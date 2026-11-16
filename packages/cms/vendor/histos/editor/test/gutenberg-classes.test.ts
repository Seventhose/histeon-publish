import { describe, expect, it } from 'vitest';
import { classTokens, validClass, withClass, withoutClass } from '../src/gutenberg/classes.ts';

describe('class chips in Gutenberg', () => {
  it('keeps expressions whole', () => {
    expect(classTokens('card  card--{props.variant} is-{a ? "x" : "y"}')).toEqual(['card', 'card--{props.variant}', 'is-{a ? "x" : "y"}']);
    expect(classTokens(true)).toEqual([]);
  });

  it('adds once and removes exactly', () => {
    expect(withClass('a b', 'c')).toBe('a b c');
    expect(withClass('a b', 'a')).toBe('a b');
    expect(withoutClass('a card--{v} b', 'a')).toBe('card--{v} b');
    expect(validClass('ok-name')).toBe(true);
    expect(validClass('no space')).toBe(false);
    expect(validClass('"x')).toBe(false);
  });
});
