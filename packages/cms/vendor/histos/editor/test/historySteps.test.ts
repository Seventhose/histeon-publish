import { describe as group, expect, it } from 'vitest';
import { parse, sequentialUids, type XbBlock } from '@xb/dsl';
import { describeStep, type StepState } from '../src/lib/historySteps.ts';

const state = (html: string, styles: Array<[string, string]> = [], globals: Array<[string, string]> = []): StepState => ({
  tree: parse(html, { uid: sequentialUids('u') }).blocks,
  styles: styles.map(([selector, css], i) => ({ id: `s${i}`, selector, css })),
  globals: globals.map(([id, css]) => ({ id, css })),
});

group('history in words', () => {
  it('added and removed blocks, the outermost only', () => {
    const before = state('<section class="hero"><h1>Titolo</h1></section>');
    const card = parse('<div class="card"><p>Uno</p></div>', { uid: sequentialUids('n') }).blocks;
    const after: StepState = { ...before, tree: [...before.tree, ...card] };
    expect(describeStep(before, after)).toBe('Aggiunto div.card');
    expect(describeStep(after, before)).toBe('Eliminato div.card');
  });
  it('a text, a change of attributes, CSS and a sheet', () => {
    const before = state('<p class="lead">Ciao</p>', [['.lead', 'color: red;']], [['global', 'body{}']]);
    const after = state('<p class="lead intro">Salve</p>', [['.lead', 'color: blue;']], [['global', 'body{margin:0}']]);
    const text = describeStep(before, after);
    expect(text).toContain('Testo «Salve»');
    expect(text).toContain('Modificato p.lead.intro');
    expect(text).toContain('CSS di .lead');
    expect(text).toContain('Foglio global');
  });
  it('a move among siblings', () => {
    const before = state('<ul><li>Uno</li><li>Due</li></ul>');
    const ul = before.tree[0] as XbBlock & { children: XbBlock[] };
    const after: StepState = { ...before, tree: [{ ...ul, children: [ul.children[1]!, ul.children[0]!] } as XbBlock] };
    expect(describeStep(before, after)).toBe('Spostato un elemento');
  });
  it('nothing visible', () => {
    const s = state('<p>x</p>');
    expect(describeStep(s, s)).toBe('Nessuna modifica visibile');
  });
});
