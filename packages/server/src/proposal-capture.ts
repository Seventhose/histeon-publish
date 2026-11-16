import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { capturedPageName, capturedSiteFiles, readRenderedCapture, RENDERED_CAPTURE_MAX_BYTES, RENDERED_CAPTURE_MAX_PAGES, renderedCaptureExpression, type CapturedSite, type RenderedCaptureOptions } from "@histos-publish/cms";
import { HistosPublishError } from "@histos-publish/core";
import type { OpenPageProbe, PageProbe } from "./prototype-verify.js";

/**
 * «Fotografa la proposta» without the person: the pages of a proposal drawn by scripts, captured in the caller's
 * browser (OpenPageProbe: the hidden window of the desktop app, Playwright in the CLI) and returned as the static site
 * the importer reads. The proposal's file is served alone on 127.0.0.1 for the time of the capture; its scripts run
 * only in that browser, which reaches nothing but this server (the network stays closed: a script, an image or a font
 * of another site does not load). Each page is told by the fragment of the viewer's address («#p03/home»).
 */

/** The proposal's file, as the capture serves it. */
const PROPOSAL_PATH = "/proposta.html";
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 900;
const PAGE_TIMEOUT_MS = 45_000;
const BROWSER_TIMEOUT_MS = 20_000;

/**
 * Inline scripts and eval run as in a browser (the proposal is the person's own file), inside a browser that reaches
 * only this server; nothing is sent anywhere (no connection, no form), nothing of another site is loaded.
 */
export const PROPOSAL_CAPTURE_CSP = "default-src 'self' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export interface ProposalCapturePage {
  /** The fragment of the viewer's address that shows the page («#p03/home»), or "" for the file as it opens. */
  hash: string;
  /** The page's name; proposed from the fragment and the title when not given. */
  name?: string;
}

export interface ProposalCaptureOptions extends Pick<RenderedCaptureOptions, "root" | "rootSelector" | "remove" | "settleMs"> {
  /** The width of the window the proposal is drawn in (1280 when not given). */
  width?: number;
  signal?: AbortSignal;
  pageTimeoutMs?: number;
}

export interface ProposalCaptured {
  /** The static site of the captured pages, links between them included. */
  site: CapturedSite;
  pages: Array<{ name: string; path: string; hash: string; title: string; bytes: number; height: number; frame: boolean; links: number; notes: string[] }>;
  /** What the person should know: the site's notes, then what the proposal asked of the network. */
  notes: string[];
}

const refused = (message: string): HistosPublishError => new HistosPublishError(message, "proposal-capture-invalid", 2);

/** The fragment as given by a person or an agent: empty, or `#` and what follows, without spaces or control characters. */
export function captureFragment(value: string): string {
  const hash = value.trim();
  if (hash === "" || hash === "#") return "";
  if (!hash.startsWith("#") || hash.length > 500 || /[\s\p{Cc}]/u.test(hash)) throw refused(`«${hash.slice(0, 80)}» non è il frammento di un indirizzo: comincia con # e non ha spazi (per esempio #p03/home).`);
  return hash;
}

/** The hosts whose scripts the proposal loads: with the network closed they do not run, and the page may stay empty. */
function remoteScriptHosts(html: string): string[] {
  const hosts = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
    const source = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!/^(?:https?:)?\/\//iu.test(source)) continue;
    try { hosts.add(new URL(source, "https://x.invalid/").host); } catch { /* not an address */ }
  }
  return [...hosts].slice(0, 8);
}

/** The file alone on 127.0.0.1 (a port of the system): GET and HEAD of its one address, from that host name only. */
async function serveProposalFile(bytes: Uint8Array): Promise<{ origin: string; close(): Promise<void> }> {
  let host = "";
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    let pathname = "";
    try { pathname = new URL(request.url ?? "/", `http://${host}`).pathname; } catch { pathname = ""; }
    if ((request.method !== "GET" && request.method !== "HEAD") || request.headers.host !== host || pathname !== PROPOSAL_PATH) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Non trovato.");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(bytes.byteLength), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": PROPOSAL_CAPTURE_CSP });
    response.end(request.method === "HEAD" ? undefined : bytes);
  };
  const server = createServer(answer);
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

function withTimeout<T>(task: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, ms);
  });
  return Promise.race([task, late]).finally(() => clearTimeout(timer));
}

/** True when a captured document shows almost nothing: no text to speak of, no image, no drawing. */
function looksEmpty(html: string): boolean {
  const body = html.slice(Math.max(0, html.search(/<body[\s>]/iu)));
  if (/<(?:img|svg|picture|video|canvas)\b/iu.test(body)) return false;
  return body.replace(/<style\b[\s\S]*?<\/style>/giu, "").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim().length < 40;
}

/**
 * Captures `pages` of the proposal in `file` (one page, the file as it opens, when the list is empty). A page that
 * cannot be captured stops everything: a site with a page missing is not what the person asked for.
 */
