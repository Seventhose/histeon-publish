import { decodeHTMLAttribute, decodeHTMLStrict } from "entities";
import postcss, { CssSyntaxError, type ChildNode, type Container, type Root } from "postcss";
import type { XbBlock } from "../.generated/histos-dsl/index.js";
import { HISTOS_ACSS_MAP } from "./histos-css-assets.generated.js";
import { histosFrameworkData, histosTokenNames } from "./histos-css.js";
import { asciiLower, rewriteInlineMarkupAttributes } from "./transfer-markup.js";

/**
 * Framework names in a prototype (queue C1, C2). A prototype may be written with Automatic.css names
 * (`framework: "acss"`): the import gives them their Histeon CSS names with the builder's own table
 * (`assets/histos-css/acss-map.json`, from `AcssImport`), or keeps them for a site where ACSS is active. Either way the
 * report names what would show without a value or a rule: a `var()` that nothing defines, an ACSS class without a rule.
 * CSS is read as the browser reads it (strings, comments, unquoted url(), nesting, character references in attributes,
 * selectors on the text of `class`, rules the browser drops) and in one pass: a prototype may hold up to 32 MB, and the
 * import reads it synchronously. Rules come from postcss, which reads valid CSS as the browser does; CSS it cannot read
 * or reads otherwise counts every class it names as defined, so the conversion only ever skips more.
 */

/** Automatic.css variable → Histeon CSS token, both without `--`: the first token of a variable wins, as in `AcssImport::variables()`. */
export const ACSS_VARIABLES: ReadonlyMap<string, string> = (() => {
  const variables = new Map<string, string>();
  for (const [token, variable] of Object.entries(HISTOS_ACSS_MAP.tokens)) if (!variables.has(variable)) variables.set(variable, token);
  return variables;
})();

/** Automatic.css class → Histeon CSS class, only where the Histeon CSS class sets the same property from the same value. */
export const ACSS_CLASSES: ReadonlyMap<string, string> = new Map(Object.entries(HISTOS_ACSS_MAP.classes));

/**
 * Automatic.css utility classes without an equivalent: its naming joins a property and a value with "--" (`btn--primary`,
 * `bg--primary-dark`, `pad--m`). A BEM modifier of the author's own block (`card--featured`) does not start this way.
 */
const ACSS_CLASS = /^(?:text|bg|btn|section|pad|padding|margin|gap|grid|flex|width|height|radius|shadow|border|link|owl|stack|breakout|aspect|object-fit|display|visibility|overlay|col|row|justify|align|self|order|opacity|font|weight|clickable|focus|z|smart-spacing)--[a-z0-9-]+$/u;

export function isAcssClass(name: string): boolean {
  return ACSS_CLASSES.has(name) || ACSS_CLASS.test(name);
}

/**
 * Automatic.css variables outside the table, by family: its colours with their shades and transparencies
 * (`--primary-trans-20`), spaces and section spaces, text and heading sizes, radii and shadows. Any other name
 * (`--brand-colour`) is the author's, and ACSS's sheets never give it a value.
 */
const ACSS_VARIABLE = /^(?:(?:primary|secondary|tertiary|accent|base|neutral|shade|action)(?:-(?:ultra-light|light|semi-light|medium|semi-dark|dark|ultra-dark|hover|comp))?(?:-trans-\d{1,3})?|(?:section-)?space-(?:xs|s|m|l|xl|xxl)|text-(?:xs|s|m|l|xl|xxl)|h[1-6]|radius(?:-(?:xs|s|m|l|xl|xxl|circle|50))?|box-shadow-[1-9])$/u;

export function isAcssVariable(name: string): boolean {
  return ACSS_VARIABLES.has(name) || ACSS_VARIABLE.test(name);
}

/** Where names are used: "page home", "foglio Base"… at most a few per name, for the report. */
type Places = Map<string, Set<string>>;

export interface FrameworkNames {
  /** Classes in the content, as the browser reads the `class` values. */
  classes: Places;
  /**
   * Classes the project's CSS defines: a rule selects each one on its own (`.text--l`, `*.x`, `[class~="x"]`,
   * `:is(.x, …)`) and sets something, outside @media and other conditions, with nesting resolved and BEM parts (`&--l`)
   * joined as Histeon compiles the selector styles. A class a selector only narrows (`.hero .x`, `h1.x`, `.x.y`,
   * `.x:hover`, `.x::after`) or names as a context or inside `:not()` has no rule of its own, and Publish has no ACSS
   * rule for it either.
   */
  ruleClasses: Set<string>;
  /**
   * Classes a rule selects on its own and styles, also only inside @media or another condition (a responsive utility):
   * they have a rule, for the report, though not one that always applies. `ruleClasses` included.
   */
  styledClasses: Set<string>;
  /** Classes any selector of the project's CSS names, anywhere (context, state, `:not()`…): `ruleClasses` included. */
  selectorClasses: Set<string>;
  /**
   * ACSS classes with a Histeon CSS name that a selector on the text of `class` may match (`[class*="text--"]`, `^=`,
   * `$=`, `|=`, `[class="…"]`, anywhere in a selector), which their new name would stop matching: `true` where the ACSS
   * name kept next to it still matches (`*=`, `^=`), `false` where it keeps its name alone.
   */
  attributeClasses: Map<string, boolean>;
  /**
   * The places whose CSS postcss cannot read, or reads otherwise than the browser, with the reason: every class they
   * name counts as defined (and as named), since which rules the browser applies there is not known.
   */
  unreadable: Map<string, string>;
  /** `var()` references without a fallback. */
  variables: Places;
  /** Custom properties the project's CSS or a `style` attribute defines (`--name:`) or registers (`@property --name`). */
  definedVariables: Set<string>;
  /**
   * What is left of the work on nested selectors, shared by every sheet read into these names: each sheet adds four
   * times its length, so many small nesting bombs cost no more than one big one.
   */
  selectorBudget: { left: number };
}

export function emptyFrameworkNames(): FrameworkNames {
  return { classes: new Map(), ruleClasses: new Set(), styledClasses: new Set(), selectorClasses: new Set(), attributeClasses: new Map(), unreadable: new Map(), variables: new Map(), definedVariables: new Set(), selectorBudget: { left: 1_048_576 } };
}

/** The place prototype-import and acssSiteNotes give the selector styles: each top-level rule is a style, compiled by compileCss. */
export const SELECTOR_STYLES_PLACE = "stili per selettore";

const PLACES_KEPT = 3;

function addPlace(places: Places, name: string, where: string): void {
  const set = places.get(name) ?? new Set<string>();
  if (set.size < PLACES_KEPT) set.add(where);
  places.set(name, set);
}

// ---------------------------------------------------------------- reading CSS (css-syntax-3, as far as names need it)

/** CSS whitespace. */
function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isNewline(code: number): boolean {
  return code === 10 || code === 12 || code === 13;
}

/** A code point that starts a name: a letter, `_` or any non-ASCII one. */
function isNameStart(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code >= 0x80;
}

/** A code point of a name: a name start, a digit or `-` (both halves of a surrogate pair are non-ASCII). */
function isNameCode(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 57) || code === 45;
}

/** A `\` that escapes what follows: not a newline, nor the end. */
function isEscape(text: string, at: number): boolean {
  return text.charCodeAt(at) === 92 && at + 1 < text.length && !isNewline(text.charCodeAt(at + 1));
}

