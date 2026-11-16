import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, protocol, safeStorage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HistosPublishError } from "@histos-publish/core";
import { startLocalServer, defaultDataDirectory, type SecretStore } from "@histos-publish/server";
import { createElectronPageProbe } from "./page-probe.js";
import { createElectronPagePhotos } from "./page-photos.js";
import { createElectronRenderPage } from "./render.js";
import { createElectronCompareRenders } from "./render-compare.js";
import { rereadPrototypeFile } from "./prototype-reread.js";
import { registerAppUpdates } from "./app-updates.js";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const packagedPagefind = path.join(process.resourcesPath, "pagefind", process.platform === "win32" ? "pagefind_extended.exe" : "pagefind_extended");
if (!process.env.PAGEFIND_EXTENDED_BINARY_PATH && existsSync(packagedPagefind)) process.env.PAGEFIND_EXTENDED_BINARY_PATH = packagedPagefind;
const packagedWordPressPlugin = path.join(MODULE_DIRECTORY, "histos-wordpress-plugin.zip");
if (!process.env.HISTOS_PUBLISH_WORDPRESS_PLUGIN_PATH && existsSync(packagedWordPressPlugin)) process.env.HISTOS_PUBLISH_WORDPRESS_PLUGIN_PATH = packagedWordPressPlugin;
const RENDERER_DIRECTORY = path.join(MODULE_DIRECTORY, "renderer");
const APP_ORIGIN = "app://histos-publish";
const DEEP_LINK_SCHEME = "histos-publish";
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf",
  ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
};

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

class ElectronSafeStorageStore implements SecretStore {
  private readonly filePath: string;

  constructor(account: string) {
    const name = createHash("sha256").update(account).digest("hex");
    this.filePath = path.join(app.getPath("userData"), "secrets", `${name}.enc`);
  }

  private async assertSecureBackend(): Promise<void> {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
      throw new HistosPublishError("Cifratura di sistema non disponibile. Avvia o sblocca il portachiavi e riprova.", "secret-store-unavailable", 4);
    }
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      throw new HistosPublishError("Histeon Publish non salva segreti con il backend Linux non protetto. Avvia o sblocca GNOME Keyring o KWallet, oppure usa HISTOS_CLOUDFLARE_API_TOKEN.", "secret-store-unavailable", 4);
    }
  }

  async get(): Promise<string | null> {
    await this.assertSecureBackend();
    let encrypted: Buffer;
    try { encrypted = await readFile(this.filePath); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw new HistosPublishError("Non riesco a leggere il segreto cifrato.", "secret-store-unavailable", 4);
    }
    try {
      const result = await safeStorage.decryptStringAsync(encrypted);
      if (result.shouldReEncrypt) await this.set(result.result);
      return result.result;
    } catch {
      throw new HistosPublishError("Il segreto cifrato non è leggibile da questo utente o da questo portachiavi.", "secret-store-unavailable", 4);
    }
  }

  async set(value: string): Promise<void> {
    await this.assertSecureBackend();
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const encrypted = await safeStorage.encryptStringAsync(value);
      await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async delete(): Promise<void> {
    await this.assertSecureBackend();
    await rm(this.filePath, { force: true });
  }
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && Boolean(url.hostname);
  } catch { return false; }
}

/**
 * A build's preview on the local server (`http://127.0.0.1:<port>/__preview/<ticket>/<build>/…`): its prefix, the part
 * every page and file of that one preview shares, or null for anything else.
 */
function previewPrefix(value: string, port: number): string | null {
  try {
    const url = new URL(value);
    const match = /^\/__preview\/[A-Za-z0-9_-]+\/[0-9a-f-]{36}\//u.exec(url.pathname);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(port) || url.username || url.password || !match) return null;
    return `${url.origin}${match[0]}`;
  } catch { return null; }
}

/** The preview window: the visitor's view of the site, with nothing of the app (no preload, sandboxed). */
const PREVIEW_WINDOW: Electron.BrowserWindowConstructorOptions = {
  title: "Anteprima del sito",
  width: 1280,
  height: 860,
  autoHideMenuBar: true,
  webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
};

