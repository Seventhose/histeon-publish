import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import LZString from "lz-string";
import yazl from "yazl";
import { CmsProjectCatalog } from "../src/project-repository.js";
import {
  createStaticPageProfile,
  createDraftImportProfile,
  decodeStaticPageArchive,
  encodeStaticPageArchive,
  encodeStaticPageProfileArchive,
  profileUsesLoopGroup,
  profileUsesMediaLinks,
  profileUsesTransferMarkupV1,
  validateTransferDocument,
} from "../src/page-transfer.js";
import { TransferMarkupError } from "../src/transfer-markup.js";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { renderCmsPage } from "../src/static-renderer.js";
import { canonicalizeJson, manifestHashInput, type StaticPageProfile } from "@histos-publish/histos-contract";
import { createHash } from "node:crypto";

const roots: string[] = [];

function zip(entries: Array<{ name: string; bytes: Buffer; compress?: boolean }>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  for (const entry of entries) archive.addBuffer(entry.bytes, entry.name, { compress: entry.compress ?? true, mode: 0o100600, mtime: new Date(0) });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.once("error", reject);
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    archive.end();
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Histeon static page archive v2", () => {
  it("encodes the shared golden fixture without changing its canonical bytes", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-page-v1.json", import.meta.url), "utf8")) as {
      profile: StaticPageProfile;
      files: Record<string, string>;
    };
    const files = new Map(Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
    const archive = await encodeStaticPageProfileArchive(fixture.profile, files);
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile).toEqual(fixture.profile);
    for (const [name, bytes] of files) expect(decoded.files.get(name)).toEqual(bytes);
  });

  it("prepares an import-as-drafts profile without changing the local source profile", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-project-v3.json", import.meta.url), "utf8")) as {
      profile: StaticPageProfile;
      files: Record<string, string>;
    };
    const files = new Map(Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
    const sourceEntities = structuredClone(fixture.profile.entities);
    const sourceHashes = new Map(sourceEntities.map((entity) => [entity.id, entity.revisionHash]));
    const projected = createDraftImportProfile(fixture.profile, files);
    const page = projected.profile.entities.find((entity) => entity.kind === "document");
    const sourcePage = fixture.profile.entities.find((entity) => entity.kind === "document");
    expect(page?.payload.status).toBe("draft");
    expect(sourcePage?.payload.status).toBe("published");
    expect(page?.revisionHash).not.toBe(sourcePage?.revisionHash);

    const records = projected.profile.entities.filter((entity) => entity.kind === "content-record");
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((entity) => entity.payload.status === "draft" && entity.payload.publishedAt === null)).toBe(true);
    expect(fixture.profile.entities).toEqual(sourceEntities);
    for (const entity of projected.profile.entities.filter((item) => item.kind !== "document" && item.kind !== "content-record")) {
      expect(entity.revisionHash).toBe(sourceHashes.get(entity.id));
    }

    const archive = await encodeStaticPageProfileArchive(projected.profile, projected.files);
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile).toEqual(projected.profile);
    expect(decoded.files.get("entities.ndjson")).toEqual(projected.files.get("entities.ndjson"));
  });

  it("exports and validates page, styles, image bytes and image metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Trasferimento 😀");
    const styles = store.getStyles();
    const stylesHead = styles ? store.getHead(styles.id) : null;
    expect(styles).not.toBeNull();
    expect(stylesHead).not.toBeNull();
    if (!styles || !stylesHead) throw new Error("Gli stili del progetto non sono inizializzati.");
    const corePresetJson = JSON.stringify({ id: "core-e2e", name: "Core E2E", description: "Preset trasferibile", date: "2026-10-24", groups: {}, styleSheetData: {}, modulesData: {}, cssString: ":root{--core-e2e-space:1rem}" });
    const corePreset = { format: "core-lz-utf16-v1" as const, data: LZString.compressToUTF16(corePresetJson) };
    const coreSource = { kind: "user-css" as const, frameworkId: "core-framework" as const, name: "Core Framework", version: "3.2.1", license: "MIT", rightsConfirmed: true as const, preset: corePreset };
    const coreCss = ":root{--core-e2e-space:1rem}";
    const acssConfiguration = '{\n  "config": "preserve spacing and order 🌱"\n}';
    const acssSource = { kind: "user-css" as const, frameworkId: "automatic-css" as const, name: "Automatic.css", version: "fixture", rightsConfirmed: true as const, configuration: { format: "opaque-utf8-v1" as const, data: acssConfiguration } };
    store.saveDocument({ entityId: styles.id, expectedHead: stylesHead.id, content: JSON.stringify({ styles: [], globals: [{ id: "core-framework", css: coreCss, source: coreSource }, { id: "automatic-css", css: ":root{--acss-space:1rem}", source: acssSource }], compiledCss: "", design: { radius: 12 }, tokenOverrides: { "xb-primary": "#123456" }, queries: { md: "(min-width: 768px)" } }) });
    const asset = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "logo.png", alt: "Logo A", caption: "Didascalia" });
    const page = store.listPages()[0]!;
    store.updatePageMetadata(page.id, { title: page.title, slug: page.slug, status: "published" });
    const draftPage = store.createPage({ title: "Bozza", slug: "bozza", status: "draft" });
    const base = store.getHead(page.id)!;
    const content = `<!-- wp:xb/element {"uid":"abcde12345","tag":"img","attributes":{"src":"/__cms-media/${project.id}/${asset.id}","alt":"Logo A"}} /-->`;
    const saved = store.saveDocument({ entityId: page.id, expectedHead: base.id, content });
    expect(saved.status).toBe("saved");

    const archive = await encodeStaticPageArchive(project, store, "0.1.14");
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile.manifest.profile).toBe("histos-static-page-v1");
    expect(decoded.profile.entities.map((entity) => entity.kind).sort()).toEqual(["asset", "document", "document", "styles"]);
    expect(decoded.profile.references).toEqual([{ ownerId: page.id, blockUid: "abcde12345", path: "attrs.attributes.src", targetId: asset.id, role: "media" }]);
    expect(decoded.profile.entities.find((entity) => entity.kind === "asset")?.payload).toMatchObject({ alt: "Logo A", caption: "Didascalia", title: "logo.png" });
    expect(decoded.profile.entities.find((entity) => entity.kind === "styles")?.payload).toMatchObject({ design: { radius: 12 }, tokenOverrides: { "xb-primary": "#123456" }, queries: { md: "(min-width: 768px)" }, globals: [{ id: "core-framework", css: coreCss, source: coreSource }, { id: "automatic-css", source: acssSource }] });
    expect(decoded.profile.entities.filter((entity) => entity.kind === "document").map((entity) => [entity.id, entity.payload.status])).toEqual(expect.arrayContaining([[page.id, "published"], [draftPage.id, "draft"]]));
    expect([...decoded.files.get(`media/${asset.sha256}`)!]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    expect(destination.project.id).toBe(project.id);
    expect(destination.store.listPages()).toHaveLength(2);
    expect(destination.store.listPages().find((entry) => entry.id === page.id)?.status).toBe("published");
    expect(destination.store.listPages().find((entry) => entry.id === draftPage.id)?.status).toBe("draft");
    expect(destination.store.getHead(page.id)?.content).toContain(`/__cms-media/${project.id}/${asset.id}`);
    expect(JSON.parse(destination.store.getHead(styles.id)!.content)).toMatchObject({ design: { radius: 12 }, tokenOverrides: { "xb-primary": "#123456" }, queries: { md: "(min-width: 768px)" }, globals: [{ id: "core-framework", css: coreCss, source: coreSource }, { id: "automatic-css", source: acssSource }] });
    expect(destination.store.listAssets()).toHaveLength(1);
    expect([...(await destination.store.readAsset(asset.id))!.bytes]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    destination.store.close();
    store.close();
  });

  it("rifiuta un media referenziato ma assente prima di creare il progetto importato", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-missing-reference-source-"));
    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-missing-reference-destination-"));
    roots.push(sourceRoot, destinationRoot);
    const sourceCatalog = new CmsProjectCatalog(sourceRoot);
    const { project, store } = await sourceCatalog.createProject("Riferimento media mancante");
    const image = store.saveAsset({ bytes: Buffer.from("image-bytes"), mimeType: "image/png", filename: "logo.png", alt: "Logo" });
    const page = store.listPages()[0]!;
    const head = store.getHead(page.id)!;
    const content = `<!-- wp:xb/element {"uid":"missingimg01","tag":"img","attributes":{"src":"/__cms-media/${project.id}/${image.id}","alt":"Logo"}} /-->`;
    expect(store.saveDocument({ entityId: page.id, expectedHead: head.id, content }).status).toBe("saved");
    const exported = await createStaticPageProfile(project, store);
    store.close();

    const invalidProfile = structuredClone(exported.profile);
    invalidProfile.entities = invalidProfile.entities.filter((entity) => entity.id !== image.id);
    const destinationCatalog = new CmsProjectCatalog(destinationRoot);
    await expect(destinationCatalog.importStaticPageProfile(invalidProfile, exported.files)).rejects.toThrow();
    expect(await destinationCatalog.listProjects()).toEqual([]);

    const assetEntity = exported.profile.entities.find((entity) => entity.kind === "asset" && entity.id === image.id);
    if (!assetEntity || assetEntity.kind !== "asset" || typeof assetEntity.payload.path !== "string") throw new Error("L’asset esportato non contiene il percorso del blob.");
    const missingBlobFiles = new Map(exported.files);
    missingBlobFiles.delete(assetEntity.payload.path);
    await expect(destinationCatalog.importStaticPageProfile(exported.profile, missingBlobFiles)).rejects.toThrow(/Manca il blob/u);
    expect(await destinationCatalog.listProjects()).toEqual([]);
  });

  it("rifiuta l'esportazione completa se il CSS contiene file relativi non trasferibili", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-css-resource-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("CSS con risorsa locale");
    const styles = store.getStyles();
    if (!styles) throw new Error("Gli stili del progetto non sono inizializzati.");
    const head = store.getHead(styles.id);
    if (!head) throw new Error("La revisione degli stili non è inizializzata.");
    store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({ styles: [], globals: [{ id: "framework-acss", css: "@import '../css/tokens.css';", source: { kind: "user-css", frameworkId: "automatic-css", name: "ACSS", rightsConfirmed: true } }], compiledCss: "" }) });
    await expect(encodeStaticPageArchive(project, store)).rejects.toThrow(/ACSS.*\.\.\/css\/tokens\.css.*Gli import locali/u);
    store.close();
  });

  it("trasferisce i media collegati a stili globali e selettori nel profilo WordPress", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-css-asset-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("CSS con asset collegato");
    const font = store.saveAsset({ bytes: new Uint8Array([119, 79, 70, 50, 0, 0]), mimeType: "font/woff2", filename: "brand.woff2" });
    const image = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "hero.png" });
    const styles = store.getStyles();
    if (!styles) throw new Error("Gli stili del progetto non sono inizializzati.");
    const head = store.getHead(styles.id);
    if (!head) throw new Error("La revisione degli stili non è inizializzata.");
    store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({
      styles: [{ id: "hero", selector: ".hero", css: "background-image:url(../images/hero.png?v=4)", assets: [{ reference: "../images/hero.png?v=4", assetId: image.id }] }],
      globals: [{ id: "framework-fonts", css: "@font-face{src:url(brand.woff2)}", assets: [{ reference: "brand.woff2", assetId: font.id }] }],
      compiledCss: "",
    }) });
    const decoded = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    const styleEntity = decoded.profile.entities.find((entity) => entity.kind === "styles");
    expect(styleEntity?.payload.styles).toMatchObject([{ id: "hero", assets: [{ reference: "../images/hero.png?v=4", assetId: image.id }] }]);
    expect(styleEntity?.payload.globals).toMatchObject([{ id: "framework-fonts", assets: [{ reference: "brand.woff2", assetId: font.id }] }]);
    expect(decoded.profile.entities.filter((entity) => entity.kind === "asset").map((entity) => entity.id)).toEqual(expect.arrayContaining([font.id, image.id]));
    store.close();
  });

  it("preserva slug uguali in lingue diverse e asset con byte uguali ma testi alternativi distinti", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-localized-assets-"));
    roots.push(root);
    const { project, store } = await new CmsProjectCatalog(root).createProject("Contenuti localizzati con media condivisi");
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const coverIt = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "copertina-it.png", alt: "Facciata della biblioteca", caption: "Biblioteca comunale" });
    const coverEn = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "cover-en.png", alt: "Library entrance", caption: "City library" });
    expect(coverEn.id).not.toBe(coverIt.id);
    expect(coverEn.sha256).toBe(coverIt.sha256);

    const contentType = store.content.saveType({
      key: "story", label: "Storia", expectedHead: null,
      fields: [{ key: "cover", label: "Copertina", type: "asset", public: true }],
    });
    expect(contentType.status).toBe("saved");
    const italian = store.content.createRecord({ typeKey: "story", title: "La biblioteca", slug: "la-biblioteca", locale: "it-IT", status: "published", values: { cover: coverIt.id } });
    const english = store.content.createRecord({ typeKey: "story", title: "The library", slug: "la-biblioteca", locale: "en-US", status: "published", values: { cover: coverEn.id } });
    expect(italian.status).toBe("saved");
    expect(english.status).toBe("saved");
    if (italian.status !== "saved" || english.status !== "saved") throw new Error("I record localizzati avrebbero dovuto essere salvati.");

    const decoded = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    const exportedRecords = decoded.profile.entities.filter((entity) => entity.kind === "content-record" && entity.payload.typeKey === "story");
    expect(exportedRecords).toHaveLength(2);
    expect(exportedRecords.map((entity) => [entity.payload.slug, entity.payload.locale])).toEqual(expect.arrayContaining([
      ["la-biblioteca", "it-IT"],
      ["la-biblioteca", "en-US"],
    ]));
    const exportedAssets = decoded.profile.entities.filter((entity) => entity.kind === "asset");
    const localizedAssets = exportedAssets.filter((entity) => entity.id === coverIt.id || entity.id === coverEn.id);
    expect(localizedAssets).toHaveLength(2);
    expect(localizedAssets[0]?.payload.path).toBe(localizedAssets[1]?.payload.path);
    expect(localizedAssets.map((entity) => [entity.payload.alt, entity.payload.caption])).toEqual(expect.arrayContaining([
      ["Facciata della biblioteca", "Biblioteca comunale"],
      ["Library entrance", "City library"],
    ]));
    expect(decoded.files.get(String(localizedAssets[0]?.payload.path))).toEqual(Buffer.from(png));

    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-localized-assets-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    const importedIt = destination.store.content.getRecordById(italian.record.id, true);
    const importedEn = destination.store.content.getRecordById(english.record.id, true);
    expect(importedIt).toMatchObject({ slug: "la-biblioteca", locale: "it-IT", values: { cover: coverIt.id } });
    expect(importedEn).toMatchObject({ slug: "la-biblioteca", locale: "en-US", values: { cover: coverEn.id } });
    expect(destination.store.listAssets().filter((asset) => asset.id === coverIt.id || asset.id === coverEn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: coverIt.id, sha256: coverIt.sha256, alt: "Facciata della biblioteca", caption: "Biblioteca comunale" }),
      expect.objectContaining({ id: coverEn.id, sha256: coverEn.sha256, alt: "Library entrance", caption: "City library" }),
    ]));
    expect([...(await destination.store.readAsset(coverIt.id))!.bytes]).toEqual([...png]);
    expect([...(await destination.store.readAsset(coverEn.id))!.bytes]).toEqual([...png]);
    destination.store.close();
    store.close();
  });

  it("round-trips the relational CMS profile, private fields, relations, taxonomy terms and query sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-relational-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Contenuti relazionali");
    // An Italian project on any computer: its records are saved without a locale and rendered it-IT below.
    store.setRenderSettings({ ...store.getRenderSettings(), locale: "it-IT" });
    const image = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "copertina.png", alt: "Copertina" });
    const singleTemplate = store.createTemplate({ ref: "content/article-single", title: "Scheda articolo" });
    const archiveTemplate = store.createTemplate({ ref: "content/article-archive", title: "Archivio articoli" });
    const authorType = store.content.saveType({
      id: "550e8400-e29b-41d4-a716-446655440101", key: "author", label: "Autore", expectedHead: null,
      fields: [{ key: "bio", label: "Biografia", type: "rich-text", public: true }, { key: "note", label: "Nota interna", type: "text", public: false }],
    });
    const articleType = store.content.saveType({
      id: "550e8400-e29b-41d4-a716-446655440102", key: "article", label: "Articolo", expectedHead: null,
      singleTemplateRef: singleTemplate.ref, archiveTemplateRef: archiveTemplate.ref,
      fields: [
        { key: "author", label: "Autore", type: "relation", targetType: "author", required: true, public: true },
        { key: "cover", label: "Copertina", type: "asset", public: true },
        { key: "rank", label: "Ordine", type: "integer", public: true },
      ],
    });
    expect(authorType.status).toBe("saved");
    expect(articleType.status).toBe("saved");
    const author = store.content.createRecord({ typeKey: "author", title: "Ada", status: "published", values: { bio: "Autrice", note: "Profilo privato" } });
    expect(author.status).toBe("saved");
    if (author.status !== "saved") throw new Error("L’autrice avrebbe dovuto essere salvata.");
    const taxonomy = store.content.saveTaxonomy({ id: "550e8400-e29b-41d4-a716-446655440103", key: "topic", label: "Argomenti", types: ["article"], expectedHead: null });
    expect(taxonomy.status).toBe("saved");
    const rootTerm = store.content.saveTerm({ id: "550e8400-e29b-41d4-a716-446655440104", taxonomyKey: "topic", slug: "cms", label: "CMS", parentId: null, expectedHead: null });
    expect(rootTerm.status).toBe("saved");
    if (rootTerm.status !== "saved") throw new Error("Il termine avrebbe dovuto essere creato.");
    const childTerm = store.content.saveTerm({ id: "550e8400-e29b-41d4-a716-446655440105", taxonomyKey: "topic", slug: "sqlite", label: "SQLite", parentId: rootTerm.term.id, expectedHead: null });
    expect(childTerm.status).toBe("saved");
    if (childTerm.status !== "saved") throw new Error("Il termine figlio avrebbe dovuto essere creato.");
    const article = store.content.createRecord({ typeKey: "article", title: "CMS relazionale", status: "published", values: { author: author.record.id, cover: image.id, rank: 1 }, terms: { topic: [childTerm.term.alias] } });
    expect(article.status).toBe("saved");
    store.content.saveQueryPreset({ key: "recent_articles", label: "Articoli recenti", typeKey: "article", limit: 10, orderBy: "publishedAt", order: "desc", filter: { taxonomyKey: "topic", termIds: [childTerm.term.id], operator: "IN" }, expectedHead: null });
    store.content.saveQueryPreset({ key: "paged_articles", label: "Articoli dalla quarta posizione", typeKey: "article", limit: 10, offset: 3, orderBy: "publishedAt", order: "desc", expectedHead: null });
    store.content.saveQuerySources({ localities: { type: "json", data: [{ name: "Rimini" }, { name: "Bologna" }] } });
    const page = store.listPages()[0]!;
    const pageHead = store.getHead(page.id)!;
    const content = '<!-- wp:xb/loop {"uid":"relpreset001","source":{"kind":"preset","id":"recent_articles","args":{"count":"2"}},"as":"item"} --><!-- wp:xb/element {"uid":"relitem001","tag":"h2"} --><!-- wp:xb/text {"uid":"reltext001","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop --><!-- wp:xb/loop {"uid":"reldatasrc01","source":{"kind":"expr","expr":"data.localities"},"as":"place"} --><!-- wp:xb/element {"uid":"reldatitem1","tag":"p"} --><!-- wp:xb/text {"uid":"reldatatext","content":"{place.name}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop -->';
    expect(store.saveDocument({ entityId: page.id, expectedHead: pageHead.id, content }).status).toBe("saved");

    const decoded = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    expect(decoded.profile.manifest.profile).toBe("histos-static-project-v3");
    expect(decoded.profile.manifest.requiredCapabilities).toContain("content:records:v1");
    expect(decoded.profile.entities.filter((entity) => entity.kind.startsWith("content-")).map((entity) => entity.kind)).toEqual(expect.arrayContaining(["content-type", "content-record"]));
    expect(decoded.profile.entities.find((entity) => entity.kind === "content-type" && entity.payload.key === "article")?.payload).toMatchObject({ singleTemplateRef: "content/article-single", archiveTemplateRef: "content/article-archive" });
    expect(decoded.profile.entities.find((entity) => entity.kind === "query-preset" && entity.payload.key === "paged_articles")?.payload).toMatchObject({ offset: 3 });
    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-relational-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    expect(destination.store.content.getType("author")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "note", public: false }),
    ]));
    expect(destination.store.content.getType("article")).toMatchObject({ singleTemplateRef: "content/article-single", archiveTemplateRef: "content/article-archive" });
    expect(destination.store.canUseTemplate("content/article-single")).toBe(true);
    expect(destination.store.canUseTemplate("content/article-archive")).toBe(true);
    expect(destination.store.content.getRecordById(author.record.id, true)?.values.note).toBe("Profilo privato");
    const importedArticle = destination.store.content.getRecordById(article.status === "saved" ? article.record.id : "", true);
    expect(importedArticle?.values.author).toMatchObject({ id: author.record.id, title: "Ada" });
    expect(importedArticle?.terms.topic?.map((term) => term.id)).toEqual([childTerm.term.id]);
    expect(destination.store.content.listQueryPresets().presets).toEqual(expect.arrayContaining([expect.objectContaining({ key: "recent_articles", offset: 0 }), expect.objectContaining({ key: "paged_articles", offset: 3 })]));
    expect(destination.store.content.listTerms("topic").find((term) => term.id === childTerm.term.id)?.parentId).toBe(rootTerm.term.id);
    expect(destination.store.content.listQuerySources()).toEqual({ localities: { type: "json", data: [{ name: "Rimini" }, { name: "Bologna" }] } });
    expect(destination.store.content.resolveQueryPreset("recent_articles", {}, "it-IT").map((record) => record.id)).toContain(importedArticle?.id);
    const sourcePage = store.getHead(page.id)!;
    const destinationPage = destination.store.getHead(page.id)!;
    const sourceRender = await renderCmsPage({ store, projectId: project.id, content: sourcePage.content, locale: "it-IT" });
    const destinationRender = await renderCmsPage({ store: destination.store, projectId: destination.project.id, content: destinationPage.content, locale: "it-IT" });
    expect(destinationRender.html).toBe(sourceRender.html);
    expect(destinationRender.css).toBe(sourceRender.css);
    expect(destinationRender.html).toContain("CMS relazionale");
    expect(destinationRender.html).toContain("Rimini");
    destination.store.close();
    store.close();
  });

  it("rejects corrupted archives before exposing a transfer profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-corrupt-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Integrità");
    const archive = await encodeStaticPageArchive(project, store);
    store.close();
    await expect(decodeStaticPageArchive(Buffer.from("not a zip archive"))).rejects.toThrow();
  });

  it("rifiuta versioni future, path traversal, zip bomb e manifest troppo grandi", async () => {
    const future = await zip([{ name: "site.json", bytes: Buffer.from(JSON.stringify({ format: "xb-site", version: 3 })), compress: false }]);
    await expect(decodeStaticPageArchive(future)).rejects.toMatchObject({ code: "unsupported-format" });

    const traversalSource = await zip([{ name: "safe", bytes: Buffer.from("outside"), compress: false }]);
    const traversal = Buffer.from(traversalSource);
    const safeName = Buffer.from("safe");
    let offset = traversal.indexOf(safeName);
    let patchedNames = 0;
    while (offset !== -1) {
      Buffer.from("../a").copy(traversal, offset);
      patchedNames += 1;
      offset = traversal.indexOf(safeName, offset + safeName.byteLength);
    }
    expect(patchedNames).toBeGreaterThanOrEqual(2);
    await expect(decodeStaticPageArchive(traversal)).rejects.toThrow(/relative path|Percorso ZIP non consentito/u);

    const duplicateNames = await zip([
      { name: "safe", bytes: Buffer.from("one"), compress: false },
      { name: "SAFE", bytes: Buffer.from("two"), compress: false },
    ]);
    await expect(decodeStaticPageArchive(duplicateNames)).rejects.toThrow(/Voce ZIP duplicata/u);

    const bomb = Buffer.alloc(4 * 1024 * 1024);
    const zipBomb = await zip([
      { name: "site.json", bytes: Buffer.from("{}"), compress: false },
      { name: `media/sha256/00/${"0".repeat(64)}`, bytes: bomb },
    ]);
    await expect(decodeStaticPageArchive(zipBomb)).rejects.toThrow(/rapporto di compressione non consentito/u);

    const hugeManifest = await zip([{ name: "site.json", bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), compress: false }]);
    await expect(decodeStaticPageArchive(hugeManifest)).rejects.toThrow(/manifest site\.json supera 8 MiB/u);

    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-invalid-import-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    for (const invalid of [future, traversal, zipBomb, hugeManifest]) await expect(decodeStaticPageArchive(invalid)).rejects.toThrow();
    expect(await catalog.listProjects()).toEqual([]);
  });

  it("round-trips component definitions and stable references in the project transfer profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-component-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Componente locale");
    const page = store.listPages()[0]!;
    const head = store.getHead(page.id)!;
    const content = '<!-- wp:xb/component {"uid":"abcde12345","ref":"ui/card"} /-->';
    expect(store.saveDocument({ entityId: page.id, expectedHead: head.id, content }).status).toBe("saved");
    await expect(encodeStaticPageArchive(project, store)).rejects.toThrow(/non appartiene al progetto/u);
    const component = store.createComponent({
      id: "550e8400-e29b-41d4-a716-446655440010",
      ref: "ui/card",
      title: "Card",
      content: '<!-- wp:xb/element {"uid":"cardtext123","tag":"p"} --><!-- wp:xb/text {"uid":"cardtext124","content":"Card"} /--><!-- /wp:xb/element -->',
      schema: { props: { href: { type: "url", label: "Link" } } },
    });
    const archive = await encodeStaticPageArchive(project, store);
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile.manifest.profile).toBe("histos-static-project-v1");
    expect(decoded.profile.manifest.requiredCapabilities).toContain("components:definition:v1");
    expect(decoded.profile.entities.find((entity) => entity.kind === "component")).toMatchObject({
      id: component.id,
      payload: { ref: "ui/card", title: "Card", schema: { props: { href: { type: "url", label: "Link" } } } },
    });
    expect(decoded.profile.references).toContainEqual({ ownerId: page.id, blockUid: "abcde12345", path: "attrs.ref", targetId: component.id, role: "document" });

    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-component-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    expect(destination.store.getComponentById(component.id)).toMatchObject({ ref: "ui/card", title: "Card", content: component.content, schema: component.schema });
    expect(destination.store.getHead(page.id)?.content).toContain('"ref":"ui/card"');
    destination.store.close();
    store.close();
  });

  it("round-trips editable conditions, local loops, prop expressions and filled slots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-runtime-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Runtime trasferibile");
    const component = store.createComponent({
      id: "550e8400-e29b-41d4-a716-446655440041",
      ref: "ui/card",
      title: "Scheda dinamica",
      schema: { props: {
        heading: { type: "string", default: "Titolo" },
        visible: { type: "boolean", default: true },
        entries: { type: "array", default: [{ name: "prima" }, { name: "seconda" }] },
      } },
      content: serializeXb(parse('<section><h2>{props.heading.upper()}</h2>{#if props.visible}<ul>{#loop props.entries as entry, index}<li data-index={index}>{entry.name.capitalize()}</li>{/loop}</ul>{:else}<p>Non visibile</p>{/if}{#if slots.default.empty}<p>Nessun extra</p>{:else}<div>{@slot}</div>{/if}</section>').blocks),
    });
    const page = store.listPages()[0]!;
    const content = serializeXb(parse('<Ui.Card heading={page.title} visible={page.slug == "home"}><span>{page.title}</span></Ui.Card>').blocks);
    store.updatePageMetadata(page.id, { title: "Pagina di prova", slug: "home", status: "published" });
    expect(store.saveDocument({ entityId: page.id, expectedHead: store.getHead(page.id)!.id, content }).status).toBe("saved");

    const archive = await encodeStaticPageArchive(project, store);
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile.manifest.profile).toBe("histos-static-project-v1");
    expect(decoded.profile.entities.find((entity) => entity.id === component.id)?.payload.content).toBe(component.content);
    expect(decoded.profile.entities.find((entity) => entity.id === page.id)?.payload.content).toBe(content);
    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-runtime-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    const input = { page: { id: page.id, title: "Pagina di prova", slug: "home", url: "/home/" } };
    const before = await renderCmsPage({ store, projectId: project.id, content, ...input });
    const after = await renderCmsPage({ store: destination.store, projectId: project.id, content: destination.store.getHead(page.id)!.content, ...input });
    expect(after.html).toBe(before.html);
    expect(after.html).toContain("<h2>PAGINA DI PROVA</h2>");
    expect(after.html).toContain('<li data-index="0">Prima</li><li data-index="1">Seconda</li>');
    expect(after.html).toContain("<div><span>Pagina di prova</span></div>");
    destination.store.close();
    store.close();
  });

  it("rejects component props and slot fills the component has not declared", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-bindings-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Controllo componenti");
    store.createComponent({
      id: "550e8400-e29b-41d4-a716-446655440051",
      ref: "ui/card",
      title: "Scheda",
      schema: { props: { heading: { type: "string", default: "Titolo" } } },
      content: serializeXb(parse("<section><h2>{props.heading}</h2></section>").blocks),
    });
    const page = store.listPages()[0]!;
    const save = (source: string): void => {
      const content = serializeXb(parse(source).blocks);
      const result = store.saveDocument({ entityId: page.id, expectedHead: store.getHead(page.id)!.id, content });
      expect(result.status).toBe("saved");
    };
    save('<Ui.Card misspelled="x"/>');
    await expect(encodeStaticPageArchive(project, store)).rejects.toThrow(/prop misspelled non è definita/u);
    save('<Ui.Card heading="Titolo"><span>Riempimento non dichiarato</span></Ui.Card>');
    await expect(encodeStaticPageArchive(project, store)).rejects.toThrow(/slot default non è definito/u);
    save('<Ui.Card heading="Titolo"/>');
    await expect(encodeStaticPageArchive(project, store)).resolves.toBeInstanceOf(Buffer);
    store.close();
  });

  it("round-trips page templates, assigned template refs and reusable template parts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-template-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Template trasferibile");
    const part = store.createTemplatePart({
      id: "550e8400-e29b-41d4-a716-446655440030",
      ref: "site/header",
      title: "Intestazione",
      area: "header",
      content: '<!-- wp:xb/element {"uid":"headertext01","tag":"header"} --><!-- wp:xb/text {"uid":"headertext02","content":"Sito"} /--><!-- /wp:xb/element -->',
    });
    const template = store.createTemplate({
      id: "550e8400-e29b-41d4-a716-446655440031",
      ref: "site/page",
      title: "Pagina",
      content: '<!-- wp:xb/component {"uid":"headpart001","ref":"site/header"} /--><!-- wp:xb/slot {"uid":"pageslot001","name":"default"} /-->',
    });
    const page = store.listPages()[0]!;
    store.updatePageMetadata(page.id, { title: page.title, slug: page.slug, status: "published", templateRef: template.ref });

    const archive = await encodeStaticPageArchive(project, store);
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile.manifest.profile).toBe("histos-static-project-v2");
    expect(decoded.profile.manifest.requiredCapabilities).toContain("templates:definition:v1");
    expect(decoded.profile.entities.map((entity) => entity.kind).sort()).toEqual(["document", "styles", "template", "template-part"]);
    expect(decoded.profile.entities.find((entity) => entity.id === page.id)?.payload.templateRef).toBe("site/page");
    expect(decoded.profile.references).toContainEqual({ ownerId: template.id, blockUid: "headpart001", path: "attrs.ref", targetId: part.id, role: "document" });

    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-template-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    expect(destination.store.listTemplates()).toHaveLength(1);
    expect(destination.store.getTemplateByRef(template.ref)).toMatchObject({ id: template.id, content: template.content, schema: template.schema });
    expect(destination.store.getTemplateByRef(template.ref)?.kind).toBe("template");
    expect(destination.store.listTemplateParts()).toHaveLength(1);
    expect(destination.store.getComponentById(part.id)).toMatchObject({ kind: "template-part", ref: part.ref, content: part.content });
    expect(destination.store.getComponentById(part.id)?.partArea).toBe("header");
    expect(destination.store.listPages().find((entry) => entry.id === page.id)?.templateRef).toBe(template.ref);
    destination.store.close();
    store.close();
  });

  it("porta i template di dettaglio e archivio collegati ai tipi CMS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-type-templates-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { project, store } = await catalog.createProject("Tipi con template");
    const single = store.createTemplate({ ref: "content/event-single", title: "Scheda evento" });
    const archive = store.createTemplate({ ref: "content/event-archive", title: "Archivio eventi" });
    const type = store.content.saveType({
      key: "event", label: "Evento", fields: [{ key: "summary", label: "Sommario", type: "text", public: true }],
      singleTemplateRef: single.ref, archiveTemplateRef: archive.ref, expectedHead: null,
    });
    expect(type.status).toBe("saved");

    const decoded = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    expect(decoded.profile.manifest.profile).toBe("histos-static-project-v3");
    const exportedType = decoded.profile.entities.find((entity) => entity.kind === "content-type");
    expect(exportedType?.payload).toMatchObject({ singleTemplateRef: single.ref, archiveTemplateRef: archive.ref });

    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-type-templates-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    expect(destination.store.content.getType("event")).toMatchObject({ singleTemplateRef: single.ref, archiveTemplateRef: archive.ref });
    store.close();
    destination.store.close();
  });
});

