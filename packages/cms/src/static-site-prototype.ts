import { breakpointNotes } from "./conversion-report.js";
import { ImportChoiceBook, type ImportChoice, type ImportChoiceRejection } from "./import-choices.js";
import { validateHistosDesign } from "./histos-design.js";
import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";
import postcss, { type AtRule, type ChildNode, type Root } from "postcss";
import valueParser, { type Node as ValueNode } from "postcss-value-parser";
import { cleanupCss, cssDesignParameters, type CssCleanupSheet, type ImportFramework } from "./css-cleanup.js";
import { staticInlineSvg } from "./css-inline-svg.js";
import { convertedMediaUrl, PROTOTYPE_MAX_BYTES, sniffPrototypeMedia } from "./prototype-media.js";
import { DOCUMENT_SCRIPT_MAX_BYTES } from "./document-script.js";
import { base64FromBytes, bytesFromBase64, sha256Hex, utf8Length } from "./isomorphic.js";
import { escapeText, structureSite, type SiteElement, type SiteNode, type StructureOptions, type StructureProposal } from "./site-structure.js";
import { acssSiteNotes } from "./framework-names.js";
import { lostInteractions } from "./lost-interactions.js";
import { classStyledInlineElements, inlineSelectors, styledClasses } from "./inline-classes.js";
import { convertUtilityClasses, scriptClassNames } from "./utility-classes.js";
import { UTILITY_VISUAL_CANDIDATES, type UtilityVisualPair, utilityVisualPairs, visualBody } from "./utility-visual-check.js";
import { applyProposalRecipes, hasHisteonBehaviour } from "./proposal-recipes.js";
import { applyRecipes, dropHandlerMarks } from "./recipes.js";
import { rootClassRules } from "./root-class-rules.js";
import { imageSize } from "./image-size.js";
import { checkTransferElement, childContext, transferHtmlAttributeAllowed, TRANSFER_NEW_HTML_TAGS, TRANSFER_ROOT_CONTEXT, TRANSFER_SVG_TAGS, TRANSFER_SVG_TEXT_PARENTS, TransferMarkupError, type TransferMarkupContext } from "./transfer-markup.js";

/**
 * "Converti in progetto Histeon" (queue B1): a static site (the files of a Publish build) becomes a Histeon prototype,
 * which then goes through the same check, preview and import as any prototype. Nothing here trusts the site: only a
 * closed list of tags and attributes survives, links are rewritten or dropped, images and fonts become media, CSS
 * keeps only references to those media. What is dropped is counted in the report.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** The text of a parsed node (for the context of a choice), spaces folded, at most `max` characters. */
function parsedText(node: Node, max: number): string {
  let out = "";
  const visit = (current: Node): void => {
    if (out.length > max) return;
    if (current.nodeName === "#text") out += ` ${(current as DefaultTreeAdapterMap["textNode"]).value}`;
    else if (current.nodeName !== "script" && current.nodeName !== "style" && "childNodes" in current) for (const child of current.childNodes) visit(child as Node);
  };
  visit(node);
  return out.replace(/\s+/gu, " ").trim().slice(0, max);
}

export interface StaticSiteFile {
  /** Relative path in the site, with `/`. */
  path: string;
  bytes: Uint8Array;
}

/** D5: a sheet of a page as `brandSheet` sees it, before it is converted. */
export interface StaticSiteSheetSource {
  kind: "link" | "style";
  /** A linked sheet's path in the site (or another site's address); empty for a `<style>`. */
  href: string;
  /** The element's `id` attribute, or empty. */
  id: string;
}

export interface StaticSitePrototype {
  /** The prototype file, at most PROTOTYPE_MAX_BYTES. */
  html: string;
  report: { pages: number; assets: number; stylesheets: number; notes: string[] };
  /** Google Fonts stylesheets the site links: their fonts can be downloaded on request (B5). */
  googleFonts: string[];
  /** The Histeon CSS `design` proposed from the site's colors and fonts (B4), applied only with `tokens`. */
  design: Record<string, string>;
  tokens: boolean;
  /** The framework the values were written with (doc 18 §6.4.1). */
  framework: ImportFramework;
  /** Doc 28: true when the sizes written by hand were kept exact, as the site's variables. */
  exact: boolean;
  /** Doc 28: those variables, names without `--xb-site-`; empty without `exact`. */
  siteTokens: Record<string, string>;
  /** Doc 18 §6.6: the recipes were applied instead of the site's scripts. */
  recipes: boolean;
  /** Whether the site has patterns a recipe can replace (and so a choice to offer). */
  recipesAvailable: boolean;
  /** What repeats in the site (B3): parts, components and lists it could become, applied only with `structure`. */
  structure: StructureProposal;
  structureApplied: StructureOptions;
  /**
   * Images and fonts of other sites (https) the pages use and `remoteMedia` did not give: the caller downloads them
   * (doc 18 §6.2, always) and converts again with their bytes. At most MAX_REMOTE_MEDIA.
   */
  remoteMedia: string[];
  /** Doc 23 item 101: pages before and after the utility conversion, for the app's screenshot check. */
  utilityVisual: UtilityVisualPair[];
  /** Doc 27: the names of judgement this conversion made, each a choice a model or a person may answer. */
  choices: ImportChoice[];
  /** Doc 27: the answers given in `choices` that were not used, and why. */
  choicesRejected: ImportChoiceRejection[];
}

/** Tags kept as they are: the transferable markup every Histeon reader accepts (`kbd` and `wbr` only inside a text run). */
const KEPT_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt",
  "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "kbd", "li", "main",
  "mark", "nav", "ol", "p", "pre", "q", "s", "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "th", "thead", "time", "tr", "u", "ul", "wbr",
]);
/**
 * Dropped with everything inside: active content and embedded documents. Forms, their fields, buttons, `picture`,
 * `details` and static SVG are kept (doc 18 F2), checked element by element with the import's own rules
 * (`checkTransferElement`): what those rules refuse goes, with a note.
 */
const DROPPED_TAGS = new Set([
  "script", "noscript", "style", "link", "meta", "base", "iframe", "frame", "frameset", "object", "embed", "applet", "video", "audio",
  "track", "canvas", "math", "datalist", "template", "slot", "portal", "head", "title",
]);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** `var(--nome, ripiego)` as the whole value of a paint: the name, then the fallback as written. */
const PAINT_FALLBACK = /^var\(\s*(--[A-Za-z0-9_-]{1,64})\s*,\s*(.{1,200})\)$/su;
/** Paints with a fallback decided in one conversion: beyond, they stay `var(--nome)`. */
const MAX_PAINT_FALLBACKS = 2000;
/** Input types that never go into a converted site: their fields go with a note. */
const DROPPED_INPUT_TYPES = new Set(["password", "file", "image"]);
const GLOBAL_ATTRIBUTES = new Set(["class", "id", "title", "lang", "dir", "role", "style", "hidden", "tabindex"]);
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  time: ["datetime"],
  ol: ["start", "reversed"],
  blockquote: ["cite"],
  q: ["cite"],
};
/** Attributes kept only with a value of their closed list, in lower case; any other value goes with the attribute. */
const ENUMERATED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  "a.target": new Set(["_blank", "_self", "_parent", "_top"]),
  "img.loading": new Set(["lazy", "eager"]),
  "img.decoding": new Set(["async", "sync", "auto"]),
};
/** The link types kept in `rel` of a link; `opener` is not one of them: a converted page never hands its window over. */
const LINK_RELS = new Set(["alternate", "author", "bookmark", "external", "help", "license", "me", "next", "nofollow", "noopener", "noreferrer", "prev", "search", "sponsored", "tag", "ugc"]);
/**
 * The mark of an image whose `width`, `height` or both the conversion wrote, and the rule that goes with it. An
 * attribute is a presentational hint: where the site's CSS gives an image only its width, a `height` in pixels would
 * stretch it. The rule has no specificity and comes first, so every rule of the site about the two properties wins, as
 * it won over nothing before; what is left of the attributes is the proportion the browser reserves while loading.
 */
const SIZED_MARK = "data-histos-sized";
const SIZED_CSS = `:where(img[${SIZED_MARK}~="width"]) { width: auto }\n:where(img[${SIZED_MARK}~="height"]) { height: auto }`;
const MAX_PAGES = 1_000;
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;
/** The importer's limits: more media, or a bigger one, and the whole prototype is refused. */
const MAX_ASSETS = 500;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
/** The DSL refuses deeper markup: past this, elements give way to their content. */
const MAX_DEPTH = 100;
/** parse5 slows down quadratically with nesting: a page nested deeper than this is not parsed at all. */
const MAX_PARSE_NESTING = 1_000;
/** All the CSS read (sheets and what they import), across the site: past it, sheets are not converted. */
const MAX_CSS_INPUT_BYTES = 8 * 1024 * 1024;
const VOID_HTML = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** CSS functions that load what their strings name: replaced, as url() written in other ways. */
const STRING_RESOURCE_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "image", "-webkit-image", "src"]);
const SITE_ORIGIN = "https://sito.invalid";
/** Event handler attributes (`onclick`…): they become listeners in the page's JavaScript (doc 18 §6.6). */
const EVENT_ATTRIBUTE = /^on[a-z]{2,30}$/iu;
/** Script types that are JavaScript; any other (`application/ld+json`, templates) is data, and goes. */
const SCRIPT_TYPES = new Set(["text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"]);
/** A dialog kept as a block (doc 18 §6.6) gets back the methods the site's scripts call on it. */
const DIALOG_SHIM = `for (const dialog of document.querySelectorAll("[data-histos-dialog]")) {
  dialog.show = dialog.showModal = function () { this.hidden = false; this.setAttribute("open", ""); };
  dialog.close = function () { this.hidden = true; this.removeAttribute("open"); };
}`;

