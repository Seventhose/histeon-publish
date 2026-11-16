import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newPage, newProject, openBuilder, openProject } from "./cms-helpers.js";
import LZString from "lz-string";

// The builder's first-run tour opens 1.2 s after load and covers the canvas: a click after it never reaches the page.
// These tests are someone who has seen it, as cms-helpers.ts openBuilder.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("xb-tour-done", "1"); } catch { /* no storage: the tour shows */ } });
});

interface E2EState { baseUrl: string; token: string; mockUrl: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function cmsRequest<T>(env: E2EState, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(route, env.baseUrl), {
    ...init,
    headers: { Origin: env.baseUrl, "X-Histos-Token": env.token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(`CMS fixture request failed (${response.status}): ${await response.text()}`);
  return await response.json() as T;
}

async function setCode(page: import("@playwright/test").Page, label: string, source: string): Promise<void> {
  const editor = page.locator(`.cm-content[aria-label="${label}"]`);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("Control+A");
  await page.keyboard.insertText(source);
}

const WORDPRESS_ONLY_ROUTES = ["changes", "content", "deploy", "extensions", "facets", "named-queries", "releases", "review/comments", "sections", "selectors", "shortcuts"];

function trackUnsupportedWordPressRequests(page: import("@playwright/test").Page, requests: string[]): void {
  page.on("request", (request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;
    const projectRoute = pathname.match(/\/api\/cms\/v1\/projects\/[0-9a-f-]{36}\/([^/]+(?:\/.*)?)$/iu)?.[1] ?? "";
    if (
      WORDPRESS_ONLY_ROUTES.some((route) => projectRoute === route || projectRoute.startsWith(`${route}/`))
      || projectRoute === "library" && url.searchParams.get("type") === "post"
      || pathname.includes("wp/v2")
    ) requests.push(`${request.method()} ${pathname}`);
  });
}

test("il builder Histeon salva HTML, CSS e media, riapre e conserva un conflitto concorrente", async ({ page }) => {
  const env = await state();
  const projectName = `E2E CMS editor ${Date.now()}`;
  await fetch(`${env.mockUrl.replace(/\/client\/v4$/u, "")}/__reset`);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await newPage(page, "Pagina Due");
  await expect(page.getByTestId("admin-table").getByRole("button", { name: /^Apri nel builder: /u })).toHaveCount(2);
  const catalog = await cmsRequest<{ projects: Array<{ id: string; name: string }> }>(env, "/api/cms/v1/projects");
  const project = catalog.projects.find((item) => item.name === projectName);
  expect(project).toBeDefined();
  const projectBase = `/api/cms/v1/projects/${project!.id}`;
  const details = await cmsRequest<{ pages: Array<{ alias: number; title: string }> }>(env, projectBase);
  const home = details.pages.find((item) => item.title === "Home");
  const pageTwo = details.pages.find((item) => item.title === "Pagina Due");
  expect(home).toBeDefined();
  expect(pageTwo).toBeDefined();
  await cmsRequest(env, `${projectBase}/templates`, {
    method: "POST",
    body: JSON.stringify({ title: "Template E2E", ref: "site/page-e2e" }),
  });
  const unsupportedWordPressRequests: string[] = [];
  trackUnsupportedWordPressRequests(page, unsupportedWordPressRequests);
  const pageAlias = home!.alias;
  const editorUrl = `${env.baseUrl}/cms-editor.html?project=${project!.id}&document=${pageAlias}`;
  await openBuilder(page, "Home");
  await expect(page.getByRole("button", { name: "Nuovo componente" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Versioni" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Commenti" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Libreria", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Contenuti" }).click();
  const contentPanel = page.getByRole("dialog", { name: "Contenuti" });
  await expect(contentPanel.getByRole("tab", { name: "Pagine" })).toBeVisible();
  await expect(contentPanel.getByRole("tab", { name: "Componenti" })).toBeVisible();
  await expect(contentPanel.getByRole("tab", { name: "Articoli" })).toHaveCount(0);
  await contentPanel.getByRole("button", { name: "Chiudi e torna all'anteprima" }).click();
  await page.getByRole("button", { name: "Template" }).click();
  await expect(page.getByRole("dialog", { name: "Template" })).toContainText("Template E2E");
  await page.getByRole("button", { name: "Chiudi e torna all'anteprima" }).click();

  await page.getByRole("button", { name: "Aggiungi un elemento" }).first().click();
  await page.getByRole("option", { name: "Immagine dalla libreria…" }).click();
  await expect(page.getByRole("dialog", { name: "Gestore dei media" })).toBeVisible();
  await page.getByLabel("Compressione prima del caricamento").selectOption({ label: "Originale" });
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "cms-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kRZ0AAAAASUVORK5CYII=", "base64"),
  });
  const imageChoice = page.getByRole("button", { name: "cms-pixel.png", exact: true });
  await expect(imageChoice).toBeVisible({ timeout: 15_000 });
  await imageChoice.click();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });

