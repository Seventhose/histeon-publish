import { describe, expect, it, vi } from 'vitest';
import { parse, print, reconcileUids, serializeXb } from '@xb/dsl';
import { BuilderState } from '../src/lib/state.svelte.ts';
import type { Api, SaveExtras, StyleEntry } from '../src/lib/api.ts';

function fakeApi(content: string): Api {
  return {
    getDocument: async () => ({ id: 1, type: 'page', title: 'T', status: 'publish', content, head: 'h'.repeat(32), base: 'h'.repeat(32), merged: 0, conflicts: [], published: true, link: null, script: '', scriptEditable: true, ref: null, schema: null }),
    getStyles: async () => ({ styles: [], globals: [], head: 's'.repeat(32), base: 's'.repeat(32) }),
    saveDocument: async (_id: number, sent: string, _head: string, _base: string, extras: SaveExtras = {}) => ({ id: 1, type: 'page', title: 'T', status: 'publish', content: sent, head: 'i'.repeat(32), base: 'h'.repeat(32), merged: 0, conflicts: [], published: false, link: null, script: extras.script ?? '', scriptEditable: true, ref: extras.ref ?? null, schema: extras.schema ?? null }),
    saveStyles: async (styles: unknown, globals: unknown) => ({ styles, globals, head: 't'.repeat(32), base: 's'.repeat(32) }),
    render: async () => ({ html: '', css: '', globalCss: '', stylesheets: [] }),
    listComponents: async () => [],
    getFramework: async () => ({ active: { id: 'xb-tokens', label: 'XB Tokens' }, variables: [], classes: [] }),
  } as unknown as Api;
}

async function loaded(dsl = '<p>a</p>'): Promise<BuilderState> {
  const state = new BuilderState(fakeApi(serializeXb(parse(dsl).blocks)), 1);
  await state.load();
  return state;
}

describe('BuilderState history', () => {
  it('undoes and redoes tree edits', async () => {
    const state = await loaded();
    state.setTree(parse('<p>b</p>').blocks);
    expect(state.dirty).toBe(true);
    state.undo();
    expect(state.content).toContain('"content":"a"');
    expect(state.dirty).toBe(false);
    state.redo();
    expect(state.content).toContain('"content":"b"');
  });

  it('starts a new history when the document is reloaded', async () => {
    const state = await loaded();
    state.setTree(parse('<p>b</p>').blocks);
    expect(state.canUndo).toBe(true);
    // A reload follows a server-side change (restore, selector rename): undo must not bring back the old tree.
    await state.load();
    expect(state.canUndo).toBe(false);
    state.undo();
    expect(state.content).toContain('"content":"a"');
  });

  it('records no step when the content does not change', async () => {
    const state = await loaded();
    // As the HTML panel does: re-parsed text keeps the uids of unchanged nodes.
    state.setTree(reconcileUids(state.tree, parse('<p>a</p>').blocks), { fromHtml: true });
    expect(state.canUndo).toBe(false);
  });

  it('merges quick consecutive edits from the same source', async () => {
    vi.useFakeTimers();
    const state = await loaded();
    state.setTree(parse('<p>ab</p>').blocks, { fromHtml: true });
    vi.advanceTimersByTime(300);
    state.setTree(parse('<p>abc</p>').blocks, { fromHtml: true });
    vi.advanceTimersByTime(2000);
    state.setTree(parse('<p>abcd</p>').blocks, { fromHtml: true });
    state.undo();
    expect(state.content).toContain('"content":"abc"');
    state.undo();
    expect(state.content).toContain('"content":"a"');
    vi.useRealTimers();
  });

  it('saves content and styles and becomes clean', async () => {
    const state = await loaded();
    state.upsertStyle('.x', 'color:red');
    state.setTree(parse('<p class="x">b</p>').blocks);
    await state.save();
    expect(state.dirty).toBe(false);
    expect(state.status.kind).toBe('saved');
    expect(state.liveCss).toContain('.x{color:red;}');
  });
});

