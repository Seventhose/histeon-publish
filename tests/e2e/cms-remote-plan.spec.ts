import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { backToSites, newProject, openProjectTab } from "./cms-helpers.js";
import { expectDialogFitsMobile } from "./responsive-helpers.js";

interface E2EState { baseUrl: string; token: string }
type PlanAction = "pull" | "push" | "publish";
interface PlanFixture {
  applyAllowed: boolean;
  initializingRemote?: boolean;
  counts: { new: number; update: number; unchanged: number; "local-only": number; "remote-only": number; conflict: number };
  entities: Array<{ id: string; kind: string; label: string; status: "new" | "update" | "unchanged" | "local-only" | "remote-only" | "conflict"; canResolve?: boolean; comparison?: Array<{ field: string; local: string; remote: string }>; omittedComparisonFields?: number; blockedReason?: "local-missing" | "remote-missing" | "type-changed" }>;
}
interface RemoteOperationFixture {
  operationId: string;
  connectionId: string;
  projectId: string;
  action: "push" | "publish";
  state: "pending" | "applying" | "partial" | "superseded" | "not-found" | "complete" | "complete-local-changes" | "rolled-back" | "failed";
  expectedEntityCount: number;
  createdAt: string;
  updatedAt: string;
  message: string | null;
  rollbackAvailable: boolean;
  rollbackRetryAvailable?: boolean;
  rollbackOfOperationId?: string;
}

