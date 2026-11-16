// «Importa i token (DTCG)» of the Histeon CSS panel and «Importa variabili» of the Design system: design tokens
// from the files a design tool exports, read here (no network, no credentials):
// - Figma, «Export modes» of a variable collection: one Design Tokens Community Group file per mode (colours as
//   objects, dimensions as `{ value, unit }`, references `{name}`);
// - Penpot, Tokens → Export: a Tokens Studio file (token sets at the top, `$themes`, `$metadata`; numbers written as
//   texts, types named `fontSizes`, `spacing`, `borderRadius`…, formulas like `{base} * 2`);
// - the files of «Esporta i token (DTCG)» of this panel (dtcg.ts).
//
// Histeon CSS computes its scales from a few values, so a token is not copied as a variable of the same name:
// `color.primary.500` becomes the parameter `primary` and the framework makes the shades. A text size never becomes
// a fixed length: it is matched to the nearest step of the scale and said in the report. What has no parameter
// becomes a variable of the site (`--xb-site-*`). Nothing is dropped silently: what is not converted is listed with
// its reason. Pure: no DOM, no server. Every value is rebuilt from parsed numbers and colours, no text of the file is
// copied into CSS; the server validates the parameters (design/preview) and the variables (SiteTokens) again.

import type { DesignParams } from '../lib/api.ts';
import { SITE_PREFIX, siteNameProblem, tokenProblem } from '../lib/designSystem.ts';
import { t } from '../lib/i18n.ts';
import { FAMILY_LABELS, OPTIONS, SHADES } from './options.ts';

export interface TokenFile {
  name: string;
  text: string;
}
export type TokenKind = 'color' | 'dimension' | 'fontSize' | 'fontFamily' | 'fontWeight' | 'number' | 'shadow' | 'typography';
export interface TokenColor {
  r: number;
  g: number;
  b: number;
  alpha: number;
  /** The colour as the file wrote it in OKLCH, which sRGB bytes may not hold exactly. */
  oklch?: string;
}
interface Length {
  px: number;
  unit: 'px' | 'rem';
}
interface Shadow {
  x: Length;
  y: Length;
  blur: Length;
  spread: Length;
  color: TokenColor;
  inset: boolean;
}
interface TextStyle {
  families?: string[];
  sizePx?: number;
  weight?: number;
  leading?: number;
}
/** One token, read and resolved. `name` is its dotted path without the token set. */
export interface ReadToken {
  name: string;
  kind: TokenKind;
  /** What it is for, from the tool's type or from the name: radius, spacing, border, lineHeight, letterSpacing… */
  use: string;
  /** The token it points at, when its value was a plain reference. */
  alias: string | null;
  color?: TokenColor;
  length?: Length;
  number?: number;
  families?: string[];
  shadows?: Shadow[];
  style?: TextStyle;
}
export interface TokenProblem {
  token: string;
  why: string;
}
export interface TokenRead {
  dialect: 'dtcg' | 'tokens-studio';
  sets: string[];
  tokens: ReadToken[];
  problems: TokenProblem[];
  /** The file is an export of the Histeon CSS panel: its tokens are the framework's own. */
  histeon: boolean;
  /** The files hold token sets of a dark theme: reading them again with `scheme: 'dark'` gives its tokens. */
  dark: boolean;
}
export interface TokenReadOptions {
  /** Which theme of a file of token sets to read: the sets of the other theme are left out. Light by default. */
  scheme?: 'light' | 'dark';
}

export const TOKEN_FILE_MAX = 8 * 1024 * 1024;
const TOKENS_MAX = 5000;
const DEPTH_MAX = 24;
const ROOT_PX = 16;

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The words of a name: `color.brandPrimary/500` → color, brand, primary, 500. */
function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// Colours

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function fromOklch(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (value: number) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
  return [gamma(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3), gamma(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3), gamma(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3)];
}

function oklchColor(l: number, c: number, h: number, alpha: number): TokenColor | null {
  const read = color(fromOklch(l, c, h), alpha);
  if (!read || l < 0 || l > 1 || c < 0 || c > 0.5) return read;
  return { ...read, oklch: `oklch(${round(l * 100, 2)}% ${round(c)} ${round(((h % 360) + 360) % 360, 2)})` };
}

function color(rgb: readonly [number, number, number], alpha = 1): TokenColor | null {
  if (![...rgb, alpha].every(Number.isFinite)) return null;
  const byte = (value: number) => Math.round(clamp(value, 0, 1) * 255);
  return { r: byte(rgb[0]), g: byte(rgb[1]), b: byte(rgb[2]), alpha: round(clamp(alpha, 0, 1), 3) };
}

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const alphaOf = (text: string | undefined) => (text === undefined ? 1 : text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text));

function parseColorText(input: string): TokenColor | null {
  const value = input.trim().toLowerCase();
  if (value === 'white') return { r: 255, g: 255, b: 255, alpha: 1 };
  if (value === 'black') return { r: 0, g: 0, b: 0, alpha: 1 };
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/u.exec(value);
  if (hex) {
    const digits = hex[1]!.length <= 4 ? [...hex[1]!].map((char) => char + char).join('') : hex[1]!;
    const byte = (at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), alpha: digits.length === 8 ? round(byte(6) / 255, 3) : 1 };
  }
  const call = new RegExp(String.raw`^(rgba?|hsla?|oklch)\(\s*(${NUMBER})(%|deg)?\s*[ ,]\s*(${NUMBER})(%)?\s*[ ,]\s*(${NUMBER})(%|deg)?\s*(?:[,/]\s*(${NUMBER}%?)\s*)?\)$`, 'u').exec(value);
  if (!call) return null;
  const [, fn, one, oneUnit, two, twoUnit, three, threeUnit, alpha] = call;
  const a = Number(one);
  const b = Number(two);
  const c = Number(three);
  if (fn!.startsWith('rgb')) {
    const channel = (n: number, unit: string | undefined) => (unit === '%' ? n / 100 : n / 255);
    return color([channel(a, oneUnit), channel(b, twoUnit), channel(c, threeUnit)], alphaOf(alpha));
  }
  if (fn!.startsWith('hsl')) return color(fromHsl(((a % 360) + 360) % 360, clamp(b / 100, 0, 1), clamp(c / 100, 0, 1)), alphaOf(alpha));
  return oklchColor(oneUnit === '%' || a > 1 ? a / 100 : a, b, c, alphaOf(alpha));
}

