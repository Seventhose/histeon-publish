import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStaticPageProfile } from "../src/page-transfer.js";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { canonicalProjectLanguage, documentAddress, languageName, normalizeProjectLanguages, pageAddress, postAddress } from "../src/translations.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-translations-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  const opened = await catalog.createProject("Lingue");
  opened.store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  return { ...opened, catalog };
}

describe("lingue del progetto", () => {
  it("accetta codici BCP 47 e rifiuta quelli che sarebbero cartelle del sito", () => {
    expect(canonicalProjectLanguage("pt-br")).toBe("pt-BR");
    for (const bad of ["media", "blog", "pagefind", "", "../x", "en/../x", "a".repeat(40), 3]) expect(() => canonicalProjectLanguage(bad)).toThrow(TypeError);
  });

  it("dà il nome della lingua nella lingua stessa", () => {
    expect(languageName("de")).toBe("Deutsch");
    expect(languageName("it-IT")).toBe("Italiano");
  });

  it("toglie la lingua del sito, rifiuta i doppioni, pulisce le etichette", () => {
    expect(normalizeProjectLanguages({ languages: [{ code: "it-it" }, { code: "en", label: "<b>Inglese</b>" }] }, "it-IT")).toEqual([{ code: "en", label: "b Inglese /b" }]);
    expect(() => normalizeProjectLanguages([{ code: "en" }, { code: "EN" }], "it-IT")).toThrow("ripetuta");
    expect(() => normalizeProjectLanguages(Array.from({ length: 31 }, (_, index) => ({ code: `a${String.fromCharCode(97 + index % 26)}${String.fromCharCode(97 + Math.floor(index / 26))}` })), "it-IT")).toThrow("al massimo");
  });

  it("calcola gli indirizzi con il prefisso solo fuori dalla lingua del sito", () => {
    expect(pageAddress({ slug: "home", locale: null }, "it-IT")).toBe("/");
    expect(pageAddress({ slug: "home", locale: "en" }, "it-IT")).toBe("/en/");
    expect(pageAddress({ slug: "about", locale: "pt-BR" }, "it-IT")).toBe("/pt-br/about/");
    expect(pageAddress({ slug: "chi-siamo", locale: "it-IT" }, "it-IT")).toBe("/chi-siamo/");
    expect(postAddress({ slug: "ciao", locale: null }, "it-IT")).toBe("/blog/ciao/");
    expect(documentAddress({ slug: "hello", locale: "en", documentType: "post" }, "it-IT")).toBe("/en/blog/hello/");
  });

  it("salva l'elenco, e una lingua con contenuti non si toglie", async () => {
    const { store } = await project();
    expect(store.getProjectLanguages()).toEqual({ defaultLanguage: { code: "it-IT", label: "Italiano" }, languages: [] });
    store.setProjectLanguages([{ code: "en" }]);
    expect(store.getProjectLanguages().languages).toEqual([{ code: "en", label: "English" }]);
    const page = store.createPage({ title: "Chi siamo", slug: "chi-siamo" });
    store.createTranslation({ sourceId: page.id, language: "en", slug: "about", title: "About" });
    expect(() => store.setProjectLanguages([])).toThrow("ha ancora dei contenuti");
    expect(store.getProjectLanguages().languages).toHaveLength(1);
    store.close();
  });
});

