import { describe, expect, it } from 'vitest';
import { parse, parseXb, print, reconcileUids, roundTrips, serializeXb } from '@xb/dsl';

// The HTML tab in Gutenberg: block markup → code → edited code → block markup, keeping uids.
describe('HTML tab round trip', () => {
  const markup = serializeXb(parse('<a class="vl-cir__a" href="/grandi-eventi/"><span class="vl-cir__t">Grandi eventi</span></a>').blocks);

  it('prints the block and reads an edit back with the same uids', () => {
    const { blocks } = parseXb(markup);
    expect(roundTrips(blocks)).toBe(true);
    const text = print(blocks);
    const edited = parse(text.replace('Grandi eventi', 'Eventi grandi').replace('href="/grandi-eventi/"', 'href="/eventi/"')).blocks;
    const next = reconcileUids(blocks, edited);
    expect(next[0]?.attrs.uid).toBe(blocks[0]?.attrs.uid);
    const back = serializeXb(next);
    expect(back).toContain('Eventi grandi');
    expect(back).toContain('/eventi/');
    expect(parseXb(back).blocks[0]?.attrs.uid).toBe(blocks[0]?.attrs.uid);
  });
});
