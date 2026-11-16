import { parse as parseHtml, serialize, type DefaultTreeAdapterMap } from "parse5";

/**
 * D6: a page added to a site keeps only its content. The page was printed by its theme, with the theme's header, menu,
 * footer and the admin bar: the site has its own, and the copied ones would show twice (and the menu's script of
 * WordPress would run twice). The content is, in this order:
 * - the first `<main>` (a block theme's template, and most classic themes), which becomes a `<div>` with the same
 *   attributes: the theme of the site has its `<main>` already;
 * - with a block theme and no `<main>`, what stands between the theme's parts: `header.wp-block-template-part` and
 *   `footer.wp-block-template-part` go;
 * - with a classic theme, `#main`, `#content` or `.site-main`.
 * Around the content, the other elements of each wrapper go (header, menu, sidebar, footer), but not the scripts, the
 * styles and the hidden SVG definitions (duotone filters); at the level of `<body>` only what is surely the theme's goes
 * (CHROME_ROOT). Then the scripts and sheets of what went: the admin bar, the skip link, the blocks of a header (menu,
 * logo, title, search) when the content does not use them, the Interactivity API when nothing in the content is
 * interactive, and the scripts of the theme for its menu. Without a content found, the page stays as it is.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export type PageContentFrom = "main" | "parti-del-tema" | "#main" | "#content" | ".site-main";

export interface PageContent {
  /** The page with only its content, or the page as it was when `from` is null. */
  html: string;
  /** Where the content was found; null when nothing was recognised (the page is then imported whole). */
  from: PageContentFrom | null;
  /** Elements of the theme taken away (header, menu, footer, sidebar, admin bar…), counted at their top. */
  elements: number;
  /** Scripts (and their module preloads) taken away with them. */
  scripts: number;
  /** Sheets and `<style>` taken away with them. */
  sheets: number;
}

/** Elements that stay in a wrapper of the content: they show nothing and the content may need them. */
const KEPT_TAGS: ReadonlySet<string> = new Set(["script", "style", "link", "meta", "template"]);
/** Ids and classes of the theme's header, menu and footer outside the content's wrappers. */
const CHROME_NAMES: ReadonlySet<string> = new Set(["masthead", "colophon", "site-header", "site-footer", "site-navigation", "elementor-location-header", "elementor-location-footer"]);
/** The blocks of a theme's header and footer: their scripts and sheets go when the content has none of them. */
const CHROME_BLOCK = /^wp-block-(navigation-submenu|navigation-link|navigation|page-list|site-logo|site-title|site-tagline|template-part|social-links|social-link|loginout|home-link|search)(?:-|$)/u;
const CHROME_BLOCK_MODULE = /^@wordpress\/block-library\/(navigation|search)\//u;
const ADMIN_BAR = /^(?:admin-bar|hoverintent-js)(?:-|$)/u;
const SKIP_LINK = /(?:^wp-block-template-skip-link(?:-|$)|skip-link-focus-fix)/u;
const INTERACTIVITY = /^(?:@wordpress\/interactivity(?:-router)?-js-module(?:preload)?|wp-importmap|wp-script-module-data-@wordpress\/interactivity(?:-router)?)$/u;
const THEME_PATH = /(?:^|\/)wp-content\/themes\//iu;
const THEME_MENU_SCRIPT = /nav|menu|header|footer|skip-link/iu;

function attribute(element: Element, name: string): string {
  return element.attrs.find((item) => item.name === name)?.value ?? "";
}

function tokens(element: Element, name: string): string[] {
  return attribute(element, name).split(/\s+/u).filter(Boolean);
}

function childElements(node: ParentNode): Element[] {
  return node.childNodes.filter((child): child is Element => "tagName" in child);
}

/** Every element under `root`, in document order. */
function elements(root: Node): Element[] {
  const out: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop() as Node;
    if ("tagName" in node) out.push(node as Element);
    if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index] as Node);
  }
  return out;
}

function remove(node: Element): void {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index >= 0) parent.childNodes.splice(index, 1);
  node.parentNode = null;
}

function inside(node: Element, ancestor: Element): boolean {
  for (let current: ParentNode | null = node.parentNode; current; current = "parentNode" in current ? (current.parentNode as ParentNode | null) : null) {
    if (current === ancestor) return true;
  }
  return false;
}

/** An SVG of definitions only (the duotone filters WordPress prints): it shows nothing, the content's images use it. */
function definitionsOnly(element: Element): boolean {
  const children = childElements(element);
  return element.tagName === "svg" && children.length > 0 && children.every((child) => child.tagName === "defs");
}

