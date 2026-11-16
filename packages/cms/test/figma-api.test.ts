import { describe, expect, it } from "vitest";
import { importDesignTokens, readDesignTokens } from "../src/design-tokens.js";
import { figmaApiLibrary, figmaApiTokens, figmaStyleIds, type FigmaSource } from "../src/figma-api.js";

const rgb = (hex: string, a = 1) => ({ r: Number.parseInt(hex.slice(1, 3), 16) / 255, g: Number.parseInt(hex.slice(3, 5), 16) / 255, b: Number.parseInt(hex.slice(5, 7), 16) / 255, a });
const solid = (hex: string, opacity = 1) => ({ type: "SOLID", color: rgb(hex), opacity });

/** A file as `GET /v1/files/:key` answers it: styles by node id, layers that name the styles they use. */
function sampleFile(): Record<string, unknown> {
  return {
    name: "Kit di prova",
    version: "123",
    document: {
      id: "0:0",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          type: "CANVAS",
          name: "Home",
          children: [
            { id: "5:1", type: "FRAME", name: "Hero", styles: { fill: "1:1" }, fills: [solid("#1D4ED8")], children: [
              { id: "5:2", type: "TEXT", name: "Titolo", styles: { text: "2:1", fill: "1:9" }, fills: [solid("#0F172A")], style: { fontFamily: "Fraunces", fontPostScriptName: "Fraunces-SemiBold", fontWeight: 600, fontSize: 40, lineHeightPx: 44, lineHeightUnit: "PIXELS" } },
              { id: "5:3", type: "TEXT", name: "Testo", styles: { text: "2:2" }, style: { fontFamily: "Inter", fontPostScriptName: "Inter-Regular", fontWeight: 400, fontSize: 17, lineHeightPercentFontSize: 150, lineHeightUnit: "FONT_SIZE_%" } },
              { id: "5:4", type: "RECTANGLE", name: "Scheda", styles: { fill: "1:1", effect: "3:1" }, fills: [solid("#1D4ED8")] },
            ] },
            { id: "5:5", type: "COMPONENT", name: "Pulsante", children: [] },
          ],
        },
        { id: "0:2", type: "CANVAS", name: "Contatti", children: [] },
      ],
    },
    styles: {
      "1:1": { key: "a", name: "Colors/Primary", styleType: "FILL" },
      "1:2": { key: "b", name: "Colors/Sfumato", styleType: "FILL" },
      "1:9": { key: "c", name: "Esterno/Inchiostro", styleType: "FILL", remote: true },
      "1:8": { key: "d", name: "Esterno/Mai usato", styleType: "FILL", remote: true },
      "2:1": { key: "e", name: "Heading/H1", styleType: "TEXT" },
      "2:2": { key: "f", name: "Body/Base", styleType: "TEXT" },
      "3:1": { key: "g", name: "Ombre/Scheda", styleType: "EFFECT" },
      "4:1": { key: "h", name: "Griglia", styleType: "GRID" },
    },
  };
}

/** The style nodes as `…/nodes` answers them. The remote styles are not there: their value is on the layers. */
const styleNodes: Record<string, unknown> = {
  "1:1": { document: { id: "1:1", type: "RECTANGLE", fills: [solid("#1D4ED8")] } },
  "1:2": { document: { id: "1:2", type: "RECTANGLE", fills: [{ type: "GRADIENT_LINEAR" }] } },
  "2:1": { document: { id: "2:1", type: "TEXT", style: { fontFamily: "Fraunces", fontPostScriptName: "Fraunces-SemiBold", fontWeight: 600, fontSize: 40, lineHeightPx: 44, lineHeightUnit: "PIXELS" } } },
  "2:2": { document: { id: "2:2", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 17, lineHeightPercentFontSize: 150, lineHeightUnit: "FONT_SIZE_%" } } },
  "3:1": { document: { id: "3:1", type: "RECTANGLE", effects: [{ type: "DROP_SHADOW", visible: true, radius: 12, spread: 0, offset: { x: 0, y: 4 }, color: rgb("#000000", 0.2) }, { type: "LAYER_BLUR", visible: true, radius: 4 }] } },
};

const variables = {
  meta: {
    variableCollections: { "VC:1": { id: "VC:1", name: "Tema", modes: [{ modeId: "m1", name: "Light" }, { modeId: "m2", name: "Dark" }] } },
    variables: {
      "V:1": { id: "V:1", name: "color/primary", variableCollectionId: "VC:1", resolvedType: "COLOR", scopes: ["ALL_FILLS"], valuesByMode: { m1: rgb("#1D4ED8"), m2: rgb("#93C5FD") } },
      "V:2": { id: "V:2", name: "color/azione", variableCollectionId: "VC:1", resolvedType: "COLOR", scopes: [], valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "V:1" }, m2: { type: "VARIABLE_ALIAS", id: "V:1" } } },
      "V:3": { id: "V:3", name: "radius/md", variableCollectionId: "VC:1", resolvedType: "FLOAT", scopes: ["CORNER_RADIUS"], valuesByMode: { m1: 10, m2: 10 } },
      "V:4": { id: "V:4", name: "orfana", variableCollectionId: "VC:9", resolvedType: "FLOAT", valuesByMode: {} },
      "V:5": { id: "V:5", name: "vecchia", variableCollectionId: "VC:1", resolvedType: "FLOAT", deletedButReferenced: true, valuesByMode: { m1: 1 } },
    },
  },
};

