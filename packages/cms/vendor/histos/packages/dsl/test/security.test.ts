import { describe, expect, it } from 'vitest';
import {
  MAX_NESTING,
  parse,
  parseXb,
  print,
  roundTrips,
  sequentialUids,
  serializeXb,
  stripUids,
  XbSyntaxError,
  type XbBlock,
} from '../src/index.ts';

const text = (content: string, verbatim = false): XbBlock =>
  verbatim ? { name: 'xb/text', attrs: { uid: 'aaaaaaab', content, verbatim: true } } : { name: 'xb/text', attrs: { uid: 'aaaaaaab', content } };
const p = (...children: XbBlock[]): XbBlock => ({ name: 'xb/element', attrs: { uid: 'aaaaaaaa', tag: 'p' }, children });

/** Elements and blocks that appear after printing and parsing again. */
function structure(blocks: XbBlock[]): string[] {
  const out: string[] = [];
  const walk = (list: XbBlock[]) => {
    for (const b of list) {
      if (b.name === 'xb/element') out.push(b.attrs.tag + JSON.stringify(b.attrs.attributes ?? {}));
      else if (b.name !== 'xb/text') out.push(b.name);
      if ('children' in b) walk(b.children as XbBlock[]);
    }
  };
  walk(blocks);
  return out;
}

const reparse = (blocks: XbBlock[]) => parse(print(blocks)).blocks;

describe('printing never turns stored text into structure', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '</p><script>alert(1)</script><p>',
    '{#raw}<script>alert(1)</script>{/raw}',
    '{@content}',
    '{/if}{#if true}<b>x</b>',
    '<!-- wp:html --><script>alert(1)</script><!-- /wp:html -->',
    '{ unbalanced',
    'trailing backslash \\',
    '<strong onclick="alert(1)">x</strong>',
    '<a href="x" onmouseover="alert(1)">x</a>',
  ];

  for (const content of hostile) {
    it(JSON.stringify(content), () => {
      const tree = [p(text(content))];
      expect(structure(reparse(tree))).toEqual(['p{}']);
      expect(roundTrips(tree)).toBe(true);
    });
  }

  it('keeps legitimate inline formatting and interpolations', () => {
    const tree = [p(text('Ciao <strong>{post.title}</strong> e <a href="/x">link</a> \\{letterale\\}'))];
    expect(print(tree)).toBe('<p>Ciao <strong>{post.title}</strong> e <a href="/x">link</a> \\{letterale\\}</p>');
    expect(roundTrips(tree)).toBe(true);
  });

  it('neutralizes a closing tag inside script, style and textarea', () => {
    for (const tag of ['script', 'style', 'textarea']) {
      const tree: XbBlock[] = [{ name: 'xb/element', attrs: { uid: 'aaaaaaaa', tag }, children: [text(`x</${tag.toUpperCase()}><img src=x onerror=alert(1)>`, true)] }];
      expect(structure(reparse(tree))).toEqual([`${tag}{}`]);
      expect(roundTrips(tree)).toBe(true);
    }
  });

  it('never hangs on `<!` and never joins adjacent texts into a tag', () => {
    expect(roundTrips([text('x<'), text('!y')])).toBe(true);
    expect(roundTrips([text('x<'), text('b>y</b>')])).toBe(true);
    expect(structure(parse('<p><!DOCTYPE html> a <![CDATA[x]]></p>').blocks)).toEqual(['p{}']);
  });

  it('keeps {#raw} content inside its block', () => {
    const tree: XbBlock[] = [{ name: 'xb/raw', attrs: { uid: 'aaaaaaaa', content: 'a{/raw}<script>alert(1)</script>' } }];
    expect(structure(reparse(tree))).toEqual(['xb/raw']);
  });

  it('flags trees whose printed form reads back differently', () => {
    const branch: XbBlock = {
      name: 'xb/if',
      attrs: { uid: 'aaaaaaaa' },
      children: [{ name: 'xb/branch', attrs: { uid: 'aaaaaaab', test: 'true}<script>alert(1)</script>{#if true' }, children: [] }],
    };
    expect(roundTrips([branch])).toBe(false);
    const attribute: XbBlock = { name: 'xb/element', attrs: { uid: 'aaaaaaaa', tag: 'div', attributes: { 'x onclick': 'y' } }, children: [] };
    expect(roundTrips([attribute])).toBe(false);
  });

  it('accepts every canonical fixture tree', () => {
    const tree = parse('<section class="a"><h1>Ciao <em>mondo</em></h1>{#loop posts(per_page: 3) as post}<Card title={post.title} />{/loop}<pre>  a\n  b</pre></section>').blocks;
    expect(roundTrips(tree)).toBe(true);
  });
});

