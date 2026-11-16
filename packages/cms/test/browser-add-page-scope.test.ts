import { existsSync } from "node:fs";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { chromium, type Browser } from "playwright-core";
import postcss from "postcss";
import { findSystemBrowser } from "@histos-publish/core";
import type { TransferEntity } from "@histos-publish/histos-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseXb, type XbBlock } from "../.generated/histos-dsl/index.js";
import { decodeStaticPageArchive } from "../src/page-transfer.js";
import { convertToXbsite, type AddPageAssetEntity, type AddPageBase, type AddPageStylesEntity, type BrowserImportResult } from "../browser/html-import.js";
import { isSizedSheet, markPageContent, PAGE_MARK, pageFilter, pageScope, renameInStyleBody, scopeSelector, scopeSelectorList, scopeSheet, styleRules } from "../browser/page-scope.js";
import type { WasmSqlite } from "../src/project-database-wasm.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * V5.5: the styles of an added page hold only on that page. The packages are read back, their CSS put together as the
 * plugin prints it (global sheets, then each style as `selector{css}`), and two pages rendered in Chromium with it: the
 * site's other page, which must look as it did before the import, and the added page, which must look as its original.
 */
const PROJECT = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const encoder = new TextEncoder();
const ONE_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

let sqlite: WasmSqlite;
beforeAll(async () => {
  sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
});

function page(input: { title: string; canonical?: string; body: string; css: string; image?: boolean }): StaticSiteFile[] {
  const head = `<meta charset="utf-8"><title>${input.title}</title>${input.canonical ? `<link rel="canonical" href="${input.canonical}">` : ""}<link rel="stylesheet" href="stile.css">`;
  const files: StaticSiteFile[] = [
    { path: "index.html", bytes: encoder.encode(`<!doctype html><html lang="it"><head>${head}</head><body>${input.body}</body></html>`) },
    { path: "stile.css", bytes: encoder.encode(input.css) },
  ];
  if (input.image) files.push({ path: "img/foto.png", bytes: PNG });
  return files;
}

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

function applied(live: readonly TransferEntity[], incoming: readonly TransferEntity[]): TransferEntity[] {
  const byId = new Map(live.map((entity) => [entity.id, entity]));
  for (const entity of incoming) byId.set(entity.id, entity);
  return [...byId.values()];
}

/** The site's CSS as the plugin prints it: the global sheets in order, then each style compiled as `selector{css}`. */
function siteCss(entities: readonly TransferEntity[]): string {
  const payload = entities.find((entity) => entity.kind === "styles")!.payload as unknown as AddPageStylesEntity["payload"];
  return [...payload.globals.map((sheet) => sheet.css), ...payload.styles.flatMap((entry) => styleRules(entry.selector, entry.css)).map((rule) => `${rule.selector}{${rule.css}}`)].join("\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** A page's content as HTML: elements with their attributes and texts, enough for the cascade (media become one image). */
function render(blocks: readonly XbBlock[]): string {
  return blocks.map((block) => {
    if (block.name === "xb/text") return block.attrs.content;
    if (block.name !== "xb/element") return "children" in block ? render(block.children as XbBlock[]) : "";
    const attributes = Object.entries(block.attrs.attributes ?? {}).map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(value).startsWith("histos-media://") ? ONE_PIXEL : String(value))}"`)).join("");
    return ["img", "br", "hr", "input"].includes(block.attrs.tag) ? `<${block.attrs.tag}${attributes}>` : `<${block.attrs.tag}${attributes}>${render(block.children)}</${block.attrs.tag}>`;
  }).join("");
}

function documentOf(entities: readonly TransferEntity[], slug: string): string {
  const document = entities.find((entity) => entity.kind === "document" && entity.payload.slug === slug)!;
  return render(parseXb(String(document.payload.content)).blocks);
}

/** What the probes read of a rendered page: computed values by CSS selector. */
interface Probe {
  selector: string;
  properties: string[];
}

const browserFound = await findSystemBrowser().then(() => true, () => existsSync(chromium.executablePath()));
let browser: Browser | undefined;
afterAll(async () => {
  await browser?.close();
});

