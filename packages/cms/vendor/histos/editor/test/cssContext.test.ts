import { describe, expect, it } from 'vitest';
import { bodyAt, rangeOf, setBodyAt, widthPreludes } from '../src/lib/cssContext.ts';

describe('mini GUI context: states and widths', () => {
  const css = 'color: red;\n/* nota */\n&:hover {\n  color: blue;\n}\n@media (--tablet) {\n  padding: 0;\n  &:hover { color: green; }\n}\n';

  it('reads the body of a nested block', () => {
    expect(bodyAt(css, [])).toBe(css);
    expect(bodyAt(css, ['&:hover']).trim()).toBe('color: blue;');
    expect(bodyAt(css, ['@media (--tablet)', '&:hover']).trim()).toBe('color: green;');
    expect(bodyAt(css, ['@media(--tablet)']).includes('padding: 0;'), 'spacing aside').toBe(true);
    expect(bodyAt(css, ['&:focus-visible'])).toBe('');
  });

  it('writes in place, keeping the rest as written', () => {
    const next = setBodyAt(css, ['&:hover'], 'color: navy;\n');
    expect(next).toContain('&:hover {\n  color: navy;\n}');
    expect(next).toContain('/* nota */');
    expect(next).toContain('@media (--tablet) {\n  padding: 0;\n  &:hover { color: green; }\n}');
  });

  it('creates missing blocks, nested, and removes emptied ones', () => {
    const created = setBodyAt('color: red;\n', ['@media (--mobile)', '&:active'], 'opacity: 0.8;\n');
    expect(created).toBe('color: red;\n@media (--mobile) {\n  &:active {\n    opacity: 0.8;\n  }\n}\n');
    expect(bodyAt(created, ['@media (--mobile)', '&:active']).trim()).toBe('opacity: 0.8;');
    expect(setBodyAt(css, ['&:hover'], '')).not.toContain('&:hover {\n');
    expect(setBodyAt('color: red;\n', ['&:hover'], ''), 'nothing to remove').toBe('color: red;\n');
  });

  it('finds where a block is, for the editor', () => {
    const r = rangeOf(css, ['&:hover'])!;
    expect(css.slice(r.from, r.to).trim()).toBe('color: blue;');
    expect(rangeOf(css, ['&:active'])).toBeNull();
  });
});

describe('widths the mini GUI offers (C3)', () => {
  const at = (w: number, d: 'down' | 'up') => (d === 'down' ? `(width < ${w}px)` : `(width >= ${w}px)`);

  it('adds the @media and @container blocks already written in the CSS, once', () => {
    const css = 'color: red;\n@container   (width > 30rem) { gap: 1px; }\n@media (--tablet) { padding: 0; }\n@media (width < 900px) { margin: 0; }\n&:hover { color: blue; }';
    expect(widthPreludes({ tablet: '(width < 60rem)' }, 900, at, css)).toEqual([
      { prelude: '@media (--tablet)', label: 'tablet' },
      { prelude: '@media (width < 900px)', label: '≤ 900px' },
      { prelude: '@container (width > 30rem)', label: '@container (width > 30rem)' },
    ]);
    // The mini GUI finds that block whatever its spacing.
    expect(bodyAt(css, ['@container (width > 30rem)'])).toBe(' gap: 1px; ');
  });
});
