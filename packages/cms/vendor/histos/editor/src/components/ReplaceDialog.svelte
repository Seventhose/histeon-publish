<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import { replaceInTree } from '../lib/replace.ts';
  import { describe } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Search and replace in the page (E13): texts, whole class names, link addresses; every change is listed before
  // it is made, and all of them are one undo step.
  let { app }: { app: BuilderState } = $props();

  let dialog: HTMLDialogElement;
  let findField = $state<HTMLInputElement | null>(null);
  let find = $state('');
  let replacement = $state('');
  let text = $state(true);
  let classes = $state(false);
  let links = $state(false);
  let matchCase = $state(false);
  const result = $derived(find ? replaceInTree(app.tree, find, replacement, { text, classes, links, matchCase }) : null);
  const WHERE = { text: t('testo'), class: t('classe'), link: t('link') };

  export function open() {
    dialog.showModal();
    findField?.focus();
    findField?.select();
  }

  function apply(event: SubmitEvent) {
    event.preventDefault();
    if (!result?.count) return;
    app.setTree(result.tree);
    app.status = { kind: 'idle', message: tn('{0} sostituzione fatta: Ctrl+Z la annulla.', '{0} sostituzioni fatte: Ctrl+Z le annulla tutte.', result.count, result.count) };
    dialog.close();
  }

  const label = (uid: string) => {
    const block = app.find(uid);
    const parent = block?.name === 'xb/text' ? app.index.parent.get(uid) : block;
    return parent ? describe(parent) : '';
  };
</script>

<dialog bind:this={dialog} class="replace" aria-labelledby="xb-replace-title">
  <form onsubmit={apply}>
    <h2 id="xb-replace-title">{t('Cerca e sostituisci nella pagina')}</h2>
    <label>{t('Cerca')}<input bind:this={findField} bind:value={find} aria-label={t('Testo da cercare')} /></label>
    <label>{t('Sostituisci con')}<input bind:value={replacement} aria-label={t('Testo che lo sostituisce')} /></label>
    <fieldset>
      <legend>{t('Dove')}</legend>
      <label><input type="checkbox" bind:checked={text} /> {t('Testi')}</label>
      <label><input type="checkbox" bind:checked={classes} /> {t('Classi (nome intero)')}</label>
      <label><input type="checkbox" bind:checked={links} /> {t('Indirizzi dei link')}</label>
      <label><input type="checkbox" bind:checked={matchCase} /> {t('Maiuscole e minuscole')}</label>
    </fieldset>
    {#if result}
      <p class="count" role="status">{result.count ? tn('{0} sostituzione', '{0} sostituzioni', result.count, result.count) : t('Nessun risultato.')}</p>
      {#if result.matches.length}
        <ul class="matches" aria-label={t('Anteprima delle sostituzioni')}>
          {#each result.matches.slice(0, 50) as m, i (i)}
            <li><small>{label(m.uid)} · {WHERE[m.where]}</small><del>{m.before}</del><ins>{m.after}</ins></li>
          {/each}
        </ul>
      {/if}
    {/if}
    <div class="row">
      <button type="button" onclick={() => dialog.close()}>{t('Annulla')}</button>
      <button type="submit" class="primary" disabled={!result?.count}>{result?.count ? tn('Sostituisci {0}', 'Sostituisci tutte e {0}', result.count, result.count) : t('Sostituisci')}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 1px solid var(--xb-line); border-radius: 10px; padding: 0; background: var(--xb-bg); color: var(--xb-text); width: min(620px, 94vw); }
  dialog::backdrop { background: rgb(0 0 0 / 0.3); }
  form { display: grid; gap: 10px; padding: 16px; font-size: 13px; }
  h2 { margin: 0; font-size: 15px; }
  form > label { display: grid; gap: 4px; color: var(--xb-muted); font-size: 12px; }
  input:not([type='checkbox']) { font: 13px var(--xb-sans); padding: 6px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-panel); color: var(--xb-text); }
  fieldset { display: flex; flex-wrap: wrap; gap: 6px 14px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); font-size: 12px; }
  .count { margin: 0; color: var(--xb-muted); }
  .matches { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow: auto; display: grid; gap: 6px; font-size: 12px; }
  .matches li { display: grid; gap: 1px; padding: 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .matches small { color: var(--xb-muted); font: 11px var(--xb-mono); }
  del { color: var(--xb-danger); }
  ins { color: var(--xb-ok); text-decoration: none; }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: 12px var(--xb-sans); padding: 5px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
