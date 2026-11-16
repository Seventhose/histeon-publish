import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserCheck } from "./prototype-verify.js";

/**
 * What to look at before publishing, read from the version just made (doc 23): broken links inside the site, images too
 * heavy, images without a text alternative, pages without a description, title or language, pages closed to search
 * engines or left out of the sitemap, pages too heavy. Only the version's files are read, never the network. What the
 * build writes on purpose is not reported: the 404 page, the small pages of old addresses (`http-equiv="refresh"`,
 * `noindex`) and the search page (`noindex`). Nothing here stops a publication.
 */

export interface SiteCheck {
  pages: number;
  brokenLinks: Array<{ page: string; link: string }>;
  heavyImages: Array<{ file: string; kilobytes: number }>;
  missingAlt: Array<{ page: string; image: string }>;
  noDescription: string[];
  /** Pages that say the same to search engines, which then show only one of them. */
  sameTitle: Array<{ text: string; pages: string[] }>;
  sameDescription: Array<{ text: string; pages: string[] }>;
  /** Pages without `<title>` or with an empty one. */
  noTitle: string[];
  /** Pages whose `<html>` has no `lang`. */
  noLang: string[];
  /** Pages closed to search engines with `<meta name="robots" content="noindex">`: a list, it may be wanted. */
  noindex: string[];
  /** Pages open to search engines that `sitemap.xml` does not list; empty when there is no sitemap. */
  notInSitemap: string[];
  /** The version has no `sitemap.xml` (the build writes it once the site's address is set). */
  noSitemap: boolean;
  /** The heaviest pages over HEAVY_PAGE_BYTES, at most five: HTML plus the files of the site it loads. */
  heavyPages: Array<{ page: string; kilobytes: number }>;
  /** How many pages are over HEAVY_PAGE_BYTES. */
  heavyPageCount: number;
}

const MAX_PAGES = 20_000;
const MAX_LISTED = 100;
const HEAVY_BYTES = 1024 * 1024;
export const HEAVY_PAGE_BYTES = 1.5 * 1024 * 1024;
const HEAVIEST_LISTED = 5;
/** A base to resolve a page's addresses on: what keeps this origin is the site's own. */
const BASE = "http://site.invalid";

const metaTags = (html: string): string[] => [...html.matchAll(/<meta\b[^>]*>/giu)].map((match) => match[0]);
const attributeOf = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag)?.slice(1).find((value) => value !== undefined);
const isNoindex = (html: string): boolean => metaTags(html).some((tag) => attributeOf(tag, "name")?.toLowerCase() === "robots" && /noindex/iu.test(attributeOf(tag, "content") ?? ""));
const isRefresh = (html: string): boolean => metaTags(html).some((tag) => attributeOf(tag, "http-equiv")?.toLowerCase() === "refresh");
/** The search page the build writes when the site search is on: noindex on purpose. */
const isSearchPage = (html: string): boolean => /<body\b[^>]*\sdata-pagefind-ignore/iu.test(html) && html.includes("/pagefind/pagefind.js");

