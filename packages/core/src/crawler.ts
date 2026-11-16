import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { SafeHttpClient, headerValue, sameSiteOrigin, underExternalAsset, type HttpResponse } from "./crawler-http.js";
import { analyzeHtml, containsInputNamed, rewriteCrawledHtml, type HtmlAnalysis, type HtmlReference } from "./crawler-html.js";
import { collectCssUrls, rewriteCssUrls } from "./css.js";
import { normalizeRelativePath, relativeUrl, safeBundlePath } from "./paths.js";
import { scanFiles } from "./scanner.js";
import type { BuildEvent, CrawlReport, DynamicFeature, Finding, RenderPage, RedirectRule, RenderedPage, SiteConfig } from "./types.js";
import type { SourceFile } from "./filesystem.js";

const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_SITEMAP_BYTES = 20 * 1024 * 1024;
const MAX_RETRIES = 4;
/** Identifies the crawler to the sites it reads; the address is the project page. */
const CRAWLER_USER_AGENT = "HistosPublish/0.1.0 (+https://github.com/Seventhose/histeon-publish)";

interface CrawlInput {
  sourceUrl: string;
  include?: readonly string[];
  exclude?: readonly string[];
  crawl?: SiteConfig["crawl"];
  rewrite?: SiteConfig["rewrite"];
  dynamic?: SiteConfig["dynamic"];
  maxBytes?: number;
  cacheDirectory?: string;
  crawlConsent?: string;
  credentials?: { basicUser?: string; basicPassword?: string; cookie?: string };
  renderPage?: RenderPage;
  privateOrigin?: boolean;
  strictOrigin?: boolean;
  originHeaders?: Record<string, string>;
  requireEcho?: { header: string; value: string };
  seedPaths?: string[];
  notFoundProbe?: boolean;
  blockNativeHistosForms?: boolean;
  forbiddenValues?: readonly string[];
  signal?: AbortSignal;
  onEvent?: (event: BuildEvent) => void;
}

interface CrawlPageTask { url: URL; depth: number }
interface PageRecord {
  requestedUrl: URL;
  finalUrl: URL;
  outputPath: string;
  originalHtml: string;
  analysis: HtmlAnalysis;
  depth: number;
}
interface AssetRecord {
  requestedUrl: URL;
  finalUrl: URL;
  outputPath: string;
  bytes: Buffer;
  contentType: string;
}
interface RedirectResponse {
  finalUrl: URL;
  response: HttpResponse;
  chain: Array<{ from: URL; to: URL; status: number }>;
}
interface RobotsRule { allow: boolean; pattern: RegExp; specificity: number }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new HistosPublishError("Operazione annullata.", "cancelled", 6));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.min(Math.max(0, timestamp - Date.now()), 120_000);
}

function safeDisplayUrl(url: URL): string {
  const copy = new URL(url);
  copy.username = "";
  copy.password = "";
  copy.search = "";
  copy.hash = "";
  return copy.href;
}

function canonicalKey(value: URL): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function urlWithoutQuery(value: URL): URL {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url;
}

function delayForRetry(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * Math.max(1, base * 0.2));
}

function rethrowCrawlSafetyFailure(error: unknown): void {
  if (error instanceof HistosPublishError && ["export-mode-not-confirmed", "crawl-sensitive-content"].includes(error.code)) throw error;
}

async function getWithRetry(
  client: SafeHttpClient,
  url: URL,
  maxBytes: number,
  options: { bypassCache?: boolean; signal?: AbortSignal; headers?: Record<string, string>; onRateLimit?: () => void; maxAttempts?: number } = {},
): Promise<HttpResponse> {
  let lastError: unknown;
  const maxAttempts = Math.min(MAX_RETRIES, Math.max(1, options.maxAttempts ?? MAX_RETRIES));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const response = await client.get(url, { maxBytes, ...(options.bypassCache ? { bypassCache: true } : {}), ...(options.headers ? { headers: options.headers } : {}) });
      if (response.status < 500 && response.status !== 429) return response;
      if (response.status === 429) options.onRateLimit?.();
      const wait = retryAfterMs(headerValue(response.headers, "retry-after")) ?? delayForRetry(attempt);
      if (attempt + 1 >= maxAttempts) return response;
      await sleep(wait, options.signal);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof HistosPublishError && error.code === "cancelled")) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
      if (error instanceof HistosPublishError && !["crawl-network", "crawl-timeout", "crawl-dns-failed"].includes(error.code)) throw error;
      if (!(error instanceof HistosPublishError)) throw error;
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      await sleep(delayForRetry(attempt), options.signal);
    }
  }
  if (lastError instanceof HistosPublishError) throw lastError;
  throw new HistosPublishError("Il sito non ha risposto dopo quattro tentativi.", "crawl-retries-exhausted", 5);
}

async function followRedirects(
  client: SafeHttpClient,
  start: URL,
  maxBytes: number,
  options: { bypassCache?: boolean; signal?: AbortSignal; headers?: Record<string, string>; allowUrl?: (url: URL) => boolean; onRateLimit?: () => void; maxAttempts?: number; strictOrigin?: boolean } = {},
): Promise<RedirectResponse> {
  const chain: RedirectResponse["chain"] = [];
  let current = new URL(start);
  for (let count = 0; count <= 5; count += 1) {
    if (options.allowUrl && !options.allowUrl(current)) throw new HistosPublishError("robots.txt non consente di richiedere questa URL.", "crawl-robots-disallowed", 2);
    const response = await getWithRetry(client, current, maxBytes, options);
    const location = headerValue(response.headers, "location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return { finalUrl: current, response, chain };
    if (count === 5) throw new HistosPublishError("Il sito supera il limite di cinque redirect.", "crawl-too-many-redirects", 2);
    const next = new URL(location, current);
    if (options.strictOrigin ? next.origin !== start.origin : !sameSiteOrigin(next, start)) throw new HistosPublishError("Il redirect esce dall’origine autorizzata ed è stato bloccato.", "crawl-cross-origin-redirect", 2);
    next.hash = "";
    chain.push({ from: current, to: next, status: response.status });
    current = next;
  }
  throw new HistosPublishError("Catena di redirect non valida.", "crawl-too-many-redirects", 2);
}

/** Whether a URL is under one of the external asset addresses the user allowed (origin and folder, never a string prefix). */
function allowedExternalAsset(target: URL, entries: readonly string[] | undefined): boolean {
  return (entries ?? []).some((entry) => {
    try { return underExternalAsset(target, new URL(entry)); } catch { return false; }
  });
}

function parseRobots(text: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | undefined;
  let hasRules = false;
  for (const line of text.split(/\r?\n/u)) {
    const clean = line.split("#")[0]?.trim() ?? "";
    if (!clean) continue;
    const separator = clean.indexOf(":");
    if (separator < 0) continue;
    const field = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || hasRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current && value) {
      current.rules.push({ allow: field === "allow", path: value });
      hasRules = true;
    }
  }
  // The group of this crawler is the one naming its token exactly: a substring would take "h" or "publish" for it.
  const specific = groups.filter((group) => group.agents.includes("histospublish"));
  const selected = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes("*"));
  return selected.flatMap((group) => group.rules.map((rule) => {
    const expression = rule.path.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
    const anchored = rule.path.endsWith("$");
    const pattern = anchored ? expression.slice(0, -2) : expression;
    return { allow: rule.allow, pattern: new RegExp(`^${pattern}${anchored ? "$" : ""}`, "u"), specificity: rule.path.replace(/[*$]/gu, "").length };
  }));
}