describe('BuilderState tree', () => {
  it('is frozen, and an edit shares the untouched parts with the tree before it', async () => {
    const state = await loaded('<section><p>a</p></section><footer><p>b</p></footer>');
    const before = state.tree;
    expect(Object.isFrozen(before[0])).toBe(true);
    const p = state.path(state.tree[0]!.attrs.uid).length ? state.tree[0]!.children[0]! : null;
    state.setTextContent(p!.attrs.uid, 'nuovo');
    expect(state.content).toContain('"content":"nuovo"');
    expect(state.tree[1]).toBe(before[1]);
    expect(() => {
      (state.tree[1]!.attrs as { uid: string }).uid = 'x';
    }).toThrow(TypeError);
    state.undo();
    expect(state.tree).toBe(before);
  });

  it('finds blocks and their ancestors through the index', async () => {
    const state = await loaded('<main><section><p>a</p></section></main>');
    const p = (state.tree[0]!.children[0] as { children: Array<{ attrs: { uid: string } }> }).children[0]!;
    expect(state.find(p.attrs.uid)).toBe(p);
    expect(state.path(p.attrs.uid)).toHaveLength(3);
    expect(state.find('nessuno')).toBeNull();
  });
});

describe('BuilderState pending panel edits', () => {
  it('applies a panel edit after the typing pause', async () => {
    vi.useFakeTimers();
    const state = await loaded();
    state.deferEdit('html', 300, () => state.setTree(parse('<p>b</p>').blocks, { fromHtml: true }));
    expect(state.editsPending).toBe(true);
    expect(state.dirty).toBe(true);
    // A newer keystroke replaces the pending edit.
    state.deferEdit('html', 300, () => state.setTree(parse('<p>c</p>').blocks, { fromHtml: true }));
    vi.advanceTimersByTime(300);
    expect(state.editsPending).toBe(false);
    expect(state.content).toContain('"content":"c"');
    vi.useRealTimers();
  });

  it('drops a cancelled edit', async () => {
    vi.useFakeTimers();
    const state = await loaded();
    state.deferEdit('css', 250, () => state.upsertStyle('.x', 'color:red'));
    state.cancelEdit('css');
    vi.advanceTimersByTime(1000);
    expect(state.editsPending).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.styles).toEqual([]);
    vi.useRealTimers();
  });

  it('saves what was typed just before saving', async () => {
    const state = await loaded();
    const saveDocument = vi.spyOn(state.api, 'saveDocument');
    const saveStyles = vi.spyOn(state.api, 'saveStyles');
    // Ctrl+S within the panels' debounce: nothing has reached the tree or the styles yet.
    state.deferEdit('html', 300, () => state.setTree(parse('<p>b</p>').blocks, { fromHtml: true }));
    state.deferEdit('css', 250, () => state.upsertStyle('.x', 'color:red'));
    await state.save();
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(saveDocument.mock.calls[0]?.[1]).toContain('"content":"b"');
    expect(saveStyles).toHaveBeenCalledOnce();
    expect(saveStyles.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ selector: '.x', css: 'color:red' })]);
    expect(state.editsPending).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.status.kind).toBe('saved');
  });
});

