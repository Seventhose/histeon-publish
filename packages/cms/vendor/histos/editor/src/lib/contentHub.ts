// Content Hub (docs/spec/content.md): content types, taxonomies and fields an administrator defines in the
// builder. The server validates everything again (plugin/src/Content/ContentTypes.php); these helpers give the
// same answers earlier, while typing.
import { t } from './i18n.ts';

export type FieldType = 'text' | 'textarea' | 'number' | 'url' | 'email' | 'date' | 'time' | 'toggle' | 'select' | 'image' | 'file' | 'post' | 'repeater';
/** What a repeater row may hold: one value each, or one more repeater (two levels at most, D6); never a relation. */
export type SubFieldType = 'text' | 'textarea' | 'number' | 'date' | 'time' | 'toggle' | 'select' | 'url' | 'image' | 'file' | 'repeater';

export interface SubField {
  name: string;
  label: string;
  type: SubFieldType;
  options: Array<{ value: string; label: string }>;
  /** For a repeater inside a row: the fields of its own rows, never another repeater. */
  sub?: SubField[];
}

export interface ContentField {
  name: string;
  label: string;
  type: FieldType;
  help: string;
  options: Array<{ value: string; label: string }>;
  /** For a `post` field: the type of the linked content. */
  postType: string;
  /** For a `repeater`: the fields of each row. */
  sub: SubField[];
  /** Several values (doc 26 voce 211): a choice with checkboxes, a gallery, several files or contents. */
  multiple?: boolean;
  /** A single choice shown as radio buttons instead of a menu. */
  radio?: boolean;
  /** Set by the server on a field that comes from a group: edited in the group, never as the type's own. */
  group?: string;
}

/** Types that may hold several values, and what the option is called. */
export const MULTIPLE_LABELS: Partial<Record<FieldType, string>> = {
  select: t('Più valori (caselle)'),
  image: t('Più immagini (galleria)'),
  file: t('Più file'),
  post: t('Più contenuti'),
};

/** Same limits as the server (ContentTypes::MAX_SUB, MAX_ROWS). */
export const MAX_SUB = 20;
export const MAX_ROWS = 200;

export interface ContentType {
  singular: string;
  plural: string;
  /** Pages of its own (single and archive); without, its items appear only through loops. */
  public: boolean;
  archive: boolean;
  /** Address: /slug/ for the archive, /slug/item/ for each item. */
  slug: string;
  hierarchical: boolean;
  icon: string;
  supports: string[];
  /** Who manages it: like posts (authors) or like pages (editors). */
  capability: 'post' | 'page';
}

export interface ContentTaxonomy {
  singular: string;
  plural: string;
  public: boolean;
  /** Categories (nested) or tags (flat). */
  hierarchical: boolean;
  slug: string;
  types: string[];
}

export interface ContentDefs {
  types: Record<string, ContentType>;
  taxonomies: Record<string, ContentTaxonomy>;
  fields: Record<string, ContentField[]>;
  /** Fields shared by several types (doc 26 voce 213); the server writes them into each type's list, with `group`. */
  groups?: Record<string, FieldGroup>;
}

/** The same fields for the types it names, or for every type but some (`all` and `except`). */
export interface FieldGroup {
  label: string;
  all: boolean;
  types: string[];
  except: string[];
  fields: ContentField[];
}

export const FIELD_TYPES: Array<{ value: FieldType; label: string; hint: string }> = [
  { value: 'text', label: t('Testo'), hint: t('una riga') },
  { value: 'textarea', label: t('Testo lungo'), hint: t('più righe, senza formattazione') },
  { value: 'number', label: t('Numero'), hint: t('prezzi, quantità, durate') },
  { value: 'date', label: t('Data'), hint: t('AAAA-MM-GG') },
  { value: 'time', label: t('Ora'), hint: t('HH:MM') },
  { value: 'toggle', label: t('Sì / no'), hint: t('interruttore') },
  { value: 'select', label: t('Scelta'), hint: t('una tra opzioni fisse') },
  { value: 'image', label: t('Immagine'), hint: t('dalla libreria dei media') },
  { value: 'file', label: t('File'), hint: t('PDF o altro file della libreria') },
  { value: 'url', label: t('Indirizzo web'), hint: 'https://…' },
  { value: 'email', label: t('Email'), hint: t('indirizzo email') },
  { value: 'post', label: t('Contenuto collegato'), hint: t('un altro contenuto del sito') },
  { value: 'repeater', label: t('Ripetitore'), hint: t('righe con gli stessi campi (orari, tappe…)') },
];

