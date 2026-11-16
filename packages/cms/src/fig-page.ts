/**
 * One frame of a page of a Figma `.fig` file as a neutral tree (note penpot-figma-a-histeon.md, phase 3).
 *
 * `canvas.fig` is decoded by fig-kiwi.ts into one message whose `nodeChanges` are all the layers of the file, flat:
 * a layer names its parent (`parentIndex.guid`) and its place among the children (`parentIndex.position`, a text
 * to sort). A page is a `CANVAS`. A layer has its size (`size`) and a matrix (`transform`) that places it in its
 * parent. The drawing of a vector is a blob of the message (`fillGeometry`, `strokeGeometry`), a picture a file
 * `images/<hash>` of the archive.
 *
 * A copy of a component (`INSTANCE`) has no children in the file. It names its component (`symbolData.symbolID`, a
 * `SYMBOL`), what it changes (`symbolData.symbolOverrides`) and what the layout computed after the changes
 * (`derivedSymbolData`); each change says which layer it is for with a path of keys (`guidPath`), one key for each
 * copy to go through. The key of a layer is its `overrideKey`, or its GUID when it has none. This reader builds the
 * children of every copy from its component.
 *
 * The field names are read through the schema each file carries. When the file has a shape this reader does not
 * recognise, it says so in the report and converts nothing of it, never guessed.
 *
 * Node only (fig-kiwi.ts). No network, no credentials; nothing is written to disk.
 */

import type { TokenProblem } from "./design-tokens.js";
import {
  crossPlace,
  DESIGN_DEPTH_MAX,
  DESIGN_NODES_MAX,
  type DesignAlign,
  type DesignColor,
  type DesignJustify,
  type DesignLayout,
  type DesignNode,
  designNode,
  type DesignPage,
  type DesignPageList,
  type DesignPaint,
  type DesignPath,
  type DesignRun,
  type DesignSizing,
  type DesignText,
} from "./design-tree.js";
import { figGuid, figList, figNumber, figRecord, figRgba, figText } from "./fig-file.js";
import { decodeKiwi, type KiwiRecord, type KiwiValue, readFigContainer, readKiwiSchema } from "./fig-kiwi.js";
import { pickByName } from "./penpot-page.js";

const IMAGE_ENTRY = /^images\/([0-9a-f]{40,64})$/u;
/** One picture of the design: the prototype takes media of at most 15 MB. */
const IMAGE_ENTRY_MAX = 15 * 1024 * 1024;
/** The `d` of the paths of one layer: an illustration traced point by point is left out and said. */
const PATH_MAX = 200_000;
/** The characters of one text. */
const TEXT_MAX = 100_000;

const CONTAINERS = new Set(["FRAME", "GROUP", "SECTION", "SYMBOL", "INSTANCE"]);
const SHAPES = new Set(["RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE"]);
const VECTORS = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION"]);
/** What a copy does not take from its component: who it is, where it is, and how its own parent places it. */
const OWN_FIELDS = new Set([
  "guid", "phase", "parentIndex", "type", "name", "size", "transform", "visible", "mask", "overrideKey", "symbolData", "derivedSymbolData", "componentPropDefs",
  "componentPropRefs", "componentPropAssignments", "isStateGroup", "stackChildPrimaryGrow", "stackChildAlignSelf", "stackPositioning", "horizontalConstraint", "verticalConstraint",
]);
/** What a change of a copy never changes: the layer it is for stays itself. */
const NEVER_CHANGED = ["guid", "guidPath", "phase", "parentIndex"];

interface FigIndex {
  file: string;
  byId: Map<string, KiwiRecord>;
  /** The children of each layer, in their order. */
  kids: Map<string, KiwiRecord[]>;
  blobs: KiwiValue[];
  /** The pages the user sees, in their order. */
  pages: KiwiRecord[];
}

/** One layer as it is where it is shown: inside a copy it is the layer of the component with the changes of the copies around it. */
interface Level {
  node: KiwiRecord;
  /** The GUID of the layer of the file, whatever the copies changed. */
  guid: string;
  /** Unique in the tree: the GUID, with the ids of the copies it is in before it. */
  id: string;
  /** Its key in the paths of the copy it is in. */
  key: string;
  /** The changes of the copy it is in, by path; null outside a copy. */
  scope: Map<string, KiwiRecord> | null;
  /** The id of the copy it is in; empty outside a copy. */
  prefix: string;
  /** The values the copy it is in gives to the properties of its component. */
  props: Map<string, KiwiRecord> | null;
  /** For a copy: its component. */
  symbol: KiwiRecord | null;
}

/** x' = a·x + c·y + e, y' = b·x + d·y + f. */
interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }

type FigPathCommand = { command: "M" | "L" | "C" | "Z"; points: number[] };
/** What a layer draws, in the coordinates of its parent; `unread` when a part of it could not be read. */
interface FigDrawing { paths: Array<{ commands: FigPathCommand[]; color: DesignColor; evenOdd: boolean }>; unread: boolean }

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const merge = (...records: Array<KiwiRecord | null | undefined>): KiwiRecord => Object.assign(Object.create(null) as KiwiRecord, ...records);

