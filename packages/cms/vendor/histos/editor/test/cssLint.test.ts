import { describe, expect, it } from 'vitest';
import { cssFindings, lintContext } from '../src/lib/cssLint.ts';

describe('CSS lint in the builder', () => {
  const framework = { active: { id: 'xb-tokens', label: 'Histeon CSS' }, variables: [{ name: '--xb-space-m', group: 'xb', value: '1rem' }], classes: [] };

  it('knows the variables of the framework, of the global sheets and of the selectors', () => {
    const context = lintContext(framework, [{ id: 'global', css: ':root { --brand: red; }' }], [{ id: 'a', selector: '.a', css: '--local: 1px;' }], { '--tablet': '(width < 60rem)' });
    const findings = cssFindings([{ id: 'b', selector: '.b', css: 'color: var(--brand); margin: var(--local); padding: var(--xb-space-m); gap: var(--nope);' }], context, () => 'u1');
    expect(findings).toEqual([{ rule: 'css-unknown-variable', severity: 'warning', area: 'CSS', message: '.b: Variabile sconosciuta: --nope. Non è nel framework, nei token né nei fogli del sito', uid: 'u1' }]);
  });

  it('checks only the selectors the page uses', () => {
    const context = lintContext(framework, [], [], {});
    const styles = [
      { id: 'a', selector: '.usata', css: 'color: red !important;' },
      { id: 'b', selector: '.altrove', css: 'color: red !important;' },
    ];
    const findings = cssFindings(styles, context, (selector) => (selector === '.usata' ? 'u9' : null));
    expect(findings.map((f) => [f.rule, f.uid])).toEqual([['css-important', 'u9']]);
  });
});
