import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import { buildPrototypePreview, checkPrototypeBuild, PROTOTYPE_BUILT_NOTE, type CmsOperationsContext } from "../src/cms-api.js";
import { checkPrototype, PrototypeInvalidError } from "../src/prototype-check.js";
import { startLocalServer } from "../src/server.js";

/**
 * What the prototype check answers when the preview build does not give a preview (round-6 review, B2): a machine
 * that cannot build is "preview unavailable" with its honest reason; a site that does not build is an invalid
 * prototype, each problem placed at its document; a site with only drafts is valid; a site whose bundle would be
 * blocked from publishing is valid, with what would stop it among the warnings.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-preview-outcome-"));
  roots.push(root);
  return root;
}

function context(root: string, overrides: Partial<CmsOperationsContext> = {}): CmsOperationsContext {
  return {
    catalog: new CmsProjectCatalog(path.join(root, "catalog")), dataDirectory: root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined,
    prototypePreviews: { root: path.join(root, "previews"), track: () => undefined, folder: async () => null } as unknown as CmsOperationsContext["prototypePreviews"],
    ...overrides,
  };
}

/** The check with the throwaway preview, as the app runs it (?check=1&preview=1). */
async function checkWithPreview(html: string, overrides: Partial<CmsOperationsContext> = {}) {
  const root = await scratch();
  const target = context(root, overrides);
  return checkPrototype(html, { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(target, opened, signal) });
}

const QUERIES = JSON.stringify({
  types: [{ key: "opera", label: "Opere", singleTemplate: "site/opera", fields: [] }],
  records: [{ type: "opera", slug: "ehi", title: "Ehi", status: "published", publishedAt: "2026-10-02T09:00:00Z" }],
  queries: [{ key: "opere_recenti", label: "Opere recenti", type: "opera", limit: 6, orderBy: "publishedAt", order: "desc" }],
});

const PROTOTYPE = (content: string, body: string, home = '<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>') => `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"5d0c9a1e-2b3f-4c6d-8e7f-0a1b2c3d4e5f","name":"Esiti","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${content}</script>
</head><body>
${home}
${body}
</body></html>`;

const NESTED = "{#loop [1] as a}{#loop [1] as b}{#loop [1] as c}{#loop [1] as d}{#loop [1] as e}{#loop [1] as f}{#loop [1] as g}<p>x</p>{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}";

/** A system error as Node's file functions throw it, with the path it names. */
function systemError(code: string, syscall = "write"): Error {
  return Object.assign(new Error(`${code}: errore, ${syscall} '/home/anna/Dati di Anna/histos/previews/x/index.html'`), { code, errno: -28, syscall, path: "/home/anna/Dati di Anna/histos/previews/x/index.html" });
}

