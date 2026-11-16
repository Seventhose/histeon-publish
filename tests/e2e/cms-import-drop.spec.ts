import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CmsProjectCatalog, encodeNativeProjectArchive, encodeStaticPageProfileArchive } from "@histos-publish/cms";
import type { StaticPageProfile } from "@histos-publish/histos-contract";
import { expect, test } from "@playwright/test";
import { backToSites, builderButton, openProjectTab } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }
interface ProfileFixture { profile: StaticPageProfile; files: Record<string, string> }

async function dropArchive(page: import("@playwright/test").Page, filename: string, archive: Buffer): Promise<void> {
  await page.locator(".cms-import-drop-zone").evaluate((element, payload) => {
    const raw = atob(payload.base64);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.filename, { type: "application/zip" }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { filename, base64: archive.toString("base64") });
}

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

test("importa un progetto .xbsite trascinato nel catalogo CMS", async ({ page }) => {
  const env = await state();
  const fixture = JSON.parse(await readFile(new URL("../../packages/histos-contract/test/fixtures/histos-static-project-v2.json", import.meta.url), "utf8")) as ProfileFixture;
  const files = new Map(Object.entries(fixture.files).map(([name, encoded]) => [name, Buffer.from(encoded, "base64")]));
  const archive = await encodeStaticPageProfileArchive(fixture.profile, files);
  const nativeRoot = await mkdtemp(path.join(tmpdir(), "histos-e2e-native-import-"));
  let nativeArchive: Buffer;
  const nativeCatalog = new CmsProjectCatalog(nativeRoot);
  const native = await nativeCatalog.createProject("Fixture backup completo");
  try {
    nativeArchive = await encodeNativeProjectArchive(native.project, native.store);
  } finally {
    native.store.close();
    await rm(nativeRoot, { recursive: true, force: true });
  }

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const dropZone = page.locator(".cms-import-drop-zone");
  await expect(dropZone).toBeVisible();

  await dropArchive(page, "histos-fixture.xbsite", archive);

  await expect(page.getByRole("heading", { name: "Fixture CMS template", exact: true })).toBeVisible();
  await openProjectTab(page, "Pagine");
  await expect(builderButton(page, "Pagina modello")).toBeVisible();
  await openProjectTab(page, "Modelli e parti");
  await expect(page.locator(".site-card").filter({ hasText: "site/page" })).toBeVisible();

  await backToSites(page);
  await expect(page.locator(".cms-import-drop-zone")).toBeVisible();
  await dropArchive(page, "histos-backup.histosproject", nativeArchive);
  await expect(page.getByRole("heading", { name: "Fixture backup completo", exact: true })).toBeVisible();
  await openProjectTab(page, "Pagine");
  await expect(builderButton(page, "Home")).toBeVisible();
});
