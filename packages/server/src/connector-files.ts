import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, statfs, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";
import { hasControlCharacters } from "@histos-publish/connector/errors";

/**
 * Files the AI connector writes or reads on the agent's behalf (docs/progettazione/histos-cms/16-connettore-ai.md
 * §3.2). The agent never chooses a name or a folder: exports go to one folder the app decides, with a generated name,
 * created exclusively; build files are read only inside a known build, without following links.
 */

export const MIN_FREE_BYTES = 1024 * 1024 * 1024;
export const BUILD_FILE_MAX_BYTES = 512 * 1024;
export const BACKUPS_KEPT = 5;
const BUILD_FILE_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
};

function unsafeDirectory(): HistosPublishError {
  return new HistosPublishError("La cartella del connettore non è sicura: deve essere una cartella normale, tua e chiusa agli altri utenti.", "connector-unsafe-directory", 500);
}

/** mkdir 0700, then: a real directory (not a link), owned by this user, mode forced to 0700. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw unsafeDirectory();
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) throw unsafeDirectory();
    if ((stats.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
  }
}

/**
 * The connector's key and client live under the data folder, so that folder must be private too. POSIX: owned by
 * this user and not writable by group or others (otherwise another account could swap the connector folder).
 * Windows has no modes to check: the folder must sit inside the user's profile, whose ACL is per user, never at a
 * drive root or a shared path where new folders inherit access for every account.
 */
export async function requirePrivateDataDirectory(dataDirectory: string, home = os.homedir()): Promise<void> {
  const refuse = () => new HistosPublishError("La cartella dati di Histeon Publish non è privata: il connettore AI non parte. Usa una cartella dentro il tuo profilo utente.", "connector-unsafe-directory", 409);
  const stats = await lstat(dataDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw refuse();
  if (process.platform === "win32") {
    const real = (await realpath(dataDirectory)).toLowerCase();
    const profile = (await realpath(home).catch(() => home)).toLowerCase();
    if (/^[\\/]{2}/u.test(real) || !inside(profile, real) || real === profile) throw refuse();
    return;
  }
  const uid = process.getuid?.();
  if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o022) !== 0) throw refuse();
}

/** Creates `target` exclusively (never through a link, never over an existing file) with mode 0600, then fsyncs it. */
export async function writeExclusiveFile(target: string, data: Uint8Array | string, mode = 0o600): Promise<void> {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true });
    throw error;
  }
  await handle.close();
}

/** Writes a private file atomically: a new 0600 temporary file next to it, then a rename over the old one. */
export async function writePrivateFileAtomic(target: string, data: Uint8Array | string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeExclusiveFile(temporary, data, mode);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Reads a small regular file that must not be a link; null when it does not exist. */
export async function readPrivateFile(target: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function requireFreeSpace(directory: string, minimum = MIN_FREE_BYTES): Promise<void> {
  if (minimum <= 0) return;
  let free: number;
  try {
    const stats = await statfs(directory);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return;
  }
  if (free < minimum) {
    throw new HistosPublishError(`Spazio su disco insufficiente: servono almeno ${Math.round(minimum / 1024 / 1024)} MB liberi.`, "connector-disk-full", 507);
  }
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function exportFileName(projectName: string, date = new Date()): string {
  const slug = projectName.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60).replace(/-+$/u, "") || "progetto";
  return `${slug}-${stamp(date)}-${randomBytes(2).toString("hex")}.xbsite`;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Writes an .xbsite export into the export folder. The folder must be a real directory of this user and, unless it
 * is the default `connector/exports`, outside the app's data folder (an agent must not be able to drop files there).
 */
export async function writeExport(input: { exportDirectory: string; dataDirectory: string; defaultExportDirectory: string; projectName: string; archive: Buffer }): Promise<{ path: string; bytes: number; sha256: string }> {
  await ensurePrivateDirectory(input.exportDirectory);
  const real = await realpath(input.exportDirectory);
  const dataRoot = await realpath(input.dataDirectory);
  const defaultReal = await realpath(input.defaultExportDirectory).catch(() => path.resolve(input.defaultExportDirectory));
  if (inside(dataRoot, real) && real !== defaultReal) throw new HistosPublishError("La cartella delle esportazioni non può stare dentro i dati di Histeon Publish.", "connector-export-directory-invalid", 500);
  for (let attempt = 0; ; attempt++) {
    const target = path.join(real, exportFileName(input.projectName));
    try {
      await writeExclusiveFile(target, input.archive);
      return { path: target, bytes: input.archive.byteLength, sha256: createHash("sha256").update(input.archive).digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 4) throw error;
    }
  }
}

/** Saves a .histosproject backup before an update and keeps the last few per project. */
function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export interface PendingBackup {
  /** The file name the backup gets once the update has committed. */
  name: string;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/**
 * Saves a .histosproject backup before an update, in two steps: a hidden pending file first, renamed into place
 * only when the update committed (a refused or failed update never evicts an older backup). Names are UTC stamps,
 * so their order is creation order across time zones and daylight-saving changes; the last few are kept, never the
 * one just written.
 */
export async function prepareBackup(connectorDirectory: string, projectId: string, archive: Buffer): Promise<PendingBackup> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(projectId)) throw new HistosPublishError("Progetto non valido per il backup.", "connector-backup-invalid", 500);
  const backups = path.join(connectorDirectory, "backups");
  await ensurePrivateDirectory(backups);
  const directory = path.join(backups, projectId);
  await ensurePrivateDirectory(directory);
  const name = `${utcStamp(new Date())}-${randomBytes(3).toString("hex")}.histosproject`;
  const pending = path.join(directory, `.pending-${randomBytes(6).toString("hex")}.histosproject`);
  await writeExclusiveFile(pending, archive);
  return {
    name,
    commit: async () => {
      await rename(pending, path.join(directory, name));
      const kept = (await readdir(directory)).filter((item) => item.endsWith(".histosproject") && !item.startsWith(".") && item !== name).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - (BACKUPS_KEPT - 1)))) await rm(path.join(directory, old), { force: true });
    },
    discard: async () => {
      await rm(pending, { force: true });
    },
  };
}

