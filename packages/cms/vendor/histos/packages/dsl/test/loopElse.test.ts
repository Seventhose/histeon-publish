import { describe, expect, it } from 'vitest';
import { loopElse, parse, print, sequentialUids, serializeXb, parseXb, roundTrips, type LoopBlock } from '../src/index.ts';

const loop = (dsl: string) => parse(dsl, { uid: sequentialUids('u') }).blocks[0] as LoopBlock;

describe('{:else} in a loop (D1)', () => {
  it('reads as a last branch without a test, and prints back the same', () => {
    const src = '{#loop data.eventi as e}<p>{e.title}</p>{:else}<p>Nessun evento in programma</p>{/loop}';
    const block = loop(src);
    expect(block.children.map((c) => c.name)).toEqual(['xb/element', 'xb/branch']);
    expect(loopElse(block)?.attrs.test).toBeUndefined();
    const printed = print([block]);
    expect(printed).toBe('{#loop data.eventi as e}\n  <p>{e.title}</p>\n{:else}\n  <p>Nessun evento in programma</p>\n{/loop}');
    expect(print(parse(printed).blocks)).toBe(printed);
    expect(roundTrips([block])).toBe(true);
  });

  it('works with a preset call and an index, and without {:else} nothing changes', () => {
    const src = '{#loop posts(limit: 3) as p, i}<li>{i}: {p.title}</li>{:else}Ancora niente{/loop}';
    const printed = print([loop(src)]);
    expect(printed).toContain('{:else}Ancora niente{/loop}');
    expect(print(parse(printed).blocks)).toBe(printed);
    const plain = loop('{#loop data.x as x}<p>{x}</p>{/loop}');
    expect(loopElse(plain)).toBeNull();
    expect(plain.children).toHaveLength(1);
  });

  it('refuses other branches and a second {:else}', () => {
    expect(() => parse('{#loop data.x as x}a{:else if x}b{/loop}')).toThrow(/solo \{:else\}/);
    expect(() => parse('{#loop data.x as x}a{:else}b{:else}c{/loop}')).toThrow(/un solo \{:else\}/);
  });

  it('survives the WordPress serialization', () => {
    const block = loop('{#loop data.x as x}<p>{x}</p>{:else}<p>vuoto</p>{/loop}');
    const back = parseXb(serializeXb([block]));
    expect(back.issues).toEqual([]);
    expect(print(back.blocks)).toBe(print([block]));
  });
});

describe('{:else} stored by WordPress', () => {
  it('drops a branch that is not a last {:else}', () => {
    const stored =
      '<!-- wp:xb/loop {"uid":"loopa001","source":{"kind":"expr","expr":"data.x"},"as":"x"} -->' +
      '<!-- wp:xb/branch {"uid":"bran0001","test":"x"} --><!-- wp:xb/text {"uid":"text0001","content":"a"} /--><!-- /wp:xb/branch -->' +
      '<!-- wp:xb/text {"uid":"text0002","content":"b"} /-->' +
      '<!-- /wp:xb/loop -->';
    const { blocks, issues } = parseXb(stored);
    expect(issues.join(' ')).toContain("bran0001");
    expect((blocks[0] as LoopBlock).children.map((c) => c.name)).toEqual(['xb/text']);
  });
});
