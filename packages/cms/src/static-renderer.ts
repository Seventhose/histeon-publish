import { createHash } from "node:crypto";
import { inlineHtml } from "./article-document.js";
import { compileCss, findClosingBrace, GROUP_BY_FIELD_PATTERN, GROUP_BY_HOW_PATTERN, INLINE_FORMAT, loopElse, parseBlockGrammar, parseExpression, parseXb, resolveNamedQueries, serializeXb, VOID_ELEMENTS, type Expr, type ParsedBlock, type XbBlock } from "../.generated/histos-dsl/index.js";
import { decodeHTMLAttribute } from "entities";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import parseSrcset from "parse-srcset";
import { CMS_ARCHIVE_PAGE_SIZE, CMS_MAX_RELATION_DEPTH, POST_TYPE_KEY } from "./content-model.js";
import type { CmsComponent, CmsComponentSchema, Repository } from "./project-repository.js";
import { productImage, productNode } from "./commerce.js";
import { PRODUCT_TYPE_KEY } from "@histos-publish/histos-contract";
import { HISTOS_DESIGN_DEFAULTS, computeHistosTokens, histosClassOffPatterns, histosContrast, histosDesignCss, histosPreviewCss, changedHistosDesign, validateHistosDesign, validateHistosTokenOverrides, validateSiteTokens, type HistosContrastPair, type HistosDesign } from "./histos-design.js";
import { frameworkDataWithExternalCss, histosGlobalCss, histosTokenNames, stylesData, type CmsStylesData } from "./histos-css.js";
import { assertCssResourcesBundled, rewriteCssAssetUrls, type CssAssetReference } from "./css-resources.js";
import { FONT_SHEET_ID } from "./local-fonts.js";
import {
  checkTransferChildren,
  checkTransferElement,
  checkTransferText,
  childContext,
  inlineStyleLoadsResources,
  isSafeFormAction,
  textareaText,
  TRANSFER_ROOT_CONTEXT,
  TRANSFER_SVG_TAGS,
  TransferMarkupError,
  transferChildKind,
  type TransferMarkupContext,
} from "./transfer-markup.js";

const STATIC_TAGS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "bdi", "bdo", "blockquote", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
  "em", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "input", "ins", "kbd", "label", "legend", "li", "main",
  "map", "mark", "menu", "meter", "nav", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section", "select", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot",
  "textarea", "th", "thead", "time", "tr", "track", "u", "ul", "var", "video", "wbr",
]);
// formmethod, formenctype and formtarget would override what the <form> declares (its method rule included), and
// form would attach a control to another form of the page. SVG is not in STATIC_TAGS: inline SVG goes through the
// strict subset of transfer-markup.ts (histos-transfer-markup-v1), never through xb/raw.
const BLOCKED_ATTRIBUTES = new Set(["formaction", "formmethod", "formenctype", "formtarget", "form", "srcdoc", "nonce", "integrity", "crossorigin", "xmlns", "is"]);
const STATIC_WORDPRESS_BLOCKS = new Set([
  "core/audio", "core/button", "core/buttons", "core/code", "core/column", "core/columns", "core/cover", "core/file", "core/gallery", "core/group",
  "core/heading", "core/html", "core/image", "core/list", "core/list-item", "core/paragraph", "core/pullquote", "core/quote", "core/separator",
  "core/spacer", "core/table", "core/verse", "core/video",
]);
const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled", "formnovalidate", "hidden", "inert",
  "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected",
]);
const MAX_RENDER_NODES = 50_000;
const MAX_RENDER_WORK_BYTES = 32 * 1024 * 1024;
const MAX_RENDER_HTML_BYTES = 32 * 1024 * 1024;
const MAX_COMPONENT_DEPTH = 16;

/**
 * Runtime features the standalone CMS renderer actually implements. Keep the API bootstrap in sync. The static SVG
 * subset, picture/source, details/summary and textarea text follow histos-transfer-markup-v1 (transfer-markup.ts).
 */
export const CMS_RUNTIME_CAPABILITIES = Object.freeze({
  blocks: Object.freeze([
    "xb/element", "xb/text", "xb/if", "xb/branch", "xb/loop", "xb/component", "xb/slot", "xb/slot-fill",
    "xb/raw", "xb/passthrough", "xb/post-content",
  ]),
  expressions: Object.freeze([
    "literals", "identifiers", "member-access", "index-access", "arrays", "objects", "conditionals", "comparisons",
    "logical", "ternary", "dynamic-props", "registered-modifiers", "local-loops", "query-presets", "json-sources",
  ]),
  modifiers: Object.freeze([
    "upper", "lower", "capitalize", "trim", "inline", "stripTags", "truncateWords", "truncateChars", "date", "number", "length",
    "first", "last", "join", "slice", "includes", "pluck", "groupBy", "default", "json", "slug",
  ]),
  forms: Object.freeze({
    staticEndpoints: true,
    methods: Object.freeze(["get", "post"]),
    actionSchemes: Object.freeze(["https", "same-origin-relative"]),
    buildRequiresActionAndMethod: true,
    previewSubmissions: false,
  }),
  limits: Object.freeze({
    componentDepth: MAX_COMPONENT_DEPTH,
    blockDepth: 64,
    loopDepth: 6,
    loopItems: 1_000,
    relationDepth: CMS_MAX_RELATION_DEPTH,
    relationRecordsPerQuery: 1_000,
    renderedNodes: MAX_RENDER_NODES,
    workBytes: MAX_RENDER_WORK_BYTES,
    htmlBytes: MAX_RENDER_HTML_BYTES,
  }),
});

/**
 * The letters a date() format reads (PHP's date(), cmsDate below): any other ASCII letter stops the render, and a `\`
 * before a character prints that character as written. One list for the renderer and the prototype check, which reads
 * every literal format before the build (prototype-expressions.ts).
 */
export const CMS_DATE_FORMAT_LETTERS: ReadonlySet<string> = new Set("dDjlNSwzWFmMntLoYyaABgGhHisuveIOPTZcrU");

/**
 * The text date() reads as a date (parseCmsDate): a day, maybe a time to the millisecond and a zone. Any other non-blank
 * text stops the render; a number is a timestamp. Shared with the prototype check, which reads literal dates.
 */
export const CMS_DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/iu;

export interface RenderedCmsPage {
  html: string;
  css: string;
  globalCss: string;
  styleCss: string;
  formCount: number;
  assets: Array<{ id: string; sha256: string; mimeType: string; filename: string; bytes: Uint8Array }>;
}

function unsupported(message: string): never {
  const error = new Error(message);
  Object.assign(error, { code: "cms-capability-unavailable", status: 422 });
  throw error;
}

function htmlText(value: string): string {
  return value.replace(/&(?!(?:[a-z][a-z0-9]+|#\d+|#x[\da-f]+);)/giu, "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * An attribute value as the browser will read it, written back with every special character escaped. Validation
 * always looks at this decoded value: `javascript&colon;` or `java&Tab;script:` are `javascript:` to the browser,
 * so they must be checked as such and never re-emitted as live entities.
 */
function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Decodes the entities of an attribute written in the document source (not of one parse5 has already decoded). */
function decodedAttribute(value: string): string {
  return decodeHTMLAttribute(value);
}

/**
 * What the URL parser sees: browsers drop ASCII tab and newline anywhere and C0 controls and spaces at either end,
 * so `java\tscript:` and ` javascript:` are both `javascript:`.
 */
function urlForSchemeCheck(value: string): string {
  const withoutBreaks = value.replace(/[\t\n\r]/gu, "");
  let start = 0;
  let end = withoutBreaks.length;
  while (start < end && withoutBreaks.charCodeAt(start) <= 0x20) start++;
  while (end > start && withoutBreaks.charCodeAt(end - 1) <= 0x20) end--;
  return withoutBreaks.slice(start, end);
}

function safeFormAction(tag: string, value: string): string {
  if (tag !== "form") return unsupported("L’attributo action è ammesso soltanto su <form>.");
  if (!isSafeFormAction(value)) return unsupported("L’endpoint del modulo deve essere un percorso del sito o un URL HTTPS senza spazi, credenziali o frammenti.");
  return value;
}

function validateFormAttributes(tag: string, attributes: Map<string, string | true>, requireFormEndpoints: boolean): void {
  const action = attributes.get("action");
  const method = attributes.get("method");
  if (action !== undefined) {
    if (typeof action !== "string") unsupported("L’endpoint del modulo deve essere un URL statico.");
    safeFormAction(tag, action);
  }
  if (method !== undefined) {
    if (tag !== "form") unsupported("L’attributo method è ammesso soltanto su <form>.");
    if (typeof method !== "string" || /[{}]/u.test(method) || !["get", "post"].includes(method.toLowerCase())) {
      unsupported("Il metodo del modulo deve essere GET o POST e non può essere dinamico.");
    }
  }
  if (tag === "form" && requireFormEndpoints) {
    if (action === undefined || action === "") unsupported("Prima di creare la build, imposta l’endpoint del modulo: un percorso del sito o un URL HTTPS.");
    if (method === undefined || method === "") unsupported("Prima di creare la build, scegli GET o POST per ogni modulo.");
  }
}

function safeInlineStyle(value: string): string {
  if (inlineStyleLoadsResources(value)) return unsupported("Lo stile HTML contiene una risorsa o un comportamento attivo non supportato.");
  return value;
}

/** A violation of the transferable markup becomes the renderer's capability error, with the same message. */
function markupChecked(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof TransferMarkupError) unsupported(error.message);
    throw error;
  }
}

/**
 * Free HTML (an xb/raw block, a preserved WordPress block) is checked by nothing else before it reaches a published
 * page, so the two shapes of a phishing form stop the build here: a password field, and a form that sends what is
 * typed to another site (an absolute URL or `//host`). A structured form of the builder keeps its HTTPS endpoint: it
 * is declared, checked by the transfer and listed in the report («cms-form-endpoint-unverified»).
 */
function freeHtmlChecked(tag: string, attributes: Map<string, string | true>): void {
  const type = attributes.get("type");
  if (tag === "input" && typeof type === "string" && type.trim().toLowerCase() === "password") {
    unsupported("L’HTML libero contiene un campo password: un sito statico non deve raccogliere password. Toglilo, o usa un modulo del builder verso un servizio che le gestisce.");
  }
  const action = attributes.get("action");
  if (tag === "form" && typeof action === "string") {
    const target = urlForSchemeCheck(action).replace(/\\/gu, "/");
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("//")) {
      unsupported("Un modulo nell’HTML libero invia i dati a un altro sito: usa un modulo del builder, che dichiara l’endpoint e passa dai controlli, oppure un percorso di questo sito.");
    }
  }
}

async function renderSanitizedHtmlFragment(
  value: string,
  visit: (node: DefaultTreeAdapterMap["childNode"]) => void,
  resolveAttribute: (name: string, value: string) => Promise<string>,
  requireFormEndpoints: boolean,
  onForm: () => void,
): Promise<string> {
  const fragment = parseFragment(value, { scriptingEnabled: false });
  const renderNode = async (node: DefaultTreeAdapterMap["childNode"]): Promise<string> => {
    visit(node);
    if ("value" in node) return htmlText(node.value);
    if ("data" in node) return "";
    if ("name" in node && node.nodeName === "#documentType") return unsupported("Il frammento HTML non può contenere una dichiarazione DOCTYPE.");
    if (!("tagName" in node) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      return unsupported("Il frammento HTML contiene un nodo non supportato.");
    }
    const tag = node.tagName.toLowerCase();
    if (!STATIC_TAGS.has(tag)) return unsupported(`Il frammento HTML contiene l’elemento <${tag}> non supportato.`);
    if (tag === "form") onForm();
    const attributes: string[] = [];
    const checkedAttributes = new Map<string, string | true>();
    for (const attribute of node.attrs) {
      const name = attribute.name.toLowerCase();
      if (!/^[a-z_:][a-z0-9:_.-]*$/u.test(name) || /^on/iu.test(name) || BLOCKED_ATTRIBUTES.has(name)) {
        return unsupported(`Il frammento HTML contiene l’attributo ${name} non supportato.`);
      }
      if (BOOLEAN_ATTRIBUTES.has(name)) {
        checkedAttributes.set(name, true);
        attributes.push(name);
        continue;
      }
      const safeValue = await resolveAttribute(name, attribute.value);
      checkedAttributes.set(name, safeValue);
      attributes.push(`${name}="${htmlAttribute(safeValue)}"`);
    }
    validateFormAttributes(tag, checkedAttributes, requireFormEndpoints);
    freeHtmlChecked(tag, checkedAttributes);
    const renderedAttributes = attributes.length ? ` ${attributes.join(" ")}` : "";
    if (VOID_ELEMENTS.has(tag)) {
      if (node.childNodes.length) return unsupported(`L’elemento HTML vuoto <${tag}> contiene figli.`);
      return `<${tag}${renderedAttributes}>`;
    }
    const children: string[] = [];
    for (const child of node.childNodes) children.push(await renderNode(child));
    return `<${tag}${renderedAttributes}>${children.join("")}</${tag}>`;
  };
  const rendered: string[] = [];
  for (const node of fragment.childNodes) rendered.push(await renderNode(node));
  return rendered.join("");
}

const EMPTY_SCOPE: Record<string, unknown> = Object.freeze(Object.create(null) as Record<string, unknown>);

function valueString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return new Intl.NumberFormat("en-US", { useGrouping: false, minimumFractionDigits: 0, maximumFractionDigits: 10 }).format(value);
  }
  if (Array.isArray(value)) return value.filter((item) => ["string", "number", "boolean"].includes(typeof item)).map(valueString).join(", ");
  return "";
}

function valueTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (typeof value === "number" && Number.isNaN(value)) return false;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function valueEquals(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && Object.hasOwn(right, key) && valueEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function compareValues(op: string, left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : left >= right;
  if (typeof left === "string" && typeof right === "string") {
    const comparison = Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
    return op === "<" ? comparison < 0 : op === "<=" ? comparison <= 0 : op === ">" ? comparison > 0 : comparison >= 0;
  }
  return false;
}

function memberValue(target: unknown, key: string | number): unknown {
  if (!target || typeof target !== "object") return null;
  const property = String(key);
  // PHP arrays have no synthetic `length` member; keep WP and CMS scopes aligned.
  if (Array.isArray(target) && property === "length") return null;
  if (["__proto__", "prototype", "constructor"].includes(property) || !Object.hasOwn(target, property)) return null;
  return (target as Record<string, unknown>)[property];
}

function isNumericValue(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed);
}

function isPhpTrimCharacter(code: number): boolean {
  return code === 0 || code === 9 || code === 10 || code === 11 || code === 13 || code === 32;
}

function phpJsonEncode(value: unknown): string {
  const encoded = JSON.stringify(value) ?? "null";
  // Match UTF-16 code units separately so astral characters become the same
  // surrogate-pair escapes emitted by PHP's json_encode/wp_json_encode.
  return encoded.replace(/[\/\u007f-\uffff]/g, (character) => {
    if (character === "/") return "\\/";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

const WP_ACCENT_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "Æ": "AE", "æ": "ae", "Œ": "OE", "œ": "oe", "ß": "s", "ẞ": "s", "Ø": "O", "ø": "o",
  "Đ": "D", "đ": "d", "Ð": "D", "ð": "d", "Þ": "TH", "þ": "th", "Ł": "L", "ł": "l",
  "Ŧ": "T", "ŧ": "t", "Ħ": "H", "ħ": "h", "ı": "i", "’": "", "‘": "", "“": "", "”": "",
  "„": "", "‟": "", "‹": "", "›": "", "…": "", "©": "", "®": "", "™": "", "°": "",
  "¡": "", "¿": "", "×": "x", "–": "-", "—": "-", "−": "-",
});

function wpSlug(value: string): string {
  let title = value.replace(/<[^>]*>/gu, "").replace(/[\u00a0\u2011\u2013\u2014]/gu, "-");
  title = Array.from(title, (character) => WP_ACCENT_EXCEPTIONS[character] ?? character).join("").normalize("NFD").replace(/\p{M}+/gu, "");
  title = Array.from(title, (character) => character.codePointAt(0)! > 0x7f
    ? [...Buffer.from(character, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")
    : character).join("").toLowerCase();
  title = title.replace(/%([a-f\d]{2})/giu, "---$1---").replaceAll("%", "").replace(/---([a-f\d]{2})---/giu, "%$1");
  title = title.replaceAll("/", "-").replace(/&.+?;/gu, "").replaceAll(".", "-");
  return title.replace(/[^%a-z0-9 _-]/gu, "").replace(/\s+/gu, "-").replace(/-+/gu, "-").replace(/^-+|-+$/gu, "");
}

function phpTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPhpTrimCharacter(value.charCodeAt(start))) start += 1;
  while (end > start && isPhpTrimCharacter(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function phpTrimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && isPhpTrimCharacter(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

/** An expression's value from its text, as a page would compute it: for the parity test with Histeon's vectors. */
export function evaluateCmsExpression(source: string, scope: Record<string, unknown>, locale = "en-US", timeZone = "UTC"): unknown {
  return expressionValue(parseExpression(source), scope, locale, timeZone);
}

function expressionValue(expression: Expr, scope: Record<string, unknown>, locale = "en-US", timeZone = "UTC"): unknown {
  switch (expression.type) {
    case "Literal": return expression.value;
    case "Identifier":
      return Object.hasOwn(scope, expression.name) ? scope[expression.name] : null;
    case "Member": {
      return memberValue(expressionValue(expression.object, scope, locale, timeZone), expression.property);
    }
    case "Index": {
      const target = expressionValue(expression.object, scope, locale, timeZone);
      const index = expressionValue(expression.index, scope, locale, timeZone);
      return typeof index === "string" || (typeof index === "number" && Number.isInteger(index)) ? memberValue(target, index) : null;
    }
    case "Unary": return !valueTruthy(expressionValue(expression.argument, scope, locale, timeZone));
    case "Conditional": return expressionValue(valueTruthy(expressionValue(expression.test, scope, locale, timeZone)) ? expression.consequent : expression.alternate, scope, locale, timeZone);
    case "Binary": {
      const left = expressionValue(expression.left, scope, locale, timeZone);
      if (expression.op === "??") return left ?? expressionValue(expression.right, scope, locale, timeZone);
      if (expression.op === "||") return valueTruthy(left) || valueTruthy(expressionValue(expression.right, scope, locale, timeZone));
      if (expression.op === "&&") return valueTruthy(left) && valueTruthy(expressionValue(expression.right, scope, locale, timeZone));
      const right = expressionValue(expression.right, scope, locale, timeZone);
      switch (expression.op) {
        case "==": return valueEquals(left, right);
        case "!=": return !valueEquals(left, right);
        case "<": case "<=": case ">": case ">=": return compareValues(expression.op, left, right);
      }
      return unsupported(`L’operatore ${expression.op} non è supportato nel runtime CMS M2.`);
    }
    case "Array": return expression.elements.map((element) => expressionValue(element, scope, locale, timeZone));
    case "Object": {
      const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const property of expression.properties) value[property.key] = expressionValue(property.value, scope, locale, timeZone);
      return value;
    }
    case "Call": {
      if (expression.callee.type !== "Member") return unsupported("Le espressioni CMS ammettono solo modifier registrati, senza chiamate libere.");
      const subject = expressionValue(expression.callee.object, scope, locale, timeZone);
      const args = expression.args.map((argument) => expressionValue(argument.value, scope, locale, timeZone));
      return applyCmsModifier(expression.callee.property, subject, args, locale, timeZone);
    }
  }
}

/** What `value.inline()` gives: a text reduced to its inline formats, the one value printed unescaped. */
class InlineHtml {
  constructor(readonly html: string) {}
}

function applyCmsModifier(name: string, subject: unknown, args: unknown[], locale = "it-IT", timeZone = "UTC"): unknown {
  const text = valueString(subject);
  const integer = (value: unknown, fallback: number): number => isNumericValue(value) ? Math.trunc(Number(value)) : fallback;
  const chars = (value: string): string[] => Array.from(value);
  switch (name) {
    case "upper": return text.toLocaleUpperCase("und");
    case "inline": return new InlineHtml(inlineHtml(text));
    case "lower": return text.toLocaleLowerCase("und");
    case "capitalize": { const parts = chars(text); return parts.length ? parts[0]!.toLocaleUpperCase("und") + parts.slice(1).join("") : ""; }
    case "trim": return phpTrim(text);
    case "stripTags": return phpTrim(text.replace(/<[^>]*>/gu, ""));
    case "truncateWords": {
      const words = phpTrim(text.replace(/<[^>]*>/gu, "")).split(/\s+/u).filter(Boolean);
      const limit = Math.max(0, integer(args[0], 55));
      return words.length > limit ? words.slice(0, limit).join(" ") + valueString(args[1] ?? "…") : words.join(" ");
    }
    case "truncateChars": {
      const clean = phpTrim(text.replace(/<[^>]*>/gu, "")); const points = chars(clean); const limit = Math.max(0, integer(args[0], 140));
      return points.length > limit ? phpTrimEnd(points.slice(0, limit).join("")) + valueString(args[1] ?? "…") : clean;
    }
    case "date": return cmsDate(subject, args[0] === undefined ? "Y-m-d" : valueString(args[0]), locale, timeZone);
    case "number": {
      const decimals = Math.max(0, integer(args[0], 0)); const number = isNumericValue(subject) ? Number(subject) : 0;
      if (decimals > 100) return unsupported("Il numero di decimali supera il limite supportato dal runtime CMS (100).");
      return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true }).format(Number.isFinite(number) ? number : 0);
    }
    case "length": return subject && typeof subject === "object" ? Object.keys(subject).length : (subject === null || subject === undefined ? 0 : chars(text).length);
    case "first": return Array.isArray(subject) ? subject[0] ?? null : (subject && typeof subject === "object" ? Object.values(subject)[0] ?? null : null);
    case "last": return Array.isArray(subject) ? subject.at(-1) ?? null : (subject && typeof subject === "object" ? Object.values(subject).at(-1) ?? null : null);
    case "join": return Array.isArray(subject) ? subject.map(valueString).join(valueString(args[0] ?? ", ")) : text;
    case "slice": {
      const start = integer(args[0], 0); const length = args[1] === undefined ? undefined : integer(args[1], 0);
      const source = Array.isArray(subject) ? subject : chars(text);
      const normalizedStart = start < 0 ? Math.max(source.length + start, 0) : Math.min(start, source.length);
      const end = length === undefined ? source.length : length < 0 ? Math.max(source.length + length, normalizedStart) : Math.min(normalizedStart + length, source.length);
      const sliced = source.slice(normalizedStart, end);
      return Array.isArray(subject) ? sliced : sliced.join("");
    }
    case "includes": return Array.isArray(subject) ? subject.some((item) => valueEquals(item, args[0] ?? null)) : text.includes(valueString(args[0] ?? ""));
    case "pluck": return Array.isArray(subject) ? subject.map((item) => memberValue(item, valueString(args[0] ?? ""))) : [];
    case "groupBy": {
      // Doc 23 item 118, as Histeon's Modifiers::groupBy: groups in the list's order, key by value, first letter
      // ("letter") or date format (any other text), each {key, items}.
      if (!Array.isArray(subject)) return [];
      const path = valueString(args[0] ?? "").split(".").filter(Boolean);
      const how = args[1] === undefined ? "" : valueString(args[1]);
      const groups = new Map<string, { key: string; items: unknown[] }>();
      for (const item of subject.slice(0, 2000)) {
        const value = path.reduce<unknown>((target, part) => memberValue(target, part), item);
        let key: string;
        if (how === "letter") {
          const first = (Array.from(phpTrim(valueString(value)))[0] ?? "").toLocaleUpperCase("und");
          key = /^\p{L}$/u.test(first) ? first : "#";
        } else key = how ? valueString(cmsDate(value, how, locale, timeZone)) : valueString(value);
        if (!groups.has(key)) groups.set(key, { key, items: [] });
        groups.get(key)!.items.push(item);
      }
      return [...groups.values()];
    }
    case "default": return valueTruthy(subject) ? subject : (args[0] ?? null);
    case "json": return phpJsonEncode(subject);
    case "slug": return wpSlug(text);
    default: return unsupported(`Il modificatore ${name} non è supportato nel runtime CMS M2.`);
  }
}

interface CmsWallTime { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }

function utcMillis(parts: CmsWallTime): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

/**
 * A date formatter for these options, made once: building one costs far more than formatting, and a build prints
 * dates on every post. Formatters never change; the cache is bounded, since the zone and locale come from settings.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= 256) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

function wallParts(date: Date, timeZone: string): CmsWallTime {
  const formatter = dateFormatter("en-US-u-ca-gregory-nu-latn", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute),
    second: Number(parts.second), millisecond: date.getUTCMilliseconds(),
  };
}

function sameWallTime(left: CmsWallTime, right: CmsWallTime): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute && left.second === right.second && left.millisecond === right.millisecond;
}

function resolveLocalWallTime(parts: CmsWallTime, timeZone: string): Date | null {
  const target = utcMillis(parts);
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 6) {
    const probe = target + hour * 60 * 60 * 1000;
    const instant = new Date(probe);
    offsets.add(utcMillis(wallParts(instant, timeZone)) - probe);
  }
  const exact: number[] = [];
  const afterGap: Array<{ instant: number; difference: number }> = [];
  for (const offset of offsets) {
    const instant = target - offset;
    const actualWall = utcMillis(wallParts(new Date(instant), timeZone));
    if (actualWall === target) exact.push(instant);
    else if (actualWall > target) afterGap.push({ instant, difference: actualWall - target });
  }
  // When the wall time occurs twice, PHP's DateTime chooses the later (standard-time) occurrence.
  if (exact.length) return new Date(Math.max(...exact));
  // PHP normalizes a nonexistent spring-forward time by the size of the gap (02:30 becomes 03:30).
  afterGap.sort((left, right) => left.difference - right.difference || left.instant - right.instant);
  return afterGap[0] ? new Date(afterGap[0].instant) : null;
}

function parseCmsDate(subject: unknown, timeZone: string): Date | null {
  if (typeof subject === "number") {
    const timestamp = subject * 1000;
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }
  const text = valueString(subject).trim();
  if (!text) return null;
  const match = CMS_DATE_TEXT.exec(text);
  if (!match) return unsupported("Il modificatore data richiede un timestamp o una data ISO deterministica (YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss con fuso esplicito).");
  const [year, month, day, hour, minute, second, fraction] = match.slice(1, 8).map((part) => part === undefined ? 0 : Number(part));
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined || fraction === undefined) return null;
  const parts: CmsWallTime = { year, month, day, hour, minute, second, millisecond: Number(String(match[7] ?? "").padEnd(3, "0")) };
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const calendarCheck = new Date(utcMillis({ ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 }));
  if (calendarCheck.getUTCFullYear() !== year || calendarCheck.getUTCMonth() !== month - 1 || calendarCheck.getUTCDate() !== day) return null;
  const zone = match[8];
  if (zone) {
    if (zone.toUpperCase() !== "Z" && (!/^([+-])(\d{2}):?(\d{2})$/u.test(zone) || Number(zone.replace(/[^\d]/gu, "").slice(0, 2)) > 23 || Number(zone.replace(/[^\d]/gu, "").slice(2, 4)) > 59)) return null;
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.${String(parts.millisecond).padStart(3, "0")}${zone.includes(":") || zone.toUpperCase() === "Z" ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`}`;
    const instant = Date.parse(iso);
    return Number.isFinite(instant) ? new Date(instant) : null;
  }
  return resolveLocalWallTime(parts, timeZone);
}

function cmsDate(subject: unknown, format: string, locale: string, timeZone: string): string {
  const date = parseCmsDate(subject, timeZone);
  if (!date || !Number.isFinite(date.getTime())) return "";
  const current = wallParts(date, timeZone);
  const utcDate = new Date(utcMillis({ ...current, hour: 0, minute: 0, second: 0, millisecond: 0 }));
  const weekday = dateFormatter(locale, { timeZone, calendar: "gregory", weekday: "long" }).format(date);
  const shortWeekday = dateFormatter(locale, { timeZone, calendar: "gregory", weekday: "short" }).format(date);
  const monthName = dateFormatter(locale, { timeZone, calendar: "gregory", month: "long" }).format(date);
  const shortMonth = dateFormatter(locale, { timeZone, calendar: "gregory", month: "short" }).format(date);
  const dayIndex = utcDate.getUTCDay();
  const isoDay = dayIndex || 7;
  const dayOfYear = Math.floor((utcDate.getTime() - utcMillis({ year: current.year, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 })) / 86400000);
  const thursday = new Date(utcDate.getTime() + (4 - isoDay) * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = utcMillis({ year: isoYear, month: 1, day: 4, hour: 0, minute: 0, second: 0, millisecond: 0 });
  const weekOneMonday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * 86400000;
  const isoWeek = Math.floor((utcDate.getTime() - weekOneMonday) / (7 * 86400000)) + 1;
  const offsetSeconds = Math.round((utcMillis(current) - date.getTime()) / 1000);
  const offsetSign = offsetSeconds < 0 ? "-" : "+";
  const offsetAbsolute = Math.abs(offsetSeconds);
  const offsetHour = String(Math.floor(offsetAbsolute / 3600)).padStart(2, "0");
  const offsetMinute = String(Math.floor((offsetAbsolute % 3600) / 60)).padStart(2, "0");
  const offsetCompact = `${offsetSign}${offsetHour}${offsetMinute}`;
  const offsetColon = `${offsetSign}${offsetHour}:${offsetMinute}`;
  const timeZoneName = dateFormatter("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  const daysInMonth = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
  const leap = current.year % 4 === 0 && (current.year % 100 !== 0 || current.year % 400 === 0);
  const ordinal = current.day % 10 === 1 && current.day % 100 !== 11 ? "st" : current.day % 10 === 2 && current.day % 100 !== 12 ? "nd" : current.day % 10 === 3 && current.day % 100 !== 13 ? "rd" : "th";
  const localizedPeriod = dateFormatter(locale, { timeZone, hour: "numeric", hourCycle: "h12", dayPeriod: "short" }).formatToParts(date).find((part) => part.type === "dayPeriod")?.value ?? (current.hour < 12 ? "AM" : "PM");
  const period = localizedPeriod.toLocaleLowerCase(locale);
  const beats = Math.floor(((date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds() + 3600) % 86400) / 86.4);
  const tokens: Record<string, string> = {
    d: String(current.day).padStart(2, "0"), D: shortWeekday, j: String(current.day), l: weekday, N: String(isoDay), S: ordinal, w: String(dayIndex), z: String(dayOfYear),
    W: String(isoWeek).padStart(2, "0"), F: monthName, m: String(current.month).padStart(2, "0"), M: shortMonth, n: String(current.month), t: String(daysInMonth),
    L: leap ? "1" : "0", o: String(isoYear), Y: String(current.year).padStart(4, "0"), y: String(current.year % 100).padStart(2, "0"),
    a: period, A: period.toLocaleUpperCase(locale), B: String(beats).padStart(3, "0"), g: String(current.hour % 12 || 12), G: String(current.hour), h: String(current.hour % 12 || 12).padStart(2, "0"),
    H: String(current.hour).padStart(2, "0"), i: String(current.minute).padStart(2, "0"), s: String(current.second).padStart(2, "0"), u: `${String(current.millisecond).padStart(3, "0")}000`, v: String(current.millisecond).padStart(3, "0"),
    e: timeZone, I: isDaylightSaving(date, timeZone) ? "1" : "0", O: offsetCompact, P: offsetColon, T: timeZoneName, Z: String(offsetSeconds),
    c: `${String(current.year).padStart(4, "0")}-${String(current.month).padStart(2, "0")}-${String(current.day).padStart(2, "0")}T${String(current.hour).padStart(2, "0")}:${String(current.minute).padStart(2, "0")}:${String(current.second).padStart(2, "0")}${offsetColon}`,
    r: `${dateFormatter("en-GB", { timeZone, weekday: "short" }).format(date)}, ${String(current.day).padStart(2, "0")} ${dateFormatter("en-GB", { timeZone, month: "short" }).format(date)} ${current.year} ${String(current.hour).padStart(2, "0")}:${String(current.minute).padStart(2, "0")}:${String(current.second).padStart(2, "0")} ${offsetCompact}`,
    U: String(Math.floor(date.getTime() / 1000)),
  };
  let result = "";
  for (let i = 0; i < format.length; i++) {
    if (format[i] === "\\" && i + 1 < format.length) result += format[++i];
    else if (/[A-Za-z]/u.test(format[i]!) && !CMS_DATE_FORMAT_LETTERS.has(format[i]!)) return unsupported(`Il token data ${format[i]} non è supportato dal runtime CMS M2.`);
    else result += tokens[format[i]!] ?? format[i];
  }
  return result;
}

function isDaylightSaving(date: Date, timeZone: string): boolean {
  const current = timezoneOffsetSeconds(date, timeZone);
  const year = wallParts(date, timeZone).year;
  const january = timezoneOffsetSeconds(new Date(Date.UTC(year, 0, 15)), timeZone);
  const july = timezoneOffsetSeconds(new Date(Date.UTC(year, 6, 15)), timeZone);
  if (january === july) return false;
  const standard = Math.min(january, july);
  return current !== standard;
}

function timezoneOffsetSeconds(date: Date, timeZone: string): number {
  return Math.round((utcMillis(wallParts(date, timeZone)) - date.getTime()) / 1000);
}

function interpolationValue(value: unknown): string {
  if (value instanceof InlineHtml) return value.html.replace(/<[^>]*>/gu, "");
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return unsupported("Un oggetto non può essere interpolato direttamente nel testo.");
  return valueString(value);
}

function interpolatedText(value: string, scope?: Record<string, unknown>, locale = "en-US", timeZone = "UTC"): string {
  let out = "";
  const inlineStack: string[] = [];
  let textBuffer = "";
  const flushText = (): void => {
    if (textBuffer) out += htmlText(textBuffer);
    textBuffer = "";
  };
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (char === "\\" && (value.charAt(i + 1) === "{" || value.charAt(i + 1) === "}")) {
      textBuffer += value.charAt(i + 1);
      i++;
    } else if (char === "{") {
      if (!scope) return unsupported("Il testo contiene un’espressione senza scope.");
      const close = findClosingBrace(value, i);
      const expression = parseExpression(value, i + 1, close);
      flushText();
      const shown = expressionValue(expression, scope, locale, timeZone);
      out += shown instanceof InlineHtml ? shown.html : htmlText(interpolationValue(shown));
      i = close;
    } else if (char === "<") {
      if (!/[A-Za-z/]/u.test(value.charAt(i + 1))) {
        textBuffer += char;
        continue;
      }
      const end = value.indexOf(">", i + 1);
      if (end < 0) return unsupported("Il testo contiene markup inline non chiuso.");
      const token = value.slice(i, end + 1);
      const match = /^<\s*(\/?)\s*([a-z][a-z0-9]*)([\s\S]*?)>$/u.exec(token);
      const tag = match?.[2];
      const allowedAttributes = tag ? INLINE_FORMAT.get(tag) : undefined;
      if (!match || !tag || !allowedAttributes) return unsupported("Il testo contiene markup inline fuori dall’allowlist upstream.");
      flushText();
      const closing = match[1] === "/";
      const tail = match[3] ?? "";
      if (closing && tail.trim()) return unsupported(`Il tag di chiusura </${tag}> contiene attributi.`);
      const attributes: string[] = [];
      if (!closing) {
        let rest = tail;
        while (rest.trim()) {
          const whitespace = /^\s+/u.exec(rest)?.[0] ?? "";
          rest = rest.slice(whitespace.length);
          if (!rest) break;
          const attribute = /^([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"<>]*)"|'([^'<>]*)')/u.exec(rest);
          if (!attribute) return unsupported(`Il tag inline <${tag}> contiene un attributo non statico o non valido.`);
          const name = attribute[1]!.toLowerCase();
          const rawValue = attribute[3] ?? attribute[4] ?? "";
          if (!allowedAttributes.has(name) || /^on/iu.test(name) || BLOCKED_ATTRIBUTES.has(name) || /[{}]/u.test(rawValue)) return unsupported(`L’attributo ${name} non è ammesso su <${tag}> nel markup inline.`);
          const safeValue = safeUrlAttribute(name, decodedAttribute(rawValue));
          attributes.push(`${name}="${htmlAttribute(safeValue)}"`);
          rest = rest.slice(attribute[0].length);
        }
      }
      const selfClosing = tag === "br" || tag === "wbr";
      if (closing) {
        if (selfClosing || inlineStack.pop() !== tag) return unsupported(`Il markup inline <${tag}> non è bilanciato.`);
        out += `</${tag}>`;
      } else {
        out += `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
        if (!selfClosing) inlineStack.push(tag);
      }
      i = end;
    } else if (char === "}") {
      return unsupported("La pagina contiene una parentesi graffa non escapata.");
    } else textBuffer += char;
  }
  flushText();
  if (inlineStack.length) return unsupported(`Il markup inline <${inlineStack[inlineStack.length - 1]}> non è chiuso.`);
  return out;
}

interface ComponentRenderScope {
  values: Record<string, unknown>;
  slots: Map<string, { blocks: XbBlock[]; scope?: ComponentRenderScope }>;
  stack: string[];
  locale: string;
  timeZone: string;
  /** The page's own content written by a template's {@post-content}: what fails in it is the content's (cmsRenderOrigin). */
  content?: true;
  /** Inside a component instance, in the editor's canvas: the instance's uid, what a click there selects. */
  owner?: string;
  /** Inside a part of the page's template (its header, its footer), in the editor's canvas: the part's ref (doc 18 F5). */
  part?: string;
  /** How many loops hold this block (the limit is 6). Carried by the scope, so loops side by side never add up. */
  loops?: number;
}

/**
 * Where a render failed: the own content of the page or post being rendered, or the definition of the template, the
 * template part or the component whose blocks were rendering, by its ref. A slot's blocks are their caller's, a
 * component instance's props too; a loop's items are where the loop is.
 */
export type CmsRenderOrigin = { kind: "content" } | { kind: "template" | "part" | "component"; ref: string };

const renderOrigins = new WeakMap<object, CmsRenderOrigin>();

/**
 * Where the render that threw `error` failed (CmsRenderOrigin), for an error renderCmsPage threw while it rendered
 * blocks; undefined for one thrown before or after (a template that is missing, the styles).
 */
export function cmsRenderOrigin(error: unknown): CmsRenderOrigin | undefined {
  return typeof error === "object" && error !== null ? renderOrigins.get(error) : undefined;
}

function templateString(value: string, scope: Record<string, unknown>, locale: string, timeZone: string): string {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (char === "\\" && (value.charAt(i + 1) === "{" || value.charAt(i + 1) === "}")) {
      output += value.charAt(i + 1); i++;
    } else if (char === "{") {
      const close = findClosingBrace(value, i);
      output += valueString(expressionValue(parseExpression(value, i + 1, close), scope, locale, timeZone)); i = close;
    } else if (char === "}") return unsupported("Il template della prop contiene una parentesi graffa non escapata.");
    else output += char;
  }
  return output;
}

