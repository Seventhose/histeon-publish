import { beforeAll, describe, expect, it } from 'vitest';
import type { StylesData } from '../src/lib/api.ts';

// The Gutenberg modules read WordPress's globals when they load: a minimal wp is enough for their pure parts.
(globalThis as unknown as { window: unknown }).window = { wp: { element: { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: (f: () => unknown) => f(), Fragment: 'f' } } };

let appearance: typeof import('../src/gutenberg/appearance.ts');
let styles: typeof import('../src/gutenberg/styles.ts');
let inspector: typeof import('../src/gutenberg/inspector.ts');
beforeAll(async () => {
  appearance = await import('../src/gutenberg/appearance.ts');
  styles = await import('../src/gutenberg/styles.ts');
  inspector = await import('../src/gutenberg/inspector.ts');
});

/** Just enough of a document for the canvas preview: <style> elements in <head>, in order. */
class FakeElement {
  id = '';
  textContent = '';
  dataset: Record<string, string> = {};
  sheet = { disabled: false };
  writes = 0;
  constructor(private readonly head: FakeElement[]) {}
  get isConnected() {
    return this.head.includes(this);
  }
  get nextElementSibling() {
    const i = this.head.indexOf(this);
    return i >= 0 ? (this.head[i + 1] ?? null) : null;
  }
  after(el: FakeElement) {
    const at = this.head.indexOf(el);
    if (at >= 0) this.head.splice(at, 1);
    this.head.splice(this.head.indexOf(this) + 1, 0, el);
  }
  remove() {
    const at = this.head.indexOf(this);
    if (at >= 0) this.head.splice(at, 1);
  }
}
function fakeDocument() {
  const nodes: FakeElement[] = [];
  const doc = {
    nodes,
    head: { appendChild: (el: FakeElement) => nodes.push(el) },
    getElementById: (id: string) => nodes.find((n) => n.id === id) ?? null,
    createElement: () => new FakeElement(nodes),
  };
  return doc;
}

const data = (entries: Array<[string, string, string]>): StylesData => ({ styles: entries.map(([id, selector, css]) => ({ id, selector, css })), globals: [{ id: 'main', css: 'body { margin: 0 }' }], queries: { tablet: '(width < 64em)' }, head: '', base: '' }) as unknown as StylesData;

