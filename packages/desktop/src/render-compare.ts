import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { HistosPublishError, type CompareRenders, type RenderComparison, type RenderComparisonInput } from "@histos-publish/core";
import { differentPixels } from "./pixel-diff.js";

/** The photographs stop here: a longer page is compared on its first 6,000 pixels. */
export const COMPARE_MAX_HEIGHT = 6000;
/**
 * Doc 23 item 101: the screenshot check of the utility conversion. Both documents come from the importer and hold only
 * sanitized markup and the site's CSS, yet they are treated as hostile like any page of a site: a hidden sandboxed
 * window of its own session, scripts off (in the preferences and again through the protocol), every request refused
 * (images and fonts stay missing on both sides alike), no permission, no download, no navigation, no new window.
 */
export const createElectronCompareRenders: CompareRenders = async (input: RenderComparisonInput): Promise<RenderComparison[]> => {
  const partition = `histos-compare-${randomUUID()}`;
  const isolated = session.fromPartition(partition, { cache: false });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition,
      javascript: false,
      // Offscreen: a hidden window of the desktop is not painted reliably, and capturePage fails on it.
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  const debug = window.webContents.debugger;
  const abortWindow = (): void => { if (!window.isDestroyed()) window.destroy(); };
  input.signal.addEventListener("abort", abortWindow, { once: true });
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: details.url !== "about:blank" }));
  await isolated.setProxy({ proxyRules: "http://127.0.0.1:9", proxyBypassRules: "<-loopback>" });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const cancelled = (): never => { throw new HistosPublishError("Operazione annullata.", "cancelled", 6); };
  try {
    await window.loadURL("about:blank");
    if (input.signal.aborted || window.isDestroyed()) cancelled();
    debug.attach("1.3");
    debug.on("message", (_event, method, params) => {
      if (method !== "Fetch.requestPaused") return;
      const requestId = (params as { requestId?: string }).requestId;
      if (requestId) void debug.sendCommand("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
    });
    await debug.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await debug.sendCommand("Emulation.setScriptExecutionDisabled", { value: true });
    await debug.sendCommand("Page.enable");
    const tree = await debug.sendCommand("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
    const frameId = tree.frameTree.frame.id;
    const photograph = async (html: string, width: number): Promise<{ width: number; height: number; data: Uint8Array }> => {
      window.setContentSize(width, 900);
      await debug.sendCommand("Page.setDocumentContent", { frameId, html });
      // Frames for style and layout; missing images and fonts fail at once, refused above.
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (input.signal.aborted || window.isDestroyed()) cancelled();
      const metrics = await debug.sendCommand("Page.getLayoutMetrics") as { cssContentSize?: { height: number } };
      const height = Math.max(1, Math.min(COMPARE_MAX_HEIGHT, Math.ceil(metrics.cssContentSize?.height ?? 900)));
      window.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (input.signal.aborted || window.isDestroyed()) cancelled();
      const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
      const size = image.getSize();
      return { width: size.width, height: size.height, data: image.toBitmap() };
    };
    const results: RenderComparison[] = [];
    for (const width of input.widths) {
      const before = await photograph(input.before, width);
      const after = await photograph(input.after, width);
      results.push({ width, height: Math.max(before.height, after.height), ...differentPixels(before, after) });
    }
    return results;
  } finally {
    input.signal.removeEventListener("abort", abortWindow);
    if (!window.isDestroyed()) {
      if (debug.isAttached()) debug.detach();
      window.destroy();
    }
    isolated.clearStorageData().catch(() => undefined);
  }
};
