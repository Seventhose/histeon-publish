import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RENDERED_CAPTURE_SCRIPT } from "@histos-publish/cms";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturedProposalSite, proposalFrameCsp, ProposalFrames, proposalFrameDocument } from "../src/proposal-frame.js";
import { keepProposal, keptPageAddress, readKeptProposal } from "../src/proposal-store.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

/**
 * «Fotografa la proposta» in the app: the proposal alive in a sealed frame (`/__capture/<ticket>/` on an origin of its
 * own), and the pages it sends back turned into an upload the importer converts. The proposal here is invented: a viewer whose scripts write
 * the page into a frame.
 */
const VIEWER = `<!-- bozza --><!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><title>Proposte</title></head>
<body><iframe id="vista" title="Proposta"></iframe>
<script>/* ${"x".repeat(4200)} */ document.getElementById("vista").contentDocument.write("<h1>Trattoria</h1>");</script></body></html>`;

const page = (title: string, body: string): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title><style>h1{color:#a22}</style></head><body>${body}</body></html>`;

describe("il documento servito nel riquadro", () => {
  it("porta il ponte subito dopo il doctype, prima di tutto ciò che è della proposta", () => {
    const served = proposalFrameDocument(VIEWER);
    const bridge = served.indexOf("<script data-histos-capture-bridge>");
    expect(bridge).toBe(VIEWER.indexOf("<html"));
    expect(served.slice(0, bridge)).toBe("<!-- bozza --><!DOCTYPE html>");
    expect(served.endsWith(VIEWER.slice(VIEWER.indexOf("<html")))).toBe(true);
    // Without a doctype the bridge is the first thing of the file.
    expect(proposalFrameDocument("<p>Ciao</p>").startsWith("<script data-histos-capture-bridge>")).toBe(true);
  });

  it("lo script di cattura non può chiudere il suo elemento script né aprire un commento", () => {
    expect(RENDERED_CAPTURE_SCRIPT).not.toMatch(/<\/script|<!--/iu);
    const served = proposalFrameDocument("<!doctype html><p>Ciao</p>");
    expect(served.match(/<\/script>/giu)).toHaveLength(1);
    expect(served.endsWith("</script><p>Ciao</p>")).toBe(true);
  });

  it("la politica non dà niente del server che la serve e chiude connessioni, moduli e finestre", () => {
    const policy = proposalFrameCsp(["http://127.0.0.1:4100", "app:"]);
    expect(policy).not.toContain("'self'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline' 'unsafe-eval';");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors http://127.0.0.1:4100 app:;");
    // Its own origin (the capture port), so a viewer can write into its inner frame; nothing else is allowed.
    expect(policy).toMatch(/; sandbox allow-scripts allow-same-origin$/u);
    expect(policy).not.toMatch(/allow-forms|allow-popups|allow-top-navigation|allow-modals|allow-downloads/u);
    expect(proposalFrameCsp([])).toContain("frame-ancestors 'none';");
  });
});

describe("i biglietti del riquadro", () => {
  it("un biglietto vale per un solo indirizzo e muore con il suo caricamento", () => {
    const frames = new ProposalFrames();
    const first = frames.open("a");
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(frames.importOf(`/__capture/${first}/`)).toBe("a");
    expect(frames.importOf(`/__capture/${first}`)).toBeNull();
    expect(frames.importOf(`/__capture/${first}/altro`)).toBeNull();
    expect(frames.importOf(`/__capture/${first}/../`)).toBeNull();
    // A second frame for the same upload replaces the first.
    const second = frames.open("a");
    expect(frames.importOf(`/__capture/${first}/`)).toBeNull();
    expect(frames.importOf(`/__capture/${second}/`)).toBe("a");
    frames.closeFor("a");
    expect(frames.importOf(`/__capture/${second}/`)).toBeNull();
  });

  it("non tiene più di otto riquadri aperti", () => {
    const frames = new ProposalFrames();
    const tickets = Array.from({ length: 9 }, (_, index) => frames.open(`upload-${index}`));
    expect(frames.importOf(`/__capture/${tickets[0]}/`)).toBeNull();
    expect(frames.importOf(`/__capture/${tickets[8]}/`)).toBe("upload-8");
  });
});

describe("le pagine tornate dal riquadro", () => {
  it("diventano un sito statico con i link collegati e le note di ogni pagina", () => {
    const captured = capturedProposalSite([
      { name: "", hash: "#p01/home", html: page("Home", '<h1>Trattoria</h1><a href="#" data-go="menu">Il menu</a>'), notes: ["1 canvas diventato un'immagine ferma"] },
      { name: "  Il   menu ", hash: "#p01/menu", html: page("Menu", '<h1>Menu</h1><a href="#p01/home">Home</a>'), title: "Menu" },
    ]);
    expect(captured.site.pages.map((item) => [item.name, item.path, item.links])).toEqual([["Home", "index.html", 1], ["Il menu", "il-menu/index.html", 1]]);
    expect(new TextDecoder().decode(captured.site.files[0]?.bytes)).toContain('href="il-menu/"');
    expect(captured.notes[0]).toBe("proposta fotografata: 2 pagine (Home, Il menu)");
    expect(captured.notes).toContain("Home: 1 canvas diventato un'immagine ferma");
  });

  it("rifiuta ciò che non è una cattura, con un messaggio per la persona", () => {
    expect(() => capturedProposalSite([])).toThrow("Aggiungi almeno una pagina della proposta.");
    expect(() => capturedProposalSite("x")).toThrow("Aggiungi almeno una pagina della proposta.");
    expect(() => capturedProposalSite(Array.from({ length: 21 }, () => ({ name: "A", hash: "", html: page("A", "a") })))).toThrow("Una proposta porta al più 20 pagine.");
    expect(() => capturedProposalSite([{ name: "Home", hash: "", html: 7 }])).toThrow("Pagina Home: La pagina non ha restituito la cattura.");
    expect(() => capturedProposalSite([null])).toThrow("Pagina 1: non è una pagina catturata.");
  });

  it("un frammento che non è un frammento non collega niente", () => {
    const captured = capturedProposalSite([{ name: "Home", hash: "javascript:alert(1)", html: page("Home", "<h1>A</h1>") }]);
    expect(captured.site.pages[0]?.hash).toBe("");
  });
});

describe("la cattura conservata nel progetto", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "histos-kept-proposal-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("sta in proposal/ con le sue pagine, e una nuova prende il posto della vecchia", async () => {
    expect(await readKeptProposal(directory)).toBeNull();
    const files = [{ path: "index.html", bytes: encode(page("Home", "<h1>A</h1>")) }, { path: "menu/index.html", bytes: encode(page("Menu", "<h1>B</h1>")) }];
    const pages = [{ name: "Home", path: "index.html", hash: "#p01/home" }, { name: "Menu", path: "menu/index.html", hash: "#p01/menu" }];
    const about = await keepProposal(directory, files, pages, "2026-11-13T10:00:00.000Z");
    expect(about).toMatchObject({ schemaVersion: 1, capturedAt: "2026-11-13T10:00:00.000Z", pages, files: 2 });
    const kept = await readKeptProposal(directory);
    expect(kept?.about.pages).toEqual(pages);
    expect(kept?.siteDirectory).toBe(path.join(directory, "proposal", "site"));
    expect(await readFile(path.join(directory, "proposal", "site", "menu", "index.html"), "utf8")).toContain("<h1>B</h1>");
    expect(kept?.about.pages.map(keptPageAddress)).toEqual(["/", "/menu/"]);

    await keepProposal(directory, files.slice(0, 1), pages.slice(0, 1));
    expect((await readKeptProposal(directory))?.about.pages).toEqual([pages[0]]);
    await expect(readFile(path.join(directory, "proposal", "site", "menu", "index.html"))).rejects.toThrow();
  });

  it("rifiuta pagine senza file, percorsi che escono e una prima pagina che non è la home", async () => {
    const home = { path: "index.html", bytes: encode(page("Home", "<h1>A</h1>")) };
    await expect(keepProposal(directory, [home], [{ name: "Menu", path: "menu/index.html", hash: "" }])).rejects.toThrow("non sono valide");
    await expect(keepProposal(directory, [home], [{ name: "Home", path: "index.html", hash: "" }, { name: "Menu", path: "menu/index.html", hash: "" }])).rejects.toThrow("non ha il suo file");
    await expect(keepProposal(directory, [home, { path: "../fuori.html", bytes: encode("x") }], [{ name: "Home", path: "index.html", hash: "" }])).rejects.toThrow("Percorso non valido");
    await expect(keepProposal(directory, [home], [{ name: "Home", path: "../index.html", hash: "" }])).rejects.toThrow("non sono valide");
    // Nothing half written stays behind, and nothing was kept.
    expect(await readKeptProposal(directory)).toBeNull();
    // A capture.json someone tampered with is no capture.
    await mkdir(path.join(directory, "proposal", "site"), { recursive: true });
    await writeFile(path.join(directory, "proposal", "capture.json"), JSON.stringify({ schemaVersion: 1, capturedAt: "x", pages: [{ name: "Home", path: "index.html", hash: "" }] }));
    expect(await readKeptProposal(directory)).toBeNull();
  });
});