/**
 * Keeps a preview window on its own preview: links inside the site navigate there, a link to another site goes to the
 * user's browser, and the window opens no other window of its own.
 */
function guardPreviewWindow(child: BrowserWindow, prefix: string): void {
  const outside = (target: string) => {
    if (target.startsWith(prefix)) return false;
    if (isSafeExternalUrl(target) && !target.startsWith(new URL(prefix).origin)) void shell.openExternal(target);
    return true;
  };
  child.webContents.on("will-navigate", (event, target) => {
    if (outside(target)) event.preventDefault();
  });
  child.webContents.on("will-redirect", (event, target) => {
    if (outside(target)) event.preventDefault();
  });
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(prefix)) void child.loadURL(url);
    else outside(url);
    return { action: "deny" };
  });
}

function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "app:" && url.hostname === "histos-publish" && url.port === "" && !url.username && !url.password;
  } catch { return false; }
}

function findLocalImportLink(argumentsList: string[]): string | null {
  return argumentsList.find((argument) => argument.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/**
 * Doc 23 item 237: `histos-publish://collega?state=…&claim=…`, the way back of a pairing started in the app. Only
 * the two identifiers go on, in the app's own address: the app shows the site and asks before claiming, and the
 * server claims only a pairing it started (cms-remote.ts). Nothing else of the link is read.
 */
function pairingAppUrl(link: URL): URL | null {
  if (link.hostname !== "collega" || (link.pathname !== "" && link.pathname !== "/") || link.username || link.password || link.hash) return null;
  const state = link.searchParams.get("state") ?? "";
  const claim = link.searchParams.get("claim") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(state) || !/^[0-9a-f]{32}$/u.test(claim)) return null;
  const destination = new URL(`${APP_ORIGIN}/`);
  destination.searchParams.set("pairState", state);
  destination.searchParams.set("pairClaim", claim);
  return destination;
}

function localImportAppUrl(value: string): URL | null {
  if (value.length > 4096) return null;
  try {
    const link = new URL(value);
    if (link.protocol === `${DEEP_LINK_SCHEME}:` && link.hostname === "collega") return pairingAppUrl(link);
  } catch {
    return null;
  }
  try {
    const link = new URL(value);
    if (link.protocol !== `${DEEP_LINK_SCHEME}:` || link.hostname !== "import" || (link.pathname !== "" && link.pathname !== "/") || link.username || link.password || link.hash) return null;
    const rawTarget = link.searchParams.get("url");
    const rawName = link.searchParams.get("name") ?? "Sito Local";
    if (!rawTarget || rawName.length > 120 || /\p{Cc}/u.test(rawName)) return null;
    const target = new URL(rawTarget);
    const hostname = target.hostname.toLowerCase();
    const localHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
    if (!localHost || (target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password || target.pathname !== "/" || target.search || target.hash) return null;
    const destination = new URL(`${APP_ORIGIN}/`);
    destination.searchParams.set("localImportUrl", target.href);
    destination.searchParams.set("localImportName", rawName.trim().slice(0, 80) || "Sito Local");
    return destination;
  } catch {
    return null;
  }
}

function isTrustedIpcSender(event: Electron.IpcMainInvokeEvent, mainWindow: BrowserWindow | null): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  return isAppUrl(event.senderFrame.url);
}

async function externalUrlHandler(event: Electron.IpcMainInvokeEvent, value: unknown, mainWindow: BrowserWindow | null): Promise<boolean> {
  if (!isTrustedIpcSender(event, mainWindow)) throw new HistosPublishError("Mittente IPC non autorizzato.", "ipc-sender-rejected", 4);
  const parsed = z.string().url().max(4096).safeParse(value);
  if (!parsed.success || !isSafeExternalUrl(parsed.data)) throw new HistosPublishError("È possibile aprire solo link HTTP o HTTPS validi.", "ipc-argument-invalid", 2);
  await shell.openExternal(parsed.data);
  return true;
}

/** One file dialog at a time: a page cannot stack them. */
let choosingPrototype = false;

/**
 * The connector's "Scegli il file del prototipo" (queue E10): a native dialog, so the message for the agent can name
 * the file's absolute path, which a browser file input never gives. Only the chosen path goes back; nothing is read.
 */
async function choosePrototypeHandler(event: Electron.IpcMainInvokeEvent, mainWindow: BrowserWindow | null): Promise<string | null> {
  if (!mainWindow || !isTrustedIpcSender(event, mainWindow)) throw new HistosPublishError("Mittente IPC non autorizzato.", "ipc-sender-rejected", 4);
  if (choosingPrototype) return null;
  choosingPrototype = true;
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: "Scegli il prototipo", properties: ["openFile"], filters: [{ name: "Prototipo HTML", extensions: ["html", "htm"] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } finally {
    choosingPrototype = false;
  }
}

/**
 * E4 «Ricontrolla»: the bytes of a prototype the user chose or dropped, read again from disk, for the app's window
 * only. What may be read, how without ever blocking on a FIFO, and why one at a time (a read stuck on a network folder
 * holds a thread of this process, the local server's too), is in rereadPrototypeFile (prototype-reread.ts).
 */
async function rereadPrototypeHandler(event: Electron.IpcMainInvokeEvent, value: unknown, mainWindow: BrowserWindow | null): Promise<Uint8Array | null> {
  if (!mainWindow || !isTrustedIpcSender(event, mainWindow)) throw new HistosPublishError("Mittente IPC non autorizzato.", "ipc-sender-rejected", 4);
  return rereadPrototypeFile(value);
}

function responseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    ...extra,
  });
}

