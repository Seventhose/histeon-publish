import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function imported(request: import("@playwright/test").APIRequestContext, env: E2EState, id: string): Promise<void> {
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const answer = await request.post(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { headers: { ...headers, "Content-Type": "text/html" }, data: example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id) });
  expect(answer.status()).toBe(201);
}

test("dal progetto all'amministrazione: si muove, cerca, modifica in linea e mette una lingua", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}`);
  await expect(page).toHaveURL(/#\/cms\/[^/]+\/amministra$/u);
  const admin = page.getByTestId("site-admin");
  await expect(admin.getByRole("heading", { name: "Bacheca" })).toBeVisible();

  // Pages: the table, the search and the detail beside the row.
  await page.getByTestId("admin-section-pagine").click();
  await expect(page).toHaveURL(/amministra\/pagine$/u);
  await expect(page.getByTestId("admin-table")).toBeVisible();
  const first = page.getByTestId("admin-table").locator(".admin-title button").first();
  const title = await first.innerText();
  await first.click();
  await expect(page.getByTestId("admin-detail")).toBeVisible();
  await page.getByTestId("admin-detail-title").fill(`${title} due`);
  await page.getByTestId("admin-detail-title").blur();
  await expect(page.getByRole("status").getByText("Salvato.")).toBeVisible();
  await expect(page.getByTestId("admin-table")).toContainText(`${title} due`);

  // Ctrl+K finds a post from anywhere and opens it.
  await page.keyboard.press("Control+k");
  await page.getByTestId("admin-palette-input").fill("antico sogno");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/amministra\/articolo-\d+$/u);
  await expect(page.getByTestId("article-title")).toHaveValue("Un antico sogno");

  // Settings from inside, then a language, then a translation in its folder.
  await page.getByTestId("admin-section-impostazioni").click();
  await page.getByTestId("admin-site-url").fill("https://esempio.it");
  await page.getByTestId("admin-settings-save").click();
  await expect(page.getByTestId("admin-settings-save")).toBeHidden();
  await page.getByTestId("admin-project-name").fill("Galleria nuova");
  await page.getByTestId("admin-settings-save").click();
  await expect(admin.locator(".admin-site-name")).toHaveText("Galleria nuova");
  await page.getByTestId("admin-section-lingue").click();
  await page.getByTestId("admin-language-code").fill("en");
  await page.getByTestId("admin-language-add").click();
  await expect(admin.getByText("/en/", { exact: true })).toBeVisible();
  await page.getByTestId("admin-lang-tab-lavoro").click();
  await expect(page.getByTestId("admin-xliff-export")).toBeVisible();
  await page.getByTestId("admin-section-pagine").click();
  await page.getByTestId("admin-table").locator(".admin-title button").first().click();
  await page.getByTestId("admin-translate-en").click();
  await expect(page.getByTestId("admin-detail").locator(".admin-version-list")).toContainText("Bozza");

  // A new page from the table, then the Cestino and the way back from the notice.
  await page.getByTestId("admin-new").click();
  await page.getByTestId("admin-new-title").fill("Pagina nuova");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("admin-detail-title")).toHaveValue("Pagina nuova");
  await page.getByTestId("admin-detail").getByRole("button", { name: "Sposta nel Cestino" }).click();
  await expect(page.getByTestId("admin-table")).not.toContainText("Pagina nuova");
  await page.getByRole("button", { name: "Annulla" }).click();
  await expect(page.getByTestId("admin-table")).toContainText("Pagina nuova");

  // The address is the screen: a reload lands in the same section.
  await page.reload();
  await expect(page.locator(".admin-title-main")).toHaveText("Pagine");
  await expect(page.getByTestId("admin-table")).toBeVisible();
});

test("il cambio di sezione è immediato anche la prima volta", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra`);
  await expect(page.getByTestId("site-admin")).toBeVisible();
  await expect(page.getByTestId("admin-section-media").locator(".admin-badge")).toBeVisible();
  const measured = await page.evaluate(async () => {
    const button = document.querySelector<HTMLElement>('[data-testid="admin-section-pagine"]')!;
    const start = performance.now();
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ms: performance.now() - start, rows: document.querySelectorAll(".admin-spacer .admin-row").length };
  });
  console.log(`cambio di sezione: ${measured.ms.toFixed(0)} ms`);
  expect(measured.rows).toBeGreaterThan(0);
  expect(measured.ms).toBeLessThan(200);
});

