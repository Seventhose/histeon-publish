import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFigmaMock, type FigmaMockHandle } from "../../cf-mock/src/figma.js";
import { sampleCanvas, zip } from "../../cms/test/fig-writer.js";
import { planTokenImport } from "../src/cms-token-import.js";
import { FIGMA_TOKEN_ACCOUNT, tokenSourceName, tokenSourceNotes } from "../src/cms-token-source.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

// Not a real token: the shape of one, for the stand-in only.
const TOKEN = "figd_prova-NONVERO_0123456789abcdefABCDEF";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const rgb = (hex: string) => ({ r: Number.parseInt(hex.slice(1, 3), 16) / 255, g: Number.parseInt(hex.slice(3, 5), 16) / 255, b: Number.parseInt(hex.slice(5, 7), 16) / 255, a: 1 });
const FIGMA_FILE = {
  file: {
    name: "Kit dell'API",
    document: { id: "0:0", type: "DOCUMENT", children: [{ id: "0:1", type: "CANVAS", name: "Home", children: [{ id: "5:1", type: "RECTANGLE", name: "Fondo", styles: { fill: "1:1" } }] }] },
    styles: { "1:1": { key: "a", name: "Colors/Primary", styleType: "FILL" }, "2:1": { key: "b", name: "Body/Base", styleType: "TEXT" } },
  },
  nodes: {
    "1:1": { document: { id: "1:1", type: "RECTANGLE", fills: [{ type: "SOLID", color: rgb("#1D4ED8") }] } },
    "2:1": { document: { id: "2:1", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 19, lineHeightPercentFontSize: 150, lineHeightUnit: "FONT_SIZE_%" } } },
  },
};

describe("note delle fonti dei token", () => {
  it("tiene solo testi corti, e il rapporto li porta in cima", () => {
    expect(tokenSourceNotes(undefined)).toEqual([]);
    expect(() => tokenSourceNotes("no")).toThrowError(expect.objectContaining({ code: "cms-tokens-import-invalid" }));
    expect(tokenSourceNotes([{ summary: `Kit\u0000 letto${"x".repeat(5000)}`, problems: [{ token: "A", why: "non è un token" }, { token: 4 }, "no"] }, 7])).toEqual([
      { summary: `Kit letto${"x".repeat(1991)}`, problems: [{ token: "A", why: "non è un token" }] },
      { summary: "", problems: [] },
    ]);
    const plan = planTokenImport({ head: "r1", files: [{ name: "a.json", text: JSON.stringify({ color: { $type: "color", primary: { $value: "#1d4ed8" } } }) }], sources: [{ summary: "Kit: file Penpot, 1 colore.", problems: [{ token: "Sfumato", why: "non è un token" }] }] }, {});
    expect(plan.view.text.startsWith("Kit: file Penpot, 1 colore.\n\n")).toBe(true);
    expect(plan.view.report.skipped).toContainEqual({ token: "Sfumato", why: "non è un token" });
  });

  it("il nome di un file caricato non è mai un percorso", () => {
    expect(tokenSourceName("../../etc/Kit\u0007 uno.fig")).toBe("Kit uno.fig");
    expect(tokenSourceName("C:\\Utenti\\x\\kit.penpot")).toBe("kit.penpot");
    expect(tokenSourceName(null)).toBe("file di design");
  });
});

