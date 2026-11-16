import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { backToSites, openProjectTab, openRow, prepareSite, tickRows } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("solo tastiera: Importa prototipo si raggiunge con Tab e il dialogo tiene, chiude e restituisce il focus", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const importButton = page.getByRole("button", { name: "Importa un file" });
  await expect(importButton).toBeVisible();

  // Reached with Tab alone, from the top of the page.
  await page.locator("body").focus();
  let reached = false;
  for (let step = 0; step < 60 && !reached; step++) {
    await page.keyboard.press("Tab");
    reached = await importButton.evaluate((element) => element === document.activeElement);
  }
  expect(reached).toBe(true);

  // A first import, then the same file again from the keyboard: the update dialog opens.
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const name = `Tastiera ${id.slice(0, 8)}`;
  const file = { name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) };
  await page.getByTestId("cms-import-input").setInputFiles(file);
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await backToSites(page);
  await importButton.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(file);
  // The check of the same file again: it would update the project, with a backup first.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toHaveAttribute("data-outcome", "update");
  await expect(dialog.getByRole("button", { name: "Annulla" })).toBeFocused();
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(importButton).toBeFocused();
});

test("i controlli ripetuti nelle schede hanno un nome con il contesto", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const name = `Nomi ${id.slice(0, 8)}`;
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) });
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  // The boxes of the rows name their page; the bar of the bulk actions, with the Cestino, comes with the first one ticked.
  await openProjectTab(page, "Pagine");
  await expect(page.locator(".admin-bulk")).toHaveCount(0);
  const box = page.getByRole("checkbox", { name: "Seleziona «Home»", exact: true });
  await expect(box).toBeVisible();
  await tickRows(page, ["Home"]);
  await expect(page.locator(".admin-bulk").getByRole("button", { name: "Sposta nel Cestino" })).toBeVisible();
  await expect(page.getByTestId("admin-table").getByRole("button", { name: "Apri nel builder: Home", exact: true })).toBeVisible();
  await openRow(page, "Home");
  await expect(page.getByRole("textbox", { name: "Titolo della pagina" }).or(page.getByLabel(/Titolo/u).first())).toBeVisible();
});

test("gli avvisi si impilano: i successi si chiudono da soli, gli errori restano, la build offre l'anteprima", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  // The live regions are in the page before any notice, so additions are announced.
  await expect(page.getByRole("region", { name: "Avvisi" }).getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Avvisi" }).getByRole("alert")).toHaveCount(1);

  await page.getByTestId("cms-import-input").setInputFiles({ name: "rotto.xbsite", mimeType: "application/zip", buffer: Buffer.from("non è uno zip") });
  const errors = page.getByRole("region", { name: "Avvisi" }).getByRole("alert");
  await expect(errors.locator(".toast")).toHaveCount(1);

  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const name = `Avvisi ${id.slice(0, 8)}`;
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) });
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  const successes = page.getByRole("region", { name: "Avvisi" }).getByRole("status").locator(".toast");
  await expect(successes.first()).toContainText("Prototipo importato");
  // The new action made the old error stale.
  await expect(errors.locator(".toast")).toHaveCount(0);

  await prepareSite(page);
  const built = successes.filter({ hasText: "Sito pronto" });
  await expect(built).toBeVisible({ timeout: 20_000 });
  await expect(built.getByRole("link", { name: /Apri anteprima/u })).toHaveAttribute("href", /\/__preview\//u);
  expect(await successes.count()).toBeLessThanOrEqual(3);
  await expect(successes).toHaveCount(0, { timeout: 10_000 });
});

test("categorie e tag di un articolo si scelgono senza la modalità «Seleziona» (review E14)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const name = `Termini ${id.slice(0, 8)}`;
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) });
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  // The switch for categories and tags is in the site's settings.
  await openProjectTab(page, "Impostazioni");
  await page.getByRole("button", { name: "Attiva categorie e tag" }).click();
  await expect(page.getByText("Categorie e tag attivati.")).toBeVisible();
  const created = await page.evaluate(async ({ token, projectId }) => {
    const response = await fetch(`/api/cms/v1/projects/${projectId}/taxonomies/category/terms`, { method: "POST", headers: { "X-Histos-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ slug: "storia", label: "Storia" }) });
    return response.status;
  }, { token: env.token, projectId: id });
  expect(created).toBe(201);
  // The article opens in its editor, at an address of its own; nothing has to be ticked to reach its terms.
  await openRow(page, "Un antico sogno", "articoli");
  await expect(page).toHaveURL(/amministra\/articolo-\d+$/u);
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("article-title"), "the reload keeps the article: it is in the address").toHaveValue("Un antico sogno");
  await expect(page.locator(".admin-bulk")).toHaveCount(0);
  const term = page.getByRole("button", { name: "Storia", exact: true });
  await expect(term).toBeVisible();
  await term.click();
  await expect(term).toHaveAttribute("aria-pressed", "true");
});
