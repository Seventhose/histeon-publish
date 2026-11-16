import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import type { BuildOptions, BuildResult } from "@histos-publish/core";
import type { TemplateRole } from "@histos-publish/histos-contract";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { buildCmsProject, cmsRoutePlanProblems, planCmsRoutes, type CmsOperationsContext } from "../src/cms-api.js";
import { checkPrototype, PrototypeInvalidError } from "../src/prototype-check.js";

/**
 * Review 7, group B1: the limits of a static build say what they protect. A term's archive pages its descendants'
 * contents as WordPress does, with no limit of its own; a site whose bundle would certainly be over 250 MiB (every page
 * inlines the Histeon CSS and the global sheets) is refused by the check and by the build before a page is written, and
 * never one that would build; the build's own record page speaks the page's language and reads each taxonomy's terms
 * once.
 */

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-build-limits-"));
  roots.push(root);
  return root;
}

interface Project { root: string; catalog: CmsProjectCatalog; opened: { project: { id: string }; store: CmsProjectStore } }

async function project(locale = "it-IT"): Promise<Project> {
  const root = await scratch();
  const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
  const opened = await catalog.createProject("Limiti");
  opened.store.setRenderSettings({ ...opened.store.getRenderSettings(), locale });
  const home = opened.store.listPages()[0]!;
  opened.store.updatePageMetadata(home.id, { title: home.title, slug: home.slug, status: "published" });
  return { root, catalog, opened };
}

function context(target: Project, buildBundle?: CmsOperationsContext["buildBundle"]): CmsOperationsContext {
  return { catalog: target.catalog, dataDirectory: target.root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined, ...(buildBundle ? { buildBundle } : {}) };
}

function plan(store: CmsProjectStore) {
  return planCmsRoutes(store, { pages: store.listPages().filter((page) => page.status === "published"), posts: store.listPosts().filter((post) => post.status === "published"), maxRoutes: 50_000 });
}

function saved<T extends { status: string }>(result: T): Extract<T, { status: "saved" }> {
  if (result.status !== "saved") throw new Error(`Salvataggio non riuscito: ${JSON.stringify(result)}`);
  return result as Extract<T, { status: "saved" }>;
}

function template(store: CmsProjectStore, ref: string, source: string, role?: TemplateRole): string {
  const created = store.createTemplate({ ref, title: ref, content: serializeXb(parse(source).blocks) });
  if (role) store.setTemplateRole(created.id, role);
  return created.ref;
}

/** Global sheets of about `kib` KiB of CSS in all, under the importer's 1 MB a sheet. */
function heavySheets(kib: number): string {
  const sheets: string[] = [];
  let sheet = "";
  let size = 0;
  for (let index = 0; size < kib * 1024; index++) {
    const rule = `.r${index}{color:#${(index % 4096).toString(16).padStart(3, "0")}}\n`;
    if (sheet.length + rule.length > 900 * 1024) {
      sheets.push(sheet);
      sheet = "";
    }
    sheet += rule;
    size += rule.length;
  }
  if (sheet) sheets.push(sheet);
  return sheets.map((css, index) => `<style data-histos="global" data-name="Base ${index + 1}">${css}</style>`).join("\n");
}

function heavyPrototype(records: number): string {
  const content = { types: [{ key: "opera", label: "Opere", fields: [] }], records: Array.from({ length: records }, (_, index) => ({ type: "opera", slug: `o${index}`, title: `O${index}`, status: "published", publishedAt: "2026-01-01T00:00:00Z" })) };
  return `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f","name":"Pesante","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${JSON.stringify(content)}</script>
${heavySheets(600)}
</head><body>
<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>
</body></html>`;
}

