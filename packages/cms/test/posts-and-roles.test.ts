import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { StaticPageProfile } from "@histos-publish/histos-contract";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeXb, parse } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog, type CmsProjectStore } from "../src/project-repository.js";
import { createDraftImportProfile, createStaticPageProfile, decodeStaticPageArchive, encodeStaticPageProfileArchive } from "../src/page-transfer.js";
import { decodeNativeProjectArchive, encodeNativeProjectArchive } from "../src/project-archive.js";
import { renderCmsPage, postContentWithImage } from "../src/static-renderer.js";
import { createHash } from "node:crypto";
import { canonicalRevisionPayload, validateStaticPageProfile } from "@histos-publish/histos-contract";

const temporaryDirectories: string[] = [];
const remoteSiteId = "550e8400-e29b-41d4-a716-446655440299";

async function newCatalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-posts-"));
  temporaryDirectories.push(root);
  return new CmsProjectCatalog(root);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A project with categories and tags, two posts, a single template with a role and a query over posts. */
function seedBlog(store: CmsProjectStore): { categoryTerm: string; tagTerm: string; postId: string; draftId: string } {
  for (const [key, label] of [["category", "Categorie"], ["post_tag", "Tag"]] as const) {
    const saved = store.content.saveTaxonomy({ key, label, types: ["post"], expectedHead: null });
    if (saved.status !== "saved") throw new Error("Tassonomia non creata.");
  }
  const category = store.content.saveTerm({ taxonomyKey: "category", slug: "notizie", label: "Notizie", expectedHead: null });
  const tag = store.content.saveTerm({ taxonomyKey: "post_tag", slug: "sicurezza", label: "Sicurezza", expectedHead: null });
  if (category.status !== "saved" || tag.status !== "saved") throw new Error("Termini non creati.");
  const template = store.createTemplate({ ref: "theme-template/single", title: "Articolo", content: serializeXb(parse("<article>{@slot}</article>").blocks) });
  store.setTemplateRole(template.id, "single");
  const post = store.createPost({ title: "Primo articolo", status: "published", publishedAt: "2026-10-25T10:00:00Z", excerpt: "Breve.", terms: { category: [category.term.id], post_tag: [tag.term.id] } });
  const draft = store.createPost({ title: "Bozza", templateRef: "theme-template/single" });
  const preset = store.content.saveQueryPreset({ key: "ultimi", label: "Ultimi articoli", typeKey: "post", limit: 5, orderBy: "publishedAt", order: "desc", filter: { taxonomyKey: "category", termIds: [category.term.id], operator: "IN" }, expectedHead: null });
  if (preset.status !== "saved") throw new Error("Query non salvata.");
  return { categoryTerm: category.term.id, tagTerm: tag.term.id, postId: post.id, draftId: draft.id };
}