function robotsAllows(pathname: string, search: string, rules: readonly RobotsRule[]): boolean {
  const value = `${pathname}${search}`;
  const matches = rules.filter((rule) => rule.pattern.test(value)).sort((left, right) => right.specificity - left.specificity || Number(right.allow) - Number(left.allow));
  return matches[0]?.allow ?? true;
}

function cleanXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").trim();
}

function sitemapLocs(bytes: Buffer, url: URL): string[] {
  let input = bytes;
  if (url.pathname.endsWith(".gz")) {
    try { input = gunzipSync(bytes, { maxOutputLength: MAX_SITEMAP_BYTES }); }
    catch { return []; }
  }
  const xml = input.toString("utf8");
  return [...xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/giu)].map((match) => cleanXml(match[1] ?? "")).filter(Boolean);
}

function isExcludedUrl(url: URL, options: CrawlInput): boolean {
  let path: string;
  try { path = decodeURIComponent(url.pathname).toLowerCase(); } catch { path = url.pathname.toLowerCase(); }
  const query = url.searchParams;
  if (!sameSiteOrigin(url, options.sourceUrl)) return true;
  if (/(?:^|\/)wp-admin(?:\/|$)|\/wp-login\.php(?:\/|$)|\/wp-json(?:\/|$)|\bxmlrpc\.php\b|\bwp-cron\.php\b/iu.test(path)) return true;
  if (/\/trackback(?:\/|$)|\/comment-page-\d+(?:\/|$)/iu.test(path)) return true;
  if (!options.crawl?.includeFeeds && /(?:^|\/)feed(?:\/|$)/iu.test(path)) return true;
  if (query.has("s") || query.has("replytocom") || query.has("preview") || query.has("xb_preview") || query.has("add-to-cart")) return true;
  if (/\/(?:cart|checkout|my-account)(?:\/|$)/iu.test(path)) return true;
  const relative = path.replace(/^\//u, "");
  const excluded = options.exclude ?? [];
  if (excluded.some((pattern) => matchesGlob(relative, pattern))) return true;
  const included = options.include ?? [];
  return included.length > 0 && !included.some((pattern) => matchesGlob(relative, pattern));
}

function matchesGlob(value: string, pattern: string): boolean {
  let expression = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i] ?? "";
    if (character === "*" && pattern[i + 1] === "*") { expression += ".*"; i += 1; }
    else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  try { return new RegExp(`${expression}$`, "u").test(value); } catch { return false; }
}

function isHtmlPath(pathname: string): boolean {
  return !/\.[a-z0-9]{1,12}$/iu.test(pathname) || /\.html?$/iu.test(pathname) || /\.php$/iu.test(pathname);
}

function extensionForMime(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const known: Record<string, string> = {
    "text/css": ".css", "text/javascript": ".js", "application/javascript": ".js", "application/json": ".json",
    "application/manifest+json": ".webmanifest", "application/rss+xml": ".xml", "application/atom+xml": ".xml", "application/xml": ".xml", "text/xml": ".xml", "text/plain": ".txt",
    "image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/avif": ".avif", "image/x-icon": ".ico", "font/woff": ".woff", "font/woff2": ".woff2", "application/pdf": ".pdf",
    "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
  };
  return known[mime] ?? ".bin";
}

function stablePathForUrl(url: URL, isPage: boolean, contentType: string, used: Map<string, string>): { path: string; changed: boolean } {
  let decoded = url.pathname;
  try { decoded = decodeURIComponent(url.pathname); } catch { /* Preserve malformed escaping and hash the path below. */ }
  decoded = decoded.normalize("NFC");
  let relative = decoded.replace(/^\/+|\/+$/gu, "");
  if (relative === "") relative = "index.html";
  const hasExtension = /\.[^/]+$/u.test(relative);
  const mimeExtension = extensionForMime(contentType);
  if (isPage) {
    if (/\.php(?:\/|$)/iu.test(relative)) relative = relative.replace(/\.php(?:\/|$)/iu, "/").replace(/\/+$/u, "") || "index";
    if (!/\.html?$/iu.test(relative)) relative = `${relative.replace(/\/+$/u, "")}/index.html`;
  } else if (!hasExtension || /\.php(?:\/|$)/iu.test(relative)) {
    relative = `${relative.replace(/\.php(?:\/|$)/iu, "").replace(/\/+$/u, "") || "asset"}${mimeExtension}`;
  }
  const normalized = normalizeRelativePath(relative);
  let finalPath = normalized?.path;
  let changed = normalized?.changed ?? false;
  if (!finalPath || !safeBundlePath(`/${finalPath}`)) {
    const extension = pathExtension(relative);
    const digest = createHash("sha256").update(url.pathname).digest("hex").slice(0, 24);
    finalPath = `__paths/${digest}${extension}`;
    changed = true;
  }
  const key = finalPath.toLocaleLowerCase("en-US");
  const previous = used.get(key);
  if (previous && previous !== canonicalKey(url)) {
    const extension = pathExtension(finalPath);
    const digest = createHash("sha256").update(url.href).digest("hex").slice(0, 24);
    finalPath = `__paths/${digest}${extension}`;
    changed = true;
  }
  used.set(finalPath.toLocaleLowerCase("en-US"), canonicalKey(url));
  return { path: finalPath, changed };
}

function pathExtension(value: string): string {
  const match = /\.[A-Za-z0-9]{1,12}$/u.exec(value);
  return match?.[0]?.toLowerCase() ?? "";
}

function htmlIsComplete(html: string): boolean {
  return /<\/html\s*>\s*$/iu.test(html.trim()) || /<\/body\s*>\s*<\/html\s*>\s*$/iu.test(html.trim());
}

function addFinding(findings: Finding[], code: string, severity: Finding["severity"], file: string, message: string): void {
  const key = `${code}\u0000${file}`;
  if (!findings.some((item) => `${item.code}\u0000${item.file}` === key)) findings.push({ code, severity, file, message });
}

function parseWpJsonLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item !== null && typeof item === "object" && typeof (item as { link?: unknown }).link === "string" ? [(item as { link: string }).link] : []);
}