function parseColor(value: unknown): TokenColor | null {
  if (typeof value === 'string') return parseColorText(value);
  if (!plain(value)) return null;
  const alpha = typeof value.alpha === 'number' ? value.alpha : 1;
  const parts = Array.isArray(value.components) ? value.components.map((part) => (part === 'none' ? 0 : part)) : [];
  if (parts.length === 3 && parts.every((part): part is number => typeof part === 'number')) {
    const [a, b, c] = parts as [number, number, number];
    if (value.colorSpace === 'srgb') return color([a, b, c], alpha);
    if (value.colorSpace === 'hsl') return color(fromHsl(((a % 360) + 360) % 360, clamp(b / 100, 0, 1), clamp(c / 100, 0, 1)), alpha);
    if (value.colorSpace === 'oklch') return oklchColor(a, b, c, alpha);
  }
  // Any other colour space: the sRGB fallback the format lets a file carry.
  const fallback = typeof value.hex === 'string' ? parseColorText(value.hex) : null;
  return fallback ? { ...fallback, alpha: fallback.alpha === 1 ? round(clamp(alpha, 0, 1), 3) : fallback.alpha } : null;
}

const hexOf = (c: TokenColor) => `#${[c.r, c.g, c.b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
const colorCss = (c: TokenColor) => (c.alpha >= 0.999 ? hexOf(c) : `rgb(${c.r} ${c.g} ${c.b} / ${c.alpha})`);

// ---------------------------------------------------------------------------------------------------------------------
// Numbers, lengths and the formulas of Tokens Studio

type Unit = '' | 'px' | 'rem';
interface Quantity {
  n: number;
  unit: Unit;
}

/**
 * `16`, `16px`, `1rem`, `150%`, `{space.base} * 2`, `({a} + 4px) / 2`: numbers, lengths, references and the four
 * operations. Anything else (functions, other units) is not computed. Never evaluates code.
 */
function evaluate(text: string, ref: (name: string) => Quantity | null): Quantity | null {
  if (text.length > 200) return null;
  let at = 0;
  const skip = () => {
    while (text[at] === ' ') at++;
  };
  const join = (a: Quantity, b: Quantity, op: string): Quantity | null => {
    let unit: Unit = a.unit || b.unit;
    let x = a.n;
    let y = b.n;
    if (a.unit && b.unit && a.unit !== b.unit) {
      if (a.unit === 'rem') x *= ROOT_PX;
      if (b.unit === 'rem') y *= ROOT_PX;
      unit = 'px';
    }
    if (op === '*') return a.unit && b.unit ? null : { n: x * y, unit };
    if (op === '/') return y === 0 || (!a.unit && b.unit) ? null : { n: x / y, unit: a.unit && b.unit ? '' : unit };
    return { n: op === '+' ? x + y : x - y, unit };
  };
  const primary = (depth: number): Quantity | null => {
    skip();
    const char = text[at];
    if (char === '(') {
      at++;
      const inner = depth < 16 ? sum(depth + 1) : null;
      skip();
      if (text[at] !== ')') return null;
      at++;
      return inner;
    }
    if (char === '{') {
      const end = text.indexOf('}', at);
      if (end < 0) return null;
      const found = ref(text.slice(at + 1, end).trim());
      at = end + 1;
      return found;
    }
    if (char === '-') {
      at++;
      const negated = depth < 16 ? primary(depth + 1) : null;
      return negated ? { n: -negated.n, unit: negated.unit } : null;
    }
    const match = /^(\d+\.?\d*|\.\d+)(px|rem|%)?/u.exec(text.slice(at));
    if (!match) return null;
    at += match[0].length;
    if (match[2] === '%') return { n: Number(match[1]) / 100, unit: '' };
    return { n: Number(match[1]), unit: (match[2] ?? '') as Unit };
  };
  const chain =
    (next: (depth: number) => Quantity | null, ops: string) =>
    (depth: number): Quantity | null => {
      let left = next(depth);
      for (;;) {
        skip();
        const op = text[at];
        if (!left || op === undefined || !ops.includes(op)) return left;
        at++;
        const right = next(depth);
        left = right ? join(left, right, op) : null;
      }
    };
  const product = chain(primary, '*/');
  const sum: (depth: number) => Quantity | null = chain(product, '+-');
  const result = sum(0);
  skip();
  return result && at === text.length && Number.isFinite(result.n) ? result : null;
}

const WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji']);
/** A family name the design parameters accept: letters, digits, spaces and hyphens. */
const FONT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,79}$/u;

function parseFamilies(value: unknown): string[] | null {
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (!list?.length || list.length > 12) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') return null;
    const name = item
      .trim()
      .replace(/^(["'])(.*)\1$/u, '$2')
      .trim();
    if (!(FONT_NAME.test(name) || GENERIC_FONTS.has(name)) || name.endsWith('-')) return null;
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

/** The tool's type → kind and use. Tokens Studio and Penpot name the types of the standard in their own way. */
const TYPES: Record<string, readonly [TokenKind, string]> = {
  color: ['color', ''],
  dimension: ['dimension', ''],
  spacing: ['dimension', 'spacing'],
  sizing: ['dimension', 'sizing'],
  borderradius: ['dimension', 'radius'],
  borderwidth: ['dimension', 'border'],
  strokewidth: ['dimension', 'border'],
  letterspacing: ['dimension', 'letterSpacing'],
  paragraphspacing: ['dimension', 'spacing'],
  fontsizes: ['fontSize', 'fontSize'],
  fontsize: ['fontSize', 'fontSize'],
  fontfamilies: ['fontFamily', 'font'],
  fontfamily: ['fontFamily', 'font'],
  fontweights: ['fontWeight', 'weight'],
  fontweight: ['fontWeight', 'weight'],
  lineheights: ['number', 'lineHeight'],
  lineheight: ['number', 'lineHeight'],
  number: ['number', ''],
  opacity: ['number', 'opacity'],
  boxshadow: ['shadow', 'shadow'],
  shadow: ['shadow', 'shadow'],
  typography: ['typography', 'typography'],
};

/** What a token is for, by its name: the tools call a font size «number» or «dimension». */
function useOf(name: string): string {
  const w = new Set(words(name));
  const has = (...list: string[]) => list.some((word) => w.has(word));
  if (has('radius', 'radii', 'corner', 'rounded', 'raggio')) return 'radius';
  if (has('fontsize', 'textsize') || (has('size', 'sizes') && has('font', 'text', 'type', 'typography', 'heading', 'body', 'title', 'display'))) return 'fontSize';
  if (has('weight', 'weights', 'fontweight', 'peso')) return 'weight';
  if (has('lineheight', 'leading', 'interlinea') || (has('line') && has('height'))) return 'lineHeight';
  if (has('letterspacing', 'tracking') || (has('letter') && has('spacing'))) return 'letterSpacing';
  if (has('family', 'families', 'typeface', 'fontfamily')) return 'font';
  if (has('space', 'spacing', 'gap', 'padding', 'margin', 'inset', 'spazio', 'spazi')) return 'spacing';
  if (has('width') && has('border', 'stroke')) return 'border';
  if (has('opacity', 'alpha')) return 'opacity';
  return '';
}

interface RawToken {
  name: string;
  type: string;
  value: unknown;
}

const DARK_WORDS = ['dark', 'scuro', 'night', 'notte'];
const isDarkName = (name: string) => words(name).some((word) => DARK_WORDS.includes(word));

/**
 * The token sets of a Tokens Studio file to read for a scheme, in the order they apply. A theme (`$themes`) says
 * which sets it switches on; a set only the dark themes use belongs to the dark scheme, and without themes the name
 * of the set says it. For the dark scheme the dark sets come last, so that their values win.
 */
function setsFor(data: Record<string, unknown>, names: readonly string[], scheme: 'light' | 'dark'): { sets: string[]; dark: boolean } {
  const themes = Array.isArray(data.$themes) ? data.$themes.filter(plain) : [];
  const inDark = new Set<string>();
  const inLight = new Set<string>();
  for (const theme of themes) {
    const dark = isDarkName(`${typeof theme.group === 'string' ? theme.group : ''} ${typeof theme.name === 'string' ? theme.name : ''}`);
    for (const [set, status] of Object.entries(plain(theme.selectedTokenSets) ? theme.selectedTokenSets : {})) {
      if (status === 'enabled' || status === 'source') (dark ? inDark : inLight).add(set);
    }
  }
  const onlyDark = (set: string) => (inDark.size || inLight.size ? inDark.has(set) && !inLight.has(set) : isDarkName(set));
  const onlyLight = (set: string) => inDark.size > 0 && inLight.has(set) && !inDark.has(set);
  const sets = names.filter((set) => (scheme === 'dark' ? !onlyLight(set) : !onlyDark(set)));
  if (scheme === 'dark') sets.sort((a, b) => Number(onlyDark(a)) - Number(onlyDark(b)));
  return { sets, dark: names.some(onlyDark) };
}

/** Reads the exported files, in order: a later file or token set wins over an earlier one, as the tools apply them. */
export function readDesignTokens(files: readonly TokenFile[], options: TokenReadOptions = {}): TokenRead {
  if (!files.length) throw new Error('no-file');
  const raw = new Map<string, RawToken>();
  const problems: TokenProblem[] = [];
  const sets: string[] = [];
  let dialect: TokenRead['dialect'] = 'dtcg';
  let histeon = false;
  let dark = false;

  const walk = (node: Record<string, unknown>, path: string[], inherited: string, depth: number): void => {
    const legacy = !('$value' in node) && 'value' in node && typeof node.type === 'string';
    if ('$value' in node || legacy) {
      if (!path.length) return;
      const type = typeof node.$type === 'string' ? node.$type : legacy ? String(node.type) : inherited;
      const name = path.join('.');
      raw.delete(name);
      raw.set(name, { name, type, value: legacy ? node.value : node.$value });
      if (raw.size > TOKENS_MAX) throw new Error('too-many');
      return;
    }
    if (depth >= DEPTH_MAX) {
      problems.push({ token: path.join('.'), why: t('gruppi annidati oltre il limite') });
      return;
    }
    const type = typeof node.$type === 'string' ? node.$type : inherited;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !plain(child)) continue;
      walk(child, [...path, key], type, depth + 1);
    }
  };

  for (const file of files) {
    if (new TextEncoder().encode(file.text).length > TOKEN_FILE_MAX) throw new Error('too-large');
    let data: unknown;
    try {
      data = JSON.parse(file.text);
    } catch {
      throw new Error('not-json');
    }
    if (!plain(data)) {
      // `$themes.json` of a Penpot export in several files is a list: it holds no token.
      problems.push({ token: file.name, why: t('il file non contiene token') });
      continue;
    }
    const before = raw.size;
    if ('$themes' in data || '$metadata' in data) {
      dialect = 'tokens-studio';
      const metadata = plain(data.$metadata) ? data.$metadata : {};
      const order = Array.isArray(metadata.tokenSetOrder) ? metadata.tokenSetOrder.filter((set): set is string => typeof set === 'string') : [];
      const names = [...new Set([...order, ...Object.keys(data)])].filter((key) => !key.startsWith('$') && plain(data[key]));
      const chosen = setsFor(data, names, options.scheme ?? 'light');
      dark ||= chosen.dark;
      for (const set of chosen.sets) {
        walk(data[set] as Record<string, unknown>, [], '', 0);
        sets.push(set);
      }
    } else {
      if (plain(data.$extensions) && 'histeon.css' in data.$extensions) histeon = true;
      walk(data, [], '', 0);
      sets.push(file.name);
    }
    if (raw.size === before && !problems.some((problem) => problem.token === file.name)) problems.push({ token: file.name, why: t('il file non contiene token') });
  }

  // A reference names a token without its set; a file of sets without `$themes` has the set as the first word.
  const tails = new Map<string, RawToken | null>();
  for (const token of raw.values()) {
    const dot = token.name.indexOf('.');
    if (dot < 0) continue;
    const tail = token.name.slice(dot + 1);
    tails.set(tail, tails.has(tail) ? null : token);
  }
  const find = (ref: string): RawToken | null => raw.get(ref) ?? raw.get(ref.replaceAll('/', '.')) ?? tails.get(ref) ?? null;

  const done = new Map<string, ReadToken | null>();
  const resolving = new Set<string>();
  const fail = (token: string, why: string): null => {
    problems.push({ token, why });
    return null;
  };

  const resolve = (token: RawToken): ReadToken | null => {
    const known = done.get(token.name);
    if (known !== undefined) return known;
    if (resolving.has(token.name)) return fail(token.name, t('rimandi in cerchio'));
    if (resolving.size >= 32) return fail(token.name, t('rimandi troppo profondi'));
    resolving.add(token.name);
    const result = classify(token);
    resolving.delete(token.name);
    done.set(token.name, result);
    return result;
  };
  /** The token a `{reference}` points at, resolved; null when the value is not a plain reference. */
  const target = (value: unknown): ReadToken | null | undefined => {
    const match = typeof value === 'string' ? /^\{([^{}]+)\}$/u.exec(value.trim()) : null;
    if (!match) return undefined;
    const found = find(match[1]!.trim());
    return found ? resolve(found) : null;
  };
  const quantity = (value: unknown): Quantity | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? { n: value, unit: '' } : null;
    if (plain(value) && typeof value.value === 'number' && (value.unit === 'px' || value.unit === 'rem')) return { n: value.value, unit: value.unit };
    if (typeof value !== 'string') return null;
    return evaluate(value.trim(), (name) => {
      const found = find(name);
      const read = found ? resolve(found) : null;
      if (read?.length) return { n: read.length.unit === 'rem' ? read.length.px / ROOT_PX : read.length.px, unit: read.length.unit };
      return read?.number !== undefined ? { n: read.number, unit: '' } : null;
    });
  };
  const length = (value: unknown): Length | null => {
    const q = quantity(value);
    // A bare number is pixels, as in the tools.
    return q ? { px: round(q.unit === 'rem' ? q.n * ROOT_PX : q.n), unit: q.unit === 'rem' ? 'rem' : 'px' } : null;
  };
  const colorOf = (value: unknown): TokenColor | null => {
    const pointed = target(value);
    return pointed === undefined ? parseColor(value) : (pointed?.color ?? null);
  };
  const familiesOf = (value: unknown): string[] | null => {
    const pointed = target(value);
    return pointed === undefined ? parseFamilies(value) : (pointed?.families ?? null);
  };
  const weightOf = (value: unknown): number | null => {
    const pointed = target(value);
    if (pointed !== undefined) return pointed?.number ?? null;
    const named =
      typeof value === 'string'
        ? WEIGHTS[
            words(value)
              .filter((word) => word !== 'italic')
              .join('')
          ]
        : undefined;
    const n = named ?? (typeof value === 'number' || (typeof value === 'string' && /^\d+$/u.test(value.trim())) ? Number(value) : Number.NaN);
    return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
  };

  function classify(token: RawToken): ReadToken | null {
    const own = useOf(token.name);
    const pointed = target(token.value);
    if (pointed !== undefined) {
      const ref = /^\{([^{}]+)\}$/u.exec(String(token.value).trim())![1]!.trim();
      const braced = `{${ref}}`;
      if (!pointed) return find(ref) ? fail(token.name, t('rimanda a {0}, che non è stato letto', braced)) : fail(token.name, t('rimanda a {0}, che non c’è', braced));
      return { ...pointed, name: token.name, alias: pointed.name, use: own || pointed.use };
    }
    const type = token.type.toLowerCase();
    let [kind, use] = TYPES[type] ?? [null, ''];
    if (!kind && typeof token.value === 'string' && parseColorText(token.value)) kind = 'color';
    if ((type === 'string' || type === 'text') && own === 'font') kind = 'fontFamily';
    if (!kind) return fail(token.name, type ? t('tipo «{0}» non convertito', token.type) : t('senza tipo'));
    use = use || own;
    // The tools call a font size, a radius or a weight «number» or «dimension»: the name says what it is.
    if ((kind === 'number' || kind === 'dimension') && use === 'fontSize') kind = 'fontSize';
    else if (kind === 'number' && ['radius', 'spacing', 'border', 'sizing', 'letterSpacing'].includes(use)) kind = 'dimension';
    else if (kind === 'number' && use === 'weight') kind = 'fontWeight';
    const base = { name: token.name, kind, use, alias: null };

    if (kind === 'color') {
      const read = parseColor(token.value);
      return read ? { ...base, color: read } : fail(token.name, t('colore non letto'));
    }
    if (kind === 'dimension' || kind === 'fontSize') {
      const read = length(token.value);
      return read ? { ...base, length: read } : fail(token.name, typeof token.value === 'string' && /[{(*/+]/u.test(token.value) ? t('formula non calcolata') : t('misura non letta (solo px e rem)'));
    }
    if (kind === 'number') {
      const read = quantity(token.value);
      return read && !read.unit ? { ...base, number: round(read.n) } : fail(token.name, t('numero non letto'));
    }
    if (kind === 'fontFamily') {
      const read = parseFamilies(token.value);
      return read ? { ...base, families: read } : fail(token.name, t('nome del carattere non ammesso'));
    }
    if (kind === 'fontWeight') {
      const read = weightOf(token.value);
      return read ? { ...base, number: read } : fail(token.name, t('peso non letto'));
    }
    if (kind === 'shadow') {
      const list = Array.isArray(token.value) ? token.value : [token.value];
      const shadows: Shadow[] = [];
      for (const item of list.slice(0, 8)) {
        if (!plain(item)) return fail(token.name, t('ombra non letta'));
        const shade = colorOf(item.color);
        const [x, y, blur, spread] = [item.offsetX ?? item.x, item.offsetY ?? item.y, item.blur ?? 0, item.spread ?? 0].map(length);
        if (!shade || !x || !y || !blur || !spread) return fail(token.name, t('ombra non letta'));
        shadows.push({ x, y, blur, spread, color: shade, inset: item.inset === true || item.type === 'innerShadow' || item.type === 'inner' });
      }
      return shadows.length ? { ...base, shadows } : fail(token.name, t('ombra non letta'));
    }
    if (!plain(token.value)) return fail(token.name, t('stile di testo non letto'));
    const value = token.value;
    const style: TextStyle = {};
    const families = familiesOf(value.fontFamily ?? value.fontFamilies);
    const size = length(value.fontSize ?? value.fontSizes);
    const weight = weightOf(value.fontWeight ?? value.fontWeights);
    const leading = quantity(value.lineHeight ?? value.lineHeights);
    if (families) style.families = families;
    if (size) style.sizePx = size.px;
    if (weight) style.weight = weight;
    // A line height in pixels is a ratio of the font size.
    if (leading && !leading.unit && leading.n <= 4) style.leading = round(leading.n, 3);
    else if (leading && size && size.px > 0) style.leading = round((leading.unit === 'rem' ? leading.n * ROOT_PX : leading.n) / size.px, 3);
    return { ...base, style };
  }

  const tokens: ReadToken[] = [];
  for (const token of raw.values()) {
    const read = resolve(token);
    if (read) tokens.push(read);
  }
  return { dialect, sets, tokens, problems, histeon, dark };
}

// ---------------------------------------------------------------------------------------------------------------------
// From tokens to the panel's parameters

const FAMILY_WORDS: Record<string, readonly string[]> = {
  primary: ['primary', 'primario'],
  secondary: ['secondary', 'secondario'],
  tertiary: ['tertiary', 'terziario'],
  accent: ['accent', 'accento'],
  neutral: ['neutral', 'neutro', 'gray', 'grey', 'grigio'],
  success: ['success', 'successo', 'positive'],
  warning: ['warning', 'avviso', 'caution'],
  danger: ['danger', 'error', 'errore', 'negative', 'destructive', 'critical'],
  info: ['info', 'information', 'informative'],
};
/** A colour named for where it is used is not the colour of a family. */
const USAGE_WORDS = new Set(
  'on text bg background border foreground fg contrast surface muted subtle hover active focus pressed disabled link button btn card input icon outline ring overlay shadow heading title container gradient sfondo testo bordo sfumatura'.split(' '),
);
const GROUP_WORDS = new Set('color colors colour colours colore colori palette core global base theme semantic default main brand solid'.split(' '));
const VARIANT_WORDS = new Set('light lighter lightest dark darker darkest tint shade chiaro scuro'.split(' '));
const HEADING_WORDS = ['heading', 'headings', 'headline', 'title', 'titles', 'display', 'titolo', 'titoli', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const BODY_WORDS = ['body', 'text', 'paragraph', 'base', 'default', 'sans', 'primary', 'testo', 'corpo', 'copy'];
const MONO_WORDS = ['mono', 'code', 'monospace', 'codice'];
const MIDDLE_WORDS = ['m', 'md', 'medium', 'base', 'default', 'regular', 'normal'];
const FAMILIES: readonly string[] = FAMILY_LABELS.map(([key]) => key);
const SHADE_SET = new Set<number>(SHADES);
const LIMITS = new Map(OPTIONS.flatMap((o) => (o.kind === 'number' ? [[o.key, [o.min, o.max]] as const] : [])));
/** As many variables as a site can hold (SiteTokens::MAX). */
export const SITE_MAX = 200;

interface FamilyColor {
  family: string;
  /** 0 for the family's own colour, higher for its shades; 30 for a light or dark variant. */
  rank: number;
  shade: number | null;
}

function familyColor(name: string): FamilyColor | null {
  const w = words(name);
  if (w.some((word) => USAGE_WORDS.has(word))) return null;
  let found = FAMILIES.filter((family) => FAMILY_WORDS[family]!.some((word) => w.includes(word)));
  // «brand» or «main» alone is the primary colour; next to a family (brand.secondary) it is a group.
  if (!found.length && (w.includes('brand') || w.includes('main'))) found = ['primary'];
  if (found.length !== 1) return null;
  const family = found[0]!;
  // What comes before the family is a group (feedback.error); what comes after says which colour of the family.
  const at = w.findIndex((word) => FAMILY_WORDS[family]!.includes(word) || ((word === 'brand' || word === 'main') && family === 'primary'));
  const rest = w.slice(at + 1).filter((word) => !FAMILY_WORDS[family]!.includes(word) && !GROUP_WORDS.has(word));
  if (!rest.length) return { family, rank: 0, shade: null };
  if (rest.length > 1) return null;
  const word = rest[0]!;
  if (VARIANT_WORDS.has(word)) return { family, rank: 30, shade: null };
  if (!/^\d{1,4}$/u.test(word)) return null;
  const n = Number(word);
  // 50…950 with 500 in the middle; a scale of twelve steps has its solid colour at 9.
  return { family, rank: n > 12 ? 1 + Math.abs(n - 500) / 100 : 1 + Math.abs(n - 9), shade: n };
}

/** A name for a variable of the site: lowercase letters, digits and single hyphens, at most 40 characters. */
function slug(name: string, taken: Set<string>): string {
  const base = words(name).join('-').slice(0, 40).replace(/-+$/u, '') || 'token';
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base.slice(0, 40 - String(n).length - 1).replace(/-+$/u, '')}-${n}`;
  taken.add(out);
  return out;
}