/** An identifier starts at `at`: a name start, `-` before one or before `-`, or an escape. */
function identStarts(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  if (code === 45) return text.charCodeAt(at + 1) === 45 || isNameStart(text.charCodeAt(at + 1)) || isEscape(text, at + 1);
  return isNameStart(code) || isEscape(text, at);
}

/** The escape at `at` (isEscape holds there) decoded, and where it ends: a hex one takes one whitespace after it. */
function readEscape(text: string, at: number): { value: string; end: number } {
  const hex = /^[0-9A-Fa-f]{1,6}/u.exec(text.slice(at + 1, at + 7))?.[0];
  if (hex === undefined) {
    const point = text.codePointAt(at + 1) ?? 0xfffd;
    return { value: String.fromCodePoint(point), end: at + (point > 0xffff ? 3 : 2) };
  }
  const point = Number.parseInt(hex, 16);
  let end = at + 1 + hex.length;
  // One whitespace after a hex escape belongs to it, CR LF as one.
  if (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) end += 2;
  else if (isSpace(text.charCodeAt(end))) end++;
  return { value: point === 0 || (point >= 0xd800 && point <= 0xdfff) || point > 0x10ffff ? "�" : String.fromCodePoint(point), end };
}

/** The name at `at` with its escapes decoded (`\62 ` is `b`), where it ends and whether it has any escape. */
function readName(text: string, at: number): { value: string; end: number; escaped: boolean } {
  let value = "";
  let from = at;
  let index = at;
  let escaped = false;
  while (index < text.length) {
    if (isNameCode(text.charCodeAt(index))) {
      index++;
      continue;
    }
    if (!isEscape(text, index)) break;
    const decoded = readEscape(text, index);
    value += text.slice(from, index) + decoded.value;
    escaped = true;
    index = decoded.end;
    from = index;
  }
  return { value: value + text.slice(from, index), end: index, escaped };
}

/**
 * The string that opens at `open` with its escapes decoded (an escaped newline continues it), and where it ends: past
 * its quote, or at the end of the text. Undefined for a bad string, one that a newline ends.
 */
function readString(text: string, open: number): { value: string; end: number } | undefined {
  const quote = text.charCodeAt(open);
  let value = "";
  let from = open + 1;
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === quote) return { value: value + text.slice(from, index), end: index + 1 };
    if (isNewline(code)) return undefined;
    if (code !== 92) {
      index++;
      continue;
    }
    value += text.slice(from, index);
    if (isEscape(text, index)) {
      const decoded = readEscape(text, index);
      value += decoded.value;
      index = decoded.end;
    } else {
      // Before a newline a `\` continues the string (CR LF as one); at the end of the text it is nothing.
      index += text.charCodeAt(index + 1) === 13 && text.charCodeAt(index + 2) === 10 ? 3 : 2;
    }
    from = index;
  }
  return { value: value + text.slice(Math.min(from, text.length)), end: text.length };
}

/** Past whitespace and comments, which may sit between any two tokens: where the next token starts. */
function skipGap(text: string, at: number): number {
  let index = at;
  for (;;) {
    const code = text.charCodeAt(index);
    if (isSpace(code)) index++;
    else if (code === 47 && text.charCodeAt(index + 1) === 42) {
      const close = text.indexOf("*/", index + 2);
      if (close < 0) return text.length;
      index = close + 2;
    } else return index;
  }
}

/** Past the comment that opens at `open`; an unclosed one runs to the end. */
function commentEnd(text: string, open: number): number {
  const close = text.indexOf("*/", open + 2);
  return close < 0 ? text.length : close + 2;
}

/** Past the string that opens at `open`: after its quote, or at a newline it does not escape, which ends it (a bad string). */
function stringEnd(text: string, open: number): number {
  const quote = text.charCodeAt(open);
  let index = open + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === quote) return index + 1;
    if (isNewline(code)) return index;
    if (code === 92) index += text.charCodeAt(index + 1) === 13 && text.charCodeAt(index + 2) === 10 ? 3 : 2;
    else index++;
  }
  return text.length;
}

/** Past the attribute selector that opens at `open`, strings and comments inside it included. */
function bracketEnd(text: string, open: number): number {
  let index = open + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 93) return index + 1;
    if (code === 34 || code === 39) index = stringEnd(text, index);
    else if (code === 47 && text.charCodeAt(index + 1) === 42) index = commentEnd(text, index);
    else index += code === 92 ? 2 : 1;
  }
  return text.length;
}

/**
 * Past an unquoted `url(…)` from its `(`: one token up to `)`, with no comment, string or function inside it
 * (css-syntax-3 §4.3.6). Undefined when a string follows: then `url(` is a function like any other.
 */
function urlTokenEnd(css: string, open: number): number | undefined {
  let index = open + 1;
  while (isSpace(css.charCodeAt(index))) index++;
  const code = css.charCodeAt(index);
  if (code === 34 || code === 39) return undefined;
  while (index < css.length && css.charCodeAt(index) !== 41) index += isEscape(css, index) ? 2 : 1;
  return Math.min(index + 1, css.length);
}

/**
 * The CSS outside strings, comments and unquoted url(), read as the CSS tokenizer reads them and scanned once:
 * `var(--name` references, `--name:` definitions at the start of a declaration and `@property --name` registrations,
 * with comments allowed between the tokens. A reference has `fallback` when a value of its own follows, or when it sits
 * inside another's fallback (`var(--a, var(--b))` needs --b only without --a). Names may hold any non-ASCII character;
 * a reference with an escape is left alone, a definition with one counts with the name it stands for.
 */
function scanCss(css: string, visit: { reference?: (name: string, fallback: boolean, start: number, end: number) => void; definition?: (name: string) => void }): void {
  let declarationStart = true;
  let depth = 0;
  /** The depths of the var() calls whose fallback is being read. */
  const fallbacks: number[] = [];
  let index = 0;
  while (index < css.length) {
    const code = css.charCodeAt(index);
    if (code === 47 && css.charCodeAt(index + 1) === 42) {
      index = commentEnd(css, index);
      continue;
    }
    if (code === 34 || code === 39) {
      index = stringEnd(css, index);
      declarationStart = false;
      continue;
    }
    if (code === 92) {
      index += isEscape(css, index) ? 2 : 1;
      declarationStart = false;
      continue;
    }
    if (code === 59 || code === 123 || code === 125) {
      declarationStart = true;
      index++;
      continue;
    }
    if (code === 40) {
      depth++;
      declarationStart = false;
      index++;
      continue;
    }
    if (code === 41) {
      if (fallbacks.at(-1) === depth) fallbacks.pop();
      depth = Math.max(0, depth - 1);
      index++;
      continue;
    }
    if (isSpace(code)) {
      index++;
      continue;
    }
    if (code === 64) {
      // `@property --name { … initial-value: … }`: a custom property the author registers, with its own value.
      const keyword = readName(css, index + 1);
      if (!keyword.escaped && asciiLower(keyword.value) === "property") {
        const at = skipGap(css, keyword.end);
        if (css.startsWith("--", at)) {
          const name = readName(css, at + 2);
          if (name.value) visit.definition?.(name.value);
        }
      }
      declarationStart = false;
      index = keyword.end;
      continue;
    }
    if (!isNameCode(code)) {
      declarationStart = false;
      index++;
      continue;
    }
    // A name, read whole: `var` and `url` count only as names of their own (`myvar(` is another function).
    let end = index + 1;
    while (end < css.length && isNameCode(css.charCodeAt(end))) end++;
    if (declarationStart && code === 45 && css.charCodeAt(index + 1) === 45) {
      const name = readName(css, index + 2);
      if (name.value && css.charCodeAt(skipGap(css, name.end)) === 58) visit.definition?.(name.value);
    }
    declarationStart = false;
    const word = end - index === 3 && css.charCodeAt(end) === 40 ? asciiLower(css.slice(index, end)) : "";
    if (word === "url") {
      const after = urlTokenEnd(css, end);
      if (after !== undefined) {
        index = after;
        continue;
      }
    }
    if (word !== "var") {
      index = end;
      continue;
    }
    depth++;
    const at = skipGap(css, end + 1);
    if (css.charCodeAt(at) !== 45 || css.charCodeAt(at + 1) !== 45) {
      index = at;
      continue;
    }
    const name = readName(css, at + 2);
    const after = skipGap(css, name.end);
    const comma = css.charCodeAt(after) === 44;
    if (name.value && !name.escaped) visit.reference?.(name.value, comma || fallbacks.length > 0, at, name.end);
    if (comma) fallbacks.push(depth);
    // On after the name and its comma: the fallback is read like any other CSS.
    index = comma ? after + 1 : after;
  }
}

