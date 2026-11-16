import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newProject, openProjectTab } from "./cms-helpers.js";
import { expectDialogFitsMobile } from "./responsive-helpers.js";

/**
 * Doc 23 items 197, 199, 200 in the linked site's own place (Pubblica → Siti collegati): «Controlla il sito», the
 * conflicts by type with one choice for a group, and the contents only on the site with «Porta nel progetto».
 * WordPress is a stand-in: the routes of Publish's API that talk to it answer from here.
 */

const CONNECTION_ID = "6a1d2a67-b34f-4dde-a234-1c678ebc8b10";
type Status = "new" | "update" | "unchanged" | "local-only" | "remote-only" | "conflict";
interface Entity { id: string; kind: string; label: string; status: Status; canResolve?: boolean; documentType?: "page" | "post"; onSite?: "only-on-site" | "changed-on-site"; comparison?: Array<{ field: string; local: string; remote: string }> }

const id = (n: number) => `550e8400-e29b-41d4-a716-4466554401${String(n).padStart(2, "0")}`;

async function state(): Promise<{ baseUrl: string; token: string }> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as { baseUrl: string; token: string };
}

function counts(entities: Entity[]): Record<Status | "delete", number> {
  const out = { new: 0, update: 0, delete: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0 };
  for (const entity of entities) out[entity.status] += 1;
  return out;
}

async function openLinkedProject(page: Page, input: { push: Entity[]; pull: (only: string[]) => Entity[]; check?: unknown }) {
  const env = await state();
  const requests = { plan: [] as Array<Record<string, unknown>>, apply: [] as Array<Record<string, unknown>>, check: [] as Array<Record<string, unknown>> };
  let projectId = "";
  let projectName = "";
  let lastOnly: string[] = [];
  await page.route(/\/api\/cms\/v1\/(?:connections|destinations)(?:\/|$)/u, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname.endsWith("/connections")) {
      await route.fulfill({ json: { connections: [{ id: CONNECTION_ID, url: "https://wordpress.example.test", siteId: "c7f66b89-81c2-4e34-9513-c4f1886decc3", projectId: null, projectName: "WordPress di prova", profile: "histos-static-project-v4", read: true, write: true, publish: false, connectedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), lastSyncedAt: null, operations: [] }] } });
      return;
    }
    if (request.method() === "POST" && pathname === `/api/cms/v1/connections/${CONNECTION_ID}/check`) {
      requests.check.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: input.check });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/destinations/plan")) {
      const body = request.postDataJSON() as { action: "pull" | "push"; only?: string[]; projectId?: string };
      requests.plan.push(body);
      lastOnly = body.only ?? [];
      const entities = body.action === "pull" ? input.pull(body.only ?? []) : input.push;
      const conflicts = entities.filter((entity) => entity.status === "conflict");
      const planId = body.action === "pull" || conflicts.length === 0 ? "a5b7e9c1-344a-4f6d-8f71-99b4c42cf120" : null;
      await route.fulfill({ json: {
        schemaVersion: 1, destination: { id: `wordpress:${CONNECTION_ID}`, label: "WordPress di prova", kind: "wordpress-existing", transport: "histos-remote", publicUrl: "https://wordpress.example.test" },
        rollback: { status: "unavailable", estimatedBytes: 0, maxBytes: 0, note: body.action === "pull" ? "Il download aggiorna il progetto locale ma non modifica WordPress." : "Il backup WordPress non esiste ancora." },
        planId, action: body.action, connectionId: CONNECTION_ID, project: { id: projectId, name: projectName }, profile: "histos-static-project-v4", initializingRemote: false,
        expiresAt: planId ? new Date(Date.now() + 600_000).toISOString() : null, applyAllowed: conflicts.length === 0, counts: counts(entities), entities, omittedEntities: 0, leftOut: [],
        ...(body.only ? { bring: { requested: body.only.length, total: entities.length } } : {}),
      } });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/destinations/apply")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.apply.push(body);
      const resolutions = (body.resolutions ?? {}) as Record<string, string>;
      await route.fulfill({ json: { action: "pull", connectionId: CONNECTION_ID, project: { id: projectId, name: projectName }, changed: input.pull(lastOnly).filter((entity) => resolutions[entity.id] !== "keep-local" && lastOnly.includes(entity.id)).map((entity) => entity.id), keptLocal: Object.keys(resolutions).filter((key) => resolutions[key] === "keep-local"), complete: true } });
      return;
    }
    await route.continue();
  });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  projectName = `E2E strumenti del sito ${Date.now()}`;
  const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/cms/v1/projects");
  await newProject(page, projectName);
  projectId = ((await (await created).json()) as { project: { id: string } }).project.id;
  await openProjectTab(page, "Pubblica");
  return { requests, projectId: () => projectId };
}

