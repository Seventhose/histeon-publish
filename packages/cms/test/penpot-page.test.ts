import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designFilePage, designFilePages } from "../src/design-file.js";
import { designPrototype, designPrototypeText } from "../src/design-prototype.js";
import { readDesignZip } from "../src/design-zip.js";
import { walkDesign, type DesignNode } from "../src/design-tree.js";
import { attachPenpotImages, penpotFrame, penpotObjectEntry, penpotPageEntry, penpotPageList, pickByName } from "../src/penpot-page.js";
import { id, PNG, siteEntries, siteShapes, zip } from "./penpot-writer.js";

const ID = "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f12";
const find = (root: DesignNode, name: string): DesignNode => {
  let found: DesignNode | null = null;
  walkDesign(root, (node) => { if (!found && node.name === name) found = node; });
  if (!found) throw new Error(`manca ${name}`);
  return found;
};

describe("pagine di un file .penpot", () => {
  it("elenca le pagine coi riquadri in cima e i loro livelli", async () => {
    const entries = await readDesignZip(await zip(siteEntries()), penpotPageEntry);
    expect(entries.files.has(`objects/${id(91)}.png`)).toBe(false);
    const list = penpotPageList(entries);
    expect(list).toMatchObject({ file: "Sito di prova", source: "penpot", pages: [{ name: "Home", frames: [{ name: "Home", width: 1200, height: 760 }] }] });
    // The hidden layer is counted: the list says what the file holds, not what will be written.
    expect(list.pages[0]!.frames[0]!.layers).toBe(siteShapes().length - 1);
  });

  it("legge un riquadro come albero: ordine a vista, layout, misure, componenti, immagini, tracciati", async () => {
    const bytes = await zip(siteEntries());
    const entries = await readDesignZip(bytes, penpotPageEntry);
    const page = penpotFrame(entries, "home", "Home");
    const root = page.root;
    // The file lists the children from the last to the first: the tree has them as the eye reads them.
    expect(root.children.map((child) => child.name)).toEqual(["Header", "Hero", "Cards", "Footer"]);
    expect(root.layout).toMatchObject({ mode: "column", gap: 0 });
    expect(find(root, "Header").layout).toMatchObject({ mode: "row", justify: "between", align: "center", padding: [24, 24, 24, 24] });
    const hero = find(root, "Hero");
    expect(hero.layout).toBeNull();
    expect(hero.box).toEqual({ x: 0, y: 80, width: 1200, height: 300 });
    expect(find(root, "h1").box).toMatchObject({ x: 100, y: 40 });
    expect(page.hidden).toBe(1);
    // The frame carries the number of the list, so the report can say both.
    expect(page.listed).toBe(siteShapes().length - 1);
    expect(hero.children.map((child) => child.name)).not.toContain("Nota nascosta");
    // A picture is named by the object that holds its bytes.
    const photo = find(root, "Foto del prodotto");
    expect(photo.kind).toBe("image");
    expect(photo.fills).toEqual([{ kind: "image", image: id(91) }]);
    expect(page.images.get(id(91))?.bytes.length).toBe(0);
    attachPenpotImages(page, await readDesignZip(bytes, penpotObjectEntry(page)));
    expect(Buffer.from(page.images.get(id(91))!.bytes).equals(PNG)).toBe(true);
    // A path is in the coordinates of its own box.
    expect(find(root, "Freccia").paths).toEqual([{ d: "M0 0L24 12L0 24Z", fill: { r: 29, g: 78, b: 216, alpha: 1 }, stroke: null, strokeWidth: 0, evenOdd: false }]);
    // Sizing in the two spellings; a text keeps only a width the designer fixed.
    const cards = find(root, "Cards").children.filter((child) => child.name === "Card");
    expect(cards.map((card) => card.sizing.horizontal)).toEqual(["fixed", "fill"]);
    expect(cards[0]!.component).toEqual({ id: id(10), name: "Card", main: false });
    expect(find(root, "Card title").sizing.horizontal).toBe("hug");
    expect(find(root, "Card copy").sizing.horizontal).toBe("fixed");
    expect(find(root, "Card title").text?.paragraphs[0]?.[0]).toMatchObject({ text: "Prima", sizePx: 20, family: "Inter", lineHeight: 1.4, color: { r: 26, g: 26, b: 26, alpha: 1 } });
    // A negative margin draws a layer over the one before: out of the flow.
    expect(find(root, "Background").absolute).toBe(true);
    expect(find(root, "Label").absolute).toBe(false);
  });

  it("sceglie pagina e riquadro per nome, per parte del nome o per id, e dice che cosa c'è quando non trova", () => {
    const items = [{ id: "a", name: "Home" }, { id: "b", name: "Home scura" }, { id: "c", name: "Contatti" }];
    expect(pickByName(items, " home ", "una pagina").id).toBe("a");
    expect(pickByName(items, "cont", "una pagina").id).toBe("c");
    expect(pickByName(items, "b", "una pagina").id).toBe("b");
    expect(() => pickByName(items, "o", "una pagina")).toThrow(/Più di una pagina ha «o» nel nome/u);
    expect(() => pickByName(items, "blog", "una pagina")).toThrow(/Nessun una pagina si chiama «blog»\. Ci sono: «Home», «Home scura», «Contatti»/u);
  });

  it("dà un prototipo con testata, piè di pagina, sezioni e nessuna coordinata", async () => {
    const bytes = await zip(siteEntries());
    const page = await designFilePage("sito.penpot", bytes, "Home", "Home");
    const { html, report } = designPrototype(page, { id: ID });
    expect(report.sections).toEqual(["header", "hero", "cards", "footer"]);
    expect(html).toContain('data-ref="site/header"');
    expect(html).toContain('data-ref="site/footer"');
    expect(html).toContain('<h1 class="hero__titolo">Un titolo grande</h1>');
    expect(html).toContain('alt="Foto del prodotto"');
    expect(html).toContain('<path d="M0 0L24 12L0 24Z" fill="#1d4ed8"/>');
    // The background of the button moved to its frame, which is a link.
    expect(html).toMatch(/<a class="cards__button" href="#"><span class="cards__testo">Scopri<\/span><\/a>/u);
    expect(html).toMatch(/&__button \{[^}]*background: #1d4ed8;[^}]*border-radius: var\(--xb-radius-full\)/u);
    expect(html).not.toMatch(/position: absolute|inset:|(?:^|[ ;])(?:left|top): |font-size: [\d.]+(?:px|rem)/u);
    expect(report.inferred).toContain("Hero");
    expect(report.hidden).toBe(1);
    // The number of the list and the layers written: the hidden one makes them differ, and the report says both.
    expect(report.listed).toBe(siteShapes().length - 1);
    expect(report.layers).toBeLessThan(report.listed!);
    expect(designPrototypeText(report)).toContain(`${report.listed} livelli nel riquadro, ${report.layers} nel prototipo (gli altri sono nascosti o non hanno niente da disegnare).`);
    expect(designPrototypeText({ ...report, listed: report.layers })).toContain(`px), ${report.layers} livelli.`);
    expect((await designFilePages("sito.penpot", bytes)).pages[0]!.name).toBe("Home");
    await expect(designFilePage("sito.penpot", bytes, "Home", "Blog")).rejects.toThrow(/sito\.penpot: Nessun un riquadro si chiama «Blog»/u);
    await expect(designFilePages("token.json", Buffer.from("{}"))).rejects.toThrow(/serve un file \.penpot o \.fig/u);
  });
});

// The real files the user gave, read where they are: skipped when they are not on this computer.
const DOWNLOADS = path.join(os.homedir(), "Scaricati");
const REAL: Array<[file: string, page: string, frame: string, sections: number]> = [
  ["Essential UI - Figma Ui Kit (Community).penpot", "Components", "desktop filter", 4],
  ["Essential UI - Figma Ui Kit (Community).penpot", "Components", "Contact", 3],
  ["Essential UI - Figma Ui Kit (Community).penpot", "Components", "Pricing Cards", 1],
  ["Material Design 3.penpot", "Components & Variations", "Cards", 5],
];

describe("riquadri di file .penpot veri", () => {
  for (const [file, pageName, frame, sections] of REAL) {
    it.skipIf(!existsSync(path.join(DOWNLOADS, file)))(`${file}, «${frame}»`, async () => {
      const page = await designFilePage(file, readFileSync(path.join(DOWNLOADS, file)), pageName, frame);
      const { html, report } = designPrototype(page, { id: ID });
      expect(report.sections).toHaveLength(sections);
      expect(report.layers).toBeGreaterThan(50);
      // A label of the kit named `h6` is not a heading: far fewer headings than texts.
      expect(report.headings).toBeLessThan(30);
      expect(report.headings).toBeGreaterThan(0);
      expect(html).not.toMatch(/position: absolute|inset:|(?:^|[ ;])(?:left|top): |font-size: [\d.]+(?:px|rem)/u);
      // One on the page; each type deduced from a row of cards has two plain pages of its own, each with its title.
      expect(html.match(/<h1[ >]/gu)).toHaveLength(1 + 2 * report.recordTypes.length);
      expect(Buffer.byteLength(html)).toBeLessThan(32 * 1024 * 1024);
    }, 60_000);
  }
});
