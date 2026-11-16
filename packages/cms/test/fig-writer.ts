/**
 * A writer of the `canvas.fig` format of Figma, for the tests only (fig-file.test.ts, fig-page.test.ts, and the tests
 * of the command and of the server that need a `.fig` file): a schema of our own with the field names the reader expects,
 * a small document with styles and variables, a small page of a site with copies of components, and the ZIP around it.
 */

import zlib from "node:zlib";
import yazl from "yazl";
import type { KiwiDefinition } from "../src/fig-kiwi.js";

// ---------------------------------------------------------------------------------------------------------------------
// A writer of the format, for the tests only: a schema of our own with the field names the reader expects.

export class Writer {
  bytes: number[] = [];
  byte(value: number) { this.bytes.push(value & 255); }
  uint(value: number | bigint) {
    let left = BigInt(value);
    do {
      const low = Number(left & 127n);
      left >>= 7n;
      this.byte(left ? low | 128 : low);
    } while (left);
  }
  int(value: number) { this.uint(value < 0 ? -2 * value - 1 : 2 * value); }
  text(value: string) { this.bytes.push(...Buffer.from(value, "utf8"), 0); }
  float(value: number) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    const bits = view.getUint32(0);
    if (bits === 0) return this.byte(0);
    const turned = ((bits >>> 23) | (bits << 9)) >>> 0;
    for (let shift = 0; shift < 32; shift += 8) this.byte(turned >>> shift);
  }
}

export const PRIMITIVES = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];
export type Spec = Record<string, ["enum", string[]] | ["struct" | "message", Array<[name: string, type: string]>]>;

/** The definitions written as a table: a type is a primitive or a name, with `[]` for a list. */
export function definitionsOf(spec: Spec): KiwiDefinition[] {
  const names = Object.keys(spec);
  return names.map((name) => {
    const [kind, fields] = spec[name]!;
    if (kind === "enum") return { name, kind, fields: (fields as string[]).map((member, value) => ({ name: member, type: 0, array: false, value })) };
    return {
      name,
      kind,
      fields: (fields as Array<[string, string]>).map(([field, type], index) => {
        const base = type.replace("[]", "");
        const primitive = PRIMITIVES.indexOf(base);
        const at = primitive >= 0 ? -1 - primitive : names.indexOf(base);
        if (primitive < 0 && at < 0) throw new Error(`tipo ${base}`);
        return { name: field, type: at, array: type.endsWith("[]"), value: index + 1 };
      }),
    };
  });
}

export function schemaBytes(definitions: KiwiDefinition[]): Buffer {
  const out = new Writer();
  out.uint(definitions.length);
  for (const definition of definitions) {
    out.text(definition.name);
    out.byte(["enum", "struct", "message"].indexOf(definition.kind));
    out.uint(definition.fields.length);
    for (const field of definition.fields) {
      out.text(field.name);
      out.int(field.type);
      out.byte(field.array ? 1 : 0);
      out.uint(field.value);
    }
  }
  return Buffer.from(out.bytes);
}

export function messageBytes(definitions: KiwiDefinition[], root: string, data: unknown): Buffer {
  const out = new Writer();
  const value = (type: number, item: unknown): void => {
    if (type === -1) {
      out.byte(item ? 1 : 0);
      return;
    }
    if (type === -2) {
      out.byte(item as number);
      return;
    }
    if (type === -3) {
      out.int(item as number);
      return;
    }
    if (type === -4) {
      out.uint(item as number);
      return;
    }
    if (type === -5) {
      out.float(item as number);
      return;
    }
    if (type === -6) {
      out.text(item as string);
      return;
    }
    if (type === -7) {
      const n = item as bigint;
      out.uint(n < 0n ? -2n * n - 1n : 2n * n);
      return;
    }
    if (type === -8) {
      out.uint(item as bigint);
      return;
    }
    const definition = definitions[type]!;
    if (definition.kind === "enum") {
      out.uint(definition.fields.find((field) => field.name === item)!.value);
      return;
    }
    const fields = item as Record<string, unknown>;
    for (const field of definition.fields) {
      if (definition.kind === "message" && !Object.hasOwn(fields, field.name)) continue;
      if (definition.kind === "message") out.uint(field.value);
      if (!field.array) value(field.type, fields[field.name]);
      else {
        const items = fields[field.name] as unknown[];
        out.uint(items.length);
        for (const one of items) value(field.type, one);
      }
    }
    if (definition.kind === "message") out.uint(0);
  };
  value(definitions.findIndex((definition) => definition.name === root), data);
  return Buffer.from(out.bytes);
}

