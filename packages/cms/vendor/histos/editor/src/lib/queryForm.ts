import { t, tn } from './i18n.ts';
import type { QueryType } from './queries.ts';

// The visual query builder reads and writes the same arguments as the code view, one field at a time.
// Arguments it has no field for are never touched: the code view stays the place for everything else.

export type Args = Record<string, unknown>;

/** Sets or removes one argument (empty string, undefined and empty lists remove it). */
export function setArg(args: Args, key: string, value: unknown): Args {
  const next = { ...args };
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete next[key];
  else next[key] = value;
  return next;
}

// ---- values a loop can pass: "$name ?? default" (docs/spec/queries.md §1)

/** A loop parameter reference and its default (as written), or null for a plain value. */
export function readParam(value: unknown): { param: string; fallback: string } | null {
  if (typeof value !== 'string') return null;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*\?\?\s*(.+))?$/s.exec(value.trim());
  if (!m) return null;
  const raw = (m[2] ?? '').trim();
  const quoted = /^(['"])(.*)\1$/s.exec(raw);
  return { param: m[1] as string, fallback: quoted ? (quoted[2] as string) : raw };
}

/** A parameter with a default: numbers stay bare, anything else is quoted. */
export function writeParam(param: string, fallback: string | number): string {
  const value = typeof fallback === 'number' || /^-?\d+(\.\d+)?$/.test(fallback) ? String(fallback) : JSON.stringify(fallback);
  return fallback === '' ? `$${param}` : `$${param} ?? ${value}`;
}

// ---- how many: a fixed number, or a loop parameter with a default ("$count ?? 6")

export interface Amount {
  fromLoop: boolean;
  /** The loop parameter that sets it (count when created here). */
  param: string;
  value: number;
}

export function readAmount(value: unknown, fallback = 6): Amount {
  if (typeof value === 'number' && Number.isFinite(value)) return { fromLoop: false, param: 'count', value };
  const ref = readParam(value);
  if (ref) return { fromLoop: true, param: ref.param, value: /^-?\d+$/.test(ref.fallback) ? Number(ref.fallback) : fallback };
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return { fromLoop: false, param: 'count', value: Number(value) };
  return { fromLoop: false, param: 'count', value: fallback };
}

export function writeAmount(amount: Amount): number | string {
  const n = Math.max(-1, Math.min(100, Math.round(amount.value)));
  return amount.fromLoop ? writeParam(amount.param || 'count', n) : n;
}

/** A field that may come from the loop: its value to show, and how to write a new one back. */
export function choiceOf(value: unknown, fallback: string): { value: string; param: string | null; write: (next: string) => string } {
  const ref = readParam(value);
  if (ref) return { value: ref.fallback || fallback, param: ref.param, write: (next) => writeParam(ref.param, next) };
  return { value: typeof value === 'string' && value !== '' ? value : fallback, param: null, write: (next) => next };
}

// ---- taxonomy filters: rows of tax_query

export interface TaxFilter {
  taxonomy: string;
  terms: number[];
  operator: 'IN' | 'NOT IN' | 'AND';
}

export function readTaxFilters(args: Args): { relation: 'AND' | 'OR'; filters: TaxFilter[] } {
  const query = args.tax_query;
  if (!Array.isArray(query) && !(query && typeof query === 'object')) return { relation: 'AND', filters: [] };
  const entries = Array.isArray(query) ? query : Object.values(query as Record<string, unknown>);
  const relation = !Array.isArray(query) && (query as Record<string, unknown>).relation === 'OR' ? 'OR' : 'AND';
  const filters: TaxFilter[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.taxonomy !== 'string') continue;
    const terms = (Array.isArray(e.terms) ? e.terms : [e.terms]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const operator = e.operator === 'NOT IN' || e.operator === 'AND' ? e.operator : 'IN';
    filters.push({ taxonomy: e.taxonomy, terms, operator });
  }
  return { relation: Array.isArray(query) && query.some((q) => q === 'OR') ? 'OR' : relation, filters };
}

/** Rows that can be represented by the form: only term-id lists on a taxonomy (anything else is code-only). */
export function taxFiltersEditable(args: Args): boolean {
  const query = args.tax_query;
  if (query === undefined) return true;
  if (!query || typeof query !== 'object') return false;
  const entries = Object.entries(query as Record<string, unknown>).filter(([k]) => k !== 'relation');
  return entries.every(([, e]) => {
    if (!e || typeof e !== 'object') return false;
    const keys = Object.keys(e as Record<string, unknown>);
    const field = (e as Record<string, unknown>).field;
    return keys.every((k) => ['taxonomy', 'terms', 'operator', 'field', 'include_children'].includes(k)) && (field === undefined || field === 'term_id');
  });
}

export function writeTaxFilters(args: Args, filters: TaxFilter[], relation: 'AND' | 'OR'): Args {
  const rows = filters
    .filter((f) => f.taxonomy && f.terms.length > 0)
    .map((f) => ({ taxonomy: f.taxonomy, field: 'term_id', terms: f.terms, operator: f.operator }));
  if (rows.length === 0) return setArg(args, 'tax_query', undefined);
  return setArg(args, 'tax_query', rows.length > 1 ? { relation, ...Object.fromEntries(rows.map((r, i) => [String(i), r])) } : rows);
}

// ---- lists of ids (include, exclude, authors)

export function readIds(value: unknown): number[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : typeof value === 'number' ? [value] : [];
  return list.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0);
}