const lengthCss = (length: Length) => {
  if (length.px === 0) return '0';
  // Hairlines stay in pixels; everything else follows the root size.
  if (length.unit === 'px' && Math.abs(length.px) < 4) return `${round(length.px, 3)}px`;
  return `${round(length.px / ROOT_PX)}rem`;
};
const shadowCss = (shadows: readonly Shadow[]) => shadows.map((s) => `${s.inset ? 'inset ' : ''}${lengthCss(s.x)} ${lengthCss(s.y)} ${lengthCss(s.blur)} ${lengthCss(s.spread)} ${colorCss(s.color)}`).join(', ');

function fontStack(families: readonly string[], mono: boolean): string {
  const list = families.map((name) => (name.includes(' ') ? `"${name}"` : name));
  if (!GENERIC_FONTS.has(families.at(-1)!)) list.push(...(mono ? ['ui-monospace', 'monospace'] : ['system-ui', 'sans-serif']));
  return list.join(', ');
}

export interface TokenImportReport {
  dialect: TokenRead['dialect'];
  sets: string[];
  read: number;
  /** Tokens that became a design parameter. */
  mapped: Array<{ param: string; token: string; value: string }>;
  /** Tokens that became a variable of the site. */
  site: Array<{ name: string; token: string }>;
  /** Shades of a colour family: the framework makes its own. */
  shades: Record<string, string[]>;
  /** Text sizes and composite styles with a size: matched to a step by textSizeSteps(), never written as lengths. */
  sizes: Array<{ token: string; px: number; heading: boolean }>;
  /** Font families to get: a token names a font, it never carries the file or its licence. */
  fonts: string[];
  skipped: TokenProblem[];
  notes: string[];
}

