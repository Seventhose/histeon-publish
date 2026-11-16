import postcss, { type ChildNode, type Rule } from "postcss";
import { splitList, statements } from "../.generated/histos-dsl/css.js";
import { blockOf, overlap, planSheetMove, properties, specificities } from "../.generated/histos-dsl/scss.js";

/** What the import moved: the sheets and the selector styles to write instead, and how much went. */
export interface SelectorPort {
  sheets: string[];
  selectors: string;
  rules: number;
  blocks: number;
  /** The selector styles written, and the longest one's CSS in characters: the import checks them against its limits. */
  entries: number;
  longest: number;
  /** Blocks whose rules stay in the sheets: in the block's selector they would print in another order. */
  kept: string[];
}

// ---------------------------------------------------------------- the order an entry prints in
//
// The builder's compileCss prints an entry as: its own declarations and the nested rules that are not BEM parts
// (`&:hover`, `& a`, `@media` with them inside), then every `&__part` and `&--variant` as a rule of its own. So a rule
// written after a BEM part prints before it: `.nav__group a { background }` then `.nav a[aria-current] { background }`
// (same weight, the second wins) come out the other way round. planSheetMove looks at the order between entries and
// sheets, not inside one entry: here a block whose entry would turn two such rules stays in the sheets as it was.
//
// The builder has its own correction (planSheetMove keeps the BEM part in the sheet, builder commit 8f52a7e), which
// is in the pinned copy of the builder since Histeon 0.5.14 (Publish 1.39.0). With it no entry turns its rules and
// this check finds nothing on the cases known so far: it stays as a guard for the ones not known.

const GROUP = /^@(?:media|container|supports|layer)\b/iu;
/** Past this many rules in one entry nothing is compared: the block stays in the sheets. */
const MAX_PRINTED = 1500;

interface Printed {
  /** Where the rule was written, counting from the top of the entry. */
  written: number;
  selector: string;
  props: Set<string>;
  /** Null when it cannot be told simply: then it may tie with any other. */
  spec: number[] | null;
}

const isBem = (prelude: string): boolean => {
  const parts = splitList(prelude);
  return parts.length > 0 && parts.every((part) => /^&(?:__|--)/u.test(part));
};
const joinBem = (selector: string, prelude: string): string => splitList(selector).flatMap((parent) => splitList(prelude).map((part) => parent + part.slice(1))).join(",");

/** The rules of an entry in the order compileCss prints them, each with the place it was written at. */
function printedOrder(selector: string, body: string, next: () => number): Printed[] {
  const own: Printed[] = [];
  const hoisted: Printed[] = [];
  const single = splitList(selector).length === 1;
  const walk = (inner: string): void => {
    // Declarations in a row are one rule of the entry's own selector.
    let run: string[] = [];
    const flush = (): void => {
      if (run.length) own.push({ written: next(), selector, props: properties(`${run.join(";")};`), spec: specificities(selector) });
      run = [];
    };
    for (const [prelude, block] of statements(inner)) {
      if (block === null) { run.push(prelude); continue; }
      flush();
      if (isBem(prelude)) hoisted.push(...printedOrder(joinBem(selector, prelude), block, next));
      else if (GROUP.test(prelude)) walk(block);
      else if (!prelude.startsWith("@")) {
        const resolved = splitList(prelude).map((part) => (part.includes("&") ? part.replaceAll("&", selector) : `${selector} ${part}`)).join(",");
        own.push({ written: next(), selector: resolved, props: properties(block), spec: single && !block.includes("{") ? specificities(resolved) : null });
      }
    }
    flush();
  };
  walk(body);
  return [...own, ...hoisted];
}

/** The last compound of a selector: the element it selects. */
function subject(selector: string): { tag: string; bases: string[]; pseudo: string } {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index] as string;
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (depth === 0 && /[\s>+~]/u.test(char)) start = index + 1;
  }
  const compound = selector.slice(start).replace(/\[[^\]]*\]|\([^)]*\)/gu, "");
  return {
    tag: (/^[a-zA-Z][\w-]*/u.exec(compound)?.[0] ?? "").toLowerCase(),
    // `card__title--big` → `card__title`: the BEM name of the element, without its variant.
    bases: [...compound.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((match) => (match[1] as string).replace(/(?<=.)--.*$/u, "")),
    pseudo: (/::[\w-]+|:(?:before|after|first-line|first-letter)\b/iu.exec(compound)?.[0] ?? "").replace(/^:+/u, "").toLowerCase(),
  };
}

/**
 * True when two selectors do not select the same box: other tags, other pseudo-elements, or two different names of
 * the same BEM block (`.card` and `.card__title`, `.card__title` and `.card__text`: one element is one of them).
 */
