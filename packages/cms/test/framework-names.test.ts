import { computeHistosTokens } from "../src/histos-design.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { XbBlock } from "../.generated/histos-dsl/index.js";
import { ACSS_CLASSES, ACSS_VARIABLES, collectCssNames, convertAcssVariables, definedVariablesIn, emptyFrameworkNames, frameworkNamesInBlocks, frameworkNameWarnings, isAcssClass } from "../src/framework-names.js";
import { histosFrameworkData, histosTokenNames } from "../src/histos-css.js";
import { HISTOS_ACSS_MAP } from "../src/histos-css-assets.generated.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { rewriteInlineMarkupAttributes } from "../src/transfer-markup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function build(html: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-framework-names-"));
  roots.push(root);
  return buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root));
}

const fixture = () => readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");

/** The example prototype with an ACSS page, sheet and selector style. */
async function acssPrototype(manifest: string) {
  return (await fixture())
    .replace('"framework": "histos-css"', manifest)
    .replace(":root { --carta: #f6f1e7; }", ":root { --carta: #f6f1e7; --accent: #b0306a; }\n.hero { padding-block: var(--section-space-l); color: var(--accent); }\n.text--xl { font-size: 3rem; }")
    .replace(".opera {\n  padding: 1rem;", ".opera {\n  padding: var(--space-s, 1rem);\n  border-radius: var(--radius-m);")
    .replace('<section class="hero"><h1>Studio Ehi</h1><p>Quadretti, libri, racconti.</p></section>', '<section class="hero"><h1 class="text--xl">Studio Ehi</h1><p class="text--l text--primary-dark btn--primary" style="margin-block: var(--space-m)">Quadretti, <strong class="text--s">libri</strong>, racconti.</p></section>');
}

/** A page's serialized blocks, with the JSON escapes of "-" and "&" undone for reading. */
const page = (built: Awaited<ReturnType<typeof build>>, slug: string) => String(built.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === slug)?.payload.content ?? "").replaceAll("\\u002d", "-").replaceAll("\\u0026", "&");
const styles = (built: Awaited<ReturnType<typeof build>>) => JSON.stringify(built.profile.entities.find((entity) => entity.kind === "styles")?.payload ?? {});

