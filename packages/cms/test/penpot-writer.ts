/**
 * A small `.penpot` export with one page of a site, written by hand with the fields of a real one, for the tests of
 * the pages (penpot-page.ts) and of the `design` command. Not a test itself.
 */
import yazl from "yazl";

export const FILE = "11111111-1111-4111-8111-111111111111";
export const PAGE = "22222222-2222-4222-8222-222222222222";
export const ROOT = "00000000-0000-0000-0000-000000000000";
export const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
/** 1×1 PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export function zip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
    archive.end();
  });
}

type Shape = Record<string, unknown>;
const rect = (x: number, y: number, width: number, height: number) => ({ selrect: { x, y, width, height }, x, y, width, height });
const fill = (color: string) => [{ fillColor: color, fillOpacity: 1 }];
const flex = (dir: string, gap = 0, padding = 0, extra: Shape = {}) => ({ layout: "flex", layoutFlexDir: dir, layoutGap: { rowGap: gap, columnGap: gap }, layoutPadding: { p1: padding, p2: padding, p3: padding, p4: padding }, layoutAlignItems: "start", layoutJustifyContent: "start", layoutWrapType: "nowrap", ...extra });

/** A text shape with one paragraph of one piece. */
export function textShape(n: number, name: string, words: string, size: number, at: ReturnType<typeof rect>, extra: Shape = {}): Shape {
  return { id: id(n), name, type: "text", growType: "auto-width", ...at, content: { type: "root", children: [{ type: "paragraph-set", children: [{ type: "paragraph", textAlign: "left", children: [{ text: words, fontSize: String(size), fontWeight: size > 30 ? "700" : "400", fontFamily: "Inter", lineHeight: "1.4", letterSpacing: "0", fills: fill("#1a1a1a") }] }] }] }, ...extra };
}

/**
 * The shapes of the page «Home»: one frame «Home» (1200 × 760, a column) with a header, a hero placed by
 * coordinates, a row of two cards and a footer. The children of the frame are listed from the last to the first, as
 * a file exported from Figma lists them.
 */
export function siteShapes(): Shape[] {
  const media = id(90);
  const card = (n: number, x: number, title: string, extra: Shape = {}): Shape[] => [
    { id: id(n), name: "Card", type: "frame", ...rect(40 + x, 420, 300, 180), ...flex("column", 12, 24), fills: fill("#f4f4f4"), r1: 12, r2: 12, r3: 12, r4: 12, componentId: id(10), componentRoot: true, shapes: [id(n + 1), id(n + 2)], ...extra },
    textShape(n + 1, "Card title", title, 20, rect(64 + x, 444, 120, 28)),
    textShape(n + 2, "Card copy", "Due righe di testo che spiegano la scheda.", 16, rect(64 + x, 484, 252, 44), { growType: "fixed" }),
  ];
  return [
    { id: ROOT, name: "Root Frame", type: "frame", shapes: [id(30)] },
    { id: id(30), name: "Home", type: "frame", ...rect(0, 0, 1200, 760), ...flex("column"), fills: fill("#ffffff"), shapes: [id(34), id(33), id(32), id(31)] },
    // Header: a row with its two ends apart.
    { id: id(31), name: "Header", type: "frame", ...rect(0, 0, 1200, 80), ...flex("row", 0, 24, { layoutJustifyContent: "space-between", layoutAlignItems: "center" }), shapes: [id(35), id(36)] },
    textShape(35, "Logo", "Bottega", 20, rect(24, 26, 90, 28)),
    textShape(36, "link", "Contatti", 16, rect(1100, 28, 76, 24)),
    // Hero: no auto layout, a hidden layer, a picture, an icon.
    { id: id(32), name: "Hero", type: "frame", ...rect(0, 80, 1200, 300), fills: fill("#eef2ff"), shapes: [id(37), id(38), id(39), id(50), id(51)] },
    textShape(37, "h1", "Un titolo grande", 48, rect(100, 120, 420, 60)),
    textShape(38, "Copy", "Un testo che presenta il prodotto in poche parole.", 16, rect(100, 200, 420, 48), { growType: "fixed" }),
    { id: id(39), name: "Foto del prodotto", type: "rect", ...rect(700, 120, 400, 220), fills: [{ fillOpacity: 1, fillImage: { id: media, width: 1, height: 1, mtype: "image/png" } }] },
    { id: id(50), name: "Nota nascosta", type: "rect", ...rect(0, 80, 10, 10), fills: fill("#ff0000"), hidden: true },
    { id: id(51), name: "Freccia", type: "path", ...rect(100, 270, 24, 24), fills: fill("#1d4ed8"), content: [{ command: "move-to", params: { x: 100, y: 270 } }, { command: "line-to", params: { x: 124, y: 282 } }, { command: "line-to", params: { x: 100, y: 294 } }, { command: "close-path", params: {} }] },
    // Cards: a row; the second card fills (spelled as older files spell it); a button whose background is drawn with a negative margin.
    { id: id(33), name: "Cards", type: "frame", ...rect(0, 380, 1200, 300), ...flex("row", 24, 40), shapes: [id(60), id(40), id(44)] },
    ...card(40, 0, "Prima"),
    ...card(44, 324, "Seconda", { layoutItemHsizing: "fill" }),
    { id: id(60), name: "Button", type: "frame", ...rect(688, 420, 120, 40), ...flex("column"), shapes: [id(61), id(62)] },
    { id: id(61), name: "Background", type: "rect", ...rect(688, 420, 120, 40), fills: fill("#1d4ed8"), rx: 20, layoutItemMargin: { m1: -40 } },
    textShape(62, "Label", "Scopri", 16, rect(720, 428, 56, 24)),
    // Footer.
    { id: id(34), name: "Footer", type: "frame", ...rect(0, 680, 1200, 80), ...flex("row", 0, 24), fills: fill("#111111"), shapes: [id(63)] },
    textShape(63, "Note", "Bottega, via Roma 1", 14, rect(24, 708, 160, 20)),
  ];
}

/** The entries of the export: the manifest, the file, the page, its shapes, one component and one picture. */
export function siteEntries(shapes: Shape[] = siteShapes()): Record<string, string | Buffer> {
  const j = (data: unknown) => JSON.stringify(data);
  const object = id(91);
  const entries: Record<string, string | Buffer> = {
    "manifest.json": j({ type: "penpot/export-files", version: 1, generatedBy: "penpot/2.5.4", files: [{ id: FILE, name: "Sito di prova", features: [] }], relations: [] }),
    [`files/${FILE}.json`]: j({ id: FILE, name: "Sito di prova" }),
    [`files/${FILE}/pages/${PAGE}.json`]: j({ id: PAGE, name: "Home", index: 0 }),
    [`files/${FILE}/components/${id(10)}.json`]: j({ id: id(10), name: "Card", path: "Blocchi", mainInstanceId: id(40), mainInstancePage: PAGE }),
    [`files/${FILE}/media/${id(90)}.json`]: j({ id: id(90), mediaId: object, mtype: "image/png", width: 1, height: 1 }),
    [`objects/${object}.png`]: PNG,
  };
  for (const shape of shapes) entries[`files/${FILE}/pages/${PAGE}/${String(shape.id)}.json`] = j(shape);
  return entries;
}
