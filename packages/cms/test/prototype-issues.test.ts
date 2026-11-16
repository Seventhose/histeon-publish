import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError, PROTOTYPE_ISSUES_KEPT } from "../src/prototype-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function build(html: string): Promise<unknown> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-issues-"));
  roots.push(root);
  return buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root));
}

async function refusal(html: string): Promise<PrototypeError> {
  const error = await build(html).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PrototypeError);
  return error as PrototypeError;
}

const fixture = () => readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
/** The 1-based line of the first line of `html` that contains `marker`. */
const lineOf = (html: string, marker: string) => html.split("\n").findIndex((line) => line.includes(marker)) + 1;
/** The 1-based column of `marker` on that line. */
const columnOf = (html: string, marker: string) => html.split("\n")[lineOf(html, marker) - 1]!.indexOf(marker) + 1;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-/u;

describe("errori del prototipo tutti insieme, con il punto del file (E4)", () => {
  it("raccoglie i problemi di tutti i documenti, ognuno con documento e riga, in ordine di file", async () => {
    const html = (await fixture())
      // A wrong element spanning lines: its start tag's line, not the end's.
      .replace('<section class="hero">', '<section class="hero">\n    <div\n      onclick="apri()"\n      class="x">\n      <p>Testo</p>\n    </div>')
      .replace("<p>Scrivimi.</p>", '<p>Scrivimi.</p>\n  <marquee>vecchio</marquee>\n  <p><strong>già</strong> <em>inline</em> e <button type="button" onmouseover="x()">ok</button></p>')
      // A syntax error stops the reading of its own document only.
      .replace("<p>C'era una volta un cane che guardava la notte.</p>", "<p>C'era una volta un cane che guardava la notte.</p>\n  {#if}");
    const error = await refusal(html);
    const issues = error.issues;
    expect(issues.map((issue) => issue.document)).toEqual(["page home", "page contatti", "page contatti", "post un-antico-sogno"]);
    expect(issues[0]).toMatchObject({ line: lineOf(html, "<div") });
    expect(issues[0]!.message).toMatch(/onclick.*Histeon non importa JavaScript: per un'azione usa un link o un modulo/u);
    expect(issues[1]).toMatchObject({ line: lineOf(html, "<marquee>") });
    expect(issues[1]!.message).toMatch(/marquee.*Gli elementi ammessi sono nel manuale, §17\.2/u);
    // Inline formatting folded into a text run before it does not move the lines of what follows.
    expect(issues[2]).toMatchObject({ line: lineOf(html, "onmouseover") });
    expect(issues[2]!.message).toMatch(/onmouseover/u);
    expect(issues[3]).toMatchObject({ line: lineOf(html, "{#if}"), column: 3 });
    // The message numbers them all, without any internal id.
    expect(error.message).toMatch(/^Il prototipo ha 4 errori:\n1\. page home, riga \d+: .*\n2\. page contatti, riga \d+: .*\n3\. .*\n4\. post un-antico-sogno, riga \d+, colonna 3: Sintassi/u);
    expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("un template che non esiste si dice con i template che ci sono", async () => {
    const html = (await fixture()).replace('data-slug="contatti" data-title="Contatti" data-template="site/page"', 'data-slug="contatti" data-title="Contatti" data-template="site/pagina"');
    const error = await refusal(html);
    expect(error.issues).toEqual([{ document: "page contatti", line: lineOf(html, 'data-template="site/pagina"'), column: columnOf(html, 'data-template="site/pagina"'), message: expect.any(String) }]);
    expect(error.message).toMatch(/^page contatti, riga \d+, colonna \d+: data-template="site\/pagina" non è un template del prototipo: scegli fra site\/page/u);
  });

  it("un errore di un componente e uno di una pagina arrivano insieme", async () => {
    const html = (await fixture()).replace('<template data-histos="component" data-ref="card-opera"', '<template data-histos="component" data-ref="card-opera" data-x="1"').replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p><font>x</font>");
    const component = (await fixture()).match(/<template data-histos="component" data-ref="card-opera"[^>]*>([\s\S]*?)<\/template>/u)?.[1] ?? "";
    // The fixture's component content with a wrong attribute of its own.
    const broken = html.replace(component, component.replace("<article", '<article onclick="x()"'));
    const error = await refusal(broken);
    expect(error.issues.map((issue) => issue.document)).toEqual(["component card-opera", "page contatti"]);
  });

  it("si ferma a un numero ragionevole di problemi", async () => {
    const many = Array.from({ length: PROTOTYPE_ISSUES_KEPT + 20 }, (_, index) => `<p onclick="f${index}()">x</p>`).join("\n");
    const error = await refusal((await fixture()).replace("<p>Scrivimi.</p>", many));
    expect(error.issues).toHaveLength(PROTOTYPE_ISSUES_KEPT);
    expect(error.message).toMatch(/… e altri 20: correggi questi e ricontrolla\.$/u);
    // The true count travels with the error, for the panel and the agent's text (which list only the kept ones).
    expect(error.total).toBe(PROTOTYPE_ISSUES_KEPT + 20);
    expect((await refusal((await fixture()).replace("<p>Scrivimi.</p>", "<font>x</font>"))).total).toBe(1);
  });

  it("un problema in un template di pagina si dice con la sua riga, non come lo slot che c'è, e non nasconde gli altri", async () => {
    const base = await fixture();
    const page = "<Site.Header /><main>{@slot}</main>";
    // Markup the transfer refuses inside the page template, and a problem in a page that uses it.
    const markup = base.replace(page, '<Site.Header /><main><div onclick="x()">a</div>{@slot}</main>').replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p>\n  <marquee>x</marquee>");
    const error = await refusal(markup);
    expect(error.issues).toEqual([
      { document: "template site/page", line: lineOf(markup, 'onclick="x()"'), message: expect.stringMatching(/onclick/u) },
      { document: "page contatti", line: lineOf(markup, "<marquee>"), message: expect.stringMatching(/<marquee>/u) },
    ]);
    expect(error.message).not.toMatch(/\{@slot\}/u);
    // A syntax error there keeps the file's line and column (on the template's first line, past its indentation).
    const syntax = base.replace(page, "<Site.Header /><main>{#if}{@slot}</main>");
    expect((await refusal(syntax)).issues).toEqual([{ document: "template site/page", line: lineOf(syntax, "{#if}"), column: columnOf(syntax, "{#if}"), message: expect.stringMatching(/^Sintassi/u) }]);
    // A template that really lacks its {@slot} says so, with its place.
    const slotless = base.replace(page, "<Site.Header /><main></main>").replace("<p>Scrivimi.</p>", '<p onclick="a()">Scrivimi.</p>');
    expect((await refusal(slotless)).issues).toEqual([
      { document: "template site/page", line: lineOf(slotless, 'data-ref="site/page"'), message: expect.stringMatching(/\{@slot\}/u) },
      { document: "page contatti", line: lineOf(slotless, 'onclick="a()"'), message: expect.stringMatching(/onclick/u) },
    ]);
  });

  it("quello che il progetto rifiuta in un componente arriva con il suo posto, insieme agli altri problemi", async () => {
    const html = (await fixture()).replace("<h1>Studio Ehi</h1>", "<h1>Studio Ehi</h1><marquee>x</marquee>").replace('{"titolo":{"type":"string"', '{"titolo":{"type":"nope"');
    expect((await refusal(html)).issues).toEqual([
      { document: "component card-opera", line: lineOf(html, 'data-ref="card-opera"'), message: expect.stringMatching(/titolo/u) },
      { document: "page home", line: lineOf(html, "<marquee>"), message: expect.stringMatching(/<marquee>/u) },
    ]);
  });

  it("il titolo mancante della home è uno dei problemi, non li sostituisce", async () => {
    const html = (await fixture()).replace('data-slug="home" data-title="Home"', 'data-slug="home"').replace("<h1>Studio Ehi</h1>", "<h1>Studio Ehi</h1><marquee>x</marquee>");
    expect((await refusal(html)).issues).toEqual([
      { document: "page home", line: lineOf(html, 'data-slug="home"'), message: "data-title: serve un testo di al massimo 500 caratteri." },
      { document: "page home", line: lineOf(html, "<marquee>"), message: expect.stringMatching(/<marquee>/u) },
    ]);
  });

  it("un carattere dove va un'immagine si dice con il suo nome e il suo documento, senza id interni", async () => {
    const woff = Buffer.concat([Buffer.from("wOFF"), Buffer.alloc(40)]).toString("base64");
    const base = (await fixture()).replace('"alt": "Ehi, con cornice" },', `"alt": "Ehi, con cornice" },\n  { "name": "carattere", "data": "data:font/woff;base64,${woff}" },`);
    for (const image of ['<img src="asset:carattere" alt="x" width="1" height="1">', '<img src="asset:ehi" srcset="asset:carattere 2x" alt="x" width="1" height="1">']) {
      const html = base.replace("<p>Scrivimi.</p>", `<p>Scrivimi.</p>\n  ${image}`);
      const error = await refusal(html);
      expect(error.issues).toEqual([{ document: "page contatti", line: lineOf(html, 'data-slug="contatti"'), message: expect.stringMatching(/^asset:carattere è un carattere \(font\/woff\), non un'immagine/u) }]);
      expect(error.message).not.toMatch(UUID_IN_TEXT);
    }
  });

  it("la colonna di un errore sulla prima riga di un documento è quella del file", async () => {
    const base = await fixture();
    const indented = base.replace("  <p>Scrivimi.</p>", "      <p>Scrivimi.</b>");
    const sameLine = base.replace('data-status="draft">\n  <p>Scrivimi.</p>', 'data-status="draft"><p>Scrivimi.</b>');
    for (const html of [indented, sameLine]) {
      expect((await refusal(html)).issues).toEqual([{ document: "page contatti", line: lineOf(html, "</b>"), column: columnOf(html, "</b>"), message: "Atteso </p>, trovato </b>." }]);
    }
  });

  // The line of a problem pairs start and end tags as the DSL parser does: what the parser reads as a value or skips
  // must never shift the pairs (the problem would land on another element's line). {#raw} and an inline Gutenberg
  // block are problems of their own in a page, each on its line.
  it.each([
    ["un valore senza virgolette che finisce con /", '<header>\n  <nav onclick="x()">\n    <a href=/>Home</a>\n  </nav>\n</header>', ["<nav onclick"]],
    ["un apostrofo in una stringa dentro un valore", `<p title="{page.title ? "L'arte" : ""}">x</p>\n  <div>\n  <font>a</font>\n  </div>\n  <p>C'era</p>`, ["<font>"]],
    ["un tag dentro {#raw}", '<section onclick="x()">\n  {#raw}<div>{/raw}\n  </section>', ["<section onclick", "{#raw}"]],
    ["un tag dentro un blocco Gutenberg", '<section onclick="x()">\n  <!-- wp:html --><div><!-- /wp:html -->\n  </section>', ["<section onclick", "<!-- wp:html"]],
  ])("la riga di un problema resta giusta con %s", async (_name, content, markers) => {
    const html = (await fixture()).replace("<p>Scrivimi.</p>", content);
    expect((await refusal(html)).issues).toEqual(markers.map((marker) => ({ document: "page contatti", line: lineOf(html, marker), message: expect.any(String) })));
  });

  it("migliaia di problemi in un documento grande non lo rileggono da capo uno per uno", async () => {
    // 10,000 problems after 400 KB of text: finding each line from the start of the template meant 4·10⁹ characters read.
    const page = (tag: string) => `<p>${"a".repeat(400_000)}</p>\n${`  ${tag}\n`.repeat(10_000)}`;
    const base = await fixture();
    let started = performance.now();
    await build(base.replace("<p>Scrivimi.</p>", page("<hr>")));
    const clean = performance.now() - started;
    const html = base.replace("<p>Scrivimi.</p>", page("<x/>"));
    started = performance.now();
    const error = await refusal(html);
    const elapsed = performance.now() - started;
    expect(error.total).toBe(10_000);
    expect(error.issues[0]).toMatchObject({ document: "page contatti", line: lineOf(html, "<x/>") });
    expect(error.issues.at(-1)).toMatchObject({ line: lineOf(html, "<x/>") + PROTOTYPE_ISSUES_KEPT - 1 });
    // Measured against the same document without problems, so that a slow machine is not a failure.
    expect(elapsed).toBeLessThan(clean * 4 + 1_500);
  }, 120_000);

  it("il conto dice tutti i problemi, anche oltre quelli che un documento tiene per trovarne le righe", async () => {
    const error = await refusal((await fixture()).replace("<p>Scrivimi.</p>", "<x/>".repeat(12_000)));
    expect(error.total).toBe(12_000);
    expect(error.issues).toHaveLength(PROTOTYPE_ISSUES_KEPT);
    expect(error.message).toMatch(/^Il prototipo ha 12000 errori:\n/u);
    expect(error.message).toMatch(/… e altri 11900: correggi questi e ricontrolla\.$/u);
  }, 120_000);

  it("un blocco che il controllo del markup rifiuta conta una volta sola, anche oltre quelli che un documento tiene", async () => {
    // 10,050 undeclared components inside <svg>: the markup check refuses each (no component in svg). Before, past the
    // 10,000 it keeps for their lines, the structure check counted the other 50 again as undeclared components.
    const error = await refusal((await fixture()).replace("<p>Scrivimi.</p>", `<svg>${"<CardOpra />".repeat(10_050)}</svg>`));
    expect(error.total).toBe(10_050);
    expect(error.message).toMatch(/^Il prototipo ha 10050 errori:\n/u);
    expect(error.message).toMatch(/… e altri 9950: correggi questi e ricontrolla\.$/u);
  }, 120_000);

  it("ogni documento si controlla con le query dichiarate senza copiarle tutte", async () => {
    // 150,000 query keys and 51 documents. Before, each document copied every key, for a message it seldom wrote.
    const queries = Array.from({ length: 150_000 }, (_, index) => ({ key: `q${index}` }));
    const components = Array.from({ length: 50 }, (_, index) => `<template data-histos="component" data-ref="c${index}"><p>${index}</p></template>`).join("\n");
    const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Q</title>
<script data-histos="manifest" type="application/json">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"Q","framework":"none"}</script>
<script data-histos="content" type="application/json">${JSON.stringify({ queries })}</script>
</head><body>
<template data-histos="page" data-slug="home" data-title="Home"><p>Home</p></template>
${components}
</body></html>`;
    const iterate = Set.prototype[Symbol.iterator];
    let copies = 0;
    const spy = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (this: Set<unknown>) {
      if (this.size >= 100_000) copies++;
      return iterate.call(this);
    });
    let error: PrototypeError;
    try {
      // The queries have neither label nor type: refused before anything is saved, once every component is read.
      error = await refusal(html);
    } finally {
      spy.mockRestore();
    }
    expect(error.issues.find((issue) => issue.document === "query q0")).toMatchObject({ line: 3, message: "label: serve un testo di al massimo 120 caratteri." });
    expect(error.total).toBe(300_001);
    expect(copies).toBe(0);
    // A loop on an undeclared query still lists the first of them (with labelled queries, so that it is among those listed).
    const labelled = html.replace(JSON.stringify({ queries }), JSON.stringify({ queries: queries.map((query) => ({ ...query, label: "Q", type: "post" })) }));
    const loop = await refusal(labelled.replace("<p>Home</p>", "{#loop nope() as x}<p>{x.title}</p>{/loop}"));
    expect(loop.issues.find((issue) => issue.document === "page home")?.message).toBe("{#loop}: la query nope non è fra quelle dei contenuti: scegli fra q0, q1, q2, q3, q4, q5, q6, q7….");
  }, 120_000);

  it("l'elenco è quello del file anche quando un documento letto prima ha i suoi problemi più avanti", async () => {
    // Components are read before pages: one declared at the end of the file, with more problems than are listed, must
    // not take the place of a page's problems that come before it in the file.
    const base = await fixture();
    const html = base
      .replace("<p>Scrivimi.</p>", Array.from({ length: 300 }, (_, index) => `<p onclick="p${index}()">x</p>`).join("\n"))
      .replace("</body>", `<template data-histos="component" data-ref="in-fondo">\n${Array.from({ length: 500 }, (_, index) => `<font>c${index}</font>`).join("\n")}\n</template>\n</body>`);
    const error = await refusal(html);
    expect(error.total).toBe(800);
    expect(error.issues).toHaveLength(PROTOTYPE_ISSUES_KEPT);
    expect(error.issues.every((issue) => issue.document === "page contatti")).toBe(true);
    expect(error.issues.map((issue) => issue.line)).toEqual(Array.from({ length: PROTOTYPE_ISSUES_KEPT }, (_, index) => lineOf(html, `onclick="p${index}()"`)));
    expect(error.message).toMatch(/… e altri 700: correggi questi e ricontrolla\.$/u);
  }, 120_000);

  it("un componente, una query o un blocco che il trasferimento non porta si dicono con la loro riga, insieme agli altri problemi", async () => {
    const html = (await fixture())
      .replace("<h1>Studio Ehi</h1>", "<h1>Studio Ehi</h1><marquee>x</marquee>")
      .replace("<p>Scrivimi.</p>", [
        "<p>Scrivimi.</p>",
        "  <CardOpra />",
        "  {#loop nope() as x}<p>{x.title}</p>{/loop}",
        "  {#raw}<b>x</b>{/raw}",
        "  <!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->",
        "  {@content}",
        "  {@slot altro}",
      ].join("\n"))
      .replace("<p>C'era una volta un cane che guardava la notte.</p>", "<p>C'era una volta un cane che guardava la notte.</p>\n  <Nope />");
    const error = await refusal(html);
    const contatti = (marker: string, message: RegExp) => ({ document: "page contatti", line: lineOf(html, marker), message: expect.stringMatching(message) });
    expect(error.issues).toEqual([
      { document: "page home", line: lineOf(html, "<marquee>"), message: expect.stringMatching(/<marquee>/u) },
      contatti("<CardOpra", /^il componente card-opra non è nel prototipo: dichiaralo con <template data-histos="component" data-ref="card-opra">/u),
      // A loop's source is said at its {#loop}, with the column too (B1).
      { ...contatti("{#loop nope", /^\{#loop\}: la query nope non è fra quelle dei contenuti: scegli fra opere_recenti, opere_notte\.$/u), column: columnOf(html, "{#loop nope") },
      contatti("{#raw}", /^\{#raw\} non si trasferisce/u),
      contatti("<!-- wp:paragraph", /^un blocco Gutenberg scritto come commento/u),
      contatti("{@content}", /^\{@content\} non si trasferisce/u),
      contatti("{@slot altro}", /^\{@slot\} vale solo nei template e nei componenti, non in una pagina\.$/u),
      { document: "post un-antico-sogno", line: lineOf(html, "<Nope"), message: expect.stringMatching(/^il componente nope non è nel prototipo/u) },
    ]);
    expect(error.total).toBe(8);
    expect(error.message).not.toMatch(UUID_IN_TEXT);
    // Alone, each is still a problem with its place, never a bare error of the transfer.
    for (const content of ["<CardOpra />", "{#loop nope() as x}<p>{x.title}</p>{/loop}", "{#raw}<b>x</b>{/raw}", "<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->", "{@content}"]) {
      const alone = (await fixture()).replace("<p>Scrivimi.</p>", content);
      const column = content.startsWith("{#loop") ? { column: columnOf(alone, content.slice(0, 12)) } : {};
      expect((await refusal(alone)).issues).toEqual([{ document: "page contatti", line: lineOf(alone, content.slice(0, 12)), ...column, message: expect.any(String) }]);
    }
    // In a template the same, with the element's line (the store would say only the template's).
    const base = await fixture();
    const template = base.replace("<Site.Header /><main>{@slot}</main>", "<Site.Header /><main>\n  <Site.Heder />{#raw}x{/raw}\n  {#loop nope() as x}{x.title}{/loop}{@slot}</main>");
    expect((await refusal(template)).issues).toEqual([
      { document: "template site/page", line: lineOf(template, "<Site.Heder"), message: expect.stringMatching(/^il componente site\/heder non è nel prototipo/u) },
      { document: "template site/page", line: lineOf(template, "<Site.Heder"), message: expect.stringMatching(/^\{#raw\}/u) },
      { document: "template site/page", line: lineOf(template, "{#loop nope"), column: columnOf(template, "{#loop nope"), message: expect.stringMatching(/la query nope/u) },
    ]);
    // A template is no component: said as such, not as a missing one.
    const asComponent = base.replace("<p>Scrivimi.</p>", "<Site.Page />");
    expect((await refusal(asComponent)).issues).toEqual([{ document: "page contatti", line: lineOf(asComponent, "<Site.Page"), message: "site/page è un template: un documento richiama solo componenti e parti, e una pagina sceglie il suo template con data-template." }]);
  }, 120_000);

  it("un problema dentro un testo ha la riga dove il testo comincia, non quella dell'elemento che lo contiene", async () => {
    const base = await fixture();
    const link = '<a href="javascript:void(0)">qui</a>';
    const cases: Array<[string, string]> = [
      // After a sibling, in an element and in the template itself.
      [`<main>\n  <h2>Titolo</h2>\n  <p>uno</p>\n  <p>due</p>\n  Vai ${link}\n</main>`, "Vai <a"],
      [`<h2>Titolo</h2>\n  <p>uno</p>\n  Vai ${link}`, "Vai <a"],
      // The first content of an element: past its start tag.
      [`<div>\n\n  ${link}\n</div>`, "<a href=\"javascript"],
      // After a comment the parser drops.
      [`<p>uno</p>\n  <!-- una nota\n  su due righe -->\n  ${link}`, "<a href=\"javascript"],
      // Inside a {#if} that follows an element: the {#if}'s line, no longer the template's.
      [`<p>uno</p>\n  {#if page.title}\n    Vai ${link}\n  {/if}`, "{#if page.title}"],
    ];
    for (const [content, marker] of cases) {
      const html = base.replace("<p>Scrivimi.</p>", content);
      expect((await refusal(html)).issues).toEqual([{ document: "page contatti", line: lineOf(html, marker), message: expect.stringMatching(/schema URL non ammesso/u) }]);
    }
  });

  it("lo stato della home si controlla come quello delle altre pagine, insieme agli altri problemi", async () => {
    for (const status of ["bozza", "Draft"]) {
      const html = (await fixture()).replace('data-slug="home" data-title="Home"', `data-slug="home" data-title="Home" data-status="${status}"`).replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p><font>x</font>");
      expect((await refusal(html)).issues).toEqual([
        { document: "page home", line: lineOf(html, 'data-slug="home"'), column: columnOf(html, `data-status="${status}"`), message: "data-status può essere draft o published." },
        { document: "page contatti", line: lineOf(html, "<font>"), message: expect.stringMatching(/<font>/u) },
      ]);
    }
    const draft = (await fixture()).replace('data-slug="home" data-title="Home"', 'data-slug="home" data-title="Home" data-status="draft"');
    await expect(build(draft)).resolves.toBeDefined();
  });

  it("con i fine riga CR o CR LF le righe e le colonne sono quelle del file", async () => {
    const base = (await fixture())
      .replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p>\n\n\n  <marquee>vecchio</marquee>")
      .replace("<p>C'era una volta un cane che guardava la notte.</p>", "<p>C'era una volta un cane che guardava la notte.</p>\n  {#if}")
      .replace("</body>", "\n\n  Vagante\n</body>");
    for (const end of ["\r", "\r\n"]) {
      const html = base.replaceAll("\n", end);
      expect((await refusal(html)).issues).toEqual([
        { document: "page contatti", line: lineOf(base, "<marquee>"), message: expect.stringMatching(/<marquee>/u) },
        { document: "post un-antico-sogno", line: lineOf(base, "{#if}"), column: 3, message: expect.stringMatching(/^Sintassi/u) },
      ]);
      expect(parsePrototype(html).ignored.filter((item) => item.what === "testo").map((item) => item.line)).toEqual([lineOf(base, "Vagante")]);
    }
  });
});

describe("gli sbagli più frequenti dei modelli piccoli dicono cosa scrivere al loro posto", () => {
  it("un componente richiamato con il data-ref dice il tag in PascalCase", async () => {
    const html = (await fixture()).replace("<CardOpera titolo=", "<card-opera titolo=");
    const error = await refusal(html);
    expect(error.message).toMatch(/<card-opera> non è trasferibile.*si richiama con il suo nome in PascalCase, non con il data-ref: per data-ref="card-opera" scrivi <CardOpera … \/>\./u);
  });

  it("una sezione posts in content dice dove vanno pagine e articoli", async () => {
    const html = (await fixture()).replace('data-histos="content">\n{\n', 'data-histos="content">\n{\n  "posts": [],\n');
    const error = await refusal(html);
    expect(error.message).toMatch(/sezione sconosciuta posts\. Le sezioni di content sono solo types, taxonomies, terms, records e queries\. Pagine e articoli non stanno in content: scrivili come <template data-histos="page"> e <template data-histos="post"> nel <body>\./u);
  });

  it("un tipo post dice che gli articoli si scrivono come template", async () => {
    const html = (await fixture()).replace('"types": [\n', '"types": [\n    { "key": "post", "label": "Articoli", "fields": [] },\n');
    const error = await refusal(html);
    expect(error.message).toMatch(/la chiave «post» è riservata.*Articoli e pagine non si dichiarano come tipi: scrivili come <template data-histos="post"> nel <body>\./u);
  });

  it("un ruolo ripetuto dice di toglierlo e di scegliere il template con data-template", async () => {
    const html = (await fixture()).replace('data-ref="site/page" data-title="Pagina">', 'data-ref="site/page" data-title="Pagina" data-role="archive">');
    const error = await refusal(html);
    expect(error.message).toMatch(/data-role="archive": ruolo non valido o già usato, è già di .*Ogni ruolo va a un solo template: togli data-role, e le pagine che usano questo template lo scelgono con data-template\./u);
  });
});

describe("un'immagine che non può essere intera si rifiuta con il suo nome (doc 23, voce 241)", () => {
  it("un WebP con la dimensione RIFF sbagliata, come lo scrive a memoria un modello piccolo", async () => {
    const good = "UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoQAAwAAoBCJaACdLoAA5gA/vD6K/8Q50OdDmtz15T4laAA";
    const broken = "UklGRiQAAABXRUJQVlA4ICgAAACQAQCdASoQAAwAAoBCJaACdLoAA5gA/vD6K/8Q50OdDmtz15T4laAA";
    const html = (await fixture()).replace('<script type="application/json" data-histos="assets">', `<script type="application/json" data-histos="assets">[{ "name": "logo-rotto", "data": "data:image/webp;base64,${broken}", "alt": "Logo" }, { "name": "logo-buono", "data": "data:image/webp;base64,${good}", "alt": "Logo" }`).replace('data-histos="assets">[{ "name": "logo-rotto"', 'data-histos="assets">[{ "name": "logo-rotto"');
    const error = await refusal(html.replace(/("alt": "Logo" \})\s*\[/u, "$1,"));
    expect(error.message).toMatch(/Media logo-rotto: non è un'immagine leggibile \(l'intestazione RIFF dice 44 byte, il file ne ha 60\)\. Usa il file vero, o togli il media e quello che lo usa: non scrivere mai a mano o a memoria i dati base64 di un'immagine\./u);
    expect(error.message).not.toMatch(/logo-buono/u);
  });
});

describe("i valori del prototipo si controllano prima di salvare, ognuno al suo posto (A7)", () => {
  /** The line and column of `marker` in the file: an attribute, or the `{` that opens an entry of the content. */
  const at = (html: string, marker: string) => ({ line: lineOf(html, marker), column: columnOf(html, marker) });
  const after = (html: string, anchor: string, added: string) => {
    expect(html).toContain(anchor);
    return html.replace(anchor, `${anchor}\n    ${added}`);
  };

  it("un data-ref fuori dalla grammatica si dice con documento, riga e colonna, per componenti, parti e template, insieme agli altri problemi", async () => {
    // A7 trial: the store alone refused a template's data-ref="site/404", as a «componente», with no document and no line.
    const fetchAsset = vi.fn(async () => new Uint8Array());
    const html = (await fixture())
      .replace('data-ref="site/non-trovato"', 'data-ref="site/404"')
      .replace('data-ref="site/header"', 'data-ref="Site/Header"')
      .replace('data-ref="card-opera" data-title', 'data-ref="card_opera" data-title')
      .replace('{ "name": "texture"', '{ "name": "remota", "url": "https://example.com/remota.png" },\n  { "name": "texture"')
      .replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p><font>x</font>");
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-issues-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const error = await buildPrototypeProfile(parsePrototype(html), catalog, { fetchAsset }).catch((reason: unknown) => reason) as PrototypeError;
    expect(error).toBeInstanceOf(PrototypeError);
    expect(error.issues).toEqual([
      { document: "part Site/Header", ...at(html, 'data-ref="Site/Header"'), message: expect.stringMatching(/^data-ref="Site\/Header" non è un nome valido per una parte\. Un data-ref è una parola, o due separate da una «\/»: .*Qui va bene site\/header\.$/u) },
      { document: "component card_opera", ...at(html, 'data-ref="card_opera"'), message: expect.stringMatching(/^data-ref="card_opera" non è un nome valido per un componente\. .*Qui va bene card-opera\.$/u) },
      { document: "template site/404", ...at(html, 'data-ref="site/404"'), message: expect.stringMatching(/^data-ref="site\/404" non è un nome valido per un template\. .*dopo un trattino viene sempre una lettera .*Per esempio site\/404 diventa site\/pagina-non-trovata\.$/u) },
      // The tags that call the part and the component by the name their fix gives them are no second problem.
      { document: "page contatti", line: lineOf(html, "<font>"), message: expect.stringMatching(/<font>/u) },
    ]);
    expect(error.issues[2]?.message).not.toMatch(/componente/u);
    expect(error.message).toMatch(/^Il prototipo ha 4 errori:\n1\. part Site\/Header, riga \d+, colonna \d+: data-ref=/u);
    // Refused before anything is downloaded or saved.
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(await catalog.listProjects()).toEqual([]);
  });

  it("anche un data-ref che manca, che si ripete, un'area o un ruolo sbagliati sono problemi raccolti con il loro posto", async () => {
    const html = (await fixture())
      .replace('data-area="header"', 'data-area="testata"')
      .replace('data-role="404"', 'data-role="errore"')
      .replace("</body>", '<template data-histos="component" data-title="Senza nome"><p>x</p></template>\n<template data-histos="template" data-ref="site/page" data-title="Copia">{@slot}</template>\n</body>');
    expect((await refusal(html)).issues).toEqual([
      { document: "part site/header", ...at(html, 'data-area="testata"'), message: 'data-area="testata": può essere header, footer o uncategorized.' },
      { document: "template site/non-trovato", ...at(html, 'data-role="errore"'), message: expect.stringMatching(/^data-role="errore": ruolo non valido o già usato\. I ruoli sono front-page, home, /u) },
      { document: "component ?", line: lineOf(html, 'data-title="Senza nome"'), message: 'manca data-ref: un componente ha bisogno del suo nome, per esempio data-ref="card-opera".' },
      { document: "template site/page", ...at(html, 'data-ref="site/page" data-title="Copia"'), message: `data-ref="site/page" ripetuto: è già di template site/page (riga ${lineOf(html, 'data-ref="site/page"')}), e ogni componente, parte e template ha il suo.` },
    ]);
  });

  // Each value that the store, the transfer or the static build refused only later (or not at all, as the build): one
  // change of the example, one problem, at the place of the file where it is written.
  const values: Array<[string, (html: string) => string, string, string, RegExp]> = [
    ["la chiave di un tipo", (html) => after(html, '{ "key": "serie", "label": "Serie", "fields": [] },', '{ "key": "Mostre", "label": "Mostre", "fields": [] },'), "tipo Mostre", '{ "key": "Mostre"', /^la chiave «Mostre» non va bene per un tipo: comincia con una lettera minuscola .* \(qui: mostre\)\.$/u],
    ["un tipo dal nome riservato", (html) => after(html, '{ "key": "serie", "label": "Serie", "fields": [] },', '{ "key": "post", "label": "Articoli", "fields": [] },'), "tipo post", '{ "key": "post"', /^la chiave «post» è riservata/u],
    ["un tipo ripetuto", (html) => after(html, '{ "key": "serie", "label": "Serie", "fields": [] },', '{ "key": "serie", "label": "Serie 2", "fields": [] },'), "tipo serie", '{ "key": "serie", "label": "Serie 2"', /^il tipo «serie» è dichiarato due volte\.$/u],
    ["un tipo blog con degli articoli", (html) => after(html, '{ "key": "serie", "label": "Serie", "fields": [] },', '{ "key": "blog", "label": "Blog", "fields": [] },'), "tipo blog", '{ "key": "blog"', /^il tipo «blog» prende l'indirizzo \/blog\/, che con degli articoli \(anche solo in bozza\) è l'elenco degli articoli/u],
    ["il template di un tipo che non c'è", (html) => html.replace('"singleTemplate": "site/opera"', '"singleTemplate": "site/scheda"'), "tipo opera", '{ "key": "opera"', /^singleTemplate «site\/scheda» non è un template del prototipo: scegli fra site\/page, /u],
    ["la chiave di un campo", (html) => html.replace('{ "key": "prezzo", "label": "Prezzo"', '{ "key": "Prezzo", "label": "Prezzo"'), "tipo opera", '{ "key": "Prezzo"', /^il campo «Prezzo»: la chiave comincia con una lettera minuscola .*senza trattini.* \(qui: prezzo\)\.$/u],
    ["un campo dal nome che il record ha già", (html) => html.replace('{ "key": "serie", "label": "Serie", "fields": [] }', '{ "key": "serie", "label": "Serie", "fields": [{ "key": "title", "label": "Titolo", "type": "text" }] }'), "tipo serie", '{ "key": "title"', /^il campo «title»: title è già un dato di ogni record \(id, typeId, /u],
    ["un tipo di campo che non c'è", (html) => html.replace('{ "key": "serie", "label": "Serie", "fields": [] }', '{ "key": "serie", "label": "Serie", "fields": [{ "key": "anno", "label": "Anno", "type": "number" }] }'), "tipo serie", '{ "key": "anno"', /^il campo «anno»: type «number» non è un tipo di campo; i tipi sono text, rich-text, /u],
    ["un enum senza options", (html) => html.replace('{ "key": "serie", "label": "Serie", "fields": [] }', '{ "key": "serie", "label": "Serie", "fields": [{ "key": "formato", "label": "Formato", "type": "enum" }] }'), "tipo serie", '{ "key": "formato"', /^il campo «formato»: un campo enum elenca i valori ammessi in options/u],
    ["options su un campo che non è enum", (html) => html.replace('{ "key": "serie", "label": "Serie", "fields": [] }', '{ "key": "serie", "label": "Serie", "fields": [{ "key": "nota", "label": "Nota", "type": "text", "options": ["a"] }] }'), "tipo serie", '{ "key": "nota"', /^il campo «nota»: options vale solo per un campo enum\.$/u],
    ["una relazione con un tipo che non c'è", (html) => html.replace('{ "key": "serie", "label": "Serie", "fields": [] }', '{ "key": "serie", "label": "Serie", "fields": [{ "key": "autore", "label": "Autore", "type": "relation", "targetType": "persona" }] }'), "tipo serie", '{ "key": "autore"', /^il campo «autore»: targetType è la key del tipo dei record collegati, e «persona» non è fra i tipi \(serie, opera\)\.$/u],
    ["la chiave di una tassonomia", (html) => after(html, '{ "key": "tema", "label": "Temi", "types": ["opera"] },', '{ "key": "Luoghi", "label": "Luoghi", "types": ["opera"] },'), "tassonomia Luoghi", '{ "key": "Luoghi"', /^la chiave «Luoghi» non va bene per una tassonomia: .* \(qui: luoghi\)\.$/u],
    ["una tassonomia con la chiave di un tipo", (html) => after(html, '{ "key": "tema", "label": "Temi", "types": ["opera"] },', '{ "key": "serie", "label": "Serie", "types": ["opera"] },'), "tassonomia serie", '{ "key": "serie", "label": "Serie", "types"', /^«serie» è già la key di un tipo: tipi e tassonomie hanno key diverse\.$/u],
    ["una tassonomia di un tipo che non c'è", (html) => html.replace('"types": ["opera"] }', '"types": ["opera", "evento"] }'), "tassonomia tema", '{ "key": "tema"', /^types: «evento» non è un tipo dichiarato \(serie, opera, o post per gli articoli\)\.$/u],
    ["category per altro che gli articoli", (html) => html.replace('"label": "Categorie", "types": ["post"]', '"label": "Categorie", "types": ["post", "opera"]'), "tassonomia category", '{ "key": "category"', /^category vale solo per gli articoli: "types": \["post"\]\.$/u],
    ["lo slug di un termine", (html) => after(html, '{ "taxonomy": "tema", "slug": "notte", "label": "Notte" },', '{ "taxonomy": "tema", "slug": "Mare Aperto", "label": "Mare" },'), "termine tema/Mare Aperto", '{ "taxonomy": "tema", "slug": "Mare Aperto"', /^lo slug «Mare Aperto» non va bene: solo lettere minuscole senza accenti, cifre e un trattino fra due parole, al massimo 63 caratteri\. Il progetto lo cambierebbe in mare-aperto, e con lui l'indirizzo del termine: scrivi "slug": "mare-aperto", e lo stesso slug dove il termine è nominato \(parent, terms dei record, data-terms degli articoli, filtri delle query\)\.$/u],
    ["il genitore di un termine che non c'è", (html) => html.replace('"label": "Cani", "parent": "notte"', '"label": "Cani", "parent": "notti"'), "termine tema/cani", '{ "taxonomy": "tema", "slug": "cani"', /^parent è lo slug di un altro termine di tema, dichiarato in terms\.$/u],
    ["un termine di una tassonomia che non c'è", (html) => after(html, '{ "taxonomy": "tema", "slug": "notte", "label": "Notte" },', '{ "taxonomy": "luogo", "slug": "roma", "label": "Roma" },'), "termine luogo/roma", '{ "taxonomy": "luogo"', /^taxonomy è la key di una tassonomia dichiarata: tema, category\.$/u],
    ["lo slug di un record", (html) => after(html, '"records": [', '{ "type": "serie", "slug": "Ritratti Due", "title": "Ritratti", "status": "draft" },'), "record serie/Ritratti Due", '{ "type": "serie", "slug": "Ritratti Due"', /^lo slug «Ritratti Due» non va bene: .*\. Il progetto lo cambierebbe in ritratti-due, e con lui l'indirizzo del record: scrivi "slug": "ritratti-due", e "serie\/ritratti-due" nei campi relation che lo collegano\.$/u],
    ["lo stato di un record", (html) => after(html, '"records": [', '{ "type": "serie", "slug": "ritratti", "title": "Ritratti", "status": "pubblicato" },'), "record serie/ritratti", '{ "type": "serie", "slug": "ritratti"', /^status «pubblicato»: può essere published, draft o archived\.$/u],
    ["una data di pubblicazione che non esiste", (html) => after(html, '"records": [', '{ "type": "serie", "slug": "ritratti", "title": "Ritratti", "publishedAt": "2026-02-30T09:00:00Z" },'), "record serie/ritratti", '{ "type": "serie", "slug": "ritratti"', /^publishedAt «2026-02-30T09:00:00Z» non è una data che esiste\.$/u],
    ["la lingua di un record", (html) => after(html, '"records": [', '{ "type": "serie", "slug": "ritratti", "title": "Ritratti", "status": "draft", "locale": "it_IT" },'), "record serie/ritratti", '{ "type": "serie", "slug": "ritratti"', /^locale «it_IT» non è una lingua: scrivi un tag BCP 47, per esempio en-GB\.$/u],
    ["l'ordine di un record", (html) => html.replace('"order": 11,', '"order": 1.5,'), "record opera/ehi", '{ "type": "opera", "slug": "ehi"', /^order è un numero intero\.$/u],
    ["un campo obbligatorio che manca", (html) => after(html.replace('"type": "decimal", "required": false', '"type": "decimal", "required": true'), '"records": [', '{ "type": "opera", "slug": "due", "title": "Due", "status": "draft" },'), "record opera/due", '{ "type": "opera", "slug": "due"', /^il campo prezzo è obbligatorio e manca\.$/u],
    ["un numero scritto come testo", (html) => html.replace('"prezzo": 90', '"prezzo": "90"'), "record opera/ehi", '{ "type": "opera", "slug": "ehi"', /^il campo prezzo vuole un numero\.$/u],
    ["una relazione con un record in bozza", (html) => html.replace('"slug": "quadretti", "title": "Quadretti", "status": "published"', '"slug": "quadretti", "title": "Quadretti", "status": "draft"'), "record opera/ehi", '{ "type": "opera", "slug": "ehi"', /^il campo serie collega serie\/quadretti, che non è pubblicato: un record pubblicato collega solo record pubblicati\.$/u],
    ["i termini di una tassonomia che il tipo non ha", (html) => html.replace('"publishedAt": "2026-10-01T09:00:00Z" }', '"publishedAt": "2026-10-01T09:00:00Z", "terms": { "tema": ["notte"] } }'), "record serie/quadretti", '{ "type": "serie", "slug": "quadretti"', /^terms: la tassonomia tema non è collegata al tipo serie: aggiungi "serie" ai suoi types\.$/u],
    ["la chiave di una query", (html) => after(html, '"queries": [', '{ "key": "opere-tutte", "label": "Tutte", "type": "opera" },'), "query opere-tutte", '{ "key": "opere-tutte"', /^la chiave «opere-tutte» non va bene per una query: .*senza trattini.* \(qui: opere_tutte\)\.$/u],
    ["una query dal nome riservato", (html) => after(html, '"queries": [', '{ "key": "posts", "label": "Articoli", "type": "post" },'), "query posts", '{ "key": "posts"', /^«posts» è un nome riservato di Histeon/u],
    ["una query di un tipo che non c'è", (html) => after(html, '"queries": [', '{ "key": "mostre", "label": "Mostre", "type": "mostra" },'), "query mostre", '{ "key": "mostre"', /^type è la key di un tipo dichiarato \(serie, opera\), o post per gli articoli\.$/u],
    ["il limite di una query", (html) => html.replace('"limit": 6, "orderBy": "publishedAt"', '"limit": 0, "orderBy": "publishedAt"'), "query opere_recenti", '{ "key": "opere_recenti"', /^limit è un numero intero da 1 a 100\.$/u],
    ["un ordine che i record non hanno", (html) => html.replace('"orderBy": "publishedAt"', '"orderBy": "createdAt"'), "query opere_recenti", '{ "key": "opere_recenti"', /^orderBy «createdAt» non ordina questi record: order, title, slug, publishedAt, updatedAt, o un campo pubblico/u],
    // Doc 23 item 232: a field with more values has no first one WordPress could sort by.
    ["un ordine per un campo con più valori", (html) => html.replace('{ "key": "prezzo", "label": "Prezzo", "type": "decimal", "required": false, "public": true, "multiple": false }', '{ "key": "prezzo", "label": "Prezzo", "type": "decimal", "required": false, "public": true, "multiple": true }').replace('"prezzo": 90', '"prezzo": [90]').replace('"orderBy": "publishedAt"', '"orderBy": "prezzo"'), "query opere_recenti", '{ "key": "opere_recenti"', /^orderBy «prezzo» non ordina questi record: .*o un campo pubblico del tipo con un solo valore che non sia relation, asset o rich-text\.$/u],
    ["una direzione che non c'è", (html) => html.replace('"order": "desc"', '"order": "giu"'), "query opere_recenti", '{ "key": "opere_recenti"', /^order può essere "asc" \(dal primo all'ultimo, il predefinito\) o "desc" \(dall'ultimo al primo\), in minuscolo: «giu» il progetto non lo legge, e la query ordinerebbe come con "asc"\.$/u],
    ["un filtro per una tassonomia che il tipo non ha", (html) => after(html, '"queries": [', '{ "key": "serie_notte", "label": "Serie", "type": "serie", "filter": { "taxonomyKey": "tema", "terms": ["notte"], "operator": "IN" } },'), "query serie_notte", '{ "key": "serie_notte"', /^filter: la tassonomia tema non è collegata al tipo serie/u],
    ["un filtro senza operatore", (html) => html.replace('"terms": ["notte"], "operator": "IN" }', '"terms": ["notte"] }'), "query opere_notte", '{ "key": "opere_notte"', /^filter: operator può essere IN, NOT IN o AND\.$/u],
    ["un filtro con più di 256 condizioni (nota 85 dell'audit)", (html) => html.replace('"filter": { "taxonomyKey": "tema", "terms": ["notte"], "operator": "IN" }', `"filter": { "and": [${Array.from({ length: 9 }, () => `{ "or": [${Array.from({ length: 32 }, () => '{ "taxonomyKey": "tema", "terms": ["notte"], "operator": "IN" }').join(", ")}] }`).join(", ")}] }`), "query opere_notte", '{ "key": "opere_notte"', /^filter: un filtro ha al massimo 256 condizioni in tutto, contando quelle di ogni gruppo\.$/u],
    ["lo slug di una pagina", (html) => html.replace('data-slug="contatti"', 'data-slug="Contatti"'), "page Contatti", 'data-slug="Contatti"', /^lo slug «Contatti» non va bene: .*\. Scrivi data-slug="contatti"\.$/u],
    ["la data di un articolo che non esiste", (html) => html.replace('data-published-at="2026-10-20T08:30:00Z"', 'data-published-at="2026-02-30T08:30:00Z"'), "post un-antico-sogno", 'data-published-at="2026-02-30T08:30:00Z"', /^data-published-at «2026-02-30T08:30:00Z» non è una data che esiste\.$/u],
    ["i termini di un articolo da una tassonomia non sua", (html) => html.replace(`data-terms='{"category":["racconti"]}'`, `data-terms='{"tema":["notte"]}'`), "post un-antico-sogno", "data-terms=", /^data-terms: la tassonomia tema non è collegata agli articoli: aggiungi "post" ai suoi types\.$/u],
    ["un termine ripetuto in un articolo", (html) => html.replace(`data-terms='{"category":["racconti"]}'`, `data-terms='{"category":["racconti","racconti"]}'`), "post un-antico-sogno", "data-terms=", /^data-terms: un termine di category è ripetuto\.$/u],
    ["la lingua del sito", (html) => html.replace('"locale": "it-IT"', '"locale": "it_IT"'), "manifest", '"locale": "it_IT"', /^locale «it_IT» non è una lingua che Histeon riconosce: scrivi un tag BCP 47/u],
    ["il fuso orario del sito", (html) => html.replace('"timeZone": "Europe/Rome"', '"timeZone": "Europe/Roma"'), "manifest", '"timeZone": "Europe/Roma"', /^timeZone «Europe\/Roma» non è un fuso orario che Histeon riconosce/u],
  ];
  it.each(values)("%s", async (_name, change, document, marker, message) => {
    const html = change(await fixture());
    expect(html).not.toBe(await fixture());
    const error = await refusal(html);
    expect(error.issues).toEqual([{ document, ...at(html, marker), message: expect.stringMatching(message) }]);
    expect(error.message).not.toMatch(UUID_IN_TEXT);
  });

  it("ogni problema dei valori arriva insieme agli altri, in ordine di file", async () => {
    const html = (await fixture())
      .replace('"order": 11,', '"order": 1.5,')
      .replace('data-ref="site/non-trovato"', 'data-ref="site/404"')
      .replace('data-slug="contatti"', 'data-slug="Contatti"')
      .replace("<p>C'era una volta un cane che guardava la notte.</p>", "<p>C'era una volta un cane che guardava la notte.</p><font>x</font>");
    const error = await refusal(html);
    expect(error.issues.map((issue) => issue.document)).toEqual(["record opera/ehi", "template site/404", "page Contatti", "post un-antico-sogno"]);
    expect(error.total).toBe(4);
  });

  it("i valori di un JSON su una riga sola hanno la loro colonna", async () => {
    const html = (await fixture()).replace(/<script type="application\/json" data-histos="content">\n([\s\S]*?)\n<\/script>/u, (_match, json: string) => `<script type="application/json" data-histos="content">${JSON.stringify(JSON.parse(json))}</script>`).replace('"order":11,', '"order":1.5,');
    const line = lineOf(html, '"order":1.5');
    const error = await refusal(html);
    expect(error.issues).toEqual([{ document: "record opera/ehi", line, column: (html.split("\n")[line - 1] ?? "").indexOf('{"type":"opera","slug":"ehi"') + 1, message: "order è un numero intero." }]);
  });

  it("più tipi di quanti il trasferimento ne porti si dicono all'elenco, dove si passa il limite", async () => {
    const extra = Array.from({ length: 30 }, (_, index) => `{ "key": "tipo-${index}", "label": "Tipo ${index}", "fields": [] },`).join("\n    ");
    const html = after(await fixture(), '"types": [', extra);
    // The 31st entry, the first past the limit.
    expect((await refusal(html)).issues).toEqual([{ document: "contenuti", ...at(html, '{ "key": "serie", "label": "Serie", "fields": [] }'), message: "32 tipi di contenuto: il trasferimento ne porta al massimo 30." }]);
  });

  it("più record di un tipo di quanti il sito statico ne costruisca si dicono prima della build", async () => {
    const records = Array.from({ length: 10_001 }, (_, index) => `{ "type": "serie", "slug": "s-${index}", "title": "S ${index}", "publishedAt": "2026-10-01T09:00:00Z" },`).join("\n    ");
    const html = after(await fixture(), '"records": [', records);
    expect((await refusal(html)).issues).toEqual([{ document: "record serie/s-10000", ...at(html, '{ "type": "serie", "slug": "s-10000"'), message: "il tipo serie ha più di 10.000 record pubblicati in it-IT: il sito statico ne costruisce al massimo 10.000 per tipo e lingua. Dividili fra più tipi o lasciane alcuni in bozza." }]);
  }, 60_000);

  it("un campo relation obbligatorio non ferma più un prototipo valido", async () => {
    // Records were saved without their relations first, so a required one was always «mancante», however written.
    const html = (await fixture()).replace('"type": "relation", "targetType": "serie", "required": false', '"type": "relation", "targetType": "serie", "required": true');
    expect(html).not.toBe(await fixture());
    const built = await build(html) as Awaited<ReturnType<typeof buildPrototypeProfile>>;
    expect(built.report.counts.records).toBe(2);
    const record = (slug: string) => built.profile.entities.find((entity) => (entity.payload as { slug?: unknown }).slug === slug && "values" in entity.payload);
    const ehi = record("ehi");
    if (!ehi) throw new Error("Record ehi mancante.");
    expect((ehi.payload as { values: Record<string, unknown> }).values.serie).toBe(record("quadretti")?.id);
    // A record it points to that the file does not declare is still a problem, at the record's place.
    const missing = html.replace('"serie": "serie/quadretti"', '"serie": "serie/altri"');
    expect((await refusal(missing)).issues).toEqual([{ document: "record opera/ehi", ...at(missing, '{ "type": "opera", "slug": "ehi"'), message: 'il campo serie vuole "<tipo>/<slug>" di un record dichiarato.' }]);
  });

  it("i nomi si controllano con la grammatica del progetto, né più né meno", async () => {
    // Each candidate goes to the store and through the check: both refuse it, or neither does.
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-issues-"));
    roots.push(root);
    const { store } = await new CmsProjectCatalog(root).createProject("Parità");
    const refusedByStore = (save: () => unknown) => {
      try {
        save();
        return false;
      } catch {
        return true;
      }
    };
    const prototypeWith = (content: Record<string, unknown>, documents = "") => `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>P</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"P","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">${JSON.stringify(content)}</script>
</head><body>
<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>
${documents}
</body></html>`;
    const refusedByCheck = async (html: string) => (await build(html).then(() => false, (error: unknown) => error instanceof PrototypeError));
    const results: Array<[string, boolean, boolean]> = [];
    try {
      for (const [index, key] of ["opera", "opera_2", "opera-due", "Opera", "1opera", "_opera", "post", "page", "category", "post_tag", "a".repeat(63), "a".repeat(64)].entries()) {
        results.push([`tipo ${key}`, refusedByStore(() => store.content.saveType({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, key, label: "T", fields: [], expectedHead: null })), await refusedByCheck(prototypeWith({ types: [{ key, label: "T", fields: [] }] }))]);
      }
      for (const [index, key] of ["prezzo", "data_inizio", "data-inizio", "Prezzo", "title", "slug", "url", "meta", "x".repeat(63), "x".repeat(64)].entries()) {
        const field = { key, label: "C", type: "text" };
        results.push([`campo ${key}`, refusedByStore(() => store.content.saveType({ key: `campi-${index}`, label: "T", fields: [field], expectedHead: null })), await refusedByCheck(prototypeWith({ types: [{ key: "campi", label: "T", fields: [field] }] }))]);
      }
      for (const key of ["opere_recenti", "OpereRecenti", "_x", "opere-recenti", "1x", "posts", "terms", "main", "users", "q".repeat(64), "q".repeat(65)]) {
        results.push([`query ${key}`, refusedByStore(() => store.content.saveQueryPreset({ key, label: "Q", typeKey: "post", expectedHead: null })), await refusedByCheck(prototypeWith({ queries: [{ key, label: "Q", type: "post" }] }))]);
      }
      for (const ref of ["card", "card-opera", "ui/card-hero", "site/404", "Card", "card_opera", "a/b/c", "card-", "card-2", "card--x", "/card", "card/"]) {
        results.push([`data-ref ${ref}`, refusedByStore(() => store.createComponent({ ref, title: "C" })), await refusedByCheck(prototypeWith({}, `<template data-histos="component" data-ref="${ref}"><p>x</p></template>`))]);
      }
    } finally {
      store.close();
    }
    expect(results.filter(([, byStore, byCheck]) => byStore !== byCheck)).toEqual([]);
    // Both refuse some and take others: the comparison is not empty on either side.
    expect(results.some(([, refused]) => refused)).toBe(true);
    expect(results.some(([, refused]) => !refused)).toBe(true);
  }, 60_000);

  it("quello che il progetto rifiuta ancora in un valore arriva con il posto del valore, mai come un messaggio nudo", async () => {
    // A filter on a field: the store's own check, which declarationIssues does not repeat.
    const html = (await fixture()).replace('"filter": { "taxonomyKey": "tema", "terms": ["notte"], "operator": "IN" }', '"filter": { "field": "nope", "op": "eq", "value": 1 }');
    const error = await refusal(html);
    expect(error.issues).toEqual([{ document: "query opere_notte", ...at(html, '{ "key": "opere_notte"'), message: "Il campo filtro nope non è disponibile nella query pubblica." }]);
    expect(error.message).toBe(`query opere_notte, riga ${lineOf(html, '{ "key": "opere_notte"')}, colonna ${columnOf(html, '{ "key": "opere_notte"')}: Il campo filtro nope non è disponibile nella query pubblica.`);
  });
});


describe("il controllo rifiuta quello che il progetto o la build rifiutano, né più né meno (review 5, Q)", () => {
  const at = (html: string, marker: string) => ({ line: lineOf(html, marker), column: columnOf(html, marker) });
  const after = (html: string, anchor: string, added: string) => {
    expect(html).toContain(anchor);
    return html.replace(anchor, `${anchor}\n    ${added}`);
  };
  type Built = Awaited<ReturnType<typeof buildPrototypeProfile>>;
  const typeOf = (built: Built, key: string) => built.profile.entities.find((entity) => entity.kind === "content-type" && (entity.payload as { key?: unknown }).key === key)?.payload as Record<string, unknown> | undefined;
  const queryOf = (built: Built, key: string) => built.profile.entities.find((entity) => entity.kind === "query-preset" && (entity.payload as { key?: unknown }).key === key)?.payload as Record<string, unknown> | undefined;
  const recordOf = (built: Built, slug: string) => built.profile.entities.find((entity) => entity.kind === "content-record" && (entity.payload as { slug?: unknown }).slug === slug)?.payload as Record<string, unknown> | undefined;

  it("Q1: singleTemplate e archiveTemplate null o vuoti sono nessun template, come per il progetto", async () => {
    // Round 4 refused them («singleTemplate è il data-ref di un template, scritto come testo»), where the store takes none.
    for (const change of ['"singleTemplate": null', '"singleTemplate": ""']) {
      const built = await build((await fixture()).replace('"singleTemplate": "site/opera"', change)) as Built;
      expect(typeOf(built, "opera")?.singleTemplateRef ?? null).toBeNull();
    }
    const built = await build((await fixture()).replace('"archiveTemplate": "site/opere"', '"archiveTemplate": null')) as Built;
    expect(typeOf(built, "opera")?.archiveTemplateRef ?? null).toBeNull();
    // Anything else that is not the data-ref of a template is still refused, at its type.
    const html = (await fixture()).replace('"singleTemplate": "site/opera"', '"singleTemplate": 5');
    expect((await refusal(html)).issues).toEqual([{ document: "tipo opera", ...at(html, '{ "key": "opera"'), message: "singleTemplate è il data-ref di un template, scritto come testo." }]);
  });

  it("Q2: un tipo blog si scontra con l'elenco degli articoli quando la build lo scrive: articoli anche in bozza, nessuna pagina blog", async () => {
    const html = after(await fixture(), '{ "key": "serie", "label": "Serie", "fields": [] },', '{ "key": "blog", "label": "Blog", "fields": [] },');
    const message = expect.stringMatching(/^il tipo «blog» prende l'indirizzo \/blog\/, che con degli articoli \(anche solo in bozza\) è l'elenco degli articoli: la build del sito si ferma\./u);
    expect((await refusal(html)).issues).toEqual([{ document: "tipo blog", ...at(html, '{ "key": "blog"'), message }]);
    // A draft starts the blog: the build writes /blog/ for it too (B1, the same rule as cmsPostsIndexWritten).
    const draft = html.replace('data-slug="un-antico-sogno"', 'data-slug="un-antico-sogno" data-status="draft"');
    expect((await refusal(draft)).issues).toEqual([{ document: "tipo blog", ...at(draft, '{ "key": "blog"'), message }]);
    // A published page «blog» takes /blog/: no posts index, and the type is accepted.
    const page = draft.replace("</body>", '<template data-histos="page" data-slug="blog" data-title="Diario"><h1>Diario</h1></template>\n</body>');
    const built = await build(page) as Built;
    expect(typeOf(built, "blog")).toBeDefined();
  });

  it("Q3: un termine ripetuto si rifiuta in un record e in un articolo, non nel filtro di una query", async () => {
    const filter = (await fixture()).replace('"terms": ["notte"], "operator": "IN"', '"terms": ["notte", "notte"], "operator": "IN"');
    expect(filter).not.toBe(await fixture());
    expect(queryOf(await build(filter) as Built, "opere_notte")).toBeDefined();
    const record = (await fixture()).replace('"terms": { "tema": ["notte", "cani"] }', '"terms": { "tema": ["notte", "notte"] }');
    expect((await refusal(record)).issues).toEqual([{ document: "record opera/ehi", ...at(record, '{ "type": "opera", "slug": "ehi"'), message: "terms: un termine di tema è ripetuto." }]);
  });

  it("Q5: un valore che l'import non legge si rifiuta solo dove cambierebbe il sito, dicendo come scriverlo", async () => {
    const base = await fixture();
    const changes: Array<[string, (html: string) => string, string, string, string]> = [
      ["limit come testo", (html) => html.replace('"limit": 6, "orderBy": "publishedAt"', '"limit": "6", "orderBy": "publishedAt"'), "query opere_recenti", '{ "key": "opere_recenti"', 'limit «6» è scritto come testo e il progetto non lo legge: la query mostrerebbe 10 voci. Scrivi il numero senza virgolette: "limit": 6.'],
      ["offset come testo", (html) => html.replace('"limit": 6, "orderBy": "publishedAt"', '"limit": 6, "offset": "2", "orderBy": "publishedAt"'), "query opere_recenti", '{ "key": "opere_recenti"', 'offset «2» è scritto come testo e il progetto non lo legge: la query partirebbe dalla prima voce. Scrivi il numero senza virgolette: "offset": 2.'],
      ["limit che non è un numero", (html) => html.replace('"limit": 6, "orderBy": "publishedAt"', '"limit": "sei", "orderBy": "publishedAt"'), "query opere_recenti", '{ "key": "opere_recenti"', 'limit è un numero intero da 1 a 100, senza virgolette, per esempio "limit": 6: scritto così il progetto non lo legge, e la query mostrerebbe 10 voci.'],
      ["order maiuscolo", (html) => html.replace('"order": "desc"', '"order": "DESC"'), "query opere_recenti", '{ "key": "opere_recenti"', 'order «DESC» non conta: si scrive in minuscolo, "order": "desc"; scritto così la query ordinerebbe dal primo all\'ultimo, come con "asc".'],
      ["orderBy che non è un testo", (html) => html.replace('"orderBy": "publishedAt"', '"orderBy": 5'), "query opere_recenti", '{ "key": "opere_recenti"', 'orderBy è il nome di un dato o di un campo fra virgolette, per esempio "orderBy": "title": scritto così il progetto non lo legge, e la query ordinerebbe per order.'],
      ["order di un record come testo", (html) => html.replace('"order": 11,', '"order": "11",'), "record opera/ehi", '{ "type": "opera", "slug": "ehi"', 'order «11» è scritto come testo e il progetto non lo legge: il record avrebbe order 0. Scrivi il numero senza virgolette: "order": 11.'],
      ["lingua di un record che non è un testo", (html) => html.replace('"order": 11,', '"order": 11, "locale": 5,'), "record opera/ehi", '{ "type": "opera", "slug": "ehi"', 'locale è il tag di una lingua fra virgolette, per esempio "locale": "en-GB": scritto così il progetto non lo legge, e il record resterebbe nella lingua del sito (it-IT).'],
      ["slug di un termine non canonico", (html) => html.replace('"slug": "notte", "label": "Notte"', '"slug": "Notte Fonda", "label": "Notte"').replace('"parent": "notte"', '"parent": "Notte Fonda"').replaceAll('["notte"', '["Notte Fonda"'), "termine tema/Notte Fonda", '{ "taxonomy": "tema", "slug": "Notte Fonda"', 'lo slug «Notte Fonda» non va bene: solo lettere minuscole senza accenti, cifre e un trattino fra due parole, al massimo 63 caratteri. Il progetto lo cambierebbe in notte-fonda, e con lui l\'indirizzo del termine: scrivi "slug": "notte-fonda", e lo stesso slug dove il termine è nominato (parent, terms dei record, data-terms degli articoli, filtri delle query).'],
    ];
    for (const [name, change, document, marker, message] of changes) {
      const html = change(base);
      expect(html, name).not.toBe(base);
      expect((await refusal(html)).issues, name).toEqual([{ document, ...at(html, marker), message }]);
    }
    // What has no effect passes: null (no value), text that reads as the default, an order that is "asc" in capitals.
    const quiet = base
      .replace('"limit": 6, "orderBy": "title", "order": "asc"', '"limit": "10", "offset": "0", "orderBy": null, "order": "ASC", "filter": null')
      .replace('"order": 11,', '"order": "0", "locale": null, "excerpt": "Breve",')
      .replace('"slug": "quadretti", "title": "Quadretti", "status": "published"', '"slug": "quadretti", "title": "Quadretti", "status": null');
    expect(quiet.match(/"limit": "10"|"order": "0"|"status": null/gu)).toHaveLength(3);
    const built = await build(quiet) as Built;
    expect(queryOf(built, "opere_notte")).toMatchObject({ limit: 10, offset: 0, orderBy: "order", order: "asc" });
    expect(recordOf(built, "ehi")).toMatchObject({ order: 0, locale: "it-IT" });
    expect(recordOf(built, "quadretti")).toMatchObject({ status: "published" });
  });

  it("Q6: dei campi relation obbligatori che fanno un giro si dicono con il giro, al primo record", async () => {
    const html = (await fixture())
      .replace('{ "key": "serie", "label": "Serie", "fields": [] }', '{ "key": "serie", "label": "Serie", "fields": [{ "key": "opera", "label": "Opera", "type": "relation", "targetType": "opera", "required": true, "public": true }] }')
      .replace('"targetType": "serie", "required": false', '"targetType": "serie", "required": true')
      .replace('"publishedAt": "2026-10-01T09:00:00Z" }', '"publishedAt": "2026-10-01T09:00:00Z", "values": { "opera": "opera/ehi" } }');
    expect((await refusal(html)).issues).toEqual([{
      document: "record serie/quadretti",
      ...at(html, '{ "type": "serie", "slug": "quadretti"'),
      message: 'i record si collegano in cerchio con campi relation obbligatori: serie/quadretti (campo opera) → opera/ehi (campo serie) → serie/quadretti. Il progetto salva un record solo dopo quelli che collega in un campo obbligatorio, quindi nessuno di questi si può salvare: togli "required": true da uno di questi campi, o il collegamento da uno di questi record.',
    }]);
  });

  it("Q6: un record con una relazione obbligatoria si salva con quella sola, le altre dopo: anche se due così si collegano a vicenda", async () => {
    // Saved with all its relations at once, the first of the two pointed to the second before it existed: refused.
    const html = after((await fixture()).replace('{ "key": "serie", "label": "Serie", "fields": [] },', '{ "key": "serie", "label": "Serie", "fields": [] },\n    { "key": "mostra", "label": "Mostre", "fields": [{ "key": "serie", "label": "Serie", "type": "relation", "targetType": "serie", "required": true, "public": true }, { "key": "gemella", "label": "Gemella", "type": "relation", "targetType": "mostra", "required": false, "public": true }] },'), '"records": [', '{ "type": "mostra", "slug": "prima", "title": "Prima", "publishedAt": "2026-10-03T09:00:00Z", "values": { "serie": "serie/quadretti", "gemella": "mostra/seconda" } },\n    { "type": "mostra", "slug": "seconda", "title": "Seconda", "publishedAt": "2026-10-03T09:00:00Z", "values": { "serie": "serie/quadretti", "gemella": "mostra/prima" } },');
    const built = await build(html) as Built;
    const id = (slug: string) => built.profile.entities.find((entity) => entity.kind === "content-record" && (entity.payload as { slug?: unknown }).slug === slug)?.id;
    const values = (slug: string) => (recordOf(built, slug)?.values ?? {}) as Record<string, unknown>;
    expect(values("prima").gemella).toBe(id("seconda"));
    expect(values("seconda").gemella).toBe(id("prima"));
    expect(values("prima").serie).toBe(id("quadretti"));
    expect(id("seconda")).toBeDefined();
  });

  it("Q7: uno stato non valido è un problema solo, senza quelli che ne deriverebbero", async () => {
    const html = (await fixture()).replace('"slug": "quadretti", "title": "Quadretti", "status": "published"', '"slug": "quadretti", "title": "Quadretti", "status": "pubblicato"');
    expect((await refusal(html)).issues).toEqual([{ document: "record serie/quadretti", ...at(html, '{ "type": "serie", "slug": "quadretti"'), message: "status «pubblicato»: può essere published, draft o archived." }]);
  });

  it("Q8: i problemi del manifest sono alla loro chiave nel JSON, non al tag <script>", async () => {
    const html = (await fixture()).replace('"locale": "it-IT"', '"locale": "italiano!!"');
    const error = await refusal(html);
    expect(error.issues).toEqual([{ document: "manifest", line: 8, column: columnOf(html, '"locale": "italiano!!"'), message: expect.stringMatching(/^locale «italiano!!» non è una lingua che Histeon riconosce/u) }]);
    // On one line with the tag, the key's column counts from the line's start too.
    const inline = html.replace('data-histos="manifest">\n{', 'data-histos="manifest">{');
    expect((await refusal(inline)).issues).toEqual([{ document: "manifest", ...at(inline, '"locale": "italiano!!"'), message: expect.any(String) }]);
  });

  it("un giro di genitori fra termini si dice al primo termine del giro, con il giro", async () => {
    // The build said only «Termini: un genitore manca o la gerarchia è circolare.», with no term and no line.
    const two = (await fixture()).replace('{ "taxonomy": "tema", "slug": "notte", "label": "Notte" }', '{ "taxonomy": "tema", "slug": "notte", "label": "Notte", "parent": "cani" }');
    expect((await refusal(two)).issues).toEqual([{ document: "termine tema/notte", ...at(two, '{ "taxonomy": "tema", "slug": "notte"'), message: "i genitori dei termini fanno un giro: tema/notte → tema/cani → tema/notte. Ogni termine sale fino a uno senza parent, e così nessuno di questi si può salvare: togli il parent di uno di loro." }]);
    const three = after(two.replace('"parent": "cani" }', '"parent": "luna" }'), '"terms": [', '{ "taxonomy": "tema", "slug": "luna", "label": "Luna", "parent": "cani" },');
    expect((await refusal(three)).issues).toEqual([{ document: "termine tema/luna", ...at(three, '{ "taxonomy": "tema", "slug": "luna"'), message: expect.stringMatching(/^i genitori dei termini fanno un giro: tema\/luna → tema\/cani → tema\/notte → tema\/luna\./u) }]);
    // A chain that ends is no circle.
    expect(await build(after(await fixture(), '"terms": [', '{ "taxonomy": "tema", "slug": "luna", "label": "Luna", "parent": "cani" },'))).toBeDefined();
  });

  it("un template con data-props ha la prop page che la build gli passa", async () => {
    // Its data-props replace the `page` prop of the store's own schema: every page it renders stopped the build.
    const html = (await fixture()).replace('data-ref="site/page" data-title="Pagina"', `data-ref="site/page" data-title="Pagina" data-props='{"tono":{"type":"string","default":"chiaro"}}'`);
    expect((await refusal(html)).issues).toEqual([{ document: "template site/page", ...at(html, "data-props='{\"tono\""), message: 'un template con data-props ha anche la prop page, di tipo object: la build gli passa la pagina in quella prop, e senza la build del sito si ferma su ogni pagina che lo usa. Aggiungi "page": {"type": "object"}.' }]);
    expect(await build(html.replace('{"tono":{"type":"string","default":"chiaro"}}', '{"tono":{"type":"string","default":"chiaro"},"page":{"type":"object"}}'))).toBeDefined();
    const broken = (await fixture()).replace('data-ref="site/page" data-title="Pagina"', `data-ref="site/page" data-title="Pagina" data-props='{"tono":'`);
    expect((await refusal(broken)).issues).toEqual([{ document: "template site/page", ...at(broken, "data-props='{\"tono\":'"), message: expect.stringMatching(/^data-props è un oggetto JSON con le props/u) }]);
  });
});

describe("elementi ignorati con la riga (D1)", () => {
  it("ogni elemento fuori dai template ha la sua riga del file", async () => {
    const html = await fixture();
    const parsed = parsePrototype(html);
    const script = parsed.ignored.find((item) => item.what === "script");
    expect(script?.line).toBe(lineOf(html, "<script>console.log"));
    expect(parsed.ignored.every((item) => typeof item.line === "number" && item.line > 0)).toBe(true);
  });

  it("il testo fuori dai template ha la riga dove si legge, non quella del tag che lo precede", async () => {
    const html = (await fixture()).replace("<p>Questo testo è fuori dai template.</p>", "<p>Questo testo è fuori dai template.</p>\n\n   Testo vagante");
    expect(parsePrototype(html).ignored.filter((item) => item.what === "testo")).toEqual([{ what: "testo", why: expect.any(String), line: lineOf(html, "Testo vagante") }]);
  });

  it("il testo dopo </body> o </html> ha la sua riga, non quella di </body>", async () => {
    // The parser adds it to the body's last text node, whose span then holds the end tags (and any comment between).
    const base = await fixture();
    for (const html of [
      base.replace("</body>\n</html>", "</body>\n\n  Testo dopo body\n</html>"),
      base.replace("</body>\n</html>\n", "</body>\n</html>\n\n\nTesto dopo body\n"),
      base.replace("</body>\n</html>", "</body>\n<!-- una nota\n> su due righe -->\n  Testo dopo body\n</html>"),
      // A stray end tag in the body joins two runs of text the same way.
      base.replace("</body>", "</div>\n\n  Testo dopo body\n</body>"),
      // Megabytes of spaces before it are read in one pass (a backtracking pattern overflowed its stack on them).
      base.replace("</body>", `${" ".repeat(11_000_000)}\n</div>\n  Testo dopo body\n</body>`),
    ]) {
      expect(parsePrototype(html).ignored.filter((item) => item.what === "testo").map((item) => item.line)).toEqual([lineOf(html, "Testo dopo body")]);
    }
  });
});
