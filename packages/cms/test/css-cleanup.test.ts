import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { cleanupCss, cssDesignParameters } from "../src/css-cleanup.js";

describe("CSS ripulito (B4)", () => {
  it("una regola per classe con stati, discendenti e @media annidati; il resto resta globale", () => {
    const css = `:root{--x:1px}
@font-face{font-family:F;src:url("asset:f")}
body{font-family:"Inter",sans-serif;color:#222}
h1{font-family:Georgia,serif}
.card{padding:1rem;color:#c83c28}
.card:hover{color:#1a5fb4}
.card .titolo{font-size:32px}
.card, .box{margin:0}
.card{padding:1rem}
.mai-usata{color:red}
@media (width < 48rem){.card{padding:.5rem} header{display:none}}
@keyframes on{from{opacity:0}to{opacity:1}}
a{color:#c83c28}
.btn{color:#c83c28 !important}`;
    const result = cleanupCss({ sheets: [{ name: "site.css", css }], usedClasses: new Set(["card", "btn", "box"]) });
    const selectors = postcss.parse(result.selectors);
    const keys = selectors.nodes.map((node) => (node.type === "rule" ? node.selector : ""));
    // planSheetMove (doc 18 §6.5): a rule shared by two blocks stays in the sheet, in its place.
    expect(keys).toEqual([".card", ".btn"]);
    const card = result.selectors.slice(result.selectors.indexOf(".card {"), result.selectors.indexOf(".btn {"));
    expect(card).toContain("&:hover {");
    expect(card).toContain("& .titolo {");
    expect(card).toContain("@media (width < 48rem) {");
    // Two rules that are not the same rule both stay, in their order: the cascade is unchanged.
    expect(card.match(/padding:\s?1rem;/gu)?.length).toBe(2);
    const globals = result.globals.map((sheet) => sheet.css).join("\n");
    for (const kept of [":root", "@font-face", "body{", "h1{", "@keyframes", "header{display:none}", "a{color:#c83c28}"]) expect(globals).toContain(kept);
    expect(globals).toMatch(/\.card,\s*\.box\{margin:0\}/u);
    expect(globals).not.toContain(".card{");
    expect(result.selectors).not.toContain("mai-usata");
    expect(result.design).toEqual({ primary: "#c83c28", secondary: "#1a5fb4", font_body: "Inter", font_heading: "Georgia" });
    expect(result.notes.join("\n")).toMatch(/1 regola di una classe che nessuna pagina usa tolta/u);
    expect(result.notes.join("\n")).toMatch(/!important/u);
    expect(result.notes.join("\n")).toMatch(/font-size: 32px/u);
  });

  it("una parte BEM seguita da una regola del blocco resta nel foglio, e la voce corrente tiene il suo fondo", () => {
    // compileCss stampa prima `& a…` e poi ogni `&__parte`: la voce corrente, scritta dopo, perderebbe il suo fondo.
    // Dalla copia del builder di Histeon 0.5.14 planSheetMove lascia nel foglio la sola parte BEM (il foglio si stampa
    // prima di ogni voce): il resto del blocco va nel selettore e la guardia di selector-port.ts non trova più nulla.
    const css = `.nav{display:flex}
.nav__g:first-of-type a{background:#eee}
.nav a:hover{background:#ddd}
.nav a[aria-current=page]{background:gold}
.card{padding:1rem}
.card__title{margin:0}`;
    const result = cleanupCss({ sheets: [{ name: "site.css", css }], usedClasses: new Set(["nav", "nav__g", "card", "card__title"]) });
    const keys = postcss.parse(result.selectors).nodes.map((node) => (node.type === "rule" ? node.selector : ""));
    expect(keys).toEqual([".nav", ".card"]);
    const globals = result.globals.map((sheet) => sheet.css).join("\n");
    expect(globals).toBe(".nav__g:first-of-type a{background:#eee}");
    expect(result.selectors.indexOf("& a[aria-current=page] {")).toBeGreaterThan(result.selectors.indexOf("& a:hover {"));
    expect(result.selectors).not.toContain("&__g");
    expect(result.notes.join("\n")).not.toMatch(/resta nel foglio/u);
  });

  it("una variante scritta prima di una regola del blocco resta nel foglio con ciò che la precede; nomi BEM diversi no", () => {
    const turned = cleanupCss({ sheets: [{ name: "site.css", css: `.btn{padding:1rem}\n.btn--big{padding:2rem}\n@media (width < 40rem){.btn{padding:.5rem}}` }], usedClasses: new Set(["btn", "btn--big"]) });
    // La regola nella media query, scritta dopo la variante, va nel selettore, che si stampa dopo il foglio.
    expect(turned.selectors).toContain("@media (width < 40rem) {");
    expect(turned.selectors).not.toContain("&--big");
    expect(turned.globals.map((sheet) => sheet.css).join("\n")).toBe(".btn{padding:1rem}\n.btn--big{padding:2rem}");
    expect(turned.notes.join("\n")).not.toMatch(/resta nel foglio/u);
    // `.card__title` e `.card` sono due elementi, e `::before` è un'altra scatola: la guardia di Publish non terrebbe
    // il blocco. planSheetMove del builder guarda solo peso e famiglia delle proprietà (`margin` contro `margin`,
    // `color` contro `color`), e lascia nel foglio le due parti BEM: più prudente, con la stessa cascata.
    const moved = cleanupCss({ sheets: [{ name: "site.css", css: `.card__title{margin:0;color:red}\n.card__mark::before{color:red}\n@media (width < 40rem){.card{margin:1rem}}\n.card a{color:blue}\n.card span{margin:2px}` }], usedClasses: new Set(["card", "card__title", "card__mark"]) });
    expect(moved.globals.map((sheet) => sheet.css).join("\n")).toBe(".card__title{margin:0;color:red}\n.card__mark::before{color:red}");
    expect(moved.selectors).toContain("& a {");
    expect(moved.selectors).not.toContain("&__title {");
    expect(moved.notes.join("\n")).not.toMatch(/resta nel foglio/u);
  });

  it("un foglio che non è CSS resta com'era", () => {
    const result = cleanupCss({ sheets: [{ name: "rotto.css", css: ".a{color:red" }], usedClasses: new Set(["a"]) });
    expect(result.globals).toEqual([{ name: "rotto.css", css: ".a{color:red" }]);
    expect(result.notes.join("\n")).toMatch(/1 foglio non leggibile come CSS lasciato com.era/u);
  });
});