function componentProps(instance: Extract<XbBlock, { name: "xb/component" }>, component: CmsComponent, callerScope: Record<string, unknown>, locale: string, timeZone: string): Record<string, unknown> {
  const schema: CmsComponentSchema = component.schema;
  const supplied = instance.attrs.props ?? {};
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(schema.props, name)) return unsupported(`La prop ${name} non è definita nel componente ${component.ref}.`);
  const props: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, definition] of Object.entries(schema.props)) {
    const raw = supplied[name];
    let value: unknown;
    if (raw === undefined) value = definition.default;
    else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const propValue = raw as Record<string, unknown>;
      if (Object.keys(propValue).length !== 1) return unsupported(`Il valore dinamico della prop ${name} non è valido.`);
      if (typeof propValue.expr === "string") value = expressionValue(parseExpression(propValue.expr), callerScope, locale, timeZone);
      else if (typeof propValue.tpl === "string") value = templateString(propValue.tpl, callerScope, locale, timeZone);
      else return unsupported(`Il valore dinamico della prop ${name} non è valido.`);
    }
    else value = raw;
    if (value === undefined) continue;
    const valid = value === null || (definition.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : definition.type === "boolean" ? typeof value === "boolean"
        : ["string", "url", "image", "rich-text", "enum"].includes(definition.type) ? typeof value === "string"
          : definition.type === "array" ? Array.isArray(value)
            : definition.type === "object" ? !!value && typeof value === "object" && !Array.isArray(value) : false);
    if (!valid) return unsupported(`Il valore della prop ${name} non corrisponde al tipo ${definition.type}.`);
    if (definition.type === "enum" && definition.options?.length && !definition.options.includes(value as string)) return unsupported(`Il valore della prop ${name} non è tra le opzioni ammesse.`);
    props[name] = value;
  }
  return props;
}

