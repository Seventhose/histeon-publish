import { decodeHTMLAttribute, decodeHTMLStrict } from "entities";
import type { XbBlock } from "../.generated/histos-dsl/index.js";

/**
 * histos-transfer-markup-v1: the markup a portable transfer profile carries, checked the same way by Publish (this
 * module) and by Histeon on WordPress (`plugin/src/Remote/TransferMarkup.php`). The lists, the grammar sources and the
 * test vectors live in `packages/histos-contract/fixtures/histos-transfer-markup-v1.json`, which both test suites
 * read, so the two ports cannot drift silently.
 *
 * Pure: no store, no DSL runtime (types only), no network. Regular expressions use ASCII classes written out and no
 * `i` flag, and every grammar is compiled with the `u` flag (PHP: `/uD`), so JavaScript and PCRE agree.
 *
 * Order of the element checks (the first failure wins, attributes in their stored order):
 * 1. tag (G1), then the content model of the element in its context (C1–C7);
 * 2. for each attribute: name syntax (G2), blocked names and form-only names (G4), blocked prefixes (G5), the
 *    allowlist of the HTML element (every one, old and new) or of the SVG element; SVG values: boolean or braces → `dynamic`, `&` or `\` →
 *    `value`, grammar → `value`, inline CSS of `style` (G7) → `style`; HTML values: numeric references (G3), the value
 *    rule of the attribute, URL schemes (G6), inline CSS (G7), form action and method (G9);
 * 3. required attributes: `action` and `method` on `form` (`form`), `srcset` on `source` (`attribute`).
 */

export const TRANSFER_MARKUP_ID = "histos-transfer-markup-v1";
/** Doc 23 item 121: a link (`<a href>`) to a media file of the project, as `histos-media://<uuid>`. */
export const MEDIA_LINKS_ID = "histos-media-links-v1";
/** The site reads `url.path` in expressions (doc 23, item 189): Histeon 0.5.4 and later. */
export const URL_PATH_ID = "histos-url-path-v1";
/** The site groups a query loop's result (`foto().groupBy("anno")`, doc 23, item 187): Histeon 0.5.5 and later. */
export const LOOP_GROUP_ID = "histos-loop-group-v1";
/**
 * The site reads SVG drawings with text, gradients and inline style (TRANSFER_SVG_TEXT_TAGS, TRANSFER_SVG_TEXT_ATTRIBUTES,
 * `aria-*` and `data-*` on SVG elements, `fill="url(#id)"`): Histeon 0.5.14 and later.
 */
export const SVG_TEXT_ID = "histos-svg-text-v1";

export type TransferMarkupReason =
  | "tag" | "context" | "attribute" | "dynamic" | "value" | "reference" | "url" | "style" | "form" | "text" | "media";

export const TRANSFER_MARKUP_REASONS: readonly TransferMarkupReason[] = Object.freeze([
  "tag", "context", "attribute", "dynamic", "value", "reference", "url", "style", "form", "text", "media",
]);

/** A violation of the transferable markup. `reason` is compared by both test suites; the message is for people. */
export class TransferMarkupError extends TypeError {
  readonly reason: TransferMarkupReason;

  constructor(reason: TransferMarkupReason, message: string) {
    super(message);
    this.name = "TransferMarkupError";
    this.reason = reason;
  }
}

function violation(reason: TransferMarkupReason, message: string): never {
  throw new TransferMarkupError(reason, message);
}

/** Where a block sits: the nearest element ancestor and whether an svg, a form or a button encloses it. */
export interface TransferMarkupContext {
  readonly parent: string | null;
  readonly svg: boolean;
  readonly form: boolean;
  readonly button: boolean;
}

export const TRANSFER_ROOT_CONTEXT: TransferMarkupContext = Object.freeze({ parent: null, svg: false, form: false, button: false });

/** The context of the children of an element; conditions and loops pass their own context through unchanged. */
export function childContext(ctx: TransferMarkupContext, tag: string): TransferMarkupContext {
  return { parent: tag, svg: ctx.svg || tag === "svg", form: ctx.form || tag === "form", button: ctx.button || tag === "button" };
}

// ---------------------------------------------------------------- lists (equal to the fixture's `lists`)

const LEGACY_TRANSFER_TAGS = [
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt",
  "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "li", "main",
  "mark", "nav", "ol", "p", "pre", "q", "s", "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "th", "thead", "time", "tr", "u", "ul",
];

/**
 * HTML elements added by markup v1: the capability gate and the `*.attribute` value rules concern them. Since doc 23
 * item 172 every HTML element, old and new, has a closed attribute allowlist (TRANSFER_ELEMENT_ATTRIBUTES).
 */
export const TRANSFER_NEW_HTML_TAGS: ReadonlySet<string> = new Set([
  "button", "details", "fieldset", "form", "input", "label", "legend", "optgroup", "option", "output", "picture", "select",
  "source", "summary", "textarea",
]);

/** The HTML elements a transfer profile carries (listed in the AI manual for prototypes, kept equal by a test). */
export const TRANSFER_TAGS: ReadonlySet<string> = new Set([...LEGACY_TRANSFER_TAGS, ...TRANSFER_NEW_HTML_TAGS].sort());

/**
 * SVG elements added by histos-svg-text-v1: text, and gradients in `defs`. The only tags with upper-case letters are
 * here, stored and written in this canonical case (G1).
 */
export const TRANSFER_SVG_TEXT_TAGS: readonly string[] = ["text", "tspan", "defs", "linearGradient", "radialGradient", "stop"];

/** The static inline SVG subset (second line of the manual's element list). */
export const TRANSFER_SVG_TAGS: ReadonlySet<string> = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "title", "desc", ...TRANSFER_SVG_TEXT_TAGS,
]);

export const TRANSFER_VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img", "input", "source", "wbr"]);

/** Inline formatting inside a text run; equal to the DSL's INLINE_FORMAT and to WordPress Spec::TEXT_INLINE_HTML. */
export const TRANSFER_INLINE_TAGS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  a: ["href", "target", "rel"], abbr: ["title"], b: [], br: [], code: [], em: [], i: [], kbd: [], mark: [], q: [], s: [],
  small: [], span: [], strong: [], sub: [], sup: [], time: ["datetime"], u: [], wbr: [],
}));

/**
 * Attributes every HTML element accepts (except TRANSFER_ELEMENTS_WITHOUT_GLOBAL_ATTRIBUTES), besides `aria-*` and
 * `data-*` (TRANSFER_GLOBAL_ATTRIBUTE_PREFIXES): the usual ones, `translate`, and microdata (inert; `itemtype` and
 * `itemid` are URLs, checked by G6).
 */
export const TRANSFER_GLOBAL_ATTRIBUTES: readonly string[] = [
  "class", "id", "style", "title", "lang", "dir", "hidden", "tabindex", "role", "translate", "itemscope", "itemtype", "itemprop", "itemid", "itemref",
];
export const TRANSFER_GLOBAL_ATTRIBUTE_PREFIXES: readonly string[] = ["aria-", "data-"];

/**
 * The closed allowlist of each HTML element besides the global attributes (doc 23 item 172: the older tags too, which
 * until then accepted any name the blocked lists did not refuse). What the prototypes, the static import, the editor's
 * fields and the libraries' sections write, and the standard inert attributes of each element; nothing presentational
 * or obsolete (`align`, `border`), nothing that runs or loads (`usemap`, `popover`, `contenteditable`).
 */
