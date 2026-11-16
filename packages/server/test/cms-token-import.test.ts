import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateHistosDesign } from "@histos-publish/cms";
import { planTokenImport } from "../src/cms-token-import.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

const file = (name: string, data: unknown) => ({ name, text: JSON.stringify(data) });
/** A colour as the design keeps it. */
const kept = (hex: string) => validateHistosDesign({ primary: hex }).primary;
const srgb = (hex: string) => ({ colorSpace: "srgb", components: [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255), alpha: 1, hex });

/** One mode of a Figma variable collection, and its dark mode. */
const light = {
  color: { $type: "color", brand: { primary: { $value: srgb("#1D4ED8") } }, sabbia: { $value: srgb("#F5EFE6") } },
  radius: { md: { $type: "number", $value: 10 } },
  font: { size: { caption: { $type: "number", $value: 13 } } },
};
const dark = { color: { $type: "color", brand: { primary: { $value: srgb("#93C5FD") } } } };

describe("piano dell'importazione dei token", () => {
  it("mette i parametri importati sopra quelli salvati e lascia gli altri", () => {
    const plan = planTokenImport({ head: "r1", files: [file("Light.tokens.json", light)] }, { design: { radius: 4, secondary: "#f97316" }, siteTokens: { "color-sabbia": "#ffffff", vecchia: "1rem" } });
    expect(plan.apply).toBe(false);
    expect(plan.design).toMatchObject({ primary: kept("#1d4ed8"), radius: 10, secondary: kept("#f97316") });
    expect(plan.siteTokens).toMatchObject({ "color-sabbia": "#f5efe6", vecchia: "1rem" });
    expect(plan.view.imported.design).toMatchObject({ primary: kept("#1d4ed8"), radius: 10 });
    // primary and radius change the design, sabbia changes a saved variable.
    expect(plan.view.counts).toEqual({ parameters: 2, variables: 1, replaced: 3 });
    expect(plan.view.text).toContain("Misure di testo: nessuna diventa una misura fissa");
    expect(JSON.stringify(plan.design) + JSON.stringify(plan.siteTokens)).not.toMatch(/\d(?:\.\d+)?px/u);
  });

  it("legge il tema scuro dai file scuri", () => {
    const plan = planTokenImport({ head: "r1", files: [file("Light.tokens.json", light)], dark: [file("Dark.tokens.json", dark)], apply: true }, {});
    expect(plan.apply).toBe(true);
    expect(plan.design).toMatchObject({ dark_on: 1, primary_dark: kept("#93c5fd") });
  });

  it("rifiuta un corpo senza revisione, senza file o con un file che non è JSON", () => {
    expect(() => planTokenImport({ files: [file("a.json", light)] }, {})).toThrowError(/revisione/u);
    expect(() => planTokenImport({ head: "r1", files: [] }, {})).toThrowError(/almeno un file/u);
    expect(() => planTokenImport({ head: "r1", files: "no" }, {})).toThrowError(/elenco di file/u);
    expect(() => planTokenImport({ head: "r1", files: [{ name: "a.json" }] }, {})).toThrowError(/un nome e un testo/u);
    expect(() => planTokenImport({ head: "r1", files: [{ name: "a.json", text: "{" }] }, {})).toThrowError(expect.objectContaining({ code: "cms-tokens-import-invalid", exitCode: 400 }));
  });

  it("un valore ostile non arriva nel design né nelle variabili", () => {
    const hostile = { color: { $type: "color", brand: { primary: { $value: "red;} body{display:none" } }, altro: { $value: "url(https://evil.example/x)" } }, font: { family: { body: { $type: "fontFamily", $value: "x\"; } body { display:none" } } } };
    const plan = planTokenImport({ head: "r1", files: [file("ostile.json", hostile)] }, {});
    expect(JSON.stringify([plan.design, plan.siteTokens])).not.toMatch(/evil|display|[;{}]\s*body/u);
    expect(plan.view.report.skipped.length).toBeGreaterThan(0);
  });
});

