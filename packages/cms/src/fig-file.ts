/**
 * The library of a Figma file (note penpot-figma-a-histeon.md, phase 2): its colour, text and effect styles and its
 * variables, as a file of tokens that design-tokens.ts reads. Off the network: the file is read from the disk.
 *
 * A `.fig` saved from Figma («Save local copy») is a ZIP with `canvas.fig`, `meta.json`, a thumbnail and the images.
 * `canvas.fig` is decoded by fig-kiwi.ts into one message whose `nodeChanges` are all the layers of the file. A
 * style is a layer with `styleType` (it lives in a page only Figma sees); a variable is a layer of type `VARIABLE`
 * and its collection one of type `VARIABLE_SET`. Every field below is checked; when the file has a shape this reader
 * does not recognise, it says so in the report and converts nothing of it, never guessed.
 *
 * Node only (fig-kiwi.ts). No network, no credentials; nothing is written to disk.
 */

import type { TokenFile, TokenProblem } from "./design-tokens.js";
import { decodeKiwi, type KiwiRecord, type KiwiValue, readFigContainer, readKiwiSchema } from "./fig-kiwi.js";
import { putToken, tokenKey, tokenPath } from "./penpot-file.js";

export interface FigRgba {
  /** 0–255. */
  r: number;
  g: number;
  b: number;
  /** 0–1: the alpha of the colour times the opacity of the paint. */
  alpha: number;
}
export interface FigStyle {
  name: string;
  /** The groups of the name (`Colors/Primary/500`), outermost first. */
  path: string[];
  /** How many layers of the file use the style. */
  uses: number;
}
export interface FigFillStyle extends FigStyle {
  /** Null for a gradient, an image or more than one paint. */
  color: FigRgba | null;
}
export interface FigTextStyle extends FigStyle {
  fontFamily: string;
  /** The style of the font as Figma names it: `SemiBold`, `Bold Italic`. */
  fontStyle: string;
  fontSizePx: number | null;
  fontWeight: number | null;
  /** A multiplier of the font size, or pixels; null for the automatic line height. */
  lineHeight: { value: number; unit: "ratio" | "px" } | null;
}
export interface FigShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: FigRgba;
  inset: boolean;
}
export interface FigEffectStyle extends FigStyle {
  shadows: FigShadow[];
  /** The types of the effects that are not shadows (`BACKGROUND_BLUR`, `GLASS`…). */
  other: string[];
}
export type FigVariableValue = { color: FigRgba } | { number: number } | { text: string } | { boolean: boolean } | { alias: number } | null;
export interface FigVariable {
  name: string;
  path: string[];
  /** The index of its collection in `collections`. */
  collection: number;
  type: "color" | "number" | "text" | "boolean";
  /** Where Figma lets the variable be used: `CORNER_RADIUS`, `FONT_SIZE`, `GAP`… */
  scopes: string[];
  /** One value for each mode of the collection, in their order; `alias` is an index in `variables`. */
  values: FigVariableValue[];
}
export interface FigCollection {
  name: string;
  modes: string[];
}
export interface FigLibrary {
  name: string;
  /** The version of the format the file declares (77, 101…). */
  version: number;
  fills: FigFillStyle[];
  texts: FigTextStyle[];
  effects: FigEffectStyle[];
  /** Layout grid styles: counted, not read. */
  grids: number;
  collections: FigCollection[];
  variables: FigVariable[];
  pages: Array<{ name: string; layers: number }>;
  components: number;
  layers: number;
  problems: TokenProblem[];
}

/** The entries of a `.fig` archive this reader needs: the document and its name. Not the images, not the thumbnail. */
export function figFileEntry(name: string): boolean {
  return name === "canvas.fig" || name === "meta.json";
}

