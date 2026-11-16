/// <reference types="vite/client" />

interface Window {
  histosDesktop?: {
    sandboxFallback: () => Promise<boolean>;
    /** Light, dark or as the system: the window's own colour scheme. */
    setTheme?: (theme: "system" | "light" | "dark") => Promise<void>;
    /** Opens an http(s) address in the system browser (desktop main.ts, externalUrlHandler). */
    openExternal?: (url: string) => Promise<boolean>;
    /** The desktop app's file dialog: the chosen prototype's absolute path, or null when cancelled (queue E10). */
    choosePrototypeFile?: () => Promise<string | null>;
    /** The text of a prototype the user chose or dropped, read again from disk (queue E4); null when it has no path. */
    rereadPrototypeFile?: (file: File) => Promise<Uint8Array<ArrayBuffer> | null>;
    /** Whether rereadPrototypeFile can read this file at all: one of the user's, with a .html/.htm path (queue E4). */
    canRereadPrototypeFile?: (file: File) => boolean;
    /** The app's own updates from the public releases (desktop app-updates.ts); null answers mean «not allowed». */
    updates?: {
      status: () => Promise<unknown>;
      check: () => Promise<unknown>;
      install: () => Promise<unknown>;
      restart: () => Promise<boolean>;
    };
  };
}
