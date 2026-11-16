import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";
import type { StaticSiteSheetSource } from "../src/static-site-prototype.js";

/**
 * D5: the brand colours of a page added to a site come only from the page's own sheets and styles. On a WordPress page
 * the sheets of the theme, of WordPress itself (`global-styles`, `wp-block-library`, the blocks' own sheets, which also
 * hold the `--wp--preset--*` palette) and of the plugins are converted as always, but their colours do not count when
 * the conversion picks `primary` and `secondary` (css-cleanup.ts). What counts: the page's inline styles (converted to
 * classes), the styles WordPress writes for the blocks of that page (`core-block-supports-inline-css`), and the sheets
 * a builder writes for that page in `wp-content/uploads/` (Elementor's `post-<id>.css`, but not its kit's).
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** Paths of WordPress itself, of the themes and of the plugins (also in a site under a folder). */
const SITE_PATH = /(?:^|\/)(?:wp-includes|wp-admin|wp-content\/(?:themes|plugins|mu-plugins))\//iu;
/** Element ids of WordPress's own sheets, of Histeon's and of the admin bar. */
const SITE_ID = /^(?:wp-|global-styles|classic-theme-styles|admin-bar|dashicons|xb-)/iu;
/** Elementor's sheet of a post, linked (`post-12.css`) or written in the page (`elementor-post-12`). */
const ELEMENTOR_POST_FILE = /(?:^|\/)wp-content\/uploads\/elementor\/css\/post-(\d+)\.css$/iu;
const ELEMENTOR_POST_STYLE = /^elementor-post-(\d+)$/iu;

function attribute(element: Element, name: string): string {
  return element.attrs.find((item) => item.name === name)?.value ?? "";
}

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

/** True when the page was printed by WordPress: its paths, its generator, its sheets or the classes of its body. */
export function isWordpressPage(html: string): boolean {
  return wordpressSigns(elements(parseHtml(html)));
}

function wordpressSigns(all: readonly Element[]): boolean {
  for (const element of all) {
    if (element.tagName === "meta" && attribute(element, "name").toLowerCase() === "generator" && /^wordpress\b/iu.test(attribute(element, "content"))) return true;
    if ((element.tagName === "link" || element.tagName === "script") && /(?:^|\/)wp-(?:content|includes)\//iu.test(attribute(element, element.tagName === "link" ? "href" : "src"))) return true;
    if (element.tagName === "style" && /^(?:global-styles|wp-block-library)-inline-css$/iu.test(attribute(element, "id"))) return true;
    if (element.tagName === "body" && /(?:^|\s)wp-(?:child-)?theme-/u.test(attribute(element, "class"))) return true;
  }
  return false;
}

/**
 * The `brandSheet` of the conversion for an added page: null when the page is not a WordPress page (every sheet then
 * counts, as before). Else a sheet is the site's, and its colours do not count, when it is:
 * - linked from WordPress, a theme or a plugin (SITE_PATH), or from another site (a library);
 * - one of WordPress's own (SITE_ID: `wp-block-library`, `wp-block-*`, `global-styles`, `classic-theme-styles`…);
 * - the `-inline-css` of a sheet of the site (`astra-theme-css-inline-css` next to `astra-theme-css-css`);
 * - named after the theme (`twentytwentyfive-style-inline-css`, the theme's slug from `wp-theme-<slug>` on the body);
 * - Elementor's sheet of the kit (`elementor-kit-<id>` on the body), the site's colours and fonts;
 * - a `<style>` of the head without an id: WordPress and the plugins print those, the content of a page cannot.
 */
export function brandSheetFilter(html: string): ((sheet: StaticSiteSheetSource) => boolean) | null {
  const all = elements(parseHtml(html));
  if (!wordpressSigns(all)) return null;
  const body = all.find((element) => element.tagName === "body");
  const bodyClasses = (body ? attribute(body, "class") : "").split(/\s+/u).filter(Boolean);
  const themes = bodyClasses.map((name) => /^wp-(?:child-)?theme-(.+)$/u.exec(name)?.[1]?.toLowerCase() ?? "").filter(Boolean);
  const kit = bodyClasses.map((name) => /^elementor-kit-(\d+)$/u.exec(name)?.[1] ?? "").find(Boolean) ?? null;
  const ofTheme = (id: string): boolean => themes.some((slug) => id === slug || id.startsWith(`${slug}-`));
  const linkedSite = (href: string, id: string): boolean => {
    if (SITE_PATH.test(href) || /^[a-z][a-z0-9+.-]*:/iu.test(href)) return true;
    if (kit !== null && ELEMENTOR_POST_FILE.exec(href)?.[1] === kit) return true;
    return SITE_ID.test(id) || ofTheme(id);
  };
  /** The handles (`<id>-css`) of the linked sheets that are the site's: their `-inline-css` is the site's too. */
  const siteHandles = new Set<string>();
  for (const element of all) {
    if (element.tagName !== "link" || !attribute(element, "rel").toLowerCase().split(/\s+/u).includes("stylesheet")) continue;
    const id = attribute(element, "id").toLowerCase();
    if (!id.endsWith("-css")) continue;
    let href = attribute(element, "href");
    try {
      const url = new URL(href, "https://pagina.invalid/");
      href = url.origin === "https://pagina.invalid" ? decodeURIComponent(url.pathname).replace(/^\/+/u, "") : url.href;
    } catch {
      continue;
    }
    if (linkedSite(href, id)) siteHandles.add(id.slice(0, -"-css".length));
  }
  return (sheet) => {
    const id = sheet.id.toLowerCase();
    if (sheet.kind === "link") return !linkedSite(sheet.href, id);
    if (!id || SITE_ID.test(id) || ofTheme(id)) return false;
    const post = ELEMENTOR_POST_STYLE.exec(id)?.[1];
    if (post !== undefined) return post !== kit;
    return !(id.endsWith("-inline-css") && siteHandles.has(id.slice(0, -"-inline-css".length)));
  };
}