  const media = await cmsRequest<Array<{ title: { rendered: string }; source_url: string }>>(env, `${projectBase}/media`);
  const uploaded = media.find((item) => item.title.rendered === "cms-pixel.png");
  expect(uploaded).toBeDefined();
  await setCode(page, "Codice HTML", `<main class="hero"><h1>Testo persistito nel builder</h1><img src="${uploaded!.source_url}" alt="Pixel di prova" /></main>`);
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Testo persistito nel builder");
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });

  await page.getByRole("tab", { name: ".hero" }).click();
  await setCode(page, "CSS di .hero", "background-image: url('../images/hero.png?v=4');");
  await page.getByRole("button", { name: "Risorse CSS" }).click();
  const resourceDialog = page.getByRole("dialog", { name: "File collegati al CSS" });
  await expect(resourceDialog).toBeVisible();
  await expect(resourceDialog.getByText("../images/hero.png?v=4", { exact: true })).toBeVisible();
  await resourceDialog.getByLabel("File locale").setInputFiles({
    name: "hero.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kRZ0AAAAASUVORK5CYII=", "base64"),
  });
  await resourceDialog.getByRole("button", { name: "Salva collegamenti" }).click();
  await expect(resourceDialog).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const selectorStyles = await cmsRequest<{ styles: Array<{ selector: string; css: string; assets?: Array<{ reference: string; assetId: string }> }> }>(env, `${projectBase}/styles`);
  const heroStyle = selectorStyles.styles.find((style) => style.selector === ".hero");
  expect(heroStyle?.css).toContain("../images/hero.png?v=4");
  expect(heroStyle?.assets).toHaveLength(1);
  const selectorPreview = await cmsRequest<{ css: string }>(env, `${projectBase}/render`, {
    method: "POST",
    body: JSON.stringify({ post_id: pageAlias, content: (await cmsRequest<{ content: string }>(env, `${projectBase}/documents/${pageAlias}`)).content }),
  });
  expect(selectorPreview.css).toContain(`/__cms-media/${project!.id}/${heroStyle!.assets![0]!.assetId}?v=4`);

  // A draft page can be previewed privately without becoming an eligible deploy build.
  await page.getByRole("button", { name: "Anteprima" }).click();
  const previewDialog = page.getByRole("dialog", { name: "Anteprima della pagina" });
  await expect(previewDialog).toBeVisible();
  const previewFrame = page.frameLocator('iframe[title="Anteprima della pagina in sviluppo"]');
  await expect(previewFrame.locator("body")).toContainText("Testo persistito nel builder", { timeout: 20_000 });
  expect(await previewDialog.locator("iframe").getAttribute("src")).toContain("/__preview/");
  await previewDialog.getByRole("button", { name: /Torna al builder/u }).click();

  await page.getByRole("tab", { name: "Foglio globale" }).click();
  await setCode(page, "CSS globale", "body { color: rgb(1, 2, 3); }");
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });

  const directImportedCss = '@import "./parts/tokens.css" layer(tokens);\nbody { color: rgb(1, 2, 3); }';
  const directCssDirectory = await mkdtemp(path.join(tmpdir(), "histos-direct-css-import-"));
  const incompleteCssDirectory = path.join(directCssDirectory, "incomplete");
  const completeCssDirectory = path.join(directCssDirectory, "complete");
  await mkdir(incompleteCssDirectory, { recursive: true });
  await mkdir(path.join(completeCssDirectory, "parts"), { recursive: true });
  await mkdir(path.join(completeCssDirectory, "images"), { recursive: true });
  await writeFile(path.join(incompleteCssDirectory, "main.css"), directImportedCss);
  await writeFile(path.join(completeCssDirectory, "main.css"), directImportedCss);
  await writeFile(path.join(completeCssDirectory, "parts", "tokens.css"), '@import "./colors.css"; .hero { background-image: url("../images/background.png"); }');
  await writeFile(path.join(completeCssDirectory, "parts", "colors.css"), ":root { --ink: #123456; }");
  const backgroundBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kRZ0AAAAASUVORK5CYII=", "base64");
  await writeFile(path.join(completeCssDirectory, "images", "background.png"), backgroundBytes);
  try {
    await setCode(page, "CSS globale", directImportedCss);
    await page.getByRole("button", { name: "Risorse CSS" }).click();
    const directResourceDialog = page.getByRole("dialog", { name: "File collegati al CSS" });
    await expect(directResourceDialog).toBeVisible();
    const directoryInput = directResourceDialog.locator("input[webkitdirectory]");
    await directoryInput.setInputFiles(incompleteCssDirectory);
    await directResourceDialog.getByLabel("Foglio CSS principale").selectOption("main.css");
    const inlineButton = directResourceDialog.getByRole("button", { name: "Incorpora import e collega file" });
    await inlineButton.click();
    await expect(directResourceDialog).toContainText("Manca il foglio CSS importato");
    await directoryInput.setInputFiles(completeCssDirectory);
    await directResourceDialog.getByLabel("Foglio CSS principale").selectOption("main.css");
    await inlineButton.click();
    await expect(directResourceDialog).toBeHidden();
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
    const directStyles = await cmsRequest<{ globals: Array<{ id: string; css: string; assets?: Array<{ reference: string; assetId: string }> }> }>(env, `${projectBase}/styles`);
    const globalSheet = directStyles.globals.find((sheet) => sheet.id === "global");
    expect(globalSheet?.css).toContain("@layer tokens");
    expect(globalSheet?.css).toContain("--ink: #123456");
    expect(globalSheet?.css).not.toContain("@import");
    const background = globalSheet?.assets?.find((asset) => asset.reference === "/images/background.png");
    expect(background).toMatchObject({ reference: "/images/background.png", assetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    const staticPreview = await cmsRequest<{ css: string }>(env, `${projectBase}/render`, {
      method: "POST",
      body: JSON.stringify({ post_id: pageAlias, content: (await cmsRequest<{ content: string }>(env, `${projectBase}/documents/${pageAlias}`)).content }),
    });
    expect(staticPreview.css).toContain(`/__cms-media/${project!.id}/${background!.assetId}`);
  } finally {
    await rm(directCssDirectory, { recursive: true, force: true });
  }

  await page.getByRole("button", { name: "Importa CSS" }).click();
  const cssImport = page.getByRole("dialog", { name: "Importa CSS del framework" });
  await expect(cssImport).toBeVisible();
  await expect(cssImport).toContainText("Il CSS selezionato viene applicato senza convertirlo in Histeon CSS. I preset Core Framework 1.1.0 possono generare CSS offline per le opzioni supportate; ACSS richiede il CSS esportato. Per la parità completa, importa il CSS generato dal framework.");
  await expect(cssImport).toContainText("Se il preset Core non contiene CSS, importa anche il foglio .css esportato da Core; se contiene CSS, puoi usare quello o sostituirlo con un foglio separato. Puoi selezionare i file in qualunque ordine. Per ACSS importa i fogli CSS generati, uno alla volta, e facoltativamente il file delle impostazioni.");
  const importedCss = '@import "./parts/extra.css" layer(utilities); :root { --core-space-s: 1rem; } .md\\:grid-cols-2{display:grid} .hero{background-image:url("./images/hero.logo.png")} @supports (--core-feature: enabled){.supported{color:var(--core-color)}} @font-face { font-family: CoreBrand; src: url(\'./fonts/brand.woff2?v=3#latin\'); }';
  await cssImport.locator('input[type="file"]').first().setInputFiles({ name: "codifica-errata.css", mimeType: "text/css", buffer: Buffer.from([0xff]) });
  await expect(cssImport).toContainText("Il file CSS non è codificato in UTF-8 valido.");
  await cssImport.locator('input[type="file"]').first().setInputFiles({
    name: "core-framework.css",
    mimeType: "text/css",
    buffer: Buffer.from(importedCss, "utf8"),
  });
  const cssAssetsDirectory = await mkdtemp(path.join(tmpdir(), "histos-css-assets-"));
  await mkdir(path.join(cssAssetsDirectory, "fonts"), { recursive: true });
  await mkdir(path.join(cssAssetsDirectory, "images"), { recursive: true });
  await mkdir(path.join(cssAssetsDirectory, "parts"), { recursive: true });
  await writeFile(path.join(cssAssetsDirectory, "core-framework.css"), importedCss);
  const importedPartCss = '.u-stack { display: grid; } @font-face { font-family: NestedBrand; src: url("../fonts/nested.woff2"); }';
  await writeFile(path.join(cssAssetsDirectory, "parts", "extra.css"), importedPartCss);
  const fontBytes = Buffer.from([119, 79, 70, 50, 0, 0]);
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const acssConfiguration = 'version: 4\ntokens:\n  space: 1rem\n';
  await writeFile(path.join(cssAssetsDirectory, "fonts", "brand.woff2"), fontBytes);
  await writeFile(path.join(cssAssetsDirectory, "fonts", "nested.woff2"), fontBytes);
  await writeFile(path.join(cssAssetsDirectory, "images", "hero.logo.png"), imageBytes);
  try {
    await cssImport.locator('input[webkitdirectory]').setInputFiles(cssAssetsDirectory);
    await cssImport.getByLabel("Tipo").selectOption("core-framework");
    await cssImport.locator('input[accept=".json,.txt,.yaml,.yml,.toml,.ini,.cfg,application/json,text/plain"]').setInputFiles({
      name: "automatic-css.yaml",
      mimeType: "text/yaml",
      buffer: Buffer.from(acssConfiguration, "utf8"),
    });
    await cssImport.getByLabel("Nome del framework").fill("Core Framework");
    await cssImport.getByLabel("Versione (se nota)").fill("1.2");
    await cssImport.getByLabel("Licenza dichiarata (se nota)").fill("MIT");
    await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
    await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
    await expect(cssImport).toBeHidden();
  } finally {
    await rm(cssAssetsDirectory, { recursive: true, force: true });
  }
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });

  const standaloneConfiguration = 'tokens:\n  color: "#123456"\n';
  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".json,.txt,.yaml,.yml,.toml,.ini,.cfg,application/json,text/plain"]').setInputFiles({
    name: "automatic-css-only.yaml",
    mimeType: "text/yaml",
    buffer: Buffer.from(standaloneConfiguration, "utf8"),
  });
  await cssImport.getByLabel("Nome del framework").fill("ACSS config only");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Conserva configurazione" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });

  const importedStyles = await cmsRequest<{ globals: Array<{ id: string; css: string; assets?: Array<{ reference: string; assetId: string }>; source?: { frameworkId: string; name: string; version?: string; license?: string; rightsConfirmed: boolean; preset?: { format: string; data: string }; configuration?: { format: string; data: string } } }> }>(env, `${projectBase}/styles`);
  const importedSheet = importedStyles.globals.find((sheet) => sheet.source?.name === "Core Framework");
  expect(importedSheet?.css).toContain("@layer utilities");
  expect(importedSheet?.css).toContain(".u-stack { display: grid; }");
  expect(importedSheet?.css).not.toContain("@import");
  expect(importedSheet?.source).toMatchObject({ kind: "user-css", frameworkId: "core-framework", name: "Core Framework", version: "1.2", license: "MIT", rightsConfirmed: true, configuration: { format: "opaque-utf8-v1", data: acssConfiguration } });
  const configurationOnlySheet = importedStyles.globals.find((sheet) => sheet.source?.name === "ACSS config only");
  expect(configurationOnlySheet?.css).toBe("");
  expect(configurationOnlySheet?.source).toMatchObject({ kind: "user-css", frameworkId: "automatic-css", configuration: { format: "opaque-utf8-v1", data: standaloneConfiguration } });
  const linkedFont = importedSheet?.assets?.find((asset) => asset.reference === "/fonts/brand.woff2?v=3#latin");
  const linkedNestedFont = importedSheet?.assets?.find((asset) => asset.reference === "/fonts/nested.woff2");
  const linkedLogo = importedSheet?.assets?.find((asset) => asset.reference === "/images/hero.logo.png");
  expect(linkedFont).toMatchObject({ reference: "/fonts/brand.woff2?v=3#latin", assetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
  expect(linkedNestedFont).toMatchObject({ reference: "/fonts/nested.woff2", assetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
  expect(linkedLogo).toMatchObject({ reference: "/images/hero.logo.png", assetId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
  const fontResponse = await fetch(`${env.baseUrl}/__cms-media/${project!.id}/${linkedFont!.assetId}`);
  expect(fontResponse.status).toBe(200);
  expect(fontResponse.headers.get("content-type")).toBe("font/woff2");
  expect(Buffer.from(await fontResponse.arrayBuffer())).toEqual(fontBytes);
  const logoResponse = await fetch(`${env.baseUrl}/__cms-media/${project!.id}/${linkedLogo!.assetId}`);
  expect(logoResponse.status).toBe(200);
  expect(logoResponse.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await logoResponse.arrayBuffer())).toEqual(imageBytes);
  const importedInventory = await cmsRequest<{ variables: Array<{ name: string; group: string }>; classes: Array<{ name: string; group: string }> }>(env, `${projectBase}/framework`);
  expect(importedInventory.variables).toContainEqual({ name: "core-space-s", group: "Core Framework" });
  expect(importedInventory.variables).not.toContainEqual({ name: "core-feature", group: "Core Framework" });
  expect(importedInventory.variables).not.toContainEqual({ name: "core-color", group: "Core Framework" });
  expect(importedInventory.classes).toContainEqual({ name: "u-stack", group: "Core Framework" });
  expect(importedInventory.classes).toContainEqual({ name: "md:grid-cols-2", group: "Core Framework" });
  expect(importedInventory.classes).not.toContainEqual({ name: "logo", group: "Core Framework" });

  await page.getByRole("button", { name: "Importa CSS" }).click();
  await expect(cssImport).toBeVisible();
  const corePreset = {
    id: "e2e-core-preset",
    name: "Core E2E",
    description: "Preset compresso di prova",
    date: "2026-10-24",
    app_version: "3.2.1",
    groups: {},
    styleSheetData: {},
    modulesData: {},
    cssString: ":root{--core-e2e-space:1rem}.core-e2e{display:grid}",
  };
  const compressedPreset = LZString.compressToUTF16(JSON.stringify(corePreset));
  const separateCoreCss = '.core-e2e{display:flex}';
  const coreCssInput = cssImport.locator('input[accept=".css,text/css"]');
  await coreCssInput.setInputFiles({
    name: "core-e2e.css",
    mimeType: "text/css",
    buffer: Buffer.from(separateCoreCss, "utf8"),
  });
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-e2e.core",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(compressedPreset, "utf8"),
  });
  await expect(cssImport).toContainText("Preset Core riconosciuto e conservato. Il CSS scelto separatamente sarà applicato al sito.");
  await expect(cssImport.getByLabel("Tipo")).toBeDisabled();
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-e2e-second.core",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(compressedPreset, "utf8"),
  });
  await coreCssInput.setInputFiles({
    name: "core-e2e-second.css",
    mimeType: "text/css",
    buffer: Buffer.from('.core-e2e{display:block}', "utf8"),
  });
  await expect(cssImport).toContainText("Preset Core conservato; nel sito verrà usato il CSS selezionato separatamente.");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const stylesWithPreset = await cmsRequest<{ globals: Array<{ css: string; source?: { name: string; preset?: { format: string; data: string } } }> }>(env, `${projectBase}/styles`);
  const savedPresets = stylesWithPreset.globals.filter((sheet) => sheet.source?.name === "Core E2E");
  expect(savedPresets).toHaveLength(2);
  expect(savedPresets.map((sheet) => sheet.css)).toEqual(expect.arrayContaining([separateCoreCss, '.core-e2e{display:block}']));
  for (const savedPreset of savedPresets) {
    expect(savedPreset.source?.preset).toEqual({ format: "core-lz-utf16-v1", data: compressedPreset });
  }

  const core110Json = await readFile(new URL("../../packages/cms/test/fixtures/core-framework-default-preset-1.1.0.json", import.meta.url));
  const core110ReferenceCss = (await readFile(new URL("../../packages/cms/test/fixtures/core-framework-css-1.1.0-default.min.css", import.meta.url), "utf8")).trim();
  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-framework-1.1.0.json",
    mimeType: "application/json",
    buffer: core110Json,
  });
  await expect(cssImport).toContainText("Preset Core 1.1.0 riconosciuto: Histeon Publish ha rigenerato il CSS dalle impostazioni e dagli stili salvati.");
  await expect(cssImport).toContainText("restano non applicate le conversioni di compatibilità browser di postcss-preset-env");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const generatedCoreStyles = await cmsRequest<{ globals: Array<{
    css: string;
    source?: { name: string; preset?: { format: string; data: string } };
  }> }>(env, `${projectBase}/styles`);
  const generatedCoreSheet = generatedCoreStyles.globals.find((sheet) => sheet.source?.preset?.format === "core-json-v1");
  expect(generatedCoreSheet).toBeDefined();
  expect(generatedCoreSheet?.source?.preset?.data).toBe(core110Json.toString("utf8"));
  expect(generatedCoreSheet?.css.replace(/^html\s*\{[^}]*\}\s*/u, "").replace(/\s/gu, "")).toBe(core110ReferenceCss);

  const hoverPreset = JSON.parse(core110Json.toString("utf8")) as Record<string, unknown>;
  const hoverPreferences = hoverPreset.preferences as Record<string, unknown>;
  hoverPreset.preferences = { ...hoverPreferences, postcss_hover_media: true, postcss_easing_gradients: true };
  const hoverStyleSheets = hoverPreset.styleSheetData as Record<string, unknown>;
  hoverPreset.styleSheetData = {
    ...hoverStyleSheets,
    designStyles: [
      ...(Array.isArray(hoverStyleSheets.designStyles) ? hoverStyleSheets.designStyles : []),
      {
        id: "hover-media-e2e",
        name: "Hover media E2E",
        cssObjects: [{
          id: "hover-media-rule-e2e",
          selector: ".hover-media-e2e, .hover-media-e2e:hover",
          declarations: [{ id: "hover-media-color-e2e", property: "color", value: "red" }],
        }],
      },
      {
        id: "easing-gradient-e2e",
        name: "Easing gradient E2E",
        cssObjects: [{
          id: "easing-gradient-rule-e2e",
          selector: ".easing-gradient-e2e",
          declarations: [{ id: "easing-gradient-value-e2e", property: "background", value: "linear-gradient(#000, ease-in-out, #fff)" }],
        }],
      },
    ],
  };
  const hoverPresetJson = JSON.stringify(hoverPreset);
  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-framework-hover-media.json",
    mimeType: "application/json",
    buffer: Buffer.from(hoverPresetJson, "utf8"),
  });
  await expect(cssImport).toContainText("PostCSS Core applica i gradienti easing e la trasformazione hover media");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const savedHoverStyles = await cmsRequest<{ globals: Array<{
    css: string;
    source?: { preset?: { format: string; data: string } };
  }> }>(env, `${projectBase}/styles`);
  const savedHoverSheet = savedHoverStyles.globals.find((sheet) => sheet.source?.preset?.data === hoverPresetJson);
  expect(savedHoverSheet?.css).toContain("@media (hover: hover)");
  expect(savedHoverSheet?.css).toContain(".hover-media-e2e:hover");
  expect(savedHoverSheet?.css).toContain(".easing-gradient-e2e");
  const savedEasingRule = savedHoverSheet?.css.match(/\.easing-gradient-e2e\s*\{[^}]*\}/su)?.[0] ?? "";
  expect(savedEasingRule).toContain("linear-gradient(hsl(");
  expect(savedEasingRule).not.toContain("ease-in-out");

  const unsupportedCorePreset = {
    id: "core-unsupported-e2e",
    name: "Core preset da conservare",
    description: "Contiene un modulo non rigenerato da Histeon Publish",
    date: "2026-10-24",
    app_version: "1.1.0",
    modulesData: { CORE_MODULE_NOT_SUPPORTED: { enabled: true } },
  };
  const unsupportedCoreJson = Buffer.from(JSON.stringify(unsupportedCorePreset), "utf8");
  const fallbackCoreCss = ".fallback-core{display:grid}";
  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".css,text/css"]').setInputFiles({
    name: "fallback-core.css",
    mimeType: "text/css",
    buffer: Buffer.from(fallbackCoreCss, "utf8"),
  });
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-unsupported.json",
    mimeType: "application/json",
    buffer: unsupportedCoreJson,
  });
  await expect(cssImport).toContainText("Preset Core riconosciuto e conservato. Il CSS scelto separatamente sarà applicato al sito.");
  await expect(cssImport).toContainText("Il preset Core 1.1.0 è stato conservato, ma il CSS non è stato rigenerato:");
  await expect(cssImport).toContainText("Importa il CSS esportato da Core Framework.");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const preservedUnsupportedStyles = await cmsRequest<{ globals: Array<{
    css: string;
    source?: { preset?: { format: string; data: string } };
  }> }>(env, `${projectBase}/styles`);
  const preservedUnsupportedSheet = preservedUnsupportedStyles.globals.find((sheet) => sheet.source?.preset?.data === unsupportedCoreJson.toString("utf8"));
  expect(preservedUnsupportedSheet?.source?.preset?.format).toBe("core-json-v1");
  expect(preservedUnsupportedSheet?.css).toBe(fallbackCoreCss);

  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-unsupported-css-second.json",
    mimeType: "application/json",
    buffer: unsupportedCoreJson,
  });
  await expect(cssImport).toContainText("Il modulo Core CORE_MODULE_NOT_SUPPORTED non è supportato dal generatore.");
  await cssImport.locator('input[accept=".css,text/css"]').setInputFiles({
    name: "fallback-core-css-second.css",
    mimeType: "text/css",
    buffer: Buffer.from(fallbackCoreCss, "utf8"),
  });
  await expect(cssImport).toContainText("Preset Core conservato; nel sito verrà usato il CSS selezionato separatamente.");
  await expect(cssImport).toContainText("Il modulo Core CORE_MODULE_NOT_SUPPORTED non è supportato dal generatore.");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const preservedAfterReverseImport = await cmsRequest<{ globals: Array<{
    css: string;
    source?: { preset?: { data: string } };
  }> }>(env, `${projectBase}/styles`);
  const reverseImportedSheet = preservedAfterReverseImport.globals.find((sheet) => sheet.source?.preset?.data === unsupportedCoreJson.toString("utf8"));
  expect(reverseImportedSheet?.css).toBe(fallbackCoreCss);

  const darkModeCorePreset = {
    id: "core-dark-mode-e2e",
    name: "Core preset con colore dark",
    description: "Contiene un valore dark mode senza flag esplicito",
    date: "2026-10-24",
    app_version: "1.1.0",
    modulesData: { COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand", value: "#123456", darkValue: "#abcdef" }] }] } },
  };
  const darkModeCoreJson = Buffer.from(JSON.stringify(darkModeCorePreset), "utf8");
  await page.getByRole("button", { name: "Importa CSS" }).click();
  await cssImport.locator('input[accept=".core,.json,application/json"]').setInputFiles({
    name: "core-dark-mode.json",
    mimeType: "application/json",
    buffer: darkModeCoreJson,
  });
  await expect(cssImport).toContainText("Preset Core 1.1.0 riconosciuto: Histeon Publish ha rigenerato il CSS dalle impostazioni e dagli stili salvati.");
  await cssImport.getByLabel("Confermo di poter usare e conservare nel progetto il CSS, il preset o la configurazione selezionati.").check();
  await cssImport.getByRole("button", { name: "Aggiungi foglio CSS" }).click();
  await expect(cssImport).toBeHidden();
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const darkModeStyles = await cmsRequest<{ globals: Array<{
    css: string;
    source?: { preset?: { format: string; data: string } };
  }> }>(env, `${projectBase}/styles`);
  const preservedDarkModeSheet = darkModeStyles.globals.find((sheet) => sheet.source?.preset?.data === darkModeCoreJson.toString("utf8"));
  expect(preservedDarkModeSheet?.source?.preset?.format).toBe("core-json-v1");
  expect(preservedDarkModeSheet?.css).toContain(":root.cf-theme-dark");
  expect(preservedDarkModeSheet?.css).toContain("--brand: #abcdef;");

  const saved = await cmsRequest<{ content: string }>(env, `${projectBase}/documents/${pageAlias}`);
  expect(saved.content).toContain("Testo persistito nel builder");
  expect(saved.content).toContain("__cms-media");
  const styles = await cmsRequest<{ compiledCss: string }>(env, `${projectBase}/styles`);
  expect(styles.compiledCss).toContain("rgb(1, 2, 3)");
  expect(media.some((item) => item.title.rendered === "cms-pixel.png" && item.source_url.includes("__cms-media"))).toBe(true);

  // Imported responsive framework classes autocomplete with their CSS rule preview.
  const htmlEditor = page.locator('.cm-content[aria-label="Codice HTML"]');
  await setCode(page, "Codice HTML", '<div class="md:grid"></div>');
  for (let step = 0; step < 8; step += 1) await htmlEditor.press("ArrowLeft");
  await htmlEditor.press("Control+Space");
  const classOptions = page.locator(".cm-tooltip-autocomplete li");
  const responsiveOption = classOptions.filter({ hasText: "md:grid-cols-2" }).first();
  await expect(responsiveOption).toBeVisible();
  await responsiveOption.hover();
  await expect(page.locator(".cm-completionInfo")).toContainText(".md\\:grid-cols-2 { display: grid; }");
  await htmlEditor.press("Escape");

  // Returning to the catalog closes the editor tab; opening the same page creates a fresh editor session.
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await openBuilder(page, "Home");
  const reopenedHtml = page.locator('.cm-content[aria-label="Codice HTML"]');
  await expect(reopenedHtml).toContainText("Testo persistito nel builder");
  await expect(reopenedHtml).toContainText("cms-media");
  await expect(page.locator('.cm-content[aria-label="CSS globale"]')).toContainText("rgb(1, 2, 3)");

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await openBuilder(page, "Pagina Due");
  await expect(page.getByRole("button", { name: "Nuovo componente" })).toBeVisible();
  await setCode(page, "Codice HTML", "<main><h1>Seconda pagina verificata</h1></main>");
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Seconda pagina verificata");
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const savedPageTwo = await cmsRequest<{ content: string }>(env, `${projectBase}/documents/${pageTwo!.alias}`);
  expect(savedPageTwo.content).toContain("Seconda pagina verificata");
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await openBuilder(page, "Pagina Due");
  await expect(page.locator('.cm-content[aria-label="Codice HTML"]')).toContainText("Seconda pagina verificata");
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await openBuilder(page, "Home");

  const secondEditor = await page.context().newPage();
  trackUnsupportedWordPressRequests(secondEditor, unsupportedWordPressRequests);
  await secondEditor.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(secondEditor.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await secondEditor.goto(editorUrl);
  await expect(secondEditor.getByRole("button", { name: "Nuovo componente" })).toBeVisible();
  await setCode(page, "Codice HTML", "<main><h1>Prima modifica concorrente</h1></main>");
  await setCode(secondEditor, "Codice HTML", "<main><h1>Seconda modifica concorrente</h1></main>");
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
  const conflictResponsePromise = secondEditor.waitForResponse((response) => response.url().includes(`${projectBase}/documents/${pageAlias}`) && response.request().method() === "POST");
  await secondEditor.getByRole("button", { name: "Salva", exact: true }).click();
  const conflictResponse = await conflictResponsePromise;
  expect(conflictResponse.status()).toBe(409);
  expect(await conflictResponse.json()).toMatchObject({
    code: "cms-revision-conflict",
    conflict: { proposedContent: expect.stringContaining("Seconda modifica concorrente") },
  });
  await expect(secondEditor.getByRole("status")).toContainText("un’altra finestra", { timeout: 10_000 });
  const current = await cmsRequest<{ content: string }>(env, `${projectBase}/documents/${pageAlias}`);
  expect(current.content).toContain("Prima modifica concorrente");
  expect(unsupportedWordPressRequests).toEqual([]);
  await secondEditor.close();
});

