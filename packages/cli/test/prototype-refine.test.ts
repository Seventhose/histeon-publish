import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/** Doc 27, G3: `histos-publish prototype rifinisci` against a fake OpenAI-compatible server. */
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CORPUS = fileURLToPath(new URL("../../cms/test/fixtures/import-corpus/utility-tailwind", import.meta.url));
const run = promisify(execFile);
const roots: string[] = [];
let fake: Server | null = null;
afterEach(async () => {
  if (fake) await new Promise<void>((resolve) => (fake as Server).close(() => resolve()));
  fake = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeModel(): Promise<{ url: string; keys: string[] }> {
  const keys: string[] = [];
  fake = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      keys.push(String(request.headers.authorization ?? ""));
      const body = JSON.parse(raw) as { response_format: { json_schema: { schema: { properties: { scelte: { items: { properties: { id: { enum: string[] } } } } } } } } };
      const ids = body.response_format.json_schema.schema.properties.scelte.items.properties.id.enum;
      const scelte = ids.includes("classe:header__box") ? [{ id: "classe:header__box", valore: "officina__testata" }, { id: "classe:header__link", valore: "header__nav" }] : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scelte }) } }] }));
    });
  });
  await new Promise<void>((resolve) => (fake as Server).listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${((fake as Server).address() as AddressInfo).port}`, keys };
}

async function site(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-rifinisci-"));
  roots.push(root);
  await cp(CORPUS, path.join(root, "officina"), { recursive: true });
  return path.join(root, "officina");
}

describe("histos-publish prototype rifinisci", () => {
  it("senza --scrivi stampa solo la tabella; con --scrivi scrive il prototipo coi nomi della tabella", async () => {
    const model = await fakeModel();
    const folder = await site();
    const env = { ...process.env, LLAMA_API_KEY: "chiave-cli" };
    const table = await run(process.execPath, [CLI, "prototype", "rifinisci", folder, "--indirizzo", model.url], { env });
    expect(table.stdout).toMatch(/header__box\s+→\s+officina__testata\s+\(classe\)/u);
    expect(table.stdout).toContain("classe:header__link → header__nav: il nome è già di un altro elemento");
    expect(table.stdout).toContain("ripeti con --scrivi");
    expect(model.keys[0]).toBe("Bearer chiave-cli");
    await expect(readFile(`${folder}-prototipo.html`)).rejects.toThrow();

    const written = await run(process.execPath, [CLI, "--json", "prototype", "rifinisci", folder, "--indirizzo", model.url, "--scrivi"], { env });
    const result = JSON.parse(written.stdout) as { output: string; rows: Array<{ after: string }>; choicesRejected: unknown[] };
    expect(result.output).toBe(`${folder}-prototipo.html`);
    expect(result.rows.map((row) => row.after)).toEqual(["officina__testata"]);
    expect(result.choicesRejected).toEqual([]);
    const html = await readFile(result.output, "utf8");
    expect(html).toContain("officina__testata");
    expect(html).not.toContain("header__box");
    // An existing prototype is never overwritten.
    await expect(run(process.execPath, [CLI, "prototype", "rifinisci", folder, "--indirizzo", model.url, "--scrivi"], { env })).rejects.toMatchObject({ code: 2 });
  }, 60_000);

  it("rifiuta un fornitore o un indirizzo sbagliati, e -o senza --scrivi", async () => {
    const folder = await site();
    const env = { ...process.env, ANTHROPIC_API_KEY: "" };
    await expect(run(process.execPath, [CLI, "prototype", "rifinisci", folder, "--fornitore", "openai"], { env })).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, [CLI, "prototype", "rifinisci", folder, "--indirizzo", "file:///etc"], { env })).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, [CLI, "prototype", "rifinisci", folder, "-o", "x.html"], { env })).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});