/** The line `at` is on, for the report: CR LF, CR, LF and FF each end one, as in CSS. */
function lineAt(text: string, at: number): number {
  let line = 1;
  for (let index = 0; index < at; index++) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 12 || (code === 13 && text.charCodeAt(index + 1) !== 10)) line++;
  }
  return line;
}

/** Whether postcss starts a word at `at`: after whitespace or a token of its own, not inside a longer word (`,url`). */
function postcssWordStarts(css: string, at: number): boolean {
  const code = css.charCodeAt(at - 1);
  return at === 0 || isSpace(code) || code === 34 || code === 39 || code === 40 || code === 41 || code === 58 || code === 59 || code === 91 || code === 93 || code === 123 || code === 125;
}

/**
 * A stylesheet for postcss, read once with the browser's tokens. With `skip`, the `<!--` and `-->` between two
 * top-level rules, which the browser skips and postcss reads as words, become spaces (lines and columns stay).
 * `misread`: where postcss ends a token elsewhere than the browser, and so may show a rule the browser has not or hide
 * one it has (`.a{content:"x⏎}.b{…}`: a newline ends the string, and for the browser .b is a rule), with the reason for
 * the report: a string that a newline ends, which postcss reads on to the next quote; an unquoted url() that postcss
 * does not read whole (after whitespace, written otherwise than `url`, or ending a longer word as in `,url(`) and that
 * holds a quote, a `(` or a `/*`, which postcss reads as a string, a parenthesis or a comment (the browser drops such a
 * url() anyway).
 * Blocks nest as the browser's tokenizer nests them: a `)`, `]` or `}` closes only the block its kind opened, and any
 * other is a token like the rest (`.a{b:c)}`: the `)` closes nothing, the `}` closes the rule). One shared count would
 * let a stray `)` close the rule or the @media around it, and the top level would start in the wrong place.
 */
