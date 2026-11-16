// Languages (docs/spec/i18n.md). The builder is written in Italian; for every other language the server sends
// the English catalog (Italian → English) in the page configuration, read here once, before any module uses t().

export type Catalog = Record<string, string>;

function initial(): Catalog {
  const w = globalThis as { xbStrings?: unknown; xbBuilder?: { strings?: unknown }; xbInspector?: { strings?: unknown } };
  const strings = w.xbStrings ?? w.xbBuilder?.strings ?? w.xbInspector?.strings;
  return strings && typeof strings === 'object' && !Array.isArray(strings) ? (strings as Catalog) : {};
}

let catalog: Catalog = initial();

/** Replaces the catalog (tests). */
export function setCatalog(next: Catalog): void {
  catalog = next;
}

function fill(text: string, args: Array<string | number>): string {
  return args.length === 0 ? text : text.replace(/\{(\d+)\}/g, (all, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : all));
}

/** A text of the interface, in the user's language: `t('Salva')`, `t('Salvato {0}', name)`. */
export function t(text: string, ...args: Array<string | number>): string {
  return fill(catalog[text] ?? text, args);
}

/**
 * A text whose Italian word means different things in different places: `tx('Comandi', 'video')`. The catalog key
 * is the context, U+0004 and the text (as gettext's msgctxt).
 */
export function tx(text: string, context: string, ...args: Array<string | number>): string {
  return fill(catalog[`${context}\u0004${text}`] ?? text, args);
}

/** A text that depends on a count: `tn('{0} elemento', '{0} elementi', n, n)`. */
export function tn(one: string, many: string, count: number, ...args: Array<string | number>): string {
  return t(count === 1 ? one : many, ...args);
}

/** The user's language for dates and numbers (the builder page's `lang`, set from the WordPress user locale). */
export function dateLocale(): string {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang;
  return lang || 'it-IT';
}