describe("gli argomenti delle query nel controllo (1)", () => {
  it("limit fuori misura e un parametro sconosciuto sono errori del controllo, con documento, riga e colonna, con o senza anteprima", async () => {
    const limit = PROTOTYPE(QUERIES, '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>\n{#loop opere_recenti(limit: 500) as o}<p>{o.title}</p>{/loop}{@slot}</main></template>');
    const unknown = PROTOTYPE(QUERIES, '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>\n{#loop opere_recenti(colore: 1) as o}<p>{o.title}</p>{/loop}{@slot}</main></template>');
    for (const preview of [false, true]) {
      const refusedLimit = await (preview ? checkWithPreview(limit) : checkPrototype(limit, { scratchRoot: await scratch() })).catch((error: unknown) => error);
      expect(refusedLimit).toMatchObject({ code: "cms-prototype-invalid", issues: [{ document: "template site/opera", line: 7, column: expect.any(Number), message: "{#loop opere_recenti(…)}: limit è un numero intero da 1 a 100 (-1 per il massimo); con 500 la build del sito si ferma." }] });
      const refusedUnknown = await (preview ? checkWithPreview(unknown) : checkPrototype(unknown, { scratchRoot: await scratch() })).catch((error: unknown) => error);
      expect(refusedUnknown).toMatchObject({ code: "cms-prototype-invalid", issues: [{ document: "template site/opera", line: 7, column: expect.any(Number), message: expect.stringMatching(/^\{#loop opere_recenti\(…\)\}: colore non è un argomento delle query/u) }] });
    }
  });
});

describe("una build che non riesce (2)", () => {
  it("un argomento che solo la build conosce ferma il controllo con il motivo e la pagina, non «spazio su disco»", async () => {
    // limit from the page's title: the check cannot read it, the query refuses it at the build (a RangeError).
    const html = PROTOTYPE(QUERIES, '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>{@slot}</main></template>\n<template data-histos="page" data-slug="tutte" data-title="Tutte">\n{#loop opere_recenti(limit: page.title) as o}<p>{o.title}</p>{/loop}</template>');
    expect(await checkPrototype(html, { scratchRoot: await scratch() })).toMatchObject({ valid: true });
    const refused = await checkWithPreview(html).catch((error: unknown) => error);
    // Before: { valid: true, preview: { status: "unavailable", reason: "La build dell'anteprima non è riuscita (spazio su disco o permessi della cartella dati)." } }.
    expect(refused).toBeInstanceOf(PrototypeInvalidError);
    expect(refused).toMatchObject({
      code: "cms-prototype-invalid",
      issues: [{ document: "page tutte", line: 7, message: "La versione del sito si ferma: /tutte/: {#loop opere_recenti(…)}: La query opere_recenti deve mostrare da 1 a 100 record; -1 indica il massimo sicuro." }],
      message: "page tutte, riga 7: La versione del sito si ferma: /tutte/: {#loop opere_recenti(…)}: La query opere_recenti deve mostrare da 1 a 100 record; -1 indica il massimo sicuro.",
    });
  });

  it("il rifiuto del template di un record dice l'indirizzo e il template, e il controllo lo colloca nel template (5)", async () => {
    const html = PROTOTYPE(QUERIES, `<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1>${NESTED}{@slot}</main></template>`);
    const refused = await checkWithPreview(html).catch((error: unknown) => error);
    // Before: «La versione del sito si ferma: I loop annidati superano il limite di 6.», with no address or template.
    expect(refused).toMatchObject({ code: "cms-prototype-invalid", issues: [{ document: "template site/opera", line: 6, message: "La versione del sito si ferma: /opera/ehi/ (template site/opera): I loop annidati superano il limite di 6." }] });
  });

  it("un errore della macchina lascia il prototipo valido, con il motivo vero e nessun percorso", async () => {
    const html = PROTOTYPE("{}", "");
    const cases: Array<[Error, string]> = [
      [systemError("ENOSPC"), "La build dell'anteprima non è riuscita: il disco è pieno. Non dipende dal prototipo."],
      [systemError("EDQUOT"), "La build dell'anteprima non è riuscita: è finito lo spazio che questo utente può usare sul disco. Non dipende dal prototipo."],
      [systemError("EACCES", "open"), "La build dell'anteprima non è riuscita: mancano i permessi per usare la cartella dei dati o quella temporanea. Non dipende dal prototipo."],
      [systemError("EROFS"), "La build dell'anteprima non è riuscita: la cartella dei dati o quella temporanea è in sola lettura. Non dipende dal prototipo."],
      [systemError("EMFILE", "open"), "La build dell'anteprima non è riuscita: ci sono troppi file aperti in questo momento. Non dipende dal prototipo."],
      [systemError("EIO"), "La build dell'anteprima non è riuscita: il disco ha dato un errore di lettura o scrittura. Non dipende dal prototipo."],
      [systemError("EXDEV", "rename"), "La build dell'anteprima non è riuscita: il sistema ha risposto con l'errore EXDEV. Non dipende dal prototipo."],
      [Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" }), "La build dell'anteprima non è riuscita: il disco è pieno. Non dipende dal prototipo."],
    ];
    for (const [error, reason] of cases) {
      const checked = await checkWithPreview(html, { buildBundle: async () => { throw error; } });
      // Before: «La build dell'anteprima non è riuscita (spazio su disco o permessi della cartella dati).» for every one.
      expect(checked, reason).toMatchObject({ valid: true, preview: { status: "unavailable", reason } });
      expect(JSON.stringify(checked)).not.toMatch(/anna|previews/u);
    }
  });

  it("un altro errore della build vuol dire che il sito non si costruisce: il suo messaggio, senza percorsi né stack", async () => {
    const html = PROTOTYPE("{}", "");
    const failure = new TypeError("Cannot read properties of undefined (reading 'slug') in /home/anna/progetto/render.js");
    const refused = await checkWithPreview(html, { buildBundle: async () => { throw failure; } }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: "La versione del sito si ferma: Cannot read properties of undefined (reading 'slug') in [percorso rimosso]" }] });
    expect(JSON.stringify((refused as PrototypeInvalidError).issues)).not.toMatch(/anna|at .*\(|render\.js/u);
    // A database error the content caused (not the disk's) is the site's too.
    const sql = Object.assign(new Error("Expression tree is too large (maximum depth 1000)"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
    expect(await checkWithPreview(html, { buildBundle: async () => { throw sql; } }).catch((error: unknown) => error)).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: "La versione del sito si ferma: Expression tree is too large (maximum depth 1000)" }] });
    // Two writes of one file in a build's own new folder: two contents on one address, never a full disk.
    const stage = path.join(os.tmpdir(), "histos-cms-stage-AbC123", "source", "opera", "ehi", "index.html");
    const twice = Object.assign(new Error(`EEXIST: file already exists, open '${stage}'`), { code: "EEXIST", errno: -17, syscall: "open", path: stage });
    const collided = await checkWithPreview(html, { buildBundle: async () => { throw twice; } }).catch((error: unknown) => error);
    expect(collided).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: "La versione del sito si ferma: due contenuti scriverebbero lo stesso file della build, opera/ehi/index.html: cambia lo slug di uno dei due." }] });
    expect(await checkWithPreview(html, { buildBundle: async () => { throw new Error(""); } }).catch((error: unknown) => error)).toMatchObject({ code: "cms-prototype-invalid", issues: [{ message: "La versione del sito si ferma: un errore inatteso, senza messaggio." }] });
  });
});