export const TRANSFER_ELEMENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "target", "rel", "hreflang", "type", "download", "referrerpolicy"],
  abbr: [],
  article: [],
  aside: [],
  b: [],
  blockquote: ["cite"],
  br: [],
  button: ["type", "name", "value", "disabled"],
  caption: [],
  cite: [],
  code: [],
  dd: [],
  del: ["cite", "datetime"],
  details: ["open", "name"],
  div: [],
  dl: [],
  dt: [],
  em: [],
  fieldset: ["disabled"],
  figcaption: [],
  figure: [],
  footer: [],
  form: ["action", "method", "enctype", "autocomplete", "novalidate"],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  header: [],
  hr: [],
  i: [],
  img: ["src", "alt", "width", "height", "srcset", "sizes", "loading", "decoding", "fetchpriority", "referrerpolicy"],
  input: [
    "type", "name", "value", "placeholder", "required", "disabled", "readonly", "checked", "min", "max", "step", "minlength",
    "maxlength", "size", "multiple", "pattern", "inputmode", "enterkeyhint", "spellcheck", "autocomplete",
  ],
  label: ["for"],
  legend: [],
  li: ["value"],
  main: [],
  mark: [],
  nav: [],
  ol: ["start", "reversed", "type"],
  optgroup: ["label", "disabled"],
  option: ["value", "label", "selected", "disabled"],
  output: ["for", "name"],
  p: [],
  picture: [],
  pre: [],
  q: ["cite"],
  s: [],
  section: [],
  select: ["name", "required", "disabled", "multiple", "size", "autocomplete"],
  small: [],
  source: ["srcset", "sizes", "media", "type", "width", "height"],
  span: [],
  strong: [],
  sub: [],
  summary: [],
  sup: [],
  table: [],
  tbody: [],
  td: ["colspan", "rowspan", "headers"],
  textarea: ["name", "rows", "cols", "placeholder", "required", "disabled", "readonly", "minlength", "maxlength", "wrap", "autocomplete", "spellcheck"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  thead: [],
  time: ["datetime"],
  tr: [],
  u: [],
  ul: [],
};

/** `source` accepts only its own list: no global attributes. */
export const TRANSFER_ELEMENTS_WITHOUT_GLOBAL_ATTRIBUTES: readonly string[] = ["source"];

export const TRANSFER_SVG_COMMON_ATTRIBUTES: readonly string[] = [
  "id", "class", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform", "vector-effect",
  "color", "clip-rule", "shape-rendering", "paint-order", "display", "visibility", "role", "aria-hidden", "aria-label",
  "aria-labelledby", "aria-describedby",
];

/**
 * Common attributes added by histos-svg-text-v1, on the same elements: inline style (checked as on an HTML element,
 * G7), the language, and the presentation attributes of text.
 */
export const TRANSFER_SVG_TEXT_ATTRIBUTES: readonly string[] = [
  "style", "lang", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing", "text-anchor",
  "dominant-baseline", "text-decoration",
];

/**
 * histos-svg-text-v1: every `aria-*` and `data-*` name on the same elements (states a style sheet selects), with the
 * blocked names and prefixes of G4 and G5 and the value grammar `svgData`.
 */
export const TRANSFER_SVG_ATTRIBUTE_PREFIXES: readonly string[] = ["aria-", "data-"];

/** SVG elements that accept the common attributes besides their own list (`title` and `desc` do not). */
export const TRANSFER_SVG_TAGS_WITH_COMMON_ATTRIBUTES: readonly string[] = [
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", ...TRANSFER_SVG_TEXT_TAGS,
];

export const TRANSFER_SVG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  svg: ["viewBox", "width", "height", "preserveAspectRatio", "focusable"],
  g: [],
  path: ["d", "pathLength"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  title: ["id"],
  desc: ["id"],
  text: ["x", "y", "dx", "dy", "textLength", "lengthAdjust"],
  tspan: ["x", "y", "dx", "dy", "textLength", "lengthAdjust"],
  defs: [],
  linearGradient: ["x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod"],
  radialGradient: ["cx", "cy", "r", "fx", "fy", "fr", "gradientUnits", "gradientTransform", "spreadMethod"],
  stop: ["offset", "stop-color", "stop-opacity"],
};

/** The only attribute names with upper-case letters, stored and written in this canonical case (G2). */
export const TRANSFER_SVG_CAMEL_CASE_ATTRIBUTES: readonly string[] = [
  "viewBox", "preserveAspectRatio", "pathLength", "textLength", "lengthAdjust", "gradientUnits", "gradientTransform", "spreadMethod",
];

/**
 * G4: refused on every element. `data-*` stays open (states and variants of components, Histeon's own behaviours
 * `data-xb-*`, the scripts of an imported site); refused are the `data-*` names that widespread front-end libraries
 * read as code, HTML or a request to send (doc 23 item 172): Knockout, Datastar, hyperscript, Rails UJS and Turbo,
 * Bootstrap's HTML tooltips; with TRANSFER_BLOCKED_PREFIXES also Dojo and Intercooler.
 */
export const TRANSFER_BLOCKED_ATTRIBUTES: readonly string[] = [
  "formaction", "formmethod", "formenctype", "formtarget", "form", "srcdoc", "nonce", "integrity", "crossorigin", "xmlns", "is",
  "autofocus", "popovertarget", "popovertargetaction", "command", "commandfor", "interestfor", "ping", "attributionsrc", "background",
  "data-bind", "data-xb-uid",
  "data-signals", "data-computed", "data-effect", "data-text", "data-show", "data-class", "data-attr", "data-style", "data-indicator", "data-init",
  "data-script", "data-method", "data-remote", "data-params", "data-disable-with", "data-turbo-method", "data-turbo-stream",
  "data-html", "data-template", "data-sanitize", "data-sanitize-fn", "data-allow-list",
  "data-bs-html", "data-bs-template", "data-bs-sanitize", "data-bs-sanitize-fn", "data-bs-allow-list",
];

/**
 * G3: the named references a browser decodes in an attribute even without `;` (HTML "legacy" entities). PHP's
 * html_entity_decode leaves them as they are, so the two sides would read different values: they are refused.
 */
export const TRANSFER_LEGACY_REFERENCES: readonly string[] = [
  "AElig", "AMP", "Aacute", "Acirc", "Agrave", "Aring", "Atilde", "Auml", "COPY", "Ccedil", "ETH", "Eacute", "Ecirc", "Egrave", "Euml", "GT", "Iacute", "Icirc", "Igrave", "Iuml", "LT", "Ntilde", "Oacute", "Ocirc", "Ograve", "Oslash", "Otilde", "Ouml", "QUOT", "REG", "THORN", "Uacute", "Ucirc", "Ugrave", "Uuml", "Yacute", "aacute", "acirc", "acute", "aelig", "agrave", "amp", "aring", "atilde", "auml", "brvbar", "ccedil", "cedil", "cent", "copy", "curren", "deg", "divide", "eacute", "ecirc", "egrave", "eth", "euml", "frac12", "frac14", "frac34", "gt", "iacute", "icirc", "iexcl", "igrave", "iquest", "iuml", "laquo", "lt", "macr", "micro", "middot", "nbsp", "not", "ntilde", "oacute", "ocirc", "ograve", "ordf", "ordm", "oslash", "otilde", "ouml", "para", "plusmn", "pound", "quot", "raquo", "reg", "sect", "shy", "sup1", "sup2", "sup3", "szlig", "thorn", "times", "uacute", "ucirc", "ugrave", "uml", "uuml", "yacute", "yen", "yuml",
];

/** G4: allowed only on `form`. */
export const TRANSFER_FORM_ONLY_ATTRIBUTES: readonly string[] = ["action", "method"];

/** G5: framework and event prefixes. */
export const TRANSFER_BLOCKED_PREFIXES: readonly string[] = [
  "on", "x-", "v-", "hx-", "ng-", "ng_", "data-hx-", "data-ng-", "data-on-", "data-bind-",
  "data-signals-", "data-computed-", "data-class-", "data-attr-", "data-style-", "data-indicator-", "data-dojo-", "data-ic-",
];

/** G6: attributes whose value is a URL checked against TRANSFER_URL_SCHEMES. */
export const TRANSFER_URL_ATTRIBUTES: readonly string[] = ["href", "cite", "longdesc", "poster", "data", "codebase", "manifest", "imagesrcset", "itemtype", "itemid"];
export const TRANSFER_URL_SCHEMES: readonly string[] = ["http", "https", "mailto", "tel"];

export const TRANSFER_INPUT_TYPES: readonly string[] = [
  "text", "search", "email", "tel", "url", "number", "range", "date", "time", "datetime-local", "month", "week", "color",
  "checkbox", "radio", "hidden", "submit", "reset", "button",
];

/** Single `autocomplete` tokens: no credentials, one-time codes, payment or transaction data. */
export const TRANSFER_AUTOCOMPLETE: readonly string[] = [
  "on", "off", "name", "honorific-prefix", "given-name", "additional-name", "family-name", "honorific-suffix", "nickname",
  "organization", "organization-title", "street-address", "address-line1", "address-line2", "address-line3",
  "address-level1", "address-level2", "address-level3", "address-level4", "country", "country-name", "postal-code",
  "language", "bday", "bday-day", "bday-month", "bday-year", "url", "email", "tel", "tel-country-code", "tel-national",
  "tel-area-code", "tel-local", "tel-extension",
];