test("il gestore dei media del builder mostra una volta sola un'immagine caricata due volte con gli stessi byte", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const created = await cmsRequest<{ project: { id: string } }>(env, "/api/cms/v1/projects", { method: "POST", body: JSON.stringify({ name: `E2E media ripetuto ${Date.now()}` }) });
  const projectBase = `/api/cms/v1/projects/${created.project.id}`;
  const home = (await cmsRequest<{ pages: Array<{ alias: number }> }>(env, projectBase)).pages[0];
  if (!home) throw new Error("Pagina mancante.");
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/cms-editor.html?project=${created.project.id}&document=${home.alias}`);
  await page.getByRole("button", { name: "Aggiungi un elemento" }).first().click();
  await page.getByRole("option", { name: "Immagine dalla libreria…" }).click();
  const picker = page.getByRole("dialog", { name: "Gestore dei media" });
  await expect(picker).toBeVisible();
  // «Originale» sends the file as it is: the second upload has the bytes of the first, and the server answers with the
  // image it already holds (as when a damaged file is uploaded again to repair it).
  await picker.getByLabel("Compressione prima del caricamento").selectOption({ label: "Originale" });
  const image = { name: "ripetuta.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kRZ0AAAAASUVORK5CYII=", "base64") };
  const ids: unknown[] = [];
  for (let round = 0; round < 2; round += 1) {
    const answer = page.waitForResponse((response) => response.url().includes(`${projectBase}/media?`) && response.request().method() === "POST");
    await picker.locator('input[type="file"][accept="image/*"]').setInputFiles(image);
    const response = await answer;
    expect(response.ok()).toBe(true);
    ids.push((await response.json() as { id: unknown }).id);
    // The upload row goes away once every upload is shown in the grid.
    await expect(picker.getByRole("list", { name: "Caricamenti" })).toBeHidden({ timeout: 10_000 });
  }
  expect(ids[1]).toBe(ids[0]);
  // Before: Svelte threw each_key_duplicate (the grid is keyed by id) and the grid stayed as it was.
  await expect(picker.locator("ul.grid > li")).toHaveCount(1);
  expect(pageErrors).toEqual([]);
  // The image is still the one to choose.
  await picker.getByRole("button", { name: "ripetuta.png", exact: true }).click();
  await expect(picker).toBeHidden();
  expect(pageErrors).toEqual([]);
});
