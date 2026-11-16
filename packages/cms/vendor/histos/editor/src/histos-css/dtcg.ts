// «Export tokens (DTCG)» of the Histeon CSS panel: the tokens the server computed (Tokens::export, through
// design/preview with `tokens: true`) as a Design Tokens Community Group file, format 2025.10
// (https://www.designtokens.org/tr/2025.10/format/). Pure: no DOM, no server; nothing is recomputed here.
//
// Names lose `xb-` and are grouped by type, then by family: `color.primary.500`, `dimension.radius.m`,
// `fontFamily.font-body`, `fontWeight.btn-weight`, `shadow.shadow-m`. A token whose name is also a group becomes
// `….base` (`color.primary.base`). `var(--xb-x)` becomes an alias `{…}` when its target is exported. What the format
// cannot hold is left out and listed in the root `$extensions`: CSS formulas (clamp(), calc(), max()…), lengths in
// units the format does not admit (em, ch, %, vw…) and values of other types (numbers, keywords, durations), each
// with its CSS value. An alias of a token left out is left out for the same reason.

import { oklchToHex } from '../lib/oklch.ts';

export type DtcgType = 'color' | 'dimension' | 'fontFamily' | 'fontWeight' | 'shadow';
export type Skip = 'formula' | 'unit' | 'type';
export type DtcgGroup = { [key: string]: unknown };

/** Where the left-out tokens are listed. */
export const EXTENSION = 'histeon.css';

export interface DtcgResult {
  doc: DtcgGroup;
  /** Tokens written to the file. */
  exported: number;
  /** Token names (without `xb-`) left out, by reason. */
  skipped: Record<Skip, string[]>;
}

interface ColorValue {
  colorSpace: 'oklch' | 'srgb';
  components: number[];
  alpha?: number;
  hex: string;
}
interface Dimension { value: number; unit: 'px' | 'rem' }
type Parsed = { type: DtcgType; value: unknown } | { skip: Skip } | { alias: string };

const round = (n: number, digits = 4) => Number(n.toFixed(digits));
const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const ALIAS = /^var\(--xb-([a-z0-9-]+)\)$/;

/** `oklch(55% 0.2 265)`, `oklch(0% 0 0 / 0.5)` or `#rrggbb`, as a DTCG colour; null otherwise. */
export function parseColor(value: string): ColorValue | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    const hex = v.toLowerCase();
    return { colorSpace: 'srgb', components: [1, 3, 5].map((i) => round(Number.parseInt(hex.slice(i, i + 2), 16) / 255)), hex };
  }
  const m = new RegExp(String.raw`^oklch\(\s*(${NUMBER})(%?)\s+(${NUMBER})\s+(${NUMBER})(?:deg)?\s*(?:/\s*(${NUMBER})(%?))?\s*\)$`, 'i').exec(v);
  if (!m) return null;
  const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const hue = ((Number(m[4]) % 360) + 360) % 360;
  const out: ColorValue = { colorSpace: 'oklch', components: [round(L), round(Number(m[3])), round(hue)], hex: oklchToHex(`oklch(${L} ${m[3]} ${hue})`) };
  if (m[5] !== undefined) {
    const alpha = m[6] ? Number(m[5]) / 100 : Number(m[5]);
    if (alpha < 1) out.alpha = round(alpha);
  }
  return out;
}

/** `12px`, `0.5rem` or `0`: a DTCG dimension; `'unit'` for a length the format does not admit; null otherwise. */
export function parseDimension(value: string): Dimension | 'unit' | null {
  const v = value.trim();
  if (v === '0') return { value: 0, unit: 'px' };
  const m = new RegExp(`^(${NUMBER})(px|rem)$`).exec(v);
  if (m) return { value: Number(m[1]), unit: m[2] as 'px' | 'rem' };
  return new RegExp(`^${NUMBER}(em|ch|ex|lh|%|vw|vh|vi|vb|vmin|vmax|svh|dvh|lvh|cqi|cqw)$`).test(v) ? 'unit' : null;
}

