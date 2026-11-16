import { readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { backToSites, openProjectTab, openTransfer, prepareSite } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string; dataDirectory: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("importa un prototipo Histeon dal catalogo e apre il progetto", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const prototype = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"));
  // A copy with its own id, so the test does not depend on what other tests imported.
  const id = crypto.randomUUID();
  const copy = Buffer.from(prototype.toString("utf8").replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "Galleria ${id.slice(0, 8)}"`));
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: copy });
  // A2: first the check, with a throwaway preview of the site before the project exists.
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  await expect(check).toHaveAttribute("data-outcome", "create");
  await expect(check.getByRole("heading")).toHaveText(`Importare «Galleria ${id.slice(0, 8)}»?`);
  await expect(check).toContainText("2 pagine");
  await expect(check).toContainText("galleria.html");
  const previewLink = check.getByTestId("cms-prototype-preview");
  await expect(previewLink).toHaveAttribute("href", /\/__preview\//u);
  const opened = page.context().waitForEvent("page");
  await previewLink.click();
  const preview = await opened;
  await expect(preview.locator("body")).toContainText("Studio Ehi");
  await preview.close();
  await check.getByTestId("cms-prototype-import").click();
  await expect(check).toBeHidden();
  await expect(page.getByRole("heading", { name: `Galleria ${id.slice(0, 8)}`, exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status").first()).toContainText("Prototipo importato");
  // D1: the import report under the title takes the focus, with every left-out item and the pages to open.
  const report = page.getByTestId("cms-import-report");
  await expect(report).toBeFocused();
  await expect(report).toContainText("Prototipo importato");
  await expect(report).toContainText("galleria.html");
  await expect(report).toContainText("importato da te");
  await expect(report).toContainText("2 pagine");
  await expect(report.getByRole("button", { name: "Apri nel builder: Home", exact: true })).toBeVisible();
  await report.getByTestId("cms-import-report-ignored").locator("summary").click();
  await expect(report.getByTestId("cms-import-report-ignored")).toContainText("script");
  await report.getByRole("button", { name: "Chiudi il rapporto" }).click();
  await expect(report).toBeHidden();
  await openProjectTab(page, "Pagine");
  await expect(page.getByTestId("admin-table")).toContainText("Contatti");
  expect(pageErrors).toEqual([]);
});

test("la build mostra subito il riepilogo sotto il titolo, con l'anteprima e le pagine escluse", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const prototype = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"));
  const id = crypto.randomUUID();
  const name = `Galleria build ${id.slice(0, 8)}`;
  const copy = Buffer.from(prototype.toString("utf8").replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`));
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: copy });
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await prepareSite(page);
  const buildButton = page.locator(".cms-unified-publish").getByRole("button", { name: "Prepara il sito", exact: true });
  const summary = page.getByTestId("cms-build-summary");
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(summary).toContainText("Sito pronto");
  await expect(summary).toContainText("pagine nel sito");
  await expect(summary).toContainText("Escluse perché in bozza: Contatti.");
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: /Apri anteprima/u })).toHaveAttribute("href", /\/__preview\//u);
  // The summary sits right under the title, not thousands of pixels down.
  const offset = await summary.evaluate((element) => element.getBoundingClientRect().top - (document.querySelector("h1")?.getBoundingClientRect().bottom ?? 0));
  expect(offset).toBeLessThan(200);
  await expect(buildButton).toBeEnabled();

  // E9: the catalog card shows the last build, and says when the project changed after it.
  await backToSites(page);
  const card = page.locator(".site-card").filter({ hasText: name });
  await expect(card.getByTestId("cms-card-build")).toHaveText(/^Ultima versione \d/u);
  await page.evaluate(async ({ token, projectId }) => {
    const response = await fetch(`/api/cms/v1/projects/${projectId}/pages`, { method: "POST", headers: { "X-Histos-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Dopo la build" }) });
    if (!response.ok) throw new Error(`pagina non creata: ${response.status}`);
  }, { token: env.token, projectId: id });
  await page.reload();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await expect(card.getByTestId("cms-card-build")).toHaveText(/^Ultima versione .+, prima delle ultime modifiche$/u);
});

