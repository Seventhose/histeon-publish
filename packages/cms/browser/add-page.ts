import { createHash } from "node:crypto";
import { canonicalRevisionPayload, canonicalizeJson, manifestHashInput, SCRIPT_CAPABILITY, transferUsesScripts, type JsonValue, type StaticPageProfile, type TransferEntity, type TransferManifest, type TransferReference } from "@histos-publish/histos-contract";
import { checkProfileForArchive } from "../src/page-transfer.js";
import { stableId } from "../src/prototype-import.js";
import { isSizedSheet, markPageContent, PAGE_MARK, pageScope, renameInStyleBody, scopeSelectorList, scopeSheet, styleRules, type PageScopeRename } from "./page-scope.js";
import { designKeptBesides, replaceSiteColors, type AddPageColorsErrorCode, type AddPageColorsMode, type AddPageColorsReport } from "./page-colors.js";
import type { PageContentFrom } from "./page-content.js";

/**
 * V5.4, «pagina aggiunta»: a converted page added to a site that already has a Histeon project, without touching what the
 * site has. The site gives what it has today (`AddPageBase`, read from its own export); the conversion keeps only the
 * page, the media it uses and the site's styles entity merged with the page's, built on the live revision. The plugin's
 * checks stay as they are: a slug already used, a base that is not the live one, an entity it would overwrite stop it.
 *
 * Everything in `base` comes from the site through the browser: it is read here as untrusted data (shape, types, sizes,
 * hashes), and a base that is not valid is an error, never a plain import instead.
 */

/** The site's styles entity, as `PageProfileAdapter::snapshot(false)` writes it (the entity of kind `styles`). */
export interface AddPageStylesEntity {
  id: string;
  kind: "styles";
  schemaVersion: 1;
  /** The live revision: the merged entity's `baseHash`. Checked against `payload`, as the plugin computes it. */
  revisionHash: string;
  baseHash?: string;
  payload: {
    styles: Array<{ id: string; selector: string; css: string; assets?: Array<{ reference: string; assetId: string }> }>;
    globals: Array<{ id: string; css: string; source?: JsonValue; assets?: Array<{ reference: string; assetId: string }> }>;
    compiledCss: string;
    /** An empty one may come as `[]` (PHP's empty array): read as `{}`, as the plugin hashes it. */
    design?: Record<string, JsonValue> | [];
    tokenOverrides?: Record<string, JsonValue> | [];
    queries?: Record<string, JsonValue> | [];
  };
}

/** One media of the site, as the snapshot writes it (an entity of kind `asset`). */
export interface AddPageAssetEntity {
  id: string;
  kind: "asset";
  schemaVersion: 1;
  revisionHash: string;
  baseHash?: string;
  payload: { sha256: string; mediaType: string; bytes: number; path: string; alt: string; title: string; caption: string; width?: number; height?: number };
}

/**
 * What the site has today, for one page added to it. Every field is read from `PageProfileAdapter::snapshot(false)` (and
 * the slugs from WordPress), nothing is made up:
 * - `projectId`: the project of the site (`manifest.project.id`); the conversion is written into it.
 * - `styles`: the styles entity of the snapshot, as it is (id, revisionHash, payload, the optional baseHash).
 * - `slugs`: the slug of every WordPress page, Histeon or not, in any state (the plugin refuses a slug a page has).
 * - `entityIds`: the id of every entity of the snapshot, of any kind: no new id of the page may be one of them.
 * - `assets`: the media entities of the snapshot, as they are (their names are `payload.title`, their bytes `sha256`).
 * - `files`: the bytes of the media the site's styles use (`media/<sha256>` → bytes): they travel with the merged styles,
 *   because the plugin checks every `url()` of a style against the media of the package. Others may be left out.
 */
export interface AddPageBase {
  projectId: string;
  styles: AddPageStylesEntity;
  slugs: string[];
  entityIds: string[];
  assets: AddPageAssetEntity[];
  files: Record<string, Uint8Array>;
}

/** `convertToXbsite`'s `addPage`: the site's base and, when known, the page's address on the site it came from. */
export interface AddPageInput {
  base: AddPageBase;
  /** The page's path on its own site («/chi-siamo/»): the slug when the page has no canonical address. */
  sourcePath?: string;
  /**
   * V5.7: whose colours the page shows (page-colors.ts): `sito` (the site's, as when it is missing), `pagina` (its own,
   * the site unchanged) or `sostituisci` (the site's colour variables take the page's: every page changes). Missing:
   * the conversion is the one before V5.7, byte for byte, and the report has no `colors`.
   */
  colors?: AddPageColorsMode;
}

