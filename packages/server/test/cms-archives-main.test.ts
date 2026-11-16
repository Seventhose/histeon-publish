import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrototypeProfile, CmsProjectCatalog, parsePrototype, type CmsProjectStore } from "@histos-publish/cms";
import type { TemplateRole } from "@histos-publish/histos-contract";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { buildCmsProject, buildPrototypePreview, planCmsRoutes, type CmsOperationsContext } from "../src/cms-api.js";
import { checkPrototype, PrototypeInvalidError } from "../src/prototype-check.js";

/**
 * Review 6, group B1: main() and the archives of the static build as WordPress with the builder serves them. main()
 * works in prototypes; every archive pages 10 contents at a time (WordPress's posts_per_page), with a template or
 * without; a term's archive lists its descendants' contents; an empty archive exists in the site's language only; the
 * build's own archive page speaks the page's language; /blog/ is the posts index when there are posts; and the plan the
 * check and the build share counts exactly the pages the build writes.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-archives-main-"));
  roots.push(root);
  return root;
}

interface Project { root: string; catalog: CmsProjectCatalog; opened: { project: { id: string }; store: CmsProjectStore } }

async function project(locale = "it-IT"): Promise<Project> {
  const root = await scratch();
  const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
  const opened = await catalog.createProject("Archivi");
  opened.store.setRenderSettings({ ...opened.store.getRenderSettings(), locale });
  const home = opened.store.listPages()[0]!;
  opened.store.updatePageMetadata(home.id, { title: home.title, slug: home.slug, status: "published" });
  return { root, catalog, opened };
}

function template(store: CmsProjectStore, ref: string, source: string, role?: TemplateRole): string {
  const created = store.createTemplate({ ref, title: ref, content: serializeXb(parse(source).blocks) });
  if (role) store.setTemplateRole(created.id, role);
  return created.ref;
}

function context(target: { root: string; catalog: CmsProjectCatalog }): CmsOperationsContext {
  return {
    catalog: target.catalog, dataDirectory: target.root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined,
    prototypePreviews: { root: path.join(target.root, "previews"), track: () => undefined, folder: async () => null } as unknown as CmsOperationsContext["prototypePreviews"],
  };
}

interface Built {
  page: (address: string) => Promise<string | null>;
  /** Every page written, as addresses ("/", "/opera/page/2/", "/404.html"), sorted. */
  addresses: string[];
}

async function build(target: Project): Promise<Built> {
  const out = path.join(target.root, "out");
  const result = await buildCmsProject(context(target), target.opened, { throwaway: { directory: out } });
  expect(result.status).toBe("ready");
  const folder = path.join(out, String(result.id));
  const files = (await readdir(folder, { recursive: true })).filter((name) => name.endsWith(".html"));
  const addresses = files.map((name) => (name === "404.html" ? "/404.html" : `/${name.replace(/\\/gu, "/").replace(/index\.html$/u, "")}`)).sort();
  return {
    addresses,
    page: async (address) => readFile(path.join(folder, address === "/404.html" ? "404.html" : path.join(...address.split("/").filter(Boolean), "index.html")), "utf8").catch(() => null),
  };
}

/** The plan as the build and the check make it, for the project's published pages and posts. */
function plan(store: CmsProjectStore) {
  return planCmsRoutes(store, { pages: store.listPages().filter((page) => page.status === "published"), posts: store.listPosts().filter((post) => post.status === "published"), maxRoutes: 50_000 });
}

function texts(html: string | null, className: string): string[] {
  return [...(html ?? "").matchAll(new RegExp(`class="${className}"[^>]*>([^<]*)<`, "gu"))].map((match) => match[1]!);
}

