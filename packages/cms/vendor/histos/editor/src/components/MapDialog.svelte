<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { randomUid } from '@xb/dsl';
  import { mapBlocks, mapFromUrl } from '../lib/media.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // A map without consent before the click (E11): a box with the place's name and a link to the map; the map
  // itself (OpenStreetMap or Google Maps) loads only when a visitor clicks. Nothing is fetched now.
  let { app }: { app: BuilderState } = $props();

  let dialog: HTMLDialogElement;
  let url = $state('');
  let label = $state('');
  const map = $derived(url.trim() ? mapFromUrl(url) : null);

  export function open() {
    url = '';
    label = '';
    dialog.showModal();
  }

  function insert(event: SubmitEvent) {
    event.preventDefault();
    if (!map) return;
    app.insert(mapBlocks(map, label, randomUid));
    dialog.close();
  }
</script>

<dialog bind:this={dialog} class="map" aria-labelledby="xb-map-title">
  <form onsubmit={insert}>
    <h2 id="xb-map-title">{t('Mappa')}</h2>
    <p class="muted">{t('Incolla un link di OpenStreetMap o di Google Maps (o il codice «incorpora» che danno). La pagina mostra un riquadro con il nome del luogo: la mappa si carica, e il fornitore riceve una richiesta, solo quando chi visita la apre.')}</p>
    <input type="url" bind:value={url} placeholder="https://www.openstreetmap.org/#map=16/45.4642/9.1900" aria-label={t('Link della mappa')} />
    <input bind:value={label} placeholder={t('Il nome del luogo (es. Libreria Il Lettore, via Roma 1)')} aria-label={t('Nome del luogo')} />
    {#if url.trim() && !map}<p class="error" role="alert">{t('Serve un link di OpenStreetMap o di Google Maps.')}</p>{/if}
    {#if map}<p class="muted" role="status">{t('Mappa di {0}', map.provider)}</p>{/if}
    <div class="row">
      <button type="button" onclick={() => dialog.close()}>{t('Annulla')}</button>
      <button type="submit" class="primary" disabled={!map}>{t('Inserisci')}</button>
    </div>
  </form>
</dialog>
<style>
  dialog { border: 1px solid var(--xb-line); border-radius: 10px; padding: 0; background: var(--xb-bg); color: var(--xb-text); width: min(560px, 92vw); }
  dialog::backdrop { background: rgb(0 0 0 / 0.3); }
  form { display: grid; gap: 10px; padding: 16px; }
  h2 { margin: 0; font-size: 15px; }
  .muted { margin: 0; color: var(--xb-muted); font-size: 12px; }
  input { font: 12px var(--xb-mono); padding: 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-panel); color: var(--xb-text); }
  .error { margin: 0; color: var(--xb-danger); font-size: 12px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: 12px var(--xb-sans); padding: 5px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
