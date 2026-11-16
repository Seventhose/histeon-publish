import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { base64FromBytes, bytesFromBase64, sha1Bytes, sha256Hex, utf8Length } from "../src/isomorphic.js";
import { staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * Doc 18 §5 and F6: the converter runs in Publish and in the WordPress administrator's browser, so its core uses no
 * Node API. These tests hold the pure helpers to Node's own results, and run the converter bundled for the browser in a
 * context with no `Buffer`, `process` or `require`, against the same conversion in Node.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

describe("aiuti isomorfi del convertitore", () => {
  it("SHA-256, base64 e lunghezza UTF-8 danno gli stessi risultati di Node", () => {
    const samples = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "àèì€😀".repeat(40), "x".repeat(10_000)];
    for (const sample of samples) {
      expect(sha256Hex(sample), sample.slice(0, 10)).toBe(createHash("sha256").update(sample).digest("hex"));
      expect(utf8Length(sample)).toBe(Buffer.byteLength(sample, "utf8"));
      const bytes = new Uint8Array(Buffer.from(sample, "utf8"));
      expect(base64FromBytes(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect([...(bytesFromBase64(Buffer.from(bytes).toString("base64")) ?? [])]).toEqual([...bytes]);
    }
    expect(bytesFromBase64("non base64!")).toBeNull();
    for (const sample of ["", "abc", "x".repeat(1000)]) expect(Buffer.from(sha1Bytes(new TextEncoder().encode(sample))).toString("hex")).toBe(createHash("sha1").update(sample).digest("hex"));
    expect(base64FromBytes(new Uint8Array(100_000).fill(7))).toBe(Buffer.alloc(100_000, 7).toString("base64"));
    // A lone surrogate counts as three bytes, as Node writes it (U+FFFD).
    expect(utf8Length("\ud800")).toBe(Buffer.byteLength("\ud800", "utf8"));
  });
});

describe("il convertitore nel browser (F6)", () => {
  it("si impacchetta per il browser senza moduli di Node e converte come in Node", async () => {
    const bundled = await build({ entryPoints: [path.join(here, "../src/static-site-prototype.ts")], bundle: true, platform: "browser", format: "iife", globalName: "HistosConverter", write: false, logLevel: "silent" });
    expect(bundled.errors).toEqual([]);
    const code = bundled.outputFiles[0]!.text;
    const root = path.join(here, "fixtures/import-corpus/utility-tailwind");
    const files: StaticSiteFile[] = readdirSync(root).filter((name) => statSync(path.join(root, name)).isFile()).map((name) => ({ path: name, bytes: new Uint8Array(readFileSync(path.join(root, name))) }));
    // A sheet with an inline source map, which postcss would read with Buffer if it could.
    files.push({ path: "mappa.css", bytes: new TextEncoder().encode(".mappa{color:red}\n/*# sourceMappingURL=data:application/json;base64,e30= */") });
    files[files.findIndex((file) => file.path === "index.html")] = { path: "index.html", bytes: new TextEncoder().encode(new TextDecoder().decode(files.find((file) => file.path === "index.html")!.bytes).replace("</head>", '<link rel="stylesheet" href="mappa.css"></head>').replace("<main>", '<main class="mappa">')) };
    const input = { projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", name: "Browser", files };
    // Only what a browser has: no Buffer, process, require or module.
    const context = vm.createContext({ TextEncoder, TextDecoder, URL, console, Uint8Array, Uint32Array, DataView, ArrayBuffer, Map, Set, WeakMap, JSON, Math, Date, RegExp, Error, TypeError, RangeError, Symbol, Promise });
    vm.runInContext(`${code}\nglobalThis.HistosConverter = HistosConverter;`, context);
    const inBrowser = (context as { HistosConverter: { staticSiteToPrototype: typeof staticSiteToPrototype } }).HistosConverter.staticSiteToPrototype(input);
    const inNode = staticSiteToPrototype(input);
    expect(inBrowser.html).toBe(inNode.html);
    // The source map annotation is dropped before parsing: the sheet is read the same way in both.
    expect(inNode.report.notes.join("\n")).not.toMatch(/non leggibile/u);
    expect(inBrowser.report.notes).toEqual(inNode.report.notes);
  }, 60_000);
});
