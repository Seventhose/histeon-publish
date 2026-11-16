import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CmsHostingBackupStore } from "../src/cms-hosting-backups.js";

const deploymentId = "a47c11a9-725c-4e65-95d1-e6d54ed01c12";
const projectId = "d47c11a9-725c-4e65-95d1-e6d54ed01c13";
const siteId = "e47c11a9-725c-4e65-95d1-e6d54ed01c14";
const destinationSha256 = "a".repeat(64);

describe("backup locale dei file hosting CMS", () => {
  let dataDirectory: string;
  let store: CmsHostingBackupStore;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-hosting-backup-"));
    store = new CmsHostingBackupStore(dataDirectory);
  });

  afterEach(async () => { await rm(dataDirectory, { recursive: true, force: true }); });

  it("salva e verifica file sostituiti, file vuoti e percorsi nuovi senza includere segreti", async () => {
    const oldContent = Buffer.from("prima versione");
    const newContent = Buffer.from("pubblicata");
    const emptyContent = Buffer.alloc(0);
    await store.create({
      deploymentId, projectId, destinationSiteId: siteId, destinationSha256,
      entries: [
        { path: "index.html", beforeBytes: oldContent, deployedBytes: newContent },
        { path: "empty.txt", beforeBytes: emptyContent, deployedBytes: Buffer.from("non vuoto") },
        { path: "assets/new.css", beforeBytes: null, deployedBytes: Buffer.from("body{}") },
      ],
    });

    const restored = await store.read({ deploymentId, projectId, destinationSiteId: siteId, destinationSha256 });
    expect(restored).toEqual([
      { path: "index.html", beforeBytes: oldContent, beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), deployedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { path: "empty.txt", beforeBytes: emptyContent, beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), deployedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { path: "assets/new.css", beforeBytes: null, beforeSha256: null, deployedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ]);
    expect(await store.has(deploymentId)).toBe(true);
    const directoryStats = await stat(path.join(dataDirectory, "cms-hosting-backups", deploymentId));
    const blobStats = await stat(path.join(dataDirectory, "cms-hosting-backups", deploymentId, "files", "00001.bin"));
    // POSIX permissions; on Windows the user profile ACL protects the data folder and Node reports 0o666/0o777.
    if (process.platform !== "win32") {
      expect(directoryStats.mode & 0o777).toBe(0o700);
      expect(blobStats.mode & 0o777).toBe(0o600);
    }
    const manifest = await readFile(path.join(dataDirectory, "cms-hosting-backups", deploymentId, "manifest.json"), "utf8");
    expect(manifest).not.toContain("password");
    expect(manifest).not.toContain("privateKey");
  });

  it("lega il ripristino all’identità della destinazione e all’hash della configurazione", async () => {
    await store.create({ deploymentId, projectId, destinationSiteId: siteId, destinationSha256, entries: [{ path: "index.html", beforeBytes: null, deployedBytes: Buffer.from("new") }] });
    await expect(store.read({ deploymentId, projectId, destinationSiteId: siteId, destinationSha256: "b".repeat(64) })).rejects.toMatchObject({ code: "cms-hosting-backup-target-changed" });
    await expect(store.read({ deploymentId, projectId, destinationSiteId: projectId, destinationSha256 })).rejects.toMatchObject({ code: "cms-hosting-backup-target-changed" });
  });

  it("rifiuta un backup manomesso prima di restituire contenuti", async () => {
    await store.create({ deploymentId, projectId, destinationSiteId: siteId, destinationSha256, entries: [{ path: "index.html", beforeBytes: Buffer.from("old"), deployedBytes: Buffer.from("new") }] });
    const blob = path.join(dataDirectory, "cms-hosting-backups", deploymentId, "files", "00000.bin");
    await writeFile(blob, "altered", { mode: 0o600 });
    await expect(store.read({ deploymentId, projectId, destinationSiteId: siteId, destinationSha256 })).rejects.toMatchObject({ code: "cms-hosting-backup-corrupt" });
  });

  it("non accetta ID o percorsi che escano dalla cartella privata", async () => {
    await expect(store.create({
      deploymentId: "../../outside", projectId, destinationSiteId: siteId, destinationSha256,
      entries: [{ path: "index.html", beforeBytes: null, deployedBytes: Buffer.from("new") }],
    })).rejects.toMatchObject({ code: "cms-hosting-backup-invalid" });
    await expect(store.create({
      deploymentId, projectId, destinationSiteId: siteId, destinationSha256,
      entries: [{ path: "../outside", beforeBytes: null, deployedBytes: Buffer.from("new") }],
    })).rejects.toMatchObject({ code: "cms-hosting-backup-invalid" });
  });
});
