import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog, decodeStaticPageArchive } from "@histos-publish/cms";
import { exportXbsiteArchive, importProfile, importPrototypeHtml, type CmsOperationsContext } from "../src/cms-api.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

/**
 * The CMS operations the routes and the AI connector share (cms-api.ts): the connector calls them directly, so they
 * must give the same bytes and the same answers as the routes, and the update of a project created from a file must
 * stay an explicit choice.
 */

const FIXTURE = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url));
const FIXTURE_PROJECT_ID = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";

describe("operazioni CMS condivise", () => {
  let server: LocalServerHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let otherDirectory: string;
  let base: string;

  function headers(contentType = "application/json"): Record<string, string> {
    if (!server) throw new Error("Server di test non avviato.");
    return { "X-Histos-Token": server.token, Origin: base, "Content-Type": contentType };
  }

  async function importFixtureByRoute(): Promise<string> {
    const response = await fetch(`${base}/api/cms/v1/projects/import-prototype`, { method: "POST", headers: headers("text/html; charset=utf-8"), body: FIXTURE });
    const body = await response.json() as { project: { id: string } };
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body.project.id;
  }

  async function exportByRoute(projectId: string): Promise<Buffer> {
    const response = await fetch(`${base}/api/cms/v1/projects/${projectId}/export`, { method: "POST", headers: headers() });
    expect(response.status).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  }

  async function revision(projectId: string): Promise<string> {
    const response = await fetch(`${base}/api/cms/v1/projects/${projectId}/bootstrap`, { headers: headers() });
    return (await response.json() as { revision: string }).revision;
  }

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-operations-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-operations-ui-"));
    otherDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-operations-other-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, connector: { appVersion: "0.1.15", minFreeBytes: 0 } });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    if (process.platform === "linux") {
      const open: string[] = [];
      for (const fd of await readdir("/proc/self/fd").catch(() => [] as string[])) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
        if (target.startsWith(dataDirectory) || target.startsWith(otherDirectory)) open.push(target);
      }
      expect(open, "files left open after the test").toEqual([]);
    }
    await Promise.all([dataDirectory, uiDirectory, otherDirectory].map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  });

  /**
   * Every export carries a fresh snapshot id in site.json (manifest.selection.snapshot, hence manifestHash): two
   * exports of the same project differ only there. Everything else must be byte for byte the same.
   */
  async function comparable(archive: Buffer): Promise<{ manifest: unknown; files: Array<[string, string]> }> {
    const decoded = await decodeStaticPageArchive(archive);
    const { manifestHash: _hash, selection, ...manifest } = decoded.profile.manifest;
    expect(selection).toMatchObject({ kind: "workspace-head", snapshot: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    const files = [...decoded.files].filter(([name]) => name !== "site.json").map(([name, bytes]): [string, string] => [name, bytes.toString("base64")]).sort(([left], [right]) => left.localeCompare(right));
    return { manifest, files };
  }

  it("exportXbsiteArchive dà lo stesso pacchetto della rotta di export", async () => {
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Creato nell'app" }) });
    expect(created.status).toBe(201);
    const fromApp = (await created.json() as { project: { id: string } }).project.id;
    const fromFile = await importFixtureByRoute();
    const catalog = new CmsProjectCatalog(dataDirectory);
    for (const projectId of [fromApp, fromFile]) {
      const routeBytes = await exportByRoute(projectId);
      const opened = await catalog.openProject(projectId);
      if (!opened) throw new Error(`Progetto ${projectId} mancante.`);
      let direct: Buffer;
      try {
        direct = await exportXbsiteArchive(opened.project, opened.store);
      } finally {
        opened.store.close();
      }
      const [fromRoute, fromFunction] = [await comparable(routeBytes), await comparable(direct)];
      expect(fromRoute.files.length).toBeGreaterThan(0);
      expect(fromFunction, projectId).toEqual(fromRoute);
      expect((await decodeStaticPageArchive(direct)).profile.manifest.project.id).toBe(projectId);
    }
  });

  it("importProfile non aggiorna senza allowUpdate un progetto creato da un file", async () => {
    const projectId = await importFixtureByRoute();
    expect(projectId).toBe(FIXTURE_PROJECT_ID);
    const before = await revision(projectId);
    const decoded = await decodeStaticPageArchive(await exportByRoute(projectId));
    const catalog = new CmsProjectCatalog(dataDirectory);
    const seen: Array<string | null> = [];
    const beforeCommit = async (existing: { project: { id: string } } | null) => {
      seen.push(existing?.project.id ?? null);
    };

    await expect(importProfile({ catalog }, decoded, { allowUpdate: false, beforeCommit })).rejects.toMatchObject({ code: "cms-prototype-update-requires-flag", exitCode: 409 });
    expect(seen).toEqual([]);
    expect(await revision(projectId)).toBe(before);

    const updated = await importProfile({ catalog }, decoded, { allowUpdate: true, beforeCommit });
    expect(updated).toMatchObject({ status: 200, body: { project: { id: projectId }, keptLocal: [] } });
    expect(seen).toEqual([projectId]);

    // A file imported into a catalog that does not have the project creates it, and says so to beforeCommit.
    const elsewhere = await importProfile({ catalog: new CmsProjectCatalog(otherDirectory) }, decoded, { allowUpdate: false, beforeCommit });
    expect(elsewhere).toMatchObject({ status: 201, body: { project: { id: projectId } } });
    expect(seen).toEqual([projectId, null]);
  });

  it("un progetto creato nell'app non si sovrascrive mai da un file, nemmeno con allowUpdate", async () => {
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Solo app" }) });
    const projectId = (await created.json() as { project: { id: string } }).project.id;
    const decoded = await decodeStaticPageArchive(await exportByRoute(projectId));
    const catalog = new CmsProjectCatalog(dataDirectory);
    for (const allowUpdate of [false, true]) {
      await expect(importProfile({ catalog }, decoded, { allowUpdate })).rejects.toMatchObject({ code: "cms-project-duplicate", exitCode: 409 });
    }
  });

  it("importPrototypeHtml rispetta allowUpdate e non lascia cataloghi temporanei", async () => {
    const context = { catalog: new CmsProjectCatalog(otherDirectory), dataDirectory: otherDirectory, port: 0, registerPreview: () => undefined, registerBuild: () => undefined } satisfies CmsOperationsContext;
    const html = FIXTURE.toString("utf8");
    const created = await importPrototypeHtml(context, html, { download: false, allowUpdate: false });
    expect(created).toMatchObject({ status: 201, body: { project: { id: FIXTURE_PROJECT_ID, name: "Galleria" } } });
    await expect(importPrototypeHtml(context, html, { download: false, allowUpdate: false })).rejects.toMatchObject({ code: "cms-prototype-update-requires-flag" });
    let committed: string | null = null;
    const updated = await importPrototypeHtml(context, html, { download: false, allowUpdate: true, beforeCommit: async (existing) => {
      committed = existing?.project.id ?? null;
    } });
    expect(updated).toMatchObject({ status: 200, body: { project: { id: FIXTURE_PROJECT_ID } } });
    expect(committed).toBe(FIXTURE_PROJECT_ID);
    await expect(importPrototypeHtml(context, "<!doctype html><html><body></body></html>", { download: false, allowUpdate: true })).rejects.toMatchObject({ code: "cms-prototype-invalid", exitCode: 422 });
    expect((await readdir(otherDirectory)).filter((name) => name.startsWith(".prototype"))).toEqual([]);
  });

  it("importPrototypeHtml: «Annulla» vale fino all'ultimo momento prima di scrivere, poi la fase writing lo toglie (D3)", async () => {
    const context = { catalog: new CmsProjectCatalog(otherDirectory), dataDirectory: otherDirectory, port: 0, registerPreview: () => undefined, registerBuild: () => undefined } satisfies CmsOperationsContext;
    const html = FIXTURE.toString("utf8");
    // Cancelled while the caller prepares (the app saves its backup there): nothing is written, and the answer is 499.
    const controller = new AbortController();
    await expect(importPrototypeHtml(context, html, { download: false, allowUpdate: false, signal: controller.signal, beforeCommit: async () => { controller.abort(); } })).rejects.toMatchObject({ code: "cms-import-cancelled", exitCode: 499 });
    expect(await context.catalog.openProject(FIXTURE_PROJECT_ID)).toBeNull();
    // Without a cancellation the import reports that it writes, after the last check.
    const phases: string[] = [];
    const created = await importPrototypeHtml(context, html, { download: false, allowUpdate: false, onProgress: (progress) => phases.push(progress.phase) });
    expect(created.status).toBe(201);
    expect(phases.at(-1)).toBe("writing");
    expect((await readdir(otherDirectory)).filter((name) => name.startsWith(".prototype"))).toEqual([]);
  });
});
