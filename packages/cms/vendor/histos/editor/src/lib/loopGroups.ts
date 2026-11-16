// A query loop's result in groups (doc 23 of Publish, items 187 and 205): `{#loop foto().groupBy("date", "Y") as
// gruppo}`. One data model everywhere: the loop's `source.groupBy` {field, how?}; each repetition is a group
// `{key, items}`. Gutenberg's loop panel and the builder's Query panel offer the same groupings from here.
import type { LoopGroupBy } from '@xb/dsl';
import { t } from './i18n.ts';

export type GroupBy = LoopGroupBy;

export type Grouping = 'year' | 'month' | 'letter';

/** The groupings the panels offer; another one, written in the code, is kept as it is. */
export const GROUPINGS: Array<{ value: Grouping; label: () => string; groupBy: GroupBy }> = [
  { value: 'year', label: () => t('Per anno di pubblicazione'), groupBy: { field: 'date', how: 'Y' } },
  { value: 'month', label: () => t('Per mese di pubblicazione'), groupBy: { field: 'date', how: 'F Y' } },
  { value: 'letter', label: () => t('Per iniziale del titolo'), groupBy: { field: 'title', how: 'letter' } },
];

export const sameGroupBy = (a: GroupBy, b: GroupBy): boolean => a.field === b.field && (a.how ?? '') === (b.how ?? '');

/** The offered grouping a `groupBy` is ('' none, 'code' one written in the code). */
export function groupingOf(groupBy: GroupBy | undefined): Grouping | 'code' | '' {
  if (!groupBy) return '';
  return GROUPINGS.find((option) => sameGroupBy(option.groupBy, groupBy))?.value ?? 'code';
}

/** The `groupBy` of an offered grouping (undefined: none). */
export function groupByOf(value: string): GroupBy | undefined {
  const option = GROUPINGS.find((entry) => entry.value === value);
  return option ? { ...option.groupBy } : undefined;
}

/** A grouped query loop in words: by value, by first letter or by date format. */
export function groupSentence(groupBy: GroupBy): string {
  if (groupBy.how === undefined) return t('in gruppi per valore di «{0}»', groupBy.field);
  if (groupBy.how === 'letter') return t('in gruppi per iniziale di «{0}»', groupBy.field);
  return t('in gruppi per «{0}» col formato «{1}»', groupBy.field, groupBy.how);
}

