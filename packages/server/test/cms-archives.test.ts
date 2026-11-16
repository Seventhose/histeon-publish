import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import type { TemplateRole } from "@histos-publish/histos-contract";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { buildCmsProject, buildPrototypePreview, cmsRoutePlanProblems, planCmsRoutes, type CmsOperationsContext } from "../src/cms-api.js";
import { checkPrototype, PrototypeInvalidError } from "../src/prototype-check.js";
import { startLocalServer } from "../src/server.js";

/**
 * The archives of the static build as the agent docs promise them, the same as the builder on WordPress (D2, D3, D6,
 * D8 of the round-4 docs check): `{#loop main()}` lists the archive's own records, empty archives exist, posts and
 * records carry their meta description, two contents on one address are refused by name, and a site that does not
 * build makes the prototype check invalid.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-archives-"));
  roots.push(root);
  return root;
}

interface Project { root: string; catalog: CmsProjectCatalog; opened: { project: { id: string }; store: CmsProjectStore } }

async function project(): Promise<Project> {
  const root = await scratch();
  const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
  const opened = await catalog.createProject("Archivi");
  const home = opened.store.listPages()[0]!;
  opened.store.updatePageMetadata(home.id, { title: home.title, slug: home.slug, status: "published" });
  return { root, catalog, opened };
}

function template(store: CmsProjectStore, ref: string, source: string, role?: TemplateRole): string {
  const created = store.createTemplate({ ref, title: ref, content: serializeXb(parse(source).blocks) });
  if (role) store.setTemplateRole(created.id, role);
  return created.ref;
}

function context(target: Project, limits?: { maxRoutes?: number }): CmsOperationsContext {
  return {
    catalog: target.catalog, dataDirectory: target.root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined,
    ...(limits ? { buildLimits: limits } : {}),
    prototypePreviews: { root: path.join(target.root, "previews"), track: () => undefined, folder: async () => null } as unknown as CmsOperationsContext["prototypePreviews"],
  };
}

/** Builds the project outside the registry and returns a reader of its pages: null for a page the build did not write. */
async function build(target: Project): Promise<(address: string) => Promise<string | null>> {
  const out = path.join(target.root, "out");
  const result = await buildCmsProject(context(target), target.opened, { throwaway: { directory: out } });
  expect(result.status).toBe("ready");
  const folder = path.join(out, String(result.id));
  return async (address) => {
    const file = address === "/404.html" ? "404.html" : path.join(...address.split("/").filter(Boolean), "index.html");
    return readFile(path.join(folder, file), "utf8").catch(() => null);
  };
}

/** The text of every element with `className` on a page, in order. */
function texts(html: string | null, className: string): string[] {
  return [...(html ?? "").matchAll(new RegExp(`class="${className}"[^>]*>([^<]*)<`, "gu"))].map((match) => match[1]!);
}

function saved<T extends { status: string }>(result: T): Extract<T, { status: "saved" }> {
  if (result.status !== "saved") throw new Error(`Salvataggio non riuscito: ${JSON.stringify(result)}`);
  return result as Extract<T, { status: "saved" }>;
}

