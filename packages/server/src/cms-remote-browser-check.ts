import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";
import type { CmsRemoteCatalog, CmsRemoteSecretStore } from "./cms-remote-catalog.js";
import { siteText } from "./cms-remote-check.js";
import { REMOTE_NAMESPACE, requestRemote, validateCapabilities } from "./cms-remote-transport.js";
import { readStoredSecret } from "./cms-remote.js";
import { probePages, type AxeScript, type BrowserCheck, type OpenPageProbe } from "./prototype-verify.js";

/**
 * V1.6, threat model T32: «Verifica nel browser» of «Controlla il sito WP». The linked site gives, with the read
 * permission, signed preview links of the pages that change in development (`GET /preview-links`, at most 20, seen as
 * a visitor without an account, valid 10 minutes); Publish opens them in its hidden window, which loads from the
 * site's origin only, runs the prototypes' axe at the same two widths, and probes itself the external links of those
 * pages (never the WordPress server): public addresses only, headers only, no cookie and no token, no redirect followed.
 *
 * The signed links are credentials: they stay in this module's memory, and never reach the result, a log, an error or
 * the disk. The result names a page by its address without the token (`page`), and every text of it passes through
 * withoutTokens() all the same.
 */

export const PREVIEW_PARAM = "xb_preview";
const MAX_PREVIEW_PAGES = 20;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_ADDRESS = 2048;
export const MAX_EXTERNAL_LINKS = 200;
const LINKS_TOGETHER = 4;
const LINK_TIMEOUT_MS = 5_000;
const LINKS_KEPT = 50;
const LINK_PAGES_KEPT = 5;

export interface PreviewLinkPage {
  /** The site's document (`post:<id>`), plain text. */
  doc: string;
  title: string;
  /** The page's address without the token: the one shown and kept. */
  page: string;
  /** The signed link: in memory only. */
  url: string;
}

export interface PreviewLinks {
  pages: PreviewLinkPage[];
  skipped: number;
  expires: number;
}

export type ExternalLinkOutcome = "ok" | "broken" | "unreachable" | "untested";

export interface ExternalLinkResult {
  url: string;
  outcome: ExternalLinkOutcome;
  /** The HTTP status, when the site answered. */
  status?: number;
}

export interface ExternalLinkReport {
  url: string;
  status?: number;
  /** The pages it is on (at most 5), by address without the token. */
  pages: string[];
}

export interface RemoteBrowserCheck extends Omit<BrowserCheck, "links" | "note"> {
  checkedAt: string;
  host: string;
  /** The pages the site gave, in its order, without the token. */
  pages: Array<{ doc: string; title: string; page: string }>;
  /** Pages that change in development the site left out (over its 20). */
  skipped: number;
  links: {
    /** External links found in the opened pages, without repeats. */
    found: number;
    /** Probed: at most MAX_EXTERNAL_LINKS. */
    checked: number;
    broken: ExternalLinkReport[];
    unreachable: ExternalLinkReport[];
    untested: ExternalLinkReport[];
  };
}

/** One external link probed: the HTTP status the site answered, or an error (HistosPublishError with its code). */
export type LinkProbe = (url: string, signal: AbortSignal) => Promise<{ status: number }>;

function invalid(reason: string): HistosPublishError {
  // The reason never quotes an address of the answer: it may carry a token.
  return new HistosPublishError(`Il sito ha dato link di anteprima non validi (${reason}): aggiorna Histeon sul sito e riprova.`, "cms-remote-preview-links-invalid", 502);
}

function siteAddress(value: unknown, origin: string, what: string): URL {
  if (typeof value !== "string" || value.length > MAX_ADDRESS) throw invalid(`${what} mancante o troppo lungo`);
  let address: URL;
  try { address = new URL(value); } catch { throw invalid(`${what} non è un indirizzo`); }
  if ((address.protocol !== "http:" && address.protocol !== "https:") || address.username || address.password || address.hash) throw invalid(`${what} non è un indirizzo http(s) semplice`);
  if (address.origin !== origin) throw invalid(`${what} è di un altro sito`);
  return address;
}

/**
 * The answer of `/preview-links`, checked strictly: at most 20 pages, `page` and `url` http(s) addresses of the
 * linked site's own origin, `url` exactly `page` plus the one `xb_preview` parameter, texts as siteText cuts them.
 * Anything else is an error that names no address.
 */
