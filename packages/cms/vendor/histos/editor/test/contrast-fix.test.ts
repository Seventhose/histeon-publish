import { describe, expect, it } from 'vitest';
import { contrast, contrastFix } from '../src/lib/checks.ts';
import { oklchToRgb, rgbToOklch } from '../src/lib/oklch.ts';

// Lista della spesa 164: a contrast too low comes with the nearest colour that passes, same hue, in OKLCH.
describe('contrasto in OKLCH', () => {
  it('rgbToOklch è l’inversa di oklchToRgb', () => {
    const [L, c, h] = rgbToOklch(37, 99, 235);
    const [r, g, b] = oklchToRgb(L, c, h);
    expect([Math.round(r), Math.round(g), Math.round(b)]).toEqual([37, 99, 235]);
  });

  it('un grigio chiaro su bianco diventa più scuro, quanto basta, con la stessa tinta', () => {
    const white = [255, 255, 255, 1] as [number, number, number, number];
    const fg = [170, 170, 190, 1] as [number, number, number, number];
    expect(contrast(fg, white)).toBeLessThan(4.5);
    const fix = contrastFix(fg, white, 4.5)!;
    expect(fix.darker).toBe(true);
    const [L, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(fix.color)!.slice(1).map(Number) as [number, number, number];
    const [r, g, b] = oklchToRgb(L, c, h);
    expect(contrast([r, g, b, 1], white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast([r, g, b, 1], white)).toBeLessThan(4.7); // the nearest, not black
    expect(Math.abs(h - rgbToOklch(170, 170, 190)[2])).toBeLessThan(1);
  });

  it('su uno sfondo scuro il testo diventa più chiaro', () => {
    const back = [20, 20, 40, 1] as [number, number, number, number];
    const fix = contrastFix([70, 70, 110, 1], back, 4.5)!;
    expect(fix.darker).toBe(false);
  });
});
