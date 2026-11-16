import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

/**
 * Doc 18 F0-F1: an HTML page dropped on the CMS catalog becomes a project at once (no site, no build), and in the
 * builder its elements are selected with a click, as in a project written by hand.
 */
test("una pagina HTML trascinata nel catalogo CMS diventa un progetto; nel builder i suoi elementi si selezionano (doc 18 F0-F1)", async ({ page }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const tag = crypto.randomUUID().slice(0, 8);
  const html = await readFile(path.resolve("packages/cms/test/fixtures/import-corpus/landing-bootstrap/index.html"), "utf8");
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: `aurora-${tag}.html`, mimeType: "text/html", buffer: Buffer.from(html) });

  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 30_000 });
  await expect(check).toHaveAttribute("data-outcome", "create");
  await expect(check.getByTestId("cms-conversion-notes")).toBeVisible();
  await expect(check.getByTestId("cms-conversion-selectable")).toContainText(/Elementi selezionabili uno per uno nel builder: (9[5-9]|100)%/u);
  // A new choice converts the same upload again (B3, the structure).
  const structure = check.getByTestId("cms-conversion-structure-apply");
  if (await structure.count()) {
    await check.getByTestId("cms-conversion-structure").locator('input[type="checkbox"]').first().check();
    await structure.click();
    await expect(check).toBeVisible({ timeout: 30_000 });
  }
  // Doc 18 §6.6: the recipes without JavaScript are a choice; on, the notes say what they replaced; off again, as before.
  const recipes = check.getByTestId("cms-conversion-recipes").locator("input");
  await recipes.check();
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("ricette senza JavaScript applicate", { timeout: 30_000 });
  await check.getByTestId("cms-conversion-recipes").locator("input").uncheck();
  await expect(check.getByTestId("cms-conversion-notes")).not.toContainText("ricette senza JavaScript applicate", { timeout: 30_000 });
  // Doc 28: the exact sizes are a choice too, off at first; on, the hand-written sizes become the site's variables.
  const exact = check.getByTestId("cms-conversion-exact").locator("input");
  await expect(exact).not.toBeChecked();
  await expect(exact).toBeEnabled();
  await expect(check.getByTestId("cms-conversion-notes")).not.toContainText("tenute esatte come variabili del sito");
  await exact.check();
  await expect(check.getByTestId("cms-conversion-notes")).toContainText("tenute esatte come variabili del sito", { timeout: 30_000 });
  await expect(check.getByTestId("cms-conversion-exact").locator("input")).toBeChecked();
  await check.getByTestId("cms-conversion-exact").locator("input").uncheck();
  await expect(check.getByTestId("cms-conversion-notes")).not.toContainText("tenute esatte come variabili del sito", { timeout: 30_000 });
  // Doc 18 §9 (F7): the conversion's report downloads as JSON before the import.
  const reportDownload = page.waitForEvent("download");
  await check.getByTestId("cms-conversion-report-download").click();
  expect((await reportDownload).suggestedFilename()).toMatch(/-rapporto\.json$/u);
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name: `aurora-${tag}`, exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  // And the project keeps it, with the conversion's notes, in its history of imports.
  const history = page.getByTestId("cms-import-history");
  await expect(history).toContainText("Rapporti d’importazione conservati nel progetto (1)");
  const keptDownload = page.waitForEvent("download");
  await history.getByRole("button", { name: "Scarica in JSON" }).click();
  expect((await keptDownload).suggestedFilename()).toMatch(/^rapporto-import-[0-9a-f]{8}\.json$/u);

  const projects = (await (await fetch(`${env.baseUrl}/api/cms/v1/projects`, { headers })).json()) as { projects: Array<{ id: string; name: string }> };
  const project = projects.projects.find((item) => item.name === `aurora-${tag}`)!;
  const details = (await (await fetch(`${env.baseUrl}/api/cms/v1/projects/${project.id}`, { headers })).json()) as { pages: Array<{ alias: number; slug: string }> };
  const home = details.pages.find((item) => item.slug === "home") ?? details.pages[0]!;

  // The builder's first-run tour opens 1.2 s after load and covers the canvas: a click after it would never reach the
  // page (the Alt+click below failed this way). This test is someone who has seen it, as cms-helpers.ts openBuilder.
  await page.addInitScript(() => { try { localStorage.setItem("xb-tour-done", "1"); } catch { /* no storage: the tour shows */ } });
  await page.goto(`${env.baseUrl}/cms-editor.html?project=${project.id}&document=${home.alias}`);
  const tree = page.getByRole("tree", { name: "Elementi della pagina" });
  await expect(tree).toContainText("Studio Aurora", { timeout: 30_000 });
  const canvas = page.frameLocator("iframe[data-xb-canvas]");
  // Every one of these is its own element in the canvas: a click selects it in the tree.
  // (An image whose file is not in the upload is dropped today: F2 keeps it.)
  const targets = ["h1", "p.lead", "a.btn-primary", ".card-title", "h2", "footer p"];
  for (const selector of targets) {
    const element = canvas.locator(selector).first();
    await expect(element, selector).toHaveAttribute("data-xb-uid", /\S+/u);
    await element.click();
    const uid = await element.getAttribute("data-xb-uid");
    await expect(tree.getByRole("treeitem", { selected: true }), selector).toHaveCount(1);
    expect(await canvas.locator(`[data-xb-uid="${uid}"]`).count(), selector).toBeGreaterThan(0);
  }
  // «Rendi elemento»: a bold word inside a sentence is text; Alt+click makes it an element with its own class (F5).
  const bold = canvas.locator(".accordion-body strong").first();
  await expect(bold).not.toHaveAttribute("data-xb-uid", /./u);
  await bold.click({ modifiers: ["Alt"] });
  await expect(canvas.locator(".accordion-body strong").first()).toHaveAttribute("class", "accordion-body__strong");
  await expect(canvas.locator(".accordion-body strong").first()).toHaveAttribute("data-xb-uid", /\S+/u);
  await expect(tree.getByRole("treeitem", { selected: true })).toHaveCount(1);
  // The upload is gone from the server once the dialog closed.
  const leftover = await fetch(`${env.baseUrl}/api/imports/${"0".repeat(8)}-0000-4000-8000-000000000000/cms-prototype`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
  expect(leftover.status).toBe(404);
});

