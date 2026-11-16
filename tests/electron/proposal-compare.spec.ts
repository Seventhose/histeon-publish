import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, test } from "@playwright/test";

/**
 * «Uguale alla proposta» in the desktop app, with the real hidden window: a project born from a captured proposal
 * shows the section in «Pronto per andare online?», the comparison photographs the kept original beside the site
 * «con i token» and «senza», and «Guarda fianco a fianco» frames the two sites. The proposal is invented.
 *
 * The kept original is untrusted: before the comparison the test plants a script and a handler in it that would paint
 * the page black. If either ran, in the hidden window or in the frame, the original would differ everywhere.
 *
 * The viewer gives the <body> of each page classes of its own, as real proposals do («vista-menu», and «con-entrate»
 * only where something enters on scroll), with rules one sees: «senza» is the same to the pixel only if the
 * conversion keeps those rules on their page. The strip has a gradient and a shadow with the colours of the page: with
 * the tokens they are written in another way (oklch), and the why must not call that a difference.
 */
const VIEWER = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Proposte</title>
<style>body{margin:0;font-family:sans-serif}header{height:40px}iframe{display:block;width:100%;height:calc(100vh - 40px);border:0}</style></head>
<body><header><button id="vai-menu" onclick="location.hash='#p01/menu'">Menu</button></header>
<iframe id="vista" title="Proposta"></iframe>
<script>/* ${"x".repeat(4200)} */
const stile = 'body{margin:0;font-family:Arial,sans-serif;color:#222;background:#fff}h1{margin:40px;font-size:40px;color:#a22}p{margin:40px;font-size:18px}.fascia{height:1400px;margin:40px;background:#f0e6d8 radial-gradient(at 30% 20%, #a22, rgba(0,0,0,0) 60%);box-shadow:0 2px 8px rgba(34,34,34,.3);transform:rotate(3deg)}.con-entrate .entra.dentro{transform:none}.vista-menu h1{margin-top:160px;color:#124}body.vista-menu{background:#f4f8ff}';
const pagine = { home: '<h1>Trattoria</h1><p><a href="#p01/menu">Il menu</a></p><div class="fascia entra dentro"></div>', menu: '<h1>Menu del giorno</h1><p><a href="#p01/home">Torna alla home</a></p>' };
function disegna() {
  const pagina = (location.hash.split("/")[1] || "home");
  const doc = document.getElementById("vista").contentDocument;
  doc.open();
  doc.write('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Trattoria · ' + pagina + '</title><style>' + stile + '</style></head><body>' + pagine[pagina] + '</body></html>');
  doc.close();
  doc.body.className = "vista-" + pagina + (doc.querySelector(".entra") ? " con-entrate" : "");
}
addEventListener("hashchange", disegna);
if (!location.hash) history.replaceState(null, "", "#p01/home");
disegna();
</script></body></html>`;

interface Count { differentPixels: number; totalPixels: number; causes?: { paired: number; properties: Array<{ property: string; count: number; examples: string[] }> } }
interface Answer { kept: boolean; available: boolean; running: boolean; failed: string | null; result: { pages: Array<{ name: string; path: string; found: { withTokens: boolean; withoutTokens: boolean }; widths: Array<{ width: number; withTokens: Count | null; withoutTokens: Count | null }> }>; notes: string[] } | null }

test("nell'app «Uguale alla proposta» fotografa la proposta e il sito, con i token e senza, e li mostra fianco a fianco", async () => {
  test.setTimeout(240_000);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "histos-publish-electron-compare-"));
  const dataDirectory = path.join(temporaryDirectory, "app-data");
  const env = { ...process.env, HISTOS_PUBLISH_DATA_DIR: dataDirectory };
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
    await page.getByTestId("cms-import-input").setInputFiles({ name: "trattoria-confronto.html", mimeType: "text/html", buffer: Buffer.from(VIEWER) });

    // The proposal is captured as a person does it: two pages added from the sealed frame, then imported.
    const dialog = page.getByTestId("cms-proposal-capture");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const viewer = page.frameLocator('[data-testid="cms-proposal-capture-frame"]');
    await expect(viewer.frameLocator("#vista").getByRole("heading", { name: "Trattoria" })).toBeVisible();
    const add = dialog.getByTestId("cms-proposal-capture-add");
    await expect(add).toBeEnabled();
    await add.click();
    await expect(dialog.getByTestId("cms-proposal-capture-pages").getByRole("listitem")).toHaveCount(1);
    await viewer.locator("#vai-menu").click();
    await expect(viewer.frameLocator("#vista").getByRole("heading", { name: "Menu del giorno" })).toBeVisible();
    await add.click();
    await expect(dialog.getByTestId("cms-proposal-capture-pages").getByRole("listitem")).toHaveCount(2);
    await dialog.getByTestId("cms-proposal-capture-import").click();
    const check = page.getByTestId("cms-prototype-check");
    await expect(check).toBeVisible({ timeout: 60_000 });
    await check.getByTestId("cms-prototype-import").click();
    await expect(page.getByRole("heading", { name: "trattoria-confronto", exact: true, level: 1 })).toBeVisible({ timeout: 60_000 });

    // The capture is kept with the project. A script and a handler planted in it must never run.
    const projects = path.join(dataDirectory, "histos-projects");
    let home = "";
    await expect.poll(async () => {
      for (const id of await readdir(projects).catch(() => [])) {
        const candidate = path.join(projects, id, "proposal", "site", "index.html");
        if (await readFile(candidate, "utf8").then(() => true, () => false)) home = candidate;
      }
      return home;
    }, { timeout: 30_000 }).not.toBe("");
    const original = await readFile(home, "utf8");
    expect(original).toContain("Trattoria");
    const black = "document.documentElement.style.setProperty('filter','invert(1)');document.body.style.setProperty('background','#000','important')";
    await writeFile(home, original.replace("<body", `<body onload="${black}"`).replace("</body>", `<script>${black}</script></body>`));

    await page.getByTestId("admin-section-pubblica").click();
    await page.locator(".cms-unified-publish").getByTestId("cms-site-check").click();
    const section = page.getByTestId("cms-proposal-match");
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(section).toContainText("Uguale alla proposta");
    await expect(section.getByTestId("cms-proposal-match-state")).toHaveAttribute("data-state", "unchecked");
    await expect(section.getByTestId("cms-proposal-match-state")).toHaveText("non controllata");

    // The comparison: followed until it ends, then read as the app read it.
    const finished = page.waitForResponse(async (response) => {
      if (!new URL(response.url()).pathname.endsWith("/admin/proposal-compare") || response.request().method() !== "GET") return false;
      const body = await response.json().catch(() => null) as Answer | null;
      return Boolean(body && !body.running && (body.result || body.failed));
    }, { timeout: 180_000 });
    // While the hidden window photographs, the test looks into it from the main process: scrolled down a page, the
    // page must be as wide as the window. A scrollbar of the window would take 15 pixels from «390 px».
    const widths = application.evaluate(async ({ BrowserWindow }) => {
      const seen: Array<[number, number]> = [];
      for (let turn = 0; turn < 9000 && seen.length < 6; turn++) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed() || !/^http:\/\/127\.0\.0\.1:\d+\//u.test(window.webContents.getURL())) continue;
          const sizes = await window.webContents.executeJavaScript("[innerWidth, document.documentElement.clientWidth, scrollY]").catch(() => null) as [number, number, number] | null;
          if (sizes && sizes[2] > 0) seen.push([sizes[0], sizes[1]]);
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      return seen;
    });
    await section.getByTestId("cms-proposal-match-run").click();
    const answer = await (await finished).json() as Answer;
    const seen = await widths;
    expect(seen.length).toBeGreaterThan(0);
    for (const [windowWidth, pageWidth] of seen) expect(pageWidth).toBe(windowWidth);
    expect(answer.failed).toBeNull();
    expect(answer.available).toBe(true);
    expect(answer.result?.notes).toEqual([]);
    expect(answer.result?.pages.map((item) => [item.name, item.path, item.found.withTokens, item.found.withoutTokens])).toEqual([["Home", "/", true, true], ["Menu", "/menu/", true, true]]);
    for (const item of answer.result?.pages ?? []) {
      expect(item.widths.map((row) => row.width)).toEqual([1280, 390]);
      for (const row of item.widths) {
        for (const count of [row.withTokens, row.withoutTokens]) {
          expect(count).not.toBeNull();
          // Whole rows of the width asked, a screen at least; and a page that is mostly the same: had the planted
          // script run, the original would be inverted and nearly every pixel would differ.
          expect((count?.totalPixels ?? 0) % row.width).toBe(0);
          expect(count?.totalPixels ?? 0).toBeGreaterThanOrEqual(row.width * 900);
          expect((count?.differentPixels ?? Infinity) / (count?.totalPixels ?? 1)).toBeLessThan(0.25);
        }
        // Converted as it is, the proposal is the same to the pixel: the rules written on the classes of each page's
        // <body> (the strip that stays straight, the heading of the menu lower and blue) still hold on their page.
        expect(row.withoutTokens?.differentPixels).toBe(0);
      }
    }
    expect(answer.result?.pages[0]?.widths[0]?.withTokens?.totalPixels).toBeGreaterThan(1280 * 900);
    // The why: where the two pages differ, the survey taken in the hidden window paired their elements.
    for (const item of answer.result?.pages ?? []) for (const row of item.widths) if (row.withTokens?.differentPixels) expect(row.withTokens.causes?.paired).toBeGreaterThanOrEqual(3);
    // The same colours inside a gradient and a shadow, however each site writes them, are not a cause.
    const causes = (answer.result?.pages ?? []).flatMap((item) => item.widths.flatMap((row) => [row.withTokens, row.withoutTokens].flatMap((count) => count?.causes?.properties ?? [])));
    expect(causes.filter((cause) => /backgroundImage|boxShadow|textShadow/u.test(cause.property))).toEqual([]);
    if (process.env.HISTOS_SHOW_CAUSES) console.log(JSON.stringify(causes));

    await expect(section.getByTestId("cms-proposal-match-state")).toHaveAttribute("data-state", "checked");
    const table = section.getByTestId("cms-proposal-match-table");
    await expect(table.getByRole("row")).toHaveCount(5);
    await expect(table).toContainText("Con i token");
    await expect(table).toContainText("Senza");
    await expect(table.getByTestId("cms-proposal-match-withTokens")).toHaveCount(4);
    await expect(table.getByTestId("cms-proposal-match-withoutTokens")).toHaveCount(4);
    for (const cell of await table.getByRole("cell").filter({ hasNotText: "px" }).allTextContents()) expect(cell).toMatch(/^(uguale|(< )?\d+,\d\d %)$/u);
    if (answer.result?.pages.some((item) => item.widths.some((row) => row.withTokens?.causes))) {
      const why = section.getByTestId("cms-proposal-match-why");
      await why.locator("summary").click();
      await expect(why.getByRole("heading", { level: 4 }).first()).toContainText("Con i token");
    }

    // Side by side: the original on the capture origin, the site in the app's closed preview, both without scripts.
    await section.getByTestId("cms-proposal-match-view").click();
    const left = section.getByTestId("cms-proposal-match-original");
    const right = section.getByTestId("cms-proposal-match-built");
    await expect(left).toHaveAttribute("src", /^http:\/\/127\.0\.0\.1:\d+\/__original\/[A-Za-z0-9_-]{32}\/$/u);
    await expect(right).toHaveAttribute("src", /^\/__preview\/[A-Za-z0-9_-]{32}\/[0-9a-f-]{36}\/$/u);
    expect(await left.getAttribute("sandbox")).toBe("");
    expect(await right.getAttribute("sandbox")).toBe("");
    for (const frame of ["cms-proposal-match-original", "cms-proposal-match-built"]) {
      const shown = page.frameLocator(`[data-testid="${frame}"]`);
      await expect(shown.getByRole("heading", { name: "Trattoria" })).toBeVisible({ timeout: 30_000 });
      // The planted script and handler did not run here either.
      expect(await shown.locator("html").evaluate((element) => getComputedStyle(element).filter)).toBe("none");
    }
    // The other page, at the phone's width.
    const frames = section.getByTestId("cms-proposal-match-frames");
    await frames.getByLabel("Pagina").selectOption({ label: "Menu" });
    await frames.getByLabel("Larghezza").selectOption({ label: "390 px" });
    await expect(left).toHaveAttribute("src", /\/__original\/[A-Za-z0-9_-]{32}\/menu\/$/u);
    await expect(page.frameLocator('[data-testid="cms-proposal-match-original"]').getByRole("heading", { name: "Menu del giorno" })).toBeVisible({ timeout: 30_000 });
    await expect(page.frameLocator('[data-testid="cms-proposal-match-built"]').getByRole("heading", { name: "Menu del giorno" })).toBeVisible({ timeout: 30_000 });
    expect(await left.evaluate((element) => (element as HTMLIFrameElement).style.width)).toBe("390px");
  } finally {
    await application?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
