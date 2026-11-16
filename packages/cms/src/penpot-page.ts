/**
 * One frame of a page of a `.penpot` file as a neutral tree (note penpot-figma-a-histeon.md, phase 3).
 *
 * In the archive a page is `files/<file>/pages/<page>.json` and every shape of it is one JSON beside it,
 * `files/<file>/pages/<page>/<shape>.json`; the root of the page is the shape with the all-zero id, and `shapes`
 * of a shape lists its children. A shape has its place on the page (`selrect`), so the box of a node is the
 * difference with the box of its parent. A picture is named by a media id: `files/<file>/media/<id>.json` leads to
 * the object, `objects/<object>.<ext>`.
 *
 * Files written by the plugin that exports from Figma to Penpot keep some fields this reader cannot trust (the
 * direction is `row-reverse` so that the order of the layers stays that of Figma, the place of a child across the
 * direction is always written): the order of the children and their place are therefore read from the coordinates.
 *
 * Pure: it receives the entries already read (design-zip.ts) and returns data. No network, no credentials.
 */

import type { TokenProblem } from "./design-tokens.js";
import {
  crossPlace,
  DESIGN_DEPTH_MAX,
  DESIGN_NODES_MAX,
  type DesignAlign,
  designColor,
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
} from "./design-tree.js";
import type { PenpotEntries } from "./penpot-file.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_ENTRY = new RegExp(`^files/(${UUID})/pages/(${UUID})(?:/(${UUID}))?\\.json$`, "u");
const SMALL_ENTRY = new RegExp(`^files/${UUID}(?:\\.json|/(?:media|components)/${UUID}\\.json)$`, "u");
const OBJECT_ENTRY = new RegExp(`^objects/(${UUID})\\.(?:png|jpe?g|gif|webp)$`, "iu");
const ROOT_SHAPE = "00000000-0000-0000-0000-000000000000";
/** One JSON of a page is small; the shape of a long path is the largest. */
const PAGE_ENTRY_MAX = 8 * 1024 * 1024;
/** One picture of the design: the prototype takes media of at most 15 MB. */
const OBJECT_ENTRY_MAX = 15 * 1024 * 1024;
/** The `d` of one path: an illustration traced point by point is left out and said. */
const PATH_MAX = 200_000;

type Shape = Record<string, unknown>;

interface PenpotIndex {
  file: string;
  fromFigma: boolean;
  pages: Array<{ id: string; name: string; index: number; shapes: Map<string, Shape> }>;
  /** Media id → the object that holds the bytes. */
  media: Map<string, { object: string; mime: string; width: number; height: number }>;
  components: Map<string, string>;
  problems: TokenProblem[];
}

/** The entries the pages need: the manifest, the files, every page and shape, the media and component cards. Not the pictures. */
export function penpotPageEntry(name: string, size: number): boolean {
  return size <= PAGE_ENTRY_MAX && (name === "manifest.json" || PAGE_ENTRY.test(name) || SMALL_ENTRY.test(name));
}

/** The entries that hold the pictures of one page already read: `objects/<key>.<ext>` for each key of `page.images`. */
export function penpotObjectEntry(page: DesignPage): (name: string, size: number) => boolean {
  return (name, size) => {
    const match = OBJECT_ENTRY.exec(name);
    return match !== null && size <= OBJECT_ENTRY_MAX && page.images.has(match[1]!.toLowerCase());
  };
}

