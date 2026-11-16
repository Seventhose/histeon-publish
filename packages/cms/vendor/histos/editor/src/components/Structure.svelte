<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { keyHint } from '../lib/keys.svelte.ts';
  import { tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import TreeNode from './TreeNode.svelte';
  import { KeyedFlags } from '../lib/keyedFlags.svelte.ts';
  import { openByDefault, rowWindow, visibleRows } from '../lib/structureRows.ts';
  import { searchTree } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  let { app }: { app: BuilderState } = $props();

  /** Every row has the same height: the panel knows where each one is without drawing it. */
  const ROW = 26;

  // Opened or closed by hand (the rest follows openByDefault). Ancestors of the selection open, so selecting in the
  // canvas reveals the node.
  const opened = new SvelteMap<string, boolean>();
  $effect(() => {
    if (app.selected) for (const uid of app.path(app.selected)) opened.set(uid, true);
  });
  const rows = $derived(visibleRows(app.tree, (block, depth) => opened.get(block.attrs.uid) ?? openByDefault(block, depth)));
  // One Tab stop for the whole tree (lista della spesa 144): the selected row, or the first. The arrows do the rest.
  const tabStop = $derived(Math.max(0, rows.findIndex((r) => app.selection.includes(r.block.attrs.uid))));
  function toggle(uid: string, open: boolean) {
    opened.set(uid, open);
  }

  // Each row reads only its own flags: on a page of thousands of elements a click or a hover updates the rows
  // concerned, not every row.
  const marks = { selected: new KeyedFlags(), hovered: new KeyedFlags(), dragging: new KeyedFlags(), matched: new KeyedFlags() };

  // Search (E8): by words, tag, class, id, name or role; the results are marked and their branches open, Enter
  // and Shift+Enter (or the arrows) select the next and the previous one.
  let query = $state('');
  const matches = $derived(searchTree(app.tree, query));
  const at = $derived(app.selected ? matches.indexOf(app.selected) : -1);
  $effect(() => marks.matched.set(matches));
  $effect(() => {
    for (const uid of matches.slice(0, 200)) for (const up of app.path(uid).slice(0, -1)) opened.set(up, true);
  });
  function step(delta: 1 | -1) {
    if (!matches.length) return;
    const next = at === -1 ? (delta === 1 ? 0 : matches.length - 1) : (at + delta + matches.length) % matches.length;
    app.select(matches[next]!);
  }
  $effect(() => marks.selected.set(app.selection));
  $effect(() => marks.hovered.set(app.hovered ? [app.hovered] : []));
  $effect(() => marks.dragging.set(app.dragging ? [app.dragging] : []));
  // A row is dragged natively: the browser sends this window no pointer events until the drop. One with the button
  // up, or a new press, means the drag ended without a dragend; nothing may stay marked as dragged. (The canvas's
  // grip drags inside the preview's own document, which this window does not hear.)
  $effect(() => {
    if (!app.dragging) return;
    const stale = (event: PointerEvent) => {
      if (event.type === 'pointerdown' || (event.buttons & 1) === 0) app.dragging = null;
    };
    window.addEventListener('pointermove', stale, true);
    window.addEventListener('pointerdown', stale, true);
    return () => {
      window.removeEventListener('pointermove', stale, true);
      window.removeEventListener('pointerdown', stale, true);
    };
  });

  // Only the rows in view are drawn on a large page; the row being dragged and the one with the focus stay drawn
  // while the list scrolls, so a drag still ends and the keyboard does not lose its place.
  let nav = $state<HTMLElement>();
  let scrollTop = $state(0);
  let height = $state(0);
  let focused = $state<string | null>(null);
  const shown = $derived.by(() => {
    const [first, last] = rowWindow(rows.length, scrollTop, height, ROW);
    const keep = new Set<number>();
    for (let i = first; i < last; i++) keep.add(i);
    rows.forEach((row, i) => {
      if (row.key === focused || row.key === app.dragging) keep.add(i);
    });
    const indices = [...keep].sort((a, b) => a - b);
    // The rows' flags exist before the rows read them (keyedFlags.svelte.ts).
    for (const i of indices) for (const flags of Object.values(marks)) flags.ensure(rows[i]!.block.attrs.uid);
    return indices;
  });

  /** Scrolls the panel so the row is in view (nearest edge), then waits for it to be drawn. */
  async function reveal(index: number): Promise<void> {
    if (!nav) return;
    const top = index * ROW;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + ROW > nav.scrollTop + nav.clientHeight) nav.scrollTop = top + ROW - nav.clientHeight;
    scrollTop = nav.scrollTop;
    await tick();
  }

  // A selection made elsewhere (canvas, code, palette) shows its row.
  $effect(() => {
    const uid = app.selected;
    if (!uid || !nav) return;
    const index = rows.findIndex((r) => r.block.attrs.uid === uid);
    if (index >= 0 && (index * ROW < nav.scrollTop || (index + 1) * ROW > nav.scrollTop + nav.clientHeight)) void reveal(index);
  });

  // The focus was on a row that went away (Delete): it moves to the row selected instead, so the keyboard goes on
  // from there. A focus that left for elsewhere (the canvas, a panel) is not taken back.
  let focusInTree = false;
  $effect(() => {
    const uid = app.selected;
    if (!uid || !focusInTree || (document.activeElement && document.activeElement !== document.body)) return;
    const index = rows.findIndex((r) => r.block.attrs.uid === uid);
    if (index >= 0) void focusRow(index);
  });

  async function focusRow(index: number): Promise<void> {
    if (index < 0 || index >= rows.length) return;
    await reveal(index);
    nav?.querySelector<HTMLButtonElement>(`li[data-index="${index}"] > .row > button.name`)?.focus();
  }

  // Keyboard of the tree (WAI-ARIA tree pattern): arrows move between the visible items, right and left open and
  // close a branch (or go to its first child / its parent), Home and End jump. Enter and Space select (buttons).
  function onkeydown(e: KeyboardEvent): void {
    const current = e.target as HTMLElement;
    if (!current.classList.contains('name') || e.altKey || e.ctrlKey || e.metaKey) return;
    const index = Number(current.closest('li')?.dataset.index ?? -1);
    const row = rows[index];
    if (!row) return;
    if (e.key === 'ArrowDown') void focusRow(index + 1);
    else if (e.key === 'ArrowUp') void focusRow(index - 1);
    else if (e.key === 'Home') void focusRow(0);
    else if (e.key === 'End') void focusRow(rows.length - 1);
    else if (e.key === 'ArrowRight') {
      if (row.expandable && !row.expanded) toggle(row.block.attrs.uid, true);
      else if (row.expanded) void focusRow(index + 1);
    } else if (e.key === 'ArrowLeft') {
      if (row.expanded) toggle(row.block.attrs.uid, false);
      else void focusRow(row.parent);
    } else return;
    e.preventDefault();
  }
