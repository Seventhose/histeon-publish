import { describe, expect, it } from "vitest";
import { designPrototype, designPrototypeText } from "../src/design-prototype.js";
import { crossPlace, designColor, designColorCss, designImageType, designNode, type DesignNode, type DesignPage, type DesignRun, designSlug, genericLayerName } from "../src/design-tree.js";

const ID = "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f12";
const run = (text: string, sizePx: number, weight = 400): DesignRun => ({ text, sizePx, weight, italic: false, family: "Inter", lineHeight: 1.5, letterSpacingPx: 0, color: designColor("#222222"), underline: false, transform: "", link: "" });
const text = (id: string, name: string, words: string, sizePx: number, box: DesignNode["box"]) => designNode({ id, name, kind: "text", box, sizing: { horizontal: "hug", vertical: "hug" }, text: { paragraphs: [[run(words, sizePx)]], align: "left" } });
// 1×1 PNG.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));

function page(root: DesignNode): DesignPage {
  return { file: "Prova", page: "Pagina", frame: root.name, source: "penpot", root, images: new Map([["foto", { bytes: PNG, mime: "image/png", width: 1, height: 1 }]]), hidden: 0, problems: [] };
}

describe("design-tree", () => {
  it("reads colours, slugs, generic names and picture sizes", () => {
    expect(designColorCss(designColor("#FFF", 0.5)!)).toBe("rgb(255 255 255 / 0.5)");
    expect(designColor("rosso")).toBeNull();
    expect(designSlug("12 Héro cardTitle")).toBe("hero-card-title");
    expect(genericLayerName("Frame 12")).toBe(true);
    expect(genericLayerName("Pricing")).toBe(false);
    expect(designImageType(PNG)).toEqual({ mime: "image/png", width: 1, height: 1 });
    expect(designImageType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("reads the place of a child across the direction from the boxes", () => {
    const layout = { mode: "column" as const, gap: 0, crossGap: 0, padding: [0, 0, 0, 0] as [number, number, number, number], justify: "start" as const, align: "start" as const, wrap: false, columns: 0 };
    const child = designNode({ id: "c", name: "c", kind: "shape", box: { x: 40, y: 0, width: 20, height: 10 } });
    expect(crossPlace(layout, { x: 0, y: 0, width: 100, height: 50 }, child)).toBe("center");
    expect(crossPlace({ ...layout, align: "center" }, { x: 0, y: 0, width: 100, height: 50 }, child)).toBeNull();
  });
});

describe("designPrototype", () => {
  it("writes sections, deduces rows from the boxes and never writes a text size as a length", () => {
    const hero = designNode({ id: "s1", name: "Hero", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 300 }, fills: [{ kind: "solid", color: designColor("#f5f5f5")! }], children: [
      text("t1", "Title", "Un titolo grande {qui}", 48, { x: 100, y: 40, width: 500, height: 60 }),
      text("t2", "Copy", "Un testo che spiega il prodotto con qualche parola in più.", 16, { x: 100, y: 120, width: 500, height: 48 }),
      designNode({ id: "i1", name: "Foto prodotto", kind: "image", box: { x: 800, y: 40, width: 540, height: 220 }, fills: [{ kind: "image", image: "foto" }] }),
    ] });
    const root = designNode({ id: "r", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 300 }, layout: { mode: "column", gap: 0, crossGap: 0, padding: [0, 0, 0, 0], justify: "start", align: "stretch", wrap: false, columns: 0 }, children: [hero] });
    const { html, report } = designPrototype(page(root), { id: ID });
    expect(html).toContain('<section class="hero" aria-label="Hero">');
    expect(html).toContain("<h1 class=\"hero__title\">Un titolo grande \\{qui\\}</h1>");
    expect(html).toContain('src="asset:img-1" width="1" height="1" alt="Foto prodotto"');
    expect(html).toMatch(/font-size: var\(--xb-(?:h|text-)[a-z0-9]+\)/u);
    expect(html).not.toMatch(/font-size: [\d.]+(?:px|rem)/u);
    // A section always says its padding, so that the default one of a framework (Automatic.css) never shows.
    expect(html.slice(html.indexOf(".hero {"), html.indexOf("&__", html.indexOf(".hero {")))).toMatch(/padding(?:-block)?: /u);
    expect(html).not.toMatch(/position: absolute|inset:|(?:^|[ ;])(?:left|top): /u);
    expect(report.inferred).toContain("Hero");
    expect(report.sections).toEqual(["hero"]);
    expect(report.headings).toBe(1);
    expect(report.textSizes.map((size) => size.px)).toEqual([48, 16]);
    expect(designPrototypeText(report)).toContain("Misure di testo: nessuna è una misura fissa");
  });

  it("always says the leading of a text: an automatic one is normal, so the default of a framework never shows", () => {
    const auto = designNode({ id: "t2", name: "Copy", kind: "text", box: { x: 100, y: 120, width: 500, height: 48 }, sizing: { horizontal: "hug", vertical: "hug" }, text: { paragraphs: [[{ ...run("Un testo con l'interlinea automatica del design.", 16), lineHeight: null }]], align: "left" } });
    const hero = designNode({ id: "s1", name: "Hero", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 300 }, children: [text("t1", "Title", "Un titolo grande", 48, { x: 100, y: 40, width: 500, height: 60 }), auto] });
    const root = designNode({ id: "r", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 300 }, layout: { mode: "column", gap: 0, crossGap: 0, padding: [0, 0, 0, 0], justify: "start", align: "stretch", wrap: false, columns: 0 }, children: [hero] });
    const { html } = designPrototype(page(root), { id: ID });
    expect(html).toMatch(/&__title \{[^}]*line-height: 1\.5;/u);
    expect(html).toMatch(/&__copy \{[^}]*line-height: normal;/u);
  });

  const column = { mode: "column" as const, gap: 0, crossGap: 0, padding: [0, 0, 0, 0] as [number, number, number, number], justify: "start" as const, align: "start" as const, wrap: false, columns: 0 };
  const solid = (hex: string) => [{ kind: "solid" as const, color: designColor(hex)! }];

  it("takes a label named h6 as a text and the size of the running text as the base of the scale", () => {
    const items = [0, 1, 2, 3, 4].map((n) => text(`i${n}`, "h6", `Una voce dell'elenco numero ${n}, lunga quanto basta`, 14, { x: 100, y: 100 + n * 30, width: 400, height: 24 }));
    const list = designNode({ id: "s1", name: "Elenco", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 300 }, children: [text("t1", "h3", "Titolo dell'elenco", 24, { x: 100, y: 40, width: 300, height: 32 }), ...items] });
    const root = designNode({ id: "r", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 300 }, layout: column, children: [list] });
    const { html, report } = designPrototype(page(root), { id: ID });
    expect(report.headings).toBe(1);
    expect(html.match(/<h[1-6][ >]/gu)).toHaveLength(1);
    expect(report.textSizes.find((size) => size.px === 14)).toMatchObject({ step: "xb-text-m", stepPx: 14 });
    expect(report.notes.join(" ")).toContain("Il testo corrente del design è di 14 px");
    expect(html).toContain('"design":{"text_min":14,"text_max":14,"font_body":"Inter, system-ui, sans-serif"}');
    // With a scale of its own the design keeps it.
    const own = designPrototype(page(designNode({ ...root, children: [designNode({ ...list })] })), { id: ID, design: { text_max: 18 } });
    expect(own.report.notes.join(" ")).not.toContain("Il testo corrente");
  });

  it("stretches what is as wide as the page, keeps a fixed width inside the room and a short label on one line", () => {
    const row = { ...column, mode: "row" as const, gap: 24, padding: [20, 40, 20, 40] as [number, number, number, number] };
    const chip = designNode({ id: "c", name: "Chip", kind: "frame", box: { x: 40, y: 20, width: 120, height: 40 }, layout: { ...row, gap: 8, padding: [8, 16, 8, 16] }, fills: solid("#1d4ed8"), children: [text("ct", "Voce", "Novità", 14, { x: 16, y: 8, width: 60, height: 24 })] });
    const panel = designNode({ id: "p", name: "Pannello", kind: "frame", box: { x: 184, y: 20, width: 600, height: 200 }, layout: column, fills: solid("#eeeeee"), children: [text("pt", "Corpo", "Un paragrafo lungo che va a capo più volte dentro il suo pannello, perché è un testo vero.", 14, { x: 0, y: 0, width: 600, height: 72 })] });
    const bar = designNode({ id: "s1", name: "Barra", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 240 }, layout: row, sizing: { horizontal: "hug", vertical: "hug" }, children: [chip, panel] });
    const poster = designNode({ id: "s2", name: "Manifesto", kind: "frame", box: { x: 0, y: 240, width: 1440, height: 300 }, sizing: { horizontal: "fixed", vertical: "fixed" }, children: [
      designNode({ id: "a", name: "Fondo", kind: "shape", box: { x: 200, y: 20, width: 600, height: 200 }, fills: solid("#1d4ed8") }),
      text("mt", "Sopra", "Scritta sopra il fondo", 14, { x: 500, y: 100, width: 200, height: 24 }),
    ] });
    const root = designNode({ id: "r", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 540 }, layout: column, children: [bar, poster] });
    const { html, report } = designPrototype(page(root), { id: ID, design: { primary: "#1d4ed8" } });
    expect(html).toMatch(/\.barra \{[^}]*align-self: stretch;/u);
    expect(html).toMatch(/&__chip \{[^}]*background: var\(--xb-primary\);[^}]*inline-size: fit-content; min-inline-size: 7\.5rem;/u);
    expect(html).toMatch(/&__voce \{[^}]*white-space: nowrap;/u);
    expect(html).toMatch(/&__pannello \{[^}]*inline-size: 37\.5rem; max-inline-size: 100%;/u);
    expect(html).not.toMatch(/&__corpo \{[^}]*white-space: nowrap/u);
    // Layers one over the other: one cell, places as shares of the width, never coordinates.
    expect(report.stacked).toEqual(["Manifesto"]);
    expect(html).toMatch(/\.manifesto \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/u);
    expect(html).toMatch(/&__forma \{[^}]*margin-inline-start: 13\.9%;[^}]*inline-size: 37\.5rem; max-inline-size: 86\.1%;/u);
    expect(html).not.toMatch(/position: absolute|inset:/u);
  });

  it("lays what is out of the flow over or under the rest, scrolls a row wider than the page and spreads a row filled by its gap", () => {
    const row = { ...column, mode: "row" as const };
    const box = (id: string, name: string, x: number, width: number, extra: Partial<DesignNode> = {}) => designNode({ id, name, kind: "frame", box: { x, y: 20, width, height: 40 }, layout: row, sizing: { horizontal: "hug", vertical: "hug" }, children: [text(`${id}t`, "Voce", name, 16, { x: 0, y: 8, width, height: 24 })], ...extra });
    // Three children and two gaps of 400 fill the 1440 px to the pixel.
    const bar = designNode({ id: "s0", name: "Top bar", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 80 }, layout: { ...row, gap: 400, padding: [20, 120, 20, 120], align: "center" }, fills: solid("#ffffff"), children: [box("b1", "Marchio", 120, 100), box("b2", "Menu", 620, 200), box("b3", "Entra", 1220, 100)] });
    // A picture in the flow that covers the frame, the words over it out of the flow.
    const words = designNode({ id: "h2", name: "Contenuto", kind: "frame", box: { x: 300, y: 100, width: 840, height: 300 }, layout: column, absolute: true, children: [text("ht", "Title", "Il titolo della pagina", 48, { x: 0, y: 0, width: 840, height: 60 })] });
    const hero = designNode({ id: "s1", name: "Hero", kind: "frame", box: { x: 0, y: 80, width: 1440, height: 600 }, layout: column, sizing: { horizontal: "hug", vertical: "hug" }, children: [designNode({ id: "h1", name: "Sfondo", kind: "image", box: { x: 0, y: 0, width: 1440, height: 600 }, fills: [{ kind: "image", image: "foto" }] }), words] });
    // Five cards in a row that goes out of the page on the right, in a section wider than the page.
    const cards = [0, 1, 2, 3, 4].map((n) => designNode({ id: `c${n}`, name: "Card", kind: "frame", box: { x: n * 306, y: 0, width: 276, height: 200 }, layout: column, fills: solid("#eeeeee"), children: [text(`c${n}t`, "Nome", `Scheda ${n}`, 16, { x: 0, y: 0, width: 100, height: 24 })] }));
    const strip = designNode({ id: "s2r", name: "Schede", kind: "frame", box: { x: 120, y: 40, width: 1500, height: 200 }, layout: { ...row, gap: 30 }, sizing: { horizontal: "hug", vertical: "hug" }, children: cards });
    const shelf = designNode({ id: "s2", name: "Vetrina", kind: "frame", box: { x: 0, y: 680, width: 1620, height: 280 }, layout: { ...column, padding: [40, 0, 40, 120] }, children: [strip] });
    // A row with a seal laid over its corner: one cell, the row and the seal in the order of the design.
    const seal = designNode({ id: "p2", name: "Bollino", kind: "frame", box: { x: 1300, y: 10, width: 80, height: 80 }, layout: column, absolute: true, fills: solid("#1d4ed8"), children: [text("p2t", "Sconto", "Novità", 14, { x: 10, y: 28, width: 60, height: 24 })] });
    const promo = designNode({ id: "s3", name: "Promo", kind: "frame", box: { x: 0, y: 960, width: 1440, height: 200 }, layout: { ...row, padding: [40, 120, 40, 120] }, children: [text("p1", "Offerta", "Un testo in flusso, lungo quanto serve per andare a capo su uno schermo stretto.", 16, { x: 120, y: 40, width: 800, height: 48 }), seal] });
    // Four things placed by hand at uneven distances: the cells of a table.
    const cell = (id: string, x: number, words: string) => text(id, "Cella", words, 16, { x, y: 18, width: 80, height: 24 });
    const table = designNode({ id: "s4", name: "Tabella", kind: "frame", box: { x: 0, y: 1160, width: 1440, height: 60 }, children: [cell("t1", 40, "Voce"), cell("t3", 900, "No"), cell("t2", 540, "Sì"), cell("t4", 1300, "Sì")] });
    const root = designNode({ id: "r", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1440, height: 1220 }, layout: column, children: [bar, hero, shelf, promo, table] });
    const { html, report } = designPrototype(page(root), { id: ID });
    expect(html).not.toMatch(/position: absolute|inset:|(?:^|[ ;])(?:left|top): /u);
    // C: the bar.
    expect(html).toMatch(/\.top-bar \{ display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var\(--xb-space-m\); padding: 1\.25rem 7\.5rem;/u);
    expect(report.spread).toBe(1);
    // A: the picture is the background, the words are read from their boxes.
    expect(html).toMatch(/\.hero \{[^}]*background: url\("asset:img-1"\) center \/ cover no-repeat;/u);
    expect(html).not.toContain('alt="Sfondo"');
    expect(html).toContain('<h1 class="hero__title">Il titolo della pagina</h1>');
    expect(report.absolute).toEqual(["Bollino"]);
    // A: the seal shares one cell with the row, each a layer of its own.
    expect(html).toMatch(/\.promo \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/u);
    expect(html).toMatch(/&__riga \{ display: flex;[^}]*grid-area: 1 \/ 1; isolation: isolate; justify-self: stretch; align-self: stretch;/u);
    expect(html).toMatch(/&__bollino \{[^}]*grid-area: 1 \/ 1; isolation: isolate; justify-self: end; margin-inline-end: 4\.2%;/u);
    expect(html.indexOf('class="promo__riga"')).toBeLessThan(html.indexOf('class="promo__bollino"'));
    // B: the strip starts where the design puts it and ends at the edge of the page.
    expect(report.strips).toEqual(["Schede"]);
    expect(html).toContain('<div class="vetrina__schede" tabindex="0" role="group" aria-label="Schede">');
    expect(html).toMatch(/&__schede \{ display: flex; align-items: flex-start; gap: [^;]+; overflow-x: auto; align-self: stretch; \}/u);
    expect(html).toMatch(/&__card \{[^}]*inline-size: 17\.25rem; max-inline-size: 100%; flex: none; \}/u);
    expect(html).not.toMatch(/&__schede \{[^}]*flex-wrap/u);
    // The cells keep their shares of the width, also on a narrow screen.
    expect(html).toMatch(/\.tabella \{ display: grid; grid-template-columns: minmax\(0, 500fr\) minmax\(0, 360fr\) minmax\(0, 400fr\) minmax\(0, 100fr\); justify-items: start; align-items: flex-start; padding: 1\.125rem var\(--xb-space-l\); align-self: stretch; &__cella/u);
    expect(html).toMatch(/<p class="tabella__cella">Voce<\/p><p class="tabella__cella">Sì<\/p><p class="tabella__cella">No<\/p>/u);
    // The block keeps the gutter: what is inside it does not take a second one.
    expect(html).toMatch(/\.hero \{[^&]*padding-inline: var\(--xb-gutter\);[^&]*&__contenuto \{[^}]*inline-size: 52\.5rem; max-inline-size: 100%; \}/u);
    const said = designPrototypeText(report);
    expect(said).toContain("Livelli fuori flusso, messi nella stessa cella di griglia del resto del loro riquadro");
    expect(said).toContain("strisce che scorrono di lato (da controllare): «Schede»");
  });

  it("reads a frame that covers the others as their backdrop, and keeps a narrow footer inside the page", () => {
    const backdrop = designNode({ id: "bg", name: "bg", kind: "frame", box: { x: 0, y: 0, width: 1920, height: 700 }, children: [designNode({ id: "bg1", name: "Macchia", kind: "shape", box: { x: 100, y: 100, width: 300, height: 300 }, fills: solid("#e0f2fe"), round: true }), text("bg2", "Filigrana", "Scritta di fondo", 14, { x: 1500, y: 600, width: 200, height: 24 })] });
    const menu = designNode({ id: "m", name: "Menu", kind: "frame", box: { x: 0, y: 0, width: 1920, height: 100 }, children: [text("m1", "Marchio", "Bottega", 18, { x: 120, y: 38, width: 120, height: 24 }), text("m2", "Voci", "Prodotti Storia Contatti", 18, { x: 810, y: 38, width: 300, height: 24 }), text("m3", "Entra", "Entra", 18, { x: 1680, y: 38, width: 120, height: 24 })] });
    const words = designNode({ id: "w", name: "Parole", kind: "frame", box: { x: 250, y: 200, width: 1420, height: 120 }, children: [text("w1", "Etichetta", "Novità", 18, { x: 676, y: 0, width: 80, height: 24 }), text("w2", "Title", "Un titolo al centro", 64, { x: 260, y: 40, width: 900, height: 80 })] });
    const hero = designNode({ id: "s1", name: "Hero", kind: "frame", box: { x: 0, y: 0, width: 1920, height: 700 }, children: [backdrop, words, menu] });
    const footer = designNode({ id: "s2", name: "Footer", kind: "frame", box: { x: 250, y: 800, width: 1420, height: 100 }, children: [text("f1", "Nota", "Bottega, 2026", 18, { x: 0, y: 38, width: 300, height: 24 })] });
    const { html, report } = designPrototype(page(designNode({ id: "r", name: "Home", kind: "frame", box: { x: 0, y: 0, width: 1920, height: 900 }, children: [hero, footer] })), { id: ID });
    expect(report.stacked).toEqual(["Hero"]);
    // The menu and the words are a column over the backdrop, in the order of the eye; the bar has its pieces at its two ends.
    expect(html.indexOf('class="hero__menu"')).toBeLessThan(html.indexOf('class="hero__parole"'));
    expect(html.indexOf('class="hero__bg"')).toBeLessThan(html.indexOf('class="hero__menu"'));
    expect(html).toMatch(/&__menu \{ display: flex; justify-content: space-between;[^}]*padding: var\(--xb-space-l\) 7\.5rem; align-self: stretch;/u);
    expect(report.spread).toBe(1);
    // Centred by hand, a few pixels off: still the centre; narrower than the page: a gutter when the screen is narrower still.
    expect(html).toMatch(/&__parole \{ display: flex; flex-direction: column; align-items: center;[^}]*inline-size: 88\.75rem; max-inline-size: calc\(100% - 2 \* var\(--xb-gutter\)\); align-self: center;/u);
    expect(html).toMatch(/\.footer \{[^}]*inline-size: min\(88\.75rem, 100% - 2 \* var\(--xb-gutter\)\); margin-inline: auto; margin-block-start: [^;]+;/u);
  });

  it("refuses an id that is not a UUID", () => {
    expect(() => designPrototype(page(designNode({ id: "r", name: "Home", kind: "frame" })), { id: "x" })).toThrow(TypeError);
  });
});