export interface TokenImport {
  /** Only the parameters the tokens set: the panel puts them over the values it has. */
  design: DesignParams;
  /** The other tokens, as variables of the site: names without `xb-site-`. */
  siteTokens: Record<string, string>;
  report: TokenImportReport;
}

/** The colour of each family: its own token, or the shade nearest the middle. */
function familyColors(tokens: readonly ReadToken[]): { main: Map<string, ReadToken>; shades: Map<string, FamilyColor> } {
  const best = new Map<string, { token: ReadToken; rank: number }>();
  const all = new Map<string, FamilyColor>();
  for (const token of tokens) {
    if (token.kind !== 'color' || !token.color || token.color.alpha < 0.999) continue;
    const found = familyColor(token.name);
    if (!found) continue;
    all.set(token.name, found);
    const now = best.get(found.family);
    const rank = found.rank + words(token.name).length / 100;
    if (found.rank < 30 && (!now || rank < now.rank)) best.set(found.family, { token, rank });
  }
  const main = new Map([...best].map(([family, { token }]) => [family, token]));
  // Without a colour of its own a family keeps its variants as plain tokens.
  for (const [name, found] of [...all]) if (!main.has(found.family)) all.delete(name);
  return { main, shades: all };
}

/**
 * Design parameters and site variables from the tokens read. Values are rebuilt from parsed numbers and colours and
 * kept inside the limits of the panel's options; the server validates them again (design/preview) before the panel
 * takes them, and the site variables when they are saved.
 */
