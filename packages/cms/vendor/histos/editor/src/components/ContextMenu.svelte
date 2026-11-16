<script lang="ts">
  import { inlineTarget } from '../lib/inlineText.ts';
  import { tick, untrack } from 'svelte';
  import { print, randomUid, refToTag, type XbBlock } from '@xb/dsl';
  import { htmlToBlocks, makeClip, readClip } from '../lib/clip.ts';
  import { copiedHere, rememberCopy, restrictPaste } from '../lib/pasteTrust.ts';
  import { componentProblem, refFrom } from '../lib/speed.ts';
  import { canUnwrap, describe, parentOf } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t } from '../lib/i18n.ts';
  import { ariaKeys, keyHint } from '../lib/keys.svelte.ts';

  // Right click (or the context-menu key, or Shift+F10) on a node of the structure: copy and paste
  // between sites, duplicate, wrap and unwrap, make a component of that part, and the usual moves. Every action
  // is one the builder already has, so it is undone with Ctrl+Z like any other edit.
  let { app, uid, x, y, start = 'menu', onclose, onrename }: { app: BuilderState; uid: string; x: number; y: number; start?: 'menu' | 'component'; onclose: () => void; onrename: () => void } = $props();

  type Item = { id: string; label: string; hint?: string; keys?: string; disabled?: string | null; danger?: boolean; run: () => void | Promise<void> };

  let menu: HTMLDivElement;
  let view = $state<'menu' | 'component'>('menu');
  let title = $state('');
  let ref = $state('');
  let refTouched = $state(false);
  let error = $state('');
  const mac = navigator.platform.toLowerCase().includes('mac');
  const mod = mac ? '⌘' : 'Ctrl+';

  const block = $derived(app.find(uid));
  const element = $derived(block?.name === 'xb/element' ? block : null);
  const snapshot = () => $state.snapshot(app.find(uid)) as XbBlock | null;

  async function copy() {
    const b = snapshot();
    if (!b) return;
    const clip = makeClip([b], $state.snapshot(app.styles), window.location.hostname);
    rememberCopy(JSON.stringify(clip));
    await navigator.clipboard.writeText(JSON.stringify(clip));
    app.status = { kind: 'idle', message: t('Copiato con i suoi stili: incollalo qui o in un altro sito Histeon.') };
  }

  async function paste() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      app.status = { kind: 'error', message: t('Il browser non ha dato accesso agli appunti: usa Ctrl+V con l’elemento selezionato.') };
      return;
    }
    const clip = readClip(text);
    if (clip) {
      app.pasteRequest = { clip, at: uid, trusted: copiedHere(text) };
      return;
    }
    if (/^\s*</.test(text)) {
      app.select(uid);
      try {
        const { blocks } = await restrictPaste(app.api, htmlToBlocks(text, randomUid).blocks);
        app.insert(blocks);
      } catch (e) {
        app.status = { kind: 'error', message: t('Non ho potuto controllare il contenuto incollato, quindi non l’ho inserito: {0}', e instanceof Error ? e.message : String(e)) };
      }
      return;
    }
    app.status = { kind: 'error', message: t('Negli appunti non c’è un elemento Histeon né dell’HTML.') };
  }

  function startComponent() {
    const b = element;
    const cls = b && typeof b.attrs.attributes?.class === 'string' ? (b.attrs.attributes.class.split(/\s+/)[0] ?? null) : null;
    title = b?.attrs.label ?? '';
    ref = refFrom(title || cls || b?.attrs.tag || 'componente');
    refTouched = false;
    error = '';
    view = 'component';
    void tick().then(() => menu?.querySelector<HTMLInputElement>('input')?.focus());
  }

  // Opened from the palette straight on the component form.
  $effect(() => {
    if (untrack(() => start) === 'component') untrack(startComponent);
  });

  async function makeComponent(event: SubmitEvent) {
    event.preventDefault();
    try {
      app.select(uid);
      await app.componentFromSelection(ref, title.trim() || ref);
      app.status = { kind: 'idle', message: t("Componente <{0}> creato: qui ora c'è una sua istanza.", refToTag(ref)) };
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Several selected nodes, this one among them: the menu acts on all of them (E7). */
  const many = $derived(app.selection.length > 1 && app.selection.includes(uid) ? app.selection.length : 0);

  const items = $derived.by((): Array<Item | 'sep'> => {
    if (!block) return [];
    if (many) {
      return [
        { id: 'dup', label: t('Duplica'), hint: keyHint('dup'), keys: ariaKeys('dup'), run: () => app.duplicateSelection() },
        'sep',
        { id: 'wrap-div', label: t('Avvolgi in un div'), run: () => app.wrapSelection('div') },
        { id: 'wrap-section', label: t('Avvolgi in una section'), run: () => app.wrapSelection('section') },
        'sep',
        { id: 'up', label: t('Sposta su'), hint: keyHint('up'), keys: ariaKeys('up'), run: () => app.moveSelection(-1) },
        { id: 'down', label: t('Sposta giù'), hint: keyHint('down'), keys: ariaKeys('down'), run: () => app.moveSelection(1) },
        'sep',
        { id: 'del', label: t('Elimina'), hint: keyHint('del'), keys: ariaKeys('del'), danger: true, run: () => app.removeSelection() },
      ];
    }
    const parent = parentOf(app.tree, uid);
    const notComponent = element ? componentProblem([$state.snapshot(element) as XbBlock]) : t('Solo un elemento HTML può diventare un componente.');
    const editComponent: Array<Item | 'sep'> =
      block.name === 'xb/component'
        ? [{ id: 'edit-component', label: t('Modifica il componente'), hint: t('doppio clic'), run: () => void app.openComponent(block.attrs.ref) }, 'sep']
        : inlineTarget(block)
          ? [{ id: 'edit-text', label: t('Scrivi il testo nella pagina'), hint: t('doppio clic'), run: () => { app.inlineRequest = uid; } }, 'sep']
          : [];
    return [
      ...editComponent,
      { id: 'copy', label: t('Copia'), hint: `${mod}C`, keys: 'Control+C', run: copy },
      { id: 'paste', label: t('Incolla qui'), hint: `${mod}V`, keys: 'Control+V', run: paste },
      { id: 'dup', label: t('Duplica'), hint: keyHint('dup'), keys: ariaKeys('dup'), run: () => app.duplicate(uid) },
      'sep',
      { id: 'wrap-div', label: t('Avvolgi in un div'), run: () => app.wrap(uid, 'div') },
      { id: 'wrap-section', label: t('Avvolgi in una section'), run: () => app.wrap(uid, 'section') },
      { id: 'wrap-a', label: t('Avvolgi in un link'), run: () => app.wrap(uid, 'a') },
      { id: 'unwrap', label: t('Togli il contenitore'), disabled: canUnwrap(block) ? null : t('Solo un elemento con dei figli.'), run: () => app.unwrap(uid) },
      'sep',
      { id: 'component', label: t('Crea componente…'), disabled: notComponent, run: startComponent },
      { id: 'bem', label: t('Classi BEM ai figli'), disabled: element && typeof element.attrs.attributes?.class === 'string' ? null : t('Serve un elemento con una classe.'), run: () => void app.bem(uid) },
      { id: 'rename', label: t('Rinomina'), hint: 'F2', keys: 'F2', disabled: element || block.name === 'xb/component' ? null : t('Questo nodo non ha un nome.'), run: onrename },
      { id: 'html', label: t('Copia HTML'), run: async () => navigator.clipboard.writeText(print([snapshot() as XbBlock])) },
      'sep',
      // Classes and style attribute from one element to another (E12).
      { id: 'copy-style', label: t('Copia stile'), disabled: element ? null : t('Solo un elemento ha uno stile.'), run: () => {
        app.copyStyle(uid);
        app.status = { kind: 'idle', message: t('Stile copiato: classi e attributo style. «Incolla stile» li dà a un altro elemento.') };
      } },
      { id: 'paste-style', label: t('Incolla stile'), disabled: !element ? t('Solo un elemento ha uno stile.') : app.copiedStyle ? null : t('Prima copia lo stile di un elemento.'), run: () => app.pasteStyle(uid) },
      'sep',
      { id: 'parent', label: t('Seleziona il genitore'), disabled: parent ? null : t('È già al primo livello.'), run: () => app.select(parent) },
      { id: 'up', label: t('Sposta su'), hint: keyHint('up'), keys: ariaKeys('up'), run: () => app.move(uid, -1) },
      { id: 'down', label: t('Sposta giù'), hint: keyHint('down'), keys: ariaKeys('down'), run: () => app.move(uid, 1) },
      'sep',
      { id: 'del', label: t('Elimina'), hint: keyHint('del'), keys: ariaKeys('del'), danger: true, run: () => app.remove(uid) },
    ];
  });

  const enabled = () => Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  async function choose(item: Item) {
    if (item.disabled) return;
    const keepOpen = item.id === 'component' || item.id === 'rename';
    if (!keepOpen) onclose();
    try {
      await item.run();
    } catch (e) {
      app.status = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  function onkeydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    if (view !== 'menu') return;
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(list.length - 1);
    else return;
    event.preventDefault();
  }

  // Inside the window, focused on the first item; closed by a click elsewhere, a scroll or losing focus.
  let left = $state(0);
  let top = $state(0);
  $effect(() => {
    void tick().then(() => {
      const r = menu.getBoundingClientRect();
      left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
      top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
      enabled()[0]?.focus();
    });
    const outside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) onclose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onclose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onclose);
    };
  });