export function validatePreviewLinks(value: unknown, siteUrl: string): PreviewLinks {
  const origin = new URL(siteUrl).origin;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("risposta non leggibile");
  const answer = value as Record<string, unknown>;
  if (!Array.isArray(answer.pages)) throw invalid("manca l'elenco delle pagine");
  if (answer.pages.length > MAX_PREVIEW_PAGES) throw invalid(`più di ${MAX_PREVIEW_PAGES} pagine`);
  const skipped = answer.skipped ?? 0;
  if (typeof skipped !== "number" || !Number.isSafeInteger(skipped) || skipped < 0) throw invalid("numero delle pagine lasciate fuori");
  if (typeof answer.expires !== "number" || !Number.isSafeInteger(answer.expires)) throw invalid("scadenza");
  const seen = new Set<string>();
  const pages = answer.pages.map((item, index): PreviewLinkPage => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(`pagina ${index + 1}`);
    const entry = item as Record<string, unknown>;
    const page = siteAddress(entry.page, origin, `l'indirizzo della pagina ${index + 1}`);
    const url = siteAddress(entry.url, origin, `il link della pagina ${index + 1}`);
    if (page.searchParams.has(PREVIEW_PARAM)) throw invalid(`l'indirizzo della pagina ${index + 1} ha il gettone`);
    const tokens = url.searchParams.getAll(PREVIEW_PARAM);
    if (tokens.length !== 1 || !/^[0-9A-Za-z._-]{16,300}$/u.test(tokens[0] ?? "")) throw invalid(`il link della pagina ${index + 1} non ha un gettone solo`);
    const rest = [...url.searchParams].filter(([name]) => name !== PREVIEW_PARAM);
    const own = [...page.searchParams];
    if (url.pathname !== page.pathname || rest.length !== own.length || rest.some(([name, item], at) => own[at]?.[0] !== name || own[at]?.[1] !== item)) {
      throw invalid(`il link della pagina ${index + 1} non è la pagina col solo gettone`);
    }
    if (seen.has(page.href)) throw invalid(`la pagina ${index + 1} è ripetuta`);
    seen.add(page.href);
    return { doc: siteText(entry.doc, 80), title: siteText(entry.title, 160), page: page.href, url: url.href };
  });
  return { pages, skipped, expires: answer.expires };
}

