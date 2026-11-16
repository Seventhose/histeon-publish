// The CSS lint of @xb/dsl (cssLint) in the builder: its messages in the interface language, its context from the
// site (framework variables and tokens, variables of the global sheets and of the selectors, named media
// queries), and its findings for the Checks panel.
import { cssLint, definedVariables, type CssLintContext, type CssLintIssue } from '@xb/dsl';
import type { Finding } from './checks.ts';
import type { FrameworkData, GlobalSheet, StyleEntry } from './api.ts';
import { t } from './i18n.ts';

/** The message of an issue, translated (the package's own messages are the Italian ones). */
export function lintMessage(issue: CssLintIssue): string {
  const [a = '', b = ''] = issue.args;
  switch (issue.code) {
    case 'brace-open':
      return t('Graffa aperta e mai chiusa: la regola non si chiude');
    case 'brace-close':
      return t('Graffa chiusa senza una aperta');
    case 'unknown-query':
      return t('Media query con nome sconosciuta: {0}. Il browser la ignora', a);
    case 'unknown-variable':
      return t('Variabile sconosciuta: {0}. Non è nel framework, nei token né nei fogli del sito', a);
    case 'important':
      return t('!important: meglio un selettore più preciso');
    case 'empty-value':
      return t('Dichiarazione senza valore: {0}', a);
    case 'token-value':
      return t('{0} è il valore di {1}: usa var({1})', a, b);
    case 'not-bem':
      return t('Classe fuori dallo schema BEM (blocco__elemento--modificatore): {0}', a);
  }
}

/** What the lint knows of the site: every variable defined somewhere, and the named media queries. */
export function lintContext(framework: FrameworkData, globals: GlobalSheet[], styles: StyleEntry[], queries: Record<string, string>): CssLintContext {
  const own = [...globals.map((g) => g.css), ...styles.map((s) => s.css)].flatMap(definedVariables).map((name) => ({ name }));
  // The site names variables and media queries without the dashes (`space-m`, `tablet`); the lint reads them as
  // they are written in CSS (`var(--space-m)`, `@media (--tablet)`).
  const dashed = (name: string) => (name.startsWith('--') ? name : `--${name}`);
  const named = framework.variables.map((v) => ({ name: dashed(v.name), value: v.value }));
  return { variables: [...named, ...own], queries: Object.fromEntries(Object.entries(queries).map(([name, query]) => [dashed(name), query])) };
}

/**
 * Findings for the Checks panel: the selectors used in the page, each finding on the first element with the
 * class (a click shows it, and the CSS panel shows the selector).
 */
export function cssFindings(styles: StyleEntry[], context: CssLintContext, elementWith: (selector: string) => string | null): Finding[] {
  const out: Finding[] = [];
  for (const style of styles) {
    const uid = elementWith(style.selector);
    if (!uid) continue;
    for (const issue of cssLint(style.selector, style.css, context)) {
      out.push({ rule: `css-${issue.code}`, severity: issue.severity, area: 'CSS', message: `${style.selector}: ${lintMessage(issue)}`, uid });
    }
  }
  return out;
}