describe("articoli e ruoli dei modelli nel progetto CMS", () => {
  it("valida articoli, termini, ruoli e chiavi riservate nello store", async () => {
    const catalog = await newCatalog();
    const { store } = await catalog.createProject("Blog");
    try {
      const seeded = seedBlog(store);
      expect(store.listPages().map((page) => page.slug)).toEqual(["home"]);
      expect(store.listPosts().map((post) => post.slug)).toEqual(["primo-articolo", "bozza"]);
      expect(store.getPostTermIds(seeded.postId)).toEqual({ category: [seeded.categoryTerm], post_tag: [seeded.tagTerm] });
      expect(store.getEntityById(seeded.draftId)).toMatchObject({ documentType: "post", publishedAt: null, status: "draft" });
      expect(() => store.createPost({ title: "Data", status: "published", publishedAt: "2026-02-30T10:00:00Z" })).toThrow(/data/u);
      expect(() => store.createPost({ title: "Data", status: "published", publishedAt: "2026-10-25T10:00:00.000Z" })).toThrow(/data/u);
      expect(() => store.createPost({ title: "Termini", terms: { category: [seeded.tagTerm] } })).toThrow(/tassonomia category/u);
      expect(() => store.createPost({ title: "Primo articolo" })).toThrow(/slug primo-articolo/u);
      expect(() => store.createPost({ title: "Lungo", excerpt: "x".repeat(20_001) })).toThrow(/riassunto/u);
      // A page and a post may share a slug: they live at different addresses.
      expect(store.createPage({ title: "Primo articolo" }).slug).toBe("primo-articolo");
      const other = store.createTemplate({ ref: "theme-template/other", title: "Altro" });
      expect(() => store.setTemplateRole(other.id, "single")).toThrow(/già del template/u);
      expect(() => store.setTemplateRole(other.id, "author" as never)).toThrow(/non valido/u);
      expect(() => store.content.saveType({ key: "post", label: "Articoli", fields: [], expectedHead: null })).toThrow(/riservata/u);
      expect(() => store.content.saveTaxonomy({ key: "post_tag", label: "Tag", types: [], expectedHead: null })).toThrow(/articoli/u);
      expect(store.content.resolveQueryPreset("ultimi").map((item) => ({ slug: item.slug, url: item.url }))).toEqual([{ slug: "primo-articolo", url: "/blog/primo-articolo/" }]);
      expect(() => store.content.saveQueryPreset({ key: "campi", label: "Campi", typeKey: "post", filter: { field: "title", op: "eq", value: "x" }, expectedHead: null })).toThrow(/soltanto per categorie/u);
    } finally { store.close(); }
  });

  it("dà agli articoli un'immagine in evidenza che i loop leggono come post.image e che il profilo porta (doc 23, voce 119)", async () => {
    const origin = await newCatalog();
    const { project, store } = await origin.createProject("Blog con immagini");
    try {
      const seeded = seedBlog(store);
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const photo = store.saveAsset({ bytes: png, mimeType: "image/png", filename: "copertina.png", alt: "Copertina" });
      const pdf = store.saveAsset({ bytes: new TextEncoder().encode("%PDF-1.7"), mimeType: "application/pdf", filename: "bando.pdf" });
      const post = store.getEntityById(seeded.postId)!;
      expect(post.imageAssetId).toBeNull();
      expect(() => store.updatePostMetadata(post.id, { title: post.title, slug: post.slug, status: post.status, imageAssetId: pdf.id })).toThrow(/deve essere un'immagine/u);
      expect(() => store.updatePostMetadata(post.id, { title: post.title, slug: post.slug, status: post.status, imageAssetId: "550e8400-e29b-41d4-a716-446655440999" })).toThrow(/non è fra i media/u);
      expect(store.updatePostMetadata(post.id, { title: post.title, slug: post.slug, status: post.status, imageAssetId: photo.id }).imageAssetId).toBe(photo.id);
      // Left out, the image stays; the asset counts as used.
      expect(store.updatePostMetadata(post.id, { title: post.title, slug: post.slug, status: post.status, excerpt: "Altro." }).imageAssetId).toBe(photo.id);
      expect(store.usedAssetIds().has(photo.id)).toBe(true);

      const loop = serializeXb(parse('{#loop ultimi() as post}<img src={post.image.url} alt={post.image.alt}><p>{post.image.title}</p>{/loop}').blocks);
      const rendered = await renderCmsPage({ store, projectId: project.id, content: loop, mediaBase: "/__cms-media" });
      expect(rendered.html).toContain(`<img src="/__cms-media/${project.id}/${photo.id}" alt="Copertina">`);
      expect(rendered.html).toContain("<p>copertina.png</p>");

      // Doc 23 item 177: without a template the image shows once above the text, as an import from WordPress had it;
      // with a template it is the template's to place. The stored text never changes.
      const text = serializeXb(parse("<p>Testo</p>").blocks);
      const shown = await renderCmsPage({ store, projectId: project.id, content: postContentWithImage(text, photo.id, false, store, project.id), mediaBase: "/__cms-media" });
      expect(shown.html.match(/<img /gu)).toHaveLength(1);
      expect(shown.html.indexOf(`src="/__cms-media/${project.id}/${photo.id}" alt="Copertina"`)).toBeLessThan(shown.html.indexOf("Testo"));
      expect(postContentWithImage(text, photo.id, true, store, project.id)).toBe(text);
      expect(postContentWithImage(text, null, false, store, project.id)).toBe(text);

      const exported = await createStaticPageProfile(project, store);
      const payloadOf = (profile: StaticPageProfile, id: string) => profile.entities.find((entity) => entity.id === id)!.payload;
      expect(payloadOf(exported.profile, post.id).image).toBe(photo.id);
      // A post without an image has no key: its fingerprint is the one it always had.
      expect(Object.hasOwn(payloadOf(exported.profile, seeded.draftId), "image")).toBe(false);
      const decoded = await decodeStaticPageArchive(await encodeStaticPageProfileArchive(exported.profile, exported.files));
      const receiving = await newCatalog();
      const imported = await receiving.importStaticPageProfile(decoded.profile, decoded.files);
      try {
        expect(imported.store.getEntityById(post.id)?.imageAssetId).toBe(photo.id);
        const again = await createStaticPageProfile(imported.project, imported.store);
        const hashes = (profile: StaticPageProfile) => Object.fromEntries(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
        expect(hashes(again.profile)).toEqual(hashes(exported.profile));
      } finally { imported.store.close(); }

      // The contract refuses an image that is not an image asset of the profile.
      const tampered = structuredClone(exported.profile);
      const entity = tampered.entities.find((candidate) => candidate.id === post.id)!;
      entity.payload.image = pdf.id;
      entity.revisionHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
      expect(() => validateStaticPageProfile(tampered)).toThrow(/immagine dell'articolo/u);

      // null takes it away, and the key leaves the profile.
      expect(store.updatePostMetadata(post.id, { title: post.title, slug: post.slug, status: post.status, imageAssetId: null }).imageAssetId).toBeNull();
      expect(Object.hasOwn(payloadOf((await createStaticPageProfile(project, store)).profile, post.id), "image")).toBe(false);
    } finally { store.close(); }
  });

  it("esporta il profilo v4 e lo reimporta identico in un progetto nuovo", async () => {
    const origin = await newCatalog();
    const { project, store } = await origin.createProject("Blog esportato");
    try {
      seedBlog(store);
      const exported = await createStaticPageProfile(project, store);
      expect(exported.profile.manifest.profile).toBe("histos-static-project-v4");
      expect(exported.profile.manifest.requiredCapabilities).toEqual(expect.arrayContaining(["documents:post:v1", "templates:roles:v1", "content:taxonomies:v1", "content:queries:v1"]));
      const post = exported.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === "primo-articolo");
      expect(post?.payload).toMatchObject({ documentType: "post", status: "published", publishedAt: "2026-10-25T10:00:00Z", excerpt: "Breve." });
      expect(exported.profile.entities.find((entity) => entity.kind === "template")?.payload.role).toBe("single");
      const draft = createDraftImportProfile(exported.profile, exported.files);
      expect(draft.profile.entities.find((entity) => entity.id === post?.id)?.payload).toMatchObject({ status: "draft", publishedAt: null });

      const archive = await encodeStaticPageProfileArchive(exported.profile, exported.files);
      const decoded = await decodeStaticPageArchive(archive);
      const receiving = await newCatalog();
      const imported = await receiving.importStaticPageProfile(decoded.profile, decoded.files);
      try {
        const again = await createStaticPageProfile(imported.project, imported.store);
        const hashes = (profile: typeof exported.profile) => Object.fromEntries(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
        expect(hashes(again.profile)).toEqual(hashes(exported.profile));
      } finally { imported.store.close(); }
    } finally { store.close(); }
  });

  it("importa il fixture WordPress v4 e lo riesporta con gli stessi hash", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-project-v4.json", import.meta.url), "utf8")) as { profile: StaticPageProfile; files: Record<string, string> };
    const files = new Map(Object.entries(fixture.files).map(([name, value]) => [name, Buffer.from(value, "base64")]));
    const catalog = await newCatalog();
    const imported = await catalog.importStaticPageProfile(fixture.profile, files, remoteSiteId);
    try {
      expect(imported.store.listPosts().map((post) => post.status).sort()).toEqual(["draft", "published"]);
      const roles = imported.store.listTemplates().map((template) => template.role).filter(Boolean).sort();
      expect(roles).toEqual(["archive", "single"]);
      const again = await createStaticPageProfile(imported.project, imported.store, undefined, remoteSiteId);
      // Templates come back with the explicit status Publish always writes; everything else, posts included, is identical.
      const hashes = (profile: StaticPageProfile) => Object.fromEntries(profile.entities.filter((entity) => entity.kind !== "template").map((entity) => [entity.id, entity.revisionHash]));
      expect(hashes(again.profile)).toEqual(hashes(fixture.profile));
      const templates = (profile: StaticPageProfile) => Object.fromEntries(profile.entities.filter((entity) => entity.kind === "template").map(({ id, payload: { status: _status, ...payload } }) => [id, payload]));
      expect(templates(again.profile)).toEqual(templates(fixture.profile));
    } finally { imported.store.close(); }
  });

  it("scarica articoli, termini nuovi e ruoli spostati da un sito remoto", async () => {
    const remote = await newCatalog();
    const local = await newCatalog();
    const { project, store: remoteStore } = await remote.createProject("Blog remoto");
    try {
      const seeded = seedBlog(remoteStore);
      const first = await createStaticPageProfile(project, remoteStore);
      const imported = await local.importStaticPageProfile(first.profile, first.files, remoteSiteId);
      imported.store.close();

      // On the remote site: a new tag on the post, the single role moved to another template, a new post.
      const tag = remoteStore.content.saveTerm({ taxonomyKey: "post_tag", slug: "novita", label: "Novità", expectedHead: null });
      if (tag.status !== "saved") throw new Error("Termine non creato.");
      const post = remoteStore.getEntityById(seeded.postId)!;
      remoteStore.updatePostMetadata(post.id, { title: post.title, slug: post.slug, status: "published", terms: { category: [seeded.categoryTerm], post_tag: [tag.term.id] } });
      const moved = remoteStore.createTemplate({ ref: "theme-template/single-new", title: "Articolo nuovo" });
      remoteStore.setTemplateRole(remoteStore.getTemplateByRole("single")!.id, null);
      remoteStore.setTemplateRole(moved.id, "single");
      remoteStore.createPost({ title: "Secondo", status: "published", publishedAt: "2026-10-26T08:30:00Z", terms: { post_tag: [tag.term.id] } });
      const second = await createStaticPageProfile(project, remoteStore);

      const applied = await local.importRemoteStaticPageProfile(second.profile, second.files, remoteSiteId);
      expect(applied.changed).toContain(seeded.postId);
      const reopened = await local.openProject(project.id);
      if (!reopened) throw new Error("Progetto locale non riaperto.");
      try {
        expect(reopened.store.getPostTermIds(seeded.postId)).toEqual({ category: [seeded.categoryTerm], post_tag: [tag.term.id] });
        expect(reopened.store.listPosts().map((item) => item.slug)).toEqual(["secondo", "primo-articolo", "bozza"]);
        expect(reopened.store.getTemplateByRole("single")?.ref).toBe("theme-template/single-new");
        const after = await createStaticPageProfile(reopened.project, reopened.store);
        const hashes = (profile: typeof second.profile) => Object.fromEntries(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
        expect(hashes(after.profile)).toEqual(hashes(second.profile));
      } finally { reopened.store.close(); }
    } finally { remoteStore.close(); }
  });

  it("ripristina un backup nativo con articoli e rifiuta un articolo alterato", async () => {
    const origin = await newCatalog();
    const { project, store } = await origin.createProject("Backup blog");
    let archive: Buffer;
    try {
      seedBlog(store);
      archive = await encodeNativeProjectArchive(project, store);
    } finally { store.close(); }
    const restoredCatalog = await newCatalog();
    const restored = await restoredCatalog.importNativeProjectBackup(await decodeNativeProjectArchive(archive));
    try {
      expect(restored.store.listPosts()).toHaveLength(2);
      expect(restored.store.getTemplateByRole("single")?.ref).toBe("theme-template/single");
    } finally { restored.store.close(); }

    const decoded = await decodeNativeProjectArchive(archive);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "histos-cms-posts-db-"));
    temporaryDirectories.push(scratch);
    const databasePath = path.join(scratch, "content.sqlite");
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(databasePath, decoded.files.get("content.sqlite")!);
    const database = new DatabaseSync(databasePath);
    database.exec("UPDATE entities SET slug = '../../escape' WHERE document_type = 'post' AND status = 'draft'");
    database.close();
    decoded.files.set("content.sqlite", await readFile(databasePath));
    await expect((await newCatalog()).importNativeProjectBackup(decoded)).rejects.toThrow(/articolo non valido/u);
  });

  it("apre un progetto della 1.23.0 (schema 5): aggiunge l'immagine degli articoli e i tipi senza pagine", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Della 1.23.0");
    store.content.saveType({ key: "foto", label: "Foto", fields: [], expectedHead: null });
    const post = store.createPost({ title: "Prima" });
    store.close();
    // The tables as Publish 1.23.0 left them, at schema version 5.
    const database = new DatabaseSync(path.join(project.directory, "content.sqlite"));
    database.exec("ALTER TABLE entities DROP COLUMN image_asset_id; ALTER TABLE cms_content_types DROP COLUMN is_public; PRAGMA user_version = 5;");
    database.close();
    const reopened = await catalog.openProject(project.id);
    if (!reopened) throw new Error("Progetto non riaperto dopo la migrazione.");
    try {
      const photo = reopened.store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "copertina.png", alt: "Copertina" });
      const current = reopened.store.getEntityById(post.id)!;
      expect(reopened.store.updatePostMetadata(post.id, { title: current.title, slug: current.slug, status: current.status, imageAssetId: photo.id }).imageAssetId).toBe(photo.id);
      expect(reopened.store.listPosts().map((item) => item.title)).toEqual(["Prima"]);
      const type = reopened.store.content.listTypes().find((item) => item.key === "foto")!;
      expect(type.public).toBe(true);
      const saved = reopened.store.content.saveType({ id: type.id, key: "foto", label: "Foto", fields: [], public: false, expectedHead: type.headRevision });
      expect(saved, JSON.stringify(saved)).toMatchObject({ status: "saved" });
      expect(reopened.store.content.listTypes().find((item) => item.key === "foto")?.public).toBe(false);
    } finally { reopened.store.close(); }
  });

  it("migra un database della versione 2 senza perdere query, tassonomie e template", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Da migrare");
    const type = store.content.saveType({ key: "evento", label: "Eventi", fields: [], expectedHead: null });
    if (type.status !== "saved") throw new Error("Tipo non creato.");
    store.content.saveTaxonomy({ key: "luogo", label: "Luoghi", types: ["evento"], expectedHead: null });
    store.content.saveQueryPreset({ key: "eventi", label: "Eventi", typeKey: "evento", limit: 3, expectedHead: null });
    store.createTemplate({ ref: "site/page", title: "Pagina" });
    store.close();
    // Bring the tables back to their version 2 shape.
    const database = new DatabaseSync(path.join(project.directory, "content.sqlite"));
    database.exec(`
      DROP INDEX cms_components_template_role;
      DROP INDEX entities_document_locale;
      ALTER TABLE cms_components DROP COLUMN template_role;
      ALTER TABLE entities DROP COLUMN document_type;
      ALTER TABLE entities DROP COLUMN published_at;
      ALTER TABLE entities DROP COLUMN excerpt;
      ALTER TABLE cms_taxonomies DROP COLUMN for_posts;
      DROP TABLE cms_post_terms;
      CREATE TABLE cms_query_presets_v2(key TEXT PRIMARY KEY, label TEXT NOT NULL, type_id TEXT NOT NULL REFERENCES cms_content_types(id), limit_no INTEGER NOT NULL CHECK(limit_no BETWEEN 1 AND 100), limit_param TEXT, offset_no INTEGER NOT NULL DEFAULT 0 CHECK(offset_no BETWEEN 0 AND 1000000), offset_param TEXT, order_by TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('asc','desc')), filter_json TEXT, head_revision TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO cms_query_presets_v2 SELECT key,label,type_id,limit_no,limit_param,offset_no,offset_param,order_by,direction,filter_json,head_revision,updated_at FROM cms_query_presets;
      DROP TABLE cms_query_presets;
      ALTER TABLE cms_query_presets_v2 RENAME TO cms_query_presets;
      PRAGMA user_version = 2;
    `);
    database.close();
    const reopened = await catalog.openProject(project.id);
    if (!reopened) throw new Error("Progetto non riaperto dopo la migrazione.");
    try {
      expect(reopened.store.listPages()).toHaveLength(1);
      expect(reopened.store.listPosts()).toEqual([]);
      expect(reopened.store.content.listQueryPresets().presets.map((preset) => [preset.key, preset.typeKey])).toEqual([["eventi", "evento"]]);
      expect(reopened.store.content.listTaxonomies()).toMatchObject([{ key: "luogo", types: ["evento"] }]);
      expect(reopened.store.listTemplates()).toMatchObject([{ ref: "site/page", role: null }]);
      reopened.store.createPost({ title: "Dopo la migrazione" });
      expect(reopened.store.listPosts()).toHaveLength(1);
    } finally { reopened.store.close(); }
  });
});
