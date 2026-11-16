<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import type { QueryOptions } from '../lib/api.ts';
  import type { QueryType } from '../lib/queries.ts';
  import {
    choiceOf,
    otherKeys,
    POST_ORDERS,
    readAmount,
    readIds,
    readTaxFilters,
    setArg,
    taxFiltersEditable,
    TERM_ORDERS,
    USER_ORDERS,
    writeAmount,
    writeIds,
    writeTaxFilters,
    type Args,
    type TaxFilter,
  } from '../lib/queryForm.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The visual side of a query: what, which ones, in which order, how many. Same arguments as the code view.
  let {
    app,
    type,
    args,
    types,
    onchange,
  }: { app: BuilderState; type: QueryType; args: Args; types: Array<{ name: string; label: string }>; onchange: (args: Args) => void } = $props();

  // Choices (taxonomies, terms, authors) per content type, fetched once.
  const cache = new Map<string, Promise<QueryOptions>>();
  let options = $state<QueryOptions | null>(null);
  const optionsFor = $derived(type === 'terms' ? '' : typeof args.post_type === 'string' ? args.post_type : 'post');
  $effect(() => {
    const key = optionsFor;
    let promise = cache.get(key);
    if (!promise) {
      promise = app.api.queryOptions(key);
      cache.set(key, promise);
    }
    options = null;
    promise.then((o) => {
      if (key === optionsFor) options = o;
    }).catch(() => (options = { taxonomies: [], authors: [] }));
  });

  const set = (key: string, value: unknown) => onchange(setArg(args, key, value));
  const amountKey = $derived(type === 'terms' || type === 'users' ? 'number' : 'posts_per_page');
  const roles = $derived(Array.isArray(args.role__in) ? (args.role__in as unknown[]).filter((r): r is string => typeof r === 'string') : []);
  const amount = $derived(readAmount(args[amountKey], type === 'posts' ? 6 : 10));
  const tax = $derived(readTaxFilters(args));
  const taxEditable = $derived(taxFiltersEditable(args));
  const others = $derived(otherKeys(type, args));
  const orders = $derived(type === 'terms' ? TERM_ORDERS : type === 'users' ? USER_ORDERS : POST_ORDERS);
  // Order and direction may come from the loop ("$orderby ?? date"): the form edits the default, keeps the link.
  const orderby = $derived(choiceOf(args.orderby, type === 'terms' ? 'name' : type === 'users' ? 'display_name' : 'date'));
  const direction = $derived(choiceOf(args.order, type === 'terms' || type === 'users' ? 'ASC' : 'DESC'));
  /** Names of terms found by a search or asked by id, for taxonomies with more than the listed ones. */
  let found = $state<Record<string, string>>({});
  const termName = (taxonomy: string, id: number) => options?.taxonomies.find((x) => x.name === taxonomy)?.terms.find((x) => x.id === id)?.name ?? found[`${taxonomy}:${id}`] ?? `#${id}`;
  /** Per filter row: the search typed and the terms it found. */
  let searches = $state<Record<number, { q: string; results: Array<{ id: number; name: string; count: number }> }>>({});
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function searchTerms(index: number, taxonomy: string, q: string) {
    searches = { ...searches, [index]: { q, results: searches[index]?.results ?? [] } };
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const { terms } = await app.api.queryTerms(taxonomy, q).catch(() => ({ terms: [] }));
      for (const term of terms) found[`${taxonomy}:${term.id}`] = term.name;
      if (searches[index]?.q === q) searches = { ...searches, [index]: { q, results: terms } };
    }, 250);
  }
  // Chosen terms beyond the listed ones get their names once.
  $effect(() => {
    for (const f of tax.filters) {
      const listed = options?.taxonomies.find((x) => x.name === f.taxonomy);
      if (!listed?.more) continue;
      const missing = f.terms.filter((id) => !listed.terms.some((x) => x.id === id) && !(`${f.taxonomy}:${id}` in found));
      if (missing.length) void app.api.queryTerms(f.taxonomy, '', missing).then(({ terms }) => {
        for (const term of terms) found[`${f.taxonomy}:${term.id}`] = term.name;
      });
    }
  });

  function setFilters(filters: TaxFilter[], relation = tax.relation) {
    onchange(writeTaxFilters(args, filters, relation));
  }
  function updateFilter(index: number, change: Partial<TaxFilter>) {
    setFilters(tax.filters.map((f, i) => (i === index ? { ...f, ...change } : f)));
  }
  function addFilter() {
    const first = options?.taxonomies[0]?.name ?? 'category';
    // An empty row lives only in the form until it gets a term (the arguments need at least one).
    draft = [...draft, { taxonomy: first, terms: [], operator: 'IN' }];
  }
  /** Rows being composed: shown with the saved ones, written once they have a term. */
  let draft = $state<TaxFilter[]>([]);
  function updateDraft(index: number, change: Partial<TaxFilter>) {
    const next = { ...(draft[index] as TaxFilter), ...change };
    if (next.terms.length > 0) {
      draft = draft.filter((_, i) => i !== index);
      setFilters([...tax.filters, next]);
    } else draft = draft.map((d, i) => (i === index ? next : d));
  }
  const authors = $derived(readIds(args.author__in));
