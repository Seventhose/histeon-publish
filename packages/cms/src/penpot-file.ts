/**
 * The library of a `.penpot` file (note penpot-figma-a-histeon.md, phase 2): its colours, its typographies and its
 * design tokens, as files of tokens that design-tokens.ts reads.
 *
 * A `.penpot` (export version 3 of Penpot, and the files the Figma exporter plugin writes) is a ZIP of JSON files:
 * `manifest.json`, `files/<id>.json`, and under `files/<id>/` one JSON per colour, typography, component, page and
 * shape, plus `tokens.json` when the file has tokens. Penpot documents the format but does not promise it is stable:
 * every field is checked, and what is not understood is reported, never guessed.
 *
 * Pure: it receives the entries already read (design-zip.ts) and returns data. No network, no credentials.
 */

import type { TokenFile, TokenProblem } from "./design-tokens.js";

export interface PenpotColor {
  id: string;
  name: string;
  /** The groups of the library, outermost first. */
  path: string[];
  /** `#rrggbb`, or null for a gradient or an image. */
  hex: string | null;
  opacity: number;
}

export interface PenpotTypography {
  id: string;
  name: string;
  path: string[];
  fontFamily: string;
  fontSizePx: number | null;
  fontWeight: number | null;
  /** A multiplier of the font size, as Penpot keeps it. */
  lineHeight: number | null;
  letterSpacingPx: number | null;
  fontStyle: string;
  textTransform: string;
}

export interface PenpotLibrary {
  /** The name of the first file of the export. */
  name: string;
  /** `penpot/2.5.4`, or the library of the Figma exporter plugin. */
  generatedBy: string;
  /** The file was written by the plugin that exports from Figma to Penpot. */
  fromFigma: boolean;
  files: Array<{ id: string; name: string }>;
  colors: PenpotColor[];
  typographies: PenpotTypography[];
  components: Array<{ id: string; name: string; path: string[] }>;
  pages: Array<{ id: string; fileId: string; name: string; shapes: number }>;
  /** `tokens.json` of the files that have tokens, as it is: the format Penpot exports (Tokens Studio). */
  tokens: TokenFile[];
  problems: TokenProblem[];
}

