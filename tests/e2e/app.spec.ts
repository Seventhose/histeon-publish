import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { backToSites, newProject, openProject, openProjectTab } from "./cms-helpers.js";
import { expectDialogFitsMobile, expectScreenFitsSupportedWidths } from "./responsive-helpers.js";

interface E2EState { baseUrl: string; token: string; mockUrl: string }

async function readState(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

function mockHttpUrl(state: E2EState): string {
  return state.mockUrl.replace(/\/client\/v4$/u, "");
}

test.beforeEach(async ({ page }) => {
  const state = await readState();
  await fetch(`${mockHttpUrl(state)}/__reset`);
  await page.goto(`${state.baseUrl}/#token=${state.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe("");
  expect(await page.evaluate(() => sessionStorage.getItem("histos-publish-session"))).toBe(state.token);
});

test("il catalogo CMS filtra i progetti e porta alle azioni principali", async ({ page }) => {
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await expect(page.getByRole("heading", { name: "I tuoi siti", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /Tutti/ })).toHaveAttribute("aria-pressed", "true");
  await expectScreenFitsSupportedWidths(page);

  await newProject(page, "Catalogo prova");
  await backToSites(page);

  await page.getByRole("button", { name: /Sul computer/ }).click();
  await expect(page.locator(".site-card").filter({ hasText: "Catalogo prova" })).toBeVisible();
  await expect(page.locator("#cms-connected-sites")).toHaveCount(0);

  await page.getByRole("button", { name: /Collegati/ }).click();
  await expect(page.locator(".site-card").filter({ hasText: "Catalogo prova" })).toHaveCount(0);
  await expect(page.locator("#cms-connected-sites")).toBeVisible();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.getByRole("button", { name: "Il sito ha Histeon? Collegalo" }).click();
  await expect(page.getByRole("heading", { name: "Collega un sito Histeon WordPress" })).toBeFocused();

  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await expect(page.getByRole("heading", { name: "Da dove partiamo?" })).toBeVisible();
  const retainedToken = await page.evaluate(() => sessionStorage.getItem("histos-publish-session"));
  expect(retainedToken).toBe((await readState()).token);

  await page.goto((await readState()).baseUrl);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("histos-publish-session"))).toBe(retainedToken);
  expect(await page.evaluate(() => window.location.hash)).toBe("");
});

test("chiede il consenso prima di rilevare un URL remoto", async ({ page }) => {
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.getByLabel("Indirizzo del sito").fill("https://example.test");
  await page.getByRole("button", { name: "Riconosci sorgente" }).click();
  await expect(page.getByRole("heading", { name: "Prima di leggere il sito" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Autorizzo e continuo" })).toBeVisible();
  await expect(page.getByText("https://example.test", { exact: false })).toBeVisible();
});

test("importa e rimuove la CA FTPS nella configurazione della destinazione", async ({ page }) => {
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><title>CA FTPS</title></head><body><h1>Test CA</h1></body></html>"),
  });
  await page.getByLabel("Nome del sito").fill("Sito CA FTPS");
  await page.getByLabel("Nome Worker").fill("sito-ca-ftps");
  await page.getByRole("button", { name: "Aggiungi sito →" }).click();
  await expect(page.getByRole("heading", { name: "Sito CA FTPS" })).toBeVisible();
  await page.locator("#deploy-target").selectOption("ftp");
  await page.locator("#hosting-protocol").selectOption("ftps");
  await page.locator("#hosting-tls-ca").setInputFiles(path.resolve("scripts/fixtures/certs/ftps-test-cert.pem"));
  await expect(page.getByText("ftps-test-cert.pem", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Rimuovi CA personalizzata" }).click();
  await expect(page.getByText("ftps-test-cert.pem", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Usala solo se il provider ti ha fornito una CA privata.", { exact: false })).toBeVisible();
});

test("verifica e conserva la CA FTPS nella configurazione del sito", async ({ page }) => {
  const { startLocalFtpServer } = await import("../../scripts/fixtures/local-ftp-server.mjs");
  const localFtps = await startLocalFtpServer({ secure: true });
  try {
    await page.getByRole("button", { name: "Nuovo sito" }).first().click();
    await page.locator("#file-html").setInputFiles({
      name: "index.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><title>FTPS salvato</title></head><body><h1>Test</h1></body></html>"),
    });
    await page.getByLabel("Nome del sito").fill("Configurazione FTPS persistente");
    await page.getByLabel("Nome Worker").fill("configurazione-ftps-persistente");
    await page.getByRole("button", { name: "Aggiungi sito →" }).click();
    await expect(page.getByRole("heading", { name: "Configurazione FTPS persistente" })).toBeVisible();
    await page.locator("#deploy-target").selectOption("ftp");
    await page.locator("#hosting-protocol").selectOption("ftps");
    await page.locator("#hosting-host").fill(localFtps.host);
    await page.locator("#hosting-port").fill(String(localFtps.port));
    await page.locator("#hosting-directory").fill("/public/site");
    await page.locator("#hosting-user").fill("publisher");
    await page.locator("#hosting-password").fill("local-only-password");
    await page.locator("#hosting-tls-ca").setInputFiles(path.resolve("scripts/fixtures/certs/ftps-test-cert.pem"));

    await page.getByRole("button", { name: "Verifica e salva la destinazione →" }).click();
    await expect(page.getByText("Connessione hosting verificata e destinazione salvata.", { exact: true })).toBeVisible();
    expect(localFtps.state.authenticatedUsers).toEqual(["publisher"]);

    await page.getByRole("button", { name: /Indietro/ }).click();
    const card = page.locator(".site-card").filter({ hasText: "Configurazione FTPS persistente" });
    await card.getByRole("button", { name: /Apri/ }).click();
    await expect(page.getByText("CA già salvata nel progetto.", { exact: false })).toBeVisible();
  } finally {
    await localFtps.close();
  }
});

test("importa, crea la build, mostra l’anteprima e pubblica solo sul mock", async ({ page }) => {
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><meta charset=\"utf-8\"><title>Pagina prova</title></head><body><h1>Contenuto locale</h1><p>Una copia di test.</p></body></html>"),
  });
  await page.getByLabel("Nome del sito").fill("Sito demo");
  await page.getByLabel("Nome Worker").fill("sito-demo");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Sito demo" })).toBeVisible();
  await expectScreenFitsSupportedWidths(page);

  await page.locator(".site-heading").getByRole("button", { name: /Prepara il sito/ }).click();
  await expect(page.getByText("Pronta", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.locator(".build-card-footer").getByRole("button", { name: /Apri report/ }).click();
  await expect(page.getByRole("heading", { name: "Report della versione" })).toBeVisible();
  await expectScreenFitsSupportedWidths(page);
  await page.getByRole("button", { name: /Torna al sito/ }).click();
  await page.locator(".build-card-footer").getByRole("button", { name: "Anteprima isolata" }).click();
  const preview = page.frameLocator("iframe");
  await expect(preview.locator("h1")).toHaveText("Contenuto locale");
  await expectScreenFitsSupportedWidths(page);

  await page.getByRole("button", { name: "Torna al sito" }).click();
  const zipPromise = page.waitForEvent("download");
  await page.locator(".build-card-footer").getByRole("button", { name: "Scarica ZIP" }).click();
  const archive = await zipPromise;
  expect(archive.suggestedFilename()).toContain("Sito-demo");

  await page.getByRole("button", { name: /Prepara e pubblica/ }).click();
  await confirmPublish(page);
  await expect(page.getByText("Sito pronto e pubblicata su Cloudflare.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "https://sito-demo.account-finto.workers.dev ↗" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Controllo del sito pubblicato" })).toBeVisible();
  await expect(page.locator(".publish-health")).toContainText("Il server invia la home come allegato");

  await page.getByRole("button", { name: "Vedi storico →" }).click();
  await expect(page.getByRole("heading", { name: "Storico" })).toBeVisible();
  await expectScreenFitsSupportedWidths(page);
  await page.getByRole("button", { name: "Aggiorna storico remoto ↻" }).click();
  await expect(page.getByText(/Deployment ·/).first()).toBeVisible();
  await page.getByRole("button", { name: /Ripristina questa versione/ }).first().click();
  await expect(page.getByRole("heading", { name: "Conferma ripristino" })).toBeVisible();
  await expectDialogFitsMobile(page, page.getByRole("dialog", { name: "Conferma ripristino" }));
  await page.getByRole("button", { name: "Conferma ripristino" }).last().click();
  await expect(page.getByText("Ripristino richiesto a Cloudflare.")).toBeVisible();

  await page.getByRole("button", { name: "← Indietro" }).click();
  // Voce 230: «Collega anche www» only for the zone's main domain (or its www), never for a subdomain.
  await page.getByLabel("Dominio pubblico").fill("blog.example.test");
  await expect(page.getByLabel(/Collega anche www/)).toHaveCount(0);
  await page.getByLabel("Dominio pubblico").fill("example.test");
  await expect(page.getByLabel(/Collega anche www/)).toBeChecked();
  await page.getByLabel("Dominio pubblico").fill("www.example.test");
  await page.getByRole("button", { name: "Collega dominio" }).click();
  await expect(page.getByRole("heading", { name: "Collega il dominio" })).toBeVisible();
  await expectDialogFitsMobile(page, page.getByRole("dialog", { name: "Collega il dominio" }));
  await expect(page.locator(".domain-hostnames").getByText("example.test", { exact: true })).toBeVisible();
  await expect(page.locator(".domain-hostnames").getByText("www.example.test", { exact: true })).toBeVisible();
  await expect(page.getByText("Ho trovato voci CNAME da sostituire")).toBeVisible();
  await expect(page.locator(".domain-modal ul li").filter({ hasText: "www.example.test" })).toContainText("example.test");
  await page.getByRole("button", { name: "Sostituisci e collega →" }).click();
  await expect(page.getByRole("link", { name: "https://example.test ↗" })).toBeVisible();

  await page.getByRole("button", { name: /Prepara e pubblica/ }).click();
  await confirmPublish(page);
  await expect(page.getByText("Sito pronto e pubblicata su Cloudflare.")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".publish-health a")).toHaveAttribute("href", "https://example.test");
});

test("crea e pubblica con un clic senza una build preparata prima", async ({ page }) => {
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><title>Pronto</title></head><body><h1>Pubblicato in un clic</h1></body></html>"),
  });
  await page.getByLabel("Nome del sito").fill("Primo clic");
  await page.getByLabel("Nome Worker").fill("primo-clic");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Primo clic" })).toBeVisible();

  // E6: the build is made, then a summary waits for the confirmation; nothing reached Cloudflare before it.
  const state = await readState();
  await page.getByRole("button", { name: /Prepara e pubblica/ }).click();
  const summary = page.getByTestId("site-deploy-summary");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).toContainText("Cloudflare · primo-clic");
  await expect(summary).toContainText("contatta Cloudflare e pubblica davvero");
  const before = await (await fetch(`${mockHttpUrl(state)}/__state`)).json() as { scripts: Record<string, unknown> };
  expect(Object.keys(before.scripts)).not.toContain("primo-clic");
  await confirmPublish(page);
  await expect(page.getByText("Sito pronto e pubblicata su Cloudflare.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "https://primo-clic.account-finto.workers.dev ↗" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Controllo del sito pubblicato" })).toBeVisible();
  await expect(page.locator(".publish-health")).toContainText("Il server invia la home come allegato");
});

test("ferma la pubblicazione se la nuova build è bloccata", async ({ page }) => {
  const state = await readState();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from('<!doctype html><html><body><script>window.wpApiSettings = { "nonce": "0123456789" };</script></body></html>'),
  });
  await page.getByLabel("Nome del sito").fill("Bloccato");
  await page.getByLabel("Nome Worker").fill("bloccato");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Bloccato" })).toBeVisible();

  await page.getByRole("button", { name: /Prepara e pubblica/ }).click();
  await expect(page.getByRole("heading", { name: "Report della versione" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Non è stato inviato nulla a Cloudflare/)).toBeVisible();
  const mockState = await (await fetch(`${mockHttpUrl(state)}/__state`)).json() as { scripts: Record<string, unknown> };
  expect(Object.keys(mockState.scripts)).toHaveLength(0);
});

test("una pubblicazione non riuscita dice perché e in che fase, nell'avviso e nello Storico (voce 228)", async ({ page }) => {
  const state = await readState();
  await fetch(`${mockHttpUrl(state)}/__fail-next`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "POST", path: "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workers/scripts/fallita/versions", status: 400, message: "Versione rifiutata per prova." }),
  });
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><title>Fallita</title></head><body><h1>Non pubblicata</h1></body></html>"),
  });
  await page.getByLabel("Nome del sito").fill("Fallita");
  await page.getByLabel("Nome Worker").fill("fallita");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Fallita" })).toBeVisible();

  await page.getByRole("button", { name: /Prepara e pubblica/ }).click();
  await confirmPublish(page);
  const reason = "Fermata alla fase versione: Cloudflare ha risposto 400: Versione rifiutata per prova.";
  await expect(page.locator(".error-toast")).toContainText(reason, { timeout: 30_000 });
  await expect(page.locator(".inline-status-detail")).toHaveText(reason);
  await expect(page.getByText("Sito pronto e pubblicata su Cloudflare.")).toHaveCount(0);

  await page.getByRole("button", { name: "Vedi storico →" }).click();
  await expect(page.getByRole("heading", { name: "Storico" })).toBeVisible();
  await expect(page.locator(".history-error")).toHaveText(reason);
});

test("verifica una connessione database, nasconde i segreti e chiede conferma prima di rimuoverla", async ({ page }) => {
  let profile: Record<string, unknown> | null = null;
  let profileSshTunnel: Record<string, unknown> | null = null;
  let probeCount = 0;
  let deleteCount = 0;
  const safeProfile = (checkedAt: string, name = "Database hosting demo") => ({
    id: "11111111-1111-4111-8111-111111111111",
    name,
    host: "db.example.test",
    port: 3306,
    databaseName: "demo_db",
    tablePrefix: "wp_demo_",
    engine: "mariadb",
    serverVersion: "11.4.9-MariaDB",
    serverComment: "MariaDB Server",
    characterSet: "utf8mb4",
    collation: "utf8mb4_unicode_ci",
    tableCount: 3,
    prefixTableCount: 2,
    privilegesVerified: true,
    grantedPrivileges: ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "INSERT", "SELECT", "UPDATE"],
    missingPrivileges: [],
    createdAt: "2026-10-23T10:00:00.000Z",
    checkedAt,
    ...(profileSshTunnel ? { sshTunnel: profileSshTunnel } : {}),
  });

  await page.route("**/api/database-connections**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/database-connections/ssh-hostkey") {
      expect(request.postDataJSON()).toEqual({ host: "ssh.example.test", port: 22 });
      await route.fulfill({ json: { hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/database-connections") {
      await route.fulfill({ json: { connections: profile ? [profile] : [] } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/database-connections") {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ host: "db.example.test", port: 3306, databaseName: "demo_db", tablePrefix: "wp_demo_", username: "wp_probe", password: "password-di-prova" });
      expect(body.sshTunnel).toMatchObject({ host: "ssh.example.test", port: 22, username: "tunnel-user", authMethod: "password", password: "ssh-password-di-prova", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
      profileSshTunnel = { host: "ssh.example.test", port: 22, username: "tunnel-user", authMethod: "password", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
      profile = safeProfile("2026-10-23T10:00:00.000Z", String(body.name));
      await route.fulfill({ status: 201, json: { connection: profile } });
      return;
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ username: "wp_probe_updated", password: "password-aggiornata" });
      expect(body.sshTunnel).toMatchObject({ password: "ssh-password-aggiornata", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
      profile = safeProfile("2026-10-23T10:03:00.000Z", String(body.name));
      await route.fulfill({ json: { connection: profile } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/probe")) {
      probeCount += 1;
      profile = safeProfile("2026-10-23T10:05:00.000Z");
      await route.fulfill({ json: { connection: profile } });
      return;
    }
    if (request.method() === "DELETE") {
      deleteCount += 1;
      profile = null;
      await route.fulfill({ json: { removed: true } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Richiesta di test non prevista." } });
  });

  await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
  await page.locator(".settings-tabs").getByRole("button", { name: "MySQL / MariaDB" }).click();
  await expect(page.getByRole("heading", { name: "MySQL / MariaDB" })).toBeVisible();
  await expect(page.getByText("Questa verifica è di sola lettura", { exact: false })).toBeVisible();
  await page.getByLabel("Nome della connessione").fill("Database hosting demo");
  await page.getByLabel("Host del database").fill("db.example.test");
  await page.getByLabel("Porta").fill("3306");
  await page.getByLabel("Nome database").fill("demo_db");
  await page.getByLabel("Prefisso tabelle WordPress").fill("wp_demo_");
  await page.getByLabel("Utente database").fill("wp_probe");
  await page.getByLabel("Password database").fill("password-di-prova");
  await page.getByLabel("Raggiungi il database tramite un tunnel SSH").check();
  await page.getByLabel("Host SSH").fill("ssh.example.test");
  await page.getByLabel("Porta SSH").fill("22");
  await page.getByLabel("Utente SSH").fill("tunnel-user");
  await page.getByLabel("Password SSH").fill("ssh-password-di-prova");
  await page.getByRole("button", { name: "Rileva la chiave host" }).click();
  const sshFingerprint = page.getByText("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { exact: true });
  await expect(sshFingerprint).toBeVisible();
  await page.getByLabel(/Confermo che l’impronta del server SSH è corretta/).check();
  await page.getByRole("button", { name: "Verifica e salva" }).click();
  await expect(page.getByRole("status").getByText("Connessione verificata e salvata nel portachiavi.")).toBeVisible();
  await expect(page.locator(".database-connection-row")).toContainText("2");
  await expect(page.getByLabel("Utente database")).toHaveValue("");
  await expect(page.getByLabel("Password database")).toHaveValue("");
  await expect(page.getByLabel("Password SSH")).toHaveValue("");
  await expect(page.locator(".database-connection-row")).toContainText("Tunnel SSH");

  const row = page.locator(".database-connection-row");
  await row.getByRole("button", { name: "Modifica" }).click();
  await expect(page.getByText("Per aggiornare il profilo", { exact: false })).toBeVisible();
  await page.getByLabel("Utente database").fill("wp_probe_updated");
  await page.getByLabel("Password database").fill("password-aggiornata");
  await page.getByLabel("Password SSH").fill("ssh-password-aggiornata");
  await page.getByRole("button", { name: "Verifica e aggiorna" }).click();
  await expect(page.getByRole("status").getByText("Connessione verificata e aggiornata nel portachiavi.")).toBeVisible();
  await expect(row).toContainText("Database hosting demo");
  await expect(page.getByLabel("Utente database")).toHaveValue("");

  await row.getByRole("button", { name: "Ricontrolla" }).click();
  await expect(row).toContainText("11.4.9-MariaDB");
  expect(probeCount).toBe(1);

  await row.getByRole("button", { name: "Rimuovi connessione" }).click();
  const dialog = page.getByRole("dialog", { name: "Rimuovere questa connessione?" });
  await expect(dialog).toBeVisible();
  await expectDialogFitsMobile(page, dialog);
  await expect(dialog).toContainText("Database hosting demo");
  expect(deleteCount).toBe(0);
  await dialog.getByRole("button", { name: "Annulla" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toBeVisible();
  // The notices of the steps above sit over the row, and they stay while the mouse is on them.
  await page.mouse.move(0, 0);
  await expect(page.getByRole("region", { name: "Avvisi" }).locator(".toast")).toHaveCount(0);

  await row.getByRole("button", { name: "Rimuovi connessione" }).click();
  await page.getByRole("dialog", { name: "Rimuovere questa connessione?" }).getByRole("button", { name: "Rimuovi connessione →" }).click();
  await expect(page.locator(".database-connection-row")).toHaveCount(0);
  await expect(page.getByText("Nessuna connessione salvata.")).toBeVisible();
  expect(deleteCount).toBe(1);
});

test("dal progetto CMS apre il preflight WordPress nella stessa schermata e preseleziona la nuova destinazione", async ({ page }) => {
  const state = await readState();
  const siteName = "Preflight WordPress UI";
  const created = await page.evaluate(async ({ token, siteName }) => {
    const response = await fetch("/api/sites", {
      method: "POST",
      headers: { "X-Histos-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: siteName, source: { kind: "directory", path: "/tmp/preflight-wordpress" } }),
    });
    return { status: response.status, body: await response.json() as { site?: { id: string } } };
  }, { token: state.token, siteName });
  expect(created.status).toBe(201);
  const siteId = created.body.site?.id;
  expect(siteId).toBeTruthy();
  const projectName = "Progetto CMS preflight WordPress";
  const projectResponse = await fetch(new URL("/api/cms/v1/projects", state.baseUrl), {
    method: "POST",
    headers: { Origin: state.baseUrl, "X-Histos-Token": state.token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: projectName }),
  });
  expect(projectResponse.status, await projectResponse.clone().text()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  expect(project.id).toMatch(/^[0-9a-f-]{36}$/u);
  const databaseId = "22222222-2222-4222-8222-222222222222";
  let preflightRequest: Record<string, unknown> | null = null;
  let runtimeRequest: Record<string, unknown> | null = null;
  let provisionRequest: Record<string, unknown> | null = null;
  let provisionPlan: Record<string, unknown> | null = null;
  let provisionInstalled = false;

  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { sites: Array<Record<string, unknown>> };
    payload.sites = payload.sites.map((site) => site.id === siteId ? {
      ...site,
      deployTarget: "ftp",
      hosting: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/preflight", publicUrl: "https://preflight.example.test", username: "publisher" },
      hostingCredentialsConfigured: true,
    } : site);
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/database-connections", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { connections: [{
      id: databaseId,
      name: "Database vuoto di prova",
      host: "db.example.test",
      port: 3306,
      databaseName: "wp_demo",
      tablePrefix: "wp_",
      engine: "mariadb",
      serverVersion: "11.4.9-MariaDB",
      serverComment: "MariaDB Server",
      characterSet: "utf8mb4",
      collation: "utf8mb4_unicode_ci",
      tableCount: 0,
      prefixTableCount: 0,
      privilegesVerified: true,
      grantedPrivileges: ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "INSERT", "SELECT", "UPDATE"],
      missingPrivileges: [],
      createdAt: "2026-10-23T10:00:00.000Z",
      checkedAt: "2026-10-23T10:00:00.000Z",
    }] } });
  });
  await page.route("**/api/cms/v1/connections", async (route) => {
    if (route.request().method() !== "GET" || !provisionInstalled) return route.continue();
    await route.fulfill({ json: { connections: [{
      id: "44444444-4444-4444-8444-444444444444",
      url: "https://preflight.example.test",
      siteId,
      projectId: null,
      projectName: siteName,
      profile: "histos-static-project-v3",
      read: true,
      write: true,
      publish: true,
      connectedAt: "2026-10-24T10:01:00.000Z",
      lastCheckedAt: "2026-10-24T10:01:00.000Z",
      lastSyncedAt: null,
    }] } });
  });
  await page.route(`**/api/sites/${siteId}/hosting/wordpress-preflight`, async (route) => {
    preflightRequest = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: {
      status: "awaiting-php-check",
      canInstall: false,
      filesystem: { readable: true, empty: true, entryCount: 0, wordpressSignals: [] },
      database: { id: databaseId, name: "Database vuoto di prova", engine: "mariadb", serverVersion: "11.4.9-MariaDB", versionSupported: true, tableCount: 0, prefixTableCount: 0, empty: true, privilegesVerified: true, grantedPrivileges: [], missingPrivileges: [] },
      runtime: { phpChecked: false, phpSupported: false, phpRecommended: false, missingRequiredExtensions: [], missingRecommendedExtensions: [], httpsAvailable: false, httpsConfigured: true, wordpressMinimumPhp: ">= 7.4", requiredPhp: ">= 8.3", recommendedPhp: ">= 8.4", status: "not-checked" },
    } });
  });
  await page.route(`**/api/sites/${siteId}/hosting/wordpress-runtime-check`, async (route) => {
    runtimeRequest = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: {
      status: "ready-for-install",
      canInstall: false,
      filesystem: { readable: true, empty: true, entryCount: 0, wordpressSignals: [] },
      database: { id: databaseId, name: "Database vuoto di prova", engine: "mariadb", serverVersion: "11.4.9-MariaDB", versionSupported: true, tableCount: 0, prefixTableCount: 0, empty: true, privilegesVerified: true, grantedPrivileges: [], missingPrivileges: [] },
      runtime: { phpChecked: true, phpVersion: "8.3.12", phpSupported: true, phpRecommended: false, missingRequiredExtensions: [], missingRecommendedExtensions: [], databaseTlsVerified: true, databaseTlsFailure: null, httpsAvailable: true, httpsConfigured: true, wordpressMinimumPhp: ">= 7.4", requiredPhp: ">= 8.3", recommendedPhp: ">= 8.4", status: "supported" },
    } });
  });
  await page.route(`**/api/sites/${siteId}/hosting/wordpress-install`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { plans: provisionPlan ? [provisionPlan] : [] } });
    provisionRequest = route.request().postDataJSON() as Record<string, unknown>;
    provisionPlan = {
      id: "33333333-3333-4333-8333-333333333333", siteId, state: "planned", phase: "planned",
      createdAt: "2026-10-24T10:00:00.000Z", updatedAt: "2026-10-24T10:00:00.000Z", expiresAt: "2026-10-24T11:00:00.000Z", errorCode: null,
      target: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/preflight", publicUrl: "https://preflight.example.test" },
      database: { name: "Database vuoto di prova", host: "db.example.test", port: 3306, databaseName: "wp_demo", tablePrefix: "wp_", engine: "mariadb", serverVersion: "11.4.9-MariaDB" },
      siteTitle: "Sito WordPress di prova", adminUsername: "histos-admin", adminEmail: "admin@example.test",
      wordpress: { version: "7.1.3", phpMinimum: "8.3", mysqlMinimum: "8.0", fileCount: 1600, bytes: 30_000_000, archiveSha256: "a".repeat(64) },
      histos: { version: "0.3.1", wordpressMinimum: "6.9", phpMinimum: "8.3", fileCount: 220, bytes: 4_000_000, archiveSha256: "b".repeat(64) },
      result: null,
    };
    await route.fulfill({ json: { plan: provisionPlan } });
  });
  await page.route(`**/api/sites/${siteId}/hosting/wordpress-install/33333333-3333-4333-8333-333333333333/apply`, async (route) => {
    provisionInstalled = true;
    provisionPlan = {
      ...provisionPlan,
      state: "complete",
      phase: "complete",
      updatedAt: "2026-10-24T10:01:00.000Z",
      result: { wordpressVersion: "7.1.3", histosVersion: "0.3.1", connectionId: "44444444-4444-4444-8444-444444444444", siteUrl: "https://preflight.example.test" },
    };
    await route.fulfill({ json: { plan: provisionPlan } });
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await openProjectTab(page, "Pubblica");
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await page.locator("#cms-deploy-destination").selectOption(`wordpress-new:${siteId}`);
  await page.getByRole("button", { name: "Configura nuovo WordPress" }).click();
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Configura WordPress per ${projectName}` })).toBeVisible();
  await expect(page.getByText(/ftp\.example\.test:21 · \/public_html\/preflight/u)).toBeVisible();
  await expectScreenFitsSupportedWidths(page);
  await page.getByRole("button", { name: "Verifica database e cartella" }).click();
  await expect(page.getByText("File e database verificati")).toBeVisible();
  await expect(page.getByText(/PHP non ancora verificato/)).toBeVisible();
  await expect(page.getByRole("status").getByText(/non installa WordPress/)).toBeVisible();
  expect(preflightRequest).toEqual({ databaseConnectionId: databaseId });
  await page.getByRole("button", { name: "Verifica PHP, HTTPS e database" }).click();
  await expect(page.getByText("Prerequisiti superati; installazione non avviata")).toBeVisible();
  await expect(page.getByText(/PHP 8\.3\.12 · HTTPS verificato · database TLS verificato/)).toBeVisible();
  expect(runtimeRequest).toEqual({ databaseConnectionId: databaseId });

  await expect(page.getByRole("heading", { name: "Crea WordPress con Histeon" })).toBeVisible();
  await page.getByLabel("Titolo del sito").fill("Sito WordPress di prova");
  await page.getByLabel("Utente amministratore").fill("histos-admin");
  await page.getByLabel("Email amministratore").fill("admin@example.test");
  await page.getByLabel("Password amministratore").fill("Histeon-Provision-Test-Admin-Password-93!");
  await page.getByRole("button", { name: "Prepara il piano d’installazione →" }).click();
  await expect(page.getByText("Piano pronto per la revisione")).toBeVisible();
  await expect(page.locator(".wordpress-provision-plan").getByText(/URL: https:\/\/preflight\.example\.test/u)).toBeVisible();
  expect(provisionRequest).toEqual({
    databaseConnectionId: databaseId,
    siteTitle: "Sito WordPress di prova",
    adminUsername: "histos-admin",
    adminEmail: "admin@example.test",
    adminPassword: expect.any(String),
  });
  await page.getByRole("button", { name: "Installa WordPress e Histeon →" }).click();
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await expect(page.locator("#cms-deploy-destination")).toHaveValue("wordpress:44444444-4444-4444-8444-444444444444");
  await expect(page.getByRole("status").getByText(/Ho selezionato il nuovo sito/u)).toBeVisible();
});

/** E6: a static site goes online only from its publish summary. */
async function confirmPublish(page: import("@playwright/test").Page): Promise<void> {
  const summary = page.getByTestId("site-deploy-summary");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await summary.getByRole("button", { name: /Conferma e pubblica/ }).click();
  await expect(summary).toBeHidden();
}
