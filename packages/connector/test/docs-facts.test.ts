import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog as BuiltCatalog } from "@histos-publish/cms";
import { TEMPLATE_ROLES } from "@histos-publish/histos-contract";
import { afterEach, describe, expect, it } from "vitest";
import { COMPONENT_REF_PATTERN, parse, refToTag, serializeXb, tagToRef } from "../../cms/.generated/histos-dsl/index.js";
import { histosFrameworkData, histosGlobalCss } from "../../cms/src/histos-css.js";
import { cmsTermArchiveRoles } from "../../cms/src/content-model.js";
import { HISTOS_DESIGN_DEFAULTS, validateHistosDesign } from "../../cms/src/histos-design.js";
import { CmsProjectCatalog, type CmsProjectStore } from "../../cms/src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError, type PrototypeImportOptions } from "../../cms/src/prototype-import.js";
import { prototypeQualityWarnings } from "../../cms/src/prototype-quality.js";
import { renderCmsPage } from "../../cms/src/static-renderer.js";
import { buildCmsProject, checkPrototypeBuild, type CmsOperationsContext } from "../../server/src/cms-api.js";
import { PrototypeInvalidError } from "../../server/src/prototype-check.js";
import { prototypePreviewText } from "../../cli/src/prototype-output.js";
import { agentDocsBundle, QUICK_MAX_WORDS } from "../build-agent-docs.mjs";
import { AGENT_DOCS, agentDoc } from "../src/docs.js";
import { PROTOTYPE_AI_MANUAL } from "../src/manual.generated.js";

/**
 * What the documentation for agents states, checked against what Histeon does: the CSS Publish ships, the transfer
 * profile, the prototype import and the builder's product data. An agent follows the docs literally, so a list that
 * promises a class histos.css lacks, or a pointer to a place where a name never appears, is a wrong page.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const utilitiesCss = read("../../cms/assets/histos-css/histos.css");
const tokensCss = read("../../cms/assets/histos-css/xb-tokens.css");
const classNames = new Set([...utilitiesCss.matchAll(/\.(xb-[a-z0-9-]+)/gu)].map((match) => match[1]!));
const tokenValues = new Map<string, string[]>();
for (const match of tokensCss.matchAll(/(?<![\w-])--(xb-[a-z0-9-]+)\s*:\s*([^;]+);/gu)) tokenValues.set(match[1]!, [...(tokenValues.get(match[1]!) ?? []), match[2]!.trim()]);

/** The two generated lists of the histos-css topic, tokens then classes: each `### Elenco completo` and its lines. */
function histosCssLists(): { tokens: string[]; classes: string[] } {
  const [, tokens = "", classes = ""] = agentDoc("histos-css").split("### Elenco completo\n\n");
  const lines = (section: string) => section.split("\n\n")[0]!.split("\n");
  return { tokens: lines(tokens), classes: lines(classes) };
}

/** The label of a list line and every name it promises, with `-N` and `<famiglia>` expanded by the values it gives. */
function expand(line: string): { label: string; names: string[] } {
  const label = /^- \*\*([^*]+)\*\*/u.exec(line)?.[1]?.replace(/:$/u, "") ?? "";
  const families = (/\(<famiglia>: ([a-z ]+)\)$/u.exec(line)?.[1] ?? /^- \*\*Famiglie di colore\*\* \(([^)]*)\)/u.exec(line)?.[1]?.replaceAll("`", "") ?? "").split(" ");
  const names: string[] = [];
  for (const segment of line.split(". Esempi:")[0]!.split(" · ")) {
    const match = /`((?:--|\.)xb-[a-zA-Z0-9<>-]+)`(?:[^(]*\(N: ([^)]*)\))?/u.exec(segment);
    if (!match) continue;
    let found = [match[1]!];
    if (match[2]) found = found.flatMap((name) => match[2]!.split(" ").map((step) => name.replace(/N$/u, step)));
    if (found.some((name) => name.includes("<famiglia>"))) found = found.flatMap((name) => families.map((family) => name.replace("<famiglia>", family)));
    names.push(...found);
  }
  return { label, names };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("percorso rapido per i modelli piccoli", () => {
  const header = "---\nkey: metodo\ntitle: Il metodo\nsummary: Prova.\n---\n";

  it("prende le parti segnate degli argomenti, in ordine, e toglie i segni dagli argomenti completi", async () => {
    const directory = await scratch("histos-agent-docs-");
    await writeFile(path.join(directory, "02-metodo.md"), `${header}# Il metodo\n\nPrima.\n\n<!-- rapido -->\nRegola essenziale.\n<!-- /rapido -->\n\nDopo.\n`);
    const { topics } = await agentDocsBundle(directory);
    const quick = topics.find((topic: { key: string }) => topic.key === "rapido");
    const full = topics.find((topic: { key: string }) => topic.key === "metodo");
    expect(quick.text).toContain("## Il metodo");
    expect(quick.text).toContain("Regola essenziale.");
    expect(quick.text).not.toContain("Prima.");
    expect(full.text).toContain("Prima.\n\nRegola essenziale.\n\nDopo.");
    expect(full.text).not.toContain("<!--");
  });

  it("rifiuta segni sbagliati e una chiave rapido scritta a mano", async () => {
    const directory = await scratch("histos-agent-docs-");
    for (const [body, error] of [
      ["<!-- rapido -->\nA\n", "<!-- rapido --> senza <!-- /rapido -->"],
      ["A\n<!-- /rapido -->\n", "<!-- /rapido --> senza <!-- rapido -->"],
      ["<!-- rapido -->\n<!-- rapido -->\nA\n<!-- /rapido -->\n", "dentro un'altra parte rapida"],
      ["Testo <!-- rapido -->\n", "va da solo sulla sua riga"],
    ]) {
      await writeFile(path.join(directory, "02-metodo.md"), `${header}${body}`);
      await expect(agentDocsBundle(directory)).rejects.toThrow(error);
    }
    await rm(path.join(directory, "02-metodo.md"));
    await writeFile(path.join(directory, "02-rapido.md"), "---\nkey: rapido\ntitle: R\nsummary: R.\n---\nTesto.\n");
    await expect(agentDocsBundle(directory)).rejects.toThrow("si costruisce da solo");
  });

  it("nel percorso vero ci sono le regole che contano, sotto il limite di parole, e nessun segno è rimasto", () => {
    const quick = agentDoc("rapido");
    for (const must of ["Non pubblichi mai", "nel **suo selettore**", "pannello script", "Il layout approvato si migliora", "lorem ipsum", "Prima di dire «fatto»", "`2.75rem`", "{:else}", "Prima di scrivere: sei domande"]) expect(quick).toContain(must);
    expect(quick.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(QUICK_MAX_WORDS);
    for (const topic of AGENT_DOCS) expect(topic.text, topic.key).not.toMatch(/<!-- \/?rapido -->/u);
    // With the recipes, the small model reads `rapido` and then the one recipe of its job (S1).
    expect(agentDoc()).toContain("leggi `rapido`, poi solo la ricetta del lavoro");
  });
});

describe("documentazione per gli agenti: ciò che dice è vero", () => {
  it("gli elenchi completi di Histeon CSS promettono solo token e classi che esistono, e li danno tutti", () => {
    const { tokens, classes } = histosCssLists();
    const promised = [...tokens, ...classes].flatMap((line) => expand(line).names);
    // `.xb-btn-<famiglia>` promised `.xb-btn-danger`, which histos.css does not have.
    expect(promised.filter((name) => name.startsWith("--") ? !tokenValues.has(name.slice(2)) : !classNames.has(name.slice(1)))).toEqual([]);
    expect([...tokenValues.keys()].filter((name) => !promised.includes(`--${name}`))).toEqual([]);
    expect([...classNames].filter((name) => !promised.includes(`.${name}`))).toEqual([]);
    expect(classes.join("\n")).toContain("`.xb-btn-<famiglia>` · `.xb-btn-<famiglia>-outline` · `.xb-btn-<famiglia>-light` · `.xb-btn-<famiglia>-dark`");
  });

  it("raggruppa le classi come il pannello CSS e mette ogni token nel gruppo giusto", () => {
    const { tokens, classes } = histosCssLists();
    const labels: Record<string, string> = { layout: "Layout", spacing: "Spazi", text: "Testo", color: "Colori", visibility: "Visibilità", shape: "Forme", ui: "Interfaccia", forms: "Moduli", helpers: "Altre" };
    const classGroup = new Map(classes.flatMap((line) => { const { label, names } = expand(line); return names.map((name) => [name.slice(1), label] as const); }));
    // `.xb-border-<famiglia>` landed in «Altre»: the panel has it among the colours.
    for (const { name, group } of histosFrameworkData().classes) expect(classGroup.get(name), name).toBe(labels[group]);
    const tokenGroup = new Map(tokens.flatMap((line) => { const { label, names } = expand(line); return names.map((name) => [name.slice(2), label] as const); }));
    expect(tokenGroup.get("xb-border-width")).toBe("Forme");
    expect(tokenGroup.get("xb-heading-weight")).toBe("Testo e titoli");
    expect(tokenGroup.get("xb-border")).toBe("Colori");
    expect(tokenGroup.get("xb-heading")).toBe("Colori");
    // «Colori» holds colours only: none of its tokens is a number, a length or a weight.
    const colours = [...tokenGroup].filter(([, label]) => label === "Colori").map(([name]) => name);
    expect(colours.length).toBeGreaterThan(10);
    for (const name of colours) for (const value of tokenValues.get(name) ?? []) expect(value, name).not.toMatch(/^[\d.]/u);
  });

  it("dice quali elementi non hanno gli attributi globali (<source>)", () => {
    const lists = JSON.parse(read("../../histos-contract/fixtures/histos-transfer-markup-v1.json")).lists as { elementsWithoutGlobalAttributes: string[] };
    const lines = agentDoc("markup").split("\n");
    const global = lines.find((line) => line.startsWith("- **Su ogni elemento HTML"))!;
    expect(lists.elementsWithoutGlobalAttributes).toContain("source");
    for (const tag of lists.elementsWithoutGlobalAttributes) {
      // The global line names the exception; the element's own line says its list is all it takes.
      expect(global).toMatch(new RegExp(`^- \\*\\*Su ogni elemento HTML tranne [^:]*\`<${tag}>\``, "u"));
      expect(lines.find((line) => line.startsWith(`- **\`<${tag}>\`:**`))).toContain("niente attributi globali");
      // hp_manual says the same where it lists the attributes of each element.
      expect(PROTOTYPE_AI_MANUAL.split("\n").find((line) => line.startsWith("- **Attributi, elenco chiuso per ogni elemento:**"))).toContain(`\`${tag}\` fa eccezione: niente attributi globali`);
    }
  });

  it("dà comandi senza MCP che esistono: i due client si avviano con node", () => {
    const index = agentDoc("indice");
    expect(index).toContain("`node <dati>/connector/histos-publish-connector.mjs docs <argomento>`");
    expect(index).toContain("`node histos-connector.mjs docs <argomento>`");
    expect(index).not.toMatch(/`histos-(?:publish-)?connector docs/u);
    expect(read("../build.mjs")).toContain('"dist/histos-publish-connector.mjs"');
  });

  it("manda a cercare nel brief le query dei loop, che il builder elenca (xb#19, I3-I5), e non le confonde con le media query", () => {
    for (const topic of AGENT_DOCS) {
      for (const line of topic.text.split("\n")) {
        if (!/\bbrief\b/u.test(line)) continue;
        // Since I3 the builder's brief lists loop queries, sources and variable values: no doc may say otherwise.
        expect(line, topic.key).not.toMatch(/brief`? non (?:le|li) elenca|non (?:le|li) elenca[^.]*brief/iu);
      }
      // «Query con nome» was the builder's old name for both: loop queries are «query dei loop» now (I4).
      expect(topic.text.replace(/media query con nome|«query con nome»/giu, ""), topic.key).not.toMatch(/query con nome/iu);
    }
    expect(agentDoc("metodo")).toContain("query dei loop con i parametri");
    for (const key of ["sintassi", "dati", "etch"]) expect(agentDoc(key), key).toMatch(/il `brief` le elenca con i (?:loro )?parametri/iu);
    expect(agentDoc("controllo")).toContain("query dei loop con i parametri, sorgenti di dati");
    expect(agentDoc("etch")).toContain("{#loop etch_<chiave>(…) as …}");
    expect(agentDoc("controllo")).toMatch(/chiedilo all'utente/u);
  });

  it("dice la fiducia dell'importazione da Etch dal lato di Histeon", () => {
    // What the builder's Etch import does: each document keeps its writer's trust; scripts need unfiltered_html.
    const etch = agentDoc("etch");
    expect(etch).toContain("Histeon importa ogni documento con il livello di fiducia di chi l'ha scritto");
    expect(etch).toMatch(/autore e ultimo editor devono avere entrambi `unfiltered_html`, altrimenti passa dal filtro ristretto/u);
    expect(etch).toMatch(/solo se l'autore e l'ultimo editor avevano `unfiltered_html`/u);
    expect(etch).toContain("entrano con la fiducia di chi importa, che deve essere amministratore");
    // Public text: no statement on what another product does about security.
    for (const topic of AGENT_DOCS) {
      expect(topic.text, topic.key).not.toMatch(/Etch[^.\n]{0,40}(?:non distingu|non controll|senza controll)|\bXSS\b/iu);
    }
  });

  it("separa i campi dei prodotti comuni da quelli di WooCommerce e di FluentCart", () => {
    // The keys the builder resolves: plugin/src/Data/ProductNode.php (WooCommerce) and FluentCartProductNode.php.
    const woo = ["price", "regularPrice", "salePrice", "onSale", "priceText", "currency", "currencySymbol", "sku", "inStock", "stockStatus", "type", "shortDescription", "addToCartUrl", "addToCartText", "rating", "reviewCount", "gallery", "categories", "tags"];
    const fluent = ["price", "regularPrice", "salePrice", "onSale", "minPrice", "maxPrice", "priceText", "currency", "currencySymbol", "sku", "inStock", "stockStatus", "type", "fulfillment", "shortDescription", "addToCartUrl", "buyNowUrl", "addToCartText", "variantId", "variations", "subscription", "gallery", "categories", "brands", "tags", "cartUrl", "checkoutUrl"];
    const lines = agentDoc("dati").split("\n");
    const keys = (label: string) => (/`([^`]+)`/u.exec(lines.find((line) => line.startsWith(`  - **${label}:**`)) ?? "")?.[1] ?? "").split(" ").filter(Boolean).sort();
    expect(keys("Con entrambi")).toEqual(woo.filter((key) => fluent.includes(key)).sort());
    expect(keys("Solo WooCommerce")).toEqual(woo.filter((key) => !fluent.includes(key)).sort());
    expect(keys("Solo FluentCart")).toEqual(fluent.filter((key) => !woo.includes(key)).sort());
    // `buyNowUrl` and `variations` were given as fields of both plugins.
    expect(lines.find((line) => line.startsWith("- **Prodotti**"))).not.toMatch(/buyNowUrl|variations/u);
  });

  it("l'esempio di prop enum dei componenti passa il controllo del prototipo, e senza options no", async () => {
    // The same example in the topic and in hp_manual, which the tool description says to read first.
    const examples = [agentDoc("componenti"), PROTOTYPE_AI_MANUAL].map((text) => /`("variante":\{[^`]*"type":"enum"[^`]*\})`/u.exec(text)?.[1]);
    expect(examples[1], "manca l'esempio di prop enum con options in hp_manual").toBe(examples[0]);
    const example = examples[0];
    expect(example, "manca l'esempio di prop enum con options").toBeDefined();
    const prototype = read("../../cms/test/fixtures/prototipo-esempio.html");
    const withProp = (prop: string) => prototype
      .replace(`data-props='{"titolo"`, `data-props='{${prop},"titolo"`)
      .replace('<article class="opera">', '<article class="opera opera--{props.variante}">');
    const check = async (html: string) => {
      const catalog = new CmsProjectCatalog(await scratch("histos-docs-enum-"));
      await catalog.initialize();
      return buildPrototypeProfile(parsePrototype(html), catalog);
    };
    await expect(check(withProp(example!))).resolves.toBeDefined();
    // What the docs used to describe: `type` and `default` only.
    await expect(check(withProp('"variante":{"type":"enum","default":"chiara"}'))).rejects.toThrow(/La prop enum variante deve dichiarare almeno un’opzione/u);
  });

  it("rifiuta un argomento con caratteri invisibili, che chi rilegge non vede e che chiudono un commento JavaScript", async () => {
    expect((await agentDocsBundle()).topics).toEqual(AGENT_DOCS);
    const directory = await scratch("histos-agent-docs-");
    const header = "---\nkey: metodo\ntitle: Il metodo\nsummary: Prova.\n---\n";
    await writeFile(path.join(directory, "02-metodo.md"), `${header}# Il metodo\n\nTesto.\n`);
    expect((await agentDocsBundle(directory)).topics.map((topic: { key: string }) => topic.key)).toEqual(["indice", "rapido", "metodo"]);
    // U+2028 ends a `//` comment where the builder embeds the docs in its connector; the others hide or reorder text.
    for (const point of [0x2028, 0x2029, 0x202e, 0x2066, 0x200b, 0xfeff, 0xe0041, 0x0c]) {
      await writeFile(path.join(directory, "02-metodo.md"), `${header}# Il metodo\n\nMarcatore: // DOCS:end${String.fromCodePoint(point)}globalThis.PWNED = 1;//\n`);
      await expect(agentDocsBundle(directory)).rejects.toThrow(`02-metodo.md, riga 8: carattere invisibile U+${point.toString(16).toUpperCase().padStart(4, "0")}.`);
    }
  });
});