const CONNECTION_ID = "6a1d2a67-b34f-4dde-a234-1c678ebc8b10";

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function openCmsProject(page: Page, projectName: string, plan: PlanFixture): Promise<{ projectId: string; applyRequests: string[]; planRequests: Array<{ projectId?: string; action?: PlanAction; destinationId?: string }>; operations: RemoteOperationFixture[]; rollbackRequests: string[]; connectionRequests: Array<Record<string, unknown>>; unlinkRequests: Array<{ url: string; localOnly: boolean }>; setRevocationUnavailable: (value: boolean) => void; setRollbackResponseUncertain: (value: boolean) => void; setRollbackResponsePartial: (value: boolean) => void }> {
  const env = await state();
  let projectId = "";
  let action: PlanAction = "push";
  const applyRequests: string[] = [];
  const planRequests: Array<{ projectId?: string; action?: PlanAction; destinationId?: string }> = [];
  const operations: RemoteOperationFixture[] = [];
  const rollbackRequests: string[] = [];
  const connectionRequests: Array<Record<string, unknown>> = [];
  const unlinkRequests: Array<{ url: string; localOnly: boolean }> = [];
  let connectionPresent = true;
  let revocationUnavailable = false;
  let rollbackResponseUncertain = false;
  let rollbackResponsePartial = false;
  await page.route(/\/api\/cms\/v1\/(?:connections|destinations)(?:\/|$)/u, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const requestUrl = new URL(request.url());
    if (request.method() === "POST" && pathname === "/api/cms/v1/connections") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      connectionRequests.push(payload);
      await route.fulfill({ status: payload.connectionId ? 200 : 201, json: { connection: { id: payload.connectionId ?? CONNECTION_ID, url: "https://wordpress.updated.example.test", siteId: "c7f66b89-81c2-4e34-9513-c4f1886decc3", projectId: null, projectName: "WordPress di prova", profile: "histos-static-page-v1", read: true, write: true, publish: true, connectedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), lastSyncedAt: null } } });
      return;
    }
    if (request.method() === "GET" && pathname.endsWith("/connections")) {
      await route.fulfill({ json: { connections: connectionPresent ? [{ id: CONNECTION_ID, url: "https://wordpress.example.test", siteId: "c7f66b89-81c2-4e34-9513-c4f1886decc3", projectId: null, projectName: "WordPress di prova", profile: "histos-static-page-v1", read: true, write: true, publish: true, connectedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), lastSyncedAt: null, operations }] : [] } });
      return;
    }
    if (request.method() === "DELETE" && pathname === `/api/cms/v1/connections/${CONNECTION_ID}`) {
      const localOnly = requestUrl.searchParams.get("localOnly") === "true";
      unlinkRequests.push({ url: request.url(), localOnly });
      if (revocationUnavailable && !localOnly) {
        await route.fulfill({ status: 409, json: { error: "WordPress non ha confermato la revoca.", code: "cms-remote-revoke-unconfirmed" } });
        return;
      }
      connectionPresent = false;
      await route.fulfill({ status: 200, json: { removed: true, id: CONNECTION_ID, remoteAccess: localOnly ? "left-active" : "revoked" } });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/check")) {
      const operationId = pathname.split("/").at(-2);
      const operation = operations.find((candidate) => candidate.operationId === operationId);
      if (!operation) {
        await route.fulfill({ status: 404, json: { error: "Operazione non trovata nel mock." } });
        return;
      }
      if (operation.state === "partial" && operation.rollbackRetryAvailable) {
        await route.fulfill({ json: { state: "partial", phase: "pages", advancedBases: 0, localChanges: operation.expectedEntityCount } });
        return;
      }
      operation.state = "complete";
      operation.updatedAt = new Date().toISOString();
      await route.fulfill({ json: { state: "complete", phase: null, advancedBases: 1, localChanges: 0 } });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/rollback")) {
      const operationId = pathname.split("/").at(-2);
      const operation = operations.find((candidate) => candidate.operationId === operationId);
      rollbackRequests.push(request.url());
      const partialAttempt = operations.find((candidate) => candidate.rollbackOfOperationId === operationId && candidate.state === "partial" && candidate.rollbackRetryAvailable);
      if (!operation) {
        await route.fulfill({ status: 409, json: { error: "Backup non disponibile nel mock." } });
        return;
      }
      if (partialAttempt && !operation.rollbackAvailable) {
        partialAttempt.state = "superseded";
        partialAttempt.rollbackRetryAvailable = false;
        partialAttempt.message = "Sostituita dopo verifica.";
        operation.state = "rolled-back";
        operations.push({
          operationId: "6fa3df28-0f45-4cea-9dab-01a0dd9f4629",
          connectionId: CONNECTION_ID,
          projectId,
          action: operation.action,
          state: "complete",
          expectedEntityCount: operation.expectedEntityCount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "Ripristino completato dopo verifica.",
          rollbackAvailable: false,
          rollbackOfOperationId: operation.operationId,
        });
        await route.fulfill({ json: { state: "rolled-back", rollbackOperationId: "6fa3df28-0f45-4cea-9dab-01a0dd9f4629", published: false } });
        return;
      }
      if (!operation.rollbackAvailable) {
        await route.fulfill({ status: 409, json: { error: "Backup non disponibile nel mock." } });
        return;
      }
      if (rollbackResponseUncertain) {
        rollbackResponseUncertain = false;
        operation.rollbackAvailable = false;
        operation.updatedAt = new Date().toISOString();
        operations.push({
          operationId: "d922b480-733d-4d52-9a5f-71170306e335",
          connectionId: CONNECTION_ID,
          projectId,
          action: operation.action,
          state: "pending",
          expectedEntityCount: operation.expectedEntityCount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "Risposta interrotta: controlla lo stato prima di riprovare.",
          rollbackAvailable: false,
          rollbackOfOperationId: operation.operationId,
        });
        await route.fulfill({ status: 504, json: { error: "Controlla l’operazione esistente prima di riprovare.", code: "cms-remote-rollback-uncertain" } });
        return;
      }
      if (rollbackResponsePartial) {
        rollbackResponsePartial = false;
        operation.rollbackAvailable = false;
        operation.updatedAt = new Date().toISOString();
        operations.push({
          operationId: "14974388-050a-4da3-86db-9f02f5eb04b4",
          connectionId: CONNECTION_ID,
          projectId,
          action: operation.action,
          state: "partial",
          expectedEntityCount: operation.expectedEntityCount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "WordPress ha interrotto il ripristino.",
          rollbackAvailable: false,
          rollbackRetryAvailable: true,
          rollbackOfOperationId: operation.operationId,
        });
        await route.fulfill({ status: 504, json: { error: "Ripristino parziale.", code: "cms-remote-rollback-incomplete" } });
        return;
      }
      operation.state = "rolled-back";
      operation.rollbackAvailable = false;
      operation.updatedAt = new Date().toISOString();
      await route.fulfill({ json: { state: "rolled-back", rollbackOperationId: "b7d06cce-cffd-452c-a7d2-0c068c941af7", published: false } });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/plan")) {
      const input = request.postDataJSON() as { projectId?: string; action?: PlanAction; destinationId?: string };
      planRequests.push(input);
      projectId = input.projectId ?? projectId;
      action = input.action ?? "push";
      const conflicts = plan.entities.filter((entity) => entity.status === "conflict");
      const canResolve = action === "pull" && conflicts.length === plan.counts.conflict && conflicts.every((entity) => entity.canResolve === true);
      const planId = plan.applyAllowed || canResolve ? "a5b7e9c1-344a-4f6d-8f71-99b4c42cf120" : null;
      const rollbackNote = action === "pull"
        ? "Il download aggiorna il progetto locale ma non modifica WordPress. Esporta un backup .histosproject prima di applicare modifiche se vuoi conservare una copia completa del progetto."
        : "Il backup WordPress non esiste ancora: viene salvato dopo un invio completato. In seguito potrai ripristinarlo dalla cronologia solo se tutte le revisioni Histeon sul sito corrispondono ancora all’esito registrato; il collegamento deve autorizzare lettura e scrittura e, per contenuti pubblicati, anche Publish. Plugin e hook possono essere eseguiti di nuovo durante il ripristino: email e chiamate API già partite non si possono annullare. Prova prima su staging e controlla i plugin attivi.";
      await route.fulfill({ json: { ...plan, schemaVersion: 1, destination: { id: `wordpress:${CONNECTION_ID}`, label: "WordPress di prova", kind: "wordpress-existing", transport: "histos-remote", publicUrl: "https://wordpress.example.test" }, rollback: { status: "unavailable", estimatedBytes: 0, maxBytes: 0, note: rollbackNote }, initializingRemote: plan.initializingRemote ?? false, planId, action, connectionId: CONNECTION_ID, project: { id: projectId, name: projectName }, profile: "histos-static-project-v3", expiresAt: planId ? new Date(Date.now() + 600_000).toISOString() : null, omittedEntities: 0 } });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/apply")) {
      const payload = JSON.parse(request.postData() ?? "{}") as { resolutions?: Record<string, string>; action?: PlanAction; destinationId?: string };
      if (payload.action) action = payload.action;
      applyRequests.push(request.postData() ?? "");
      const keptLocal = Object.entries(payload.resolutions ?? {}).filter(([, choice]) => choice === "keep-local").map(([id]) => id);
      await route.fulfill({ json: { action, connectionId: CONNECTION_ID, projectId, ...(action === "pull" ? { project: { id: projectId, name: projectName }, changed: [], keptLocal } : { report: { changed: ["550e8400-e29b-41d4-a716-446655440101"], unchanged: [], complete: true } }), complete: true } });
      return;
    }
    await route.continue();
  });

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  const createdProjectResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/cms/v1/projects");
  await newProject(page, projectName);
  const createdProject = await (await createdProjectResponse).json() as { project: { id: string } };
  projectId = createdProject.project.id;
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  // Destinations, linked sites and their plans are in the Publish tab (E14).
  await openProjectTab(page, "Pubblica");
  return {
    projectId, applyRequests, planRequests, operations, rollbackRequests, connectionRequests, unlinkRequests,
    setRevocationUnavailable: (value) => { revocationUnavailable = value; },
    setRollbackResponseUncertain: (value) => { rollbackResponseUncertain = value; },
    setRollbackResponsePartial: (value) => { rollbackResponsePartial = value; },
  };
}