export function container(schema: Buffer, message: Buffer, options: { version?: number; zstd?: boolean } = {}): Buffer {
  const piece = (data: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    return Buffer.concat([size, data]);
  };
  const version = Buffer.alloc(4);
  version.writeUInt32LE(options.version ?? 101);
  const packed = options.zstd ? (zlib as unknown as { zstdCompressSync(data: Buffer): Buffer }).zstdCompressSync(message) : zlib.deflateRawSync(message);
  return Buffer.concat([Buffer.from("fig-kiwi"), version, piece(zlib.deflateRawSync(schema)), piece(packed)]);
}

export const SPEC: Spec = {
  NodeType: ["enum", ["NONE", "DOCUMENT", "CANVAS", "FRAME", "TEXT", "ROUNDED_RECTANGLE", "SYMBOL", "VARIABLE", "VARIABLE_SET", "INSTANCE", "VECTOR", "ELLIPSE", "LINE"]],
  NodePhase: ["enum", ["CREATED", "REMOVED"]],
  StyleType: ["enum", ["NONE", "FILL", "STROKE", "TEXT", "EFFECT", "EXPORT", "GRID"]],
  PaintType: ["enum", ["SOLID", "GRADIENT_LINEAR", "IMAGE"]],
  StackMode: ["enum", ["NONE", "HORIZONTAL", "VERTICAL"]],
  StackJustify: ["enum", ["MIN", "CENTER", "MAX", "SPACE_EVENLY", "SPACE_BETWEEN"]],
  StackAlign: ["enum", ["MIN", "CENTER", "MAX", "BASELINE"]],
  StackCounterAlign: ["enum", ["MIN", "CENTER", "MAX", "STRETCH", "AUTO"]],
  StackSize: ["enum", ["FIXED", "RESIZE_TO_FIT", "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE"]],
  StackPositioning: ["enum", ["AUTO", "ABSOLUTE"]],
  TextAutoResize: ["enum", ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT"]],
  TextAlignHorizontal: ["enum", ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]],
  WindingRule: ["enum", ["NONZERO", "ODD"]],
  NumberUnits: ["enum", ["RAW", "PIXELS", "PERCENT"]],
  EffectType: ["enum", ["INNER_SHADOW", "DROP_SHADOW", "FOREGROUND_BLUR", "BACKGROUND_BLUR"]],
  VariableResolvedDataType: ["enum", ["BOOLEAN", "FLOAT", "STRING", "COLOR"]],
  VariableScope: ["enum", ["ALL_SCOPES", "CORNER_RADIUS", "FONT_FAMILY", "FONT_SIZE"]],
  GUID: ["struct", [["sessionID", "uint"], ["localID", "uint"]]],
  Color: ["struct", [["r", "float"], ["g", "float"], ["b", "float"], ["a", "float"]]],
  Vector: ["struct", [["x", "float"], ["y", "float"]]],
  Matrix: ["struct", [["m00", "float"], ["m01", "float"], ["m02", "float"], ["m10", "float"], ["m11", "float"], ["m12", "float"]]],
  Blob: ["struct", [["bytes", "byte[]"]]],
  Image: ["message", [["hash", "byte[]"], ["name", "string"]]],
  ColorStop: ["struct", [["color", "Color"], ["position", "float"]]],
  Path: ["message", [["windingRule", "WindingRule"], ["commandsBlob", "uint"], ["styleID", "uint"]]],
  GUIDPath: ["message", [["guids", "GUID[]"]]],
  Hyperlink: ["message", [["url", "string"]]],
  SymbolData: ["message", [["symbolID", "GUID"], ["symbolOverrides", "NodeChange[]"]]],
  TextData: ["message", [["characters", "string"], ["characterStyleIDs", "uint[]"], ["styleOverrideTable", "NodeChange[]"]]],
  ParentIndex: ["struct", [["guid", "GUID"], ["position", "string"]]],
  Number: ["struct", [["value", "float"], ["units", "NumberUnits"]]],
  FontName: ["struct", [["family", "string"], ["style", "string"], ["postscript", "string"]]],
  Paint: ["message", [["type", "PaintType"], ["color", "Color"], ["opacity", "float"], ["visible", "bool"], ["stops", "ColorStop[]"], ["transform", "Matrix"], ["image", "Image"]]],
  Effect: ["message", [["type", "EffectType"], ["color", "Color"], ["offset", "Vector"], ["radius", "float"], ["spread", "float"], ["visible", "bool"]]],
  AssetRef: ["message", [["key", "string"]]],
  StyleId: ["message", [["guid", "GUID"], ["assetRef", "AssetRef"]]],
  VariableSetMode: ["message", [["id", "GUID"], ["name", "string"]]],
  VariableAnyValue: ["message", [["boolValue", "bool"], ["textValue", "string"], ["floatValue", "float"], ["alias", "StyleId"], ["colorValue", "Color"]]],
  VariableData: ["message", [["value", "VariableAnyValue"]]],
  VariableDataValuesEntry: ["message", [["modeID", "GUID"], ["variableData", "VariableData"]]],
  VariableDataValues: ["message", [["entries", "VariableDataValuesEntry[]"]]],
  FontMetaData: ["message", [["fontWeight", "int"]]],
  DerivedTextData: ["message", [["fontMetaData", "FontMetaData[]"]]],
  NodeChange: ["message", [
    ["guid", "GUID"], ["phase", "NodePhase"], ["parentIndex", "ParentIndex"], ["type", "NodeType"], ["name", "string"], ["key", "string"],
    ["styleType", "StyleType"], ["fontSize", "float"], ["lineHeight", "Number"], ["fontName", "FontName"], ["derivedTextData", "DerivedTextData"],
    ["visible", "bool"], ["fillPaints", "Paint[]"], ["effects", "Effect[]"], ["styleIdForFill", "StyleId"], ["styleIdForText", "StyleId"], ["internalOnly", "bool"],
    ["variableSetModes", "VariableSetMode[]"], ["variableSetID", "StyleId"], ["variableResolvedType", "VariableResolvedDataType"],
    ["variableDataValues", "VariableDataValues"], ["variableScopes", "VariableScope[]"], ["isSoftDeleted", "bool"], ["children", "NodeChange[]"],
    // The fields of a page (fig-page.ts), after those of the library so that the numbers of the first ones stay.
    ["size", "Vector"], ["transform", "Matrix"], ["opacity", "float"], ["stackMode", "StackMode"], ["stackSpacing", "float"], ["stackHorizontalPadding", "float"], ["stackVerticalPadding", "float"],
    ["stackPaddingRight", "float"], ["stackPaddingBottom", "float"], ["stackPrimaryAlignItems", "StackJustify"], ["stackCounterAlignItems", "StackAlign"], ["stackPrimarySizing", "StackSize"],
    ["stackCounterSizing", "StackSize"], ["stackChildPrimaryGrow", "float"], ["stackChildAlignSelf", "StackCounterAlign"], ["stackPositioning", "StackPositioning"], ["strokePaints", "Paint[]"],
    ["strokeWeight", "float"], ["cornerRadius", "float"], ["textData", "TextData"], ["textAutoResize", "TextAutoResize"], ["textAlignHorizontal", "TextAlignHorizontal"], ["hyperlink", "Hyperlink"],
    ["fillGeometry", "Path[]"], ["strokeGeometry", "Path[]"], ["symbolData", "SymbolData"], ["derivedSymbolData", "NodeChange[]"], ["overrideKey", "GUID"], ["guidPath", "GUIDPath"],
    ["overriddenSymbolID", "GUID"], ["styleID", "uint"], ["mask", "bool"], ["frameMaskDisabled", "bool"], ["isStateGroup", "bool"], ["borderStrokeWeightsIndependent", "bool"], ["borderBottomWeight", "float"],
  ]],
  Message: ["message", [["nodeChanges", "NodeChange[]"], ["sentTimestamp", "uint64"], ["pasteID", "int"], ["offset", "int64"], ["blob", "byte[]"], ["__proto__", "string"], ["blobs", "Blob[]"]]],
};
export const DEFINITIONS = definitionsOf(SPEC);