/**
 * «Fotografa la proposta»: the local server's capture origin (a port of its own on 127.0.0.1). It serves only the
 * proposal's sealed frame, and it is the one address besides the app's own that the interface may frame.
 */
let proposalFrameOrigin = "";

function csp(): string {
  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'" + (proposalFrameOrigin ? ` ${proposalFrameOrigin}` : "") + "; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
}

async function serveRendererFile(url: URL, method: string): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: responseHeaders({ Allow: "GET, HEAD" }) });
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch { return new Response("Not found", { status: 404 }); }
  if (decoded.includes("\\") || decoded.includes("\0")) return new Response("Not found", { status: 404 });
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const absolute = path.resolve(RENDERER_DIRECTORY, relative);
  if (absolute !== RENDERER_DIRECTORY && !absolute.startsWith(`${RENDERER_DIRECTORY}${path.sep}`)) return new Response("Not found", { status: 404 });
  let info: Awaited<ReturnType<typeof stat>>;
  try { info = await stat(absolute); } catch { return new Response("Not found", { status: 404 }); }
  if (!info.isFile() || info.size > 20 * 1024 * 1024) return new Response("Not found", { status: 404 });
  const body = method === "HEAD" ? null : await readFile(absolute);
  const extension = path.extname(absolute).toLowerCase();
  const headers = responseHeaders({
    "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
    "Content-Length": String(info.size),
    ...(extension === ".html" ? { "Content-Security-Policy": csp() } : {}),
  });
  if (extension !== ".html") headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(body, { status: 200, headers });
}

