import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from "postcss";
import type { ImportChoiceBook } from "./import-choices.js";
import { ACTIVE_CLASS, describeElement, type SiteElement, type SiteNode } from "./site-structure.js";

/**
 * Doc 18 §6.4-§6.5: utility classes (Tailwind, Bootstrap utilities) become one BEM class per element, and inline
 * `style=""` becomes CSS of that class. Each element gets the declarations its utilities gave it, read from the site's
 * own sheets (responsive variants as @media, states as `:hover`…), in the order the sheets had them; elements of a
 * block with the same utilities share the class. The utility rules then have no element left and go with the dead CSS.
 *
 * **The check is a strict CSS equivalence, not a screenshot.** The converter runs in Publish and, in F6, in the
 * WordPress admin's browser: neither has a headless browser to take screenshots with, and the site's CSS is all
 * there is to read. So a utility is converted only when the cascade proves the element looks the same:
 * - its rules are plain (`.u`, `.u:hover`, `.u::before`, inside @media or @supports), and no other selector names it
 *   (`.group:hover .u`, `.u > *`): what such selectors match would change;
 * - it has no `!important`, and the script text of the site does not name it;
 * - every other rule that may match the element (by its last compound: tag, id, classes, attributes) and sets the
 *   same property lost to the utility before, or still wins over the new class after: an unlayered rule of higher
 *   specificity. The new class's CSS is written last and unlayered, so it wins every other tie, as the utility did
 *   only when it came later. Matching is over-approximated (pseudo-classes and `:not()` count as matching), which can
 *   only keep a utility that would have converted.
 * An inline style moves only where the new class still wins: no other rule of higher specificity sets the property,
 * and no state or @media of the converted utilities does. What does not pass stays as the site wrote it, and the
 * report counts it. Nothing here runs the site or loads anything.
 */

type Specificity = [number, number, number];

interface Analysed {
  specificity: Specificity;
  /** Requirements of the last compound: what an element must have for the selector to possibly match it. */
  tag: string | null;
  ids: string[];
  classes: string[];
  attributes: string[];
  pseudoElement: string;
  /** Every class the selector names, anywhere (inside :is(), :not(), earlier compounds). */
  mentioned: string[];
  /** Plain utility selector: one compound, a class first, then only pseudo-classes, attributes, a pseudo-element. */
  simple: { name: string; suffix: string } | null;
}

interface PlacedRule {
  order: number;
  /** Cascade layer rank: declared order, Infinity when unlayered. */
  layer: number;
  context: string[];
  selector: string;
  analysed: Analysed | null;
  /** For a rule not analysed: the classes its text names, which then keep their names. */
  mentioned?: string[];
  declarations: Array<{ prop: string; value: string; important: boolean }>;
}

export interface UtilityConversion {
  /** Classes written on elements (the new BEM classes), for the list of classes in use. */
  added: string[];
  /** The new classes' CSS, to append after every sheet of the site. */
  css: string;
  notes: string[];
  /** Doc 27: answered name → the default it replaces, for the names that changed. */
  origin: Map<string, string>;
}

