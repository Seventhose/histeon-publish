import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { canonicalizeJson } from "@histos-publish/histos-contract";
import { measureSelectable } from "../src/import-measure.js";
import { memoryProjectCatalog } from "../src/memory-catalog.js";
import { checkProfileForArchive } from "../src/page-transfer.js";
import { wasmProjectDatabaseOpener, type WasmSqlite } from "../src/project-database-wasm.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";
import { groupConversionNotes, type ConversionNoteGroup } from "../src/conversion-report.js";
import type { ImportFramework } from "../src/css-cleanup.js";
import type { StructureOptions } from "../src/site-structure.js";
import type { ImportChoice, ImportChoiceRejection } from "../src/import-choices.js";
import { addedPageSlug, addPageToSite, AddPageError, readAddPageBase, type AddPageInput, type AddPageReport } from "./add-page.js";
import { ADD_PAGE_COLORS_MODES, colorsBack, pageColors, protectColorNames, type AddPageColorsMode } from "./page-colors.js";
import { brandSheetFilter, isWordpressPage } from "./page-sheets.js";
import { pageContent, type PageContent } from "./page-content.js";

export { AddPageError, ADD_PAGE_LIMITS, readAddPageBase, type AddPageAssetEntity, type AddPageBase, type AddPageErrorCode, type AddPageInput, type AddPageReport, type AddPageStylesEntity } from "./add-page.js";
export { ADD_PAGE_COLORS_MODES, type AddPageColorsMode, type AddPageColorsReport } from "./page-colors.js";
export type { PageContentFrom } from "./page-content.js";

/**
 * Doc 18 F6: «Importa HTML» in the WordPress administrator's browser. The same converter and the same prototype import
 * as Histeon Publish (its project store on SQLite for WebAssembly, in memory) turn a page, a ZIP's files or a folder into
 * a `.xbsite`, which the plugin then imports through its own checks (PageProfileAdapter), as any `.xbsite`. Media of
 * other sites are not downloaded here: a browser cannot tell an address of the administrator's own network from a
 * public one (doc 18 §8), so they stay out, with a note.
 */
export interface BrowserImportInput {
  files: StaticSiteFile[];
  name: string;
  /** The site's Histeon project, when it has one: the import updates it. Else a new one. */
  projectId?: string;
  framework?: ImportFramework;
  recipes?: boolean;
  structure?: StructureOptions;
  /**
   * Doc 27 G4: answers to the choices of a previous conversion, by id (the names a person applied from the plugin's
   * table). Each one is used only where it fits its rules and collides with nothing.
   */
  choices?: Readonly<Record<string, string>>;
  /**
   * V5.4: the page is added to the site that `addPage.base` describes (see `AddPageBase` in add-page.ts), without
   * touching what the site has. Without it, the conversion is the one of a whole project, as always.
   */
  addPage?: AddPageInput;
}

export interface BrowserImportResult {
  projectId: string;
  /** The prototype, for the administrator to download and keep. */
  prototype: string;
  notes: string[];
  /** Doc 23 item 163: notes and warnings grouped (removed, moved to the page's JavaScript, breakpoints, to check). */
  groups: ConversionNoteGroup[];
  warnings: string[];
  selectable: { original: number; selectable: number; share: number } | null;
  structure: ReturnType<typeof staticSiteToPrototype>["structure"];
  recipesAvailable: boolean;
  /** Doc 27 G4: the choices of judgement the converter met (what a model may rename); none for a prototype file. */
  choices: ImportChoice[];
  /** The answers in `choices` that were not used, and why. */
  choicesRejected: ImportChoiceRejection[];
  /** The `.xbsite` the plugin imports. */
  archive: Uint8Array;
  /** V5.4: what the addition of the page did; only with `addPage`. */
  addPage?: AddPageReport;
}

const ZIP_TIME = new Date("1980-01-01T00:00:00Z");

/** The largest image a prototype may name by address, as the server's import takes it. */
const REMOTE_MEDIA_MAX = 15 * 1024 * 1024;

