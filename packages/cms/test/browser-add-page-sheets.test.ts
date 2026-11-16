import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { TransferEntity } from "@histos-publish/histos-contract";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeStaticPageArchive } from "../src/page-transfer.js";
import { convertToXbsite, type AddPageAssetEntity, type AddPageBase, type AddPageStylesEntity, type BrowserImportResult } from "../browser/html-import.js";
import { brandSheetFilter, isWordpressPage } from "../browser/page-sheets.js";
import type { WasmSqlite } from "../src/project-database-wasm.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * D5: the brand colours of a page added to a site (`primary`, `secondary`) come only from the page's own sheets and
 * styles. The sheets of the theme, of WordPress (global-styles, wp-block-library and the palette `--wp--preset--*`) and
 * of the plugins are converted as always, but their colours do not count, even when they are the most used ones.
 */
const PROJECT = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const encoder = new TextEncoder();
const THEME_GREEN = "#2e7d32";

let sqlite: WasmSqlite;
beforeAll(async () => {
  sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
});

async function read(result: BrowserImportResult) {
  const decoded = await decodeStaticPageArchive(Buffer.from(result.archive));
  return { entities: decoded.profile.entities, files: new Map([...decoded.files].map(([name, bytes]) => [name, new Uint8Array(bytes)])) };
}

function baseOf(entities: readonly TransferEntity[], files: ReadonlyMap<string, Uint8Array>): AddPageBase {
  const styles = entities.find((entity) => entity.kind === "styles")! as unknown as AddPageStylesEntity;
  const assets = entities.filter((entity) => entity.kind === "asset") as unknown as AddPageAssetEntity[];
  return {
    projectId: PROJECT,
    styles,
    slugs: entities.filter((entity) => entity.kind === "document").map((entity) => String(entity.payload.slug)),
    entityIds: entities.map((entity) => entity.id),
    assets,
    files: Object.fromEntries(assets.map((asset) => [asset.payload.path, new Uint8Array(files.get(asset.payload.path)!)])),
  };
}

