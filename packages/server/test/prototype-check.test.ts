import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, unlink } from "node:fs/promises";
import { readFileSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrototypeProfile, CmsProjectCatalog, decodeNativeProjectArchive, parsePrototype } from "@histos-publish/cms";
import { updateBackupArchive } from "../src/cms-api.js";
import { requestErrorCode, requestErrorStatus, safeErrorMessage } from "../src/http.js";
import { checkPrototype } from "../src/prototype-check.js";

// The project can change right before a media file is linked into the comparison copy, chosen media files can be
// measured at another size (lstat only, as the backup's sizes are measured): the bytes read stay the real ones, and the
// rename that installs the comparison copy can fail as on Windows while an antivirus holds a file inside it.
const fsHooks = vi.hoisted(() => ({ beforeLink: null as null | ((source: string) => void), sizes: new Map<string, number>(), busyRenames: 0, refusedRenames: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      fsHooks.beforeLink?.(String(args[0]));
      return actual.link(...args);
    },
    lstat: (async (...args: unknown[]) => {
      const info = await (actual.lstat as (...input: unknown[]) => Promise<{ size: number | bigint }>)(...args);
      const name = /[0-9a-f]{64}$/u.exec(String(args[0]))?.[0];
      const size = name === undefined ? undefined : fsHooks.sizes.get(name);
      if (size !== undefined) info.size = typeof info.size === "bigint" ? BigInt(size) : size;
      return info;
    }) as typeof actual.lstat,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsHooks.busyRenames > 0 && /[\\/]changes[\\/]histos-projects[\\/]\.import-[0-9a-f-]{36}$/u.test(String(args[0]))) {
        fsHooks.busyRenames -= 1;
        fsHooks.refusedRenames += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(args[0])}' -> '${String(args[1])}'`), { code: "EPERM", syscall: "rename" });
      }
      return actual.rename(...args);
    },
  };
});

// Media files flushed to disk (fsyncSync), counted; nothing else changes.
const syncs = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: ((fd: number) => {
      syncs.count += 1;
      actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
  };
});

/** A small valid PNG of its own bytes for each `seed`. */
function png(seed: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((8 * 3 + 1) * 8, seed & 0xff);
  for (let row = 0; row < 8; row++) rows[row * 25] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const example = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url), "utf8");
const roots: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-check-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  fsHooks.beforeLink = null;
  fsHooks.sizes.clear();
  fsHooks.busyRenames = 0;
  fsHooks.refusedRenames = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The example imported as a project with its sync bases: a later check of the same prototype is an update. */
async function importedExample(root: string): Promise<{ catalog: CmsProjectCatalog; id: string; directory: string }> {
  const built = await buildPrototypeProfile(parsePrototype(example), new CmsProjectCatalog(path.join(root, "build")));
  const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
  await catalog.initialize();
  const id = built.profile.manifest.project.id;
  const imported = await catalog.importRemoteStaticPageProfile(built.profile, built.files, id);
  return { catalog, id, directory: imported.project.directory };
}

/** Bytes, inode, links, mode and modification time of every media file of a project. */
async function mediaFiles(directory: string): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  const media = path.join(directory, "media", "sha256");
  for (const prefix of await readdir(media)) {
    for (const name of await readdir(path.join(media, prefix))) {
      const file = path.join(media, prefix, name);
      const info = await stat(file, { bigint: true });
      files[`${prefix}/${name}`] = { sha256: createHash("sha256").update(await readFile(file)).digest("hex"), ino: info.ino, nlink: info.nlink, mode: info.mode, mtimeNs: info.mtimeNs };
    }
  }
  return files;
}

/** The example's "texture" image, and the example with its media "ehi" given by URL (downloaded as that image). */
const texture = new Uint8Array(Buffer.from(/"name": "texture", "data": "data:image\/png;base64,([^"]+)"/u.exec(example)?.[1] ?? "", "base64"));
const remote = example.replace(/"data": "data:image\/png;base64,[^"]+"(, "alt": "Ehi, con cornice")/u, '"url": "https://example.com/ehi.png"$1');

