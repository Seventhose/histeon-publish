/**
 * The neutral tree of one frame of a design (note penpot-figma-a-histeon.md, phase 3): what a Penpot file and a
 * Figma file have in common, with none of their names. The readers (penpot-page.ts, fig-page.ts) write it, the
 * writer of the prototype (design-prototype.ts) reads it.
 *
 * Lengths are pixels of the design. A box is relative to the box of the parent. Children are in the order the eye
 * reads them when the parent has a layout, and from the bottom layer to the top one when it has none; a child out of
 * the flow of a layout before the first one in the flow lies under them, any other over them. Paints are from the
 * top one to the bottom one, as CSS lists backgrounds.
 *
 * Pure: types and small helpers. No network, no credentials, nothing read from disk.
 */

import type { TokenProblem } from "./design-tokens.js";

export interface DesignColor {
  /** 0-255. */
  r: number;
  g: number;
  b: number;
  /** 0-1. */
  alpha: number;
}

export type DesignPaint =
  | { kind: "solid"; color: DesignColor }
  /** `angle` as CSS wants it: 180 goes from the top to the bottom. */
  | { kind: "linear"; angle: number; stops: Array<{ color: DesignColor; offset: number }> }
  /** `image` is a key of `DesignPage.images`. */
  | { kind: "image"; image: string }
  /** A paint that is not converted (a radial gradient, a video): said in the report. */
  | { kind: "other"; what: string };

export interface DesignShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: DesignColor;
  inset: boolean;
}

export interface DesignStroke {
  color: DesignColor;
  /** The widest side. */
  width: number;
  dashed: boolean;
  /** Top, right, bottom, left, when the sides differ (a line under a header); absent when the four are `width`. */
  sides?: [number, number, number, number];
}

export type DesignJustify = "start" | "center" | "end" | "between" | "around" | "evenly";
export type DesignAlign = "start" | "center" | "end" | "stretch" | "baseline";
export type DesignSizing = "fixed" | "hug" | "fill";

export interface DesignLayout {
  mode: "row" | "column" | "grid";
  /** Between two children along the direction (for a grid, between two columns). */
  gap: number;
  /** Between two lines of a layout that wraps (for a grid, between two rows). */
  crossGap: number;
  /** Top, right, bottom, left. */
  padding: [number, number, number, number];
  justify: DesignJustify;
  align: DesignAlign;
  wrap: boolean;
  /** Columns of a grid; 0 for the other modes. */
  columns: number;
  /** The widths of the columns of a grid as shares of its width, when they are not all the same. */
  tracks?: number[];
}

export interface DesignRun {
  text: string;
  sizePx: number;
  weight: number;
  italic: boolean;
  /** The name of the font family, never its file. */
  family: string;
  /** A multiplier of the size; null for the automatic one. */
  lineHeight: number | null;
  letterSpacingPx: number;
  color: DesignColor | null;
  underline: boolean;
  transform: "" | "uppercase" | "lowercase" | "capitalize";
  /** An address the design gives to this piece of text; empty when it has none. */
  link: string;
}

export interface DesignText {
  /** Each paragraph is its pieces of text, each with its style. */
  paragraphs: DesignRun[][];
  align: "left" | "center" | "right" | "justify";
}

export interface DesignPath {
  /** The `d` of an SVG path, in the coordinates of the box of its node. */
  d: string;
  fill: DesignColor | null;
  stroke: DesignColor | null;
  strokeWidth: number;
  /** `evenodd` when the design says so. */
  evenOdd: boolean;
}

export interface DesignNode {
  id: string;
  /** The name of the layer, as the designer wrote it. */
  name: string;
  /** `shape` is a rectangle or an ellipse without children; `image` a layer that only shows a picture. */
  kind: "frame" | "text" | "image" | "vector" | "shape";
  box: { x: number; y: number; width: number; height: number };
  /** Null when the design places the children by coordinates. */
  layout: DesignLayout | null;
  sizing: { horizontal: DesignSizing; vertical: DesignSizing };
  /** Out of the flow of a parent that has a layout. */
  absolute: boolean;
  /** Its own place across the direction of the parent, when it differs; null otherwise. */
  alignSelf: DesignAlign | null;
  fills: DesignPaint[];
  stroke: DesignStroke | null;
  /** Top left, top right, bottom right, bottom left. */
  radii: [number, number, number, number];
  shadows: DesignShadow[];
  opacity: number;
  /** The frame cuts what goes out of its box. */
  clip: boolean;
  /** An ellipse: its corners are fully round whatever its size. */
  round: boolean;
  text: DesignText | null;
  paths: DesignPath[];
  /** The component this layer is a copy of, or is the main one of. `variant` is the name of the variant inside its set (`Size=Large, State=Hover`), when the design has sets. */
  component: { id: string; name: string; main: boolean; variant?: string } | null;
  /** An HTML tag the design itself names for this layer; empty when it names none. */
  tag: string;
  /** What this layer has that is not converted (a mask, a blur, a rotation), in Italian, for the report. */
  unsupported: string[];
  children: DesignNode[];
}

export interface DesignImage {
  /** Empty until the reader of the file attaches the bytes. */
  bytes: Uint8Array;
  /** As the design declares it; the writer trusts only the bytes. */
  mime: string;
  width: number;
  height: number;
}

export interface DesignPage {
  /** The name of the file, for the report. */
  file: string;
  /** The page of the design and the frame converted. */
  page: string;
  frame: string;
  source: "penpot" | "figma";
  root: DesignNode;
  images: Map<string, DesignImage>;
  /** Layers skipped because hidden. */
  hidden: number;
  /** How many layers the list of the frames counts for this frame: every layer of the file, also the hidden and the empty ones the tree leaves out. */
  listed?: number;
  /** How many other frames at the top of the page have the name of this one: a name alone does not say which one this is. */
  twins?: number;
  problems: TokenProblem[];
}