/** What a reader of the entries gives: design-zip.ts, or a map made by hand in a test. */
export interface PenpotEntries {
  names: ReadonlyArray<{ name: string; size: number }>;
  files: ReadonlyMap<string, Uint8Array>;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LIBRARY_ENTRY = new RegExp(`^files/${UUID}(?:\\.json|/(?:colors|typographies|components)/${UUID}\\.json|/tokens\\.json|/pages/${UUID}\\.json)$`, "u");
const SHAPE_ENTRY = new RegExp(`^files/(${UUID})/pages/(${UUID})/${UUID}\\.json$`, "u");
/** One JSON of the library is small; a larger one is not what this reader expects. */
const LIBRARY_ENTRY_MAX = 8 * 1024 * 1024;

/** The entries the library needs: the manifest, the files, their colours, typographies, components, pages and tokens. Not the shapes, not the media. */
export function penpotLibraryEntry(name: string, size: number): boolean {
  return size <= LIBRARY_ENTRY_MAX && (name === "manifest.json" || LIBRARY_ENTRY.test(name));
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A number Penpot wrote as a number or as a text (`"16"`); null for anything else. */
function numberOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** The groups of a library path (`"Remote / Gradient / Black"`), without the mark the Figma exporter adds for styles of another library. */
function groups(path: unknown): string[] {
  return text(path).split("/").map((part) => part.trim()).filter((part) => part && part.toLowerCase() !== "remote");
}

/** A name that can be a key of a token file: no dot, no brace, no leading `$`, at most 80 characters. */
export function tokenKey(name: string): string {
  const cleaned = [...name].map((char) => (".{}$".includes(char) || char.charCodeAt(0) < 32 ? " " : char)).join("").replace(/\s+/gu, " ").trim().slice(0, 80);
  return cleaned || "senza nome";
}

function wordsOf(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

/**
 * Reads the library from the entries of the archive. Throws a TypeError when the archive is not an export of Penpot;
 * a single entry that cannot be read goes to `problems` and the rest is read.
 */
export function readPenpotLibrary(entries: PenpotEntries): PenpotLibrary {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const problems: TokenProblem[] = [];
  const json = (name: string): Record<string, unknown> | null => {
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
  const files = manifest.files.filter(plain).map((file) => ({ id: text(file.id), name: text(file.name) })).filter((file) => new RegExp(`^${UUID}$`, "u").test(file.id));
  if (!files.length) throw new TypeError("L'esportazione di Penpot non contiene file.");
  const library: PenpotLibrary = {
    name: files[0]!.name || "Senza nome",
    generatedBy: text(manifest.generatedBy),
    fromFigma: /penpot-exporter-figma/u.test(text(manifest.referer)),
    files,
    colors: [],
    typographies: [],
    components: [],
    pages: [],
    tokens: [],
    problems,
  };
  const known = new Set(files.map((file) => file.id));
  const shapes = new Map<string, number>();
  for (const { name } of entries.names) {
    const shape = SHAPE_ENTRY.exec(name);
    if (shape) shapes.set(`${shape[1]}/${shape[2]}`, (shapes.get(`${shape[1]}/${shape[2]}`) ?? 0) + 1);
  }
  for (const { name } of entries.names) {
    const parts = name.split("/");
    if (parts[0] !== "files" || !known.has(parts[1] ?? "") || !entries.files.has(name)) continue;
    const fileId = parts[1]!;
    if (parts.length === 3 && parts[2] === "tokens.json") {
      const data = json(name);
      // A file without tokens still has the sets, empty: nothing to read there.
      if (data && Object.entries(data).some(([key, value]) => !key.startsWith("$") && plain(value) && Object.keys(value).length > 0)) {
        library.tokens.push({ name: `${files.find((file) => file.id === fileId)?.name || fileId}: tokens.json`, text: decoder.decode(entries.files.get(name)!) });
      }
      continue;
    }
    if (parts.length !== 4) continue;
    const data = json(name);
    if (!data) continue;
    const id = text(data.id) || parts[3]!.replace(/\.json$/u, "");
    const itemName = text(data.name).trim();
    if (parts[2] === "colors") {
      const hex = /^#[0-9a-f]{6}$/iu.test(text(data.color)) ? text(data.color).toLowerCase() : null;
      const opacity = numberOf(data.opacity);
      library.colors.push({ id, name: itemName, path: groups(data.path), hex, opacity: opacity === null ? 1 : Math.min(1, Math.max(0, opacity)) });
    } else if (parts[2] === "typographies") {
      library.typographies.push({
        id,
        name: itemName,
        path: groups(data.path),
        fontFamily: text(data.fontFamily).trim(),
        fontSizePx: numberOf(data.fontSize),
        fontWeight: numberOf(data.fontWeight),
        lineHeight: numberOf(data.lineHeight),
        letterSpacingPx: numberOf(data.letterSpacing),
        fontStyle: text(data.fontStyle),
        textTransform: text(data.textTransform),
      });
    } else if (parts[2] === "components") {
      library.components.push({ id, name: itemName, path: groups(data.path) });
    } else if (parts[2] === "pages") {
      library.pages.push({ id, fileId, name: itemName, shapes: shapes.get(`${fileId}/${id}`) ?? 0 });
    }
  }
  return library;
}

/** Where a library item goes in the token file: its groups, without those its own name already says, then its name. */
export function tokenPath(root: string, path: readonly string[], name: string): string[] {
  const own = new Set(wordsOf(name));
  const kept = path.filter((group) => !wordsOf(group).every((word) => own.has(word)));
  return [root, ...kept.map(tokenKey), tokenKey(name)];
}

/** Puts a token in the tree of a token file, under its groups; a group and a token of the same name both stay. */
export function putToken(tree: Record<string, unknown>, path: readonly string[], token: Record<string, unknown>): void {
  let node = tree;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    // A group with the name of a token: the token stays, the group gets a name of its own.
    if (plain(next) && !("$value" in next)) node = next;
    else {
      const fresh: Record<string, unknown> = {};
      node[next === undefined ? key : `${key} (gruppo)`] = fresh;
      node = fresh;
    }
  }
  const last = path.at(-1)!;
  const there = node[last];
  node[plain(there) && !("$value" in there) ? `${last} (stile)` : last] = token;
}

/**
 * The library as files of design tokens, for `readDesignTokens`: first the colours and the typographies of the
 * library as one DTCG document made here, then each `tokens.json` as Penpot wrote it (a token wins over a library
 * style of the same name). What cannot become a token (a gradient, a typography without a font) goes to `problems`.
 */
export function penpotTokenFiles(library: PenpotLibrary): { files: TokenFile[]; problems: TokenProblem[] } {
  const problems: TokenProblem[] = [];
  const tree: Record<string, unknown> = {};
  let count = 0;
  for (const color of library.colors) {
    if (!color.name) continue;
    if (!color.hex) {
      problems.push({ token: [...color.path, color.name].join(" / "), why: "colore della libreria con sfumatura o immagine: non è un token" });
      continue;
    }
    const alpha = Math.round(color.opacity * 255).toString(16).padStart(2, "0");
    putToken(tree, tokenPath("color", color.path, color.name), { $type: "color", $value: color.opacity >= 0.999 ? color.hex : `${color.hex}${alpha}` });
    count += 1;
  }
  for (const typography of library.typographies) {
    if (!typography.name) continue;
    if (!typography.fontFamily || typography.fontSizePx === null) {
      problems.push({ token: [...typography.path, typography.name].join(" / "), why: "tipografia della libreria senza carattere o senza misura" });
      continue;
    }
    const value: Record<string, unknown> = { fontFamily: typography.fontFamily, fontSize: { value: typography.fontSizePx, unit: "px" } };
    if (typography.fontWeight !== null) value.fontWeight = typography.fontWeight;
    if (typography.lineHeight !== null) value.lineHeight = typography.lineHeight;
    putToken(tree, tokenPath("typography", typography.path, typography.name), { $type: "typography", $value: value });
    count += 1;
  }
  const files: TokenFile[] = [];
  if (count) files.push({ name: `${library.name}: libreria`, text: JSON.stringify(tree) });
  files.push(...library.tokens);
  return { files, problems };
}
