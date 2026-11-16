import { describe, expect, it } from 'vitest';
import { compileCss } from '@xb/dsl';
import { blockOf, blockRules, nestedBody, overlap, planSheetMove, properties, relative, safeToMove, specificities, withoutRules } from '../src/lib/scss.ts';

const SHEET = `body { margin: 0; }
.card { padding: 1rem; border: 1px solid; }
.card:hover { color: red; }
.card__title { font-weight: 700; }
.cardigan { color: blue; }
.card, .tile { gap: 1rem; }
@media (width > 40em) {
  .card { padding: 2rem; }
  .card__title { font-size: 2em; }
  .other { color: green; }
}
.card--dark .card__title { color: white; }
`;

describe('SCSS view of a block in the sheet', () => {
  it('relative selectors', () => {
    expect(relative('.card', 'card')).toBe('');
    expect(relative('.card:hover', 'card')).toBe('&:hover');
    expect(relative('.card__title:hover', 'card')).toBe('&__title:hover');
    expect(relative('.card--dark .card__title', 'card')).toBe('&--dark .card__title');
    expect(relative('.card > a', 'card')).toBe('& > a');
    expect(relative('.card .x', 'card')).toBe('& .x');
    expect(relative('.card.is-open', 'card')).toBe('&.is-open');
    expect(relative('.cardigan', 'card')).toBeNull();
    expect(relative('.card-x', 'card')).toBeNull();
  });

  it('gathers the block\'s rules, leaves the shared ones and other blocks', () => {
    const { movable, shared } = blockRules(SHEET, 'card', 'global');
    expect(movable.map((r) => r.rel)).toEqual(['', '&:hover', '&__title', '', '&__title', '&--dark .card__title']);
    expect(shared).toHaveLength(1); // .card, .tile
    const body = nestedBody(movable);
    expect(body).toBe(
      ['padding: 1rem;', 'border: 1px solid;', '&:hover {', '  color: red;', '}', '&__title {', '  font-weight: 700;', '}', '@media (width > 40em) {', '  padding: 2rem;', '  &__title {', '    font-size: 2em;', '  }', '}', '&--dark .card__title {', '  color: white;', '}'].join('\n'),
    );
  });

  it('a minified body without its last `;` stays a declaration of its own', () => {
    const css = '.a{color:red}.a{margin:0}.a__x{gap:0}';
    const body = nestedBody(blockRules(css, 'a', 'g').movable);
    expect(body).toBe(['color:red;', 'margin:0;', '&__x {', '  gap:0;', '}'].join('\n'));
    expect(compileCss('.a', body).replace(/\s+/g, '')).toContain('.a{color:red;margin:0;}');
  });

  it('compiles back to the same rules, in the same order', () => {
    const { movable } = blockRules(SHEET, 'card', 'global');
    const css = compileCss('.card', nestedBody(movable)).replace(/\s+/g, ' ');
    expect(css).toContain('.card{padding: 1rem;');
    expect(css).toContain('.card__title{font-weight: 700;}');
    expect(css).toContain('@media (width > 40em){.card__title{font-size: 2em;}}');
    expect(css).toContain('.card--dark .card__title{color: white;}');
  });

  it('the sheet keeps everything else; emptied @media go', () => {
    const { movable } = blockRules(SHEET, 'card', 'global');
    const rest = withoutRules(SHEET, movable);
    expect(rest).toContain('body { margin: 0; }');
    expect(rest).toContain('.cardigan { color: blue; }');
    expect(rest).toContain('.card, .tile { gap: 1rem; }');
    expect(rest).toContain('.other { color: green; }');
    expect(rest).not.toMatch(/\.card(?:__title)? \{|\.card:hover|\.card--dark/);
    const only = '@media print {\n  .card { color: black; }\n}\n.x { a: b; }\n';
    expect(withoutRules(only, blockRules(only, 'card', 'g').movable)).toBe('.x { a: b; }\n');
  });
});

describe('moving keeps the cascade', () => {
  it('a rule that a later shared rule overrides stays in the sheet', () => {
    const css = '.card { gap: 2rem; color: red; }\n.card__x { margin: 0; }\n.card, .tile { gap: 1rem; }\n';
    const { movable } = blockRules(css, 'card', 'g');
    const { move, keep } = safeToMove(css, movable, ['card', 'tile']);
    expect(keep.map((r) => r.rel)).toEqual(['']); // .card sets gap, which `.card, .tile` sets later
    expect(move.map((r) => r.rel)).toEqual(['&__x']);
  });
  it('another class of the element, set later on the same property, keeps the rule too', () => {
    const css = '.card { color: red; }\n.btn { color: blue; }\n.card { padding: 0; }\n';
    const { movable } = blockRules(css, 'card', 'g');
    const { move, keep } = safeToMove(css, movable, ['card', 'btn']);
    expect(keep).toHaveLength(1);
    expect(move.map((r) => r.body)).toEqual(['padding: 0;']);
    expect(safeToMove(css, movable, ['card']).keep).toHaveLength(0);
  });
});

describe('minified sheets', () => {
  it('rules without the last semicolon do not run together', () => {
    const css = '.vl-wrap{max-width:var(--w)}.vl-x{color:red}.vl-wrap{padding:0}@media (max-width:600px){.vl-wrap{margin:0}.vl-wrap__a{gap:0}}';
    const { movable } = blockRules(css, 'vl-wrap', 'g');
    const body = nestedBody(movable);
    expect(body).toContain('max-width:var(--w);');
    expect(body).toContain('padding:0;');
    const out = compileCss('.vl-wrap', body).replace(/\s+/g, '');
    expect(out).toContain('.vl-wrap{max-width:var(--w);padding:0;@media(max-width:600px){margin:0;}}');
    expect(out).toContain('@media(max-width:600px){.vl-wrap__a{gap:0;}}');
  });
});

describe('every block at once', () => {
  const used = (...names: string[]) => new Set(names);

  it('block roots and the helpers of the cascade', () => {
    expect(blockOf('card__title')).toBe('card');
    expect(blockOf('card--dark')).toBe('card');
    expect(blockOf('card')).toBe('card');
    expect(blockOf('my-card__a--b')).toBe('my-card');
    expect([...properties('color: red; --x: url(a;b); &:hover { padding-top: 0; }')]).toEqual(['color', '--x', 'padding-top']);
    expect(overlap(new Set(['padding']), new Set(['padding-top']))).toBe('padding / padding-top');
    expect(overlap(new Set(['margin-left']), new Set(['margin-inline']))).not.toBeNull();
    expect(overlap(new Set(['top']), new Set(['inset']))).not.toBeNull();
    expect(overlap(new Set(['text-align']), new Set(['text-transform']))).toBeNull();
    expect(overlap(new Set(['--a']), new Set(['--b']))).toBeNull();
    expect(specificities('.a, #b .c, a:hover, .x::before')).toEqual([100, 10100, 101, 101]);
    expect(specificities('.a:not(.b)')).toBeNull();
  });

  it('groups by block in order of appearance, nests, empties the sheet', () => {
    const css = `.tile { gap: 1rem; }\n.card { padding: 1rem; }\n.card__title { font-weight: 700; }\n@media (width > 40em) {\n  .tile__x { gap: 2rem; }\n  .card:hover { color: red; }\n}\n:root { --x: 1; }\n`;
    const plan = planSheetMove([{ id: 'global', css }], [], used('card', 'tile__x'));
    expect(plan.blocks.map((b) => [b.selector, b.rules])).toEqual([['.tile', 2], ['.card', 3]]);
    expect(plan.moved).toBe(5);
    expect(plan.cascade).toEqual([]);
    expect(plan.blocks[1]?.body).toBe(['padding: 1rem;', '&__title {', '  font-weight: 700;', '}', '@media (width > 40em) {', '  &:hover {', '    color: red;', '  }', '}'].join('\n'));
    expect(plan.sheets.global).toBe(':root { --x: 1; }\n');
    expect(plan.entries.map((e) => e.selector)).toEqual(['.tile', '.card']);
  });

  it('only used blocks move; shared lists stay', () => {
    const css = '.card { color: red; }\n.old { width: 1px; }\n.old__x { margin: 0; }\n.card, .tile { border: 0; }\n';
    const plan = planSheetMove([{ id: 'g', css }], [], used('card'));
    expect(plan.blocks.map((b) => b.block)).toEqual(['card']);
    expect(plan.unused).toEqual({ blocks: ['old'], rules: 2 });
    expect(plan.shared).toBe(1);
    expect(plan.sheets.g).toBe('.old { width: 1px; }\n.old__x { margin: 0; }\n.card, .tile { border: 0; }\n');
  });

  it('a rule stays when a later shared rule sets the same property, and so do the earlier ones it holds back', () => {
    const css = '.card { gap: 2rem; }\n.card__x { gap: 0; }\n.card, .tile { gap: 1rem; }\n.card__y { margin: 0; }\n';
    const plan = planSheetMove([{ id: 'g', css }], [], used('card', 'tile'));
    expect(plan.cascade.map((k) => k.selector).sort()).toEqual(['.card', '.card__x']);
    expect(plan.cascade.find((k) => k.selector === '.card__x')?.against).toBe('.card, .tile');
    expect(plan.cascade.find((k) => k.selector === '.card')?.against).toBe('.card__x');
    expect(plan.blocks[0]?.body).toBe('&__y {\n  margin: 0;\n}');
  });

  it('a BEM part followed by a rule of the block that is not one stays: the compiler would print it after', () => {
    // compileCss writes `&__g …` after `& a[…]`: with the same specificity the first one would win.
    const css = '.nav a { color: white; }\n.nav__g:first-of-type a { background: grey; }\n.nav a[aria-current=page] { background: gold; }\n.nav__n { margin: 0; }\n';
    const plan = planSheetMove([{ id: 'g', css }], [], used('nav', 'nav__g', 'nav__n'));
    expect(plan.cascade).toEqual([{ sheet: 'g', selector: '.nav__g:first-of-type a', against: '.nav a[aria-current=page]', property: 'background' }]);
    expect(plan.sheets.g).toBe('.nav__g:first-of-type a { background: grey; }\n');
    expect(plan.blocks[0]?.body).toBe('& a {\n  color: white;\n}\n& a[aria-current=page] {\n  background: gold;\n}\n&__n {\n  margin: 0;\n}');
    // The other way round the order is the compiler's own, and a different specificity does not depend on order.
    const ordered = '.nav a[aria-current=page] { background: gold; }\n.nav__g:first-of-type a { background: grey; }\n';
    expect(planSheetMove([{ id: 'g', css: ordered }], [], used('nav')).cascade).toEqual([]);
    expect(planSheetMove([{ id: 'g', css: css.replace('.nav a[aria-current=page]', '.nav.nav a[aria-current=page]') }], [], used('nav')).cascade).toEqual([]);
  });

  it('interleaved blocks: a rule followed by a block whose entry prints earlier stays', () => {
    // .b first appears before .a's second rule; .a{color} then .b{color}: b's entry prints before a's.
    const css = '.b { margin: 0; }\n.a { color: red; }\n.b--x { color: blue; }\n.a__y { padding: 0; }\n';
    const plan = planSheetMove([{ id: 'g', css }], [], used('a', 'b'));
    expect(plan.cascade).toEqual([{ sheet: 'g', selector: '.a', against: '.b--x', property: 'color' }]);
    expect(plan.blocks.map((b) => [b.block, b.rules])).toEqual([['b', 2], ['a', 1]]);
    // A different specificity does not depend on order.
    const deeper = planSheetMove([{ id: 'g', css: css.replace('.b--x {', '.b--x.b--x {') }], [], used('a', 'b'));
    expect(deeper.cascade).toEqual([]);
  });

  it('a later rule of the same family in another sheet keeps it too; `only` moves one sheet', () => {
    const sheets = [
      { id: 'site', css: '.card { padding: 1rem; }\n.card__t { color: red; }\n' },
      { id: 'acss', css: '.pad--m { padding-top: 2rem; }\n' },
    ];
    // Both move: .pad's entry prints after .card's, as the sheets did.
    const all = planSheetMove(sheets, [], used('card', 'pad--m'));
    expect(all.cascade).toEqual([]);
    expect(all.blocks.map((b) => b.block)).toEqual(['card', 'pad']);
    // Only the site's sheet: .pad--m stays in its sheet, after .card's entry would print… before it.
    const one = planSheetMove(sheets, [], used('card', 'pad--m'), 'site');
    expect(one.cascade.map((k) => [k.selector, k.property])).toEqual([['.card', 'padding / padding-top']]);
    expect(Object.keys(one.sheets)).toEqual(['site']);
    expect(one.blocks.map((b) => [b.block, b.rules])).toEqual([['card', 1]]);
  });

  it('new entries go first; an existing entry gets the rules before its own CSS, unless an earlier entry overrides', () => {
    const styles = [{ selector: '.btn', css: 'color: blue;' }, { selector: '.card', css: 'margin: 0;' }];
    const css = '.hero { margin: 0; }\n.card { color: red; }\n.card__t { padding: 0; }\n';
    const plan = planSheetMove([{ id: 'g', css }], styles, used('card', 'hero', 'btn'));
    // .card prints after .btn now (both entries): its color would beat the button's, so it stays.
    expect(plan.cascade).toEqual([{ sheet: 'g', selector: '.card', against: '.btn (selettore .btn)', property: 'color' }]);
    expect(plan.entries).toEqual([
      { selector: '.hero', css: 'margin: 0;\n' },
      { selector: '.card', css: '&__t {\n  padding: 0;\n}\nmargin: 0;\n' },
    ]);
    expect(plan.blocks.map((b) => b.existing)).toEqual([false, true]);
  });

  it('an unused block that comes later still counts for the cascade', () => {
    const css = '.card { padding: 1rem; }\n@media (width > 40em) { .card__t { color: blue; } }\n.x { color: green; }\n';
    const plan = planSheetMove([{ id: 'g', css }], [], used('card'));
    expect(plan.cascade).toEqual([{ sheet: 'g', selector: '.card__t', against: '.x', property: 'color' }]);
    expect(plan.sheets.g).toBe('@media (width > 40em) { .card__t { color: blue; } }\n.x { color: green; }\n');
    expect(compileCss('.card', plan.entries[0]?.css ?? '')).toContain('padding: 1rem;');
  });
});