function safeUrlAttribute(name: string, value: string): string {
  if (!/^(?:href|src|poster|xlink:href)$/iu.test(name)) return value;
  const trimmed = urlForSchemeCheck(value);
  if (/^(?:javascript|vbscript|data):/iu.test(trimmed)) return unsupported("La pagina contiene un URL attivo non supportato.");
  if (/^https?:\/\//iu.test(trimmed) || /^(?:#|mailto:|tel:)/iu.test(trimmed) || trimmed.startsWith("/")) return value;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed) || trimmed.startsWith("//")) return unsupported("La pagina contiene uno schema URL non supportato.");
  return value;
}

function mediaReference(value: string, projectId: string): string | null {
  const match = /^\/__cms-media\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/iu.exec(value);
  if (!match || match[1]?.toLowerCase() !== projectId.toLowerCase()) return null;
  return match[2] ?? null;
}

function cmsValuesWithMedia(typeKey: string, source: Record<string, unknown>, store: Repository, projectId: string, relationDepth = 0): Record<string, unknown> {
  const type = store.content.getType(typeKey);
  if (!type) return source;
  const mapped: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of type.fields) {
    if (!Object.hasOwn(source, field.key)) continue;
    const value = source[field.key];
    if (field.type === "asset") {
      const toUrl = (assetId: unknown): unknown => typeof assetId === "string" ? "/__cms-media/" + projectId + "/" + assetId : assetId;
      mapped[field.key] = Array.isArray(value) ? value.map(toUrl) : toUrl(value);
    } else if (field.type === "relation" && field.targetType && relationDepth < CMS_MAX_RELATION_DEPTH) {
      const mapTarget = (target: unknown): unknown => {
        if (!target || typeof target !== "object" || Array.isArray(target)) return target;
        const linked = target as Record<string, unknown>;
        const linkedFields = linked.fields && typeof linked.fields === "object" && !Array.isArray(linked.fields) ? linked.fields as Record<string, unknown> : null;
        return linkedFields ? { ...linked, fields: cmsValuesWithMedia(field.targetType!, linkedFields, store, projectId, relationDepth + 1) } : linked;
      };
      mapped[field.key] = Array.isArray(value) ? value.map(mapTarget) : mapTarget(value);
    }
  }
  return { ...source, ...mapped };
}

