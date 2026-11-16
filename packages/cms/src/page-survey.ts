/**
 * «Uguale alla proposta», the why: when the photograph of a built page differs from the photograph of the captured
 * one, the numbers say how much and this says where. A page is surveyed in the browser (PAGE_SURVEY_SCRIPT: its
 * visible elements in document order, each with its box and the computed styles that paint it), two surveys are
 * aligned element by element and the differences are gathered by property (surveyDifferences).
 *
 * Pure: the script is text for the caller's browser, the rest reads plain data. A survey comes from a page that is
 * untrusted: readPageSurvey takes only what has the shape and cuts every text, and what it returns is shown as text.
 */

/** The elements of one survey: a longer page is surveyed on its first 3,000 visible elements. */
export const PAGE_SURVEY_MAX_ELEMENTS = 3000;

/**
 * The survey, as a function for the page: `(options) => Promise<survey>`. Colours are compared as painted (rgb and
 * oklch of the same colour are the same), an image by what it is and not by its address (a built site renames them).
 *
 * The colours inside a gradient, a shadow or a filter are painted too (`paint`): the value keeps its text with every
 * colour as `rgba(r,g,b,a)`; a value too long for that is `start…#shape¦colours`, the hash of the value without its
 * colours and then the colours, eight hexadecimal digits each (the first 17; the others as one more hash).
 */
export const PAGE_SURVEY_SCRIPT = String.raw`(async (options) => {
  const doc = document;
  const win = doc.defaultView;
  const MAX = ${PAGE_SURVEY_MAX_ELEMENTS};
  const root = (options && options.rootSelector && doc.querySelector(options.rootSelector)) || doc.body;
  const PROPS = ["display", "position", "visibility", "opacity", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textTransform", "textAlign", "textDecorationLine", "textDecorationColor", "textDecorationStyle", "textDecorationThickness", "textUnderlineOffset", "textShadow", "textRendering", "fontKerning", "fontFeatureSettings", "wordSpacing", "textIndent", "verticalAlign", "outlineStyle", "color", "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopColor", "borderTopStyle", "borderTopLeftRadius", "boxShadow", "marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "transform", "gridTemplateColumns", "columnGap", "rowGap", "flexDirection", "flexWrap", "justifyContent", "alignItems", "objectFit", "aspectRatio", "zIndex", "overflowX", "overflowY", "maxWidth", "minHeight", "whiteSpace", "filter", "mixBlendMode", "clipPath", "listStyleType"];
  const PSEUDO = ["content", "display", "position", "width", "height", "backgroundColor", "backgroundImage", "color", "fontSize", "opacity", "transform", "borderTopWidth", "top", "left", "right", "bottom"];
  const hash = (value) => { let h = 0; for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const short = (value) => { value = String(value); return value.length > 120 ? value.slice(0, 40) + "…#" + hash(value) : value; };
  const image = (value) => String(value).replace(/url\("(?:[^"\\]|\\.)*"\)|url\([^)]*\)/g, "url(…)");
  const canvas = doc.createElement("canvas"); canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true });
  const seen = new Map();
  const color = (value) => { value = String(value); if (!pen || !/^(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/.test(value)) return value; if (seen.has(value)) return seen.get(value); pen.clearRect(0, 0, 1, 1); pen.fillStyle = "#000"; pen.fillStyle = value; pen.fillRect(0, 0, 1, 1); const d = pen.getImageData(0, 0, 1, 1).data; const result = "rgba(" + d[0] + "," + d[1] + "," + d[2] + "," + (d[3] / 255).toFixed(2) + ")"; seen.set(value, result); return result; };
  const INNER = /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)/g;
  const hex = (item) => { const n = (item.match(/[\d.]+/g) || []).map(Number); return [n[0], n[1], n[2], Math.round(n[3] * 255)].map((part) => (part < 16 ? "0" : "") + (part | 0).toString(16)).join(""); };
  const paint = (value) => {
    value = String(value);
    const colors = [];
    const painted = value.replace(INNER, (found) => { const as = color(found); colors.push(as); return as; });
    if (!pen || !colors.length) return short(value);
    const shape = value.replace(INNER, "§");
    if (shape.length + 20 * colors.length <= 120) return painted;
    const digits = colors.map(hex);
    return painted.slice(0, 40) + "…#" + hash(shape) + "¦" + digits.slice(0, 17).join("") + (digits.length > 17 ? "+" + hash(digits.slice(17).join("")) : "");
  };
  const PAINTED = new Set(["boxShadow", "textShadow", "filter"]);
  const read = (style, name) => name === "backgroundImage" ? paint(image(style[name])) : PAINTED.has(name) ? paint(style[name]) : /olor$/.test(name) ? color(style[name]) : short(style[name]);
  const out = [];
  const skip = new Set(["script", "style", "noscript", "template", "link", "meta", "title", "head", "source", "br", "wbr"]);
  const scrollY = win.scrollY;
  const visit = (element, depth) => {
    if (out.length >= MAX) return;
    const tag = element.localName;
    if (skip.has(tag)) return;
    const style = win.getComputedStyle(element);
    if (style.display === "none") return;
    const rect = element.getBoundingClientRect();
    const own = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(" ").replace(/\s+/g, " ").trim().slice(0, 40);
    const props = {};
    for (const name of PROPS) props[name] = read(style, name);
    for (const which of ["::before", "::after"]) {
      const pseudo = win.getComputedStyle(element, which);
      if (pseudo.content === "none" || pseudo.content === "normal" || pseudo.display === "none") continue;
      for (const name of PSEUDO) props[which + " " + name] = read(pseudo, name);
    }
    if (tag === "img") { props.naturalSize = element.naturalWidth + "x" + element.naturalHeight; props.loaded = String(element.complete && element.naturalWidth > 0); }
    out.push({ tag, cls: String(element.getAttribute("class") || "").slice(0, 80), text: own, rect: [Math.round(rect.left), Math.round(rect.top + scrollY), Math.round(rect.width), Math.round(rect.height)], props });
    if (tag === "svg") return;
    for (const child of element.children) visit(child, depth + 1);
  };
  if (root) visit(root, 0);
  const loaded = new Set([...doc.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, "").toLowerCase()));
  const fonts = [...new Set(out.map((item) => String(item.props.fontFamily).split(",")[0].replace(/["']/g, "").trim().toLowerCase()))].slice(0, 40).map((family) => ({ family, loaded: loaded.has(family) }));
  return { width: win.innerWidth, height: (doc.scrollingElement || doc.documentElement).scrollHeight, elements: out, fonts };
})`;

