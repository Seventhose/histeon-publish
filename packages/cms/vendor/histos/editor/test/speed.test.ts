import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, type ElementBlock, type XbBlock } from '@xb/dsl';
import { applyBem, componentProblem, freeRoots, interpolations, refFrom, svgAttribute } from '../src/lib/speed.ts';

const tree = (dsl: string): XbBlock[] => parse(dsl, { uid: sequentialUids('n') }).blocks;

describe('quick actions', () => {
  it('finds the expressions of a value, not escaped braces', () => {
    expect(interpolations('a {item.title} \\{x\\} {site.name ?? "}"}')).toEqual(['item.title', 'site.name ?? "}"']);
  });

  it('knows which names a selection reads from outside', () => {
    const blocks = tree('<article class="{item.slug}"><h2>{item.title}</h2>{#loop this.tags as t}<span>{t.name} {i}</span>{/loop}<p>{site.name}</p></article>');
    expect([...freeRoots(blocks)].sort()).toEqual(['i', 'item', 'site', 'this']);
    expect(componentProblem(blocks)).toMatch(/"i", "item"/);
    expect(componentProblem(tree('<div><p>{this.title} {data.orari[0].giorno}</p>{#loop data.posts as p}<b>{p.title}</b>{/loop}</div>'))).toBeNull();
  });

  it('makes a component key from a label', () => {
    expect(refFrom('Scheda evento')).toBe('scheda-evento');
    expect(refFrom('Città 2')).toBe('citta2');
    expect(refFrom('***')).toBe('componente');
  });

  it('names the children of a block in BEM', () => {
    const [card] = tree('<article class="card"><h2>{this.title}</h2><p class="lead">x</p><div><img src="a.jpg" alt=""><p>y</p></div><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><Badge /></article>') as [ElementBlock];
    const { block, added, base } = applyBem(card);
    expect(base).toBe('card');
    expect(added).toEqual(['card__title', 'card__inner', 'card__image', 'card__text', 'card__icon']);
    const classes: string[] = [];
    const walk = (b: XbBlock) => {
      if (b.name === 'xb/element') classes.push(`${b.attrs.tag}:${b.attrs.attributes?.class ?? ''}`);
      if ('children' in b) (b.children as XbBlock[]).forEach(walk);
    };
    walk(block);
    expect(classes).toContain('p:lead');
    expect(classes).toContain('path:');
    const [plain] = tree('<section><h3>x</h3></section>') as [ElementBlock];
    expect(applyBem({ ...plain, attrs: { ...plain.attrs, label: 'Hero banner' } }).block.attrs.attributes?.class).toBe('hero-banner');
  });
});

describe('svg handlers', () => {
  it('removes event handler attributes however they are written', async () => {
    const { stripHandlers } = await import('../src/lib/speed.ts');
    const cases = ['<svg onload="a()">', "<svg/onload='a()'>", '<svg a="x"onclick=a()>', '<svg ONLOAD = a()>', '<svg\nonmouseover="a">', '<svg on-x="1">'];
    for (const c of cases) expect(stripHandlers(c)).not.toMatch(/on[a-z-]*\s*=/i);
    expect(stripHandlers('<svg title="scon=1" viewBox="0 0 1 1">')).toBe('<svg title="scon=1" viewBox="0 0 1 1">');
  });
});

describe('structure labels', () => {
  it('names elements in BEM inside a block with a class, and nowhere else', async () => {
    const { autoLabel, childBase, cleanLabel } = await import('../src/lib/speed.ts');
    const [card] = tree('<article class="card big"><h2>T</h2><p class="lead">x</p><div><h3>y</h3></div></article>') as [ElementBlock];
    const base = childBase(card, null);
    expect(base).toBe('card');
    const [h2, p, div] = card.children as ElementBlock[];
    expect(autoLabel(h2 as ElementBlock, base)).toBe('card__title');
    expect(autoLabel(p as ElementBlock, base)).toBeNull();
    expect(childBase(p as ElementBlock, base)).toBe('lead');
    expect(autoLabel((div as ElementBlock).children[0] as ElementBlock, childBase(div as ElementBlock, base))).toBe('card__title');
    expect(autoLabel(h2 as ElementBlock, null)).toBeNull();
    expect(autoLabel({ ...(h2 as ElementBlock), attrs: { ...(h2 as ElementBlock).attrs, label: 'Titolo' } }, base)).toBeNull();
    expect(cleanLabel('  Scheda {item.x}\n evento  ')).toBe('Scheda item.x evento');
  });
});

describe('svgAttribute (pasted SVG)', () => {
  it('drops every namespace declaration, on the root too: Histeon CMS transfers refuse them', () => {
    expect(svgAttribute('xmlns', 'http://www.w3.org/2000/svg')).toEqual({});
    expect(svgAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')).toEqual({});
    expect(svgAttribute('XMLNS', 'http://www.w3.org/2000/svg')).toEqual({});
  });

  it('drops handlers and outside references, keeps same-document ones and drawing attributes', () => {
    expect(svgAttribute('onload', 'alert(1)')).toEqual({ dropped: 'onload' });
    expect(svgAttribute('href', 'https://example.com/sprite.svg#a')).toEqual({ dropped: 'href="https://example.com/sprite.svg"' });
    expect(svgAttribute('xlink:href', '#icon')).toEqual({ keep: ['href', '#icon'] });
    expect(svgAttribute('viewBox', '0 0 24 24')).toEqual({ keep: ['viewBox', '0 0 24 24'] });
    expect(svgAttribute('fill', '{x}')).toEqual({ keep: ['fill', '\\{x\\}'] });
  });
});

