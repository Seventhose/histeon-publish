import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

// Voce 2: il file di `kit proposte` caricato come una pagina; la proposta scelta diventa un prototipo che passa il
// controllo e si importa, dalle stesse rotte che usa l'app.
const roots: string[] = [];
let server: LocalServerHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-proposal-"));
  roots.push(root);
  return root;
}
const fixture = (name: string): Promise<Buffer> => readFile(path.resolve("packages/cms/test/fixtures", name));
const manifestOf = (html: string): Record<string, unknown> => JSON.parse(/<script data-histos="manifest" type="application\/json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "{}") as Record<string, unknown>;

interface Converted { fileName: string; prototype: string; report: { notes: string[] }; design: Record<string, string>; framework: string; structureApplied: { parts: boolean; components: boolean; lists: boolean }; proposal?: { id: string; name: string; framework: string } }

async function start(): Promise<{ base: string; headers: Record<string, string> }> {
  const dataDirectory = await temporary();
  const uiDirectory = await temporary();
  await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
  server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
  const base = `http://127.0.0.1:${server.port}`;
  return { base, headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" } };
}
async function upload(base: string, headers: Record<string, string>, bytes: Buffer): Promise<string> {
  const plan = await (await fetch(`${base}/api/imports`, { method: "POST", headers, body: JSON.stringify({ name: "proposte", kind: "html", files: [{ path: "proposte.html", size: bytes.length }] }) })).json() as { id: string };
  expect((await fetch(`${base}/api/imports/${plan.id}/files/proposte.html`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes })).status).toBe(201);
  return plan.id;
}

describe("una proposta di kit proposte diventa un progetto Histeon", () => {
  it("ACSS: converte la proposta scelta, passa il controllo senza avvisi e si importa con componente, tipo e record", async () => {
    const { base, headers } = await start();
    const id = await upload(base, headers, await fixture("proposte-acss.html"));
    const response = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ proposal: "p01" }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const converted = await response.json() as Converted;
    expect(converted.proposal).toEqual({ id: "p01", name: "Brace", framework: "acss" });
    expect(converted.fileName).toBe("trattoria-brace-prototipo.html");
    expect(converted.framework).toBe("histos-css");
    // Components and lists are on unless the user chose otherwise.
    expect(converted.structureApplied).toEqual({ parts: false, components: true, lists: true });
    const manifest = manifestOf(converted.prototype);
    expect(manifest.name).toBe("Trattoria · Brace");
    expect(manifest.design).toEqual({ font_body: "Georgia, serif", primary: "oklch(0.55 0.15 30)" });
    expect(converted.design).toEqual({ font_body: "Georgia, serif", primary: "oklch(0.55 0.15 30)" });
    expect(converted.prototype).toContain("{#loop piatto_elenco() as item}");
    expect(converted.prototype).not.toContain("var(--primary)");
    expect(converted.prototype).toContain("--text-light-muted");
    expect(converted.report.notes[0]).toBe("proposta «p01 · Brace» dal file «Trattoria», scritta con ACSS");
    expect(converted.report.notes).toContain("variabile senza corrispondenza in Histeon CSS, resta nel :root del prototipo: --text-light-muted");

    const checked = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html" }, body: converted.prototype });
    expect(checked.status, await checked.clone().text()).toBe(200);
    const result = await checked.json() as { outcome: string; report: { counts: Record<string, number>; warnings: string[] } };
    expect(result.outcome).toBe("create");
    expect(result.report.warnings).toEqual([]);
    expect(result.report.counts).toMatchObject({ pages: 1, components: 1, types: 1, records: 3, queries: 1 });
    const imported = await fetch(`${base}/api/cms/v1/projects/import-prototype?download=0`, { method: "POST", headers: { ...headers, "Content-Type": "text/html" }, body: converted.prototype });
    expect(imported.status, await imported.clone().text()).toBeLessThan(300);
    expect((await imported.json() as { project: { name: string } }).project.name).toBe("Trattoria · Brace");
  }, 60_000);

  it("Histeon: la proposta passa il controllo senza avvisi e tiene il primario del suo :root", async () => {
    const { base, headers } = await start();
    const id = await upload(base, headers, await fixture("proposte-histeon.html"));
    const converted = await (await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ proposal: "h01" }) })).json() as Converted;
    expect(converted.proposal).toEqual({ id: "h01", name: "Scaffale", framework: "histeon" });
    expect((manifestOf(converted.prototype).design as Record<string, string>).primary).toBe("oklch(55% 0.2 265)");
    expect(converted.prototype).not.toContain(":root");
    const checked = await (await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html" }, body: converted.prototype })).json() as { outcome: string; report: { counts: Record<string, number>; warnings: string[] } };
    expect(checked.outcome).toBe("create");
    expect(checked.report.warnings).toEqual([]);
    expect(checked.report.counts).toMatchObject({ components: 1, types: 1, records: 3 });
  }, 60_000);

  it("rispetta la struttura scelta, e rifiuta una proposta che non c'è o un file che non è di proposte", async () => {
    const { base, headers } = await start();
    const id = await upload(base, headers, await fixture("proposte-acss.html"));
    const flat = await (await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ proposal: "p01", structure: { parts: false, components: false, lists: false } }) })).json() as Converted;
    expect(flat.structureApplied).toEqual({ parts: false, components: false, lists: false });
    expect(flat.prototype).not.toContain("{#loop");
    const missing = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ proposal: "p09" }) });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: "cms-site-conversion-invalid", error: "Il file di proposte non ha la proposta «p09»." });
    // Without `proposal` the same file is converted as a plain page, as before.
    const plain = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: "{}" });
    expect(plain.status).toBe(200);
    expect((await plain.json() as Converted).proposal).toBeUndefined();
    const other = await upload(base, headers, Buffer.from("<!doctype html><html><body><h1>Un sito</h1></body></html>"));
    const refused = await fetch(`${base}/api/imports/${other}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ proposal: "p01" }) });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "cms-site-conversion-invalid", error: "Il file non è un file di proposte di kit proposte: manca il blocco kp-dati." });
  }, 60_000);
});
