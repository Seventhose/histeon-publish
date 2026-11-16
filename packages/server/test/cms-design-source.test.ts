import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designPrototypeId } from "@histos-publish/cms";
import { siteCanvas, zip as figZip } from "../../cms/test/fig-writer.js";
import { id, siteEntries, siteShapes, zip } from "../../cms/test/penpot-writer.js";
import { designSourceChoice, designSourceFileName, designSourceName } from "../src/cms-design-source.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

describe("scelte di «Nuovo sito da Penpot o Figma»", () => {
  it("il nome di un file caricato non è mai un percorso, e il nome del prototipo è uno slug", () => {
    expect(designSourceName("C:\\Lavori\\..\\Kit del negozio.fig")).toBe("Kit del negozio.fig");
    expect(designSourceName("/tmp/a/../kit.penpot\u0000")).toBe("kit.penpot");
    expect(designSourceName(null)).toBe("file di design");
    expect(designSourceName("x".repeat(500))).toHaveLength(200);
    expect(designSourceFileName("Kit del negozio.fig", "Home / Desktop")).toBe("kit-del-negozio-home-desktop.html");
    expect(designSourceFileName("Città.PENPOT", "Prezzi è così")).toBe("citta-prezzi-e-cosi.html");
    expect(designSourceFileName("…", "")).toBe("prototipo.html");
  });

  it("legge pagina, riquadro e le tre scelte dall'indirizzo, e rifiuta il resto", () => {
    const choice = (query: string) => designSourceChoice(new URLSearchParams(query));
    expect(choice("page=Home")).toEqual({ page: "Home", frame: "", components: true, records: true, uniform: false });
    expect(choice("page=%20Sito%20&frame=4%3A12&components=0&records=0&uniform=1")).toEqual({ page: "Sito", frame: "4:12", components: false, records: false, uniform: true });
    const refused = expect.objectContaining({ code: "cms-design-source-invalid", exitCode: 400 });
    expect(() => choice("frame=Home")).toThrowError(refused);
    expect(() => choice(`page=${"x".repeat(301)}`)).toThrowError(refused);
    expect(() => choice("page=Home&uniform=si")).toThrowError(refused);
    expect(() => choice("page=Home&components=false")).toThrowError(refused);
  });
});

/** The page of penpot-writer.ts with three copies of its card in a row (the second one fills), and no button. */
function threeCards(): Array<Record<string, unknown>> {
  const shapes = siteShapes().filter((shape) => ![id(60), id(61), id(62)].includes(String(shape.id)));
  const by = (n: number) => shapes.find((shape) => shape.id === id(n))!;
  const moved = (n: number, to: number, title?: string) => {
    const copy = JSON.parse(JSON.stringify(by(n))) as { id: string; x: number; selrect: { x: number }; shapes?: string[]; content?: { children: Array<{ children: Array<{ children: Array<{ text: string }> }> }> } };
    copy.id = id(to);
    copy.x += 324;
    copy.selrect.x += 324;
    if (copy.shapes) copy.shapes = [id(to + 1), id(to + 2)];
    if (title && copy.content) copy.content.children[0]!.children[0]!.children[0]!.text = title;
    return copy;
  };
  shapes.push(moved(44, 70), moved(45, 71, "Terza"), moved(46, 72));
  by(33).shapes = [id(70), id(44), id(40)];
  return shapes;
}

