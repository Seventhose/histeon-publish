import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildWxr, CmsProjectCatalog, parseWxr } from "@histos-publish/cms";
import { checkOutsideCopy, copyChangedSites, openSealedCopy, sealCopy } from "../src/automatic-copies.js";
import { importWordPressContent, spreadDesign } from "../src/cms-api.js";
import { checkBuiltSite } from "../src/site-check.js";
import { readWordPressSite, type JsonFetcher } from "../src/wordpress-site-read.js";

const roots: string[] = [];
const scratch = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-site-tools-"));
  roots.push(root);
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

describe("controllo del sito costruito", () => {
  it("trova link rotti, immagini pesanti, testi alternativi e descrizioni mancanti", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "chi"), { recursive: true });
    await writeFile(path.join(root, "index.html"), `<meta name="description" content="x"><a href="/chi/">ok</a><a href="/manca/">no</a><a href="#in">qui</a><img src="/a.png" alt=""><img src="/b.png" alt="Foto">`);
    await writeFile(path.join(root, "chi", "index.html"), `<a href="/">home</a>`);
    await writeFile(path.join(root, "404.html"), "non trovata");
    await writeFile(path.join(root, "a.png"), Buffer.alloc(2 * 1024 * 1024));
    await writeFile(path.join(root, "b.png"), Buffer.alloc(10));
    const check = await checkBuiltSite(root);
    expect(check.pages).toBe(3);
    expect(check.brokenLinks).toEqual([{ page: "/", link: "/manca/" }]);
    expect(check.heavyImages).toEqual([{ file: "/a.png", kilobytes: 2048 }]);
    expect(check.missingAlt).toEqual([]);
    expect(check.noDescription).toEqual(["/chi/"]);
  });

  it("trova titoli e descrizioni uguali su più pagine, e lascia stare i reindirizzamenti", async () => {
    const root = await scratch();
    const page = async (name: string, html: string): Promise<void> => {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, "index.html"), html);
    };
    await page("a", `<title>Uguale</title><meta name="description" content="Stessa">`);
    await page("b", `<title>Uguale</title><meta name="description" content="Stessa">`);
    await page("c", `<title>Altro</title><meta name="description" content="Diversa">`);
    await page("d", `<title>Uguale</title><meta http-equiv="refresh" content="0; url=/a/">`);
    const check = await checkBuiltSite(root);
    expect(check.sameTitle).toEqual([{ text: "Uguale", pages: ["/a/", "/b/"] }]);
    expect(check.sameDescription).toEqual([{ text: "Stessa", pages: ["/a/", "/b/"] }]);
  });
});

describe("esportazione per WordPress", () => {
  it("il file si rilegge: contenuti, termini, stati e un testo che contiene la fine del CDATA", () => {
    const xml = buildWxr({ title: "Sito & co", link: "https://esempio.it", language: "it-IT", terms: [{ kind: "category", slug: "notizie", name: "Notizie", parent: "" }, { kind: "post_tag", slug: "libri", name: "Libri", parent: "" }], items: [
      { id: 1, type: "post", title: "Primo", slug: "primo", status: "published", date: "2024-05-06T07:08:09Z", excerpt: "Breve", html: "<p>Ciao ]]> mondo</p>", terms: [{ kind: "category", slug: "notizie", name: "Notizie" }] },
      { id: 2, type: "page", title: "Chi", slug: "chi", status: "draft", date: null, excerpt: "", html: "<p>Noi</p>", terms: [] },
    ] });
    const file = parseWxr(xml);
    expect(file).toMatchObject({ title: "Sito & co", language: "it-IT" });
    expect(file.terms.map((term) => term.slug)).toEqual(["notizie", "libri"]);
    expect(file.items[0]).toMatchObject({ type: "post", slug: "primo", status: "publish", date: "2024-05-06T07:08:09Z", content: "<p>Ciao ]]> mondo</p>", terms: [{ kind: "category", slug: "notizie" }] });
    expect(file.items[1]).toMatchObject({ type: "page", status: "draft", date: null });
  });
});

