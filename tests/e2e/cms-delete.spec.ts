import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("progetti CMS: vanno nel Cestino dal menu del clic destro o selezionandoli, solo incollando il nome di ciascuno; da lì si ripristinano o si eliminano per sempre", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl, "Content-Type": "application/json" };
  const tag = crypto.randomUUID().slice(0, 8);
  const names = [`Da buttare A ${tag}`, `Da buttare B ${tag}`, `Da buttare C ${tag}`];
  for (const name of names) expect((await request.post(`${env.baseUrl}/api/cms/v1/projects`, { headers, data: { name } })).status()).toBe(201);

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const card = (name: string) => page.locator("article.site-card").filter({ has: page.getByRole("button", { name: new RegExp(`^${name}`, "u") }) });
  await expect(card(names[0]!)).toBeVisible();

  // Right click: the card's menu, then the dialog that asks for the exact name.
  await card(names[0]!).click({ button: "right" });
  const menu = page.getByRole("menu", { name: names[0] });
  await expect(menu.getByRole("menuitem", { name: "Apri" })).toBeFocused();
  await menu.getByRole("menuitem", { name: "Sposta nel Cestino…" }).click();
  const dialog = page.getByTestId("delete-dialog");
  const confirm = dialog.getByRole("button", { name: /^Sposta nel Cestino/u });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Nome di conferma per «${names[0]}»`).fill(names[0]!.toLowerCase());
  await expect(confirm, "the name must be exact").toBeDisabled();
  await dialog.getByLabel(`Nome di conferma per «${names[0]}»`).fill(names[0]!);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(card(names[0]!)).toHaveCount(0);

  // «Seleziona»: two at once, each with its own name.
  await page.getByRole("button", { name: "Seleziona", exact: true }).first().click();
  await card(names[1]!).getByRole("checkbox").check();
  await card(names[2]!).getByRole("checkbox").check();
  await expect(page.getByTestId("pick-bar")).toContainText("2 selezionati");
  await page.getByTestId("pick-bar").getByRole("button", { name: "Sposta nel Cestino (2)" }).click();
  await expect(dialog.getByRole("button", { name: "Sposta nel Cestino (2)" })).toBeDisabled();
  await dialog.getByLabel(`Nome di conferma per «${names[1]}»`).fill(names[1]!);
  await expect(dialog.getByRole("button", { name: "Sposta nel Cestino (2)" }), "every name is needed").toBeDisabled();
  await dialog.getByLabel(`Nome di conferma per «${names[2]}»`).fill(names[2]!);
  await dialog.getByRole("button", { name: "Sposta nel Cestino (2)" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(names[1]!)).toHaveCount(0);
  await expect(card(names[2]!)).toHaveCount(0);
  const left = (await (await request.get(`${env.baseUrl}/api/cms/v1/projects`, { headers })).json()) as { projects: Array<{ name: string }> };
  expect(left.projects.map((project) => project.name).filter((name) => name.includes(tag))).toEqual([]);

  // The Cestino has all three: one comes back, one goes for good, the rest with «Svuota il Cestino».
  await page.getByRole("button", { name: /^Cestino/u }).click();
  const bin = page.getByTestId("trash");
  const row = (name: string) => bin.locator("li.trash-row").filter({ hasText: name });
  for (const name of names) await expect(row(name)).toBeVisible();
  await expect(row(names[0]!)).toContainText("si elimina da solo il");
  await row(names[0]!).getByRole("button", { name: "Ripristina" }).click();
  await expect(row(names[0]!)).toHaveCount(0);
  await expect(page.getByText(`«${names[0]}» ripristinato.`)).toBeVisible();

  await row(names[1]!).getByRole("button", { name: "Elimina definitivamente…" }).click();
  await expect(dialog.getByRole("heading")).toHaveText(`Eliminare definitivamente «${names[1]}»?`);
  await expect(dialog.getByRole("button", { name: "Elimina definitivamente (1)" })).toBeDisabled();
  await dialog.getByLabel(`Nome di conferma per «${names[1]}»`).fill(names[1]!);
  await dialog.getByRole("button", { name: "Elimina definitivamente (1)" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(names[1]!)).toHaveCount(0);

  await bin.getByRole("button", { name: "Svuota il Cestino…" }).click();
  for (const name of await dialog.locator(".delete-name code").allTextContents()) await dialog.getByLabel(`Nome di conferma per «${name}»`).fill(name);
  await dialog.getByRole("button", { name: /^Elimina definitivamente/u }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bin).toContainText("Il Cestino è vuoto.");
  const binLeft = (await (await request.get(`${env.baseUrl}/api/trash`, { headers })).json()) as { projects: unknown[]; sites: unknown[] };
  expect(binLeft).toMatchObject({ projects: [], sites: [] });

  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await expect(card(names[0]!), "the restored project is back in the catalog").toBeVisible();
});
