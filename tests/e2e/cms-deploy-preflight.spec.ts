import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { backToSites, newProject, openProject, openProjectTab, prepareSite, setPageStatus } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string; mockUrl: string; mockAccountId: string }

async function readState(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

function mockHttpUrl(state: E2EState): string {
  return state.mockUrl.replace(/\/client\/v4$/u, "");
}

test("ferma il deploy CMS e spiega l'errore quando il Worker scelto non esiste", async ({ page }) => {
  const state = await readState();
  const headers = { Origin: state.baseUrl, "X-Histos-Token": state.token, "Content-Type": "application/json" };
  const suffix = Date.now().toString(36);
  const worker = `worker-assente-${suffix}`;
  const siteResponse = await fetch(new URL("/api/sites", state.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Destinazione assente ${suffix}`, source: { kind: "html", path: "/tmp/cms-destination.html" }, cloudflare: { accountId: state.mockAccountId, script: worker } }),
  });
  expect(siteResponse.status, await siteResponse.clone().text()).toBe(201);
  const { site } = await siteResponse.json() as { site: { id: string } };

  let deployRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/cms\/v1\/projects\/[0-9a-f-]+\/deploy$/u.test(new URL(request.url()).pathname)) deployRequests += 1;
  });
  await page.goto(`${state.baseUrl}/#token=${state.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const projectName = `Preflight destinazione ${suffix}`;
  await newProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await setPageStatus(page, "Home", "Nel sito");
  await prepareSite(page);
  await expect(page.getByRole("heading", { name: "Sito pronto" })).toBeVisible();
  await page.locator("#cms-deploy-destination").selectOption(site.id);
  await page.getByRole("button", { name: "Rivedi piano di pubblicazione" }).click();

  await expect(page.getByRole("alert")).toContainText("non esiste");
  expect(deployRequests).toBe(0);
  const cloudflareState = await fetch(`${mockHttpUrl(state)}/__state`).then((response) => response.json()) as { scripts: Record<string, unknown>; requestCounts: Record<string, number> };
  expect(Object.keys(cloudflareState.scripts)).toEqual([]);
  expect(Object.keys(cloudflareState.requestCounts).filter((key) => /^(?:PUT|POST|DELETE) /u.test(key))).toEqual([]);
});

test("mostra il piano prima del deploy e richiede una conferma esplicita", async ({ page }) => {
  const state = await readState();
  const headers = { Origin: state.baseUrl, "X-Histos-Token": state.token, "Content-Type": "application/json" };
  const suffix = Date.now().toString(36);
  const worker = `worker-piano-${suffix}`;
  const siteResponse = await fetch(new URL("/api/sites", state.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Destinazione piano ${suffix}`, source: { kind: "html", path: "/tmp/cms-plan.html" }, cloudflare: { accountId: state.mockAccountId, script: worker } }),
  });
  expect(siteResponse.status, await siteResponse.clone().text()).toBe(201);
  const { site } = await siteResponse.json() as { site: { id: string; name: string } };
  const projectName = `Piano pubblicazione ${suffix}`;
  const projectResponse = await fetch(new URL("/api/cms/v1/projects", state.baseUrl), {
    method: "POST", headers, body: JSON.stringify({ name: projectName }),
  });
  expect(projectResponse.status).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const detailsResponse = await fetch(new URL(`/api/cms/v1/projects/${project.id}`, state.baseUrl), { headers });
  const pages = (await detailsResponse.json() as { pages: Array<{ alias: number; slug: string; headRevision: string }> }).pages;
  const home = pages.find((pageItem) => pageItem.slug === "home");
  if (!home) throw new Error("Pagina Home CMS non trovata.");
  const publishedHome = await fetch(new URL(`/api/cms/v1/projects/${project.id}/pages/${home.alias}`, state.baseUrl), {
    method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }),
  });
  expect(publishedHome.status).toBe(200);

  let deployCalls = 0;
  let deployBody: unknown;
  const planId = "123e4567-e89b-42d3-a456-426614174002";
  const deployId = "123e4567-e89b-42d3-a456-426614174003";
  const jobId = "e2e-cms-publish-job";
  let deploymentCommitted = false;
  await page.route("**/api/cms/v1/projects/*/builds", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { builds: Array<Record<string, unknown>> };
    if (deploymentCommitted && payload.builds[0]) {
      payload.builds[0].deployments = [{ id: deployId, targetSiteId: site.id, status: "deployed", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), result: { provider: "cloudflare", accountId: state.mockAccountId, script: worker, versionId: "e2e-version-id", healthCheck: { status: "ok", url: `https://${worker}.account-finto.workers.dev`, message: "Verifica E2E" } }, error: null }];
    }
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route("**/api/cms/v1/destinations/plan", async (route) => {
    const request = route.request().postDataJSON() as { buildId?: string; destinationId?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        planId,
        projectId: project.id,
        buildId: request.buildId,
        projectRevision: "a".repeat(64),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        build: { fileCount: 1, totalBytes: 1024, sha256: "b".repeat(64), homePage: "index.html", filesPreview: [{ path: "index.html", size: 1024 }], additionalFiles: 0 },
        destination: { id: request.destinationId, label: site.name, kind: "static-cloudflare", transport: "cloudflare-api", location: `Worker ${worker}`, publicUrl: `https://${worker}.account-finto.workers.dev` },
        rollback: { status: "provider-managed", estimatedBytes: 0, maxBytes: 0, note: "Le versioni del Worker restano gestite da Cloudflare; l’app non archivia una copia del sito remoto." },
        inspection: { schemaVersion: 1, destinationId: request.destinationId, label: site.name, kind: "static-cloudflare", transport: "cloudflare-api", checkedAt: new Date().toISOString(), readVerified: true, writeVerified: false, detectedCapabilities: { atomicSwitch: false, rollback: false, deleteManaged: false, remoteVerify: true, runtimeProvision: false, databaseProbe: false }, evidence: { workerExists: true }, findings: [] },
        remoteDiff: { status: "unavailable", basis: "none", counts: { missing: 0, sameSize: 0, differentSize: 0, remoteOnly: 0 }, filesPreview: [], additionalFiles: 0, note: "Il provider non espone un inventario file statico." },
        rollbackBackup: { status: "not-applicable", estimatedBytes: 0, maxBytes: 268_435_456, note: "" },
        effects: ["Invierà i file al Worker selezionato."],
        findings: [],
        writeVerified: false,
      }),
    });
  });
  await page.route("**/api/cms/v1/destinations/apply", async (route) => {
    deployCalls += 1;
    deployBody = route.request().postDataJSON();
    deploymentCommitted = true;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId, deployId, targetSiteId: site.id }) });
  });
  await page.route(`**/api/jobs/${jobId}/events`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "job-finished", status: "complete" })}\n\n` });
  });
  await page.route("**/api/cms/v1/projects/*/builds/*/deployments", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deployments: [{ id: deployId, targetSiteId: site.id, status: "deployed", result: { provider: "cloudflare", accountId: state.mockAccountId, script: worker, versionId: "e2e-version-id", healthCheck: { status: "ok", url: `https://${worker}.account-finto.workers.dev`, message: "Verifica E2E" } } }] }),
    });
  });
  const rollbackJobId = "e2e-cms-rollback-job";
  let rollbackBody: unknown;
  await page.route("**/api/cms/v1/destinations/rollback", async (route) => {
    rollbackBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: rollbackJobId, deployId: "e2e-cms-rollback-record" }) });
  });
  await page.route(`**/api/jobs/${rollbackJobId}/events`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "job-finished", status: "complete" })}\n\n` });
  });

  await page.goto(`${state.baseUrl}/#token=${state.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await prepareSite(page);
  await expect(page.getByRole("heading", { name: "Sito pronto" })).toBeVisible();
  await page.locator("#cms-deploy-destination").selectOption(site.id);
  await page.getByRole("button", { name: "Rivedi piano di pubblicazione" }).click();
  await expect(page.getByText("Piano pronto per la revisione")).toBeVisible();
  await expect(page.getByText(`Worker ${worker}`, { exact: false })).toBeVisible();
  await expect(page.getByText("Il provider non fornisce un elenco di file confrontabile.")).toBeVisible();
  const confirm = page.getByRole("button", { name: "Conferma e pubblica" });
  await expect(confirm).toBeDisabled();
  expect(deployCalls).toBe(0);
  await page.getByLabel(`Confermo l’invio di 1 file a ${site.name}.`).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText(`Versione pubblicata su ${site.name}.`, { exact: true })).toBeVisible();
  expect(deployCalls).toBe(1);
  expect(deployBody).toEqual({ destinationId: site.id, action: "deploy", projectId: project.id, planId, confirmed: true });

  await backToSites(page);
  await openProject(page, projectName);
  await openProjectTab(page, "Pubblica");
  await expect(page.getByRole("heading", { name: "Sito pronto" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cronologia", exact: true })).toBeVisible();
  await expect(page.getByText("Pubblicazione · Pubblicata", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ripristina questa versione Cloudflare →" }).click();
  await expect(page.getByRole("dialog", { name: "Conferma il ripristino" })).toContainText("e2e-version-id");
  await page.getByRole("dialog").getByRole("button", { name: "Conferma ripristino →" }).click();
  await expect(page.getByText(`Worker ${worker} ripristinato alla versione e2e-version-id.`, { exact: true })).toBeVisible();
  expect(rollbackBody).toMatchObject({ destinationId: site.id, projectId: expect.any(String), buildId: expect.any(String), deploymentId: deployId, confirmed: true });
});

test("mostra e conferma il ripristino dei file hosting dalla cronologia CMS", async ({ page }) => {
  const state = await readState();
  const headers = { Origin: state.baseUrl, "X-Histos-Token": state.token, "Content-Type": "application/json" };
  const suffix = Date.now().toString(36);
  const siteResponse = await fetch(new URL("/api/sites", state.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Hosting rollback ${suffix}`, source: { kind: "html", path: "/tmp/cms-hosting-rollback.html" }, cloudflare: { accountId: state.mockAccountId, script: `hosting-rollback-${suffix}` } }),
  });
  expect(siteResponse.status, await siteResponse.clone().text()).toBe(201);
  const { site } = await siteResponse.json() as { site: { id: string; name: string } };
  const deploymentId = "123e4567-e89b-42d3-a456-426614174004";
  const rollbackJobId = "e2e-cms-hosting-rollback-job";
  let rollbackBody: unknown;

  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { sites: Array<Record<string, unknown>> };
    payload.sites = payload.sites.map((candidate) => candidate.id === site.id
      ? { ...candidate, deployTarget: "ftp", hosting: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public", publicUrl: "https://hosting.example.test" } }
      : candidate);
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route("**/api/cms/v1/projects/*/builds", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { builds: Array<Record<string, unknown>> };
    payload.builds = payload.builds.map((build, index) => index === 0
      ? { ...build, deployments: [{ id: deploymentId, targetSiteId: site.id, status: "deployed", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), result: { provider: "hosting", rollbackAvailable: true, backupBytes: 128 }, error: null }] }
      : build);
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route("**/api/cms/v1/destinations/rollback", async (route) => {
    rollbackBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: rollbackJobId, deployId: "e2e-cms-hosting-rollback-record" }) });
  });
  await page.route(`**/api/jobs/${rollbackJobId}/events`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "job-finished", status: "complete" })}\n\n` });
  });

  const projectName = `Cronologia hosting ${suffix}`;
  await page.goto(`${state.baseUrl}/#token=${state.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await setPageStatus(page, "Home", "Nel sito");
  await prepareSite(page);
  await expect(page.getByRole("heading", { name: "Sito pronto" })).toBeVisible();
  await backToSites(page);
  await openProject(page, projectName);
  await openProjectTab(page, "Pubblica");
  await expect(page.getByRole("heading", { name: "Cronologia", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ripristina i file hosting precedenti →" }).click();
  const dialog = page.getByRole("dialog", { name: "Conferma il ripristino" });
  await expect(dialog).toContainText(site.name);
  await expect(dialog).toContainText("hash dei file remoti");
  await dialog.getByRole("button", { name: "Conferma ripristino →" }).click();
  await expect(page.getByText(`File precedenti ripristinati su ${site.name}.`, { exact: true })).toBeVisible();
  expect(rollbackBody).toMatchObject({ destinationId: site.id, projectId: expect.any(String), buildId: expect.any(String), deploymentId, confirmed: true });
});
