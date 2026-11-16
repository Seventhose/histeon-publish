import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";

export const CMS_HOSTING_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface CmsHostingBackupEntry {
  path: string;
  beforeBytes: Buffer | null;
  deployedSha256: string;
}

export interface CmsHostingBackupFile extends CmsHostingBackupEntry {
  beforeSha256: string | null;
}

interface StoredBackupFile {
  path: string;
  beforeFile: string | null;
  beforeSha256: string | null;
  beforeBytes: number;
  deployedSha256: string;
}

interface StoredBackupManifest {
  schemaVersion: 1;
  deploymentId: string;
  projectId: string;
  destinationSiteId: string;
  destinationSha256: string;
  createdAt: string;
  files: StoredBackupFile[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\") && !/[\0\r\n]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= 1024 && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function backupError(message: string, code: string, status = 409): HistosPublishError {
  return new HistosPublishError(message, code, status);
}

function safeId(value: string): void {
  if (!UUID.test(value)) throw backupError("Identificativo del backup hosting non valido.", "cms-hosting-backup-invalid", 500);
}

function validateManifest(value: unknown, expectedId: string): StoredBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw backupError("Il manifesto del backup hosting non è valido.", "cms-hosting-backup-invalid");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "createdAt,deploymentId,destinationSha256,destinationSiteId,files,projectId,schemaVersion") {
    throw backupError(`Il manifesto del backup hosting contiene campi non previsti (${Object.keys(candidate).sort().join(",")}).`, "cms-hosting-backup-invalid");
  }
  if (candidate.schemaVersion !== 1 || candidate.deploymentId !== expectedId || typeof candidate.projectId !== "string" || !UUID.test(candidate.projectId)
      || typeof candidate.destinationSiteId !== "string" || !UUID.test(candidate.destinationSiteId)
      || typeof candidate.destinationSha256 !== "string" || !SHA256.test(candidate.destinationSha256)
      || typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))
      || !Array.isArray(candidate.files) || candidate.files.length < 1 || candidate.files.length > 20_000) {
    throw backupError("I dati del backup hosting non superano la verifica.", "cms-hosting-backup-invalid");
  }
  const files: StoredBackupFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < candidate.files.length; index += 1) {
    const raw = candidate.files[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw backupError("Una voce del backup hosting non è valida.", "cms-hosting-backup-invalid");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "beforeBytes,beforeFile,beforeSha256,deployedSha256,path") {
      throw backupError("Una voce del backup hosting contiene campi non previsti.", "cms-hosting-backup-invalid");
    }
    const hasBeforeFile = item.beforeFile !== null;
    if (typeof item.path !== "string" || !validRelativePath(item.path) || seen.has(item.path)
      || hasBeforeFile && item.beforeFile !== `${String(index).padStart(5, "0")}.bin`
      || !hasBeforeFile && item.beforeFile !== null
      || !Number.isSafeInteger(item.beforeBytes) || (item.beforeBytes as number) < 0
      || item.beforeSha256 !== null && (typeof item.beforeSha256 !== "string" || !SHA256.test(item.beforeSha256))
      || typeof item.deployedSha256 !== "string" || !SHA256.test(item.deployedSha256)
      || hasBeforeFile && (typeof item.beforeSha256 !== "string" || !SHA256.test(item.beforeSha256))
      || !hasBeforeFile && (item.beforeBytes !== 0 || item.beforeSha256 !== null)) {
      throw backupError("I dati di un file nel backup hosting non superano la verifica.", "cms-hosting-backup-invalid");
    }
    seen.add(item.path);
    totalBytes += item.beforeBytes as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > CMS_HOSTING_BACKUP_MAX_BYTES) throw backupError("Il backup hosting supera il limite locale di 256 MiB.", "cms-hosting-backup-too-large", 413);
    files.push({ path: item.path, beforeFile: item.beforeFile as string | null, beforeSha256: item.beforeSha256 as string | null, beforeBytes: item.beforeBytes as number, deployedSha256: item.deployedSha256 });
  }
  return {
    schemaVersion: 1,
    deploymentId: candidate.deploymentId as string,
    projectId: candidate.projectId as string,
    destinationSiteId: candidate.destinationSiteId as string,
    destinationSha256: candidate.destinationSha256 as string,
    createdAt: candidate.createdAt as string,
    files,
  };
}