export function importDesignTokens(read: TokenRead, options: { dark?: TokenRead | null } = {}): TokenImport {
  const report: TokenImportReport = { dialect: read.dialect, sets: read.sets, read: read.tokens.length, mapped: [], site: [], shades: {}, sizes: [], fonts: [], skipped: [...read.problems], notes: [] };
  const design: DesignParams = {};
  /** Token → the Histeon CSS token that now holds its value. */
  const holder = new Map<string, string>();
  const has = (token: ReadToken, list: readonly string[]) => {
    const w = words(token.name);
    return list.some((word) => w.includes(word));
  };
  const set = (param: string, value: string | number, token: ReadToken, held?: string): boolean => {
    const limit = LIMITS.get(param);
    if (typeof value === 'number' && limit && (value < limit[0] || value > limit[1])) {
      report.skipped.push({ token: token.name, why: t('{0}: {1} è fuori dai limiti ({2}–{3})', param, value, limit[0], limit[1]) });
      return false;
    }
    design[param] = value;
    report.mapped.push({ param, token: token.name, value: String(value) });
    if (held) holder.set(token.name, held);
    return true;
  };

  // Colours.
  const { main, shades } = familyColors(read.tokens);
  for (const family of FAMILIES) {
    const token = main.get(family);
    if (!token?.color) continue;
    set(family, token.color.oklch ?? hexOf(token.color), token, `xb-${family}`);
    if (family === 'tertiary') design.tertiary_on = 1;
  }
  for (const [name, found] of shades) {
    if (holder.has(name) || design[found.family] === undefined) continue;
    report.shades[found.family] = [...(report.shades[found.family] ?? []), name];
    holder.set(name, found.shade !== null && SHADE_SET.has(found.shade) ? `xb-${found.family}-${found.shade}` : '');
  }

  // Fonts: a token of its own first, then a composite text style.
  const fontTokens = read.tokens.filter((token) => token.alias === null && (token.kind === 'fontFamily' ? token.families : token.style?.families));
  fontTokens.sort((a, b) => Number(a.kind !== 'fontFamily') - Number(b.kind !== 'fontFamily') || a.name.length - b.name.length);
  const familiesOf = (token: ReadToken) => token.families ?? token.style?.families ?? [];
  const named = new Set<string>();
  for (const token of read.tokens) for (const name of familiesOf(token)) if (!GENERIC_FONTS.has(name)) named.add(name);
  report.fonts = [...named];
  const mono = fontTokens.find((token) => has(token, MONO_WORDS));
  const heading = fontTokens.find((token) => token !== mono && has(token, HEADING_WORDS));
  const plainFonts = fontTokens.filter((token) => token !== mono && token !== heading && token.kind === 'fontFamily');
  const body = fontTokens.find((token) => token !== mono && token !== heading && has(token, BODY_WORDS)) ?? (plainFonts.length === 1 ? plainFonts[0] : undefined);
  if (body) set('font_body', fontStack(familiesOf(body), false), body, body.kind === 'fontFamily' ? 'xb-font-body' : undefined);
  if (heading) set('font_heading', fontStack(familiesOf(heading), false), heading, heading.kind === 'fontFamily' ? 'xb-font-heading' : undefined);
  else if (body && design.font_body !== undefined) {
    design.font_heading = design.font_body;
    report.notes.push(t('Nessun carattere per i titoli nel design: i titoli usano quello del testo.'));
  }
  if (mono) set('font_mono', fontStack(familiesOf(mono), true), mono, mono.kind === 'fontFamily' ? 'xb-font-mono' : undefined);

  // The base text size. Design tools draw one screen: that size is the large one, the small one never exceeds 16.
  const sizes = read.tokens.filter((token) => token.kind === 'fontSize' && token.length);
  const lastWord = (token: ReadToken) => words(token.name).at(-1) ?? '';
  const baseSize =
    sizes.find((token) => !has(token, HEADING_WORDS) && (MIDDLE_WORDS.includes(lastWord(token)) || has(token, ['body', 'paragraph', 'testo', 'corpo']))) ??
    // A library has several body styles (small, medium, large): the one nearest 16 px is the running text.
    read.tokens
      .filter((token) => token.kind === 'typography' && token.style?.sizePx && has(token, ['body', 'paragraph', 'testo', 'corpo']) && !has(token, HEADING_WORDS))
      .sort((x, y) => Math.abs(x.style!.sizePx! - 16) - Math.abs(y.style!.sizePx! - 16))[0];
  const basePx = baseSize?.length?.px ?? baseSize?.style?.sizePx;
  if (baseSize && basePx !== undefined && set('text_max', round(basePx, 2), baseSize)) {
    if (!set('text_min', round(Math.min(basePx, 16), 2), baseSize)) delete design.text_max;
  }

  // Leading and heading weight, from tokens of their own or from the text styles.
  const pick = (kind: 'weight' | 'leading', list: readonly string[], not: readonly string[] = []) => {
    for (const token of read.tokens) {
      if (!has(token, list) || has(token, not)) continue;
      const value = kind === 'weight' ? (token.kind === 'fontWeight' ? token.number : token.style?.weight) : token.kind === 'number' && token.use === 'lineHeight' ? token.number : token.style?.leading;
      if (value !== undefined) return { token, value };
    }
    return null;
  };
  const headingWeight = pick('weight', HEADING_WORDS);
  if (headingWeight) set('heading_weight', clamp(Math.round(headingWeight.value / 100) * 100, 100, 900), headingWeight.token);
  const headingLeading = pick('leading', HEADING_WORDS);
  if (headingLeading) set('heading_leading', round(headingLeading.value, 2), headingLeading.token);
  // The leading of the style the base size came from, before that of any other body style.
  const textLeading =
    (baseSize?.kind === 'typography' && baseSize.style?.leading !== undefined ? { token: baseSize, value: baseSize.style.leading } : null) ??
    pick('leading', ['body', 'paragraph', 'text', 'base', 'testo', 'corpo'], HEADING_WORDS);
  if (textLeading) set('text_leading', round(textLeading.value, 2), textLeading.token);

  // The radius in the middle of the scale; a pill (999px) is not a size.
  const radii = read.tokens.filter((token) => token.kind === 'dimension' && token.use === 'radius' && token.alias === null && token.length && token.length.px > 0 && token.length.px <= 64);
  radii.sort((a, b) => a.length!.px - b.length!.px);
  const radius = radii.find((token) => MIDDLE_WORDS.includes(lastWord(token))) ?? radii[Math.floor((radii.length - 1) / 2)];
  if (radius) set('radius', round(radius.length!.px, 2), radius, 'xb-radius-m');

  // The dark mode: the same families, where their colour changes.
  if (options.dark) {
    // A file of token sets is read twice, once for each theme: what the light reading already said is not said again.
    const said = new Set(read.problems.map((problem) => `${problem.token}\n${problem.why}`));
    report.skipped.push(...options.dark.problems.filter((problem) => !said.has(`${problem.token}\n${problem.why}`)).map((problem) => ({ token: t('{0} (scuro)', problem.token), why: problem.why })));
    design.dark_on = 1;
    const darkMain = familyColors(options.dark.tokens).main;
    for (const family of FAMILIES) {
      const light = main.get(family);
      const dark = darkMain.get(family);
      if (!light?.color || !dark?.color || design[family] === undefined || hexOf(light.color) === hexOf(dark.color)) continue;
      set(`${family}_dark`, dark.color.oklch ?? hexOf(dark.color), dark);
    }
    report.notes.push(t('Tema scuro acceso. Si importano i colori delle famiglie; le altre differenze del tema scuro restano da fare a mano nel pannello.'));
  }

  // Text sizes: never a length. The panel matches each to the nearest step once the server has computed the scale.
  for (const token of read.tokens) {
    const px = token.kind === 'fontSize' ? token.length?.px : token.kind === 'typography' ? token.style?.sizePx : undefined;
    if (px !== undefined) report.sizes.push({ token: token.name, px, heading: has(token, HEADING_WORDS) });
  }

  // Everything else: a variable of the site. An export of Histeon CSS holds the framework's own tokens: none is added.
  const taken = new Set<string>();
  const leftovers: Array<{ token: ReadToken; slug: string }> = [];
  if (read.histeon) report.notes.push(t('Il file è un’esportazione di Histeon CSS: si leggono i parametri principali. Per copiare un design intero fra due siti usa «Esporta» e «Importa».'));
  else {
    for (const token of read.tokens) {
      if (holder.has(token.name) || token.kind === 'fontSize' || token.kind === 'typography') continue;
      if (report.mapped.some((item) => item.token === token.name)) continue;
      leftovers.push({ token, slug: slug(token.name, taken) });
    }
  }
  const slugs = new Map(leftovers.map((item) => [item.token.name, item.slug]));
  const literal = (token: ReadToken): string | null => {
    if (token.kind === 'color' && token.color) return colorCss(token.color);
    if (token.kind === 'dimension' && token.length) return lengthCss(token.length);
    if ((token.kind === 'number' || token.kind === 'fontWeight') && token.number !== undefined) return String(token.number);
    if (token.kind === 'fontFamily' && token.families) return token.families.join(', ');
    if (token.kind === 'shadow' && token.shadows) return shadowCss(token.shadows);
    return null;
  };
  // First what each token is worth by itself, so that a reference only ever points at a variable that is written.
  const kept = new Map<string, { token: ReadToken; value: string }>();
  for (const { token, slug: name } of leftovers) {
    const value = literal(token);
    if (value === null) continue;
    const problem = kept.size >= SITE_MAX ? t('oltre le {0} variabili del sito', SITE_MAX) : (siteNameProblem(name) ?? tokenProblem(value));
    if (problem) report.skipped.push({ token: token.name, why: problem });
    else kept.set(name, { token, value });
  }
  const siteTokens: Record<string, string> = {};
  for (const [name, { token, value }] of kept) {
    const held = token.alias ? holder.get(token.alias) : undefined;
    const slugOf = token.alias ? slugs.get(token.alias) : undefined;
    const pointed = slugOf !== undefined && kept.has(slugOf) ? slugOf : undefined;
    siteTokens[name] = held ? `var(--${held})` : pointed ? `var(--${SITE_PREFIX}${pointed})` : value;
    report.site.push({ name, token: token.name });
  }
  if (!report.mapped.length) report.notes.push(t('Nessun token è stato riconosciuto come colore di famiglia, carattere, misura base o raggio: il design resta com’è.'));
  return { design, siteTokens, report };
}

