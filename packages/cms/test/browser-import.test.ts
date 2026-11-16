import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { canonicalizeJson } from "@histos-publish/histos-contract";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM build script, without types.
import { browserImportBuild } from "../build-browser-import.mjs";
import { decodeStaticPageArchive } from "../src/page-transfer.js";
import { convertToXbsite, type BrowserImportInput } from "../browser/html-import.js";
import type { WasmSqlite } from "../src/project-database-wasm.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * Doc 18 F6: the importer bundled for the WordPress administrator's browser, run where there is no Buffer, process or
 * require, writes a `.xbsite` that Histeon Publish's own reader accepts, with the same entities as the same code in Node.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

function filesOf(root: string): StaticSiteFile[] {
  const out: StaticSiteFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

describe("importatore nel browser (F6)", () => {
  it("impacchettato senza Node, scrive un .xbsite che Publish legge, uguale a quello di Node", async () => {
    const bundled = await build({ ...browserImportBuild, format: "iife", globalName: "HistosHtmlImport", write: false, logLevel: "silent" });
    expect(bundled.errors).toEqual([]);
    const code = bundled.outputFiles[0]!.text;
    expect(code).not.toMatch(/require\(["']node:/u);
    const sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
    const input: BrowserImportInput = { files: filesOf(path.join(here, "fixtures/import-corpus/blog-statico")), name: "Blog", projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", structure: { parts: true, components: true, lists: true } };
    // What a browser adds to JavaScript, and nothing of Node; the language's own objects are the context's.
    const context = vm.createContext({ TextEncoder, TextDecoder, URL, console, crypto: globalThis.crypto, atob, btoa, queueMicrotask, setTimeout, clearTimeout });
    vm.runInContext(`${code}\nglobalThis.HistosHtmlImport = HistosHtmlImport;`, context);
    const inBrowser = await (context as { HistosHtmlImport: { convertToXbsite: typeof convertToXbsite } }).HistosHtmlImport.convertToXbsite(input, sqlite);
    const inNode = await convertToXbsite(input, sqlite);
    expect(inBrowser.selectable).toEqual(inNode.selectable);
    expect(inBrowser.prototype).toBe(inNode.prototype);
    // Publish's own reader accepts it, and finds the same entities as the same conversion in Node.
    const read = await decodeStaticPageArchive(Buffer.from(inBrowser.archive));
    const node = await decodeStaticPageArchive(Buffer.from(inNode.archive));
    expect(canonicalizeJson(read.profile.entities as never)).toBe(canonicalizeJson(node.profile.entities as never));
    expect(read.profile.entities.some((entity) => entity.kind === "document")).toBe(true);
    expect(Object.keys(unzipSync(inBrowser.archive))).toContain("site.json");
    // Doc 27 G4: the choices the plugin asks a model about are the same in the bundle and in Node.
    expect(inBrowser.choices.length).toBeGreaterThan(0);
    expect(inBrowser.choices).toEqual(inNode.choices);
    expect(inBrowser.choicesRejected).toEqual([]);
  }, 120_000);

  it("prova e applica le scelte di un modello: un nome già preso resta fuori col suo motivo (doc 27, G4)", async () => {
    const { trialChoices } = await import("../browser/html-import.js");
    const sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
    const input: BrowserImportInput = { files: filesOf(path.join(here, "fixtures/import-corpus/utility-tailwind")), name: "Utility" };
    const first = await convertToXbsite(input, sqlite);
    const classes = first.choices.filter((choice) => choice.kind === "classe");
    expect(classes.length).toBeGreaterThan(1);
    const [one, two] = classes as [(typeof classes)[number], (typeof classes)[number]];
    // The same new name twice: the second one collides; nothing is written by the trial.
    const answers = { [one.id]: "rifinito__primo", [two.id]: "rifinito__primo" };
    const rejected = trialChoices(input, answers);
    expect(rejected.map((item) => item.id)).toEqual([two.id]);
    expect(rejected[0]?.motivo).toBe("il nome è già di un altro elemento");
    expect(trialChoices(input, {})).toEqual([]);
    const applied = await convertToXbsite({ ...input, choices: { [one.id]: "rifinito__primo" } }, sqlite);
    expect(applied.prototype).toContain("rifinito__primo");
    expect(applied.prototype).not.toBe(first.prototype);
    expect(applied.choicesRejected).toEqual([]);
    expect(applied.choices.map((choice) => choice.id)).toEqual(first.choices.map((choice) => choice.id));
  }, 120_000);

  it("un prototipo Histeon in un file si importa così com'è, non come una pagina da convertire (voce 167)", async () => {
    const sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
    const html = readFileSync(path.join(here, "fixtures/prototipo-esempio.html"), "utf8");
    const result = await convertToXbsite({ files: [{ path: "prototipo.html", bytes: new TextEncoder().encode(html) }], name: "Prototipo" }, sqlite);
    expect(result.prototype).toBe(html);
    expect(result.notes[0]).toContain("Prototipo Histeon");
    const read = await decodeStaticPageArchive(Buffer.from(result.archive));
    const kinds = new Set(read.profile.entities.map((entity) => entity.kind));
    expect(kinds.has("document")).toBe(true);
    expect(read.profile.entities.length).toBeGreaterThan(1);
    // Into the site's project, when it has one.
    const into = await convertToXbsite({ files: [{ path: "prototipo.html", bytes: new TextEncoder().encode(html) }], name: "Prototipo", projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4" }, sqlite);
    expect(into.projectId).toBe("6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4");
    expect((await decodeStaticPageArchive(Buffer.from(into.archive))).profile.manifest.project.id).toBe("6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4");
  }, 120_000);

  it("legge lo ZIP di un sito con i percorsi controllati e senza la cartella di primo livello", async () => {
    const { zipSync } = await import("fflate");
    const { readSiteZip, siteFilePath } = await import("../browser/html-import.js");
    const zip = zipSync({ "sito/index.html": new TextEncoder().encode("<p>x</p>"), "sito/css/a.css": new TextEncoder().encode("p{}"), "sito/.git/config": new Uint8Array(1), "sito/../fuori.txt": new Uint8Array(1) });
    const read = readSiteZip(zip);
    expect(read.files.map((file) => file.path).sort()).toEqual(["css/a.css", "index.html"]);
    expect(read.refused).toBe(2);
    for (const bad of ["/etc/passwd", "C:/x", "a\\b", "a/../b", "a//b", ""]) expect(siteFilePath(bad), bad).toBeNull();
  });
});

