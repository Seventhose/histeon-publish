import { describe, expect, it } from 'vitest';
import { parse, print, refToTag, sequentialUids, stripUids, tagToRef, XbSyntaxError, type XbBlock } from '../src/index.ts';

const tree = (src: string): XbBlock[] => stripUids(parse(src, { uid: sequentialUids() }).blocks);
/** The source of a loop block, or undefined for any other block. */
const loopSource = (b: XbBlock | undefined) => (b?.name === 'xb/loop' ? b.attrs.source : undefined);

describe('elements and text', () => {
  it('folds plain inline formatting into one xb/text', () => {
    expect(tree('<p>Ciao <strong>mondo</strong> e <a href="/x">link</a>!</p>')).toEqual([
      {
        name: 'xb/element',
        attrs: { uid: '', tag: 'p' },
        children: [{ name: 'xb/text', attrs: { uid: '', content: 'Ciao <strong>mondo</strong> e <a href="/x">link</a>!' } }],
      },
    ]);
  });

  it('keeps inline tags with classes or dynamic attributes as elements', () => {
    const [p] = tree('<p>Vai <a class="btn" href="/x">qui</a> o <a href={url}>là</a></p>');
    expect(p && 'children' in p ? p.children.map((c) => c.name) : []).toEqual([
      'xb/text',
      'xb/element',
      'xb/text',
      'xb/element',
    ]);
  });

  it('drops indentation whitespace but keeps meaningful spaces', () => {
    const [div] = tree('<div>\n  <span class="a">a</span> <span class="b">b</span>\n</div>');
    expect(div && 'children' in div ? div.children.map((c) => (c.name === 'xb/text' ? c.attrs.content : c.name)) : []).toEqual([
      'xb/element',
      ' ',
      'xb/element',
    ]);
  });

  it('keeps attribute order, boolean and dynamic values', () => {
    expect(tree('<input type="checkbox" checked data-id={item.id} title="Ciao {user.name}">')).toEqual([
      {
        name: 'xb/element',
        attrs: {
          uid: '',
          tag: 'input',
          attributes: { type: 'checkbox', checked: true, 'data-id': '{item.id}', title: 'Ciao {user.name}' },
        },
        children: [],
      },
    ]);
  });

  it('allows quotes inside interpolations in quoted attributes', () => {
    const [el] = tree('<p title="{a ?? "x"}"></p>');
    expect(el?.name === 'xb/element' && el.attrs.attributes).toEqual({ title: '{a ?? "x"}' });
  });
});

describe('components', () => {
  it('maps tags to refs bijectively', () => {
    for (const ref of ['card', 'card-hero', 'ui/card-hero', 'h1-title', 'card2-x', 'card-h-t-m-l']) {
      expect(tagToRef(refToTag(ref))).toBe(ref);
    }
    expect(refToTag('ui/card-hero')).toBe('Ui.CardHero');
    expect(tree('<Header />')[0]?.attrs).toMatchObject({ ref: 'header' });
  });

  it('types props and builds slot fills', () => {
    const [c] = tree('<Card a="x" b={1} c d={null} e={x.y} f="Hi {u}">{#slot head}H{/slot}body</Card>');
    expect(c).toEqual({
      name: 'xb/component',
      attrs: { uid: '', ref: 'card', props: { a: 'x', b: 1, c: true, d: null, e: { expr: 'x.y' }, f: { tpl: 'Hi {u}' } } },
      children: [
        { name: 'xb/slot-fill', attrs: { uid: '', name: 'head' }, children: [{ name: 'xb/text', attrs: { uid: '', content: 'H' } }] },
        { name: 'xb/slot-fill', attrs: { uid: '', name: 'default' }, children: [{ name: 'xb/text', attrs: { uid: '', content: 'body' } }] },
      ],
    });
  });
});

describe('loops', () => {
  it('distinguishes presets from expressions', () => {
    const [a, b] = tree('{#loop posts(limit: 3) as p}{/loop}{#loop props.items as item, i}{/loop}');
    expect(a?.attrs).toMatchObject({ source: { kind: 'preset', id: 'posts', args: { limit: '3' } }, as: 'p' });
    expect(b?.attrs).toMatchObject({ source: { kind: 'expr', expr: 'props.items' }, as: 'item', index: 'i' });
  });

  it('finds the trailing "as" even when the source contains " as "', () => {
    const [a] = tree('{#loop posts(title: "x as y") as p}{/loop}');
    expect(a?.attrs).toMatchObject({ source: { kind: 'preset', id: 'posts', args: { title: '"x as y"' } }, as: 'p' });
  });
});