function plain(value: unknown): value is Shape {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown): string => (typeof value === "string" ? value : "");
/** A number Penpot wrote as a number or as a text (`"16"`); `fallback` for anything else. */
function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e-?\d+)?$/iu.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** Everything of the archive the pages need, by id. Throws a TypeError when the archive is not an export of Penpot. */
function penpotIndex(entries: PenpotEntries): PenpotIndex {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const problems: TokenProblem[] = [];
  const json = (name: string): Shape | null => {
    const bytes = entries.files.get(name);
    if (!bytes) return null;
    try {
      const data: unknown = JSON.parse(decoder.decode(bytes));
      if (plain(data)) return data;
    } catch { /* reported below */ }
    problems.push({ token: name, why: "il file dell'archivio non è JSON leggibile" });
    return null;
  };
  const manifest = json("manifest.json");
  if (!manifest || manifest.type !== "penpot/export-files" || !Array.isArray(manifest.files)) throw new TypeError("Il file non è un'esportazione di Penpot (manca manifest.json di tipo penpot/export-files).");
  const first = manifest.files.filter(plain)[0];
  const index: PenpotIndex = { file: text(first?.name) || "Senza nome", fromFigma: /penpot-exporter-figma/u.test(text(manifest.referer)), pages: [], media: new Map(), components: new Map(), problems };
  const pages = new Map<string, PenpotIndex["pages"][number]>();
  const pageOf = (id: string) => {
    let page = pages.get(id);
    if (!page) {
      page = { id, name: "", index: pages.size, shapes: new Map() };
      pages.set(id, page);
    }
    return page;
  };
  for (const name of entries.files.keys()) {
    const match = PAGE_ENTRY.exec(name);
    if (match) {
      const data = json(name);
      if (!data) continue;
      const page = pageOf(match[2]!);
      if (match[3] === undefined) {
        page.name = text(data.name).trim() || "Pagina";
        page.index = num(data.index, page.index);
      } else page.shapes.set(text(data.id) || match[3], data);
      continue;
    }
    const parts = name.split("/");
    if (parts.length !== 4 || (parts[2] !== "media" && parts[2] !== "components")) continue;
    const data = json(name);
    if (!data) continue;
    if (parts[2] === "components") index.components.set(text(data.id), text(data.name).trim());
    else if (new RegExp(`^${UUID}$`, "u").test(text(data.mediaId))) index.media.set(text(data.id), { object: text(data.mediaId).toLowerCase(), mime: text(data.mtype), width: num(data.width), height: num(data.height) });
  }
  index.pages = [...pages.values()].sort((a, b) => a.index - b.index);
  return index;
}

/** The pages of the file and the frames at the top of each, with how many layers each frame holds. */
export function penpotPageList(entries: PenpotEntries): DesignPageList {
  const index = penpotIndex(entries);
  const count = (shapes: Map<string, Shape>, id: string, depth: number): number => {
    const shape = shapes.get(id);
    if (!shape || depth > DESIGN_DEPTH_MAX) return 0;
    let total = 1;
    for (const child of Array.isArray(shape.shapes) ? shape.shapes : []) total += count(shapes, text(child), depth + 1);
    return total;
  };
  return {
    file: index.file,
    source: "penpot",
    pages: index.pages.map((page) => {
      const top = page.shapes.get(ROOT_SHAPE);
      const frames = (Array.isArray(top?.shapes) ? top.shapes : []).map((id) => page.shapes.get(text(id))).filter((shape): shape is Shape => shape !== undefined && (shape.type === "frame" || shape.type === "group") && shape.hidden !== true);
      return { id: page.id, name: page.name, frames: frames.map((shape) => ({ id: text(shape.id), name: text(shape.name).trim(), width: Math.round(num(plain(shape.selrect) ? shape.selrect.width : 0)), height: Math.round(num(plain(shape.selrect) ? shape.selrect.height : 0)), layers: count(page.shapes, text(shape.id), 0) })) };
    }),
  };
}

/** The one item `wanted` names: by id, by its whole name, or by a part of it when a single name has it. Case and outer spaces do not count. */
export function pickByName<T extends { id: string; name: string }>(items: readonly T[], wanted: string, what: string): T {
  const key = wanted.trim().toLowerCase();
  const exact = items.filter((item) => item.id === key || item.name.trim().toLowerCase() === key);
  const found = exact.length ? exact : items.filter((item) => key !== "" && item.name.toLowerCase().includes(key));
  if (found.length === 1 || (exact.length > 1 && found.length)) return found[0]!;
  const names = items.slice(0, 40).map((item) => `«${item.name}»`).join(", ");
  throw new TypeError(found.length ? `Più di ${what} ha «${wanted}» nel nome: scrivi il nome intero. Ci sono: ${names}.` : `Nessun ${what} si chiama «${wanted}». Ci sono: ${names || "nessuno"}.`);
}