export async function captureProposal(file: { name: string; bytes: Uint8Array }, pages: readonly ProposalCapturePage[], openProbe: OpenPageProbe, options: ProposalCaptureOptions = {}): Promise<ProposalCaptured> {
  if (file.bytes.byteLength < 1) throw refused(`${file.name}: il file è vuoto.`);
  if (file.bytes.byteLength > RENDERED_CAPTURE_MAX_BYTES) throw refused(`${file.name}: il file supera ${RENDERED_CAPTURE_MAX_BYTES / 1024 / 1024} MB.`);
  if (pages.length > RENDERED_CAPTURE_MAX_PAGES) throw refused(`Una proposta porta al più ${RENDERED_CAPTURE_MAX_PAGES} pagine.`);
  const wanted = (pages.length ? pages : [{ hash: "" }]).map((page) => ({ hash: captureFragment(page.hash), name: (page.name ?? "").replace(/\s+/gu, " ").trim().slice(0, 80) }));
  const width = Math.round(Math.max(320, Math.min(2560, options.width ?? CAPTURE_WIDTH)));
  const expression = renderedCaptureExpression({ ...(options.root ? { root: options.root } : {}), ...(options.rootSelector ? { rootSelector: options.rootSelector } : {}), ...(options.remove ? { remove: options.remove } : {}), ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}) });
  const served = await serveProposalFile(file.bytes);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const captured: Array<{ name: string; hash: string; html: string; title: string; height: number; frame: boolean; notes: string[] }> = [];
  let probe: PageProbe | undefined;
  try {
    let browser: PageProbe;
    try {
      browser = await withTimeout(openProbe({ origin: served.origin, signal: controller.signal }), BROWSER_TIMEOUT_MS, controller);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new HistosPublishError(`Il browser per fotografare la proposta non è partito${error instanceof Error && error.message !== "timeout" ? ` (${error.message.slice(0, 200)})` : ""}.`, "proposal-capture-browser", 5);
    }
    probe = browser;
    for (const [index, page] of wanted.entries()) {
      options.signal?.throwIfAborted();
      // A query of its own for each page: the same file at another fragment would not load again.
      const url = `${served.origin}${PROPOSAL_PATH}?pagina=${index + 1}${encodeURI(page.hash)}`;
      const label = page.hash || "iniziale";
      const pageController = new AbortController();
      const stop = (): void => pageController.abort();
      controller.signal.addEventListener("abort", stop, { once: true });
      let value: unknown;
      try {
        value = await withTimeout(browser.probe({ url, width, height: CAPTURE_HEIGHT, expression, signal: pageController.signal }), options.pageTimeoutMs ?? PAGE_TIMEOUT_MS, pageController);
      } catch (error) {
        options.signal?.throwIfAborted();
        const reason = error instanceof Error ? (error.message === "timeout" ? "non si è aperta in tempo" : `non si è aperta (${(error.message.split("\n")[0] ?? "").slice(0, 160)})`) : "non si è aperta";
        throw new HistosPublishError(`Pagina ${label}: ${reason}.`, "proposal-capture-failed", 5);
      } finally {
        controller.signal.removeEventListener("abort", stop);
      }
      let capture: ReturnType<typeof readRenderedCapture>;
      try {
        capture = readRenderedCapture(value, options.rootSelector ? { rootSelector: options.rootSelector } : {});
      } catch (error) {
        throw new HistosPublishError(`Pagina ${label}: ${error instanceof Error ? error.message : "cattura non riuscita."}`, "proposal-capture-failed", 2);
      }
      const notes = [...capture.notes];
      if (looksEmpty(capture.html)) notes.push("la pagina fotografata è quasi vuota: controlla il frammento, o se la proposta carica i suoi script dalla rete");
      // The fragment the viewer settled on is the one its links use; the one asked for when it keeps none.
      const hash = capture.hash || page.hash;
      captured.push({ name: page.name || capturedPageName({ hash, title: capture.title, index }), hash, html: capture.html, title: capture.title, height: capture.height, frame: capture.frame, notes });
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await probe?.close().catch(() => undefined);
    await served.close();
  }
  const site = capturedSiteFiles(captured.map((page) => ({ name: page.name, hash: page.hash, html: page.html })));
  const hosts = remoteScriptHosts(new TextDecoder().decode(file.bytes));
  return {
    site,
    pages: captured.map((page, index) => ({ name: site.pages[index]?.name ?? page.name, path: site.pages[index]?.path ?? "", hash: page.hash, title: page.title, bytes: site.files[index]?.bytes.byteLength ?? 0, height: page.height, frame: page.frame, links: site.pages[index]?.links ?? 0, notes: page.notes })),
    notes: [...site.notes, ...(hosts.length ? [`la proposta carica script da ${hosts.join(", ")}: qui la rete è chiusa e non sono partiti`] : [])],
  };
}
