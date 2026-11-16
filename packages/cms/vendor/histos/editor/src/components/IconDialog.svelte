<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { randomUid } from '@xb/dsl';
  import { iconBlocks, iconMarkup, searchIcons, type IconLibrary, type IconNodes } from '../lib/icons.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The icon library (E10): Lucide, bundled with the plugin and read only when this dialog first opens. An icon
  // enters the page as an inline SVG in the text colour, editable like any other element.
  let { app, url }: { app: BuilderState; url: string } = $props();

  let dialog: HTMLDialogElement;
  let search = $state<HTMLInputElement | null>(null);
  let library = $state<IconLibrary | null>(null);
  let query = $state('');
  let error = $state('');
  const found = $derived(library ? searchIcons(Object.keys(library.icons), query) : []);

  export async function open() {
    query = '';
    error = '';
    dialog.showModal();
    search?.focus();
    if (library) return;
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(t('Errore {0}', response.status));
      library = (await response.json()) as IconLibrary;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** The icon's nodes when they are drawing elements and geometry only (what iconMarkup accepts), else none. */
  function drawn(name: string): IconNodes {
    const nodes = library?.icons[name] ?? [];
    try {
      iconMarkup(name, nodes);
      return nodes;
    } catch {
      return [];
    }
  }

  function insert(name: string) {
    if (!library) return;
    try {
      app.insert(iconBlocks(name, library.icons[name] ?? [], randomUid).blocks);
      dialog.close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<dialog bind:this={dialog} class="icons" aria-labelledby="xb-icons-title">
  <header>
    <h2 id="xb-icons-title">{t('Icone')}</h2>
    <input type="search" bind:this={search} bind:value={query} placeholder={t('Cerca un’icona in inglese (house, arrow right, mail…)')} aria-label={t('Cerca un’icona')} />
    <button type="button" onclick={() => dialog.close()} aria-label={t('Chiudi')}>✕</button>
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !library && !error}<p class="muted">{t('Carico le icone…')}</p>{/if}
  {#if library}
    {#if query.trim() && !found.length}<p class="muted">{t('Nessuna icona trovata.')}</p>{/if}
    {#if !query.trim()}<p class="muted">{t('{0} icone di {1} {2} (licenza {3}). Scrivi un nome per cercarle.', Object.keys(library.icons).length, library.name, library.version, library.license)}</p>{/if}
    <ul class="grid" aria-label={t('Icone trovate')}>
      {#each found as name (name)}
        <li>
          <button type="button" onclick={() => insert(name)} title={name} aria-label={t('Inserisci l’icona {0}', name)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {#each drawn(name) as [tag, attrs], i (i)}<svelte:element this={tag} xmlns="http://www.w3.org/2000/svg" {...attrs} />{/each}
            </svg>
            <span>{name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</dialog>

<style>
  dialog { border: 1px solid var(--xb-line); border-radius: 10px; padding: 0; background: var(--xb-bg); color: var(--xb-text); width: min(760px, 94vw); height: min(560px, 86vh); }
  dialog[open] { display: grid; grid-template-rows: auto auto 1fr; }
  dialog::backdrop { background: rgb(0 0 0 / 0.3); }
  header { display: flex; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid var(--xb-line); }
  h2 { margin: 0; font-size: 15px; }
  header input { flex: 1; font: 13px var(--xb-sans); padding: 6px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-panel); color: var(--xb-text); }
  header button { font: 12px var(--xb-sans); padding: 5px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .muted, .error { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--xb-muted); }
  .error { color: var(--xb-danger); }
  .grid { list-style: none; margin: 0; padding: 10px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; align-content: start; }
  .grid button { width: 100%; display: grid; justify-items: center; gap: 4px; padding: 10px 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: transparent; color: var(--xb-text); cursor: pointer; }
  .grid button:hover, .grid button:focus-visible { border-color: var(--xb-accent); }
  .grid span { font-size: 10.5px; color: var(--xb-muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
