import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConvertedMedia } from "../src/converted-media.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

/** Doc 23 item 109: a converted site's media stay in the app, outside its prototype, until the import reads them. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];
let server: LocalServerHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-converted-"));
  roots.push(root);
  return root;
}

describe("media dei siti convertiti nell'app", () => {
  it("si tengono per impronta, solo per chi li ha scritti, e si rileggono controllati", async () => {
    const root = await temporary();
    const store = new ConvertedMedia(root);
    const hash = createHash("sha256").update(PNG).digest("hex");
    store.hold(PNG, hash);
    store.hold(PNG, hash);
    expect(Buffer.from(store.read(hash)!)).toEqual(PNG);
    const folder = path.join(root, "converted-media");
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(folder, hash))).mode & 0o777).toBe(0o600);
    expect(await readdir(folder)).toEqual([hash]);
    // A file changed on disk, a name that is not a hash: nothing comes back.
    await writeFile(path.join(folder, hash), "altro");
    expect(store.read(hash)).toBeNull();
    expect(store.read("../../etc/passwd")).toBeNull();
    expect(() => store.hold(PNG, "../fuori")).toThrow();
  });

  it("dopo due giorni senza uso un media si toglie", async () => {
    const root = await temporary();
    const store = new ConvertedMedia(root);
    const old = createHash("sha256").update("vecchio").digest("hex");
    store.hold(PNG, createHash("sha256").update(PNG).digest("hex"));
    await writeFile(path.join(root, "converted-media", old), "vecchio");
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(path.join(root, "converted-media", old), past, past);
    // The cleaning runs at most once an hour: a fresh store runs it at its first write.
    new ConvertedMedia(root).hold(Buffer.from("nuovo"), createHash("sha256").update("nuovo").digest("hex"));
    expect(await readdir(path.join(root, "converted-media"))).not.toContain(old);
  });

  it("un sito di 40 MB di immagini si converte, si controlla e si importa dalle rotte dell'app", async () => {
    const dataDirectory = await temporary();
    const uiDirectory = await temporary();
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, Origin: base };
    const images = Array.from({ length: 40 }, (_, index) => { const bytes = Buffer.alloc(1024 * 1024); PNG.copy(bytes); bytes[bytes.length - 1] = index + 1; return { name: `img/foto-${index}.png`, bytes }; });
    const page = `<!doctype html><html lang="it"><head><title>Grande</title></head><body><main class="galleria">${images.map((image) => `<img src="${image.name}" alt="Foto" width="1" height="1">`).join("")}</main></body></html>`;
    const files = [{ name: "index.html", bytes: Buffer.from(page) }, ...images];
    const plan = await (await fetch(`${base}/api/imports`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Grande", kind: "directory", files: files.map((file) => ({ path: file.name, size: file.bytes.length })) }) })).json() as { id: string };
    for (const file of files) expect((await fetch(`${base}/api/imports/${plan.id}/files/${file.name}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: file.bytes })).status).toBe(201);
    const converted = await fetch(`${base}/api/imports/${plan.id}/cms-prototype`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    expect(converted.status, await converted.clone().text()).toBe(200);
    const prototype = (await converted.json() as { prototype: string }).prototype;
    expect(prototype.length).toBeLessThan(1024 * 1024);
    expect(prototype).toContain("https://media.histos.invalid/");

    const checked = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html" }, body: prototype });
    expect(checked.status, await checked.clone().text()).toBe(200);
    const imported = await fetch(`${base}/api/cms/v1/projects/import-prototype?download=0`, { method: "POST", headers: { ...headers, "Content-Type": "text/html" }, body: prototype });
    expect(imported.status, await imported.clone().text()).toBeLessThan(300);
    const project = (await imported.json() as { project: { id: string } }).project;
    const media = await (await fetch(`${base}/api/cms/v1/projects/${project.id}/media`, { headers })).json() as unknown[];
    expect(media).toHaveLength(40);
  }, 120_000);
});
