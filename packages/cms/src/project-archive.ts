import { HISTOS_PUBLISH_VERSION } from "./version.js";
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import type { Entry as ZipEntry } from "yauzl";
import yazl from "yazl";
import { canonicalizeJson, parseJsonStrict } from "@histos-publish/histos-contract";
import { unreadableArchive } from "./page-transfer.js";
import { CmsBackupUnrestorableError, type CmsProject, type CmsProjectStore, type NativeBackupSizes } from "./project-repository.js";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/**
 * The one entry a backup compresses. Media are stored as they are: images and fonts are compressed already, and a
 * stored entry never exceeds the restore's compression ratio limit (readEntries), whatever its bytes.
 */
const COMPRESSED_ENTRY = "content.sqlite";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const MEDIA_PATH = /^media\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/u;

export interface NativeProjectMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface NativeProjectFile { path: string; bytes: number; sha256: string; mediaType: string }
export interface NativeProjectManifest {
  format: "histos-project";
  version: 1;
  generator: { name: "Histos Publish"; version: string };
  project: NativeProjectMetadata;
  files: NativeProjectFile[];
  manifestHash: string;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function json(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) as unknown; }

function validateProjectMetadata(value: unknown): asserts value is NativeProjectMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Metadati progetto mancanti nel backup.");
  const project = value as Record<string, unknown>;
  if (Object.keys(project).sort().join(",") !== "createdAt,id,name,schemaVersion,updatedAt") throw new TypeError("Il backup contiene campi progetto non previsti.");
  if (typeof project.id !== "string" || !UUID.test(project.id) || typeof project.name !== "string" || !project.name.trim() || project.name.length > 120
    || typeof project.createdAt !== "string" || !Number.isFinite(Date.parse(project.createdAt))
    || typeof project.updatedAt !== "string" || !Number.isFinite(Date.parse(project.updatedAt)) || project.schemaVersion !== 1) {
    throw new TypeError("Metadati del progetto nel backup non validi.");
  }
}

const mediaType = (filePath: string): string => filePath === "content.sqlite" ? "application/vnd.sqlite3" : "application/octet-stream";
const byPath = (a: { path: string }, b: { path: string }): number => a.path.localeCompare(b.path);

/**
 * The project as a backup carries it: the five fields its restore accepts and nothing else project.json may hold,
 * checked as the restore checks them (CmsBackupUnrestorableError otherwise).
 */
function backupProject(project: CmsProject): NativeProjectMetadata {
  const metadata = { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, schemaVersion: project.schemaVersion };
  try { validateProjectMetadata(metadata); }
  catch (error) {
    if (error instanceof TypeError) throw new CmsBackupUnrestorableError(error.message);
    throw error;
  }
  return metadata;
}

function nativeManifest(project: CmsProject, files: NativeProjectFile[], version: string): NativeProjectManifest {
  const manifestBase = {
    format: "histos-project" as const,
    version: 1 as const,
    generator: { name: "Histos Publish" as const, version },
    project: backupProject(project),
    files,
  };
  return { ...manifestBase, manifestHash: sha256(Buffer.from(canonicalizeJson(json(manifestBase) as never), "utf8")) };
}

const manifestBytes = (manifest: NativeProjectManifest): Buffer => Buffer.from(canonicalizeJson(json(manifest) as never), "utf8");

/** The entry count and path rules of a backup: a database and media at their sha256 paths, at most MAX_ARCHIVE_ENTRIES with the manifest. */
function assertBackupEntries(paths: readonly string[]): void {
  if (paths.length > MAX_ARCHIVE_ENTRIES - 1 || paths.some((filePath) => filePath !== "content.sqlite" && !MEDIA_PATH.test(filePath))) throw new RangeError("Il progetto supera i limiti del backup Histeon.");
}

/**
 * The limits on the content of a backup, before compression, as its restore applies them: a manifest of at most 4 MiB,
 * and 512 MiB for every entry together, the manifest included (readEntries counts it too).
 */
function assertBackupBytes(manifest: number, sizes: readonly number[]): void {
  if (manifest > MAX_MANIFEST_BYTES) throw new RangeError("Il progetto supera i limiti del backup Histeon.");
  if (sizes.reduce((sum, bytes) => sum + bytes, manifest) > MAX_ARCHIVE_BYTES) throw new RangeError("Il progetto supera il limite di 512 MiB.");
}