describe('Aspetto in Gutenberg (lista della spesa 130-132)', () => {
  it('writes a declaration in the rule, at a width or in a state, and removes it again', () => {
    expect(appearance.applyDeclaration('', [], 'padding', 'var(--space-m)')).toBe('padding: var(--space-m);\n');
    const atTablet = appearance.applyDeclaration('color: red;\n', appearance.contextPath('@media (--tablet)', '&:hover'), 'padding', 'var(--space-s)');
    expect(atTablet).toContain('@media (--tablet) {');
    expect(atTablet).toContain('&:hover {');
    expect(atTablet).toContain('padding: var(--space-s);');
    expect(appearance.applyDeclaration(atTablet, ['@media (--tablet)', '&:hover'], 'padding', null).trim()).toBe('color: red;');
    expect(appearance.contextPath('', '')).toEqual([]);
  });

  it('speaks the client’s words for common values and keeps token steps', () => {
    expect(appearance.valueLabel({ label: 'flex', value: 'flex' })).toBe('In fila');
    expect(appearance.valueLabel({ label: 'm', value: 'var(--space-m)' })).toBe('m');
    expect(appearance.LABELS.padding).toBe('Spazio interno');
  });

  it('finds the declaration a button wrote, for the code to select it', () => {
    const css = 'padding-block: 1rem;\npadding: var(--space-m);\n&:hover {\n  padding: 2rem;\n}\n';
    const top = inspector.declarationRange(css, [], 'padding', 1)!;
    expect(css.slice(top.from, top.to)).toBe('padding: var(--space-m);');
    const hover = inspector.declarationRange(css, ['&:hover'], 'padding', 2)!;
    expect(css.slice(hover.from, hover.to)).toBe('padding: 2rem;');
    expect(inspector.declarationRange(css, ['&:focus'], 'padding', 3)).toBeUndefined();
  });

  it('previews incrementally: only the changed selector is compiled again, in the cascade order', () => {
    const doc = fakeDocument();
    const first = styles.applyPreview(data([['a', '.a', 'color: red;'], ['b', '.b', 'padding: 1rem;']]), doc as unknown as Document);
    expect(first.compiled).toBe(2);
    expect(doc.nodes.map((n) => n.id || n.dataset.xbPreview)).toEqual(['xb-inspector-preview', 'a', 'b']);
    const second = styles.applyPreview(data([['a', '.a', 'color: red;'], ['b', '.b', 'padding: 2rem;']]), doc as unknown as Document);
    expect(second.compiled).toBe(1);
    expect(doc.nodes[2]!.textContent).toContain('2rem');
    expect(styles.applyPreview(data([['a', '.a', 'color: red;'], ['b', '.b', 'padding: 2rem;']]), doc as unknown as Document).compiled).toBe(0);
    // A selector removed disappears; a new one goes where the site's CSS has it.
    styles.applyPreview(data([['c', '.c', 'margin: 0;'], ['b', '.b', 'padding: 2rem;']]), doc as unknown as Document);
    expect(doc.nodes.map((n) => n.id || n.dataset.xbPreview)).toEqual(['xb-inspector-preview', 'c', 'b']);
    // Named queries are resolved in the preview, as on the site.
    styles.applyPreview(data([['c', '.c', '@media (--tablet) { margin: 0; }']]), doc as unknown as Document);
    expect(doc.nodes[1]!.textContent).toContain('(width < 64em)');
  });

  it('a page with many selectors costs one compile per click', () => {
    const doc = fakeDocument();
    const many = Array.from({ length: 500 }, (_, i) => [`s${i}`, `.s${i}`, `padding: ${i}px;`] as [string, string, string]);
    styles.applyPreview(data(many), doc as unknown as Document);
    many[250] = ['s250', '.s250', 'padding: 1rem;'];
    const started = performance.now();
    expect(styles.applyPreview(data(many), doc as unknown as Document).compiled).toBe(1);
    expect(performance.now() - started).toBeLessThan(16);
  });
});

describe('Histeon · Libreria in Gutenberg (lista della spesa 136)', () => {
  it('inserts a section as the paste dialog does: new uids, new classes with styles, clashes renamed, same ones shared', async () => {
    const { planInsert } = await import('../src/gutenberg/library.ts');
    const { parse, serializeXb } = await import('@xb/dsl');
    const markup = serializeXb(parse('<section class="hero"><h2 class="hero__t">Ciao</h2><p class="same">x</p><p class="nuova">y</p></section>').blocks);
    const clip = { xb: 'clip' as const, version: 1 as const, origin: 'altro.sito', markup, styles: [{ selector: '.hero', css: 'padding: 2rem;' }, { selector: '.same', css: 'color: red;' }, { selector: '.nuova', css: 'margin: 0;' }] };
    const site = data([['h', '.hero', 'padding: 1rem;'], ['s', '.same', 'color:red']]);
    let n = 0;
    const plan = planInsert(clip, site, () => `fresh${(n++).toString().padStart(4, '0')}`);
    expect(plan.renames).toEqual([['hero', 'hero-2']]);
    expect(plan.styles).toEqual([{ selector: '.hero-2', css: 'padding: 2rem;' }, { selector: '.nuova', css: 'margin: 0;' }]);
    const printed = serializeXb(plan.blocks);
    expect(printed).toContain('"class":"hero-2"');
    expect(printed).toContain('"class":"hero-2__t"'); // the block's BEM part follows it: its CSS is .hero-2 { &__t … }
    expect(printed).toContain('fresh0000');
    expect(printed).not.toMatch(new RegExp((parse('<section class="hero"></section>').blocks[0]!.attrs.uid as string) ?? 'x'));
  });
});

