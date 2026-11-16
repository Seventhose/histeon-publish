import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designFilePage, designFilePages } from "../src/design-file.js";
import { type DesignNode, walkDesign } from "../src/design-tree.js";
import { figFontWeight, figFrame, figPageList, figPathCommands } from "../src/fig-page.js";
import { HAS_ZSTD, IMAGE_KEY, pathBlob, PNG, siteCanvas, siteNodes, zip } from "./fig-writer.js";

const find = (root: DesignNode, name: string): DesignNode[] => {
  const found: DesignNode[] = [];
  walkDesign(root, (node) => { if (node.name === name) found.push(node); });
  return found;
};
const words = (node: DesignNode) => node.text?.paragraphs.map((runs) => runs.map((run) => run.text).join("")).join("|") ?? "";

describe("the page of a Figma file made by hand", () => {
  it("lists the pages the user sees and the frames at the top, counting the layers of the copies", () => {
    const site = siteNodes();
    const list = figPageList(siteCanvas(site), "Bottega");
    expect(list.source).toBe("figma");
    expect(list.pages.map((page) => page.name)).toEqual(["Sito"]);
    const frames = list.pages[0]!.frames;
    // The children of the page in the order of their position, not of the file.
    expect(frames.map((frame) => frame.name)).toEqual(["Pulsante", "Scheda", "Home", "Doppio", "Doppio"]);
    expect(frames[2]).toMatchObject({ id: site.ids.home, width: 1440, height: 900, layers: 27 });
  });

  it("reads the auto layout, the sizes and the look of the layers", () => {
    const page = figFrame(siteCanvas(), "Bottega", "sito", "home");
    expect(page).toMatchObject({ file: "Bottega", page: "Sito", frame: "Home", source: "figma" });
    const root = page.root;
    expect(root.layout).toMatchObject({ mode: "column", gap: 0 });
    expect(root.sizing).toEqual({ horizontal: "fixed", vertical: "fixed" });
    expect(root.children.map((child) => child.name)).toEqual(["Header", "Hero", "Schede", "Disegni"]);
    const [header, hero, cards] = root.children as [DesignNode, DesignNode, DesignNode];
    // Spread from end to end: the space that came out is not a gap.
    expect(header.layout).toMatchObject({ mode: "row", justify: "between", align: "center", gap: 0, padding: [0, 120, 0, 120] });
    expect(header.sizing).toEqual({ horizontal: "fill", vertical: "fixed" });
    expect(header.children[1]!.text!.paragraphs[0]![0]).toMatchObject({ text: "Scrivici", link: "https://example.com/contatti", sizePx: 16, weight: 400 });
    expect(hero.layout).toMatchObject({ mode: "column", gap: 24, align: "center", padding: [64, 120, 64, 120] });
    expect(hero.sizing).toEqual({ horizontal: "fill", vertical: "hug" });
    const title = hero.children[0]!;
    expect(words(title)).toBe("Vasi fatti a mano|uno per uno");
    expect(title.text!.align).toBe("center");
    expect(title.text!.paragraphs[0]!.map((run) => [run.text, run.weight, run.italic])).toEqual([["Vasi ", 600, false], ["fatti", 700, true], [" a mano", 600, false]]);
    expect(title.text!.paragraphs[0]![0]!.lineHeight).toBe(1.1);
    expect(title.sizing).toEqual({ horizontal: "fixed", vertical: "hug" });
    const photo = hero.children[1]!;
    expect(photo).toMatchObject({ kind: "image", radii: [12, 12, 12, 12], fills: [{ kind: "image", image: IMAGE_KEY }] });
    expect(page.images.has(IMAGE_KEY)).toBe(true);
    const badge = hero.children[2]!;
    expect(badge).toMatchObject({ kind: "shape", round: true, absolute: true, fills: [{ kind: "linear", angle: 180 }] });
    expect(cards.layout).toMatchObject({ mode: "row", gap: 32 });
    expect(page.hidden).toBe(2);
  });

  it("builds the children of a copy from its component, with its changes and those of the copy around", () => {
    const site = siteNodes();
    const { ids } = site;
    const page = figFrame(siteCanvas(site), "Bottega", "Sito", "Home");
    const [first, second] = find(page.root, "Scheda") as [DesignNode, DesignNode];
    // What the copy does not say comes from the component: the layout, the fill, the border of one side.
    expect(first.layout).toMatchObject({ mode: "column", gap: 12, padding: [16, 16, 16, 16] });
    expect(first.fills).toEqual([{ kind: "solid", color: { r: 255, g: 255, b: 255, alpha: 1 } }]);
    expect(first.stroke).toMatchObject({ width: 2, sides: [0, 0, 2, 0] });
    expect(first.component).toEqual({ id: ids.card, name: "Scheda", variant: "Tipo=Base", main: false });
    expect(first.sizing.horizontal).toBe("fill");
    expect(second.sizing.horizontal).toBe("fixed");
    // The title is changed by its key, and takes the size the layout computed.
    expect(first.children.map(words)).toEqual(["Vaso blu", ""]);
    expect(first.children[0]).toMatchObject({ id: `${ids.first};${ids.cardTitle}`, box: { width: 268, height: 60 }, sizing: { horizontal: "fill", vertical: "hug" } });
    // The copy of the button inside the card: the outer copy changes the text inside it, through two keys.
    const button = first.children[1]!;
    expect(button).toMatchObject({ kind: "frame", name: "Pulsante", component: { id: ids.button, name: "Pulsante", main: false }, radii: [8, 8, 8, 8] });
    expect(button.children.map(words)).toEqual(["Compra"]);
    expect(button.children[0]!.id).toBe(`${ids.first};${ids.cardButton};${ids.buttonText}`);
    expect(button.children[0]!.text!.paragraphs[0]![0]!.color).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    // The second copy keeps the words of the component and hides the button.
    expect(second.children.map(words)).toEqual(["Titolo della scheda"]);
    // A copy whose component is not in the file is left out and said.
    expect(find(page.root, "Persa")).toEqual([]);
    expect(page.problems.map((problem) => problem.why)).toContain("copia senza il suo componente nel file: resta vuota");
    // The component itself is a frame like the others.
    const main = figFrame(siteCanvas(site), "Bottega", "Sito", "Pulsante");
    expect(main.root.component).toEqual({ id: ids.button, name: "Pulsante", main: true });
    expect(main.root.children.map(words)).toEqual(["Scopri"]);
  });

  it("reads the drawings from the blobs, a mask and what it cannot read", () => {
    const page = figFrame(siteCanvas(), "Bottega", "Sito", "Home");
    const [arrow] = find(page.root, "Freccia");
    expect(arrow).toMatchObject({ kind: "vector", box: { x: 120, y: 40, width: 24, height: 24 } });
    expect(arrow!.paths).toEqual([{ d: "M0 12L24 12C20 0 20 24 12 24Z", fill: { r: 17, g: 17, b: 17, alpha: 1 }, stroke: null, strokeWidth: 0, evenOdd: true }]);
    // A mirrored layer: the points go through its matrix.
    const [turned] = find(page.root, "Freccia girata");
    expect(turned!.box).toMatchObject({ x: 200, y: 40, width: 24, height: 24 });
    expect(turned!.paths[0]!.d).toBe("M24 12L0 12C4 0 4 24 12 24Z");
    expect(turned!.unsupported).toEqual([]);
    // A straight line stays a line with its stroke.
    expect(find(page.root, "Filetto")[0]!.paths).toEqual([{ d: "M0 0L400 0", fill: null, stroke: { r: 153, g: 153, b: 153, alpha: 1 }, strokeWidth: 2, evenOdd: false }]);
    expect(find(page.root, "Rotto")[0]!.paths).toEqual([]);
    expect(page.problems.map((problem) => problem.why)).toContain("tracciato con comandi non letti: resta vuoto o incompleto");
    // The group takes the box and the shape of its mask; what it cuts moves with it.
    const [group] = find(page.root, "Tondo");
    expect(group).toMatchObject({ box: { x: 950, y: 30, width: 80, height: 80 }, clip: true, round: true, unsupported: ["maschera"] });
    expect(group!.children.map((child) => [child.name, child.box.x, child.box.y])).toEqual([["Ritratto", -50, -10]]);
    expect(find(page.root, "Nascosto")).toEqual([]);
  });

  it("says when other frames of the page have the same name, and takes one by its id", () => {
    const site = siteNodes();
    const first = figFrame(siteCanvas(site), "Bottega", "Sito", "Doppio");
    expect(first.root.id).toBe(site.ids.twinA);
    expect(first.twins).toBe(1);
    expect(first.root.children.map(words)).toEqual(["Primo"]);
    expect(first.problems.map((problem) => problem.why)).toEqual([`2 riquadri della pagina hanno questo nome: convertito quello con id ${site.ids.twinA}; per un altro scrivi il suo id al posto del nome (${site.ids.twinB})`]);
    const second = figFrame(siteCanvas(site), "Bottega", "Sito", site.ids.twinB!);
    expect(second.root.children.map(words)).toEqual(["Secondo"]);
    expect(second.twins).toBe(1);
    expect(figFrame(siteCanvas(site), "Bottega", "Sito", "Home").twins).toBeUndefined();
  });

  it("refuses a blob it does not know and names the weights", () => {
    expect(figPathCommands(Uint8Array.from(pathBlob([[1, 1, 2], [0]]).bytes))).toEqual([{ command: "M", points: [1, 2] }, { command: "Z", points: [] }]);
    expect(figPathCommands(Uint8Array.from(pathBlob([[1, 1, 2], [3, 1, 2, 3, 4]]).bytes))).toBeNull();
    expect(figPathCommands(Uint8Array.from(pathBlob([[2, 1, 2]]).bytes.slice(0, 6)))).toBeNull();
    expect(figPathCommands(new Uint8Array(0))).toBeNull();
    expect(["Thin", "ExtraLight", "Light", "Regular", "Medium", "Semi Bold", "Bold", "ExtraBold Italic", "Black", ""].map(figFontWeight)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 400]);
  });

  it("is read from the archive of a .fig, with the pictures of the frame", async () => {
    const archive = await zip({ "canvas.fig": siteCanvas(), "meta.json": JSON.stringify({ file_name: "Bottega dei vasi" }), [`images/${IMAGE_KEY}`]: PNG, "images/ffffffffffffffffffffffffffffffffffffffff": PNG });
    const list = await designFilePages("bottega.fig", archive);
    expect(list).toMatchObject({ file: "Bottega dei vasi", source: "figma" });
    const page = await designFilePage("bottega.fig", archive, "Sito", "Home");
    expect([...page.images.keys()]).toEqual([IMAGE_KEY]);
    expect(page.images.get(IMAGE_KEY)!.bytes.length).toBe(PNG.length);
    expect(page.problems.some((problem) => /immagin/u.test(problem.why))).toBe(false);
    // The bare document, as old files are: the pictures are not there, and it is said.
    const bare = await designFilePage("bottega.fig", siteCanvas(), "Sito", "Home");
    expect(bare.file).toBe("bottega");
    expect(bare.problems.map((problem) => problem.why)).toContain("1 immagine senza il suo file nell'archivio, o più grande di 15 MB");
    await expect(designFilePage("bottega.fig", archive, "Sito", "Chi siamo")).rejects.toThrow(/^bottega\.fig: Nessun un riquadro si chiama «Chi siamo»\. Ci sono: «Pulsante», «Scheda», «Home», «Doppio», «Doppio»\.$/u);
    await expect(designFilePages("bottega.fig", Buffer.from("{}"))).rejects.toThrow(/serve un file \.penpot o \.fig/u);
  });
});