/**
 * The most bytes one entry takes in the archive yazl writes from a buffer: local header and central record (with its
 * 9-byte timestamp field, no data descriptor, no ZIP64 under 4 GiB) around the name twice, and the data: as it is when
 * stored, and within zlib's deflateBound when compressed (the default window and memory level yazl compresses with
 * fall back to stored blocks for incompressible data: about 0.03% more, plus 7 bytes).
 */
function zipEntryBound(name: string, bytes: number, compressed: boolean): number {
  const deflate = compressed ? Math.floor(bytes / 4096) + Math.floor(bytes / 16_384) + Math.floor(bytes / 33_554_432) + 7 : 0;
  return 30 + 46 + 9 + 2 * Buffer.byteLength(name, "utf8") + bytes + deflate;
}

/**
 * Throws the RangeError encodeNativeProjectArchive throws for a backup of these sizes (NativeBackupSizes: what the
 * backup holds, measured exactly and never read). The limits are those of the restore (readEntries,
 * decodeNativeProjectArchive), so a backup that passes is never refused for its size there: at most 9,999 files besides
 * the manifest, 512 MiB of content with the manifest, a manifest of at most 4 MiB, and an archive of at most 512 MiB,
 * bounded from above (zipEntryBound for every entry, the manifest as it is written). It answers before a backup is
 * needed (queue D2: an update saves one first, so a request that could only fail is never put to the user): the check
 * before an update calls it with the sizes of its copy of the project (copyProjectForComparison), the backup itself
 * with those of its own snapshot (CmsProjectStore.withBackupSnapshot), and for the same project these are the same
 * sizes, so the check and the update cannot disagree. Only the database's deflate margin is an estimate: a backup
 * within about 0.03% of the database of 512 MiB may be refused although its compressed archive would have fitted.
 * Project metadata a restore refuses is a CmsBackupUnrestorableError.
 */
export function assertNativeBackupFits(project: CmsProject, sizes: NativeBackupSizes, version = HISTOS_PUBLISH_VERSION): void {
  assertBackupEntries(["content.sqlite", ...sizes.media.map((file) => file.path)]);
  // The manifest as the encoder writes it: same fields and lengths (the database digest is only a stand-in of the same length).
  const files: NativeProjectFile[] = [
    { path: "content.sqlite", bytes: sizes.database, sha256: "0".repeat(64), mediaType: mediaType("content.sqlite") },
    ...sizes.media.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.path.split("/").at(-1) ?? "", mediaType: mediaType(file.path) })),
  ].sort(byPath);
  const manifest = manifestBytes(nativeManifest(project, files, version)).byteLength;
  assertBackupBytes(manifest, files.map((file) => file.bytes));
  const archive = 22 + zipEntryBound("histos-project.json", manifest, false) + files.reduce((sum, file) => sum + zipEntryBound(file.path, file.bytes, file.path === COMPRESSED_ENTRY), 0);
  if (archive > MAX_ARCHIVE_BYTES) throw new RangeError("Il backup supera il limite di 512 MiB.");
}