function saved<T extends { status: string }>(result: T): Extract<T, { status: "saved" }> {
  if (result.status !== "saved") throw new Error(`Salvataggio non riuscito: ${JSON.stringify(result)}`);
  return result as Extract<T, { status: "saved" }>;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
const two = (n: number) => String(n).padStart(2, "0");
const MAIN = '<main><h1 class="titolo">{page.title}</h1><p class="totale">{page.totalRecords}</p><p class="pagine">{page.page}/{page.totalPages}</p>{#loop main() as item}<a class="voce" href="{item.url}">{item.title}</a>{/loop}{@slot}</main>';

describe("main() e gli archivi come WordPress (B1)", () => {
  it("un prototipo con main() nel template d'archivio si controlla, si importa e si costruisce: i termini con i loro figli, 10 per pagina", async () => {
    const records = Array.from({ length: 12 }, (_, index) => ({ type: "opera", slug: `cane-${two(index + 1)}`, title: `Cane ${two(index + 1)}`, status: "published", publishedAt: day(index + 1), terms: { tema: ["cani"] } }));
    const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","name":"Main","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${JSON.stringify({
      types: [{ key: "opera", label: "Opere", fields: [] }],
      taxonomies: [{ key: "tema", label: "Temi", types: ["opera"] }, { key: "category", label: "Categorie", types: ["post"] }],
      terms: [{ taxonomy: "tema", slug: "notte", label: "Notte" }, { taxonomy: "tema", slug: "cani", label: "Cani", parent: "notte" }, { taxonomy: "tema", slug: "gatti", label: "Gatti" }, { taxonomy: "category", slug: "racconti", label: "Racconti" }],
      records: [...records, { type: "opera", slug: "luna", title: "Luna", status: "published", publishedAt: day(20), terms: { tema: ["notte"] } }],
    })}</script>
</head><body>
<template data-histos="template" data-ref="site/archivio" data-role="archive" data-title="Archivio">${MAIN}</template>
<template data-histos="template" data-ref="site/categoria" data-role="category" data-title="Categoria">${MAIN}</template>
<template data-histos="template" data-ref="site/blog" data-role="home" data-title="Blog">${MAIN}</template>
<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>
${Array.from({ length: 11 }, (_, index) => `<template data-histos="post" data-slug="articolo-${two(index + 1)}" data-title="Articolo ${two(index + 1)}" data-status="published" data-published-at="${day(index + 1)}" data-excerpt="Breve." data-terms='{"category":["racconti"]}'><p>Testo</p></template>`).join("\n")}
</body></html>`;
    const root = await scratch();
    const target = { root, catalog: new CmsProjectCatalog(path.join(root, "catalog")) };
    // Before: «La query main non è inclusa nel trasferimento CMS.», with no place, from the check and the import.
    const checked = await checkPrototype(html, { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(context(target), opened, signal) });
    expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "ready" } });
    // The import: the prototype's profile, through the transfer's checks, into the catalog.
    const profile = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(path.join(root, "scratch")));
    const opened = await target.catalog.importStaticPageProfile(profile.profile, profile.files);
    const built = await build({ root, catalog: target.catalog, opened });
    // The parent term lists its child's records too (WordPress's include_children), newest first, 10 a page.
    const notte = await built.page("/tema/notte/");
    expect(texts(notte, "totale")).toEqual(["13"]);
    expect(texts(notte, "pagine")).toEqual(["1/2"]);
    expect(texts(notte, "voce")).toEqual(["Luna", ...Array.from({ length: 9 }, (_, index) => `Cane ${two(12 - index)}`)]);
    expect(texts(await built.page("/tema/notte/page/2/"), "voce")).toEqual(["Cane 03", "Cane 02", "Cane 01"]);
    expect(texts(await built.page("/tema/notte/cani/"), "totale")).toEqual(["12"]);
    expect(await built.page("/tema/notte/cani/page/3/")).toBeNull();
    // An empty term has its archive, with the template's empty case; the type's archive and the posts index page at 10.
    expect(texts(await built.page("/tema/gatti/"), "totale")).toEqual(["0"]);
    expect(texts(await built.page("/opera/page/2/"), "voce")).toEqual(["Cane 03", "Cane 02", "Cane 01"]);
    expect(texts(await built.page("/blog/page/2/"), "voce")).toEqual(["Articolo 01"]);
    expect(texts(await built.page("/category/racconti/page/2/"), "voce")).toEqual(["Articolo 01"]);
    opened.store.close();
  });

  it("con il template o senza, un archivio ha le stesse pagine e gli stessi contenuti: 10 per pagina, i figli compresi", async () => {
    const target = await project();
    const { store } = target.opened;
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["opera"] }));
    const notte = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "notte", label: "Notte" })).term;
    const cani = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "cani", label: "Cani", parentId: notte.id })).term;
    for (let n = 1; n <= 11; n++) saved(store.content.saveRecord({ typeKey: "opera", title: `Opera ${two(n)}`, slug: `opera-${two(n)}`, status: "published", publishedAt: day(n), terms: { tema: [n % 2 ? cani.alias : notte.alias] } }));
    // Without a template: the build's own page. Before: 20 a page, so /opera/page/2/ did not exist; the parent term
    // listed only its own five records.
    const plain = await build(target);
    const listed = (html: string | null) => [...(html ?? "").matchAll(/<h2><a href="[^"]*">([^<]*)<\/a><\/h2>/gu)].map((match) => match[1]!);
    expect(listed(await plain.page("/opera/"))).toEqual(Array.from({ length: 10 }, (_, index) => `Opera ${two(11 - index)}`));
    expect(listed(await plain.page("/opera/page/2/"))).toEqual(["Opera 01"]);
    expect(listed(await plain.page("/tema/notte/page/2/"))).toEqual(["Opera 01"]);
    expect(listed(await plain.page("/tema/notte/cani/"))).toEqual(["Opera 11", "Opera 09", "Opera 07", "Opera 05", "Opera 03", "Opera 01"]);
    // With a template looping main(): the same addresses, the same contents on each.
    template(store, "site/archivio", MAIN, "archive");
    const templated = await build(target);
    expect(templated.addresses).toEqual(plain.addresses);
    for (const address of ["/opera/", "/opera/page/2/", "/tema/notte/", "/tema/notte/page/2/", "/tema/notte/cani/"]) {
      expect(texts(await templated.page(address), "voce"), address).toEqual(listed(await plain.page(address)));
    }
  });

  it("un ciclo fra i termini (un progetto danneggiato) non blocca il piano né la build", async () => {
    const target = await project();
    const { store } = target.opened;
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["opera"] }));
    const a = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "a", label: "A" })).term;
    const b = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "b", label: "B", parentId: a.id })).term;
    saved(store.content.saveRecord({ typeKey: "opera", title: "Ehi", slug: "ehi", status: "published", publishedAt: day(1), terms: { tema: [b.alias] } }));
    // The store refuses a cycle; a damaged database can hold one: a's parent is b, b's parent is a.
    const database = new DatabaseSync(path.join(store.directory, "content.sqlite"));
    try { database.prepare("UPDATE cms_terms SET parent_id=? WHERE id=?").run(b.id, a.id); } finally { database.close(); }
    const routes = plan(store);
    // Home, the record, the type's archive, the two terms' archives: each once, the cycle cut where it is met.
    expect(routes.count).toBe(5);
    const built = await build(target);
    expect(built.addresses.filter((address) => address.startsWith("/tema/"))).toHaveLength(2);
  });

  it("un archivio vuoto esiste solo nella lingua del sito; nelle altre c'è con almeno un contenuto, e la pagina della build parla la lingua della pagina", async () => {
    const target = await project("en-US");
    const { store } = target.opened;
    saved(store.content.saveType({ key: "opera", label: "Works", fields: [] }));
    saved(store.content.saveType({ key: "evento", label: "Events", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Themes", types: ["opera"] }));
    const terms = Array.from({ length: 30 }, (_, index) => saved(store.content.saveTerm({ taxonomyKey: "tema", slug: `t${index}`, label: `T${index}` })).term);
    saved(store.content.saveRecord({ typeKey: "opera", title: "Night", slug: "night", locale: "en-US", status: "published", publishedAt: day(1), terms: { tema: [terms[0]!.alias] } }));
    saved(store.content.saveRecord({ typeKey: "opera", title: "Notte", slug: "notte", locale: "it-IT", status: "published", publishedAt: day(2), terms: { tema: [terms[1]!.alias] } }));
    for (let n = 1; n <= 11; n++) saved(store.content.saveRecord({ typeKey: "opera", title: `Nacht ${two(n)}`, slug: `nacht-${two(n)}`, locale: "de-DE", status: "published", publishedAt: day(n) }));
    const routes = plan(store);
    // Home, 13 records, /opera/ in three languages (two pages in German), /evento/ in the site's language only, the 30
    // terms' archives in the site's language and the one term with an Italian record in Italian. Before (round 5): the
    // 30 terms in every language of their type, 90 archives.
    expect(routes.count).toBe(1 + 13 + 4 + 1 + 30 + 1);
    const built = await build(target);
    expect(built.addresses).toHaveLength(routes.count);
    expect(built.addresses).toEqual(expect.arrayContaining(["/tema/t0/", "/tema/t1/", "/tema/t29/", "/it-it/tema/t1/", "/evento/", "/de-de/opera/page/2/"]));
    expect(built.addresses).not.toContain("/it-it/tema/t0/");
    expect(built.addresses).not.toContain("/de-de/tema/t0/");
    expect(built.addresses).not.toContain("/it-it/evento/");
    // The build's own archive page: English on an English site (before: «Nessun contenuto.»), Italian on an Italian page.
    const empty = await built.page("/evento/");
    expect(empty).toContain("<p>Nothing found.</p>");
    expect(empty).not.toMatch(/Nessun contenuto|Paginazione/u);
    expect(await built.page("/de-de/opera/")).toContain('<nav aria-label="Pagination">');
    expect(await built.page("/it-it/tema/t1/")).toContain('<html lang="it-IT">');
  });

  it("/blog/ è l'elenco degli articoli solo con degli articoli: un template home da solo non lo crea, una bozza sì, una pagina blog lo prende", async () => {
    const target = await project();
    const { store } = target.opened;
    template(store, "site/blog", MAIN, "home");
    // Before (round 5): a home-role template alone planned /blog/, wrote a stray blog/index.html and refused a type «blog».
    expect([...plan(store).routes.keys()]).not.toContain("blog");
    expect((await build(target)).addresses).toEqual(["/"]);
    store.createPost({ title: "Bozza", slug: "bozza" });
    expect([...plan(store).routes.keys()]).toContain("blog");
    expect(texts(await (await build(target)).page("/blog/"), "totale")).toEqual(["0"]);
    const blogPage = store.createPage({ title: "Diario", slug: "blog", content: serializeXb(parse("<h1>Diario</h1>").blocks), status: "published" });
    expect(blogPage.slug).toBe("blog");
    expect((await build(target)).addresses).toEqual(["/", "/blog/"]);
    expect(await (await build(target)).page("/blog/")).toContain("Diario");
  });
});

const PROTOTYPE = (content: string, body: string) => `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e","name":"Blog","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${content}</script>
</head><body>
<template data-histos="template" data-ref="site/home" data-role="home" data-title="Home"><header><p class="testata">Studio</p></header><main>{@slot}</main></template>
<template data-histos="page" data-slug="home" data-title="Home" data-template="site/home"><h1>Benvenuti</h1></template>
${body}
</body></html>`;

describe("/blog/: il controllo, l'import e la build lo decidono con la stessa regola (B1)", () => {
  it("un tipo «blog» con un template home e nessun articolo si controlla e si costruisce; con un articolo in bozza no, al suo posto", async () => {
    const root = await scratch();
    const target = { root, catalog: new CmsProjectCatalog(path.join(root, "catalog")) };
    const content = JSON.stringify({ types: [{ key: "blog", label: "Diario", fields: [] }], records: [{ type: "blog", slug: "primo", title: "Primo", status: "published", publishedAt: day(1) }] });
    // Before (round 5): «Due contenuti avrebbero lo stesso indirizzo /blog/: l'elenco degli articoli e l'archivio del tipo blog».
    const valid = await checkPrototype(PROTOTYPE(content, ""), { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(context(target), opened, signal) });
    expect(valid).toMatchObject({ valid: true, preview: { status: "ready" } });
    // A draft post starts the blog: the check refuses the type where it is declared, as the import does.
    const draft = PROTOTYPE(content, '<template data-histos="post" data-slug="bozza" data-title="Bozza" data-status="draft"><p>x</p></template>');
    const refused = await checkPrototype(draft, { scratchRoot: root }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PrototypeInvalidError);
    expect((refused as PrototypeInvalidError).issues).toEqual([expect.objectContaining({ document: "tipo blog", line: expect.any(Number), message: expect.stringMatching(/^il tipo «blog» prende l'indirizzo \/blog\/, che con degli articoli \(anche solo in bozza\) è l'elenco degli articoli/u) })]);
  });
});

describe("tipo senza pagine proprie (doc 23, voce 122)", () => {
  it("non ha pagine singole né archivio, e i suoi record non hanno indirizzo nei loop", async () => {
    const target = await project();
    const store = target.opened.store;
    saved(store.content.saveType({ key: "foto", label: "Foto", fields: [], public: false }));
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    expect(store.content.getType("foto")?.public).toBe(false);
    expect(store.content.getType("opera")?.public).toBe(true);
    saved(store.content.saveRecord({ typeKey: "foto", title: "Mare", slug: "mare", status: "published", publishedAt: day(1) }));
    saved(store.content.saveRecord({ typeKey: "opera", title: "Ponte", slug: "ponte", status: "published", publishedAt: day(1) }));
    const addresses = [...plan(store).routes.keys()];
    expect(addresses.some((address) => address.startsWith("foto"))).toBe(false);
    expect(addresses).toContain("opera/ponte");
    expect(store.content.previewQueryDefinition({ type: "posts", args: { post_type: "foto", posts_per_page: 5 } })[0]?.url).toBe("");
    expect(store.content.previewQueryDefinition({ type: "posts", args: { post_type: "opera", posts_per_page: 5 } })[0]?.url).toContain("opera/ponte");
    const built = await build(target);
    expect(built.addresses.some((address) => address.startsWith("/foto/"))).toBe(false);
    expect(built.addresses).toContain("/opera/ponte/");
  });
});
