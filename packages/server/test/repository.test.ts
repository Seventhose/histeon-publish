import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppRepository } from "../src/repository.js";

describe("archivio SQLite locale", () => {
  it("conserva siti, build, deploy e impostazioni dopo la riapertura", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-repository-"));
    const databasePath = path.join(directory, "state", "histos-publish.sqlite");
    const config = { schemaVersion: 1 as const, name: "Prova", source: { kind: "directory" as const, path: "/tmp/site" } };
    let repository: AppRepository | undefined;
    let reopened: AppRepository | undefined;

    try {
      repository = new AppRepository(databasePath);
      const site = repository.createSite({ id: "site-1", name: "Prova", config });
      repository.addBuild({ id: "build-1", siteId: site.id, status: "ready", createdAt: "2026-10-21T10:00:00.000Z", bundlePath: "/tmp/bundle" });
      repository.addDeploy({ id: "deploy-1", siteId: site.id, buildId: "build-1", status: "deployed", createdAt: "2026-10-21T10:01:00.000Z", versionId: "version-1", workersDevUrl: "https://example.workers.dev", files: 1, uploaded: 1 });
      repository.setSetting("language", "it");
      repository.close();
      repository = undefined;

      reopened = new AppRepository(databasePath);
      expect(reopened.getSite("site-1")).toMatchObject({ name: "Prova", config });
      expect(reopened.getBuild("build-1")).toMatchObject({ status: "ready", bundlePath: "/tmp/bundle" });
      expect(reopened.listDeploys("site-1")).toMatchObject([{ status: "deployed", workersDevUrl: "https://example.workers.dev", files: 1, uploaded: 1 }]);
      expect(reopened.getSetting("language")).toBe("it");
    } finally {
      repository?.close();
      reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("una build annullata o non riuscita non sostituisce l'ultima finita (E13)", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-repository-"));
    const repository = new AppRepository(path.join(directory, "state.sqlite"));
    try {
      const site = repository.createSite({ id: "site-1", name: "Prova", config: { schemaVersion: 1, name: "Prova", source: { kind: "directory", path: "/tmp/site" } } });
      expect(repository.latestFinishedBuild(site.id)).toBeNull();
      repository.addBuild({ id: "ready", siteId: site.id, status: "ready", createdAt: "2026-10-21T10:00:00.000Z", bundlePath: "/tmp/bundle" });
      repository.addBuild({ id: "cancelled", siteId: site.id, status: "cancelled", createdAt: "2026-10-21T11:00:00.000Z" });
      repository.addBuild({ id: "failed", siteId: site.id, status: "failed", createdAt: "2026-10-21T12:00:00.000Z" });
      expect(repository.listBuilds(site.id, 1)[0]?.id).toBe("failed");
      expect(repository.latestFinishedBuild(site.id)?.id).toBe("ready");
      repository.addBuild({ id: "blocked", siteId: site.id, status: "blocked", createdAt: "2026-10-21T13:00:00.000Z" });
      expect(repository.latestFinishedBuild(site.id)?.id).toBe("blocked");
    } finally {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("un ripristino trova la build della versione ripristinata, non l'ultima tentata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-repository-"));
    const repository = new AppRepository(path.join(directory, "state.sqlite"));
    try {
      const site = repository.createSite({ id: "site-1", name: "Prova", config: { schemaVersion: 1, name: "Prova", source: { kind: "directory", path: "/tmp/site" } } });
      repository.addBuild({ id: "old", siteId: site.id, status: "ready", createdAt: "2026-10-21T10:00:00.000Z", bundlePath: "/tmp/old" });
      repository.addDeploy({ id: "deploy-old", siteId: site.id, buildId: "old", status: "deployed", createdAt: "2026-10-21T10:01:00.000Z", versionId: "version-old" });
      repository.addBuild({ id: "new", siteId: site.id, status: "ready", createdAt: "2026-10-21T11:00:00.000Z", bundlePath: "/tmp/new" });
      repository.addDeploy({ id: "deploy-new", siteId: site.id, buildId: "new", status: "deployed", createdAt: "2026-10-21T11:01:00.000Z", versionId: "version-new" });
      repository.addBuild({ id: "failed", siteId: site.id, status: "failed", createdAt: "2026-10-21T12:00:00.000Z" });
      expect(repository.buildForVersion(site.id, "version-old")?.id).toBe("old");
      expect(repository.buildForVersion(site.id, "version-new")?.id).toBe("new");
      expect(repository.buildForVersion(site.id, "version-sconosciuta")).toBeNull();
    } finally {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
