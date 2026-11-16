import { describe, expect, it } from 'vitest';
import { findClosingBrace, parseExpression } from '../src/index.ts';

describe('expressions', () => {
  it('respects precedence', () => {
    const e = parseExpression('a ?? b || c && d == e');
    expect(e).toMatchObject({ type: 'Binary', op: '??', right: { op: '||', right: { op: '&&', right: { op: '==' } } } });
  });

  it('parses modifiers, indexes and literals', () => {
    expect(parseExpression('post.title.truncateWords(20, "…")')).toMatchObject({
      type: 'Call',
      callee: { type: 'Member', property: 'truncateWords', object: { type: 'Member', property: 'title' } },
      args: [{ value: { value: 20 } }, { value: { value: '…' } }],
    });
    expect(parseExpression('item["a-b"][0]')).toMatchObject({ type: 'Index', object: { type: 'Index' } });
    expect(parseExpression('{a: [1, -2], "b": null}')).toMatchObject({ type: 'Object' });
    expect(parseExpression('!x')).toMatchObject({ type: 'Unary', op: '!' });
  });

  it('positions are absolute', () => {
    expect(parseExpression('xx{a.b}', 3, 6)).toMatchObject({ start: 3, end: 6 });
  });

  it('skips strings when matching braces', () => {
    expect(findClosingBrace('{a ?? "}"} tail', 0)).toBe(9);
  });
});