export async function checkBuiltSite(root: string): Promise<SiteCheck> {
  const files: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(root);
  const known = new Set(files.map((file) => `/${path.relative(root, file).split(path.sep).join("/")}`));
  const exists = (address: string): boolean => {
    const clean = decodeURIComponent(address.replace(/[?#].*$/u, ""));
    return known.has(clean) || known.has(`${clean.replace(/\/$/u, "")}/index.html`) || known.has(clean.replace(/\/$/u, ""));
  };
  const check: SiteCheck = { pages: 0, brokenLinks: [], heavyImages: [], missingAlt: [], noDescription: [], sameTitle: [], sameDescription: [], noTitle: [], noLang: [], noindex: [], notInSitemap: [], noSitemap: true, heavyPages: [], heavyPageCount: 0 };
  const sitemap = await readSitemap(path.join(root, "sitemap.xml"));
  check.noSitemap = sitemap === null;
  const sizes = new Map<string, number>();
  const sizeOf = async (address: string): Promise<number> => {
    const known = sizes.get(address);
    if (known !== undefined) return known;
    let size = 0;
    try { size = (await stat(path.join(root, ...address.split("/").filter(Boolean)))).size; } catch { size = 0; }
    sizes.set(address, size);
    return size;
  };
  const cssResources = new Map<string, string[]>();
  const resourcesOfCss = async (address: string): Promise<string[]> => {
    const cached = cssResources.get(address);
    if (cached) return cached;
    let found: string[] = [];
    try { found = cssUrls(await readFile(path.join(root, ...address.split("/").filter(Boolean)), "utf8"), address); } catch { found = []; }
    cssResources.set(address, found);
    return found;
  };
  const weights: Array<{ page: string; bytes: number }> = [];
  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  const note = (map: Map<string, string[]>, text: string | undefined, page: string): void => {
    if (!text) return;
    const key = text.trim();
    map.set(key, [...(map.get(key) ?? []), page]);
  };
  const seenLinks = new Set<string>();
  for (const file of files) {
    const address = `/${path.relative(root, file).split(path.sep).join("/")}`;
    if (/\.(?:jpe?g|png|gif|webp|avif|jxl)$/iu.test(file)) {
      const { size } = await stat(file);
      if (size > HEAVY_BYTES && check.heavyImages.length < MAX_LISTED) check.heavyImages.push({ file: address, kilobytes: Math.round(size / 1024) });
      continue;
    }
    if (!file.endsWith(".html") || check.pages >= MAX_PAGES) continue;
    check.pages += 1;
    const html = await readFile(file, "utf8");
    const page = address.replace(/index\.html$/u, "");
    const refresh = isRefresh(html);
    const noindex = isNoindex(html);
    const notFound = page.endsWith("404.html");
    if (!notFound && !refresh) {
      const title = /<title\b[^>]*>([^<]*)<\/title>/iu.exec(html)?.[1];
      if (!title?.trim() && check.noTitle.length < MAX_LISTED) check.noTitle.push(page);
    }
    if (!refresh && !attributeOf(/<html\b[^>]*>/iu.exec(html)?.[0] ?? "", "lang")?.trim() && check.noLang.length < MAX_LISTED) check.noLang.push(page);
    if (noindex && !refresh && !isSearchPage(html) && check.noindex.length < MAX_LISTED) check.noindex.push(page);
    if (sitemap && !notFound && !refresh && !noindex && !sitemap.has(page) && check.notInSitemap.length < MAX_LISTED) check.notInSitemap.push(page);
    if (!refresh) {
      const loaded = new Set<string>();
      for (const reference of pageResources(html)) {
        const own = sameSite(reference, address);
        if (own) loaded.add(own);
      }
      for (const sheet of [...loaded].filter((item) => item.endsWith(".css"))) for (const inner of await resourcesOfCss(sheet)) loaded.add(inner);
      for (const inline of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) for (const inner of cssUrls(inline[1] as string, address)) loaded.add(inner);
      let bytes = Buffer.byteLength(html);
      for (const resource of loaded) bytes += await sizeOf(resource);
      if (bytes > HEAVY_PAGE_BYTES) weights.push({ page, bytes });
    }
    if (!page.endsWith("404.html") && !/<meta name="description"/u.test(html) && !/http-equiv="refresh"/u.test(html) && check.noDescription.length < MAX_LISTED) check.noDescription.push(page);
    if (!page.endsWith("404.html") && !/http-equiv="refresh"|name="robots" content="noindex"/u.test(html)) {
      note(titles, /<title>([^<]*)<\/title>/u.exec(html)?.[1], page);
      note(descriptions, /<meta name="description" content="([^"]*)"/u.exec(html)?.[1], page);
    }
    for (const match of html.matchAll(/\shref="(\/[^"#?]*)/gu)) {
      const link = match[1] as string;
      if (link.startsWith("//") || seenLinks.has(link)) continue;
      seenLinks.add(link);
      let good = true;
      try { good = exists(link); } catch { good = false; }
      if (!good && check.brokenLinks.length < MAX_LISTED) check.brokenLinks.push({ page, link });
    }
    for (const match of html.matchAll(/<img\b[^>]*>/gu)) {
      const tag = match[0];
      if (!/\salt(?=[\s=/>]|$)/u.test(tag) && check.missingAlt.length < MAX_LISTED) check.missingAlt.push({ page, image: /\ssrc="([^"]*)"/u.exec(tag)?.[1] ?? "" });
    }
  }
  const repeated = (map: Map<string, string[]>) => [...map].filter(([, pages]) => pages.length > 1).sort((left, right) => right[1].length - left[1].length).slice(0, MAX_LISTED).map(([text, pages]) => ({ text, pages: pages.slice(0, 20) }));
  check.sameTitle = repeated(titles);
  check.sameDescription = repeated(descriptions);
  check.heavyPageCount = weights.length;
  check.heavyPages = weights.sort((left, right) => right.bytes - left.bytes).slice(0, HEAVIEST_LISTED).map((item) => ({ page: item.page, kilobytes: Math.round(item.bytes / 1024) }));
  return check;
}

/** The pages `sitemap.xml` lists, as paths (`/`, `/chi/`), or null without the file. */
async function readSitemap(file: string): Promise<Set<string> | null> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return null; }
  const listed = new Set<string>();
  for (const match of text.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gu)) {
    const raw = (match[1] as string).replace(/&amp;/gu, "&");
    try {
      const pathname = new URL(raw, BASE).pathname;
      listed.add(pathname);
      listed.add(decodeURIComponent(pathname));
    } catch { /* an address that does not read is not a page of the site */ }
  }
  return listed;
}