/** True when Histeon CSS takes the design parameter `key` with `value`. */
function acceptsDesignValue(key: string, value: string): boolean {
  try {
    validateHistosDesign({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

function extension(path: string): string {
  return /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "";
}

/** A URL path decoded ("caf%C3%A9.html" → "café.html") without its leading slashes, or null when it is not valid UTF-8. */
function decodedPath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/u, "");
  } catch {
    return null;
  }
}

/** A CSS identifier with its escapes resolved ("u\72l" → "url"), in lower case: names are compared after it. */
function cssIdentifier(raw: string): string {
  return raw.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/gu, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? "";
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  }).toLowerCase();
}

/**
 * How deep the tags of a page nest, estimated from the text before parsing. Linear: a tag ends at the next "<" or
 * ">", so a page of unclosed "<a" costs one pass.
 */
function tagNesting(html: string): number {
  let depth = 0;
  let deepest = 0;
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/gu)) {
    const tag = (match[2] ?? "").toLowerCase();
    if (match[1]) depth = Math.max(0, depth - 1);
    else if (!(match[3] ?? "").endsWith("/") && !VOID_HTML.has(tag)) deepest = Math.max(deepest, ++depth);
  }
  return deepest;
}

/** The reference inside url(…) or a quoted string, or null when it is anything else. */
function referenceOf(node: ValueNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return node.value;
  if (node.type !== "function" || cssIdentifier(node.value) !== "url") return null;
  const inner = node.nodes.filter((child) => child.type !== "space");
  const only = inner[0];
  return inner.length === 1 && only && (only.type === "word" || only.type === "string") ? only.value : null;
}

function slugify(value: string, max = 63): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max).replace(/-+$/u, "");
}