describe('stored attributes are validated like DSL', () => {
  const doc = (attrs: Record<string, unknown>, name = 'xb/element') => `<!-- wp:${name} ${JSON.stringify(attrs)} /-->`;

  it('rejects invalid tags, attribute names and values', () => {
    const { blocks, issues } = parseXb(
      doc({ uid: 'aaaaaaaa', tag: 'img src=x onerror=alert(1)', attributes: { 'a b': 'x', __proto__: 'x', ok: 'y', n: 3, 'xb:label': 'z' } }),
      sequentialUids('z'),
    );
    const el = blocks[0];
    expect(el?.name === 'xb/element' && el.attrs.tag).toBe('div');
    expect(el?.name === 'xb/element' && el.attrs.attributes).toEqual({ ok: 'y' });
    expect(Object.getPrototypeOf(el?.name === 'xb/element' ? el.attrs.attributes : null)).toBe(Object.prototype);
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects malformed props, sources, refs and slot names', () => {
    const component = parseXb(
      doc({ uid: 'aaaaaaaa', ref: 'x" onload="y', props: { constructor: 'x', ok: { expr: 'a' }, bad: { expr: 1 }, deep: { a: 1 } } }, 'xb/component'),
    ).blocks[0];
    expect(component?.name === 'xb/component' && component.attrs).toMatchObject({ ref: '', props: { ok: { expr: 'a' } } });

    const loop = parseXb(doc({ uid: 'aaaaaaaa', source: { kind: 'preset', id: 'x y' }, as: 'a b' }, 'xb/loop')).blocks[0];
    expect(loop?.name === 'xb/loop' && loop.attrs).toMatchObject({ source: { kind: 'expr', expr: '[]' }, as: 'item' });

    const slot = parseXb(doc({ uid: 'aaaaaaaa', name: '}{@content' }, 'xb/slot')).blocks[0];
    expect(slot?.name === 'xb/slot' && slot.attrs.name).toBe('default');
  });

  it('refuses documents nested beyond the limit', () => {
    let tree: XbBlock[] = [];
    for (let i = 0; i < MAX_NESTING + 5; i++) tree = [{ name: 'xb/element', attrs: { uid: 'u' + String(i).padStart(7, '0'), tag: 'div' }, children: tree }];
    expect(() => parseXb(serializeXb(tree))).toThrow(RangeError);
    expect(() => print(tree)).toThrow(RangeError);
    expect(() => parse('<div>'.repeat(MAX_NESTING + 5) + '</div>'.repeat(MAX_NESTING + 5))).toThrow(XbSyntaxError);
  });
});

describe('the parser', () => {
  it('rejects reserved attribute and prop names', () => {
    expect(() => parse('<div __proto__="x"></div>')).toThrow(XbSyntaxError);
    expect(() => parse('<Card constructor="x" />')).toThrow(XbSyntaxError);
  });

  it('stays linear on long whitespace runs', () => {
    const spaces = ' '.repeat(200_000);
    let t = performance.now();
    parse(`<p>${spaces}x${spaces}</p>`);
    expect(() => parse(`{#loop ${spaces}}{/loop}`)).toThrow(XbSyntaxError);
    expect(performance.now() - t).toBeLessThan(2000);
    t = performance.now();
    const tree = parse(`{#loop posts() ${' '.repeat(1000)}as post}x{/loop}`).blocks;
    expect(stripUids(tree)[0]).toMatchObject({ attrs: { as: 'post', source: { kind: 'preset', id: 'posts' } } });
  });
});

describe('guard and inline formatting stored as separate nodes', () => {
  it('accepts nested inline elements that the parser folds bottom-up', () => {
    const strong: XbBlock = {
      name: 'xb/element',
      attrs: { uid: 'aaaaaaa1', tag: 'strong' },
      children: [
        { name: 'xb/text', attrs: { uid: 'aaaaaaa2', content: "dell'editrice " } },
        { name: 'xb/element', attrs: { uid: 'aaaaaaa3', tag: 'a', attributes: { href: 'https://x.it/', target: '_blank' } }, children: [{ name: 'xb/text', attrs: { uid: 'aaaaaaa4', content: 'Vita' } }] },
        { name: 'xb/text', attrs: { uid: 'aaaaaaa5', content: ' – fine' } },
      ],
    };
    expect(roundTrips([{ name: 'xb/element', attrs: { uid: 'aaaaaaa0', tag: 'p' }, children: [strong] }])).toBe(true);
  });

  it('still refuses inline elements with attributes the folding does not allow', () => {
    const span: XbBlock = { name: 'xb/element', attrs: { uid: 'bbbbbbb1', tag: 'span', attributes: { onclick: 'x' } }, children: [{ name: 'xb/text', attrs: { uid: 'bbbbbbb2', content: 'a' } }] };
    const wrapped: XbBlock = { name: 'xb/element', attrs: { uid: 'bbbbbbb0', tag: 'strong' }, children: [span] };
    expect(roundTrips([wrapped])).toBe(true);
    const tree = parse(print([wrapped])).blocks;
    expect(JSON.stringify(stripUids(tree))).toContain('onclick');
  });
});
