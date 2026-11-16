import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { TransferEntity } from "@histos-publish/histos-contract";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeStaticPageArchive } from "../src/page-transfer.js";
import { convertToXbsite, type AddPageAssetEntity, type AddPageBase, type AddPageStylesEntity, type BrowserImportResult } from "../browser/html-import.js";
import { pageContent } from "../browser/page-content.js";
import type { WasmSqlite } from "../src/project-database-wasm.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * D6: a page added to a site keeps only its content. The theme's header (with its menu), its footer and the admin bar
 * go, with the scripts and sheets that are theirs; the page's own content, its scripts and what shows nothing (hidden
 * SVG definitions, the lightbox of the images) stay. A page whose content is not recognised is imported whole, with a
 * warning.
 */
const PROJECT = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const encoder = new TextEncoder();

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

async function siteBase(): Promise<AddPageBase> {
  const site = await read(await convertToXbsite({ files: [{ path: "index.html", bytes: encoder.encode(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Bottega</title></head><body><main><h1>Il laboratorio</h1></main></body></html>`) }], name: "Bottega", projectId: PROJECT }, sqlite));
  return baseOf(site.entities, site.files);
}

/** A page of a block theme: skip link, admin bar, the theme's header with the Navigation block, the content, the footer. */
const BLOCK_THEME = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Chi siamo</title><link rel="canonical" href="https://esempio.test/chi-siamo/">
<link rel="stylesheet" id="admin-bar-css" href="wp-includes/css/admin-bar.min.css">
<style id="admin-bar-inline-css">html{margin-top:32px !important}</style>
<link rel="stylesheet" id="wp-block-navigation-css" href="wp-includes/blocks/navigation/style.min.css">
<style id="wp-block-site-title-inline-css">.wp-block-site-title{font-weight:700}</style>
<style id="wp-block-group-inline-css">.wp-block-group{box-sizing:border-box}</style>
<style id="wp-block-template-skip-link-inline-css">.skip-link.screen-reader-text{position:absolute}</style>
<style id="core-block-supports-inline-css">.wp-container-1{display:flex}</style>
<script type="importmap" id="wp-importmap">{"imports":{"@wordpress/interactivity":"wp-includes/js/dist/script-modules/interactivity/index.min.js"}}</script>
<link rel="modulepreload" href="wp-includes/js/dist/script-modules/interactivity/index.min.js" id="@wordpress/interactivity-js-modulepreload">
</head><body class="page page-id-9 wp-theme-tema admin-bar">
<div id="wpadminbar" class="nojq"><a href="wp-admin/">Bacheca della barra</a></div>
<a class="skip-link screen-reader-text" id="wp-skip-link" href="#wp--skip-link--target">Vai al contenuto</a>
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="visibility:hidden;position:absolute"><defs><filter id="wp-duotone-1"><feColorMatrix type="saturate" values="0"/></filter></defs></svg>
<div class="wp-site-blocks">
<header class="wp-block-template-part"><div class="wp-block-group wp-container-1"><p class="wp-block-site-title"><a href="/">Testata del tema</a></p><nav class="wp-block-navigation" data-wp-interactive="core/navigation"><ul><li><a href="/corsi/">Menu del tema</a></li></ul></nav></div></header>
<main id="wp--skip-link--target" class="wp-block-group is-layout-constrained"><h1 class="wp-block-heading">Chi siamo</h1><p>Tre generazioni di falegnami.</p></main>
<footer class="wp-block-template-part"><div class="wp-block-group"><p>Piè del tema</p></div></footer>
</div>
<div class="wp-lightbox-overlay" hidden></div>
<script src="wp-includes/js/admin-bar.min.js" id="admin-bar-js"></script>
<script id="@wordpress/block-library/navigation/view-js-module" src="wp-includes/js/dist/script-modules/block-library/navigation/view.min.js" type="module"></script>
<script id="wp-block-template-skip-link-js-after">document.title += " ";/* collegamento al contenuto */</script>
<script>/* script della pagina */ document.documentElement.dataset.pronta = "1";</script>
</body></html>`;

/** A page of a classic theme: #page with the header and its menu, #content with main and a sidebar, the footer. */
const CLASSIC_THEME = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Corsi</title><link rel="canonical" href="https://esempio.test/corsi/">
<link rel="stylesheet" id="tema-style-css" href="wp-content/themes/tema/style.css">
</head><body class="page page-id-12 wp-theme-tema">
<div id="page" class="site">
<a class="skip-link screen-reader-text" href="#primary">Vai al contenuto</a>
<header id="masthead" class="site-header"><p class="site-title">Testata del tema</p><nav id="site-navigation" class="main-navigation"><button class="menu-toggle">Menu del tema</button></nav></header>
<div id="content" class="site-content"><div id="primary" class="content-area"><main id="main" class="site-main"><article class="page"><h1 class="entry-title">Corsi</h1><p class="entry-content">Falegnameria per principianti.</p></article></main></div>
<aside id="secondary" class="widget-area"><p>Barra laterale del tema</p></aside></div>
<footer id="colophon" class="site-footer"><p>Piè del tema</p></footer>
</div>
<script src="wp-content/themes/tema/js/navigation.js" id="tema-navigation-js"></script>
<script src="wp-content/themes/tema/js/galleria.js" id="tema-galleria-js"></script>
</body></html>`;

const THEME_TEXTS = ["Testata del tema", "Menu del tema", "Piè del tema", "Bacheca della barra", "Barra laterale del tema", "Vai al contenuto"];

function files(html: string, extra: Record<string, string> = {}): StaticSiteFile[] {
  return [{ path: "index.html", bytes: encoder.encode(html) }, ...Object.entries(extra).map(([path, text]) => ({ path, bytes: encoder.encode(text) }))];
}

const BLOCK_FILES = files(BLOCK_THEME, {
  "wp-includes/css/admin-bar.min.css": "#wpadminbar{position:fixed}",
  "wp-includes/blocks/navigation/style.min.css": ".wp-block-navigation{display:flex}",
  "wp-includes/js/admin-bar.min.js": "/* barra di amministrazione */ window.barra = 1;",
  "wp-includes/js/dist/script-modules/block-library/navigation/view.min.js": "/* menu di WordPress */ const r = 1;",
  "wp-includes/js/dist/script-modules/interactivity/index.min.js": "/* interactivity */ export const store = 1;",
});
const CLASSIC_FILES = files(CLASSIC_THEME, {
  "wp-content/themes/tema/style.css": ".site-header{padding:1rem}.entry-title{color:#333}",
  "wp-content/themes/tema/js/navigation.js": "/* menu del tema classico */ window.menu = 1;",
  "wp-content/themes/tema/js/galleria.js": "/* galleria del tema */ window.galleria = 1;",
});

function pageOf(entities: readonly TransferEntity[]) {
  return entities.find((entity) => entity.kind === "document")!.payload;
}

describe("D6: della pagina aggiunta resta solo il contenuto", () => {
  it("tema a blocchi: via testata, menu, piè, barra di amministrazione e i loro script e fogli", () => {
    const content = pageContent(BLOCK_THEME);
    expect(content.from).toBe("main");
    for (const text of THEME_TEXTS) expect(content.html).not.toContain(text);
    expect(content.html).toContain("Tre generazioni di falegnami.");
    expect(content.html).not.toContain("<main");
    expect(content.html).toContain(`<div id="wp--skip-link--target" class="wp-block-group is-layout-constrained">`);
    // What shows nothing and the page's own script stay.
    expect(content.html).toContain(`<filter id="wp-duotone-1">`);
    expect(content.html).toContain("wp-lightbox-overlay");
    expect(content.html).toContain("script della pagina");
    expect(content.html).toContain("wp-block-group-inline-css");
    expect(content.html).toContain("core-block-supports-inline-css");
    for (const gone of ["admin-bar-css", "admin-bar-inline-css", "admin-bar-js", "wp-block-navigation-css", "wp-block-site-title-inline-css", "navigation/view-js-module", "wp-importmap", "interactivity-js-modulepreload", "wp-block-template-skip-link"]) expect(content.html).not.toContain(gone);
    // Header and footer of the theme, the admin bar, the skip link; five scripts and five sheets.
    expect(content).toMatchObject({ elements: 4, scripts: 5, sheets: 5 });
  });

  it("tema classico: via testata, menu, barra laterale, piè e lo script del menu del tema", () => {
    const content = pageContent(CLASSIC_THEME);
    expect(content.from).toBe("main");
    for (const text of THEME_TEXTS) expect(content.html).not.toContain(text);
    expect(content.html).toContain("Falegnameria per principianti.");
    expect(content.html).toContain(`<div id="main" class="site-main">`);
    expect(content.html).toContain(`<div id="content" class="site-content"><div id="primary" class="content-area">`);
    expect(content.html).not.toContain("tema-navigation-js");
    expect(content.html).toContain("tema-galleria-js");
    expect(content.html).toContain("tema-style-css");
  });

  it("tema classico senza <main>: #content; tema a blocchi senza <main>: fra le parti del tema", () => {
    const classic = pageContent(CLASSIC_THEME.replaceAll(`<main id="main" class="site-main">`, `<div class="area">`).replaceAll("</main>", "</div>"));
    expect(classic.from).toBe("#content");
    for (const text of THEME_TEXTS.filter((text) => text !== "Barra laterale del tema")) expect(classic.html).not.toContain(text);
    expect(classic.html).toContain("Falegnameria per principianti.");
    const block = pageContent(BLOCK_THEME.replace(/<main([^>]*)>/u, "<div$1>").replace("</main>", "</div>"));
    expect(block.from).toBe("parti-del-tema");
    for (const text of THEME_TEXTS) expect(block.html).not.toContain(text);
    expect(block.html).toContain("Tre generazioni di falegnami.");
  });

  it("nessun contenuto riconoscibile: la pagina resta com'è", () => {
    const html = `<!doctype html><html><head><title>Altro</title></head><body><header><p>Testata</p></header><div class="corpo"><p>Testo</p></div></body></html>`;
    expect(pageContent(html)).toEqual({ html, from: null, elements: 0, scripts: 0, sheets: 0 });
  });

  it("nel pacchetto della pagina aggiunta non c'è niente del tema (a blocchi e classico)", async () => {
    const base = await siteBase();
    for (const [input, kept, gone] of [[BLOCK_FILES, "Tre generazioni di falegnami.", ["menu di WordPress", "barra di amministrazione", "interactivity", "collegamento al contenuto"]], [CLASSIC_FILES, "Falegnameria per principianti.", ["menu del tema classico"]]] as const) {
      const result = await convertToXbsite({ files: [...input], name: "Pagina", addPage: { base } }, sqlite);
      const page = JSON.stringify(pageOf((await read(result)).entities));
      expect(page).toContain(kept);
      for (const text of [...THEME_TEXTS, ...gone]) expect(page).not.toContain(text);
      expect(result.addPage?.content?.from).toBe("main");
      expect(result.notes.filter((note) => note.startsWith("Solo il contenuto della pagina, preso da <main>"))).toHaveLength(1);
      expect(result.warnings.join("\n")).not.toContain("non riconosciuto");
    }
  });

  it("senza contenuto riconoscibile la pagina si importa intera, con un avviso", async () => {
    const base = await siteBase();
    const html = BLOCK_THEME.replace(/<main([^>]*)>/u, "<div$1>").replace("</main>", "</div>").replaceAll("wp-block-template-part", "parte");
    const result = await convertToXbsite({ files: files(html), name: "Pagina", addPage: { base } }, sqlite);
    expect(result.addPage?.content).toEqual({ wordpress: true, from: null, elements: 0, scripts: 0, sheets: 0 });
    expect(result.warnings[0]).toMatch(/^Contenuto della pagina di WordPress non riconosciuto/u);
    expect(JSON.stringify(pageOf((await read(result)).entities))).toContain("Testata del tema");
  });

  it("una pagina che non è di WordPress resta intera, senza avviso: la sua testata non è di un tema", async () => {
    const base = await siteBase();
    const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Contatti</title><link rel="canonical" href="https://esempio.test/contatti/"></head><body><header class="banda"><h1>Testata della pagina</h1></header><main><p>Scrivici.</p></main></body></html>`;
    const result = await convertToXbsite({ files: files(html), name: "Contatti", addPage: { base } }, sqlite);
    expect(result.addPage?.content).toEqual({ wordpress: false, from: null, elements: 0, scripts: 0, sheets: 0 });
    expect(result.warnings.join("\n")).not.toContain("non riconosciuto");
    expect(JSON.stringify(pageOf((await read(result)).entities))).toContain("Testata della pagina");
  });
});
