import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { expect, test } from "@playwright/test";

/**
 * Doc 17 item 4 in the app: the prototype check with its preview opens the built pages in a hidden window at 1440 and
 * 390 px. A page wider than 390 px and a field without a label are warnings of the report; the manual's kit has none.
 */
test("il controllo del prototipo nell'app apre le pagine nella finestra nascosta: scorrimento e axe sono avvisi", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "histos-publish-electron-verify-"));
  const env = { ...process.env, HISTOS_PUBLISH_DATA_DIR: path.join(temporaryDirectory, "app-data") };
  delete env.HISTOS_CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_TOKEN;
  const packagedElectron = process.env.HISTOS_PUBLISH_ELECTRON_PATH;
  const kit = await readFile(path.resolve("packages/cms/assets/kit-minimo.html"), "utf8");
  const broken = kit.replace("<p>Graffa", '<img src="asset:f1" width="900" height="600" alt="Larga"/><input name="cognome"/><p>Graffa');
  expect(broken).not.toBe(kit);
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
    const check = (html: string) => page.evaluate(async (body) => {
      const response = await fetch("/api/cms/v1/projects/import-prototype?check=1&preview=1", { method: "POST", headers: { "X-Histos-Token": sessionStorage.getItem("histos-publish-session") ?? "", "Content-Type": "text/html; charset=utf-8" }, body });
      return { status: response.status, body: await response.json() as { report: { warnings: string[] }; preview: { status: string; verify?: { opened?: number; overflow?: { page: string; width: number }[]; axe?: { id: string }[] } } } };
    }, html);

    const failing = await check(broken);
    expect(failing.status).toBe(200);
    expect(failing.body.preview.status).toBe("ready");
    expect(failing.body.preview.verify?.opened).toBeGreaterThan(5);
    expect(failing.body.preview.verify?.overflow).toEqual([expect.objectContaining({ page: "/", width: 390 })]);
    expect(failing.body.preview.verify?.axe?.map((rule) => rule.id)).toEqual(["label"]);
    expect(failing.body.report.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Scorrimento orizzontale a 390 px: la pagina \/ è larga 9\d\d px \(sporge img\)/u),
      expect.stringMatching(/^Accessibilità, regola axe label, gravità critica: .* 1 elemento in \/ \(per esempio input\[name="cognome"\]\)/u),
    ]));

    const clean = await check(kit);
    expect(clean.status).toBe(200);
    expect(clean.body.preview.verify).toMatchObject({ overflow: [], axe: [] });
    expect(clean.body.preview.verify?.opened).toBeGreaterThan(5);
    expect(clean.body.report.warnings).toEqual([]);
  } finally {
    await application?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