describe("nomi dei framework (C1, C2)", () => {
  it("la tabella ACSS è quella del builder e punta solo a token e classi che Histeon CSS ha", () => {
    // 82 correspondences, as AcssImport::tokens() (scripts/check-acss-map.mjs checks them against the builder).
    expect(Object.keys(HISTOS_ACSS_MAP.tokens)).toHaveLength(82);
    expect(Object.keys(HISTOS_ACSS_MAP.classes)).toHaveLength(47);
    // The tertiary family is off by default: its tokens exist once it is on (an ACSS import with a tertiary switches it on).
    const tokens = new Set([...histosTokenNames(), ...Object.keys(computeHistosTokens({ tertiary_on: 1 }))]);
    for (const token of Object.keys(HISTOS_ACSS_MAP.tokens)) expect(tokens.has(token), token).toBe(true);
    const classes = new Set(histosFrameworkData().classes.map((entry) => entry.name));
    for (const name of ACSS_CLASSES.values()) expect(classes.has(name), name).toBe(true);
    expect(ACSS_VARIABLES.get("primary-dark")).toBe("xb-primary-800");
    expect(ACSS_VARIABLES.get("section-space-l")).toBe("xb-section-l");
    expect(ACSS_CLASSES.get("text--primary-dark")).toBe("xb-color-primary-800");
    expect(isAcssClass("btn--primary")).toBe(true);
    // A BEM modifier of the author's own block is not ACSS.
    expect(isAcssClass("card--featured")).toBe(false);
  });

  it("converte le variabili solo nei valori, mai in stringhe e commenti, e lascia quelle che il prototipo definisce", () => {
    const conversions = new Map();
    const css = 'a { color: var(--primary-dark); content: "var(--primary)"; /* var(--space-m) */ margin: var( --space-m , 1rem) var(--gap); padding: var(--accent); }';
    const out = convertAcssVariables(css, new Set(["accent"]), conversions);
    expect(out).toBe('a { color: var(--xb-primary-800); content: "var(--primary)"; /* var(--space-m) */ margin: var( --xb-space-m , 1rem) var(--gap); padding: var(--accent); }');
    expect([...conversions.keys()]).toEqual(["--primary-dark", "--space-m"]);
    // An escaped or longer name is another name.
    expect(convertAcssVariables("a{b:var(--primary-darker);c:var(--primary\\2d dark)}", new Set(), new Map())).toBe("a{b:var(--primary-darker);c:var(--primary\\2d dark)}");
  });

  it("una variabile dentro il valore di riserva di un'altra non manca", () => {
    const names = emptyFrameworkNames();
    collectCssNames(names, "a { color: var(--a, var(--b)); margin: var(--c); --d: 1px; padding: var(--d); }", "foglio");
    expect([...names.variables.keys()]).toEqual(["c", "d"]);
    expect(names.definedVariables.has("d")).toBe(true);
  });

  it("un prototipo ACSS diventa Histeon CSS: classi e variabili convertite, i nomi del prototipo tenuti, il resto segnalato", async () => {
    const built = await build(await acssPrototype('"framework": "acss"'));
    const home = page(built, "home");
    expect(home).toContain('"class":"xb-text-l xb-color-primary-800 btn--primary"');
    expect(home).toContain('"style":"margin-block: var(--xb-space-m)"');
    // Inline elements too (the inline markup of a text run is covered below).
    expect(home).toContain('"tag":"strong","attributes":{"class":"xb-text-s"}');
    // A class with a rule in the prototype is the author's.
    expect(home).toContain('"class":"text--xl"');
    const css = styles(built);
    expect(css).toContain("padding-block: var(--xb-section-l)");
    expect(css).toContain("padding: var(--xb-space-s, 1rem)");
    expect(css).toContain("border-radius: var(--xb-radius-m)");
    // --accent is defined by the prototype: its value stays the prototype's.
    expect(css).toContain("color: var(--accent)");
    const warnings = built.report.warnings.join("\n");
    expect(warnings).toMatch(/ACSS → Histeon CSS: \d+ nomi convertiti \(.*\.text--l → \.xb-text-l/u);
    expect(warnings).toMatch(/tenuti 2 nomi che il prototipo definisce da sé \(--accent, \.text--xl\)/u);
    // Doc 23 item 240: what the import did on purpose is a note, not a warning.
    expect(warnings).toMatch(/^Nota: ACSS → Histeon CSS: /mu);
    expect(warnings).toMatch(/^Nota: ACSS: tenuti 2 nomi che il prototipo definisce da sé/mu);
    expect(warnings).toMatch(/Classi ACSS senza regola: btn--primary \(page home\)\./u);
    expect(warnings).not.toMatch(/Variabili senza valore/u);
  });

  it("con acss: keep i nomi restano ACSS e il rapporto dice che servono i fogli del sito", async () => {
    const built = await build(await acssPrototype('"framework": "acss", "acss": "keep"'));
    const home = page(built, "home");
    expect(home).toContain('"class":"text--l text--primary-dark btn--primary"');
    expect(home).toContain('"style":"margin-block: var(--space-m)"');
    const warnings = built.report.warnings.join("\n");
    expect(warnings).not.toMatch(/ACSS → Histeon CSS/u);
    expect(warnings).toMatch(/ACSS tenuto \(acss: keep\): \d+ nomi restano senza valore o regola finché non importi i fogli che ACSS genera sul sito/u);
    expect(warnings).toContain("--space-m");
    expect(warnings).toContain(".btn--primary");
  });

  it("un prototipo Histeon CSS con nomi ACSS o variabili senza valore li segnala con il nome giusto", async () => {
    const built = await build(await acssPrototype('"framework": "histos-css"'));
    const warnings = built.report.warnings.join("\n");
    expect(warnings).toMatch(/Variabili senza valore: .*--radius-m \(stili per selettore\) → in Histeon CSS --xb-radius-m/u);
    expect(warnings).toMatch(/--space-m \(page home\) → in Histeon CSS --xb-space-m/u);
    // A var() with a fallback is not missing.
    expect(warnings).not.toMatch(/--space-s \(/u);
    expect(warnings).toMatch(/Classi ACSS senza regola: .*text--l \(page home\) → in Histeon CSS xb-text-l/u);
    // Nothing is renamed without framework acss.
    expect(page(built, "home")).toContain('"class":"text--l text--primary-dark btn--primary"');
  });

  it("il manifest accetta acss solo con framework acss e solo convert o keep", async () => {
    const html = await fixture();
    expect(() => parsePrototype(html.replace('"framework": "histos-css"', '"framework": "histos-css", "acss": "keep"'))).toThrow(/acss vale solo con framework "acss"/u);
    expect(() => parsePrototype(html.replace('"framework": "histos-css"', '"framework": "acss", "acss": "sì"'))).toThrow(/"convert" o "keep"/u);
  });

  it("riscrive gli attributi del markup inline come lo legge il controllo, e solo dove può", () => {
    const upper = (_tag: string, name: string, value: string) => (name === "class" ? value.toUpperCase() : value);
    expect(rewriteInlineMarkupAttributes('a <em class="x y" title=\'t\'>b</em> {props.c} <strong class=\'z\'>d</strong>', upper)).toBe('a <em class="X Y" title=\'t\'>b</em> {props.c} <strong class=\'Z\'>d</strong>');
    // An expression that contains a tag-like text is skipped.
    expect(rewriteInlineMarkupAttributes('{a < b ? "<em class=\\"x\\">" : ""} <em class="x">y</em>', upper)).toBe('{a < b ? "<em class=\\"x\\">" : ""} <em class="X">y</em>');
    // Unreadable markup comes back as it was, for the check to refuse.
    expect(rewriteInlineMarkupAttributes('<em class=x>y</em>', upper)).toBe('<em class=x>y</em>');
    // A new value that would close the attribute is not written.
    expect(rewriteInlineMarkupAttributes('<em class="x">y</em>', () => 'x" onclick="z')).toBe('<em class="x">y</em>');
  });

  it("le segnalazioni restano brevi con molti nomi", () => {
    const names = emptyFrameworkNames();
    for (let index = 0; index < 50; index++) collectCssNames(names, `a{b:var(--manca-${index})}`, `foglio ${index}`);
    const [warning] = frameworkNameWarnings(names, { framework: "histos-css" });
    expect(warning).toMatch(/e altri 42\. Nessun foglio/u);
  });

  it("legge definizioni, riferimenti e selettori in tempo lineare, anche con lunghe file di trattini", () => {
    // Before: a backtracking regex, quadratic on a run of "-" (seconds for 100k, minutes for 1 MB) and synchronous.
    const defined = new Set<string>();
    let started = performance.now();
    definedVariablesIn(`<p>${"-".repeat(100_000)}</p><p>${"--a".repeat(30_000)}</p><p style="--ok: 1">x</p>`, defined);
    expect(performance.now() - started).toBeLessThan(500);
    expect([...defined]).toEqual(["ok"]);
    started = performance.now();
    const names = emptyFrameworkNames();
    collectCssNames(names, `a{b:${"-".repeat(100_000)};c:var(${"--a".repeat(30_000)});d:url(${"/*".repeat(30_000)})}`, "foglio");
    // Nesting multiplies selectors (4^40 here): past a budget the deeper rules are not read, and nothing overflows the stack.
    collectCssNames(names, `${".a,.b{&__x,&__y{".repeat(40)}color:red${"}".repeat(80)}`, "stili per selettore");
    collectCssNames(names, `.e{${"&__x,&__y{".repeat(60)}color:red${"}".repeat(61)}`, "stili per selettore");
    collectCssNames(names, `${"@media (x){".repeat(5_000)}.c{color:red}${"}".repeat(5_000)}`, "foglio");
    collectCssNames(names, `${":is(".repeat(20_000)}.d${")".repeat(20_000)}{color:red}`, "foglio");
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(names.ruleClasses.has("a__x")).toBe(false);
    expect(names.selectorClasses.has("a__x")).toBe(true);
  });

  it("una parte BEM annidata negli stili per selettore ha la regola che Histeon compila (&--l → .text--l)", async () => {
    const html = (await fixture())
      .replace(".opera {\n  padding: 1rem;", ".btn { padding: 1rem; &--primary { color: red; } }\n.text { line-height: 1.4; &--l { font-size: 3rem; color: hotpink; } }\n.opera {\n  padding: 1rem;")
      .replace("<h1>Studio Ehi</h1>", '<h1 class="text text--l btn btn--primary">Studio Ehi</h1>');
    // Histeon CSS: btn--primary has its rule (.btn--primary{color:red}), so no warning tells to write another one.
    const histos = await build(html);
    expect(histos.report.warnings.join("\n")).not.toMatch(/Classi ACSS senza regola/u);
    // ACSS: text--l is the author's (its compiled rule must keep matching), not converted to xb-text-l.
    const acss = await build(html.replace('"framework": "histos-css"', '"framework": "acss"'));
    expect(page(acss, "home")).toContain('"class":"text text--l btn btn--primary"');
    const warnings = acss.report.warnings.join("\n");
    expect(warnings).toMatch(/ACSS: tenuto un nome che il prototipo definisce da sé \(\.text--l\)/u);
    expect(warnings).not.toMatch(/ACSS → Histeon CSS|Classi ACSS senza regola/u);
    // Every selector of both lists; a BEM part inside @media is a rule only at those widths.
    const names = emptyFrameworkNames();
    collectCssNames(names, ".a, .b { color: red; &__x, &--y { color: blue; } }\n.c { color: red; @media (width > 40em) { &--z { color: blue; } } }", "stili per selettore");
    expect([...names.ruleClasses].sort()).toEqual(["a", "a--y", "a__x", "b", "b--y", "b__x", "c"]);
    expect(names.selectorClasses.has("c--z")).toBe(true);
    // A global sheet reaches the browser as written: there &--x is no BEM part (it names an element), so no class.
    const sheet = emptyFrameworkNames();
    collectCssNames(sheet, ".text { line-height: 1.4; &--l { font-size: 3rem; } }", "foglio Base");
    expect([...sheet.ruleClasses]).toEqual(["text"]);
    expect(sheet.selectorClasses.has("text--l")).toBe(false);
  });

  it("una classe ACSS che i selettori nominano senza una regola tutta sua prende anche il nome Histeon CSS, e senza regola è segnalata", async () => {
    const rules = [".hero .text--primary { font-weight: 700; }", "a:not(.text--primary) { text-decoration: underline; }", ".text--primary:hover { text-decoration: underline; }", ".text--primary .icona { color: red; }", ".text--primary::after { content: '!'; }", "h1.text--primary { color: red; }", ".text--primary { &:hover { color: red; } }", "@media (width > 40em) { .text--primary { color: red; } }"];
    for (const rule of rules) {
      const html = (await fixture()).replace('"framework": "histos-css"', '"framework": "acss"').replace(":root { --carta: #f6f1e7; }", `:root { --carta: #f6f1e7; }\n${rule}`).replace("<h1>Studio Ehi</h1>", '<h1 class="text--primary">Studio Ehi</h1>');
      const built = await build(html);
      // Its ACSS value stays (as the Histeon CSS class) and the prototype's selectors keep matching.
      expect(page(built, "home"), rule).toContain('"class":"text--primary xb-color-primary"');
      const warnings = built.report.warnings.join("\n");
      expect(warnings, rule).not.toMatch(/definisce da sé|Classi ACSS senza regola/u);
      expect(warnings, rule).toMatch(/ACSS → Histeon CSS: un nome convertito \(\.text--primary → \.xb-color-primary\)/u);
      expect(warnings, rule).toMatch(/ACSS: una classe tiene anche il nome ACSS accanto a quello Histeon CSS \(\.text--primary con \.xb-color-primary\)/u);
    }
    // A rule of its own keeps the name alone, as before.
    const own = await build((await fixture()).replace('"framework": "histos-css"', '"framework": "acss"').replace(":root { --carta: #f6f1e7; }", ":root { --carta: #f6f1e7; }\n.text--primary, .altro { font-weight: 700; }").replace("<h1>Studio Ehi</h1>", '<h1 class="text--primary">Studio Ehi</h1>'));
    expect(page(own, "home")).toContain('"class":"text--primary"');
    expect(own.report.warnings.join("\n")).toMatch(/tenuto un nome che il prototipo definisce da sé \(\.text--primary\)/u);
    // C2, in any framework: an ACSS class named only as a context, in :not() or with a state has no rule of its own.
    for (const rule of [".btn--primary .icona { color: red; }", "a:not(.btn--primary) { color: red; }", ".btn--primary:focus-visible { outline: 2px solid; }"]) {
      const html = (await fixture()).replace(":root { --carta: #f6f1e7; }", `:root { --carta: #f6f1e7; }\n${rule}`).replace("<h1>Studio Ehi</h1>", '<h1 class="btn--primary">Studio Ehi</h1>');
      expect((await build(html)).report.warnings.join("\n"), rule).toMatch(/Classi ACSS senza regola: btn--primary \(page home\)\./u);
    }
    const names = emptyFrameworkNames();
    // [class~="otto"] is .otto (before: attribute selectors named nothing); any other attribute names no class.
    collectCssNames(names, ".x:is(.uno, .due) > .tre, :where(.quattro, .cinque .sei), *.sette, [class~=\"otto\"], .nove\\:dieci, [data-x~=\"dodici\"], [href*=\".tredici\"] { color: red; }", "foglio");
    expect([...names.ruleClasses].sort()).toEqual(["nove:dieci", "otto", "quattro", "sette"]);
    expect([...names.selectorClasses].sort()).toEqual(["cinque", "due", "nove:dieci", "otto", "quattro", "sei", "sette", "tre", "uno", "x"]);
  });

  it("legge i nomi non ASCII interi: niente nome troncato, convertito o segnalato per errore", () => {
    const conversions = new Map();
    const css = ":root{--accentò:#b0306a;--colore-più:red} h1{color:var(--accentò);background:var(--colore-più)}";
    expect(convertAcssVariables(css, new Set(), conversions)).toBe(css);
    expect(conversions.size).toBe(0);
    const names = emptyFrameworkNames();
    collectCssNames(names, css, "foglio Base");
    expect([...names.definedVariables].sort()).toEqual(["accentò", "colore-più"]);
    expect(frameworkNameWarnings(names, { framework: "histos-css" })).toEqual([]);
    const missing = emptyFrameworkNames();
    collectCssNames(missing, "a{color:var(--colore-più)}", "foglio Base");
    expect(frameworkNameWarnings(missing, { framework: "histos-css" }).join("\n")).toMatch(/Variabili senza valore: --colore-più \(foglio Base\)\./u);
    const defined = new Set<string>();
    definedVariablesIn('<p style="--accentò: red; --a\\62 : 1">x</p>', defined);
    expect([...defined].sort()).toEqual(["ab", "accentò"]);
  });

  it("una variabile registrata con @property è del prototipo: non si converte e non manca", async () => {
    const css = "@property --accent { syntax: '<color>'; inherits: true; initial-value: #b0306a; }\n@PROPERTY\n--primary /* registrata */ { syntax: '*'; inherits: false; }\n.hero { color: var(--accent); background: var(--primary); }";
    const names = emptyFrameworkNames();
    collectCssNames(names, css, "foglio Base");
    expect([...names.definedVariables].sort()).toEqual(["accent", "primary"]);
    expect(frameworkNameWarnings(names, { framework: "histos-css" })).toEqual([]);
    expect(convertAcssVariables(css, names.definedVariables, new Map())).toBe(css);
    const defined = new Set<string>();
    definedVariablesIn("<style>@property --accent{inherits:true}</style>", defined);
    expect([...defined]).toEqual(["accent"]);
    const built = await build((await fixture()).replace('"framework": "histos-css"', '"framework": "acss"').replace(":root { --carta: #f6f1e7; }", ":root { --carta: #f6f1e7; }\n@property --accent { syntax: '<color>'; inherits: true; initial-value: #b0306a; }\n.hero { color: var(--accent); }"));
    expect(styles(built)).toContain("color: var(--accent)");
    const warnings = built.report.warnings.join("\n");
    expect(warnings).toMatch(/ACSS: tenuto un nome che il prototipo definisce da sé \(--accent\)/u);
    expect(warnings).not.toMatch(/ACSS → Histeon CSS|Variabili senza valore/u);
  });

  it("legge uno style come il browser, riferimenti a carattere compresi, e cambia solo i nomi scritti come sono", async () => {
    const html = (await fixture()).replace('"framework": "histos-css"', '"framework": "acss"').replace("<h1>Studio Ehi</h1>", `<h1 style="--tag: &quot;l'arte&quot;; color: var(--primary)">Studio Ehi</h1>`).replace("<p>Quadretti, libri, racconti.</p>", `<p style="margin: var(--prim&#97;ry-dark)">Quadretti, <em style="--t: &quot;l'a&quot;; padding: var(--space-m)">libri</em>, racconti.</p>`);
    const built = await build(html);
    const home = page(built, "home");
    // The apostrophe sits inside a string the entities close: the var() after it is read and converted.
    expect(home).toContain(`"style":"--tag: &quot;l'arte&quot;; color: var(--xb-primary)"`);
    expect(home).toContain(`"tag":"em","attributes":{"style":"--t: &quot;l'a&quot;; padding: var(--xb-space-m)"}`);
    // A name written with a character reference stays as written, and the report says it has no value.
    expect(home).toContain('"style":"margin: var(--prim&#97;ry-dark)"');
    const warnings = built.report.warnings.join("\n");
    expect(warnings).toMatch(/ACSS → Histeon CSS: 2 nomi convertiti \(--primary → --xb-primary, --space-m → --xb-space-m\)/u);
    expect(warnings).toMatch(/Variabili senza valore: --primary-dark \(page home\) → in Histeon CSS --xb-primary-800/u);
    // Inline markup of a text run: a value with an entity is read too, no longer skipped; only names written as they are change.
    const text = { name: "xb/text", attrs: { uid: "t", content: `Quadretti, <em style="--t: &quot;l'a&quot;; padding: var(--space-m)">libri</em> <b class='te&#120;t--l text--s'>x</b> <i style="color: var(--primary) &amp">y</i>` } };
    const names = emptyFrameworkNames();
    const conversions = new Map();
    frameworkNamesInBlocks([text] as XbBlock[], "page home", names, { defined: new Set(), ruleClasses: new Set(), conversions });
    // The last value has a legacy reference (`&amp` without `;`, refused by the transfer check): it is left as written.
    expect(text.attrs.content).toBe(`Quadretti, <em style="--t: &quot;l'a&quot;; padding: var(--xb-space-m)">libri</em> <b class='te&#120;t--l xb-text-s'>x</b> <i style="color: var(--primary) &amp">y</i>`);
    expect([...conversions.keys()]).toEqual(["--space-m", ".text--s"]);
    // As the browser reads them: text--l (written with a reference) is not renamed, and it is reported.
    expect([...names.classes.keys()].sort()).toEqual(["text--l", "xb-text-s"]);
    expect(frameworkNameWarnings(names, { framework: "acss" }).join("\n")).toMatch(/Classi ACSS senza regola: text--l \(page home\) → in Histeon CSS xb-text-l/u);
  });

  it("con acss: keep solo le variabili ACSS aspettano i fogli di ACSS: un nome qualunque senza valore è segnalato come tale", async () => {
    const names = emptyFrameworkNames();
    collectCssNames(names, ".hero { color: var(--brand-colour); margin: var(--space-m); background: var(--primary-trans-20); }", "foglio Base");
    const warnings = frameworkNameWarnings(names, { framework: "acss", acss: "keep" }).join("\n");
    expect(warnings).toMatch(/ACSS tenuto \(acss: keep\): 2 nomi restano senza valore o regola finché non importi i fogli che ACSS genera sul sito \(Stili → Importa CSS\): --primary-trans-20, --space-m\./u);
    expect(warnings).toMatch(/Variabili senza valore: --brand-colour \(foglio Base\)\./u);
    const built = await build((await acssPrototype('"framework": "acss", "acss": "keep"')).replace("color: var(--accent); }", "color: var(--accent); border-color: var(--brand-colour); }"));
    const report = built.report.warnings.join("\n");
    expect(report).toMatch(/Variabili senza valore: --brand-colour \(foglio Base\)\./u);
    expect(report).not.toMatch(/ACSS tenuto[^\n]*--brand-colour/u);
  });

  it("legge commenti e url() come il tokenizer CSS", () => {
    // An unquoted url() is one token: "/*" inside it opens no comment, and a var() inside it is no reference.
    const conversions = new Map();
    expect(convertAcssVariables("a{background:url(img/*.png);color:var(--primary)} b{color:var(--accent);background:url( x/var(--space-m).png )}", new Set(), conversions)).toBe("a{background:url(img/*.png);color:var(--xb-primary)} b{color:var(--xb-accent);background:url( x/var(--space-m).png )}");
    expect([...conversions.keys()]).toEqual(["--primary", "--accent"]);
    // A quoted url() is a function with a string; a string ends at a newline it does not escape.
    expect(convertAcssVariables('a{background:url( "a/*b" ) var(--primary);content:"l\'arte\ncolor:var(--accent)}', new Set(), new Map())).toBe('a{background:url( "a/*b" ) var(--xb-primary);content:"l\'arte\ncolor:var(--xb-accent)}');
    // A comment between the name and its comma: the var() still has a fallback.
    const names = emptyFrameworkNames();
    collectCssNames(names, "a { color: var(--brand /* nota */, red); margin: var(--a /*x*/, var(--b)); padding: var( /* c */ --c); --d /* x */ : 1px; }", "foglio");
    expect([...names.variables.keys()]).toEqual(["c"]);
    expect(names.definedVariables.has("d")).toBe(true);
    // What follows such a url() is read: a definition there still keeps the name from the conversion.
    const after = emptyFrameworkNames();
    collectCssNames(after, "a{background:url(img/*.png)} :root{--space-m:1rem} b{margin:var(--space-m)}", "foglio");
    expect(after.definedVariables.has("space-m")).toBe(true);
    expect([...after.variables.keys()]).toEqual(["space-m"]);
  });

  it("il lavoro sui selettori annidati ha un solo limite per tutto il prototipo, non uno per foglio", async () => {
    const example = await fixture();
    // Before: each sheet had its own budget, so 2,000 tiny nesting bombs took seconds before the import failed.
    const bomb = `.a{${"&,&{".repeat(16)}color:red${"}".repeat(17)}`;
    const names = emptyFrameworkNames();
    const started = performance.now();
    for (let index = 0; index < 2_000; index++) collectCssNames(names, bomb, `foglio ${index}`);
    expect(performance.now() - started).toBeLessThan(2_000);
    // And a prototype with more global sheets than a transfer holds stops at once, with the reason.
    const many = Array.from({ length: 101 }, (_, index) => `<style data-histos="global" data-name="F${index}">body{margin:0}</style>`).join("");
    expect(() => parsePrototype(example.replace("</head>", `${many}</head>`))).toThrow(/fogli globali: al massimo 100\./u);
  });

  it("una utility responsiva, con la regola solo dentro @media, ha la sua regola per il rapporto ma non per la conversione", () => {
    const names = emptyFrameworkNames();
    collectCssNames(names, ".grid--m-1 { @media (max-width: 991px) { grid-template-columns: minmax(0, 1fr); } }", "stili per selettore");
    collectCssNames(names, "@media (width < 40em) { .text--l { font-size: 2rem } }", "foglio");
    expect(names.styledClasses.has("grid--m-1")).toBe(true);
    expect(names.styledClasses.has("text--l")).toBe(true);
    // Not a rule that always applies: an ACSS prototype keeps the Histeon CSS name next to it.
    expect(names.ruleClasses.has("text--l")).toBe(false);
    names.classes.set("grid--m-1", new Set(["page home"]));
    expect(frameworkNameWarnings(names, { framework: "histos-css" }).join("\n")).not.toMatch(/senza regola/u);
  });

  it("tante regole @ con dichiarazioni dentro un selettore lungo non lo rileggono ogni volta: tempo lineare", () => {
    // Before: each @media{x:y} read every selector around it again, uncharged (6 s here, 4x per doubling, synchronous).
    const names = emptyFrameworkNames();
    const started = performance.now();
    collectCssNames(names, `.x${" .a".repeat(20_000)}{${"@a{b:c}".repeat(10_000)}}`, "foglio");
    collectCssNames(names, `.y${" .a".repeat(20_000)}{${"@a{@a{b:c}}".repeat(5_000)}}`, "foglio");
    collectCssNames(names, `${Array.from({ length: 3_000 }, (_, index) => `.a${index}`).join(",")}{${"@media x{b:c}".repeat(3_000)}}`, "stili per selettore");
    expect(performance.now() - started).toBeLessThan(1_500);
    // The same names as before: a list styled under a condition, and always once an @layer styles it too, in any order.
    expect(names.styledClasses.has("a2999")).toBe(true);
    expect(names.ruleClasses.has("a2999")).toBe(false);
    collectCssNames(names, ".z{@media x{b:c} @layer l{b:c}} .w{@layer l{b:c} @media x{b:c}} .v{@media x{b:c} @media y{b:c}}", "foglio");
    expect(["z", "w", "v"].map((name) => [names.ruleClasses.has(name), names.styledClasses.has(name)])).toEqual([[true, true], [true, true], [false, true]]);
  });

  it("CSS che postcss non legge, o legge diversamente dal browser: ogni classe nominata conta come definita, e il rapporto lo dice", () => {
    // Before: one slip the browser tolerates made the whole sheet name nothing, and its classes were renamed.
    for (const [css, reason] of [
      [".text--xl { font-size: 3rem; }\n.nota { color red; }", /^riga 2: Unknown word/u],
      [".text--xl { font-size: 3rem; }\n}", /^riga 2: Unexpected \}/u],
      [".text--xl { font-size: 3rem; }\n.z { color: red;", /Unclosed block/u],
      [".text--xl { font-size: 3rem; }\n/* fine", /Unclosed comment/u],
      // For the browser the newline ends the string and .text--xl is a rule; postcss read it as part of the string.
      ['.a { content: "x\n}\n.text--xl { color: red }\n.b { content: "y" }', /^riga 1: una stringa va a capo senza chiudersi$/u],
      // For the browser url( x/*) is one token and .text--xl a rule; postcss read a comment up to "*/".
      [".a { background: url( x/*) }\n.text--xl { color: red }\n/* q */", /^riga 1: un url\(\) senza virgolette contiene/u],
      // For the browser --> is no property name, and .text--xl a rule; postcss read a custom property holding it.
      ["@media all { --> : x { y } .text--xl { color: red } }", /^riga 1: postcss legge «-->» come una proprietà che contiene le regole seguenti, il browser no$/u],
    ] as const) {
      const names = emptyFrameworkNames();
      collectCssNames(names, css, "foglio Base");
      expect(names.ruleClasses.has("text--xl"), css).toBe(true);
      expect(names.styledClasses.has("text--xl"), css).toBe(true);
      expect(names.unreadable.get("foglio Base"), css).toMatch(reason);
    }
    // Where both read the tokens alike, nothing is guessed: an unquoted url() postcss reads whole, an escaped newline,
    // a custom property in a style's body.
    const read = emptyFrameworkNames();
    collectCssNames(read, ".a { background: url(data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>) }\n.b { content: \"x\\\ny\"; --v: { a: b } }\n.hero .text--xl { color: red }", "foglio Base");
    expect(read.unreadable.size).toBe(0);
    expect(read.ruleClasses.has("text--xl")).toBe(false);
    // The report names the sheet only where ACSS names matter.
    const names = emptyFrameworkNames();
    collectCssNames(names, ".text--xl { font-size: 3rem; }\n.nota { color red; }", "foglio Base");
    expect(frameworkNameWarnings(names, { framework: "histos-css" })).toEqual([]);
    names.classes.set("text--xl", new Set(["page home"]));
    expect(frameworkNameWarnings(names, { framework: "histos-css" }).join("\n")).toMatch(/^CSS che l'import non legge come il browser: foglio Base, riga 2: Unknown word[^\n]*\. Ogni classe che vi compare conta come definita dal prototipo/mu);
  });

  it("un prototipo con un foglio che il browser tollera e postcss no tiene le classi del foglio, e lo dice", async () => {
    const slip = (framework: string) => fixture().then((html) => html.replace('"framework": "histos-css"', framework).replace(":root { --carta: #f6f1e7; }", ":root { --carta: #f6f1e7; }\n.text--xl { font-size: 3rem; color: hotpink; }\n.nota { color red; }").replace("<h1>Studio Ehi</h1>", '<h1 class="text--xl">Studio Ehi</h1>'));
    const acss = await build(await slip('"framework": "acss"'));
    // Before: class "xb-text-xl", and the sheet's .text--xl rule (size, colour) matched nothing.
    expect(page(acss, "home")).toContain('"tag":"h1","attributes":{"class":"text--xl"}');
    const warnings = acss.report.warnings.join("\n");
    expect(warnings).not.toMatch(/ACSS → Histeon CSS/u);
    expect(warnings).toMatch(/CSS che l'import non legge come il browser: foglio Base, riga \d+: Unknown word/u);
    // Histeon CSS: no false "without a rule" for a class the sheet defines.
    const histos = (await build(await slip('"framework": "histos-css"'))).report.warnings.join("\n");
    expect(histos).not.toMatch(/Classi ACSS senza regola/u);
    expect(histos).toMatch(/CSS che l'import non legge come il browser: foglio Base/u);
  });

  it("una regola che il browser scarta nel foglio globale non definisce niente: ; o dichiarazioni fra le regole, <!-- e -->", () => {
    const ruled = (css: string, place = "foglio") => {
      const names = emptyFrameworkNames();
      collectCssNames(names, css, place);
      return { rule: names.ruleClasses.has("text--l"), styled: names.styledClasses.has("text--l"), named: names.selectorClasses.has("text--l"), read: names.unreadable.size === 0 };
    };
    const dropped = { rule: false, styled: false, named: false, read: true };
    // Before: postcss kept these rules, so text--l kept its name alone with a rule that applies nowhere.
    for (const css of [
      ".a { color: red };\n.text--l { font-size: 2rem }",
      ";.text--l { font-size: 2rem }",
      "color: red;\n.text--l { font-size: 2rem }",
      ".a { color: red } /* x */ ; /* y */ .text--l { font-size: 2rem }",
      ".a { color: red }; @media all { .text--l { font-size: 2rem } }",
      ".a { color: red }; @layer x; .text--l { font-size: 2rem }",
      "@media all { .a { color: red }; .text--l { font-size: 2rem } }",
      "@scope (.s) { @media all { .a { color: red }; .text--l { font-size: 2rem } } }",
      "@media all { <!-- .text--l { font-size: 2rem } }",
      ".p { --> .text--l { font-size: 2rem } }",
    ]) expect(ruled(css), css).toEqual(dropped);
    // The rule after the dropped one counts again.
    expect(ruled(".a { color: red };\n.b { color: red }\n.text--l { font-size: 2rem }").rule).toBe(true);
    // Where the browser skips them: at the top of a sheet <!-- and --> are nothing, and in a style's body a stray ; is.
    expect(ruled("<!-- .text--l { font-size: 2rem } -->")).toEqual({ rule: true, styled: true, named: true, read: true });
    expect(ruled(".p { .a { color: red }; .text--l { font-size: 2rem } }").named).toBe(true);
    for (const css of ["@scope (.s) { .a { color: red }; .text--l { font-size: 2rem } }", "@layer x; .text--l { font-size: 2rem }", "@import url(x.css);\n<!-- .text--l { font-size: 2rem } -->"]) expect(ruled(css).styled, css).toBe(true);
    // The selector styles are compiled rule by rule: nothing between them reaches the browser.
    expect(ruled(".a { color: red };\n.text--l { font-size: 2rem }", "stili per selettore").rule).toBe(true);
  });

  it("un ) o un ] fuori posto non chiude nessun blocco: <!-- e --> si saltano solo dove li salta il browser", () => {
    const ruled = (css: string) => {
      const names = emptyFrameworkNames();
      collectCssNames(names, css, "foglio");
      return { rule: names.ruleClasses.has("text--l"), styled: names.styledClasses.has("text--l"), read: names.unreadable.size === 0 };
    };
    // As Chrome reads them: a stray `)` or `]` inside a rule is a token like the others, the `}` still closes the rule,
    // so what follows is the top level, where <!-- and --> are nothing (cssRules keeps `.text--l`).
    for (const css of [".a{b:c)} <!-- .text--l { font-size: 2rem }", ".a{b:c]} --> .text--l { font-size: 2rem }", ".a{b:c)]} <!-- .text--l { font-size: 2rem }"]) {
      expect(ruled(css), css).toEqual({ rule: true, styled: true, read: true });
    }
    // Inside @media the same `}` leaves the @media open: <!-- starts a selector there and the browser drops the rule
    // (cssRules holds only `@media all { .a { } }`). Before, the `)` closed the @media and the rule counted as styling.
    for (const css of ["@media all { .a{b:c)} <!-- .text--l { font-size: 2rem } }", "@media all { .a{b:c]} --> .text--l { font-size: 2rem } }"]) {
      expect(ruled(css), css).toEqual({ rule: false, styled: false, read: true });
    }
  });

  it("una classe ACSS scelta con il testo di class ([class~=…], [class*=…]…) tiene il nome che il selettore legge", async () => {
    const names = emptyFrameworkNames();
    collectCssNames(names, "[class~=\"text--primary\"] { color: hotpink; } *[CLASS~=TEXT--S i] { color: red; } [class~='text--l' s] { color: red; } :is([class~=\"text--m\"]) { color: red; } h1[class~=text--xl] { color: red; } [class /* c */ ~= \"text--x\\73\"] { color: red; } [class~=\"text--xxl a\"], [class~=\"\"], [class|class~=\"text--accent\"] { color: red; }", "foglio");
    expect([...names.ruleClasses].sort()).toEqual(["text--l", "text--m", "text--primary", "text--s", "text--xs"]);
    expect([...names.selectorClasses].sort()).toEqual(["text--l", "text--m", "text--primary", "text--s", "text--xl", "text--xs"]);
    // Any other selector on the text of class: the ACSS classes its words may stand for, whole, as a start, an end or a part.
    const text = emptyFrameworkNames();
    collectCssNames(text, "[class*=\"text--accent-\"] { color: red; } [class^='text--s'] { color: red; } [class$=\"neutral\"] { color: red; } a:not([class=\"text--l x\"]) { color: red; } [class*=\"TEXT--XS\" i] { color: red; } [class*=\"TEXT--XXL\"] { color: red; } [title*=\"text--m\"] { color: red; }", "foglio");
    expect(Object.fromEntries([...text.attributeClasses].sort())).toEqual({
      "text--accent-dark": true, "text--accent-hover": true, "text--accent-light": true, "text--accent-semi-dark": true, "text--accent-semi-light": true, "text--accent-ultra-dark": true, "text--accent-ultra-light": true,
      "text--s": true, "text--secondary": true, "text--secondary-dark": true, "text--secondary-hover": true, "text--secondary-light": true, "text--secondary-semi-dark": true, "text--secondary-semi-light": true, "text--secondary-ultra-dark": true, "text--secondary-ultra-light": true,
      // $= reaches the end of the name: the new name after it would end the text. "x" is a whole class, none of ACSS.
      "text--neutral": false, "text--l": false, "text--xs": true,
    });
    expect(text.ruleClasses.size + text.selectorClasses.size).toBe(0);
    // A word before whitespace ends its class; |= also matches the value alone.
    const spaced = emptyFrameworkNames();
    collectCssNames(spaced, "[class*=\"-semi-dark text--m\"] { color: red; } [class|=\"text--xl\"] { color: red; }", "foglio");
    expect(Object.fromEntries([...spaced.attributeClasses].sort())).toEqual({ "text--accent-semi-dark": false, "text--m": true, "text--neutral-semi-dark": false, "text--primary-semi-dark": false, "text--secondary-semi-dark": false, "text--tertiary-semi-dark": false, "text--xl": false });
    // Through the import: before, each of these lost the author's rule (class="xb-color-primary" alone).
    const cases: Array<[string, string, RegExp]> = [
      ["[class~=\"text--primary\"] { color: hotpink; }", '"class":"text--primary"', /tenuto un nome che il prototipo definisce da sé \(\.text--primary\)/u],
      ["[class*=\"text--\"] { letter-spacing: .1em; }", '"class":"text--primary xb-color-primary"', /una classe tiene anche il nome ACSS accanto a quello Histeon CSS \(\.text--primary con \.xb-color-primary\)/u],
      ["[class^=\"text--\"] { letter-spacing: .1em; }", '"class":"text--primary xb-color-primary"', /una classe tiene anche il nome ACSS accanto/u],
      ["h1[class~=text--primary] { color: hotpink; }", '"class":"text--primary xb-color-primary"', /una classe tiene anche il nome ACSS accanto/u],
      ["[class$=\"primary\"] { color: hotpink; }", '"class":"text--primary"', /tenuto un nome che un selettore del prototipo legge nel testo di class, come \[class="…"\] o \[class\$="…"\] \(\.text--primary\)/u],
      ["[class=\"text--primary\"] { color: hotpink; }", '"class":"text--primary"', /legge nel testo di class[^\n]*\(\.text--primary\)/u],
    ];
    for (const [rule, kept, reported] of cases) {
      const html = (await fixture()).replace(":root { --carta: #f6f1e7; }", `:root { --carta: #f6f1e7; }\n${rule}`).replace("<h1>Studio Ehi</h1>", '<h1 class="text--primary">Studio Ehi</h1>');
      const acss = await build(html.replace('"framework": "histos-css"', '"framework": "acss"'));
      expect(page(acss, "home"), rule).toContain(`"tag":"h1","attributes":{${kept}}`);
      expect(acss.report.warnings.join("\n"), rule).toMatch(reported);
      // Histeon CSS: [class~=…] is the class's own rule, not a missing one.
      if (rule.startsWith("[class~=")) expect((await build(html)).report.warnings.join("\n"), rule).not.toMatch(/Classi ACSS senza regola/u);
    }
  });
});
