import { describe, expect, it } from "vitest";
import { histosCssDesignFile, importDesignTokens, readDesignTokens, stepRanges, tokenImportText } from "../src/design-tokens.js";
import { validateHistosDesign, validateSiteTokens } from "../src/histos-design.js";

const file = (name: string, data: unknown) => ({ name, text: JSON.stringify(data) });
const srgb = (hex: string) => ({
  colorSpace: "srgb",
  components: [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255),
  alpha: 1,
  hex,
});
const px = (value: number) => ({ value, unit: "px" });

/** One mode of a Figma variable collection, as «Export modes» writes it. */
const figmaLight = {
  color: {
    $type: "color",
    brand: { primary: { $value: srgb("#1D4ED8") }, secondary: { $value: srgb("#F97316") } },
    gray: { "100": { $value: srgb("#F3F4F6") }, "500": { $value: srgb("#6B7280") }, "900": { $value: srgb("#111827") } },
    feedback: { error: { $value: srgb("#DC2626") } },
    button: { background: { $value: "{color.brand.primary}" } },
    overlay: { $value: { ...srgb("#000000"), alpha: 0.4 } },
  },
  radius: { sm: { $type: "number", $value: 4 }, md: { $type: "number", $value: 10 }, full: { $type: "number", $value: 999 } },
  font: {
    family: { body: { $type: "string", $value: "Inter" }, heading: { $type: "string", $value: "Playfair Display" } },
    size: { body: { $type: "number", $value: 17 }, caption: { $type: "number", $value: 13 }, h1: { $type: "number", $value: 56 } },
    weight: { heading: { $type: "number", $value: 600 } },
  },
  spacing: { card: { $type: "dimension", $value: px(24) }, hairline: { $type: "dimension", $value: px(1) } },
  label: { cta: { $type: "string", $value: "Scopri" } },
  visible: { $type: "number", $value: 1, $extensions: { "com.figma.type": "boolean" } },
};
const figmaDark = { color: { $type: "color", brand: { primary: { $value: srgb("#93C5FD") }, secondary: { $value: srgb("#F97316") } } } };

/** A Penpot export: Tokens Studio sets, numbers as texts, formulas. */
const penpot = {
  "Globale/Colori": {
    primary: { "400": { $value: "#60a5fa", $type: "color" }, "500": { $value: "#3b82f6", $type: "color" }, "600": { $value: "#2563eb", $type: "color" } },
    accent: { $value: "hsl(160, 84%, 39%)", $type: "color" },
    sabbia: { $value: "#f5efe6", $type: "color" },
  },
  "Globale/Misure": {
    spacing: { base: { $value: "8", $type: "spacing" }, lg: { $value: "{spacing.base} * 3", $type: "spacing" }, strano: { $value: "roundTo({spacing.base} / 3, 1)", $type: "spacing" } },
    raggio: { card: { $value: "12", $type: "borderRadius" } },
    testo: { base: { $value: "20", $type: "fontSizes" }, grande: { $value: "{testo.base} * 1.25", $type: "fontSizes" } },
    caratteri: { testo: { $value: "Source Sans 3", $type: "fontFamilies" }, codice: { $value: "JetBrains Mono, monospace", $type: "fontFamilies" } },
    ombra: { card: { $value: { x: "0", y: "4", blur: "12", spread: "0", color: "rgba(0,0,0,0.12)", type: "dropShadow" }, $type: "boxShadow" } },
    titolo: { h2: { $value: { fontFamily: "{caratteri.testo}", fontSize: "32", fontWeight: "Bold", lineHeight: "120%" }, $type: "typography" } },
    perso: { $value: "{non.esiste}", $type: "color" },
    giro: { a: { $value: "{giro.b}", $type: "color" }, b: { $value: "{giro.a}", $type: "color" } },
  },
  Sovrascritture: { accent: { $value: "#0ea5a0", $type: "color" } },
  $themes: [],
  $metadata: { tokenSetOrder: ["Globale/Colori", "Globale/Misure", "Sovrascritture"] },
};