/** The entries of a `.fig` archive that hold the pictures of one page already read: `images/<key>` for each key of `page.images`. */
export function figImageEntry(page: DesignPage): (name: string, size: number) => boolean {
  return (name, size) => {
    const match = IMAGE_ENTRY.exec(name);
    return match !== null && size <= IMAGE_ENTRY_MAX && page.images.has(match[1]!);
  };
}

/** Every layer of the document by GUID, the children of each in their order, the blobs and the pages. Throws a TypeError when the bytes are not a Figma document. */
function figIndex(canvas: Uint8Array, file: string): FigIndex {
  const container = readFigContainer(canvas);
  const message = decodeKiwi(readKiwiSchema(container.schema), container.message, "Message");
  const byId = new Map<string, KiwiRecord>();
  const kids = new Map<string, KiwiRecord[]>();
  let document = "";
  for (const node of figList(message.nodeChanges).map(figRecord)) {
    const id = node ? figGuid(node.guid) : "";
    if (!node || !id || figText(node.phase) === "REMOVED" || byId.has(id)) continue;
    byId.set(id, node);
    if (figText(node.type) === "DOCUMENT") document ||= id;
    const parent = figGuid(figRecord(node.parentIndex)?.guid);
    if (parent) kids.set(parent, [...(kids.get(parent) ?? []), node]);
  }
  if (!document) throw new TypeError("Il file di Figma non si legge: non contiene un documento.");
  const position = (node: KiwiRecord) => figText(figRecord(node.parentIndex)?.position);
  for (const list of kids.values()) list.sort((a, b) => (position(a) < position(b) ? -1 : position(a) > position(b) ? 1 : 0));
  const pages = (kids.get(document) ?? []).filter((node) => figText(node.type) === "CANVAS" && node.internalOnly !== true);
  return { file, byId, kids, blobs: figList(message.blobs), pages };
}

/** The frames at the top of a page: its frames, components and copies, and those inside a section. Hidden ones are left out. */
function topFrames(index: FigIndex, page: KiwiRecord): KiwiRecord[] {
  const frames: KiwiRecord[] = [];
  const isFrame = (node: KiwiRecord) => node.visible !== false && ["FRAME", "SYMBOL", "INSTANCE"].includes(figText(node.type));
  for (const node of index.kids.get(figGuid(page.guid)) ?? []) {
    if (isFrame(node)) frames.push(node);
    else if (figText(node.type) === "SECTION" && node.visible !== false) frames.push(...(index.kids.get(figGuid(node.guid)) ?? []).filter(isFrame));
  }
  return frames;
}

/** The component a copy is made from (`overriddenSymbolID` when the copy was swapped, else `symbolData.symbolID`), or null. */
function symbolOf(index: FigIndex, node: KiwiRecord): KiwiRecord | null {
  const symbol = index.byId.get(figGuid(node.overriddenSymbolID) || figGuid(figRecord(node.symbolData)?.symbolID));
  return symbol && figText(symbol.type) === "SYMBOL" ? symbol : null;
}

/** The pages and their frames, from an index already read. */
function pageList(index: FigIndex): DesignPageList {
  // A copy counts the layers of its component. Each layer is counted once and kept: a component that holds a copy of itself cannot loop.
  const counts = new Map<string, number>();
  const count = (node: KiwiRecord, depth: number): number => {
    const id = figGuid(node.guid);
    const known = counts.get(id);
    if (known !== undefined) return known;
    if (depth > DESIGN_DEPTH_MAX) return 1;
    counts.set(id, 1);
    const from = figText(node.type) === "INSTANCE" ? symbolOf(index, node) : node;
    let total = 1;
    for (const child of from ? index.kids.get(figGuid(from.guid)) ?? [] : []) total += count(child, depth + 1);
    counts.set(id, total);
    return total;
  };
  const side = (node: KiwiRecord, key: "x" | "y") => Math.round(figNumber(figRecord(node.size)?.[key]) ?? 0);
  return {
    file: index.file,
    source: "figma",
    pages: index.pages.map((page) => ({
      id: figGuid(page.guid),
      name: figText(page.name).trim() || "Pagina",
      frames: topFrames(index, page).map((frame) => ({ id: figGuid(frame.guid), name: figText(frame.name).trim(), width: side(frame, "x"), height: side(frame, "y"), layers: count(frame, 0) })),
    })),
  };
}

/** The pages of the file and the frames at the top of each, with how many layers each frame holds once its copies are built. `canvas` is the bytes of `canvas.fig`. */
export function figPageList(canvas: Uint8Array, file: string): DesignPageList {
  return pageList(figIndex(canvas, file));
}

function matrixOf(value: KiwiValue | undefined): Matrix {
  const m = figRecord(value);
  const at = (key: string, fallback: number) => figNumber(m?.[key]) ?? fallback;
  return { a: at("m00", 1), c: at("m01", 0), e: at("m02", 0), b: at("m10", 0), d: at("m11", 1), f: at("m12", 0) };
}

