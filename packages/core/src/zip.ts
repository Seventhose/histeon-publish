import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES, type ReadSourceResult, type SourceFile } from "./filesystem.js";
import { safeZipEntryName } from "./paths.js";
import type { Finding } from "./types.js";

export interface ReadZipOptions {
  maxFiles?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Impossibile aprire il file ZIP."));
      else resolve(zip);
    });
  });
}

/** The limit as the message says it: in MiB from one MiB up, in bytes below. */
function limitText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Number((bytes / 1024 / 1024).toFixed(1)).toLocaleString("it-IT")} MiB` : `${bytes} byte`;
}

function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("Impossibile leggere un elemento ZIP."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          stream.destroy(new Error("Elemento ZIP oltre il limite consentito."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks, size)));
    });
  });
}

export interface ZipSourceResult extends ReadSourceResult {
  strippedRoot?: string;
}

export async function readZipSource(zipPath: string, options: ReadZipOptions = {}): Promise<ZipSourceResult> {
  const realZip = await realpath(zipPath).catch(() => {
    throw new HistosPublishError("Il file ZIP non esiste o non è accessibile.", "source-unreachable", 5);
  });
  if (!(await lstat(realZip)).isFile()) throw new HistosPublishError("La sorgente ZIP non è un file regolare.", "source-invalid", 2);
  const zip = await openZip(realZip).catch(() => {
    throw new HistosPublishError("Il file ZIP è danneggiato o non valido.", "zip-invalid", 2);
  });
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const files: SourceFile[] = [];
  const skipped: string[] = [];
  const findings: Finding[] = [];
  const names = new Set<string>();
  let count = 0;
  let totalBytes = 0;

  return await new Promise<ReadSourceResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      if (error) reject(error);
      else {
        let outputFiles = files.sort((a, b) => a.path.localeCompare(b.path, "en"));
        let strippedRoot: string | undefined;
        if (!outputFiles.some((file) => file.path === "index.html")) {
          const nestedIndex = outputFiles.find((file) => /^[^/]+\/index\.html$/u.test(file.path));
          const prefix = nestedIndex?.path.split("/")[0];
          if (prefix && outputFiles.every((file) => file.path.startsWith(`${prefix}/`))) {
            strippedRoot = prefix;
            outputFiles = outputFiles.map((file) => ({ ...file, path: file.path.slice(prefix.length + 1) }));
            findings.push({ code: "zip-root-directory", severity: "warn", file: prefix, message: "La cartella principale del ZIP è stata rimossa automaticamente." });
          }
        }
        resolve({ files: outputFiles, skipped, findings, ...(strippedRoot ? { strippedRoot } : {}) });
      }
    };
    zip.on("error", () => finish(new HistosPublishError("Il file ZIP contiene dati non validi o un percorso non sicuro.", "zip-invalid", 2)));
    zip.on("end", () => finish());
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        try {
          throwIfAborted(options.signal);
          count += 1;
          if (count > maxFiles * 2) throw new HistosPublishError(`Il file ZIP supera il limite di ${maxFiles} elementi.`, "zip-too-many-files", 2);
          const safe = safeZipEntryName(entry.fileName);
          if (!safe) {
            findings.push({ code: "unsafe-zip-entry", severity: "block", file: "[elemento ZIP]", message: "Il ZIP contiene un percorso assoluto, traversal o un nome non sicuro." });
            skipped.push("[elemento ZIP non sicuro]");
            zip.readEntry();
            return;
          }
          if (safe.path.endsWith("/")) {
            zip.readEntry();
            return;
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) {
            findings.push({ code: "zip-symlink", severity: "block", file: safe.path, message: "Il ZIP contiene un collegamento simbolico." });
            skipped.push(safe.path);
            zip.readEntry();
            return;
          }
          const collision = safe.path.toLocaleLowerCase("en-US");
          if (names.has(collision)) throw new HistosPublishError(`Il ZIP contiene nomi duplicati o in collisione: ${safe.path}`, "zip-path-collision", 2);
          names.add(collision);
          if (entry.uncompressedSize > maxBytes || totalBytes + entry.uncompressedSize > maxBytes) {
            throw new HistosPublishError(`Il contenuto estratto del ZIP supera il limite di ${limitText(maxBytes)}.`, "zip-too-large", 2);
          }
          if (entry.uncompressedSize > 1024 * 1024 && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 1000) {
            throw new HistosPublishError(`Il file ZIP ha un rapporto di compressione sospetto: ${safe.path}`, "zip-suspicious-ratio", 2);
          }
          if (files.length >= maxFiles) throw new HistosPublishError(`Il file ZIP supera il limite di ${maxFiles} file.`, "zip-too-many-files", 2);
          const bytes = await readEntry(zip, entry, maxBytes - totalBytes);
          if (bytes.byteLength !== entry.uncompressedSize) throw new HistosPublishError(`Dimensione ZIP non coerente: ${safe.path}`, "zip-size-mismatch", 2);
          totalBytes += bytes.byteLength;
          files.push({ path: safe.path, bytes, sourcePath: `${path.basename(realZip)}:${safe.path}` });
          if (safe.changed) findings.push({ code: "unicode-normalized", severity: "warn", file: safe.path, message: "Il nome è stato normalizzato in Unicode NFC." });
          zip.readEntry();
        } catch (error) {
          finish(error);
        }
      })();
    });
    if (options.signal) {
      options.signal.addEventListener("abort", () => finish(new HistosPublishError("Operazione annullata.", "cancelled", 6)), { once: true });
    }
    zip.readEntry();
  });
}

export async function inspectZipSource(zipPath: string, options: ReadZipOptions = {}): Promise<{
  fileCount: number;
  totalBytes: number;
  rootIndexFound: boolean;
  strippedRoot?: string;
  blockedFindings: number;
  previewFiles: string[];
}> {
  const result = await readZipSource(zipPath, options);
  return {
    fileCount: result.files.length,
    totalBytes: result.files.reduce((total, file) => total + file.bytes.byteLength, 0),
    rootIndexFound: result.files.some((file) => file.path === "index.html"),
    ...(result.strippedRoot ? { strippedRoot: result.strippedRoot } : {}),
    blockedFindings: result.findings.filter((finding) => finding.severity === "block").length,
    previewFiles: result.files.slice(0, 8).map((file) => file.path),
  };
}
