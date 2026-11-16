/**
 * One file the user chose as a source of design tokens (note penpot-figma-a-histeon.md, phase 2): a JSON of tokens
 * exported by Figma or Penpot, a whole `.penpot` file, or a `.fig` file saved from Figma. What it is, is told by its
 * bytes, never by its name.
 *
 * Node only (design-zip.ts). No network, no credentials; nothing is written to disk.
 */

import { createHash } from "node:crypto";
import { type DesignPrototypeReport, designPrototype, designPrototypeText } from "./design-prototype.js";
import { importDesignTokens, readDesignTokens, TOKEN_FILE_MAX, type TokenFile, type TokenProblem } from "./design-tokens.js";
import { readDesignZip } from "./design-zip.js";
import { figFileEntry, figFileName, type FigLibrary, figTokenFiles, readFigLibrary } from "./fig-file.js";
import { isFigKiwi } from "./fig-kiwi.js";
import { attachFigImages, figFrame, figImageEntry, figPageList } from "./fig-page.js";
import type { DesignPage, DesignPageList } from "./design-tree.js";
import type { HistosDesign } from "./histos-design.js";
import { penpotLibraryEntry, penpotTokenFiles, readPenpotLibrary } from "./penpot-file.js";
import { attachPenpotImages, penpotFrame, penpotObjectEntry, penpotPageEntry, penpotPageList, pickByName } from "./penpot-page.js";

export interface DesignFileTokens {
  kind: "tokens" | "penpot" | "figma";
  /** The files of tokens for `readDesignTokens`, in the order they apply. */
  files: TokenFile[];
  /** What the file holds that cannot become a token. */
  problems: TokenProblem[];
  /** One line in Italian on what was read, for the report; empty for a plain file of tokens. */
  summary: string;
}

/** The largest design file read: the archive, before it is opened. */
export const DESIGN_FILE_MAX = 512 * 1024 * 1024;

const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

/** True for the first bytes of a ZIP archive (`PK\x03\x04`, or the empty archive `PK\x05\x06`). */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

/** The styles and the variables of a Figma document, as files of tokens with their one line of report. */
function figmaTokens(name: string, canvas: Uint8Array, fileName: string): DesignFileTokens {
  let library: FigLibrary;
  try {
    library = readFigLibrary(canvas, fileName || name.replace(/\.fig$/iu, ""));
  } catch (error) {
    throw new TypeError(`${name}: ${error instanceof Error ? error.message : "file di Figma non leggibile"}`);
  }
  const { files, problems } = figTokenFiles(library);
  const summary = `${library.name}: file .fig di Figma (formato ${library.version}), ${many(library.fills.length, "stile di colore", "stili di colore")}, ${many(library.texts.length, "stile di testo", "stili di testo")}, ${many(library.effects.length, "stile di effetto", "stili di effetto")}, ${many(library.variables.length, "variabile", "variabili")} in ${many(library.collections.length, "raccolta", "raccolte")}, ${many(library.components, "componente", "componenti")}, ${many(library.pages.length, "pagina", "pagine")}. Pagine e componenti non si convertono qui.`;
  if (!files.length) throw new TypeError(`${name}: il file di Figma non ha stili né variabili.`);
  return { kind: "figma", files, problems: [...library.problems, ...problems], summary };
}

/**
 * The tokens of one chosen file. `name` is only shown in messages. Throws a TypeError, in Italian, for a file that is
 * too large, is not UTF-8 text, or is an archive this reader does not know.
 */
