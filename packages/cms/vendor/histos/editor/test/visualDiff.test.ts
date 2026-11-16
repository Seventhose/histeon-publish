import { describe as group, expect, it } from 'vitest';
import { align, appearanceSummary, compare, describe, type SigNode } from '../src/lib/visualDiff.ts';

const node = (key: string, box: Partial<SigNode> = {}, s = 'block'): SigNode => ({ key, x: 0, y: 0, w: 100, h: 20, s, ...box });

group('align', () => {
  it('pairs equal keys around a change in the middle', () => {
    expect(align(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });
  it('handles insertions and removals', () => {
    expect(align(['a', 'b'], ['a', 'n', 'b'])).toEqual([
      [0, 0],
      [1, 2],
    ]);
    expect(align(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });
});

group('compare', () => {
  it('same page: nothing to show', () => {
    const page = [node('div||'), node('h1||Titolo')];
    const r = compare(page, page.map((n) => ({ ...n })));
    expect(r?.same).toBe(true);
    expect(describe(r)).toBe('Nessuna differenza visibile');
  });

  it('new text, other colour, element gone', () => {
    const before = [node('h1||Titolo'), node('p||Vecchio'), node('a|btn|Vai', {}, 'red')];
    const after = [node('h1||Titolo'), node('p||Nuovo'), node('a|btn|Vai', {}, 'blue')];
    const r = compare(before, after)!;
    expect(r.added).toEqual([1]);
    expect(r.removed).toEqual([1]);
    expect(r.changed).toEqual([2]);
    expect(describe(r)).toBe("1 elemento nuovo, 1 tolto, 1 cambiato nell'aspetto");
  });

  it('a box that grows because of what is inside is not marked, one that grows by itself is', () => {
    const before = [node('section||', { h: 200 }), node('p||Uno'), node('img||', { w: 100 })];
    const after = [node('section||', { h: 240 }), node('p||Uno'), node('p||Due'), node('img||', { w: 160 })];
    const inside = (outer: number, inner: number) => outer === 0 && inner > 0;
    const r = compare(before, after, inside)!;
    expect(r.added).toEqual([2]);
    expect(r.changed).toEqual([3]);
  });

  it('elements pushed down by a change above only count as moved', () => {
    const before = [node('h1||A'), node('p||B', { y: 40 })];
    const after = [node('h1||A', { h: 60 }), node('p||B', { y: 80 })];
    const r = compare(before, after)!;
    expect(r.changed).toEqual([0]);
    expect(r.moved).toBe(1);
  });

  it('rounding is not a difference', () => {
    const r = compare([node('p||A', { w: 100 })], [node('p||A', { w: 102, y: 1 })])!;
    expect(r.same).toBe(true);
    expect(r.moved).toBe(0);
  });
});

group('appearanceSummary (V7.1)', () => {
  const same = compare([node('h1||A')], [node('h1||A')]);
  const changed = compare([node('h1||A')], [node('h1||B')]);
  it('counts the pages that change at each screen', () => {
    expect(
      appearanceSummary([
        { vp: 'desktop', result: same },
        { vp: 'desktop', result: changed },
        { vp: 'desktop', result: null },
        { vp: 'mobile', result: same },
        { vp: 'mobile', result: changed },
      ]),
    ).toEqual({ desktop: 2, mobile: 1, failed: 0 });
  });
  it('nothing changes: zero and zero; a failed comparison is never «no change»', () => {
    expect(appearanceSummary([{ vp: 'desktop', result: same }, { vp: 'mobile', result: same }])).toEqual({ desktop: 0, mobile: 0, failed: 0 });
    expect(appearanceSummary([{ vp: 'mobile', result: 'La pagina non si può leggere da qui' }])).toEqual({ desktop: 0, mobile: 0, failed: 1 });
  });
});
