import { describe, expect, it } from 'vitest';
import { parse, print, sequentialUids } from '@xb/dsl';
import { replaceInTree } from '../src/lib/replace.ts';

const tree = (dsl: string) => parse(dsl, { uid: sequentialUids('n') }).blocks;
const html = (blocks: ReturnType<typeof tree>) => print(blocks).replace(/\n\s*/g, '');

describe('search and replace in the page (E13)', () => {
  it('replaces in the words only: never inside tags, expressions or other attributes', () => {
    const doc = tree('<p class="vino">Il vino <strong>vino</strong> {this.vino} e Vino</p><a href="/vino">vino</a>');
    const r = replaceInTree(doc, 'vino', 'pane', { text: true, classes: false, links: false, matchCase: true });
    expect(r.count).toBe(3);
    expect(html(r.tree)).toBe('<p class="vino">Il pane <strong>pane</strong> {this.vino} e Vino</p><a href="/vino">pane</a>');
    expect(r.matches[0]).toMatchObject({ where: 'text', before: expect.stringContaining('vino'), after: expect.stringContaining('pane') });
  });

  it('ignores case on request, and writes special characters safely', () => {
    const doc = tree('<p>Vino &amp; vino</p>');
    const r = replaceInTree(doc, 'vino & vino', 'a < b {x}', { text: true, classes: false, links: false, matchCase: false });
    expect(r.count).toBe(1);
    expect(html(r.tree)).toBe('<p>a &lt; b \\{x\\}</p>');
  });

  it('renames a class where it is a whole class, and rewrites links', () => {
    const doc = tree('<div class="card card--big"><a class="card__link" href="https://vecchio.it/pagina">x</a></div>');
    const classes = replaceInTree(doc, 'card', 'scheda', { text: false, classes: true, links: false, matchCase: true });
    expect(classes.count).toBe(1);
    expect(html(classes.tree)).toContain('class="scheda card--big"');
    expect(html(classes.tree)).toContain('class="card__link"');
    const links = replaceInTree(doc, 'https://vecchio.it', 'https://nuovo.it', { text: false, classes: false, links: true, matchCase: true });
    expect(links.count).toBe(1);
    expect(html(links.tree)).toContain('href="https://nuovo.it/pagina"');
  });

  it('changes nothing when nothing matches, and refuses an empty search', () => {
    const doc = tree('<p>ciao</p>');
    expect(replaceInTree(doc, 'addio', 'x', { text: true, classes: true, links: true, matchCase: false })).toMatchObject({ count: 0, tree: doc });
    expect(replaceInTree(doc, '', 'x', { text: true, classes: true, links: true, matchCase: false }).count).toBe(0);
  });
});