/** The commands of a blob of geometry, in the coordinates of its layer: a byte for the command (0 close, 1 move, 2 line, 4 curve) and its points as 32 bit floats, little endian. Null for a command this reader does not know or a blob cut short. */
export function figPathCommands(bytes: Uint8Array): FigPathCommand[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: FigPathCommand[] = [];
  let at = 0;
  while (at < bytes.length) {
    const code = bytes[at]!;
    at += 1;
    const command = code === 0 ? "Z" : code === 1 ? "M" : code === 2 ? "L" : code === 4 ? "C" : null;
    const numbers = command === "Z" ? 0 : command === "C" ? 6 : 2;
    if (!command || at + numbers * 4 > bytes.length) return null;
    const points: number[] = [];
    for (let n = 0; n < numbers; n += 1, at += 4) points.push(view.getFloat32(at, true));
    if (points.some((point) => !Number.isFinite(point))) return null;
    out.push({ command, points });
  }
  return out.length ? out : null;
}

const JUSTIFY: Record<string, DesignJustify> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "between", SPACE_EVENLY: "between" };
const ALIGN: Record<string, DesignAlign> = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" };

/** The auto layout of a frame, or null. A grid is not read: its children are placed by their coordinates. */
function figLayout(node: KiwiRecord): DesignLayout | null {
  const mode = figText(node.stackMode);
  if (mode !== "HORIZONTAL" && mode !== "VERTICAL") return null;
  const length = (key: string) => Math.max(0, figNumber(node[key]) ?? 0);
  const [left, top] = [length("stackHorizontalPadding"), length("stackVerticalPadding")];
  // Files of older versions write one padding for the two sides.
  const right = figNumber(node.stackPaddingRight) === null ? left : length("stackPaddingRight");
  const bottom = figNumber(node.stackPaddingBottom) === null ? top : length("stackPaddingBottom");
  const justify = JUSTIFY[figText(node.stackPrimaryAlignItems)] ?? "start";
  const wrap = figText(node.stackWrap) === "WRAP";
  return {
    mode: mode === "HORIZONTAL" ? "row" : "column",
    // With the children spread from end to end the file keeps the space that came out, not one the designer chose.
    gap: justify === "between" ? 0 : round(length("stackSpacing")),
    crossGap: wrap ? round(length("stackCounterSpacing")) : 0,
    padding: [round(top), round(right), round(bottom), round(left)],
    justify,
    align: ALIGN[figText(node.stackCounterAlignItems)] ?? "start",
    wrap,
    columns: 0,
  };
}

/** The weight a font style name says (`SemiBold`, `Extra Light Italic`); 400 when it says none. */
export function figFontWeight(style: string): number {
  const name = style.toLowerCase().replace(/[\s_-]+/gu, "");
  const table: Array<[RegExp, number]> = [[/thin|hairline/u, 100], [/extralight|ultralight/u, 200], [/semibold|demibold/u, 600], [/extrabold|ultrabold/u, 800], [/black|heavy/u, 900], [/light/u, 300], [/medium/u, 500], [/bold/u, 700]];
  return table.find(([word]) => word.test(name))?.[1] ?? 400;
}

/** The paints that can be seen, the top one first (the file lists them from the bottom). */
function visiblePaints(value: KiwiValue | undefined): KiwiRecord[] {
  return figList(value).map(figRecord).filter((paint): paint is KiwiRecord => paint !== null && paint.visible !== false && (figNumber(paint.opacity) ?? 1) > 0).reverse();
}

/** The one colour a list of paints gives to a text or a path: its top solid paint, or the first stop of its top gradient. Null for a picture or no paint. */
function paintColor(value: KiwiValue | undefined): DesignColor | null {
  const paint = visiblePaints(value)[0];
  if (!paint) return null;
  const opacity = figNumber(paint.opacity) ?? 1;
  if (figText(paint.type) === "SOLID") return figRgba(paint.color, opacity);
  return figText(paint.type).startsWith("GRADIENT") ? figRgba(figRecord(figList(paint.stops)[0])?.color, opacity) : null;
}