function wpSignalHeader(response: HttpResponse): boolean {
  return /rel=["']https:\/\/api\.w\.org\/["']/iu.test(headerValue(response.headers, "link") ?? "");
}

function outputPathForPage(url: URL, contentType: string, used: Map<string, string>): { path: string; changed: boolean } {
  let pathName = url.pathname;
  try { pathName = decodeURIComponent(url.pathname); } catch { /* Stable path generation hashes malformed encodings. */ }
  const html = /text\/html|application\/xhtml\+xml/iu.test(contentType) || isHtmlPath(pathName);
  return stablePathForUrl(url, html, contentType, used);
}

function rewriteJsonAsset(value: unknown, baseUrl: URL, outputPath: string, filesByUrl: ReadonlyMap<string, string>, key = ""): unknown {
  if (typeof value === "string" && ["src", "url", "href", "start_url", "scope", "logo", "image", "contentUrl"].includes(key)) {
    let target: URL;
    try { target = new URL(value, baseUrl); } catch { return value; }
    if (target.protocol !== "http:" && target.protocol !== "https:") return value;
    const suffix = `${target.search}${target.hash}`;
    const output = filesByUrl.get(canonicalKey(urlWithoutQuery(target)));
    return output ? `${relativeUrl(outputPath, output)}${suffix}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteJsonAsset(item, baseUrl, outputPath, filesByUrl, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewriteJsonAsset(item, baseUrl, outputPath, filesByUrl, name)]));
  }
  return value;
}

function urlReference(reference: HtmlReference, pageUrl: URL): URL | null {
  try {
    const target = new URL(reference.raw, pageUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    target.hash = "";
    return target;
  } catch { return null; }
}

function isLikelyAssetUrl(url: URL): boolean {
  return /\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|pdf|json|webmanifest|xml|txt)(?:$|\?)/iu.test(url.href)
    && !/\.html?$/iu.test(url.pathname);
}

function dynamicFeatureKey(feature: DynamicFeature): string {
  return `${feature.code}\u0000${feature.file}`;
}

function htmlHttpHeaders(): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.6",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function getTargetOrigin(input: CrawlInput, source: URL): string {
  const domain = input.rewrite?.destinationDomain;
  if (!domain) return source.origin;
  const normalized = /^https?:\/\//iu.test(domain) ? domain : `https://${domain}`;
  const target = new URL(normalized);
  if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new HistosPublishError("Il dominio di destinazione deve contenere solo schema, host e porta.", "config-invalid", 2);
  }
  return target.origin;
}

export interface CrawlResult {
  files: SourceFile[];
  skipped: string[];
  findings: Finding[];
  report: CrawlReport;
  redirects: RedirectRule[];
}

export interface OnlineDetectionResult {
  kind: "url";
  sourceUrl: string;
  finalUrl: string;
  engine: "wordpress" | "generic";
  wordpressSignals: string[];
  integrations: { histos: boolean; staticBridge: boolean };
  technologies: string[];
  dynamicFeatures: DynamicFeature[];
  maintenance: boolean;
}

export async function detectOnlineSite(input: { sourceUrl: string; crawlConsent: string; timeoutMs?: number; delayMs?: number; credentials?: { basicUser?: string; basicPassword?: string; cookie?: string }; privateOrigin?: boolean }): Promise<OnlineDetectionResult> {
  const source = new URL(input.sourceUrl);
  if (source.protocol !== "http:" && source.protocol !== "https:") throw new HistosPublishError("La sorgente online deve iniziare con http:// o https://.", "source-invalid", 2);
  if (source.username || source.password) throw new HistosPublishError("Rimuovi le credenziali dall’URL e usa le variabili ambiente previste.", "source-invalid", 2);
  if (input.crawlConsent !== source.origin) throw new HistosPublishError(`Prima di leggere ${source.origin}, conferma l’autorizzazione per questo dominio.`, "crawl-consent-required", 2);
  const client = new SafeHttpClient({
    origin: source.origin,
    userAgent: CRAWLER_USER_AGENT,
    timeoutMs: input.timeoutMs ?? 60_000,
    delayMs: input.delayMs ?? 500,
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.privateOrigin === undefined ? {} : { privateOrigin: input.privateOrigin }),
  });
  let robotsRules: RobotsRule[] = [];
  try {
    const robots = await followRedirects(client, new URL("/robots.txt", source.origin), 1024 * 1024, { maxAttempts: 1, allowUrl: (candidate) => candidate.pathname === "/robots.txt" || sameSiteOrigin(candidate, source) });
    if (robots.response.status === 200) robotsRules = parseRobots(robots.response.body.toString("utf8"));
  } catch { /* An unavailable robots file does not prevent a limited detect; the build reports its status. */ }
  if (!robotsAllows(source.pathname, source.search, robotsRules)) throw new HistosPublishError("robots.txt non consente di leggere la home per il rilevamento.", "crawl-robots-disallowed", 2);
  const home = await followRedirects(client, source, 1024 * 1024, {
    maxAttempts: 1,
    allowUrl: (candidate) => candidate.pathname === "/robots.txt" || !sameSiteOrigin(candidate, source) || robotsAllows(candidate.pathname, candidate.search, robotsRules),
  });
  if (home.response.status !== 200) throw new HistosPublishError(`La home ha risposto HTTP ${home.response.status}.`, "source-unreachable", 5);
  const contentType = headerValue(home.response.headers, "content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/iu.test(contentType)) throw new HistosPublishError("L’URL iniziale non restituisce una pagina HTML.", "source-invalid", 2);
  const html = home.response.body.toString("utf8");
  const analysis = analyzeHtml(html, "index.html");
  const signals = new Set<string>();
  const restNamespaces = new Set<string>();
  if (wpSignalHeader(home.response)) signals.add("header REST WordPress");
  if (analysis.technologies.includes("WordPress")) signals.add("markup WordPress");
  if (/(?:\/wp-content\/|\/wp-includes\/)/iu.test(html)) signals.add("percorsi wp-content/wp-includes");
  if (/<link\b[^>]*rel=["']https:\/\/api\.w\.org\/["']/iu.test(html)) signals.add("link REST nel documento");
  if (/<body\b[^>]*class=["'][^"']*\bwp-[a-z0-9_-]+/iu.test(html)) signals.add("classi WordPress nel body");
  if (signals.size > 0) {
    const restUrl = new URL("/wp-json/", home.finalUrl);
    if (robotsAllows(restUrl.pathname, restUrl.search, robotsRules)) {
      try {
        const rest = await followRedirects(client, restUrl, 256 * 1024, { maxAttempts: 1, headers: { Accept: "application/json" }, allowUrl: (candidate) => robotsAllows(candidate.pathname, candidate.search, robotsRules) });
        if (rest.response.status === 200) {
          const data: unknown = JSON.parse(rest.response.body.toString("utf8"));
          if (data !== null && typeof data === "object" && Array.isArray((data as { namespaces?: unknown }).namespaces)) {
            signals.add("REST con namespaces");
            for (const namespace of (data as { namespaces: unknown[] }).namespaces) if (typeof namespace === "string") restNamespaces.add(namespace);
          }
        }
      } catch { /* Disabled REST endpoints leave the other signals usable. */ }
    }
  }
  const wordpress = signals.size >= 2;
  const technologies = new Set(analysis.technologies);
  if ([...restNamespaces].some((namespace) => /(?:wc\/store|woocommerce)/iu.test(namespace))) technologies.add("WooCommerce");
  if ([...restNamespaces].some((namespace) => namespace.startsWith("xb/v1"))) technologies.add("Histeon");
  let staticBridge = headerValue(home.response.headers, "x-static-bridge-route")?.toLowerCase() === "static"
    || technologies.has("Static Bridge");
  if (wordpress && !staticBridge) {
    const probe = new URL("/wp-content/static-bridge/", home.finalUrl);
    if (robotsAllows(probe.pathname, probe.search, robotsRules)) {
      try {
        const response = await followRedirects(client, probe, 64 * 1024, {
          maxAttempts: 1,
          allowUrl: (candidate) => sameSiteOrigin(candidate, source) && robotsAllows(candidate.pathname, candidate.search, robotsRules),
        });
        staticBridge = response.response.status === 403;
      } catch { /* The public marker is optional; a blocked probe does not block detection. */ }
    }
  }
  if (staticBridge) technologies.add("Static Bridge");
  const histos = technologies.has("Histeon") || restNamespaces.has("xb/v1") || /(?:\/wp-content\/plugins\/xb\/|\bxb\/v1\b|\bxb-[a-z0-9_-]+)/iu.test(html);
  return {
    kind: "url",
    sourceUrl: safeDisplayUrl(source),
    finalUrl: safeDisplayUrl(home.finalUrl),
    engine: wordpress ? "wordpress" : "generic",
    wordpressSignals: [...signals].sort((left, right) => left.localeCompare(right, "en")),
    integrations: { histos, staticBridge },
    technologies: [...technologies].sort((left, right) => left.localeCompare(right, "en")),
    dynamicFeatures: analysis.dynamicFeatures,
    maintenance: analysis.maintenance,
  };
}

export async function crawlSite(input: CrawlInput): Promise<CrawlResult> {
  const source = new URL(input.sourceUrl);
  if (source.protocol !== "http:" && source.protocol !== "https:") throw new HistosPublishError("La sorgente online deve iniziare con http:// o https://.", "source-invalid", 2);
  if (source.username || source.password) throw new HistosPublishError("Rimuovi le credenziali dall’URL e usa le variabili ambiente previste.", "source-invalid", 2);
  if (input.crawlConsent !== source.origin) throw new HistosPublishError(`Prima di leggere ${source.origin}, conferma l’autorizzazione per questo dominio.`, "crawl-consent-required", 2);
  const shouldIgnoreRobots = Boolean(input.crawl?.ignoreRobots) || input.crawl?.respectRobots === false;
  if (shouldIgnoreRobots && input.crawl?.siteManaged !== true) {
    throw new HistosPublishError("Per ignorare robots.txt devi dichiarare di gestire il sito.", "config-invalid", 2);
  }
  if (input.crawl?.render && !input.renderPage) throw new HistosPublishError("La modalità render richiede l’app desktop oppure Playwright Core e un Chrome/Chromium di sistema.", "render-engine-missing", 5);
  const concurrency = input.crawl?.concurrency ?? 4;
  const delayMs = input.crawl?.delayMs ?? 500;
  const timeoutMs = input.crawl?.timeoutMs ?? 60_000;
  const maxPages = input.crawl?.maxPages ?? 5000;
  const maxDepth = input.crawl?.maxDepth ?? 12;
  const maxBytes = Math.min(input.crawl?.maxBytes ?? input.maxBytes ?? 512 * 1024 * 1024, input.maxBytes ?? Number.MAX_SAFE_INTEGER);
  const respectRobots = !shouldIgnoreRobots;
  const client = new SafeHttpClient({
    origin: source.origin,
    userAgent: CRAWLER_USER_AGENT,
    timeoutMs,
    delayMs,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.cacheDirectory ? { cacheDirectory: input.cacheDirectory } : {}),
    externalAssets: input.rewrite?.externalAssets ?? [],
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.privateOrigin === undefined ? {} : { privateOrigin: input.privateOrigin }),
    ...(input.strictOrigin === undefined ? {} : { strictOrigin: input.strictOrigin }),
    ...(input.originHeaders === undefined ? {} : { originHeaders: input.originHeaders }),
    ...(input.forbiddenValues === undefined ? {} : { forbiddenValues: input.forbiddenValues }),
  });
  const findings: Finding[] = [];
  const skipped: string[] = [];
  const redirects: RedirectRule[] = [];
  const pages: PageRecord[] = [];
  const assets: AssetRecord[] = [];
  const filesByUrl = new Map<string, string>();
  const usedPaths = new Map<string, string>();
  const discovered = new Map<string, CrawlPageTask>();
  const pending: CrawlPageTask[] = [];
  const assetUrls = new Map<string, URL>();
  const seenSitemaps = new Set<string>();
  const robotsSitemaps: URL[] = [];
  const dynamicFeatures: DynamicFeature[] = [];
  const technologies = new Set<string>();
  const signals = new Set<string>();
  const signatures = new Map<string, string>();
  let totalBytes = 0;
  let pagesDownloaded = 0;
  let assetsDownloaded = 0;
  let robotsRules: RobotsRule[] = [];
  let robotsText = "";
  let adaptiveConcurrency = concurrency;
  const emit = (event: BuildEvent): void => { try { input.onEvent?.(event); } catch { /* A progress listener cannot interrupt a crawl. */ } };
  const isOriginUrl = (candidate: URL): boolean => input.strictOrigin ? candidate.origin === source.origin : sameSiteOrigin(candidate, source);

  const enqueuePage = (candidate: URL, depth: number): void => {
    if (!isOriginUrl(candidate) || isExcludedUrl(candidate, input) || depth > maxDepth) return;
    if (input.crawl?.includeFeeds && /\/(?:feed)(?:\/|$)/iu.test(candidate.pathname)) {
      assetUrls.set(canonicalKey(candidate), urlWithoutQuery(candidate));
      return;
    }
    const key = canonicalKey(urlWithoutQuery(candidate));
    if (discovered.has(key)) return;
    if (discovered.size >= maxPages) {
      skipped.push(safeDisplayUrl(candidate));
      addFinding(findings, "crawl-page-limit", "warn", safeDisplayUrl(candidate), "La pagina è oltre il limite configurato.");
      return;
    }
    const task = { url: urlWithoutQuery(candidate), depth };
    discovered.set(key, task);
    pending.push(task);
  };

  const enqueueReference = (reference: HtmlReference, base: URL, depth: number): void => {
    const target = urlReference(reference, base);
    if (!target || !isOriginUrl(target)) {
      if (target && reference.kind === "asset") {
        const allowlisted = input.rewrite?.externalAssets?.some((prefix) => {
          try {
            const allowed = new URL(prefix);
            if (allowed.origin !== target.origin) return false;
            const prefixPath = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
            return allowed.pathname === "/" || target.pathname === allowed.pathname || target.pathname.startsWith(prefixPath);
          } catch { return false; }
        });
        if (allowlisted) assetUrls.set(canonicalKey(target), target);
        else addFinding(findings, "external-asset", "warn", safeDisplayUrl(base), "Una risorsa esterna resta collegata all’origine esterna e non viene copiata senza autorizzazione esplicita.");
      }
      return;
    }
    if (reference.kind === "page" && /\/(?:feed)(?:\/|$)/iu.test(target.pathname) && input.crawl?.includeFeeds) assetUrls.set(canonicalKey(target), target);
    else if (reference.kind === "page" && !isLikelyAssetUrl(target)) enqueuePage(target, depth + 1);
    else assetUrls.set(canonicalKey(target), target);
  };

  const fetchAndFollow = async (url: URL, maxResponseBytes: number, headers?: Record<string, string>, recordRedirects = false): Promise<RedirectResponse> => {
    const requestUrl = new URL(url);
    if (input.crawl?.bypassCache && sameSiteOrigin(requestUrl, source)) requestUrl.searchParams.set("__hp", randomUUID());
    const response = await followRedirects(client, requestUrl, maxResponseBytes, {
      ...(input.crawl?.bypassCache ? { bypassCache: true } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(headers ? { headers } : {}),
      ...(input.strictOrigin ? { strictOrigin: true } : {}),
      allowUrl: (candidate) => !respectRobots || candidate.pathname === "/robots.txt" || !isOriginUrl(candidate) || robotsAllows(candidate.pathname, candidate.search, robotsRules),
      onRateLimit: () => { adaptiveConcurrency = Math.max(1, adaptiveConcurrency - 1); },
    });
    if (input.requireEcho && isOriginUrl(response.finalUrl) && [200, 404].includes(response.response.status)) {
      const contentType = headerValue(response.response.headers, "content-type") ?? "";
      if (/^(?:text\/html|application\/xhtml\+xml)/iu.test(contentType) && headerValue(response.response.headers, input.requireEcho.header) !== input.requireEcho.value) {
        throw new HistosPublishError("Il sito non ha confermato la modalità di esportazione richiesta.", "export-mode-not-confirmed", 2);
      }
    }
    if (recordRedirects) {
      for (const item of response.chain) {
        const from = item.from.pathname || "/";
        const to = item.to.pathname || "/";
        if (item.status === 301 || item.status === 308) redirects.push({ from, to, status: item.status });
        else addFinding(findings, "temporary-redirect", "warn", from, `Il sito ha restituito un redirect temporaneo ${item.status}.`);
      }
    }
    return response;
  };

  if (respectRobots) {
    const robotsUrl = new URL("/robots.txt", source.origin);
    try {
      const response = await fetchAndFollow(robotsUrl, 1024 * 1024, { Accept: "text/plain,*/*;q=0.5" });
      if (response.response.status === 200) {
        robotsText = response.response.body.toString("utf8");
        robotsRules = parseRobots(robotsText);
        for (const match of robotsText.matchAll(/^\s*Sitemap\s*:\s*(\S+)/gimu)) {
          try { robotsSitemaps.push(new URL(match[1] ?? "", source)); } catch { /* Ignore malformed sitemap declarations. */ }
        }
      } else if (![404, 410].includes(response.response.status)) {
        addFinding(findings, "robots-unavailable", "warn", "robots.txt", `robots.txt ha risposto HTTP ${response.response.status}.`);
      }
    } catch (error) {
      rethrowCrawlSafetyFailure(error);
      addFinding(findings, "robots-unavailable", "warn", "robots.txt", error instanceof Error ? error.message : "robots.txt non è accessibile.");
    }
  }

  if (respectRobots && !robotsAllows(source.pathname, source.search, robotsRules)) {
    throw new HistosPublishError("robots.txt non consente di acquisire la pagina iniziale.", "crawl-robots-disallowed", 2);
  }
  const initial = await fetchAndFollow(source, MAX_PAGE_BYTES, htmlHttpHeaders(), true);
  if (initial.response.status !== 200) throw new HistosPublishError(`La pagina iniziale ha risposto HTTP ${initial.response.status}.`, "source-unreachable", 5);
  const initialType = headerValue(initial.response.headers, "content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/iu.test(initialType)) throw new HistosPublishError("L’URL iniziale non restituisce una pagina HTML.", "source-invalid", 2);
  const initialHtml = initial.response.body.toString("utf8");
  const initialAnalysis = analyzeHtml(initialHtml, "index.html");
  if (wpSignalHeader(initial.response)) signals.add("header Link rel=api.w.org");
  if (/<link\b[^>]*rel=["']https:\/\/api\.w\.org\/["']/iu.test(initialHtml)) signals.add("link rel=api.w.org");
  if (/<meta\b(?=[^>]*name=["']generator["'])(?=[^>]*content=["']WordPress)/iu.test(initialHtml)) signals.add("meta generator WordPress");
  if (/\/wp-content\/|\/wp-includes\//iu.test(initialHtml)) signals.add("percorsi wp-content/wp-includes");
  if (/wp-emoji-release\.min\.js/iu.test(initialHtml)) signals.add("script emoji WordPress");
  if (/\bclass=["'][^"']*\bwp-[a-z0-9_-]+/iu.test(initialHtml)) signals.add("classi wp- nel markup");
  if (/(?:wp-content\/plugins\/xb\/|\bxb-[a-z0-9_-]+|\bxb\/v1\b)/iu.test(initialHtml)) technologies.add("Histeon");
  if (headerValue(initial.response.headers, "x-static-bridge-route") === "static" || /static-bridge-fluent-forms/iu.test(initialHtml)) technologies.add("Static Bridge");
  for (const item of initialAnalysis.technologies) technologies.add(item);

  if (signals.size < 2) {
    const restUrl = new URL("/wp-json/", source.origin);
    let restResponse: HttpResponse | undefined;
    try { restResponse = await fetchAndFollow(restUrl, 1024 * 1024, { Accept: "application/json" }).then((item) => item.response); }
    catch (error) { rethrowCrawlSafetyFailure(error); /* An unavailable REST API is common on WordPress sites. */ }
    if (restResponse?.status === 200) {
      try {
        const body: unknown = JSON.parse(restResponse.body.toString("utf8"));
        if (body !== null && typeof body === "object" && Array.isArray((body as { namespaces?: unknown }).namespaces)) signals.add("JSON wp-json con namespaces");
      } catch { /* The endpoint is not public JSON. */ }
    }
  }
  const engine: CrawlReport["engine"] = signals.size >= 2 ? "wordpress" : "generic";
  enqueuePage(initial.finalUrl, 0);
  if (input.seedPaths) {
    for (const raw of input.seedPaths.slice(0, maxPages)) {
      try { enqueuePage(new URL(raw, source.origin), 0); } catch { /* Agent requests validate seed paths before the crawler. */ }
    }
    if (input.seedPaths.length > maxPages) addFinding(findings, "seed-paths-truncated", "warn", "paths", "Sono state saltate le pagine oltre il limite massimo del crawl.");
  }
  for (const raw of input.crawl?.urls ?? []) {
    try { enqueuePage(new URL(raw, source), 0); }
    catch { addFinding(findings, "invalid-manual-url", "warn", "config", "Un URL aggiunto manualmente non è valido e verrà ignorato."); }
  }

  const sitemapSeeds = [...robotsSitemaps, ...["/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap.xml"].map((pathname) => new URL(pathname, source.origin))];
  const sitemapQueue = sitemapSeeds;
  let sitemapDepth = 0;
  while (sitemapQueue.length > 0 && sitemapDepth < 100) {
    throwIfAborted(input.signal);
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || !sameSiteOrigin(sitemapUrl, source)) continue;
    const key = canonicalKey(sitemapUrl);
    if (seenSitemaps.has(key)) continue;
    seenSitemaps.add(key);
    sitemapDepth += 1;
    try {
      const response = await fetchAndFollow(sitemapUrl, MAX_SITEMAP_BYTES, { Accept: "application/xml,text/xml,*/*;q=0.5" });
      if (response.response.status !== 200) continue;
      const locs = sitemapLocs(response.response.body, response.finalUrl);
      for (const value of locs) {
        let location: URL;
        try { location = new URL(value, response.finalUrl); } catch { continue; }
        if (!sameSiteOrigin(location, source)) continue;
        if (/\.xml(?:\.gz)?(?:$|\?)/iu.test(location.pathname)) sitemapQueue.push(location);
        else enqueuePage(location, 0);
      }
    } catch (error) {
      rethrowCrawlSafetyFailure(error);
      addFinding(findings, "sitemap-unavailable", "warn", safeDisplayUrl(sitemapUrl), error instanceof Error ? error.message : "La sitemap non è accessibile.");
    }
  }

  if (engine === "wordpress") {
    const restRoot = new URL("/wp-json/wp/v2/", source.origin);
    for (const endpoint of ["types", "taxonomies"]) {
      try {
        let response = await fetchAndFollow(new URL(endpoint, restRoot), 2 * 1024 * 1024, { Accept: "application/json" });
        if (response.response.status === 404 || response.response.status === 403) {
          const fallback = new URL(source.origin);
          fallback.pathname = "/";
          fallback.searchParams.set("rest_route", `/wp/v2/${endpoint}`);
          response = await fetchAndFollow(fallback, 2 * 1024 * 1024, { Accept: "application/json" });
        }
        if (response.response.status !== 200) continue;
        const definitions: unknown = JSON.parse(response.response.body.toString("utf8"));
        if (definitions === null || typeof definitions !== "object") continue;
        const bases = Object.values(definitions as Record<string, { rest_base?: unknown; viewable?: unknown }>).flatMap((item) => typeof item?.rest_base === "string" && item.viewable !== false ? [item.rest_base] : []);
        for (const base of [...new Set(bases)]) {
          for (let page = 1; page <= 100 && discovered.size < maxPages; page += 1) {
            const pageUrl = new URL(encodeURIComponent(base), restRoot);
            pageUrl.searchParams.set("per_page", "100");
            pageUrl.searchParams.set("page", String(page));
            pageUrl.searchParams.set("_fields", "link");
            const items = await fetchAndFollow(pageUrl, 5 * 1024 * 1024, { Accept: "application/json" });
            if (items.response.status !== 200) break;
            try {
              const links = parseWpJsonLinks(JSON.parse(items.response.body.toString("utf8")));
              for (const link of links) {
                try { enqueuePage(new URL(link), 0); } catch { /* Invalid REST links are ignored. */ }
              }
              const totalPages = Number(headerValue(items.response.headers, "x-wp-totalpages") ?? "1");
              if (!Number.isFinite(totalPages) || page >= totalPages || links.length === 0) break;
            } catch { break; }
          }
        }
      } catch (error) { rethrowCrawlSafetyFailure(error); /* Anonymous REST can be disabled; HTML and sitemaps remain available. */ }
    }
  }

  const processed = new Set<string>();
  const workOnePage = async (task: CrawlPageTask): Promise<void> => {
    throwIfAborted(input.signal);
    const requestUrl = urlWithoutQuery(task.url);
    if (robotsRules.length > 0 && !robotsAllows(requestUrl.pathname, requestUrl.search, robotsRules)) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "robots-disallowed", "warn", safeDisplayUrl(requestUrl), "robots.txt non consente di acquisire questa pagina.");
      return;
    }
    let redirect: RedirectResponse;
    try {
      redirect = canonicalKey(requestUrl) === canonicalKey(urlWithoutQuery(initial.finalUrl))
        ? initial
        : await fetchAndFollow(requestUrl, Math.min(MAX_PAGE_BYTES, maxBytes), htmlHttpHeaders(), true);
    }
    catch (error) {
      rethrowCrawlSafetyFailure(error);
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "page-fetch-failed", "warn", safeDisplayUrl(requestUrl), error instanceof Error ? error.message : "La pagina non è stata scaricata.");
      return;
    }
    if (redirect.response.status !== 200) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "page-http-status", "warn", safeDisplayUrl(requestUrl), `La pagina ha risposto HTTP ${redirect.response.status}.`);
      return;
    }
    const contentType = headerValue(redirect.response.headers, "content-type") ?? "";
    const pageAge = Number(headerValue(redirect.response.headers, "age") ?? "0");
    if (Number.isFinite(pageAge) && pageAge > 86_400) addFinding(findings, "stale-cached-page", "warn", safeDisplayUrl(requestUrl), "La cache del sito segnala una copia servita da oltre 24 ore.");
    if (!/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "page-not-html", "warn", safeDisplayUrl(requestUrl), "L’URL interno non restituisce un documento HTML.");
      return;
    }
    if (redirect.response.body.byteLength > MAX_PAGE_BYTES) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "page-too-large", "warn", safeDisplayUrl(requestUrl), "La pagina supera il limite di 10 MiB.");
      return;
    }
    let html = redirect.response.body.toString("utf8");
    let finalPageUrl = redirect.finalUrl;
    let rendered: RenderedPage | undefined;
    if (input.crawl?.render && input.renderPage) {
      try {
        rendered = await input.renderPage({
          url: redirect.finalUrl.href,
          timeoutMs,
          maxBytes: Math.min(MAX_PAGE_BYTES, maxBytes),
          maxRequests: Math.min(500, Math.max(40, maxPages * 2)),
          signal: input.signal ?? new AbortController().signal,
          fetchResource: (url, requestMaxBytes) => client.get(url, { maxBytes: Math.min(requestMaxBytes, MAX_ASSET_BYTES) }),
        });
        const renderedUrl = new URL(rendered.finalUrl);
        if (!sameSiteOrigin(renderedUrl, source) || renderedUrl.username || renderedUrl.password) {
          throw new HistosPublishError("La modalità render ha terminato la navigazione fuori dall’origine autorizzata.", "crawl-cross-origin", 2);
        }
        if (Buffer.byteLength(rendered.html, "utf8") > MAX_PAGE_BYTES) throw new HistosPublishError("Il DOM serializzato supera il limite di 10 MiB.", "crawl-response-too-large", 2);
        html = rendered.html;
        finalPageUrl = renderedUrl;
      } catch (error) {
        rethrowCrawlSafetyFailure(error);
        if (input.signal?.aborted) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
        skipped.push(safeDisplayUrl(requestUrl));
        addFinding(findings, "render-failed", "warn", safeDisplayUrl(requestUrl), error instanceof Error ? error.message : "Il browser isolato non ha renderizzato la pagina.");
        return;
      }
    }
    const preliminary = analyzeHtml(html, "index.html");
    if (!htmlIsComplete(html) && !preliminary.looksHtml) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "page-truncated", "warn", safeDisplayUrl(requestUrl), "Il contenuto non sembra una pagina HTML completa.");
      return;
    }
    if (preliminary.maintenance) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "maintenance-page", "warn", safeDisplayUrl(requestUrl), "La pagina sembra una schermata di manutenzione o coming soon.");
      return;
    }
    if (preliminary.loggedIn) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "authenticated-page", "block", safeDisplayUrl(requestUrl), "La pagina contiene elementi di una sessione WordPress autenticata.");
      return;
    }
    if (preliminary.fatalOutput) {
      skipped.push(safeDisplayUrl(requestUrl));
      addFinding(findings, "server-error-output", "warn", safeDisplayUrl(requestUrl), "La pagina mostra un errore PHP o un errore critico.");
      return;
    }
    const digest = createHash("sha256").update(html.replace(/https?:\/\/[^/\s"']+/giu, "//HOST").replace(/\s+/gu, " ").trim()).digest("hex");
    const otherUrl = signatures.get(digest);
    if (otherUrl && otherUrl !== canonicalKey(requestUrl)) addFinding(findings, "similar-page-content", "warn", safeDisplayUrl(requestUrl), "Il contenuto coincide con un’altra URL e potrebbe essere una pagina coming soon o un soft-404.");
    else signatures.set(digest, canonicalKey(requestUrl));

    const existingPage = pages.find((page) => canonicalKey(page.finalUrl) === canonicalKey(finalPageUrl));
    if (existingPage) {
      filesByUrl.set(canonicalKey(urlWithoutQuery(requestUrl)), existingPage.outputPath);
      filesByUrl.set(canonicalKey(urlWithoutQuery(redirect.finalUrl)), existingPage.outputPath);
      return;
    }
    const output = outputPathForPage(finalPageUrl, contentType, usedPaths);
    if (output.changed) addFinding(findings, "path-normalized", "warn", output.path, "Il percorso URL è stato reso sicuro e compatibile con Windows.");
    totalBytes += redirect.response.body.byteLength;
    if (totalBytes > maxBytes) throw new HistosPublishError("Il sito supera il limite totale di byte configurato.", "crawl-total-too-large", 2);
    const analysis = analyzeHtml(html, output.path);
    if (input.blockNativeHistosForms && containsInputNamed(html, "xb_form")) {
      addFinding(findings, "histos-forms-unsupported", "block", output.path, "La pagina usa un modulo nativo Histeon, non compatibile con questo Worker statico.");
    }
    for (const feature of analysis.dynamicFeatures) dynamicFeatures.push(feature);
    for (const technology of analysis.technologies) technologies.add(technology);
    if (/\/wp-content\/|\/wp-includes\//iu.test(html)) signals.add("percorsi wp-content/wp-includes");
    if (analysis.technologies.includes("WordPress")) signals.add("segnali markup WordPress");
    if (/^\s*Sitemap\s*:/imu.test(robotsText)) { /* Sitemap source already processed above. */ }
    const record: PageRecord = { requestedUrl: requestUrl, finalUrl: finalPageUrl, outputPath: output.path, originalHtml: html, analysis, depth: task.depth };
    pages.push(record);
    filesByUrl.set(canonicalKey(urlWithoutQuery(requestUrl)), output.path);
    filesByUrl.set(canonicalKey(urlWithoutQuery(finalPageUrl)), output.path);
    for (const reference of analysis.references) enqueueReference(reference, finalPageUrl, task.depth);
    if (rendered) {
      if (rendered.idleTimedOut) addFinding(findings, "render-networkidle-timeout", "warn", output.path, "La pagina non è diventata inattiva entro il limite; il DOM è stato salvato comunque.");
      for (const resource of rendered.requests) {
        let target: URL;
        try { target = new URL(resource.url); } catch { continue; }
        if (target.protocol !== "http:" && target.protocol !== "https:") continue;
        if (canonicalKey(urlWithoutQuery(target)) === canonicalKey(urlWithoutQuery(finalPageUrl))) continue;
        // Playwright names resource types in lowercase (image, fetch…); compared without case, whatever the renderer.
        const type = resource.type.toLowerCase();
        if (["stylesheet", "image", "font", "script", "media", "texttrack", "manifest", "other"].includes(type)) {
          if (sameSiteOrigin(target, source) || allowedExternalAsset(target, input.rewrite?.externalAssets)) assetUrls.set(canonicalKey(target), urlWithoutQuery(target));
        }
        if (["xhr", "fetch", "websocket", "eventsource"].includes(type)) {
          const internal = sameSiteOrigin(target, source) ? "interna" : "esterna";
          dynamicFeatures.push({ code: "rendered-js-api", file: output.path, message: `La pagina caricata via JavaScript usa una richiesta API ${internal}: ${safeDisplayUrl(target)}.`, solution: "Verifica se i dati possono essere acquisiti come asset statici. Il bundle può ancora richiedere un’API esterna." });
        }
      }
      addFinding(findings, "rendered-spa-api-limit", "warn", output.path, "La modalità render salva il DOM e raccoglie le risorse, ma non rende statiche le funzioni o le API della SPA.");
    }
    pagesDownloaded += 1;
    totalBytes += 0;
    emit({ type: "progress", phase: "crawl", completed: pagesDownloaded, total: Math.min(maxPages, discovered.size) });
  };

  while (pending.length > 0 && pagesDownloaded < maxPages) {
    throwIfAborted(input.signal);
    const batch: CrawlPageTask[] = [];
    while (batch.length < adaptiveConcurrency && pending.length > 0) {
      const task = pending.shift();
      if (!task) break;
      const key = canonicalKey(task.url);
      if (processed.has(key)) continue;
      processed.add(key);
      batch.push(task);
    }
    await Promise.all(batch.map(workOnePage));
  }
  if (pending.length > 0) {
    for (const task of pending) {
      skipped.push(safeDisplayUrl(task.url));
      addFinding(findings, "crawl-page-limit", "warn", safeDisplayUrl(task.url), "La pagina è oltre il limite configurato.");
    }
  }
  if (input.notFoundProbe) {
    const probeUrl = new URL("/histos-404-" + randomUUID().replaceAll("-", "").slice(0, 16) + "/", source.origin);
    try {
      const response = await fetchAndFollow(probeUrl, MAX_PAGE_BYTES, htmlHttpHeaders());
      const contentType = headerValue(response.response.headers, "content-type") ?? "";
      if (response.response.status !== 404 || !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
        addFinding(findings, "missing-404-page", "warn", "404.html", "Il sito non ha restituito una pagina HTML con stato HTTP 404.");
      } else {
        const html = response.response.body.toString("utf8");
        const analysis = analyzeHtml(html, "404.html");
        if (input.blockNativeHistosForms && containsInputNamed(html, "xb_form")) {
          addFinding(findings, "histos-forms-unsupported", "block", "404.html", "La pagina 404 usa un modulo nativo Histeon, non compatibile con questo Worker statico.");
        }
        for (const feature of analysis.dynamicFeatures) dynamicFeatures.push(feature);
        for (const technology of analysis.technologies) technologies.add(technology);
        pages.push({ requestedUrl: probeUrl, finalUrl: response.finalUrl, outputPath: "404.html", originalHtml: html, analysis, depth: 0 });
        filesByUrl.set(canonicalKey(urlWithoutQuery(probeUrl)), "404.html");
        for (const reference of analysis.references) if (reference.kind === "asset") enqueueReference(reference, response.finalUrl, 0);
        totalBytes += response.response.body.byteLength;
        pagesDownloaded += 1;
      }
    } catch (error) {
      rethrowCrawlSafetyFailure(error);
      addFinding(findings, "missing-404-page", "warn", "404.html", "Non è stato possibile acquisire una pagina 404 verificabile.");
    }
  }
  if (pagesDownloaded === 0) {
    addFinding(findings, "crawl-no-pages", "block", safeDisplayUrl(initial.finalUrl), "Nessuna pagina HTML ha superato i controlli; il bundle non è pubblicabile.");
  }

  // Add stable common root assets even when a theme omits explicit links.
  for (const pathname of ["/favicon.ico", "/robots.txt"]) {
    const url = new URL(pathname, source.origin);
    if (pathname === "/robots.txt") continue;
    assetUrls.set(canonicalKey(url), url);
  }
  const assetsPending = [...assetUrls.values()];
  const assetProcessed = new Set<string>();
  const workOneAsset = async (url: URL): Promise<void> => {
    throwIfAborted(input.signal);
    const key = canonicalKey(urlWithoutQuery(url));
    if (assetProcessed.has(key)) return;
    assetProcessed.add(key);
    if (totalBytes >= maxBytes) {
      addFinding(findings, "asset-over-budget", "warn", safeDisplayUrl(url), "La risorsa è stata saltata perché il crawl ha raggiunto il limite totale di byte.");
      skipped.push(safeDisplayUrl(url));
      return;
    }
    let response: RedirectResponse;
    try { response = await fetchAndFollow(url, Math.min(MAX_ASSET_BYTES, maxBytes), { Accept: "*/*" }); }
    catch (error) {
      rethrowCrawlSafetyFailure(error);
      addFinding(findings, "missing-asset", "warn", safeDisplayUrl(url), error instanceof Error ? error.message : "La risorsa non è stata scaricata.");
      return;
    }
    if (response.response.status !== 200) {
      addFinding(findings, "missing-asset", "warn", safeDisplayUrl(url), `La risorsa ha risposto HTTP ${response.response.status}.`);
      return;
    }
    const contentType = headerValue(response.response.headers, "content-type") ?? "application/octet-stream";
    const assetAge = Number(headerValue(response.response.headers, "age") ?? "0");
    if (Number.isFinite(assetAge) && assetAge > 86_400) addFinding(findings, "stale-cached-asset", "warn", safeDisplayUrl(url), "La cache del sito segnala una risorsa servita da oltre 24 ore.");
    if (/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      addFinding(findings, "asset-returned-html", "warn", safeDisplayUrl(url), "Un riferimento a una risorsa restituisce una pagina HTML.");
      return;
    }
    if (totalBytes + response.response.body.byteLength > maxBytes) {
      addFinding(findings, "asset-over-budget", "warn", safeDisplayUrl(url), "La risorsa è stata saltata perché supera il limite totale del sito.");
      skipped.push(safeDisplayUrl(url));
      return;
    }
    if (pages.length + assets.length >= 20_000) {
      addFinding(findings, "crawl-file-limit", "warn", safeDisplayUrl(url), "La risorsa è stata saltata perché il bundle ha raggiunto 20.000 file.");
      skipped.push(safeDisplayUrl(url));
      return;
    }
    const output = stablePathForUrl(response.finalUrl, false, contentType, usedPaths);
    if (output.changed) addFinding(findings, "path-normalized", "warn", output.path, "Il percorso della risorsa è stato reso sicuro e compatibile con Windows.");
    const record: AssetRecord = { requestedUrl: urlWithoutQuery(url), finalUrl: response.finalUrl, outputPath: output.path, bytes: response.response.body, contentType };
    assets.push(record);
    filesByUrl.set(canonicalKey(urlWithoutQuery(url)), output.path);
    filesByUrl.set(canonicalKey(urlWithoutQuery(response.finalUrl)), output.path);
    totalBytes += response.response.body.byteLength;
    assetsDownloaded += 1;
    if (/text\/css/iu.test(contentType) || /\.css(?:$|\?)/iu.test(url.pathname)) {
      const css = response.response.body.toString("utf8");
      let references: string[] = [];
      try { references = collectCssUrls(css); } catch { addFinding(findings, "css-parse-failed", "warn", output.path, "Un foglio CSS non è stato analizzato completamente."); }
      for (const raw of references) {
        let target: URL;
        try { target = new URL(raw, response.finalUrl); } catch { continue; }
        if (sameSiteOrigin(target, source) || allowedExternalAsset(target, input.rewrite?.externalAssets)) assetUrls.set(canonicalKey(target), target);
      }
    }
    emit({ type: "progress", phase: "assets", completed: assetsDownloaded, total: assetUrls.size });
  };
  let assetIndex = 0;
  while (assetIndex < assetsPending.length) {
    throwIfAborted(input.signal);
    const batch = assetsPending.slice(assetIndex, assetIndex + adaptiveConcurrency);
    assetIndex += batch.length;
    await Promise.all(batch.map(workOneAsset));
    for (const url of assetUrls.values()) if (!assetProcessed.has(canonicalKey(urlWithoutQuery(url)))) assetsPending.push(url);
  }

  // A repeated URL is harmless; redirect rules are deduplicated by source/target.
  const redirectMap = new Map<string, RedirectRule>();
  for (const rule of redirects) {
    if (rule.from === rule.to) continue;
    redirectMap.set(`${rule.from}\u0000${rule.to}`, rule);
  }
  const finalRedirects = [...redirectMap.values()].sort((left, right) => left.from.localeCompare(right.from, "en"));
  const destinationOrigin = getTargetOrigin(input, source);
  const outputFiles: SourceFile[] = [];
  for (const page of pages) {
    const rewritten = rewriteCrawledHtml(page.originalHtml, {
      pageUrl: page.finalUrl.href,
      outputPath: page.outputPath,
      sourceOrigin: source.origin,
      destinationOrigin,
      filesByUrl,
      ...(input.rewrite?.removeEmoji === undefined ? {} : { removeEmoji: input.rewrite.removeEmoji }),
      ...(input.dynamic?.hideComments === undefined ? {} : { hideComments: input.dynamic.hideComments }),
      ...(input.dynamic?.wooCommerceCatalog === undefined ? {} : { wooCommerceCatalog: input.dynamic.wooCommerceCatalog }),
    });
    outputFiles.push({ path: page.outputPath, bytes: Buffer.from(rewritten, "utf8") });
  }
  for (const asset of assets) {
    let bytes = asset.bytes;
    if (/text\/css/iu.test(asset.contentType) || /\.css$/iu.test(asset.outputPath)) {
      const replacements = new Map<string, string>();
      try {
        for (const raw of collectCssUrls(bytes.toString("utf8"))) {
          let target: URL;
          try { target = new URL(raw, asset.finalUrl); } catch { continue; }
          const mapped = filesByUrl.get(canonicalKey(urlWithoutQuery(target)));
          if (mapped) replacements.set(raw, `${relativeUrl(asset.outputPath, mapped)}${target.search}${target.hash}`);
        }
        bytes = Buffer.from(rewriteCssUrls(bytes.toString("utf8"), replacements), "utf8");
      } catch { addFinding(findings, "css-parse-failed", "warn", asset.outputPath, "Il foglio CSS non è stato riscritto completamente."); }
    }
    if (/\.json$|\.webmanifest$/iu.test(asset.outputPath) || /application\/(?:manifest\+json|json)/iu.test(asset.contentType)) {
      try {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        bytes = Buffer.from(`${JSON.stringify(rewriteJsonAsset(value, asset.finalUrl, asset.outputPath, filesByUrl), null, 2)}\n`, "utf8");
      } catch { addFinding(findings, "json-asset-parse-failed", "warn", asset.outputPath, "Il file JSON non è stato riscritto perché non è valido."); }
    }
    outputFiles.push({ path: asset.outputPath, bytes });
  }

  const sitemapUrls = pages.map((page) => new URL(page.outputPath.split("/").map(encodeURIComponent).join("/"), `${destinationOrigin}/`).href).sort();
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapUrls.map((url) => `<url><loc>${xmlEscape(url)}</loc></url>`).join("")}</urlset>\n`;
  const robotsSitemap = new URL("/sitemap.xml", destinationOrigin).href;
  const generatedRobots = `User-agent: *\nAllow: /\nSitemap: ${robotsSitemap}\n`;
  const reserved = new Set(["sitemap.xml", "robots.txt", "_redirects", "_headers"]);
  for (const pathName of reserved) {
    if (outputFiles.some((file) => file.path.toLowerCase() === pathName)) {
      addFinding(findings, "reserved-generated-file", "warn", pathName, "Il file sorgente è stato sostituito dal file necessario alla navigazione del bundle.");
      for (let index = outputFiles.length - 1; index >= 0; index -= 1) if (outputFiles[index]?.path.toLowerCase() === pathName) outputFiles.splice(index, 1);
    }
  }
  outputFiles.push({ path: "sitemap.xml", bytes: Buffer.from(sitemapXml, "utf8") });
  outputFiles.push({ path: "robots.txt", bytes: Buffer.from(generatedRobots, "utf8") });
  if (finalRedirects.length > 0) outputFiles.push({ path: "_redirects", bytes: Buffer.from(`${finalRedirects.map((item) => `${item.from} ${item.to} ${item.status}`).join("\n")}\n`, "utf8") });
  if (new URL(destinationOrigin).hostname.endsWith(".workers.dev")) outputFiles.push({ path: "_headers", bytes: Buffer.from("/*\n  X-Robots-Tag: noindex\n", "utf8") });
  emit({ type: "progress", phase: "rewrite", completed: pages.length, total: pages.length });

  const findingsFromScanner = scanFiles(outputFiles.map((file) => ({ path: file.path, size: file.bytes.byteLength, contents: file.bytes })));
  findings.push(...findingsFromScanner);
  const uniqueFindings = [...new Map(findings.map((finding) => [`${finding.code}\u0000${finding.file}\u0000${finding.line ?? 0}`, finding])).values()]
    .sort((left, right) => left.file.localeCompare(right.file, "en") || left.code.localeCompare(right.code, "en"));
  const uniqueDynamic = [...new Map(dynamicFeatures.map((feature) => [dynamicFeatureKey(feature), feature])).values()]
    .sort((left, right) => left.file.localeCompare(right.file, "en") || left.code.localeCompare(right.code, "en"));
  const report: CrawlReport = {
    engine,
    sourceUrl: safeDisplayUrl(source),
    pagesDiscovered: discovered.size,
    pagesDownloaded,
    assetsDownloaded,
    pagesSkipped: [...new Set(skipped)].sort(),
    cache: client.counters,
    signals: [...signals].sort(),
    technologies: [...technologies].sort(),
    dynamicFeatures: uniqueDynamic,
    redirects: finalRedirects,
  };
  outputFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { files: outputFiles, skipped: report.pagesSkipped, findings: uniqueFindings, report, redirects: finalRedirects };
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