test("dal builder si torna alla sezione dell'amministrazione da cui si è partiti", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/pagine`);
  await page.getByTestId("admin-table").locator(".admin-title button").first().click();
  await page.getByTestId("admin-open-builder").click();
  const back = page.getByRole("link", { name: "← Amministrazione" });
  await expect(back).toBeVisible({ timeout: 20_000 });
  await back.click();
  await expect(page).toHaveURL(/#\/cms\/[^/]+\/amministra\/pagine$/u);
  await expect(page.getByTestId("admin-table")).toBeVisible();
});

test("un articolo si scrive a blocchi, senza HTML, e il sito lo pubblica con il suo modello", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/articoli`);
  await page.getByTestId("admin-new").click();
  await page.locator("#admin-new-title").fill("Scritto a mano");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("article-editor")).toBeVisible();
  await expect(page).toHaveURL(/amministra\/articolo-\d+$/u);
  await expect(page.getByTestId("article-title")).toHaveValue("Scritto a mano");

  const text = page.locator(".article-text");
  await text.click();
  await page.keyboard.type("Primo paragrafo {non espressione}");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Un titolo");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- voce uno");
  await page.keyboard.press("Enter");
  await page.keyboard.type("voce due");
  await expect(text.locator("h2")).toHaveText("Un titolo");
  await expect(text.locator("li")).toHaveCount(2);

  // A selection brings the format bar; «/» on an empty line the block menu.
  await page.getByText("Primo paragrafo").click({ clickCount: 3 });
  await page.getByTestId("article-bubble").getByRole("button", { name: "Grassetto" }).click();
  await expect(text.locator("strong")).toHaveText("Primo paragrafo {non espressione}");
  await text.locator("li").last().click();
  await expect(page.getByTestId("article-bubble")).toBeHidden();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/cit");
  await expect(page.getByTestId("article-menu")).toContainText("Citazione");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Una citazione");
  await expect(text.locator("blockquote")).toHaveText("Una citazione");

  await expect(page.getByTestId("article-saving")).toHaveText("Salvato", { timeout: 6000 });
  // A second save keeps the blocks' ids: translations are tied to them.
  const contentOf = async () => (await (await request.get(`${env.baseUrl}/api/cms/v1/projects/${id}/admin/article/${/articolo-(\d+)/u.exec(page.url())![1]}`, { headers: { "X-Histos-Token": env.token, Origin: env.baseUrl } })).json() as { document: { blocks: Array<{ uid: string }> } }).document.blocks.map((block) => block.uid);
  const ids = await contentOf();
  await page.locator(".article-text blockquote").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" fine");
  await expect(page.getByTestId("article-saving")).toHaveText("Salvato", { timeout: 6000 });
  expect(await contentOf()).toEqual(ids);
  // After a reload it is all there, from the server.
  await page.reload();
  await expect(page.locator(".article-text blockquote")).toHaveText("Una citazione fine", { timeout: 20_000 });
  await expect(page.locator(".article-text strong")).toContainText("Primo paragrafo {non espressione}");

  // Everything leaves the editor with its back button, and the list shows the article.
  await page.getByTestId("article-back").click();
  await expect(page).toHaveURL(/amministra\/articoli$/u);
  await expect(page.getByTestId("admin-table")).toContainText("Scritto a mano");
});

