import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("l'anteprima di una build CMS mostra le immagini e i link interni restano nell'anteprima", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const imported = await request.post(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { headers: { ...headers, "Content-Type": "text/html" }, data: example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id) });
  expect(imported.status()).toBe(201);
  const built = await request.post(`${env.baseUrl}/api/cms/v1/projects/${id}/build`, { headers: { ...headers, "Content-Type": "application/json" }, data: {} });
  expect(built.status()).toBe(200);
  const { previewUrl } = await built.json() as { previewUrl: string };
  const prefix = new URL(previewUrl).pathname.replace(/index\.html$/u, "");

  await page.goto(previewUrl);
  // Every image, including CSS backgrounds turned into <img> by the site, must really load.
  const images = page.locator("img");
  expect(await images.count()).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  const backgrounds = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("*")].map((element) => getComputedStyle(element).backgroundImage).filter((value) => value.startsWith("url(")));
  for (const background of backgrounds) {
    const address = /url\("?([^")]+)"?\)/u.exec(background)?.[1] ?? "";
    expect((await request.get(address)).status(), address).toBe(200);
  }

  const link = page.locator(`a[href^="${prefix}"]:not([href="${prefix}"])`).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${prefix.replaceAll("/", "\\/")}.+`, "u"));
  await expect(page.locator("body")).not.toContainText("Sessione non valida");
  await expect.poll(async () => page.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
});

test("«Anteprima del sito» apre tutto il sito navigabile, e rifà la build solo quando il progetto è cambiato", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const imported = await request.post(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { headers: { ...headers, "Content-Type": "text/html" }, data: example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id) });
  expect(imported.status()).toBe(201);
  const builds = async () => ((await (await request.get(`${env.baseUrl}/api/cms/v1/projects/${id}/builds`, { headers })).json()) as { builds: Array<{ id: string }> }).builds;

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}`);
  const button = page.getByTestId("cms-site-preview");
  await expect(button).toHaveText("Anteprima");
  // No build yet: the first preview makes one.
  const first = page.context().waitForEvent("page");
  await button.click();
  const site = await first;
  await site.waitForURL(/\/__preview\/[^/]+\/[0-9a-f-]{36}\/index\.html$/u);
  await expect(site.locator("body")).not.toContainText("Anteprima non valida");
  const prefix = new URL(site.url()).pathname.replace(/index\.html$/u, "");
  const link = site.locator(`a[href^="${prefix}"]:not([href="${prefix}"])`).first();
  await link.click();
  await expect(site).toHaveURL(new RegExp(`${prefix.replaceAll("/", "\\/")}.+`, "u"));
  await site.close();
  expect(await builds()).toHaveLength(1);

  // The project as it was: the same build, opened again.
  const again = page.context().waitForEvent("page");
  await button.click();
  await (await again).close();
  expect(await builds(), "an unchanged project is not built again").toHaveLength(1);
});