export const guid = (localID: number, sessionID = 1) => ({ sessionID, localID });
export const rgb = (hex: string, a = 1) => ({ r: Number.parseInt(hex.slice(1, 3), 16) / 255, g: Number.parseInt(hex.slice(3, 5), 16) / 255, b: Number.parseInt(hex.slice(5, 7), 16) / 255, a });
export const solid = (hex: string, opacity = 1) => ({ type: "SOLID", color: rgb(hex), opacity, visible: true });
export const INTERNAL = guid(2, 0);
export const PAGE = guid(3, 0);
export const under = (parent: { sessionID: number; localID: number }) => ({ guid: parent, position: "!" });
export let next = 100;
export const node = (type: string, name: string, extra: Record<string, unknown> = {}, parent = INTERNAL) => {
  next += 1;
  return { guid: guid(next), phase: "CREATED", parentIndex: under(parent), type, name, ...extra };
};
export const fill = (name: string, paints: unknown[], extra: Record<string, unknown> = {}) => node("ROUNDED_RECTANGLE", name, { styleType: "FILL", fillPaints: paints, ...extra });
export const textStyle = (name: string, family: string, style: string, size: number, lineHeight: { value: number; units: string }, weight?: number) =>
  node("TEXT", name, { styleType: "TEXT", fontName: { family, style, postscript: "" }, fontSize: size, lineHeight, ...(weight ? { derivedTextData: { fontMetaData: [{ fontWeight: weight }] } } : {}) });