describe("le rotte del riquadro", () => {
  let server: LocalServerHandle;
  let dataDirectory: string;
  let base: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-capture-frame-"));
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

  async function upload(name: string, html: string): Promise<string> {
    const bytes = Buffer.from(html);
    const plan = await (await api("/api/imports", { method: "POST", type: "application/json", body: JSON.stringify({ name: "Trattoria", kind: "html", files: [{ path: name, size: bytes.byteLength }] }) })).json() as { id: string };
    expect((await api(`/api/imports/${plan.id}/files/${name}`, { method: "PUT", type: "application/octet-stream", body: bytes })).status).toBe(201);
    return plan.id;
  }

  it("una pagina disegnata da script ha il suo riquadro; una pagina ferma no", async () => {
    const plain = await upload("ferma.html", page("Ferma", `<h1>Ciao</h1><p>${"parole ".repeat(100)}</p>`));
    expect(await (await api(`/api/imports/${plain}/capture-frame`, { method: "POST", type: "application/json", body: "{}" })).json()).toEqual({ scripted: false, reasons: [] });

    const id = await upload("proposta.html", VIEWER);
    const frame = await (await api(`/api/imports/${id}/capture-frame`, { method: "POST", type: "application/json", body: "{}" })).json() as { scripted: boolean; reasons: string[]; url: string };
    expect(frame.scripted).toBe(true);
    expect(frame.reasons.length).toBeGreaterThan(0);
    // An origin of its own: another port of 127.0.0.1, which the app's policy lets the interface frame.
    expect(server.captureOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.captureOrigin).not.toBe(base);
    expect(frame.url.startsWith(`${server.captureOrigin}/__capture/`)).toBe(true);
    expect(new URL(frame.url).pathname).toMatch(/^\/__capture\/[A-Za-z0-9_-]{32}\/$/u);
    expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toContain(`frame-src 'self' ${server.captureOrigin};`);

    // The frame is served without the session token: the ticket in its address is what opens it.
    const served = await fetch(frame.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe(proposalFrameCsp([base, `http://localhost:${server.port}`, "app:"]));
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(await served.text()).toBe(proposalFrameDocument(VIEWER));
    expect((await fetch(frame.url, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${frame.url}index.html`)).status).toBe(404);
    expect((await fetch(`${server.captureOrigin}/__capture/${"a".repeat(32)}/`)).status).toBe(404);
    // The capture origin serves nothing else: not the app, not its API.
    expect((await fetch(`${server.captureOrigin}/`)).status).toBe(404);
    expect((await fetch(`${server.captureOrigin}/api/bootstrap`, { headers: { "X-Histos-Token": server.token } })).status).toBe(404);
    // And the app's own port does not serve the proposal: there its scripts would have the app's origin.
    expect(await (await fetch(`${base}${new URL(frame.url).pathname}`)).text()).toContain("APP-SHELL");

    // The ticket dies with the upload.
    expect((await api(`/api/imports/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(frame.url)).status).toBe(404);
  });

  it("le pagine catturate diventano un caricamento che si converte, con le note della cattura in testa", async () => {
    const id = await upload("proposta.html", VIEWER);
    const pages = [
      { name: "Home", hash: "#p01/home", html: page("Trattoria", '<h1>Trattoria</h1><p><a href="#p01/menu">Il menu</a></p>'), notes: ["1 gestore on… tolto"] },
      { name: "Menu", hash: "#p01/menu", html: page("Menu", '<h1>Menu</h1><p><a href="#p01/home">Home</a></p>') },
    ];
    const created = await api(`/api/imports/${id}/captured-site`, { method: "POST", type: "application/json", body: JSON.stringify({ pages }) });
    expect(created.status).toBe(201);
    const site = await created.json() as { id: string; pages: Array<{ name: string; path: string; links: number }>; notes: string[] };
    expect(site.id).not.toBe(id);
    expect(site.pages.map((item) => item.path)).toEqual(["index.html", "menu/index.html"]);

    // A captured site is not offered the capture again.
    expect(await (await api(`/api/imports/${site.id}/capture-frame`, { method: "POST", type: "application/json", body: "{}" })).json()).toEqual({ scripted: false, reasons: [] });

    const converted = await api(`/api/imports/${site.id}/cms-prototype`, { method: "POST", type: "application/json", body: JSON.stringify({ framework: "none" }) });
    expect(converted.status).toBe(200);
    const result = await converted.json() as { prototype: string; report: { pages: number; notes: string[] } };
    expect(result.report.pages).toBe(2);
    expect(result.report.notes[0]).toBe("proposta fotografata: 2 pagine (Home, Menu)");
    expect(result.report.notes).toContain("Home: 1 gestore on… tolto");
    expect(result.prototype).toContain("Trattoria");

    // After the import the captured pages are kept in the project; an update of the project leaves them there.
    const imported = await (await api("/api/cms/v1/projects/import-prototype", { method: "POST", type: "text/html", body: result.prototype })).json() as { project: { id: string } };
    expect((await api(`/api/imports/${id}/keep-proposal`, { method: "POST", type: "application/json", body: JSON.stringify({ projectId: imported.project.id }) })).status).toBe(400);
    expect((await api(`/api/imports/${site.id}/keep-proposal`, { method: "POST", type: "application/json", body: JSON.stringify({ projectId: crypto.randomUUID() }) })).status).toBe(404);
    const keep = await api(`/api/imports/${site.id}/keep-proposal`, { method: "POST", type: "application/json", body: JSON.stringify({ projectId: imported.project.id }) });
    expect(keep.status).toBe(201);
    const projectDirectory = path.join(dataDirectory, "histos-projects", imported.project.id);
    const kept = await readKeptProposal(projectDirectory);
    expect(kept?.about.pages).toEqual([{ name: "Home", path: "index.html", hash: "#p01/home" }, { name: "Menu", path: "menu/index.html", hash: "#p01/menu" }]);
    expect(await readFile(path.join(projectDirectory, "proposal", "site", "menu", "index.html"), "utf8")).toContain('href="../"');
    expect(await (await api(`/api/cms/v1/projects/${imported.project.id}/admin/proposal`)).json()).toMatchObject({ kept: { schemaVersion: 1, files: 2, pages: [{ name: "Home" }, { name: "Menu" }] } });
    expect((await api("/api/cms/v1/projects/import-prototype?update=1", { method: "POST", type: "text/html", body: result.prototype })).status).toBe(200);
    expect((await readKeptProposal(projectDirectory))?.about.pages).toHaveLength(2);

    // Nothing is taken from a page that is not a capture; the upload it came from must still exist.
    expect((await api(`/api/imports/${id}/captured-site`, { method: "POST", type: "application/json", body: JSON.stringify({ pages: [{ name: "Home", html: "" }] }) })).status).toBe(400);
    expect((await api(`/api/imports/${crypto.randomUUID()}/captured-site`, { method: "POST", type: "application/json", body: JSON.stringify({ pages }) })).status).toBe(404);
  });
});
