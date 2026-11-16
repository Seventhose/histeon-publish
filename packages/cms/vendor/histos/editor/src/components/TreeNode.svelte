<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import ContextMenu from './ContextMenu.svelte';
  import { contentHint, describe, dropCandidates, iconFor, roleName, sectionName, type DropPosition } from '../lib/tree.ts';
  import { holdPointer } from '../lib/pointerHold.ts';
  import { autoLabel } from '../lib/speed.ts';
  import type { Row } from '../lib/structureRows.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import type { KeyedFlags } from '../lib/keyedFlags.svelte.ts';

  // One row of the structure (Structure.svelte draws the rows in view, each at its place in the list).
  let {
    row,
    index,
    top,
    height,
    app,
    marks,
    ontoggle,
    tabbable = false,
  }: {
    row: Row;
    index: number;
    /** The one row Tab reaches (roving tabindex, lista della spesa 144); the arrows move to the others. */
    tabbable?: boolean;
    top: number;
    height: number;
    app: BuilderState;
    marks: Record<'selected' | 'hovered' | 'dragging' | 'matched', KeyedFlags>;
    ontoggle: (open: boolean) => void;
  } = $props();
  const block = $derived(row.block);
  const uid = $derived(block.attrs.uid);
  const selected = $derived(marks.selected.has(uid));
  const expanded = $derived(row.expanded);

  // Automatic BEM label (an h2 in .card reads card__title), and renaming: double click or F2.
  const auto = $derived(autoLabel(block, row.base));
  const nameable = $derived(block.name === 'xb/element' || block.name === 'xb/component');
  let renaming = $state(false);
  let draft = $state('');
  // Rename asked from the canvas's context menu.
  $effect(() => {
    if (app.renameRequest !== uid) return;
    app.renameRequest = null;
    startRename();
  });

  function startRename() {
    if (!nameable) return;
    draft = (block.name === 'xb/element' || block.name === 'xb/component' ? block.attrs.label : undefined) ?? auto ?? '';
    renaming = true;
  }
  function finishRename(save: boolean) {
    if (save) app.setLabel(block.attrs.uid, draft);
    renaming = false;
  }
  const focus = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };

  // Context menu (docs/spec/quick-actions.md §6): right click, the context-menu key or Shift+F10.
  let menu = $state<{ x: number; y: number } | null>(null);
  let nameButton = $state<HTMLButtonElement | null>(null);
  function openMenu(x: number, y: number) {
    // On one of several selected nodes the menu acts on all of them (E7).
    if (!app.selection.includes(block.attrs.uid)) app.select(block.attrs.uid);
    menu = { x, y };
  }
  function closeMenu() {
    menu = null;
    menuView = 'menu';
    nameButton?.focus();
  }
  // The palette asks for this node's menu (U8: «Crea componente dalla selezione…»).
  let menuView = $state<'menu' | 'component'>('menu');
  $effect(() => {
    const request = app.menuRequest;
    if (!request || request.uid !== block.attrs.uid || !nameButton) return;
    app.menuRequest = null;
    const r = nameButton.getBoundingClientRect();
    menuView = request.view;
    openMenu(r.left + 24, r.bottom);
  });

  let hint = $state<DropPosition | null>(null);

  function ondragstart(event: DragEvent) {
    event.stopPropagation();
    event.dataTransfer?.setData('text/plain', block.attrs.uid);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    app.dragging = block.attrs.uid;
  }

  /** Top quarter: before; bottom quarter: after; middle: inside when allowed, else the nearer edge. */
  function position(event: DragEvent): DropPosition | null {
    const row = event.currentTarget as HTMLElement;
    const y = event.clientY - row.getBoundingClientRect().top;
    return dropCandidates(y, row.offsetHeight).find((p) => app.canDrop(block.attrs.uid, p)) ?? null;
  }

  /** The row under a point and where a drop would land on it, or null. */
  function dropAt(x: number, y: number): { uid: string; position: DropPosition } | null {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('nav.structure li[data-uid] > .row');
    const target = row?.parentElement?.dataset.uid;
    if (!row || !target) return null;
    const r = row.getBoundingClientRect();
    const position = dropCandidates(y - r.top, r.height).find((p) => app.canDrop(target, p));
    return position ? { uid: target, position } : null;
  }

  // Touch and pen (L3): most mobile browsers have no HTML5 drag and drop. The row's icon is a grip that drags with
  // pointer events instead (lib/pointerHold.ts): the row under the finger shows where it lands, the list scrolls
  // near its edges, Esc or a cancelled touch leaves everything as it was. The mouse keeps the native drag.
  function startTouchDrag(event: PointerEvent) {
    if (event.pointerType === 'mouse' || renaming) return;
    event.preventDefault();
    event.stopPropagation();
    const from = block.attrs.uid;
    const nav = (event.currentTarget as HTMLElement).closest<HTMLElement>('nav.structure');
    let target: { uid: string; position: DropPosition } | null = null;
    const stop = () => {
      app.dropHint = null;
      app.dragging = null;
    };
    app.dragging = from;
    holdPointer(
      event,
      {
        cursor: 'grabbing',
        move: (e) => {
          if (nav) {
            const box = nav.getBoundingClientRect();
            if (e.clientY < box.top + 28) nav.scrollTop -= 14;
            else if (e.clientY > box.bottom - 28) nav.scrollTop += 14;
          }
          target = dropAt(e.clientX, e.clientY);
          app.dropHint = target;
        },
        end: () => {
          const drop = target;
          stop();
          if (drop) app.moveTo(from, drop.uid, drop.position);
        },
        cancel: stop,
      },
      event.currentTarget as HTMLElement,
    );
  }
  const touchHint = $derived(app.dropHint?.uid === uid ? app.dropHint.position : null);

  function ondragover(event: DragEvent) {
    hint = position(event);
    if (hint) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    const where = position(event);
    if (where && app.dragging) app.moveTo(app.dragging, block.attrs.uid, where);
    hint = null;
    app.dragging = null;
  }
  // What the node is, in words ("Titolo H1", "Scheda"); the selector follows, small.
  const role = $derived(roleName(block));
  // A section or a box takes the name of its first heading, open or closed (E4): «I giusti», then «Sezione».
  const heading = $derived(sectionName(block));
  // A few words of the most important text inside (a heading first), so a row is recognisable without opening it.
  const textHint = $derived.by(() => {
    const hint = contentHint(block, expanded);
    return hint && hint !== heading ? hint : null;
  });
