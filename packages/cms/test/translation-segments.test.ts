import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { localizeHtml, normalizeStringSource } from "../src/localize-html.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { applySegments, assertSegmentText, documentSegments, staticTexts } from "../src/translation-segments.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-segments-"));
  roots.push(root);
  const { store } = await new CmsProjectCatalog(root).createProject("Segmenti");
  store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  store.setProjectLanguages([{ code: "en" }]);
  return store;
}

const documentOf = (source: string) => serializeXb(parse(source).blocks);
const page = documentOf('<h1 class="titolo">Benvenuti</h1><p class="testo">Ciao {page.title}</p><img class="foto" src="/a.png" alt="Una foto">');

describe("segmenti", () => {
  it("elenca testi e attributi visibili, non le espressioni sole né i numeri", () => {
    const content = documentOf('<h1 class="a">Ciao</h1><p class="b">{page.title}</p><p class="c">2026</p><img class="d" src="/a.png" alt="Foto">');
    expect(documentSegments(content).map((segment) => segment.text)).toEqual(["Ciao", "Foto"]);
  });

  it("delle prop prende solo quelle che il componente dichiara come testo", () => {
    const content = documentOf('<Card title="Ciao mondo" href="/contatti/" />');
    expect(documentSegments(content, (_ref, name) => name === "title").map((segment) => segment.text)).toEqual(["Ciao mondo"]);
  });

  it("rimette i testi nella stessa struttura, e nient'altro cambia", () => {
    const segments = documentSegments(page);
    const texts = new Map(segments.map((segment) => [segment.id, segment.text === "Benvenuti" ? "Welcome" : segment.text]));
    const translated = applySegments(page, texts);
    expect(translated).toContain("Welcome");
    expect(translated.replace("Welcome", "Benvenuti")).toBe(page);
  });

  it("rifiuta un testo con altri tag, altre espressioni, parentesi angolari o controlli", () => {
    expect(assertSegmentText("Ciao {page.title}", "Hello {page.title}", "x")).toBe("Hello {page.title}");
    expect(() => assertSegmentText("Ciao {page.title}", "Hello", "x")).toThrow("espressioni");
    expect(() => assertSegmentText("Ciao", "Hello {site.secret}", "x")).toThrow("espressioni");
    expect(() => assertSegmentText("Ciao", "<script>alert(1)</script>", "x")).toThrow("tag");
    expect(() => assertSegmentText("<b>Ciao</b>", '<b onclick="x()">Hi</b>', "x")).toThrow("tag");
    expect(assertSegmentText("<b>Ciao</b>", "<b>Hi</b>", "x")).toBe("<b>Hi</b>");
    expect(() => assertSegmentText("Ciao", "a < b", "x")).toThrow("angolare");
    expect(() => assertSegmentText("Ciao", "a\u0007b", "x")).toThrow("controllo");
    expect(() => assertSegmentText("Ciao", "", "x")).toThrow("vuoto");
    expect(() => assertSegmentText("Ciao", "a".repeat(70_000), "x")).toThrow("64 kB");
  });

  it("dà i testi statici di un componente, senza quelli con espressioni", () => {
    expect(staticTexts(documentOf('<p class="a">Tutti i diritti riservati</p><p class="b">Ciao {page.title}</p>'))).toEqual(["Tutti i diritti riservati"]);
  });
});

describe("testi con tag in linea", () => {
  it("ne fa una stringa per ogni pezzo di testo, come arrivano alla pagina", () => {
    expect(staticTexts(serializeXb([{ name: "xb/text", attrs: { uid: "aaaaaaaa", content: '<a href="/">Casa</a> e <a href="/x/">Opere</a>' } }]))).toEqual(["Casa", "e", "Opere"]);
  });
});