/** A shadow written by the panel, `0 4px 12px oklch(0% 0 0 / 0.1)` (offset x, y, blur, optional spread, colour). */
function parseShadow(value: string): object | null {
  const m = new RegExp(String.raw`^(${NUMBER}(?:px|rem)?)\s+(${NUMBER}(?:px|rem)?)(?:\s+(${NUMBER}(?:px|rem)?))?(?:\s+(${NUMBER}(?:px|rem)?))?\s+(oklch\([^()]*\)|#[0-9a-f]{6})(\s+inset)?$`, 'i').exec(value.trim());
  if (!m) return null;
  const dims = [m[1], m[2], m[3] ?? '0', m[4] ?? '0'].map((d) => parseDimension(d!));
  const color = parseColor(m[5]!);
  if (!color || dims.some((d) => d === null || d === 'unit')) return null;
  const [offsetX, offsetY, blur, spread] = dims;
  return { color, offsetX, offsetY, blur, spread, ...(m[6] ? { inset: true } : {}) };
}

/** A font stack as the list of its families, quotes taken away. */
function parseFamilies(value: string): string[] | null {
  const parts = value.split(',').map((p) => p.trim().replace(/^(['"])(.*)\1$/, '$2'));
  return parts.every((p) => p !== '' && !/[()]/.test(p)) ? parts : null;
}

/**
 * The type of one token, by its name and literal value. Colours from `color-mix(in oklch, var(--xb-x) N%,
 * transparent)` (the server's transparencies) are the colour of `x` with alpha N%: exact, not an approximation.
 */
function classify(name: string, value: string, tokens: Record<string, string>): Parsed {
  const v = value.trim();
  const alias = ALIAS.exec(v);
  if (alias) return { alias: alias[1]! };
  const segments = name.split('-');
  if (segments[0] === 'font' || segments.at(-1) === 'font') {
    const families = parseFamilies(v);
    return families ? { type: 'fontFamily', value: families.length === 1 ? families[0] : families } : { skip: 'formula' };
  }
  if (segments.at(-1) === 'weight') {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 1000 ? { type: 'fontWeight', value: n } : { skip: 'type' };
  }
  const color = parseColor(v);
  if (color) return { type: 'color', value: color };
  const mix = new RegExp(String.raw`^color-mix\(in oklch,\s*var\(--xb-([a-z0-9-]+)\)\s+(${NUMBER})%,\s*transparent\)$`).exec(v);
  if (mix) {
    const base = parseColor(tokens[`xb-${mix[1]}`] ?? '');
    if (base && base.alpha === undefined) return { type: 'color', value: { ...base, alpha: round(Number(mix[2]) / 100) } };
    return { skip: 'formula' };
  }
  if (segments.includes('shadow')) {
    if (v === 'none') return { skip: 'type' };
    const shadow = parseShadow(v);
    return shadow ? { type: 'shadow', value: shadow } : { skip: /\(/.test(v.replace(/oklch\([^()]*\)/g, '')) ? 'formula' : 'type' };
  }
  const dim = parseDimension(v);
  if (dim === 'unit') return { skip: 'unit' };
  if (dim) return { type: 'dimension', value: dim };
  return { skip: /[a-z-]+\(/i.test(v) ? 'formula' : 'type' };
}

/** The path of a token in the file: by type, then by family for colours and dimensions. */
function pathOf(name: string, type: DtcgType): string[] {
  if (type === 'color' || type === 'dimension') {
    // `on-primary` sits with its family: `color.primary.on`.
    const on = /^on-(.+)$/.exec(name);
    if (on) return [type, on[1]!, 'on'];
    const dash = name.indexOf('-');
    return dash < 0 ? [type, name] : [type, name.slice(0, dash), name.slice(dash + 1)];
  }
  return [type, name];
}

/** Puts a token at a path; a token that meets a group of the same name moves to `base` inside it. */
function place(root: DtcgGroup, path: string[], token: object, moved: Map<string, string>): string[] {
  let group = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    let next = group[key] as DtcgGroup | undefined;
    if (next && '$value' in next) {
      // A token stood where a group is needed: it becomes the group's `base`.
      group[key] = { base: next };
      next = group[key] as DtcgGroup;
      moved.set(path.slice(0, i + 1).join('.'), [...path.slice(0, i + 1), 'base'].join('.'));
    }
    if (!next) group[key] = next = {};
    group = next;
  }
  const last = path.at(-1)!;
  if (group[last] && !('$value' in (group[last] as object))) {
    (group[last] as DtcgGroup).base = token;
    return [...path, 'base'];
  }
  group[last] = token;
  return path;
}
const SKIPPED = (): Record<Skip, string[]> => ({ formula: [], unit: [], type: [] });

/**
 * The tokens of one scheme (`xb-name` → CSS value, as Tokens::export gives them) as a DTCG document. `description`
 * is the root `$description` (the panel writes it in the reader's language).
 */
export function toDtcg(tokens: Record<string, string>, scheme: 'light' | 'dark', description = ''): DtcgResult {
  const parsed = new Map<string, Parsed>();
  for (const [full, value] of Object.entries(tokens)) {
    if (!full.startsWith('xb-')) continue;
    parsed.set(full.slice(3), classify(full.slice(3), String(value), tokens));
  }
  // Aliases take the type of the token they point at, through chains; an alias of a token left out is left out.
  const resolve = (name: string, seen = new Set<string>()): Parsed => {
    const p = parsed.get(name);
    if (!p) return { skip: 'formula' };
    if (!('alias' in p)) return p;
    if (seen.has(name)) return { skip: 'formula' };
    seen.add(name);
    const target = resolve(p.alias, seen);
    // An alias of a token left out is left out for the same reason (a formula, a unit, a type).
    return 'type' in target ? { type: target.type, value: p.alias } : target;
  };

  const doc: DtcgGroup = {};
  const skipped = SKIPPED();
  // In the file the left-out tokens keep their CSS value, so nothing of the site is silently lost.
  const left: Record<Skip, Record<string, string>> = { formula: {}, unit: {}, type: {} };
  const paths = new Map<string, string[]>();
  const aliases: Array<[string[], string]> = [];
  const moved = new Map<string, string>();
  let exported = 0;
  for (const name of parsed.keys()) {
    const p = resolve(name);
    if ('skip' in p) {
      skipped[p.skip].push(name);
      left[p.skip][name] = String(tokens[`xb-${name}`]);
      continue;
    }
    if ('alias' in p) continue;
    const isAlias = 'alias' in parsed.get(name)!;
    const token = { $type: p.type, $value: isAlias ? '' : p.value };
    const path = place(doc, pathOf(name, p.type), token, moved);
    paths.set(name, path);
    if (isAlias) aliases.push([path, String(p.value)]);
    exported++;
  }
  // References last, once every path (and every move to `base`) is known.
  const finalPath = (path: string[]) => moved.get(path.join('.')) ?? path.join('.');
  for (const [path, target] of aliases) {
    let node = doc;
    const at = finalPath(path).split('.');
    for (const key of at.slice(0, -1)) node = node[key] as DtcgGroup;
    (node[at.at(-1)!] as { $value: string }).$value = `{${finalPath(paths.get(target)!)}}`;
  }

  const out: DtcgGroup = {};
  if (description) out.$description = description;
  out.$extensions = { [EXTENSION]: { scheme, exported, skipped: left } };
  return { doc: Object.assign(out, doc), exported, skipped };
}

/** The file names of the two schemes. */
export const DTCG_FILES = { light: 'tokens.chiaro.json', dark: 'tokens.scuro.json' } as const;
