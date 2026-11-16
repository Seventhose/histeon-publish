// The table of contents of a type (Content Hub, docs/spec/content.md §8): rows from WordPress's REST API, cells
// edited in place. WordPress validates and authorizes every write; these helpers only shape values for it.
import { MAX_ROWS, type ContentField, type SubField } from './contentHub.ts';
import { t, tn } from './i18n.ts';

/** What the table and its details need of the REST client: WordPress's core routes (Api.core in the builder). */
export interface CoreApi {
  core<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ data: T; total: number }>;
}

export interface RestItem {
  id: number;
  status: string;
  date: string;
  link: string;
  title: { raw?: string; rendered?: string };
  meta?: Record<string, unknown>;
}

export interface Row {
  id: number;
  status: string;
  date: string;
  link: string;
  title: string;
  meta: Record<string, unknown>;
}

/** Field types a cell edits in place; the others (image, linked content, rows) open in the row's details. */
const INLINE = new Set(['text', 'textarea', 'number', 'url', 'email', 'date', 'time', 'toggle', 'select']);
/** Several values (a choice with checkboxes, a gallery) are edited in the block editor's Fields panel. */
export const editsInline = (f: ContentField): boolean => INLINE.has(f.type) && !f.multiple;

export function toRow(item: RestItem): Row {
  return {
    id: item.id,
    status: item.status,
    date: item.date,
    link: item.link,
    title: item.title.raw ?? decode(item.title.rendered ?? ''),
    meta: item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta) ? item.meta : {},
  };
}

function decode(html: string): string {
  const el = typeof document === 'undefined' ? null : document.createElement('textarea');
  if (!el) return html;
  el.innerHTML = html;
  return el.value;
}

/** What a cell shows. */
export function cellText(f: ContentField, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (f.type === 'repeater') return Array.isArray(value) ? tn('{0} riga', '{0} righe', value.length, value.length) : '';
  if (Array.isArray(value)) return f.type === 'select' ? value.map((v) => f.options.find((o) => o.value === v)?.label ?? String(v)).join(', ') : tn('{0} valore', '{0} valori', value.length, value.length);
  if (f.type === 'toggle') return value ? t('Sì') : t('No');
  if (f.type === 'select') return f.options.find((o) => o.value === value)?.label ?? String(value);
  if (f.type === 'image' || f.type === 'file' || f.type === 'post') return Number(value) > 0 ? `#${value}` : '';
  return String(value);
}

/** A typed value for the REST API: an empty number is null (the meta is removed), booleans stay booleans. */
export function fromInput(f: ContentField, input: string | boolean): unknown {
  if (f.type === 'toggle') return input === true || input === 'true';
  const text = String(input);
  if (f.type === 'number') return text.trim() === '' || Number.isNaN(Number(text)) ? null : Number(text);
  return text;
}

export const STATUSES: Array<{ value: string; label: string }> = [
  { value: 'any', label: t('Tutti') },
  { value: 'publish', label: t('Pubblicati') },
  { value: 'draft', label: t('Bozze') },
  { value: 'pending', label: t('In revisione') },
  { value: 'private', label: t('Privati') },
];

/** The REST query of a page of the table. */
export function listQuery(route: string, page: number, perPage: number, status: string, search: string): string {
  const params = new URLSearchParams({ context: 'edit', per_page: String(perPage), page: String(page), orderby: 'date', order: 'desc', _fields: 'id,status,date,link,title,meta' });
  params.set('status', status === 'any' ? 'publish,future,draft,pending,private' : status);
  if (search.trim()) params.set('search', search.trim());
  return `${route}?${params.toString()}`;
}

/** Rows a repeater inside a row may hold (ContentTypes::MAX_INNER_ROWS). */
export const MAX_INNER_ROWS = 50;

/** A new row: every sub field present, empty as the REST schema wants it (a number null, an image 0). */
export function emptyRow(sub: SubField[]): Record<string, unknown> {
  return Object.fromEntries(sub.map((s) => [s.name, emptySub(s)]));
}

function emptySub(s: SubField): unknown {
  if (s.type === 'repeater') return [];
  if (s.type === 'number') return null;
  if (s.type === 'toggle') return false;
  if (s.type === 'image' || s.type === 'file') return 0;
  return '';
}

/**
 * The rows of a repeater as the table edits them: only the defined sub fields, each with a value of its type, at
 * most `max` rows. The server drops anything else (`additionalProperties: false`), so the table never sends it.
 */
export function rowsOf(value: unknown, sub: SubField[], max = MAX_ROWS): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((raw) => {
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return Object.fromEntries(sub.map((s) => [s.name, s.type === 'repeater' ? rowsOf(row[s.name], s.sub ?? [], MAX_INNER_ROWS) : subValue(s, row[s.name])]));
  });
}

/** A sub field's value from an input, or from what WordPress stored. */
export function subValue(s: SubField, input: unknown): unknown {
  if (s.type === 'toggle') return input === true || input === 'true' || input === 1 || input === '1';
  if (s.type === 'number') return input === null || input === undefined || String(input).trim() === '' || Number.isNaN(Number(input)) ? null : Number(input);
  if (s.type === 'image' || s.type === 'file') return Number(input) > 0 ? Math.floor(Number(input)) : 0;
  return input === null || input === undefined ? '' : String(input);
}

/** A page of images to choose from (WordPress's media library). */
export function mediaQuery(search: string, images = true): string {
  const params = new URLSearchParams({ ...(images ? { media_type: 'image' } : {}), per_page: '12', _fields: 'id,title,alt_text,media_details,source_url' });
  if (search.trim()) params.set('search', search.trim());
  return `/wp/v2/media?${params.toString()}`;
}

/** A page of contents of the linked type, by its REST route (`/wp/v2/<rest_base>`). */
export function relatedQuery(route: string, search: string): string {
  const params = new URLSearchParams({ per_page: '12', status: 'publish,draft,pending,private,future', context: 'edit', _fields: 'id,title,status' });
  if (search.trim()) params.set('search', search.trim());
  return `${route}?${params.toString()}`;
}

/** WordPress's own edit screen of a term: by the taxonomy's name (`post_tag`), not by its REST route (`tags`). */
export function termEditUrl(adminUrl: string | null, taxonomy: string, id: number): string | null {
  if (!adminUrl || !taxonomy) return null;
  try {
    return new URL(`term.php?taxonomy=${encodeURIComponent(taxonomy)}&tag_ID=${id}`, adminUrl).toString();
  } catch {
    return null;
  }
}
