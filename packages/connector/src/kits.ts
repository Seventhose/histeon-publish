import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { ConnectorError, hasControlCharacters } from "./errors.js";
import { PROTOTYPE_KITS } from "./kits.generated.js";

/**
 * hp_prototype_init (doc 17 item 3): the kits to copy, with a new id. The same as prototypeKit() in
 * packages/cms/src/prototype-kits.ts: the client is bundled alone, without that package.
 */
export type PrototypeKitKind = keyof typeof PROTOTYPE_KITS;
export const PROTOTYPE_KIT_KINDS = Object.keys(PROTOTYPE_KITS) as PrototypeKitKind[];

function invalid(message: string): ConnectorError {
  return new ConnectorError("connector-invalid-arguments", message, 2);
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A kit with a new id, so that importing it never updates the project of another prototype; `name` renames it. */
export function prototypeKit(kind: PrototypeKitKind, options: { id?: string; name?: string } = {}): { html: string; id: string } {
  const id = options.id ?? randomUUID();
  const kit = PROTOTYPE_KITS[kind];
  const start = kit.indexOf('data-histos="manifest">');
  let manifest = kit.slice(start, kit.indexOf("</script>", start)).replace(/"id": "[0-9a-f-]{36}"/u, `"id": "${id}"`);
  let html = kit;
  if (options.name !== undefined) {
    const name = options.name.trim();
    if (!name || name.length > 120 || hasControlCharacters(name)) throw invalid("Il nome del prototipo va da 1 a 120 caratteri, senza caratteri di controllo.");
    manifest = manifest.replace(/"name": "(?:[^"\\]|\\.)*"/u, `"name": ${JSON.stringify(name).replaceAll("</", "<\\/")}`);
    html = html.replace(/<title>[^<]*<\/title>/u, `<title>${escapeHtml(name)}</title>`);
  }
  const at = html.indexOf('data-histos="manifest">');
  return { html: html.slice(0, at) + manifest + html.slice(html.indexOf("</script>", at)), id };
}

/**
 * Writes a kit where the agent asks, with the rules readPrototypeFile applies to what it reads: only `.html`/`.htm`,
 * no path component starting with ".", no network path on Windows; the folder must exist, and an existing file (or a
 * link in its place) is never overwritten.
 */
export function writePrototypeKit(input: string, html: string, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): string {
  if (typeof input !== "string" || !input.trim() || hasControlCharacters(input)) throw invalid("Il percorso del prototipo non è valido.");
  if (platform === "win32" && /^[\\/]{2}/u.test(input)) throw invalid("Percorsi di rete non ammessi: scrivi il prototipo sul computer.");
  const resolved = path.resolve(cwd, input);
  if (platform === "win32" && /^[\\/]{2}/u.test(resolved)) throw invalid("Percorsi di rete non ammessi: scrivi il prototipo sul computer.");
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") throw invalid("Il prototipo deve essere un file .html o .htm.");
  if (resolved.split(/[\\/]+/u).some((part) => part.startsWith("."))) throw invalid("Non scrivo file dentro cartelle o con nomi che iniziano con «.».");
  let folder: ReturnType<typeof statSync> | undefined;
  try {
    folder = statSync(path.dirname(resolved));
  } catch {
    folder = undefined;
  }
  if (!folder?.isDirectory()) throw invalid(`La cartella non esiste: ${path.dirname(resolved)}`);
  let descriptor: number;
  try {
    descriptor = openSync(resolved, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw invalid(code === "EEXIST" ? `Il file esiste già: ${resolved}. Scegli un altro nome: il kit non sovrascrive nulla.` : `Non riesco a creare il file (${code ?? "errore"}).`);
  }
  try {
    const bytes = Buffer.from(html, "utf8");
    for (let written = 0; written < bytes.byteLength;) written += writeSync(descriptor, bytes, written);
  } finally {
    closeSync(descriptor);
  }
  return resolved;
}