describe('BuilderState text the panels refused', () => {
  it('counts as unsaved, and saving says it was not saved', async () => {
    const state = await loaded();
    const saveDocument = vi.spyOn(state.api, 'saveDocument');
    // As the HTML panel does when the typed text does not parse.
    state.deferEdit('html', 300, () => state.reject('html', 'HTML non valido alla riga 3'));
    await state.save();
    expect(saveDocument).not.toHaveBeenCalled();
    expect(state.dirty).toBe(true);
    expect(state.status).toEqual({ kind: 'error', message: 'HTML non valido alla riga 3: non salvato' });
  });

  it('saves the rest, and still says what was not saved', async () => {
    const state = await loaded();
    state.upsertStyle('.x', 'color:red');
    state.reject('css:global:0', 'CSS di .x con graffe non bilanciate');
    await state.save();
    expect(state.dirtyStyles).toBe(false);
    expect(state.dirty).toBe(true);
    expect(state.status.kind).toBe('error');
    expect(state.status.message).toContain('CSS di .x con graffe non bilanciate: non salvato');
  });

  it('asks before another selection, an edit from elsewhere or undo would replace it', async () => {
    const state = await loaded('<p>a</p><p>b</p>');
    const [first, second] = state.tree.map((b) => b.attrs.uid);
    state.select(first ?? null);
    state.setTree(parse('<p>c</p>').blocks);
    state.reject('html', 'HTML non valido alla riga 1');
    const asked: string[] = [];
    state.confirmDiscard = (question) => (asked.push(question), false);
    state.select(second ?? null);
    expect(state.selected).toBe(first);
    state.undo();
    expect(state.content).toContain('"content":"c"');
    state.setTree(parse('<p>d</p>').blocks);
    expect(state.content).toContain('"content":"c"');
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain('HTML non valido alla riga 1');
    // The HTML panel's own edits and selections do not ask: they are the fix.
    state.select(second ?? null, 'html');
    expect(state.selected).toBe(second);
    // Agreed: the text no longer counts.
    state.confirmDiscard = () => true;
    state.undo();
    expect(state.invalid).toBe('');
    expect(state.content).toContain('"content":"a"');
  });

  it('stops counting once the panel types again or shows the state again', async () => {
    const state = await loaded();
    state.reject('html', 'Codice HTML vuoto');
    expect(state.dirty).toBe(true);
    state.cancelEdit('html');
    expect(state.invalid).toBe('');
    expect(state.dirty).toBe(false);
  });
});

describe('BuilderState live CSS', () => {
  it('compiles each entry again only when its text changes, and follows every change (V12)', async () => {
    const state = await loaded();
    state.upsertStyle('.a', 'color: red;');
    state.upsertStyle('.b', '&__t { color: blue; }');
    expect(state.liveCss).toContain('.a{color: red;}');
    expect(state.liveCss).toContain('.b__t{color: blue;}');
    state.upsertStyle('.a', 'color: green;');
    expect(state.liveCss).toContain('.a{color: green;}');
    expect(state.liveCss).not.toContain('color: red');
    // Back to a text compiled before: the same CSS as then.
    state.undo();
    expect(state.liveCss).toContain('.a{color: red;}');
    expect(state.liveCss).not.toContain('color: green');
  });
});

describe('BuilderState styles as frozen, shared arrays (V12)', () => {
  it('changes only the edited entry, never in place, and undo brings back the very same arrays', async () => {
    const state = await loaded();
    state.upsertStyle('.a', 'color: red;');
    state.upsertStyle('.b', 'color: blue;');
    state.setGlobalCss('body { margin: 0; }');
    const before = state.styles;
    const globals = state.globals;
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before[0])).toBe(true);
    expect(() => (before as Array<{ css: string }>)[0]!.css = 'x').toThrow();

    state.upsertStyle('.a', 'color: green;');
    expect(state.styles).not.toBe(before);
    expect(state.styles[1]).toBe(before[1]);
    expect(state.globals).toBe(globals);
    state.undo();
    expect(state.styles).toBe(before);
    expect(state.globals).toBe(globals);
  });

  it('is clean again when the styles come back to what was saved', async () => {
    const state = await loaded();
    state.upsertStyle('.a', 'color: red;');
    await state.save();
    expect(state.dirtyStyles).toBe(false);
    state.upsertStyle('.a', 'color: blue;');
    expect(state.dirtyStyles).toBe(true);
    state.upsertStyle('.a', 'color: red;');
    expect(state.dirtyStyles).toBe(false);
  });
});