/** The fills of a shape as paints, the top one first; a fill that cannot be seen is left out. */
function penpotPaints(fills: unknown, index: PenpotIndex, images: DesignPage["images"], box: { width: number; height: number }): DesignPaint[] {
  const paints: DesignPaint[] = [];
  for (const fill of Array.isArray(fills) ? fills.filter(plain) : []) {
    const opacity = num(fill.fillOpacity, 1);
    if (opacity <= 0) continue;
    const gradient = plain(fill.fillColorGradient) ? fill.fillColorGradient : null;
    const image = plain(fill.fillImage) ? fill.fillImage : null;
    if (image) {
      const media = index.media.get(text(image.id));
      if (!media) { paints.push({ kind: "other", what: "immagine senza il suo file" }); continue; }
      images.set(media.object, { bytes: new Uint8Array(0), mime: media.mime || text(image.mtype), width: media.width || num(image.width), height: media.height || num(image.height) });
      paints.push({ kind: "image", image: media.object });
    } else if (gradient) {
      const stops = (Array.isArray(gradient.stops) ? gradient.stops.filter(plain) : []).map((stop) => ({ color: designColor(stop.color, num(stop.opacity, 1) * opacity), offset: Math.min(1, Math.max(0, num(stop.offset))) })).filter((stop): stop is { color: NonNullable<ReturnType<typeof designColor>>; offset: number } => stop.color !== null);
      if (gradient.type !== "linear" || stops.length < 2) { paints.push({ kind: "other", what: "sfumatura non lineare" }); continue; }
      // The two ends are fractions of the box: the angle CSS wants is measured on the real box, 0 pointing up.
      const dx = (num(gradient.endX) - num(gradient.startX)) * box.width;
      const dy = (num(gradient.endY) - num(gradient.startY)) * box.height;
      paints.push({ kind: "linear", angle: round((Math.atan2(dx, -dy) * 180) / Math.PI + 360, 1) % 360, stops });
    } else {
      const color = designColor(fill.fillColor, opacity);
      if (color) paints.push({ kind: "solid", color });
    }
  }
  return paints;
}

/** The paragraphs of a text shape: `content` is root → paragraph-set → paragraph → pieces of text, each with its style. */
function penpotText(shape: Shape): DesignNode["text"] {
  const sets = plain(shape.content) && Array.isArray(shape.content.children) ? shape.content.children.filter(plain) : [];
  const paragraphs: DesignRun[][] = [];
  let align: NonNullable<DesignNode["text"]>["align"] = "left";
  for (const paragraph of sets.flatMap((set) => (Array.isArray(set.children) ? set.children.filter(plain) : []))) {
    const wanted = text(paragraph.textAlign);
    if (!paragraphs.length && (wanted === "center" || wanted === "right" || wanted === "justify")) align = wanted;
    const runs: DesignRun[] = [];
    for (const piece of Array.isArray(paragraph.children) ? paragraph.children.filter(plain) : []) {
      if (typeof piece.text !== "string" || piece.text === "") continue;
      const fill = (Array.isArray(piece.fills) ? piece.fills.filter(plain) : [])[0];
      const transform = text(piece.textTransform);
      const size = num(piece.fontSize, 16);
      const leading = num(piece.lineHeight, 0);
      runs.push({
        text: piece.text,
        sizePx: round(size),
        weight: Math.min(1000, Math.max(1, Math.round(num(piece.fontWeight, 400)))),
        italic: text(piece.fontStyle) === "italic",
        family: text(piece.fontFamily).trim(),
        lineHeight: leading > 0 ? round(leading, 3) : null,
        letterSpacingPx: round(num(piece.letterSpacing)),
        color: fill ? designColor(fill.fillColor, num(fill.fillOpacity, 1)) : null,
        underline: text(piece.textDecoration) === "underline",
        transform: transform === "uppercase" || transform === "lowercase" || transform === "capitalize" ? transform : "",
        link: "",
      });
    }
    if (runs.length) paragraphs.push(runs);
  }
  return paragraphs.length ? { paragraphs, align } : null;
}

