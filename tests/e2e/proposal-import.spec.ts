import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

// Voce 2: il file unico di `kit proposte` entra dallo stesso «Importa un file»; si sceglie la proposta del cliente e
// la conversione di sempre la porta al controllo del prototipo.
test("un file di kit proposte: si sceglie la proposta e diventa un progetto Histeon (voce 2)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  // A title of its own, so the project does not collide with what other tests imported.
  const title = `Trattoria ${Date.now()}`;
  const file = (await readFile(path.resolve("packages/cms/test/fixtures/proposte-acss.html"), "utf8")).replace('"titolo":"Trattoria"', `"titolo":"${title}"`);
  await page.getByTestId("cms-import-input").setInputFiles({ name: "proposte.html", mimeType: "text/html", buffer: Buffer.from(file) });

  const pick = page.getByTestId("cms-proposal-pick");
  await expect(pick).toBeVisible({ timeout: 20_000 });
  await expect(pick.getByRole("heading", { level: 2 })).toHaveText("Quale proposta ha scelto il cliente?");
  await expect(pick).toContainText(title);
  const options = pick.getByRole("radio");
  await expect(options).toHaveCount(2);
  await expect(pick.getByRole("radio", { name: /P01 · Brace/u })).toBeChecked();
  await expect(pick).toContainText("Rosso mattone e schede dei piatti");
  await expect(pick).toContainText("Calde");
  // The preview shows the chosen proposal, without running its scripts.
  const preview = pick.getByTestId("cms-proposal-preview");
  await expect(preview).toHaveAttribute("sandbox", "");
  await expect(preview.contentFrame().locator("h1")).toHaveText("Cucina alla brace");
  await pick.getByRole("radio", { name: /P02 · Orto/u }).check();
  await expect(preview.contentFrame().locator("h1")).toHaveText("Dall'orto alla tavola");
  await pick.getByRole("radio", { name: /P01 · Brace/u }).check();
  await pick.getByTestId("cms-proposal-convert").click();

  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 30_000 });
  await expect(pick).toBeHidden();
  await expect(check).toHaveAttribute("data-outcome", "create");
  await expect(check.getByRole("heading", { level: 2 })).toHaveText(`Importare «${title} · Brace»?`);
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("proposta «p01 · Brace»");
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("--text-light-muted");
  // Converting again with another structure keeps the same proposal.
  await check.getByTestId("cms-conversion-structure").getByRole("checkbox").nth(1).uncheck();
  await check.getByTestId("cms-conversion-structure-apply").click();
  await expect(check.getByRole("heading", { level: 2 })).toHaveText(`Importare «${title} · Brace»?`, { timeout: 30_000 });
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("proposta «p01 · Brace»");
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name: `${title} · Brace`, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  expect(pageErrors).toEqual([]);
});

test("chiudere la scelta della proposta non importa niente", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "proposte.html", mimeType: "text/html", buffer: await readFile(path.resolve("packages/cms/test/fixtures/proposte-histeon.html")) });
  const pick = page.getByTestId("cms-proposal-pick");
  await expect(pick).toBeVisible({ timeout: 20_000 });
  // One proposal only: it is already chosen.
  await expect(pick.getByRole("radio", { name: /H01 · Scaffale/u })).toBeChecked();
  await pick.getByRole("button", { name: "Annulla" }).click();
  await expect(pick).toBeHidden();
  await expect(page.getByTestId("cms-prototype-check")).toHaveCount(0);
});
