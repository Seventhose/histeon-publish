/**
 * The writer of the prototype (note penpot-figma-a-histeon.md, phase 3): one frame of a design, as a neutral tree
 * (design-tree.ts), becomes a Histeon prototype — one HTML file the importer already knows how to check and import.
 *
 * What the manual of the prototype asks is done here: BEM classes, one rule for each selector with its parts and
 * its `@media` nested, `--xb-*` tokens, media as `data:` assets, icons as inline SVG. Nothing is placed by
 * coordinates: a frame without auto layout is cut in rows and columns from the boxes of its children, and children
 * that overlap share the one cell of a grid. A text size is never a length: it becomes the nearest step of the
 * scale. Every deduction and everything that is not converted goes to the report, never lost in silence.
 *
 * Node only (Buffer, for the base64 of the media). No network, no credentials; nothing is read from or written to
 * disk. The tree it receives is changed in place.
 */

import { DESIGN_NARROW, designAttr, designBlockRule, designComponents, type DesignComponents, type DesignOut, designOutHtml, nameDesignClasses } from "./design-components.js";
import type { TokenProblem } from "./design-tokens.js";
import {
  crossPlace,
  type DesignAlign,
  type DesignColor,
  designColorCss,
  designImageType,
  type DesignLayout,
  type DesignNode,
  designNode,
  type DesignPage,
  type DesignPath,
  type DesignRun,
  designSlug,
  genericLayerName,
  walkDesign,
} from "./design-tree.js";
import { HISTOS_CSS_DESIGN_DATA } from "./histos-design-data.generated.js";
import { changedHistosDesign, computeHistosTokens, type HistosDesign, validateHistosDesign } from "./histos-design.js";

export interface DesignPrototypeOptions {
  /** The id of the prototype, a lowercase UUID: the same id updates the project made by the first import. */
  id: string;
  /** The name of the project; the name of the file and of the frame when it is not given. */
  name?: string;
  /** `it-IT` when it is not given. */
  locale?: string;
  /** Parameters of Histeon CSS for the manifest, for example those `importDesignTokens` read from the same file. */
  design?: HistosDesign;
  /** False leaves every copy of a component as plain elements of its block. */
  components?: boolean;
  /** False keeps a run of cards as uses of their component, without records and loops. */
  records?: boolean;
  /** True gives cards side by side the look of the first one, and one place for their pictures: they can be records even when the design places each picture by hand. It changes how they look. */
  uniform?: boolean;
}

export interface DesignPrototypeReport {
  file: string;
  page: string;
  frame: string;
  source: DesignPage["source"];
  /** The width of the frame: the only width the design has. */
  width: number;
  /** The layers written in the prototype. */
  layers: number;
  /** The layers the list of the frames counts for this frame, when the reader says it: also the hidden and the empty ones, which are not written. */
  listed?: number;
  /** The blocks written, in their order: the header, the sections, the footer. */
  sections: string[];
  /** Frames without auto layout cut in rows and columns. */
  inferred: string[];
  /** Frames whose children overlap: one cell of a grid. */
  stacked: string[];
  /** Layers out of the flow of their frame: they share one cell of a grid with the rest of the frame, under it or over it. */
  absolute: string[];
  /** Rows wider than the page, written as strips that scroll sideways. */
  strips: string[];
  /** Fixed widths written as a largest width. */
  fixedWidths: number;
  /** Rows whose wide gap fills their width, written as `space-between`. */
  spread: number;
  spaces: { token: number; fixed: number };
  textSizes: Array<{ px: number; step: string; stepPx: number; count: number }>;
  /** Font families the design names: the file and its licence are never in the design. */
  fonts: string[];
  headings: number;
  images: number;
  /** Pictures replaced by a placeholder, with the reason. */
  imagesMissing: string[];
  vectors: number;
  /** Buttons and links without an address: `#`. */
  links: number;
  /** Texts with pieces of another colour or size, written with one style. */
  mixedText: number;
  /** Layers with a name the tool gave: their class is named after what they are. */
  genericNames: number;
  unsupported: Array<{ layer: string; what: string }>;
  /** The components of the design used in the frame, and what became of the copies of each: uses of a component of the prototype, markup of a larger component, plain elements. `copies` counts also the ones written as a block of the page or as one drawing. */
  designComponents: Array<{ name: string; copies: number; made: number; nested: number; loose: number }>;
  /** The components written in the prototype. `declared` is false for frames that only repeat; `type` is the type their copies became records of. */
  components: Array<{ ref: string; name: string; copies: number; variants: string[]; props: string[]; slots: string[]; declared: boolean; type: string; uneven: boolean; uniformed: boolean }>;
  /** The types of content deduced from runs of cards. */
  recordTypes: Array<{ key: string; records: number; queries: number }>;
  hidden: number;
  problems: TokenProblem[];
  notes: string[];
}

const ROOT_PX = HISTOS_CSS_DESIGN_DATA.rootPx;
const NARROW = DESIGN_NARROW;
/** One media of a prototype, and all of them: the file must stay under 32 MB once the bytes are base64. */
const ASSET_MAX = 15 * 1024 * 1024;
const ASSETS_TOTAL_MAX = 21 * 1024 * 1024;
const ASSETS_COUNT_MAX = 500;
const ICON_MAX = 400;
const BUTTON_NAME = /(?:^|[^a-z])(?:button|btn|cta|pulsante|bottone)(?:[^a-z]|$)/iu;
const LINK_NAME = /^(?:link|a|anchor|collegamento)$/iu;
const HEADER_NAME = /(?:^|[^a-z])(?:header|nav|navbar|navigation|menu|testata|top ?bar)(?:[^a-z]|$)/iu;
const FOOTER_NAME = /(?:^|[^a-z])(?:footer|piede|pi[eè] di pagina)(?:[^a-z]|$)/iu;
/** Names that are HTML tags say what the layer is, not what it is for: the class is named after the role. */
const TAG_NAME = /^(?:h[1-6]|p|paragraph|a|link|img|ul|ol|li|hr|label)$/iu;

type Steps = Array<[string, number]>;
interface Scales {
  text: Steps;
  heading: Steps;
  space: Steps;
}

/** Where a node is written: the layout of its parent and the room it gives. */
interface Place {
  mode: "row" | "column" | "grid" | "stack" | "flow";
  width: number;
  height: number;
  align: DesignAlign;
  inLink: boolean;
  /** The parent takes its width from its children: a child that fills it keeps its own width. */
  hugs?: boolean;
  /** The parent is a row that becomes a column on a narrow screen. */
  collapses?: boolean;
  /** Inside a button, a field or a chip: its one line of text does not break. */
  label?: boolean;
  /** The parent is a strip that scrolls sideways: its children keep their width. */
  strip?: boolean;
  /** The parent is one cell with several layers: each one is painted in its order. */
  layers?: boolean;
  /** The parent already keeps a gutter at its sides. */
  gutter?: boolean;
}

type Out = DesignOut;

interface Ctx {
  page: DesignPage;
  scales: Scales;
  report: DesignPrototypeReport;
  /** Image key → the asset written, or null for a placeholder. */
  assets: Map<string, { name: string; data: string; alt: string; width: number; height: number } | null>;
  assetBytes: number;
  /** A colour as the design parameters write it → the token of the design that has that colour. */
  colors: Map<string, string>;
  /** `#rrggbb` → the same colour as the design parameters write it. */
  canon: Map<string, string>;
  bodyFamily: string;
  headingFamily: string;
  /** Text node → its heading level. */
  headings: Map<DesignNode, number>;
  /** Nodes whose layout was deduced here. */
  inferred: Set<DesignNode>;
  /** Rows wider than the page: strips that scroll sideways. */
  strips: Set<DesignNode>;
  /** Children of a column that go out of the page on the right → how far from the left of the content of their parent they start. */
  bleed: Map<DesignNode, number>;
  /** Frames whose background was the layer that gave them their size. */
  drawn: Set<DesignNode>;
  textSizes: Map<string, { px: number; step: string; stepPx: number; count: number }>;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** A length in rem; hairlines stay in pixels. */
function rem(px: number): string {
  if (Math.abs(px) < 0.05) return "0";
  if (Math.abs(px) < 4) return `${round(px, 1)}px`;
  return `${round(px / ROOT_PX, 3)}rem`;
}

/** Text for the body of an element: `&`, `<`, `>` as entities, braces as the template language wants them. */
function esc(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/\{/gu, "\\{").replace(/\}/gu, "\\}");
}

const attr = designAttr;

/** The largest size, in pixels, of each step of the text, heading and space scales of a design. */
function designScales(design: HistosDesign): Scales {
  const scales: Scales = { text: [], heading: [], space: [] };
  for (const [name, value] of Object.entries(computeHistosTokens(design))) {
    const group = /^xb-text-(?:xs|s|m|l|xl|[234]xl)$/u.test(name) ? scales.text : /^xb-h[1-6]$/u.test(name) ? scales.heading : /^xb-space-(?:[23]?xs|s|m|l|xl|[234]xl)$/u.test(name) ? scales.space : null;
    const size = /(\d+\.?\d*)rem\s*\)?$/u.exec(String(value));
    if (group && size) group.push([name, round(Number(size[1]) * ROOT_PX, 1)]);
  }
  return scales;
}

/** The step nearest to a size. */
function nearestStep(steps: Steps, px: number): [string, number] {
  return steps.reduce((best, step) => (Math.abs(step[1] - px) < Math.abs(best[1] - px) ? step : best), steps[0] ?? ["xb-text-m", 16]);
}

/** A gap or a padding: the space token when one is within 12% of it, a length in rem otherwise. */
function spaceCss(ctx: Ctx, px: number): string {
  if (px < 0.5) return "0";
  const [name, size] = nearestStep(ctx.scales.space, px);
  if (px >= 3 && Math.abs(size - px) / px <= 0.12) {
    ctx.report.spaces.token += 1;
    return `var(--${name})`;
  }
  ctx.report.spaces.fixed += 1;
  return rem(px);
}