test("la pubblicazione WordPress compare nella destinazione unificata e usa il piano Histeon", async ({ page }) => {
  const projectName = `E2E publish unificato ${Date.now()}`;
  const { projectId, planRequests, applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    initializingRemote: true,
    counts: { new: 2, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [
      { id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Pagina iniziale", status: "new" },
      { id: "550e8400-e29b-41d4-a716-446655440102", kind: "styles", label: "Stili globali", status: "new" },
    ],
  });
  let staticDeployRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/cms\/v1\/projects\/[0-9a-f-]+\/deploy$/u.test(new URL(request.url()).pathname)) staticDeployRequests += 1;
  });

  await page.locator("#cms-deploy-destination").selectOption(`wordpress:${CONNECTION_ID}`);
  await expect(page.getByText(/Non serve una versione statica/u)).toBeVisible();
  await page.getByRole("button", { name: "Rivedi piano di pubblicazione" }).click();

  const dialog = page.getByRole("dialog", { name: "Pubblica sul sito" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("wordpress.example.test");
  await expect(dialog).toContainText("Il backup WordPress non esiste ancora");
  await expect(dialog).toContainText("Plugin e hook possono essere eseguiti di nuovo durante il ripristino");
  await expect(dialog).toContainText("controlla i plugin attivi");
  await expect(dialog).toContainText("Prova prima su staging");
  expect(planRequests.at(-1)).toEqual({ destinationId: `wordpress:${CONNECTION_ID}`, action: "publish", projectId });
  expect(applyRequests).toHaveLength(0);
  expect(staticDeployRequests).toBe(0);
  await dialog.getByRole("button", { name: /Conferma pubblicazione/u }).click();
  await expect.poll(() => applyRequests).toHaveLength(1);
  expect(JSON.parse(applyRequests[0]!)).toMatchObject({ destinationId: `wordpress:${CONNECTION_ID}`, projectId, action: "publish", confirmed: true });
  expect(staticDeployRequests).toBe(0);
  await expect(page.getByText(/Pubblicazione completata: 1 elementi aggiornati su WordPress/u)).toBeVisible();
});

