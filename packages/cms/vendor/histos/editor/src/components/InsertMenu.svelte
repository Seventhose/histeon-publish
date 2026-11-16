<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { tick } from 'svelte';
  import { parse, randomUid, refToTag, type XbBlock } from '@xb/dsl';
  import { groupInOrder, INTERACTIONS, prepareSnippet, SNIPPETS, type InsertGroup, type Snippet } from '../lib/snippets.ts';
  import { acceptsChildren, describe, insertLanding, type InsertPosition } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The "+" popup: everything that can be added, searchable and keyboard first (↑ ↓ ← → Invio Esc).
  // It opens next to the button that called it and closes after each insertion.
  let {
    app,
    pickImage,
    pickMedia,
    onsvg,
    onvideo,
    onicon,
    onmap,
    forms,
  }: {
    app: BuilderState;
    pickImage?: () => Promise<Record<string, string> | null>;
    /** Video, audio or PDF from the library (M1): the element to insert. */
    pickMedia?: () => Promise<{ tag: string; attributes: Record<string, string | true>; text?: string } | null>;
    onsvg?: () => void;
    onvideo?: () => void;
    onicon?: () => void;
    onmap?: () => void;
    /** Fluent Forms (docs/spec/fluent-forms.md): its forms, and «new form» in its own editor. */
    forms?: { list: () => Promise<Array<{ id: number; title: string }>>; create: () => Promise<void> };
  } = $props();
  let formList = $state<Array<{ id: number; title: string }>>([]);

  interface Item {
    id: string;
    label: string;
    group: InsertGroup;
    icon: string;
    hint?: string;
    run: () => void | Promise<void>;
  }
  // By the snippets' stable key (their Italian label, lib/snippets.ts), whatever the user's language.
  const ICONS: Record<string, string> = {
    'Sezione': '▭',
    'Contenitore': '▢',
    'Titolo': 'H',
    'Paragrafo': '¶',
    'Link': '↗',
    'Pulsante': '⬭',
    'Immagine': '▨',
    'Lista': '≡',
    'Condizione': '?',
    'Loop di articoli': '⟳',
    'Slot (nei componenti)': '◌',
    'Contenuto del post': '✎',
    'Schede': '⊟',
    'Fisarmonica': '☰',
    'Menu mobile': '≣',
    'Selettore di lingua': '⇄',
    'Comparsa allo scorrimento': '↥',
  };
  const GROUP_TITLES: Record<Item['group'], string> = {
    Elementi: t('Elementi'),
    Interazioni: t('Interazioni'),
    Media: t('Media'),
    Componenti: t('Componenti'),
    Moduli: t('Moduli (Fluent Forms)'),
    'Blocchi PHP del sito': t('Blocchi PHP del sito'),
  };

  /** A snippet with unique ids; its BEM classes get their CSS only where the site has none yet. */
  function insertSnippet(s: Snippet) {
    const { dsl, styles } = prepareSnippet(s, randomUid().slice(0, 6));
    app.insert(parse(dsl).blocks, position);
    let added = 0;
    for (const [selector, css] of styles) {
      if (app.styles.some((e) => e.selector === selector)) continue;
      app.upsertStyle(selector, `${css}\n`);
      added++;
    }
    if (added) app.styleRevision++;
  }

  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let active = $state(0);
  let top = $state(0);
  let left = $state(0);

  /** Where the element goes (U7): said exactly, with the choice of before, after or inside the selection. */
  let position = $state<InsertPosition>('auto');
  const target = $derived(app.selected ? app.find(app.selected) : null);
  const landing = $derived(insertLanding(target, position));
  const where = $derived.by(() => {
    const name = target ? describe(target) : '';
    if (landing === 'before') return t('Prima di {0}', name);
    if (landing === 'after') return t('Dopo {0}', name);
    if (landing === 'inside') return t('Dentro {0}, in fondo', name);
    return t('In fondo alla pagina');
  });

  const all = $derived.by((): Item[] => {
    const list: Item[] = [...SNIPPETS, ...INTERACTIONS].map((s) => ({ id: `s:${s.key}`, label: s.label, group: s.group ?? 'Elementi', icon: ICONS[s.key] ?? '•', run: () => insertSnippet(s) }));
    if (pickImage) {
      const pick = pickImage;
      list.push({
        id: 'media',
        label: t('Immagine dalla libreria…'),
        group: 'Media',
        icon: '▤',
        run: async () => {
          const attributes = await pick();
          if (attributes) app.insert([{ name: 'xb/element', attrs: { uid: randomUid(), tag: 'img', attributes }, children: [] }], position);
        },
      });
    }
    if (pickMedia) {
      const pick = pickMedia;
      list.push({
        id: 'media-any',
        label: t('Video, audio o PDF dalla libreria…'),
        group: 'Media',
        icon: '▶',
        run: async () => {
          const chosen = await pick();
          if (!chosen) return;
          const children: XbBlock[] = chosen.text ? [{ name: 'xb/text', attrs: { uid: randomUid(), content: chosen.text } }] : [];
          app.insert([{ name: 'xb/element', attrs: { uid: randomUid(), tag: chosen.tag, attributes: chosen.attributes }, children }], position);
        },
      });
    }
    if (onvideo) list.push({ id: 'video-embed', label: t('Video YouTube o Vimeo…'), group: 'Media', icon: '▶', hint: t('video youtube vimeo gdpr'), run: onvideo });
    if (onmap) list.push({ id: 'map', label: t('Mappa (OpenStreetMap o Google)…'), group: 'Media', icon: '⌖', hint: t('mappa indirizzo gdpr'), run: onmap });
    if (onicon) list.push({ id: 'icon', label: t('Icona dalla libreria…'), group: 'Media', icon: '☆', hint: t('icone lucide simboli'), run: onicon });
    if (onsvg) list.push({ id: 'svg', label: t('SVG (incolla o file)…'), group: 'Media', icon: '✎', hint: t('icona vettoriale svg'), run: onsvg });
    // Dynamic blocks registered by the site's PHP (docs/spec/php.md): rendered by WordPress, as they are.
    for (const b of app.extensions?.blocks ?? []) {
      list.push({ id: `b:${b.name}`, label: b.title, hint: b.name, group: 'Blocchi PHP del sito', icon: '⚙', run: () => app.insert(parse(`<!-- wp:${b.name} /-->`).blocks, position) });
    }
    // Fluent Forms' block, kept as it is: Fluent Forms renders it, on the canvas and on the site.
    for (const f of formList) {
      list.push({ id: `f:${f.id}`, label: f.title || t('Modulo {0}', f.id), hint: `fluentform ${f.id}`, group: 'Moduli', icon: '✉', run: () => app.insert(parse(`<!-- wp:fluentfom/guten-block {"formId":"${Math.trunc(Number(f.id))}"} /-->`).blocks, position) });
    }
    if (forms) {
      const f = forms;
      list.push({ id: 'f:new', label: t('Nuovo modulo Fluent Forms…'), group: 'Moduli', icon: '+', run: async () => { await f.create(); formList = await f.list(); } });
    }
    for (const c of app.components) {
      list.push({ id: `c:${c.ref}`, label: c.title || c.ref, hint: c.ref, group: 'Componenti', icon: '◇', run: () => app.insert(parse(`<${refToTag(c.ref)} />`).blocks, position) });
    }
    return list;
  });
  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? all : all.filter((i) => i.label.toLowerCase().includes(q) || (i.hint ?? '').toLowerCase().includes(q));
  });
  /** What the menu draws, by group; `visible` is its order, the one the arrows and Enter follow. */
  const shown = $derived(groupInOrder(results));
  const groups = $derived(shown.groups);
  const visible = $derived(shown.visible);

  $effect(() => {
    void query;
    active = 0;
  });

  /** Opens below `anchor` (above it when there is no room), kept inside the window. */
  export async function open(anchor: HTMLElement | null) {
    void app.loadExtensions();
    if (forms) void forms.list().then((l) => (formList = l)).catch(() => (formList = []));
    query = '';
    active = 0;
    position = 'auto';
    const width = 380;
    const height = 460;
    const r = anchor?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2 - width / 2, 80, 0, 0);
    left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - width - 8));
    top = Math.round(r.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 6) : r.bottom + 6);
    dialog.showModal();
    await tick();
    input?.focus();
  }

  function run(item: Item | undefined) {
    if (!item) return;
    dialog.close();
    void item.run();
  }

  function onkeydown(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      active = Math.min(Math.max(0, active + step), visible.length - 1);
      document.getElementById(`xb-ins-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(visible[active]);
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="insert"
  aria-label={t('Aggiungi un elemento')}
  style:top="{top}px"
  style:left="{left}px"
  onclick={(e) => {
    if (e.target === dialog) dialog.close();
  }}
>
  <div class="box">
    <input bind:this={input} bind:value={query} {onkeydown} type="search" placeholder={t('Cerca un elemento o un componente…')} aria-label={t('Cerca')} aria-controls="xb-ins-list" />
    <div class="where-row">
      <p class="where" aria-live="polite">{where}</p>
      {#if target}
        <div class="place" role="group" aria-label={t('Dove inserire')}>
          <button type="button" aria-pressed={landing === 'before'} onclick={() => (position = 'before')}>{t('Prima')}</button>
          <button type="button" aria-pressed={landing === 'inside'} disabled={!acceptsChildren(target)} onclick={() => (position = 'inside')}>{t('Dentro')}</button>
          <button type="button" aria-pressed={landing === 'after'} onclick={() => (position = 'after')}>{t('Dopo')}</button>
        </div>
      {/if}
    </div>
    <div id="xb-ins-list" class="list" role="listbox" aria-label={t('Elementi da aggiungere')}>
      {#each groups as group (group.name)}
        <h3>{GROUP_TITLES[group.name]}</h3>
        <div class="grid">
          {#each group.items as item (item.id)}
            {@const index = visible.indexOf(item)}
            <button
              id="xb-ins-{index}"
              role="option"
              aria-selected={index === active}
              class:active={index === active}
              tabindex="-1"
              onclick={() => run(item)}
              onmouseenter={() => (active = index)}
              title={item.hint ?? item.label}
            >
              <span class="icon" aria-hidden="true">{item.icon}</span>
              <span class="label">{item.label}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="none">{t('Nessun elemento corrisponde.')}</p>
      {/each}
    </div>
  </div>
</dialog>

<style>
  .insert {
    position: fixed;
    margin: 0;
    padding: 0;
    width: 380px;
    max-height: 460px;
    border: 1px solid var(--xb-line);
    border-radius: 10px;
    background: var(--xb-bg);
    color: var(--xb-text);
    box-shadow: var(--xb-shadow);
  }
  .insert::backdrop {
    background: transparent;
  }
  .box {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    max-height: 458px;
  }
  input {
    margin: 10px 10px 4px;
    font: 14px var(--xb-sans);
    padding: 8px 10px;
    border-radius: var(--xb-r);
    border: 1px solid var(--xb-line);
    background: var(--xb-panel);
    color: var(--xb-text);
  }
  input:focus {
    outline: 2px solid var(--xb-accent);
    outline-offset: -1px;
  }
  .where-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 12px 6px;
  }
  .place {
    display: inline-flex;
    margin-left: auto;
    flex: none;
  }
  .place button {
    font: 11px var(--xb-sans);
    padding: 2px 8px;
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
  }
  .place button + button {
    margin-left: -1px;
  }
  .place button:first-child {
    border-radius: var(--xb-r-sm) 0 0 var(--xb-r-sm);
  }
  .place button:last-child {
    border-radius: 0 var(--xb-r-sm) var(--xb-r-sm) 0;
  }
  .place button[aria-pressed='true'] {
    background: var(--xb-accent-bg);
    border-color: var(--xb-accent);
    color: var(--xb-link);
  }
  .place button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .where {
    margin: 0;
    min-width: 0;
    font-size: 12px;
    color: var(--xb-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list {
    overflow: auto;
    padding: 0 10px 10px;
  }
  h3 {
    margin: 10px 2px 6px;
    font: 600 11px var(--xb-sans);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--xb-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .grid button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r);
    background: var(--xb-bg);
    color: var(--xb-text);
    font: 13px var(--xb-sans);
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .grid button.active {
    border-color: var(--xb-accent);
    background: var(--xb-accent-bg);
  }
  .icon {
    flex: none;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: var(--xb-r-sm);
    background: var(--xb-panel);
    font: 600 13px var(--xb-sans);
    color: var(--xb-muted);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .none {
    color: var(--xb-muted);
    font-size: 13px;
    padding: 8px 2px;
  }
</style>