/** Utility names of Tailwind and Bootstrap: what such a class is called, after its variants (`md:hover:`) and a `-`. */
const UTILITY = new RegExp(
  "^(?:" +
    [
      // spacing and size
      "-?[mp][trblxyse]?-(?:\\d+(?:\\.\\d+)?|auto|px|\\[.+\\])", "space-[xy]-.+", "-?(?:inset|top|right|bottom|left|start|end)(?:-[xy])?-.+",
      "(?:min-|max-)?[wh]-.+", "size-.+", "mw-\\d+", "mh-\\d+", "v[wh]-\\d+", "min-v[wh]-\\d+",
      // display and layout
      "flex", "inline-flex", "grid", "inline-grid", "block", "inline-block", "inline", "hidden", "contents", "table", "flow-root",
      "d-(?:[a-z]+-)?(?:none|inline|inline-block|block|grid|inline-grid|table|table-cell|table-row|flex|inline-flex)",
      "flex-.+", "grow(?:-0)?", "shrink(?:-0)?", "basis-.+", "order-.+", "-?order-.+", "(?:items|justify|content|self|place)-.+",
      "align-(?:items|self|content)-.+", "justify-content-.+", "gap(?:-[xy])?-.+", "(?:row|column)-gap-.+", "grid-(?:cols|rows|flow)-.+",
      "(?:col|row)-(?:span|start|end)-.+", "auto-(?:cols|rows)-.+", "float-.+", "clear-.+", "(?:static|fixed|absolute|relative|sticky)",
      "position-.+", "z-.+", "overflow(?:-[xy])?-.+", "object-.+", "aspect-.+", "isolate", "box-(?:border|content)", "visible", "invisible",
      "collapse", "sr-only", "not-sr-only", "visually-hidden", "translate-middle(?:-[xy])?",
      // text
      "text-.+", "font-.+", "fw-.+", "fs-\\d", "fst-.+", "lh-.+", "leading-.+", "tracking-.+", "(?:uppercase|lowercase|capitalize|normal-case)",
      "italic", "not-italic", "underline", "overline", "line-through", "no-underline", "decoration-.+", "underline-offset-.+", "truncate",
      "whitespace-.+", "break-.+", "text-wrap", "list-.+", "indent-.+", "align-(?:baseline|top|middle|bottom|text-top|text-bottom)",
      "antialiased", "subpixel-antialiased", "tabular-nums", "link-.+",
      // backgrounds, borders, effects
      "bg-.+", "from-.+", "via-.+", "to-.+", "border(?:-.+)?", "rounded(?:-.+)?", "divide-.+", "outline(?:-.+)?", "ring(?:-.+)?",
      "shadow(?:-.+)?", "opacity-.+", "mix-blend-.+", "blur(?:-.+)?", "brightness-.+", "contrast-.+", "grayscale(?:-.+)?", "drop-shadow(?:-.+)?",
      "backdrop-.+", "fill-.+", "stroke-.+",
      // interaction and motion
      "cursor-.+", "pointer-events-.+", "pe-none", "pe-auto", "select-.+", "user-select-.+", "resize(?:-.+)?", "scroll-.+", "snap-.+",
      "touch-.+", "will-change-.+", "appearance-none", "transition(?:-.+)?", "duration-.+", "ease-.+", "delay-.+", "animate-.+",
      "transform(?:-.+)?", "-?(?:scale|rotate|translate|skew)(?:-[xy])?-.+", "origin-.+",
    ].join("|") +
    ")$",
  "u",
);
/** The most declarations a utility rule has (Tailwind's shadows and rings set a few variables too). */
const MAX_UTILITY_DECLARATIONS = 8;
/** At-rules whose content is not rules (or not about elements): skipped. */
const NOT_RULES = new Set(["keyframes", "-webkit-keyframes", "font-face", "property", "page", "counter-style", "font-feature-values", "font-palette-values", "import", "charset", "namespace", "view-transition"]);
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);
/** The second half of a new class when the element has none of its own: what the element is. */
const ROLE: Readonly<Record<string, string>> = {
  a: "link", span: "text", p: "text", h1: "title", h2: "title", h3: "title", h4: "title", h5: "title", h6: "title", img: "image", picture: "picture",
  ul: "list", ol: "list", li: "item", div: "box", section: "section", article: "article", aside: "aside", header: "header", footer: "footer", nav: "nav",
  main: "main", button: "button", form: "form", input: "field", textarea: "field", select: "field", label: "label", figure: "figure",
  figcaption: "caption", svg: "icon", blockquote: "quote", time: "time", strong: "strong", em: "em", small: "small", table: "table",
};
const LANDMARKS = new Set(["header", "footer", "nav", "main", "aside", "section", "article", "form"]);
const MAX_SCRIPT_TEXT = 2 * 1024 * 1024;

/** The name of a class written in a selector, its escapes resolved (`md\:flex` → `md:flex`). */
function unescapeIdent(raw: string): string {
  return raw.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/gu, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? "";
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
  });
}

function utilityBase(name: string): string {
  // Variants (`md:`, `hover:`, `[&>p]:`) come before the last colon outside brackets; `!` marks important.
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < name.length; index++) {
    const char = name[index];
    if (char === "[") depth++;
    else if (char === "]") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) cut = index;
  }
  return name.slice(cut + 1).replace(/^!/u, "").replace(/!$/u, "");
}

export function isUtilityName(name: string): boolean {
  // BEM parts and modifiers (`card__title`, ACSS's `text--l`) are not utilities: ACSS has its own mapping (C1).
  if (name.length > 200 || /--|__/u.test(name.replace(/\[[^\]]*\]/gu, ""))) return false;
  return UTILITY.test(utilityBase(name).replace(/^-(?=[a-z])/u, ""));
}

/** Splits at top-level commas (outside parentheses, brackets and strings). */
function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      out.push(text.slice(start, index));
      start = index + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