export const TRANSFER_SOURCE_TYPES: readonly string[] = ["image/avif", "image/webp", "image/png", "image/jpeg", "image/gif"];

/** Enumerations of the HTML value rules, compared after ASCII lower-casing of the decoded value. */
export const TRANSFER_ENUMS: Readonly<Record<string, readonly string[]>> = {
  autocomplete: TRANSFER_AUTOCOMPLETE,
  buttonType: ["button", "submit", "reset"],
  dir: ["ltr", "rtl", "auto"],
  enctype: ["application/x-www-form-urlencoded", "multipart/form-data"],
  enterkeyhint: ["enter", "done", "go", "next", "previous", "search", "send"],
  formAutocomplete: ["on", "off"],
  inputmode: ["none", "text", "decimal", "numeric", "tel", "search", "email", "url"],
  inputTypes: TRANSFER_INPUT_TYPES,
  sourceTypes: TRANSFER_SOURCE_TYPES,
  spellcheck: ["true", "false"],
  wrap: ["soft", "hard"],
};

export interface TransferHtmlValueRule {
  /** A list of TRANSFER_ENUMS. */
  enum?: string;
  /** A grammar of TRANSFER_GRAMMARS, matched against the decoded value. */
  grammar?: string;
  /** At most this many code points. */
  maxCodePoints?: number;
  /** Every candidate URL is checked (G6, or a portable `histos-media://` identity). */
  srcset?: boolean;
}

/**
 * Value rules of HTML attributes, keyed `tag.attribute`; `*.attribute` applies to every new HTML element. Every rule
 * makes the value static: a string without `{` or `}` (otherwise `dynamic`).
 */
export const TRANSFER_HTML_VALUE_RULES: Readonly<Record<string, TransferHtmlValueRule>> = {
  "*.dir": { enum: "dir" },
  "button.type": { enum: "buttonType" },
  "details.name": { grammar: "detailsName" },
  "form.autocomplete": { enum: "formAutocomplete" },
  "form.enctype": { enum: "enctype" },
  "img.sizes": { grammar: "sizes" },
  "img.srcset": { grammar: "srcset", srcset: true },
  "input.autocomplete": { enum: "autocomplete" },
  "input.enterkeyhint": { enum: "enterkeyhint" },
  "input.inputmode": { enum: "inputmode" },
  "input.pattern": { maxCodePoints: 256 },
  "input.spellcheck": { enum: "spellcheck" },
  "input.type": { enum: "inputTypes" },
  "select.autocomplete": { enum: "autocomplete" },
  "source.height": { grammar: "dimension" },
  "source.media": { grammar: "sizes" },
  "source.sizes": { grammar: "sizes" },
  "source.srcset": { grammar: "srcset", srcset: true },
  "source.type": { enum: "sourceTypes" },
  "source.width": { grammar: "dimension" },
  "textarea.autocomplete": { enum: "autocomplete" },
  "textarea.wrap": { enum: "wrap" },
};

/**
 * Grammar of each SVG attribute, keyed `tag.attribute` first, then `attribute`, then `prefix*` for the names of
 * TRANSFER_SVG_ATTRIBUTE_PREFIXES. Matched exactly (no lower-casing).
 */
export const TRANSFER_SVG_VALUE_RULES: Readonly<Record<string, string>> = {
  "svg.width": "lengthOrAuto", "svg.height": "lengthOrAuto",
  width: "length", height: "length", x: "length", y: "length", cx: "length", cy: "length", r: "length",
  x1: "length", y1: "length", x2: "length", y2: "length", rx: "lengthOrAuto", ry: "lengthOrAuto",
  viewBox: "viewBox", preserveAspectRatio: "preserveAspectRatio", pathLength: "number", "stroke-miterlimit": "number",
  d: "pathData", points: "points", transform: "transform",
  fill: "paintServer", stroke: "paintServer", color: "paint",
  opacity: "opacity", "fill-opacity": "opacity", "stroke-opacity": "opacity",
  "stroke-width": "length", "stroke-dashoffset": "length", "stroke-dasharray": "dasharray",
  "fill-rule": "fillRule", "clip-rule": "fillRule", "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin",
  "vector-effect": "vectorEffect", "shape-rendering": "shapeRendering", "paint-order": "paintOrder",
  display: "display", visibility: "visibility", role: "svgRole", "aria-hidden": "boolean", focusable: "boolean",
  class: "svgClass", id: "id", "aria-labelledby": "idList", "aria-describedby": "idList", "aria-label": "ariaLabel",
  "text.x": "lengthList", "text.y": "lengthList", "tspan.x": "lengthList", "tspan.y": "lengthList", dx: "lengthList", dy: "lengthList",
  textLength: "length", lengthAdjust: "lengthAdjust", fx: "length", fy: "length", fr: "length",
  gradientUnits: "gradientUnits", gradientTransform: "transform", spreadMethod: "spreadMethod",
  offset: "opacity", "stop-color": "paint", "stop-opacity": "opacity",
  style: "svgStyle", lang: "lang", "font-family": "fontFamily", "font-size": "length", "font-weight": "fontWeight",
  "font-style": "fontStyle", "letter-spacing": "spacing", "word-spacing": "spacing", "text-anchor": "textAnchor",
  "dominant-baseline": "dominantBaseline", "text-decoration": "textDecoration",
  "aria-*": "svgData", "data-*": "svgData",
};

/** The SVG elements that hold text: plain, without markup (`text` and `tspan` since histos-svg-text-v1). */
export const TRANSFER_SVG_TEXT_PARENTS: readonly string[] = ["title", "desc", "text", "tspan"];

/** Parents under which components, slots and slot fills are refused (as inside svg). */
export const TRANSFER_CONTENT_BLOCKED_PARENTS: readonly string[] = ["option", "optgroup", "picture", "select", "textarea"];

const WS = "[ \\t\\n\\r\\f]";
const NUM = "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?";
const LEN = `${NUM}(?:px|em|rem|%)?`;
const ID = "[A-Za-z][A-Za-z0-9_-]{0,63}";
const SEP = `(?:${WS}*,${WS}*|${WS}+)`;
const SRCSET_CANDIDATE = `[^ \\t\\n\\r\\f,]+(?:${WS}+(?:[1-9][0-9]{0,4}w|[0-9]{1,2}(?:\\.[0-9]{1,2})?x))?`;

/**
 * Regular expression sources shared with PHP (compiled with `u`; PHP adds `D`). Anchored ones match a whole value;
 * `numericReference` is matched at each `&#`, `styleResource` and the escapes are searched.
 */
