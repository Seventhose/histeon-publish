import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The check builds a throwaway preview: under heavy machine load it can take a minute.
test.describe.configure({ timeout: 120_000 });

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("un prototipo il cui sito non si costruisce si ferma al controllo, con il motivo della build fra gli errori (D8)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Seven nested loops: the import takes them, the build's renderer stops at six. The app's check builds the preview.
  const nested = "{#loop [1] as a}{#loop [1] as b}{#loop [1] as c}{#loop [1] as d}{#loop [1] as e}{#loop [1] as f}{#loop [1] as g}<p>x</p>{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}";
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8"))
    .replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", crypto.randomUUID())
    .replace("<p>Quadretti, libri, racconti.</p>", `<p>Quadretti, libri, racconti.</p>${nested}`);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "senza-build.html", mimeType: "text/html", buffer: Buffer.from(prototype) });
  // Before: the check dialog offered «Importa», with the reason only as a note beside a missing preview.
  const problems = page.getByTestId("cms-prototype-problems");
  await expect(problems).toBeVisible({ timeout: 60_000 });
  await expect(problems).toBeFocused();
  await expect(problems.getByRole("heading")).toHaveText("«senza-build.html»: un errore da correggere");
  // Placed at the page the build was writing (B2): its line in the file, then the build's own words.
  await expect(problems.locator("li")).toHaveText(["page home, riga 87 La versione del sito si ferma: / (template site/page): I loop annidati superano il limite di 6."]);
  await expect(page.getByTestId("cms-prototype-check")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("un prototipo con main() nel template d'archivio si controlla e si importa dall'app, e i termini elencano anche i figli (B1)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const id = crypto.randomUUID();
  // The archive role's template (also opera's archiveTemplate) lists the archive with main(); «Lupo» is filed under
  // «cani», a child of «notte», «Stella» under «notte» only.
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8"))
    .replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id)
    .replace('"name": "Galleria"', `"name": "Main ${id.slice(0, 8)}"`)
    .replace("{#loop opere_recenti() as opera}", "{#loop main() as opera}")
    .replace('"terms": { "tema": ["notte", "cani"] } }', '"terms": { "tema": ["notte", "cani"] } },\n    { "type": "opera", "slug": "lupo", "title": "Lupo", "status": "published", "publishedAt": "2026-10-03T09:00:00Z", "terms": { "tema": ["cani"] } },\n    { "type": "opera", "slug": "stella", "title": "Stella", "status": "published", "publishedAt": "2026-10-04T09:00:00Z", "terms": { "tema": ["notte"] } }');
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "main.html", mimeType: "text/html", buffer: Buffer.from(prototype) });
  // Before: the problems panel with «La query main non è inclusa nel trasferimento CMS.», with no place.
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("cms-prototype-problems")).toHaveCount(0);
  const previewLink = check.getByTestId("cms-prototype-preview");
  await expect(previewLink).toHaveAttribute("href", /\/__preview\//u);
  const href = new URL((await previewLink.getAttribute("href"))!, env.baseUrl);
  const archive = await page.context().newPage();
  const titles = async (address: string) => {
    await archive.goto(new URL(`${address}index.html`, href).toString());
    return archive.locator("article.opera h3").allTextContents();
  };
  // Newest first; the parent term lists its child's record too, as on WordPress.
  expect(await titles("tema/notte/")).toEqual(["Stella", "Lupo", "Ehi"]);
  expect(await titles("tema/notte/cani/")).toEqual(["Lupo", "Ehi"]);
  expect(await titles("opera/")).toEqual(["Stella", "Lupo", "Ehi"]);
  await archive.close();
  await check.getByTestId("cms-prototype-import").click();
  await expect(check).toBeHidden();
  await expect(page.getByRole("heading", { name: `Main ${id.slice(0, 8)}`, exact: true })).toBeVisible({ timeout: 60_000 });
  expect(pageErrors).toEqual([]);
});

test("un prototipo che la pubblicazione fermerebbe si può importare: l'anteprima manca e i motivi sono il primo avviso (B2)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // A folder of the server in the home's text: the site builds, the scanner would stop its publishing.
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8"))
    .replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", crypto.randomUUID())
    .replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti, libri, racconti. Archivio in /home/andrea/sito.</p>");
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "percorso.html", mimeType: "text/html", buffer: Buffer.from(prototype) });
  // Before (round 5): the problems panel, «La build bloccherebbe la pubblicazione del sito…», and no «Importa».
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("cms-prototype-problems")).toHaveCount(0);
  await expect(check).toContainText("Anteprima non disponibile: Il sito si costruisce, ma i controlli di sicurezza fermerebbero la pubblicazione: i motivi sono fra gli avvisi.");
  await expect(check.getByTestId("cms-prototype-preview")).toHaveCount(0);
  const warnings = check.getByTestId("cms-prototype-warnings");
  await expect(warnings).toHaveAttribute("open", "");
  await expect(warnings.locator("li").first()).toHaveText(/^La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga 87 del prototipo\.$/u);
  await expect(check.getByTestId("cms-prototype-import")).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test("un prototipo con sole bozze si può importare, con l'anteprima non disponibile e il motivo (B2)", async ({ page }) => {
  const env = await state();
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8"))
    .replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", crypto.randomUUID())
    .replace('data-slug="home" data-title="Home" data-template="site/page">', 'data-slug="home" data-title="Home" data-template="site/page" data-status="draft">');
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "bozze.html", mimeType: "text/html", buffer: Buffer.from(prototype) });
  // Before (round 5): the problems panel, «La versione del sito si ferma: Il progetto non ha pagine…».
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 60_000 });
  await expect(check).toContainText("Anteprima non disponibile: Il progetto non ha pagine incluse nella versione.");
  await expect(check.getByTestId("cms-prototype-import")).toBeEnabled();
});