export const SUB_FIELD_TYPES = FIELD_TYPES.filter((t): t is (typeof FIELD_TYPES)[number] & { value: SubFieldType } =>
  (['text', 'textarea', 'number', 'date', 'time', 'toggle', 'select', 'url', 'image', 'file', 'repeater'] as string[]).includes(t.value),
);
/** The fields of a repeater inside a row: the same, without a third level. */
export const INNER_SUB_FIELD_TYPES = SUB_FIELD_TYPES.filter((t) => t.value !== 'repeater');

export const SUPPORTS: Array<{ value: string; label: string }> = [
  { value: 'title', label: t('Titolo') },
  { value: 'editor', label: t('Contenuto') },
  { value: 'thumbnail', label: t('Immagine in evidenza') },
  { value: 'excerpt', label: t('Riassunto') },
  { value: 'author', label: t('Autore') },
  { value: 'comments', label: t('Commenti') },
  { value: 'revisions', label: t('Revisioni') },
  { value: 'page-attributes', label: t('Ordine e genitore') },
];

export const ICONS = ['admin-post', 'calendar-alt', 'location', 'groups', 'businessperson', 'portfolio', 'products', 'cart', 'book', 'format-quote', 'megaphone', 'star-filled', 'heart', 'clipboard', 'building', 'food', 'tickets-alt', 'video-alt3', 'microphone', 'welcome-learn-more'].map((i) => `dashicons-${i}`);

/** Names WordPress uses (types, query variables, routes) or XB reads as roots: never a new type or taxonomy. */
const RESERVED = new Set(
  'post page attachment revision nav_menu_item custom_css customize_changeset oembed_cache user_request wp_block wp_template wp_template_part wp_global_styles wp_navigation wp_font_family wp_font_face action author order theme type fields category post_tag nav_menu link_category post_format attachment_id calendar cat category_name cpage day embed error feed hour link m minute monthnum more name offset p page_id paged pagename perm post_status post_type posts preview robots s search second static status tag tag_id taxonomy term terms title year users user site data url this item main xb xb_submission'.split(' '),
);

export const emptyDefs = (): ContentDefs => ({ types: {}, taxonomies: {}, fields: {} });

/** A technical name from a label: "Eventi musicali" → "eventi_musicali". */
export function slugify(label: string, max = 20): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, max)
    .replace(/_+$/, '');
}

/** An address part from a label: "Eventi musicali" → "eventi-musicali". */
export const urlSlug = (label: string): string => slugify(label, 60).replace(/_/g, '-');

/** Why a type or taxonomy name cannot be used (null: it can). */
export function nameProblem(name: string, taken: string[], max: 20 | 32): string | null {
  if (!new RegExp(`^[a-z][a-z0-9_-]{0,${max - 1}}$`).test(name)) return t('Nome tecnico non valido: lettere minuscole, cifre, - e _, al massimo {0} caratteri, iniziando con una lettera.', max);
  if (RESERVED.has(name) || name.startsWith('wp_')) return t('"{0}" è un nome riservato da WordPress: scegline un altro.', name);
  if (taken.includes(name)) return t('Il nome "{0}" è già usato.', name);
  return null;
}

export function fieldNameProblem(name: string, existing: string[]): string | null {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) return t('Nome del campo non valido: lettere minuscole, cifre e _, iniziando con una lettera.');
  if (existing.includes(name)) return t('Il campo "{0}" c’è già.', name);
  return null;
}

export function blankType(singular: string, plural: string): ContentType {
  return { singular, plural, public: true, archive: true, slug: urlSlug(plural || singular), hierarchical: false, icon: 'dashicons-admin-post', supports: ['title', 'editor', 'thumbnail', 'excerpt'], capability: 'post' };
}

