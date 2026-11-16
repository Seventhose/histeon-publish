import { sha256Hex } from "../src/isomorphic.js";
import { HISTOS_UTILITIES_CSS } from "../src/histos-css-assets.generated.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeHistosTokens, filterHistosClasses, histosContrast, histosClassOffPatterns, histosDesignCss, histosPreviewCss, histosTokenSheet, receiveSiteTokens, siteTokenDeclarations, validateHistosDesign, validateHistosTokenOverrides } from "../src/histos-design.js";
import { frameworkDataWithExternalCss, histosFrameworkData, histosGlobalCss, histosTokenNames, stylesData, withSiteDesign } from "../src/histos-css.js";
import { compileCmsStyles } from "../src/static-renderer.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/histos-css-reference.json", import.meta.url), "utf8")) as {
  defaults: Record<string, string | number>;
  defaultTokens: Record<string, string>;
  defaultContrast: Array<{ text: string; bg: string; ratio: number; ok: boolean }>;
  customDesign: Record<string, string | number>;
  customTokens: Record<string, string>;
  customContrast: Array<{ text: string; bg: string; ratio: number; ok: boolean }>;
  customCss: string;
  vectors: Array<{
    name: string;
    input: Record<string, string | number> | null;
    design: Record<string, string | number>;
    tokens: Record<string, string>;
    contrast: Array<{ text: string; bg: string; ratio: number; ok: boolean }>;
    css: string;
    sheet: string;
    classesSha: string;
    preview: string;
    classesOff: string[];
    changed: Record<string, string | number>;
  }>;
};