/**
 * The step of the scale nearest each text size of the tokens: `tokens` are the printed tokens of the design
 * (`xb-text-l` → `clamp(…, 1.4rem)`), as the server computes them. A size never becomes a fixed length.
 */
export function textSizeSteps(sizes: TokenImportReport['sizes'], tokens: Record<string, string>): Array<{ token: string; px: number; step: string; stepPx: number }> {
  const steps = new Map<string, number>();
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^xb-(?:text-(?:xs|s|m|l|xl|[234]xl)|h[1-6])$/u.test(name)) continue;
    const size = /(\d+\.?\d*)rem\s*\)?$/u.exec(String(value));
    if (size) steps.set(name, round(Number(size[1]) * ROOT_PX, 1));
  }
  const out: Array<{ token: string; px: number; step: string; stepPx: number }> = [];
  for (const item of sizes) {
    const wanted = item.heading ? /^xb-h/u : /^xb-text-/u;
    let nearest: [string, number] | null = null;
    for (const [step, size] of steps) if (wanted.test(step) && (!nearest || Math.abs(size - item.px) < Math.abs(nearest[1] - item.px))) nearest = [step, size];
    if (nearest) out.push({ token: item.token, px: item.px, step: nearest[0], stepPx: nearest[1] });
  }
  return out;
}

