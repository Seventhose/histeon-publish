<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { randomUid } from '@xb/dsl';
  import { videoBlocks } from '../lib/media.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // A YouTube or Vimeo video without consent before the click (E9): the server downloads the poster once into the
  // media library; the page shows it with a link to the video, and the player loads only when a visitor clicks.
  let { app }: { app: BuilderState } = $props();

  let dialog: HTMLDialogElement;
  let url = $state('');
  let error = $state('');
  let busy = $state(false);

  export function open() {
    url = '';
    error = '';
    dialog.showModal();
  }

  async function insert(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      const info = await app.api.videoInfo(url.trim());
      app.insert(videoBlocks(info, randomUid));
      dialog.close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} class="video" aria-labelledby="xb-video-title">
  <form onsubmit={insert}>
    <h2 id="xb-video-title">{t('Video YouTube o Vimeo')}</h2>
    <p class="muted">{t('La pagina mostra un’immagine di anteprima salvata sul sito: YouTube o Vimeo ricevono una richiesta solo quando chi visita avvia il video (da youtube-nocookie.com, o con dnt=1 per Vimeo). Niente consenso preventivo.')}</p>
    <input type="url" bind:value={url} placeholder="https://www.youtube.com/watch?v=…" aria-label={t('Indirizzo del video')} required />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row">
      <button type="button" onclick={() => dialog.close()}>{t('Annulla')}</button>
      <button type="submit" class="primary" disabled={busy || !url.trim()}>{busy ? t('Scarico l’anteprima…') : t('Inserisci')}</button>
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