test("reimportare lo stesso prototipo: il controllo chiede conferma e salva un backup prima di aggiornare", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const prototype = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"));
  const id = crypto.randomUUID();
  const name = `Galleria aggiornata ${id.slice(0, 8)}`;
  const copy = { name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(prototype.toString("utf8").replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) };
  const importInput = () => page.getByTestId("cms-import-input");
  await importInput().setInputFiles(copy);
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await backToSites(page);

  // Cancelling leaves the project as it is.
  await importInput().setInputFiles(copy);
  const dialog = page.getByTestId("cms-prototype-check");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toHaveAttribute("data-outcome", "update");
  // D2: the same file changes nothing.
  await expect(dialog.getByTestId("cms-prototype-changes")).toContainText("Il file non cambia nulla nel progetto.");
  await expect(dialog).toContainText(`Aggiornare «${name}»?`);
  await expect(dialog).toContainText("salvo un backup");
  await dialog.getByRole("button", { name: "Annulla" }).click();
  await expect(dialog).toBeHidden();

  await importInput().setInputFiles(copy);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: /Salva il backup e aggiorna/u }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("status").first()).toContainText("aggiornato");
  await expect(page.getByRole("status").first()).toContainText("Backup salvato");

  // A new version of the prototype: what changes is listed before anything happens.
  await backToSites(page);
  await importInput().setInputFiles({ ...copy, buffer: Buffer.from(copy.buffer.toString("utf8").replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti, libri, racconti e viaggi.</p>")) });
  const changes = dialog.getByTestId("cms-prototype-changes");
  await expect(changes).toContainText("1 modificati", { timeout: 20_000 });
  await expect(changes.locator('.cms-check-list li[data-status="modified"]')).toContainText("Home");
  await dialog.getByRole("button", { name: "Annulla" }).click();
  await expect(dialog).toBeHidden();
});

test("pubblicare senza vicoli ciechi: sito statico .zip e una destinazione del progetto (E6)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const prototype = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"));
  const id = crypto.randomUUID();
  const name = `Galleria destinazione ${id.slice(0, 8)}`;
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(prototype.toString("utf8").replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) });
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });

  await openProjectTab(page, "Pubblica");
  const ways = page.getByTestId("cms-publish-ways");
  if (!(await ways.isVisible())) await page.getByRole("button", { name: "＋ Altri modi di pubblicare" }).click();
  // The static site as a .zip, with the build made on the way.
  const download = page.waitForEvent("download");
  await ways.getByTestId("cms-way-zip").click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/u);
  // A destination for this project only: no source, no build of its own, a way back.
  await ways.getByTestId("cms-way-hosting").click();
  const card = page.getByTestId("cms-destination-card");
  await expect(card).toContainText(name);
  await expect(page.getByRole("button", { name: /Prepara e pubblica/u })).toHaveCount(0);
  await expect(page.locator(".source-replacement-card")).toHaveCount(0);
  await page.getByTestId("site-open-cms-project").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
});

