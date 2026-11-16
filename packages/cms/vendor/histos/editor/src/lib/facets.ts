// Facets (docs/spec/facets.md): filters, sorting and pages of a list, defined in the site settings and read in
// pages as facets.<name>. Checks mirror plugin/src/Render/Facets.php (the server has the last word: it also
// knows WordPress's query variables and which fields are public); the snippet is ready-made markup that works
// without JavaScript and is updated in place by the facets script when it runs.

import { t } from './i18n.ts';

export type FilterKind = 'search' | 'taxonomy' | 'field' | 'range' | 'sort';

export interface SortOption {
  value: string;
  label: string;
  orderby: (typeof ORDERS)[number];
  order: 'asc' | 'desc';
  /** With `orderby: 'field'`: the public field to sort by. */
  field?: string;
}

export interface Filter {
  kind: FilterKind;
  key: string;
  label: string;
  taxonomy?: string;
  multiple?: boolean;
  match?: 'any' | 'all';
  field?: string;
  /** A range compares numbers or dates (`AAAA-MM-GG`); the form sends `<key>_min` and `<key>_max`. */
  type?: 'number' | 'date';
  options?: SortOption[];
}

export interface Facet {
  query: string;
  type: string;
  perPage: number;
  pageKey: string;
  filters: Filter[];
}

export type Facets = Record<string, Facet>;

export const ORDERS = ['date', 'title', 'modified', 'menu_order', 'comment_count', 'rand', 'field'] as const;
export const ORDER_LABELS: Record<(typeof ORDERS)[number], string> = {
  date: t('Data'),
  title: t('Titolo'),
  modified: t('Ultima modifica'),
  menu_order: t('Ordine manuale'),
  comment_count: t('Commenti'),
  rand: t('Casuale'),
  field: t('Un campo'),
};

/** Parameters WordPress reads itself (a subset: the server checks the full list of the site). */
const RESERVED = ['p', 'page', 'paged', 's', 'cat', 'tag', 'm', 'w', 'name', 'author', 'feed', 'preview', 'order', 'orderby', 'year', 'day', 'monthnum', 'post_type', 'taxonomy', 'term', 'category_name', 'static_bridge_bypass', 'xb'];
const NAME = /^[a-z][a-z0-9_]{0,30}$/;
const KEY = /^[a-z][a-z0-9_-]{0,30}$/;

export function blankFacet(type = 'post'): Facet {
  return {
    query: 'posts',
    type,
    perPage: 12,
    pageKey: 'pagina',
    filters: [{ kind: 'search', key: 'q', label: t('Cerca') }],
  };
}

