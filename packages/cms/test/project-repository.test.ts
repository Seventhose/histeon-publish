import { lstat, lutimes, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { createStaticPageProfile } from "../src/page-transfer.js";
import { canonicalRevisionPayload, type JsonValue, type StaticPageProfile, type TransferEntity } from "@histos-publish/histos-contract";

const temporaryDirectories: string[] = [];

async function newCatalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-"));
  temporaryDirectories.push(root);
  return new CmsProjectCatalog(root);
}

async function killSqliteWriter(databasePath: string, commit: boolean): Promise<void> {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('BEGIN IMMEDIATE');
    database.prepare('UPDATE project_meta SET value=? WHERE key=?').run(process.argv[2] === 'commit' ? 'en-US' : 'fr-FR', 'render.locale');
    if (process.argv[2] === 'commit') database.exec('COMMIT');
    process.kill(process.pid, 'SIGKILL');
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, databasePath, commit ? "commit" : "rollback"], { stdio: "ignore" });
    child.once("error", reject);
    // Windows has no signals: process.kill() ends the process abruptly (TerminateProcess) with exit code 1.
    const killed = (code: number | null, signal: NodeJS.Signals | null) => signal === "SIGKILL" || (process.platform === "win32" && code === 1);
    child.once("exit", (code, signal) => killed(code, signal) ? resolve() : reject(new Error(`Il writer di prova è uscito senza SIGKILL (${signal ?? "nessun segnale"}).`)));
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native Histeon project repository", () => {
  it("calcola una revisione stabile che cambia con impostazioni e dati relazionali", async () => {
    const catalog = await newCatalog();
    const { store } = await catalog.createProject("Revisione globale");
    try {
      const initial = store.getProjectRevision();
      expect(store.getProjectRevision()).toBe(initial);

      store.setRenderSettings({ locale: "en-US", timeZone: "Europe/Rome" });
      const afterSettings = store.getProjectRevision();
      expect(afterSettings).not.toBe(initial);

      const type = store.content.saveType({ key: "news", label: "Notizie", fields: [], expectedHead: null });
      expect(type.status).toBe("saved");
      const afterType = store.getProjectRevision();
      expect(afterType).not.toBe(afterSettings);

      const record = store.content.createRecord({ typeKey: "news", title: "Primo articolo", status: "published" });
      expect(record.status).toBe("saved");
      expect(store.getProjectRevision()).not.toBe(afterType);
    } finally {
      store.close();
    }
  });

  it("recupera atomicamente un writer ucciso prima e dopo COMMIT", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Crash SQLite");
    store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
    store.close();

    await killSqliteWriter(path.join(project.directory, "content.sqlite"), false);
    const afterRollback = await catalog.openProject(project.id);
    if (!afterRollback) throw new Error("Il progetto non si è riaperto dopo il crash prima del commit.");
    expect(afterRollback.store.getRenderSettings().locale).toBe("it-IT");
    afterRollback.store.close();

    await killSqliteWriter(path.join(project.directory, "content.sqlite"), true);
    const afterCommit = await catalog.openProject(project.id);
    if (!afterCommit) throw new Error("Il progetto non si è riaperto dopo il crash dopo il commit.");
    expect(afterCommit.store.getRenderSettings().locale).toBe("en-US");
    afterCommit.store.close();
  });

  it("migra le tombstone esistenti nello scope remoto senza perdere i dati", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Migrazione scope cestino");
    store.createPage({ title: "Pagina secondaria", slug: "pagina-secondaria" });
    const profile = await createStaticPageProfile(project, store);
    const previous = profile.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === "home");
    if (!previous || previous.kind !== "document") throw new Error("Pagina fixture non trovata.");
    const payload = {
      entityKind: previous.kind,
      deletedAt: "2026-10-24T12:00:00.000Z",
      label: String(previous.payload.title),
      previousRevisionHash: previous.revisionHash,
      previousPayload: previous.payload,
    } as Record<string, JsonValue>;
    const tombstone: TransferEntity = {
      id: previous.id,
      kind: "tombstone",
      schemaVersion: 1,
      revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
      baseHash: previous.revisionHash,
      payload,
    };
    store.applyTransferTombstone(tombstone, previous.revisionHash);
    store.close();

    const legacyDb = new DatabaseSync(path.join(project.directory, "content.sqlite"));
    legacyDb.exec(`
      CREATE TABLE transfer_tombstones_legacy (
        id TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        entity_json TEXT NOT NULL
      );
      INSERT INTO transfer_tombstones_legacy(id, entity_kind, deleted_at, entity_json)
        SELECT id, entity_kind, deleted_at, entity_json FROM transfer_tombstones;
      DROP TABLE transfer_tombstones;
      ALTER TABLE transfer_tombstones_legacy RENAME TO transfer_tombstones;
      PRAGMA user_version = 0;
    `);
    legacyDb.close();

    const reopened = await catalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto non si è riaperto dopo la migrazione.");
    try {
      expect(reopened.store.listTransferTombstones("remote").map((entity) => entity.id)).toContain(previous.id);
      expect(reopened.store.listTransferTombstones("local")).toEqual([]);
      const recoveryFiles = await readdir(path.join(project.directory, "recovery"));
      const snapshots = recoveryFiles.filter((name) => name.startsWith("before-schema-v0-to-v6-"));
      expect(snapshots).toHaveLength(1);
      const snapshot = snapshots[0];
      if (!snapshot) throw new Error("La copia di sicurezza della migrazione non è stata creata.");
      const backup = new DatabaseSync(path.join(project.directory, "recovery", snapshot), { readOnly: true });
      try {
        expect((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
        expect((backup.prepare("PRAGMA table_info(transfer_tombstones)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("scope");
        expect((backup.prepare("SELECT id FROM transfer_tombstones").all() as Array<{ id: string }>).map(({ id }) => id)).toContain(previous.id);
      } finally {
        backup.close();
      }
    } finally {
      reopened.store.close();
    }
  });

  it("annulla una migrazione SQLite interrotta, conserva il database e consente il recupero", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Migrazione recuperabile");
    const asset = store.saveAsset({ bytes: Buffer.from("recoverable-image"), mimeType: "image/png", filename: "logo.png", alt: "Logo" });
    store.close();

    const legacyDb = new DatabaseSync(path.join(project.directory, "content.sqlite"));
    legacyDb.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE assets_legacy (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        alt TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO assets_legacy(id,sha256,mime_type,filename,alt,caption,relative_path,created_at)
        SELECT id,sha256,mime_type,filename,alt,caption,relative_path,created_at FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_legacy RENAME TO assets;
      CREATE TRIGGER fail_asset_alias_backfill BEFORE UPDATE ON assets
        BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
      PRAGMA user_version=0;
    `);
    legacyDb.close();

    // Migration adds the alias, then the trigger aborts its backfill.
    // The DDL and user_version change must roll back as one transaction.
    // A failed migration is reported, not hidden as "no such project".
    await expect(catalog.openProject(project.id)).rejects.toMatchObject({ code: "cms-project-unavailable" });
    const recoveryFiles = await readdir(path.join(project.directory, "recovery"));
    const snapshots = recoveryFiles.filter((name) => name.startsWith("before-schema-v0-to-v6-"));
    expect(snapshots).toHaveLength(1);
    const failedDb = new DatabaseSync(path.join(project.directory, "content.sqlite"), { readOnly: true });
    try {
      expect((failedDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
      expect((failedDb.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("alias");
      expect(failedDb.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(failedDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      failedDb.close();
    }

    const retryDb = new DatabaseSync(path.join(project.directory, "content.sqlite"));
    retryDb.exec("DROP TRIGGER fail_asset_alias_backfill");
    retryDb.close();
    const recovered = await catalog.openProject(project.id);
    if (!recovered) throw new Error("Il progetto non si è riaperto dopo aver rimosso il failpoint della migrazione.");
    try {
      expect(recovered.store.listAssets()).toMatchObject([{ id: asset.id, alias: 1, alt: "Logo" }]);
      await expect(recovered.store.readAsset(asset.id)).resolves.toMatchObject({ bytes: Buffer.from("recoverable-image") });
      expect((await readdir(path.join(project.directory, "recovery"))).filter((name) => name.startsWith("before-schema-v0-to-v6-"))).toHaveLength(2);
    } finally {
      recovered.store.close();
    }
  });

  it("refuses to import tombstones without a linked project and a verified common base", async () => {
    const sourceCatalog = await newCatalog();
    const receivingCatalog = await newCatalog();
    const { project, store } = await sourceCatalog.createProject("Tombstone sicura");
    store.createPage({ title: "Pagina secondaria", slug: "pagina-secondaria" });
    const exported = await createStaticPageProfile(project, store);
    const profile = structuredClone(exported.profile);
    const previous = profile.entities.find((entity) => entity.kind === "document")!;
    const deletedAt = "2026-10-24T12:00:00.000Z";
    const previousRevisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(previous.kind, previous.schemaVersion, previous.payload), "utf8")
      .digest("hex");
    const payload = {
      entityKind: previous.kind,
      deletedAt,
      label: String(previous.payload.title),
      previousRevisionHash,
      previousPayload: previous.payload,
    } as Record<string, JsonValue>;
    const tombstone: TransferEntity = {
      id: previous.id,
      kind: "tombstone",
      schemaVersion: 1,
      revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
      baseHash: previous.revisionHash,
      payload,
    };
    profile.entities[profile.entities.indexOf(previous)] = tombstone;

    await expect(receivingCatalog.importStaticPageProfile(profile, exported.files)).rejects.toThrow(/senza una base collegata/u);
    expect(await receivingCatalog.openProject(project.id)).toBeNull();
    store.close();
  });

  it("never lets a remote query source with another id replace a local one of the same name silently", async () => {
    const remoteCatalog = await newCatalog();
    const localCatalog = await newCatalog();
    const remoteSiteId = "550e8400-e29b-41d4-a716-446655440199";
    const { project, store: remoteStore } = await remoteCatalog.createProject("Fonti per chiave");
    const initial = await createStaticPageProfile(project, remoteStore);
    const local = await localCatalog.importStaticPageProfile(initial.profile, initial.files, remoteSiteId);
    local.store.content.saveQuerySources({ products: { type: "json", data: [{ name: "locale" }] } });
    local.store.close();

    remoteStore.content.saveQuerySources({ products: { type: "json", data: [{ name: "remota" }] } });
    const changed = await createStaticPageProfile(project, remoteStore);
    const source = changed.profile.entities.find((entity) => entity.kind === "query-source");
    if (!source) throw new Error("La fonte remota non è nel profilo.");
    source.id = "550e8400-e29b-41d4-a716-4466554401aa";
    delete (source as { baseHash?: string }).baseHash;

    await expect(localCatalog.importRemoteStaticPageProfile(changed.profile, changed.files, remoteSiteId)).rejects.toThrow("Il sito remoto e la copia locale");
    const reopened = await localCatalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto locale non si è riaperto.");
    try {
      expect(reopened.store.content.listQuerySources().products?.data).toEqual([{ name: "locale" }]);
    } finally {
      reopened.store.close();
    }
    remoteStore.close();
  });

  it("applies a linked, unchanged page tombstone with a durable recovery copy", async () => {
    const remoteCatalog = await newCatalog();
    const localCatalog = await newCatalog();
    const remoteSiteId = "550e8400-e29b-41d4-a716-446655440199";
    const { project, store: remoteStore } = await remoteCatalog.createProject("Cancellazione recuperabile");
    const target = remoteStore.createPage({ title: "Pagina da rimuovere", slug: "pagina-da-rimuovere" });
    const initial = await createStaticPageProfile(project, remoteStore);
    const local = await localCatalog.importStaticPageProfile(initial.profile, initial.files, remoteSiteId);
    local.store.close();

    const previous = initial.profile.entities.find((entity) => entity.id === target.id)!;
    const deletedAt = "2026-10-24T12:00:00.000Z";
    const payload = {
      entityKind: previous.kind,
      deletedAt,
      label: String(previous.payload.title),
      previousRevisionHash: previous.revisionHash,
      previousPayload: previous.payload,
    } as Record<string, JsonValue>;
    const tombstone: TransferEntity = {
      id: previous.id,
      kind: "tombstone",
      schemaVersion: 1,
      revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
      baseHash: previous.revisionHash,
      payload,
    };
    remoteStore.applyTransferTombstone(tombstone, previous.revisionHash);
    const deletedRemote = await createStaticPageProfile(project, remoteStore);
    const recoveryId = deletedRemote.profile.manifest.selection.snapshot;

    const applied = await localCatalog.importRemoteStaticPageProfile(deletedRemote.profile, deletedRemote.files, remoteSiteId);
    expect(applied.changed).toContain(target.id);

    const reopened = await localCatalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto locale non si è riaperto dopo la sincronizzazione.");
    try {
      expect(reopened.store.listPages().some((page) => page.id === target.id)).toBe(false);
      expect(reopened.store.listTransferTombstones().map((entity) => entity.id)).toContain(target.id);
      const recovery = await readFile(path.join(reopened.project.directory, "recovery", `before-delete-${recoveryId}.sqlite`));
      expect(recovery.subarray(0, 16).toString("binary")).toBe("SQLite format 3\0");
      expect(reopened.store.restoreTransferTombstone(target.id)).toBe(true);
      expect(reopened.store.listPages().some((page) => page.id === target.id)).toBe(true);
    } finally {
      reopened.store.close();
    }
    remoteStore.close();
  });

  it("applies and restores a linked relational-record tombstone without erasing its SQLite data", async () => {
    const remoteCatalog = await newCatalog();
    const localCatalog = await newCatalog();
    const remoteSiteId = "550e8400-e29b-41d4-a716-446655440199";
    const { project, store: remoteStore } = await remoteCatalog.createProject("Record recuperabile");
    const type = remoteStore.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [{ key: "summary", label: "Sommario", type: "text", public: true }] });
    expect(type.status).toBe("saved");
    const created = remoteStore.content.createRecord({ typeKey: "article", title: "Contenuto da rimuovere", status: "published", values: { summary: "Resta nel progetto" } });
    expect(created.status).toBe("saved");
    if (created.status !== "saved") throw new Error("Il record CMS avrebbe dovuto essere creato.");

    const initial = await createStaticPageProfile(project, remoteStore);
    const local = await localCatalog.importStaticPageProfile(initial.profile, initial.files, remoteSiteId);
    local.store.close();
    const previous = initial.profile.entities.find((entity) => entity.id === created.record.id);
    if (!previous || previous.kind !== "content-record") throw new Error("Il record non è presente nel profilo di partenza.");
    const payload = {
      entityKind: previous.kind,
      deletedAt: "2026-10-24T12:00:00.000Z",
      label: String(previous.payload.title),
      previousRevisionHash: previous.revisionHash,
      previousPayload: previous.payload,
    } as Record<string, JsonValue>;
    const tombstone: TransferEntity = {
      id: previous.id,
      kind: "tombstone",
      schemaVersion: 1,
      revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
      baseHash: previous.revisionHash,
      payload,
    };
    remoteStore.applyTransferTombstone(tombstone, previous.revisionHash);
    const deletedRemote = await createStaticPageProfile(project, remoteStore);
    const applied = await localCatalog.importRemoteStaticPageProfile(deletedRemote.profile, deletedRemote.files, remoteSiteId);
    expect(applied.changed).toContain(created.record.id);

    const reopened = await localCatalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto locale non si è riaperto dopo la sincronizzazione.");
    try {
      expect(reopened.store.content.getRecordById(created.record.id, true)).toBeNull();
      expect(reopened.store.content.listRecords({ typeKey: "article", status: "any", includePrivate: true })).toMatchObject({ items: [], total: 0 });
      expect(reopened.store.listTransferTombstones().map((entity) => entity.id)).toContain(created.record.id);
      expect(reopened.store.restoreTransferTombstone(created.record.id)).toBe(true);
      expect(reopened.store.content.getRecordById(created.record.id, true)).toMatchObject({ title: "Contenuto da rimuovere", values: { summary: "Resta nel progetto" } });
      expect(reopened.store.listTransferTombstones().map((entity) => entity.id)).not.toContain(created.record.id);
    } finally {
      reopened.store.close();
    }
    remoteStore.close();
  });

  it("applies a batch tombstone for related records when every incoming reference is deleted too", async () => {
    const remoteCatalog = await newCatalog();
    const localCatalog = await newCatalog();
    const remoteSiteId = "550e8400-e29b-41d4-a716-446655440199";
    const { project, store: remoteStore } = await remoteCatalog.createProject("Record relazionali recuperabili");
    remoteStore.content.saveType({ key: "author", label: "Autore", expectedHead: null, fields: [{ key: "bio", label: "Biografia", type: "text", public: true }] });
    remoteStore.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [{ key: "author", label: "Autore", type: "relation", targetType: "author", public: true }] });
    const author = remoteStore.content.createRecord({ typeKey: "author", title: "Autrice", status: "published", values: { bio: "Profilo" } });
    if (author.status !== "saved") throw new Error("Il record autore avrebbe dovuto essere creato.");
    const article = remoteStore.content.createRecord({ typeKey: "article", title: "Articolo collegato", status: "published", values: { author: author.record.id } });
    if (article.status !== "saved") throw new Error("Il record collegato avrebbe dovuto essere creato.");

    const initial = await createStaticPageProfile(project, remoteStore);
    const local = await localCatalog.importStaticPageProfile(initial.profile, initial.files, remoteSiteId);
    local.store.close();
    const tombstones: TransferEntity[] = [];
    for (const id of [author.record.id, article.record.id]) {
      const previous = initial.profile.entities.find((entity) => entity.id === id);
      if (!previous || previous.kind !== "content-record") throw new Error(`Manca il record ${id} nel profilo iniziale.`);
      const payload = {
        entityKind: previous.kind,
        deletedAt: "2026-10-24T12:00:00.000Z",
        label: String(previous.payload.title),
        previousRevisionHash: previous.revisionHash,
        previousPayload: previous.payload,
      } as Record<string, JsonValue>;
      tombstones.push({
        id: previous.id,
        kind: "tombstone",
        schemaVersion: 1,
        revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
        baseHash: previous.revisionHash,
        payload,
      });
    }
    remoteStore.applyTransferTombstones(tombstones.map((entity) => ({ entity, verifiedCurrentHash: String(entity.payload.previousRevisionHash) })));

    const deletedRemote = await createStaticPageProfile(project, remoteStore);
    const applied = await localCatalog.importRemoteStaticPageProfile(deletedRemote.profile, deletedRemote.files, remoteSiteId);
    expect(applied.changed).toEqual(expect.arrayContaining(tombstones.map((entity) => entity.id)));

    const reopened = await localCatalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto locale non si è riaperto dopo la sincronizzazione dei record collegati.");
    try {
      expect(reopened.store.content.getRecordById(author.record.id, true)).toBeNull();
      expect(reopened.store.content.getRecordById(article.record.id, true)).toBeNull();
      expect(reopened.store.listTransferTombstones().map((entity) => entity.id)).toEqual(expect.arrayContaining(tombstones.map((entity) => entity.id)));
      expect(reopened.store.restoreTransferTombstone(author.record.id)).toBe(true);
      expect(reopened.store.restoreTransferTombstone(article.record.id)).toBe(true);
      expect(reopened.store.content.getRecordById(article.record.id, true)?.values.author).toMatchObject({ id: author.record.id, title: "Autrice" });
      expect(reopened.store.listTransferTombstones()).toEqual([]);
    } finally {
      reopened.store.close();
    }
    remoteStore.close();
  });

  it("applies and restores a batch of linked component, template, and media tombstones", async () => {
    const remoteCatalog = await newCatalog();
    const localCatalog = await newCatalog();
    const remoteSiteId = "550e8400-e29b-41d4-a716-446655440199";
    const { project, store: remoteStore } = await remoteCatalog.createProject("Componenti e media recuperabili");
    const component = remoteStore.createComponent({ ref: "ui/card", title: "Card" });
    const part = remoteStore.createTemplatePart({ ref: "site/header", title: "Intestazione" });
    const template = remoteStore.createTemplate({ ref: "site/page", title: "Pagina" });
    const imageFixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-page-v1.json", import.meta.url), "utf8")) as {
      profile: StaticPageProfile;
      files: Record<string, string>;
    };
    const imageEntity = imageFixture.profile.entities.find((entity) => entity.kind === "asset");
    if (!imageEntity || imageEntity.kind !== "asset") throw new Error("Manca il media PNG di fixture.");
    const imageBytes = Buffer.from(imageFixture.files[imageEntity.payload.path] ?? "", "base64");
    const asset = remoteStore.saveAsset({ bytes: imageBytes, mimeType: "image/png", filename: "logo.png", alt: "Logo", caption: "Didascalia" });
    const initial = await createStaticPageProfile(project, remoteStore);
    const local = await localCatalog.importStaticPageProfile(initial.profile, initial.files, remoteSiteId);
    local.store.close();

    const tombstones: TransferEntity[] = [];
    for (const id of [component.id, part.id, template.id, asset.id]) {
      const previous = initial.profile.entities.find((entity) => entity.id === id);
      if (!previous || !["component", "template-part", "template", "asset"].includes(previous.kind)) throw new Error(`Manca l’entità ${id} nel profilo iniziale.`);
      const payload = {
        entityKind: previous.kind,
        deletedAt: "2026-10-24T12:00:00.000Z",
        label: String(previous.payload.title ?? previous.payload.ref ?? "Media"),
        previousRevisionHash: previous.revisionHash,
        previousPayload: previous.payload,
      } as Record<string, JsonValue>;
      const tombstone: TransferEntity = {
        id: previous.id,
        kind: "tombstone",
        schemaVersion: 1,
        revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
        baseHash: previous.revisionHash,
        payload,
      };
      remoteStore.applyTransferTombstone(tombstone, previous.revisionHash);
      tombstones.push(tombstone);
    }

    const deletedRemote = await createStaticPageProfile(project, remoteStore);
    const recoveryId = deletedRemote.profile.manifest.selection.snapshot;
    const applied = await localCatalog.importRemoteStaticPageProfile(deletedRemote.profile, deletedRemote.files, remoteSiteId);
    expect(applied.changed).toEqual(expect.arrayContaining(tombstones.map((entity) => entity.id)));
    const reopened = await localCatalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto locale non si è riaperto dopo la sincronizzazione.");
    try {
      expect(reopened.store.listComponents().map((item) => item.id)).not.toContain(component.id);
      expect(reopened.store.listTemplateParts().map((item) => item.id)).not.toContain(part.id);
      expect(reopened.store.listTemplates().map((item) => item.id)).not.toContain(template.id);
      expect(reopened.store.listAssets().map((item) => item.id)).not.toContain(asset.id);
      expect(reopened.store.listTransferTombstones().map((entity) => entity.id)).toEqual(expect.arrayContaining(tombstones.map((entity) => entity.id)));
      const recovery = await readFile(path.join(reopened.project.directory, "recovery", `before-delete-${recoveryId}.sqlite`));
      expect(recovery.subarray(0, 16).toString("binary")).toBe("SQLite format 3\0");
      for (const tombstone of tombstones) expect(reopened.store.restoreTransferTombstone(tombstone.id)).toBe(true);
      expect(reopened.store.getComponentById(component.id)?.kind).toBe("component");
      expect(reopened.store.listTemplateParts().map((item) => item.id)).toContain(part.id);
      expect(reopened.store.listTemplates().map((item) => item.id)).toContain(template.id);
      expect(reopened.store.listAssets().map((item) => item.id)).toContain(asset.id);
      expect(reopened.store.listTransferTombstones()).toEqual([]);
    } finally {
      reopened.store.close();
    }
    remoteStore.close();
  });

  it("imports remote relational edits into an existing project without losing relations or local sync bases", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-project-v3.json", import.meta.url), "utf8")) as {
      profile: StaticPageProfile;
      files: Record<string, string>;
    };
    const files = new Map(Object.entries(fixture.files).map(([name, value]) => [name, Buffer.from(value, "base64")]));
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "histos-cms-relational-pull-local-"));
    const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "histos-cms-relational-pull-remote-"));
    temporaryDirectories.push(localRoot, remoteRoot);
    const localCatalog = new CmsProjectCatalog(localRoot);
    const remoteCatalog = new CmsProjectCatalog(remoteRoot);
    const remoteSiteId = "550e8400-e29b-41d4-a716-446655440199";
    const local = await localCatalog.importStaticPageProfile(fixture.profile, files, remoteSiteId);
    local.store.close();
    const remote = await remoteCatalog.importStaticPageProfile(fixture.profile, files);
    try {
      const type = remote.store.content.getType("events");
      if (!type) throw new Error("Il tipo evento manca dalla fixture remota.");
      expect(remote.store.content.saveType({ id: type.id, key: type.key, label: "Appuntamenti", fields: type.fields, singleTemplateRef: type.singleTemplateRef, archiveTemplateRef: type.archiveTemplateRef, expectedHead: type.headRevision }).status).toBe("saved");

      const speakerType = remote.store.content.getType("speaker");
      if (!speakerType) throw new Error("Il tipo relatore manca dalla fixture remota.");
      const cyclicFields = [...speakerType.fields, { key: "featured_event", label: "Evento in evidenza", type: "relation" as const, targetType: "events", required: true, public: true, multiple: false }];
      expect(remote.store.content.saveType({ id: speakerType.id, key: speakerType.key, label: speakerType.label, fields: cyclicFields, singleTemplateRef: speakerType.singleTemplateRef, archiveTemplateRef: speakerType.archiveTemplateRef, expectedHead: speakerType.headRevision }).status).toBe("saved");

      const taxonomy = remote.store.content.getTaxonomy("event-category");
      if (!taxonomy) throw new Error("La tassonomia manca dalla fixture remota.");
      expect(remote.store.content.saveTaxonomy({ id: taxonomy.id, key: taxonomy.key, label: "Categorie aggiornate", types: taxonomy.types, expectedHead: taxonomy.headRevision }).status).toBe("saved");

      const term = remote.store.content.getTermById("550e8400-e29b-41d4-a716-446655440106");
      if (!term) throw new Error("Il termine manca dalla fixture remota.");
      expect(remote.store.content.saveTerm({ id: term.id, taxonomyKey: term.taxonomyKey, slug: term.slug, label: "Formazione aggiornata", parentId: term.parentId, expectedHead: term.headRevision }).status).toBe("saved");

      const event = remote.store.content.getRecordById("550e8400-e29b-41d4-a716-446655440108", true);
      if (!event) throw new Error("Il record evento manca dalla fixture remota.");
      const speaker = event.values.speaker as { id: string };
      const terms = Object.fromEntries(Object.entries(event.terms).map(([key, entries]) => [key, entries.map((entry) => entry.alias)]));
      expect(remote.store.content.saveRecord({
        id: event.id,
        typeKey: event.typeKey,
        title: "Incontro aggiornato dal sito remoto",
        slug: event.slug,
        locale: event.locale,
        status: event.status,
        publishedAt: event.publishedAt,
        excerpt: event.excerpt,
        order: event.order,
        values: { ...event.values, speaker: speaker.id, starts_at: "2026-11-16T09:30:00+01:00" },
        terms,
        expectedHead: event.headRevision,
      }).status).toBe("saved");

      const speakerRecord = remote.store.content.getRecordById("550e8400-e29b-41d4-a716-446655440107", true);
      if (!speakerRecord) throw new Error("Il record relatore manca dalla fixture remota.");
      expect(remote.store.content.saveRecord({
        id: speakerRecord.id,
        typeKey: speakerRecord.typeKey,
        title: speakerRecord.title,
        slug: speakerRecord.slug,
        locale: speakerRecord.locale,
        status: speakerRecord.status,
        publishedAt: speakerRecord.publishedAt,
        excerpt: speakerRecord.excerpt,
        order: speakerRecord.order,
        values: { ...speakerRecord.values, featured_event: event.id },
        terms: Object.fromEntries(Object.entries(speakerRecord.terms).map(([key, entries]) => [key, entries.map((entry) => entry.alias)])),
        expectedHead: speakerRecord.headRevision,
      }).status).toBe("saved");

      const preset = remote.store.content.listQueryPresets().presets.find((item) => item.key === "upcoming_events");
      if (!preset) throw new Error("La query non è presente nella fixture remota.");
      expect(remote.store.content.saveQueryPreset({ ...preset, label: "Prossimi appuntamenti", expectedHead: preset.headRevision }).status).toBe("saved");
      remote.store.content.saveQuerySources({ featured: { type: "json", data: [{ label: "In programma", href: "/agenda/" }] } });

      const remoteSnapshot = await createStaticPageProfile(remote.project, remote.store);
      const sourceEntity = remoteSnapshot.profile.entities.find((item) => item.kind === "query-source" && item.payload.name === "featured");
      if (!sourceEntity) throw new Error("La sorgente query manca dal profilo remoto.");
      const result = await localCatalog.importRemoteStaticPageProfile(remoteSnapshot.profile, remoteSnapshot.files, remoteSiteId);
      expect(result.changed).toEqual(expect.arrayContaining([
        type.id,
        speakerType.id,
        taxonomy.id,
        term.id,
        event.id,
        speakerRecord.id,
        sourceEntity.id,
      ]));
      const importedType = result.project.id === local.project.id ? await localCatalog.openProject(local.project.id) : null;
      if (!importedType) throw new Error("Il progetto locale non è stato riaperto dopo il pull.");
      try {
        expect(importedType.store.content.getType("events")?.label).toBe("Appuntamenti");
        expect(importedType.store.content.getType("speaker")?.fields.find((field) => field.key === "featured_event")).toMatchObject({ type: "relation", targetType: "events", required: true });
        expect(importedType.store.content.getTaxonomy("event-category")?.label).toBe("Categorie aggiornate");
        expect(importedType.store.content.getTermById(term.id)?.label).toBe("Formazione aggiornata");
        expect(importedType.store.content.getRecordById(event.id, true)).toMatchObject({
          title: "Incontro aggiornato dal sito remoto",
          values: { speaker: { id: "550e8400-e29b-41d4-a716-446655440107" }, starts_at: "2026-11-16T09:30:00+01:00" },
        });
        expect(importedType.store.content.getRecordById(speakerRecord.id, true)?.values.featured_event).toMatchObject({ id: event.id, title: "Incontro aggiornato dal sito remoto" });
        expect(importedType.store.content.listQueryPresets().presets.find((item) => item.key === "upcoming_events")?.label).toBe("Prossimi appuntamenti");
        expect(importedType.store.content.listQuerySources()).toEqual({ featured: { type: "json", data: [{ label: "In programma", href: "/agenda/" }] } });
        expect(importedType.store.getSyncBase(remoteSiteId, event.id)?.baseHash).toBe(remoteSnapshot.profile.entities.find((item) => item.id === event.id)?.revisionHash);
      } finally {
        importedType.store.close();
      }
    } finally {
      remote.store.close();
    }
  });

  it("creates an isolated SQLite project with a real starter page and stylesheet entity", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Progetto 😀");
    const pages = store.listPages();
    expect(project.directory).toContain(project.id);
    expect(pages).toHaveLength(1);
    expect(store.getStyles()?.kind).toBe("styles");
    const first = store.getHead(pages[0]!.id)!;
    expect(first.content).toContain("wp:xb/element");
    expect(first.content).toContain("Home");
    store.close();

    const manifest = JSON.parse(await readFile(path.join(project.directory, "project.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("directory");
    const reopened = await catalog.openProject(project.id);
    expect(reopened?.store.getHead(pages[0]!.id)?.content).toBe(first.content);
    reopened?.store.close();
  });

  it("persists validated render locale and time zone with the project", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Impostazioni regionali");
    const defaults = store.getRenderSettings();
    expect(defaults.locale).toBeTruthy();
    expect(defaults.timeZone).toBeTruthy();
    expect(store.setRenderSettings({ locale: "it-it", timeZone: "Europe/Rome" })).toEqual({ locale: "it-IT", timeZone: "Europe/Rome" });
    expect(() => store.setRenderSettings({ locale: "not a locale", timeZone: "Europe/Rome" })).toThrow(/Lingua e formato/u);
    expect(() => store.setRenderSettings({ locale: "it-IT", timeZone: "Fuso Inventato" })).toThrow(/Fuso orario/u);
    store.close();

    const reopened = await catalog.openProject(project.id);
    expect(reopened?.store.getRenderSettings()).toEqual({ locale: "it-IT", timeZone: "Europe/Rome" });
    reopened?.store.close();
  });

  it("creates immutable revisions, treats identical saves as no-op, and preserves stale edits as conflicts", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Revisions");
    const page = store.listPages()[0]!;
    const base = store.getHead(page.id)!;
    const firstEdit = store.saveDocument({ entityId: page.id, expectedHead: base.id, content: `${base.content}<!-- edited -->` });
    expect(firstEdit.status).toBe("saved");
    if (firstEdit.status !== "saved") throw new Error("Expected saved revision");
    const duplicate = store.saveDocument({ entityId: page.id, expectedHead: firstEdit.revision.id, content: firstEdit.revision.content });
    expect(duplicate.status).toBe("saved");
    if (duplicate.status !== "saved") throw new Error("Expected saved no-op");
    expect(duplicate.revision.id).toBe(firstEdit.revision.id);

    const conflict = store.saveDocument({ entityId: page.id, expectedHead: base.id, content: `${base.content}<!-- branch -->` });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") throw new Error("Expected conflict");
    expect(store.listConflicts(page.id)).toHaveLength(1);
    expect(conflict.conflict.proposedContent).toContain("branch");

    const resolved = store.resolveConflict(conflict.conflict.id, `${firstEdit.revision.content}<!-- merged -->`);
    expect(resolved.status).toBe("saved");
    expect(store.listConflicts(page.id)).toHaveLength(0);
    expect(store.listRevisions(page.id)).toHaveLength(3);
    store.close();

    const reopened = await catalog.openProject(project.id);
    expect(reopened?.store.getHead(page.id)?.content).toContain("merged");
    reopened?.store.close();
  });

  it("detects writes made through another SQLite handle", async () => {
    const catalog = await newCatalog();
    const { project, store: firstHandle } = await catalog.createProject("Finestre");
    const second = await catalog.openProject(project.id);
    const page = firstHandle.listPages()[0]!;
    const firstHead = firstHandle.getHead(page.id)!;
    const secondHead = second!.store.getHead(page.id)!;
    const saved = firstHandle.saveDocument({ entityId: page.id, expectedHead: firstHead.id, content: `${firstHead.content}<!-- finestra A -->` });
    expect(saved.status).toBe("saved");
    const stale = second!.store.saveDocument({ entityId: page.id, expectedHead: secondHead.id, content: `${secondHead.content}<!-- finestra B -->` });
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.conflict.proposedContent).toContain("finestra B");
    firstHandle.close();
    second!.store.close();
  });

  it("serializes simultaneous stale saves from independent Node processes", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Processi concorrenti");
    const page = store.listPages()[0];
    if (!page) throw new Error("La pagina iniziale del progetto non esiste.");
    const originalHead = store.getHead(page.id);
    if (!originalHead) throw new Error("La revisione iniziale del progetto non esiste.");
    store.close();

    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cms-concurrent-writer.mjs");
    const synchronizationDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-process-race-"));
    temporaryDirectories.push(synchronizationDirectory);
    const artifactPath = (kind: "ready" | "result" | "error", label: string) => path.join(synchronizationDirectory, `${kind}-${label}.json`);
    const spawnWriter = (label: string) => spawn(process.execPath, [helper, path.dirname(catalog.projectsDirectory), project.id, page.id, label, synchronizationDirectory], { stdio: "ignore" });
    const waitForJson = async (file: string, child: ReturnType<typeof spawnWriter>): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
          if (value.kind === "error") throw new Error(`Writer ${String(value.label)}: ${String(value.error)}`);
          return value;
        }
        catch (error) {
          if (error instanceof Error && error.message.startsWith("Writer ")) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            const value = JSON.parse(await readFile(artifactPath("error", path.basename(file).replace(/^(?:ready|result)-|\.json$/gu, "")), "utf8")) as Record<string, unknown>;
            throw new Error(`Writer ${String(value.label)}: ${String(value.error)}`);
          } catch (failure) {
            if (failure instanceof Error && failure.message.startsWith("Writer ")) throw failure;
            if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
          }
          if (child.exitCode !== null) throw new Error(`Writer terminato con codice ${child.exitCode} senza produrre ${path.basename(file)}.`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw new Error(`Timeout aspettando ${path.basename(file)}.`);
    };
    const writers: Array<{ label: string; child: ReturnType<typeof spawnWriter> }> = [];
    try {
      const firstWriter = { label: "processo A", child: spawnWriter("processo-a") };
      writers.push(firstWriter);
      const firstReady = await waitForJson(artifactPath("ready", "processo-a"), firstWriter.child);
      const secondWriter = { label: "processo B", child: spawnWriter("processo-b") };
      writers.push(secondWriter);
      const secondReady = await waitForJson(artifactPath("ready", "processo-b"), secondWriter.child);
      expect([firstReady.head, secondReady.head]).toEqual([originalHead.id, originalHead.id]);

      await writeFile(path.join(synchronizationDirectory, "save"), "go\n", { mode: 0o600 });
      const results = await Promise.all(writers.map((writer) => waitForJson(artifactPath("result", writer.label === "processo A" ? "processo-a" : "processo-b"), writer.child)));
      expect(results.map((item) => item.status).sort()).toEqual(["conflict", "saved"]);

      await Promise.all(writers.map(({ child }) => new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) {
          if (child.exitCode === 0) resolve();
          else reject(new Error(`Writer terminato con codice ${child.exitCode}.`));
          return;
        }
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Writer terminato con codice ${code}.`)));
      })));

      const reopened = await catalog.openProject(project.id);
      expect(reopened).not.toBeNull();
      if (!reopened) throw new Error("Il progetto non si è riaperto dopo le scritture concorrenti.");
      const current = reopened.store.getHead(page.id);
      if (!current) throw new Error("La revisione vincente non è stata salvata.");
      const conflict = reopened.store.listConflicts(page.id)[0];
      const saved = results.find((item) => item.status === "saved");
      const rejected = results.find((item) => item.status === "conflict");
      expect(reopened.store.listRevisions(page.id)).toHaveLength(2);
      expect(reopened.store.listConflicts(page.id)).toHaveLength(1);
      expect(saved).toBeDefined();
      expect(rejected).toBeDefined();
      expect(current.content).toContain(`<!-- ${String(saved?.label)} -->`);
      expect(conflict?.proposedContent).toContain(`<!-- ${String(rejected?.label)} -->`);
      expect(conflict?.proposedContent).not.toBe(current.content);
      reopened.store.close();
    } finally {
      for (const writer of writers) {
        if (writer.child.exitCode === null && !writer.child.killed) {
          await new Promise<void>((resolve) => {
            writer.child.once("exit", () => resolve());
            writer.child.once("error", () => resolve());
            writer.child.kill("SIGTERM");
          });
        }
      }
    }
  }, 30_000);

  it("rolls back nested page revisions and entity creation as one SQLite unit", async () => {
    const catalog = await newCatalog();
    const { store } = await catalog.createProject("Transazione");
    const page = store.listPages()[0]!;
    const head = store.getHead(page.id)!;
    await expect(store.atomic(async () => {
      const saved = store.saveDocument({ entityId: page.id, expectedHead: head.id, content: `${head.content}<!-- tentative -->` });
      expect(saved.status).toBe("saved");
      store.createPage({ title: "Da annullare", slug: "da-annullare" });
      await Promise.resolve();
      throw new Error("annulla tutto");
    })).rejects.toThrow("annulla tutto");
    expect(store.listPages()).toHaveLength(1);
    expect(store.getHead(page.id)?.id).toBe(head.id);
    expect(store.listRevisions(page.id)).toHaveLength(1);
    store.close();
  });

  it("rolls back relational writes nested inside a project transaction and remains writable afterward", async () => {
    const catalog = await newCatalog();
    const { store } = await catalog.createProject("Atomicità CMS");
    await expect(store.atomic(() => {
      expect(store.content.saveType({ key: "temporary", label: "Temporaneo", fields: [], expectedHead: null }).status).toBe("saved");
      throw new Error("annulla contenuti CMS");
    })).rejects.toThrow("annulla contenuti CMS");
    expect(store.content.getType("temporary")).toBeNull();
    expect(store.content.saveType({ key: "restored", label: "Dopo rollback", fields: [], expectedHead: null }).status).toBe("saved");
    store.close();
  });

  it("keeps asset blob bytes deduplicated while retaining distinct alt and caption metadata", async () => {
    const catalog = await newCatalog();
    const { store } = await catalog.createProject("Media");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const one = store.saveAsset({ bytes, mimeType: "image/png", filename: "uno.png", alt: "Alt uno", caption: "Didascalia uno" });
    const two = store.saveAsset({ bytes, mimeType: "image/png", filename: "due.png", alt: "Alt due", caption: "Didascalia due" });
    expect(two.sha256).toBe(one.sha256);
    expect(two.id).not.toBe(one.id);
    expect(store.listAssets()).toHaveLength(2);
    const read = await store.readAsset(two.id);
    expect([...read!.bytes]).toEqual([...bytes]);
    expect(read!.metadata.alt).toBe("Alt due");
    store.close();
  });

  it("rimette a posto il file di un media danneggiato, mancante o sostituito quando si salvano di nuovo gli stessi byte", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Media riparati");
    try {
      const bytes = Buffer.from("immagine originale ".repeat(100));
      const asset = store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" });
      const file = path.join(project.directory, asset.relativePath);
      const folder = path.dirname(file);
      const sound = await stat(file, { bigint: true });
      // A file that holds the bytes is left as it is: no new inode, nothing rewritten.
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" }).id).toBe(asset.id);
      expect((await stat(file, { bigint: true })).ino).toBe(sound.ino);
      const damages: Array<[string, () => Promise<void>]> = [
        // Before: the same bytes with the same alt and caption returned the row and left the file as it was.
        ["troncato", () => truncate(file, 10)],
        ["modificato a parità di dimensione", () => writeFile(file, Buffer.alloc(bytes.byteLength, 0x41))],
        ["cresciuto", () => writeFile(file, Buffer.concat([bytes, Buffer.from("coda")]))],
        ["cancellato", () => unlink(file)],
      ];
      for (const [damage, apply] of damages) {
        await apply();
        await expect(store.readAsset(asset.id).then((read) => Buffer.from(read?.bytes ?? []).equals(bytes)).catch(() => false), damage).resolves.toBe(false);
        expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" }), damage).toMatchObject({ id: asset.id, alias: asset.alias, relativePath: asset.relativePath });
        expect(Buffer.from((await store.readAsset(asset.id))?.bytes ?? []).equals(bytes), damage).toBe(true);
        expect(store.listAssets(), damage).toHaveLength(1);
      }
      // The import path (an explicit id) and replaceAsset repair it too (before: replaceAsset kept any file on EEXIST).
      await truncate(file, 10);
      expect(store.saveAsset({ id: asset.id, bytes, mimeType: "image/png", filename: "foto.png" }).id).toBe(asset.id);
      expect(await readFile(file)).toEqual(bytes);
      await truncate(file, 10);
      store.replaceAsset({ id: asset.id, bytes, mimeType: "image/png", filename: "foto.png", alt: "", caption: "" });
      expect(await readFile(file)).toEqual(bytes);
      if (process.platform !== "win32") {
        // A symlink planted under the name is replaced, never followed or written through.
        const outside = path.join(path.dirname(catalog.projectsDirectory), "fuori.png");
        await writeFile(outside, "fuori");
        await rm(file);
        await symlink(outside, file);
        store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" });
        expect((await lstat(file)).isFile()).toBe(true);
        expect(await readFile(file)).toEqual(bytes);
        expect(await readFile(outside, "utf8")).toBe("fuori");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
      // Written aside and renamed into place: nothing left next to it.
      expect(await readdir(folder)).toEqual([path.basename(file)]);
    } finally { store.close(); }
  });

  it("persists component revisions and stale edits as recoverable conflicts", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Componenti");
    const component = store.createComponent({
      ref: "ui/card",
      title: "Card",
      schema: { props: { title: { type: "string", default: "Titolo" }, variant: { type: "enum", options: ["a", "b"], default: "a" } } },
    });
    expect(component.alias).toBeGreaterThanOrEqual(1_000_000_000);
    expect(store.getEntityByAlias(component.alias)).toBeNull();

    const first = store.saveComponent({
      alias: component.alias,
      expectedHead: component.headRevision,
      ref: component.ref,
      content: "<!-- revisione uno -->",
      schema: component.schema,
    });
    expect(first.status).toBe("saved");
    if (first.status !== "saved") throw new Error("Expected saved component revision");
    const stale = store.saveComponent({
      alias: component.alias,
      expectedHead: component.headRevision,
      ref: component.ref,
      content: "<!-- ramo concorrente -->",
      schema: component.schema,
    });
    expect(stale.status).toBe("conflict");
    if (stale.status !== "conflict") throw new Error("Expected a recoverable component conflict");
    expect(store.listComponentConflicts(component.alias)).toHaveLength(1);
    expect(stale.conflict.proposedContent).toContain("ramo concorrente");

    const resolved = store.resolveComponentConflict(stale.conflict.id, "<!-- merge -->", component.ref, component.schema);
    expect(resolved.status).toBe("saved");
    expect(store.listComponentConflicts(component.alias)).toHaveLength(0);
    store.close();

    const reopened = await catalog.openProject(project.id);
    expect(reopened?.store.getComponentByAlias(component.alias)?.content).toBe("<!-- merge -->");
    expect(reopened?.store.getComponentByAlias(component.alias)?.headRevision).not.toBe(component.headRevision);
    const page = reopened!.store.listPages()[0]!;
    const pageHead = reopened!.store.getHead(page.id)!;
    const used = reopened!.store.saveDocument({ entityId: page.id, expectedHead: pageHead.id, content: serializeXb(parse('<Ui.Card title="Usato"/>').blocks) });
    expect(used.status).toBe("saved");
    const current = reopened!.store.getComponentByAlias(component.alias)!;
    expect(() => reopened!.store.saveComponent({ alias: component.alias, expectedHead: current.headRevision, ref: "ui/card-next", content: current.content, schema: current.schema }))
      .toThrow(/Non posso rinominare ui\/card/u);
    expect(() => reopened!.store.createComponent({ ref: "ui/card-", title: "Ref invalida" })).toThrow(/grammatica Histeon/u);
    reopened?.store.close();
  });

  it("stores page templates and reusable template parts without mixing them with templates", async () => {
    const catalog = await newCatalog();
    const { project, store } = await catalog.createProject("Template Histeon");
    const template = store.createTemplate({ ref: "site/page", title: "Pagina" });
    const part = store.createTemplatePart({ ref: "site/header", title: "Intestazione" });
    expect(template.kind).toBe("template");
    expect(template.content).toContain('"name":"default"');
    expect(template.schema.props.page?.type).toBe("object");
    expect(part.kind).toBe("template-part");
    expect(store.listTemplates().map(({ id }) => id)).toEqual([template.id]);
    expect(store.listTemplateParts().map(({ id }) => id)).toEqual([part.id]);
    expect(store.listComponents().map(({ id }) => id)).toEqual([part.id]);
    expect(store.canUseTemplate(template.ref)).toBe(true);
    expect(() => store.createTemplate({ ref: "site/no-slot", title: "Senza slot", content: "" })).toThrow(/slot Histeon predefinito/u);

    const page = store.listPages()[0]!;
    const assigned = store.updatePageMetadata(page.id, { title: page.title, slug: page.slug, status: "published", templateRef: template.ref });
    expect(assigned).toMatchObject({ templateRef: template.ref, status: "published" });
    expect(() => store.saveComponent({ alias: template.alias, expectedHead: template.headRevision, ref: "site/renamed", content: template.content, schema: template.schema }))
      .toThrow(/Non posso rinominare site\/page/u);
    expect(store.updatePageMetadata(page.id, { title: page.title, slug: page.slug, status: "draft" }).templateRef).toBe(template.ref);
    store.close();

    const reopened = await catalog.openProject(project.id);
    expect(reopened?.store.listTemplates()[0]?.ref).toBe("site/page");
    expect(reopened?.store.listPages()[0]?.templateRef).toBe("site/page");
    reopened?.store.close();
  });

  it("rejects missing and recursive component references before committing them", async () => {
    const catalog = await newCatalog();
    const { store } = await catalog.createProject("Grafo componenti");
    const first = store.createComponent({ ref: "ui/first", title: "Primo" });
    const firstUse = '<!-- wp:xb/component {"uid":"firstuse123","ref":"ui/first"} /-->';
    expect(() => store.createComponent({ ref: "ui/missing", title: "Manca", content: '<!-- wp:xb/component {"uid":"missing123","ref":"ui/nope"} /-->' }))
      .toThrow(/non esiste nel progetto/u);
    const second = store.createComponent({ ref: "ui/second", title: "Secondo", content: firstUse });
    const recursive = '<!-- wp:xb/component {"uid":"seconduse123","ref":"ui/second"} /-->';
    expect(() => store.saveComponent({ alias: first.alias, expectedHead: first.headRevision, ref: first.ref, content: recursive, schema: first.schema }))
      .toThrow(/non possono richiamarsi/u);
    expect(store.getComponentById(first.id)?.content).toBe("");
    expect(store.getComponentById(second.id)?.content).toBe(firstUse);
    store.close();
  });
});

