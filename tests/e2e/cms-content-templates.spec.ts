import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { openProject, openProjectTab, prepareSite } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function cmsJson<T>(env: E2EState, route: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(new URL(route, env.baseUrl), {
    method,
    headers: { Origin: env.baseUrl, "X-Histos-Token": env.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`CMS test request ${method} ${route} failed (${response.status}): ${result.error ?? "errore non specificato"}`);
  return result;
}

test("associa template Histeon dal pannello Contenuti e li usa per scheda e archivio pubblici", async ({ page }) => {
  const env = await state();
  const projectName = `E2E template tipi ${Date.now()}`;
  const { project } = await cmsJson<{ project: { id: string } }>(env, "/api/cms/v1/projects", "POST", { name: projectName });
  const projectPath = `/api/cms/v1/projects/${project.id}`;
  const single = await cmsJson<{ id: number; head: string; ref: string; schema: unknown }>(env, `${projectPath}/templates`, "POST", { title: "Scheda notizia", ref: "content/news-single" });
  const archive = await cmsJson<{ id: number; head: string; ref: string; schema: unknown }>(env, `${projectPath}/templates`, "POST", { title: "Archivio notizie", ref: "content/news-archive" });
  const singleContent = '<!-- wp:xb/element {"uid":"e2esingleroot","tag":"article"} --><!-- wp:xb/element {"uid":"e2esingletitle","tag":"h1"} --><!-- wp:xb/text {"uid":"e2esingletext","content":"{page.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"e2esinglesummary","tag":"p"} --><!-- wp:xb/text {"uid":"e2esinglesummarytext","content":"{page.meta.summary}"} /--><!-- /wp:xb/element --><!-- wp:xb/slot {"uid":"e2esingleslot","name":"default"} /--><!-- /wp:xb/element -->';
  const archiveContent = '<!-- wp:xb/element {"uid":"e2earchiveroot","tag":"main"} --><!-- wp:xb/element {"uid":"e2earchivetitle","tag":"h1"} --><!-- wp:xb/text {"uid":"e2earchivetext","content":"{page.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/loop {"uid":"e2earchiveloop","source":{"kind":"preset","id":"recent_news"},"as":"item"} --><!-- wp:xb/element {"uid":"e2earchiveitem","tag":"h2"} --><!-- wp:xb/text {"uid":"e2earchiveitemtext","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop --><!-- wp:xb/slot {"uid":"e2earchiveslot","name":"default"} /--><!-- /wp:xb/element -->';
  for (const template of [
    { ...single, content: singleContent },
    { ...archive, content: archiveContent },
  ]) {
    await cmsJson(env, `${projectPath}/documents/${template.id}`, "POST", { head: template.head, ref: template.ref, schema: template.schema, content: template.content });
  }

  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await openProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();

  await openProjectTab(page, "Contenuti");
  await page.getByRole("button", { name: "＋ Nuovo tipo" }).click();
  await page.getByLabel("Nome visibile").fill("Notizie");
  await page.getByLabel("Nome tecnico").fill("news");
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row input").first().fill("Summary");
  await page.getByLabel("Modello pagina dettaglio").selectOption(single.ref);
  await page.getByLabel("Modello pagina archivio").selectOption(archive.ref);
  await page.getByRole("button", { name: "Crea tipo" }).click();
  await expect(page.getByRole("heading", { name: "Notizie", exact: true })).toBeVisible();
  const savedTypes = await cmsJson<{ types: Array<{ key: string; singleTemplateRef: string | null; archiveTemplateRef: string | null }> }>(env, `${projectPath}/types`);
  expect(savedTypes.types.find((item) => item.key === "news")).toMatchObject({ singleTemplateRef: single.ref, archiveTemplateRef: archive.ref });

  await page.locator(".record-editor").getByLabel("Titolo").fill("Notizia con modello");
  await page.getByLabel("Stato").selectOption("published");
  await page.locator(".record-field input").first().fill("Testo creato dal modulo Contenuti");
  await page.getByRole("button", { name: "Salva record" }).click();
  await expect(page.getByRole("button", { name: /Notizia con modello/u })).toBeVisible();

  await cmsJson(env, `${projectPath}/query-presets`, "POST", { key: "recent_news", label: "Notizie recenti", typeKey: "news", limit: 10, orderBy: "title", order: "asc", expectedHead: null });
  const projectDetails = await cmsJson<{ pages: Array<{ alias: number; slug: string; headRevision: string }> }>(env, projectPath);
  const home = projectDetails.pages.find((item) => item.slug === "home");
  if (!home) throw new Error("La pagina iniziale del progetto non esiste.");
  await cmsJson(env, `${projectPath}/pages/${home.alias}`, "PATCH", { status: "published", head: home.headRevision });

  const buildResponse = page.waitForResponse((response) => response.url().includes(`${projectPath}/build`) && response.request().method() === "POST");
  await prepareSite(page);
  const build = await (await buildResponse).json() as { status: string; previewUrl: string | null; findings?: unknown[] };
  expect(build.status, JSON.stringify(build.findings)).toBe("ready");
  expect(build.previewUrl).toBeTruthy();

  const base = new URL("./", build.previewUrl!);
  const singlePage = await fetch(new URL("news/notizia-con-modello/index.html", base));
  expect(singlePage.status).toBe(200);
  const singleHtml = await singlePage.text();
  expect(singleHtml).toContain("<h1>Notizia con modello</h1>");
  expect(singleHtml).toContain("Testo creato dal modulo Contenuti");
  const archivePage = await fetch(new URL("news/index.html", base));
  expect(archivePage.status).toBe(200);
  const archiveHtml = await archivePage.text();
  expect(archiveHtml).toContain("<h1>Notizie</h1>");
  expect(archiveHtml).toContain("<h2>Notizia con modello</h2>");
});