describe('grouped query loops (doc 23 of Publish, item 187)', () => {
  it('reads one groupBy after the query, and prints it back the same', () => {
    const [a, b] = tree('{#loop foto().groupBy("anno") as gruppo}{/loop}{#loop foto(limit: 20).groupBy("publishedAt", "F Y") as g}{/loop}');
    expect(loopSource(a)).toEqual({ kind: 'preset', id: 'foto', groupBy: { field: 'anno' } });
    expect(loopSource(b)).toEqual({ kind: 'preset', id: 'foto', args: { limit: '20' }, groupBy: { field: 'publishedAt', how: 'F Y' } });
    const src = '{#loop foto(limit: 20).groupBy("fields.data", "Y") as gruppo}<h2>{gruppo.key}</h2>{#loop gruppo.items as f}<p>{f.title}</p>{/loop}{/loop}';
    const printed = print(parse(src, { uid: sequentialUids() }).blocks);
    expect(printed).toContain('{#loop foto(limit: 20).groupBy("fields.data", "Y") as gruppo}');
    expect(tree(printed)).toEqual(tree(src));
    // A mode with quotes and a backslash prints escaped and reads back the same.
    const odd = tree(String.raw`{#loop foto().groupBy("date", "j \\d\"F\"") as g}{/loop}`);
    expect(loopSource(odd[0])).toEqual({ kind: 'preset', id: 'foto', groupBy: { field: 'date', how: 'j \\d"F"' } });
    expect(tree(print(odd))).toEqual(odd);
  });

  it('keeps groupBy on a list an expression source', () => {
    expect(loopSource(tree('{#loop props.items.groupBy("tipo") as g}{/loop}')[0])).toEqual({ kind: 'expr', expr: 'props.items.groupBy("tipo")' });
  });

  it.each([
    ['another modifier', '{#loop foto().upper() as g}{/loop}', /intera sorgente.*groupBy/],
    ['two groupBy', '{#loop foto().groupBy("a").groupBy("b") as g}{/loop}', /intera sorgente/],
    ['a modifier after groupBy', '{#loop foto().groupBy("a").slice(0, 2) as g}{/loop}', /intera sorgente/],
    ['an index after groupBy', '{#loop foto().groupBy("a")[0] as g}{/loop}', /intera sorgente/],
    ['a fallback', '{#loop foto().groupBy("a") ?? [] as g}{/loop}', /intera sorgente/],
    ['a field from an expression', '{#loop foto().groupBy(props.campo) as g}{/loop}', /come testi scritti/],
    ['a number', '{#loop foto().groupBy("a", 4) as g}{/loop}', /come testi scritti/],
    ['no field', '{#loop foto().groupBy() as g}{/loop}', /come testi scritti/],
    ['three arguments', '{#loop foto().groupBy("a", "Y", "x") as g}{/loop}', /come testi scritti/],
    ['a field with spaces', '{#loop foto().groupBy("a b") as g}{/loop}', /Campo di groupBy non valido/],
    ['an empty mode', '{#loop foto().groupBy("a", "") as g}{/loop}', /Modo di groupBy non valido/],
    ['a long mode', `{#loop foto().groupBy("a", "${'Y'.repeat(33)}") as g}{/loop}`, /Modo di groupBy non valido/],
  ])('refuses %s', (_name, src, message) => {
    expect(() => parse(src)).toThrow(message);
  });
});

describe('errors carry positions', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['mismatched tag', '<div>\n  <p>x</div>', /Atteso <\/p>/],
    ['unclosed if', '{#if a}<p>x</p>', /\{#if\} non chiuso/],
    ['else outside if', '<div>{:else}</div>', /<div> non chiuso/],
    ['branch after else', '{#if a}{:else}{:else if b}{/if}', /dopo \{:else\}/],
    ['strict equality', '{a === b}', /già stretti/],
    ['free function call', '{alert(1)}', /Chiamata a funzione non consentita/],
    ['named args in modifier', '{a.slice(n: 1)}', /solo argomenti posizionali/],
    ['positional preset args', '{#loop posts(3) as p}{/loop}', /devono essere nominati/],
    ['preset nested in expression', '{#loop posts() ?? [] as p}{/loop}', /intera sorgente/],
    ['duplicate attribute', '<a href="x" href="y"></a>', /duplicato/],
    ['slot fill outside component', '<div>{#slot a}{/slot}</div>', /figlio diretto di un componente/],
    ['unknown pseudo attribute', '<div xb:uid="x"></div>', /Pseudo-attributo/],
    ['uppercase html tag', '<DIV></DIV>', /componente/],
    ['unclosed brace', '<p>{a</p>', /non chiusa/],
    ['default slot twice', '<Card>x{#slot default}y{/slot}</Card>', /non possono coesistere/],
  ];

  it.each(cases)('%s', (_name, src, message) => {
    let error: unknown;
    try {
      parse(src);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(XbSyntaxError);
    expect((error as XbSyntaxError).message).toMatch(message);
    expect((error as XbSyntaxError).line).toBeGreaterThan(0);
  });

  it('reports line and column of the offending close tag', () => {
    expect.assertions(1);
    try {
      parse('<div>\n  <p>x</div>');
    } catch (e) {
      expect(e).toMatchObject({ line: 2, column: 7 });
    }
  });
});

it('warns about dropped HTML comments', () => {
  expect(parse('<p>a<!-- x -->b</p>').warnings).toHaveLength(1);
});