/**
 * The prototype facts the A7 trial found missing or wrong (two small models wrote prototypes from the docs alone). Each
 * is read from the docs as an agent reads it and tried against the code that decides it: the store, the import, the
 * renderer. A rule that changes in code then fails here until the docs say the new one.
 */

/** A 1×1 PNG: any inline media the examples need. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4YaMBAAL8AS3/gzpXAAAAAElFTkSuQmCC";
const PROTOTYPE_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
/** Prototypes that import several times take longer than the default 5 seconds on a busy machine. */
const IMPORTS = 30_000;
/** The facts that need the site built (the check with its build, a static build) take longer still. */
const BUILDS = 90_000;
const docsAndManual = () => [...AGENT_DOCS.map((topic) => ({ where: topic.key, text: topic.text })), { where: "hp_manual", text: PROTOTYPE_AI_MANUAL }];
const ticks = (text: string) => [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
/** The first line of `text` that contains `marker`; the test names the marker when the docs lost it. */
function lineWith(text: string, marker: string): string {
  const line = text.split("\n").find((candidate) => candidate.includes(marker));
  expect(line, `manca la riga con ${marker}`).toBeDefined();
  return line!;
}
/** The fenced blocks of a language, as written. */
const fenced = (text: string, language: string) => [...text.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``, "gu"))].map((match) => match[1]!);
/** The assets example of the docs, with a real image where it abbreviates the data URI. */
const assetsExample = (text: string) => fenced(text, "json").find((block) => block.includes('"name": "logo"'));
const withRealData = (json: string) => json.replace(/"data:image\/webp;base64,[^"]*"/u, JSON.stringify(PNG));

/** A prototype around the given parts: one manifest (its fields replaceable), the given head and body. */
function prototypeHtml(input: { manifest?: Record<string, unknown>; head?: string; body: string }): string {
  const manifest = { format: "histos-prototype", version: 1, id: PROTOTYPE_ID, name: "Prova", locale: "it-IT", timeZone: "Europe/Rome", ...input.manifest };
  return `<!doctype html>\n<html lang="it" data-histos-prototype="1">\n<head>\n<meta charset="utf-8">\n<title>Prova</title>\n<script type="application/json" data-histos="manifest">${JSON.stringify(manifest)}</script>\n${input.head ?? ""}\n</head>\n<body>\n${input.body}\n</body>\n</html>\n`;
}

async function importPrototype(html: string, options: PrototypeImportOptions = {}) {
  const catalog = new CmsProjectCatalog(await scratch("histos-docs-prototype-"));
  await catalog.initialize();
  return buildPrototypeProfile(parsePrototype(html), catalog, options);
}

/** A project with the content model the query, field and renderer facts need. */
async function contentProject(): Promise<{ store: CmsProjectStore; projectId: string; ids: Record<string, string> }> {
  const catalog = new CmsProjectCatalog(await scratch("histos-docs-content-"));
  await catalog.initialize();
  const { project, store } = await catalog.createProject("Contenuti");
  // An Italian project on any computer: the records below are saved without a locale and rendered it-IT.
  store.setRenderSettings({ ...store.getRenderSettings(), locale: "it-IT" });
  const field = (key: string, type: string, extra: Record<string, unknown> = {}) => ({ key, label: key, type, required: false, public: true, multiple: false, ...extra });
  expect(store.content.saveType({ key: "serie", label: "Serie", fields: [], expectedHead: null }).status).toBe("saved");
  expect(store.content.saveType({
    key: "evento", label: "Eventi", expectedHead: null,
    fields: [
      field("data", "date"), field("ora", "datetime"), field("luogo", "text"), field("testo", "rich-text"), field("posti", "integer"), field("prezzo", "decimal"),
      field("gratuito", "boolean"), field("tecnica", "enum", { options: ["olio", "acrilico"] }), field("sito", "url"), field("immagine", "asset"),
      field("serie", "relation", { targetType: "serie" }), field("etichette", "text", { multiple: true }), field("nota", "text", { public: false }),
    ],
  }).status).toBe("saved");
  expect(store.content.saveTaxonomy({ key: "tema", label: "Temi", types: ["evento"], expectedHead: null }).status).toBe("saved");
  expect(store.content.saveTaxonomy({ key: "category", label: "Categorie", types: ["post"], expectedHead: null }).status).toBe("saved");
  const ids: Record<string, string> = {};
  for (const [taxonomyKey, slug, label] of [["tema", "notte", "Notte"], ["category", "racconti", "Racconti"]] as const) {
    const saved = store.content.saveTerm({ taxonomyKey, slug, label, expectedHead: null });
    if (saved.status !== "saved") throw new Error(`termine ${slug} non salvato`);
    ids[slug] = saved.term.id;
  }
  const serie = store.content.saveRecord({ typeKey: "serie", slug: "quadretti", title: "Quadretti", status: "published", publishedAt: "2026-10-01T09:00:00Z", expectedHead: null });
  if (serie.status !== "saved") throw new Error("serie non salvata");
  ids.quadretti = serie.record.id;
  const notte = store.content.getTermById(ids.notte!)!;
  expect(store.content.saveRecord({ typeKey: "evento", slug: "concerto", title: "Concerto", status: "published", publishedAt: "2026-10-02T09:00:00Z", values: { data: "2026-11-07", luogo: "Sala grande" }, terms: { tema: [notte.alias] }, expectedHead: null }).status).toBe("saved");
  return { store, projectId: project.id, ids };
}