const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T09:00:00Z`;
const two = (n: number) => String(n).padStart(2, "0");

/** A loop over main() with the archive's empty case: the template the docs show for archives. */
const MAIN_ARCHIVE = '<main><h1 class="titolo">{page.title}</h1><p class="totale">{page.totalRecords}</p>{#if page.totalRecords}{#loop main() as item}<a class="voce" href="{item.url}">{item.title}</a>{/loop}{:else}<p class="vuoto">Nessun contenuto qui.</p>{/if}{@slot}</main>';

describe("archivi della build statica: main(), archivi vuoti, descrizione, indirizzi contesi", () => {
  it("main() elenca i contenuti dell'archivio che il template mostra, 10 per pagina dal più recente: tipo, termine, elenco articoli (D3)", async () => {
    const target = await project();
    const { store } = target.opened;
    // A type's own archive template, with a query loop beside main(): the query loop works as before.
    const opere = template(store, "site/opere", MAIN_ARCHIVE.replace("{@slot}", '<ol>{#loop recenti() as r}<li class="recente">{r.title}</li>{/loop}</ol>{@slot}'));
    template(store, "site/archivio", MAIN_ARCHIVE, "archive");
    template(store, "site/categoria", MAIN_ARCHIVE, "category");
    template(store, "site/blog", MAIN_ARCHIVE, "home");
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [], archiveTemplateRef: opere }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["opera"] }));
    saved(store.content.saveTaxonomy({ key: "category", label: "Categorie", types: ["post"] }));
    const notte = saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "notte", label: "Notte" })).term;
    saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "cani", label: "Cani" }));
    const racconti = saved(store.content.saveTerm({ taxonomyKey: "category", slug: "racconti", label: "Racconti" })).term;
    for (let n = 1; n <= 21; n++) {
      saved(store.content.saveRecord({ typeKey: "opera", title: `Opera ${two(n)}`, slug: `opera-${two(n)}`, status: "published", publishedAt: day(n), terms: n <= 3 ? { tema: [notte.alias] } : {} }));
      store.createPost({ title: `Articolo ${two(n)}`, slug: `articolo-${two(n)}`, status: "published", publishedAt: day(n), terms: n <= 2 ? { category: [racconti.id] } : {} });
    }
    saved(store.content.saveRecord({ typeKey: "opera", title: "Opera in bozza", slug: "bozza", status: "draft", terms: { tema: [notte.alias] } }));
    saved(store.content.saveQueryPreset({ key: "recenti", label: "Recenti", typeKey: "opera", limit: 5, orderBy: "publishedAt", order: "desc", expectedHead: null }));
    const page = await build(target);

    // The type's archive: newest first, 10 a page as WordPress's posts_per_page, each with its address; the draft nowhere.
    const first = await page("/opera/");
    expect(texts(first, "voce")).toEqual(Array.from({ length: 10 }, (_, index) => `Opera ${two(21 - index)}`));
    expect(first).toContain('href="/opera/opera-21/"');
    expect(texts(first, "totale")).toEqual(["21"]);
    expect(texts(await page("/opera/page/2/"), "voce")).toEqual(Array.from({ length: 10 }, (_, index) => `Opera ${two(11 - index)}`));
    expect(texts(await page("/opera/page/3/"), "voce")).toEqual(["Opera 01"]);
    expect(first).not.toContain("Opera in bozza");
    // The explicit query loop pages as before: its own limit, offset by the page.
    expect(texts(first, "recente")).toEqual(["Opera 21", "Opera 20", "Opera 19", "Opera 18", "Opera 17"]);
    expect(texts(await page("/opera/page/2/"), "recente")).toEqual(["Opera 16", "Opera 15", "Opera 14", "Opera 13", "Opera 12"]);
    // A term's archive lists that term's records only (before: every record of the query, whatever the term).
    expect(texts(await page("/tema/notte/"), "voce")).toEqual(["Opera 03", "Opera 02", "Opera 01"]);
    expect(texts(await page("/category/racconti/"), "voce")).toEqual(["Articolo 02", "Articolo 01"]);
    expect(await page("/category/racconti/")).toContain('href="/blog/articolo-02/"');
    // The posts index: the posts, paged.
    const blog = await page("/blog/");
    expect(texts(blog, "voce")).toEqual(Array.from({ length: 10 }, (_, index) => `Articolo ${two(21 - index)}`));
    expect(texts(await page("/blog/page/3/"), "voce")).toEqual(["Articolo 01"]);
  });

  it("gli archivi hanno page.prevUrl, page.nextUrl e page.pageLinks: tipo, termine ed elenco articoli (A8)", async () => {
    const target = await project();
    const { store } = target.opened;
    const PAGING = '<main><h1>{page.title}</h1><p class="pagina">{page.page}/{page.totalPages}/{page.totalRecords}</p><p class="prev">{page.prevUrl}</p><p class="next">{page.nextUrl}</p><nav>{#loop page.pageLinks as l}<a class="link" href={l.url} data-current={l.current}>{l.number}</a>{/loop}</nav>{@slot}</main>';
    const opere = template(store, "site/opere", PAGING);
    template(store, "site/categoria", PAGING, "category");
    template(store, "site/blog", PAGING, "home");
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [], archiveTemplateRef: opere }));
    saved(store.content.saveTaxonomy({ key: "category", label: "Categorie", types: ["post"] }));
    const racconti = saved(store.content.saveTerm({ taxonomyKey: "category", slug: "racconti", label: "Racconti" })).term;
    saved(store.content.saveTerm({ taxonomyKey: "category", slug: "vuota", label: "Vuota" }));
    for (let n = 1; n <= 21; n++) {
      saved(store.content.saveRecord({ typeKey: "opera", title: `Opera ${two(n)}`, slug: `opera-${two(n)}`, status: "published", publishedAt: day(n) }));
      if (n <= 12) store.createPost({ title: `Articolo ${two(n)}`, slug: `articolo-${two(n)}`, status: "published", publishedAt: day(n), terms: { category: [racconti.id] } });
    }
    const page = await build(target);
    const paging = async (address: string) => {
      const html = await page(address);
      return {
        pagina: texts(html, "pagina")[0], prev: texts(html, "prev")[0], next: texts(html, "next")[0],
        links: [...(html ?? "").matchAll(/<a class="link" href="([^"]*)"( data-current(?:="[^"]*")?)?>(\d+)<\/a>/gu)].map((match) => `${match[3]} ${match[1]}${match[2] && !match[2].includes("false") ? " *" : ""}`),
      };
    };
    const opereLinks = (current: number) => [1, 2, 3].map((n) => `${n} ${n === 1 ? "/opera/" : `/opera/page/${n}/`}${n === current ? " *" : ""}`);
    expect(await paging("/opera/")).toEqual({ pagina: "1/3/21", prev: "", next: "/opera/page/2/", links: opereLinks(1) });
    expect(await paging("/opera/page/2/")).toEqual({ pagina: "2/3/21", prev: "/opera/", next: "/opera/page/3/", links: opereLinks(2) });
    expect(await paging("/opera/page/3/")).toEqual({ pagina: "3/3/21", prev: "/opera/page/2/", next: "", links: opereLinks(3) });
    expect(await paging("/category/racconti/page/2/")).toEqual({ pagina: "2/2/12", prev: "/category/racconti/", next: "", links: ["1 /category/racconti/", "2 /category/racconti/page/2/ *"] });
    expect(await paging("/category/vuota/")).toEqual({ pagina: "1/1/0", prev: "", next: "", links: ["1 /category/vuota/ *"] });
    expect(await paging("/blog/")).toEqual({ pagina: "1/2/12", prev: "", next: "/blog/page/2/", links: ["1 /blog/ *", "2 /blog/page/2/"] });
  });

  it("main() fuori da un archivio o con argomenti ferma la build con il motivo, l'indirizzo e il template", async () => {
    const target = await project();
    const { store } = target.opened;
    const pagina = template(store, "site/pagina", "<main>{#loop main() as item}<p>{item.title}</p>{/loop}{@slot}</main>");
    const home = store.listPages()[0]!;
    store.updatePageMetadata(home.id, { title: home.title, slug: home.slug, status: "published", templateRef: pagina });
    const refused = await buildCmsProject(context(target), target.opened, { throwaway: { directory: path.join(target.root, "out") } }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HistosPublishError);
    expect(refused).toMatchObject({ code: "cms-capability-unavailable", message: expect.stringMatching(/^\/ \(template site\/pagina\): \{#loop main\(\)\}: main\(\) elenca i contenuti di un archivio e vale solo nei template d'archivio/u) });

    const other = await project();
    template(other.opened.store, "site/archivio", MAIN_ARCHIVE.replace("main()", "main(limit: 3)"), "archive");
    saved(other.opened.store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    saved(other.opened.store.content.saveRecord({ typeKey: "opera", title: "Ehi", slug: "ehi", status: "published" }));
    const withArguments = await buildCmsProject(context(other), other.opened, { throwaway: { directory: path.join(other.root, "out") } }).catch((error: unknown) => error);
    expect(withArguments).toMatchObject({ code: "cms-capability-unavailable", message: expect.stringContaining("/opera/ (template site/archivio): {#loop main()}: main() non accetta argomenti") });
  });

  it("un archivio senza contenuti esiste, con il suo {:else}: tipo, termine ed elenco articoli (D2)", async () => {
    const target = await project();
    const { store } = target.opened;
    const eventi = template(store, "site/eventi", MAIN_ARCHIVE);
    template(store, "site/archivio", MAIN_ARCHIVE, "archive");
    template(store, "site/blog", MAIN_ARCHIVE, "home");
    saved(store.content.saveType({ key: "evento", label: "Eventi", fields: [], archiveTemplateRef: eventi }));
    saved(store.content.saveType({ key: "luogo", label: "Luoghi", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["evento"] }));
    saved(store.content.saveTerm({ taxonomyKey: "tema", slug: "notte", label: "Notte" }));
    // Only drafts: no published record, no published post.
    saved(store.content.saveRecord({ typeKey: "evento", title: "Concerto", slug: "concerto", status: "draft" }));
    store.createPost({ title: "Bozza", slug: "bozza" });
    const page = await build(target);
    for (const [address, title] of [["/evento/", "Eventi"], ["/luogo/", "Luoghi"], ["/tema/notte/", "Notte"], ["/blog/", "Blog"]] as const) {
      const html = await page(address);
      // Before: no page at all, so a menu link to it was a 404.
      expect(html, address).not.toBeNull();
      expect(texts(html, "titolo"), address).toEqual([title]);
      expect(texts(html, "totale"), address).toEqual(["0"]);
      expect(texts(html, "vuoto"), address).toEqual(["Nessun contenuto qui."]);
    }
    expect(await page("/evento/concerto/")).toBeNull();
    expect(await page("/blog/bozza/")).toBeNull();
    expect(await page("/evento/page/2/")).toBeNull();
  });

  it("senza template un archivio vuoto lo dice; senza articoli né template home non c'è /blog/", async () => {
    const target = await project();
    const { store } = target.opened;
    // An Italian site, whatever the computer's language: the build's own page speaks the site's language.
    store.setRenderSettings({ ...store.getRenderSettings(), locale: "it-IT" });
    saved(store.content.saveType({ key: "evento", label: "Eventi", fields: [] }));
    const page = await build(target);
    expect(await page("/evento/")).toContain("<h1>Eventi</h1></header><p>Nessun contenuto.</p></main>");
    // No blog in the project: no posts index.
    expect(await page("/blog/")).toBeNull();
  });

  it("articoli e record hanno la descrizione dal riassunto, come testo e tagliata a 160 caratteri su una parola (D6)", async () => {
    const target = await project();
    const { store } = target.opened;
    template(store, "site/articolo", "<article><h1>{page.title}</h1>{@slot}</article>", "single");
    const scheda = template(store, "site/scheda", "<article><h1>{page.title}</h1>{@slot}</article>");
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [], singleTemplateRef: scheda }));
    saved(store.content.saveType({ key: "nota", label: "Note", fields: [] }));
    const long = `Un "racconto" <breve> & sincero: ${"parola ".repeat(40)}fine.`;
    store.createPost({ title: "Lungo", slug: "lungo", status: "published", publishedAt: day(1), excerpt: long });
    store.createPost({ title: "Senza", slug: "senza", status: "published", publishedAt: day(2) });
    saved(store.content.saveRecord({ typeKey: "opera", title: "Ehi", slug: "ehi", status: "published", excerpt: "Un quadretto\n su  tela." }));
    saved(store.content.saveRecord({ typeKey: "nota", title: "Nota", slug: "nota", status: "published", excerpt: long }));
    const page = await build(target);
    const description = (html: string | null) => {
      const found = /<meta name="description" content="([^"]*)">/u.exec(html ?? "");
      return found ? found[1]!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#39;", "'").replaceAll("&amp;", "&") : null;
    };
    const post = await page("/blog/lungo/");
    // Escaped in the attribute: no quote, angle bracket or bare ampersand of the excerpt reaches the markup.
    expect(post).toContain('<meta name="description" content="Un &quot;racconto&quot; &lt;breve&gt; &amp; sincero: parola');
    const cut = description(post)!;
    expect(Array.from(cut).length).toBeLessThanOrEqual(160);
    expect(cut).toMatch(/ parola…$/u);
    expect(long.startsWith(`${cut.slice(0, -1)} `)).toBe(true);
    // A record with its single template, and one with the plain page of the build: the same rule.
    expect(description(await page("/opera/ehi/"))).toBe("Un quadretto su tela.");
    expect(description(await page("/nota/nota/"))).toBe(cut);
    // No excerpt, a page, an archive: no tag.
    expect(description(await page("/blog/senza/"))).toBeNull();
    expect(description(await page("/"))).toBeNull();
    expect(description(await page("/opera/"))).toBeNull();
  });

  it("due contenuti sullo stesso indirizzo fermano la build con i due nomi, mai con un EEXIST (tag, blog)", async () => {
    const target = await project();
    const { store } = target.opened;
    saved(store.content.saveType({ key: "tag", label: "Etichette", fields: [] }));
    saved(store.content.saveTaxonomy({ key: "post_tag", label: "Tag", types: ["post"] }));
    const news = saved(store.content.saveTerm({ taxonomyKey: "post_tag", slug: "news", label: "News" })).term;
    saved(store.content.saveRecord({ typeKey: "tag", title: "News", slug: "news", status: "published" }));
    store.createPost({ title: "Notizia", slug: "notizia", status: "published", publishedAt: day(1), terms: { post_tag: [news.id] } });
    const refused = await buildCmsProject(context(target), target.opened, { throwaway: { directory: path.join(target.root, "out") } }).catch((error: unknown) => error);
    // Before: «EEXIST: file already exists, open '…/tag/news/index.html'», halfway through the build.
    expect(refused).toBeInstanceOf(HistosPublishError);
    expect(refused).toMatchObject({ code: "cms-build-route-collision", message: "Due contenuti avrebbero lo stesso indirizzo /tag/news/: il record «news» del tipo tag e l'archivio del termine «news» (post_tag). Cambia lo slug di uno dei due, o la chiave del tipo o della tassonomia." });

    const blog = await project();
    saved(blog.opened.store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    saved(blog.opened.store.content.saveTaxonomy({ key: "blog", label: "Rubriche", types: ["opera"] }));
    const ciao = saved(blog.opened.store.content.saveTerm({ taxonomyKey: "blog", slug: "ciao", label: "Ciao" })).term;
    saved(blog.opened.store.content.saveRecord({ typeKey: "opera", title: "Ehi", slug: "ehi", status: "published", terms: { blog: [ciao.alias] } }));
    blog.opened.store.createPost({ title: "Ciao", slug: "ciao", status: "published", publishedAt: day(1) });
    const plan = planCmsRoutes(blog.opened.store, { pages: blog.opened.store.listPages(), posts: blog.opened.store.listPosts(), maxRoutes: 50_000 });
    expect(plan.collisions).toEqual([{ address: "/blog/ciao/", first: "l'articolo «ciao»", second: "l'archivio del termine «ciao» (blog)" }]);
    await expect(buildCmsProject(context(blog), blog.opened, { throwaway: { directory: path.join(blog.root, "out") } })).rejects.toMatchObject({ code: "cms-build-route-collision", message: expect.stringContaining("/blog/ciao/: l'articolo «ciao» e l'archivio del termine «ciao» (blog)") });
  });

  it("il piano conta ogni pagina di ogni archivio e dice quante sono oltre il limite", async () => {
    const target = await project();
    const { store } = target.opened;
    saved(store.content.saveType({ key: "opera", label: "Opere", fields: [] }));
    for (let n = 1; n <= 21; n++) saved(store.content.saveRecord({ typeKey: "opera", title: `Opera ${n}`, slug: `opera-${n}`, status: "published", publishedAt: day(n) }));
    const plan = planCmsRoutes(store, { pages: store.listPages(), posts: [], maxRoutes: 50_000 });
    // Home, 21 records, the archive's three pages of 10.
    expect(plan.count).toBe(25);
    expect([...plan.routes.keys()]).toEqual(expect.arrayContaining(["", "opera/opera-1", "opera", "opera/page/2", "opera/page/3"]));
    expect(cmsRoutePlanProblems(plan, 50_000)).toEqual({ messages: [], total: 0 });
    expect(cmsRoutePlanProblems(plan, 10).messages).toEqual([expect.stringMatching(/^La build supera il limite di 10 pagine generate: il sito ne avrebbe 25, contando pagine, articoli, record e ogni pagina di ogni archivio/u)]);
    const refused = await buildCmsProject(context(target, { maxRoutes: 10 }), target.opened, { throwaway: { directory: path.join(target.root, "out") } }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "cms-build-route-limit", message: expect.stringContaining("il sito ne avrebbe 25") });
  });
});

const PROTOTYPE = (content: string, body = "") => `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f","name":"Indirizzi","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${content}</script>
</head><body>
<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>
${body}
</body></html>`;

describe("il controllo del prototipo dice ciò che la build rifiuterebbe (D8)", () => {
  it("gli indirizzi contesi sono problemi del controllo, con i due nomi, senza costruire", async () => {
    const html = PROTOTYPE(JSON.stringify({
      types: [{ key: "tag", label: "Etichette", fields: [] }],
      taxonomies: [{ key: "post_tag", label: "Tag", types: ["post"] }],
      terms: [{ taxonomy: "post_tag", slug: "news", label: "News" }, { taxonomy: "post_tag", slug: "arte", label: "Arte" }],
      records: [{ type: "tag", slug: "news", title: "News", status: "published", publishedAt: day(1) }, { type: "tag", slug: "arte", title: "Arte", status: "published", publishedAt: day(2) }],
    }));
    const refused = await checkPrototype(html, { scratchRoot: await scratch() }).catch((error: unknown) => error);
    // Before: valid: true, and the first build ended on EEXIST.
    expect(refused).toBeInstanceOf(PrototypeInvalidError);
    const error = refused as PrototypeInvalidError;
    expect(error).toMatchObject({ code: "cms-prototype-invalid", total: 2 });
    expect(error.issues.map((issue) => issue.message)).toEqual([
      "Due contenuti avrebbero lo stesso indirizzo /tag/arte/: il record «arte» del tipo tag e l'archivio del termine «arte» (post_tag). Cambia lo slug di uno dei due, o la chiave del tipo o della tassonomia.",
      "Due contenuti avrebbero lo stesso indirizzo /tag/news/: il record «news» del tipo tag e l'archivio del termine «news» (post_tag). Cambia lo slug di uno dei due, o la chiave del tipo o della tassonomia.",
    ]);
    expect(error.message).toMatch(/^Il prototipo ha 2 errori:\n1\. Due contenuti avrebbero lo stesso indirizzo \/tag\/arte\//u);
  });

  it("con preview: true un sito che non si costruisce rende il controllo non valido, con il motivo; un'anteprima solo non disponibile no", async () => {
    const root = await scratch();
    const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
    const target: Project = { root, catalog, opened: undefined as unknown as Project["opened"] };
    const nested = "{#loop [1] as a}{#loop [1] as b}{#loop [1] as c}{#loop [1] as d}{#loop [1] as e}{#loop [1] as f}{#loop [1] as g}<p>x</p>{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}";
    const html = PROTOTYPE("{}", `<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><h1>Chi siamo</h1>${nested}</template>`);
    const refused = await checkPrototype(html, { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(context(target), opened, signal) }).catch((error: unknown) => error);
    // Before: { valid: true, preview: { status: "unavailable", reason: "…" } }, easy to miss.
    expect(refused).toBeInstanceOf(PrototypeInvalidError);
    expect(refused).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: "La versione del sito si ferma: /chi-siamo/: I loop annidati superano il limite di 6." }] });
    // A limit of the build is the site's too.
    const twoPages = PROTOTYPE("{}", '<template data-histos="page" data-slug="contatti" data-title="Contatti"><h1>Contatti</h1></template>');
    const limited = await checkPrototype(twoPages, { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(context(target, { maxRoutes: 1 }), opened, signal) }).catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: expect.stringMatching(/^La versione del sito si ferma: La build supera il limite di 1 pagine generate: il sito ne avrebbe 2/u) }] });
    // No previews in this app: unavailable, and the prototype stays valid.
    const noPreviews = { ...context(target), prototypePreviews: undefined };
    const valid = await checkPrototype(PROTOTYPE("{}"), { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(noPreviews, opened, signal) });
    expect(valid).toMatchObject({ valid: true, preview: { status: "unavailable" } });
  });

  it("nell'app il controllo con anteprima risponde 422 con il motivo della build, come ogni prototipo rifiutato", async () => {
    const dataDirectory = await scratch();
    const uiDirectory = await scratch();
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    const server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, cmsBuildLimits: { maxRoutes: 1 } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const twoPages = PROTOTYPE("{}", '<template data-histos="page" data-slug="contatti" data-title="Contatti"><h1>Contatti</h1></template>');
      const response = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1&preview=1`, { method: "POST", headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "text/html; charset=utf-8" }, body: twoPages });
      const body = await response.json() as { code: string; error: string; issues: Array<{ message: string }> };
      // Before: 200 { valid: true, preview: { status: "unavailable", reason } }.
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(body).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: expect.stringMatching(/^La versione del sito si ferma: La build supera il limite di 1 pagine generate/u) }] });
      // The same file without the preview stays valid: only a build finds what the build refuses.
      const plain = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "text/html; charset=utf-8" }, body: twoPages });
      expect(await plain.json()).toMatchObject({ valid: true, outcome: "create" });
    } finally {
      await server.close();
    }
  });
});
