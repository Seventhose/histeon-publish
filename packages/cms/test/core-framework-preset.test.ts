import { readFileSync } from "node:fs";
import LZString from "lz-string";
import { describe, expect, it } from "vitest";
import { decompressCoreUtf16, parseCoreFrameworkPresetFile } from "../src/core-framework-preset.js";
import { generateCoreFrameworkCss } from "../src/core-framework-css.js";

// Reduced data fixture from Core Framework's official DEFAULT_PRESET at commit
// 9e7390a2959fe73c62dcb39107f4b4158e7daab5. Dynamic id and app_version omitted.
const coreDefaultPresetJson = readFileSync(
  new URL("./fixtures/core-framework-default-preset.json", import.meta.url),
  "utf8",
);
const coreDefaultPreset110Json = readFileSync(
  new URL("./fixtures/core-framework-default-preset-1.1.0.json", import.meta.url),
  "utf8",
);
const coreDefaultCss110 = readFileSync(new URL("./fixtures/core-framework-css-1.1.0-default.min.css", import.meta.url), "utf8").trim();

const corePreset = {
  id: "preset-1",
  name: "Histeon demo",
  description: "Preset di prova 🌱",
  date: "2026-10-24",
  app_version: "3.2.1",
  updatedAt: 1_792_814_400_000,
  classPrefix: "cf-",
  groups: {
    colorStyles: [
      {
        id: "group-colors",
        name: "Colors",
        cssObjects: [
          {
            id: "object-colors",
            selector: ":root",
            declarations: [{ id: "declaration-primary", property: "--cf-primary", value: "#123456" }],
          },
        ],
      },
    ],
  },
  breakpoints: [
    [640, 768],
    [1024, 1280],
  ],
  styleSheetData: {
    colorStyles: [
      {
        id: "style-colors",
        name: "Color variables",
        cssObjects: [
          {
            id: "style-object-colors",
            selector: ":root",
            declarations: [{ id: "style-declaration-primary", property: "--cf-primary", value: "#123456" }],
          },
        ],
      },
    ],
  },
  modulesData: { COLOR_SYSTEM: { palette: [{ id: "primary", value: "#123456" }] } },
  preferences: { root_font_size: 16, is_rem: true, theme_mode: "light" },
  cssString: ":root{--core-space:1rem}.card{display:grid}",
};

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

