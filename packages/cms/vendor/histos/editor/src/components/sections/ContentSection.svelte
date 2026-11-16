<script lang="ts">
  import { untrack } from 'svelte';
  import { t, dateLocale } from '../../lib/i18n.ts';
  import type { LibraryItem } from '../../lib/api.ts';
  import { openDocument } from '../../lib/nav.ts';
  import type { BuilderState } from '../../lib/state.svelte.ts';

  // Content section: the site's pages, posts and components, each opened in the builder.
  let { app, initial = 'page' }: { app: BuilderState; initial?: 'page' | 'post' | 'wp_block' } = $props();

  const TYPES = [
    ['page', t('Pagine')],
    ['post', t('Articoli')],
    ['wp_block', t('Componenti')],
  ] as const;
  let type = $state<'page' | 'post' | 'wp_block'>(untrack(() => initial));
  let search = $state('');
  let items = $state<LibraryItem[]>([]);
  let message = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    try {
      items = (await app.api.library(type, search)).items;
      message = items.length ? '' : t('Nessun contenuto.');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void type;
    void load();
  });

  function onsearch() {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  }

  const STATUS: Record<string, string> = { publish: t('Pubblicato'), draft: t('Bozza'), private: t('Privato'), future: t('Programmato'), pending: t('In revisione') };
  const date = (iso: string) => new Date(iso).toLocaleString(dateLocale());
</script>

<div class="section">
  <div class="bar">
    <div class="types" role="tablist" aria-label={t('Tipo di contenuto')}>
      {#each TYPES as [id, label] (id)}
        <button role="tab" aria-selected={type === id} class:active={type === id} onclick={() => (type = id)}>{label}</button>
      {/each}
    </div>
    <input bind:value={search} oninput={onsearch} placeholder={t('Cerca…')} aria-label={t('Cerca nei contenuti')} />
  </div>
  {#if message}<p class="message">{message}</p>{/if}
  <table>
    <thead><tr><th>{t('Titolo')}</th><th>{type === 'wp_block' ? t('Chiave') : 'Slug'}</th><th>{t('Stato')}</th><th>{t('Modificato')}</th><th><span class="sr">{t('Azioni')}</span></th></tr></thead>
    <tbody>
      {#each items as item (item.id)}
        <tr class:current={item.id === app.postId}>
          <td><strong>{item.title || t('(senza titolo)')}</strong>{#if !item.xb}<span class="tag">Gutenberg</span>{/if}</td>
          <td><code>{type === 'wp_block' ? item.ref || '—' : item.slug}</code></td>
          <td>{STATUS[item.status] ?? item.status}</td>
          <td>{date(item.modified)}</td>
          <td class="actions">
            {#if item.id === app.postId}<span class="tag">{t('aperto')}</span>{:else}<button onclick={() => openDocument(item.id, app.anyDirty)}>{t('Apri')}</button>{/if}
            {#if item.url}<a href={item.url} target="_blank" rel="noopener">{t('Vedi')}</a>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .section { display: grid; grid-template-rows: auto auto 1fr; gap: 8px; height: 100%; min-height: 0; }
  .bar { display: flex; gap: 12px; align-items: center; }
  .types { display: flex; gap: 4px; }
  .types button { font: 13px var(--xb-sans); padding: 6px 12px; border-radius: var(--xb-r); border: 1px solid transparent; background: transparent; color: var(--xb-muted); cursor: pointer; }
  .types button.active { background: var(--xb-accent-bg); color: var(--xb-text); border-color: var(--xb-line); }
  input { flex: 1; max-width: 320px; font: 13px var(--xb-sans); padding: 6px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); color: var(--xb-text); }
  .message { margin: 0; color: var(--xb-muted); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; display: block; overflow: auto; min-height: 0; }
  thead, tbody, tr { display: table; width: 100%; table-layout: fixed; }
  th { text-align: left; font-weight: 600; color: var(--xb-muted); padding: 8px; border-bottom: 1px solid var(--xb-line); position: sticky; top: 0; background: var(--xb-panel); }
  td { padding: 8px; border-bottom: 1px solid var(--xb-line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr.current td { background: var(--xb-accent-bg); }
  th:nth-child(1), td:nth-child(1) { width: 38%; }
  .actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
  .actions button, .actions a { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; text-decoration: none; }
  .tag { font-size: 11px; color: var(--xb-muted); border: 1px solid var(--xb-line); border-radius: 999px; padding: 0 6px; margin-left: 6px; }
</style>