/** What the addition did, for the plugin's report. Every list is in the order the page has it. */
export interface AddPageReport {
  slug: string;
  /** Where the slug came from: the canonical address, the page's path, or its title. */
  slugFrom: "canonico" | "percorso" | "titolo";
  pageId: string;
  /** The styles by selector the page brought and the site did not have. */
  stylesAdded: string[];
  /** Selectors the site already has with the same declarations: nothing to add. */
  stylesSame: string[];
  /**
   * Selectors the site already has with other declarations: the site's stay as they are, the page's hold too, limited
   * to the page (M-P2). The site's declarations the page does not have still hold on the page.
   */
  stylesKept: string[];
  /** The page's global sheets, added with these ids (their names in the editor). */
  sheetsAdded: string[];
  /** Site variables (`--xb-site-…`) the site already declares with another value: the site's stay. */
  variablesKept: string[];
  queriesAdded: string[];
  /** Named media queries the site already has with another condition: the site's stay. */
  queriesKept: string[];
  /** The page had its own design (colours, type) or token overrides: they are not imported, the site's stay. */
  designKept: boolean;
  /** Media names: new, reused from the site (same name, same bytes), renamed (a name the site has with other bytes). */
  mediaAdded: string[];
  mediaReused: string[];
  mediaRenamed: Array<{ from: string; to: string }>;
  /** Kinds of entity an added page does not bring, and why. */
  leftOut: Array<{ kind: "parti" | "componenti" | "elenchi"; reason: string }>;
  /**
   * V5.5: the value of `data-histos-pagina` on the page's top-level elements; every style the page adds holds only where
   * it is (page-scope.ts).
   */
  mark: string;
  /** V5.5: global CSS names of the page (animations, fonts, counters, registered properties) the site has: renamed. */
  renamed: PageScopeRename[];
  /** V5.7: what the choice of colours did; only when `addPage.colors` is given. */
  colors?: AddPageColorsReport;
  /**
   * D6: whether the page is a WordPress page (only then is it reduced to its content), where its content was found
   * (`from`, null when it was not recognised or the page is not of WordPress: the page came whole) and what of the theme
   * went with its header, footer and admin bar (page-content.ts). Always there in a result of convertToXbsite.
   */
  content?: { wordpress: boolean; from: PageContentFrom | null; elements: number; scripts: number; sheets: number };
}

/** The codes of an addition refused. The plugin may say them in its own words; `message` is in Italian. */
export type AddPageErrorCode =
  | "base-non-valida"
  | "base-hash"
  | "base-progetto"
  | "base-file-mancante"
  | "prototipo"
  | "piu-pagine"
  | "slug-mancante"
  | "slug-usato"
  | "entita-inattese"
  | AddPageColorsErrorCode;

export class AddPageError extends TypeError {
  readonly code: AddPageErrorCode;
  /** What the code is about: the field of `base`, the slug, the kinds. */
  readonly detail: string;
  constructor(code: AddPageErrorCode, message: string, detail = "") {
    super(message);
    this.name = "AddPageError";
    this.code = code;
    this.detail = detail;
  }
}