export function blankTaxonomy(singular: string, plural: string, types: string[] = []): ContentTaxonomy {
  return { singular, plural, public: true, hierarchical: true, slug: urlSlug(plural || singular), types };
}

function uniqueName(label: string, existing: string[]): string {
  let name = slugify(label, 64) || 'campo';
  for (let i = 2; existing.includes(name); i++) name = `${slugify(label, 60) || 'campo'}_${i}`;
  return name;
}

const firstOption = () => [{ value: 'opzione_1', label: 'Opzione 1' }];

export function blankField(label: string, type: FieldType, existing: string[]): ContentField {
  return {
    name: uniqueName(label, existing),
    label,
    type,
    help: '',
    options: type === 'select' ? firstOption() : [],
    postType: '',
    sub: type === 'repeater' ? [blankSubField('Testo', 'text', [])] : [],
  };
}

export function blankSubField(label: string, type: SubFieldType, existing: string[]): SubField {
  const sub: SubField = { name: uniqueName(label, existing), label, type, options: type === 'select' ? firstOption() : [] };
  if (type === 'repeater') sub.sub = [blankSubField('Testo', 'text', [])];
  return sub;
}

const optionsFor = (type: string, options: SubField['options']) => (type === 'select' ? (options.length ? options : firstOption()) : []);

/** A field with a new type: options for a choice, a first sub field for a repeater, nothing left of the old type. */
export function retypeField(f: ContentField, type: FieldType): ContentField {
  const { multiple, radio, ...rest } = f;
  const next: ContentField = { ...rest, type, options: optionsFor(type, f.options), sub: type === 'repeater' ? (f.sub.length ? f.sub : [blankSubField('Testo', 'text', [])]) : [] };
  // Several values and radio buttons belong to the types that have them (MULTIPLE_LABELS, a choice).
  if (multiple && MULTIPLE_LABELS[type]) next.multiple = true;
  if (radio && type === 'select' && !multiple) next.radio = true;
  return next;
}

export function retypeSub(s: SubField, type: SubFieldType): SubField {
  const { sub, ...rest } = s;
  const next: SubField = { ...rest, type, options: optionsFor(type, s.options) };
  if (type === 'repeater') next.sub = sub?.length ? sub : [blankSubField('Testo', 'text', [])];
  return next;
}

export function moveField<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to] as T, next[index] as T];
  return next;
}

/** Renames a type everywhere it is referenced (its fields, taxonomies, relation fields). Only before it goes live. */
export function renameType(defs: ContentDefs, from: string, to: string): ContentDefs {
  if (from === to || !defs.types[from]) return defs;
  const types = Object.fromEntries(Object.entries(defs.types).map(([k, v]) => [k === from ? to : k, v]));
  const fields = Object.fromEntries(
    Object.entries(defs.fields).map(([k, list]) => [k === from ? to : k, list.map((f) => (f.postType === from ? { ...f, postType: to } : f))]),
  );
  const taxonomies = Object.fromEntries(Object.entries(defs.taxonomies).map(([k, t]) => [k, { ...t, types: t.types.map((x) => (x === from ? to : x)) }]));
  const swap = (x: string) => (x === from ? to : x);
  const groups = defs.groups && Object.fromEntries(Object.entries(defs.groups).map(([k, g]) => [k, { ...g, types: g.types.map(swap), except: g.except.map(swap), fields: g.fields.map((f) => (f.postType === from ? { ...f, postType: to } : f)) }]));
  return { ...defs, types, taxonomies, fields, ...(groups ? { groups } : {}) };
}

