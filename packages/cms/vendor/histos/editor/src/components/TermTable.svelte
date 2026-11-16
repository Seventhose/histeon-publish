<script lang="ts">
  import type { Api } from '../lib/api.ts';
  import type { ContentField } from '../lib/contentHub.ts';
  import { cellText, editsInline, fromInput, termEditUrl } from '../lib/contentTable.ts';
  import { t, tn } from '../lib/i18n.ts';

  // The terms of a taxonomy as a table (doc 26 voce 212, docs/spec/content.md §8): name, slug, parent, description
  // and the simple fields of the term edited in place, through WordPress's REST API, which checks every permission
  // (manage_terms, edit_terms, delete_terms) and sanitizes every value.
  let { api, route, taxonomy, label, hierarchical, fields, adminUrl }: {
    api: Api;
    route: string;
    /** The taxonomy's name (`category`, `post_tag`…), which may differ from the last part of its REST route. */
    taxonomy: string;
    label: string;
    hierarchical: boolean;
    fields: ContentField[];
    adminUrl: string | null;
  } = $props();

  type Term = { id: number; name: string; slug: string; parent: number; count: number; description: string; meta: Record<string, unknown> };
  type RestTerm = Partial<Term> & { id: number; meta?: Record<string, unknown> | unknown[] };

  const PER_PAGE = 20;
  const FIELDS = 'id,name,slug,parent,count,description,meta';
  let terms = $state<Term[]>([]);
  /** Every term (up to 100) for the parent menu: id, name, parent. */
  let all = $state<Array<{ id: number; name: string; parent: number }>>([]);
  let total = $state(0);
  let page = $state(1);
  let search = $state('');
  let loading = $state(false);
  let message = $state('');
  let newName = $state('');
  let newParent = $state(0);
  let busy = $state<Record<number, boolean>>({});

  const pages = $derived(Math.max(1, Math.ceil(total / PER_PAGE)));
  const inline = $derived(fields.filter(editsInline));
  const toTerm = (r: RestTerm): Term => ({ id: r.id, name: r.name ?? '', slug: r.slug ?? '', parent: r.parent ?? 0, count: r.count ?? 0, description: r.description ?? '', meta: r.meta && !Array.isArray(r.meta) ? r.meta : {} });

  async function load() {
    loading = true;
    message = '';
    try {
      const params = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page), hide_empty: 'false', context: 'edit', orderby: 'name', _fields: FIELDS });
      if (search.trim()) params.set('search', search.trim());
      const result = await api.core<RestTerm[]>('GET', `${route}?${params}`);
      terms = result.data.map(toTerm);
      total = result.total;
      if (hierarchical) {
        const parents = await api.core<RestTerm[]>('GET', `${route}?per_page=100&hide_empty=false&orderby=name&_fields=id,name,parent`);
        all = parents.data.map((p) => ({ id: p.id, name: p.name ?? '', parent: p.parent ?? 0 }));
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
      terms = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void route;
    void page;
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

  /** One change; on refusal the row goes back to what WordPress has. */
  async function save(term: Term, patch: Record<string, unknown>) {
    busy = { ...busy, [term.id]: true };
    message = '';
    try {
      const { data } = await api.core<RestTerm>('POST', `${route}/${term.id}?context=edit&_fields=${FIELDS}`, patch);
      terms = terms.map((x) => (x.id === term.id ? toTerm(data) : x));
      if ('name' in patch || 'parent' in patch) all = all.map((x) => (x.id === term.id ? { id: x.id, name: data.name ?? x.name, parent: data.parent ?? x.parent } : x));
    } catch (e) {
      message = `"${term.name}": ${e instanceof Error ? e.message : String(e)}`;
      void load();
    } finally {
      const { [term.id]: _done, ...rest } = busy;
      busy = rest;
    }
  }

  function setText(term: Term, key: 'name' | 'slug' | 'description', value: string) {
    if (value !== term[key] && (key === 'description' || value.trim())) void save(term, { [key]: key === 'description' ? value : value.trim() });
  }

  function setField(term: Term, f: ContentField, input: string | boolean) {
    const value = fromInput(f, input);
    if (value === term.meta[f.name]) return;
    void save(term, { meta: { [f.name]: value } });
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await api.core('POST', route, { name, ...(hierarchical && newParent ? { parent: newParent } : {}) });
      if (newName.trim() === name) newName = ''; // What was typed meanwhile stays.
      page = 1;
      await load();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(term: Term) {
    const contents = term.count ? tn('È assegnato a {0} contenuto, che lo perde.', 'È assegnato a {0} contenuti, che lo perdono.', term.count, term.count) : '';
    if (!confirm(`${t('Eliminare il termine «{0}»? Non si può annullare.', term.name)} ${contents}`)) return;
    try {
      await api.core('DELETE', `${route}/${term.id}?force=true`);
      await load();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  /** The parents a term may take: never itself or one of its own descendants. */
  function parentsFor(term: Term): Array<{ id: number; name: string }> {
    const below = new Set<number>([term.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of all) {
        if (below.has(x.id) || !below.has(x.parent)) continue;
        below.add(x.id);
        grew = true;
      }
    }
    return all.filter((x) => !below.has(x.id));
  }

  const termLink = (id: number): string | null => termEditUrl(adminUrl, taxonomy, id);
</script>

<div class="table-view">
  <div class="bar">
    <input class="search" type="search" value={search} oninput={(e) => onsearch(e.currentTarget.value)} placeholder={t('Cerca in {0}', label)} aria-label={t('Cerca in {0}', label)} />
    <span class="muted">{loading ? t('caricamento…') : tn('{0} termine', '{0} termini', total, total)}</span>
    <form onsubmit={create}>
      <input bind:value={newName} placeholder={t('Nome del nuovo termine')} aria-label={t('Nome del nuovo termine')} />
      {#if hierarchical}
        <select bind:value={newParent} aria-label={t('Genitore del nuovo termine')}>
          <option value={0}>{t('— nessun genitore —')}</option>
          {#each all as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </select>
      {/if}
      <button type="submit" disabled={!newName.trim()}>+ {t('Aggiungi')}</button>
    </form>
  </div>
  {#if message}<p class="problem" role="status">{message}</p>{/if}

  <div class="scroll">
    <table aria-label={t('Termini: {0}', label)}>
      <thead>
        <tr>
          <th>{t('Nome')}</th>
          <th>{t('Slug')}</th>
          {#if hierarchical}<th>{t('Genitore')}</th>{/if}
          <th>{t('Descrizione')}</th>
          {#each inline as f (f.name)}<th>{f.label}</th>{/each}
          <th>{t('Contenuti')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each terms as term (term.id)}
          <tr class:busy={busy[term.id]}>
            <td class="title"><input value={term.name} onchange={(e) => setText(term, 'name', e.currentTarget.value)} aria-label={t('Nome di {0}', term.name)} /></td>
            <td><input class="mono" value={term.slug} onchange={(e) => setText(term, 'slug', e.currentTarget.value)} aria-label={t('Slug di {0}', term.name)} /></td>
            {#if hierarchical}
              <td>
                <select value={term.parent} onchange={(e) => void save(term, { parent: Number(e.currentTarget.value) })} aria-label={t('Genitore di {0}', term.name)}>
                  <option value={0}>—</option>
                  {#each parentsFor(term) as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
                </select>
              </td>
            {/if}
            <td><input value={term.description} onchange={(e) => setText(term, 'description', e.currentTarget.value)} aria-label={t('Descrizione di {0}', term.name)} /></td>
            {#each inline as f (f.name)}
              {@const value = term.meta[f.name]}
              <td>
                {#if f.type === 'toggle'}
                  <input type="checkbox" checked={!!value} onchange={(e) => setField(term, f, e.currentTarget.checked)} aria-label={t('{0} di {1}', f.label, term.name)} />
                {:else if f.type === 'select'}
                  <select value={typeof value === 'string' ? value : ''} onchange={(e) => setField(term, f, e.currentTarget.value)} aria-label={t('{0} di {1}', f.label, term.name)}>
                    <option value="">—</option>
                    {#each f.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                  </select>
                {:else}
                  <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : f.type === 'url' ? 'url' : f.type === 'email' ? 'email' : 'text'} value={cellText(f, value)} onchange={(e) => setField(term, f, e.currentTarget.value)} aria-label={t('{0} di {1}', f.label, term.name)} />
                {/if}
              </td>
            {/each}
            <td class="status">{term.count}</td>
            <td class="actions">
              {#if termLink(term.id)}<a href={termLink(term.id)} target="_top">{t('Modifica')}</a>{/if}
              <button class="link danger" onclick={() => void remove(term)}>{t('Elimina')}</button>
            </td>
          </tr>
        {:else}
          {#if !loading}<tr><td colspan={5 + inline.length} class="muted empty">{t('Nessun termine: aggiungine uno qui sopra.')}</td></tr>{/if}
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
  <p class="muted note">{t('Le modifiche vanno subito sul sito, come in WordPress. Le immagini e gli altri campi dei termini si cambiano con «Modifica».')}</p>
</div>

<style>
  .table-view { display: grid; gap: 8px; min-width: 0; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .bar form { display: flex; gap: 6px; margin-left: auto; }
  .search { min-width: 180px; }
  input, select { font: 12.5px var(--xb-sans); padding: 4px 6px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  td input:not([type='checkbox']), td select { width: 100%; min-width: 90px; border-color: transparent; background: transparent; }
  td input:hover, td input:focus, td select:hover, td select:focus { border-color: var(--xb-line); background: var(--xb-bg); }
  .mono { font-family: var(--xb-mono, monospace); }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.link { border: 0; padding: 0; color: var(--xb-link); text-decoration: underline; margin-left: 8px; }
  button.danger { color: var(--xb-danger); }
  .scroll { overflow: auto; max-height: 60vh; border: 1px solid var(--xb-line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { position: sticky; top: 0; background: var(--xb-panel); text-align: left; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.04em; color: var(--xb-muted); padding: 6px; border-bottom: 1px solid var(--xb-line); z-index: 1; }
  td { padding: 2px 4px; border-bottom: 1px solid var(--xb-line); vertical-align: middle; }
  td.title { min-width: 180px; }
  td.title input { font-weight: 600; }
  td.status { white-space: nowrap; color: var(--xb-muted); text-align: right; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions a { color: var(--xb-link); }
  tr.busy { opacity: 0.6; }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: center; }
  .muted { color: var(--xb-muted); font-size: 12px; }
  .empty { padding: 16px; text-align: center; }
  .problem { margin: 0; color: var(--xb-danger); font-size: 12px; }
  .note { margin: 0; }
</style>