test("«Controlla il sito» nella riga del sito elenca per nome cosa non viaggia, con motivo e rimedio", async ({ page }) => {
  const { requests, projectId } = await openLinkedProject(page, {
    push: [], pull: () => [],
    check: {
      checkedAt: new Date().toISOString(), host: "wordpress.example.test", read: 812, canSend: false, stoppedEarly: true,
      problems: [
        { where: "site", kind: "template-part", title: "Testata <img src=x onerror=alert(1)>", reason: "Un'espressione usa «url», che non viaggia fra WP e Publish (di url viaggia solo url.path).", remedy: "Nel builder, in WP, cambia l'espressione: per la voce attiva di un menu usa url.path, che viaggia da Histeon 0.5.4.", message: "The expression scope is not portable in x: url.", blocking: true },
        { where: "project", kind: "project", title: "Il mio progetto", reason: "Il sito usa PHP 8.1: Histeon chiede PHP 8.3 o superiore.", remedy: "Aggiorna Histeon in WP (o PHP dall'hosting, se lo dice il motivo), poi ricontrolla.", blocking: true },
        { where: "site", kind: "template", title: "Archivio eventi", reason: "Il template non ha il blocco «Contenuto del post»: senza, non c'è dove mettere la pagina.", remedy: "Nel template, in WP, rimetti il blocco «Contenuto del post» (in un archivio può restare vuoto) e salva.", message: "manca lo slot predefinito richiesto per una pagina", blocking: false },
      ],
    },
  });
  const row = page.locator("#cms-linked-sites .cms-remote-row");
  await row.getByRole("button", { name: "Controlla il sito WP" }).click();
  await expect.poll(() => requests.check).toHaveLength(1);
  expect(requests.check[0]).toEqual({ projectId: projectId() });
  const result = row.getByTestId("cms-site-check");
  await expect(result).toContainText("2 problemi fermano l'invio.");
  await expect(result).toContainText("Il sito si è fermato al primo contenuto");
  await expect(result.getByRole("region", { name: "Fermano l'invio" })).toContainText("Parte di template");
  await expect(result.getByRole("region", { name: "Fermano l'invio" })).toContainText("Nel progetto");
  await expect(result.getByRole("region", { name: /Restano fuori dall'invio/u })).toContainText("Archivio eventi");
  await expect(result).toContainText("Cosa fare: Nel template, in WP, rimetti il blocco «Contenuto del post»");
  await expect(result).toContainText("Messaggio del sito: The expression scope is not portable in x: url.");
  // What the site says is text, never markup.
  await expect(result).toContainText("Testata <img src=x onerror=alert(1)>");
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(result.getByTestId("cms-site-check-problem")).toHaveCount(3);
});

test("risolve i conflitti per gruppo scaricando solo quelli, con le due versioni a confronto", async ({ page }) => {
  const conflicts: Entity[] = [
    { id: id(1), kind: "document", documentType: "page", label: "Chi siamo", status: "conflict", canResolve: true, comparison: [{ field: "testo", local: "Testo del progetto", remote: "Testo del sito" }] },
    { id: id(2), kind: "document", documentType: "page", label: "Contatti", status: "conflict", canResolve: true },
    { id: id(3), kind: "component", label: "Manifesto", status: "conflict", canResolve: true },
    { id: id(4), kind: "document", documentType: "page", label: "Pagina cancellata sul sito", status: "conflict", canResolve: false },
  ];
  const { requests } = await openLinkedProject(page, {
    push: [...conflicts, { id: id(9), kind: "document", documentType: "page", label: "Solo qui", status: "remote-only", onSite: "only-on-site" }],
    pull: (only) => conflicts.filter((entity) => only.includes(entity.id)),
  });
  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  const send = page.getByRole("dialog", { name: "Invia al sito" });
  await expect(send.getByRole("region", { name: "Conflitti: Pagine" })).toContainText("(3)");
  await expect(send.getByRole("region", { name: "Conflitti: Componenti" })).toContainText("Manifesto");
  await send.getByText("Confronta il campo modificato").click();
  await expect(send.getByRole("columnheader", { name: "Nel progetto" })).toBeVisible();
  await expect(send.getByText("Testo del sito")).toBeVisible();
  await send.getByRole("button", { name: /Risolvi i conflitti/u }).click();

  await expect.poll(() => requests.plan.length).toBe(2);
  expect(requests.plan[1]).toMatchObject({ action: "pull", only: [id(1), id(2), id(3)] });
  const resolve = page.getByRole("dialog", { name: "Risolvi i conflitti" });
  await expect(resolve).toBeVisible();
  await expectDialogFitsMobile(page, resolve);
  await expect(resolve.getByTestId("cms-sync-bring-note")).toContainText("Gli altri contenuti del sito non entrano nel progetto");
  const apply = resolve.getByRole("button", { name: /Applica le scelte e scarica/u });
  await expect(apply).toBeDisabled();
  await resolve.getByRole("button", { name: "Tieni quella del sito per Pagine" }).click();
  await expect(apply).toBeDisabled();
  await resolve.getByRole("button", { name: "Tieni quella del progetto per Componenti" }).click();
  await expect(resolve.getByLabel("Versione da conservare per Contatti")).toHaveValue("use-remote");
  await expect(resolve).toContainText("scelti 3");
  await resolve.getByLabel("Versione da conservare per Chi siamo").selectOption("keep-local");
  await apply.click();
  await expect.poll(() => requests.apply).toHaveLength(1);
  expect(requests.apply[0]).toMatchObject({ action: "pull", resolutions: { [id(1)]: "keep-local", [id(2)]: "use-remote", [id(3)]: "keep-local" } });
});

test("dice quali contenuti sono solo sul sito e porta nel progetto quelli scelti", async ({ page }) => {
  const onSite: Entity[] = [
    { id: id(11), kind: "document", documentType: "page", label: "Pagina del sito", status: "remote-only", onSite: "only-on-site" },
    { id: id(12), kind: "document", documentType: "page", label: "Cambiata in WP", status: "remote-only", onSite: "changed-on-site" },
    { id: id(13), kind: "document", documentType: "post", label: "Un articolo del sito", status: "remote-only", onSite: "only-on-site" },
    { id: id(14), kind: "styles", label: "Stili globali", status: "remote-only", onSite: "changed-on-site" },
  ];
  const { requests } = await openLinkedProject(page, {
    push: [{ id: id(20), kind: "document", documentType: "page", label: "Home", status: "update" }, ...onSite],
    pull: (only) => [...onSite.filter((entity) => only.includes(entity.id)).map((entity) => ({ ...entity, status: "new" as const })), { id: id(15), kind: "asset", label: "foto.jpg", status: "new" as const }],
  });
  await page.getByRole("button", { name: "Invia in sviluppo" }).click();
  const send = page.getByRole("dialog", { name: "Invia al sito" });
  await expect(send).toContainText("4 solo sul sito: l’invio non li tocca.");
  const pages = send.getByRole("region", { name: "Solo sul sito: Pagine" });
  await expect(pages).toContainText("Pagina del sito");
  await expect(pages).toContainText("cambiato sul sito dopo l’ultimo invio");
  await expect(send.getByRole("region", { name: "Solo sul sito: Articoli" })).toContainText("Un articolo del sito");
  await expect(send.getByRole("region", { name: "Solo sul sito: Stili" }).getByRole("checkbox")).toBeDisabled();
  const bring = send.getByTestId("cms-sync-bring");
  await expect(bring).toBeDisabled();
  await send.getByRole("checkbox", { name: /Pagina del sito/u }).check();
  await send.getByRole("checkbox", { name: /Un articolo del sito/u }).check();
  await expect(bring).toHaveText(/Porta nel progetto \(2\)/u);
  // The send itself still goes: the contents only on the site do not stop it.
  await expect(send.getByRole("button", { name: /Conferma invio/u })).toBeEnabled();
  await bring.click();

  await expect.poll(() => requests.plan.length).toBe(2);
  expect(requests.plan[1]).toMatchObject({ action: "pull", only: [id(11), id(13)] });
  const dialog = page.getByRole("dialog", { name: "Porta nel progetto" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("cms-sync-bring-note")).toContainText("i 2 contenuti scelti e 1 che servono loro");
  await expect(dialog).toContainText("foto.jpg");
  await dialog.getByRole("button", { name: /^Porta nel progetto/u }).click();
  await expect.poll(() => requests.apply).toHaveLength(1);
  expect(requests.apply[0]).toMatchObject({ action: "pull", planId: "a5b7e9c1-344a-4f6d-8f71-99b4c42cf120", confirmed: true });
  expect(requests.apply[0]).not.toHaveProperty("only");
  await expect(page.getByText(/2 contenuti portati nel progetto\. Gli altri restano solo sul sito\./u)).toBeVisible();
});
