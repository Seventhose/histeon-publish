<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReviewData } from '../lib/api.ts';
    import type { BuilderState } from '../lib/state.svelte.ts';
  import { t, dateLocale } from '../lib/i18n.ts';

  // Comments and approval from the signed preview (docs/spec/review.md): who wrote what, on which element.
  let { app, onshow, oncount }: { app: BuilderState; onshow: () => void; oncount: (open: number) => void } = $props();

  let data = $state<ReviewData>({ comments: [], approval: null });
  let filter = $state<'open' | 'resolved'>('open');
  let error = $state('');
  const shown = $derived(data.comments.filter((c) => c.status === filter));
  const when = (at: number) => new Date(at * 1000).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });

  async function load() {
    try {
      data = await app.api.reviewComments(app.postId);
      oncount(data.comments.filter((c) => c.status === 'open').length);
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(load);

  async function status(id: number, next: 'open' | 'resolved') {
    try {
      await app.api.setCommentStatus(id, next);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function remove(id: number) {
    if (!window.confirm(t('Eliminare il commento? Non si recupera.'))) return;
    try {
      await app.api.deleteComment(id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function show(uid: string) {
    app.select(uid);
    onshow();
  }
</script>

<div class="comments">
  {#if data.approval}
    <p class="approval" class:stale={!data.approval.current} role="status">
      {t('Approvata da')} <strong>{data.approval.name}</strong> {t('il {0}', when(data.approval.at))}{data.approval.current ? t(': è la versione in sviluppo di adesso.') : t(', ma la pagina è cambiata dopo: chiedi una nuova approvazione.')}
    </p>
  {/if}
  <div class="bar">
    <button class:on={filter === 'open'} aria-pressed={filter === 'open'} onclick={() => (filter = 'open')}>{t('Da fare')} <b>{data.comments.filter((c) => c.status === 'open').length}</b></button>
    <button class:on={filter === 'resolved'} aria-pressed={filter === 'resolved'} onclick={() => (filter = 'resolved')}>{t('Risolti')} <b>{data.comments.filter((c) => c.status === 'resolved').length}</b></button>
    <button class="again" onclick={load}>{t('Aggiorna')}</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  {#if shown.length === 0}
    <p class="empty">
      {filter === 'open' ? t('Nessun commento da fare.') : t('Nessun commento risolto.')} {t('Chi ha il link di')}
      <b>{t('Anteprima')}</b> ({t('Nuova scheda')}) {t('può commentare un elemento della pagina e approvare la versione che vede.')}
    </p>
  {:else}
    <ul>
      {#each shown as c (c.id)}
        {@const block = app.find(c.uid)}
        <li>
          <div class="meta"><strong>{c.author}</strong> · {when(c.at)}</div>
          <p class="text">{c.text}</p>
          <div class="actions">
            {#if block}<button onclick={() => show(c.uid)}>{t("Mostra l'elemento")}</button>{:else}<span class="gone">{t('elemento non più nella pagina')}</span>{/if}
            {#if c.status === 'open'}<button onclick={() => status(c.id, 'resolved')}>{t('Risolto')}</button>{:else}<button onclick={() => status(c.id, 'open')}>{t('Riapri')}</button>{/if}
            <button class="danger" onclick={() => remove(c.id)}>{t('Elimina')}</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .comments { display: grid; gap: 12px; align-content: start; max-width: 760px; }
  .approval { margin: 0; padding: 10px 12px; border-radius: var(--xb-r); background: color-mix(in srgb, var(--xb-ok) 12%, transparent); color: var(--xb-text); font-size: 13px; }
  .approval.stale { background: color-mix(in srgb, var(--xb-coral) 16%, transparent); }
  .bar { display: flex; gap: 6px; flex-wrap: wrap; }
  button { font: 500 12.5px var(--xb-sans); padding: 5px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  .bar button { border-radius: 999px; }
  .bar button.on { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); }
  .again { margin-left: auto; border-radius: var(--xb-r) !important; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { padding: 10px 12px; border: 1px solid var(--xb-line); border-left: 3px solid var(--xb-coral); border-radius: var(--xb-r); background: var(--xb-bg); display: grid; gap: 6px; }
  .meta { font-size: 12px; color: var(--xb-muted); }
  .meta strong { color: var(--xb-text); }
  .text { margin: 0; white-space: pre-wrap; font-size: 13.5px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .danger { color: var(--xb-danger); }
  .gone, .empty { color: var(--xb-muted); font-size: 12.5px; }
  .empty { margin: 0; }
  .error { color: var(--xb-danger); margin: 0; }
</style>