/** The report of an import, a line each, in the reader's language. */
export function tokenImportLines(report: TokenImportReport, steps: ReturnType<typeof textSizeSteps> = []): string[] {
  const lines: string[] = [];
  lines.push(report.dialect === 'tokens-studio' ? t('Token letti: {0} (formato Tokens Studio, come li esporta Penpot).', report.read) : t('Token letti: {0} (formato DTCG).', report.read));
  for (const item of report.mapped) lines.push(t('{0} = {1} (da {2})', item.param, item.value, item.token));
  for (const [family, tokens] of Object.entries(report.shades)) lines.push(t('{0}: {1} sfumature non importate, le calcola Histeon CSS dal colore della famiglia.', family, tokens.length));
  if (report.site.length) lines.push(t('Variabili del sito: {0}.', report.site.length));
  for (const item of steps) lines.push(t('{0}: {1} px → --{2} ({3} px). Le misure di testo non diventano misure fisse.', item.token, item.px, item.step, item.stepPx));
  if (report.fonts.length) lines.push(t('Caratteri da procurare (il file e la licenza non stanno nei token): {0}.', report.fonts.join(', ')));
  for (const item of report.skipped) lines.push(t('Non convertito: {0} ({1}).', item.token, item.why));
  lines.push(...report.notes);
  return lines;
}