/**
 * The featured image of a post (doc 23 item 119) with the keys of the builder's ImageNode, so `{post.image.url}` reads
 * the same in Publish and on WordPress. The project does not keep the sides of an image: width, height, srcset and
 * sizes are null, as WordPress gives them for a file it cannot measure.
 */
export function postImageNode(assetId: unknown, store: Pick<Repository, "mediaAsset">, projectId: string): Record<string, unknown> | null {
  if (typeof assetId !== "string") return null;
  const asset = store.mediaAsset?.(assetId);
  if (!asset) return null;
  return { id: asset.id, url: `/__cms-media/${projectId}/${asset.id}`, width: null, height: null, alt: asset.alt, caption: asset.caption, title: asset.filename, srcset: null, sizes: null };
}

/**
 * A post without a template shows its featured image above its text (doc 23 item 177): an import from WordPress makes
 * no article template, and its posts used to carry the image in the text. Only what is rendered changes, never the
 * stored text; with a template, the template decides where `page.image` goes.
 */
export function postContentWithImage(content: string, assetId: unknown, hasTemplate: boolean, store: Pick<Repository, "mediaAsset">, projectId: string): string {
  if (hasTemplate) return content;
  const image = postImageNode(assetId, store, projectId);
  if (!image) return content;
  const block: XbBlock = { name: "xb/element", attrs: { uid: "featuredimg", tag: "img", attributes: { src: String(image.url), alt: String(image.alt ?? "") } }, children: [] } as unknown as XbBlock;
  return serializeXb([block]) + content;
}

export function queryItemWithMedia(value: unknown, store: Repository, projectId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (typeof item.typeKey !== "string") return item;
  const sourceValues = item.fields && typeof item.fields === "object" && !Array.isArray(item.fields)
    ? item.fields as Record<string, unknown>
    : item.values && typeof item.values === "object" && !Array.isArray(item.values) ? item.values as Record<string, unknown> : {};
  const fields = cmsValuesWithMedia(item.typeKey, sourceValues, store, projectId);
  const meta = item.meta && typeof item.meta === "object" && !Array.isArray(item.meta) ? item.meta as Record<string, unknown> : sourceValues;
  const mapped = { ...item, ...fields, fields, values: fields, meta: { ...meta, ...fields } };
  // A product (queue C6): `product` and its main image `image`, as the builder's PostNode and ProductNode give them.
  const commerce = item.typeKey === PRODUCT_TYPE_KEY ? store.commerceContext?.() : undefined;
  if (commerce) {
    const record = { typeKey: item.typeKey, slug: String(item.slug ?? ""), locale: String(item.locale ?? commerce.defaultLocale), title: String(item.title ?? ""), excerpt: typeof item.excerpt === "string" ? item.excerpt : "", values: sourceValues, terms: item.terms && typeof item.terms === "object" ? item.terms as Record<string, unknown> : {} };
    return { ...mapped, product: productNode(record, commerce, projectId), image: productImage(record, commerce, projectId) };
  }
  // A post's featured image (doc 23 item 119), as the builder's PostNode gives `image`.
  if (item.typeKey === POST_TYPE_KEY) return { ...mapped, image: postImageNode(item.imageAssetId, store, projectId) };
  return mapped;
}

export interface RenderContext {
  store: Repository;
  projectId: string;
  content: string;
  mediaBase?: string;
  /** The rules of the writer blocks even with none on the page: an editor that adds them needs them. */
  articleBlocks?: boolean;
  buildMediaDirectory?: string;
  rootComponentAlias?: number;
  templateRef?: string | null;
  page?: { id: string; title: string; slug: string; url: string; [key: string]: unknown };
  locale?: string;
  timeZone?: string;
  /** Require a working external action and an explicit GET/POST method for each form in a publishable build. */
  requireFormEndpoints?: boolean;
  /** `data.lingua` of this page (doc 20 §5.5), when the project has other languages. */
  lingua?: unknown;
  resolveQuery?: (presetId: string, args: Record<string, unknown>, locale: string) => Promise<unknown[]> | unknown[];
  /**
   * The page's main query, what `{#loop main() as item}` lists (the builder's built-in `main` preset, blocks.md §3):
   * given only for an archive (a type, a term with its descendants' contents, the posts index), as the records of the
   * page being written, already paged as WordPress pages it (CMS_ARCHIVE_PAGE_SIZE, newest first). Elsewhere (a page,
   * a post, a record, the 404) a main() loop is refused with its reason.
   */
  mainQuery?: () => Promise<unknown[]> | unknown[];
  /**
   * The editor's canvas only: every element carries `data-xb-uid`, the block the builder selects on hover and click
   * (inside a component, the instance's), as the WordPress renderer does for its canvas. Never for a build: the
   * annotation is the builder's own and a published page must not carry it.
   */
  annotate?: boolean;
}

/** WordPress SEO plugins cut an automatic description at about this many characters, on a word boundary. */
export const CMS_META_DESCRIPTION_MAX = 160;

/**
 * The `<meta name="description">` text of an excerpt: plain text (the excerpt is text, never markup), spaces folded,
 * at most CMS_META_DESCRIPTION_MAX code points, cut on a word boundary with "…" as the SEO plugins do on WordPress.
 * Empty when there is no excerpt: the tag is then left out. The caller escapes it for the attribute.
 */