/** A colour: the token of the design that has it, or the colour itself. */
function colorCss(ctx: Ctx, color: DesignColor): string {
  const css = designColorCss(color);
  if (!ctx.colors.size || color.alpha < 0.999) return css;
  let canon = ctx.canon.get(css);
  if (canon === undefined) {
    // The parameters keep a colour in their own notation: the same reading gives the same text.
    try {
      canon = String(validateHistosDesign({ primary: css }).primary);
    } catch {
      canon = "";
    }
    ctx.canon.set(css, canon);
  }
  return ctx.colors.get(canon) ?? css;
}

/** Groups the children whose spans along one axis overlap, in the order of that axis; children that only touch are apart. */
function bands(children: readonly DesignNode[], axis: "x" | "y"): DesignNode[][] {
  const size = axis === "x" ? "width" : "height";
  const sorted = [...children].sort((a, b) => a.box[axis] - b.box[axis]);
  const groups: DesignNode[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const child of sorted) {
    // Boxes drawn a few pixels one over the other (two borders that share a line) are still one after the other.
    if (!groups.length || child.box[axis] >= end - Math.max(1, Math.min(8, child.box[size] * 0.1))) groups.push([child]);
    else groups.at(-1)!.push(child);
    end = Math.max(end, child.box[axis] + child.box[size]);
  }
  // Inside a group the layers keep their order from the bottom to the top.
  return groups.map((group) => children.filter((child) => group.includes(child)));
}

/** A child that covers its whole frame from below is the background of the frame: its paints, border, corners and shadows move to the frame. */
function mergeBackground(node: DesignNode, ctx: Ctx): void {
  for (let pass = 0; pass < 3; pass += 1) {
    const flow = node.children.filter((child) => !child.absolute);
    // With a layout: a layer out of the flow, or the only layer in the flow when the content is laid over it (a picture with the words on it).
    const candidates = node.layout ? [...node.children.filter((child) => child.absolute), ...(flow.length === 1 && node.children.length > 1 ? flow : [])] : node.children.slice(0, 1);
    const back = candidates.find((child) => (child.kind === "shape" || child.kind === "image") && child.opacity >= 0.999 && child.box.x <= 1 && child.box.y <= 1 && child.box.width >= node.box.width - 2 && child.box.height >= node.box.height - 2);
    if (!back || (!node.layout && node.children.length < 2)) break;
    node.fills = [...back.fills, ...node.fills];
    node.stroke ??= back.stroke;
    if (node.radii.every((radius) => radius === 0)) node.radii = back.radii;
    node.shadows.push(...back.shadows);
    if (back.round) node.round = true;
    // A frame that took its size from the layer that is now its background keeps that size.
    if (node.layout && !back.absolute) {
      node.sizing = { horizontal: node.sizing.horizontal === "hug" ? "fixed" : node.sizing.horizontal, vertical: node.sizing.vertical === "hug" ? "fixed" : node.sizing.vertical };
      ctx.drawn.add(node);
    }
    node.children = node.children.filter((child) => child !== back);
  }
  // Nothing is left in the flow: the layers placed by hand are the content, and their layout is read from their boxes.
  if (node.layout && node.children.length && node.children.every((child) => child.absolute)) {
    node.layout = null;
    for (const child of node.children) child.absolute = false;
  }
}

/** True for a small frame made only of drawings: it is written as one icon. */
function iconLike(node: DesignNode): boolean {
  if (node.kind !== "frame" || node.fills.some((paint) => paint.kind === "image")) return false;
  let vectors = 0;
  let others = 0;
  let boxes = 0;
  let count = 0;
  walkDesign(node, (item) => {
    count += 1;
    if (item.kind === "vector" && item.paths.length) vectors += 1;
    else if (item.kind === "text" || item.kind === "image" || item.fills.some((paint) => paint.kind !== "solid")) others += 1;
    else if (item.kind !== "frame" || item.fills.length || item.stroke || item.shadows.length || item.layout) boxes += 1;
  });
  // A small frame may have plain boxes among its drawings (the disc under a glyph); a large one is a drawing only when it holds nothing else (a wordmark).
  const small = node.box.width <= ICON_MAX && node.box.height <= ICON_MAX;
  return vectors > 0 && others === 0 && count <= 300 && (small || boxes === 0);
}

/** Moves every pair of numbers of a path by an offset. The path has only absolute commands with pairs (M, L, C, Q) and Z. */
function shiftPath(d: string, dx: number, dy: number): string {
  if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return d;
  let index = 0;
  return d.replace(/-?\d+(?:\.\d+)?(?:e-?\d+)?/giu, (number) => String(round(Number(number) + (index++ % 2 === 0 ? dx : dy))));
}

/** The outline of a rectangle or an ellipse as a path, in the coordinates of its parent. */
function shapePath(node: DesignNode): string {
  const { x, y, width: w, height: h } = node.box;
  if (!node.round) return `M${round(x)} ${round(y)}L${round(x + w)} ${round(y)}L${round(x + w)} ${round(y + h)}L${round(x)} ${round(y + h)}Z`;
  // Four cubic curves: the usual constant for a quarter of a circle.
  const k = 0.5523;
  const [rx, ry, cx, cy] = [w / 2, h / 2, x + w / 2, y + h / 2];
  const p = (px: number, py: number) => `${round(px)} ${round(py)}`;
  return `M${p(cx, y)}C${p(cx + k * rx, y)} ${p(x + w, cy - k * ry)} ${p(x + w, cy)}C${p(x + w, cy + k * ry)} ${p(cx + k * rx, y + h)} ${p(cx, y + h)}C${p(cx - k * rx, y + h)} ${p(x, cy + k * ry)} ${p(x, cy)}C${p(x, cy - k * ry)} ${p(cx - k * rx, y)} ${p(cx, y)}Z`;
}

/** Turns a frame of drawings into one vector: every path under it, in the coordinates of the frame. */
function collapseIcon(node: DesignNode): void {
  const paths: DesignPath[] = [];
  const gather = (item: DesignNode, dx: number, dy: number) => {
    for (const child of item.children) {
      if (child.kind === "vector") paths.push(...child.paths.map((path) => ({ ...path, d: shiftPath(path.d, dx + child.box.x, dy + child.box.y) })));
      else {
        const fill = child.fills.find((paint) => paint.kind === "solid");
        if (fill?.kind === "solid" || child.stroke) paths.push({ d: shiftPath(shapePath(child), dx, dy), fill: fill?.kind === "solid" ? fill.color : null, stroke: child.stroke?.color ?? null, strokeWidth: child.stroke?.width ?? 0, evenOdd: false });
        gather(child, dx + child.box.x, dy + child.box.y);
      }
    }
  };
  gather(node, 0, 0);
  node.kind = "vector";
  node.paths = paths;
  node.children = [];
  node.layout = null;
}

/**
 * Gives a layout to a frame that has none, from the boxes of its children: rows when their heights do not overlap,
 * otherwise columns, each group of several children in a frame of its own. Children that overlap both ways stay as
 * they are: the frame is written as one cell of a grid.
 */
function inferLayout(node: DesignNode, ctx: Ctx): void {
  const kids = node.children;
  if (!kids.length) return;
  const rows = bands(kids, "y");
  const columns = rows.length > 1 ? [] : bands(kids, "x");
  const mode = rows.length > 1 || kids.length === 1 ? "column" : columns.length > 1 ? "row" : null;
  if (!mode) {
    // A frame at the bottom that covers the others is their backdrop: the others are read without it, and lie over it.
    const [back, ...rest] = kids;
    if (back && rest.length >= 2 && back.kind === "frame" && back.box.x <= 2 && back.box.y <= 2 && back.box.width >= node.box.width * 0.9 && back.box.height >= node.box.height * 0.5 && (bands(rest, "y").length > 1 || bands(rest, "x").length > 1)) {
      const inner = designNode({ id: `${node.id}~contenuto`, name: "", kind: "frame", box: { x: 0, y: 0, width: node.box.width, height: node.box.height }, sizing: { horizontal: "fill", vertical: "hug" }, children: rest });
      node.children = [back, inner];
      inferLayout(inner, ctx);
    }
    if (node.name) ctx.report.stacked.push(node.name);
    return;
  }
  const groups = mode === "column" ? rows : columns;
  const items = groups.map((group, index) => {
    if (group.length === 1) return group[0]!;
    const x = Math.min(...group.map((child) => child.box.x));
    const y = Math.min(...group.map((child) => child.box.y));
    const box = { x, y, width: Math.max(...group.map((child) => child.box.x + child.box.width)) - x, height: Math.max(...group.map((child) => child.box.y + child.box.height)) - y };
    for (const child of group) child.box = { ...child.box, x: child.box.x - x, y: child.box.y - y };
    return designNode({ id: `${node.id}~${index}`, name: "", kind: "frame", box, sizing: { horizontal: "hug", vertical: "hug" }, children: group });
  });
  const [main, size, cross, crossSize] = mode === "column" ? (["y", "height", "x", "width"] as const) : (["x", "width", "y", "height"] as const);
  const first = items[0]!;
  const last = items.at(-1)!;
  let start = Math.max(0, first.box[main]);
  let end = Math.max(0, node.box[size] - last.box[main] - last.box[size]);
  let before = Math.max(0, Math.min(...items.map((item) => item.box[cross])));
  let after = Math.max(0, Math.min(...items.map((item) => node.box[crossSize] - item.box[cross] - item.box[crossSize])));
  const gaps = items.slice(1).map((item, index) => Math.max(0, item.box[main] - items[index]!.box[main] - items[index]!.box[size])).sort((a, b) => a - b);
  let gap = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0;
  let justify: DesignLayout["justify"] = "start";
  // Two margins are the same when they differ by less than 2% of the width: nobody centres by eye to the pixel.
  const near = Math.max(2, node.box.width * 0.02);
  const middle = items.length === 3 ? items[1]!.box.x + items[1]!.box.width / 2 : Number.NaN;
  if (mode === "row" && gaps.length && gaps[0]! >= 96 && (gaps.at(-1)! - gaps[0]! <= 4 || (Math.abs(start - end) <= near && Math.abs(middle - node.box.width / 2) <= near))) {
    // Groups far apart, at even distances, or three with the one in the middle at the centre: the pieces of a bar, not a gap.
    justify = "between";
    gap = 24;
    ctx.report.spread += 1;
    if (!node.name) node.sizing.horizontal = "fill";
  } else if (mode === "row" && start > 40 && Math.abs(start - end) <= near) {
    justify = "center";
    start = end = 0;
  } else if (mode === "row" && end > start + near) end = start;
  // Equal margins on the two sides are a centred content, not a padding: the content keeps its width.
  let align: DesignAlign = "start";
  if (mode === "column" && before > 40 && Math.abs(before - after) <= near) {
    align = "center";
    before = after = 0;
  } else if (mode === "column" && after > before + near) after = before;
  // The room left after the content of a box with its own width is not a padding: the box keeps its width.
  const padding: DesignLayout["padding"] = mode === "column" ? [round(start), round(after), round(end), round(before)] : [round(before), round(end), round(after), round(start)];
  const layout: DesignLayout = { mode, gap: round(gap), crossGap: 0, padding, justify, align, wrap: false, columns: 0 };
  // Three or more things in a row at uneven distances are placed, not spaced (the cells of a table drawn by hand): each keeps its share of the width, so the rows of one table stay in line.
  if (mode === "row" && justify === "start" && items.length >= 3 && gaps.at(-1)! - gaps[0]! > 16) {
    layout.mode = "grid";
    layout.columns = items.length;
    layout.gap = 0;
    // The last cell may grow to the right, up to a margin like the one on the left: its text must not touch the edge.
    const right = Math.min(Math.max(0, first.box.x), end);
    layout.padding = [round(before), round(right), round(after), round(Math.max(0, first.box.x))];
    layout.tracks = items.map((item, index) => round(Math.max(1, (items[index + 1]?.box.x ?? node.box.width - right) - item.box.x), 1));
  }
  // The place most children have across the direction is the place of the layout; the others keep their own.
  // By hand nobody centres to the pixel: the same tolerance as for the margins.
  const places = items.map((item) => crossPlace({ ...layout, align: "start" }, node.box, item, near) ?? "start");
  if (align === "start") {
    for (const candidate of ["center", "end"] as const) if (places.filter((place) => place === candidate).length > items.length / 2) layout.align = candidate;
  }
  for (const item of items) item.alignSelf = crossPlace(layout, node.box, item, near);
  node.layout = layout;
  node.children = items;
  ctx.inferred.add(node);
  if (node.name) ctx.report.inferred.push(node.name);
}

