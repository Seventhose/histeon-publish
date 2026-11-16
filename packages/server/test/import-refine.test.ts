import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalServer, type LocalServerHandle, type SecretStore } from "../src/server.js";
import { parseChoiceAnswers, parseRefineSettingsChange, readRefineSettings, REFINE_DEFAULTS } from "../src/import-refine.js";

/**
 * Doc 27, G3: «Rifinisci i nomi con un modello» from the routes the app uses. The local model is a fake
 * OpenAI-compatible server here; the Claude API provider has its own test (import-choices-anthropic.test.ts).
 */
const roots: string[] = [];
const fakes: Server[] = [];
let server: LocalServerHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
  await Promise.all(fakes.splice(0).map((fake) => new Promise<void>((resolve) => fake.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-refine-"));
  roots.push(root);
  return root;
}

const secrets = new Map<string, string>();
const memoryStore = (account: string): SecretStore => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => void secrets.set(account, value),
  delete: async () => void secrets.delete(account),
});

async function start(): Promise<{ base: string; headers: Record<string, string> }> {
  secrets.clear();
  const dataDirectory = await temporary();
  const uiDirectory = await temporary();
  await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
  server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, automaticCopies: false, secretStoreFactory: memoryStore, importRefine: { timeoutMs: 5_000 } });
  const base = `http://127.0.0.1:${server.port}`;
  return { base, headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" } };
}

