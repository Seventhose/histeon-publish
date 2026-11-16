import { describe, expect, it } from "vitest";
import { cssResourceReferences } from "@histos-publish/histos-contract/css-resources";
import { decodeCssSource, flattenCssImportBundle } from "../src/css-imports.js";

describe("importazione CSS da una cartella scelta dall'utente", () => {
  it("espande @import annidati e mantiene le condizioni CSS", async () => {
    const files = new Map([
      ["framework/base.css", `@import "./tokens.css" layer(tokens); .base{color:var(--ink)}`],
      ["framework/tokens.css", `:root{--ink:#123}@supports (display:grid){.grid{display:grid}}`],
    ]);

    const output = await flattenCssImportBundle({
      css: `@import "./framework/base.css" screen and (min-width: 40em); .page{display:block}`,
      entryPath: "site.css",
      loadCss: async (path) => files.get(path),
    });

    expect(output).toContain("@media screen and (min-width: 40em){");
    expect(output).toContain("@layer tokens{");
    expect(output).toContain("--ink:#123");
    expect(output).toContain("@supports (display:grid){.grid{display:grid}}");
    expect(output).toContain(".page{display:block}");
    expect(cssResourceReferences(output).filter(({ kind }) => kind === "import")).toEqual([]);
  });

  it("rebases URLs from imported sheets to the selected folder root", async () => {
    const files = new Map([
      ["vendor/css/main.css", `@import "./parts/type.css"; .hero{background:url(../images/hero image.webp)}`],
      ["vendor/css/parts/type.css", `@font-face{src:url(../../fonts/site.woff2?v=2)}`],
    ]);
    const output = await flattenCssImportBundle({
      css: `@import "./vendor/css/main.css";`,
      entryPath: "theme.css",
      loadCss: async (path) => files.get(path),
    });

    expect(output).toContain(`url("/vendor/fonts/site.woff2?v=2")`);
    expect(output).toContain(`url("/vendor/images/hero%20image.webp")`);
    expect(cssResourceReferences(output).filter(({ kind }) => kind === "url").map(({ value }) => value)).toEqual([
      "/vendor/fonts/site.woff2?v=2",
      "/vendor/images/hero%20image.webp",
    ]);
  });

  it("conserva gli @import remoti senza fare richieste di rete", async () => {
    const loadCss = async () => {
      throw new Error("Non deve essere chiamato per URL remoti");
    };
    await expect(flattenCssImportBundle({
      css: `@import url("https://cdn.example.test/base.css") layer(remote); .page{color:red}`,
      entryPath: "theme.css",
      loadCss,
    })).resolves.toContain(`@import url("https://cdn.example.test/base.css") layer(remote);`);
  });

  it("rifiuta file assenti, percorsi fuori cartella, cicli e limiti d'importazione", async () => {
    const loadCss = async (path: string) => path === "parts/a.css" ? `@import "./b.css";` : path === "parts/b.css" ? `@import "./a.css";` : undefined;
    await expect(flattenCssImportBundle({ css: `@import "./missing.css";`, entryPath: "theme.css", loadCss })).rejects.toThrow(/Manca il foglio CSS/u);
    await expect(flattenCssImportBundle({ css: `@import "../../outside.css";`, entryPath: "parts/theme.css", loadCss })).rejects.toThrow(/non è un file CSS locale valido/u);
    await expect(flattenCssImportBundle({ css: `@import "./a.css";`, entryPath: "parts/theme.css", loadCss })).rejects.toThrow(/ciclo CSS/u);
  });

  it("rifiuta riferimenti url() che escono dalla cartella del bundle", async () => {
    await expect(flattenCssImportBundle({
      css: `.icon{mask:url(../../../fuori.svg)}`,
      entryPath: "vendor/theme.css",
      loadCss: async () => undefined,
    })).rejects.toThrow(/esce dalla cartella/u);
  });

  it("accetta supports() e layer() senza alterare le regole incorporate", async () => {
    await expect(flattenCssImportBundle({
      css: `@import "./grid.css" layer(layout) supports(display:grid);`,
      entryPath: "theme.css",
      loadCss: async () => `.grid{display:grid}`,
    })).resolves.toContain(`@layer layout{@supports (display:grid){.grid{display:grid}}}`);
  });

  it("rifiuta un @import remoto annidato quando un wrapper ne cambierebbe la validità", async () => {
    await expect(flattenCssImportBundle({
      css: `@import "./local.css" layer(vendor);`,
      entryPath: "theme.css",
      loadCss: async () => `@import "https://cdn.example.test/remote.css"; .vendor{color:red}`,
    })).rejects.toThrow(/@import remoto/u);
  });

  it("rifiuta condizioni di import non ancora supportate invece di trasformarle in media query", async () => {
    await expect(flattenCssImportBundle({
      css: `@import "./scoped.css" scope(.theme);`,
      entryPath: "theme.css",
      loadCss: async () => ".scoped{color:green}",
    })).rejects.toThrow(/condizioni di @import non sono supportate/u);
  });

  it("decodifica CSS UTF-8 rigorosamente e rifiuta altre dichiarazioni di codifica", async () => {
    const invalidUtf8 = new ArrayBuffer(1);
    new Uint8Array(invalidUtf8)[0] = 0xff;
    expect(() => decodeCssSource(invalidUtf8)).toThrow(/UTF-8 valido/u);
    await expect(new Blob(['@charset "ISO-8859-1"; .x{color:red}']).arrayBuffer().then(decodeCssSource)).rejects.toThrow(/solo fogli CSS codificati in UTF-8/u);
    await expect(new Blob(['.first{color:black} @charset "UTF-8";']).arrayBuffer().then(decodeCssSource)).rejects.toThrow(/ammessa solo all'inizio/u);
    await expect(new Blob([' @charset "UTF-8"; .x{color:red}']).arrayBuffer().then(decodeCssSource)).rejects.toThrow(/ammessa solo all'inizio/u);
    await expect(new Blob(["@charset 'UTF-8'; .x{color:red}"]).arrayBuffer().then(decodeCssSource)).rejects.toThrow(/dichiarazione CSS @charset non è valida/u);
  });

  it("rimuove BOM e @charset UTF-8 dai fogli principali e importati", async () => {
    const mainCss = decodeCssSource(await new Blob(['\uFEFF@charset "UTF-8"; @import "./parts/theme.css"; .main{color:black}']).arrayBuffer());
    const output = await flattenCssImportBundle({
      css: mainCss,
      entryPath: "theme.css",
      loadCss: async () => '@charset "utf-8"; .nested{color:blue}',
    });
    expect(output).not.toContain("@charset");
    expect(output).not.toContain("\uFEFF");
    expect(output).toContain(".nested{color:blue}");
    expect(output).toContain(".main{color:black}");
  });

  it("rispetta i limiti di import annidati e quantità", async () => {
    const chain = new Map<string, string>();
    for (let index = 0; index < 18; index++) chain.set(`css/${index}.css`, `@import "./${index + 1}.css";`);
    chain.set("css/18.css", ".end{color:green}");
    await expect(flattenCssImportBundle({
      css: `@import "./0.css";`, entryPath: "css/main.css", loadCss: async (path) => chain.get(path),
    })).rejects.toThrow(/16 livelli/u);
    const many = Array.from({ length: 129 }, (_, index) => `@import "./${index}.css";`).join("\n");
    await expect(flattenCssImportBundle({
      css: many, entryPath: "main.css", loadCss: async () => ".x{color:red}",
    })).rejects.toThrow(/128 fogli/u);
  });
});
