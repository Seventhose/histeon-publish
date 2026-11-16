import { canonicalizeJson, type JsonValue } from "@histos-publish/histos-contract";
import { computeHistosTokens, HISTOS_DESIGN_DEFAULTS, histosDarkTokens, printedHistosTokens, validateHistosDesign } from "../src/histos-design.js";
import type { StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * V5.7, «pagina aggiunta»: whose colours a page added to a site shows. The conversion writes the page's brand colours as
 * the framework's variables (`#fe0` → `var(--xb-primary)`, css-cleanup.ts), and the site's values win: the page takes
 * the site's colours. The caller asks, and says the answer in `addPage.colors`:
 * - `sito` (also when `colors` is missing): the page takes the site's colours, as before V5.7;
 * - `pagina`: the page keeps its own colours: the variables the conversion wrote go back to the page's values, and the
 *   site does not change;
 * - `sostituisci`: the site's colour variables take the page's values. Every page of the site changes: only the colour
 *   families the page has, and `colors.changes` says each variable before → after.
 */
export type AddPageColorsMode = "pagina" | "sito" | "sostituisci";

export const ADD_PAGE_COLORS_MODES: readonly AddPageColorsMode[] = Object.freeze(["pagina", "sito", "sostituisci"]);

/** The colour families the conversion writes as variables (css-cleanup.ts, tokenizeSheets): only the brand's two. */
export const PAGE_COLOR_FAMILIES = Object.freeze(["primary", "secondary"] as const);
export type PageColorFamily = (typeof PAGE_COLOR_FAMILIES)[number];

/** What `result.addPage.colors` says, only when `addPage.colors` is given. */
export interface AddPageColorsReport {
  mode: AddPageColorsMode;
  /** The page's colours the conversion wrote as variables of the framework, whatever the mode. Empty: none. */
  page: Array<{ family: PageColorFamily; variable: string; value: string }>;
  /** `pagina`: how many `var(…)` of those went back to the page's value. 0 in the other modes. */
  kept: number;
  /** `sostituisci`: the site's settings in the package that change, before → after (`design.primary`, `tokenOverrides.xb-primary`). */
  settings: Array<{ name: string; before: string; after: string }>;
  /**
   * `sostituisci`: every CSS variable of the site that changes value, before → after, in the light theme and (when the
   * site has the dark theme on) in the dark one. Nothing else of the site changes. Empty in the other modes.
   */
  changes: Array<{ variable: string; theme: "chiaro" | "scuro"; before: string; after: string }>;
  /** `sostituisci`: variables of `changes` that a sheet of the site also declares: where that rule holds, its value stays. */
  covered: Array<{ variable: string; sheet: string }>;
}

/** The variable the conversion writes for a family with a framework, or null when it writes none (Core, none). */
export function colorVariable(family: PageColorFamily, framework: string): string | null {
  if (framework === "histos-css") return `--xb-${family}`;
  // Automatic.css: the names of HISTOS_ACSS_MAP for xb-primary and xb-secondary.
  if (framework === "acss") return `--${family}`;
  return null;
}

/** The page's colours that are variables now: the families of the converted design, with the framework's names. */
export function pageColors(design: Readonly<Record<string, string>>, framework: string): AddPageColorsReport["page"] {
  const out: AddPageColorsReport["page"] = [];
  for (const family of PAGE_COLOR_FAMILIES) {
    const variable = colorVariable(family, framework);
    const value = design[family];
    if (variable && typeof value === "string" && value) out.push({ family, variable, value });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- the mode «pagina»

/** Every name the conversion may write for a colour, in any framework: a page may hold them already, written by hand. */
const PROTECTED = ["--xb-primary", "--xb-secondary", "--primary", "--secondary"].map((name) => new TextEncoder().encode(name));
const TEXT_FILE = /\.(?:html?|css)$/iu;

/** A byte that continues a CSS name: letters, digits, `-`, `_`, and any non-ASCII byte. */
function nameByte(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return byte >= 0x80 || byte === 0x2d || byte === 0x5f || (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function includesBytes(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let at = 0; at + needle.length <= bytes.length; at++) {
    for (let index = 0; index < needle.length; index++) if (bytes[at + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}

/**
 * For `pagina`: the colour names the page's own HTML and CSS already use (`var(--xb-primary)` in a page that comes from
 * a site with Histeon CSS, `var(--primary)` from one with Automatic.css) are given a name of their own before the
 * conversion, so that afterwards only the variables the conversion wrote go back to the page's colours; `restore`
 * gives the names back. Bytes are changed only where a whole name is (ASCII, so no text is decoded); the other files are
 * the same objects. Without any such name, `files` is returned as it is and `restore` changes nothing.
 */
export function protectColorNames(files: readonly StaticSiteFile[]): { files: StaticSiteFile[]; restore: (text: string) => string } {
  const texts = files.filter((file) => TEXT_FILE.test(file.path));
  if (!texts.some((file) => PROTECTED.some((name) => includesBytes(file.bytes, name)))) return { files: [...files], restore: (text) => text };
  let nonce = 0;
  const prefixOf = (value: number) => new TextEncoder().encode(`--h57k${value}-`);
  while (texts.some((file) => includesBytes(file.bytes, prefixOf(nonce)))) nonce++;
  const prefix = prefixOf(nonce);
  const out = files.map((file) => {
    if (!TEXT_FILE.test(file.path)) return file;
    const bytes = file.bytes;
    const chunks: Uint8Array[] = [];
    let from = 0;
    for (let at = 0; at < bytes.length; at++) {
      if (bytes[at] !== 0x2d || bytes[at + 1] !== 0x2d || nameByte(bytes[at - 1])) continue;
      const name = PROTECTED.find((candidate) => candidate.every((byte, index) => bytes[at + index] === byte) && !nameByte(bytes[at + candidate.length]));
      if (!name) continue;
      // `--xb-primary` → `--h57kN-xb-primary`: the prefix holds the two dashes.
      chunks.push(bytes.subarray(from, at), prefix, name.subarray(2));
      at += name.length - 1;
      from = at + 1;
    }
    if (!chunks.length) return file;
    chunks.push(bytes.subarray(from));
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return { ...file, bytes: joined };
  });
  const marker = new RegExp(`--h57k${nonce}-`, "gu");
  return { files: out, restore: (text) => text.replace(marker, "--") };
}

/**
 * For `pagina`: each `var(--xb-primary)` (or the framework's name) the conversion wrote, back to the page's colour, in
 * every style and sheet of the page. Only the plain `var(name)` the conversion writes; the count says how many.
 */
export function colorsBack(payload: Record<string, JsonValue>, colors: AddPageColorsReport["page"]): { payload: Record<string, JsonValue>; kept: number } {
  if (!colors.length) return { payload, kept: 0 };
  let kept = 0;
  const back = (css: string): string => {
    let out = css;
    for (const color of colors) {
      out = out.replaceAll(`var(${color.variable})`, () => {
        kept++;
        return color.value;
      });
    }
    return out;
  };
  const rewrite = (entries: JsonValue | undefined) => ((entries ?? []) as Array<Record<string, JsonValue>>).map((entry) => ({ ...entry, css: back(String(entry.css)) }));
  return { payload: { ...payload, styles: rewrite(payload.styles), globals: rewrite(payload.globals) }, kept };
}

// --------------------------------------------------------------------------------------------- the mode «sostituisci»

/** The codes `sostituisci` adds to AddPageError (add-page.ts). */
export type AddPageColorsErrorCode = "colori-senza-variabili" | "colori-pagina-assenti";

/** A variable's name in `tokenOverrides` (`xb-primary`, as TokenOverrides::validate stores it; `--xb-primary` read too). */
function overrideKey(overrides: Readonly<Record<string, JsonValue>>, token: string): string | null {
  return Object.keys(overrides).find((key) => key.replace(/^-+/u, "") === token) ?? null;
}

/**
 * The colour variables a site prints with these settings, as the plugin prints them (Frameworks::enqueue): the tokens
 * of the design (Tokens::css_changes, the groups switched off left out), then the token overrides in the light theme;
 * the dark theme's tokens when it is on.
 */
function siteVariables(design: Record<string, JsonValue>, overrides: Record<string, JsonValue>): { chiaro: Record<string, string>; scuro: Record<string, string> } {
  const full = validateHistosDesign(design);
  const chiaro: Record<string, string> = { ...printedHistosTokens(computeHistosTokens(full), full) };
  for (const [key, value] of Object.entries(overrides)) chiaro[key.replace(/^-+/u, "")] = String(value);
  const scuro = Number(full.dark_on) === 1 ? { ...printedHistosTokens(histosDarkTokens(full), full) } : {};
  return { chiaro, scuro };
}

/** The same colour, however written (`#FE0`, `#ffee00`): Histeon CSS's own writing of it. */
function sameColor(left: string, right: string): boolean {
  try {
    return validateHistosDesign({ primary: left }).primary === validateHistosDesign({ primary: right }).primary;
  } catch {
    return left === right;
  }
}

/**
 * For `sostituisci`: the site's `design` and `tokenOverrides` with the page's colours in the families it has. Only the
 * colour of each family changes (no font, size, radius or any other parameter); a token override of the same variable,
 * which would hide the new colour, takes it too. Returns the new settings and the report's lists.
 */
export function replaceSiteColors(live: Record<string, JsonValue>, colors: AddPageColorsReport["page"], globals: ReadonlyArray<{ id: string; css: string }>): { design: Record<string, JsonValue>; tokenOverrides: Record<string, JsonValue>; settings: AddPageColorsReport["settings"]; changes: AddPageColorsReport["changes"]; covered: AddPageColorsReport["covered"] } {
  const design = { ...((live.design ?? {}) as Record<string, JsonValue>) };
  const tokenOverrides = { ...((live.tokenOverrides ?? {}) as Record<string, JsonValue>) };
  const settings: AddPageColorsReport["settings"] = [];
  for (const color of colors) {
    const before = typeof design[color.family] === "string" ? String(design[color.family]) : String(HISTOS_DESIGN_DEFAULTS[color.family]);
    if (!sameColor(before, color.value)) {
      design[color.family] = color.value;
      settings.push({ name: `design.${color.family}`, before, after: color.value });
    }
    const key = overrideKey(tokenOverrides, `xb-${color.family}`);
    if (key !== null && !sameColor(String(tokenOverrides[key]), color.value)) {
      settings.push({ name: `tokenOverrides.${key}`, before: String(tokenOverrides[key]), after: color.value });
      tokenOverrides[key] = color.value;
    }
  }
  const before = siteVariables((live.design ?? {}) as Record<string, JsonValue>, (live.tokenOverrides ?? {}) as Record<string, JsonValue>);
  const after = siteVariables(design, tokenOverrides);
  const changes: AddPageColorsReport["changes"] = [];
  for (const theme of ["chiaro", "scuro"] as const) {
    for (const name of [...new Set([...Object.keys(before[theme]), ...Object.keys(after[theme])])].sort()) {
      const was = before[theme][name] ?? "";
      const now = after[theme][name] ?? "";
      if (was !== now) changes.push({ variable: `--${name}`, theme, before: was, after: now });
    }
  }
  const covered: AddPageColorsReport["covered"] = [];
  for (const variable of new Set(changes.map((change) => change.variable))) {
    // A variable's name is letters, digits and dashes only (Histeon CSS's tokens): nothing to escape.
    const declared = new RegExp(`(?<![\\w-])${variable}\\s*:`, "u");
    for (const sheet of globals) if (declared.test(sheet.css)) covered.push({ variable, sheet: sheet.id });
  }
  return { design, tokenOverrides, settings, changes, covered };
}

/**
 * For `sostituisci`, the report's `designKept`: whether the page's design has values the site does not take, the
 * colours it imported (`imported`) aside.
 */
export function designKeptBesides(own: JsonValue | undefined, merged: JsonValue | undefined, imported: ReadonlySet<string>): boolean {
  if (!own || typeof own !== "object" || Array.isArray(own)) return false;
  const site = (merged && typeof merged === "object" && !Array.isArray(merged) ? merged : {}) as Record<string, JsonValue>;
  return Object.entries(own).some(([key, value]) => !imported.has(key) && canonicalizeJson(value) !== canonicalizeJson(site[key] ?? null));
}