function record(value: KiwiValue | undefined): KiwiRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) ? value : null;
}
const list = (value: KiwiValue | undefined): KiwiValue[] => (Array.isArray(value) ? value : []);
const text = (value: KiwiValue | undefined): string => (typeof value === "string" ? value : "");
const number = (value: KiwiValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/** `sessionID:localID` of a GUID of the file; empty when it is not one. */
function guidOf(value: KiwiValue | undefined): string {
  const guid = record(value);
  return guid && number(guid.sessionID) !== null && number(guid.localID) !== null ? `${guid.sessionID}:${guid.localID}` : "";
}

/** A reference to a style or a variable: by GUID when it is of this file, by key when it came from a library. */
function refOf(value: KiwiValue | undefined): string {
  const ref = record(value);
  if (!ref) return "";
  const key = text(record(ref.assetRef)?.key);
  return guidOf(ref.guid) || (key ? `key:${key}` : "");
}

function rgbaOf(value: KiwiValue | undefined, opacity = 1): FigRgba | null {
  const color = record(value);
  if (!color) return null;
  const channels = [color.r, color.g, color.b, color.a].map(number);
  if (channels.some((channel) => channel === null)) return null;
  const byte = (channel: number) => Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return { r: byte(channels[0]!), g: byte(channels[1]!), b: byte(channels[2]!), alpha: round(Math.min(1, Math.max(0, channels[3]! * opacity)), 3) };
}

/** The readers of a decoded value, for the reader of the pages (fig-page.ts). */
export { guidOf as figGuid, list as figList, number as figNumber, record as figRecord, rgbaOf as figRgba, text as figText };

/** `Colors / Primary / 500` → the groups and the name. */
export function figStyleName(full: string): { name: string; path: string[] } {
  const parts = full.split("/").map((part) => part.trim()).filter(Boolean);
  return { name: parts.at(-1) ?? "", path: parts.slice(0, -1) };
}

/** One style for each name: of several with the same name the most used stays, and a different value is said. */
export function distinctFigStyles<T extends FigStyle>(styles: T[], valueOfStyle: (style: T) => unknown, what: string, problems: TokenProblem[]): T[] {
  const groups = new Map<string, T[]>();
  for (const style of styles) {
    const key = [...style.path, style.name].join(" / ");
    groups.set(key, [...(groups.get(key) ?? []), style]);
  }
  const kept: T[] = [];
  for (const [key, group] of groups) {
    const best = group.reduce((a, b) => (b.uses > a.uses ? b : a));
    const values = new Set(group.map((style) => JSON.stringify(valueOfStyle(style))));
    if (values.size > 1) problems.push({ token: key, why: `${group.length} stili ${what} con questo nome e ${values.size} valori diversi: tenuto il più usato` });
    kept.push(best);
  }
  return kept;
}

const VARIABLE_TYPES: Record<string, FigVariable["type"]> = { COLOR: "color", FLOAT: "number", STRING: "text", BOOLEAN: "boolean" };

/**
 * Reads the library from the bytes of `canvas.fig`. `name` is the name of the file, shown in the report. Throws a
 * TypeError, in Italian, when the bytes are not a Figma document; a single style or variable that cannot be read
 * goes to `problems` and the rest is read.
 */
export function readFigLibrary(canvas: Uint8Array, name: string): FigLibrary {
  const container = readFigContainer(canvas);
  const message = decodeKiwi(readKiwiSchema(container.schema), container.message, "Message");
  const nodes = list(message.nodeChanges).map(record).filter((node): node is KiwiRecord => node !== null && text(node.phase) !== "REMOVED");
  if (!nodes.some((node) => text(node.type) === "DOCUMENT")) throw new TypeError("Il file di Figma non si legge: non contiene un documento.");
  const problems: TokenProblem[] = [];

  // How many layers use each style: `styleIdForFill`, `styleIdForText`… and, in older files, `inherit…StyleID`.
  const uses = new Map<string, number>();
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      const ref = key.startsWith("styleIdFor") ? refOf(node[key]) : /^inherit\w*StyleID/u.test(key) ? guidOf(node[key]) : "";
      if (ref) uses.set(ref, (uses.get(ref) ?? 0) + 1);
    }
  }
  const usesOf = (node: KiwiRecord) => (uses.get(guidOf(node.guid)) ?? 0) + (text(node.key) ? (uses.get(`key:${text(node.key)}`) ?? 0) : 0);

  const fills: FigFillStyle[] = [];
  const texts: FigTextStyle[] = [];
  const effects: FigEffectStyle[] = [];
  let grids = 0;
  for (const node of nodes) {
    const styleType = text(node.styleType);
    if (!styleType || styleType === "NONE" || node.isSoftDeletedStyle === true) continue;
    const base = { ...figStyleName(text(node.name)), uses: usesOf(node) };
    if (!base.name) continue;
    if (styleType === "FILL") {
      const paints = list(node.fillPaints).map(record).filter((paint): paint is KiwiRecord => paint !== null && paint.visible !== false);
      const solid = paints.length === 1 && text(paints[0]!.type) === "SOLID" ? rgbaOf(paints[0]!.color, number(paints[0]!.opacity) ?? 1) : null;
      fills.push({ ...base, color: solid });
    } else if (styleType === "TEXT") {
      const font = record(node.fontName);
      const meta = list(record(node.derivedTextData)?.fontMetaData).map(record)[0];
      const weight = number(meta?.fontWeight);
      const leading = record(node.lineHeight);
      const leadingValue = number(leading?.value);
      const unit = text(leading?.units);
      // RAW is a multiplier of the font size, PIXELS a length; PERCENT 100 is the automatic line height.
      const lineHeight = leadingValue === null || leadingValue <= 0 ? null : unit === "RAW" ? { value: round(leadingValue), unit: "ratio" as const } : unit === "PIXELS" ? { value: round(leadingValue), unit: "px" as const } : null;
      if (unit === "PERCENT" && leadingValue !== null && Math.abs(leadingValue - 100) > 0.01) problems.push({ token: text(node.name), why: "interlinea in percentuale del carattere: non letta" });
      texts.push({
        ...base,
        fontFamily: text(font?.family).trim(),
        fontStyle: text(font?.style).trim(),
        fontSizePx: number(node.fontSize),
        fontWeight: weight !== null && Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? weight : null,
        lineHeight,
      });
    } else if (styleType === "EFFECT") {
      const shadows: FigShadow[] = [];
      const other: string[] = [];
      for (const effect of list(node.effects).map(record)) {
        if (!effect || effect.visible === false) continue;
        const type = text(effect.type);
        const offset = record(effect.offset);
        const color = rgbaOf(effect.color);
        const [x, y, blur, spread] = [offset?.x, offset?.y, effect.radius, effect.spread ?? 0].map(number);
        if ((type === "DROP_SHADOW" || type === "INNER_SHADOW") && color && x !== null && y !== null && blur !== null && spread !== null) {
          shadows.push({ x: round(x!, 2), y: round(y!, 2), blur: round(blur!, 2), spread: round(spread!, 2), color, inset: type === "INNER_SHADOW" });
        } else other.push(type || "?");
      }
      effects.push({ ...base, shadows, other });
    } else if (styleType === "GRID") grids += 1;
  }

  // Variables and their collections. A variable names its collection, and an alias its target, by GUID or by key.
  const collections: FigCollection[] = [];
  const collectionAt = new Map<string, number>();
  const modeIds: string[][] = [];
  for (const node of nodes) {
    if (text(node.type) !== "VARIABLE_SET") continue;
    const modes = list(node.variableSetModes).map(record).filter((mode): mode is KiwiRecord => mode !== null && guidOf(mode.id) !== "");
    if (!modes.length) continue;
    const at = collections.push({ name: text(node.name).trim() || "Raccolta", modes: modes.map((mode) => text(mode.name).trim() || "Modo") }) - 1;
    modeIds.push(modes.map((mode) => guidOf(mode.id)));
    collectionAt.set(guidOf(node.guid), at);
    if (text(node.key)) collectionAt.set(`key:${text(node.key)}`, at);
  }
  const variableNodes = nodes.filter((node) => text(node.type) === "VARIABLE" && node.isSoftDeleted !== true);
  const variableAt = new Map<string, number>();
  const kept: KiwiRecord[] = [];
  for (const node of variableNodes) {
    const collection = collectionAt.get(refOf(node.variableSetID));
    const type = VARIABLE_TYPES[text(node.variableResolvedType)];
    if (collection === undefined || !type || !figStyleName(text(node.name)).name) {
      problems.push({ token: text(node.name) || "variabile senza nome", why: collection === undefined ? "variabile senza la sua raccolta: non letta" : "variabile di un tipo non convertito" });
      continue;
    }
    variableAt.set(guidOf(node.guid), kept.length);
    if (text(node.key)) variableAt.set(`key:${text(node.key)}`, kept.length);
    kept.push(node);
  }
  const variables: FigVariable[] = kept.map((node) => {
    const collection = collectionAt.get(refOf(node.variableSetID))!;
    const entries = list(record(node.variableDataValues)?.entries).map(record).filter((entry): entry is KiwiRecord => entry !== null);
    const values = modeIds[collection]!.map((mode, index): FigVariableValue => {
      // A value for each mode; a file with one mode may not name it.
      const entry = entries.find((item) => guidOf(item.modeID) === mode) ?? (index === 0 && modeIds[collection]!.length === 1 ? entries[0] : undefined);
      const value = record(record(entry?.variableData)?.value);
      if (!value) return null;
      if (record(value.alias)) {
        const target = variableAt.get(refOf(value.alias));
        return target === undefined ? null : { alias: target };
      }
      const color = rgbaOf(value.colorValue);
      if (color) return { color };
      if (number(value.floatValue) !== null) return { number: round(number(value.floatValue)!) };
      if (typeof value.textValue === "string") return { text: value.textValue };
      return typeof value.boolValue === "boolean" ? { boolean: value.boolValue } : null;
    });
    return { ...figStyleName(text(node.name)), collection, type: VARIABLE_TYPES[text(node.variableResolvedType)]!, scopes: list(node.variableScopes).map(text).filter(Boolean), values };
  });

  // Pages and their layers: a layer belongs to the page its parents lead to.
  const parent = new Map<string, string>();
  for (const node of nodes) parent.set(guidOf(node.guid), guidOf(record(node.parentIndex)?.guid));
  const pageAt = new Map<string, number>();
  const pages: FigLibrary["pages"] = [];
  for (const node of nodes) {
    if (text(node.type) !== "CANVAS" || node.internalOnly === true) continue;
    pageAt.set(guidOf(node.guid), pages.push({ name: text(node.name).trim() || "Pagina", layers: 0 }) - 1);
  }
  for (const node of nodes) {
    let at = parent.get(guidOf(node.guid)) ?? "";
    for (let depth = 0; at && depth < 512 && !pageAt.has(at); depth += 1) at = parent.get(at) ?? "";
    const page = pageAt.get(at);
    if (page !== undefined) pages[page]!.layers += 1;
  }

  return {
    name,
    version: container.version,
    fills: distinctFigStyles(fills, (style) => style.color, "di colore", problems),
    texts: distinctFigStyles(texts, (style) => [style.fontFamily, style.fontStyle, style.fontSizePx, style.lineHeight], "di testo", problems),
    effects: distinctFigStyles(effects, (style) => [style.shadows, style.other], "di effetto", problems),
    grids,
    collections,
    variables,
    pages,
    components: nodes.filter((node) => text(node.type) === "SYMBOL").length,
    layers: pages.reduce((sum, page) => sum + page.layers, 0),
    problems,
  };
}