/** What a page loads: `src`, the first candidate of `srcset`, the `href` of style sheets and preloads. */
function pageResources(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<(?:img|script|source|video|audio|iframe|embed|input|track)\b[^>]*>/giu)) {
    const src = attributeOf(match[0], "src");
    if (src) found.push(src);
    const srcset = attributeOf(match[0], "srcset");
    const first = srcset?.split(",")[0]?.trim().split(/\s+/u)[0];
    if (first) found.push(first);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = (attributeOf(match[0], "rel") ?? "").toLowerCase().split(/\s+/u);
    const href = attributeOf(match[0], "href");
    if (href && rel.some((item) => item === "stylesheet" || item === "preload" || item === "modulepreload")) found.push(href);
  }
  return found;
}

/** The files of the site a style sheet at `address` loads with `url()` (fonts, images), as site paths. */
function cssUrls(css: string, address: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/giu)) {
    const own = sameSite(match[1] ?? match[2] ?? match[3] ?? "", address);
    if (own) found.push(own);
  }
  return found;
}

/** `reference` as a path of this site, resolved on the page at `address`; null for another site, a `data:` address or a path that leaves the version. */
function sameSite(reference: string, address: string): string | null {
  const value = reference.trim().replace(/&amp;/gu, "&");
  if (!value || /^(?:data|blob|javascript|mailto|tel):/iu.test(value)) return null;
  try {
    const url = new URL(value, `${BASE}${address}`);
    if (url.origin !== BASE) return null;
    const own = decodeURIComponent(url.pathname);
    // A decoded `%2F..` would climb out of the version: such an address is not a file of the site.
    return own.split("/").some((segment) => segment === ".." || segment === ".") ? null : own;
  } catch {
    return null;
  }
}

/**
 * The last check in a browser of one version (checkBuiltPages, doc 17 item 4), as the readiness report keeps it: only
 * counts, rule names and page addresses, never the help texts, the elements or the messages.
 */
export interface BrowserSummary {
  checkedAt: string;
  /** The pages opened at every width; 0 means nothing was checked (no browser, no axe-core). */
  opened: number;
  /**
   * The pages of the version, opened or not (BrowserCheck.total); more than `opened` means accessibility is checked on
   * part of the site only. Missing in reports written before 13 November 2026 (then `opened` is taken as all).
   */
  total?: number;
  axe: Array<{ id: string; count: number; pages: string[] }>;
  overflow: string[];
  brokenImages: string[];
  edges: string[];
  /** How many notes of what could not be checked (a page that did not open, the time that ran out). */
  failures: number;
}

export type ReadinessVerdict = "pronto" | "da-guardare" | "non-pronto";
export type ReadinessSectionId = "links" | "images" | "search" | "weight" | "accessibility";
export type ReadinessState = "ok" | "warning" | "error" | "unchecked";
export interface ReadinessItem {
  /** A field of SiteCheck, `axe:<rule>` or one of the browser's: overflow, brokenImages, edges, browserFailures. */
  rule: string;
  level: "error" | "warning";
  count: number;
  /** At most READINESS_PAGES addresses of pages of the site. */
  pages: string[];
  /** `browserPartial` only: the pages of the version, of which `count` were opened. */
  total?: number;
}
export interface ReadinessSection { id: ReadinessSectionId; title: string; state: ReadinessState; items: ReadinessItem[] }
export interface Readiness {
  verdict: ReadinessVerdict;
  sections: ReadinessSection[];
  /** When the browser check of the same version ran, or null: then accessibility is "unchecked". */
  browserCheckedAt: string | null;
}

const READINESS_PAGES = 10;
const SECTION_TITLES: Record<ReadinessSectionId, string> = { links: "Collegamenti", images: "Immagini", search: "Motori di ricerca", weight: "Peso", accessibility: "Accessibilità" };

/** The browser check of a version in the shape the report keeps (BrowserSummary). */
export function summarizeBrowserCheck(check: BrowserCheck, checkedAt: string): BrowserSummary {
  const pagesOf = (items: ReadonlyArray<{ page: string }> | undefined): string[] => [...new Set((items ?? []).map((item) => item.page))].slice(0, READINESS_PAGES);
  return {
    checkedAt,
    opened: check.opened,
    ...(typeof check.total === "number" && Number.isSafeInteger(check.total) && check.total >= check.opened ? { total: check.total } : {}),
    axe: check.axe.slice(0, 100).map((rule) => ({ id: rule.id, count: rule.count, pages: rule.pages.slice(0, READINESS_PAGES) })),
    overflow: pagesOf(check.overflow),
    brokenImages: pagesOf(check.brokenImages),
    edges: pagesOf(check.edges),
    failures: check.failures?.length ?? 0,
  };
}