</script>

<div bind:this={menu} class="menu" style:left="{left}px" style:top="{top}px" {onkeydown} role="presentation">
  {#if view === 'menu'}
    <div role="menu" aria-label={many ? t('Azioni su {0} elementi selezionati', many) : t('Azioni su {0}', block ? describe(block) : '')} tabindex="-1">
      {#each items as item, i (typeof item === 'string' ? `sep${i}` : item.id)}
        {#if item === 'sep'}
          <div class="sep" role="separator"></div>
        {:else}
          <button role="menuitem" class:danger={item.danger} aria-disabled={item.disabled ? 'true' : undefined} aria-keyshortcuts={item.keys} title={item.disabled ?? undefined} onclick={() => choose(item)}>
            <span>{item.label}</span>{#if item.hint}<kbd aria-hidden="true">{item.hint}</kbd>{/if}
          </button>
        {/if}
      {/each}
    </div>
  {:else}
    <form class="component" onsubmit={makeComponent} aria-label={t('Nuovo componente')}>
      <label>{t('Nome')} <input aria-label={t('Nome del nuovo componente')} bind:value={title} oninput={() => { if (!refTouched) ref = refFrom(title); }} placeholder={t('Scheda evento')} /></label>
      <label>{t('Chiave')} <input aria-label={t('Chiave del nuovo componente')} bind:value={ref} oninput={() => (refTouched = true)} /></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="row">
        <button type="button" onclick={() => (view = 'menu')}>{t('Indietro')}</button>
        <button type="submit" class="primary">{t('Crea')}</button>
      </div>
    </form>
  {/if}
</div>

<style>
  .menu { position: fixed; z-index: 60; min-width: 230px; max-width: 320px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-lg); padding: 4px; box-shadow: var(--xb-shadow); font: 12px var(--xb-sans); }
  [role='menu'] { display: grid; outline: none; }
  [role='menuitem'] { display: flex; justify-content: space-between; gap: 16px; padding: 5px 8px; border: 0; border-radius: var(--xb-r-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  [role='menuitem']:hover, [role='menuitem']:focus-visible { background: color-mix(in srgb, var(--xb-accent) 14%, transparent); outline: none; }
  [role='menuitem'][aria-disabled='true'] { opacity: 0.45; cursor: default; }
  .danger { color: var(--xb-danger); }
  kbd { font: 11px var(--xb-sans); color: var(--xb-muted); }
  .sep { height: 1px; margin: 4px 2px; background: var(--xb-line); }
  .component { display: grid; gap: 6px; padding: 6px; }
  .component label { display: grid; gap: 2px; color: var(--xb-muted); }
  .component input { font: 12px var(--xb-sans); padding: 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .row { display: flex; justify-content: flex-end; gap: 6px; }
  .row button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .row .primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  .error { color: var(--xb-danger); margin: 0; }
</style>