describe("fonti dei token: file di design e API di Figma", () => {
  let server: LocalServerHandle | null = null;
  let mock: FigmaMockHandle | null = null;
  let leaky: FigmaMockHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let base: string;
  let headers: Record<string, string>;
  let prefix: string;
  const secrets = new Map<string, string>();
  const savedBase = process.env.HISTOS_FIGMA_API_BASE;
  const savedToken = process.env.HISTOS_FIGMA_API_TOKEN;

  beforeEach(async () => {
    delete process.env.HISTOS_FIGMA_API_TOKEN;
    secrets.clear();
    mock = await startFigmaMock({ token: TOKEN, files: { [KEY]: FIGMA_FILE } });
    leaky = await startFigmaMock({ token: `${TOKEN}-altro`, echoToken: true, files: { [KEY]: FIGMA_FILE } });
    process.env.HISTOS_FIGMA_API_BASE = mock.origin;
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-token-source-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-token-source-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    server = await startLocalServer({
      dataDirectory,
      uiDirectory,
      openBrowser: false,
      secretStoreFactory: (account) => ({
        get: async () => secrets.get(account) ?? null,
        set: async (value) => { secrets.set(account, value); },
        delete: async () => { secrets.delete(account); },
      }),
    });
    base = `http://127.0.0.1:${server.port}`;
    headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Fonti dei token" }) });
    prefix = `${base}/api/cms/v1/projects/${(await created.json() as { project: { id: string } }).project.id}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedBase === undefined) delete process.env.HISTOS_FIGMA_API_BASE;
    else process.env.HISTOS_FIGMA_API_BASE = savedBase;
    if (savedToken !== undefined) process.env.HISTOS_FIGMA_API_TOKEN = savedToken;
    if (server) await server.close();
    server = null;
    await Promise.all([mock?.close(), leaky?.close()]);
    await Promise.all([rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(uiDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  const upload = (name: string, bytes: Uint8Array) => fetch(`${prefix}/tokens/source/file?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes });

  it("legge un file .fig e un file .penpot caricati, e l'importazione ne porta il riassunto nel rapporto", async () => {
    const fig = await upload("Kit.fig", await zip({ "canvas.fig": sampleCanvas(), "meta.json": JSON.stringify({ file_name: "Kit di prova" }) }));
    expect(fig.status).toBe(200);
    const figBody = await fig.json() as { kind: string; summary: string; problems: unknown[]; files: Array<{ name: string; text: string }> };
    expect(figBody.kind).toBe("figma");
    expect(figBody.summary).toContain("Kit di prova: file .fig di Figma");
    expect(figBody.files.length).toBeGreaterThan(0);

    const id = "11111111-1111-4111-8111-111111111111";
    const penpot = await upload("kit.penpot", await zip({
      "manifest.json": JSON.stringify({ type: "penpot/export-files", version: 1, generatedBy: "penpot/2.5.4", files: [{ id, name: "Kit Penpot" }] }),
      [`files/${id}/colors/22222222-2222-4222-8222-222222222222.json`]: JSON.stringify({ name: "Primary", path: "Primary", color: "#6750a4", opacity: 1 }),
    }));
    expect(penpot.status).toBe(200);
    const penpotBody = await penpot.json() as { kind: string; summary: string; problems: unknown[]; files: Array<{ name: string; text: string }> };
    expect(penpotBody).toMatchObject({ kind: "penpot", summary: expect.stringContaining("Kit Penpot: file Penpot (penpot/2.5.4), 1 colore") });

    const { head } = await (await fetch(`${prefix}/tokens`, { headers })).json() as { head: string };
    const imported = await fetch(`${prefix}/tokens/import`, { method: "POST", headers, body: JSON.stringify({ head, files: penpotBody.files, sources: [{ summary: penpotBody.summary, problems: penpotBody.problems }], apply: true }) });
    expect(imported.status).toBe(200);
    const importedBody = await imported.json() as { applied: boolean; text: string; counts: { parameters: number } };
    expect(importedBody.applied).toBe(true);
    expect(importedBody.text.startsWith("Kit Penpot: file Penpot")).toBe(true);
    expect(importedBody.counts.parameters).toBeGreaterThan(0);

    const refused = await upload("../finto.fig", Buffer.from("PK\u0003\u0004 non è un archivio"));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "cms-tokens-source-invalid", error: expect.stringContaining("finto.fig:") });
    expect((await fetch(`${prefix}/tokens/source/file`, { method: "POST", headers: { Origin: base, "Content-Type": "application/octet-stream" }, body: "x" })).status).toBeGreaterThanOrEqual(400);
  });

  it("il token di Figma: stato, salvataggio dopo la verifica, rimozione", async () => {
    const tokenUrl = `${base}/api/cms/v1/figma-token`;
    expect(await (await fetch(tokenUrl, { headers })).json()).toEqual({ token: { configured: false, source: null, available: true } });
    const missing = await fetch(`${prefix}/tokens/source/figma`, { method: "POST", headers, body: JSON.stringify({ figma: KEY }) });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "cms-figma-token-missing" });

    const wrong = await fetch(tokenUrl, { method: "POST", headers, body: JSON.stringify({ token: `${TOKEN}-sbagliato` }) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "cms-figma-token-refused", error: "Figma non riconosce questo token." });
    expect((await fetch(tokenUrl, { method: "POST", headers, body: JSON.stringify({ token: "corto" }) })).status).toBe(400);
    expect(secrets.has(FIGMA_TOKEN_ACCOUNT)).toBe(false);

    const saved = await fetch(tokenUrl, { method: "POST", headers, body: JSON.stringify({ token: ` ${TOKEN} ` }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ token: { configured: true, source: "keyring", available: true }, handle: "Prova" });
    expect(secrets.get(FIGMA_TOKEN_ACCOUNT)).toBe(TOKEN);
    expect(await (await fetch(tokenUrl, { headers })).json()).toEqual({ token: { configured: true, source: "keyring", available: true } });

    expect(await (await fetch(tokenUrl, { method: "DELETE", headers })).json()).toEqual({ token: { configured: false, source: null, available: true } });
    expect(secrets.has(FIGMA_TOKEN_ACCOUNT)).toBe(false);
    // Without the token of the app, none of this answers.
    expect((await fetch(tokenUrl, { headers: { Origin: base } })).status).toBeGreaterThanOrEqual(400);
  });

  it("legge un file di Figma dall'API, e il token non compare in risposte, rapporti, log e file", async () => {
    const said: string[] = [];
    const keep = (...parts: unknown[]) => { said.push(parts.map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : typeof part === "string" ? part : JSON.stringify(part))).join(" ")); };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(keep);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        said.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
        return (write as (...all: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    const bodies: string[] = [];
    const call = async (url: string, init: RequestInit) => {
      const response = await fetch(url, init);
      const text = await response.text();
      bodies.push(text, JSON.stringify([...response.headers]));
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    };
    const tokenUrl = `${base}/api/cms/v1/figma-token`;
    expect((await call(tokenUrl, { method: "POST", headers, body: JSON.stringify({ token: TOKEN }) })).status).toBe(200);

    const read = await call(`${prefix}/tokens/source/figma`, { method: "POST", headers, body: JSON.stringify({ figma: `https://www.figma.com/design/${KEY}/Kit?node-id=0-1` }) });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ kind: "figma", summary: expect.stringContaining("Kit dell'API: file di Figma letto dall’API, 1 stile di colore, 1 stile di testo") });
    expect(read.body.problems).toContainEqual({ token: "Variabili", why: expect.stringContaining("Enterprise") });
    // The token went to the stand-in, in its header, and nowhere else.
    expect(mock!.requests.length).toBeGreaterThanOrEqual(4);
    expect(mock!.requests.every((request) => request.token === TOKEN && !request.url.includes(TOKEN))).toBe(true);

    const { head } = (await call(`${prefix}/tokens`, { headers })).body as { head: string };
    const applied = await call(`${prefix}/tokens/import`, { method: "POST", headers, body: JSON.stringify({ head, files: read.body.files, sources: [{ summary: read.body.summary, problems: read.body.problems }], apply: true }) });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: true, design: { text_max: 19 } });
    expect(String(applied.body.text)).toContain("Kit dell'API: file di Figma letto dall’API");

    // Refusals: an address that is not of Figma, a file that is not there, and a server that repeats the token it got.
    expect((await call(`${prefix}/tokens/source/figma`, { method: "POST", headers, body: JSON.stringify({ figma: `https://evil.example/design/${KEY}` }) })).status).toBe(400);
    const absent = await call(`${prefix}/tokens/source/figma`, { method: "POST", headers, body: JSON.stringify({ figma: "ZzZzZzZzZzZzZzZzZzZz" }) });
    expect(absent).toMatchObject({ status: 502, body: { code: "figma-api" } });
    process.env.HISTOS_FIGMA_API_BASE = leaky!.origin;
    const leaked = await call(`${prefix}/tokens/source/figma`, { method: "POST", headers, body: JSON.stringify({ figma: KEY }) });
    expect(leaked.status).toBe(502);
    expect(String(leaked.body.error)).toContain("[token rimosso]");
    expect(leaky!.requests.at(-1)?.token).toBe(TOKEN);
    const leakedSave = await call(tokenUrl, { method: "POST", headers, body: JSON.stringify({ token: `${TOKEN}-nuovo` }) });
    expect(leakedSave.status).toBe(400);
    expect(JSON.stringify(leakedSave.body)).not.toContain(`${TOKEN}-nuovo`);

    await server!.close();
    server = null;
    const files: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    await walk(dataDirectory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect((await readFile(file)).includes(TOKEN), file).toBe(false);
    expect(bodies.join("\n")).not.toContain(TOKEN);
    expect(said.join("\n")).not.toContain(TOKEN);
    // The only place it is kept: the keyring.
    expect(secrets.get(FIGMA_TOKEN_ACCOUNT)).toBe(TOKEN);
  });
});
