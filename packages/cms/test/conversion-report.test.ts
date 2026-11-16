import { expect, test } from "vitest";
import { breakpointNotes, conversionNoteKind, groupConversionNotes } from "../src/conversion-report.js";

test("the import report groups what was removed, moved to JavaScript, breakpoints and what to check (doc 23 item 163)", () => {
  expect(conversionNoteKind("3 × gestore di eventi tolto")).toEqual("removed");
  expect(conversionNoteKind("gestore di eventi portato nel JavaScript della pagina (addEventListener)")).toEqual("script");
  expect(conversionNoteKind("<dialog> tenuto come blocco nascosto: il JavaScript della pagina gli ridà showModal() e close()")).toEqual("script");
  expect(conversionNoteKind("@media fino a 768px (2 volte): nessuna media query con nome uguale; la più vicina è --mobile (40em = 640px)")).toEqual("breakpoint");
  expect(conversionNoteKind("immagine senza testo alternativo: aggiunto alt vuoto, scrivilo se l'immagine dice qualcosa")).toEqual("check");
  const groups = groupConversionNotes(["immagine SVG tolta: le icone si scrivono in linea", "modulo senza un indirizzo d'invio valido: restano i campi, il modulo va collegato", "<iframe> tolto"]);
  expect(groups.map((g) => [g.kind, g.items.length])).toEqual([["removed", 2], ["check", 1]]);
  // A captured proposal: what waited for a script has a group of its own, even when the line quotes a word of the others.
  expect(conversionNoteKind("da rifare: pulsante .tolto («Sostituito»), 1 volta in home: non risponde, lo script della proposta non è nel sito")).toEqual("redo");
  expect(conversionNoteKind("3 × da rifare: link «#», 3 volte in home: non portano da nessuna parte")).toEqual("redo");
  expect(conversionNoteKind("niente da rifare: tutto a posto")).toEqual("check");
  expect(groupConversionNotes(["da rifare: link «#», 1 volta in home", "@media fino a 640px (1 volta): è --mobile", "immagine senza testo alternativo"]).map((g) => g.kind)).toEqual(["breakpoint", "redo", "check"]);
});

test("the site's media queries against the named ones", () => {
  const notes = breakpointNotes([
    "@media (max-width: 64em) { .a { color: red } } @media (max-width: 1024px) { .b { color: red } }",
    "@media screen and (min-width: 1024px) { .c { color: red } } @media (width < 768px) { .d { color: red } }",
  ]);
  expect(notes[0]).toMatch(/^@media fino a 64em \(2 volte\): è --tablet/u);
  expect(notes.some((n) => /^@media da 1024px \(1 volta\): è --desktop/u.test(n))).toBe(true);
  expect(notes.some((n) => /^@media fino a 768px .*la più vicina è --mobile/u.test(n))).toBe(true);
});
