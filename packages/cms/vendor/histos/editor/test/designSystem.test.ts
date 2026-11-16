import { describe, expect, it } from 'vitest';
import { colorFamilies, colorFamilyKey, kindOf, recipeProblem, siteNameProblem, tokenProblem } from '../src/lib/designSystem.ts';

const isColor = (v: string) => /^(#|rgb|hsl|oklch|oklab|color\()/.test(v.trim());

describe('design system panel', () => {
  it('sorts variables by what they are', () => {
    expect(kindOf('xb-primary', 'oklch(55% 0.2 265)', isColor)).toBe('color');
    expect(kindOf('xb-text', 'oklch(25% 0.02 265)', isColor), 'the text colour').toBe('color');
    expect(kindOf('xb-text-l', 'clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem)', isColor)).toBe('text');
    expect(kindOf('text-xxl', '3rem', isColor)).toBe('text');
    expect(kindOf('space-m', '1.5rem', isColor)).toBe('space');
    expect(kindOf('xb-radius-m', '0.5rem', isColor)).toBe('radius');
    expect(kindOf('box-shadow-1', '0 1px 2px #0002', isColor)).toBe('shadow');
    expect(kindOf('content-width', '72rem', isColor)).toBe('other');
  });

  it('checks values like the server does', () => {
    expect(tokenProblem('oklch(60% 0.2 30)')).toBeNull();
    expect(tokenProblem('clamp(1rem, 0.9rem + 0.5vw, 1.5rem)')).toBeNull();
    expect(tokenProblem('#ff6f5e')).toBeNull();
    expect(tokenProblem('red;} body{x:y')).not.toBeNull();
    expect(tokenProblem('url(x)')).not.toBeNull();
    expect(tokenProblem('calc(1px + (2px)')).toMatch(/Parentesi/);
    expect(tokenProblem('')).toMatch(/vuoto/);
  });

  it('groups colours by family: the base colour shows, its shades and transparencies wait for a click', () => {
    expect(colorFamilyKey('xb-primary-700')).toBe('xb-primary');
    expect(colorFamilyKey('xb-primary-a40')).toBe('xb-primary');
    expect(colorFamilyKey('xb-on-primary')).toBe('xb-primary');
    expect(colorFamilyKey('primary-ultra-light')).toBe('primary');
    expect(colorFamilyKey('primary-light-trans-20')).toBe('primary');
    expect(colorFamilyKey('xb-text-muted'), 'a role is its own family').toBe('xb-text-muted');
    const names = ['xb-primary', 'xb-primary-50', 'xb-primary-a10', 'xb-on-primary', 'xb-secondary-100', 'xb-secondary', 'xb-bg'];
    const families = colorFamilies(names.map((name) => ({ name })));
    expect(families.map((f) => [f.key, f.main.name, f.variants.length])).toEqual([['xb-primary', 'xb-primary', 3], ['xb-secondary', 'xb-secondary', 1], ['xb-bg', 'xb-bg', 0]]);
  });

  it('checks the site names and recipes like the server does', () => {
    expect(siteNameProblem('card-gap')).toBeNull();
    for (const bad of ['', 'Card', 'a--b', 'a-', '-a', 'a b', 'x'.repeat(41)]) expect(siteNameProblem(bad), bad).not.toBeNull();
    expect(recipeProblem('riquadro', 'padding: 1rem;\n&:hover { opacity: .9; }')).toBeNull();
    for (const bad of ['</style>', 'background: url(x)', '@import "x"', 'width: expression(1)', '-moz-binding: x', 'a {', '} b {', ' ']) expect(recipeProblem('r', bad), bad).not.toBeNull();
  });
});
