import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { findSystemBrowser } from "@histos-publish/core";
import { afterEach, describe, expect, it } from "vitest";
import { capturePageArgument } from "../src/prototype-capture.js";

/**
 * `histos-publish prototype capture`: a proposal drawn by its scripts, opened in Chrome or Chromium and copied page by
 * page without scripts. The proposals here are invented: a viewer that writes the proposal into a frame from the
 * fragment of its address, and one that copies templates into a part of its own page. Without a browser on the
 * machine only the reading of the arguments runs.
 */

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);
const browserFound = await findSystemBrowser().then(() => true, () => existsSync(chromium.executablePath()));

/** A viewer with the proposal in a frame: the frame's document is written by a script, one page per fragment. */
const FRAME_VIEWER = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Proposte</title>
<style>body{margin:0}header{height:40px}iframe{display:block;width:100%;height:calc(100vh - 40px);border:0}</style></head>
<body><header><button id="p01">Uno</button></header><iframe id="vista" title="Proposta"></iframe>
<script src="https://cdn.example/libreria.js"></script>
<script>
const pagine = {
  home: '<h1>Trattoria</h1><nav><a href="#" data-go="menu" onclick="return false">Il menu</a> <a href="#p01/home">Home</a></nav><canvas id="grafico" width="40" height="20"></canvas><label><input type="checkbox" id="scelta"> Ricordami</label><p class="rivela">Appare allo scorrimento</p>',
  menu: '<h1>Menu</h1><p><a href="#p01/home">Torna alla home</a></p><details id="orari"><summary>Orari</summary><p>12-15</p></details>',
};
function disegna() {
  const pagina = (location.hash.split("/")[1] || "home");
  const doc = document.getElementById("vista").contentDocument;
  doc.open();
  doc.write('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Trattoria · ' + pagina + '</title><style>.rivela{opacity:0}.rivela.visto{opacity:1}h1{color:#a22}</style></head><body>' + pagine[pagina] + '<scr' + 'ipt>document.body.dataset.pronta = "1";</scr' + 'ipt></body></html>');
  doc.close();
  const canvas = doc.getElementById("grafico");
  if (canvas) { const penna = canvas.getContext("2d"); penna.fillStyle = "#06c"; penna.fillRect(0, 0, 40, 20); }
  const scelta = doc.getElementById("scelta");
  if (scelta) scelta.checked = true;
  const orari = doc.getElementById("orari");
  if (orari) orari.open = true;
  for (const nodo of doc.querySelectorAll(".rivela")) nodo.classList.add("visto");
}
addEventListener("hashchange", disegna);
disegna();
</script></body></html>`;

/** A viewer that copies a template into a part of its own page; the part depends on a container around it. */
const PART_VIEWER = `<!doctype html><html lang="it" class="tema-chiaro"><head><meta charset="utf-8"><title>Dieci proposte</title>
<style>.barra{padding:8px}.schermo{container-type:inline-size;container-name:sito;max-width:900px;margin:24px auto;padding:12px;border:4px solid #000}
.sito{--tinta:#063}.sito h1{color:var(--tinta)}@container sito (min-width:30rem){.sito .griglia{display:grid;grid-template-columns:1fr 2fr}}</style></head>
<body data-vista="home"><div class="barra"><button>Proposta 7</button><span id="scelta-proposta">Scegli</span></div>
<main class="palco" style="--bordo:2px"><div class="schermo"><div class="sito"></div></div></main>
<template id="t-home"><h1>Centro</h1><div class="griglia"><p>Lato</p><p>Testo</p></div><p class="solo-visore">Anteprima</p></template>
<script>/* ${"x".repeat(200)} */ document.querySelector(".sito").append(document.getElementById("t-home").content.cloneNode(true)); document.documentElement.style.setProperty("--doc-alto", "148px");</script></body></html>`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function capture(html: string, args: string[], json = false): Promise<{ code: number; stdout: string; stderr: string; out: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cli-capture-"));
  roots.push(root);
  const file = path.join(root, "proposta.html");
  await writeFile(file, html);
  const out = path.join(root, "sito");
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...(json ? ["--json"] : []), "prototype", "capture", file, "--out", out, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr, out, root };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", out, root };
  }
}

describe("capturePageArgument", () => {
  it("legge il frammento, col nome davanti quando c'è", () => {
    expect(capturePageArgument("#p03/home")).toEqual({ hash: "#p03/home" });
    expect(capturePageArgument(" Il menu = #p03/menu ".replace(" = ", "="))).toEqual({ name: "Il menu", hash: "#p03/menu" });
    expect(capturePageArgument("#a=b")).toEqual({ hash: "#a=b" });
    expect(capturePageArgument("Home=")).toEqual({ name: "Home", hash: "" });
    expect(() => capturePageArgument("p03/home")).toThrow("non è il frammento di un indirizzo");
    expect(() => capturePageArgument("#p03 home")).toThrow("non è il frammento di un indirizzo");
  });
});

describe.skipIf(!browserFound)("histos-publish prototype capture", () => {
  it("fotografa le pagine di un visore con la proposta in un riquadro, senza script e con i link fra le pagine", async () => {
    const result = await capture(FRAME_VIEWER, ["--pagina", "#p01/home", "Il menu=#p01/menu"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await readdir(result.out)).sort()).toEqual(["il-menu", "index.html"]);
    const home = await readFile(path.join(result.out, "index.html"), "utf8");
    // The frame's document, not the viewer around it.
    expect(home).toContain("<title>Trattoria · home</title>");
    expect(home).toContain("<h1>Trattoria</h1>");
    expect(home).not.toContain("Uno</button>");
    // No script, no handler; what a script did to the page stays: the class, the checked box, the canvas as an image.
    expect(home).not.toMatch(/<script/iu);
    expect(home).not.toContain("onclick");
    expect(home).toContain('data-pronta="1"');
    expect(home).toContain('class="rivela visto"');
    expect(home).toMatch(/<input type="checkbox" id="scelta" checked="">/u);
    expect(home).toMatch(/<img id="grafico" src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="" width="40" height="20">/u);
    // The links a script of the viewer served now point to the captured pages.
    expect(home).toContain('<a href="il-menu/" data-go="menu">Il menu</a>');
    expect(home).toContain('<a href="./">Home</a>');
    const menu = await readFile(path.join(result.out, "il-menu", "index.html"), "utf8");
    expect(menu).toContain("<h1>Menu</h1>");
    expect(menu).toContain('<a href="../">Torna alla home</a>');
    expect(menu).toContain('<details id="orari" open="">');
    expect(result.stdout).toContain("Proposta fotografata: 2 pagine in ");
    expect(result.stdout).toMatch(/^• index\.html: «Home», #p01\/home, \d+ kB, 2 link collegati$/mu);
    expect(result.stdout).toMatch(/^• il-menu\/index\.html: «Il menu», #p01\/menu, \d+ kB, 1 link collegato$/mu);
    expect(result.stdout).toContain("  Nota: 1 canvas diventato un'immagine ferma");
    expect(result.stdout).toContain("  Nota: 1 gestore on… tolto");
    // The network is closed: the library of another site did not load, and the report says so.
    expect(result.stdout).toContain("Nota: la proposta carica script da cdn.example: qui la rete è chiusa e non sono partiti");
  }, 60_000);

  it("con --radice tiene solo la proposta, coi contenitori attorno senza le loro misure, e --togli lascia fuori il resto", async () => {
    const result = await capture(PART_VIEWER, ["--radice", ".sito", "--togli", ".solo-visore"], true);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { output: string; pages: Array<{ file: string; name: string; hash: string; notes: string[] }>; notes: string[] };
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0]?.file).toBe("index.html");
    expect(report.pages[0]?.notes).toContain("la proposta è una parte della pagina (.sito): il resto della pagina non è nella cattura; 2 contenitori tenuti attorno, senza le loro misure");
    expect(report.pages[0]?.notes).toContain("1 elemento del visore tolto");
    // A variable the viewer wrote on <html> stays in the copy, and the person is told the built site will not have it.
    expect(report.pages[0]?.notes).toContain("1 variabile scritta dalla pagina su <html> o <body>: --doc-alto (148px) su <html>. Restano nella copia della proposta, il sito costruito non le ha");
    const home = await readFile(path.join(result.out, "index.html"), "utf8");
    expect(home).toContain('<html lang="it" class="tema-chiaro" style="--doc-alto: 148px;">');
    expect(home).toContain('<body data-vista="home">');
    expect(home).toContain("@container sito");
    // The container the proposal depends on is still around it, flattened; the viewer's bar and templates are gone.
    expect(home).toMatch(/<main class="palco" style="--bordo:2px;position:static!important;[^"]*display:block!important"><div class="schermo" style=";?position:static!important;[^"]*"><div class="sito"><h1>Centro<\/h1>/u);
    expect(home).not.toContain("Proposta 7");
    expect(home).not.toContain("<template");
    expect(home).not.toContain("solo-visore");
    expect(home).not.toMatch(/<script/iu);
  }, 60_000);

  it("rifiuta una cartella che esiste, un frammento sbagliato e un selettore che non trova niente, senza lasciare la cartella", async () => {
    const existing = await capture(FRAME_VIEWER, []);
    expect(existing.code, existing.stderr).toBe(0);
    await mkdir(path.join(existing.root, "altra"));
    const again = await run(process.execPath, [CLI, "prototype", "capture", path.join(existing.root, "proposta.html"), "--out", path.join(existing.root, "altra")]).then(() => ({ code: 0, stderr: "" }), (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" }));
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("altra esiste già: scegli un altro nome.");

    const fragment = await capture(FRAME_VIEWER, ["--pagina", "p01/home"]);
    expect(fragment.code).toBe(2);
    expect(fragment.stderr).toContain("«p01/home» non è il frammento di un indirizzo");
    expect(existsSync(fragment.out)).toBe(false);

    const missing = await capture(PART_VIEWER, ["--radice", ".non-c-e"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Pagina iniziale: Il selettore «.non-c-e» non trova niente nella pagina: la proposta non è stata catturata.");
    expect(existsSync(missing.out)).toBe(false);
  }, 90_000);
});
