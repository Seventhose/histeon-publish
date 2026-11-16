import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { staticSiteToPrototype } from "../../packages/cms/dist/static-site-prototype.js";

// The builder's first-run tour opens 1.2 s after load and covers the canvas: a click after it never reaches the page.
// These tests are someone who has seen it, as cms-helpers.ts openBuilder.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("xb-tour-done", "1"); } catch { /* no storage: the tour shows */ } });
});

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function siteFiles(root: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: new Uint8Array(await readFile(full)) });
    }
  };
  await walk(root);
  return out;
}

/** Doc 18 F5: the header and footer of a converted site become parts of its template; in the builder of a page a click on them says what they are, a double click opens the part. */
test("testata e piè diventati parti del template: un clic dice cosa sono, il doppio clic apre la parte (doc 18 F5)", async ({ page }) => {
  const env = await state();
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const id = crypto.randomUUID();
  const converted = staticSiteToPrototype({ projectId: id, name: `Taccuino ${id.slice(0, 8)}`, files: await siteFiles(path.resolve("packages/cms/test/fixtures/import-corpus/blog-statico")), structure: { parts: true } });
  const imported = await fetch(`${env.baseUrl}/api/cms/v1/projects/import-prototype`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: converted.html });
  expect(imported.status, await imported.clone().text()).toBeLessThan(300);
  const details = (await (await fetch(`${env.baseUrl}/api/cms/v1/projects/${id}`, { headers })).json()) as { pages: Array<{ alias: number; slug: string }> };
  const home = details.pages.find((item) => item.slug === "home") ?? details.pages[0]!;

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.goto(`${env.baseUrl}/cms-editor.html?project=${id}&document=${home.alias}`);
  const canvas = page.frameLocator("iframe[data-xb-canvas]");
  const title = canvas.locator("header .site-title");
  await expect(title).toHaveAttribute("data-xb-part", "site/header", { timeout: 30_000 });
  await title.click();
  await expect(page.getByText("Fa parte di site/header, una parte del template")).toBeVisible();
  // The page's own content stays selectable as before.
  await expect(canvas.locator("main h1").first()).not.toHaveAttribute("data-xb-part", /./u);
  await title.dblclick();
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Taccuino di viaggio", { timeout: 15_000 });

  // In the article editor's page preview, a click on the header opens its part in the builder (list item 93).
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/articolo-${home.alias}`);
  await expect(page.getByTestId("article-editor")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("article-page-preview").click();
  await page.frameLocator('[data-testid="article-page-frame"]').locator("header .site-title").click();
  await expect(page).toHaveURL(/cms-editor\.html\?project=[^&]+&document=\d+/u, { timeout: 15_000 });
  await expect(page.getByRole("tree", { name: "Elementi della pagina" })).toContainText("Taccuino di viaggio", { timeout: 15_000 });
});