function apart(one: string, other: string): boolean {
  return splitList(one).every((a) => splitList(other).every((b) => {
    const [x, y] = [subject(a), subject(b)];
    if (x.pseudo !== y.pseudo) return true;
    if (x.tag && y.tag && x.tag !== y.tag) return true;
    return x.bases.some((base) => !y.bases.includes(base) && y.bases.some((theirs) => theirs !== base && !x.bases.includes(theirs) && blockOf(theirs) === blockOf(base)));
  }));
}

const mayTie = (a: number[] | null, b: number[] | null): boolean => a === null || b === null || a.some((value) => b.includes(value));

/** Whether an entry prints two rules that may override each other in another order than they were written in. */
export function printsInAnotherOrder(selector: string, css: string): boolean {
  let count = 0;
  const list = printedOrder(selector, css, () => count++);
  if (list.length > MAX_PRINTED) return true;
  for (let index = 0; index < list.length; index++) {
    const early = list[index] as Printed;
    for (let later = index + 1; later < list.length; later++) {
      const late = list[later] as Printed;
      // Printed in the order they were written in: nothing changes.
      if (early.written < late.written) continue;
      if (mayTie(early.spec, late.spec) && overlap(early.props, late.props) !== null && !apart(early.selector, late.selector)) return true;
    }
  }
  return false;
}

/**
 * At import, the rules of every block the content uses leave the global sheets for the block's own selector, nested
 * as SCSS (`&:hover`, `&__title`, `@media` inside): what the editor's «Porta nel selettore» and «Nei selettori» do, with
 * the same code (planSheetMove of the builder's DSL), so each block has one place to read and edit. The cascade stays
 * the same: rules shared with other blocks, of blocks no document uses, or that would print in another order stay in
 * the sheets, and so does a whole block whose own entry would turn two of its rules (`kept`). Null when nothing moves or the selector styles are not plain top-level rules (the import then says why
 * as it always did): the CSS is then imported as it was written.
 */
export function portToSelectors(sheets: readonly string[], selectors: string, used: ReadonlySet<string>, onParsed?: (root: ReturnType<typeof postcss.parse>) => void): SelectorPort | null {
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(selectors);
  } catch {
    return null;
  }
  // The import's strict check reads the selector styles from this parse, the first one (prototype-strict.ts).
  onParsed?.(root);
  const styles: Array<{ selector: string; css: string }> = [];
  for (const node of root.nodes as ChildNode[]) {
    if (node.type === "comment") continue;
    if (node.type !== "rule") return null;
    const rule = node as Rule;
    const body = (rule.nodes ?? []).map((child) => (child.type === "decl" ? `${child.toString()};` : child.toString())).join("\n");
    styles.push({ selector: rule.selector.trim(), css: body });
  }
  if (new Set(styles.map((style) => style.selector)).size !== styles.length) return null;
  const list = sheets.map((css, index) => ({ id: String(index), css }));
  let plan = planSheetMove(list, styles, new Set(used));
  // A block whose entry would print its rules in another order stays in the sheets, and the others are planned again
  // with its rules counted among those that stay. Twice is enough: an entry only loses rules the second time.
  const kept = new Set<string>();
  for (let round = 0; round < 4; round++) {
    const turned = plan.entries.filter((entry) => printsInAnotherOrder(entry.selector, entry.css)).map((entry) => entry.selector.slice(1));
    if (!turned.length) break;
    if (round === 3) return null;
    for (const block of turned) kept.add(block);
    plan = planSheetMove(list, styles, new Set([...used].filter((name) => !kept.has(blockOf(name)))));
  }
  if (plan.moved === 0) return null;
  // As the editor writes them (BuilderState.moveToSelector): new entries first, in the plan's order, since the sheets
  // they come from printed before every entry; an existing entry keeps its place with the moved rules before its own.
  const fresh: Array<{ selector: string; css: string }> = [];
  const written = styles.map((style) => ({ ...style }));
  for (const entry of plan.entries) {
    const existing = written.find((style) => style.selector === entry.selector);
    if (existing) existing.css = entry.css;
    else fresh.push(entry);
  }
  const all = [...fresh, ...written];
  return {
    sheets: sheets.map((css, index) => plan.sheets[String(index)] ?? css),
    selectors: all.map((style) => `${style.selector} {\n${style.css.trim()}\n}`).join("\n\n"),
    rules: plan.moved,
    blocks: plan.blocks.length,
    entries: all.length,
    longest: Math.max(0, ...all.map((style) => style.css.length)),
    kept: [...kept],
  };
}
