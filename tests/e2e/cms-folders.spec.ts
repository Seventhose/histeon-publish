import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("progetti CMS: «Seleziona» sceglie con un clic su tutta la scheda ed esce con Esc; le cartelle raggruppano le versioni", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl, "Content-Type": "application/json" };
  const tag = crypto.randomUUID().slice(0, 8);
  const names = [`Proposta 10 ${tag}`, `Proposta 20 ${tag}`, `Proposta 30 ${tag}`];
  for (const name of names) expect((await request.post(`${env.baseUrl}/api/cms/v1/projects`, { headers, data: { name } })).status()).toBe(201);

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const card = (name: string) => page.locator("article.site-card").filter({ has: page.getByRole("button", { name: new RegExp(`^${name}`, "u") }) });
  await expect(card(names[0]!)).toBeVisible();

  // A click on the title picks the card instead of opening the project; Esc leaves the selection.
  await page.getByRole("button", { name: "Seleziona", exact: true }).first().click();
  await card(names[0]!).getByRole("button", { name: new RegExp(`^${names[0]}`, "u") }).click();
  await expect(card(names[0]!).getByRole("checkbox")).toBeChecked();
  await card(names[0]!).click({ position: { x: 10, y: 10 } });
  await expect(card(names[0]!).getByRole("checkbox"), "a second click anywhere takes it back").not.toBeChecked();
  await expect(page.getByRole("heading", { name: "I tuoi siti", exact: true, level: 1 }), "still the catalog, no project opened").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pick-bar")).toHaveCount(0);
  await expect(card(names[0]!).getByRole("checkbox")).toHaveCount(0);

  // Two picked, moved into a new folder.
  await page.getByRole("button", { name: "Seleziona", exact: true }).first().click();
  await card(names[0]!).click();
  await card(names[1]!).click();
  await page.getByTestId("pick-bar").getByRole("button", { name: "Sposta in cartella…" }).click();
  const dialog = page.getByTestId("folder-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Sposta 2 elementi in una cartella");
  await dialog.getByLabel("Nome della cartella").fill(`Proposte ${tag}`);
  await dialog.getByRole("button", { name: "Sposta (2)" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("pick-bar")).toHaveCount(0);
  const folder = page.getByRole("button", { name: new RegExp(`^Apri la cartella «(Proposte|Versioni) ${tag}»`, "u") });
  await expect(folder).toHaveAccessibleName(`Apri la cartella «Proposte ${tag}» (2)`);
  await expect(card(names[0]!)).toHaveCount(0);
  await expect(card(names[2]!)).toBeVisible();

  // Dragged onto the folder card, the third one joins.
  // Only this test's cards on screen: after the other tests the list is long, and a drag across it depends on scrolling.
  await page.getByTestId("home-search").fill(names[2]!);
  await card(names[2]!).dragTo(folder);
  await expect(folder).toHaveAccessibleName(`Apri la cartella «Proposte ${tag}» (3)`);
  await page.getByTestId("home-search").fill("");
  await expect(card(names[2]!)).toHaveCount(0);

  // Inside: the three, a new name, then the folder goes and they are back at the top.
  await folder.click();
  const bar = page.getByTestId("folder-bar");
  await expect(bar.getByRole("heading")).toContainText(`Proposte ${tag}`);
  for (const name of names) await expect(card(name)).toBeVisible();
  await bar.getByRole("button", { name: "Rinomina…" }).click();
  await dialog.getByLabel("Nome della cartella").fill(`Versioni ${tag}`);
  await dialog.getByRole("button", { name: "Rinomina" }).click();
  await expect(bar.getByRole("heading")).toContainText(`Versioni ${tag}`);
  // The right-click menu takes one out.
  await card(names[2]!).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Sposta in cartella…" }).click();
  await dialog.getByRole("radio", { name: /Fuori dalle cartelle/u }).check();
  await dialog.getByRole("button", { name: "Sposta (1)" }).click();
  await expect(card(names[2]!)).toHaveCount(0);
  await bar.getByRole("button", { name: "Elimina la cartella" }).click();
  await expect(bar).toHaveCount(0);
  for (const name of names) await expect(card(name)).toBeVisible();
  const saved = (await (await request.get(`${env.baseUrl}/api/folders`, { headers })).json()) as { folders: Array<{ name: string }> };
  expect(saved.folders.filter((item) => item.name.includes(tag))).toEqual([]);
});