/** The commands of a path shape as the `d` of an SVG path, moved so that the corner of the box is 0,0. Null for a content that is not a list of commands or is too long. */
function penpotPath(content: unknown, x: number, y: number): string | null {
  if (!Array.isArray(content)) return null;
  const out: string[] = [];
  let length = 0;
  for (const item of content.filter(plain)) {
    const p = plain(item.params) ? item.params : {};
    const at = (key: string, origin: number) => round(num(p[key]) - origin);
    const command = text(item.command);
    const piece =
      command === "move-to" ? `M${at("x", x)} ${at("y", y)}`
      : command === "line-to" ? `L${at("x", x)} ${at("y", y)}`
      : command === "curve-to" ? `C${at("c1x", x)} ${at("c1y", y)} ${at("c2x", x)} ${at("c2y", y)} ${at("x", x)} ${at("y", y)}`
      : command === "close-path" ? "Z"
      : "";
    if (!piece) return null;
    length += piece.length;
    if (length > PATH_MAX) return null;
    out.push(piece);
  }
  return out.length ? out.join("") : null;
}

const JUSTIFY: Record<string, DesignJustify> = { start: "start", center: "center", end: "end", "space-between": "between", "space-around": "around", "space-evenly": "evenly" };
const ALIGN: Record<string, DesignAlign> = { start: "start", center: "center", end: "end", stretch: "stretch" };
const SIZING: Record<string, DesignSizing> = { fix: "fixed", auto: "hug", fill: "fill" };

/** The auto layout of a frame, or null. In a file of Penpot itself a reversed direction turns the two ends. */
function penpotLayout(shape: Shape, fromFigma: boolean): DesignLayout | null {
  if (shape.layout !== "flex" && shape.layout !== "grid") return null;
  const gap = plain(shape.layoutGap) ? shape.layoutGap : {};
  const pad = plain(shape.layoutPadding) ? shape.layoutPadding : {};
  const padding: DesignLayout["padding"] = [num(pad.p1), num(pad.p2), num(pad.p3), num(pad.p4)].map((value) => round(Math.max(0, value))) as DesignLayout["padding"];
  const align = ALIGN[text(shape.layoutAlignItems)] ?? "start";
  if (shape.layout === "grid") {
    const columns = Array.isArray(shape.layoutGridColumns) ? shape.layoutGridColumns.length : 0;
    return { mode: "grid", gap: round(num(gap.columnGap)), crossGap: round(num(gap.rowGap)), padding, justify: "start", align, wrap: false, columns: Math.max(1, columns) };
  }
  const direction = text(shape.layoutFlexDir) || "row";
  const row = direction.startsWith("row");
  let justify = JUSTIFY[text(shape.layoutJustifyContent)] ?? "start";
  if (!fromFigma && direction.endsWith("-reverse")) justify = justify === "start" ? "end" : justify === "end" ? "start" : justify;
  return { mode: row ? "row" : "column", gap: round(num(row ? gap.columnGap : gap.rowGap)), crossGap: round(num(row ? gap.rowGap : gap.columnGap)), padding, justify, align, wrap: text(shape.layoutWrapType) === "wrap", columns: 0 };
}

/**
 * One frame of one page as a neutral tree. `pageRef` and `frameRef` are an id, a name or a part of a name. The
 * pictures are named in `images` without their bytes: `attachPenpotImages` adds them. Throws a TypeError, in
 * Italian, for a page or a frame that is not there and for a frame with more than `DESIGN_NODES_MAX` layers.
 */
