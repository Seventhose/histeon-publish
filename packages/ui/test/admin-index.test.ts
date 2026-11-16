import { describe, expect, it } from "vitest";
import { filterDocuments, searchable, sortDocuments, tableWindow, versionsBySource, type AdminDocument, type AdminLink } from "../src/lib/admin-index.js";

const document = (fields: Partial<AdminDocument>): AdminDocument => ({ id: "1", alias: 1, kind: "page", title: "Titolo", slug: "titolo", status: "draft", locale: null, templateRef: null, publishedAt: null, head: "h", updatedAt: "2026-11-01", address: "/titolo/", ...fields });

describe("indice dell'amministrazione", () => {
  it("cerca senza accenti né maiuscole", () => {
    expect(searchable("Città Èlite")).toBe("citta elite");
    expect(filterDocuments([document({ title: "Città" })], { search: "citta", status: "", language: "" })).toHaveLength(1);
  });

  it("mostra la lingua del sito, salvo scelta diversa", () => {
    const items = [document({ id: "1" }), document({ id: "2", locale: "en" })];
    expect(filterDocuments(items, { search: "", status: "", language: "" }).map((item) => item.id)).toEqual(["1"]);
    expect(filterDocuments(items, { search: "", status: "", language: "en" }).map((item) => item.id)).toEqual(["2"]);
    expect(filterDocuments(items, { search: "", status: "", language: "*" })).toHaveLength(2);
  });

  it("ordina con i numeri in ordine naturale", () => {
    const items = [document({ id: "a", title: "Pagina 10", alias: 1 }), document({ id: "b", title: "Pagina 2", alias: 2 })];
    expect(sortDocuments(items, "title", 1).map((item) => item.id)).toEqual(["b", "a"]);
    expect(sortDocuments(items, "title", -1).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("disegna solo la finestra visibile della tabella", () => {
    expect(tableWindow(5000, 0, 480, 48)).toEqual({ start: 0, end: 18 });
    expect(tableWindow(5000, 4800, 480, 48)).toEqual({ start: 92, end: 118 });
    expect(tableWindow(5, 0, 480, 48)).toEqual({ start: 0, end: 5 });
  });

  it("raggruppa le versioni per originale", () => {
    const link = (translationId: string, sourceId: string): AdminLink => ({ translationId, sourceId, kind: "page", language: "en", mode: "follow", state: "draft" });
    expect(versionsBySource([link("a", "s"), link("b", "s"), link("c", "t")]).get("s")).toHaveLength(2);
  });
});