describe("token di Histeon CSS a scelta (B4)", () => {
  const css = `body{font-family:"Inter",sans-serif;color:#222}
h1{font-family:Georgia,serif;font-size:52px}
.card{color:#c83c28;border:1px solid #C83C28;font-size:1.1rem;padding:1.4rem 14px 0;margin:2rem}
.card:hover{color:#1a5fb4}
.small{font-size:14px}
.huge{font-size:120px}
@font-face{font-family:Inter;src:url("asset:inter")}
a{color:#c83c28}`;

  it("senza la scelta i valori restano com'erano", () => {
    const result = cleanupCss({ sheets: [{ name: "s.css", css }], usedClasses: new Set(["card", "small", "huge"]) });
    expect([result.selectors, ...result.globals.map((sheet) => sheet.css)].join("\n")).not.toContain("var(--xb-");
  });

  it("con la scelta colori, caratteri e misure diventano token; @font-face resta", () => {
    const result = cleanupCss({ sheets: [{ name: "s.css", css }], usedClasses: new Set(["card", "small", "huge"]), tokens: true });
    const all = [result.selectors, ...result.globals.map((sheet) => sheet.css)].join("\n").replaceAll(": ", ":");
    expect(all).toContain("color:var(--xb-primary)");
    expect(all).toContain("1px solid var(--xb-primary)");
    expect(all).toContain("color:var(--xb-secondary)");
    expect(all).toContain("a{color:var(--xb-primary)}");
    expect(all).toContain("font-family:var(--xb-font-body)");
    expect(all).toContain("font-family:var(--xb-font-heading)");
    expect(all).toContain("font-size:var(--xb-text-4xl)");
    expect(all).toContain("font-size:var(--xb-text-m)");
    expect(all).toContain("font-size:var(--xb-text-s)");
    // Far from every step of the scale: it stays.
    expect(all).toContain("font-size:120px");
    expect(all).toContain("@font-face{font-family:Inter;");
    expect(result.design).toEqual({ primary: "#c83c28", secondary: "#1a5fb4", font_body: "Inter", font_heading: "Georgia" });
    // Doc 18 §6.4.1: within a twentieth of the token at 1280 px; 2rem (32 px) is between space-m and space-l, and stays.
    expect(all).toContain("padding:var(--xb-space-m) var(--xb-space-s) 0");
    expect(all).toContain("margin:2rem");
    expect(result.notes.join("\n")).toMatch(/token di Histeon CSS al posto dei valori: 4 colori, 2 caratteri, 3 misure di testo, 2 spazi/u);
    expect(cssDesignParameters(result)).toEqual({ primary: "#c83c28", secondary: "#1a5fb4", font_body: '"Inter",sans-serif', font_heading: "Georgia,serif" });
  });

  it("con Automatic.css scrive le sue variabili, e lascia i valori che non hanno un nome ACSS", () => {
    const result = cleanupCss({ sheets: [{ name: "s.css", css }], usedClasses: new Set(["card", "small", "huge"]), framework: "acss" });
    const all = [result.selectors, ...result.globals.map((sheet) => sheet.css)].join("\n").replaceAll(": ", ":");
    expect(all).toContain("color:var(--primary)");
    expect(all).toContain("padding:var(--space-m) var(--space-s) 0");
    expect(all).toContain("font-size:var(--text-m)");
    // The text step 4xl and the fonts have no ACSS name: the values stay.
    expect(all).toContain("font-size:52px");
    expect(all).toContain('font-family:"Inter",sans-serif');
    expect(all).not.toContain("--xb-");
    expect(result.notes.join("\n")).toMatch(/variabili di Automatic\.css al posto dei valori/u);
  });

  it("non mette il token dei caratteri dove la proposta non porta quel carattere (V5.3b)", () => {
    // The body's font through a variable: it is no font name, the proposal leaves it out, so the value must stay.
    const viaVariable = `@font-face{font-family:Manrope;src:url("asset:manrope") format("woff2")}
:root{--famiglia:Manrope, sans-serif}
body{font-family:var(--famiglia);color:#c83c28}
h1{font-family:inherit}`;
    const first = cleanupCss({ sheets: [{ name: "s.css", css: viaVariable }], usedClasses: new Set(), framework: "histos-css" });
    const all = first.globals.map((sheet) => sheet.css).join("\n").replaceAll(": ", ":");
    expect(all).toContain("body{font-family:var(--famiglia)");
    expect(all).toContain("h1{font-family:inherit}");
    expect(all).not.toContain("--xb-font-");
    expect(first.design.font_body).toBeUndefined();
    expect(first.design.font_heading).toBeUndefined();
    // A name Histeon CSS cannot write stays a name too, instead of a token that would show another font.
    const odd = cleanupCss({ sheets: [{ name: "s.css", css: 'body{font-family:"Font_Uno", sans-serif}\n.x{font-family:"Font_Uno"}' }], usedClasses: new Set(["x"]), framework: "histos-css" });
    expect([odd.selectors, ...odd.globals.map((sheet) => sheet.css)].join("\n")).not.toContain("--xb-font-");
  });

  it("lascia fuori dalla proposta ciò che Histeon CSS non sa scrivere", () => {
    expect(cssDesignParameters({ design: { primary: "#c83c28", font_body: "Strana{font}" }, fontStacks: { body: "Strana{font}, sans-serif" } })).toEqual({ primary: "#c83c28" });
  });
});