export function writeIds(ids: number[]): number[] | undefined {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  return clean.length ? clean : undefined;
}

// ---- what the form covers, per query type

export const FORM_KEYS: Record<QueryType, string[]> = {
  posts: ['post_type', 'posts_per_page', 'offset', 'orderby', 'order', 'meta_key', 's', 'author__in', 'post__in', 'post__not_in', 'tax_query', 'ignore_sticky_posts', 'post_parent'],
  terms: ['taxonomy', 'number', 'offset', 'orderby', 'order', 'hide_empty', 'parent', 'include', 'exclude'],
  main: ['posts_per_page', 'offset', 'orderby', 'order'],
  users: ['number', 'offset', 'orderby', 'order', 'role__in', 'post_type'],
};

/** Arguments the form does not show: listed so nobody thinks they are lost. */
export function otherKeys(type: QueryType, args: Args): string[] {
  return Object.keys(args).filter((k) => !FORM_KEYS[type].includes(k));
}

export const POST_ORDERS: Array<[string, string]> = [
  ['date', t('Data di pubblicazione')],
  ['modified', t('Ultima modifica')],
  ['title', t('Titolo')],
  ['menu_order', t('Ordine manuale')],
  ['comment_count', t('Numero di commenti')],
  ['rand', t('Casuale')],
  ['post__in', t('Come nell’elenco "Solo questi"')],
  ['meta_value', t('Campo personalizzato (testo)')],
  ['meta_value_num', t('Campo personalizzato (numero)')],
];

export const USER_ORDERS: Array<[string, string]> = [
  ['display_name', t('Nome')],
  ['post_count', t('Numero di contenuti')],
  ['registered', t('Data di iscrizione')],
  ['include', t('Come nell’elenco')],
];

export const TERM_ORDERS: Array<[string, string]> = [
  ['name', t('Nome')],
  ['count', t('Numero di contenuti')],
  ['slug', t('Slug')],
  ['term_order', t('Ordine manuale')],
  ['id', t('Creazione')],
];

/** A one-line description of what the query returns, for the list and the preview. */
export function summary(type: QueryType, args: Args, labels: { types?: Record<string, string>; taxonomies?: Record<string, string> } = {}): string {
  if (type === 'main') return t('La query principale della pagina');
  if (type === 'users') {
    const n = readAmount(args.number, 10);
    const roles = Array.isArray(args.role__in) ? args.role__in.length : 0;
    const who = n.fromLoop ? t('{0} (o {1}) autori', n.value, n.param) : n.value <= 0 ? t('Tutti gli autori') : t('{0} autori', n.value);
    return roles ? t('{0}, {1}', who, tn('{0} ruolo', '{0} ruoli', roles, roles)) : who;
  }
  if (type === 'terms') {
    const tax = typeof args.taxonomy === 'string' ? (labels.taxonomies?.[args.taxonomy] ?? args.taxonomy) : t('termini');
    const n = readAmount(args.number, 10);
    return (n.fromLoop ? t('fino a {0} (o count) {1}', n.value, tax) : n.value <= 0 ? t('tutti i {0}', tax) : `${n.value} ${tax}`).trim();
  }
  const postType = typeof args.post_type === 'string' ? (labels.types?.[args.post_type] ?? args.post_type) : t('articoli');
  const n = readAmount(args.posts_per_page, 10);
  const order = POST_ORDERS.find(([k]) => k === args.orderby)?.[1]?.toLowerCase() ?? t('data');
  const filters = readTaxFilters(args).filters.length;
  const what = n.fromLoop ? t('{0} (o count) {1}', n.value, postType) : n.value < 0 ? t('Tutti i {0}', postType) : `${n.value} ${postType}`;
  const sorted = args.order === 'ASC' ? t('{0}, per {1} crescente', what, order) : t('{0}, per {1}', what, order);
  return filters ? t('{0}, {1}', sorted, tn('{0} filtro', '{0} filtri', filters, filters)) : sorted;
}