export const value = (mode: { sessionID: number; localID: number }, data: Record<string, unknown>) => ({ modeID: mode, variableData: { value: data } });
export const variable = (name: string, set: Record<string, unknown>, type: string, entries: unknown[], extra: Record<string, unknown> = {}) =>
  node("VARIABLE", name, { variableSetID: set, variableResolvedType: type, variableDataValues: { entries }, ...extra });

/** A small file with what the three real ones have: styles kept in the internal page, collections with modes, aliases by key. */
export function sampleNodes(): unknown[] {
  const LIGHT = guid(0, 50);
  const DARK = guid(1, 50);
  const ONE = guid(0, 60);
  const colors = node("VARIABLE_SET", "Colori", { key: "set-colori", variableSetModes: [{ id: LIGHT, name: "Light" }, { id: DARK, name: "Dark" }, { id: guid(2, 50), name: "Contrasto" }] });
  const sizes = node("VARIABLE_SET", "Misure", { variableSetModes: [{ id: ONE, name: "Mode 1" }] });
  const faces = node("VARIABLE_SET", "Caratteri", { variableSetModes: [{ id: guid(0, 70), name: "Mode 1" }] });
  const byKey = { assetRef: { key: "set-colori" } };
  const blue = variable("Blue/500", byKey, "COLOR", [value(LIGHT, { colorValue: rgb("#1d4ed8") }), value(DARK, { colorValue: rgb("#93c5fd") })], { key: "var-blue" });
  const used = fill("Yellow", [solid("#ffbd00")], { key: "style-yellow" });
  const brand = fill("Brand/Primary", [solid("#6750a4")]);
  const frame = node("FRAME", "Hero", { styleIdForFill: { guid: brand.guid } }, PAGE);
  const plain = variable("Plain", { guid: faces.guid }, "STRING", [value(guid(0, 70), { textValue: "Source Sans 3" })]);
  return [
    { guid: guid(0, 0), phase: "CREATED", type: "DOCUMENT", name: "Document" },
    { guid: INTERNAL, phase: "CREATED", parentIndex: under(guid(0, 0)), type: "CANVAS", name: "Internal Only Canvas", internalOnly: true },
    { guid: PAGE, phase: "CREATED", parentIndex: under(guid(0, 0)), type: "CANVAS", name: "Design" },
    frame,
    node("TEXT", "Titolo", { styleIdForFill: { assetRef: { key: "style-yellow" } } }, frame.guid),
    node("SYMBOL", "Card", {}, PAGE),
    node("FRAME", "Tolto", { phase: "REMOVED" }, PAGE),
    brand,
    fill("Colors / White / 20%", [solid("#ffffff", 0.2)]),
    fill("Yellow", [solid("#ffc947")]),
    used,
    fill("Sfondo sfumato", [{ type: "GRADIENT_LINEAR", opacity: 1, visible: true }]),
    fill("Due riempimenti", [solid("#000000"), solid("#ffffff")]),
    textStyle("Body/Large", "Roboto", "Regular", 22, { value: 1.3, units: "RAW" }, 400),
    textStyle("Body/Medium", "Roboto", "Regular", 15, { value: 27, units: "PIXELS" }, 400),
    textStyle("Heading/H1", "Roboto Slab", "SemiBold", 48, { value: 100, units: "PERCENT" }),
    textStyle("Etichetta", "Roboto", "Medium", 12, { value: 140, units: "PERCENT" }),
    node("ROUNDED_RECTANGLE", "Shadow/Card", { styleType: "EFFECT", effects: [
      { type: "DROP_SHADOW", color: rgb("#000000", 0.25), offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true },
      { type: "INNER_SHADOW", color: rgb("#ffffff", 0.5), offset: { x: 0, y: 1 }, radius: 0, spread: 0, visible: true },
      { type: "BACKGROUND_BLUR", radius: 8, visible: true },
    ] }),
    node("FRAME", "Griglia", { styleType: "GRID" }),
    colors,
    sizes,
    faces,
    blue,
    variable("Primary", byKey, "COLOR", [value(LIGHT, { alias: { assetRef: { key: "var-blue" } } }), value(DARK, { alias: { guid: blue.guid } })]),
    variable("Radius/Card", { guid: sizes.guid }, "FLOAT", [value(ONE, { floatValue: 12 })], { variableScopes: ["CORNER_RADIUS"] }),
    variable("Gap", { guid: sizes.guid }, "FLOAT", [value(ONE, { floatValue: 24 })]),
    variable("Gap", { guid: faces.guid }, "FLOAT", [value(guid(0, 70), { floatValue: 8 })]),
    plain,
    variable("Titoli/Font", { guid: faces.guid }, "STRING", [value(guid(0, 70), { alias: { guid: plain.guid } })], { variableScopes: ["FONT_FAMILY"] }),
    variable("Mostra", { guid: sizes.guid }, "BOOLEAN", [value(ONE, { boolValue: true })]),
    variable("Vecchia", { guid: sizes.guid }, "FLOAT", [value(ONE, { floatValue: 1 })], { isSoftDeleted: true }),
    variable("Orfana", { guid: guid(999) }, "FLOAT", [value(ONE, { floatValue: 1 })]),
  ];
}
export const sampleCanvas = (options: { zstd?: boolean; version?: number } = {}) => container(schemaBytes(DEFINITIONS), messageBytes(DEFINITIONS, "Message", { nodeChanges: sampleNodes() }), options);

