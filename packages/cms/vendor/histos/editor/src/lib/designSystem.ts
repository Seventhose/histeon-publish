// The design system panel (docs/spec/design-system.md): the active framework's variables, sorted by what they
// are, from the values the page actually computes. Pure parts, tested in test/designSystem.test.ts.

import { t } from './i18n.ts';

export type TokenKind = 'color' | 'space' | 'text' | 'radius' | 'shadow' | 'other';

export const KIND_LABELS: Record<TokenKind, string> = {
  color: t('Colori'),
  space: t('Spazi'),
  text: t('Testi'),
  radius: t('Raggi'),
  shadow: t('Ombre'),
  other: t('Altro'),
};

/** What a variable is, from its name first (sizes named "text-…" are sizes, not colours), then its value. */
export function kindOf(name: string, value: string, isColor: (v: string) => boolean): TokenKind {
  const n = name.toLowerCase();
  if (/(^|-)(radius|rounded)(-|$)/.test(n)) return 'radius';
  if (/(^|-)shadow(-|$)/.test(n)) return 'shadow';
  if (/(^|-)(text|font|fs|h[1-6])-(\d?x*[sml]|\d?xl|xxl|\d+)$/.test(n) || /(^|-)font-size/.test(n)) return 'text';
  if (/(^|-)(space|spacing|gap|gutter|section-space)(-|$)/.test(n)) return 'space';
  if (value && isColor(value)) return 'color';
  return 'other';
}

/** The same check as the server (TokenOverrides::problem): a plain CSS value, or why not. */
export function tokenProblem(value: string): string | null {
  if (!value.trim()) return t('Il valore è vuoto.');
  if (value.length > 200) return t('Il valore è troppo lungo.');
  if (/[;{}<>"'\\@!]|\/\*|url\s*\(|expression\s*\(|javascript:/i.test(value)) return t('Caratteri non ammessi (; { } < > virgolette @ ! url()).');
  if (!/^[\w\s.,%()+\-*/#]+$/u.test(value)) return t('Solo valori CSS semplici: numeri, unità, colori, calc(), clamp(), var().');
  let depth = 0;
  for (const c of value) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (depth < 0) break;
  }
  return depth === 0 ? null : t('Parentesi non bilanciate.');
}

/**
 * The family a colour variable belongs to, for the readable colour list: its shades (`-50` … `-950`), transparencies
 * (`-a10`, `-trans-20`), named steps of other frameworks (`-light`, `-ultra-dark`, `-hover`) and its text colour
 * (`on-`) all belong to the base name. `xb-primary-a40` and `xb-on-primary` → `xb-primary`.
 */
export function colorFamilyKey(name: string): string {
  let key = name.replace(/(^|-)on-/, '$1');
  for (let i = 0; i < 4; i++) {
    const next = key.replace(/-(\d+|a\d+|trans-\d+|ultra-light|ultra-dark|semi-light|semi-dark|light|dark|hover|comp)$/, '');
    if (next === key || next === '') break;
    key = next;
  }
  return key;
}

/** Colours grouped by family, in the order they come: the base colour first (or the first one), then the rest. */
export function colorFamilies<T extends { name: string }>(list: readonly T[]): Array<{ key: string; main: T; variants: T[] }> {
  const families = new Map<string, T[]>();
  for (const item of list) {
    const key = colorFamilyKey(item.name);
    families.set(key, [...(families.get(key) ?? []), item]);
  }
  return [...families].map(([key, items]) => {
    const main = items.find((item) => item.name === key) ?? items[0]!;
    return { key, main, variants: items.filter((item) => item !== main) };
  });
}

/** The site's own variables are `--xb-site-<name>` (docs/spec/design-system.md). */
export const SITE_PREFIX = 'xb-site-';

/** The same check as the server (SiteTokens::name_problem and SiteRecipes): 1-40 of a-z, 0-9 and single hyphens. */
export function siteNameProblem(name: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) && !name.endsWith('-') && !name.includes('--')
    ? null
    : t('Nome: da 1 a 40 caratteri fra lettere minuscole, cifre e trattini singoli.');
}

/** The same check as the server (SiteRecipes::problem): CSS declarations that load and run nothing. */
export function recipeProblem(name: string, css: string): string | null {
  const bad = siteNameProblem(name);
  if (bad) return bad;
  if (!css.trim()) return t('La ricetta è vuota.');
  if (new TextEncoder().encode(css).length > 4096) return t('La ricetta supera 4 KB.');
  if (css.includes('<') || /url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) return t('Non sono ammessi markup, url(), @import, expression(), behavior e -moz-binding.');
  let depth = 0;
  for (const c of css) {
    depth += c === '{' ? 1 : c === '}' ? -1 : 0;
    if (depth < 0) break;
  }
  return depth === 0 ? null : t('Graffe non bilanciate.');
}
