import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isProposalsFile, PROPOSAL_DOC_MAX_BYTES, PROPOSALS_MAX, proposalFramework, readProposalsFile } from "../src/proposal-import.js";

// Voce 2: il file unico di `kit proposte` (un visore con i dati in <script type="application/json" id="kp-dati">).
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const viewer = (data: unknown): string => `<!doctype html><html lang="it"><head><title>Proposte</title></head><body><main></main><script type="application/json" id="kp-dati">${JSON.stringify(data).replace(/</gu, "\\u003c")}</script><script>void 0;</script></body></html>`;
const DOC = "<!doctype html><html><head><style>:root {\n  --primary: #123456;\n}\nbody { color: var(--primary); }</style></head><body><h1>Ciao</h1></body></html>";
const proposal = (id: string, extra: Record<string, unknown> = {}) => ({ id, nome: `Nome ${id}`, gruppo: "", idea: "", doc: DOC, ...extra });

describe("isProposalsFile", () => {
  it("riconosce il visore di kit proposte e nient'altro", () => {
    expect(isProposalsFile(fixture("proposte-acss.html"))).toBe(true);
    expect(isProposalsFile(fixture("proposte-histeon.html"))).toBe(true);
    expect(isProposalsFile(viewer({ titolo: "x", gruppi: [], proposte: [] }))).toBe(true);
    expect(isProposalsFile("<!doctype html><html><body><h1>Un sito</h1></body></html>")).toBe(false);
    // Serve proprio un elemento script con quell'id: il testo nella pagina non basta.
    expect(isProposalsFile('<!doctype html><html><body><p>id="kp-dati"</p><div id="kp-dati"></div></body></html>')).toBe(false);
    expect(isProposalsFile('<!doctype html><html><body><script id="kp-dati">{}</script></body></html>')).toBe(false);
  });
});