/**
 * Prepares the tree for writing, from the top: icons become one vector, backgrounds move to their frame, frames
 * without a layout get one, layers out of the flow share one cell with the rest of their frame, rows wider than the
 * page become strips. `pageX` is where the node starts on the page; `inStrip` is true under a strip.
 */
function prepare(node: DesignNode, ctx: Ctx, top: boolean, pageX = 0, inStrip = false): void {
  if (node.kind !== "frame") return;
  if (!top && iconLike(node)) {
    collapseIcon(node);
    return;
  }
  mergeBackground(node, ctx);
  if (!node.layout) inferLayout(node, ctx);
  else {
    const out = node.children.filter((child) => child.absolute);
    const flow = node.children.filter((child) => !child.absolute);
    for (const child of out) ctx.report.absolute.push(child.name || node.name || "livello");
    if (out.length && top) {
      // The frame of the page is written section by section: a layer laid over them has no place.
      for (const child of out) ctx.report.unsupported.push({ layer: child.name || "livello", what: "livello fuori flusso sul riquadro di pagina: non scritto" });
    } else if (out.length) {
      // The layout and what it places go to a frame of their own; the frame keeps one cell where that frame and the layers out of the flow lie one over the other, in the order of the design.
      const first = node.children.findIndex((child) => !child.absolute);
      const under = first < 0 ? [] : node.children.slice(0, first);
      const inner = designNode({ id: `${node.id}~flusso`, name: "", kind: "frame", box: { x: 0, y: 0, width: node.box.width, height: node.box.height }, layout: node.layout, sizing: { ...node.sizing }, children: flow });
      for (const child of out) child.absolute = false;
      node.layout = null;
      node.children = [...under, ...(flow.length ? [inner] : []), ...out.filter((child) => !under.includes(child))];
    } else {
      const layout = node.layout;
      const row = layout.mode === "row" && layout.justify === "start" && !layout.wrap;
      const used = flow.reduce((sum, child) => sum + child.box.width, 0) + layout.gap * (flow.length - 1) + layout.padding[1] + layout.padding[3];
      if (row && layout.gap >= 96 && flow.length === 2) {
        // A wide gap in a row that hugs its two children is how a design tool writes «one at each end».
        node.layout = { ...layout, justify: "between", gap: 24 };
        if (node.sizing.horizontal === "hug") node.sizing = { ...node.sizing, horizontal: "fill" };
        ctx.report.spread += 1;
      } else if (row && layout.gap >= 64 && flow.length >= 3 && node.sizing.horizontal !== "hug" && Math.abs(used - node.box.width) <= 2) {
        // Children and gaps fill the width to the pixel: the gap was measured, not chosen. With another font the row would break.
        node.layout = { ...layout, justify: "between", gap: 24 };
        ctx.report.spread += 1;
      }
    }
  }
  // A row that goes out of the page, or whose children go out of it, is a strip the reader scrolls sideways.
  const layout = node.layout;
  if (layout && layout.mode === "row" && !layout.wrap && !inStrip && !top) {
    const flow = node.children.filter((child) => !child.absolute);
    const pageWidth = ctx.page.root.box.width;
    const right = Math.max(0, ...flow.map((child) => child.box.x + child.box.width));
    if (flow.length >= 2 && pageX < pageWidth && (pageX + node.box.width > pageWidth + 8 || right > node.box.width + 8)) {
      ctx.strips.add(node);
      ctx.report.strips.push(node.name || "riga");
      if (layout.justify !== "start") node.layout = { ...layout, justify: "start" };
    }
  }
  const strip = inStrip || ctx.strips.has(node);
  // In a column, what goes out of the page on the right ends at the edge of the page: it starts where the design puts it and takes the room that is left.
  if (layout && layout.mode === "column" && !strip) {
    const pageWidth = ctx.page.root.box.width;
    for (const child of node.children) {
      const x = pageX + child.box.x;
      if (child.absolute || child.kind !== "frame" || x < 0 || x >= pageWidth || x + child.box.width <= pageWidth + 8) continue;
      child.box = { ...child.box, width: round(pageWidth - x) };
      child.sizing = { ...child.sizing, horizontal: "fill" };
      child.alignSelf = null;
      ctx.bleed.set(child, Math.max(0, child.box.x - layout.padding[3]));
    }
  }
  for (const child of node.children) prepare(child, ctx, false, pageX + child.box.x, strip);
}

/** The piece of a text with the most characters: its style is the style of the text. */
function dominantRun(node: DesignNode): DesignRun | null {
  const runs = node.text?.paragraphs.flat() ?? [];
  return runs.length ? runs.reduce((best, run) => (run.text.length > best.text.length ? run : best)) : null;
}

/**
 * Chooses the headings among the texts, in the order of the page. The largest text of the content is the only h1;
 * a text much larger than the running text, or one the designer named `h2`…`h6`, is a heading whose level follows
 * its size; no level is skipped. Also finds the family of the running text and that of the headings.
 */