function safeProxyHeaders(request: Request, backendOrigin: string): Headers {
  const headers = new Headers({ Origin: backendOrigin });
  for (const name of ["x-histos-token", "content-type", "accept", "accept-language"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function proxyToLocalServer(request: Request, serverOrigin: string): Promise<Response> {
  const incoming = new URL(request.url);
  const isApi = incoming.pathname === "/api" || incoming.pathname.startsWith("/api/");
  const isPreview = incoming.pathname.startsWith("/__preview/");
  // The project's media: the editor's canvas and panels load them by this root-relative address, which on app:// has
  // to reach the local server like the preview does. Read-only there too.
  const isMedia = incoming.pathname.startsWith("/__cms-media/");
  if (!isApi && !isPreview && !isMedia) return new Response("Not found", { status: 404 });
  if ((isPreview || isMedia) && request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const target = new URL(`${incoming.pathname}${incoming.search}`, serverOrigin);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: safeProxyHeaders(request, serverOrigin),
    redirect: "manual",
  };
  if (request.body && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  const upstream = await fetch(target, init);
  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "cache-control", "x-content-type-options", "referrer-policy", "content-security-policy", "x-frame-options", "allow", "retry-after", "access-control-allow-origin"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // A preview folder redirects to its trailing slash: only a same-origin preview path is passed on.
  const location = upstream.headers.get("location");
  if (isPreview && location?.startsWith("/__preview/")) headers.set("location", location);
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function registerAppProtocol(serverOrigin: string): Promise<void> {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (!isAppUrl(url.href)) return new Response("Not found", { status: 404 });
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/__preview/") || url.pathname.startsWith("/__cms-media/")) {
      try { return await proxyToLocalServer(request, serverOrigin); }
      catch { return Response.json({ error: "Il server locale non ha completato la richiesta.", code: "local-server-error" }, { status: 502 }); }
    }
    return serveRendererFile(url, request.method);
  });
}

/**
 * Where the AI connector finds its client (copied into the data folder when the user turns it on) and where the
 * .xbsite exports an agent asks for go. The connector itself stays off until the user turns it on.
 */
function connectorOptions(): NonNullable<NonNullable<Parameters<typeof startLocalServer>[0]>["connector"]> {
  const clientScript = path.join(MODULE_DIRECTORY, "histos-publish-connector.mjs");
  let exportDirectory: string | undefined;
  try {
    exportDirectory = path.join(app.getPath("documents"), "Histeon Publish", "Esportazioni AI");
  } catch {
    exportDirectory = undefined;
  }
  return {
    appVersion: app.getVersion(),
    ...(existsSync(clientScript) ? { clientScript } : {}),
    ...(exportDirectory ? { exportDirectory } : {}),
    onApprovals: notifyConnectorApprovals,
  };
}

/** An agent asks to send to WordPress: a system notification, a flashing window and a badge with the count (E8). */
function notifyConnectorApprovals(event: { pending: number; request?: { client: string; host: string; projectName: string; kind?: "wordpress" | "import" } }): void {
  app.setBadgeCount(event.pending);
  if (!event.request) return;
  if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (!Notification.isSupported()) return;
  const update = event.request.kind === "import";
  const notice = new Notification({
    title: update ? "Histeon Publish: aggiornamento da confermare" : "Histeon Publish: invio da confermare",
    body: update
      ? `${event.request.client} chiede di aggiornare «${event.request.projectName}» con un nuovo prototipo. Apri Histeon Publish per decidere: la richiesta scade fra 10 minuti.`
      : `${event.request.client} chiede di inviare «${event.request.projectName}» a ${event.request.host}. Apri Histeon Publish per decidere: la richiesta scade fra 10 minuti.`,
  });
  notice.on("click", () => focusMainWindow());
  notice.show();
}

let localServer: Awaited<ReturnType<typeof startLocalServer>> | null = null;
let mainWindow: BrowserWindow | null = null;
let serverShutdownStarted = false;
let serverShutdownComplete = false;
let pendingServerClose: { window: BrowserWindow; onClosed: () => void } | null = null;
let pendingLocalImportLink: string | null = findLocalImportLink(process.argv);

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openLocalImportLink(value: string): boolean {
  const destination = localImportAppUrl(value);
  if (!destination) return false;
  if (!localServer || !mainWindow) {
    pendingLocalImportLink = value;
    focusMainWindow();
    return true;
  }
  destination.hash = new URL(localServer.url).hash;
  void mainWindow.loadURL(destination.href);
  focusMainWindow();
  return true;
}

app.on("open-url", (event, value) => {
  event.preventDefault();
  openLocalImportLink(value);
});

if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

function createMainWindow(): void {
  if (!localServer) throw new Error("Il server locale non è pronto.");
  mainWindow = new BrowserWindow({
    title: "Histeon Publish",
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 680,
    show: false,
    webPreferences: {
      preload: path.join(MODULE_DIRECTORY, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // The site preview opens in a window of the app (previewWindow), the rest of the web in the user's browser.
    const preview = localServer ? previewPrefix(url, localServer.port) : null;
    if (preview) return { action: "allow", overrideBrowserWindowOptions: PREVIEW_WINDOW };
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", (child, details) => {
    const prefix = localServer ? previewPrefix(details.url, localServer.port) : null;
    if (prefix) guardPreviewWindow(child, prefix);
    else child.destroy();
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!isAppUrl(target)) event.preventDefault();
  });
  const window = mainWindow;
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "Modifiche non salvate",
      message: "L’editor contiene modifiche non salvate.",
      detail: "Puoi restare nell’editor oppure uscire senza salvare queste modifiche.",
      buttons: ["Resta nell’editor", "Esci senza salvare"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 1) {
      // Electron's will-prevent-unload event permits the close only when the
      // main process explicitly prevents its default behavior.
      event.preventDefault();
      return;
    }
    if (pendingServerClose?.window === window) {
      window.off("closed", pendingServerClose.onClosed);
      pendingServerClose = null;
      serverShutdownStarted = false;
    }
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  const url = pendingLocalImportLink ? localImportAppUrl(pendingLocalImportLink) ?? new URL(`${APP_ORIGIN}/`) : new URL(`${APP_ORIGIN}/`);
  pendingLocalImportLink = null;
  url.hash = new URL(localServer.url).hash;
  void mainWindow.loadURL(url.href);
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("histos-publish:open-external", (event, value: unknown) => externalUrlHandler(event, value, mainWindow));
ipcMain.handle("histos-publish:choose-prototype", (event) => choosePrototypeHandler(event, mainWindow));
ipcMain.handle("histos-publish:reread-prototype", (event, value: unknown) => rereadPrototypeHandler(event, value, mainWindow));
ipcMain.handle("histos-publish:theme", (event, value: unknown) => {
  if (isTrustedIpcSender(event, mainWindow) && (value === "system" || value === "light" || value === "dark")) nativeTheme.themeSource = value;
});
ipcMain.handle("histos-publish:sandbox-fallback", (event) => isTrustedIpcSender(event, mainWindow) && process.env.HISTOS_PUBLISH_SANDBOX_FALLBACK === "1");
registerAppUpdates({ legacyTokenStore: new ElectronSafeStorageStore("github-app-updates"), trusted: (event) => isTrustedIpcSender(event, mainWindow) });

app.on("before-quit", (event) => {
  if (serverShutdownComplete || (!localServer && !serverShutdownStarted)) return;
  event.preventDefault();
  if (serverShutdownStarted) return;
  serverShutdownStarted = true;

  const closeServer = (): void => {
    pendingServerClose = null;
    const server = localServer;
    localServer = null;
    if (!server) {
      serverShutdownComplete = true;
      app.quit();
      return;
    }
    void server.close().catch(() => undefined).finally(() => {
      serverShutdownComplete = true;
      app.quit();
    });
  };

  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    closeServer();
    return;
  }

  // Let the renderer run beforeunload first. If it cancels (for example because
  // a document has unsaved edits), leave the server running and allow another
  // quit attempt later. Closing the server before the window can deadlock when
  // the editor still has an active request to the local API.
  const onClosed = (): void => closeServer();
  pendingServerClose = { window, onClosed };
  window.once("closed", onClosed);
  window.close();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin" && !serverShutdownComplete) app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && localServer) createMainWindow(); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", (_event, commandLine) => {
    const link = findLocalImportLink(commandLine);
    if (link) openLocalImportLink(link);
    focusMainWindow();
  });
  app.whenReady().then(async () => {
    localServer = await startLocalServer({
      dataDirectory: defaultDataDirectory(),
      openBrowser: false,
      secretStoreFactory: (account) => new ElectronSafeStorageStore(account),
      renderPage: createElectronRenderPage,
      compareRenders: createElectronCompareRenders,
      openPageProbe: createElectronPageProbe,
      photographPages: createElectronPagePhotos,
      connector: connectorOptions(),
    });
    if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(localServer.captureOrigin)) proposalFrameOrigin = localServer.captureOrigin;
    await registerAppProtocol(`http://127.0.0.1:${localServer.port}`);
    createMainWindow();
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Avvio di Histeon Publish non riuscito.";
    void dialog.showErrorBox("Histeon Publish", message);
    app.quit();
  });
}
