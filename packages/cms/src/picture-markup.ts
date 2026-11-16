import { parse, type DefaultTreeAdapterMap } from "parse5";
import postcss, { type ChildNode as CssNode, type Container } from "postcss";

/**
 * Modern image formats in a built page (queue B6): an `<img>` whose file has variants becomes
 * `<picture style="display:contents">` with one `<source hidden>` per format (JPEG XL, AVIF, WebP, each with `srcset`
 * and `sizes`), the `<img>` itself kept as written as the fallback. Nothing else of the page changes, and an image is
 * wrapped only when that cannot change how the page looks:
 *
 * - its `src` is a media file of the build (`/media/…`), it has both `width` and `height` as the browser reads them
 *   (they size the box, so the intrinsic size the `srcset` gives cannot move it), no `srcset` of its own, and it is
 *   not already inside a `<picture>` the author wrote;
 * - the page's CSS (all of it is in its `<style>` elements: a built page links no sheet) selects the same elements
 *   before and after the wrap. Every rule is matched against the image, its siblings (and their descendants for a
 *   rule with `+` or `~`), the new `<picture>` and its `<source>` elements, in the page as written and in the page as
 *   it would be. A rule whose match changes (`.card > img`, `.flow > * + *` around an image, `img:first-child`), a rule
 *   that would give the `<picture>` an inherited value or content, a rule that would give a `<source>` a box, a rule
 *   that makes the image size itself from its file (`width: auto` with `height: auto`, `all`), a `:has()` on the image,
 *   one of its ancestors or a sibling before them (doc 23 item 123: elsewhere it cannot see the wrap), or a sheet
 *   that does not parse: the image keeps only its `src`. Dynamic states (`:hover`, `:focus`…) are tried both true and
 *   false; nested rules are resolved as CSS nesting does (`&` is the parent's selector).
 *
 * `display: contents` keeps the box tree as it was: the `<img>` stays the flex or grid item, the line content, the
 * block it was. A `<source>` is `display: inline` for the browser, and with the `<picture>` gone from the box tree an
 * empty one in a grid or flex container would be an item of its own, with a track and a gap before the image (doc 23
 * item 183: 19 px more above each card's image than on WordPress); `hidden` keeps it out of the layout, and the
 * browser still picks the file from it. `sizes` is the image's own when it has one, otherwise `100vw`: never a
 * candidate smaller than the viewport, so never blurrier than the original wherever the CSS stretches the image (the
 * largest candidate is the file's own width, up to the encoder's maximum).
 */

type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export type PictureSourceType = "image/jxl" | "image/avif" | "image/webp";

/** The `<source>` elements of an image, in the order a browser tries them. */
export interface PictureSource {
  type: PictureSourceType;
  /** Each file and its width in pixels, smallest first. */
  candidates: Array<{ url: string; width: number }>;
}

/** Why an `<img>` of a build's media keeps only its `src`. */
export type PictureSkipReason = "picture" | "srcset" | "unsized" | "css";

export const PICTURE_SKIP_TEXT: Readonly<Record<PictureSkipReason, string>> = {
  picture: "dentro un <picture> scritto dall'autore",
  srcset: "con un srcset scritto dall'autore",
  unsized: "senza width e height",
  css: "il CSS della pagina selezionerebbe altri elementi",
};

/** One `<img>` of a page that can become a `<picture>`: where its tag is in the page, and its file. */
export interface PictureImage {
  src: string;
  start: number;
  end: number;
  sizes: string | null;
  /** The element, for the check against the CSS (pictureImages, wrapPictures). */
  node: Element;
}

export interface PicturePage {
  html: string;
  images: PictureImage[];
  skipped: Array<{ src: string; reason: PictureSkipReason; detail?: string }>;
  /** The page's CSS, read once; null when a sheet does not parse (no image is wrapped). */
  css: PageCss | null;
  tree: PageTree;
}

const MEDIA_SRC = /^\/media\/[0-9a-f]{64}\.(?:jpg|png|webp|avif)$/u;

