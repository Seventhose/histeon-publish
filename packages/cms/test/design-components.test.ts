import { describe, expect, it } from "vitest";
import { designPrototype, designPrototypeText } from "../src/design-prototype.js";
import { type DesignColor, type DesignLayout, type DesignNode, designNode, type DesignPage } from "../src/design-tree.js";

const ID = "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f10";
const INK: DesignColor = { r: 20, g: 20, b: 20, alpha: 1 };
const LONG = "Un testo di prova abbastanza lungo da essere il testo corrente della pagina, più lungo di ogni altro.";

const flex = (mode: "row" | "column", gap: number): DesignLayout => ({ mode, gap, crossGap: 0, padding: [0, 0, 0, 0], justify: "start", align: "start", wrap: false, columns: 0 });

function text(name: string, words: string, sizePx: number, y: number): DesignNode {
  return designNode({
    id: `t-${name}-${words}`, name, kind: "text", box: { x: 0, y, width: 280, height: Math.round(sizePx * 1.4) }, sizing: { horizontal: "hug", vertical: "hug" },
    text: { align: "left", paragraphs: [[{ text: words, sizePx, weight: 400, italic: false, family: "Inter", lineHeight: null, letterSpacingPx: 0, color: INK, underline: false, transform: "", link: "" }]] },
  });
}

/** The first bytes of a PNG: enough for the writer to read its type and its size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A page with one section: a title, a paragraph and a row of cards. */
function page(name: string, cards: DesignNode[], images: string[] = []): DesignPage {
  const row = designNode({ id: "fila", name: "Fila", kind: "frame", box: { x: 0, y: 120, width: 940, height: 220 }, layout: flex("row", 20), sizing: { horizontal: "hug", vertical: "hug" }, children: cards });
  const section = designNode({ id: "sezione", name, kind: "frame", box: { x: 0, y: 0, width: 1440, height: 340 }, layout: flex("column", 24), sizing: { horizontal: "fill", vertical: "hug" }, children: [text("Titolo pagina", "Il catalogo", 40, 0), text("Testo", LONG, 16, 70), row] });
  const root = designNode({ id: "radice", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 340 }, layout: flex("column", 0), sizing: { horizontal: "fixed", vertical: "hug" }, children: [section] });
  return { file: "Prova", page: "Pagina", frame: "Home", source: "figma", root, images: new Map(images.map((key) => [key, { bytes: png(300, 200), mime: "image/png", width: 300, height: 200 }])), hidden: 0, problems: [] };
}

function product(n: number, name: string, price: string, pictureWidth = 120): DesignNode {
  return designNode({
    id: `prodotto-${n}`, name: "Prodotto", kind: "frame", box: { x: n * 320, y: 0, width: 300, height: 220 }, layout: flex("column", 8), sizing: { horizontal: "fixed", vertical: "hug" },
    children: [
      designNode({ id: `foto-${n}`, name: "Foto", kind: "image", box: { x: 0, y: 0, width: pictureWidth, height: 100 }, fills: [{ kind: "image", image: `foto-${n}` }] }),
      text("Nome", name, 24, 108),
      text("Prezzo", price, 16, 150),
    ],
  });
}

const products = (widths = [120, 120, 120]) => page("Catalogo", [product(0, "Vaso blu", "€ 12", widths[0]), product(1, "Tazza rossa", "€ 8", widths[1]), product(2, "Ciotola", "€ 15", widths[2])], ["foto-0", "foto-1", "foto-2"]);

function card(n: number, title: string, variant: string, fill: DesignColor): DesignNode {
  return designNode({
    id: `scheda-${n}`, name: "Scheda", kind: "frame", box: { x: n * 320, y: 0, width: 300, height: 160 }, layout: flex("column", 8), sizing: { horizontal: "fixed", vertical: "hug" }, fills: [{ kind: "solid", color: fill }],
    component: { id: variant, name: "Scheda", main: false, variant }, children: [text("Titolo", title, 24, 0), text("Testo", "Lo stesso testo in ogni scheda.", 16, 44)],
  });
}

