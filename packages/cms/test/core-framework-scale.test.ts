import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateCoreFrameworkCss } from "../src/core-framework-css.js";
import { cleanupCss } from "../src/css-cleanup.js";
import { CORE_DEFAULT_SCALE, coreValueAt, corePxExpression } from "../src/core-framework-scale.js";

describe("Core Framework come framework di arrivo (doc 18 §6.4.1)", () => {
  it("la scala inclusa è quella che il generatore scrive per il preset predefinito 1.1.0", () => {
    const preset = JSON.parse(readFileSync(new URL("./fixtures/core-framework-default-preset-1.1.0.json", import.meta.url), "utf8"));
    const css = generateCoreFrameworkCss(preset).css;
    for (const [name, expression] of Object.entries(CORE_DEFAULT_SCALE)) expect(css, name).toContain(`--${name}: ${expression};`);
  });

  it("legge clamp() come il browser: anche una scala che decresce", () => {
    expect(coreValueAt(CORE_DEFAULT_SCALE["space-m"]!, 1280)).toBeCloseTo(26.6, 1);
    expect(coreValueAt(CORE_DEFAULT_SCALE["text-xs"]!, 1280)).toBeCloseTo(12.6, 1);
    expect(corePxExpression(CORE_DEFAULT_SCALE["space-m"]!)).toBe("clamp(16px, calc(1.11vw + 12.4px), 28px)");
  });

  it("scrive le variabili di Core per spazi e testo, le definisce in px, e lascia colori e caratteri", () => {
    const css = `body{font-family:"Inter",sans-serif}.card{color:#c83c28;padding:26px 19px;font-size:23px;margin:3px}`;
    const result = cleanupCss({ sheets: [{ name: "s.css", css }], usedClasses: new Set(["card"]), framework: "core" });
    const all = [result.selectors, ...result.globals.map((sheet) => sheet.css)].join("\n").replaceAll(": ", ":");
    expect(all).toContain("padding:var(--space-m) var(--space-s)");
    expect(all).toContain("font-size:var(--text-l)");
    expect(all).toContain("margin:3px");
    expect(all).toContain("color:#c83c28");
    expect(all).toContain('font-family:"Inter",sans-serif');
    expect(result.globals[0]).toEqual({ name: "Core Framework: variabili usate", css: ":where(:root) {\n  --space-m: clamp(16px, calc(1.11vw + 12.4px), 28px);\n  --space-s: clamp(12.8px, calc(0.65vw + 10.7px), 19.8px);\n  --text-l: clamp(18px, calc(0.55vw + 16.2px), 24px);\n}" });
    expect(result.notes.join("\n")).toMatch(/variabili di Core Framework \(preset predefinito\) al posto dei valori: 0 colori, 0 caratteri, 1 misure di testo, 2 spazi/u);
  });
});