test("la bacheca dice il passo dopo, l'articolo ha cronologia e motori di ricerca, e ? mostra le scorciatoie", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra`);
  await expect(page.getByTestId("admin-next")).toContainText("Il sito non è ancora online");

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Scorciatoie" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Scorciatoie" })).toHaveCount(0);

  await page.getByTestId("admin-section-articoli").click();
  await page.getByTestId("admin-table").locator(".admin-title button").first().click();
  await expect(page.getByTestId("article-editor")).toBeVisible();
  await page.locator(".article-text").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" aggiunta");
  await expect(page.getByTestId("article-saving")).toHaveText("Salvato", { timeout: 6000 });
  await page.getByTestId("article-history").click();
  await expect(page.getByTestId("article-history-list").getByRole("button", { name: "Ripristina" }).first()).toBeVisible();
  await page.getByTestId("article-history-list").getByRole("button", { name: "Confronta" }).first().click();
  await expect(page.getByTestId("article-compare").locator("ins")).toContainText("aggiunta");
  await page.getByTestId("article-history-list").getByRole("button", { name: "Ripristina" }).first().click();
  await expect(page.locator(".article-text")).not.toContainText("aggiunta");

  await page.getByTestId("admin-seo").locator("summary").click();
  await page.getByTestId("admin-seo-title").fill("Titolo per Google");
  await page.getByTestId("admin-seo-title").blur();
  await expect(page.getByTestId("admin-seo").locator(".admin-seo-preview")).toContainText("Titolo per Google");
});

test("le immagini non usate si trovano e una si ritaglia in una copia", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await request.post(`${env.baseUrl}/api/cms/v1/projects/${id}/media?filename=solitaria.png`, { headers: { "X-Histos-Token": env.token, Origin: env.baseUrl, "Content-Type": "image/png" }, data: png });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/media`);
  await page.getByTestId("admin-media-unused").check();
  const unused = page.locator(".admin-media li").filter({ hasText: "solitaria.png" });
  await expect(unused).toBeVisible();
  await unused.getByRole("button", { name: "Ritaglia" }).click();
  const crop = page.getByTestId("admin-crop");
  await crop.getByRole("button", { name: "Ruota" }).click();
  await crop.getByRole("button", { name: "Salva una copia" }).click();
  await expect(crop).toHaveCount(0);
  await expect(page.locator(".admin-media li").filter({ hasText: "solitaria-ritaglio.webp" })).toBeVisible();
});

test("un sito nasce da un modello pronto", async ({ page }) => {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.getByTestId("new-starter-rivista").click();
  await expect(page.getByRole("heading", { name: "Bacheca" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("admin-section-articoli")).toContainText(/\d/u);
});

test("una tabella si inserisce, cresce e resta dopo una ricarica", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/articoli`);
  await page.getByTestId("admin-new").click();
  await page.locator("#admin-new-title").fill("Con tabella");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("article-editor")).toBeVisible();
  await page.getByTestId("article-editor").getByRole("button", { name: "＋ Tabella" }).click();
  const table = page.locator(".article-text table");
  await expect(table.locator("tr")).toHaveCount(2);
  await table.locator("th").first().click();
  await page.keyboard.type("Nome");
  await page.getByRole("button", { name: "+ riga" }).click();
  await page.getByRole("button", { name: "+ colonna" }).click();
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
  await expect(page.getByTestId("article-saving")).toHaveText("Salvato", { timeout: 6000 });
  await page.reload();
  await expect(page.locator(".article-text table th").first()).toHaveText("Nome", { timeout: 20_000 });
  await expect(page.locator(".article-text table tr")).toHaveCount(3);
});

test("gli articoli si vedono a copertine e i media stanno in cartelle", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/articoli`);
  await page.getByTestId("admin-wall").click();
  await expect(page.getByTestId("admin-wall-list").getByRole("button").first()).toBeVisible();
  await page.getByTestId("admin-wall").click();
  await page.getByTestId("admin-section-media").click();
  const first = page.getByTestId("admin-media-folder").first();
  await first.fill("Copertine");
  await first.blur();
  await page.getByTestId("admin-media-folder-filter").selectOption("Copertine");
  await expect(page.locator(".admin-media li")).toHaveCount(1);
});

test("il primo sito nasce da tre domande", async ({ page }) => {
  const env = await state();
  await page.route("**/api/cms/v1/projects", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { projects: [], unavailable: [] } });
    else await route.continue();
  });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.getByTestId("welcome-start").click();
  const assistant = page.getByTestId("first-site");
  await expect(assistant.getByRole("button", { name: "Avanti" })).toBeDisabled();
  const name = `Primo ${Date.now()}`;
  await page.getByTestId("first-site-name").fill(name);
  await page.getByTestId("first-site-next").click();
  await assistant.getByRole("button", { name: /Vuoto/u }).click();
  await page.getByTestId("first-site-next").click();
  await page.getByTestId("first-site-create").click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeAttached({ timeout: 20_000 });
  await expect(assistant).toHaveCount(0);
});