const DRAFTS = PROTOTYPE("{}", '<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo" data-status="draft"><h1>Chi siamo</h1></template>', '<template data-histos="page" data-slug="home" data-title="Home" data-status="draft"><h1>Home</h1></template>');

describe("un prototipo con sole bozze (3)", () => {
  it("è valido, con l'anteprima non disponibile e il motivo", async () => {
    const checked = await checkWithPreview(DRAFTS);
    // Before (round 5): 422 «La versione del sito si ferma: Il progetto non ha pagine incluse nella versione…».
    expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "unavailable", reason: "Il progetto non ha pagine incluse nella versione. Seleziona almeno una pagina dal catalogo CMS." } });
  });
});

/** A page with a folder of the server in its text: the bundle's scanner blocks publishing. */
const LEAK = PROTOTYPE("{}", "", '<template data-histos="page" data-slug="home" data-title="Home">\n<h1>Home</h1>\n<p>I file sono in /home/deploy/sito.</p></template>');

describe("una build che la pubblicazione fermerebbe (4)", () => {
  it("il prototipo è valido; ogni motivo è un avviso, col file, la riga e la pagina del prototipo", async () => {
    const checked = await checkWithPreview(LEAK);
    // Before (round 5): 422 «La build bloccherebbe la pubblicazione del sito: index.html: Il contenuto espone un percorso del server.».
    expect(checked).toMatchObject({ valid: true, preview: { status: "unavailable", reason: "Il sito si costruisce, ma i controlli di sicurezza fermerebbero la pubblicazione: i motivi sono fra gli avvisi." } });
    expect(checked.report.warnings).toContainEqual(expect.stringMatching(/^La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga 5 del prototipo\.$/u));
    // Only the warnings carry the findings: the preview the client receives has none of them.
    expect(checked.preview).not.toHaveProperty("publishBlocks");
  });

  it("un link pubblico con /home/ nel percorso non ferma niente: l'anteprima c'è", async () => {
    const html = PROTOTYPE("{}", "", '<template data-histos="page" data-slug="home" data-title="Home"><p><a href="https://www.comune.example.it/home/servizi">Servizi del comune</a></p></template>');
    // Before: { valid: true, preview: unavailable } on base, 422 in round 5.
    expect(await checkWithPreview(html)).toMatchObject({ valid: true, preview: { status: "ready" } });
  });
});

