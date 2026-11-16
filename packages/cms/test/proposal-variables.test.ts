import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HISTOS_ACSS_MAP } from "../src/histos-css-assets.generated.js";
import { histosTokenNames } from "../src/histos-css.js";
import { histosDesignCss } from "../src/histos-design.js";
import { PROPOSAL_ACSS_EXTRA } from "../src/proposal-acss-table.js";
import { convertProposalVariables, proposalAcssTokens, readProposalsFile } from "../src/proposal-import.js";

// Voce 2: le variabili di una proposta di `kit proposte` diventano token --xb-* con una tabella esplicita.
const fixtureDoc = (name: string, index = 0): string => readProposalsFile(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).proposals[index]?.doc ?? "";
const doc = (css: string, body = "<p>x</p>"): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>P</title><style>\n${css}\n</style></head><body>${body}</body></html>`;
/** The custom properties of the top-level :root rules of the result, in order: name → value. */
const rootOf = (html: string): Array<[string, string]> => {
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gu)].map((match) => match[1]).join("\n");
  const out: Array<[string, string]> = [];
  for (const block of css.matchAll(/(?:^|\})\s*:root\s*\{([^}]*)\}/gu)) for (const line of (block[1] ?? "").split(";")) {
    const found = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]*?)\s*$/u.exec(line);
    if (found) out.push([found[1] ?? "", found[2] ?? ""]);
  }
  return out;
};

describe("proposalAcssTokens", () => {
  it("è la tabella del builder rovesciata più le righe di PROPOSAL_ACSS_EXTRA, che vincono", () => {
    const table = proposalAcssTokens();
    for (const [xb, acss] of Object.entries(HISTOS_ACSS_MAP.tokens)) if (!(acss in PROPOSAL_ACSS_EXTRA)) expect(table.get(acss)).toBe(xb);
    for (const [acss, xb] of Object.entries(PROPOSAL_ACSS_EXTRA)) expect(table.get(acss)).toBe(xb);
    expect(table.get("primary")).toBe("xb-primary");
    expect(table.get("text-dark")).toBe("xb-text");
    expect(table.get("bg-light")).toBe("xb-surface-2");
    expect(table.has("base")).toBe(false);
    expect(table.size).toBe(Object.keys(HISTOS_ACSS_MAP.tokens).length + Object.keys(PROPOSAL_ACSS_EXTRA).length);
    // The first rows are the builder's, in its order.
    expect([...table.keys()].slice(0, 2)).toEqual(["primary", "primary-ultra-light"]);
  });

  it("porta solo a token che Histeon CSS ha davvero", () => {
    // The tertiary family exists only when the design turns it on (tertiary_on): its tokens count with it on.
    const withTertiary = histosDesignCss({ tertiary_on: "1" });
    const tokens = new Set([...histosTokenNames(), ...[...withTertiary.matchAll(/--(xb-tertiary[a-z0-9-]*):/gu)].map((match) => match[1] ?? "")]);
    for (const [acss, xb] of proposalAcssTokens()) expect(tokens.has(xb), `${acss} → ${xb}`).toBe(true);
  });
});

describe("convertProposalVariables con ACSS", () => {
  it("converte la proposta vera p01: nomi, design, :root ripulito, note", () => {
    const result = convertProposalVariables(fixtureDoc("proposte-acss.html"), "acss");
    expect(result.renamed.map((item) => item.from)).toEqual(["--black", "--white", "--radius", "--text-m", "--text-dark", "--space-l", "--space-m", "--h1", "--text-l", "--h3", "--bg-light", "--radius-m", "--space-xs", "--text-s", "--primary", "--space-s", "--text-light"]);
    expect(result.renamed[0]).toEqual({ from: "--black", to: "--xb-black", count: 1 });
    expect(result.renamed.find((item) => item.from === "--primary")).toEqual({ from: "--primary", to: "--xb-primary", count: 2 });
    expect(result.renamed.find((item) => item.from === "--space-m")).toEqual({ from: "--space-m", to: "--xb-space-m", count: 6 });
    expect(result.renamed.find((item) => item.from === "--text-dark")).toEqual({ from: "--text-dark", to: "--xb-text", count: 1 });
    expect(result.design).toEqual({ primary: "oklch(0.55 0.15 30)" });
    expect(result.unmapped).toEqual(["--text-light-muted"]);
    expect(result.dropped).toEqual(["--base"]);
    expect(rootOf(result.doc)).toEqual([["--text-light-muted", "oklch(0.9 0.01 239)"]]);
    expect(result.doc).not.toMatch(/var\(--(?!xb-|text-light-muted\))/u);
    expect(result.doc).toContain("background: var(--xb-primary);");
    expect(result.doc).toContain("color: var(--xb-text);");
    expect(result.doc).toContain("color: var(--text-light-muted);");
    // The markup is still there.
    expect(result.doc).toContain('<article class="piatto">');
    expect(result.doc).toContain("<title>P01 · Brace</title>");
    expect(result.notes).toEqual([
      "ACSS → Histeon CSS: 17 variabili convertite (--black → --xb-black, --white → --xb-white, --radius → --xb-radius-m, --text-m → --xb-text-m, --text-dark → --xb-text, --space-l → --xb-space-l, --space-m → --xb-space-m, --h1 → --xb-h1 e altre 9)",
      "colori della proposta nel design di Histeon CSS: primary",
      "variabile senza corrispondenza in Histeon CSS, resta nel :root del prototipo: --text-light-muted",
      "variabili non più usate tolte dal :root: --base",
    ]);
  });

  it("converte la proposta vera p02: secondario acceso, :root tolto del tutto", () => {
    const result = convertProposalVariables(fixtureDoc("proposte-acss.html", 1), "acss");
    expect(result.design).toEqual({ secondary: "#1f6f5c", secondary_on: "1" });
    expect(result.renamed).toHaveLength(9);
    expect(result.unmapped).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(rootOf(result.doc)).toEqual([]);
    expect(result.doc).not.toContain(":root");
    expect(result.notes).toEqual([
      "ACSS → Histeon CSS: 9 variabili convertite (--black → --xb-black, --text-m → --xb-text-m, --text-dark → --xb-text, --space-l → --xb-space-l, --h1 → --xb-h1, --text-l → --xb-text-l, --space-s → --xb-space-s, --secondary → --xb-secondary e altre 1)",
      "colori della proposta nel design di Histeon CSS: secondary",
    ]);
  });

  it("segue le catene di var() per i colori, legge le riserve e scarta i colori che Histeon CSS non legge", () => {
    const result = convertProposalVariables(doc(":root {\n  --brand: oklch(0.6 0.1 200);\n  --primary: var(--brand);\n  --secondary: hsl(10 50% 50%);\n  --accent: var(--manca, #aa0000);\n}\n.a { color: var(--primary); border-color: var(--secondary); background: var(--accent); }"), "acss");
    // --secondary's value does not read, but the family is used: it is on.
    expect(result.design).toEqual({ primary: "oklch(0.6 0.1 200)", accent: "#aa0000", accent_on: "1", secondary_on: "1" });
    // --brand is only used by --primary's definition, which goes: it goes too.
    expect(result.dropped).toEqual(["--brand"]);
    expect(result.notes).toContain("colori della proposta nel design di Histeon CSS: primary, accent");
    expect(result.notes).toContain("colori che Histeon CSS non legge, lasciati al design di serie: --secondary");
  });

  it("accende la famiglia di una sfumatura usata senza il suo colore, perché i suoi token esistano", () => {
    const result = convertProposalVariables(doc(":root {\n  --tertiary-light: #ddeeff;\n  --primary-dark: #001122;\n}\n.a { color: var(--tertiary-light); background: var(--primary-dark); }"), "acss");
    expect(result.design).toEqual({ tertiary_on: "1" });
    expect(result.doc).toContain("color: var(--xb-tertiary-200);");
  });

  it("converte anche dentro @media, nei valori del :root che restano e negli attributi style", () => {
    const result = convertProposalVariables(doc(":root {\n  --mio: calc(var(--space-m) * 2);\n  color-scheme: light;\n}\n@media (min-width: 900px) {\n  .a { padding: var(--space-l); }\n}\n.b { margin: var(--mio); }", '<p style="color: var(--primary); margin: var(--altro)">x</p>'), "acss");
    expect(result.doc).toContain("padding: var(--xb-space-l);");
    expect(rootOf(result.doc)).toEqual([["--mio", "calc(var(--xb-space-m) * 2)"]]);
    // A declaration that is not a custom property stays in :root.
    expect(result.doc).toContain("color-scheme: light;");
    expect(result.doc).toContain('style="color: var(--xb-primary); margin: var(--altro)"');
    expect(result.unmapped).toEqual(["--mio", "--altro"]);
    expect(result.renamed).toEqual([{ from: "--space-m", to: "--xb-space-m", count: 1 }, { from: "--space-l", to: "--xb-space-l", count: 1 }, { from: "--primary", to: "--xb-primary", count: 1 }]);
    expect(result.notes).toContain("variabili senza corrispondenza in Histeon CSS, restano nel :root del prototipo: --mio, --altro");
  });

  it("lascia com'è un foglio che non si legge", () => {
    const broken = doc(".a { color: var(--primary); ");
    const result = convertProposalVariables(broken.replace("</style>", "</style><style>.b { color: var(--primary); }</style>"), "acss");
    expect(result.doc).toContain(".a { color: var(--primary);");
    expect(result.doc).toContain(".b { color: var(--xb-primary); }");
    expect(result.notes).toContain("un foglio di stile della proposta non si legge: lasciato com'è");
  });
});

describe("convertProposalVariables con Histeon", () => {
  it("toglie i --xb-* dal :root e ne prende i colori per il design", () => {
    const result = convertProposalVariables(fixtureDoc("proposte-histeon.html"), "histeon");
    expect(result.design).toEqual({ primary: "oklch(55% 0.2 265)" });
    expect(result.renamed).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.doc).not.toContain(":root");
    expect(result.doc).toContain("background: var(--xb-surface);");
    expect(result.notes).toEqual([
      "colori della proposta nel design di Histeon CSS: primary",
      "token di Histeon CSS presi dal design del progetto, non dal :root della proposta: 21",
    ]);
  });

  it("tiene le variabili proprie della proposta e non rinomina i nomi ACSS", () => {
    const result = convertProposalVariables(doc(":root {\n  --xb-primary: #112233;\n  --xb-success: #00aa00;\n  --mia: var(--xb-space-m);\n  --vecchia: 1px;\n}\n.a { padding: var(--mia); color: var(--primary); }"), "histeon");
    expect(result.design).toEqual({ primary: "#112233", success: "#00aa00", success_on: "1" });
    expect(rootOf(result.doc)).toEqual([["--mia", "var(--xb-space-m)"]]);
    expect(result.doc).toContain("color: var(--primary);");
    expect(result.unmapped).toEqual(["--mia", "--primary"]);
    expect(result.dropped).toEqual(["--vecchia"]);
  });
});

describe("convertProposalVariables senza framework", () => {
  it("non cambia niente e lo dice", () => {
    const input = doc(":root {\n  --mio: red;\n}\n.a { color: var(--mio); }");
    expect(convertProposalVariables(input, "none")).toEqual({ doc: input, design: {}, renamed: [], unmapped: [], dropped: [], notes: ["la proposta non usa le variabili di ACSS né di Histeon CSS: i valori restano com'erano"] });
  });
});
