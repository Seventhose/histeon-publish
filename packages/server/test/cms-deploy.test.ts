import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZipSource, type DeployBundleResult } from "@histos-publish/core";
import { AppRepository } from "../src/repository.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";
import type { CmsDestinationInspection, CmsPublishPlan } from "../src/cms-api.js";

describe("deploy esplicito dei build CMS sui provider Publish", () => {
  let server: LocalServerHandle;
  let dataDirectory: string;
  let uiDirectory: string;
  let base: string;
  let secrets: Map<string, string>;
  let cloudflareCalls: Array<{ accountId: string; script: string; files: Array<{ path: string; bytes?: Buffer }> }>;
  let rollbackCalls: Array<{ accountId: string; script: string; versionId: string }>;
  let hostingCalls: Array<{ host: string; protocol: string; username: string; files: Array<{ path: string; bytes: Buffer }> }>;
  let hostingRollbackCalls: Array<Array<{ path: string; beforeBytes: Buffer | null; beforeSha256: string | null; deployedSha256: string }>>;
  let hostingCurrent: Map<string, Buffer>;
  let cloudflareGate: (() => Promise<void>) | null;
  let cloudflareError: Error | null;
  let hostingError: Error | null;
  let hostingRemoteInventory: NonNullable<CmsDestinationInspection["remoteInventory"]>;
  const hostingDestinationIds = new Set<string>();
  const blockedDestinationIds = new Set<string>();

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-deploy-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-deploy-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>CMS deploy test</title>");
    secrets = new Map();
    cloudflareCalls = [];
    rollbackCalls = [];
    hostingCalls = [];
    hostingRollbackCalls = [];
    hostingCurrent = new Map([["index.html", Buffer.from("o")], ["legacy/old.css", Buffer.alloc(23, "x")]]);
    cloudflareGate = null;
    cloudflareError = null;
    hostingError = null;
    hostingRemoteInventory = { complete: true, files: [{ path: "index.html", size: 1 }, { path: "legacy/old.css", size: 23 }] };
    hostingDestinationIds.clear();
    blockedDestinationIds.clear();
    server = await startLocalServer({
      dataDirectory,
      uiDirectory,
      openBrowser: false,
      publishedHomeCheck: async (url) => ({ status: url ? "ok" : "unavailable", ...(url ? { url } : {}), message: "Verifica di prova." }),
      cmsDestinationInspection: async ({ destinationId }) => {
        const hosting = hostingDestinationIds.has(destinationId);
        return {
          schemaVersion: 1,
          destinationId,
          label: "CMS target",
          kind: hosting ? "static-hosting" : "static-cloudflare",
          transport: hosting ? "ftps" : "cloudflare-api",
          checkedAt: new Date().toISOString(),
          readVerified: true,
          writeVerified: false,
          publicUrl: hosting ? "https://publish.example.test" : "https://cms-test.account-finto.workers.dev",
          detectedCapabilities: { atomicSwitch: false, rollback: false, deleteManaged: false, remoteVerify: true, runtimeProvision: false, databaseProbe: false },
          evidence: hosting ? { host: "publish.example.test", remoteDirectory: "/public", entryCount: 0, directoryEmpty: true, wordpressSignals: [], publicOutputChecked: false } : { workerExists: true, worker: "cms-test", publicOutputChecked: false },
          ...(hosting ? { remoteInventory: hostingRemoteInventory } : {}),
          findings: blockedDestinationIds.has(destinationId) ? [{ severity: "block", code: "fixture-block", message: "Destinazione fixture bloccata." }] : [],
        } satisfies CmsDestinationInspection;
      },
      secretStoreFactory: (account) => ({
        get: async () => secrets.get(account) ?? null,
        set: async (value) => { secrets.set(account, value); },
        delete: async () => { secrets.delete(account); },
      }),
      cmsDeployAdapters: {
        cloudflare: async (input) => {
          cloudflareCalls.push({ accountId: input.accountId, script: input.script, files: input.files });
          await cloudflareGate?.();
          if (input.signal.aborted) throw new Error("fixture cancelled");
          if (cloudflareError) throw cloudflareError;
          input.onEvent({ type: "deploy-progress", phase: "upload", completed: input.files.length, total: input.files.length });
          return mockCloudflareResult(input.files.length);
        },
        hosting: async (input) => {
          hostingCalls.push({ host: input.settings.host, protocol: input.settings.protocol, username: input.credentials.username, files: input.files });
          input.onProgress({ phase: "upload", completed: Math.min(1, input.files.length), total: input.files.length });
          if (hostingError) {
            const firstFile = input.files[0];
            if (firstFile) hostingCurrent.set(firstFile.path, firstFile.bytes);
            throw hostingError;
          }
          for (const file of input.files) hostingCurrent.set(file.path, file.bytes);
          input.onProgress({ phase: "upload", completed: input.files.length, total: input.files.length });
          return { uploaded: input.files.length, files: input.files.length, publicUrl: input.settings.publicUrl };
        },
        hostingSnapshot: async (input) => input.files.map((file) => ({ path: file.path, beforeBytes: hostingCurrent.get(file.path) ?? null })),
        hostingRestore: async (input) => {
          hostingRollbackCalls.push(input.entries.map((entry) => ({ ...entry })));
          let restored = 0; let removed = 0; let alreadyRestored = 0;
          for (const entry of input.entries) {
            if (entry.beforeBytes === null) {
              if (hostingCurrent.delete(entry.path)) removed += 1;
              else alreadyRestored += 1;
            } else if (hostingCurrent.get(entry.path)?.equals(entry.beforeBytes)) alreadyRestored += 1;
            else { hostingCurrent.set(entry.path, entry.beforeBytes); restored += 1; }
          }
          return { restored, removed, alreadyRestored };
        },
      },
      cmsRollbackAdapter: async (input) => {
        rollbackCalls.push({ accountId: input.accountId, script: input.script, versionId: input.versionId });
        return { id: "fixture-rollback-deployment", versions: [{ version_id: input.versionId, percentage: 100 }] };
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    await Promise.all([rm(dataDirectory, { recursive: true, force: true }), rm(uiDirectory, { recursive: true, force: true })]);
  });

  it("invoca Cloudflare solo dopo build e scelta del sito, esclude bozze e salva l’esito separato", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);

    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    expect(plan).toMatchObject({ status: "ready", build: { homePage: "index.html" }, destination: { id: siteId, kind: "static-cloudflare", transport: "cloudflare-api" }, writeVerified: false });
    expect(plan.rollback).toMatchObject({ status: "provider-managed", note: expect.stringContaining("Cloudflare") });
    expect(plan.build.filesPreview.map((file) => file.path)).toContain("index.html");
    expect(cloudflareCalls).toHaveLength(0);

    const unrelatedSiteId = await createCloudflareSite(headers);
    const wrongDestination = await fetch(`${base}/api/cms/v1/destinations/apply`, {
      method: "POST", headers,
      body: JSON.stringify({ destinationId: unrelatedSiteId, action: "deploy", projectId, planId: plan.planId, confirmed: true }),
    });
    expect(wrongDestination.status).toBe(404);
    expect(await wrongDestination.json()).toMatchObject({ code: "cms-publish-plan-missing" });
    expect(cloudflareCalls).toHaveLength(0);

    const missingConfirmation = await fetch(`${base}/api/cms/v1/destinations/apply`, { method: "POST", headers, body: JSON.stringify({ destinationId: siteId, action: "deploy", projectId, planId: plan.planId }) });
    expect(missingConfirmation.status).toBe(428);
    expect(cloudflareCalls).toHaveLength(0);

    const published = await confirmPublishPlan(projectId, plan, headers);
    expect(published.status).toBe(202);
    const started = await published.json() as { jobId: string; deployId: string; targetSiteId: string };
    expect(started.targetSiteId).toBe(siteId);
    const events = await fetch(`${base}/api/jobs/${started.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    const eventText = await events.text();
    expect(eventText).toContain('"status":"complete"');
    expect(cloudflareCalls).toHaveLength(1);
    const repeatedConfirmation = await confirmPublishPlan(projectId, plan, headers);
    expect(repeatedConfirmation.status).toBe(202);
    expect(await repeatedConfirmation.json()).toMatchObject({ jobId: started.jobId, deployId: started.deployId });
    expect(cloudflareCalls).toHaveLength(1);
    const cloudflareCall = cloudflareCalls[0];
    if (!cloudflareCall) throw new Error("Adapter Cloudflare non chiamato.");
    expect(cloudflareCall).toMatchObject({ accountId: "a".repeat(32), script: "cms-test" });
    expect(cloudflareCall.files.map((file) => file.path)).toContain("index.html");
    expect(Buffer.concat(cloudflareCall.files.map((file) => file.bytes ?? Buffer.alloc(0))).toString()).not.toContain("Bozza esclusa");

    const history = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    expect(await history.json()).toMatchObject({ deployments: [{ id: started.deployId, status: "deployed", targetSiteId: siteId, result: { provider: "cloudflare" } }] });
    const ordinaryHistory = await fetch(`${base}/api/sites/${siteId}/history`, { headers: { "X-Histos-Token": server.token } });
    expect(await ordinaryHistory.json()).toMatchObject({ builds: [], deploys: [] });
  });

  it("riusa hosting e credenziali configurate senza rete", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    configureHostingSite(siteId);
    hostingDestinationIds.add(siteId);
    secrets.set(`hosting-${siteId}`, JSON.stringify({ username: "publisher", password: "fixture-secret", authMethod: "password" }));
    const build = await buildCmsProject(projectId, headers);

    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    expect(plan).toMatchObject({ status: "ready", destination: { kind: "static-hosting", transport: "ftps", location: expect.stringContaining("/public") }, findings: [] });
    expect(plan.remoteDiff).toMatchObject({
      status: "complete",
      basis: "path-and-size",
      counts: { remoteOnly: 1 },
    });
    expect(plan.remoteDiff.filesPreview).toContainEqual({ path: "index.html", status: "different-size", localSize: expect.any(Number), remoteSize: 1 });
    expect(plan.remoteDiff.filesPreview).toContainEqual({ path: "legacy/old.css", status: "remote-only", remoteSize: 23 });
    expect(plan.rollbackBackup).toMatchObject({ status: "ready", estimatedBytes: 1 });
    expect(plan.rollback).toMatchObject({ status: "ready", estimatedBytes: 1, maxBytes: expect.any(Number) });
    const deployed = await confirmPublishPlan(projectId, plan, headers);
    expect(deployed.status).toBe(202);
    const started = await deployed.json() as { jobId: string; deployId: string };
    const events = await fetch(`${base}/api/jobs/${started.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await events.text()).toContain('"status":"complete"');
    expect(hostingCalls).toHaveLength(1);
    const hostingCall = hostingCalls[0];
    if (!hostingCall) throw new Error("Adapter hosting non chiamato.");
    expect(hostingCall).toMatchObject({ host: "publish.example.test", protocol: "ftps", username: "publisher" });
    expect(hostingCall.files.map((file) => file.path)).toContain("index.html");
    expect(Buffer.concat(hostingCall.files.map((file) => file.bytes)).toString()).not.toContain("Bozza esclusa");

    const history = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    expect(await history.json()).toMatchObject({ deployments: [{ id: started.deployId, status: "deployed", result: { provider: "hosting", protocol: "ftps", healthCheck: { status: "ok", url: "https://publish.example.test" } } }] });
    expect(cloudflareCalls).toHaveLength(0);

    const hostingRollback = await fetch(`${base}/api/cms/v1/destinations/rollback`, {
      method: "POST", headers, body: JSON.stringify({ destinationId: siteId, projectId, buildId: build.id, deploymentId: started.deployId, confirmed: true }),
    });
    expect(hostingRollback.status).toBe(202);
    const rollbackStarted = await hostingRollback.json() as { jobId: string; deployId: string };
    const rollbackEvents = await fetch(`${base}/api/jobs/${rollbackStarted.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await rollbackEvents.text()).toContain('"status":"complete"');
    expect(hostingRollbackCalls).toHaveLength(1);
    expect(hostingCurrent.get("index.html")).toEqual(Buffer.from("o"));
    expect(hostingCurrent.has("legacy/old.css")).toBe(true);
    expect(rollbackCalls).toHaveLength(0);
  });

  it("invalida il piano hosting se il confronto remoto cambia prima della conferma", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    configureHostingSite(siteId);
    hostingDestinationIds.add(siteId);
    secrets.set(`hosting-${siteId}`, JSON.stringify({ username: "publisher", password: "fixture-secret", authMethod: "password" }));
    const build = await buildCmsProject(projectId, headers);
    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    expect(plan.remoteDiff.counts.remoteOnly).toBe(1);

    hostingRemoteInventory = { complete: true, files: [{ path: "index.html", size: 1 }, { path: "another-file.txt", size: 5 }] };
    const confirmation = await confirmPublishPlan(projectId, plan, headers);
    expect(confirmation.status).toBe(409);
    expect(await confirmation.json()).toMatchObject({ code: "cms-publish-plan-stale" });
    expect(hostingCalls).toHaveLength(0);
  });

  it("ripristina dalla cronologia una versione Cloudflare solo dopo conferma e registra l'operazione", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    const deployed = await confirmPublishPlan(projectId, plan, headers);
    const started = await deployed.json() as { jobId: string; deployId: string };
    const deployEvents = await fetch(`${base}/api/jobs/${started.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await deployEvents.text()).toContain('"status":"complete"');

    const endpoint = `${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments/${started.deployId}/rollback`;
    const unconfirmed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({}) });
    expect(unconfirmed.status).toBe(428);
    expect(rollbackCalls).toHaveLength(0);

    const unrelatedSiteId = await createCloudflareSite(headers);
    const wrongDestination = await fetch(`${base}/api/cms/v1/destinations/rollback`, {
      method: "POST", headers,
      body: JSON.stringify({ destinationId: unrelatedSiteId, projectId, buildId: build.id, deploymentId: started.deployId, confirmed: true }),
    });
    expect(wrongDestination.status).toBe(409);
    expect(await wrongDestination.json()).toMatchObject({ code: "cms-deployment-destination-mismatch" });
    expect(rollbackCalls).toHaveLength(0);

    const rolledBack = await fetch(`${base}/api/cms/v1/destinations/rollback`, {
      method: "POST", headers,
      body: JSON.stringify({ destinationId: siteId, projectId, buildId: build.id, deploymentId: started.deployId, confirmed: true }),
    });
    expect(rolledBack.status).toBe(202);
    const rollback = await rolledBack.json() as { jobId: string; deployId: string; versionId: string };
    const rollbackEvents = await fetch(`${base}/api/jobs/${rollback.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await rollbackEvents.text()).toContain('"status":"complete"');
    expect(rollbackCalls).toEqual([{ accountId: "a".repeat(32), script: "cms-test", versionId: "fixture-version" }]);

    const history = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    expect(await history.json()).toMatchObject({ deployments: [
      { id: rollback.deployId, status: "deployed", result: { provider: "cloudflare", versionId: "fixture-version", rollbackOf: started.deployId } },
      { id: started.deployId, status: "deployed", result: { provider: "cloudflare", versionId: "fixture-version" } },
    ] });
  });

  it("non crea un piano confermabile quando il preflight segnala un blocco", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    blockedDestinationIds.add(siteId);

    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    expect(plan).toMatchObject({ status: "blocked", planId: null, findings: [{ severity: "block", code: "fixture-block" }] });
    const deploy = await fetch(`${base}/api/cms/v1/projects/${projectId}/deploy`, {
      method: "POST", headers, body: JSON.stringify({ planId: plan.planId, confirmed: true }),
    });
    expect(deploy.status).toBe(400);
    expect(cloudflareCalls).toHaveLength(0);
  });

  it("invalida il piano se i file del build cambiano prima della conferma", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    const htmlPath = path.join(dataDirectory, "histos-cms-builds", projectId, build.id, "index.html");
    await writeFile(htmlPath, "<!doctype html><title>Changed after review</title>");

    const deploy = await confirmPublishPlan(projectId, plan, headers);
    expect(deploy.status).toBe(409);
    expect(await deploy.json()).toMatchObject({ code: "cms-publish-plan-stale" });
    expect(cloudflareCalls).toHaveLength(0);
  });

  it("non prepara né conferma piani basati su un progetto CMS modificato", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    const initialPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const changed = await fetch(`${base}/api/cms/v1/projects/${projectId}/pages`, {
      method: "POST", headers, body: JSON.stringify({ title: "Aggiunta dopo il build" }),
    });
    expect(changed.status).toBe(201);

    const stalePlan = await fetch(`${base}/api/cms/v1/projects/${projectId}/publish-plan`, {
      method: "POST", headers, body: JSON.stringify({ buildId: build.id, targetSiteId: siteId }),
    });
    expect(stalePlan.status).toBe(409);
    expect(await stalePlan.json()).toMatchObject({ code: "cms-build-stale" });

    const confirmed = await confirmPublishPlan(projectId, initialPlan, headers);
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toMatchObject({ code: "cms-publish-plan-stale" });
    expect(cloudflareCalls).toHaveLength(0);
  });

  it("invalida il piano se la configurazione della destinazione cambia prima della conferma", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    const repository = new AppRepository(path.join(dataDirectory, "histos-publish.sqlite"));
    try {
      const site = repository.getSite(siteId);
      if (!site) throw new Error("Sito fixture non trovato.");
      repository.updateSite(siteId, { config: { ...site.config, cloudflare: { accountId: "a".repeat(32), script: "worker-cambiato" } } });
    } finally { repository.close(); }

    const deploy = await confirmPublishPlan(projectId, plan, headers);
    expect(deploy.status).toBe(409);
    expect(await deploy.json()).toMatchObject({ code: "cms-publish-plan-stale" });
    expect(cloudflareCalls).toHaveLength(0);
  });

  it("esporta una build pronta come ZIP statico e rifiuta build mancanti o di un altro progetto", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const otherProjectId = await createPublishedCmsProject(headers);
    const build = await buildCmsProject(projectId, headers);
    const endpoint = `${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/export`;

    const missing = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/00000000-0000-4000-8000-000000000000/export`, { method: "POST", headers, body: "{}" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "cms-build-missing" });

    const wrongProject = await fetch(`${base}/api/cms/v1/projects/${otherProjectId}/builds/${build.id}/export`, { method: "POST", headers, body: "{}" });
    expect(wrongProject.status).toBe(409);
    expect(await wrongProject.json()).toMatchObject({ code: "cms-build-project-mismatch" });

    const response = await fetch(endpoint, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    // A readable name: the project name and the day (E11).
    expect(response.headers.get("content-disposition")).toMatch(/filename="[a-z0-9-]+-\d{4}-\d{2}-\d{2}-sito\.zip"/u);
    const archivePath = path.join(dataDirectory, "cms-static-build.zip");
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    const archive = await readZipSource(archivePath, { maxBytes: 250 * 1024 * 1024 });
    const filePaths = archive.files.map((file) => file.path);
    expect(filePaths).toContain("index.html");
    expect(archive.files.find((file) => file.path === "index.html")?.bytes.toString("utf8")).toContain("<title>Home</title>");
    expect(filePaths.some((file) => file.startsWith(".histos-publish/") || /\.(?:sqlite|histosproject|xbsite)$/u.test(file))).toBe(false);
  });

  it("registra l’upload hosting parziale e consente un nuovo invio verificabile", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    configureHostingSite(siteId);
    hostingDestinationIds.add(siteId);
    secrets.set(`hosting-${siteId}`, JSON.stringify({ username: "publisher", password: "fixture-secret", authMethod: "password" }));
    const build = await buildCmsProject(projectId, headers);
    hostingError = new Error("Pubblicazione FTP/FTPS non riuscita: connessione interrotta. Ho caricato 1 file; quelli già aggiornati restano sul server.");

    const failedPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const failed = await confirmPublishPlan(projectId, failedPlan, headers);
    expect(failed.status).toBe(202);
    const failedJob = await failed.json() as { jobId: string; deployId: string };
    const failedEvents = await fetch(`${base}/api/jobs/${failedJob.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await failedEvents.text()).toContain('"status":"failed"');
    const failedHistory = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    expect(await failedHistory.json()).toMatchObject({ deployments: [{ id: failedJob.deployId, status: "failed", result: { provider: "hosting", rollbackAvailable: true }, error: expect.stringContaining("Ho caricato 1 file") }] });

    const partialRollback = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments/${failedJob.deployId}/rollback`, {
      method: "POST", headers, body: JSON.stringify({ confirmed: true }),
    });
    expect(partialRollback.status).toBe(202);
    const partialRollbackJob = await partialRollback.json() as { jobId: string; deployId: string };
    const partialRollbackEvents = await fetch(`${base}/api/jobs/${partialRollbackJob.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await partialRollbackEvents.text()).toContain('"status":"complete"');
    expect(hostingCurrent.get("index.html")).toEqual(Buffer.from("o"));
    expect(hostingRollbackCalls).toHaveLength(1);

    hostingError = null;
    const retryPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const retried = await confirmPublishPlan(projectId, retryPlan, headers);
    const retryJob = await retried.json() as { jobId: string; deployId: string };
    const retryEvents = await fetch(`${base}/api/jobs/${retryJob.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await retryEvents.text()).toContain('"status":"complete"');
    const retryHistory = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    const retryHistoryBody = await retryHistory.json() as { deployments: Array<{ id: string; status: string }> };
    expect(retryHistoryBody.deployments.map((deployment) => deployment.id)).toEqual(expect.arrayContaining([retryJob.deployId, partialRollbackJob.deployId, failedJob.deployId]));
    expect(retryHistoryBody.deployments.find((deployment) => deployment.id === retryJob.deployId)?.status).toBe("deployed");
    expect(retryHistoryBody.deployments.find((deployment) => deployment.id === partialRollbackJob.deployId)?.status).toBe("deployed");
    expect(retryHistoryBody.deployments.find((deployment) => deployment.id === failedJob.deployId)?.status).toBe("failed");
  });

  it("rifiuta un secondo job mentre il primo deploy del build è ancora attivo", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    let markStarted!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    cloudflareGate = async () => { markStarted(); await providerGate; };

    const firstPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const secondPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const first = await confirmPublishPlan(projectId, firstPlan, headers);
    const started = await first.json() as { jobId: string };
    await providerStarted;
    const second = await confirmPublishPlan(projectId, secondPlan, headers);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "cms-deploy-already-running" });
    release();
    const events = await fetch(`${base}/api/jobs/${started.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await events.text()).toContain('"status":"complete"');
    expect(cloudflareCalls).toHaveLength(1);
  });

  it("registra un errore del provider in modo interrogabile e consente un nuovo tentativo esplicito", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    cloudflareError = new Error("fixture provider failure");
    const failedPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const failed = await confirmPublishPlan(projectId, failedPlan, headers);
    const failedJob = await failed.json() as { jobId: string; deployId: string };
    const failedEvents = await fetch(`${base}/api/jobs/${failedJob.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await failedEvents.text()).toContain('"status":"failed"');
    const firstHistory = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    expect(await firstHistory.json()).toMatchObject({ deployments: [{ id: failedJob.deployId, status: "failed", error: "fixture provider failure" }] });

    cloudflareError = null;
    const retryPlan = await createPublishPlan(projectId, build.id, siteId, headers);
    const retried = await confirmPublishPlan(projectId, retryPlan, headers);
    const retryJob = await retried.json() as { jobId: string; deployId: string };
    const retryEvents = await fetch(`${base}/api/jobs/${retryJob.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await retryEvents.text()).toContain('"status":"complete"');
    const retryHistory = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    const retryRecords = (await retryHistory.json() as { deployments: Array<{ id: string; status: string }> }).deployments;
    expect(retryRecords.find((deployment) => deployment.id === failedJob.deployId)).toMatchObject({ status: "failed" });
    expect(retryRecords.find((deployment) => deployment.id === retryJob.deployId)).toMatchObject({ status: "deployed" });
  });

  it("salva il deploy annullato con stato recuperabile", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    let markStarted!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    cloudflareGate = async () => { markStarted(); await providerGate; };
    const plan = await createPublishPlan(projectId, build.id, siteId, headers);
    const startedResponse = await confirmPublishPlan(projectId, plan, headers);
    const started = await startedResponse.json() as { jobId: string; deployId: string };
    await providerStarted;
    const cancelled = await fetch(`${base}/api/jobs/${started.jobId}/cancel`, { method: "POST", headers, body: "{}" });
    expect(cancelled.status).toBe(202);
    release();
    const events = await fetch(`${base}/api/jobs/${started.jobId}/events`, { headers: { "X-Histos-Token": server.token } });
    expect(await events.text()).toContain('"status":"cancelled"');
    const history = await fetch(`${base}/api/cms/v1/projects/${projectId}/builds/${build.id}/deployments`, { headers: { "X-Histos-Token": server.token } });
    expect(await history.json()).toMatchObject({ deployments: [{ id: started.deployId, status: "cancelled", error: "fixture cancelled" }] });
  });

  it("rifiuta un build appartenente a un altro progetto", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const otherProject = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    const response = await fetch(`${base}/api/cms/v1/projects/${otherProject}/publish-plan`, {
      method: "POST", headers, body: JSON.stringify({ buildId: build.id, targetSiteId: siteId }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "cms-build-project-mismatch" });
    expect(cloudflareCalls).toHaveLength(0);
  });

  it("rifiuta un bundle CMS spostato fuori dalla directory privata prevista", async () => {
    const headers = requestHeaders();
    const projectId = await createPublishedCmsProject(headers);
    const siteId = await createCloudflareSite(headers);
    const build = await buildCmsProject(projectId, headers);
    const bundlePath = path.join(dataDirectory, "histos-cms-builds", projectId, build.id);
    await rm(bundlePath, { recursive: true, force: true });
    await symlink(uiDirectory, bundlePath, "dir");

    const response = await fetch(`${base}/api/cms/v1/projects/${projectId}/publish-plan`, {
      method: "POST", headers, body: JSON.stringify({ buildId: build.id, targetSiteId: siteId }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "cms-build-path-invalid" });
    expect(cloudflareCalls).toHaveLength(0);
  });

  function requestHeaders(): Record<string, string> {
    return { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
  }

  async function createPublishPlan(projectId: string, buildId: string, targetSiteId: string, headers: Record<string, string>): Promise<CmsPublishPlan> {
    const response = await fetch(`${base}/api/cms/v1/destinations/plan`, {
      method: "POST", headers, body: JSON.stringify({ destinationId: targetSiteId, action: "deploy", projectId, buildId }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as CmsPublishPlan;
  }

  function confirmPublishPlan(projectId: string, plan: CmsPublishPlan, headers: Record<string, string>, confirmed = true): Promise<Response> {
    return fetch(`${base}/api/cms/v1/destinations/apply`, {
      method: "POST", headers, body: JSON.stringify({ destinationId: plan.destination.id, action: "deploy", projectId, planId: plan.planId, confirmed }),
    });
  }

  async function createPublishedCmsProject(headers: Record<string, string>): Promise<string> {
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "CMS deploy fixture" }) });
    const { project } = await created.json() as { project: { id: string } };
    const draft = await fetch(`${base}/api/cms/v1/projects/${project.id}/pages`, { method: "POST", headers, body: JSON.stringify({ title: "Bozza esclusa" }) });
    expect(draft.status).toBe(201);
    const details = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers: { "X-Histos-Token": server.token } });
    const pages = (await details.json() as { pages: Array<{ slug: string; alias: number; headRevision: string }> }).pages;
    const home = pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Pagina Home non trovata nel fixture.");
    const included = await fetch(`${base}/api/cms/v1/projects/${project.id}/pages/${home.alias}`, {
      method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }),
    });
    expect(included.status).toBe(200);
    return project.id;
  }

  async function buildCmsProject(projectId: string, headers: Record<string, string>): Promise<{ id: string }> {
    const response = await fetch(`${base}/api/cms/v1/projects/${projectId}/build`, { method: "POST", headers, body: "{}" });
    const result = await response.json() as { id?: string; status?: string; code?: string };
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.status).toBe("ready");
    if (!result.id) throw new Error("Build CMS senza identificativo.");
    return { id: result.id };
  }

  async function createCloudflareSite(headers: Record<string, string>): Promise<string> {
    const created = await fetch(`${base}/api/sites`, {
      method: "POST", headers, body: JSON.stringify({
        name: "CMS target", source: { kind: "directory", path: dataDirectory },
        cloudflare: { accountId: "a".repeat(32), script: "cms-test" },
      }),
    });
    const body = await created.json() as { site: { id: string } };
    expect(created.status).toBe(201);
    return body.site.id;
  }

  function configureHostingSite(siteId: string): void {
    hostingDestinationIds.add(siteId);
    const repository = new AppRepository(path.join(dataDirectory, "histos-publish.sqlite"));
    try {
      const site = repository.getSite(siteId);
      if (!site) throw new Error("Sito fixture non trovato.");
      repository.updateSite(siteId, { config: {
        ...site.config,
        deployTarget: "ftp",
        hosting: { protocol: "ftps", host: "publish.example.test", port: 21, remoteDirectory: "/public", username: "publisher", publicUrl: "https://publish.example.test" },
      } });
      repository.setSetting(`hostingCredentials:${siteId}`, true);
    } finally { repository.close(); }
  }

  function mockCloudflareResult(fileCount: number): DeployBundleResult {
    return {
      versionId: "fixture-version",
      deployment: { id: "fixture-deployment", versions: [{ version_id: "fixture-version", percentage: 100 }] },
      files: fileCount,
      uploaded: fileCount,
      findings: [],
    };
  }
});
