import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HAS_ZSTD, sampleCanvas, zip } from "../../packages/cms/test/fig-writer.js";
import { newProject, openProjectTab } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string; figmaToken: string; figmaKey: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function openImport(page: Page, env: E2EState, name: string) {
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await newProject(page, name);
  await openProjectTab(page, "Impostazioni");
  const block = page.getByTestId("cms-token-import");
  await expect(block).toBeVisible();
  return block;
}

// Note penpot-figma-a-histeon.md, phase 2 in the app: «Importa token di design» takes a JSON of tokens, a whole
// .penpot file and a whole .fig file; the two design files are uploaded and the server answers their tokens.
test("Importa token di design: un JSON, un file .penpot e un file .fig danno il rapporto e si applicano", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const block = await openImport(page, env, `Token da file ${Date.now()}`);
  const field = block.getByTestId("cms-token-import-file");
  await expect(field).toHaveAttribute("accept", /\.penpot/u);
  await expect(field).toHaveAttribute("accept", /\.fig/u);
  const report = block.getByTestId("cms-token-import-report");

  // A plain JSON of tokens, read in the page.
  await field.setInputFiles({ name: "chiaro.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ color: { $type: "color", primary: { $value: "#1d4ed8" } } })) });
  await expect(report).toContainText("Rapporto, niente è stato ancora salvato.");
  await expect(report).toContainText("Parametri del design: 1.");
  await expect(report).toContainText("chiaro.json");

  // A whole .penpot file: told by its bytes, uploaded, and its one line of summary opens the report.
  const id = "11111111-1111-4111-8111-111111111111";
  const penpot = await zip({
    "manifest.json": JSON.stringify({ type: "penpot/export-files", version: 1, generatedBy: "penpot/2.5.4", files: [{ id, name: "Kit Penpot" }] }),
    [`files/${id}/colors/22222222-2222-4222-8222-222222222222.json`]: JSON.stringify({ name: "Primary", path: "Primary", color: "#6750a4", opacity: 1 }),
  });
  const uploaded = page.waitForRequest((request) => request.url().includes("/tokens/source/file?name=kit.penpot") && request.method() === "POST");
  await field.setInputFiles({ name: "kit.penpot", mimeType: "application/octet-stream", buffer: penpot });
  expect((await uploaded).headers()["content-type"]).toBe("application/octet-stream");
  await expect(report).toContainText("Kit Penpot: file Penpot");
  await expect(report).toContainText("kit.penpot");
  await expect(report).not.toContainText("chiaro.json");
  await expect(report).toContainText("Parametri del design: 1.");

  // A whole .fig file, with its dark theme inside; then «Applica al progetto» saves on the revision of the report.
  test.skip(!HAS_ZSTD, "questo Node non ha zstd: il file .fig di prova non si scrive");
  const fig = await zip({ "canvas.fig": sampleCanvas(), "meta.json": JSON.stringify({ file_name: "Kit di prova" }) });
  await field.setInputFiles({ name: "Kit.fig", mimeType: "application/octet-stream", buffer: fig });
  await expect(report).toContainText("Kit di prova: file .fig di Figma");
  await expect(report).toContainText("Rapporto, niente è stato ancora salvato.");
  await block.getByTestId("cms-token-import-apply").click();
  await expect(report).toContainText("Token applicati al progetto.");
  await expect(block.getByTestId("cms-token-import-apply")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// The token is typed once, kept by the server (here a keyring in memory) and never shown again: not in the field,
// not in the page, not in what the page keeps. The address of the file is all that goes with a read.
test("Da Figma: il token si salva e non si rivede, il file si legge dall'API simulata, il token si rimuove", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const sent: Array<{ url: string; body: string }> = [];
  page.on("request", (request) => { if (request.url().includes("/api/")) sent.push({ url: request.url(), body: request.postData() ?? "" }); });
  const block = await openImport(page, env, `Token da Figma ${Date.now()}`);
  const figma = block.getByTestId("cms-token-import-figma");
  const tokenState = figma.getByTestId("cms-figma-token-state");
  // Another test of this run may have left a token in the shared keyring: start from none.
  if (await figma.getByTestId("cms-figma-token-remove").count()) await figma.getByTestId("cms-figma-token-remove").click();
  await expect(tokenState).toHaveText("Nessun token di Figma salvato.");
  await expect(figma.getByTestId("cms-figma-address")).toHaveCount(0);
  const secret = figma.getByTestId("cms-figma-token");
  await expect(secret).toHaveAttribute("type", "password");
  await expect(figma.getByTestId("cms-figma-token-save")).toBeDisabled();

  // A token Figma refuses is not saved, and the message does not repeat it.
  const wrong = `${env.figmaToken}-sbagliato`;
  await secret.fill(wrong);
  await figma.getByTestId("cms-figma-token-save").click();
  await expect(page.getByText("Figma non riconosce questo token.")).toBeVisible();
  await expect(secret).toHaveValue("");
  await expect(tokenState).toHaveText("Nessun token di Figma salvato.");

  await secret.fill(env.figmaToken);
  await figma.getByTestId("cms-figma-token-save").click();
  await expect(tokenState).toContainText("Token di Figma salvato nel portachiavi di questo computer.");
  await expect(tokenState).toContainText("Account: Prova.");
  await expect(secret).toHaveValue("");

  await figma.getByTestId("cms-figma-address").fill(`https://www.figma.com/design/${env.figmaKey}/Kit-dell-API?node-id=0-1`);
  await figma.getByTestId("cms-figma-read").click();
  const report = block.getByTestId("cms-token-import-report");
  await expect(report).toContainText("Kit dell'API");
  await expect(report).toContainText("Rapporto, niente è stato ancora salvato.");
  await expect(report).toContainText("Parametri del design:");
  await block.getByTestId("cms-token-import-apply").click();
  await expect(report).toContainText("Token applicati al progetto.");

  // Nowhere in the page, in its storage, or in a request other than the one that saved it.
  for (const token of [env.figmaToken, wrong]) {
    expect(await page.content()).not.toContain(token);
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(token);
  }
  const carrying = sent.filter((request) => `${request.url}\n${request.body}`.includes(env.figmaToken));
  expect(carrying.map((request) => new URL(request.url).pathname)).toEqual(["/api/cms/v1/figma-token", "/api/cms/v1/figma-token"]);
  const answer = await page.evaluate(async (session) => (await fetch("/api/cms/v1/figma-token", { headers: { "X-Histos-Token": session } })).text(), env.token);
  expect(answer).not.toContain(env.figmaToken);
  expect(JSON.parse(answer)).toEqual({ token: { configured: true, source: "keyring", available: true } });

  // After a reload the token is still there, and still not shown.
  await page.reload();
  await openProjectTab(page, "Impostazioni");
  await expect(tokenState).toHaveText("Token di Figma salvato nel portachiavi di questo computer.");
  await expect(figma.getByTestId("cms-figma-token")).toHaveValue("");

  await figma.getByTestId("cms-figma-token-remove").click();
  await expect(tokenState).toHaveText("Nessun token di Figma salvato.");
  await expect(figma.getByTestId("cms-figma-address")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
