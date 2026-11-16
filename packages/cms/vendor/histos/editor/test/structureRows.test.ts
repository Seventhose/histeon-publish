import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, type XbBlock } from '@xb/dsl';
import { indexTree, pathIn, scopeFor } from '../src/lib/tree.ts';
import { openByDefault, rowWindow, visibleRows } from '../src/lib/structureRows.ts';

const tree = (dsl: string): XbBlock[] => parse(dsl, { uid: sequentialUids('n') }).blocks;
const label = (b: XbBlock): string => (b.name === 'xb/element' ? b.attrs.tag : b.name.slice(3));

describe('structure rows', () => {
  const doc = tree('<section class="card"><h2>Titolo</h2><div><p>Uno</p><ul><li>a</li></ul></div></section><footer></footer>');

  it('lists the open rows in order, with level, place among siblings and parent', () => {
    const rows = visibleRows(doc, openByDefault);
    // The first two levels are open; a heading with only text stays closed (its text is on the row).
    expect(rows.map((r) => `${'-'.repeat(r.depth)}${label(r.block)}`)).toEqual(['section', '-h2', '-div', '--p', '--ul', 'footer']);
    const ul = rows[4]!;
    expect([ul.position, ul.siblings, rows[ul.parent]?.block.name === 'xb/element' && rows[ul.parent]?.block.attrs.tag]).toEqual([2, 2, 'div']);
    expect(rows[1]).toMatchObject({ expandable: true, expanded: false, base: 'card' });
    expect(rows[5]).toMatchObject({ expandable: false, expanded: false, parent: -1 });
  });

  it('follows what was opened and closed by hand', () => {
    const div = visibleRows(doc, openByDefault)[2]!.block.attrs.uid;
    const h2 = visibleRows(doc, openByDefault)[1]!.block.attrs.uid;
    const hand = new Map([
      [div, false],
      [h2, true],
    ]);
    const rows = visibleRows(doc, (b, d) => hand.get(b.attrs.uid) ?? openByDefault(b, d));
    expect(rows.map((r) => label(r.block))).toEqual(['section', 'h2', 'text', 'div', 'footer']);
  });

  it('keeps keys unique when a broken document repeats a uid', () => {
    const [a] = tree('<p>x</p>');
    const rows = visibleRows([a!, a!], () => false);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('draws every row of a normal page, and only the ones in view of a large one', () => {
    expect(rowWindow(120, 5000, 600, 26)).toEqual([0, 120]);
    const [first, last] = rowWindow(6000, 26 * 1000, 26 * 30, 26);
    expect(first).toBe(980);
    expect(last).toBe(980 + 30 + 40);
    expect(rowWindow(6000, 0, 0, 26)[1]).toBeLessThan(200);
  });
});

describe('tree index', () => {
  const doc = tree('<main><section><p>Uno</p></section></main><aside></aside>');
  const index = indexTree(doc);
  const p = [...index.block.values()].find((b) => b.name === 'xb/element' && b.attrs.tag === 'p')!;

  it('finds blocks and their ancestors without walking the page', () => {
    expect(pathIn(index, p.attrs.uid).map((uid) => label(index.block.get(uid)!))).toEqual(['main', 'section', 'p']);
    expect(pathIn(index, 'nope')).toEqual([]);
  });

  it('scopes a text to its element, from the tree or from an index', () => {
    const text = (p as { children: XbBlock[] }).children[0]!;
    expect(scopeFor(doc, text.attrs.uid)).toBe(p.attrs.uid);
    expect(scopeFor(index, text.attrs.uid)).toBe(p.attrs.uid);
  });

  it('keeps a paragraph with inline formatting closed: its words are on the row (E4)', () => {
    const doc = tree('<section><p>Il <strong class="b">giusto</strong><br class="r"/>legge</p></section>');
    expect(visibleRows(doc, openByDefault).map((r) => label(r.block))).toEqual(['section', 'p']);
  });
});
