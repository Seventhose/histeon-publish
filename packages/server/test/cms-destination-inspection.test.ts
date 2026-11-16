import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudflareMock, type CloudflareMockHandle } from "@histos-publish/cf-mock";
import { CloudflareClient, deployBundle } from "@histos-publish/core";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

describe("ispezione CMS delle destinazioni Cloudflare", () => {
  let server: LocalServerHandle | null = null;
  let mock: CloudflareMockHandle | null = null;
  let dataDirectory: string | null = null;
  let uiDirectory: string | null = null;
  const previousApiBase = process.env.HISTOS_CLOUDFLARE_API_BASE;
  const previousToken = process.env.HISTOS_CLOUDFLARE_API_TOKEN;

  afterEach(async () => {
    if (server) await server.close();
    if (mock) await mock.close();
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
    if (uiDirectory) await rm(uiDirectory, { recursive: true, force: true });
    if (previousApiBase === undefined) delete process.env.HISTOS_CLOUDFLARE_API_BASE;
    else process.env.HISTOS_CLOUDFLARE_API_BASE = previousApiBase;
    if (previousToken === undefined) delete process.env.HISTOS_CLOUDFLARE_API_TOKEN;
    else process.env.HISTOS_CLOUDFLARE_API_TOKEN = previousToken;
    server = null;
    mock = null;
    dataDirectory = null;
    uiDirectory = null;
  });

  it("ferma la pubblicazione preliminare se il Worker salvato non esiste e usa solo GET", async () => {
    mock = await startCloudflareMock();
    process.env.HISTOS_CLOUDFLARE_API_BASE = mock.url;
    process.env.HISTOS_CLOUDFLARE_API_TOKEN = mock.token;
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-destination-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-destination-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>destination test</title>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };

    const createdSite = await fetch(`${base}/api/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Worker inesistente",
        source: { kind: "html", path: "/tmp/histos-destination-fixture.html" },
        cloudflare: { accountId: mock.accountId, script: "worker-assente" },
      }),
    });
    expect(createdSite.status, await createdSite.clone().text()).toBe(201);
    const { site } = await createdSite.json() as { site: { id: string } };
    const createdProject = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Build statico" }) });
    expect(createdProject.status).toBe(201);
    const { project } = await createdProject.json() as { project: { id: string } };

    const inspected = await fetch(`${base}/api/cms/v1/projects/${project.id}/destinations/inspect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ destinationId: site.id }),
    });
    expect(inspected.status).toBe(404);
    expect(await inspected.json()).toMatchObject({ code: "cloudflare-api", error: expect.stringContaining("non esiste") });
    expect(Object.keys(mock.state().scripts)).toEqual([]);
    expect(Object.keys(mock.state().requestCounts).some((key) => /PUT|POST|DELETE/u.test(key))).toBe(false);
  });

  it("restituisce solo capability verificate quando Worker e workers.dev sono leggibili", async () => {
    mock = await startCloudflareMock();
    process.env.HISTOS_CLOUDFLARE_API_BASE = mock.url;
    process.env.HISTOS_CLOUDFLARE_API_TOKEN = mock.token;
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-destination-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-destination-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>destination test</title>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const worker = "cms-destination-readable";
    const client = new CloudflareClient({ token: mock.token, apiBase: mock.url });
    const html = Buffer.from("<!doctype html><title>Worker fixture</title>");
    await deployBundle({ client, accountId: mock.accountId, script: worker, files: [{ path: "index.html", size: html.byteLength, bytes: html }], signal: new AbortController().signal });

    const createdSite = await fetch(`${base}/api/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Worker leggibile", source: { kind: "html", path: "/tmp/histos-destination-fixture.html" }, cloudflare: { accountId: mock.accountId, script: worker } }),
    });
    expect(createdSite.status).toBe(201);
    const { site } = await createdSite.json() as { site: { id: string } };
    const createdProject = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Destinazione leggibile" }) });
    expect(createdProject.status).toBe(201);
    const { project } = await createdProject.json() as { project: { id: string } };
    const before = mock.state().requestCounts;

    const inspected = await fetch(`${base}/api/cms/v1/projects/${project.id}/destinations/inspect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ destinationId: site.id }),
    });
    expect(inspected.status, await inspected.clone().text()).toBe(200);
    expect(await inspected.json()).toMatchObject({
      destinationId: site.id,
      kind: "static-cloudflare",
      transport: "cloudflare-api",
      readVerified: true,
      writeVerified: false,
      publicUrl: `https://${worker}.account-finto.workers.dev`,
      detectedCapabilities: { atomicSwitch: false, rollback: false, deleteManaged: false, remoteVerify: true, runtimeProvision: false, databaseProbe: false },
      evidence: { workerExists: true, publicOutputChecked: false },
    });
    const after = mock.state().requestCounts;
    expect(Object.entries(after).filter(([key, count]) => count > (before[key] ?? 0) && !key.startsWith("GET "))).toEqual([]);
  });
});
