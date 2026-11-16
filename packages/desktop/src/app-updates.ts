import { app, ipcMain, Notification } from "electron";
import path from "node:path";
import { checkDownload, downloadAsset, isNewer, latestRelease, MAX_APPIMAGE_BYTES, replaceAppImage, UpdateError, type AppRelease } from "./updates.js";

/** What the Settings card shows (docs/spec/aggiornamenti-app.md). */
export interface UpdateState {
  current: string;
  /** Running as an AppImage, which the app can replace; the .deb and Windows installs are updated by hand. */
  canInstall: boolean;
  available: { version: string; page: string } | null;
  checkedAt: string | null;
  error: string | null;
  /** A newer version written over the AppImage, waiting for a restart. */
  installed: string | null;
  busy: boolean;
}

/** Where versions up to 1.39.0 kept the GitHub token of the private releases: only ever deleted now. */
interface LegacyTokenStore { delete(): Promise<void> }

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;

/**
 * The app's own updates, from the public GitHub releases, without a token: one request to GitHub at start (after a
 * minute) and every 12 hours, and a notification when a newer version exists. Installing replaces the running AppImage
 * only after the signature check of updates.ts. A token saved by an older version is deleted at start and never read.
 */
export function registerAppUpdates(options: { legacyTokenStore: LegacyTokenStore; trusted: (event: Electron.IpcMainInvokeEvent) => boolean }): void {
  let release: AppRelease | null = null;
  let checkedAt: string | null = null;
  let error: string | null = null;
  let installed: string | null = null;
  let busy = false;
  let notified: string | null = null;

  const appImage = (): string | null => {
    const value = process.env.APPIMAGE;
    return process.platform === "linux" && app.isPackaged && typeof value === "string" && path.isAbsolute(value) ? value : null;
  };
  const message = (caught: unknown) => caught instanceof UpdateError ? caught.message : "Controllo degli aggiornamenti non riuscito: GitHub non raggiungibile o risposta inattesa.";

  async function state(): Promise<UpdateState> {
    return {
      current: app.getVersion(),
      canInstall: appImage() !== null,
      available: release ? { version: release.version, page: release.page } : null,
      checkedAt,
      error,
      installed,
      busy,
    };
  }

  async function check(notify: boolean): Promise<void> {
    try {
      const found = await latestRelease();
      release = found && isNewer(found.version, app.getVersion()) ? found : null;
      error = null;
    } catch (caught) { error = message(caught); }
    checkedAt = new Date().toISOString();
    if (notify && release && notified !== release.version && Notification.isSupported()) {
      notified = release.version;
      new Notification({ title: "Histeon Publish", body: `È disponibile la versione ${release.version}: installala da Impostazioni → Dati → Aggiornamenti.` }).show();
    }
  }

  async function install(): Promise<void> {
    const target = appImage();
    if (!target) throw new UpdateError("Questa installazione non è un’AppImage: scarica la nuova versione dalla release.");
    if (!release) throw new UpdateError("Nessuna versione più nuova da installare.");
    const chosen = release;
    const [data, signature] = await Promise.all([
      downloadAsset(chosen.appImage.url, MAX_APPIMAGE_BYTES),
      downloadAsset(chosen.signature.url, 4096),
    ]);
    checkDownload(chosen, data, signature.toString("utf8"), app.getVersion());
    await replaceAppImage(target, data);
    installed = chosen.version;
  }

  const guarded = (task: () => Promise<void>) => async (event: Electron.IpcMainInvokeEvent): Promise<UpdateState | null> => {
    if (!options.trusted(event)) return null;
    if (busy) return state();
    busy = true;
    try { await task(); }
    catch (caught) { error = message(caught); }
    finally { busy = false; }
    return state();
  };

  ipcMain.handle("histos-publish:update-status", (event) => options.trusted(event) ? state() : null);
  ipcMain.handle("histos-publish:update-check", guarded(() => check(false)));
  ipcMain.handle("histos-publish:update-install", guarded(install));
  ipcMain.handle("histos-publish:update-restart", (event) => {
    const target = appImage();
    if (!options.trusted(event) || !installed || !target) return false;
    // The AppImage's mount goes away when this process exits: start the file itself again, with the same arguments.
    app.relaunch({ execPath: target, args: process.argv.slice(1) });
    app.quit();
    return true;
  });

  void app.whenReady().then(() => {
    // The private releases needed a token; the public ones do not. A locked keyring only leaves the file where it is.
    void options.legacyTokenStore.delete().catch(() => undefined);
    setTimeout(() => { void check(true); }, FIRST_CHECK_MS).unref();
    setInterval(() => { void check(true); }, CHECK_EVERY_MS).unref();
  });
}
