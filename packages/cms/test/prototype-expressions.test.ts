import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseDsl, serializeXb } from "../.generated/histos-dsl/index.js";
import { TRANSFER_MODIFIERS } from "../src/page-transfer.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError } from "../src/prototype-import.js";
import { CMS_DATE_FORMAT_LETTERS, CMS_RUNTIME_CAPABILITIES, renderCmsPage } from "../src/static-renderer.js";

/**
 * The expressions of a prototype read before the build (A7 hunt, review 5): every one the transfer or the static build
 * would refuse is said with its document, line and column, and nothing the build renders is refused. The build is
 * checked end to end: the profile the check exports is imported as the app imports it and each page is rendered by the
 * static renderer, as the build renders it.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-expressions-"));
  roots.push(root);
  return root;
}

const fixture = () => readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
const lineOf = (html: string, marker: string) => html.split("\n").findIndex((line) => line.includes(marker)) + 1;
const columnOf = (html: string, marker: string) => html.split("\n")[lineOf(html, marker) - 1]!.indexOf(marker) + 1;
const at = (html: string, marker: string) => ({ line: lineOf(html, marker), column: columnOf(html, marker) });
/** The fixture with the draft page contatti published and written as `body`. */
const contatti = async (body: string) => {
  const html = (await fixture()).replace("<p>Scrivimi.</p>", body).replace(' data-status="draft"', "");
  expect(html).toContain(body);
  return html;
};

async function refusal(html: string): Promise<PrototypeError> {
  const error = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(await temporary())).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PrototypeError);
  return error as PrototypeError;
}

/**
 * The static build of a prototype that passed the check: its profile imported as the app imports it, then every page
 * and article rendered as the build renders it (cms-api.ts, renderCmsDocumentPage). Each page's HTML, or the error that
 * stopped it, by slug.
 */
async function staticBuild(html: string): Promise<Map<string, string | Error>> {
  const built = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(await temporary()));
  const { project, store } = await new CmsProjectCatalog(await temporary()).importStaticPageProfile(built.profile, built.files);
  const pages = new Map<string, string | Error>();
  try {
    for (const document of [...store.listPages(), ...store.listPosts()]) {
      const content = store.getHead(document.id)?.content ?? "";
      const templateRef = document.templateRef ?? store.listTemplates().find((template) => template.role === (document.documentType === "post" ? "single" : "page"))?.ref;
      const page = { id: document.id, title: document.title, slug: document.slug, url: document.slug === "home" ? "/" : `/${document.slug}/` };
      pages.set(document.slug, await renderCmsPage({ store, projectId: project.id, content, ...store.getRenderSettings(), ...(templateRef ? { templateRef } : {}), page }).then((rendered) => rendered.html, (error: unknown) => error as Error));
    }
  } finally {
    store.close();
  }
  return pages;
}

