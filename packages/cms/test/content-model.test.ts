import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";

const roots: string[] = [];

const stores: Array<{ close(): void }> = [];

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-relational-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  const created = await catalog.createProject("Contenuti relazionali");
  stores.push(created.store);
  // An Italian project on any computer: a record saved without a locale is in the project's language, and these
  // tests query and render it-IT (record-locale-default.test.ts is about the default itself).
  created.store.setRenderSettings({ ...created.store.getRenderSettings(), locale: "it-IT" });
  return { catalog, ...created };
}

afterEach(async () => {
  // Windows cannot delete a SQLite file that is still open.
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed by the test */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe("CMS relazionale locale", () => {
  it("versiona i template di dettaglio e archivio e li ricarica da SQLite", async () => {
    const { catalog, project: site, store } = await project();
    const type = store.content.saveType({
      key: "event",
      label: "Evento",
      expectedHead: null,
      singleTemplateRef: "site/event-single",
      archiveTemplateRef: "site/event-archive",
      fields: [{ key: "summary", label: "Sommario", type: "text", public: true }],
    });
    expect(type.status).toBe("saved");
    if (type.status !== "saved") throw new Error("Il tipo avrebbe dovuto essere salvato.");
    expect(type.contentType).toMatchObject({ singleTemplateRef: "site/event-single", archiveTemplateRef: "site/event-archive" });
    const { id } = site;
    store.close();
    const reopened = await catalog.openProject(id);
    expect(reopened?.store.content.getType("event")).toMatchObject({ singleTemplateRef: "site/event-single", archiveTemplateRef: "site/event-archive" });
    expect(() => reopened?.store.content.saveType({ id: type.contentType.id, key: "event", label: "Evento", fields: type.contentType.fields, singleTemplateRef: "Site/invalid ref", expectedHead: type.contentType.headRevision })).toThrow(/riferimento template/u);
    reopened?.store.close();
  });

  it("salva tipi versionati e record tipizzati, filtra i campi privati e persiste in SQLite", async () => {
    const { catalog, project: site, store } = await project();
    const savedType = store.content.saveType({
      key: "article",
      label: "Articolo",
      expectedHead: null,
      fields: [
        { key: "summary", label: "Sommario", type: "text", required: true, public: true },
        { key: "rating", label: "Valutazione", type: "integer", public: true },
        { key: "featured", label: "In evidenza", type: "boolean", public: true },
        { key: "editor_note", label: "Nota redazione", type: "text", public: false },
        { key: "tags", label: "Tag", type: "enum", multiple: true, public: true, options: ["cms", "histos"] },
      ],
    });
    expect(savedType.status).toBe("saved");
    if (savedType.status !== "saved") throw new Error("Il tipo avrebbe dovuto essere salvato.");

    const published = store.content.createRecord({
      typeKey: "article", title: "SQLite relazionale", locale: "it-IT", status: "published", order: 2,
      values: { summary: "Un CMS portabile", rating: 5, featured: true, editor_note: "Solo redazione", tags: ["cms", "histos"] },
    });
    const draft = store.content.createRecord({ typeKey: "article", title: "Bozza", status: "draft", values: { summary: "Non pubblica", rating: 2 } });
    expect(published.status).toBe("saved");
    expect(draft.status).toBe("saved");
    if (published.status !== "saved") throw new Error("Il record avrebbe dovuto essere salvato.");

    const publicResult = store.content.listRecords({ typeKey: "article", locale: "it-IT", filter: { field: "rating", op: "gte", value: 4 } });
    expect(publicResult.total).toBe(1);
    expect(publicResult.items[0]).toMatchObject({ title: "SQLite relazionale", values: { summary: "Un CMS portabile", rating: 5, featured: true, tags: ["cms", "histos"] } });
    expect(publicResult.items[0]?.values).not.toHaveProperty("editor_note");
    expect(() => store.content.listRecords({ typeKey: "article", filter: { field: "editor_note", op: "eq", value: "Solo redazione" } })).toThrow(/non è disponibile/u);
    // Audit note 85: at most 256 leaf conditions in one filter, across its groups (32 × 8 passes, 32 × 9 does not).
    const leaf = { field: "rating", op: "gte", value: 1 } as const;
    const group = (size: number) => ({ or: Array.from({ length: size }, () => leaf) });
    expect(store.content.listRecords({ typeKey: "article", locale: "it-IT", filter: { and: Array.from({ length: 8 }, () => group(32)) } }).total).toBe(1);
    expect(() => store.content.listRecords({ typeKey: "article", filter: { and: Array.from({ length: 9 }, () => group(32)) } })).toThrow(/più di 256 condizioni/u);
    expect(() => store.content.listRecords({ typeKey: "article", filter: { and: [{ or: Array.from({ length: 32 }, () => ({ and: Array.from({ length: 32 }, () => group(32)) })) }] } })).toThrow(/più di 256 condizioni/u);
    expect(store.content.listRecords({ typeKey: "article", status: "any" }).total).toBe(2);
    expect(store.content.listRecords({ typeKey: "article", includePrivate: true, status: "any" }).items.find((item) => item.title === "SQLite relazionale")?.values.editor_note).toBe("Solo redazione");
    expect(() => store.content.createRecord({ typeKey: "article", title: "Data errata", values: { summary: "No", rating: 1.5 } })).toThrow(/intero sicuro/u);
    expect(() => store.content.createRecord({ typeKey: "article", title: "Enum errata", values: { summary: "No", tags: ["non-esiste"] } })).toThrow(/opzioni ammesse/u);

    const { id } = site;
    store.close();
    const reopened = await catalog.openProject(id);
    expect(reopened?.store.content.getType("article")?.fields).toHaveLength(5);
    expect(reopened?.store.content.getRecordById(published.record.id)?.values.tags).toEqual(["cms", "histos"]);
    reopened?.store.close();
  });

  it("pagine i record e cerca titolo o slug trattando i caratteri speciali come testo", async () => {
    const { store } = await project();
    store.content.saveType({ key: "news", label: "Notizie", expectedHead: null, fields: [] });
    for (const input of [
      { title: "Notizia 100% sicura", slug: "notizia-speciale" },
      { title: "Seconda notizia", slug: "route-tecnica" },
      { title: "Terza notizia", slug: "terza-notizia" },
    ]) {
      expect(store.content.createRecord({ typeKey: "news", ...input, status: "draft" }).status).toBe("saved");
    }

    expect(store.content.listRecords({ typeKey: "news", status: "any", orderBy: "title", limit: 2, offset: 1 })).toMatchObject({ total: 3, items: [{ title: "Seconda notizia" }, { title: "Terza notizia" }] });
    expect(store.content.listRecords({ typeKey: "news", status: "any", search: "route-tecnica" })).toMatchObject({ total: 1, items: [{ title: "Seconda notizia" }] });
    expect(store.content.listRecords({ typeKey: "news", status: "any", search: "%" })).toMatchObject({ total: 1, items: [{ title: "Notizia 100% sicura" }] });
    expect(store.content.listRecords({ typeKey: "news", status: "any", search: "_" }).total).toBe(0);
    expect(store.content.listRecords({ typeKey: "news", status: "any", search: "\\" }).total).toBe(0);
    expect(store.content.listRecords({ typeKey: "news", status: "any", search: "NOTIZIA" }).total).toBe(3);
    expect(() => store.content.listRecords({ typeKey: "news", search: "x".repeat(121) })).toThrow(/120 caratteri/u);
  });

  it("mantiene relazioni tipizzate, impedisce target errati e nasconde record non pubblicati", async () => {
    const { store } = await project();
    store.content.saveType({ key: "author", label: "Autore", expectedHead: null, fields: [{ key: "bio", label: "Biografia", type: "text", public: true }] });
    store.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [{ key: "author", label: "Autore", type: "relation", targetType: "author", public: true }] });
    store.content.saveType({ key: "topic", label: "Tema", expectedHead: null, fields: [{ key: "name", label: "Nome", type: "text", public: true }] });
    const author = store.content.createRecord({ typeKey: "author", title: "Autrice", status: "published", values: { bio: "Profilo" } });
    const privateAuthor = store.content.createRecord({ typeKey: "author", title: "Autore bozza", status: "draft", values: { bio: "Privato" } });
    const topic = store.content.createRecord({ typeKey: "topic", title: "Tema", status: "published", values: { name: "Tecnologia" } });
    expect(author.status).toBe("saved");
    expect(privateAuthor.status).toBe("saved");
    expect(topic.status).toBe("saved");
    if (author.status !== "saved" || privateAuthor.status !== "saved" || topic.status !== "saved") throw new Error("I record collegati avrebbero dovuto essere salvati.");
    const article = store.content.createRecord({ typeKey: "article", title: "Articolo con autore", status: "published", values: { author: author.record.id } });
    expect(article.status).toBe("saved");
    if (article.status !== "saved") throw new Error("L’articolo avrebbe dovuto essere salvato.");
    expect(article.record.values.author).toEqual({ id: author.record.id, title: "Autrice", slug: "autrice", locale: "it-IT" });
    expect(() => store.content.createRecord({ typeKey: "article", title: "Target errato", values: { author: topic.record.id } })).toThrow(/non appartiene al tipo author/u);
    expect(() => store.content.createRecord({ typeKey: "article", title: "Target bozza", status: "published", values: { author: privateAuthor.record.id } })).toThrow(/non è ancora pubblicato/u);
    store.close();
  });

  it("espande le relazioni pubbliche in batch fino a tre livelli senza esporre campi privati o inseguire cicli", async () => {
    const { store } = await project();
    store.content.saveType({ key: "organization", label: "Organizzazione", expectedHead: null, fields: [
      { key: "name", label: "Nome", type: "text", public: true },
      { key: "director", label: "Direzione", type: "relation", targetType: "writer", public: true },
    ] });
    store.content.saveType({ key: "writer", label: "Autore", expectedHead: null, fields: [
      { key: "bio", label: "Biografia", type: "text", public: true },
      { key: "editor_note", label: "Nota privata", type: "text", public: false },
      { key: "organization", label: "Organizzazione", type: "relation", targetType: "organization", public: true },
      { key: "private_contact", label: "Contatto privato", type: "relation", targetType: "organization", public: false },
    ] });
    store.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [
      { key: "author", label: "Autore", type: "relation", targetType: "writer", public: true },
    ] });
    const organization = store.content.createRecord({ typeKey: "organization", title: "Studio Histeon", status: "published", values: { name: "Studio Histeon" } });
    const writer = store.content.createRecord({ typeKey: "writer", title: "Autrice", status: "published", values: { bio: "Profilo pubblico", editor_note: "Appunto riservato" } });
    const privateOrganization = store.content.createRecord({ typeKey: "organization", title: "Studio riservato", status: "published", values: { name: "Sede privata" } });
    if (organization.status !== "saved" || writer.status !== "saved" || privateOrganization.status !== "saved") throw new Error("I record collegati avrebbero dovuto essere salvati.");
    const linkedWriter = store.content.saveRecord({ id: writer.record.id, typeKey: "writer", title: "Autrice", status: "published", expectedHead: writer.record.headRevision, values: { bio: "Profilo pubblico", editor_note: "Appunto riservato", organization: organization.record.id, private_contact: privateOrganization.record.id } });
    if (linkedWriter.status !== "saved") throw new Error("La relazione dell’autrice avrebbe dovuto essere salvata.");
    const linkedOrganization = store.content.saveRecord({ id: organization.record.id, typeKey: "organization", title: "Studio Histeon", status: "published", expectedHead: organization.record.headRevision, values: { name: "Studio Histeon", director: writer.record.id } });
    if (linkedOrganization.status !== "saved") throw new Error("La relazione ciclica avrebbe dovuto essere salvata.");
    const article = store.content.createRecord({ typeKey: "article", title: "Articolo collegato", status: "published", values: { author: writer.record.id } });
    if (article.status !== "saved") throw new Error("L’articolo avrebbe dovuto essere salvato.");
    store.content.saveQueryPreset({ key: "articles_with_author", label: "Articoli con autore", typeKey: "article", limit: 10, expectedHead: null });

    const item = store.content.resolveQueryPreset("articles_with_author")[0];
    if (!item) throw new Error("La query avrebbe dovuto restituire l’articolo pubblicato.");
    expect(item.fields).toMatchObject({
      author: {
        title: "Autrice",
        fields: {
          bio: "Profilo pubblico",
          organization: {
            title: "Studio Histeon",
            fields: {
              name: "Studio Histeon",
              director: { title: "Autrice", fields: { bio: "Profilo pubblico" } },
            },
          },
        },
      },
    });
    expect(item.fields.author).not.toHaveProperty("fields.editor_note");
    expect((item.fields.author as { fields: Record<string, unknown> }).fields).not.toHaveProperty("private_contact");
    const returnedOrganization = (item.fields.author as { fields: { organization: { fields: { director: { fields: Record<string, unknown> } } } } }).fields.organization;
    expect(returnedOrganization.fields.director.fields.organization).not.toHaveProperty("fields");
    expect(store.content.listRecords({ typeKey: "article" }).items[0]?.fields.author).toMatchObject({ id: writer.record.id, title: "Autrice" });
    expect(() => store.content.listRecords({ typeKey: "article" }, 4)).toThrow(/profondità.*3/u);
    store.close();
  });

  // Writes over a thousand records: the Windows runner needs more than the default.
  it("interrompe l’espansione oltre 1.000 record collegati senza restituire una lista parziale", { timeout: 120_000 }, async () => {
    const { store } = await project();
    store.content.saveType({ key: "linked", label: "Collegato", expectedHead: null, fields: [] });
    store.content.saveType({ key: "holder", label: "Contenitore", expectedHead: null, fields: [
      { key: "first_batch", label: "Primo gruppo", type: "relation", targetType: "linked", multiple: true, public: true },
      { key: "second_batch", label: "Secondo gruppo", type: "relation", targetType: "linked", multiple: true, public: true },
    ] });
    const linkedIds: string[] = [];
    for (let index = 0; index < 1_001; index++) {
      const linked = store.content.createRecord({ typeKey: "linked", title: `Collegato ${index}`, status: "published" });
      if (linked.status !== "saved") throw new Error("Il record collegato avrebbe dovuto essere salvato.");
      linkedIds.push(linked.record.id);
    }
    const holder = store.content.createRecord({ typeKey: "holder", title: "Molti collegamenti", status: "published", values: { first_batch: linkedIds.slice(0, 501), second_batch: linkedIds.slice(501) } });
    if (holder.status !== "saved") throw new Error("Il record contenitore avrebbe dovuto essere salvato.");
    store.content.saveQueryPreset({ key: "too_many_links", label: "Troppi collegamenti", typeKey: "holder", limit: 10, expectedHead: null });

    expect(() => store.content.resolveQueryPreset("too_many_links")).toThrow(/supera il limite di 1000 record per query/u);
    store.close();
  }, 30_000);

  it("nasconde i record eliminati e rifiuta la tombstone finché altri record li referenziano", async () => {
    const { store } = await project();
    store.content.saveType({ key: "author", label: "Autore", expectedHead: null, fields: [{ key: "bio", label: "Biografia", type: "text", public: true }] });
    store.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [{ key: "author", label: "Autore", type: "relation", targetType: "author", public: true }] });
    const author = store.content.createRecord({ typeKey: "author", title: "Autrice", status: "published", values: { bio: "Profilo" } });
    if (author.status !== "saved") throw new Error("Il record autore avrebbe dovuto essere creato.");
    const article = store.content.createRecord({ typeKey: "article", title: "Articolo", status: "published", values: { author: author.record.id } });
    if (article.status !== "saved") throw new Error("Il record articolo avrebbe dovuto essere creato.");
    expect(() => store.content.markRecordDeleted(author.record.id, "2026-10-24T12:00:00.000Z")).toThrow(/altri contenuti CMS la usano/u);

    const cleared = store.content.saveRecord({ id: article.record.id, typeKey: "article", title: article.record.title, status: "published", expectedHead: article.record.headRevision, values: {} });
    expect(cleared.status).toBe("saved");
    store.content.markRecordDeleted(author.record.id, "2026-10-24T12:00:00.000Z");
    expect(store.content.getRecordById(author.record.id, true)).toBeNull();
    expect(store.content.listRecords({ typeKey: "author", status: "any", includePrivate: true })).toMatchObject({ total: 0, items: [] });
    expect(() => store.content.createRecord({ typeKey: "article", title: "Nuovo", values: { author: author.record.id } })).toThrow(/non appartiene al tipo author/u);
    expect(() => store.content.saveRecord({ id: author.record.id, typeKey: "author", title: "Modificata", expectedHead: author.record.headRevision, values: { bio: "Nuovo" } })).toThrow(/eliminata da una sincronizzazione/u);
    expect(store.content.restoreRecord(author.record.id)).toBe(true);
    expect(store.content.getRecordById(author.record.id, true)).toMatchObject({ title: "Autrice" });
    store.close();
  });

  it("applica concorrenza ottimistica e impedisce di invalidare campi con valori presenti", async () => {
    const { store } = await project();
    const type = store.content.saveType({ key: "event", label: "Evento", expectedHead: null, fields: [{ key: "date", label: "Data", type: "date", public: true }, { key: "tags", label: "Tag", type: "text", multiple: true }] });
    if (type.status !== "saved") throw new Error("Il tipo avrebbe dovuto essere salvato.");
    const created = store.content.createRecord({ typeKey: "event", title: "Riunione", status: "published", values: { date: "2026-10-23", tags: ["uno", "due"] } });
    if (created.status !== "saved") throw new Error("Il record avrebbe dovuto essere salvato.");
    expect(() => store.content.createRecord({ typeKey: "event", title: "Data impossibile", values: { date: "2026-02-31" } })).toThrow(/YYYY-MM-DD/u);
    expect(() => store.content.saveType({ id: type.contentType.id, key: "event", label: "Evento", expectedHead: type.contentType.headRevision, fields: [{ key: "date", label: "Data", type: "date", public: true }] })).toThrow(/non può essere rimosso/u);
    expect(() => store.content.saveType({ id: type.contentType.id, key: "event", label: "Evento", expectedHead: type.contentType.headRevision, fields: [{ key: "date", label: "Data", type: "date", public: true }, { key: "tags", label: "Tag", type: "text", multiple: false }] })).toThrow(/non può cambiare configurazione/u);
    const stale = store.content.saveRecord({ id: created.record.id, typeKey: "event", title: "Versione obsoleta", expectedHead: "00000000-0000-4000-8000-000000000000", values: { date: "2026-10-24", tags: ["tre"] } });
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.current?.title).toBe("Riunione");
    store.close();
  });

  it("salva preset query validati e li risolve con limiti e locale per il renderer", async () => {
    const { store } = await project();
    store.content.saveType({ key: "news", label: "Notizia", expectedHead: null, fields: [{ key: "topic", label: "Argomento", type: "text", public: true }] });
    store.content.createRecord({ typeKey: "news", title: "Una notizia", status: "published", values: { topic: "Histeon" } });
    const saved = store.content.saveQueryPreset({ key: "recent_news", label: "Notizie recenti", typeKey: "news", limit: 5, orderBy: "title", order: "desc", expectedHead: null });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Il preset query avrebbe dovuto essere salvato.");
    expect(store.content.resolveQueryPreset("recent_news", { count: 1 }, "it-it")).toMatchObject([{ title: "Una notizia", topic: "Histeon", url: "/news/una-notizia/" }]);
    expect(() => store.content.resolveQueryPreset("recent_news", { post_status: "draft" })).toThrow(/non è supportato/u);
    expect(() => store.content.saveQueryPreset({ key: "recent_news", label: "Non valido", typeKey: "news", expectedHead: saved.head, filter: { field: "missing", op: "eq", value: "x" } })).toThrow(/non è disponibile/u);
    const updated = store.content.saveQueryPreset({ key: "recent_news", label: "Notizie aggiornate", typeKey: "news", expectedHead: saved.preset.headRevision });
    expect(updated.status).toBe("saved");
    const stale = store.content.saveQueryPreset({ key: "recent_news", label: "Ramo vecchio", typeKey: "news", expectedHead: saved.preset.headRevision });
    expect(stale.status).toBe("conflict");
    expect(store.content.listQueryPresets().presets[0]?.label).toBe("Notizie aggiornate");
    store.close();
  });

  it("applica offset, pagina e il limite massimo sicuro delle query Histeon", async () => {
    const { store } = await project();
    store.content.saveType({ key: "news", label: "Notizia", expectedHead: null, fields: [{ key: "topic", label: "Argomento", type: "text", public: true }] });
    for (let index = 1; index <= 5; index++) store.content.createRecord({ typeKey: "news", title: `Notizia ${index}`, status: "published", values: { topic: "Histeon" } });
    const saved = store.content.saveQueryPreset({ key: "paged_news", label: "Notizie paginate", typeKey: "news", limit: 2, offset: 1, orderBy: "title", order: "asc", expectedHead: null });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Il preset query avrebbe dovuto essere salvato.");
    expect(store.content.listQueryPresets().presets[0]).toMatchObject({ offset: 1 });
    expect(store.content.resolveQueryPreset("paged_news").map((record) => record.title)).toEqual(["Notizia 2", "Notizia 3"]);
    expect(store.content.resolveQueryPreset("paged_news", { page: 2 }).map((record) => record.title)).toEqual(["Notizia 3", "Notizia 4"]);
    expect(store.content.resolveQueryPreset("paged_news", { offset: "4" }).map((record) => record.title)).toEqual(["Notizia 5"]);
    expect(store.content.resolveQueryPreset("paged_news", { posts_per_page: -1, offset: 0 })).toHaveLength(5);
    expect(() => store.content.resolveQueryPreset("paged_news", { page: 0 })).toThrow(/intero positivo/u);
    expect(() => store.content.resolveQueryPreset("paged_news", { offset: 1_000_001 })).toThrow(/offset/u);

    expect(store.content.previewQueryDefinition({ type: "posts", args: { post_type: "news", posts_per_page: 2, page: "$page ?? 1", orderby: "title", order: "ASC" } }, { page: 2 }).map((record) => record.title)).toEqual(["Notizia 3", "Notizia 4"]);
    expect(store.content.previewQueryDefinition({ type: "posts", args: { post_type: "news", posts_per_page: -1, orderby: "title", order: "ASC" } })).toHaveLength(5);
    store.close();
  });

  it("sincronizza preset e sorgenti JSON in un unico snapshot revisionato e mantiene i parametri dei loop", async () => {
    const { store } = await project();
    store.content.saveType({ key: "news", label: "Notizia", expectedHead: null, fields: [{ key: "topic", label: "Argomento", type: "text", public: true }] });
    store.content.createRecord({ typeKey: "news", title: "Prima", status: "published", values: { topic: "Uno" } });
    store.content.createRecord({ typeKey: "news", title: "Seconda", status: "published", values: { topic: "Due" } });
    const start = store.content.listQueryPresets();
    const saved = store.content.saveQueryPresets({
      expectedHead: start.head,
      presets: { recent_news: { type: "posts", args: { post_type: "news", posts_per_page: "$count ?? 6", orderby: "date", order: "DESC", xb_label: "Notizie recenti" } } },
      sources: { locations: { type: "json", data: [{ name: "Rimini", address: "Piazza Cavour" }] } },
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Lo snapshot query avrebbe dovuto essere salvato.");
    expect(store.content.listQueryPresets().presets).toMatchObject([{ key: "recent_news", limit: 6, limitParam: "count" }]);
    // `$limit` and `$offset` are the loop's own arguments, as Histeon for WordPress writes them: not parameters.
    const again = store.content.saveQueryPresets({ expectedHead: store.content.listQueryPresets().head, presets: { recent_news: { type: "posts", args: { post_type: "news", posts_per_page: "$limit ?? 4", offset: "$offset ?? 1", orderby: "date", order: "DESC", xb_label: "Notizie recenti" } } }, sources: { locations: { type: "json", data: [{ name: "Rimini", address: "Piazza Cavour" }] } } });
    expect(again.status).toBe("saved");
    const base = store.content.listQueryPresets().presets[0]!;
    expect(base).toMatchObject({ limit: 4, offset: 1 });
    expect(base).not.toHaveProperty("limitParam");
    expect(base).not.toHaveProperty("offsetParam");
    expect(store.content.resolveQueryPreset("recent_news", { limit: 1, offset: 0 }, "it-IT")).toHaveLength(1);
    expect(store.content.saveQueryPresets({ expectedHead: store.content.listQueryPresets().head, presets: { recent_news: { type: "posts", args: { post_type: "news", posts_per_page: "$count ?? 6", orderby: "date", order: "DESC", xb_label: "Notizie recenti" } } }, sources: { locations: { type: "json", data: [{ name: "Rimini", address: "Piazza Cavour" }] } } }).status).toBe("saved");
    expect(store.content.listQuerySources()).toEqual({ locations: { type: "json", data: [{ name: "Rimini", address: "Piazza Cavour" }] } });
    expect(store.content.resolveQueryPreset("recent_news", { count: 1 }, "it-IT")).toHaveLength(1);
    expect(store.content.resolveQueryPreset("removed_query")).toEqual([]);

    const beforeInvalid = store.content.listQueryPresets();
    expect(store.content.fromHistosTaxQuery([], "news")).toBeUndefined();
    expect(store.content.listQueryPresets().head).toBe(beforeInvalid.head);
    expect(store.content.listQuerySources()).toHaveProperty("locations");

    const cleared = store.content.saveQueryPresets({ expectedHead: beforeInvalid.head, presets: {}, sources: {} });
    expect(cleared.status).toBe("saved");
    expect(store.content.listQueryPresets().presets).toEqual([]);
    expect(store.content.listQuerySources()).toEqual({});
    store.close();
  });

  it("gestisce tassonomie tipizzate, termini gerarchici e filtri Histeon tax_query", async () => {
    const { store } = await project();
    store.content.saveType({ key: "news", label: "Notizie", expectedHead: null, fields: [{ key: "topic", label: "Argomento", type: "text", public: true }] });
    store.content.saveType({ key: "scheda", label: "Schede", expectedHead: null, fields: [] });
    const taxonomyResult = store.content.saveTaxonomy({ key: "argomento", label: "Categorie", types: ["news"], expectedHead: null });
    expect(taxonomyResult.status).toBe("saved");
    if (taxonomyResult.status !== "saved") throw new Error("La tassonomia avrebbe dovuto essere creata.");
    const parentResult = store.content.saveTerm({ taxonomyKey: "argomento", label: "Guide", slug: "guide", expectedHead: null });
    expect(parentResult.status).toBe("saved");
    if (parentResult.status !== "saved") throw new Error("Il termine avrebbe dovuto essere creato.");
    const childResult = store.content.saveTerm({ taxonomyKey: "argomento", label: "Tecnologia", slug: "tecnologia", parentAlias: parentResult.term.alias, expectedHead: null });
    expect(childResult.status).toBe("saved");
    if (childResult.status !== "saved") throw new Error("Il termine figlio avrebbe dovuto essere creato.");
    const article = store.content.createRecord({ typeKey: "news", title: "Notizia tecnologica", status: "published", values: { topic: "Tech" }, terms: { argomento: [childResult.term.alias] } });
    store.content.createRecord({ typeKey: "news", title: "Notizia senza categoria", status: "published", values: { topic: "Altro" } });
    expect(article.status).toBe("saved");
    if (article.status !== "saved") throw new Error("Il record avrebbe dovuto essere creato.");
    expect(article.record.terms.argomento?.map((term) => term.alias)).toEqual([childResult.term.alias]);
    // «scheda» is not linked to «argomento»: its terms are refused at once, not at the .xbsite export.
    expect(() => store.content.createRecord({ typeKey: "scheda", title: "Scheda con categoria", status: "published", values: {}, terms: { argomento: [childResult.term.alias] } })).toThrow("La tassonomia argomento non è collegata al tipo scheda");
    expect(store.content.listRecords({ typeKey: "news", filter: { taxonomyKey: "argomento", termIds: [childResult.term.id], operator: "IN" } })).toMatchObject({ total: 1, items: [{ title: "Notizia tecnologica" }] });
    expect(() => store.content.listRecords({ typeKey: "scheda", filter: { taxonomyKey: "argomento", termIds: [childResult.term.id], operator: "IN" } })).toThrow(/non è collegata/u);
    const presetHead = store.content.listQueryPresets().head;
    const saved = store.content.saveQueryPresets({
      expectedHead: presetHead,
      presets: { guides: { type: "posts", args: { post_type: "news", tax_query: [{ taxonomy: "argomento", field: "term_id", terms: [childResult.term.alias], operator: "IN" }] } } },
      sources: {},
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("La query tassonomica avrebbe dovuto essere salvata.");
    expect(store.content.resolveQueryPreset("guides")).toMatchObject([{ title: "Notizia tecnologica" }]);
    const preset = store.content.listQueryPresets().presets[0]!;
    expect(store.content.toHistosTaxQuery(preset.filter)).toEqual([{ taxonomy: "argomento", field: "term_id", operator: "IN", terms: [childResult.term.alias] }]);
    expect(store.content.fromHistosTaxQuery(store.content.toHistosTaxQuery(preset.filter), "news")).toEqual(preset.filter);
    store.close();
  });

  it("filtra query pubbliche per identità dei record collegati e rifiuta tipo o stato errati", async () => {
    const { store } = await project();
    store.content.saveType({ key: "author", label: "Autori", expectedHead: null, fields: [{ key: "role", label: "Ruolo", type: "text", public: true }] });
    store.content.saveType({ key: "article", label: "Articoli", expectedHead: null, fields: [{ key: "author", label: "Autore", type: "relation", targetType: "author", public: true }] });
    const author = store.content.createRecord({ typeKey: "author", title: "Ada Lovelace", status: "published", values: { role: "Autrice" } });
    const secondAuthor = store.content.createRecord({ typeKey: "author", title: "Grace Hopper", status: "published", values: { role: "Informatica" } });
    const draftAuthor = store.content.createRecord({ typeKey: "author", title: "Autore bozza", status: "draft", values: { role: "Privato" } });
    expect(author.status).toBe("saved");
    expect(secondAuthor.status).toBe("saved");
    expect(draftAuthor.status).toBe("saved");
    if (author.status !== "saved" || secondAuthor.status !== "saved" || draftAuthor.status !== "saved") throw new Error("I record di prova avrebbero dovuto essere creati.");
    const firstArticle = store.content.createRecord({ typeKey: "article", title: "Primo articolo", status: "published", values: { author: author.record.id } });
    const secondArticle = store.content.createRecord({ typeKey: "article", title: "Secondo articolo", status: "published", values: { author: secondAuthor.record.id } });
    expect(firstArticle.status).toBe("saved");
    expect(secondArticle.status).toBe("saved");
    if (firstArticle.status !== "saved" || secondArticle.status !== "saved") throw new Error("Gli articoli di prova avrebbero dovuto essere creati.");

    const filter = { field: "author", op: "eq", value: author.record.id } as const;
    expect(store.content.listRecords({ typeKey: "article", filter })).toMatchObject({ total: 1, items: [{ title: "Primo articolo" }] });
    expect(store.content.listRecords({ typeKey: "article", filter: { field: "author", op: "exists" } })).toMatchObject({ total: 2 });
    const saved = store.content.saveQueryPreset({ key: "by_author", label: "Per autore", typeKey: "article", filter, expectedHead: null });
    expect(saved.status).toBe("saved");
    expect(store.content.resolveQueryPreset("by_author")).toMatchObject([{ title: "Primo articolo" }]);
    expect(() => store.content.listRecords({ typeKey: "article", filter: { field: "author", op: "eq", value: secondArticle.record.id } })).toThrow(/tipo collegato/u);
    expect(() => store.content.listRecords({ typeKey: "article", filter: { field: "author", op: "eq", value: draftAuthor.record.id } })).toThrow(/non esiste, non è pubblicato/u);
    store.close();
  });

  it("filtra per campi pubblici attraversando fino a tre relazioni annidate", async () => {
    const { store } = await project();
    store.content.saveType({ key: "region", label: "Regioni", expectedHead: null, fields: [{ key: "code", label: "Codice", type: "text", public: true }] });
    store.content.saveType({ key: "organization", label: "Organizzazioni", expectedHead: null, fields: [
      { key: "regions", label: "Regioni", type: "relation", targetType: "region", multiple: true, public: true },
    ] });
    store.content.saveType({ key: "author", label: "Autori", expectedHead: null, fields: [
      { key: "organizations", label: "Organizzazioni", type: "relation", targetType: "organization", multiple: true, public: true },
    ] });
    store.content.saveType({ key: "article", label: "Articoli", expectedHead: null, fields: [
      { key: "author", label: "Autore", type: "relation", targetType: "author", public: true },
    ] });
    const regionIt = store.content.createRecord({ typeKey: "region", title: "Italia", status: "published", values: { code: "IT" } });
    const regionUs = store.content.createRecord({ typeKey: "region", title: "Stati Uniti", status: "published", values: { code: "US" } });
    expect(regionIt.status).toBe("saved");
    expect(regionUs.status).toBe("saved");
    if (regionIt.status !== "saved" || regionUs.status !== "saved") throw new Error("Le regioni di prova avrebbero dovuto essere create.");
    const organization = store.content.createRecord({ typeKey: "organization", title: "Studio", status: "published", values: { regions: [regionIt.record.id, regionUs.record.id] } });
    expect(organization.status).toBe("saved");
    if (organization.status !== "saved") throw new Error("L’organizzazione di prova avrebbe dovuto essere creata.");
    const secondOrganization = store.content.createRecord({ typeKey: "organization", title: "Studio secondario", status: "published", values: { regions: [regionUs.record.id] } });
    expect(secondOrganization.status).toBe("saved");
    if (secondOrganization.status !== "saved") throw new Error("La seconda organizzazione di prova avrebbe dovuto essere creata.");
    const author = store.content.createRecord({ typeKey: "author", title: "Ada", status: "published", values: { organizations: [organization.record.id, secondOrganization.record.id] } });
    expect(author.status).toBe("saved");
    if (author.status !== "saved") throw new Error("L’autrice di prova avrebbe dovuto essere creata.");
    const article = store.content.createRecord({ typeKey: "article", title: "Articolo italiano", status: "published", values: { author: author.record.id } });
    expect(article.status).toBe("saved");
    if (article.status !== "saved") throw new Error("L’articolo di prova avrebbe dovuto essere creato.");
    const authorWithoutOrganizations = store.content.createRecord({ typeKey: "author", title: "Autore senza organizzazioni", status: "published", values: { organizations: [] } });
    expect(authorWithoutOrganizations.status).toBe("saved");
    if (authorWithoutOrganizations.status !== "saved") throw new Error("L’autore senza organizzazioni avrebbe dovuto essere creato.");
    const articleWithoutRegions = store.content.createRecord({ typeKey: "article", title: "Articolo senza regioni", status: "published", values: { author: authorWithoutOrganizations.record.id } });
    expect(articleWithoutRegions.status).toBe("saved");
    if (articleWithoutRegions.status !== "saved") throw new Error("L’articolo senza regioni avrebbe dovuto essere creato.");

    const filter = { field: "author.organizations.regions.code", op: "eq", value: "IT" } as const;
    expect(store.content.listRecords({ typeKey: "article", filter })).toMatchObject({ total: 1, items: [{ title: "Articolo italiano" }] });
    expect(store.content.listRecords({ typeKey: "article", filter: { field: "author.organizations.regions.code", op: "eq", value: "US" } })).toMatchObject({ total: 1, items: [{ title: "Articolo italiano" }] });
    expect(store.content.listRecords({ typeKey: "article", filter: { field: "author.organizations.regions.code", op: "eq", value: "CA" } })).toMatchObject({ total: 0, items: [] });
    expect(store.content.listRecords({ typeKey: "article", filter: { field: "author.organizations.regions", op: "exists" } })).toMatchObject({ total: 1, items: [{ title: "Articolo italiano" }] });
    expect(() => store.content.listRecords({ typeKey: "article", filter: { field: "author.organizations.regions.private_code", op: "eq", value: "IT" } })).toThrow(/disponibile/u);
    expect(() => store.content.listRecords({ typeKey: "article", filter: { field: "author.organizations.regions.code.extra", op: "eq", value: "IT" } })).toThrow(/profondità/u);
    store.close();
  });
});

describe("i link fra le pagine di un archivio (A8)", () => {
  it("prevUrl e nextUrl vuoti dove la pagina non c'è, pageLinks con le prime 100 pagine e quella mostrata", async () => {
    const { cmsArchivePaging, CMS_ARCHIVE_PAGE_LINKS } = await import("../src/content-model.js");
    expect(cmsArchivePaging("/opera/", 1, 1)).toEqual({ prevUrl: "", nextUrl: "", pageLinks: [{ number: 1, url: "/opera/", current: true }] });
    expect(cmsArchivePaging("/en/opera/", 2, 3)).toEqual({
      prevUrl: "/en/opera/", nextUrl: "/en/opera/page/3/",
      pageLinks: [{ number: 1, url: "/en/opera/", current: false }, { number: 2, url: "/en/opera/page/2/", current: true }, { number: 3, url: "/en/opera/page/3/", current: false }],
    });
    const many = cmsArchivePaging("/blog/", 150, 150);
    expect(CMS_ARCHIVE_PAGE_LINKS).toBe(100);
    expect(many.pageLinks).toHaveLength(100);
    expect(many.pageLinks.at(-1)).toEqual({ number: 100, url: "/blog/page/100/", current: false });
    expect(many.pageLinks.some((link) => link.current)).toBe(false);
    expect(many).toMatchObject({ prevUrl: "/blog/page/149/", nextUrl: "" });
  });
});