export class CmsHostingBackupStore {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = path.join(dataDirectory, "cms-hosting-backups");
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw backupError("La cartella privata dei backup hosting non è sicura.", "cms-hosting-backup-path-invalid", 500);
    await chmod(this.root, 0o700);
  }

  async has(deploymentId: string): Promise<boolean> {
    safeId(deploymentId);
    try {
      const directory = path.join(this.root, deploymentId);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const manifest = await lstat(path.join(directory, "manifest.json"));
      return manifest.isFile() && !manifest.isSymbolicLink();
    } catch { return false; }
  }

  async create(input: {
    deploymentId: string;
    projectId: string;
    destinationSiteId: string;
    destinationSha256: string;
    entries: Array<{ path: string; beforeBytes: Buffer | null; deployedBytes: Buffer }>;
  }): Promise<{ files: number; storedBytes: number }> {
    safeId(input.deploymentId);
    safeId(input.projectId);
    safeId(input.destinationSiteId);
    if (!SHA256.test(input.destinationSha256) || input.entries.length < 1 || input.entries.length > 20_000) {
      throw backupError("Il piano del backup hosting non è valido.", "cms-hosting-backup-invalid", 500);
    }
    const seen = new Set<string>();
    let storedBytes = 0;
    const files = input.entries.map((entry, index): StoredBackupFile => {
      if (!validRelativePath(entry.path) || seen.has(entry.path)) throw backupError("Il backup contiene un percorso remoto non valido.", "cms-hosting-backup-invalid", 500);
      seen.add(entry.path);
      storedBytes += entry.beforeBytes?.byteLength ?? 0;
      if (!Number.isSafeInteger(storedBytes) || storedBytes > CMS_HOSTING_BACKUP_MAX_BYTES) throw backupError("I file remoti da conservare superano il limite locale di 256 MiB; la pubblicazione è stata fermata prima dell’upload.", "cms-hosting-backup-too-large", 413);
      return {
        path: entry.path,
        beforeFile: entry.beforeBytes === null ? null : `${String(index).padStart(5, "0")}.bin`,
        beforeSha256: entry.beforeBytes === null ? null : sha256(entry.beforeBytes),
        beforeBytes: entry.beforeBytes?.byteLength ?? 0,
        deployedSha256: sha256(entry.deployedBytes),
      };
    });
    await this.ensureRoot();
    const target = path.join(this.root, input.deploymentId);
    if (await this.has(input.deploymentId)) throw backupError("Esiste già un backup per questa pubblicazione.", "cms-hosting-backup-exists", 409);
    const staging = await mkdtemp(path.join(this.root, ".pending-"));
    let committed = false;
    try {
      const blobs = path.join(staging, "files");
      await mkdir(blobs, { mode: 0o700 });
      for (const [index, entry] of input.entries.entries()) {
        if (entry.beforeBytes !== null) await writeFile(path.join(blobs, `${String(index).padStart(5, "0")}.bin`), entry.beforeBytes, { mode: 0o600, flag: "wx" });
      }
      const manifest: StoredBackupManifest = {
        schemaVersion: 1,
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        destinationSiteId: input.destinationSiteId,
        destinationSha256: input.destinationSha256,
        createdAt: new Date().toISOString(),
        files,
      };
      await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
      await rename(staging, target);
      committed = true;
      await chmod(target, 0o700);
      return { files: files.length, storedBytes };
    } finally {
      if (!committed) await rm(staging, { recursive: true, force: true });
    }
  }

  async read(input: { deploymentId: string; projectId: string; destinationSiteId: string; destinationSha256: string }): Promise<CmsHostingBackupFile[]> {
    safeId(input.deploymentId);
    await this.ensureRoot();
    const directory = path.join(this.root, input.deploymentId);
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw backupError("La copia locale necessaria al ripristino non è disponibile o è stata spostata.", "cms-hosting-backup-missing", 409);
    const manifestPath = path.join(directory, "manifest.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 16 * 1024 * 1024) throw backupError("Il manifesto del backup hosting non è sicuro o supera il limite.", "cms-hosting-backup-invalid");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown; }
    catch { throw backupError("Non riesco a leggere il manifesto del backup hosting.", "cms-hosting-backup-invalid"); }
    const manifest = validateManifest(parsed, input.deploymentId);
    if (manifest.projectId !== input.projectId || manifest.destinationSiteId !== input.destinationSiteId || manifest.destinationSha256 !== input.destinationSha256) {
      throw backupError("Il backup non corrisponde più al progetto o alla destinazione configurata.", "cms-hosting-backup-target-changed");
    }
    let totalBytes = 0;
    const result: CmsHostingBackupFile[] = [];
    for (const item of manifest.files) {
      if (item.beforeFile === null) {
        result.push({ path: item.path, beforeBytes: null, beforeSha256: null, deployedSha256: item.deployedSha256 });
        continue;
      }
      const blobPath = path.join(directory, "files", item.beforeFile);
      const blobInfo = await lstat(blobPath).catch(() => null);
      if (!blobInfo?.isFile() || blobInfo.isSymbolicLink() || blobInfo.size !== item.beforeBytes) throw backupError(`Il file di backup ${item.path} non è disponibile o ha una dimensione diversa.`, "cms-hosting-backup-corrupt");
      totalBytes += blobInfo.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > CMS_HOSTING_BACKUP_MAX_BYTES) throw backupError("Il backup hosting supera il limite locale di 256 MiB.", "cms-hosting-backup-too-large", 413);
      const bytes = await readFile(blobPath);
      if (sha256(bytes) !== item.beforeSha256) throw backupError(`La copia locale di ${item.path} non supera il controllo SHA-256.`, "cms-hosting-backup-corrupt");
      result.push({ path: item.path, beforeBytes: bytes, beforeSha256: item.beforeSha256, deployedSha256: item.deployedSha256 });
    }
    return result;
  }
}

