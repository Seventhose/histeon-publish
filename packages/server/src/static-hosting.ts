import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { Client as FtpClient, FileType } from "basic-ftp";
import { HistosPublishError } from "@histos-publish/core";
import { ensureSftpDirectories, listSftpDirectory, lstatSftpPath, readSftpFile, readSftpHostFingerprint, removeSftpFile, uploadSftpFile, withSftpConnection } from "./sftp-transport.js";

export interface StaticHostingSettings {
  protocol: "ftp" | "ftps" | "sftp";
  host: string;
  port: number;
  remoteDirectory: string;
  publicUrl?: string;
  username?: string;
  allowInsecureFtp?: boolean;
  tlsCaCertificate?: string;
  authMethod?: "password" | "privateKey";
  hostKeyFingerprint?: string;
}

export interface StaticHostingCredentials {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  authMethod?: "password" | "privateKey";
}

export interface StaticHostingFile {
  path: string;
  bytes: Buffer;
}

export interface StaticHostingRollbackFile {
  path: string;
  beforeBytes: Buffer | null;
  beforeSha256: string | null;
  deployedSha256: string;
}

export interface StaticHostingProgress {
  phase: "connect" | "upload";
  completed: number;
  total: number;
}

export type StaticHostingVerification =
  | { verified: true; hostKeyFingerprint?: string }
  | { hostKeyConfirmationRequired: true; hostKeyFingerprint: string };

export interface StaticHostingDirectoryInspection {
  entryCount: number;
  isEmpty: boolean;
  wordpressSignals: string[];
  remoteFiles: Array<{ path: string; size: number }>;
  remoteInventoryComplete: boolean;
}

function normalizedRemoteDirectory(value: string): string {
  if (value.length > 1024 || /[\\\0\r\n]/u.test(value)) {
    throw new HistosPublishError("La cartella remota contiene caratteri non validi.", "hosting-path-invalid", 2);
  }
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new HistosPublishError("La cartella remota non può contenere . o ..", "hosting-path-invalid", 2);
  }
  return value.trim();
}

function normalizeFtpsCaCertificate(value: unknown, protocol: StaticHostingSettings["protocol"]): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (protocol !== "ftps") throw new HistosPublishError("La CA TLS personalizzata si usa solo con FTPS.", "hosting-tls-ca-invalid", 2);
  if (typeof value !== "string" || value.length > 65_536 || value.includes("\0")) {
    throw new HistosPublishError("Il file CA FTPS deve essere testo PEM valido e non superare 64 KiB.", "hosting-tls-ca-invalid", 2);
  }
  const certificateBlocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  const remainder = value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim();
  if (!certificateBlocks.length || certificateBlocks.length > 16 || remainder) {
    throw new HistosPublishError("Seleziona un certificato CA in formato PEM, con al massimo 16 certificati.", "hosting-tls-ca-invalid", 2);
  }
  const now = Date.now();
  try {
    for (const block of certificateBlocks) {
      const certificate = new X509Certificate(block);
      if (!certificate.ca || now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
        throw new Error("not-current-ca");
      }
    }
  } catch {
    throw new HistosPublishError("Il PEM deve contenere CA valide e attualmente valide; non accettiamo certificati server come autorità.", "hosting-tls-ca-invalid", 2);
  }
  return `${certificateBlocks.join("\n")}\n`;
}

export function parseStaticHostingSettings(value: unknown): StaticHostingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HistosPublishError("Completa i dati del server FTP/FTPS/SFTP.", "hosting-config-invalid", 2);
  }
  const input = value as Record<string, unknown>;
  const protocol = input.protocol;
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  const remoteDirectory = typeof input.remoteDirectory === "string" ? input.remoteDirectory.trim() : "";
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const publicUrl = typeof input.publicUrl === "string" ? input.publicUrl.trim() : "";
  const allowInsecureFtp = input.allowInsecureFtp === true;
  const authMethod = input.authMethod === "privateKey" ? "privateKey" : "password";
  const hostKeyFingerprint = typeof input.hostKeyFingerprint === "string" ? input.hostKeyFingerprint.trim() : "";

  if (protocol !== "ftp" && protocol !== "ftps" && protocol !== "sftp") {
    throw new HistosPublishError("Scegli FTP, FTPS o SFTP.", "hosting-config-invalid", 2);
  }
  if (!host || host.length > 253 || host.startsWith("-") || /[\s/@?#\\\0]/u.test(host) || host.includes("://")) {
    throw new HistosPublishError("Inserisci il nome host del server senza ftp://, ftps:// o sftp://.", "hosting-host-invalid", 2);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HistosPublishError("La porta deve essere un numero da 1 a 65535.", "hosting-port-invalid", 2);
  if (protocol === "ftp" && !allowInsecureFtp) {
    throw new HistosPublishError("FTP senza cifratura invia la password in chiaro. Se il tuo hosting lo supporta, scegli FTPS o SFTP.", "hosting-insecure-ftp-not-confirmed", 2);
  }
  if (username.length > 255 || /[\0\r\n]/u.test(username)) throw new HistosPublishError("Il nome utente del server non è valido.", "hosting-credentials-invalid", 2);
  if (hostKeyFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(hostKeyFingerprint)) {
    throw new HistosPublishError("L’impronta della chiave SSH non ha un formato valido.", "hosting-hostkey-invalid", 2);
  }
  if (protocol !== "sftp" && hostKeyFingerprint) {
    throw new HistosPublishError("L’impronta SSH si usa solo con il protocollo SFTP.", "hosting-hostkey-invalid", 2);
  }
  const tlsCaCertificate = normalizeFtpsCaCertificate(input.tlsCaCertificate, protocol);
  if (publicUrl) {
    let parsed: URL;
    try { parsed = new URL(publicUrl); }
    catch { throw new HistosPublishError("Inserisci l’indirizzo pubblico del sito, per esempio https://esempio.it.", "hosting-url-invalid", 2); }
    if (!(parsed.protocol === "https:" || parsed.protocol === "http:") || parsed.username || parsed.password || !parsed.hostname) {
      throw new HistosPublishError("L’indirizzo pubblico deve iniziare con http:// o https:// e non contenere credenziali.", "hosting-url-invalid", 2);
    }
  }
  return {
    protocol,
    host,
    port,
    remoteDirectory: normalizedRemoteDirectory(remoteDirectory),
    ...(publicUrl ? { publicUrl: new URL(publicUrl).href.replace(/\/$/u, "") } : {}),
    ...(username ? { username } : {}),
    ...(protocol === "ftp" ? { allowInsecureFtp: true } : {}),
    ...(tlsCaCertificate ? { tlsCaCertificate } : {}),
    ...(protocol === "sftp" ? { authMethod, ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}) } : {}),
  };
}

