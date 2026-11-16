import { existsSync } from "node:fs";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { chromium, type Browser } from "playwright-core";
import { findSystemBrowser } from "@histos-publish/core";
import { canonicalizeJson, type JsonValue, type TransferEntity } from "@histos-publish/histos-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseXb, type XbBlock } from "../.generated/histos-dsl/index.js";
import { decodeStaticPageArchive } from "../src/page-transfer.js";
import { histosGlobalCss } from "../src/histos-css.js";
import { AddPageError, convertToXbsite, type AddPageAssetEntity, type AddPageBase, type AddPageStylesEntity, type BrowserImportInput, type BrowserImportResult } from "../browser/html-import.js";
import { protectColorNames } from "../browser/page-colors.js";
import { styleRules } from "../browser/page-scope.js";
import type { WasmSqlite } from "../src/project-database-wasm.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * V5.7: whose colours a page added to a site shows (`addPage.colors`): the page's own (`pagina`), the site's (`sito`, as
 * when it is missing), or the site's colour variables replaced by the page's (`sostituisci`). The packages are read back
 * and rendered in Chromium with the site's CSS as the plugin prints it: Histeon CSS with the design and the token
 * overrides, the global sheets, then the styles.
 */
const PROJECT = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const encoder = new TextEncoder();

let sqlite: WasmSqlite;
beforeAll(async () => {
  sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
});

function page(input: { title: string; canonical?: string; body: string; css: string }): StaticSiteFile[] {
  const head = `<meta charset="utf-8"><title>${input.title}</title>${input.canonical ? `<link rel="canonical" href="${input.canonical}">` : ""}<link rel="stylesheet" href="stile.css">`;
  return [
    { path: "index.html", bytes: encoder.encode(`<!doctype html><html lang="it"><head>${head}</head><body>${input.body}</body></html>`) },
    { path: "stile.css", bytes: encoder.encode(input.css) },
  ];
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

/** The base with other settings of Histeon CSS, its revision hash written again as the plugin's snapshot would. */
async function withSettings(base: AddPageBase, settings: { design?: Record<string, JsonValue>; tokenOverrides?: Record<string, JsonValue>; globals?: AddPageStylesEntity["payload"]["globals"] }): Promise<AddPageBase> {
  const { canonicalRevisionPayload } = await import("@histos-publish/histos-contract");
  const { createHash } = await import("node:crypto");
  const payload = { ...base.styles.payload, ...settings } as unknown as Record<string, JsonValue>;
  const revisionHash = createHash("sha256").update(canonicalRevisionPayload("styles", 1, payload)).digest("hex");
  return { ...base, styles: { ...base.styles, payload: payload as unknown as AddPageStylesEntity["payload"], revisionHash } };
}

function stylesOf(entities: readonly TransferEntity[]): AddPageStylesEntity["payload"] {
  return entities.find((entity) => entity.kind === "styles")!.payload as unknown as AddPageStylesEntity["payload"];
}

function applied(live: readonly TransferEntity[], incoming: readonly TransferEntity[]): TransferEntity[] {
  const byId = new Map(live.map((entity) => [entity.id, entity]));
  for (const entity of incoming) byId.set(entity.id, entity);
  return [...byId.values()];
}

/** The site's CSS as the plugin prints it: Histeon CSS with design and token overrides, the global sheets, the styles. */
function siteCss(entities: readonly TransferEntity[]): string {
  const payload = stylesOf(entities);
  return [
    histosGlobalCss({ design: payload.design ?? {}, tokenOverrides: payload.tokenOverrides ?? {}, globals: payload.globals }),
    ...payload.styles.flatMap((entry) => styleRules(entry.selector, entry.css)).map((rule) => `${rule.selector}{${rule.css}}`),
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function render(blocks: readonly XbBlock[]): string {
  return blocks.map((block) => {
    if (block.name === "xb/text") return block.attrs.content;
    if (block.name !== "xb/element") return "children" in block ? render(block.children as XbBlock[]) : "";
    const attributes = Object.entries(block.attrs.attributes ?? {}).map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(value))}"`)).join("");
    return ["img", "br", "hr", "input"].includes(block.attrs.tag) ? `<${block.attrs.tag}${attributes}>` : `<${block.attrs.tag}${attributes}>${render(block.children)}</${block.attrs.tag}>`;
  }).join("");
}

function documentOf(entities: readonly TransferEntity[], slug: string): string {
  const document = entities.find((entity) => entity.kind === "document" && entity.payload.slug === slug)!;
  return render(parseXb(String(document.payload.content)).blocks);
}

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
      // A colour as the screen shows it (Histeon CSS writes oklch(), a page #rrggbb): one pixel painted with it.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const paint = canvas.getContext("2d", { willReadFrequently: true })!;
      const screen = (value: string): string => {
        paint.clearRect(0, 0, 1, 1);
        paint.fillStyle = value;
        paint.fillRect(0, 0, 1, 1);
        const [red, green, blue] = paint.getImageData(0, 0, 1, 1).data;
        return `rgb(${red}, ${green}, ${blue})`;
      };
      const out: Record<string, Record<string, string>> = {};
      for (const item of items) {
        const element = document.querySelector(item.selector);
        const style = element ? getComputedStyle(element) : null;
        out[item.selector] = Object.fromEntries(item.properties.map((property) => {
          const value = style ? style.getPropertyValue(property).trim() : "assente";
          return [property, property.endsWith("color") && style ? screen(value) : value];
        }));
      }
      return out;
    }, probes as Probe[]);
  } finally {
    await tab.close();
  }
}

