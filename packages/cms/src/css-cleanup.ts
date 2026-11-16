import postcss, { type AtRule, type ChildNode, type Declaration, type Rule } from "postcss";
import { HISTOS_ACSS_MAP } from "./histos-css-assets.generated.js";
import { HISTOS_CSS_DESIGN_DATA } from "./histos-design-data.generated.js";
import { SITE_TOKEN_PREFIX, validateHistosDesign, validateSiteTokens } from "./histos-design.js";
import { CORE_DEFAULT_SCALE, corePxExpression, coreScale } from "./core-framework-scale.js";
import { portToSelectors } from "./selector-port.js";

/**
 * CSS of a converted site, made editable (queue B4): the rules of each block in use go into its selector, nested as
 * the builder's CSS panel holds them, with the builder's own planSheetMove (doc 18 §6.5), which leaves in the global
 * sheets what would print in another order; the rest (:root, @font-face, element rules, animations) stays global.
 * Exact duplicate declarations and rules go, and so do rules of classes no page uses.
 * The colors and fonts that dominate become a proposal for Histeon CSS `design`. Values are rewritten as tokens only
 * when the user asks (`tokens`), since the fluid scale changes the look: the preview shows it before anything is
 * imported.
 */

export interface CssCleanupResult {
  globals: Array<{ name: string; css: string }>;
  /** The text of `<style data-histos="selectors">`: one rule per class selector. */
  selectors: string;
  /** Dominant colors and fonts, as Histeon CSS `design` parameters. */
  design: { primary?: string; secondary?: string; font_body?: string; font_heading?: string };
  /** The whole font stacks the proposal's fonts come from ("Inter", sans-serif), for `cssDesignParameters`. */
  fontStacks: { body?: string; heading?: string };
  notes: string[];
  /** Doc 28: the sizes written by hand, as the site's variables (names without `--xb-site-`), when `exact` was asked. */
  siteTokens?: Record<string, string>;
  /** Sheets kept whole because they could not be parsed: nothing is moved then. */
  unparsed?: number;
}

const CLASS_KEY = /^\.(-?[_a-zA-Z][\w-]*)(.*)$/su;
const COLOR_PROPERTIES = new Set(["color", "background", "background-color", "border-color", "border", "border-top-color", "border-bottom-color", "outline-color", "fill", "stroke"]);
const MAX_SELECTOR = 1024;

/** The colors of a value written as hex, lower-case and expanded (#abc → #aabbcc). */
function hexColors(value: string): string[] {
  return [...value.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/giu)].map((match) => {
    const hex = (match[1] ?? "").toLowerCase();
    return `#${hex.length === 3 ? hex.split("").map((digit) => digit + digit).join("") : hex}`;
  });
}

/** Saturation and lightness of a hex color, to tell brand colors from greys, black and white. */
function chroma(hex: string): { saturation: number; lightness: number } {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return { saturation, lightness };
}