export const TRANSFER_GRAMMARS: Readonly<Record<string, string>> = {
  attributeName: "^[a-z][a-z0-9_-]*$",
  ariaLabel: "^[^\\x00-\\x1F\\x7F<>\"]{1,256}$",
  boolean: "^(?:true|false)$",
  cssCharEscape: "\\\\([^\\r\\n\\f0-9a-fA-F])",
  cssHexEscape: `\\\\([0-9a-fA-F]{1,6})${WS}?`,
  dasharray: `^(?:none|${LEN}(?:${SEP}${LEN}){0,15})$`,
  detailsName: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
  dimension: "^[0-9]{1,5}$",
  display: "^(?:none|inline)$",
  dominantBaseline: "^(?:auto|middle|central|hanging|alphabetic|ideographic|mathematical|text-before-edge|text-after-edge|text-top|text-bottom)$",
  fillRule: "^(?:nonzero|evenodd)$",
  fontFamily: "^(?:[A-Za-z0-9 ,'._-]{1,256}|var\\(--[A-Za-z0-9_-]{1,64}\\))$",
  fontStyle: "^(?:normal|italic|oblique)$",
  fontWeight: "^(?:normal|bold|bolder|lighter|[1-9][0-9]{0,2}|1000)$",
  formActionForbidden: "[\\p{Cc}\\p{Z}﻿\\\\#{}]",
  gradientUnits: "^(?:userSpaceOnUse|objectBoundingBox)$",
  id: `^${ID}$`,
  idList: `^${ID}(?:${WS}+${ID}){0,7}$`,
  inlineAttribute: `^([a-zA-Z_:][a-zA-Z0-9_:.-]*)${WS}*=${WS}*(?:"([^"<>]*)"|'([^'<>]*)')`,
  inlineTag: "^<(/?)([a-z][a-z0-9]*)([^>]*)>$",
  lang: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$",
  length: `^${LEN}$`,
  lengthAdjust: "^(?:spacing|spacingAndGlyphs)$",
  // At most 64 lengths: PCRE refuses to compile a longer repetition of this group ("regular expression is too large").
  lengthList: `^${LEN}(?:${SEP}${LEN}){0,63}$`,
  lengthOrAuto: `^(?:${LEN}|auto)$`,
  number: `^${NUM}$`,
  numericReference: "^&#(?:([0-9]{1,7})|[xX]([0-9A-Fa-f]{1,6}));",
  opacity: `^${NUM}%?$`,
  paint: "^(?:#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})|[A-Za-z]{3,24}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\([0-9A-Za-z.,%/+ -]{1,64}\\)|var\\(--[A-Za-z0-9_-]{1,64}\\))$",
  paintOrder: "^(?:normal|(?:fill|stroke|markers)(?: (?:fill|stroke|markers)){0,2})$",
  paintServer: "^(?:#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})|[A-Za-z]{3,24}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\([0-9A-Za-z.,%/+ -]{1,64}\\)|var\\(--[A-Za-z0-9_-]{1,64}\\)|url\\(#[A-Za-z][A-Za-z0-9_-]{0,63}\\))$",
  pathData: "^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+ \\t\\n\\r\\f-]{0,32768}$",
  points: "^[0-9eE.,+ \\t\\n\\r\\f-]{0,32768}$",
  preserveAspectRatio: `^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:${WS}+(?:meet|slice))?$`,
  shapeRendering: "^(?:auto|optimizeSpeed|crispEdges|geometricPrecision)$",
  sizes: "^[A-Za-z0-9 ().,:%+/*-]{1,512}$",
  spacing: `^(?:normal|${LEN})$`,
  spreadMethod: "^(?:pad|reflect|repeat)$",
  srcset: `^${WS}*${SRCSET_CANDIDATE}(?:${WS}*,${WS}*${SRCSET_CANDIDATE}){0,15}${WS}*$`,
  strokeLinecap: "^(?:butt|round|square)$",
  strokeLinejoin: "^(?:miter|miter-clip|round|bevel|arcs)$",
  styleResource: `url${WS}*\\(|image-set${WS}*\\(|cross-fade${WS}*\\(|element${WS}*\\(|src${WS}*\\(|expression${WS}*\\(|@import|-moz-binding|behavior${WS}*:|javascript${WS}*:|vbscript${WS}*:|data${WS}*:|<${WS}*/${WS}*style`,
  svgClass: "^[A-Za-z0-9_ -]{0,256}$",
  svgData: "^[^\\x00-\\x1F\\x7F<>\"]{0,256}$",
  svgRole: "^(?:img|presentation|none)$",
  svgStyle: "^[^\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F<>]{0,4096}$",
  textAnchor: "^(?:start|middle|end)$",
  textDecoration: "^(?:none|underline|overline|line-through)$",
  transform: `^${WS}*(?:(?:matrix|translate|scale|rotate|skewX|skewY)${WS}*\\([0-9eE.,+ \\t\\n\\r\\f-]{0,128}\\)${WS}*,?${WS}*){1,8}$`,
  urlIgnored: "[\\x00-\\x20\\x7F]",
  vectorEffect: "^(?:none|non-scaling-stroke)$",
  verbatimForbidden: "[{}<&]",
  visibility: "^(?:visible|hidden|collapse)$",
  viewBox: `^${WS}*${NUM}${SEP}${NUM}${SEP}${NUM}${SEP}${NUM}${WS}*$`,
  whitespace: `^${WS}*$`,
};