describe("readProposalsFile", () => {
  it("legge titolo, gruppi e proposte del file vero", () => {
    const file = readProposalsFile(fixture("proposte-acss.html"));
    expect(file.title).toBe("Trattoria");
    expect(file.groups).toEqual([{ id: "calde", name: "Calde" }, { id: "fresche", name: "Fresche" }]);
    expect(file.proposals.map(({ id, name, group, idea }) => ({ id, name, group, idea }))).toEqual([
      { id: "p01", name: "Brace", group: "calde", idea: "Rosso mattone e schede dei piatti" },
      { id: "p02", name: "Orto", group: "fresche", idea: "Verde e testo ampio" },
    ]);
    expect(file.proposals[0]?.doc).toMatch(/^<!doctype html>/u);
    expect(file.proposals[0]?.doc).toContain('<article class="piatto">');
    const histeon = readProposalsFile(fixture("proposte-histeon.html"));
    expect(histeon.title).toBe("Libreria");
    expect(histeon.groups).toEqual([]);
    expect(histeon.proposals.map((item) => item.id)).toEqual(["h01"]);
  });

  it("dà i valori di serie e taglia i testi lunghi", () => {
    const file = readProposalsFile(viewer({ proposte: [{ id: "a1", doc: DOC }, proposal("b2", { nome: `  ${"n".repeat(300)}  `, gruppo: 7, idea: "i".repeat(900) })], gruppi: [{ id: "g", nome: "G" }, { id: 3 }, "x", { id: "h", nome: "H".repeat(200) }] }));
    expect(file.title).toBe("Proposte");
    expect(file.groups).toEqual([{ id: "g", name: "G" }, { id: "h", name: "H".repeat(120) }]);
    expect(file.proposals[0]).toEqual({ id: "a1", name: "a1", group: "", idea: "", doc: DOC });
    expect(file.proposals[1]?.name).toBe("n".repeat(120));
    expect(file.proposals[1]?.group).toBe("");
    expect(file.proposals[1]?.idea).toBe("i".repeat(500));
    expect(readProposalsFile(viewer({ titolo: `  ${"t".repeat(250)} `, proposte: [proposal("a")] })).title).toBe("t".repeat(200));
  });

  it("rifiuta con un messaggio in italiano quello che non è un file di proposte valido", () => {
    expect(() => readProposalsFile("<!doctype html><html><body></body></html>")).toThrow(new TypeError("Il file non è un file di proposte di kit proposte: manca il blocco kp-dati."));
    expect(() => readProposalsFile('<!doctype html><html><body><script type="application/json" id="kp-dati">{nope</script></body></html>')).toThrow(new TypeError("Il blocco kp-dati del file di proposte non è JSON valido."));
    expect(() => readProposalsFile(viewer([1, 2]))).toThrow(new TypeError("Il blocco kp-dati del file di proposte non ha l'elenco delle proposte."));
    expect(() => readProposalsFile(viewer({ proposte: "no" }))).toThrow(new TypeError("Il blocco kp-dati del file di proposte non ha l'elenco delle proposte."));
    expect(() => readProposalsFile(viewer({ proposte: [] }))).toThrow(new TypeError("Il file di proposte non contiene proposte."));
    const many = Array.from({ length: PROPOSALS_MAX + 1 }, (_, index) => proposal(`p${index}`));
    expect(() => readProposalsFile(viewer({ proposte: many }))).toThrow(new TypeError(`Il file di proposte ha ${PROPOSALS_MAX + 1} proposte: al massimo ${PROPOSALS_MAX}.`));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("a"), proposal("B")] }))).toThrow(new TypeError("La proposta 2 del file non ha un id valido."));
    expect(() => readProposalsFile(viewer({ proposte: [{ nome: "x", doc: DOC }] }))).toThrow(new TypeError("La proposta 1 del file non ha un id valido."));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("a".repeat(41))] }))).toThrow(new TypeError("La proposta 1 del file non ha un id valido."));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("-a")] }))).toThrow(new TypeError("La proposta 1 del file non ha un id valido."));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("a"), proposal("a")] }))).toThrow(new TypeError("Due proposte del file hanno lo stesso id «a»."));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("a", { doc: 3 })] }))).toThrow(new TypeError("La proposta «a» non ha il documento HTML."));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("a", { doc: "   " })] }))).toThrow(new TypeError("La proposta «a» non ha il documento HTML."));
    expect(() => readProposalsFile(viewer({ proposte: [proposal("a", { doc: `<p>${"è".repeat(PROPOSAL_DOC_MAX_BYTES / 2)}</p>` })] }))).toThrow(new TypeError("La proposta «a» supera 8 MB."));
  });

  it("legge i limiti esportati", () => {
    expect(PROPOSALS_MAX).toBe(50);
    expect(PROPOSAL_DOC_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("proposalFramework", () => {
  const doc = (root: string) => `<!doctype html><html><head><style>${root}\nbody { margin: 0; }</style></head><body></body></html>`;
  it("riconosce il framework dai nomi del :root", () => {
    const acss = readProposalsFile(fixture("proposte-acss.html")).proposals[0]?.doc ?? "";
    const histeon = readProposalsFile(fixture("proposte-histeon.html")).proposals[0]?.doc ?? "";
    expect(proposalFramework(acss)).toBe("acss");
    expect(proposalFramework(histeon)).toBe("histeon");
    expect(proposalFramework(doc(":root {\n  --xb-primary: #000;\n  --mio: 1px;\n}"))).toBe("histeon");
    expect(proposalFramework(doc(":root {\n  --space-m: 1rem;\n}"))).toBe("acss");
    // Un nome di serie di ACSS che kit usa, anche se la tabella del builder non lo ha.
    expect(proposalFramework(doc(":root {\n  --text-dark: #000;\n}"))).toBe("acss");
    expect(proposalFramework(doc(":root {\n  --mio-colore: red;\n}"))).toBe("none");
    expect(proposalFramework(doc(""))).toBe("none");
    // Solo le regole :root contano, non le variabili di un altro selettore.
    expect(proposalFramework(doc(".scuro {\n  --xb-primary: red;\n}"))).toBe("none");
  });
});