export interface SurveyedElement {
  tag: string;
  /** The element's classes, as written. */
  cls: string;
  /** Its own text (not its children's), at most 40 characters. */
  text: string;
  /** Left, top (from the top of the page), width, height. */
  rect: [number, number, number, number];
  props: Record<string, string>;
}

export interface PageSurvey {
  width: number;
  height: number;
  elements: SurveyedElement[];
  /** The first family of every font the page asks for, and whether the browser had it loaded. */
  fonts: Array<{ family: string; loaded: boolean }>;
}

/** What PAGE_SURVEY_SCRIPT gave, read as untrusted; null when it is not a survey. */
export function readPageSurvey(value: unknown): PageSurvey | null {
  if (typeof value !== "object" || value === null) return null;
  const survey = value as Record<string, unknown>;
  if (typeof survey.width !== "number" || typeof survey.height !== "number" || !Number.isFinite(survey.width) || !Number.isFinite(survey.height) || !Array.isArray(survey.elements)) return null;
  const elements: SurveyedElement[] = [];
  for (const item of survey.elements.slice(0, PAGE_SURVEY_MAX_ELEMENTS)) {
    if (typeof item !== "object" || item === null) return null;
    const element = item as Record<string, unknown>;
    const rect = element.rect;
    if (typeof element.tag !== "string" || !Array.isArray(rect) || rect.length !== 4 || rect.some((side) => typeof side !== "number" || !Number.isFinite(side)) || typeof element.props !== "object" || element.props === null) return null;
    const props: Record<string, string> = {};
    for (const [name, style] of Object.entries(element.props as Record<string, unknown>).slice(0, 120)) if (typeof style === "string") props[name.slice(0, 60)] = style.slice(0, 200);
    elements.push({ tag: element.tag.slice(0, 40), cls: typeof element.cls === "string" ? element.cls.slice(0, 80) : "", text: typeof element.text === "string" ? element.text.slice(0, 40) : "", rect: rect as [number, number, number, number], props });
  }
  const fonts = Array.isArray(survey.fonts) ? survey.fonts.slice(0, 40).flatMap((font) => (typeof font === "object" && font !== null && typeof (font as { family?: unknown }).family === "string" ? [{ family: ((font as { family: string }).family).slice(0, 80), loaded: (font as { loaded?: unknown }).loaded === true }] : [])) : [];
  return { width: survey.width, height: survey.height, elements, fonts };
}

const key = (item: SurveyedElement): string => `${item.tag}|${item.text}`;
const LOOK_AHEAD = 12;