function planHeadings(content: readonly DesignNode[], after: readonly DesignNode[], ctx: Ctx): number {
  const texts: Array<{ node: DesignNode; run: DesignRun; chars: number; main: boolean }> = [];
  const collect = (roots: readonly DesignNode[], main: boolean) => {
    for (const root of roots) {
      walkDesign(root, (node) => {
        const run = node.kind === "text" ? dominantRun(node) : null;
        if (run) texts.push({ node, run, chars: node.text!.paragraphs.flat().reduce((sum, piece) => sum + piece.text.length, 0), main });
      });
    }
  };
  collect(content, true);
  collect(after, false);
  if (!texts.length) return 0;
  const weigh = (key: (item: (typeof texts)[number]) => string, items = texts) => {
    const total = new Map<string, number>();
    for (const item of items) total.set(key(item), (total.get(key(item)) ?? 0) + item.chars);
    return [...total].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  const bodySize = Number(weigh((item) => String(item.run.sizePx))) || 16;
  const named = (item: (typeof texts)[number]) => /^h([1-6])$/iu.exec(item.node.name.trim())?.[1] ?? /^h([1-6])$/iu.exec(item.node.tag)?.[1];
  // A kit may call `h6` a label as small as the running text: a name is a heading only on a text that is larger.
  const candidates = texts.filter((item) => item.chars <= 160 && item.run.sizePx >= bodySize * (named(item) !== undefined ? 1.1 : 1.25));
  const top = candidates.filter((item) => item.main).reduce<(typeof texts)[number] | null>((best, item) => (!best || item.run.sizePx > best.run.sizePx ? item : best), null) ?? texts.filter((item) => item.main).reduce<(typeof texts)[number] | null>((best, item) => (!best || item.run.sizePx > best.run.sizePx ? item : best), null);
  if (!top) return bodySize;
  const sizes = [...new Set(candidates.filter((item) => item !== top).map((item) => item.run.sizePx))].sort((a, b) => b - a);
  let reached = false;
  let previous = 1;
  for (const item of texts) {
    if (item === top) {
      ctx.headings.set(item.node, 1);
      reached = true;
      previous = 1;
      continue;
    }
    // A heading before the h1 would open the page at a lower level: it stays a text.
    if (!reached || !candidates.includes(item)) continue;
    const wanted = Math.max(2, Number(named(item) ?? 0) || 2 + sizes.indexOf(item.run.sizePx));
    const level = Math.min(6, wanted, previous + 1);
    ctx.headings.set(item.node, level);
    previous = level;
  }
  ctx.report.headings = ctx.headings.size;
  ctx.bodyFamily = weigh((item) => item.run.family, texts.filter((item) => !ctx.headings.has(item.node)));
  ctx.headingFamily = weigh((item) => item.run.family, texts.filter((item) => ctx.headings.has(item.node))) || ctx.bodyFamily;
  ctx.report.fonts = [...new Set(texts.map((item) => item.run.family).filter(Boolean))].sort();
  return bodySize;
}

/** True for a narrow frame whose texts are all one line (a button, a field, a chip): with another font its text must not break. */
function labelLike(node: DesignNode): boolean {
  if (node.kind !== "frame" || node.box.width > 240) return false;
  let texts = 0;
  let other = false;
  walkDesign(node, (item) => {
    if (item.kind === "image") other = true;
    if (item.kind !== "text" || !item.text) return;
    texts += 1;
    const run = dominantRun(item);
    if (!run || item.text.paragraphs.length !== 1 || /\n/u.test(item.text.paragraphs[0]!.map((piece) => piece.text).join("")) || item.box.height > run.sizePx * (run.lineHeight ?? 1.3) * 1.5) other = true;
  });
  return texts > 0 && !other;
}

/** The declarations of what a box looks like: background, border, corners, shadows, opacity, clipping. */
function boxCss(node: DesignNode, ctx: Ctx, css: string[], background = true): void {
  if (background && node.fills.length) {
    const layers = node.fills.map((paint, index) => {
      if (paint.kind === "solid") return index === node.fills.length - 1 ? colorCss(ctx, paint.color) : `linear-gradient(${colorCss(ctx, paint.color)}, ${colorCss(ctx, paint.color)})`;
      if (paint.kind === "linear") return `linear-gradient(${paint.angle}deg, ${paint.stops.map((stop) => `${colorCss(ctx, stop.color)} ${round(stop.offset * 100, 1)}%`).join(", ")})`;
      const asset = paint.kind === "image" ? assetFor(ctx, paint.image, "") : null;
      return asset ? `url("asset:${asset.name}") center / cover no-repeat` : "var(--xb-surface)";
    });
    css.push(`background: ${layers.join(", ")}`);
  }
  if (node.stroke?.sides) css.push(`border-style: ${node.stroke.dashed ? "dashed" : "solid"}`, `border-color: ${colorCss(ctx, node.stroke.color)}`, `border-width: ${node.stroke.sides.map((side) => (side > 0 ? rem(side) : "0")).join(" ")}`);
  else if (node.stroke) css.push(`border: ${rem(node.stroke.width)} ${node.stroke.dashed ? "dashed" : "solid"} ${colorCss(ctx, node.stroke.color)}`);
  const [a, b, c, d] = node.radii;
  const full = Math.min(node.box.width, node.box.height) / 2;
  if (node.round) css.push("border-radius: 50%");
  else if (a > 0 || b > 0 || c > 0 || d > 0) {
    const one = (radius: number) => (full > 0 && radius >= full - 0.5 ? "var(--xb-radius-full)" : rem(radius));
    css.push(`border-radius: ${a === b && b === c && c === d ? one(a) : [a, b, c, d].map(one).join(" ")}`);
  }
  if (node.shadows.length) css.push(`box-shadow: ${node.shadows.map((shadow) => `${shadow.inset ? "inset " : ""}${rem(shadow.x)} ${rem(shadow.y)} ${rem(shadow.blur)} ${rem(shadow.spread)} ${colorCss(ctx, shadow.color)}`).join(", ")}`);
  if (node.opacity < 0.999) css.push(`opacity: ${round(node.opacity)}`);
  if (node.clip && (node.radii.some((radius) => radius > 0) || node.round)) css.push("overflow: hidden");
}

/** The asset of a picture of the design, made the first time it is asked; null when a placeholder takes its place. */
function assetFor(ctx: Ctx, key: string, alt: string): { name: string; data: string; alt: string; width: number; height: number } | null {
  const known = ctx.assets.get(key);
  if (known !== undefined) {
    if (known && !known.alt && alt) known.alt = alt;
    return known;
  }
  const image = ctx.page.images.get(key);
  const type = image && image.bytes.length ? designImageType(image.bytes) : null;
  const why = !image || !image.bytes.length ? "il file non è nel design" : !type ? "formato non ammesso (servono PNG, JPEG, GIF o WebP)" : image.bytes.length > ASSET_MAX ? "più di 15 MB" : ctx.assetBytes + image.bytes.length > ASSETS_TOTAL_MAX ? "il prototipo supererebbe 32 MB" : [...ctx.assets.values()].filter(Boolean).length >= ASSETS_COUNT_MAX ? "più di 500 media" : "";
  if (why || !image || !type) {
    ctx.report.imagesMissing.push(`${alt || "immagine"}: ${why}`);
    ctx.assets.set(key, null);
    return null;
  }
  ctx.assetBytes += image.bytes.length;
  const asset = { name: `img-${[...ctx.assets.values()].filter(Boolean).length + 1}`, data: `data:${type.mime};base64,${Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString("base64")}`, alt, width: type.width || Math.round(image.width), height: type.height || Math.round(image.height) };
  ctx.assets.set(key, asset);
  ctx.report.images += 1;
  return asset;
}

const PAGE_CAP = "calc(100% - 2 * var(--xb-gutter))";

/** The largest width of a node in a column: all the room, less a gutter at each side when the column is as wide as the page and the node is narrower (on a narrower screen it would touch the two edges). */
function pageCap(node: DesignNode, place: Place, ctx: Ctx): string {
  return place.mode === "column" && !place.gutter && place.width >= ctx.page.root.box.width * 0.99 && node.box.width < place.width - 32 ? PAGE_CAP : "100%";
}

const ALIGN_CSS: Record<DesignAlign, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };

/** The declarations of the width of a node in its place, and of its own place across the direction of the parent. */
function sizeCss(node: DesignNode, place: Place, ctx: Ctx, css: string[], narrow: string[] = []): void {
  const width = node.box.width;
  const spans = place.width > 0 && width >= place.width * 0.99;
  const { horizontal, vertical } = node.sizing;
  const cap = pageCap(node, place, ctx);
  const fixed = () => {
    // The width, and never more than the room: `min(100%, …)` alone is lost inside a parent that takes its width from its children.
    if (node.kind === "text" && place.mode !== "row") css.push(`max-inline-size: ${rem(width)}`);
    else if (labelLike(node)) css.push("inline-size: fit-content", `min-inline-size: ${rem(width)}`);
    else css.push(`inline-size: ${rem(width)}`, `max-inline-size: ${cap}`);
    ctx.report.fixedWidths += 1;
  };
  let self = node.alignSelf;
  if (place.mode === "row") {
    if (horizontal === "fill") css.push("flex: 1 1 0", "min-inline-size: 0");
    else if (horizontal === "fixed" && width > 0) fixed();
  } else if (place.mode === "column") {
    // What is as wide as its parent follows the parent, whatever the design says of its width; not when the parent takes its width from it.
    if (horizontal === "fill" || (spans && !(place.hugs && horizontal === "fixed"))) self = place.align === "stretch" ? null : "stretch";
    else if (horizontal === "fixed" && width > 0) fixed();
    if (vertical === "fill") css.push("flex: 1 1 auto");
    const bleed = ctx.bleed.get(node) ?? 0;
    if (bleed >= 0.5) {
      css.push(`margin-inline-start: ${rem(bleed)}`);
      if (bleed > 40) narrow.push("margin-inline-start: var(--xb-gutter)");
    }
  } else if (place.mode === "stack") {
    const cap = stackCss(node, place, css);
    if (horizontal === "fixed" && !spans && width > 0) {
      css.push(...(node.kind === "text" ? [`max-inline-size: min(${rem(width)}, ${cap})`] : [`inline-size: ${rem(width)}`, `max-inline-size: ${cap}`]));
      ctx.report.fixedWidths += 1;
    } else if (cap !== "100%") css.push(`max-inline-size: ${cap}`);
    self = null;
  }
  if (self && (place.mode === "row" || place.mode === "column")) {
    css.push(`align-self: ${ALIGN_CSS[self]}`);
    if (place.collapses) narrow.push("align-self: auto");
  }
}

/**
 * The place of a child in the one cell it shares with the others: start, centre or end on each axis, with the
 * distance from the nearer edge as a margin (a share of the width at the sides, so that it shrinks with the screen).
 * Returns the largest width the child can take beside its margins, as CSS: `100%` when it has none.
 */
function stackCss(node: DesignNode, place: Place, css: string[]): string {
  css.push("grid-area: 1 / 1");
  // A layer with an opacity is painted over the plain ones that follow it: each layer is its own, in the order of the design.
  if (place.layers) css.push("isolation: isolate");
  let cap = "100%";
  const content = node.kind === "frame" || node.kind === "text";
  const axis = (offset: number, size: number, room: number, self: string, margin: string, inline: boolean) => {
    const far = room - offset - size;
    const distance = (value: number) => {
      if (!inline || room <= 0) return rem(value);
      const share = Math.min(90, round((value / room) * 100, 1));
      cap = `${round(100 - share, 1)}%`;
      return `${share}%`;
    };
    if (room > 0 && size >= room * 0.99) css.push(`${self}: stretch`);
    else if (Math.abs(offset - far) <= 2) {
      css.push(`${self}: center`);
      // Centred in a wide cell: on a narrow screen it would touch the two edges.
      if (inline && room >= 480 && node.kind !== "shape") {
        css.push("margin-inline: var(--xb-gutter)");
        cap = "calc(100% - 2 * var(--xb-gutter))";
      }
      // Heights are never fixed: the distance from the top keeps the layer under what lies over the top of the cell.
      if (!inline && offset > 2 && content) css.push(`margin-block: ${rem(offset)}`);
    } else if (offset <= far) css.push(`${self}: start`, ...(offset > 2 ? [`${margin}-start: ${distance(offset)}`] : []));
    else css.push(`${self}: end`, ...(far > 2 ? [`${margin}-end: ${distance(far)}`] : []), ...(!inline && offset > 2 && content ? [`margin-block-start: ${rem(offset)}`] : []));
  };
  axis(node.box.x, node.box.width, place.width, "justify-self", "margin-inline", true);
  axis(node.box.y, node.box.height, place.height, "align-self", "margin-block", false);
  return cap;
}

