import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderComparison, RenderComparisonInput } from "@histos-publish/core";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

/** Doc 23 item 101: the screenshot check of the utility conversion, with the app's photographer replaced. */
describe("controllo visivo delle classi utility nel resoconto dell'importazione", () => {
  let server: LocalServerHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let calls: RenderComparisonInput[];
  let answer: (input: RenderComparisonInput) => Promise<RenderComparison[]>;

  const page = '<!doctype html><html lang="it"><head><link rel="stylesheet" href="s.css"></head><body><section class="hero"><h1 class="text-4xl font-bold">Bottega</h1></section></body></html>';
  const css = ".hero{display:grid}.text-4xl{font-size:2.25rem}.font-bold{font-weight:700}";

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-visual-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-visual-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    calls = [];
    answer = async (input) => input.widths.map((width) => ({ width, height: 900, differentPixels: 0, totalPixels: width * 900 }));
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, compareRenders: async (input) => { calls.push(input); return await answer(input); } });
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    await Promise.all([rm(dataDirectory, { recursive: true, force: true }), rm(uiDirectory, { recursive: true, force: true })]);
  });

  async function convert(files: Record<string, string>): Promise<string[]> {
    if (!server) throw new Error("Server di test non avviato.");
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const entries = Object.entries(files);
    const plan = await (await fetch(`${base}/api/imports`, { method: "POST", headers, body: JSON.stringify({ name: "Bottega", kind: "directory", files: entries.map(([name, value]) => ({ path: name, size: Buffer.byteLength(value) })) }) })).json() as { id: string };
    for (const [name, value] of entries) {
      const put = await fetch(`${base}/api/imports/${plan.id}/files/${name}`, { method: "PUT", headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/octet-stream" }, body: Buffer.from(value) });
      expect(put.status, await put.clone().text()).toBe(201);
    }
    const converted = await fetch(`${base}/api/imports/${plan.id}/cms-prototype`, { method: "POST", headers, body: "{}" });
    expect(converted.status, await converted.clone().text()).toBe(200);
    return (await converted.json() as { report: { notes: string[] } }).report.notes;
  }

  it("fotografa la pagina prima e dopo, a 1280 e 390 px, e lo scrive nel resoconto", async () => {
    const notes = await convert({ "index.html": page, "s.css": css });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.widths).toEqual([1280, 390]);
    expect(calls[0]?.before).toContain('class="text-4xl font-bold"');
    expect(calls[0]?.after).toContain('class="hero__title"');
    expect(notes).toContain("controllo visivo delle classi utility: 1 pagina uguale prima e dopo, a 1280 e 390 px");
  });

  it("nomina la pagina diversa, con la parte di pixel peggiore", async () => {
    answer = async () => [{ width: 1280, height: 900, differentPixels: 0, totalPixels: 1_152_000 }, { width: 390, height: 1000, differentPixels: 3_900, totalPixels: 390_000 }];
    const notes = await convert({ "index.html": page, "s.css": css });
    expect(notes).toContain("controllo visivo delle classi utility: pagine diverse prima e dopo, da guardare: home (1% dei pixel a 390 px)");
  });

  it("un errore del fotografo è una nota, non un'importazione fallita; senza utility non fotografa", async () => {
    answer = async () => { throw new Error("finestra chiusa"); };
    expect(await convert({ "index.html": page, "s.css": css })).toContain("controllo visivo delle classi utility non riuscito");
    calls = [];
    const notes = await convert({ "index.html": '<!doctype html><html><head><link rel="stylesheet" href="s.css"></head><body><h1 class="titolo">Bottega</h1></body></html>', "s.css": ".titolo{color:#123}" });
    expect(calls).toEqual([]);
    expect(notes.join("\n")).not.toContain("controllo visivo");
  });
});