/** At the level of `<body>`: the admin bar, a skip link, a header, footer or menu of the theme. */
function chromeAtRoot(element: Element): boolean {
  if (attribute(element, "id") === "wpadminbar") return true;
  if (element.tagName === "header" || element.tagName === "footer" || element.tagName === "nav") return true;
  const classes = tokens(element, "class");
  if (element.tagName === "a" && (classes.includes("skip-link") || (classes.includes("screen-reader-text") && attribute(element, "href").startsWith("#")))) return true;
  return CHROME_NAMES.has(attribute(element, "id")) || classes.some((name) => CHROME_NAMES.has(name));
}

function templatePart(element: Element): boolean {
  return (element.tagName === "header" || element.tagName === "footer") && tokens(element, "class").includes("wp-block-template-part");
}

export function pageContent(html: string): PageContent {
  const unchanged: PageContent = { html, from: null, elements: 0, scripts: 0, sheets: 0 };
  const document = parseHtml(html);
  const all = elements(document);
  const body = all.find((element) => element.tagName === "body");
  if (!body) return unchanged;
  const inBody = elements(body).slice(1);
  let from: PageContentFrom | null = null;
  let content: Element | undefined = inBody.find((element) => element.tagName === "main");
  if (content) from = "main";
  const parts = content ? [] : inBody.filter(templatePart);
  if (!content && parts.length) from = "parti-del-tema";
  if (!content && !parts.length) {
    for (const [test, name] of [[(element: Element) => attribute(element, "id") === "main", "#main"], [(element: Element) => attribute(element, "id") === "content", "#content"], [(element: Element) => tokens(element, "class").includes("site-main"), ".site-main"]] as const) {
      content = inBody.find(test);
      if (content) {
        from = name;
        break;
      }
    }
  }
  if (from === null) return unchanged;

  let removed = 0;
  let top: Element | null = null;
  if (content) {
    // Each wrapper of the content keeps only the way down to it (and what shows nothing).
    let child: Element = content;
    for (let parent = content.parentNode; parent && parent !== body; parent = "parentNode" in parent ? (parent.parentNode as ParentNode | null) : null) {
      for (const sibling of childElements(parent)) {
        if (sibling === child || KEPT_TAGS.has(sibling.tagName) || definitionsOnly(sibling)) continue;
        remove(sibling);
        removed++;
      }
      if (!("tagName" in parent)) break;
      child = parent as Element;
    }
    top = child;
    if (content.tagName === "main") {
      content.tagName = "div";
      content.nodeName = "div";
    }
  } else {
    for (const part of parts) {
      if (parts.some((other) => other !== part && inside(part, other))) continue;
      remove(part);
      removed++;
    }
  }
  for (const element of childElements(body)) {
    if (element === top || !chromeAtRoot(element)) continue;
    remove(element);
    removed++;
  }

  // The scripts and sheets of what went.
  const kept = elements(body);
  const classes = new Set(kept.flatMap((element) => tokens(element, "class")));
  const interactive = kept.some((element) => element.attrs.some((item) => item.name === "data-wp-interactive"));
  let scripts = 0;
  let sheets = 0;
  for (const element of elements(document)) {
    if (element.tagName !== "script" && element.tagName !== "link" && element.tagName !== "style") continue;
    if (element.tagName === "link" && !/\b(?:stylesheet|modulepreload|preload)\b/iu.test(attribute(element, "rel"))) continue;
    const id = attribute(element, "id").toLowerCase();
    const address = attribute(element, element.tagName === "script" ? "src" : "href");
    const block = CHROME_BLOCK.exec(id)?.[1] ?? CHROME_BLOCK_MODULE.exec(id)?.[1];
    const goes = ADMIN_BAR.test(id)
      || SKIP_LINK.test(id) || SKIP_LINK.test(address)
      || (block !== undefined && !classes.has(`wp-block-${block}`))
      || (INTERACTIVITY.test(id) && !interactive)
      || (element.tagName === "script" && THEME_PATH.test(address) && THEME_MENU_SCRIPT.test(`${id} ${address.split(/[?#]/u)[0]?.split("/").at(-1) ?? ""}`));
    if (!goes) continue;
    remove(element);
    if (element.tagName === "style" || /\bstylesheet\b/iu.test(attribute(element, "rel"))) sheets++;
    else scripts++;
  }
  return { html: serialize(document), from, elements: removed, scripts, sheets };
}