describe("the pages of real Figma files (skipped when the files are not there)", () => {
  const folder = path.join(os.homedir(), "Scaricati");
  const ceramic = path.join(folder, "1735620798351-Ceramic Plant Pot Website UI Kit.fig");
  const taskflow = path.join(folder, "1769060188363-Taskflow - AI Task Management SaaS Template.fig");

  it.skipIf(!existsSync(ceramic) || !HAS_ZSTD)("a page whose sections are all copies of components", async () => {
    const bytes = readFileSync(ceramic);
    const list = await designFilePages("ceramic.fig", bytes);
    expect(list.pages.map((page) => page.name)).toContain("✦ UI Design");
    const page = await designFilePage("ceramic.fig", bytes, "UI Design", "Home");
    expect(page.root.box).toMatchObject({ width: 1440, height: 6382 });
    expect(page.root.children).toHaveLength(10);
    expect(page.root.children.every((child) => child.component !== null && child.children.length > 0)).toBe(true);
    let layers = 0;
    const texts: string[] = [];
    walkDesign(page.root, (node) => { layers += 1; if (node.text) texts.push(words(node)); });
    expect(layers).toBeGreaterThan(350);
    expect(texts).toContain("Feel it, Feel the Uniqueness.");
    // A variant is named by its set.
    expect(find(page.root, "Top Navigation Bar")[0]!.component).toMatchObject({ name: "Top Navigation Bar", variant: "Navigation=Home" });
    expect(page.images.size).toBeGreaterThan(10);
    expect([...page.images.values()].every((image) => image.bytes.length > 0)).toBe(true);
    expect(page.problems.filter((problem) => /tracciato con comandi|senza il suo componente/u.test(problem.why))).toEqual([]);
  });

  it.skipIf(!existsSync(taskflow) || !HAS_ZSTD)("every frame of a page of frames with few copies", async () => {
    const bytes = readFileSync(taskflow);
    const list = await designFilePages("taskflow.fig", bytes);
    const design = list.pages.find((page) => page.name === "Design")!;
    expect(design.frames.length).toBeGreaterThan(5);
    const page = await designFilePage("taskflow.fig", bytes, "Design", design.frames[0]!.id);
    expect(page.root.box.width).toBe(1920);
    let texts = 0;
    let drawings = 0;
    walkDesign(page.root, (node) => { if (node.text) texts += 1; if (node.paths.length) drawings += 1; });
    expect(texts).toBeGreaterThan(50);
    expect(drawings).toBeGreaterThan(10);
    expect(page.problems.filter((problem) => /tracciato con comandi/u.test(problem.why))).toEqual([]);
  });
});
