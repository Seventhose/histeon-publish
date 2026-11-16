import postcss from "postcss";
import type { ImportChoiceBook } from "./import-choices.js";
import { ACTIVE_CLASS, describeElement, type SiteElement, type SiteNode } from "./site-structure.js";

/**
 * Doc 18 §6.3: an inline element without a class (a link, a `span`, a `time`…) is folded into the text around it,
 * and the builder cannot select it. When the site's CSS styles it with a rule of its own (`.hero h1 em`,
 * `.site-nav a[aria-current]`), the user expects to click it: it gets a class, so it stays an element. The rules are
 * not rewritten (they still match), and an inline element no rule styles stays in the text, editable in place.
 * An inline element that is not inside a sentence (its parent has no text of its own, as the links of a menu) gets
 * a class too: there is no text run to keep it in.
 *
 * The matching covers what such rules use: type, class, id and attribute selectors, descendant and child
 * combinators. Pseudo-classes and pseudo-elements are left out (`a:hover` styles the link too). A selector with
 * anything else (functions, sibling combinators) is not used: it can only leave an element in the text.
 */

/** Inline tags the DSL folds into text when they carry no class (TRANSFER_INLINE_TAGS without br, kbd and wbr). */
const INLINE = new Set(["a", "abbr", "b", "code", "em", "i", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);
/** The second half of the new class: what the element is. */
/** Elements never given a class: the page's frame, what has no box of its own, and `kbd` (only in a text run). */
const NEVER = new Set(["br", "hr", "kbd", "wbr", "source", "option", "optgroup", "tbody", "thead", "tr", "td", "th", "li", "dt", "dd"]);
const ROLE: Readonly<Record<string, string>> = { a: "link", span: "text", time: "time", em: "em", strong: "strong", b: "strong", i: "em", small: "small", code: "code", mark: "mark", abbr: "abbr", q: "quote", s: "strike", u: "underline", sub: "sub", sup: "sup" };

interface Compound { tag: string | null; classes: string[]; id: string | null; attributes: Array<{ name: string; value: string | null }> }
interface Selector { compounds: Compound[]; combinators: Array<" " | ">"> }

/**
 * The selectors of the sheets that style an element by its place (`.hero h1`, `.nav a[aria-current]`): more than one
 * part, or an attribute on the last one. A plain element rule (`a { color }`, `h1 { … }`) styles every such element
 * of the site, as a theme does: it is no reason for a class of its own.
 */
export function inlineSelectors(css: readonly string[]): Selector[] {
  const out: Selector[] = [];
  for (const sheet of css) {
    let root: postcss.Root;
    try {
      root = postcss.parse(sheet);
    } catch {
      continue;
    }
    root.walkRules((rule) => {
      for (const text of rule.selectors ?? []) {
        const selector = parseSelector(text);
        const last = selector?.compounds.at(-1);
        if (selector && last?.tag && !last.classes.length && !last.id && (selector.compounds.length > 1 || last.attributes.length)) out.push(selector);
        if (out.length >= 5000) return false;
      }
      return undefined;
    });
  }
  return out;
}

function parseSelector(text: string): Selector | null {
  // Pseudo-classes and pseudo-elements without arguments are dropped; anything with parentheses is not used.
  const source = text.trim().replace(/::?[a-z-]+(?![(\w-])/giu, "");
  if (!source || /[(+~,]|\\|\|/u.test(source) || source.length > 300) return null;
  const tokens = source.replace(/\s*>\s*/gu, " > ").split(/\s+/u).filter(Boolean);
  const compounds: Compound[] = [];
  const combinators: Array<" " | ">"> = [];
  let pending: " " | ">" = " ";
  for (const token of tokens) {
    if (token === ">") {
      pending = ">";
      continue;
    }
    const compound = parseCompound(token);
    if (!compound) return null;
    if (compounds.length) combinators.push(pending);
    compounds.push(compound);
    pending = " ";
  }
  return compounds.length ? { compounds, combinators } : null;
}

function parseCompound(token: string): Compound | null {
  const compound: Compound = { tag: null, classes: [], id: null, attributes: [] };
  const pattern = /^([a-z][a-z0-9-]*|\*)?((?:\.[A-Za-z_-][\w-]*|#[A-Za-z_-][\w-]*|\[[a-z][a-z0-9-]*(?:[~|^$*]?=(?:"[^"]*"|'[^']*'|[^\]]*))?\])*)$/iu;
  const match = pattern.exec(token);
  if (!match) return null;
  if (match[1] && match[1] !== "*") compound.tag = match[1].toLowerCase();
  for (const part of (match[2] ?? "").match(/\.[A-Za-z_-][\w-]*|#[A-Za-z_-][\w-]*|\[[^\]]*\]/gu) ?? []) {
    if (part.startsWith(".")) compound.classes.push(part.slice(1));
    else if (part.startsWith("#")) compound.id = part.slice(1);
    else {
      const attribute = /^\[([a-z][a-z0-9-]*)(?:([~|^$*]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/iu.exec(part);
      if (!attribute) return null;
      // Only presence and exact value: other operators count as presence, which can only add a class.
      compound.attributes.push({ name: (attribute[1] ?? "").toLowerCase(), value: attribute[2] ? null : attribute[3] ?? attribute[4] ?? attribute[5] ?? null });
    }
  }
  return compound;
}

const attributeOf = (element: SiteElement, name: string): string | undefined => element.attrs.find(([key]) => key === name)?.[1];
const classesOf = (element: SiteElement): string[] => (attributeOf(element, "class") ?? "").split(/\s+/u).filter(Boolean);

function matchesCompound(element: SiteElement, compound: Compound): boolean {
  if (compound.tag && element.tag !== compound.tag) return false;
  if (compound.id && attributeOf(element, "id") !== compound.id) return false;
  const classes = classesOf(element);
  if (compound.classes.some((name) => !classes.includes(name))) return false;
  return compound.attributes.every(({ name, value }) => {
    const actual = attributeOf(element, name);
    return actual !== undefined && (value === null || actual === value);
  });
}

/** Every class a selector of the sheets names, whatever the selector: the names a new class must not take. */
export function styledClasses(css: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const sheet of css) {
    let root: postcss.Root;
    try {
      root = postcss.parse(sheet);
    } catch {
      continue;
    }
    root.walkRules((rule) => {
      for (const match of rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)) out.add(match[1] as string);
    });
  }
  return out;
}

/** Whether the selector matches the element, given its ancestors (nearest last). */
export function selectorMatches(selector: Selector, element: SiteElement, ancestors: readonly SiteElement[]): boolean {
  const { compounds, combinators } = selector;
  if (!matchesCompound(element, compounds.at(-1) as Compound)) return false;
  let position = ancestors.length - 1;
  for (let index = compounds.length - 2; index >= 0; index--) {
    const compound = compounds[index] as Compound;
    if (combinators[index] === ">") {
      if (position < 0 || !matchesCompound(ancestors[position] as SiteElement, compound)) return false;
      position--;
    } else {
      while (position >= 0 && !matchesCompound(ancestors[position] as SiteElement, compound)) position--;
      if (position < 0) return false;
      position--;
    }
  }
  return true;
}

/**
 * Gives a class to every element without class or id that a rule styles by its place, and to the inline ones
 * outside a sentence: `<block>__<role>`, with `block`
 * the first class of the nearest ancestor that has one (its block part), or the role alone. Returns the classes
 * added, for the list of the classes in use.
 */
export function classStyledInlineElements(pages: ReadonlyArray<{ nodes: SiteNode[] }>, selectors: readonly Selector[], choices?: { book: ImportChoiceBook; origin: ReadonlyMap<string, string>; taken: ReadonlySet<string>; styled?: ReadonlySet<string> }): string[] {
  const added = new Set<string>();
  /**
   * Doc 28: a name made here must not be a class the site's CSS already names for something else (`.piede__link` on
   * the list of the footer's links): the element would take those rules and change. Such a name gets a number.
   */
  const styled = choices?.styled;
  const free = (wanted: string): string => {
    if (!styled?.has(wanted)) return wanted;
    for (let index = 2; index < 1000; index++) if (!styled.has(`${wanted}-${index}`)) return `${wanted}-${index}`;
    return wanted;
  };
  // Doc 27: the names in the site before this step, so only a name made here is a choice; the block of a name comes
  // from the default of its owner's class, so the default (and the choice's id) is the same with or without answers.
  const before = new Set<string>();
  const collect = (node: SiteNode): void => {
    if (node.kind !== "element") return;
    for (const name of classesOf(node)) before.add(name);
    for (const child of node.children) collect(child);
  };
  if (choices) for (const page of pages) for (const node of page.nodes) collect(node);
  const fresh = new Map<string, string>();
  const named: SiteElement[] = [];
  /** A default name of the utility step that an answer replaced: an element that gets it here follows the rename. */
  const renamed = new Map([...(choices?.origin ?? [])].map(([final, name]) => [name, final]));
  const visit = (node: SiteNode, ancestors: SiteElement[]): void => {
    if (node.kind !== "element") return;
    const parent = ancestors.at(-1);
    const alone = parent !== undefined && parent.children.every((child) => child.kind === "element" || !child.text.trim());
    // A menu item's active state (`active`, `is-current`…) is no class of its own: B3 takes it away on every page.
    const ownClasses = classesOf(node).filter((name) => !ACTIVE_CLASS.test(name));
    const inline = INLINE.has(node.tag);
    // Doc 18 §6.4: a block a rule styles by its place (`.hero h1`) gets a class too: the canvas handles write there.
    if (!NEVER.has(node.tag) && !ownClasses.length && attributeOf(node, "id") === undefined && ((inline && alone) || selectors.some((selector) => selectorMatches(selector, node, ancestors)))) {
      const owner = [...ancestors].reverse().find((ancestor) => classesOf(ancestor).length);
      const first = owner ? (classesOf(owner)[0] as string) : "";
      const block = first ? (choices?.origin.get(first) ?? first).split(/__|--/u)[0] : "";
      const role = ROLE[node.tag] ?? node.tag;
      const byDefault = block ? `${block}__${role}` : role;
      const name = free(renamed.get(byDefault) ?? byDefault);
      const existing = node.attrs.find(([key]) => key === "class");
      if (existing) existing[1] = `${name} ${existing[1]}`;
      else node.attrs.push(["class", name]);
      added.add(name);
      if (choices && !before.has(name) && !renamed.has(byDefault)) {
        named.push(node);
        if (!fresh.has(name)) fresh.set(name, describeElement(node, ancestors));
      }
    }
    ancestors.push(node);
    for (const child of node.children) visit(child, ancestors);
    ancestors.pop();
  };
  for (const page of pages) for (const node of page.nodes) visit(node, []);
  if (!choices || !fresh.size) return [...added];
  const finals = choices.book.pickNames("classe", [...fresh].map(([name, context]) => ({ key: name, value: name, context })), new Set([...before, ...choices.taken]));
  for (const node of named) {
    const classAttribute = node.attrs.find(([key]) => key === "class");
    if (classAttribute) classAttribute[1] = classAttribute[1].split(" ").map((name, index) => (index === 0 ? finals.get(name) ?? name : name)).join(" ");
  }
  return [...added].map((name) => finals.get(name) ?? name);
}