/** A text as an element: a heading, a paragraph, a link, or a span inside a link. */
function textOut(node: DesignNode, place: Place, ctx: Ctx): Out | null {
  const run = dominantRun(node);
  if (!run || !node.text) return null;
  const level = ctx.headings.get(node);
  const linked = node.text.paragraphs.flat().every((piece) => piece.link !== "");
  const link = !place.inLink && !level && (LINK_NAME.test(node.name.trim()) || linked);
  const paragraphs = node.text.paragraphs;
  const tag = place.inLink ? "span" : level ? `h${level}` : link ? "a" : paragraphs.length > 1 ? "div" : "p";
  let mixed = false;
  const safe = (address: string) => (/^(?:https?:\/\/|mailto:|tel:)[^\s"<>{}]+$/iu.test(address) ? address : "#");
  const inline = (pieces: readonly DesignRun[]) => pieces.map((piece) => {
    let html = esc(piece.text).replace(/\r?\n/gu, "<br/>");
    if (piece === run) return html;
    if (piece.weight >= run.weight + 200) html = `<strong>${html}</strong>`;
    if (piece.italic && !run.italic) html = `<em>${html}</em>`;
    if (piece.link && tag !== "a" && !place.inLink) html = `<a href="${attr(safe(piece.link))}">${html}</a>`;
    else if (piece.underline && !run.underline) html = `<u>${html}</u>`;
    if (piece.sizePx !== run.sizePx || (piece.color && run.color && designColorCss(piece.color) !== designColorCss(run.color))) mixed = true;
    return html;
  }).join("");
  const raw = tag === "div" ? paragraphs.map((pieces) => `<p>${inline(pieces)}</p>`).join("") : paragraphs.map(inline).join("<br/>");
  if (mixed) ctx.report.mixedText += 1;
  // Never a length: the nearest step. A heading may take a step of the text scale when that one is nearer.
  const own = nearestStep(level ? ctx.scales.heading : ctx.scales.text, run.sizePx);
  const other = nearestStep(level ? ctx.scales.text : ctx.scales.heading, run.sizePx);
  const [step, stepPx] = Math.abs(other[1] - run.sizePx) < Math.abs(own[1] - run.sizePx) && (level !== undefined || Math.abs(own[1] - run.sizePx) / run.sizePx > 0.15) ? other : own;
  const seen = ctx.textSizes.get(`${run.sizePx}|${step}`);
  if (seen) seen.count += 1;
  else ctx.textSizes.set(`${run.sizePx}|${step}`, { px: run.sizePx, step, stepPx, count: 1 });
  const css = [`font-size: var(--${step})`, `font-weight: ${run.weight}`];
  if (run.family && run.family !== ctx.bodyFamily) css.unshift(`font-family: ${run.family === ctx.headingFamily ? "var(--xb-font-heading)" : `"${run.family.replace(/["\\;{}<>]/gu, "")}", sans-serif`}`);
  if (run.italic) css.push("font-style: italic");
  // Always said, as the padding of a section is: an automatic leading is `normal`, whatever the framework gives its texts.
  css.push(`line-height: ${run.lineHeight ? round(run.lineHeight) : "normal"}`);
  if (Math.abs(run.letterSpacingPx) >= 0.1 && run.sizePx > 0) css.push(`letter-spacing: ${round(run.letterSpacingPx / run.sizePx, 3)}em`);
  if (node.text.align !== "left") css.push(`text-align: ${node.text.align}`);
  if (run.transform) css.push(`text-transform: ${run.transform}`);
  if (run.underline) css.push("text-decoration: underline");
  if (run.color) css.push(`color: ${colorCss(ctx, run.color)}`);
  if (node.opacity < 0.999) css.push(`opacity: ${round(node.opacity)}`);
  if (place.label) css.push("white-space: nowrap");
  const narrow: string[] = [];
  sizeCss(node, place, ctx, css, narrow);
  const attrs: Out["attrs"] = [];
  if (tag === "a") {
    const address = safe(node.text.paragraphs.flat()[0]?.link ?? "");
    attrs.push(["href", address]);
    if (address === "#") ctx.report.links += 1;
  }
  const named = !genericLayerName(node.name) && !TAG_NAME.test(node.name.trim()) ? designSlug(node.name) : "";
  // Only words, with nothing the template language reads: a component can take them as a prop.
  const words = paragraphs.flat().map((piece) => piece.text).join("");
  return { tag, base: named || (level ? "titolo" : tag === "a" ? "link" : "testo"), attrs, css, narrow, children: [], raw, cls: "", ...(!raw.includes("<") && !/[{}\r\n\\]/u.test(words) ? { text: words } : {}) };
}

/** A drawing as an inline SVG, or as a rule when it is one straight thin line. */
function vectorOut(node: DesignNode, place: Place, ctx: Ctx): Out | null {
  if (!node.paths.length) return null;
  const { width, height } = node.box;
  const first = node.paths[0]!;
  if (node.paths.length === 1 && height <= 1.5 && width > 8 && first.stroke) return ruleOut(node, place, ctx, first.stroke, Math.max(1, first.strokeWidth));
  const paint = (name: string, color: DesignColor | null) => (color ? ` ${name}="${designColorCss({ ...color, alpha: 1 })}"${color.alpha < 0.999 ? ` ${name}-opacity="${round(color.alpha)}"` : ""}` : name === "fill" ? ' fill="none"' : "");
  const raw = node.paths.map((path) => `<path d="${path.d}"${paint("fill", path.fill)}${paint("stroke", path.stroke)}${path.stroke ? ` stroke-width="${round(path.strokeWidth)}"` : ""}${path.evenOdd ? ' fill-rule="evenodd"' : ""}/>`).join("");
  const [w, h] = [Math.max(1, round(width)), Math.max(1, round(height))];
  const css = [`inline-size: ${rem(w)}`, "block-size: auto"];
  if (place.mode === "row" || place.mode === "column") css.push("flex: none");
  if (place.mode === "stack") {
    const cap = stackCss(node, place, css);
    if (cap !== "100%") css.push(`max-inline-size: ${cap}`);
  } else if (node.alignSelf) css.push(`align-self: ${ALIGN_CSS[node.alignSelf]}`);
  boxCss(node, ctx, css);
  ctx.report.vectors += 1;
  return { tag: "svg", base: "icona", attrs: [["viewBox", `0 0 ${w} ${h}`], ["width", String(Math.round(w))], ["height", String(Math.round(h))], ["aria-hidden", "true"], ["focusable", "false"]], css, narrow: [], children: [], raw, cls: "" };
}

/** A thin horizontal line as `<hr>`. */
function ruleOut(node: DesignNode, place: Place, ctx: Ctx, color: DesignColor, thickness: number): Out {
  const css = ["border: 0", `border-block-start: ${rem(thickness)} solid ${colorCss(ctx, color)}`, "margin: 0"];
  if (place.mode === "stack") {
    const cap = stackCss(node, place, css);
    if (!css.includes("justify-self: stretch")) css.push(`inline-size: ${rem(node.box.width)}`, `max-inline-size: ${cap}`);
  } else if (place.width > 0 && node.box.width >= place.width * 0.99) css.push(place.mode === "row" ? "flex: 1 1 0" : "inline-size: 100%");
  else css.push(`inline-size: ${rem(node.box.width)}`, "max-inline-size: 100%");
  return { tag: "hr", base: "linea", attrs: [], css, narrow: [], children: [], raw: "", cls: "" };
}

/** A layer that only shows a picture as `<img>`, or as a placeholder when the picture cannot be an asset. */
function imageOut(node: DesignNode, place: Place, ctx: Ctx): Out {
  const paint = node.fills.find((item) => item.kind === "image");
  const name = genericLayerName(node.name) || /^[0-9a-f]{16,}$/iu.test(node.name.trim()) ? "" : node.name.trim();
  const asset = paint?.kind === "image" ? assetFor(ctx, paint.image, name) : null;
  const { width, height } = node.box;
  const css: string[] = [];
  const spans = place.width > 0 && width >= place.width * 0.99;
  if (place.mode === "stack") {
    const cap = stackCss(node, place, css);
    if (spans && height >= place.height * 0.99) css.push("inline-size: 100%", "block-size: 100%");
    else css.push(`inline-size: ${rem(width)}`, `max-inline-size: ${cap}`, "block-size: auto");
  } else if (place.mode === "row" && node.sizing.horizontal === "fill") css.push("flex: 1 1 0", "min-inline-size: 0", "block-size: auto");
  else if ((spans && !place.hugs) || node.sizing.horizontal === "fill") css.push("inline-size: 100%", "block-size: auto");
  else css.push(`inline-size: ${rem(width)}`, "max-inline-size: 100%", "block-size: auto");
  if (width > 0 && height > 0) css.push(`aspect-ratio: ${round(width)} / ${round(height)}`);
  if (node.alignSelf && (place.mode === "row" || place.mode === "column")) css.push(`align-self: ${ALIGN_CSS[node.alignSelf]}`);
  boxCss(node, ctx, css, false);
  if (!asset) return { tag: "div", base: "immagine", attrs: [], css: [...css, "background: var(--xb-surface)"], narrow: [], children: [], raw: "", cls: "" };
  css.push("object-fit: cover");
  return { tag: "img", base: designSlug(name) || "immagine", attrs: [["src", `asset:${asset.name}`], ["width", String(asset.width || Math.round(width))], ["height", String(asset.height || Math.round(height))], ["alt", name]], css, narrow: [], children: [], raw: "", cls: "" };
}

/** A rectangle or an ellipse as an empty box; a thin one as a rule; one that cannot be seen is not written. */
function shapeOut(node: DesignNode, place: Place, ctx: Ctx): Out | null {
  const fill = node.fills.find((paint) => paint.kind === "solid");
  if (!node.fills.length && !node.stroke && !node.shadows.length) return null;
  const { width, height } = node.box;
  const line = fill?.kind === "solid" ? fill.color : node.stroke?.color;
  if (height <= 2 && width > 8 && line) return ruleOut(node, place, ctx, line, Math.max(1, height));
  const css: string[] = [];
  boxCss(node, ctx, css);
  if (width <= 2 && line) css.push(`inline-size: ${rem(Math.max(1, width))}`, "align-self: stretch", "flex: none");
  else {
    sizeCss(node, place, ctx, css);
    if (css.some((line2) => line2.startsWith("max-inline-size:"))) css.push(`aspect-ratio: ${round(width)} / ${round(height)}`);
    else css.push(`block-size: ${rem(height)}`);
  }
  return { tag: "div", base: "forma", attrs: [], css, narrow: [], children: [], raw: "", cls: "" };
}

