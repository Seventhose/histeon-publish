<script lang="ts">
  import { t } from '../lib/i18n.ts';

  // Fluent Forms' own editor, inside the builder (docs/spec/fluent-forms.md): its admin page, same origin, framed
  // without WordPress's menus. Closing resolves the promise; the caller refreshes the preview or the form list.
  let dialog: HTMLDialogElement;
  let url = $state('');
  let title = $state('');
  let done: (() => void) | null = null;

  export function open(next: string, label: string): Promise<void> {
    url = next;
    title = label;
    dialog.showModal();
    return new Promise((resolve) => (done = resolve));
  }

  function onclose() {
    url = '';
    done?.();
    done = null;
  }
</script>

<dialog bind:this={dialog} class="forms" aria-label={title} {onclose}>
  <header>
    <h2>{title}</h2>
    <button onclick={() => dialog.close()}>{t('Chiudi e aggiorna l\'anteprima')}</button>
  </header>
  {#if url}<iframe src={url} title={title}></iframe>{/if}
</dialog>

<style>
  .forms { width: min(1200px, 96vw); height: min(860px, 92vh); padding: 0; border: 1px solid var(--xb-line); border-radius: 10px; background: var(--xb-panel); color: var(--xb-text); }
  .forms[open] { display: grid; grid-template-rows: auto 1fr; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--xb-line); }
  h2 { margin: 0; font: 600 14px var(--xb-sans); }
  button { font: 13px var(--xb-sans); padding: 6px 12px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  iframe { width: 100%; height: 100%; border: 0; background: #fff; }
</style>