describe("libreria di un file di Figma dalle risposte dell'API", () => {
  it("legge stili di colore, di testo e di effetto, usi, pagine e componenti", () => {
    expect(figmaStyleIds(sampleFile())).toHaveLength(8);
    const library = figmaApiLibrary(sampleFile(), styleNodes, variables);
    expect(library.name).toBe("Kit di prova");
    expect(library.fills).toEqual([
      { name: "Primary", path: ["Colors"], uses: 2, color: { r: 29, g: 78, b: 216, alpha: 1 } },
      { name: "Sfumato", path: ["Colors"], uses: 0, color: null },
      // A style of another library has no node here: its value comes from the layer that uses it.
      { name: "Inchiostro", path: ["Esterno"], uses: 1, color: { r: 15, g: 23, b: 42, alpha: 1 } },
    ]);
    expect(library.texts).toEqual([
      { name: "H1", path: ["Heading"], uses: 1, fontFamily: "Fraunces", fontStyle: "SemiBold", fontSizePx: 40, fontWeight: 600, lineHeight: { value: 44, unit: "px" } },
      { name: "Base", path: ["Body"], uses: 1, fontFamily: "Inter", fontStyle: "", fontSizePx: 17, fontWeight: 400, lineHeight: { value: 1.5, unit: "ratio" } },
    ]);
    expect(library.effects).toEqual([{ name: "Scheda", path: ["Ombre"], uses: 1, shadows: [{ x: 0, y: 4, blur: 12, spread: 0, color: { r: 0, g: 0, b: 0, alpha: 0.2 }, inset: false }], other: ["LAYER_BLUR"] }]);
    expect(library.grids).toBe(1);
    expect(library.pages).toEqual([{ name: "Home", layers: 5 }, { name: "Contatti", layers: 0 }]);
    expect(library.components).toBe(1);
    expect(library.problems).toContainEqual({ token: "Esterno / Mai usato", why: expect.stringContaining("libreria esterna") });
  });

  it("legge le variabili coi modi e i rimandi, e lascia fuori quelle senza raccolta o cancellate", () => {
    const library = figmaApiLibrary(sampleFile(), styleNodes, variables);
    expect(library.collections).toEqual([{ name: "Tema", modes: ["Light", "Dark"] }]);
    expect(library.variables.map((variable) => [...variable.path, variable.name].join("/"))).toEqual(["color/primary", "color/azione", "radius/md"]);
    expect(library.variables[1]!.values).toEqual([{ alias: 0 }, { alias: 0 }]);
    expect(library.variables[2]).toMatchObject({ type: "number", scopes: ["CORNER_RADIUS"], values: [{ number: 10 }, { number: 10 }] });
    expect(library.problems).toContainEqual({ token: "orfana", why: expect.stringContaining("senza la sua raccolta") });
  });

  it("rifiuta ciò che non è un file e regge campi del tipo sbagliato", () => {
    expect(() => figmaApiLibrary({ err: "Not found" }, {}, null)).toThrowError(/manca il documento/u);
    expect(() => figmaApiLibrary(null, {}, null)).toThrowError(TypeError);
    const odd = figmaApiLibrary({ name: 7, document: { type: "DOCUMENT", children: [null, { type: "CANVAS", children: [{ styles: "no", children: "no" }, 3] }] }, styles: { "1:1": null, "1:2": { name: "", styleType: "FILL" }, __proto__: { name: "x", styleType: "FILL" } } }, { "1:1": 4 }, { meta: { variables: [], variableCollections: "no" } });
    expect(odd).toMatchObject({ name: "File di Figma", fills: [], pages: [{ name: "Pagina", layers: 1 }], variables: [] });
  });
});

describe("token di un file di Figma letto dall'API", () => {
  const asked: string[] = [];
  const source = (withVariables: boolean): FigmaSource => ({
    file: async (key) => { asked.push(`file ${key}`); return sampleFile(); },
    nodes: async (key, ids) => { asked.push(`nodes ${key} ${ids.length}`); return styleNodes; },
    localVariables: async (key) => { asked.push(`variables ${key}`); return withVariables ? variables : null; },
  });

  it("dà file di token che il lettore capisce, con una richiesta per tipo", async () => {
    asked.length = 0;
    const tokens = await figmaApiTokens(source(true), "CHIAVE");
    expect(asked).toEqual(["file CHIAVE", "nodes CHIAVE 8", "variables CHIAVE"]);
    expect(tokens.kind).toBe("figma");
    expect(tokens.summary).toContain("Kit di prova: file di Figma letto dall’API, 3 stili di colore, 2 stili di testo, 1 stile di effetto, 3 variabili in 1 raccolta, 1 componente, 2 pagine");
    const read = readDesignTokens(tokens.files);
    const result = importDesignTokens(read, read.dark ? { dark: readDesignTokens(tokens.files, { scheme: "dark" }) } : {});
    expect(result.design).toMatchObject({ radius: 10, dark_on: 1 });
    expect(String(result.design.font_heading)).toContain("Fraunces");
    expect(result.report.fonts).toEqual(expect.arrayContaining(["Fraunces", "Inter"]));
    expect(JSON.stringify(result.siteTokens)).not.toMatch(/\d(?:\.\d+)?px\b.*text|font-size/u);
  });

  it("senza le variabili legge gli stili e dice come averle", async () => {
    const tokens = await figmaApiTokens(source(false), "CHIAVE");
    expect(tokens.summary).toContain("variabili non date dall’API");
    expect(tokens.problems[0]).toEqual({ token: "Variabili", why: expect.stringContaining("Enterprise") });
    expect(tokens.files.length).toBeGreaterThan(0);
  });

  it("un file senza stili né variabili è un errore in italiano", async () => {
    const empty: FigmaSource = { file: async () => ({ name: "Vuoto", document: { type: "DOCUMENT", children: [] }, styles: {} }), nodes: async () => { throw new Error("non va chiesto"); }, localVariables: async () => null };
    await expect(figmaApiTokens(empty, "CHIAVE")).rejects.toThrowError(/Vuoto: il file di Figma non ha stili/u);
  });
});