describe('BuilderState notices and removals', () => {
  it('drops a notice or an error with the next edit, not before', async () => {
    const state = await loaded('<p>a</p><p>b</p>');
    state.setTree(parse('<p>c</p>').blocks);
    state.status = { kind: 'idle', message: 'Elemento copiato' };
    expect(state.status.message).toBe('Elemento copiato');
    state.select(null);
    expect(state.status.message).toBe('Elemento copiato');
    state.setTree(parse('<p>d</p>').blocks);
    expect(state.status).toEqual({ kind: 'idle', message: '' });
    state.status = { kind: 'error', message: 'Rifiutato' };
    state.upsertStyle('.x', 'color:red');
    expect(state.status).toEqual({ kind: 'idle', message: '' });
  });

  it('moves the selection to a neighbour of a removed element, also from inside it', async () => {
    const state = await loaded('<div><p>a</p><p>b</p></div><p>c</p>');
    const [div, last] = state.tree;
    const [first, second] = (div as { children: Array<{ attrs: { uid: string }; children: Array<{ attrs: { uid: string } }> }> }).children;
    state.select(first!.attrs.uid);
    state.remove(first!.attrs.uid);
    expect(state.selected).toBe(second!.attrs.uid);
    // The selection is inside what goes (the text of the paragraph): it moves too.
    state.select(second!.children[0]!.attrs.uid);
    state.remove(div!.attrs.uid);
    expect(state.selected).toBe(last!.attrs.uid);
    state.remove(last!.attrs.uid);
    expect(state.selected).toBeNull();
  });

  it('leaves the selection alone when something else is removed', async () => {
    const state = await loaded('<p>a</p><p>b</p>');
    const [a, b] = state.tree;
    state.select(a!.attrs.uid);
    state.remove(b!.attrs.uid);
    expect(state.selected).toBe(a!.attrs.uid);
  });
});

describe('BuilderState status', () => {
  it('stops reporting "saved" once the document changes again', async () => {
    const state = await loaded();
    state.setTree(parse('<p>b</p>').blocks);
    await state.save();
    expect(state.status).toEqual({ kind: 'saved', message: 'Salvato in sviluppo: non ancora pubblicato' });
    state.setTree(parse('<p>c</p>').blocks);
    expect(state.status).toEqual({ kind: 'idle', message: '' });
    await state.save();
    expect(state.status.kind).toBe('saved');
    // Typing counts as soon as it starts, and so does the JS panel (which writes the script directly).
    state.deferEdit('css', 250, () => state.upsertStyle('.x', 'color:red'));
    expect(state.status.kind).toBe('idle');
    state.cancelEdit('css');
    state.script = 'console.log(1);';
    expect(state.status.kind).toBe('idle');
  });

  it('keeps other statuses while the document is dirty', async () => {
    const state = await loaded();
    state.setTree(parse('<p>b</p>').blocks);
    state.status = { kind: 'error', message: 'Salvataggio non riuscito: rete' };
    expect(state.status).toEqual({ kind: 'error', message: 'Salvataggio non riuscito: rete' });
  });
});