</script>

<div class="structure-wrap">
  {#if app.tree.length > 0}
    <form class="search" role="search" onsubmit={(e) => e.preventDefault()}>
      <input
        type="search"
        bind:value={query}
        placeholder={t('Cerca nella struttura')}
        aria-label={t('Cerca nella struttura')}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape' && query) {
            e.preventDefault();
            e.stopPropagation();
            query = '';
          }
        }}
      />
      {#if query.trim()}
        <span class="count" role="status">{matches.length ? t('{0} di {1}', at + 1 || '–', matches.length) : t('nessuno')}</span>
        <button type="button" onclick={() => step(-1)} disabled={!matches.length} aria-label={t('Risultato precedente')}>↑</button>
        <button type="button" onclick={() => step(1)} disabled={!matches.length} aria-label={t('Risultato successivo')}>↓</button>
      {/if}
    </form>
  {/if}
<nav
  class="structure"
  aria-label={t('Struttura')}
  bind:this={nav}
  bind:clientHeight={height}
  onscroll={() => nav && (scrollTop = nav.scrollTop)}
  onfocusin={(e) => {
    focused = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]')?.dataset.key ?? null;
    focusInTree = true;
  }}
  onfocusout={(e) => {
    focused = null;
    // Going somewhere else ends it; a row removed under the focus has nowhere to go.
    if (e.relatedTarget) focusInTree = nav?.contains(e.relatedTarget as Node) ?? false;
  }}
>
  {#if app.tree.length === 0}
    <p class="empty">{keyHint('insert') ? t('La pagina è vuota: aggiungi un elemento con + ({0}) o scrivilo nel pannello HTML.', keyHint('insert')) : t('La pagina è vuota: aggiungi un elemento con + o scrivilo nel pannello HTML.')}</p>
  {:else}
    <ul role="tree" aria-label={t('Elementi della pagina')} {onkeydown} style:height="{rows.length * ROW}px">
      {#each shown as index (rows[index]!.key)}
        {@const row = rows[index]!}
        <TreeNode {row} {index} top={index * ROW} height={ROW} {app} {marks} tabbable={index === tabStop} ontoggle={(open) => toggle(row.block.attrs.uid, open)} />
      {/each}
    </ul>
  {/if}
</nav>
</div>

<style>
  .structure-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .structure {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 6px 24px;
  }
  ul {
    position: relative;
    margin: 0;
    padding: 0;
  }
  .search {
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 6px;
    background: var(--xb-panel);
    border-bottom: 1px solid var(--xb-line);
  }
  .search input {
    flex: 1;
    min-width: 0;
    font: 12.5px var(--xb-sans);
    padding: 4px 8px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: var(--xb-bg);
    color: var(--xb-text);
  }
  .search .count {
    font-size: 11px;
    color: var(--xb-muted);
    white-space: nowrap;
  }
  .search button {
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: transparent;
    color: var(--xb-text);
    padding: 1px 6px;
    cursor: pointer;
  }
  .empty {
    color: var(--xb-muted);
    font-size: 13px;
    padding: 0 8px;
  }
</style>
