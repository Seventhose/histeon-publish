import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

/** The main screens under axe, the rules a screen reader depends on: names, roles, labels, structure, contrast apart (responsive.spec.ts has it). */
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

interface E2EState { baseUrl: string; token: string }
async function state(): Promise<E2EState> {
  return JSON.parse(await readFile(process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json"), "utf8")) as E2EState;
}

async function problems(page: Page): Promise<string[]> {
  // Not as a script tag: the app's own policy refuses inline scripts, as it should.
  await page.evaluate(await readFile(axePath, "utf8"));
  const found = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: unknown[] }> }> }> } }).axe;
    return (await axe.run(document, { runOnly: ["wcag2a", "wcag2aa"], rules: { "color-contrast": { enabled: false } } })).violations;
  });
  return found.flatMap((rule) => rule.nodes.slice(0, 4).map((node) => `${rule.impact} ${rule.id}: ${String(node.target[0]).slice(0, 110)}`));
}

test("le schermate principali non hanno errori per chi usa un lettore di schermo", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  expect((await request.post(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { headers: { ...headers, "Content-Type": "text/html" }, data: example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id) })).status()).toBe(201);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  const report: Record<string, string[]> = { home: await problems(page) };
  await page.goto(`${env.baseUrl}/#/cms/${id}`);
  const admin = page.getByTestId("site-admin");
  await expect(admin.getByRole("heading", { name: "Bacheca" })).toBeVisible();
  report.bacheca = await problems(page);
  for (const section of ["pagine", "impostazioni", "lingue"]) {
    await page.getByTestId(`admin-section-${section}`).click();
    await page.waitForTimeout(300);
    report[section] = await problems(page);
  }
  await page.keyboard.press("Control+k");
  report.ricerca = await problems(page);
  await page.getByTestId("admin-palette-input").fill("antico sogno");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("article-text").locator(".article-text")).toBeVisible();
  report.editor = await problems(page);
  expect(Object.fromEntries(Object.entries(report).filter(([, list]) => list.length))).toEqual({});
});