describe("il pacchetto della build: ciò che è certo si dice prima (B1)", () => {
  it("un sito che supera di certo i 250 MiB si rifiuta al controllo senza anteprima, con il perché e cosa fare; uno sotto resta valido", { timeout: 30_000 }, async () => {
    const refused = await checkPrototype(heavyPrototype(450), { scratchRoot: await scratch() }).catch((error: unknown) => error);
    // Before: valid, and the build stopped on «La sorgente supera il limite di 250 MiB.» after writing every page.
    expect(refused).toBeInstanceOf(PrototypeInvalidError);
    expect((refused as PrototypeInvalidError).issues).toEqual([{ message: "Il sito non entra nel pacchetto della build: 496 pagine (450 di record e articoli, 45 di un archivio, un'altra), e ognuna contiene almeno 680 KiB di CSS (quello di Histeon e dei fogli globali), cioè almeno 329 MiB, oltre i 250 MiB del pacchetto: la build si fermerebbe dopo aver scritto tutte le pagine. Fra gli archivi, il più lungo è l'archivio del tipo opera: 450 contenuti, 45 pagine. Riduci le pagine (meno record, termini o lingue: ogni archivio ha una pagina ogni 10 contenuti, in ogni lingua, e quello di un termine conta anche i contenuti dei suoi sottotermini) o alleggerisci i fogli CSS globali." }]);
    // 375 pages carry at least 245 MiB: under the limit, nothing is said (only the build can tell).
    await expect(checkPrototype(heavyPrototype(340), { scratchRoot: await scratch() })).resolves.toMatchObject({ valid: true });
  });

  it("la build lo rifiuta prima di scrivere una pagina, con lo stesso messaggio", { timeout: 60_000 }, async () => {
    const target = await project();
    const styles = target.opened.store.getStyles()!;
    const heavy = [...heavySheets(2700).matchAll(/<style[^>]*>([^<]*)<\/style>/gu)].map((match, index) => ({ id: `g${index}`, css: match[1]! }));
    saved(target.opened.store.saveDocument({ entityId: styles.id, expectedHead: target.opened.store.getHead(styles.id)!.id, content: JSON.stringify({ styles: [], globals: heavy }) }));
    saved(target.opened.store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    for (let index = 0; index < 100; index++) saved(target.opened.store.content.saveRecord({ typeKey: "opera", title: `O${index}`, slug: `o${index}`, status: "published", publishedAt: "2026-01-01T00:00:00Z" }));
    const bundle = vi.fn<NonNullable<CmsOperationsContext["buildBundle"]>>();
    const refused = await buildCmsProject(context(target, bundle), target.opened, { throwaway: { directory: path.join(target.root, "out") } }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "cms-build-size-limit", message: expect.stringMatching(/^Il sito non entra nel pacchetto della build: 111 pagine .*cioè almeno \d+ MiB, oltre i 250 MiB del pacchetto/u) });
    expect(bundle).not.toHaveBeenCalled();
    expect(cmsRoutePlanProblems(plan(target.opened.store), 50_000).messages).toEqual([(refused as Error).message]);
  });

  it("ogni pagina scritta porta almeno il CSS che il piano conta, con o senza template, anche quando un url() riscritto si accorcia", async () => {
    const target = await project();
    const { store } = target.opened;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const asset = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "punto.png" });
    // A reference much longer than the /media/<sha256>.png the renderer writes in its place.
    const reference = `immagini/${"lungo-".repeat(40)}punto.png`;
    const styles = store.getStyles()!;
    saved(store.saveDocument({ entityId: styles.id, expectedHead: store.getHead(styles.id)!.id, content: JSON.stringify({ styles: [], globals: [{ id: "base", css: `body{background:url("${reference}")}\n.a{color:red}`, assets: [{ reference, assetId: asset.id }] }] }) }));
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [], singleTemplateRef: template(store, "site/opera", "<main><h1>{page.title}</h1>{@slot}</main>") }));
    saved(store.content.saveType({ key: "libro", label: "Libri", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["opera", "libro"] }));
    const term = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "notte", label: "Notte" })).term;
    template(store, "site/archivio", "<main><h1>{page.title}</h1>{#loop main() as item}<p>{item.title}</p>{/loop}{@slot}</main>", "archive");
    for (let index = 0; index < 12; index++) {
      saved(store.content.saveRecord({ typeKey: index % 2 ? "opera" : "libro", title: `R${index}`, slug: `r${index}`, status: "published", publishedAt: "2026-01-01T00:00:00Z", terms: { tema: [term.alias] } }));
    }
    const planned = plan(store);
    expect(planned.pageCssBytes).toBeGreaterThan(46_000);
    const sizes: number[] = [];
    const measure = async (options: BuildOptions): Promise<BuildResult> => {
      const root = (options.source as { path: string }).path;
      for (const name of await readdir(root, { recursive: true })) if (name.endsWith(".html")) sizes.push((await stat(path.join(root, name))).size);
      throw new Error("misurato");
    };
    await expect(buildCmsProject(context(target, measure), target.opened, { throwaway: { directory: path.join(target.root, "out") } })).rejects.toThrow("misurato");
    expect(sizes).toHaveLength(planned.count);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(planned.pageCssBytes);
  });
});