describe("token di design: lettura", () => {
  it("legge un modo esportato da Figma: colori a oggetto, numeri che il nome dice misure, rimandi", () => {
    const read = readDesignTokens([file("Light.tokens.json", figmaLight)]);
    expect(read.dialect).toBe("dtcg");
    const byName = new Map(read.tokens.map((token) => [token.name, token]));
    expect(byName.get("color.brand.primary")).toMatchObject({ kind: "color", color: { r: 29, g: 78, b: 216, alpha: 1 } });
    expect(byName.get("color.overlay")?.color?.alpha).toBe(0.4);
    expect(byName.get("color.button.background")).toMatchObject({ kind: "color", alias: "color.brand.primary" });
    expect(byName.get("radius.md")).toMatchObject({ kind: "dimension", use: "radius", length: { px: 10, unit: "px" } });
    expect(byName.get("font.size.body")).toMatchObject({ kind: "fontSize", length: { px: 17 } });
    expect(byName.get("font.family.heading")).toMatchObject({ kind: "fontFamily", families: ["Playfair Display"] });
    expect(byName.get("font.weight.heading")).toMatchObject({ kind: "fontWeight", number: 600 });
    // What has no place in a stylesheet is said, not guessed.
    expect(read.problems).toContainEqual({ token: "label.cta", why: "tipo «string» non convertito" });
  });

  it("legge l'esportazione di Penpot: insiemi in ordine, numeri scritti come testi, formule calcolate", () => {
    const read = readDesignTokens([file("tokens.json", penpot)]);
    expect(read.dialect).toBe("tokens-studio");
    expect(read.sets).toEqual(["Globale/Colori", "Globale/Misure", "Sovrascritture"]);
    const byName = new Map(read.tokens.map((token) => [token.name, token]));
    // The last set wins.
    expect(byName.get("accent")?.color).toMatchObject({ r: 14, g: 165, b: 160 });
    expect(byName.get("spacing.lg")?.length).toEqual({ px: 24, unit: "px" });
    expect(byName.get("testo.grande")?.length?.px).toBe(25);
    expect(byName.get("ombra.card")?.shadows?.[0]).toMatchObject({ y: { px: 4 }, blur: { px: 12 }, color: { alpha: 0.12 }, inset: false });
    expect(byName.get("titolo.h2")?.style).toEqual({ families: ["Source Sans 3"], sizePx: 32, weight: 700, leading: 1.2 });
    const why = (token: string) => read.problems.find((problem) => problem.token === token)?.why;
    expect(why("spacing.strano")).toBe("formula non calcolata");
    expect(why("perso")).toBe("rimanda a {non.esiste}, che non c'è");
    expect(why("giro.a") ?? why("giro.b")).toBe("rimandi in cerchio");
  });

  it("sceglie gli insiemi del tema: quelli del tema scuro restano fuori dal chiaro e vincono nello scuro", () => {
    // `$themes` as a real Penpot file writes it: a list of themes, each with the sets it switches on.
    const temi = {
      Base: { raggio: { card: { $value: "8", $type: "borderRadius" } } },
      "Colori/Giorno": { primary: { $value: "#1d4ed8", $type: "color" } },
      "Colori/Sera": { primary: { $value: "#93c5fd", $type: "color" } },
      $themes: [
        { id: "a", name: "Light", group: "Modo", description: "", isSource: false, selectedTokenSets: { Base: "source", "Colori/Giorno": "enabled" } },
        { id: "b", name: "Dark", group: "Modo", description: "", isSource: false, selectedTokenSets: { Base: "source", "Colori/Sera": "enabled", "Colori/Giorno": "disabled" } },
      ],
      $metadata: { tokenSetOrder: ["Base", "Colori/Sera", "Colori/Giorno"], activeThemes: [], activeSets: ["Base", "Colori/Giorno"] },
    };
    const light = readDesignTokens([file("tokens.json", temi)]);
    expect(light.dark).toBe(true);
    expect(light.sets).toEqual(["Base", "Colori/Giorno"]);
    expect(light.tokens.find((token) => token.name === "primary")?.color).toMatchObject({ r: 29, g: 78, b: 216 });
    const dark = readDesignTokens([file("tokens.json", temi)], { scheme: "dark" });
    expect(dark.sets).toEqual(["Base", "Colori/Sera"]);
    expect(dark.tokens.find((token) => token.name === "primary")?.color).toMatchObject({ r: 147, g: 197, b: 253 });
    // Without themes the name of the set says it.
    const perNome = { chiaro: { primary: { $value: "#1d4ed8", $type: "color" } }, "tema scuro": { primary: { $value: "#93c5fd", $type: "color" } }, $themes: [], $metadata: { tokenSetOrder: ["tema scuro", "chiaro"] } };
    expect(readDesignTokens([file("t.json", perNome)]).sets).toEqual(["chiaro"]);
    expect(readDesignTokens([file("t.json", perNome)], { scheme: "dark" }).sets).toEqual(["chiaro", "tema scuro"]);
    expect(readDesignTokens([file("tokens.json", penpot)]).dark).toBe(false);
    const result = importDesignTokens(light, { dark });
    expect(result.design).toMatchObject({ dark_on: 1 });
    expect(String(result.design.primary_dark)).toMatch(/^(#93c5fd|oklch)/u);
    // What both readings refuse is said once; what only the dark sets hold is said as dark.
    const rotti = { ...temi, Base: { ...temi.Base, strano: { $value: "roundTo(3)", $type: "spacing" } }, "Colori/Sera": { ...temi["Colori/Sera"], altro: { $value: "roundTo(4)", $type: "spacing" } } };
    const conRotti = importDesignTokens(readDesignTokens([file("t.json", rotti)]), { dark: readDesignTokens([file("t.json", rotti)], { scheme: "dark" }) });
    expect(conRotti.report.skipped.map((item) => item.token)).toEqual(["strano", "altro (scuro)"]);
  });

  it("rifiuta ciò che non è JSON o è troppo, e non esegue mai nulla", () => {
    expect(() => readDesignTokens([])).toThrow("serve almeno un file");
    expect(() => readDesignTokens([{ name: "a.json", text: "{" }])).toThrow("a.json: non è un file JSON.");
    const tanti = Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`t${n}`, { $type: "number", $value: n }]));
    expect(() => readDesignTokens([file("tanti.json", tanti)])).toThrow("più di 5000 token");
    // A formula is arithmetic only: anything else is left out.
    const read = readDesignTokens([file("f.json", { a: { $type: "dimension", $value: "constructor.constructor('return 1')()" }, __proto__x: { polluted: { $type: "number", $value: 1 } } })]);
    expect(read.tokens.map((token) => token.name)).toEqual(["__proto__x.polluted"]);
    // A long chain of references ends with a reason, not with a stack overflow.
    const catena = Object.fromEntries(Array.from({ length: 4000 }, (_, n) => [`c${n}`, { $type: "color", $value: n === 3999 ? "#112233" : `{c${n + 1}}` }]));
    const lunga = readDesignTokens([file("catena.json", catena)]);
    expect(lunga.problems.some((problem) => problem.why === "rimandi troppo profondi")).toBe(true);
    expect(lunga.tokens.find((token) => token.name === "c3999")?.color).toMatchObject({ r: 17, g: 34, b: 51 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("token di design: verso Histeon CSS e Automatic.css", () => {
  it("da Figma: colori di famiglia, caratteri, misura base e raggio diventano parametri validi", () => {
    const result = importDesignTokens(readDesignTokens([file("Light.tokens.json", figmaLight)]), { dark: readDesignTokens([file("Dark.tokens.json", figmaDark)]) });
    expect(result.design).toMatchObject({
      font_body: "Inter, system-ui, sans-serif",
      font_heading: '"Playfair Display", system-ui, sans-serif',
      text_max: 17,
      heading_weight: 600,
      radius: 10,
      dark_on: 1,
    });
    // Colours are stored as the panel stores them.
    for (const family of ["primary", "secondary", "neutral", "danger", "primary_dark"]) expect(String(result.design[family])).toMatch(/^oklch\(/u);
    // The same secondary in both modes is not a dark colour of its own.
    expect(result.design.secondary_dark).toBeUndefined();
    // Text at 17 px: the small screen keeps the default 16, so only the large size is written.
    expect(result.design.text_min).toBeUndefined();
    // The file is the one the panel imports, and the server accepts it.
    const written = JSON.parse(histosCssDesignFile(result.design)) as { format: string; version: number; design: Record<string, unknown> };
    expect(written).toMatchObject({ format: "histos-css-design", version: 1 });
    expect(() => validateHistosDesign(written.design)).not.toThrow();
  });

  it("ciò che non ha un parametro diventa una variabile del sito; i rimandi puntano ai token del framework", () => {
    const result = importDesignTokens(readDesignTokens([file("Light.tokens.json", figmaLight)]));
    expect(result.siteTokens).toMatchObject({
      "color-button-background": "var(--xb-primary)",
      "color-overlay": "rgb(0 0 0 / 0.4)",
      "radius-sm": "0.25rem",
      "spacing-card": "1.5rem",
      "spacing-hairline": "1px",
    });
    expect(() => validateSiteTokens(result.siteTokens)).not.toThrow();
    // A reference written before its target, and one to a token that is not written, both hold a value.
    const ordine = importDesignTokens(readDesignTokens([file("o.json", { a: { $type: "color", $value: "{b}" }, b: { $type: "color", $value: "#abcdef" }, c: { $type: "color", $value: "{font.size.x}" }, font: { size: { x: { $type: "number", $value: 12 } } } })]));
    expect(ordine.siteTokens).toEqual({ a: "var(--xb-site-b)", b: "#abcdef" });
    expect(ordine.acss.css).toBe(":root {\n  --ds-a: var(--ds-b);\n  --ds-b: #abcdef;\n}\n");
    // The shades of a family are the framework's: counted, not copied.
    expect(result.report.shades.neutral).toEqual(["color.gray.100", "color.gray.900"]);
    expect(Object.keys(result.siteTokens).some((name) => name.startsWith("color-gray"))).toBe(false);
  });

  it("una misura di testo non diventa mai una misura fissa: si dice il gradino più vicino", () => {
    const result = importDesignTokens(readDesignTokens([file("Light.tokens.json", figmaLight)]));
    expect(Object.keys(result.siteTokens).some((name) => name.includes("size"))).toBe(false);
    expect(result.acss.css).not.toMatch(/size/u);
    const steps = Object.fromEntries(result.report.textSizes.map((item) => [item.token, item]));
    expect(steps["font.size.body"]).toMatchObject({ px: 17, step: "xb-text-m", stepPx: 17, acss: "text-m" });
    expect(steps["font.size.caption"]).toMatchObject({ step: "xb-text-s", acss: "text-s" });
    expect(steps["font.size.h1"]?.step).toMatch(/^xb-h[1-6]$/u);
  });

  it("stepRanges: i px di ogni gradino sullo schermo stretto e su quello largo", () => {
    const base = stepRanges({});
    expect(base.get("xb-text-m")).toEqual([16, 18]);
    expect(base.get("xb-h6")).toEqual([18, 20]);
    expect(base.has("xb-text-xxl")).toBe(false);
    // A step with a size of its own, one that shrinks on a wide screen, and titles that follow the text scale.
    const own = stepRanges({ size_h1_min: 40, size_h1_max: 84, size_text_s_min: 15, size_text_s_max: 13, heading_scale_on: 0 });
    expect(own.get("xb-h1")).toEqual([40, 84]);
    expect(own.get("xb-text-s")).toEqual([15, 13]);
    expect(own.get("xb-h6")).toEqual(own.get("xb-text-m"));
  });

  it("per Automatic.css: valori con nomi nostri e variabili con un prefisso, con i nomi ACSS nei rimandi", () => {
    const result = importDesignTokens(readDesignTokens([file("Light.tokens.json", figmaLight)]), { acssPrefix: "sito" });
    expect(result.acss.values).toMatchObject({
      format: "histeon-acss-valori",
      version: 1,
      colori: { primary: { hex: "#1d4ed8" }, secondary: { hex: "#f97316" }, neutral: { hex: "#6b7280" }, danger: { hex: "#dc2626" } },
      caratteri: { testo: "Inter, system-ui, sans-serif" },
      testo: { base_px: 17, minimo_px: 16 },
      titoli: { peso: 600 },
      raggio_px: 10,
    });
    expect(result.acss.values.colori.primary?.oklch).toMatch(/^oklch\(/u);
    // The scale of the design, with the names of the steps of Automatic.css: its own scale gives other sizes.
    const scala = result.acss.values.scala ?? {};
    expect(Object.keys(scala).sort()).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "text-l", "text-m", "text-s", "text-xl", "text-xs", "text-xxl"]);
    expect(scala["text-m"]).toEqual({ minimo_px: 16, massimo_px: 17 });
    const ranges = stepRanges(result.design);
    expect(scala.h1).toEqual({ minimo_px: ranges.get("xb-h1")![0], massimo_px: ranges.get("xb-h1")![1] });
    expect(scala["text-xxl"]).toEqual({ minimo_px: ranges.get("xb-text-2xl")![0], massimo_px: ranges.get("xb-text-2xl")![1] });
    expect(scala.h1!.massimo_px).toBeGreaterThan(scala.h2!.massimo_px);
    expect(result.acss.values.schermo).toEqual({ minimo_px: 360, massimo_px: 1440 });
    // The space scale and the side margin (by default the medium space step).
    expect(result.acss.values.spazi).toEqual({ base_px: 24, minimo_px: 16, rapporto: 1.6, rapporto_minimo: 1.5 });
    expect(result.acss.values.margine).toEqual({ minimo_px: 16, massimo_px: 24 });
    expect(result.acss.css).toContain("  --sito-color-button-background: var(--primary);\n");
    expect(result.acss.css).toContain("  --sito-spacing-card: 1.5rem;\n");
    expect(result.acss.css.startsWith(":root {\n")).toBe(true);
    expect(() => importDesignTokens(readDesignTokens([file("a.json", figmaLight)]), { acssPrefix: "x;}" })).toThrow("Prefisso");
  });

  it("da Penpot: la sfumatura di mezzo è il colore della famiglia, le altre restano al framework", () => {
    const result = importDesignTokens(readDesignTokens([file("tokens.json", penpot)]));
    expect(result.acss.values.colori).toMatchObject({ primary: { hex: "#3b82f6" }, accent: { hex: "#0ea5a0" } });
    expect(result.report.shades.primary).toEqual(["primary.400", "primary.600"]);
    expect(result.design).toMatchObject({ text_max: 20, radius: 12, font_mono: '"JetBrains Mono", monospace' });
    expect(result.design.font_body).toBe('"Source Sans 3", system-ui, sans-serif');
    expect(result.siteTokens).toMatchObject({ sabbia: "#f5efe6", "spacing-lg": "1.5rem", "ombra-card": "0 0.25rem 0.75rem 0 rgb(0 0 0 / 0.12)" });
    expect(result.report.styles).toEqual(["titolo.h2"]);
    expect(result.report.fonts).toEqual(["Source Sans 3", "JetBrains Mono"]);
    const text = tokenImportText(result.report);
    expect(text).toContain("formato Tokens Studio, come li esporta Penpot");
    // Taken from a whole design file or from the API of Figma: no format the user never exported is named.
    const fromDesign = tokenImportText(result.report, { fromDesign: true });
    expect(fromDesign).toContain("(stili, colori e variabili presi dal design; ");
    expect(fromDesign).not.toContain("Penpot");
    expect(text).toContain("• spacing.strano: formula non calcolata");
    expect(text).toContain("Caratteri da procurare");
  });

  it("niente del file arriva nel CSS senza passare dai controlli", () => {
    const cattivo = {
      color: { $type: "color", primary: { $value: "#112233" }, rotto: { $value: "red; } body { display:none" } },
      font: { family: { body: { $type: "fontFamily", $value: "Inter; } * { color: red" } } },
      "x} body{display:none}": { card: { $type: "dimension", $value: px(8) } },
      ombra: { $type: "shadow", a: { $value: { color: "#000000", offsetX: px(0), offsetY: "1px; x", blur: px(2) } } },
    };
    const result = importDesignTokens(readDesignTokens([file("cattivo.json", cattivo)]));
    // The hostile name survives only as a slug; no value and no line of CSS holds a character that ends a rule.
    for (const value of [...Object.values(result.design), ...Object.values(result.siteTokens)]) expect(String(value)).not.toMatch(/[;{}<>]/u);
    for (const line of result.acss.css.trim().split("\n").slice(1, -1)) expect(line).toMatch(/^ {2}--ds-[a-z0-9-]+: [^;{}<>]+;$/u);
    expect(result.design.font_body).toBeUndefined();
    expect(result.siteTokens).toEqual({ "x-body-display-none-card": "0.5rem" });
    expect(result.report.skipped.map((item) => item.token).sort()).toEqual(["color.rotto", "font.family.body", "ombra.a"]);
  });

  it("un file esportato da Histeon CSS ridà i suoi parametri e nessuna variabile del sito", () => {
    const esportato = {
      $extensions: { "histeon.css": { scheme: "light", exported: 4, skipped: { formula: {}, unit: {}, type: {} } } },
      color: {
        primary: {
          base: { $type: "color", $value: { colorSpace: "oklch", components: [0.5, 0.15, 150], hex: "#22763a" } },
          "500": { $type: "color", $value: { colorSpace: "oklch", components: [0.62, 0.2, 265], hex: "#4f6df5" } },
          on: { $type: "color", $value: { colorSpace: "srgb", components: [1, 1, 1], hex: "#ffffff" } },
        },
      },
      dimension: { radius: { m: { $type: "dimension", $value: { value: 0.75, unit: "rem" } } } },
      fontFamily: { "font-body": { $type: "fontFamily", $value: ["Inter", "sans-serif"] } },
    };
    const result = importDesignTokens(readDesignTokens([file("tokens.chiaro.json", esportato)]));
    expect(result.siteTokens).toEqual({});
    expect(result.design).toMatchObject({ radius: 12, font_body: "Inter, sans-serif" });
    // An OKLCH colour comes back as it was written, not through sRGB bytes.
    expect(result.design.primary).toBe("oklch(50% 0.15 150)");
    expect(result.report.notes.join(" ")).toContain("esportazione di Histeon CSS");
  });
});