describe("traduzione a segmenti", () => {
  it("salva in bozza, conta ciò che resta, e rifiuta testi sconosciuti", async () => {
    const store = await project();
    const source = store.createPage({ title: "Benvenuti", slug: "benvenuti", content: page, status: "published" });
    const view = store.translationSource(source.id, "en");
    const h1 = view.segments.find((segment) => segment.text === "Benvenuti" && segment.id !== "title")!;
    const { link, left } = store.saveTranslationSegments({ sourceId: source.id, language: "en", segments: { title: "Welcome", [h1.id]: "Welcome" } });
    expect(left).toBe(2);
    const draft = store.getEntityById(link.translationId)!;
    expect(draft).toMatchObject({ title: "Welcome", status: "draft", locale: "en" });
    expect(store.getHead(draft.id)!.content).toContain("Welcome");
    expect(() => store.saveTranslationSegments({ sourceId: source.id, language: "en", segments: { nope: "x" } })).toThrow("non è fra quelli");
    store.close();
  });

  it("non scrive mai su una versione pubblicata, né su una indipendente", async () => {
    const store = await project();
    const source = store.createPage({ title: "Uno", slug: "uno", content: page, status: "published" });
    const { link } = store.saveTranslationSegments({ sourceId: source.id, language: "en", segments: { title: "One" } });
    store.updatePageMetadata(link.translationId, { title: "One", slug: "uno", status: "published" });
    const head = store.getEntityById(link.translationId)!.headRevision;
    expect(() => store.saveTranslationSegments({ sourceId: source.id, language: "en", segments: { title: "Two" } })).toThrow("pubblicata");
    expect(store.getEntityById(link.translationId)!.headRevision).toBe(head);
    expect(() => store.updateTranslationDraft(link.translationId)).toThrow("mai");
    store.setTranslationMode(link.translationId, "independent");
    expect(() => store.saveTranslationSegments({ sourceId: source.id, language: "en", segments: { title: "Two" } })).toThrow("indipendente");
    store.close();
  });

  it("dopo un cambio dell'originale aggiorna la bozza: tiene le frasi invariate, le altre tornano originali", async () => {
    const store = await project();
    const source = store.createPage({ title: "Titolo", slug: "uno", content: page, status: "published" });
    const segments = store.translationSource(source.id, "en").segments;
    const ids = Object.fromEntries(segments.map((segment) => [segment.text, segment.id]));
    const { link } = store.saveTranslationSegments({ sourceId: source.id, language: "en", segments: { title: "Title", [ids.Benvenuti!]: "Welcome", [ids["Una foto"]!]: "A photo" } });
    const edited = page.replace("Benvenuti", "Salve");
    store.saveDocument({ entityId: source.id, expectedHead: store.getEntityById(source.id)!.headRevision, content: edited });
    expect(store.translationChanges(link.translationId).changes).toEqual([{ id: ids.Benvenuti, before: "Benvenuti", now: "Salve", translation: "Welcome" }]);
    const { left } = store.updateTranslationDraft(link.translationId);
    expect(left).toBe(2);
    const content = store.getHead(link.translationId)!.content;
    expect(content).toContain("Salve");
    expect(content).not.toContain("Welcome");
    expect(content).toContain("A photo");
    expect(store.getEntityById(link.translationId)!.title).toBe("Title");
    store.close();
  });

  it("la memoria impara solo da ciò che è pubblicato, e serve alle pagine nuove", async () => {
    const store = await project();
    const first = store.createPage({ title: "Uno", slug: "uno", content: page, status: "published" });
    const ids = Object.fromEntries(store.translationSource(first.id, "en").segments.map((segment) => [segment.text, segment.id]));
    const { link } = store.saveTranslationSegments({ sourceId: first.id, language: "en", segments: { title: "One", [ids.Benvenuti!]: "Welcome" } });
    const second = store.createPage({ title: "Due", slug: "due", content: page, status: "published" });
    expect(Object.values(store.translationSource(second.id, "en").memory)).toEqual([]);
    store.updatePageMetadata(link.translationId, { title: "One", slug: "uno", status: "published" });
    expect(Object.values(store.translationSource(second.id, "en").memory)).toEqual(["Welcome"]);
    const draft = store.createTranslation({ sourceId: second.id, language: "en" });
    expect(store.getHead(draft.translationId)!.content).toContain("Welcome");
    store.close();
  });

  it("traduce i campi di testo di un record", async () => {
    const store = await project();
    store.content.saveType({ key: "opera", label: "Opere", fields: [{ key: "trama", label: "Trama", type: "text", required: false, public: true, multiple: false }, { key: "anno", label: "Anno", type: "integer", required: false, public: true, multiple: false }] });
    const saved = store.content.saveRecord({ typeKey: "opera", title: "Opera", slug: "opera", status: "published", values: { trama: "Una storia", anno: 1300 } });
    if (saved.status !== "saved") throw new Error("record");
    const { link } = store.saveTranslationSegments({ sourceId: saved.record.id, language: "en", segments: { title: "Work", "field:trama": "A story" } });
    expect(store.content.getRecordById(link.translationId)).toMatchObject({ title: "Work", status: "draft", values: { trama: "A story", anno: 1300 } });
    store.close();
  });
});

