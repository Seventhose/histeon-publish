import { Client, type SFTPWrapper, type Stats } from "ssh2";
import { HistosPublishError } from "@histos-publish/core";

export interface SftpEndpoint {
  host: string;
  port: number;
  username?: string;
  hostKeyFingerprint?: string;
  authMethod?: "password" | "privateKey";
}

export interface SftpAuthentication {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  authMethod?: "password" | "privateKey";
}

export function fingerprintFromSha256Hex(hexHash: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(hexHash)) throw new TypeError("Impronta SSH SHA-256 non valida.");
  return `SHA256:${Buffer.from(hexHash, "hex").toString("base64").replace(/=+$/u, "")}`;
}

function abortError(label: string): HistosPublishError {
  return new HistosPublishError(`${label} annullata.`, "operation-cancelled", 2);
}

/** Reads a host key without authenticating or sending the user's credentials. */
export async function readSftpHostFingerprint(
  endpoint: Pick<SftpEndpoint, "host" | "port"> & { username: string },
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw abortError("Verifica SFTP");
  const client = new Client();
  return await new Promise<string>((resolve, reject) => {
    let fingerprint = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(fingerprint);
    };
    const onAbort = () => {
      client.end();
      finish(abortError("Verifica SFTP"));
    };
    client.on("error", (error) => {
      if (fingerprint) finish();
      else finish(error);
    });
    client.once("close", () => {
      if (fingerprint) finish();
      else finish(new Error("Il server SFTP ha chiuso la connessione prima di presentare la chiave host."));
    });
    client.once("ready", () => {
      client.end();
      if (fingerprint) finish();
      else finish(new Error("Il server SFTP non ha presentato una chiave host verificabile."));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      client.end();
      finish(new Error("Il server SFTP non ha risposto entro il tempo previsto."));
    }, 15_000);
    try {
      client.connect({
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        readyTimeout: 12_000,
        hostHash: "sha256",
        hostVerifier: (hexHash: string) => {
          fingerprint = fingerprintFromSha256Hex(hexHash);
          // Reject before authentication. This connection is only for TOFU confirmation.
          return false;
        },
      });
    } catch (error) {
      finish(error);
    }
  });
}

interface SftpSession {
  client: Client;
  sftp: SFTPWrapper;
}

async function openSftpSession(
  endpoint: SftpEndpoint,
  credentials: SftpAuthentication,
  signal?: AbortSignal,
): Promise<SftpSession> {
  if (signal?.aborted) throw abortError("Operazione SFTP");
  if (!endpoint.hostKeyFingerprint) {
    throw new HistosPublishError("La chiave host SFTP non è stata confermata.", "hosting-hostkey-unconfirmed", 2);
  }
  const client = new Client();
  return await new Promise<SftpSession>((resolve, reject) => {
    let settled = false;
    let hostKeyChanged = false;
    let actualFingerprint = "";
    const finish = (error?: unknown, sftp?: SFTPWrapper) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        client.end();
        reject(error);
      } else if (sftp) {
        resolve({ client, sftp });
      } else {
        client.end();
        reject(new Error("Il canale SFTP non è disponibile."));
      }
    };
    const onAbort = () => finish(abortError("Operazione SFTP"));
    client.on("error", (error) => {
      if (!settled) {
        finish(hostKeyChanged
          ? new HistosPublishError(`La chiave SSH del server è cambiata. L’impronta ricevuta è ${actualFingerprint}.`, "hosting-hostkey-changed", 2)
          : error);
      }
    });
    client.once("close", () => {
      if (!settled) {
        finish(hostKeyChanged
          ? new HistosPublishError(`La chiave SSH del server è cambiata. L’impronta ricevuta è ${actualFingerprint}.`, "hosting-hostkey-changed", 2)
          : new Error("Il server SFTP ha chiuso la connessione prima dell’accesso."));
      }
    });
    client.once("ready", () => {
      client.sftp((error, sftp) => {
        if (error) finish(error);
        else finish(undefined, sftp);
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    const authMethod = credentials.authMethod ?? endpoint.authMethod ?? "password";
    const config = {
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username ?? credentials.username,
      readyTimeout: 20_000,
      hostHash: "sha256" as const,
      hostVerifier: (hexHash: string) => {
        actualFingerprint = fingerprintFromSha256Hex(hexHash);
        hostKeyChanged = actualFingerprint !== endpoint.hostKeyFingerprint;
        return !hostKeyChanged;
      },
      ...(authMethod === "privateKey"
        ? credentials.privateKey
          ? { privateKey: credentials.privateKey, ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}) }
          : {}
        : { password: credentials.password ?? "" }),
    };
    try {
      client.connect(config);
    } catch (error) {
      finish(error);
    }
  });
}

