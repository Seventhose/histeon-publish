import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, test } from "@playwright/test";

/**
 * «Fotografa la proposta» in the desktop app: the interface lives on app://, the proposal's sealed frame on a port of
 * its own on 127.0.0.1. The app's policy must let that one origin be framed, and the frame's policy must accept the
 * app as its ancestor. The proposal is invented: a viewer whose scripts write the page into a frame of its own.
 */
const VIEWER = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Proposte</title>
<style>body{margin:0;font-family:sans-serif}header{height:40px}iframe{display:block;width:100%;height:calc(100vh - 40px);border:0}</style></head>
<body><header><button id="vai-menu" onclick="location.hash='#p01/menu'">Menu</button> <output id="prove"></output></header>
<iframe id="vista" title="Proposta"></iframe>
<script>/* ${"x".repeat(4200)} */
const pagine = { home: '<h1>Trattoria</h1><p><a href="#p01/menu">Il menu</a></p>', menu: '<h1>Menu del giorno</h1><p><a href="#p01/home">Torna alla home</a></p>' };
function disegna() {
  const pagina = (location.hash.split("/")[1] || "home");
  const doc = document.getElementById("vista").contentDocument;
  doc.open();
  doc.write('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Trattoria · ' + pagina + '</title><style>h1{color:#a22}</style></head><body>' + pagine[pagina] + '</body></html>');
  doc.close();
}
addEventListener("hashchange", disegna);
if (!location.hash) history.replaceState(null, "", "#p01/home");
disegna();
(async () => {
  const esiti = [];
  try { void parent.document.title; esiti.push("app:letta"); } catch { esiti.push("app:chiusa"); }
  try { await fetch("/api/bootstrap"); esiti.push("api:raggiunta"); } catch { esiti.push("api:chiusa"); }
  document.getElementById("prove").textContent = esiti.join(" ");
})();
</script></body></html>`;

test("nell'app una proposta disegnata da script si apre nel riquadro chiuso e le pagine aggiunte diventano il progetto", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "histos-publish-electron-capture-"));
  const env = { ...process.env, HISTOS_PUBLISH_DATA_DIR: path.join(temporaryDirectory, "app-data") };
  delete env.HISTOS_CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_TOKEN;
  const packagedElectron = process.env.HISTOS_PUBLISH_ELECTRON_PATH;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      ...(packagedElectron ? { executablePath: packagedElectron, cwd: path.dirname(packagedElectron) } : {}),
      args: ["--no-sandbox", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []), `--user-data-dir=${path.join(temporaryDirectory, "electron-user-data")}`, ...(packagedElectron ? [] : [path.resolve("packages/desktop/dist/main.js")])],
      env,
      timeout: 60_000,
    });
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
    await page.getByTestId("cms-import-input").setInputFiles({ name: "trattoria-app.html", mimeType: "text/html", buffer: Buffer.from(VIEWER) });

    const dialog = page.getByTestId("cms-proposal-capture");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).protocol).toBe("app:");
    expect(await dialog.getByTestId("cms-proposal-capture-frame").getAttribute("src")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__capture\/[A-Za-z0-9_-]{32}\/$/u);
    const viewer = page.frameLocator('[data-testid="cms-proposal-capture-frame"]');
    await expect(viewer.frameLocator("#vista").getByRole("heading", { name: "Trattoria" })).toBeVisible();
    await expect(viewer.locator("#prove")).toHaveText("app:chiusa api:chiusa");

    const add = dialog.getByTestId("cms-proposal-capture-add");
    await expect(add).toBeEnabled();
    await add.click();
    const pages = dialog.getByTestId("cms-proposal-capture-pages").getByRole("listitem");
    await expect(pages).toHaveCount(1);
    await viewer.locator("#vai-menu").click();
    await expect(viewer.frameLocator("#vista").getByRole("heading", { name: "Menu del giorno" })).toBeVisible();
    await add.click();
    await expect(pages).toHaveCount(2);

    await dialog.getByTestId("cms-proposal-capture-import").click();
    const check = page.getByTestId("cms-prototype-check");
    await expect(check).toBeVisible({ timeout: 60_000 });
    await expect(check.getByTestId("cms-conversion-notes")).toContainText("proposta fotografata: 2 pagine (Home, Menu)");
    await check.getByTestId("cms-prototype-import").click();
    await expect(page.getByRole("heading", { name: "trattoria-app", exact: true, level: 1 })).toBeVisible({ timeout: 60_000 });
  } finally {
    await application?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