/** The name of the file from `meta.json` of the archive; empty when it is not there. */
export function figFileName(meta: Uint8Array | undefined): string {
  if (!meta || meta.byteLength > 1024 * 1024) return "";
  try {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(meta));
    const name = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).file_name : "";
    return typeof name === "string" ? name.trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}

/** A colour for a token file: `#rrggbb`, or with its alpha the object form of the standard (two hex digits would round it). */
function colorValue(color: FigRgba): unknown {
  const hex = `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  return color.alpha >= 0.999 ? hex : { colorSpace: "srgb", components: [color.r / 255, color.g / 255, color.b / 255], alpha: color.alpha, hex };
}
const DARK_WORDS = ["dark", "scuro", "night", "notte"];
const isDark = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/u).some((word) => DARK_WORDS.includes(word));

/** The type of a number or a text variable, from where Figma lets it be used; empty when its scopes do not agree. */
const SCOPE_TYPES: Record<string, string> = {
  CORNER_RADIUS: "borderRadius",
  FONT_SIZE: "fontSizes",
  GAP: "spacing",
  WIDTH_HEIGHT: "sizing",
  STROKE_FLOAT: "borderWidth",
  LETTER_SPACING: "letterSpacing",
  FONT_WEIGHT: "fontWeights",
  FONT_STYLE: "fontWeights",
  FONT_FAMILY: "fontFamilies",
  OPACITY: "opacity",
};
function scopeType(variable: FigVariable): string {
  const types = new Set(variable.scopes.map((scope) => SCOPE_TYPES[scope] ?? ""));
  const only = types.size === 1 ? [...types][0]! : "";
  // A text is a font or a weight, never a length.
  return variable.type === "text" && only !== "fontFamilies" && only !== "fontWeights" ? "" : only;
}

/**
 * The library as one file of token sets, for `readDesignTokens`: the styles in a set of their own, then for each
 * collection of variables its first mode that is not dark, and its dark mode in a set only the dark theme switches
 * on (a variable wins over a style of the same name). What cannot become a token goes to `problems`.
 */
export function figTokenFiles(library: FigLibrary): { files: TokenFile[]; problems: TokenProblem[] } {
  const problems: TokenProblem[] = [];
  const styles: Record<string, unknown> = {};
  let count = 0;
  for (const style of library.fills) {
    if (!style.color) {
      problems.push({ token: [...style.path, style.name].join(" / "), why: "stile di colore con sfumatura, immagine o più riempimenti: non è un token" });
      continue;
    }
    putToken(styles, tokenPath("color", style.path, style.name), { $type: "color", $value: colorValue(style.color) });
    count += 1;
  }
  for (const style of library.texts) {
    if (!style.fontFamily || style.fontSizePx === null) {
      problems.push({ token: [...style.path, style.name].join(" / "), why: "stile di testo senza carattere o senza misura" });
      continue;
    }
    const value: Record<string, unknown> = { fontFamily: style.fontFamily, fontSize: { value: round(style.fontSizePx), unit: "px" } };
    // The weight Figma computed; otherwise the name of the font style («SemiBold»), which the reader knows.
    if (style.fontWeight !== null || style.fontStyle) value.fontWeight = style.fontWeight ?? style.fontStyle;
    if (style.lineHeight) value.lineHeight = style.lineHeight.unit === "px" ? { value: style.lineHeight.value, unit: "px" } : style.lineHeight.value;
    putToken(styles, tokenPath("typography", style.path, style.name), { $type: "typography", $value: value });
    count += 1;
  }
  for (const style of library.effects) {
    const label = [...style.path, style.name].join(" / ");
    if (style.other.length) problems.push({ token: label, why: `effetti non convertiti: ${[...new Set(style.other)].join(", ")}` });
    if (!style.shadows.length) continue;
    putToken(styles, tokenPath("shadow", style.path, style.name), {
      $type: "shadow",
      $value: style.shadows.map((shadow) => ({ color: colorValue(shadow.color), offsetX: shadow.x, offsetY: shadow.y, blur: shadow.blur, spread: shadow.spread, ...(shadow.inset ? { inset: true } : {}) })),
    });
    count += 1;
  }

  // Where each variable goes: its groups and name; with the collection first when two collections share the name.
  const plainPath = (variable: FigVariable) => [...(variable.type === "color" ? ["color"] : []), ...variable.path.map(tokenKey), tokenKey(variable.name)];
  const owners = new Map<string, Set<number>>();
  for (const variable of library.variables) {
    const key = plainPath(variable).join(".").toLowerCase();
    owners.set(key, (owners.get(key) ?? new Set()).add(variable.collection));
  }
  const paths = library.variables.map((variable) => {
    const path = plainPath(variable);
    if ((owners.get(path.join(".").toLowerCase())?.size ?? 0) < 2) return path;
    const collection = tokenKey(library.collections[variable.collection]!.name);
    return variable.type === "color" ? ["color", collection, ...path.slice(1)] : [collection, ...path];
  });

  // The type of each variable: its own, or the one of the variables that point at it when they agree («Plain», a
  // text with no scope, is a font family because «Title/Font» points at it).
  const types = library.variables.map((variable) => (variable.type === "color" ? "color" : scopeType(variable)));
  const pointers = library.variables.map((): number[] => []);
  library.variables.forEach((variable, index) => {
    for (const value of variable.values) if (value && "alias" in value && !pointers[value.alias]!.includes(index)) pointers[value.alias]!.push(index);
  });
  for (let pass = 0; pass < 4; pass += 1) {
    types.forEach((type, index) => {
      if (type) return;
      const wanted = new Set(pointers[index]!.map((from) => types[from]!).filter(Boolean));
      if (wanted.size === 1) types[index] = [...wanted][0]!;
    });
  }

  const sets: Array<{ name: string; dark: boolean; tree: Record<string, unknown> }> = [];
  const taken = new Set<string>();
  const setName = (wanted: string) => {
    let name = tokenKey(wanted);
    for (let n = 2; taken.has(name); n += 1) name = `${tokenKey(wanted)} ${n}`;
    taken.add(name);
    return name;
  };
  if (count) sets.push({ name: setName("Stili"), dark: false, tree: styles });
  const refused = new Set<number>();
  library.collections.forEach((collection, at) => {
    const base = Math.max(0, collection.modes.findIndex((mode) => !isDark(mode)));
    const dark = collection.modes.findIndex((mode, index) => index !== base && isDark(mode));
    const left = collection.modes.filter((_, index) => index !== base && index !== dark);
    if (left.length) problems.push({ token: collection.name, why: `raccolta di variabili: letto il modo «${collection.modes[base]}»${dark >= 0 ? ` e, per il tema scuro, «${collection.modes[dark]}»` : ""}; non letti: ${left.map((mode) => `«${mode}»`).join(", ")}` });
    for (const mode of dark >= 0 ? [base, dark] : [base]) {
      const tree: Record<string, unknown> = {};
      let size = 0;
      library.variables.forEach((variable, index) => {
        if (variable.collection !== at) return;
        const label = [...variable.path, variable.name].join(" / ");
        const refuse = (why: string) => {
          if (!refused.has(index)) problems.push({ token: label, why });
          refused.add(index);
        };
        const value = variable.values[mode] ?? null;
        if (variable.type === "boolean") {
          refuse("variabile vero o falso: non è un token di stile");
          return;
        }
        if (!value) {
          if (mode === base) refuse("variabile senza un valore letto, o che rimanda a una variabile che non è nel file");
          return;
        }
        const type = types[index] || (variable.type === "number" ? "number" : "string");
        if ("alias" in value) {
          if (library.variables[value.alias]!.type === "boolean") {
            refuse("rimanda a una variabile vero o falso");
            return;
          }
          putToken(tree, paths[index]!, { $type: type, $value: `{${paths[value.alias]!.join(".")}}` });
        } else if ("color" in value) putToken(tree, paths[index]!, { $type: type, $value: colorValue(value.color) });
        else if ("number" in value) putToken(tree, paths[index]!, { $type: type, $value: value.number });
        else if ("text" in value) putToken(tree, paths[index]!, { $type: type, $value: value.text });
        else {
          refuse("valore di un tipo non convertito");
          return;
        }
        size += 1;
      });
      if (size) sets.push({ name: setName(mode === base ? collection.name : `${collection.name} (${collection.modes[mode]})`), dark: mode !== base, tree });
    }
  });
  if (!sets.length) return { files: [], problems };

  const light = sets.filter((set) => !set.dark).map((set) => set.name);
  const all = [...light, ...sets.filter((set) => set.dark).map((set) => set.name)];
  const enabled = (names: string[]) => Object.fromEntries(names.map((name) => [name, "enabled"]));
  const document: Record<string, unknown> = {};
  for (const set of sets) document[set.name] = set.tree;
  document.$themes = [{ id: "light", name: "Light", selectedTokenSets: enabled(light) }, ...(all.length > light.length ? [{ id: "dark", name: "Dark", selectedTokenSets: enabled(all) }] : [])];
  document.$metadata = { tokenSetOrder: all };
  return { files: [{ name: `${library.name || "Figma"}: stili e variabili`, text: JSON.stringify(document) }], problems };
}
