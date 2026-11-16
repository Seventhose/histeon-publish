import { describe, expect, it } from 'vitest';
import { parse } from '@xb/dsl';
import { blankPreset, loopSnippet, nameProblem, parameters, parseArgs } from '../src/lib/queries.ts';

describe('queries', () => {
  it('validates names', () => {
    expect(nameProblem('news', [])).toBeNull();
    expect(nameProblem('posts', [])).toMatch(/predefinita/);
    expect(nameProblem('1x', [])).toMatch(/non valido/);
    expect(nameProblem('news', ['news'])).toMatch(/già/);
  });

  it('parses arguments and refuses visibility overrides', () => {
    expect(parseArgs('{"post_type":"post"}')).toEqual({ args: { post_type: 'post' } });
    expect(parseArgs('')).toEqual({ args: {} });
    expect(parseArgs('[1]')).toHaveProperty('error');
    expect(parseArgs('{oops')).toHaveProperty('error');
    expect(parseArgs('{"post_status":"draft"}')).toHaveProperty('error');
    expect(parseArgs('{"Bad Key":1}')).toHaveProperty('error');
  });

  it('finds loop parameters, nested too', () => {
    expect(parameters({ a: '$count ?? 3', b: { c: ['$cat'] }, d: 'x$y' })).toEqual(['cat', 'count']);
  });

  it('generates loops that parse', () => {
    for (const type of ['posts', 'terms', 'main'] as const) {
      const snippet = loopSnippet('news', blankPreset(type));
      expect(() => parse(snippet)).not.toThrow();
    }
  });

  it('generates loops in groups that parse, with the same groupBy as the code (item 205)', () => {
    const snippet = loopSnippet('foto', blankPreset('posts'), { field: 'date', how: 'Y' });
    expect(snippet).toContain('{#loop foto(count: 3).groupBy("date", "Y") as gruppo}');
    expect(snippet).toContain('<h2>{gruppo.key}</h2>');
    expect(snippet).toContain('{#loop gruppo.items as item}');
    const { blocks } = parse(snippet);
    const outer = (blocks[0] as { children: Array<{ name: string; attrs: Record<string, unknown> }> }).children[0]!;
    expect(outer.name).toBe('xb/loop');
    expect(outer.attrs.source).toEqual({ kind: 'preset', id: 'foto', args: { count: '3' }, groupBy: { field: 'date', how: 'Y' } });
    expect(() => parse(loopSnippet('nomi', blankPreset('main'), { field: 'title', how: 'letter' }))).not.toThrow();
    // Without a grouping the loop is the one it always was.
    expect(loopSnippet('foto', blankPreset('posts'))).toBe('<div>{#loop foto(count: 3) as item}<article><h3><a href={item.url}>{item.title}</a></h3><p>{item.excerpt.truncateWords(20)}</p></article>{/loop}</div>');
  });
});
