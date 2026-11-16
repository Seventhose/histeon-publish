<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { tick, type Snippet } from 'svelte';
  import { AREA_TITLES, type Area, type PanelId } from '../lib/layout.ts';

  // A movable panel: its header is the drag handle (or use the ⋯ menu from the keyboard), and it can be
  // collapsed to its header or maximized within its area.
  type Action = { kind: 'move'; area: Area } | { kind: 'shift'; delta: -1 | 1 } | { kind: 'collapse' } | { kind: 'maximize' } | { kind: 'reset' };
  let {
    id,
    title,
    area,
    collapsed,
    maximized,
    canMaximize,
    first,
    last,
    badge = '',
    tools,
    children,
    onaction,
    ondragstart,
    ondragend,
    ontouchdrag,
  }: {
    id: PanelId;
    title: string;
    area: Area;
    collapsed: boolean;
    maximized: boolean;
    canMaximize: boolean;
    first: boolean;
    last: boolean;
    badge?: string;
    tools?: Snippet;
    children: Snippet;
    onaction: (action: Action) => void;
    ondragstart: (id: PanelId) => void;
    ondragend: () => void;
    /** A drag by touch or pen from the grip (L3): pointer events, since HTML5 drag and drop is mouse-only there. */
    ontouchdrag?: (id: PanelId, event: PointerEvent) => void;
  } = $props();

  let menuOpen = $state(false);
  let menu = $state<HTMLElement | null>(null);
  let toggle = $state<HTMLButtonElement | null>(null);

  // WAI-ARIA menu: on opening the focus goes to the first item; arrows, Home and End move between the items.
  async function openMenu() {
    menuOpen = !menuOpen;
    if (!menuOpen) return;
    await tick();
    menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }
  function menuKeys(event: KeyboardEvent) {
    const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (go === undefined) {
      if (event.key === 'Tab') menuOpen = false;
      return;
    }
    event.preventDefault();
    items[(go + items.length) % items.length]?.focus();
  }
  const horizontal = $derived(area === 'bottom');

  function choose(action: Action) {
    menuOpen = false;
    onaction(action);
  }

  function startDrag(event: DragEvent) {
    if (!event.dataTransfer || event.defaultPrevented) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-xb-panel', id);
    ondragstart(id);
  }

  $effect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => {
      if (!menu?.contains(event.target as Node)) menuOpen = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        menuOpen = false;
        toggle?.focus();
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key, true);
    };
  });
</script>