const leftovers = async (root: string): Promise<string[]> => (await readdir(root)).filter((name) => name.startsWith(".prototype-check-"));

describe("controllo dei prototipi", () => {
  it("rifiuta l'import se un progetto con lo stesso id non viene dal prototipo", async () => {
    const root = await scratch();
    const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
    await catalog.initialize();
    const created = await catalog.createProject("Altro", { id: "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10" });
    created.store.close();
    const result = await checkPrototype(example, { scratchRoot: root, catalog });
    expect(result).toMatchObject({ valid: false, outcome: "refused-duplicate" });
    expect((await readdir(root)).filter((name) => name.startsWith(".prototype-check-"))).toEqual([]);
  });

  it("non lascia cartelle temporanee quando il prototipo è sbagliato", async () => {
    const root = await scratch();
    await expect(checkPrototype(example.replace("<p>Scrivimi.</p>", '<p onclick="alert(1)">Scrivimi.</p>'), { scratchRoot: root })).rejects.toMatchObject({ code: "cms-prototype-invalid" });
    expect((await readdir(root)).filter((name) => name.startsWith(".prototype-check-"))).toEqual([]);
  });

  it("con strict dà il controllo severo, con gli avvisi del rapporto fra i problemi; senza strict il risultato resta com'era (F1)", async () => {
    const root = await scratch();
    const plain = await checkPrototype(example, { scratchRoot: root });
    expect(Object.keys(plain)).not.toContain("strict");
    const strict = await checkPrototype(example, { scratchRoot: root, strict: true });
    const { strict: verdict, ...rest } = strict;
    expect(rest).toEqual(plain);
    // The example's queries have no {:else}, and its headings skip a level: two of the rules, both errors.
    expect(verdict?.passed).toBe(false);
    expect(verdict?.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "loop-senza-else", level: "errore", document: "page home", line: expect.any(Number) }),
      expect.objectContaining({ rule: "avviso-del-controllo", level: "errore", message: expect.stringContaining("i titoli saltano un livello") }),
    ]));
    expect(await leftovers(root)).toEqual([]);
  });

  it("dà le differenze di un aggiornamento da una copia su disco, senza toccare il progetto né i suoi media (D2)", async () => {
    const root = await scratch();
    const { catalog, id, directory } = await importedExample(root);
    const before = await mediaFiles(directory);
    const opened = await catalog.openProject(id);
    const revision = opened?.store.getProjectRevision();
    opened?.store.close();
    // The image «ehi» takes the bytes of «texture», and the home text changes.
    const texture = /"name": "texture", "data": "(data:image\/png;base64,[^"]+)"/u.exec(example)?.[1] ?? "";
    const changed = example.replace(/("name": "ehi", "data": ")data:image\/png;base64,[^"]+"/u, `$1${texture}"`).replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti e viaggi.</p>");
    const result = await checkPrototype(changed, { scratchRoot: root, catalog });
    expect(result).toMatchObject({ valid: true, outcome: "update", changes: { added: [], removed: [], keptLocal: [], conflicts: [], omitted: 0, basis: { projectRevision: revision } } });
    expect(result.changes?.modified).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "page", label: "Home" }), expect.objectContaining({ kind: "asset" })]));
    expect(result.changes?.modified).toHaveLength(2);
    expect(result.changes?.unchanged).toBeGreaterThan(5);
    // The same file again changes nothing: the dry run wrote nothing in the project.
    expect((await checkPrototype(example, { scratchRoot: root, catalog })).changes).toMatchObject({ added: [], modified: [], removed: [], basis: { projectRevision: revision } });
    expect(await mediaFiles(directory)).toEqual(before);
    expect(await leftovers(root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rifiuta il confronto se un media del progetto è un collegamento simbolico", async () => {
    const root = await scratch();
    const { catalog, id, directory } = await importedExample(root);
    const opened = await catalog.openProject(id);
    const [asset] = opened?.store.listAssets() ?? [];
    opened?.store.close();
    if (!asset) throw new Error("Media mancante.");
    const file = path.join(directory, asset.relativePath);
    await rename(file, path.join(root, "fuori"));
    await symlink(path.join(root, "fuori"), file);
    await expect(checkPrototype(example, { scratchRoot: root, catalog })).rejects.toMatchObject({ code: "cms-transfer-invalid", message: expect.stringMatching(/non è un file regolare/u) });
    expect(await leftovers(root)).toEqual([]);
  });
  it("un media sostituito durante il confronto chiede di ripetere il controllo (409), non dice che il progetto non è valido", async () => {
    const root = await scratch();
    const { catalog, id } = await importedExample(root);
    const source = await catalog.openProject(id);
    if (!source) throw new Error("Progetto mancante.");
    try {
      // While the copy runs, the app saves an image again with the same bytes and another alt. Its file holds them, so
      // it is kept and the check goes on (before: a new file renamed over it, and a 409 for nothing).
      fsHooks.beforeLink = (linked) => {
        fsHooks.beforeLink = null;
        const asset = source.store.listAssets().find((item) => linked.endsWith(item.sha256));
        if (!asset) throw new Error("Media mancante.");
        source.store.saveAsset({ bytes: readFileSync(linked), mimeType: asset.mimeType, filename: "altro.png", alt: `${asset.alt} (altro)` });
      };
      expect(await checkPrototype(example, { scratchRoot: root, catalog })).toMatchObject({ outcome: "update", changes: { conflicts: [] } });
      // The same on a file damaged meanwhile: saveAsset repairs it, a new file renamed over the old one, so the link
      // lands on another inode than the one checked.
      fsHooks.beforeLink = (linked) => {
        fsHooks.beforeLink = null;
        const asset = source.store.listAssets().find((item) => linked.endsWith(item.sha256));
        if (!asset) throw new Error("Media mancante.");
        const bytes = readFileSync(linked);
        truncateSync(linked, 1);
        source.store.saveAsset({ bytes, mimeType: asset.mimeType, filename: "di-nuovo.png", alt: `${asset.alt} (di nuovo)` });
      };
      const error = await checkPrototype(example, { scratchRoot: root, catalog }).then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ code: "cms-project-changed", exitCode: 409, message: "Il progetto è cambiato durante il confronto: ripeti il controllo." });
      expect(await leftovers(root)).toEqual([]);
      // Repeated, the check gives the changes.
      expect(await checkPrototype(example, { scratchRoot: root, catalog })).toMatchObject({ outcome: "update", changes: { conflicts: [] } });
    } finally {
      source.store.close();
    }
  });

  it("dà le differenze anche se il backup prima dell'aggiornamento non starebbe nei limiti, e dice perché l'aggiornamento non si può fare (D2)", async () => {
    const root = await scratch();
    const { catalog, id } = await importedExample(root);
    const opened = await catalog.openProject(id);
    const [asset] = opened?.store.listAssets() ?? [];
    opened?.store.close();
    if (!asset) throw new Error("Media mancante.");
    fsHooks.sizes.set(asset.sha256, 513 * 1024 * 1024);
    const result = await checkPrototype(example, { scratchRoot: root, catalog });
    expect(result).toMatchObject({ valid: true, outcome: "update", changes: { added: [], modified: [], removed: [], conflicts: [] }, backupUnavailable: "Il progetto supera il limite di 512 MiB." });
    expect(await leftovers(root)).toEqual([]);
    fsHooks.sizes.clear();
    expect(await checkPrototype(example, { scratchRoot: root, catalog })).not.toHaveProperty("backupUnavailable");
  });
  it("il controllo e l'aggiornamento misurano lo stesso backup: se il controllo dice che sta nei limiti, l'aggiornamento lo salva (D2)", async () => {
    const root = await scratch();
    const { catalog, id, directory } = await importedExample(root);
    const limit = 512 * 1024 * 1024;
    const opened = await catalog.openProject(id);
    if (!opened) throw new Error("Progetto mancante.");
    // Ordinary use: four data sources of about 0.9 MB added and removed again leave megabytes of free pages in the
    // database file, which the backup's VACUUM INTO copy leaves out.
    const original = opened.store.content.listQuerySources();
    const big = (seed: number) => ({ type: "json", data: [`${"x".repeat(900_000)}${seed}`] });
    opened.store.content.saveQuerySources({ ...original, a: big(1), b: big(2), c: big(3), d: big(4) });
    opened.store.content.saveQuerySources(original);
    const database = (await opened.store.createDatabaseSnapshot()).byteLength;
    const files = [...new Map(opened.store.listAssets().map((asset) => [asset.relativePath, asset.sha256])).entries()];
    opened.store.close();
    const [[, grown] = ["", ""], ...others] = files;
    let rest = database;
    for (const [file] of others) rest += (await stat(path.join(directory, file))).size;
    // One media file measured so that the backup fits with 256 KiB to spare: less than the free pages, which the update's
    // own measure counted (before: the check let it through and the approved update refused it, 413).
    fsHooks.sizes.set(grown, limit - rest - 256 * 1024);
    const fits = await checkPrototype(example, { scratchRoot: root, catalog });
    expect(fits).toMatchObject({ valid: true, outcome: "update", changes: { conflicts: [] } });
    expect(fits).not.toHaveProperty("backupUnavailable");
    const live = await catalog.openProject(id);
    if (!live) throw new Error("Progetto mancante.");
    try {
      const archive = await updateBackupArchive(live);
      expect((await decodeNativeProjectArchive(archive)).files.get("content.sqlite")?.byteLength).toBe(database);
      // 512 KiB more and both refuse, with the same reason.
      fsHooks.sizes.set(grown, limit - rest + 256 * 1024);
      const over = await checkPrototype(example, { scratchRoot: root, catalog });
      expect(over.backupUnavailable).toBe("Il progetto supera il limite di 512 MiB.");
      await expect(updateBackupArchive(live)).rejects.toMatchObject({ code: "cms-backup-too-large", exitCode: 413, message: expect.stringMatching(/^Il progetto supera il limite di 512 MiB\. /u) });
    } finally {
      live.store.close();
    }
    expect(await leftovers(root)).toEqual([]);
  });

  it("un media danneggiato nel progetto ferma il controllo e l'aggiornamento: nessun backup che non si potrebbe ripristinare (D2)", async () => {
    const root = await scratch();
    const { catalog, id, directory } = await importedExample(root);
    const opened = await catalog.openProject(id);
    const [asset] = opened?.store.listAssets() ?? [];
    opened?.store.close();
    if (!asset) throw new Error("Media mancante.");
    // Truncated in place, as after a crash or another program: the name stays, the bytes do not.
    const file = path.join(directory, asset.relativePath);
    await truncate(file, Math.floor((await stat(file)).size / 2));
    // Before: an update with no backupUnavailable, and an approved update that saved a backup the restore refuses.
    const refused = await checkPrototype(example, { scratchRoot: root, catalog }).then(() => null, (reason: unknown) => reason);
    expect(refused).toMatchObject({ code: "cms-backup-unrestorable", exitCode: 422, message: expect.stringMatching(/^Il media «[^»]+» è danneggiato: .*non si potrebbe ripristinare: l'aggiornamento non si può fare\.$/u) });
    expect(requestErrorStatus(refused)).toBe(422);
    expect(await leftovers(root)).toEqual([]);
    const live = await catalog.openProject(id);
    if (!live) throw new Error("Progetto mancante.");
    try {
      await expect(updateBackupArchive(live)).rejects.toMatchObject({ code: "cms-backup-unrestorable", exitCode: 422, message: expect.stringMatching(/l'aggiornamento non è partito\.$/u) });
    } finally {
      live.store.close();
    }
    expect((await readdir(directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  it("un aggiornamento da confrontare con i media scaricati non fa il confronto né l'anteprima coi segnaposto: li fa una volta il controllo con i media (8)", async () => {
    const root = await scratch();
    // The project made from the prototype whose media «ehi» is remote, downloaded at import.
    const fetchAsset = vi.fn(async () => texture);
    const built = await buildPrototypeProfile(parsePrototype(remote), new CmsProjectCatalog(path.join(root, "build")), { fetchAsset });
    const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
    await catalog.initialize();
    await catalog.importRemoteStaticPageProfile(built.profile, built.files, built.profile.manifest.project.id);
    fetchAsset.mockClear();
    const compared = vi.spyOn(CmsProjectCatalog.prototype, "copyProjectForComparison");
    const preview = vi.fn(async () => ({ status: "unavailable" as const, reason: "prova" }));
    try {
      // As the app's route asks: an update with placeholders answers at once. Before, the dry run on a copy of the
      // project and the preview build ran here too, only to be thrown away by the route.
      const deferred = await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, preview, fetchAsset });
      expect(deferred).toMatchObject({ check: true, valid: true, outcome: "update", changesNeedDownload: true, report: { placeholders: ["ehi"] } });
      expect(deferred).not.toHaveProperty("changes");
      expect(deferred).not.toHaveProperty("preview");
      expect(compared).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(await leftovers(root)).toEqual([]);
      // The check again with the media: the comparison, the preview and the download, once each.
      const downloaded = await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, download: true, preview, fetchAsset });
      expect(downloaded).toMatchObject({ outcome: "update", changes: { added: [], modified: [], removed: [], conflicts: [] }, preview: { status: "unavailable" } });
      expect(downloaded).not.toHaveProperty("changesNeedDownload");
      expect(compared).toHaveBeenCalledTimes(1);
      expect(preview).toHaveBeenCalledTimes(1);
      expect(fetchAsset).toHaveBeenCalledTimes(1);
      // Without the option (the agent's check) nothing changes: the comparison is made with the placeholders.
      expect(await checkPrototype(remote, { scratchRoot: root, catalog })).toMatchObject({ outcome: "update", changes: expect.any(Object) });
      expect(compared).toHaveBeenCalledTimes(2);
    } finally {
      compared.mockRestore();
    }
    expect(await leftovers(root)).toEqual([]);
  });

  it("un media cancellato fuori dall'app ferma controllo e aggiornamento con 422 senza percorsi, e caricarlo di nuovo lo ripara (D2)", async () => {
    const root = await scratch();
    const { catalog, id, directory } = await importedExample(root);
    const opened = await catalog.openProject(id);
    const [asset] = opened?.store.listAssets() ?? [];
    opened?.store.close();
    if (!asset) throw new Error("Media mancante.");
    const file = path.join(directory, asset.relativePath);
    const bytes = await readFile(file);
    await unlink(file);
    // Before: 500 «error», «ENOENT: no such file or directory, lstat '<data folder>/…/media/sha256/…'», for both.
    const refused = await checkPrototype(example, { scratchRoot: root, catalog }).then(() => null, (reason: unknown) => reason);
    expect(refused).toMatchObject({ code: "cms-backup-unrestorable", exitCode: 422, message: expect.stringMatching(/^Il media «[^»]+» manca: .*Per ripararlo carica di nuovo lo stesso file .* scegliendo «Originale» nel menu della compressione: .*non si potrebbe ripristinare: l'aggiornamento non si può fare\.$/u) });
    expect(requestErrorStatus(refused)).toBe(422);
    expect(requestErrorCode(refused)).toBe("cms-backup-unrestorable");
    expect(safeErrorMessage(refused)).not.toContain(root);
    expect(safeErrorMessage(refused)).not.toMatch(/ENOENT|sha256/u);
    expect(await leftovers(root)).toEqual([]);
    const live = await catalog.openProject(id);
    if (!live) throw new Error("Progetto mancante.");
    try {
      const update = await updateBackupArchive(live).then(() => null, (reason: unknown) => reason);
      expect(update).toMatchObject({ code: "cms-backup-unrestorable", exitCode: 422, message: expect.stringMatching(/^Il media «[^»]+» manca: .*l'aggiornamento non è partito\.$/u) });
      expect(requestErrorStatus(update)).toBe(422);
      expect(safeErrorMessage(update)).not.toContain(root);
      // As the message says: the same file uploaded again from the builder (no alt, no caption) puts it back.
      live.store.saveAsset({ bytes, mimeType: asset.mimeType, filename: asset.filename });
      expect((await decodeNativeProjectArchive(await updateBackupArchive(live))).files.get(asset.relativePath)).toEqual(bytes);
    } finally {
      live.store.close();
    }
    expect(await checkPrototype(example, { scratchRoot: root, catalog })).toMatchObject({ outcome: "update", changes: { conflicts: [] } });
    expect((await readdir(directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  it("ritenta la rinomina della copia che Windows rifiuta per un momento; se resta bloccata risponde 409 senza percorsi (D2)", async () => {
    const root = await scratch();
    const { catalog } = await importedExample(root);
    // Once, as while an antivirus scans the database just written into the copy: retried, the check goes through.
    fsHooks.busyRenames = 1;
    expect(await checkPrototype(example, { scratchRoot: root, catalog })).toMatchObject({ outcome: "update", changes: { conflicts: [] } });
    expect(fsHooks.refusedRenames).toBe(1);
    // Always: a retryable 409 that names no local path, never a 500 with the data folder in it.
    fsHooks.busyRenames = 1_000;
    const busy = await checkPrototype(example, { scratchRoot: root, catalog }).then(() => null, (reason: unknown) => reason);
    expect(busy).toMatchObject({ code: "cms-project-busy", exitCode: 409 });
    expect(requestErrorStatus(busy)).toBe(409);
    expect(safeErrorMessage(busy)).not.toContain(root);
    expect(await leftovers(root)).toEqual([]);
  });

  it("le copie usa-e-getta del controllo non portano su disco i loro media; il catalogo dell'utente sì", async () => {
    const root = await scratch();
    syncs.count = 0;
    const { catalog, directory } = await importedExample(root);
    expect(syncs.count).toBeGreaterThan(0);
    const before = await mediaFiles(directory);
    // A new image for «ehi»: the build, the verification and the comparison copy each write it.
    const changed = example.replace(/("name": "ehi", "data": ")data:image\/png;base64,[^"]+"/u, `$1data:image/png;base64,${png(3).toString("base64")}"`);
    syncs.count = 0;
    const result = await checkPrototype(changed, { scratchRoot: root, catalog });
    expect(result.changes?.modified).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "asset" })]));
    // Before: every media file of the three scratch catalogs was flushed to disk, synchronously, then thrown away.
    expect(syncs.count).toBe(0);
    expect(await mediaFiles(directory)).toEqual(before);
    expect(await leftovers(root)).toEqual([]);
  });
});