const corpus = path.resolve("packages/cms/test/fixtures/import-corpus/utility-tailwind");
async function uploadCorpus(base: string, headers: Record<string, string>): Promise<string> {
  const files = await Promise.all(["index.html", "tw.css"].map(async (name) => ({ name, bytes: await readFile(path.join(corpus, name)) })));
  const plan = await (await fetch(`${base}/api/imports`, { method: "POST", headers, body: JSON.stringify({ name: "officina", kind: "directory", files: files.map((file) => ({ path: file.name, size: file.bytes.length })) }) })).json() as { id: string };
  for (const file of files) expect((await fetch(`${base}/api/imports/${plan.id}/files/${file.name}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: file.bytes })).status).toBe(201);
  return plan.id;
}

/** A fake llama-server: answers every batch with `answer(ids)`, and remembers what it was sent. */
async function fakeModel(answer: (ids: string[]) => Array<{ id: string; valore: string }>): Promise<{ url: string; seen: Array<{ key?: string; body: Record<string, unknown> }> }> {
  const seen: Array<{ key?: string; body: Record<string, unknown> }> = [];
  const fake = createServer((request: IncomingMessage, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push({ ...(request.headers.authorization ? { key: request.headers.authorization } : {}), body });
      const schema = (body.response_format as { json_schema: { schema: { properties: { scelte: { items: { properties: { id: { enum: string[] } } } } } } } }).json_schema.schema;
      const ids = schema.properties.scelte.items.properties.id.enum;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scelte: answer(ids) }) } }] }));
    });
  });
  fakes.push(fake);
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, seen };
}

interface Converted {
  prototype: string;
  choices: number;
  choicesApplied: Record<string, string>;
  choicesRejected: Array<{ id: string; motivo: string }>;
  refine?: { provider: string; model: string; rows: Array<{ id: string; before: string; after: string; kind: string }>; suggestions: unknown[]; rejected: Array<{ id: string; motivo: string; after?: string }>; batches: Array<{ ok: boolean; error?: string }> };
}

describe("impostazioni della rifinitura (Agente AI)", () => {
  it("predefinito Claude dal connettore; le chiavi vanno nel portachiavi e non tornano mai indietro", async () => {
    const { base, headers } = await start();
    const first = await (await fetch(`${base}/api/import-refine`, { headers })).json() as Record<string, unknown>;
    expect(first).toEqual({ ...REFINE_DEFAULTS, connectorEnabled: false, localKeyConfigured: false, haikuKeyConfigured: false, keyringAvailable: true });
    const saved = await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ provider: "haiku", localUrl: "http://127.0.0.1:18081/", localModel: "qwen3-30b-a3b", localKey: "chiave-locale", haikuKey: "sk-ant-prova" }) });
    const text = await saved.text();
    expect(saved.status, text).toBe(200);
    expect(text).not.toContain("chiave-locale");
    expect(text).not.toContain("sk-ant-prova");
    expect(JSON.parse(text)).toEqual({ provider: "haiku", connectorEnabled: false, localUrl: "http://127.0.0.1:18081", localModel: "qwen3-30b-a3b", localKeyConfigured: true, haikuKeyConfigured: true, keyringAvailable: true });
    expect(secrets.get("import-refine-local")).toBe("chiave-locale");
    expect(secrets.get("import-refine-anthropic")).toBe("sk-ant-prova");
    // null removes a key, absent leaves it.
    const removed = await (await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ haikuKey: null }) })).json() as Record<string, unknown>;
    expect(removed).toMatchObject({ provider: "haiku", localKeyConfigured: true, haikuKeyConfigured: false });
  });

  it("rifiuta indirizzi, modelli e chiavi che non vanno", async () => {
    const { base, headers } = await start();
    for (const body of [{ localUrl: "file:///etc/passwd" }, { localUrl: "http://utente:segreto@127.0.0.1:18080" }, { localUrl: "http://127.0.0.1:18080/?x=1" }, { provider: "openai" }, { localModel: "a b" }, { haikuKey: "due parole" }]) {
      const response = await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify(body) });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(readRefineSettings({ provider: "altro", localUrl: "ftp://x" })).toEqual(REFINE_DEFAULTS);
    expect(() => parseRefineSettingsChange({ localKey: "" }, REFINE_DEFAULTS)).toThrow(/chiave/u);
  });
});

describe("Rifinisci i nomi con un modello", () => {
  it("dà la tabella prima → dopo senza toccare il prototipo; poi le scelte applicate entrano nel prototipo", async () => {
    const { base, headers } = await start();
    const model = await fakeModel((ids) => [
      ...(ids.includes("classe:header__box") ? [{ id: "classe:header__box", valore: "testata__riquadro" }] : []),
      // Already the name of another element: the trial conversion leaves it out.
      ...(ids.includes("classe:header__link") ? [{ id: "classe:header__link", valore: "header__nav" }] : []),
      // Not a BEM name: refused by its shape.
      ...(ids.includes("classe:header__icon") ? [{ id: "classe:header__icon", valore: "Testata Icona" }] : []),
    ]);
    expect((await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ provider: "locale", localUrl: model.url, localKey: "chiave-locale" }) })).status).toBe(200);
    const id = await uploadCorpus(base, headers);
    const plain = await (await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: "{}" })).json() as Converted;
    expect(plain.choices).toBeGreaterThan(5);
    expect(plain.refine).toBeUndefined();
    expect(model.seen).toEqual([]);

    const response = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ refine: true }) });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain("chiave-locale");
    const refined = JSON.parse(text) as Converted;
    expect(refined.prototype).toBe(plain.prototype);
    expect(refined.refine?.provider).toBe("locale");
    expect(refined.refine?.model).toBe("qwen3-8b");
    expect(refined.refine?.rows).toEqual([expect.objectContaining({ id: "classe:header__box", kind: "classe", before: "header__box", after: "testata__riquadro" })]);
    const reasons = new Map(refined.refine?.rejected.map((item) => [item.id, item.motivo]));
    expect(reasons.get("classe:header__link")).toMatch(/già/u);
    expect(reasons.get("classe:header__icon")).toMatch(/non è un nome ammesso/u);
    expect(refined.refine?.batches.every((batch) => batch.ok)).toBe(true);
    expect(model.seen[0]?.key).toBe("Bearer chiave-locale");
    expect(model.seen[0]?.body.model).toBe("qwen3-8b");

    const applied = await (await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ choices: { "classe:header__box": "testata__riquadro" } }) })).json() as Converted;
    expect(applied.choicesApplied).toEqual({ "classe:header__box": "testata__riquadro" });
    expect(applied.choicesRejected).toEqual([]);
    expect(applied.prototype).toContain("testata__riquadro");
    expect(applied.prototype).not.toContain("header__box");
    const checked = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html" }, body: applied.prototype });
    expect(checked.status, await checked.clone().text()).toBe(200);
  }, 60_000);

  it("un modello spento è un lotto fallito, non un errore: il prototipo resta quello di sempre", async () => {
    const { base, headers } = await start();
    const model = await fakeModel(() => []);
    const url = model.url;
    await new Promise<void>((resolve) => (fakes.pop() as Server).close(() => resolve()));
    await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ provider: "locale", localUrl: url }) });
    const id = await uploadCorpus(base, headers);
    const refined = await (await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ refine: true }) })).json() as Converted;
    expect(refined.refine?.rows).toEqual([]);
    expect(refined.refine?.batches[0]).toMatchObject({ ok: false, error: expect.stringMatching(/non risponde: è acceso\?/u) });
  }, 60_000);

  it("Haiku senza chiave si ferma prima di chiedere; scelte malformate sono rifiutate", async () => {
    const { base, headers } = await start();
    await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ provider: "haiku" }) });
    const id = await uploadCorpus(base, headers);
    const missing = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ refine: true }) });
    expect(missing.status).toBe(409);
    // Claude through the connector, with the connector off: said at once, nothing waits.
    await fetch(`${base}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ provider: "connettore" }) });
    const off = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ refine: true }) });
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ code: "cms-import-refine-connector-off" });
    expect(await missing.text()).toContain("cms-import-refine-key-missing");
    const bad = await fetch(`${base}/api/imports/${id}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ choices: { "script:x": "y" } }) });
    expect(bad.status).toBe(400);
    expect(() => parseChoiceAnswers(Object.fromEntries(Array.from({ length: 401 }, (_, index) => [`classe:a${index}`, "b"])))).toThrow(/400/u);
    expect(() => parseChoiceAnswers(["classe:a"])).toThrow();
  }, 60_000);
});
