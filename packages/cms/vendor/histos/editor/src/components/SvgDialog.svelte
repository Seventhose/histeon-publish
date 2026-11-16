<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { randomUid } from '@xb/dsl';
  import { svgToBlocks } from '../lib/speed.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // An SVG pasted or read from a file, inserted inline as elements: cleaned before it enters
  // the page (lib/speed.ts svgToBlocks), filtered again by the server on save. Nothing is uploaded.
  let { app }: { app: BuilderState } = $props();

  let dialog: HTMLDialogElement;
  let code = $state('');
  let error = $state('');
  let note = $state('');

  export function open() {
    code = '';
    error = '';
    note = '';
    dialog.showModal();
  }

  async function readFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 200_000) {
      error = t('File troppo grande (al massimo 200 KB).');
      return;
    }
    code = await file.text();
    error = '';
  }

  function insert(event: SubmitEvent) {
    event.preventDefault();
    try {
      const { blocks, dropped } = svgToBlocks(code, randomUid);
      app.insert(blocks);
      note = dropped.length ? t('Inserito. Tolti perché non sicuri o non grafici: {0}', dropped.slice(0, 6).join(', ') + (dropped.length > 6 ? '…' : '')) : '';
      if (!dropped.length) dialog.close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<dialog bind:this={dialog} class="svg" aria-labelledby="xb-svg-title">
  <form onsubmit={insert}>
    <h2 id="xb-svg-title">{t('Inserisci un SVG')}</h2>
    <p class="muted">{t('Incolla il codice o scegli un file .svg dal computer: diventa parte della pagina, modificabile come gli altri elementi (colori con')} <code>currentColor</code> {t('e classi).')}</p>
    <textarea bind:value={code} rows="8" placeholder={'<svg viewBox="0 0 24 24">…</svg>'} aria-label={t('Codice SVG')} spellcheck="false"></textarea>
    <label class="file">{t('oppure un file')} <input type="file" accept=".svg,image/svg+xml" onchange={readFile} /></label>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if note}<p class="muted" role="status">{note}</p>{/if}
    <div class="row">
      <button type="button" onclick={() => dialog.close()}>{note ? t('Chiudi') : t('Annulla')}</button>
      <button type="submit" class="primary" disabled={!code.trim()}>{t('Inserisci')}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 1px solid var(--xb-line); border-radius: 10px; padding: 0; background: var(--xb-bg); color: var(--xb-text); width: min(560px, 92vw); }
  dialog::backdrop { background: rgb(0 0 0 / 0.3); }
  form { display: grid; gap: 10px; padding: 16px; }
  h2 { margin: 0; font-size: 15px; }
  .muted { margin: 0; color: var(--xb-muted); font-size: 12px; }
  textarea { font: 12px var(--xb-mono); padding: 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-panel); color: var(--xb-text); resize: vertical; }
  .file { font-size: 12px; color: var(--xb-muted); }
  .error { margin: 0; color: var(--xb-danger); font-size: 12px; }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: 12px var(--xb-sans); padding: 5px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