// ---------------------------------------------------------------------------------------------------------------------
// A page of a site, for fig-page.test.ts: frames with auto layout, a picture, a drawing, a mask and copies of components.

/** The blob of a path: a byte for each command (0 close, 1 move, 2 line, 4 curve) and its numbers as 32 bit floats. */
export function pathBlob(commands: Array<[code: number, ...numbers: number[]]>): { bytes: number[] } {
  const bytes: number[] = [];
  for (const [code, ...numbers] of commands) {
    bytes.push(code);
    for (const number of numbers) {
      const four = Buffer.alloc(4);
      four.writeFloatLE(number);
      bytes.push(...four);
    }
  }
  return { bytes };
}
export const IMAGE_HASH = Array.from({ length: 20 }, (_, index) => index + 1);
export const IMAGE_KEY = Buffer.from(IMAGE_HASH).toString("hex");
/** A PNG of one pixel. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const box = (x: number, y: number, width: number, height: number) => ({ size: { x: width, y: height }, transform: at(x, y) });
const label = (name: string, characters: string, size: number, extra: Record<string, unknown>, parent: { sessionID: number; localID: number }) =>
  node("TEXT", name, { textData: { characters }, fontSize: size, fontName: { family: "Inter", style: "Regular", postscript: "" }, fillPaints: [solid("#111111")], textAutoResize: "WIDTH_AND_HEIGHT", ...extra }, parent);
let order = 0;
/** The same node with the next place among its siblings: the reader sorts the children by this text. */
const placed = <T extends { parentIndex: { position: string } }>(item: T): T => {
  order += 1;
  return { ...item, parentIndex: { ...item.parentIndex, position: String.fromCharCode(33 + order) } };
};

