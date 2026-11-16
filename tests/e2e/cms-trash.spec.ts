import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject, tickRows } from "./cms-helpers.js";
import { expectDialogFitsMobile } from "./responsive-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("prepara una cancellazione recuperabile dalla schermata del progetto", async ({ page }) => {
  const env = await state();
  const connectionId = "6a1d2a67-b34f-4dde-a234-1c678ebc8b10";
  let trashRequest: { connectionId: string; entityIds: string[] } | null = null;

  await page.route("**/api/cms/v1/connections**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { connections: [{
        id: connectionId,
        url: "https://wordpress.example.test",
        siteId: "c7f66b89-81c2-4e34-9513-c4f1886decc3",
        projectId: null,
        projectName: "WordPress di prova",
        profile: "histos-static-project-v3",
        read: true,
        write: true,
        publish: false,
        connectedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      }] } });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/cms/v1/projects/*/trash", async (route) => {
    trashRequest = route.request().postDataJSON() as { connectionId: string; entityIds: string[] };
    await route.fulfill({ json: { deleted: [], recoveryAvailable: true, remoteSyncRequired: true } });
  });

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, `E2E Cestino ${Date.now()}`);

  await expect(page.getByRole("heading", { name: "Bacheca", exact: true })).toBeVisible();
  await tickRows(page, ["Home"]);
  await expect(page.getByText("1 selezionato", { exact: true })).toBeVisible();
  await page.locator(".admin-bulk").getByRole("button", { name: "Sposta nel Cestino" }).click();
  const confirmation = page.getByRole("dialog", { name: "Spostare gli elementi nel Cestino?" });
  await expect(confirmation).toBeVisible();
  await expectDialogFitsMobile(page, confirmation);
  // The project has a WordPress site linked: the deletion can be prepared for it, and nothing is chosen at the start.
  const destination = confirmation.getByLabel("Dove preparare la cancellazione");
  await expect(destination).toHaveValue("");
  await destination.selectOption(connectionId);
  await expect(confirmation.getByText(/WordPress non viene modificato/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Prepara nel Cestino →" }).click();

  await expect.poll(() => trashRequest).toMatchObject({ connectionId, entityIds: [expect.any(String)] });
  await expect(page.getByText(/Elementi spostati nel Cestino locale/u)).toBeVisible();
});

test("sposta nel cestino solo locale quando non è scelto un sito WordPress", async ({ page }) => {
  const env = await state();
  let trashRequest: { connectionId?: string; entityIds: string[] } | null = null;

  // A linked site is what brings the dialog: without one the page goes to the Cestino at once (cms-admin.spec.ts).
  await page.route("**/api/cms/v1/connections**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { connections: [{
        id: "6a1d2a67-b34f-4dde-a234-1c678ebc8b11",
        url: "https://wordpress.example.test",
        siteId: "c7f66b89-81c2-4e34-9513-c4f1886decc4",
        projectId: null,
        projectName: "WordPress di prova",
        profile: "histos-static-project-v3",
        read: true,
        write: true,
        publish: false,
        connectedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      }] } });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/cms/v1/projects/*/trash", async (route) => {
    trashRequest = route.request().postDataJSON() as { connectionId?: string; entityIds: string[] };
    await route.fulfill({ json: { deleted: [], recoveryAvailable: true, remoteSyncRequired: false, scope: "local" } });
  });

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, `E2E Cestino locale ${Date.now()}`);

  await expect(page.getByRole("heading", { name: "Bacheca", exact: true })).toBeVisible();
  await tickRows(page, ["Home"]);
  await page.locator(".admin-bulk").getByRole("button", { name: "Sposta nel Cestino" }).click();
  const confirmation = page.getByRole("dialog", { name: "Spostare gli elementi nel Cestino?" });
  await expect(confirmation).toBeVisible();
  await expectDialogFitsMobile(page, confirmation);
  await expect(confirmation.getByText(/non verrà inviata a WordPress/u)).toBeVisible();
  await confirmation.getByRole("button", { name: "Prepara nel Cestino →" }).click();

  await expect.poll(() => trashRequest).toMatchObject({ entityIds: [expect.any(String)] });
  expect(trashRequest).not.toHaveProperty("connectionId");
  await expect(page.getByText(/Cestino di questo progetto/u)).toBeVisible();
});
