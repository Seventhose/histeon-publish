import { describe, expect, it } from 'vitest';
import { childrenOf, parse, print, sequentialUids, type XbBlock } from '@xb/dsl';
import { canDrop, canUnwrap, contentHint, crumbName, searchTree, sectionName, findBlock, indentBlock, indexTree, insertAtSelection, insertLanding, moveTo, outdentBlock, onlyText, parentOf, roleName, selectionAfterRemoval, shorten, unwrapBlock, wrapBlock } from '../src/lib/tree.ts';

const tree = (dsl: string): XbBlock[] => parse(dsl, { uid: sequentialUids('n') }).blocks;
const shape = (blocks: XbBlock[]): string =>
  blocks
    .map((b) => {
      const label = b.name === 'xb/element' ? b.attrs.tag : b.name.slice(3);
      const kids = 'children' in b ? (b.children as XbBlock[]) : [];
      return kids.length ? `${label}(${shape(kids)})` : label;
    })
    .join(' ');
const uidOf = (blocks: XbBlock[], tag: string): string => {
  const walk = (list: XbBlock[]): string | null => {
    for (const b of list) {
      if (b.name === 'xb/element' && b.attrs.tag === tag) return b.attrs.uid;
      const found = walk('children' in b ? (b.children as XbBlock[]) : []);
      if (found) return found;
    }
    return null;
  };
  return walk(blocks) as string;
};

describe('drag and drop', () => {
  const doc = tree('<header></header><main><section></section><aside></aside></main><footer></footer>');

  it('moves before, after and inside', () => {
    expect(shape(moveTo(doc, uidOf(doc, 'footer'), uidOf(doc, 'header'), 'before'))).toBe('footer header main(section aside)');
    expect(shape(moveTo(doc, uidOf(doc, 'section'), uidOf(doc, 'aside'), 'after'))).toBe('header main(aside section) footer');
    expect(shape(moveTo(doc, uidOf(doc, 'header'), uidOf(doc, 'section'), 'inside'))).toBe('main(section(header) aside) footer');
  });

  it('never moves a node into itself or a void element', () => {
    expect(canDrop(doc, uidOf(doc, 'main'), uidOf(doc, 'section'), 'inside')).toBe(false);
    expect(canDrop(doc, uidOf(doc, 'main'), uidOf(doc, 'main'), 'after')).toBe(false);
    const withImg = tree('<div><img src="a.png"></div><p>x</p>');
    expect(canDrop(withImg, uidOf(withImg, 'p'), uidOf(withImg, 'img'), 'inside')).toBe(false);
    expect(moveTo(withImg, uidOf(withImg, 'p'), uidOf(withImg, 'img'), 'inside')).toBe(withImg);
  });

  it('keeps branches in their if, with the else last', () => {
    const cond = tree('{#if a}<b>1</b>{:else if c}<i>2</i>{:else}<u>3</u>{/if}<p>x</p>');
    const ifBlock = cond[0] as XbBlock & { children: XbBlock[] };
    const [first, second, last] = ifBlock.children.map((b) => b.attrs.uid) as [string, string, string];
    expect(canDrop(cond, second, first, 'before')).toBe(true);
    expect(canDrop(cond, last, first, 'before')).toBe(false);
    expect(canDrop(cond, first, uidOf(cond, 'p'), 'after')).toBe(false);
    expect(canDrop(cond, uidOf(cond, 'p'), ifBlock.attrs.uid, 'inside')).toBe(false);
    expect(findBlock(moveTo(cond, second, first, 'before'), second)).not.toBeNull();
  });
});

describe('HTML panel scope', () => {
  const doc = tree('<main><p>Ciao <b>mondo</b></p>{#if a}<i>x</i>{:else}<u>y</u>{/if}</main>');

  it('scopes texts to their element and branches to their if', async () => {
    const { scopeFor } = await import('../src/lib/tree.ts');
    const main = doc[0] as XbBlock & { children: XbBlock[] };
    const p = main.children[0] as XbBlock & { children: XbBlock[] };
    const ifBlock = main.children[1] as XbBlock & { children: XbBlock[] };
    expect(scopeFor(doc, p.children[0]!.attrs.uid)).toBe(p.attrs.uid);
    expect(scopeFor(doc, ifBlock.children[1]!.attrs.uid)).toBe(ifBlock.attrs.uid);
    expect(scopeFor(doc, main.attrs.uid)).toBe(main.attrs.uid);
    expect(scopeFor(doc, null)).toBeNull();
  });

  it('replaces one node with what was written', async () => {
    const { replaceBlock } = await import('../src/lib/tree.ts');
    const main = doc[0] as XbBlock & { children: XbBlock[] };
    const p = main.children[0] as XbBlock;
    expect(shape(replaceBlock(doc, p.attrs.uid, tree('<h2>a</h2><h3>b</h3>')))).toBe('main(h2(text) h3(text) if(branch(text) branch(text)))');
    expect(shape(replaceBlock(doc, p.attrs.uid, []))).toBe('main(if(branch(text) branch(text)))');
  });
});

