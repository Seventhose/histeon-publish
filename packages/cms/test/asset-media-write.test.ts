import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeNativeProjectArchive } from "../src/project-archive.js";
import { CmsProjectCatalog, type CmsProjectCatalogOptions } from "../src/project-repository.js";

// writeSync can write fewer bytes than asked: a few at a time, or as on a disk almost full (the bytes that fit, then
// ENOSPC on the next call). The flushes of written files are counted.
const writes = vi.hoisted(() => ({ perCall: Infinity, space: Infinity, fsyncs: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: ((fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => {
      const start = offset ?? 0;
      const wanted = length ?? buffer.byteLength - start;
      if (wanted > 0 && writes.space === 0) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
      const count = actual.writeSync(fd, buffer, start, Math.min(wanted, writes.perCall, writes.space), position);
      writes.space -= count;
      return count;
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      writes.fsyncs += 1;
      actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
  };
});

const roots: string[] = [];
async function catalog(options?: CmsProjectCatalogOptions): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-asset-write-"));
  roots.push(root);
  return new CmsProjectCatalog(root, options);
}

/** The refusal of every read and write of media while the project's media folder is not a real folder. */
const MEDIA_FOLDER_NOT_REAL = "La cartella media del progetto non è una cartella vera (per esempio è un collegamento a un'altra cartella o a un altro disco): Histeon Publish non legge e non salva media fuori dalla cartella del progetto. Riporta i media in una cartella «media» vera dentro la cartella del progetto.";

/** Entries of a folder with the random part of their names hidden. */
async function names(folder: string): Promise<string[]> {
  return (await readdir(folder)).map((name) => name.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>")).sort();
}

afterEach(async () => {
  writes.perCall = Infinity;
  writes.space = Infinity;
  writes.fsyncs = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scrittura dei file media", () => {
  it("scrive tutti i byte anche quando una scrittura ne accetta meno, e li porta su disco prima di rinominarli", async () => {
    const { project, store } = await (await catalog()).createProject("Scritture parziali");
    try {
      const bytes = Buffer.from("immagine scritta a pezzi ".repeat(40));
      // Three bytes a call. Before: one writeSync and its count ignored, so a file of three bytes under the name of
      // all of them, and every backup of the project refused as damaged from the start.
      writes.perCall = 3;
      const asset = store.saveAsset({ bytes, mimeType: "image/png", filename: "pezzi.png" });
      writes.perCall = Infinity;
      expect(await readFile(path.join(project.directory, asset.relativePath))).toEqual(bytes);
      // Before: never flushed, so a crash right after the rename could leave the name without its bytes.
      expect(writes.fsyncs).toBe(1);
      await expect(encodeNativeProjectArchive(project, store, "test")).resolves.toBeInstanceOf(Buffer);
    } finally { store.close(); }
  });

  it("su un disco pieno non lascia né un file a metà né un file temporaneo, e il media non viene salvato", async () => {
    const { project, store } = await (await catalog()).createProject("Disco pieno");
    try {
      const bytes = Buffer.from("immagine che non entra ".repeat(40));
      // 100 bytes fit, then ENOSPC. Before: the 100 bytes were renamed under the name of all of them and the asset
      // saved with them, a damaged media file from the start.
      writes.space = 100;
      expect(() => store.saveAsset({ bytes, mimeType: "image/png", filename: "piena.png" })).toThrow(/ENOSPC/u);
      writes.space = Infinity;
      expect(store.listAssets()).toEqual([]);
      const folder = path.join(project.directory, "media", "sha256");
      for (const prefix of await readdir(folder)) expect(await readdir(path.join(folder, prefix))).toEqual([]);
      // With room again, the same upload saves it whole.
      const asset = store.saveAsset({ bytes, mimeType: "image/png", filename: "piena.png" });
      expect(await readFile(path.join(project.directory, asset.relativePath))).toEqual(bytes);
    } finally { store.close(); }
  });

  it("porta su disco i media del catalogo dell'utente, non quelli di un catalogo usa-e-getta", async () => {
    for (const [options, flushes] of [[undefined, 1], [{ durable: true }, 1], [{ durable: false }, 0]] as const) {
      const scratch = await catalog(options);
      const { project, store } = await scratch.createProject("Durata");
      try {
        writes.fsyncs = 0;
        const asset = store.saveAsset({ bytes: Buffer.from(`immagine ${String(options?.durable)} `.repeat(30)), mimeType: "image/png", filename: "uno.png" });
        // Before: every media file flushed, the scratch copies of a prototype check too (1,000 flushes for 500 images).
        expect(writes.fsyncs, JSON.stringify(options)).toBe(flushes);
        expect((await readFile(path.join(project.directory, asset.relativePath))).byteLength).toBeGreaterThan(0);
      } finally { store.close(); }
      // The stores the catalog opens later write the same way, replaceAsset too.
      const opened = await scratch.openProject(project.id);
      try {
        writes.fsyncs = 0;
        const [asset] = opened!.store.listAssets();
        opened!.store.replaceAsset({ id: asset!.id, bytes: Buffer.from("altri byte ".repeat(30)), mimeType: "image/png", filename: "uno.png", alt: "", caption: "" });
        expect(writes.fsyncs, JSON.stringify(options)).toBe(flushes);
      } finally { opened?.store.close(); }
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rimette a posto un file media che non si può più leggere invece di fallire con il suo percorso", async () => {
    const { project, store } = await (await catalog()).createProject("Media illeggibile");
    try {
      const bytes = Buffer.from("immagine che non si legge ".repeat(40));
      const asset = store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" });
      const file = path.join(project.directory, asset.relativePath);
      await chmod(file, 0o000);
      // Before: «EACCES: permission denied, open '<data folder>/…/media/sha256/…'» at every upload of these bytes,
      // a 500 with the path for the builder.
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" }).id).toBe(asset.id);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file)).toEqual(bytes);
      await chmod(file, 0o000);
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png", alt: "Un altro testo" }).sha256).toBe(asset.sha256);
      expect(await readFile(file)).toEqual(bytes);
      expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
      await expect(encodeNativeProjectArchive(project, store, "test")).resolves.toBeInstanceOf(Buffer);
    } finally { store.close(); }
  });

  it("rimette a posto la cartella di un media diventata un file o un collegamento, senza seguirlo e senza cancellare nulla", async () => {
    const { project, store } = await (await catalog()).createProject("Cartella media");
    try {
      const bytes = Buffer.from("immagine nella sua cartella ".repeat(40));
      const asset = store.saveAsset({ bytes, mimeType: "image/png", filename: "due.png" });
      const file = path.join(project.directory, asset.relativePath);
      const shard = path.dirname(file);
      const shards = path.dirname(shard);
      const prefix = path.basename(shard);
      // A file where the folder media/sha256/<xx> must be: the backup says the media is missing and how to repair it.
      await rm(shard, { recursive: true });
      await writeFile(shard, "non una cartella");
      await expect(encodeNativeProjectArchive(project, store, "test")).rejects.toMatchObject({ code: "cms-backup-unrestorable", message: expect.stringMatching(/^Il media «due\.png» manca: .*Per ripararlo carica di nuovo lo stesso file/u) });
      // Before: «EEXIST: file already exists, mkdir '<data folder>/…/media/sha256/<xx>'»: the promised repair failed.
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "due.png" }).id).toBe(asset.id);
      expect((await lstat(shard)).isDirectory()).toBe(true);
      expect(await readFile(file)).toEqual(bytes);
      await expect(encodeNativeProjectArchive(project, store, "test")).resolves.toBeInstanceOf(Buffer);
      // Moved aside, not deleted.
      expect(await names(shards)).toEqual([prefix, `${prefix}.displaced-<uuid>`]);
      const displaced = (await readdir(shards)).find((name) => name !== prefix)!;
      expect(await readFile(path.join(shards, displaced), "utf8")).toBe("non una cartella");
      // A folder where the file must be: moved aside too, the file put in place.
      await rm(file);
      await mkdir(file);
      await writeFile(path.join(file, "dentro"), "di qualcuno");
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "due.png" }).id).toBe(asset.id);
      expect(await readFile(file)).toEqual(bytes);
      const aside = (await readdir(shard)).find((name) => name.includes(".displaced-"))!;
      expect(await readFile(path.join(shard, aside, "dentro"), "utf8")).toBe("di qualcuno");
      if (process.platform !== "win32") {
        // A symlink where the folder must be: replaced by a real folder, nothing written where it pointed.
        const outside = path.join(path.dirname(project.directory), "fuori");
        await mkdir(outside);
        await rm(shard, { recursive: true });
        await symlink(outside, shard);
        expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "due.png" }).id).toBe(asset.id);
        expect((await lstat(shard)).isDirectory()).toBe(true);
        expect(await readdir(outside)).toEqual([]);
        expect(await readFile(file)).toEqual(bytes);
        // The project's media folder itself is the boundary: a symlink there is never written through.
        const media = path.join(project.directory, "media");
        await rename(media, path.join(outside, "media"));
        await symlink(path.join(outside, "media"), media);
        expect(() => store.saveAsset({ bytes: Buffer.from("nuova"), mimeType: "image/png", filename: "nuova.png" })).toThrow(MEDIA_FOLDER_NOT_REAL);
        expect(store.listAssets()).toHaveLength(1);
      }
    } finally { store.close(); }
  });

  it.skipIf(process.platform === "win32")("una cartella media che non è una cartella vera si rifiuta allo stesso modo in lettura, scrittura, backup e copia, e il progetto si apre", async () => {
    const projects = await catalog();
    const { project, store } = await projects.createProject("Cartella media collegata");
    const bytes = Buffer.from("immagine dietro un collegamento ".repeat(40));
    const media = path.join(project.directory, "media");
    const outside = path.join(path.dirname(path.dirname(project.directory)), "media-altrove");
    let id: string;
    try { id = store.saveAsset({ bytes, mimeType: "image/png", filename: "foto.png" }).id; }
    finally { store.close(); }
    const refusedEverywhere = async (where: string) => {
      const opened = await projects.openProject(project.id);
      if (!opened) throw new Error(`Il progetto non si apre (${where}).`);
      try {
        await expect(opened.store.readAsset(id), where).rejects.toThrow(MEDIA_FOLDER_NOT_REAL);
        expect(() => opened.store.saveAsset({ bytes: Buffer.from("nuova"), mimeType: "image/png", filename: "nuova.png" }), where).toThrow(MEDIA_FOLDER_NOT_REAL);
        await expect(encodeNativeProjectArchive(opened.project, opened.store, "test"), where).rejects.toThrow(MEDIA_FOLDER_NOT_REAL);
      } finally { opened.store.close(); }
      await expect(projects.copyProjectForComparison(project.id, await catalog()), where).rejects.toThrow(MEDIA_FOLDER_NOT_REAL);
    };
    // A symlink to a folder inside the project. Before: read, served and backed up through it, while uploads refused.
    await rename(media, path.join(project.directory, "media-vera"));
    await symlink(path.join(project.directory, "media-vera"), media);
    await refusedEverywhere("collegamento dentro il progetto");
    // A symlink to a folder on another disk. Before: reads refused with another message («esce dalla cartella del
    // progetto»), and nothing is ever written there.
    await rm(media);
    await rename(path.join(project.directory, "media-vera"), outside);
    await symlink(outside, media);
    const outsideBefore = await readdir(outside, { recursive: true });
    await refusedEverywhere("collegamento fuori dal progetto");
    expect(await readdir(outside, { recursive: true })).toEqual(outsideBefore);
    // A symlink to nothing, or a file. Before: the whole project could not be opened («errore di lettura»).
    await rm(media);
    await symlink(path.join(project.directory, "nessuna-cartella"), media);
    await refusedEverywhere("collegamento a niente");
    await rm(media);
    await writeFile(media, "non una cartella");
    await refusedEverywhere("file");
    // Back as a real folder in the project: everything works again, nothing lost.
    await rm(media);
    await rename(outside, media);
    const opened = await projects.openProject(project.id);
    if (!opened) throw new Error("Il progetto non si apre.");
    try {
      expect(Buffer.from((await opened.store.readAsset(id))!.bytes)).toEqual(bytes);
      opened.store.saveAsset({ bytes: Buffer.from("nuova"), mimeType: "image/png", filename: "nuova.png" });
      await expect(encodeNativeProjectArchive(opened.project, opened.store, "test")).resolves.toBeInstanceOf(Buffer);
    } finally { opened.store.close(); }
  });

  it("un caricamento senza testi di byte già salvati dà la loro riga, anche con un alt, e mai una riga cancellata", async () => {
    const { project, store } = await (await catalog()).createProject("Nessun doppione");
    try {
      const bytes = Buffer.from("immagine con un testo alternativo ".repeat(40));
      // As a prototype import saves it: with its alt.
      const asset = store.saveAsset({ bytes, mimeType: "image/png", filename: "ehi.png", alt: "Ehi, con cornice" });
      await unlink(path.join(project.directory, asset.relativePath));
      await expect(encodeNativeProjectArchive(project, store, "test")).rejects.toMatchObject({ code: "cms-backup-unrestorable" });
      // The repair the backup asks for, as the builder uploads (no alt, no caption). Before: a second row «ehi.png»
      // with no alt, an item the app cannot delete, at every repair.
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "ehi.png" })).toMatchObject({ id: asset.id, alias: asset.alias, alt: "Ehi, con cornice" });
      expect(store.listAssets()).toHaveLength(1);
      await expect(encodeNativeProjectArchive(project, store, "test")).resolves.toBeInstanceOf(Buffer);
      // Texts of their own make a row of their own, as before; an upload without texts still gets the oldest row.
      const other = store.saveAsset({ bytes, mimeType: "image/png", filename: "ehi.png", alt: "Un altro testo" });
      expect(other.id).not.toBe(asset.id);
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "ehi.png", alt: "Un altro testo" }).id).toBe(other.id);
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "copia.png" }).id).toBe(asset.id);
      // A row deleted recoverably is never given back (its image is not served): a new one is made.
      const database = new DatabaseSync(path.join(project.directory, "content.sqlite"));
      for (const row of [asset, other]) database.prepare("INSERT INTO transfer_tombstones(id, entity_kind, deleted_at, entity_json, scope) VALUES (?, 'asset', ?, '{}', 'local')").run(row.id, new Date().toISOString());
      database.close();
      const fresh = store.saveAsset({ bytes, mimeType: "image/png", filename: "ehi.png" });
      expect([asset.id, other.id]).not.toContain(fresh.id);
      expect(store.listAssets().map((item) => item.id)).toEqual([fresh.id]);
      expect(store.saveAsset({ bytes, mimeType: "image/png", filename: "ehi.png", alt: "Un altro testo" }).id).not.toBe(other.id);
    } finally { store.close(); }
  });
});