describe("generatore Histeon CSS portato da PHP", () => {
  it("produce i token e i contrasti predefiniti identici al generatore Histeon", () => {
    expect(validateHistosDesign(null)).toEqual(reference.defaults);
    expect(computeHistosTokens(null)).toEqual(reference.defaultTokens);
    // The same order too: the stylesheet and the changes print the tokens in it.
    expect(Object.keys(computeHistosTokens(null))).toEqual(Object.keys(reference.defaultTokens));
    for (const vector of reference.vectors) expect(Object.keys(computeHistosTokens(vector.input)), vector.name).toEqual(Object.keys(vector.tokens));
    expect(histosContrast(null)).toEqual(reference.defaultContrast);
  });

  it("mantiene parità PHP per design personalizzato, palette, contrasto e CSS", () => {
    const design = validateHistosDesign({ primary: "#e5533d", radius: 4, text_min: 15.5, space_max: 32, font_body: "Inter, sans-serif" });
    expect(design).toEqual(reference.customDesign);
    expect(computeHistosTokens(design)).toEqual(reference.customTokens);
    expect(histosContrast(design)).toEqual(reference.customContrast);
    expect(histosDesignCss(design)).toBe(reference.customCss);
  });

  it("mantiene parità PHP ai limiti minimi e massimi di tutti i parametri", () => {
    for (const vector of reference.vectors) {
      const design = validateHistosDesign(vector.input);
      expect(design, vector.name).toEqual(vector.design);
      expect(computeHistosTokens(design), vector.name).toEqual(vector.tokens);
      expect(histosContrast(design), vector.name).toEqual(vector.contrast);
      expect(histosDesignCss(design), vector.name).toBe(vector.css);
      expect(histosTokenSheet(design), vector.name).toBe(vector.sheet);
      expect(histosPreviewCss(design), vector.name).toBe(vector.preview);
      expect(histosClassOffPatterns(design), vector.name).toEqual(vector.classesOff);
      expect(sha256Hex(filterHistosClasses(HISTOS_UTILITIES_CSS, design)), vector.name).toBe(vector.classesSha);
    }
  });

  it("con un gruppo di variabili spento la build stampa il foglio del sito al posto di xb-tokens.css", () => {
    const shipped = histosGlobalCss({});
    expect(shipped).toContain("--xb-primary-a10:");
    const own = histosGlobalCss({ design: { print_alphas: 0, print_motion: 0 } });
    expect(own).not.toContain("--xb-primary-a10:");
    expect(own).not.toContain("--xb-enter-range:");
    expect(own).toContain("--xb-primary-700:");
    expect(own).toContain(".xb-btn");
  });

  it("un token di un gruppo spento esce dalle variabili del pannello CSS", () => {
    const names = (design: unknown) => withSiteDesign(histosFrameworkData(), { design }).variables.map(({ name }) => name);
    expect(names({})).toContain("xb-enter-range");
    expect(names({ print_motion: 0 })).not.toContain("xb-enter-range");
    expect(names({ print_motion: 0 })).toContain("xb-primary-700");
  });

  it("rifiuta iniezioni nei parametri e negli override CSS", () => {
    for (const design of [
      { font_body: "Inter; } body { display:none" },
      { font_body: '"Inter' },
      { font_body: "url(https://evil.example/x)" },
      { primary: "red;}body{" },
      { text_min: 999 },
      { viewport_min: 1200, viewport_max: 1000 },
      { unknown: 1 },
    ]) expect(() => validateHistosDesign(design)).toThrow();
    const known = new Set(histosTokenNames());
    expect(validateHistosTokenOverrides({ "xb-primary": "#fff" }, known)).toEqual({ "xb-primary": "#fff" });
    expect(() => validateHistosTokenOverrides({ "xb-primary": "red;}body{display:none" }, known)).toThrow();
    expect(() => validateHistosTokenOverrides({ "xb-not-a-token": "1rem" }, known)).toThrow();
  });

  it("fornisce framework, classi, ricette e CSS globale Histeon senza dipendenze WordPress", () => {
    const framework = histosFrameworkData();
    expect(framework.active).toEqual({ id: "xb-tokens", label: "Histeon CSS" });
    expect(framework.variables).toContainEqual({ name: "xb-primary", group: "xb" });
    expect(framework.classes).toContainEqual({ name: "xb-container", group: "layout" });
    expect(framework.recipes.card).toContain("--xb-radius-l");
    const css = histosGlobalCss({ design: { radius: 4 }, tokenOverrides: { "xb-primary": "#123456" } });
    expect(css).toContain(".xb-container");
    expect(css).toContain("--xb-radius-m:0.25rem");
    expect(css).toContain("--xb-primary:#123456");
  });

  it("conserva provenienza CSS utente e aggiunge classi e variabili importate all'inventario", () => {
    const source = { kind: "user-css", frameworkId: "core-framework", name: "Core Framework", version: "1.2", license: "MIT", rightsConfirmed: true } as const;
    const css = `/* .fake { color: red } */ :root { --core-space-s: 1rem; } .u-stack { display: grid; }`;
    const globals = [{ id: "framework-core-framework", css, source }];
    const framework = frameworkDataWithExternalCss(globals);
    expect(framework.variables).toContainEqual({ name: "core-space-s", group: "Core Framework" });
    expect(framework.classes).toContainEqual({ name: "u-stack", group: "Core Framework" });
    expect(framework.classes).not.toContainEqual({ name: "fake", group: "Core Framework" });
    expect(compileCmsStyles(JSON.stringify({ globals })).globals[0]?.source).toEqual(source);
    expect(stylesData(JSON.stringify({ globals })).globals?.[0]?.source).toEqual(source);
    expect(() => stylesData(JSON.stringify({ globals: [{ id: "bad", css, source: { ...source, rightsConfirmed: false } }] }))).toThrow(/provenienza/u);
  });

  it("conserva la configurazione grezza ACSS senza interpretarla", () => {
    const configuration = '{\n  "version": 4,\n  "tokens": {"space": "1rem"}\n}';
    const styles = stylesData(JSON.stringify({ globals: [{ id: "acss", css: ":root{--acss-space:1rem}", source: { kind: "user-css", frameworkId: "automatic-css", name: "ACSS", rightsConfirmed: true, configuration: { format: "opaque-utf8-v1", data: configuration } } }] }));
    expect(styles.globals?.[0]?.source?.configuration).toEqual({ format: "opaque-utf8-v1", data: configuration });
    expect(() => stylesData(JSON.stringify({ globals: [{ id: "bad", css: "", source: { kind: "user-css", frameworkId: "automatic-css", name: "ACSS", rightsConfirmed: true, configuration: { format: "opaque-utf8-v1", data: "\ud800" } } }] }))).toThrow(/UTF-8/u);
  });

  it("estrae classi CSS dai selettori, decodifica gli escape e ignora valori, URL e attributi", () => {
    const source = { kind: "user-css", frameworkId: "core-framework", name: "Core Framework", rightsConfirmed: true } as const;
    const css = [
      '@font-face{src:url(/assets/icon.svg)}',
      '.card{background:url(/images/.logo.svg);content:".value"}',
      '@media (min-width:40rem){.md\\:grid-cols-2, .\\6d d\\3a grid-cols-2, .éclair:not(.inside){color:red}}',
      '@supports (--core-feature: enabled){.supported{color:var(--core-color)}}',
      '@media (min-width:40rem){:root{--core-space-m:1rem}}',
      '@property --core-registered{syntax:"<color>";inherits:false;initial-value:black}',
      '[data-icon=".attribute"]{color:blue}',
    ].join("\n");
    const framework = frameworkDataWithExternalCss([{ id: "core-framework", css, source }]);
    const imported = framework.classes.filter(({ group }) => group === "Core Framework").map(({ name }) => name);
    const variables = framework.variables.filter(({ group }) => group === "Core Framework").map(({ name }) => name);

    expect(imported).toEqual(expect.arrayContaining(["card", "md:grid-cols-2", "éclair", "inside"]));
    const hexEscape = frameworkDataWithExternalCss([{ id: "core-framework", css: ".\\6d d\\3a grid-cols-2{display:grid}", source }]);
    expect(hexEscape.classes.filter(({ group }) => group === "Core Framework").map(({ name }) => name)).toContain("md:grid-cols-2");
    for (const falseClass of ["svg", "logo", "value", "attribute"]) expect(imported).not.toContain(falseClass);
    expect(variables).toEqual(expect.arrayContaining(["core-space-m", "core-registered"]));
    expect(variables).not.toContain("core-feature");
    expect(variables).not.toContain("core-color");
  });
});

