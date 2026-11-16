<script lang="ts">
  import type { TemplateItem } from '../../lib/api.ts';
  import { t } from '../../lib/i18n.ts';
  import { openDocument } from '../../lib/nav.ts';
  import type { BuilderState } from '../../lib/state.svelte.ts';

  // Template section: the active theme's templates and parts, grouped, each opened in the builder.
  let { app, newUrl = null }: { app: BuilderState; newUrl?: string | null } = $props();
  let items = $state<TemplateItem[]>([]);
  let message = $state('');
  let busy = $state(false);

  async function load() {
    try {
      items = (await app.api.listTemplates()).items;
      message = items.length ? '' : t('Il tema attivo non ha template.');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }
  $effect(() => {
    void load();
  });

  /** Theme-file templates are written to the database the first time, then opened like any document. */
  async function open(item: TemplateItem) {
    if (item.post) return openDocument(item.post, app.anyDirty);
    busy = true;
    try {
      openDocument((await app.api.openTemplate(item.type, item.id)).post, app.anyDirty);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // Groups as the server classifies them (the same as XB → Template in wp-admin), in its order.
  let filter = $state<string | null>(null);
  let query = $state('');
  const groups = $derived.by(() => {
    const byKey = new Map<string, { key: string; label: string; items: TemplateItem[] }>();
    for (const item of items) {
      const entry = byKey.get(item.group) ?? { key: item.group, label: item.groupLabel, items: [] };
      entry.items.push(item);
      byKey.set(item.group, entry);
    }
    return [...byKey.values()];
  });
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter((g) => filter === null || g.key === filter)
      .map((g) => ({ ...g, items: g.items.filter((i) => q === '' || `${i.title} ${i.slug} ${i.description}`.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  });
</script>

<div class="section">
  {#if message}<p class="message">{message}</p>{/if}
  {#if groups.length > 0}
    <div class="filters">
      <div class="chips" role="group" aria-label={t('Tipi di template')}>
        <button class="chip" class:active={filter === null} aria-pressed={filter === null} onclick={() => (filter = null)}>{t('Tutti')} <span>{items.length}</span></button>
        {#each groups as g (g.key)}
          <button class="chip" class:active={filter === g.key} aria-pressed={filter === g.key} onclick={() => (filter = filter === g.key ? null : g.key)}>{g.label} <span>{g.items.length}</span></button>
        {/each}
      </div>
      <input type="search" bind:value={query} placeholder={t('Cerca un template…')} aria-label={t('Cerca un template')} />
      {#if newUrl}<a class="new" href={newUrl} target="_blank" rel="noopener">{t('+ Nuovo template')}</a>{/if}
    </div>
  {/if}
  {#each shown as g (g.key)}
    <h3>{g.label} <small>{g.items.length}</small></h3>
    <ul>
      {#each g.items as item (item.type + item.id)}
        <li class:current={item.post === app.postId}>
          <button onclick={() => open(item)} disabled={busy || item.post === app.postId}>
            <strong>{item.title}</strong>
            <code>{item.slug}</code>
            {#if item.description}<span class="desc">{item.description}</span>{/if}
            <small class:custom={item.post > 0}>{item.post === app.postId ? t('aperto ora') : item.post ? t('personalizzato') : t('file del tema')}</small>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    {#if groups.length > 0}<p class="message">{t('Nessun template corrisponde.')}</p>{/if}
  {/each}
</div>

<style>
  .new { margin-left: auto; font: 600 13px var(--xb-sans); color: var(--xb-link); text-decoration: none; padding: 6px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); }
  .new:hover { border-color: var(--xb-accent); }
  .section { overflow: auto; height: 100%; }
  h3 { font: 600 12px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.05em; color: var(--xb-muted); margin: 16px 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  button { width: 100%; text-align: left; display: grid; gap: 4px; padding: 12px; border-radius: 8px; border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; font: 13px var(--xb-sans); }
  button:hover:not(:disabled) { border-color: var(--xb-accent); }
  li.current button { border-color: var(--xb-accent); background: var(--xb-accent-bg); }
  code { font: 12px var(--xb-mono); color: var(--xb-muted); }
  small { color: var(--xb-muted); }
  .message { color: var(--xb-muted); }
  h3 small { font-weight: 400; margin-left: 4px; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
  .chip { width: auto; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-weight: 500; }
  .chip span { font-size: 11px; color: var(--xb-muted); }
  .chip.active { border-color: var(--xb-accent); background: var(--xb-accent-bg); color: var(--xb-text); }
  input[type='search'] { font: 13px var(--xb-sans); padding: 6px 10px; border-radius: var(--xb-r); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); min-width: 200px; }
  .desc { font-size: 12px; color: var(--xb-muted); line-height: 1.4; }
  small.custom { color: var(--xb-ok); }
</style>
