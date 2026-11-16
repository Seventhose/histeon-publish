/**
 * The ZIP of a design file (`.penpot`, `.fig`), read in memory (note penpot-figma-a-histeon.md, phase 2).
 *
 * A design file comes from outside: nothing is written to disk, only the entries the caller asks for are inflated,
 * and counts and sizes are capped before and while reading. Node only (yauzl).
 */

import yauzl from "yauzl";
import type { Entry as ZipEntry } from "yauzl";

export interface DesignZipLimits {
  /** The archive itself. */
  archiveBytes: number;
  /** Entries in the central directory, kept or not. */
  entries: number;
  /** One kept entry, inflated. */
  entryBytes: number;
  /** All the kept entries together, inflated. */
  totalBytes: number;
}

export const DESIGN_ZIP_LIMITS: DesignZipLimits = {
  archiveBytes: 512 * 1024 * 1024,
  entries: 200_000,
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 768 * 1024 * 1024,
};

export interface DesignZip {
  /** Every file of the archive, in its order, with the inflated size its header declares. */
  names: Array<{ name: string; size: number }>;
  /** The entries `keep` asked for. */
  files: Map<string, Buffer>;
}

/** A name that stays inside the archive: no drive, no leading slash, no `..`, no backslash, no control character. */
function safeName(name: string): boolean {
  if (!name || name.length > 1024 || name.startsWith("/") || name.includes("\\") || /^[a-z]:/iu.test(name)) return false;
  for (let index = 0; index < name.length; index += 1) if (name.charCodeAt(index) < 32) return false;
  return !name.split("/").includes("..");
}

/**
 * Reads the archive once. `keep( name, size )` says which entries to inflate; the others are only listed.
 * Rejects with a TypeError (in Italian, for the user) when the file is not a ZIP, is encrypted, or goes over a limit.
 */
export function readDesignZip(archive: Uint8Array, keep: (name: string, size: number) => boolean, limits: Partial<DesignZipLimits> = {}): Promise<DesignZip> {
  const max = { ...DESIGN_ZIP_LIMITS, ...limits };
  if (archive.byteLength > max.archiveBytes) return Promise.reject(new TypeError(`Il file supera ${Math.round(max.archiveBytes / 1024 / 1024)} MB.`));
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new TypeError("Il file non è un archivio ZIP leggibile.")); return; }
      const names: DesignZip["names"] = [];
      const files = new Map<string, Buffer>();
      let total = 0;
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(new TypeError(message));
      };
      zip.on("error", () => fail("Il file non è un archivio ZIP leggibile."));
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ names, files });
      });
      zip.on("entry", (entry: ZipEntry) => {
        // A folder: nothing to read.
        if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
        if (!safeName(entry.fileName)) { fail("L'archivio ha un nome di file non ammesso."); return; }
        if (names.length >= max.entries) { fail(`L'archivio ha più di ${max.entries} file.`); return; }
        if ((entry.generalPurposeBitFlag & 1) !== 0) { fail("L'archivio è protetto da password."); return; }
        names.push({ name: entry.fileName, size: entry.uncompressedSize });
        if (files.has(entry.fileName) || !keep(entry.fileName, entry.uncompressedSize)) { zip.readEntry(); return; }
        if (entry.uncompressedSize > max.entryBytes || total + entry.uncompressedSize > max.totalBytes) { fail("L'archivio, una volta aperto, è troppo grande."); return; }
        total += entry.uncompressedSize;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail("Un file dell'archivio non si legge."); return; }
          const chunks: Buffer[] = [];
          let read = 0;
          stream.on("data", (chunk: Buffer) => {
            read += chunk.byteLength;
            // validateEntrySizes stops a stream longer than its header; this is the second guard.
            if (read > entry.uncompressedSize) { stream.destroy(); fail("Un file dell'archivio è più grande di quanto dichiara."); return; }
            chunks.push(chunk);
          });
          stream.on("error", () => fail("Un file dell'archivio non si legge."));
          stream.on("end", () => {
            if (settled) return;
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
