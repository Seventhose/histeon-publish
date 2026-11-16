import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);
interface E2EState { baseUrl: string; token: string; dataDirectory: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("un invio a WordPress con rimozioni si approva solo dopo averle viste; «Senza chiedere» chiede conferma (E8); il permesso si sceglie nel sito", async ({ page, request }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
  const projectId = crypto.randomUUID();
  const imported = await request.post(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { headers: { ...headers, "Content-Type": "text/html" }, data: example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", projectId) });
  expect(imported.status()).toBe(201);
  // A connected WordPress site for that project, as a pairing would leave it (the plan and the send are faked).
  const { CmsRemoteCatalog } = await import(path.resolve("packages/server/dist/cms-remote.js"));
  const remote = new CmsRemoteCatalog(env.dataDirectory);
  const connectionId = crypto.randomUUID();
  try {
    remote.add({ id: connectionId, url: "https://dev.esempio.test", siteId: crypto.randomUUID(), projectId, projectName: "Galleria", profile: "histos-static-project-v4", read: true, write: true, publish: false });
  } finally {
    remote.close();
  }

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  // Settings points to the "Agente AI" screen, where the connector lives (E10).
  await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
  await page.locator(".settings-tabs").getByRole("button", { name: "Dati e privacy" }).click();
  await page.getByTestId("settings-open-agent").click();
  const section = page.getByTestId("connector-section");
  if ((await section.getAttribute("data-enabled")) !== "true") await page.getByTestId("connector-enable").click();
  // The "Agente AI" screen only shows the permission: it is chosen next to the connection, in the site itself.
  const shown = page.locator(`[data-testid="connector-wordpress-mode"][data-connection-id="${connectionId}"]`);
  await expect(shown).toHaveText("Mai", { timeout: 15_000 });
  await page.locator(".connector-site", { has: shown }).getByTestId("connector-wordpress-open").click();
  const linked = page.locator("#cms-linked-sites");
  await expect(linked).toBeVisible({ timeout: 15_000 });
  const select = linked.locator(`[data-testid="cms-agent-send-mode"][data-connection-id="${connectionId}"]`);
  await expect(select).toHaveValue("off", { timeout: 15_000 });
  await expect(linked.getByRole("button", { name: "Scollega" })).toBeVisible();

  // "Senza chiedere" asks first, naming the site; cancelling keeps the current mode.
  await select.selectOption("auto");
  const autoDialog = page.getByTestId("cms-agent-auto-dialog");
  await expect(autoDialog).toContainText("dev.esempio.test");
  await autoDialog.getByRole("button", { name: "Annulla" }).click();
  await expect(autoDialog).toBeHidden();
  await expect(select).toHaveValue("off");
  // «Solo prove» (item 203): the server refuses the agent's real send, with nothing to approve.
  await select.selectOption("dry-run");
  await expect(linked.getByTestId("cms-agent-send-saved")).toHaveText("✓ Salvato");
  await expect(select).toHaveValue("dry-run");
  const client = path.join(env.dataDirectory, "connector", "histos-publish-connector.mjs");
  const refused = await run(process.execPath, [client, "push", projectId, connectionId, "--data-dir", env.dataDirectory]).then(() => null, (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`);
  expect(refused).toContain("connector-wordpress-dry-run-only");
  await expect(page.getByTestId("connector-approval")).toBeHidden();
  await select.selectOption("confirm");
  // The choice saves itself, and says so beside the menu (item 191).
  await expect(linked.getByTestId("cms-agent-send-saved")).toHaveText("✓ Salvato");
  await expect(select).toHaveValue("confirm");

  const pushed = await run(process.execPath, [client, "push", projectId, connectionId, "--data-dir", env.dataDirectory]);
  expect(pushed.stdout).toContain("\"state\": \"pending\"");

  const banner = page.getByTestId("connector-approval");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle(/^\(1\) Conferma invio/u);
  await expect(page.getByTestId("connector-chip")).toContainText("1 da confermare");
  await expect(banner).toContainText("1 nuovo, 1 rimosso");
  await expect(banner).not.toContainText("conflitt");
  const approve = banner.getByTestId("connector-approve");
  await expect(approve).toBeDisabled();
  await banner.locator("summary", { hasText: "Cosa cambia" }).click();
  await expect(banner).toContainText("Vecchia opera");
  await expect(banner).toContainText("record");
  await expect(banner.getByTestId("connector-approval-seen")).toBeVisible();
  await expect(banner).toContainText("Ho visto la rimozione");
  await banner.getByTestId("connector-approval-seen").check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(page).not.toHaveTitle(/Conferma invio/u);
  // Off again, as the other tests expect to find it: back on the "Agente AI" screen, left for the site above.
  await page.locator(".sidebar").getByRole("button", { name: "Agente AI" }).click();
  await page.getByTestId("connector-stop").click();
  await expect(page.getByTestId("connector-enable")).toBeVisible();
});