describe("traduzioni", () => {
  it("crea la bozza di una pagina con lo stesso slug in un'altra lingua, contenuto e script compresi", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    store.setDocumentScript(page.id, "console.log(1);");
    const link = store.createTranslation({ sourceId: page.id, language: "en" });
    const translated = store.getEntityById(link.translationId)!;
    expect(translated).toMatchObject({ slug: "chi-siamo", locale: "en", status: "draft", title: "Chi siamo" });
    expect(store.getHead(translated.id)!.content).toBe(store.getHead(page.id)!.content);
    expect(store.getDocumentScript(translated.id)).toBe("console.log(1);");
    expect(store.listPages().filter((item) => item.slug === "chi-siamo").map((item) => item.locale)).toEqual([null, "en"]);
    expect(() => store.createTranslation({ sourceId: page.id, language: "en" })).toThrow("esiste già");
    expect(() => store.createPage({ title: "Doppia", slug: "chi-siamo" })).toThrow("slug");
    store.close();
  });

  it("rifiuta lingue fuori dal progetto e la traduzione di una traduzione", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }, { code: "de" }]);
    const page = store.createPage({ title: "Prima", slug: "prima" });
    const link = store.createTranslation({ sourceId: page.id, language: "en" });
    expect(() => store.createTranslation({ sourceId: link.translationId, language: "de" })).toThrow("già una traduzione");
    expect(() => store.createTranslation({ sourceId: page.id, language: "fr" })).toThrow("non è fra quelle");
    store.close();
  });

  it("copia articoli con termini e record con campi, sempre bozze", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const post = store.createPost({ title: "Ciao", slug: "ciao", status: "published", excerpt: "Riassunto" });
    const postLink = store.createTranslation({ sourceId: post.id, language: "en", slug: "hello", title: "Hello" });
    expect(store.getEntityById(postLink.translationId)).toMatchObject({ documentType: "post", slug: "hello", locale: "en", status: "draft", excerpt: "Riassunto", publishedAt: null });
    store.content.saveType({ key: "opera", label: "Opere", fields: [{ key: "autore", label: "Autore", type: "text", required: false, public: true, multiple: false }] });
    const saved = store.content.saveRecord({ typeKey: "opera", title: "Opera", slug: "opera", status: "published", values: { autore: "Dante" } });
    if (saved.status !== "saved") throw new Error("record");
    const link = store.createTranslation({ sourceId: saved.record.id, language: "en" });
    expect(link.kind).toBe("record");
    expect(store.content.getRecordById(link.translationId)).toMatchObject({ slug: "opera", locale: "en", status: "draft", values: { autore: "Dante" } });
    store.close();
  });

  it("una versione diventa da aggiornare quando cambiano i testi dell'originale, non il suo stato", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Uno", slug: "uno", status: "published" });
    const link = store.createTranslation({ sourceId: page.id, language: "en", slug: "one" });
    expect(store.translationState(link)).toBe("draft");
    store.updatePageMetadata(link.translationId, { title: "One", slug: "one", status: "published" });
    expect(store.translationState(store.getTranslation(link.translationId)!)).toBe("published");
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.updatePageMetadata(page.id, { title: "Uno", slug: "uno", status: "draft" });
    expect(store.translationState(store.getTranslation(link.translationId)!)).toBe("published");
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.updatePageMetadata(page.id, { title: "Due", slug: "uno", status: "published" });
    expect(store.translationState(store.getTranslation(link.translationId)!)).toBe("stale");
    store.setTranslationMode(link.translationId, "independent");
    expect(store.translationState(store.getTranslation(link.translationId)!)).toBe("published");
    expect(store.translationState(store.setTranslationMode(link.translationId, "follow"))).toBe("published");
    store.close();
  });

  it("una pagina vuota è indipendente; il collegamento sposta una pagina esistente nella lingua", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }, { code: "de" }]);
    const page = store.createPage({ title: "Uno", slug: "uno" });
    const empty = store.createTranslation({ sourceId: page.id, language: "de", mode: "empty" });
    expect(empty.mode).toBe("independent");
    expect(store.getHead(empty.translationId)!.content).not.toBe("");
    const other = store.createPage({ title: "One", slug: "one" });
    const linked = store.createTranslation({ sourceId: page.id, language: "en", mode: "link", linkId: other.id });
    expect(linked.translationId).toBe(other.id);
    expect(store.getEntityById(other.id)!.locale).toBe("en");
    expect(() => store.createTranslation({ sourceId: page.id, language: "en", mode: "link", linkId: page.id })).toThrow();
    store.close();
  });

  it("togliendo il legame il contenuto resta, per conto suo", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Uno", slug: "uno" });
    const link = store.createTranslation({ sourceId: page.id, language: "en" });
    store.removeTranslationLink(link.translationId);
    expect(store.listTranslations(page.id)).toEqual([]);
    expect(store.getEntityById(link.translationId)).not.toBeNull();
    store.close();
  });

  it("nel profilo di trasferimento una traduzione ha uno slug suo, unico nel sito", async () => {
    const { store, project: info } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Uno", slug: "uno" });
    const post = store.createPost({ title: "Ciao", slug: "ciao" });
    const pageLink = store.createTranslation({ sourceId: page.id, language: "en" });
    const postLink = store.createTranslation({ sourceId: post.id, language: "en" });
    const { profile } = await createStaticPageProfile(info, store);
    const slug = (id: string) => profile.entities.find((entity) => entity.id === id)?.payload.slug;
    expect([slug(page.id), slug(pageLink.translationId), slug(post.id), slug(postLink.translationId)]).toEqual(["uno", "uno-en", "ciao", "ciao-en"]);
    store.close();
  });

  it("le lingue cambiano la revisione del progetto solo quando ci sono", async () => {
    const { store } = await project();
    const before = store.getProjectRevision();
    expect(store.getProjectRevision()).toBe(before);
    store.setProjectLanguages([{ code: "en" }]);
    expect(store.getProjectRevision()).not.toBe(before);
    store.close();
  });
});