/**
 * A Histeon prototype in one file (`<html data-histos-prototype="1">`): its templates, components, contents and loops
 * are imported as they are, never converted as a plain page (lista della spesa 167). Null for anything else.
 */
export function prototypeFile(files: readonly StaticSiteFile[]): string | null {
  const pages = files.filter((file) => /\.html?$/iu.test(file.path));
  if (pages.length !== 1) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(pages[0]!.bytes);
  return /<html\b[^>]*\sdata-histos-prototype\s*=\s*["']?1\b/iu.test(text.slice(0, 4096)) ? text : null;
}

/**
 * Images a prototype names by address, read by this browser: only https, without cookies or referrer, as the server
 * would; a host that does not allow it (CORS) stops the import with a message. The plugin checks every image again.
 */
async function fetchRemote(url: string, maxBytes: number): Promise<Uint8Array> {
  if (!/^https:\/\//iu.test(url)) throw new TypeError(`${url}: solo indirizzi https`);
  let response: Response;
  try {
    response = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" });
  } catch {
    throw new TypeError(`${url}: il sito che la ospita non la lascia leggere da qui. Caricala in WordPress e scrivi il suo indirizzo, oppure importa il prototipo con Histeon Publish`);
  }
  if (!response.ok) throw new TypeError(`${url}: risposta ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > Math.min(maxBytes, REMOTE_MEDIA_MAX)) throw new TypeError(`${url}: oltre ${Math.round(REMOTE_MEDIA_MAX / 1048576)} MB`);
  return bytes;
}

/**
 * V5.4: an added page brings no parts, components or lists. Their keys (refs, type keys, query keys, template slugs) are
 * the site's too, and the plugin would find them taken or would overwrite the site's: the page stays one page.
 */
const ADDED_PAGE_STRUCTURE: StructureOptions = { parts: false, components: false, lists: false };

function convertSite(input: BrowserImportInput, projectId: string, choices: Readonly<Record<string, string>> | undefined) {
  const structure = input.addPage !== undefined ? ADDED_PAGE_STRUCTURE : input.structure;
  // D5: an added page's brand colours come from its own sheets, not from those of the theme, WordPress or the plugins.
  const brandSheet = input.addPage !== undefined ? addedPageBrandSheet(input.files) : null;
  return staticSiteToPrototype({ projectId, name: input.name, files: input.files, framework: input.framework ?? "histos-css", recipes: input.recipes === true, ...(structure ? { structure } : {}), ...(choices && Object.keys(choices).length ? { choices } : {}), ...(brandSheet ? { brandSheet } : {}) });
}

/** D5: brandSheetFilter of the one page of an added page; null when it is not a WordPress page (every sheet counts). */
function addedPageBrandSheet(files: readonly StaticSiteFile[]): ReturnType<typeof brandSheetFilter> {
  const page = files.find((file) => file.path === "index.html") ?? files.find((file) => /\.html?$/iu.test(file.path) && !/(^|\/)404\.html?$/iu.test(file.path));
  return page ? brandSheetFilter(new TextDecoder("utf-8", { fatal: false }).decode(page.bytes)) : null;
}

/**
 * D6: the files of an added page with its one page reduced to its content (page-content.ts), when it is a WordPress page
 * (page-sheets.ts): the header and footer to take away are its theme's. A page that is not of WordPress, or whose
 * content is not found, stays as it was given, with `content.from` null.
 */
function addedPageContent(files: readonly StaticSiteFile[], page?: StaticSiteFile): { files: StaticSiteFile[]; content: PageContent; wordpress: boolean } {
  const html = files.find((file) => file === page) ?? files.find((file) => /\.html?$/iu.test(file.path) && !/(^|\/)404\.html?$/iu.test(file.path));
  const text = html ? new TextDecoder("utf-8", { fatal: false }).decode(html.bytes) : "";
  const wordpress = isWordpressPage(text);
  const content = wordpress ? pageContent(text) : { html: text, from: null, elements: 0, scripts: 0, sheets: 0 };
  if (!html || content.from === null) return { files: [...files], content, wordpress };
  const bytes = new TextEncoder().encode(content.html);
  return { files: files.map((file) => (file === html ? { path: file.path, bytes } : file)), content, wordpress };
}

const PAGE_CONTENT_FROM: Record<NonNullable<PageContent["from"]>, string> = {
  main: "<main> (ora un <div>: il sito ha il suo <main>)",
  "parti-del-tema": "ciò che sta fra la testata e il piè di pagina del tema a blocchi",
  "#main": "#main",
  "#content": "#content",
  ".site-main": ".site-main",
};

function pageContentNote(content: PageContent): string {
  return `Solo il contenuto della pagina, preso da ${PAGE_CONTENT_FROM[content.from!]}: tolti testata, menu, piè di pagina e barra di amministrazione del tema (${content.elements} ${content.elements === 1 ? "elemento" : "elementi"}, ${content.scripts} script, ${content.sheets} ${content.sheets === 1 ? "foglio" : "fogli"})`;
}

/** D6: the warning of a page whose content was not recognised: it is imported whole, as before. */
const PAGE_CONTENT_NOT_FOUND = "Contenuto della pagina di WordPress non riconosciuto (nessun <main>, #main, #content, .site-main né parti di un tema a blocchi): la pagina è importata intera, con la testata e il piè di pagina del tema se li ha. Toglili nell'editor.";

/** What an added page leaves out of what was asked (`structure`), with the reason the plugin shows. */
function addedPageLeftOut(structure: StructureOptions | undefined): AddPageReport["leftOut"] {
  const out: AddPageReport["leftOut"] = [];
  if (structure?.parts) out.push({ kind: "parti", reason: "testata e piè di pagina restano dentro la pagina: le parti e i template del sito non si toccano" });
  if (structure?.components) out.push({ kind: "componenti", reason: "i blocchi ripetuti restano nella pagina: un componente nuovo potrebbe avere la chiave di uno del sito" });
  if (structure?.lists) out.push({ kind: "elenchi", reason: "gli elenchi restano nella pagina: tipi, record e query del sito non si toccano" });
  return out;
}

const LEFT_OUT_NOTE: Record<AddPageReport["leftOut"][number]["kind"], string> = { parti: "Parti non create", componenti: "Componenti non creati", elenchi: "Elenchi non creati" };

/**
 * V5.4: `addPage` read before anything is converted: the base checked as untrusted data, the project the site's, one
 * page only, no Histeon prototype (it brings templates and components of its own). Null without `addPage`.
 */
function addPageStart(input: BrowserImportInput): { base: ReturnType<typeof readAddPageBase>; page: StaticSiteFile; colors: AddPageColorsMode | undefined } | null {
  if (input.addPage === undefined) return null;
  const raw = input.addPage as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AddPageError("base-non-valida", "La base del sito non è valida: addPage non è un oggetto. La pagina non è stata importata.", "addPage");
  const sourcePath = (raw as { sourcePath?: unknown }).sourcePath;
  if (sourcePath !== undefined && (typeof sourcePath !== "string" || sourcePath.length > 2048)) throw new AddPageError("base-non-valida", "La base del sito non è valida: addPage.sourcePath non è un percorso. La pagina non è stata importata.", "addPage.sourcePath");
  const colors = (raw as { colors?: unknown }).colors;
  if (colors !== undefined && !ADD_PAGE_COLORS_MODES.includes(colors as AddPageColorsMode)) throw new AddPageError("base-non-valida", "La base del sito non è valida: addPage.colors deve essere «pagina», «sito» o «sostituisci». La pagina non è stata importata.", "addPage.colors");
  const base = readAddPageBase((raw as { base?: unknown }).base);
  if (input.projectId !== undefined && input.projectId !== base.projectId) {
    throw new AddPageError("base-progetto", "La base è di un altro progetto Histeon: projectId e base.projectId devono essere quelli del sito. La pagina non è stata importata.", base.projectId);
  }
  if (prototypeFile(input.files) !== null) {
    throw new AddPageError("prototipo", "Un prototipo Histeon porta i suoi template e componenti: non si aggiunge come pagina a un sito che esiste. Importalo come progetto con Histeon Publish.", "prototipo");
  }
  const pages = input.files.filter((file) => /\.html?$/iu.test(file.path) && !/(^|\/)404\.html?$/iu.test(file.path));
  if (pages.length !== 1) {
    throw new AddPageError("piu-pagine", `Per aggiungere una pagina a un sito serve una sola pagina HTML (index.html); qui ce ne sono ${pages.length}. La pagina non è stata importata.`, String(pages.length));
  }
  // V5.7: the site's colour variables are those of Histeon CSS; with another framework (or none) there are none here.
  const framework = input.framework ?? "histos-css";
  if (colors === "sostituisci" && framework !== "histos-css") {
    throw new AddPageError("colori-senza-variabili", `«Sostituisci i colori del sito» vale solo per un sito con Histeon CSS: con il framework «${framework}» i colori del sito non sono variabili di Histeon CSS che la pagina possa cambiare. Scegli di tenere i colori della pagina o di prendere quelli del sito; la pagina non è stata importata.`, framework);
  }
  return { base, page: pages[0]!, colors: colors as AddPageColorsMode | undefined };
}

/**
 * Doc 27 G4: which of a model's answers a conversion with them would refuse (a name already taken, a swap), so the
 * plugin's table «prima → dopo» shows only names that would apply. Nothing is written, no archive is made.
 */
export function trialChoices(input: BrowserImportInput, answers: Readonly<Record<string, string>>): ImportChoiceRejection[] {
  if (!Object.keys(answers).length || prototypeFile(input.files) !== null) return [];
  const projectId = input.projectId ?? "00000000-0000-4000-8000-000000000000";
  const merged = { ...(input.choices ?? {}), ...answers };
  const adding = input.addPage !== undefined ? addedPageContent(input.files) : null;
  return convertSite(adding ? { ...input, files: adding.files } : input, projectId, merged).choicesRejected.filter((item) => Object.hasOwn(answers, item.id));
}

export async function convertToXbsite(input: BrowserImportInput, sqlite: WasmSqlite): Promise<BrowserImportResult> {
  const adding = addPageStart(input);
  if (adding) return addPage(input, sqlite, adding);
  const prototype = prototypeFile(input.files);
  if (prototype !== null) return importPrototype(prototype, sqlite, input.projectId);
  const projectId = input.projectId ?? globalThis.crypto.randomUUID();
  const converted = convertSite(input, projectId, input.choices);
  const notes = [...converted.report.notes];
  if (converted.remoteMedia.length) notes.unshift(`${converted.remoteMedia.length} file di altri siti non scaricati nel browser: caricali in WordPress, oppure converti il sito con Histeon Publish, che li scarica con i suoi controlli`);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let selectable: BrowserImportResult["selectable"] = null;
  try {
    selectable = measureSelectable(input.files.filter((file) => /\.html?$/iu.test(file.path) && !/(^|\/)404\.html?$/iu.test(file.path)).slice(0, 1000).map((file) => decoder.decode(file.bytes)), converted.html);
  } catch {
    selectable = null;
  }
  const opener = wasmProjectDatabaseOpener(sqlite);
  try {
    const built = await buildPrototypeProfile(parsePrototype(converted.html), memoryProjectCatalog(opener.open));
    checkProfileForArchive(built.profile, built.files);
    const entries: Zippable = { "site.json": [strToU8(canonicalizeJson(built.profile.manifest as never)), { mtime: ZIP_TIME }] };
    for (const [name, bytes] of [...built.files].sort(([left], [right]) => left.localeCompare(right))) entries[name] = [new Uint8Array(bytes), { mtime: ZIP_TIME }];
    return { projectId, prototype: converted.html, notes, groups: groupConversionNotes([...notes, ...built.report.warnings]), warnings: built.report.warnings, selectable, structure: converted.structure, recipesAvailable: converted.recipesAvailable, choices: converted.choices, choicesRejected: converted.choicesRejected, archive: zipSync(entries) };
  } finally {
    opener.dispose();
  }
}

/**
 * V5.4: the page converted as any page (one page, no structure), then added to the site's base by addPageToSite: the
 * package holds the page, its media, the merged styles and the site's media those styles use.
 */
async function addPage(input: BrowserImportInput, sqlite: WasmSqlite, adding: NonNullable<ReturnType<typeof addPageStart>>): Promise<BrowserImportResult> {
  const { base, page } = adding;
  const projectId = base.projectId;
  // D6: only the page's content, without the theme's header, footer and admin bar.
  const trimmed = addedPageContent(input.files, page);
  // V5.7, «pagina»: the colour names the page already uses are set apart, so only the ones the conversion writes go back.
  const guarded = adding.colors === "pagina" ? protectColorNames(trimmed.files) : null;
  const restore = guarded?.restore ?? ((text: string) => text);
  const converted = convertSite({ ...input, files: guarded ? guarded.files : trimmed.files }, projectId, input.choices);
  const colorsPage = adding.colors ? pageColors(converted.design, input.framework ?? "histos-css") : [];
  if (adding.colors === "sostituisci" && !colorsPage.length) {
    throw new AddPageError("colori-pagina-assenti", "La pagina non ha colori che la conversione abbia scritto come variabili del sito (il colore principale e il secondario): non c'è niente da sostituire nei colori del sito. Scegli di tenere i colori della pagina o di prendere quelli del sito; la pagina non è stata importata.", "");
  }
  const notes = [...converted.report.notes].map(restore);
  if (converted.remoteMedia.length) notes.unshift(`${converted.remoteMedia.length} file di altri siti non scaricati nel browser: caricali in WordPress, oppure converti il sito con Histeon Publish, che li scarica con i suoi controlli`);
  const contentNote = trimmed.content.from !== null ? pageContentNote(trimmed.content) : null;
  if (contentNote) notes.unshift(contentNote);
  const html = trimmed.content.html;
  let selectable: BrowserImportResult["selectable"] = null;
  try {
    selectable = measureSelectable([html], converted.html);
  } catch {
    selectable = null;
  }
  const opener = wasmProjectDatabaseOpener(sqlite);
  try {
    const built = await buildPrototypeProfile(parsePrototype(converted.html), memoryProjectCatalog(opener.open));
    let kept = 0;
    // The variables the conversion wrote, back to the page's colours; then the page's own names, as they were.
    const ready = !guarded ? built : {
      ...built,
      profile: {
        ...built.profile,
        entities: built.profile.entities.map((entity) => {
          let payload = entity.payload;
          if (entity.kind === "styles") {
            const back = colorsBack(payload, colorsPage);
            payload = back.payload;
            kept = back.kept;
          }
          return { ...entity, payload: JSON.parse(restore(JSON.stringify(payload))) as typeof payload };
        }),
      },
    };
    const document = ready.profile.entities.find((entity) => entity.kind === "document");
    const sourcePath = input.addPage?.sourcePath;
    const slug = addedPageSlug({ html, filePath: page.path, ...(typeof sourcePath === "string" ? { sourcePath } : {}), title: typeof document?.payload.title === "string" ? document.payload.title : "" });
    if (!slug) throw new AddPageError("slug-mancante", "La pagina non ha un indirizzo canonico, un percorso o un titolo da cui ricavare lo slug: aggiungine uno e riprova.", "");
    const leftOut = addedPageLeftOut(input.structure);
    const added = addPageToSite(ready, base, { slug: slug.slug, slugFrom: slug.from }, leftOut, adding.colors ? { mode: adding.colors, page: colorsPage, kept } : undefined);
    const warnings = built.report.warnings.map(restore);
    if (trimmed.wordpress && trimmed.content.from === null) warnings.unshift(PAGE_CONTENT_NOT_FOUND);
    const allNotes = [...added.notes, ...leftOut.map((item) => `${LEFT_OUT_NOTE[item.kind]}: ${item.reason}`), ...notes];
    const entries: Zippable = { "site.json": [strToU8(canonicalizeJson(added.profile.manifest as never)), { mtime: ZIP_TIME }] };
    for (const [name, bytes] of [...added.files].sort(([left], [right]) => left.localeCompare(right))) entries[name] = [new Uint8Array(bytes), { mtime: ZIP_TIME }];
    return { projectId, prototype: restore(converted.html), notes: allNotes, groups: groupConversionNotes([...allNotes, ...warnings]), warnings, selectable, structure: converted.structure, recipesAvailable: converted.recipesAvailable, choices: converted.choices, choicesRejected: converted.choicesRejected, archive: zipSync(entries), addPage: { ...added.report, content: { wordpress: trimmed.wordpress, from: trimmed.content.from, elements: trimmed.content.elements, scripts: trimmed.content.scripts, sheets: trimmed.content.sheets } } };
  } finally {
    opener.dispose();
  }
}

/** A prototype file straight into a `.xbsite`: nothing is converted, the prototype import reads it as Publish does. */
async function importPrototype(html: string, sqlite: WasmSqlite, projectId?: string): Promise<BrowserImportResult> {
  const read = parsePrototype(html);
  // Into the site's own project when it has one, as a converted page goes: the manifest's id is the prototype's.
  const parsed = projectId ? { ...read, manifest: { ...read.manifest, id: projectId } } : read;
  const opener = wasmProjectDatabaseOpener(sqlite);
  try {
    const built = await buildPrototypeProfile(parsed, memoryProjectCatalog(opener.open), { fetchAsset: fetchRemote });
    checkProfileForArchive(built.profile, built.files);
    const entries: Zippable = { "site.json": [strToU8(canonicalizeJson(built.profile.manifest as never)), { mtime: ZIP_TIME }] };
    for (const [name, bytes] of [...built.files].sort(([left], [right]) => left.localeCompare(right))) entries[name] = [new Uint8Array(bytes), { mtime: ZIP_TIME }];
    const notes = ["Prototipo Histeon: importato così com'è, con template, componenti, contenuti e loop. Nessuna conversione."];
    return { projectId: parsed.manifest.id, prototype: html, notes, groups: groupConversionNotes([...notes, ...built.report.warnings]), warnings: built.report.warnings, selectable: null, structure: { parts: [], components: [], lists: [] }, recipesAvailable: false, choices: [], choicesRejected: [], archive: zipSync(entries) };
  } finally {
    opener.dispose();
  }
}

/** What a site the browser reads may hold: past these, the files are refused, as Histeon Publish refuses them. */
const SITE_MAX_FILES = 5_000;
const SITE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * A relative path of a site's file, or null: no absolute path, drive letter, backslash, empty, `.` or `..` part, and
 * no hidden folder (the build's metadata); at most 400 characters.
 */
export function siteFilePath(raw: string): string | null {
  if (!raw || raw.length > 400 || raw.includes("\\") || raw.includes("\u0000") || raw.startsWith("/") || /^[A-Za-z]:/u.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) return null;
  return parts.join("/");
}

/**
 * The files of a site's ZIP, read in the browser: each path checked by siteFilePath, folders and refused paths left
 * out, at most SITE_MAX_FILES files and SITE_MAX_BYTES in all (counted on what the archive declares, and again on what
 * it gives). A single top folder (a site zipped with its folder) is taken away.
 */
export function readSiteZip(bytes: Uint8Array): { files: StaticSiteFile[]; refused: number } {
  let declared = 0;
  let count = 0;
  let refused = 0;
  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (file.name.endsWith("/")) return false;
      if (siteFilePath(file.name) === null) {
        refused++;
        return false;
      }
      count++;
      declared += file.originalSize;
      if (count > SITE_MAX_FILES || declared > SITE_MAX_BYTES) throw new RangeError("Lo ZIP supera i limiti di un sito: 5000 file o 200 MB.");
      return true;
    },
  });
  let total = 0;
  let files = Object.entries(entries).map(([path, data]) => {
    total += data.length;
    return { path, bytes: data };
  });
  if (total > SITE_MAX_BYTES) throw new RangeError("Lo ZIP supera i limiti di un sito: 5000 file o 200 MB.");
  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  if (tops.size === 1 && files.every((file) => file.path.includes("/"))) files = files.map((file) => ({ ...file, path: file.path.slice(file.path.indexOf("/") + 1) }));
  return { files, refused };
}