describe('wrap in loop', () => {
  it('turns an element into the template of a loop and keeps it valid DSL', async () => {
    const { wrapInLoop, canWrapInLoop } = await import('../src/lib/tree.ts');
    const { print, parse: parseDsl } = await import('@xb/dsl');
    const blocks = tree('<div><article class="card"><h3>Titolo</h3></article></div>');
    const article = blocks[0]!.name === 'xb/element' ? (blocks[0] as { children: XbBlock[] }).children[0]! : null;
    expect(canWrapInLoop(blocks, article!.attrs.uid)).toBe(true);
    const wrapped = wrapInLoop(blocks, article!.attrs.uid, { kind: 'preset', id: 'eventi', args: { count: '3' } }, 'item', () => 'loop0001');
    expect(shape(wrapped)).toBe('div(loop(article(h3(text))))');
    const text = print(wrapped);
    expect(text).toContain('{#loop eventi(count: 3) as item}');
    expect(parseDsl(text).blocks).toHaveLength(1);
    const textUid = (article as { children: XbBlock[] }).children[0]!.attrs.uid;
    expect(canWrapInLoop(blocks, null)).toBe(false);
    expect(wrapInLoop(blocks, 'missing', { kind: 'preset', id: 'eventi' }, 'item', () => 'x')).toBe(blocks);
    const json = wrapInLoop(blocks, article!.attrs.uid, { kind: 'expr', expr: 'data.orari' }, 'h', () => 'loop0002');
    expect(print(json)).toContain('{#loop data.orari as h}');
    void textUid;
  });
});

describe('wrap and unwrap (structure context menu)', () => {
  it('wraps a node in a new element and unwraps keeping the children in place', () => {
    const t = tree('<main><p class="a">Uno</p><div class="box"><span>x</span><em class="e">y</em></div></main>');
    const main = t[0] as XbBlock & { children: XbBlock[] };
    const p = main.children[0]!;
    const box = main.children[1]!;
    expect(print(wrapBlock(t, p.attrs.uid, 'section', () => 'w1')).replace(/\s+/g, '')).toContain('<section><pclass="a">Uno</p></section>');
    expect(print(wrapBlock(t, p.attrs.uid, 'bad tag', () => 'w2'))).toBe(print(t));
    expect(canUnwrap(box)).toBe(true);
    expect(print(unwrapBlock(t, box.attrs.uid)).replace(/\s+/g, '')).toContain('<pclass="a">Uno</p><span>x</span><emclass="e">y</em></main>');
    expect(canUnwrap(main.children.find((b) => b.name === 'xb/text') ?? null)).toBe(false);
    expect(parentOf(t, box.attrs.uid)).toBe(main.attrs.uid);
    expect(parentOf(t, main.attrs.uid)).toBeNull();
  });
});