describe("difetti della revisione", () => {
  it("un record con termini si traduce, si pubblica in blocco e si riallinea", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    store.content.saveType({ key: "opera", label: "Opere", fields: [{ key: "trama", label: "Trama", type: "text", required: false, public: true, multiple: false }, { key: "anno", label: "Anno", type: "integer", required: false, public: true, multiple: false }, { key: "nota", label: "Nota", type: "text", required: false, public: true, multiple: false }] });
    store.content.saveTaxonomy({ key: "genere", label: "Generi", types: ["opera"] });
    const term = store.content.saveTerm({ taxonomyKey: "genere", label: "Epica", slug: "epica" });
    if (term.status !== "saved") throw new Error("termine");
    const saved = store.content.saveRecord({ typeKey: "opera", title: "Opera", slug: "opera", status: "published", values: { trama: "Una storia", anno: 1300, nota: "Vecchia" }, terms: { genere: [term.term.alias] } });
    if (saved.status !== "saved") throw new Error("record");
    const link = store.createTranslation({ sourceId: saved.record.id, language: "en" });
    expect(store.content.getRecordById(link.translationId)!.terms.genere?.[0]?.slug).toBe("epica");
    expect(store.bulkSetStatus([saved.record.id], "draft")).toBe(1);
    const current = store.content.getRecordById(saved.record.id)!;
    store.content.saveRecord({ id: current.id, typeKey: "opera", title: "Opera", slug: "opera", status: "draft", values: { trama: "Una storia", anno: 1321 }, terms: { genere: [term.term.alias] }, expectedHead: current.headRevision });
    store.updateTranslationDraft(link.translationId);
    expect(store.content.getRecordById(link.translationId)!.values).toMatchObject({ anno: 1321 });
    expect(store.content.getRecordById(link.translationId)!.values.nota).toBeUndefined();
    store.close();
  });

  it("leggere i testi da tradurre non cambia la revisione del progetto", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Uno", slug: "uno", status: "published" });
    const before = store.getProjectRevision();
    store.translationSource(page.id, "en");
    store.translationSource(page.id, "en");
    expect(store.getProjectRevision()).toBe(before);
    store.close();
  });

  it("una versione rimasta indietro non insegna alla memoria", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Primo", slug: "uno", status: "published" });
    const link = store.createTranslation({ sourceId: page.id, language: "en" });
    store.updatePageMetadata(link.translationId, { title: "First", slug: "uno", status: "published" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.updatePageMetadata(page.id, { title: "Secondo", slug: "uno", status: "published" });
    expect(store.translationSource(page.id, "en").memory).toEqual({});
    store.close();
  });

  it("una pagina con struttura sua non torna a seguire l'originale, e nessuno traduce sé stesso", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    const page = store.createPage({ title: "Uno", slug: "uno", content: serializeXb(parse('<h1 class="a">Ciao</h1>').blocks) });
    const link = store.createTranslation({ sourceId: page.id, language: "en", mode: "empty" });
    expect(() => store.setTranslationMode(link.translationId, "follow")).toThrow("struttura sua");
    const other = store.createPage({ title: "Due", slug: "due" });
    expect(() => store.createTranslation({ sourceId: other.id, language: "en", mode: "link", linkId: other.id })).toThrow("sé stesso");
    store.close();
  });

  it("una lingua mai elencata non blocca le altre, e con più lingue i record fermano il cambio di lingua del sito", async () => {
    const { store } = await project();
    store.content.saveType({ key: "opera", label: "Opere", fields: [] });
    store.content.saveRecord({ typeKey: "opera", title: "Oeuvre", slug: "oeuvre", locale: "fr", status: "published" });
    store.content.saveRecord({ typeKey: "opera", title: "Opera", slug: "opera", status: "published" });
    expect(store.setProjectLanguages([{ code: "en" }]).languages).toHaveLength(1);
    expect(() => store.setRenderSettings({ locale: "de-DE", timeZone: "Europe/Rome" })).toThrow("record");
    store.close();
  });
});