export async function designFileTokens(name: string, bytes: Uint8Array): Promise<DesignFileTokens> {
  if (bytes.byteLength > DESIGN_FILE_MAX) throw new TypeError(`${name}: il file supera ${DESIGN_FILE_MAX / 1024 / 1024} MB.`);
  // An old `.fig` is the document itself, without the archive around it.
  if (isFigKiwi(bytes)) return figmaTokens(name, bytes, "");
  if (isZip(bytes)) {
    const zip = await readDesignZip(bytes, (entry, size) => figFileEntry(entry) || penpotLibraryEntry(entry, size), { archiveBytes: DESIGN_FILE_MAX }).catch((error: unknown) => {
      throw new TypeError(`${name}: ${error instanceof Error ? error.message : "archivio non leggibile"}`);
    });
    const canvas = zip.files.get("canvas.fig");
    if (canvas) return figmaTokens(name, canvas, figFileName(zip.files.get("meta.json")));
    let library: ReturnType<typeof readPenpotLibrary>;
    try {
      library = readPenpotLibrary(zip);
    } catch (error) {
      throw new TypeError(`${name}: ${error instanceof Error ? error.message : "archivio non riconosciuto"}`);
    }
    const { files, problems } = penpotTokenFiles(library);
    const summary = `${library.name}: file Penpot${library.fromFigma ? " portato da Figma" : ""}${library.generatedBy ? ` (${library.generatedBy})` : ""}, ${many(library.colors.length, "colore", "colori")} e ${many(library.typographies.length, "tipografia", "tipografie")} della libreria, ${many(library.tokens.length, "file di token", "file di token")}, ${many(library.components.length, "componente", "componenti")}, ${many(library.pages.length, "pagina", "pagine")}. Pagine e componenti non si convertono qui.`;
    if (!files.length) throw new TypeError(`${name}: il file Penpot non ha colori, tipografie né token nella libreria.`);
    return { kind: "penpot", files, problems: [...library.problems, ...problems], summary };
  }
  if (bytes.byteLength > TOKEN_FILE_MAX) throw new TypeError(`${name}: il file supera 8 MB.`);
  try {
    return { kind: "tokens", files: [{ name, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }], problems: [], summary: "" };
  } catch {
    throw new TypeError(`${name}: il file non è testo UTF-8.`);
  }
}

/** The archive of a design file opened for its pages: the bytes are checked as `designFileTokens` checks them. */
async function pageArchive(name: string, bytes: Uint8Array, keep: (entry: string, size: number) => boolean) {
  if (bytes.byteLength > DESIGN_FILE_MAX) throw new TypeError(`${name}: il file supera ${DESIGN_FILE_MAX / 1024 / 1024} MB.`);
  if (!isZip(bytes)) throw new TypeError(`${name}: serve un file .penpot o .fig (un archivio), non un file di token.`);
  return readDesignZip(bytes, keep, { archiveBytes: DESIGN_FILE_MAX }).catch((error: unknown) => {
    throw new TypeError(`${name}: ${error instanceof Error ? error.message : "archivio non leggibile"}`);
  });
}

/** The same error with the name of the file in front, as every error of a chosen file has. */
function named<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new TypeError(`${name}: ${error instanceof Error ? error.message : "file di design non leggibile"}`);
  }
}

/** A design file opened for its pages: the document of a `.fig` (in its archive, or bare as old files are), or the entries of a `.penpot`. */
async function pageSource(name: string, bytes: Uint8Array): Promise<{ canvas: Uint8Array; file: string; zipped: boolean } | { zip: Awaited<ReturnType<typeof readDesignZip>> }> {
  const bare = name.replace(/\.fig$/iu, "");
  if (isFigKiwi(bytes)) {
    if (bytes.byteLength > DESIGN_FILE_MAX) throw new TypeError(`${name}: il file supera ${DESIGN_FILE_MAX / 1024 / 1024} MB.`);
    return { canvas: bytes, file: bare, zipped: false };
  }
  const zip = await pageArchive(name, bytes, (entry, size) => figFileEntry(entry) || penpotPageEntry(entry, size));
  const canvas = zip.files.get("canvas.fig");
  return canvas ? { canvas, file: figFileName(zip.files.get("meta.json")) || bare, zipped: true } : { zip };
}

/**
 * The pages of a design file and the frames at the top of each (note penpot-figma-a-histeon.md, phase 3). Throws a
 * TypeError, in Italian, for a file that is neither a `.penpot` nor a `.fig`.
 */
export async function designFilePages(name: string, bytes: Uint8Array): Promise<DesignPageList> {
  const source = await pageSource(name, bytes);
  return named(name, () => ("canvas" in source ? figPageList(source.canvas, source.file) : penpotPageList(source.zip)));
}

/**
 * One frame of one page of a design file as a neutral tree, with the bytes of its pictures. `pageRef` and
 * `frameRef` are a name, a part of a name or an id. The archive is read twice: the pages first, then only the
 * pictures the frame uses.
 */