describe('content hint of structure rows', () => {
  it('picks the most important text, short', () => {
    const t = tree(`<section xb:label="Banner" class="vl-hero"><div class="wrap"><figure><img src="/a.jpg" alt="Foto di gruppo"/></figure><h2 class="t">I giusti continuano a leggere libri e storie</h2><p>Testo minore</p></div></section>`);
    expect(contentHint(t[0]!, true), 'open: the children show their text').toBeNull();
    expect(contentHint(tree('<div><img src="/a.jpg" alt="Foto"/><p>Testo vero</p></div>')[0]!), 'real text before an alt').toBe('Testo vero');
    expect(contentHint(tree('<div class="sl"><span>01 / 07</span><p class="sl__title">I giusti leggono</p></div>')[0]!), 'counters skipped, BEM titles first').toBe('I giusti leggono');
    const section = t[0]!;
    expect(contentHint(section)).toBe('I giusti continuano a…');
    const wrap = (section as XbBlock & { children: XbBlock[] }).children[0]!;
    const [figure, h2, p] = (wrap as XbBlock & { children: XbBlock[] }).children as [XbBlock, XbBlock, XbBlock];
    expect(contentHint(figure)).toBe('Foto di gruppo');
    expect(contentHint(h2)).toBe('I giusti continuano a…');
    expect(contentHint(p)).toBe('Testo minore');
    expect(contentHint(p, true), 'its text row is visible right below').toBeNull();
    const img = (figure as XbBlock & { children: XbBlock[] }).children[0]!;
    expect(contentHint(img)).toBe('Foto di gruppo');
  });

  it('reads components, expressions, and never repeats the label', () => {
    expect(contentHint(tree('<Ui.Card title="Prossimi eventi" url="/eventi" />')[0]!)).toBe('Prossimi eventi');
    expect(contentHint(tree('<h1>{this.title}</h1>')[0]!)).toBe('{this.title}');
    expect(contentHint(tree('<div xb:label="Ciao"><p>Ciao</p></div>')[0]!)).toBeNull();
    expect(contentHint(tree('<div class="vuoto"></div>')[0]!)).toBeNull();
    expect(contentHint(tree('<p>Caff&egrave; &amp; libri &#8211; s&#xEC;</p>')[0]!)).toBe('Caffè & libri – sì');
    expect(shorten('Una frase molto lunga che non entra nella riga', 20)).toBe('Una frase molto…');
  });
});

describe('readable names of structure rows', () => {
  const first = (html: string) => tree(html)[0]!;
  it('names a node by its tag when the tag says it, else by the word of its BEM class', () => {
    expect(roleName(first('<h2 class="card__title">x</h2>'))).toBe('Titolo H2');
    expect(roleName(first('<a class="vl-tile" href="/">x</a>'))).toBe('Link');
    expect(roleName(first('<header class="vl-page__hd"></header>'))).toBe('Intestazione');
    expect(roleName(first('<div class="vl-page__body"></div>'))).toBe('Corpo');
    expect(roleName(first('<div class="vl-wrap"></div>'))).toBe('Contenitore');
    expect(roleName(first('<span class="vl-tile__img"></span>'))).toBe('Immagine');
    expect(roleName(first('<div class="card--featured"></div>'))).toBe('Scheda');
    expect(roleName(first('<section class="e2e-hero"></section>'))).toBe('Hero');
    expect(roleName(first('<section class="news"></section>'))).toBe('Sezione news');
    expect(roleName(first('<div class="promo-strip"></div>'))).toBe('Strip');
    expect(roleName(first('<div></div>'))).toBe('Contenitore');
  });
  it('leaves rows that already read well', () => {
    expect(roleName(first('<div xb:label="Banner"></div>'))).toBeNull();
    expect(roleName(first('<p>testo</p>'))).toBe('Paragrafo');
  });
  it('keeps text-only elements closed', () => {
    expect(onlyText(first('<h1>Ciao</h1>'))).toBe(true);
    expect(onlyText(first('<div><div>Ciao</div></div>'))).toBe(false);
    expect(onlyText(first('<div></div>'))).toBe(false);
  });
});

describe('selection after a removal', () => {
  const tree = parse('<ul id="l"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul><p id="solo">x</p>', { uid: sequentialUids() }).blocks;
  const uidOf = (id: string) => {
    const find = (list: XbBlock[]): string | null => {
      for (const b of list) {
        if (b.name === 'xb/element' && b.attrs.attributes?.id === id) return b.attrs.uid;
        const inner = find('children' in b ? b.children : []);
        if (inner) return inner;
      }
      return null;
    };
    return find(tree)!;
  };
  const index = indexTree(tree);

  it('goes to the next sibling, else the previous one, else the parent', () => {
    expect(selectionAfterRemoval(tree, index, uidOf('a'))).toBe(uidOf('b'));
    expect(selectionAfterRemoval(tree, index, uidOf('c'))).toBe(uidOf('b'));
    const only = parse('<div id="p"><span id="s">s</span></div>', { uid: sequentialUids() }).blocks;
    const [div] = only;
    const span = (div as { children: XbBlock[] }).children[0]!;
    expect(selectionAfterRemoval(only, indexTree(only), span.attrs.uid)).toBe(div!.attrs.uid);
  });

  it('works at the top of the page, down to an empty page', () => {
    expect(selectionAfterRemoval(tree, index, uidOf('solo'))).toBe(uidOf('l'));
    const single = parse('<p>x</p>', { uid: sequentialUids() }).blocks;
    expect(selectionAfterRemoval(single, indexTree(single), single[0]!.attrs.uid)).toBeNull();
  });
});