describe("POST /api/cms/v1/projects/:id/tokens/import", () => {
  let server: LocalServerHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let base: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-token-import-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-token-import-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    const secrets = new Map<string, string>();
    server = await startLocalServer({
      dataDirectory,
      uiDirectory,
      openBrowser: false,
      secretStoreFactory: (account) => ({
        get: async () => secrets.get(account) ?? null,
        set: async (value) => { secrets.set(account, value); },
        delete: async () => { secrets.delete(account); },
      }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server) await server.close();
    await Promise.all([rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(uiDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  it("dà il rapporto senza salvare, poi salva e il foglio del sito ha i colori importati", async () => {
    const headers = { "X-Histos-Token": server!.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Token importati" }) });
    const { project } = await created.json() as { project: { id: string } };
    const prefix = `${base}/api/cms/v1/projects/${project.id}`;
    const state = await (await fetch(`${prefix}/tokens`, { headers })).json() as { head: string; base: string };
    // A value the import does not touch must stay.
    const first = await fetch(`${prefix}/tokens`, { method: "POST", headers, body: JSON.stringify({ head: state.head, base: state.base, tokens: {}, design: { secondary: "#f97316" }, siteTokens: { vecchia: "1rem" } }) });
    const { head } = await first.json() as { head: string };
    const files = [file("Light.tokens.json", light)];

    const preview = await fetch(`${prefix}/tokens/import`, { method: "POST", headers, body: JSON.stringify({ head, files, dark: [file("Dark.tokens.json", dark)], apply: false }) });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { applied: boolean; head: string; text: string; counts: { parameters: number } };
    expect(previewBody).toMatchObject({ applied: false, head, design: { primary: kept("#1d4ed8"), secondary: kept("#f97316") } });
    expect(previewBody.text).toContain("Parametri del design:");
    const untouched = await (await fetch(`${prefix}/tokens`, { headers })).json() as { head: string; design: Record<string, unknown> };
    expect(untouched.head).toBe(head);
    expect(untouched.design.primary).not.toBe(kept("#1d4ed8"));

    const applied = await fetch(`${prefix}/tokens/import`, { method: "POST", headers, body: JSON.stringify({ head, files, dark: [file("Dark.tokens.json", dark)], apply: true }) });
    expect(applied.status).toBe(200);
    const appliedBody = await applied.json() as { applied: boolean; head: string };
    expect(appliedBody.applied).toBe(true);
    expect(appliedBody.head).not.toBe(head);
    const after = await (await fetch(`${prefix}/tokens`, { headers })).json() as { head: string; design: Record<string, unknown>; siteTokens: Record<string, string> };
    expect(after.head).toBe(appliedBody.head);
    expect(after.design).toMatchObject({ primary: kept("#1d4ed8"), secondary: kept("#f97316"), radius: 10, dark_on: 1, primary_dark: kept("#93c5fd") });
    expect(after.siteTokens).toMatchObject({ "color-sabbia": "#f5efe6", vecchia: "1rem" });
    const styles = await (await fetch(`${prefix}/styles`, { headers })).json() as { globalCss: string };
    expect(styles.globalCss).toContain("--xb-site-color-sabbia:#f5efe6");
    expect(styles.globalCss).toContain("--xb-radius-m:0.625rem");

    // The revision the first request was made on is old now: nothing is saved over the new one.
    const stale = await fetch(`${prefix}/tokens/import`, { method: "POST", headers, body: JSON.stringify({ head, files, apply: true }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "cms-revision-conflict" });
    const bad = await fetch(`${prefix}/tokens/import`, { method: "POST", headers, body: JSON.stringify({ head: appliedBody.head, files: [{ name: "a.json", text: "[" }], apply: true }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "cms-tokens-import-invalid" });
  });
});
