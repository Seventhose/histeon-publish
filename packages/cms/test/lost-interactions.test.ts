import { describe, expect, it } from "vitest";
import { lostInteractions } from "../src/lost-interactions.js";
import type { SiteElement, SiteNode } from "../src/site-structure.js";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";

const el = (tag: string, attrs: Record<string, string> = {}, ...children: Array<SiteNode | string>): SiteElement => ({ kind: "element", tag, attrs: Object.entries(attrs), children: children.map((child) => (typeof child === "string" ? { kind: "text", text: child } : child)) });

describe("«da rifare»: ciò che in una proposta fotografata aspettava uno script", () => {
  it("elenca pulsanti, campi fuori dai moduli, moduli senza indirizzo e link «#», dal più frequente", () => {
    const shop = [
      el("button", { class: "carrello-add primario", "data-add": "1", type: "button" }, "Aggiungi"),
      el("button", { class: "carrello-add", "data-add": "2", type: "button" }, "Aggiungi"),
      el("select", { class: "ordina", "data-sort": "" }),
      el("a", { href: "#" }, "Uno"),
      el("a", { href: "#" }, "Due"),
      el("a", { href: "#" }, "Tre"),
      el("a", { href: "#nota" }, "Ancora vera"),
      el("form", { class: "prenota" }, el("input", { type: "text" }), el("button", {}, "Invia"), el("button", { type: "button", class: "svuota" }, "Svuota")),
      el("form", { action: "/invia" }, el("button", {}, "Invia")),
      el("span", { class: "pillola", "aria-pressed": "false" }, "Filtro"),
    ];
    const lines = lostInteractions([{ slug: "home", nodes: shop }, { slug: "negozio", nodes: [el("button", { class: "carrello-add", "data-add": "3" }, "Aggiungi")] }]);
    expect(lines).toEqual([
      "da rifare: link «#», 3 volte in home: non portano da nessuna parte, lo script della proposta non è nel sito",
      "da rifare: pulsante .carrello-add [data-add] («Aggiungi»), 3 volte in ogni pagina: non risponde, lo script della proposta non è nel sito",
      "da rifare: campo .ordina [data-sort], 1 volta in home: non cambia niente, lo script della proposta non è nel sito",
      "da rifare: elemento .pillola («Filtro»), 1 volta in home: non risponde, lo script della proposta non è nel sito",
      "da rifare: modulo .prenota, 1 volta in home: non ha un indirizzo a cui inviare, lo script della proposta non è nel sito",
      "da rifare: pulsante .svuota («Svuota»), 1 volta in home: non risponde, lo script della proposta non è nel sito",
    ]);
  });

  it("lascia fuori ciò che ha una ricetta o funziona da solo", () => {
    expect(lostInteractions([{ slug: "home", nodes: [
      el("button", { class: "menu-toggle", "aria-expanded": "false", "aria-controls": "menu" }, "Menu"),
      el("button", { role: "tab", "aria-controls": "t1" }, "Uno"),
      el("details", {}, el("summary", {}, "Apri"), "Testo"),
      el("a", { href: "altra/" }, "Altra pagina"),
      el("form", { action: "https://example.org/invia" }, el("input", { type: "email" }), el("button", { type: "submit" }, "Invia")),
    ] }])).toEqual([]);
  });

  it("le parole del sito sono tagliate e ripulite, e l'elenco si ferma a venti righe", () => {
    const [line] = lostInteractions([{ slug: "home", nodes: [el("button", { class: `${"a".repeat(80)}` }, `Riga\u0000 uno\n«chiusa» ${"x".repeat(80)}`)] }]);
    expect(line).toContain(`pulsante .${"a".repeat(40)} («Riga uno chiusa xxxxxxxxxxxxxx»)`);
    const many = lostInteractions([{ slug: "home", nodes: Array.from({ length: 25 }, (_, index) => el("button", { class: `b${index}` }, "x")) }]);
    expect(many).toHaveLength(21);
    expect(many.at(-1)).toBe("da rifare: altri 5 tipi di elementi che aspettavano uno script");
  });

  it("la conversione lo scrive solo per una proposta fotografata, e non dice più che lo script resta", () => {
    const page = '<!doctype html><html lang="it"><head><title>P</title></head><body><header><button class="menu-toggle" aria-expanded="false" aria-controls="menu">Menu</button><nav id="menu"><a href="#">A</a></nav></header><main><button class="compra" type="button">Compra</button></main></body></html>';
    const files = [{ path: "index.html", bytes: new TextEncoder().encode(page) }];
    const captured = staticSiteToPrototype({ projectId: staticSiteProjectId("p"), name: "P", files, captured: true }).report.notes.join("\n");
    expect(captured).toContain("da rifare: pulsante .compra («Compra»), 1 volta in home: non risponde");
    expect(captured).toContain("proposta: menu mobile (1) funziona anche senza JavaScript");
    expect(captured).toContain("nella proposta fotografata lo script non c'è più: senza la ricetta non risponde");
    expect(captured).not.toContain("lo script del sito resta");
    const plain = staticSiteToPrototype({ projectId: staticSiteProjectId("p"), name: "P", files }).report.notes.join("\n");
    expect(plain).not.toContain("da rifare");
    expect(plain).toContain("lo script del sito resta");
  });
});
