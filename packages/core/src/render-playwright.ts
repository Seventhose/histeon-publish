import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Route } from "playwright-core";
import { HistosPublishError } from "./errors.js";
import type { RenderPage, RenderPageContext, RenderedPage } from "./types.js";

function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const fromPath = (names: string[]): string[] => (env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap((directory) => names.map((name) => path.join(directory, name)));
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const programFiles = env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    return [
      env.HISTOS_PUBLISH_BROWSER ?? "",
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Chromium", "Application", "chrome.exe"),
      ...fromPath(["chrome.exe", "chromium.exe"]),
    ];
  }
  if (platform === "darwin") return [
    env.HISTOS_PUBLISH_BROWSER ?? "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ...fromPath(["google-chrome", "chromium", "chrome"]),
  ];
  return [env.HISTOS_PUBLISH_BROWSER ?? "", ...fromPath(["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"])];
}

export async function findSystemBrowser(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  for (const candidate of browserCandidates(platform, env, home)) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* Continue through system browser locations. */ }
  }
  throw new HistosPublishError("Modalità render: non trovo Chrome o Chromium installato. Installa un browser supportato oppure imposta HISTOS_PUBLISH_BROWSER.", "render-browser-missing", 5);
}

function safeResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["content-type", "content-language", "location", "cache-control", "content-security-policy", "x-content-type-options", "referrer-policy"]) {
    const value = headers[name];
    if (typeof value === "string") output[name] = value;
    else if (Array.isArray(value)) output[name] = value.join(", ");
  }
  return output;
}

async function fulfillSafeRoute(route: Route, context: RenderPageContext, requested: Set<string>, budget: { requests: number; bytes: number }): Promise<void> {
  const request = route.request();
  let url: URL;
  try { url = new URL(request.url()); }
  catch { await route.abort("blockedbyclient"); return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") { await route.abort("blockedbyclient"); return; }
  requested.add(JSON.stringify({ url: url.href, type: request.resourceType() }));
  budget.requests += 1;
  if (budget.requests > context.maxRequests) { await route.abort("blockedbyclient"); return; }
  const type = request.resourceType();
  const maxResourceBytes = type === "document" ? context.maxBytes : 25 * 1024 * 1024;
  try {
    const response = await context.fetchResource(url.href, maxResourceBytes);
    budget.bytes += response.body.byteLength;
    if (budget.bytes > context.maxBytes * 4) { await route.abort("blockedbyclient"); return; }
    await route.fulfill({ status: response.status || 502, headers: safeResponseHeaders(response.headers), body: response.body });
  } catch {
    await route.abort(context.signal.aborted ? "aborted" : "blockedbyclient");
  }
}

/** The environment the crawl browser gets: the process environment without anything that looks like a secret. */
export function browserEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || /^(?:HISTOS_|CLOUDFLARE_|CF_)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|(?:^|_)KEY(?:$|_)/iu.test(name)) continue;
    output[name] = value;
  }
  return output;
}

export interface PlaywrightRenderSession {
  renderPage: RenderPage;
  close(): Promise<void>;
}

/** Explicit opt-out for hosts where Chromium's sandbox cannot start (containers without user namespaces). */
export const RENDER_NO_SANDBOX_ENV = "HISTOS_PUBLISH_RENDER_NO_SANDBOX";

/**
 * Chromium for hostile pages, with its OS sandbox. `loopback`: the browser may reach 127.0.0.1 (the prototype check's
 * own server, prototype verify), every other address still goes to the dead proxy.
 */
export async function launchCrawlBrowser(executablePath: string, options: { loopback?: boolean } = {}): Promise<Browser> {
  const launch = (chromiumSandbox: boolean) => chromium.launch({
    headless: true,
    // Crawled script is hostile: keep Chromium's OS sandbox (Playwright turns it off unless asked), and give the
    // browser no Histeon, Cloudflare or other secret from this process's environment.
    chromiumSandbox,
    env: browserEnvironment(process.env),
    executablePath,
    // Every request is answered by the routes below. A dead proxy (loopback included) catches what Chromium would
    // still open on its own, such as speculative preconnects, and WebRTC may not send UDP outside that proxy.
    args: [
      "--disable-dev-shm-usage",
      "--proxy-server=http://127.0.0.1:9",
      ...(options.loopback ? [] : ["--proxy-bypass-list=<-loopback>"]),
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  try {
    return await launch(true);
  } catch (error) {
    if (process.env[RENDER_NO_SANDBOX_ENV] === "1") {
      process.stderr.write(`Attenzione: la sandbox di Chromium non parte su questo sistema e ${RENDER_NO_SANDBOX_ENV}=1 la disattiva. Il codice delle pagine scansionate gira senza isolamento del sistema operativo.\n`);
      return await launch(false);
    }
    throw new HistosPublishError(
      `La modalità render ha bisogno della sandbox di Chromium, che su questo sistema non parte (spesso: user namespace non disponibili o bloccati da AppArmor). Abilitala, oppure, solo per siti di cui ti fidi, imposta ${RENDER_NO_SANDBOX_ENV}=1. Dettaglio: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      "render-sandbox-unavailable",
      5,
    );
  }
}

export async function createPlaywrightRenderSession(options: { executablePath?: string; browser?: Browser } = {}): Promise<PlaywrightRenderSession> {
  const browser = options.browser ?? await launchCrawlBrowser(options.executablePath ?? await findSystemBrowser());
  const ownsBrowser = options.browser === undefined;
  const contexts = new Set<BrowserContext>();
  const renderPage: RenderPage = async (input) => {
    if (input.signal.aborted) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    contexts.add(context);
    const requested = new Set<string>();
    const budget = { requests: 0, bytes: 0 };
    // Crawled script is hostile: every HTTP request of the context goes through fetchResource (SafeHttpClient),
    // WebSockets and WebRTC are refused, and popups are closed, so nothing reaches the network around that policy.
    await context.route("**/*", (route) => fulfillSafeRoute(route, input, requested, budget));
    await context.routeWebSocket(/.*/u, (socket) => { void socket.close({ code: 1008, reason: "blocked" }); });
    await context.addInitScript(() => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
        try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch { /* Already absent. */ }
      }
    });
    const page = await context.newPage();
    context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => undefined); });
    const abort = () => { void page.close().catch(() => undefined); };
    input.signal.addEventListener("abort", abort, { once: true });
    let idleTimedOut = false;
    try {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      try { await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, input.timeoutMs) }); }
      catch { idleTimedOut = true; }
      if (input.signal.aborted) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
      const html = await page.content();
      const finalUrl = page.url();
      return {
        html,
        finalUrl,
        requests: [...requested].map((value) => JSON.parse(value) as { url: string; type: string }),
        idleTimedOut,
      } satisfies RenderedPage;
    } finally {
      input.signal.removeEventListener("abort", abort);
      contexts.delete(context);
      await context.close().catch(() => undefined);
    }
  };
  return {
    renderPage,
    async close() {
      await Promise.all([...contexts].map((context) => context.close().catch(() => undefined)));
      if (ownsBrowser) await browser.close();
    },
  };
}
