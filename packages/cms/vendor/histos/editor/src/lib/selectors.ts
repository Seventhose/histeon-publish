import type { RenamePlan, SelectorUsage } from './api.ts';
import { t, tn } from './i18n.ts';

/** Selector manager helpers (SelectorsPanel) — docs/spec/styles.md §4. */

export type SelectorSort = 'name' | 'usage' | 'size';
/** Entries of the selector manager, classes defined in the global sheets, or both. */
export type SelectorOrigin = 'all' | 'entries' | 'sheets';

/** Same rule as the server (Selectors::NAME_PATTERN) and the CSS panel. */
export function validClassName(name: string): boolean {
  return /^-?[_a-zA-Z][_a-zA-Z0-9-]{0,99}$/.test(name);
}

/** How many places use a selector: editable documents, locked ones and theme templates. */
export function usageCount(row: SelectorUsage): number {
  return row.docs.length + row.locked + row.theme.length;
}

/** Search by name (case-insensitive substring), optional "unused only" filter, then sort. */
export function filterSelectors(rows: SelectorUsage[], query: string, sort: SelectorSort, unusedOnly = false, origin: SelectorOrigin = 'all'): SelectorUsage[] {
  const q = query.trim().toLowerCase();
  const out = rows.filter(
    (row) =>
      (!unusedOnly || row.unused) &&
      (origin === 'all' || (origin === 'sheets') === (row.sheet !== undefined)) &&
      (q === '' || row.selector.toLowerCase().includes(q)),
  );
  const byName = (a: SelectorUsage, b: SelectorUsage) => a.selector.localeCompare(b.selector, 'it');
  return out.sort((a, b) => {
    if (sort === 'usage') return usageCount(a) - usageCount(b) || byName(a, b);
    if (sort === 'size') return b.bytes - a.bytes || byName(a, b);
    return byName(a, b);
  });
}



/** Short usage badge text. */
export function usageLabel(row: SelectorUsage): string {
  if (row.always) return t('sempre');
  if (row.unused) return t('non usato');
  const n = usageCount(row);
  if (n === 0) return 'safelist';
  return tn('{0} uso', '{0} usi', n, n);
}

/** What a rename would do, line by line, in Italian. */
export function describePlan(plan: RenamePlan): string[] {
  const lines: string[] = [];
  if (plan.styles > 0) lines.push(tn('Stili: {0} selettore riscritto', 'Stili: {0} selettori riscritti', plan.styles, plan.styles));
  for (const doc of plan.docs) lines.push(tn('{0}: {1} classe', '{0}: {1} classi', doc.classes, doc.label || doc.doc, doc.classes));
  // Free HTML is listed occurrence by occurrence below the plan (C4); without the permission it stays by hand.
  if (!plan.html || !plan.htmlAllowed) for (const doc of plan.manual) lines.push(t('{0}: usata in HTML libero, da rinominare a mano', doc.label || doc.doc));
  if (plan.locked > 0) lines.push(tn('Bloccata: usata in {0} documento che non puoi modificare', 'Bloccata: usata in {0} documenti che non puoi modificare', plan.locked, plan.locked));
  if (plan.theme.length > 0) lines.push(t('Bloccata: usata nel tema ({0})', plan.theme.join(', ')));
  for (const doc of plan.blocked) lines.push(t('Bloccata: {0} contiene elementi che richiedono unfiltered_html', doc.label || doc.doc));
  if (plan.conflicts.length > 0) lines.push(t('Bloccata: nome già in uso ({0})', plan.conflicts.join(', ')));
  if (lines.length === 0) lines.push(t('Nessuno stile o documento usa questa classe.'));
  return lines;
}