function firstFamily(value: string): string {
  return value.split(",")[0]?.trim().replace(/^["']|["']$/gu, "") ?? "";
}

/**
 * V5.3b: a font-family that names no font: a variable («var(--famiglia)») or a CSS-wide keyword. It never becomes the
 * proposal's font, so no value is rewritten as the font token on its account.
 */
function namesNoFont(family: string): boolean {
  return /^(?:var\(|env\(|inherit$|initial$|unset$|revert(?:-layer)?$)/iu.test(family);
}

/** The text steps of Histeon CSS at their default scale: the size halfway between the smallest and largest screen. */
/** The framework the values of a converted site are written with (doc 18 §6.4.1). */
export type ImportFramework = "histos-css" | "acss" | "core" | "none";

/** The width the fluid scales are compared at (doc 18 §6.4.1). */
const REFERENCE_WIDTH = 1280;
/** A step of a Histeon CSS fluid scale, in px at the reference width. */
function fluidSteps(steps: Readonly<Record<string, number>>, base: [number, number], ratio: [number, number]): Array<{ name: string; px: number }> {
  const defaults = HISTOS_CSS_DESIGN_DATA.defaults;
  const share = Math.min(1, Math.max(0, (REFERENCE_WIDTH - defaults.viewport_min) / (defaults.viewport_max - defaults.viewport_min)));
  return Object.entries(steps).map(([name, step]) => {
    const min = base[0] * ratio[0] ** step;
    const max = base[1] * ratio[1] ** step;
    return { name, px: min + (max - min) * share };
  });
}
const DEFAULTS = HISTOS_CSS_DESIGN_DATA.defaults;
const TEXT_TOKENS = fluidSteps(HISTOS_CSS_DESIGN_DATA.textSteps, [DEFAULTS.text_min, DEFAULTS.text_max], [DEFAULTS.text_ratio_min, DEFAULTS.text_ratio_max]);
const SPACE_TOKENS = fluidSteps(HISTOS_CSS_DESIGN_DATA.spaceSteps, [DEFAULTS.space_min, DEFAULTS.space_max], [DEFAULTS.space_ratio_min, DEFAULTS.space_ratio_max]);
/** Spacing properties whose lengths snap to the space scale. */
const SPACE_PROPERTY = /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/u;

/**
 * The token nearest a size in px, when it is within a twentieth of the token's value at 1280 px (doc 18 §6.4.1);
 * else null (the size stays as a number).
 */
function nearestToken(scale: ReadonlyArray<{ name: string; px: number }>, prefix: string, px: number): string | null {
  let best: { name: string; px: number } | null = null;
  for (const token of scale) if (!best || Math.abs(token.px - px) < Math.abs(best.px - px)) best = token;
  return best && Math.abs(best.px - px) <= best.px / 20 ? `--xb-${prefix}-${best.name}` : null;
}
/** A length written in px or rem, in px; null for anything else. */
function lengthPx(value: string): number | null {
  const size = /^([0-9]{1,4}(?:\.[0-9]+)?|\.[0-9]+)(px|rem)$/u.exec(value.trim());
  return size ? Number(size[1]) * (size[2] === "rem" ? 16 : 1) : null;
}
/** Histeon CSS token → Automatic.css variable, both without `--`. */
const ACSS_NAME = new Map(Object.entries(HISTOS_ACSS_MAP.tokens));

/**
 * The proposal as `design` parameters Histeon CSS accepts: colors as they are, a font name with a generic fallback.
 * What does not validate is left out.
 */
export function cssDesignParameters(result: Pick<CssCleanupResult, "design" | "fontStacks">): Record<string, string> {
  const out: Record<string, string> = {};
  const valid = (key: string, value: string | undefined): boolean => {
    if (!value) return false;
    try {
      validateHistosDesign({ [key]: value });
      return true;
    } catch {
      return false;
    }
  };
  const { design, fontStacks } = result;
  for (const key of ["primary", "secondary"] as const) if (valid(key, design[key])) out[key] = design[key] ?? "";
  // The site's own stack when Histeon CSS can write it, else the name with a generic fallback.
  for (const [key, name, stack] of [["font_body", design.font_body, fontStacks.body], ["font_heading", design.font_heading, fontStacks.heading]] as const) {
    if (!name) continue;
    const fallback = `"${name}", ${/\bserif\b/iu.test(stack ?? "") && !/sans-serif/iu.test(stack ?? "") ? "serif" : "sans-serif"}`;
    if (valid(key, stack)) out[key] = stack ?? "";
    else if (valid(key, fallback)) out[key] = fallback;
  }
  return out;
}

/**
 * The sheets with their values as Histeon CSS tokens (B4): the brand colors become `var(--xb-primary)` and
 * `var(--xb-secondary)`, the fonts of text and headings `var(--xb-font-body)` and `var(--xb-font-heading)`, sizes in
 * px or rem the nearest `var(--xb-text-*)`. @font-face stays as it is.
 */
function tokenizeSheets(sheets: ReadonlyArray<{ name: string; css: string }>, design: CssCleanupResult["design"], framework: Exclude<ImportFramework, "none">, snapSizes = true): { sheets: Array<{ name: string; css: string }>; colors: number; fonts: number; sizes: number; spaces: number; coreVariables: string[] } {
  let colors = 0;
  let fonts = 0;
  let sizes = 0;
  let spaces = 0;
  /** Core Framework's variables the rewritten sheets use: the conversion defines them (cleanupTokens). */
  const coreUsed = new Set<string>();
  const coreScales = framework === "core" ? { text: coreScale("text", REFERENCE_WIDTH), space: coreScale("space", REFERENCE_WIDTH) } : null;
  /** A size as the framework's step within a twentieth at 1280 px (doc 18 §6.4.1), or null: the size stays a number. */
  const step = (prefix: "text" | "space", px: number): string | null => {
    if (!coreScales) {
      const nearest = nearestToken(prefix === "text" ? TEXT_TOKENS : SPACE_TOKENS, prefix, px);
      return nearest ? named(nearest) : null;
    }
    const nearest = nearestToken(coreScales[prefix], prefix, px);
    if (!nearest) return null;
    const variable = nearest.replace(/^--xb-/u, "");
    coreUsed.add(variable);
    return `var(--${variable})`;
  };
  /**
   * A Histeon CSS token as the framework names it, or null when it has no name there (the value then stays). Core's
   * colors are its own (HSL) and a color is matched only when identical: with Core, colors and fonts stay.
   */
  const named = (token: string): string | null => {
    if (framework === "core") return null;
    if (framework === "histos-css") return `var(${token})`;
    const acss = ACSS_NAME.get(token.slice(2));
    return acss ? `var(--${acss})` : null;
  };
  const brand = new Map<string, string>();
  const primary = named("--xb-primary");
  const secondary = named("--xb-secondary");
  if (design.primary && primary) brand.set(design.primary, primary);
  if (design.secondary && secondary && !brand.has(design.secondary)) brand.set(design.secondary, secondary);
  const out = sheets.map((sheet) => {
    let root: ReturnType<typeof postcss.parse>;
    try {
      root = postcss.parse(sheet.css);
    } catch {
      return { ...sheet };
    }
    root.walkDecls((declaration) => {
      if (declaration.parent?.type === "atrule" && (declaration.parent as AtRule).name.toLowerCase() === "font-face") return;
      const property = declaration.prop.toLowerCase();
      if (property === "font-family") {
        const family = firstFamily(declaration.value).toLowerCase();
        const token = design.font_heading && family === design.font_heading.toLowerCase() && design.font_heading !== design.font_body ? named("--xb-font-heading") : design.font_body && family === design.font_body.toLowerCase() ? named("--xb-font-body") : null;
        if (token) {
          declaration.value = token;
          fonts++;
        }
        return;
      }
      // Doc 28: with the exact sizes no length goes on a fluid step; what is left is left as written.
      if (!snapSizes && (property === "font-size" || SPACE_PROPERTY.test(property))) return;
      if (property === "font-size") {
        const px = lengthPx(declaration.value);
        const token = px === null ? null : step("text", px);
        if (token) {
          declaration.value = token;
          sizes++;
        }
        return;
      }
      if (SPACE_PROPERTY.test(property)) {
        const parts = declaration.value.trim().split(/\s+/u);
        if (parts.length <= 4) {
          const written = parts.map((part) => {
            const px = lengthPx(part);
            return (px === null || px === 0 ? null : step("space", px)) ?? part;
          });
          const changed = written.filter((part, index) => part !== parts[index]).length;
          if (changed) {
            declaration.value = written.join(" ");
            spaces += changed;
          }
        }
        return;
      }
      if (!brand.size) return;
      declaration.value = declaration.value.replace(/#([0-9a-f]{3}|[0-9a-f]{6})\b/giu, (match) => {
        const token = hexColors(match).map((color) => brand.get(color)).find(Boolean);
        if (!token) return match;
        colors++;
        return token;
      });
    });
    return { name: sheet.name, css: root.toString() };
  });
  return { sheets: out, colors, fonts, sizes, spaces, coreVariables: [...coreUsed].sort() };
}

/**
 * Doc 28, «valori esatti»: the sizes a captured proposal writes by hand stay what they are, as the site's variables
 * (`--xb-site-testo-17: 17px`), instead of going on the framework's fluid steps. A size written with a variable stays.
 */
const ABSOLUTE_LENGTH = /(?:^|[^\w.#-])(?:\d+\.?\d*|\.\d+)(?:px|rem|pt|pc|cm|mm|in|q)(?![\w-])/iu;
const ONE_LENGTH = /^(\d+\.?\d*|\.\d+)(px|rem)$/iu;
/** The site's variables are at most 200 (validateSiteTokens). */
const EXACT_MAX = 200;

/** `10.5` → `10-5`, `.85` → `0-85`: a number as a variable's name holds it. */
function numberName(text: string): string {
  return String(Number(text)).replace(".", "-");
}
/** `17px` → `17`, `1.5rem` → `1-5rem`; null for anything but one length in px or rem. */
function lengthName(value: string): string | null {
  const one = ONE_LENGTH.exec(value);
  return one ? `${numberName(one[1] ?? "")}${(one[2] ?? "").toLowerCase() === "rem" ? "rem" : ""}` : null;
}
/** One length as the variable holds it: `17.0PX` → `17px`. */
function lengthValue(value: string): string {
  const one = ONE_LENGTH.exec(value);
  return one ? `${Number(one[1])}${(one[2] ?? "").toLowerCase()}` : value.replace(/\s+/gu, " ").replace(/\s*,\s*/gu, ", ").replace(/\(\s+/gu, "(").replace(/\s+\)/gu, ")").trim();
}
/** A value cut where `separator` stands outside brackets and quotes; a white-space separator cuts on any run of it. */
function splitOutside(value: string, separator: "," | "/" | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (separator === " " ? /\s/u.test(character) : character === separator)) {
      if (separator !== " " || current) parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (separator !== " " || current) parts.push(current);
  return parts;
}
/** A text size written with an absolute length, alone or inside a function; a lone `var()` is a variable already. */
function fixedTextSize(value: string): boolean {
  const text = value.trim();
  return ABSOLUTE_LENGTH.test(text) && !/^var\([^()]*\)$/iu.test(text) && !/["']/u.test(text);
}
/** The name a text size asks for (without `testo-`), or "" when only a counter can name it. */
function textSizeName(value: string): string {
  const text = value.trim();
  const one = lengthName(text);
  if (one) return one;
  const clamp = /^clamp\((.*)\)$/isu.exec(text);
  const parts = clamp ? splitOutside(clamp[1] ?? "", ",").map((part) => part.trim()) : [];
  const [from, to] = [lengthName(parts[0] ?? ""), lengthName(parts[2] ?? "")];
  return parts.length === 3 && from && to ? `da-${from}-a-${to}` : "";
}
/** The size of a `font` shorthand: the first part that is neither a keyword nor a bare number, before its `/line-height`. */
function fontShorthandSize(value: string): { parts: string[]; index: number; size: string; rest: string } | null {
  const parts = splitOutside(value.trim(), " ");
  for (const [index, part] of parts.entries()) {
    if (/^[a-z-]+$/iu.test(part) || /^\d+(?:\.\d+)?$/u.test(part)) continue;
    const [size = "", ...rest] = splitOutside(part, "/");
    return fixedTextSize(size) ? { parts, index, size, rest: rest.length ? `/${rest.join("/")}` : "" } : null;
  }
  return null;
}

/**
 * The sizes of `plan` (the sheets cleaned once: only the rules a page uses) named as the site's variables, and
 * `sheets` rewritten with them. Texts first, then the spaces from the most used, within the site's 200 variables.
 */
function exactSizes(plan: ReadonlyArray<{ css: string }>, sheets: ReadonlyArray<CssCleanupSheet>): { sheets: CssCleanupSheet[]; siteTokens: Record<string, string>; texts: number; spaces: number; left: number; refused: number } {
  const texts: string[] = [];
  const spaceUses = new Map<string, number>();
  const walk = (css: string, visit: (declaration: Declaration, property: string) => void): ReturnType<typeof postcss.parse> | null => {
    let root: ReturnType<typeof postcss.parse>;
    try {
      root = postcss.parse(css);
    } catch {
      return null;
    }
    root.walkDecls((declaration) => {
      if (declaration.parent?.type === "atrule" && (declaration.parent as AtRule).name.toLowerCase() === "font-face") return;
      visit(declaration, declaration.prop.toLowerCase());
    });
    return root;
  };
  const spaceParts = (value: string): string[] | null => {
    const parts = value.trim().split(/\s+/u);
    return parts.length <= 4 ? parts : null;
  };
  const spaceKey = (part: string): string | null => {
    const px = lengthPx(part);
    return px === null || px === 0 ? null : lengthValue(part);
  };
  for (const sheet of plan) walk(sheet.css, (declaration, property) => {
    if (property === "font-size" && fixedTextSize(declaration.value)) texts.push(lengthValue(declaration.value));
    else if (property === "font") {
      const size = fontShorthandSize(declaration.value);
      if (size) texts.push(lengthValue(size.size));
    } else if (SPACE_PROPERTY.test(property)) for (const part of spaceParts(declaration.value) ?? []) {
      const key = spaceKey(part);
      if (key) spaceUses.set(key, (spaceUses.get(key) ?? 0) + 1);
    }
  });

  const siteTokens: Record<string, string> = {};
  const taken = new Set<string>();
  let refused = 0;
  /** The variable of a value, or null when the site's variables do not take it. */
  const add = (kind: "testo" | "spazio", wanted: string, value: string, counter: () => number): string | null => {
    const candidates = wanted ? [wanted, ...[..."bcdefghijklmnopqrstuvwxyz"].map((letter) => `${wanted}-${letter}`)].map((name) => `${kind}-${name}`) : [];
    let name = candidates.find((candidate) => candidate.length <= 40 && !taken.has(candidate));
    while (!name) {
      const numbered = `${kind}-misura-${counter()}`;
      if (!taken.has(numbered)) name = numbered;
    }
    try {
      validateSiteTokens({ [name]: value });
    } catch {
      refused++;
      return null;
    }
    taken.add(name);
    siteTokens[name] = value;
    return `var(--${SITE_TOKEN_PREFIX}${name})`;
  };
  let numbered = 0;
  let left = 0;
  const textVariable = new Map<string, string | null>();
  for (const value of texts) {
    if (textVariable.has(value)) continue;
    if (taken.size >= EXACT_MAX) left++;
    textVariable.set(value, taken.size < EXACT_MAX ? add("testo", textSizeName(value), value, () => ++numbered) : null);
  }
  const spaceVariable = new Map<string, string | null>();
  let spaceNumbered = 0;
  for (const [value] of [...spaceUses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }))) {
    if (taken.size >= EXACT_MAX) {
      left++;
      continue;
    }
    spaceVariable.set(value, add("spazio", lengthName(value) ?? "", value, () => ++spaceNumbered));
  }

  const out = sheets.map((sheet) => {
    const root = walk(sheet.css, (declaration, property) => {
      if (property === "font-size") {
        const variable = fixedTextSize(declaration.value) ? textVariable.get(lengthValue(declaration.value)) : null;
        if (variable) declaration.value = variable;
      } else if (property === "font") {
        const size = fontShorthandSize(declaration.value);
        const variable = size ? textVariable.get(lengthValue(size.size)) : null;
        if (size && variable) declaration.value = size.parts.map((part, index) => (index === size.index ? `${variable}${size.rest}` : part)).join(" ");
      } else if (SPACE_PROPERTY.test(property)) {
        const parts = spaceParts(declaration.value);
        if (!parts) return;
        const written = parts.map((part) => {
          const key = spaceKey(part);
          return (key ? spaceVariable.get(key) : null) ?? part;
        });
        if (written.some((part, index) => part !== parts[index])) declaration.value = written.join(" ");
      }
    });
    return root ? { ...sheet, css: root.toString() } : { ...sheet };
  });
  const names = Object.keys(siteTokens);
  return { sheets: out, siteTokens: validateSiteTokens(siteTokens), texts: names.filter((name) => name.startsWith("testo-")).length, spaces: names.filter((name) => name.startsWith("spazio-")).length, left, refused };
}

/**
 * A sheet to clean up. `brand: false` (D5, a page added to a site: the sheets of the theme, of WordPress and of its
 * plugins) keeps the sheet as any other, but its colours do not count for the brand colours of the design.
 */
export interface CssCleanupSheet {
  name: string;
  css: string;
  brand?: false;
}

export function cleanupCss(input: { sheets: ReadonlyArray<CssCleanupSheet>; usedClasses: ReadonlySet<string>; tokens?: boolean; framework?: ImportFramework; exact?: boolean }): CssCleanupResult {
  return toSelectors(cleanupTokens(input), input.usedClasses);
}

/**
 * The rules of each block in use go into the block's selector, nested as SCSS, with the builder's own planSheetMove
 * (selector-port.ts, the same move the import and the editor's «Nei selettori» make): what would print in another order
 * stays in the sheets, so the cascade is the one of the site.
 */
function toSelectors(result: CssCleanupResult, usedClasses: ReadonlySet<string>): CssCleanupResult {
  if (result.unparsed) return result;
  const port = portToSelectors(result.globals.map((sheet) => sheet.css), result.selectors, usedClasses);
  if (!port) return result;
  const globals = result.globals.map((sheet, index) => ({ name: sheet.name, css: (port.sheets[index] ?? sheet.css).trim() })).filter((sheet) => sheet.css);
  const kept = port.kept.length ? [`${port.kept.length} ${port.kept.length === 1 ? "blocco resta nel foglio" : "blocchi restano nel foglio"}: nel selettore due regole dello stesso peso si stamperebbero in un altro ordine (${port.kept.slice(0, 6).map((block) => `.${block.slice(0, 40)}`).join(", ")}${port.kept.length > 6 ? "…" : ""})`] : [];
  const notes = [`${port.entries} ${port.entries === 1 ? "stile" : "stili"} per selettore (${port.rules} ${port.rules === 1 ? "regola spostata" : "regole spostate"} con planSheetMove, la cascata resta quella del sito)`, ...kept, ...result.notes];
  return { ...result, globals, selectors: port.selectors, notes };
}

function cleanupTokens(input: { sheets: ReadonlyArray<CssCleanupSheet>; usedClasses: ReadonlySet<string>; tokens?: boolean; framework?: ImportFramework; exact?: boolean }): CssCleanupResult {
  const first = cleanupPass(input.sheets, input.usedClasses);
  const framework = input.framework ?? (input.tokens ? "histos-css" : "none");
  if (framework === "none") return first;
  // The proposal comes from the site as it is; the values are then rewritten and cleaned again. A font becomes the font
  // token only when the design carries it (V5.3b): else the token would show Histeon CSS's own font instead of the site's.
  const accepted = cssDesignParameters(first);
  const { font_body: fontBody, font_heading: fontHeading, ...colors } = first.design;
  // Doc 28: a captured proposal keeps the sizes it wrote by hand, as the site's variables; nothing goes on a fluid step.
  const exact = input.exact === true && framework !== "core" ? exactSizes(first.globals, input.sheets) : null;
  const tokenized = tokenizeSheets(exact?.sheets ?? input.sheets, { ...colors, ...(fontBody && accepted.font_body ? { font_body: fontBody } : {}), ...(fontHeading && accepted.font_heading ? { font_heading: fontHeading } : {}) }, framework, !exact);
  // Core's variables the site now uses, defined in px at the lowest specificity: they hold in Histeon Publish, and on a
  // WordPress site with Core Framework active its own definitions win.
  const coreSheet = tokenized.coreVariables.length ? [{ name: "Core Framework: variabili usate", css: `:where(:root) {\n${tokenized.coreVariables.map((name) => `  --${name}: ${corePxExpression(CORE_DEFAULT_SCALE[name] as string)};`).join("\n")}\n}` }] : [];
  const second = cleanupPass([...coreSheet, ...tokenized.sheets], input.usedClasses);
  const changed = tokenized.colors + tokenized.fonts + tokenized.sizes + tokenized.spaces;
  const notes = second.notes.filter((note) => !note.startsWith("proposta per Histeon CSS"));
  if (changed) notes.unshift(`${framework === "acss" ? "variabili di Automatic.css" : framework === "core" ? "variabili di Core Framework (preset predefinito)" : "token di Histeon CSS"} al posto dei valori: ${tokenized.colors} colori, ${tokenized.fonts} caratteri, ${tokenized.sizes} misure di testo, ${tokenized.spaces} spazi (entro un ventesimo a 1280 px; gli altri restano numeri)`);
  if (exact && (exact.texts || exact.spaces)) {
    notes.unshift(`misure scritte a mano tenute esatte come variabili del sito: ${exact.texts} ${exact.texts === 1 ? "misura di testo" : "misure di testo"} (--${SITE_TOKEN_PREFIX}testo-…), ${exact.spaces} ${exact.spaces === 1 ? "spazio" : "spazi"} (--${SITE_TOKEN_PREFIX}spazio-…); si cambiano in Design, Variabili del sito`);
  }
  if (exact?.left) notes.push(`${exact.left} ${exact.left === 1 ? "misura resta un numero" : "misure restano numeri"}: le variabili del sito sono al massimo ${EXACT_MAX}`);
  if (exact?.refused) notes.push(`${exact.refused} ${exact.refused === 1 ? "misura resta com'era" : "misure restano com'erano"}: le variabili del sito non accettano quel valore`);
  return { ...second, design: first.design, fontStacks: first.fontStacks, notes, ...(exact && Object.keys(exact.siteTokens).length ? { siteTokens: exact.siteTokens } : {}) };
}

function cleanupPass(sheetsInput: ReadonlyArray<CssCleanupSheet>, usedClasses: ReadonlySet<string>): CssCleanupResult {
  const input = { sheets: sheetsInput, usedClasses };
  const globals: Array<{ name: string; css: string }> = [];
  const colorUse = new Map<string, number>();
  /** D5: false while the sheet being read is one whose colours do not count for the brand (`brand: false`). */
  let brandColors = true;
  let bodyFont = "";
  let headingFont = "";
  let bodyStack = "";
  let headingStack = "";
  let dead = 0;
  let duplicates = 0;
  let important = 0;
  let unparsed = 0;
  const suggestions: string[] = [];

  const declarationsOf = (rule: Rule): string[] => {
    const out: string[] = [];
    for (const node of rule.nodes ?? []) {
      if (node.type !== "decl") continue;
      const declaration = node as Declaration;
      if (declaration.important) important++;
      const property = declaration.prop.toLowerCase();
      if (brandColors && COLOR_PROPERTIES.has(property)) for (const color of hexColors(declaration.value)) colorUse.set(color, (colorUse.get(color) ?? 0) + 1);
      if (/^font-size$/u.test(property) && /^[0-9.]+px$/u.test(declaration.value) && suggestions.length < 8) {
        suggestions.push(`font-size: ${declaration.value} in ${rule.selector.slice(0, 60)} → una misura della scala --xb-text-*`);
      }
      out.push(`${declaration.prop}: ${declaration.value}${declaration.important ? " !important" : ""}`);
    }
    return out;
  };

  /**
   * A rule: each class selector goes under its class (nested by what follows the class); what is not about a class
   * stays global. Returns the CSS of the part that stays global, or "".
   */
  const placeRule = (rule: Rule, mediaPath: readonly string[]): string => {
    const declarations = declarationsOf(rule);
    const hasNestedRules = (rule.nodes ?? []).some((node) => node.type !== "decl" && node.type !== "comment");
    const globalSelectors: string[] = [];
    for (const selector of rule.selectors.map((item) => item.trim())) {
      const match = CLASS_KEY.exec(selector);
      if (!match || hasNestedRules || selector.length > MAX_SELECTOR) {
        globalSelectors.push(selector);
        for (const declaration of declarations) {
          if (!/^font-family:/iu.test(declaration)) continue;
          const stack = declaration.slice(declaration.indexOf(":") + 1).replace(/\s*!important$/iu, "").trim();
          if (namesNoFont(firstFamily(stack))) continue;
          if (/^(?:html|body|:root)\b/u.test(selector) && !bodyFont) [bodyFont, bodyStack] = [firstFamily(stack), stack];
          if (/^h[1-3]\b/u.test(selector) && !headingFont) [headingFont, headingStack] = [firstFamily(stack), stack];
        }
        continue;
      }
      const name = match[1] ?? "";
      if (!input.usedClasses.has(name)) {
        dead++;
        continue;
      }
      // A rule of a class in use stays where it is: planSheetMove moves it into its selector afterwards, only where
      // the cascade stays the same (doc 18 §6.5).
      globalSelectors.push(selector);
    }
    if (!globalSelectors.length) return "";
    const clone = rule.clone({ selector: globalSelectors.join(",\n") });
    // An exact repeat of a declaration goes, the last one wins: the cascade is the same. Linear.
    const lastOf = new Map<string, Declaration>();
    for (const node of clone.nodes ?? []) if (node.type === "decl") lastOf.set(node.toString(), node as Declaration);
    const nodes = clone.nodes ?? [];
    const unique = nodes.filter((node) => node.type !== "decl" || lastOf.get(node.toString()) === node);
    if (unique.length !== nodes.length) {
      // Rebuilt in one go: removing one node at a time is quadratic.
      duplicates += nodes.length - unique.length;
      clone.removeAll();
      clone.append(unique);
    }
    return clone.toString();
  };
  /**
   * An exact repeat of a rule (same @media, selector and declarations) leaves only its last copy: whatever the earlier
   * one won over, the later one wins over too.
   */
  const seenRules = new Map<string, { css: string }>();
  const keep = (list: Array<{ css: string }>, css: string, context: string): void => {
    const entry = { css };
    const key = `${context}\u0000${css}`;
    const earlier = seenRules.get(key);
    if (earlier) {
      earlier.css = "";
      duplicates++;
    }
    seenRules.set(key, entry);
    list.push(entry);
  };

  const sheetEntries: Array<{ name: string; kept: Array<{ css: string }> }> = [];
  for (const sheet of input.sheets) {
    brandColors = sheet.brand !== false;
    let root: ReturnType<typeof postcss.parse>;
    try {
      root = postcss.parse(sheet.css);
    } catch {
      // Not CSS we can read: kept whole, as it was.
      unparsed++;
      sheetEntries.push({ name: sheet.name, kept: [{ css: sheet.css }] });
      continue;
    }
    const kept: Array<{ css: string }> = [];
    for (const node of root.nodes as ChildNode[]) {
      if (node.type === "comment") continue;
      if (node.type === "rule") {
        const css = placeRule(node as Rule, []);
        if (css) keep(kept, css, "");
        continue;
      }
      if (node.type === "atrule") {
        const atRule = node as AtRule;
        const name = atRule.name.toLowerCase();
        if ((name === "media" || name === "supports") && atRule.nodes?.every((child) => child.type === "rule" || child.type === "comment")) {
          const step = `@${atRule.name} ${atRule.params}`.trim();
          const rest: Array<{ css: string }> = [];
          for (const child of atRule.nodes) if (child.type === "rule") {
            const css = placeRule(child as Rule, [step]);
            if (css) keep(rest, css, step);
          }
          if (rest.length) kept.push({ get css() {
            const inner = rest.map((entry) => entry.css).filter(Boolean);
            return inner.length ? `${step} {\n${inner.join("\n")}\n}` : "";
          } });
          continue;
        }
        kept.push({ css: atRule.toString() });
        continue;
      }
      kept.push({ css: node.toString() });
    }
    sheetEntries.push({ name: sheet.name, kept });
  }
  for (const { name, kept } of sheetEntries) {
    const css = kept.map((entry) => entry.css).filter(Boolean).join("\n").trim();
    if (css) globals.push({ name, css });
  }

  const selectors = "";

  // Brand colors: the most used colors that are neither grey, nor near black or white.
  const brand = [...colorUse].filter(([color]) => {
    const { saturation, lightness } = chroma(color);
    return saturation > 0.25 && lightness > 0.12 && lightness < 0.9;
  }).sort((left, right) => right[1] - left[1]).map(([color]) => color);
  const design: CssCleanupResult["design"] = {
    ...(brand[0] ? { primary: brand[0] } : {}),
    ...(brand[1] ? { secondary: brand[1] } : {}),
    ...(bodyFont ? { font_body: bodyFont } : {}),
    ...(headingFont ? { font_heading: headingFont } : {}),
  };

  const notes: string[] = [];
  /** "1 regola", "3 regole": the report is in Italian. */
  const count = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;
  if (dead) notes.push(count(dead, "regola di una classe che nessuna pagina usa tolta", "regole di classi che nessuna pagina usa tolte"));
  if (duplicates) notes.push(count(duplicates, "dichiarazione ripetuta tolta", "dichiarazioni ripetute tolte"));
  if (important) notes.push(count(important, "dichiarazione con !important: meglio toglierla nel pannello CSS", "dichiarazioni con !important: meglio toglierle nel pannello CSS"));
  if (unparsed) notes.push(count(unparsed, "foglio non leggibile come CSS lasciato com'era", "fogli non leggibili come CSS lasciati come erano"));
  if (design.primary || design.font_body) {
    notes.push(`proposta per Histeon CSS: ${[design.primary ? `primary ${design.primary}` : "", design.secondary ? `secondary ${design.secondary}` : "", design.font_body ? `testo «${design.font_body}»` : "", design.font_heading ? `titoli «${design.font_heading}»` : ""].filter(Boolean).join(", ")}`);
  }
  for (const suggestion of suggestions) notes.push(suggestion);
  return { globals, selectors, unparsed, design, fontStacks: { ...(bodyStack ? { body: bodyStack } : {}), ...(headingStack ? { heading: headingStack } : {}) }, notes };
}
