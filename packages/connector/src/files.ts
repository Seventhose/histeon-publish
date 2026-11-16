import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { ConnectorError, hasControlCharacters } from "./errors.js";

/** Same limit as the importer (`PROTOTYPE_MAX_BYTES` in @histos-publish/cms). */
export const PROTOTYPE_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** Prototypes passed as text in a tool call: clients without a file system. */
export const PROTOTYPE_INLINE_MAX_BYTES = 4 * 1024 * 1024;
const MARKER_WINDOW = 64 * 1024;
const MARKER = /<html\b[^>]*?\sdata-histos-prototype\s*=\s*(?:"1"|'1'|1(?=[\s>/]))/iu;

export interface PrototypeSource {
  bytes: Buffer;
  /** File name only: what the server, the activity log and the user see. */
  name: string;
  /** Resolved absolute path, returned to the agent (never sent to the app). */
  path?: string;
  sha256: string;
}

function invalid(message: string): ConnectorError {
  return new ConnectorError("connector-file-invalid", message, 2);
}

/** Strict UTF-8 and the prototype marker on `<html>` near the top; checked before anything leaves this process. */
function checkText(bytes: Buffer): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("Il file non è testo UTF-8 valido.");
  }
  if (!MARKER.test(text.slice(0, MARKER_WINDOW))) {
    throw new ConnectorError("connector-file-not-prototype", 'Il file non è un prototipo Histeon: serve <html data-histos-prototype="1"> all\'inizio (vedi hp_manual). Non l\'ho inviato.', 2);
  }
}

function sameFileName(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Reads a prototype the agent points at, with the agent's own permissions but refusing what is clearly not one:
 * only `.html`/`.htm`, no path component starting with "." (keeps ~/.ssh, ~/.config and the connector folder out),
 * no links, FIFOs or devices, at most 32 MiB, strict UTF-8 and the marker. Nothing is sent to the app unless every
 * check passes, so an arbitrary file can never come back inside an error message.
 */
export function readPrototypeFile(input: string, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): PrototypeSource {
  if (typeof input !== "string" || !input.trim() || hasControlCharacters(input)) throw invalid("Il percorso del prototipo non è valido.");
  // Network paths (\\host\share, //host/share, \\?\UNC\…) would make Windows contact that host, with the user's
  // credentials, before any check: refused before any file system call.
  if (platform === "win32" && /^[\\/]{2}/u.test(input)) throw invalid("Percorsi di rete non ammessi: copia il prototipo sul computer.");
  const resolved = path.resolve(cwd, input);
  if (platform === "win32" && /^[\\/]{2}/u.test(resolved)) throw invalid("Percorsi di rete non ammessi: copia il prototipo sul computer.");
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") throw invalid("Il prototipo deve essere un file .html o .htm.");
  const hidden = (target: string): boolean => target.split(/[\\/]+/u).some((part) => part.startsWith("."));
  if (hidden(resolved)) throw invalid("Non leggo file dentro cartelle o con nomi che iniziano con «.».");
  let before: BigIntStats;
  try {
    before = lstatSync(resolved, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw invalid(code === "ENOENT" || code === "ENOTDIR" ? `Il file non esiste: ${resolved}` : `Non riesco a leggere il file (${code ?? "errore"}).`);
  }
  if (before.isSymbolicLink()) throw invalid("Il prototipo è un collegamento: indica il file vero.");
  if (!before.isFile()) throw invalid("Il prototipo non è un file normale.");
  if (before.size > BigInt(PROTOTYPE_FILE_MAX_BYTES)) throw invalid("Il prototipo supera i 32 MB.");
  let real: string;
  try {
    real = realpathSync.native(resolved);
  } catch {
    throw invalid("Non riesco a risolvere il percorso del prototipo.");
  }
  if (hidden(real)) throw invalid("Non leggo file dentro cartelle o con nomi che iniziano con «.».");
  // Without O_NOFOLLOW (Windows) the last component must resolve to itself inside its own real folder. Folders are
  // compared through their real path, so short 8.3 names like RUNNER~1 are not mistaken for links.
  if (constants.O_NOFOLLOW === undefined) {
    let expected: string;
    try {
      expected = path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      throw invalid("Non riesco a risolvere il percorso del prototipo.");
    }
    if (!sameFileName(real, expected, platform)) throw invalid("Il prototipo è un collegamento: indica il file vero.");
  }
  let descriptor: number;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw invalid("Non riesco ad aprire il prototipo.");
  }
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw invalid("Il file è cambiato mentre lo aprivo: riprova.");
    const buffer = Buffer.alloc(Math.min(Number(opened.size), PROTOTYPE_FILE_MAX_BYTES) + 1);
    let length = 0;
    for (;;) {
      if (length === buffer.byteLength) throw invalid("Il prototipo supera i 32 MB o sta cambiando: riprova quando è salvato.");
      const read = readSync(descriptor, buffer, length, buffer.byteLength - length, null);
      if (read === 0) break;
      length += read;
    }
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
  checkText(bytes);
  return { bytes, name: path.basename(resolved), path: resolved, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** A prototype passed as text: at most 4 MiB, with the same text checks as a file. */
export function inlinePrototype(html: string): PrototypeSource {
  if (typeof html !== "string" || !html) throw invalid("Manca il testo del prototipo.");
  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength > PROTOTYPE_INLINE_MAX_BYTES) throw invalid("Il prototipo come testo supera i 4 MB: salvalo in un file e indica path.");
  checkText(bytes);
  return { bytes, name: "prototipo.html", sha256: createHash("sha256").update(bytes).digest("hex") };
}