/**
 * Pairs the elements of two surveys in order: two pointers with a look ahead, since a built site has a few elements
 * more or fewer than the page it came from (a wrapper around an image, a list rewritten). Elements are the same when
 * tag and own text are; where nothing matches nearby, two of the same tag are paired anyway.
 */
export function alignSurveys(left: readonly SurveyedElement[], right: readonly SurveyedElement[]): { pairs: Array<[SurveyedElement, SurveyedElement]>; onlyLeft: SurveyedElement[]; onlyRight: SurveyedElement[] } {
  const pairs: Array<[SurveyedElement, SurveyedElement]> = [];
  const onlyLeft: SurveyedElement[] = [];
  const onlyRight: SurveyedElement[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i] as SurveyedElement;
    const b = right[j] as SurveyedElement;
    if (key(a) === key(b)) { pairs.push([a, b]); i++; j++; continue; }
    let found: [number, number] | null = null;
    for (let distance = 1; distance <= LOOK_AHEAD && !found; distance++) {
      for (let x = 0; x <= distance; x++) {
        const y = distance - x;
        const ahead = left[i + x];
        const other = right[j + y];
        if (ahead && other && key(ahead) === key(other)) { found = [x, y]; break; }
      }
    }
    if (!found) {
      if (a.tag === b.tag) pairs.push([a, b]);
      else { onlyLeft.push(a); onlyRight.push(b); }
      i++; j++;
      continue;
    }
    for (let x = 0; x < found[0]; x++) onlyLeft.push(left[i + x] as SurveyedElement);
    for (let y = 0; y < found[1]; y++) onlyRight.push(right[j + y] as SurveyedElement);
    i += found[0];
    j += found[1];
  }
  while (i < left.length) onlyLeft.push(left[i++] as SurveyedElement);
  while (j < right.length) onlyRight.push(right[j++] as SurveyedElement);
  return { pairs, onlyLeft, onlyRight };
}

export interface SurveyDifferences {
  /** Elements found in both pages, and those only one has. */
  paired: number;
  onlyLeft: number;
  onlyRight: number;
  onlyLeftExamples: string[];
  onlyRightExamples: string[];
  /** Paired elements whose box moved or changed size by more than 2 pixels. */
  boxes: number;
  boxExamples: string[];
  /** The computed styles that differ, the most frequent first: `examples` are «element: left → right». */
  properties: Array<{ property: string; count: number; examples: string[] }>;
  /** Fonts the left page had loaded and the right page did not. */
  fontsMissing: string[];
  heights: [number, number];
}

const elementName = (item: SurveyedElement): string => `${item.tag}${item.cls ? `.${item.cls.split(/\s+/u)[0]}` : ""}${item.text ? ` «${item.text.slice(0, 24)}»` : ""}`;
const RGBA = /^rgba\([^()]*\)$/u;
const numbers = (value: string): number[] => (value.match(/[\d.]+/gu) ?? []).map(Number);

/**
 * Two colours are the same within two levels as painted: a translucent colour is read back from the canvas through its
 * alpha (at 30 % one step of the canvas is three levels of the colour), so its tolerance grows as it fades.
 */
function sameColor(p: readonly number[], q: readonly number[]): boolean {
  if (p.length !== 4 || q.length !== 4) return false;
  const [pa, qa] = [p[3] as number, q[3] as number];
  if (Math.abs(pa - qa) > 0.02) return false;
  if (Math.max(pa, qa) <= 0.02) return true;
  const levels = Math.max(2, 2 / Math.min(pa, qa));
  return [0, 1, 2].every((index) => Math.abs((p[index] as number) - (q[index] as number)) <= levels);
}

const INNER_COLOR = /rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),([\d.]{1,6})\)/gu;
const LONG_PAINTED = /…#([0-9a-z]{1,8})¦((?:[0-9a-f]{8}){1,17})(\+[0-9a-z]{1,8})?$/u;

/**
 * A gradient, a shadow or a filter as PAGE_SURVEY_SCRIPT's `paint` wrote it: what it is without its colours, and the
 * colours. Null when the value has no painted colour.
 */
function paintedParts(value: string): { shape: string; colors: number[][] } | null {
  const long = LONG_PAINTED.exec(value);
  if (long) {
    const digits = long[2] as string;
    const colors: number[][] = [];
    for (let at = 0; at < digits.length; at += 8) colors.push([0, 2, 4, 6].map((offset, index) => Number.parseInt(digits.slice(at + offset, at + offset + 2), 16) / (index === 3 ? 255 : 1)));
    return { shape: `#${long[1]}${long[3] ?? ""}`, colors };
  }
  const colors: number[][] = [];
  const shape = value.replace(INNER_COLOR, (_found, r: string, g: string, b: string, a: string) => { colors.push([Number(r), Number(g), Number(b), Number(a)]); return "§"; });
  return colors.length ? { shape, colors } : null;
}

