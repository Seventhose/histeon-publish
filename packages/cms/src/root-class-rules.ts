import postcss, { type Rule } from "postcss";

/**
 * V5.3a: rules a site writes on the classes of its `<body>` or `<html>` («.theme-kit { --brand: … }», «.page-x h1»).
 * A converted page has no body or html of its own: those classes reach no element, so the cleanup would drop the
 * rules as dead, and with them the site's variables, colors and fonts. Each compound made only of such classes
 * (optionally with its tag: «body.theme-kit») becomes the tag itself, so the rule stays global with the site's other
 * body and html rules and applies as it did. The specificity of a rewritten compound drops from a class to a tag; the
 * order of the sheets, kept as the site's, decides among the site's own body rules.
 *
 * A class only some pages' body has («.view-product .sheet», «.page-id-7 h1») cannot become the tag: its rules would
 * apply to every page. The conversion gives that class to one element of those pages (the mark, see
 * static-site-prototype.ts) and the compound becomes «the body that has the mark inside»: `:where(body):has(.view-product)`,
 * which weighs one class as the compound it replaces did (`body.view-product` becomes `body:has(.view-product)`).
 */

const COMPOUND = /^(html|body)?((?:\.-?[_a-zA-Z][\w-]*)+)(?![\w\\-])/iu;

/** The compounds of a selector with their place: split at combinators outside parentheses, brackets and strings. */
function compounds(selector: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let quote = "";
  let start = -1;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index] as string;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\\") {
      if (start < 0) start = index;
      index++;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if ((char === ")" || char === "]") && depth > 0) depth--;
    else if (depth === 0 && /[\s>+~]/u.test(char)) {
      if (start >= 0) out.push({ start, end: index });
      start = -1;
      continue;
    }
    if (start < 0) start = index;
  }
  if (start >= 0) out.push({ start, end: selector.length });
  return out;
}

/** The classes of the roots: `body` and `html` are those every page has, `pageBody` and `pageHtml` those only some pages have. */
export interface RootClasses {
  body: ReadonlySet<string>;
  html: ReadonlySet<string>;
  pageBody?: ReadonlySet<string>;
  pageHtml?: ReadonlySet<string>;
}

/**
 * The selector with each compound of root classes written as its tag, or null when nothing changes. A compound that
 * names a class of some pages only becomes the root that has the mark inside; `marks` receives those classes.
 */
export function rootClassSelector(selector: string, roots: RootClasses, marks?: Set<string>): string | null {
  let out = "";
  let last = 0;
  let changed = false;
  const some = { body: roots.pageBody, html: roots.pageHtml };
  for (const { start, end } of compounds(selector)) {
    const compound = selector.slice(start, end);
    const match = COMPOUND.exec(compound);
    if (!match) continue;
    const tag = match[1]?.toLowerCase();
    const classes = (match[2] ?? "").slice(1).split(".");
    const names = (["body", "html"] as const).filter((name) => !tag || tag === name);
    // A root every page gives all those classes comes first: its rule holds on every page, with no mark.
    const root = names.find((name) => classes.every((item) => roots[name].has(item))) ?? names.find((name) => classes.every((item) => roots[name].has(item) || some[name]?.has(item) === true));
    if (!root) continue;
    const own = classes.filter((item) => !roots[root].has(item));
    for (const item of own) marks?.add(item);
    out += `${selector.slice(last, start)}${own.length ? `${tag ? root : `:where(${root})`}:has(${own.map((item) => `.${item}`).join("")})` : root}`;
    last = start + match[0].length;
    changed = true;
  }
  return changed ? out + selector.slice(last) : null;
}

/**
 * A sheet with the rules on root classes written on `body` and `html` (see above), how many rules changed and the
 * classes of some pages only that the rules written name (`marks`). A sheet postcss cannot read stays as it is.
 */
export function rootClassRules(css: string, roots: RootClasses): { css: string; rules: number; marks: string[] } {
  if (!roots.body.size && !roots.html.size && !roots.pageBody?.size && !roots.pageHtml?.size) return { css, rules: 0, marks: [] };
  let parsed: ReturnType<typeof postcss.parse>;
  try {
    parsed = postcss.parse(css);
  } catch {
    return { css, rules: 0, marks: [] };
  }
  let rules = 0;
  const marks = new Set<string>();
  parsed.walkRules((rule: Rule) => {
    // Keyframe steps («from», «50%») are rules too, and never name a class.
    if (rule.parent?.type === "atrule" && /keyframes$/iu.test((rule.parent as { name: string }).name)) return;
    let changed = false;
    const selectors = rule.selectors.map((selector) => {
      const written = rootClassSelector(selector, roots, marks);
      if (written === null) return selector;
      changed = true;
      return written;
    });
    if (!changed) return;
    rule.selectors = selectors;
    rules++;
  });
  return rules ? { css: parsed.toString(), rules, marks: [...marks] } : { css, rules: 0, marks: [] };
}
