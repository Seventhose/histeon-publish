/**
 * The library of a Figma file read from the REST API of Figma (note penpot-figma-a-histeon.md, phase 2): the answers
 * of `GET /v1/files/:key`, of `…/nodes` for the styles and of `…/variables/local` become the same `FigLibrary` the
 * reader of a `.fig` file gives (fig-file.ts), and from there the same files of tokens.
 *
 * Pure: it receives what was answered, already parsed. The requests are made by whoever passes the `FigmaSource`
 * (packages/core/src/figma.ts); no token is seen here, nothing is written.
 */

import type { DesignFileTokens } from "./design-file.js";
import type { TokenProblem } from "./design-tokens.js";
import {
  distinctFigStyles,
  type FigCollection,
  type FigEffectStyle,
  type FigFillStyle,
  type FigLibrary,
  type FigRgba,
  type FigShadow,
  figStyleName,
  type FigTextStyle,
  figTokenFiles,
  type FigVariable,
  type FigVariableValue,
} from "./fig-file.js";

/** What reads a file of Figma from its API. `localVariables` answers null when the plan does not give them. */
export interface FigmaSource {
  file(key: string, signal?: AbortSignal): Promise<unknown>;
  nodes(key: string, ids: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown>>;
  localVariables(key: string, signal?: AbortSignal): Promise<unknown | null>;
}

/** The most layers walked in one file: beyond, the counts stop and the report says so. */
const LAYERS_MAX = 2_000_000;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

function rgbaOf(value: unknown, opacity = 1): FigRgba | null {
  const color = record(value);
  if (!color) return null;
  const channels = [color.r, color.g, color.b, color.a ?? 1].map(number);
  if (channels.some((channel) => channel === null)) return null;
  const byte = (channel: number) => Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return { r: byte(channels[0]!), g: byte(channels[1]!), b: byte(channels[2]!), alpha: round(Math.min(1, Math.max(0, channels[3]! * opacity)), 3) };
}

function fillOf(node: Json): FigRgba | null {
  const paints = list(node.fills).map(record).filter((paint): paint is Json => paint !== null && paint.visible !== false);
  return paints.length === 1 && text(paints[0]!.type) === "SOLID" ? rgbaOf(paints[0]!.color, number(paints[0]!.opacity) ?? 1) : null;
}

function textOf(node: Json, problems: TokenProblem[], label: string): Omit<FigTextStyle, "name" | "path" | "uses"> {
  const style = record(node.style) ?? {};
  const unit = text(style.lineHeightUnit);
  const px = number(style.lineHeightPx);
  const percent = number(style.lineHeightPercentFontSize);
  // PIXELS is a length, FONT_SIZE_% a multiplier of the font size; INTRINSIC_% is the automatic line height.
  const lineHeight = unit === "PIXELS" && px !== null && px > 0 ? { value: round(px), unit: "px" as const }
    : unit === "FONT_SIZE_%" && percent !== null && percent > 0 ? { value: round(percent / 100), unit: "ratio" as const }
      : null;
  if (unit && unit !== "PIXELS" && unit !== "FONT_SIZE_%" && unit !== "INTRINSIC_%") problems.push({ token: label, why: "interlinea in un’unità non conosciuta: non letta" });
  const weight = number(style.fontWeight);
  const postScript = text(style.fontPostScriptName);
  const cut = postScript.lastIndexOf("-");
  return {
    fontFamily: text(style.fontFamily).trim(),
    fontStyle: (cut > 0 ? postScript.slice(cut + 1) : style.italic === true ? "Italic" : "").trim(),
    fontSizePx: number(style.fontSize),
    fontWeight: weight !== null && Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? weight : null,
    lineHeight,
  };
}

function effectsOf(node: Json): { shadows: FigShadow[]; other: string[] } {
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
  return { shadows, other };
}

const VARIABLE_TYPES: Record<string, FigVariable["type"]> = { COLOR: "color", FLOAT: "number", STRING: "text", BOOLEAN: "boolean" };

/** The ids of the styles of a file answer, for the request of their nodes. */
export function figmaStyleIds(file: unknown): string[] {
  return Object.keys(record(record(file)?.styles) ?? {});
}

/**
 * The library from the answers of the API. `styleNodes` are the nodes of the styles by id (each `{ document }`);
 * a style without its node takes its value from the first layer that uses it. `variables` is the answer of
 * `variables/local`, or null. Throws a TypeError, in Italian, when `file` is not a file of Figma.
 */
export function figmaApiLibrary(file: unknown, styleNodes: Record<string, unknown>, variables: unknown | null): FigLibrary {
  const root = record(file);
  const document = record(root?.document);
  if (!root || !document || text(document.type) !== "DOCUMENT") throw new TypeError("La risposta di Figma non è un file: manca il documento.");
  const problems: TokenProblem[] = [];
  const styles = record(root.styles) ?? {};

  // One walk: the layers of each page, the components, how many layers use each style and the first that does.
  const uses = new Map<string, number>();
  const firstUser = new Map<string, Json>();
  const pages: FigLibrary["pages"] = [];
  let components = 0;
  let walked = 0;
  for (const page of list(document.children).map(record)) {
    if (!page || text(page.type) !== "CANVAS") continue;
    const entry = { name: text(page.name).trim() || "Pagina", layers: 0 };
    pages.push(entry);
    const stack: unknown[] = [...list(page.children)];
    while (stack.length && walked < LAYERS_MAX) {
      const node = record(stack.pop());
      if (!node) continue;
      walked += 1;
      entry.layers += 1;
      const type = text(node.type);
      if (type === "COMPONENT") components += 1;
      for (const [role, id] of Object.entries(record(node.styles) ?? {})) {
        if (typeof id !== "string") continue;
        uses.set(id, (uses.get(id) ?? 0) + 1);
        const wanted = text(record(styles[id])?.styleType);
        // The value of a style is on a layer only in the place the style is used for: a text style on a text layer.
        if (!firstUser.has(id) && ((wanted === "FILL" && (role === "fill" || role === "fills")) || (wanted === "TEXT" && role === "text" && type === "TEXT") || (wanted === "EFFECT" && role === "effect"))) firstUser.set(id, node);
      }
      for (const child of list(node.children)) stack.push(child);
    }
  }
  if (walked >= LAYERS_MAX) problems.push({ token: text(root.name) || "file", why: `più di ${LAYERS_MAX} livelli: il conteggio si è fermato` });

  const fills: FigFillStyle[] = [];
  const texts: FigTextStyle[] = [];
  const effects: FigEffectStyle[] = [];
  let grids = 0;
  for (const [id, raw] of Object.entries(styles)) {
    const meta = record(raw);
    const styleType = text(meta?.styleType);
    const base = { ...figStyleName(text(meta?.name)), uses: uses.get(id) ?? 0 };
    if (!meta || !base.name) continue;
    const label = [...base.path, base.name].join(" / ");
    const node = record(record(styleNodes[id])?.document) ?? firstUser.get(id) ?? null;
    if (styleType === "GRID") {
      grids += 1;
      continue;
    }
    if (styleType !== "FILL" && styleType !== "TEXT" && styleType !== "EFFECT") continue;
    if (!node) {
      problems.push({ token: label, why: "stile di una libreria esterna che nessun livello usa: l’API non ne dà il valore" });
      continue;
    }
    if (styleType === "FILL") fills.push({ ...base, color: fillOf(node) });
    else if (styleType === "TEXT") texts.push({ ...base, ...textOf(node, problems, label) });
    else effects.push({ ...base, ...effectsOf(node) });
  }

  const collections: FigCollection[] = [];
  const modeIds: string[][] = [];
  const collectionAt = new Map<string, number>();
  const meta = record(record(variables)?.meta);
  for (const [id, raw] of Object.entries(record(meta?.variableCollections) ?? {})) {
    const collection = record(raw);
    const modes = list(collection?.modes).map(record).filter((mode): mode is Json => mode !== null && text(mode.modeId) !== "");
    if (!collection || !modes.length) continue;
    collectionAt.set(id, collections.push({ name: text(collection.name).trim() || "Raccolta", modes: modes.map((mode) => text(mode.name).trim() || "Modo") }) - 1);
    modeIds.push(modes.map((mode) => text(mode.modeId)));
  }
  const kept: Array<{ id: string; variable: Json }> = [];
  const variableAt = new Map<string, number>();
  for (const [id, raw] of Object.entries(record(meta?.variables) ?? {})) {
    const variable = record(raw);
    if (!variable || variable.deletedButReferenced === true) continue;
    const collection = collectionAt.get(text(variable.variableCollectionId));
    const type = VARIABLE_TYPES[text(variable.resolvedType)];
    if (collection === undefined || !type || !figStyleName(text(variable.name)).name) {
      problems.push({ token: text(variable.name) || "variabile senza nome", why: collection === undefined ? "variabile senza la sua raccolta: non letta" : "variabile di un tipo non convertito" });
      continue;
    }
    variableAt.set(id, kept.length);
    kept.push({ id, variable });
  }
  const libraryVariables: FigVariable[] = kept.map(({ variable }) => {
    const collection = collectionAt.get(text(variable.variableCollectionId))!;
    const byMode = record(variable.valuesByMode) ?? {};
    const values = modeIds[collection]!.map((mode): FigVariableValue => {
      const value = Object.hasOwn(byMode, mode) ? byMode[mode] : undefined;
      const alias = record(value);
      if (alias && text(alias.type) === "VARIABLE_ALIAS") {
        const target = variableAt.get(text(alias.id));
        return target === undefined ? null : { alias: target };
      }
      const color = rgbaOf(value);
      if (color) return { color };
      if (number(value) !== null) return { number: round(number(value)!) };
      if (typeof value === "string") return { text: value };
      return typeof value === "boolean" ? { boolean: value } : null;
    });
    return { ...figStyleName(text(variable.name)), collection, type: VARIABLE_TYPES[text(variable.resolvedType)]!, scopes: list(variable.scopes).map(text).filter(Boolean), values };
  });

  return {
    name: text(root.name).trim() || "File di Figma",
    version: 0,
    fills: distinctFigStyles(fills, (style) => style.color, "di colore", problems),
    texts: distinctFigStyles(texts, (style) => [style.fontFamily, style.fontStyle, style.fontSizePx, style.lineHeight], "di testo", problems),
    effects: distinctFigStyles(effects, (style) => [style.shadows, style.other], "di effetto", problems),
    grids,
    collections,
    variables: libraryVariables,
    pages,
    components,
    layers: pages.reduce((sum, page) => sum + page.layers, 0),
    problems,
  };
}

/**
 * The tokens of a file of Figma read from its API: three kinds of request (the file, the nodes of its styles, its
 * variables). Without the variables (the API gives them to Enterprise plans only) the styles are read and the report
 * says how to get the variables. Throws a TypeError, in Italian, for a file with neither styles nor variables;
 * the errors of the source pass as they are.
 */
export async function figmaApiTokens(source: FigmaSource, key: string, signal?: AbortSignal): Promise<DesignFileTokens> {
  const file = await source.file(key, signal);
  const ids = figmaStyleIds(file);
  const styleNodes = ids.length ? await source.nodes(key, ids, signal) : {};
  const variables = await source.localVariables(key, signal);
  const library = figmaApiLibrary(file, styleNodes, variables);
  const { files, problems } = figTokenFiles(library);
  const noVariables: TokenProblem[] = variables === null
    ? [{ token: "Variabili", why: "l’API di Figma le dà solo ai piani Enterprise: esporta i modi delle variabili da Figma, o salva il file .fig e importa quello" }]
    : [];
  const summary = `${library.name}: file di Figma letto dall’API, ${many(library.fills.length, "stile di colore", "stili di colore")}, ${many(library.texts.length, "stile di testo", "stili di testo")}, ${many(library.effects.length, "stile di effetto", "stili di effetto")}, ${variables === null ? "variabili non date dall’API" : `${many(library.variables.length, "variabile", "variabili")} in ${many(library.collections.length, "raccolta", "raccolte")}`}, ${many(library.components, "componente", "componenti")}, ${many(library.pages.length, "pagina", "pagine")}. Pagine e componenti non si convertono qui.`;
  if (!files.length) throw new TypeError(`${library.name}: il file di Figma non ha stili${variables === null ? " (e l’API non dà le sue variabili: salva il file .fig e importa quello)" : " né variabili"}.`);
  return { kind: "figma", files, problems: [...noVariables, ...library.problems, ...problems], summary };
}