describe("migrazione allo schema 5", () => {
  it("un progetto alla versione 4 si apre, tiene i dati e prende le tabelle nuove", async () => {
    const { store, project: info, catalog } = await project();
    const page = store.createPage({ title: "Vecchia", slug: "vecchia" });
    store.close();
    const file = path.join(info.directory, "content.sqlite");
    const old = new DatabaseSync(file);
    old.exec("DROP INDEX entities_document_locale; ALTER TABLE entities DROP COLUMN locale; DROP TABLE cms_translations; DROP TABLE cms_strings; DROP TABLE cms_translation_memory; PRAGMA user_version = 4;");
    old.close();
    const copy = `${file}.check`;
    await copyFile(file, copy);
    const opened = await catalog.openProject(info.id);
    expect(opened!.store.getEntityById(page.id)).toMatchObject({ slug: "vecchia", locale: null });
    expect(opened!.store.listTranslations()).toEqual([]);
    opened!.store.close();
    expect((await catalog.listProjectsWithProblems()).unavailable).toEqual([]);
  });

  it("una pagina tradotta elenca gli originali finché la loro versione non è online", async () => {
    const { store } = await project();
    store.setProjectLanguages([{ code: "en" }]);
    store.content.saveType({ key: "partner", label: "Partner", fields: [] });
    const saved = (title: string) => {
      const answer = store.content.saveRecord({ typeKey: "partner", title, slug: title.toLowerCase(), status: "published", publishedAt: "2026-01-01T00:00:00Z" });
      if (answer.status !== "saved") throw new Error("non salvato");
      return answer.record;
    };
    const uno = saved("Uno");
    saved("Due");
    store.content.saveQueryPreset({ key: "tutti", label: "Tutti", typeKey: "partner", limit: 10, orderBy: "title", order: "asc", expectedHead: null });
    const shown = () => store.content.resolveQueryPreset("tutti", {}, "en").map((item) => [item.title, item.url]);
    expect(shown()).toEqual([["Due", "/partner/due/"], ["Uno", "/partner/uno/"]]);

    const version = store.createTranslation({ sourceId: uno.id, language: "en", slug: "one", title: "One" });
    expect(shown()).toEqual([["Due", "/partner/due/"], ["Uno", "/partner/uno/"]]);
    const record = store.content.getRecordById(version.translationId)!;
    expect(store.content.saveRecord({ id: record.id, typeKey: "partner", title: "One", slug: "one", locale: record.locale, status: "published", publishedAt: "2026-01-01T00:00:00Z", expectedHead: record.headRevision } as never).status).toBe("saved");
    expect(shown()).toEqual([["Due", "/partner/due/"], ["One", "/en/partner/one/"]]);
    expect(store.content.resolveQueryPreset("tutti", { locale: "en" }).map((item) => item.title)).toEqual(["One"]);
  });
});