describe("rotte design-file", () => {
  let dataDirectory = "";
  let uiDirectory = "";
  let server: LocalServerHandle | null = null;
  let base = "";
  let headers: Record<string, string> = {};

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-design-source-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-design-source-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
    base = `http://127.0.0.1:${server.port}`;
    headers = { "X-Histos-Token": server.token, "Content-Type": "application/octet-stream", Origin: base };
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    await Promise.all([rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(uiDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  const send = (route: string, query: string, bytes: Uint8Array | string, extra: Record<string, string> = {}) => fetch(`${base}/api/cms/v1/design-file/${route}?${query}`, { method: "POST", headers: { ...headers, ...extra }, body: bytes });
  const projects = async () => (await (await fetch(`${base}/api/cms/v1/projects`, { headers })).json() as { projects: unknown[] }).projects;

  it("elenca pagine e riquadri di un .penpot e di un .fig, senza salvare niente", async () => {
    const penpot = await send("pages", "name=sito.penpot", await zip(siteEntries()));
    expect(penpot.status).toBe(200);
    const listed = await penpot.json() as { source: string; truncated: boolean; pages: Array<{ id: string; name: string; frames: Array<{ id: string; name: string; width: number; height: number; layers: number }> }> };
    expect(listed).toMatchObject({ source: "penpot", truncated: false, pages: [{ name: "Home", frames: [{ name: "Home", width: 1200, height: 760 }] }] });
    expect(listed.pages[0]!.frames[0]!.layers).toBeGreaterThan(5);

    const fig = await send("pages", `name=${encodeURIComponent("/percorso/Bottega.fig")}`, await figZip({ "canvas.fig": siteCanvas(), "meta.json": JSON.stringify({ file_name: "Bottega" }) }));
    expect(fig.status).toBe(200);
    const figList = await fig.json() as { file: string; source: string; pages: Array<{ name: string; frames: Array<{ name: string }> }> };
    expect(figList).toMatchObject({ file: "Bottega", source: "figma" });
    expect(figList.pages.map((page) => page.name)).toEqual(["Sito"]);
    expect(figList.pages[0]!.frames.map((frame) => frame.name)).toContain("Home");
    expect(await projects()).toEqual([]);
  }, 60_000);

  it("un riquadro diventa un prototipo che supera il controllo dell'import, con l'id della riga di comando", async () => {
    const bytes = await zip(siteEntries());
    const made = await send("prototype", "name=sito.penpot&page=Home", bytes);
    expect(made.status).toBe(200);
    const view = await made.json() as { id: string; fileName: string; html: string; report: string; page: string; frame: string; source: string; components: boolean; records: boolean; uniform: boolean };
    expect(view).toMatchObject({ id: designPrototypeId("sito.penpot", "Home", "Home"), fileName: "sito-home.html", page: "Home", frame: "Home", source: "penpot", components: true, records: true, uniform: false });
    expect(view.html).toContain('data-histos-prototype="1"');
    expect(view.html).toContain(`"id":"${view.id}"`);
    expect(view.report).toContain("riquadro «Home» (Penpot, 1200 px)");
    expect(view.report).toContain("Blocchi scritti: header, hero, cards, footer.");
    expect(view.report).toContain("Stili del file non usati: sito.penpot: il file Penpot non ha colori, tipografie né token nella libreria.");
    // The same answer goes to the check of a prototype, as the app sends it.
    const check = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: view.html });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ outcome: "create", report: { project: { id: view.id } } });
    expect(await projects()).toEqual([]);
    expect((await readdir(dataDirectory)).filter((name) => /\.(?:penpot|fig|html)$/u.test(name))).toEqual([]);
  }, 120_000);

  it("le scelte arrivano alla conversione: senza componenti, senza record, schede uniformi", async () => {
    const bytes = await zip(siteEntries(threeCards()));
    const ask = async (query: string) => {
      const response = await send("prototype", `name=schede.penpot&page=Home&frame=Home${query}`, bytes);
      expect(response.status).toBe(200);
      return await response.json() as { id: string; html: string; report: string; components: boolean; records: boolean; uniform: boolean; fileName: string };
    };
    const whole = await ask("");
    expect(whole.fileName).toBe("schede-home.html");
    expect(whole.report).toContain("Riconosciuti come componenti del prototipo: 1 («Card»).");
    expect(whole.report).toContain("varianti come modificatori: --2");
    expect(whole.html).toContain('<template data-histos="component" data-ref="card"');
    // Without components every copy stays in the markup of its block; the id is the one of the frame all the same.
    const plain = await ask("&components=0&records=0");
    expect(plain).toMatchObject({ id: whole.id, components: false, records: false, uniform: false });
    expect(plain.html).not.toContain('data-histos="component"');
    expect(plain.report).toContain("Riconosciuti come componenti del prototipo: 0.");
    // Uniform cards take the look of the first one: the numbered modifier goes, and the report says so.
    const uniform = await ask("&uniform=1");
    expect(uniform).toMatchObject({ id: whole.id, components: true, uniform: true });
    expect(uniform.report).toContain("hanno preso tutte lo stile della prima");
    expect(uniform.report).not.toContain("varianti come modificatori");
    // This file has no cards that become records: the choice is taken and changes nothing here (design-components.test.ts covers it).
    const uses = await ask("&records=0");
    expect(uses).toMatchObject({ records: false });
    expect(uses.html).toBe(whole.html);
  }, 120_000);

  it("rifiuta un file che non è un design, una pagina che non c'è, le scelte sbagliate e chi non ha il token dell'app", async () => {
    const bytes = await zip(siteEntries());
    const notDesign = await send("pages", "name=appunti.penpot", "non sono un file di design");
    expect(notDesign.status).toBe(400);
    expect(await notDesign.json()).toMatchObject({ code: "cms-design-source-invalid" });
    const noPage = await send("prototype", "name=sito.penpot&page=Manca", bytes);
    expect(noPage.status).toBe(400);
    expect(await noPage.json()).toMatchObject({ code: "cms-design-source-invalid", error: expect.stringContaining("sito.penpot") });
    expect((await send("prototype", "name=sito.penpot", bytes)).status).toBe(400);
    expect((await send("prototype", "name=sito.penpot&page=Home&records=forse", bytes)).status).toBe(400);
    expect((await fetch(`${base}/api/cms/v1/design-file/pages?name=sito.penpot`, { headers })).status).toBe(405);
    expect((await send("altro", "name=sito.penpot", bytes)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/cms/v1/design-file/pages?name=sito.penpot`, { method: "POST", headers: { Origin: base, "Content-Type": "application/octet-stream" }, body: bytes })).status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});