describe('moving out of and into containers (Alt+← and Alt+→)', () => {
  it('takes an element out of its parent, right after it, and puts it into the element before it', () => {
    const tree = parse('<section><p>a</p><p>b</p></section><div></div><p>c</p>', { uid: sequentialUids() }).blocks;
    const [section, div, c] = tree as Array<XbBlock & { children: XbBlock[] }>;
    const b = section!.children[1]!;
    const out = outdentBlock(tree, b.attrs.uid);
    expect(print(out)).toBe(print(parse('<section><p>a</p></section><p>b</p><div></div><p>c</p>').blocks));
    const into = indentBlock(tree, c!.attrs.uid);
    expect(print(into)).toBe(print(parse('<section><p>a</p><p>b</p></section><div><p>c</p></div>').blocks));
    void div;
  });

  it('leaves the tree as it is where it cannot go', () => {
    const tree = parse('<p>a</p><img src="x.png" alt=""><p>b</p>', { uid: sequentialUids() }).blocks;
    expect(outdentBlock(tree, tree[0]!.attrs.uid)).toBe(tree);
    // The element before is an image: nothing goes inside it.
    expect(indentBlock(tree, tree[2]!.attrs.uid)).toBe(tree);
    expect(indentBlock(tree, tree[0]!.attrs.uid)).toBe(tree);
  });
});

describe('insertion next to the selection', () => {
  const tree = parse('<div><p>a</p></div><img src="x.png" alt="">', { uid: sequentialUids() }).blocks;
  const [div, img] = tree;
  const added = parse('<hr>', { uid: sequentialUids() }).blocks;

  it('goes inside a container by default, after anything else, before or after when asked', () => {
    expect(insertLanding(div!, 'auto')).toBe('inside');
    expect(insertLanding(img!, 'auto')).toBe('after');
    expect(insertLanding(img!, 'inside')).toBe('after');
    expect(insertLanding(null, 'before')).toBe('end');
    expect(print(insertAtSelection(tree, div!.attrs.uid, added, 'before'))).toBe(print(parse('<hr><div><p>a</p></div><img src="x.png" alt="">').blocks));
    expect(print(insertAtSelection(tree, div!.attrs.uid, added, 'after'))).toBe(print(parse('<div><p>a</p></div><hr><img src="x.png" alt="">').blocks));
    expect(print(insertAtSelection(tree, div!.attrs.uid, added))).toBe(print(parse('<div><p>a</p><hr></div><img src="x.png" alt="">').blocks));
  });
});