describe("apertura dei progetti e migrazioni dello schema", () => {
  it("mostra un progetto che non si apre invece di nasconderlo", async () => {
    const catalog = await newCatalog();
    const good = await catalog.createProject("Buono");
    good.store.close();
    const broken = await catalog.createProject("Rotto");
    broken.store.close();
    await writeFile(path.join(broken.project.directory, "project.json"), "{ non è json", "utf8");
    const listed = await catalog.listProjectsWithProblems();
    expect(listed.projects.map((item) => item.name)).toEqual(["Buono"]);
    expect(listed.unavailable).toHaveLength(1);
    expect(listed.unavailable[0]?.message).toMatch(/esiste ma non si può aprire: il file project\.json non è leggibile/u);
    expect(listed.unavailable[0]?.message).not.toContain(broken.project.directory);
    await expect(catalog.openProject(broken.project.id)).rejects.toMatchObject({ code: "cms-project-unavailable", status: 409 });
    expect(await catalog.openProject("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("rifiuta uno schema più nuovo e migra una volta sola uno schema vecchio, con copia di sicurezza", async () => {
    const catalog = await newCatalog();
    const newer = await catalog.createProject("Dal futuro");
    newer.store.close();
    const database = new DatabaseSync(path.join(newer.project.directory, "content.sqlite"));
    database.exec("PRAGMA user_version = 99");
    database.close();
    await expect(catalog.openProject(newer.project.id)).rejects.toMatchObject({ code: "cms-project-unavailable" });

    const older = await catalog.createProject("Versione 1");
    older.store.close();
    const v1 = new DatabaseSync(path.join(older.project.directory, "content.sqlite"));
    v1.exec("PRAGMA user_version = 1");
    v1.close();
    const migrated = await catalog.openProject(older.project.id);
    migrated?.store.close();
    const after = new DatabaseSync(path.join(older.project.directory, "content.sqlite"));
    expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
    after.close();
    const snapshots = (await readdir(path.join(older.project.directory, "recovery"))).filter((name) => name.startsWith("before-schema-v1-to-v6-"));
    expect(snapshots).toHaveLength(1);
    // Already current: a second open migrates nothing and makes no new copy.
    (await catalog.openProject(older.project.id))?.store.close();
    expect((await readdir(path.join(older.project.directory, "recovery"))).filter((name) => name.startsWith("before-schema-"))).toHaveLength(1);
  });

  it("un database alla versione 3 senza le tabelle aggiunte dopo si apre e si fa leggere", async () => {
    const catalog = await newCatalog();
    const created = await catalog.createProject("Versione 3");
    created.store.close();
    const v3 = new DatabaseSync(path.join(created.project.directory, "content.sqlite"));
    v3.exec("DROP TABLE cms_document_scripts; DROP TABLE cms_import_reports; PRAGMA user_version = 3;");
    v3.close();
    const opened = await catalog.openProject(created.project.id);
    expect(opened).not.toBeNull();
    expect(opened!.store.getDocumentScript("00000000-0000-4000-8000-000000000000")).toBe("");
    opened!.store.close();
    expect((await catalog.listProjectsWithProblems()).unavailable).toEqual([]);
  });
});

describe("istantanee del database lasciate da un crash (S1)", () => {
  const snapshotName = () => `.snapshot-${randomUUID()}.sqlite`;
  const twoHoursAgo = () => new Date(Date.now() - 2 * 3_600_000);
  const snapshotsIn = async (directory: string) => (await readdir(directory)).filter((name) => name.startsWith(".snapshot-")).sort();

  it("al primo avvio del catalogo e prima di ogni nuova istantanea toglie solo le istantanee vecchie che nessuno usa", async () => {
    const catalog = await newCatalog();
    const root = path.dirname(catalog.projectsDirectory);
    const { project, store } = await catalog.createProject("Istantanee rimaste");
    store.close();
    const old = async (entry: string) => { await utimes(entry, twoHoursAgo(), twoHoursAgo()); return path.basename(entry); };
    const leftover = async (directory: string) => {
      const file = path.join(directory, snapshotName());
      await writeFile(file, "SQLite format 3\0 copia di un crash", { mode: 0o600 });
      return old(file);
    };
    const stale = await leftover(project.directory);
    // Kept: one another process may be using (an hour at most), and entries that are not a snapshot the app wrote.
    const recent = snapshotName();
    await writeFile(path.join(project.directory, recent), "in uso altrove", { mode: 0o600 });
    const folder = path.join(project.directory, snapshotName());
    await mkdir(folder);
    await old(folder);
    const uuid = randomUUID();
    const others = [`.snapshot-${uuid.toUpperCase()}.sqlite`, `.snapshot-${uuid}.sqlite-wal`, `.snapshot-${uuid}.sqlite.bak`, `snapshot-${uuid}.sqlite`, ".snapshot-x.sqlite"];
    for (const name of others) {
      await writeFile(path.join(project.directory, name), "di qualcuno");
      await old(path.join(project.directory, name));
    }
    // A staging folder is no project of the catalog.
    const staging = path.join(catalog.projectsDirectory, `.import-${randomUUID()}`);
    await mkdir(staging);
    const inStaging = await leftover(staging);
    let link = "";
    let target = "";
    let linkedInside = "";
    if (process.platform !== "win32") {
      // A symlink named as a snapshot, to an old file elsewhere: neither is removed.
      target = path.join(root, "di-qualcuno.sqlite");
      await writeFile(target, "di qualcuno");
      await old(target);
      link = snapshotName();
      await symlink(target, path.join(project.directory, link));
      await lutimes(path.join(project.directory, link), twoHoursAgo(), twoHoursAgo());
      // A project folder that is a symlink: never followed.
      const elsewhere = path.join(root, "progetto-altrove");
      await mkdir(elsewhere);
      linkedInside = await leftover(elsewhere);
      await symlink(elsewhere, path.join(catalog.projectsDirectory, randomUUID()));
    }

    // The app starts: its catalog sweeps once. Before: nothing removed the copy a crash left, at any start.
    const started = new CmsProjectCatalog(root);
    await started.initialize();
    const kept = [recent, path.basename(folder), ...others.filter((name) => name.startsWith(".snapshot-")), ...(link ? [link] : [])].sort();
    expect(await snapshotsIn(project.directory)).toEqual(kept);
    expect(await snapshotsIn(staging)).toEqual([inStaging]);
    if (link) {
      expect(await readFile(target, "utf8")).toBe("di qualcuno");
      expect(await snapshotsIn(path.join(root, "progetto-altrove"))).toEqual([linkedInside]);
    }
    expect(await snapshotsIn(project.directory)).not.toContain(stale);

    // Before a new snapshot, the project's folder is swept too, whatever takes it.
    const opened = await started.openProject(project.id);
    if (!opened) throw new Error("Il progetto non si apre.");
    try {
      const beforeBackup = await leftover(project.directory);
      await opened.store.withBackupSnapshot(async () => undefined);
      expect(await snapshotsIn(project.directory)).not.toContain(beforeBackup);
      const beforeCopy = await leftover(project.directory);
      await opened.store.createDatabaseSnapshot();
      expect(await snapshotsIn(project.directory)).not.toContain(beforeCopy);
      expect(await snapshotsIn(project.directory)).toEqual(kept);
    } finally { opened.store.close(); }
  });

  it("non toglie mai un'istantanea che questo processo sta usando, qualunque catalogo la cerchi", async () => {
    const catalog = await newCatalog();
    const root = path.dirname(catalog.projectsDirectory);
    const { project, store } = await catalog.createProject("Istantanea in uso");
    try {
      const result = await store.withBackupSnapshot(async ({ read }) => {
        const [inUse] = await snapshotsIn(project.directory);
        if (!inUse) throw new Error("Manca l'istantanea in uso.");
        // As old as a leftover: only this process knows it is in use.
        await utimes(path.join(project.directory, inUse), twoHoursAgo(), twoHoursAgo());
        await new CmsProjectCatalog(root).initialize();
        const other = await new CmsProjectCatalog(root).openProject(project.id);
        if (!other) throw new Error("Il progetto non si apre.");
        try {
          await other.store.withBackupSnapshot(async () => expect(await snapshotsIn(project.directory)).toHaveLength(2));
          await other.store.createDatabaseSnapshot();
        } finally { other.store.close(); }
        expect(await snapshotsIn(project.directory)).toEqual([inUse]);
        return (await read("content.sqlite")).bytes.subarray(0, 16).toString("binary");
      });
      expect(result).toBe("SQLite format 3\0");
      expect(await snapshotsIn(project.directory)).toEqual([]);
    } finally { store.close(); }
  });
});