describe("nell'app (?check=1&preview=1, come la chiama l'interfaccia)", () => {
  it("sole bozze: 200 valido; una pubblicazione che si fermerebbe: 200 valido con gli avvisi", async () => {
    const dataDirectory = await scratch();
    const uiDirectory = await scratch();
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    const server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const check = async (html: string) => {
        const response = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1&preview=1`, { method: "POST", headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "text/html; charset=utf-8" }, body: html });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const drafts = await check(DRAFTS);
      // Before (round 5): 422 cms-prototype-invalid, so the app showed the problems panel and no «Importa».
      expect(drafts, JSON.stringify(drafts.body)).toMatchObject({ status: 200, body: { valid: true, preview: { status: "unavailable", reason: expect.stringMatching(/^Il progetto non ha pagine incluse nella versione/u) } } });
      const leak = await check(LEAK);
      expect(leak, JSON.stringify(leak.body)).toMatchObject({ status: 200, body: { valid: true, preview: { status: "unavailable" }, report: { warnings: expect.arrayContaining([expect.stringMatching(/^La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga 5 del prototipo\.$/u)]) } } });
      expect(leak.body.preview).not.toHaveProperty("publishBlocks");
    } finally {
      await server.close();
    }
  });
});

/** The issue a refused check gives, with the preview build (the app's check), as checkWithPreview runs it. */
async function refusedIssues(html: string): Promise<unknown> {
  const refused = await checkWithPreview(html).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(PrototypeInvalidError);
  return (refused as PrototypeInvalidError).issues;
}

const LOOP_BY_TITLE = "{#loop opere_recenti(limit: page.title) as o}<p>{o.title}</p>{/loop}";
const LIMIT_REFUSED = "{#loop opere_recenti(…)}: La query opere_recenti deve mostrare da 1 a 100 record; -1 indica il massimo sicuro.";
const OPERA = '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>{@slot}</main></template>';

describe("il documento di un rifiuto della build è quello che si stava costruendo (round 7)", () => {
  it("un template che non si costruisce: il problema è nel template, non nella pagina che lo usa (repro p-tpl-page)", async () => {
    const html = PROTOTYPE(QUERIES, [
      OPERA,
      '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main>',
      `${LOOP_BY_TITLE}{@slot}</main></template>`,
      '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista"><p>x</p></template>',
    ].join("\n"));
    // Before: { document: "page tutte", line: 9 }, a page with no loop in it.
    expect(await refusedIssues(html)).toEqual([{ document: "template site/lista", line: 7, message: `La versione del sito si ferma: /tutte/ (template site/lista): ${LIMIT_REFUSED}` }]);
  });

  it("il contenuto della pagina resta della pagina, anche dentro il suo template", async () => {
    const html = PROTOTYPE(QUERIES, [
      OPERA,
      '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main>{@slot}</main></template>',
      '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista">',
      `${LOOP_BY_TITLE}</template>`,
    ].join("\n"));
    expect(await refusedIssues(html)).toEqual([{ document: "page tutte", line: 8, message: `La versione del sito si ferma: /tutte/ (template site/lista): ${LIMIT_REFUSED}` }]);
  });

  it("una parte del template e un componente sono il documento del problema", async () => {
    const part = PROTOTYPE(QUERIES, [
      OPERA,
      '<template data-histos="part" data-ref="site/testata" data-title="Testata"><header>',
      `${LOOP_BY_TITLE}</header></template>`,
      '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main><Site.Testata />{@slot}</main></template>',
      '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista"><p>x</p></template>',
    ].join("\n"));
    // Before: { document: "page tutte", line: 10 }.
    expect(await refusedIssues(part)).toEqual([{ document: "part site/testata", line: 7, message: `La versione del sito si ferma: /tutte/ (template site/lista): ${LIMIT_REFUSED}` }]);
    const component = PROTOTYPE(QUERIES, [
      OPERA,
      '<template data-histos="component" data-ref="scheda" data-title="Scheda"><div>',
      `${LOOP_BY_TITLE}</div></template>`,
      '<template data-histos="page" data-slug="tutte" data-title="Tutte"><Scheda /></template>',
    ].join("\n"));
    // Before: { document: "page tutte", line: 9 }.
    expect(await refusedIssues(component)).toEqual([{ document: "component scheda", line: 7, message: `La versione del sito si ferma: /tutte/: ${LIMIT_REFUSED}` }]);
  });

  it("un errore qualsiasi di un render, senza indirizzo nel messaggio, va al template che si stava costruendo", async () => {
    const html = PROTOTYPE(QUERIES, [
      OPERA,
      '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main>',
      "{#loop opere_recenti() as o}<p>{o.title}</p>{/loop}{@slot}</main></template>",
      '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista"><p>x</p></template>',
    ].join("\n"));
    const root = await scratch();
    const target = context(root);
    const refused = await checkPrototype(html, {
      scratchRoot: root,
      preview: (opened, signal) => {
        // A query that fails as no refusal of the renderer does (a database error, a bug): its message has no address.
        opened.store.content.resolveQueryPreset = () => { throw new Error("guasto della query in /home/anna/progetto/db.sqlite"); };
        return buildPrototypePreview(target, opened, signal);
      },
    }).catch((error: unknown) => error);
    // Before: { message } alone, with no document.
    expect(refused).toMatchObject({ code: "cms-prototype-invalid", issues: [{ document: "template site/lista", line: 7, message: "La versione del sito si ferma: guasto della query in [percorso rimosso]" }] });
  });
});

const QUANTI = JSON.stringify({
  types: [{ key: "opera", label: "Opere", singleTemplate: "site/opera", fields: [{ key: "quanti", label: "Quanti", type: "integer", required: false, public: true, multiple: false }] }],
  records: [{ type: "opera", slug: "ehi", title: "Ehi", status: "published", publishedAt: "2026-10-02T09:00:00Z", values: { quanti: 500 } }],
  queries: [{ key: "opere_recenti", label: "Opere recenti", type: "opera", limit: 6, orderBy: "publishedAt", order: "desc" }],
});
const DRAFT_HOME = '<template data-histos="page" data-slug="home" data-title="Home" data-status="draft"><h1>Home</h1></template>';

describe("sole bozze: il resto del sito si costruisce comunque (round 7)", () => {
  it("un record pubblicato il cui template non si costruisce rifiuta il prototipo (repro p-drafts-brokenrecord)", async () => {
    const html = PROTOTYPE(QUANTI, '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>\n{#loop opere_recenti(limit: page.fields.quanti) as o}<p>{o.title}</p>{/loop}{@slot}</main></template>', DRAFT_HOME);
    // Before: { valid: true, preview: { status: "unavailable", reason: «Il progetto non ha pagine incluse nella versione…» } }.
    expect(await refusedIssues(html)).toEqual([{ document: "template site/opera", line: 6, message: `La versione del sito si ferma: /opera/ehi/ (template site/opera): ${LIMIT_REFUSED}` }]);
  });

  it("un articolo pubblicato il cui template non si costruisce, anche", async () => {
    const html = PROTOTYPE("{}", [
      `<template data-histos="template" data-ref="site/articolo" data-title="Articolo"><main>${NESTED}{@slot}</main></template>`,
      '<template data-histos="post" data-slug="ciao" data-title="Ciao" data-template="site/articolo" data-published-at="2026-10-20T08:30:00Z"><p>Ciao.</p></template>',
    ].join("\n"), DRAFT_HOME);
    expect(await refusedIssues(html)).toEqual([{ document: "template site/articolo", line: 6, message: "La versione del sito si ferma: /blog/ciao/ (template site/articolo): I loop annidati superano il limite di 6." }]);
  });

  it("record e articoli pubblicati che si costruiscono: valido, con lo stesso motivo di prima", async () => {
    const html = PROTOTYPE(QUERIES, [
      '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1>{@slot}</main></template>',
      '<template data-histos="post" data-slug="ciao" data-title="Ciao" data-published-at="2026-10-20T08:30:00Z"><p>Ciao.</p></template>',
    ].join("\n"), DRAFT_HOME);
    expect(await checkWithPreview(html)).toMatchObject({ valid: true, preview: { status: "unavailable", reason: "Il progetto non ha pagine incluse nella versione. Seleziona almeno una pagina dal catalogo CMS." } });
  });
});

describe("gli avvisi della pubblicazione leggono pagine e articoli una volta sola (round 7)", () => {
  it("le letture non crescono con il numero dei problemi, e ogni avviso dice il suo articolo", async () => {
    const leaking = (count: number) => PROTOTYPE("{}", Array.from({ length: count }, (_, index) => `<template data-histos="post" data-slug="p${index}" data-title="P${index}" data-published-at="2026-10-20T08:30:00Z"><p>In /home/deploy/p${index}.</p></template>`).join("\n"));
    const reads = async (html: string) => {
      const root = await scratch();
      const target = context(root);
      let calls = 0;
      const checked = await checkPrototype(html, {
        scratchRoot: root,
        preview: (opened, signal) => {
          const store = opened.store as CmsProjectStore & { listPosts: CmsProjectStore["listPosts"] };
          const listPosts = store.listPosts.bind(store);
          store.listPosts = (...args: Parameters<CmsProjectStore["listPosts"]>) => {
            calls += 1;
            return listPosts(...args);
          };
          return buildPrototypePreview(target, opened, signal);
        },
      });
      return { calls, checked };
    };
    const few = await reads(leaking(3));
    const many = await reads(leaking(12));
    expect(many.checked.report.warnings).toContainEqual(expect.stringMatching(/^La pubblicazione si fermerebbe: blog\/p11\/index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da post p11, riga 17 del prototipo\.$/u));
    // Before: one more reading of every post for each warning (3 and 12 more).
    expect(many.calls).toBe(few.calls);
  });
});

describe("il controllo con la build e senza server (checkPrototypeBuild, la riga di comando)", () => {
  it("un sito che si costruisce: «built», con la nota che non c'è un indirizzo, e nessuna cartella lasciata", async () => {
    const root = await scratch();
    const html = PROTOTYPE(QUERIES, '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1>{@slot}</main></template>');
    const checked = await checkPrototypeBuild(html, { scratchRoot: root });
    expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "built", findings: expect.any(Number), note: PROTOTYPE_BUILT_NOTE } });
    expect(PROTOTYPE_BUILT_NOTE).toContain("Qui non c'è un indirizzo di anteprima");
    expect(await readdir(root)).toEqual([]);
  });

  it("gli stessi rifiuti e gli stessi avvisi del controllo dell'app", async () => {
    const root = await scratch();
    const template = PROTOTYPE(QUERIES, [OPERA, '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main>', `${LOOP_BY_TITLE}{@slot}</main></template>`, '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista"><p>x</p></template>'].join("\n"));
    expect(await checkPrototypeBuild(template, { scratchRoot: root }).catch((error: unknown) => error)).toMatchObject({ code: "cms-prototype-invalid", issues: [{ document: "template site/lista", line: 7, message: `La versione del sito si ferma: /tutte/ (template site/lista): ${LIMIT_REFUSED}` }] });
    const drafts = PROTOTYPE(QUANTI, '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main>\n{#loop opere_recenti(limit: page.fields.quanti) as o}<p>{o.title}</p>{/loop}{@slot}</main></template>', DRAFT_HOME);
    expect(await checkPrototypeBuild(drafts, { scratchRoot: root }).catch((error: unknown) => error)).toMatchObject({ code: "cms-prototype-invalid", issues: [{ document: "template site/opera", line: 6 }] });
    const leak = await checkPrototypeBuild(LEAK, { scratchRoot: root });
    expect(leak).toMatchObject({ valid: true, preview: { status: "unavailable", reason: "Il sito si costruisce, ma i controlli di sicurezza fermerebbero la pubblicazione: i motivi sono fra gli avvisi." } });
    expect(leak.report.warnings).toContainEqual(expect.stringMatching(/^La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga 5 del prototipo\.$/u));
    expect(leak.preview).not.toHaveProperty("publishBlocks");
    expect(await checkPrototypeBuild(DRAFTS, { scratchRoot: root })).toMatchObject({ valid: true, preview: { status: "unavailable", reason: "Il progetto non ha pagine incluse nella versione. Seleziona almeno una pagina dal catalogo CMS." } });
    expect(await readdir(root)).toEqual([]);
  });
});
