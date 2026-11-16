import type { SiteElement, SiteNode } from "./site-structure.js";

/**
 * «Da rifare»: what a captured proposal did with its scripts. The capture keeps the page as it was drawn and leaves the
 * scripts out, so a button that added to a cart, a filter, a gallery or a demo form is still there and answers nothing.
 * No recipe replaces these: the report lists them, so whoever imports knows what to build again (decision of 13
 * November 2026: recipes for the mobile menu and the tabs, the rest in a list).
 *
 * Read-only: the pages are not changed. The words of the site that end up in a line (a class, a label) are cut and
 * cleaned: the report shows them as text.
 */

/** Lines of the list, at most; the rest is counted in one more line. */
const MAX_LINES = 20;

const attributeOf = (node: SiteElement, name: string): string | undefined => node.attrs.find(([key]) => key === name)?.[1];

/** The site's own word, safe to print in a line of the report. */
function word(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must go.
  return value.replace(/[\u0000-\u001f\u007f«»]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function textOf(node: SiteElement): string {
  const parts: string[] = [];
  const stack: SiteNode[] = [...node.children].reverse();
  for (let child = stack.pop(); child !== undefined && parts.join(" ").length < 80; child = stack.pop()) {
    if (child.kind === "text") parts.push(child.text);
    else if (child.tag !== "svg" && child.tag !== "style") for (let index = child.children.length - 1; index >= 0; index--) stack.push(child.children[index] as SiteNode);
  }
  return word(parts.join(" "), 30);
}

/** How the element is written in the line: `.classe [data-x]`, or its tag alone. */
function mark(node: SiteElement): string {
  const first = (attributeOf(node, "class") ?? "").split(/\s+/u).find((name) => /^-?[_a-zA-Z][\w-]*$/u.test(name));
  const data = node.attrs.map(([name]) => name).find((name) => /^data-[a-z][\w-]*$/u.test(name) && !name.startsWith("data-histos"));
  return [first ? `.${first.slice(0, 40)}` : "", data ? `[${data.slice(0, 40)}]` : ""].filter(Boolean).join(" ") || `<${node.tag}>`;
}

/** A pattern a recipe covers (static-site-prototype.ts, RECIPES): proposed there, not listed here. */
function hasRecipe(node: SiteElement): boolean {
  const classes = attributeOf(node, "class") ?? "";
  if (node.tag === "button" && attributeOf(node, "aria-expanded") !== undefined && (attributeOf(node, "aria-controls") !== undefined || /menu|nav|toggle/iu.test(classes))) return true;
  return attributeOf(node, "role") === "tab" || attributeOf(node, "data-bs-toggle") === "collapse" || attributeOf(node, "data-histos-dialog") !== undefined;
}

interface Found {
  what: string;
  why: string;
  label: string;
  count: number;
  pages: Set<string>;
}

/** The «da rifare: …» lines of a captured site, the most frequent first; empty when nothing waits for a script. */
export function lostInteractions(pages: ReadonlyArray<{ slug: string; nodes: readonly SiteNode[] }>): string[] {
  const found = new Map<string, Found>();
  const add = (page: string, what: string, why: string, label: string): void => {
    const key = `${what}\u0000${why}`;
    const entry = found.get(key) ?? { what, why, label, count: 0, pages: new Set<string>() };
    entry.count++;
    entry.pages.add(page);
    found.set(key, entry);
  };
  for (const page of pages) {
    const stack: Array<{ node: SiteNode; inForm: boolean }> = [...page.nodes].reverse().map((node) => ({ node, inForm: false }));
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      const { node } = item;
      if (node.kind !== "element") continue;
      let inForm = item.inForm;
      if (node.tag === "form") {
        inForm = true;
        const action = (attributeOf(node, "action") ?? "").trim();
        if (!action || action === "#") add(page.slug, `modulo ${mark(node)}`, "non ha un indirizzo a cui inviare", "");
      } else if (node.tag === "button" && !hasRecipe(node)) {
        const type = (attributeOf(node, "type") ?? "").toLowerCase();
        // Inside a form a button sends or empties it, unless it says `type="button"`: that is the form's line.
        if (!inForm || type === "button") add(page.slug, `pulsante ${mark(node)}`, "non risponde", textOf(node) || word(attributeOf(node, "aria-label") ?? "", 30));
      } else if (!inForm && (node.tag === "select" || node.tag === "textarea" || (node.tag === "input" && (attributeOf(node, "type") ?? "").toLowerCase() !== "hidden"))) {
        add(page.slug, `campo ${mark(node)}`, "non cambia niente", word(attributeOf(node, "aria-label") ?? attributeOf(node, "placeholder") ?? "", 30));
      } else if (node.tag === "a" && attributeOf(node, "href") === "#") {
        add(page.slug, "link «#»", "non portano da nessuna parte", "");
      } else if (node.tag !== "button" && node.tag !== "a" && node.tag !== "summary" && (attributeOf(node, "role") === "button" || attributeOf(node, "aria-pressed") !== undefined)) {
        add(page.slug, `elemento ${mark(node)}`, "non risponde", textOf(node));
      }
      for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index] as SiteNode, inForm });
    }
  }
  const all = [...found.values()].sort((left, right) => right.count - left.count || left.what.localeCompare(right.what));
  const lines = all.slice(0, MAX_LINES).map((entry) => {
    const where = entry.pages.size === pages.length && pages.length > 1 ? "in ogni pagina" : `in ${[...entry.pages].slice(0, 3).join(", ")}${entry.pages.size > 3 ? ` e altre ${entry.pages.size - 3}` : ""}`;
    return `da rifare: ${entry.what}${entry.label ? ` («${entry.label}»)` : ""}, ${entry.count} ${entry.count === 1 ? "volta" : "volte"} ${where}: ${entry.why}, lo script della proposta non è nel sito`;
  });
  if (all.length > MAX_LINES) lines.push(`da rifare: altri ${all.length - MAX_LINES} tipi di elementi che aspettavano uno script`);
  return lines;
}
