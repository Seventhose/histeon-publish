import { describe, expect, it } from 'vitest';
import { GROUPINGS, groupByOf, groupingOf, groupSentence, sameGroupBy } from '../src/lib/loopGroups.ts';

// Doc 23 of Publish, items 187 and 205: the groupings Gutenberg's loop panel and the builder's Query panel share.
describe('loop groupings', () => {
  it('maps each offered grouping to its groupBy and back', () => {
    expect(GROUPINGS.map((g) => g.value)).toEqual(['year', 'month', 'letter']);
    expect(groupByOf('year')).toEqual({ field: 'date', how: 'Y' });
    expect(groupByOf('month')).toEqual({ field: 'date', how: 'F Y' });
    expect(groupByOf('letter')).toEqual({ field: 'title', how: 'letter' });
    expect(groupByOf('')).toBeUndefined();
    expect(groupByOf('code')).toBeUndefined();
    for (const g of GROUPINGS) expect(groupingOf(g.groupBy)).toBe(g.value);
    expect(groupingOf(undefined)).toBe('');
    expect(groupingOf({ field: 'fields.tipo' })).toBe('code');
    // A copy: changing it does not change the offered grouping.
    const copy = groupByOf('year') as { field: string };
    copy.field = 'x';
    expect(groupByOf('year')).toEqual({ field: 'date', how: 'Y' });
  });

  it('compares and says a grouping in words', () => {
    expect(sameGroupBy({ field: 'date' }, { field: 'date', how: '' })).toBe(true);
    expect(sameGroupBy({ field: 'date', how: 'Y' }, { field: 'date', how: 'F Y' })).toBe(false);
    expect(groupSentence({ field: 'fields.tipo' })).toBe('in gruppi per valore di «fields.tipo»');
    expect(groupSentence({ field: 'title', how: 'letter' })).toBe('in gruppi per iniziale di «title»');
    expect(groupSentence({ field: 'date', how: 'Y' })).toBe('in gruppi per «date» col formato «Y»');
  });
});