export async function designFilePage(name: string, bytes: Uint8Array, pageRef: string, frameRef: string): Promise<DesignPage> {
  const source = await pageSource(name, bytes);
  if ("canvas" in source) {
    const page = named(name, () => figFrame(source.canvas, source.file, pageRef, frameRef));
    if (page.images.size) attachFigImages(page, source.zipped ? (await pageArchive(name, bytes, figImageEntry(page))).files : new Map());
    return page;
  }
  const page = named(name, () => penpotFrame(source.zip, pageRef, frameRef));
  if (page.images.size) attachPenpotImages(page, await pageArchive(name, bytes, penpotObjectEntry(page)));
  return page;
}

/** The largest prototype a design frame may become: what the import of a prototype reads. */
export const DESIGN_PROTOTYPE_MAX = 32 * 1024 * 1024;

/**
 * The id of the prototype made from one frame: the same file name, page and frame give the same id, so converting
 * the frame again updates the project the first import made. `twin` is the id of the frame in the design, given only
 * when other frames of the page have the same name: without it two frames would update the same project.
 */
export function designPrototypeId(file: string, page: string, frame: string, twin = ""): string {
  const hash = createHash("sha256").update(JSON.stringify(["histos-design", file, page, frame, ...(twin ? [twin] : [])])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${"89ab"[Number.parseInt(hash[16]!, 16) % 4]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface DesignFilePrototypeOptions {
  /** The id of the prototype; `designPrototypeId` of file, page and frame when it is not given. */
  id?: string;
  /** The name of the project. */
  name?: string;
  /** False does not read colours, fonts and scale from the styles of the file. */
  styles?: boolean;
  /** False leaves every copy of a component as plain elements of its block. */
  components?: boolean;
  /** False keeps a run of cards as uses of their component, without records and loops. */
  records?: boolean;
  /** True gives cards side by side the look of the first one (it changes how they look). */
  uniform?: boolean;
}

export interface DesignFilePrototype {
  id: string;
  html: string;
  details: DesignPrototypeReport;
  /** The report in Italian: what was written, deduced and left out, and one line on the styles of the file. */
  report: string;
}

/**
 * One frame of a design file as a Histeon prototype (note penpot-figma-a-histeon.md, phases 3 to 6): what the
 * command `design` and the app's «Nuovo sito» both do. The styles of the same file, when it has any, are the
 * parameters of the design. An empty `frameRef` is the only frame of the page. Throws a TypeError, in Italian, for a
 * file, a page or a frame that cannot be read, and for a prototype over 32 MB.
 */
export async function designFilePrototype(name: string, bytes: Uint8Array, pageRef: string, frameRef: string, options: DesignFilePrototypeOptions = {}): Promise<DesignFilePrototype> {
  let frame = frameRef;
  if (!frame.trim()) {
    const pages = (await designFilePages(name, bytes)).pages;
    const listed = named(name, () => pickByName(pages, pageRef, "una pagina"));
    if (listed.frames.length !== 1) throw new TypeError(listed.frames.length ? `La pagina «${listed.name}» ha più di un riquadro: indica quale.` : `La pagina «${listed.name}» non ha riquadri.`);
    frame = listed.frames[0]!.id;
  }
  const page = await designFilePage(name, bytes, pageRef, frame);
  let design: HistosDesign | undefined;
  let styles = "";
  if (options.styles !== false) {
    try {
      design = importDesignTokens(readDesignTokens((await designFileTokens(name, bytes)).files)).design;
      styles = "Parametri del design presi dagli stili dello stesso file (per vederli uno per uno: histos-publish tokens).";
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      styles = `Stili del file non usati: ${error.message}`;
    }
  }
  const id = options.id ?? designPrototypeId(name, page.page, page.frame, page.twins ? page.root.id : "");
  const made = designPrototype(page, { id, ...(options.name === undefined ? {} : { name: options.name }), ...(design ? { design } : {}), components: options.components !== false, records: options.records !== false, uniform: options.uniform === true });
  if (Buffer.byteLength(made.html) > DESIGN_PROTOTYPE_MAX) throw new TypeError("Il prototipo supererebbe i 32 MB: scegli un riquadro con meno immagini.");
  return { id, html: made.html, details: made.report, report: [designPrototypeText(made.report), ...(styles ? [styles] : [])].join("\n") };
}
