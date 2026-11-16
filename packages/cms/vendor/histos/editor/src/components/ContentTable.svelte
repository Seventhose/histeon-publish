<script lang="ts">
  import type { Api } from '../lib/api.ts';
  import type { ContentField } from '../lib/contentHub.ts';
  import { STATUSES, cellText, editsInline, fromInput, listQuery, toRow, type RestItem, type Row } from '../lib/contentTable.ts';
  import { t, tn } from '../lib/i18n.ts';
  import FieldValue from './FieldValue.svelte';

  // The contents of a type as a table (Content Hub, docs/spec/content.md §8): title, status and fields edited in
  // place through WordPress's REST API, which checks every permission and sanitizes every value.
  let { api, route, label, fields, adminUrl, routeFor }: { api: Api; route: string; label: string; fields: ContentField[]; adminUrl: string | null; routeFor: (postType: string) => string | null } = $props();

  const PER_PAGE = 20;
  let rows = $state<Row[]>([]);
  let total = $state(0);
  let page = $state(1);
  let status = $state('any');
  let search = $state('');
  let loading = $state(false);
  let message = $state('');
  let saving = $state<Record<string, boolean>>({});
  let newTitle = $state('');
  let open = $state<number | null>(null);

  const pages = $derived(Math.max(1, Math.ceil(total / PER_PAGE)));
  const inline = $derived(fields.filter(editsInline));
  const others = $derived(fields.filter((f) => !editsInline(f)));

  async function load() {
    loading = true;
    message = '';
    try {
      const result = await api.core<RestItem[]>('GET', listQuery(route, page, PER_PAGE, status, search));
      rows = result.data.map(toRow);
      total = result.total;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
      rows = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void route;
    void page;
    void status;
    void load();
  });

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onsearch(value: string) {
    search = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      void load();
    }, 300);
  }

  /** Writes one cell; on refusal the row goes back to what WordPress has. */
  async function save(row: Row, patch: Record<string, unknown>, key: string) {
    saving = { ...saving, [`${row.id}:${key}`]: true };
    message = '';
    try {
      const { data } = await api.core<RestItem>('POST', `${route}/${row.id}?context=edit&_fields=id,status,date,link,title,meta`, patch);
      rows = rows.map((r) => (r.id === row.id ? toRow(data) : r));
    } catch (e) {
      message = `"${row.title || row.id}": ${e instanceof Error ? e.message : String(e)}`;
      void load();
    } finally {
      const { [`${row.id}:${key}`]: _done, ...rest } = saving;
      saving = rest;
    }
  }

  function setTitle(row: Row, title: string) {
    if (title !== row.title) void save(row, { title }, 'title');
  }

  function setField(row: Row, f: ContentField, input: string | boolean) {
    const value = fromInput(f, input);
    if (value === row.meta[f.name] || (value === null && (row.meta[f.name] === '' || row.meta[f.name] === undefined))) return;
    void save(row, { meta: { [f.name]: value } }, f.name);
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    try {
      await api.core<RestItem>('POST', route, { title, status: 'draft' });
      newTitle = '';
      status = 'any';
      page = 1;
      await load();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  const editLink = (id: number): string | null => {
    if (!adminUrl) return null;
    try {
      return new URL(`post.php?post=${id}&action=edit`, adminUrl).toString();
    } catch {
      return null;
    }
  };
  const STATUS_LABEL: Record<string, string> = { publish: t('Pubblicato'), draft: t('Bozza'), pending: t('In revisione'), private: t('Privato'), future: t('Programmato') };
</script>

<div class="table-view">
  <div class="bar">
    <input class="search" type="search" value={search} oninput={(e) => onsearch(e.currentTarget.value)} placeholder={t('Cerca in {0}', label)} aria-label={t('Cerca in {0}', label)} />
    <select bind:value={status} onchange={() => (page = 1)} aria-label={t('Stato')}>
      {#each STATUSES as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
    </select>
    <span class="muted">{loading ? t('caricamento…') : tn('{0} contenuto', '{0} contenuti', total, total)}</span>
    <form onsubmit={create}>
      <input bind:value={newTitle} placeholder={t('Titolo del nuovo contenuto')} aria-label={t('Titolo del nuovo contenuto')} />
      <button type="submit" disabled={!newTitle.trim()}>+ {t('Aggiungi (bozza)')}</button>
    </form>
  </div>
  {#if message}<p class="problem" role="status">{message}</p>{/if}

  <div class="scroll">
    <table aria-label={t('Contenuti: {0}', label)}>
      <thead>
        <tr>
          <th>{t('Titolo')}</th>
          <th>{t('Stato')}</th>
          {#each inline as f (f.name)}<th>{f.label}</th>{/each}
          {#if others.length}<th>{t('Altri campi')}</th>{/if}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr class:busy={Object.keys(saving).some((k) => k.startsWith(`${row.id}:`))}>
            <td class="title"><input value={row.title} onchange={(e) => setTitle(row, e.currentTarget.value)} aria-label={t('Titolo di {0}', row.title || row.id)} /></td>
            <td class="status">{STATUS_LABEL[row.status] ?? row.status}</td>
            {#each inline as f (f.name)}
              {@const value = row.meta[f.name]}
              <td>
                {#if f.type === 'toggle'}
                  <input type="checkbox" checked={!!value} onchange={(e) => setField(row, f, e.currentTarget.checked)} aria-label={t('{0} di {1}', f.label, row.title)} />
                {:else if f.type === 'select'}
                  <select value={typeof value === 'string' ? value : ''} onchange={(e) => setField(row, f, e.currentTarget.value)} aria-label={t('{0} di {1}', f.label, row.title)}>
                    <option value="">—</option>
                    {#each f.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                  </select>
                {:else}
                  <input
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : f.type === 'url' ? 'url' : f.type === 'email' ? 'email' : 'text'}
                    step={f.type === 'number' ? 'any' : undefined}
                    value={value === null || value === undefined ? '' : String(value)}
                    onchange={(e) => setField(row, f, e.currentTarget.value)}
                    aria-label={t('{0} di {1}', f.label, row.title)}
                  />
                {/if}
              </td>
            {/each}
            {#if others.length}
              <td class="others">
                <button class="link" onclick={() => (open = open === row.id ? null : row.id)} aria-expanded={open === row.id}>{t('{0} di {1}', others.map((f) => cellText(f, row.meta[f.name])).filter(Boolean).length, others.length)}</button>
              </td>
            {/if}
            <td class="actions">
              {#if editLink(row.id)}<a href={editLink(row.id)} target="_blank" rel="noopener">{t('Modifica')} ↗</a>{/if}
              {#if row.status === 'publish'}<a href={row.link} target="_blank" rel="noopener">{t('Vedi')} ↗</a>{/if}
            </td>
          </tr>
          {#if open === row.id}
            <tr class="detail">
              <td colspan={3 + inline.length + 1}>
                {#each others as f (f.name)}
                  <div class="field">
                    <strong>{f.label}</strong>
                    <FieldValue {api} field={f} value={row.meta[f.name]} onchange={(v) => void save(row, { meta: { [f.name]: v } }, f.name)} {routeFor} />
                  </div>
                {/each}
              </td>
            </tr>
          {/if}
        {:else}
          {#if !loading}<tr><td colspan={4 + inline.length} class="muted empty">{search ? t('Nessun contenuto trovato: aggiungine uno qui sopra.') : t('Nessun contenuto: aggiungine uno qui sopra.')}</td></tr>{/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if pages > 1}
    <div class="pager">
      <button onclick={() => (page = Math.max(1, page - 1))} disabled={page === 1} aria-label={t('Pagina precedente')}>◂</button>
      <span>{t('Pagina {0} di {1}', page, pages)}</span>
      <button onclick={() => (page = Math.min(pages, page + 1))} disabled={page >= pages} aria-label={t('Pagina successiva')}>▸</button>
    </div>
  {/if}
  <p class="muted note">{t('Le modifiche vanno subito sul sito, come in WordPress: i contenuti non hanno versioni Histeon, le hanno le pagine e i modelli che li mostrano.')}</p>
</div>

<style>
  .table-view { display: grid; gap: 8px; min-width: 0; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .bar form { display: flex; gap: 6px; margin-left: auto; }
  .search { min-width: 180px; }
  input, select { font: 12.5px var(--xb-sans); padding: 4px 6px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  td input:not([type='checkbox']), td select { width: 100%; min-width: 90px; border-color: transparent; background: transparent; }
  td input:hover, td input:focus, td select:hover, td select:focus { border-color: var(--xb-line); background: var(--xb-bg); }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.link { border: 0; padding: 0; color: var(--xb-link); text-decoration: underline; }
  .scroll { overflow: auto; max-height: 60vh; border: 1px solid var(--xb-line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { position: sticky; top: 0; background: var(--xb-panel); text-align: left; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.04em; color: var(--xb-muted); padding: 6px; border-bottom: 1px solid var(--xb-line); z-index: 1; }
  td { padding: 2px 4px; border-bottom: 1px solid var(--xb-line); vertical-align: middle; }
  td.title { min-width: 200px; }
  td.title input { font-weight: 600; }
  td.status { white-space: nowrap; color: var(--xb-muted); }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions a { margin-left: 8px; color: var(--xb-link); }
  tr.busy { opacity: 0.6; }
  tr.detail td { background: var(--xb-panel); padding: 8px; }
  tr.detail .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: center; }
  .muted { color: var(--xb-muted); font-size: 12px; }
  .empty { padding: 16px; text-align: center; }
  .problem { margin: 0; color: var(--xb-danger); font-size: 12px; }
  .note { margin: 0; }
</style>