/** Keeps one authenticated, host-key-pinned connection for a bounded SFTP operation. */
export async function withSftpConnection<T>(options: {
  endpoint: SftpEndpoint;
  credentials: SftpAuthentication;
  signal?: AbortSignal;
  timeoutMs?: number;
  run: (sftp: SFTPWrapper) => Promise<T>;
}): Promise<T> {
  const { client, sftp } = await openSftpSession(options.endpoint, options.credentials, options.signal);
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (options.signal?.aborted) throw abortError("Operazione SFTP");
    const interrupted = new Promise<never>((_, reject) => {
      if (options.signal) {
        onAbort = () => {
          client.end();
          reject(abortError("Operazione SFTP"));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      timeout = setTimeout(() => {
        client.end();
        reject(new Error("L’operazione SFTP non è terminata entro il tempo previsto."));
      }, options.timeoutMs ?? 120_000);
    });
    return await Promise.race([Promise.resolve().then(() => options.run(sftp)), interrupted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    client.end();
  }
}

function sftpResultCall<T>(invoke: (callback: (error: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => invoke((error, result) => error ? reject(error) : resolve(result)));
}

function sftpVoidCall(invoke: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => invoke((error) => error ? reject(error) : resolve()));
}

export function listSftpDirectory(sftp: SFTPWrapper, remoteDirectory: string): Promise<Array<{ filename: string; attrs?: { mode?: number; size?: number } }>> {
  return sftpResultCall((callback) => sftp.readdir(remoteDirectory, callback));
}

export function statSftpPath(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return sftpResultCall((callback) => sftp.stat(remotePath, callback));
}

export function lstatSftpPath(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return sftpResultCall((callback) => sftp.lstat(remotePath, callback));
}

export async function readSftpFile(sftp: SFTPWrapper, remotePath: string, maxBytes: number): Promise<Buffer> {
  const info = await lstatSftpPath(sftp, remotePath);
  const fileType = typeof info.mode === "number" ? info.mode & 0o170000 : 0;
  if (fileType !== 0o100000) throw new HistosPublishError("Il percorso remoto non è un file regolare. Per sicurezza il backup è stato fermato.", "hosting-backup-file-type-unsupported", 409);
  if (!Number.isSafeInteger(info.size) || typeof info.size !== "number" || info.size < 0 || info.size > maxBytes) throw new HistosPublishError("Un file remoto supera il limite previsto per il backup locale.", "cms-hosting-backup-too-large", 413);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of sftp.createReadStream(remotePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) throw new HistosPublishError("Un file remoto supera il limite previsto per il backup locale.", "cms-hosting-backup-too-large", 413);
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError("Non riesco a leggere il file remoto necessario al backup.", "cms-hosting-backup-read-failed", 4);
  }
  if (total !== info.size) throw new HistosPublishError("Un file remoto è cambiato durante il backup. Ripeti il controllo della destinazione.", "cms-hosting-backup-stale", 409);
  return Buffer.concat(chunks, total);
}

export async function ensureSftpDirectories(sftp: SFTPWrapper, directories: string[]): Promise<void> {
  for (const directory of directories) {
    try {
      await sftpVoidCall((callback) => sftp.mkdir(directory, callback));
    } catch (error) {
      try {
        if ((await statSftpPath(sftp, directory)).isDirectory()) continue;
      } catch {
        // Keep the original mkdir error for the user-facing diagnostic.
      }
      throw error;
    }
  }
}

export function uploadSftpFile(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return sftpVoidCall((callback) => sftp.fastPut(localPath, remotePath, callback));
}

export function removeSftpFile(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return sftpVoidCall((callback) => sftp.unlink(remotePath, callback));
}
