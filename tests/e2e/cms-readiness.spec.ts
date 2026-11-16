import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject, openProjectTab, setPageStatus } from "./cms-helpers.js";

/**
 * V1.3 «Pronto per andare online?»: in Pubblica, «Controlla il sito» prepara la versione e dà un verdetto unico con
 * le sezioni. Il server delle prove non ha la finestra nascosta dell'app: l'accessibilità resta «non verificato» e il
 * verdetto non può essere «Pronto».
 */

async function state(): Promise<{ baseUrl: string; token: string }> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as { baseUrl: string; token: string };
}

test("il pannello Pubblica mostra il verdetto e le cinque sezioni del controllo del sito", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, `E2E pronto online ${Date.now()}`);
  await setPageStatus(page, "Home", "Nel sito");
  await openProjectTab(page, "Pubblica");

  const answered = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/admin/site-check") && response.request().method() === "GET");
  await page.locator(".cms-unified-publish").getByTestId("cms-site-check").click();
  const body = await (await answered).json() as { readiness: { verdict: string }; browserAvailable: boolean };
  expect(body.browserAvailable).toBe(false);

  const report = page.getByRole("region", { name: "Pronto per andare online?" });
  await expect(report).toBeVisible();
  const verdict = report.getByTestId("cms-readiness-verdict");
  await expect(verdict).toHaveAttribute("data-verdict", body.readiness.verdict);
  expect(body.readiness.verdict).not.toBe("pronto");
  await expect(verdict).toContainText(body.readiness.verdict === "non-pronto" ? "Non pronto." : "Da guardare.");
  for (const name of ["Collegamenti", "Immagini", "Motori di ricerca", "Peso", "Accessibilità"]) await expect(report).toContainText(name);
  const accessibility = report.getByTestId("cms-readiness-accessibility");
  await expect(accessibility).toContainText("non verificato");
  await expect(accessibility).toContainText("La verifica nel browser c'è nell'app desktop.");
  await expect(accessibility.getByTestId("cms-readiness-verify")).toHaveCount(0);
});
