import { createHash } from "node:crypto";
import vm from "node:vm";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { build } from "esbuild";
import { canonicalizeJson, canonicalRevisionPayload, type JsonValue, type TransferEntity } from "@histos-publish/histos-contract";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM build script, without types.
import { browserImportBuild } from "../build-browser-import.mjs";
import { decodeStaticPageArchive } from "../src/page-transfer.js";
import { pageFilter, scopeSelectorList } from "../browser/page-scope.js";
import { AddPageError, convertToXbsite, type AddPageBase, type AddPageAssetEntity, type AddPageStylesEntity, type BrowserImportInput, type BrowserImportResult } from "../browser/html-import.js";
import type { WasmSqlite } from "../src/project-database-wasm.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * V5.4, «pagina aggiunta»: a converted page added to a site that already has a project. The site's base is built here as
 * the plugin's snapshot gives it, from the package of a first import; the package of the added page is read back with
 * Publish's own reader (which checks every revision hash as the plugin does) and compared with that base.
 */
const PROJECT = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const encoder = new TextEncoder();
// Two different 1×1 PNG files.
const PNG_A = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const PNG_B = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

let sqlite: WasmSqlite;
beforeAll(async () => {
  sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
});

function page(input: { title: string; canonical?: string; body: string; css: string; image?: Uint8Array; imageName?: string }): StaticSiteFile[] {
  const head = `<meta charset="utf-8"><title>${input.title}</title>${input.canonical ? `<link rel="canonical" href="${input.canonical}">` : ""}<link rel="stylesheet" href="stile.css">`;
  const files: StaticSiteFile[] = [
    { path: "index.html", bytes: encoder.encode(`<!doctype html><html lang="it"><head>${head}</head><body>${input.body}</body></html>`) },
    { path: "stile.css", bytes: encoder.encode(input.css) },
  ];
  if (input.image) files.push({ path: `img/${input.imageName ?? "foto.png"}`, bytes: input.image });
  return files;
}

/** The site of a first import: a home with a hero image, a style with a background image and a global sheet. */
const SITE = page({
  title: "Bottega",
  body: `<main><section class="apertura"><h1 class="apertura__titolo">Benvenuti</h1><img src="img/foto.png" alt="Il laboratorio"></section></main>`,
  css: `:root{--fondo:#fafafa}.apertura{padding:2rem;background:url(img/foto.png)}.apertura__titolo{color:navy}`,
  image: PNG_A,
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashOf(kind: TransferEntity["kind"], payload: Record<string, JsonValue>): string {
  return sha256(canonicalRevisionPayload(kind, 1, payload));
}

async function read(result: BrowserImportResult) {
  return decodeStaticPageArchive(Buffer.from(result.archive));
}

/** What the plugin's snapshot gives the browser for a site whose live entities are `entities` (with `files`). */
function baseOf(entities: readonly TransferEntity[], files: ReadonlyMap<string, Uint8Array>, extraSlugs: string[] = []): AddPageBase {
  const styles = entities.find((entity) => entity.kind === "styles")! as unknown as AddPageStylesEntity;
  const assets = entities.filter((entity) => entity.kind === "asset") as unknown as AddPageAssetEntity[];
  const usedByStyles = new Set([...styles.payload.styles, ...styles.payload.globals].flatMap((rule) => (rule.assets ?? []).map((mapping) => mapping.assetId)));
  return {
    projectId: PROJECT,
    styles,
    slugs: [...entities.filter((entity) => entity.kind === "document").map((entity) => String(entity.payload.slug)), ...extraSlugs],
    entityIds: entities.map((entity) => entity.id),
    assets,
    files: Object.fromEntries(assets.filter((asset) => usedByStyles.has(asset.id)).map((asset) => [asset.payload.path, new Uint8Array(files.get(asset.payload.path)!)])),
  };
}

/** The site after the plugin applied a package: its entities replace those with the same id. */
function applied(live: readonly TransferEntity[], incoming: readonly TransferEntity[]): TransferEntity[] {
  const byId = new Map(live.map((entity) => [entity.id, entity]));
  for (const entity of incoming) byId.set(entity.id, entity);
  return [...byId.values()];
}

/** The plugin's check of a package against the live site (PageProfileAdapter::import): a changed entity needs the live base. */
function conflicts(live: readonly TransferEntity[], incoming: readonly TransferEntity[]): string[] {
  const byId = new Map(live.map((entity) => [entity.id, entity]));
  return incoming.filter((entity) => {
    const current = byId.get(entity.id);
    return current !== undefined && current.revisionHash !== entity.revisionHash && entity.baseHash !== current.revisionHash;
  }).map((entity) => entity.id);
}

async function firstSite() {
  const result = await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT }, sqlite);
  const decoded = await read(result);
  return { entities: decoded.profile.entities, files: new Map([...decoded.files].map(([name, bytes]) => [name, new Uint8Array(bytes)])) };
}

