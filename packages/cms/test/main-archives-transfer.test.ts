import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { createStaticPageProfile, validateTransferDocument } from "../src/page-transfer.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError } from "../src/prototype-import.js";
import { prototypeQualityWarnings } from "../src/prototype-quality.js";

/**
 * Review 6, group B1: `{#loop main()}` goes through the transfer as the builder takes it (ProfileValidator's
 * TRANSFER_BUILTIN_QUERY_PRESETS), so a prototype with it imports and exports to WordPress; where main() lists nothing,
 * or with arguments the builder ignores, the check says so at the loop's place. And the quality walk reads the
 * archives the build now writes.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-main-transfer-"));
  roots.push(root);
  return root;
}

const fixture = () => readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
const content = (source: string) => serializeXb(parse(source).blocks);
const lineOf = (html: string, marker: string) => html.split("\n").findIndex((line) => line.includes(marker)) + 1;
const columnOf = (html: string, marker: string) => html.split("\n")[lineOf(html, marker) - 1]!.indexOf(marker) + 1;

async function build(html: string) {
  return buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(await scratch()));
}

async function refusal(html: string): Promise<PrototypeError> {
  const error = await build(html).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PrototypeError);
  return error as PrototypeError;
}

/** The example prototype with the archive template's loop on main(), and a template without role for the cases below. */
async function withMain(extraTemplate = ""): Promise<string> {
  const html = (await fixture()).replace("{#loop opere_recenti() as opera}", "{#loop main() as opera}");
  return extraTemplate ? html.replace("</body>", `${extraTemplate}\n</body>`) : html;
}
const ELENCO = '<template data-histos="template" data-ref="site/elenco" data-title="Elenco"><main><h1>{page.title}</h1>{#loop main() as voce}<p>{voce.title}</p>{/loop}{@slot}</main></template>';

describe("main() nel trasferimento, come lo prende il builder", () => {
  it("il trasferimento porta main() in ogni documento, con o senza argomenti; una query non dichiarata resta rifiutata", () => {
    const loop = content("{#loop main() as x}<p>{x.title}</p>{/loop}");
    // Before: «La query main non è inclusa nel trasferimento CMS.» for every owner.
    for (const ownerKind of ["template", "template-part", "component", "document"] as const) {
      expect(() => validateTransferDocument(loop, { ownerKind }), ownerKind).not.toThrow();
    }
    // The builder takes them and ignores them; the prototype check refuses them where they are written (below).
    expect(() => validateTransferDocument(content("{#loop main(limit: 3) as x}<p>{x.title}</p>{/loop}"), { ownerKind: "template" })).not.toThrow();
    expect(() => validateTransferDocument(content("{#loop nessuna() as x}<p>{x.title}</p>{/loop}"), { ownerKind: "template" })).toThrow("La query nessuna non è inclusa nel trasferimento CMS.");
  });

  it("un progetto con main() in un template si esporta (come verso WordPress) e si reimporta", async () => {
    const opened = await new CmsProjectCatalog(await scratch()).createProject("Main");
    const template = opened.store.createTemplate({ ref: "site/archivio", title: "Archivio", content: content("<main>{#loop main() as voce}<p>{voce.title}</p>{/loop}{@slot}</main>") });
    opened.store.setTemplateRole(template.id, "archive");
    // createStaticPageProfile is the export of the .xbsite and of every WordPress plan and sync (cms-remote.ts).
    const exported = await createStaticPageProfile(opened.project, opened.store);
    const entity = exported.profile.entities.find((item) => item.kind === "template" && item.payload.ref === "site/archivio");
    expect(String(entity?.payload.content)).toContain('"id":"main"');
    const imported = await new CmsProjectCatalog(await scratch()).importStaticPageProfile(exported.profile, exported.files);
    expect(imported.store.getTemplateByRef("site/archivio")?.content).toBe(template.content);
  });

  it("un prototipo con main() nel template d'archivio di un tipo e dei termini si importa", async () => {
    // Before (round 5): the check accepted it, then the import stopped on «La query main non è inclusa nel trasferimento CMS.»
    const built = await build(await withMain());
    const archive = built.profile.entities.find((item) => item.kind === "template" && item.payload.ref === "site/opere");
    expect(String(archive?.payload.content)).toContain('"id":"main"');
    // A template without role that is only a type's archiveTemplate is an archive's too.
    const elenco = (await withMain(ELENCO)).replace('"archiveTemplate": "site/opere"', '"archiveTemplate": "site/elenco"');
    await expect(build(elenco)).resolves.toBeDefined();
    // The home's data-template is no use when a front-page template renders the home.
    const front = (await withMain(ELENCO)).replace('data-slug="home" data-title="Home" data-template="site/page"', 'data-slug="home" data-title="Home" data-template="site/elenco"')
      .replace("</body>", '<template data-histos="template" data-ref="site/home" data-title="Home" data-role="front-page"><main><h1>Home</h1>{@slot}</main></template>\n</body>');
    await expect(build(front)).resolves.toBeDefined();
  });
});