async function computed(css: string, body: string, probes: readonly Probe[]): Promise<Record<string, Record<string, string>>> {
  if (!browser) {
    const executablePath = await findSystemBrowser().catch(() => undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  }
  const tab = await browser.newPage();
  try {
    await tab.setContent(`<!doctype html><html lang="it"><head><style>${css}</style></head><body>${body}</body></html>`);
    return await tab.evaluate((items) => {
      const out: Record<string, Record<string, string>> = {};
      for (const item of items) {
        const element = document.querySelector(item.selector);
        const style = element ? getComputedStyle(element) : null;
        out[item.selector] = Object.fromEntries(item.properties.map((property) => [property, style ? style.getPropertyValue(property).trim() : "assente"]));
      }
      return out;
    }, probes as Probe[]);
  } finally {
    await tab.close();
  }
}

/** The site: a home with a heading, a class, its own animation and variable. No framework, so the values stay values. */
const SITE = page({
  title: "Bottega",
  body: `<header class="testata"><h1 class="testata__titolo">Bottega</h1></header><main><div class="storia">Da noi</div><p class="nota">Nota</p></main>`,
  css: `:root{--accento:#00f}body{margin:0;background:#fff;color:#222}.testata__titolo{animation:giro 2s}.nota{margin:3px}@keyframes giro{to{opacity:.5}}`,
});

/** The page to add: a body background, a tag rule, a class the site's markup has too, the same animation and variable. */
const ADDED = page({
  title: "Chi siamo",
  canonical: "https://esempio.test/chi-siamo/",
  body: `<header class="cima"><h1>Chi siamo</h1></header><main><div class="storia"><p>Dal 1990.</p><img src="img/foto.png" alt="Ritratto"></div></main>`,
  css: `:root{--accento:#0a0}html{font-size:20px}body{background:#ffd700;margin:8px}h1{color:#800000;animation:giro 1s}p{letter-spacing:2px}.storia{padding:7px;border-left:4px solid var(--accento)}.cima::before{content:"*"}.storia img{height:30px}@keyframes giro{from{opacity:0}}@page{margin:1cm}`,
  image: true,
});

const OTHER_PROBES: Probe[] = [
  { selector: "html", properties: ["font-size", "--accento"] },
  { selector: "body", properties: ["background-color", "margin-top"] },
  { selector: ".testata__titolo", properties: ["color", "animation-name"] },
  { selector: ".storia", properties: ["padding-top", "border-left-width"] },
  { selector: ".nota", properties: ["letter-spacing", "margin-top"] },
];

const ADDED_PROBES: Probe[] = [
  { selector: "html", properties: ["font-size", "--accento"] },
  { selector: "body", properties: ["background-color", "margin-top"] },
  { selector: "h1", properties: ["color", "animation-name"] },
  { selector: "p", properties: ["letter-spacing"] },
  { selector: ".storia", properties: ["padding-top", "border-left-color"] },
  { selector: "img", properties: ["width"] },
];

describe("pagina aggiunta: gli stili valgono solo sulla sua pagina (V5.5)", () => {
  it("ogni regola della pagina è limitata alla pagina, il foglio delle misure resta uno e del sito", async () => {
    const site = await read(await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT, framework: "none" }, sqlite));
    const base = baseOf(site.entities, site.files);
    const result = await convertToXbsite({ files: ADDED, name: "Chi siamo", framework: "none", addPage: { base } }, sqlite);
    const out = await read(result);
    const styles = out.entities.find((entity) => entity.kind === "styles")!.payload as unknown as AddPageStylesEntity["payload"];
    const filter = pageFilter("chi-siamo");
    expect(result.addPage?.mark).toBe("chi-siamo");
    // The page's top-level elements carry the mark, nothing else is added to the page.
    const content = String(out.entities.find((entity) => entity.kind === "document")!.payload.content);
    expect(content.split(`"${PAGE_MARK}":"chi-siamo"`).length - 1).toBe(2);
    // Every rule the page added has the page's filter on its subject (keyframe steps aside).
    const added = styles.globals.slice(base.styles.payload.globals.length);
    expect(added.map((sheet) => sheet.id)).toEqual(["misure-immagini", "chi-siamo-foglio-1"]);
    const [sized, own] = added;
    expect(isSizedSheet(sized!.css)).toBe(true);
    expect(sized!.css).not.toContain(PAGE_MARK);
    let rules = 0;
    postcss.parse(own!.css).walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/u.test((rule.parent as { name: string }).name)) return;
      rules++;
      for (const selector of rule.selectors) expect(selector).toContain(filter);
    });
    expect(rules).toBeGreaterThanOrEqual(5);
    for (const entry of styles.styles.slice(base.styles.payload.styles.length)) expect(entry.selector).toBe(scopeSelectorList(entry.selector.slice(0, entry.selector.indexOf(":where(")), filter));
    // The page's animation has the site's name: it takes the page's, with its reference; @page holds for every page.
    expect(result.addPage?.renamed).toEqual([{ kind: "animazione", from: "giro", to: "giro--chi-siamo" }]);
    expect(own!.css).toContain("@keyframes giro--chi-siamo");
    expect(own!.css).not.toContain("@page");
    expect(result.notes).toContain("Regola @page della pagina non importata: varrebbe per tutto il sito");
  }, 120_000);

  it.skipIf(!browserFound)("nel browser l'altra pagina resta com'era e la pagina aggiunta come l'originale; due pagine tengono ognuna i suoi stili", async () => {
    const site = await read(await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT, framework: "none" }, sqlite));
    const home = documentOf(site.entities, "home");
    const before = await computed(siteCss(site.entities), home, OTHER_PROBES);
    // The site as it is: its own variable, animation and margins.
    expect(before).toMatchObject({ html: { "--accento": "#00f" }, body: { "background-color": "rgb(255, 255, 255)", "margin-top": "0px" }, ".testata__titolo": { "animation-name": "giro" }, ".storia": { "padding-top": "0px" }, ".nota": { "letter-spacing": "normal" } });

    const first = await read(await convertToXbsite({ files: ADDED, name: "Chi siamo", framework: "none", addPage: { base: baseOf(site.entities, site.files) } }, sqlite));
    const live = applied(site.entities, first.entities);
    // The other page, with the styles of the site after the import: exactly as before.
    expect(await computed(siteCss(live), home, OTHER_PROBES)).toEqual(before);
    // The added page, with the site's styles: as its original (rendered with its own CSS only).
    const originalBody = new TextDecoder().decode(ADDED[0]!.bytes).replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/gu, "").replace("img/foto.png", ONE_PIXEL);
    const original = await computed(new TextDecoder().decode(ADDED[1]!.bytes), originalBody, ADDED_PROBES);
    const addedPage = documentOf(live, "chi-siamo");
    const rendered = await computed(siteCss(live), addedPage, ADDED_PROBES);
    // The same, but for the name of the page's own animation (the site has one called giro) and the image's file.
    expect(rendered).toEqual({ ...original, h1: { ...original.h1, "animation-name": "giro--chi-siamo" } });
    expect(original).toMatchObject({ html: { "font-size": "20px", "--accento": "#0a0" }, body: { "background-color": "rgb(255, 215, 0)", "margin-top": "8px" }, h1: { color: "rgb(128, 0, 0)" } });
    expect(rendered.h1!["animation-name"]).toBe("giro--chi-siamo");
    // The rule of the sized images holds on the added page: the image the conversion gave width="1" and height="1"
    // takes its width from the page's height (30px), as the original without attributes did.
    expect(addedPage).toContain('data-histos-sized="width height"');
    expect(rendered.img!.width).toBe("30px");

    // A second page added after the first, with the same class and other values: each page keeps its own.
    const files = [...site.files, ...first.files];
    const second = page({ title: "Corsi", canonical: "https://esempio.test/corsi/", body: `<main><div class="storia"><p>Ogni sabato.</p><img src="img/foto.png" alt="Banco"></div></main>`, css: `body{background:#e0ffff}.storia{padding:11px}`, image: true });
    const secondResult = await convertToXbsite({ files: second, name: "Corsi", framework: "none", addPage: { base: baseOf(live, new Map(files)) } }, sqlite);
    const secondOut = await read(secondResult);
    // The sheet of the sized images is the site's now: not added again.
    expect(secondResult.addPage?.sheetsAdded).toEqual(["corsi-foglio-1"]);
    const live2 = applied(live, secondOut.entities);
    const css2 = siteCss(live2);
    expect(css2.split(`[${SIZED_MARK_TEXT}~="width"]`).length - 1).toBe(1);
    expect(await computed(css2, home, OTHER_PROBES)).toEqual(before);
    expect(await computed(css2, addedPage, ADDED_PROBES)).toEqual(rendered);
    const corsi = await computed(css2, documentOf(live2, "corsi"), [{ selector: "body", properties: ["background-color"] }, { selector: ".storia", properties: ["padding-top", "border-left-width"] }]);
    expect(corsi).toEqual({ body: { "background-color": "rgb(224, 255, 255)" }, ".storia": { "padding-top": "11px", "border-left-width": "0px" } });
  }, 120_000);
});