/** Removes a type and every reference to it. */
export function removeType(defs: ContentDefs, name: string): ContentDefs {
  const { [name]: _type, ...types } = defs.types;
  const { [name]: _fields, ...fields } = defs.fields;
  const taxonomies = Object.fromEntries(Object.entries(defs.taxonomies).map(([k, t]) => [k, { ...t, types: t.types.filter((x) => x !== name) }]));
  const cleaned = Object.fromEntries(Object.entries(fields).map(([k, list]) => [k, list.map((f) => (f.postType === name ? { ...f, postType: '' } : f))]));
  const keep = (x: string) => x !== name;
  const groups = defs.groups && Object.fromEntries(Object.entries(defs.groups).map(([k, g]) => [k, { ...g, types: g.types.filter(keep), except: g.except.filter(keep), fields: g.fields.map((f) => (f.postType === name ? { ...f, postType: '' } : f)) }]));
  return { ...defs, types, taxonomies, fields: cleaned, ...(groups ? { groups } : {}) };
}

export function removeTaxonomy(defs: ContentDefs, name: string): ContentDefs {
  const { [name]: _gone, ...taxonomies } = defs.taxonomies;
  const { [`term:${name}`]: _fields, ...fields } = defs.fields;
  return { ...defs, taxonomies, fields };
}

/**
 * What a fields key names (docs/spec/content.md §2): a content type (`evento`, `post`), the terms of a taxonomy
 * (`term:category`) or users (`user`), with the expressions that reach one: on its own page and inside a loop.
 */
export function targetOf(key: string): { kind: 'post' | 'term' | 'user'; single: string; loop: string; repeater: boolean } {
  if (key === 'user') return { kind: 'user', single: 'this.author', loop: 'item', repeater: false };
  if (key.startsWith('term:')) {
    const taxonomy = key.slice(5);
    const single = taxonomy === 'category' ? 'this.categories[0]' : taxonomy === 'post_tag' ? 'this.tags[0]' : `this.terms.${taxonomy}[0]`;
    return { kind: 'term', single, loop: 'item', repeater: false };
  }
  return { kind: 'post', single: 'this', loop: 'item', repeater: true };
}

/** Where a definition stands against the live site: only on WordPress after a release. */
export type Status = 'new' | 'changed' | 'live';
export function statusOf(kind: 'types' | 'taxonomies', name: string, defs: ContentDefs, live: ContentDefs): Status {
  const now = defs[kind][name];
  const before = live[kind][name];
  if (!before) return 'new';
  const sameFields = kind === 'types' ? JSON.stringify(defs.fields[name] ?? []) === JSON.stringify(live.fields[name] ?? []) : true;
  return JSON.stringify(now) === JSON.stringify(before) && sameFields ? 'live' : 'changed';
}

/** The expression that prints a field: an image prints its address, a repeater is a loop over its rows. */
export function fieldExpression(root: string, name: string, type: string, sub: Array<{ name: string; type: string; sub?: Array<{ name: string; type: string }> }> = []): string {
  if (type === 'repeater') {
    const first = sub[0];
    const value = (row: string, f: { name: string; type: string }) => (f.type === 'image' ? `{${row}.${f.name}.url}` : `{${row}.${f.name}}`);
    // A repeater as the first field of the row (D6): a loop inside the loop.
    const nested = first?.type === 'repeater' ? first.sub?.[0] : undefined;
    const inner = !first ? '{r}' : first.type === 'repeater' ? `{#loop r.${first.name} as o}${nested ? value('o', nested) : '{o}'}{/loop}` : value('r', first);
    return `{#loop ${root}.fields.${name} as r}${inner}{/loop}`;
  }
  if (type === 'image') return `{${root}.fields.${name}.url}`;
  if (type === 'post') return `{${root}.fields.${name}.title}`;
  return `{${root}.fields.${name}}`;
}