/** The pages of a design file with the frames at the top of each: what the user chooses from. */
export interface DesignPageList {
  file: string;
  source: "penpot" | "figma";
  pages: Array<{ id: string; name: string; frames: Array<{ id: string; name: string; width: number; height: number; layers: number }> }>;
}

/** Layers of one frame, and how deep they go: a file from outside cannot ask for more. */
export const DESIGN_NODES_MAX = 20_000;
export const DESIGN_DEPTH_MAX = 64;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A colour from `#rrggbb` (or `#rgb`) and an opacity; null for anything else. */
export function designColor(hex: unknown, opacity: unknown = 1): DesignColor | null {
  if (typeof hex !== "string") return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(hex.trim());
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
  const parts = short ? short.slice(1).map((part) => part + part) : long ? long.slice(1) : null;
  if (!parts) return null;
  const alpha = typeof opacity === "number" && Number.isFinite(opacity) ? clamp(opacity, 0, 1) : 1;
  return { r: Number.parseInt(parts[0]!, 16), g: Number.parseInt(parts[1]!, 16), b: Number.parseInt(parts[2]!, 16), alpha: Number(alpha.toFixed(3)) };
}

/** The colour as CSS: `#rrggbb`, or `rgb(r g b / a)` when it is not opaque. */
export function designColorCss(color: DesignColor): string {
  const hex = `#${[color.r, color.g, color.b].map((part) => clamp(Math.round(part), 0, 255).toString(16).padStart(2, "0")).join("")}`;
  return color.alpha >= 0.999 ? hex : `rgb(${color.r} ${color.g} ${color.b} / ${Number(color.alpha.toFixed(3))})`;
}

/** A node with every field at its empty value, then the fields given. */
export function designNode(fields: Partial<DesignNode> & Pick<DesignNode, "id" | "name" | "kind">): DesignNode {
  return {
    box: { x: 0, y: 0, width: 0, height: 0 },
    layout: null,
    sizing: { horizontal: "fixed", vertical: "fixed" },
    absolute: false,
    alignSelf: null,
    fills: [],
    stroke: null,
    radii: [0, 0, 0, 0],
    shadows: [],
    opacity: 1,
    clip: false,
    round: false,
    text: null,
    paths: [],
    component: null,
    tag: "",
    unsupported: [],
    children: [],
    ...fields,
  };
}

/** Calls `visit` for the node and for every node under it, parents first; `depth` starts at 0. */
export function walkDesign(node: DesignNode, visit: (node: DesignNode, depth: number, parent: DesignNode | null) => void, depth = 0, parent: DesignNode | null = null): void {
  visit(node, depth, parent);
  if (depth >= DESIGN_DEPTH_MAX) return;
  for (const child of node.children) walkDesign(child, visit, depth + 1, node);
}

/** Where a child sits across the direction of its parent, read from the two boxes: null when it is where the layout puts everyone. `tolerance` is how many pixels off still count: more for boxes placed by hand. */
export function crossPlace(layout: DesignLayout, parent: DesignNode["box"], child: DesignNode, tolerance = 1.5): DesignAlign | null {
  if (layout.mode === "grid" || child.absolute) return null;
  const row = layout.mode === "row";
  const [before, after] = row ? [layout.padding[0], layout.padding[2]] : [layout.padding[3], layout.padding[1]];
  const room = (row ? parent.height : parent.width) - before - after;
  const size = row ? child.box.height : child.box.width;
  const offset = (row ? child.box.y : child.box.x) - before;
  const place: DesignAlign = (row ? child.sizing.vertical : child.sizing.horizontal) === "fill" ? "stretch"
    : room - size <= tolerance ? layout.align
    : Math.abs(offset) <= tolerance ? "start"
    : Math.abs(offset - (room - size) / 2) <= tolerance ? "center"
    : Math.abs(offset - (room - size)) <= tolerance ? "end"
    : layout.align;
  return place === layout.align ? null : place;
}

/** The words of a layer name as a slug: lowercase ASCII letters and digits joined by one hyphen, at most 40 characters, starting with a letter; empty when no word is left. */
export function designSlug(name: string): string {
  const words = name.normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  while (words.length && !/^[a-z]/u.test(words[0]!)) words.shift();
  return words.join("-").slice(0, 40).replace(/-+$/u, "");
}

/** True for a name the tool gave and the designer never changed (`Frame 12`, `Group`, `Rectangle 5`, `Vector`), or an empty one. */
export function genericLayerName(name: string): boolean {
  return /^(?:frame|group|gruppo|rectangle|rettangolo|ellipse|ellisse|vector|vettore|line|linea|polygon|star|union|subtract|intersect|exclude|mask|mask group|image|img|board|container|div|span|auto layout|component|instance|shape|path|rect|circle|layer|slice|section|text|testo)?[\s_-]*\d*$/iu.test(name.trim());
}

/** The type and the size of a picture from its first bytes (PNG, JPEG, GIF, WebP); null for anything else. */
export function designImageType(bytes: Uint8Array): { mime: string; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number) => (at + length <= bytes.length ? String.fromCharCode(...bytes.subarray(at, at + length)) : "");
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && ascii(12, 4) === "IHDR") return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { mime: "image/webp", width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + ((view.getUint32(27, true)) & 0xffffff) };
    if (kind === "VP8 ") return { mime: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const bits = view.getUint32(21, true);
      return { mime: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // The size is in the first start-of-frame segment; every segment says its own length.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: "image/jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      at += 2 + view.getUint16(at + 2);
    }
    return null;
  }
  return null;
}
