import { describe, expect, it } from 'vitest';
import { parse, parseXb, sequentialUids, serializeAttributes, serializeXb } from '../src/index.ts';

describe('block grammar', () => {
  it('escapes attributes exactly like core', () => {
    expect(serializeAttributes({ a: '<b> & "c" -- d' })).toBe('{"a":"\\u003cb\\u003e \\u0026 \\u0022c\\u0022 \\u002d\\u002d d"}');
  });

  it('serializes leaf blocks as void comments and omits empty maps', () => {
    expect(
      serializeXb([{ name: 'xb/element', attrs: { uid: 'aaaaaaaa', tag: 'hr', attributes: {} }, children: [] }]),
    ).toBe('<!-- wp:xb/element {"uid":"aaaaaaaa","tag":"hr"} /-->');
  });

  it('repairs content edited outside XB', () => {
    const doc =
      '<!-- wp:xb/element {"uid":"aaaaaaaa","tag":"div"} -->' +
      '<!-- wp:paragraph --><p>inserito dal cliente</p><!-- /wp:paragraph -->' +
      '<!-- wp:xb/text {"uid":"aaaaaaaa","content":"uid duplicato"} /-->' +
      '<!-- /wp:xb/element -->' +
      '<p>HTML libero</p>';
    const { blocks, issues } = parseXb(doc, sequentialUids('z'));
    expect(blocks.map((b) => b.name)).toEqual(['xb/element', 'xb/raw']);
    const div = blocks[0];
    expect(div && 'children' in div ? div.children.map((c) => c.name) : []).toEqual(['xb/passthrough', 'xb/text']);
    expect(issues).toHaveLength(4);
  });
});

describe('serializeXb on frozen trees', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      for (const v of Object.values(value)) deepFreeze(v);
      Object.freeze(value);
    }
    return value;
  };

  it('serializes a block that cannot change only once, and gives the same markup as an unfrozen copy', () => {
    const blocks = parse('<section class="a"><h2>Titolo</h2><p>Testo {x}</p></section>').blocks;
    const plain = serializeXb(structuredClone(blocks));
    let reads = 0;
    const [section] = blocks;
    const attrs = section!.attrs as Record<string, unknown>;
    const tag = attrs.tag;
    Object.defineProperty(attrs, 'tag', { get: () => (reads++, tag), enumerable: true });
    deepFreeze(blocks);
    expect(serializeXb(blocks)).toBe(plain);
    const first = reads;
    expect(first).toBeGreaterThan(0);
    expect(serializeXb(blocks)).toBe(plain);
    expect(reads).toBe(first);
  });

  it('serializes again what can still change', () => {
    const blocks = parse('<p>uno</p>').blocks;
    const before = serializeXb(blocks);
    const [p] = blocks as Array<{ attrs: { tag: string } }>;
    p!.attrs.tag = 'h3';
    expect(serializeXb(blocks)).not.toBe(before);
    expect(serializeXb(blocks)).toContain('"tag":"h3"');
  });

  it('shares the markup of untouched siblings after an edit that copies only the changed branch', () => {
    const blocks = deepFreeze(parse('<div><p>a</p><p>b</p></div>').blocks);
    serializeXb(blocks);
    const [div] = blocks as Array<{ name: string; attrs: object; children: Array<{ attrs: object; children: Array<{ attrs: { content: string } }> }> }>;
    const [first, second] = div!.children;
    const changed = { ...second!, children: [{ ...second!.children[0]!, attrs: { ...second!.children[0]!.attrs, content: 'c' } }] };
    const next = deepFreeze([{ ...div!, children: [first!, changed] }]) as unknown as typeof blocks;
    expect(serializeXb(next)).toContain('"content":"a"');
    expect(serializeXb(next)).toContain('"content":"c"');
    expect(serializeXb(next)).not.toContain('"content":"b"');
  });
});

describe('grouped query loops in the block grammar (doc 23 of Publish, item 187)', () => {
  const loop = (source: unknown) => `<!-- wp:xb/loop {"uid":"aaaaaaaa","source":${JSON.stringify(source)},"as":"g"} /-->`;

  it('keeps groupBy through serialize and parse', () => {
    const blocks = parse('{#loop foto(limit: 20).groupBy("publishedAt", "Y") as gruppo}<h2>{gruppo.key}</h2>{/loop}', { uid: sequentialUids() }).blocks;
    const stored = serializeXb(blocks);
    expect(stored).toContain('"source":{"kind":"preset","id":"foto","args":{"limit":"20"},"groupBy":{"field":"publishedAt","how":"Y"}}');
    const back = parseXb(stored);
    expect(back.issues).toEqual([]);
    expect(back.blocks).toEqual(blocks);
    expect(serializeXb(back.blocks)).toBe(stored);
    const plain = parseXb(loop({ kind: 'preset', id: 'foto', groupBy: { field: 'title', how: 'letter' } }));
    expect(plain.issues).toEqual([]);
    expect(plain.blocks[0]?.attrs).toMatchObject({ source: { kind: 'preset', id: 'foto', groupBy: { field: 'title', how: 'letter' } } });
    expect(serializeXb(plain.blocks)).toBe(loop({ kind: 'preset', id: 'foto', groupBy: { field: 'title', how: 'letter' } }));
  });

  it.each([
    ['a field that is not text', { field: 3 }],
    ['a field with spaces', { field: 'a b' }],
    ['an empty field', { field: '' }],
    ['a mode that is not text', { field: 'a', how: true }],
    ['an empty mode', { field: 'a', how: '' }],
    ['a control character', { field: 'a', how: 'Y\n' }],
    ['another key', { field: 'a', order: 'desc' }],
    ['a list', ['a']],
  ])('replaces a source with %s', (_name, groupBy) => {
    const parsed = parseXb(loop({ kind: 'preset', id: 'foto', groupBy }));
    expect(parsed.issues).toEqual([expect.stringContaining('raggruppamento della query non valido')]);
    expect(parsed.blocks[0]?.attrs).toMatchObject({ source: { kind: 'expr', expr: '[]' } });
  });
});