describe("lettura di un WordPress dal suo indirizzo", () => {
  const site: Record<string, unknown> = {
    "https://esempio.it/wp-json/": { name: "Il sito &amp; altro", namespaces: ["wp/v2"] },
    "https://esempio.it/wp-json/wp/v2/categories?per_page=100&page=1": [{ id: 2, slug: "notizie", name: "Notizie", parent: 0 }, { id: 3, slug: "locali", name: "Locali", parent: 2 }],
    "https://esempio.it/wp-json/wp/v2/tags?per_page=100&page=1": [{ id: 5, slug: "libri", name: "Libri" }],
    "https://esempio.it/wp-json/wp/v2/pages?_embed=1&per_page=100&page=1": [{ id: 7, slug: "chi", title: { rendered: "Chi siamo" }, excerpt: { rendered: "" }, content: { rendered: "<p>Noi</p>" }, date_gmt: "2024-01-02T03:04:05" }],
    "https://esempio.it/wp-json/wp/v2/posts?_embed=1&per_page=100&page=1": [{ id: 8, slug: "primo", title: { rendered: "Primo &#8211; bis" }, excerpt: { rendered: "<p>Breve</p>" }, content: { rendered: "<p>Ciao</p>" }, date_gmt: "2024-05-06T07:08:09", categories: [3], tags: [5], yoast_head_json: { title: "Per Google", description: "Descrizione" }, _embedded: { "wp:featuredmedia": [{ id: 9, source_url: "https://esempio.it/a.png", title: { rendered: "Foto" } }] } }],
  };
  const fetchJson: JsonFetcher = async (url) => site[url] ?? null;

  it("porta pagine, articoli, termini, immagine in evidenza e SEO, e diventa un sito", async () => {
    const file = await readWordPressSite({ url: "esempio.it/", fetchJson });
    expect(file.title).toBe("Il sito & altro");
    expect(file.terms.find((term) => term.slug === "locali")).toMatchObject({ parent: "notizie" });
    const catalog = new CmsProjectCatalog(path.join(await scratch(), "publish"));
    await catalog.initialize();
    const report = await importWordPressContent({ catalog, file, fetchAsset: async () => png });
    expect(report).toMatchObject({ posts: 1, pages: 1, terms: 3, images: { saved: 1, failed: 0 }, failed: [] });
    const opened = await catalog.openProject(report.projectId);
    const post = opened!.store.listPosts()[0]!;
    expect(post).toMatchObject({ title: "Primo – bis", slug: "primo", excerpt: "Breve", status: "published" });
    expect(opened!.store.getSeo(post.id)).toMatchObject({ title: "Per Google", description: "Descrizione" });
    // Doc 23 items 119 and 177: the featured image is the post's image, and is not put again at the top of its text.
    expect(post.imageAssetId).toBe(opened!.store.listAssets()[0]?.id);
    expect(opened!.store.getRevision(post.headRevision)?.content).not.toContain("__cms-media");
    expect(report.featuredImages).toEqual({ posts: 1, removedFromText: [] });
    opened!.store.close();
  });

  it("immagine in evidenza senza doppioni: si toglie solo il primo blocco, e solo se è la stessa immagine (doc 23, voce 177)", async () => {
    const other = Uint8Array.from([...png, 1]);
    const bytes: Record<string, Uint8Array> = { "https://esempio.it/foto.png": png, "https://cdn.esempio.it/copia-foto.png": png, "https://esempio.it/altra.png": other };
    const item = (id: string, type: string, title: string, content: string, thumbnailId = "11") => ({ id, type, title, slug: title.toLowerCase().replaceAll(" ", "-"), status: "publish", date: "2024-05-06T07:08:09Z", excerpt: "", content, terms: [], attachmentUrl: "", thumbnailId });
    const foto = `<img src="https://esempio.it/foto.png" alt="Il forno a legna">`;
    const file = {
      title: "Pizzeria", link: "https://esempio.it", language: "it-IT", terms: [],
      items: [
        { ...item("11", "attachment", "foto", "", ""), attachmentUrl: "https://esempio.it/foto.png" },
        item("1", "post", "Primo blocco", `<p>${foto}</p><p>Il testo.</p>`),
        item("2", "post", "Dopo il testo", `<p>Il testo.</p><p>${foto}</p>`),
        item("3", "post", "Altra immagine", `<p><img src="https://esempio.it/altra.png" alt=""></p><p>Il testo.</p>`),
        item("4", "post", "Con didascalia", `<figure>${foto}<figcaption>La sala</figcaption></figure><p>Il testo.</p>`),
        item("5", "post", "Stesso file", `<p><img src="https://cdn.esempio.it/copia-foto.png" alt=""></p><p>Il testo.</p>`),
        item("6", "page", "Chi siamo", "<p>Noi.</p>"),
      ],
    };
    const catalog = new CmsProjectCatalog(path.join(await scratch(), "publish"));
    await catalog.initialize();
    const report = await importWordPressContent({ catalog, file, fetchAsset: async (url) => bytes[url] ?? png });
    expect(report.failed).toEqual([]);
    expect(report.featuredImages).toEqual({ posts: 5, removedFromText: ["Primo blocco", "Stesso file"] });
    const opened = (await catalog.openProject(report.projectId))!;
    try {
      const assets = opened.store.listAssets();
      const photo = assets.find((asset) => asset.filename === "foto.png")!;
      // The text's description of the image it took away stays on the media, where `page.image` reads it.
      expect(photo.alt).toBe("Il forno a legna");
      const images = (title: string): number => {
        const post = opened.store.listPosts().find((entry) => entry.title === title)!;
        expect(post.imageAssetId).toBe(photo.id);
        return (opened.store.getRevision(post.headRevision)?.content.match(/__cms-media\//gu) ?? []).length;
      };
      expect(images("Primo blocco")).toBe(0);
      expect(images("Stesso file")).toBe(0);
      expect(images("Dopo il testo")).toBe(1);
      expect(images("Altra immagine")).toBe(1);
      expect(images("Con didascalia")).toBe(1);
      // A page has no image of its own: the featured image still opens its text.
      const page = opened.store.listPages().find((entry) => entry.title === "Chi siamo")!;
      expect(opened.store.getRevision(page.headRevision)?.content).toContain("__cms-media");
    } finally {
      opened.store.close();
    }
  });

  it("un sito senza le API lo dice e propone il file", async () => {
    await expect(readWordPressSite({ url: "https://altro.it", fetchJson: async () => null })).rejects.toThrow("Strumenti → Esporta");
  });
});

describe("il magazzino del sito", () => {
  const project = async () => {
    const catalog = new CmsProjectCatalog(path.join(await scratch(), "publish"));
    await catalog.initialize();
    const opened = await catalog.createProject("Prova");
    return { catalog, ...opened };
  };

  it("SEO: si salva, si svuota e rifiuta un'immagine da chissà dove", async () => {
    const { store } = await project();
    const page = store.listPages()[0]!;
    expect(store.setSeo(page.id, { title: " Titolo  lungo ", description: "Testo" })).toMatchObject({ title: "Titolo lungo", description: "Testo" });
    expect(store.getSeo(page.id).title).toBe("Titolo lungo");
    expect(() => store.setSeo(page.id, { image: "javascript:alert(1)" })).toThrow("immagine");
    store.setSeo(page.id, {});
    expect(store.getSeo(page.id)).toEqual({ title: "", description: "", image: "" });
    store.close();
  });

  it("un indirizzo cambiato lascia un reindirizzamento, e una catena diventa un passo", async () => {
    const { store } = await project();
    const page = store.createPage({ title: "Chi", slug: "chi", status: "published" });
    store.updatePageMetadata(page.id, { title: "Chi", slug: "noi", status: "published" });
    store.updatePageMetadata(page.id, { title: "Chi", slug: "squadra", status: "published" });
    expect(store.getRedirects()).toEqual([{ from: "/chi/", to: "/squadra/" }, { from: "/noi/", to: "/squadra/" }]);
    const draft = store.createPage({ title: "Bozza", slug: "bozza" });
    store.updatePageMetadata(draft.id, { title: "Bozza", slug: "altra", status: "draft" });
    expect(store.getRedirects()).toHaveLength(2);
    expect(() => store.setRedirects([{ from: "/a/", to: "https://altro.it" }])).toThrow("non è valido");
    store.close();
  });

  it("un cambio di indirizzo rifiutato per uno slug già usato non lascia reindirizzamenti", async () => {
    const { store } = await project();
    store.createPage({ title: "Presa", slug: "presa", status: "published" });
    const page = store.createPage({ title: "Chi", slug: "chi", status: "published" });
    expect(() => store.updatePageMetadata(page.id, { title: "Chi", slug: "presa", status: "published" })).toThrow("Esiste già una pagina");
    store.createPost({ title: "Preso", slug: "preso", status: "published" });
    const post = store.createPost({ title: "Notizia", slug: "notizia", status: "published" });
    expect(() => store.updatePostMetadata(post.id, { title: "Notizia", slug: "preso", status: "published" })).toThrow("Esiste già un articolo");
    expect(store.getRedirects()).toEqual([]);
    expect(store.getEntityById(page.id)?.slug).toBe("chi");
    store.close();
  });

  it("SEO, reindirizzamenti e cartelle dei media guasti fuori dall'app si leggono come vuoti", async () => {
    const { project: created, store } = await project();
    const page = store.listPages()[0]!;
    const database = new DatabaseSync(path.join(created.directory, "content.sqlite"));
    const put = database.prepare("INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const key of [`seo.${page.id}`, "site.redirects", "media.folders"]) put.run(key, "{non json");
    database.close();
    expect(store.getSeo(page.id)).toEqual({ title: "", description: "", image: "" });
    expect(store.getRedirects()).toEqual([]);
    expect(store.getMediaFolders()).toEqual({});
    store.close();
  });

  it("le immagini usate si riconoscono e una categoria va su più articoli insieme", async () => {
    const { store } = await project();
    const used = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "a.png" });
    const unused = store.saveAsset({ bytes: Uint8Array.from([...png, 0]), mimeType: "image/png", filename: "b.png" });
    store.createPage({ title: "Foto", slug: "foto", content: `<!-- wp:xb/element {"uid":"aaaaaaaaaa","tag":"img","attributes":{"src":"/__cms-media/p/${used.id}","alt":""}} /-->` });
    expect(store.usedAssetIds().has(used.id)).toBe(true);
    expect(store.usedAssetIds().has(unused.id)).toBe(false);
    store.content.saveTaxonomy({ key: "category", label: "Categorie", types: ["post"] });
    const term = store.content.saveTerm({ taxonomyKey: "category", slug: "n", label: "N" });
    if (term.status !== "saved") throw new Error("termine");
    const ids = [store.createPost({ title: "A", slug: "a" }).id, store.createPost({ title: "B", slug: "b" }).id];
    expect(store.bulkAddTerm(ids, "category", term.term.id)).toBe(2);
    expect(store.getPostTermIds(ids[1]!).category).toEqual([term.term.id]);
    store.close();
  });
});

describe("copie automatiche", () => {
  it("una copia al giorno dei siti cambiati, le ultime tre", async () => {
    const root = await scratch();
    const catalog = new CmsProjectCatalog(path.join(root, "publish"));
    await catalog.initialize();
    const opened = await catalog.createProject("Copie");
    opened.store.close();
    const folder = path.join(root, "copie");
    expect(await copyChangedSites({ catalog, folder, now: new Date() })).toBe(1);
    expect(await copyChangedSites({ catalog, folder, now: new Date() })).toBe(0);
    const inside = path.join(folder, opened.project.id);
    expect(await readdir(inside)).toHaveLength(1);
    for (const day of ["2020-01-01", "2020-01-02", "2020-01-03"]) await writeFile(path.join(inside, `${day}.histosproject`), "x");
    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await catalog.saveManifest(opened.project);
    await copyChangedSites({ catalog, folder, now: later });
    expect((await readdir(inside)).length).toBeLessThanOrEqual(4);
  });

  it("un giorno in cui la copia non riesce non cancella le copie vecchie", async () => {
    const root = await scratch();
    const catalog = new CmsProjectCatalog(path.join(root, "publish"));
    await catalog.initialize();
    const opened = await catalog.createProject("Copie");
    opened.store.close();
    const folder = path.join(root, "copie");
    const inside = path.join(folder, opened.project.id);
    await mkdir(inside, { recursive: true });
    const old = ["2020-01-01.histosproject", "2020-01-02.histosproject", "2020-01-03.histosproject"];
    for (const name of old) await writeFile(path.join(inside, name), "x");
    // A store that cannot be read: the archive of the day fails.
    const busy = Object.assign(Object.create(catalog) as CmsProjectCatalog, {
      openProject: async (id: string) => {
        const real = await catalog.openProject(id);
        if (!real) return real;
        const store = new Proxy(real.store, { get: (target, key) => (key === "close" ? target.close.bind(target) : (() => { throw new Error("occupato"); })) });
        return { ...real, store };
      },
    });
    expect(await copyChangedSites({ catalog: busy, folder, now: new Date() })).toBe(0);
    expect((await readdir(inside)).sort()).toEqual(old);
  });
});

describe("ricerca nel sito", () => {
  it("si accende e si spegne per progetto", async () => {
    const catalog = new CmsProjectCatalog(path.join(await scratch(), "publish"));
    await catalog.initialize();
    const { store } = await catalog.createProject("Ricerca");
    expect(store.getSiteSearch()).toBe(false);
    store.setSiteSearch(true);
    expect(store.getSiteSearch()).toBe(true);
    expect(store.adminIndex().siteSearch).toBe(true);
    store.setSiteSearch(false);
    expect(store.getSiteSearch()).toBe(false);
    store.close();
  });
});

describe("stile portato su altri siti", () => {
  it("dice cosa cambia, salva una copia e tocca solo lo stile", async () => {
    const root = await scratch();
    const catalog = new CmsProjectCatalog(path.join(root, "publish"));
    await catalog.initialize();
    const look = async (store: Awaited<ReturnType<typeof catalog.createProject>>["store"], design: Record<string, unknown>): Promise<void> => {
      const styles = store.getStyles()!;
      const head = store.getHead(styles.id)!;
      store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({ ...JSON.parse(head.content || "{}"), design }) });
    };
    const from = await catalog.createProject("Riferimento");
    await look(from.store, { primary: "#123456" });
    from.store.close();
    const to = await catalog.createProject("Variante");
    const page = to.store.createPage({ title: "Resta", slug: "resta", status: "published" });
    const pageHead = page.headRevision;
    to.store.close();

    const preview = await spreadDesign({ catalog, dataDirectory: root, from: from.project.id, to: [from.project.id, to.project.id], apply: false });
    expect(preview.results).toHaveLength(1);
    expect(preview.results[0]).toMatchObject({ name: "Variante", changes: ["primary"], applied: false });
    await expect(readdir(path.join(root, "backups")).catch(() => [])).resolves.toEqual([]);

    const done = await spreadDesign({ catalog, dataDirectory: root, from: from.project.id, to: [to.project.id], apply: true });
    expect(done.results[0]?.applied).toBe(true);
    expect(await readdir(path.join(root, "backups", "prima-dello-stile", to.project.id))).toHaveLength(1);
    const after = await catalog.openProject(to.project.id);
    const styles = after!.store.getStyles()!;
    expect(JSON.parse(after!.store.getHead(styles.id)!.content).design).toEqual({ primary: "#123456" });
    expect(after!.store.listPages().find((entry) => entry.slug === "resta")?.headRevision).toBe(pageHead);
    after!.store.close();
    expect((await spreadDesign({ catalog, dataDirectory: root, from: from.project.id, to: [to.project.id], apply: false })).results[0]?.changes).toEqual([]);
  });
});