/** `/preview-links` of the linked site, signed with the link's secret, validated. */
export async function readPreviewLinks(connection: { url: string }, secret: Buffer): Promise<PreviewLinks> {
  const response = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/preview-links`, new Uint8Array(), MAX_PREVIEW_BYTES);
  let value: unknown;
  try { value = JSON.parse(response.bytes.toString("utf8")) as unknown; } catch { throw invalid("risposta non JSON"); }
  return validatePreviewLinks(value, connection.url);
}

/**
 * Every text of a result without the signed links' tokens: the parameter with its value, each token as the site gave
 * it, and any run of 64 hex digits or more (a signature cut out of an address by axe's selectors).
 */
export function withoutTokens<T>(value: T, tokens: readonly string[]): T {
  const clean = (text: string): string => {
    let out = text;
    for (const token of tokens) for (const secret of [token, token.split(".").at(-1) ?? ""]) if (secret.length >= 16) out = out.split(secret).join("…");
    return out.replace(/xb_preview(=|%3D)[^\s&#"'<>)]*/giu, "xb_preview=…").replace(/[0-9a-f]{64,}/giu, "…");
  };
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === "string" ? clean(item) : item)) as T;
}

/**
 * The external links of the opened pages: http(s) of another origin than the site, without credentials in the address,
 * without repeats, at most MAX_EXTERNAL_LINKS. A link carrying a preview token or its signature (a share button built
 * from the page's own address) is never probed: the token would leave for another site.
 */
export function externalLinks(pages: ReadonlyArray<{ page: string; links: readonly string[] }>, siteOrigin: string, tokens: readonly string[]): { links: Array<{ url: string; pages: string[] }>; found: number } {
  // The token, and its signature alone too: with it, the rest of a token (expiry, post, user) is easy to guess.
  const secrets = tokens.flatMap((token) => [token, token.split(".").at(-1) ?? ""]).filter((secret) => secret.length >= 16);
  const byUrl = new Map<string, string[]>();
  for (const { page, links } of pages) {
    for (const raw of links) {
      let address: URL;
      try { address = new URL(raw); } catch { continue; }
      if ((address.protocol !== "http:" && address.protocol !== "https:") || address.username || address.password || address.origin === siteOrigin) continue;
      address.hash = "";
      let decoded = address.href;
      try { decoded = decodeURIComponent(address.href); } catch { /* the address as it is */ }
      if (/xb_preview/iu.test(decoded) || secrets.some((secret) => decoded.includes(secret) || address.href.includes(secret))) continue;
      const listed = byUrl.get(address.href) ?? [];
      if (!listed.includes(page)) listed.push(page);
      byUrl.set(address.href, listed);
    }
  }
  return { links: [...byUrl].slice(0, MAX_EXTERNAL_LINKS).map(([url, on]) => ({ url, pages: on })), found: byUrl.size };
}

/** The probe of a link from Publish: SafeHttpClient for its origin, public addresses only, headers only, 5 seconds. */
export const safeLinkProbe: LinkProbe = async (url, signal) => {
  const client = new SafeHttpClient({ origin: new URL(url).origin, userAgent: "HistosPublish-LinkCheck/1.0", timeoutMs: LINK_TIMEOUT_MS, delayMs: 0, publicOnly: true, strictOrigin: true, signal });
  const response = await client.probe(url);
  return { status: response.status };
};

/** 404 and 410 broken; 5xx, a network error or the time unreachable; a private or loopback address untested; the rest (3xx too: a redirect is not followed) fine. */
export function linkOutcome(answer: { status: number } | { error: unknown }): ExternalLinkResult["outcome"] {
  if ("status" in answer) return answer.status === 404 || answer.status === 410 ? "broken" : answer.status >= 500 ? "unreachable" : "ok";
  const code = answer.error instanceof HistosPublishError ? answer.error.code : "";
  return code === "crawl-private-network" || code === "crawl-url-invalid" || code === "crawl-cross-origin" ? "untested" : "unreachable";
}

/** Probes the links 4 at a time, each within 5 seconds; only a cancellation of `signal` stops them. */
export async function checkExternalLinks(links: readonly string[], probe: LinkProbe, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExternalLinkResult[]> {
  const results: ExternalLinkResult[] = new Array(links.length);
  const timeout = options.timeoutMs ?? LINK_TIMEOUT_MS;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < links.length) {
      options.signal?.throwIfAborted();
      const index = next++;
      const url = links[index]!;
      const controller = new AbortController();
      const stop = () => controller.abort();
      options.signal?.addEventListener("abort", stop, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HistosPublishError("La richiesta ha superato il tempo massimo.", "crawl-timeout", 5)); }, timeout); });
        const answer = await Promise.race([probe(url, controller.signal), late]);
        results[index] = { url, outcome: linkOutcome(answer), status: answer.status };
      } catch (error) {
        options.signal?.throwIfAborted();
        results[index] = { url, outcome: linkOutcome({ error }) };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINKS_TOGETHER, links.length) }, worker));
  return results;
}

/** The label of a page in the report: its path and query on the site, without the token. */
function pageLabel(page: string): string {
  const address = new URL(page);
  return `${address.pathname}${address.search}`;
}

export async function checkRemoteSiteInBrowser(
  input: { connectionId: string },
  catalog: CmsRemoteCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
  options: { openProbe: OpenPageProbe; axe: AxeScript | null; probeLink?: LinkProbe; signal?: AbortSignal; timeoutMs?: number },
): Promise<RemoteBrowserCheck> {
  const connection = catalog.get(input.connectionId);
  if (!connection) throw new HistosPublishError("Collegamento remoto non trovato.", "cms-remote-connection-missing", 404);
  if (!connection.read) {
    throw new HistosPublishError("Questo collegamento non permette di leggere il sito, e la verifica nel browser è una lettura: in WP crea un codice con la lettura e aggiorna il collegamento.", "cms-remote-read-scope-required", 403);
  }
  const secret = await readStoredSecret(storeFor, connection.id);
  const capabilities = validateCapabilities(JSON.parse((await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/capabilities`)).bytes.toString("utf8")) as unknown);
  if (capabilities.siteId !== connection.siteId) {
    throw new HistosPublishError("L'identità del sito è cambiata: ricollega il sito prima di controllarlo.", "cms-remote-site-changed", 409);
  }
  if (!capabilities.previewLinks) {
    throw new HistosPublishError("Il sito non sa ancora dare i link di anteprima per la verifica nel browser: aggiorna Histeon sul sito.", "cms-remote-preview-links-unavailable", 409);
  }
  const origin = new URL(connection.url).origin;
  const checkedAt = new Date().toISOString();
  const preview = await readPreviewLinks(connection, secret);
  const tokens = preview.pages.map((page) => new URL(page.url).searchParams.get(PREVIEW_PARAM) ?? "");
  const targets = preview.pages.map((page) => ({ page: pageLabel(page.page), url: page.url }));
  let check: BrowserCheck;
  if (!targets.length) check = { opened: 0, overflow: [], axe: [], links: [] };
  else if (!options.axe) check = { opened: 0, overflow: [], axe: [], links: [], failures: ["axe-core non è installato con l'app: accessibilità non controllata."] };
  else check = await probePages(targets, origin, options.openProbe, { axe: options.axe, site: true, links: true, ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const { links: pageLinks = [], note: _note, ...browser } = check;
  const external = externalLinks(pageLinks, origin, tokens);
  const probed = await checkExternalLinks(external.links.map((link) => link.url), options.probeLink ?? safeLinkProbe, options.signal ? { signal: options.signal } : {});
  const report = (outcome: ExternalLinkOutcome): ExternalLinkReport[] => probed
    .map((result, index) => ({ result, pages: external.links[index]?.pages ?? [] }))
    .filter(({ result }) => result.outcome === outcome)
    .slice(0, LINKS_KEPT)
    .map(({ result, pages }) => ({ url: result.url.slice(0, MAX_ADDRESS), ...(result.status !== undefined ? { status: result.status } : {}), pages: pages.slice(0, LINK_PAGES_KEPT) }));
  return withoutTokens({
    ...browser,
    checkedAt,
    host: new URL(connection.url).host,
    pages: preview.pages.map(({ doc, title, page }) => ({ doc, title, page })),
    skipped: preview.skipped,
    links: { found: external.found, checked: probed.length, broken: report("broken"), unreachable: report("unreachable"), untested: report("untested") },
  }, tokens);
}
