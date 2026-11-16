import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTemporary } from "../src/remove-temporary.js";

describe("cartelle temporanee di build, controlli e import", () => {
  it("si tolgono con tutto quel che contengono", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-remove-temporary-"));
    const folder = path.join(root, "build");
    await mkdir(path.join(folder, "source", "media"), { recursive: true });
    await writeFile(path.join(folder, "source", "media", "a.png"), "x");
    await removeTemporary(folder);
    await expect(stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });

  it("una pulizia che non riesce non lancia: l'errore della build resta quello che il chiamante sta lanciando", async () => {
    // A render refusal ends a build in its finally block: before, an ENOTEMPTY from the cleanup replaced it, and the
    // app called a broken prototype «a machine error» (e2e D8 under load). Here the folder cannot go at all.
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-remove-temporary-"));
    const parent = path.join(root, "locked");
    const folder = path.join(parent, "build");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "index.html"), "x");
    await chmod(parent, 0o500);
    try {
      if (process.getuid?.() === 0) return; // root ignores the permission: nothing to prove
      await expect(removeTemporary(folder)).resolves.toBeUndefined();
    } finally {
      await chmod(parent, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});