/** A side the browser reads as one (the same rule as the import's B6 report): digits, never %, a word or nothing. */
export function readsAsImageDimension(value: string | undefined): boolean {
  return typeof value === "string" && /^[\t\n\f\r ]*(?=(\d+(?:\.\d*)?))\1(?![%*])/u.test(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Element tree, before and after the wrap.

interface El {
  tag: string;
  attrs: Map<string, string>;
  classes: Set<string>;
  parent: El | null;
  children: El[];
  /** A text child (even white space): `:empty` does not match. */
  text: boolean;
  node?: Element;
}

interface PageTree {
  root: El | null;
  byNode: Map<Element, El>;
}

function element(tag: string, attrs: Array<{ name: string; value: string }>): El {
  const map = new Map(attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
  return { tag, attrs: map, classes: new Set((map.get("class") ?? "").split(/[\t\n\f\r ]+/u).filter(Boolean)), parent: null, children: [], text: false };
}

function buildTree(document: ParentNode): PageTree {
  const byNode = new Map<Element, El>();
  let root: El | null = null;
  const visit = (node: ParentNode, parent: El | null) => {
    for (const child of node.childNodes) {
      if (child.nodeName === "#text") {
        if (parent) parent.text = true;
        continue;
      }
      if (!("tagName" in child)) continue;
      const el = element(child.tagName.toLowerCase(), child.attrs);
      el.parent = parent;
      el.node = child;
      byNode.set(child, el);
      if (parent) parent.children.push(el);
      else root ??= el;
      visit(child, el);
    }
  };
  visit(document, null);
  return { root, byNode };
}

/** How a matcher walks the page: as written, or with one image wrapped. */
interface Tree {
  parent(el: El): El | null;
  children(el: El): El[];
  empty(el: El): boolean;
}

const BEFORE: Tree = { parent: (el) => el.parent, children: (el) => el.children, empty: (el) => !el.text && el.children.length === 0 };

function wrappedTree(image: El, picture: El, sources: El[]): Tree {
  const host = image.parent;
  return {
    parent: (el) => (el === image || sources.includes(el) ? picture : el === picture ? host : el.parent),
    children: (el) => (el === picture ? [...sources, image] : el === host ? host.children.map((child) => (child === image ? picture : child)) : el.children),
    empty: (el) => (el === picture ? false : sources.includes(el) ? true : !el.text && el.children.length === 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Selectors: enough of Selectors 4 to match a rule exactly or to know that it cannot be read.

type Combinator = " " | ">" | "+" | "~";

interface AttrTest {
  name: string;
  op: string | null;
  value: string;
  insensitive: boolean;
}

type Pseudo =
  | { kind: "nth"; name: string; a: number; b: number; of: Complex[] | null }
  | { kind: "is"; list: Complex[] }
  | { kind: "not"; list: Complex[] }
  | { kind: "nest" }
  | { kind: "has" }
  | { kind: "root" }
  | { kind: "empty" }
  | { kind: "state" };

interface Compound {
  type: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
  pseudos: Pseudo[];
  pseudoElement: boolean;
}

interface Complex {
  compounds: Compound[];
  /** Between compounds[i] and compounds[i + 1]. */
  combinators: Combinator[];
}

class SelectorSyntaxError extends Error {}

const STRUCTURAL = new Set(["first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"]);
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

class SelectorParser {
  private at = 0;
  constructor(private readonly text: string) {}

  static list(text: string): Complex[] {
    const parser = new SelectorParser(text);
    const list = parser.list();
    parser.space();
    if (parser.at < text.length) throw new SelectorSyntaxError(text);
    return list;
  }

  private peek(offset = 0): string {
    return this.text[this.at + offset] ?? "";
  }

  private space(): boolean {
    const start = this.at;
    while (/[\t\n\f\r ]/u.test(this.peek())) this.at++;
    // Comments inside a selector count as nothing.
    if (this.peek() === "/" && this.peek(1) === "*") {
      const end = this.text.indexOf("*/", this.at + 2);
      if (end < 0) throw new SelectorSyntaxError(this.text);
      this.at = end + 2;
      this.space();
    }
    return this.at > start;
  }

  list(): Complex[] {
    const list: Complex[] = [];
    for (;;) {
      this.space();
      list.push(this.complex());
      this.space();
      if (this.peek() !== ",") return list;
      this.at++;
    }
  }

  private complex(): Complex {
    const compounds: Compound[] = [];
    const combinators: Combinator[] = [];
    // A nested selector may start with a combinator (`> * + *`): its left side is the parent's selector.
    if (/[>+~]/u.test(this.peek())) compounds.push(nestCompound());
    else compounds.push(this.compound());
    for (;;) {
      const spaced = this.space();
      const next = this.peek();
      if (next === ">" || next === "+" || next === "~") {
        this.at++;
        this.space();
        combinators.push(next);
        compounds.push(this.compound());
      } else if (spaced && next !== "" && next !== "," && next !== ")") {
        combinators.push(" ");
        compounds.push(this.compound());
      } else return { compounds, combinators };
    }
  }

  private ident(): string {
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === "\\") {
        const hex = /^[0-9a-fA-F]{1,6}[\t\n\f\r ]?/u.exec(this.text.slice(this.at + 1));
        if (hex) {
          const code = Number.parseInt(hex[0].trim(), 16);
          value += code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
          this.at += 1 + hex[0].length;
        } else {
          if (this.at + 1 >= this.text.length) throw new SelectorSyntaxError(this.text);
          value += this.text[this.at + 1];
          this.at += 2;
        }
      } else if (/[A-Za-z0-9_-]/u.test(char) || char.charCodeAt(0) >= 0x80) {
        value += char;
        this.at++;
      } else break;
    }
    if (!value) throw new SelectorSyntaxError(this.text);
    return value;
  }

  private string(): string {
    const quote = this.peek();
    this.at++;
    let value = "";
    while (this.at < this.text.length && this.peek() !== quote) {
      if (this.peek() === "\\") {
        value += this.text[this.at + 1] ?? "";
        this.at += 2;
      } else value += this.text[this.at++];
    }
    if (this.peek() !== quote) throw new SelectorSyntaxError(this.text);
    this.at++;
    return value;
  }

  /** The text between the parentheses of a function, balanced, strings skipped. */
  private parenthesized(): string {
    this.at++;
    const start = this.at;
    let depth = 1;
    while (this.at < this.text.length) {
      const char = this.peek();
      if (char === "\"" || char === "'") this.string();
      else if (char === "\\") this.at += 2;
      else {
        if (char === "(") depth++;
        if (char === ")" && --depth === 0) {
          this.at++;
          return this.text.slice(start, this.at - 1);
        }
        this.at++;
      }
    }
    throw new SelectorSyntaxError(this.text);
  }

  private compound(): Compound {
    const compound: Compound = { type: null, ids: [], classes: [], attrs: [], pseudos: [], pseudoElement: false };
    const start = this.at;
    for (;;) {
      const char = this.peek();
      if (char === "*" && this.at === start) {
        this.at++;
        compound.type = "*";
        if (this.peek() === "|") {
          this.at++;
          compound.type = this.namespacedType();
        }
      } else if (char === "&") {
        this.at++;
        compound.pseudos.push({ kind: "nest" });
      } else if (char === "#") {
        this.at++;
        compound.ids.push(this.ident());
      } else if (char === ".") {
        this.at++;
        compound.classes.push(this.ident());
      } else if (char === "[") {
        compound.attrs.push(this.attribute());
      } else if (char === ":") {
        this.pseudo(compound);
      } else if (this.at === start && (/[A-Za-z_\\-]/u.test(char) || char.charCodeAt(0) >= 0x80)) {
        compound.type = this.ident().toLowerCase();
        if (this.peek() === "|") {
          this.at++;
          compound.type = this.namespacedType();
        }
      } else break;
    }
    if (this.at === start) throw new SelectorSyntaxError(this.text);
    return compound;
  }

  /** The type after a namespace bar (`svg|rect`, `*|*`): the namespace itself is not checked. */
  private namespacedType(): string {
    if (this.peek() !== "*") return this.ident().toLowerCase();
    this.at++;
    return "*";
  }

  private attribute(): AttrTest {
    this.at++;
    this.space();
    let name = this.peek() === "*" || this.peek() === "|" ? "" : this.ident();
    if (this.peek() === "|" && this.peek(1) !== "=") {
      this.at++;
      name = this.ident();
    } else if (!name) throw new SelectorSyntaxError(this.text);
    this.space();
    let op: string | null = null;
    let value = "";
    let insensitive = false;
    const operator = /^[~|^$*]?=/u.exec(this.text.slice(this.at));
    if (operator) {
      op = operator[0];
      this.at += op.length;
      this.space();
      value = this.peek() === "\"" || this.peek() === "'" ? this.string() : this.ident();
      this.space();
      if (/[iIsS]/u.test(this.peek()) && /[\t\n\f\r \]]/u.test(this.peek(1))) {
        insensitive = this.peek().toLowerCase() === "i";
        this.at++;
        this.space();
      }
    }
    if (this.peek() !== "]") throw new SelectorSyntaxError(this.text);
    this.at++;
    return { name: name.toLowerCase(), op, value, insensitive };
  }

  private pseudo(compound: Compound): void {
    this.at++;
    if (this.peek() === ":") {
      this.at++;
      this.ident();
      if (this.peek() === "(") this.parenthesized();
      compound.pseudoElement = true;
      return;
    }
    const name = this.ident().toLowerCase();
    const args = this.peek() === "(" ? this.parenthesized() : null;
    if (LEGACY_PSEUDO_ELEMENTS.has(name) && args === null) {
      compound.pseudoElement = true;
      return;
    }
    if (STRUCTURAL.has(name)) {
      if (name.startsWith("nth-")) {
        if (args === null) throw new SelectorSyntaxError(this.text);
        const nth = parseNth(args, name === "nth-child" || name === "nth-last-child");
        compound.pseudos.push({ kind: "nth", name, ...nth });
      } else {
        if (args !== null) throw new SelectorSyntaxError(this.text);
        compound.pseudos.push({ kind: "nth", name, a: 0, b: 1, of: null });
      }
      return;
    }
    if (["is", "where", "matches", "-webkit-any", "-moz-any"].includes(name) && args !== null) {
      compound.pseudos.push({ kind: "is", list: SelectorParser.list(args) });
      return;
    }
    if (name === "not" && args !== null) {
      compound.pseudos.push({ kind: "not", list: SelectorParser.list(args) });
      return;
    }
    if (name === "has") {
      compound.pseudos.push({ kind: "has" });
      return;
    }
    if (name === "root" && args === null) {
      compound.pseudos.push({ kind: "root" });
      return;
    }
    if (name === "empty" && args === null) {
      compound.pseudos.push({ kind: "empty" });
      return;
    }
    // A state of the element or the document (:hover, :checked, :lang()…): the same before and after the wrap.
    compound.pseudos.push({ kind: "state" });
  }
}

function nestCompound(): Compound {
  return { type: null, ids: [], classes: [], attrs: [], pseudos: [{ kind: "nest" }], pseudoElement: false };
}

function parseNth(text: string, allowOf: boolean): { a: number; b: number; of: Complex[] | null } {
  const match = /^[\t\n\f\r ]*(?:(odd)|(even)|([+-]?\d*)n(?:[\t\n\f\r ]*([+-])[\t\n\f\r ]*(\d+))?|([+-]?\d+))[\t\n\f\r ]*(?:of[\t\n\f\r ]+([\s\S]+))?$/iu.exec(text);
  if (!match) throw new SelectorSyntaxError(text);
  const of = match[7] !== undefined ? (allowOf ? SelectorParser.list(match[7]) : (() => { throw new SelectorSyntaxError(text); })()) : null;
  if (match[1]) return { a: 2, b: 1, of };
  if (match[2]) return { a: 2, b: 0, of };
  if (match[6] !== undefined) return { a: 0, b: Number(match[6]), of };
  const coefficient = match[3] ?? "";
  const a = coefficient === "" || coefficient === "+" ? 1 : coefficient === "-" ? -1 : Number(coefficient);
  const b = match[5] ? Number(match[5]) * (match[4] === "-" ? -1 : 1) : 0;
  return { a, b, of };
}

/** Replaces `&` with the parent rule's selectors (CSS nesting); a nested selector without `&` is relative to them. */
function resolveNesting(list: Complex[], parent: Complex[] | null): Complex[] {
  if (!parent) return list;
  const nested = (pseudo: Pseudo): Pseudo => (pseudo.kind === "nest" ? { kind: "is", list: parent } : pseudo.kind === "is" || pseudo.kind === "not" ? { ...pseudo, list: resolveNesting(pseudo.list, parent) } : pseudo);
  const hasNest = (complex: Complex): boolean => complex.compounds.some((compound) => compound.pseudos.some((pseudo) => pseudo.kind === "nest"));
  return list.map((complex) => {
    const resolved: Complex = { compounds: complex.compounds.map((compound) => ({ ...compound, pseudos: compound.pseudos.map(nested) })), combinators: [...complex.combinators] };
    if (hasNest(complex)) return resolved;
    return { compounds: [{ ...nestCompound(), pseudos: [{ kind: "is", list: parent }] }, ...resolved.compounds], combinators: [" ", ...resolved.combinators] };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Matching.

function attributeMatches(test: AttrTest, el: El): boolean {
  const actual = el.attrs.get(test.name);
  if (actual === undefined) return false;
  if (test.op === null) return true;
  const value = test.insensitive ? actual.toLowerCase() : actual;
  const wanted = test.insensitive ? test.value.toLowerCase() : test.value;
  switch (test.op) {
    case "=": return value === wanted;
    case "~=": return wanted !== "" && value.split(/[\t\n\f\r ]+/u).includes(wanted);
    case "|=": return value === wanted || value.startsWith(`${wanted}-`);
    case "^=": return wanted !== "" && value.startsWith(wanted);
    case "$=": return wanted !== "" && value.endsWith(wanted);
    case "*=": return wanted !== "" && value.includes(wanted);
    default: return false;
  }
}

class Matcher {
  constructor(private readonly tree: Tree, private readonly assume: boolean) {}

  private siblings(el: El): El[] {
    const parent = this.tree.parent(el);
    return parent ? this.tree.children(parent) : [el];
  }

  private nth(pseudo: Extract<Pseudo, { kind: "nth" }>, el: El): boolean {
    let siblings = this.siblings(el);
    const ofType = pseudo.name.endsWith("of-type");
    if (ofType) siblings = siblings.filter((sibling) => sibling.tag === el.tag);
    if (pseudo.of) siblings = siblings.filter((sibling) => this.any(pseudo.of as Complex[], sibling));
    const index = siblings.indexOf(el);
    if (index < 0) return false;
    const last = pseudo.name.includes("last");
    if (pseudo.name.startsWith("only")) return siblings.length === 1;
    if (pseudo.name.startsWith("first")) return index === 0;
    if (pseudo.name.startsWith("last")) return index === siblings.length - 1;
    const position = last ? siblings.length - index : index + 1;
    if (pseudo.a === 0) return position === pseudo.b;
    const steps = (position - pseudo.b) / pseudo.a;
    return Number.isInteger(steps) && steps >= 0;
  }

  compound(compound: Compound, el: El): boolean {
    if (compound.type !== null && compound.type !== "*" && compound.type !== el.tag) return false;
    if (compound.ids.some((id) => el.attrs.get("id") !== id)) return false;
    if (compound.classes.some((name) => !el.classes.has(name))) return false;
    if (compound.attrs.some((test) => !attributeMatches(test, el))) return false;
    for (const pseudo of compound.pseudos) {
      switch (pseudo.kind) {
        case "nth": if (!this.nth(pseudo, el)) return false; break;
        case "is": if (!this.any(pseudo.list, el)) return false; break;
        case "not": if (this.any(pseudo.list, el)) return false; break;
        case "root": if (this.tree.parent(el) !== null) return false; break;
        case "empty": if (!this.tree.empty(el)) return false; break;
        // A top-level `&` is the scope, the document's root here; `:has()` is refused before matching.
        case "nest": if (this.tree.parent(el) !== null) return false; break;
        case "has":
        case "state": if (!this.assume) return false; break;
      }
    }
    return true;
  }

  private from(complex: Complex, index: number, el: El): boolean {
    if (!this.compound(complex.compounds[index] as Compound, el)) return false;
    if (index === 0) return true;
    const combinator = complex.combinators[index - 1];
    if (combinator === ">") {
      const parent = this.tree.parent(el);
      return parent !== null && this.from(complex, index - 1, parent);
    }
    if (combinator === " ") {
      for (let parent = this.tree.parent(el); parent; parent = this.tree.parent(parent)) if (this.from(complex, index - 1, parent)) return true;
      return false;
    }
    const siblings = this.siblings(el);
    const position = siblings.indexOf(el);
    if (combinator === "+") return position > 0 && this.from(complex, index - 1, siblings[position - 1] as El);
    for (let before = position - 1; before >= 0; before--) if (this.from(complex, index - 1, siblings[before] as El)) return true;
    return false;
  }

  matches(complex: Complex, el: El): boolean {
    return this.from(complex, complex.compounds.length - 1, el);
  }

  any(list: Complex[], el: El): boolean {
    return list.some((complex) => this.matches(complex, el));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The page's CSS.

interface CssRule {
  selector: Complex;
  text: string;
  /** Has `+` or `~`, anywhere: the descendants of the image's siblings can change too. */
  siblingCombinator: boolean;
  /** Whether its subject is a pseudo-element (`::before`). */
  pseudoElement: boolean;
  declarations: Array<{ prop: string; value: string; important: boolean }>;
  /** The compounds with a `:has()` (doc 23 item 123): an element they can match near the image may see the wrap. */
  hasCompounds: Compound[];
  /**
   * What the `:has()` arguments end on (the subject of each relative selector), or null when one does not parse: the
   * wrap changes only the image and adds a `<picture>` and `<source>` elements, so only an argument that can end on
   * one of those can change.
   */
  hasTargets: Compound[] | null;
  /** An argument starts with `+` or `~`: it looks at the following siblings, so the siblings before count too. */
  hasSiblings: boolean;
  /** Which of the sheets read it is in, and its line there (pageWideImageRules). */
  sheet: number;
  line: number;
}

interface PageCss {
  rules: CssRule[];
  /** `@scope` or a rule for `picture`/`source`: anything could change, nothing is wrapped. */
  relational: boolean;
  /** Where each of those is, for pageWideImageRules. */
  relationalAt?: Array<{ text: string; sheet: number; line: number }>;
}

/** Inherited properties: a `<picture>` that gets one passes it to its `<img>`. */
const INHERITED = /^(?:--.*|color|cursor|direction|font(?:-.*)?|letter-spacing|line-height|list-style(?:-.*)?|quotes|tab-size|text-(?:align(?:-last)?|indent|justify|shadow|transform|rendering|underline-position|wrap(?:-.*)?|emphasis(?:-.*)?|size-adjust)|visibility|white-space(?:-collapse)?|word-(?:break|spacing|wrap)|overflow-wrap|writing-mode|hyphens|image-(?:rendering|orientation|resolution)|pointer-events|color-scheme|accent-color|caret-color|paint-order|fill(?:-.*)?|stroke(?:-.*)?|border-collapse|border-spacing|caption-side|empty-cells|orphans|widows|-webkit-.*|-moz-.*|forced-color-adjust|print-color-adjust|dynamic-range-limit|interpolate-size|math-.*|ruby-.*|speak.*)$/u;

/** What an empty `<source>` may get without drawing a box (a reset's `box-sizing`, zero margins, fonts). */
function harmlessOnSource(prop: string, value: string): boolean {
  // What `hidden` already gives it (a reset's `[hidden] { display: none !important }`).
  if (prop === "display" && /^none$/iu.test(value.trim())) return true;
  if (/^(?:--.*|box-sizing|color|cursor|font(?:-.*)?|line-height|letter-spacing|word-spacing|text-.*|transition(?:-.*)?|animation(?:-.*)?|will-change|-webkit-font-smoothing|-moz-osx-font-smoothing|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?-(?:style|color)|outline-(?:style|color|offset)|vertical-align|quotes|list-style(?:-.*)?|direction|unicode-bidi|tab-size|hyphens|overflow-wrap|word-break|white-space|text-size-adjust)$/u.test(prop)) return true;
  if (/^(?:margin|padding|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-width)?|outline(?:-width)?|inset)(?:-.*)?$/u.test(prop)) {
    return value.split(/[\t\n\f\r ]+/u).every((part) => /^(?:0(?:\.0*)?[a-z%]*|none|initial|unset|inherit|revert(?:-layer)?|solid|dashed|dotted|currentcolor|transparent)$/iu.test(part) || /^(?:#|rgb|hsl|var\()/iu.test(part));
  }
  return false;
}

/** The same sheets on every page of a site: read once, as parsing them is most of what a page costs here. */
let lastRead: { sheets: string[]; css: PageCss | null } | null = null;

function readCss(sheets: string[]): PageCss | null {
  // Compared sheet by sheet: joining them into one key would copy megabytes for every page.
  const previous = lastRead?.sheets;
  if (lastRead && previous && previous.length === sheets.length && previous.every((sheet, at) => sheet === sheets[at])) return lastRead.css;
  const css = readSheets(sheets);
  lastRead = { sheets, css };
  return css;
}

/** The arguments of the `:has()` in a selector, with balanced parentheses and quotes. */
function hasArguments(selector: string): string[] {
  const out: string[] = [];
  const lower = selector.toLowerCase();
  for (let at = lower.indexOf(":has("); at >= 0; at = lower.indexOf(":has(", at + 1)) {
    let depth = 0;
    let quote = "";
    for (let i = at + 4; i < selector.length; i++) {
      const c = selector[i]!;
      if (quote) { if (c === quote && selector[i - 1] !== "\\") quote = ""; continue; }
      if (c === "\"" || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { out.push(selector.slice(at + 5, i)); break; }
    }
  }
  return out;
}

function hasParts(selector: string): { hasTargets: Compound[] | null; hasSiblings: boolean } {
  const args = hasArguments(selector);
  let targets: Compound[] | null = [];
  let siblings = false;
  for (const arg of args) {
    for (const relative of arg.split(",")) {
      const text = relative.trim();
      if (/^[+~]/u.test(text)) siblings = true;
      try {
        for (const complex of SelectorParser.list(text.replace(/^[>+~][\t\n\f\r ]*/u, ""))) {
          const last = complex.compounds.at(-1);
          if (last && targets) targets.push(last);
        }
      } catch {
        targets = null;
      }
    }
  }
  return { hasTargets: targets, hasSiblings: siblings };
}

/** The selectors of a list, split at its top-level commas. */
function topLevelParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) { if (c === quote && list[i - 1] !== "\\") quote = ""; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

function readSheets(sheets: string[]): PageCss | null {
  const rules: CssRule[] = [];
  let relational = false;
  const relationalAt: NonNullable<PageCss["relationalAt"]> = [];
  let sheet = 0;
  // `shown`: the rule's selector as the report names it, nesting resolved (`& > img` in `.card` is `.card > img`).
  const walk = (container: Container<CssNode>, parent: Complex[] | null, parentText: string | null): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === "rule") {
        // An SCSS suffix (`&__img` in `.card`, a prototype's selector styles before their build) joins the texts.
        const suffix = parentText !== null && /&[\w-]/u.test(node.selector);
        const joined = suffix ? topLevelParts(parentText).flatMap((outer) => topLevelParts(node.selector).map((inner) => (inner.includes("&") ? inner.replaceAll("&", outer) : `${outer} ${inner}`))).join(", ") : "";
        const list = suffix ? SelectorParser.list(joined) : resolveNesting(SelectorParser.list(node.selector), parent);
        const outer = parentText === null ? null : parentText.includes(",") ? `:is(${parentText})` : parentText;
        const shown = suffix ? joined : outer === null ? node.selector.trim() : node.selector.includes("&") ? node.selector.trim().replaceAll("&", outer) : `${outer} ${node.selector.trim()}`;
        // A rule for `picture` or `source` could see two wrapped images together. A `:has()` sees changes only in the
        // subtree (and following siblings) of the element it is on: it is checked image by image (doc 23 item 123).
        const line = node.source?.start?.line ?? 0;
        if (/(?:^|[\s>+~,(])(?:picture|source)(?![\w-])/iu.test(node.selector.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/gu, ""))) {
          relational = true;
          relationalAt.push({ text: shown.slice(0, 200), sheet, line });
        }
        const declarations = (node.nodes ?? []).filter((child) => child.type === "decl").map((decl) => ({ prop: decl.prop.toLowerCase(), value: decl.value.trim(), important: decl.important }));
        for (const selector of list) {
          rules.push({ ...hasParts(node.selector), selector, text: shown.slice(0, 200), siblingCombinator: /[+~]/u.test(node.selector.replace(/\[[^\]]*\]|\([^)]*\)/gu, (part) => (part.startsWith("(") ? part.replace(/[^+~]/gu, "") : ""))), pseudoElement: selector.compounds.at(-1)?.pseudoElement === true, declarations, hasCompounds: selector.compounds.filter((compound) => compound.pseudos.some((pseudo) => pseudo.kind === "has")), sheet, line });
        }
        walk(node, list, shown);
      } else if (node.type === "atrule") {
        // Keyframes select no element; every other block (@media, @supports, @layer, @container, @scope) may apply.
        if (/keyframes$/iu.test(node.name) || node.name.toLowerCase() === "font-face" || node.name.toLowerCase() === "page") continue;
        if (node.name.toLowerCase() === "scope") {
          relational = true;
          relationalAt.push({ text: `@scope ${node.params}`.trim().slice(0, 200), sheet, line: node.source?.start?.line ?? 0 });
        }
        walk(node, parent, parentText);
      }
    }
  };
  try {
    for (const css of sheets) {
      walk(postcss.parse(css), null, null);
      sheet++;
    }
  } catch {
    return null;
  }
  return { rules, relational, relationalAt };
}

// ---------------------------------------------------------------------------------------------------------------
// The check of one image.

const AUTO_SIZE = /^(?:auto|fit-content|max-content|min-content)(?:[\t\n\f\r ]*!important)?$/iu;

function declaresAutoSize(declarations: CssRule["declarations"], side: "width" | "height"): boolean {
  const logical = side === "width" ? "inline-size" : "block-size";
  return declarations.some((decl) => (decl.prop === side || decl.prop === logical) && AUTO_SIZE.test(decl.value));
}

/**
 * Why wrapping `image` in a `<picture>` with `sourceCount` sources could change the page, or null when it cannot.
 * Every rule is matched in the page as written and as it would be, with dynamic states both true and false.
 */
function cssChange(css: PageCss, image: El, sourceCount: number): string | null {
  if (css.relational) return "@scope o una regola per picture o source nel CSS";
  const picture = element("picture", [{ name: "style", value: "display:contents" }]);
  picture.text = false;
  const sources = Array.from({ length: sourceCount }, () => element("source", [{ name: "type", value: "image/avif" }, { name: "srcset", value: "x" }, { name: "sizes", value: "100vw" }, { name: "hidden", value: "" }]));
  const host = image.parent;
  if (!host) return "immagine senza genitore";
  const after = wrappedTree(image, picture, sources);
  const siblings = host.children.filter((child) => child !== image);
  const descendants: El[] = [];
  const collect = (el: El) => {
    for (const child of el.children) {
      descendants.push(child);
      collect(child);
    }
  };
  for (const sibling of siblings) collect(sibling);
  const style = image.attrs.get("style") ?? "";
  let widthAuto = /(?:^|;)[\t\n\f\r ]*(?:width|inline-size)[\t\n\f\r ]*:[\t\n\f\r ]*(?:auto|fit-content|max-content|min-content)/iu.test(style);
  let heightAuto = /(?:^|;)[\t\n\f\r ]*(?:height|block-size)[\t\n\f\r ]*:[\t\n\f\r ]*(?:auto|fit-content|max-content|min-content)/iu.test(style);
  if (/(?:^|;)[\t\n\f\r ]*all[\t\n\f\r ]*:/iu.test(style)) return "style con all sull'immagine";
  // Where a `:has()` could see the wrap (doc 23 item 123). The wrap changes the image and adds a `<picture>` and
  // `<source>` elements, nothing else: a `:has()` changes only if one of its arguments can end on one of them, and its
  // own element is an ancestor of the image (or a sibling before one, for `:has(+ …)` and `:has(~ …)`). Elsewhere on
  // the page (a lightbox's `html:has(.open)`, a menu's `nav:has(a:hover)`) it cannot.
  const ancestors: El[] = [];
  const before: El[] = [];
  for (let node: El | null = image; node; node = node.parent) {
    ancestors.push(node);
    const parent: El | null = node.parent;
    if (parent) for (const sibling of parent.children as El[]) {
      if (sibling === node) break;
      before.push(sibling);
    }
  }
  const loose = new Matcher(BEFORE, true);
  const probes = [image, element("picture", []), element("source", [{ name: "type", value: "image/avif" }, { name: "srcset", value: "x" }, { name: "hidden", value: "" }])];
  for (const rule of css.rules) {
    if (rule.hasCompounds.length === 0) continue;
    const reaches = rule.hasTargets === null || rule.hasTargets.some((target) => probes.some((probe) => loose.compound(target, probe)));
    if (!reaches) continue;
    const near = rule.hasSiblings ? [...ancestors, ...before] : ancestors;
    if (rule.hasCompounds.some((compound) => near.some((el) => loose.compound(compound, el)))) return `${rule.text} (:has() intorno all'immagine)`;
  }
  for (const assume of [true, false]) {
    const before = new Matcher(BEFORE, assume);
    const wrapped = new Matcher(after, assume);
    for (const rule of css.rules) {
      const was = before.matches(rule.selector, image);
      const is = wrapped.matches(rule.selector, image);
      if (was !== is) return rule.text;
      if (was && !rule.pseudoElement) {
        if (rule.declarations.some((decl) => decl.prop === "all")) return rule.text;
        widthAuto ||= declaresAutoSize(rule.declarations, "width");
        heightAuto ||= declaresAutoSize(rule.declarations, "height");
      }
      for (const sibling of rule.siblingCombinator ? [...siblings, ...descendants] : siblings) {
        if (before.matches(rule.selector, sibling) !== wrapped.matches(rule.selector, sibling)) return rule.text;
      }
      if (wrapped.matches(rule.selector, picture)) {
        if (rule.pseudoElement ? rule.declarations.some((decl) => decl.prop === "content" && !/^(?:none|normal)$/iu.test(decl.value))
          : !is && rule.declarations.some((decl) => (INHERITED.test(decl.prop) && !/^(?:inherit|unset)$/iu.test(decl.value)) || (decl.prop === "display" && decl.important) || decl.prop.startsWith("counter-") || decl.prop === "all")) return rule.text;
      }
      for (const source of sources) {
        if (wrapped.matches(rule.selector, source) && rule.declarations.some((decl) => !harmlessOnSource(decl.prop, decl.value))) return rule.text;
      }
    }
  }
  // Both sides auto: the image takes its size from the file, which the srcset would change.
  if (widthAuto && heightAuto) return "width e height automatici nel CSS";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The rules that reach every image (doc 17 item 1).

/** A rule of a prototype's sheets that would leave every image of the pages loading it with only its `src`. */
export interface PageWideImageRule {
  /** Index of the sheet in the list given, and the rule's line in it (1 for the first). */
  sheet: number;
  line: number;
  /** The rule as written, nesting resolved. */
  rule: string;
  /** What to write instead, in the manual's words (§3.1). */
  advice: string;
}

function pageWideAdvice(rule: string): string {
  if (/^@scope\b/iu.test(rule) || /(?:^|[\s>+~,(])(?:picture|source)(?![\w-])/iu.test(rule)) return "metti una classe sull'img o sul suo contenitore";
  if (/:has\(/iu.test(rule)) return "metti una classe sull'elemento (.card--con-foto)";
  if (/::selection/iu.test(rule)) return "toglila";
  if (/:(?:hover|focus(?:-visible|-within)?|active)\b/iu.test(rule)) return "metti un elemento davanti: :where(a, button, summary, input, textarea, select):focus-visible";
  if (/(?:^|[\s>+~,(])\*/u.test(rule)) return "in * lascia solo box-sizing, margin e padding a zero, caratteri, color, animation e transition; scroll-behavior va su html";
  return "metti una classe sull'immagine";
}

/**
 * The rules of `sheets` that take the modern formats from every image of the pages that load them, whatever its class
 * and wherever it is: each rule is tried alone against an image with no class, in an element no rule names, as the
 * build does it page by page (cssChange). `::selection`, a `:hover` or `:focus-visible` with no element, `*` with a
 * property that would give a `<source>` a box, `:root:has(img)`, `img { width: auto; height: auto }`, `@scope` and a
 * rule for `picture` or `source`. The rules of one class (`.card > img`) are the build's to say, on the real pages.
 * A sheet that does not parse has none.
 */
export function pageWideImageRules(sheets: string[]): PageWideImageRule[] {
  // Each sheet alone: one that does not parse (the import says so elsewhere) hides nothing of the others.
  const read = sheets.map((sheet) => readSheets([sheet]));
  const css: PageCss = {
    rules: read.flatMap((one, sheet) => (one?.rules ?? []).map((rule) => ({ ...rule, sheet }))),
    relational: false,
    relationalAt: read.flatMap((one, sheet) => (one?.relationalAt ?? []).map((at) => ({ ...at, sheet }))),
  };
  const found = new Map<string, PageWideImageRule>();
  const add = (sheet: number, line: number, rule: string) => {
    const key = `${sheet}:${line}:${rule}`;
    if (!found.has(key)) found.set(key, { sheet, line, rule, advice: pageWideAdvice(rule) });
  };
  for (const at of css.relationalAt ?? []) add(at.sheet, at.line, at.text);
  const html = element("html", []);
  const body = element("body", []);
  const box = element("x-histos-probe", []);
  const image = element("img", [{ name: "src", value: "/media/x.jpg" }, { name: "width", value: "1200" }, { name: "height", value: "800" }, { name: "alt", value: "" }]);
  for (const [parent, child] of [[html, body], [body, box], [box, image]] as const) {
    child.parent = parent;
    parent.children.push(child);
  }
  for (const rule of css.rules) {
    if (cssChange({ rules: [rule], relational: false }, image, 3)) add(rule.sheet, rule.line, rule.text);
  }
  return [...found.values()].sort((left, right) => left.sheet - right.sheet || left.line - right.line);
}

// ---------------------------------------------------------------------------------------------------------------
// Pages.

/**
 * The `<img>` of a built page that can become a `<picture>` (see the top of this file), and the others of the build's
 * media with why they cannot. `sourceCount` is how many `<source>` the check assumes (the rewrite checks again with
 * the real number).
 */
export function pictureImages(html: string, sourceCount = 3): PicturePage {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const tree = buildTree(document);
  const images: PictureImage[] = [];
  const skipped: PicturePage["skipped"] = [];
  const sheets: string[] = [];
  const candidates: Array<{ el: El; node: Element; src: string }> = [];
  for (const [node, el] of tree.byNode) {
    if (el.tag === "style") sheets.push(node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""));
    if (el.tag !== "img") continue;
    const src = el.attrs.get("src") ?? "";
    if (!MEDIA_SRC.test(src)) continue;
    let inPicture = false;
    for (let parent = el.parent; parent; parent = parent.parent) if (parent.tag === "picture") inPicture = true;
    if (inPicture) skipped.push({ src, reason: "picture" });
    else if (el.attrs.has("srcset")) skipped.push({ src, reason: "srcset" });
    else if (!readsAsImageDimension(el.attrs.get("width")) || !readsAsImageDimension(el.attrs.get("height"))) skipped.push({ src, reason: "unsized" });
    else if (!node.sourceCodeLocation) skipped.push({ src, reason: "css", detail: "posizione nel file non nota" });
    else candidates.push({ el, node, src });
  }
  const css = candidates.length ? readCss(sheets) : { rules: [], relational: false };
  for (const candidate of candidates) {
    const change = css ? cssChange(css, candidate.el, sourceCount) : "un foglio CSS non si legge";
    if (change) {
      skipped.push({ src: candidate.src, reason: "css", detail: change });
      continue;
    }
    const location = candidate.node.sourceCodeLocation;
    if (!location) continue;
    images.push({ src: candidate.src, start: location.startOffset, end: location.endOffset, sizes: candidate.el.attrs.get("sizes")?.trim() || null, node: candidate.node });
  }
  return { html, images, skipped, css, tree };
}

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The page with each image of `page.images` that has sources wrapped in a `<picture>`; the rest of the page is left
 * byte for byte. Each image is checked again against the CSS with its real number of sources.
 */
export function wrapPictures(page: PicturePage, sourcesFor: (src: string) => PictureSource[] | undefined): { html: string; wrapped: Array<{ src: string }>; skipped: PicturePage["skipped"] } {
  const wrapped: Array<{ src: string }> = [];
  const skipped: PicturePage["skipped"] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const image of page.images) {
    const sources = (sourcesFor(image.src) ?? []).filter((source) => source.candidates.length > 0);
    if (!sources.length) continue;
    const el = page.tree.byNode.get(image.node);
    const change = !el || !page.css ? "un foglio CSS non si legge" : cssChange(page.css, el, sources.length);
    if (change) {
      skipped.push({ src: image.src, reason: "css", detail: change });
      continue;
    }
    const sizes = escapeAttribute(image.sizes ?? "100vw");
    const tags = sources.map((source) => `<source type="${source.type}" srcset="${escapeAttribute(source.candidates.map((candidate) => `${candidate.url} ${candidate.width}w`).join(", "))}" sizes="${sizes}" hidden>`).join("");
    edits.push({ start: image.start, end: image.end, text: `<picture style="display:contents">${tags}${page.html.slice(image.start, image.end)}</picture>` });
    wrapped.push({ src: image.src });
  }
  let html = page.html;
  for (const edit of edits.sort((left, right) => right.start - left.start)) html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return { html, wrapped, skipped };
}