describe('structure names (E4)', () => {
  const first = (dsl: string): XbBlock => tree(dsl)[0]!;

  it('folds inline formatting: a paragraph with bold and line breaks is one row with its words', () => {
    // Plain formatting is already text; with attributes (as imported pages have it) it is made of elements.
    const p = first('<p>Il <strong class="b">giusto</strong> legge,<br class="r"/>sempre <em class="i">e <a href="/x">ovunque</a></em></p>');
    expect(childrenOf(p).some((k) => k.name === 'xb/element'), 'elements inside').toBe(true);
    expect(onlyText(p)).toBe(true);
    expect(contentHint(p)).toBe('Il giusto legge, sempre e…');
    expect(contentHint(first('<p>Caff&egrave; <b class="x">buono</b></p>'))).toBe('Caffè buono');
    // Without any text it is not a text row: an empty span inside a link is a part of its own.
    expect(onlyText(first('<a class="vl-tile" href="/x"><span class="vl-tile__img"></span></a>'))).toBe(false);
    expect(onlyText(first('<p>Uno<span class="x"><img src="/a.jpg" alt=""/></span></p>'))).toBe(false);
    expect(onlyText(first('<div><p>Testo</p></div>'))).toBe(false);
  });

  it('names a section or a box by its first heading, then aria-label, then id', () => {
    expect(sectionName(first('<section class="s"><div class="w"><span>01</span><h2>I giusti</h2><p>Testo</p></div></section>'))).toBe('I giusti');
    expect(sectionName(first('<div class="card"><p class="card__title">Prossimi eventi</p></div>')), 'a BEM title counts').toBe('Prossimi eventi');
    expect(sectionName(first('<nav aria-label="Menu principale"><ul><li>Uno</li></ul></nav>'))).toBe('Menu principale');
    expect(sectionName(first('<section id="chi-siamo"><p>Testo</p></section>'))).toBe('Chi siamo');
    expect(sectionName(first('<section xb:label="Banner"><h2>I giusti</h2></section>')), 'a hand-given name wins').toBeNull();
    expect(sectionName(first('<h2>I giusti</h2>')), 'a heading is its own text').toBeNull();
    expect(sectionName(first('<p>Il <strong>giusto</strong></p>')), 'a text row shows its words').toBeNull();
    expect(sectionName(first('<div class="w"><p>Solo testo</p></div>'))).toBeNull();
    expect(sectionName(first('<section id="{this.id}"><p>x</p></section>')), 'dynamic ids say nothing').toBeNull();
  });

  it('names a step of the path above the canvas', () => {
    expect(crumbName(first('<section xb:label="Banner"><h2>I giusti</h2></section>'))).toBe('Banner');
    expect(crumbName(first('<section class="s"><h2>I giusti che leggono sempre libri</h2></section>'))).toBe('I giusti che leggono…');
    expect(crumbName(first('<p>Il <strong class="b">giusto</strong></p>'))).toBe('Il giusto');
    expect(crumbName(first('<div class="card__body"><img src="/a.jpg" alt=""/></div>'))).toBe('Corpo');
    expect(crumbName(first('<div><img src="/a.jpg" alt=""/></div>'))).toBe('Contenitore');
  });
});

describe('structure search (E8)', () => {
  const doc = tree('<section id="chi-siamo" class="hero"><h2>I giusti leggono</h2><p>Il <strong class="b">giusto</strong> legge sempre</p><img src="/a.jpg" alt="Foto di gruppo"/><Ui.Card title="Prossimi eventi" /></section><footer class="site-footer"><p>Contatti</p></footer>');
  const tags = (uids: string[]) => uids.map((uid) => {
    const b = findBlock(doc, uid)!;
    return b.name === 'xb/element' ? b.attrs.tag : b.name;
  });

  it('finds by words, every word of the query, in reading order', () => {
    expect(tags(searchTree(doc, 'giust'))).toEqual(['h2', 'p']);
    expect(tags(searchTree(doc, 'legge sempre'))).toEqual(['p']);
    expect(searchTree(doc, '   ')).toEqual([]);
  });

  it('finds by tag, class, id, alt, component and role, never an ancestor by its children', () => {
    expect(tags(searchTree(doc, '#chi-siamo'))).toEqual(['section']);
    expect(tags(searchTree(doc, 'site-footer'))).toEqual(['footer']);
    expect(tags(searchTree(doc, 'foto'))).toEqual(['img']);
    expect(tags(searchTree(doc, 'eventi'))).toEqual(['xb/component']);
    expect(tags(searchTree(doc, 'paragrafo'))).toEqual(['p', 'p']);
    // The bold word inside the paragraph is part of its row, not a result of its own.
    expect(tags(searchTree(doc, 'strong'))).toEqual([]);
  });
});

describe('suggestedClass (doc 18 F5)', () => {
  it('proposes block__role after the nearest ancestor with a class, numbered when taken', async () => {
    const { parse } = await import('@xb/dsl');
    const { suggestedClass } = await import('../src/lib/tree.ts');
    let n = 0;
    const blocks = parse('<section class="hero hero--dark"><div><h1>Titolo</h1><p class="hero__text">a</p><p>b</p></div></section><p>c</p>', { uid: () => `u${(n++).toString().padStart(8, '0')}` }).blocks;
    const uidOf = (tag: string, index = 0) => {
      const out: string[] = [];
      const walk = (list: typeof blocks): void => { for (const b of list) { if (b.name === 'xb/element' && b.attrs.tag === tag) out.push(b.attrs.uid); if ('children' in b) walk(b.children as typeof blocks); } };
      walk(blocks);
      return out[index]!;
    };
    expect(suggestedClass(blocks, uidOf('h1'))).toBe('hero__title');
    expect(suggestedClass(blocks, uidOf('p', 1)), 'hero__text is taken').toBe('hero__text-2');
    expect(suggestedClass(blocks, uidOf('p', 2)), 'no ancestor with a class').toBe('text');
  });
});

