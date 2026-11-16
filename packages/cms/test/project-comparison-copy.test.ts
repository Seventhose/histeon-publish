import { createHash } from "node:crypto";
import { readFileSync, truncateSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaticPageProfile } from "../src/page-transfer.js";
import { assertNativeBackupFits, decodeNativeProjectArchive, encodeNativeProjectArchive } from "../src/project-archive.js";
import { CmsBackupUnrestorableError, CmsProjectCatalog, CmsProjectChangedError, type CmsProject, type CmsProjectStore } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";

// link() can be made to fail as on another file system, to test the copy that takes its place, or to let the project
// change right before it; reads of media files are counted, to show what is only measured. The project can change right
// when a backup reads its database snapshot, and the rename of a new project folder can fail for a moment as on Windows.
const links = vi.hoisted(() => ({ refuse: false, calls: 0, before: null as null | ((source: string) => void), mediaReads: 0, beforeSnapshotRead: null as null | (() => void), busyRenames: 0, refusedRenames: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      links.calls += 1;
      links.before?.(String(args[0]));
      if (links.refuse) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return actual.link(...args);
    },
    readFile: ((...args: unknown[]) => {
      if (typeof args[0] === "string" && /[\\/]media[\\/]sha256[\\/]/u.test(args[0])) links.mediaReads += 1;
      if (typeof args[0] === "string" && /[\\/]\.snapshot-[0-9a-f-]{36}\.sqlite$/u.test(args[0])) links.beforeSnapshotRead?.();
      return (actual.readFile as (...input: unknown[]) => Promise<unknown>)(...args);
    }) as typeof actual.readFile,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (links.busyRenames > 0 && /[\\/]\.import-[0-9a-f-]{36}$/u.test(String(args[0]))) {
        links.busyRenames -= 1;
        links.refusedRenames += 1;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM", syscall: "rename" });
      }
      return actual.rename(...args);
    },
  };
});

const example = readFileSync(new URL("./fixtures/prototipo-esempio.html", import.meta.url), "utf8");
const POSIX = process.platform !== "win32";
const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-comparison-copy-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  links.refuse = false;
  links.calls = 0;
  links.before = null;
  links.mediaReads = 0;
  links.beforeSnapshotRead = null;
  links.busyRenames = 0;
  links.refusedRenames = 0;
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A project imported from the example prototype, with its sync bases: the project an update compares against. */
async function importedProject(html = example): Promise<{ catalog: CmsProjectCatalog; id: string; base: string }> {
  const base = await root();
  const built = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(path.join(base, "build")));
  const catalog = new CmsProjectCatalog(path.join(base, "data"));
  await catalog.initialize();
  const id = built.profile.manifest.project.id;
  await catalog.importRemoteStaticPageProfile(built.profile, built.files, id);
  return { catalog, id, base };
}

async function open(catalog: CmsProjectCatalog, id: string): Promise<{ project: CmsProject; store: CmsProjectStore }> {
  const opened = await catalog.openProject(id);
  if (!opened) throw new Error("Progetto mancante.");
  return opened;
}

/** Every media file of a project: bytes digest, inode, link count, mode and modification time (any write in place changes it). */
async function mediaFiles(directory: string): Promise<Map<string, { sha256: string; ino: bigint; nlink: bigint; mode: bigint; mtimeNs: bigint }>> {
  const files = new Map<string, { sha256: string; ino: bigint; nlink: bigint; mode: bigint; mtimeNs: bigint }>();
  const media = path.join(directory, "media", "sha256");
  for (const prefix of await readdir(media)) {
    for (const name of await readdir(path.join(media, prefix))) {
      const file = path.join(media, prefix, name);
      const info = await stat(file, { bigint: true });
      files.set(`${prefix}/${name}`, { sha256: createHash("sha256").update(await readFile(file)).digest("hex"), ino: info.ino, nlink: info.nlink, mode: info.mode & 0o777n, mtimeNs: info.mtimeNs });
    }
  }
  return files;
}

