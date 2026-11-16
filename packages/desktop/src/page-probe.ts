import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { HistosPublishError } from "@histos-publish/core";
import type { OpenPageProbe } from "@histos-publish/server";

/**
 * Doc 17 item 4: the browser of the prototype check's preview (checkBuiltPages). The pages are the prototype's, built,
 * and treated as any site's: a hidden sandboxed window without preload, of its own session, with no permission, no
 * download, no new window, no navigation and no request outside the bundle's server on 127.0.0.1 (a dead proxy for any
 * other address too). Scripts run, as on the published site: the menu and the rest are measured as a visitor sees them.
 *
 * V1.6, threat model T32: with `site`, the pages of the linked WordPress («Verifica nel browser»), opened by signed
 * preview links. The same window, without the dead proxy, and still no request outside the site's origin: no CDN, no
 * third party, so the link's token cannot leave even by mistake. The check runs in a world of its own
 * (executeJavaScriptInIsolatedWorld): the page's scripts cannot touch it, and the CSP a preview of untrusted content
 * sends (`script-src 'none'`) stays as it is and still stops the page's own scripts, not axe's messages.
 */
const SITE_WORLD = 1_016;

export const createElectronPageProbe: OpenPageProbe = async ({ origin, signal, site }) => {
  if (site) {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) throw new HistosPublishError("Origine del sito non valida per la verifica nel browser.", "verify-origin-invalid", 2);
  }
  const partition = `histos-verify-${randomUUID()}`;
  const isolated = session.fromPartition(partition, { cache: false });
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    useContentSize: true,
    webPreferences: {
      partition,
      // Offscreen: a hidden window of the desktop is not laid out at every size reliably (render-compare.ts).
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  const destroy = (): void => { if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener("abort", destroy, { once: true });
  const inside = (target: string) => target.startsWith(`${origin}/`);
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: !inside(details.url) && !details.url.startsWith("data:") && !details.url.startsWith("blob:") }));
  if (!site) await isolated.setProxy({ proxyRules: "http://127.0.0.1:9" });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (!inside(target)) event.preventDefault(); });
  window.webContents.on("will-redirect", (event, target) => { if (!inside(target)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  return {
    probe: async ({ url, width, height, expression }) => {
      if (window.isDestroyed()) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
      window.setContentSize(width, height);
      await window.loadURL(url);
      return site ? window.webContents.executeJavaScriptInIsolatedWorld(SITE_WORLD, [{ code: expression }]) : window.webContents.executeJavaScript(expression);
    },
    close: async () => {
      signal.removeEventListener("abort", destroy);
      destroy();
      await isolated.clearStorageData().catch(() => undefined);
    },
  };
};
