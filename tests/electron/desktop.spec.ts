import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, test } from "@playwright/test";
import { newProject, openBuilder } from "../e2e/cms-helpers";

test("avvia il desktop isolato e carica l'interfaccia via app://", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "histos-publish-electron-"));
  const userDataDirectory = path.join(temporaryDirectory, "electron-user-data");
  const dataDirectory = path.join(temporaryDirectory, "app-data");
  const mainFile = path.resolve("packages/desktop/dist/main.js");
  const packagedElectron = process.env.HISTOS_PUBLISH_ELECTRON_PATH;
  const env = { ...process.env, HISTOS_PUBLISH_DATA_DIR: dataDirectory };
  delete env.HISTOS_CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.HISTOS_CLOUDFLARE_ACCOUNT_ID;
  delete env.HISTOS_WP_BASIC_USER;
  delete env.HISTOS_WP_BASIC_PASSWORD;
  delete env.HISTOS_WP_COOKIE;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let editorMayHaveUnsavedChanges = false;

  try {
    application = await electron.launch({
      ...(packagedElectron ? { executablePath: packagedElectron, cwd: path.dirname(packagedElectron) } : {}),
      args: ["--no-sandbox", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []), `--user-data-dir=${userDataDirectory}`, ...(packagedElectron ? [] : [mainFile])],
      env,
      timeout: 60_000,
    });
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
    expect(page.url()).toMatch(/^app:\/\/histos-publish\//u);
    const bootstrapStatus = await page.evaluate(async () => {
      const token = sessionStorage.getItem("histos-publish-session") ?? "";
      return (await fetch("/api/bootstrap", { headers: { "X-Histos-Token": token } })).status;
    });
    expect(bootstrapStatus).toBe(200);

    const cspErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /unsafe-eval/u.test(message.text())) cspErrors.push(message.text());
    });
    const projectName = `Electron CMS ${Date.now()}`;
    // The same steps as the browser tests: «Nuovo sito», then the builder from the row of the page.
    await newProject(page, projectName);
    await openBuilder(page, "Home");
    editorMayHaveUnsavedChanges = true;
    await expect(page.getByRole("button", { name: "Nuovo componente" })).toBeVisible();
    await expect(page.locator("header .status")).not.toHaveText(/Caricamento/u);
    expect(cspErrors).toEqual([]);
    const saveButton = page.getByRole("button", { name: "Salva", exact: true });
    if (await saveButton.isEnabled()) {
      await saveButton.click();
    }
    await expect(saveButton).toBeDisabled();
    editorMayHaveUnsavedChanges = false;
  } finally {
    if (application) {
      if (editorMayHaveUnsavedChanges) await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await application.close();
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