/**
 * Doc 27, G3: «Rifinisci i nomi con un modello». The model is a fake OpenAI-compatible server here; the provider is
 * chosen in Agente AI, the checkbox is in the import check, and the prototype changes only with the names applied.
 */
test("un modello propone nomi più chiari; solo quelli applicati entrano nel prototipo (doc 27, G3)", async ({ page }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl, "Content-Type": "application/json" };
  const keys: string[] = [];
  const fake: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      keys.push(String(request.headers.authorization ?? ""));
      const body = JSON.parse(raw) as { response_format: { json_schema: { schema: { properties: { scelte: { items: { properties: { id: { enum: string[] } } } } } } } } };
      const ids = body.response_format.json_schema.schema.properties.scelte.items.properties.id.enum;
      const scelte = [["classe:header__box", "officina__testata"], ["classe:header__link", "officina__marchio"]].filter(([id]) => ids.includes(id as string)).map(([id, valore]) => ({ id, valore }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scelte }) } }] }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  try {
    await page.goto(`${env.baseUrl}/#token=${env.token}`);
    await page.locator(".main-nav").getByRole("button", { name: /Agente AI/u }).click();
    const settings = page.getByTestId("import-refine-settings");
    // The default since the real test (G5) is Claude through the connector; with the connector off it says so.
    await expect(settings.getByLabel(/Claude dal connettore \(consigliato\)/u)).toBeChecked();
    await expect(settings.getByTestId("import-refine-connector-hint")).toContainText("Il connettore è spento");
    await settings.getByLabel(/Modello locale:/u).check();
    await settings.getByLabel("Indirizzo del server").fill(modelUrl);
    await settings.getByLabel("Chiave del server (facoltativa)").fill("chiave-e2e");
    await settings.getByTestId("import-refine-save").click();
    await expect(settings.getByRole("status")).toContainText("salvate");
    await expect(settings).toContainText("Chiave del server nel portachiavi");

    const corpus = "packages/cms/test/fixtures/import-corpus/utility-tailwind";
    const html = (await readFile(path.resolve(corpus, "index.html"), "utf8")).replace(/<link[^>]*tw\.css[^>]*>/u, `<style>${await readFile(path.resolve(corpus, "tw.css"), "utf8")}</style>`);
    await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
    await page.getByTestId("cms-import-input").setInputFiles({ name: `officina-${crypto.randomUUID().slice(0, 8)}.html`, mimeType: "text/html", buffer: Buffer.from(html) });
    const check = page.getByTestId("cms-prototype-check");
    await expect(check).toBeVisible({ timeout: 30_000 });
    const refine = check.getByTestId("cms-conversion-refine");
    await expect(refine).toContainText("Il convertitore ha dato 16 nomi");
    await refine.getByTestId("cms-conversion-refine-toggle").check();
    const table = check.getByTestId("cms-refine-table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(check.getByTestId("cms-refine-summary")).toContainText("Proposte di qwen3-8b (modello locale)");
    expect(keys[0]).toBe("Bearer chiave-e2e");
    // Nothing applied yet: one name kept, one left out, then applied.
    await table.getByRole("checkbox", { name: "Applica officina__marchio al posto di header__link" }).uncheck();
    await check.getByTestId("cms-refine-apply").click();
    await expect(check.getByTestId("cms-refine-applied")).toContainText("1 nome scelto è nel prototipo", { timeout: 30_000 });
    await expect(check.getByTestId("cms-refine-table").locator('tr[data-applied="true"]')).toHaveCount(1);
    // The prototype the dialog would import carries the applied name and not the other.
    const download = page.waitForEvent("download");
    await check.locator("a[download]").click();
    const prototype = await readFile(await (await download).path(), "utf8");
    expect(prototype).toContain("officina__testata");
    expect(prototype).not.toContain("officina__marchio");
    // Back to the converter's names.
    await check.getByRole("button", { name: "Torna ai nomi del convertitore" }).click();
    await expect(check.getByTestId("cms-refine-applied")).toHaveCount(0, { timeout: 30_000 });
    await check.getByRole("button", { name: "Annulla" }).click();
  } finally {
    await fetch(`${env.baseUrl}/api/import-refine`, { method: "PUT", headers, body: JSON.stringify({ provider: "connettore", localUrl: "http://127.0.0.1:18080", localKey: null }) });
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
