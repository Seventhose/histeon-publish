<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import { parse } from '@xb/dsl';
  import type { FacetTest, ProviderField, QueriesData, QueryOptions } from '../lib/api.ts';
  import { blankFacet, blankFilter, FACET_STYLES, facetProblem, facetSnippet, nameProblem, ORDER_LABELS, ORDERS, type Facet, type Facets, type FilterKind } from '../lib/facets.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Facets (docs/spec/facets.md): filters, sorting and pages of a list. Saved in dev with the site settings and
  // published with a release; pages read them as facets.<name>. "Prova" runs the facet as a visitor would.
  let { app }: { app: BuilderState } = $props();

  let facets = $state<Facets>({});
  let saved = $state('{}');
  let head = $state('');
  let base = $state('');
  let queries = $state<QueriesData | null>(null);
  let fields = $state<ProviderField[]>([]);
  let publicIds = $state<string[]>([]);
  let options = $state<QueryOptions | null>(null);
  let selected = $state<string | null>(null);
  let newName = $state('');
  let message = $state('');
  let busy = $state(false);
  let params = $state<Record<string, string>>({});
  let test = $state<FacetTest | null>(null);
  let testing = $state(false);
  /** Nothing is created before the saved filters arrive: they would replace it. */
  let loaded = $state(false);

  const names = $derived(Object.keys(facets).sort());
  const current = $derived(selected ? (facets[selected] ?? null) : null);
  const dirty = $derived(JSON.stringify(facets) !== saved);
  /** Names WordPress reads from the address for this site's types and taxonomies: not usable as parameters. */
  const siteNames = $derived([...(queries?.types ?? []).map((ty) => ty.name), ...(options?.taxonomies ?? []).map((tx) => tx.name)]);
  const problem = $derived(current ? facetProblem(current, siteNames) : null);
  /** Custom queries that list posts: the ones a facet can filter. */
  const postQueries = $derived(Object.entries(queries?.presets ?? {}).filter(([, p]) => (p.type ?? 'posts') === 'posts').map(([n]) => n).sort());
  const type = $derived.by(() => {
    if (!current) return 'post';
    if (current.query === 'posts') return current.type;
    const postType = queries?.presets[current.query]?.args?.post_type;
    return typeof postType === 'string' ? postType : 'post';
  });
  /** Fields a filter may compare: public, one short value, defined for the type. */
  const usableFields = $derived(
    fields.filter(
      (f) =>
        (!f.postTypes.length || f.postTypes.includes(type)) &&
        ['text', 'select', 'radio', 'number', 'toggle', 'true_false', 'date', 'date_picker', 'button_group', 'email', 'url', 'switcher', 'range'].includes(f.type) &&
        (f.provider === 'xb' || f.rest || publicIds.includes(f.id)),
    ),
  );

  async function load() {
    try {
      const [doc, q, content] = await Promise.all([app.api.getFacets(), app.api.getQueries(), app.api.getContent()]);
      facets = JSON.parse(JSON.stringify(doc.facets ?? {})) as Facets;
      saved = JSON.stringify(facets);
      head = doc.head;
      base = doc.base;
      queries = q;
      fields = content.providers.flatMap((p) => p.fields);
      publicIds = content.publicFields;
      if (selected && !facets[selected]) selected = null;
      loaded = true;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }
  void load();

  $effect(() => {
    const postType = type;
    if (!current) return;
    app.api.queryOptions(postType).then(
      (o) => (options = o),
      () => (options = null),
    );
  });

  function create() {
    if (!loaded) return;
    const name = newName.trim();
    const p = nameProblem(name, names);
    if (p) {
      message = p;
      return;
    }
    facets = { ...facets, [name]: blankFacet(queries?.types[0]?.name ?? 'post') };
    selected = name;
    newName = '';
    message = '';
    test = null;
  }

  function remove(name: string) {
    const { [name]: _gone, ...rest } = facets;
    facets = rest;
    if (selected === name) selected = null;
  }

  function update(patch: Partial<Facet>) {
    if (!selected || !current) return;
    facets = { ...facets, [selected]: { ...current, ...patch } };
  }

  function addFilter(kind: FilterKind) {
    if (!current) return;
    update({ filters: [...current.filters, blankFilter(kind, [current.pageKey, ...current.filters.map((f) => f.key)])] });
  }

  function setFilter(i: number, patch: Record<string, unknown>) {
    if (!current) return;
    update({ filters: current.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  }

  function moveFilter(i: number, delta: -1 | 1) {
    if (!current) return;
    const list = [...current.filters];
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    update({ filters: list });
  }

  async function save() {
    busy = true;
    message = '';
    try {
      const res = await app.api.saveFacets($state.snapshot(facets), head, base);
      head = res.head;
      base = res.base;
      saved = JSON.stringify(facets);
      message = t('Filtri salvati in sviluppo: arrivano al sito con la prossima release.');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function run() {
    if (!current) return;
    testing = true;
    try {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v.trim() !== ''));
      test = await app.api.testFacet($state.snapshot(current), clean);
    } catch (e) {
      test = { error: e instanceof Error ? e.message : String(e), total: 0, pages: 0, titles: [], filters: [] };
    } finally {
      testing = false;
    }
  }

  function insert() {
    if (!selected || !current) return;
    for (const [selector, css] of Object.entries(FACET_STYLES)) if (!app.styles.some((s) => s.selector === selector)) app.upsertStyle(selector, css);
    app.insert(parse(facetSnippet(selected, current)).blocks);
    app.status = { kind: 'idle', message: t('Inseriti i filtri «{0}»: form, risultati e pagine. Si modificano come ogni elemento.', selected) };
  }
</script>

<div class="facets">
  <aside class="list">
    <h3>{t('Filtri dei loop')}</h3>
    <ul>
      {#each names as name (name)}
        <li><button class:active={selected === name} aria-pressed={selected === name} onclick={() => ((selected = name), (test = null), (params = {}))}>{name}</button></li>
      {/each}
    </ul>
    <form class="new" onsubmit={(e) => (e.preventDefault(), create())}>
      <input aria-label={t('Nome dei nuovi filtri')} placeholder={t('eventi')} bind:value={newName} />
      <button type="submit" disabled={!loaded}>{t('Crea')}</button>
    </form>
    <div class="actions">
      <button class="primary" disabled={!dirty || busy || !!problem} onclick={save}>{t('Salva i filtri')}</button>
    </div>
    {#if message}<p class="msg" role="status">{message}</p>{/if}
  </aside>

  {#if current && selected}
    <section class="edit" aria-label={t('Filtri {0}', selected)}>
      <div class="row">
        <label>Query
          <select value={current.query} onchange={(e) => update({ query: e.currentTarget.value })}>
            <option value="posts">{t('Contenuti di un tipo')}</option>
            {#each postQueries as q (q)}<option value={q}>{q}</option>{/each}
          </select>
        </label>
        {#if current.query === 'posts'}
          <label>{t('Tipo')}
            <select value={current.type} onchange={(e) => update({ type: e.currentTarget.value })}>
              {#each queries?.types ?? [] as ty (ty.name)}<option value={ty.name}>{ty.label}</option>{/each}
            </select>
          </label>
        {/if}
        <label>{t('Per pagina')} <input type="number" min="1" max="100" value={current.perPage} oninput={(e) => update({ perPage: Number(e.currentTarget.value) })} /></label>
        <label>{t('Parametro della pagina')} <input value={current.pageKey} oninput={(e) => update({ pageKey: e.currentTarget.value.trim() })} /></label>
        <button class="danger" onclick={() => selected && remove(selected)}>{t('Elimina')}</button>
      </div>

      <ol class="filters">
        {#each current.filters as f, i (i)}
          <li>
            <div class="row">
              <strong>{({ search: t('Ricerca'), taxonomy: t('Tassonomia'), field: t('Campo'), range: t('Intervallo'), sort: t('Ordinamento') })[f.kind]}</strong>
              <label>{t('Etichetta')} <input value={f.label} oninput={(e) => setFilter(i, { label: e.currentTarget.value })} /></label>
              <label>{t('Parametro')} <input value={f.key} oninput={(e) => setFilter(i, { key: e.currentTarget.value.trim() })} /></label>
              {#if f.kind === 'taxonomy'}
                <label>{t('Tassonomia')}
                  <select value={f.taxonomy} onchange={(e) => setFilter(i, { taxonomy: e.currentTarget.value })}>
                    {#each options?.taxonomies ?? [] as tx (tx.name)}<option value={tx.name}>{tx.label}</option>{/each}
                  </select>
                </label>
                <label class="check"><input type="checkbox" checked={f.multiple !== false} onchange={(e) => setFilter(i, { multiple: e.currentTarget.checked })} /> {t('più scelte')}</label>
                {#if f.multiple !== false}
                  <label>{t('Con più scelte')}
                    <select value={f.match ?? 'any'} onchange={(e) => setFilter(i, { match: e.currentTarget.value })}>
                      <option value="any">{t('almeno una')}</option>
                      <option value="all">{t('tutte')}</option>
                    </select>
                  </label>
                {/if}
              {:else if f.kind === 'field' || f.kind === 'range'}
                <label>{t('Campo')}
                  <select value={f.field} onchange={(e) => setFilter(i, { field: e.currentTarget.value })}>
                    <option value="">{t('Scegli…')}</option>
                    {#each usableFields as fd (fd.id)}<option value={fd.id}>{fd.label} ({fd.provider})</option>{/each}
                  </select>
                </label>
                {#if f.kind === 'range'}
                  <label>{t('Confronta')}
                    <select value={f.type ?? 'number'} onchange={(e) => setFilter(i, { type: e.currentTarget.value })}>
                      <option value="number">{t('numeri')}</option>
                      <option value="date">{t('date')}</option>
                    </select>
                  </label>
                {/if}
              {/if}
              <span class="tools">
                <button aria-label={t('Sposta su {0}', f.label)} onclick={() => moveFilter(i, -1)}>↑</button>
                <button aria-label={t('Sposta giù {0}', f.label)} onclick={() => moveFilter(i, 1)}>↓</button>
                <button aria-label={t('Togli {0}', f.label)} onclick={() => update({ filters: current.filters.filter((_, j) => j !== i) })}>✕</button>
              </span>
            </div>
            {#if f.kind === 'sort'}
              <ul class="sorts">
                {#each f.options ?? [] as o, k (k)}
                  <li>
                    <input aria-label={t('Valore')} value={o.value} oninput={(e) => setFilter(i, { options: f.options?.map((x, n) => (n === k ? { ...x, value: e.currentTarget.value.trim() } : x)) })} />
                    <input aria-label={t('Etichetta')} value={o.label} oninput={(e) => setFilter(i, { options: f.options?.map((x, n) => (n === k ? { ...x, label: e.currentTarget.value } : x)) })} />
                    <select aria-label={t('Ordina per')} value={o.orderby} onchange={(e) => setFilter(i, { options: f.options?.map((x, n) => (n === k ? { ...x, orderby: e.currentTarget.value } : x)) })}>
                      {#each ORDERS as by (by)}<option value={by}>{ORDER_LABELS[by]}</option>{/each}
                    </select>
                    {#if o.orderby === 'field'}
                      <select aria-label={t('Campo')} value={o.field ?? ''} onchange={(e) => setFilter(i, { options: f.options?.map((x, n) => (n === k ? { ...x, field: e.currentTarget.value } : x)) })}>
                        <option value="">{t('Scegli…')}</option>
                        {#each usableFields as fd (fd.id)}<option value={fd.id}>{fd.label}</option>{/each}
                      </select>
                    {/if}
                    <select aria-label={t('Verso')} value={o.order} onchange={(e) => setFilter(i, { options: f.options?.map((x, n) => (n === k ? { ...x, order: e.currentTarget.value } : x)) })}>
                      <option value="desc">{t('decrescente')}</option>
                      <option value="asc">{t('crescente')}</option>
                    </select>
                    <button aria-label={t("Togli l'opzione {0}", o.label)} onclick={() => setFilter(i, { options: f.options?.filter((_, n) => n !== k) })}>✕</button>
                  </li>
                {/each}
                <li><button onclick={() => setFilter(i, { options: [...(f.options ?? []), { value: `opzione${(f.options?.length ?? 0) + 1}`, label: t('Opzione'), orderby: 'date', order: 'desc' }] })}>{t('+ opzione')}</button></li>
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
      <div class="row add">
        {t('Aggiungi:')}
        <button onclick={() => addFilter('search')}>{t('Ricerca')}</button>
        <button onclick={() => addFilter('taxonomy')}>{t('Tassonomia')}</button>
        <button onclick={() => addFilter('field')}>{t('Campo')}</button>
        <button onclick={() => addFilter('range')}>{t('Intervallo')}</button>
        <button onclick={() => addFilter('sort')}>{t('Ordinamento')}</button>
      </div>
      {#if problem}<p class="warn" role="alert">{problem}</p>{/if}

      <div class="try">
        <h4>{t('Prova come un visitatore')}</h4>
        <div class="row">
          {#each current.filters as f (f.key)}
            <label>{f.label || f.key} <input aria-label={t('Prova {0}', f.key)} placeholder={f.kind === 'taxonomy' ? 'slug1,slug2' : ''} value={params[f.key] ?? ''} oninput={(e) => (params = { ...params, [f.key]: e.currentTarget.value })} /></label>
          {/each}
          <label>{current.pageKey} <input aria-label={t('Prova pagina')} value={params[current.pageKey] ?? ''} oninput={(e) => (params = { ...params, [current.pageKey]: e.currentTarget.value })} /></label>
          <button disabled={testing || !!problem} onclick={run}>{t('Prova')}</button>
          <button class="primary" disabled={!!problem} onclick={insert}>{t('Inserisci nella pagina')}</button>
        </div>
        {#if test}
          {#if test.error}<p class="warn">{test.error}</p>
          {:else}
            <p class="result" role="status">{tn('{0} risultati, {1} pagina', '{0} risultati, {1} pagine', test.pages, test.total, test.pages)}</p>
            <ol class="titles">{#each test.titles as title, n (n)}<li>{title}</li>{/each}</ol>
            {#each test.filters.filter((x) => x.options.length) as x (x.key)}
              <p class="opts"><strong>{x.label || x.key}:</strong> {#each x.options as o, n (o.value)}{n ? ', ' : ''}<span class:sel={o.selected}>{o.label}{o.count === null ? '' : ` (${o.count})`}</span>{/each}</p>
            {/each}
          {/if}
        {/if}
      </div>
    </section>
  {:else}
    <section class="edit empty">
      <p>{t("I filtri fanno scegliere ai visitatori cosa vedere in un elenco: ricerca, categorie, campi, ordine e pagine. Funzionano anche senza JavaScript e, se c'è, aggiornano i risultati senza ricaricare.")}</p>
      <p>{t('Crea dei filtri a sinistra, provali e inseriscili nella pagina; nelle espressioni si leggono come')} <code>facets.nome</code>.</p>
    </section>
  {/if}
</div>

<style>
  .facets { display: grid; grid-template-columns: 220px 1fr; gap: 16px; font-size: 13px; height: 100%; }
  .list { border-right: 1px solid var(--xb-line); padding-right: 12px; display: grid; align-content: start; gap: 8px; }
  h3 { margin: 0; font-size: 13px; }
  h4 { margin: 12px 0 6px; font-size: 13px; }
  ul, ol { margin: 0; padding: 0; list-style: none; }
  .list li button { width: 100%; text-align: left; }
  .list li button.active { background: var(--xb-accent); color: #fff; border-color: var(--xb-accent); }
  .new { display: flex; gap: 4px; }
  .new input { flex: 1; min-width: 0; }
  .edit { overflow: auto; padding-bottom: 24px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  label { display: grid; gap: 2px; color: var(--xb-muted); }
  label.check { display: flex; align-items: center; gap: 4px; }
  .filters > li { border: 1px solid var(--xb-line); border-radius: var(--xb-r); padding: 8px; margin-top: 8px; }
  .filters strong { min-width: 90px; }
  .tools { margin-left: auto; display: flex; gap: 2px; }
  .sorts { margin-top: 6px; display: grid; gap: 4px; }
  .sorts li { display: flex; gap: 4px; }
  .add { margin-top: 8px; color: var(--xb-muted); }
  .try { border-top: 1px solid var(--xb-line); margin-top: 12px; }
  .titles { list-style: decimal; padding-left: 20px; }
  .sel { font-weight: 700; }
  .warn { color: var(--xb-danger); }
  .msg { color: var(--xb-muted); }
  .empty { color: var(--xb-muted); max-width: 60ch; }
  input, select { font: 12px var(--xb-sans); padding: 3px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  button.danger { color: var(--xb-danger); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
