import { describe, expect, it } from 'vitest';
import { parse, reconcileUids, sequentialUids, type XbBlock } from '../src/index.ts';

const uids = (blocks: XbBlock[]): string[] =>
  blocks.flatMap((b) => [b.attrs.uid, ...('children' in b ? uids(b.children) : [])]);

const parseWith = (src: string, prefix: string) => parse(src, { uid: sequentialUids(prefix) }).blocks;

describe('reconcileUids', () => {
  const before = parseWith('<section class="a"><h1>Titolo</h1><p>Testo</p></section><footer></footer>', 'o');

  it('keeps every uid when only text changes', () => {
    const after = reconcileUids(before, parseWith('<section class="b"><h1>Altro</h1><p>Testo nuovo</p></section><footer></footer>', 'n'));
    expect(uids(after)).toEqual(uids(before));
  });

  it('keeps siblings stable around an insertion', () => {
    const after = reconcileUids(before, parseWith('<section class="a"><h1>Titolo</h1><img src="x"><p>Testo</p></section><footer></footer>', 'n'));
    const kept = uids(after).filter((u) => u.startsWith('o'));
    const fresh = uids(after).filter((u) => u.startsWith('n'));
    expect(kept).toHaveLength(uids(before).length);
    expect(fresh).toHaveLength(1);
  });

  it('gives a new identity to a node whose tag changed', () => {
    const after = reconcileUids(before, parseWith('<section class="a"><h2>Titolo</h2><p>Testo</p></section><footer></footer>', 'n'));
    const section = after[0];
    const heading = section && 'children' in section ? section.children[0] : undefined;
    expect(heading?.attrs.uid.startsWith('n')).toBe(true);
    expect(section?.attrs.uid.startsWith('o')).toBe(true);
  });

  it('never produces duplicate uids', () => {
    const after = reconcileUids(before, parseWith('<footer></footer><section class="a"><p>x</p><p>y</p></section><footer></footer>', 'n'));
    const all = uids(after);
    expect(new Set(all).size).toBe(all.length);
  });
});