test("un prototipo scelto in Nuovo sito va al CMS (E9)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  // A finished HTML site is converted at once (cms-direct-import.spec.ts); here, from "Nuovo sito".
  await page.getByRole("button", { name: "I tuoi siti", exact: true }).click();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();

  // In "Nuovo sito" a prototype is recognized and goes to the CMS check instead.
  const prototype = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"));
  const id = crypto.randomUUID();
  const name = `Galleria ingresso ${id.slice(0, 8)}`;
  await page.locator("#file-html").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(prototype.toString("utf8").replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`)) });
  await page.getByTestId("new-site-prototype").getByRole("button", { name: "Importa in Histeon CMS" }).click();
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  // The catalog card says where the project comes from and what it holds.
  await backToSites(page);
  const card = page.locator(".site-card").filter({ hasText: name });
  await expect(card).toContainText("Da un file");
  await expect(card).toContainText("2 pagine · 1 articolo");
});

test("le sezioni del progetto si esportano per la libreria del builder (D5)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const prototype = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const id = crypto.randomUUID();
  const name = `Sezioni ${id.slice(0, 8)}`;
  const withSection = prototype.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`).replace(/(<template data-histos="page" data-slug="home"[^>]*>)/u, '$1<section class="promo"><h2>Promo</h2><p>Testo</p></section>');
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(withSection) });
  await page.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await openTransfer(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Esporta le sezioni (.xblibrary)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-sezioni\.xblibrary$/u);
  const library = JSON.parse(await readFile(await file.path(), "utf8")) as { format: string; version: number; sections: Array<{ name: string }> };
  expect(library).toMatchObject({ format: "xb-library", version: 1 });
  expect(library.sections.some((section) => section.name.endsWith("section.promo"))).toBe(true);
  await expect(page.getByText(/sezion[ei] esportat[ae] per la libreria del builder/u)).toBeVisible();
});

