import { describe, expect, it, vi } from 'vitest';
import { compileCss, parse } from '@xb/dsl';
import { groupInOrder, INSERT_GROUPS, INTERACTIONS, prepareSnippet, SNIPPETS } from '../src/lib/snippets.ts';

describe('interactions without code', () => {
  it('are valid Histeon HTML with unique ids, and their CSS compiles', () => {
    for (const s of INTERACTIONS) {
      const a = prepareSnippet(s, 'aaa111');
      const b = prepareSnippet(s, 'bbb222');
      expect(() => parse(a.dsl), s.label).not.toThrow();
      expect(a.dsl).not.toContain('__ID__');
      const ids = [...a.dsl.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, `${s.label}: ids unique`).toBe(ids.length);
      for (const id of ids) expect(b.dsl).not.toContain(`id="${id}"`);
      for (const [selector, css] of a.styles) expect(compileCss(selector, css), `${s.label} ${selector}`).toContain(selector);
    }
  });

  it('follow the ARIA patterns', () => {
    const tabs = prepareSnippet(INTERACTIONS.find((s) => s.label === 'Schede')!, 'x').dsl;
    expect(tabs).toContain('role="tablist"');
    expect(tabs.match(/role="tab"/g)).toHaveLength(2);
    expect(tabs).toContain('aria-controls="panel-x-1"');
    const menu = prepareSnippet(INTERACTIONS.find((s) => s.label === 'Menu mobile')!, 'x').dsl;
    expect(menu).toContain('aria-expanded="false"');
    expect(menu).toContain('aria-controls="menu-x"');
    const accordion = prepareSnippet(INTERACTIONS.find((s) => s.label === 'Fisarmonica')!, 'x').dsl;
    expect(accordion).toContain('<details class="accordion__item" name="accordion-x" open>');
  });

  it('have their group in the + menu, and the arrows follow what it shows', () => {
    expect(INTERACTIONS.every((s) => s.group === 'Interazioni')).toBe(true);
    const items = [...SNIPPETS, ...INTERACTIONS].map((s) => ({ id: s.key, group: s.group ?? 'Elementi' })).concat([{ id: 'media', group: 'Media' as const }]);
    const { groups, visible } = groupInOrder(items);
    expect(groups.map((g) => g.name)).toEqual(['Elementi', 'Interazioni', 'Media']);
    expect(groups.find((g) => g.name === 'Interazioni')?.items).toHaveLength(INTERACTIONS.length);
    // Every item has its place on screen, in the order drawn: elements, then interactions, then media.
    expect(visible).toHaveLength(items.length);
    expect(visible.map((i) => i.group)).toEqual([...visible.map((i) => i.group)].sort((a, b) => INSERT_GROUPS.indexOf(a) - INSERT_GROUPS.indexOf(b)));
  });

  it('name their landmarks in the editor language', async () => {
    vi.resetModules();
    const i18n = await import('../src/lib/i18n.ts');
    i18n.setCatalog({ Principale: 'Main', Lingua: 'Language' });
    try {
      const fresh = await import('../src/lib/snippets.ts');
      const dsl = (key: string) => fresh.INTERACTIONS.find((s) => s.key === key)!.dsl;
      expect(dsl('Menu mobile')).toContain('aria-label="Main"');
      expect(dsl('Selettore di lingua')).toContain('aria-label="Language"');
    } finally {
      i18n.setCatalog({});
    }
  });
});
