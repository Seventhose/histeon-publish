import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childrenOf, nodeAt, parse, print, printWithMap, reuid, sequentialUids, type XbBlock } from '../src/index.ts';

const all = (blocks: XbBlock[]): XbBlock[] => blocks.flatMap((b) => [b, ...all(childrenOf(b))]);

describe('printWithMap', () => {
  const dir = join(import.meta.dirname, 'fixtures');
  it.each(readdirSync(dir).filter((f) => f.endsWith('.xb')))('%s: same text as print(), a range for every node', (file) => {
    const { blocks } = parse(readFileSync(join(dir, file), 'utf8'), { uid: sequentialUids() });
    const { text, map } = printWithMap(blocks);
    expect(text).toBe(print(blocks));
    for (const block of all(blocks)) {
      const range = map.get(block.attrs.uid);
      expect(range, block.name).toBeDefined();
      // Every range re-parses to the same kind of node (or is plain text / a passthrough chunk).
      if (range && block.name === 'xb/element') expect(text.slice(range[0], range[1]).startsWith(`<${block.attrs.tag}`)).toBe(true);
    }
  });

  it('finds the innermost node at a cursor position', () => {
    const { blocks } = parse('<section><h1 class="t">Ciao</h1></section>', { uid: sequentialUids() });
    const { text, map } = printWithMap(blocks);
    const heading = (blocks[0] as { children: XbBlock[] }).children[0] as XbBlock;
    expect(nodeAt(map, text.indexOf('class="t"'))).toBe(heading.attrs.uid);
  });
});

it('reuid gives fresh identities to a copy', () => {
  const { blocks } = parse('<div><p>x</p></div>', { uid: sequentialUids('a') });
  const copy = reuid(blocks, sequentialUids('b'));
  expect(all(copy).every((b) => b.attrs.uid.startsWith('b'))).toBe(true);
  expect(print(copy)).toBe(print(blocks));
});
