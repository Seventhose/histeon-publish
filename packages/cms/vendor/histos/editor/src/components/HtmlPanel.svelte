<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { tick, untrack } from 'svelte';
  import { childrenOf, nodeAt, parse, printWithMap, reconcileUids, roundTrips, XbSyntaxError, type SourceMap, type XbBlock } from '@xb/dsl';
  import type { Diagnostic } from '@codemirror/lint';
  import CodeEditor from './CodeEditor.svelte';
  import { classSource, expressionSource } from '../lib/completions.ts';
  import { classInfo } from '../lib/classPreview.ts';
  import { describe, findBlock, replaceBlock, scopeFor, staticClasses, staticId } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The code of the selected element (the whole page when nothing is selected), as in the bottom panels of
  // code-first builders: short, focused, and what you edit is what you selected.
  // `visible`: false while the panel cannot be seen (another panel maximized, its area hidden or covered by a
  // section): then it does not reprint after every edit, and catches up when it shows again (V4).
  let { app, visible = true }: { app: BuilderState; visible?: boolean } = $props();

  let text = $state('');
  let diagnostics = $state<Diagnostic[]>([]);
  /** Node ranges, valid only while the text is exactly the canonical print of the scope. */
  let map: SourceMap = new Map();
  /** The node shown (null: the whole page). Follows the selection, except while it changes from here. */
  let scope = $state<string | null>(null);
  /**
   * False when the printed code would not read back as the same structure (content written outside XB that
   * the DSL cannot represent faithfully). Editing it would save a different document with this user's
   * privileges, so the panel is read-only until the content is fixed from the other panels.
   */
  let faithful = $state(true);
  // What a class does, for utility-class frameworks (Core Framework, Automatic.css). Histeon CSS is written with
  // variables and BEM classes: no preview there.
  const canvasDoc = () => document.querySelector<HTMLIFrameElement>('iframe[data-xb-canvas]')?.contentDocument ?? null;
  const describeClass = (name: string) => (app.framework.active.id === 'xb-tokens' ? null : classInfo(canvasDoc(), name));
  const completions = [classSource(() => app.framework.classes, describeClass), expressionSource(() => app.extensions)];
  $effect(() => void app.loadExtensions());

  const scopeLabel = $derived.by(() => {
    const block = scope ? app.find(scope) : null;
    return block ? describe(block) : t('pagina intera');
  });

  // A new selection from the canvas, the structure or the palette: show that element.
  $effect(() => {
    const selected = app.selected;
    if (untrack(() => app.selectionSource) === 'html') return;
    scope = scopeFor(untrack(() => app.index), selected);
  });

  function blocksInScope(tree: XbBlock[]): XbBlock[] {
    const block = scope ? findBlock(tree, scope) : null;
    return block ? [block] : tree;
  }

  /**
   * What the text was last printed from (the scope's block, or the page's tree: both frozen, so the same object is
   * the same content) and that text: an edit elsewhere that left the shown code as it was needs no reprint.
   */
  let printedFrom: object | null = null;
  let printedText = '';
  /** Whether the code of a frozen tree or block reads back as the same structure (roundTrips), by identity. */
  const faithfulOf = new WeakMap<object, boolean>();
  function checkFaithful(key: object, blocks: XbBlock[]): boolean {
    if (!Object.isFrozen(key)) return roundTrips(blocks);
    let known = faithfulOf.get(key);
    if (known === undefined) faithfulOf.set(key, (known = roundTrips(blocks)));
    return known;
  }

  // Reprint when the scope or the tree changes elsewhere (load, undo, structure edits): never while typing.
  $effect(() => {
    void app.treeRevision;
    void scope;
    if (!visible) {
      printedFrom = null;
      return;
    }
    const block = untrack(() => (scope ? app.find(scope) : null));
    const key: object = block ?? untrack(() => app.tree);
    if (key === printedFrom && untrack(() => text) === printedText) return;
    app.cancelEdit('html');
    const blocks = block ? [block] : untrack(() => app.tree);
    try {
      const printed = printWithMap(blocks);
      text = printed.text;
      map = printed.map;
      faithful = checkFaithful(key, blocks);
      printedFrom = key;
      printedText = printed.text;
    } catch {
      text = '';
      map = new Map();
      faithful = false;
      printedFrom = null;
    }
    diagnostics = [];
  });

  // Text written in the canvas that only the code can take: shown here as typed, then applied (or refused) as if
  // typed here, so it counts as unsaved until it is fixed.
  $effect(() => {
    const draft = app.htmlDraft;
    if (!draft) return;
    untrack(() => {
      app.htmlDraft = null;
      scope = draft.uid;
      app.select(draft.uid, 'html');
      void tick().then(() => onchange(draft.code));
    });
  });

  /** The line (from 1) of an offset in the text. */
  const lineAt = (value: string, offset: number) => value.slice(0, offset).split('\n').length;

  /** The cursor shows where it is in the canvas, without changing what the panel shows. */
  function oncursor(offset: number) {
    const uid = nodeAt(map, offset);
    if (uid) app.hovered = uid;
  }

  /** Ctrl/Cmd+click or F12 on a class (or id) in the code: its element is selected and the CSS panel opens on it. */
  function ondefinition(doc: string, offset: number): boolean {
    for (const m of doc.matchAll(/\b(class|id)="([^"]*)"/g)) {
      const start = (m.index ?? 0) + m[1]!.length + 2;
      const value = m[2] ?? '';
      if (offset < start || offset > start + value.length) continue;
      const at = offset - start;
      const from = value.lastIndexOf(' ', at - 1) + 1;
      const to = value.indexOf(' ', at) === -1 ? value.length : value.indexOf(' ', at);
      const token = value.slice(from, to);
      if (!/^[_a-zA-Z][\w-]*$/.test(token)) return false;
      // Selected from the code: the panel keeps showing what it shows.
      // The map is the last print's; right after typing it may be behind: then the first element with the class.
      const owner = (list: XbBlock[]): string | null => {
        for (const b of list) {
          if (b.name === 'xb/element' && (m[1] === 'id' ? staticId(b) === token : staticClasses(b).includes(token))) return b.attrs.uid;
          const inner = owner(childrenOf(b));
          if (inner) return inner;
        }
        return null;
      };
      const mapped = nodeAt(map, offset);
      const block = mapped ? app.find(mapped) : null;
      const uid = block && (m[1] === 'id' ? staticId(block) === token : staticClasses(block).includes(token)) ? mapped : owner(app.tree);
      if (uid) app.select(uid, 'html');
      app.cssRequest = `${m[1] === 'id' ? '#' : '.'}${token}`;
      return true;
    }
    return false;
  }

  function onchange(value: string) {
    text = value;
    map = new Map();
    app.deferEdit('html', 300, () => apply(value));
  }

  function apply(value: string) {
    if (!faithful) return;
    try {
      const { blocks, warnings } = parse(value);
      const tree = app.tree;
      const current = scope ? findBlock(tree, scope) : null;
      let next: XbBlock[];
      if (current && scope) {
        if (blocks.length === 0) {
          diagnostics = [{ from: 0, to: Math.min(1, value.length), severity: 'error', message: t('Il codice dell’elemento è vuoto: per eliminarlo usa la struttura o il tasto Canc.') }];
          app.reject('html', t('Codice HTML vuoto'));
          return;
        }
        const reconciled = reconcileUids([current], blocks);
        next = replaceBlock(tree, scope, reconciled);
        const first = reconciled[0]?.attrs.uid ?? null;
        if (first && first !== scope) {
          scope = first;
          app.select(first, 'html');
        }
      } else {
        next = reconcileUids(tree, blocks);
      }
      app.setTree(next, { fromHtml: true });
      // If the author's text happens to be canonical, the map is usable again.
      const printed = printWithMap(blocksInScope(next));
      if (printed.text === value) map = printed.map;
      diagnostics = warnings.map((w) => ({ from: w.offset, to: w.offset + 4, severity: 'warning', message: w.message }));
    } catch (e) {
      if (!(e instanceof XbSyntaxError)) throw e;
      diagnostics = [{ from: e.offset, to: e.offset + 1, severity: 'error', message: e.message }];
      app.reject('html', t('HTML non valido alla riga {0}', lineAt(value, e.offset)));
    }
  }

  function showPage() {
    scope = null;
    app.select(null);
  }
