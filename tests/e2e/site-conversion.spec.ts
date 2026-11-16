import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectTab } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("un sito statico diventa un progetto Histeon, con controllo, anteprima e aggiornamento (B1)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  const name = `Vetrina ${Date.now()}`;
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Vetrina</title><style>h1{color:#123}</style></head><body><header><nav><a href="#chi">Chi</a></nav></header><main><h1 onclick="x()">Benvenuti</h1><p id="chi">Prezzi {da concordare}</p><iframe src="https://example.org/"></iframe></main></body></html>'),
  });
  await page.getByLabel("Nome del sito").fill(name);
  await page.getByLabel("Nome Worker").fill(`vetrina-${Date.now()}`);
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  // No build yet: nothing to convert.
  await expect(page.getByTestId("site-convert-cms")).toBeDisabled();
  await page.locator(".site-heading").getByRole("button", { name: /Prepara il sito/ }).click();
  await expect(page.getByText("Pronta", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("site-convert-cms").click();
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  await expect(check).toHaveAttribute("data-outcome", "create");
  await expect(check.getByRole("heading", { level: 2 })).toHaveText(`Importare «${name}»?`);
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("<iframe> tolto");
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("gestore di eventi portato nel JavaScript della pagina");
  await expect(check.getByRole("link", { name: "Scarica il prototipo" })).toHaveAttribute("download", /-prototipo\.html$/u);
  const opened = page.context().waitForEvent("page");
  await check.getByTestId("cms-prototype-preview").click();
  const preview = await opened;
  await expect(preview.locator("h1")).toHaveText("Benvenuti");
  await expect(preview.locator("body")).toContainText("Prezzi {da concordare}");
  await preview.close();
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });

  // Converting the same site again updates the same project, and it changes nothing.
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.locator(".site-card").filter({ hasText: name }).getByRole("button", { name: /Apri/ }).click();
  await page.getByTestId("site-convert-cms").click();
  await expect(check).toHaveAttribute("data-outcome", "update", { timeout: 20_000 });
  await expect(check.getByTestId("cms-prototype-changes")).toContainText("Il file non cambia nulla nel progetto.");
  await check.getByRole("button", { name: "Annulla" }).click();
});

test("i Google Fonts del sito si scaricano come media su richiesta, con licenza verificata (B5)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  const name = `Font ${Date.now()}`;
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Font</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap"><style>body{font-family:Inter,sans-serif}</style></head><body><h1>Caratteri</h1></body></html>'),
  });
  await page.getByLabel("Nome del sito").fill(name);
  await page.getByLabel("Nome Worker").fill(`font-${Date.now()}`);
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await page.locator(".site-heading").getByRole("button", { name: /Prepara il sito/ }).click();
  await expect(page.getByText("Pronta", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("site-convert-cms").click();
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("Google Fonts collegati");
  await check.getByTestId("cms-conversion-fonts").click();
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("file di font scaricati come media", { timeout: 20_000 });
  await expect(check.getByTestId("cms-conversion-fonts")).toHaveCount(0);
  await check.getByRole("button", { name: "Annulla" }).click();
});

test("il framework di arrivo: Histeon CSS preselezionato, ACSS o nessuno riconvertono (B4, doc 18 §6.4.1)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  const name = `Colori ${Date.now()}`;
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Colori</title><style>body{font-family:"Inter",sans-serif}.titolo{color:#c83c28;font-size:48px}.nota{color:#c83c28;border-color:#1a5fb4}</style></head><body><main><h1 class="titolo">Colori</h1><p class="nota">Testo</p></main></body></html>'),
  });
  await page.getByLabel("Nome del sito").fill(name);
  await page.getByLabel("Nome Worker").fill(`colori-${Date.now()}`);
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await page.locator(".site-heading").getByRole("button", { name: /Prepara il sito/ }).click();
  await expect(page.getByText("Pronta", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("site-convert-cms").click();
  const check = page.getByTestId("cms-prototype-check");
  const design = check.getByTestId("cms-conversion-design");
  const framework = check.getByTestId("cms-conversion-framework").locator("select");
  await expect(framework).toHaveValue("histos-css");
  await expect(design).toContainText("Convertito con i token di Histeon CSS");
  await expect(design).toContainText("#c83c28");
  await expect(design).toContainText("#1a5fb4");
  await expect(design).toContainText('"Inter",sans-serif');
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("token di Histeon CSS al posto dei valori");
  await framework.selectOption("none");
  await expect(check.getByTestId("cms-conversion-design")).toContainText("Proposta per Histeon CSS", { timeout: 20_000 });
  await expect(check.getByTestId("cms-conversion-framework").locator("select")).toHaveValue("none");
  await check.getByTestId("cms-conversion-framework").locator("select").selectOption("acss");
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("variabili di Automatic.css al posto dei valori", { timeout: 20_000 });
  await check.getByTestId("cms-conversion-framework").locator("select").selectOption("core");
  await expect(check.getByTestId("cms-conversion-framework").locator("select")).toHaveValue("core", { timeout: 20_000 });
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("Core Framework: il prototipo resta senza framework Histeon");
  await check.getByTestId("cms-conversion-framework").locator("select").selectOption("histos-css");
  await expect(check.getByTestId("cms-conversion-design")).toContainText("Convertito con i token di Histeon CSS", { timeout: 20_000 });
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
});