describe("l'archivio di un termine con i suoi sottotermini non ha un limite suo (B1)", () => {
  it("10.002 contenuti di due tipi nei figli di un termine: il piano li conta, e un sito troppo grande dice il termine e i suoi contenuti", { timeout: 30_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    saved(store.content.saveType({ key: "libro", label: "Libri", fields: [] }));
    saved(store.content.saveType({ key: "disco", label: "Dischi", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "genere", label: "Generi", types: ["libro", "disco"] }));
    const arte = saved(store.content.saveTerm({ taxonomyKey: "genere", slug: "arte", label: "Arte" })).term;
    const pittura = saved(store.content.saveTerm({ taxonomyKey: "genere", slug: "pittura", label: "Pittura", parentId: arte.id })).term;
    const musica = saved(store.content.saveTerm({ taxonomyKey: "genere", slug: "musica", label: "Musica", parentId: arte.id })).term;
    const libro = saved(store.content.saveRecord({ typeKey: "libro", title: "L0", slug: "l0", status: "published", publishedAt: "2026-01-01T00:00:00Z", terms: { genere: [pittura.alias] } })).record;
    const disco = saved(store.content.saveRecord({ typeKey: "disco", title: "D0", slug: "d0", status: "published", publishedAt: "2026-01-01T00:00:00Z", terms: { genere: [musica.alias] } })).record;
    // 5,000 more of each, copies of these two written in one transaction: saving them one by one takes half a minute.
    const database = new DatabaseSync(path.join(store.directory, "content.sqlite"));
    try {
      const identity = database.prepare("INSERT INTO cms_identity_registry(id, kind, created_at, deleted_at) SELECT ?, kind, created_at, NULL FROM cms_identity_registry WHERE id=?");
      const record = database.prepare("INSERT INTO cms_records(id, type_id, slug, locale, title, status, published_at, excerpt, order_no, parent_id, head_revision, created_at, updated_at) SELECT ?, type_id, ?, locale, ?, status, published_at, excerpt, order_no, parent_id, head_revision, created_at, updated_at FROM cms_records WHERE id=?");
      const terms = database.prepare("INSERT INTO cms_record_terms(record_id, taxonomy_id, term_id, ordinal) SELECT ?, taxonomy_id, term_id, ordinal FROM cms_record_terms WHERE record_id=?");
      database.exec("BEGIN");
      for (let index = 1; index <= 5000; index++) {
        for (const [source, prefix] of [[libro, "l"], [disco, "d"]] as const) {
          const id = randomUUID();
          identity.run(id, source.id);
          record.run(id, `${prefix}${index}`, `${prefix.toUpperCase()}${index}`, source.id);
          terms.run(id, source.id);
        }
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    // Before: «La tassonomia supera il limite di 10.000 record per build statico.», naming no term.
    const planned = plan(store);
    // The home, 10,002 records, the two types' archives (501 pages each), arte's (1,001) and its children's (501 each).
    expect(planned).toMatchObject({ count: 13_008, contentPages: 10_002, archivePages: 3005, archives: 5, largestArchive: { name: "l'archivio del termine «arte» (genere), con i contenuti dei suoi sottotermini", total: 10_002, pages: 1001 } });
    expect(planned.routes.has("genere/arte/page/1001")).toBe(true);
    // 13,008 pages of at least 45 KiB each: the bundle says so, naming arte and what its archive holds.
    expect(cmsRoutePlanProblems(planned, 50_000).messages).toEqual([expect.stringContaining("13.008 pagine (10.002 di record e articoli, 3005 di 5 archivi, un'altra), e ognuna contiene almeno 80 KiB di CSS (quello di Histeon e dei fogli globali), cioè almeno 1021 MiB, oltre i 250 MiB del pacchetto: la build si fermerebbe dopo aver scritto tutte le pagine. Fra gli archivi, il più lungo è l'archivio del termine «arte» (genere), con i contenuti dei suoi sottotermini: 10.002 contenuti, 1001 pagine.")]);
  }, 120_000);

  it("oltre il limite di pagine il messaggio dice anche il termine e quanti contenuti tiene con i sottotermini", async () => {
    const target = await project();
    const { store } = target.opened;
    saved(store.content.saveType({ key: "libro", label: "Libri", fields: [] }));
    saved(store.content.saveType({ key: "disco", label: "Dischi", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "genere", label: "Generi", types: ["libro", "disco"] }));
    const arte = saved(store.content.saveTerm({ taxonomyKey: "genere", slug: "arte", label: "Arte" })).term;
    const pittura = saved(store.content.saveTerm({ taxonomyKey: "genere", slug: "pittura", label: "Pittura", parentId: arte.id })).term;
    const musica = saved(store.content.saveTerm({ taxonomyKey: "genere", slug: "musica", label: "Musica", parentId: arte.id })).term;
    for (let index = 0; index < 24; index++) saved(store.content.saveRecord({ typeKey: "libro", title: `L${index}`, slug: `l${index}`, status: "published", publishedAt: "2026-01-01T00:00:00Z", terms: { genere: [(index % 2 ? pittura : musica).alias] } }));
    const planned = planCmsRoutes(store, { pages: store.listPages().filter((page) => page.status === "published"), posts: [], maxRoutes: 30 });
    // The home, 24 records, libro's archive (3 pages) and disco's empty one, arte's with its children's contents (3) and each child's (2).
    expect(planned).toMatchObject({ count: 36, contentPages: 24, archivePages: 11, archives: 5, largestArchive: { total: 24, pages: 3 } });
    const message = "La build supera il limite di 30 pagine generate: il sito ne avrebbe 36, contando pagine, articoli, record e ogni pagina di ogni archivio (10 contenuti l'una, in ogni lingua che ne ha; vuoti solo nella lingua del sito): 24 di record e articoli, 11 di 5 archivi, un'altra. Fra gli archivi, il più lungo è l'archivio del tipo libro: 24 contenuti, 3 pagine. Riduci le pagine (meno record, termini o lingue: ogni archivio ha una pagina ogni 10 contenuti, in ogni lingua, e quello di un termine conta anche i contenuti dei suoi sottotermini).";
    // Before: «… vuoti solo nella lingua del sito). Riduci record, termini o lingue.», naming no archive.
    expect(cmsRoutePlanProblems(planned, 30).messages).toEqual([message]);
    // With records of a second type under musica, arte's archive is the longest, and named with its descendants.
    for (let index = 0; index < 8; index++) saved(store.content.saveRecord({ typeKey: "disco", title: `D${index}`, slug: `d${index}`, status: "published", publishedAt: "2026-01-01T00:00:00Z", terms: { genere: [musica.alias] } }));
    const wider = planCmsRoutes(store, { pages: store.listPages().filter((page) => page.status === "published"), posts: [], maxRoutes: 30 });
    expect(cmsRoutePlanProblems(wider, 30).messages).toEqual([expect.stringContaining(": 32 di record e articoli, 12 di 5 archivi, un'altra. Fra gli archivi, il più lungo è l'archivio del termine «arte» (genere), con i contenuti dei suoi sottotermini: 32 contenuti, 4 pagine. Riduci le pagine (")]);
    const refused = await buildCmsProject({ ...context(target), buildLimits: { maxRoutes: 30 } }, target.opened, { throwaway: { directory: path.join(target.root, "out") } }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "cms-build-route-limit", message: cmsRoutePlanProblems(wider, 30).messages[0] });
  });

  it("oltre i file che il pacchetto prende, il messaggio lo dice anche con CSS leggero", () => {
    const planned = { routes: new Map(), count: 20_001, collisions: [], collisionCount: 0, contentPages: 20_000, archivePages: 0, archives: 0, largestArchive: null, pageCssBytes: 0 };
    expect(cmsRoutePlanProblems(planned, 50_000).messages).toEqual(["Il sito non entra nel pacchetto della build: 20.001 pagine (20.000 di record e articoli, un'altra), un file l'una, e il pacchetto ne prende al massimo 20.000: la build si fermerebbe dopo aver scritto tutte le pagine. Riduci le pagine (meno record, termini o lingue: ogni archivio ha una pagina ogni 10 contenuti, in ogni lingua, e quello di un termine conta anche i contenuti dei suoi sottotermini)."]);
    expect(cmsRoutePlanProblems({ ...planned, count: 20_000, contentPages: 19_999 }, 50_000).messages).toEqual([]);
  });
});

describe("la pagina di un record senza template (B1)", () => {
  async function recordSite(locale: string) {
    const target = await project(locale);
    const { store } = target.opened;
    saved(store.content.saveType({ key: "work", label: "Works", fields: [{ key: "framed", label: "Framed", type: "boolean", required: false, public: true, multiple: false }] }));
    saved(store.content.saveTaxonomy({ key: "theme", label: "Themes", types: ["work"] }));
    const night = saved(store.content.saveTerm({ taxonomyKey: "theme", slug: "night", label: "Night" })).term;
    const moon = saved(store.content.saveTerm({ taxonomyKey: "theme", slug: "moon", label: "Moon", parentId: night.id })).term;
    for (let index = 0; index < 20; index++) {
      saved(store.content.saveRecord({ typeKey: "work", title: `Work ${index}`, slug: `work-${index}`, locale, status: "published", publishedAt: "2026-01-01T00:00:00Z", values: { framed: index % 2 === 0 }, terms: { theme: [night.alias, moon.alias] } }));
    }
    return target;
  }

  async function built(target: Project, address: string): Promise<string> {
    const out = path.join(target.root, "out");
    const result = await buildCmsProject(context(target), target.opened, { throwaway: { directory: out } });
    expect(result.status).toBe("ready");
    return readFile(path.join(out, String(result.id), ...address.split("/").filter(Boolean), "index.html"), "utf8");
  }

  it("parla la lingua della pagina: inglese fuori dall'italiano, come l'archivio", async () => {
    const english = await built(await recordSite("en-US"), "/work/work-0/");
    // Before: «<dd>Sì</dd>» and «aria-label="Categorie"» on an en-US page.
    expect(english).toContain('<html lang="en-US">');
    expect(english).toContain("<dt>Framed</dt><dd>Yes</dd>");
    expect(english).toContain('<nav aria-label="Categories"><a href="/theme/night/">Night</a> <a href="/theme/night/moon/">Moon</a></nav>');
    expect(english.replace(/<head>[\s\S]*<\/head>/u, "")).not.toMatch(/Sì|"Categorie"/u);
    const italian = await built(await recordSite("it-IT"), "/work/work-0/");
    expect(italian).toContain("<dt>Framed</dt><dd>Sì</dd>");
    expect(italian).toContain('<nav aria-label="Categorie"><a href="/theme/night/">Night</a> <a href="/theme/night/moon/">Moon</a></nav>');
  });

  it("legge i termini di una tassonomia una volta per build, non per ogni termine di ogni record", async () => {
    const target = await recordSite("it-IT");
    const listTerms = vi.spyOn(target.opened.store.content, "listTerms");
    await built(target, "/work/work-1/");
    // Before: 40 more reads, two terms on each of the 20 record pages. Now the plan's, the archives' and the records' one.
    expect(listTerms.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("le pagine senza template portano il CSS con gli indirizzi della build (B1)", () => {
  it("un url() di un foglio globale o di uno stile punta alla copia in /media/ anche nei record e negli archivi senza template", async () => {
    const target = await project();
    const { store } = target.opened;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const asset = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "punto.png" });
    const styles = store.getStyles()!;
    saved(store.saveDocument({ entityId: styles.id, expectedHead: store.getHead(styles.id)!.id, content: JSON.stringify({
      styles: [{ id: "s1", selector: ".card", css: "background:url(img/punto.png)", assets: [{ reference: "img/punto.png", assetId: asset.id }] }],
      globals: [{ id: "base", css: 'body{background:url("img/punto.png")}', assets: [{ reference: "img/punto.png", assetId: asset.id }] }],
    }) }));
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["opera", "post"] }));
    const notte = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "notte", label: "Notte" })).term;
    saved(store.content.saveRecord({ typeKey: "opera", title: "Uno", slug: "uno", status: "published", publishedAt: "2026-01-01T00:00:00Z", terms: { tema: [notte.alias] } }));
    store.createPost({ title: "Ciao", slug: "ciao", status: "published", publishedAt: "2026-01-01T00:00:00Z" });
    const out = path.join(target.root, "out");
    const result = await buildCmsProject(context(target), target.opened, { throwaway: { directory: out } });
    expect(result.status).toBe("ready");
    const sha = (await store.readAsset(asset.id))!.metadata.sha256;
    const read = (address: string) => readFile(path.join(out, String(result.id), ...address.split("/").filter(Boolean), "index.html"), "utf8");
    const home = await read("/");
    expect(home).toContain(`url("/media/${sha}.png")`);
    // Before: the record, the type's and the term's archives and the blog kept url("img/punto.png"), relative to their own address.
    for (const address of ["/opera/uno/", "/opera/", "/tema/notte/", "/blog/"]) {
      const html = await read(address);
      expect(html, address).toContain(`body{background:url("/media/${sha}.png")}`);
      expect(html, address).toContain(`/media/${sha}.png`);
      expect(html, address).not.toContain("img/punto.png");
    }
    expect((await stat(path.join(out, String(result.id), "media", `${sha}.png`))).size).toBe(png.length);
  });
});