describe('renaming a clashing class keeps its BEM parts with it', () => {
  it('renames card__title and card--dark with card, in elements and selectors, and nothing else', async () => {
    const { renameClasses, renameSelector } = await import('../src/lib/clip.ts');
    const { parse, serializeXb } = await import('@xb/dsl');
    const map = new Map([['card', 'card-2']]);
    const blocks = renameClasses(parse('<div class="card card--dark"><h3 class="card__title">x</h3><p class="cardigan">y</p></div>').blocks, map);
    const printed = serializeXb(blocks);
    expect(printed).toContain('"class":"card-2 card-2\\u002d\\u002ddark"'); // block markup writes -- escaped
    expect(printed).toContain('"class":"card-2__title"');
    expect(printed).toContain('"class":"cardigan"');
    expect(renameSelector('.card__title:hover, .cardigan .card--dark', map)).toBe('.card-2__title:hover, .cardigan .card-2--dark');
  });
});

describe('loops and conditions in words (lista della spesa 137)', () => {
  it('composes and reads simple tests, and refuses what is not a plain field', async () => {
    const logic = await import('../src/gutenberg/logic.ts');
    expect(logic.composeTest('page.type', '==', 'evento')).toBe('page.type == "evento"');
    expect(logic.composeTest('props.count', '>', '3')).toBe('props.count > 3');
    expect(logic.composeTest('user.logged_in', 'missing', '')).toBe('!user.logged_in');
    expect(logic.composeTest('a b', '==', 'x')).toBeNull();
    expect(logic.composeTest('x; alert(1)', 'exists', '')).toBeNull();
    expect(logic.readTest('page.type == "evento"')).toEqual({ field: 'page.type', operator: '==', value: 'evento' });
    expect(logic.readTest("page.type != 'x'")).toEqual({ field: 'page.type', operator: '!=', value: 'x' });
    expect(logic.readTest('!props.hidden')).toEqual({ field: 'props.hidden', operator: 'missing', value: '' });
    expect(logic.readTest('a.length > 2 && b')).toBeNull();
    expect(logic.readTest('true')).toBeNull();
    expect(logic.readTest('!false')).toBeNull();
    expect(logic.sentence('page.type == "evento"')).toBe('Si mostra se page.type è uguale a "evento".');
    expect(logic.sentence(null)).toBe('Si mostra quando nessuna condizione prima è vera.');
    expect(logic.checkTest('page.type == "x"')).toBeNull();
    expect(logic.checkTest('page.type == ')).not.toBeNull();
  });

  it('says what a loop shows, with what the loop passes', async () => {
    const logic = await import('../src/gutenberg/logic.ts');
    const presets = { eventi: { type: 'posts' as const, args: { post_type: 'evento', posts_per_page: 10 } } };
    expect(logic.loopSentence({ kind: 'preset', id: 'eventi', args: { limit: 6, offset: 2 } }, presets, { evento: 'Eventi' })).toBe('6 Eventi, per data, saltando i primi 2 — query «eventi»');
    expect(logic.loopSentence({ kind: 'preset', id: 'posts' }, presets)).toContain('query di serie «posts»');
    expect(logic.loopSentence({ kind: 'preset', id: 'sparita' }, presets)).toContain('che questo sito non ha');
    expect(logic.loopSentence({ kind: 'expr', expr: 'props.items' }, presets)).toBe('Ripete i valori di props.items');
    // Doc 23 of Publish, item 187: a grouped query loop says how it groups.
    expect(logic.loopSentence({ kind: 'preset', id: 'eventi', args: { limit: 6 }, groupBy: { field: 'date', how: 'Y' } }, presets, { evento: 'Eventi' })).toBe('6 Eventi, per data, in gruppi per «date» col formato «Y» — query «eventi»');
    expect(logic.loopSentence({ kind: 'preset', id: 'eventi', groupBy: { field: 'title', how: 'letter' } }, presets)).toContain('in gruppi per iniziale di «title»');
    expect(logic.loopSentence({ kind: 'preset', id: 'eventi', groupBy: { field: 'fields.tipo' } }, presets)).toContain('in gruppi per valore di «fields.tipo»');
  });
});