describe("le espressioni si leggono prima della build, ognuna al suo posto", () => {
  it("un modificatore che Histeon non ha, con la riga e la colonna e quello che probabilmente si voleva", async () => {
    // The transfer said only «Il modifier dell'espressione non è disponibile in Histeon CMS: page contatti.», no line.
    const html = await contatti("<p>{page.title.uppercase()}</p>");
    expect((await refusal(html)).issues).toEqual([{ document: "page contatti", ...at(html, "uppercase"), message: expect.stringMatching(/^il modificatore uppercase\(\) non esiste in Histeon \(forse upper\): la build del sito si ferma\. I modificatori sono upper, lower, /u) }]);
    // In an attribute, a prop, a condition and a loop's argument too, each at its own place.
    const many = (await fixture())
      .replace('<CardOpera titolo="Ehi" url="/opera/ehi/">', '<CardOpera titolo={page.title.toUpper()} url="/opera/ehi/">')
      .replace("<p>Scrivimi.</p>", '<p class="{page.slug.kebab()}">{#if page.title.blank()}x{/if}</p>')
      .replace('{#loop opere_notte() as opera}', '{#loop opere_notte(limit: page.title.count()) as opera}');
    const issues = (await refusal(many)).issues;
    expect(issues.map((issue) => [issue.line, issue.column, issue.message.replace(/ non esiste[\s\S]*/u, "")])).toEqual([
      [lineOf(many, "toUpper"), columnOf(many, "toUpper"), "il modificatore toUpper()"],
      [lineOf(many, "count()"), columnOf(many, "count()"), "il modificatore count()"],
      [lineOf(many, "kebab"), columnOf(many, "kebab"), "il modificatore kebab()"],
      [lineOf(many, "blank"), columnOf(many, "blank"), "il modificatore blank()"],
    ]);
  });

  it("date(): una lettera che il formato non conosce, con il modo di scriverla com'è", async () => {
    // The check said «Prototipo valido» and the build stopped at «Il token data q non è supportato dal runtime CMS M2».
    const html = await contatti('<p>{"2026-11-07T10:00:00Z".date("j q F")}</p>');
    expect((await refusal(html)).issues).toEqual([{ document: "page contatti", ...at(html, '"j q F"'), message: 'date("j q F"): q non è una lettera del formato delle date (d D j l N S w z W F m M n t L o Y y a A B g G h H i s u v e I O P T Z c r U), e la build del sito si ferma. Per scrivere una lettera com\'è mettile davanti due barre: \\\\q.' }]);
  });

  it("date(): una \\ prima di una lettera che la stringa perde si dice, con la barra raddoppiata; quella raddoppiata stampa la lettera nella build", async () => {
    // The DSL string lexer reads `\d` as `d` (expr.ts: a backslash before a character other than n, t, r gives that
    // character), so date() gets "j di F": the day and the minutes, «7 0700 novembre», where «7 di novembre» was meant.
    const eaten = await contatti('<p>{"2026-11-07T10:00:00Z".date("j \\d\\i F")}</p>');
    expect((await refusal(eaten)).issues).toEqual([{ document: "page contatti", ...at(eaten, '"j \\d\\i F"'), message: 'date("j \\d\\i F"): in una stringa di un\'espressione una sola \\ prima di una lettera si perde: \\d diventa d, cioè il giorno a due cifre; \\i diventa i, cioè i minuti. Per scrivere la lettera com\'è raddoppia la barra: date("j \\\\d\\\\i F").' }]);
    const doubled = await contatti('<p>{"2026-11-07T10:00:00Z".date("j \\\\d\\\\i F")}</p>');
    expect((await staticBuild(doubled)).get("contatti")).toMatch(/<p>7 di novembre<\/p>/u);
    // What the eaten one renders, past the check: the store keeps it, the renderer prints the day and the minutes.
    const { project, store } = await new CmsProjectCatalog(await temporary()).createProject("Data");
    try {
      const content = serializeXb(parseDsl('<p>{"2026-11-07T10:00:00Z".date("j \\d\\i F")}</p>').blocks);
      const rendered = await renderCmsPage({ store, projectId: project.id, content, locale: "it-IT", timeZone: "Europe/Rome", page: { id: "00000000-0000-4000-8000-000000000001", title: "Data", slug: "data", url: "/data/" } });
      expect(rendered.html).toContain("<p>7 0700 novembre</p>");
    } finally {
      store.close();
    }
    // \n, \t and \r become a control character, not the letter; a letter the format does not know stops the build.
    const control = await contatti('<p>{"2026-11-07T10:00:00Z".date("\\n\\q j")}</p>');
    expect((await refusal(control)).issues).toEqual([{ document: "page contatti", ...at(control, '"\\n\\q j"'), message: expect.stringMatching(/^date\("\\n\\q j"\): .*\\n diventa un a capo; \\q diventa q, che non è una lettera del formato e ferma la build\. Per scrivere la lettera com'è raddoppia la barra: date\("\\\\n\\\\q j"\)\.$/u) }]);
    // An escape that date() itself reads, from a doubled backslash, is no problem: "\\\d" gives `\d`, the letter d.
    expect((await staticBuild(await contatti('<p>{"2026-11-07T10:00:00Z".date("j \\\\\\d")}</p>'))).get("contatti")).toMatch(/<p>7 d<\/p>/u);
  });

  it("date() di una data scritta che non è ISO, e number() con più di 100 decimali", async () => {
    const html = await contatti('<p>{"7 novembre".date("j")} {3.number(101)}</p>');
    expect((await refusal(html)).issues).toEqual([
      { document: "page contatti", ...at(html, '"7 novembre"'), message: expect.stringMatching(/^"7 novembre"\.date\(\): date\(\) legge una data ISO/u) },
      { document: "page contatti", ...at(html, "101"), message: "number(101): al massimo 100 decimali, oltre la build del sito si ferma." },
    ]);
  });

  it("un dato che il documento non ha si dice al suo posto, non come un messaggio del trasferimento senza riga", async () => {
    const html = (await fixture()).replace("<h3>{props.titolo}</h3>", "<h3>{props.titolo} {opera.title}</h3>");
    expect((await refusal(html)).issues).toEqual([{ document: "component card-opera", ...at(html, "opera.title}"), message: expect.stringMatching(/^\{props\.titolo\}|^\{opera\.title\}: opera non è un dato di questo documento, e il trasferimento lo rifiuta\. Qui ci sono page, this, props, slots\.$/u) }]);
    // Inside a loop its variable is one; past the loop it is not.
    const page = await contatti("{#loop opere_recenti() as opera}<p>{opera.title}</p>{/loop}<p>{opera.slug}</p>");
    expect((await refusal(page)).issues).toEqual([{ document: "page contatti", ...at(page, "opera.slug"), message: "{opera.slug}: opera non è un dato di questo documento, e il trasferimento lo rifiuta. Qui ci sono page, this (props e slots solo in componenti, parti e template)." }]);
  });

  it("una graffa da sola nel testo, in un attributo o nel testo di una prop", async () => {
    const html = (await fixture())
      .replace("<p>Scrivimi.</p>", '<p title="a } b">Scrivimi :}</p>')
      .replace(' data-status="draft"', "")
      .replace('<CardOpera titolo="Ehi" url="/opera/ehi/">', '<CardOpera titolo="Ehi {page.title} }" url="/opera/ehi/">');
    const columns = html.split("\n");
    const issues = (await refusal(html)).issues;
    expect(issues.map((issue) => [issue.document, issue.line, issue.column])).toEqual([
      ["page home", lineOf(html, "{page.title} }"), columns[lineOf(html, "{page.title} }") - 1]!.indexOf("{page.title} }") + 14],
      ["page contatti", lineOf(html, 'title="a } b"'), columns[lineOf(html, 'title="a } b"') - 1]!.indexOf("a } b") + 3],
      ["page contatti", lineOf(html, "Scrivimi :}"), columns[lineOf(html, "Scrivimi :}") - 1]!.indexOf(":}") + 2],
    ]);
    expect(issues.every((issue) => issue.message.startsWith("una } da sola"))).toBe(true);
  });

  it("un oggetto scritto nel testo: la pagina, un record, un campo relation, uno slot", async () => {
    const html = (await fixture())
      .replace("<p>Scrivimi.</p>", "<p>{page}</p>{#loop opere_recenti() as opera}<p>{opera} {opera.fields.serie} {opera.fields.serie.title}</p>{/loop}")
      .replace(' data-status="draft"', "")
      .replace("<h3>{props.titolo}</h3>", "<h3>{props.titolo}</h3><p>{slots.media}</p>")
      .replace('"targetType": "serie", "required": false, "public": true', '"targetType": "serie", "required": false, "public": true');
    const issues = (await refusal(html)).issues;
    expect(issues.map((issue) => [issue.document, issue.message.slice(0, 60)])).toEqual([
      ["component card-opera", "{slots.media}: slots.media dice solo se lo slot media è vuot"],
      ["page contatti", "{page}: page è la pagina, un oggetto: scrivi un suo dato, pe"],
      ["page contatti", "{opera}: opera è un record del loop, un oggetto: scrivi un s"],
      ["page contatti", "{opera.fields.serie}: opera.fields.serie è il record collega"],
    ]);
    // As the whole value of an attribute, and in a prop's text, an object is written as nothing: no problem.
    const quiet = await staticBuild(await contatti('<p title={page}>x</p><CardOpera titolo="Pagina {page}" url="/" />'));
    expect(quiet.get("contatti")).toMatch(/<p title="">x<\/p><article class="opera"><a href="\/"><h3>Pagina <\/h3><\/a><\/article>/u);
    // Passed whole to a prop that is no object, it is one: the build stops on it.
    const whole = await contatti('<CardOpera titolo="{page}" url="/" />');
    expect((await refusal(whole)).issues).toEqual([{ document: "page contatti", ...at(whole, 'page}" url'), message: "la prop titolo di card-opera è di tipo string, e {page} è un oggetto: la build del sito si ferma. Passa un suo dato, per esempio {page.title}." }]);
  });

  it("un loop a gruppi sul risultato di una query passa il controllo e la build; il gruppo e i suoi record sono quel che sono (voce 187)", async () => {
    const grouped = '{#loop opere_recenti().groupBy("title", "letter") as lettera}<h2>{lettera.key}</h2>{#loop lettera.items as opera}<p>«{opera.title}»</p>{/loop}{/loop}';
    const built = await staticBuild(await contatti(grouped));
    const page = built.get("contatti");
    expect(page).not.toBeInstanceOf(Error);
    expect(page).toMatch(/<h2>[A-Z#]<\/h2>(<p>«[^»]+»<\/p>)+/u);
    // The group and its records are objects: written whole in the text, the check says what to write.
    const issues = (await refusal(await contatti('{#loop opere_recenti().groupBy("title", "letter") as lettera}<p>{lettera}</p>{#loop lettera.items as opera}<p>{opera}</p>{/loop}{/loop}'))).issues;
    expect(issues.map((issue) => [issue.document, issue.message.slice(0, 60)])).toEqual([
      ["page contatti", "{lettera}: lettera è un gruppo del loop, un oggetto: scrivi "],
      ["page contatti", "{opera}: opera è un record del loop, un oggetto: scrivi un s"],
    ]);
    // Another chain after the query is a syntax error of the document.
    await expect(buildPrototypeProfile(parsePrototype(await contatti("{#loop opere_recenti().slice(0, 2) as opera}<p>{opera.title}</p>{/loop}")), new CmsProjectCatalog(await temporary()))).rejects.toThrow(/intera sorgente del loop/u);
  });

  it("le props e gli slot di un componente come li dichiara: una prop che non ha, un valore del tipo sbagliato, uno slot che non c'è", async () => {
    const html = (await fixture()).replace('<CardOpera titolo="Ehi" url="/opera/ehi/">{#slot media}', '<CardOpera titolo={5} colore="rosso" url="/opera/ehi/">{#slot altro}');
    expect((await refusal(html)).issues).toEqual([
      { document: "page home", ...at(html, "titolo={5}"), message: '<CardOpera titolo=…>: la prop titolo di card-opera è di tipo string: 5 fra graffe non è un testo, e la build del sito si ferma. Scrivi titolo="5".' },
      { document: "page home", ...at(html, 'colore="rosso"'), message: "<CardOpera colore=…>: card-opera non ha la prop colore (ha titolo, immagine, url): la build del sito e l'esportazione si fermano. Dichiarala nel data-props di card-opera, o toglila." },
      { document: "page home", ...at(html, "{#slot altro}"), message: "<CardOpera> riempie {#slot altro}, ma card-opera non ha {@slot altro} (i suoi slot: {@slot media}): la build del sito si ferma. Usa uno dei suoi slot, o aggiungi {@slot altro} a card-opera." },
    ]);
    // A number written as text, true written as text, a value an enum does not have.
    const typed = (await fixture())
      .replace(`data-props='{"titolo":{"type":"string","default":""}`, `data-props='{"conta":{"type":"number"},"vetrina":{"type":"boolean"},"tono":{"type":"enum","options":["chiaro","scuro"]},"titolo":{"type":"string","default":""}`)
      .replace('<CardOpera titolo="Ehi" url="/opera/ehi/">', '<CardOpera titolo="Ehi" conta="3" vetrina="true" tono="grigio" url="/opera/ehi/">');
    expect((await refusal(typed)).issues.map((issue) => issue.message)).toEqual([
      "<CardOpera conta=…>: la prop conta di card-opera è di tipo number, e fra virgolette è un testo: la build del sito si ferma. Scrivi conta={3}.",
      "<CardOpera vetrina=…>: la prop vetrina di card-opera è di tipo boolean, e fra virgolette è un testo: la build del sito si ferma. Scrivi vetrina={true} o solo vetrina.",
      "<CardOpera tono=…>: la prop tono di card-opera è di tipo enum e vale uno fra chiaro, scuro: con «grigio» la build del sito si ferma.",
    ]);
    // Written as the component declares them, the same props render.
    const pages = await staticBuild(typed.replace('conta="3" vetrina="true" tono="grigio"', 'conta={3} vetrina tono="scuro"'));
    expect(pages.get("home")).toMatch(/<h3>Ehi<\/h3>/u);
  });

  it("lo slot di un componente letto dopo chi lo chiama si controlla quando lo si legge, con il posto della chiamata", async () => {
    // The home is read first, before any component: its call is checked once card-opera is read.
    const html = (await fixture()).replace("{@slot media}", "{@slot immagine}");
    expect((await refusal(html)).issues).toEqual([{ document: "page home", ...at(html, "{#slot media}"), message: expect.stringMatching(/^<CardOpera> riempie \{#slot media\}, ma card-opera non ha \{@slot media\} \(i suoi slot: \{@slot immagine\}\)/u) }]);
    // A component calling one declared after it, with content where it has no {@slot}.
    const later = (await fixture()).replace("</body>", '<template data-histos="component" data-ref="cornice"><div><Badge>testo</Badge></div></template>\n<template data-histos="component" data-ref="badge"><span>!</span></template>\n</body>');
    expect((await refusal(later)).issues).toEqual([{ document: "component cornice", ...at(later, "<Badge>"), message: expect.stringMatching(/^<Badge> ha del contenuto fra i suoi tag, ma badge non ha \{@slot\} dove metterlo \(non ha slot\)/u) }]);
  });

  it("gli argomenti di una query in un loop: quelli che prende, con valori che la build legge", async () => {
    const html = (await fixture()).replace("{#loop opere_notte() as opera}", '{#loop opere_notte(limite: 3, limit: 500, offset: "x", locale: 5) as opera}');
    expect((await refusal(html)).issues.map((issue) => [issue.column, issue.message.replace(/;[\s\S]*/u, "")])).toEqual([
      [columnOf(html, "limite"), "{#loop opere_notte(…)}: limite non è un argomento delle query"],
      [columnOf(html, "500"), "{#loop opere_notte(…)}: limit è un numero intero da 1 a 100 (-1 per il massimo)"],
      [columnOf(html, '"x"'), "{#loop opere_notte(…)}: offset è un numero intero da 0 a 1.000.000"],
      [columnOf(html, "5)"), '{#loop opere_notte(…)}: locale è il tag di una lingua fra virgolette, per esempio locale: "en-GB"'],
    ]);
    // limit: -1 is the most a query shows; a page from 1 up; numbers as text the store reads.
    expect(await staticBuild(html.replace('limite: 3, limit: 500, offset: "x", locale: 5', 'limit: -1, page: "2"'))).toBeDefined();
  });
});

describe("i limiti del renderer si contano prima della build, con template e componenti", () => {
  /** contatti without its template: its blocks render from the top, as the build renders a page with none. */
  const alone = async (body: string) => {
    const html = (await contatti(body)).replace('data-slug="contatti" data-title="Contatti" data-template="site/page"', 'data-slug="contatti" data-title="Contatti"');
    expect(html).toContain('data-title="Contatti">');
    return html;
  };
  const nested = (levels: number) => `${"<div>".repeat(levels)}x${"</div>".repeat(levels)}`;
  /** The warnings of the check about the static build: a page past a limit is said there, the project is still made. */
  const buildWarnings = async (html: string) => (await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(await temporary()))).report.warnings.filter((warning) => warning.startsWith("Build del sito: "));

  it("un blocco oltre 64 livelli: la pagina, il suo template e i componenti contano insieme", async () => {
    // 64 elements, their text at the 65th level from the top (level 64 counting from 0): the most the renderer takes.
    expect((await staticBuild(await alone(nested(64)))).get("contatti")).toMatch(/x<\/div>/u);
    expect(await buildWarnings(await alone(nested(64)))).toEqual([]);
    const deep = await alone(nested(65));
    expect(await buildWarnings(deep)).toEqual([`Build del sito: page contatti, riga ${lineOf(deep, 'data-slug="contatti"')}: con i componenti e le parti che chiama, un blocco arriva a 65 livelli uno dentro l'altro: la build del sito si ferma oltre 64. Togli i livelli che non servono (un div che contiene solo un altro div, un componente che ne avvolge un altro).`]);
    // And so it does: the page past the limit stops the renderer.
    expect((await staticBuild(deep)).get("contatti")).toHaveProperty("message", "I componenti e i blocchi superano la profondità massima di 64.");
    // In its template the page's blocks start three levels down: <main>, then {@slot}, then them.
    expect(await buildWarnings(await contatti(nested(62)))).toEqual([expect.stringMatching(/^Build del sito: page contatti, riga \d+: nel template site\/page, con i componenti e le parti che chiama, un blocco arriva a 65 livelli/u)]);
    expect((await staticBuild(await contatti(nested(62)))).get("contatti")).toBeInstanceOf(Error);
    expect((await staticBuild(await contatti(nested(61)))).get("contatti")).toMatch(/x<\/div>/u);
    expect(await buildWarnings(await contatti(nested(61)))).toEqual([]);
  });

  it("più di sei loop uno dentro l'altro, e più di sedici componenti uno dentro l'altro", async () => {
    const loops = (count: number) => `${"{#loop [1] as a}".repeat(count)}x${"{/loop}".repeat(count)}`;
    expect((await staticBuild(await alone(loops(6)))).get("contatti")).toMatch(/x/u);
    expect(await buildWarnings(await alone(loops(6)))).toEqual([]);
    expect(await buildWarnings(await alone(loops(7)))).toEqual([expect.stringMatching(/^Build del sito: page contatti, riga \d+: con i componenti e le parti che chiama, 7 \{#loop\} stanno uno dentro l'altro: la build del sito si ferma oltre 6\.$/u)]);
    expect((await staticBuild(await alone(loops(7)))).get("contatti")).toHaveProperty("message", "I loop annidati superano il limite di 6.");
    // c1 calls c2 … c17: called from a page, c2 opens sixteen components, c1 seventeen.
    const chain = Array.from({ length: 17 }, (_, index) => `<template data-histos="component" data-ref="c${index + 1}"><span>${index < 16 ? `<C${index + 2} />` : "fine"}</span></template>`).join("\n");
    const withChain = async (call: string) => (await alone(call)).replace("</body>", `${chain}\n</body>`);
    expect((await staticBuild(await withChain("<C2 />"))).get("contatti")).toMatch(/fine/u);
    expect(await buildWarnings(await withChain("<C2 />"))).toEqual([]);
    expect(await buildWarnings(await withChain("<C1 />"))).toEqual([expect.stringMatching(/^Build del sito: page contatti, riga \d+: con i componenti e le parti che chiama, 17 componenti stanno uno dentro l'altro: la build del sito si ferma oltre 16\.$/u)]);
    expect((await staticBuild(await withChain("<C1 />"))).get("contatti")).toHaveProperty("message", "I componenti superano la profondità massima di 16.");
    // A template is one of them for its own calls, not for the page's: every page in it, and the pages the build makes from it.
    const inTemplate = (await withChain("<p>x</p>")).replace("<Site.Header /><main>{@slot}</main>", "<C2 /><main>{@slot}</main>");
    expect(await buildWarnings(inTemplate)).toEqual([expect.stringMatching(/^Build del sito: page home, riga \d+: nel template site\/page, con i componenti e le parti che chiama, 17 componenti stanno uno dentro l'altro, il template compreso: la build del sito si ferma oltre 16\.$/u)]);
    expect((await staticBuild(inTemplate)).get("home")).toBeInstanceOf(Error);
    const archive = (await fixture()).replace("</body>", `${chain}\n</body>`).replace('data-role="archive">\n  <Site.Header />', 'data-role="archive">\n  <C2 />');
    expect(await buildWarnings(archive)).toEqual([
      expect.stringMatching(/^Build del sito: template site\/opere, riga \d+: per l'archivio di serie, site\/opere e quello che chiama, 17 componenti stanno uno dentro l'altro: /u),
      expect.stringMatching(/^Build del sito: template site\/opere, riga \d+: per l'archivio di opera, /u),
      expect.stringMatching(/^Build del sito: template site\/opere, riga \d+: per i termini di tema, /u),
      expect.stringMatching(/^Build del sito: template site\/opere, riga \d+: per i termini di category, /u),
    ]);
  });
});

describe("i modificatori e le lettere del formato delle date sono quelli del renderer", () => {
  it("ogni modificatore dell'elenco condiviso si trasferisce e si applica nella build", async () => {
    const modifiers = CMS_RUNTIME_CAPABILITIES.modifiers.filter((name) => TRANSFER_MODIFIERS.has(name));
    expect(modifiers).toEqual([...TRANSFER_MODIFIERS]);
    const calls = modifiers.map((name) => (name === "date" ? '{"2026-11-07".date("j")}' : `{page.title.${name}()}`)).join(" ");
    const page = (await staticBuild(await contatti(`<p>${calls}</p>`))).get("contatti");
    expect(page).not.toBeInstanceOf(Error);
    expect(page).toMatch(/<p>CONTATTI contatti Contatti Contatti /u);
  });

  it("ogni lettera dell'elenco condiviso è un formato del renderer, e una lettera fuori dall'elenco ferma il renderer", async () => {
    const letters = [...CMS_DATE_FORMAT_LETTERS];
    expect(letters).toHaveLength(38);
    const page = (await staticBuild(await contatti(`<p>${letters.map((letter) => `[{"2026-11-07T10:05:09Z".date("${letter}")}]`).join("")}</p>`))).get("contatti");
    expect(page).not.toBeInstanceOf(Error);
    // Each letter prints a value of the date, never the letter itself.
    const values = /<p>(.*)<\/p>/u.exec(page as string)![1]!.match(/\[[^\]]*\]/gu)!;
    expect(values).toHaveLength(38);
    expect(values.filter((value, index) => value === `[${letters[index]}]` || value === "[]")).toEqual([]);
    const { project, store } = await new CmsProjectCatalog(await temporary()).createProject("Lettere");
    try {
      for (const letter of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const content = serializeXb(parseDsl(`<p>{"2026-11-07".date("${letter}")}</p>`).blocks);
        const rendered = await renderCmsPage({ store, projectId: project.id, content, locale: "it-IT", timeZone: "UTC", page: { id: "00000000-0000-4000-8000-000000000001", title: "L", slug: "l", url: "/l/" } }).then(() => true, () => false);
        expect(rendered, letter).toBe(CMS_DATE_FORMAT_LETTERS.has(letter));
      }
    } finally {
      store.close();
    }
  });

  it("il prototipo d'esempio e le espressioni di ogni tipo passano e si costruiscono", async () => {
    const html = await contatti('<p class="nota {page.slug.upper()}" title={page.title}>{page.title.truncateWords(3, "…")} {"2026-11-07".date("j F Y")} \\{graffe\\}</p>{#loop opere_recenti(limit: 3) as opera, indice}{#if opera.fields.prezzo}<p>{indice}: {opera.title} {opera.fields.prezzo.number(2)} {opera.fields.serie.title ?? "—"}</p>{/if}{/loop}');
    const pages = await staticBuild(html);
    expect([...pages.values()].filter((page) => page instanceof Error)).toEqual([]);
    expect(pages.get("contatti")).toMatch(/<p class="nota CONTATTI" title="Contatti">Contatti 7 novembre 2026 \{graffe\}<\/p><p>0: Ehi 90,00 Quadretti<\/p>/u);
  });
});
