import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject, openProjectTab } from "./cms-helpers.js";
import { expectScreenFitsSupportedWidths } from "./responsive-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function cmsRequest<T>(env: E2EState, route: string): Promise<T> {
  const response = await fetch(new URL(route, env.baseUrl), {
    headers: { Origin: env.baseUrl, "X-Histos-Token": env.token },
  });
  if (!response.ok) throw new Error(`CMS fixture request failed (${response.status}): ${await response.text()}`);
  return await response.json() as T;
}

test("gestisce tipi, record localizzati, modifiche di schema e query dalla schermata Contenuti", async ({ page }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const projectName = `E2E CMS content manager ${Date.now()}`;
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await openProjectTab(page, "Impostazioni");
  await page.getByTestId("admin-locale").selectOption("en-US");
  await page.getByTestId("admin-settings-save").click();
  await expect(page.getByRole("status").getByText("Salvato.")).toBeVisible();

  await openProjectTab(page, "Contenuti");
  await page.getByRole("button", { name: "＋ Nuovo tipo" }).click();
  await page.getByLabel("Nome visibile").fill("Articoli");
  await page.getByLabel("Nome tecnico").fill("articoli");
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row input").first().fill("Descrizione");
  await page.locator(".field-builder-row select").selectOption("rich-text");
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row").last().locator("input").first().fill("Punteggio");
  await page.locator(".field-builder-row").last().locator("select").selectOption("integer");
  await page.getByRole("button", { name: "Crea tipo" }).click();

  await page.locator(".record-editor").getByLabel("Titolo").fill("Una prova localizzata");
  await page.locator(".record-editor").getByLabel(/Lingua/u).fill("en-US");
  await page.getByLabel("Stato").selectOption("published");
  await page.getByLabel(/Descrizione/u).fill("Testo del record");
  await page.getByLabel(/Punteggio/u).fill("42");
  await page.getByRole("button", { name: "Salva record" }).click();
  await expect(page.getByRole("button", { name: /Una prova localizzata/u })).toBeVisible();
  await page.getByRole("button", { name: "＋ Nuovo record" }).click();
  await page.locator(".record-editor").getByLabel("Titolo").fill("Secondo articolo");
  await page.getByLabel("Stato").selectOption("published");
  await page.getByLabel(/Punteggio/u).fill("41");
  await page.getByRole("button", { name: "Salva record" }).click();
  await expect(page.getByRole("button", { name: /Secondo articolo/u })).toBeVisible();

  const currentProjects = await cmsRequest<{ projects: Array<{ id: string; name: string }> }>(env, "/api/cms/v1/projects");
  const currentProjectId = currentProjects.projects.find((item) => item.name === projectName)?.id;
  if (!currentProjectId) throw new Error("Progetto CMS E2E non trovato.");
  for (let index = 1; index <= 51; index += 1) {
    const response = await fetch(new URL(`/api/cms/v1/projects/${currentProjectId}/records`, env.baseUrl), {
      method: "POST",
      headers: { Origin: env.baseUrl, "X-Histos-Token": env.token, "Content-Type": "application/json" },
      body: JSON.stringify({ typeKey: "articoli", title: `Record di prova ${String(index).padStart(2, "0")}`, status: "draft" }),
    });
    expect(response.status).toBe(201);
  }
  await page.getByRole("button", { name: "Cerca", exact: true }).click();
  await expect(page.locator(".record-pagination")).toContainText("53");
  await expect(page.getByRole("button", { name: "Successivi" })).toBeEnabled();
  await page.getByRole("button", { name: "Successivi" }).click();
  await expect(page.locator(".record-pagination")).toContainText("51–53 di 53");
  await page.getByRole("button", { name: "Precedenti" }).click();
  await expect(page.locator(".record-pagination")).toContainText("1–50 di 53");
  await page.locator("#cms-record-search").fill("Una prova localizzata");
  await page.getByRole("button", { name: "Cerca", exact: true }).click();
  await expect(page.getByRole("button", { name: /Una prova localizzata/u })).toBeVisible();
  await expect(page.locator(".record-pagination")).toContainText("1–1 di 1");

  await page.getByRole("button", { name: "Modifica campi" }).click();
  await expect(page.getByRole("heading", { name: "Modifica tipo di contenuto" })).toBeVisible();
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row").last().locator("input").first().fill("Sottotitolo");
  await page.getByRole("button", { name: "Salva struttura" }).click();
  await expect(page.locator(".content-alert[role='status']")).toContainText("Struttura aggiornata.");

  await page.getByLabel("Ordina per").selectOption("title");
  await page.getByLabel("Direzione").selectOption("asc");
  await page.getByLabel("Salta i primi").fill("1");
  await page.getByLabel("Filtro").selectOption("field");
  await page.getByLabel("Campo pubblico").selectOption("punteggio");
  await page.getByLabel("Condizione").selectOption("gte");
  await page.getByLabel("Valore", { exact: true }).fill("40");
  await page.getByPlaceholder("ultime_notizie").fill("ultimi_articoli");
  await page.getByPlaceholder("Ultime notizie").fill("Ultimi articoli");
  await page.getByRole("button", { name: "Salva query" }).click();
  const previewResponsePromise = page.waitForResponse((response) => response.url().includes("/query-presets/ultimi_articoli/preview"));
  await page.getByRole("button", { name: "Prova", exact: true }).click();
  const previewResponse = await previewResponsePromise;
  expect(previewResponse.status()).toBe(200);
  const preview = await previewResponse.json() as { items: unknown[] };
  expect(preview.items).toHaveLength(1);
  expect(preview.items[0]).toMatchObject({ title: "Una prova localizzata" });
  await expect(page.getByText("1 record restituito dalla query.")).toBeVisible();
  // The record's fields come as an object, not a list: the preview shows them without breaking the screen.
  await expect(page.locator(".query-preview")).toContainText("Una prova localizzata");
  await page.getByRole("button", { name: "Modifica", exact: true }).click();
  await expect(page.getByLabel("Ordina per")).toHaveValue("title");
  await expect(page.getByLabel("Salta i primi")).toHaveValue("1");
  await expect(page.getByLabel("Condizione")).toHaveValue("gte");
  await expect(page.getByRole("button", { name: "Aggiorna query" })).toBeEnabled();
  await page.getByLabel("Numero massimo").fill("5");
  await expect(page.getByRole("button", { name: "Aggiorna query" })).toBeEnabled();
  await page.getByRole("button", { name: "Aggiorna query" }).click();

  await page.getByRole("button", { name: "＋ Nuovo tipo" }).click();
  await page.locator("form.content-card").getByLabel("Nome visibile").fill("Autori");
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row input").first().fill("Biografia");
  await page.getByRole("button", { name: "Crea tipo" }).click();
  await expect(page.locator(".content-alert[role='status']")).toContainText("Tipo di contenuto creato.");
  await page.locator(".record-editor").getByLabel("Titolo", { exact: true }).fill("Autore Speciale");
  await page.getByLabel("Stato").selectOption("published");
  await page.getByRole("button", { name: "Salva record" }).click();

  await page.locator(".type-row").filter({ hasText: "Articoli" }).click();
  await page.getByRole("button", { name: "Modifica campi" }).click();
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row").last().locator("input").first().fill("Autore");
  await page.locator(".field-builder-row").last().locator("select").selectOption("relation");
  await page.getByLabel("Collega record di").selectOption("autori");
  const typeFormValidity = await page.locator("form.content-card").evaluate((form) => ({
    valid: (form as HTMLFormElement).checkValidity(),
    invalid: [...form.querySelectorAll<HTMLElement>(":invalid")].map((field) => ({ name: field.getAttribute("aria-label") ?? field.getAttribute("name") ?? field.tagName, value: field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : "" })),
  }));
  expect(typeFormValidity).toEqual({ valid: true, invalid: [] });
  await page.getByRole("button", { name: "Salva struttura" }).click();
  await expect(page.locator(".content-alert[role='status']")).toContainText("Struttura aggiornata.");
  const recordSearch = page.locator("#cms-record-search");
  await recordSearch.fill("Una prova localizzata");
  await expect(recordSearch).toHaveValue("Una prova localizzata");
  const filteredRecords = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/records") && url.searchParams.get("q") === "Una prova localizzata";
  });
  await page.getByRole("button", { name: "Cerca", exact: true }).click();
  const filteredResponse = await filteredRecords;
  expect(filteredResponse.status()).toBe(200);
  const filteredBody = await filteredResponse.json() as { items?: Array<{ title?: string }> };
  expect(filteredBody.items).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Una prova localizzata" })]));
  await page.getByRole("button", { name: /Una prova localizzata/u }).click();
  await page.locator("#relation-search-autore").fill("Autore Speciale");
  await page.getByRole("button", { name: "Cerca record" }).click();
  const relation = page.getByLabel("Record collegati per Autore");
  const authorOption = relation.locator("option").filter({ hasText: "Autore Speciale" });
  await expect(authorOption).toContainText("/autori/autore-speciale/");
  const authorId = await authorOption.getAttribute("value");
  expect(authorId).toBeTruthy();
  await relation.selectOption(authorId!);
  await page.getByRole("button", { name: "Salva record" }).click();
  await expectScreenFitsSupportedWidths(page);

  const queryForm = page.locator("form.query-form");
  await queryForm.getByLabel("Filtro").selectOption("field");
  await queryForm.getByLabel("Campo pubblico").selectOption("autore");
  await queryForm.getByLabel("Condizione").selectOption("eq");
  await queryForm.getByLabel("Cerca nel tipo collegato").fill("Autore Speciale");
  await queryForm.getByRole("button", { name: "Cerca", exact: true }).click();
  const linkedAuthor = queryForm.locator(".query-relation-select select");
  const linkedAuthorOption = linkedAuthor.locator("option").filter({ hasText: "/autori/autore-speciale/" });
  await expect(linkedAuthorOption).toHaveCount(1);
  await expect(linkedAuthorOption).toContainText("Autore Speciale");
  await linkedAuthor.selectOption(authorId!);
  await queryForm.getByPlaceholder("ultime_notizie").fill("articoli_per_autore");
  await queryForm.getByPlaceholder("Ultime notizie").fill("Articoli per autore");
  await queryForm.getByRole("button", { name: "Salva query" }).click();
  const relationPreviewResponsePromise = page.waitForResponse((response) => response.url().includes("/query-presets/articoli_per_autore/preview"));
  const relationQueryRow = page.locator(".query-row").filter({ hasText: "Articoli per autore" });
  await relationQueryRow.getByRole("button", { name: "Prova" }).click();
  const relationPreviewResponse = await relationPreviewResponsePromise;
  expect(relationPreviewResponse.status()).toBe(200);
  expect(await relationPreviewResponse.json()).toMatchObject({ items: [{ title: "Una prova localizzata" }] });
  await relationQueryRow.getByRole("button", { name: "Modifica" }).click();
  await expect(page.locator(".query-form .query-relation-select select")).toHaveValue(authorId!);

  await page.getByRole("button", { name: "＋ Nuovo tipo" }).click();
  const organizationType = page.locator("form.content-card");
  await organizationType.getByLabel("Nome visibile").fill("Organizzazioni");
  await organizationType.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await organizationType.locator(".field-builder-row input").first().fill("Nome");
  await organizationType.getByRole("button", { name: "Crea tipo" }).click();
  await expect(page.locator(".content-alert[role='status']")).toContainText("Tipo di contenuto creato.");
  await page.locator(".record-editor").getByLabel("Titolo", { exact: true }).fill("Studio Italiano");
  await page.getByLabel("Stato").selectOption("published");
  await page.locator(".record-editor").getByLabel("Nome · visibile").fill("Studio Italiano");
  await page.getByRole("button", { name: "Salva record" }).click();

  await page.locator(".type-row").filter({ hasText: "Autori" }).click();
  await page.getByRole("button", { name: "Modifica campi" }).click();
  await page.getByRole("button", { name: "＋ Aggiungi campo" }).click();
  await page.locator(".field-builder-row").last().locator("input").first().fill("Organizzazione");
  await page.locator(".field-builder-row").last().locator("select").selectOption("relation");
  await page.getByLabel("Collega record di").selectOption("organizzazioni");
  await page.getByRole("button", { name: "Salva struttura" }).click();
  await expect(page.locator(".content-alert[role='status']")).toContainText("Struttura aggiornata.");
  await page.locator(".record-row").filter({ hasText: "Autore Speciale" }).click();
  await page.locator("#relation-search-organizzazione").fill("Studio Italiano");
  await page.getByRole("button", { name: "Cerca record" }).click();
  const organizationRelation = page.getByLabel("Record collegati per Organizzazione");
  const organizationOption = organizationRelation.locator("option").filter({ hasText: "Studio Italiano" });
  await expect(organizationOption).toContainText("/organizzazioni/studio-italiano/");
  await organizationRelation.selectOption(await organizationOption.getAttribute("value") ?? "");
  await page.getByRole("button", { name: "Salva record" }).click();

  await page.locator(".type-row").filter({ hasText: "Articoli" }).click();
  const nestedQueryForm = page.locator("form.query-form");
  await nestedQueryForm.getByLabel("Campo pubblico").selectOption("autore.organizzazione.nome");
  const nestedOption = nestedQueryForm.getByLabel("Campo pubblico").locator("option").filter({ hasText: "Autore → Organizzazione → Nome" });
  await expect(nestedOption).toHaveCount(1);
  await nestedQueryForm.getByLabel("Valore", { exact: true }).fill("Studio Italiano");
  await nestedQueryForm.getByRole("button", { name: "Aggiorna query" }).click();
  const nestedPreviewResponsePromise = page.waitForResponse((response) => response.url().includes("/query-presets/articoli_per_autore/preview"));
  await page.locator(".query-row").filter({ hasText: "Articoli per autore" }).getByRole("button", { name: "Prova" }).click();
  const nestedPreviewResponse = await nestedPreviewResponsePromise;
  expect(nestedPreviewResponse.status()).toBe(200);
  expect(await nestedPreviewResponse.json()).toMatchObject({ items: [{ title: "Una prova localizzata" }] });
  await page.locator(".query-row").filter({ hasText: "Articoli per autore" }).getByRole("button", { name: "Modifica" }).click();
  await expect(nestedQueryForm.getByLabel("Campo pubblico")).toHaveValue("autore.organizzazione.nome");
  await expect(nestedQueryForm.getByLabel("Valore", { exact: true })).toHaveValue("Studio Italiano");

  const catalog = await cmsRequest<{ projects: Array<{ id: string; name: string }> }>(env, "/api/cms/v1/projects");
  const project = catalog.projects.find((item) => item.name === projectName);
  expect(project).toBeDefined();
  const base = `/api/cms/v1/projects/${project!.id}`;
  const types = await cmsRequest<{ types: Array<{ key: string; fields: Array<{ key: string }> }> }>(env, `${base}/types`);
  expect(types.types.find((item) => item.key === "articoli")?.fields.map((field) => field.key)).toEqual(["descrizione", "punteggio", "sottotitolo", "autore"]);
  const records = await cmsRequest<{ items: Array<{ title: string; locale: string; status: string; values: Record<string, unknown> }> }>(env, `${base}/records?type=articoli&status=any&limit=100`);
  expect(records.items).toContainEqual(expect.objectContaining({ title: "Una prova localizzata", locale: "en-US", status: "published" }));
  expect(records.items.find((item) => item.title === "Una prova localizzata")?.values.autore).toMatchObject({ id: authorId });
  expect(pageErrors, "the screen raised no script error").toEqual([]);
});