function sanitizedMessage(error: unknown, credentials: StaticHostingCredentials): string {
  let message = error instanceof Error ? error.message : "errore di rete";
  for (const secret of [credentials.password, credentials.username, credentials.privateKey, credentials.passphrase]) {
    if (secret) message = message.replaceAll(secret, "[omesso]");
  }
  return message.replace(/[\r\n\0]/gu, " ").slice(0, 300);
}

function createFtpClient(): FtpClient {
  const client = new FtpClient(20_000);
  client.ftp.verbose = false;
  return client;
}

async function connectFtp(client: FtpClient, settings: StaticHostingSettings, credentials: StaticHostingCredentials): Promise<string> {
  await openFtpSession(client, settings, credentials);
  if (settings.remoteDirectory) await client.ensureDir(settings.remoteDirectory);
  return await client.pwd();
}

async function openFtpSession(client: FtpClient, settings: StaticHostingSettings, credentials: StaticHostingCredentials): Promise<void> {
  await client.access({
    host: settings.host,
    port: settings.port,
    user: credentials.username,
    password: credentials.password ?? "",
    secure: settings.protocol === "ftps",
    ...(settings.tlsCaCertificate ? { secureOptions: { ca: settings.tlsCaCertificate } } : {}),
  });
}

function remoteJoin(base: string, relative: string): string {
  const cleanBase = base.replace(/\/+$/u, "");
  if (!cleanBase) return relative;
  return `${cleanBase}/${relative}`;
}

function remoteDirectoryList(base: string, relativeDirectories: Iterable<string>): string[] {
  const directories = new Set<string>();
  const baseParts = base.split("/").filter(Boolean);
  let current = base.startsWith("/") ? "/" : "";
  for (const part of baseParts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    directories.add(current);
  }
  for (const directory of relativeDirectories) {
    const combined = remoteJoin(base, directory);
    const absolute = combined.startsWith("/");
    const parts = combined.split("/").filter(Boolean);
    let nested = absolute ? "/" : "";
    for (const part of parts) {
      nested = nested === "/" ? `/${part}` : nested ? `${nested}/${part}` : part;
      directories.add(nested);
    }
  }
  return [...directories];
}

interface HostingDirectoryEntry {
  name: string;
  kind: "file" | "directory" | "other";
  size?: number;
}

const REMOTE_INVENTORY_MAX_FILES = 2_000;
const REMOTE_INVENTORY_MAX_DIRECTORIES = 64;
const REMOTE_INVENTORY_MAX_DEPTH = 8;
const MAX_HOSTING_BACKUP_BYTES = 256 * 1024 * 1024;

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inventoryKey(files: Array<{ path: string; size: number }>): string {
  return JSON.stringify([...files].sort((left, right) => left.path.localeCompare(right.path, "en")));
}

function assertCompleteRemoteInventory(inspection: StaticHostingDirectoryInspection): void {
  if (!inspection.remoteInventoryComplete) throw new HistosPublishError("L’inventario hosting è parziale o contiene link/tipi non supportati. Per non perdere file, il backup e la pubblicazione sono stati fermati.", "cms-hosting-backup-inventory-incomplete", 409);
}

function validateRollbackEntries(entries: StaticHostingRollbackFile[]): void {
  if (entries.length < 1 || entries.length > 20_000) throw new HistosPublishError("Il backup contiene un numero di file non valido.", "cms-hosting-backup-invalid", 409);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some((part) => !part || part === "." || part === "..") || /[\0\r\n]/u.test(entry.path)) {
      throw new HistosPublishError("Il backup contiene un percorso remoto non valido.", "cms-hosting-backup-invalid", 409);
    }
    if (seen.has(entry.path)) throw new HistosPublishError("Il backup contiene percorsi remoti duplicati.", "cms-hosting-backup-invalid", 409);
    seen.add(entry.path);
    if (!/^[a-f0-9]{64}$/u.test(entry.deployedSha256)
      || (entry.beforeBytes === null) !== (entry.beforeSha256 === null)
      || entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/u.test(entry.beforeSha256)) {
      throw new HistosPublishError("Gli hash del backup hosting non sono validi.", "cms-hosting-backup-invalid", 409);
    }
  }
}

async function inspectSftpRoot(sftp: import("ssh2").SFTPWrapper, settings: StaticHostingSettings): Promise<StaticHostingDirectoryInspection> {
  return inspectDirectoryTree(settings.remoteDirectory || ".", async (remotePath) => {
    const entries = await listSftpDirectory(sftp, remotePath);
    return entries.map((entry): HostingDirectoryEntry => {
      const mode = entry.attrs?.mode;
      const fileType = typeof mode === "number" ? mode & 0o170000 : 0;
      if (fileType === 0o040000) return { name: entry.filename, kind: "directory" };
      if (fileType === 0o100000 && typeof entry.attrs?.size === "number") return { name: entry.filename, kind: "file", size: entry.attrs.size };
      return { name: entry.filename, kind: "other" };
    });
  });
}

async function inspectFtpRoot(client: FtpClient, settings: StaticHostingSettings): Promise<StaticHostingDirectoryInspection> {
  return inspectDirectoryTree(settings.remoteDirectory || ".", async (remotePath) => {
    const entries = await client.list(remotePath);
    return entries.map((entry): HostingDirectoryEntry => {
      if (entry.type === FileType.Directory) return { name: entry.name, kind: "directory" };
      if (entry.type === FileType.File) return { name: entry.name, kind: "file", size: entry.size };
      return { name: entry.name, kind: "other" };
    });
  });
}