test("dopo la prima pubblicazione propone la pagina iniziale del progetto e la imposta solo col sì (voce 201)", async ({ page }) => {
  const projectName = `E2E pagina iniziale ${Date.now()}`;
  const { projectId, applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    initializingRemote: true,
    counts: { new: 1, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Pagina iniziale", status: "new" }],
  });
  const offers: string[] = [];
  const answers: unknown[] = [];
  let offered = true;
  // The proposal comes from the server, which reads the pages from the project: the app only says yes or no.
  await page.route(`**/api/cms/v1/connections/${CONNECTION_ID}/front-page**`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      offers.push(new URL(request.url()).searchParams.get("projectId") ?? "");
      await route.fulfill({ json: { offer: offered ? { frontPage: { id: "550e8400-e29b-41d4-a716-446655440101", title: "Home" }, postsPage: { id: "550e8400-e29b-41d4-a716-446655440103", title: "Blog" }, postsWithoutPage: false, current: { showOnFront: "posts", frontPageIsOther: false, postsPageIsOther: false } } : null } });
      return;
    }
    answers.push(request.postDataJSON());
    offered = false;
    await route.fulfill({ json: { answer: "accepted", showOnFront: "page" } });
  });
  await page.locator("#cms-deploy-destination").selectOption(`wordpress:${CONNECTION_ID}`);
  await page.getByRole("button", { name: "Rivedi piano di pubblicazione" }).click();
  await page.getByRole("dialog", { name: "Pubblica sul sito" }).getByRole("button", { name: /Conferma pubblicazione/u }).click();
  await expect.poll(() => applyRequests).toHaveLength(1);
  const offer = page.getByTestId("cms-front-page-offer");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Vuoi che wordpress.example.test si apra su «Home», come nel progetto?");
  await expect(offer).toContainText("elenco degli articoli");
  await expect(offer).toContainText("«Blog»");
  await expect(offer).toContainText("Impostazioni → Lettura");
  expect(offers).toEqual([projectId]);
  expect(answers).toEqual([]);
  await offer.getByTestId("cms-front-page-accept").click();
  await expect(offer).toBeHidden();
  expect(answers).toEqual([{ projectId, accept: true }]);
  await expect(page.getByText("Ora wordpress.example.test si apre su «Home», come nel progetto.")).toBeVisible();
});

