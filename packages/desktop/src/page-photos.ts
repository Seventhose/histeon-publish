import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { HistosPublishError } from "@histos-publish/core";
import { COMPARE_MAX_HEIGHT, type OpenPagePhotos } from "@histos-publish/server";

/**
 * «Uguale alla proposta»: the browser that photographs the captured proposal and the site built from it
 * (compareProposal). The pages are untrusted and are served still on 127.0.0.1, one port each (`origins`), with a
 * policy that runs none of their scripts. The window is hidden, sandboxed, without preload, of a session of its own
 * thrown away at the end: no permission, no download, no new window, no navigation outside `origins`.
 *
 * The only requests it lets out of `origins` are images, style sheets, fonts and media over https: a captured
 * proposal takes them from other sites, and without them the original would be photographed with holes the built
 * site does not have. It is what the frame the person browsed the proposal in already loaded. Nothing else leaves:
 * no script, no connection, no page.
 *
 * What is measured runs in a world of its own (executeJavaScriptInIsolatedWorld): the page's policy stays whole.
 */
const PHOTO_WORLD = 1_017;
const REMOTE_KINDS = new Set(["image", "stylesheet", "font", "media"]);
/** The window is as tall as a screen; a page is photographed in tiles of this height. */
const TILE = 900;

/**
 * Movement stops and what moves is shown at its end, so two photographs of the same page are the same. The window's
 * own scrollbar goes: it takes 15 pixels from the page, and «390 px» must be the 390 pixels a phone gives the page.
 */
const STILL_CSS = "*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;animation-play-state:running!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}html{scrollbar-width:none!important}";

/** Images asked at once and decoded, fonts ready (five seconds each at most); gives the height of the page. */
const SETTLE = `(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  for (const image of document.images) image.loading = "eager";
  await Promise.race([Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))), wait(5000)]);
  await Promise.race([document.fonts.ready, wait(5000)]);
  scrollTo(0, 0);
  const page = document.scrollingElement || document.documentElement;
  return page.scrollHeight;
})()`;

export const createElectronPagePhotos: OpenPagePhotos = async ({ origins, signal }) => {
  const allowed = origins.filter((origin) => /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(origin));
  if (!allowed.length || allowed.length !== origins.length) throw new HistosPublishError("Origine non valida per il confronto con la proposta.", "verify-origin-invalid", 2);
  const partition = `histos-photos-${randomUUID()}`;
  const isolated = session.fromPartition(partition, { cache: false });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: TILE,
    useContentSize: true,
    webPreferences: {
      partition,
      // Offscreen: a hidden window of the desktop is not painted reliably, and capturePage fails on it.
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
  const inside = (target: string) => allowed.some((origin) => target.startsWith(`${origin}/`));
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const url = details.url;
    const still = inside(url) || url.startsWith("data:") || url.startsWith("blob:") || (url.startsWith("https://") && REMOTE_KINDS.has(details.resourceType));
    callback({ cancel: !still });
  });
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (!inside(target)) event.preventDefault(); });
  window.webContents.on("will-redirect", (event, target) => { if (!inside(target)) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const cancelled = (): never => { throw new HistosPublishError("Operazione annullata.", "cancelled", 6); };
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    photograph: async ({ url, width, expression, signal: one }) => {
      if (window.isDestroyed() || one.aborted) cancelled();
      if (!inside(url) || !Number.isSafeInteger(width) || width < 200 || width > 4000) throw new HistosPublishError("Pagina non valida per il confronto con la proposta.", "verify-origin-invalid", 2);
      window.setContentSize(width, TILE);
      await window.loadURL(url);
      await window.webContents.insertCSS(STILL_CSS);
      const world = (code: string): Promise<unknown> => window.webContents.executeJavaScriptInIsolatedWorld(PHOTO_WORLD, [{ code }]);
      const measured = Number(await world(SETTLE));
      const height = Math.max(TILE, Math.min(COMPARE_MAX_HEIGHT, Math.ceil(Number.isFinite(measured) ? measured : TILE)));
      // The window stays as tall as a screen (a section «100vh» keeps its height) and the page is taken tile by tile.
      const data = new Uint8Array(width * height * 4);
      for (let top = 0; top < height; top += TILE) {
        const scrolled = Math.round(Number(await world(`(() => { scrollTo(0, ${top}); return scrollY; })()`)));
        await pause(120);
        if (window.isDestroyed() || one.aborted) cancelled();
        let image = await window.webContents.capturePage({ x: 0, y: 0, width, height: TILE });
        let tile = image.toBitmap();
        if (tile.length !== width * TILE * 4) {
          // A screen that paints more pixels than it counts: back to one pixel each.
          image = image.resize({ width, height: TILE });
          tile = image.toBitmap();
        }
        if (tile.length !== width * TILE * 4 || !Number.isSafeInteger(scrolled) || scrolled < 0 || scrolled >= height) throw new HistosPublishError("La fotografia della pagina non è riuscita.", "verify-photo-failed", 2);
        // The last tile cannot scroll a whole screen: it is placed where the page really stopped.
        const rows = Math.min(TILE, height - scrolled);
        data.set(tile.subarray(0, rows * width * 4), scrolled * width * 4);
      }
      await world("scrollTo(0, 0)");
      const value = expression ? await world(expression) : undefined;
      return { width, height, data, ...(expression ? { value } : {}) };
    },
    close: async () => {
      signal.removeEventListener("abort", destroy);
      destroy();
      await isolated.clearStorageData().catch(() => undefined);
    },
  };
};