async function readFtpFile(client: FtpClient, remotePath: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        callback(new HistosPublishError("Un file remoto supera il limite previsto per il backup locale.", "cms-hosting-backup-too-large", 413));
        return;
      }
      chunks.push(Buffer.from(bytes));
      callback();
    },
  });
  try { await client.downloadTo(destination, remotePath); }
  catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError("Non riesco a leggere un file remoto necessario al backup.", "cms-hosting-backup-read-failed", 4);
  }
  return Buffer.concat(chunks, total);
}

function assertSameInventory(expected: StaticHostingDirectoryInspection["remoteFiles"], actual: StaticHostingDirectoryInspection): void {
  assertCompleteRemoteInventory(actual);
  if (inventoryKey(expected) !== inventoryKey(actual.remoteFiles)) throw new HistosPublishError("I file hosting sono cambiati dopo il controllo. Rivedi la destinazione e prepara un nuovo piano.", "cms-hosting-backup-stale", 409);
}

async function inspectDirectoryTree(
  root: string,
  readDirectory: (remotePath: string) => Promise<HostingDirectoryEntry[]>,
): Promise<StaticHostingDirectoryInspection> {
  const queue = [{ remotePath: root || ".", relativePath: "", depth: 0 }];
  const remoteFiles: StaticHostingDirectoryInspection["remoteFiles"] = [];
  const rootNames: string[] = [];
  let rootEntryCount = 0;
  let visitedDirectories = 0;
  let seenEntries = 0;
  let complete = true;
  const seenPaths = new Set<string>();

  while (queue.length) {
    if (visitedDirectories >= REMOTE_INVENTORY_MAX_DIRECTORIES) {
      complete = false;
      break;
    }
    const directory = queue.shift();
    if (!directory) break;
    visitedDirectories += 1;
    const entries = await readDirectory(directory.remotePath);
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || entry.name === "") continue;
      if (entry.name.includes("/") || entry.name.includes("\\") || /[\0\r\n]/u.test(entry.name)) {
        complete = false;
        continue;
      }
      if (seenEntries >= REMOTE_INVENTORY_MAX_FILES) {
        complete = false;
        break;
      }
      seenEntries += 1;
      const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
      if (Buffer.byteLength(entry.name, "utf8") > 255 || Buffer.byteLength(relativePath, "utf8") > 1024 || seenPaths.has(relativePath)) {
        complete = false;
        continue;
      }
      seenPaths.add(relativePath);
      if (directory.depth === 0) {
        rootEntryCount += 1;
        rootNames.push(entry.name);
      }
      if (entry.kind === "directory") {
        if (directory.depth >= REMOTE_INVENTORY_MAX_DEPTH) {
          complete = false;
          continue;
        }
        queue.push({ remotePath: remoteJoin(directory.remotePath, entry.name), relativePath, depth: directory.depth + 1 });
      } else if (entry.kind === "file") {
        if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
          complete = false;
          continue;
        }
        remoteFiles.push({ path: relativePath, size: entry.size ?? 0 });
      } else {
        complete = false;
      }
    }
  }

  const wordpressMarkerNames = new Set(["index.php", "wp-config.php", "wp-load.php", "wp-admin", "wp-content", "wp-includes"]);
  const wordpressSignals = [...new Set(rootNames.filter((name) => wordpressMarkerNames.has(name)))].sort();
  return {
    entryCount: rootEntryCount,
    isEmpty: rootEntryCount === 0,
    wordpressSignals,
    remoteFiles: remoteFiles.slice(0, REMOTE_INVENTORY_MAX_FILES),
    remoteInventoryComplete: complete,
  };
}

async function requirePinnedSftpHost(settings: StaticHostingSettings, credentials: StaticHostingCredentials, signal?: AbortSignal): Promise<void> {
  if (settings.hostKeyFingerprint) return;
  const fingerprint = await readSftpHostFingerprint({ ...settings, username: credentials.username }, signal);
  throw new HistosPublishError(`La chiave SSH del server non è stata confermata. Confronta e conferma questa impronta nelle impostazioni hosting: ${fingerprint}`, "hosting-hostkey-unconfirmed", 2);
}