describe("stringhe", () => {
  it("raccoglie i testi fissi di parti e termini, e tiene solo testo semplice", async () => {
    const store = await project();
    store.createTemplatePart({ ref: "site/footer", title: "Piè", content: documentOf('<p class="a">Tutti i diritti riservati</p>') });
    expect(store.listStrings("en").map((item) => [item.source, item.status])).toContainEqual(["Tutti i diritti riservati", "missing"]);
    expect(store.saveStrings("en", [{ source: "Tutti i diritti riservati", translation: "All rights reserved", context: "part" }], "draft")).toBe(1);
    expect(store.publishedStrings("en").size).toBe(0);
    expect(store.saveStrings("en", [{ source: "Tutti i diritti riservati", translation: "All rights reserved", context: "part" }], "published")).toBe(1);
    expect(store.publishedStrings("en").get("Tutti i diritti riservati")).toBe("All rights reserved");
    expect(() => store.saveStrings("en", [{ source: "Tutti i diritti riservati", translation: "<b>x</b>", context: "part" }], "published")).toThrow("angolari");
    expect(() => store.saveStrings("en", [{ source: "Tutti i diritti riservati", translation: "Altro", context: "part" }], "draft")).toThrow("pubblicata");
    store.close();
  });
});

describe("passaggio finale di una pagina tradotta", () => {
  const strings = new Map([["Tutti i diritti", "All rights"], ["Chi siamo", "About & us"], ["Cerca", "Search"]]);
  const links = new Map([["/chi-siamo/", "/en/about/"], ["/", "/en/"]]);

  it("cambia testi interi e attributi interi, con l'escape", () => {
    expect(localizeHtml('<p class="a"> Tutti  i diritti </p><img alt="Chi siamo"><input placeholder="Cerca">', strings, links)).toBe('<p class="a"> All rights </p><img alt="About &amp; us"><input placeholder="Search">');
    expect(localizeHtml("<p>Tutti i diritti riservati</p>", strings, links)).toBe("<p>Tutti i diritti riservati</p>");
  });

  it("non tocca script, stili, codice, commenti", () => {
    const html = '<script>"Cerca"</script><style>a{content:"Cerca"}</style><code>Cerca</code><pre>Cerca</pre><textarea>Cerca</textarea><!-- Cerca -->';
    expect(localizeHtml(html, strings, links)).toBe(html);
  });

  it("porta i link interni alla versione nella lingua, tiene frammenti e il selettore", () => {
    expect(localizeHtml('<a href="/chi-siamo/#team">x</a><a href="/">y</a><a href="/altro/">z</a><a href="https://a.it/chi-siamo/">w</a>', new Map(), links)).toBe('<a href="/en/about/#team">x</a><a href="/en/">y</a><a href="/altro/">z</a><a href="https://a.it/chi-siamo/">w</a>');
    const switcher = '<a href="/chi-siamo/" hreflang="it-IT">IT</a>';
    expect(localizeHtml(switcher, new Map(), links)).toBe(switcher);
  });

  it("una stringa non può aggiungere markup, e il tempo resta lineare su pagine lunghe", () => {
    expect(normalizeStringSource(" A &amp;  B ")).toBe("A & B");
    const big = "<p>x</p>".repeat(200_000);
    const start = performance.now();
    expect(localizeHtml(big, new Map([["y", "z"]]), new Map())).toBe(big);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
