import { mkdtemp, readFile, rm, truncate, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { stylesData } from "../src/histos-css.js";
import { decodeNativeProjectArchive, encodeNativeProjectArchive } from "../src/project-archive.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { renderCmsPage } from "../src/static-renderer.js";

const roots: string[] = [];

async function catalog() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-native-backup-"));
  roots.push(root);
  return new CmsProjectCatalog(root);
}

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

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("backup nativo .histosproject", () => {
  it("conserva la configurazione opaca del framework CSS nel backup", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Backup configurazione framework");
    const styles = origin.store.getStyles();
    if (!styles) throw new Error("Foglio stili non inizializzato.");
    const head = origin.store.getHead(styles.id);
    if (!head) throw new Error("Revisione stili non inizializzata.");
    const configuration = '{\n  "tokens": {"space": "1rem"}\n}\n';
    origin.store.saveDocument({
      entityId: styles.id,
      expectedHead: head.id,
      content: JSON.stringify({
        styles: [],
        globals: [{
          id: "framework-acss",
          css: ":root{--space:1rem}",
          source: {
            kind: "user-css",
            frameworkId: "automatic-css",
            name: "ACSS",
            rightsConfirmed: true,
            configuration: { format: "opaque-utf8-v1", data: configuration },
          },
        }],
        compiledCss: "",
      }),
    });

    const archive = await encodeNativeProjectArchive(origin.project, origin.store, "test");
    origin.store.close();
    const decoded = await decodeNativeProjectArchive(archive);
    const restoredCatalog = await catalog();
    const restored = await restoredCatalog.importNativeProjectBackup(decoded);
    const restoredStyles = restored.store.getStyles();
    if (!restoredStyles) throw new Error("Foglio stili ripristinato non trovato.");
    const revision = restored.store.getHead(restoredStyles.id);
    if (!revision) throw new Error("Revisione stili ripristinata non trovata.");
    expect(stylesData(revision.content).globals[0]?.source?.configuration).toEqual({ format: "opaque-utf8-v1", data: configuration });
    const rendered = await renderCmsPage({ store: restored.store, projectId: restored.project.id, content: "", mediaBase: "/__cms-media" });
    expect(JSON.stringify(rendered)).not.toContain(configuration);
    restored.store.close();
  });

  it("rifiuta un backup con uno slug che diventerebbe un percorso fuori dal build", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Backup manomesso");
    origin.store.createPage({ title: "Contatti" });
    const archive = await encodeNativeProjectArchive(origin.project, origin.store, "test");
    origin.store.close();
    const decoded = await decodeNativeProjectArchive(archive);
    for (const slug of ["../../escape-probe", "a/b", "..\\..\\escape", "Maiuscole"]) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "histos-tampered-"));
      roots.push(scratch);
      const file = path.join(scratch, "content.sqlite");
      await writeFile(file, decoded.files.get("content.sqlite") ?? Buffer.alloc(0));
      const db = new DatabaseSync(file);
      db.prepare("UPDATE entities SET slug = ? WHERE kind = 'page'").run(slug);
      db.close();
      const files = new Map(decoded.files);
      files.set("content.sqlite", await readFile(file));
      const restoredCatalog = await catalog();
      await expect(restoredCatalog.importNativeProjectBackup({ project: decoded.project, files })).rejects.toThrow("indirizzo non valido");
    }
  });

  it("conserva i font collegati al CSS e li rende disponibili dopo il ripristino", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Backup con font CSS");
    const fontBytes = Buffer.from([119, 79, 70, 50, 0, 0]);
    const font = origin.store.saveAsset({ bytes: fontBytes, mimeType: "font/woff2", filename: "brand.woff2" });
    const styles = origin.store.getStyles();
    if (!styles) throw new Error("Foglio stili non inizializzato.");
    const head = origin.store.getHead(styles.id);
    if (!head) throw new Error("Revisione stili non inizializzata.");
    const css = "@font-face{font-family:Brand;src:url('./fonts/brand.woff2?v=2')}";
    const mapping = { reference: "./fonts/brand.woff2?v=2", assetId: font.id };
    origin.store.saveDocument({
      entityId: styles.id,
      expectedHead: head.id,
      content: JSON.stringify({ styles: [], globals: [{ id: "framework-custom", css, assets: [mapping] }], compiledCss: "" }),
    });

    const archive = await encodeNativeProjectArchive(origin.project, origin.store, "test");
    origin.store.close();
    const decoded = await decodeNativeProjectArchive(archive);
    const restoredCatalog = await catalog();
    const restored = await restoredCatalog.importNativeProjectBackup(decoded);
    const restoredStyles = restored.store.getStyles();
    if (!restoredStyles) throw new Error("Foglio stili ripristinato non trovato.");
    const revision = restored.store.getHead(restoredStyles.id);
    if (!revision) throw new Error("Revisione stili ripristinata non trovata.");
    expect(stylesData(revision.content).globals).toMatchObject([{ css, assets: [mapping] }]);
    expect((await restored.store.readAsset(font.id))?.bytes).toEqual(fontBytes);
    const rendered = await renderCmsPage({ store: restored.store, projectId: restored.project.id, content: "", mediaBase: "/__cms-media" });
    expect(rendered.globalCss).toContain(`/__cms-media/${restored.project.id}/${font.id}?v=2`);
    expect(rendered.assets.map(({ id }) => id)).toContain(font.id);
    restored.store.close();
  });

  it("conserva editor, storico, modelli relazionali, tassonomie, query e media al ripristino", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Raccolta portabile");
    const person = origin.store.content.saveType({ key: "author", label: "Autore", expectedHead: null, fields: [{ key: "bio", label: "Biografia", type: "text", public: true }] });
    const article = origin.store.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [
      { key: "body", label: "Testo", type: "rich-text", public: true },
      { key: "author", label: "Autore", type: "relation", targetType: "author", public: true },
      { key: "cover", label: "Copertina", type: "asset", public: true },
    ] });
    expect(person.status).toBe("saved");
    expect(article.status).toBe("saved");
    const taxonomy = origin.store.content.saveTaxonomy({ key: "argomento", label: "Argomenti", types: ["article"], expectedHead: null });
    expect(taxonomy.status).toBe("saved");
    if (taxonomy.status !== "saved") throw new Error("Tassonomia non salvata.");
    const term = origin.store.content.saveTerm({ taxonomyKey: "argomento", slug: "guide", label: "Guide", expectedHead: null });
    expect(term.status).toBe("saved");
    if (term.status !== "saved") throw new Error("Termine non salvato.");
    const cover = origin.store.saveAsset({ bytes: Buffer.from("test-image-content"), mimeType: "image/png", filename: "cover.png", alt: "Copertina", caption: "Didascalia" });
    const authorRecord = origin.store.content.createRecord({ typeKey: "author", title: "Ada", status: "published", values: { bio: "Ricercatrice" } });
    expect(authorRecord.status).toBe("saved");
    if (authorRecord.status !== "saved") throw new Error("Autrice non salvata.");
    const articleRecord = origin.store.content.createRecord({ typeKey: "article", title: "Archivio locale", status: "published", values: { body: "Testo completo", author: authorRecord.record.id, cover: cover.id }, terms: { argomento: [term.term.alias] } });
    expect(articleRecord.status).toBe("saved");
    if (articleRecord.status !== "saved") throw new Error("Articolo non salvato.");
    const queries = origin.store.content.listQueryPresets();
    const savedQueries = origin.store.content.saveQueryPresets({ expectedHead: queries.head, sources: { links: { type: "json", data: [{ label: "Archivio", url: "/archivio/" }] } }, presets: {} });
    expect(savedQueries.status).toBe("saved");
    const head = origin.store.getHead(origin.store.listPages()[0]!.id)!;
    origin.store.saveDocument({ entityId: origin.store.listPages()[0]!.id, expectedHead: head.id, content: `${head.content}\n<!-- snapshot-test -->`, source: "editor" });

    const archive = await encodeNativeProjectArchive(origin.project, origin.store, "test");
    origin.store.close();
    const decoded = await decodeNativeProjectArchive(archive);
    expect(decoded.project).toMatchObject({ id: origin.project.id, name: "Raccolta portabile", schemaVersion: 1 });

    const restoredCatalog = await catalog();
    const restored = await restoredCatalog.importNativeProjectBackup(decoded);
    expect(restored.store.content.getType("article")?.fields).toHaveLength(3);
    expect(restored.store.content.listTaxonomies()).toMatchObject([{ key: "argomento", types: ["article"] }]);
    const loadedArticle = restored.store.content.getRecordById(articleRecord.record.id, true)!;
    expect(loadedArticle.values.author).toMatchObject({ id: authorRecord.record.id, title: "Ada" });
    expect(loadedArticle.terms.argomento?.map(({ slug }) => slug)).toEqual(["guide"]);
    expect(restored.store.content.listQuerySources()).toEqual({ links: { type: "json", data: [{ label: "Archivio", url: "/archivio/" }] } });
    expect(await restored.store.readAsset(cover.id)).toMatchObject({ metadata: { alt: "Copertina", caption: "Didascalia" }, bytes: expect.any(Uint8Array) });
    expect(restored.store.listRevisions(restored.store.listPages()[0]!.id)).toHaveLength(2);
    restored.store.close();
  });

  it("rifiuta archivi alterati e non sovrascrive un progetto con la stessa identità", async () => {
    const sourceCatalog = await catalog();
    const source = await sourceCatalog.createProject("Progetto");
    const archive = await encodeNativeProjectArchive(source.project, source.store, "test");
    source.store.close();
    const decoded = await decodeNativeProjectArchive(archive);
    const targetCatalog = await catalog();
    await targetCatalog.importNativeProjectBackup(decoded).then(({ store }) => store.close());
    await expect(targetCatalog.importNativeProjectBackup(decoded)).rejects.toThrow(/identità esiste già/u);
    const broken = Buffer.from(archive);
    broken[broken.length - 1] = broken[broken.length - 1]! ^ 0xff;
    await expect(decodeNativeProjectArchive(broken)).rejects.toThrow();
  });

  it("rifiuta versioni future e percorsi ZIP traversal prima di importare dati", async () => {
    const future = await zip([{
      name: "histos-project.json",
      bytes: Buffer.from(JSON.stringify({
        format: "histos-project",
        version: 2,
        generator: {},
        project: {},
        files: [],
        manifestHash: "0".repeat(64),
      })),
      compress: false,
    }]);
    await expect(decodeNativeProjectArchive(future)).rejects.toThrow(/versione del backup Histeon sconosciuti/u);

    const traversal = await zip([{ name: "safe", bytes: Buffer.from("outside"), compress: false }]);
    const malicious = Buffer.from(traversal);
    const safeName = Buffer.from("safe");
    let offset = malicious.indexOf(safeName);
    let patchedNames = 0;
    while (offset !== -1) {
      Buffer.from("../a").copy(malicious, offset);
      patchedNames += 1;
      offset = malicious.indexOf(safeName, offset + safeName.byteLength);
    }
    expect(patchedNames).toBeGreaterThanOrEqual(2);
    await expect(decodeNativeProjectArchive(malicious)).rejects.toThrow(/relative path|Percorso ZIP non consentito/u);

    const target = await catalog();
    expect(await target.listProjects()).toEqual([]);
  });

  it("ripristina il backup di un progetto con due immagini sugli stessi byte, che condividono un file (D2)", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Media condivisi");
    const bytes = Buffer.from("stessa immagine");
    const first = origin.store.saveAsset({ bytes, mimeType: "image/png", filename: "uno.png", alt: "Primo testo" });
    // Same bytes, another alt: a second row on the same file, as the app saves it.
    const twin = origin.store.saveAsset({ bytes, mimeType: "image/png", filename: "due.png", alt: "Secondo testo" });
    expect(twin.relativePath).toBe(first.relativePath);
    const decoded = await decodeNativeProjectArchive(await encodeNativeProjectArchive(origin.project, origin.store, "test"));
    origin.store.close();
    expect([...decoded.files.keys()].filter((file) => file.startsWith("media/"))).toEqual([first.relativePath]);
    // Before: refused, «I media dichiarati nel database non corrispondono ai file del backup».
    const restored = await (await catalog()).importNativeProjectBackup(decoded);
    try {
      expect(restored.store.listAssets().map((asset) => asset.alt).sort()).toEqual(["Primo testo", "Secondo testo"]);
      expect(Buffer.from((await restored.store.readAsset(twin.id))?.bytes ?? [])).toEqual(bytes);
    } finally { restored.store.close(); }
  });

  it("rifiuta il backup di un media danneggiato o mancante dicendo come ripararlo, e caricare di nuovo lo stesso file lo ripara (D2)", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Media da riparare");
    try {
      const bytes = Buffer.from("immagine originale ".repeat(100));
      const asset = origin.store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" });
      const file = path.join(origin.project.directory, asset.relativePath);
      for (const [damage, apply, refusal] of [
        ["troncato", () => truncate(file, 10), "è danneggiato"],
        ["cancellato", () => unlink(file), "manca"],
      ] as const) {
        await apply();
        // The manual backup is this archive: still refused, never one its restore refuses, but with the way out.
        const refused = await encodeNativeProjectArchive(origin.project, origin.store, "test").then(() => null, (reason: unknown) => reason);
        expect(refused, damage).toMatchObject({ code: "cms-backup-unrestorable", status: 422 });
        const message = (refused as Error).message;
        expect(message, damage).toContain(`Il media «foto.png» ${refusal}`);
        // Before: no word of a repair, and none was possible: the same upload left the file as it was. The builder
        // compresses to WebP unless «Originale» is chosen, and a WebP has other bytes: the message says to choose it.
        expect(message, damage).toContain("Per ripararlo carica di nuovo lo stesso file (la stessa immagine o lo stesso font) dal builder scegliendo «Originale» nel menu della compressione: Histeon Publish lo riconosce dai suoi byte e lo rimette al suo posto.");
        expect(message, damage).not.toContain(origin.project.directory);
        // The same image uploaded again, as the builder sends it (no alt, no caption): the same row, its file back.
        expect(origin.store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" }).id, damage).toBe(asset.id);
        const decoded = await decodeNativeProjectArchive(await encodeNativeProjectArchive(origin.project, origin.store, "test"));
        expect(decoded.files.get(asset.relativePath), damage).toEqual(bytes);
        const restored = await (await catalog()).importNativeProjectBackup(decoded);
        try { expect(Buffer.from((await restored.store.readAsset(asset.id))?.bytes ?? []), damage).toEqual(bytes); } finally { restored.store.close(); }
      }
    } finally { origin.store.close(); }
  });

  it("salva i media senza comprimerli: un media che si comprime moltissimo si ripristina (D2)", async () => {
    const originCatalog = await catalog();
    const origin = await originCatalog.createProject("Media piatto");
    // 2 MiB of a PNG signature and zeros, as the media route accepts it: deflate would shrink it over 1000:1, which the
    // restore refuses as a zip bomb.
    const flat = Buffer.alloc(2 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(flat);
    const asset = origin.store.saveAsset({ bytes: flat, mimeType: "image/png", filename: "piatto.png" });
    const archive = await encodeNativeProjectArchive(origin.project, origin.store, "test");
    origin.store.close();
    // Before: «Dimensione o compressione non consentita».
    const restored = await (await catalog()).importNativeProjectBackup(await decodeNativeProjectArchive(archive));
    try { expect(Buffer.from((await restored.store.readAsset(asset.id))?.bytes ?? []).equals(flat)).toBe(true); } finally { restored.store.close(); }
    // The database is still compressed.
    expect(archive.byteLength).toBeLessThan(flat.byteLength + 64 * 1024);
  });

  it("mette nel backup solo i campi del progetto che il ripristino accetta (D2)", async () => {
    const originCatalog = await catalog();
    const created = await originCatalog.createProject("Campi in più");
    created.store.close();
    // A project.json with a field another version wrote: openProject keeps it, the restore refuses any field it does
    // not know, so the backup carries only its five.
    const manifestPath = path.join(created.project.directory, "project.json");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, "utf8")), extra: "valore" }));
    const origin = await originCatalog.openProject(created.project.id);
    if (!origin) throw new Error("Progetto mancante.");
    const archive = await encodeNativeProjectArchive(origin.project, origin.store, "test");
    origin.store.close();
    // Before: «Il backup contiene campi progetto non previsti».
    const decoded = await decodeNativeProjectArchive(archive);
    expect(Object.keys(decoded.project).sort()).toEqual(["createdAt", "id", "name", "schemaVersion", "updatedAt"]);
    const restored = await (await catalog()).importNativeProjectBackup(decoded);
    restored.store.close();
    expect(restored.project).toMatchObject({ id: created.project.id, name: "Campi in più" });
  });

  it("rifiuta una voce ZIP con rapporto di compressione da zip bomb", async () => {
    const bomb = Buffer.alloc(4 * 1024 * 1024);
    const archive = await zip([
      { name: "histos-project.json", bytes: Buffer.from("{}"), compress: false },
      { name: `media/sha256/00/${"0".repeat(64)}`, bytes: bomb },
    ]);
    await expect(decodeNativeProjectArchive(archive)).rejects.toThrow(/Dimensione o compressione non consentita/u);
  });
});