test("testata, piè, schede ed elenchi diventano struttura Histeon solo a richiesta (B3)", async ({ page }) => {
  const env = await state();
  const directory = await mkdtemp(path.join(tmpdir(), "histos-b3-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await mkdir(path.join(directory, "img"));
  for (const index of [1, 2, 3]) await writeFile(path.join(directory, "img", `${index}.png`), Buffer.concat([png, Buffer.from([index])]));
  const header = '<header class="top"><a href="index.html">Studio</a><nav><a href="servizi.html">Servizi</a></nav></header>';
  const footer = '<footer class="bottom"><p>Studio 2026</p></footer>';
  const card = (index: number, title: string) => `<article class="card"><img src="img/${index}.png" alt="${title}"><h3>${title}</h3><p>Su ${title}</p></article>`;
  const html = (title: string, main: string) => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title></head><body>${header}<main>${main}</main>${footer}</body></html>`;
  await writeFile(path.join(directory, "index.html"), html("Home", `<h1>Benvenuti</h1><section>${card(1, "Restauro")}${card(2, "Cornici")}${card(3, "Doratura")}</section>`));
  await writeFile(path.join(directory, "servizi.html"), html("Servizi", "<h1>Servizi</h1>"));
  await writeFile(path.join(directory, "contatti.html"), html("Contatti", "<h1>Contatti</h1>"));
  const name = `Struttura ${Date.now()}`;
  const created = await fetch(new URL("/api/sites", env.baseUrl), {
    method: "POST",
    headers: { Origin: env.baseUrl, "X-Histos-Token": env.token, "Content-Type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", path: directory } }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".site-card").filter({ hasText: name }).getByRole("button", { name: /Apri/ }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await page.locator(".site-heading").getByRole("button", { name: /Prepara il sito/ }).click();
  await expect(page.getByText("Pronta", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("site-convert-cms").click();
  const check = page.getByTestId("cms-prototype-check");
  const structure = check.getByTestId("cms-conversion-structure");
  await expect(structure).toBeVisible({ timeout: 20_000 });
  // Nothing changes before a choice.
  await expect(check.getByTestId("cms-conversion-notes")).not.toContainText("parti di template");
  await expect(structure.getByTestId("cms-conversion-structure-apply")).toBeDisabled();
  await structure.getByRole("checkbox", { name: /Testata e piè di pagina uguali/u }).check();
  await structure.getByRole("checkbox", { name: /blocco ripetuto come componente: card \(3\)/iu }).check();
  await structure.getByRole("checkbox", { name: /elenco come tipo di contenuto con 3 voci/iu }).check();
  await structure.getByTestId("cms-conversion-structure-apply").click();
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("parti di template", { timeout: 20_000 });
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("tipo di contenuto con 3 record");
  await expect(check.getByTestId("cms-conversion-structure").getByRole("checkbox", { name: /elenco come tipo di contenuto/iu })).toBeChecked();
  const opened = page.context().waitForEvent("page");
  await check.getByTestId("cms-prototype-preview").click();
  const preview = await opened;
  await expect(preview.locator("main h3")).toHaveText(["Restauro", "Cornici", "Doratura"]);
  await expect(preview.locator("main img")).toHaveCount(3);
  await expect(preview.locator("header")).toContainText("Studio");
  await preview.close();
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await openProjectTab(page, "Modelli e parti");
  await expect(page.locator(".site-card").filter({ hasText: "site/header" })).toBeVisible();
});