/** Past these, a base is refused: a site's export is far below them. */
export const ADD_PAGE_LIMITS = Object.freeze({
  slugs: 100_000,
  slugLength: 200,
  entityIds: 100_000,
  assets: 10_000,
  styles: 20_000,
  globals: 1_000,
  css: 1_048_576,
  selector: 4_096,
  idLength: 128,
  mappings: 500,
  stylesBytes: 32 * 1024 * 1024,
  files: 10_000,
  filesBytes: 200 * 1024 * 1024,
  depth: 64,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const HASH = /^[0-9a-f]{64}$/u;
const SITE_TOKENS_ID = "histos-site-tokens";
const FONT_SHEET_ID = "histos-fonts";

function invalid(field: string, why: string): AddPageError {
  return new AddPageError("base-non-valida", `La base del sito non è valida: ${field} ${why}. Ricarica la pagina e riprova; la pagina non è stata importata.`, field);
}

/** A plain object (also one made in another realm, as a page's frame or a test's context makes them). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function onlyKeys(value: Record<string, unknown>, field: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw invalid(`${field}.${key}`, "manca");
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw invalid(`${field}.${key}`, "non è un campo ammesso");
}

function text(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== "string") throw invalid(field, "non è un testo");
  if (value.length < min || value.length > max) throw invalid(field, `deve avere da ${min} a ${max} caratteri`);
  if (value.includes("\u0000")) throw invalid(field, "contiene un carattere NUL");
  return value;
}

/** A JSON value (no functions, symbols, undefined or numbers that JSON cannot write), at most `depth` levels deep. */
function assertJson(value: unknown, field: string, depth = 0): asserts value is JsonValue {
  if (depth > ADD_PAGE_LIMITS.depth) throw invalid(field, `è annidato oltre ${ADD_PAGE_LIMITS.depth} livelli`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(field, "contiene un numero non finito");
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJson(item, `${field}[${index}]`, depth + 1);
    return;
  }
  if (!isPlainObject(value)) throw invalid(field, "non è un valore JSON");
  for (const [key, item] of Object.entries(value)) assertJson(item, `${field}.${key}`, depth + 1);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes as never).digest("hex");
}

function entityHash(kind: TransferEntity["kind"], payload: Record<string, JsonValue>): string {
  return sha256(canonicalRevisionPayload(kind, 1, payload));
}

function mappings(value: unknown, field: string): Array<{ reference: string; assetId: string }> {
  if (!Array.isArray(value) || value.length > ADD_PAGE_LIMITS.mappings) throw invalid(field, `deve essere un elenco di al massimo ${ADD_PAGE_LIMITS.mappings} voci`);
  return value.map((item, index) => {
    if (!isPlainObject(item)) throw invalid(`${field}[${index}]`, "non è un oggetto");
    onlyKeys(item, `${field}[${index}]`, ["reference", "assetId"]);
    text(item.reference, `${field}[${index}].reference`, 2048, 1);
    if (typeof item.assetId !== "string" || !UUID.test(item.assetId)) throw invalid(`${field}[${index}].assetId`, "non è un UUID");
    return { reference: item.reference as string, assetId: item.assetId };
  });
}

/** `design`, `tokenOverrides`, `queries`: an object, or `[]` for an empty one (PHP), read as `{}` as the plugin hashes it. */
function settingsObject(value: unknown, field: string): Record<string, JsonValue> {
  if (Array.isArray(value) && value.length === 0) return {};
  if (!isPlainObject(value)) throw invalid(field, "non è un oggetto");
  assertJson(value, field);
  return json(value as Record<string, JsonValue>);
}

function readStyles(raw: unknown): AddPageStylesEntity & { payload: Record<string, JsonValue> } {
  if (!isPlainObject(raw)) throw invalid("styles", "non è un oggetto");
  onlyKeys(raw, "styles", ["id", "kind", "schemaVersion", "revisionHash", "payload"], ["baseHash"]);
  if (typeof raw.id !== "string" || !UUID.test(raw.id)) throw invalid("styles.id", "non è un UUID");
  if (raw.kind !== "styles") throw invalid("styles.kind", "non è «styles»");
  if (raw.schemaVersion !== 1) throw invalid("styles.schemaVersion", "non è 1");
  if (typeof raw.revisionHash !== "string" || !HASH.test(raw.revisionHash)) throw invalid("styles.revisionHash", "non è uno SHA-256 esadecimale");
  if (raw.baseHash !== undefined && (typeof raw.baseHash !== "string" || !HASH.test(raw.baseHash))) throw invalid("styles.baseHash", "non è uno SHA-256 esadecimale");
  const payload = raw.payload;
  if (!isPlainObject(payload)) throw invalid("styles.payload", "non è un oggetto");
  onlyKeys(payload, "styles.payload", ["styles", "globals", "compiledCss"], ["design", "tokenOverrides", "queries"]);
  if (!Array.isArray(payload.styles) || payload.styles.length > ADD_PAGE_LIMITS.styles) throw invalid("styles.payload.styles", `deve essere un elenco di al massimo ${ADD_PAGE_LIMITS.styles} voci`);
  if (!Array.isArray(payload.globals) || payload.globals.length > ADD_PAGE_LIMITS.globals) throw invalid("styles.payload.globals", `deve essere un elenco di al massimo ${ADD_PAGE_LIMITS.globals} voci`);
  text(payload.compiledCss, "styles.payload.compiledCss", 4 * ADD_PAGE_LIMITS.css);
  const styles = payload.styles.map((entry: unknown, index) => {
    const field = `styles.payload.styles[${index}]`;
    if (!isPlainObject(entry)) throw invalid(field, "non è un oggetto");
    onlyKeys(entry, field, ["id", "selector", "css"], ["assets"]);
    const out: Record<string, JsonValue> = { id: text(entry.id, `${field}.id`, ADD_PAGE_LIMITS.idLength, 1), selector: text(entry.selector, `${field}.selector`, ADD_PAGE_LIMITS.selector, 1), css: text(entry.css, `${field}.css`, ADD_PAGE_LIMITS.css) };
    if (entry.assets !== undefined) out.assets = mappings(entry.assets, `${field}.assets`);
    return out;
  });
  const globals = payload.globals.map((entry: unknown, index) => {
    const field = `styles.payload.globals[${index}]`;
    if (!isPlainObject(entry)) throw invalid(field, "non è un oggetto");
    onlyKeys(entry, field, ["id", "css"], ["source", "assets"]);
    const out: Record<string, JsonValue> = { id: text(entry.id, `${field}.id`, ADD_PAGE_LIMITS.idLength, 1), css: text(entry.css, `${field}.css`, ADD_PAGE_LIMITS.css) };
    if (entry.source !== undefined) {
      if (!isPlainObject(entry.source)) throw invalid(`${field}.source`, "non è un oggetto");
      assertJson(entry.source, `${field}.source`);
      out.source = json(entry.source);
    }
    if (entry.assets !== undefined) out.assets = mappings(entry.assets, `${field}.assets`);
    return out;
  });
  const normalized: Record<string, JsonValue> = { styles, globals, compiledCss: payload.compiledCss as string };
  for (const key of ["design", "tokenOverrides", "queries"] as const) if (payload[key] !== undefined) normalized[key] = settingsObject(payload[key], `styles.payload.${key}`);
  if (canonicalizeJson(normalized).length > ADD_PAGE_LIMITS.stylesBytes) throw invalid("styles.payload", `supera ${ADD_PAGE_LIMITS.stylesBytes / 1048576} MB`);
  if (entityHash("styles", normalized) !== raw.revisionHash) {
    throw new AddPageError("base-hash", "La base del sito non è valida: la revisione degli stili (styles.revisionHash) non corrisponde al loro contenuto. Ricarica la pagina e riprova; la pagina non è stata importata.", "styles.revisionHash");
  }
  return { id: raw.id, kind: "styles", schemaVersion: 1, revisionHash: raw.revisionHash, ...(raw.baseHash !== undefined ? { baseHash: raw.baseHash as string } : {}), payload: normalized } as AddPageStylesEntity & { payload: Record<string, JsonValue> };
}

function readAsset(raw: unknown, index: number): AddPageAssetEntity {
  const field = `assets[${index}]`;
  if (!isPlainObject(raw)) throw invalid(field, "non è un oggetto");
  onlyKeys(raw, field, ["id", "kind", "schemaVersion", "revisionHash", "payload"], ["baseHash"]);
  if (typeof raw.id !== "string" || !UUID.test(raw.id)) throw invalid(`${field}.id`, "non è un UUID");
  if (raw.kind !== "asset") throw invalid(`${field}.kind`, "non è «asset»");
  if (raw.schemaVersion !== 1) throw invalid(`${field}.schemaVersion`, "non è 1");
  if (typeof raw.revisionHash !== "string" || !HASH.test(raw.revisionHash)) throw invalid(`${field}.revisionHash`, "non è uno SHA-256 esadecimale");
  if (raw.baseHash !== undefined && (typeof raw.baseHash !== "string" || !HASH.test(raw.baseHash))) throw invalid(`${field}.baseHash`, "non è uno SHA-256 esadecimale");
  const payload = raw.payload;
  if (!isPlainObject(payload)) throw invalid(`${field}.payload`, "non è un oggetto");
  onlyKeys(payload, `${field}.payload`, ["sha256", "mediaType", "bytes", "path", "alt", "title", "caption"], ["width", "height"]);
  if (typeof payload.sha256 !== "string" || !HASH.test(payload.sha256)) throw invalid(`${field}.payload.sha256`, "non è uno SHA-256 esadecimale");
  if (payload.path !== `media/${payload.sha256}`) throw invalid(`${field}.payload.path`, "non è media/<sha256>");
  text(payload.mediaType, `${field}.payload.mediaType`, 128, 1);
  if (!Number.isSafeInteger(payload.bytes) || (payload.bytes as number) < 0) throw invalid(`${field}.payload.bytes`, "non è un intero non negativo");
  text(payload.alt, `${field}.payload.alt`, 1000);
  text(payload.title, `${field}.payload.title`, 500);
  text(payload.caption, `${field}.payload.caption`, 4000);
  for (const key of ["width", "height"] as const) if (payload[key] !== undefined && (!Number.isSafeInteger(payload[key]) || (payload[key] as number) < 0)) throw invalid(`${field}.payload.${key}`, "non è un intero non negativo");
  // Copied as JSON: what is read from here on is this realm's data, never the caller's objects.
  const asset = json(raw) as unknown as AddPageAssetEntity;
  if (entityHash("asset", asset.payload as unknown as Record<string, JsonValue>) !== asset.revisionHash) {
    throw new AddPageError("base-hash", `La base del sito non è valida: la revisione del media ${field} non corrisponde al suo contenuto. Ricarica la pagina e riprova; la pagina non è stata importata.`, `${field}.revisionHash`);
  }
  return asset;
}

function uniqueStrings(value: unknown, field: string, max: number, check: (item: string, at: string) => void): string[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(field, `deve essere un elenco di al massimo ${max} voci`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw invalid(`${field}[${index}]`, "non è un testo");
    check(item, `${field}[${index}]`);
  }
  return value as string[];
}

/**
 * The site's base, read as untrusted data: every field of `AddPageBase` with its type and its limits, the hashes of the
 * styles and of each media against their content, the bytes of each file against its name, and the media the styles use
 * present with their bytes. Anything else is an `AddPageError`.
 */
export function readAddPageBase(raw: unknown): AddPageBase {
  if (!isPlainObject(raw)) throw invalid("base", "non è un oggetto");
  onlyKeys(raw, "base", ["projectId", "styles", "slugs", "entityIds", "assets", "files"]);
  if (typeof raw.projectId !== "string" || !UUID.test(raw.projectId)) throw invalid("projectId", "non è un UUID");
  const styles = readStyles(raw.styles);
  const slugs = uniqueStrings(raw.slugs, "slugs", ADD_PAGE_LIMITS.slugs, (item, at) => text(item, at, ADD_PAGE_LIMITS.slugLength));
  const entityIds = uniqueStrings(raw.entityIds, "entityIds", ADD_PAGE_LIMITS.entityIds, (item, at) => {
    if (!UUID.test(item)) throw invalid(at, "non è un UUID");
  });
  if (!Array.isArray(raw.assets) || raw.assets.length > ADD_PAGE_LIMITS.assets) throw invalid("assets", `deve essere un elenco di al massimo ${ADD_PAGE_LIMITS.assets} voci`);
  const assets = raw.assets.map((asset, index) => readAsset(asset, index));
  const assetIds = new Set<string>();
  for (const [index, asset] of assets.entries()) {
    if (assetIds.has(asset.id)) throw invalid(`assets[${index}].id`, "è ripetuto");
    assetIds.add(asset.id);
  }
  if (!isPlainObject(raw.files)) throw invalid("files", "non è un oggetto");
  const names = Object.keys(raw.files);
  if (names.length > ADD_PAGE_LIMITS.files) throw invalid("files", `ha più di ${ADD_PAGE_LIMITS.files} file`);
  let total = 0;
  const files: Record<string, Uint8Array> = {};
  for (const name of names) {
    const bytes = raw.files[name];
    if (!/^media\/[0-9a-f]{64}$/u.test(name)) throw invalid(`files["${name.slice(0, 80)}"]`, "non ha un nome media/<sha256>");
    if (!isBytes(bytes)) throw invalid(`files["${name}"]`, "non è un Uint8Array");
    total += bytes.byteLength;
    if (total > ADD_PAGE_LIMITS.filesBytes) throw invalid("files", `supera ${ADD_PAGE_LIMITS.filesBytes / 1048576} MB`);
    if (sha256(bytes) !== name.slice(6)) throw invalid(`files["${name}"]`, "non ha i byte del suo SHA-256");
    files[name] = new Uint8Array(bytes);
  }
  // The media the site's styles use travel with the merged styles: each one is a media of the base, with its bytes.
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const rules = [...(styles.payload.styles as Array<Record<string, JsonValue>>), ...(styles.payload.globals as Array<Record<string, JsonValue>>)];
  for (const rule of rules) {
    for (const mapping of (rule.assets ?? []) as Array<{ assetId: string }>) {
      const asset = byId.get(mapping.assetId);
      if (!asset) throw invalid("styles.payload", `usa il media ${mapping.assetId}, che non è fra gli assets`);
      if (!files[asset.payload.path]) {
        throw new AddPageError("base-file-mancante", `La base del sito non ha i byte del media «${asset.payload.title}» (${asset.payload.path}), che gli stili del sito usano: servono per inviare gli stili uniti. La pagina non è stata importata.`, asset.payload.path);
      }
    }
  }
  return { projectId: raw.projectId, styles, slugs, entityIds, assets, files };
}

// ---------------------------------------------------------------------------------------------------------- the slug

function slugify(value: string, max = 63): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max).replace(/-+$/u, "");
}