/** The fills of a layer as paints, the top one first. A picture is named by the hash of its file and added to `images` without bytes. */
function figPaints(value: KiwiValue | undefined, images: DesignPage["images"], box: { width: number; height: number }): DesignPaint[] {
  const paints: DesignPaint[] = [];
  for (const paint of visiblePaints(value)) {
    const type = figText(paint.type);
    const opacity = figNumber(paint.opacity) ?? 1;
    if (type === "SOLID") {
      const color = figRgba(paint.color, opacity);
      if (color) paints.push({ kind: "solid", color });
    } else if (type === "IMAGE") {
      const hash = figRecord(paint.image)?.hash;
      const key = hash instanceof Uint8Array && hash.length >= 20 && hash.length <= 32 ? Buffer.from(hash).toString("hex") : "";
      if (!key) { paints.push({ kind: "other", what: "immagine senza il suo file" }); continue; }
      if (!images.has(key)) images.set(key, { bytes: new Uint8Array(0), mime: "", width: figNumber(paint.originalImageWidth) ?? 0, height: figNumber(paint.originalImageHeight) ?? 0 });
      paints.push({ kind: "image", image: key });
    } else if (type === "GRADIENT_LINEAR") {
      const stops = figList(paint.stops).map(figRecord).map((stop) => ({ color: figRgba(stop?.color, opacity), offset: Math.min(1, Math.max(0, figNumber(stop?.position) ?? 0)) })).filter((stop): stop is { color: DesignColor; offset: number } => stop.color !== null);
      // The matrix of the paint takes a point of the layer (0-1 on each side) to the space of the gradient, where the
      // colours go from 0 to 1 along x at half height: the two ends on the layer are the inverse of those two points.
      const m = matrixOf(paint.transform);
      const det = m.a * m.d - m.b * m.c;
      if (stops.length < 2 || Math.abs(det) < 1e-9) { paints.push({ kind: "other", what: "sfumatura non leggibile" }); continue; }
      const back = (u: number, v: number) => ({ x: (m.d * (u - m.e) - m.c * (v - m.f)) / det, y: (-m.b * (u - m.e) + m.a * (v - m.f)) / det });
      const [start, end] = [back(0, 0.5), back(1, 0.5)];
      const dx = (end.x - start.x) * box.width;
      const dy = (end.y - start.y) * box.height;
      paints.push({ kind: "linear", angle: round((Math.atan2(dx, -dy) * 180) / Math.PI + 360, 1) % 360, stops });
    } else paints.push({ kind: "other", what: type.startsWith("GRADIENT") ? "sfumatura non lineare" : type === "VIDEO" ? "video" : "riempimento non convertito" });
  }
  return paints;
}

/**
 * The paragraphs of a text layer. `textData.characters` is the whole text, a new line ends a paragraph;
 * `characterStyleIDs` gives a number to each character and `styleOverrideTable` says what the characters of that
 * number change of the style of the layer. Null when there is no text.
 */
function figTextOf(node: KiwiRecord): DesignText | null {
  const data = figRecord(node.textData);
  const characters = figText(data?.characters).slice(0, TEXT_MAX);
  if (!characters.trim()) return null;
  const ids = figList(data?.characterStyleIDs);
  const table = new Map<number, KiwiRecord>();
  for (const entry of figList(data?.styleOverrideTable).map(figRecord)) if (entry && figNumber(entry.styleID) !== null) table.set(figNumber(entry.styleID)!, entry);
  // The weight Figma computed for each font the text uses; otherwise the name of the font style says it.
  const weights = new Map<string, number>();
  for (const meta of figList(figRecord(node.derivedTextData)?.fontMetaData).map(figRecord)) {
    const key = figRecord(meta?.key);
    const weight = figNumber(meta?.fontWeight);
    if (key && weight !== null && weight >= 1 && weight <= 1000) weights.set(`${figText(key.family)}\n${figText(key.style)}`, Math.round(weight));
  }
  const styles = new Map<number, Omit<DesignRun, "text">>();
  const styleOf = (id: number): Omit<DesignRun, "text"> => {
    const known = styles.get(id);
    if (known) return known;
    const own = id ? table.get(id) : undefined;
    const get = (key: string) => (own && own[key] !== undefined ? own[key] : node[key]);
    const size = figNumber(get("fontSize")) ?? 16;
    const font = figRecord(get("fontName"));
    const fontStyle = figText(font?.style);
    const leading = figRecord(get("lineHeight"));
    const leadingValue = figNumber(leading?.value) ?? 0;
    // RAW is a multiplier of the font size, PIXELS a length; PERCENT is the automatic line height.
    const lineHeight = leadingValue <= 0 || size <= 0 ? null : figText(leading?.units) === "RAW" ? round(leadingValue, 3) : figText(leading?.units) === "PIXELS" ? round(leadingValue / size, 3) : null;
    const spacing = figRecord(get("letterSpacing"));
    const spacingValue = figNumber(spacing?.value) ?? 0;
    const textCase = figText(get("textCase"));
    const style: Omit<DesignRun, "text"> = {
      sizePx: round(size),
      weight: weights.get(`${figText(font?.family)}\n${fontStyle}`) ?? figFontWeight(fontStyle),
      italic: /italic|oblique/iu.test(fontStyle),
      family: figText(font?.family).trim(),
      lineHeight,
      letterSpacingPx: round(figText(spacing?.units) === "PIXELS" ? spacingValue : (spacingValue / 100) * size),
      color: paintColor(get("fillPaints")),
      underline: figText(get("textDecoration")) === "UNDERLINE",
      transform: textCase === "UPPER" ? "uppercase" : textCase === "LOWER" ? "lowercase" : textCase === "TITLE" ? "capitalize" : "",
      link: figText(figRecord(get("hyperlink"))?.url).trim(),
    };
    styles.set(id, style);
    return style;
  };
  const paragraphs: DesignRun[][] = [];
  let runs: DesignRun[] = [];
  let piece = "";
  let pieceId = 0;
  const endRun = () => {
    if (piece) runs.push({ text: piece, ...styleOf(pieceId) });
    piece = "";
  };
  const endParagraph = () => {
    endRun();
    if (runs.some((run) => run.text.trim())) paragraphs.push(runs);
    runs = [];
  };
  for (let at = 0; at < characters.length; at += 1) {
    const character = characters[at]!;
    if (character === "\n") { endParagraph(); continue; }
    const id = figNumber(ids[at]) ?? 0;
    if (id !== pieceId) endRun();
    pieceId = id;
    // A line break inside a paragraph is a space: the page decides where a line ends.
    piece += character === " " ? " " : character;
  }
  endParagraph();
  if (!paragraphs.length) return null;
  const wanted = figText(node.textAlignHorizontal);
  return { paragraphs, align: wanted === "CENTER" ? "center" : wanted === "RIGHT" ? "right" : wanted === "JUSTIFIED" ? "justify" : "left" };
}

