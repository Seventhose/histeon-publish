import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOTYPE_BUILT_NOTE } from "@histos-publish/server";

/**
 * `histos-publish prototype check --preview` (round 7, B2): the check builds the site as the app's check does, in a
 * temporary folder it removes, and reports the same refusals (a site that does not build, D8, placed at its document)
 * and the same warnings (a bundle that publishing would block), with no preview address: the output says so.
 */

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cli-preview-"));
  roots.push(root);
  return root;
}

/**
 * `prototype check` on a prototype written to a file, with `--json` (a global option, before the command) and
 * `--preview` as asked, and a temporary folder of its own: what the run left there is `left`.
 */
async function check(html: string, options: { json?: boolean; preview?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string; left: string[] }> {
  const root = await scratch();
  const file = path.join(root, "prototipo.html");
  await writeFile(file, html);
  const tmp = path.join(root, "tmp");
  await mkdir(tmp, { mode: 0o700 });
  const args = [CLI, ...(options.json ? ["--json"] : []), "prototype", "check", ...(options.preview ? ["--preview"] : []), file];
  let result: { code: number; stdout: string; stderr: string };
  try {
    const { stdout, stderr } = await run(process.execPath, args, { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, maxBuffer: 16 * 1024 * 1024 });
    result = { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    result = { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
  return { ...result, left: await readdir(tmp) };
}

const QUERIES = JSON.stringify({
  types: [{ key: "opera", label: "Opere", singleTemplate: "site/opera", fields: [] }],
  records: [{ type: "opera", slug: "ehi", title: "Ehi", status: "published", publishedAt: "2026-10-02T09:00:00Z" }],
  queries: [{ key: "opere_recenti", label: "Opere recenti", type: "opera", limit: 6, orderBy: "publishedAt", order: "desc" }],
});

const PROTOTYPE = (body: string, home = '<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>') => `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"5d0c9a1e-2b3f-4c6d-8e7f-0a1b2c3d4e5f","name":"Esiti","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${QUERIES}</script>
</head><body>
${home}
${body}
</body></html>`;

const BUILDS = PROTOTYPE('<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1>{@slot}</main></template>');
/** The loop's limit from the page's title: only the build reads it, and refuses it in the template site/lista. */
const TEMPLATE_REFUSED = PROTOTYPE([
  '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>{@slot}</main></template>',
  '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main>',
  "{#loop opere_recenti(limit: page.title) as o}<p>{o.title}</p>{/loop}{@slot}</main></template>",
  '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista"><p>x</p></template>',
].join("\n"));
const REFUSAL = "template site/lista, riga 7: La versione del sito si ferma: /tutte/ (template site/lista): {#loop opere_recenti(…)}: La query opere_recenti deve mostrare da 1 a 100 record; -1 indica il massimo sicuro.";
const LEAK = PROTOTYPE('<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1>{@slot}</main></template>', '<template data-histos="page" data-slug="home" data-title="Home">\n<h1>Home</h1>\n<p>I file sono in /home/deploy/sito.</p></template>');

describe("histos-publish prototype check --preview", () => {
  it("un sito che si costruisce: valido, e dice che qui non c'è un indirizzo di anteprima", async () => {
    const text = await check(BUILDS, { preview: true });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("Prototipo valido: «Esiti»");
    expect(text.stdout).toContain(PROTOTYPE_BUILT_NOTE);
    expect(text.left).toEqual([]);
    const json = await check(BUILDS, { json: true, preview: true });
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ valid: true, outcome: "create", preview: { status: "built", findings: expect.any(Number), note: PROTOTYPE_BUILT_NOTE } });
    expect(json.left).toEqual([]);
    // Without --preview: no build, no line about it.
    const plain = await check(BUILDS);
    expect(plain.stdout).not.toContain(PROTOTYPE_BUILT_NOTE);
  }, 60_000);

  it("un sito che non si costruisce: codice 2 e il problema nel template, come nel controllo dell'app", async () => {
    // Before: no --preview, and the check without it answers valid (it builds nothing).
    const plain = await check(TEMPLATE_REFUSED);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toContain("Prototipo valido");
    const text = await check(TEMPLATE_REFUSED, { preview: true });
    expect(text.code).toBe(2);
    expect(text.stderr).toContain(REFUSAL);
    expect(text.left).toEqual([]);
    const json = await check(TEMPLATE_REFUSED, { json: true, preview: true });
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({ error: REFUSAL, code: "cms-prototype-invalid", issues: [{ document: "template site/lista", line: 7, message: REFUSAL.slice("template site/lista, riga 7: ".length) }], total: 1 });
  }, 60_000);

  it("un sito che la pubblicazione fermerebbe: valido, con il motivo fra gli avvisi e la pagina del prototipo", async () => {
    const text = await check(LEAK, { preview: true });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("Build del sito: Il sito si costruisce, ma i controlli di sicurezza fermerebbero la pubblicazione: i motivi sono fra gli avvisi.");
    expect(text.stdout).toMatch(/^Avviso: La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga 5 del prototipo\.$/mu);
    const json = await check(LEAK, { json: true, preview: true });
    const body = JSON.parse(json.stdout) as { valid: boolean; preview: Record<string, unknown>; report: { warnings: string[] } };
    expect(body).toMatchObject({ valid: true, preview: { status: "unavailable" } });
    expect(body.preview).not.toHaveProperty("publishBlocks");
    expect(body.report.warnings[0]).toMatch(/^La pubblicazione si fermerebbe: index\.html/u);
  }, 60_000);
});