/** Problems that stop a save, in the author's words (the server checks again). */
export function problems(defs: ContentDefs): string[] {
  const out: string[] = [];
  for (const [type, list] of Object.entries(defs.fields)) {
    const seen: string[] = [];
    for (const f of list) {
      const p = fieldNameProblem(f.name, seen);
      if (p) out.push(`${type}: ${p}`);
      if (f.type === 'repeater' && !targetOf(type).repeater) out.push(t('{0}: il ripetitore "{1}" si usa solo nei contenuti, non in termini o utenti.', type, f.name));
      seen.push(f.name);
      if (f.type === 'select' && f.options.length === 0) out.push(t('{0}: il campo "{1}" è una scelta senza opzioni.', type, f.name));
      if (f.type === 'select' && f.options.some((o) => !/^[A-Za-z0-9_-]{1,64}$/.test(o.value))) out.push(t('{0}: un\'opzione di "{1}" ha un valore non valido (lettere, cifre, - e _).', type, f.name));
      if (f.type === 'post' && !f.postType) out.push(t('{0}: il campo "{1}" collega un contenuto: scegli di che tipo.', type, f.name));
      if (f.type === 'repeater') out.push(...subProblems(f).map((p) => `${type}: ${p}`));
    }
  }
  for (const [name, def] of Object.entries(defs.types)) if (!def.singular.trim() || !def.plural.trim()) out.push(t('{0}: scrivi il nome singolare e plurale.', name));
  return out;
}

function subProblems(f: { name: string; sub: SubField[] }, inner = false): string[] {
  const out: string[] = [];
  if (f.sub.length === 0 || f.sub.length > MAX_SUB) out.push(t('il ripetitore "{0}" deve avere da 1 a {1} campi.', f.name, MAX_SUB));
  const seen: string[] = [];
  for (const s of f.sub) {
    const p = fieldNameProblem(s.name, seen);
    if (p) out.push(`${f.name}: ${p}`);
    seen.push(s.name);
    if (inner && s.type === 'repeater') out.push(t('{0}: "{1}" non può stare in un ripetitore dentro una riga.', f.name, s.name));
    else if (!SUB_FIELD_TYPES.some((t) => t.value === s.type)) out.push(t('{0}: "{1}" non può stare in un ripetitore.', f.name, s.name));
    if (!inner && s.type === 'repeater') out.push(...subProblems({ name: s.name, sub: s.sub ?? [] }, true).map((p) => `${f.name}: ${p}`));
    if (s.type === 'select' && s.options.length === 0) out.push(t('{0}: "{1}" è una scelta senza opzioni.', f.name, s.name));
    if (s.type === 'select' && s.options.some((o) => !/^[A-Za-z0-9_-]{1,64}$/.test(o.value))) out.push(t('{0}: un\'opzione di "{1}" ha un valore non valido (lettere, cifre, - e _).', f.name, s.name));
  }
  return out;
}

/** Options of a choice, one per line: `valore: Etichetta` (or just the label, which gives the value). */
export function optionsText(options: Array<{ value: string; label: string }>): string {
  return options.map((o) => (o.value === slugify(o.label, 64) ? o.label : `${o.value}: ${o.label}`)).join('\n');
}

export function parseOptions(text: string): Array<{ value: string; label: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      const value = at > 0 ? line.slice(0, at).trim() : slugify(line, 64) || 'opzione';
      return { value, label: at > 0 ? line.slice(at + 1).trim() || value : line };
    });
}

/** Field types of other plugins that hold several values: they are read with a loop. */
const LISTS = new Set(['repeater', 'flexible_content', 'gallery', 'relationship']);

/**
 * How to show a field of another plugin: a loop for rows and lists (with the first sub field, or the image
 * address), a single expression otherwise.
 */
export function providerExpression(field: { name: string; type: string; sub: Array<{ name: string }>; optionsPage?: string | null }): string {
  // A field of an options page (D5) is read from site.options, the page's slug with underscores for dashes.
  const path = field.optionsPage ? `site.options.${field.optionsPage.replace(/-/g, '_')}.${field.name}` : `this.fields.${field.name}`;
  if (LISTS.has(field.type)) {
    const inner = field.type === 'gallery' ? '{r.url}' : field.type === 'relationship' ? '{r.title}' : `{r.${field.sub[0]?.name ?? 'chiave'}}`;
    return `{#loop ${path} as r}${inner}{/loop}`;
  }
  if (field.optionsPage) return field.type === 'image' ? `{${path}.url}` : field.type === 'post_object' ? `{${path}.title}` : `{${path}}`;
  return fieldExpression('this', field.name, field.type === 'image' ? 'image' : field.type === 'post_object' ? 'post' : field.type);
}
