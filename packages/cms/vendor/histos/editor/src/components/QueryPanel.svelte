<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';
  import { untrack } from 'svelte';
  import { parse, randomUid } from '@xb/dsl';
  import CodeEditor from './CodeEditor.svelte';
  import QueryBuilder from './QueryBuilder.svelte';
  import DataPreview from './DataPreview.svelte';
  import JsonSourceEditor from './JsonSourceEditor.svelte';
  import type { JsonSource, QueriesData, QueryGroup, QueryRecord } from '../lib/api.ts';
  import { blankPreset, GALLERY, galleryName, GROUP_VARIABLE, loopSnippet, nameProblem, parameters, parseArgs, variableFor, type Preset, type Presets, type QueryType } from '../lib/queries.ts';
  import { GROUPINGS, groupByOf } from '../lib/loopGroups.ts';
  import { columns, shapeOf, type Json, type Row } from '../lib/jsonTable.ts';
  import { summary, type Args } from '../lib/queryForm.ts';
  import { canWrapInLoop, describe, wrapInGroups, wrapInLoop } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Data manager: queries and JSON sources, saved in dev with the site settings and published with a release
  // (docs/spec/queries.md, docs/spec/data.md). Loops use them as {#loop name(param: value) as item} or
  // {#loop data.name as item}; anywhere else a record is read as {data.name[0].key}.
  let { app, visible }: { app: BuilderState; visible: boolean } = $props();

  let data = $state<QueriesData | null>(null);
  let presets = $state<Presets>({});
  let sources = $state<Record<string, JsonSource>>({});
  let saved = $state('{}');
  let savedSources = $state('{}');
  let selected = $state<string | null>(null);
  /** The JSON source being edited (a query and a source are never selected together). */
  let source = $state<string | null>(null);
  let argsText = $state('{}');
  let argsError = $state('');
  let newName = $state('');
  let paramsText = $state('{}');
  let results = $state<QueryRecord[] | null>(null);
  /** The groups of the loop in groups, when one is chosen (doc 23 of Publish, item 205). */
  let groups = $state<QueryGroup[] | null>(null);
  /** How the loop put in the page groups the query's result: '' none, or one of GROUPINGS (the loop's source.groupBy). */
  let grouping = $state('');
  let loading = $state(false);
  let previewError = $state('');
  /** Visual form or JSON: the same arguments either way. */
  let view = $state<'visual' | 'code'>('visual');
  /** The loop's `count` used by the preview (when the query reads it). */
  let previewCount = $state(3);
  let message = $state('');
  let busy = $state(false);

  const names = $derived(Object.keys(presets).sort());
  const current = $derived(selected ? (presets[selected] ?? null) : null);
  /** Groups by date or title: contents only (the page's own query too), not terms or people. */
  const groupable = $derived(current?.type === 'posts' || current?.type === 'main');
  const groupBy = $derived(groupable ? groupByOf(grouping) : undefined);
  const groupKey = `{${GROUP_VARIABLE}.key}`;
  const groupItems = `{${GROUP_VARIABLE}.items}`;
  const sourceNames = $derived(Object.keys(sources).sort());
  const dirty = $derived(JSON.stringify(presets) !== saved || JSON.stringify(sources) !== savedSources);
  const taken = $derived([...names, ...sourceNames]);

  async function refresh() {
    try {
      const fresh = await app.api.getQueries();
      // A plain copy of the response: the editable list must not share objects with `data`.
      presets = JSON.parse(JSON.stringify(fresh.presets ?? {})) as Presets;
      sources = JSON.parse(JSON.stringify(fresh.sources ?? {})) as Record<string, JsonSource>;
      data = fresh;
      saved = JSON.stringify(presets);
      savedSources = JSON.stringify(sources);
      if (source && !sources[source]) source = null;
      if (selected && !presets[selected]) selected = null;
      if (selected) argsText = JSON.stringify(presets[selected]?.args ?? {}, null, 2);
    } catch (e) {
      message = errorText(e);
    }
  }

  $effect(() => {
    if (visible && !data) void refresh();
  });

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function choose(name: string) {
    source = null;
    selected = name;
    argsText = JSON.stringify(presets[name]?.args ?? {}, null, 2);
    argsError = '';
    results = null;
    groups = null;
    grouping = '';
    paramsText = JSON.stringify(Object.fromEntries(parameters(presets[name]?.args).filter((p) => p !== 'count').map((p) => [p, ''])));
    message = '';
  }

  /** From the visual form: the arguments change, the code view follows. */
  function onform(args: Args) {
    if (!selected || !current) return;
    presets = { ...presets, [selected]: { ...current, args } };
    argsText = JSON.stringify(args, null, 2);
    argsError = '';
  }

  // The preview follows every valid change, shortly after it (a visitor's view: published, readable content).
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewAbort: AbortController | null = null;
  $effect(() => {
    const name = selected;
    const preset = current ? JSON.stringify(current) : '';
    void previewCount;
    void paramsText;
    void groupBy;
    if (!name || !preset || argsError) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => untrack(() => void runPreview()), 350);
  });

  async function runPreview() {
    if (!selected || !current) return;
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(paramsText.trim() || '{}') as Record<string, unknown>;
    } catch {
      previewError = t('Parametri di prova: JSON non valido.');
      return;
    }
    // An empty test value means "not passed": the query's own default applies, as in a loop without it.
    params = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));
    if (parameters(current.args).includes('count')) params.count = previewCount;
    previewAbort?.abort();
    const abort = new AbortController();
    previewAbort = abort;
    loading = true;
    try {
      const answer = await app.api.testQuery(selected, current as Preset, params, abort.signal, groupBy);
      results = answer.items;
      groups = groupBy ? (answer.groups ?? []) : null;
      previewError = '';
    } catch (e) {
      if (abort.signal.aborted) return;
      previewError = errorText(e);
      results = null;
      groups = null;
    } finally {
      if (previewAbort === abort) loading = false;
    }
  }

  const variable = $derived(current ? variableFor(current.type) : 'item');

  // ---- JSON sources
  function createSource() {
    const name = newName.trim();
    const problem = nameProblem(name, taken);
    if (problem) {
      message = problem;
      return;
    }
    sources = { ...sources, [name]: { type: 'json', data: [{ nome: 'Primo', valore: '' }] } };
    newName = '';
    chooseSource(name);
  }
  function chooseSource(name: string) {
    selected = null;
    source = name;
    message = '';
  }
  const current_source = $derived(source ? (sources[source] ?? null) : null);
  /** A source read from an address (doc 26 voce 214): its preview is what «Prova» last read. */
  let remoteSample = $state<Json | null>(null);
  let remoteError = $state('');
  let remoteBusy = $state(false);
  let hosts = $state<{ hosts: string[]; canChange: boolean } | null>(null);
  let newHost = $state('');
  const sourceValue = $derived(!current_source ? null : current_source.type === 'json' ? ((current_source.data ?? null) as Json) : remoteSample);
  function setSource(value: Json) {
    if (source) sources = { ...sources, [source]: { type: 'json', data: value } };
  }
  function setRemote(patch: { url?: string; path?: string; ttl?: number }) {
    if (!source) return;
    const now = current_source?.type === 'url' ? current_source : { type: 'url' as const, url: 'https://', path: '', ttl: 60 };
    sources = { ...sources, [source]: { ...now, ...patch } };
  }
  function setSourceKind(kind: 'json' | 'url') {
    if (!source || current_source?.type === kind) return;
    remoteSample = null;
    remoteError = '';
    if (kind === 'url') {
      setRemote({});
      if (!hosts) void app.api.sourceHosts().then((h) => (hosts = h)).catch(() => (hosts = { hosts: [], canChange: false }));
    } else sources = { ...sources, [source]: { type: 'json', data: [{ nome: 'Primo', valore: '' }] } };
  }
  async function testRemote() {
    if (current_source?.type !== 'url') return;
    remoteBusy = true;
    remoteError = '';
    try {
      remoteSample = (await app.api.testSource(current_source.url, current_source.path ?? '')).data as Json;
    } catch (e) {
      remoteSample = null;
      remoteError = e instanceof Error ? e.message : String(e);
    } finally {
      remoteBusy = false;
    }
  }
  async function saveHosts(next: string[]) {
    try {
      hosts = await app.api.saveSourceHosts(next);
    } catch (e) {
      remoteError = e instanceof Error ? e.message : String(e);
    }
  }
  $effect(() => {
    if (current_source?.type === 'url' && !hosts) void app.api.sourceHosts().then((h) => (hosts = h)).catch(() => (hosts = { hosts: [], canChange: false }));
  });
  function removeSource() {
    if (!source || !window.confirm(t('Eliminare la sorgente "{0}"? Ciò che la legge nella pagina resterà vuoto.', source))) return;
    const { [source]: _gone, ...rest } = sources;
    sources = rest;
    source = null;
  }
  /** The JSON as records for the preview: rows of a table, or the one object. */
  const sourceRecords = $derived.by((): QueryRecord[] | null => {
    if (!source) return null;
    const value = sourceValue;
    const rows: unknown[] = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    return rows.map((row) => {
      const entries = row && typeof row === 'object' && !Array.isArray(row) ? Object.entries(row as Record<string, unknown>) : [['valore', row] as [string, unknown]];
      const fields = entries.map(([path, v]) => ({
        path,
        kind: (typeof v === 'number' ? 'number' : Array.isArray(v) ? 'list' : typeof v === 'string' && /^https?:\/\/\S+\.(jpe?g|png|gif|webp|avif|svg)$/i.test(v) ? 'image' : typeof v === 'string' && /^https?:\/\//.test(v) ? 'url' : 'text') as QueryRecord['fields'][number]['kind'],
        value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''),
      }));
      return { title: String(entries.find(([, v]) => typeof v === 'string')?.[1] ?? ''), url: '', fields };
    });
  });
  const sourceIsList = $derived(Array.isArray(sourceValue));

  function wrapSource() {
    if (!source || !app.selected) return;
    app.setTree(wrapInLoop(app.tree, app.selected, { kind: 'expr', expr: `data.${source}` }, 'item', randomUid));
    message = t('"{0}" ora si ripete per ogni riga di "{1}": usa le chiavi a destra (es. {2}).', selectedLabel, source, `{item.${columns((sourceIsList ? sourceValue : []) as Row[])[0] ?? t('chiave')}}`);
  }
  function insertSourceLoop() {
    if (!source) return;
    const keys = columns((sourceIsList ? sourceValue : []) as Row[]).slice(0, 3);
    const body = keys.length ? keys.map((k) => `<span>{item.${k}}</span>`).join(' ') : '{item}';
    try {
      app.insert(parse(`<ul>{#loop data.${source} as item}<li>${body}</li>{/loop}</ul>`).blocks);
      message = t('Loop su "{0}" inserito nella pagina.', source);
    } catch (e) {
      message = errorText(e);
    }
  }
  const wrappable = $derived(canWrapInLoop(app.tree, app.selected));
  const selectedLabel = $derived.by(() => {
    const block = app.selected ? app.find(app.selected) : null;
    return block ? describe(block) : '';
  });

  /** Wrap in a loop: the selected element becomes the template repeated for every record. */
  function wrap() {
    if (!selected || !current || !app.selected) return;
    const args: Record<string, string> = parameters(current.args).includes('count') ? { count: String(previewCount) } : {};
    if (groupBy) {
      // A title per group, then the selected element for each of its contents (item 205).
      app.setTree(wrapInGroups(app.tree, app.selected, { kind: 'preset', id: selected, args, groupBy }, GROUP_VARIABLE, variable, randomUid));
      message = t('"{0}" ora si ripete per ogni risultato di "{1}", in gruppi: ogni gruppo ha il suo titolo ({2}) e i suoi contenuti.', selectedLabel, selected, groupKey);
      return;
    }
    app.setTree(wrapInLoop(app.tree, app.selected, { kind: 'preset', id: selected, args }, variable, randomUid));
    message = t('"{0}" ora si ripete per ogni risultato di "{1}": usa le chiavi a destra (es. {2}) nei suoi testi.', selectedLabel, selected, `{${variable}.title}`);
  }

  /** A key of the record as text, inside or after the selected element. */
  function insertExpression(expression: string) {
    try {
      app.insert(parse(expression).blocks);
    } catch (e) {
      message = errorText(e);
    }
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const problem = nameProblem(newName.trim(), taken);
    if (problem) {
      message = problem;
      return;
    }
    const name = newName.trim();
    presets = { ...presets, [name]: blankPreset() };
    newName = '';
    choose(name);
  }

  /** A ready query from the gallery (lista della spesa 165), added and chosen; saving makes it real. */
  function addFromGallery(index: string) {
    const entry = GALLERY[Number(index)];
    if (!entry) return;
    const name = galleryName(entry.name, taken);
    presets = { ...presets, [name]: structuredClone(entry.preset) };
    choose(name);
    message = t('Query «{0}» aggiunta dalla galleria: {1} Salvala, poi inseriscila nella pagina.', name, entry.description);
  }

  /** Each type has its own arguments: switching starts from that type's defaults (the old ones mean nothing there). */
  function setType(type: QueryType) {
    if (!selected || !current || current.type === type) return;
    const fresh = blankPreset(type);
    presets = { ...presets, [selected]: fresh };
    argsText = JSON.stringify(fresh.args, null, 2);
    argsError = '';
  }

  function onargs(text: string) {
    argsText = text;
    const parsed = parseArgs(text);
    if ('error' in parsed) {
      argsError = parsed.error;
      return;
    }
    argsError = '';
    if (selected && current) presets = { ...presets, [selected]: { ...current, args: parsed.args } };
  }

  function removeSelected() {
    if (!selected || !window.confirm(t('Eliminare la query "{0}"? I loop che la usano resteranno vuoti.', selected))) return;
    const { [selected]: _gone, ...rest } = presets;
    presets = rest;
    selected = null;
  }

  async function save() {
    if (!data || argsError) return;
    busy = true;
    message = '';
    try {
      const done = await app.api.saveQueries(presets, data.head, data.base, sources);
      data = { ...data, head: done.head, base: done.base };
      saved = JSON.stringify(presets);
      savedSources = JSON.stringify(sources);
      message = t('Query e dati salvati in sviluppo: si vedono in anteprima e vanno online con la prossima release.');
      void app.refreshPreview();
    } catch (e) {
      message = errorText(e);
    } finally {
      busy = false;
    }
  }

  function insert() {
    if (!selected || !current) return;
    try {
      app.insert(parse(loopSnippet(selected, current, groupBy)).blocks);
      message = t('Loop "{0}" inserito nella pagina: modificalo nel pannello HTML.', selected);
    } catch (e) {
      message = errorText(e);
    }
  }