const compiled = new Map<string, RegExp>();
function grammar(name: string, flags = "u"): RegExp {
  const key = `${flags}\0${name}`;
  let pattern = compiled.get(key);
  if (!pattern) {
    const source = TRANSFER_GRAMMARS[name];
    if (source === undefined) throw new TypeError(`Grammatica di trasferimento sconosciuta: ${name}.`);
    pattern = new RegExp(source, flags);
    compiled.set(key, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

const MEDIA_URL = /^histos-media:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

/** The asset id of a portable media identity (`histos-media://` and a lower-case UUID), or null. */
export function transferMediaId(value: string): string | null {
  return MEDIA_URL.exec(value)?.[1] ?? null;
}

/** ASCII lower-casing, as PHP strtolower: Unicode folding (the Kelvin sign is `k` in JavaScript) never applies. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function isWhitespace(value: string): boolean {
  return grammar("whitespace").test(value);
}

// ---------------------------------------------------------------- G3: numeric character references

function allowedReferenceCodePoint(code: number): boolean {
  if (!((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x10ffff))) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (code >= 0xfdd0 && code <= 0xfdef) return false;
  // The last two code points of every plane are noncharacters, which PHP's html_entity_decode leaves undecoded.
  return (code & 0xffff) < 0xfffe;
}

/** G3: every `&#` is a complete reference (with `;`) to a code point both decoders decode the same way. */
export function transferReferencesAreSafe(value: string): boolean {
  const reference = grammar("numericReference");
  for (let at = value.indexOf("&#"); at >= 0; at = value.indexOf("&#", at + 2)) {
    const match = reference.exec(value.slice(at));
    if (!match) return false;
    const code = match[1] !== undefined ? Number.parseInt(match[1], 10) : Number.parseInt(match[2] ?? "", 16);
    if (!allowedReferenceCodePoint(code)) return false;
  }
  return true;
}

function assertReferences(value: string, what: string): void {
  if (!transferReferencesAreSafe(value)) {
    violation("reference", `${what} contiene un riferimento numerico a carattere incompleto o non ammesso: scrivi il carattere com’è, oppure il riferimento con il punto e virgola.`);
  }
}

/** G3 for named references: a legacy one without `;` (`&amp`, `&nbsp`) decodes differently in PHP. */
function assertNamedReferences(value: string, what: string): void {
  if (value.includes("&") && decodeHTMLAttribute(value) !== decodeHTMLStrict(value)) {
    violation("reference", `${what} contiene un riferimento a carattere senza punto e virgola (come &amp o &nbsp): aggiungi il punto e virgola o scrivi il carattere com’è.`);
  }
}

/** An attribute value as the browser reads it, after G3 (`reference` otherwise). */
export function decodeTransferAttribute(value: string, what = "Il valore"): string {
  assertReferences(value, what);
  assertNamedReferences(value, what);
  return decodeHTMLAttribute(value);
}

// ---------------------------------------------------------------- G6, G7, G9

/** G6 on a decoded value: a scheme, if any, is http, https, mailto or tel. Relative and `//host` URLs pass. */
export function transferUrlIsSafe(decoded: string): boolean {
  let value = asciiLower(decoded.replace(grammar("urlIgnored", "gu"), ""));
  const brace = value.indexOf("{");
  if (brace >= 0) value = value.slice(0, brace);
  const colon = value.indexOf(":");
  if (colon < 0) return true;
  const scheme = value.slice(0, colon);
  if (/[/?#]/u.test(scheme)) return true;
  return TRANSFER_URL_SCHEMES.includes(scheme);
}

/**
 * The CSS escapes of a declaration resolved as the CSS tokenizer would (`\75 rl(` is `url(`), after the CSS input
 * preprocessing: CR LF, CR and FF become LF and NUL becomes U+FFFD, so `\75` + CR LF + `rl(` is `url(` here too.
 */
export function decodeCssEscapes(value: string): string {
  return value
    .replace(/\r\n?|\f/gu, "\n")
    .replaceAll(String.fromCharCode(0), "\uFFFD")
    .replace(grammar("cssHexEscape", "gu"), (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
    })
    .replace(grammar("cssCharEscape", "gu"), "$1");
}

/**
 * G7 on a decoded `style` value: true when it would load a resource or run an active behaviour. Any `/*` counts: inside
 * a CSS string it starts no comment, so removing "comments" could hide a live url(); a comment between a function
 * name and its `(` already breaks the function, so nothing is lost by not stripping them.
 */
export function inlineStyleLoadsResources(decoded: string): boolean {
  if (decoded.includes("/*")) return true;
  return grammar("styleResource").test(asciiLower(decodeCssEscapes(decoded)));
}

/**
 * G9: a form endpoint is a same-site path or an absolute HTTPS URL with a host, without whitespace or control
 * characters, backslashes, braces, credentials or fragments. Takes the decoded value.
 */
export function isSafeFormAction(decoded: string): boolean {
  const action = decoded;
  if (!action || grammar("formActionForbidden").test(action) || action.startsWith("//") || /^https:\/\/\//u.test(asciiLower(action))) return false;
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(action);
  let parsed: URL;
  try {
    parsed = new URL(action, "https://histos-publish.invalid/");
  } catch {
    return false;
  }
  // An `@` in the authority is userinfo even when empty (`https://@host/`), as PHP's parse_url reads it.
  if (parsed.username || parsed.password || parsed.hash || /^https:\/\/[^/?#]*@/iu.test(action)) return false;
  return hasScheme
    ? asciiLower(action).startsWith("https://") && parsed.protocol === "https:" && parsed.hostname !== ""
    : parsed.origin === "https://histos-publish.invalid";
}

// ---------------------------------------------------------------- srcset and textarea

export interface TransferSrcsetCandidate {
  url: string;
  descriptor: string | null;
}

/** The candidates of a `srcset` that matches the shared grammar (at most 16, URLs without commas), or null. */
export function parseTransferSrcset(value: string): TransferSrcsetCandidate[] | null {
  if (!grammar("srcset").test(value)) return null;
  return value.split(",").map((part) => {
    const [url = "", descriptor] = part.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/gu, "").split(/[ \t\n\r\f]+/u);
    return { url, descriptor: descriptor ?? null };
  });
}

/** The canonical spelling of a srcset: `url descriptor` candidates joined by `, `. */
export function formatTransferSrcset(candidates: readonly TransferSrcsetCandidate[]): string {
  return candidates.map((candidate) => (candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url)).join(", ");
}

/** The verbatim content of a textarea, escaped byte for byte as WordPress esc_textarea does. */
export function textareaText(content: string): string {
  return content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/** The index of the brace closing the interpolation opened at `open` (string literals skipped), or -1. */
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source.charAt(index);
    if (char === '"' || char === "'") {
      index++;
      while (index < source.length && source.charAt(index) !== char) {
        if (source.charAt(index) === "\\") index++;
        index++;
      }
      if (index >= source.length) return -1;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/** True when the whole value is one interpolation (`{props.image}`). */
export function isWholeInterpolation(value: string): boolean {
  return value.startsWith("{") && closingBrace(value, 0) === value.length - 1;
}

/**
 * The only dynamic media source a transfer carries: a component prop as a whole (`{props.immagine}`), filled by the
 * instance. Any other expression (`{page.title}`, filters, nested fields) could print an arbitrary URL.
 */
export function isTransferMediaProp(value: string): boolean {
  return /^\{props\.[A-Za-z_][A-Za-z0-9_]{0,63}\}$/u.test(value);
}

// ---------------------------------------------------------------- elements

function lookupHtmlRule(tag: string, name: string): TransferHtmlValueRule | undefined {
  return TRANSFER_HTML_VALUE_RULES[`${tag}.${name}`] ?? (TRANSFER_NEW_HTML_TAGS.has(tag) ? TRANSFER_HTML_VALUE_RULES[`*.${name}`] : undefined);
}

function checkElementContext(tag: string, ctx: TransferMarkupContext): void {
  const svgTag = TRANSFER_SVG_TAGS.has(tag);
  if (svgTag && tag !== "svg" && !ctx.svg) violation("context", `<${tag}> è ammesso solo dentro <svg>.`);
  if (tag === "svg" && ctx.svg) violation("context", "Un <svg> dentro un altro <svg> non è trasferibile.");
  if (ctx.svg && !svgTag) violation("context", `Dentro <svg> sono ammessi solo gli elementi SVG statici: <${tag}> no.`);
  if ((tag === "title" || tag === "desc") && !(ctx.parent !== null && TRANSFER_SVG_TAGS.has(ctx.parent) && ctx.parent !== "title" && ctx.parent !== "desc")) {
    violation("context", `<${tag}> è ammesso solo come figlio di un elemento SVG.`);
  }
  // histos-svg-text-v1 (C7): a line of text holds text, `tspan`, `title` and `desc`; a gradient holds its stops.
  if (tag === "tspan" && ctx.parent !== "text" && ctx.parent !== "tspan") violation("context", "<tspan> è ammesso solo dentro <text> o un altro <tspan>.");
  if ((ctx.parent === "text" || ctx.parent === "tspan") && tag !== "tspan" && tag !== "title" && tag !== "desc") {
    violation("context", `Dentro <${ctx.parent}> vanno solo testo e <tspan>: <${tag}> no.`);
  }
  if (tag === "stop" && ctx.parent !== "linearGradient" && ctx.parent !== "radialGradient") violation("context", "<stop> è ammesso solo dentro <linearGradient> o <radialGradient>.");
  if ((ctx.parent === "linearGradient" || ctx.parent === "radialGradient") && tag !== "stop") violation("context", `Dentro <${ctx.parent}> vanno solo gli <stop>: <${tag}> no.`);
  if (ctx.parent === "stop") violation("context", `<stop> non ha contenuto: <${tag}> no.`);
  if (tag === "source" && ctx.parent !== "picture") violation("context", "<source> è ammesso solo dentro <picture>.");
  if (ctx.parent === "picture" && tag !== "source" && tag !== "img") violation("context", `Dentro <picture> vanno solo <source> e un <img>: <${tag}> no.`);
  if (tag === "summary" && ctx.parent !== "details") violation("context", "<summary> è ammesso solo dentro <details>.");
  if (tag === "option" && ctx.parent !== "select" && ctx.parent !== "optgroup") violation("context", "<option> è ammesso solo dentro <select> o <optgroup>.");
  if (tag === "optgroup" && ctx.parent !== "select") violation("context", "<optgroup> è ammesso solo dentro <select>.");
  if ((ctx.parent === "select" || ctx.parent === "optgroup") && tag !== "option" && tag !== "optgroup") {
    violation("context", `Dentro <${ctx.parent}> vanno solo <option> e <optgroup>: <${tag}> no.`);
  }
  if (ctx.parent === "option" || ctx.parent === "textarea") violation("context", `<${ctx.parent}> contiene solo testo: <${tag}> no.`);
  if (tag === "form" && ctx.form) violation("context", "Un modulo dentro un altro modulo non è trasferibile.");
  if (tag === "button" && ctx.button) violation("context", "Un pulsante dentro un altro pulsante non è trasferibile.");
}

function checkAttributeName(tag: string, name: string, svg: boolean): void {
  if (!grammar("attributeName").test(name) && !(svg && TRANSFER_SVG_CAMEL_CASE_ATTRIBUTES.includes(name))) {
    violation("attribute", `Il nome di attributo «${name.slice(0, 60)}» su <${tag}> non è trasferibile: solo minuscole, cifre, - e _.`);
  }
  if (TRANSFER_BLOCKED_ATTRIBUTES.includes(name) || (TRANSFER_FORM_ONLY_ATTRIBUTES.includes(name) && tag !== "form")) {
    violation("attribute", `L’attributo ${name} non è ammesso su <${tag}> nel profilo trasferibile.`);
  }
  if (TRANSFER_BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    violation("attribute", `L’attributo ${name} non è ammesso: gestori di eventi e attributi di framework non sono trasferibili.`);
  }
}

/** The prefix of TRANSFER_SVG_ATTRIBUTE_PREFIXES an SVG attribute name starts with (and goes beyond), or undefined. */
function svgAttributePrefix(name: string): string | undefined {
  return TRANSFER_SVG_ATTRIBUTE_PREFIXES.find((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

function checkSvgAttribute(tag: string, name: string, value: string | true): void {
  checkAttributeName(tag, name, true);
  const allowed = TRANSFER_SVG_ATTRIBUTES[tag] ?? [];
  const prefix = svgAttributePrefix(name);
  const common = TRANSFER_SVG_COMMON_ATTRIBUTES.includes(name) || TRANSFER_SVG_TEXT_ATTRIBUTES.includes(name) || prefix !== undefined;
  if (!allowed.includes(name) && !(TRANSFER_SVG_TAGS_WITH_COMMON_ATTRIBUTES.includes(tag) && common)) {
    violation("attribute", `L’attributo ${name} non è ammesso su <${tag}> nell’SVG trasferibile.`);
  }
  if (value === true || /[{}]/u.test(value)) violation("dynamic", `L’attributo ${name} di <${tag}> deve avere un valore statico.`);
  if (/[&\\]/u.test(value)) violation("value", `Il valore di ${name} su <${tag}> non può contenere & o \\.`);
  const rule = TRANSFER_SVG_VALUE_RULES[`${tag}.${name}`] ?? TRANSFER_SVG_VALUE_RULES[name] ?? (prefix === undefined ? undefined : TRANSFER_SVG_VALUE_RULES[`${prefix}*`]);
  if (rule === undefined || !grammar(rule).test(value)) violation("value", `Il valore di ${name} su <${tag}> non è ammesso nell’SVG trasferibile.`);
  // G7, as on an HTML element; the value has no `&` and no `\\`, so nothing is left to decode.
  if (name === "style" && inlineStyleLoadsResources(value)) {
    violation("style", `Lo stile in linea di <${tag}> carica una risorsa o un comportamento attivo (url(), image-set(), @import…).`);
  }
}

function checkHtmlValueRule(tag: string, name: string, value: string | true, rule: TransferHtmlValueRule): void {
  if (value === true || /[{}]/u.test(value)) violation("dynamic", `L’attributo ${name} di <${tag}> deve avere un valore statico.`);
  const decoded = decodeTransferAttribute(value, `L’attributo ${name}`);
  const invalid = (): never => violation("value", `Il valore di ${name} su <${tag}> non è ammesso.`);
  if (rule.enum !== undefined && !(TRANSFER_ENUMS[rule.enum] ?? []).includes(asciiLower(decoded))) invalid();
  if (rule.grammar !== undefined && !grammar(rule.grammar).test(decoded)) invalid();
  if (rule.maxCodePoints !== undefined && Array.from(decoded).length > rule.maxCodePoints) invalid();
  if (rule.srcset) {
    for (const candidate of parseTransferSrcset(decoded) ?? invalid()) {
      if (transferMediaId(candidate.url) === null && !transferUrlIsSafe(candidate.url)) {
        violation("url", `Una sorgente di srcset su <${tag}> usa uno schema URL non ammesso.`);
      }
    }
  }
}

/** Whether an HTML element's allowlist (its own attributes and the global ones) holds the name. */
function htmlAttributeListed(tag: string, name: string): boolean {
  const own = TRANSFER_ELEMENT_ATTRIBUTES[tag] ?? [];
  const global = !TRANSFER_ELEMENTS_WITHOUT_GLOBAL_ATTRIBUTES.includes(tag)
    && (TRANSFER_GLOBAL_ATTRIBUTES.includes(name) || TRANSFER_GLOBAL_ATTRIBUTE_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length));
  return own.includes(name) || global;
}

/**
 * Whether a transfer may carry the attribute name on the HTML element (G2, G4, G5 and the allowlist), its value aside:
 * for importers that drop what a transfer would refuse (the static site import) instead of failing.
 */
export function transferHtmlAttributeAllowed(tag: string, name: string): boolean {
  try {
    checkAttributeName(tag, name, false);
  } catch (error) {
    if (error instanceof TransferMarkupError) return false;
    throw error;
  }
  return htmlAttributeListed(tag, name);
}

function checkHtmlAttribute(tag: string, name: string, value: string | true): void {
  checkAttributeName(tag, name, false);
  if (!htmlAttributeListed(tag, name)) violation("attribute", `L’attributo ${name} non è ammesso su <${tag}> nel profilo trasferibile.`);
  if (typeof value === "string") {
    assertReferences(value, `L’attributo ${name} di <${tag}>`);
    assertNamedReferences(value, `L’attributo ${name} di <${tag}>`);
  }
  const rule = lookupHtmlRule(tag, name);
  if (rule) checkHtmlValueRule(tag, name, value, rule);
  // A link of an `a` may also be a media identity of the project (doc 23 item 121), checked as a media later.
  if (typeof value === "string" && TRANSFER_URL_ATTRIBUTES.includes(name) && !transferUrlIsSafe(decodeHTMLAttribute(value)) && !(tag === "a" && name === "href" && transferMediaId(value) !== null)) {
    violation("url", `L’attributo ${name} di <${tag}> usa uno schema URL non ammesso: solo http, https, mailto e tel.`);
  }
  if (name === "style" && typeof value === "string" && /[{}]/u.test(value)) {
    violation("dynamic", `Lo stile in linea di <${tag}> deve essere statico: un’espressione potrebbe portare url() a ogni rendering.`);
  }
  if (name === "style" && typeof value === "string" && inlineStyleLoadsResources(decodeHTMLAttribute(value))) {
    violation("style", `Lo stile in linea di <${tag}> carica una risorsa o un comportamento attivo (url(), image-set(), @import…).`);
  }
  if (tag === "form" && name === "action" && (typeof value !== "string" || /[{}]/u.test(value) || !isSafeFormAction(decodeHTMLAttribute(value)))) {
    violation("form", "L’endpoint del modulo deve essere statico: un percorso del sito o un URL HTTPS senza spazi, credenziali o frammenti.");
  }
  if (tag === "form" && name === "method" && (typeof value !== "string" || /[{}]/u.test(value) || !["get", "post"].includes(asciiLower(value)))) {
    violation("form", "Il metodo del modulo deve essere GET o POST e non può essere dinamico.");
  }
}

/** Checks one element of the transferable markup in its context (the media identities are checked by the caller). */
export function checkTransferElement(tag: string, attributes: Readonly<Record<string, string | true>>, ctx: TransferMarkupContext): void {
  const svg = TRANSFER_SVG_TAGS.has(tag);
  if (!svg && !TRANSFER_TAGS.has(tag)) violation("tag", `L’elemento <${tag.slice(0, 40)}> non è trasferibile da Histeon CMS${tag !== asciiLower(tag) ? " (i tag vanno scritti in minuscolo)" : ""}.`);
  checkElementContext(tag, ctx);
  for (const [name, value] of Object.entries(attributes)) {
    if (svg) checkSvgAttribute(tag, name, value);
    else checkHtmlAttribute(tag, name, value);
  }
  if (tag === "form" && (!Object.hasOwn(attributes, "action") || !Object.hasOwn(attributes, "method"))) {
    violation("form", "Un modulo trasferibile dichiara sia action (percorso del sito o URL HTTPS) sia method (GET o POST).");
  }
  if (tag === "source" && !Object.hasOwn(attributes, "srcset")) violation("attribute", "<source> richiede srcset.");
}

// ---------------------------------------------------------------- children, blocks, text

/** One token per child block, for checkTransferChildren. */
export type TransferChildKind = string;

export function transferChildKind(block: XbBlock): TransferChildKind {
  switch (block.name) {
    case "xb/element": return `element:${block.attrs.tag}`;
    case "xb/text": return block.attrs.verbatim ? "verbatim" : isWhitespace(block.attrs.content) ? "space" : "text";
    case "xb/if": case "xb/loop": return "control";
    case "xb/component": return "component";
    case "xb/slot": return "slot";
    default: return `block:${block.name}`;
  }
}

/** The content model of an element's children. */
export function checkTransferChildren(tag: string, kinds: readonly TransferChildKind[]): void {
  if (TRANSFER_VOID_TAGS.has(tag) && kinds.length) violation("context", `L’elemento vuoto <${tag}> non può avere figli.`);
  const significant = kinds.filter((kind) => kind !== "space");
  if (tag === "picture") {
    let index = 0;
    while (significant[index] === "element:source") index++;
    if (significant[index] !== "element:img" || index + 1 !== significant.length) {
      violation("context", "<picture> contiene zero o più <source> e poi esattamente un <img>, senza testo, condizioni o componenti.");
    }
  }
  if (tag === "details") {
    const summaries = significant.filter((kind) => kind === "element:summary").length;
    if (summaries > 1 || (summaries === 1 && significant[0] !== "element:summary")) violation("context", "<details> ha al massimo un <summary>, e come primo figlio.");
  }
  if (tag === "textarea" && !(kinds.length === 0 || (kinds.length === 1 && kinds[0] === "verbatim"))) {
    violation("text", "<textarea> contiene soltanto il suo testo iniziale, scritto così com’è.");
  }
  if (tag === "option" && kinds.some((kind) => kind !== "text" && kind !== "space")) violation("context", "<option> contiene solo testo.");
  if ((tag === "select" || tag === "optgroup") && kinds.includes("text")) violation("context", `<${tag}> non contiene testo libero, solo <option>.`);
}

/** Components, slots, slot fills and WordPress blocks kept whole are refused inside svg and inside elements whose content is fixed. */
export function checkTransferBlock(name: string, ctx: TransferMarkupContext): void {
  if (name !== "xb/component" && name !== "xb/slot" && name !== "xb/slot-fill" && name !== "xb/passthrough") return;
  if (ctx.svg || (ctx.parent !== null && TRANSFER_CONTENT_BLOCKED_PARENTS.includes(ctx.parent))) {
    // A block of WordPress kept whole (xb/passthrough, audit note 88) would be read by another parser there.
    violation("context", name === "xb/passthrough"
      ? `Un blocco di WordPress non è ammesso dentro <${ctx.svg ? "svg" : ctx.parent}>.`
      : `Componenti e slot non sono ammessi dentro <${ctx.svg ? "svg" : ctx.parent}>.`);
  }
}

/** A block as the WordPress block grammar reads it, before any repair (parseBlockGrammar / parse_blocks()). */
export interface TransferGrammarBlock {
  blockName: string | null;
  attrs: Record<string, unknown> | null;
  innerBlocks: readonly TransferGrammarBlock[];
}

/**
 * Where an `xb/branch` may stand, on the blocks as written (before parseXb drops a misplaced one): in `xb/if`, or as
 * the `{:else}` of an `xb/loop` (D1), which is at most one branch, the loop's last block, without a `test` attribute
 * (any `test`, even one that is not a string). Anything else is a `context` violation. Blocks without a name (HTML
 * between blocks) do not count as children.
 */
export function checkTransferBranches(blocks: readonly TransferGrammarBlock[]): void {
  const pending: Array<{ block: TransferGrammarBlock; parent: string | null }> = blocks.map((block) => ({ block, parent: null }));
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { block, parent } = item;
    if (block.blockName === "xb/branch" && parent !== "xb/if" && parent !== "xb/loop") {
      violation("context", "Un ramo condizionale sta solo in {#if} o, come {:else}, in fondo a un {#loop}.");
    }
    if (block.blockName === "xb/loop") {
      const named = block.innerBlocks.filter((child) => child.blockName !== null);
      const branches = named.filter((child) => child.blockName === "xb/branch");
      if (branches.length > 1) violation("context", "Un {#loop} ha al più un {:else}.");
      const branch = branches[0];
      if (branch && named[named.length - 1] !== branch) violation("context", "Il {:else} di un {#loop} sta in fondo al loop, dopo il contenuto degli elementi.");
      if (branch && branch.attrs !== null && Object.hasOwn(branch.attrs, "test")) violation("context", "Il ramo di un {#loop} è solo {:else}, senza condizione.");
    }
    for (const child of block.innerBlocks) pending.push({ block: child, parent: block.blockName });
  }
}

/**
 * The inline markup of a text run: only TRANSFER_INLINE_TAGS with their quoted, static attributes, balanced, and no
 * comments or processing instructions. Interpolations are skipped (their scopes are checked elsewhere).
 */
export function checkTransferInlineMarkup(content: string): void {
  assertReferences(content, "Il testo");
  const stack: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const char = content.charAt(index);
    const next = content.charAt(index + 1);
    if (char === "\\" && (next === "{" || next === "}")) { index++; continue; }
    if (char === "{") {
      const close = closingBrace(content, index);
      if (close < 0) violation("text", "Il testo contiene un’espressione non chiusa.");
      index = close;
      continue;
    }
    if (char !== "<") continue;
    if (next === "!" || next === "?") violation("text", "Il testo non può contenere commenti HTML o istruzioni <? ?>.");
    if (!/[A-Za-z/]/u.test(next)) continue;
    const end = content.indexOf(">", index + 1);
    if (end < 0) violation("text", "Il testo contiene markup inline non chiuso.");
    const match = grammar("inlineTag").exec(content.slice(index, end + 1));
    const tag = match?.[2] ?? "";
    const allowed = TRANSFER_INLINE_TAGS.get(tag);
    if (!match || !allowed) violation("text", `Il testo contiene markup inline fuori dall’elenco ammesso (${content.slice(index, Math.min(end + 1, index + 40))}).`);
    const closing = match[1] === "/";
    let tail = match[3] ?? "";
    const selfClosing = TRANSFER_VOID_TAGS.has(tag);
    if (closing) {
      if (!isWhitespace(tail)) violation("text", `Il tag di chiusura </${tag}> contiene attributi.`);
      if (selfClosing || stack.pop() !== tag) violation("text", `Il markup inline <${tag}> non è bilanciato.`);
    } else {
      while (!isWhitespace(tail)) {
        tail = tail.replace(/^[ \t\n\r\f]+/u, "");
        const attribute = grammar("inlineAttribute").exec(tail);
        if (!attribute) violation("text", `Il tag inline <${tag}> contiene un attributo senza virgolette o non valido.`);
        const name = attribute[1] ?? "";
        const value = attribute[2] ?? attribute[3] ?? "";
        if (!allowed.includes(name)) violation("attribute", `L’attributo ${name} non è ammesso su <${tag}> nel markup inline.`);
        if (/[{}]/u.test(value)) violation("text", `Gli attributi del markup inline non ammettono valori dinamici (<${tag}>).`);
        if (name === "href" && !transferUrlIsSafe(decodeTransferAttribute(value, "Il link"))) violation("url", "Un link nel testo usa uno schema URL non ammesso: solo http, https, mailto e tel.");
        tail = tail.slice(attribute[0].length);
      }
      if (!selfClosing) stack.push(tag);
    }
    index = end;
  }
  if (stack.length) violation("text", `Il markup inline <${stack[stack.length - 1]}> non è chiuso.`);
}

/**
 * The inline markup of a text run with some attribute values rewritten (C1: class and style names), read as
 * checkTransferInlineMarkup reads it: interpolations skipped, tags and quoted attributes by the shared grammar, the quote
 * kept. A run it cannot read comes back unchanged, for the check to refuse it with its reason.
 */
export function rewriteInlineMarkupAttributes(content: string, rewrite: (tag: string, name: string, value: string) => string): string {
  const parts: string[] = [];
  let from = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content.charAt(index);
    const next = content.charAt(index + 1);
    if (char === "\\" && (next === "{" || next === "}")) { index++; continue; }
    if (char === "{") {
      const close = closingBrace(content, index);
      if (close < 0) return content;
      index = close;
      continue;
    }
    if (char !== "<" || !/[A-Za-z]/u.test(next)) continue;
    const end = content.indexOf(">", index + 1);
    if (end < 0) return content;
    const match = grammar("inlineTag").exec(content.slice(index, end + 1));
    if (!match) return content;
    const tag = match[2] ?? "";
    let offset = index + 1 + tag.length;
    let tail = match[3] ?? "";
    while (!isWhitespace(tail)) {
      const space = /^[ \t\n\r\f]*/u.exec(tail)?.[0].length ?? 0;
      tail = tail.slice(space);
      offset += space;
      const attribute = grammar("inlineAttribute").exec(tail);
      if (!attribute) return content;
      const value = attribute[2] ?? attribute[3] ?? "";
      const rewritten = rewrite(tag, attribute[1] ?? "", value);
      // A new value that could close the attribute or open a tag is not written.
      if (rewritten !== value && !/[<>]/u.test(rewritten) && !rewritten.includes(attribute[2] !== undefined ? '"' : "'")) {
        // The value sits just before the closing quote that ends the match.
        const valueEnd = offset + attribute[0].length - 1;
        parts.push(content.slice(from, valueEnd - value.length), rewritten);
        from = valueEnd;
      }
      tail = tail.slice(attribute[0].length);
      offset += attribute[0].length;
    }
    index = end;
  }
  if (!parts.length) return content;
  parts.push(content.slice(from));
  return parts.join("");
}

/** A text block in its context. `verbatim` text (a textarea's initial value) is printed as is, never parsed. */
export function checkTransferText(content: string, verbatim: boolean, ctx: TransferMarkupContext): void {
  if (verbatim) {
    if (ctx.parent !== "textarea") violation("text", "Il testo letterale è ammesso solo come contenuto di <textarea>.");
    if (grammar("verbatimForbidden").test(content)) violation("text", "Il testo iniziale di <textarea> non può contenere { } < o &.");
    return;
  }
  if (ctx.svg && !TRANSFER_SVG_TEXT_PARENTS.includes(ctx.parent ?? "")) {
    if (!isWhitespace(content)) violation("text", "Dentro <svg> il testo è ammesso solo in <title>, <desc>, <text> e <tspan>.");
    return;
  }
  if (TRANSFER_SVG_TEXT_PARENTS.includes(ctx.parent ?? "") || ctx.parent === "option") {
    if (content.includes("<")) violation("text", `<${ctx.parent}> contiene solo testo, senza markup.`);
    assertReferences(content, "Il testo");
    return;
  }
  if (ctx.parent === "select" || ctx.parent === "optgroup" || ctx.parent === "picture") {
    if (!isWhitespace(content)) violation("text", `<${ctx.parent}> non contiene testo libero.`);
    return;
  }
  checkTransferInlineMarkup(content);
}

/**
 * Every markup violation of a document's blocks (E4), in document order, instead of only the first: the checks of a
 * transfer that read the markup alone (blocks in their context, tags, attributes, children, text). A block whose own
 * check fails is not entered, so one wrong element is one problem, not one per descendant. At most `limit` come back;
 * with `counted` the walk goes on past them and `counted.total` grows by every violation, kept or not, so a count can
 * be exact without holding millions of errors; `counted.refused` (when given) gets the uid of every block refused, kept
 * or not, so that a later check of the same document never counts one of them a second time.
 */
export function transferMarkupIssues(blocks: readonly XbBlock[], limit = 100, counted?: { total: number; refused?: Set<string> }): Array<{ uid: string; error: TransferMarkupError }> {
  const issues: Array<{ uid: string; error: TransferMarkupError }> = [];
  const visit = (block: XbBlock, ctx: TransferMarkupContext): void => {
    if (issues.length >= limit && !counted) return;
    try {
      checkTransferBlock(block.name, ctx);
      if (block.name === "xb/text") checkTransferText(block.attrs.content, block.attrs.verbatim === true, ctx);
      if (block.name === "xb/element") {
        checkTransferElement(block.attrs.tag, block.attrs.attributes ?? {}, ctx);
        checkTransferChildren(block.attrs.tag, block.children.map(transferChildKind));
      }
    } catch (error) {
      if (!(error instanceof TransferMarkupError)) throw error;
      if (counted) {
        counted.total++;
        counted.refused?.add(block.attrs.uid);
      }
      if (issues.length < limit) issues.push({ uid: block.attrs.uid, error });
      return;
    }
    if ("children" in block) {
      const next = block.name === "xb/element" ? childContext(ctx, block.attrs.tag) : ctx;
      for (const child of block.children) visit(child, next);
    }
  };
  for (const block of blocks) visit(block, TRANSFER_ROOT_CONTEXT);
  return issues;
}

/**
 * The static SVG subset of an SVG element tree, for SVG code pasted into the local editor (queue A6, P2): what the
 * transfer would refuse is left out and named in `dropped` (`<use>`, an attribute name, `testo`); namespace
 * declarations (`xmlns`, `xmlns:xlink`) go silently, as in the builder's svgAttribute(): inline SVG needs none and
 * transfers refuse them. Each element is checked with its own context and each attribute on its own, so one bad value
 * costs that attribute only. `block` is null when the root itself is not a transferable `svg` element. Pure: the
 * editor patch and the tests call it with the same blocks.
 */
export function transferSvgSubset(root: XbBlock, ctx: TransferMarkupContext = TRANSFER_ROOT_CONTEXT): { block: XbBlock | null; dropped: string[] } {
  const dropped = new Set<string>();
  const refused = (error: unknown): void => {
    if (!(error instanceof TransferMarkupError)) throw error;
  };
  const visit = (block: XbBlock, context: TransferMarkupContext): XbBlock | null => {
    if (block.name === "xb/text") {
      try {
        checkTransferText(block.attrs.content, block.attrs.verbatim === true, context);
        return block;
      } catch (error) {
        refused(error);
        dropped.add("testo");
        return null;
      }
    }
    if (block.name !== "xb/element") {
      dropped.add(block.name);
      return null;
    }
    const tag = block.attrs.tag;
    try {
      checkTransferElement(tag, {}, context);
    } catch (error) {
      refused(error);
      dropped.add(`<${tag}>`);
      return null;
    }
    const attributes: Record<string, string | true> = {};
    for (const [name, value] of Object.entries(block.attrs.attributes ?? {})) {
      const lower = asciiLower(name);
      if (lower === "xmlns" || lower.startsWith("xmlns:")) continue;
      try {
        checkTransferElement(tag, { [name]: value }, context);
        attributes[name] = value;
      } catch (error) {
        refused(error);
        dropped.add(name);
      }
    }
    const inner = childContext(context, tag);
    const children = block.children.map((child) => visit(child, inner)).filter((child): child is XbBlock => child !== null);
    const { attributes: _previous, ...attrs } = block.attrs;
    return { ...block, attrs: { ...attrs, ...(Object.keys(attributes).length ? { attributes } : {}) }, children };
  };
  if (root.name !== "xb/element" || root.attrs.tag !== "svg") return { block: null, dropped: [] };
  const block = visit(root, ctx);
  return { block, dropped: [...dropped] };
}

/**
 * True when blocks use what only a reader of histos-svg-text-v1 accepts: an element of TRANSFER_SVG_TEXT_TAGS, or on
 * any SVG element an attribute of TRANSFER_SVG_TEXT_ATTRIBUTES, an `aria-*` or `data-*` name the older list did not
 * have, or a `fill` or `stroke` that points to a gradient (`url(#id)`).
 */
export function blocksUseSvgText(blocks: readonly XbBlock[]): boolean {
  return blocks.some((block) => {
    if (block.name === "xb/element" && TRANSFER_SVG_TAGS.has(block.attrs.tag)) {
      if (TRANSFER_SVG_TEXT_TAGS.includes(block.attrs.tag)) return true;
      for (const [name, value] of Object.entries(block.attrs.attributes ?? {})) {
        if (TRANSFER_SVG_TEXT_ATTRIBUTES.includes(name)) return true;
        if (svgAttributePrefix(name) !== undefined && !TRANSFER_SVG_COMMON_ATTRIBUTES.includes(name)) return true;
        if ((name === "fill" || name === "stroke") && typeof value === "string" && value.startsWith("url(")) return true;
      }
    }
    return "children" in block && blocksUseSvgText(block.children);
  });
}

/** Tags whose presence needs a WordPress site that advertises histos-transfer-markup-v1. */
export const TRANSFER_MARKUP_V1_TAGS: ReadonlySet<string> = new Set([...TRANSFER_SVG_TAGS, "picture", "source", "details", "summary"]);

/** True when blocks use markup that only histos-transfer-markup-v1 readers accept (SVG, picture, details, verbatim text). */
export function blocksUseTransferMarkupV1(blocks: readonly XbBlock[]): boolean {
  return blocks.some((block) =>
    (block.name === "xb/element" && (TRANSFER_MARKUP_V1_TAGS.has(block.attrs.tag) || (block.attrs.tag === "img" && block.attrs.attributes?.srcset !== undefined)
      // A component's dynamic image source: released plugins refuse it after the upload.
      || (typeof block.attrs.attributes?.src === "string" && isWholeInterpolation(block.attrs.attributes.src))))
    || (block.name === "xb/text" && block.attrs.verbatim === true)
    || ("children" in block && blocksUseTransferMarkupV1(block.children)));
}