interface MarkupDocumentVector {
  name: string;
  ownerKind: "document" | "component" | "template-part" | "template";
  assets: string[];
  componentRefs?: string[];
  content: string;
  expect: string;
  note?: string;
  references?: Array<{ blockUid: string; path: string; targetId: string; index?: number }>;
}

const markupFixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-transfer-markup-v1.json", import.meta.url), "utf8")) as { documents: MarkupDocumentVector[] };
const markupProfileFixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-markup-v1.json", import.meta.url), "utf8")) as { profile: StaticPageProfile; files: Record<string, string> };

describe("histos-transfer-markup-v1 nei documenti trasferiti", () => {
  it.each(markupFixture.documents.map((vector) => [`${vector.name} → ${vector.expect}`, vector] as const))("documento della fixture condivisa: %s", (_name, vector) => {
    let reason = "accept";
    let references: ReturnType<typeof validateTransferDocument> = [];
    try {
      references = validateTransferDocument(vector.content, { ownerKind: vector.ownerKind, assetIds: vector.assets, componentRefs: vector.componentRefs ?? [] });
    } catch (error) {
      if (!(error instanceof TransferMarkupError)) throw error;
      reason = error.reason;
    }
    expect(reason).toBe(vector.expect);
    if (vector.expect === "accept") {
      expect(references.map(({ blockUid, path: referencePath, targetId, index }) => ({ blockUid, path: referencePath, targetId, ...(index === undefined ? {} : { index }) }))).toEqual(vector.references ?? []);
    }
  });

  it("un loop a gruppi sul risultato di una query viaggia con source.groupBy, e solo valido (voce 187)", async () => {
    const content = (source: string) => serializeXb(parse(source).blocks);
    expect(validateTransferDocument(content('{#loop main().groupBy("date", "Y") as anno}<h2>{anno.key}</h2>{#loop anno.items as post}<p>{post.title}</p>{/loop}{/loop}'))).toEqual([]);
    expect(validateTransferDocument(content('{#loop main().groupBy("title", "letter") as l}<h2>{l.key}</h2>{/loop}'))).toEqual([]);
    const loop = (groupBy: unknown) => `<!-- wp:xb/loop ${JSON.stringify({ uid: "grouploop01", source: { kind: "preset", id: "main", groupBy }, as: "g" })} --><!-- wp:xb/text {"uid":"grouptext01","content":"{g.key}"} /--><!-- /wp:xb/loop -->`;
    expect(validateTransferDocument(loop({ field: "fields.anno", how: "F Y" }))).toEqual([]);
    for (const groupBy of [{ field: "a b" }, { field: "" }, { field: "anno", how: "" }, { field: "anno", how: 4 }, { field: "anno", order: "desc" }, "anno"]) {
      expect(() => validateTransferDocument(loop(groupBy)), JSON.stringify(groupBy)).toThrow(/raggruppamento della query non valido/u);
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-loop-group-"));
    roots.push(root);
    const { project, store } = await new CmsProjectCatalog(root).createProject("Loop a gruppi");
    store.content.saveType({ key: "foto", label: "Foto", expectedHead: null, fields: [] });
    store.content.saveQueryPreset({ key: "foto_recenti", label: "Foto recenti", typeKey: "foto", limit: 20, expectedHead: null });
    const page = store.listPages()[0]!;
    const plain = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    expect(profileUsesLoopGroup(plain.profile)).toBe(false);
    const grouped = content('<main>{#loop foto_recenti(limit: 20).groupBy("publishedAt", "Y") as anno}<h2>{anno.key}</h2>{/loop}</main>');
    expect(store.saveDocument({ entityId: page.id, expectedHead: store.getHead(page.id)!.id, content: grouped }).status).toBe("saved");
    const decoded = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    expect(profileUsesLoopGroup(decoded.profile)).toBe(true);
    const sent = decoded.profile.entities.find((entity) => entity.id === page.id)?.payload.content;
    expect(sent).toContain('"source":{"kind":"preset","id":"foto_recenti","args":{"limit":"20"},"groupBy":{"field":"publishedAt","how":"Y"}}');
    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-loop-group-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    expect(destination.store.getHead(page.id)?.content).toBe(store.getHead(page.id)?.content);
    destination.store.close();
    store.close();
  });

  it("il {:else} di un loop non vede la variabile né l'indice del loop, ma vede gli scope intorno (D1)", () => {
    const content = (source: string) => serializeXb(parse(source).blocks);
    expect(validateTransferDocument(content("<ul>{#loop page.items as voce, i}<li>{voce.title}</li>{:else}<li>{page.title}: nessuna voce</li>{/loop}</ul>"))).toEqual([]);
    for (const reference of ["{voce.title}", "{i}"]) {
      expect(() => validateTransferDocument(content(`<ul>{#loop page.items as voce, i}<li>{voce.title}</li>{:else}<li>${reference}</li>{/loop}</ul>`)), reference).toThrow(/non ha uno scope portabile/u);
    }
    expect(() => validateTransferDocument(content("{#loop page.items as voce}<p>{voce.title}</p>{:else}{#if voce}<p>x</p>{/if}{/loop}"))).toThrow(/non ha uno scope portabile/u);
    expect(validateTransferDocument(content("{#loop props.voci as voce}<p>{voce}</p>{:else}<p>{props.vuoto}</p>{/loop}"), { ownerKind: "component" })).toEqual([]);
  });

  it("codifica la fixture di profilo con SVG, picture, details e testo dei campi senza cambiarne i byte e la importa", async () => {
    const files = new Map(Object.entries(markupProfileFixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
    expect(profileUsesTransferMarkupV1(markupProfileFixture.profile)).toBe(true);
    const decoded = await decodeStaticPageArchive(await encodeStaticPageProfileArchive(markupProfileFixture.profile, files));
    expect(decoded.profile).toEqual(markupProfileFixture.profile);
    for (const [name, bytes] of files) expect(decoded.files.get(name)).toEqual(bytes);

    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-markup-fixture-"));
    roots.push(root);
    const { project, store } = await new CmsProjectCatalog(root).importStaticPageProfile(decoded.profile, decoded.files);
    try {
      const page = store.listPages()[0]!;
      const content = store.getHead(page.id)!.content;
      expect(content).toContain(`/__cms-media/${project.id}/550e8400-e29b-41d4-a716-446655440064 1x, /__cms-media/${project.id}/550e8400-e29b-41d4-a716-446655440065 2x`);
      const body = /<body>([\s\S]*)<\/body>/u.exec((await renderCmsPage({ store, projectId: project.id, content, mediaBase: "/media" })).html)?.[1] ?? "";
      expect(body).toContain('<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" focusable="false" role="img"><title>Cerca</title><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>');
      expect(body).toContain(`<source type="image/png" srcset="/media/${project.id}/550e8400-e29b-41d4-a716-446655440064 1x, /media/${project.id}/550e8400-e29b-41d4-a716-446655440065 2x">`);
      expect(body).toContain('<details name="faq"><summary>Domanda</summary><p>Risposta</p></details>');
      expect(body).toContain('<textarea name="note" rows="3">Scrivi qui</textarea>');
    } finally {
      store.close();
    }
  });

  it("porta icone, moduli, select con loop, details e picture con srcset dei media del progetto e li renderizza uguali", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-markup-"));
    roots.push(root);
    const { project, store } = await new CmsProjectCatalog(root).createProject("Markup trasferibile");
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const small = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "foto.png", alt: "Foto" });
    const large = store.saveAsset({ bytes: new Uint8Array([...png, 0]), mimeType: "image/png", filename: "foto-2x.png", alt: "Foto grande" });
    const media = (asset: { id: string }) => `/__cms-media/${project.id}/${asset.id}`;
    const icon = store.createComponent({
      id: "550e8400-e29b-41d4-a716-446655440071", ref: "ui/icona", title: "Icona",
      schema: { props: { label: { type: "string", default: "Icona" } } },
      content: serializeXb(parse('<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" aria-hidden="true" focusable="false"><title>{props.label}</title><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>').blocks),
    });
    const newsletter = store.createComponent({
      id: "550e8400-e29b-41d4-a716-446655440072", ref: "ui/newsletter", title: "Newsletter",
      schema: { props: { temi: { type: "array", default: [{ slug: "arte", label: "Arte" }, { slug: "libri", label: "Libri" }] } } },
      content: serializeXb(parse('<form action="https://newsletter.example.org/iscrizione" method="post"><input type="email" name="email" autocomplete="email" required><select name="tema">{#loop props.temi as tema}<option value={tema.slug}>{tema.label}</option>{/loop}</select><textarea name="note" rows="3">Scrivi qui: "grazie" > \'ciao\'</textarea><button type="submit">Iscriviti</button></form>').blocks),
    });
    const page = store.listPages()[0]!;
    const content = serializeXb(parse([
      '<header><Ui.Icona label="Cerca"/><button type="button" aria-expanded="false">Menu</button></header>',
      '<form action="/cerca/" method="get" role="search"><label for="q">Cerca</label><input id="q" type="search" name="q"><button type="submit">Vai</button></form>',
      "<Ui.Newsletter/>",
      '<details name="faq"><summary>Domanda</summary><p>Risposta</p></details>',
      `<picture><source type="image/png" srcset="${media(small)} 1x, ${media(large)} 2x"><source srcset="${media(large)}"><img src="${media(small)}" srcset="${media(small)} 480w, ${media(large)} 960w" sizes="100vw" alt="Foto"></picture>`,
    ].join("")).blocks);
    expect(store.saveDocument({ entityId: page.id, expectedHead: store.getHead(page.id)!.id, content }).status).toBe("saved");

    const decoded = await decodeStaticPageArchive(await encodeStaticPageArchive(project, store));
    expect(profileUsesTransferMarkupV1(decoded.profile)).toBe(true);
    const srcsetReferences = decoded.profile.references.filter((reference) => reference.path === "attrs.attributes.srcset");
    expect(srcsetReferences.map((reference) => [reference.targetId, reference.index])).toEqual(expect.arrayContaining([[small.id, 0], [large.id, 1], [large.id, 0], [small.id, 0], [large.id, 1]]));
    expect(srcsetReferences).toHaveLength(5);
    const exportedPage = decoded.profile.entities.find((entity) => entity.id === page.id)!;
    expect(exportedPage.payload.content).toContain(`histos-media://${small.id} 1x, histos-media://${large.id} 2x`);
    expect(exportedPage.payload.content).not.toContain("/__cms-media/");

    const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-markup-destination-"));
    roots.push(destinationRoot);
    const destination = await new CmsProjectCatalog(destinationRoot).importStaticPageProfile(decoded.profile, decoded.files);
    try {
      expect(destination.store.getHead(page.id)?.content).toBe(content);
      expect(destination.store.getComponentById(icon.id)?.content).toBe(icon.content);
      expect(destination.store.getComponentById(newsletter.id)?.content).toBe(newsletter.content);
      const input = { page: { id: page.id, title: "Home", slug: "home", url: "/" } };
      const before = await renderCmsPage({ store, projectId: project.id, content, ...input });
      const after = await renderCmsPage({ store: destination.store, projectId: project.id, content: destination.store.getHead(page.id)!.content, ...input });
      expect(after.html).toBe(before.html);
      expect(after.html).toContain('<svg viewBox="0 0 24 24"');
      expect(after.html).toContain("<title>Cerca</title>");
      expect(after.html).toContain('<option value="arte">Arte</option><option value="libri">Libri</option>');
      // The textarea text is printed as written, escaped as esc_textarea does.
      expect(after.html).toContain('<textarea name="note" rows="3">Scrivi qui: &quot;grazie&quot; &gt; &#039;ciao&#039;</textarea>');
      expect(after.formCount).toBe(2);
    } finally {
      destination.store.close();
      store.close();
    }
  });

  it("rifiuta all'esportazione immagini esterne, srcset fuori dalla libreria media e override del modulo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-transfer-markup-refusals-"));
    roots.push(root);
    const { project, store } = await new CmsProjectCatalog(root).createProject("Rifiuti markup");
    const asset = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "a.png", alt: "A" });
    const page = store.listPages()[0]!;
    const save = (source: string) => expect(store.saveDocument({ entityId: page.id, expectedHead: store.getHead(page.id)!.id, content: serializeXb(parse(source).blocks) }).status).toBe("saved");
    const reason = async (): Promise<string> => {
      try {
        await createStaticPageProfile(project, store);
        return "accept";
      } catch (error) {
        return error instanceof TransferMarkupError ? error.reason : (error as Error).message;
      }
    };
    try {
      save('<img src="https://example.org/foto.png" alt="">');
      expect(await reason()).toBe("media");
      save(`<img src="/__cms-media/${project.id}/${asset.id}" srcset="https://cdn.example/foto-2x.png 2x" alt="">`);
      expect(await reason()).toBe("media");
      save(`<picture><source srcset="/immagini/a.avif"><img src="/__cms-media/${project.id}/${asset.id}" alt=""></picture>`);
      expect(await reason()).toBe("media");
      save('<form action="/invio" method="post"><button formmethod="get">Invia</button></form>');
      expect(await reason()).toBe("attribute");
      save('<form action="/invio"><button>Invia</button></form>');
      expect(await reason()).toBe("form");
      save(`<img src="/__cms-media/${project.id}/${asset.id}" srcset="/__cms-media/${project.id}/${asset.id} 2x" alt="">`);
      expect(await reason()).toBe("accept");
    } finally {
      store.close();
    }
  });

  it("rifiuta un riferimento srcset il cui indice punta alla sorgente sbagliata", async () => {
    const tampered = structuredClone(markupProfileFixture.profile);
    const files = new Map(Object.entries(markupProfileFixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
    const srcset = tampered.references.filter((reference) => reference.blockUid === "markup000011" && reference.path === "attrs.attributes.srcset");
    expect(srcset.map((reference) => reference.index)).toEqual([0, 1]);
    srcset[0]!.index = 1;
    srcset[1]!.index = 0;
    const references = Buffer.from(`${tampered.references.map((reference) => canonicalizeJson(reference)).join("\n")}\n`, "utf8");
    files.set("references.ndjson", references);
    const { manifestHash: _ignored, ...manifestBase } = tampered.manifest;
    manifestBase.files = manifestBase.files.map((file) => file.path === "references.ndjson" ? { ...file, bytes: references.byteLength, sha256: createHash("sha256").update(references).digest("hex") } : file);
    tampered.manifest = { ...manifestBase, manifestHash: createHash("sha256").update(manifestHashInput(manifestBase), "utf8").digest("hex") };
    await expect(encodeStaticPageProfileArchive(tampered, files)).rejects.toThrow(/riferimenti del documento .* non corrispondono/u);
    const archive = await zip([
      { name: "site.json", bytes: Buffer.from(canonicalizeJson(tampered.manifest), "utf8") },
      ...[...files].map(([name, bytes]) => ({ name, bytes })),
    ]);
    await expect(decodeStaticPageArchive(archive)).rejects.toThrow(/riferimenti del documento .* non corrispondono/u);
  });
});

describe("archivio non leggibile (E13)", () => {
  it("dice in italiano che il file è rotto e tiene l'errore della libreria come causa", async () => {
    const { UnreadableArchiveError } = await import("../src/page-transfer.js");
    const { decodeNativeProjectArchive } = await import("../src/project-archive.js");
    for (const decode of [decodeStaticPageArchive, decodeNativeProjectArchive]) {
      const error = await decode(Buffer.from("non è uno zip, è un file troncato")).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(UnreadableArchiveError);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("Il file non è un archivio ZIP leggibile: forse è incompleto o danneggiato.");
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });
});
