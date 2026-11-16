import { describe, expect, it } from 'vitest';
import { cssLint, definedVariables } from '../src/index.ts';

const codes = (issues: ReturnType<typeof cssLint>) => issues.map((i) => `${i.code}:${i.args.join(',')}`);

describe('CSS lint', () => {
  const context = {
    variables: [
      { name: '--space-m', value: '1.5rem' },
      { name: '--primary', value: '#3F4BC4' },
      { name: '--xb-text', value: 'clamp(1rem, 2vw, 1.2rem)' },
    ],
    queries: { '--tablet': '(width < 64rem)' },
  };

  it('finds nothing in clean CSS', () => {
    const css = 'padding: var(--space-m);\n&__title { color: var(--primary); }\n@media (--tablet) { padding: 0; }\n--local: 2px;\nmargin: var(--local);';
    expect(cssLint('.card', css, context)).toEqual([]);
  });

  it('reports unbalanced braces where they are', () => {
    const css = 'color: red;\n&:hover { color: blue;';
    const [issue] = cssLint('.card', css, context);
    expect(issue).toMatchObject({ code: 'brace-open', severity: 'error', from: css.indexOf('{') });
    expect(codes(cssLint('.card', 'color: red; }', context))).toEqual(['brace-close:']);
  });

  it('warns about unknown named queries and variables, at their place in the text', () => {
    const css = '@media (--telefono) { color: var(--nope); }';
    const issues = cssLint('.card', css, context);
    expect(codes(issues)).toEqual(['unknown-query:--telefono', 'unknown-variable:--nope']);
    expect(css.slice(issues[0]!.from, issues[0]!.to)).toBe('--telefono');
    expect(css.slice(issues[1]!.from, issues[1]!.to)).toBe('--nope');
  });

  it('does not judge variables without a list of them, nor WordPress presets', () => {
    expect(cssLint('.card', 'color: var(--anything);', {})).toEqual([]);
    expect(cssLint('.card', 'color: var(--wp--preset--color--black);', context)).toEqual([]);
  });

  it('flags !important, empty values and fixed values that a token has', () => {
    const css = 'gap: 1.5rem; color: #3f4bc4 !important; margin:;';
    const issues = cssLint('.card', css, context);
    expect(codes(issues)).toEqual(['token-value:1.5rem,--space-m', 'token-value:#3f4bc4,--primary', 'important:', 'empty-value:margin']);
    expect(issues[0]!.message).toBe('1.5rem è il valore di --space-m: usa var(--space-m)');
    expect(issues.find((i) => i.code === 'important')!.severity).toBe('warning');
  });

  it('notes class names outside BEM, in the selector and in nested rules', () => {
    expect(codes(cssLint('.Card', 'color: red;', context))).toEqual(['not-bem:Card']);
    expect(codes(cssLint('.card', '.cardTitle { color: red; } &__a__b { color: red; }', context))).toEqual(['not-bem:cardTitle', 'not-bem:card__a__b']);
    expect(cssLint('.card__title--big', '&:hover { color: red; }', context)).toEqual([]);
  });

  it('ignores comments and strings', () => {
    expect(cssLint('.card', '/* { var(--nope) */ content: "}{ var(--nope)";', context)).toEqual([]);
  });

  it('lists the custom properties a sheet defines', () => {
    expect(definedVariables(':root { --a: 1px; --b-c:2px } .x { color: var(--d); }').sort()).toEqual(['--a', '--b-c']);
  });
});