describe("doc 28: le variabili del sito tornano al loro posto dopo un trasferimento", () => {
  const tokens = { "spazio-14": "14px", "testo-17": "17px", "testo-da-46-a-80": "clamp(46px, 5.4vw, 80px)" };
  const sheet = { id: "histos-site-tokens", css: `:root{${siteTokenDeclarations(tokens)}}` };
  const base = { id: "g1", css: "body{margin:0}" };
  const fonts = { id: "histos-fonts", css: "@font-face{font-family:X}", assets: [] };

  it("il foglio scritto dall'esportazione torna in siteTokens e lascia i fogli", () => {
    expect(receiveSiteTokens({ styles: [], globals: [base, sheet, fonts], design: {} }, "histos-fonts")).toEqual({ styles: [], globals: [base, fonts], design: {}, siteTokens: tokens });
    expect(receiveSiteTokens({ globals: [sheet] }, "histos-fonts")).toEqual({ globals: [], siteTokens: tokens });
  });

  it("un foglio che non è alla lettera quello dell'esportazione resta un foglio", () => {
    const same = (payload: Record<string, unknown>) => expect(receiveSiteTokens(payload, "histos-fonts")).toBe(payload);
    same({ globals: [base] });
    same({ globals: [sheet, base] });
    same({ globals: [{ ...sheet, css: `${sheet.css}body{display:none}` }] });
    same({ globals: [{ ...sheet, css: ":root{--xb-site-a:1px;--altro:2px;}" }] });
    same({ globals: [{ ...sheet, css: ":root{--xb-site-a:url(x);}" }] });
    same({ globals: [{ ...sheet, css: ":root{--xb-site-b:1px;--xb-site-a:2px;}" }] });
    same({ globals: [{ ...sheet, css: ":root{--xb-site-a:1px;--xb-site-a:2px;}" }] });
    same({ globals: [{ ...sheet, css: ":root{}" }] });
    same({ globals: [{ ...sheet, assets: [] }] });
    same({ globals: [sheet], siteTokens: { a: "1px" } });
    same({ globals: "no" });
  });
});