const SECOND = page({
  title: "Chi siamo – Bottega",
  canonical: "https://esempio.test/chi-siamo/",
  body: `<main><section class="apertura"><h1 class="apertura__titolo">Chi siamo</h1><img src="img/foto.png" alt="Ritratto"></section><div class="storia"><p class="storia__testo">Dal 1990.</p></div></main>`,
  css: `:root{--accento:#0a0}.apertura{padding:4rem;background:url(img/foto.png)}.storia{margin:1rem}.storia__testo{color:green}`,
  image: PNG_B,
});

describe("pagina aggiunta a un sito che esiste (V5.4)", () => {
  it("senza addPage la conversione resta quella di un progetto intero", async () => {
    const plain = await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT }, sqlite);
    const undefinedAdd = await convertToXbsite({ files: SITE, name: "Bottega", projectId: PROJECT, addPage: undefined }, sqlite);
    expect(plain).not.toHaveProperty("addPage");
    const one = await read(plain);
    const two = await read(undefinedAdd);
    expect(canonicalizeJson(one.profile.entities as never)).toBe(canonicalizeJson(two.profile.entities as never));
    expect(one.profile.entities.find((entity) => entity.kind === "document")?.payload.slug).toBe("home");
    expect(one.profile.entities.find((entity) => entity.kind === "styles")?.baseHash).toBeUndefined();
  }, 120_000);

  it("prende lo slug dalla pagina, un id suo, gli stili uniti sulla base viva e i media senza pestare quelli del sito", async () => {
    const site = await firstSite();
    const base = baseOf(site.entities, site.files);
    const result = await convertToXbsite({ files: SECOND, name: "Chi siamo", projectId: PROJECT, structure: { parts: true, components: true, lists: true }, addPage: { base } }, sqlite);
    const out = await read(result);
    const entities = out.profile.entities;
    // Only the page, the merged styles and media: nothing else of the site is sent.
    expect(entities.map((entity) => entity.kind).sort()).toEqual(["asset", "asset", "document", "styles"]);
    const document = entities.find((entity) => entity.kind === "document")!;
    expect(document.payload.slug).toBe("chi-siamo");
    expect(result.addPage?.slugFrom).toBe("canonico");
    expect(base.entityIds).not.toContain(document.id);
    expect(result.addPage?.pageId).toBe(document.id);
    expect(out.profile.references.every((reference) => reference.ownerId === document.id)).toBe(true);
    expect(out.profile.manifest.project.id).toBe(PROJECT);
    expect(out.profile.manifest.profile).toBe("histos-static-page-v1");

    // Styles: the site's id, the live revision as base, the hash of the merged payload; the site's entries as they are.
    const styles = entities.find((entity) => entity.kind === "styles")!;
    expect(styles.id).toBe(base.styles.id);
    expect(styles.baseHash).toBe(base.styles.revisionHash);
    expect(styles.revisionHash).toBe(hashOf("styles", styles.payload));
    expect(styles.revisionHash).not.toBe(base.styles.revisionHash);
    const merged = styles.payload as unknown as AddPageStylesEntity["payload"];
    expect(merged.styles.slice(0, base.styles.payload.styles.length)).toEqual(base.styles.payload.styles);
    expect(merged.globals.slice(0, base.styles.payload.globals.length)).toEqual(base.styles.payload.globals);
    expect(merged.design ?? {}).toEqual(base.styles.payload.design ?? {});
    expect(merged.tokenOverrides ?? {}).toEqual(base.styles.payload.tokenOverrides ?? {});
    // .apertura is the site's, with other declarations: the site's stays as it is for every page, and the page's holds
    // too, on the page only, after the site's (M-P2: padding 4rem on «Chi siamo», 2rem everywhere else).
    const siteApertura = base.styles.payload.styles.find((entry) => entry.selector === ".apertura")!;
    expect(merged.styles.filter((entry) => entry.selector === ".apertura")).toEqual([siteApertura]);
    const scopedApertura = scopeSelectorList(".apertura", pageFilter("chi-siamo"));
    const pageApertura = merged.styles.find((entry) => entry.selector === scopedApertura)!;
    expect(pageApertura.css).toContain("padding:4rem");
    expect(pageApertura.id).not.toBe(siteApertura.id);
    expect(merged.styles.indexOf(pageApertura)).toBeGreaterThan(merged.styles.indexOf(siteApertura));
    expect(result.addPage?.stylesKept).toEqual([".apertura"]);
    expect(result.notes).toContain("Stile .apertura: il sito lo ha già diverso, quello della pagina vale solo su questa pagina");
    expect(result.addPage?.stylesAdded).toEqual([".storia"]);
    // V5.5: added, it holds on the page only (page-scope.ts).
    expect(result.addPage?.mark).toBe("chi-siamo");
    // Its BEM part (&__testo) is a rule of its own, as the plugin prints it, limited too.
    expect(merged.styles.find((entry) => entry.selector === scopeSelectorList(".storia", pageFilter("chi-siamo")))?.css).toContain("margin:1rem");
    expect(merged.styles.find((entry) => entry.selector === scopeSelectorList(".storia__testo", pageFilter("chi-siamo")))?.css).toContain("color:green");
    // The page's sheet, with an id that says which page it came from.
    expect(result.addPage?.sheetsAdded).toEqual(["chi-siamo-foglio-1"]);
    expect(merged.globals.at(-1)?.id).toBe("chi-siamo-foglio-1");

    // Media: foto.png is the site's name with other bytes, so the page's takes a suffix; the site's travels unchanged,
    // because the site's .apertura uses it, and the plugin checks every url() against the package's media.
    expect(result.addPage?.mediaRenamed).toEqual([{ from: "foto.png", to: "foto-2.png" }]);
    const siteFoto = base.assets.find((asset) => asset.payload.title === "foto.png")!;
    const sentSiteFoto = entities.find((entity) => entity.id === siteFoto.id)!;
    expect(sentSiteFoto.revisionHash).toBe(siteFoto.revisionHash);
    const renamed = entities.find((entity) => entity.kind === "asset" && entity.payload.title === "foto-2.png")!;
    expect(base.entityIds).not.toContain(renamed.id);
    expect(renamed.payload.sha256).toBe(sha256(PNG_B));
    expect(String(document.payload.content)).toContain(`histos-media://${renamed.id}`);
    expect(conflicts(site.entities, entities)).toEqual([]);
    // The parts, components and lists asked for are left out, and said.
    expect(result.addPage?.leftOut.map((item) => item.kind)).toEqual(["parti", "componenti", "elenchi"]);
  }, 120_000);

  it("lo stesso nome con gli stessi byte riusa il media del sito; lo slug viene dal percorso o dal titolo", async () => {
    const site = await firstSite();
    const base = baseOf(site.entities, site.files);
    const files = page({ title: "Contatti", body: `<main><img class="mappa" src="img/foto.png" alt="Mappa"></main>`, css: `.mappa{width:100%}`, image: PNG_A });
    const fromPath = await convertToXbsite({ files, name: "Contatti", addPage: { base, sourcePath: "/dove-siamo/" } }, sqlite);
    expect(fromPath.addPage?.slug).toBe("dove-siamo");
    expect(fromPath.addPage?.slugFrom).toBe("percorso");
    expect(fromPath.addPage?.mediaReused).toEqual(["foto.png"]);
    const siteFoto = base.assets.find((asset) => asset.payload.title === "foto.png")!;
    const out = await read(fromPath);
    expect(out.profile.entities.filter((entity) => entity.kind === "asset").map((entity) => entity.id)).toEqual([siteFoto.id]);
    expect(String(out.profile.entities.find((entity) => entity.kind === "document")!.payload.content)).toContain(`histos-media://${siteFoto.id}`);
    const fromTitle = await convertToXbsite({ files, name: "Contatti", addPage: { base } }, sqlite);
    expect(fromTitle.addPage).toMatchObject({ slug: "contatti", slugFrom: "titolo" });
  }, 120_000);

  it("uno slug già usato dal sito è un errore che dice quale", async () => {
    const site = await firstSite();
    const base = baseOf(site.entities, site.files, ["chi-siamo"]);
    const error = await convertToXbsite({ files: SECOND, name: "Chi siamo", addPage: { base } }, sqlite).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AddPageError);
    expect(error).toMatchObject({ code: "slug-usato", detail: "chi-siamo" });
    expect((error as Error).message).toContain("«chi-siamo»");
  }, 120_000);

  it("una base non valida è un errore, mai un'importazione normale", async () => {
    const site = await firstSite();
    const base = baseOf(site.entities, site.files);
    const attempt = (addPage: unknown, extra: Partial<BrowserImportInput> = {}) => convertToXbsite({ files: SECOND, name: "Chi siamo", addPage: addPage as never, ...extra }, sqlite).then(() => null, (caught: unknown) => caught as AddPageError);
    expect(await attempt(null)).toMatchObject({ code: "base-non-valida", detail: "addPage" });
    expect(await attempt({ base: "sito" })).toMatchObject({ code: "base-non-valida", detail: "base" });
    expect(await attempt({ base: { ...base, altro: 1 } })).toMatchObject({ code: "base-non-valida", detail: "base.altro" });
    expect(await attempt({ base: { ...base, slugs: [1] } })).toMatchObject({ code: "base-non-valida", detail: "slugs[0]" });
    expect(await attempt({ base: { ...base, entityIds: ["non-un-id"] } })).toMatchObject({ code: "base-non-valida", detail: "entityIds[0]" });
    expect(await attempt({ base: { ...base, styles: { ...base.styles, payload: { ...base.styles.payload, compiledCss: "x" } } } })).toMatchObject({ code: "base-hash", detail: "styles.revisionHash" });
    expect(await attempt({ base: { ...base, files: {} } })).toMatchObject({ code: "base-file-mancante" });
    expect(await attempt({ base: { ...base, files: { [Object.keys(base.files)[0]!]: PNG_B } } })).toMatchObject({ code: "base-non-valida" });
    expect(await attempt({ base: { ...base, slugs: Array.from({ length: 100_001 }, () => "a") } })).toMatchObject({ code: "base-non-valida", detail: "slugs" });
    expect(await attempt({ base }, { projectId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ code: "base-progetto" });
    expect(await attempt({ base }, { files: [...SECOND, { path: "altra.html", bytes: encoder.encode("<p>x</p>") }] })).toMatchObject({ code: "piu-pagine" });
    // An empty design written by PHP as [] is the same revision as {}.
    const empty = (["design", "tokenOverrides", "queries"] as const).find((key) => canonicalizeJson(base.styles.payload[key] ?? null) === "{}");
    expect(empty).toBeDefined();
    const phpLike = { ...base, styles: { ...base.styles, payload: { ...base.styles.payload, [empty!]: [] } } };
    expect(await attempt({ base: phpLike })).toBeNull();
  }, 120_000);

  it("due pagine aggiunte una dopo l'altra non si pestano", async () => {
    const site = await firstSite();
    const base1 = baseOf(site.entities, site.files);
    const first = await convertToXbsite({ files: SECOND, name: "Chi siamo", addPage: { base: base1 } }, sqlite);
    const firstOut = await read(first);
    expect(conflicts(site.entities, firstOut.profile.entities)).toEqual([]);
    // The site after the first page, as the plugin's snapshot would then give it.
    const live = applied(site.entities, firstOut.profile.entities);
    const liveFiles = new Map([...site.files, ...[...firstOut.files].map(([name, bytes]) => [name, new Uint8Array(bytes)] as const)]);
    const base2 = baseOf(live, liveFiles);
    const third = page({
      title: "Corsi",
      canonical: "https://esempio.test/corsi/",
      body: `<main><div class="storia"><p class="storia__testo">Ogni sabato.</p></div><section class="corsi"><h2 class="corsi__titolo">Corsi</h2><img src="img/foto.png" alt="Banco"></section></main>`,
      css: `.storia{margin:1rem}.storia__testo{color:green}.corsi{display:grid}.corsi__titolo{font-weight:700}`,
      image: encoder.encode("non usata"),
      imageName: "vuota.txt",
    });
    third.push({ path: "img/foto.png", bytes: PNG_B });
    const second = await convertToXbsite({ files: third, name: "Corsi", addPage: { base: base2 } }, sqlite);
    const secondOut = await read(second);
    expect(conflicts(live, secondOut.profile.entities)).toEqual([]);
    const firstDoc = firstOut.profile.entities.find((entity) => entity.kind === "document")!;
    const secondDoc = secondOut.profile.entities.find((entity) => entity.kind === "document")!;
    expect(secondDoc.id).not.toBe(firstDoc.id);
    expect(secondDoc.payload.slug).toBe("corsi");
    // V5.5: the first page's styles hold on the first page only: the second page adds its own, limited to it.
    expect(second.addPage?.stylesSame).toEqual([]);
    expect(second.addPage?.stylesAdded).toEqual([".storia", ".corsi"]);
    const styles2 = secondOut.profile.entities.find((entity) => entity.kind === "styles")!;
    const styles1 = firstOut.profile.entities.find((entity) => entity.kind === "styles")!;
    expect(styles2.baseHash).toBe(styles1.revisionHash);
    const merged2 = styles2.payload as unknown as AddPageStylesEntity["payload"];
    expect(merged2.styles.slice(0, (styles1.payload.styles as unknown[]).length)).toEqual(styles1.payload.styles);
    expect(new Set(merged2.styles.map((entry) => entry.id)).size).toBe(merged2.styles.length);
    expect(new Set(merged2.globals.map((entry) => entry.id)).size).toBe(merged2.globals.length);
    // foto.png (bytes B) is now the first added page's foto-2.png: the same bytes reuse it.
    expect(second.addPage?.mediaReused).toEqual(["foto.png"]);
    expect(second.addPage?.mediaRenamed).toEqual([]);
    // The second page built on the old base instead is stopped by the plugin's check: its styles base is not the live one.
    const stale = await read(await convertToXbsite({ files: third, name: "Corsi", addPage: { base: base1 } }, sqlite));
    expect(conflicts(live, stale.profile.entities)).toEqual([base1.styles.id]);
    // And the first page cannot come again: its slug is taken now.
    await expect(convertToXbsite({ files: SECOND, name: "Chi siamo", addPage: { base: base2 } }, sqlite)).rejects.toMatchObject({ code: "slug-usato" });
  }, 120_000);

  it("impacchettato per il browser fa la stessa pagina aggiunta di Node", async () => {
    const site = await firstSite();
    const base = baseOf(site.entities, site.files);
    const bundled = await build({ ...browserImportBuild, format: "iife", globalName: "HistosHtmlImport", write: false, logLevel: "silent" });
    const context = vm.createContext({ TextEncoder, TextDecoder, URL, console, crypto: globalThis.crypto, atob, btoa, queueMicrotask, setTimeout, clearTimeout });
    vm.runInContext(`${bundled.outputFiles[0]!.text}\nglobalThis.HistosHtmlImport = HistosHtmlImport;`, context);
    const inBrowser = await (context as { HistosHtmlImport: { convertToXbsite: typeof convertToXbsite } }).HistosHtmlImport.convertToXbsite({ files: SECOND, name: "Chi siamo", addPage: { base } }, sqlite);
    const inNode = await convertToXbsite({ files: SECOND, name: "Chi siamo", addPage: { base } }, sqlite);
    expect(canonicalizeJson((await read(inBrowser)).profile.entities as never)).toBe(canonicalizeJson((await read(inNode)).profile.entities as never));
    expect(inBrowser.addPage).toEqual(inNode.addPage);
  }, 120_000);
});
