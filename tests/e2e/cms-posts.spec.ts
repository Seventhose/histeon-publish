import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("pagine e articoli in due schede; gli articoli si filtrano per categoria, parole e stato, all'istante", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const imported = await request.post(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { headers: { ...headers, "Content-Type": "text/html" }, data: example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id) });
  expect(imported.status()).toBe(201);

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}`);
  await expect(page.getByTestId("admin-section-bacheca")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("admin-section-pagine").click();
  const table = page.getByTestId("admin-table");
  await expect(table).toBeVisible();
  await expect(table).not.toContainText("Un antico sogno");

  await page.getByTestId("admin-section-articoli").click();
  await expect(page).toHaveURL(/#\/cms\/[^/]+\/amministra\/articoli$/u);
  const rows = table.locator(".admin-body .admin-row");
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("admin-section-articoli").locator(".admin-badge")).toHaveText("1");
  const terms = page.getByTestId("admin-filter-term");
  await terms.selectOption({ label: "Racconti" });
  await expect(terms.locator("option:checked")).toHaveText("Racconti");
  await expect(table.getByRole("button", { name: /^Un antico sogno/u })).toBeVisible();
  await page.getByTestId("admin-table-search").fill("nessuno");
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".admin-empty")).toContainText("Nessun");
  await page.getByRole("button", { name: "Azzera i filtri" }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("group", { name: "Stato" }).getByRole("button", { name: /^Bozza/u }).click();
  await expect(rows).toHaveCount(0);
});