/** A stable project id for a site: converting it again updates the same project (with "what changes"). */
export function staticSiteProjectId(siteId: string): string {
  const hex = sha256Hex(`histos-publish:site-conversion:${siteId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function attributeValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Counts per message, for the report: "12 × script tolto". */
class Notes {
  private readonly counts = new Map<string, number>();
  add(message: string, times = 1): void {
    this.counts.set(message, (this.counts.get(message) ?? 0) + times);
  }
  list(): string[] {
    return [...this.counts].sort((left, right) => right[1] - left[1]).map(([message, count]) => (count > 1 ? `${count} × ${message}` : message));
  }
}

/** An inline style that cannot load anything: no url(), image-set(), imports, comments, escapes or expressions. */
function harmlessStyle(value: string): boolean {
  return !/url\s*\(|image-set|cross-fade|element\s*\(|expression|@import|behavio|binding|javascript|vbscript|data\s*:|\/\*|\\|[{}<&]/iu.test(value);
}

/**
 * `tokens` (B4, the user's choice after seeing the proposal): values become Histeon CSS tokens and the proposal
 * becomes the project's `design`, with the Histeon CSS framework.
 */
/** How many remote media one conversion asks for. */
export const MAX_REMOTE_MEDIA = 300;

/** The patterns of doc 18 §6.6 and the recipe that does each without JavaScript (AI manual §6). */
const RECIPES: ReadonlyArray<{ name: string; recipe: string; test: (node: SiteElement) => boolean }> = [
  { name: "menu mobile", recipe: "un secondo menu dentro <details> (manuale AI §6.1)", test: (node) => node.tag === "button" && !hasHisteonBehaviour(node) && attributeIn(node, "aria-expanded") !== undefined && (attributeIn(node, "aria-controls") !== undefined || /menu|nav|toggle/iu.test(attributeIn(node, "class") ?? "")) },
  { name: "fisarmonica", recipe: "<details name> con lo stesso name (manuale AI §6)", test: (node) => /(?:^|\s)accordion(?:\s|$)/u.test(attributeIn(node, "class") ?? "") || attributeIn(node, "data-bs-toggle") === "collapse" },
  { name: "schede", recipe: "sezioni una sotto l'altra con un indice di ancore (manuale AI §6)", test: (node) => attributeIn(node, "role") === "tablist" && !hasHisteonBehaviour(node) },
  { name: "carosello", recipe: "una riga a scorrimento con scroll-snap (manuale AI §6.3)", test: (node) => /(?:^|\s)(?:swiper|carousel|slick-slider|splide|glide)(?:\s|$)/u.test(attributeIn(node, "class") ?? "") },
  { name: "finestra modale", recipe: "un link alla pagina o all'immagine (manuale AI §6)", test: (node) => attributeIn(node, "data-histos-dialog") !== undefined || /(?:^|\s)(?:modal|lightbox)(?:\s|$)/u.test(attributeIn(node, "class") ?? "") },
];

function attributeIn(node: SiteElement, name: string): string | undefined {
  return node.attrs.find(([key]) => key === name)?.[1];
}

/** «proposta: …» notes for the recipes the pages could use instead of their scripts, one per pattern found. */
function recipeProposals(pages: ReadonlyArray<{ nodes: SiteNode[] }>): string[] {
  const found = new Map<string, number>();
  const stack: SiteNode[] = pages.flatMap((page) => page.nodes);
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.kind !== "element") continue;
    for (const recipe of RECIPES) if (recipe.test(node)) found.set(recipe.name, (found.get(recipe.name) ?? 0) + 1);
    for (const child of node.children) stack.push(child);
  }
  return RECIPES.filter((recipe) => found.has(recipe.name)).map((recipe) => `proposta: ${recipe.name} (${found.get(recipe.name)}) funziona anche senza JavaScript, e nel builder, con ${recipe.recipe}; lo script del sito resta`);
}

/**
 * The element of a page that takes the classes only that page's <body> had: its <main>, else the first element that is
 * not the site's header, navigation or footer (those are the same on every page, and must stay so to become parts),
 * else the first element. null for a page without elements.
 */
function pageMark(nodes: readonly SiteNode[]): SiteElement | null {
  const elements = nodes.filter((node): node is SiteElement => node.kind === "element");
  return elements.find((element) => element.tag === "main") ?? elements.find((element) => !["header", "nav", "footer", "aside"].includes(element.tag)) ?? elements[0] ?? null;
}

export function staticSiteToPrototype(input: { projectId: string; name: string; files: readonly StaticSiteFile[]; extraStylesheets?: readonly string[]; tokens?: boolean; framework?: ImportFramework; /** Doc 28: the sizes written by hand stay exact, as the site's variables (a captured proposal). */ exact?: boolean; /** The files are a proposal captured without its scripts: the report says what waited for one («da rifare»). */ captured?: boolean; recipes?: boolean; structure?: StructureOptions; remoteMedia?: ReadonlyMap<string, Uint8Array>;
  /**
   * The design the caller already knows, for example the colors of a `kit proposte` proposal's :root. Each key that
   * validateHistosDesign accepts goes over the design read from the CSS; the others are dropped without a word.
   */
  design?: Readonly<Record<string, string>>;
  /**
   * Doc 23 item 109: where the app keeps the media of the site, by hash. With it the prototype names them by a
   * converted-media address instead of carrying them as base64, so a site with many images fits its 32 MB. The browser
   * converter of F6 has no such folder and keeps them inline.
   */
  holdMedia?: (bytes: Uint8Array, sha256: string) => void;
  /**
   * Doc 27: answers to the choices a previous conversion gave (`choices`), by id. Each one is used only where it fits
   * its rules and collides with nothing; the others are in `choicesRejected`. Alternative texts given here are applied:
   * the caller passes only the ones a person accepted.
   */
  choices?: Readonly<Record<string, string>>;
  /**
   * D5: whether the colours of a sheet of the page count for the brand colours of the design (`primary`, `secondary`).
   * `link` is a linked sheet (`href`: its path in the site, or the address of another site's), `style` a `<style>` of
   * the head (`href` empty); `id` is the element's id. A sheet it refuses is converted as any other. Without it, every
   * sheet counts.
   */
  brandSheet?: (sheet: StaticSiteSheetSource) => boolean }): StaticSitePrototype {
  const notes = new Notes();
  const book = new ImportChoiceBook(input.choices ?? {});
  const files = new Map<string, Uint8Array>();
  for (const file of input.files) {
    const path = file.path.replaceAll("\\", "/").replace(/^\/+/u, "");
    // The build keeps its own metadata in hidden folders: never part of the site.
    if (!path || path.split("/").some((segment) => segment.startsWith(".") || segment === "")) continue;
    files.set(path, file.bytes);
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // ---------------------------------------------------------------- pages and their new addresses
  const htmlPaths = [...files.keys()].filter((path) => /\.html?$/iu.test(path)).sort((left, right) => (left === "index.html" ? -1 : right === "index.html" ? 1 : left.localeCompare(right)));
  if (!htmlPaths.includes("index.html")) throw new TypeError("Il sito non ha una pagina index.html da usare come home.");
  const pageSlug = new Map<string, string>();
  const usedSlugs = new Set<string>();
  for (const path of htmlPaths) {
    const base = path.replace(/\.html?$/iu, "");
    if (base === "404" || base.endsWith("/404")) {
      notes.add("pagina 404 non convertita: il progetto ne ha una sua");
      continue;
    }
    if (pageSlug.size >= MAX_PAGES) {
      notes.add(`pagina oltre le prime ${MAX_PAGES} non convertita`);
      continue;
    }
    // Checked before any link points to it: a page parse5 would take minutes on is left out.
    if (tagNesting(decoder.decode(files.get(path) ?? new Uint8Array())) > MAX_PARSE_NESTING) {
      if (path === "index.html") throw new TypeError(`La home (index.html) ha markup annidato oltre ${MAX_PARSE_NESTING} livelli: non la converto.`);
      notes.add(`pagina con markup annidato oltre ${MAX_PARSE_NESTING} livelli non convertita: ${path.slice(0, 120)}`);
      continue;
    }
    let slug = base === "index" ? "home" : slugify(base.replace(/\/index$/iu, "")) || "pagina";
    if (slug === "home" && base !== "index") slug = "home-2";
    let unique = slug;
    for (let counter = 2; usedSlugs.has(unique); counter++) unique = `${slug.slice(0, 58).replace(/-+$/u, "")}-${counter}`;
    usedSlugs.add(unique);
    pageSlug.set(path, unique);
  }
  /** The site address of a page ("/chi-siamo/", "/chi-siamo.html", "/") → its address in the project. */
  const pageByAddress = new Map<string, string>();
  for (const [path, slug] of pageSlug) {
    const target = slug === "home" ? "/" : `/${slug}/`;
    const clean = `/${path}`.replace(/\.html?$/iu, "");
    for (const address of [`/${path}`, clean, `${clean}/`, clean.replace(/\/index$/iu, "/"), clean.replace(/\/index$/iu, "")]) if (address) pageByAddress.set(address, target);
  }

  // ---------------------------------------------------------------- media
  const assets: Array<{ name: string; data?: string; url?: string }> = [];
  const assetByKey = new Map<string, string>();
  /** The bytes of each asset, by name: the size of an image without width and height is read from them. */
  const assetBytes = new Map<string, Uint8Array>();
  const usedAssetNames = new Set<string>();
  const addAsset = (key: string, base: string, bytes: Uint8Array): string | null => {
    const known = assetByKey.get(key);
    if (known) return known;
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      notes.add("media oltre 15 MB tolto: alleggeriscilo e caricalo nel progetto");
      return null;
    }
    if (assets.length >= MAX_ASSETS) {
      notes.add(`media oltre i primi ${MAX_ASSETS} tolto: caricalo nel progetto`);
      return null;
    }
    let name = slugify(base, 50) || "media";
    if (!/^[a-z0-9]/u.test(name)) name = `m-${name}`;
    let unique = name;
    for (let counter = 2; usedAssetNames.has(unique); counter++) unique = `${name}-${counter}`;
    usedAssetNames.add(unique);
    assetByKey.set(key, unique);
    assetBytes.set(unique, bytes);
    if (input.holdMedia) {
      const hash = sha256Hex(bytes);
      input.holdMedia(bytes, hash);
      assets.push({ name: unique, url: convertedMediaUrl(hash) });
    } else assets.push({ name: unique, data: `data:${sniffPrototypeMedia(bytes)};base64,${base64FromBytes(bytes)}` });
    return unique;
  };
  /** The kind of media a byte string really is (the import checks it the same way), or null. */
  const mediaKind = (bytes: Uint8Array): "image" | "font" | null => {
    const type = sniffPrototypeMedia(bytes);
    return type === null ? null : type.startsWith("font/") ? "font" : "image";
  };
  /**
   * A media reference resolved against the file it appears in: a local image or font of the site, or an embedded
   * one, that really is of an allowed type; else null. Media of other sites (https) come from `remoteMedia`, which
   * the caller downloaded beforehand: the conversion itself never goes to the network, and a media that could not be
   * downloaded is left out with a note instead of stopping the whole import.
   */
  const remoteWanted = new Set<string>();
  /** A stylesheet downloaded from another site resolves its own references against its address. */
  const baseFor = (fromPath: string): string => fromPath.startsWith("https://") ? fromPath : `${SITE_ORIGIN}/${fromPath}`;
  /** A stylesheet of another site (https): its text when the caller downloaded it, else asked for. */
  const remoteStylesheet = (url: URL): string | null => {
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const bytes = input.remoteMedia?.get(url.href);
    if (!bytes) {
      if (remoteWanted.size < MAX_REMOTE_MEDIA) remoteWanted.add(url.href);
      return null;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  };
  const mediaFor = (reference: string, fromPath: string, kinds: ReadonlySet<"image" | "font">): string | null => {
    const value = reference.trim();
    if (!value) return null;
    if (/^data:/iu.test(value)) {
      const match = /^data:[a-z0-9.+/-]+;base64,([A-Za-z0-9+/=\s]+)$/iu.exec(value);
      if (!match) return null;
      const bytes = bytesFromBase64(match[1] ?? "");
      if (!bytes) return null;
      const kind = mediaKind(bytes);
      return kind && kinds.has(kind) ? addAsset(`data:${sha256Hex(bytes)}`, "incorporato", bytes) : null;
    }
    let resolved: URL;
    try {
      resolved = new URL(value, baseFor(fromPath));
    } catch {
      return null;
    }
    if (resolved.origin !== SITE_ORIGIN) {
      // Another site's media: its bytes when the caller downloaded them, else asked for (doc 18 §6.2).
      if (resolved.protocol !== "https:" || resolved.username || resolved.password) return null;
      const remote = input.remoteMedia?.get(resolved.href);
      if (!remote) {
        if (remoteWanted.size < MAX_REMOTE_MEDIA) remoteWanted.add(resolved.href);
        return null;
      }
      const remoteKind = mediaKind(remote);
      if (!remoteKind || !kinds.has(remoteKind)) return null;
      return addAsset(`remote:${resolved.href}`, (decodedPath(resolved.pathname)?.split("/").at(-1) ?? "media").replace(/\.[a-z0-9]+$/iu, "") || "media", remote);
    }
    const path = decodedPath(resolved.pathname);
    const bytes = path === null ? undefined : files.get(path);
    const kind = bytes ? mediaKind(bytes) : null;
    if (path === null || !bytes || !kind || !kinds.has(kind)) return null;
    return addAsset(`file:${path}`, (path.split("/").at(-1) ?? "media").replace(/\.[a-z0-9]+$/iu, ""), bytes);
  };

  // ---------------------------------------------------------------- CSS
  const stylesheets: CssCleanupSheet[] = [];
  const stylesheetKeys = new Set<string>();
  const IMAGE_OR_FONT: ReadonlySet<"image" | "font"> = new Set(["image", "font"]);
  /** CSS kept so far, across all sheets: past the prototype's own limit the conversion stops early. */
  let cssBytes = 0;
  /** CSS read so far, imports included (MAX_CSS_INPUT_BYTES). */
  let cssInputBytes = 0;
  const googleFonts = new Set<string>();
  const fontsDownloaded = (input.extraStylesheets?.length ?? 0) > 0;
  /** A Google Fonts stylesheet is remembered: B5 can download its fonts. */
  const isGoogleFonts = (url: URL): boolean => {
    if (url.protocol !== "https:" || url.hostname !== "fonts.googleapis.com" || !/^\/css2?$/u.test(url.pathname)) return false;
    if (googleFonts.size < 16) googleFonts.add(url.href);
    return true;
  };
  /**
   * A CSS value with every resource function rewritten: url() of a local image or font, or embedded, becomes the
   * project media, and a static SVG drawing embedded in the sheet stays embedded (css-inline-svg.ts); any other url(),
   * image-set() and src() becomes none. Function names are compared with their escapes
   * resolved, so "u\72l(…)" is a url() too. Null when the value cannot be read (it is then dropped).
   */
  const rewriteValue = (value: string, fromPath: string): string | null => {
    if (!/[(\\]/u.test(value)) return value;
    try {
      const parsed = valueParser(value);
      parsed.walk((node) => {
        if (node.type !== "function") return;
        const name = cssIdentifier(node.value);
        if (name === "url") {
          const reference = referenceOf(node);
          const asset = reference === null ? null : mediaFor(reference, fromPath, IMAGE_OR_FONT);
          // A drawing the sheet carries in itself (a grain, a wave) is no media of the project: static, it stays.
          const drawing = asset || reference === null ? null : staticInlineSvg(reference);
          if (drawing) notes.add("disegno SVG incorporato nel CSS tenuto: è statico, non carica e non esegue niente");
          else if (!asset) notes.add("riferimento url() del CSS non portabile, sostituito con none");
          Object.assign(node, { type: "word", value: asset ? `url("asset:${asset}")` : drawing ? `url("${drawing}")` : "none" });
          return false;
        }
        if (STRING_RESOURCE_FUNCTIONS.has(name) || node.value.includes("\\")) {
          notes.add(`${name.slice(0, 40)}() del CSS non portabile, sostituito con none`);
          Object.assign(node, { type: "word", value: "none" });
          return false;
        }
        return undefined;
      });
      return parsed.toString();
    } catch {
      // Nesting too deep for the parser: the value goes.
      return null;
    }
  };
  /**
   * A sheet parsed and rewritten (comments go, resources become media), with its local @import inlined: each file
   * once per sheet, up to 4 levels and 2 MB in all; other @import go. At-rules written with escapes go too, so
   * "@\69mport" cannot pass for something else. Null when the sheet is not CSS that can be read.
   */
  const rewriteSheet = (css: string, fromPath: string, budget: { inlined: Set<string>; bytes: number; limit: number }, depth: number): Root | null => {
    let root: Root;
    try {
      // A source map annotation is a comment, which goes anyway: taken out first, postcss never reads the map (Node
      // would, the browser cannot), so the conversion is the same in Publish and in WordPress (F6).
      root = postcss.parse(css.replace(/\/\*\s*[#@]\s*sourceMappingURL=[^*]*\*+\//gu, ""));
    } catch {
      return null;
    }
    root.walkComments((comment) => {
      comment.remove();
    });
    const imports: AtRule[] = [];
    root.walkAtRules((atRule) => {
      // postcss ends a name at its first escape ("@im\70ort" is "im" + "\70ort …"): either way it goes.
      if (atRule.name.includes("\\") || atRule.params.startsWith("\\")) {
        notes.add("regola @ scritta con escape tolta");
        atRule.remove();
        return;
      }
      if (atRule.name.toLowerCase() === "import") {
        imports.push(atRule);
        return;
      }
      if (atRule.params) {
        const params = rewriteValue(atRule.params, fromPath);
        if (params === null) atRule.remove();
        else atRule.params = params;
      }
    });
    root.walkDecls((declaration) => {
      const value = rewriteValue(declaration.value, fromPath);
      if (value === null) {
        notes.add("dichiarazione CSS illeggibile tolta");
        declaration.remove();
      } else declaration.value = value;
    });
    // Imports last: what they bring is already rewritten against its own file.
    for (const atRule of imports) {
      const inlined = atRule.parent?.type === "root" ? importedNodes(atRule, fromPath, budget, depth) : [];
      if (inlined.length) atRule.replaceWith(inlined);
      else atRule.remove();
    }
    return root;
  };
  const importedNodes = (atRule: AtRule, fromPath: string, budget: { inlined: Set<string>; bytes: number; limit: number }, depth: number): ChildNode[] => {
    let parsed: ValueNode[];
    try {
      parsed = valueParser(atRule.params).nodes.filter((node) => node.type !== "space" && node.type !== "comment");
    } catch {
      notes.add("@import illeggibile tolto");
      return [];
    }
    const reference = referenceOf(parsed[0]);
    let resolved: URL;
    try {
      if (reference === null) throw new TypeError("no reference");
      resolved = new URL(reference, baseFor(fromPath));
    } catch {
      notes.add("@import illeggibile tolto");
      return [];
    }
    if (isGoogleFonts(resolved)) {
      if (!fontsDownloaded) notes.add("Google Fonts collegati: si possono scaricare come media");
      return [];
    }
    if (resolved.origin !== SITE_ORIGIN) {
      // Another site's stylesheet: downloaded like its media (doc 18 §6.2), then read as part of this one.
      const remote = remoteStylesheet(resolved);
      if (remote !== null) {
        addStylesheet(`CSS di ${resolved.host}`.slice(0, 120), remote, resolved.href);
        return [];
      }
      notes.add(`@import esterno tolto (${resolved.host})`);
      return [];
    }
    const path = decodedPath(resolved.pathname);
    const imported = path !== null && extension(path) === "css" ? files.get(path) : undefined;
    if (path === null || !imported) {
      notes.add("@import CSS non trovato, tolto");
      return [];
    }
    if (budget.inlined.has(path)) {
      notes.add("@import ripetuto tolto: il foglio è già incluso");
      return [];
    }
    if (depth >= 4 || budget.bytes + imported.byteLength > budget.limit) {
      notes.add(depth >= 4 ? "@import oltre 4 livelli tolto" : "@import oltre 2 MB in tutto tolto");
      return [];
    }
    budget.inlined.add(path);
    budget.bytes += imported.byteLength;
    const child = rewriteSheet(decoder.decode(imported), path, budget, depth + 1);
    if (!child) {
      notes.add("@import di un foglio non leggibile come CSS tolto");
      return [];
    }
    // A condition after the address: a media query list keeps applying; layer() and supports() are not kept.
    const condition = valueParser.stringify(parsed.slice(1)).trim();
    if (!condition) return child.nodes.slice();
    if (/\b(?:layer|supports)\b|[{};\\]/iu.test(condition)) {
      notes.add("@import con layer() o supports() tolto");
      return [];
    }
    return [postcss.atRule({ name: "media", params: condition, nodes: child.nodes.slice() })];
  };
  const addStylesheet = (name: string, css: string, fromPath: string, source?: StaticSiteSheetSource): void => {
    const key = sha256Hex(css);
    if (stylesheetKeys.has(key)) return;
    stylesheetKeys.add(key);
    if (utf8Length(css) > MAX_STYLESHEET_BYTES) {
      notes.add("foglio di stile oltre 2 MB non convertito");
      return;
    }
    const size = utf8Length(css);
    if (cssInputBytes + size > MAX_CSS_INPUT_BYTES) {
      notes.add(`foglio di stile oltre ${MAX_CSS_INPUT_BYTES / 1024 / 1024} MB di CSS in tutto non convertito`);
      return;
    }
    const budget = { inlined: new Set([fromPath]), bytes: 0, limit: Math.min(MAX_STYLESHEET_BYTES, MAX_CSS_INPUT_BYTES - cssInputBytes - size) };
    const root = rewriteSheet(css, fromPath, budget, 0);
    cssInputBytes += size + budget.bytes;
    if (!root) {
      notes.add("foglio di stile non leggibile come CSS non convertito");
      return;
    }
    const rewritten = root.toString();
    cssBytes += utf8Length(rewritten);
    if (cssBytes > PROTOTYPE_MAX_BYTES) throw new RangeError(`I fogli di stile del sito superano ${PROTOTYPE_MAX_BYTES / 1024 / 1024} MB: il prototipo sarebbe oltre il limite.`);
    if (/<\/style/iu.test(rewritten)) {
      notes.add("foglio di stile con </style> non convertito");
      return;
    }
    const brand = source === undefined || input.brandSheet === undefined || input.brandSheet(source);
    stylesheets.push({ name: name.slice(0, 120) || "Foglio globale", css: rewritten, ...(brand ? {} : { brand: false as const }) });
  };

  // ---------------------------------------------------------------- scripts (doc 18 §6.6)
  /** The JavaScript each page keeps, in order, with where it came from; never run here. */
  const pageScripts = new Map<string, Array<{ from: string; code: string }>>();
  /** The `on*` attributes of each page, as addEventListener calls keyed by the element's mark. */
  const pageHandlers = new Map<string, Map<string, string>>();
  const dialogPages = new Set<string>();
  /**
   * An element's `on*` attributes become listeners in the page's JavaScript, found by a mark (`data-histos-js`) named
   * after what they do, so the same handler in the same header gets the same mark on every page (B3 sees one part).
   */
  const eventHandlers = (element: Element, fromPath: string): string | null => {
    const events = element.attrs.filter((attribute) => EVENT_ATTRIBUTE.test(attribute.name) && attribute.value.length <= 4000);
    if (!events.length) return null;
    const mark = `e${sha256Hex(JSON.stringify(events.map((attribute) => [attribute.name.toLowerCase(), attribute.value]))).slice(0, 12)}`;
    const handlers = pageHandlers.get(fromPath) ?? new Map<string, string>();
    pageHandlers.set(fromPath, handlers);
    if (!handlers.has(mark)) {
      const listeners = events.map((attribute) => `  element.addEventListener(${JSON.stringify(attribute.name.toLowerCase().slice(2))}, function (event) {\n    if (function (event) {\n${attribute.value}\n    }.call(this, event) === false) event.preventDefault();\n  });`);
      handlers.set(mark, `for (const element of document.querySelectorAll('[data-histos-js="${mark}"]')) {\n${listeners.join("\n")}\n}`);
    }
    notes.add(`gestore di eventi portato nel JavaScript della pagina (addEventListener)`, events.length);
    return mark;
  };

  // ---------------------------------------------------------------- markup
  /** The classes the pages use: CSS for any other class is dead (B4). */
  const usedClasses = new Set<string>();
  /** Whether an image got a size from its file (SIZED_MARK): the sheet with SIZED_CSS is then added. */
  let sizedImages = false;
  const elementAttributes = (element: Element, fromPath: string): Array<[string, string]> | null => {
    const tag = element.tagName;
    const allowed = TAG_ATTRIBUTES[tag] ?? [];
    const out: Array<[string, string]> = [];
    let sourceAddress = "";
    const handler = eventHandlers(element, fromPath);
    if (handler) out.push(["data-histos-js", handler]);
    for (const attribute of element.attrs) {
      const name = attribute.name;
      let value = attribute.value;
      if (handler && EVENT_ATTRIBUTE.test(name)) continue;
      // `data-*` stays (doc 18 §6.1: states and variants of a component, read by its CSS and scripts), except the
      // names a transfer refuses: the ones script frameworks and libraries read as code (doc 23 item 172).
      const data = /^data-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && transferHtmlAttributeAllowed(tag, name);
      if (!GLOBAL_ATTRIBUTES.has(name) && !allowed.includes(name) && !/^aria-[a-z]+$/u.test(name) && !data) {
        notes.add(/^on/iu.test(name) ? "gestore di eventi tolto" : `attributo ${name.slice(0, 40)} tolto`);
        continue;
      }
      if (name === "style" && !harmlessStyle(value)) {
        notes.add("stile in linea con risorse o costrutti non portabili tolto");
        continue;
      }
      if (name === "href" || name === "cite") {
        const rewritten = linkFor(value, fromPath);
        if (rewritten === null) {
          notes.add(`link non portabile tolto`);
          continue;
        }
        value = rewritten;
      }
      if (name === "src") {
        sourceAddress = value.trim().slice(0, 160);
        const asset = mediaFor(value, fromPath, new Set(["image"] as const));
        if (!asset) {
          notes.add(/\.svg(?:[?#]|$)/iu.test(value) ? "immagine SVG tolta: le icone si scrivono in linea" : /^(?:https?:)?\/\//iu.test(value.trim()) ? "immagine di un altro sito tolta: caricala nel progetto" : "immagine mancante o in un formato non supportato tolta");
          return null;
        }
        value = `asset:${asset}`;
      }
      if ((name === "width" || name === "height" || name === "colspan" || name === "rowspan" || name === "start") && !/^[0-9]{1,5}$/u.test(value)) continue;
      if (name === "tabindex" && !/^-?[0-9]{1,3}$/u.test(value)) continue;
      const known = ENUMERATED_ATTRIBUTES[`${tag}.${name}`];
      if (known) {
        value = value.trim().toLowerCase();
        if (!known.has(value)) {
          notes.add(`attributo ${name} con un valore non noto tolto`);
          continue;
        }
      }
      if (tag === "a" && name === "rel") {
        value = [...new Set(value.toLowerCase().split(/\s+/u).filter((type) => LINK_RELS.has(type)))].join(" ");
        if (!value) continue;
      }
      if (name === "hidden") value = "";
      // Braces in an attribute read as a dynamic value in the importer, even escaped: they become parentheses.
      if (/[{}]/u.test(value)) {
        notes.add("graffe in un attributo sostituite con parentesi");
        value = value.replaceAll("{", "(").replaceAll("}", ")");
      }
      if (name === "class") for (const item of value.split(/\s+/u)) if (item) usedClasses.add(item);
      out.push([name, value]);
    }
    if (tag === "a" && out.some(([name, value]) => name === "target" && value === "_blank")) {
      // A new tab never gets the window that opened it: browsers imply it, older ones and other readers do not.
      const rel = out.find(([name]) => name === "rel");
      if (!rel) out.push(["rel", "noopener"]);
      else if (!/(?:^| )no(?:opener|referrer)(?: |$)/u.test(rel[1])) rel[1] = `${rel[1]} noopener`;
    }
    if (tag === "img") {
      // Doc 18 §6.2: an image without its size gets it from its file (no layout shift); one without alt gets alt="".
      // The size the page gives stays: the other one follows the file's proportions. What is written here is marked
      // (SIZED_MARK), so the page looks as it did without it.
      const src = out.find(([name]) => name === "src")?.[1] ?? "";
      const bytes = src.startsWith("asset:") ? assetBytes.get(src.slice("asset:".length)) : undefined;
      const given = (wanted: string): number | null => {
        const value = out.find(([name]) => name === wanted)?.[1];
        return value === undefined ? null : Number(value);
      };
      const width = given("width");
      const height = given("height");
      const size = bytes && (width === null || height === null) ? imageSize(bytes) : null;
      if (size) {
        const added: Array<[string, string]> = width !== null ? [["height", String(Math.round(width * size.height / size.width))]]
          : height !== null ? [["width", String(Math.round(height * size.width / size.height))]]
          : [["width", String(size.width)], ["height", String(size.height)]];
        // A side of 0 hides the image and says nothing of the other; past five digits the attribute would not pass.
        if (width !== 0 && height !== 0 && added.every(([, value]) => /^[0-9]{1,5}$/u.test(value))) {
          out.push(...added, [SIZED_MARK, added.map(([name]) => name).join(" ")]);
          sizedImages = true;
        }
      }
      if (!out.some(([name]) => name === "alt")) {
        // Doc 27: a choice, whose answer a person accepts; the text near the image is its only context.
        const title = element.attrs.find((attribute) => attribute.name === "title")?.value ?? "";
        const near = element.parentNode ? parsedText(element.parentNode as Node, 120) : "";
        const alt = src.startsWith("asset:") ? book.pickAlt(src.slice("asset:".length), [`file: ${sourceAddress}`, `pagina: ${fromPath}`, title ? `title: «${title.slice(0, 80)}»` : "", near ? `testo vicino: «${near}»` : ""].filter(Boolean).join("; ")) : "";
        out.push(["alt", alt]);
        if (!alt) notes.add("immagine senza testo alternativo: aggiunto alt vuoto, scrivilo se l'immagine dice qualcosa");
      }
    }
    return out;
  };
  /** A link of the site: to a converted page, an external http(s), mailto or tel address, or null. */
  const linkFor = (reference: string, fromPath: string): string | null => {
    const value = reference.trim();
    if (value.startsWith("#")) {
      if (/^#[A-Za-z][A-Za-z0-9_-]*$/u.test(value)) return value;
      // A bare "#" (a link a script answers) and a route only a script reads ("#/menu") stay links, to the top of the
      // page: without href an <a> is no link, and loses the look and the focus the site gives to its links.
      if (value !== "#") notes.add("link a una rotta di uno script (#/…) tenuto come link vuoto (#): collegalo alla sua pagina");
      return "#";
    }
    let resolved: URL;
    try {
      resolved = new URL(value, `${SITE_ORIGIN}/${fromPath}`);
    } catch {
      return null;
    }
    if (resolved.origin === SITE_ORIGIN) {
      const path = decodedPath(resolved.pathname);
      const target = path === null ? undefined : pageByAddress.get(`/${path}`);
      if (!target) return null;
      return `${target}${braceFree(resolved.search)}${/^#[A-Za-z][A-Za-z0-9_-]*$/u.test(resolved.hash) ? resolved.hash : ""}`;
    }
    // The URL parser leaves { and } in a query: the importer reads them as dynamic values.
    if (["http:", "https:"].includes(resolved.protocol) && !resolved.username && !resolved.password) return braceFree(resolved.href);
    if (["mailto:", "tel:"].includes(resolved.protocol)) return braceFree(value);
    return null;
  };
  const braceFree = (value: string): string => value.replaceAll("{", "%7B").replaceAll("}", "%7D");
  /** The text of a subtree, without recursion (sloppy markup can nest thousands of levels), skipping dropped tags. */
  const textOf = (root: Node): string => {
    let text = "";
    const stack: Node[] = [root];
    while (stack.length) {
      const node = stack.pop() as Node;
      if (node.nodeName === "#text") text += (node as DefaultTreeAdapterMap["textNode"]).value;
      else if ("tagName" in node && DROPPED_TAGS.has(node.tagName)) continue;
      else if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index] as Node);
    }
    return text;
  };
  /**
   * Forms, fields, buttons, `picture`, `details` and static SVG (doc 18 F2): each attribute stays only if the import's
   * own check accepts it, so the converted page always passes the import. An element its context refuses (a form in a
   * form, `source` outside `picture`) gives way to its children; a password, file or image field goes.
   */
  /**
   * Doc 28: a `fill` or a `stroke` written `var(--nome, ripiego)`. The SVG subset carries `var(--nome)` alone, so the
   * attribute used to go and the drawing lost its colour. Which of the two says the same is known only once every
   * sheet of the site is read (paintFallbacks below): the variable when the site declares it, else the fallback.
   */
  const pendingPaints: Array<{ node: SiteNode & { kind: "element" }; attribute: string; variable: string; fallback: string; ctx: TransferMarkupContext }> = [];
  const transferElement = (element: Element, fromPath: string, depth: number, ctx: TransferMarkupContext): SiteNode[] => {
    const tag = element.namespaceURI === SVG_NAMESPACE ? element.tagName : element.tagName.toLowerCase();
    const svg = element.namespaceURI === SVG_NAMESPACE;
    if (svg && !TRANSFER_SVG_TAGS.has(tag)) {
      notes.add(`<${tag.slice(0, 40)}> di un SVG tolto: resta il disegno statico`);
      return [];
    }
    const typeOf = element.attrs.find((attribute) => attribute.name === "type")?.value.trim().toLowerCase() ?? "";
    if (tag === "input" && DROPPED_INPUT_TYPES.has(typeOf)) {
      notes.add(`campo di tipo ${typeOf} tolto`);
      return [];
    }
    const children = (): SiteNode[] => depth >= MAX_DEPTH ? [] : element.childNodes.flatMap((child) => sanitize(child, fromPath, depth + 1, childContext(ctx, tag)));
    // The import resolves `asset:` references into media identities before this check: one stands in for them here.
    const resolved = (attributes: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, value.replace(/asset:[a-z0-9-]+/gu, "histos-media://00000000-0000-4000-8000-000000000000")]));
    const accepts = (attributes: Record<string, string>): boolean => {
      try {
        checkTransferElement(tag, resolved(attributes), ctx);
        return true;
      } catch (error) {
        // What needs every attribute (a form's action and method, a source's srcset) is checked once they are all known.
        if (error instanceof TransferMarkupError && tag === "form" && error.reason === "form" && !("action" in attributes && "method" in attributes)) return true;
        if (error instanceof TransferMarkupError && tag === "source" && !("srcset" in attributes) && /srcset/u.test(error.message)) return true;
        if (error instanceof TransferMarkupError) return false;
        throw error;
      }
    };
    const placed = (() => {
      try {
        checkTransferElement(tag, {}, ctx);
        return true;
      } catch (error) {
        if (error instanceof TransferMarkupError) return error.reason !== "context" && error.reason !== "tag";
        throw error;
      }
    })();
    if (!placed) {
      notes.add(`<${tag.slice(0, 40)}> fuori posto sostituito dal suo contenuto`);
      return children().filter((node) => !svg || node.kind !== "text");
    }
    const kept: Record<string, string> = {};
    const paints: Array<{ attribute: string; variable: string; fallback: string }> = [];
    const handler = eventHandlers(element, fromPath);
    if (handler && accepts({ "data-histos-js": handler })) kept["data-histos-js"] = handler;
    for (const attribute of element.attrs) {
      const name = attribute.name;
      let value = attribute.value;
      if (kept["data-histos-js"] && EVENT_ATTRIBUTE.test(name)) continue;
      if (name === "srcset") {
        const candidates = value.split(",").map((candidate) => candidate.trim()).filter(Boolean).flatMap((candidate) => {
          const [url = "", ...descriptor] = candidate.split(/\s+/u);
          const asset = mediaFor(url, fromPath, new Set(["image"] as const));
          const target = asset ? `asset:${asset}` : /^https:\/\//iu.test(url) ? url : null;
          return target ? [[target, ...descriptor].join(" ")] : [];
        });
        if (!candidates.length) continue;
        value = candidates.join(", ");
      }
      if (name === "class") for (const item of value.split(/\s+/u)) if (item) usedClasses.add(item);
      if (/[{}]/u.test(value)) value = value.replaceAll("{", "(").replaceAll("}", ")");
      // A family name in double quotes says the same in single ones, which the SVG subset carries.
      if (svg && name === "font-family") value = value.replaceAll('"', "'");
      const paint = svg && (name === "fill" || name === "stroke") ? PAINT_FALLBACK.exec(value.trim()) : null;
      if (paint) {
        value = `var(${paint[1]})`;
        if (accepts({ ...kept, [name]: value })) paints.push({ attribute: name, variable: paint[1] as string, fallback: (paint[2] as string).trim() });
      }
      if (accepts({ ...kept, [name]: value })) kept[name] = value;
      else notes.add(/^on/iu.test(name) ? "gestore di eventi tolto" : `attributo ${name.slice(0, 40)} di <${tag}> tolto`);
    }
    if (tag === "input" && !("type" in kept) && typeOf && typeOf !== "text") {
      notes.add(`campo di tipo ${typeOf.slice(0, 20)} tolto`);
      return [];
    }
    if (tag === "form") {
      // The browser sends a form without action to its own page, and without method as GET: written out here.
      kept.method ??= "get";
      if (!("action" in kept)) {
        const own = linkFor("", fromPath);
        if (own && accepts({ ...kept, action: own.split("#")[0] ?? own })) kept.action = own.split("#")[0] ?? own;
      }
      if (!accepts(kept) || !("action" in kept)) {
        notes.add("modulo senza un indirizzo d'invio valido: restano i campi, il modulo va collegato");
        return children();
      }
    }
    if (tag === "source" && !("srcset" in kept)) return [];
    // These hold elements only: their layout whitespace goes.
    const inner = ["picture", "select", "optgroup"].includes(tag) ? children().filter((node) => node.kind === "element") : children();
    // A picture without its image (one of another site, not downloaded) shows nothing: it goes, with the image's note.
    if (tag === "picture" && !inner.some((node) => node.kind === "element" && node.tag === "img")) return [];
    const node: SiteNode & { kind: "element" } = { kind: "element", tag, attrs: Object.entries(kept), children: inner };
    for (const paint of paints) if (pendingPaints.length < MAX_PAINT_FALLBACKS) pendingPaints.push({ node, ...paint, ctx });
    return [node];
  };
  /** A node of a page, sanitized: what stays of it (an unknown tag gives way to its children). */
  const sanitize = (node: Node, fromPath: string, depth = 0, ctx: TransferMarkupContext = TRANSFER_ROOT_CONTEXT): SiteNode[] => {
    if (node.nodeName === "#text") {
      // Inside an SVG drawing only `title`, `desc`, `text` and `tspan` hold text: the rest is layout whitespace.
      if (ctx.svg && !TRANSFER_SVG_TEXT_PARENTS.includes(ctx.parent ?? "")) return [];
      return [{ kind: "text", text: (node as DefaultTreeAdapterMap["textNode"]).value }];
    }
    if (!("tagName" in node)) return [];
    const element = node as Element;
    const tag = element.tagName;
    if (element.namespaceURI === SVG_NAMESPACE || TRANSFER_NEW_HTML_TAGS.has(tag)) return transferElement(element, fromPath, depth, ctx);
    if (tag === "dialog") {
      // Doc 18 §6.6: a dialog is no transferable markup. It stays a block with its content (hidden while closed), and
      // the page's JavaScript gives it back showModal() and close() (DIALOG_SHIM).
      const attrs = elementAttributes({ ...element, tagName: "div", attrs: element.attrs.filter((attribute) => attribute.name !== "open") }, fromPath) ?? [];
      if (!attrs.some(([name]) => name === "role")) attrs.push(["role", "dialog"]);
      if (!element.attrs.some((attribute) => attribute.name === "open") && !attrs.some(([name]) => name === "hidden")) attrs.push(["hidden", ""]);
      attrs.push(["data-histos-dialog", ""]);
      dialogPages.add(fromPath);
      notes.add("<dialog> tenuto come blocco nascosto: il JavaScript della pagina gli ridà showModal() e close()");
      const inner = depth >= MAX_DEPTH ? [] : element.childNodes.flatMap((child) => sanitize(child, fromPath, depth + 1, childContext(ctx, "div")));
      return [{ kind: "element", tag: "div", attrs, children: inner }];
    }
    if (DROPPED_TAGS.has(tag)) {
      if (tag === "style") addStylesheet(`Stili di ${fromPath}`, element.childNodes.map((child) => ("value" in child ? child.value : "")).join(""), fromPath);
      // A script's text is kept in the page's JavaScript section (doc 18 §6.6), not in the markup.
      else if (tag !== "script") notes.add(`<${tag}> tolto`);
      return [];
    }
    if (depth >= MAX_DEPTH) {
      notes.add(`markup annidato oltre ${MAX_DEPTH} livelli ridotto al suo testo`);
      return [{ kind: "text", text: textOf(element) }];
    }
    const children = element.childNodes.flatMap((child) => sanitize(child, fromPath, depth + 1, KEPT_TAGS.has(tag) ? childContext(ctx, tag) : ctx));
    if (!KEPT_TAGS.has(tag)) {
      notes.add(`<${tag.slice(0, 40)}> sostituito dal suo contenuto`);
      return children;
    }
    const attrs = elementAttributes(element, fromPath);
    if (attrs === null) return [];
    // `wbr` and `kbd` are inline markup of a text run only (TRANSFER_INLINE_TAGS, without attributes), never elements:
    // `wbr` loses its attributes, and a `kbd` with some (a class of its own) becomes the `span` that can carry them.
    if (tag === "wbr") return [{ kind: "element", tag, attrs: [], children: [] }];
    if (tag === "kbd" && attrs.length) {
      notes.add("<kbd> con attributi diventato <span>: Histeon tiene <kbd> solo nel testo, senza attributi");
      return [{ kind: "element", tag: "span", attrs, children }];
    }
    return [{ kind: "element", tag, attrs, children }];
  };

  /** Elements with the tag, in document order, without recursion. */
  const all = (root: Node, tag: string): Element[] => {
    const out: Element[] = [];
    const stack: Node[] = [root];
    while (stack.length) {
      const node = stack.pop() as Node;
      if ("tagName" in node && node.tagName === tag) out.push(node as Element);
      if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index] as Node);
    }
    return out;
  };
  const find = (root: Node, tag: string): Element | null => all(root, tag)[0] ?? null;

  // Downloaded fonts (B5) come first: the site's own sheets may override them.
  for (const path of input.extraStylesheets ?? []) {
    const extra = files.get(path);
    if (extra) addStylesheet("Font", decoder.decode(extra), path);
  }
  let locale: string | undefined;
  /** The text of the site's scripts (never run): the classes they name keep their names (doc 18 §6.4). */
  const scripts: string[] = [];
  /** Tailwind's browser build writes the CSS when the page runs: its classes have no rules to read here. */
  let tailwindInBrowser = false;
  const pageNodes: Array<{ slug: string; title: string; nodes: SiteNode[] }> = [];
  /** V5.3a: the classes of every page's <body> and <html> (their intersection); null before the first page. */
  const rootClasses: { body: Set<string> | null; html: Set<string> | null } = { body: null, html: null };
  const classesOf = (element: Element | null): Set<string> => new Set((element?.attrs.find((attribute) => attribute.name === "class")?.value ?? "").split(/\s+/u).filter(Boolean));
  const keepCommon = (key: "body" | "html", element: Element | null): Set<string> => {
    const classes = classesOf(element);
    const before = rootClasses[key];
    rootClasses[key] = before === null ? classes : new Set([...before].filter((name) => classes.has(name)));
    return classes;
  };
  /** The classes of each page's own <body> and <html>, in the order of `pageNodes`. */
  const pageRoots: Array<{ body: Set<string>; html: Set<string> }> = [];
  for (const [path, slug] of pageSlug) {
    const document = parseHtml(decoder.decode(files.get(path) ?? new Uint8Array()));
    const html = find(document, "html");
    const htmlClasses = keepCommon("html", html);
    const lang = html?.attrs.find((attribute) => attribute.name === "lang")?.value ?? "";
    if (slug === "home" && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(lang)) locale = lang.length === 2 ? `${lang}-${lang.toUpperCase()}` : lang;
    // Stylesheets of the page, in order: linked local files, then <style> in the head.
    for (const link of all(document, "link")) {
      const rel = link.attrs.find((attribute) => attribute.name === "rel")?.value.toLowerCase() ?? "";
      const href = link.attrs.find((attribute) => attribute.name === "href")?.value ?? "";
      const linkId = link.attrs.find((attribute) => attribute.name === "id")?.value ?? "";
      if (!rel.split(/\s+/u).includes("stylesheet")) continue;
      let resolved: URL;
      try {
        resolved = new URL(href, `${SITE_ORIGIN}/${path}`);
      } catch {
        continue;
      }
      const cssPath = decodedPath(resolved.pathname);
      const linked = resolved.origin === SITE_ORIGIN && cssPath !== null ? files.get(cssPath) : undefined;
      if (linked && cssPath !== null) addStylesheet(cssPath, decoder.decode(linked), cssPath, { kind: "link", href: cssPath, id: linkId });
      else if (isGoogleFonts(resolved)) {
        if (!fontsDownloaded) notes.add("Google Fonts collegati: si possono scaricare come media");
      } else {
        // Another site's stylesheet (a CDN): downloaded and kept, its unused rules go with the rest (B4).
        const remote = resolved.origin !== SITE_ORIGIN ? remoteStylesheet(resolved) : null;
        if (remote !== null) addStylesheet(`CSS di ${resolved.host}`.slice(0, 120), remote, resolved.href, { kind: "link", href: resolved.href, id: linkId });
        else notes.add(`foglio di stile esterno non convertito (${resolved.host || href.slice(0, 60)})`);
      }
    }
    // Doc 18 §6.6: the page's scripts are kept, in order, as text for its JavaScript section; none runs here.
    const kept = pageScripts.get(path) ?? [];
    pageScripts.set(path, kept);
    for (const [index, script] of all(document, "script").entries()) {
      const src = script.attrs.find((attribute) => attribute.name === "src")?.value;
      const type = script.attrs.find((attribute) => attribute.name === "type")?.value.trim().toLowerCase() ?? "";
      if (src !== undefined && /tailwind/iu.test(src)) tailwindInBrowser = true;
      if (type && !SCRIPT_TYPES.has(type)) {
        notes.add(`script di tipo ${type.slice(0, 40)} tolto: è un dato, non JavaScript`);
        continue;
      }
      let code: string | null = null;
      let from = `${path}, script ${index + 1}`;
      if (src === undefined) code = script.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
      else {
        let resolved: URL | null = null;
        try {
          resolved = new URL(src, `${SITE_ORIGIN}/${path}`);
        } catch {
          resolved = null;
        }
        const local = resolved?.origin === SITE_ORIGIN ? decodedPath(resolved.pathname) : null;
        if (resolved && local !== null) {
          const bytes = files.get(local);
          from = local;
          if (bytes) code = decoder.decode(bytes);
          else notes.add("script del sito non trovato, tolto");
        } else if (resolved?.protocol === "https:" && !resolved.username && !resolved.password) {
          // A library of a CDN: downloaded like the other files of other sites (doc 18 §6.2), then kept.
          from = resolved.href;
          const bytes = input.remoteMedia?.get(resolved.href);
          if (bytes) code = decoder.decode(bytes);
          else if (remoteWanted.size < MAX_REMOTE_MEDIA) remoteWanted.add(resolved.href);
        } else notes.add("script con un indirizzo non https tolto");
      }
      if (code === null || !code.trim()) continue;
      scripts.push(code);
      kept.push({ from, code });
    }
    const head = find(document, "head");
    if (head) for (const style of all(head, "style")) addStylesheet(`Stili di ${path}`, style.childNodes.map((child) => ("value" in child ? child.value : "")).join(""), path, { kind: "style", href: "", id: style.attrs.find((attribute) => attribute.name === "id")?.value ?? "" });
    const titleElement = find(document, "title");
    const title = (titleElement?.childNodes.map((child) => ("value" in child ? child.value : "")).join("") ?? "").replace(/\s+/gu, " ").trim().slice(0, 500) || slug;
    const body = find(document, "body");
    pageRoots.push({ body: keepCommon("body", body), html: htmlClasses });
    pageNodes.push({ slug, title, nodes: body ? body.childNodes.flatMap((child) => sanitize(child, path)) : [] });
  }

  // The paints written with a fallback, now that every sheet is here (pendingPaints).
  if (pendingPaints.length) {
    const pagesText = [...pageSlug.keys()].map((path) => decoder.decode(files.get(path) ?? new Uint8Array()));
    const known = new Map<string, boolean>();
    const declared = (variable: string): boolean => {
      let answer = known.get(variable);
      if (answer === undefined) {
        // `variable` is `--` and letters, digits, `_`, `-`: nothing a pattern reads as its own.
        const pattern = new RegExp(`(?:^|[;{\\s"'])${variable}\\s*:`, "u");
        answer = stylesheets.some((sheet) => pattern.test(sheet.css)) || pagesText.some((text) => pattern.test(text));
        known.set(variable, answer);
      }
      return answer;
    };
    const paintOf = (variable: string, fallback: string, depth = 0): string | null => {
      if (declared(variable)) return `var(${variable})`;
      const nested = PAINT_FALLBACK.exec(fallback);
      if (nested) return depth < 3 ? paintOf(nested[1] as string, (nested[2] as string).trim(), depth + 1) : null;
      const plain = /^var\(\s*(--[A-Za-z0-9_-]{1,64})\s*\)$/u.exec(fallback);
      if (plain) return declared(plain[1] as string) ? `var(${plain[1]})` : null;
      return fallback;
    };
    for (const { node, attribute, variable, fallback, ctx } of pendingPaints) {
      const at = node.attrs.findIndex(([name]) => name === attribute);
      if (at < 0) continue;
      const value = paintOf(variable, fallback);
      let accepted = value !== null;
      if (value !== null) {
        try {
          checkTransferElement(node.tag, { [attribute]: value }, ctx);
        } catch (error) {
          if (!(error instanceof TransferMarkupError)) throw error;
          accepted = false;
        }
      }
      if (accepted) node.attrs[at] = [attribute, value as string];
      else {
        node.attrs.splice(at, 1);
        notes.add(`attributo ${attribute} di <${node.tag}> tolto`);
      }
    }
  }

  // First of the sheets, so that it loses against every rule of the site (SIZED_MARK).
  if (sizedImages) stylesheets.unshift({ name: "Misure delle immagini", css: SIZED_CSS });

  // V5.3a: the rules on the classes of <body> and <html> reach no element of a converted page: written on the tags,
  // they keep the site's variables, colors and fonts. A class an element of a page uses too stays a class.
  const roots = { body: new Set([...rootClasses.body ?? []].filter((name) => !usedClasses.has(name))), html: new Set([...rootClasses.html ?? []].filter((name) => !usedClasses.has(name))) };
  // A class only some pages' body (or html) has cannot be written on the tag: its rules would reach every page. One
  // element of those pages takes it (pageMark) and the rules select «the body that has it inside».
  const onSomePages = (key: "body" | "html"): Set<string> => new Set(pageRoots.flatMap((page) => [...page[key]]).filter((name) => !rootClasses[key]?.has(name) && !usedClasses.has(name)));
  const pageBody = onSomePages("body");
  const pageHtml = onSomePages("html");
  let rootRules = 0;
  const marks = new Set<string>();
  for (const [index, sheet] of stylesheets.entries()) {
    const written = rootClassRules(sheet.css, { ...roots, pageBody, pageHtml });
    rootRules += written.rules;
    for (const name of written.marks) marks.add(name);
    if (written.rules) stylesheets[index] = { ...sheet, css: written.css };
  }
  if (rootRules) notes.add(`${rootRules} ${rootRules === 1 ? "regola scritta sulle classi di <body> o <html> riscritta" : "regole scritte sulle classi di <body> o <html> riscritte"} su body e html: la pagina convertita non ha quelle classi`);
  const marked = new Set<string>();
  for (const [index, page] of pageNodes.entries()) {
    const own = pageRoots[index];
    const mark = pageMark(page.nodes);
    if (!own || !mark) continue;
    // Only the classes a rule names: a body with twenty classes of its CMS does not pour them on the page.
    const given = [...new Set([...[...own.body].filter((name) => pageBody.has(name)), ...[...own.html].filter((name) => pageHtml.has(name))])].filter((name) => marks.has(name));
    if (!given.length) continue;
    const at = mark.attrs.findIndex(([key]) => key === "class");
    if (at < 0) mark.attrs.push(["class", given.join(" ")]);
    else mark.attrs[at] = ["class", [...(mark.attrs[at]?.[1] ?? "").split(/\s+/u).filter(Boolean), ...given].join(" ")];
    for (const name of given) marked.add(name);
  }
  if (marked.size) notes.add(`${marked.size === 1 ? "1 classe che il <body> ha solo in alcune pagine è passata" : `${marked.size} classi che il <body> ha solo in alcune pagine sono passate`} a un elemento di quelle pagine (${[...marked].sort().slice(0, 6).join(", ")}${marked.size > 6 ? ", …" : ""}): le loro regole scelgono la pagina con :has()`.slice(0, 400));

  // Doc 18 §6.6: patterns a recipe of the AI manual (§6) does without JavaScript are proposed, and the scripts stay;
  // when the user chooses the recipes, they replace the patterns and the page keeps no script.
  // Doc 28: a captured proposal has lost its scripts; its tabs and its phone menu get Histeon's own behaviours, which
  // leave the page as the proposal drew it. Before the proposals below, which are for what is left.
  if (input.captured === true) for (const note of applyProposalRecipes(pageNodes, stylesheets, [...(rootClasses.body ?? []), ...(rootClasses.html ?? []), ...pageRoots.flatMap((page) => [...page.body, ...page.html])]).notes) notes.add(note);
  const proposals = recipeProposals(pageNodes);
  const recipes = input.recipes === true;
  if (recipes) {
    const applied = applyRecipes(pageNodes);
    dropHandlerMarks(pageNodes);
    const done = [applied.menus ? `${applied.menus} menu` : "", applied.accordions ? `${applied.accordions} fisarmoniche` : "", applied.tabs ? `${applied.tabs} gruppi di schede` : "", applied.carousels ? `${applied.carousels} caroselli` : "", applied.modals ? `${applied.modals} finestre modali` : ""].filter(Boolean);
    notes.add(`ricette senza JavaScript applicate${done.length ? `: ${done.join(", ")}` : ""}; gli script del sito non sono tenuti`);
  } else for (const note of proposals) notes.add(input.captured === true ? note.replace(/; lo script del sito resta$/u, "; nella proposta fotografata lo script non c'è più: senza la ricetta non risponde") : note);
  // A captured proposal has no scripts left: what waited for one is listed, to be built again (decision of 13 November 2026).
  if (input.captured === true) for (const note of lostInteractions(pageNodes)) notes.add(note);

  // Doc 18 §6.4-§6.5: utility classes and inline styles become one BEM class per element, checked by the cascade.
  // Doc 23 item 101: the pages as they are before the conversion, for the screenshot check of the desktop app.
  const sheetsBefore = stylesheets.map((sheet) => sheet.css);
  const visualBefore = pageNodes.slice(0, UTILITY_VISUAL_CANDIDATES).map((page) => ({ page: page.slug, body: visualBody(page.nodes) }));
  const scriptClasses = scriptClassNames(scripts);
  const utilities = convertUtilityClasses(pageNodes, sheetsBefore, scriptClasses, { keepUnstyled: tailwindInBrowser, book });
  const utilityVisual = utilities.css ? utilityVisualPairs(visualBefore, (slug) => {
    const page = pageNodes.find((item) => item.slug === slug);
    return page ? visualBody(page.nodes) : undefined;
  }, sheetsBefore, [...sheetsBefore, utilities.css]) : [];
  if (tailwindInBrowser) notes.add("Tailwind caricato come script: il CSS nasce nel browser, le classi utility restano come sono");
  for (const note of utilities.notes) notes.add(note);
  if (utilities.css) stylesheets.push({ name: "Classi convertite dalle utility", css: utilities.css });
  // The classes in use, read again: converted utilities are gone from the pages, and their rules with them (B4).
  usedClasses.clear();
  const collectClasses = (node: SiteNode): void => {
    if (node.kind !== "element") return;
    for (const name of (node.attrs.find(([key]) => key === "class")?.[1] ?? "").split(/\s+/u)) if (name) usedClasses.add(name);
    for (const child of node.children) collectClasses(child);
  };
  for (const page of pageNodes) for (const node of page.nodes) collectClasses(node);

  // Doc 18 §6.3: an inline element a rule of the site styles gets a class, so the builder can select it. Doc 28: never
  // a name the site's own CSS already gives to something else (the names the utility step made are shared, as before).
  for (const name of classStyledInlineElements(pageNodes, inlineSelectors(stylesheets.map((sheet) => sheet.css)), { book, origin: utilities.origin, taken: scriptClasses, styled: styledClasses(sheetsBefore) })) usedClasses.add(name);

  // B3: parts, components and lists, only those the user chose; without a choice the pages stay as they are.
  const structured = structureSite(pageNodes, input.structure ?? {}, { book, origin: utilities.origin });
  for (const note of structured.notes) notes.add(note);
  const pages = structured.pages.map((page) => `<template data-histos="page" data-slug="${page.slug}" data-title="${attributeValue(page.title)}"${page.template ? ` data-template="${page.template}"` : ""}>\n${page.markup}\n</template>`);

  // B4: one style per class with its states and @media, globals for the rest, duplicates and dead rules gone.
  // Doc 18 §6.4.1: the user's framework; `tokens` is the older yes/no for Histeon CSS.
  const framework: ImportFramework = input.framework ?? (input.tokens === true ? "histos-css" : "none");
  const tokens = framework !== "none";
  const cleaned = cleanupCss({ sheets: stylesheets, usedClasses, framework, ...(input.exact === true ? { exact: true } : {}) });
  const design: Record<string, string> = { ...cssDesignParameters(cleaned) };
  for (const [key, value] of Object.entries(input.design ?? {})) {
    if (acceptsDesignValue(key, value)) design[key] = value;
  }
  for (const note of cleaned.notes) notes.add(note);
  // Doc 23 item 163: the site's breakpoints against Histeon's named media queries.
  for (const note of breakpointNotes([...cleaned.globals.map((sheet) => sheet.css), cleaned.selectors])) notes.add(note);
  // The prototype's manifest knows histos-css, acss and none: a Core site is "none", with Core's variables it uses
  // defined in a sheet of their own (css-cleanup.ts).
  if (framework === "core") notes.add("Core Framework: il prototipo resta senza framework Histeon; le variabili di Core usate sono definite in un foglio che Core, dove è attivo, sostituisce");
  for (const note of acssSiteNotes(usedClasses, cleaned.globals, cleaned.selectors)) notes.add(note);
  const selectorsCss = /<\/style/iu.test(cleaned.selectors) ? "" : cleaned.selectors;
  const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  // Doc 18 §6.6: each page's JavaScript section: the dialog methods, the site's scripts in order, then its on* handlers,
  // within the document limit of WordPress; what does not fit goes, with a note.
  const scriptsBySlug: Record<string, string> = {};
  let keptScripts = 0;
  for (const [path, slug] of recipes ? [] : pageSlug) {
    const pieces = [
      ...(dialogPages.has(path) ? [{ from: "Histeon: metodi dei dialog", code: DIALOG_SHIM }] : []),
      ...(pageScripts.get(path) ?? []),
      ...[...(pageHandlers.get(path)?.values() ?? [])].map((code) => ({ from: `${path}: attributi on*`, code })),
    ];
    const out: string[] = [];
    let bytes = 0;
    for (const piece of pieces) {
      const text = `/* ${piece.from.slice(0, 200).replaceAll("*/", "* /")} */\n${piece.code.replaceAll("\u0000", "\ufffd")}`;
      const size = utf8Length(text) + 2;
      if (bytes + size > DOCUMENT_SCRIPT_MAX_BYTES) {
        notes.add(`script oltre ${DOCUMENT_SCRIPT_MAX_BYTES / 1000} kB per pagina tolto: ${piece.from.slice(0, 120)}`);
        continue;
      }
      bytes += size;
      out.push(text);
      keptScripts++;
    }
    if (out.length) scriptsBySlug[slug] = out.join("\n\n");
  }
  if (keptScripts) notes.add(`${keptScripts} script tenuti nella sezione JS delle pagine: girano nel sito e nell'anteprima, mai nel builder`);
  const manifest = { format: "histos-prototype", version: 1, id: input.projectId, name: input.name.trim().slice(0, 120) || "Sito convertito", framework: framework === "core" ? "none" : framework, ...(framework === "acss" ? { acss: "keep" } : {}), ...(locale ? { locale } : {}), ...(tokens && framework !== "core" && Object.keys(design).length ? { design } : {}), ...(cleaned.siteTokens ? { siteTokens: cleaned.siteTokens } : {}) };
  const html = [
    "<!doctype html>",
    `<html lang="${attributeValue(locale?.slice(0, 2) ?? "it")}" data-histos-prototype="1">`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeText(manifest.name)}</title>`,
    `<script data-histos="manifest" type="application/json">${json(manifest)}</script>`,
    ...(assets.length ? [`<script data-histos="assets" type="application/json">${json(assets)}</script>`] : []),
    ...(structured.content ? [`<script data-histos="content" type="application/json">${json(structured.content)}</script>`] : []),
    ...(Object.keys(scriptsBySlug).length ? [`<script data-histos="scripts" type="application/json">${json({ pages: scriptsBySlug })}</script>`] : []),
    ...cleaned.globals.filter((sheet) => !/<\/style/iu.test(sheet.css)).map((sheet) => `<style data-histos="global" data-name="${attributeValue(sheet.name)}">\n${sheet.css}\n</style>`),
    ...(selectorsCss ? [`<style data-histos="selectors">\n${selectorsCss}\n</style>`] : []),
    "</head>",
    "<body>",
    ...structured.documents,
    ...pages,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const bytes = utf8Length(html);
  if (bytes > PROTOTYPE_MAX_BYTES) {
    throw new RangeError(`Il prototipo del sito sarebbe di ${Math.ceil(bytes / 1024 / 1024)} MB, oltre il limite di ${PROTOTYPE_MAX_BYTES / 1024 / 1024} MB: alleggerisci le immagini o converti una parte del sito.`);
  }
  return { html, report: { pages: pages.length, assets: assets.length, stylesheets: cleaned.globals.length, notes: notes.list() }, googleFonts: [...googleFonts], design, tokens, framework, exact: input.exact === true && tokens && framework !== "core", siteTokens: cleaned.siteTokens ?? {}, recipes, recipesAvailable: proposals.length > 0 || recipes, structure: structured.proposal, structureApplied: { parts: input.structure?.parts === true, components: input.structure?.components === true, lists: input.structure?.lists === true }, remoteMedia: [...remoteWanted], utilityVisual, choices: book.choices, choicesRejected: book.rejected };
}