/** The archive yazl writes: the manifest first, then the files by path; only the database compressed, if `compress`. */
function zipBackup(manifest: Buffer, files: ReadonlyMap<string, Buffer>, compress: boolean): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(manifest, "histos-project.json", { mode: 0o100600, mtime: new Date(0), compress: false });
  for (const [filePath, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) zip.addBuffer(bytes, filePath, { mode: 0o100600, mtime: new Date(0), compress: compress && filePath === COMPRESSED_ENTRY });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

/**
 * A backup of the project (.histosproject) that its restore accepts. The database is copied once and that copy, with
 * the media of its live assets, is measured exactly and checked against the limits (assertNativeBackupFits) before
 * anything is read; the archive is then made from the same copy, so it holds what was measured and the check before an
 * update gives the same answer as the update. What a restore would refuse is refused here, before anything is saved
 * (CmsBackupUnrestorableError): a database its checks refuse, a media file whose bytes no longer match its sha256 name
 * or that is gone, project metadata it does not accept. The manual backup (POST …/backup) is this archive too, and is
 * refused the same way: never a backup that cannot be restored. A media file's refusal says how to repair it (upload
 * the same file again: CmsProjectStore.saveAsset puts it back), since the app has no other copy of it to fall back
 * on. The archive is read back as the restore first reads it (entryRefusal on its
 * central directory, nothing decompressed): the database, the one compressed entry, is stored as well should it
 * compress past the restore's ratio limit.
 */
export async function encodeNativeProjectArchive(project: CmsProject, store: CmsProjectStore, version = HISTOS_PUBLISH_VERSION): Promise<Buffer> {
  return store.withBackupSnapshot(async ({ sizes, read }) => {
    assertNativeBackupFits(project, sizes, version);
    const files = new Map<string, Buffer>();
    const declared: NativeProjectFile[] = [];
    for (const filePath of ["content.sqlite", ...sizes.media.map((file) => file.path)]) {
      const file = await read(filePath);
      files.set(filePath, file.bytes);
      declared.push({ path: filePath, bytes: file.bytes.byteLength, sha256: file.sha256, mediaType: mediaType(filePath) });
    }
    const manifest = manifestBytes(nativeManifest(project, declared.sort(byPath), version));
    // The bytes read are the ones measured (a private database copy, media that match their names): checked again all the same.
    assertBackupEntries([...files.keys()]);
    assertBackupBytes(manifest.byteLength, [...files.values()].map((bytes) => bytes.byteLength));
    let archive = await zipBackup(manifest, files, true);
    let refusal = await archiveRefusal(archive);
    // The sizes are checked already, so a RangeError on the compressed entry is its ratio: stored, it has none.
    if (refusal?.path === COMPRESSED_ENTRY && refusal.error instanceof RangeError) {
      archive = await zipBackup(manifest, files, false);
      refusal = await archiveRefusal(archive);
    }
    if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new RangeError("Il backup supera il limite di 512 MiB.");
    if (refusal) throw new CmsBackupUnrestorableError(refusal.error.message);
    return archive;
  });
}

/**
 * Why the restore refuses an archive entry before reading it, or null: past MAX_ARCHIVE_ENTRIES, a symlink, a path
 * outside a backup's layout or one of `seen` again (case aside), or a size or compression ratio past the limits (a zip
 * bomb). `seen` holds the lowercased paths of the entries before it and `total` their bytes. readEntries applies it as
 * it reads, and the encoder to its own archive (archiveRefusal), so a backup is never one the restore refuses here.
 */
function entryRefusal(entry: ZipEntry, seen: ReadonlySet<string>, total: number): TypeError | RangeError | null {
  const filePath = entry.fileName;
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (seen.size >= MAX_ARCHIVE_ENTRIES || mode === 0o120000 || filePath.endsWith("/") || filePath.includes("\\") || filePath.startsWith("/")
    || filePath.split("/").some((part) => part === "" || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+$/u.test(filePath)
    || filePath !== "histos-project.json" && filePath !== "content.sqlite" && !MEDIA_PATH.test(filePath) || seen.has(filePath.toLocaleLowerCase("en-US"))) {
    return new TypeError(`Percorso ZIP non consentito o duplicato: ${filePath.slice(0, 100)}`);
  }
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_ARCHIVE_BYTES || total + entry.uncompressedSize > MAX_ARCHIVE_BYTES
    || entry.uncompressedSize > 1024 * 1024 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > 1000)) {
    return new RangeError(`Dimensione o compressione non consentita: ${filePath}`);
  }
  return null;
}

