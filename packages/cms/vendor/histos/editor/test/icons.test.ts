import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { iconMarkup, searchIcons, type IconLibrary } from '../src/lib/icons.ts';

const library = JSON.parse(readFileSync(new URL('../../plugin/assets/icons/lucide.json', import.meta.url), 'utf8')) as IconLibrary;

describe('icon library (E10)', () => {
  it('ships Lucide with its licence, drawing elements only', () => {
    expect(library.license).toBe('ISC');
    expect(Object.keys(library.icons).length).toBeGreaterThan(1500);
    const tags = new Set(Object.values(library.icons).flatMap((nodes) => nodes.map(([tag]) => tag)));
    expect([...tags].sort()).toEqual(['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect']);
  });

  it('finds by name: exact first, then the start, then anywhere; words in any order', () => {
    const found = searchIcons(Object.keys(library.icons), 'house');
    expect(found[0]).toBe('house');
    expect(found.slice(0, 5).every((n) => n.startsWith('house'))).toBe(true);
    expect(searchIcons(Object.keys(library.icons), 'arrow right')).toContain('arrow-right');
    expect(searchIcons(Object.keys(library.icons), 'right arrow')).toContain('arrow-right');
    expect(searchIcons(Object.keys(library.icons), '')).toHaveLength(0);
  });

  it('inserts an inline SVG that takes the text colour, hidden from screen readers', () => {
    const markup = iconMarkup('house', library.icons.house!);
    expect(markup).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="icon icon--house" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="/);
    expect(markup).toContain('<path d="M15 21v-8');
    // Values are geometry only: nothing else can come in through a crafted file.
    expect(() => iconMarkup('x', [['path', { d: '"/><script>' }]])).toThrow();
  });
});