describe("documentazione dei prototipi: i fatti della prova A7", () => {
  it("la grammatica dei data-ref è quella del codice, con gli stessi esempi nel manuale, in prototipi, componenti ed errori-tipici", async () => {
    const accepted = (ref: string) => expect(COMPONENT_REF_PATTERN.test(ref) && tagToRef(refToTag(ref)) === ref, `${ref} dovrebbe valere`).toBe(true);
    const refused = (ref: string) => expect(COMPONENT_REF_PATTERN.test(ref), `${ref} dovrebbe essere rifiutata`).toBe(false);
    // The ✅ and ❌ lines of the manual and of prototipi: the same, and each name as the store decides it.
    const lines = [PROTOTYPE_AI_MANUAL, agentDoc("prototipi")].map((text) => [lineWith(text, "- ✅ `card`"), lineWith(text, "- ❌ `site/404`")]);
    expect(lines[1]).toEqual(lines[0]);
    const [good, bad] = lines[0]!;
    expect(ticks(good!).length).toBeGreaterThanOrEqual(5);
    for (const ref of ticks(good!)) accepted(ref);
    for (const item of bad!.replace(/^\s*- ❌ /u, "").split("; ")) {
      const [from, to] = item.split(" → ");
      if (to !== undefined) {
        refused(ticks(from!)[0]!);
        accepted(ticks(to)[0]!);
      } else for (const ref of ticks(item).filter((name) => name !== "/")) refused(ref);
    }
    // componenti: its table of keys and markup names, and its block of refused keys with their fixes.
    const componenti = agentDoc("componenti");
    const keyRows = componenti.split("\n").filter((line) => line.startsWith("| `") && ticks(line)[1]?.startsWith("<"));
    expect(keyRows.length).toBeGreaterThanOrEqual(4);
    for (const row of keyRows) {
      const [ref, tag] = ticks(row);
      accepted(ref!);
      expect(tag!.replace(/^<|\s*\/?>$/gu, ""), ref).toBe(refToTag(ref!));
    }
    const block = fenced(componenti, "text").find((text) => text.startsWith("site/404 "));
    expect(block, "manca in componenti l'elenco delle chiavi rifiutate").toBeDefined();
    for (const line of block!.split("\n")) {
      const [from, to] = line.replace(/\s*\([^)]*\)\s*$/u, "").split(/\s+→\s+/u);
      for (const ref of from!.split(/,\s*/u)) refused(ref.trim());
      for (const ref of to!.split(/,\s*/u)) accepted(ref.trim());
    }
    // Every data-ref written in the docs: refused on a ❌ line, valid anywhere else.
    let refusedExamples = 0;
    for (const { where, text } of docsAndManual()) {
      for (const line of text.split("\n")) {
        for (const match of line.matchAll(/data-ref="([^"]*)"/gu)) {
          if (line.includes("❌")) refusedExamples++;
          expect(COMPONENT_REF_PATTERN.test(match[1]!), `${where}: ${match[1]}`).toBe(!line.includes("❌"));
        }
      }
    }
    expect(refusedExamples, "errori-tipici mostra il data-ref sbagliato").toBeGreaterThan(0);
    expect(agentDoc("errori-tipici")).toContain('data-ref="site/pagina-non-trovata" data-role="404"');
    // And the import itself: the template the trial named site/404 stops it, the name the docs give passes.
    const withTemplate = (ref: string) => prototypeHtml({ body: `<template data-histos="template" data-ref="${ref}" data-role="404" data-title="Pagina non trovata"><main><h1>Pagina non trovata</h1>{@slot}</main></template>\n<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>` });
    await expect(importPrototype(withTemplate("site/404"))).rejects.toThrow();
    await expect(importPrototype(withTemplate("site/pagina-non-trovata"))).resolves.toBeDefined();
  }, IMPORTS);

  it("il manifest e i media hanno i campi e i limiti che il lettore del prototipo accetta", () => {
    const home = '<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>';
    // The manifest table: its fields are all the parser takes; one more stops it, and so does an id in capitals.
    const table = PROTOTYPE_AI_MANUAL.split("### Il manifest\n")[1]!.split("\n\n")[0]!;
    const fields = table.split("\n").slice(2).flatMap((row) => ticks(row.split(" | ")[0]!));
    expect(fields.sort()).toEqual(["acss", "design", "format", "framework", "id", "locale", "name", "siteTokens", "timeZone", "version"]);
    const formatRow = table.split("\n").find((row) => row.startsWith("| `format`"))!;
    expect(agentDoc("prototipi")).toContain(formatRow);
    expect(parsePrototype(prototypeHtml({ manifest: { framework: "acss", acss: "convert", design: {} }, body: home })).manifest).toMatchObject({ framework: "acss", acss: "convert" });
    // Doc 28: the site's variables, an object name → value.
    expect(parsePrototype(prototypeHtml({ manifest: { siteTokens: { "testo-17": "17px" } }, body: home })).manifest.siteTokens).toEqual({ "testo-17": "17px" });
    expect(() => parsePrototype(prototypeHtml({ manifest: { autore: "x" }, body: home }))).toThrow(/campo sconosciuto autore/u);
    expect(() => parsePrototype(prototypeHtml({ manifest: { id: PROTOTYPE_ID.toUpperCase() }, body: home }))).toThrow(/UUID minuscolo/u);
    // The design parameters the manual names exist, and the example of prototipi passes the design's own check.
    const designKeys = ticks(table.split("\n").find((row) => row.startsWith("| `design`"))!).filter((name) => name !== "design" && /^[a-z][a-z0-9_]*$/u.test(name));
    expect(designKeys).toEqual(expect.arrayContaining(["primary", "info", "font_body", "font_heading", "font_mono"]));
    for (const key of designKeys) expect(Object.hasOwn(HISTOS_DESIGN_DEFAULTS, key), key).toBe(true);
    // Every parameter, the numbers too (review 4, D4: the manual named colours and fonts only, then said that any
    // other key stops the import).
    expect(Object.keys(HISTOS_DESIGN_DEFAULTS).filter((key) => !designKeys.includes(key))).toEqual([]);
    expect(() => validateHistosDesign({ primary: "#c83c28", radius: 12, width_prose: 60, text_min: 17 })).not.toThrow();
    const designExample = /per esempio `(\{[^`]+\})`/u.exec(lineWith(agentDoc("prototipi"), "| `design`"))?.[1];
    expect(designExample, "manca l'esempio di design in prototipi").toBeDefined();
    expect(() => validateHistosDesign(JSON.parse(designExample!))).not.toThrow();
    // framework none still ships Histeon CSS in what Publish builds: the tokens are in every build's global CSS.
    expect(lineWith(PROTOTYPE_AI_MANUAL, '**`"framework": "none"`:**')).toContain("ha comunque i token e le classi di Histeon CSS");
    expect(histosGlobalCss({})).toContain("--xb-space-m:");

    // The assets block: the same example in the manual and in prototipi, and its fields are those the parser takes.
    const examples = [PROTOTYPE_AI_MANUAL, agentDoc("prototipi")].map(assetsExample);
    expect(examples[0], "manca l'esempio del blocco assets").toBeDefined();
    expect(examples[1]).toBe(examples[0]);
    const assets = JSON.parse(withRealData(examples[0]!)) as Array<Record<string, string>>;
    expect([...new Set(assets.flatMap((asset) => Object.keys(asset)))].sort()).toEqual(["alt", "caption", "data", "name", "url"]);
    const withAssets = (list: unknown) => prototypeHtml({ head: `<script type="application/json" data-histos="assets">${JSON.stringify(list)}</script>`, body: home });
    expect(parsePrototype(withAssets(assets)).assets.map((asset) => asset.name)).toEqual(["ehi", "logo"]);
    const [remote, inline] = assets as [Record<string, string>, Record<string, string>];
    expect(() => parsePrototype(withAssets([{ ...inline, title: "x" }]))).toThrow(/campo sconosciuto title/u);
    expect(() => parsePrototype(withAssets([{ ...inline, url: remote.url }]))).toThrow(/esattamente uno tra url e data/u);
    // The limits the docs give: alt 1.000 and caption 4.000 characters, a name of 63.
    for (const text of [PROTOTYPE_AI_MANUAL, agentDoc("prototipi")]) {
      expect(lineWith(text, "Esattamente uno fra `url`")).toContain("e `data` (un data URI in base64)");
      expect(lineWith(text, "`alt` (al massimo")).toContain("`alt` (al massimo 1.000 caratteri) e `caption` (al massimo 4.000) sono facoltativi. Nessun altro campo.");
      expect(lineWith(text, "- `name`: minuscole, cifre e trattini")).toContain("al massimo 63 caratteri");
    }
    expect(() => parsePrototype(withAssets([{ ...inline, alt: "a".repeat(1000), caption: "c".repeat(4000), name: `a${"b".repeat(62)}` }]))).not.toThrow();
    expect(() => parsePrototype(withAssets([{ ...inline, alt: "a".repeat(1001) }]))).toThrow(/alt/u);
    // Each problem at its entry of the JSON, as the docs' example writes it.
    const refused = (() => {
      try { parsePrototype(withAssets([{ ...inline, alt: "a".repeat(1001) }])); } catch (error) { return error; }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(PrototypeError);
    const [issue] = (refused as PrototypeError).issues;
    expect(issue).toMatchObject({ document: "assets", line: expect.any(Number), column: expect.any(Number) });
    for (const text of [PROTOTYPE_AI_MANUAL, agentDoc("prototipi")]) expect(/`assets, riga \d+, colonna \d+: (Media logo: [^`]+)`/u.exec(text)?.[1]).toBe(issue!.message);
    expect(() => parsePrototype(withAssets([{ ...inline, caption: "c".repeat(4001) }]))).toThrow(/caption/u);
    expect(() => parsePrototype(withAssets([{ ...inline, name: `a${"b".repeat(63)}` }]))).toThrow(/nome mancante, non valido/u);
  });

  it("gli esempi di contenuti, media e articolo con data-terms si importano così come sono scritti", async () => {
    const templates = '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1>{@slot}</main></template>\n<template data-histos="template" data-ref="site/opere" data-title="Opere"><main><h1>{page.title}</h1>{#if page.totalRecords}<p>Opere</p>{:else}<p>Nessuna opera.</p>{/if}{@slot}</main></template>';
    const post = (text: string) => {
      const example = fenced(text, "html").find((block) => block.includes('data-histos="post"') && block.includes("data-terms=") && block.includes("un-antico-sogno"));
      expect(example, "manca l'esempio di articolo con data-terms").toBeDefined();
      return example!;
    };
    // data-terms is JSON, taxonomies and their slugs, the same in the manual and in prototipi.
    const postExample = post(PROTOTYPE_AI_MANUAL);
    expect(post(agentDoc("prototipi"))).toBe(postExample);
    const terms = JSON.parse(/data-terms='([^']*)'/u.exec(postExample)![1]!) as Record<string, unknown>;
    expect(Object.values(terms).every((slugs) => Array.isArray(slugs) && slugs.every((slug) => typeof slug === "string"))).toBe(true);
    const assets = withRealData(assetsExample(PROTOTYPE_AI_MANUAL)!);
    for (const [where, text] of [["hp_manual", PROTOTYPE_AI_MANUAL], ["dati", agentDoc("dati")]] as const) {
      const content = fenced(text, "json").find((block) => block.includes('"types"'));
      expect(content, `${where}: manca l'esempio di content`).toBeDefined();
      const forPosts = (JSON.parse(content!) as { taxonomies: Array<{ types: string[] }> }).taxonomies.some((taxonomy) => taxonomy.types.includes("post"));
      const html = prototypeHtml({
        head: `<script type="application/json" data-histos="assets">${assets}</script>\n<script type="application/json" data-histos="content">${content}</script>`,
        body: `${templates}\n<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1><img src="asset:logo" alt="Studio Ehi" width="1" height="1"></template>${forPosts ? `\n${postExample}` : ""}`,
      });
      const { report } = await importPrototype(html, { remotePlaceholders: true });
      expect(report.counts.records, where).toBe(1);
      expect(report.counts.queries, where).toBe(2);
      if (forPosts) expect(report.counts.posts, where).toBe(1);
    }
  }, IMPORTS);

  it("il prototipo d'esempio del manuale (§1.3) passa il controllo con la build, valido e senza avvisi", async () => {
    // The kit a small model copies first: it must stay valid as the import and the build change.
    const kit = fenced(PROTOTYPE_AI_MANUAL, "html").find((block) => block.includes('data-histos-prototype="1"'));
    expect(kit, "manca il prototipo d'esempio nel §1.3").toBeDefined();
    const checked = await checkPrototypeBuild(kit!, { scratchRoot: await scratch("histos-docs-kit-") });
    expect(checked).toMatchObject({ valid: true, preview: { status: "built" } });
    expect(checked.report.warnings).toEqual([]);
  }, BUILDS);

  it("i modelli di progettare sono presi tali e quali da un prototipo che si costruisce valido e senza avvisi", async () => {
    // A small model copies these templates literally: each fenced block of the topic is in the fixture, which passes the
    // check with the build (the browser part, axe and the 390 px width, is run by hand with prototype verify).
    const fixture = read("fixtures/progettare.html");
    const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
    // A CSS block may hold more rules: each top-level rule (a line starting with `.`) is checked on its own.
    const blocks = [...fenced(agentDoc("progettare"), "html"), ...fenced(agentDoc("progettare"), "css").flatMap((block) => block.split(/\n(?=\.)/u))];
    expect(blocks.length).toBeGreaterThanOrEqual(15);
    for (const block of blocks) expect(flat(fixture), block.slice(0, 80)).toContain(flat(block));
    const checked = await checkPrototypeBuild(fixture, { scratchRoot: await scratch("histos-docs-progettare-") });
    expect(checked).toMatchObject({ valid: true, preview: { status: "built" } });
    expect(checked.report.warnings).toEqual([]);
  }, BUILDS);

  it("orderBy, filtri e chiavi delle query sono quelli che il modello dei contenuti accetta", async () => {
    const { store, ids } = await contentProject();
    try {
      let next = 0;
      const saves = (preset: Record<string, unknown>) => {
        const result = store.content.saveQueryPreset({ key: `q${next++}`, label: "Prova", typeKey: "evento", ...preset, expectedHead: null } as Parameters<typeof store.content.saveQueryPreset>[0]);
        expect(result.status, JSON.stringify(preset)).toBe("saved");
      };
      for (const [where, text] of [["dati", agentDoc("dati")], ["hp_manual", PROTOTYPE_AI_MANUAL]] as const) {
        const typeLine = lineWith(text, "`orderBy` per un tipo");
        const forTypes = ticks(typeLine.split("oppure")[0]!).filter((name) => name !== "orderBy");
        const forPosts = ticks(lineWith(text, "`orderBy` per gli articoli")).filter((name) => name !== "orderBy");
        expect(forTypes, where).toEqual(["order", "title", "slug", "publishedAt", "updatedAt"]);
        expect(forPosts, where).toEqual(["order", "title", "slug", "publishedAt", "updatedAt", "createdAt"]);
        for (const orderBy of forTypes) saves({ orderBy });
        for (const orderBy of forPosts) saves({ typeKey: "post", orderBy });
        // What only posts have is refused on a type: the docs of the trial offered createdAt for every query.
        for (const orderBy of forPosts.filter((name) => !forTypes.includes(name))) expect(() => saves({ orderBy }), `${where}: ${orderBy}`).toThrow(/non può ordinare/u);
        // A public field orders a type («prossimi eventi» by date), unless it is of a kind the docs exclude or private.
        saves({ orderBy: "data", order: "asc" });
        const excluded = ticks(typeLine.split("che non sia")[1]!.split(".")[0]!);
        expect(excluded, where).toEqual(["relation", "asset", "rich-text"]);
        for (const key of ["serie", "immagine", "testo", "nota"]) expect(() => saves({ orderBy: key }), `${where}: ${key}`).toThrow(/non può ordinare/u);
        expect(() => saves({ typeKey: "post", orderBy: "data" })).toThrow(/non può ordinare gli articoli/u);

        // Field filters: every documented op on a field that takes it; one more is refused; posts take none.
        const ops = /con `op` fra `([^`]+)`/u.exec(lineWith(text, "`filter` per campo"))![1]!.split(" ");
        expect([...ops].sort(), where).toEqual(["contains", "eq", "exists", "gt", "gte", "in", "lt", "lte", "ne"]);
        for (const op of ops) {
          saves({ filter: op === "exists" ? { field: "data", op } : op === "in" ? { field: "data", op, value: ["2026-11-07"] } : op === "contains" ? { field: "luogo", op, value: "Sala" } : { field: "data", op, value: "2026-11-01" } });
        }
        expect(() => saves({ filter: { field: "data", op: "like", value: "2026" } })).toThrow(/Operatore filtro sconosciuto/u);
        saves({ filter: { field: "tecnica", op: "eq", value: "olio" } });
        expect(() => saves({ filter: { field: "immagine", op: "exists" } })).toThrow(/asset/u);
        expect(() => saves({ filter: { field: "etichette", op: "eq", value: "x" } })).toThrow(/multiplo/u);
        expect(() => saves({ filter: { field: "nota", op: "eq", value: "x" } })).toThrow(/non è disponibile/u);
        saves({ filter: { field: "serie", op: "exists" } });
        saves({ filter: { field: "serie", op: "eq", value: ids.quadretti } });
        expect(() => saves({ filter: { field: "serie", op: "ne", value: ids.quadretti } })).toThrow(/non è supportato per il campo relazione/u);
        expect(() => saves({ typeKey: "post", filter: { field: "data", op: "exists" } })).toThrow(/soltanto per categorie, tag o altre tassonomie/u);
        // Taxonomy filters: the three operators, for a type and for posts, alone or in a group.
        const operators = ticks(lineWith(text, "`filter` per tassonomia").split(", con ")[1]!);
        expect(operators, where).toEqual(["IN", "NOT IN", "AND"]);
        for (const operator of operators) {
          saves({ filter: { taxonomyKey: "tema", termIds: [ids.notte], operator } });
          saves({ typeKey: "post", filter: { taxonomyKey: "category", termIds: [ids.racconti], operator } });
        }
        saves({ filter: { and: [{ taxonomyKey: "tema", termIds: [ids.notte], operator: "IN" }, { field: "data", op: "gte", value: "2026-11-01" }] } });
        saves({ filter: { or: [{ field: "luogo", op: "contains", value: "Sala" }, { field: "data", op: "exists" }] } });
      }
      // «Prossimi eventi»: the ✅ query of dati and the filter it shows are saved as written.
      const dati = agentDoc("dati");
      const upcoming = JSON.parse(/✅ (\{[^\n]+\})/u.exec(dati)![1]!) as { key: string; label: string; type: string; limit: number; orderBy: string; order: "asc" | "desc" };
      expect(store.content.saveQueryPreset({ key: upcoming.key, label: upcoming.label, typeKey: upcoming.type, limit: upcoming.limit, orderBy: upcoming.orderBy, order: upcoming.order, expectedHead: null }).status).toBe("saved");
      saves({ filter: JSON.parse(/Un filtro `(\{[^`]+\})`/u.exec(dati)![1]!) });

      // Query keys, limits and defaults as the docs give them.
      const reserved = ticks(lineWith(dati, "- **`key`:** lettere, cifre e `_`").split("; non ")[1]!.split(".")[0]!);
      expect(reserved).toEqual(["posts", "terms", "main", "users"]);
      expect(lineWith(PROTOTYPE_AI_MANUAL, "  - `key`: lettere, cifre e `_`")).toContain("non `posts`, `terms`, `main` o `users`");
      for (const key of [...reserved, "opere-recenti"]) expect(() => store.content.saveQueryPreset({ key, label: "Prova", typeKey: "evento", expectedHead: null }), key).toThrow(/non è valido o è riservato/u);
      const defaults = store.content.saveQueryPreset({ key: "predefinita", label: "Prova", typeKey: "evento", expectedHead: null });
      if (defaults.status !== "saved") throw new Error("query non salvata");
      expect(defaults.preset).toMatchObject({ limit: 10, orderBy: "order", order: "asc" });
      const limits = lineWith(dati, "- **`limit`**");
      expect(limits).toContain("da 1 a 100 (predefinito 10)");
      expect(limits).toContain("`order`** `asc` (predefinito)");
      saves({ limit: 100 });
      expect(() => saves({ limit: 101 })).toThrow(/da 1 a 100/u);
    } finally {
      store.close();
    }
  });

  it("i valori dei campi hanno le forme della tabella, e un datetime senza fuso è rifiutato", async () => {
    const { store } = await contentProject();
    try {
      for (const [where, text] of [["dati", agentDoc("dati")], ["hp_manual", PROTOTYPE_AI_MANUAL]] as const) {
        const table = text.split("**Valori dei campi:**")[1];
        expect(table, `${where}: manca la tabella dei valori dei campi`).toBeDefined();
        const row = (type: string) => lineWith(table!, `| \`${type}\` |`);
        // The examples a row gives as JSON values; abbreviated ones ("https://…") are left out.
        const values = (type: string) => ticks(row(type)).filter((value) => /^(?:"[^"…]*"|-?\d+(?:\.\d+)?|true|false)$/u.test(value)).map((value) => JSON.parse(value) as unknown);
        const accepts = (key: string, value: unknown) => {
          const saved = store.content.saveRecord({ typeKey: "evento", title: `${where} ${key} ${String(value)}`, status: "published", publishedAt: "2026-10-02T09:00:00Z", values: { [key]: value }, expectedHead: null });
          expect(saved.status, `${where}: ${key} = ${JSON.stringify(value)}`).toBe("saved");
        };
        expect(values("date"), where).toEqual(["2026-11-07"]);
        for (const value of values("date")) accepts("data", value);
        expect(values("datetime").length, where).toBe(2);
        for (const value of values("datetime")) accepts("ora", value);
        expect(row("datetime"), where).toContain("ora e fuso sempre");
        expect(() => accepts("ora", "2026-11-07T18:30:00")).toThrow(/fuso esplicito/u);
        const [integer, decimal] = values("integer`, `decimal") as [number, number];
        accepts("posti", integer);
        accepts("prezzo", decimal);
        expect(() => accepts("posti", decimal)).toThrow(/intero/u);
        expect(values("boolean"), where).toEqual([true, false]);
        for (const value of values("boolean")) accepts("gratuito", value);
        const paths = values("url").filter((value) => typeof value === "string" && value.startsWith("/"));
        expect(paths.length, where).toBe(1);
        for (const value of paths) accepts("sito", value);
      }
    } finally {
      store.close();
    }
  });

  it("i termini di un elemento di un loop hanno label e slug, non url, e il loop dell'esempio li stampa", async () => {
    const { store, projectId } = await contentProject();
    try {
      for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(lineWith(text, "| Elemento di un loop |")).toContain("x.terms.<tassonomia>[].label/slug");
      expect(store.content.saveQueryPreset({ key: "eventi", label: "Eventi", typeKey: "evento", expectedHead: null }).status).toBe("saved");
      const [item] = store.content.resolveQueryPreset("eventi");
      const term = (item!.terms.tema ?? [])[0] as unknown as Record<string, unknown>;
      expect(term).toMatchObject({ label: "Notte", slug: "notte" });
      expect(term.url).toBeUndefined();
      // The example loop over a record's terms, as dati and the manual write it, inside a query loop.
      for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) {
        const example = /`(\{#loop opera\.terms\.tema as t\}.*?\{\/loop\})`/u.exec(text)?.[1];
        expect(example, "manca l'esempio del loop sui termini").toBeDefined();
        const content = serializeXb(parse(`{#loop eventi() as opera}${example}{/loop}`).blocks);
        const rendered = await renderCmsPage({ store, projectId, content, locale: "it-IT", timeZone: "Europe/Rome" });
        expect(rendered.html).toContain('<a href="/tema/notte/">Notte</a>');
      }
    } finally {
      store.close();
    }
  });

  it("le lettere di date() della tabella danno quello che la tabella promette, e senza formato Publish stampa AAAA-MM-GG", async () => {
    const { store, projectId } = await contentProject();
    try {
      const render = async (expression: string) => {
        const content = serializeXb(parse(`<p>{${expression}}</p>`).blocks);
        const page = { id: projectId, title: "Prova", slug: "prova", url: "/prova/", quando: "2026-11-07T09:05:00", giorno: "2026-11-07" };
        const rendered = await renderCmsPage({ store, projectId, content, page, locale: "it-IT", timeZone: "Europe/Rome" });
        return /<p>(.*?)<\/p>/u.exec(rendered.html)?.[1];
      };
      const table = agentDoc("sintassi").split("### Date\n")[1]!.split("\n\n")[1]!;
      const pairs = table.split("\n").slice(2).flatMap((row) => {
        const cells = row.replace(/^\| | \|$/gu, "").split(" | ");
        return [[cells[0], cells[1]], [cells[2], cells[3]]].map(([letter, gives]) => ({ letter: ticks(letter!)[0]!, gives: ticks(gives!).at(-1) }));
      });
      // The row of the escape: two backslashes, as the file has them (review 4, D1: the table said one).
      expect(pairs.map((pair) => pair.letter)).toContain("\\\\");
      const letters = pairs.map((pair) => pair.letter).filter((letter) => letter !== "\\\\");
      expect(letters.length).toBeGreaterThanOrEqual(13);
      for (const { letter, gives } of pairs) if (letter !== "\\\\") expect(await render(`page.quando.date("${letter}")`), letter).toBe(gives);
      // The manual names the same letters; every example of it and of sintassi gives what it says, the escaped one too.
      const manualLetters = ticks(lineWith(PROTOTYPE_AI_MANUAL, '- **Date:** `date("formato")`').split("lettere di `date()` di PHP:")[1]!.split(". Nomi")[0]!);
      expect(manualLetters.sort()).toEqual([...letters].sort());
      for (const text of [PROTOTYPE_AI_MANUAL, agentDoc("sintassi")]) {
        const examples = [...text.matchAll(/`\{opera\.fields\.in_mostra\.date\("([^"]+)"\)\}` dà «([^»]+)»/gu)];
        expect(examples.length, "manca l'esempio di date()").toBeGreaterThanOrEqual(2);
        expect(examples.map((example) => example[1]), "manca l'esempio con le barre raddoppiate").toContain("j \\\\d\\\\i F");
        for (const [, format, result] of examples) expect(await render(`page.giorno.date("${format}")`), format).toBe(result);
      }
      // One backslash in the file: the string loses it and the letters stay letters, as the docs say it would print;
      // the check refuses it, showing the doubled form, and refuses \n too.
      expect(await render('page.giorno.date("j \\d\\i F")')).toBe("7 0700 novembre");
      for (const text of [PROTOTYPE_AI_MANUAL, agentDoc("sintassi")]) expect(text).toContain("«7 0700 novembre»");
      const dated = (format: string) => importPrototype(prototypeHtml({ body: `<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1><p>{page.title.date("${format}")}</p></template>` }));
      await expect(dated("j \\d\\i F")).rejects.toThrow('raddoppia la barra: date("j \\\\d\\\\i F")');
      await expect(dated("j\\nF")).rejects.toThrow(/\\n diventa un a capo/u);
      expect(await render("page.giorno.date()")).toBe("2026-11-07");
      expect(lineWith(agentDoc("sintassi"), "**Scrivi sempre il formato.**")).toContain("Publish stampa `2026-11-07`");
      // What the docs say stops the build does: an unknown letter, a date in another form. The check finds the
      // letter, with its place; a value that comes from data in another form is left to the build, as the docs say
      // (the preview's outcome is tried in «l'anteprima del controllo»).
      await expect(render('page.giorno.date("X")')).rejects.toThrow(/token data X/u);
      await expect(render('page.title.date("j")')).rejects.toThrow(/data ISO/u);
      for (const text of [PROTOTYPE_AI_MANUAL, agentDoc("sintassi")]) {
        expect(text).toMatch(/il controllo li segnala con documento, riga e colonna: un modificatore sconosciuto/u);
        expect(text).toMatch(/vede solo la build:\*\* una data che arriva dai dati in un'altra forma[^\n]*`limit: page\.title`[^\n]*«La versione del sito si ferma: …»/u);
      }
      await expect(dated("X")).rejects.toThrow(/X/u);
      await expect(dated("j")).resolves.toBeDefined();
    } finally {
      store.close();
    }
  }, IMPORTS);

  it("il manuale e gli argomenti non mandano a leggere file del repository: chi li legge non ce l'ha", () => {
    for (const { where, text } of docsAndManual()) expect(text, where).not.toMatch(/docs\/(?:progettazione|spec)|packages\/[a-z]|\b\d{2}-[a-z-]+\.md\b/u);
    expect(PROTOTYPE_AI_MANUAL.split("\n\n")[1]).toContain("Contiene tutto il formato: non ti serve nessun altro documento.");
  });

  it("nei template e nelle parti page è il documento che il template mostra, e nei template d'archivio page.totalRecords dice il caso vuoto", async () => {
    for (const [where, text] of [["dati", agentDoc("dati")], ["sintassi", agentDoc("sintassi")], ["prototipi", agentDoc("prototipi")], ["hp_manual", PROTOTYPE_AI_MANUAL]] as const) {
      expect(text, where).toContain("`page` è il documento che il template");
    }
    for (const [where, text] of [["dati", agentDoc("dati")], ["controllo", agentDoc("controllo")], ["hp_manual", PROTOTYPE_AI_MANUAL]] as const) {
      expect(text, where).toMatch(/template d'archivio[^\n]*`\{#if page\.totalRecords\}…\{:else\}/u);
    }
    expect(agentDoc("metodo")).toContain("Prevedi il caso vuoto dove si può contare");
    const catalog = new CmsProjectCatalog(await scratch("histos-docs-template-"));
    await catalog.initialize();
    const { project, store } = await catalog.createProject("Template");
    try {
      const source = (html: string) => serializeXb(parse(html).blocks);
      store.createTemplatePart({ ref: "site/header", title: "Testata", area: "header", content: source('<header><p class="testata">{page.title}</p></header>') });
      store.createTemplate({ ref: "site/opere", title: "Opere", content: source('<Site.Header /><main>{#if page.totalRecords}<p>{page.totalRecords} opere</p>{:else}<p>Nessuna opera.</p>{/if}{@slot}</main>') });
      const archive = (totalRecords: number) => renderCmsPage({ store, projectId: project.id, content: "", templateRef: "site/opere", page: { id: "0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c", title: "Opere", slug: "opera", url: "/opera/", page: 1, totalPages: 1, totalRecords } });
      const empty = (await archive(0)).html;
      expect(empty).toContain('<p class="testata">Opere</p>');
      expect(empty).toContain("<p>Nessuna opera.</p>");
      expect((await archive(2)).html).toContain("<p>2 opere</p>");
    } finally {
      store.close();
    }
  });

  it("la tabella dei template per vista è la stessa nel manuale e in prototipi e nomina solo ruoli che esistono", () => {
    const templates = (text: string) => {
      const table = text.split("Quale template usa ogni vista")[1]!.split("\n\n").find((block) => block.trimStart().startsWith("| Vista"))!;
      const rows = table.trim().split("\n").slice(2);
      return rows.map((row) => row.replace(/ \|$/u, "").split(" | ")[1]!);
    };
    const manual = templates(PROTOTYPE_AI_MANUAL);
    expect(manual.length).toBe(10);
    // The three term rows are the build's own order (cmsTermArchiveRoles): a term of another taxonomy never takes the
    // category role (review 10).
    const rolesOf = (cell: string) => ticks(cell).filter((name) => (TEMPLATE_ROLES as readonly string[]).includes(name));
    expect(manual.slice(5, 8).map(rolesOf)).toEqual([cmsTermArchiveRoles("category"), cmsTermArchiveRoles("post_tag"), cmsTermArchiveRoles("tema")].map((roles) => [...roles]));
    expect(templates(agentDoc("prototipi"))).toEqual(manual);
    const roles = manual.flatMap((cell) => ticks(cell)).filter((name) => !["data-template", "singleTemplate", "archiveTemplate"].includes(name));
    for (const role of roles) expect(TEMPLATE_ROLES as readonly string[], role).toContain(role);
    // Every role but search (WordPress only) decides some view of the static site.
    expect(TEMPLATE_ROLES.filter((role) => role !== "search" && !roles.includes(role))).toEqual([]);
    for (const text of [PROTOTYPE_AI_MANUAL, agentDoc("prototipi")]) expect(text).toContain("senza, i suoi record prendono il template di ruolo `single`, quello degli articoli.");
  });

  it("le classi che l'import converte da ACSS sono utility di Histeon CSS che valgono: i documenti lo dicono, non «nessuna utility»", async () => {
    const acssMap = JSON.parse(read("../../cms/assets/histos-css/acss-map.json")) as { classes: Record<string, string> };
    expect(acssMap.classes["text--l"]).toBe("xb-text-l");
    expect(classNames.has("xb-text-l")).toBe(true);
    const { report } = await importPrototype(prototypeHtml({ manifest: { framework: "acss" }, body: '<template data-histos="page" data-slug="home" data-title="Home"><h1 class="hero__title text--l">Home</h1></template>' }));
    expect(report.warnings.join("\n")).toContain(".text--l → .xb-text-l");
    expect(report.warnings.join("\n")).not.toMatch(/utility/iu);
    for (const [where, text] of [["stile", agentDoc("stile")], ["acss", agentDoc("acss")], ["errori-tipici", agentDoc("errori-tipici")], ["controllo", agentDoc("controllo")], ["hp_manual", PROTOTYPE_AI_MANUAL]] as const) {
      expect(text, where).toContain("`text--l` → `xb-text-l`");
      expect(text, where).toMatch(/controllo non (?:le )?segnala|il controllo non vede: le catene di utility/u);
      expect(text, where).not.toMatch(/Utility nel prototipo:\*\* nessuna\.|nel prototipo nessuna\.|[Nn]essuna utility[,.]/u);
    }
  }, IMPORTS);

  it("controllo, manuale e accessibilita nominano ogni avviso che il rapporto dell'import dà", async () => {
    // Each warning the report can give, by what its text says, and the words the docs use for it.
    const phrases: Array<[RegExp, string]> = [
      [/Commento HTML rimosso/u, "commenti HTML rimossi"],
      [/non è usato: è comunque nella libreria/u, "media mai usat"],
      [/media remoti non scaricati/u, "media remoti non scaricati"],
      [/^Immagini: .* senza width o height/u, "senza `width` o `height`"],
      [/^Variabili senza valore/u, "senza valore"],
      [/^Classi ACSS senza regola/u, "classi ACSS senza regola"],
      [/^(Nota: )?ACSS/u, "convertit"],
      [/^CSS che l'import non legge/u, "CSS che l'import non legge come il browser"],
      [/il modulo invia i dati/u, "i dati a un altro sito"],
      [/Gli articoli non hanno categorie né tag/u, "articoli senza categorie né tag"],
      [/^framework none/u, '`"framework": "none"`'],
      [/non dice la lingua \(locale\)/u, "`locale`"],
      [/immagini senza alt/u, "immagini senza `alt`"],
      [/link senza testo né aria-label/u, "link senza testo né `aria-label`"],
      [/senza titolo h1/u, "senza `h1`"],
      [/più di un h1/u, "più di un `h1`"],
      [/i titoli saltano un livello/u, "titoli che saltano un livello"],
      [/\bsection\b|sezion/iu, "`section` senza titolo"],
      [/pagine con lo stesso titolo/u, "pagine con lo stesso titolo"],
      [/senza riassunto/u, "articoli senza riassunto"],
      // Reviews 5–9: the renderer's limits, a global sheet kept unparsed, the source map that ends a sheet, and what
      // would stop publishing a site that builds (the check with its build only).
      [/^Build del sito: /u, "«Build del sito: …»"],
      [/l'import non ne legge le regole\.$/u, "l'import non ne legge le regole"],
      [/: tolto il source map incorporato \(/u, "tolto il source map incorporato"],
      [/^La pubblicazione si fermerebbe: /u, "«La pubblicazione si fermerebbe: …»"],
    ];
    const assets = JSON.stringify([{ name: "foto", data: PNG }, { name: "inutile", data: PNG }, { name: "remota", url: "https://example.org/remota.png" }]);
    const none = prototypeHtml({
      manifest: { framework: "none", locale: undefined },
      head: `<script type="application/json" data-histos="assets">${assets}</script>\n<style data-histos="selectors">.scheda { color: var(--non-esiste); }</style>`,
      body: [
        '<template data-histos="page" data-slug="home" data-title="Home"><!-- nota --><h1>Uno</h1><h1>Due</h1><img src="asset:foto"><img src="asset:remota" alt="Remota" width="1" height="1"><a href="/chi-siamo/"></a><p class="btn--primary scheda">Testo</p><form action="https://example.org/iscrizione" method="post"><button type="submit">Iscriviti</button></form></template>',
        '<template data-histos="page" data-slug="chi-siamo" data-title="Home"><section><p>Senza titolo</p></section><h2>Storia</h2><h4>Oggi</h4></template>',
        '<template data-histos="post" data-slug="articolo" data-title="Articolo" data-published-at="2026-10-20T08:30:00Z"><p>Testo</p></template>',
      ].join("\n"),
    });
    const acss = prototypeHtml({
      manifest: { framework: "acss" },
      head: '<style data-histos="selectors">.hero { padding: var(--space-m); }</style>',
      body: '<template data-histos="page" data-slug="home" data-title="Home"><h1 class="hero text--l">Home</h1></template>',
    });
    // Seven loops one inside the other (the build stops past six), a global sheet whose `(` never closes (past
    // 100.000 parts: kept as written, unparsed), a source map that ends the selector styles.
    const limits = prototypeHtml({
      head: `<style data-histos="global" data-name="Base">.a { b: (${" x".repeat(100_001)} }</style>\n<style data-histos="selectors">.scheda { color: var(--xb-primary); }\n/*# sourceMappingURL=data:application/json;base64,e30= */\n</style>`,
      body: `<template data-histos="page" data-slug="home" data-title="Home"><h1 class="scheda">Home</h1>${"{#loop [1] as a}".repeat(7)}x${"{/loop}".repeat(7)}</template>`,
    });
    const scratchRoot = await scratch("histos-docs-publish-");
    const leak = prototypeHtml({ body: '<template data-histos="page" data-slug="home" data-title="Home">\n<h1>Home</h1>\n<p>I file sono in /home/deploy/sito.</p></template>' });
    const warnings = [
      ...(await importPrototype(none, { remotePlaceholders: true })).report.warnings,
      ...(await importPrototype(acss)).report.warnings,
      ...(await importPrototype(limits)).report.warnings,
      ...(await checkPrototypeBuild(leak, { scratchRoot })).report.warnings,
    ];
    // The accessibility checks by themselves on a bare section, as the import runs them.
    warnings.push(...prototypeQualityWarnings({ locale: "it-IT", documents: [{ kind: "page", attributes: { "data-slug": "x", "data-title": "X" }, source: "<h1>X</h1><section><p>Senza titolo</p></section>" }] }));
    const docs = { controllo: agentDoc("controllo"), hp_manual: PROTOTYPE_AI_MANUAL };
    const matched = new Set<string>();
    for (const warning of warnings) {
      const entry = phrases.find(([pattern]) => pattern.test(warning));
      expect(entry, `un avviso che la documentazione non nomina: ${warning}`).toBeDefined();
      matched.add(entry![1]);
      for (const [where, text] of Object.entries(docs)) expect(text.toLowerCase(), `${where}: ${entry![1]}`).toContain(entry![1].toLowerCase());
    }
    // Every phrase but two stands for a warning these runs give: the unreadable CSS needs a broken sheet, and the
    // section without a heading is a check of its own that the docs announce with the others.
    const unmatched = phrases.map(([, phrase]) => phrase).filter((phrase) => !matched.has(phrase));
    expect(unmatched.filter((phrase) => !["CSS che l'import non legge come il browser", "`section` senza titolo"].includes(phrase))).toEqual([]);
    for (const [, phrase] of phrases) for (const [where, text] of Object.entries(docs)) expect(text.toLowerCase(), `${where}: ${phrase}`).toContain(phrase.toLowerCase());
    // accessibilita lists the accessibility and SEO ones too.
    for (const phrase of ["immagini senza `alt`", "link senza testo né `aria-label`", "`section` senza titolo", "titoli che saltano un livello", "senza `h1`", "più di un `h1`", "pagine con lo stesso titolo", "articoli senza riassunto", "`locale`"]) {
      expect(agentDoc("accessibilita").toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  }, BUILDS);
});

/**
 * The facts reviews 5 to 9 changed: main() in archive templates, empty archives, the meta description, the outcomes of
 * the check with its build, the checks of props, loop arguments and content values, preview scripts left open. Each is
 * read from the docs as an agent reads it and tried against the code that decides it: the import and its check, the
 * check with the build, the static build.
 */

/**
 * A prototype's site, imported into a catalog of its own and built by the static build: its pages by address. The
 * catalog is the one the server's build is written against (the package's), as the app's.
 */
async function builtSite(html: string): Promise<(address: string) => Promise<string | null>> {
  const root = await scratch("histos-docs-build-");
  const catalog = new BuiltCatalog(path.join(root, "catalog"));
  await catalog.initialize();
  const scratchCatalog = new CmsProjectCatalog(path.join(root, "scratch"));
  await scratchCatalog.initialize();
  const built = await buildPrototypeProfile(parsePrototype(html), scratchCatalog);
  const opened = await catalog.importStaticPageProfile(built.profile, built.files);
  try {
    const context: CmsOperationsContext = { catalog, dataDirectory: root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined };
    const out = path.join(root, "out");
    const result = await buildCmsProject(context, opened, { throwaway: { directory: out } });
    expect(result.status).toBe("ready");
    const folder = path.join(out, String(result.id));
    return (address) => readFile(path.join(folder, ...address.split("/").filter(Boolean), "index.html"), "utf8").catch(() => null);
  } finally {
    opened.store.close();
  }
}

const homePage = (inside = "", status = "published") => `<template data-histos="page" data-slug="home" data-title="Home" data-status="${status}">\n<h1>Home</h1>\n${inside}</template>`;
const contentScript = (content: unknown) => `<script type="application/json" data-histos="content">${JSON.stringify(content)}</script>`;
/** A type with one published record and a query of it, for the loops. */
const OPERE = {
  types: [{ key: "opera", label: "Opere", fields: [] }],
  records: [{ type: "opera", slug: "ehi", title: "Ehi", status: "published", publishedAt: "2026-10-02T09:00:00Z" }],
  queries: [{ key: "opere_recenti", label: "Opere recenti", type: "opera", limit: 6, orderBy: "publishedAt", order: "desc" }],
};

describe("documentazione dei prototipi: i fatti delle revisioni 5–9", () => {
  it("il template di categoria dell'esempio elenca con main() gli articoli del termine, 10 per pagina; un termine vuoto ha la sua pagina con il ramo else; il riassunto è la descrizione", async () => {
    // The same example in dati and in the manual.
    // The manual's kit (a whole prototype) has a main() loop too: the example is the template on its own.
    const examples = [agentDoc("dati"), PROTOTYPE_AI_MANUAL].map((text) => fenced(text, "html").find((block) => block.includes("{#loop main() as") && !block.includes("data-histos-prototype")));
    expect(examples[0], "manca in dati l'esempio di template d'archivio con main()").toBeDefined();
    expect(examples[1]).toBe(examples[0]);
    const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T08:30:00Z`;
    const post = (slug: string, n: number, term: string) => `<template data-histos="post" data-slug="${slug}" data-title="Articolo ${n}" data-published-at="${day(n)}" data-excerpt="Riassunto ${n}." data-terms='{"category":["${term}"]}'><p>Testo</p></template>`;
    const html = prototypeHtml({
      head: contentScript({ taxonomies: [{ key: "category", label: "Categorie", types: ["post"] }], terms: ["racconti", "notizie", "vuota"].map((slug) => ({ taxonomy: "category", slug, label: slug })) }),
      body: [examples[0], homePage(), ...Array.from({ length: 11 }, (_, index) => post(`racconto-${index + 1}`, index + 1, "racconti")), post("notizia", 20, "notizie")].join("\n"),
    });
    const page = await builtSite(html);
    const titles = (text: string | null) => [...(text ?? "").matchAll(/class="archivio__voce"><a href="[^"]*">([^<]*)<\/a>/gu)].map((match) => match[1]);
    // Only the term's posts, newest first, 10 a page; the next ones on …/page/2/.
    expect(titles(await page("/category/racconti/"))).toEqual(Array.from({ length: 10 }, (_, index) => `Articolo ${11 - index}`));
    expect(titles(await page("/category/racconti/page/2/"))).toEqual(["Articolo 1"]);
    expect(titles(await page("/category/notizie/"))).toEqual(["Articolo 20"]);
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toMatch(/10 per pagina, dal più recente/u);
    // An empty term has its archive, and it shows the example's {:else}.
    expect(await page("/category/vuota/")).toContain('<p class="archivio__vuoto">Nessun articolo in questa categoria.</p>');
    // The excerpt is the post's meta description; a page has none (review 4, D6).
    expect(await page("/blog/notizia/")).toContain('<meta name="description" content="Riassunto 20.">');
    expect(await page("/")).not.toContain('name="description"');
    for (const text of [agentDoc("prototipi"), PROTOTYPE_AI_MANUAL]) {
      expect(lineWith(text, "- **`data-excerpt`:**")).toContain('`<meta name="description">`');
      expect(text).not.toContain("descrizione per i motori di ricerca");
    }
    // main() takes no arguments: the check refuses them where they are written.
    await expect(importPrototype(html.replace("main()", "main(limit: 3)"))).rejects.toThrow(/main\(\) non accetta argomenti/u);
  }, BUILDS);

  it("l'anteprima del controllo ha gli esiti che i documenti dicono, e trova gli errori che vede solo la build", async () => {
    const scratchRoot = await scratch("histos-docs-preview-");
    const both = [agentDoc("prototipi"), PROTOTYPE_AI_MANUAL];
    const refusal = async (html: string) => {
      const error = await checkPrototypeBuild(html, { scratchRoot }).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(PrototypeInvalidError);
      return error as PrototypeInvalidError;
    };
    const reason = (preview: unknown) => (preview as { reason?: string } | undefined)?.reason ?? "";

    // It builds; a public address with /home/ in its path does not stop publishing.
    const builds = await checkPrototypeBuild(prototypeHtml({ body: homePage('<p><a href="https://www.comune.it/home/servizi/">Servizi del comune</a></p>') }), { scratchRoot });
    expect(builds).toMatchObject({ valid: true, preview: { status: "built" } });
    expect(builds.report.warnings.filter((warning) => warning.startsWith("La pubblicazione si fermerebbe"))).toEqual([]);

    // Only drafts: valid, the preview unavailable with the reason the docs quote.
    const drafts = await checkPrototypeBuild(prototypeHtml({ body: homePage("<p>Ciao</p>", "draft") }), { scratchRoot });
    expect(drafts).toMatchObject({ valid: true, preview: { status: "unavailable" } });
    expect(reason(drafts.preview)).toMatch(/^Il progetto non ha pagine incluse nella versione/u);
    for (const text of both) expect(text).toContain("«Il progetto non ha pagine incluse nella versione…»");

    // A server path in a page: valid, the preview unavailable with the docs' reason, the warning first, placed.
    const leak = await checkPrototypeBuild(prototypeHtml({ body: homePage("<p>I file sono in /home/deploy/sito.</p>") }), { scratchRoot });
    expect(leak).toMatchObject({ valid: true, preview: { status: "unavailable" } });
    expect(PROTOTYPE_AI_MANUAL).toContain(`«${reason(leak.preview)}»`);
    expect(agentDoc("prototipi")).toContain(`«${reason(leak.preview).split(":")[0]}…»`);
    const placed = /^La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga \d+ del prototipo\.$/u;
    expect(leak.report.warnings[0]).toMatch(placed);
    for (const text of both) expect(/«(La pubblicazione si fermerebbe: index\.html[^»]+)»/u.exec(text)?.[1]).toMatch(placed);

    // What only the build sees: a date from data in another form, a query argument computed from an expression. The
    // check without the build passes both; with it, the site does not build, each refusal at its document.
    const fromData = prototypeHtml({ body: homePage('<p>{page.title.date("j")}</p>') });
    await expect(importPrototype(fromData)).resolves.toBeDefined();
    const dateRefusal = await refusal(fromData);
    expect(dateRefusal.issues[0]).toMatchObject({ document: "page home", message: expect.stringMatching(/^La versione del sito si ferma: /u) });
    const computed = prototypeHtml({
      head: contentScript(OPERE),
      body: [
        homePage(),
        '<template data-histos="template" data-ref="site/lista" data-title="Lista"><main>\n{#loop opere_recenti(limit: page.title) as o}<p>{o.title}</p>{/loop}{@slot}</main></template>',
        '<template data-histos="page" data-slug="tutte" data-title="Tutte" data-template="site/lista"><p>x</p></template>',
      ].join("\n"),
    });
    await expect(importPrototype(computed)).resolves.toBeDefined();
    expect((await refusal(computed)).message).toMatch(/^template site\/lista, riga \d+: La versione del sito si ferma: \/tutte\/ \(template site\/lista\): /u);
    for (const text of both) expect(text).toContain("`template site/lista, riga 7: La versione del sito si ferma: /tutte/ (template site/lista): …`");

    // Two contents on one address: refused before any build, with the message the docs quote.
    const collision = prototypeHtml({
      head: contentScript({
        types: [{ key: "tag", label: "Tag", fields: [] }],
        taxonomies: [{ key: "post_tag", label: "Tag", types: ["post"] }],
        terms: [{ taxonomy: "post_tag", slug: "news", label: "News" }],
        records: [{ type: "tag", slug: "news", title: "News", status: "published", publishedAt: "2026-10-02T09:00:00Z" }],
      }),
      body: homePage(),
    });
    const quoted = both.map((text) => /«(Due contenuti avrebbero lo stesso indirizzo .+?)…»/u.exec(text)?.[1]);
    expect(quoted[0], "manca il messaggio di due contenuti sullo stesso indirizzo").toBeDefined();
    expect(quoted[1]).toBe(quoted[0]);
    expect((await refusal(collision)).message).toContain(quoted[0]);
    // A type «blog» with a post, a draft too.
    const blog = prototypeHtml({
      head: contentScript({ types: [{ key: "blog", label: "Blog", fields: [] }] }),
      body: `${homePage()}\n<template data-histos="post" data-slug="bozza" data-title="Bozza" data-status="draft"><p>x</p></template>`,
    });
    await expect(importPrototype(blog)).rejects.toThrow(/il tipo «blog» prende l'indirizzo \/blog\//u);
  }, BUILDS);

  it("le props dei componenti: ogni ✅ della tabella di componenti passa il controllo, ogni ❌ no", async () => {
    const rows = agentDoc("componenti").split("\n").filter((line) => /^\| `(?:number|boolean|string|enum)` \|/u.test(line));
    expect(rows.map((row) => ticks(row)[0])).toEqual(["number", "boolean", "string", "enum"]);
    const props = JSON.stringify({ titolo: { type: "string", default: "" }, conta: { type: "number", default: 0 }, vetrina: { type: "boolean", default: false }, variante: { type: "enum", default: "chiara", options: ["chiara", "scura"] } });
    const withProp = (prop: string) => prototypeHtml({ body: `<template data-histos="component" data-ref="scheda" data-title="Scheda" data-props='${props}'><article class="scheda scheda--{props.variante}"><h2>{props.titolo}</h2></article></template>\n${homePage(`<Scheda ${prop} />`)}` });
    for (const row of rows) {
      const [, good, bad] = ticks(row);
      await expect(importPrototype(withProp(good!)), good).resolves.toBeDefined();
      await expect(importPrototype(withProp(bad!)), bad).rejects.toThrow(PrototypeError);
    }
    // A boolean alone is true; a prop the component does not declare is refused.
    await expect(importPrototype(withProp("vetrina"))).resolves.toBeDefined();
    await expect(importPrototype(withProp('colore="rosso"'))).rejects.toThrow(/scheda non ha la prop colore/u);
    expect(PROTOTYPE_AI_MANUAL).toContain("`vetrina={true}` o `vetrina`");
    expect(agentDoc("errori-tipici")).toContain("<CardOpera conta={3} vetrina />");
  }, IMPORTS);

  it("gli argomenti dei loop e i valori dei contenuti sono quelli che il controllo prende", async () => {
    // The loop arguments dati and the manual list: each passes with a value of the docs, another name is refused.
    const names = (text: string) => ticks(lineWith(text, "**Argomenti")).filter((name) => /^[a-z_]+$/u.test(name));
    expect(names(agentDoc("dati"))).toEqual(["limit", "offset", "page", "paged", "posts_per_page", "count", "locale"]);
    expect(names(PROTOTYPE_AI_MANUAL)).toEqual(names(agentDoc("dati")));
    const values: Record<string, string> = { limit: "3", offset: "0", page: "1", paged: "1", posts_per_page: "3", count: "3", locale: '"it-IT"' };
    const looping = (args: string) => prototypeHtml({ head: contentScript(OPERE), body: homePage(`{#loop opere_recenti(${args}) as o}<p>{o.title}</p>{/loop}`) });
    for (const name of names(agentDoc("dati"))) await expect(importPrototype(looping(`${name}: ${values[name]}`)), name).resolves.toBeDefined();
    await expect(importPrototype(looping("limit: -1"))).resolves.toBeDefined();
    await expect(importPrototype(looping("colore: 1"))).rejects.toThrow(/colore non è un argomento delle query/u);
    await expect(importPrototype(looping("limit: 500"))).rejects.toThrow(/limit è un numero intero da 1 a 100/u);

    // Content values: a number as text is refused with the fix, unless it is the default; null is absent; order is
    // lowercase; a term is not repeated in a record; a type's template null means none; a slug is written as it is.
    const withQuery = (query: Record<string, unknown>) => prototypeHtml({ head: contentScript({ ...OPERE, queries: [{ ...OPERE.queries[0], ...query }] }), body: homePage() });
    await expect(importPrototype(withQuery({ limit: "6" }))).rejects.toThrow(/Scrivi il numero senza virgolette/u);
    await expect(importPrototype(withQuery({ limit: "10" }))).resolves.toBeDefined();
    await expect(importPrototype(withQuery({ limit: null, orderBy: null }))).resolves.toBeDefined();
    await expect(importPrototype(withQuery({ order: "DESC" }))).rejects.toThrow(PrototypeError);
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toContain('`"limit": 6`, non `"limit": "6"`');
    const terms = { taxonomies: [{ key: "tema", label: "Temi", types: ["opera"] }], terms: [{ taxonomy: "tema", slug: "notte", label: "Notte" }] };
    const record = (extra: Record<string, unknown>, type: Record<string, unknown> = {}) => prototypeHtml({ head: contentScript({ ...OPERE, ...terms, types: [{ ...OPERE.types[0], ...type }], records: [{ ...OPERE.records[0], ...extra }] }), body: homePage() });
    await expect(importPrototype(record({ terms: { tema: ["notte"] } }))).resolves.toBeDefined();
    await expect(importPrototype(record({ terms: { tema: ["notte", "notte"] } }))).rejects.toThrow(PrototypeError);
    await expect(importPrototype(record({}, { singleTemplate: null, archiveTemplate: "" }))).resolves.toBeDefined();
    await expect(importPrototype(record({ slug: "Mare Aperto" }))).rejects.toThrow(/scrivi "slug": "mare-aperto"/u);

    // A posts query with no orderBy is ordered by `order`, not by date: what dati and the manual tell to write instead.
    const { store } = await contentProject();
    try {
      const saved = store.content.saveQueryPreset({ key: "articoli", label: "Articoli", typeKey: "post", expectedHead: null });
      if (saved.status !== "saved") throw new Error("query non salvata");
      expect(saved.preset.orderBy).toBe("order");
    } finally {
      store.close();
    }
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(lineWith(text, "enza `orderBy`")).toContain('`"orderBy": "publishedAt", "order": "desc"`');
  }, IMPORTS);

  it("uno script di anteprima lasciato aperto ferma l'import con le righe che i documenti mostrano; uno chiuso, con un selettore sui template, no", async () => {
    const swallowed = /<template data-histos="page"> \(riga \d+\) per il browser è testo dentro <script> \(riga \d+\)/u;
    for (const text of [agentDoc("prototipi"), PROTOTYPE_AI_MANUAL]) expect(text).toMatch(swallowed);
    const open = prototypeHtml({ body: `<script>const pagine = document.querySelectorAll("template");\n${homePage()}` });
    await expect(importPrototype(open)).rejects.toThrow(swallowed);
    const closed = prototypeHtml({ body: `<script>const pagine = document.querySelectorAll('template[data-histos="page"]'); const nuova = '<' + 'template data-histos="page">';</script>\n${homePage()}` });
    await expect(importPrototype(closed)).resolves.toBeDefined();
  }, IMPORTS);
});

/**
 * The facts review 10 found wrong or missing: the nesting limits with and without the build, what stops publishing and
 * how often it is said, a project with no published page, archives on their following pages, the fields an archive
 * has, what a record's slot and a rich-text field print, the term template of another taxonomy, hyphenated keys, a
 * loop's {:else}, the issues' places, and the CLI's line for an unavailable preview.
 */
describe("documentazione dei prototipi: i fatti della revisione 10", () => {
  const both = () => [agentDoc("prototipi"), PROTOTYPE_AI_MANUAL];
  const publishWarnings = (warnings: readonly string[]) => warnings.filter((warning) => warning.startsWith("La pubblicazione si fermerebbe"));

  it("oltre i limiti della build il controllo senza anteprima avvisa, quello con l'anteprima rifiuta, con le frasi dei documenti", async () => {
    const nested = prototypeHtml({ body: `<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1>${"{#loop [1] as a}".repeat(7)}x${"{/loop}".repeat(7)}</template>` });
    const warning = (await importPrototype(nested)).report.warnings.find((item) => item.startsWith("Build del sito: "));
    expect(warning).toMatch(/^Build del sito: page home, riga \d+: .*7 \{#loop\} stanno uno dentro l'altro: la build del sito si ferma oltre 6\.$/u);
    const refused = await checkPrototypeBuild(nested, { scratchRoot: await scratch("histos-docs-nested-") }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(PrototypeInvalidError);
    expect((refused as PrototypeInvalidError).message).toMatch(/^page home, riga \d+: La versione del sito si ferma: \/: I loop annidati superano il limite di 6\.$/u);
    for (const text of [agentDoc("sintassi"), PROTOTYPE_AI_MANUAL]) {
      expect(text).toContain("7 {#loop} stanno uno dentro l'altro: la build del sito si ferma oltre 6.»");
      expect(text).toContain(": La versione del sito si ferma: /: I loop annidati superano il limite di 6.»");
    }
    expect(agentDoc("controllo")).toContain("Con `preview: true` lo stesso problema è un rifiuto");
    // The CLI prints an unavailable preview with the same prefix: the docs tell the two apart.
    expect(prototypePreviewText({ status: "unavailable", reason: "Il progetto non ha pagine incluse nella versione." })).toBe("Build del sito: Il progetto non ha pagine incluse nella versione.");
    for (const text of [agentDoc("prototipi"), agentDoc("controllo"), PROTOTYPE_AI_MANUAL]) expect(text).toContain("«Build del sito: Il progetto non ha pagine incluse nella versione…»");
  }, BUILDS);

  it("senza pagine pubblicate non c'è anteprima né controllo della pubblicazione; con una pagina pubblicata ogni file dà un avviso per regola", async () => {
    const scratchRoot = await scratch("histos-docs-publish10-");
    const post = (text: string) => `<template data-histos="post" data-slug="primo" data-title="Primo" data-published-at="2026-10-20T08:30:00Z" data-excerpt="Primo."><p>${text}</p></template>`;
    // A draft home and a published post: no preview, whatever the post holds.
    const drafts = await checkPrototypeBuild(prototypeHtml({ body: `${homePage("", "draft")}\n${post("I file sono in /var/www/sito.")}` }), { scratchRoot });
    expect(drafts).toMatchObject({ valid: true, preview: { status: "unavailable" } });
    expect((drafts.preview as { reason: string }).reason).toMatch(/^Il progetto non ha pagine incluse nella versione/u);
    expect(publishWarnings(drafts.report.warnings)).toEqual([]);
    for (const text of both()) expect(lineWith(text, "- **`data-status`:**")).toContain("senza nessuna pagina pubblicata");
    // A published home: the same post stops publishing.
    const published = await checkPrototypeBuild(prototypeHtml({ body: `${homePage()}\n${post("I file sono in /var/www/sito.")}` }), { scratchRoot });
    expect(publishWarnings(published.report.warnings)).toHaveLength(1);
    // Three server paths in one file: one warning, at the first.
    const three = await checkPrototypeBuild(prototypeHtml({ body: homePage("<p>/var/www/sito</p><p>C:\\inetpub\\sito</p><p>/home/nome/file</p>") }), { scratchRoot });
    expect(publishWarnings(three.report.warnings)).toHaveLength(1);
    for (const text of both()) expect(text).toContain("al primo punto in cui la trova");
    // The cases beyond the plain folders the docs now name each stop publishing.
    for (const written of ['<a href="https://example.org/?p=/home/nome">Link</a>', "<code>/^\\/home\\/utente$/</code>"]) {
      const result = await checkPrototypeBuild(prototypeHtml({ body: homePage(`<p>${written}</p>`) }), { scratchRoot });
      expect(publishWarnings(result.report.warnings), written).toHaveLength(1);
    }
    for (const text of both()) {
      expect(text).toContain("`https://example.org/?p=/home/nome`");
      expect(text).toContain("`/^\\/home\\/utente$/`");
    }
  }, BUILDS);

  it("negli archivi: le query del tipo scorrono con le pagine, quelle dei termini no; page.url è la pagina mostrata, prevUrl, nextUrl e pageLinks i link fra le pagine (A8); il record e il rich-text", async () => {
    const snippets = [agentDoc("dati"), PROTOTYPE_AI_MANUAL].map((text) => fenced(text, "html").find((block) => block.includes("page.pageLinks") && !block.includes("data-histos-prototype")));
    expect(snippets[0], "manca in dati l'esempio dei link fra le pagine").toBeDefined();
    expect(snippets[1]).toBe(snippets[0]);
    // 25 records: three pages of the type's archive, ten a page.
    const records = Array.from({ length: 25 }, (_, index) => {
      const n = String(index + 1).padStart(2, "0");
      return { type: "opera", slug: `o${n}`, title: `O${n}`, status: "published", publishedAt: `2026-10-${n}T09:00:00Z`, values: index === 0 ? { desc: "<b>ciao</b>" } : {}, terms: { "tipo-evento": ["concerti"] } };
    });
    const html = prototypeHtml({
      head: contentScript({
        types: [{ key: "opera", label: "Opere", singleTemplate: "site/opera", archiveTemplate: "site/opere", fields: [{ key: "desc", label: "Descrizione", type: "rich-text", required: false, public: true, multiple: false }] }],
        taxonomies: [{ key: "tipo-evento", label: "Tipi", types: ["opera"] }],
        terms: [{ taxonomy: "tipo-evento", slug: "concerti", label: "Concerti" }],
        records,
        queries: [{ key: "per_titolo", label: "Per titolo", type: "opera", limit: 3, orderBy: "title", order: "asc" }],
      }),
      body: [
        homePage(),
        '<template data-histos="template" data-ref="site/opera" data-title="Opera"><main><h1>{page.title}</h1><p class="desc">{page.fields.desc}</p><p class="tt">{page.terms["tipo-evento"][0].label}</p><div class="slot">{@slot}</div></main></template>',
        `<template data-histos="template" data-ref="site/opere" data-title="Opere" data-role="archive"><main><h1>{page.title}</h1><p class="u">{page.url}|{page.prevUrl}|{page.nextUrl}</p><ul class="q">{#loop per_titolo() as o}<li>{o.title}</li>{/loop}</ul>${snippets[0]}{@slot}</main></template>`,
      ].join("\n"),
    });
    const page = await builtSite(html);
    const listed = (text: string | null) => [.../<ul class="q">(.*?)<\/ul>/su.exec(text ?? "")?.[1]?.matchAll(/<li>([^<]*)<\/li>/gu) ?? []].map((match) => match[1]);
    const first = await page("/opera/");
    const second = await page("/opera/page/2/");
    const last = await page("/opera/page/3/");
    expect(listed(first)).toEqual(["O01", "O02", "O03"]);
    expect(listed(second)).toEqual(["O04", "O05", "O06"]);
    expect(first).toContain('<p class="u">/opera/||/opera/page/2/</p>');
    expect(second).toContain('<p class="u">/opera/page/2/|/opera/|/opera/page/3/</p>');
    expect(last).toContain('<p class="u">/opera/page/3/|/opera/page/2/|</p>');
    expect(await page("/opera/page/4/")).toBeNull();
    // The docs' navigation: previous and next where they exist, every page, the one shown without a link.
    const nav = (html: string | null) => /<nav class="paginazione"[^>]*>(.*?)<\/nav>/su.exec(html ?? "")?.[1] ?? null;
    const pages = (current: number) => [1, 2, 3].map((n) => n === current ? `<span class="paginazione__pagina" aria-current="page">${n}</span>` : `<a class="paginazione__pagina" href="${n === 1 ? "/opera/" : `/opera/page/${n}/`}">${n}</a>`).join("");
    expect(nav(first)).toBe(`${pages(1)}<a class="paginazione__link" href="/opera/page/2/" rel="next">Pagina seguente</a>`);
    expect(nav(second)).toBe(`<a class="paginazione__link" href="/opera/" rel="prev">Pagina precedente</a>${pages(2)}<a class="paginazione__link" href="/opera/page/3/" rel="next">Pagina seguente</a>`);
    expect(nav(last)).toBe(`<a class="paginazione__link" href="/opera/page/2/" rel="prev">Pagina precedente</a>${pages(3)}`);
    // One page only: no navigation at all.
    expect(nav(await page("/opera/o01/"))).toBeNull();
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toContain("al massimo le prime 100");
    // A link of page.pageLinks is an object: printed whole, the check says what to write.
    const whole = html.replace("{l.number}</span>", "{l}</span>");
    expect(whole).not.toBe(html);
    await expect(importPrototype(whole)).rejects.toThrow("{l}: l è un link di page.pageLinks, un oggetto: scrivi {l.url}, {l.number} o {l.current}");
    // A term of another taxonomy renders with the archive role, and a query there is the same on every page.
    expect(listed(await page("/tipo-evento/concerti/"))).toEqual(["O01", "O02", "O03"]);
    expect(listed(await page("/tipo-evento/concerti/page/2/"))).toEqual(["O01", "O02", "O03"]);
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toContain("una query con `limit` 3 mostra dalla quarta alla sesta");
    // A record: rich-text printed as text, the hyphenated key read in brackets, the slot empty.
    const record = await page("/opera/o01/");
    expect(record).toContain('<p class="desc">&lt;b&gt;ciao&lt;/b&gt;</p>');
    expect(record).toContain('<p class="tt">Concerti</p>');
    expect(record).toContain('<div class="slot"></div>');
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toContain('`page.terms["tipo-evento"]`');
    // The dotted form is a subtraction the check refuses with the docs' words.
    await expect(importPrototype(html.replace('page.terms["tipo-evento"]', "page.terms.tipo-evento"))).rejects.toThrow('Token inatteso "-"');
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toContain("«Token inatteso \"-\"»");
  }, BUILDS);

  it("un archivio senza template dice «Nessun contenuto.» in italiano e «Nothing found.» nelle altre lingue", async () => {
    const empty = (locale: string) => prototypeHtml({ manifest: { locale }, head: contentScript({ types: [{ key: "opera", label: "Opere", fields: [] }] }), body: homePage() });
    expect(await (await builtSite(empty("it-IT")))("/opera/")).toContain("Nessun contenuto.");
    expect(await (await builtSite(empty("en-GB")))("/opera/")).toContain("Nothing found.");
    for (const text of both()) expect(text).toContain("«Nessun contenuto.» su una pagina in italiano e «Nothing found.» in ogni altra lingua");
  }, BUILDS);

  it("un tipo blog accanto a una pagina pubblicata blog si importa; una variabile del loop nel suo {:else} e un selettore ripetuto danno i messaggi dei documenti", async () => {
    const blogType = prototypeHtml({
      head: contentScript({ types: [{ key: "blog", label: "Blog", fields: [] }] }),
      body: `${homePage()}\n<template data-histos="page" data-slug="blog" data-title="Blog"><h1>Blog</h1></template>\n<template data-histos="post" data-slug="primo" data-title="Primo" data-published-at="2026-10-20T08:30:00Z"><p>x</p></template>`,
    });
    await expect(importPrototype(blogType)).resolves.toBeDefined();
    for (const text of both()) expect(text).toContain("e nessuna pagina pubblicata ha lo slug `blog`. Chiamalo per esempio `notizie`");

    // {:else} in a loop (D1): the check says where the loop variable is missing, in the docs' words.
    const elseWithItem = prototypeHtml({ body: homePage("<ul>{#loop [1] as voce}<li>{voce}</li>{:else}<li>{voce}</li>{/loop}</ul>") });
    const elseError = await importPrototype(elseWithItem).then(() => null, (reason: unknown) => reason);
    expect(elseError).toBeInstanceOf(PrototypeError);
    expect((elseError as PrototypeError).issues.map((issue) => issue.message)).toEqual(["{voce}: nel {:else} di un loop voce non c'è: il ramo si mostra quando il loop non ha elementi. Qui ci sono page, this."]);
    for (const text of [agentDoc("sintassi"), agentDoc("errori-tipici"), PROTOTYPE_AI_MANUAL]) expect(text).toContain("«{voce}: nel {:else} di un loop voce non c'è");

    // A repeated selector: an issue with no document and no line, as the docs show it.
    const repeated = prototypeHtml({ head: '<style data-histos="selectors">.hero { color: red; }\n.hero { color: blue; }</style>', body: homePage() });
    const error = await importPrototype(repeated).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrototypeError);
    expect((error as PrototypeError).issues).toEqual([{ message: "Stili per selettore: selettore vuoto, troppo lungo o ripetuto (.hero)." }]);
    for (const text of [agentDoc("prototipi"), agentDoc("errori-tipici")]) expect(text).toContain("Stili per selettore: selettore vuoto, troppo lungo o ripetuto (.hero).");
    expect(agentDoc("prototipi")).toContain("`{document?, line?, column?, message}`");
  }, IMPORTS);

  it("il componente con i livelli dei titoli di componenti passa il controllo dei titoli; gli argomenti e i caratteri del design hanno i limiti detti", async () => {
    const component = fenced(agentDoc("componenti"), "html").find((block) => block.includes('data-ref="ui/scheda"'));
    expect(component, "manca in componenti l'esempio dei livelli dei titoli").toBeDefined();
    const page = (definition: string) => prototypeHtml({ body: `${definition}\n${homePage('<Ui.Scheda titolo="Uno" /><section aria-label="Altre"><h2>Due</h2><Ui.Scheda titolo="Tre" livello="h3" /></section>')}` });
    const headings = async (html: string) => (await importPrototype(html)).report.warnings.filter((warning) => warning.includes("titoli saltano"));
    expect(await headings(page(component!))).toEqual([]);
    // With the other level first the heading check reads h3 under the h1: why the docs put the default first.
    const swapped = component!.replace('{#if props.livello == "h2"}<h2 class="scheda__titolo">{props.titolo}</h2>{:else}<h3 class="scheda__titolo">{props.titolo}</h3>{/if}', '{#if props.livello == "h3"}<h3 class="scheda__titolo">{props.titolo}</h3>{:else}<h2 class="scheda__titolo">{props.titolo}</h2>{/if}');
    expect(swapped).not.toBe(component);
    expect(await headings(page(swapped))).toHaveLength(1);

    const looping = (args: string) => prototypeHtml({ head: contentScript(OPERE), body: homePage(`{#loop opere_recenti(${args}) as o}<p>{o.title}</p>{/loop}`) });
    await expect(importPrototype(looping("posts_per_page: 500"))).rejects.toThrow(/posts_per_page è un numero intero da 1 a 100/u);
    await expect(importPrototype(looping("count: 0"))).rejects.toThrow(/count è un numero intero da 1 a 100/u);
    await expect(importPrototype(looping("paged: 0"))).rejects.toThrow(/paged è un numero intero da 1 in su/u);
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(lineWith(text, "**Argomenti")).toContain("`page` e `paged` (da 1 in su)");
    // An order equal to the default passes: the docs no longer promise a refusal.
    const withQuery = (query: Record<string, unknown>) => prototypeHtml({ head: contentScript({ ...OPERE, queries: [{ ...OPERE.queries[0], ...query }] }), body: homePage() });
    await expect(importPrototype(withQuery({ order: "ASC" }))).resolves.toBeDefined();

    const stack = /`("Playfair Display", Georgia, serif)`/u;
    for (const text of [agentDoc("histos-css"), PROTOTYPE_AI_MANUAL]) {
      const written = stack.exec(text)?.[1];
      expect(written, "manca la pila di caratteri d'esempio").toBeDefined();
      expect(validateHistosDesign({ font_heading: written }).font_heading).toBe(written);
    }
  }, IMPORTS);

  it("date e datetime si ordinano come testo: lo stesso istante con un altro fuso cambia l'ordine", async () => {
    const { store } = await contentProject();
    try {
      for (const [slug, ora] of [["sera", "2026-11-07T18:30:00+01:00"], ["pomeriggio", "2026-11-07T17:45:00Z"]] as const) {
        expect(store.content.saveRecord({ typeKey: "evento", slug, title: slug, status: "published", publishedAt: "2026-10-02T09:00:00Z", values: { ora }, expectedHead: null }).status).toBe("saved");
      }
      expect(store.content.saveQueryPreset({ key: "per_ora", label: "Per ora", typeKey: "evento", orderBy: "ora", order: "asc", expectedHead: null }).status).toBe("saved");
      // 18:30+01:00 is 17:30 UTC, before 17:45 UTC; as text it comes after.
      expect(store.content.resolveQueryPreset("per_ora").map((record) => record.slug).filter((slug) => slug !== "concerto")).toEqual(["pomeriggio", "sera"]);
    } finally {
      store.close();
    }
    for (const text of [agentDoc("dati"), PROTOTYPE_AI_MANUAL]) expect(text).toContain("scrivi ogni valore dello stesso campo con lo stesso fuso");
  }, IMPORTS);
});
