import { describe, expect, it } from 'vitest';
import { applyDeclarations, pxToRem, queryProblem, spacingScale } from '../src/lib/cssActions.ts';

describe('css quick actions', () => {
  it('sets declarations in place and appends the missing ones, keeping nested rules', () => {
    const css = 'display: block;\ncolor: red;\n&:hover { color: blue; }\n@media (--tablet) { display: none; }';
    const out = applyDeclarations(css, { display: 'grid', gap: 'var(--space-m)' });
    expect(out).toBe('display: grid;\ncolor: red;\ngap: var(--space-m);\n&:hover { color: blue; }\n@media (--tablet) { display: none; }\n');
    expect(applyDeclarations('', { display: 'flex' })).toBe('display: flex;\n');
  });

  it('converts px to rem outside strings and urls, keeping hairlines', () => {
    expect(pxToRem('padding: 24px 8px; border: 1px solid; margin: 0px; content: "12px"; background: url(a-16px.png); top: -32px;')).toBe(
      'padding: 1.5rem 0.5rem; border: 1px solid; margin: 0px; content: "12px"; background: url(a-16px.png); top: -2rem;',
    );
  });

  it('uses the framework spacing scale when there is one', () => {
    expect(spacingScale([{ name: 'space-l' }, { name: 'space-s' }, { name: 'space-m' }, { name: 'primary' }]).map((s) => s.label)).toEqual(['s', 'm', 'l']);
    expect(spacingScale([])[0]?.value).toBe('0.5rem');
  });

  it('checks named queries like the server', () => {
    expect(queryProblem('tablet', '(width < 64em)')).toBeNull();
    expect(queryProblem('Tablet', '(width < 64em)')).toMatch(/Nome/);
    expect(queryProblem('x', '(width < 64em)) { body { display:none')).toMatch(/Condizione/);
    expect(queryProblem('x', 'url(evil)')).toMatch(/Condizione/);
    expect(queryProblem('x', '(width < 64em')).toMatch(/Condizione/);
  });
});