/** The format of a file of site variables (Histeon Publish writes it: `histos-publish tokens`). */
export const SITE_VARIABLES_FORMAT = 'histeon-variabili-sito';

/**
 * A file of variables for the site, read: `variabili-sito.json` (`{ format, version: 1, variabili: { name: value } }`)
 * or a file of design tokens (DTCG, Tokens Studio), whose tokens without a design parameter become variables. Names
 * and values follow the rules of the server (SiteTokens), which checks them again when they are saved.
 */
export function parseSiteVariables(files: readonly TokenFile[]): { variables: Record<string, string>; skipped: TokenProblem[] } {
  if (files.length === 1) {
    let data: unknown;
    try {
      data = JSON.parse(files[0]!.text);
    } catch {
      throw new Error('not-json');
    }
    if (plain(data) && data.format === SITE_VARIABLES_FORMAT) {
      if (data.version !== 1 || !plain(data.variabili)) throw new Error('not-variables');
      const entries = Object.entries(data.variabili);
      if (entries.length > SITE_MAX) throw new Error('too-many');
      const variables: Record<string, string> = {};
      const skipped: TokenProblem[] = [];
      for (const [name, value] of entries) {
        const problem = siteNameProblem(name) ?? (typeof value === 'string' ? tokenProblem(value) : t('serve un testo.'));
        if (problem) skipped.push({ token: name, why: problem });
        else variables[name] = String(value).trim();
      }
      return { variables, skipped };
    }
  }
  const result = importDesignTokens(readDesignTokens(files));
  return { variables: result.siteTokens, skipped: result.report.skipped };
}