/** Holds each save call until the test releases it, so edits can be made while it is in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function loadedWithGates(dsl = '<p>a</p>', serverContent?: (sent: string) => string, serverStyles?: (sent: StyleEntry[]) => StyleEntry[]) {
  const state = await loaded(dsl);
  const styles = deferred<void>();
  const document = deferred<void>();
  const api = state.api as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
  const saveStyles = api.saveStyles!;
  const saveDocument = api.saveDocument!;
  api.saveStyles = async (...args) => {
    await styles.promise;
    const saved = (await saveStyles(...args)) as { styles: StyleEntry[] };
    return serverStyles ? { ...saved, styles: serverStyles(saved.styles) } : saved;
  };
  api.saveDocument = async (...args: never[]) => {
    await document.promise;
    const doc = (await saveDocument(...args)) as { content: string };
    return serverContent ? { ...doc, content: serverContent(doc.content) } : doc;
  };
  return { state, styles, document };
}

/** Lets the save continue past the awaits it can already pass. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('BuilderState edits during a save', () => {
  it('keeps tree edits typed while the document is being saved', async () => {
    const { state, document } = await loadedWithGates();
    state.setTree(parse('<p>b</p>').blocks);
    const saving = state.save();
    await settle();
    state.setTree(parse('<p>c</p>').blocks);
    const revision = state.treeRevision;
    document.resolve();
    await saving;
    expect(state.content).toContain('"content":"c"');
    expect(state.treeRevision).toBe(revision);
    expect(state.dirty).toBe(true);
    expect(state.status.kind).toBe('idle');
    // Undoing the late edit returns to what was saved.
    state.undo();
    expect(state.content).toContain('"content":"b"');
    expect(state.dirty).toBe(false);
  });

  it('keeps style edits typed while the styles are being saved', async () => {
    const { state, styles, document } = await loadedWithGates();
    state.upsertStyle('.x', 'color:red');
    const saving = state.save();
    await settle();
    state.upsertStyle('.x', 'color:blue');
    const revision = state.styleRevision;
    styles.resolve();
    document.resolve();
    await saving;
    expect(state.liveCss).toContain('.x{color:blue;}');
    expect(state.styleRevision).toBe(revision);
    expect(state.dirtyStyles).toBe(true);
    state.upsertStyle('.x', 'color:red');
    expect(state.dirtyStyles).toBe(false);
  });

  it('leaves the CSS panel pending edit alone', async () => {
    const { state, styles } = await loadedWithGates();
    state.upsertStyle('.x', 'color:red');
    const saving = state.save();
    await settle();
    state.deferEdit('css', 250, () => state.upsertStyle('.x', 'color:blue'));
    const revision = state.styleRevision;
    styles.resolve();
    await saving;
    expect(state.styleRevision).toBe(revision);
    expect(state.editsPending).toBe(true);
    state.flushEdits();
    expect(state.liveCss).toContain('.x{color:blue;}');
    expect(state.dirty).toBe(true);
  });

  it('sends tree edits made while the styles were being saved', async () => {
    const { state, styles, document } = await loadedWithGates();
    const saveDocument = vi.spyOn(state.api, 'saveDocument');
    state.upsertStyle('.x', 'color:red');
    const saving = state.save();
    await settle();
    state.setTree(parse('<p>b</p>').blocks);
    styles.resolve();
    document.resolve();
    await saving;
    expect(saveDocument.mock.calls[0]?.[1]).toContain('"content":"b"');
    expect(state.dirty).toBe(false);
  });

  it('keeps script edits typed while the document is being saved', async () => {
    const { state, document } = await loadedWithGates();
    state.script = 'a();';
    const saving = state.save();
    await settle();
    state.script = 'b();';
    document.resolve();
    await saving;
    expect(state.script).toBe('b();');
    expect(state.dirtyScript).toBe(true);
  });

  it('keeps schema edits made while the document is being saved', async () => {
    const { state, document } = await loadedWithGates();
    state.setSchema({ props: {} }, 'card');
    const saving = state.save();
    await settle();
    state.setSchema({ props: {} }, 'card-2');
    document.resolve();
    await saving;
    expect(state.ref).toBe('card-2');
    expect(state.dirtyMeta).toBe(true);
  });

  it('shows filtered content only when nothing changed during the save', async () => {
    const filter = (sent: string) => sent.replace('"content":"b"', '"content":"filtered"');
    const first = await loadedWithGates('<p>a</p>', filter);
    first.state.setTree(parse('<p>b</p>').blocks);
    const saving = first.state.save();
    first.document.resolve();
    await saving;
    expect(first.state.content).toContain('"content":"filtered"');
    expect(first.state.dirty).toBe(false);
    expect(first.state.status.message).toContain('filtrati');

    const second = await loadedWithGates('<p>a</p>', filter);
    second.state.setTree(parse('<p>b</p>').blocks);
    const late = second.state.save();
    await settle();
    second.state.setTree(parse('<p>c</p>').blocks);
    second.document.resolve();
    await late;
    expect(second.state.content).toContain('"content":"c"');
    expect(second.state.dirty).toBe(true);
  });

  it('puts what the server filtered under the edits made during the save, and says so', async () => {
    const filter = (sent: string) => sent.replace('"content":"a"', '"content":"a, filtrato"');
    const { state, document } = await loadedWithGates('<p>a</p><p>b</p>', filter);
    state.setTree(reconcileUids(state.tree, parse('<p>a</p><p>b2</p>').blocks), { fromHtml: true });
    const saving = state.save();
    await settle();
    state.setTree(reconcileUids(state.tree, parse('<p>a</p><p>c</p>').blocks), { fromHtml: true });
    document.resolve();
    await saving;
    // The filtered paragraph is shown as stored (not sent again as it was), the late edit stays unsaved.
    expect(state.content).toContain('"content":"a, filtrato"');
    expect(state.content).toContain('"content":"c"');
    expect(state.dirty).toBe(true);
    expect(state.status).toEqual({ kind: 'idle', message: 'Alcuni elementi sono stati filtrati per i tuoi permessi; le modifiche fatte durante il salvataggio non sono ancora salvate.' });
    // Back to what was saved: clean.
    state.setTree(reconcileUids(state.tree, parse('<p>a, filtrato</p><p>b2</p>').blocks), { fromHtml: true });
    expect(state.dirty).toBe(false);
  });

  it('applies a pending panel edit before showing filtered content', async () => {
    const filter = (sent: string) => sent.replace('"content":"a"', '"content":"a, filtrato"');
    const { state, document } = await loadedWithGates('<p>a</p><p>b</p>', filter);
    state.setTree(reconcileUids(state.tree, parse('<p>a</p><p>b2</p>').blocks), { fromHtml: true });
    const saving = state.save();
    await settle();
    state.deferEdit('html', 300, () => state.setTree(reconcileUids(state.tree, parse('<p>a</p><p>c</p>').blocks), { fromHtml: true }));
    document.resolve();
    await saving;
    expect(state.editsPending).toBe(false);
    expect(state.content).toContain('"content":"a, filtrato"');
    expect(state.content).toContain('"content":"c"');
  });

  it('takes the stored version of the style entries not changed during the save', async () => {
    const trim = (sent: StyleEntry[]) => sent.map((e) => ({ ...e, css: e.css.trim() }));
    const { state, styles, document } = await loadedWithGates('<p>a</p>', undefined, trim);
    state.upsertStyle('.x', 'color:red ');
    state.upsertStyle('.y', 'color:green');
    const saving = state.save();
    await settle();
    state.upsertStyle('.y', 'color:blue');
    const revision = state.styleRevision;
    styles.resolve();
    document.resolve();
    await saving;
    expect(state.styles.map((e) => e.css)).toEqual(['color:red', 'color:blue']);
    expect(state.styleRevision).toBe(revision + 1);
    expect(state.dirtyStyles).toBe(true);
    state.upsertStyle('.y', 'color:green');
    expect(state.dirtyStyles).toBe(false);
  });

  it('applies a pending CSS edit before taking the stored styles', async () => {
    const trim = (sent: StyleEntry[]) => sent.map((e) => ({ ...e, css: e.css.trim() }));
    const { state, styles } = await loadedWithGates('<p>a</p>', undefined, trim);
    state.upsertStyle('.x', 'color:red ');
    const saving = state.save();
    await settle();
    state.deferEdit('css', 250, () => state.upsertStyle('.y', 'color:blue'));
    styles.resolve();
    await saving;
    // Before, the stored «.x» was never taken while a panel edit was pending, and the next save sent the old one.
    expect(state.editsPending).toBe(false);
    expect(state.styles.map((e) => [e.selector, e.css])).toEqual([['.x', 'color:red'], ['.y', 'color:blue']]);
    expect(state.dirtyStyles).toBe(true);
  });

  it('saves what was typed in the selector manager just before saving', async () => {
    const state = await loaded();
    const saveStyles = vi.spyOn(state.api, 'saveStyles');
    state.deferEdit('selectors', 250, () => state.upsertStyle('.x', 'color:red'));
    await state.save();
    expect(saveStyles.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ selector: '.x', css: 'color:red' })]);
    expect(state.dirty).toBe(false);
  });
});

describe('copy and paste style (E12)', () => {
  it('pastes the classes and the style attribute of an element on another, in one undo step', async () => {
    const state = await loaded('<p class="lead card__text" style="color: red">a</p><h2 class="x">b</h2><div>c</div>');
    const [p, h2, div] = state.tree as Array<{ attrs: { uid: string } }>;
    expect(state.copyStyle(p!.attrs.uid)).toBe(true);
    expect(state.copiedStyle).toEqual({ class: 'lead card__text', style: 'color: red' });
    state.pasteStyle(h2!.attrs.uid);
    expect(print(state.tree)).toContain('<h2 class="lead card__text" style="color: red">b</h2>');
    state.undo();
    expect(print(state.tree)).toContain('<h2 class="x">b</h2>');

    // From an element with neither: pasting takes them away.
    expect(state.copyStyle(div!.attrs.uid)).toBe(true);
    state.pasteStyle(p!.attrs.uid);
    expect(print(state.tree)).toContain('<p>a</p>');
    // A text node has no style to copy.
    expect(state.copyStyle('nope')).toBe(false);
  });
});

describe('multiple selection (E7)', () => {
  const uids = (state: BuilderState) => (state.tree as Array<{ attrs: { uid: string } }>).map((b) => b.attrs.uid);

  it('adds and removes with Ctrl+click, selects the siblings in between with Shift+click', async () => {
    const state = await loaded('<p class="a">a</p><p class="b">b</p><p class="c">c</p><p class="d">d</p>');
    const [a, b, c, d] = uids(state);
    state.select(a!);
    state.toggleSelect(c!);
    expect(state.selection).toEqual([a, c]);
    state.toggleSelect(a!);
    expect(state.selection).toEqual([c]);
    expect(state.selected).toBe(c);
    state.selectRange(a!);
    expect(new Set(state.selection)).toEqual(new Set([a, b, c]));
    // A plain selection is one element again.
    state.select(d!);
    expect(state.selection).toEqual([d]);
  });

  it('deletes, duplicates, moves and wraps them all, each in one undo step', async () => {
    const state = await loaded('<p class="a">a</p><p class="b">b</p><p class="c">c</p>');
    const [a, , c] = uids(state);
    state.select(a!);
    state.toggleSelect(c!);
    state.duplicateSelection();
    expect(print(state.tree).match(/<p class="a">/g)).toHaveLength(2);
    expect(print(state.tree).match(/<p class="c">/g)).toHaveLength(2);
    expect(state.selection).toHaveLength(2);
    state.undo();
    expect(print(state.tree).match(/<p class="a">/g)).toHaveLength(1);

    state.select(a!);
    state.toggleSelect(c!);
    state.removeSelection();
    expect(print(state.tree).replace(/\s+/g, '')).toBe('<pclass="b">b</p>');
    expect(state.selection).toEqual([]);
    state.undo();

    const [a2, b2, c2] = uids(state);
    state.select(b2!);
    state.toggleSelect(c2!);
    state.wrapSelection('div');
    // Siblings next to each other go into one container.
    expect(print(state.tree).replace(/\s+/g, '')).toBe('<pclass="a">a</p><div><pclass="b">b</p><pclass="c">c</p></div>');
    state.undo();

    state.select(b2!);
    state.toggleSelect(c2!);
    state.moveSelection(-1);
    expect(print(state.tree).replace(/\s+/g, '')).toBe('<pclass="b">b</p><pclass="c">c</p><pclass="a">a</p>');
    expect(uids(state)[2]).toBe(a2);
  });

  it('acts on the outer element when one selected element is inside another', async () => {
    const state = await loaded('<div class="box"><p class="in">x</p></div><p class="out">y</p>');
    const [box] = uids(state);
    const inner = (state.tree[0] as { children: Array<{ attrs: { uid: string } }> }).children[0]!.attrs.uid;
    state.select(box!);
    state.toggleSelect(inner);
    state.removeSelection();
    expect(print(state.tree).replace(/\s+/g, '')).toBe('<pclass="out">y</p>');
  });
});