</script>

<li
  role="treeitem"
  aria-selected={selected}
  aria-expanded={row.expandable ? expanded : undefined}
  aria-level={row.depth + 1}
  aria-posinset={row.position}
  aria-setsize={row.siblings}
  data-index={index}
  data-key={row.key}
  data-uid={uid}
  style:top="{top}px"
  style:height="{height}px"
>
  <div
    class="row"
    class:selected
    class:hovered={marks.hovered.has(uid)}
    class:matched={marks.matched.has(uid)}
    class:drop-before={hint === 'before' || touchHint === 'before'}
    class:drop-after={hint === 'after' || touchHint === 'after'}
    class:drop-inside={hint === 'inside' || touchHint === 'inside'}
    class:dragging={marks.dragging.has(uid)}
    style:padding-left="{8 + row.depth * 14}px"
    draggable="true"
    {ondragstart}
    {ondragover}
    ondragleave={() => (hint = null)}
    oncontextmenu={(e) => {
      // The whole row, not only the name: right click anywhere on it opens the node's menu.
      if (renaming) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    }}
    {ondrop}
    ondragend={() => {
      hint = null;
      app.dragging = null;
    }}
    role="presentation"
  >
    {#if row.expandable}
      <button class="toggle" tabindex="-1" aria-label={expanded ? t('Comprimi') : t('Espandi')} onclick={() => ontoggle(!expanded)}>{expanded ? '▾' : '▸'}</button>
    {:else}
      <span class="toggle"></span>
    {/if}
    {#if renaming}
      <input
        class="rename"
        bind:value={draft}
        use:focus
        aria-label={t('Etichetta di {0}', describe(block))}
        placeholder={t('Etichetta (vuota: automatica)')}
        onkeydown={(e) => {
          if (e.key === 'Enter') finishRename(true);
          else if (e.key === 'Escape') finishRename(false);
          e.stopPropagation();
        }}
        onblur={() => finishRename(true)}
      />
    {:else}
      <button
        class="name"
        tabindex={tabbable ? 0 : -1}
        bind:this={nameButton}
        onclick={(e) => (e.ctrlKey || e.metaKey ? app.toggleSelect(block.attrs.uid) : e.shiftKey ? app.selectRange(block.attrs.uid) : app.select(block.attrs.uid))}
        ondblclick={() => (block.name === 'xb/component' ? void app.openComponent(block.attrs.ref) : startRename())}
        onkeydown={(e) => {
          if (e.key === 'F2') {
            e.preventDefault();
            startRename();
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left + 24, r.bottom);
          }
        }}
        aria-haspopup="menu"
        onmouseenter={() => (app.hovered = block.attrs.uid)}
        onmouseleave={() => (app.hovered = null)}
        title={[(heading ? `${heading} — ` : '') + [role, describe(block)].filter(Boolean).join(' · ') + (textHint ? ` — “${textHint}”` : ''), block.name === 'xb/component' ? t('Doppio clic per modificare il componente, F2 per rinominare') : nameable ? t('Doppio clic o F2 per rinominare') : ''].filter(Boolean).join('\n') || undefined}
        aria-label={describe(block)}
        aria-describedby={role || heading || textHint ? `xb-tree-desc-${block.attrs.uid}` : undefined}
      >
        <!-- The words first, what the node is after them, small (E4). -->
        <span class="icon" aria-hidden="true" onpointerdown={startTouchDrag}>{iconFor(block)}</span>{#if heading}<span class="heading" aria-hidden="true">{heading}</span>{/if}{#if textHint}<span class="text-hint" aria-hidden="true">“{textHint}”</span>{/if}{#if role}<span class="role" class:small={!!(heading || textHint)} aria-hidden="true">{role}</span>{/if}<span class="tech" class:quiet={!!role} class:words={block.name === 'xb/text'} class:named={!role && 'label' in block.attrs && !!block.attrs.label}>{describe(block)}</span>{#if auto}<span class="auto" aria-hidden="true" title={t('Etichetta automatica BEM: diventa la classe con «Classi BEM»')}>{auto}</span>{/if}
        {#if role || heading || textHint}<span class="sr" id="xb-tree-desc-{block.attrs.uid}">{[role, heading, textHint].filter(Boolean).join(', ')}</span>{/if}
      </button>
    {/if}
    {#if menu}
      <ContextMenu {app} uid={block.attrs.uid} x={menu.x} y={menu.y} start={menuView} onclose={closeMenu} onrename={() => ((menu = null), startRename())} />
    {/if}
  </div>
</li>

<style>
  li {
    list-style: none;
    position: absolute;
    left: 0;
    right: 0;
  }
  .row {
    height: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--xb-r-sm);
  }
  .row.hovered {
    background: var(--xb-hover);
  }
  /* A result of the structure's search (E8). */
  .row.matched {
    box-shadow: inset 3px 0 0 var(--xb-accent);
  }
  .row.selected {
    background: var(--xb-accent-bg);
  }
  .row.dragging {
    opacity: 0.4;
  }
  .row.drop-before {
    box-shadow: inset 0 2px 0 var(--xb-accent);
  }
  .row.drop-after {
    box-shadow: inset 0 -2px 0 var(--xb-accent);
  }
  .row.drop-inside {
    outline: 1px dashed var(--xb-accent);
    outline-offset: -1px;
  }
  .toggle {
    /* WCAG 2.5.8: a target of at least 24×24 px (the arrow stays small, the area around it is clickable). */
    width: 24px;
    min-height: 24px;
    display: inline-grid;
    place-items: center;
    padding: 0;
    flex: none;
    background: none;
    border: 0;
    color: var(--xb-muted);
    cursor: pointer;
    padding: 0;
    font-size: 11px;
  }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    text-align: left;
    background: none;
    border: 0;
    color: var(--xb-text);
    font: 13px/1.3 var(--xb-sans);
    padding: 4px 4px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .name > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .role {
    flex: none;
    max-width: 60%;
    font-weight: 600;
  }
  .role.small {
    flex: 0 2 auto;
    min-width: 0;
    font-size: 11px;
    font-weight: 400;
    color: var(--xb-muted);
  }
  .heading {
    flex: 0 1 auto;
    min-width: 4ch;
    font-weight: 600;
  }
  .text-hint {
    flex: 0 1 auto;
    min-width: 2ch;
    color: var(--xb-text);
    opacity: 0.8;
  }
  .tech {
    flex: 0 1 auto;
    min-width: 3ch;
    font: 12px var(--xb-mono);
  }
  .tech.quiet {
    flex: 0 100 auto;
    min-width: 0;
    font-size: 11px;
    color: var(--xb-muted);
  }
  /* A text, or a name given by hand: words, not code. */
  .tech.words {
    font: 13px var(--xb-sans);
  }
  .tech.named {
    font: 600 13px var(--xb-sans);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .auto {
    flex: none;
    color: var(--xb-muted);
    font-style: italic;
  }
  .rename {
    flex: 1;
    min-width: 0;
    font: 12.5px var(--xb-mono);
    padding: 3px 4px;
    border: 1px solid var(--xb-accent);
    border-radius: var(--xb-r-sm);
    background: var(--xb-bg);
    color: var(--xb-text);
  }
  .icon {
    /* The grip for touch and pen (L3): pressing it drags the row instead of scrolling the list. */
    touch-action: none;
    flex: none;
    display: inline-block;
    width: 16px;
    text-align: center;
    color: var(--xb-muted);
    font: 11px var(--xb-mono);
  }
</style>
