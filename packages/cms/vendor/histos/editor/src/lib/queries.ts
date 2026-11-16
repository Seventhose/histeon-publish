/** Custom loop queries in the builder — docs/spec/queries.md. Pure helpers, tested in test/queries.test.ts. */

import { printLoopSource, type LoopGroupBy } from '@xb/dsl';
import { t } from './i18n.ts';

export type QueryType = 'posts' | 'terms' | 'main' | 'users';

export interface Preset {
  type: QueryType;
  args: Record<string, unknown>;
}

export type Presets = Record<string, Preset>;

export const RESERVED = ['posts', 'terms', 'main', 'users'];
/** XB fixes these: a loop only ever shows published content the visitor can read. */
export const FORBIDDEN_ARGS = ['post_status', 'perm', 'has_password', 'post_password', 'suppress_filters', 'fields', 'cache_results', 'lazy_load_term_meta'];

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Problem with a query name, or null. */
export function nameProblem(name: string, others: string[]): string | null {
  if (!NAME.test(name)) return t('Nome non valido: lettere, cifre e _ (non all’inizio una cifra).');
  if (RESERVED.includes(name)) return t('"{0}" è una query predefinita di Histeon.', name);
  if (others.includes(name)) return t('Esiste già una query "{0}".', name);
  return null;
}

/** Arguments as JSON text → object, or the problem to show. */
export function parseArgs(text: string): { args: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() === '' ? '{}' : text);
  } catch (e) {
    return { error: t('JSON non valido: {0}', e instanceof Error ? e.message : String(e)) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: t('I parametri sono un oggetto JSON: { "post_type": "post", … }') };
  const args = value as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(key)) return { error: t('Parametro non valido: "{0}".', key) };
    if (FORBIDDEN_ARGS.includes(key)) return { error: t('"{0}" non si può usare: Histeon mostra solo contenuti pubblicati e leggibili da chi visita.', key) };
  }
  return { args };
}

/** Loop arguments a preset reads: "$count", "$count ?? 3". */
export function parameters(args: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*\?\?.*)?$/s.exec(v);
      if (m) found.add(m[1] as string);
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(args);
  return [...found].sort();
}

/** The loop variable of a grouped query loop: each repetition is a group `{key, items}` (items 187 and 205). */
export const GROUP_VARIABLE = 'gruppo';

/**
 * A ready-to-edit loop for a preset, in the DSL. With `groupBy` (doc 23 of Publish, item 205) the query's result comes
 * in groups: a title per group, `{gruppo.key}`, then its contents, `{#loop gruppo.items as item}`.
 */
export function loopSnippet(name: string, preset: Preset, groupBy?: LoopGroupBy): string {
  const args: Record<string, string> = Object.fromEntries(parameters(preset.args).map((p) => [p, LOOP_VALUES[p] ?? '""']));
  const item = variableFor(preset.type);
  const body =
    preset.type === 'terms'
      ? `<li><a href={${item}.url}>{${item}.name}</a></li>`
      : preset.type === 'users'
        ? `<li><a href={${item}.url}><img src={${item}.avatar} alt="" width="48" height="48"> {${item}.name}</a></li>`
        : `<article><h3><a href={${item}.url}>{${item}.title}</a></h3><p>{${item}.excerpt.truncateWords(20)}</p></article>`;
  const list = preset.type === 'terms' || preset.type === 'users';
  if (groupBy) {
    const group = GROUP_VARIABLE;
    const inner = `{#loop ${group}.items as ${item}}${body}{/loop}`;
    return `<div>{#loop ${printLoopSource({ kind: 'preset', id: name, args, groupBy })} as ${group}}<section><h2>{${group}.key}</h2>${list ? `<ul>${inner}</ul>` : inner}</section>{/loop}</div>`;
  }
  const loop = `{#loop ${printLoopSource({ kind: 'preset', id: name, args })} as ${item}}${body}{/loop}`;
  return list ? `<ul>${loop}</ul>` : `<div>${loop}</div>`;
}

/** The loop variable a query's records get: item, term, person. */
export function variableFor(type: QueryType): string {
  return type === 'terms' ? 'term' : type === 'users' ? 'person' : 'item';
}

export function blankPreset(type: QueryType = 'posts'): Preset {
  if (type === 'users') return { type, args: { number: '$count ?? 6', orderby: 'display_name', order: 'ASC' } };
  if (type === 'terms') return { type, args: { taxonomy: 'category', number: '$count ?? 10' } };
  if (type === 'main') return { type, args: { posts_per_page: '$count ?? 10' } };
  return { type, args: { post_type: 'post', posts_per_page: '$count ?? 6', orderby: 'date', order: 'DESC' } };
}

/** What a loop passes for the parameters the gallery's queries read: the page it is on gives its own id and category. */
const LOOP_VALUES: Record<string, string> = { count: '3', limit: '3', escludi: 'this.id', categoria: 'this.categories[0].id' };

export interface GalleryQuery {
  /** The name the query gets (a number is added if taken). */
  name: string;
  label: string;
  description: string;
  preset: Preset;
  /** The post type it needs among those loops may list; absent, it always fits. */
  needs?: string;
}

/**
 * Ready queries (lista della spesa 165): added with a click, then edited like any other. They read `$count` (how many,
 * from the loop) and, for related posts, the page's own id and category; upcoming events compare a date field with
 * `$today`, which the server fills in.
 */
export const GALLERY: GalleryQuery[] = [
  {
    name: 'ultimiArticoli',
    label: t('Ultimi articoli'),
    description: t('Gli articoli più recenti, i primi in evidenza esclusi.'),
    preset: { type: 'posts', args: { post_type: 'post', posts_per_page: '$count ?? 3', orderby: 'date', order: 'DESC', ignore_sticky_posts: true } },
  },
  {
    name: 'articoliCorrelati',
    label: t('Articoli correlati'),
    description: t('Altri articoli della stessa categoria della pagina, senza la pagina stessa.'),
    preset: { type: 'posts', args: { post_type: 'post', posts_per_page: '$count ?? 3', category__in: ['$categoria'], post__not_in: ['$escludi'], orderby: 'date', order: 'DESC', ignore_sticky_posts: true } },
  },
  {
    name: 'prodottiInEvidenza',
    label: t('Prodotti in evidenza'),
    description: t('I prodotti segnati «in evidenza» in WooCommerce.'),
    preset: { type: 'posts', args: { post_type: 'product', posts_per_page: '$count ?? 4', tax_query: [{ taxonomy: 'product_visibility', field: 'name', terms: ['featured'] }], orderby: 'date', order: 'DESC' } },
    needs: 'product',
  },
  {
    name: 'eventiFuturi',
    label: t('Eventi futuri'),
    description: t('Gli eventi con la data da oggi in poi, dal più vicino. Il tipo «evento» e il campo «data» si cambiano nella query.'),
    preset: { type: 'posts', args: { post_type: 'evento', posts_per_page: '$count ?? 6', meta_key: 'data', orderby: 'meta_value', order: 'ASC', meta_query: [{ key: 'data', value: '$today', compare: '>=', type: 'DATE' }] } },
  },
];

/** A free name for a gallery query: its own, or with 2, 3… after it. */
export function galleryName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}