export function penpotFrame(entries: PenpotEntries, pageRef: string, frameRef: string): DesignPage {
  const index = penpotIndex(entries);
  const list = penpotPageList(entries);
  const listed = pickByName(list.pages, pageRef, "una pagina");
  const frame = pickByName(listed.frames, frameRef, "un riquadro");
  const shapes = index.pages.find((page) => page.id === listed.id)!.shapes;
  const page: DesignPage = { file: index.file, page: listed.name, frame: frame.name, source: "penpot", root: designNode({ id: frame.id, name: frame.name, kind: "frame" }), images: new Map(), hidden: 0, listed: frame.layers, problems: [...index.problems] };
  // Frames with the same name: the one converted is said, and the others can be asked for by their id.
  const twins = listed.frames.filter((item) => item.name === frame.name).length - 1;
  if (twins > 0) {
    page.twins = twins;
    page.problems.push({ token: frame.name, why: `${twins + 1} riquadri della pagina hanno questo nome: convertito quello con id ${frame.id}; per un altro scrivi il suo id al posto del nome (${listed.frames.filter((item) => item.name === frame.name && item.id !== frame.id).map((item) => item.id).slice(0, 8).join(", ")})` });
  }
  let made = 0;
  const rect = (shape: Shape) => {
    const r = plain(shape.selrect) ? shape.selrect : shape;
    return { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) };
  };
  const build = (shape: Shape, origin: { x: number; y: number }, depth: number): DesignNode | null => {
    if (shape.hidden === true || num(shape.opacity, 1) <= 0) { page.hidden += 1; return null; }
    made += 1;
    if (made > DESIGN_NODES_MAX) throw new TypeError(`Il riquadro «${frame.name}» ha più di ${DESIGN_NODES_MAX} livelli: scegline uno più piccolo.`);
    const at = rect(shape);
    const type = text(shape.type);
    const name = text(shape.name).trim();
    const box = { x: round(at.x - origin.x), y: round(at.y - origin.y), width: round(at.width), height: round(at.height) };
    const fills = type === "text" ? [] : penpotPaints(shape.fills, index, page.images, at);
    const strokes = (Array.isArray(shape.strokes) ? shape.strokes.filter(plain) : []).filter((stroke) => num(stroke.strokeWidth) > 0 && num(stroke.strokeOpacity, 1) > 0);
    const strokeColor = strokes[0] ? designColor(strokes[0].strokeColor, num(strokes[0].strokeOpacity, 1)) : null;
    const unsupported: string[] = [];
    if (Math.abs(num(shape.rotation)) > 0.5) unsupported.push("rotazione");
    if (shape.maskedGroup === true) unsupported.push("maschera");
    if (plain(shape.blur) && shape.blur.hidden !== true) unsupported.push("sfocatura");
    if (text(shape.blendMode) && text(shape.blendMode) !== "normal") unsupported.push("fusione");
    if (strokes.length > 1) unsupported.push("più di un bordo");
    for (const paint of fills) if (paint.kind === "other") unsupported.push(paint.what);
    const node = designNode({
      id: text(shape.id),
      name,
      kind: type === "text" ? "text" : type === "path" || type === "bool" ? "vector" : type === "rect" || type === "circle" || type === "image" ? "shape" : "frame",
      box,
      fills: fills.filter((paint) => paint.kind !== "other"),
      stroke: strokeColor && type !== "path" && type !== "bool" ? { color: strokeColor, width: round(num(strokes[0]!.strokeWidth)), dashed: /dash|dot/u.test(text(strokes[0]!.strokeStyle)) } : null,
      radii: [num(shape.r1, num(shape.rx)), num(shape.r2, num(shape.rx)), num(shape.r3, num(shape.rx)), num(shape.r4, num(shape.rx))].map((value) => round(Math.max(0, value))) as DesignNode["radii"],
      shadows: (Array.isArray(shape.shadow) ? shape.shadow.filter(plain) : []).filter((shadow) => shadow.hidden !== true).flatMap((shadow) => {
        const color = plain(shadow.color) ? designColor(shadow.color.color, num(shadow.color.opacity, 1)) : null;
        return color ? [{ x: round(num(shadow.offsetX)), y: round(num(shadow.offsetY)), blur: round(num(shadow.blur)), spread: round(num(shadow.spread)), color, inset: text(shadow.style) === "inner-shadow" }] : [];
      }),
      opacity: round(Math.min(1, num(shape.opacity, 1)), 3),
      clip: type === "frame" && shape.showContent === false,
      round: type === "circle",
      // A negative margin is how a layer is drawn over the one before it (the background of a button): it is out of the flow.
      absolute: shape.layoutItemAbsolute === true || (plain(shape.layoutItemMargin) && Object.values(shape.layoutItemMargin).some((margin) => num(margin) < 0)),
      // Penpot writes `layoutItemHSizing`; files of older versions have `layoutItemHsizing`.
      sizing: { horizontal: SIZING[text(shape.layoutItemHSizing) || text(shape.layoutItemHsizing)] ?? "fixed", vertical: SIZING[text(shape.layoutItemVSizing) || text(shape.layoutItemVsizing)] ?? "fixed" },
      unsupported,
    });
    if (text(shape.componentId) && (shape.componentRoot === true || shape.mainInstance === true)) node.component = { id: text(shape.componentId), name: index.components.get(text(shape.componentId)) || name, main: shape.mainInstance === true };
    if (type === "text") {
      node.text = penpotText(shape);
      if (!node.text) return null;
      // A text grows with its words: only a width the designer fixed is kept.
      const grow = text(shape.growType);
      node.sizing = { horizontal: node.sizing.horizontal === "fill" ? "fill" : grow === "auto-width" ? "hug" : "fixed", vertical: "hug" };
    } else if (type === "path" || type === "bool") {
      const d = penpotPath(shape.content, at.x, at.y);
      const fill = (Array.isArray(shape.fills) ? shape.fills.filter(plain) : []).map((item) => designColor(item.fillColor, num(item.fillOpacity, 1))).find((color) => color !== null && color.alpha > 0) ?? null;
      const rule = plain(shape.svgAttrs) ? text(shape.svgAttrs.fillRule) || text(shape.svgAttrs["fill-rule"]) : "";
      const path: DesignPath | null = d && (fill || strokeColor) ? { d, fill, stroke: strokeColor, strokeWidth: strokeColor ? round(num(strokes[0]!.strokeWidth)) : 0, evenOdd: rule === "evenodd" } : null;
      if (path) node.paths = [path];
      else page.problems.push({ token: name || "tracciato", why: d ? "tracciato senza colore: non disegnato" : "tracciato non leggibile o troppo lungo: resta vuoto" });
      node.fills = [];
    } else if (type === "image") {
      const media = index.media.get(text(plain(shape.metadata) ? shape.metadata.id : ""));
      if (media) {
        page.images.set(media.object, { bytes: new Uint8Array(0), mime: media.mime, width: media.width, height: media.height });
        node.fills = [{ kind: "image", image: media.object }];
      }
    } else if (type === "svg-raw") {
      page.problems.push({ token: name || "svg", why: "SVG incollato com'è: non convertito" });
      return null;
    }
    if (node.kind === "frame") {
      node.layout = penpotLayout(shape, index.fromFigma);
      const children: DesignNode[] = [];
      if (depth < DESIGN_DEPTH_MAX) {
        for (const id of Array.isArray(shape.shapes) ? shape.shapes : []) {
          const child = shapes.get(text(id));
          const built = child ? build(child, at, depth + 1) : null;
          if (built) children.push(built);
        }
      }
      const layout = node.layout;
      if (layout) {
        // The order the eye reads: along the direction, line by line when the layout wraps or is a grid.
        const row = layout.mode !== "column";
        const line = (child: DesignNode) => (layout.wrap || layout.mode === "grid" ? Math.round((row ? child.box.y : child.box.x) / 8) : 0);
        children.sort((a, b) => Number(a.absolute) - Number(b.absolute) || line(a) - line(b) || (row ? a.box.x - b.box.x : a.box.y - b.box.y));
        for (const child of children) child.alignSelf = crossPlace(layout, box, child);
      }
      node.children = children;
      // A frame that only shows a picture is a picture.
      if (!children.length && node.fills.length === 1 && node.fills[0]!.kind === "image") node.kind = "image";
      else if (!children.length && type !== "group") node.kind = "shape";
      else if (!children.length) return null;
    } else if (node.kind === "shape" && node.fills.length === 1 && node.fills[0]!.kind === "image") node.kind = "image";
    return node;
  };
  const top = shapes.get(frame.id);
  const root = top ? build(top, rect(top), 0) : null;
  if (!root) throw new TypeError(`Il riquadro «${frame.name}» è vuoto o nascosto.`);
  root.box.x = 0;
  root.box.y = 0;
  page.root = root;
  return page;
}

/** Puts the bytes of each picture of the page, from the `objects/` entries read with `penpotObjectEntry`. A picture without its entry stays empty and is said in `problems`. */
export function attachPenpotImages(page: DesignPage, entries: PenpotEntries): void {
  for (const [name, bytes] of entries.files) {
    const match = OBJECT_ENTRY.exec(name);
    const image = match ? page.images.get(match[1]!.toLowerCase()) : undefined;
    if (image) image.bytes = bytes;
  }
  const missing = [...page.images.values()].filter((image) => image.bytes.length === 0).length;
  if (missing) page.problems.push({ token: page.frame, why: `${missing} ${missing === 1 ? "immagine senza il suo file nell'archivio, o più grande di 15 MB" : "immagini senza il loro file nell'archivio, o più grandi di 15 MB"}` });
}