<section class="panel" class:collapsed class:horizontal data-panel={id} aria-label={title}>
  <header role="group" aria-label={t("{0}: trascina l'intestazione per spostare il pannello", title)} draggable="true" ondragstart={startDrag} {ondragend} title={t('Trascina per spostare il pannello')}>
    <span class="grip" aria-hidden="true" onpointerdown={(e) => e.pointerType !== 'mouse' && ontouchdrag?.(id, e)}>⠿</span>
    <h2>{title}{badge}</h2>
    {#if tools && !collapsed}<span class="tools">{@render tools()}</span>{/if}
    <span class="actions">
      {#if canMaximize && !collapsed}
        <button onclick={() => onaction({ kind: 'maximize' })} title={maximized ? t('Riduci') : t('Allarga')} aria-label={maximized ? t('Riduci {0}', title) : t('Allarga {0}', title)}>{maximized ? '⤡' : '⤢'}</button>
      {/if}
      <button onclick={() => onaction({ kind: 'collapse' })} title={collapsed ? t('Espandi') : t('Comprimi')} aria-label={collapsed ? t('Espandi {0}', title) : t('Comprimi {0}', title)} aria-expanded={!collapsed}>{collapsed ? '▸' : '▾'}</button>
      <span class="menu" bind:this={menu}>
        <button bind:this={toggle} onclick={openMenu} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('Sposta {0}', title)} title={t('Sposta il pannello')}>⋯</button>
        {#if menuOpen}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <ul role="menu" aria-label={t('Sposta {0}', title)} onkeydown={menuKeys}>
            {#each Object.entries(AREA_TITLES) as [target, label] (target)}
              {#if target !== area}<li><button role="menuitem" onclick={() => choose({ kind: 'move', area: target as Area })}>{t('Sposta {0}', label)}</button></li>{/if}
            {/each}
            {#if !first}<li><button role="menuitem" onclick={() => choose({ kind: 'shift', delta: -1 })}>{horizontal ? t('Sposta a sinistra') : t('Sposta su')}</button></li>{/if}
            {#if !last}<li><button role="menuitem" onclick={() => choose({ kind: 'shift', delta: 1 })}>{horizontal ? t('Sposta a destra') : t('Sposta giù')}</button></li>{/if}
            <li class="sep"><button role="menuitem" onclick={() => choose({ kind: 'reset' })}>{t('Ripristina la disposizione')}</button></li>
          </ul>
        {/if}
      </span>
    </span>
  </header>
  {#if !collapsed}<div class="body">{@render children()}</div>{/if}
</section>

<style>
  .panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background: var(--xb-panel);
  }
  .panel.collapsed {
    grid-template-rows: auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 6px 0 4px;
    border-bottom: 1px solid var(--xb-line);
    cursor: grab;
    user-select: none;
    min-width: 0;
  }
  header:active {
    cursor: grabbing;
  }
  .grip {
    touch-action: none;
    color: var(--xb-muted);
    opacity: 0.5;
    font-size: 12px;
    width: 12px;
    text-align: center;
  }
  header:hover .grip {
    opacity: 1;
  }
  /* A finger needs a bigger grip (L3). */
  @media (pointer: coarse) {
    .grip {
      width: 24px;
      font-size: 16px;
      opacity: 1;
    }
  }
  h2 {
    margin: 0;
    font: 600 11px var(--xb-sans);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--xb-muted);
    white-space: nowrap;
  }
  .tools {
    display: flex;
    gap: 4px;
    min-width: 0;
  }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .actions > button,
  .menu > button,
  .tools :global(button) {
    border: 0;
    background: transparent;
    color: var(--xb-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    width: 24px;
    height: 24px;
    border-radius: var(--xb-r-sm);
  }
  .actions > button:hover,
  .menu > button:hover,
  .tools :global(button:hover) {
    background: var(--xb-hover);
    color: var(--xb-text);
  }
  .actions > button:focus-visible,
  .menu > button:focus-visible,
  .tools :global(button:focus-visible) {
    outline: 2px solid var(--xb-accent);
    outline-offset: -2px;
  }
  .menu {
    position: relative;
  }
  ul {
    position: absolute;
    right: 0;
    top: 26px;
    z-index: 30;
    margin: 0;
    padding: 4px;
    list-style: none;
    min-width: 190px;
    width: max-content;
    max-width: min(320px, 90vw);
    background: var(--xb-bg);
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r);
    box-shadow: var(--xb-shadow);
  }
  ul button {
    display: block;
    width: 100%;
    height: auto;
    line-height: 1.35;
    white-space: nowrap;
    text-align: left;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--xb-r-sm);
    background: transparent;
    color: var(--xb-text);
    font: 13px var(--xb-sans);
    cursor: pointer;
  }
  ul button:hover,
  ul button:focus-visible {
    background: var(--xb-accent-bg);
    outline: none;
  }
  .sep {
    border-top: 1px solid var(--xb-line);
    margin-top: 4px;
    padding-top: 4px;
  }
  .body {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  /* In the bottom area a collapsed panel becomes a narrow vertical tab. */
  .panel.horizontal.collapsed header {
    flex-direction: column;
    height: 100%;
    width: 32px;
    padding: 6px 0;
    border-bottom: 0;
  }
  .panel.horizontal.collapsed h2 {
    writing-mode: vertical-rl;
  }
  .panel.horizontal.collapsed .actions {
    margin: 0;
    flex-direction: column;
  }
</style>
