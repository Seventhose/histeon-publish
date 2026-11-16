import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** main.ts needs Electron to load: its IPC wiring is checked on the source. */
const mainSource = readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main.ts"), "utf8");

describe("IPC del processo principale", () => {
  it("ogni canale controlla il mittente con isTrustedIpcSender", async () => {
    const source = await mainSource;
    for (const channel of ["theme", "sandbox-fallback"]) {
      const start = source.indexOf(`ipcMain.handle("histos-publish:${channel}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("ipcMain.handle(", start + 1);
      expect(source.slice(start, end < 0 ? undefined : end)).toContain("isTrustedIpcSender(event, mainWindow)");
    }
    // The only direct comparison with the window's webContents is the one inside isTrustedIpcSender.
    expect(source.match(/event\.sender\s*[!=]==/gu) ?? []).toHaveLength(1);
  });
});