/**
 * «Pronto per andare online?» (V1): one verdict over the check of a version and, when there is one, the browser check
 * of the same version. Not ready with internal links broken or a page without `<title>`; to look at with warnings only,
 * or while accessibility is not checked in a browser; ready with nothing at all. Never ready without the browser check,
 * nor with a browser check that opened only some of the pages (`browserPartial`, M-P1: 20 of 60 is not the site).
 */
export function readiness(check: SiteCheck, browser: BrowserSummary | null): Readiness {
  const unique = (pages: Iterable<string>): string[] => [...new Set(pages)].slice(0, READINESS_PAGES);
  const item = (rule: string, level: ReadinessItem["level"], count: number, pages: Iterable<string>): ReadinessItem[] => count > 0 ? [{ rule, level, count, pages: unique(pages) }] : [];
  const items: Record<ReadinessSectionId, ReadinessItem[]> = {
    links: item("brokenLinks", "error", check.brokenLinks.length, check.brokenLinks.map((entry) => entry.page)),
    images: [
      ...item("missingAlt", "warning", check.missingAlt.length, check.missingAlt.map((entry) => entry.page)),
      ...item("heavyImages", "warning", check.heavyImages.length, []),
    ],
    search: [
      ...item("noTitle", "error", check.noTitle.length, check.noTitle),
      ...item("noDescription", "warning", check.noDescription.length, check.noDescription),
      ...item("sameTitle", "warning", check.sameTitle.length, check.sameTitle.flatMap((entry) => entry.pages)),
      ...item("sameDescription", "warning", check.sameDescription.length, check.sameDescription.flatMap((entry) => entry.pages)),
      ...item("noindex", "warning", check.noindex.length, check.noindex),
      ...item("noSitemap", "warning", check.noSitemap ? 1 : 0, []),
      ...item("notInSitemap", "warning", check.notInSitemap.length, check.notInSitemap),
    ],
    weight: item("heavyPages", "warning", check.heavyPageCount, check.heavyPages.map((entry) => entry.page)),
    accessibility: [
      ...item("noLang", "warning", check.noLang.length, check.noLang),
      ...(browser ? [
        ...browser.axe.flatMap((rule) => item(`axe:${rule.id}`, "warning", rule.count, rule.pages)),
        ...item("overflow", "warning", browser.overflow.length, browser.overflow),
        ...item("brokenImages", "warning", browser.brokenImages.length, browser.brokenImages),
        ...item("edges", "warning", browser.edges.length, browser.edges),
        ...item("browserFailures", "warning", browser.failures, []),
        ...(browser.opened > 0 && typeof browser.total === "number" && browser.opened < browser.total ? [{ rule: "browserPartial", level: "warning" as const, count: browser.opened, pages: [], total: browser.total }] : []),
      ] : []),
    ],
  };
  // A browser check that opened no page checked nothing.
  const checked = browser !== null && browser.opened > 0;
  const sections = (Object.keys(SECTION_TITLES) as ReadinessSectionId[]).map((id): ReadinessSection => {
    const found = items[id];
    const state: ReadinessState = found.some((entry) => entry.level === "error") ? "error" : id === "accessibility" && !checked ? "unchecked" : found.length ? "warning" : "ok";
    return { id, title: SECTION_TITLES[id], state, items: found };
  });
  const verdict: ReadinessVerdict = sections.some((section) => section.state === "error") ? "non-pronto" : sections.every((section) => section.state === "ok") ? "pronto" : "da-guardare";
  return { verdict, sections, browserCheckedAt: browser?.checkedAt ?? null };
}

/** The report kept beside a version: `<version folder>.pronto.json`, outside the files that go online. */
export const readinessFile = (bundlePath: string): string => `${bundlePath.replace(/[\\/]+$/u, "")}.pronto.json`;

export interface SavedReadiness { version: string; checkedAt: string; pages: number; readiness: Readiness; browser: BrowserSummary | null }

/** What is kept beside the version, or null when there is nothing or it is of another version. */
export async function readSavedReadiness(bundlePath: string): Promise<SavedReadiness | null> {
  try {
    const saved = JSON.parse(await readFile(readinessFile(bundlePath), "utf8")) as Partial<SavedReadiness>;
    if (saved.version !== path.basename(bundlePath)) return null;
    return saved as SavedReadiness;
  } catch {
    return null;
  }
}

/** Writes the report beside the version (mode 0600): counts, rule names and page addresses only. */
export async function saveReadiness(bundlePath: string, report: Omit<SavedReadiness, "version">): Promise<void> {
  const saved: SavedReadiness = { version: path.basename(bundlePath), ...report };
  await writeFile(readinessFile(bundlePath), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
}
