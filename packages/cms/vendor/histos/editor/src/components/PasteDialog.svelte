<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import type { XbBlock } from '@xb/dsl';
  import type { Clip } from '../lib/clip.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { applyPaste, preparePaste, type ClassChoice, type PreparedPaste } from '../lib/pastePlan.ts';

  // Paste from another XB site (docs/spec/quick-actions.md §5): what comes in, which classes are new, and for
  // each clash whether to keep this site's class or import theirs under a new name.
  let { app }: { app: BuilderState } = $props();

  let dialog: HTMLDialogElement;
  let clip = $state<Clip | null>(null);
  let blocks = $state<XbBlock[]>([]);
  let plan = $state<PreparedPaste['plan']>([]);
  let choice = $state<Record<string, ClassChoice>>({});
  let missing = $state<string[]>([]);
  let prepared: PreparedPaste | null = null;

  /** @param trusted Only for what this tab copied itself: anything else is restricted by the server first. */
  export async function open(incoming: Clip, trusted = false) {
    try {
      prepared = await preparePaste(app, incoming, trusted);
    } catch (e) {
      app.status = { kind: 'error', message: t('Non ho potuto controllare il contenuto incollato, quindi non l’ho inserito: {0}', e instanceof Error ? e.message : String(e)) };
      return;
    }
    ({ clip, blocks, plan, missing } = prepared);
    choice = Object.fromEntries(plan.filter((p) => p.fate === 'conflict').map((p) => [p.name, 'rename']));
    dialog.showModal();
  }
  function apply() {
    if (!clip || !prepared) return;
    const { renames } = applyPaste(app, prepared, choice);
    const from = clip.origin || t('un altro sito');
    const list = [...renames].map(([a, b]) => `${a} → ${b}`).join(', ');
    app.status = { kind: 'idle', message: renames.size ? t('Incollati {0} elementi da {1}; classi rinominate: {2}.', blocks.length, from, list) : t('Incollati {0} elementi da {1}.', blocks.length, from) };
    dialog.close();
  }
</script>

<dialog bind:this={dialog} class="paste" aria-labelledby="xb-paste-title">
  {#if clip}
    <h2 id="xb-paste-title">{t('Incolla da {0}', clip.origin || t('un altro sito'))}</h2>
    <p class="muted">{tn('{0} elemento, {1} classi con stili.', '{0} elementi, {1} classi con stili.', blocks.length, blocks.length, plan.length)}</p>
    {#if plan.length}
      <table>
        <tbody>
          {#each plan as p (p.name)}
            <tr>
              <td><code>.{p.name}</code></td>
              <td>
                {#if p.fate === 'new'}<span class="tag new">{t('nuova: viene aggiunta')}</span>
                {:else if p.fate === 'same'}<span class="tag same">{t('uguale a quella del sito')}</span>
                {:else}
                  <label><input type="radio" name="c-{p.name}" checked={choice[p.name] === 'rename'} onchange={() => (choice = { ...choice, [p.name]: 'rename' })} /> {t('importa con un nome nuovo')}</label>
                  <label><input type="radio" name="c-{p.name}" checked={choice[p.name] === 'keep'} onchange={() => (choice = { ...choice, [p.name]: 'keep' })} /> {t('usa quella di questo sito')}</label>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if missing.length}<p class="warn">{t('Componenti che questo sito non ha (resteranno vuoti): {0}.', missing.join(', '))}</p>{/if}
    <div class="row">
      <button onclick={() => dialog.close()}>{t('Annulla')}</button>
      <button class="primary" onclick={apply}>{t('Incolla')}</button>
    </div>
  {/if}
</dialog>

<style>
  dialog { border: 1px solid var(--xb-line); border-radius: 10px; padding: 16px; background: var(--xb-bg); color: var(--xb-text); width: min(560px, 92vw); font-size: 13px; }
  dialog::backdrop { background: rgb(0 0 0 / 0.3); }
  h2 { margin: 0 0 6px; font-size: 15px; }
  .muted { margin: 0 0 10px; color: var(--xb-muted); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  td { padding: 5px 4px; border-bottom: 1px solid var(--xb-line); vertical-align: top; }
  td label { display: block; }
  .tag { font-size: 12px; color: var(--xb-muted); }
  .tag.new { color: var(--xb-ok); }
  .warn { color: var(--xb-warn); }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: 12px var(--xb-sans); padding: 5px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
</style>