test("i blocchi per chi scrive: si aggiungono dal menu, si compilano e le note si numerano da sole", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}`);
  await expect(page.getByTestId("site-admin").getByRole("heading", { name: "Bacheca" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByTestId("admin-palette-input").fill("antico sogno");
  await page.keyboard.press("Enter");
  const text = page.getByTestId("article-text").locator(".article-text");
  await expect(text).toBeVisible();

  /** The cursor at the end of the first paragraph; the End key does not move it in a headless browser. */
  const atEnd = async (): Promise<void> => {
    await text.focus();
    await text.locator("p").first().evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.waitForTimeout(100);
  };
  const newLine = async (): Promise<void> => {
    await atEnd();
    await page.keyboard.press("Enter");
  };
  const fields = page.getByTestId("article-card-fields");

  // A block with rows: a row at a time, each with its own fields.
  await newLine();
  await page.keyboard.type("/domande");
  await page.getByTestId("article-menu").getByRole("button", { name: "Domande e risposte" }).click();
  await page.getByTestId("article-card-add-row").click();
  await fields.locator('[data-field="question"]').fill("Perché?");
  await fields.locator('[data-field="answer"]').fill("Perché sì.");
  await fields.locator('[data-field="answer"]').blur();
  await expect(text.locator(".xb-art-domande summary")).toHaveText("Perché?");

  await newLine();
  await page.keyboard.type("/riquadro");
  await page.getByTestId("article-menu").getByRole("button", { name: "Riquadro" }).click();
  await expect(fields).toBeVisible();
  await fields.locator('[data-field="title"]').fill("Attenzione");
  await fields.locator('[data-field="text"]').click();
  await page.keyboard.type("Da leggere {prima}");
  await page.getByTestId("article-title").click();
  await expect(text.locator(".xb-art-riquadro .xb-art-testo")).toHaveText("Da leggere {prima}");
  await expect(page.getByTestId("article-saving")).toHaveText("Salvato");

  // The block of a site of its own, without HTML.
  await newLine();
  await page.keyboard.type("/nuovo");
  await page.getByTestId("article-menu").getByRole("button", { name: "Nuovo blocco…" }).click();
  await page.getByTestId("article-new-card-name").fill("Premio");
  await page.getByTestId("article-new-card-field").first().fill("Nome del premio");
  await page.getByTestId("article-new-card-create").click();
  await fields.locator('[data-field="campo1"]').fill("Premio Strega");
  await fields.locator('[data-field="campo1"]').blur();
  await expect(text.locator(".xb-art-riquadro .xb-art-titolo").filter({ hasText: "Premio Strega" })).toBeVisible();

  // The block of one's own changes after it is made (list item 92): a new name and one more field, and what the
  // article wrote in the first field stays.
  await newLine();
  await page.keyboard.type("/cambia");
  await page.getByTestId("article-menu").getByRole("button", { name: "Cambia il blocco «Premio»" }).click();
  await expect(page.getByTestId("article-new-card-name")).toHaveValue("Premio");
  await page.getByTestId("article-new-card-name").fill("Premio letterario");
  await page.getByTestId("article-new-card").getByRole("button", { name: /Aggiungi un campo|campo/u }).first().click();
  await page.getByTestId("article-new-card-field").last().fill("Anno");
  await page.getByTestId("article-new-card-create").click();
  await expect(text.locator(".xb-art-riquadro .xb-art-titolo").filter({ hasText: "Premio Strega" })).toBeVisible();

  // The first note, then one before it: the numbers follow the text and the lines follow the numbers.
  await atEnd();
  await page.getByTestId("article-add-note").click();
  await page.keyboard.type("Nota seconda");
  await page.getByTestId("article-note-back").click();
  await text.locator("p").first().click({ position: { x: 60, y: 8 } });
  await page.getByTestId("article-add-note").click();
  await page.keyboard.type("Nota prima");
  await expect(text.locator("ol.xb-art-note li")).toHaveText(["Nota prima", "Nota seconda"]);
  await expect(text.locator('a[href="#nota-1"] sup')).toHaveText("1");
  await expect(text.locator('a[href="#nota-2"] sup')).toHaveText("2");
  await expect(page.getByTestId("article-saving")).toHaveText("Salvato");

  // A click on a text of the page leads back to it on the sheet.
  await page.getByTestId("article-page-preview").click();
  await page.frameLocator('[data-testid="article-page-frame"]').getByText("Da leggere {prima}").click();
  await expect(page.getByTestId("article-page-frame")).toHaveCount(0);
  await expect(page.getByTestId("article-card-fields")).toBeVisible();

  // All of it survives a reload, and the definition has entered the project.
  await page.reload();
  await expect(text.locator(".xb-art-riquadro .xb-art-titolo").filter({ hasText: "Attenzione" })).toBeVisible();
  await expect(text.locator(".xb-art-domande summary")).toHaveText("Perché?");
  await expect(text.locator("ol.xb-art-note li")).toHaveText(["Nota prima", "Nota seconda"]);
});

test("i documenti allegati e la riga della fonte dei siti di prima diventano blocchi con un clic (voce 111)", async ({ page, request }) => {
  const env = await state();
  const id = crypto.randomUUID();
  await imported(request, env, id);
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/articoli`);
  await page.getByTestId("admin-new").click();
  await page.locator("#admin-new-title").fill("Dal sito di prima");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("article-editor")).toBeVisible();
  const alias = /articolo-(\d+)/u.exec(page.url())![1];
  // The markup the importer left in existing sites, written straight into the document.
  const documentUrl = `${env.baseUrl}/api/cms/v1/projects/${id}/documents/${alias}`;
  const { head } = await (await request.get(documentUrl, { headers })).json() as { head: string };
  const old = '<!-- wp:xb/element {"uid":"pprosa00001","tag":"p"} --><!-- wp:xb/text {"uid":"pprosa00002","content":"Il testo."} /--><!-- /wp:xb/element -->'
    + '<!-- wp:xb/element {"uid":"pdocs000001","tag":"section","attributes":{"class":"documenti","aria-label":"Documenti allegati"}} --><!-- wp:xb/element {"uid":"pdocs000002","tag":"h2","attributes":{"class":"documenti__titolo"}} --><!-- wp:xb/text {"uid":"pdocs000003","content":"Documenti"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"pdocs000004","tag":"ul","attributes":{"class":"documenti__lista"}} --><!-- wp:xb/element {"uid":"pdocs000005","tag":"li","attributes":{"class":"documenti__voce"}} --><!-- wp:xb/element {"uid":"pdocs000006","tag":"a","attributes":{"class":"documenti__link","href":"https://esempio.it/programma.pdf"}} --><!-- wp:xb/text {"uid":"pdocs000007","content":"Il programma"} /--><!-- wp:xb/element {"uid":"pdocs000008","tag":"span","attributes":{"class":"sr"}} --><!-- wp:xb/text {"uid":"pdocs000009","content":" (PDF)"} /--><!-- /wp:xb/element --><!-- /wp:xb/element --><!-- /wp:xb/element --><!-- /wp:xb/element --><!-- /wp:xb/element -->'
    + '<!-- wp:xb/element {"uid":"pfonte00001","tag":"p","attributes":{"class":"articolo__fonte"}} --><!-- wp:xb/element {"uid":"pfonte00002","tag":"a","attributes":{"href":"https://esempio.it/originale/"}} --><!-- wp:xb/text {"uid":"pfonte00003","content":"Leggi l\'articolo sul sito ufficiale"} /--><!-- /wp:xb/element --><!-- /wp:xb/element -->';
  expect((await request.post(documentUrl, { headers: { ...headers, "Content-Type": "application/json" }, data: { head, content: old } })).status()).toBe(200);
  await page.reload();
  const kept = page.locator(".article-kept");
  await expect(kept).toHaveCount(2, { timeout: 20_000 });

  await kept.first().click();
  await expect(page.getByTestId("article-kept-fields")).toContainText("Questa parte viene dal sito di prima");
  await page.getByTestId("article-kept-convert").click();
  await expect(page.locator(".article-kept")).toHaveCount(1);
  await page.locator(".article-kept").click();
  await page.getByTestId("article-kept-convert").click();
  await expect(page.locator(".article-kept")).toHaveCount(0);
  await expect(page.locator(".article-text h2")).toHaveText("Documenti");
  await expect(page.getByTestId("article-saving")).toHaveText("Salvato", { timeout: 6000 });

  const saved = await (await request.get(`${env.baseUrl}/api/cms/v1/projects/${id}/admin/article/${alias}`, { headers })).json() as { document: { blocks: Array<{ type: string; ref?: string; props?: Record<string, string> }> } };
  expect(saved.document.blocks.map((block) => block.ref ?? block.type)).toEqual(["paragraph", "heading", "articolo/documento", "articolo/fonte"]);
  expect(saved.document.blocks[2]?.props).toMatchObject({ label: "Il programma", href: "https://esempio.it/programma.pdf" });
  expect(saved.document.blocks[3]?.props).toMatchObject({ label: "Leggi l'articolo sul sito ufficiale", link: "https://esempio.it/originale/" });
  const content = (await (await request.get(documentUrl, { headers })).json() as { content: string }).content;
  // Instances of the blocks' components, which entered the project with their first use.
  expect(content).toContain('"ref":"articolo/fonte"');
  expect(content).toContain('"ref":"articolo/documento"');
  expect(content).not.toContain("documenti__lista");
});
