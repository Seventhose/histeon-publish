import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject, openProject, openProjectTab, openRow, openTransfer, prepareSite, setPageStatus } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function setCode(page: import("@playwright/test").Page, label: string, source: string): Promise<void> {
  const editor = page.locator(`.cm-content[aria-label="${label}"]`);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("Control+A");
  await page.keyboard.insertText(source);
}

test("crea un template Histeon, lo assegna alla pagina e lo compila nel build", async ({ page }) => {
  const env = await state();
  const projectName = `E2E template CMS ${Date.now()}`;
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const projectCreated = page.waitForResponse((response) => response.url().endsWith("/api/cms/v1/projects") && response.request().method() === "POST");
  await newProject(page, projectName);
  const projectResponse = await projectCreated;
  const { project } = await projectResponse.json() as { project: { id: string } };
  const projectUrl = `${env.baseUrl}/api/cms/v1/projects/${encodeURIComponent(project.id)}`;
  const apiHeaders = { "X-Histos-Token": env.token, "Content-Type": "application/json", Origin: env.baseUrl };
  const stylesResponse = await page.request.get(`${projectUrl}/styles`, { headers: apiHeaders });
  const styles = await stylesResponse.json() as { styles: unknown[]; globals: unknown[]; head: string };
  const frameworkStyle = await page.request.post(`${projectUrl}/styles`, {
    headers: apiHeaders,
    data: { styles: styles.styles, globals: [{ id: "framework-core-framework", css: "", source: { kind: "user-css", frameworkId: "core-framework", name: "Core Framework", rightsConfirmed: true } }], head: styles.head },
  });
  expect(frameworkStyle.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();

  await openProjectTab(page, "Modelli e parti");
  await page.getByPlaceholder("Nome del modello").fill("Layout base");
  await page.getByPlaceholder("Chiave, es. site/page").fill("site/page");
  await page.getByRole("button", { name: "Crea modello" }).click();
  const templateCard = page.locator(".site-card").filter({ hasText: "site/page" });
  await expect(templateCard).toContainText("Slot pagina pronto");
  await templateCard.getByRole("button", { name: "Apri builder → Layout base", exact: true }).click();
  await expect(page.getByRole("button", { name: "Nuovo componente" })).toBeVisible();
  await setCode(page, "Codice HTML", "<header><h1>{props.page.title}</h1></header><main>{@slot}</main>");
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.locator("header .status")).toContainText("Salvato in sviluppo", { timeout: 15_000 });

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await openRow(page, "Home");
  const detail = page.getByTestId("admin-detail");
  await detail.getByLabel("Modello").selectOption("site/page");
  await expect(detail.getByLabel("Modello")).toHaveValue("site/page");
  await setPageStatus(page, "Home", "Nel sito");
  await expect(page.getByTestId("admin-table")).toContainText("Nel sito");

  const buildResponse = page.waitForResponse((response) => response.url().includes("/api/cms/v1/projects/") && response.url().endsWith("/build") && response.request().method() === "POST");
  await prepareSite(page);
  const build = await (await buildResponse).json() as { status: string; previewUrl: string | null };
  expect(build.status).toBe("ready");
  await expect(page.locator(".cms-build-result")).toContainText("Il preset Core Framework è conservato");
  await expect(page.locator(".cms-build-result")).toContainText("Avviso");
  await expect(page.locator(".cms-build-result")).toContainText("core-framework-css-missing");
  const html = await (await fetch(build.previewUrl!)).text();
  expect(html).toContain("<header><h1>Home</h1></header>");
  expect(html).toContain("<title>Home</title>");

  const projectTransfer = page.waitForEvent("download");
  await openTransfer(page);
  await page.getByRole("button", { name: "Esporta .xbsite" }).click();
  const archive = await projectTransfer;
  // A readable name: the project name and the day, not an id (E11).
  expect(archive.suggestedFilename()).toMatch(/^e2e-template-cms-\d+-\d{4}-\d{2}-\d{2}\.xbsite$/u);
  expect((await readFile(await archive.path())).subarray(0, 4)).toEqual(Buffer.from("504b0304", "hex"));

  await openProjectTab(page, "Pubblica");
  const staticDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Scarica sito statico .zip" }).click();
  expect((await staticDownload).suggestedFilename()).toMatch(/^e2e-template-cms-\d+-\d{4}-\d{2}-\d{2}-sito\.zip$/u);
  await expect(page.getByText("ZIP del sito statico scaricato.")).toBeVisible();
});