describe("aggiornamento da confrontare con i media scaricati: prima i controlli del progetto (8)", () => {
  /** The project made from the prototype whose media «ehi» is remote (downloaded at import), and its media file. */
  async function importedRemote(root: string) {
    const fetchAsset = vi.fn(async () => texture);
    const built = await buildPrototypeProfile(parsePrototype(remote), new CmsProjectCatalog(path.join(root, "build")), { fetchAsset });
    const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
    await catalog.initialize();
    const imported = await catalog.importRemoteStaticPageProfile(built.profile, built.files, built.profile.manifest.project.id);
    const opened = await catalog.openProject(built.profile.manifest.project.id);
    const [asset] = opened?.store.listAssets() ?? [];
    opened?.store.close();
    if (!asset) throw new Error("Media mancante.");
    fetchAsset.mockClear();
    return { catalog, directory: imported.project.directory, media: path.join(imported.project.directory, asset.relativePath), fetchAsset };
  }

  it("un media danneggiato o mancante ferma il primo controllo con 422, prima di scaricare qualcosa", async () => {
    for (const damage of ["troncato", "cancellato"] as const) {
      const root = await scratch();
      const { catalog, directory, media, fetchAsset } = await importedRemote(root);
      if (damage === "troncato") await truncate(media, Math.floor((await stat(media)).size / 2));
      else await unlink(media);
      const compared = vi.spyOn(CmsProjectCatalog.prototype, "copyProjectForComparison");
      const preview = vi.fn(async () => ({ status: "unavailable" as const, reason: "prova" }));
      try {
        // Before: the first check answered changesNeedDownload, the app downloaded every remote media for the second
        // one, and only that refused (422). Now the first one refuses, with nothing downloaded, copied or built.
        const refused = await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, preview, fetchAsset }).then(() => null, (reason: unknown) => reason);
        expect(refused, damage).toMatchObject({ code: "cms-backup-unrestorable", exitCode: 422, message: expect.stringMatching(/^Il media «[^»]+» (?:è danneggiato|manca): .*Per ripararlo carica di nuovo lo stesso file.*non si potrebbe ripristinare: l'aggiornamento non si può fare\.$/u) });
        expect(requestErrorStatus(refused)).toBe(422);
        expect(safeErrorMessage(refused)).not.toContain(root);
        expect(fetchAsset).not.toHaveBeenCalled();
        expect(compared).not.toHaveBeenCalled();
        expect(preview).not.toHaveBeenCalled();
        // The check with the downloads refuses the same way: the first one says nothing the second would not.
        await expect(checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, download: true, fetchAsset })).rejects.toMatchObject({ code: "cms-backup-unrestorable", exitCode: 422 });
      } finally {
        compared.mockRestore();
      }
      expect(await leftovers(root)).toEqual([]);
      expect((await readdir(directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("un media che non si legge ferma il primo controllo con 409 da ripetere, prima di scaricare qualcosa", async () => {
    const root = await scratch();
    const { catalog, directory, media, fetchAsset } = await importedRemote(root);
    const { chmod } = await import("node:fs/promises");
    // As while another program holds it, or with its permissions changed outside the app.
    await chmod(media, 0o000);
    try {
      const busy = await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, fetchAsset }).then(() => null, (reason: unknown) => reason);
      expect(busy).toMatchObject({ code: "cms-project-busy", exitCode: 409 });
      expect(requestErrorStatus(busy)).toBe(409);
      expect(safeErrorMessage(busy)).not.toContain(root);
      expect(fetchAsset).not.toHaveBeenCalled();
    } finally {
      await chmod(media, 0o600);
    }
    // Readable again, the first check asks for the downloads.
    expect(await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, fetchAsset })).toMatchObject({ outcome: "update", changesNeedDownload: true });
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(await leftovers(root)).toEqual([]);
    expect((await readdir(directory)).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  it("un backup che non starebbe nei limiti si dice al primo controllo, senza scaricare i media per un aggiornamento che non si può fare", async () => {
    const root = await scratch();
    const { catalog, media, fetchAsset } = await importedRemote(root);
    fsHooks.sizes.set(path.basename(media), 513 * 1024 * 1024);
    const compared = vi.spyOn(CmsProjectCatalog.prototype, "copyProjectForComparison");
    const preview = vi.fn(async () => ({ status: "unavailable" as const, reason: "prova" }));
    try {
      const result = await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, preview, fetchAsset });
      // The reason the app shows (cms.importUpdateNoBackup), with no «Aggiorna»: no second check, nothing downloaded.
      expect(result).toMatchObject({ check: true, valid: true, outcome: "update", backupUnavailable: "Il progetto supera il limite di 512 MiB.", report: { placeholders: ["ehi"] } });
      expect(result).not.toHaveProperty("changesNeedDownload");
      expect(result).not.toHaveProperty("changes");
      expect(result).not.toHaveProperty("preview");
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(compared).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
      // The check with the downloads gives the same reason.
      expect((await checkPrototype(remote, { scratchRoot: root, catalog, askDownloadForUpdate: true, download: true, fetchAsset })).backupUnavailable).toBe("Il progetto supera il limite di 512 MiB.");
    } finally {
      compared.mockRestore();
    }
    expect(await leftovers(root)).toEqual([]);
  });
});