async function runTemporarySftpFile<T>(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  fileName: string;
  bytes: Buffer;
  run: () => Promise<T>;
}): Promise<T> {
  await requirePinnedSftpHost(options.settings, options.credentials);
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-runtime-probe-"));
  const localPath = path.join(directory, options.fileName);
  const remoteDirectory = options.settings.remoteDirectory || ".";
  const remotePath = remoteJoin(options.settings.remoteDirectory, options.fileName);
  try {
    await chmod(directory, 0o700);
    await writeFile(localPath, options.bytes, { mode: 0o600 });
    return await withSftpConnection({
      endpoint: options.settings,
      credentials: options.credentials,
      timeoutMs: 30_000,
      run: async (sftp) => {
        let uploadAttempted = false;
        let result: T | undefined;
        let operationError: unknown;
        let cleanupError: unknown;
        try {
          const before = await listSftpDirectory(sftp, remoteDirectory);
          if (before.some((entry) => entry.filename === options.fileName)) {
            throw new HistosPublishError("Il nome del file temporaneo esiste già sul server. Riprova il controllo.", "hosting-temporary-file-collision", 2);
          }
          uploadAttempted = true;
          await uploadSftpFile(sftp, localPath, remotePath);
          result = await options.run();
        } catch (error) { operationError = error; }
        finally {
          if (uploadAttempted) {
            try {
              const afterRun = await listSftpDirectory(sftp, remoteDirectory);
              if (afterRun.some((entry) => entry.filename === options.fileName)) {
                await removeSftpFile(sftp, remotePath);
                const verified = await listSftpDirectory(sftp, remoteDirectory);
                if (verified.some((entry) => entry.filename === options.fileName)) cleanupError = new Error("temporary file remains on server");
              }
            } catch (error) { cleanupError = error; }
          }
        }
        if (cleanupError) {
          throw new HistosPublishError(`Non riesco a verificare la rimozione del file PHP temporaneo ${options.fileName}. Controlla la cartella remota e rimuovilo prima di continuare.`, "hosting-temporary-file-cleanup-failed", 4);
        }
        if (operationError) throw operationError;
        return result as T;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Uploads a random, temporary file into an existing remote directory, runs a callback, then verifies its removal. */
export async function withTemporaryStaticHostingFile<T>(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  fileName: string;
  bytes: Buffer;
  run: () => Promise<T>;
}): Promise<T> {
  if (!/^histos-(?:runtime-check|provision)-[a-f0-9]{32}\.php$/u.test(options.fileName)) {
    throw new HistosPublishError("Il nome del file temporaneo remoto non è valido.", "hosting-temporary-file-invalid", 2);
  }
  if (options.settings.protocol === "sftp") return runTemporarySftpFile(options);

  const client = createFtpClient();
  let uploadAttempted = false;
  let result: T | undefined;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    await openFtpSession(client, options.settings, options.credentials);
    await client.cd(options.settings.remoteDirectory || ".");
    const before = await client.list();
    if (before.some((entry) => entry.name === options.fileName)) {
      throw new HistosPublishError("Il nome del file temporaneo esiste già sul server. Riprova il controllo.", "hosting-temporary-file-collision", 2);
    }
    uploadAttempted = true;
    await client.uploadFrom(Readable.from([options.bytes]), options.fileName);
    result = await options.run();
  } catch (error) { operationError = error; }
  finally {
    if (uploadAttempted) {
      try {
        const afterRun = await client.list();
        if (afterRun.some((entry) => entry.name === options.fileName)) {
          await client.remove(options.fileName);
          if ((await client.list()).some((entry) => entry.name === options.fileName)) cleanupError = new Error("temporary file remains on server");
        }
      } catch (error) { cleanupError = error; }
    }
    client.close();
  }
  if (cleanupError) {
    throw new HistosPublishError(`Non riesco a verificare la rimozione del file PHP temporaneo ${options.fileName}. Controlla la cartella remota e rimuovilo prima di continuare.`, "hosting-temporary-file-cleanup-failed", 4);
  }
  if (operationError) throw operationError;
  return result as T;
}

/**
 * Inspects a saved hosting directory without creating it or changing remote files.
 * WordPress provisioning must stop unless the target directory can be read and is empty.
 */
export async function inspectStaticHostingDirectory(
  settings: StaticHostingSettings,
  credentials: StaticHostingCredentials,
  signal?: AbortSignal,
): Promise<StaticHostingDirectoryInspection> {
  try {
    if (signal?.aborted) throw new HistosPublishError("Controllo annullato.", "operation-cancelled", 2);
    if (settings.protocol === "sftp") {
      await requirePinnedSftpHost(settings, credentials, signal);
      return await withSftpConnection<StaticHostingDirectoryInspection>({
        endpoint: settings,
        credentials,
        ...(signal ? { signal } : {}),
        timeoutMs: 60_000,
        run: (sftp) => inspectDirectoryTree(settings.remoteDirectory || ".", async (remotePath) => {
          const entries = await listSftpDirectory(sftp, remotePath);
          return entries.map((entry): HostingDirectoryEntry => {
            const mode = entry.attrs?.mode;
            const fileType = typeof mode === "number" ? mode & 0o170000 : 0;
            if (fileType === 0o040000) return { name: entry.filename, kind: "directory" };
            if (fileType === 0o100000 && typeof entry.attrs?.size === "number") return { name: entry.filename, kind: "file", size: entry.attrs.size };
            return { name: entry.filename, kind: "other" };
          });
        }),
      });
    }

    const client = createFtpClient();
    const closeOnAbort = () => client.close();
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      if (signal?.aborted) throw new HistosPublishError("Controllo annullato.", "operation-cancelled", 2);
      await openFtpSession(client, settings, credentials);
      const result = await inspectDirectoryTree(settings.remoteDirectory || ".", async (remotePath) => {
        const entries = await client.list(remotePath);
        return entries.map((entry): HostingDirectoryEntry => {
          if (entry.type === FileType.Directory) return { name: entry.name, kind: "directory" };
          if (entry.type === FileType.File) return { name: entry.name, kind: "file", size: entry.size };
          return { name: entry.name, kind: "other" };
        });
      });
      if (signal?.aborted) throw new HistosPublishError("Controllo annullato.", "operation-cancelled", 2);
      return result;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
      client.close();
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof HistosPublishError && error.code === "operation-cancelled")) {
      throw new HistosPublishError("Controllo annullato.", "operation-cancelled", 2);
    }
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError(`Non riesco a leggere la cartella remota senza modificarla: ${sanitizedMessage(error, credentials)}`, "hosting-directory-inspection-failed", 4);
  }
}

/** Reads only build paths that will be replaced and proves the full pre-deploy inventory is unchanged. */
export async function captureStaticHostingPreviousFiles(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  files: StaticHostingFile[];
  expectedRemoteFiles: StaticHostingDirectoryInspection["remoteFiles"];
  expectedInventoryComplete: boolean;
  signal?: AbortSignal;
}): Promise<Array<{ path: string; beforeBytes: Buffer | null }>> {
  validateHostingFiles(options.files);
  if (!options.expectedInventoryComplete) throw new HistosPublishError("L’inventario hosting non è completo. La pubblicazione è stata fermata prima dell’upload perché non posso preparare un backup verificabile.", "cms-hosting-backup-inventory-incomplete", 409);
  const expectedByPath = new Map(options.expectedRemoteFiles.map((file) => [file.path, file.size]));
  const targetBytes = options.files.filter((file) => expectedByPath.has(file.path)).reduce((sum, file) => sum + (expectedByPath.get(file.path) ?? 0), 0);
  if (!Number.isSafeInteger(targetBytes) || targetBytes > MAX_HOSTING_BACKUP_BYTES) throw new HistosPublishError("I file remoti da conservare superano il limite locale di 256 MiB; la pubblicazione è stata fermata prima dell’upload.", "cms-hosting-backup-too-large", 413);
  const result: Array<{ path: string; beforeBytes: Buffer | null }> = [];
  let totalBytes = 0;

  if (options.settings.protocol === "sftp") {
    await requirePinnedSftpHost(options.settings, options.credentials, options.signal);
    try {
      return await withSftpConnection({
        endpoint: options.settings,
        credentials: options.credentials,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 120_000,
        run: async (sftp) => {
        const inspection = await inspectSftpRoot(sftp, options.settings);
        assertSameInventory(options.expectedRemoteFiles, inspection);
        for (const file of options.files) {
          const expectedSize = expectedByPath.get(file.path);
          if (expectedSize === undefined) { result.push({ path: file.path, beforeBytes: null }); continue; }
          await assertSftpParentsAreDirectories(sftp, options.settings, file.path);
          const beforeBytes = await readSftpFile(sftp, remoteJoin(options.settings.remoteDirectory, file.path), MAX_HOSTING_BACKUP_BYTES - totalBytes);
          if (beforeBytes.byteLength !== expectedSize) throw new HistosPublishError(`Il file remoto ${file.path} è cambiato dopo il controllo. Rivedi il piano.`, "cms-hosting-backup-stale", 409);
          totalBytes += beforeBytes.byteLength;
          result.push({ path: file.path, beforeBytes });
        }
        return result;
        },
      });
    } catch (error) {
      if (options.signal?.aborted) throw new HistosPublishError("Backup hosting annullato.", "operation-cancelled", 2);
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError(`Non riesco a preparare il backup SFTP: ${sanitizedMessage(error, options.credentials)}`, "cms-hosting-backup-read-failed", 4);
    }
  }

  const client = createFtpClient();
  const closeOnAbort = () => client.close();
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (options.signal?.aborted) throw new HistosPublishError("Backup hosting annullato.", "operation-cancelled", 2);
    await openFtpSession(client, options.settings, options.credentials);
    await client.cd(options.settings.remoteDirectory || ".");
    const inspection = await inspectFtpRoot(client, options.settings);
    assertSameInventory(options.expectedRemoteFiles, inspection);
    for (const file of options.files) {
      if (options.signal?.aborted) throw new HistosPublishError("Backup hosting annullato.", "operation-cancelled", 2);
      const expectedSize = expectedByPath.get(file.path);
      if (expectedSize === undefined) { result.push({ path: file.path, beforeBytes: null }); continue; }
      const beforeBytes = await readFtpFile(client, file.path, MAX_HOSTING_BACKUP_BYTES - totalBytes);
      if (beforeBytes.byteLength !== expectedSize) throw new HistosPublishError(`Il file remoto ${file.path} è cambiato dopo il controllo. Rivedi il piano.`, "cms-hosting-backup-stale", 409);
      totalBytes += beforeBytes.byteLength;
      result.push({ path: file.path, beforeBytes });
    }
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw new HistosPublishError("Backup hosting annullato.", "operation-cancelled", 2);
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError(`Non riesco a preparare il backup FTP/FTPS: ${sanitizedMessage(error, options.credentials)}`, "cms-hosting-backup-read-failed", 4);
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    client.close();
  }
}

function isMissingSftpPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? String(error.message) : "";
  return code === 2 || code === "ENOENT" || /no such file|not found/iu.test(message);
}

async function assertSftpParentsAreDirectories(sftp: import("ssh2").SFTPWrapper, settings: StaticHostingSettings, relativePath: string): Promise<void> {
  let current = settings.remoteDirectory || ".";
  try {
    const root = await lstatSftpPath(sftp, current);
    if ((typeof root.mode !== "number" ? 0 : root.mode & 0o170000) !== 0o040000) throw new Error("invalid root");
    for (const part of path.posix.dirname(relativePath).split("/").filter((item) => item && item !== ".")) {
      current = remoteJoin(current, part);
      const parent = await lstatSftpPath(sftp, current);
      if ((typeof parent.mode !== "number" ? 0 : parent.mode & 0o170000) !== 0o040000) throw new Error("invalid parent");
    }
  } catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError("Un percorso SFTP del sito contiene una directory non leggibile o un link simbolico. Il ripristino è stato fermato.", "cms-hosting-backup-path-unsupported", 409);
  }
}

async function currentSftpBytes(sftp: import("ssh2").SFTPWrapper, settings: StaticHostingSettings, pathValue: string, exists: boolean): Promise<Buffer | null> {
  if (!exists) return null;
  await assertSftpParentsAreDirectories(sftp, settings, pathValue);
  try { return await readSftpFile(sftp, remoteJoin(settings.remoteDirectory, pathValue), MAX_HOSTING_BACKUP_BYTES); }
  catch (error) {
    if (isMissingSftpPath(error)) return null;
    throw error;
  }
}

async function validateHostingRestoreState(options: {
  entries: StaticHostingRollbackFile[];
  current: Map<string, Buffer | null>;
}): Promise<Array<{ entry: StaticHostingRollbackFile; action: "restore" | "delete" | "none" }>> {
  const actions: Array<{ entry: StaticHostingRollbackFile; action: "restore" | "delete" | "none" }> = [];
  const conflicts: string[] = [];
  for (const entry of options.entries) {
    const currentBytes = options.current.get(entry.path) ?? null;
    const currentHash = currentBytes === null ? null : fileSha256(currentBytes);
    if (currentHash === entry.beforeSha256) {
      actions.push({ entry, action: "none" });
    } else if (currentHash === entry.deployedSha256) {
      actions.push({ entry, action: entry.beforeBytes === null ? "delete" : "restore" });
    } else {
      conflicts.push(entry.path);
      actions.push({ entry, action: "none" });
    }
  }
  if (conflicts.length) throw new HistosPublishError(`Il server è cambiato dopo la pubblicazione (${conflicts.slice(0, 10).join(", ")}${conflicts.length > 10 ? ", …" : ""}). Non modifico i file: confrontali o ripristina prima le modifiche manuali.`, "cms-hosting-rollback-conflict", 409);
  return actions;
}