describe("importazione preset Core Framework", () => {
  it("legge il formato .core UTF-16 compresso e conserva il file originale", () => {
    const json = JSON.stringify(corePreset);
    const compressed = LZString.compressToUTF16(json);
    expect(decompressCoreUtf16(compressed)).toBe(LZString.decompressFromUTF16(compressed));
    const imported = parseCoreFrameworkPresetFile("studio.core", bytes(compressed));

    expect(imported.preset).toEqual(corePreset);
    expect(imported.css).toBe(corePreset.cssString);
    expect(imported.source).toEqual({ format: "core-lz-utf16-v1", data: compressed });
  });

  it("accetta il JSON esportato e lo conserva senza normalizzarlo", () => {
    const json = JSON.stringify(corePreset, null, 2);
    const imported = parseCoreFrameworkPresetFile("studio.json", bytes(json));
    expect(imported.preset).toEqual(corePreset);
    expect(imported.source).toEqual({ format: "core-json-v1", data: json });
  });

  it("conserva un preset senza CSS e segnala il dato mancante al chiamante", () => {
    const { cssString: _css, ...withoutCss } = corePreset;
    const imported = parseCoreFrameworkPresetFile("no-css.json", bytes(JSON.stringify(withoutCss)));
    expect(imported.css).toBe("");
    expect(imported.preset).toEqual(withoutCss);
  });

  it("accetta i campi opzionali previsti dal preset Core e un preset privo di payload CSS", () => {
    const metadataOnly = { id: "empty", name: "Preset vuoto", description: "Senza moduli", date: "2026-10-24" };
    const imported = parseCoreFrameworkPresetFile("empty.json", bytes(JSON.stringify(metadataOnly)));
    expect(imported.preset).toEqual(metadataOnly);
    expect(imported.css).toBe("");
  });

  it("importa senza normalizzare il preset predefinito Core, sia JSON sia .core", () => {
    const expected = JSON.parse(coreDefaultPresetJson);
    const importedJson = parseCoreFrameworkPresetFile("default.json", bytes(coreDefaultPresetJson));
    const compressed = LZString.compressToUTF16(coreDefaultPresetJson);
    const importedCore = parseCoreFrameworkPresetFile("default.core", bytes(compressed));

    expect(importedJson.preset).toEqual(expected);
    expect(importedJson.source.data).toBe(coreDefaultPresetJson);
    expect(importedJson.css).toBe("");
    expect(importedCore.preset).toEqual(expected);
    expect(importedCore.source.data).toBe(compressed);
    expect(importedCore.css).toBe("");
  });

  it("conserva il preset Core completo della versione 1.1.0 in JSON e .core", () => {
    const expected = JSON.parse(coreDefaultPreset110Json);
    const importedJson = parseCoreFrameworkPresetFile("core-1.1.0.json", bytes(coreDefaultPreset110Json));
    const compressed = LZString.compressToUTF16(coreDefaultPreset110Json);
    const importedCore = parseCoreFrameworkPresetFile("core-1.1.0.core", bytes(compressed));

    expect(importedJson.preset).toEqual(expected);
    expect(importedJson.source).toEqual({ format: "core-json-v1", data: coreDefaultPreset110Json });
    expect(importedCore.preset).toEqual(expected);
    expect(importedCore.source).toEqual({ format: "core-lz-utf16-v1", data: compressed });
    expect(importedJson.cssKind).toBe("generated");
    expect(importedCore.cssKind).toBe("generated");
    expect(importedJson.css.replace(/^html\s*\{[^}]*\}\s*/u, "").replace(/\s/gu, "")).toBe(coreDefaultCss110);
    expect(importedCore.css.replace(/^html\s*\{[^}]*\}\s*/u, "").replace(/\s/gu, "")).toBe(coreDefaultCss110);
    expect(Object.keys(expected.modulesData)).toContain("FLUID_TYPOGRAPHY");
    expect(Object.keys(expected.modulesData)).toContain("COLOR_SYSTEM");
    expect(Object.keys(expected.modulesData)).toContain("FLUID_SPACING");
    expect(Object.keys(expected.modulesData)).toContain("COMPONENTS");
  });

  it("rigenera il CSS del preset predefinito Core 1.1.0 contro il test ufficiale", () => {
    const generated = generateCoreFrameworkCss(JSON.parse(coreDefaultPreset110Json), { includeHtmlRootFontSize: false });
    expect(generated.version).toBe("1.1.0");
    const actual = generated.css.replace(/\s/gu, "");
    if (actual !== coreDefaultCss110) {
      const firstDifference = [...actual].findIndex((character, index) => character !== coreDefaultCss110[index]);
      throw new Error(JSON.stringify({ firstDifference, actual: actual.slice(firstDifference - 60, firstDifference + 140), expected: coreDefaultCss110.slice(firstDifference - 60, firstDifference + 140), actualLength: actual.length, expectedLength: coreDefaultCss110.length }));
    }
    expect(generated.warnings.join(" ")).toContain("PostCSS");
  });

  it("applica hover media ed easing Core e segnala le conversioni browser ancora escluse", () => {
    const generated = generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { postcss: true, postcss_hover_media: true, postcss_easing_gradients: false },
      modulesData: {},
      styleSheetData: {
        designStyles: [{
          id: "hover-styles",
          name: "Hover styles",
          cssObjects: [{
            id: "card-hover",
            selector: ".card, .card:hover",
            declarations: [{ property: "color", value: "red" }],
          }],
        }],
      },
    });

    expect(generated.css).toContain(".card {");
    expect(generated.css).toContain("@media (hover: hover)");
    expect(generated.css).toContain(".card:hover");
    expect(generated.warnings.join(" ")).toContain("postcss-preset-env");
    expect(generated.warnings.join(" ")).not.toContain("non ha potuto espandere");
  });

  it("espande i gradienti easing solo se l'opzione Core è attiva", () => {
    const preset = {
      app_version: "1.1.0",
      preferences: { postcss: true, postcss_easing_gradients: true },
      modulesData: {},
      styleSheetData: {
        designStyles: [{
          id: "easing-styles",
          name: "Easing styles",
          cssObjects: [{
            id: "gradient",
            selector: ".gradient",
            declarations: [{ property: "background", value: "linear-gradient(#000, ease-in-out, #fff)" }],
          }],
        }],
      },
    };
    const generated = generateCoreFrameworkCss(preset);
    expect(generated.css).toContain("linear-gradient(hsl(");
    expect(generated.css).not.toContain("ease-in-out");
    expect(generated.warnings.join(" ")).toContain("postcss-preset-env");
    expect(generated.warnings.join(" ")).not.toContain("non ha potuto espandere");
  });

  it("segnala il gradiente Core che non può convertire senza perdita", () => {
    const generated = generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { postcss: true, postcss_easing_gradients: true },
      modulesData: {},
      styleSheetData: {
        designStyles: [{
          id: "unsupported-easing",
          name: "Unsupported easing",
          cssObjects: [{
            id: "unsupported-easing-rule",
            selector: ".gradient",
            declarations: [{ property: "background", value: "linear-gradient(red, ease-in-out, blue, white)" }],
          }],
        }],
      },
    });
    expect(generated.css).toContain("linear-gradient(red, ease-in-out, blue, white)");
    expect(generated.warnings.join(" ")).toContain("non ha potuto espandere 1 gradiente/i easing");
  });

  it("conserva il preset 1.1.0 se contiene un modulo che il generatore non supporta", () => {
    const preset = JSON.parse(coreDefaultPreset110Json) as Record<string, unknown>;
    const modulesData = { ...(preset.modulesData as Record<string, unknown>), CORE_MODULE_NOT_SUPPORTED: { enabled: true } };
    const sourceJson = JSON.stringify({ ...preset, modulesData });
    const imported = parseCoreFrameworkPresetFile("unsupported-module.json", bytes(sourceJson));

    expect(imported.source).toEqual({ format: "core-json-v1", data: sourceJson });
    expect(imported.preset.modulesData).toEqual(modulesData);
    expect(imported.css).toBe("");
    expect(imported.cssKind).toBe("unsupported");
    expect(imported.warnings.join(" ")).toContain("Il modulo Core CORE_MODULE_NOT_SUPPORTED non è supportato");
    expect(imported.warnings.join(" ")).toContain("Importa il CSS esportato da Core Framework");
  });

  it("genera condizioni media/support e varianti responsive dei fogli CSS", () => {
    const generated = generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1400, postcss: false },
      modulesData: {},
      styleSheetData: {
        designStyles: [{
          id: "conditional",
          name: "Conditional",
          cssObjects: [
            { id: "hover", selector: ".hover", media: "HOVER", declarations: [{ property: "opacity", value: "1" }] },
            { id: "supports", selector: ".supports", support: "CLAMP", declarations: [{ property: "width", value: "clamp(1px, 1vw, 2px)" }] },
            { id: "variant", selector: ".responsive", declarations: [{ property: "display", value: "block" }], variants: [{ id: "mobile", mediaQuery: [0, 768], declarations: [{ property: "display", value: "grid" }] }] },
          ],
        }],
      },
    });

    expect(generated.css).toContain("@media (hover: hover)");
    expect(generated.css).toContain("@supports (width: clamp(1px, 1px, 1px))");
    expect(generated.css).toContain("@media (max-width: 768px)");
    expect(generated.css).toContain("display: grid;");
    expect(generated.warnings).toEqual([]);
  });

  it("genera la categoria stylesheetsStyles e blocca regole o moduli attivi non interpretati", () => {
    const base = {
      app_version: "1.1.0",
      preferences: { root_font_size: 16, postcss: false },
      modulesData: {},
      styleSheetData: {
        stylesheetsStyles: [{
          id: "additional-sheet",
          name: "Additional sheet",
          cssObjects: [{ id: "additional-rule", selector: ".additional", declarations: [{ property: "display", value: "grid" }] }],
        }],
      },
    };
    expect(generateCoreFrameworkCss(base).css).toContain(".additional {\n  display: grid;");

    expect(() => generateCoreFrameworkCss({
      ...base,
      styleSheetData: {
        stylesheetsStyles: [{
          id: "unsafe-sheet",
          name: "Unsafe sheet",
          cssObjects: [{ id: "unsafe-rule", selector: ".card{} body", declarations: [{ property: "display", value: "none" }] }],
        }],
      },
    })).toThrow(/selettore CSS/u);

    expect(() => generateCoreFrameworkCss({ ...base, modulesData: { UNKNOWN_ACTIVE_MODULE: { enabled: true } } })).toThrow(/non è supportato/u);
    expect(generateCoreFrameworkCss({ ...base, modulesData: { UNKNOWN_DISABLED_MODULE: { isDisabled: true } } }).warnings).toEqual([]);
  });

  it("applica classPrefix e variablePrefix alle classi e ai riferimenti alle variabili", () => {
    const generated = generateCoreFrameworkCss({
      app_version: "1.1.0",
      classPrefix: "custom-",
      variablePrefix: "site-",
      preferences: { root_font_size: 16, postcss: false },
      modulesData: {
        COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand", value: "#123456", gen: ["bg"] }] }] },
      },
      styleSheetData: {
        designStyles: [{
          id: "variables",
          name: "Variables",
          cssObjects: [
            { id: "root", selector: ":root", declarations: [{ property: "--accent", value: "#fff" }] },
            { id: "card", selector: ".card", declarations: [{ property: "color", value: "var(--accent)" }] },
          ],
        }],
      },
    });

    expect(generated.css).toContain("--site-brand: #123456;");
    expect(generated.css).toContain("--site-accent: #fff;");
    expect(generated.css).toContain(".custom-bg-brand");
    expect(generated.css).toContain(".custom-card");
    expect(generated.css).toContain("var(--site-accent)");
  });

  it("genera scale fluide manuali Core 1.1.0 e le relative classi legacy", () => {
    const generated = generateCoreFrameworkCss({
      app_version: "1.1.0",
      classPrefix: "cf-",
      variablePrefix: "site-",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1440, is_rem: true, postcss: false },
      modulesData: {
        FLUID_SPACING: {
          has_legacy_manual_class_generator: true,
          groups: [{
            id: "space-group",
            name: "Space",
            mode: "fluid_manual",
            steps: "s,m",
            manualSizes: [
              { id: "s", name: "space-s", min: 8, max: 12, css: "valore derivato non usato", },
              { id: "m", name: "space-m", min: 16, max: 24, css: "valore derivato non usato", },
            ],
          }],
          classes: [{ id: "padding", tabId: "space-group", name: ".padding-*", property: ["padding", "padding-top"] }],
        },
        FLUID_TYPOGRAPHY: {
          groups: [{
            id: "type-group",
            name: "Type",
            mode: "fluid_manual",
            steps: "body,heading",
            manualSizes: [
              { id: "body", name: "text-body", min: 16, max: 18, css: "ignored", },
              { id: "heading", name: "text-heading", min: 24, max: 32, css: "ignored", },
            ],
          }],
          classes: [{ id: "text", tabId: "type-group", name: ".text-*", property: ["font-size"] }],
          has_legacy_manual_class_generator: true,
        },
      },
      styleSheetData: {},
    });

    expect(generated.css).toContain("--site-space-s: clamp(0.5rem, calc(0.36vw + 0.43rem), 0.75rem);");
    expect(generated.css).toContain("--site-space-m: clamp(1rem, calc(0.71vw + 0.86rem), 1.5rem);");
    expect(generated.css).toContain("--site-text-body: clamp(1rem, calc(0.18vw + 0.96rem), 1.13rem);");
    expect(generated.css).toContain(".cf-padding-s {");
    expect(generated.css).toContain("padding: var(--site-space-s);");
    expect(generated.css).toContain(".cf-text-heading {");
    expect(generated.css).toContain("font-size: var(--site-text-heading);");
    expect(generated.warnings).toEqual([]);
  });

  it("genera classi delle scale automatiche e applica le guardie alle misure manuali", () => {
    const automatic = generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1280, is_rem: false, postcss: false },
      modulesData: {
        FLUID_SPACING: {
          groups: [{ id: "spacing", mode: "fluid", min: { size: 8, scaleRatio: 1.25 }, max: { size: 12, scaleRatio: 1.25 }, steps: "s,m", namingConvention: "space", baseScaleIndex: 1 }],
          classes: [{ id: "gap", tabId: "spacing", name: ".gap-*", property: ["gap"] }],
        },
      },
      styleSheetData: {},
    });
    expect(automatic.css).toContain(".gap-s {");
    expect(automatic.css).toContain("gap: var(--space-s);");
    expect(automatic.css).toContain(".gap-m {");
    expect(automatic.css).toContain("gap: var(--space-m);");

    const withoutLegacyClassGenerator = generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1280, is_rem: false, postcss: false },
      modulesData: {
        FLUID_SPACING: {
          groups: [{ id: "manual", mode: "fluid_manual", steps: "m", manualSizes: [{ id: "m", name: "space-m", min: 16, max: 20, css: "ignored" }] }],
          classes: [{ id: "gap", tabId: "manual", name: ".gap-*", property: ["gap"] }],
        },
      },
      styleSheetData: {},
    });
    expect(withoutLegacyClassGenerator.css).toContain("--space-m:");
    expect(withoutLegacyClassGenerator.css).not.toContain(".gap-m");

    expect(() => generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1280, is_rem: true, postcss: false },
      modulesData: { FLUID_SPACING: { groups: [{ id: "bad", mode: "fluid_manual", steps: "m", manualSizes: [{ id: "m", name: "space-m; body", min: 16, max: 20, css: "ignored" }] }] } },
      styleSheetData: {},
    })).toThrow(/nome di una variabile/u);
  });

  it("riproduce i selettori di tema chiaro e scuro del generatore Core", () => {
    const generated = generateCoreFrameworkCss({
      app_version: "1.1.0",
      has_updated_columns: true,
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1400, postcss: false },
      modulesData: {
        COLOR_SYSTEM: { groups: [{ id: "brand", name: "Brand", colors: [{
          id: "one",
          name: "one",
          value: "hsl(238, 100%, 62%)",
          darkValue: "hsl(138, 100%, 62%)",
          isDarkMode: true,
        }] }] },
      },
      styleSheetData: {},
    });

    const actual = generated.css.replace(/\s/gu, "");
    const expected = `
html.cf-theme-dark{color-scheme:dark;}
:root,:root.cf-theme-dark .theme-inverted, :root.cf-theme-dark .theme-always-light, :root.cf-theme-light .theme-inverted .theme-always-light{--one:hsl(238,100%,62%);}
:root.cf-theme-dark, :root.cf-theme-light .theme-inverted, :root.cf-theme-light .theme-always-dark, :root.cf-theme-dark .theme-inverted .theme-always-dark{--one:hsl(138,100%,62%);}
`.replace(/\s/gu, "");
    expect(actual).toBe(expected);
  });

  it("genera la regola reduced-motion e rifiuta dati sconosciuti o non sicuri", () => {
    const reducedMotion = generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, postcss: false, prefers_reduced_motion: true },
      modulesData: {},
      styleSheetData: {},
    });
    expect(reducedMotion.css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(reducedMotion.css).toContain("animation-duration: 1ms !important;");
    expect(reducedMotion.warnings).toEqual([]);

    const scale = (mode: string) => generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1400, postcss: false },
      modulesData: { FLUID_SPACING: { groups: [{ min: { size: 16, scaleRatio: 1.25 }, max: { size: 24, scaleRatio: 1.25 }, steps: "m", baseScaleIndex: 0, mode }] } },
      styleSheetData: {},
    });
    expect(scale("fluid_manual").css).not.toContain("--space-m");
    expect(() => scale("unknown")).toThrow(/modalità/u);
    const darkMode = generateCoreFrameworkCss({
      app_version: "1.1.0",
      classPrefix: "cf-",
      variablePrefix: "site-",
      preferences: { root_font_size: 16, postcss: false },
      modulesData: {
        COLOR_SYSTEM: { groups: [{ colors: [{
          name: "brand",
          value: "rgb(1, 2, 3)",
          isDarkMode: true,
          darkValue: "rgb(4, 5, 6)",
          transparent: true,
          transparentVariables: [50],
          isShades: true,
          shades: [{ name: "brand-100", value: "rgb(10, 20, 30)" }],
          darkShades: [{ name: "brand-100", value: "rgb(30, 20, 10)" }],
          gen: ["bg"],
        }] }] },
      },
      styleSheetData: {},
    });
    expect(darkMode.css).toContain("--site-brand: rgb(1,2,3);");
    expect(darkMode.css).toContain("--site-brand: rgb(4,5,6);");
    expect(darkMode.css).toContain("--site-brand-50: rgba(4,5,6,0.5);");
    expect(darkMode.css).toContain("--site-brand-100: rgb(30,20,10);");
    expect(darkMode.css).toContain("html.cf-theme-dark {");
    expect(darkMode.css).toContain(".cf-bg-brand {");
    expect(darkMode.css).toContain("var(--site-brand)");
    expect(darkMode.css).toContain(":root.cf-theme-dark");
    expect(() => generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, postcss: false },
      modulesData: { COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand", value: "#123456", darkPalette: { surface: "#111111" } }] }] } },
      styleSheetData: {},
    })).toThrow(/dati colore dark mode non riconosciuti/u);
    expect(() => generateCoreFrameworkCss({
      app_version: "1.1.0",
      preferences: { root_font_size: 16, postcss: false },
      modulesData: { COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand;body", value: "#123456", gen: ["bg"] }] }] } },
      styleSheetData: {},
    })).toThrow(/identificatore CSS/u);
    expect(() => generateCoreFrameworkCss({
      app_version: "1.1.0",
      variablePrefix: "x;body{color:red}",
      preferences: { root_font_size: 16, postcss: false },
      modulesData: {},
      styleSheetData: {},
    })).toThrow(/prefissi CSS/u);
  });

  it("non ignora gruppi di scala o palette Core malformati", () => {
    const base = {
      app_version: "1.1.0",
      preferences: { root_font_size: 16, min_screen_width: 320, max_screen_width: 1400, postcss: false },
      styleSheetData: {},
    };
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { FLUID_SPACING: { groups: [{ min: { size: 16, scaleRatio: 1.25 }, max: { size: 24, scaleRatio: 1.25 }, steps: "m" }, null] } },
    })).toThrow(/gruppo della scala/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { FLUID_SPACING: { groups: { min: { size: 16 }, max: { size: 24 }, steps: "m" } } },
    })).toThrow(/gruppi della scala/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { FLUID_SPACING: { classes: "not-an-array", min: { size: 16 }, max: { size: 24 }, steps: "m" } },
    })).toThrow(/classi della scala/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { COLOR_SYSTEM: { groups: [null] } },
    })).toThrow(/gruppo colore/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { COLOR_SYSTEM: { groups: [{ colors: [null] }] } },
    })).toThrow(/colore del preset Core non contiene un nome/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand", value: "#123456", shades: "not-an-array" }] }] } },
    })).toThrow(/sfumature colore/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand", value: 123 }] }] } },
    })).toThrow(/valore colore/u);
    expect(() => generateCoreFrameworkCss({
      ...base,
      modulesData: { COLOR_SYSTEM: { groups: [{ colors: [{ name: "brand", value: "#123456", darkShades: "not-an-array" }] }] } },
    })).toThrow(/dark mode.*struttura/u);
  });

  it("rifiuta gruppi, fogli di stile e breakpoint con strutture incompatibili con Core", () => {
    const invalidCases = [
      { ...corePreset, groups: { colorStyles: { id: "not-an-array" } } },
      { ...corePreset, groups: { colorStyles: [{ name: "Missing id" }] } },
      {
        ...corePreset,
        groups: { colorStyles: [{ id: "group", name: "Colors", cssObjects: [{ id: "object", selector: ":root" }] }] },
      },
      { ...corePreset, preferences: { root_font_size: "16" } },
      { ...corePreset, preferences: { theme_mode: "system" } },
      {
        ...corePreset,
        styleSheetData: {
          colorStyles: [{ id: "style", name: "Colors", cssObjects: [{ id: "object", declarations: [] }] }],
        },
      },
      { ...corePreset, breakpoints: [[640, "768"]] },
    ];
    for (const invalid of invalidCases) {
      expect(() => parseCoreFrameworkPresetFile("invalid.json", bytes(JSON.stringify(invalid)))).toThrow();
    }
  });

  it("rifiuta dati corrotti, JSON non Core e file oltre il limite", () => {
    expect(() => parseCoreFrameworkPresetFile("bad.core", bytes("not a compressed preset"))).toThrow();
    expect(() => parseCoreFrameworkPresetFile("bad.json", bytes('{"name":"x"}'))).toThrow(/campi riconoscibili/u);
    expect(() => parseCoreFrameworkPresetFile("large.json", new ArrayBuffer(1_048_577))).toThrow(/limite/u);
    expect(() => parseCoreFrameworkPresetFile("bad.css", bytes(".x{}"))).toThrow(/\.core o \.json/u);
  });

  it("interrompe una decompressione che supera il tetto di output", () => {
    const bomb = LZString.compressToUTF16(JSON.stringify({ ...corePreset, cssString: "x".repeat(1_100_000) }));
    expect(() => parseCoreFrameworkPresetFile("large.core", bytes(bomb))).toThrow(/decompresso supera/u);
  });
});