/** One frame of an index already read. See `figFrame`. */
function frameOf(index: FigIndex, pageRef: string, frameRef: string): DesignPage {
  const listed = pickByName(pageList(index).pages, pageRef, "una pagina");
  const frame = pickByName(listed.frames, frameRef, "un riquadro");
  const page: DesignPage = { file: index.file, page: listed.name, frame: frame.name, source: "figma", root: designNode({ id: frame.id, name: frame.name, kind: "frame" }), images: new Map(), hidden: 0, listed: frame.layers, problems: [] };
  // Frames with the same name: the one converted is said, and the others can be asked for by their id.
  const twins = listed.frames.filter((item) => item.name === frame.name).length - 1;
  if (twins > 0) {
    page.twins = twins;
    page.problems.push({ token: frame.name, why: `${twins + 1} riquadri della pagina hanno questo nome: convertito quello con id ${frame.id}; per un altro scrivi il suo id al posto del nome (${listed.frames.filter((item) => item.name === frame.name && item.id !== frame.id).map((item) => item.id).slice(0, 8).join(", ")})` });
  }
  const counted = new Map<string, number>();
  const count = (why: string) => counted.set(why, (counted.get(why) ?? 0) + 1);
  let made = 0;

  /** The layer `raw` of the file as it is shown inside the copy whose changes are `scope`. */
  const resolve = (raw: KiwiRecord, scope: Level["scope"], prefix: string, props: Level["props"]): Level => {
    const guid = figGuid(raw.guid);
    const key = figGuid(raw.overrideKey) || guid;
    const change = scope?.get(key);
    let node = change ? merge(raw, change) : raw;
    // A property of the component: the copy gives the text, or says whether the layer shows.
    for (const ref of props ? figList(raw.componentPropRefs).map(figRecord) : []) {
      const value = ref ? props!.get(figGuid(ref.defID)) : undefined;
      const field = figText(ref?.componentPropNodeField);
      const characters = figRecord(value?.textValue)?.characters;
      if (field === "TEXT_DATA" && typeof characters === "string" && change?.textData === undefined) node = merge(node, { textData: merge(figRecord(node.textData), { characters, characterStyleIDs: [] }) });
      else if (field === "VISIBLE" && typeof value?.boolValue === "boolean" && change?.visible === undefined) node = merge(node, { visible: value.boolValue });
    }
    const symbol = figText(node.type) === "INSTANCE" ? symbolOf(index, node) : null;
    if (symbol) {
      // What the copy does not say, its component says.
      const base = Object.create(null) as KiwiRecord;
      for (const field of Object.keys(symbol)) if (!OWN_FIELDS.has(field)) base[field] = symbol[field]!;
      node = merge(base, node);
    }
    return { node, guid, id: prefix ? `${prefix};${guid}` : guid, key, scope, prefix, props, symbol };
  };

  /** The children of a layer. Those of a copy are the children of its component, with the changes of the copy and, over them, those the copies around it make to the same layers. */
  const childrenOf = (level: Level): Level[] => {
    if (figText(level.node.type) !== "INSTANCE") return (index.kids.get(level.guid) ?? []).map((child) => resolve(child, level.scope, level.prefix, level.props));
    if (!level.symbol) return [];
    const scope = new Map<string, KiwiRecord>();
    const put = (path: string, change: KiwiRecord) => {
      const merged = merge(scope.get(path), change);
      for (const field of NEVER_CHANGED) delete merged[field];
      scope.set(path, merged);
    };
    // The changes first, then what the layout computed after them: sizes and places win.
    for (const source of [figRecord(level.node.symbolData)?.symbolOverrides, level.node.derivedSymbolData]) {
      for (const change of figList(source).map(figRecord)) {
        const path = change ? figList(figRecord(change.guidPath)?.guids).map(figGuid).filter(Boolean).join("/") : "";
        if (change && path) put(path, change);
      }
    }
    if (level.scope) for (const [path, change] of level.scope) if (path.startsWith(`${level.key}/`)) put(path.slice(level.key.length + 1), change);
    const props = new Map<string, KiwiRecord>();
    for (const assignment of figList(level.node.componentPropAssignments).map(figRecord)) {
      const value = figRecord(assignment?.value);
      if (assignment && value) props.set(figGuid(assignment.defID), value);
    }
    return (index.kids.get(figGuid(level.symbol.guid)) ?? []).map((child) => resolve(child, scope, level.id, props));
  };

  /** The geometry of a layer as paths in the coordinates of its parent, with the corners of what they cover. The fills first, then the strokes, which the file keeps already turned into outlines. */
  const drawn = (node: KiwiRecord, matrix: Matrix): FigDrawing => {
    const paths: FigDrawing["paths"] = [];
    let unread = false;
    const stroke = (figNumber(node.strokeWeight) ?? 0) > 0 ? paintColor(node.strokePaints) : null;
    for (const [geometry, color] of [[node.fillGeometry, paintColor(node.fillPaints)], [node.strokeGeometry, stroke]] as const) {
      if (!color) continue;
      for (const part of figList(geometry).map(figRecord)) {
        const at = figNumber(part?.commandsBlob);
        const bytes = at !== null && Number.isInteger(at) && at >= 0 ? figRecord(index.blobs[at])?.bytes : undefined;
        const commands = bytes instanceof Uint8Array ? figPathCommands(bytes) : null;
        if (!commands) { unread = true; continue; }
        for (const item of commands) for (let n = 0; n < item.points.length; n += 2) [item.points[n], item.points[n + 1]] = [matrix.a * item.points[n]! + matrix.c * item.points[n + 1]! + matrix.e, matrix.b * item.points[n]! + matrix.d * item.points[n + 1]! + matrix.f];
        paths.push({ commands, color, evenOdd: figText(part?.windingRule) === "ODD" });
      }
    }
    return { paths, unread };
  };

  const build = (level: Level, depth: number, parentMode: "row" | "column" | null): DesignNode | null => {
    const raw = level.node;
    const type = figText(raw.type);
    if (!CONTAINERS.has(type) && !SHAPES.has(type) && !VECTORS.has(type) && type !== "TEXT") return null;
    if (raw.visible === false || (figNumber(raw.opacity) ?? 1) <= 0) { page.hidden += 1; return null; }
    made += 1;
    if (made > DESIGN_NODES_MAX) throw new TypeError(`Il riquadro «${frame.name}» ha più di ${DESIGN_NODES_MAX} livelli: scegline uno più piccolo.`);
    const name = figText(raw.name).trim();
    const size = figRecord(raw.size);
    const [width, height] = [Math.max(0, figNumber(size?.x) ?? 0), Math.max(0, figNumber(size?.y) ?? 0)];
    const matrix = matrixOf(raw.transform);
    // The box is what the layer covers in its parent, whatever the matrix does to it.
    const xs = [0, width, 0, width].map((x, corner) => matrix.a * x + matrix.c * (corner < 2 ? 0 : height) + matrix.e);
    const ys = [0, width, 0, width].map((x, corner) => matrix.b * x + matrix.d * (corner < 2 ? 0 : height) + matrix.f);
    const box = { x: round(Math.min(...xs)), y: round(Math.min(...ys)), width: round(Math.max(...xs) - Math.min(...xs)), height: round(Math.max(...ys) - Math.min(...ys)) };
    const rotated = Math.abs(matrix.b) > 0.01 || Math.abs(matrix.c) > 0.01;
    const vector = VECTORS.has(type) || (SHAPES.has(type) && rotated);
    const fills = type === "TEXT" || vector ? [] : figPaints(raw.fillPaints, page.images, { width, height });
    const unsupported: string[] = [];
    if (rotated && !vector) unsupported.push("rotazione");
    const blend = figText(raw.blendMode);
    if (blend && blend !== "NORMAL" && blend !== "PASS_THROUGH") unsupported.push("fusione");
    for (const paint of fills) if (paint.kind === "other") unsupported.push(paint.what);

    const strokeColor = (figNumber(raw.strokeWeight) ?? 0) > 0 || raw.borderStrokeWeightsIndependent === true ? paintColor(raw.strokePaints) : null;
    if (visiblePaints(raw.strokePaints).length > 1) unsupported.push("più di un bordo");
    let stroke: DesignNode["stroke"] = null;
    if (strokeColor && !vector && type !== "TEXT") {
      const weight = round(figNumber(raw.strokeWeight) ?? 0);
      const sides = raw.borderStrokeWeightsIndependent === true ? (["borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"].map((key) => round(Math.max(0, figNumber(raw[key]) ?? 0))) as [number, number, number, number]) : null;
      const uneven = sides !== null && sides.some((side) => side !== sides[0]);
      const widest = sides ? Math.max(...sides) : weight;
      if (widest > 0) stroke = { color: strokeColor, width: widest, dashed: figList(raw.dashPattern).length > 0, ...(uneven ? { sides: sides! } : {}) };
    }

    const shadows: DesignNode["shadows"] = [];
    for (const effect of figList(raw.effects).map(figRecord)) {
      if (!effect || effect.visible === false) continue;
      const kind = figText(effect.type);
      const offset = figRecord(effect.offset);
      const color = figRgba(effect.color);
      if ((kind === "DROP_SHADOW" || kind === "INNER_SHADOW") && color) shadows.push({ x: round(figNumber(offset?.x) ?? 0), y: round(figNumber(offset?.y) ?? 0), blur: round(figNumber(effect.radius) ?? 0), spread: round(figNumber(effect.spread) ?? 0), color, inset: kind === "INNER_SHADOW" });
      else unsupported.push(kind === "FOREGROUND_BLUR" ? "sfocatura" : kind === "BACKGROUND_BLUR" ? "sfocatura dello sfondo" : "effetto non convertito");
    }

    const all = Math.max(0, figNumber(raw.cornerRadius) ?? 0);
    const corner = (key: string) => round(raw.rectangleCornerRadiiIndependent === true ? Math.max(0, figNumber(raw[key]) ?? 0) : all);
    const own = figText(raw.stackMode);
    const [ownRow, ownColumn] = [own === "HORIZONTAL", own === "VERTICAL"];
    // Along its direction a frame with a layout takes the size of its children unless the file says FIXED; across it, only when the file says so.
    const along: DesignSizing = figText(raw.stackPrimarySizing) === "FIXED" ? "fixed" : "hug";
    const across: DesignSizing = figText(raw.stackCounterSizing).startsWith("RESIZE_TO_FIT") ? "hug" : "fixed";
    const sizing: DesignNode["sizing"] = { horizontal: ownRow ? along : ownColumn ? across : "fixed", vertical: ownColumn ? along : ownRow ? across : "fixed" };
    const absolute = parentMode !== null && figText(raw.stackPositioning) === "ABSOLUTE";
    if (parentMode && !absolute) {
      const [grow, stretch] = [figNumber(raw.stackChildPrimaryGrow) === 1, figText(raw.stackChildAlignSelf) === "STRETCH"];
      if (parentMode === "row" ? grow : stretch) sizing.horizontal = "fill";
      if (parentMode === "row" ? stretch : grow) sizing.vertical = "fill";
    }
    const tag = figText(raw.accessibleHTMLTag);
    const node = designNode({
      id: level.id,
      name,
      kind: type === "TEXT" ? "text" : vector ? "vector" : SHAPES.has(type) ? "shape" : "frame",
      box,
      fills: fills.filter((paint) => paint.kind !== "other"),
      stroke,
      radii: [corner("rectangleTopLeftCornerRadius"), corner("rectangleTopRightCornerRadius"), corner("rectangleBottomRightCornerRadius"), corner("rectangleBottomLeftCornerRadius")],
      shadows,
      opacity: round(Math.min(1, figNumber(raw.opacity) ?? 1), 3),
      clip: CONTAINERS.has(type) && raw.frameMaskDisabled === false,
      round: type === "ELLIPSE",
      absolute,
      sizing,
      tag: tag && tag !== "AUTO" ? tag.toLowerCase() : "",
      unsupported,
    });
    if (level.symbol) node.component = { id: figGuid(level.symbol.guid), ...componentName(level.symbol), main: false };
    else if (type === "SYMBOL") node.component = { id: level.guid, ...componentName(raw), main: true };

    if (type === "TEXT") {
      node.text = figTextOf(raw);
      if (!node.text) return null;
      // A text grows with its words: only a width the designer fixed is kept.
      node.sizing = { horizontal: sizing.horizontal === "fill" ? "fill" : figText(raw.textAutoResize) === "WIDTH_AND_HEIGHT" ? "hug" : "fixed", vertical: "hug" };
      return node;
    }
    if (vector) {
      const lineColor = type === "LINE" && !rotated && (figNumber(raw.strokeWeight) ?? 0) > 0 ? paintColor(raw.strokePaints) : null;
      if (lineColor) {
        // A straight line stays a line with its stroke: the writer makes a rule of it.
        node.paths = [{ d: `M0 0L${round(width)} 0`, fill: null, stroke: lineColor, strokeWidth: round(figNumber(raw.strokeWeight)!), evenOdd: false }];
        return node;
      }
      const { paths, unread } = drawn(raw, matrix);
      if (unread) count("tracciato con comandi non letti: resta vuoto o incompleto");
      if (!paths.length) { if (!unread) count("tracciato senza colore: non disegnato"); return node; }
      // A stroke goes out of the box of its layer by half its width: the box grows to hold what is drawn.
      const [px, py] = [paths.flatMap((path) => path.commands.flatMap((item) => item.points.filter((_, n) => n % 2 === 0))), paths.flatMap((path) => path.commands.flatMap((item) => item.points.filter((_, n) => n % 2 === 1)))];
      const [left, top] = [Math.min(box.x, ...px), Math.min(box.y, ...py)];
      node.box = { x: round(left), y: round(top), width: round(Math.max(box.x + box.width, ...px) - left), height: round(Math.max(box.y + box.height, ...py) - top) };
      let length = 0;
      const out: DesignPath[] = [];
      for (const path of paths) {
        const d = path.commands.map((item) => item.command + item.points.map((point, n) => round(point - (n % 2 === 0 ? left : top))).join(" ")).join("");
        length += d.length;
        if (length > PATH_MAX) { count("tracciato troppo lungo: resta vuoto o incompleto"); break; }
        out.push({ d, fill: path.color, stroke: null, strokeWidth: 0, evenOdd: path.evenOdd });
      }
      node.paths = out;
      return node;
    }
    if (node.kind === "shape") {
      if (node.fills.length === 1 && node.fills[0]!.kind === "image") node.kind = "image";
      return node;
    }

    node.layout = figLayout(raw);
    if (own === "GRID") count("auto layout a griglia: i figli sono messi secondo le loro posizioni");
    if (type === "INSTANCE" && !level.symbol) count("copia senza il suo componente nel file: resta vuota");
    const children: DesignNode[] = [];
    let mask: Level | null = null;
    if (depth < DESIGN_DEPTH_MAX) {
      for (const child of childrenOf(level)) {
        // A mask is not drawn: it cuts the layers over it.
        if (child.node.mask === true && child.node.visible !== false) { mask ??= child; continue; }
        const built = build(child, depth + 1, node.layout ? node.layout.mode === "row" ? "row" : "column" : null);
        if (built) children.push(built);
      }
    }
    if (mask) {
      node.unsupported.push("maschera");
      const cut = build({ ...mask, node: merge(mask.node, { mask: false }) }, depth + 1, null);
      // A group that only holds the mask and what it cuts becomes the box of the mask, with its corners.
      if (cut && !node.layout && !node.fills.length && !node.stroke && (cut.kind === "shape" || cut.kind === "image") && cut.box.width > 0 && cut.box.height > 0) {
        node.box = { x: round(box.x + cut.box.x), y: round(box.y + cut.box.y), width: cut.box.width, height: cut.box.height };
        for (const child of children) child.box = { ...child.box, x: round(child.box.x - cut.box.x), y: round(child.box.y - cut.box.y) };
        node.clip = true;
        node.radii = cut.radii;
        node.round = cut.round;
      }
    }
    const layout = node.layout;
    if (layout) {
      // The file keeps the children in the order of the layout, which is also the order from the bottom layer to the top one: a child out of the flow stays where it is, under or over the others.
      for (const child of children) child.alignSelf = crossPlace(layout, node.box, child);
    }
    node.children = children;
    // A frame that only shows a picture is a picture.
    if (!children.length && node.fills.length === 1 && node.fills[0]!.kind === "image") node.kind = "image";
    else if (!children.length && (node.fills.length || node.stroke || node.shadows.length)) node.kind = "shape";
    else if (!children.length) return null;
    return node;
  };

  /** The name of a component; a variant is named by the set it belongs to, and keeps its own name (`Size=Large, State=Hover`) as `variant`. */
  function componentName(symbol: KiwiRecord): { name: string; variant?: string } {
    const set = index.byId.get(figGuid(figRecord(symbol.parentIndex)?.guid));
    const own = figText(symbol.name).trim();
    return set && set.isStateGroup === true ? { name: figText(set.name).trim() || own, variant: own } : { name: own };
  }

  const top = index.byId.get(frame.id);
  const root = top ? build(resolve(top, null, "", null), 0, null) : null;
  if (!root || root.kind !== "frame") throw new TypeError(`Il riquadro «${frame.name}» è vuoto o nascosto.`);
  root.box.x = 0;
  root.box.y = 0;
  page.root = root;
  for (const [why, times] of counted) page.problems.push({ token: frame.name, why: times === 1 ? why : `${times} volte: ${why}` } satisfies TokenProblem);
  return page;
}

