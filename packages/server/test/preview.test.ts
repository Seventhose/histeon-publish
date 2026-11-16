import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

const FIXTURE = path.resolve(import.meta.dirname, "../../cms/test/fixtures/prototipo-esempio.html");

/**
 * The preview of a CMS build (queue item E3): the built site addresses pages and media from the root, the preview
 * lives under /__preview/<ticket>/<build>/, and every image, stylesheet address and internal link must stay inside it.
 */
describe("anteprima delle build CMS", () => {
  let server: LocalServerHandle;
  let dataDirectory: string;
  let base: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-preview-"));
    const uiDirectory = path.join(dataDirectory, "ui");
    await mkdir(uiDirectory);
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>App</title><p>APP-SHELL</p>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  async function api(pathname: string, init: { method?: string; body?: string | Buffer; type?: string } = {}): Promise<Response> {
    return fetch(`${base}${pathname}`, {
      method: init.method ?? "GET",
      headers: { "X-Histos-Token": server.token, Origin: base, ...(init.type ? { "Content-Type": init.type } : {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  }

  async function buildPreview(): Promise<{ previewUrl: string; prefix: string }> {
    const imported = await (await api("/api/cms/v1/projects/import-prototype", { method: "POST", type: "text/html", body: await readFile(FIXTURE) })).json() as { project: { id: string } };
    const build = await (await api(`/api/cms/v1/projects/${imported.project.id}/build`, { method: "POST", type: "application/json", body: "{}" })).json() as { previewUrl: string };
    const prefix = new URL(build.previewUrl).pathname.replace(/index\.html$/u, "").replace(/\/$/u, "");
    return { previewUrl: build.previewUrl, prefix };
  }

  it("ogni immagine e ogni link interno della home restano dentro l'anteprima e rispondono", async () => {
    const { previewUrl, prefix } = await buildPreview();
    const home = await fetch(previewUrl);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const html = await home.text();
    const addresses = [...html.matchAll(/(?:src|href)="([^"]+)"|url\(["']?([^"')]+)["']?\)/gu)].map((match) => (match[1] ?? match[2]) as string).filter((address) => address.startsWith("/"));
    expect(addresses.length).toBeGreaterThan(3);
    for (const address of addresses) expect(address.startsWith(`${prefix}/`), address).toBe(true);
    for (const address of new Set(addresses)) {
      const response = await fetch(`${base}${address}`);
      expect(response.status, address).toBe(200);
      const type = response.headers.get("content-type") ?? "";
      if (address.includes("/media/")) expect(type, address).toMatch(/^image\//u);
      else {
        expect(type, address).toMatch(/^text\/html/u);
        expect(await response.text(), address).not.toContain("APP-SHELL");
      }
    }
  });

  it("una cartella senza barra finale si reindirizza, i file nascosti della build no", async () => {
    const { prefix } = await buildPreview();
    const folder = await fetch(`${base}${prefix}/opera`, { redirect: "manual" });
    expect(folder.status).toBe(308);
    expect(folder.headers.get("location")).toBe(`${prefix}/opera/`);
    expect((await fetch(`${base}${prefix}/opera/`)).status).toBe(200);
    expect((await fetch(`${base}${prefix}/`)).status).toBe(200);
    for (const hidden of [".histos-publish/meta.json", "opera/.histos-publish/meta.json", ".histos-publish/"]) {
      expect((await fetch(`${base}${prefix}/${hidden}`)).status, hidden).toBe(404);
    }
  });

  it("serve una pagina senza estensione come fanno gli host con indirizzi puliti, e i font con CORS", async () => {
    const { prefix } = await buildPreview();
    const buildId = prefix.split("/").at(-1) as string;
    const projects = await (await api("/api/cms/v1/projects")).json() as { projects: Array<{ id: string }> };
    const root = path.join(dataDirectory, "histos-cms-builds", projects.projects[0]?.id as string, buildId);
    await writeFile(path.join(root, "pagina-pulita.html"), `<!doctype html><img src="/media/x.png"><a href="/opera/">Opere</a>`);
    await mkdir(path.join(root, "fonts"), { recursive: true });
    await writeFile(path.join(root, "fonts", "f.woff2"), Buffer.from("wOF2"));
    const clean = await fetch(`${base}${prefix}/pagina-pulita`);
    expect(clean.status).toBe(200);
    expect(await clean.text()).toContain(`href="${prefix}/opera/"`);
    const font = await fetch(`${base}${prefix}/fonts/f.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${base}${prefix}/opera/`)).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("la build su disco resta quella da pubblicare: la riscrittura vale solo per l'anteprima", async () => {
    const { prefix } = await buildPreview();
    const buildId = prefix.split("/").at(-1) as string;
    const projects = await (await api("/api/cms/v1/projects")).json() as { projects: Array<{ id: string }> };
    const onDisk = await readFile(path.join(dataDirectory, "histos-cms-builds", projects.projects[0]?.id as string, buildId, "index.html"), "utf8");
    expect(onDisk).not.toContain("/__preview/");
    expect(onDisk).toMatch(/src="\/media\//u);
    const head = await fetch(`${base}${prefix}/`, { method: "HEAD" });
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength((await (await fetch(`${base}${prefix}/`)).text()), "utf8"));
  });
});