/** What a comparison reads from a project: revision, entities and their revisions, assets, sync bases. */
async function comparable(opened: { project: CmsProject; store: CmsProjectStore }, siteId: string) {
  const profile = (await createStaticPageProfile(opened.project, opened.store)).profile;
  return {
    revision: opened.store.getProjectRevision(),
    entities: profile.entities.map((entity) => `${entity.kind}:${entity.id}:${entity.revisionHash}`).sort(),
    assets: opened.store.listAssets(),
    bases: profile.entities.map((entity) => opened.store.getSyncBase(siteId, entity.id)?.baseHash ?? null),
  };
}

const changedPrototype = (): string => {
  // The image «ehi» takes the bytes of «texture», and the home text changes.
  const texture = /"name": "texture", "data": "(data:image\/png;base64,[^"]+)"/u.exec(example)?.[1];
  if (!texture) throw new Error("Media texture mancante nel prototipo d'esempio.");
  return example.replace(/("name": "ehi", "data": ")data:image\/png;base64,[^"]+"/u, `$1${texture}"`).replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti e viaggi.</p>");
};

describe("copia di un progetto per il confronto (D2)", () => {
  it("dà lo stesso progetto del giro dal backup, e lo stesso esito dell'aggiornamento", async () => {
    const { catalog, id, base } = await importedProject();
    // A local edit, which the update must leave as it is.
    const source = await open(catalog, id);
    const contacts = source.store.listPages().find((page) => page.slug === "contatti");
    if (!contacts) throw new Error("Pagina contatti mancante.");
    const head = source.store.getHead(contacts.id);
    if (!head) throw new Error("Revisione mancante.");
    expect(source.store.saveDocument({ entityId: contacts.id, expectedHead: head.id, content: head.content.replace("Scrivimi.", "Scrivimi in Publish.") }).status).toBe("saved");
    const original = await comparable(source, id);
    const archive = await encodeNativeProjectArchive(source.project, source.store);
    source.store.close();

    const viaBackup = new CmsProjectCatalog(path.join(base, "backup"));
    const restored = await viaBackup.importNativeProjectBackup(await decodeNativeProjectArchive(archive));
    const viaCopy = new CmsProjectCatalog(path.join(base, "copy"));
    const copied = await catalog.copyProjectForComparison(id, viaCopy);
    if (!copied) throw new Error("Copia mancante.");
    try {
      expect(copied.project).toMatchObject({ id, name: restored.project.name, createdAt: restored.project.createdAt, updatedAt: restored.project.updatedAt, schemaVersion: 1 });
      expect(await comparable(copied, id)).toEqual(original);
      expect(await comparable(restored, id)).toEqual(original);
    } finally {
      copied.store.close();
      restored.store.close();
    }

    const changed = await buildPrototypeProfile(parsePrototype(changedPrototype()), new CmsProjectCatalog(path.join(base, "build-changed")));
    const fromBackup = await viaBackup.importRemoteStaticPageProfile(changed.profile, changed.files, id);
    const fromCopy = await viaCopy.importRemoteStaticPageProfile(changed.profile, changed.files, id);
    const outcome = (result: typeof fromCopy) => ({ changed: [...result.changed].sort(), keptLocal: [...result.keptLocal].sort(), unchanged: [...result.unchanged].sort() });
    expect(outcome(fromCopy)).toEqual(outcome(fromBackup));
    // The changed image and the home page; the contact page edited in Publish is not touched.
    expect(changed.profile.entities.some((entity) => entity.kind === "asset" && fromCopy.changed.includes(entity.id))).toBe(true);
    expect(fromCopy.changed).not.toContain(contacts.id);
    // The original project did not see any of it.
    const after = await open(catalog, id);
    try { expect(await comparable(after, id)).toEqual(original); } finally { after.store.close(); }
  });

  it("collega i media senza poterli cambiare: le scritture della copia non toccano i file del progetto", async () => {
    const { catalog, id, base } = await importedProject();
    const source = await open(catalog, id);
    // Same bytes, other alt: two rows and one file.
    const [first] = source.store.listAssets();
    if (!first) throw new Error("Media mancante.");
    const twin = source.store.saveAsset({ bytes: await readFile(path.join(source.project.directory, first.relativePath)), mimeType: first.mimeType, filename: "gemello.png", alt: "Un altro testo" });
    expect(twin.relativePath).toBe(first.relativePath);
    const directory = source.project.directory;
    const assets = source.store.listAssets();
    source.store.close();
    const before = await mediaFiles(directory);
    expect(before.size).toBe(2);

    const copies = new CmsProjectCatalog(path.join(base, "copy"));
    const copy = await catalog.copyProjectForComparison(id, copies);
    if (!copy) throw new Error("Copia mancante.");
    const copied = await mediaFiles(copy.project.directory);
    expect([...copied.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, info] of copied) {
      const original = before.get(file);
      expect(info.sha256).toBe(original?.sha256);
      // A hard link: the same inode, counted twice while the copy exists.
      expect(info.ino).toBe(original?.ino);
      if (POSIX) expect(info.nlink).toBe((original?.nlink ?? 0n) + 1n);
    }
    expect(links.calls).toBe(2);
    if (POSIX) {
      expect((await stat(copy.project.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(copy.project.directory, "content.sqlite"))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(copy.project.directory, "project.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(copies.projectsDirectory)).mode & 0o777).toBe(0o700);
    }
    // Every way the copy can write media: a new row on a linked name (saveAsset keeps the file, which holds its bytes;
    // it would rename a new one over the name otherwise), replaceAsset onto a linked name, and a whole update with a
    // changed image.
    const bytes = await readFile(path.join(copy.project.directory, first.relativePath));
    copy.store.saveAsset({ bytes, mimeType: first.mimeType, filename: "terzo.png", alt: "Terzo testo" });
    copy.store.replaceAsset({ id: twin.id, bytes, mimeType: first.mimeType, filename: "gemello.png", alt: "Ancora un altro", caption: "" });
    copy.store.close();
    const changed = await buildPrototypeProfile(parsePrototype(changedPrototype()), new CmsProjectCatalog(path.join(base, "build-changed")));
    const applied = await copies.importRemoteStaticPageProfile(changed.profile, changed.files, id);
    expect(applied.changed.length).toBeGreaterThan(0);
    for (const [file, info] of before) expect((await mediaFiles(directory)).get(file)?.sha256).toBe(info.sha256);

    await rm(path.join(base, "copy"), { recursive: true, force: true });
    // Same bytes, inode, link count, mode and modification time as before the comparison.
    expect(await mediaFiles(directory)).toEqual(before);
    const reopened = await open(catalog, id);
    try { expect(reopened.store.listAssets()).toEqual(assets); } finally { reopened.store.close(); }
  });

  it("copia i media quando il collegamento fisico non si può fare, con file propri e privati", async () => {
    const { catalog, id, base } = await importedProject();
    const source = await open(catalog, id);
    const directory = source.project.directory;
    const original = await comparable(source, id);
    source.store.close();
    const before = await mediaFiles(directory);
    links.refuse = true;
    const copy = await catalog.copyProjectForComparison(id, new CmsProjectCatalog(path.join(base, "copy")));
    if (!copy) throw new Error("Copia mancante.");
    try {
      const copied = await mediaFiles(copy.project.directory);
      expect(copied.size).toBe(before.size);
      for (const [file, info] of copied) {
        expect(info.sha256).toBe(before.get(file)?.sha256);
        expect(info.ino).not.toBe(before.get(file)?.ino);
        if (POSIX) expect(info.mode).toBe(0o600n);
      }
      // The copies are read like the originals.
      expect(await comparable(copy, id)).toEqual(original);
    } finally { copy.store.close(); }
    expect(await mediaFiles(directory)).toEqual(before);
  });

  it.skipIf(!POSIX)("rifiuta un media che è un collegamento simbolico, o che esce dal progetto, e non lascia nulla", async () => {
    const { catalog, id, base } = await importedProject();
    const source = await open(catalog, id);
    const directory = source.project.directory;
    const [asset] = source.store.listAssets();
    source.store.close();
    if (!asset) throw new Error("Media mancante.");
    const file = path.join(directory, asset.relativePath);
    const outside = path.join(base, "fuori");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, path.basename(file)), await readFile(file), { mode: 0o600 });

    // The file itself is a symlink to a file outside the project.
    await rename(file, `${file}.vero`);
    await symlink(path.join(outside, path.basename(file)), file);
    const copies = new CmsProjectCatalog(path.join(base, "copy"));
    await expect(catalog.copyProjectForComparison(id, copies)).rejects.toThrow(/non è un file regolare/u);
    expect(await readdir(copies.projectsDirectory)).toEqual([]);

    // The file is regular, but its folder is a symlink out of the project.
    await rm(file);
    await rename(`${file}.vero`, file);
    const prefix = path.dirname(file);
    await rename(prefix, `${prefix}.vera`);
    await symlink(outside, prefix);
    await expect(catalog.copyProjectForComparison(id, copies)).rejects.toThrow(/esce dalla cartella del progetto/u);
    expect(await readdir(copies.projectsDirectory)).toEqual([]);
  });

  it("copia un'istantanea coerente: c'è ciò che è confermato, non una scrittura ancora aperta, e non la aspetta", async () => {
    const { catalog, id, base } = await importedProject();
    const source = await open(catalog, id);
    const initial = source.store.getRenderSettings();
    const committed = initial.timeZone === "Asia/Tokyo" ? "America/Lima" : "Asia/Tokyo";
    source.store.setRenderSettings({ ...initial, timeZone: committed });
    const databasePath = path.join(source.project.directory, "content.sqlite");
    source.store.close();
    // Another connection is in the middle of a write transaction, as the app may be.
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec("PRAGMA busy_timeout = 5000");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE project_meta SET value = ? WHERE key = 'render.timeZone'").run("Europe/Lisbon");
      const started = Date.now();
      const during = await catalog.copyProjectForComparison(id, new CmsProjectCatalog(path.join(base, "copy-during")));
      if (!during) throw new Error("Copia mancante.");
      expect(Date.now() - started).toBeLessThan(4000);
      try { expect(during.store.getRenderSettings().timeZone).toBe(committed); } finally { during.store.close(); }
      writer.exec("COMMIT");
    } finally {
      if (writer.isTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
    const after = await catalog.copyProjectForComparison(id, new CmsProjectCatalog(path.join(base, "copy-after")));
    if (!after) throw new Error("Copia mancante.");
    try {
      expect(after.store.getRenderSettings().timeZone).toBe("Europe/Lisbon");
      const current = await open(catalog, id);
      try { expect(after.store.getProjectRevision()).toBe(current.store.getProjectRevision()); } finally { current.store.close(); }
    } finally { after.store.close(); }
  });

  it("non mette mai la copia nel catalogo dei progetti e dà null per un progetto che non c'è", async () => {
    const { catalog, id, base } = await importedProject();
    await expect(catalog.copyProjectForComparison(id, catalog)).rejects.toThrow(/fuori dal catalogo/u);
    await expect(catalog.copyProjectForComparison(id, new CmsProjectCatalog(path.join(catalog.projectsDirectory, "annidato")))).rejects.toThrow(/fuori dal catalogo/u);
    expect((await readdir(catalog.projectsDirectory)).sort()).toEqual([id]);
    expect(await catalog.copyProjectForComparison("9b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", new CmsProjectCatalog(path.join(base, "copy")))).toBeNull();
    const aborted = new AbortController();
    aborted.abort(new Error("fermato"));
    const copies = new CmsProjectCatalog(path.join(base, "copy"));
    await expect(catalog.copyProjectForComparison(id, copies, aborted.signal)).rejects.toThrow("fermato");
    expect(await readdir(copies.projectsDirectory)).toEqual([]);
  });

  it("un media sostituito mentre si copia è un progetto cambiato da ricopiare, non un contenuto non valido", async () => {
    for (const refuse of [false, true]) {
      const { catalog, id, base } = await importedProject();
      const source = await open(catalog, id);
      try {
        const copies = new CmsProjectCatalog(path.join(base, "copy"));
        // Right before the first media is linked (or copied), the app saves its bytes again with another alt. The file
        // holds them, so saveAsset keeps it: the copy goes on (before: a new file renamed over it, and a 409 to repeat).
        links.refuse = refuse;
        links.before = (linked) => {
          links.before = null;
          const asset = source.store.listAssets().find((item) => linked.endsWith(item.sha256));
          if (!asset) throw new Error("Media mancante.");
          source.store.saveAsset({ bytes: readFileSync(linked), mimeType: asset.mimeType, filename: "altro.png", alt: `${asset.alt} (altro)` });
        };
        const kept = await catalog.copyProjectForComparison(id, copies);
        if (!kept) throw new Error("Copia mancante.");
        kept.store.close();
        await rm(path.join(base, "copy"), { recursive: true, force: true });
        // The same, on a file damaged meanwhile: saveAsset repairs it, writing a new file and renaming it over the old
        // one, so the name now points to another inode.
        links.before = (linked) => {
          links.before = null;
          const asset = source.store.listAssets().find((item) => linked.endsWith(item.sha256));
          if (!asset) throw new Error("Media mancante.");
          const bytes = readFileSync(linked);
          truncateSync(linked, 1);
          source.store.saveAsset({ bytes, mimeType: asset.mimeType, filename: "di-nuovo.png", alt: `${asset.alt} (di nuovo)` });
        };
        const error = await catalog.copyProjectForComparison(id, copies).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(CmsProjectChangedError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error).toMatchObject({ code: "cms-project-changed", status: 409, message: "Il file media è cambiato durante la copia del progetto." });
        expect(await readdir(copies.projectsDirectory)).toEqual([]);
        // Nothing was wrong with the project: the same copy, repeated, works.
        const copy = await catalog.copyProjectForComparison(id, copies);
        if (!copy) throw new Error("Copia mancante.");
        try { expect(copy.store.listAssets()).toEqual(source.store.listAssets()); } finally { copy.store.close(); }
      } finally {
        source.store.close();
      }
    }
  });

  it("misura il backup di un aggiornamento esattamente come l'aggiornamento stesso, anche con pagine libere nel database (D2)", async () => {
    const { catalog, id, base } = await importedProject();
    const opened = await open(catalog, id);
    try {
      const { project, store } = opened;
      // Data sources added and removed again, as the app does: the rows go (their revision stays) and the database file
      // keeps their pages as free ones, which a VACUUM INTO copy (the backup's) leaves out.
      const original = store.content.listQuerySources();
      const big = (seed: number) => ({ type: "json", data: [`${"x".repeat(900_000)}${seed}`] });
      store.content.saveQuerySources({ ...original, a: big(1), b: big(2), c: big(3), d: big(4) });
      store.content.saveQuerySources(original);
      const reader = new DatabaseSync(path.join(project.directory, "content.sqlite"), { readOnly: true });
      const pragma = (name: string) => Number((reader.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name]);
      const freeBytes = pragma("freelist_count") * pragma("page_size");
      reader.close();
      expect(freeBytes).toBeGreaterThan(3_000_000);
      // What the update measures before its backup: its own snapshot, made once, exactly (the archive is built from it).
      const updated = await store.withBackupSnapshot(async ({ sizes }) => sizes);
      expect(updated.database).toBe((await store.createDatabaseSnapshot()).byteLength);
      const files = [...new Set(store.listAssets().map((asset) => asset.relativePath))].sort();
      expect(updated.media).toEqual(await Promise.all(files.map(async (file) => ({ path: file, bytes: (await stat(path.join(project.directory, file))).size }))));
      // What the check measures: the copy it already made. The same sizes, so the same answer (before: a bound from the
      // live page count, free pages included, which refused after approval a backup the check had let through).
      const copy = await catalog.copyProjectForComparison(id, new CmsProjectCatalog(path.join(base, "copy")));
      if (!copy) throw new Error("Copia mancante.");
      try { expect(copy.backup).toEqual(updated); } finally { copy.store.close(); }
      // The backup holds exactly what was measured.
      const decoded = await decodeNativeProjectArchive(await encodeNativeProjectArchive(project, store));
      expect(decoded.files.get("content.sqlite")?.byteLength).toBe(updated.database);
      for (const file of updated.media) expect(decoded.files.get(file.path)?.byteLength).toBe(file.bytes);
    } finally {
      opened.store.close();
    }
  });

  it("applica i limiti della lettura del backup alle misure, manifest compreso, e il backup li controlla prima di leggere i media (D2)", async () => {
    const limit = 512 * 1024 * 1024;
    const { catalog, id } = await importedProject();
    const opened = await open(catalog, id);
    try {
      const { project, store } = opened;
      const sha = (index: number) => createHash("sha256").update(`media ${index}`).digest("hex");
      const media = (index: number, bytes: number) => ({ path: `media/sha256/${sha(index).slice(0, 2)}/${sha(index)}`, bytes });
      /** The RangeError's message for these sizes, or null when they fit. */
      const refusal = (sizes: Parameters<typeof assertNativeBackupFits>[1]): string | null => {
        try {
          assertNativeBackupFits(project, sizes);
          return null;
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          return error.message;
        }
      };
      // More files than a backup holds: refused on the count alone.
      expect(refusal({ database: 4096, media: Array.from({ length: 9_999 }, (_, index) => media(index, 1)) })).toBe("Il progetto supera i limiti del backup Histeon.");
      expect(refusal({ database: 4096, media: Array.from({ length: 9_998 }, (_, index) => media(index, 1)) })).toBeNull();
      // The restore counts the manifest (here about 740 bytes) in its 512 MiB: content that fits only without it is
      // refused (before: accepted, and the backup could not be read back).
      expect(refusal({ database: 4096, media: [media(1, limit - 4096 - 64)] })).toBe("Il progetto supera il limite di 512 MiB.");
      // Content and manifest fit, but not with the archive's headers around them (about 500 bytes for three entries).
      expect(refusal({ database: 4096, media: [media(1, limit - 4096 - 1000)] })).toBe("Il backup supera il limite di 512 MiB.");
      // Media are stored, so only the database has a deflate margin: a few KiB of room are enough.
      expect(refusal({ database: 4096, media: [media(1, limit - 4096 - 8192)] })).toBeNull();
      // The backup itself refuses the same way before it reads any media: one file grown past the limit, sparse.
      const [grown] = store.listAssets();
      if (!grown) throw new Error("Media mancante.");
      await truncate(path.join(project.directory, grown.relativePath), limit + 1024 * 1024);
      links.mediaReads = 0;
      const tooBig = await encodeNativeProjectArchive(project, store).then(() => null, (reason: unknown) => reason);
      expect(tooBig).toBeInstanceOf(RangeError);
      expect(tooBig).toMatchObject({ message: "Il progetto supera il limite di 512 MiB." });
      expect(links.mediaReads).toBe(0);
      expect((await readdir(project.directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
    } finally {
      opened.store.close();
    }
  });

  it("rifiuta, come farebbe il ripristino, un progetto il cui backup non si potrebbe ripristinare, e non salva quel backup (D2)", async () => {
    // A media file truncated in place (a crash after an unsynced write, another tool): same name, other bytes.
    {
      const { catalog, id, base } = await importedProject();
      const source = await open(catalog, id);
      const [asset] = source.store.listAssets();
      if (!asset) throw new Error("Media mancante.");
      const file = path.join(source.project.directory, asset.relativePath);
      await truncate(file, Math.floor((await stat(file)).size / 2));
      try {
        const encoded = await encodeNativeProjectArchive(source.project, source.store).then(() => null, (reason: unknown) => reason);
        expect(encoded).toBeInstanceOf(CmsBackupUnrestorableError);
        expect(encoded).toBeInstanceOf(TypeError);
        expect(encoded).toMatchObject({ code: "cms-backup-unrestorable", status: 422, message: expect.stringContaining(`«${asset.filename}» è danneggiato`) });
        expect((await readdir(source.project.directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
      } finally { source.store.close(); }
      // The comparison copy refuses it too, so no update is offered (before: it hard-linked the file unread).
      const copies = new CmsProjectCatalog(path.join(base, "copy"));
      for (const refuse of [false, true]) {
        links.refuse = refuse;
        const copied = await catalog.copyProjectForComparison(id, copies).then(() => null, (reason: unknown) => reason);
        expect(copied).toBeInstanceOf(CmsBackupUnrestorableError);
        expect(await readdir(copies.projectsDirectory)).toEqual([]);
      }
    }
    // A database the restore's own checks refuse (a slug that is not a build path, as no editor writes it).
    {
      const { catalog, id, base } = await importedProject();
      const before = await open(catalog, id);
      before.store.close();
      const database = new DatabaseSync(path.join(before.project.directory, "content.sqlite"));
      try { database.prepare("UPDATE entities SET slug = 'Maiuscole' WHERE kind = 'page' AND slug = 'contatti'").run(); } finally { database.close(); }
      const source = await open(catalog, id);
      try {
        await expect(encodeNativeProjectArchive(source.project, source.store)).rejects.toMatchObject({ code: "cms-backup-unrestorable", message: "Il database del backup contiene un indirizzo non valido." });
      } finally { source.store.close(); }
      const copies = new CmsProjectCatalog(path.join(base, "copy"));
      await expect(catalog.copyProjectForComparison(id, copies)).rejects.toBeInstanceOf(CmsBackupUnrestorableError);
      expect(await readdir(copies.projectsDirectory)).toEqual([]);
    }
  });

  it("un media cancellato fuori dall'app, prima o durante la copia e il backup, è un backup che non si ripristina: 422 senza percorsi, e si ripara (D2)", async () => {
    const { catalog, id, base } = await importedProject();
    const source = await open(catalog, id);
    const copies = new CmsProjectCatalog(path.join(base, "copy"));
    try {
      const [asset] = source.store.listAssets();
      if (!asset) throw new Error("Media mancante.");
      const file = path.join(source.project.directory, asset.relativePath);
      const bytes = await readFile(file);
      const missing = (reason: unknown, when: string): void => {
        // Before: a raw ENOENT («no such file or directory, lstat '<data folder>/…'»), a 500 for the server.
        expect(reason, when).toBeInstanceOf(CmsBackupUnrestorableError);
        expect(reason, when).toMatchObject({ code: "cms-backup-unrestorable", status: 422, message: expect.stringMatching(new RegExp(`^Il media «${asset.filename}» manca: .* Per ripararlo carica di nuovo lo stesso file .* scegliendo «Originale» nel menu della compressione`, "u")) });
        expect((reason as Error).message, when).not.toContain(base);
      };
      unlinkSync(file);
      // The backup (manual, or saved before an update), the measure the app's update check makes, the comparison copy.
      missing(await encodeNativeProjectArchive(source.project, source.store).then(() => null, (reason: unknown) => reason), "backup");
      missing(await source.store.withBackupSnapshot(async ({ sizes }) => sizes).then(() => null, (reason: unknown) => reason), "misura");
      for (const refuse of [false, true]) {
        links.refuse = refuse;
        missing(await catalog.copyProjectForComparison(id, copies).then(() => null, (reason: unknown) => reason), `copia${refuse ? " senza collegamenti" : ""}`);
        expect(await readdir(copies.projectsDirectory)).toEqual([]);
      }
      // Gone while the copy links or copies it (after its checks), or while the backup reads it (after measuring it).
      for (const refuse of [false, true]) {
        source.store.saveAsset({ bytes, mimeType: asset.mimeType, filename: asset.filename, alt: asset.alt, caption: asset.caption });
        links.refuse = refuse;
        links.before = (linked) => {
          if (linked.endsWith(asset.sha256)) unlinkSync(linked);
        };
        missing(await catalog.copyProjectForComparison(id, copies).then(() => null, (reason: unknown) => reason), `copia in corso${refuse ? " senza collegamenti" : ""}`);
        expect(await readdir(copies.projectsDirectory)).toEqual([]);
      }
      links.before = null;
      links.refuse = false;
      source.store.saveAsset({ bytes, mimeType: asset.mimeType, filename: asset.filename, alt: asset.alt, caption: asset.caption });
      links.beforeSnapshotRead = () => unlinkSync(file);
      missing(await encodeNativeProjectArchive(source.project, source.store).then(() => null, (reason: unknown) => reason), "backup in corso");
      links.beforeSnapshotRead = null;
      expect((await readdir(source.project.directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
      // The same file uploaded again repairs it: the backup and the copy go through.
      source.store.saveAsset({ bytes, mimeType: asset.mimeType, filename: "di-nuovo.png" });
      expect((await decodeNativeProjectArchive(await encodeNativeProjectArchive(source.project, source.store))).files.get(asset.relativePath)).toEqual(bytes);
      const copy = await catalog.copyProjectForComparison(id, copies);
      copy?.store.close();
      expect(copy?.backup.media.map((media) => media.path)).toContain(asset.relativePath);
    } finally { source.store.close(); }
  });

  it("fa il backup dei media della sua istantanea, non di quelli salvati nel frattempo, così si ripristina sempre (D2)", async () => {
    const { catalog, id, base } = await importedProject();
    const source = await open(catalog, id);
    try {
      // Right after the database is copied, the app saves a new image: it is not in the copy, so it is not in the backup
      // either (before: the media were listed from the project afterwards, and the restore refused the extra file).
      links.beforeSnapshotRead = () => {
        links.beforeSnapshotRead = null;
        source.store.saveAsset({ bytes: Buffer.from("nuova immagine"), mimeType: "image/png", filename: "nuova.png" });
      };
      const archive = await encodeNativeProjectArchive(source.project, source.store);
      expect(links.beforeSnapshotRead).toBeNull();
      const decoded = await decodeNativeProjectArchive(archive);
      const restored = await new CmsProjectCatalog(path.join(base, "restore")).importNativeProjectBackup(decoded);
      try { expect(restored.store.listAssets().map((asset) => asset.filename)).not.toContain("nuova.png"); } finally { restored.store.close(); }
      expect(source.store.listAssets().map((asset) => asset.filename)).toContain("nuova.png");
    } finally {
      source.store.close();
    }
  });

  it("ritenta la rinomina della cartella nuova che Windows rifiuta per un momento, in copia, ripristino e import (D2)", async () => {
    // The first rename of each new folder fails as on Windows while an antivirus still scans a file inside it.
    links.busyRenames = 1;
    const { catalog, id, base } = await importedProject();
    expect(links.refusedRenames).toBe(1);
    links.busyRenames = 1;
    const copy = await catalog.copyProjectForComparison(id, new CmsProjectCatalog(path.join(base, "copy")));
    if (!copy) throw new Error("Copia mancante.");
    copy.store.close();
    expect(links.refusedRenames).toBe(2);
    const source = await open(catalog, id);
    const archive = await encodeNativeProjectArchive(source.project, source.store);
    source.store.close();
    links.busyRenames = 1;
    const restored = await new CmsProjectCatalog(path.join(base, "restore")).importNativeProjectBackup(await decodeNativeProjectArchive(archive));
    restored.store.close();
    expect(links.refusedRenames).toBe(3);
  });
});