</script>

<div class="builder">
  {#if type === 'main'}
    <p class="note">{t('La query principale è quella della pagina che si sta guardando (un archivio, una ricerca…): qui si sceglie solo quanti risultati e in che ordine.')}</p>
  {/if}

  {#if type === 'posts'}
    <section>
      <h4>{t('Cosa mostrare')}</h4>
      <label class="field">{t('Tipo di contenuto')}
        <select value={typeof args.post_type === 'string' ? args.post_type : 'post'} onchange={(e) => set('post_type', e.currentTarget.value)}>
          {#each types as ty (ty.name)}<option value={ty.name}>{ty.label}</option>{/each}
          {#if typeof args.post_type === 'string' && !types.some((ty) => ty.name === args.post_type)}<option value={args.post_type}>{t('{0} (non ammesso)', args.post_type)}</option>{/if}
        </select>
      </label>
    </section>

    <section>
      <h4>{t('Filtri')}</h4>
      {#if !taxEditable}
        <p class="note">{t('I filtri per tassonomia di questa query sono scritti nel codice: modificali nella vista Codice.')}</p>
      {:else}
        {#if tax.filters.length > 1}
          <div class="segmented" role="group" aria-label={t('Come combinare i filtri')}>
            <button class:active={tax.relation === 'AND'} onclick={() => setFilters(tax.filters, 'AND')}>{t('Tutti i filtri')}</button>
            <button class:active={tax.relation === 'OR'} onclick={() => setFilters(tax.filters, 'OR')}>{t('Almeno uno')}</button>
          </div>
        {/if}
        {#each [...tax.filters.map((f) => ({ f, saved: true })), ...draft.map((f) => ({ f, saved: false }))] as row, i (i)}
          {@const index = row.saved ? i : i - tax.filters.length}
          {@const update = (change: Partial<TaxFilter>) => (row.saved ? updateFilter(index, change) : updateDraft(index, change))}
          {@const taxonomy = options?.taxonomies.find((x) => x.name === row.f.taxonomy)}
          <div class="filter">
            <select value={row.f.taxonomy} onchange={(e) => update({ taxonomy: e.currentTarget.value, terms: [] })} aria-label={t('Tassonomia')}>
              {#each options?.taxonomies ?? [] as tx (tx.name)}<option value={tx.name}>{tx.label}</option>{/each}
              {#if !taxonomy}<option value={row.f.taxonomy}>{row.f.taxonomy}</option>{/if}
            </select>
            <select value={row.f.operator} onchange={(e) => update({ operator: e.currentTarget.value as TaxFilter['operator'] })} aria-label={t('Condizione')}>
              <option value="IN">{t('è uno di')}</option>
              <option value="NOT IN">{t('non è')}</option>
              <option value="AND">{t('ha tutti')}</option>
            </select>
            <button class="icon" onclick={() => (row.saved ? setFilters(tax.filters.filter((_, j) => j !== index)) : (draft = draft.filter((_, j) => j !== index)))} aria-label={t('Togli il filtro')} title={t('Togli il filtro')}>×</button>
            <div class="chips">
              {#each row.f.terms as id (id)}
                <span class="chip">{termName(row.f.taxonomy, id)}<button onclick={() => update({ terms: row.f.terms.filter((x) => x !== id) })} aria-label={t('Togli {0}', termName(row.f.taxonomy, id))}>×</button></span>
              {/each}
              <select
                class="add"
                value=""
                onchange={(e) => {
                  const id = Number(e.currentTarget.value);
                  if (id) update({ terms: [...row.f.terms, id] });
                  e.currentTarget.value = '';
                }}
                aria-label={t('Aggiungi un termine')}
              >
                <option value="">{t('+ termine…')}</option>
                {#each (taxonomy?.more && searches[i]?.results.length ? searches[i]!.results : (taxonomy?.terms ?? [])).filter((x) => !row.f.terms.includes(x.id)) as term (term.id)}<option value={term.id}>{term.name} ({term.count})</option>{/each}
              </select>
              {#if taxonomy?.more}
                <input class="add" type="search" value={searches[i]?.q ?? ''} oninput={(e) => searchTerms(i, row.f.taxonomy, e.currentTarget.value)} placeholder={t('Cerca fra tutti i termini')} aria-label={t('Cerca un termine di {0}', taxonomy.label)} />
              {/if}
            </div>
          </div>
        {/each}
        <button class="link" onclick={addFilter} disabled={!options || options.taxonomies.length === 0}>{t('+ Filtra per categoria, tag o tassonomia')}</button>
      {/if}

      {#if (options?.authors.length ?? 0) > 0}
        <div class="field">{t('Autori')}
          <div class="chips">
            {#each authors as id (id)}
              <span class="chip">{options?.authors.find((a) => a.id === id)?.name ?? `#${id}`}<button onclick={() => set('author__in', writeIds(authors.filter((a) => a !== id)))} aria-label={t("Togli l'autore")}>×</button></span>
            {/each}
            <select class="add" value="" onchange={(e) => { const id = Number(e.currentTarget.value); if (id) set('author__in', writeIds([...authors, id])); e.currentTarget.value = ''; }} aria-label={t('Aggiungi un autore')}>
              <option value="">{authors.length ? t('+ autore…') : t('Tutti gli autori')}</option>
              {#each (options?.authors ?? []).filter((a) => !authors.includes(a.id)) as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
            </select>
          </div>
        </div>
      {/if}

      <label class="field">{t('Contiene il testo')}
        <input type="search" value={typeof args.s === 'string' ? args.s : ''} onchange={(e) => set('s', e.currentTarget.value.trim())} placeholder={t('parola o frase (facoltativo)')} />
      </label>
    </section>
  {/if}

  {#if type === 'terms'}
    <section>
      <h4>{t('Cosa mostrare')}</h4>
      <label class="field">{t('Tassonomia')}
        <select value={typeof args.taxonomy === 'string' ? args.taxonomy : 'category'} onchange={(e) => set('taxonomy', e.currentTarget.value)}>
          {#each options?.taxonomies ?? [] as tx (tx.name)}<option value={tx.name}>{tx.label}</option>{/each}
          {#if typeof args.taxonomy === 'string' && !(options?.taxonomies ?? []).some((x) => x.name === args.taxonomy)}<option value={args.taxonomy}>{args.taxonomy}</option>{/if}
        </select>
      </label>
      <label class="check"><input type="checkbox" checked={args.hide_empty !== false} onchange={(e) => set('hide_empty', e.currentTarget.checked ? undefined : false)} /> {t('Nascondi i termini senza contenuti')}</label>
      <label class="check"><input type="checkbox" checked={args.parent === 0} onchange={(e) => set('parent', e.currentTarget.checked ? 0 : undefined)} /> {t('Solo il primo livello')}</label>
    </section>
  {/if}

  {#if type === 'users'}
    <section>
      <h4>{t('Chi mostrare')}</h4>
      <p class="note">{t('Solo chi ha contenuti pubblicati, con il profilo pubblico (nome, pagina, avatar, biografia): mai email, nome utente o ruolo.')}</p>
      <div class="field">{t('Ruoli')}
        <div class="chips">
          {#each roles as role (role)}
            <span class="chip">{options?.roles?.find((r) => r.name === role)?.label ?? role}<button onclick={() => set('role__in', roles.filter((r) => r !== role))} aria-label={t('Togli il ruolo')}>×</button></span>
          {/each}
          <select class="add" value="" onchange={(e) => { const role = e.currentTarget.value; if (role) set('role__in', [...roles, role]); e.currentTarget.value = ''; }} aria-label={t('Aggiungi un ruolo')}>
            <option value="">{roles.length ? t('+ ruolo…') : t('Tutti i ruoli')}</option>
            {#each (options?.roles ?? []).filter((r) => !roles.includes(r.name)) as r (r.name)}<option value={r.name}>{r.label}</option>{/each}
          </select>
        </div>
      </div>
    </section>
  {/if}

  <section>
    <h4>{t('Ordine')}</h4>
    <div class="row">
      <select value={orderby.value} onchange={(e) => set('orderby', orderby.write(e.currentTarget.value))} aria-label={t('Ordina per')}>
        {#each orders as [value, label] (value)}<option {value}>{label}</option>{/each}
        {#if !orders.some(([v]) => v === orderby.value)}<option value={orderby.value}>{orderby.value}</option>{/if}
      </select>
      <div class="segmented" role="group" aria-label={t('Verso')}>
        <button class:active={direction.value.toUpperCase() === 'ASC'} onclick={() => set('order', direction.write('ASC'))}>{t('Crescente')}</button>
        <button class:active={direction.value.toUpperCase() !== 'ASC'} onclick={() => set('order', direction.write('DESC'))}>{t('Decrescente')}</button>
      </div>
    </div>
    {#if orderby.param || direction.param}
      <p class="note">{t('Il loop può cambiarli:')} {#if orderby.param}<code>{orderby.param}</code>{/if}{#if orderby.param && direction.param}, {/if}{#if direction.param}<code>{direction.param}</code>{/if}. {t('Qui scegli il valore predefinito.')}</p>
    {/if}
    {#if orderby.value === 'meta_value' || orderby.value === 'meta_value_num'}
      <label class="field">{t('Campo personalizzato')}
        <input value={typeof args.meta_key === 'string' ? args.meta_key : ''} onchange={(e) => set('meta_key', e.currentTarget.value.trim())} placeholder={t('chiave del campo, es. data_evento')} />
      </label>
    {/if}
  </section>

  <section>
    <h4>{t('Quanti')}</h4>
    <div class="row">
      <input class="num" type="number" min="-1" max="100" value={amount.value} onchange={(e) => set(amountKey, writeAmount({ ...amount, value: Number(e.currentTarget.value) }))} aria-label={t('Quanti risultati')} />
      <span class="muted">{type === 'terms' && amount.value <= 0 ? t('tutti') : amount.value < 0 ? t('tutti (fino a 100)') : t('risultati')}</span>
      <label class="check"><input type="checkbox" checked={amount.fromLoop} onchange={(e) => set(amountKey, writeAmount({ ...amount, fromLoop: e.currentTarget.checked }))} /> {t('Il loop può cambiarlo')} (<code>{amount.param}</code>)</label>
    </div>
    <label class="field">{t('Salta i primi')}
      <input class="num" type="number" min="0" max="1000" value={typeof args.offset === 'number' ? args.offset : 0} onchange={(e) => set('offset', Number(e.currentTarget.value) > 0 ? Number(e.currentTarget.value) : undefined)} />
    </label>
    {#if type === 'posts'}
      <label class="check"><input type="checkbox" checked={args.ignore_sticky_posts === false} onchange={(e) => set('ignore_sticky_posts', e.currentTarget.checked ? false : undefined)} /> {t('Metti prima gli articoli in evidenza')}</label>
      <details>
        <summary>{t('Contenuti precisi')}</summary>
        <label class="field">{t('Solo questi (ID separati da virgole)')}
          <input value={readIds(args.post__in).join(', ')} onchange={(e) => set('post__in', writeIds(readIds(e.currentTarget.value)))} placeholder={t('es. 12, 48')} />
        </label>
        <label class="field">{t('Escludi (ID)')}
          <input value={readIds(args.post__not_in).join(', ')} onchange={(e) => set('post__not_in', writeIds(readIds(e.currentTarget.value)))} placeholder={t('es. 7')} />
        </label>
      </details>
    {/if}
  </section>

  {#if others.length > 0}
    <p class="note">{t('Altri parametri, modificabili nella vista Codice:')} {#each others as k, i (k)}<code>{k}</code>{i < others.length - 1 ? ', ' : ''}{/each}.</p>
  {/if}
</div>

<style>
  .builder { display: grid; gap: 4px; align-content: start; font-size: 13px; }
  section { display: grid; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--xb-line); }
  h4 { margin: 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .field { display: grid; gap: 4px; color: var(--xb-muted); font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  select, input:not([type='checkbox']) { font: 13px var(--xb-sans); padding: 5px 8px; border-radius: var(--xb-r); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); min-width: 0; }
  .num { width: 80px; }
  .check { display: flex; gap: 6px; align-items: center; color: var(--xb-text); font-size: 12.5px; }
  .muted { color: var(--xb-muted); }
  .note { margin: 4px 0; color: var(--xb-muted); font-size: 12px; }
  .filter { display: grid; grid-template-columns: minmax(0, 1fr) auto 28px; gap: 6px; padding: 8px; border: 1px solid var(--xb-line); border-radius: 8px; background: var(--xb-panel); }
  .filter .chips { grid-column: 1 / -1; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 10px; border-radius: 999px; background: var(--xb-accent-bg); font-size: 12px; }
  .chip button, .icon { border: 0; background: none; cursor: pointer; color: var(--xb-muted); font-size: 14px; padding: 0 6px; }
  .add { border-style: dashed !important; color: var(--xb-muted) !important; }
  .link { justify-self: start; border: 0; background: none; color: var(--xb-link); cursor: pointer; padding: 2px 0; font: 600 12.5px var(--xb-sans); }
  .link:disabled { opacity: 0.5; cursor: default; }
  .segmented { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--xb-hover); }
  .segmented button { border: 0; background: none; padding: 4px 10px; border-radius: var(--xb-r); cursor: pointer; color: var(--xb-muted); font: 12px var(--xb-sans); }
  .segmented button.active { background: var(--xb-bg); color: var(--xb-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
  details summary { cursor: pointer; color: var(--xb-muted); font-size: 12px; }
  details { display: grid; gap: 6px; }
</style>