/** Restores only files changed by this deployment; any later remote edit blocks the whole restore. */
export async function restoreStaticHostingBackup(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  entries: StaticHostingRollbackFile[];
  signal?: AbortSignal;
}): Promise<{ restored: number; removed: number; alreadyRestored: number }> {
  validateRollbackEntries(options.entries);
  if (options.signal?.aborted) throw new HistosPublishError("Ripristino hosting annullato.", "operation-cancelled", 2);
  const current = new Map<string, Buffer | null>();
  let currentBytesTotal = 0;
  let actions: Array<{ entry: StaticHostingRollbackFile; action: "restore" | "delete" | "none" }> = [];

  const inspectSftp = async (sftp: import("ssh2").SFTPWrapper) => {
    const inspection = await inspectSftpRoot(sftp, options.settings);
    assertCompleteRemoteInventory(inspection);
    const present = new Map(inspection.remoteFiles.map((file) => [file.path, file.size]));
    for (const entry of options.entries) {
      const bytes = await currentSftpBytes(sftp, options.settings, entry.path, present.has(entry.path));
      currentBytesTotal += bytes?.byteLength ?? 0;
      if (!Number.isSafeInteger(currentBytesTotal) || currentBytesTotal > MAX_HOSTING_BACKUP_BYTES) throw new HistosPublishError("I file remoti da verificare superano il limite di 256 MiB.", "cms-hosting-backup-too-large", 413);
      if (bytes !== null && bytes.byteLength !== present.get(entry.path)) throw new HistosPublishError(`Il file remoto ${entry.path} è cambiato durante la verifica. Ripeti il ripristino.`, "cms-hosting-rollback-stale", 409);
      current.set(entry.path, bytes);
    }
    actions = await validateHostingRestoreState({ entries: options.entries, current });
  };

  if (options.settings.protocol === "sftp") {
    await requirePinnedSftpHost(options.settings, options.credentials, options.signal);
    try {
      return await withSftpConnection({
        endpoint: options.settings,
        credentials: options.credentials,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 120_000,
        run: async (sftp) => {
        await inspectSftp(sftp);
        const directory = await mkdtemp(path.join(os.tmpdir(), "histos-hosting-rollback-"));
        await chmod(directory, 0o700);
        try {
          let restored = 0; let removed = 0; let alreadyRestored = 0;
          for (const [index, item] of actions.entries()) {
            if (options.signal?.aborted) throw new HistosPublishError("Ripristino hosting annullato. Alcuni file possono essere già stati ripristinati.", "operation-cancelled", 2);
            if (item.action === "none") { alreadyRestored += 1; continue; }
            const pathValue = remoteJoin(options.settings.remoteDirectory, item.entry.path);
            const now = await currentSftpBytes(sftp, options.settings, item.entry.path, true);
            if (now === null || fileSha256(now) !== item.entry.deployedSha256) throw new HistosPublishError(`Il file remoto ${item.entry.path} è cambiato durante il ripristino. Ho interrotto l’operazione.`, "cms-hosting-rollback-stale", 409);
            if (item.action === "delete") {
              await removeSftpFile(sftp, pathValue);
              removed += 1;
            } else {
              const before = item.entry.beforeBytes;
              if (before === null) throw new HistosPublishError("La copia precedente di un file non è disponibile.", "cms-hosting-backup-corrupt", 409);
              const localPath = path.join(directory, `${String(index).padStart(5, "0")}.bin`);
              await writeFile(localPath, before, { mode: 0o600, flag: "wx" });
              await uploadSftpFile(sftp, localPath, pathValue);
              restored += 1;
            }
          }
          const after = await inspectSftpRoot(sftp, options.settings);
          assertCompleteRemoteInventory(after);
          const present = new Map(after.remoteFiles.map((file) => [file.path, file.size]));
          for (const entry of options.entries) {
            const bytes = await currentSftpBytes(sftp, options.settings, entry.path, present.has(entry.path));
            if (entry.beforeBytes === null ? bytes !== null : bytes === null || fileSha256(bytes) !== entry.beforeSha256) {
              throw new HistosPublishError(`Il server non conferma il ripristino di ${entry.path}. Controlla il sito prima di riprovare.`, "cms-hosting-rollback-unverified", 502);
            }
          }
          return { restored, removed, alreadyRestored };
        } finally { await rm(directory, { recursive: true, force: true }); }
        },
      });
    } catch (error) {
      if (options.signal?.aborted) throw new HistosPublishError("Ripristino hosting annullato. Alcuni file possono essere già stati ripristinati.", "operation-cancelled", 2);
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError(`Non riesco a ripristinare il sito SFTP: ${sanitizedMessage(error, options.credentials)}`, "cms-hosting-rollback-failed", 4);
    }
  }

  const client = createFtpClient();
  const closeOnAbort = () => client.close();
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await openFtpSession(client, options.settings, options.credentials);
    await client.cd(options.settings.remoteDirectory || ".");
    const inspection = await inspectFtpRoot(client, options.settings);
    assertCompleteRemoteInventory(inspection);
    const present = new Map(inspection.remoteFiles.map((file) => [file.path, file.size]));
    for (const entry of options.entries) {
      const bytes = present.has(entry.path) ? await readFtpFile(client, entry.path, MAX_HOSTING_BACKUP_BYTES - currentBytesTotal) : null;
      currentBytesTotal += bytes?.byteLength ?? 0;
      if (!Number.isSafeInteger(currentBytesTotal) || currentBytesTotal > MAX_HOSTING_BACKUP_BYTES) throw new HistosPublishError("I file remoti da verificare superano il limite di 256 MiB.", "cms-hosting-backup-too-large", 413);
      if (bytes !== null && bytes.byteLength !== present.get(entry.path)) throw new HistosPublishError(`Il file remoto ${entry.path} è cambiato durante la verifica. Ripeti il ripristino.`, "cms-hosting-rollback-stale", 409);
      current.set(entry.path, bytes);
    }
    actions = await validateHostingRestoreState({ entries: options.entries, current });
    let restored = 0; let removed = 0; let alreadyRestored = 0;
    for (const item of actions) {
      if (options.signal?.aborted) throw new HistosPublishError("Ripristino hosting annullato. Alcuni file possono essere già stati ripristinati.", "operation-cancelled", 2);
      if (item.action === "none") { alreadyRestored += 1; continue; }
      const now = await readFtpFile(client, item.entry.path, MAX_HOSTING_BACKUP_BYTES);
      if (fileSha256(now) !== item.entry.deployedSha256) throw new HistosPublishError(`Il file remoto ${item.entry.path} è cambiato durante il ripristino. Ho interrotto l’operazione.`, "cms-hosting-rollback-stale", 409);
      if (item.action === "delete") {
        await client.remove(item.entry.path);
        removed += 1;
      } else {
        if (item.entry.beforeBytes === null) throw new HistosPublishError("La copia precedente di un file non è disponibile.", "cms-hosting-backup-corrupt", 409);
        await client.uploadFrom(Readable.from([item.entry.beforeBytes]), item.entry.path);
        restored += 1;
      }
    }
    const after = await inspectFtpRoot(client, options.settings);
    assertCompleteRemoteInventory(after);
    const afterFiles = new Map(after.remoteFiles.map((file) => [file.path, file.size]));
    for (const entry of options.entries) {
      const bytes = afterFiles.has(entry.path) ? await readFtpFile(client, entry.path, MAX_HOSTING_BACKUP_BYTES) : null;
      if (entry.beforeBytes === null ? bytes !== null : bytes === null || fileSha256(bytes) !== entry.beforeSha256) {
        throw new HistosPublishError(`Il server non conferma il ripristino di ${entry.path}. Controlla il sito prima di riprovare.`, "cms-hosting-rollback-unverified", 502);
      }
    }
    return { restored, removed, alreadyRestored };
  } catch (error) {
    if (options.signal?.aborted) throw new HistosPublishError("Ripristino hosting annullato. Alcuni file possono essere già stati ripristinati.", "operation-cancelled", 2);
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError(`Non riesco a ripristinare il sito FTP/FTPS: ${sanitizedMessage(error, options.credentials)}`, "cms-hosting-rollback-failed", 4);
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    client.close();
  }
}