test("progetti CMS: Ctrl+clic sceglie una scheda alla volta (anche per iniziare), Maiusc+clic tutte quelle fino a lì", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl, "Content-Type": "application/json" };
  const tag = crypto.randomUUID().slice(0, 8);
  const ids: string[] = [];
  for (let index = 1; index <= 5; index++) ids.push(((await (await request.post(`${env.baseUrl}/api/cms/v1/projects`, { headers, data: { name: `Variante ${index} ${tag}` } })).json()) as { project: { id: string } }).project.id);
  const folder = ((await (await request.post(`${env.baseUrl}/api/folders`, { headers, data: { kind: "cms", name: `Varianti ${tag}` } })).json()) as { folder: { id: string } }).folder;
  expect((await request.post(`${env.baseUrl}/api/folders/move`, { headers, data: { kind: "cms", ids, folderId: folder.id } })).status()).toBe(200);

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByRole("button", { name: new RegExp(`^Apri la cartella «Varianti ${tag}»`, "u") }).click();
  const cards = page.locator("article.site-card");
  await expect(cards).toHaveCount(5);
  const pickedNames = async () => (await cards.evaluateAll((items) => items.filter((item) => item.querySelector<HTMLInputElement>(".card-pick input")?.checked).map((item) => item.querySelector(".site-title")?.firstChild?.textContent ?? "")));
  const nameAt = async (index: number) => (await cards.nth(index).locator(".site-title").evaluate((title) => title.firstChild?.textContent ?? ""));
  const order = await Promise.all([0, 1, 2, 3, 4].map(nameAt));

  // Ctrl+click on the title starts the selection, without opening the project.
  await cards.nth(1).locator(".site-title").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("pick-bar")).toContainText("1 selezionati");
  expect(await pickedNames()).toEqual([order[1]]);
  // Shift+click: from the last one clicked to this one.
  await cards.nth(3).click({ modifiers: ["Shift"] });
  expect(await pickedNames()).toEqual(order.slice(1, 4));
  // Ctrl+click takes one back; Shift+click from it, upwards, adds the range.
  await cards.nth(2).click({ modifiers: ["ControlOrMeta"] });
  expect(await pickedNames()).toEqual([order[1], order[3]]);
  await cards.nth(0).click({ modifiers: ["Shift"] });
  expect(await pickedNames()).toEqual(order.slice(0, 4));
  expect(await page.evaluate(() => String(window.getSelection() ?? "")), "no text selected by Shift+click").toBe("");
  await expect(page.getByTestId("pick-bar")).toContainText("4 selezionati");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pick-bar")).toHaveCount(0);
  // Shift+click with the selection off starts it with that card alone.
  await cards.nth(4).click({ modifiers: ["Shift"] });
  expect(await pickedNames()).toEqual([order[4]]);
  await page.keyboard.press("Escape");
  expect((await request.delete(`${env.baseUrl}/api/folders/${folder.id}`, { headers })).status()).toBe(200);
});

test("uno stile si porta sui siti di una cartella, vedendo prima cosa cambia", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl, "Content-Type": "application/json" };
  const tag = crypto.randomUUID().slice(0, 8);
  const ids: string[] = [];
  for (const name of [`Stile A ${tag}`, `Stile B ${tag}`]) ids.push(((await (await request.post(`${env.baseUrl}/api/cms/v1/projects`, { headers, data: { name } })).json()) as { project: { id: string } }).project.id);
  const folder = ((await (await request.post(`${env.baseUrl}/api/folders`, { headers, data: { kind: "cms", name: `Stili ${tag}` } })).json()) as { folder?: { id: string }; id?: string });
  await request.post(`${env.baseUrl}/api/folders/move`, { headers, data: { kind: "cms", ids, folderId: folder.folder?.id ?? folder.id } });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.getByRole("button", { name: new RegExp(`^Apri la cartella «Stili ${tag}»`, "u") }).click();
  await page.getByTestId("folder-spread").click();
  await page.getByTestId("spread-from").selectOption(ids[0]!);
  await page.getByTestId("spread-preview").click();
  await expect(page.getByTestId("spread-dialog")).toContainText("Gli altri siti hanno già questo stile.");
  await expect(page.getByTestId("spread-apply")).toBeDisabled();
});

