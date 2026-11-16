import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import v8 from "node:v8";
import vm from "node:vm";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { cssParseCost, cssParseHeap, parsePrototype, readPrototypeHtml } from "../src/prototype-import.js";

/** A prototype with `pages` pages, each holding `content`, and `body` written directly in <body>. */
function prototype(pages: number, content: (index: number) => string, body = ""): string {
  const documents = Array.from({ length: pages }, (_, index) => `<template data-histos="page" data-slug="${index === 0 ? "home" : `p${index}`}" data-title="Pagina ${index}">${content(index)}</template>`).join("\n");
  return `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Limiti</title>
<script data-histos="manifest" type="application/json">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"Limiti","framework":"none"}</script>
</head><body>
${documents}
${body}
</body></html>`;
}

const TOO_COSTLY = /^Il markup del prototipo costa troppo da leggere \(intorno alla riga \d+\): migliaia di elementi aperti e mai chiusi/u;

describe("la lettura del file ha dei limiti, prima di ogni controllo (finding 7)", () => {
  it("un sito realistico di 2.000 pagine si legge per intero", () => {
    // About 15 MB and 590,000 elements: the whole tree of its documents once took more than 600 MB to read.
    const page = (index: number) => `<section class="hero"><div class="wrap"><h1 class="title">Pagina ${index}</h1><p class="lead">Testo con <a href="/chi-siamo">un link</a>, <strong>grassetto</strong> e <em>corsivo</em>.</p><Site.Button label="Scopri" href="/opere" /></div></section>${
      Array.from({ length: 12 }, (_, k) => `<section class="block"><h2>Sezione ${k}</h2><div class="grid"><article class="card"><img src="asset:foto" alt="Foto ${k}" width="640" height="480"><h3>Opera ${k}</h3><p>Una scheda con <a href="/opere/${k}">dettagli</a> e <span class="badge">segno</span>.</p></article><ul><li>Uno</li><li>Due</li><li><a href="#x">Tre</a></li></ul><CardOpera titolo="Opera ${k}" /></div></section>`).join("")
    }<table><tbody>${Array.from({ length: 20 }, (_, row) => `<tr><td>${row}</td><td>${row * 2}</td></tr>`).join("")}</tbody></table>`;
    const parsed = parsePrototype(prototype(2_000, page));
    expect(parsed.documents).toHaveLength(2_000);
    expect(parsed.documents[1]!.source).toBe(page(1));
  }, 60_000);

  it("migliaia di elementi aperti e mai chiusi si fermano subito, non riempiono la memoria", () => {
    // The verifier's file in small: 100 pages of 10,000 <x/> (a non-void element: each opens inside the last). The
    // whole of it, 790 pages, took 18 s and 4 GB of heap before any check; now it stops in a fraction of a second.
    expect(() => parsePrototype(prototype(100, () => "<x/>".repeat(10_000)))).toThrow(TOO_COSTLY);
  }, 60_000);

  it("un tag con migliaia di attributi si ferma prima che il confronto fra i nomi diventi lungo", () => {
    // parse5 compares each attribute with those before it: 30,000 of them are 450 million comparisons.
    const attributes = Array.from({ length: 30_000 }, (_, index) => ` a${index}`).join("");
    expect(() => parsePrototype(prototype(1, () => `<p${attributes}>x</p>`))).toThrow(TOO_COSTLY);
  }, 60_000);

  it("molti tag di chiusura fuori posto su molti elementi aperti si fermano", () => {
    // Each stray end tag looks through every open element: 15,000 by 15,000.
    expect(() => parsePrototype(prototype(1, () => `${"<x>".repeat(15_000)}${"</y>".repeat(15_000)}`))).toThrow(TOO_COSTLY);
  }, 60_000);

  it("elementi di formattazione lasciati aperti non si moltiplicano senza fine", () => {
    // 200 <b> left open are copied into each new paragraph: 6,000 paragraphs, 1.2 million copies from 60 KB.
    const open = Array.from({ length: 200 }, (_, index) => `<b class="b${index}">`).join("");
    expect(() => parsePrototype(prototype(1, () => `<p>${open}</p>${"<p>x</p>".repeat(6_000)}`))).toThrow(TOO_COSTLY);
  }, 60_000);

  it("tag <html> o <body> ripetuti e tabelle piene di elementi fuori posto si fermano", () => {
    // Each repeated <html> merges its attributes into all those before: 25,000 of them took some 20 s.
    expect(() => parsePrototype(prototype(1, () => "<p>x</p>", Array.from({ length: 25_000 }, (_, index) => `<html a${index}>`).join("")))).toThrow(TOO_COSTLY);
    // What a table cannot hold goes before it, looked up among all that went there before.
    expect(() => parsePrototype(prototype(1, () => "<p>x</p>", `<div><table>${"<br>".repeat(100_000)}</table></div>`))).toThrow(TOO_COSTLY);
  }, 60_000);

  it("oltre 4 milioni di elementi e commenti il file non si legge", () => {
    expect(() => parsePrototype(prototype(1, () => "<!---->".repeat(4_000_100)))).toThrow(/^Il prototipo ha più di 4\.000\.000 elementi e commenti HTML \(oltre la riga \d+\): troppi da leggere/u);
  }, 60_000);

  it("l'albero di un documento non si tiene, quello del resto del file sì e ha un limite", () => {
    // 300,000 paragraphs in a page are read from the file as written: none of their tree is kept, nor counted.
    const paragraphs = "<p>x</p>".repeat(300_000);
    expect(parsePrototype(prototype(1, () => paragraphs)).documents[0]!.source).toBe(paragraphs);
    // Outside the templates the same markup is kept for the report, up to a bound.
    expect(() => parsePrototype(prototype(1, () => "<p>x</p>", `<div>${paragraphs}</div>`))).toThrow(/^Fuori dai template con data-histos il prototipo ha troppo markup \(oltre la riga \d+\): quel contenuto non entra nel progetto/u);
  }, 60_000);

  it("di un documento chiuso non resta nulla, neanche una catena di elementi mai chiusi (review 4)", () => {
    // The verifier's file in small: each page holds 380 elements with ten attributes, never closed. Each dropped element
    // kept its last child, so every chain stayed reachable from its template: 2,000 such pages held 2 GB of tree and
    // ran out of a 1 GB heap, and the set marking dropped nodes, millions of keys alive, made 190,000 pages take 45 s.
    const chain = "<x a b c d e f g h i j>".repeat(380);
    const html = prototype(200, () => chain);
    const document = readPrototypeHtml(html);
    // Every node the read document still reaches, template contents included: the 76,000 elements of the pages are gone.
    let reached = 0;
    const stack: object[] = [document];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      reached++;
      if ("childNodes" in node) stack.push(...(node.childNodes as object[]));
      if ("content" in node) stack.push(node.content as object);
    }
    expect(reached).toBeLessThan(1_000);
    // And the documents are read whole, from the file.
    expect(parsePrototype(html).documents[199]!.source).toBe(chain);
  }, 60_000);

  it("il testo scritto direttamente in una tabella ha un limite, anche in un documento (review 4)", () => {
    // parse5 holds each run of text or spaces written straight in a table, some 150 bytes each, until the next tag: 16 MB
    // of `x ` in a page's table took 2.3 GB. 120,000 runs stop; a table's own spaces and DSL text read.
    expect(() => parsePrototype(prototype(1, () => `<table>${"x ".repeat(60_000)}</table>`))).toThrow(/^Il prototipo ha troppo testo scritto direttamente in una tabella \(intorno alla riga \d+\), fuori dalle celle/u);
    const table = `<table>\n  <tbody>\n    {#each opere as opera}\n    <tr><td>{opera.titolo}</td></tr>\n    {/each}\n  </tbody>\n</table>`;
    expect(parsePrototype(prototype(1, () => table)).documents[0]!.source).toBe(table);
  });

  it("il testo e i valori lunghi fuori dai documenti non tengono 32 byte a carattere (review 4)", () => {
    // parse5 builds text and attribute values a character at a time, and V8 keeps each step as a pair of 32 bytes: a run
    // of 31 MB of text, or of one attribute value, held 1 GB. 8 million characters held 256 MB each; now about what they weigh.
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const run = "x ".repeat(4_000_000);
    for (const html of [prototype(1, () => "<p>x</p>", `<p>${run}</p>`), prototype(1, () => "<p>x</p>", `<p title="${run}">x</p>`)]) {
      gc();
      const before = process.memoryUsage().heapUsed;
      const document = readPrototypeHtml(html);
      gc();
      const held = process.memoryUsage().heapUsed - before;
      expect(document.childNodes.length).toBeGreaterThan(0);
      expect(held).toBeLessThan(64 * 1024 * 1024);
    }
  }, 60_000);

  it("il markup che l'algoritmo di adozione sposta dentro un documento non conta come markup fuori dai template (review 4)", () => {
    // The verifier's file: one page of 12,000 misnested formatting elements with 80 attributes, nothing outside it. The
    // adoption agency moves nodes into a copy it builds before the copy has a place: they were charged to the markup
    // outside the templates, and the page stopped with «Fuori dai template…».
    const attributes = Array.from({ length: 80 }, (_, index) => ` a${index}`).join("");
    const content = `<b><p><span${attributes}>x</span></b>y</p>`.repeat(12_000);
    expect(parsePrototype(prototype(1, () => content)).documents[0]!.source).toBe(content);
    // The same markup outside the templates is still kept and counted.
    expect(() => parsePrototype(prototype(1, () => "<p>x</p>", `<div>${content}</div>`))).toThrow(/^Fuori dai template con data-histos il prototipo ha troppo markup/u);
  }, 60_000);

  it("anche il testo che l'algoritmo di adozione sposta dentro un documento non conta fuori dai template (review 5)", () => {
    // The verifier's file: one page of 1,010,000 `<b><p>x</b></p>`, 15 MB and nothing outside it. The text node made
    // in the page's content was not marked as part of it, so each one the agency moved was charged to the markup
    // outside the templates, and the page stopped with «Fuori dai template…».
    for (const unit of ["<b><p>x</b></p>", "<b><p>x</b>y</p>"]) {
      const content = unit.repeat(1_010_000);
      expect(parsePrototype(prototype(1, () => content)).documents[0]!.source).toBe(content);
    }
  }, 60_000);

  it("leggere come markup il testo di <plaintext>, <noscript>, <textarea> o di uno script resta lineare (review 5)", () => {
    // Each <script> or <style> in that text looked for its end tag from where it opened, to the end of the text when it
    // had none: 640 KB of `<script>` took 15 s, and a file of 32 MB would take hours, on the server's thread. Now each
    // search goes on from where the last one stopped.
    const cases: Array<[string, string]> = [
      ["plaintext", `<plaintext>${"<script>".repeat(80_000)}`],
      ["plaintext e tag di chiusura", `<plaintext>${"<script></x>".repeat(53_000)}`],
      ["noscript", `<noscript>${"<style>".repeat(91_000)}</noscript>`],
      ["textarea", `<textarea>${"<style>".repeat(91_000)}</textarea>`],
      ["script aperto", `<script>${"<style>".repeat(91_000)}`],
      ["script chiuso", `<script>${"<script>".repeat(80_000)}</script>`],
      ["script e stili chiusi in noscript", `<noscript>${"<script><style></script>".repeat(26_000)}</noscript>`],
      // Review 6: a tag cut short by a line that opens with a tag resumes there, also inside a quoted value.
      ["script chiuso con confronti e righe che aprono un tag", `<script>${"i<n x='a\n<b ".repeat(60_000)}</script>`],
      ["stile chiuso con valori su più righe", `<style>${'a<b c="<d\n" '.repeat(60_000)}</style>`],
      // Review 7: the CSS, the JSON or the JavaScript of each text is read once, wherever its tags stand.
      ["script con template literal annidati", `<script>${"`${<p>".repeat(100_000)}</script>`],
      ["script con commenti mai chiusi", `<script>${"/*<p>".repeat(100_000)}</script>`],
      ["script con confronti, paragrafi e espressioni regolari", `<script>${"a<b;<p>x</p>/'/;".repeat(40_000)}</script>`],
      ["stile con commenti mai chiusi e url", `<style>${"/*<p>url(".repeat(80_000)}</style>`],
      ["stile con stringhe interrotte", `<style>${"'a\n<b c='".repeat(60_000)}</style>`],
      ["foglio globale con tag in commenti e stringhe", `<style data-histos="global" data-name="G">${"/*<p>*/a{content:'<b>'}".repeat(40_000)}</style>`],
    ];
    for (const [name, body] of cases) {
      const started = performance.now();
      expect(parsePrototype(prototype(1, () => "<p>x</p>", body)).documents, name).toHaveLength(1);
      // parse5 alone reads each in some 50 ms; quadratic, the first took 15 s.
      expect(performance.now() - started, name).toBeLessThan(3_000);
    }
  }, 120_000);
});

describe("l'analisi dei fogli ha dei limiti, contati prima di analizzarli (review 4)", () => {
  const require = createRequire(import.meta.url);
  type Token = [string, string, number?, number?];
  const tokenize = require("postcss/lib/tokenize") as (input: unknown) => { nextToken: () => Token | undefined; endOfFile: () => boolean };
  const Input = require("postcss/lib/input") as new (css: string) => unknown;
  type Tokenizer = { nextToken: (options?: unknown) => Token | undefined; back: (token: Token) => void };
  const Parser = require("postcss/lib/parser") as new (input: unknown) => { root: postcss.Root; tokenizer: Tokenizer; parse(): void; createTokenizer(): void };
  /**
   * postcss's parser, counting the tokens it reads between two node boundaries (a comment, a rule without selector, a
   * `}`, the end of a node it made): the run that cssParseCost bounds. A token given back and read again counts once.
   */
  class Measured extends Parser {
    run = 0;
    longest = 0;
    override createTokenizer(): void {
      super.createTokenizer();
      const { nextToken, back } = this.tokenizer;
      let returned = 0;
      this.tokenizer.nextToken = (options) => {
        const token = nextToken(options);
        if (returned > 0) returned--;
        else if (token) this.longest = Math.max(this.longest, ++this.run);
        return token;
      };
      this.tokenizer.back = (token) => {
        returned++;
        back(token);
      };
    }
  }
  for (const method of ["comment", "emptyRule", "end", "other", "atrule"]) {
    const measured = Measured.prototype as unknown as Record<string, (this: Measured, token: Token) => void>;
    const inherited = (Parser.prototype as unknown as Record<string, (this: Measured, token: Token) => void>)[method]!;
    measured[method] = function (this: Measured, token: Token) {
      inherited.call(this, token);
      this.run = 0;
    };
  }
  // Review 7: raw() keeps a rule's selector or an at-rule's prelude twice, raws {value, raw}, when a comment in it has
  // a space on a side or follows a `,`: the tokens it joined count again.
  type Raw = (this: Measured & { doubled?: number }, node: { raws: Record<string, unknown> }, prop: string, tokens: Token[], customProperty?: boolean) => void;
  const inheritedRaw = (Parser.prototype as unknown as { raw: Raw }).raw;
  (Measured.prototype as unknown as { raw: Raw }).raw = function (node, prop, tokens, customProperty) {
    const joined = tokens.length;
    inheritedRaw.call(this, node, prop, tokens, customProperty);
    if ((prop === "selector" || prop === "params") && typeof node.raws[prop] === "object") this.doubled = (this.doubled ?? 0) + joined;
  };
  /** What postcss itself makes of a sheet: its nodes, its top-level rules, the most words its tokenizer holds, the longest run, the tokens raw() joined twice. */
  const postcssCost = (css: string) => {
    const parser = new Measured(new Input(css)) as Measured & { doubled?: number };
    parser.parse();
    const root = parser.root;
    let nodes = 0;
    root.walk(() => {
      nodes++;
    });
    // The tokenizer keeps each word it reads (not one an escape starts) and lets go of the last at each `(`. Every
    // token's text is a string V8 shares when it is one character up to U+00FF, else one of its own.
    const tokens = tokenize(new Input(css));
    let held = 0;
    let words = 0;
    let count = 0;
    let strings = 0;
    while (!tokens.endOfFile()) {
      const [type, value] = tokens.nextToken()!;
      count++;
      if (value.length > 1 || value.charCodeAt(0) > 0xff) strings++;
      if (type === "word" && !value.startsWith("\\")) held++;
      if (type === "(" || type === "brackets") held = Math.max(0, held - 1);
      words = Math.max(words, held);
    }
    return { nodes, topRules: root.nodes.filter((node) => node.type === "rule").length, words, run: parser.longest, tokens: count, strings, doubled: parser.doubled ?? 0 };
  };
  const counted = (css: string) => {
    const cost = cssParseCost(css);
    return { nodes: cost.nodes, topRules: cost.topRules, words: cost.words, run: cost.run, tokens: cost.tokens, strings: cost.strings, doubled: cost.doubled };
  };
  /** The characters decl() copies flat, each declaration's name, spaces after its colon and value: cssParseCost counts no fewer. */
  const declarationCopies = (css: string) => {
    let copied = 0;
    postcss.parse(css).walkDecls((declaration) => {
      copied += declaration.prop.length + String(declaration.raws.between ?? "").length + declaration.value.length;
    });
    return copied;
  };

  it("conta nodi, regole, parole e parti come postcss", () => {
    const example = readFileSync(new URL("./fixtures/prototipo-esempio.html", import.meta.url), "utf8");
    const sheets = [...example.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map((match) => match[1]!);
    sheets.push(
      // A declaration that a `}` ends gives back the comments after it; a custom property keeps its braces.
      ".a{b:c /* x */ /* y */}.b{--x:{a:b;c:d};e:f}",
      // url() and parentheses as one token, or not; strings and escapes with `;`, `{` and `}` inside; brackets in preludes.
      ".a{background:url(data:a;b{c}) url( x.png ) calc(1px + (2px));content:\"a;{}\" 'b\\'';x:\\;y}@supports (a:b) and [c;d] {.e{f:g}}",
      // At-rules with and without a block, stray semicolons, nesting, a byte order mark.
      "\uFEFF/*c*/@charset \"x\";;; .a{&:hover{b:c};@media (x){d:e}} @layer a, b; .f{}",
      // Words that `url` and `(` hold and let go of.
      ".a{b:url url(x) url (y) c(d) e( f ) g url(\"h\")}",
      // Review 5: a node that opens with `[` or a `(` that is no single token holds everything up to its `]` or `)`,
      // `;` and braces included; one that opens with `:` is a declaration, which gives back the comments after it.
      ".z{[:;:;:;]:x}",
      ".z{[a;b{c}d]:x} .y{(e/f;g)h:i}",
      ".b{: u /*k*/ }",
      ".b{a:b; : u  /*k*/ }",
      // Spaces and stray semicolons between nodes are one run with the node after them.
      `.a{b:c}${" ;".repeat(50)}.d{e:f}`,
      // Review 7: a comment with a space on a side, or after a `,`, in a selector or a prelude keeps it twice; one
      // between two words, or before a `{` or after an at-rule's name (in raws.between and raws.afterName), does not.
      ".a /**/ b{} .a/**/b{} .a,/**/b{} .a /**/{} a/**//**/ b{} a/**//**/b{} [a /**/ b]{} .z{& /**/ a{}}",
      "@media /**/ x{} @media x /**/ y{} @x a /**/ b; @media x/**/y{} .z{@media a, /**/ b{}}",
    );
    for (const css of sheets) expect(counted(css), css.slice(0, 80)).toEqual(postcssCost(css));
  });

  it("conta come postcss anche migliaia di fogli generati (review 5)", () => {
    // Sheets of every token postcss reads, put together at random: nodes, at-rules and comments, nested, with brackets,
    // parentheses, strings, escapes, url(), `!important`, stray `;`, a node that opens with `[`, `(` or `:`.
    let seed = 20_261_027;
    const random = (count: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 8) % count;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
    const values = ["x", "1px", "url(a.png)", "url( b )", "url(\"c\")", "url(d;e)", "calc(1px + (2px))", "f(g)", "f( g )", "'s;{}'", "\"t}\"", "\\;", "\\41 ", "\\\\", "!important", "#fff", "/", "*", ",", "a/b", "url", "(", ")", "[x]", "[", "]", "/*c*/", "u\\(", "--v", "@w", "x(y\nz)", "(a\"b\")", "url(a\\)b)", "url(x)y", "a!b", ":", "{", "}", ";", "(a/b;c)", "[;]", "[{}]"];
    const selectors = ["a", ".b", "&", "&:hover", "a > b", "[c=d]", "e,f", "--g", ":root", "\\31 x", "a/**/b", "#h", "*", "x:not(.y)", "a b c", "@nope", "[", "[a;b]", "(", "(x/y)", ":", "::x", "]"];
    const gap = () => pick(["", " ", "\n", "  ", "\t", "/*k*/", " /*k*/ ", ";", ";;", "\n/*k*/\n"]);
    const value = () => Array.from({ length: 1 + random(5) }, () => pick(values) + pick(["", " ", " "])).join("");
    const block = (depth: number): string => {
      let out = "";
      for (let index = random(5); index > 0; index--) {
        const kind = random(12);
        if (kind < 4) out += gap() + pick(["b", "--c", "d", "-e", "*f", "[", "(", ":", "[x]", "(a/b)", "]"]) + pick([":", " : ", ":", ""]) + value() + pick([";", ";", "", " ;"]);
        else if (kind < 6 && depth < 4) out += `${gap()}${pick(selectors)}${gap()}{${block(depth + 1)}}`;
        else if (kind < 7 && depth < 4) out += `${gap()}${pick(["@media (x)", "@supports (a:b) and [c;d]", "@layer a", "@x y", "@font-face", "@media screen{", "@x [", "@x ("])}${gap()}{${block(depth + 1)}}`;
        else if (kind < 8) out += gap() + pick(["@charset \"x\";", "@layer a, b;", "@import url(x);", "@x;", "@x [;];"]);
        else if (kind < 9) out += gap() + pick(["[", "(", "[a:b;c:d]", "[:;:;]", "(a/b;c)"]) + value() + pick(["]", ")", ""]) + pick([":x", ""]) + pick([";", "", "}"]);
        else out += `${gap()}/*${pick(["", "c", "*", "{}"])}*/`;
      }
      return out + gap();
    };
    let compared = 0;
    for (let index = 0; index < 20_000; index++) {
      const css = (random(20) === 0 ? "﻿" : "") + block(0);
      let expected: ReturnType<typeof postcssCost>;
      try {
        expected = postcssCost(css);
      } catch {
        // A sheet postcss refuses: counted up to where it stops, nothing to compare.
        continue;
      }
      compared++;
      expect(counted(css), JSON.stringify(css)).toEqual(expected);
      expect(cssParseCost(css).flat, JSON.stringify(css)).toBeGreaterThanOrEqual(declarationCopies(css));
    }
    expect(compared).toBeGreaterThan(5_000);
  }, 120_000);

  it("la memoria contata copre quel che postcss tiene davvero, anche nei fogli più fitti (review 6)", () => {
    // What the parse holds at its end (the tree, the words its tokenizer keeps), measured, against cssParseHeap: a
    // twentieth of the densest sheet of each shape within the bounds. Pieces of one character, of two spaces (each a
    // string of its own), strings, a million nodes' worth of nested rules, nodes and pieces together.
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const bracket = (unit: string, count: number) => Array.from({ length: Math.ceil(count / 49_990) }, (_, index) => `.r${index}{[${unit.repeat(Math.min(49_990, count - index * 49_990))}]:x}`).join("");
    const shapes: Record<string, string> = {
      "un carattere": bracket(": ", 409_000),
      "due spazi": bracket(":  ", 279_000),
      "stringhe": bracket("''  ", 205_000),
      "selettori": Array.from({ length: 6 }, () => `${":  ".repeat(46_000)}x{}`).join(""),
      "regole annidate": `.z{${"&{b:c}".repeat(41_000)}}`,
      "regole vuote": Array.from({ length: 4_990 }, (_, index) => `.r${index}{${"&{}".repeat(9)}}`).join(""),
      "nodi e parti": `.z{${"&{b:c}".repeat(20_000)}}${bracket(":  ", 140_000)}`,
      // Review 7: a comment with a space beside it keeps a selector or an at-rule's prelude twice, raws {value, raw}:
      // these held 2.0 times the count before it counted that.
      "selettori con un commento": Array.from({ length: 3 }, (_, index) => `.s${index} /**/ ${": ".repeat(49_000)}x{}`).join("\n"),
      "preludi con un commento": `.w{${Array.from({ length: 3 }, (_, index) => `@media x${index} /**/ ${": ".repeat(49_000)}x{}`).join("\n")}}`,
      "selettori annidati con un commento": `.w{${Array.from({ length: 3 }, (_, index) => `& .s${index} , /**/ ${": ".repeat(49_000)}x{}`).join("\n")}}`,
    };
    /** The heap the parse of `css` holds at its end; in a call of its own, so that nothing of the last one stays. */
    const measure = (css: string) => {
      gc();
      gc();
      const before = process.memoryUsage().heapUsed;
      const parser = new Parser(new Input(css));
      parser.parse();
      gc();
      gc();
      const held = process.memoryUsage().heapUsed - before;
      return parser.root.nodes.length > 0 ? held : 0;
    };
    for (const [name, css] of Object.entries(shapes)) {
      const estimate = cssParseHeap(cssParseCost(css));
      const held = measure(css);
      // Measured 0.67 to 1.00 of the estimate over 27 shapes; the estimate never falls short by more than noise.
      expect(held, name).toBeLessThan(estimate * 1.05);
      expect(held, name).toBeGreaterThan(estimate * 0.6);
    }
    // decl() copies each declaration's value flat (`value.includes(':')`), in two-byte text two bytes a character, and
    // with a comment or a space before its `;` keeps its tokens as raws.value.raw: counted from above, the copies at two
    // bytes a character of the declaration (40 values of 200,000 spaces held 16 MB the count missed).
    const copies: Record<string, string> = {
      "valori di spazi": `/* ’ */.a{${Array.from({ length: 40 }, (_, index) => `p${index}: x${" ".repeat(200_000)}x;`).join("")}}`,
      "valori con un commento": `.a{${Array.from({ length: 3 }, (_, index) => `p${index}: x /**/ ${"] ".repeat(49_000)}y ;`).join("")}}`,
    };
    for (const [name, css] of Object.entries(copies)) {
      // Counted first, which reads the sheet flat as the import has it, before the parse measured.
      const estimate = cssParseHeap(cssParseCost(css));
      expect(measure(css), name).toBeLessThan(estimate * 1.05);
    }
  }, 120_000);

  it("una dichiarazione lunga che finisce con «important» senza «!» si conta prima di analizzarla (review 7)", () => {
    // decl() takes such a value back from its end one token at a time, copying all it took back each time (trim):
    // quadratic, 4,000 pieces of a word and 1,000 spaces took 7.7 s, a file of 30 MB of them would take minutes. The
    // copies are counted from above (tokens taken back times characters), and only for such a value: up to a word
    // opening with `!` and the space before it.
    const piece = `x${" ".repeat(1_000)}`;
    expect(cssParseCost(`.a{p: ${piece.repeat(4_000)}important}`).important).toBeGreaterThan(10_000_000);
    expect(cssParseCost(`.a{p: ${piece.repeat(4_000)}IMPORTANT;}`).important).toBeGreaterThan(10_000_000);
    expect(cssParseCost(`.a{p: ${piece.repeat(4_000)}! important}`).important).toBeLessThan(100_000);
    expect(cssParseCost(`.a{p: ${piece.repeat(4_000)}!important}`).important).toBe(0);
    expect(cssParseCost(`.a{p: ${piece.repeat(4_000)}importantly}`).important).toBe(0);
    // A real sheet never comes near it.
    const histos = readFileSync(new URL("../assets/histos-css/histos.css", import.meta.url), "utf8");
    expect(cssParseCost(histos).important).toBeLessThan(1_000_000);
  });

  it("trova il source map incorporato come postcss, che lo leggerebbe per intero (review 7)", () => {
    // postcss's Input takes the last `/*`, spaces and `# sourceMappingURL=` of the whole text, up to its `*/`, and decodes
    // and parses an annotation that opens with `data:` as a source map, held with the tree; on an error in the sheet it
    // reads every mapping (1.4 million alike, in 8 MB, took 67 s and then ran out of stack).
    const map = 'data:application/json,{"version":3,"sources":[],"names":[],"mappings":""}';
    const cases = [
      `a{}\n/*# sourceMappingURL=${map} */`,
      `a{}/*  #  sourceMappingURL=${map} */`,
      `a{content:"/*# sourceMappingURL=${map} */"}`,
      `/*# sourceMappingURL=${map} */ a{} /*# sourceMappingURL=a.css.map */`,
      `/*# sourceMappingURL=a.css.map */ a{} /*# sourceMappingURL=${map} */`,
      `a{} /*\t\n # sourceMappingURL=  ${map} */`,
      `a{} /*# sourceMappingURL= */ data: */`,
      `a{} /*# sourceMappingURL=dat*/`,
      `a{} /*/*# sourceMappingURL=${map} */`,
    ];
    for (const css of cases) expect(cssParseCost(css).sourceMap !== -1, css).toBe(postcss.parse(css).source?.input.map !== undefined);
    expect(cases.filter((css) => cssParseCost(css).sourceMap !== -1)).toHaveLength(5);
  });

  it("toglie dai fogli solo il source map incorporato che li chiude, in un tempo lineare; ogni altro ferma il foglio (review 8, 9)", () => {
    // The comment that ends the sheet (only spaces after it) leaves, a line feed in its place; postcss then finds no map
    // in what is kept. Any other stays, and a sheet that holds one postcss would read stops at its line.
    const map = 'data:application/json,{"version":3,"sources":[],"names":[],"mappings":""}';
    const stripped = [
      [`a{}\n/*# sourceMappingURL=${map} */`, "a{}\n\n"],
      [`/*# sourceMappingURL=${map} */`, "\n"],
      [`a{}\n \t/*\t\n # sourceMappingURL=  ${map} */\n  \r\n`, "a{}\n \t\n\n  \n"],
      [`/*# sourceMappingURL=a.css.map */ a{}\n/*# sourceMappingURL=${map} */`, "/*# sourceMappingURL=a.css.map */ a{}\n\n"],
      [`a{content:"*/"}\n/*# sourceMappingURL=${map} */`, 'a{content:"*/"}\n\n'],
      [`a{content:'/*'}\n/*# sourceMappingURL=${map} */\n`, "a{content:'/*'}\n\n\n"],
      [`a\\\\{}\n/*# sourceMappingURL=${map} */`, "a\\\\{}\n\n"],
      // A comment, url( or string opened on an earlier line runs to the end of the sheet with the map or without it.
      [`a{} /* vecchio\n/*# sourceMappingURL=${map} */`, "a{} /* vecchio\n\n"],
      // Not a map postcss decodes: they stay.
      [`a{}/*  #  sourceMappingURL=${map} */`, null],
      [`a{}\n/*# sourceMappingURL= */ data: */`, null],
      [`a{}\n/*# sourceMappingURL=dat*/`, null],
      [`a{}\n/*# sourceMappingURL=stili.css.map */`, null],
    ] as const;
    const kept = [
      // Anywhere but on its own line at the end, in a string, or the first of two: the sheet stops at its line, as review
      // 7 did.
      [`/*# sourceMappingURL=${map} */\na{}`, 1],
      [`a{}\n/*# sourceMappingURL=${map} */\n/* fine */`, 2],
      [`a{}\n/*# sourceMappingURL=${map} */ b{}`, 2],
      [`a{}/*# sourceMappingURL=${map} */`, 1],
      [`@media screen/*# sourceMappingURL=${map} */and (min-width:1px){a{}}`, 1],
      [`a{} /*/*# sourceMappingURL=${map} */`, 1],
      [`a{}\n/*# sourceMappingURL=${map} */\n/*# sourceMappingURL=${map} */`, 2],
      [`a{content:"/*# sourceMappingURL=${map} */"}`, 1],
      [`a{} /* x */\nb{content:"/* # sourceMappingURL=${map} */"}`, 2],
      [`a{background:url(x.png /*# sourceMappingURL=${map} */`, 1],
      [`a{content:"x /*# sourceMappingURL=${map} */`, 1],
    ] as const;
    const read = (css: string) => prototype(1, () => "<p>x</p>").replace("</head>", () => `<style data-histos="selectors">${css}</style>\n<style data-histos="global" data-name="G">${css}</style>\n</head>`);
    for (const [css, expected] of stripped) {
      const parsed = parsePrototype(read(css));
      for (const sheet of [parsed.selectors!, parsed.globals[0]!.css]) {
        expect(sheet, css).toBe(expected ?? css);
        if (expected === null) expect(postcss.parse(sheet).source?.input.map, css).toBeUndefined();
        else expect(sheet, css).not.toContain("sourceMappingURL=data:");
      }
      if (expected === null) expect(parsed.warnings, css).toBeUndefined();
      else {
        // The line of the comment's `/*`: the selector styles open on line 3, the global sheet on the line their end tag is.
        const line = 3 + css.slice(0, css.lastIndexOf("/*")).split("\n").length - 1;
        const sheetLine = line + css.split("\n").length;
        const warning = `tolto il source map incorporato (/*# sourceMappingURL=data:… */), che al sito pubblicato non serve.`;
        expect(parsed.warnings, css).toEqual([`Il foglio globale «G», riga ${sheetLine}: ${warning}`, `Gli stili per selettore, riga ${line}: ${warning}`]);
      }
    }
    for (const [css, line] of kept) {
      // Each sheet on its own, opening on line 3: the refusal names it and the line of the map.
      for (const [style, where] of [['<style data-histos="selectors">', "Gli stili per selettore"], ['<style data-histos="global" data-name="G">', "Il foglio globale «G»"]]) {
        const html = prototype(1, () => "<p>x</p>").replace("</head>", () => `${style}${css}</style>\n</head>`);
        expect(() => parsePrototype(html), css).toThrow(new RegExp(`^${where}, riga ${2 + line}: un source map incorporato`, "u"));
      }
    }
    // One backwards look: 1 MB and 4 MB of short maps with no line feed (review 8 took 0.7 s for 1 MB, 37 s for 10 MB:
    // quadratic) are refused at once, and so is a sheet that ends with 1 MB of spaces after its map, or whose map holds
    // 1 MB of spaces, or whose map follows 1 MB of spaces.
    const short = "/*# sourceMappingURL=data:x */";
    const sheets = [short.repeat(1_000_000 / short.length), `${short.repeat(1_000_000 / short.length)}\n`, short.repeat(4_000_000 / short.length)];
    sheets.push(`a{}\n/*# sourceMappingURL=${map} */${" ".repeat(1_000_000)}`, `a{}\n/*${" ".repeat(1_000_000)}# sourceMappingURL=${map} */`, `${" ".repeat(1_000_000)}/*# sourceMappingURL=${map} */`);
    for (const css of sheets) {
      const started = performance.now();
      let parsed: ReturnType<typeof parsePrototype> | undefined;
      try {
        parsed = parsePrototype(prototype(1, () => "<p>x</p>").replace("</head>", () => `<style data-histos="global" data-name="G">${css}</style>\n</head>`));
      } catch (error) {
        expect((error as Error).message).toMatch(/^Il foglio globale «G»(, riga 3: un source map incorporato| supera 1 MB di CSS)/u);
      }
      expect(performance.now() - started, css.slice(0, 40)).toBeLessThan(1_500);
      if (parsed) expect(parsed.globals[0]!.css).not.toContain("sourceMappingURL");
    }
  });

  it("i fogli reali stanno lontani dalla memoria che un foglio può tenere (review 6)", () => {
    const bound = 384 * 1024 * 1024;
    // The package's own sheets (Histeon CSS, its tokens, the Core Framework fixture), scaled to 3 MB: each holds less
    // than a third of the bound (the densest of 560 real sheets measured, 122 MB at 3 MB, too).
    for (const file of ["../assets/histos-css/histos.css", "../assets/histos-css/xb-tokens.css", "./fixtures/core-framework-css-1.1.0-default.min.css"]) {
      const css = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(cssParseHeap(cssParseCost(css)) * ((3 * 1024 * 1024) / css.length), file).toBeLessThan(bound / 3);
    }
    // A utility sheet the size of Tailwind's full build, 3 MB: every color, shade, spacing and state, at every breakpoint.
    const colors = ["slate", "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "stone"];
    const utilities: string[] = [];
    for (const [i, color] of colors.entries()) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        const rgb = `${(i * 37 + shade) % 256} ${(i * 53 + shade) % 256} ${(i * 19 + shade) % 256}`;
        for (const [prefix, property] of [["text", "color"], ["bg", "background-color"], ["border", "border-color"]]) {
          for (const state of ["", "hover\\:", "focus\\:", "active\\:", "disabled\\:", "visited\\:", "checked\\:"]) utilities.push(`.${state}${prefix}-${color}-${shade}${state ? `:${state.slice(0, -2)}` : ""} {\n  --tw-${prefix}-opacity: 1;\n  ${property}: rgb(${rgb} / var(--tw-${prefix}-opacity));\n}\n`);
        }
        utilities.push(`.divide-${color}-${shade} > :not([hidden]) ~ :not([hidden]) {\n  --tw-divide-opacity: 1;\n  border-color: rgb(${rgb} / var(--tw-divide-opacity));\n}\n`);
      }
    }
    const block = utilities.join("\n");
    let sheet = block;
    for (const [screen, width] of [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536], ["3xl", 1920]] as const) {
      if (sheet.length >= 3 * 1024 * 1024) break;
      sheet += `\n@media (min-width: ${width}px) {\n${block.replace(/^\./gmu, `  .${screen}\\:`)}}\n`;
    }
    expect(sheet.length).toBeGreaterThan(3 * 1024 * 1024);
    const cost = cssParseCost(sheet);
    expect(cost.nodes).toBeGreaterThan(75_000);
    expect(cssParseHeap(cost)).toBeLessThan(bound / 3);
  });

  it("un foglio reale resta lontano dai limiti", () => {
    // 4,000 rules of a realistic shape, 2.2 MB: a twentieth of the bounds, scaled to 8 MiB well within them.
    const rule = (index: number) => `.blocco-${index} { display: flex; gap: var(--space-m); padding: 2rem 1.5rem; color: var(--text-dark); background: url("asset:sfondo") center / cover no-repeat;\n  &:hover { color: var(--primary); transform: translateY(-2px); }\n  & .titolo { font-size: var(--h3); line-height: 1.2; }\n  @media (max-width: 48rem) { padding: 1rem; }\n}`;
    const css = Array.from({ length: 4_000 }, (_, index) => rule(index)).join("\n");
    const cost = cssParseCost(css);
    const scale = (8 * 1024 * 1024) / css.replace(/\s/gu, "").length;
    expect(cost.topRules).toBe(4_000);
    expect(cost.nodes * scale).toBeLessThan(500_000);
    expect(cost.words * scale).toBeLessThan(1_000_000);
    expect(cost.run).toBeLessThan(100);
    expect(cost.lines * scale).toBeLessThan(1_000_000);
  });
});