</script>

<div class="panel">
  <header>
    <!-- Until the site's queries arrive, nothing can be added: the load would replace what was just added. -->
    <form onsubmit={create}>
      <input bind:value={newName} placeholder={t('nome')} aria-label={t('Nome della nuova query')} disabled={!data} />
      <button type="submit" disabled={!data}>{t('Nuova query')}</button>
      <button type="button" onclick={createSource} title={t('Dati scritti da te: orari, sedi, listini…')} disabled={!data}>{t('Nuova sorgente JSON')}</button>
      <select aria-label={t('Galleria di query pronte')} value="" disabled={!data} onchange={(e) => { addFromGallery(e.currentTarget.value); e.currentTarget.value = ''; }}>
        <option value="">{t('Dalla galleria…')}</option>
        {#each GALLERY as entry, i (entry.name)}
          {#if !entry.needs || (data?.types ?? []).some((x) => x.name === entry.needs)}<option value={String(i)} title={entry.description}>{entry.label}</option>{/if}
        {/each}
      </select>
    </form>
    <button class="primary" onclick={save} disabled={!dirty || busy || !!argsError}>{t('Salva query e dati')}{dirty ? ' •' : ''}</button>
  </header>

  {#if message}<p class="message" role="status">{message}</p>{/if}

  <div class="body">
    <ul class="list" aria-label="Query">
      <li class="group">Query</li>
      {#each names as name (name)}
        {@const preset = presets[name] as Preset}
        <li>
          <button class:active={selected === name} onclick={() => choose(name)}>
            <span class="name">{name}</span>
            <small>{summary(preset.type, preset.args, { types: Object.fromEntries((data?.types ?? []).map((x) => [x.name, x.label])) })}</small>
          </button>
        </li>
      {:else}
        <li class="empty">{t('Nessuna query tua: le predefinite')} <code>posts</code>, <code>terms</code>, <code>users</code> {t('e')} <code>main</code> {t('sono sempre disponibili. Creane una per filtrare, ordinare e riusare.')}</li>
      {/each}
      <li class="group">{t('Sorgenti JSON')}</li>
      {#each sourceNames as name (name)}
        {@const def = sources[name]}
        {@const value = def?.type === 'json' ? def.data : undefined}
        <li>
          <button class:active={source === name} onclick={() => chooseSource(name)}>
            <span class="name">{name}</span>
            <small>{def?.type === 'url' ? t('da indirizzo') : Array.isArray(value) ? t('{0} righe', value.length) : value && typeof value === 'object' ? t('{0} chiavi', Object.keys(value).length) : t('valore')} · data.{name}</small>
          </button>
        </li>
      {:else}
        <li class="empty">{t('Dati scritti da te (orari, sedi, listini…), letti con')} <code>{'{data.nome[0].chiave}'}</code> {t('o ripetuti in un loop.')}</li>
      {/each}
    </ul>

    {#if selected && current}
      <section class="edit" aria-label="Query {selected}">
        <div class="row top">
          <div class="segmented" role="tablist" aria-label={t('Tipo di query')}>
            {#each [['posts', t('Contenuti')], ['terms', t('Categorie e termini')], ['users', t('Utenti')], ['main', t('Della pagina')]] as [value, label] (value)}
              <button role="tab" aria-selected={current.type === value} class:active={current.type === value} onclick={() => setType(value as QueryType)}>{label}</button>
            {/each}
          </div>
          <div class="segmented" role="tablist" aria-label={t('Vista')}>
            <button role="tab" aria-selected={view === 'visual'} class:active={view === 'visual'} onclick={() => (view = 'visual')}>{t('Visuale')}</button>
            <button role="tab" aria-selected={view === 'code'} class:active={view === 'code'} onclick={() => (view = 'code')}>{t('Codice')}</button>
          </div>
        </div>

        {#if view === 'visual'}
          {#if argsError}<p class="problem">{t('Il codice ha un errore: correggilo nella vista Codice prima di usare la vista visuale. {0}', argsError)}</p>{/if}
          <QueryBuilder {app} type={current.type} args={current.args} types={data?.types ?? []} onchange={onform} />
        {:else}
          <p class="help">
            {t('Parametri della query in JSON')} (<code>WP_Query</code> / <code>get_terms</code>). <code>"$count ?? 6"</code> {t('prende il parametro')} <code>count</code> {t('del loop, con 6 se manca.')}
            {t('Solo contenuti pubblicati e leggibili da chi visita')}{#if data?.types.length}{t('; tipi ammessi: {0}', data.types.map((x) => x.name).join(', '))}{/if}.
          </p>
          <div class="code">
            <CodeEditor value={argsText} language="javascript" onchange={onargs} label={t('Parametri della query {0}', selected)} />
          </div>
          {#if argsError}<p class="problem">{argsError}</p>{/if}
        {/if}

        <div class="use">
          <h4>{t('Usala nella pagina')}</h4>
          {#if groupable}
            <!-- Doc 23 of Publish, item 205: the same groupings as Gutenberg's loop panel, written as the loop's groupBy. -->
            <label class="grouping">
              {t('In gruppi')}
              <select bind:value={grouping} aria-label={t('Raggruppa il risultato nel loop')}>
                <option value="">{t('No, un elemento per contenuto')}</option>
                {#each GROUPINGS as option (option.value)}<option value={option.value}>{option.label()}</option>{/each}
              </select>
            </label>
            {#if groupBy}<p class="help">{t('Ogni ripetizione è un gruppo: il titolo in {0}, i contenuti in {1}.', groupKey, groupItems)} {t('La query resta una sola: il loop ne divide il risultato.')}</p>{/if}
          {/if}
          <div class="row">
            <button class="primary" onclick={wrap} disabled={!wrappable} title={wrappable ? '' : t("Seleziona nella pagina l'elemento da ripetere (una scheda, una riga…)")}>
              <Icon name="loop" size={14} /> {wrappable ? t('Avvolgi in un loop: {0}', selectedLabel) : t('Avvolgi in un loop')}
            </button>
            <button onclick={insert}>{t('Inserisci un loop nuovo')}</button>
            <button class="danger" onclick={removeSelected}>{t('Elimina la query')}</button>
          </div>
          {#if !wrappable}<p class="help">{t("Seleziona nella pagina l'elemento da ripetere (una scheda, una riga di tabella…) e avvolgilo: diventa il modello, ripetuto per ogni risultato.")}</p>{/if}
        </div>
      </section>

      <aside class="data">
        {#if parameters(current.args).includes('count') || parameters(current.args).some((p) => p !== 'count')}
          <div class="row params">
            {#if parameters(current.args).includes('count')}
              <label>{t('Prova con')} <code>count</code> = <input class="num" type="number" min="-1" max="100" bind:value={previewCount} /></label>
            {/if}
            {#if parameters(current.args).some((p) => p !== 'count')}
              <label class="grow">{t('Altri parametri')} <input bind:value={paramsText} aria-label={t('Parametri di prova in JSON')} /></label>
            {/if}
          </div>
        {/if}
        <DataPreview records={results} {groups} group={GROUP_VARIABLE} {variable} direct={current.type === 'main' ? undefined : `data.${selected}`} {loading} error={previewError} oninsert={app.selected ? insertExpression : undefined} />
      </aside>
    {:else if source && current_source}
      <section class="edit" aria-label={t('Sorgente {0}', source)}>
        <p class="help">{t('Sorgente')} <code>data.{source}</code>{t(': dati scritti da te, con versioni come il resto. Si pubblicano con la prossima release.')}</p>
        <div class="segmented" role="tablist" aria-label={t('Origine dei dati')}>
          <button role="tab" aria-selected={current_source?.type !== 'url'} class:active={current_source?.type !== 'url'} onclick={() => setSourceKind('json')}>{t('Scritti qui')}</button>
          <button role="tab" aria-selected={current_source?.type === 'url'} class:active={current_source?.type === 'url'} onclick={() => setSourceKind('url')}>{t('Da un indirizzo')}</button>
        </div>
        {#if current_source?.type === 'url'}
          <div class="remote">
            <label>{t('Indirizzo del JSON')} <input class="mono" value={current_source.url} onchange={(e) => setRemote({ url: e.currentTarget.value.trim() })} placeholder="https://" /></label>
            <label>{t('Parte da usare (facoltativa)')} <input class="mono" value={current_source.path ?? ''} onchange={(e) => setRemote({ path: e.currentTarget.value.trim() })} placeholder="items" /></label>
            <label>{t('Rileggi ogni (minuti)')} <input type="number" min="5" max="1440" value={current_source.ttl ?? 60} onchange={(e) => setRemote({ ttl: Number(e.currentTarget.value) })} /></label>
            <button onclick={() => void testRemote()} disabled={remoteBusy}>{remoteBusy ? t('Leggo…') : t('Prova')}</button>
            {#if remoteError}<p class="problem" role="alert">{remoteError}</p>{/if}
            <p class="help">{t('Solo https e solo dagli host consentiti. Il sito tiene una copia per il tempo scelto; se il servizio non risponde, resta l’ultima copia buona. Static Bridge e Histeon Publish usano i dati del momento in cui costruiscono la pagina.')}</p>
            {#if hosts}
              <p class="help">{t('Host consentiti:')} {hosts.hosts.length ? hosts.hosts.join(', ') : t('nessuno')}</p>
              {#if hosts.canChange}
                <form class="row" onsubmit={(e) => { e.preventDefault(); if (newHost.trim()) void saveHosts([...hosts!.hosts, newHost.trim()]).then(() => (newHost = '')); }}>
                  <input bind:value={newHost} placeholder="api.esempio.it" aria-label={t('Host da consentire')} />
                  <button type="submit" disabled={!newHost.trim()}>{t('Consenti')}</button>
                  {#each hosts.hosts as h (h)}<button type="button" class="chip" onclick={() => void saveHosts(hosts!.hosts.filter((x) => x !== h))} aria-label={t('Togli {0}', h)}>{h} ×</button>{/each}
                </form>
              {/if}
            {/if}
          </div>
        {:else}
          <JsonSourceEditor name={source} value={sourceValue} onchange={setSource} />
        {/if}
        <div class="use">
          <h4>{t('Usala nella pagina')}</h4>
          <div class="row">
            {#if sourceIsList}
              <button class="primary" onclick={wrapSource} disabled={!wrappable} title={wrappable ? '' : t("Seleziona nella pagina l'elemento da ripetere")}><Icon name="loop" size={14} /> {wrappable ? t('Avvolgi in un loop: {0}', selectedLabel) : t('Avvolgi in un loop')}</button>
              <button onclick={insertSourceLoop}>{t('Inserisci un loop nuovo')}</button>
            {/if}
            <button class="danger" onclick={removeSource}>{t('Elimina la sorgente')}</button>
          </div>
        </div>
      </section>
      <aside class="data">
        <DataPreview records={sourceRecords} variable={sourceIsList ? 'item' : `data.${source}`} direct={sourceIsList ? `data.${source}` : undefined} kind="json" loading={false} error="" oninsert={app.selected ? insertExpression : undefined} />
      </aside>
    {:else}
      <div class="placeholder">
        <p><strong>{t('Query e sorgenti JSON sono i dati delle tue pagine.')}</strong></p>
        <p>{t('Una query prende contenuti, termini o autori del sito; una sorgente JSON contiene dati scritti da te. Scegline una a sinistra o creane una nuova: a destra vedi subito i dati, con le espressioni da usare nella pagina, dentro un loop o in qualunque punto.')}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .remote { display: grid; gap: 6px; }
  .remote label { display: grid; gap: 2px; }
  .panel {
    display: grid;
    grid-template-rows: auto auto 1fr;
    height: 100%;
    min-height: 0;
    font-size: 13px;
  }
  header {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--xb-line);
  }
  header form {
    display: flex;
    gap: 6px;
  }
  input {
    font: 12px var(--xb-mono);
    padding: 4px 6px;
    background: var(--xb-bg);
    color: var(--xb-text);
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
  }
  button {
    font: 12px var(--xb-sans);
    padding: 4px 10px;
    border-radius: var(--xb-r-sm);
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
  }
  button.primary {
    background: var(--xb-accent);
    border-color: var(--xb-accent);
    color: #fff;
  }
  button.danger {
    color: var(--xb-danger);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .message {
    margin: 0;
    padding: 6px 12px;
    color: var(--xb-muted);
  }
  .body {
    display: grid;
    grid-template-columns: 220px minmax(320px, 1fr) minmax(320px, 1fr);
    min-height: 0;
  }
  .data {
    padding: 10px 14px;
    border-left: 1px solid var(--xb-line);
    overflow: auto;
    min-height: 0;
    display: grid;
    gap: 10px;
    align-content: start;
  }
  .grouping { display: flex; gap: 6px; align-items: center; color: var(--xb-muted); font-size: 12px; }
  .grouping select { font: 12px var(--xb-sans); padding: 3px 6px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .params label { display: flex; gap: 6px; align-items: center; color: var(--xb-muted); font-size: 12px; }
  .num { width: 64px; }
  .placeholder { grid-column: 2 / -1; padding: 24px; color: var(--xb-muted); max-width: 560px; }
  .placeholder p { margin: 0 0 8px; }
  .name { font-family: var(--xb-mono); }
  .group { padding: 10px 8px 4px; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .list small { display: block; font-family: var(--xb-sans); margin-top: 2px; }
  .segmented { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--xb-hover); }
  .segmented button { border: 0; padding: 4px 10px; border-radius: var(--xb-r); color: var(--xb-muted); }
  .segmented button.active { background: var(--xb-bg); color: var(--xb-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
  .top { justify-content: space-between; }
  .use { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--xb-line); }
  .use h4 { margin: 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .list {
    list-style: none;
    margin: 0;
    padding: 8px;
    border-right: 1px solid var(--xb-line);
    overflow: auto;
  }
  .list button {
    width: 100%;
    text-align: left;
    border-color: transparent;
    font-family: var(--xb-mono);
  }
  .list button {
    padding: 8px 10px;
    border-radius: var(--xb-r);
  }
  .list button.active {
    background: var(--xb-accent-bg);
    border-color: var(--xb-accent);
    color: var(--xb-text);
  }
  .list small {
    opacity: 0.7;
  }
  .empty {
    color: var(--xb-muted);
    padding: 6px;
  }
  .edit {
    display: grid;
    align-content: start;
    gap: 8px;
    padding: 8px 12px;
    min-height: 0;
    overflow: auto;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .grow input {
    flex: 1;
  }
  .help {
    margin: 0;
    color: var(--xb-muted);
    font-size: 12px;
  }
  .code {
    min-height: 160px;
    border: 1px solid var(--xb-line);
  }
  .problem {
    margin: 0;
    color: var(--xb-danger);
  }
</style>
