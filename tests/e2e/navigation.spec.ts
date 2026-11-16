import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject, openBuilder } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("ogni schermata ha un indirizzo: Indietro, ricarica, titolo, focus e ritorno dal builder (E12)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await expect(page).toHaveTitle("Histeon Publish");

  // "Vai al contenuto" is the first stop of the keyboard and leads to the screen's title.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Vai al contenuto" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "I tuoi siti", level: 1 })).toBeFocused();

  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await expect(page.getByRole("heading", { name: "I tuoi siti", level: 1 })).toBeVisible();
  const name = `Indirizzi ${Date.now()}`;
  await newProject(page, name);
  const heading = page.getByRole("heading", { name, exact: true, level: 1 });
  await expect(page).toHaveURL(/#\/cms\/[0-9a-f-]{36}\/amministra$/u);
  const projectUrl = page.url();
  await expect(page).toHaveTitle(`${name} · Histeon CMS`);
  await expect(heading).toBeFocused();
  // The breadcrumb leads back.
  await expect(page.getByRole("navigation", { name: "Dove sei" })).toContainText(name);

  // Back: «Nuovo sito», where the project was created, then the catalog; Forward: the project again.
  await page.goBack();
  await expect(page).toHaveURL(/#\/nuovo$/u);
  await expect(page.getByPlaceholder("Nome del progetto")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "I tuoi siti", level: 1 })).toBeVisible();
  await page.goForward();
  await expect(page.getByPlaceholder("Nome del progetto")).toBeVisible();
  await page.goForward();
  await expect(heading).toBeVisible();

  // A reload opens the same project.
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(projectUrl);

  // Each section has an address; Back returns to the previous one, a reload keeps it.
  const sections = page.getByRole("navigation", { name: "Sezioni del sito" });
  await expect(page.getByTestId("admin-section-bacheca")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("admin-section-pubblica").click();
  await expect(page).toHaveURL(/#\/cms\/[0-9a-f-]{36}\/amministra\/pubblica$/u);
  await expect(page.getByRole("heading", { name: "Pubblicazione" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bacheca", exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pubblicazione" })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("admin-section-impostazioni").click();
  await expect(page).toHaveURL(/amministra\/impostazioni$/u);
  await expect(page.getByTestId("admin-locale")).toBeVisible();
  // Back: the section before, without reloading.
  await page.goBack();
  await expect(page).toHaveURL(/amministra\/pubblica$/u);
  await expect(page.getByTestId("admin-section-pubblica")).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page).toHaveURL(/amministra\/impostazioni$/u);
  await expect(page.getByTestId("admin-locale")).toBeVisible();
  await expect(sections.getByTestId("admin-section-impostazioni")).toHaveAttribute("aria-current", "page");
  // The header's "Pubblica" opens its section and moves the focus to it.
  await page.getByTestId("admin-publish").click();
  await expect(page.getByRole("heading", { name: "Pubblicazione" })).toBeFocused();
  await expect(page.getByTestId("admin-publish"), "inside its own section the command goes away").toHaveCount(0);
  await page.getByTestId("admin-section-pagine").click();
  await expect(page).toHaveURL(/amministra\/pagine$/u);
  const pagesUrl = page.url();

  // The builder's "←" leads back to the section it was opened from.
  await openBuilder(page, "Home");
  const back = page.getByRole("link", { name: "← Amministrazione" });
  await expect(back).toBeVisible({ timeout: 30_000 });
  await back.click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toBe(pagesUrl);

  // Another screen by address, and an address that leads nowhere goes home.
  await page.goto(`${env.baseUrl}/#/agente`);
  await expect(page.getByRole("heading", { name: "Agente AI", level: 1 })).toBeVisible();
  await expect(page).toHaveTitle("Agente AI · Histeon Publish");
  await page.goto(`${env.baseUrl}/#/cms/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  // The dead address was replaced, not stacked: Back goes to the screen before it, not into a loop.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Agente AI", level: 1 })).toBeVisible();
  // An in-page anchor is not a screen.
  await page.evaluate(() => { window.location.hash = "#sezione"; });
  await expect(page.getByRole("heading", { name: "Agente AI", level: 1 })).toBeVisible();
});

test("le sezioni hanno il loro indirizzo già appena aperto il progetto (E14)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  const name = `Sezioni ${Date.now()}`;
  await newProject(page, name);
  // Before any reload: a section is an address, so a reload keeps it and Back returns from it.
  await page.getByTestId("admin-section-media").click();
  await expect(page).toHaveURL(/amministra\/media$/u);
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("admin-section-media")).toHaveAttribute("aria-current", "page");
});
