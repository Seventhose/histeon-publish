import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildXliff, parseXliff } from "../src/translation-xliff.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-xliff-"));
  roots.push(root);
  const { store } = await new CmsProjectCatalog(root).createProject("X");
  store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  store.setProjectLanguages([{ code: "en" }]);
  return store;
}
const translate = (xliff: string, from: string, to: string) => xliff.replace(`<source>${from}</source>`, `<source>${from}</source><target>${to}</target>`);

describe("XLIFF", () => {
  it("fa il giro completo con testi speciali", () => {
    const xliff = buildXliff({ sourceLanguage: "it-IT", targetLanguage: "en", contents: [{ sourceId: "abc", sourceHash: "h", title: "T", segments: [{ id: "a:text", text: "Fish & <b>chips</b> \"x\"" }], targets: { "a:text": "Pesce & <b>patate</b>" } }] });
    expect(parseXliff(xliff)).toEqual([{ sourceId: "abc", sourceHash: "h", targetLanguage: "en", segments: { "a:text": "Pesce & <b>patate</b>" }, unreadable: 0 }]);
  });

  it("rifiuta DOCTYPE, entità, file altrui e file enormi", () => {
    expect(() => parseXliff('<!DOCTYPE x [<!ENTITY a "b">]><xliff></xliff>')).toThrow("DOCTYPE");
    expect(() => parseXliff("<nope/>")).toThrow("XLIFF");
    expect(() => parseXliff('<xliff><file original="altro"></file></xliff>')).toThrow("Histeon");
    expect(() => parseXliff(`<xliff>${" ".repeat(65 * 1024 * 1024)}</xliff>`)).toThrow("64 MB");
  });

  it("esporta ciò che manca, importa in bozza, e rifiuta markup e originali cambiati", async () => {
    const store = await project();
    const content = serializeXb(parse('<h1 class="a">Benvenuti</h1>').blocks);
    const page = store.createPage({ title: "Uno", slug: "uno", content, status: "published" });
    const xliff = store.exportTranslationXliff("en", false);
    expect(xliff).toContain("<source>Benvenuti</source>");
    const done = store.importTranslationXliff("en", translate(translate(xliff, "Benvenuti", "Welcome"), "Uno", "One"));
    expect(done.saved).toBe(1);
    const link = store.listTranslations(page.id)[0]!;
    expect(store.getEntityById(link.translationId)).toMatchObject({ status: "draft", title: "One" });
    expect(store.getHead(link.translationId)!.content).toContain("Welcome");
    const bad = store.importTranslationXliff("en", translate(xliff, "Benvenuti", "&lt;script&gt;x&lt;/script&gt;"));
    expect(bad.saved).toBe(0);
    expect(bad.skipped[0]?.reason).toContain("tag");
    store.saveDocument({ entityId: page.id, expectedHead: store.getEntityById(page.id)!.headRevision, content: content.replace("Benvenuti", "Salve") });
    const late = store.importTranslationXliff("en", translate(xliff, "Benvenuti", "Hi"));
    expect(late.skipped[0]?.reason).toContain("cambiato");
    store.close();
  });

  it("rifiuta un file di un'altra lingua, legge il CDATA, dice ciò che non legge", async () => {
    const store = await project();
    store.setProjectLanguages([{ code: "en" }, { code: "fr" }]);
    store.createPage({ title: "Uno", slug: "uno", status: "published" });
    const xliff = store.exportTranslationXliff("en", false);
    expect(() => store.importTranslationXliff("fr", xliff)).toThrow("non in fr");
    expect(store.importTranslationXliff("en", xliff.replace("<source>Uno</source>", "<source>Uno</source><target><![CDATA[One]]></target>")).saved).toBe(1);
    const marked = store.exportTranslationXliff("en", true).replace(/<target[^>]*>One<\/target>/u, "").replace("<source>Uno</source>", '<source>Uno</source><target><g id="1">One</g></target>');
    expect(store.importTranslationXliff("en", marked).skipped[0]?.reason).toContain("marcatori");
    store.close();
  });

  it("non tocca una versione pubblicata", async () => {
    const store = await project();
    const page = store.createPage({ title: "Uno", slug: "uno", status: "published" });
    const xliff = store.exportTranslationXliff("en", false);
    const link = store.createTranslation({ sourceId: page.id, language: "en" });
    store.updatePageMetadata(link.translationId, { title: "One", slug: "uno", status: "published" });
    const result = store.importTranslationXliff("en", translate(xliff, "Uno", "Two"));
    expect(result.saved).toBe(0);
    expect(store.getEntityById(link.translationId)!.title).toBe("One");
    store.close();
  });
});