const SITE: StaticSiteFile[] = [
  { path: "index.html", bytes: encoder.encode(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Bottega</title><link rel="stylesheet" href="stile.css"></head><body><main><h1 class="titolo">Il laboratorio</h1></main></body></html>`) },
  { path: "stile.css", bytes: encoder.encode(`.titolo{color:#1a4d8f}`) },
];

async function siteBase(): Promise<AddPageBase> {
  const site = await read(await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT }, sqlite));
  return baseOf(site.entities, site.files);
}

/** A theme sheet that uses the green everywhere, as the palette of a theme does. */
const THEME_CSS = `.tema-a{color:${THEME_GREEN}}.tema-b{background:${THEME_GREEN}}.tema-c{border-color:${THEME_GREEN}}.tema-d{color:${THEME_GREEN}}.tema-e{fill:${THEME_GREEN}}.tema-f{stroke:${THEME_GREEN}}`;

/**
 * A page printed by WordPress with a block theme: the theme's sheet and its inline part, WordPress's own sheets (the
 * block library with the green of its palette, global-styles with `--wp--preset--color--*`), a plugin's sheet, a
 * `<style>` without id; the page's own colours are in the styles WordPress writes for its blocks
 * (`core-block-supports-inline-css`) and in an inline style.
 */
const WORDPRESS_PAGE: StaticSiteFile[] = [
  {
    path: "index.html",
    bytes: encoder.encode(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Chi siamo</title><link rel="canonical" href="https://esempio.test/chi-siamo/"><meta name="generator" content="WordPress 6.9">
<link rel="stylesheet" id="wp-block-library-css" href="wp-includes/css/dist/block-library/style.min.css">
<link rel="stylesheet" id="tema-style-css" href="wp-content/themes/tema/style.css">
<link rel="stylesheet" id="plug-css" href="wp-content/plugins/plug/plug.css">
<style id="global-styles-inline-css">:root{--wp--preset--color--verde:${THEME_GREEN}}.has-verde-color{color:${THEME_GREEN} !important}.has-verde-background-color{background-color:${THEME_GREEN} !important}.has-verde-border-color{border-color:${THEME_GREEN} !important}</style>
<style id="wp-block-button-inline-css">.wp-block-button__link{background-color:${THEME_GREEN};color:#fff}</style>
<style id="tema-style-inline-css">.tema-g{color:${THEME_GREEN}}</style>
<style id="plug-inline-css">.plug-b{color:#ff6f00}</style>
<style>.senza-id{color:#ff6f00;background:#ff6f00}</style>
<style id="core-block-supports-inline-css">.wp-container-core-group-is-layout-1{background-color:#b5179e}.wp-elements-1 a{color:#b5179e}</style>
</head><body class="wp-singular page-template-default page page-id-10 wp-theme-tema">
<main class="wp-block-group wp-container-core-group-is-layout-1"><h1 class="wp-block-heading has-verde-color">Chi siamo</h1><p class="wp-elements-1" style="color:#1565c0">Tre generazioni di <a href="/storia/">falegnami</a>.</p></main>
</body></html>`),
  },
  { path: "wp-includes/css/dist/block-library/style.min.css", bytes: encoder.encode(`.wp-block-group{box-sizing:border-box}.has-vivid-green-color{color:${THEME_GREEN}}.wp-block-heading{border-color:${THEME_GREEN}}`) },
  { path: "wp-content/themes/tema/style.css", bytes: encoder.encode(THEME_CSS) },
  { path: "wp-content/plugins/plug/plug.css", bytes: encoder.encode(`.plug-a{color:#ff6f00;background:#ff6f00;border-color:#ff6f00}`) },
];

/** A page built with Elementor: the kit's sheet (the site's colours) against the page's own `post-<id>.css`. */
const ELEMENTOR_PAGE: StaticSiteFile[] = [
  {
    path: "index.html",
    bytes: encoder.encode(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Corsi</title><link rel="canonical" href="https://esempio.test/corsi/">
<link rel="stylesheet" id="elementor-frontend-css" href="wp-content/plugins/elementor/assets/css/frontend.min.css">
<style id="elementor-frontend-inline-css">.e-a{color:#ff6f00}</style>
<link rel="stylesheet" id="elementor-post-4-css" href="wp-content/uploads/elementor/css/post-4.css">
<link rel="stylesheet" id="elementor-post-10-css" href="wp-content/uploads/elementor/css/post-10.css">
</head><body class="page page-id-10 wp-theme-tema elementor-default elementor-kit-4 elementor-page elementor-page-10">
<div class="elementor elementor-10"><div class="elementor-element elementor-element-a1"><h2 class="elementor-heading-title">Corsi</h2></div><div class="elementor-element elementor-element-b2"><a class="elementor-button" href="/iscriviti/">Iscriviti</a></div></div>
</body></html>`),
  },
  { path: "wp-content/plugins/elementor/assets/css/frontend.min.css", bytes: encoder.encode(`.elementor-button{background-color:#ff6f00;color:#fff}.e-b{color:#ff6f00}`) },
  { path: "wp-content/uploads/elementor/css/post-4.css", bytes: encoder.encode(`.elementor-kit-4{--e-global-color-primary:${THEME_GREEN}}.elementor-kit-4 a{color:${THEME_GREEN}}.elementor-kit-4 h2{color:${THEME_GREEN}}.elementor-kit-4 button{background-color:${THEME_GREEN}}`) },
  { path: "wp-content/uploads/elementor/css/post-10.css", bytes: encoder.encode(`.elementor-10 .elementor-element-a1{background-color:#b5179e}.elementor-10 .elementor-element-a1 .elementor-heading-title{color:#b5179e}.elementor-10 .elementor-element-b2 .elementor-button{background-color:#1565c0}`) },
];

function brandOf(result: BrowserImportResult): Record<string, string> {
  return Object.fromEntries((result.addPage?.colors?.page ?? []).map((color) => [color.family, color.value]));
}

describe("D5: colori del marchio solo dai fogli della pagina", () => {
  it("una pagina di WordPress: primario e secondario sono della pagina, non il verde del tema e di WordPress", async () => {
    const base = await siteBase();
    const result = await convertToXbsite({ files: WORDPRESS_PAGE, name: "Chi siamo", addPage: { base, colors: "sito" } }, sqlite);
    expect(brandOf(result)).toEqual({ primary: "#b5179e", secondary: "#1565c0" });
    // The theme's sheets are still converted: only the choice of the brand leaves them out.
    const out = await read(result);
    const styles = out.entities.find((entity) => entity.kind === "styles")!.payload as unknown as AddPageStylesEntity["payload"];
    expect(styles.globals.map((sheet) => sheet.css).join("\n")).toContain(THEME_GREEN);
  });

  it("la stessa pagina convertita come sito intero sceglie ancora fra tutti i fogli (il verde del tema)", async () => {
    const result = await convertToXbsite({ files: WORDPRESS_PAGE, name: "Chi siamo", projectId: PROJECT }, sqlite);
    expect(result.prototype).toMatch(new RegExp(`"primary":"${THEME_GREEN}"`, "u"));
  });

  it("una pagina di Elementor: il foglio della pagina conta, quello del kit e del plugin no", async () => {
    const base = await siteBase();
    const result = await convertToXbsite({ files: ELEMENTOR_PAGE, name: "Corsi", addPage: { base, colors: "sito" } }, sqlite);
    expect(brandOf(result)).toEqual({ primary: "#b5179e", secondary: "#1565c0" });
  });

  it("quali fogli sono del sito", () => {
    const decode = (files: StaticSiteFile[]) => new TextDecoder().decode(files[0]!.bytes);
    const wordpress = brandSheetFilter(decode(WORDPRESS_PAGE))!;
    expect(wordpress).not.toBeNull();
    const page = (sheet: Parameters<typeof wordpress>[0]) => wordpress(sheet);
    expect(page({ kind: "link", href: "wp-includes/css/dist/block-library/style.min.css", id: "wp-block-library-css" })).toBe(false);
    expect(page({ kind: "link", href: "wp-content/themes/tema/style.css", id: "tema-style-css" })).toBe(false);
    expect(page({ kind: "link", href: "blog/wp-content/plugins/plug/plug.css", id: "" })).toBe(false);
    expect(page({ kind: "link", href: "https://cdn.esempio.test/libreria.css", id: "" })).toBe(false);
    expect(page({ kind: "style", href: "", id: "global-styles-inline-css" })).toBe(false);
    expect(page({ kind: "style", href: "", id: "tema-style-inline-css" })).toBe(false);
    expect(page({ kind: "style", href: "", id: "plug-inline-css" })).toBe(false);
    expect(page({ kind: "style", href: "", id: "" })).toBe(false);
    expect(page({ kind: "style", href: "", id: "core-block-supports-inline-css" })).toBe(true);
    expect(page({ kind: "link", href: "wp-content/uploads/foglio-della-pagina.css", id: "" })).toBe(true);
    const elementor = brandSheetFilter(decode(ELEMENTOR_PAGE))!;
    expect(elementor({ kind: "link", href: "wp-content/uploads/elementor/css/post-4.css", id: "elementor-post-4-css" })).toBe(false);
    expect(elementor({ kind: "link", href: "wp-content/uploads/elementor/css/post-10.css", id: "elementor-post-10-css" })).toBe(true);
    expect(elementor({ kind: "style", href: "", id: "elementor-post-4" })).toBe(false);
    expect(elementor({ kind: "style", href: "", id: "elementor-post-10" })).toBe(true);
    expect(elementor({ kind: "style", href: "", id: "elementor-frontend-inline-css" })).toBe(false);
  });

  it("una pagina che non è di WordPress: tutti i fogli contano, come prima", () => {
    const html = `<!doctype html><html><head><style>.a{color:red}</style></head><body><p class="a">Ciao</p></body></html>`;
    expect(isWordpressPage(html)).toBe(false);
    expect(brandSheetFilter(html)).toBeNull();
  });
});
