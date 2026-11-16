import { randomUUID } from "node:crypto";
import { BrowserWindow, session, type Session } from "electron";
import { HistosPublishError, type RenderPage, type RenderPageContext, type RenderedPage, type RenderedRequest } from "@histos-publish/core";

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string };
  resourceType: string;
  responseStatusCode?: number;
}

function sameSiteOrigin(left: string, right: URL): boolean {
  try { return new URL(left).origin === right.origin; } catch { return false; }
}

function safeHeaders(headers: Record<string, string | string[] | undefined>): Array<{ name: string; value: string }> {
  const allowed = new Set(["content-type", "content-language", "location", "cache-control", "etag", "last-modified", "content-security-policy", "x-content-type-options", "referrer-policy", "set-cookie"]);
  return Object.entries(headers).flatMap(([name, value]) => {
    if (!allowed.has(name.toLowerCase()) || value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((item) => ({ name, value: item }));
  });
}

function waitForNetworkIdle(active: Set<string>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let quietSince = active.size === 0 ? Date.now() : 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => {
      if (pollTimer) clearInterval(pollTimer);
      if (capTimer) clearTimeout(capTimer);
      signal.removeEventListener("abort", abort);
    };
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(timedOut);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HistosPublishError("Operazione annullata.", "cancelled", 6));
    };
    signal.addEventListener("abort", abort, { once: true });
    capTimer = setTimeout(() => finish(true), timeoutMs);
    pollTimer = setInterval(() => {
      if (active.size > 0) {
        quietSince = 0;
      } else if (quietSince === 0) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 500) {
        finish(false);
      }
    }, 100);
    if (signal.aborted) abort();
  });
}

export const createElectronRenderPage: RenderPage = async (input: RenderPageContext): Promise<RenderedPage> => {
  const partition = `histos-render-${randomUUID()}`;
  const isolatedSession: Session = session.fromPartition(partition, { cache: false });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  const debug = window.webContents.debugger;
  const activeRequests = new Set<string>();
  const requests = new Map<string, RenderedRequest>();
  const pending = new Set<Promise<void>>();
  const budget = { bytes: 0, requests: 0 };
  const allowedOrigin = new URL(input.url);
  let alive = true;

  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.on("will-download", (event) => event.preventDefault());
  isolatedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let protocol = "";
    try { protocol = new URL(details.url).protocol; } catch { /* Block malformed protocol URLs. */ }
    callback(protocol === "http:" || protocol === "https:" ? {} : { cancel: true });
  });
  // Every request is fulfilled through the Fetch domain below. A dead proxy (loopback included) catches what Chromium
  // would still open on its own, such as speculative preconnects, and WebRTC may not send UDP outside that proxy.
  await isolatedSession.setProxy({ proxyRules: "http://127.0.0.1:9", proxyBypassRules: "<-loopback>" });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, target) => {
    if (!sameSiteOrigin(target, allowedOrigin)) event.preventDefault();
  });

  const abortWindow = (): void => { alive = false; if (!window.isDestroyed()) window.destroy(); };
  input.signal.addEventListener("abort", abortWindow, { once: true });

  try {
    debug.attach("1.3");
    debug.on("message", (_event, method, params) => {
      if (method === "Network.requestWillBeSent") {
        const value = params as { requestId?: string; request?: { url?: string } };
        if (value.requestId && value.request?.url) activeRequests.add(value.requestId);
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        const value = params as { requestId?: string };
        if (value.requestId) activeRequests.delete(value.requestId);
      } else if (method === "Fetch.requestPaused") {
        const value = params as PausedRequest;
        const task = (async () => {
          if (!alive || input.signal.aborted) {
            await debug.sendCommand("Fetch.failRequest", { requestId: value.requestId, errorReason: "Aborted" }).catch(() => undefined);
            return;
          }
          let target: URL;
          try { target = new URL(value.request.url); }
          catch {
            await debug.sendCommand("Fetch.failRequest", { requestId: value.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
            return;
          }
          if ((value.request.method !== "GET" && value.request.method !== "HEAD") || (target.protocol !== "http:" && target.protocol !== "https:")) {
            await debug.sendCommand("Fetch.failRequest", { requestId: value.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
            return;
          }
          budget.requests += 1;
          if (budget.requests > input.maxRequests) {
            await debug.sendCommand("Fetch.failRequest", { requestId: value.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
            return;
          }
          requests.set(`${value.resourceType}\u0000${target.href}`, { url: target.href, type: value.resourceType });
          try {
            const response = await input.fetchResource(target.href, value.resourceType === "Document" ? input.maxBytes : 25 * 1024 * 1024);
            budget.bytes += response.body.byteLength;
            if (budget.bytes > input.maxBytes * 4) throw new HistosPublishError("Le risorse della pagina superano il limite di render.", "render-response-too-large", 2);
            await debug.sendCommand("Fetch.fulfillRequest", {
              requestId: value.requestId,
              responseCode: response.status || 502,
              responseHeaders: safeHeaders(response.headers),
              body: response.body.toString("base64"),
            });
          } catch {
            await debug.sendCommand("Fetch.failRequest", { requestId: value.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
          }
        })().finally(() => pending.delete(task));
        pending.add(task);
      }
    });
    await debug.sendCommand("Network.enable");
    await debug.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await debug.sendCommand("Page.enable");
    await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: "for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) { try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {} }",
    });
    await window.loadURL(input.url);
    if (!alive || input.signal.aborted) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
    const idleTimedOut = await waitForNetworkIdle(activeRequests, Math.min(15_000, input.timeoutMs), input.signal);
    const html = await window.webContents.executeJavaScript("document.documentElement ? document.documentElement.outerHTML : ''") as string;
    const finalUrl = window.webContents.getURL();
    return { html: `<!doctype html>${html}`, finalUrl, requests: [...requests.values()], idleTimedOut };
  } finally {
    alive = false;
    input.signal.removeEventListener("abort", abortWindow);
    for (const task of pending) await task.catch(() => undefined);
    if (debug.isAttached()) debug.detach();
    if (!window.isDestroyed()) window.destroy();
    isolatedSession.clearStorageData().catch(() => undefined);
  }
};