/** The nodes of the page and the blobs their drawings point at. `ids` names the layers the tests look for. */
export function siteNodes(): { nodes: unknown[]; blobs: Array<{ bytes: number[] }>; ids: Record<string, string> } {
  order = 0;
  const id = (item: { guid: { sessionID: number; localID: number } }) => `${item.guid.sessionID}:${item.guid.localID}`;
  const SITE = guid(4, 0);
  const KEY_TITLE = guid(1, 900);
  const KEY_BUTTON = guid(2, 900);
  // The component of a button, and the one of a card that holds a copy of the button.
  const button = placed(node("SYMBOL", "Pulsante", { ...box(0, 1200, 120, 40), stackMode: "HORIZONTAL", stackHorizontalPadding: 16, stackPaddingRight: 16, stackVerticalPadding: 8, stackPaddingBottom: 8, fillPaints: [solid("#1d4ed8")], cornerRadius: 8, stackCounterSizing: "RESIZE_TO_FIT" }, SITE));
  const buttonText = placed(label("Etichetta", "Scopri", 16, box(16, 8, 88, 24), button.guid));
  const set = placed(node("FRAME", "Scheda", { ...box(400, 1200, 700, 300), isStateGroup: true }, SITE));
  const card = placed(node("SYMBOL", "Tipo=Base", { ...box(0, 0, 300, 200), stackMode: "VERTICAL", stackSpacing: 12, stackHorizontalPadding: 16, stackPaddingRight: 16, stackVerticalPadding: 16, stackPaddingBottom: 16, stackPrimarySizing: "FIXED", fillPaints: [solid("#ffffff")], strokePaints: [solid("#dddddd")], strokeWeight: 1, borderStrokeWeightsIndependent: true, borderBottomWeight: 2 }, set.guid));
  const cardTitle = placed(label("Titolo", "Titolo della scheda", 24, { ...box(16, 16, 268, 30), overrideKey: KEY_TITLE, textAutoResize: "HEIGHT", stackChildAlignSelf: "STRETCH" }, card.guid));
  const cardButton = placed(node("INSTANCE", "Pulsante", { ...box(16, 58, 120, 40), overrideKey: KEY_BUTTON, symbolData: { symbolID: button.guid, symbolOverrides: [] } }, card.guid));

  const home = placed(node("FRAME", "Home", { ...box(0, 0, 1440, 900), stackMode: "VERTICAL", stackPrimarySizing: "FIXED", fillPaints: [solid("#fafafa")] }, SITE));
  const header = placed(node("FRAME", "Header", { ...box(0, 0, 1440, 80), stackMode: "HORIZONTAL", stackPrimaryAlignItems: "SPACE_EVENLY", stackCounterAlignItems: "CENTER", stackSpacing: 900, stackHorizontalPadding: 120, stackPaddingRight: 120, stackPrimarySizing: "FIXED", stackChildAlignSelf: "STRETCH" }, home.guid));
  const logo = placed(label("Logo", "Bottega", 20, box(120, 28, 100, 24), header.guid));
  const link = placed(label("Contatti", "Scrivici", 16, { ...box(1220, 28, 100, 24), hyperlink: { url: "https://example.com/contatti" } }, header.guid));
  const hero = placed(node("FRAME", "Hero", { ...box(0, 80, 1440, 400), stackMode: "VERTICAL", stackSpacing: 24, stackVerticalPadding: 64, stackPaddingBottom: 64, stackHorizontalPadding: 120, stackPaddingRight: 120, stackCounterAlignItems: "CENTER", stackChildAlignSelf: "STRETCH" }, home.guid));
  const heroTitle = placed(node("TEXT", "Titolo", { ...box(420, 64, 600, 120), textData: { characters: "Vasi fatti a mano\nuno per uno", characterStyleIDs: [0, 0, 0, 0, 0, 7, 7, 7, 7, 7], styleOverrideTable: [{ styleID: 7, fontName: { family: "Inter", style: "Bold Italic", postscript: "" } }] }, fontSize: 56, fontName: { family: "Inter", style: "SemiBold", postscript: "" }, lineHeight: { value: 1.1, units: "RAW" }, fillPaints: [solid("#111111")], textAlignHorizontal: "CENTER", textAutoResize: "HEIGHT" }, hero.guid));
  const photo = placed(node("ROUNDED_RECTANGLE", "Foto", { ...box(520, 208, 400, 128), fillPaints: [{ type: "IMAGE", opacity: 1, visible: true, image: { hash: IMAGE_HASH, name: "foto" } }], cornerRadius: 12 }, hero.guid));
  const badge = placed(node("ELLIPSE", "Bollo", { ...box(1300, 20, 60, 60), fillPaints: [{ type: "GRADIENT_LINEAR", opacity: 1, visible: true, stops: [{ color: rgb("#ff0000"), position: 0 }, { color: rgb("#0000ff"), position: 1 }], transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 } }], stackPositioning: "ABSOLUTE" }, hero.guid));
  const cards = placed(node("FRAME", "Schede", { ...box(0, 480, 1440, 300), stackMode: "HORIZONTAL", stackSpacing: 32, stackHorizontalPadding: 120, stackPaddingRight: 120, stackVerticalPadding: 48, stackPaddingBottom: 48, stackPrimarySizing: "FIXED", stackChildAlignSelf: "STRETCH" }, home.guid));
  // The first copy changes the title, the label of the button inside it, and takes the size the layout computed.
  const first = placed(node("INSTANCE", "Scheda", { ...box(120, 48, 300, 200), stackChildPrimaryGrow: 1, symbolData: { symbolID: card.guid, symbolOverrides: [
    { guidPath: { guids: [KEY_TITLE] }, textData: { characters: "Vaso blu" } },
    { guidPath: { guids: [KEY_BUTTON, buttonText.guid] }, textData: { characters: "Compra" }, fillPaints: [solid("#ffffff")] },
  ] }, derivedSymbolData: [{ guidPath: { guids: [KEY_TITLE] }, size: { x: 268, y: 60 } }] }, cards.guid));
  const second = placed(node("INSTANCE", "Scheda", { ...box(452, 48, 300, 200), symbolData: { symbolID: card.guid, symbolOverrides: [{ guidPath: { guids: [KEY_BUTTON] }, visible: false }] } }, cards.guid));
  const orphan = placed(node("INSTANCE", "Persa", { ...box(784, 48, 300, 200), symbolData: { symbolID: guid(99999), symbolOverrides: [] } }, cards.guid));
  const icons = placed(node("FRAME", "Disegni", { ...box(0, 780, 1440, 120), stackChildAlignSelf: "STRETCH" }, home.guid));
  const arrow = placed(node("VECTOR", "Freccia", { ...box(120, 40, 24, 24), fillPaints: [solid("#111111")], fillGeometry: [{ windingRule: "ODD", commandsBlob: 0, styleID: 0 }] }, icons.guid));
  const turned = placed(node("VECTOR", "Freccia girata", { size: { x: 24, y: 24 }, transform: { m00: -1, m01: 0, m02: 224, m10: 0, m11: 1, m12: 40 }, fillPaints: [solid("#111111")], fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 0, styleID: 0 }] }, icons.guid));
  const rule = placed(node("LINE", "Filetto", { ...box(300, 60, 400, 0), strokePaints: [solid("#999999")], strokeWeight: 2, strokeGeometry: [{ windingRule: "NONZERO", commandsBlob: 1, styleID: 0 }] }, icons.guid));
  const broken = placed(node("VECTOR", "Rotto", { ...box(800, 40, 24, 24), fillPaints: [solid("#111111")], fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 2, styleID: 0 }] }, icons.guid));
  const group = placed(node("FRAME", "Tondo", { ...box(900, 20, 200, 100) }, icons.guid));
  const mask = placed(node("ELLIPSE", "Maschera", { ...box(50, 10, 80, 80), fillPaints: [solid("#000000")], mask: true }, group.guid));
  const masked = placed(node("ROUNDED_RECTANGLE", "Ritratto", { ...box(0, 0, 200, 100), fillPaints: [{ type: "IMAGE", opacity: 1, visible: true, image: { hash: IMAGE_HASH, name: "foto" } }] }, group.guid));
  const hidden = placed(node("FRAME", "Nascosto", { ...box(1200, 20, 100, 100), visible: false, fillPaints: [solid("#ff0000")] }, icons.guid));
  // Two frames with the same name at the top of the page.
  const twinA = placed(node("FRAME", "Doppio", { ...box(0, 2000, 400, 100), fillPaints: [solid("#ffffff")] }, SITE));
  const twinAText = placed(label("Testo", "Primo", 16, box(10, 10, 80, 24), twinA.guid));
  const twinB = placed(node("FRAME", "Doppio", { ...box(500, 2000, 400, 100), fillPaints: [solid("#ffffff")] }, SITE));
  const twinBText = placed(label("Testo", "Secondo", 16, box(10, 10, 80, 24), twinB.guid));
  return {
    nodes: [
      { guid: guid(0, 0), phase: "CREATED", type: "DOCUMENT", name: "Document" },
      { guid: INTERNAL, phase: "CREATED", parentIndex: { guid: guid(0, 0), position: "!" }, type: "CANVAS", name: "Internal Only Canvas", internalOnly: true },
      { guid: SITE, phase: "CREATED", parentIndex: { guid: guid(0, 0), position: "\"" }, type: "CANVAS", name: "Sito" },
      // Out of order on purpose: the reader sorts by position, not by where a node is in the file.
      twinBText, twinB, twinAText, twinA, hidden, masked, mask, group, broken, rule, turned, arrow, icons, orphan, second, first, cards, badge, photo, heroTitle, hero, link, logo, header, home, cardButton, cardTitle, card, set, buttonText, button,
    ],
    blobs: [pathBlob([[1, 0, 12], [2, 24, 12], [4, 20, 0, 20, 24, 12, 24], [0]]), pathBlob([[1, 0, -1], [2, 400, -1], [2, 400, 1], [2, 0, 1], [0]]), pathBlob([[1, 0, 0], [3, 1, 1, 2, 2]])],
    ids: { home: id(home), card: id(card), set: id(set), button: id(button), first: id(first), second: id(second), cardTitle: id(cardTitle), cardButton: id(cardButton), buttonText: id(buttonText), twinA: id(twinA), twinB: id(twinB) },
  };
}
/** The document of the page; give the nodes of one `siteNodes()` call to know their ids. */
export function siteCanvas(site = siteNodes()): Buffer {
  const { nodes, blobs } = site;
  return container(schemaBytes(DEFINITIONS), messageBytes(DEFINITIONS, "Message", { nodeChanges: nodes, blobs }));
}

export const HAS_ZSTD = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function";

export function zip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
    archive.end();
  });
}