/** The size of the text is told apart to a twentieth of a pixel: a fluid size half a pixel larger redraws every glyph. */
const FINE = new Set(["fontSize", "letterSpacing", "wordSpacing"]);

function sameStyle(left: string | undefined, right: string | undefined, property = ""): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (RGBA.test(left) && RGBA.test(right)) return sameColor(numbers(left), numbers(right));
  // Half a pixel of a box is rounding, not a difference.
  if (/^-?[\d.]+px$/u.test(left) && /^-?[\d.]+px$/u.test(right)) return Math.abs(Number.parseFloat(left) - Number.parseFloat(right)) < (FINE.has(property.replace(/^::(?:before|after) /u, "")) ? 0.05 : 0.6);
  // The same gradient or shadow with the same colours as painted, however each side wrote them.
  const p = paintedParts(left);
  const q = p && paintedParts(right);
  if (p && q) return p.shape === q.shape && p.colors.length === q.colors.length && p.colors.every((color, index) => sameColor(color, q.colors[index] as number[]));
  return false;
}

/** A value for an example: the colours a long painted value carries after its hash are for comparing, not for reading. */
const shown = (value: string | undefined): string => (value === undefined ? "—" : value.replace(LONG_PAINTED, "…"));

const AUTO_RATIO = /^auto(?:\s|$)/u;

/**
 * An image that loaded on both sides keeps its own proportions whatever `width` and `height` attributes say: «auto»
 * and «auto 1200 / 800» (the attributes the conversion adds) draw the same box, and are not a difference.
 */
function sameLoadedRatio(left: SurveyedElement, right: SurveyedElement): boolean {
  return left.tag === "img" && right.tag === "img" && left.props.loaded === "true" && right.props.loaded === "true" && left.props.naturalSize === right.props.naturalSize && AUTO_RATIO.test(left.props.aspectRatio ?? "") && AUTO_RATIO.test(right.props.aspectRatio ?? "");
}

/**
 * Why two surveyed pages differ: `left` is the page as it should be (the captured proposal), `right` the built one.
 * At most `limit` properties, three examples each; every text is cut, so the result is small enough to be saved.
 */
export function surveyDifferences(left: PageSurvey, right: PageSurvey, limit = 12): SurveyDifferences {
  const { pairs, onlyLeft, onlyRight } = alignSurveys(left.elements, right.elements);
  const byProperty = new Map<string, { count: number; examples: string[] }>();
  let boxes = 0;
  const boxExamples: string[] = [];
  for (const [a, b] of pairs) {
    for (const property of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
      const x = a.props[property];
      const y = b.props[property];
      if (sameStyle(x, y, property)) continue;
      if (property === "aspectRatio" && sameLoadedRatio(a, b)) continue;
      const entry = byProperty.get(property) ?? { count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 3) entry.examples.push(`${elementName(a)}: ${shown(x)} → ${shown(y)}`.slice(0, 200));
      byProperty.set(property, entry);
    }
    const moved = Math.abs(a.rect[0] - b.rect[0]) > 2 || Math.abs(a.rect[1] - b.rect[1]) > 2;
    const resized = Math.abs(a.rect[2] - b.rect[2]) > 2 || Math.abs(a.rect[3] - b.rect[3]) > 2;
    if (moved || resized) {
      boxes += 1;
      if (resized && boxExamples.length < 4) boxExamples.push(`${elementName(a)}: ${a.rect[2]}×${a.rect[3]} → ${b.rect[2]}×${b.rect[3]}`.slice(0, 200));
    }
  }
  const properties = [...byProperty].sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0])).slice(0, Math.max(0, limit)).map(([property, entry]) => ({ property, ...entry }));
  const fontsMissing = left.fonts.filter((font) => font.loaded && !right.fonts.some((other) => other.family === font.family && other.loaded)).map((font) => font.family).slice(0, 8);
  return {
    paired: pairs.length,
    onlyLeft: onlyLeft.length,
    onlyRight: onlyRight.length,
    onlyLeftExamples: onlyLeft.slice(0, 4).map(elementName),
    onlyRightExamples: onlyRight.slice(0, 4).map(elementName),
    boxes,
    boxExamples,
    properties,
    fontsMissing,
    heights: [Math.round(left.height), Math.round(right.height)],
  };
}
