import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

/**
 * An invented proposal: a viewer whose scripts write the page into a frame, one page per fragment of the address. Its
 * body holds almost no text: converted as it is, it would be an empty viewer. The scripts also try what a proposal
 * must not manage from inside the app's frame, and write the outcome on the page.
 */
const proposalFile = (appPort: string): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Proposte</title>
<style>body{margin:0;font-family:sans-serif}header{height:40px}iframe{display:block;width:100%;height:calc(100vh - 40px);border:0}</style></head>
<body><header><button id="vai-home" onclick="location.hash='#p01/home'">Home</button> <button id="vai-menu" onclick="location.hash='#p01/menu'">Menu</button> <output id="prove"></output></header>
<iframe id="vista" title="Proposta"></iframe>
<script>/* ${"x".repeat(4200)} */
const pagine = {
  home: '<h1>Trattoria</h1><p><a href="#p01/menu">Il menu</a></p><p class="rivela">Appare allo scorrimento</p>',
  menu: '<h1>Menu del giorno</h1><p><a href="#p01/home">Torna alla home</a></p>',
};
function disegna() {
  const pagina = (location.hash.split("/")[1] || "home");
  const doc = document.getElementById("vista").contentDocument;
  doc.open();
  doc.write('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Trattoria · ' + pagina + '</title><style>h1{color:#a22}.rivela{opacity:0}.rivela.visto{opacity:1}</style></head><body>' + pagine[pagina] + '</body></html>');
  doc.close();
  for (const nodo of doc.querySelectorAll(".rivela")) nodo.classList.add("visto");
}
addEventListener("hashchange", disegna);
if (!location.hash) history.replaceState(null, "", "#p01/home");
disegna();
(async () => {
  const esiti = [];
  try { void parent.document.title; esiti.push("app:letta"); } catch { esiti.push("app:chiusa"); }
  try { localStorage.setItem("x", "1"); esiti.push("archivio:aperto"); } catch { esiti.push("archivio:chiuso"); }
  try { await fetch("/api/bootstrap"); esiti.push("api:raggiunta"); } catch { esiti.push("api:chiusa"); }
  try { await fetch("http://127.0.0.1:${appPort}/api/bootstrap", { mode: "no-cors" }); esiti.push("app-api:raggiunta"); } catch { esiti.push("app-api:chiusa"); }
  document.getElementById("prove").textContent = esiti.join(" ");
})();
</script></body></html>`;

test("una proposta disegnata da script si apre viva in un riquadro chiuso, le pagine aggiunte diventano il sito", async ({ page }) => {
  const env = await state();
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: `trattoria-${tag}.html`, mimeType: "text/html", buffer: Buffer.from(proposalFile(new URL(env.baseUrl).port)) });

  const dialog = page.getByTestId("cms-proposal-capture");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("heading", { name: "Fotografa la proposta" })).toBeVisible();
  const frameElement = dialog.getByTestId("cms-proposal-capture-frame");
  await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
  // An origin of its own: another port of 127.0.0.1, never the app's.
  const address = new URL((await frameElement.getAttribute("src")) ?? "");
  expect(address.origin).not.toBe(new URL(env.baseUrl).origin);
  expect(address.hostname).toBe("127.0.0.1");
  expect(address.pathname).toMatch(/^\/__capture\/[A-Za-z0-9_-]{32}\/$/u);
  const viewer = page.frameLocator('[data-testid="cms-proposal-capture-frame"]');
  // The proposal is alive: its scripts drew the page in the viewer's own frame.
  await expect(viewer.frameLocator("#vista").getByRole("heading", { name: "Trattoria" })).toBeVisible();
  // And sealed: it reads nothing of the app and asks nothing of the local server. Its storage is its own origin's.
  await expect(viewer.locator("#prove")).toHaveText(`app:chiusa archivio:aperto api:chiusa app-api:chiusa`);
  expect(await page.evaluate(() => localStorage.getItem("x"))).toBeNull();

  const add = dialog.getByTestId("cms-proposal-capture-add");
  await expect(add).toBeEnabled();
  await expect(dialog.getByTestId("cms-proposal-capture-import")).toBeDisabled();
  await add.click();
  const pages = dialog.getByTestId("cms-proposal-capture-pages").getByRole("listitem");
  await expect(pages).toHaveCount(1);
  await expect(dialog.getByTestId("cms-proposal-capture-status")).toContainText("Pagina aggiunta: Home");
  await expect(pages.nth(0).getByRole("textbox")).toHaveValue("Home");

  // The person browses as the client would, then adds the page shown.
  await viewer.locator("#vai-menu").click();
  await expect(viewer.frameLocator("#vista").getByRole("heading", { name: "Menu del giorno" })).toBeVisible();
  await add.click();
  await expect(pages).toHaveCount(2);
  await expect(pages.nth(1).getByRole("textbox")).toHaveValue("Menu");
  await expect(pages.nth(1)).toContainText("#p01/menu");
  // The name is the person's to change.
  await pages.nth(1).getByRole("textbox").fill("Il menu");

  await dialog.getByTestId("cms-proposal-capture-import").click();
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeHidden();
  await expect(check).toHaveAttribute("data-outcome", "create");
  const notes = check.getByTestId("cms-conversion-notes");
  await expect(notes).toContainText("proposta fotografata: 2 pagine (Home, Il menu)");
  await expect(notes).toContainText("2 link della proposta collegati alle pagine fotografate");

  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name: `trattoria-${tag}`, exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
  const headers = { "X-Histos-Token": env.token, Origin: env.baseUrl };
  const projects = (await (await fetch(`${env.baseUrl}/api/cms/v1/projects`, { headers })).json()) as { projects: Array<{ id: string; name: string }> };
  const project = projects.projects.find((item) => item.name === `trattoria-${tag}`)!;
  const details = (await (await fetch(`${env.baseUrl}/api/cms/v1/projects/${project.id}`, { headers })).json()) as { pages: Array<{ slug: string }> };
  expect(details.pages.map((item) => item.slug).sort()).toEqual(["home", "il-menu"]);
  // The captured pages stay with the project: the original its site will be compared with.
  await expect.poll(async () => ((await (await fetch(`${env.baseUrl}/api/cms/v1/projects/${project.id}/admin/proposal`, { headers })).json()) as { kept: { pages: Array<{ name: string; path: string; hash: string }> } | null }).kept?.pages).toEqual([
    { name: "Home", path: "index.html", hash: "#p01/home" },
    { name: "Il menu", path: "il-menu/index.html", hash: "#p01/menu" },
  ]);

  // «Uguale alla proposta» in «Pronto per andare online?»: here there is no hidden window, so nothing is photographed
  // and the section says so; the two sites are still shown side by side, both without scripts.
  await page.getByTestId("admin-section-pubblica").click();
  await page.locator(".cms-unified-publish").getByTestId("cms-site-check").click();
  const match = page.getByRole("region", { name: "Uguale alla proposta" });
  await expect(match).toBeVisible({ timeout: 30_000 });
  await expect(match.getByTestId("cms-proposal-match-state")).toHaveText("non controllata");
  await expect(match.getByTestId("cms-proposal-match-app-only")).toHaveText("Il confronto con la proposta si fa nell’app desktop.");
  await expect(match.getByTestId("cms-proposal-match-run")).toHaveCount(0);
  await expect(match.getByTestId("cms-proposal-match-table")).toHaveCount(0);
  await match.getByTestId("cms-proposal-match-view").click();
  const original = match.getByTestId("cms-proposal-match-original");
  const built = match.getByTestId("cms-proposal-match-built");
  expect(await original.getAttribute("sandbox")).toBe("");
  expect(await built.getAttribute("sandbox")).toBe("");
  expect(new URL((await original.getAttribute("src")) ?? "").origin).not.toBe(new URL(env.baseUrl).origin);
  await expect(page.frameLocator('[data-testid="cms-proposal-match-original"]').getByRole("heading", { name: "Trattoria" })).toBeVisible();
  await expect(page.frameLocator('[data-testid="cms-proposal-match-built"]').getByRole("heading", { name: "Trattoria" })).toBeVisible();
});

test("«Converti il file com'è» salta la cattura; «Annulla» toglie il caricamento", async ({ page }) => {
  const env = await state();
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  const input = page.getByTestId("cms-import-input");
  await input.setInputFiles({ name: `visore-${tag}.html`, mimeType: "text/html", buffer: Buffer.from(proposalFile(new URL(env.baseUrl).port)) });
  const dialog = page.getByTestId("cms-proposal-capture");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const address = await dialog.getByTestId("cms-proposal-capture-frame").getAttribute("src");
  await dialog.getByRole("button", { name: "Annulla" }).click();
  await expect(dialog).toBeHidden();
  // The frame's address died with the upload.
  await expect.poll(async () => (await fetch(address ?? "")).status).toBe(404);

  await input.setInputFiles({ name: `visore-${tag}.html`, mimeType: "text/html", buffer: Buffer.from(proposalFile(new URL(env.baseUrl).port)) });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId("cms-proposal-capture-plain").click();
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 30_000 });
  await expect(check.getByTestId("cms-conversion-notes")).not.toContainText("proposta fotografata");
});
