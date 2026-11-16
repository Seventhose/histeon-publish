import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describePlan, filterSelectors, usageLabel, validClassName } from '../src/lib/selectors.ts';
import type { RenamePlan, SelectorUsage } from '../src/lib/api.ts';

function row(selector: string, extra: Partial<SelectorUsage> = {}): SelectorUsage {
  return { id: selector.replace(/\W/g, ''), selector, rename: null, bytes: 10, docs: [], locked: 0, theme: [], always: false, safelisted: false, unused: false, ...extra };
}

const doc = (n: number) => ({ doc: `post:${n}`, post: n, label: `Pagina ${n}` });

describe('selector manager', () => {
  const rows = [
    row('.card', { docs: [doc(1), doc(2)], bytes: 5 }),
    row('.Badge', { unused: true, bytes: 50 }),
    row('.card__title', { docs: [doc(1)], theme: ['Header'], bytes: 20 }),
  ];

  it('searches by name, case-insensitively', () => {
    expect(filterSelectors(rows, 'CARD', 'name').map((r) => r.selector)).toEqual(['.card', '.card__title']);
    expect(filterSelectors(rows, '  ', 'name')).toHaveLength(3);
  });

  it('sorts by name, usage or size and filters unused', () => {
    expect(filterSelectors(rows, '', 'name').map((r) => r.selector)).toEqual(['.Badge', '.card', '.card__title']);
    expect(filterSelectors(rows, '', 'usage').map((r) => r.selector)).toEqual(['.Badge', '.card', '.card__title']);
    expect(filterSelectors(rows, '', 'size').map((r) => r.selector)).toEqual(['.Badge', '.card__title', '.card']);
    expect(filterSelectors(rows, '', 'name', true).map((r) => r.selector)).toEqual(['.Badge']);
  });

  it('labels usage', () => {
    expect(usageLabel(rows[0] as SelectorUsage)).toBe('2 usi');
    expect(usageLabel(row('.x', { locked: 1 }))).toBe('1 uso');
    expect(usageLabel(row('.x', { unused: true }))).toBe('non usato');
    expect(usageLabel(row('h1', { always: true }))).toBe('sempre');
    expect(usageLabel(row('.is-open', { safelisted: true }))).toBe('safelist');
  });

  it('validates class names like the server', () => {
    expect(validClassName('card__title--big')).toBe(true);
    expect(validClassName('-x')).toBe(true);
    expect(validClassName('1card')).toBe(false);
    expect(validClassName('a b')).toBe(false);
    expect(validClassName('a:hover')).toBe(false);
    expect(validClassName('a'.repeat(101))).toBe(false);
  });

  it('adds classes from the CSS and recipes panels only when the server would take them', () => {
    for (const panel of ['CssPanel', 'RecipesPanel']) {
      const source = readFileSync(new URL(`../src/components/${panel}.svelte`, import.meta.url), 'utf8');
      const addClass = source.slice(source.indexOf('function addClass'), source.indexOf('app.setTree', source.indexOf('function addClass')));
      expect(addClass, panel).toContain('validClassName(name)');
    }
  });

  it('describes a rename plan, blockers included', () => {
    const plan: RenamePlan = {
      from: 'card', to: 'tile', styles: 2, docs: [{ doc: 'post:1', label: 'Home', classes: 3 }], manual: [{ doc: 'post:2', label: 'Raw' }],
      locked: 1, theme: ['Header'], blocked: [], conflicts: ['tile'], ok: false,
    };
    expect(describePlan(plan)).toEqual([
      'Stili: 2 selettori riscritti',
      'Home: 3 classi',
      'Raw: usata in HTML libero, da rinominare a mano',
      'Bloccata: usata in 1 documento che non puoi modificare',
      'Bloccata: usata nel tema (Header)',
      'Bloccata: nome già in uso (tile)',
    ]);
    expect(describePlan({ ...plan, styles: 0, docs: [], manual: [], locked: 0, theme: [], conflicts: [] })).toEqual(['Nessuno stile o documento usa questa classe.']);
  });
});