const add = (left: Specificity, right: Specificity): Specificity => [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
const compare = (left: Specificity, right: Specificity): number => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** The highest specificity in a selector list, or null when one cannot be read. */
function listSpecificity(text: string, mentioned: string[]): Specificity | null {
  let best: Specificity = [0, 0, 0];
  for (const part of splitList(text)) {
    const analysed = analyseSelector(part);
    if (!analysed) return null;
    mentioned.push(...analysed.mentioned);
    if (compare(analysed.specificity, best) > 0) best = analysed.specificity;
  }
  return best;
}

/**
 * Specificity, last-compound requirements and named classes of one complex selector, read by a small tokenizer.
 * Null for what it does not understand (namespaces, nesting left over, broken text): such a rule is treated as one
 * that may match anything and cannot be ordered, so it blocks every conversion it overlaps.
 */
export function analyseSelector(text: string): Analysed | null {
  const source = text.trim();
  if (!source || source.length > 2000 || source.includes("&") || source.includes("|")) return null;
  let specificity: Specificity = [0, 0, 0];
  const mentioned: string[] = [];
  let compounds = 0;
  let last = { tag: null as string | null, ids: [] as string[], classes: [] as string[], attributes: [] as string[], pseudoElement: "" };
  let firstClassEnd = -1;
  let firstIsClass = false;
  let onlyPlainAfterClass = true;
  let tokensInCompound = 0;
  let index = 0;
  const ident = (): string => {
    const start = index;
    while (index < source.length) {
      const char = source[index] as string;
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (/[\w-]/u.test(char) || char.charCodeAt(0) > 0x7f) index++;
      else break;
    }
    return source.slice(start, index);
  };
  const balanced = (): string | null => {
    // At "(": returns the inside and moves past the closing parenthesis.
    let depth = 0;
    const start = index + 1;
    for (; index < source.length; index++) {
      const char = source[index];
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")" && --depth === 0) {
        index++;
        return source.slice(start, index - 1);
      }
    }
    return null;
  };
  const newCompound = (): void => {
    compounds++;
    last = { tag: null, ids: [], classes: [], attributes: [], pseudoElement: "" };
    tokensInCompound = 0;
  };
  newCompound();
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s|[>+~]/u.test(char)) {
      while (index < source.length && /\s|[>+~]/u.test(source[index] as string)) index++;
      if (index < source.length) newCompound();
      continue;
    }
    tokensInCompound++;
    if (char === "*") {
      index++;
      continue;
    }
    if (char === ".") {
      index++;
      const name = unescapeIdent(ident());
      if (!name) return null;
      specificity = add(specificity, [0, 1, 0]);
      mentioned.push(name);
      last.classes.push(name);
      if (compounds === 1 && tokensInCompound === 1) {
        firstIsClass = true;
        firstClassEnd = index;
      } else onlyPlainAfterClass = false;
      continue;
    }
    if (char === "#") {
      index++;
      const name = unescapeIdent(ident());
      if (!name) return null;
      specificity = add(specificity, [1, 0, 0]);
      last.ids.push(name);
      onlyPlainAfterClass = false;
      continue;
    }
    if (char === "[") {
      const end = (() => {
        let quote = "";
        for (let at = index + 1; at < source.length; at++) {
          const inner = source[at];
          if (inner === "\\") {
            at++;
            continue;
          }
          if (quote) {
            if (inner === quote) quote = "";
          } else if (inner === '"' || inner === "'") quote = inner;
          else if (inner === "]") return at;
        }
        return -1;
      })();
      if (end < 0) return null;
      const name = /^\s*([\w-]+)/u.exec(source.slice(index + 1, end))?.[1];
      if (!name) return null;
      specificity = add(specificity, [0, 1, 0]);
      last.attributes.push(name.toLowerCase());
      index = end + 1;
      continue;
    }
    if (char === ":") {
      const element = source[index + 1] === ":";
      index += element ? 2 : 1;
      const name = ident().toLowerCase();
      if (!name) return null;
      let argument: string | null = null;
      if (source[index] === "(") {
        argument = balanced();
        if (argument === null) return null;
      }
      if (element || (LEGACY_PSEUDO_ELEMENTS.has(name) && argument === null)) {
        specificity = add(specificity, [0, 0, 1]);
        last.pseudoElement = name;
        continue;
      }
      if (argument === null) {
        specificity = add(specificity, [0, 1, 0]);
        continue;
      }
      const inner: string[] = [];
      if (name === "where") {
        if (listSpecificity(argument, inner) === null) return null;
      } else if (["is", "not", "has", "matches", "-webkit-any", "-moz-any"].includes(name)) {
        const best = listSpecificity(argument, inner);
        if (best === null) return null;
        specificity = add(specificity, best);
      } else if (/^nth-(?:last-)?child$/u.test(name) && /\bof\b/u.test(argument)) {
        const best = listSpecificity(argument.slice(argument.search(/\bof\b/u) + 2), inner);
        if (best === null) return null;
        specificity = add(specificity, add([0, 1, 0], best));
      } else specificity = add(specificity, [0, 1, 0]);
      mentioned.push(...inner);
      if (inner.length) onlyPlainAfterClass = false;
      continue;
    }
    if (/[a-zA-Z]/u.test(char)) {
      const name = ident().toLowerCase();
      specificity = add(specificity, [0, 0, 1]);
      last.tag = name;
      onlyPlainAfterClass = false;
      continue;
    }
    return null;
  }
  const simple = compounds === 1 && firstIsClass && onlyPlainAfterClass && last.ids.length === 0 && last.classes.length === 1
    ? { name: last.classes[0] as string, suffix: source.slice(firstClassEnd) }
    : null;
  return { specificity, ...last, mentioned, simple };
}

