import { describe, expect, it } from 'vitest';
import { FOLD_OVER, longValues } from '../src/lib/fold.ts';

describe('long attribute values', () => {
  it('folds only values over the limit, past their first characters', () => {
    const long = 'a'.repeat(FOLD_OVER + 20);
    const text = `<img src="/x.jpg" srcset="${long}" alt="ok" />`;
    const [range, ...rest] = longValues(text);
    expect(rest).toEqual([]);
    expect(text.slice(range!.start, range!.to)).toBe(long);
    expect(range!.to - range!.from).toBe(long.length - 24);
  });

  it('leaves short values and text content alone', () => {
    expect(longValues(`<p class="a">${'x'.repeat(300)}</p>`)).toEqual([]);
  });
});