export function cmsMetaDescription(excerpt: unknown): string {
  if (typeof excerpt !== "string") return "";
  // Controls never belong in an attribute; spaces of any kind fold into one.
  const text = excerpt.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= CMS_META_DESCRIPTION_MAX) return text;
  const head = characters.slice(0, CMS_META_DESCRIPTION_MAX - 1).join("");
  const space = head.lastIndexOf(" ");
  // A word longer than half the description is cut where the limit falls rather than dropped whole.
  const cut = space >= CMS_META_DESCRIPTION_MAX / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.!?\-–—]+$/u, "")}…`;
}

/** The path of a page address, "/festival/" from "/festival/" or "https://x.it/festival/?a=1"; null when there is none. */
export function urlPathOf(address: unknown): string | null {
  if (typeof address !== "string" || address === "") return null;
  if (address.startsWith("/") && !address.startsWith("//")) return address.split(/[?#]/u, 1)[0] || "/";
  try {
    return new URL(address).pathname || "/";
  } catch {
    return null;
  }
}

const compiledPageCss = new Map<string, { css: string; globalCss: string; styleCss: string }>();

export async function renderCmsPage(input: RenderContext): Promise<RenderedCmsPage> {
  const parsed = parseXb(input.content);
  const locale = input.locale ?? "en-US";
  const timeZone = input.timeZone ?? "UTC";
  const assets = new Map<string, RenderedCmsPage["assets"][number]>();
  const rootComponent = input.rootComponentAlias === undefined ? null : input.store.getComponentByAlias(input.rootComponentAlias);
  const querySources = input.store.content.listQuerySources();
  const rootProps: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (rootComponent) for (const [name, definition] of Object.entries(rootComponent.schema.props)) if (definition.default !== undefined) rootProps[name] = definition.default;
  const rootValues: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, {
    ...(rootComponent ? { props: rootProps, slots: Object.create(null) as Record<string, unknown> } : {}),
    data: Object.fromEntries(Object.entries(querySources).map(([name, source]) => [name, source.data])),
  });
  if (input.lingua) (rootValues.data as Record<string, unknown>).lingua = input.lingua;
  if (input.page) {
    rootValues.page = input.page;
    rootValues.this = input.page;
    // `url.path` as on WordPress (doc 23, item 189): there the path of the request, here the path of the page being
    // built, the same on a static site. A static page has no query string, so `url.query` does not exist.
    const path = urlPathOf(input.page.url);
    if (path !== null) rootValues.url = { path };
  }
  const rootScope: ComponentRenderScope = { values: rootValues, slots: new Map(), stack: rootComponent ? [rootComponent.ref] : [], locale, timeZone };
  let blocksToRender: XbBlock[] = parsed.blocks;
  let templateInstanceUid: string | null = null;
  if (input.templateRef) {
    const template = input.store.getTemplateByRef(input.templateRef);
    if (!template || !input.store.canUseTemplate(input.templateRef)) return unsupported(`Il template ${input.templateRef} non esiste oppure non contiene lo slot predefinito della pagina.`);
    if (!input.page) return unsupported(`Il template ${input.templateRef} richiede i dati della pagina per l’anteprima o la build.`);
    const identity = input.page.id.replaceAll("-", "").toLowerCase();
    templateInstanceUid = `cms${identity.slice(0, 13)}`;
    const slotUid = `slot${identity.slice(13, 25)}`;
    const templateInstance: XbBlock = {
      name: "xb/component",
      attrs: { uid: templateInstanceUid, ref: template.ref, props: { page: { expr: "page" } } },
      children: [{ name: "xb/slot-fill", attrs: { uid: slotUid, name: "default" }, children: parsed.blocks }],
    };
    blocksToRender = [templateInstance];
  }
  let renderedNodes = 0;
  let renderedWorkBytes = 0;
  let formCount = 0;
  let renderingPostContent = false;
  const hasRootExpressionScope = Boolean(input.page || rootComponent || input.lingua || Object.keys(querySources).length);
  const expressionValues = (scope?: ComponentRenderScope): Record<string, unknown> | undefined =>
    scope === rootScope && !hasRootExpressionScope ? undefined : scope?.values;

  const copyAsset = async (assetId: string): Promise<string> => {
    const file = await input.store.readAsset(assetId);
    if (!file) return unsupported("Il contenuto fa riferimento a un asset assente dal progetto.");
    assets.set(assetId, { id: file.metadata.id, sha256: file.metadata.sha256, mimeType: file.metadata.mimeType, filename: file.metadata.filename, bytes: file.bytes });
    const extension = extensionForMime(file.metadata.mimeType);
    const filename = `${file.metadata.sha256}.${extension}`;
    const relative = `media/${filename}`;
    if (input.buildMediaDirectory) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const target = path.join(input.buildMediaDirectory, filename);
      await mkdir(input.buildMediaDirectory, { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600, flag: "wx" }).catch(async (error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      });
      return `/${relative}`;
    }
    return `${input.mediaBase ?? ""}/${input.projectId}/${assetId}`;
  };

  const resolveMediaUrl = async (name: string, value: string): Promise<string> => {
    const safe = safeUrlAttribute(name, value);
    // An address of a document of the site, as `href`, is a media like an image in `src`.
    if (!(["src", "poster"].includes(name)) && !(name === "href" && safe.startsWith("/__cms-media/"))) return safe;
    const assetId = mediaReference(safe, input.projectId);
    if (assetId) return copyAsset(assetId);
    if (safe.startsWith("/__cms-media/")) return unsupported("Il contenuto usa un riferimento media di un altro progetto o non valido.");
    return safe;
  };

  const resolveStaticAttribute = async (name: string, value: string): Promise<string> => {
    if (name === "style") return safeInlineStyle(value);
    if (name === "srcset") {
      let candidates: ReturnType<typeof parseSrcset>;
      try { candidates = parseSrcset(value); }
      catch { return unsupported("L’attributo srcset non contiene un elenco di sorgenti valido."); }
      const formatted: string[] = [];
      for (const candidate of candidates) {
        const url = await resolveMediaUrl("src", candidate.url);
        const descriptors = [candidate.w === undefined ? "" : `${candidate.w}w`, candidate.h === undefined ? "" : `${candidate.h}h`, candidate.d === undefined ? "" : `${candidate.d}x`].filter(Boolean);
        formatted.push(`${url}${descriptors.length ? ` ${descriptors.join(" ")}` : ""}`);
      }
      return formatted.join(", ");
    }
    return resolveMediaUrl(name, value);
  };

  const sanitizeHtmlFragment = async (html: string): Promise<string> => {
    renderedWorkBytes += Buffer.byteLength(html, "utf8");
    if (renderedWorkBytes > MAX_RENDER_WORK_BYTES) return unsupported(`Il rendering supera il limite di ${MAX_RENDER_WORK_BYTES / 1024 / 1024} MiB di lavoro.`);
    return renderSanitizedHtmlFragment(html, () => {
      renderedNodes++;
      if (renderedNodes > MAX_RENDER_NODES) unsupported(`Il rendering supera il limite di ${MAX_RENDER_NODES} nodi.`);
    }, resolveStaticAttribute, input.requireFormEndpoints === true, () => { formCount++; });
  };

  const staticWordPressHtml = async (raw: string): Promise<string> => {
    let blocks: ParsedBlock[];
    try { blocks = parseBlockGrammar(raw); }
    catch { return unsupported("Il blocco WordPress conservato contiene una serializzazione non valida."); }
    if (blocks.length !== 1) return unsupported("Un blocco WordPress conservato deve contenere esattamente un blocco statico.");
    const reconstruct = (block: ParsedBlock, depth: number): string => {
      if (depth > 64) return unsupported("I blocchi WordPress conservati superano la profondità massima di 64.");
      if (block.blockName !== null && !STATIC_WORDPRESS_BLOCKS.has(block.blockName)) {
        return unsupported(`Il blocco WordPress ${block.blockName} è dinamico o non è nella lista dei blocchi statici supportati.`);
      }
      let childIndex = 0;
      let html = "";
      for (const part of block.innerContent) {
        if (part === null) {
          const child = block.innerBlocks[childIndex++];
          if (!child) return unsupported("Il blocco WordPress contiene una struttura interna non valida.");
          html += reconstruct(child, depth + 1);
        } else html += part;
      }
      if (childIndex !== block.innerBlocks.length) return unsupported("Il blocco WordPress contiene riferimenti interni non consumati.");
      return html;
    };
    return sanitizeHtmlFragment(reconstruct(blocks[0]!, 0));
  };

  /** The document whose blocks render in `scope` (CmsRenderOrigin): the innermost component of its stack, or the content. */
  const scopeOrigin = (scope: ComponentRenderScope | undefined): CmsRenderOrigin => {
    const ref = scope?.content ? undefined : scope?.stack.at(-1);
    if (ref === undefined) return { kind: "content" };
    const kind = input.store.getComponentByRef(ref)?.kind;
    return { kind: kind === "template" ? "template" : kind === "template-part" ? "part" : "component", ref };
  };

  // `ctx` is where the block sits (nearest element, enclosing svg): it passes through conditions, loops, components
  // and slots, so the SVG subset and the textarea text are checked where the browser will parse them. What fails is
  // tagged with its origin by the innermost block that saw it fail (cmsRenderOrigin); the blocks around it rethrow it.
  /** The canvas's selection mark (RenderContext.annotate): the element's own uid, or its component instance's. */
  // The elements of the page's template are not in the page's document: they say whose they are, the template's or
  // one of its parts' (doc 18 F5), so the builder can tell the user and open the part on a double click.
  const annotation = (block: { attrs: { uid: string } }, scope: ComponentRenderScope | undefined): string => {
    if (input.annotate !== true) return "";
    const own = templateInstanceUid !== null && scope?.owner === templateInstanceUid
      ? scope.part ? ` data-xb-part="${htmlAttribute(scope.part)}"` : input.templateRef ? ` data-xb-template="${htmlAttribute(input.templateRef)}"` : ""
      : "";
    return ` data-xb-uid="${htmlAttribute(scope?.owner ?? block.attrs.uid)}"${own}`;
  };
  const renderBlock = async (block: (typeof parsed.blocks)[number], scope: ComponentRenderScope | undefined, depth = 0, ctx: TransferMarkupContext = TRANSFER_ROOT_CONTEXT): Promise<string> => {
    try {
      return await renderBlockIn(block, scope, depth, ctx);
    } catch (error) {
      if (typeof error === "object" && error !== null && !renderOrigins.has(error)) renderOrigins.set(error, scopeOrigin(scope));
      throw error;
    }
  };
  const renderBlockIn = async (block: (typeof parsed.blocks)[number], scope: ComponentRenderScope | undefined, depth: number, ctx: TransferMarkupContext): Promise<string> => {
    renderedNodes++;
    if (renderedNodes > MAX_RENDER_NODES) return unsupported(`Il rendering supera il limite di ${MAX_RENDER_NODES} nodi.`);
    if (block.name === "xb/text") renderedWorkBytes += Buffer.byteLength(block.attrs.content, "utf8");
    if (block.name === "xb/element") for (const value of Object.values(block.attrs.attributes ?? {})) if (typeof value === "string") renderedWorkBytes += Buffer.byteLength(value, "utf8");
    if (block.name === "xb/component") {
      const referenced = input.store.getComponentByRef(block.attrs.ref);
      if (referenced) renderedWorkBytes += Buffer.byteLength(referenced.content, "utf8");
    }
    if (renderedWorkBytes > MAX_RENDER_WORK_BYTES) return unsupported(`Il rendering supera il limite di ${MAX_RENDER_WORK_BYTES / 1024 / 1024} MiB di lavoro.`);
    if (depth > 64) return unsupported("I componenti e i blocchi superano la profondità massima di 64.");
    if (block.name === "xb/text") {
      // The initial value of a textarea: printed as written, never evaluated or parsed (blocks.md), as esc_textarea.
      if (block.attrs.verbatim === true) {
        if (ctx.parent !== "textarea") return unsupported("Il testo letterale è ammesso solo come contenuto di <textarea>.");
        return textareaText(block.attrs.content);
      }
      if (ctx.svg) markupChecked(() => checkTransferText(block.attrs.content, false, ctx));
      return interpolatedText(block.attrs.content, expressionValues(scope), scope?.locale ?? locale, scope?.timeZone ?? timeZone);
    }
    if (ctx.svg && (block.name === "xb/raw" || block.name === "xb/passthrough" || block.name === "xb/post-content" || block.name === "xb/component" || block.name === "xb/slot")) {
      return unsupported("Dentro <svg> sono ammessi solo gli elementi SVG statici, senza HTML, componenti o slot.");
    }
    if (block.name === "xb/raw") return sanitizeHtmlFragment(block.attrs.content);
    if (block.name === "xb/passthrough") return staticWordPressHtml(block.raw);
    if (block.name === "xb/post-content") {
      if (!input.templateRef || renderingPostContent) return "";
      renderingPostContent = true;
      // The content keeps the template's scope; only its origin is its own.
      const contentScope: ComponentRenderScope | undefined = scope ? { ...scope, content: true } : scope;
      try {
        return (await Promise.all(parsed.blocks.map((child) => renderBlock(child, contentScope, depth + 1, ctx)))).join("");
      } finally {
        renderingPostContent = false;
      }
    }
    if (block.name === "xb/slot") {
      if (!scope) return unsupported("Uno slot può comparire soltanto nella definizione di un componente.");
      const fill = scope.slots.get(block.attrs.name);
      return fill ? (await Promise.all(fill.blocks.map((child) => renderBlock(child, fill.scope, depth + 1, ctx)))).join("") : "";
    }
    if (block.name === "xb/component") {
      const component = input.store.getComponentByRef(block.attrs.ref);
      if (!component) return unsupported(`Il componente ${block.attrs.ref} non è presente nel progetto.`);
      if (component.kind === "template" && block.attrs.uid !== templateInstanceUid) return unsupported(`Il template ${component.ref} può essere applicato a una pagina dal catalogo, non inserito come componente.`);
      if (scope?.stack.includes(component.ref)) return unsupported(`Il componente ${component.ref} richiama sé stesso (direttamente o in modo circolare).`);
      if ((scope?.stack.length ?? 0) >= MAX_COMPONENT_DEPTH) return unsupported(`I componenti superano la profondità massima di ${MAX_COMPONENT_DEPTH}.`);
      const callerValues = scope?.values ?? EMPTY_SCOPE;
      const slots = new Map<string, { blocks: XbBlock[]; scope?: ComponentRenderScope }>();
      for (const fill of block.children) {
        if (slots.has(fill.attrs.name)) return unsupported(`Lo slot ${fill.attrs.name} è fornito più di una volta al componente ${component.ref}.`);
        slots.set(fill.attrs.name, { blocks: fill.children, ...(scope ? { scope } : {}) });
      }
      const props = componentProps(block, component, callerValues, scope?.locale ?? locale, scope?.timeZone ?? timeZone);
      const definition = parseXb(component.content);
      const declaredSlots = new Set<string>();
      const findSlots = (children: XbBlock[]): void => {
        for (const child of children) {
          if (child.name === "xb/slot") declaredSlots.add(child.attrs.name);
          if ("children" in child && child.name !== "xb/component") findSlots(child.children);
        }
      };
      findSlots(definition.blocks);
      const slotMetadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const name of declaredSlots) if (!slots.has(name)) slotMetadata[name] = { empty: true };
      for (const [name, fill] of slots) slotMetadata[name] = { empty: fill.blocks.length === 0 };
      const values: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>,
        scope?.values && Object.hasOwn(scope.values, "this") ? { this: scope.values.this } : {},
        scope?.values && Object.hasOwn(scope.values, "page") ? { page: scope.values.page } : {},
        scope?.values && Object.hasOwn(scope.values, "url") ? { url: scope.values.url } : {},
        // `data` reaches every template and component, as on WordPress: the language switcher lives in a header.
        scope?.values && Object.hasOwn(scope.values, "data") ? { data: scope.values.data } : {},
        { props, slots: slotMetadata });
      const owner = scope?.owner ?? (input.annotate ? block.attrs.uid : undefined);
      const part = component.kind === "template-part" && owner === templateInstanceUid ? component.ref : scope?.part;
      const childScope: ComponentRenderScope = { values, slots, stack: [...(scope?.stack ?? []), component.ref], locale: scope?.locale ?? locale, timeZone: scope?.timeZone ?? timeZone, ...(owner ? { owner } : {}), ...(part ? { part } : {}), ...(scope?.loops ? { loops: scope.loops } : {}) };
      for (const name of slots.keys()) if (!declaredSlots.has(name)) return unsupported(`Lo slot ${name} non è definito nel componente ${component.ref}.`);
      return (await Promise.all(definition.blocks.map((child) => renderBlock(child, childScope, depth + 1, ctx)))).join("");
    }
    if (block.name === "xb/if") {
      for (const branch of block.children) {
        const matches = branch.attrs.test === undefined || valueTruthy(expressionValue(parseExpression(branch.attrs.test), scope?.values ?? EMPTY_SCOPE, scope?.locale ?? locale, scope?.timeZone ?? timeZone));
        if (matches) return (await Promise.all(branch.children.map((child) => renderBlock(child, scope, depth + 1, ctx)))).join("");
      }
      return "";
    }
    if (block.name === "xb/loop") {
      if ((scope?.loops ?? 0) >= 6) return unsupported("I loop annidati superano il limite di 6.");
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(block.attrs.as) || (block.attrs.index !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(block.attrs.index))) return unsupported("Il loop contiene un nome di variabile non valido.");
      let items: unknown[];
      const loopSource = block.attrs.source;
      if (loopSource.kind === "preset" && loopSource.id === "main") {
        // The builder's built-in main query: what the archive being written lists, as WordPress's main query does.
        // Its size, order and offset are the archive's own (CMS_ARCHIVE_PAGE_SIZE, newest first): the builder's
        // built-in main ignores arguments, so one written here is refused rather than silently dropped.
        if (Object.keys(loopSource.args ?? {}).length) return unsupported(`{#loop main()}: main() non accetta argomenti, e WordPress li ignora: elenca i contenuti dell'archivio ${CMS_ARCHIVE_PAGE_SIZE} per pagina, dal più recente. Scrivi main(); per un altro numero o un altro ordine usa una query dichiarata, con limit, orderBy e order.`);
        if (!input.mainQuery) return unsupported("{#loop main()}: main() elenca i contenuti di un archivio e vale solo nei template d'archivio (di un tipo, di un termine o dell'elenco degli articoli), non in una pagina, un articolo, un record o la 404.");
        const result = await input.mainQuery();
        if (!Array.isArray(result)) return unsupported("La query main non ha restituito un elenco di contenuti.");
        items = result.map((item) => queryItemWithMedia(item, input.store, input.projectId));
      } else if (loopSource.kind === "preset") {
        if (!input.store.content.listQueryPresets().presets.some((preset) => preset.key === loopSource.id)) {
          return unsupported(`La query ${loopSource.id} non è configurata nel CMS relazionale M3.`);
        }
        const args = Object.fromEntries(Object.entries(loopSource.args ?? {}).map(([key, expression]) => [key, expressionValue(parseExpression(expression), scope?.values ?? EMPTY_SCOPE, scope?.locale ?? locale, scope?.timeZone ?? timeZone)]));
        const resolveQuery = input.resolveQuery ?? ((presetId: string, values: Record<string, unknown>, queryLocale: string) => input.store.content.resolveQueryPreset(presetId, values, queryLocale));
        let result: unknown;
        try {
          result = await resolveQuery(loopSource.id, args, scope?.locale ?? locale);
        } catch (error) {
          // The arguments the content gave the query (a limit past 100 from a field, a parameter the query does not
          // take): a refusal of the content like the others, so the build names the page and the template.
          if (error instanceof TypeError || error instanceof RangeError) return unsupported(`{#loop ${loopSource.id}(…)}: ${error.message}`);
          throw error;
        }
        if (!Array.isArray(result)) return unsupported(`La query ${loopSource.id} non ha restituito un elenco di record.`);
        items = result.map((item) => queryItemWithMedia(item, input.store, input.projectId));
      } else {
        const source = expressionValue(parseExpression(loopSource.expr), scope?.values ?? EMPTY_SCOPE, scope?.locale ?? locale, scope?.timeZone ?? timeZone);
        items = Array.isArray(source) ? source : source && typeof source === "object" ? Object.values(source) : [];
      }
      // `{#loop foto().groupBy("anno") as gruppo}` (doc 23, item 187): the query's result in groups {key, items}, from
      // one query, as Histeon's Renderer::group_items does with the groupBy modifier.
      if (loopSource.kind === "preset" && loopSource.groupBy !== undefined) {
        const { field, how } = loopSource.groupBy;
        if (!GROUP_BY_FIELD_PATTERN.test(field) || (how !== undefined && !GROUP_BY_HOW_PATTERN.test(how))) return unsupported(`{#loop ${loopSource.id}().groupBy(…)}: il campo o il modo del raggruppamento non è valido.`);
        items = applyCmsModifier("groupBy", items, how === undefined ? [field] : [field, how], scope?.locale ?? locale, scope?.timeZone ?? timeZone) as unknown[];
      }
      if (items.length > 1000) return unsupported("Il loop supera il limite di 1.000 elementi.");
      // `{:else}` (D1): the loop's last branch without a test, shown instead of the items when there are none, in the
      // scope around the loop (it has no item, so no loop variable).
      const empty = loopElse(block);
      const itemChildren = empty ? block.children.slice(0, -1) : block.children;
      if (empty && items.length === 0) return (await Promise.all(empty.children.map((child) => renderBlock(child, scope, depth + 1, ctx)))).join("");
      {
        const rendered: string[] = [];
        for (let index = 0; index < items.length; index++) {
          const values = Object.assign(Object.create(null) as Record<string, unknown>, scope?.values ?? EMPTY_SCOPE);
          values[block.attrs.as] = items[index];
          if (block.attrs.index !== undefined) values[block.attrs.index] = index;
          const itemScope: ComponentRenderScope = { values, slots: scope?.slots ?? new Map(), stack: scope?.stack ?? [], locale: scope?.locale ?? locale, timeZone: scope?.timeZone ?? timeZone, ...(scope?.content ? { content: true as const } : {}), ...(scope?.owner ? { owner: scope.owner } : {}), ...(scope?.part ? { part: scope.part } : {}), loops: (scope?.loops ?? 0) + 1 };
          for (const child of itemChildren) rendered.push(await renderBlock(child, itemScope, depth + 1, ctx));
        }
        return rendered.join("");
      }
    }
    if (block.name === "xb/branch") return unsupported("Un ramo condizionale non può essere renderizzato fuori da xb/if o dal {:else} di un loop.");
    if (block.name === "xb/slot-fill") return unsupported("Uno slot-riempimento può comparire soltanto in un’istanza di componente.");
    if (block.name !== "xb/element") return unsupported("Un blocco non appartiene al profilo pagine statiche M1.");
    if (ctx.svg || TRANSFER_SVG_TAGS.has(block.attrs.tag.toLowerCase())) {
      // The strict static subset (the renderer has no broader SVG profile): names as stored, so viewBox keeps its
      // case, values static and escaped, never interpolated.
      const svgTag = block.attrs.tag;
      const svgAttributes = block.attrs.attributes ?? {};
      markupChecked(() => {
        checkTransferElement(svgTag, svgAttributes, ctx);
        checkTransferChildren(svgTag, block.children.map(transferChildKind));
      });
      const rendered = Object.entries(svgAttributes).map(([name, value]) => ` ${name}="${htmlAttribute(String(value))}"`).join("") + annotation(block, scope);
      const svgChildren = await Promise.all(block.children.map((child) => renderBlock(child, scope, depth + 1, childContext(ctx, svgTag))));
      return `<${svgTag}${rendered}>${svgChildren.join("")}</${svgTag}>`;
    }
    const tag = block.attrs.tag.toLowerCase();
    if (!STATIC_TAGS.has(tag)) return unsupported(`L’elemento HTML <${tag}> non è supportato dal profilo statico M1.`);
    const attributes: string[] = [];
    const checkedAttributes = new Map<string, string | true>();
    const seenNames = new Set<string>();
    for (const [rawName, rawValue] of Object.entries(block.attrs.attributes ?? {})) {
      const name = rawName.toLowerCase();
      // METHOD and method are the same attribute to the browser, which keeps the first: never write two.
      if (seenNames.has(name)) return unsupported(`L’attributo ${name} compare più volte su <${tag}>.`);
      seenNames.add(name);
      if (/^on/iu.test(name) || BLOCKED_ATTRIBUTES.has(name)) return unsupported(`L’attributo ${name} non è supportato nel profilo statico M1.`);
      if (rawValue === true) {
        if (name === "action" || name === "method") return unsupported(`L’attributo ${name} deve avere un valore statico su <${tag}>.`);
        checkedAttributes.set(name, true);
        attributes.push(name);
        continue;
      }
      if ((name === "action" || name === "method") && /[{}]/u.test(rawValue)) return unsupported(`L’attributo ${name} del modulo non può essere dinamico.`);
      const evaluated = interpolatedAttribute(rawValue, expressionValues(scope), scope?.locale ?? locale, scope?.timeZone ?? timeZone);
      if (evaluated === null) continue;
      if (evaluated === true) {
        checkedAttributes.set(name, true);
        attributes.push(name);
        continue;
      }
      const decoded = decodedAttribute(evaluated);
      const value = name === "action" ? safeFormAction(tag, decoded) : await resolveStaticAttribute(name, decoded);
      checkedAttributes.set(name, value);
      attributes.push(`${name}="${htmlAttribute(value)}"`);
    }
    validateFormAttributes(tag, checkedAttributes, input.requireFormEndpoints === true);
    if (tag === "form") formCount++;
    const attrs = (attributes.length ? ` ${attributes.join(" ")}` : "") + annotation(block, scope);
    if (VOID_ELEMENTS.has(tag)) {
      if (block.children.length) return unsupported(`L’elemento vuoto <${tag}> contiene figli.`);
      return `<${tag}${attrs}>`;
    }
    const children = await Promise.all(block.children.map((child) => renderBlock(child, scope, depth + 1, childContext(ctx, tag))));
    return `<${tag}${attrs}>${children.join("")}</${tag}>`;
  };

  const body = (await Promise.all(blocksToRender.map((block) => renderBlock(block, rootScope)))).join("");
  if (Buffer.byteLength(body, "utf8") > MAX_RENDER_HTML_BYTES) return unsupported(`Il risultato HTML supera il limite di ${MAX_RENDER_HTML_BYTES / 1024 / 1024} MiB.`);
  const styleEntity = input.store.getStyles();
  const styleRevision = styleEntity ? input.store.getHead(styleEntity.id) : null;
  let css = "";
  let globalCss = "";
  let styleCss = "";
  const articleBlocks = input.articleBlocks === true || body.includes("xb-art-");
  // A site repeats the same CSS on every page: compiled once a build, with the media it names copied the first time.
  // The project's fonts are one more global sheet (local-fonts.ts), with their own key in the cache.
  const fontSheet = input.store.getFontSheet();
  const fontKey = fontSheet ? createHash("sha256").update(JSON.stringify(fontSheet)).digest("hex") : "";
  const compiledKey = input.buildMediaDirectory ? `${input.projectId}\n${styleRevision?.id ?? ""}\n${fontKey}\n${input.buildMediaDirectory}\n${articleBlocks}` : null;
  const known = compiledKey ? compiledPageCss.get(compiledKey) : undefined;
  try {
    if (known) ({ css, globalCss, styleCss } = known);
    else {
      const styleData = stylesData(styleRevision?.content ?? "{}");
      assertCssResourcesBundled([
        ...(styleData.globals ?? []).map((sheet, index) => ({ label: sheet.source?.name ?? sheet.id ?? `foglio globale ${index + 1}`, css: sheet.css, ...(sheet.assets ? { assets: sheet.assets } : {}) })),
        ...(styleData.styles ?? []).map((style, index) => ({ label: style.selector || `stile ${index + 1}`, css: style.css, ...(style.assets ? { assets: style.assets } : {}) })),
      ]);
      const compiled = compileCmsStyles(styleRevision?.content ?? "{}");
      if (fontSheet) compiled.globals = [...compiled.globals, { id: FONT_SHEET_ID, css: fontSheet.css, assets: fontSheet.assets }];
      const rewrittenGlobals = await Promise.all(compiled.globals.map((sheet) => rewriteCssAssetUrls(sheet.css, sheet.assets ?? [], (assetId) => copyAsset(assetId))));
      globalCss = histosGlobalCss({ design: compiled.design, tokenOverrides: compiled.tokenOverrides, siteTokens: compiled.siteTokens, globals: compiled.globals.map((sheet, index) => ({ ...sheet, css: rewrittenGlobals[index] ?? sheet.css })), articleBlocks });
      const rewrittenStyles = await Promise.all(compiled.styles.map(async (style) => {
        const css = resolveNamedQueries(compileCss(style.selector, style.css), compiled.queries);
        return rewriteCssAssetUrls(css, style.assets ?? [], (assetId) => copyAsset(assetId));
      }));
      styleCss = rewrittenStyles.join("\n").replace(/<\//gu, "\\3C /");
      css = [globalCss, styleCss].filter(Boolean).join("\n").replace(/<\//gu, "\\3C /");
      if (compiledKey) {
        if (compiledPageCss.size >= 8) compiledPageCss.clear();
        compiledPageCss.set(compiledKey, { css, globalCss, styleCss });
      }
    }
  }
  catch (error) {
    return unsupported(error instanceof Error ? error.message : "Gli stili globali non contengono JSON leggibile o CSS supportato.");
  }
  const language = htmlAttribute(locale);
  const seo = (input.page as { seo?: { title?: string; description?: string; image?: string } } | undefined)?.seo;
  const plainTitle = seo?.title || input.page?.title || "Anteprima Histeon";
  const title = htmlText(plainTitle);
  // A post or a record carries its excerpt in `page`: it is the description search engines show (WordPress SEO
  // plugins make the same one from the excerpt). Pages and archives have none, so no tag.
  const description = cmsMetaDescription(seo?.description || input.page?.excerpt);
  const descriptionTag = (description ? `<meta name="description" content="${htmlAttribute(description)}">` : "")
    + (seo?.title || seo?.description || seo?.image ? `<meta property="og:title" content="${htmlAttribute(plainTitle)}">${description ? `<meta property="og:description" content="${htmlAttribute(description)}">` : ""}${seo.image ? `<meta property="og:image" content="${htmlAttribute(seo.image)}">` : ""}` : "");
  // What search engines read of an article: JSON, with `<` escaped so nothing in a title can close the script.
  const post = input.page as { documentType?: string; publishedAt?: string | null } | undefined;
  const structured = post?.documentType === "post" ? `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Article", headline: plainTitle, ...(post.publishedAt ? { datePublished: post.publishedAt } : {}), ...(description ? { description } : {}) }).replaceAll("<", "\\u003c")}</script>` : "";
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${descriptionTag}${structured}<style>${css}</style></head><body>${body}</body></html>`;
  return { html, css, globalCss, styleCss, formCount, assets: [...assets.values()] };
}

function interpolatedAttribute(value: string, scope?: Record<string, unknown>, locale = "en-US", timeZone = "UTC"): string | true | null {
  if (!scope) {
    if (/[{}]/u.test(value.replace(/\\([{}])/gu, ""))) return unsupported("La pagina usa espressioni dinamiche che il profilo statico non compila.");
    return value.replace(/\\([{}])/gu, "$1");
  }
  if (value.startsWith("{")) {
    const close = findClosingBrace(value, 0);
    if (close === value.length - 1) {
      const result = expressionValue(parseExpression(value, 1, close), scope, locale, timeZone);
      if (result === null || result === undefined || result === false) return null;
      if (result === true) return true;
      return valueString(result);
    }
  }
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (char === "\\" && (value.charAt(i + 1) === "{" || value.charAt(i + 1) === "}")) {
      out += value.charAt(i + 1);
      i++;
    } else if (char === "{") {
      const close = findClosingBrace(value, i);
      out += interpolationValue(expressionValue(parseExpression(value, i + 1, close), scope, locale, timeZone));
      i = close;
    } else if (char === "}") return unsupported("L’attributo contiene una parentesi graffa non escapata.");
    else out += char;
  }
  return out;
}

export function extensionForMime(mimeType: string): string {
  const extensions: Record<string, string> = { "application/pdf": "pdf", "font/otf": "otf", "font/ttf": "ttf", "font/woff": "woff", "font/woff2": "woff2", "image/avif": "avif", "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = extensions[mimeType];
  if (!extension) return unsupported(`Il tipo media ${mimeType} non è supportato dal profilo statico M1.`);
  return extension;
}

export function compileCmsStyles(content: string): { styles: Array<{ id: string; selector: string; css: string; assets?: CssAssetReference[] }>; globals: NonNullable<CmsStylesData["globals"]>; queries: Record<string, string>; design: HistosDesign; tokenOverrides: Record<string, string>; siteTokens: Record<string, string>; globalCss: string; styleCss: string; head: string; base: string; compiledCss: string } {
  const parsed = stylesData(content);
  const styles = (parsed.styles ?? []).map((style, index) => ({ id: style.id ?? `style-${index + 1}`, selector: style.selector, css: style.css, ...(style.assets ? { assets: style.assets } : {}) }));
  const globals = (parsed.globals ?? []).map((sheet, index) => ({ id: sheet.id ?? `global-${index + 1}`, css: sheet.css, ...(sheet.source ? { source: sheet.source } : {}), ...(sheet.assets ? { assets: sheet.assets } : {}) }));
  const queries = parsed.queries ?? {};
  const design = validateHistosDesign(parsed.design ?? {});
  const tokenOverrides = validateHistosTokenOverrides(parsed.tokenOverrides ?? {}, new Set(histosTokenNames()));
  const siteTokens = validateSiteTokens(parsed.siteTokens ?? {});
  const globalCss = histosGlobalCss({ design, tokenOverrides, siteTokens, globals, articleBlocks: false });
  const styleCss = styles.map((style) => resolveNamedQueries(compileCss(style.selector, style.css), queries)).join("\n").replace(/<\//gu, "\\3C /");
  return { styles, globals, queries, design, tokenOverrides, siteTokens, globalCss, styleCss, head: "", base: "", compiledCss: [globalCss, styleCss].filter(Boolean).join("\n") };
}

export { HISTOS_DESIGN_DEFAULTS, changedHistosDesign, computeHistosTokens, frameworkDataWithExternalCss, histosClassOffPatterns, histosContrast, histosDesignCss, histosPreviewCss, histosTokenNames, validateHistosDesign, validateHistosTokenOverrides };
