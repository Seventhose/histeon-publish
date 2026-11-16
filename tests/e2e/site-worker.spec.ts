import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

// A page that carries its own server code: HTML and the Worker .js uploaded apart, a KV archive declared in the site.

interface E2EState { baseUrl: string; token: string; mockUrl: string; mockAccountId: string }
interface MockState {
  scripts: Record<string, { activeVersionId?: string; workerFirstRoutes: Array<string[] | true>; siteWorkers: Array<string | null>; kvBindings: Array<Array<{ name: string; namespace_id: string }>> }>;
  kvNamespaces: Array<{ id: string; title: string }>;
}

const WORKER = `export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/api/voto") return;
    return Response.json({ totale: Number(await env.VOTI.get("totale") ?? 0) });
  }
};
`;

async function readState(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

function mockHttpUrl(state: E2EState): string {
  return state.mockUrl.replace(/\/client\/v4$/u, "");
}

async function mockState(state: E2EState): Promise<MockState> {
  return await (await fetch(`${mockHttpUrl(state)}/__state`)).json() as MockState;
}

async function publish(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Prepara e pubblica/ }).click();
  const summary = page.getByTestId("site-deploy-summary");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await summary.getByRole("button", { name: /Conferma e pubblica/ }).click();
  await expect(summary).toBeHidden();
  await expect(page.getByText("Sito pronto e pubblicata su Cloudflare.")).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  const state = await readState();
  await fetch(`${mockHttpUrl(state)}/__reset`);
  await page.goto(`${state.baseUrl}/#token=${state.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
});

test("pubblica HTML e codice del Worker caricati a parte, con l’archivio KV che resta tra due pubblicazioni", async ({ page }) => {
  const state = await readState();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "voto.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><title>Voto</title></head><body><h1>Vota il logo</h1></body></html>"),
  });
  await page.getByLabel("Nome del sito").fill("Voto loghi");
  await page.getByLabel("Nome Worker").fill("loghi-voto");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Voto loghi" })).toBeVisible();

  // The Worker code goes in the site's source card, next to the HTML.
  const card = page.getByTestId("site-worker");
  await expect(card).toContainText("Nessun codice caricato a parte");
  await page.locator("#site-worker-js").setInputFiles({ name: "worker.js", mimeType: "text/javascript", buffer: Buffer.from(WORKER) });
  await expect(card).toContainText("Caricato: worker.js");

  // A file that is not a Worker module is refused with the reason.
  await page.locator("#site-worker-js").setInputFiles({ name: "altro.js", mimeType: "text/javascript", buffer: Buffer.from("console.log('ciao');\n") });
  await expect(page.getByText(/non è un modulo Worker/u)).toBeVisible();
  await expect(card).toContainText("Caricato: worker.js");

  await page.locator("#site-kv").fill("VOTI");
  await page.getByRole("button", { name: "Salva configurazione" }).click();
  await expect(page.locator("#site-kv")).toHaveValue("VOTI");

  await publish(page);
  await expect(page.getByTestId("build-worker-note")).toContainText("_worker.js");
  const first = await mockState(state);
  const script = first.scripts[`${state.mockAccountId}/loghi-voto`];
  expect(first.kvNamespaces.map((namespace) => namespace.title)).toEqual(["loghi-voto-VOTI"]);
  expect(script?.siteWorkers.at(-1)).toBe(WORKER);
  expect(script?.workerFirstRoutes.at(-1)).toBe(true);
  expect(script?.kvBindings.at(-1)).toEqual([{ name: "VOTI", namespace_id: first.kvNamespaces[0]?.id }]);

  // A second publication keeps both the code and the same KV archive.
  await publish(page);
  const second = await mockState(state);
  const again = second.scripts[`${state.mockAccountId}/loghi-voto`];
  expect(again?.activeVersionId).not.toBe(script?.activeVersionId);
  expect(second.kvNamespaces).toEqual(first.kvNamespaces);
  expect(again?.siteWorkers.at(-1)).toBe(WORKER);
  expect(again?.kvBindings.at(-1)).toEqual([{ name: "VOTI", namespace_id: first.kvNamespaces[0]?.id }]);

  // Removing the code goes back to Publish's own Worker on the next publication.
  await card.getByRole("button", { name: "Togli il codice" }).click();
  await expect(card).toContainText("Nessun codice caricato a parte");
});

test("scrive nel campo l’archivio KV che il codice usa appena caricato, e lo collega", async ({ page }) => {
  const state = await readState();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-html").setInputFiles({
    name: "voto.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><title>Voto</title></head><body><h1>Vota il logo</h1></body></html>"),
  });
  await page.getByLabel("Nome del sito").fill("Voto automatico");
  await page.getByLabel("Nome Worker").fill("loghi-auto");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Voto automatico" })).toBeVisible();
  await page.locator("#site-worker-js").setInputFiles({ name: "worker.js", mimeType: "text/javascript", buffer: Buffer.from(WORKER) });
  await expect(page.getByTestId("site-worker")).toContainText("Caricato: worker.js");
  // The archive the code uses is written into the field as soon as the code is uploaded, and saved.
  await expect(page.locator("#site-kv")).toHaveValue("VOTI=loghi-auto-VOTI");
  await expect(page.getByText(/Archivi KV trovati nel codice e aggiunti alla configurazione: VOTI=loghi-auto-VOTI/u)).toBeVisible();

  await publish(page);
  await expect(page.getByTestId("build-worker-note")).toContainText("Archivi KV usati dal codice: VOTI");
  const first = await mockState(state);
  expect(first.kvNamespaces.map((namespace) => namespace.title)).toEqual(["loghi-auto-VOTI"]);
  expect(first.scripts[`${state.mockAccountId}/loghi-auto`]?.kvBindings.at(-1)).toEqual([{ name: "VOTI", namespace_id: first.kvNamespaces[0]?.id }]);

  await publish(page);
  const second = await mockState(state);
  expect(second.kvNamespaces).toEqual(first.kvNamespaces);
  expect(second.scripts[`${state.mockAccountId}/loghi-auto`]?.kvBindings.at(-1)).toEqual([{ name: "VOTI", namespace_id: first.kvNamespaces[0]?.id }]);

  // A name typed in lower case and not saved: the field warns about the case, and publishing saves it first.
  await page.locator("#site-kv").fill("voti");
  await expect(page.getByTestId("site-kv-case")).toContainText("env.VOTI");
  await publish(page);
  const third = await mockState(state);
  expect(third.kvNamespaces.map((namespace) => namespace.title).sort()).toEqual(["loghi-auto-VOTI", "loghi-auto-voti"]);
  expect(third.scripts[`${state.mockAccountId}/loghi-auto`]?.kvBindings.at(-1)?.map((binding) => binding.name)).toEqual(["voti", "VOTI"]);
  await page.reload();
  await expect(page.locator("#site-kv")).toHaveValue("voti, VOTI=loghi-auto-VOTI");
});

test("uno ZIP con _worker.js scrive nel campo gli archivi KV alla prima versione", async ({ page }) => {
  const zip = zipSync({
    "index.html": strToU8("<!doctype html><html lang=\"it\"><head><title>Voto</title></head><body><h1>Vota il logo</h1></body></html>"),
    "_worker.js": strToU8(WORKER),
  });
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await page.locator("#file-zip").setInputFiles({ name: "loghi-voto.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByLabel("Nome del sito").fill("Voto da ZIP");
  await page.getByLabel("Nome Worker").fill("loghi-zip");
  await page.getByRole("button", { name: "Aggiungi sito" }).click();
  await expect(page.getByRole("heading", { name: "Voto da ZIP" })).toBeVisible();
  await expect(page.locator("#site-kv")).toHaveValue("");

  await publish(page);
  await expect(page.locator("#site-kv")).toHaveValue("VOTI=loghi-zip-VOTI");
  const state = await mockState(await readState());
  expect(state.kvNamespaces.map((namespace) => namespace.title)).toEqual(["loghi-zip-VOTI"]);
  await page.reload();
  await expect(page.locator("#site-kv")).toHaveValue("VOTI=loghi-zip-VOTI");
});
