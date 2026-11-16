import { describe, expect, it } from 'vitest';
import { dropAt, grow, snap } from '../src/lib/handles.ts';

describe('canvas handles', () => {
  it('grows a padding inwards and a margin outwards', () => {
    expect(grow('padding-top', 0, 10)).toBe(10);
    expect(grow('padding-bottom', 0, 10)).toBe(-10);
    expect(grow('padding-right', -8, 0)).toBe(8);
    expect(grow('margin-top', 0, -12)).toBe(12);
    expect(grow('margin-bottom', 0, 12)).toBe(12);
  });

  it('snaps to the framework scale, or to whole pixels', () => {
    const steps = [
      { label: '0', value: '0', px: 0 },
      { label: 's', value: 'var(--space-s)', px: 16 },
      { label: 'm', value: 'var(--space-m)', px: 24 },
    ];
    expect(snap(19, steps).label).toBe('s');
    expect(snap(21, steps).label).toBe('m');
    expect(snap(-5, steps).label).toBe('0');
    expect(snap(21.4, steps, true)).toEqual({ label: '21px', value: '21px', px: 21 });
    expect(snap(-3, [], false).value).toBe('0');
  });

  it('places a drop like the structure does', () => {
    const all = () => true;
    expect(dropAt(102, 100, 100, all)).toBe('before');
    expect(dropAt(198, 100, 100, all)).toBe('after');
    expect(dropAt(150, 100, 100, all)).toBe('inside');
    expect(dropAt(140, 100, 100, (p) => p !== 'inside')).toBe('before');
    expect(dropAt(140, 100, 100, () => false)).toBeNull();
  });
});
