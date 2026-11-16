import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOTYPE_REREAD_MAX_BYTES, rereadPrototypeFile, type RereadOpen } from "../src/prototype-reread.js";

const roots: string[] = [];
const fifos: string[] = [];
afterEach(async () => {
  // A read still waiting on a FIFO (the defect this guards against) is let go: a writer that opens and closes at once.
  for (const fifo of fifos.splice(0)) {
    try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* No reader waiting. */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-reread-"));
  roots.push(root);
  return root;
}

describe("«Ricontrolla» rilegge il prototipo dal disco (E4)", () => {
  it("legge un file .html normale e nient'altro", async () => {
    const root = await folder();
    const file = path.join(root, "proto.html");
    await writeFile(file, "<html></html>");
    expect(Buffer.from((await rereadPrototypeFile(file)) ?? []).toString("utf8")).toBe("<html></html>");
    expect(await rereadPrototypeFile("proto.html")).toBeNull();
    expect(await rereadPrototypeFile(path.join(root, "proto.txt"))).toBeNull();
    expect(await rereadPrototypeFile(path.join(root, "manca.html"))).toBeNull();
    expect(await rereadPrototypeFile(42)).toBeNull();
    await mkdir(path.join(root, "cartella.html"));
    expect(await rereadPrototypeFile(path.join(root, "cartella.html"))).toBeNull();
    const big = path.join(root, "grande.html");
    await writeFile(big, "");
    await truncate(big, PROTOTYPE_REREAD_MAX_BYTES + 1);
    expect(await rereadPrototypeFile(big)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("una FIFO chiamata proto.html non blocca la lettura: risponde subito che non si rilegge (17)", async () => {
    const root = await folder();
    const fifo = path.join(root, "proto.html");
    execFileSync("mkfifo", [fifo]);
    fifos.push(fifo);
    const started = Date.now();
    const answer = await Promise.race([
      rereadPrototypeFile(fifo).then((value) => ({ value })),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    expect(answer).toEqual({ value: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("una rilettura ferma su una cartella che non risponde non ne lascia partire un'altra: al massimo un thread fermo (10)", async () => {
    const root = await folder();
    const file = path.join(root, "proto.html");
    await writeFile(file, "<html></html>");
    // A network folder that stopped answering: the open waits until it is let go, as a hard mount does.
    const waiting: Array<() => void> = [];
    let opens = 0;
    const stuck: RereadOpen = async (name, flags) => {
      opens += 1;
      await new Promise<void>((resolve) => { waiting.push(resolve); });
      return open(name, flags);
    };
    const first = rereadPrototypeFile(file, stuck);
    // «Ricontrolla» again after the preload stopped waiting: before, a second open joined the first, one more thread
    // held each time; now an answer at once, and nothing opened.
    const again = await Promise.race([
      rereadPrototypeFile(file, stuck).then((value) => ({ value })),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]);
    expect(again).toEqual({ value: null });
    expect(await rereadPrototypeFile(file)).toBeNull();
    expect(opens).toBe(1);
    // The folder answers again: the first read ends, and the next «Ricontrolla» reads.
    for (const resolve of waiting.splice(0)) resolve();
    expect(Buffer.from((await first) ?? []).toString("utf8")).toBe("<html></html>");
    expect(Buffer.from((await rereadPrototypeFile(file)) ?? []).toString("utf8")).toBe("<html></html>");
    // A failed read lets the next one go too.
    expect(await rereadPrototypeFile(file, async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); })).toBeNull();
    expect(Buffer.from((await rereadPrototypeFile(file)) ?? []).toString("utf8")).toBe("<html></html>");
    // Nothing left waiting if the guard is ever removed and a second open got in.
    for (const resolve of waiting.splice(0)) resolve();
  });
});