/** The last part of an address or a path («/chi-siamo/» → «chi-siamo», «storia.html» → «storia»); empty for the root. */
function lastPart(address: string): string {
  let pathname: string;
  try {
    pathname = new URL(address, "https://pagina.invalid/").pathname;
  } catch {
    return "";
  }
  const parts = pathname.split("/").filter(Boolean);
  let last = parts.at(-1) ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    // An address that does not decode is read as written.
  }
  last = last.replace(/\.html?$/iu, "");
  if (last.toLowerCase() === "index") last = parts.length > 1 ? (parts.at(-2) ?? "") : "";
  return slugify(last);
}

/** The canonical address of a page, read from its `<head>`: `<link rel="canonical" href="…">`. */
export function canonicalAddress(html: string): string | null {
  const head = html.slice(0, 262_144);
  for (const match of head.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
    if (!rel || !(rel[1] ?? rel[2] ?? rel[3] ?? "").toLowerCase().split(/\s+/u).includes("canonical")) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
    const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (value) return value.replaceAll("&amp;", "&");
  }
  return null;
}

/**
 * The slug of the added page: from its canonical address, else from its path on its site (`sourcePath`, then the file's
 * own path), else from its title. Null when none gives one.
 */
export function addedPageSlug(input: { html: string; filePath: string; sourcePath?: string; title: string }): { slug: string; from: AddPageReport["slugFrom"] } | null {
  const canonical = canonicalAddress(input.html);
  const fromCanonical = canonical ? lastPart(canonical) : "";
  if (fromCanonical) return { slug: fromCanonical, from: "canonico" };
  for (const path of [input.sourcePath ?? "", input.filePath]) {
    const slug = path ? lastPart(path) : "";
    if (slug) return { slug, from: "percorso" };
  }
  const fromTitle = slugify(input.title);
  return fromTitle ? { slug: fromTitle, from: "titolo" } : null;
}