</script>

<div class="panel">
  <div class="scope">
    <span class="what" title={t('Cosa mostra il codice')}>{scopeLabel}</span>
    {#if scope}<button onclick={showPage} title={t('Mostra il codice di tutta la pagina')}>{t('Pagina intera')}</button>{/if}
  </div>
  {#if !faithful}
    <p class="problem" role="status">{t('Questo elemento contiene contenuto scritto fuori da Histeon che il codice non può rappresentare fedelmente: il codice è in sola lettura. Correggilo dalla struttura o dalle proprietà.')}</p>
  {:else if diagnostics.some((d) => d.severity === 'error')}
    <p class="problem" role="status">{t("{0} — l'anteprima mostra l'ultima versione valida.", diagnostics[0]?.message ?? '')}</p>
  {/if}
  <CodeEditor value={text} language="html" {onchange} {diagnostics} {oncursor} {completions} {ondefinition} emmet readOnly={!faithful} label={t('Codice HTML')} />
</div>

<style>
  .panel {
    display: grid;
    grid-template-rows: auto auto 1fr;
    height: 100%;
    min-height: 0;
  }
  .scope {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    font: 12px var(--xb-mono);
    color: var(--xb-muted);
    border-bottom: 1px solid var(--xb-line);
    min-width: 0;
  }
  .what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scope button {
    font: 11px var(--xb-sans);
    padding: 2px 8px;
    border-radius: var(--xb-r-sm);
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
  }
  .problem {
    margin: 0;
    padding: 6px 12px;
    background: var(--xb-danger-bg);
    color: var(--xb-danger);
    font-size: 12px;
  }
</style>