/**
 * One frame of one page as a neutral tree. `canvas` is the bytes of `canvas.fig`, `file` the name shown in the
 * report; `pageRef` and `frameRef` are an id, a name or a part of a name. The pictures are named in `images`
 * without their bytes: `attachFigImages` adds them. Throws a TypeError, in Italian, for bytes that are not a Figma
 * document, for a page or a frame that is not there and for a frame with more than `DESIGN_NODES_MAX` layers.
 */
export function figFrame(canvas: Uint8Array, file: string, pageRef: string, frameRef: string): DesignPage {
  return frameOf(figIndex(canvas, file), pageRef, frameRef);
}

/** Puts the bytes of each picture of the page, from the `images/` entries read with `figImageEntry`. A picture without its entry stays empty and is said in `problems`. */
export function attachFigImages(page: DesignPage, files: ReadonlyMap<string, Uint8Array>): void {
  for (const [name, bytes] of files) {
    const match = IMAGE_ENTRY.exec(name);
    const image = match ? page.images.get(match[1]!) : undefined;
    if (image) image.bytes = bytes;
  }
  const missing = [...page.images.values()].filter((image) => image.bytes.length === 0).length;
  if (missing) page.problems.push({ token: page.frame, why: `${missing} ${missing === 1 ? "immagine senza il suo file nell'archivio, o più grande di 15 MB" : "immagini senza il loro file nell'archivio, o più grandi di 15 MB"}` });
}