describe("copie cifrate fuori dal computer", () => {
  it("si aprono solo con la frase, e un file alterato si rifiuta", async () => {
    const sealed = await sealCopy(Buffer.from("il mio sito"), "una frase lunga abbastanza");
    expect(sealed.includes(Buffer.from("il mio sito"))).toBe(false);
    expect((await openSealedCopy(sealed, "una frase lunga abbastanza")).toString()).toBe("il mio sito");
    await expect(openSealedCopy(sealed, "un'altra frase qualunque")).rejects.toThrow("non apre");
    const altered = Buffer.from(sealed);
    altered[altered.byteLength - 1] = (altered[altered.byteLength - 1] ?? 0) ^ 1;
    await expect(openSealedCopy(altered, "una frase lunga abbastanza")).rejects.toThrow("alterato");
    await expect(openSealedCopy(Buffer.from("altro"), "x")).rejects.toThrow("copia cifrata");
  });

  it("escono ogni giorno nella cartella scelta, solo cifrate, e ne restano tre", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-outside-"));
    const catalog = new CmsProjectCatalog(path.join(root, "data"));
    await catalog.initialize();
    const opened = await catalog.createProject("Sito");
    opened.store.close();
    const outside = { folder: path.join(root, "pcloud"), passphrase: "una frase lunga abbastanza" };
    await mkdir(outside.folder);
    for (const day of ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]) {
      const again = (await catalog.openProject(opened.project.id))!;
      again.store.createPost({ title: day, slug: day, status: "published" });
      again.store.close();
      await copyChangedSites({ catalog, folder: path.join(root, "copies"), now: new Date(`${day}T10:00:00Z`), outside });
    }
    const away = path.join(outside.folder, "histos-publish", opened.project.id);
    const names = await readdir(away);
    expect(names).toEqual(["2026-10-29.histosproject.sealed", "2026-10-30.histosproject.sealed", "2026-10-31.histosproject.sealed"]);
    await expect(checkOutsideCopy(outside)).resolves.toBe("ok");
    await expect(checkOutsideCopy({ ...outside, passphrase: "una frase che non è quella" })).resolves.toBe("wrong");
    await expect(checkOutsideCopy({ ...outside, folder: path.join(root, "vuota") })).resolves.toBe("none");
    await rm(root, { recursive: true, force: true });
  });
});