/** A property's family: what a shorthand and its longhands share, so `padding` and `padding-inline` overlap. */
export function propertyFamily(prop: string): string {
  const name = prop.toLowerCase();
  if (name.startsWith("--")) return name;
  const bare = name.replace(/^-(?:webkit|moz|ms|o)-/u, "");
  if (["top", "right", "bottom", "left", "inset"].some((side) => bare === side || bare.startsWith("inset-"))) return "inset";
  if (/^(?:row-|column-)?gap$/u.test(bare) || bare === "grid-gap" || bare === "grid-row-gap" || bare === "grid-column-gap") return "gap";
  if (/^(?:place|align|justify)-/u.test(bare)) return bare;
  if (bare.startsWith("text-decoration")) return "text-decoration";
  if (bare.startsWith("text-") || bare.startsWith("font-") && !["font-family", "font-size", "font-weight", "font-style", "line-height"].includes(bare)) return bare.split("-").slice(0, 2).join("-");
  if (["font-family", "font-size", "font-weight", "font-style", "line-height", "font"].includes(bare)) return "font";
  if (bare.startsWith("grid")) return "grid";
  if (bare.startsWith("flex")) return "flex";
  return bare.split("-")[0] as string;
}

/** Every style rule of the sheets in source order, nesting resolved, with its layer and its @media/@supports context. */
function placeRules(sheets: readonly string[]): PlacedRule[] {
  const out: PlacedRule[] = [];
  const layerRank = new Map<string, number>();
  let order = 0;
  let anonymous = 0;
  const rankOf = (name: string): number => {
    if (!layerRank.has(name)) layerRank.set(name, layerRank.size);
    return layerRank.get(name) as number;
  };
  const walk = (container: Container, selectors: string[] | null, layer: string | null, context: string[]): void => {
    for (const node of (container.nodes ?? []) as ChildNode[]) {
      if (node.type === "rule") {
        const rule = node as Rule;
        const own = splitList(rule.selector);
        // A parent that is one compound (`.hover\:x`) stands in for `&` as it is, so `&:hover` stays a plain rule.
        // Nesting multiplies selectors and their length: past these limits the rule is left out (it then counts as
        // unreadable, below, so it can only keep utilities).
        if ((selectors?.length ?? 1) * own.length > 200 || (selectors ?? []).some((parent) => own.some((child) => parent.length * Math.max(1, child.split("&").length - 1) > 2000))) {
          const mentioned = [...`${(selectors ?? []).join(",")},${rule.selector}`.matchAll(/\.((?:\\.|[\w-])+)/gu)].map((match) => unescapeIdent(match[1] ?? ""));
          rule.walkDecls((declaration) => {
            out.push({ order: order++, layer: layer === null ? Number.POSITIVE_INFINITY : rankOf(layer), context, selector: "", analysed: null, mentioned, declarations: [{ prop: declaration.prop, value: declaration.value, important: declaration.important === true }] });
          });
          continue;
        }
        const resolved = selectors === null ? own : selectors.flatMap((parent) => {
          const written = /^[^\s>+~,]+$/u.test(parent) ? parent : `:is(${parent})`;
          return own.map((child) => (child.includes("&") ? child.replaceAll("&", written) : `${written} ${child}`));
        });
        const declarations = (rule.nodes ?? []).filter((child): child is Declaration => child.type === "decl").map((declaration) => ({ prop: declaration.prop, value: declaration.value, important: declaration.important === true }));
        if (declarations.length) {
          for (const selector of resolved) out.push({ order: order++, layer: layer === null ? Number.POSITIVE_INFINITY : rankOf(layer), context, selector, analysed: analyseSelector(selector), declarations });
        }
        walk(rule, resolved, layer, context);
        continue;
      }
      if (node.type !== "atrule") continue;
      const atRule = node as AtRule;
      const name = atRule.name.toLowerCase();
      if (NOT_RULES.has(name)) continue;
      if (name === "layer") {
        const names = atRule.params.split(",").map((item) => item.trim()).filter(Boolean).map((item) => (layer ? `${layer}.${item}` : item));
        if (!atRule.nodes) {
          for (const item of names) rankOf(item);
          continue;
        }
        const inner = names[0] ?? `${layer ? `${layer}.` : ""}#${anonymous++}`;
        rankOf(inner);
        walk(atRule, selectors, inner, context);
        continue;
      }
      if (!atRule.nodes) continue;
      const inner = [...context, `@${atRule.name} ${atRule.params}`.trim()];
      // Declarations straight inside an at-rule nested in a rule (`.x { @media (…) { color: red } }`) style the rule.
      const direct = atRule.nodes.filter((child): child is Declaration => child.type === "decl").map((declaration) => ({ prop: declaration.prop, value: declaration.value, important: declaration.important === true }));
      if (selectors !== null && direct.length) {
        for (const selector of selectors) out.push({ order: order++, layer: layer === null ? Number.POSITIVE_INFINITY : rankOf(layer), context: inner, selector, analysed: analyseSelector(selector), declarations: direct });
      }
      walk(atRule, selectors, layer, inner);
    }
  };
  for (const css of sheets) {
    let root: postcss.Root;
    try {
      root = postcss.parse(css);
    } catch {
      continue;
    }
    walk(root, null, null, []);
  }
  return out;
}

const attributeOf = (element: SiteElement, name: string): string | undefined => element.attrs.find(([key]) => key === name)?.[1];
const classesOf = (element: SiteElement): string[] => (attributeOf(element, "class") ?? "").split(/\s+/u).filter(Boolean);