async function verifySftpWrite(settings: StaticHostingSettings, credentials: StaticHostingCredentials, signal?: AbortSignal): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-probe-"));
  const localPath = path.join(directory, "connection-check.txt");
  const remotePath = remoteJoin(settings.remoteDirectory, `.histos-publish-test-${randomUUID()}`);
  try {
    await writeFile(localPath, "Histeon Publish connection check", { mode: 0o600 });
    await withSftpConnection({
      endpoint: settings,
      credentials,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
      run: async (sftp) => {
        await ensureSftpDirectories(sftp, remoteDirectoryList(settings.remoteDirectory, []));
        let uploadAttempted = false;
        let operationError: unknown;
        let cleanupError: unknown;
        try {
          uploadAttempted = true;
          await uploadSftpFile(sftp, localPath, remotePath);
        } catch (error) { operationError = error; }
        finally {
          if (uploadAttempted) {
            try {
              const remoteDirectory = settings.remoteDirectory || ".";
              const basename = path.posix.basename(remotePath);
              const entries = await listSftpDirectory(sftp, remoteDirectory);
              if (entries.some((entry) => entry.filename === basename)) {
                await removeSftpFile(sftp, remotePath);
                if ((await listSftpDirectory(sftp, remoteDirectory)).some((entry) => entry.filename === basename)) {
                  cleanupError = new Error("Il file temporaneo di verifica è ancora presente sul server.");
                }
              }
            } catch (error) { cleanupError = error; }
          }
        }
        if (cleanupError) throw new HistosPublishError("Non riesco a verificare la rimozione del file temporaneo di controllo SFTP. Controlla la cartella remota prima di continuare.", "hosting-temporary-file-cleanup-failed", 4);
        if (operationError) throw operationError;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyStaticHostingConnection(
  settings: StaticHostingSettings,
  credentials: StaticHostingCredentials,
  signal?: AbortSignal,
): Promise<StaticHostingVerification> {
  if (settings.protocol === "sftp") {
    try {
      if (signal?.aborted) throw new HistosPublishError("Verifica annullata.", "operation-cancelled", 2);
      if (!settings.hostKeyFingerprint) {
        const hostKeyFingerprint = await readSftpHostFingerprint({ ...settings, username: credentials.username }, signal);
        return { hostKeyConfirmationRequired: true, hostKeyFingerprint };
      }
      await verifySftpWrite(settings, credentials, signal);
      return { verified: true, hostKeyFingerprint: settings.hostKeyFingerprint };
    } catch (error) {
      if (signal?.aborted) throw new HistosPublishError("Verifica annullata.", "operation-cancelled", 2);
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError(`Non riesco a scrivere nella cartella SFTP: ${sanitizedMessage(error, credentials)}`, "hosting-connect-failed", 4);
    }
  }

  const client = createFtpClient();
  const closeOnAbort = () => client.close();
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (signal?.aborted) throw new HistosPublishError("Verifica annullata.", "operation-cancelled", 2);
    await connectFtp(client, settings, credentials);
    const probe = `.histos-publish-test-${randomUUID()}`;
    await client.uploadFrom(Readable.from([Buffer.from("Histeon Publish connection check", "utf8")]), probe);
    await client.remove(probe);
    return { verified: true };
  } catch (error) {
    if (signal?.aborted) throw new HistosPublishError("Verifica annullata.", "operation-cancelled", 2);
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError(`Non riesco a scrivere nella cartella FTP/FTPS: ${sanitizedMessage(error, credentials)}`, "hosting-connect-failed", 4);
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    client.close();
  }
}

function validateHostingFiles(files: StaticHostingFile[]): void {
  if (files.length === 0 || files.length > 20_000) throw new HistosPublishError("Il pacchetto hosting deve contenere da 1 a 20.000 file.", "hosting-file-count-invalid", 2);
  const names = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new HistosPublishError(`La build contiene un percorso non valido: ${file.path}`, "hosting-file-path-invalid", 2);
    }
    if (Buffer.byteLength(file.path, "utf8") > 1024 || /[\0\r\n]/u.test(file.path)) throw new HistosPublishError("Il pacchetto contiene un nome file troppo lungo o non valido.", "hosting-file-path-invalid", 2);
    const normalized = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(normalized)) throw new HistosPublishError(`Il pacchetto contiene file in collisione: ${file.path}`, "hosting-file-path-collision", 2);
    names.add(normalized);
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 256 * 1024 * 1024) throw new HistosPublishError("Il pacchetto supera il limite di 256 MiB.", "hosting-files-too-large", 2);
  }
}