/** The first entry of `archive` the restore would refuse before reading it (entryRefusal), from the central directory alone. */
function archiveRefusal(archive: Buffer): Promise<{ path: string; error: TypeError | RangeError } | null> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(unreadableArchive(error)); return; }
      const seen = new Set<string>();
      let total = 0;
      let settled = false;
      zip.on("error", (reason: Error) => {
        if (settled) return;
        settled = true;
        reject(unreadableArchive(reason));
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(null);
      });
      zip.on("entry", (entry: ZipEntry) => {
        const refused = entryRefusal(entry, seen, total);
        if (refused) {
          settled = true;
          zip.close();
          resolve({ path: entry.fileName, error: refused });
          return;
        }
        seen.add(entry.fileName.toLocaleLowerCase("en-US"));
        total += entry.uncompressedSize;
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

function readEntries(archive: Buffer): Promise<Map<string, Buffer>> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new RangeError("Il backup supera il limite di 512 MiB.");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(unreadableArchive(error)); return; }
      const entries = new Map<string, Buffer>();
      const names = new Set<string>();
      let total = 0;
      let failed = false;
      const fail = (reason: Error): void => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(reason);
      };
      zip.on("error", (reason: Error) => fail(unreadableArchive(reason)));
      zip.on("end", () => { if (!failed) resolve(entries); });
      zip.on("entry", (entry: ZipEntry) => {
        const filePath = entry.fileName;
        const refused = entryRefusal(entry, names, total);
        if (refused) {
          fail(refused);
          return;
        }
        names.add(filePath.toLocaleLowerCase("en-US"));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(unreadableArchive(streamError)); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > entry.uncompressedSize || total + size > MAX_ARCHIVE_BYTES) { stream.destroy(new RangeError("Voce ZIP oltre i limiti dichiarati.")); return; }
            chunks.push(chunk);
          });
          stream.once("error", (reason: Error) => fail(reason instanceof RangeError ? reason : unreadableArchive(reason)));
          stream.once("end", () => {
            if (size !== entry.uncompressedSize) { fail(new TypeError(`Dimensione ZIP non coerente: ${filePath}`)); return; }
            total += size;
            entries.set(filePath, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function validateManifest(value: unknown): asserts value is NativeProjectManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Manifest Histeon mancante.");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).sort().join(",") !== "files,format,generator,manifestHash,project,version") throw new TypeError("Il manifest contiene campi non previsti.");
  if (manifest.format !== "histos-project" || manifest.version !== 1 || !manifest.generator || typeof manifest.generator !== "object") throw new TypeError("Formato o versione del backup Histeon sconosciuti.");
  validateProjectMetadata(manifest.project);
  const generator = manifest.generator as Record<string, unknown>;
  if (Object.keys(generator).sort().join(",") !== "name,version") throw new TypeError("Il generatore del backup contiene campi non previsti.");
  if (generator.name !== "Histos Publish" || typeof generator.version !== "string" || generator.version.length > 64) throw new TypeError("Generatore del backup non valido.");
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_ARCHIVE_ENTRIES - 1) throw new TypeError("Elenco file del backup non valido.");
  const seen = new Set<string>();
  for (const raw of manifest.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Voce file del backup non valida.");
    const file = raw as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "bytes,mediaType,path,sha256") throw new TypeError("La voce file contiene campi non previsti.");
    if (typeof file.path !== "string" || file.path !== "content.sqlite" && !MEDIA_PATH.test(file.path) || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || typeof file.sha256 !== "string" || !SHA256.test(file.sha256) || typeof file.mediaType !== "string") throw new TypeError("Descrizione file del backup non valida.");
    const key = file.path.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new TypeError(`File duplicato nel backup: ${file.path}.`);
    seen.add(key);
  }
  if (!seen.has("content.sqlite") || typeof manifest.manifestHash !== "string" || !SHA256.test(manifest.manifestHash)) throw new TypeError("Manifest senza database o hash valido.");
  const { manifestHash, ...body } = manifest;
  const expected = sha256(Buffer.from(canonicalizeJson(json(body) as never), "utf8"));
  if (expected !== manifestHash) throw new TypeError("Hash del manifest del backup non valido.");
}

export async function decodeNativeProjectArchive(archive: Buffer): Promise<{ project: NativeProjectMetadata; files: Map<string, Buffer> }> {
  const entries = await readEntries(archive);
  const manifestBytes = entries.get("histos-project.json");
  if (!manifestBytes) throw new TypeError("Manca histos-project.json nel backup.");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new RangeError("Il manifest del backup supera 4 MiB.");
  const manifestValue = parseJsonStrict(manifestBytes);
  validateManifest(manifestValue);
  const manifest = manifestValue as NativeProjectManifest;
  if (entries.size !== manifest.files.length + 1) throw new TypeError("Il backup contiene file mancanti o non dichiarati.");
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const declared of manifest.files) {
    const bytes = entries.get(declared.path);
    if (!bytes || bytes.byteLength !== declared.bytes || sha256(bytes) !== declared.sha256) throw new TypeError(`Integrità non valida per ${declared.path}.`);
    total += bytes.byteLength;
    if (total > MAX_ARCHIVE_BYTES) throw new RangeError("Il progetto supera il limite di 512 MiB.");
    files.set(declared.path, bytes);
  }
  const database = files.get("content.sqlite");
  if (!database || !database.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "binary"))) throw new TypeError("Il backup non contiene un database SQLite valido.");
  for (const [filePath, bytes] of files) {
    if (filePath === "content.sqlite") continue;
    const digest = sha256(bytes);
    if (filePath.split("/").at(-1) !== digest || filePath.split("/")[2] !== digest.slice(0, 2)) throw new TypeError(`Hash del media non coerente con il percorso: ${filePath}.`);
  }
  return { project: manifest.project, files };
}