// ------------------------------------------------------------------------------------------------------- the addition

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every UUID of `value`'s texts that `ids` renames, renamed (a UUID is never part of anything else). */
function renameIds<T extends JsonValue>(value: T, ids: ReadonlyMap<string, string>): T {
  if (!ids.size) return value;
  return JSON.parse(JSON.stringify(value).replace(UUID_IN_TEXT, (id) => ids.get(id) ?? id)) as T;
}

function ndjson(values: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(values.length ? values.map((value) => canonicalizeJson(json(value))).join("\n") + "\n" : "");
}

/** `--name:value;` declarations of the site-tokens sheet (`:root{…}`), by name. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = /^\s*:root\s*\{([\s\S]*)\}\s*$/u.exec(css)?.[1] ?? "";
  for (const part of body.split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name.startsWith("--")) out.set(name, part.slice(at + 1).trim());
  }
  return out;
}

const RENAMED_NOTE: Record<PageScopeRename["kind"], [string, string]> = { animazione: ["Animazione", "rinominata"], carattere: ["Carattere", "rinominato"], contatore: ["Stile di contatore", "rinominato"], proprieta: ["Proprietà registrata", "rinominata"] };

function uniqueName(wanted: string, taken: ReadonlySet<string>, max = ADD_PAGE_LIMITS.idLength): string {
  const base = wanted.slice(0, max);
  if (!taken.has(base)) return base;
  for (let counter = 2; ; counter++) {
    const suffix = `-${counter}`;
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** «foto.png» → «foto-2.png». */
function suffixed(name: string, counter: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${counter}${name.slice(dot)}` : `${name}-${counter}`;
}

/**
 * The converted profile (one page, the styles, its media) as an addition to the site's base: the page with `slug` and a
 * new id, its media (reused, new or renamed), the site's styles entity merged (the site's entries as they are, then the
 * page's sheets and the styles by selector the site lacks), `baseHash` the live revision. Checked as any archive.
 */
export function addPageToSite(built: { profile: StaticPageProfile; files: ReadonlyMap<string, Uint8Array> }, base: AddPageBase, page: { slug: string; slugFrom: AddPageReport["slugFrom"] }, leftOut: AddPageReport["leftOut"], colors?: { mode: AddPageColorsMode; page: AddPageColorsReport["page"]; kept: number }): { profile: StaticPageProfile; files: Map<string, Uint8Array>; report: AddPageReport; notes: string[] } {
  const { profile } = built;
  const projectId = base.projectId;
  const unexpected = profile.entities.filter((entity) => !["document", "styles", "asset"].includes(entity.kind));
  const documents = profile.entities.filter((entity) => entity.kind === "document");
  if (unexpected.length || documents.length !== 1 || profile.entities.filter((entity) => entity.kind === "styles").length !== 1) {
    const kinds = [...new Set(unexpected.map((entity) => entity.kind))].join(", ") || `${documents.length} documenti`;
    throw new AddPageError("entita-inattese", `La conversione ha dato più di una pagina con i suoi stili e i suoi media (${kinds}): una pagina aggiunta a un sito porta solo questo. La pagina non è stata importata.`, kinds);
  }
  const used = new Set(base.slugs.map((slug) => slug.toLowerCase()));
  if (used.has(page.slug)) {
    throw new AddPageError("slug-usato", `Il sito ha già una pagina con lo slug «${page.slug}»: Histeon non la sovrascrive e non la rinomina. Rinomina o elimina quella pagina in WordPress, oppure dai alla pagina da importare un altro indirizzo canonico o un altro titolo, poi riprova.`, page.slug);
  }
  const taken = new Set(base.entityIds);
  for (const asset of base.assets) taken.add(asset.id);
  taken.add(base.styles.id);

  const report: AddPageReport = { slug: page.slug, slugFrom: page.slugFrom, pageId: "", stylesAdded: [], stylesSame: [], stylesKept: [], sheetsAdded: [], variablesKept: [], queriesAdded: [], queriesKept: [], designKept: false, mediaAdded: [], mediaReused: [], mediaRenamed: [], leftOut, mark: "", renamed: [] };
  const notes: string[] = [];

  // The page: the slug of the page it came from, and an id of its own, as an import of the project would name it.
  let pageId = stableId(projectId, "page", page.slug);
  for (let counter = 2; taken.has(pageId); counter++) pageId = stableId(projectId, "page", `${page.slug}-${counter}`);
  taken.add(pageId);
  report.pageId = pageId;
  const ids = new Map<string, string>([[documents[0]!.id, pageId]]);

  // Media: the same name with the same bytes is the site's; a name the site has with other bytes takes a suffix.
  const liveById = new Map(base.assets.map((asset) => [asset.id, asset]));
  const liveTitles = new Set(base.assets.map((asset) => asset.payload.title));
  const outAssets = new Map<string, TransferEntity>();
  const outFiles = new Map<string, Uint8Array>();
  for (const asset of profile.entities.filter((entity) => entity.kind === "asset")) {
    const payload = asset.payload as unknown as AddPageAssetEntity["payload"];
    const bytes = built.files.get(payload.path);
    if (!bytes) throw new TypeError(`Manca il file del media ${payload.title}.`);
    const same = liveById.get(asset.id)?.payload.sha256 === payload.sha256 ? liveById.get(asset.id) : base.assets.find((live) => live.payload.title === payload.title && live.payload.sha256 === payload.sha256);
    if (same) {
      ids.set(asset.id, same.id);
      outAssets.set(same.id, json(same) as unknown as TransferEntity);
      outFiles.set(same.payload.path, bytes);
      report.mediaReused.push(payload.title);
      continue;
    }
    if (taken.has(asset.id) || liveTitles.has(payload.title)) {
      let name = payload.title;
      let id = asset.id;
      let reused: AddPageAssetEntity | undefined;
      for (let counter = 2; taken.has(id) || liveTitles.has(name); counter++) {
        name = suffixed(payload.title, counter);
        id = stableId(projectId, "asset", name);
        // A name the site gave these same bytes before (a page added earlier): the site's media again.
        reused = base.assets.find((live) => (live.id === id || live.payload.title === name) && live.payload.sha256 === payload.sha256);
        if (reused) break;
      }
      if (reused) {
        ids.set(asset.id, reused.id);
        outAssets.set(reused.id, json(reused) as unknown as TransferEntity);
        outFiles.set(reused.payload.path, bytes);
        report.mediaReused.push(payload.title);
        continue;
      }
      const renamed = { ...asset.payload, title: name } as Record<string, JsonValue>;
      ids.set(asset.id, id);
      taken.add(id);
      liveTitles.add(name);
      outAssets.set(id, { id, kind: "asset", schemaVersion: 1, revisionHash: entityHash("asset", renamed), payload: renamed });
      outFiles.set(payload.path, bytes);
      report.mediaRenamed.push({ from: payload.title, to: name });
      notes.push(`Media ${payload.title} rinominato ${name}: il sito ha già un media con quel nome e byte diversi`);
      continue;
    }
    taken.add(asset.id);
    liveTitles.add(payload.title);
    outAssets.set(asset.id, json(asset));
    outFiles.set(payload.path, bytes);
    report.mediaAdded.push(payload.title);
  }

  // V5.5: the page's styles hold only on the page. Its top-level elements take its mark, and every rule it adds is
  // limited to the elements with the mark (and to html and body where they hold it); see page-scope.ts.
  const live = base.styles;
  const livePayload = live.payload as unknown as Record<string, JsonValue>;
  const pageStylesEntity = profile.entities.find((entity) => entity.kind === "styles")!;
  const pageStyles = renameIds(pageStylesEntity.payload, ids) as Record<string, JsonValue>;
  const asRules = (payload: Record<string, JsonValue>): string[] => [
    ...((payload.globals ?? []) as Array<Record<string, JsonValue>>).map((entry) => String(entry.css)),
    ...((payload.styles ?? []) as Array<Record<string, JsonValue>>).map((entry) => `${String(entry.selector)}{${String(entry.css)}}`),
  ];
  const scope = pageScope(page.slug, asRules(livePayload), asRules(pageStyles));
  report.mark = scope.mark;
  report.renamed = scope.renamed;

  // The page's document, with its references, named as above, and its mark.
  const document = documents[0]!;
  const renamedPayload = renameIds(document.payload, ids) as Record<string, JsonValue>;
  const marked = markPageContent(String(renamedPayload.content ?? ""), scope.mark);
  const pagePayload = { ...renamedPayload, content: marked.content, slug: page.slug } as Record<string, JsonValue>;
  const pageEntity: TransferEntity = { id: pageId, kind: "document", schemaVersion: 1, revisionHash: entityHash("document", pagePayload), payload: pagePayload };
  const references: TransferReference[] = profile.references.map((reference) => ({ ...reference, ownerId: ids.get(reference.ownerId) ?? reference.ownerId, targetId: ids.get(reference.targetId) ?? reference.targetId }));

  // The styles: the site's as they are, then what the page adds. The site wins on every name it already has.
  const merged = json(livePayload) as Record<string, JsonValue> & { styles: Array<Record<string, JsonValue>>; globals: Array<Record<string, JsonValue>> };
  const bySelector = new Map(merged.styles.map((entry) => [entry.selector as string, entry]));
  const styleIds = new Set(merged.styles.map((entry) => entry.id as string));
  // V5.5: a style holds on the page only. Its rules as the plugin prints them (a BEM part, `&__titolo`, is a rule of its
  // own), each with its selector limited to the page and the page's names in its body; the first keeps the id.
  const addOnPage = (entry: Record<string, JsonValue>, selector: string) => {
    for (const [index, rule] of styleRules(selector, entry.css as string).entries()) {
      let id = index === 0 ? (entry.id as string) : stableId(projectId, "style", `${page.slug}:${rule.selector}`);
      if (styleIds.has(id)) id = uniqueName(stableId(projectId, "style", `${page.slug}:${rule.selector}`), styleIds);
      styleIds.add(id);
      // Each rule keeps the style's media mappings: the plugin checks every url() of a rule against them.
      merged.styles.push({ ...entry, id, selector: scopeSelectorList(rule.selector, scope.filter), css: renameInStyleBody(rule.css, scope) });
    }
  };
  for (const entry of (pageStyles.styles ?? []) as Array<Record<string, JsonValue>>) {
    const selector = entry.selector as string;
    const present = bySelector.get(selector);
    if (present) {
      if (present.css === entry.css && canonicalizeJson(present.assets ?? []) === canonicalizeJson(entry.assets ?? [])) report.stylesSame.push(selector);
      else {
        // M-P2: the site's stays as it is on every page; the page's holds too, on the page only. Limited and after the
        // site's, with the same specificity (`:where()` adds none), it wins there on every property it declares.
        addOnPage(entry, selector);
        report.stylesKept.push(selector);
        notes.push(`Stile ${selector}: il sito lo ha già diverso, quello della pagina vale solo su questa pagina`);
      }
      continue;
    }
    bySelector.set(selector, entry);
    addOnPage(entry, selector);
    report.stylesAdded.push(selector);
  }
  const sheetIds = new Set(merged.globals.map((entry) => entry.id as string));
  const siteVariables = declarations(String(merged.globals.find((entry) => entry.id === SITE_TOKENS_ID)?.css ?? ""));
  let sheet = 0;
  const siteSized = merged.globals.some((site) => isSizedSheet(String(site.css)));
  // A sheet the site already has, letter for letter (a reset every page carries, the site's own and global), is not
  // added a second time.
  for (const entry of (pageStyles.globals ?? []) as Array<Record<string, JsonValue>>) {
    let css = entry.css as string;
    let wanted: string;
    // The rule of the images the conversion sized: no specificity, only the marked images; shared by the whole site,
    // one sheet for every page, never limited to one page.
    if (isSizedSheet(css)) {
      if (siteSized) continue;
      const id = uniqueName("misure-immagini", sheetIds);
      sheetIds.add(id);
      merged.globals.push({ ...entry, id, css });
      report.sheetsAdded.push(id);
      continue;
    }
    if (entry.id === SITE_TOKENS_ID) {
      // The page's own site variables: only those the site does not declare; a different value stays the site's.
      const kept: string[] = [];
      for (const [name, value] of declarations(css)) {
        const site = siteVariables.get(name);
        if (site === undefined) kept.push(`${name}:${value};`);
        else if (site !== value) {
          report.variablesKept.push(name);
          notes.push(`Variabile ${name} non importata perché il sito la ha già diversa`);
        }
      }
      if (!kept.length) continue;
      css = `:root{${kept.join("")}}`;
      wanted = `${page.slug}-variabili`;
    } else if (entry.id === FONT_SHEET_ID) wanted = `${page.slug}-caratteri`;
    else if (merged.globals.some((site) => site.css === css)) continue;
    else wanted = `${page.slug}-foglio-${++sheet}`;
    const scoped = scopeSheet(css, scope);
    if (!scoped) {
      notes.push(`Foglio ${wanted} non importato: il CSS non si legge, e non si può limitare alla pagina`);
      continue;
    }
    for (const note of scoped.notes) if (!notes.includes(note)) notes.push(note);
    const id = uniqueName(wanted, sheetIds);
    sheetIds.add(id);
    merged.globals.push({ ...entry, id, css: scoped.css });
    report.sheetsAdded.push(id);
  }
  const pageQueries = (pageStyles.queries ?? {}) as Record<string, JsonValue>;
  if (Object.keys(pageQueries).length) {
    const queries = { ...((merged.queries ?? {}) as Record<string, JsonValue>) };
    for (const [name, query] of Object.entries(pageQueries)) {
      if (!Object.hasOwn(queries, name)) {
        queries[name] = query;
        report.queriesAdded.push(name);
      } else if (canonicalizeJson(queries[name]) !== canonicalizeJson(query)) {
        report.queriesKept.push(name);
        notes.push(`Media query ${name} non importata perché il sito la ha già diversa`);
      }
    }
    merged.queries = queries;
  }
  if (colors?.mode === "sostituisci") {
    // V5.7, asked for: the site's colour variables take the page's colours, nothing else of its design.
    let replaced: ReturnType<typeof replaceSiteColors>;
    try {
      replaced = replaceSiteColors(merged, colors.page, merged.globals.map((entry) => ({ id: String(entry.id), css: String(entry.css) })));
    } catch (error) {
      if (error instanceof TypeError) throw invalid("styles.payload.design", `non è un design di Histeon CSS (${error.message.replace(/\.$/u, "")})`);
      throw error;
    }
    if (replaced.settings.some((item) => item.name.startsWith("design."))) merged.design = replaced.design;
    if (replaced.settings.some((item) => item.name.startsWith("tokenOverrides."))) merged.tokenOverrides = replaced.tokenOverrides;
    report.colors = { mode: colors.mode, page: colors.page, kept: 0, settings: replaced.settings, changes: replaced.changes, covered: replaced.covered };
    const families = new Set<string>(colors.page.map((color) => color.family));
    report.designKept = designKeptBesides(pageStyles.design, merged.design, families) || designKeptBesides(pageStyles.tokenOverrides, merged.tokenOverrides, new Set());
    notes.push(replaced.changes.length ? `Colori del sito sostituiti con quelli della pagina: cambiano ${new Set(replaced.changes.map((change) => change.variable)).size} variabili, in tutte le pagine del sito` : "Colori del sito già uguali a quelli della pagina: niente da sostituire");
    for (const item of replaced.covered) notes.push(`Variabile ${item.variable} dichiarata anche nel foglio ${item.sheet} del sito: dove vale quella regola resta il suo valore`);
    if (report.designKept) notes.push("Caratteri, misure e altri valori del design della pagina non importati: restano quelli del sito");
  } else {
    // The design and the token overrides are the site's: the page's would change every page of the site.
    for (const key of ["design", "tokenOverrides"] as const) {
      const own = pageStyles[key];
      if (own && typeof own === "object" && Object.keys(own).length && canonicalizeJson(own) !== canonicalizeJson(merged[key] ?? {})) report.designKept = true;
    }
    if (report.designKept) notes.push("Design e token della pagina non importati: restano quelli del sito");
    if (colors) {
      report.colors = { mode: colors.mode, page: colors.page, kept: colors.kept, settings: [], changes: [], covered: [] };
      if (colors.mode === "pagina" && colors.kept) notes.push(`Colori della pagina tenuti nella pagina: ${colors.kept} variabili del sito tornate ai valori della pagina, il sito non cambia`);
      else if (colors.mode === "sito" && colors.page.length) notes.push("Colori della pagina presi dal sito: la pagina usa le variabili dei colori del sito");
    }
  }
  const stylesEntity: TransferEntity = { id: live.id, kind: "styles", schemaVersion: 1, revisionHash: entityHash("styles", merged), baseHash: live.revisionHash, payload: merged };

  // The media the site's styles use travel unchanged: the plugin checks every url() against the package's media.
  for (const rule of [...merged.styles, ...merged.globals]) {
    for (const mapping of (rule.assets ?? []) as Array<{ assetId: string }>) {
      if (outAssets.has(mapping.assetId)) continue;
      const asset = liveById.get(mapping.assetId);
      if (!asset) throw new TypeError(`Gli stili uniti usano il media ${mapping.assetId}, che non è né del sito né della pagina.`);
      outAssets.set(asset.id, json(asset) as unknown as TransferEntity);
      outFiles.set(asset.payload.path, base.files[asset.payload.path]!);
    }
  }

  const entities = [pageEntity, stylesEntity, ...outAssets.values()].sort((left, right) => left.id.localeCompare(right.id));
  references.sort((left, right) => `${left.ownerId}\0${left.blockUid}\0${left.path}\0${left.targetId}\0${left.index ?? ""}`.localeCompare(`${right.ownerId}\0${right.blockUid}\0${right.path}\0${right.targetId}\0${right.index ?? ""}`));
  const files = new Map<string, Uint8Array>(outFiles);
  files.set("entities.ndjson", ndjson(entities));
  files.set("references.ndjson", ndjson(references));
  const manifestBase: Omit<TransferManifest, "manifestHash"> = {
    format: "xb-site",
    version: 2,
    generator: profile.manifest.generator,
    project: { ...profile.manifest.project, id: projectId },
    selection: profile.manifest.selection,
    requiredCapabilities: ["documents:page:v1", "styles:global:v1", "media:asset:v1", ...(transferUsesScripts(entities) ? [SCRIPT_CAPABILITY] : [])],
    profile: "histos-static-page-v1",
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: sha256(bytes), mediaType: path.endsWith(".ndjson") ? "application/x-ndjson" : "application/octet-stream" })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifest: TransferManifest = { ...manifestBase, manifestHash: sha256(manifestHashInput(manifestBase)) };
  const out: StaticPageProfile = { manifest, entities, references };
  checkProfileForArchive(out, files);
  for (const item of scope.renamed) notes.push(`${RENAMED_NOTE[item.kind][0]} ${item.from} della pagina ${RENAMED_NOTE[item.kind][1]} ${item.to}: il sito ha già quel nome`);
  notes.unshift(`Stili della pagina limitati alla pagina (${PAGE_MARK}="${scope.mark}" sui suoi ${marked.marked} elementi principali): le altre pagine del sito non cambiano`);
  notes.unshift(`Pagina aggiunta al sito con lo slug ${page.slug}: il resto del sito non cambia`);
  return { profile: out, files, report, notes };
}