describe("designComponents, through the writer", () => {
  it("writes the copies of a component of the design as one component, and a variant as a modifier", () => {
    const white = { r: 255, g: 255, b: 255, alpha: 1 };
    const { html, report } = designPrototype(page("Schede", [card(0, "Uno", "Stato=Base", white), card(1, "Due", "Stato=Base", white), card(2, "Tre", "Stato=Hover", { r: 31, g: 58, b: 147, alpha: 1 })]), { id: ID });
    expect(html).toContain('<template data-histos="component" data-ref="scheda" data-title="Scheda"');
    expect(html).toContain('class="scheda scheda--{props.variante}"');
    expect(html).toContain('<Scheda titolo="Uno" />');
    expect(html).toContain('<Scheda titolo="Tre" variante="hover" />');
    expect(html).toContain("&--hover { background: #1f3a93; }");
    expect(html).not.toContain("schede__scheda");
    expect(html).not.toMatch(/font-size:\s*[\d.]/u);
    expect(report.components).toEqual([expect.objectContaining({ ref: "scheda", copies: 3, variants: ["hover"], props: ["titolo"], slots: [], declared: true, type: "" })]);
    expect(report.designComponents).toEqual([{ name: "Scheda", copies: 3, made: 3, nested: 0, loose: 0 }]);
    expect(designPrototypeText(report)).toContain("Componenti del design usati nel riquadro: 1, con 3 copie. Riconosciuti come componenti del prototipo: 1 («Scheda»).");
  });

  it("writes a row of cards with other words and pictures as records read by a loop", () => {
    const { html, report } = designPrototype(products(), { id: ID });
    expect(html).toContain('<template data-histos="component" data-ref="prodotto"');
    expect(html).toContain("src={props.foto}");
    expect(html).toContain("{#loop prodotto_elenco() as voce}<Prodotto foto={voce.fields.foto} nome={voce.title} prezzo={voce.fields.prezzo} />{/loop}");
    expect(html).toContain('<script type="application/json" data-histos="content">');
    expect(html).toContain('{"type":"prodotto","slug":"vaso-blu","title":"Vaso blu","publishedAt":"2026-01-01T00:00:00Z","order":1,"values":{"foto":"asset:img-1","prezzo":"€ 12"}}');
    expect(html).toContain('{"key":"prodotto_elenco","label":"Prodotto","type":"prodotto","limit":3,"orderBy":"order","order":"asc"}');
    expect(html).toContain('data-ref="schede/prodotto" data-title="Prodotto"');
    expect(html).toContain('data-ref="schede/prodotto-elenco"');
    expect(html).toContain('<h1 class="elenco__titolo">{page.title}</h1><p class="elenco__testo">{page.fields.prezzo}</p>{@slot}');
    expect(report.recordTypes).toEqual([{ key: "prodotto", records: 3, queries: 1 }]);
    expect(report.components).toEqual([expect.objectContaining({ ref: "prodotto", copies: 3, declared: false, type: "prodotto" })]);
  });

  it("keeps the cards as uses of the component, or as plain elements, when asked", () => {
    const uses = designPrototype(products(), { id: ID, records: false });
    expect(uses.html).not.toContain('data-histos="content"');
    expect(uses.html.match(/<Prodotto /gu)).toHaveLength(3);
    expect(uses.html).toContain('<Prodotto nome="Vaso blu" prezzo="€ 12">{#slot foto}<img class="prodotto__foto" src="asset:img-1"');
    const plain = designPrototype(products(), { id: ID, components: false });
    expect(plain.html).not.toContain('data-histos="component"');
    expect(plain.html).toContain('class="catalogo__prodotto"');
    expect(plain.report.components).toEqual([]);
  });

  it("makes records of cards whose pictures sit differently only with uniform", () => {
    const uneven = designPrototype(products([120, 90, 150]), { id: ID });
    expect(uneven.report.recordTypes).toEqual([]);
    expect(uneven.report.components).toEqual([expect.objectContaining({ ref: "prodotto", copies: 3, slots: ["foto"], uneven: true })]);
    expect(uneven.html).toContain("prodotto__foto-2");
    const uniform = designPrototype(products([120, 90, 150]), { id: ID, uniform: true });
    expect(uniform.report.recordTypes).toEqual([{ key: "prodotto", records: 3, queries: 1 }]);
    expect(uniform.html).toContain("object-fit: contain");
    expect(uniform.html).not.toContain("prodotto__foto-2");
  });
});
