import { describe, expect, it } from 'vitest';
import { balanced, namesClass, prettyRule, rulesFor } from '../src/lib/sheet.ts';

const css = `/* .card in a comment { } */
:root { --x: 1 }
.card { gap: 1rem }
.cardigan, .card-alt { color: red }
.list > .card:hover, .x { color: "}" }
@media (width > 600px) { .wrap .card { padding: 0 } .other { margin: 0 } }
.card { & .card__t { font-weight: 700 } }
a[href=".card"] { color: blue }`;

describe('rules of a class in a global sheet', () => {
  it('finds the class as a whole name, in groups and with nesting', () => {
    const found = rulesFor(css, 'card').map((r) => [css.slice(r.from, r.to), r.within]);
    expect(found).toEqual([
      ['.card { gap: 1rem }', []],
      ['.list > .card:hover, .x { color: "}" }', []],
      ['.wrap .card { padding: 0 }', ['@media (width > 600px)']],
      ['.card { & .card__t { font-weight: 700 } }', []],
    ]);
  });

  it('does not match prefixes, attribute values or escaped longer names', () => {
    expect(namesClass('.card-alt', 'card')).toBe(false);
    expect(namesClass('.card__t', 'card')).toBe(false);
    expect(namesClass('[class=".card"]', 'card')).toBe(false);
    expect(namesClass('.md\\:card', 'card')).toBe(false);
    expect(namesClass('.a.card', 'card')).toBe(true);
    expect(rulesFor(css, 'card__t')).toEqual([]);
  });
});

describe('one rule in the CSS panel', () => {
  it('formats a minified rule and is idempotent', () => {
    const raw = '.vl-hero{position:relative;background:url("a;b.png");grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}';
    const pretty = prettyRule(raw);
    expect(pretty).toBe('.vl-hero {\n  position:relative;\n  background:url("a;b.png");\n  grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))\n}');
    expect(prettyRule(pretty)).toBe(pretty);
    const nested = prettyRule('.a{color:red;&:hover{color:blue}}');
    expect(nested).toBe('.a {\n  color:red;\n  &:hover {\n    color:blue\n  }\n}');
    expect(prettyRule(nested)).toBe(nested);
  });

  it('accepts only rules whose braces close where they open', () => {
    expect(balanced('.a { color: red }')).toBe(true);
    expect(balanced('.a { content: "}" }')).toBe(true);
    expect(balanced('.a { color: red } } .b {')).toBe(false);
    expect(balanced('.a { color: red')).toBe(false);
    expect(balanced('.a { /* } */ color: red }')).toBe(true);
    expect(balanced('.a { /* unterminated }')).toBe(false);
  });
});