/** The site: a blue brand (#1a4d8f) and an orange second colour (#e07a10), written as Histeon CSS variables. */
const SITE = page({
  title: "Bottega",
  body: `<header class="testata"><a class="testata__marchio" href="/">Bottega</a></header><main><h1 class="titolo">Il laboratorio</h1><p class="nota">Dal 1950.</p><a class="bottone" href="/x/">Scrivici</a></main>`,
  css: `body{margin:0}.testata{padding:16px;background:#1a4d8f}.testata__marchio{color:#1a4d8f;background:#fff}.titolo{color:#1a4d8f;font-size:40px}.nota{border-bottom:2px solid #e07a10;padding:4px}.bottone{background:#e07a10;color:#fff;padding:8px}`,
});

/** The page to add: a green brand (#2e7d32) and a red second colour (#c62828), and one value it already had as a variable. */
const ADDED = page({
  title: "Chi siamo",
  canonical: "https://esempio.test/chi-siamo/",
  body: `<header class="banda"><h1 class="banda__titolo">Chi siamo</h1></header><main><p class="storia">Tre generazioni.</p><a class="invito" href="/y/">Vieni</a><p class="vecchia">Scritto prima.</p></main>`,
  css: `.banda{background:#2e7d32;padding:20px}.banda__titolo{color:#fff;border-bottom:3px solid #2e7d32}.storia{color:#2e7d32;border-left:5px solid #c62828}.invito{background:#c62828;color:#fff}.vecchia{color:var(--xb-primary)}`,
});

const OTHER_PROBES: Probe[] = [
  { selector: ".testata", properties: ["background-color", "padding-top"] },
  { selector: ".testata__marchio", properties: ["color"] },
  { selector: ".titolo", properties: ["color", "font-size"] },
  { selector: ".nota", properties: ["border-bottom-color", "padding-top"] },
  { selector: ".bottone", properties: ["background-color", "color"] },
];

const ADDED_PROBES: Probe[] = [
  { selector: ".banda", properties: ["background-color", "padding-top"] },
  { selector: ".banda__titolo", properties: ["border-bottom-color"] },
  { selector: ".storia", properties: ["color", "border-left-color"] },
  { selector: ".invito", properties: ["background-color"] },
];

async function siteAndBase() {
  const site = await read(await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT }, sqlite));
  return { site, base: baseOf(site.entities, site.files) };
}

async function addWith(base: AddPageBase, colors: "pagina" | "sito" | "sostituisci" | undefined, extra: Partial<BrowserImportInput> = {}) {
  const result = await convertToXbsite({ files: ADDED, name: "Chi siamo", ...extra, addPage: { base, ...(colors ? { colors } : {}) } }, sqlite);
  return { result, out: await read(result) };
}