async function publishSftpBundle(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  files: StaticHostingFile[];
  purpose: "publish" | "provision";
  signal?: AbortSignal;
  onProgress?: (progress: StaticHostingProgress) => void;
}): Promise<{ uploaded: number; files: number; publicUrl?: string }> {
  let uploaded = 0;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-upload-"));
  try {
    if (options.signal?.aborted) throw new HistosPublishError("Pubblicazione annullata.", "operation-cancelled", 2);
    options.onProgress?.({ phase: "connect", completed: 0, total: options.files.length });
    await requirePinnedSftpHost(options.settings, options.credentials, options.signal);

    for (const [index, file] of options.files.entries()) {
      const localPath = path.join(tempDirectory, String(index).padStart(8, "0"));
      await writeFile(localPath, file.bytes, { mode: 0o600 });
    }
    options.onProgress?.({ phase: "upload", completed: 0, total: options.files.length });
    await withSftpConnection({
      endpoint: options.settings,
      credentials: options.credentials,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: Math.max(120_000, options.files.length * 5_000),
      run: async (sftp) => {
        const relativeDirectories = options.files.map((file) => path.posix.dirname(file.path)).filter((directory) => directory !== ".");
        await ensureSftpDirectories(sftp, remoteDirectoryList(options.settings.remoteDirectory, relativeDirectories));
        for (const [index, file] of options.files.entries()) {
          const localPath = path.join(tempDirectory, String(index).padStart(8, "0"));
          await uploadSftpFile(sftp, localPath, remoteJoin(options.settings.remoteDirectory, file.path));
          uploaded += 1;
          options.onProgress?.({ phase: "upload", completed: uploaded, total: options.files.length });
        }
      },
    });
    return {
      uploaded,
      files: options.files.length,
      ...(options.settings.publicUrl ? { publicUrl: options.settings.publicUrl } : {}),
    };
  } catch (error) {
    if (options.signal?.aborted) throw new HistosPublishError("Pubblicazione annullata. I file già caricati possono essere stati aggiornati.", "operation-cancelled", 2);
    if (error instanceof HistosPublishError) throw error;
    const details = sanitizedMessage(error, options.credentials);
    const partial = uploaded > 0 ? ` Ho caricato ${uploaded} file; quelli già aggiornati restano sul server.` : " Se l’errore è avvenuto durante il trasferimento, i file completati restano sul server.";
    const action = options.purpose === "provision" ? "Installazione WordPress tramite SFTP" : "Pubblicazione SFTP";
    throw new HistosPublishError(`${action} non riuscita: ${details}.${partial}`, options.purpose === "provision" ? "wordpress-provision-upload-failed" : "hosting-deploy-failed", 4);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function publishStaticBundle(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  files: StaticHostingFile[];
  signal?: AbortSignal;
  onProgress?: (progress: StaticHostingProgress) => void;
}): Promise<{ uploaded: number; files: number; publicUrl?: string }> {
  validateHostingFiles(options.files);
  if (!options.files.some((file) => file.path === "index.html")) {
    throw new HistosPublishError("La build non contiene index.html nella cartella principale. Il server statico non saprebbe quale home mostrare.", "hosting-index-missing", 2);
  }
  return transferHostingFiles({ ...options, purpose: "publish" });
}

/** Uploads bounded, path-validated files without requiring a static-site index.html. */
export async function uploadStaticHostingFiles(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  files: StaticHostingFile[];
  signal?: AbortSignal;
  onProgress?: (progress: StaticHostingProgress) => void;
}): Promise<{ uploaded: number; files: number; publicUrl?: string }> {
  validateHostingFiles(options.files);
  return transferHostingFiles({ ...options, purpose: "provision" });
}

async function transferHostingFiles(options: {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  files: StaticHostingFile[];
  purpose: "publish" | "provision";
  signal?: AbortSignal;
  onProgress?: (progress: StaticHostingProgress) => void;
}): Promise<{ uploaded: number; files: number; publicUrl?: string }> {
  if (options.settings.protocol === "sftp") return publishSftpBundle(options);

  const client = createFtpClient();
  const closeOnAbort = () => client.close();
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  let uploaded = 0;
  try {
    if (options.signal?.aborted) throw new HistosPublishError("Pubblicazione annullata.", "operation-cancelled", 2);
    options.onProgress?.({ phase: "connect", completed: 0, total: options.files.length });
    const baseDirectory = await connectFtp(client, options.settings, options.credentials);
    for (const file of options.files) {
      if (options.signal?.aborted) throw new HistosPublishError("Pubblicazione annullata. I file già caricati possono essere stati aggiornati.", "operation-cancelled", 2);
      await client.cd(baseDirectory);
      const pieces = file.path.split("/");
      const filename = pieces.pop();
      if (!filename) throw new HistosPublishError(`Nome file non valido: ${file.path}`, "hosting-file-path-invalid", 2);
      const directory = pieces.join("/");
      if (directory) await client.ensureDir(directory);
      await client.uploadFrom(Readable.from([file.bytes]), filename);
      uploaded += 1;
      options.onProgress?.({ phase: "upload", completed: uploaded, total: options.files.length });
    }
    return {
      uploaded,
      files: options.files.length,
      ...(options.settings.publicUrl ? { publicUrl: options.settings.publicUrl } : {}),
    };
  } catch (error) {
    if (options.signal?.aborted) throw new HistosPublishError("Pubblicazione annullata. I file già caricati possono essere stati aggiornati.", "operation-cancelled", 2);
    if (error instanceof HistosPublishError) throw error;
    const partial = uploaded > 0 ? ` Ho caricato ${uploaded} file; quelli già aggiornati restano sul server.` : "";
    const action = options.purpose === "provision" ? "Installazione WordPress tramite FTP/FTPS" : "Pubblicazione FTP/FTPS";
    throw new HistosPublishError(`${action} non riuscita: ${sanitizedMessage(error, options.credentials)}.${partial}`, options.purpose === "provision" ? "wordpress-provision-upload-failed" : "hosting-deploy-failed", 4);
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    client.close();
  }
}