describe("main() dove non elenca nulla o con argomenti: il controllo lo dice al suo posto", () => {
  it("gli argomenti di main(): WordPress li ignora, e il messaggio dice come paginare e ordinare", async () => {
    const html = (await fixture()).replace("{#loop opere_recenti() as opera}", "{#loop main(limit: 3) as opera}");
    const { issues } = await refusal(html);
    expect(issues).toEqual([{
      document: "template site/opere", line: lineOf(html, "{#loop main(limit: 3)"), column: columnOf(html, "{#loop main(limit: 3)"),
      message: "{#loop main()}: main() non accetta argomenti, e WordPress li ignora: elenca i contenuti dell'archivio 10 per pagina, dal più recente, e le pagine seguenti sono …/page/2/, …/page/3/ (page.page e page.totalPages dicono quale). Scrivi main(); per un altro numero o un altro ordine usa una query dichiarata in queries, con limit, orderBy e order.",
    }]);
  });

  it("un template senza ruolo con main() che fa anche da pagina, da articolo o da record si rifiuta al loop, con il nome di chi lo usa", async () => {
    const asPage = (await withMain(ELENCO)).replace("</body>", '<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo" data-template="site/elenco" data-status="draft"><p>Noi</p></template>\n</body>');
    // Before: valid, and the build stopped on /chi-siamo/ with no line (or, as a draft, once published).
    const page = await refusal(asPage);
    expect(page.issues).toEqual([{
      document: "template site/elenco", line: lineOf(asPage, "{#loop main() as voce}"), column: columnOf(asPage, "{#loop main() as voce}"),
      message: "{#loop main()}: main() elenca i contenuti di un archivio, ma con questo template si mostra anche la pagina chi-siamo, che non è un archivio: lì la build del sito si ferma. Dai a quella pagina un altro data-template, o qui usa una query dichiarata in queries.",
    }]);
    const asRecord = (await withMain(ELENCO)).replace('"singleTemplate": "site/opera"', '"singleTemplate": "site/elenco"');
    expect((await refusal(asRecord)).issues).toEqual([{
      document: "template site/elenco", line: lineOf(asRecord, "{#loop main() as voce}"), column: columnOf(asRecord, "{#loop main() as voce}"),
      message: expect.stringMatching(/si mostra anche ogni record del tipo opera, che non è un archivio: lì la build del sito si ferma\. Dai al tipo opera un altro singleTemplate, o qui /u),
    }]);
    const asPost = (await withMain(ELENCO)).replace('data-slug="un-antico-sogno"', 'data-slug="un-antico-sogno" data-template="site/elenco"');
    expect((await refusal(asPost)).issues).toEqual([expect.objectContaining({ document: "template site/elenco", message: expect.stringContaining("si mostra anche l'articolo un-antico-sogno, che non è un archivio: lì la build del sito si ferma. Dai a quell'articolo un altro data-template") })]);
  });
});

describe("la verifica di accessibilità e SEO legge gli archivi che la build scrive (B1)", () => {
  const template = (ref: string, role?: string) => ({ kind: "template", attributes: { "data-ref": ref, ...(role ? { "data-role": role } : {}) }, source: "<main>{@slot}</main>" });
  const home = { kind: "page", attributes: { "data-slug": "home", "data-title": "Home" }, source: "<h1>Home</h1>" };
  const noH1 = (documents: Array<{ kind: string; attributes: Record<string, string>; source: string }>, content: Record<string, unknown>) =>
    prototypeQualityWarnings({ locale: "it-IT", documents, content }).filter((warning) => /senza titolo h1/u.test(warning));

  it("l'archivio vuoto di un tipo e di ogni termine si controlla, come quello di un tipo in un'altra lingua", () => {
    const content = { types: [{ key: "opera" }], taxonomies: [{ key: "tema", types: ["opera"] }], terms: [{ taxonomy: "tema", slug: "notte", label: "Notte" }] };
    // Before: neither (no record, no term «in uso»), though the build writes both.
    expect(noH1([template("site/archivio", "archive"), home], content)).toEqual(["Accessibilità e SEO: 2 pagine senza titolo h1 (site/archivio per l'archivio di opera, site/archivio per i termini di tema)."]);
    // A taxonomy with no term has no archive.
    expect(noH1([template("site/archivio", "archive"), home], { ...content, terms: [] })).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (site/archivio per l'archivio di opera)."]);
    // A published page with the type's address takes its archive's place, in the site's language only.
    const owned = [template("site/archivio", "archive"), home, { kind: "page", attributes: { "data-slug": "opera", "data-title": "Opere" }, source: "<h1>Opere</h1>" }];
    expect(noH1(owned, { types: [{ key: "opera" }] })).toEqual([]);
    expect(noH1(owned, { types: [{ key: "opera" }], records: [{ type: "opera", slug: "ehi", title: "Ehi", locale: "en-US" }] })).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (site/archivio per l'archivio di opera)."]);
    expect(noH1(owned, { types: [{ key: "opera" }], records: [{ type: "opera", slug: "ehi", title: "Ehi", locale: "it-IT" }] })).toEqual([]);
  });

  it("l'elenco degli articoli si controlla con un articolo anche in bozza, mai per un template home da solo", () => {
    const draft = { kind: "post", attributes: { "data-slug": "bozza", "data-title": "Bozza", "data-status": "draft", "data-excerpt": "Breve" }, source: "<h1>Bozza</h1>" };
    const blog = template("site/blog", "home");
    // Before: only with a published post, while the build writes /blog/ for a draft too.
    expect(noH1([blog, home, draft], {})).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (site/blog per il blog)."]);
    expect(noH1([blog, home], {})).toEqual([]);
    // A published page «blog» takes /blog/.
    expect(noH1([blog, home, draft, { kind: "page", attributes: { "data-slug": "blog", "data-title": "Diario" }, source: "<h1>Diario</h1>" }], {})).toEqual([]);
  });
});
