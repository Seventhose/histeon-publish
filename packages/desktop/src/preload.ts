import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * E4 «Ricontrolla»: the path of a prototype the user chose or dropped, when the main process would read it (see
 * rereadPrototypeHandler, which checks it again); "" otherwise. Only a file of the user's has a path here, so a page
 * cannot make one up; a File made in memory (a converted site, B1) has none, and a file without .html/.htm is refused.
 */
function prototypePath(file: File): string {
  let filePath = "";
  try { filePath = webUtils.getPathForFile(file); } catch { return ""; }
  return typeof filePath === "string" && filePath.length <= 4096 && !filePath.includes("\0") && /\.html?$/iu.test(filePath) ? filePath : "";
}

/** How long «Ricontrolla» waits for the main process to read the file again (32 MB at most). */
const REREAD_TIMEOUT_MS = 60_000;

contextBridge.exposeInMainWorld("histosDesktop", Object.freeze({
  setTheme: (theme: "system" | "light" | "dark"): Promise<void> => ipcRenderer.invoke("histos-publish:theme", theme) as Promise<void>,
  sandboxFallback: (): Promise<boolean> => ipcRenderer.invoke("histos-publish:sandbox-fallback") as Promise<boolean>,
  // The app's own updates (app-updates.ts): the state, a check, install, restart.
  updates: Object.freeze({
    status: (): Promise<unknown> => ipcRenderer.invoke("histos-publish:update-status"),
    check: (): Promise<unknown> => ipcRenderer.invoke("histos-publish:update-check"),
    install: (): Promise<unknown> => ipcRenderer.invoke("histos-publish:update-install"),
    restart: (): Promise<boolean> => ipcRenderer.invoke("histos-publish:update-restart") as Promise<boolean>,
  }),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("histos-publish:open-external", url) as Promise<boolean>,
  choosePrototypeFile: (): Promise<string | null> => ipcRenderer.invoke("histos-publish:choose-prototype") as Promise<string | null>,
  // The app offers «Ricontrolla» only for a file this says yes to; nothing is read and nothing crosses to the main process.
  canRereadPrototypeFile: (file: File): boolean => prototypePath(file) !== "",
  rereadPrototypeFile: (file: File): Promise<Uint8Array | null> => {
    const filePath = prototypePath(file);
    if (!filePath) return Promise.resolve(null);
    // A read that has not answered in time counts as failed: «Ricontrolla» runs while the app is busy, and nothing on
    // the other side (a network folder that stopped answering) may keep every control disabled. The read itself goes
    // on in the main process, which runs one at a time (rereadPrototypeFile): a press meanwhile answers null at once.
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), REREAD_TIMEOUT_MS);
      (ipcRenderer.invoke("histos-publish:reread-prototype", filePath) as Promise<Uint8Array | null>).then(
        (bytes) => { clearTimeout(timer); resolve(bytes); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
  },
}));