test("un prototipo grande mostra l'avanzamento e «Annulla» lo ferma senza creare nulla (D3)", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const id = crypto.randomUUID();
  const records = Array.from({ length: 6000 }, (_, index) => ({ type: "opera", slug: `opera-${index}`, title: `Opera ${index}`, status: "published", publishedAt: "2026-10-02T09:00:00Z", order: index, values: { prezzo: index } }));
  const content = { types: [{ key: "opera", label: "Opere", fields: [{ key: "prezzo", label: "Prezzo", type: "decimal", required: false, public: true, multiple: false }] }], records };
  const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Grande</title>
<script data-histos="manifest" type="application/json">{"format":"histos-prototype","version":1,"id":"${id}","name":"Grande ${id.slice(0, 8)}","framework":"none","locale":"it-IT"}</script>
<script data-histos="content" type="application/json">${JSON.stringify(content)}</script>
</head><body><template data-histos="page" data-slug="home" data-title="Home"><main><h1>Home</h1></main></template></body></html>`;
  await page.getByTestId("cms-import-input").setInputFiles({ name: "grande.html", mimeType: "text/html", buffer: Buffer.from(html) });
  const progress = page.getByTestId("cms-import-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/Voci: \d+ di 6000|Controllo il prototipo/u);
  await progress.getByRole("button", { name: "Annulla" }).click();
  await expect(page.getByText("Controllo annullato: non è stato scritto nulla.")).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(page.getByTestId("cms-prototype-check")).toHaveCount(0);
  const projects = await page.evaluate(async (token) => (await (await fetch("/api/cms/v1/projects", { headers: { "X-Histos-Token": token } })).json()) as { projects: Array<{ id: string }> }, env.token);
  expect(projects.projects.some((project) => project.id === id)).toBe(false);
});

test("un prototipo con errori li mostra tutti sotto i pulsanti, con la riga, da copiare per l'agente e da ricontrollare (E4, D1)", async ({ page, context }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8")).replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", crypto.randomUUID());
  const broken = prototype.replace("<p>Scrivimi.</p>", '<p onclick="apri()">Scrivimi.</p>\n  <marquee>vecchio</marquee>');
  const brokenLine = broken.split("\n").findIndex((line) => line.includes('onclick="apri()"')) + 1;
  // The desktop app's bridge, as the preload gives it: «Ricontrolla» reads the corrected file from disk.
  await page.addInitScript((fixed: string) => {
    (window as unknown as { histosDesktop: unknown }).histosDesktop = { sandboxFallback: async () => false, canRereadPrototypeFile: () => true, rereadPrototypeFile: async () => new TextEncoder().encode(fixed) };
  }, prototype);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "rotto.html", mimeType: "text/html", buffer: Buffer.from(broken) });
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems).toBeVisible({ timeout: 20_000 });
  await expect(problems).toBeFocused();
  await expect(problems.getByRole("heading")).toHaveText("«rotto.html»: 2 errori da correggere");
  const items = problems.locator("li");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText(`page contatti, riga ${brokenLine}`);
  await expect(items.first()).toContainText("Histeon non importa JavaScript");
  await expect(items.nth(1)).toContainText("marquee");
  // No red notice at the top for the normal correction loop, and no internal id anywhere.
  await expect(page.locator(".error-toast")).toHaveCount(0);
  await expect(problems).not.toContainText("segreto rimosso");
  await problems.getByTestId("cms-prototype-problems-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^Il prototipo «rotto\.html» non passa il controllo di Histeon Publish \(2\):\n1\. page contatti, riga \d+: .*onclick/u);
  expect(copied).toMatch(/hp_check_prototype prima di importarlo\.$/u);
  // «Ricontrolla»: the same file, now corrected, goes to the check without the file chooser.
  await problems.getByTestId("cms-prototype-problems-recheck").click();
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  await expect(problems).toBeHidden();
  // D1: each left-out element with its line in the file.
  await check.locator("summary", { hasText: "ignorat" }).first().click();
  await expect(check).toContainText(/script \(riga \d+\)/u);
  await page.keyboard.press("Escape");
  expect(pageErrors).toEqual([]);
});

/** The example prototype under a fresh id, as it is (`fixed`) and with two problems, an onclick and a marquee. */
async function brokenPrototype(): Promise<{ fixed: string; broken: string }> {
  const fixed = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8")).replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", crypto.randomUUID());
  return { fixed, broken: fixed.replace("<p>Scrivimi.</p>", '<p onclick="apri()">Scrivimi.</p>\n  <marquee>vecchio</marquee>') };
}

const CHECK_REQUEST = /\/api\/cms\/v1\/projects\/import-prototype\?check=1&/u;

test("un prototipo rifiutato si vede anche col catalogo su «Collegati», con il riquadro per sceglierlo di nuovo (E4)", async ({ page }) => {
  const env = await state();
  const { broken } = await brokenPrototype();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const filters = page.locator(".cms-catalog-filters");
  await filters.getByRole("button", { name: /^Collegati/u }).click();
  await expect(page.getByTestId("cms-import-zone")).toHaveCount(0);
  // The filter stays as it was while the user goes to "Nuovo sito" and picks a prototype there.
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({ name: "rotto.html", mimeType: "text/html", buffer: Buffer.from(broken) });
  await page.getByTestId("new-site-prototype").getByRole("button", { name: "Importa in Histeon CMS" }).click();
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems).toBeVisible({ timeout: 20_000 });
  await expect(problems).toBeFocused();
  await expect(problems.getByRole("heading")).toHaveText("«rotto.html»: 2 errori da correggere");
  await expect(filters.getByRole("button", { name: /^Tutti/u })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("cms-import-zone")).toBeVisible();
});

test("«Ricontrolla» c'è solo per un file che l'app desktop può rileggere dal disco (E4)", async ({ page }) => {
  const env = await state();
  const { broken } = await brokenPrototype();
  // The bridge of the desktop app, for a file with no .html path of the user's (dropped without extension).
  await page.addInitScript(() => {
    (window as unknown as { histosDesktop: unknown }).histosDesktop = { sandboxFallback: async () => false, canRereadPrototypeFile: () => false, rereadPrototypeFile: async () => null };
  });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "rotto.html", mimeType: "text/html", buffer: Buffer.from(broken) });
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems).toBeVisible({ timeout: 20_000 });
  await expect(problems.getByTestId("cms-prototype-problems-recheck")).toHaveCount(0);
  await expect(problems).toContainText("Correggili nel file e sceglilo di nuovo.");
  await expect(problems).not.toContainText("Ricontrolla");
});

test("oltre i primi 100 errori il riquadro e il testo per l'agente dicono quanti sono in tutto (E4)", async ({ page, context }) => {
  const env = await state();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { broken } = await brokenPrototype();
  // The server's answer for 150 problems: the first 100 listed, the count of all of them beside.
  const issues = Array.from({ length: 100 }, (_, index) => ({ document: "page home", line: index + 10, message: "L'attributo onclick non è ammesso: Histeon non importa JavaScript." }));
  await page.route(CHECK_REQUEST, (route) => route.fulfill({ status: 422, contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: "Il prototipo ha 150 errori: …", code: "cms-prototype-invalid", issues, issuesTotal: 150 }) }));
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "molti.html", mimeType: "text/html", buffer: Buffer.from(broken) });
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems).toBeVisible({ timeout: 20_000 });
  await expect(problems.getByRole("heading")).toHaveText("«molti.html»: 150 errori da correggere");
  await expect(problems.locator("li")).toHaveCount(100);
  await expect(problems.getByTestId("cms-prototype-problems-more")).toHaveText("… e altri 50: li elenca il prossimo controllo, quando questi sono corretti.");
  await problems.getByTestId("cms-prototype-problems-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^Il prototipo «molti\.html» non passa il controllo di Histeon Publish \(150\):\n1\. page home, riga 10: /u);
  expect(copied).toMatch(/\n100\. page home, riga 109: [^\n]+\n… e altri 50: li elenca il prossimo controllo, quando questi sono corretti\.\nCorreggi tutti gli errori/u);
});

test("«Ricontrolla» annullato o non riuscito lascia la lista e il suo pulsante (E4)", async ({ page }) => {
  const env = await state();
  const { broken } = await brokenPrototype();
  await page.addInitScript((onDisk: string) => {
    (window as unknown as { histosDesktop: unknown }).histosDesktop = { sandboxFallback: async () => false, canRereadPrototypeFile: () => true, rereadPrototypeFile: async () => new TextEncoder().encode(onDisk) };
  }, broken);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "rotto.html", mimeType: "text/html", buffer: Buffer.from(broken) });
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems.locator("li")).toHaveCount(2, { timeout: 20_000 });

  // «Annulla» while the check runs: nothing changed, so the list stays, with «Ricontrolla».
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(CHECK_REQUEST, async (route) => { await held; await route.continue().catch(() => undefined); });
  await problems.getByTestId("cms-prototype-problems-recheck").click();
  const progress = page.getByTestId("cms-import-progress");
  await expect(progress).toBeVisible();
  await expect(problems.locator("li")).toHaveCount(2);
  await progress.getByRole("button", { name: "Annulla" }).click();
  await expect(page.getByText("Controllo annullato: non è stato scritto nulla.")).toBeVisible();
  await expect(problems.locator("li")).toHaveCount(2);
  await expect(problems.getByTestId("cms-prototype-problems-recheck")).toBeEnabled();
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A check that fails for another reason: its error at the top, the list still here.
  await page.route(CHECK_REQUEST, (route) => route.fulfill({ status: 500, contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: "Disco pieno.", code: "error" }) }));
  await problems.getByTestId("cms-prototype-problems-recheck").click();
  await expect(page.getByRole("region", { name: "Avvisi" }).getByRole("alert")).toContainText("Disco pieno.");
  await expect(problems.locator("li")).toHaveCount(2);
  await expect(problems.getByTestId("cms-prototype-problems-recheck")).toBeEnabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("un sito convertito e rifiutato si scarica per correggerlo, senza «Ricontrolla» (E4, B1)", async ({ page }) => {
  const env = await state();
  // Even where the bridge would reread a file: the converted prototype was made in memory, not chosen.
  await page.addInitScript(() => {
    (window as unknown as { histosDesktop: unknown }).histosDesktop = { sandboxFallback: async () => false, canRereadPrototypeFile: () => true, rereadPrototypeFile: async () => null };
  });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  const name = `Rifiutato ${Date.now()}`;
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Rifiutato</title></head><body><main><h1>Rifiutato</h1></main></body></html>') });
  await page.getByLabel("Nome del sito").fill(name);
  await page.getByLabel("Nome Worker").fill(`rifiutato-${Date.now()}`);
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.locator(".site-heading").getByRole("button", { name: /Prepara il sito/ }).click();
  await expect(page.getByText("Pronta", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The check refuses the converted prototype (as for a global sheet over 1 MB).
  await page.route(CHECK_REQUEST, (route) => route.fulfill({ status: 422, contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: "Il foglio globale «s.css» supera 1 MB di CSS: dividilo in più fogli.", code: "cms-prototype-invalid", issues: [{ message: "Il foglio globale «s.css» supera 1 MB di CSS: dividilo in più fogli." }] }) }));
  await page.getByTestId("site-convert-cms").click();
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems).toBeVisible({ timeout: 20_000 });
  await expect(problems).toBeFocused();
  await expect(problems.getByTestId("cms-prototype-problems-recheck")).toHaveCount(0);
  await expect(problems).toContainText("Il prototipo è stato creato dal sito: scaricalo");
  await expect(problems.getByTestId("cms-prototype-problems-download")).toHaveAttribute("download", /-prototipo\.html$/u);
  const download = page.waitForEvent("download");
  await problems.getByTestId("cms-prototype-problems-download").click();
  expect(await readFile(await (await download).path(), "utf8")).toContain('data-histos-prototype="1"');
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("un rifiuto che arriva su un'altra schermata si annuncia e porta alla lista degli errori (E4)", async ({ page }) => {
  const env = await state();
  const { broken } = await brokenPrototype();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(CHECK_REQUEST, async (route) => { await held; await route.continue().catch(() => undefined); });
  await page.getByTestId("cms-import-input").setInputFiles({ name: "rotto.html", mimeType: "text/html", buffer: Buffer.from(broken) });
  await expect(page.getByTestId("cms-import-progress")).toBeVisible();
  // The user moves to another screen while the check runs.
  await page.locator(".main-nav").getByRole("button", { name: "Guida" }).click();
  release();
  const notice = page.getByRole("region", { name: "Avvisi" }).getByRole("alert");
  await expect(notice).toContainText("«rotto.html»: 2 errori da correggere", { timeout: 20_000 });
  await notice.getByRole("button", { name: "Mostra gli errori" }).click();
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems.locator("li")).toHaveCount(2);
  await expect(problems).toBeFocused();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("un aggiornamento il cui backup supererebbe i limiti non si offre, e il dialogo dice perché (D2)", async ({ page }) => {
  const env = await state();
  const { fixed } = await brokenPrototype();
  await page.route(CHECK_REQUEST, (route) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ check: true, valid: true, outcome: "update", existingProject: { id: "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", name: "Galleria" }, report: { project: { id: "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", name: "Galleria" }, counts: { pages: 2 }, downloaded: 0, placeholders: [], ignored: [], warnings: [], forms: [] }, changes: { added: [], modified: [], removed: [], keptLocal: [], conflicts: [], unchanged: 3, omitted: 0, basis: { projectRevision: "r", profileDigest: "d" } }, backupUnavailable: "Il progetto supera il limite di 512 MiB." }) }));
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(fixed) });
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  await expect(check.getByTestId("cms-prototype-no-backup")).toContainText("Il progetto supera il limite di 512 MiB.");
  await expect(check.getByTestId("cms-prototype-import")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("un aggiornamento con media remoti si confronta con i media scaricati, non con i segnaposto (D2)", async ({ page }) => {
  const env = await state();
  const { fixed } = await brokenPrototype();
  const project = { id: "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", name: "Galleria" };
  const report = (placeholders: string[], downloaded: number) => ({ project, counts: { pages: 2, media: 2 }, downloaded, placeholders, ignored: [], warnings: [], forms: [] });
  const asked: Array<string | null> = [];
  // The server's answers: without the media no list of changes, with them the real one (an alt text kept from Publish).
  await page.route(CHECK_REQUEST, (route) => {
    const withMedia = new URL(route.request().url()).searchParams.get("download");
    asked.push(withMedia);
    const body = withMedia === "1"
      ? { check: true, valid: true, outcome: "update", existingProject: project, report: report([], 1), changes: { added: [], modified: [], removed: [], keptLocal: [{ id: "a", kind: "asset", label: "ehi.png" }], conflicts: [], unchanged: 23, omitted: 0, basis: { projectRevision: "r", profileDigest: "d" } } }
      : { check: true, valid: true, outcome: "update", existingProject: project, report: report(["ehi"], 0), changesNeedDownload: true };
    return route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
  });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(fixed) });
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 20_000 });
  expect(asked).toEqual([null, "1"]);
  const changes = check.getByTestId("cms-prototype-changes");
  await expect(changes).toContainText("1 tue modifiche tenute");
  await expect(changes).toContainText("ehi.png");
  await expect(check.getByTestId("cms-prototype-import")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(check).toBeHidden();

  // A server that still gives no list with the media: no update is offered without what it changes.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(CHECK_REQUEST, (route) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ check: true, valid: true, outcome: "update", existingProject: project, report: report(["ehi"], 0), changesNeedDownload: true }) }));
  await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria-2.html", mimeType: "text/html", buffer: Buffer.from(fixed) });
  await expect(page.getByRole("alert").first()).toContainText("senza scaricare i media remoti", { timeout: 20_000 });
  await expect(check).toBeHidden();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("un aggiornamento il cui backup supera i limiti lo dice al primo controllo, senza scaricare nulla e senza «Aggiorna» (D2)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const headers = { Origin: env.baseUrl, "X-Histos-Token": env.token };
  const id = crypto.randomUUID();
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8")).replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "Galleria ${id.slice(0, 8)}"`);
  // The project, imported with its media in the file.
  const imported = await fetch(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: prototype });
  expect(imported.status).toBe(201);
  const asset = (await imported.json() as { assets: Array<{ sha256: string }> }).assets[0];
  if (!asset) throw new Error("Media mancante.");
  // One media file grows past the 512 MiB a backup holds, as a project with many large photos does (a sparse file:
  // no disk is used). The check measures it and reads no media for it.
  const file = path.join(env.dataDirectory, "histos-projects", id, "media", "sha256", asset.sha256.slice(0, 2), asset.sha256);
  const original = await readFile(file);
  await truncate(file, 513 * 1024 * 1024);
  try {
    // The update gives a media by URL. Before, the app checked again with ?download=1, downloading every remote media,
    // only to learn then that the update could not run.
    const update = prototype.replace(/\{ "name": "ehi", "data": "[^"]+",/u, '{ "name": "ehi", "url": "https://media.example.test/ehi.png",');
    expect(update).not.toBe(prototype);
    const checks: string[] = [];
    page.on("request", (request) => { if (CHECK_REQUEST.test(request.url())) checks.push(request.url()); });
    await page.goto(`${env.baseUrl}/#token=${env.token}`);
    await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
    await page.getByTestId("cms-import-input").setInputFiles({ name: "galleria.html", mimeType: "text/html", buffer: Buffer.from(update) });
    const check = page.getByTestId("cms-prototype-check");
    await expect(check).toBeVisible({ timeout: 20_000 });
    await expect(check).toHaveAttribute("data-outcome", "update");
    await expect(check.getByTestId("cms-prototype-no-backup")).toContainText("Il progetto supera il limite di 512 MiB.");
    // Nothing to approve and nothing to compare: no «Aggiorna», no list of changes.
    await expect(check.getByTestId("cms-prototype-import")).toHaveCount(0);
    await expect(check.getByTestId("cms-prototype-changes")).toHaveCount(0);
    // One check, the first, without the media: no second one with ?download=1.
    expect(checks).toHaveLength(1);
    expect(new URL(checks[0] as string).searchParams.get("download")).toBeNull();
    await page.keyboard.press("Escape");
    await expect(check).toBeHidden();
    expect(pageErrors).toEqual([]);
  } finally {
    await writeFile(file, original);
  }
});