describe("CSS ripulito su fogli enormi (review B1, 2° giro)", () => {
  it("una classe con decine di migliaia di dichiarazioni: lineare e senza stack overflow", () => {
    const many = Array.from({ length: 130_000 }, (_, index) => `b:${index % 7}`).join(";");
    const started = Date.now();
    const one = cleanupCss({ sheets: [{ name: "s.css", css: `.a{${many}}` }], usedClasses: new Set(["a"]) });
    expect(one.selectors).toMatch(/b:\s?6;/u);
    const rules = ".a{b:0}\n".repeat(96_000);
    const merged = cleanupCss({ sheets: [{ name: "s.css", css: rules }], usedClasses: new Set(["a"]) });
    expect(merged.selectors.match(/b:\s?0;/gu)?.length).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe("doc 28: valori esatti di una proposta fotografata", () => {
  const css = `body{font-family:"Inter", sans-serif;font:400 18px/1.55 "Inter", sans-serif}
h1{font-size:clamp(46px,5.4vw,80px)}
h2{font-size:clamp(46px, 6vw, 80px)}
h3{font-size:calc(1rem + 2vw)}
.card{font-size:17px;padding:14px 22px;margin:-4px 0 1.5rem;gap:14px;color:#c83c28}
.small{font-size:.85rem;font:inherit}
.note{font-size:1.2em;padding:var(--pad) 6%}
.label{font:700 13px/1 var(--sans);font-size:var(--label)}
.dead{font-size:99px;padding:77px}
@font-face{font-family:Inter;src:url("asset:inter");font-size:12px}`;
  const used = new Set(["card", "small", "note", "label"]);
  const run = (framework: "histos-css" | "acss" | "core" | "none" = "histos-css") => {
    const result = cleanupCss({ sheets: [{ name: "s.css", css }], usedClasses: used, framework, exact: true });
    return { result, all: [result.selectors, ...result.globals.map((sheet) => sheet.css)].join("\n").replaceAll(": ", ":") };
  };

  it("le misure scritte a mano diventano variabili del sito con il loro valore", () => {
    const { result, all } = run();
    expect(result.siteTokens).toEqual({
      "spazio-1-5rem": "1.5rem",
      "spazio-14": "14px",
      "spazio-22": "22px",
      "testo-0-85rem": "0.85rem",
      "testo-13": "13px",
      "testo-17": "17px",
      "testo-18": "18px",
      "testo-da-46-a-80": "clamp(46px, 5.4vw, 80px)",
      "testo-da-46-a-80-b": "clamp(46px, 6vw, 80px)",
      "testo-misura-1": "calc(1rem + 2vw)",
    });
    expect(all).toContain("font-size:var(--xb-site-testo-17)");
    expect(all).toContain("padding:var(--xb-site-spazio-14) var(--xb-site-spazio-22)");
    expect(all).toContain("margin:-4px 0 var(--xb-site-spazio-1-5rem)");
    expect(all).toContain("gap:var(--xb-site-spazio-14)");
    expect(all).toContain("font-size:var(--xb-site-testo-da-46-a-80)");
    expect(all).toContain("font-size:var(--xb-site-testo-da-46-a-80-b)");
    expect(all).toContain("font-size:var(--xb-site-testo-misura-1)");
    expect(all).toContain("font-size:var(--xb-site-testo-0-85rem)");
  });

  it("la scorciatoia font cambia la sola misura", () => {
    const { all } = run();
    expect(all).toContain('font:400 var(--xb-site-testo-18)/1.55 "Inter", sans-serif');
    expect(all).toContain("font:700 var(--xb-site-testo-13)/1 var(--sans)");
    expect(all).toContain("font:inherit");
  });

  it("nessuna misura va sui passi fluidi, e nessun testo resta con una lunghezza fissa", () => {
    const { all } = run();
    expect(all).not.toMatch(/var\(--xb-(?:text|space)-/u);
    const fixed = [...all.matchAll(/(?:^|[;{\s])font(?:-size)?:([^;}]+)/gu)].map((match) => match[1] ?? "").filter((value) => /\d(?:px|rem)\b/u.test(value.replace(/var\(--[\w-]+\)/gu, "")));
    // What is left is @font-face, which is not a rule of an element.
    expect(fixed).toEqual(["12px"]);
  });

  it("ciò che è già una variabile, relativo o di una classe che nessuno usa resta fuori", () => {
    const { result, all } = run();
    expect(all).toContain("font-size:1.2em");
    expect(all).toContain("padding:var(--pad) 6%");
    expect(all).toContain("font-size:var(--label)");
    expect(Object.values(result.siteTokens ?? {})).not.toContain("99px");
    expect(Object.values(result.siteTokens ?? {})).not.toContain("77px");
    expect(result.notes.join("\n")).toMatch(/^misure scritte a mano tenute esatte come variabili del sito: 7 misure di testo .*, 3 spazi/mu);
  });

  it("colori e caratteri vanno sui token come senza la scelta", () => {
    const { all } = run();
    expect(all).toContain("color:var(--xb-primary)");
  });

  it("senza framework e con Core niente cambia; con ACSS i nomi delle variabili del sito sono gli stessi", () => {
    expect(run("none").result.siteTokens).toBeUndefined();
    expect(run("none").all).toContain("font-size:17px");
    expect(run("core").result.siteTokens).toBeUndefined();
    expect(run("acss").all).toContain("font-size:var(--xb-site-testo-17)");
  });

  it("senza exact la conversione è quella di prima", () => {
    const before = cleanupCss({ sheets: [{ name: "s.css", css }], usedClasses: used, framework: "histos-css" });
    expect(before.siteTokens).toBeUndefined();
    expect([before.selectors, ...before.globals.map((sheet) => sheet.css)].join("\n")).not.toContain("--xb-site-");
  });

  it("oltre 200 variabili: prima i testi, poi gli spazi più usati; il resto resta un numero con una nota", () => {
    const many = [
      ...Array.from({ length: 150 }, (_, index) => `.t${index}{font-size:${index + 10}px}`),
      ...Array.from({ length: 80 }, (_, index) => `.s${index}{padding:${index + 1}px}`),
      ".s0b{margin:1px}.s79b{margin:80px}.s79c{gap:80px}",
    ].join("\n");
    const names = new Set([...Array.from({ length: 150 }, (_, index) => `t${index}`), ...Array.from({ length: 80 }, (_, index) => `s${index}`), "s0b", "s79b", "s79c"]);
    const result = cleanupCss({ sheets: [{ name: "s.css", css: many }], usedClasses: names, framework: "histos-css", exact: true });
    const tokens = result.siteTokens ?? {};
    expect(Object.keys(tokens)).toHaveLength(200);
    expect(Object.keys(tokens).filter((name) => name.startsWith("testo-"))).toHaveLength(150);
    expect(tokens["spazio-80"]).toBe("80px");
    expect(tokens["spazio-1"]).toBe("1px");
    expect(result.notes.join("\n")).toContain("30 misure restano numeri: le variabili del sito sono al massimo 200");
  });

  it("un valore che le variabili del sito non accettano resta com'era", () => {
    const odd = cleanupCss({ sheets: [{ name: "s.css", css: ".x{font-size:calc(10px + env(safe-area-inset-top, 4px))}\n.y{font-size:max(12px, 1vw)}" }], usedClasses: new Set(["x", "y"]), framework: "histos-css", exact: true });
    expect(Object.values(odd.siteTokens ?? {})).toEqual(["calc(10px + env(safe-area-inset-top, 4px))", "max(12px, 1vw)"]);
  });
});
