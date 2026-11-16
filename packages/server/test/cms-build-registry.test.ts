import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CmsBuildRegistry } from "../src/cms-build-registry.js";

describe("registro locale dei build e dei deploy CMS", () => {
  let dataDirectory: string | undefined;

  afterEach(async () => {
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  });

  it("rifiuta un secondo job sullo stesso build e conserva errore e interruzione dopo il riavvio", async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-build-registry-"));
    const registry = new CmsBuildRegistry(dataDirectory);
    registry.registerBuild({ projectId: "project-one", buildId: "build-one", bundlePath: path.join(dataDirectory, "project-one", "build-one"), projectRevision: "a".repeat(64), files: 3, pages: 1, assets: 2, totalBytes: 256, findings: [] });
    expect(registry.listBuilds("project-one")).toMatchObject([{ buildId: "build-one", files: 3, pages: 1, assets: 2, totalBytes: 256 }]);
    registry.reserveDeployment({ id: "deploy-one", projectId: "project-one", buildId: "build-one", targetSiteId: "site-one" });
    expect(() => registry.reserveDeployment({ id: "deploy-two", projectId: "project-one", buildId: "build-one", targetSiteId: "site-one" })).toThrowError(expect.objectContaining({ code: "cms-deploy-already-running" }));
    registry.registerBuild({ projectId: "project-two", buildId: "build-two", bundlePath: path.join(dataDirectory, "project-two", "build-two"), projectRevision: "b".repeat(64), files: 1, pages: 1, assets: 0, totalBytes: 128, findings: [] });
    expect(() => registry.reserveDeployment({ id: "deploy-other-project", projectId: "project-two", buildId: "build-two", targetSiteId: "site-one" })).toThrowError(expect.objectContaining({ code: "cms-deploy-already-running" }));
    const observer = new CmsBuildRegistry(dataDirectory);
    expect(observer.listDeployments("project-one", "build-one")).toMatchObject([{ id: "deploy-one", status: "running" }]);
    observer.close();
    registry.finishDeployment("deploy-one", "failed", { error: "mock provider error" });
    expect(registry.listDeployments("project-one", "build-one")).toMatchObject([{ id: "deploy-one", status: "failed", error: "mock provider error" }]);
    registry.reserveDeployment({ id: "deploy-two", projectId: "project-one", buildId: "build-one", targetSiteId: "site-one" });
    registry.close();
    const database = new DatabaseSync(path.join(dataDirectory, "histos-cms-builds.sqlite"));
    database.prepare("UPDATE cms_deployments SET owner_pid = ? WHERE id = ?").run(2_000_000_000, "deploy-two");
    database.close();

    const reopened = new CmsBuildRegistry(dataDirectory);
    expect(reopened.listDeployments("project-one", "build-one")).toMatchObject([
      { id: "deploy-two", status: "interrupted", error: expect.stringContaining("risultato sul provider è incerto") },
      { id: "deploy-one", status: "failed", error: "mock provider error" },
    ]);
    reopened.close();
  });

  it("aggiunge i riepiloghi build a un registro già esistente senza alterare i record precedenti", async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-build-registry-migrate-"));
    const database = new DatabaseSync(path.join(dataDirectory, "histos-cms-builds.sqlite"));
    database.exec(`CREATE TABLE cms_builds (build_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, bundle_path TEXT NOT NULL, project_revision TEXT NOT NULL DEFAULT '', findings_json TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO cms_builds VALUES ('legacy-build', 'project-one', '/private/bundle', 'rev', '[]', '2026-10-25T00:00:00.000Z');`);
    database.close();
    const migrated = new CmsBuildRegistry(dataDirectory);
    expect(migrated.listBuilds("project-one")).toMatchObject([{ buildId: "legacy-build", files: 0, pages: 0, assets: 0, totalBytes: 0 }]);
    migrated.close();
  });
});
