import { describe, expect, it } from 'vitest';
import { appendQueryBlock, breakpointsFrom, clampWidth, conditionAt, holdsAt, widthPrelude } from '../src/lib/canvasWidth.ts';

describe('canvas at any width', () => {
  it('keeps widths in range', () => {
    expect(clampWidth(100)).toBe(240);
    expect(clampWidth(5000)).toBe(3840);
    expect(clampWidth(720.6)).toBe(721);
    expect(clampWidth(Number.NaN)).toBe(240);
  });

  it('reads the site breakpoints from named queries', () => {
    expect(breakpointsFrom({ mobile: '(width < 40em)', tablet: '(width < 64em)', desktop: '(width >= 64em)', wide: '(min-width: 1440px)', tall: '(orientation: portrait)', mix: '(40em <= width < 64em)' })).toEqual([
      { name: 'mobile', px: 640 },
      { name: 'desktop', px: 1024 },
      { name: 'tablet', px: 1024 },
      { name: 'wide', px: 1440 },
    ]);
  });

  it('writes queries from the current width, once', () => {
    expect(conditionAt(720, 'down')).toBe('(width <= 720px)');
    expect(conditionAt(1100, 'up')).toBe('(width >= 1100px)');
    const once = appendQueryBlock('padding: 1rem;', '@media (width <= 720px)');
    expect(once).toBe('padding: 1rem;\n@media (width <= 720px) {\n  \n}\n');
    expect(appendQueryBlock(once, '@media (width <= 720px)')).toBe(once);
    expect(appendQueryBlock('', '@container (width <= 400px)')).toBe('@container (width <= 400px) {\n  \n}\n');
  });
});

describe('edits at the canvas width', () => {
  const queries = { mobile: '(width < 40em)', tablet: '(width < 64em)', desktop: '(min-width: 1200px)', stampa: 'print' };
  it('the narrowest named query that holds', () => {
    expect(widthPrelude(queries, 390)).toBe('@media (--mobile)');
    expect(widthPrelude(queries, 800)).toBe('@media (--tablet)');
  });
  it('a «from» query when no «up to» one holds, else the canvas width', () => {
    expect(widthPrelude(queries, 1300)).toBe('@media (--desktop)');
    expect(widthPrelude(queries, 1100)).toBe('@media (width <= 1100px)');
    expect(widthPrelude({}, 500)).toBe('@media (width <= 500px)');
  });
  it('reads range and classic conditions', () => {
    expect(holdsAt('(max-width: 768px)', 768)).toEqual({ holds: true, bound: 768, upper: true });
    expect(holdsAt('(width > 40rem)', 640)).toEqual({ holds: false, bound: 640, upper: false });
    expect(holdsAt('screen and (orientation: portrait)', 500)).toBeNull();
  });
});
