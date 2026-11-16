import { expect, type Locator, type Page } from "@playwright/test";

/** «Nuovo sito» holds the form that creates a project; the project then opens on its workspace. */
export async function newProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.getByPlaceholder("Nome del progetto").fill(name);
  await page.getByRole("button", { name: "Crea progetto" }).click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
}

/** From the home «I tuoi siti»: the title of a card opens the project. */
export async function openProject(page: Page, name: string): Promise<void> {
  await page.locator("article.site-card").filter({ hasText: name }).locator(".site-title").click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
}

/** The way back from a project: the button at the top of its sidebar. */
export async function backToSites(page: Page): Promise<void> {
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await expect(page.getByRole("heading", { name: "I tuoi siti", level: 1 })).toBeVisible();
}

/** The project's sections are in its sidebar: shows the one named, e.g. "Pubblica" or "Modelli e parti". */
export async function openProjectTab(page: Page, name: "Pagine" | "Articoli" | "Contenuti" | "Modelli e parti" | "Media" | "Pubblica" | "Impostazioni"): Promise<void> {
  const section = { Pagine: "pagine", Articoli: "articoli", Contenuti: "contenuti", "Modelli e parti": "aspetto", Media: "media", Pubblica: "pubblica", Impostazioni: "impostazioni" }[name];
  await page.getByTestId(`admin-section-${section}`).click();
}

/** «Prepara il sito» is in the header of the Pubblica section. */
export async function prepareSite(page: Page): Promise<void> {
  await openProjectTab(page, "Pubblica");
  await page.locator(".cms-unified-publish").getByRole("button", { name: "Prepara il sito", exact: true }).click();
}

/** A new page from the table of the Pagine section; it opens in the panel beside its row. */
export async function newPage(page: Page, title: string): Promise<void> {
  await openProjectTab(page, "Pagine");
  await page.getByTestId("admin-new").click();
  await page.getByTestId("admin-new-title").fill(title);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("admin-detail-title")).toHaveValue(title);
}

/** The title of a row: a page opens in the panel beside it, a post in the article editor. */
export async function openRow(page: Page, title: string, section: "pagine" | "articoli" = "pagine"): Promise<void> {
  await page.getByTestId(`admin-section-${section}`).click();
  await page.getByTestId("admin-table").locator(".admin-title button").filter({ hasText: title }).first().click();
}

/** The status of a page, from the select of its side panel. */
export async function setPageStatus(page: Page, title: string, status: "Bozza" | "Nel sito"): Promise<void> {
  await openRow(page, title);
  const detail = page.getByTestId("admin-detail");
  await detail.getByLabel("Stato").selectOption({ label: status });
  await expect(detail.locator(".admin-detail-head .admin-state")).toHaveText(status);
}

/** Ticks the rows of the table, which brings up the bar of the bulk actions. */
export async function tickRows(page: Page, titles: string[], section: "pagine" | "articoli" = "pagine"): Promise<void> {
  await page.getByTestId(`admin-section-${section}`).click();
  for (const title of titles) await page.getByRole("checkbox", { name: `Seleziona «${title}»`, exact: true }).check();
}

/** The site's settings hold backup, export and the section library, in «Copie e trasferimento». */
export async function openTransfer(page: Page): Promise<void> {
  await openProjectTab(page, "Impostazioni");
  await expect(page.getByTestId("cms-transfer")).toBeVisible();
}

/** The action of a row that opens it in the builder. */
export function builderButton(page: Page, title: string): Locator {
  return page.getByTestId("admin-table").getByRole("button", { name: `Apri nel builder: ${title}`, exact: true });
}

/** A page or post opens in the builder from its row in the site's administration. */
export async function openBuilder(page: Page, title: string, section: "pagine" | "articoli" = "pagine"): Promise<void> {
  // The builder's first-run tour (builder list 142) opens 1.2 s after load and covers the screen: these tests are someone
  // who has seen it, as its own key in localStorage says.
  await page.addInitScript(() => { try { localStorage.setItem("xb-tour-done", "1"); } catch { /* no storage: the tour shows */ } });
  await page.getByTestId(`admin-section-${section}`).click();
  await builderButton(page, title).click();
}
