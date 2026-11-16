<script lang="ts">
  import { untrack } from 'svelte';
  import { classesOf } from '../lib/clip.ts';
  import { planSheetMove } from '../lib/scss.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t, tn } from '../lib/i18n.ts';

  // «Porta i blocchi nei selettori» (docs/spec/styles.md §11): every used block's rules leave the global sheets for
  // its selector, nested as SCSS, in one step to undo. A preview first: what moves, what stays and why.
  let { app, only, onclose }: { app: BuilderState; only?: string; onclose: () => void } = $props();

  /** Classes in use: documents and templates as saved in dev (GET /selectors), plus this page as it is now. */
  let saved = $state<Set<string> | null>(null);
  let truncated = $state(false);
  let error = $state('');
  let done = $state('');
  let showKept = $state(false);

  async function loadUsage() {
    try {
      const list = await app.api.listSelectors();
      const names = new Set<string>();
      for (const row of list.selectors) {
        if (row.unused) continue;
        const name = row.rename ?? /^\.(-?[_a-zA-Z][\w-]*)$/.exec(row.selector)?.[1];
        if (name) names.add(name);
      }
      saved = names;
      truncated = list.truncated;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  $effect(() => {
    untrack(() => {
      app.flushEdits(); // pending edits of the sheet first: the preview reads the sheets as they will be saved
      void loadUsage();
    });
  });

  const used = $derived(saved ? new Set([...saved, ...classesOf(app.tree)]) : null);
  const plan = $derived(used ? planSheetMove(app.globals, app.styles, used, only) : null);
  const MAX_LISTED = 40;

  function apply() {
    app.flushEdits();
    const p = plan;
    if (!p || p.moved === 0) return;
    app.moveToSelector(p.entries, p.sheets);
    done = t('Spostate {0} in {1}. Ctrl+Z annulla tutto in un passo.', tn('{0} regola', '{0} regole', p.moved, p.moved), tn('{0} selettore', '{0} selettori', p.blocks.length, p.blocks.length));
  }

</script>

<div class="bulk" role="region" aria-label={t('Porta i blocchi nei selettori')}>
  <div class="head">
    <strong>{t('Porta i blocchi nei selettori')}{only ? ` (${t('foglio {0}', only)})` : ''}</strong>
    <button class="close" onclick={onclose} aria-label={t('Chiudi')} title={t('Chiudi')}>×</button>
  </div>
  {#if done}
    <p class="done" role="status">{done}</p>
  {/if}
  {#if error}
    <p class="error" role="status">{error}</p>
  {:else if !plan}
    <p class="note">{t("Calcolo dell'uso delle classi…")}</p>
  {:else}
    <p class="summary" aria-label={t('Riepilogo')}>
      {#if plan.moved > 0}
        <b>{tn('{0} blocco', '{0} blocchi', plan.blocks.length, plan.blocks.length)}</b>, <b>{tn('{0} regola spostata', '{0} regole spostate', plan.moved, plan.moved)}</b> {t('nel proprio selettore, annidate come in SCSS.')}
      {:else}
        {t('Nessuna regola da spostare.')}
      {/if}
    </p>
    {#if plan.cascade.length || plan.shared || plan.unused.rules}
      <ul class="kept" aria-label={t('Regole che restano nel foglio')}>
        {#if plan.cascade.length}
          <li>
            <button class="link" aria-expanded={showKept} onclick={() => (showKept = !showKept)}>{showKept ? '▾' : '▸'} {tn('{0} regola resta', '{0} regole restano', plan.cascade.length, plan.cascade.length)}</button>
            {t("per la cascata: più in basso un'altra regola tocca le stesse proprietà e, spostata, passerebbe davanti.")}
            {#if showKept}
              <ul class="list">
                {#each plan.cascade.slice(0, MAX_LISTED) as k, i (i)}
                  <li><code>{k.selector}</code> → {t('dopo')} <code>{k.against}</code> <small>({k.property})</small></li>
                {/each}
                {#if plan.cascade.length > MAX_LISTED}<li>{t('… e altre {0}', plan.cascade.length - MAX_LISTED)}</li>{/if}
              </ul>
            {/if}
          </li>
        {/if}
        {#if plan.shared}<li>{tn('{0} regola condivisa resta', '{0} regole condivise restano', plan.shared, plan.shared)}: {t('nominano anche altre classi')} (<code>.a, .b</code>, <code>.x .card</code>) {t('o stanno in @keyframes, @scope…')}</li>{/if}
        {#if plan.unused.rules}
          <li>{t('{0} di {1} da pagine o template:', tn('{0} regola resta', '{0} regole restano', plan.unused.rules, plan.unused.rules), tn('{0} blocco non usato', '{0} blocchi non usati', plan.unused.blocks.length, plan.unused.blocks.length))} <code>{plan.unused.blocks.slice(0, 12).map((b) => `.${b}`).join(' ')}</code>{plan.unused.blocks.length > 12 ? '…' : ''}</li>
        {/if}
      </ul>
    {/if}
    {#if plan.blocks.length}
      <ul class="list blocks" aria-label={t('Blocchi da spostare')}>
        {#each plan.blocks.slice(0, MAX_LISTED) as b (b.selector)}
          <li><code>{b.selector}</code> {tn('{0} regola', '{0} regole', b.rules, b.rules)}{b.existing ? ` · ${t('prima del suo CSS')}` : ''}</li>
        {/each}
        {#if plan.blocks.length > MAX_LISTED}<li>{t('… e altri {0}', plan.blocks.length - MAX_LISTED)}</li>{/if}
      </ul>
    {/if}
    <p class="note">
      {t("L'uso viene dagli stili salvati in sviluppo e da questa pagina; le classi aggiunte da script non si vedono")}{truncated ? ` (${t('troppi documenti: conteggio parziale, i blocchi non trovati restano nel foglio')})` : ''}. {t('I blocchi che nessuno usa restano nel foglio: da eliminare o spostare a mano.')}
    </p>
    <div class="actions">
      <button class="primary" disabled={plan.moved === 0} onclick={apply}>{tn('Sposta {0} regola', 'Sposta {0} regole', plan.moved, plan.moved)}</button>
      <button onclick={onclose}>{t('Annulla')}</button>
    </div>
  {/if}
</div>

<style>
  .bulk { margin: 6px 8px; padding: 6px 8px 8px; border: 1px solid var(--xb-accent); border-radius: var(--xb-r); background: color-mix(in srgb, var(--xb-accent) 5%, transparent); font-size: 12px; display: grid; gap: 6px; max-height: min(45vh, 55cqh); overflow: auto; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .close { border: 0; background: none; color: var(--xb-muted); font-size: 16px; cursor: pointer; padding: 0 4px; }
  p { margin: 0; }
  .note { color: var(--xb-muted); font-size: 11.5px; }
  .error { color: var(--xb-danger); }
  .done { color: var(--xb-text); background: var(--xb-accent-bg); padding: 4px 6px; border-radius: var(--xb-r-sm); }
  .kept { margin: 0; padding-left: 16px; color: var(--xb-muted); display: grid; gap: 2px; }
  .list { margin: 2px 0 0; padding-left: 16px; }
  .list code, .kept code { font: 11.5px var(--xb-mono); overflow-wrap: anywhere; }
  .blocks { max-height: 140px; overflow: auto; color: var(--xb-muted); }
  .link { border: 0; background: none; padding: 0; color: var(--xb-text); font: 600 12px var(--xb-sans); cursor: pointer; }
  .actions { display: flex; gap: 6px; }
  .actions button { font: 12px var(--xb-sans); padding: 3px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  .actions .primary { border-color: var(--xb-accent); background: var(--xb-accent); color: #fff; font-weight: 600; }
  .actions button:disabled { opacity: 0.5; cursor: default; }
</style>