export function blankFilter(kind: FilterKind, taken: string[]): Filter {
  const base = { search: 'q', taxonomy: 'categoria', field: 'campo', range: 'intervallo', sort: 'ordine' }[kind];
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base}${i}`;
  switch (kind) {
    case 'search':
      return { kind, key, label: t('Cerca') };
    case 'taxonomy':
      return { kind, key, label: t('Categoria'), taxonomy: 'category', multiple: true, match: 'any' };
    case 'field':
      return { kind, key, label: t('Campo'), field: '' };
    case 'range':
      return { kind, key, label: t('Da… a…'), field: '', type: 'number' };
    case 'sort':
      return {
        kind,
        key,
        label: t('Ordina'),
        options: [
          { value: 'recenti', label: t('Più recenti'), orderby: 'date', order: 'desc' },
          { value: 'titolo', label: t('Titolo A-Z'), orderby: 'title', order: 'asc' },
        ],
      };
  }
}

export function nameProblem(name: string, others: string[]): string | null {
  if (!NAME.test(name)) return t('Nome non valido: minuscole, cifre e trattino basso, come una variabile (es. eventi).');
  if (others.includes(name)) return t('Esistono già filtri chiamati "{0}".', name);
  return null;
}

/** The first problem of a facet, or null; `extraReserved` are names the site uses (taxonomies, types). */
export function facetProblem(facet: Facet, extraReserved: string[] = []): string | null {
  // A range also reads `<key>_min` and `<key>_max`.
  const keys = [facet.pageKey, ...facet.filters.flatMap((f) => (f.kind === 'range' ? [f.key, `${f.key}_min`, `${f.key}_max`] : [f.key]))];
  for (const key of keys) {
    if (!KEY.test(key)) return t('"{0}" non va bene come parametro dell\'indirizzo: minuscole, cifre e trattini.', key);
    if (RESERVED.includes(key) || extraReserved.includes(key)) return t('"{0}" lo usa già WordPress: scegli un altro nome (es. "{0}-filtro").', key);
  }
  if (new Set(keys).size !== keys.length) return t('Due filtri usano lo stesso parametro.');
  if (!(facet.perPage >= 1 && facet.perPage <= 100)) return t('Risultati per pagina: da 1 a 100.');
  for (const f of facet.filters) {
    if (f.kind === 'taxonomy' && !f.taxonomy) return t('"{0}": scegli una tassonomia.', f.label || f.key);
    if ((f.kind === 'field' || f.kind === 'range') && !f.field) return t('"{0}": scegli un campo pubblico.', f.label || f.key);
    if (f.kind === 'sort') {
      if (!f.options?.length) return t('"{0}": serve almeno un\'opzione di ordinamento.', f.label || f.key);
      for (const o of f.options) {
        if (!/^[a-z0-9_-]{1,30}$/.test(o.value)) return t('Ordinamento: "{0}" non è un valore valido (minuscole, cifre e trattini).', o.value);
        if (o.orderby === 'field' && !o.field) return t('Ordinamento "{0}": scegli il campo.', o.label || o.value);
      }
    }
  }
  return null;
}

/** Text for markup: braces escaped so labels never become expressions, `<` and `&` as entities. */
const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[{}]/g, (c) => `\\${c}`);
const attr = (s: string) => text(s).replace(/"/g, '&quot;');
/** `.key`, or `["key-with-dashes"]` (a parameter may have dashes, an identifier may not). */
const member = (key: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `["${key}"]`);

/**
 * Ready-made markup for a facet: the form (a region the script refreshes, so counts follow the choices), the
 * results with their count and the pages. Plain GET form and links: it works without JavaScript too.
 */
export function facetSnippet(name: string, facet: Facet): string {
  const f = `facets.${name}`;
  const fields: string[] = [];
  for (const filter of facet.filters) {
    const label = text(filter.label || filter.key);
    const opts = `${f}.filters${member(filter.key)}.options`;
    if (filter.kind === 'search') {
      fields.push(`    <label class="xb-facets__field"><span>${label}</span><input type="search" name="${filter.key}" value="{${f}.values${member(filter.key)}}" /></label>`);
    } else if (filter.kind === 'taxonomy' && filter.multiple !== false) {
      fields.push(
        `    <fieldset class="xb-facets__group">\n      <legend>${label}</legend>\n      {#loop ${opts} as o}\n        <label class="xb-facets__option"><input type="checkbox" name="${filter.key}[]" value="{o.value}" checked={o.selected} /> {o.label} <span class="xb-facets__count">({o.count})</span></label>\n      {/loop}\n    </fieldset>`,
      );
    } else if (filter.kind === 'range') {
      const input = filter.type === 'date' ? 'date' : 'number';
      const entry = `${f}.filters${member(filter.key)}`;
      fields.push(
        `    <fieldset class="xb-facets__group">\n      <legend>${label}</legend>\n      <label class="xb-facets__field"><span>${text(t('da'))}</span><input type="${input}" name="${filter.key}_min" value="{${entry}.min}" /></label>\n      <label class="xb-facets__field"><span>${text(t('a'))}</span><input type="${input}" name="${filter.key}_max" value="{${entry}.max}" /></label>\n    </fieldset>`,
      );
    } else if (filter.kind === 'sort') {
      fields.push(
        `    <label class="xb-facets__field"><span>${label}</span><select name="${filter.key}"><option value="">${text(t('Predefinito'))}</option>{#loop ${opts} as o}<option value="{o.value}" selected={o.selected}>{o.label}</option>{/loop}</select></label>`,
      );
    } else {
      fields.push(
        `    <label class="xb-facets__field"><span>${label}</span><select name="${filter.key}"><option value="">${text(t('Tutti'))}</option>{#loop ${opts} as o}<option value="{o.value}" selected={o.selected}>{o.label} ({o.count})</option>{/loop}</select></label>`,
      );
    }
  }
  return `<section class="xb-facets" aria-label="${attr(t('Filtri {0}', name))}">
  <form class="xb-facets__form" method="get" action="{${f}.action}" data-xb-facet="${name}">
    {#loop ${f}.hidden as h}<input type="hidden" name="{h.name}" value="{h.value}" />{/loop}
${fields.join('\n')}
    <button type="submit" class="xb-facets__submit">${t('Filtra')}</button>
  </form>
  <div class="xb-facets__results" data-xb-facet="${name}" aria-live="polite">
    <p class="xb-facets__summary"><span data-xb-facet-total="${name}">{${f}.total}</span> ${t('risultati')}{#if ${f}.hasFilters} · <a href="{${f}.resetUrl}">${t('Azzera i filtri')}</a>{/if}</p>
    <ul class="xb-facets__list">
      {#loop ${f}.items as item}
        <li><a href="{item.url}">{item.title}</a></li>
      {/loop}
    </ul>
    {#if ${f}.pages > 1}
      <nav class="xb-facets__pages" aria-label="${attr(t('Pagine'))}">
        {#loop ${f}.pageLinks as p}{#if p.number}<a href="{p.url}" aria-current={p.current ? "page" : null}>{p.number}</a>{:else}<span>…</span>{/if}{/loop}
      </nav>
    {/if}
  </div>
</section>`;
}

/** Base styles for the snippet's classes (added once, editable like any style). */
export const FACET_STYLES: Record<string, string> = {
  '.xb-facets': 'display: grid; gap: var(--space-m, 1.5rem);\n&__form { display: flex; flex-wrap: wrap; gap: var(--space-s, 1rem); align-items: end; }\n&__field { display: grid; gap: 0.25rem; }\n&__group { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }\n&__group legend { font-weight: 600; margin-block-end: 0.25rem; }\n&__count { opacity: 0.7; }\n&__list { display: grid; gap: var(--space-xs, 0.5rem); padding: 0; list-style: none; }\n&__results[aria-busy="true"] { opacity: 0.6; transition: opacity 0.2s; }\n&__pages { display: flex; gap: 0.5rem; }\n&__pages [aria-current="page"] { font-weight: 700; text-decoration: none; }',
};
