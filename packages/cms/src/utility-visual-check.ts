import { type SiteNode, VOID_TAGS } from "./site-structure.js";

/**
 * Doc 23 item 101: the screenshot check of the utility conversion, in Publish only. The cascade check of
 * utility-classes.ts stays the rule everywhere (it is all the WordPress admin has); where the desktop app is there, the
 * importer also gives it each page as it was before the conversion and after it, and the app photographs both with
 * scripts off and no network, then counts the pixels that differ. The two documents differ only in classes, inline
 * styles and the converted CSS: everything else (missing images, fallback fonts) is the same on both sides.
 */
export interface UtilityVisualPair {
  /** The page's slug. */
  page: string;
  before: string;
  after: string;
}

/** Pages compared at most: the first ones the conversion changed, home first. */
export const UTILITY_VISUAL_PAGES = 3;
/** Pages whose markup is kept before the conversion, to find those it changed. */
export const UTILITY_VISUAL_CANDIDATES = 20;
/** A document larger than this is not compared (the sheets of a utility framework can be large). */
export const UTILITY_VISUAL_MAX_CHARS = 6 * 1024 * 1024;

/** Motion would make two photographs of the same page differ. */
const STILL = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}";

const text = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** Plain HTML of sanitized nodes (renderNodes writes the DSL's escapes, which a browser would show). */
function plain(nodes: readonly SiteNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += text(node.text);
      continue;
    }
    const attrs = node.attrs.map(([name, value]) => ` ${name}="${attribute(value)}"`).join("");
    out += VOID_TAGS.has(node.tag) ? `<${node.tag}${attrs}>` : `<${node.tag}${attrs}>${plain(node.children)}</${node.tag}>`;
  }
  return out;
}

/** The markup of a page's body, to tell the pages the conversion changed. */
export function visualBody(nodes: readonly SiteNode[]): string {
  return plain(nodes);
}

/** A whole document of the page with its sheets, in order; `</style` inside a sheet cannot close it. */
export function visualDocument(body: string, sheets: readonly string[]): string {
  const styles = [...sheets, STILL].map((css) => `<style>${css.replace(/<\/(style)/giu, "<\\/$1")}</style>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8">${styles}</head><body>${body}</body></html>`;
}

/**
 * The pairs to compare: pages whose body the conversion changed, at most UTILITY_VISUAL_PAGES, none when either
 * document would pass the size limit. Documents are built only for the pages chosen.
 */
export function utilityVisualPairs(before: ReadonlyArray<{ page: string; body: string }>, after: (page: string) => string | undefined, sheetsBefore: readonly string[], sheetsAfter: readonly string[]): UtilityVisualPair[] {
  const size = (sheets: readonly string[]): number => sheets.reduce((total, css) => total + css.length, 0);
  const sheetChars = Math.max(size(sheetsBefore), size(sheetsAfter));
  const pairs: UtilityVisualPair[] = [];
  for (const item of before) {
    if (pairs.length >= UTILITY_VISUAL_PAGES) break;
    const changed = after(item.page);
    if (changed === undefined || changed === item.body) continue;
    if (sheetChars + Math.max(item.body.length, changed.length) > UTILITY_VISUAL_MAX_CHARS) continue;
    pairs.push({ page: item.page, before: visualDocument(item.body, sheetsBefore), after: visualDocument(changed, sheetsAfter) });
  }
  return pairs;
}
