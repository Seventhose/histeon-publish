import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { proposalSite } from "../src/proposal-import.js";
import { staticSiteToPrototype } from "../src/static-site-prototype.js";

// Voce 2: dalla proposta scelta al «sito» di una pagina che la conversione di sempre trasforma in prototipo.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const manifestOf = (html: string): Record<string, unknown> => JSON.parse(/<script data-histos="manifest" type="application\/json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "{}") as Record<string, unknown>;

describe("proposalSite", () => {
  it("prepara la proposta scelta come index.html con nome, design e note", () => {
    const site = proposalSite(fixture("proposte-acss.html"), "p01");
    expect(site.name).toBe("Trattoria · Brace");
    expect(site.title).toBe("Trattoria");
    expect(site.proposal).toEqual({ id: "p01", name: "Brace" });
    expect(site.framework).toBe("acss");
    expect(site.files).toHaveLength(1);
    expect(site.files[0]?.path).toBe("index.html");
    const page = decode(site.files[0]?.bytes ?? new Uint8Array());
    expect(page).toContain("var(--xb-primary)");
    expect(page).not.toContain("var(--primary)");
    expect(site.design).toEqual({ primary: "oklch(0.55 0.15 30)" });
    expect(site.notes[0]).toBe("proposta «p01 · Brace» dal file «Trattoria», scritta con ACSS");
    expect(site.notes.slice(1)).toEqual([
      "ACSS → Histeon CSS: 17 variabili convertite (--black → --xb-black, --white → --xb-white, --radius → --xb-radius-m, --text-m → --xb-text-m, --text-dark → --xb-text, --space-l → --xb-space-l, --space-m → --xb-space-m, --h1 → --xb-h1 e altre 9)",
      "colori della proposta nel design di Histeon CSS: primary",
      "variabile senza corrispondenza in Histeon CSS, resta nel :root del prototipo: --text-light-muted",
      "variabili non più usate tolte dal :root: --base",
    ]);
  });

  it("dice il framework nella prima nota e taglia il nome a 80 caratteri", () => {
    const histeon = proposalSite(fixture("proposte-histeon.html"), "h01");
    expect(histeon.name).toBe("Libreria · Scaffale");
    expect(histeon.framework).toBe("histeon");
    expect(histeon.notes[0]).toBe("proposta «h01 · Scaffale» dal file «Libreria», scritta con Histeon CSS");
    const long = fixture("proposte-histeon.html").replace('"titolo":"Libreria"', `"titolo":"${"L".repeat(100)}"`);
    expect(proposalSite(long, "h01").name).toBe("L".repeat(80));
    const plain = '<!doctype html><html><body><script type="application/json" id="kp-dati">{"titolo":"T","proposte":[{"id":"a","nome":"A","doc":"<!doctype html><html><head><style>.a { color: red; }</style></head><body><p class=\\"a\\">x</p></body></html>"}]}</script></body></html>';
    const site = proposalSite(plain, "a");
    expect(site.framework).toBe("none");
    expect(site.notes).toEqual(["proposta «a · A» dal file «T», scritta senza le variabili di un framework", "la proposta non usa le variabili di ACSS né di Histeon CSS: i valori restano com'erano"]);
    expect(site.design).toEqual({});
  });

  it("rifiuta una proposta che il file non ha", () => {
    expect(() => proposalSite(fixture("proposte-acss.html"), "p09")).toThrow(new TypeError("Il file di proposte non ha la proposta «p09»."));
    expect(() => proposalSite("<!doctype html><p>no</p>", "p01")).toThrow(new TypeError("Il file non è un file di proposte di kit proposte: manca il blocco kp-dati."));
  });
});

describe("staticSiteToPrototype con il design della proposta", () => {
  it("mette il design passato sopra quello letto dal CSS, e riconosce schede ed elenchi", () => {
    const site = proposalSite(fixture("proposte-acss.html"), "p01");
    const out = staticSiteToPrototype({ projectId: "11111111-2222-4333-8444-555555555555", name: site.name, files: site.files, framework: "histos-css", structure: { parts: false, components: true, lists: true }, design: site.design });
    const manifest = manifestOf(out.html);
    expect(manifest.name).toBe("Trattoria · Brace");
    expect(manifest.framework).toBe("histos-css");
    // font_body comes from the CSS (Georgia), primary from the proposal's :root.
    expect(manifest.design).toEqual({ font_body: "Georgia, serif", primary: "oklch(0.55 0.15 30)" });
    expect(out.design).toEqual({ font_body: "Georgia, serif", primary: "oklch(0.55 0.15 30)" });
    expect(out.html).toContain("{#loop piatto_elenco() as item}<Piatto ");
    expect(out.html).toContain('data-ref="piatto"');
    expect(out.report.notes).toContain("1 blocco ripetuto diventa un componente: piatto (3 usi)");
  });

  it("scarta dal design passato le chiavi che Histeon CSS non accetta, e senza token non scrive il design", () => {
    const site = proposalSite(fixture("proposte-acss.html"), "p01");
    const out = staticSiteToPrototype({ projectId: "11111111-2222-4333-8444-555555555555", name: site.name, files: site.files, framework: "histos-css", design: { primary: "hsl(1 2% 3%)", secondary: "#1f6f5c", sconosciuta: "1" } });
    expect(manifestOf(out.html).design).toEqual({ font_body: "Georgia, serif", secondary: "#1f6f5c" });
    const none = staticSiteToPrototype({ projectId: "11111111-2222-4333-8444-555555555555", name: site.name, files: site.files, framework: "none", design: { secondary: "#1f6f5c" } });
    expect(manifestOf(none.html).design).toBeUndefined();
  });
});
