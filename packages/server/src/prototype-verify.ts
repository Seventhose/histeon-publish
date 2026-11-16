import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { builtPages } from "./prototype-links.js";

/**
 * Doc 17 item 4, the part with a browser: each page of a built preview opened at 1440 and 390 px, its width compared
 * with the window's (a page wider than the window scrolls sideways), and axe-core run on it (WCAG 2.2 AA). The browser
 * is the caller's (OpenPageProbe): a hidden window of the desktop app without preload, Playwright in the CLI. Here the
 * bundle is served on 127.0.0.1 for the time of the check, the pages chosen and the results gathered for the report.
 */

/** One page at one width in the caller's browser: `expression` evaluated there once the page loaded (a promise is awaited). */
export interface PageProbeInput {
  url: string;
  width: number;
  height: number;
  expression: string;
  signal: AbortSignal;
}

export interface PageProbe {
  probe(input: PageProbeInput): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Opens the browser for one check; every request it makes must stay on `origin` (the bundle's server). V1.6, threat
 * model T32: with `site`, `origin` is a real site's (the linked WordPress, «Verifica nel browser»): no dead proxy, the
 * requests still on that origin only, and the expression run in a world of its own, apart from the page's scripts,
 * so that a page CSP without 'unsafe-eval' (a preview of untrusted content) does not stop axe's messages.
 */
export type OpenPageProbe = (input: { origin: string; signal: AbortSignal; site?: boolean }) => Promise<PageProbe>;

/** axe-core as the page receives it: its source and the Italian messages. */
export interface AxeScript {
  source: string;
  locale?: unknown;
}

/** A page wider than the window at `width`: how wide, and the outermost elements that stick out (at most 3). */
export interface PageOverflow {
  page: string;
  width: number;
  scrollWidth: number;
  elements: string[];
}

/** One axe rule that failed, over every page and width: the pages (at most 5), the elements (at most 5) and how many. */
export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  pages: string[];
  targets: string[];
  count: number;
}

export interface BrowserCheck {
  /** The pages opened, each at every width. */
  opened: number;
  overflow: PageOverflow[];
  axe: AxeViolation[];
  /** Doc 23 item 242: pages with images the browser could not show (with the files), and with text touching a side. */
  brokenImages?: Array<{ page: string; images: string[] }>;
  edges?: Array<{ page: string; width: number; elements: string[] }>;
  /** More pages than were opened: which ones were. */
  note?: string;
  /** The pages of the bundle, opened or not (checkBuiltPages): with fewer `opened`, the check covers only part of the site. */
  total?: number;
  /** What could not be checked: a browser that did not start, a page that did not open, the time that ran out. */
  failures?: string[];
  /** V1.6: the links of the pages as the browser resolved them (`a[href]`), per page, when asked for. */
  links?: Array<{ page: string; links: string[] }>;
}

export const VERIFY_VIEWPORTS: readonly { width: number; height: number }[] = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES_OPENED = 20;
const PAGE_TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 120_000;
const OVERFLOW_KEPT = 20;
const AXE_PAGES_KEPT = 5;
const AXE_TARGETS_KEPT = 5;

let axeScript: Promise<AxeScript> | undefined;

/** axe-core from its package (the desktop app ships it in app.asar/node_modules), read once. */
export function loadAxeScript(): Promise<AxeScript> {
  axeScript ??= (async () => {
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
    const locale = JSON.parse(await readFile(require.resolve("axe-core/locales/it.json"), "utf8")) as unknown;
    return { source, locale };
  })();
  axeScript.catch(() => { axeScript = undefined; });
  return axeScript;
}

/**
 * What runs in the page. The width: the scrolling element's scrollWidth against its clientWidth, unless the page hides
 * its sideways overflow (nothing to scroll then); the elements that stick out are the outermost ones past the right
 * edge, not inside a fixed element (off-canvas menus) or a box that clips them. Then axe, violations only.
 */
function pageExpression(axe: AxeScript, options: { links?: boolean } = {}): string {
  const run = `(async () => {
  await Promise.race([document.fonts ? document.fonts.ready : null, new Promise((done) => setTimeout(done, 2000))]);
  // Doc 23 item 242: every image loaded, the lazy ones too, then those the browser could not show.
  const images = [...document.images];
  for (const image of images) if (image.loading === "lazy") image.loading = "eager";
  await Promise.race([Promise.all(images.map((image) => image.complete ? null : new Promise((done) => { image.addEventListener("load", done, { once: true }); image.addEventListener("error", done, { once: true }); }))), new Promise((done) => setTimeout(done, 3000))]);
  // Only the site's own files: the check's browser reaches nothing else, so another site's image says nothing.
  const own = (image) => { try { const address = new URL(image.currentSrc || image.src); return address.origin === location.origin ? address.pathname.slice(0, 160) : ""; } catch { return ""; } };
  const broken = [...new Set(images.filter((image) => image.complete && image.naturalWidth === 0).map(own).filter(Boolean))].slice(0, 5);
  const root = document.scrollingElement || document.documentElement;
  const width = root.clientWidth;
  const hidden = (element) => element && /^(hidden|clip)$/.test(getComputedStyle(element).overflowX);
  const scrollWidth = hidden(document.documentElement) || hidden(document.body) ? width : root.scrollWidth;
  const elements = [];
  if (scrollWidth > width + 1 && document.body) {
    const name = (element) => element.localName + [...element.classList].slice(0, 2).map((item) => "." + item).join("");
    let seen = 0;
    const visit = (element) => {
      for (const child of element.children) {
        if (elements.length >= 3 || ++seen > 5000) return;
        const style = getComputedStyle(child);
        if (style.position === "fixed" || style.display === "none") continue;
        if (child.getBoundingClientRect().right > width + 1) elements.push(name(child));
        else if (!/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) visit(child);
      }
    };
    visit(document.body);
  }
  // Doc 23 item 242: text closer than 12 px to a side of the window, outside fixed boxes: a page without inline padding
  // (the body's own 8 px margin alone is too little on a phone).
  const edges = [];
  if (document.body) {
    const label = (element) => element.localName + [...element.classList].slice(0, 2).map((item) => "." + item).join("");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let read = 0;
    for (let node = walker.nextNode(); node && edges.length < 3 && read < 4000; node = walker.nextNode()) {
      if (!node.textContent || !node.textContent.trim()) continue;
      read++;
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, noscript, [hidden], [aria-hidden='true']")) continue;
      // Not shown: inside a closed <details> (its summary is shown), or skipped by the browser (content-visibility, opacity).
      if (parent.closest("details:not([open])") && !parent.closest("summary")) continue;
      if (parent.checkVisibility && !parent.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) continue;
      // Not in a fixed box, nor in a strip the reader scrolls sideways: there the text moves, and where it is cut says nothing.
      let fixed = false;
      for (let element = parent; element && !fixed; element = element.parentElement) {
        const style = getComputedStyle(element);
        fixed = style.position === "fixed" || (/^(auto|scroll)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1);
      }
      if (fixed) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      // Text one can see: inside the window and more than a pixel wide (a skip link off screen or clipped is not).
      const near = [...range.getClientRects()].some((rect) => rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.left < width && (rect.left < 12 || rect.right > width - 12));
      if (near && getComputedStyle(parent).visibility !== "hidden" && !edges.includes(label(parent))) edges.push(label(parent));
    }
  }
  axe.configure({ ${axe.locale ? `locale: ${JSON.stringify(axe.locale)}, ` : ""}noHtml: true });
  const result = await axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} }, resultTypes: ["violations"] });
  const violations = result.violations.map((rule) => ({ id: rule.id, impact: rule.impact || null, help: rule.help, helpUrl: rule.helpUrl, targets: rule.nodes.map((node) => node.target.map(String).join(" ")).slice(0, 50) }));
  // V1.6: the links as the browser resolved them, for the check of the external ones (Publish probes them, not the page).
  const links = ${options.links ? "[...new Set([...document.querySelectorAll(\"a[href]\")].map((link) => link.href).filter((href) => typeof href === \"string\"))].slice(0, 500)" : "[]"};
  return { width, scrollWidth, elements, violations, broken, edges, links };
})()`;
  return `${axe.source};\n${run}`;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".jxl": "image/jxl", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm", ".vtt": "text/vtt; charset=utf-8",
};

/**
 * The bundle in `root` on 127.0.0.1 (a port of the system), as a static host serves it: a folder through its
 * index.html, `/a` as `a.html`. Only GET and HEAD, only that host name, nothing hidden or outside the bundle.
 */
async function serveBundle(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const boundary = `${path.resolve(root)}${path.sep}`;
  let host = "";
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const missing = () => { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Non trovato."); };
    if ((request.method !== "GET" && request.method !== "HEAD") || request.headers.host !== host) return missing();
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname); } catch { return missing(); }
    const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const segments = relative.split("/").filter(Boolean);
    if (segments.some((segment) => segment.startsWith(".")) || relative.includes("\\")) return missing();
    let absolute = path.resolve(root, ...segments);
    if (!absolute.startsWith(boundary)) return missing();
    let info = await stat(absolute).catch(() => null);
    if (!info && !path.extname(absolute)) {
      const page = await stat(`${absolute}.html`).catch(() => null);
      if (page?.isFile()) { absolute = `${absolute}.html`; info = page; }
    }
    if (info?.isDirectory()) {
      response.writeHead(308, { Location: `${pathname}/`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (!info?.isFile()) return missing();
    const type = CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type, "Content-Length": String(info.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    // 'unsafe-eval': axe compiles its messages with new Function, in the page (the browser's own evaluation is not enough).
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    else await pipeline(createReadStream(absolute), response).catch(() => undefined);
  };
  const server = createServer((request, response) => { answer(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  host = `127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`;
  return {
    origin: `http://${host}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Home first, then the shallow pages before the deep ones (a list's pages before each of its posts). */
function chosenPages(addresses: string[]): string[] {
  const depth = (address: string) => address.split("/").filter(Boolean).length;
  return [...addresses].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
}

interface ProbeResult {
  width: number;
  scrollWidth: number;
  elements: string[];
  /** Doc 23 item 242: images the browser could not show, and the elements whose text touches a side. */
  broken: string[];
  edges: string[];
  violations: { id: string; impact: string | null; help: string; helpUrl: string; targets: string[] }[];
  /** V1.6: the page's links, resolved (only when the expression collects them). */
  links: string[];
}

function probeResult(value: unknown): ProbeResult {
  const result = value as Partial<ProbeResult> | null;
  if (!result || typeof result !== "object" || typeof result.width !== "number" || typeof result.scrollWidth !== "number" || !Array.isArray(result.violations)) throw new Error("La pagina non ha dato il risultato del controllo.");
  const text = (item: unknown, max = 300) => (typeof item === "string" ? item.slice(0, max) : "");
  return {
    width: result.width,
    scrollWidth: result.scrollWidth,
    elements: Array.isArray(result.elements) ? result.elements.slice(0, 3).map((item) => text(item, 120)) : [],
    broken: Array.isArray(result.broken) ? result.broken.slice(0, 5).map((item) => text(item, 160)).filter(Boolean) : [],
    edges: Array.isArray(result.edges) ? result.edges.slice(0, 3).map((item) => text(item, 120)).filter(Boolean) : [],
    violations: result.violations.slice(0, 100).map((rule) => ({ id: text(rule.id, 80), impact: typeof rule.impact === "string" ? rule.impact : null, help: text(rule.help), helpUrl: text(rule.helpUrl), targets: Array.isArray(rule.targets) ? rule.targets.map((item) => text(item, 200)) : [] })),
    // An address longer than 2048 characters is not cut (a cut address is another one): it is left out.
    links: Array.isArray(result.links) ? result.links.slice(0, 500).filter((item): item is string => typeof item === "string" && item.length <= 2048) : [],
  };
}

function withTimeout<T>(task: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, ms);
  });
  return Promise.race([task, late]).finally(() => clearTimeout(timer));
}

/**
 * Opens the pages of the built bundle in `root` (at most PAGES_OPENED, home first) at every width of VERIFY_VIEWPORTS.
 * A browser that cannot start or a check past its time is a note, never an error: the links check and the rest of
 * the report stand. Only a cancellation of `signal` stops the check.
 */
export async function checkBuiltPages(root: string, openProbe: OpenPageProbe, options: { axe: AxeScript; signal?: AbortSignal; pageLimit?: number; timeoutMs?: number }): Promise<BrowserCheck> {
  const all = chosenPages(await builtPages(root));
  const pages = all.slice(0, options.pageLimit ?? PAGES_OPENED);
  const note = all.length > pages.length ? `Aperte nel browser ${pages.length} pagine su ${all.length}: la pagina iniziale e le meno profonde.` : undefined;
  const served = await serveBundle(root);
  try {
    const check = await probePages(pages.map((page) => ({ page, url: `${served.origin}${page.split("/").map(encodeURIComponent).join("/")}` })), served.origin, openProbe, options);
    return { ...check, total: all.length, ...(note ? { note } : {}) };
  } finally {
    await served.close();
  }
}

/**
 * The browser part of checkBuiltPages for any list of pages on `origin` (each `page` the address the report shows,
 * `url` the one opened). V1.6: with `site`, the pages of the linked WordPress (OpenPageProbe's `site`), and with
 * `links` the links of each page too.
 */
export async function probePages(targets: ReadonlyArray<{ page: string; url: string }>, origin: string, openProbe: OpenPageProbe, options: { axe: AxeScript; signal?: AbortSignal; timeoutMs?: number; site?: boolean; links?: boolean }): Promise<BrowserCheck> {
  const pages = targets;
  const expression = pageExpression(options.axe, { links: options.links === true });
  const overflow: PageOverflow[] = [];
  const brokenImages: Array<{ page: string; images: string[] }> = [];
  const edges: Array<{ page: string; width: number; elements: string[] }> = [];
  const rules = new Map<string, AxeViolation & { seen: Set<string> }>();
  const failures: string[] = [];
  const links: Array<{ page: string; links: string[] }> = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + (options.timeoutMs ?? CHECK_TIMEOUT_MS);
  let opened = 0;
  let probe: PageProbe | undefined;
  try {
    const browser = await withTimeout(openProbe({ origin, signal: controller.signal, ...(options.site ? { site: true } : {}) }), PAGE_TIMEOUT_MS, controller);
    probe = browser;
    for (const { page, url } of pages) {
      options.signal?.throwIfAborted();
      if (Date.now() > deadline) {
        failures.push(`Il controllo nel browser si è fermato dopo ${opened} pagine su ${pages.length}, per il tempo.`);
        break;
      }
      const measure = async (viewport: { width: number; height: number }): Promise<ProbeResult> => {
        const pageController = new AbortController();
        const stop = () => pageController.abort();
        controller.signal.addEventListener("abort", stop, { once: true });
        try {
          return probeResult(await withTimeout(browser.probe({ url, ...viewport, expression, signal: pageController.signal }), PAGE_TIMEOUT_MS, pageController));
        } finally {
          controller.signal.removeEventListener("abort", stop);
        }
      };
      try {
        const found = new Set<string>();
        for (const viewport of VERIFY_VIEWPORTS) {
          // Once more on an error of the browser (a navigation it dropped), not after a page past its time.
          const result = await measure(viewport).catch((error: unknown) => {
            options.signal?.throwIfAborted();
            if (error instanceof Error && error.message === "timeout") throw error;
            return measure(viewport);
          });
          if (result.scrollWidth > result.width + 1 && overflow.length < OVERFLOW_KEPT) overflow.push({ page, width: viewport.width, scrollWidth: result.scrollWidth, elements: result.elements });
          // An image broken at one width is broken at the other: said once per page.
          if (result.broken.length && !brokenImages.some((item) => item.page === page) && brokenImages.length < OVERFLOW_KEPT) brokenImages.push({ page, images: result.broken });
          // A page that scrolls sideways already says why: its text at the edge would be the same problem twice.
          if (result.edges.length && result.scrollWidth <= result.width + 1 && edges.length < OVERFLOW_KEPT) edges.push({ page, width: viewport.width, elements: result.edges });
          for (const violation of result.violations) {
            const rule = rules.get(violation.id) ?? { id: violation.id, impact: violation.impact, help: violation.help, helpUrl: violation.helpUrl, pages: [], targets: [], count: 0, seen: new Set<string>() };
            for (const target of violation.targets) {
              // The same element at both widths counts once.
              if (rule.seen.has(`${page}\u0000${target}`)) continue;
              rule.seen.add(`${page}\u0000${target}`);
              rule.count++;
              if (rule.targets.length < AXE_TARGETS_KEPT && !rule.targets.includes(target)) rule.targets.push(target);
            }
            if (!rule.pages.includes(page) && rule.pages.length < AXE_PAGES_KEPT) rule.pages.push(page);
            rules.set(violation.id, rule);
          }
          for (const link of result.links) found.add(link);
        }
        if (options.links) links.push({ page, links: [...found].slice(0, 500) });
        opened++;
      } catch (error) {
        options.signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message === "timeout" ? " in tempo" : ` (${(error.message.split("\n")[0] ?? "").slice(0, 160)})` : "";
        failures.push(`La pagina ${page} non si è aperta nel browser${reason}: le altre sono controllate.`);
      }
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    failures.push(`Il browser per il controllo delle pagine non è partito: scorrimento e accessibilità non controllati${error instanceof Error && error.message !== "timeout" ? ` (${error.message.slice(0, 200)})` : ""}.`);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await probe?.close().catch(() => undefined);
  }
  const impact: Readonly<Record<string, number>> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const axe = [...rules.values()].map(({ seen: _seen, ...rule }) => rule).sort((left, right) => (impact[left.impact ?? ""] ?? 4) - (impact[right.impact ?? ""] ?? 4) || right.count - left.count || left.id.localeCompare(right.id));
  return { opened, overflow, axe, ...(brokenImages.length ? { brokenImages } : {}), ...(edges.length ? { edges } : {}), ...(failures.length ? { failures: failures.slice(0, 5) } : {}), ...(options.links ? { links } : {}) };
}

const IMPACT_WORDS: Readonly<Record<string, string>> = { critical: "critica", serious: "seria", moderate: "media", minor: "lieve" };

/**
 * The report warnings of the browser check: one per page and width that scrolls sideways, one per axe rule (at most 10
 * each), then what could not be checked.
 */
export function browserCheckWarnings(check: Pick<BrowserCheck, "overflow" | "axe" | "failures" | "brokenImages" | "edges">): string[] {
  const out = check.overflow.slice(0, 10).map((item) => `Scorrimento orizzontale a ${item.width} px: la pagina ${item.page} è larga ${item.scrollWidth} px${item.elements.length ? ` (sporge ${item.elements.join(", ")})` : ""}. Restringi quegli elementi a quella larghezza (max-width: 100%, flex-wrap, overflow-wrap: anywhere).`);
  if (check.overflow.length > 10) out.push(`Altre ${check.overflow.length - 10} pagine scorrono in orizzontale: correggi queste e ricontrolla.`);
  // Doc 23 item 242.
  for (const item of (check.brokenImages ?? []).slice(0, 10)) out.push(`Immagini che il browser non mostra nella pagina ${item.page}: ${item.images.join(", ")}. Il file non si legge (dati inventati o tagliati): usa il file vero, o togli l'immagine.`);
  for (const item of (check.edges ?? []).slice(0, 10)) out.push(`Testo attaccato al bordo a ${item.width} px nella pagina ${item.page} (${item.elements.join(", ")}): manca lo spazio ai lati. Dai al contenitore un padding-inline con un token (per esempio var(--xb-gutter) o var(--xb-space-m)).`);
  for (const rule of check.axe.slice(0, 10)) {
    const where = rule.targets.length ? ` (per esempio ${rule.targets.slice(0, 3).join(", ")})` : "";
    out.push(`Accessibilità, regola axe ${rule.id}${rule.impact && IMPACT_WORDS[rule.impact] ? `, gravità ${IMPACT_WORDS[rule.impact]}` : ""}: ${rule.help.replace(/\.$/u, "")}. ${rule.count === 1 ? "1 elemento" : `${rule.count} elementi`} in ${rule.pages.join(", ")}${where}. ${rule.helpUrl}`);
  }
  if (check.axe.length > 10) out.push(`Altre ${check.axe.length - 10} regole di accessibilità non rispettate: correggi queste e ricontrolla.`);
  return [...out, ...(check.failures ?? [])];
}