/**
 * Reads one text file of a build. The path is a published path (letters, digits, `._~/-`), with no segment that
 * starts with "." and no backslash or percent; every segment is checked with lstat, so a link inside the bundle is
 * refused, and the real path must stay inside the build.
 */
export async function readBuildTextFile(input: { dataDirectory: string; projectId: string; buildId: string; path?: string }): Promise<{ path: string; contentType: string; bytes: number; text: string; truncated: boolean }> {
  let relative = input.path ?? "index.html";
  if (relative === "" || relative.endsWith("/")) relative += "index.html";
  const segments = relative.split("/");
  if (relative.length > 300 || /[\\%]/u.test(relative) || (process.platform === "win32" && /~[0-9]/u.test(relative)) || hasControlCharacters(relative) || segments.some((segment) => !segment || segment.startsWith(".") || !/^[A-Za-z0-9._~-]+$/u.test(segment))) {
    throw new HistosPublishError("Percorso del file non valido: usa un percorso pubblicato come index.html o chi-siamo/index.html.", "connector-build-path-invalid", 400);
  }
  const contentType = BUILD_FILE_TYPES[path.extname(relative).toLowerCase()];
  if (!contentType) throw new HistosPublishError("Leggo solo file di testo della build: html, css, js, json, xml, txt, svg.", "connector-build-file-type", 415);
  const missing = () => new HistosPublishError("Il file non esiste nella build.", "connector-build-file-missing", 404);
  let root: string;
  let dataRoot: string;
  try {
    dataRoot = await realpath(input.dataDirectory);
    root = await realpath(path.join(input.dataDirectory, "histos-cms-builds", input.projectId, input.buildId));
  } catch {
    throw new HistosPublishError("La build non è disponibile.", "cms-build-missing", 404);
  }
  // A build folder that leads elsewhere (a link) holds no file of this build.
  if (root !== path.join(dataRoot, "histos-cms-builds", input.projectId, input.buildId)) throw missing();
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch {
      throw missing();
    }
    if (stats.isSymbolicLink()) throw missing();
    if (index < segments.length - 1 ? !stats.isDirectory() : !stats.isFile()) throw missing();
  }
  const real = await realpath(current);
  // Real names too: on Windows a short 8.3 name (HISTOS~1) can stand for a hidden ".histos" entry.
  if (!inside(root, real) || path.relative(root, real).split(path.sep).some((part) => part.startsWith("."))) throw missing();
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw missing();
    const length = Math.min(stats.size, BUILD_FILE_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { path: relative, contentType, bytes: stats.size, text: buffer.subarray(0, read).toString("utf8"), truncated: stats.size > read };
  } finally {
    await handle.close();
  }
}

/** Removes scratch catalogs older than an hour that a crash left in the data folder. */
export async function removeStalePrototypeScratch(dataDirectory: string, olderThanMs = 3_600_000): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dataDirectory);
  } catch {
    return;
  }
  const limit = Date.now() - olderThanMs;
  for (const name of names) {
    if (!/^\.prototype-(?:check-)?[0-9a-f-]{36}$/u.test(name)) continue;
    const target = path.join(dataDirectory, name);
    try {
      const stats = await lstat(target);
      if (!stats.isSymbolicLink() && stats.isDirectory() && stats.mtimeMs < limit) await rm(target, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to touch.
    }
  }
}