/** A frame as an element with its layout, its look and its children. `tag` is given for the root of a block. */
function frameOut(node: DesignNode, place: Place, ctx: Ctx, tag = ""): Out {
  const css: string[] = [];
  const narrow: string[] = [];
  const layout = node.layout;
  const pad = layout?.padding ?? [0, 0, 0, 0];
  const flow = node.children.filter((child) => child.kind !== "shape" || child.fills.length || child.stroke || child.shadows.length);
  const strip = ctx.strips.has(node);
  if (layout?.mode === "grid") {
    css.push("display: grid", `grid-template-columns: ${layout.tracks ? layout.tracks.map((share) => `minmax(0, ${share}fr)`).join(" ") : `repeat(${layout.columns}, minmax(0, 1fr))`}`);
    if (layout.tracks) css.push("justify-items: start", ...(layout.align !== "stretch" ? [`align-items: ${ALIGN_CSS[layout.align]}`] : []));
    if (layout.gap > 0 || layout.crossGap > 0) css.push(`gap: ${spaceCss(ctx, layout.crossGap)} ${spaceCss(ctx, layout.gap)}`);
    // A row of small things placed by hand (the cells of a table) stays a row on a narrow screen.
    if (layout.columns > 1 && (!layout.tracks || flow.some((child) => child.box.width >= 280))) narrow.push("grid-template-columns: 1fr");
  } else if (layout) {
    css.push("display: flex");
    if (layout.mode === "column") css.push("flex-direction: column");
    const wide = !strip && layout.mode === "row" && node.box.width > 480 && flow.filter((child) => child.box.width >= 120).length >= 2;
    if (!strip && (layout.wrap || (layout.mode === "row" && !wide && node.box.width > 320 && flow.length > 1))) css.push("flex-wrap: wrap");
    if (layout.justify !== "start") css.push(`justify-content: ${layout.justify === "end" ? "flex-end" : layout.justify === "center" ? "center" : `space-${layout.justify}`}`);
    if (layout.align !== "stretch") css.push(`align-items: ${ALIGN_CSS[layout.align]}`);
    if (layout.gap > 0 && flow.length > 1) css.push(layout.wrap && layout.crossGap > 0 ? `gap: ${spaceCss(ctx, layout.mode === "row" ? layout.crossGap : layout.gap)} ${spaceCss(ctx, layout.mode === "row" ? layout.gap : layout.crossGap)}` : `gap: ${spaceCss(ctx, layout.gap)}`);
    if (wide) narrow.push("flex-direction: column", "align-items: stretch");
  } else if (node.children.length) css.push("display: grid", "grid-template-columns: minmax(0, 1fr)");
  if (pad.some((value) => value >= 0.5)) {
    const [t, r, b, l] = pad.map((value) => spaceCss(ctx, value));
    css.push(`padding: ${t === r && r === b && b === l ? t : t === b && r === l ? `${t} ${r}` : `${t} ${r} ${b} ${l}`}`);
    if (pad[1] > 40 || pad[3] > 40) narrow.push("padding-inline: var(--xb-gutter)");
  }
  // A block whose content is narrower than the page and has no room at its sides in the design (it is centred there) gets the gutter: on a narrow screen the text would touch the edge.
  if (tag && layout && layout.mode !== "grid" && pad[1] < 0.5 && pad[3] < 0.5 && flow.length > 0) {
    const room = node.box.width - 32;
    if (layout.mode === "row" ? flow.reduce((sum, child) => sum + child.box.width, 0) < room : flow.every((child) => child.box.width < room)) css.push("padding-inline: var(--xb-gutter)");
  }
  // A height is never fixed; a box the design draws keeps at least the height it was drawn with.
  if ((!ctx.inferred.has(node) || (ctx.drawn.has(node) && node.box.height <= 480)) && node.sizing.vertical === "fixed" && node.box.height >= 24 && (node.fills.length > 0 || node.stroke !== null)) css.push(`min-block-size: ${rem(node.box.height)}`);
  boxCss(node, ctx, css);
  if (strip) css.push("overflow-x: auto");
  const button = !tag && !place.inLink && BUTTON_NAME.test(node.name) && flow.some((child) => child.kind === "text") && !hasLink(node);
  if (tag) {
    if (place.mode !== "flow") sizeCss(node, place, ctx, css, narrow);
  } else sizeCss(node, place, ctx, css, narrow);
  // A frame as wide as its content never grows past the room it has: a fixed width under it would push it out of a narrow screen.
  if (node.sizing.horizontal === "hug" && place.mode !== "flow" && !css.includes("align-self: stretch") && !css.some((line) => line.startsWith("max-inline-size:"))) css.push(`max-inline-size: ${pageCap(node, place, ctx)}`);
  const inner: Place = { mode: layout ? layout.mode : "stack", width: node.box.width - pad[1] - pad[3], height: node.box.height - pad[0] - pad[2], align: layout?.align ?? "start", inLink: place.inLink || button, hugs: node.sizing.horizontal === "hug" && place.mode !== "flow" && (place.hugs === true || !css.includes("align-self: stretch")), collapses: narrow.includes("flex-direction: column"), label: place.label === true || labelLike(node), strip, layers: !layout && node.children.length > 1, gutter: css.includes("padding-inline: var(--xb-gutter)") };
  const children: Out[] = [];
  for (const child of node.children) {
    const out = nodeOut(child, inner, ctx);
    if (!out) continue;
    if (strip) {
      // In a strip nothing grows or shrinks: each child keeps the width the design gave it.
      const grew = out.css.some((line) => line.startsWith("flex: 1"));
      out.css = out.css.filter((line) => !line.startsWith("flex:") && line !== "min-inline-size: 0");
      if (grew && child.box.width > 0) out.css.push(`inline-size: ${rem(child.box.width)}`, "max-inline-size: 100%");
      out.css.push("flex: none");
    }
    children.push(out);
  }
  const attrs: Out["attrs"] = [];
  // A strip must be reachable from the keyboard, and say what it is.
  if (strip) attrs.push(["tabindex", "0"], ["role", "group"], ["aria-label", genericLayerName(node.name) ? "Elenco a scorrimento" : node.name.trim()]);
  if (button) {
    attrs.push(["href", "#"]);
    ctx.report.links += 1;
    if (!css.some((line) => line.startsWith("display:"))) css.unshift("display: inline-flex");
  }
  const named = !genericLayerName(node.name) && !TAG_NAME.test(node.name.trim());
  const role = button ? "pulsante" : !layout ? (node.children.length ? "pila" : "gruppo") : layout.mode === "row" ? "riga" : layout.mode === "grid" ? "griglia" : "colonna";
  return { tag: tag || (button ? "a" : "div"), base: (named && designSlug(node.name)) || role, attrs, css, narrow, children, raw: "", cls: "", origin: { name: node.name, component: node.component } };
}

/** True when a text under the node is a link by its name or by its address: a button around it would put a link in a link. */
function hasLink(node: DesignNode): boolean {
  let found = false;
  walkDesign(node, (item) => {
    if (item.kind === "text" && (LINK_NAME.test(item.name.trim()) || item.text?.paragraphs.flat().some((piece) => piece.link !== ""))) found = true;
  });
  return found;
}

/** The element of any node, or null for one that is not written. */
function nodeOut(node: DesignNode, place: Place, ctx: Ctx): Out | null {
  if (node.kind === "text") return textOut(node, place, ctx);
  if (node.kind === "vector") return vectorOut(node, place, ctx);
  if (node.kind === "image") return imageOut(node, place, ctx);
  if (node.kind === "shape") return shapeOut(node, place, ctx);
  return frameOut(node, place, ctx);
}

/**
 * The prototype of one frame. The children of the frame are the sections of the page `home`; the first one named
 * as a header and the last one named as a footer become the parts `site/header` and `site/footer`. Throws a
 * TypeError, in Italian, for an id that is not a UUID.
 */