/** Every colour of the probes within 2 of the other's on each channel (oklch() rounds), the rest the same. */
function expectClose(actual: Record<string, Record<string, string>>, expected: Record<string, Record<string, string>>): void {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [selector, values] of Object.entries(expected)) {
    for (const [property, value] of Object.entries(values)) {
      const [left, right] = [actual[selector]![property]!, value].map((text) => /^rgb\((\d+), (\d+), (\d+)\)$/u.exec(text)?.slice(1).map(Number));
      if (left && right) expect(left.every((channel, index) => Math.abs(channel - right[index]!) <= 2), `${selector} ${property}: ${actual[selector]![property]} / ${value}`).toBe(true);
      else expect(actual[selector]![property], `${selector} ${property}`).toBe(value);
    }
  }
}

const COLOR_NAME = /^--xb-(?:primary|secondary|on-primary|on-secondary|link|link-hover|focus|accent|neutral)(?:-|$)/u;

describe("pagina aggiunta: la scelta dei colori (V5.7)", () => {
  it("senza colors l'uscita è quella di prima; con «sito» lo stesso pacchetto e il rapporto dei colori", async () => {
    const { base } = await siteAndBase();
    const before = await addWith(base, undefined);
    const sito = await addWith(base, "sito");
    expect(before.result.addPage?.colors).toBeUndefined();
    // The same package, but for the random snapshot id of the selection.
    const strip = (entities: readonly TransferEntity[]) => canonicalizeJson(entities as unknown as JsonValue);
    expect(strip(sito.out.entities)).toBe(strip(before.out.entities));
    expect(sito.result.addPage?.colors).toEqual({ mode: "sito", page: [{ family: "primary", variable: "--xb-primary", value: "#2e7d32" }, { family: "secondary", variable: "--xb-secondary", value: "#c62828" }], kept: 0, settings: [], changes: [], covered: [] });
    // The page's colours are the site's variables.
    const added = stylesOf(sito.out.entities).styles.slice(base.styles.payload.styles.length).map((entry) => entry.css).join("");
    expect(added).toContain("var(--xb-primary)");
    expect(added).not.toContain("#2e7d32");
  }, 120_000);

  it("«pagina» tiene i valori dell'originale e non cambia il sito; una variabile scritta dalla pagina resta variabile", async () => {
    const { base } = await siteAndBase();
    const { result, out } = await addWith(base, "pagina");
    const styles = stylesOf(out.entities);
    // The site's entries are there as they were, and its settings too.
    expect(styles.styles.slice(0, base.styles.payload.styles.length)).toEqual(base.styles.payload.styles);
    expect(styles.globals.slice(0, base.styles.payload.globals.length)).toEqual(base.styles.payload.globals);
    expect(styles.design ?? {}).toEqual(base.styles.payload.design ?? {});
    expect(styles.tokenOverrides ?? {}).toEqual(base.styles.payload.tokenOverrides ?? {});
    const added = styles.styles.slice(base.styles.payload.styles.length);
    const css = added.map((entry) => entry.css).join("\n");
    expect(css).toContain("#2e7d32");
    expect(css).toContain("#c62828");
    expect(css).not.toContain("var(--xb-secondary)");
    // Only the page's own `var(--xb-primary)` (in .vecchia) is left: the conversion's ones went back to the colour.
    expect(css.split("var(--xb-primary)").length - 1).toBe(1);
    expect(added.find((entry) => entry.selector.startsWith(".vecchia"))?.css).toContain("var(--xb-primary)");
    expect(result.addPage?.colors?.mode).toBe("pagina");
    expect(result.addPage?.colors?.kept).toBe(5);
    expect(result.notes).toContain("Colori della pagina tenuti nella pagina: 5 variabili del sito tornate ai valori della pagina, il sito non cambia");
    // No name set apart for the conversion is left anywhere.
    expect(JSON.stringify(out.entities)).not.toContain("--h57k");
    expect(result.prototype).not.toContain("--h57k");
  }, 120_000);

  it("«sostituisci» cambia solo i colori del sito ed elenca ogni variabile prima → dopo", async () => {
    const { base: plain } = await siteAndBase();
    // A site with its own radius and font, and an override of its brand colour.
    const base = await withSettings(plain, { design: { ...((plain.styles.payload.design ?? {}) as Record<string, JsonValue>), radius: 4, font_body: "Georgia, serif" }, tokenOverrides: { "xb-primary": "#1a4d8f" } });
    const { result, out } = await addWith(base, "sostituisci");
    const styles = stylesOf(out.entities);
    const report = result.addPage!.colors!;
    expect(report.mode).toBe("sostituisci");
    const liveDesign = base.styles.payload.design as Record<string, JsonValue>;
    expect(report.settings).toEqual([
      { name: "design.primary", before: String(liveDesign.primary), after: "#2e7d32" },
      { name: "tokenOverrides.xb-primary", before: "#1a4d8f", after: "#2e7d32" },
      { name: "design.secondary", before: String(liveDesign.secondary), after: "#c62828" },
    ]);
    // Only the colours of the design changed: radius, font and every other parameter as they were.
    const design = styles.design as Record<string, JsonValue>;
    expect(Object.keys(design).sort()).toEqual(Object.keys(liveDesign).sort());
    for (const [key, value] of Object.entries(liveDesign)) if (key !== "primary" && key !== "secondary") expect(design[key], key).toEqual(value);
    expect(design.primary).toBe("#2e7d32");
    expect(design.secondary).toBe("#c62828");
    expect(styles.tokenOverrides).toEqual({ "xb-primary": "#2e7d32" });
    // The list: the colour variables only, each with its value before and after.
    expect(report.changes.length).toBeGreaterThan(10);
    for (const change of report.changes) {
      expect(change.variable, change.variable).toMatch(COLOR_NAME);
      expect(change.before).not.toBe(change.after);
    }
    expect(report.changes).toContainEqual({ variable: "--xb-primary", theme: "chiaro", before: "#1a4d8f", after: "#2e7d32" });
    expect(report.changes.some((change) => change.variable === "--xb-secondary")).toBe(true);
    expect(report.covered).toEqual([]);
    // The page keeps the variables: it shows the new colours of the site.
    expect(styles.styles.slice(base.styles.payload.styles.length).map((entry) => entry.css).join("")).toContain("var(--xb-primary)");
    // The site's own styles and sheets are not touched.
    expect(styles.styles.slice(0, base.styles.payload.styles.length)).toEqual(base.styles.payload.styles);
    // The radius and the font of the page are not imported, and the report says so.
    expect(result.notes.some((note) => note.startsWith("Colori del sito sostituiti con quelli della pagina: cambiano"))).toBe(true);
  }, 120_000);

  it("«sostituisci» dice quando un foglio del sito dichiara anche una variabile che cambia", async () => {
    const { base: plain } = await siteAndBase();
    const base = await withSettings(plain, { globals: [...plain.styles.payload.globals, { id: "mio-foglio", css: ".scuro{--xb-primary:#000}" }] });
    const { result } = await addWith(base, "sostituisci");
    expect(result.addPage?.colors?.covered).toEqual([{ variable: "--xb-primary", sheet: "mio-foglio" }]);
    expect(result.notes).toContain("Variabile --xb-primary dichiarata anche nel foglio mio-foglio del sito: dove vale quella regola resta il suo valore");
  }, 120_000);

  it("errori: sito senza variabili dei colori, pagina senza colori, valore sconosciuto", async () => {
    const { base } = await siteAndBase();
    for (const framework of ["acss", "core", "none"] as const) {
      const error = await convertToXbsite({ files: ADDED, name: "Chi siamo", framework, addPage: { base, colors: "sostituisci" } }, sqlite).catch((caught: unknown) => caught);
      expect(error, framework).toBeInstanceOf(AddPageError);
      expect((error as AddPageError).code).toBe("colori-senza-variabili");
      expect((error as AddPageError).detail).toBe(framework);
    }
    const grey = page({ title: "Grigia", canonical: "https://esempio.test/grigia/", body: `<main><p class="g">Niente colori</p></main>`, css: `.g{color:#333;background:#fff}` });
    const none = await convertToXbsite({ files: grey, name: "Grigia", addPage: { base, colors: "sostituisci" } }, sqlite).catch((caught: unknown) => caught);
    expect((none as AddPageError).code).toBe("colori-pagina-assenti");
    // The same grey page with «pagina» or «sito»: nothing to choose, and no error.
    for (const colors of ["pagina", "sito"] as const) {
      const ok = await convertToXbsite({ files: grey, name: "Grigia", addPage: { base, colors } }, sqlite);
      expect(ok.addPage?.colors).toEqual({ mode: colors, page: [], kept: 0, settings: [], changes: [], covered: [] });
    }
    const wrong = await convertToXbsite({ files: ADDED, name: "Chi siamo", addPage: { base, colors: "tutti" as never } }, sqlite).catch((caught: unknown) => caught);
    expect((wrong as AddPageError).code).toBe("base-non-valida");
    expect((wrong as AddPageError).detail).toBe("addPage.colors");
  }, 120_000);

  it("i nomi dei colori che la pagina usa già si mettono da parte e tornano come erano", () => {
    const files: StaticSiteFile[] = [
      { path: "a.css", bytes: encoder.encode(".a{color:var(--xb-primary);--primary:1;x:var(--primary-2) var(--my--primary) var(--secondaryx)}") },
      { path: "f.png", bytes: encoder.encode("--xb-primary") },
    ];
    const guarded = protectColorNames(files);
    const text = new TextDecoder().decode(guarded.files[0]!.bytes);
    expect(text).toBe(".a{color:var(--h57k0-xb-primary);--h57k0-primary:1;x:var(--primary-2) var(--my--primary) var(--secondaryx)}");
    expect(guarded.files[1]).toBe(files[1]);
    expect(guarded.restore(text)).toBe(new TextDecoder().decode(files[0]!.bytes));
    // A page without those names: the same files.
    const plain = [{ path: "b.css", bytes: encoder.encode(".b{color:red}") }];
    expect(protectColorNames(plain).files[0]).toBe(plain[0]);
  });

  it.skipIf(!browserFound)("nel browser: «pagina» come l'originale e l'altra pagina identica; «sostituisci» cambia l'altra pagina solo nelle variabili elencate", async () => {
    const { site, base } = await siteAndBase();
    const home = documentOf(site.entities, "home");
    const before = await computed(siteCss(site.entities), home, OTHER_PROBES);
    expectClose({ a: before[".testata"]!, b: before[".bottone"]! }, { a: { "background-color": "rgb(26, 77, 143)", "padding-top": "16px" }, b: { "background-color": "rgb(224, 122, 16)", color: "rgb(255, 255, 255)" } });
    const originalBody = new TextDecoder().decode(ADDED[0]!.bytes).replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/gu, "");
    const original = await computed(new TextDecoder().decode(ADDED[1]!.bytes), originalBody, ADDED_PROBES);
    expect(original).toMatchObject({ ".banda": { "background-color": "rgb(46, 125, 50)" }, ".invito": { "background-color": "rgb(198, 40, 40)" } });

    // «pagina»: the added page as its original, the other page as before.
    const pagina = applied(site.entities, (await addWith(base, "pagina")).out.entities);
    expect(await computed(siteCss(pagina), documentOf(pagina, "chi-siamo"), ADDED_PROBES)).toEqual(original);
    expect(await computed(siteCss(pagina), home, OTHER_PROBES)).toEqual(before);

    // «sito»: the added page takes the site's colours.
    const sito = applied(site.entities, (await addWith(base, "sito")).out.entities);
    expect((await computed(siteCss(sito), documentOf(sito, "chi-siamo"), ADDED_PROBES))[".banda"]!["background-color"]).toBe(before[".testata"]!["background-color"]);
    expect(await computed(siteCss(sito), home, OTHER_PROBES)).toEqual(before);

    // «sostituisci»: the added page shows its colours through the site's variables, the other page changes colours…
    const replaced = await addWith(base, "sostituisci");
    const sostituisci = applied(site.entities, replaced.out.entities);
    expectClose(await computed(siteCss(sostituisci), documentOf(sostituisci, "chi-siamo"), ADDED_PROBES), original);
    const after = await computed(siteCss(sostituisci), home, OTHER_PROBES);
    expectClose({ a: after[".testata"]!, b: after[".titolo"]!, c: after[".bottone"]! }, { a: { "background-color": "rgb(46, 125, 50)", "padding-top": "16px" }, b: { color: "rgb(46, 125, 50)", "font-size": before[".titolo"]!["font-size"]! }, c: { "background-color": "rgb(198, 40, 40)", color: "rgb(255, 255, 255)" } });
    // …and only through the variables listed: with them set back to their values before, it is the page of before.
    const light = replaced.result.addPage!.colors!.changes.filter((change) => change.theme === "chiaro");
    const undo = `:root{${light.map((change) => `${change.variable}:${change.before};`).join("")}}`;
    expect(await computed(`${siteCss(sostituisci)}\n${undo}`, home, OTHER_PROBES)).toEqual(before);
  }, 180_000);
});