test("il selettore apre il preflight per configurare un nuovo WordPress senza installarlo", async ({ page }) => {
  const env = await state();
  const headers = { Origin: env.baseUrl, "X-Histos-Token": env.token, "Content-Type": "application/json" };
  const suffix = Date.now().toString(36);
  const siteName = `Nuovo WordPress CMS ${suffix}`;
  const siteResponse = await fetch(new URL("/api/sites", env.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: siteName, source: { kind: "html", path: `/tmp/${siteName}.html` } }),
  });
  expect(siteResponse.status, await siteResponse.clone().text()).toBe(201);
  const { site } = await siteResponse.json() as { site: { id: string } };

  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { sites: Array<Record<string, unknown>> };
    payload.sites = payload.sites.map((candidate) => candidate.id === site.id ? {
      ...candidate,
      deployTarget: "ftp",
      hosting: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html", publicUrl: "https://wp.example.test", username: "publisher" },
      hostingCredentialsConfigured: true,
    } : candidate);
    await route.fulfill({ response, json: payload });
  });
  let installRequests = 0;
  await page.route(`**/api/sites/${site.id}/hosting/wordpress-install`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { plans: [] } });
    installRequests += 1;
    return route.continue();
  });

  const projectName = `Progetto CMS nuovo WordPress ${suffix}`;
  await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [],
  });

  const destination = page.locator("#cms-deploy-destination");
  await expect(destination.getByRole("option", { name: `${siteName} · Nuovo WordPress · ftp.example.test`, exact: true })).toBeAttached();
  await destination.selectOption(`wordpress-new:${site.id}`);
  await expect(page.getByText(/Prima passerai da verifica database, runtime PHP e piano/u)).toBeVisible();
  await page.getByRole("button", { name: "Configura nuovo WordPress" }).click();

  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Configura WordPress per ${projectName}` })).toBeVisible();
  await expect(page.getByLabel("Database per il nuovo WordPress")).toBeVisible();
  expect(await page.locator("#cms-deploy-destination").inputValue()).toBe(`wordpress-new:${site.id}`);
  expect(installRequests).toBe(0);
});

test("chiede conferma e revoca il pairing prima di scollegare il sito", async ({ page }) => {
  const projectName = `E2E Remote unlink ${Date.now()}`;
  const { unlinkRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [],
  });

  await backToSites(page);
  await page.getByRole("button", { name: "Scollega" }).click();
  const dialog = page.getByRole("dialog", { name: "Scollega il sito Histeon" });
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/Prima provo a revocare il pairing anche su WordPress/u)).toBeVisible();
  expect(unlinkRequests).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(unlinkRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Scollega" }).click();

  const confirmedDialog = page.getByRole("dialog", { name: "Scollega il sito Histeon" });
  await confirmedDialog.getByRole("button", { name: /Revoca e scollega/u }).click();
  await expect.poll(() => unlinkRequests).toHaveLength(1);
  expect(unlinkRequests[0]?.localOnly).toBe(false);
  await expect(confirmedDialog).toHaveCount(0);
  await expect(page.getByRole("status").getByText(/Pairing revocato su WordPress/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Scollega" })).toHaveCount(0);
});

test("consente di scollegare solo in locale dopo aver spiegato che il pairing remoto resta attivo", async ({ page }) => {
  const projectName = `E2E Remote local unlink ${Date.now()}`;
  const { unlinkRequests, setRevocationUnavailable } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [],
  });
  setRevocationUnavailable(true);

  await backToSites(page);
  await page.getByRole("button", { name: "Scollega" }).click();
  const dialog = page.getByRole("dialog", { name: "Scollega il sito Histeon" });
  await dialog.getByRole("button", { name: /Revoca e scollega/u }).click();
  await expect(dialog.getByRole("button", { name: "Scollega solo qui" })).toBeVisible();
  await expect(page.getByText(/il pairing potrebbe restare valido su WordPress/u)).toBeVisible();
  expect(unlinkRequests).toHaveLength(1);

  await dialog.getByRole("button", { name: "Scollega solo qui" }).click();
  await expect.poll(() => unlinkRequests).toHaveLength(2);
  expect(unlinkRequests[1]?.localOnly).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").getByText(/Il pairing può restare valido su WordPress/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Scollega" })).toHaveCount(0);
});

test("aggiorna il collegamento esistente usando un nuovo codice dello stesso sito", async ({ page }) => {
  const projectName = `E2E Reconnect ${Date.now()}`;
  const { connectionRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [],
  });

  await backToSites(page);
  // E9: the pairing form lives in the "Collegati" filter.
  await page.getByRole("button", { name: /Collegati/ }).click();
  await page.getByLabel("Collegamento da aggiornare").selectOption(CONNECTION_ID);
  await page.getByLabel("Codice di abbinamento Histeon").fill("histos-cms-1:codice-rinnovato");
  await expect(page.getByText(/solo se l’identità del sito coincide/u)).toBeVisible();
  await page.getByRole("button", { name: "Verifica e aggiorna collegamento →" }).click();

  await expect.poll(() => connectionRequests).toHaveLength(1);
  expect(connectionRequests[0]).toMatchObject({ code: "histos-cms-1:codice-rinnovato", connectionId: CONNECTION_ID });
  await expect(page.getByRole("status").getByText("Collegamento Histeon aggiornato: wordpress.updated.example.test.")).toBeVisible();
});

test("mostra il diff e chiede conferma prima di inviare un progetto Histeon", async ({ page }) => {
  const projectName = `E2E Remote plan ${Date.now()}`;
  const { applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 1, update: 1, unchanged: 2, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [
      { id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Pagina iniziale", status: "update" },
      { id: "550e8400-e29b-41d4-a716-446655440102", kind: "content-record", label: "Evento demo", status: "new" },
    ],
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  const dialog = page.getByRole("dialog", { name: "Invia al sito" });
  await expect(dialog).toBeVisible();
  await expectDialogFitsMobile(page, dialog);
  await expect(dialog).toContainText("Plugin e hook possono essere eseguiti di nuovo durante il ripristino");
  await expect(dialog).toContainText("Il backup WordPress non esiste ancora");
  await expect(dialog).toContainText("email e chiamate API già partite non si possono annullare");
  await expect(dialog).toContainText("Prova prima su staging");
  await expect(page.getByText("Pagina iniziale")).toBeVisible();
  await expect(page.getByText("Evento demo")).toBeVisible();
  expect(applyRequests).toHaveLength(0);
  await page.getByRole("button", { name: /Conferma invio/u }).click();
  await expect.poll(() => applyRequests).toHaveLength(1);
  await expect(page.getByRole("dialog", { name: "Invia al sito" })).toHaveCount(0);
});

test("nel piano di download chiarisce che WordPress non viene modificato", async ({ page }) => {
  const projectName = `E2E Remote pull plan ${Date.now()}`;
  const { applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: false,
    counts: { new: 0, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 1 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Pagina iniziale", status: "conflict", canResolve: true }],
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  await page.getByRole("button", { name: /Rivedi download/u }).click();
  const dialog = page.getByRole("dialog", { name: "Scarica dal sito" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Il download aggiorna il progetto locale ma non modifica WordPress");
  await expect(dialog).not.toContainText("Plugin e hook possono essere eseguiti di nuovo durante il ripristino");
  expect(applyRequests).toHaveLength(0);
});

test("spiega il primo invio verso un WordPress senza progetto Histeon", async ({ page }) => {
  const projectName = `E2E Remote initialize ${Date.now()}`;
  const { applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    initializingRemote: true,
    counts: { new: 2, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [
      { id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Pagina iniziale", status: "new" },
      { id: "550e8400-e29b-41d4-a716-446655440102", kind: "styles", label: "Stili globali", status: "new" },
    ],
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  const dialog = page.getByRole("dialog", { name: "Invia al sito" });
  await expect(dialog).toBeVisible();
  await expectDialogFitsMobile(page, dialog);
  await expect(page.getByText(/non ha ancora un progetto Histeon collegato/u)).toBeVisible();
  expect(applyRequests).toHaveLength(0);
  await page.getByRole("button", { name: /Conferma invio/u }).click();
  await expect.poll(() => applyRequests).toHaveLength(1);
});

test("ferma l'invio e spiega un conflitto con cambio di tipo", async ({ page }) => {
  const projectName = `E2E Remote conflict ${Date.now()}`;
  const { applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: false,
    counts: { new: 0, update: 0, unchanged: 1, "local-only": 0, "remote-only": 0, conflict: 1 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "content-record", label: "Pagina modificata da entrambe le parti", status: "conflict", canResolve: false, blockedReason: "type-changed", comparison: [{ field: "tipo entità", local: "document", remote: "content-record" }, { field: "title", local: "Titolo locale", remote: "Titolo remoto" }] }],
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  await expect(page.getByRole("dialog", { name: "Invia al sito" })).toBeVisible();
  await expect(page.getByText(/modifiche concorrenti/u)).toBeVisible();
  await expect(page.getByText("Pagina modificata da entrambe le parti", { exact: true })).toBeVisible();
  await expect(page.getByText(/tipo dell’entità è cambiato/u)).toBeVisible();
  await page.getByText("Confronta 2 campi modificati").click();
  await expect(page.getByText("Titolo locale")).toBeVisible();
  await expect(page.getByText("Titolo remoto")).toBeVisible();
  await expect(page.getByRole("button", { name: /Conferma invio/u })).toBeDisabled();
  expect(applyRequests).toHaveLength(0);
});

test("segnala quando il remoto ha eliminato un'entità già sincronizzata", async ({ page }) => {
  const projectName = `E2E Remote deletion ${Date.now()}`;
  const { applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: false,
    counts: { new: 0, update: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 1 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Pagina cancellata sul sito", status: "conflict", canResolve: false, blockedReason: "remote-missing" }],
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  await expect(page.getByRole("dialog", { name: "Invia al sito" })).toBeVisible();
  await expect(page.getByText(/La copia sul sito manca/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /Conferma invio/u })).toBeDisabled();
  expect(applyRequests).toHaveLength(0);
});

test("permette di scegliere quale versioni conservare prima del download", async ({ page }) => {
  const projectName = `E2E Remote resolve ${Date.now()}`;
  const conflictId = "550e8400-e29b-41d4-a716-446655440101";
  const { applyRequests } = await openCmsProject(page, projectName, {
    applyAllowed: false,
    counts: { new: 0, update: 0, unchanged: 1, "local-only": 0, "remote-only": 0, conflict: 1 },
    entities: [{ id: conflictId, kind: "document", label: "Pagina da confrontare", status: "conflict", canResolve: true, comparison: [{ field: "title", local: "Titolo sul computer", remote: "Titolo sul sito" }] }],
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  await page.getByRole("button", { name: /Rivedi download/u }).click();
  const dialog = page.getByRole("dialog", { name: "Scarica dal sito" });
  await expect(dialog).toBeVisible();
  await expectDialogFitsMobile(page, dialog);
  await page.getByText("Confronta il campo modificato").click();
  await expect(page.getByText("Titolo sul computer")).toBeVisible();
  await expect(page.getByText("Titolo sul sito")).toBeVisible();
  await page.getByLabel("Versione da conservare per Pagina da confrontare").selectOption("keep-local");
  const apply = page.getByRole("button", { name: /Applica le scelte e scarica/u });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(() => applyRequests).toHaveLength(1);
  expect(JSON.parse(applyRequests[0]!)).toMatchObject({ resolutions: { [conflictId]: "keep-local" } });
  await expect(page.getByText(/versioni locali conservate/u)).toBeVisible();
});

test("mostra dopo la riapertura l'invio remoto da verificare e non lo reinvia", async ({ page }) => {
  const projectName = `E2E Remote recovery ${Date.now()}`;
  const { projectId, operations } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 1, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Home", status: "update" }],
  });
  const operationId = "f00c3e12-2a4c-4daa-98a2-07a7cd967e73";
  operations.push({
    operationId,
    connectionId: CONNECTION_ID,
    projectId,
    action: "push",
    state: "pending",
    expectedEntityCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: null,
    rollbackAvailable: false,
  });

  // E12: reopening the app at the project's address opens the project again.
  await page.reload();
  await expect(page.getByRole("heading", { name: projectName, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await openProjectTab(page, "Pubblica");
  await expect(page.getByRole("region", { name: "Invii remoti da verificare" })).toBeVisible();
  await expect(page.getByText(/Invio in sviluppo · Da controllare/u)).toBeVisible();
  await page.getByRole("button", { name: "Controlla esito" }).click();
  await expect(page.getByRole("status").getByText(/Esito verificato: invio completato/u)).toBeVisible();
  await expect(page.getByRole("region", { name: "Invii remoti da verificare" })).toHaveCount(0);
});

test("ripristina dalla cronologia solo dopo conferma e nasconde l'operazione completata", async ({ page }) => {
  const projectName = `E2E Remote rollback ${Date.now()}`;
  const { projectId, operations, rollbackRequests } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 1, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Home", status: "update" }],
  });
  operations.push({
    operationId: "edc36402-0fe2-4ca1-bc4e-9a4f3298b372",
    connectionId: CONNECTION_ID,
    projectId,
    action: "publish",
    state: "complete",
    expectedEntityCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: "Pubblicazione verificata.",
    rollbackAvailable: true,
  });

  // E12: reopening the app at the project's address opens the project again.
  await page.reload();
  await expect(page.getByRole("heading", { name: projectName, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await openProjectTab(page, "Pubblica");
  const operationRegion = page.getByRole("region", { name: "Invii remoti da verificare" });
  await expect(operationRegion).toBeVisible();
  expect(rollbackRequests).toHaveLength(0);
  await operationRegion.getByRole("button", { name: "Ripristina" }).click();
  const dialog = page.getByRole("dialog", { name: "Ripristinare la copia precedente?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Plugin e hook WordPress possono eseguire di nuovo le proprie azioni");
  expect(rollbackRequests).toHaveLength(0);
  await dialog.getByRole("button", { name: /Conferma ripristino/u }).click();
  await expect.poll(() => rollbackRequests).toHaveLength(1);
  await expect(page.getByRole("status").getByText(/La copia precedente è stata ripristinata su WordPress/u)).toBeVisible();
  await expect(operationRegion).toHaveCount(0);
});

test("dopo una risposta incerta del ripristino mostra il journal e impedisce un doppio invio", async ({ page }) => {
  const projectName = `E2E Remote rollback recovery ${Date.now()}`;
  const { projectId, operations, rollbackRequests, setRollbackResponseUncertain } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 1, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Home", status: "update" }],
  });
  operations.push({
    operationId: "ce5dc057-68f4-47a4-bf8d-4fe44bba8850",
    connectionId: CONNECTION_ID,
    projectId,
    action: "push",
    state: "complete",
    expectedEntityCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: "Invio verificato.",
    rollbackAvailable: true,
  });
  setRollbackResponseUncertain(true);

  // E12: reopening the app at the project's address opens the project again.
  await page.reload();
  await expect(page.getByRole("heading", { name: projectName, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await openProjectTab(page, "Pubblica");
  const operationRegion = page.getByRole("region", { name: "Invii remoti da verificare" });
  await expect(operationRegion).toBeVisible();
  await operationRegion.getByRole("button", { name: "Ripristina" }).click();
  const dialog = page.getByRole("dialog", { name: "Ripristinare la copia precedente?" });
  await dialog.getByRole("button", { name: /Conferma ripristino/u }).click();

  await expect.poll(() => rollbackRequests).toHaveLength(1);
  await expect(dialog).toHaveCount(0);
  await expect(operationRegion.getByText(/Ripristino compensativo · Da controllare/u)).toBeVisible();
  await expect(operationRegion.getByRole("button", { name: "Controlla esito" })).toBeVisible();
  await expect(operationRegion.getByRole("button", { name: "Ripristina" })).toHaveCount(0);
  await expect(operationRegion.getByRole("button", { name: "Rivedi nuovo piano" })).toHaveCount(0);

  await operationRegion.getByRole("button", { name: "Controlla esito" }).click();
  await expect(page.getByRole("status").getByText(/Ripristino verificato/u)).toBeVisible();
  expect(rollbackRequests).toHaveLength(1);
});

test("riprende un ripristino parziale solo dopo controllo e conferma esplicita", async ({ page }) => {
  const projectName = `E2E Remote rollback partial ${Date.now()}`;
  const { projectId, operations, rollbackRequests, setRollbackResponsePartial } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 1, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Home", status: "update" }],
  });
  operations.push({
    operationId: "5a7e53ed-0205-46bb-8e2c-7fbb58be1928",
    connectionId: CONNECTION_ID,
    projectId,
    action: "publish",
    state: "complete",
    expectedEntityCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: "Pubblicazione verificata.",
    rollbackAvailable: true,
  });
  setRollbackResponsePartial(true);

  // E12: reopening the app at the project's address opens the project again.
  await page.reload();
  await expect(page.getByRole("heading", { name: projectName, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await openProjectTab(page, "Pubblica");
  const operationRegion = page.getByRole("region", { name: "Invii remoti da verificare" });
  await operationRegion.getByRole("button", { name: "Ripristina" }).click();
  let dialog = page.getByRole("dialog", { name: "Ripristinare la copia precedente?" });
  await dialog.getByRole("button", { name: /Conferma ripristino/u }).click();
  await expect.poll(() => rollbackRequests).toHaveLength(1);
  await expect(dialog).toHaveCount(0);

  await operationRegion.getByRole("button", { name: "Controlla esito" }).click();
  await expect(page.getByRole("status").getByText(/Verifica e riprendi/u)).toBeVisible();
  // The notice stands in the corner where this button falls at this window size: it is read, then closed.
  await page.getByRole("region", { name: "Avvisi" }).getByRole("button", { name: "Chiudi" }).click();
  const resume = operationRegion.getByRole("button", { name: "Verifica e riprendi" });
  await expect(resume).toBeVisible();
  await resume.click();
  dialog = page.getByRole("dialog", { name: "Verificare e riprendere il ripristino?" });
  await expect(dialog).toContainText("le modifiche estranee bloccano l’operazione");
  expect(rollbackRequests).toHaveLength(1);
  await dialog.getByRole("button", { name: /Verifica e riprendi/u }).click();
  await expect.poll(() => rollbackRequests).toHaveLength(2);
  await expect(dialog).toHaveCount(0);
  expect(operations).toContainEqual(expect.objectContaining({ state: "superseded", rollbackOfOperationId: "5a7e53ed-0205-46bb-8e2c-7fbb58be1928" }));
  await expect(page.getByRole("status").getByText(/La copia precedente è stata ripristinata su WordPress/u)).toBeVisible();
});

test("mostra subito il recupero se la risposta di WordPress si interrompe durante l'invio", async ({ page }) => {
  const projectName = `E2E Remote uncertain ${Date.now()}`;
  const { projectId, operations } = await openCmsProject(page, projectName, {
    applyAllowed: true,
    counts: { new: 0, update: 1, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 },
    entities: [{ id: "550e8400-e29b-41d4-a716-446655440101", kind: "document", label: "Home", status: "update" }],
  });
  const operationId = "53aa8399-4083-4f99-8a3f-dedfc68ba117";
  let applyRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/cms/v1/destinations/apply") applyRequests += 1;
  });
  await page.route("**/api/cms/v1/destinations/apply", async (route) => {
    operations.push({
      operationId,
      connectionId: CONNECTION_ID,
      projectId,
      action: "push",
      state: "pending",
      expectedEntityCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: "La risposta si è interrotta; l’esito remoto va controllato.",
      rollbackAvailable: false,
    });
    await route.fulfill({ status: 504, json: { error: "Controlla l’esito remoto prima di inviare di nuovo.", code: "cms-remote-operation-uncertain" } });
  });

  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  await page.getByRole("button", { name: /Conferma invio/u }).click();
  await expect(page.getByRole("region", { name: "Invii remoti da verificare" })).toBeVisible();
  await expect(page.getByText(/Invio in sviluppo · Da controllare/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Controlla esito" })).toBeVisible();
  expect(applyRequests).toBe(1);
});