describe('promoteInline (doc 18 F5)', () => {
  it('turns the n-th link of a sentence into an element with a class, keeping the rest as text', async () => {
    const { parse } = await import('@xb/dsl');
    const { promoteInline } = await import('../src/lib/tree.ts');
    let n = 0;
    const blocks = parse('<section class="hero"><p>Vieni <a href="#a">qui</a> o <a href="#b">là</a>.</p></section>', { uid: () => `u${(n++).toString().padStart(8, '0')}` }).blocks;
    const p = (blocks[0] as { children: Array<{ attrs: { uid: string } }> }).children[0]!.attrs.uid;
    const result = promoteInline(blocks, p, 'a', 1, 'hero__link');
    expect(result).not.toBeNull();
    const para = (result!.blocks[0] as { children: Array<{ attrs: { uid: string }; children: Array<{ name: string; attrs: Record<string, unknown> }> }> }).children[0]!;
    expect(para.attrs.uid, 'the paragraph keeps its uid').toBe(p);
    expect(para.children.map((c) => c.name)).toEqual(['xb/text', 'xb/element', 'xb/text']);
    expect(para.children[0]!.attrs.content).toBe('Vieni <a href="#a">qui</a> o ');
    expect(para.children[1]!.attrs).toMatchObject({ tag: 'a', attributes: { href: '#b', class: 'hero__link' } });
    expect(promoteInline(blocks, p, 'a', 5, 'x'), 'no such link').toBeNull();
  });
});

describe('loop in groups and the content block of a template (doc 23 of Publish, items 204 and 205)', () => {
  it('wraps an element in a grouped query loop: a title per group, the element for each of its contents', async () => {
    const { wrapInGroups } = await import('../src/lib/tree.ts');
    const { parseXb, serializeXb } = await import('@xb/dsl');
    const blocks = tree('<div><article class="card"><h3>{item.title}</h3></article></div>');
    const article = uidOf(blocks, 'article');
    const wrapped = wrapInGroups(blocks, article, { kind: 'preset', id: 'foto', args: {}, groupBy: { field: 'date', how: 'Y' } }, 'gruppo', 'item', sequentialUids('g'));
    expect(shape(wrapped)).toBe('div(loop(h2(text) loop(article(h3(text)))))');
    const text = print(wrapped);
    expect(text).toContain('{#loop foto().groupBy("date", "Y") as gruppo}');
    expect(text).toContain('{gruppo.key}');
    expect(text).toContain('{#loop gruppo.items as item}');
    // The same source.groupBy in the saved blocks as the code and Gutenberg write.
    const saved = parseXb(serializeXb(wrapped));
    expect(saved.issues).toEqual([]);
    const outer = (saved.blocks[0] as { children: XbBlock[] }).children[0]!;
    expect(outer.name === 'xb/loop' && outer.attrs.source).toEqual({ kind: 'preset', id: 'foto', groupBy: { field: 'date', how: 'Y' } });
    // Without a grouping, or on something that cannot be wrapped, nothing changes.
    expect(wrapInGroups(blocks, article, { kind: 'preset', id: 'foto' }, 'gruppo', 'item', () => 'x')).toBe(blocks);
    expect(wrapInGroups(blocks, 'missing', { kind: 'preset', id: 'foto', groupBy: { field: 'title', how: 'letter' } }, 'gruppo', 'item', () => 'x')).toBe(blocks);
  });

  it('finds the content block of a template anywhere in it', async () => {
    const { hasPostContent } = await import('../src/lib/tree.ts');
    expect(hasPostContent(tree('<main><h1>{this.title}</h1>{@content}</main>'))).toBe(true);
    expect(hasPostContent(tree('<main>{#if this.title}<section>{@content}</section>{/if}</main>'))).toBe(true);
    expect(hasPostContent(tree('<main><h1>{this.title}</h1>{#loop posts() as item}<p>{item.title}</p>{/loop}</main>'))).toBe(false);
    expect(hasPostContent([])).toBe(false);
  });
});
