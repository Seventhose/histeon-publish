import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNode, nodeFolders } from "../src/connector-server.js";

describe("connettore AI: dove si trova Node (E10)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "histos-node-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fake `node` that prints the given text for --version. */
  async function fakeNode(folder: string, output: string, executable = true): Promise<string> {
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "node");
    await writeFile(file, `#!/bin/sh\necho '${output}'\n`);
    await chmod(file, executable ? 0o755 : 0o644);
    return file;
  }

  it("cerca prima nel PATH, poi nelle cartelle di Homebrew, Volta e nvm (dalla versione più recente)", async () => {
    const home = path.join(root, "home");
    for (const version of ["v18.20.4", "v22.11.0", "v9.9.9", "non-una-versione"]) await mkdir(path.join(home, ".nvm", "versions", "node", version, "bin"), { recursive: true });
    const folders = await nodeFolders({ PATH: "/primo:relativo/bin::/secondo" }, "linux", home);
    expect(folders.slice(0, 2)).toEqual(["/primo", "/secondo"]);
    expect(folders).not.toContain("relativo/bin");
    expect(folders).toContain("/opt/homebrew/bin");
    expect(folders).toContain(path.join(home, ".volta", "bin"));
    const nvm = folders.filter((folder) => folder.includes(".nvm"));
    expect(nvm).toEqual(["v22.11.0", "v18.20.4", "v9.9.9"].map((version) => path.join(home, ".nvm", "versions", "node", version, "bin")));
    const windows = await nodeFolders({ PATH: "C:\\Tools;relativo;D:\\Node", ProgramFiles: "C:\\Program Files" }, "win32", home);
    expect(windows.slice(0, 3)).toEqual(["C:\\Tools", "D:\\Node", "C:\\Program Files\\nodejs"]);
  });

  it.skipIf(process.platform === "win32")("prende il primo Node eseguibile che risponde con una versione, e dice se è almeno la 18", async () => {
    const notExecutable = path.join(root, "a");
    await fakeNode(notExecutable, "v20.0.0", false);
    const garbage = path.join(root, "b");
    await fakeNode(garbage, "ciao");
    const old = path.join(root, "c");
    const oldNode = await fakeNode(old, "v16.20.2");
    const good = path.join(root, "d");
    const goodNode = await fakeNode(good, "v20.11.1");
    expect(await findNode([path.join(root, "manca"), notExecutable, garbage, good, old], "linux")).toEqual({ path: goodNode, version: "v20.11.1", supported: true });
    // An old Node first (the system one) does not hide a newer one further on (nvm).
    expect(await findNode([old, good], "linux")).toEqual({ path: goodNode, version: "v20.11.1", supported: true });
    expect(await findNode([garbage, old], "linux")).toEqual({ path: oldNode, version: "v16.20.2", supported: false });
    expect(await findNode([notExecutable, garbage], "linux")).toEqual({ path: null, version: null, supported: false });
  });
});