const SIZED_MARK_TEXT = "data-histos-sized";

describe("i selettori e i nomi limitati alla pagina (V5.5)", () => {
  const filter = pageFilter("p");
  it("il filtro va sul soggetto, prima dello pseudo-elemento, e un selettore che finisce con un combinatore resta com'è", () => {
    const cases: Array<[string, string]> = [
      ["h1", `h1${filter}`],
      [".a > .b", `.a > .b${filter}`],
      ["body", `body${filter}`],
      [":root", `:root${filter}`],
      ["*", `*${filter}`],
      [".a::before", `.a${filter}::before`],
      ["p:first-line", `p${filter}:first-line`],
      ["a:hover:not(.x)", `a:hover:not(.x)${filter}`],
      [":is(h1, h2) span", `:is(h1, h2) span${filter}`],
      ["input::-webkit-input-placeholder", `input${filter}::-webkit-input-placeholder`],
      ["::selection", `${filter}::selection`],
      ['[title="a > b"]', `[title="a > b"]${filter}`],
      [".x\\31 23 p", `.x\\31 23 p${filter}`],
      [".a\\:b", `.a\\:b${filter}`],
      [".a:has(> img)", `.a:has(> img)${filter}`],
      ["> p", `> p${filter}`],
      [".a >", ".a >"],
    ];
    for (const [selector, expected] of cases) expect(scopeSelector(selector, filter), selector).toBe(expected);
    expect(scopeSelectorList(".a, .b::after", filter)).toBe(`.a${filter},.b${filter}::after`);
  });

  it("@media, @supports e @layer si riscrivono dentro; @keyframes, @font-face, @counter-style e @property del sito non si pestano", () => {
    const site = [`@keyframes giro{to{opacity:1}}@font-face{font-family:"Lora";src:url(a.woff2)}@counter-style stelle{system:cyclic;symbols:"*"}@property --angolo{syntax:"<angle>";inherits:false;initial-value:0deg}`];
    const pageCss = `@media (min-width:600px){h1{color:red}}@supports (display:grid){@layer base{.a{display:grid}}}@font-face{font-family:Lora;src:url(b.woff2)}@counter-style stelle{system:cyclic;symbols:"+"}@property --angolo{syntax:"<angle>";inherits:true;initial-value:10deg}@keyframes giro{from{opacity:0}}h2{font:bold 16px/1.2 Lora, serif;animation:giro 1s;--angolo:5deg;transform:rotate(var(--angolo))}ol{list-style:stelle inside}li::marker{content:counter(item, stelle)}p{font-family:"lora",serif}@import url(x.css);`;
    const scope = pageScope("chi", site, [pageCss]);
    expect(scope.renamed.map((item) => [item.kind, item.from, item.to])).toEqual([["animazione", "giro", "giro--chi"], ["contatore", "stelle", "stelle--chi"], ["proprieta", "--angolo", "--angolo--chi"], ["carattere", "Lora", "Lora chi"]]);
    const out = scopeSheet(pageCss, scope)!;
    const own = pageFilter("chi");
    expect(out.css).toContain(`@media (min-width:600px){h1${own}{color:red}}`);
    expect(out.css).toContain(`@supports (display:grid){@layer base{.a${own}{display:grid}}}`);
    expect(out.css).toContain(`@font-face{font-family:"Lora chi";src:url(b.woff2)}`);
    expect(out.css).toContain("@counter-style stelle--chi{");
    expect(out.css).toContain("@property --angolo--chi{");
    expect(out.css).toContain("@keyframes giro--chi{from{opacity:0}}");
    expect(out.css).toContain(`h2${own}{font:bold 16px/1.2 "Lora chi", serif;animation:giro--chi 1s;--angolo--chi:5deg;transform:rotate(var(--angolo--chi))}`);
    expect(out.css).toContain(`ol${own}{list-style:stelle--chi inside}`);
    expect(out.css).toContain(`li${own}::marker{content:counter(item, stelle--chi)}`);
    expect(out.css).toContain(`p${own}{font-family:"Lora chi",serif}`);
    expect(out.css).not.toContain("@import");
    expect(out.notes).toEqual(["Regola @import della pagina non importata: varrebbe per tutto il sito"]);
    // A style by selector keeps its body, with the renamed names.
    expect(renameInStyleBody("animation:giro 1s;&:hover{font-family:Lora}", scope)).toBe('animation:giro--chi 1s;&:hover{font-family:"Lora chi"}');
    // Names the site does not have stay the page's own; the mark is the slug unless the site's styles already name it.
    expect(pageScope("chi", [], [pageCss]).renamed).toEqual([]);
    expect(pageScope("chi", [`p${pageFilter("chi")}{color:red}`], []).mark).toBe("chi-2");
  });

  it("segna solo gli elementi principali della pagina", () => {
    const content = '<!-- wp:xb/element {"uid":"pa0000000001","tag":"main"} --><!-- wp:xb/element {"uid":"pa0000000002","tag":"p","attributes":{"class":"x"}} --><!-- wp:xb/text {"uid":"pa0000000003","content":"Ciao"} /--><!-- /wp:xb/element --><!-- /wp:xb/element --><!-- wp:xb/text {"uid":"pa0000000004","content":"fuori"} /-->';
    const marked = markPageContent(content, "chi");
    expect(marked.marked).toBe(1);
    expect(marked.content).toBe(content.replace('"tag":"main"}', `"tag":"main","attributes":{"${PAGE_MARK}":"chi"}}`));
  });
});