function forPostcss(css: string, skip: boolean): { css: string; misread?: string } {
  let out = "";
  let from = 0;
  /** The closer each open block waits for (`}`, `)` or `]`), innermost last; and whether the next token starts a top-level rule. */
  const open: number[] = [];
  let between = true;
  let index = 0;
  while (index < css.length) {
    const code = css.charCodeAt(index);
    if (code === 47 && css.charCodeAt(index + 1) === 42) {
      index = commentEnd(css, index);
      continue;
    }
    if (isSpace(code)) {
      index++;
      continue;
    }
    if (skip && open.length === 0 && between && (css.startsWith("<!--", index) || css.startsWith("-->", index))) {
      const length = code === 60 ? 4 : 3;
      out += `${css.slice(from, index)}${" ".repeat(length)}`;
      index += length;
      from = index;
      continue;
    }
    between = false;
    if (code === 34 || code === 39) {
      let at = index + 1;
      while (at < css.length && css.charCodeAt(at) !== code && !isNewline(css.charCodeAt(at))) at += css.charCodeAt(at) !== 92 ? 1 : css.charCodeAt(at + 1) === 13 && css.charCodeAt(at + 2) === 10 ? 3 : 2;
      if (at < css.length && css.charCodeAt(at) !== code) return { css, misread: `riga ${lineAt(css, at)}: una stringa va a capo senza chiudersi` };
      index = at + 1;
    } else if (identStarts(css, index)) {
      const name = readName(css, index);
      const end = css.charCodeAt(name.end) === 40 && asciiLower(name.value) === "url" ? urlTokenEnd(css, name.end) : undefined;
      if (end === undefined) index = name.end;
      else {
        const whole = css.startsWith("url(", index) && !isSpace(css.charCodeAt(name.end + 1)) && postcssWordStarts(css, index);
        if (!whole && /["'(]|\/\*/u.test(css.slice(name.end + 1, end))) return { css, misread: `riga ${lineAt(css, index)}: un url() senza virgolette contiene una virgoletta, una parentesi o /*` };
        index = end;
      }
    } else {
      if (code === 123 || code === 40 || code === 91) open.push(code === 123 ? 125 : code === 40 ? 41 : 93);
      else if (code === open.at(-1)) {
        open.pop();
        between = code === 125 && open.length === 0;
      } else if (code === 59 && open.length === 0) between = true;
      index++;
    }
  }
  return { css: from ? out + css.slice(from) : css };
}

// ---------------------------------------------------------------- reading selectors

/** Without leading and trailing CSS whitespace (String#trim also takes U+00A0, a name character in CSS). */
function trimCss(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/** A selector list split at its top-level commas, each selector trimmed. */
function selectorList(selector: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let from = 0;
  let index = 0;
  while (index < selector.length) {
    const code = selector.charCodeAt(index);
    if (code === 34 || code === 39) index = stringEnd(selector, index);
    else if (code === 47 && selector.charCodeAt(index + 1) === 42) index = commentEnd(selector, index);
    else if (code === 92) index += 2;
    else {
      if (code === 40 || code === 91) depth++;
      else if ((code === 41 || code === 93) && depth > 0) depth--;
      else if (code === 44 && depth === 0) {
        items.push(selector.slice(from, index));
        from = index + 1;
      }
      index++;
    }
  }
  items.push(selector.slice(from));
  return items.map(trimCss).filter((item) => item !== "");
}

/** Past the `)` that closes the `(` at `open`, or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 34 || code === 39) index = stringEnd(text, index);
    else if (code === 47 && text.charCodeAt(index + 1) === 42) index = commentEnd(text, index);
    else if (code === 92) index += 2;
    else {
      if (code === 40) depth++;
      else if (code === 41 && --depth === 0) return index;
      index++;
    }
  }
  return -1;
}

function withoutComments(text: string): string {
  let out = "";
  let from = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 34 || code === 39) index = stringEnd(text, index);
    else if (code === 92) index += 2;
    else if (code === 47 && text.charCodeAt(index + 1) === 42) {
      out += text.slice(from, index);
      index = commentEnd(text, index);
      from = index;
    } else index++;
  }
  return out + text.slice(from);
}

/** A selector on the text of `class`: its operator (`~=`, `*=`…), its value and whether it ignores case (`i`). */
interface ClassAttribute { operator: string; value: string; insensitive: boolean }

/**
 * The attribute selector from `open` to `end` (past its `]`) when it reads `class`, as the browser reads it: the name
 * in any case and with escapes, without a namespace or with `*|` or `|` (HTML's attributes have none), comments
 * between the tokens, the value as an identifier or a string, an `i` or `s` flag. Undefined for any other attribute,
 * a bare `[class]` (renaming keeps it matching) and a selector the browser refuses.
 */
function classAttribute(selector: string, open: number, end: number): ClassAttribute | undefined {
  let at = skipGap(selector, open + 1);
  const pipe = (from: number) => selector.charCodeAt(from) === 124 && selector.charCodeAt(from + 1) !== 61;
  if (selector.charCodeAt(at) === 42 && pipe(at + 1)) at += 2;
  else if (pipe(at)) at++;
  if (!identStarts(selector, at)) return undefined;
  const name = readName(selector, at);
  // `class|x` is the attribute x in a namespace named class.
  if (asciiLower(name.value) !== "class" || pipe(name.end)) return undefined;
  at = skipGap(selector, name.end);
  const code = selector.charCodeAt(at);
  let operator = "=";
  if ((code === 126 || code === 124 || code === 94 || code === 36 || code === 42) && selector.charCodeAt(at + 1) === 61) operator = `${selector[at]}=`;
  else if (code !== 61) return undefined;
  at = skipGap(selector, at + operator.length);
  let value: { value: string; end: number } | undefined;
  if (selector.charCodeAt(at) === 34 || selector.charCodeAt(at) === 39) value = readString(selector, at);
  else if (identStarts(selector, at)) value = readName(selector, at);
  if (value === undefined) return undefined;
  at = skipGap(selector, value.end);
  let insensitive = false;
  if (identStarts(selector, at)) {
    const flag = readName(selector, at);
    const lower = asciiLower(flag.value);
    if (lower !== "i" && lower !== "s") return undefined;
    insensitive = lower === "i";
    at = skipGap(selector, flag.end);
  }
  return at === end - 1 && selector.charCodeAt(at) === 93 ? { operator, value: value.value, insensitive } : undefined;
}

/**
 * The class `[class~="x"]` selects, which is `.x`: lower case with the `i` flag (ACSS's names are), none for a value
 * that is empty or holds whitespace (it matches nothing).
 */
function classWord(attribute: ClassAttribute): string | undefined {
  if (attribute.operator !== "~=" || attribute.value === "" || /[\t\n\f\r ]/u.test(attribute.value)) return undefined;
  return attribute.insensitive ? asciiLower(attribute.value) : attribute.value;
}

/** The longest ACSS class with a Histeon CSS name: a longer piece of text is inside none. */
const ACSS_CLASS_LONGEST = Math.max(0, ...[...ACSS_CLASSES.keys()].map((name) => name.length));

/** Every piece of text inside an ACSS class with a Histeon CSS name, in lower case → those classes; built once. */
let acssPieces: Map<string, string[]> | undefined;

/**
 * The ACSS classes with a Histeon CSS name that hold `piece` (in any case with `insensitive`): as their whole name with
 * `start` and `end`, as its start with `start` alone, as its end with `end` alone, anywhere without either.
 */
function acssClassesHolding(piece: string, insensitive: boolean, start: boolean, end: boolean): string[] {
  if (piece.length > ACSS_CLASS_LONGEST) return [];
  if (acssPieces === undefined) {
    acssPieces = new Map();
    for (const name of ACSS_CLASSES.keys()) {
      const lower = asciiLower(name);
      const pieces = new Set<string>();
      for (let from = 0; from < lower.length; from++) for (let to = from + 1; to <= lower.length; to++) pieces.add(lower.slice(from, to));
      for (const item of pieces) acssPieces.set(item, [...(acssPieces.get(item) ?? []), name]);
    }
  }
  const text = insensitive ? asciiLower(piece) : piece;
  return (acssPieces.get(asciiLower(piece)) ?? []).filter((name) => {
    const own = insensitive ? asciiLower(name) : name;
    return start && end ? own === text : start ? own.startsWith(text) : end ? own.endsWith(text) : own.includes(text);
  });
}

/**
 * A selector on the text of `class` other than `~=` (`[class*="text--"]`, `^=`, `$=`, `|=`, `=`): the ACSS classes
 * with a Histeon CSS name it may match through their own text. Each word of its value (whitespace apart) stands for a
 * class: a whole one where whitespace or an anchor (`^=`, `|=` and `=` at the start, `$=` and `=` at the end) bounds it
 * on both sides, its start or its end where one side only, any part of it where neither. Renamed, such a class changes
 * the text and the selector may stop matching: kept next to the new name (`true`) where what the word stands for ends
 * inside it, since the new name goes after it (`[class*="text--"]`, `[class^="text--"]`); alone (`false`, which wins)
 * where the word reaches its end (`[class$="primary"]`, `[class="text--l"]`, and `|=`, which also matches the value
 * alone). A selector the new name would make match is the author's to write for it, as `.xb-…` is.
 * `seen`: the words read in this CSS already, which nesting repeats.
 */
function classTextNames(names: FrameworkNames, attribute: ClassAttribute, seen: Set<string>): void {
  const { operator, value, insensitive } = attribute;
  const words = value.split(/[\t\n\f\r ]+/u).filter((word) => word !== "");
  const lead = /^[\t\n\f\r ]/u.test(value);
  const trail = /[\t\n\f\r ]$/u.test(value);
  words.forEach((word, index) => {
    const start = index > 0 || lead || operator === "^=" || operator === "|=" || operator === "=";
    const end = index < words.length - 1 || trail || operator === "$=" || operator === "=";
    const together = !end && operator !== "|=";
    const key = `${start ? "<" : "-"}${end ? ">" : "-"}${together ? "+" : "-"}${insensitive ? "i" : "s"}${word}`;
    if (seen.has(key)) return;
    const classes = acssClassesHolding(word, insensitive, start, end);
    if (!classes.length) return;
    seen.add(key);
    for (const name of classes) if (names.attributeClasses.get(name) !== false) names.attributeClasses.set(name, together);
  });
}

/**
 * The classes a selector names, anywhere in it: `.x` and `[class~="x"]`, not strings. Any other selector on the text
 * of `class` goes to `attribute`. Read with the browser's tokens, unquoted url() included, so a whole stylesheet reads
 * as the browser reads it too (`url(x/*)` opens no comment).
 */
function selectorClassNames(selector: string, attribute?: (found: ClassAttribute) => void): string[] {
  const classes: string[] = [];
  let index = 0;
  while (index < selector.length) {
    const code = selector.charCodeAt(index);
    if (code === 34 || code === 39) index = stringEnd(selector, index);
    else if (code === 47 && selector.charCodeAt(index + 1) === 42) index = commentEnd(selector, index);
    else if (code === 91) {
      const end = bracketEnd(selector, index);
      const found = classAttribute(selector, index, end);
      const word = found && classWord(found);
      if (word !== undefined) classes.push(word);
      else if (found && found.operator !== "~=") attribute?.(found);
      index = end;
    } else if (code === 46 && identStarts(selector, index + 1)) {
      const name = readName(selector, index + 1);
      classes.push(name.value);
      index = name.end;
    } else if (identStarts(selector, index)) {
      const name = readName(selector, index);
      const end = selector.charCodeAt(name.end) === 40 && asciiLower(name.value) === "url" ? urlTokenEnd(selector, name.end) : undefined;
      index = end ?? name.end;
    } else index += code === 92 ? 2 : 1;
  }
  return classes;
}

/** How deep `:is(:is(…))` is read for the classes a selector selects on its own: each level reads the selector again. */
const IS_DEPTH_READ = 4;

/**
 * The classes a selector selects on its own: `.x`, `*.x`, `[class~="x"]` (the same), or `:is()` / `:where()` of a
 * list that holds such a selector. Anything else narrows the class (a tag, another class, a state, a pseudo-element, a
 * context) or does not select it at all (`:not(.x)`, `.x .y`, `[class="x"]`, which wants no other class).
 */
function aloneClasses(selector: string, depth = 0): string[] {
  const item = trimCss(selector.includes("/*") ? withoutComments(selector) : selector);
  const at = item.charCodeAt(0) === 42 ? 1 : 0;
  const code = item.charCodeAt(at);
  if (code === 46 && identStarts(item, at + 1)) {
    const name = readName(item, at + 1);
    return name.end === item.length ? [name.value] : [];
  }
  if (code === 91) {
    const end = bracketEnd(item, at);
    const found = end === item.length ? classAttribute(item, at, end) : undefined;
    const word = found && classWord(found);
    return word === undefined ? [] : [word];
  }
  if (code === 58 && depth < IS_DEPTH_READ) {
    const pseudo = readName(item, at + 1);
    const name = pseudo.escaped ? "" : asciiLower(pseudo.value);
    if ((name === "is" || name === "where") && item.charCodeAt(pseudo.end) === 40 && closeParen(item, pseudo.end) === item.length - 1) {
      return selectorList(item.slice(pseudo.end + 1, -1)).flatMap((part) => aloneClasses(part, depth + 1));
    }
  }
  return [];
}

/** `&__part` / `&--variant` as every selector of the list: compileCss hoists such a rule as a sibling with the joined name. */
function isBemList(items: string[]): boolean {
  return items.length > 0 && items.every((item) => item.startsWith("&__") || item.startsWith("&--"));
}

/**
 * CSS nesting as the browser reads it: `&` is the parent, written `:is(parent)` (so in `&--x` the `--x` is a tag,
 * not part of a class), and a selector without `&` is relative to the parent.
 */
function nestedSelector(item: string, parent: string): string {
  let out = "";
  let from = 0;
  let nested = false;
  let index = 0;
  while (index < item.length) {
    const code = item.charCodeAt(index);
    if (code === 34 || code === 39) index = stringEnd(item, index);
    else if (code === 47 && item.charCodeAt(index + 1) === 42) index = commentEnd(item, index);
    else if (code === 91) index = bracketEnd(item, index);
    else if (code === 92) index += 2;
    else {
      if (code === 38) {
        out += `${item.slice(from, index)}:is(${parent})`;
        from = index + 1;
        nested = true;
      }
      index++;
    }
  }
  return nested ? out + item.slice(from) : `${parent} ${item}`;
}

/** How many nested levels are read: deeper rules (no real stylesheet has them) name nothing. */
const NESTING_READ = 64;

/** At-rules whose block, outside any style rule, is a list of rules (in a style rule or @scope, a style's body). */
const RULE_LIST = /^(?:media|supports|container|layer|starting-style)$/u;

/** Where postcss's tree is not the browser's, found while reading it: the CSS is read as unreadable (the message). */
class PostcssMisread extends Error {}

/** A text that is one identifier, as a custom property's name must be. */
function isIdentifier(text: string): boolean {
  return identStarts(text, 0) && readName(text, 0).end === text.length;
}

/** A selector that starts with `<!--` or `-->`, after whitespace and comments: no selector the browser reads. */
function startsWithHtmlComment(selector: string): boolean {
  const at = skipGap(selector, 0);
  return selector.startsWith("<!--", at) || selector.startsWith("-->", at);
}

/**
 * The classes the rules of a stylesheet name and define, nesting resolved. In the selector styles (`styles`) each
 * top-level rule is a style compiled by compileCss, which hoists `&__x` / `&--x` parts (every selector of the list, also
 * inside @media, @container, @supports or @layer) as rules with the joined name (`.text` + `&--l` → `.text--l`); any
 * other nested rule, and all of a global sheet, is CSS nesting. `entry` is a style's selector when `css` is its body.
 * Nesting multiplies selectors (a list in a list…): past a budget proportional to all the CSS read into `names`, deeper
 * rules are not read.
 * A global sheet reaches the browser as written, so a rule the browser drops there names nothing (see `visit`), and
 * the `<!--` / `-->` it skips between rules are no part of a selector. CSS that postcss cannot read, or reads
 * otherwise than the browser (forPostcss), is not guessed at: every class its text names (as the browser reads the
 * tokens) counts as defined, so none is renamed or reported without a rule (the conversion only ever skips more), and
 * `names.unreadable` keeps the place with the reason, for the report. With `unparsed`, the reason a sheet is not to be
 * parsed (a global sheet past prototype-import's parse bounds), it is read so without trying.
 */
function collectSelectorNames(names: FrameworkNames, css: string, where: string, styles: boolean, entry?: string, unparsed?: string): void {
  const seen = new Set<string>();
  const attribute = (found: ClassAttribute) => classTextNames(names, found, seen);
  /** A global sheet: the browser reads it as written, where compileCss rewrites a style. */
  const asWritten = !styles && entry === undefined;
  let root: Root | undefined;
  let reason = unparsed;
  if (reason === undefined) {
    const prepared = forPostcss(css, asWritten);
    reason = prepared.misread;
    if (reason === undefined) {
      try {
        root = postcss.parse(prepared.css);
      } catch (error) {
        reason = error instanceof CssSyntaxError ? `riga ${error.line ?? "?"}: ${error.reason}` : "CSS non leggibile";
      }
    }
  }
  const failSafe = (why: string) => {
    if (!names.unreadable.has(where)) names.unreadable.set(where, why);
    for (const name of selectorClassNames(css, attribute)) {
      names.selectorClasses.add(name);
      names.styledClasses.add(name);
      names.ruleClasses.add(name);
    }
  };
  if (root === undefined) {
    failSafe(reason ?? "CSS non leggibile");
    return;
  }
  const top = root;
  const budget = names.selectorBudget;
  budget.left += 4 * css.length;
  /** Spends `cost` characters of resolved selectors: false once the budget is gone. */
  const spend = (cost: number): boolean => {
    budget.left -= cost;
    return budget.left >= 0;
  };
  /** `styles`: the rule sets something; `always`: and not only under a condition. */
  const record = (items: string[], styles: boolean, always: boolean) => {
    for (const item of items) {
      for (const name of selectorClassNames(item, attribute)) names.selectorClasses.add(name);
      if (styles) {
        for (const name of aloneClasses(item)) {
          names.styledClasses.add(name);
          if (always) names.ruleClasses.add(name);
        }
      }
    }
  };
  /**
   * Each list of parents an at-rule's declarations styled (1 under a condition, 2 always): at-rules pass the same list
   * down, and reading it again for each of thousands of `@media{x:y}` would cost its length every time, uncharged.
   */
  const styledParents = new WeakMap<string[], number>();
  /** A rule's own declarations: those of a nested @media or rule apply only there. */
  const declares = (rule: Container<ChildNode>) => (rule.nodes ?? []).some((node) => node.type === "decl");
  const joined = (parents: string[], parts: string[]): string[] | undefined => {
    const out: string[] = [];
    for (const parent of parents) {
      for (const part of parts) {
        if (!spend(parent.length + part.length)) return undefined;
        out.push(parent + part.slice(1));
      }
    }
    return out;
  };
  const nested = (parents: string[], parts: string[]): string[] | undefined => {
    const out: string[] = [];
    for (const part of parts) {
      let ampersands = 0;
      for (let index = 0; index < part.length; index++) if (part.charCodeAt(index) === 38) ampersands++;
      for (const parent of parents) {
        if (!spend(part.length + Math.max(1, ampersands) * (parent.length + 5))) return undefined;
        out.push(nestedSelector(part, parent));
      }
    }
    return out;
  };
  /**
   * `compile`: the container's rule is one compileCss compiles (a style, or a BEM part it hoists), so its BEM parts are
   * hoisted too; `conditional`: inside an at-rule other than @layer, where a rule applies only sometimes; `list`: a list
   * of rules the browser reads as written (a global sheet; @media, @supports, @container, @layer, @starting-style outside
   * any style rule), where whatever stands between two rules (a stray `;`, a declaration, and a statement at-rule after
   * them) starts the next rule's selector: the browser drops that rule, or at-rule, with all it holds.
   */
  const visit = (container: Container<ChildNode>, parents: string[] | undefined, compile: boolean, conditional: boolean, level: number, list: boolean): void => {
    if (level > NESTING_READ) return;
    let stray = false;
    for (const node of container.nodes ?? []) {
      // postcss reads `--name: … {…}` as a custom property holding what follows, braces and all; the browser does so
      // only in a style's body and for a name that is one identifier (`-->` is none): elsewhere what follows is rules.
      if (node.type === "decl" && node.prop.startsWith("--") && node.value.includes("{") && (list || !isIdentifier(node.prop))) {
        throw new PostcssMisread(`riga ${node.source?.start?.line ?? "?"}: postcss legge «${node.prop.slice(0, 40)}» come una proprietà che contiene le regole seguenti, il browser no`);
      }
      if (list) {
        // postcss keeps a stray `;` in the next node's spaces, or as a rule's own semicolon (below).
        if (/[^\t\n\f\r ]/u.test(node.raws.before ?? "")) stray = true;
        if (node.type === "decl") stray = true;
        if (node.type === "decl" || node.type === "comment" || (stray && node.type === "atrule" && node.nodes === undefined)) continue;
        if (stray) {
          stray = node.type === "rule" && Boolean(node.raws.ownSemicolon);
          continue;
        }
      }
      if (node.type === "atrule") {
        const name = asciiLower(node.name);
        if (name === "scope") for (const item of selectorClassNames(node.params, attribute)) names.selectorClasses.add(item);
        // Declarations right inside a nested @media style the rule around it, under that condition: read once per list.
        if (parents !== undefined && declares(node)) {
          const styled = !conditional && name === "layer" ? 2 : 1;
          if ((styledParents.get(parents) ?? 0) < styled) {
            styledParents.set(parents, styled);
            record(parents, true, styled === 2);
          }
        }
        if (node.nodes) visit(node, parents, compile && /^(?:media|container|supports|layer)$/u.test(name), conditional || name !== "layer", level + 1, asWritten && parents === undefined && RULE_LIST.test(name));
        continue;
      }
      if (node.type !== "rule") continue;
      if (list && node.raws.ownSemicolon) stray = true;
      // Below the top level (where forPostcss took them out) `<!--` and `-->` start a selector the browser drops.
      if (asWritten && container !== top && startsWithHtmlComment(node.selector)) continue;
      const written = selectorList(node.selector);
      let items: string[] | undefined = written;
      let compiled = parents === undefined && styles && container === top;
      if (parents !== undefined && compile && isBemList(written)) {
        items = joined(parents, written);
        compiled = true;
      } else if (parents !== undefined) items = nested(parents, written);
      if (items === undefined) continue;
      record(items, declares(node), !conditional);
      visit(node, items, compiled, conditional, level + 1, false);
    }
  };
  try {
    if (entry === undefined) visit(top, undefined, false, false, 0, asWritten);
    else {
      const items = selectorList(entry);
      record(items, declares(top), true);
      visit(top, items, true, false, 0, false);
    }
  } catch (error) {
    if (!(error instanceof PostcssMisread)) throw error;
    failSafe(error.message);
  }
}

function collectDeclarationNames(names: FrameworkNames, css: string, where: string): void {
  scanCss(css, {
    reference: (name, fallback) => { if (!fallback) addPlace(names.variables, name, where); },
    definition: (name) => names.definedVariables.add(name),
  });
}

/**
 * The custom properties a sheet defines, as collectCssNames adds them to `definedVariables`, read without parsing: for
 * a sheet whose other names are read from its text once converted (an ACSS sheet to convert, whose definitions the
 * conversion needs first and leaves as they are).
 */
export function collectCssDefinitions(names: FrameworkNames, css: string): void {
  scanCss(css, { definition: (name) => names.definedVariables.add(name) });
}

/**
 * The names of a global sheet, of the selector styles (`where` is SELECTOR_STYLES_PLACE: each top-level rule is a style
 * that Histeon compiles) or of one style (`selector` plus its body). `unparsed`: why a sheet is not to be parsed (past
 * the parse bounds), which reads it as CSS postcss cannot read, with that reason.
 */
export function collectCssNames(names: FrameworkNames, css: string, where: string, selector?: string, unparsed?: string): void {
  collectDeclarationNames(names, css, where);
  if (selector !== undefined) collectSelectorNames(names, css, where, true, selector);
  else if (css.includes("{")) collectSelectorNames(names, css, where, where === SELECTOR_STYLES_PLACE, undefined, unparsed);
}

/** `@property` and whitespace just before `at`. */
function registeredBefore(text: string, at: number): boolean {
  let index = at;
  while (index > 0 && isSpace(text.charCodeAt(index - 1))) index--;
  return index < at && index >= 9 && asciiLower(text.slice(index - 9, index)) === "@property";
}

/**
 * Custom properties a text defines, read without parsing and in one pass: any `--name:` counts, even one in a string,
 * and so does any `@property --name`, so a name the author defines is never taken for an ACSS one (the conversion only
 * ever skips more, never less). A name that is no definition is skipped whole: no definition starts inside it, since a
 * definition there would end where it ends.
 */
export function definedVariablesIn(text: string, into: Set<string>): void {
  let at = text.indexOf("--");
  while (at >= 0) {
    const name = readName(text, at + 2);
    let after = name.end;
    while (isSpace(text.charCodeAt(after))) after++;
    if (name.value && (text.charCodeAt(after) === 58 || registeredBefore(text, at))) into.add(name.value);
    at = text.indexOf("--", name.end);
  }
}

/** What a conversion changed, for the report: `from → to`, counted; `alongside` when the ACSS class stays next to its new name. */
export type Conversions = Map<string, { to: string; count: number; alongside?: boolean }>;

function converted(conversions: Conversions, from: string, to: string, alongside = false): void {
  const entry = conversions.get(from);
  if (entry) {
    entry.count++;
    if (alongside) entry.alongside = true;
  } else conversions.set(from, { to, count: 1, ...(alongside ? { alongside } : {}) });
}

interface Edit { start: number; end: number; from: string; to: string }

/** Where a `var(--acss)` takes its Histeon CSS name, outside strings, comments and url(): not for a name the prototype defines. */
function variableEdits(css: string, defined: ReadonlySet<string>): Edit[] {
  const edits: Edit[] = [];
  scanCss(css, {
    reference: (name, _fallback, start, end) => {
      const token = ACSS_VARIABLES.get(name);
      if (token !== undefined && !defined.has(name)) edits.push({ start, end, from: `--${name}`, to: `--${token}` });
    },
  });
  return edits;
}

function applyEdits(text: string, edits: Edit[], conversions: Conversions): string {
  let out = "";
  let from = 0;
  for (const edit of edits) {
    out += text.slice(from, edit.start) + edit.to;
    from = edit.end;
    converted(conversions, edit.from, edit.to);
  }
  return out + text.slice(from);
}

/** `var(--acss)` → `var(--xb-…)` outside strings, comments and url(), except for names the prototype defines itself. */
export function convertAcssVariables(css: string, defined: ReadonlySet<string>, conversions: Conversions): string {
  return applyEdits(css, variableEdits(css, defined), conversions);
}

/**
 * An attribute value as the browser reads it (`text`) and, for each character read, where `value` writes it (-1 for
 * one that a character reference gives). Undefined when this reading is not decodeHTMLAttribute's: a legacy reference
 * without `;`, which the transfer check refuses anyway (G3).
 */
function readAttributeValue(value: string): { text: string; at: number[] } | undefined {
  const reference = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/uy;
  let text = "";
  const at: number[] = [];
  let index = 0;
  while (index < value.length) {
    const amp = value.indexOf("&", index);
    const plain = amp < 0 ? value.length : amp;
    text += value.slice(index, plain);
    for (; index < plain; index++) at.push(index);
    if (amp < 0) break;
    reference.lastIndex = amp;
    const match = reference.exec(value)?.[0];
    const decoded = match === undefined ? undefined : decodeHTMLStrict(match);
    if (match !== undefined && decoded !== undefined && decoded !== match) {
      text += decoded;
      for (let k = 0; k < decoded.length; k++) at.push(-1);
      index = amp + match.length;
    } else {
      text += "&";
      at.push(amp);
      index = amp + 1;
    }
  }
  return text === decodeHTMLAttribute(value) ? { text, at } : undefined;
}

/**
 * A `style` value with its ACSS variables renamed, read as the browser reads it (`&quot;` closes a string, so an
 * apostrophe inside it opens none) and edited where it is written: only a name written as itself changes, every other
 * character stays as the author wrote it.
 */
function convertStyleValue(value: string, defined: ReadonlySet<string>, conversions: Conversions): string {
  if (!value.includes("&")) return convertAcssVariables(value, defined, conversions);
  const read = readAttributeValue(value);
  if (read === undefined) return value;
  const edits: Edit[] = [];
  for (const edit of variableEdits(read.text, defined)) {
    const start = read.at[edit.start] ?? -1;
    const end = start + edit.end - edit.start;
    // A name written with a character reference stays as written: the report says it has no value.
    if (start >= 0 && read.at[edit.end - 1] === end - 1 && value.slice(start, end) === read.text.slice(edit.start, edit.end)) edits.push({ ...edit, start, end });
  }
  return applyEdits(value, edits, conversions);
}

/**
 * The blocks of a document: names collected (classes, `style` references and definitions, as the browser reads the
 * values) and, with `convert`, ACSS classes and variables renamed in `class` and `style` attributes, inline markup of
 * text runs included. A class the prototype defines (`convert.ruleClasses`) keeps its name alone, with the prototype's
 * rule; one its selectors only name (`names.selectorClasses`) keeps it next to the Histeon CSS name, so they still match.
 * A selector on the text of `class` (`names.attributeClasses`) keeps it next to the new name, or alone where the added
 * name itself would change the text it reads (`[class="x"]`, `[class$="x"]`).
 */
export function frameworkNamesInBlocks(blocks: XbBlock[], where: string, names: FrameworkNames, convert?: { defined: ReadonlySet<string>; ruleClasses: ReadonlySet<string>; conversions: Conversions }): void {
  const classValue = (value: string): string => {
    // A dynamic part may hold any text: then nothing is renamed, and only the parts without braces count as names.
    const renaming = convert !== undefined && !/[{}]/u.test(value) ? convert : undefined;
    return value.replace(/[^\t\n\f\r ]+/gu, (name) => {
      if (/[{}]/u.test(name)) return name;
      if (name.includes("&")) {
        // As the browser reads it; a name written with a character reference is not renamed.
        for (const item of decodeHTMLAttribute(name).split(/[\t\n\f\r ]+/u)) if (item) addPlace(names.classes, item, where);
        return name;
      }
      const target = renaming ? ACSS_CLASSES.get(name) : undefined;
      const text = names.attributeClasses.get(name);
      if (!renaming || target === undefined || renaming.ruleClasses.has(name) || text === false) {
        addPlace(names.classes, name, where);
        return name;
      }
      addPlace(names.classes, target, where);
      const alongside = text === true || names.selectorClasses.has(name);
      converted(renaming.conversions, `.${name}`, `.${target}`, alongside);
      return alongside ? `${name} ${target}` : target;
    });
  };
  const styleValue = (value: string): string => {
    const out = convert && !/[{}]/u.test(value) ? convertStyleValue(value, convert.defined, convert.conversions) : value;
    collectDeclarationNames(names, out.includes("&") ? decodeHTMLAttribute(out) : out, where);
    return out;
  };
  const attribute = (name: string, value: string): string => (name === "class" ? classValue(value) : name === "style" ? styleValue(value) : value);
  for (const block of blocks) {
    if (block.name === "xb/element" && block.attrs.attributes) {
      for (const [name, value] of Object.entries(block.attrs.attributes)) {
        if (typeof value === "string" && (name === "class" || name === "style")) block.attrs.attributes[name] = attribute(name, value);
      }
    } else if (block.name === "xb/text" && block.attrs.verbatim !== true && /<[A-Za-z]/u.test(block.attrs.content)) {
      block.attrs.content = rewriteInlineMarkupAttributes(block.attrs.content, (_tag, name, value) => attribute(name, value));
    }
    if ("children" in block) frameworkNamesInBlocks(block.children as XbBlock[], where, names, convert);
  }
}

function list(items: string[], max: number): string {
  return `${items.slice(0, max).join(", ")}${items.length > max ? ` e altri ${items.length - max}` : ""}`;
}

function placesOf(places: Places, name: string): string {
  return [...(places.get(name) ?? [])].join(", ");
}

/**
 * Doc 23 item 240: the start of a report line that informs and asks nothing (the CLI prints it as such, not as
 * «Avviso:»): what the import converted or kept on purpose.
 */
export const PROTOTYPE_NOTE_PREFIX = "Nota: ";

/**
 * The report's lines on framework names (C2): what was renamed, what the prototype keeps as its own, variables that
 * nothing defines and ACSS classes without a rule. `framework` and `acss` are the manifest's.
 */
export function frameworkNameWarnings(names: FrameworkNames, options: { framework: "histos-css" | "none" | "acss"; acss?: "convert" | "keep"; conversions?: Conversions }): string[] {
  const warnings: string[] = [];
  const tokens = new Set(histosTokenNames());
  const histosClasses = new Set(histosFrameworkData().classes.map((entry) => entry.name));
  const keep = options.framework === "acss" && options.acss === "keep";
  if (options.conversions?.size) {
    const pairs = [...options.conversions].map(([from, { to }]) => `${from} → ${to}`);
    // Doc 23 item 240: what the import did, not a problem: a note, which an agent working down to zero warnings leaves.
    warnings.push(`${PROTOTYPE_NOTE_PREFIX}ACSS → Histeon CSS: ${options.conversions.size === 1 ? "un nome convertito" : `${options.conversions.size} nomi convertiti`} (${list(pairs, 8)}). I valori ora vengono da Histeon CSS e dal design del manifest, non da ACSS.`);
    const alongside = [...options.conversions].filter(([, entry]) => entry.alongside).map(([from, { to }]) => `${from} con ${to}`);
    if (alongside.length) warnings.push(`ACSS: ${alongside.length === 1 ? "una classe tiene" : `${alongside.length} classi tengono`} anche il nome ACSS accanto a quello Histeon CSS (${list(alongside, 8)}): i selettori del prototipo ${alongside.length === 1 ? "la nominano" : "le nominano"} senza una regola propria (in un contesto, con uno stato, dentro :not(), nel testo di class come [class*="text--"]…), e così valgono ancora.`);
  }
  if (options.framework === "acss" && !keep) {
    const own = [
      ...[...names.definedVariables].filter((name) => ACSS_VARIABLES.has(name)).map((name) => `--${name}`),
      ...[...names.ruleClasses].filter((name) => ACSS_CLASSES.has(name) && names.classes.has(name)).map((name) => `.${name}`),
    ];
    if (own.length) warnings.push(`${PROTOTYPE_NOTE_PREFIX}ACSS: ${own.length === 1 ? "tenuto un nome" : `tenuti ${own.length} nomi`} che il prototipo definisce da sé (${list(own, 8)}): restano come sono, con il valore o la regola del prototipo.`);
    const text = [...names.classes.keys()].filter((name) => names.attributeClasses.get(name) === false && ACSS_CLASSES.has(name) && !names.ruleClasses.has(name)).sort().map((name) => `.${name}`);
    if (text.length) warnings.push(`ACSS: ${text.length === 1 ? "tenuto un nome" : `tenuti ${text.length} nomi`} che un selettore del prototipo legge nel testo di class, come [class="…"] o [class$="…"] (${list(text, 8)}): con il nome Histeon CSS, anche accanto, quel selettore non varrebbe più.`);
  }
  // Only where it matters: names ACSS's own or converted, which such a sheet may define.
  if (names.unreadable.size && (options.framework === "acss" || [...names.classes.keys()].some(isAcssClass))) {
    const places = [...names.unreadable].map(([place, reason]) => `${place}, ${reason}`);
    warnings.push(`CSS che l'import non legge come il browser: ${list(places, 4)}. Ogni classe che vi compare conta come definita dal prototipo, quindi non è convertita né segnalata senza regola: correggi il CSS perché la conversione e il controllo delle classi ACSS valgano.`);
  }
  const undefinedVariables = [...names.variables.keys()].filter((name) => !tokens.has(name) && !names.definedVariables.has(name)).sort();
  const unruled = [...names.classes.keys()].filter((name) => isAcssClass(name) && !names.styledClasses.has(name) && !histosClasses.has(name)).sort();
  let missing = undefinedVariables;
  if (keep) {
    // Only ACSS's own names wait for its sheets: any other name has no value there either.
    const acssNames = [...undefinedVariables.filter(isAcssVariable).map((name) => `--${name}`), ...unruled.map((name) => `.${name}`)];
    if (acssNames.length) warnings.push(`ACSS tenuto (acss: keep): ${acssNames.length === 1 ? "un nome resta" : `${acssNames.length} nomi restano`} senza valore o regola finché non importi i fogli che ACSS genera sul sito (Stili → Importa CSS): ${list(acssNames, 10)}. Publish non include ACSS.`);
    missing = undefinedVariables.filter((name) => !isAcssVariable(name));
  }
  if (missing.length) {
    const described = missing.map((name) => {
      const token = ACSS_VARIABLES.get(name);
      return `--${name} (${placesOf(names.variables, name)})${token ? ` → in Histeon CSS --${token}` : ""}`;
    });
    warnings.push(`Variabili senza valore: ${list(described, 8)}. Nessun foglio del progetto le definisce e non hanno un valore di riserva, quindi le proprietà che le usano non valgono. Usa i token --xb-* o definiscile nel foglio globale.`);
  }
  if (!keep && unruled.length) {
    const described = unruled.map((name) => {
      const target = ACSS_CLASSES.get(name);
      return `${name} (${placesOf(names.classes, name)})${target ? ` → in Histeon CSS ${target}` : ""}`;
    });
    warnings.push(`Classi ACSS senza regola: ${list(described, 8)}. Publish non include ACSS: scrivi la regola negli stili per selettore, usa la classe Histeon CSS indicata o importa i fogli di ACSS del sito.`);
  }
  return warnings;
}

/**
 * C2 for a converted site (B1): the Automatic.css classes its pages use keep the rule the site's own sheets give them,
 * which become the project's compatibility sheet; the report names them, the ones Histeon CSS has under another name,
 * and those with no rule of their own (ACSS's sheet was not part of the site). Nothing is renamed: the site looks the same.
 */
export function acssSiteNotes(usedClasses: ReadonlySet<string>, sheets: ReadonlyArray<{ css: string; name?: string }>, selectors: string): string[] {
  const names = emptyFrameworkNames();
  for (const sheet of sheets) collectCssNames(names, sheet.css, sheet.name ? `foglio ${sheet.name}` : "foglio");
  collectCssNames(names, selectors, SELECTOR_STYLES_PLACE);
  const classes = [...usedClasses].filter(isAcssClass).sort();
  const variables = [...names.definedVariables].filter((name) => ACSS_VARIABLES.has(name));
  // A few ACSS-looking names alone are no sign of ACSS; its sheet defines dozens of its variables.
  if (!classes.length && variables.length < 5) return [];
  const notes: string[] = [];
  // A responsive utility (`grid--m-1` only inside @media) has its rule too.
  const ruled = classes.filter((name) => names.styledClasses.has(name));
  const unruled = classes.filter((name) => !names.styledClasses.has(name));
  if (ruled.length) {
    const renamed = ruled.filter((name) => ACSS_CLASSES.has(name)).map((name) => `${name} → ${ACSS_CLASSES.get(name)}`);
    notes.push(`Automatic.css: ${ruled.length === 1 ? "una classe resta" : `${ruled.length} classi restano`} con la regola dei fogli del sito, che fanno da foglio di compatibilità (${list(ruled, 8)})${renamed.length ? `; in Histeon CSS hanno un nome: ${list(renamed, 6)}` : ""}`);
  }
  if (unruled.length) notes.push(`Automatic.css: ${unruled.length === 1 ? "una classe usata non ha" : `${unruled.length} classi usate non hanno`} una regola nei fogli del sito, forse il foglio di ACSS non è stato scaricato (${list(unruled, 8)})`);
  if (classes.length && names.unreadable.size) notes.push(`Automatic.css: CSS che la conversione non legge come il browser (${list([...names.unreadable].map(([place, reason]) => `${place}, ${reason}`), 4)}): le classi che vi compaiono contano come regolate`);
  if (!classes.length) notes.push(`Automatic.css: il sito definisce ${variables.length} variabili di ACSS, che restano nei fogli del progetto`);
  return notes;
}
