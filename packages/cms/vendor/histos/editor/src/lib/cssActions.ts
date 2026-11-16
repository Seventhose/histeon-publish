// CSS quick actions (docs/spec/styles.md §7): layout and spacing buttons that write
// declarations into the selected class, abbreviations typed in the CSS editor, named queries in completions.
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { statements } from '@xb/dsl';
import { t } from './i18n.ts';
import { variableSource, type NamedItem } from './completions.ts';
import { RECIPE_ALIASES } from './recipes.ts';

export interface CssAction {
  id: string;
  label: string;
  group: 'Layout' | 'Allinea' | 'Spazi';
  decls: Record<string, string>;
}

export const LAYOUT_ACTIONS: CssAction[] = [
  { id: 'row', label: t('Flex riga'), group: 'Layout', decls: { display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap' } },
  { id: 'col', label: t('Flex colonna'), group: 'Layout', decls: { display: 'flex', 'flex-direction': 'column' } },
  { id: 'grid2', label: t('Griglia 2'), group: 'Layout', decls: { display: 'grid', 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' } },
  { id: 'grid3', label: t('Griglia 3'), group: 'Layout', decls: { display: 'grid', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' } },
  { id: 'grid4', label: t('Griglia 4'), group: 'Layout', decls: { display: 'grid', 'grid-template-columns': 'repeat(4, minmax(0, 1fr))' } },
  { id: 'auto', label: t('Griglia automatica'), group: 'Layout', decls: { display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))' } },
  { id: 'center', label: t('Centra'), group: 'Allinea', decls: { display: 'grid', 'place-items': 'center' } },
  { id: 'between', label: t('Spazio tra'), group: 'Allinea', decls: { display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' } },
  { id: 'stack', label: t('Pila centrata'), group: 'Allinea', decls: { display: 'flex', 'flex-direction': 'column', 'align-items': 'center', 'text-align': 'center' } },
];

/** A spacing scale: the framework's own (`--space-m`…) when it has one, otherwise rem steps. */
export function spacingScale(variables: Array<{ name: string }>): Array<{ label: string; value: string }> {
  const order = ['3xs', '2xs', 'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl'];
  const space = variables.map((v) => v.name).filter((n) => /^space-[a-z0-9]+$/.test(n));
  if (space.length) {
    return space
      .map((n) => n.slice(6))
      .sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
      .map((step) => ({ label: step, value: `var(--space-${step})` }));
  }
  return [0.5, 1, 1.5, 2, 3, 4].map((r) => ({ label: `${r}rem`, value: `${r}rem` }));
}

/**
 * Sets top-level declarations in a rule body: an existing property gets the new value in place, a missing one is
 * appended; nested rules and everything else stay as written.
 */
export function applyDeclarations(css: string, decls: Record<string, string>): string {
  const pending = new Map(Object.entries(decls));
  const parts: string[] = [];
  for (const [prelude, block] of statements(css)) {
    if (block !== null) {
      parts.push(`${prelude} {${block}}`);
      continue;
    }
    const at = prelude.indexOf(':');
    const prop = at > 0 ? prelude.slice(0, at).trim().toLowerCase() : '';
    if (prop && pending.has(prop)) {
      parts.push(`${prop}: ${pending.get(prop)};`);
      pending.delete(prop);
    } else {
      parts.push(`${prelude.trim()};`);
    }
  }
  const declarations = parts.filter((p) => !p.includes('{'));
  const nested = parts.filter((p) => p.includes('{'));
  for (const [prop, value] of pending) declarations.push(`${prop}: ${value};`);
  return [...declarations, ...nested].join('\n') + '\n';
}

/** `24px` → `1.5rem` outside strings and url(); 0 and 1px (hairlines) stay. */
export function pxToRem(css: string, base = 16): string {
  return css.replace(/("[^"]*"|'[^']*'|url\([^)]*\))|(-?\d*\.?\d+)px\b/gi, (m, keep: string | undefined, n: string | undefined) => {
    if (keep || n === undefined) return m;
    const value = Number(n);
    if (value === 0 || Math.abs(value) === 1) return m;
    return `${Number((value / base).toFixed(4))}rem`;
  });
}

/** Abbreviations typed at the start of a declaration, expanded by the completion. */
export const ABBREVIATIONS: Record<string, string> = {
  df: 'display: flex;',
  dg: 'display: grid;',
  db: 'display: block;',
  dn: 'display: none;',
  dib: 'display: inline-block;',
  fdc: 'flex-direction: column;',
  fww: 'flex-wrap: wrap;',
  jcc: 'justify-content: center;',
  jcsb: 'justify-content: space-between;',
  aic: 'align-items: center;',
  pic: 'place-items: center;',
  gtc: 'grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));',
  posr: 'position: relative;',
  posa: 'position: absolute;',
  posst: 'position: sticky;',
  ins0: 'inset: 0;',
  w100: 'width: 100%;',
  mxa: 'margin-inline: auto;',
  tac: 'text-align: center;',
  oh: 'overflow: hidden;',
  ar169: 'aspect-ratio: 16 / 9;',
  ofc: 'object-fit: cover;',
};

export function abbreviationSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[a-z0-9]+$/);
    if (!word || word.from === word.to) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, word.from - line.from);
    // Only where a declaration starts: beginning of a line or after `{` / `;`.
    if (!/(^|[{;])\s*$/.test(before)) return null;
    const typed = word.text;
    const options = Object.entries(ABBREVIATIONS)
      .filter(([abbr]) => abbr.startsWith(typed))
      .map(([abbr, expansion]) => ({ label: abbr, detail: expansion, type: 'keyword', apply: expansion }));
    return options.length ? { from: word.from, options, validFor: /^[a-z0-9]*$/ } : null;
  };
}

/** After `@media (--` or `@container … (--`: the named queries. */
export function querySource(queries: () => Record<string, string>): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\(--[\w-]*/);
    if (!word) return null;
    const line = context.state.doc.lineAt(context.pos);
    if (!/@(media|container)\b/i.test(line.text.slice(0, word.from - line.from))) return null;
    return {
      from: word.from + 1,
      validFor: /^--[\w-]*$/,
      options: Object.entries(queries()).map(([name, query]) => ({ label: `--${name}`, detail: query, type: 'constant', apply: `--${name})` })),
    };
  };
}

/** The named query names a builder may use, checked like the server (plugin/src/Styles/NamedQueries.php). */
export function queryProblem(name: string, query: string): string | null {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return t('Nome non valido: "{0}" (minuscole, cifre e trattini).', name);
  const q = query.trim();
  let depth = 0;
  for (const c of q) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (depth < 0) break;
  }
  if (!q || q.length > 200 || !/^[a-zA-Z0-9\s().,:<>=/%+*-]+$/.test(q) || /url\s*\(|expression|\/\*|\*\//i.test(q) || depth !== 0) {
    return t('Condizione non valida per "{0}": per esempio (width < 64em).', name);
  }
  return null;
}

/**
 * Recipes (Histeon CSS's own and those imported from Automatic.css, docs/spec/histos-css.md §5): `@name` at the
 * start of a declaration expands to the recipe's CSS. `?name` works too, and so do the alternative names of a
 * recipe that Histeon has under its own name (lib/recipes.ts, RECIPE_ALIASES).
 */
export function recipeSource(recipes: () => Record<string, string>): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[@?][a-z0-9-]*$/);
    if (!word) return null;
    const line = context.state.doc.lineAt(context.pos);
    if (!/(^|[{;])\s*$/.test(line.text.slice(0, word.from - line.from))) return null;
    const all = recipes();
    const sigil = word.text[0] as string;
    // Only names that start with what was typed (no fuzzy match): `@media` never becomes a recipe by accident.
    const typed = word.text.slice(1);
    const own = Object.keys(all).filter((n) => n.startsWith(typed)).map((name) => ({ label: `${sigil}${name}`, name, detail: t('ricetta') }));
    const aliases = Object.entries(RECIPE_ALIASES)
      .filter(([alias, target]) => alias.startsWith(typed) && Object.hasOwn(all, target) && !Object.hasOwn(all, alias))
      .map(([alias, target]) => {
        const histos = `@${target}`;
        return { label: `${sigil}${alias}`, name: target, detail: t('ricetta {0}', histos) };
      });
    const options = [...own, ...aliases];
    if (!options.length) return null;
    return {
      from: word.from,
      filter: false,
      options: options.map((o) => ({ label: o.label, detail: o.detail, info: all[o.name], type: 'function', apply: all[o.name] ?? '' })),
    };
  };
}

/**
 * What every editor of a site's CSS suggests while typing (the CSS panel, the selectors' own CSS): the framework's
 * variables, the abbreviations, the named queries and the recipes. Properties and values come with the CSS language.
 */
export function cssCompletions(source: () => { framework: { variables: NamedItem[]; recipes?: Record<string, string> }; queries: Record<string, string> }): CompletionSource[] {
  return [variableSource(() => source().framework.variables), abbreviationSource(), querySource(() => source().queries), recipeSource(() => source().framework.recipes ?? {})];
}