export function designPrototype(page: DesignPage, options: DesignPrototypeOptions): { html: string; report: DesignPrototypeReport } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.id)) throw new TypeError("L'id del prototipo deve essere un UUID in minuscolo.");
  const root = page.root;
  const report: DesignPrototypeReport = {
    file: page.file, page: page.page, frame: page.frame, source: page.source, width: Math.round(root.box.width), layers: 0, sections: [], inferred: [], stacked: [], absolute: [], strips: [], fixedWidths: 0, spread: 0,
    spaces: { token: 0, fixed: 0 }, textSizes: [], fonts: [], headings: 0, images: 0, imagesMissing: [], vectors: 0, links: 0, mixedText: 0, genericNames: 0, unsupported: [], designComponents: [], components: [], recordTypes: [], hidden: page.hidden, problems: [...page.problems], notes: [],
  };
  let design: HistosDesign = {};
  // Only what the caller gave: a default of the framework is not a colour or a size of this design.
  let given = new Set(Object.keys(options.design ?? {}));
  try {
    design = validateHistosDesign(options.design ?? {});
  } catch (error) {
    given = new Set();
    report.notes.push(`Parametri del design non validi, non usati: ${error instanceof Error ? error.message : "errore"}.`);
  }
  const ctx: Ctx = { page, scales: designScales(design), report, assets: new Map(), assetBytes: 0, colors: new Map(), canon: new Map(), bodyFamily: "", headingFamily: "", headings: new Map(), inferred: new Set(), strips: new Set(), bleed: new Map(), drawn: new Set(), textSizes: new Map() };
  for (const family of HISTOS_CSS_DESIGN_DATA.families as readonly string[]) {
    const value = design[family];
    if (given.has(family) && typeof value === "string" && value) ctx.colors.set(value, `var(--xb-${family})`);
  }
  if (page.listed !== undefined) report.listed = page.listed;
  const copies = new Map<string, number>();
  walkDesign(root, (node) => {
    report.layers += 1;
    if (node.component) copies.set(node.component.name, (copies.get(node.component.name) ?? 0) + 1);
    if (node.kind !== "vector" && genericLayerName(node.name)) report.genericNames += 1;
    for (const what of node.unsupported) report.unsupported.push({ layer: node.name || "livello", what });
  });
  prepare(root, ctx, true);

  // The sections: the children of a frame that is a column; otherwise the frame itself is the one section.
  const column = root.layout?.mode === "column";
  const sections = column ? root.children.filter((child) => !child.absolute) : [root];
  const header = column && sections.length > 1 && HEADER_NAME.test(sections[0]!.name) ? sections[0]! : null;
  const footer = column && sections.length > 1 && FOOTER_NAME.test(sections.at(-1)!.name) && sections.at(-1) !== header ? sections.at(-1)! : null;
  const content = sections.filter((section) => section !== header && section !== footer);
  const bodySize = planHeadings(content, footer ? [footer] : [], ctx);
  // The size of the running text of the design is the base of the scale, when the design gives no scale of its own.
  if (bodySize >= 10 && bodySize <= 40 && !given.has("text_max") && !given.has("text_min")) {
    const max = Math.round(bodySize);
    const min = Math.min(max, Math.max(14, max - 2));
    try {
      design = validateHistosDesign({ ...design, text_min: min, text_max: max });
      ctx.scales = designScales(design);
      report.notes.push(`Il testo corrente del design è di ${bodySize} px: la scala dei testi parte da lì (da ${min} px sugli schermi stretti a ${max} px su quelli larghi).`);
    } catch {
      // The default scale stays.
    }
  }

  const blocks = new Map<string, { roots: Out[]; registry: Map<string, string[]> }>();
  const extra = new Map<DesignNode, string[]>();
  const drafts: Array<{ out: Out; name: string }> = [];
  /** Writes a block as elements and chooses its name. Its classes and its HTML come later, when the components are known. */
  const write = (node: DesignNode, tag: string, fallback: string, place: Place): { out: Out; name: string } | null => {
    // A section that is a single text or picture gets a frame of its own around it.
    const lone = node.kind === "frame" ? null : nodeOut(node, { ...place, mode: "column", align: "start" }, ctx);
    const out: Out | null = node.kind === "frame" ? frameOut(node, place, ctx, tag) : lone ? { tag, base: fallback, attrs: [], css: ["display: flex", "flex-direction: column", "align-items: flex-start", "padding-inline: var(--xb-gutter)"], narrow: [], children: [lone], raw: "", cls: "" } : null;
    if (!out) return null;
    out.css.push(...(extra.get(node) ?? []));
    // A framework can give every section a padding of its own (Automatic.css does): a section says its own, also when it is none.
    if (tag === "section" && !out.css.some((line) => /^padding(-block)?:/u.test(line))) out.css.push(out.css.some((line) => line.startsWith("padding-inline:")) ? "padding-block: 0" : "padding: 0");
    const named = !genericLayerName(node.name) && designSlug(node.name);
    const base = named || fallback;
    const signature = [...out.css, NARROW, ...out.narrow].join(";");
    let name = base;
    for (let n = 2; blocks.has(name) && [...blocks.get(name)!.roots[0]!.css, NARROW, ...blocks.get(name)!.roots[0]!.narrow].join(";") !== signature; n += 1) name = `${base}-${n}`;
    const block = blocks.get(name) ?? { roots: [], registry: new Map<string, string[]>() };
    blocks.set(name, block);
    block.roots.push(out);
    if (tag === "section") {
      let titled = false;
      const find = (item: Out) => {
        if (/^h[2-6]$/u.test(item.tag)) titled = true;
        item.children.forEach(find);
      };
      find(out);
      if (named && !out.attrs.some(([key]) => key === "aria-label")) out.attrs.push(["aria-label", node.name.trim()]);
      else if (!titled) out.tag = "div";
    }
    report.sections.push(name);
    drafts.push({ out, name });
    return drafts.at(-1)!;
  };
  /** What a part outside `<main>` needs as a block of its own: its width when it is narrower than the page, and its distance from the content. */
  const apart = (node: DesignNode, side: "start" | "end", distance: number): void => {
    if (node.box.width < root.box.width - 32) extra.set(node, [`inline-size: min(${rem(node.box.width)}, 100% - 2 * var(--xb-gutter))`, "margin-inline: auto"]);
    if (distance >= 0.5) extra.set(node, [...(extra.get(node) ?? []), `margin-block-${side}: ${spaceCss(ctx, distance)}`]);
  };
  const pad = root.layout?.padding ?? [0, 0, 0, 0];
  const place: Place = column ? { mode: "column", width: root.box.width - pad[1] - pad[3], height: 0, align: root.layout!.align, inLink: false } : { mode: "flow", width: root.box.width, height: root.box.height, align: "stretch", inLink: false };
  const flowPlace: Place = { mode: "flow", width: root.box.width, height: 0, align: "stretch", inLink: false };
  if (header && content[0]) apart(header, "end", content[0].box.y - header.box.y - header.box.height);
  if (footer) apart(footer, "start", footer.box.y - Math.max(0, ...sections.filter((section) => section !== footer).map((section) => section.box.y + section.box.height)));
  const headerDraft = header ? write(header, "header", "testata", flowPlace) : null;
  const bodyDrafts = content.map((section, index) => write(section, "section", `sezione-${index + 1}`, place)).filter((draft) => draft !== null);
  const footerDraft = footer ? write(footer, "footer", "piede", flowPlace) : null;

  // Phase 4: what repeats becomes a component, before the classes are given: a component is a block of its own.
  const taken = new Set([...blocks.keys(), "pagina"]);
  const found: DesignComponents = options.components === false ? { components: [], types: [], families: [] } : designComponents(drafts.map((draft) => draft.out), { taken, records: options.records !== false, uniform: options.uniform === true });
  for (const draft of drafts) nameDesignClasses(draft.out, draft.name, blocks.get(draft.name)!.registry);
  const headerHtml = headerDraft ? designOutHtml(headerDraft.out) : "";
  const body = bodyDrafts.map((draft) => designOutHtml(draft.out));
  const footerHtml = footerDraft ? designOutHtml(footerDraft.out) : "";
  report.designComponents = [...copies].map(([name, count]) => {
    const family = found.families.find((item) => item.name === name);
    return { name, copies: count, made: family?.made ?? 0, nested: family?.nested ?? 0, loose: family?.loose ?? 0 };
  });
  report.components = found.components.map((component) => ({ ref: component.ref, name: component.title, copies: component.copies, variants: component.variants, props: component.texts, slots: component.slots, declared: component.declared, type: component.type, uneven: component.uneven, uniformed: component.uniformed }));
  report.recordTypes = found.types.map((type) => ({ key: type.key, records: type.records.length, queries: type.queries.length }));
  // A type has its own pages, whether the design draws them or not: one plain block for them.
  let listBlock = "";
  if (found.types.length) {
    for (let n = 1; !listBlock || taken.has(listBlock); n += 1) listBlock = n === 1 ? "elenco" : `elenco-${String.fromCharCode(96 + n)}`;
    report.notes.push(`Schede ripetute scritte come record (${found.types.map((type) => `tipo «${type.key}», ${type.records.length} record`).join("; ")}): ogni tipo ha anche le sue pagine, l'elenco e una per record, scritte qui con un template semplice (schede/…). Il design non le disegna: controlla il nome del tipo, i campi e quelle pagine.`);
  }
  const shell = (inner: string) => `${headerHtml ? "<Site.Header />" : ""}<main class="pagina"><div class="${listBlock}">${inner}{@slot}</div></main>${footerHtml ? "<Site.Footer />" : ""}`;
  const typeRef = (key: string) => `schede/${key.replace(/_/gu, "-")}`;

  // The page itself: the look and the layout of the frame, on <main>.
  const main: string[] = [];
  if (column) {
    const shell = designNode({ ...root, children: [] });
    main.push("display: flex", "flex-direction: column");
    if (root.layout!.align !== "stretch") main.push(`align-items: ${ALIGN_CSS[root.layout!.align]}`);
    if (root.layout!.gap > 0) main.push(`gap: ${spaceCss(ctx, root.layout!.gap)}`);
    boxCss({ ...shell, shadows: [], radii: [0, 0, 0, 0], stroke: null }, ctx, main);
  }
  report.textSizes = [...ctx.textSizes.values()].sort((a, b) => b.px - a.px);
  if (!ctx.headings.size) report.notes.push("Il riquadro non ha testi: la pagina non ha un titolo h1, aggiungilo nel prototipo.");
  report.notes.push(`Il design ha una sola larghezza (${report.width} px): la versione per telefono è dedotta, con le righe larghe in colonna sotto i 48rem.`);

  // The fonts of the design: named in the manifest when the design gives no parameters of its own.
  const font = (param: string, family: string) => {
    if (!family || given.has(param)) return;
    try {
      design = validateHistosDesign({ ...design, [param]: `${family}, system-ui, sans-serif` });
    } catch {
      report.notes.push(`Carattere «${family}»: il nome non entra nei parametri del design.`);
    }
  };
  font("font_body", ctx.bodyFamily);
  if (ctx.headingFamily !== ctx.bodyFamily) font("font_heading", ctx.headingFamily);

  const name = (options.name?.trim() || `${page.file} · ${page.frame}`).slice(0, 120);
  const manifest = { format: "histos-prototype", version: 1, id: options.id, name, locale: options.locale ?? "it-IT", timeZone: "Europe/Rome", framework: "histos-css", design: changedHistosDesign(design) };
  const assets = [...ctx.assets.values()].filter((asset) => asset !== null).map((asset) => ({ name: asset.name, data: asset.data, alt: asset.alt }));
  const json = (value: unknown) => JSON.stringify(value).replace(/</gu, "\\u003c");
  const rules = [
    ...(main.length ? [`.pagina { ${main.map((line) => `${line};`).join(" ")} }`] : []),
    ...[...blocks].map(([block, { roots }]) => designBlockRule(block, roots)),
    ...found.components.map((component) => component.rule),
    ...(listBlock ? [`.${listBlock} { display: flex; flex-direction: column; gap: var(--xb-space-m); padding: var(--xb-space-xl) var(--xb-gutter); &__titolo { font-size: var(--xb-h2); overflow-wrap: anywhere; } &__voci { display: grid; gap: var(--xb-space-xs); margin: 0; padding-inline-start: var(--xb-space-m); } &__link { display: inline-block; padding-block: var(--xb-space-2xs); text-decoration: underline; } }`] : []),
  ];
  const records = {
    types: found.types.map((type) => ({ key: type.key, label: type.label, singleTemplate: typeRef(type.key), archiveTemplate: `${typeRef(type.key)}-elenco`, fields: type.fields.map((field) => ({ ...field, required: false, public: true, multiple: false })) })),
    taxonomies: [],
    terms: [],
    records: found.types.flatMap((type) => type.records.map((record) => ({ type: type.key, slug: record.slug, title: record.title, publishedAt: "2026-01-01T00:00:00Z", order: record.order, values: record.values }))),
    queries: found.types.flatMap((type) => type.queries.map((query) => ({ key: query.key, label: query.label, type: type.key, limit: query.limit, ...(query.offset ? { offset: query.offset } : {}), orderBy: "order", order: "asc" }))),
  };
  const quoted = (value: unknown) => JSON.stringify(value).replace(/&/gu, "&amp;").replace(/'/gu, "&#39;").replace(/</gu, "&lt;");
  const html = [
    "<!doctype html>",
    `<html lang="${attr((options.locale ?? "it-IT").split("-")[0]!)}" data-histos-prototype="1">`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${esc(name).replace(/\\/gu, "")}</title>`,
    `<script type="application/json" data-histos="manifest">${json(manifest)}</script>`,
    ...(assets.length ? [`<script type="application/json" data-histos="assets">${json(assets)}</script>`] : []),
    ...(found.types.length ? [`<script type="application/json" data-histos="content">${json(records)}</script>`] : []),
    '<style data-histos="global" data-name="Base">*, *::before, *::after { box-sizing: border-box; } body { margin: 0; font-family: var(--xb-font-body); } h1, h2, h3, h4, h5, h6, p, figure { margin: 0; } img, svg { display: block; max-inline-size: 100%; } a { color: inherit; text-decoration: none; }</style>',
    `<style data-histos="selectors">${rules.join("\n")}</style>`,
    "</head>",
    "<body>",
    ...(headerHtml ? [`<template data-histos="part" data-ref="site/header" data-area="header" data-title="Testata">${headerHtml}</template>`] : []),
    ...(footerHtml ? [`<template data-histos="part" data-ref="site/footer" data-area="footer" data-title="Piè di pagina">${footerHtml}</template>`] : []),
    ...found.components.map((component) => `<template data-histos="component" data-ref="${component.ref}" data-title="${attr(component.title)}"${Object.keys(component.props).length ? ` data-props='${quoted(component.props)}'` : ""}>${component.html}</template>`),
    ...found.types.flatMap((type) => [
      `<template data-histos="template" data-ref="${typeRef(type.key)}" data-title="${attr(type.label)}">${shell(`<h1 class="${listBlock}__titolo">{page.title}</h1>${type.fields.filter((field) => field.type === "text").map((field) => `<p class="${listBlock}__testo">{page.fields.${field.key}}</p>`).join("")}`)}</template>`,
      `<template data-histos="template" data-ref="${typeRef(type.key)}-elenco" data-title="${attr(type.label)}, elenco">${shell(`<h1 class="${listBlock}__titolo">{page.title}</h1><ul class="${listBlock}__voci">{#loop main() as voce}<li><a class="${listBlock}__link" href={voce.url}>{voce.title}</a></li>{:else}<li>Nessun contenuto.</li>{/loop}</ul>`)}</template>`,
    ]),
    `<template data-histos="template" data-ref="site/page" data-role="page" data-title="Pagina">${headerHtml ? "<Site.Header />" : ""}<main class="pagina">{@slot}</main>${footerHtml ? "<Site.Footer />" : ""}</template>`,
    `<template data-histos="page" data-slug="home" data-title="${attr(page.frame) || "Home"}" data-template="site/page">${body.join("\n")}</template>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { html, report };
}

/** The report in Italian, for a terminal or a text file: what was written, what was deduced, what was left out. */
export function designPrototypeText(report: DesignPrototypeReport): string {
  const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
  const some = (items: readonly string[], max = 8) => `${items.slice(0, max).map((item) => `«${item}»`).join(", ")}${items.length > max ? ` e ${many(items.length - max, "altro", "altri")}` : ""}`;
  // The list of the frames counts every layer of the file: when fewer are written, both numbers are said, with the reason.
  const layers = report.listed !== undefined && report.listed > report.layers
    ? `${many(report.listed, "livello", "livelli")} nel riquadro, ${report.layers} nel prototipo (gli altri sono nascosti o non hanno niente da disegnare)`
    : many(report.layers, "livello", "livelli");
  const lines = [
    `${report.file}: pagina «${report.page}», riquadro «${report.frame}» (${report.source === "penpot" ? "Penpot" : "Figma"}, ${report.width} px), ${layers}.`,
    `Blocchi scritti: ${report.sections.join(", ") || "nessuno"}.`,
    `Titoli: ${report.headings}. Immagini: ${report.images}. Icone e disegni: ${report.vectors}.`,
  ];
  if (report.designComponents.length) {
    const families = report.designComponents;
    const made = families.filter((family) => family.made > 0);
    const nested = families.filter((family) => !family.made && family.nested > 0).length;
    const once = families.filter((family) => !family.made && !family.nested && family.copies === 1).length;
    const other = families.length - made.length - nested - once;
    lines.push(`Componenti del design usati nel riquadro: ${families.length}, con ${many(families.reduce((sum, family) => sum + family.copies, 0), "copia", "copie")}. Riconosciuti come componenti del prototipo: ${made.length}${made.length ? ` (${some(made.map((family) => family.name))})` : ""}.`);
    const left = [once ? `${once} con una copia sola (${once === 1 ? "resta un blocco o un elemento" : "restano blocchi o elementi"} della pagina)` : "", nested ? `${nested} solo dentro un altro componente (${nested === 1 ? "sta" : "stanno"} nel suo markup)` : "", other ? `${other} con copie di struttura diversa, troppo diverse nello stile, o scritte come un solo disegno` : ""].filter(Boolean);
    if (left.length) lines.push(`Non riuniti: ${left.join("; ")}.`);
  }
  for (const component of report.components) {
    const parts = [many(component.copies, "copia", "copie"), component.variants.length ? `varianti come modificatori: ${component.variants.map((name) => `--${name}`).join(", ")}` : "", component.props.length ? `testi nelle prop: ${component.props.join(", ")}` : "", component.slots.length ? `negli slot: ${component.slots.join(", ")}` : "", component.type ? `le copie sono record del tipo «${component.type}», lette con un loop` : "", component.uneven ? "schede in fila, ma le immagini stanno in modo diverso in ogni copia o le copie hanno varianti: restano usi del componente, non record (per farne record, con lo stile della prima scheda per tutte: --schede-uniformi)" : "", component.uniformed ? "le schede in fila erano diverse fra loro: hanno preso tutte lo stile della prima (da controllare)" : ""].filter(Boolean);
    lines.push(`Componente «${component.ref}» (${component.declared ? "dal componente del design" : "da riquadri che si ripetono,"} «${component.name}»): ${parts.join("; ")}.`);
  }
  if (report.components.some((component) => component.variants.some((name) => /^\d+$/u.test(name)))) lines.push("Un modificatore con un numero (--2, --3) è una copia con altre dichiarazioni che il design non chiama variante: dagli un nome, o togli la differenza nel design.");
  if (report.components.some((component) => component.variants.some((name) => /hover|focus|active|pressed/u.test(name)))) lines.push("Una variante che è uno stato (hover, focus) è scritta come modificatore, per mostrarla dov'è nel design: sul sito spostala nello stato (&:hover) della regola del blocco.");
  if (report.inferred.length) lines.push(`Senza auto layout, righe e colonne dedotte dalle posizioni (da controllare): ${some(report.inferred)}.`);
  if (report.stacked.length) lines.push(`Livelli sovrapposti, messi in una cella di griglia senza coordinate: ${some(report.stacked)}.`);
  if (report.absolute.length) lines.push(`Livelli fuori flusso, messi nella stessa cella di griglia del resto del loro riquadro, sopra o sotto com'è nel design (da controllare sugli schermi stretti, dove possono coprire il testo): ${some(report.absolute)}.`);
  if (report.strips.length) lines.push(`Righe più larghe della pagina, rese come strisce che scorrono di lato (da controllare): ${some(report.strips)}.`);
  if (report.spread) lines.push(`${many(report.spread, "riga con uno spazio largo resa", "righe con uno spazio largo rese")} coi gruppi distribuiti da un capo all'altro (space-between).`);
  if (report.fixedWidths) lines.push(`${many(report.fixedWidths, "larghezza fissa resa massima", "larghezze fisse rese massime")}, in rem.`);
  lines.push(`Spazi: ${report.spaces.token} con un token, ${report.spaces.fixed} con una misura in rem.`);
  if (report.textSizes.length) {
    lines.push("Misure di testo: nessuna è una misura fissa. Il gradino più vicino:");
    for (const size of report.textSizes) lines.push(`  ${size.px} px → --${size.step} (${size.stepPx} px), ${many(size.count, "testo", "testi")}`);
  }
  if (report.fonts.length) lines.push(`Caratteri nominati dal design (il file e la licenza non sono nel design: caricali in Publish o scegli un carattere libero): ${report.fonts.join(", ")}.`);
  if (report.links) lines.push(`${many(report.links, "pulsante o link senza destinazione", "pulsanti e link senza destinazione")}: href «#», da sostituire.`);
  if (report.mixedText) lines.push(`${many(report.mixedText, "testo con pezzi di colore o misura diversi", "testi con pezzi di colore o misura diversi")}: scritti con lo stile del pezzo più lungo.`);
  if (report.genericNames) lines.push(`${many(report.genericNames, "livello ha", "livelli hanno")} un nome dato dallo strumento («Frame 12»): la classe dice che cosa sono (riga, colonna, testo). Per nomi migliori: histos-publish prototype rifinisci.`);
  if (report.imagesMissing.length) lines.push(`Immagini sostituite da un segnaposto: ${report.imagesMissing.slice(0, 8).join("; ")}${report.imagesMissing.length > 8 ? "…" : ""}.`);
  if (report.unsupported.length) {
    const kinds = new Map<string, string[]>();
    for (const item of report.unsupported) kinds.set(item.what, [...(kinds.get(item.what) ?? []), item.layer]);
    for (const [what, layers] of kinds) lines.push(`Non convertito, ${what}: ${some([...new Set(layers)], 5)}.`);
  }
  if (report.hidden) lines.push(`${many(report.hidden, "livello nascosto saltato", "livelli nascosti saltati")}.`);
  for (const problem of report.problems.slice(0, 20)) lines.push(`Problema, ${problem.token}: ${problem.why}.`);
  if (report.problems.length > 20) lines.push(`… e altri ${report.problems.length - 20} problemi.`);
  lines.push(...report.notes);
  return lines.join("\n");
}
