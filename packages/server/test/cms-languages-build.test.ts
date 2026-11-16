import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import type { TemplateRole } from "@histos-publish/histos-contract";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { buildCmsProject, type CmsOperationsContext } from "../src/cms-api.js";

/** A site in two languages built for real (doc 20 §10): addresses, lang, archives, data.lingua, hreflang, sitemap. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Project { root: string; catalog: CmsProjectCatalog; opened: { project: { id: string }; store: CmsProjectStore } }

async function project(): Promise<Project> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-languages-build-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
  const opened = await catalog.createProject("Lingue");
  opened.store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  const home = opened.store.listPages()[0]!;
  opened.store.updatePageMetadata(home.id, { title: "Home", slug: home.slug, status: "published" });
  return { root, catalog, opened };
}

function template(store: CmsProjectStore, ref: string, source: string, role: TemplateRole): void {
  const created = store.createTemplate({ ref, title: ref, content: serializeXb(parse(source).blocks) });
  store.setTemplateRole(created.id, role);
}

async function build(target: Project) {
  const out = path.join(target.root, "out");
  const context: CmsOperationsContext = { catalog: target.catalog, dataDirectory: target.root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined };
  const result = await buildCmsProject(context, target.opened, { throwaway: { directory: out } });
  expect(result.status).toBe("ready");
  const folder = path.join(out, String(result.id));
  const read = (file: string) => readFile(path.join(folder, file), "utf8").catch(() => null);
  return { result, read, page: (address: string) => read(path.join(...address.split("/").filter(Boolean), "index.html")), files: () => readdir(folder, { recursive: true }) };
}

const publish = (store: CmsProjectStore, id: string, slug: string, title: string) => store.updatePageMetadata(id, { title, slug, status: "published" });
const publishPost = (store: CmsProjectStore, id: string, slug: string, title: string) => store.updatePostMetadata(id, { title, slug, status: "published" });

describe("build in più lingue", () => {
  it("scrive ogni lingua nella sua cartella, con lang e hreflang", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    store.setSiteUrl("https://esempio.it");
    const about = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    const home = store.listPages().find((page) => page.slug === "home")!;
    publish(store, store.createTranslation({ sourceId: home.id, language: "en" }).translationId, "home", "Welcome");
    publish(store, store.createTranslation({ sourceId: about.id, language: "en" }).translationId, "about", "About");
    const { read, page } = await build(target);
    expect(await read("index.html")).toContain('<html lang="it-IT"');
    const en = await page("/en/about/");
    expect(en).toContain('<html lang="en"');
    expect(en).toContain("<title>About</title>");
    expect(en).toContain('<link rel="alternate" hreflang="en" href="https://esempio.it/en/about/">');
    expect(en).toContain('<link rel="alternate" hreflang="it-IT" href="https://esempio.it/chi-siamo/">');
    expect(en).toContain('<link rel="alternate" hreflang="x-default" href="https://esempio.it/chi-siamo/">');
    expect(await page("/en/")).toContain("<title>Welcome</title>");
    const sitemap = await read("sitemap.xml");
    expect(sitemap).toContain("<loc>https://esempio.it/en/about/</loc>");
    expect(sitemap).toContain('<xhtml:link rel="alternate" hreflang="it-IT" href="https://esempio.it/chi-siamo/"/>');
    expect(await read("robots.txt")).toContain("Sitemap: https://esempio.it/sitemap.xml");
  });

  it("gli articoli e gli elenchi restano ciascuno nella sua lingua", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    template(store, "site/blog", '<ul>{#loop main() as post}<li class="voce"><a class="voce__link" href={post.url}>{post.title}</a></li>{/loop}</ul>{@slot}', "home");
    const post = store.createPost({ title: "Ciao", slug: "ciao", status: "published" });
    publishPost(store, store.createTranslation({ sourceId: post.id, language: "en" }).translationId, "hello", "Hello");
    const { page } = await build(target);
    expect(await page("/blog/ciao/")).toContain('<html lang="it-IT"');
    expect(await page("/en/blog/hello/")).toContain('<html lang="en"');
    const list = await page("/blog/");
    expect(list).toContain("Ciao");
    expect(list).not.toContain("Hello");
    const english = await page("/en/blog/");
    expect(english).toContain('href="/en/blog/hello/"');
    expect(english).not.toContain("Ciao");
  });

  it("una bozza tradotta non esce, e la versione pubblicata senza l'altra non ha hreflang", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    const about = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    store.createTranslation({ sourceId: about.id, language: "en", slug: "about" });
    const { page } = await build(target);
    expect(await page("/en/about/")).toBeNull();
    expect(await page("/chi-siamo/")).not.toContain("hreflang");
  });

  it("data.lingua dà le versioni pubblicate al selettore", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }, { code: "de" }]);
    template(store, "site/pagina", '<nav class="lingue">{#loop data.lingua.alternates as lang}<a class="lingue__link" href={lang.url} hreflang={lang.code}>{lang.code}</a>{/loop}</nav><main class="corpo">{@slot}</main>', "page");
    const about = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    publish(store, store.createTranslation({ sourceId: about.id, language: "en" }).translationId, "about", "About");
    const { page } = await build(target);
    const it = await page("/chi-siamo/");
    expect(it).toContain('href="/en/about/" hreflang="en"');
    expect(it).toContain('hreflang="it-IT"');
    expect(it).not.toContain('hreflang="de"');
  });

  it("traduce stringhe e link interni dei template, nella build", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    const about = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    template(store, "site/pagina", '<header class="testa"><a class="testa__link" href="/chi-siamo/">Chi siamo</a><a class="testa__casa" href="/">Inizio</a></header><main class="corpo">{@slot}</main><p class="piede">Tutti i diritti</p>', "page");
    const home = store.listPages().find((page) => page.slug === "home")!;
    publish(store, store.createTranslation({ sourceId: home.id, language: "en" }).translationId, "home", "Home");
    publish(store, store.createTranslation({ sourceId: about.id, language: "en" }).translationId, "about", "About");
    store.saveStrings("en", [{ source: "Tutti i diritti", translation: "All rights", context: "template" }, { source: "Chi siamo", translation: "About", context: "template" }], "published");
    const { page } = await build(target);
    const en = await page("/en/about/");
    expect(en).toContain('href="/en/about/">About</a>');
    expect(en).toContain('href="/en/">Inizio</a>');
    expect(en).toContain(">All rights</p>");
    const it = await page("/chi-siamo/");
    expect(it).toContain('href="/chi-siamo/">Chi siamo</a>');
    expect(it).toContain(">Tutti i diritti</p>");
  });

  it("la 404 tradotta non indica un indirizzo con la barra finale", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    template(store, "site/errore", '<nav class="l">{#loop data.lingua.alternates as lang}<a class="l__a" href={lang.url} hreflang={lang.code}>{lang.code}</a>{/loop}</nav>{@slot}', "404");
    const home = store.listPages().find((page) => page.slug === "home")!;
    publish(store, store.createTranslation({ sourceId: home.id, language: "en" }).translationId, "home", "Home");
    const { read } = await build(target);
    expect(await read("en/404.html")).not.toContain("404.html/");
    expect(await read("en/404.html")).toContain('href="/" hreflang="it-IT"');
  });

  it("un progetto con una lingua e senza indirizzo non cambia di un byte", async () => {
    const one = await project();
    const before = await build(one);
    expect((await before.files()).filter((file) => file === "sitemap.xml" || file === "robots.txt")).toEqual([]);
    const html = await before.read("index.html");
    expect(html).not.toContain("hreflang");
    expect(before.result.findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "cms-site-url-missing" })]));
  });

  it("senza indirizzo avvisa e tiene i link relativi", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    const about = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    publish(store, store.createTranslation({ sourceId: about.id, language: "en" }).translationId, "about", "About");
    const { result, page, read } = await build(target);
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "cms-site-url-missing" })]));
    expect(await page("/chi-siamo/")).toContain('hreflang="en" href="/en/about/"');
    expect(await read("sitemap.xml")).toBeNull();
  });

  it("nomina i due contenuti quando una pagina occupa la cartella di una lingua", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setProjectLanguages([{ code: "en" }]);
    store.createPage({ title: "En", slug: "en", status: "published" });
    const home = store.listPages().find((page) => page.slug === "home")!;
    publish(store, store.createTranslation({ sourceId: home.id, language: "en" }).translationId, "home", "Welcome");
    await expect(build(target)).rejects.toThrow(/\/en\//u);
  });
});

describe("strumenti del sito nella build", () => {
  it("SEO, articoli programmati, reindirizzamenti e ricerca arrivano nei file", async () => {
    const target = await project();
    const { store } = target.opened;
    const page = store.createPage({ title: "Chi", slug: "chi", status: "published" });
    store.setSeo(page.id, { title: "Per Google", description: "Una descrizione", image: "https://esempio.it/a.png" });
    store.updatePageMetadata(page.id, { title: "Chi", slug: "noi", status: "published" });
    const live = store.createPost({ title: "Oggi", slug: "oggi", status: "published", publishedAt: "2020-01-02T03:04:05Z" });
    const later = store.createPost({ title: "Domani", slug: "domani", status: "published", publishedAt: "2999-01-02T03:04:05Z" });
    store.setSiteSearch(true);
    const { read, page: at, files } = await build(target);
    const html = await at("/noi/");
    expect(html).toContain("<title>Per Google</title>");
    expect(html).toContain('<meta name="description" content="Una descrizione">');
    expect(html).toContain('<meta property="og:image" content="https://esempio.it/a.png">');
    expect(await read("_redirects")).toBe("/chi/ /noi/ 301\n");
    expect(await at("/chi/")).toContain('http-equiv="refresh"');
    expect(await at(`/blog/${live.slug}/`)).toContain("Oggi");
    expect(await at(`/blog/${later.slug}/`)).toBeNull();
    expect(await at("/cerca/")).toContain("/pagefind/pagefind.js");
    expect(await at(`/blog/${live.slug}/`)).toContain('"@type":"Article"');
    expect(await read("feed.xml")).toBeNull();
    expect((await files()).some((file) => file.startsWith("pagefind/"))).toBe(true);
  });

  it("con l'indirizzo del sito scrive il feed degli articoli", async () => {
    const target = await project();
    const { store } = target.opened;
    store.setSiteUrl("https://esempio.it");
    store.createPost({ title: "A & B", slug: "a-b", status: "published", publishedAt: "2024-05-06T07:08:09Z" });
    store.createPost({ title: "Domani", slug: "domani", status: "published", publishedAt: "2999-01-02T03:04:05Z" });
    const feed = await (await build(target)).read("feed.xml");
    expect(feed).toContain("<title>A &amp; B</title>");
    expect(feed).toContain("<link>https://esempio.it/blog/a-b/</link>");
    expect(feed).not.toContain("Domani");
  });
});