function mightMatch(analysed: Analysed, element: SiteElement, classes: ReadonlySet<string>): boolean {
  if (analysed.tag && analysed.tag !== element.tag) return false;
  const id = attributeOf(element, "id");
  if (analysed.ids.some((name) => name !== id)) return false;
  if (analysed.classes.some((name) => !classes.has(name))) return false;
  return analysed.attributes.every((name) => element.attrs.some(([key]) => key === name));
}

function styleDeclarations(style: string): Array<{ prop: string; value: string; important: boolean }> | null {
  try {
    const root = postcss.parse(`a{${style}}`);
    const rule = root.first;
    if (!rule || rule.type !== "rule" || root.nodes.length !== 1) return null;
    const out: Array<{ prop: string; value: string; important: boolean }> = [];
    for (const node of rule.nodes ?? []) {
      if (node.type !== "decl") return null;
      out.push({ prop: node.prop, value: node.value, important: node.important === true });
    }
    return out;
  } catch {
    return null;
  }
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "");
}

/** The class names a script names in its strings (`classList.add("hidden")`, `".is-open"`): never converted. */
export function scriptClassNames(scripts: readonly string[]): Set<string> {
  const out = new Set<string>();
  let budget = MAX_SCRIPT_TEXT;
  for (const script of scripts) {
    const text = script.slice(0, Math.max(0, budget));
    budget -= text.length;
    for (const match of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n]){1,2000})\1/gu)) {
      for (const word of (match[2] ?? "").split(/[\s.,>+~#()[\]="']+/u)) if (word && word.length <= 200) out.add(word);
    }
    if (budget <= 0) break;
  }
  return out;
}

/**
 * Converts the utility classes and inline styles of the pages in place (doc 18 §6.4, §6.5). `sheets` are the site's
 * sheets as the conversion keeps them, in order; `scriptClasses` the names the site's scripts use.
 */
export function convertUtilityClasses(pages: ReadonlyArray<{ nodes: SiteNode[] }>, sheets: readonly string[], scriptClasses: ReadonlySet<string>, options: { keepUnstyled?: boolean; book?: ImportChoiceBook } = {}): UtilityConversion {
  const rules = placeRules(sheets);
  /** Classes some selector names in a way a conversion would break. */
  const referenced = new Set<string>();
  const simpleRules = new Map<string, PlacedRule[]>();
  let unreadable = false;
  for (const rule of rules) {
    if (!rule.analysed) {
      unreadable = true;
      for (const name of rule.mentioned ?? [...rule.selector.matchAll(/\.((?:\\.|[\w-])+)/gu)].map((match) => unescapeIdent(match[1] ?? ""))) referenced.add(name);
      continue;
    }
    const simple = rule.analysed.simple;
    if (simple) {
      const list = simpleRules.get(simple.name) ?? [];
      list.push(rule);
      simpleRules.set(simple.name, list);
    } else for (const name of rule.analysed.mentioned) referenced.add(name);
  }
  const reasons = { referenced: new Set<string>(), script: new Set<string>(), important: new Set<string>(), cascade: new Set<string>(), layers: new Set<string>() };
  const convertible = (name: string): boolean => {
    if (!isUtilityName(name)) return false;
    if (referenced.has(name)) {
      reasons.referenced.add(name);
      return false;
    }
    const own = simpleRules.get(name);
    if (!own?.length) return false;
    if (scriptClasses.has(name)) {
      reasons.script.add(name);
      return false;
    }
    if (own.some((rule) => rule.declarations.length > MAX_UTILITY_DECLARATIONS)) return false;
    if (own.some((rule) => rule.declarations.some((declaration) => declaration.important))) {
      reasons.important.add(name);
      return false;
    }
    return true;
  };
  const convertibleCache = new Map<string, boolean>();
  const isConvertible = (name: string): boolean => {
    let known = convertibleCache.get(name);
    if (known === undefined) {
      known = convertible(name);
      convertibleCache.set(name, known);
    }
    return known;
  };

  // Rules indexed by what their last compound requires, to find those that may match an element.
  const byKey = new Map<string, PlacedRule[]>();
  const unknown: PlacedRule[] = [];
  for (const rule of rules) {
    const analysed = rule.analysed;
    if (!analysed) {
      unknown.push(rule);
      continue;
    }
    const key = analysed.ids[0] ? `#${analysed.ids[0]}` : analysed.classes[0] ? `.${analysed.classes[0]}` : analysed.tag ? analysed.tag : "*";
    const list = byKey.get(key) ?? [];
    list.push(rule);
    byKey.set(key, list);
  }
  const competitorsOf = (element: SiteElement, classes: ReadonlySet<string>): PlacedRule[] => {
    const keys = ["*", element.tag, ...[...classes].map((name) => `.${name}`)];
    const id = attributeOf(element, "id");
    if (id) keys.push(`#${id}`);
    const out: PlacedRule[] = [...unknown];
    for (const key of new Set(keys)) for (const rule of byKey.get(key) ?? []) if (rule.analysed && mightMatch(rule.analysed, element, classes)) out.push(rule);
    return out;
  };

  /** Whether a competing rule still decides the property the same way after the utility's rule becomes the new class. */
  const keepsOutcome = (utility: PlacedRule, other: PlacedRule): boolean => {
    const families = new Set(utility.declarations.map((declaration) => propertyFamily(declaration.prop)));
    const overlap = other.declarations.filter((declaration) => families.has(propertyFamily(declaration.prop)));
    if (!overlap.length) return true;
    if (!other.analysed) return false;
    if (other.analysed.pseudoElement !== utility.analysed?.pseudoElement) return true;
    // An !important rule wins over both the utility and the new class.
    if (overlap.every((declaration) => declaration.important)) return true;
    const otherWon = other.layer !== utility.layer ? other.layer > utility.layer : compare(other.analysed.specificity, utility.analysed?.specificity ?? [0, 0, 0]) !== 0 ? compare(other.analysed.specificity, utility.analysed?.specificity ?? [0, 0, 0]) > 0 : other.order > utility.order;
    if (!otherWon) return true;
    return other.layer === Number.POSITIVE_INFINITY && compare(other.analysed.specificity, utility.analysed?.specificity ?? [0, 0, 0]) > 0;
  };

  interface Plan { element: SiteElement; converted: string[]; rules: PlacedRule[]; style: Array<{ prop: string; value: string; important: boolean }>; keptStyle: string }
  const plans: Plan[] = [];
  const utilitiesKept = new Set<string>();
  let styleMoved = 0;
  let styleKept = 0;
  /** Utility names no rule of the site styles, no selector names and no script uses: they do nothing, and go. */
  const mentionedAnywhere = new Set(rules.flatMap((rule) => rule.analysed?.mentioned ?? []));
  const deadUtilities = new Set<string>();
  const plan = (element: SiteElement): void => {
    const dead = classesOf(element).filter((name) => isUtilityName(name) && !mentionedAnywhere.has(name) && !scriptClasses.has(name) && !unreadable && options.keepUnstyled !== true);
    if (dead.length) {
      for (const name of dead) deadUtilities.add(name);
      const kept = classesOf(element).filter((name) => !dead.includes(name));
      const index = element.attrs.findIndex(([attribute]) => attribute === "class");
      if (kept.length) element.attrs[index] = ["class", kept.join(" ")];
      else element.attrs.splice(index, 1);
    }
    const classes = classesOf(element);
    const set = new Set(classes);
    let candidates = classes.filter((name) => !ACTIVE_CLASS.test(name) && isConvertible(name));
    const style = attributeOf(element, "style");
    if (!candidates.length && !style) {
      for (const name of classes) if (isUtilityName(name) && (simpleRules.has(name) || referenced.has(name))) utilitiesKept.add(name);
      return;
    }
    const competitors = candidates.length || style ? competitorsOf(element, set) : [];
    // Repeated until stable: a utility left out competes with the others.
    for (let changed = true; changed && candidates.length;) {
      changed = false;
      const chosen = new Set(candidates);
      const own = candidates.flatMap((name) => simpleRules.get(name) ?? []);
      for (const name of candidates) {
        const mine = simpleRules.get(name) ?? [];
        const others = competitors.filter((rule) => !(rule.analysed?.simple && chosen.has(rule.analysed.simple.name)));
        const crossLayer = own.some((rule) => !mine.includes(rule) && mine.some((utility) => utility.layer !== rule.layer && utility.analysed?.pseudoElement === rule.analysed?.pseudoElement && utility.declarations.some((declaration) => rule.declarations.some((otherDeclaration) => propertyFamily(otherDeclaration.prop) === propertyFamily(declaration.prop)))));
        if (crossLayer || !mine.every((utility) => others.every((other) => keepsOutcome(utility, other)))) {
          (crossLayer ? reasons.layers : reasons.cascade).add(name);
          candidates = candidates.filter((candidate) => candidate !== name);
          changed = true;
          break;
        }
      }
    }
    for (const name of classes) if (isUtilityName(name) && (simpleRules.has(name) || referenced.has(name)) && !candidates.includes(name)) utilitiesKept.add(name);
    const chosenRules = candidates.flatMap((name) => simpleRules.get(name) ?? []).sort((left, right) => left.order - right.order);
    // Inline style: a declaration moves when the new class still wins where the inline style did.
    const moved: Array<{ prop: string; value: string; important: boolean }> = [];
    let keptStyle = style ?? "";
    if (style) {
      const declarations = styleDeclarations(style);
      if (declarations) {
        const kept: string[] = [];
        const remaining = competitors.filter((rule) => !(rule.analysed?.simple && candidates.includes(rule.analysed.simple.name)));
        const stateFamilies = new Set(chosenRules.filter((rule) => rule.context.length || rule.analysed?.simple?.suffix).flatMap((rule) => rule.declarations.map((declaration) => propertyFamily(declaration.prop))));
        for (const declaration of declarations) {
          const family = propertyFamily(declaration.prop);
          const beaten = remaining.some((rule) => (!rule.analysed || (rule.analysed.pseudoElement === "" && compare(rule.analysed.specificity, [0, 1, 0]) > 0)) && rule.declarations.some((other) => !other.important && propertyFamily(other.prop) === family));
          if (declaration.important || beaten || stateFamilies.has(family) || /[{};]/u.test(declaration.value)) kept.push(`${declaration.prop}: ${declaration.value}${declaration.important ? " !important" : ""}`);
          else moved.push(declaration);
        }
        keptStyle = kept.join("; ");
        styleMoved += moved.length;
        styleKept += kept.length;
      } else styleKept++;
    }
    if (!chosenRules.length && !moved.length) return;
    plans.push({ element, converted: candidates, rules: chosenRules, style: moved, keptStyle });
  };
  const walk = (node: SiteNode): void => {
    if (node.kind !== "element") return;
    plan(node);
    for (const child of node.children) walk(child);
  };
  for (const page of pages) for (const node of page.nodes) walk(node);
  const keptNote = (): string[] => utilitiesKept.size ? [`${utilitiesKept.size} classi utility tenute come sono: ${[reasons.referenced.size ? "usate da selettori composti" : "", reasons.script.size ? "nominate dagli script" : "", reasons.important.size ? "con !important" : "", reasons.cascade.size ? "la cascata cambierebbe" : "", reasons.layers.size ? "in layer diversi" : ""].filter(Boolean).join(", ") || "la cascata non garantisce lo stesso aspetto"}`] : [];
  const deadNote = (): string[] => deadUtilities.size ? [`${deadUtilities.size} classi utility senza regole nel CSS del sito tolte`] : [];
  if (!plans.length) return { added: [], css: "", notes: [...keptNote(), ...deadNote()], origin: new Map() };

  // Names: the element's own class when it has one no rule styles and every element with it converts the same way;
  // else `<block>__<role>`, the block being the nearest ancestor's first class (or the element's id, or its tag).
  const planOf = new Map(plans.map((item) => [item.element, item]));
  const signature = (item: Plan): string => JSON.stringify([item.rules.map((rule) => rule.order), item.style]);
  const ownClassSignatures = new Map<string, Set<string>>();
  const ownerCount = new Map<string, number>();
  const allWithClass = new Map<string, number>();
  const countClasses = (node: SiteNode): void => {
    if (node.kind !== "element") return;
    for (const name of classesOf(node)) {
      allWithClass.set(name, (allWithClass.get(name) ?? 0) + 1);
      const item = planOf.get(node);
      const owner = classesOf(node).find((candidate) => !isUtilityName(candidate) && !ACTIVE_CLASS.test(candidate));
      if (owner === name) {
        ownerCount.set(name, (ownerCount.get(name) ?? 0) + 1);
        const set = ownClassSignatures.get(name) ?? new Set<string>();
        set.add(item ? signature(item) : "");
        ownClassSignatures.set(name, set);
      }
    }
    for (const child of node.children) countClasses(child);
  };
  for (const page of pages) for (const node of page.nodes) countClasses(node);
  const styled = new Set(rules.flatMap((rule) => rule.analysed?.mentioned ?? []));
  const nameSignature = new Map<string, string>();
  const reserved = new Set(allWithClass.keys());
  const original = new Set(reserved);
  const added = new Set<string>();
  const css: Array<(name: string) => string> = [];
  /** The default name each entry of `css` is written for. */
  const cssOwner: string[] = [];
  /** Default name → the context of its first element, for the new names only (not a class of the site reused). */
  const fresh = new Map<string, string>();
  const assigned: SiteElement[] = [];
  const written = new Set<string>();
  const nameFor = (item: Plan, ancestors: readonly SiteElement[]): { name: string; reuse: boolean } => {
    const key = signature(item);
    const owner = classesOf(item.element).find((name) => !isUtilityName(name) && !ACTIVE_CLASS.test(name));
    // An unstyled class every element carrying it shares (a hook like `card` with only utilities) takes the CSS itself.
    if (owner && !styled.has(owner) && ownClassSignatures.get(owner)?.size === 1 && ownerCount.get(owner) === allWithClass.get(owner) && (nameSignature.get(owner) ?? key) === key && /^[a-z][a-z0-9_-]*$/iu.test(owner)) return { name: owner, reuse: true };
    // The nearest ancestor's own class, else its id, else a landmark (`header__box`, `section__title`).
    const ancestor = [...ancestors].reverse().map((element) => classesOf(element).find((name) => !isUtilityName(name) && !ACTIVE_CLASS.test(name)) ?? (slug(attributeOf(element, "id") ?? "") || (LANDMARKS.has(element.tag) ? element.tag : undefined))).find(Boolean);
    const role = ROLE[item.element.tag] ?? (slug(item.element.tag) || "box");
    const id = attributeOf(item.element, "id");
    // Only a plain CSS identifier becomes part of a new class: the name is written into the CSS as it is.
    const block = [owner, ancestor].map((name) => name?.split(/__|--/u)[0] ?? "").find((name) => /^[a-zA-Z][\w-]{0,60}$/u.test(name)) ?? "";
    let base = block ? `${block}__${role}` : (id && slug(id)) || role;
    if (!/^[a-z]/u.test(base)) base = `x-${base}`;
    let name = base;
    for (let counter = 2; (nameSignature.has(name) && nameSignature.get(name) !== key) || (!nameSignature.has(name) && reserved.has(name)); counter++) name = `${base}-${counter}`;
    return { name, reuse: false };
  };
  const apply = (node: SiteNode, ancestors: SiteElement[]): void => {
    if (node.kind !== "element") return;
    const item = planOf.get(node);
    if (item) {
      const { name, reuse } = nameFor(item, ancestors);
      if (!reuse && !fresh.has(name)) fresh.set(name, describeElement(node, ancestors));
      assigned.push(node);
      const key = signature(item);
      nameSignature.set(name, key);
      reserved.add(name);
      const remaining = classesOf(node).filter((candidate) => !item.converted.includes(candidate) && candidate !== name);
      const classAttribute = node.attrs.find(([attribute]) => attribute === "class");
      const value = [name, ...remaining].join(" ");
      if (classAttribute) classAttribute[1] = value;
      else node.attrs.push(["class", value]);
      if (item.style.length) {
        const styleAttribute = node.attrs.findIndex(([attribute]) => attribute === "style");
        if (item.keptStyle) node.attrs[styleAttribute] = ["style", item.keptStyle];
        else if (styleAttribute >= 0) node.attrs.splice(styleAttribute, 1);
      }
      added.add(name);
      if (!written.has(name)) {
        written.add(name);
        // Rules of the same state and @media join one block, unless a rule between them sets the same property.
        const groups: Array<{ key: string; rule: PlacedRule; declarations: PlacedRule["declarations"] }> = [];
        for (const rule of item.rules) {
          const key = JSON.stringify([rule.context, rule.analysed?.simple?.suffix ?? ""]);
          const families = new Set(rule.declarations.map((declaration) => propertyFamily(declaration.prop)));
          let target = groups.length - 1;
          while (target >= 0 && groups[target]?.key !== key) target--;
          const blocked = target < 0 || groups.slice(target + 1).some((group) => group.declarations.some((declaration) => families.has(propertyFamily(declaration.prop))));
          if (blocked) groups.push({ key, rule, declarations: [...rule.declarations] });
          else groups[target]?.declarations.push(...rule.declarations);
        }
        for (const group of groups) {
          const suffix = group.rule.analysed?.simple?.suffix ?? "";
          const contexts = [...group.rule.context].reverse();
          const body = group.declarations.map((declaration) => `  ${declaration.prop}: ${declaration.value};`).join("\n");
          css.push((final) => {
            let block = `.${final}${suffix} {\n${body}\n}`;
            for (const context of contexts) block = `${context} {\n${block}\n}`;
            return block;
          });
          cssOwner.push(name);
        }
        if (item.style.length) {
          const body = item.style.map((declaration) => `  ${declaration.prop}: ${declaration.value};`).join("\n");
          css.push((final) => `.${final} {\n${body}\n}`);
          cssOwner.push(name);
        }
      }
    }
    ancestors.push(node);
    for (const child of node.children) apply(child, ancestors);
    ancestors.pop();
  };
  for (const page of pages) for (const node of page.nodes) apply(node, []);

  // Doc 27: the new names may be answered (a model, a person): every default is known now, so an answer is checked
  // against all of them, and written over the default on the elements and in the CSS.
  const finals = options.book && fresh.size ? options.book.pickNames("classe", [...fresh].map(([name, context]) => ({ key: name, value: name, context })), new Set([...original, ...scriptClasses]), (value) => (isUtilityName(value) ? "sembra una classe utility" : null)) : new Map<string, string>();
  const finalOf = (name: string): string => finals.get(name) ?? name;
  const origin = new Map<string, string>();
  for (const [name, final] of finals) if (final !== name) origin.set(final, name);
  if (origin.size) {
    for (const node of assigned) {
      const classAttribute = node.attrs.find(([attribute]) => attribute === "class");
      if (classAttribute) classAttribute[1] = classAttribute[1].split(" ").map(finalOf).join(" ");
    }
  }

  const converted = new Set(plans.flatMap((item) => item.converted)).size;
  // Only inline styles moved (no utility): the new classes hold those, and the style note below says so.
  const notes = converted
    ? [`${converted} classi utility convertite in ${added.size} classi BEM, con il controllo di equivalenza del CSS (stessa cascata, nessuna differenza visiva)`]
    : added.size ? [`${added.size} ${added.size === 1 ? "classe BEM nuova" : "classi BEM nuove"} per gli stili style="" portati nel CSS`] : [];
  notes.push(...keptNote(), ...deadNote());
  if (styleMoved) notes.push(`${styleMoved} dichiarazioni di style="" portate nel CSS del selettore`);
  if (styleKept) notes.push(`${styleKept} dichiarazioni di style="" tenute nell'HTML: nel CSS del selettore la cascata cambierebbe`);
  if (unreadable) notes.push("alcuni selettori del sito non si leggono: le utility che toccano le stesse proprietà restano come sono");
  return { added: [...added].map(finalOf), css: css.map((write, index) => write(finalOf(cssOwner[index] as string))).join("\n"), notes, origin };
}
