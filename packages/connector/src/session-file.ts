import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { connectorDirectory, SESSION_FILE_NAME } from "./data-directory.js";
import { ConnectorError } from "./errors.js";

/** What Histeon Publish writes to `<data>/connector/session.json` (0600) while the connector is on. */
export interface ConnectorSession {
  v: 1;
  app: "histos-publish";
  port: number;
  instance: string;
  key: string;
  pid: number;
  appVersion: string;
  startedAt: string;
}

export const SESSION_FILE_MAX_BYTES = 4096;
const KEY = /^[A-Za-z0-9_-]{43}$/u;
const INSTANCE = /^[a-f0-9]{32}$/u;
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/u;

export function parseSession(text: string): ConnectorSession | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(",");
  if (keys !== "app,appVersion,instance,key,pid,port,startedAt,v") return null;
  if (item.v !== 1 || item.app !== "histos-publish") return null;
  if (typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65_535) return null;
  if (typeof item.pid !== "number" || !Number.isInteger(item.pid) || item.pid < 1 || item.pid > 2 ** 31) return null;
  if (typeof item.instance !== "string" || !INSTANCE.test(item.instance)) return null;
  if (typeof item.key !== "string" || !KEY.test(item.key) || Buffer.from(item.key, "base64url").byteLength !== 32) return null;
  if (typeof item.appVersion !== "string" || !VERSION.test(item.appVersion)) return null;
  if (typeof item.startedAt !== "string" || item.startedAt.length > 40 || Number.isNaN(Date.parse(item.startedAt))) return null;
  return item as unknown as ConnectorSession;
}

export function sessionKey(session: ConnectorSession): Buffer {
  return Buffer.from(session.key, "base64url");
}

export type SessionRead = { state: "absent" } | { state: "ok"; session: ConnectorSession; key: Buffer };

interface ReadOptions {
  platform?: NodeJS.Platform;
  uid?: number;
}

function unsafe(message: string): ConnectorError {
  return new ConnectorError("connector-unsafe-state", message);
}

function lstatOrNull(target: string): BigIntStats | null {
  try {
    return lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw unsafe(`Non riesco a leggere lo stato del connettore (${(error as NodeJS.ErrnoException).code ?? "errore"}).`);
  }
}

/** Only the owner may read or change it, as ssh asks of its keys. Windows relies on the per-user ACL of %APPDATA%. */
function checkOwner(stats: BigIntStats, what: string, options: ReadOptions): void {
  if ((options.platform ?? process.platform) === "win32") return;
  const uid = options.uid ?? process.getuid?.();
  if (uid !== undefined && stats.uid !== BigInt(uid)) throw unsafe(`${what} appartiene a un altro utente: non lo uso.`);
  if ((stats.mode & 0o077n) !== 0n) throw unsafe(`Permessi troppo aperti su ${what}: non lo uso. Riattiva il connettore da Histeon Publish.`);
}

/**
 * Reads the session file the way ssh reads keys: the folder and the file must not be links, must belong to this
 * user and be closed to everyone else; the file is regular, small, and has exactly the expected shape. Called before
 * every request, so an app restart is picked up without restarting the agent.
 */
export function readSessionFile(dataDirectory: string, options: ReadOptions = {}): SessionRead {
  const directory = connectorDirectory(dataDirectory);
  const directoryStats = lstatOrNull(directory);
  if (!directoryStats) return { state: "absent" };
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) throw unsafe("La cartella del connettore non è una cartella normale: non la uso.");
  checkOwner(directoryStats, "la cartella del connettore", options);
  const file = path.join(directory, SESSION_FILE_NAME);
  const fileStats = lstatOrNull(file);
  if (!fileStats) return { state: "absent" };
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) throw unsafe("session.json non è un file normale: non lo uso.");
  checkOwner(fileStats, "session.json", options);
  if (fileStats.size > BigInt(SESSION_FILE_MAX_BYTES)) throw unsafe("session.json è troppo grande: non lo uso.");
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw unsafe("Non riesco ad aprire session.json in sicurezza.");
  }
  let text: string;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== fileStats.dev || opened.ino !== fileStats.ino) throw unsafe("session.json è cambiato mentre lo leggevo: riprova.");
    const buffer = Buffer.alloc(SESSION_FILE_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, length, buffer.byteLength - length, null);
      if (read === 0) break;
      length += read;
      if (length > SESSION_FILE_MAX_BYTES) throw unsafe("session.json è troppo grande: non lo uso.");
    }
    text = buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
  const session = parseSession(text);
  if (!session) throw unsafe("session.json non ha il formato atteso: non lo uso. Riattiva il connettore da Histeon Publish.");
  return { state: "ok", session, key: sessionKey(session) };
}

/** Whether a process with this id exists (EPERM means it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
