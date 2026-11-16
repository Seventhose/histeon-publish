<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import NamedQueries from './NamedQueries.svelte';
  import { untrack } from 'svelte';
  import CodeEditor from './CodeEditor.svelte';
  import BulkMove from './BulkMove.svelte';
  import { cssCompletions } from '../lib/cssActions.ts';
  import { safeUrl } from '../lib/config.ts';
  import { describePlan, filterSelectors, usageLabel, validClassName, type SelectorOrigin, type SelectorSort } from '../lib/selectors.ts';
  import type { RenamePlan, SelectorList, SelectorUsage } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Selector manager: every selector with its usage; view and edit its CSS, rename, delete.
  // Usage, rename and delete work on what is saved in dev (docs/spec/styles.md §4).
  /** `canManage`: may change the site settings, the safelist among them (C6). */
  let { app, visible, canManage = false }: { app: BuilderState; visible: boolean; canManage?: boolean } = $props();

  /** Classes added by scripts, props or widgets are not seen in the pages: the safelist keeps them (C6). */
  async function safelist(selector: string, on: boolean) {
    busy = true;
    message = '';
    try {
      await app.api.setSafelisted(selector, on);
      await refresh();
      message = on ? t('{0} è nella safelist: sempre incluso, non più «inutilizzato».', selector) : t('{0} non è più nella safelist.', selector);
    } catch (e) {
      message = errorText(e);
    } finally {
      busy = false;
    }
  }

  let list = $state<SelectorList | null>(null);
  let query = $state('');
  let sort = $state<SelectorSort>('name');
  let unusedOnly = $state(false);
  let origin = $state<SelectorOrigin>('all');
  let open = $state<string | null>(null);
  let newName = $state('');
  let plan = $state<RenamePlan | null>(null);
  /** Free-HTML occurrences ticked in the rename preview (C4). */
  let pickedHtml = $state<Record<string, boolean>>({});
  let busy = $state(false);
  let message = $state('');
  let bulkOpen = $state(false);
  const completions = cssCompletions(() => app);

  const rows = $derived(list ? filterSelectors(list.selectors, query, sort, unusedOnly, origin) : []);
  const current = $derived(list?.selectors.find((r) => r.id === open) ?? null);
  const fromSheets = $derived(list?.selectors.filter((r) => r.sheet !== undefined).length ?? 0);
  // Only entries can be deleted from here: a class of a global sheet is removed by editing the sheet.
  const unused = $derived(list?.selectors.filter((r) => r.unused && r.sheet === undefined) ?? []);
  // Server-side changes need a clean builder: unsaved work would conflict with the new dev commits.
  const frozen = $derived(busy || app.dirty || (list?.truncated ?? false));

  async function refresh() {
    try {
      list = await app.api.listSelectors();
    } catch (e) {
      message = errorText(e);
    }
  }

  // Reload when the tab is shown and after every save (new entries, changed classes).
  $effect(() => {
    if (visible && app.status.kind !== 'saving') void refresh();
  });

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function toggle(row: SelectorUsage) {
    open = open === row.id ? null : row.id;
    newName = row.rename ?? '';
    plan = null;
    message = '';
  }

  function builderLink(post: number): string | null {
    const url = new URL(window.location.href);
    url.searchParams.set('post', String(post));
    return safeUrl(url.href);
  }

  // CSS of the open selector: local text, written to the builder state with a short delay (as the CSS panel).
  const stored = $derived(current ? (app.styles.find((s) => s.selector === current.selector)?.css ?? '') : '');
  let text = $state('');
  // The name only: the list is reloaded whenever the status changes (typing makes the page unsaved at once), and
  // a new row object for the same selector must not throw away what is being typed.
  const currentSelector = $derived(current?.selector);
  $effect(() => {
    void open;
    void currentSelector; // a rename keeps the entry id
    void visible;
    void app.styleRevision;
    app.cancelEdit('selectors');
    text = untrack(() => stored);
  });

  // Through the builder state, as the CSS panel: saving applies what was typed just before.
  function onchange(css: string) {
    text = css;
    const selector = current?.selector;
    app.deferEdit('selectors', 250, () => {
      if (!selector) return;
      app.upsertStyle(selector, css);
      app.styleRevision++; // the CSS panel shows the same entry
    });
  }

  async function preview() {
    const from = current?.rename;
    const to = newName.trim();
    if (!from) return;
    if (!validClassName(to)) {
      message = t('Nome non valido: lettere, cifre, - e _, senza iniziare con una cifra.');
      return;
    }
    busy = true;
    message = '';
    try {
      plan = await app.api.renameSelector(from, to, true);
      pickedHtml = {};
    } catch (e) {
      plan = null;
      message = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function rename() {
    if (!plan?.ok || app.dirty) return;
    const { from, to } = plan;
    if (!window.confirm(t('Rinominare .{0} in .{1} (con le classi BEM) in tutti gli stili e i documenti? Le modifiche vanno in sviluppo e saranno online con la prossima pubblicazione.', from, to))) return;
    busy = true;
    message = '';
    try {
      const html = (plan.html ?? []).filter((o) => pickedHtml[o.id]).map((o) => ({ id: o.id, before: o.before }));
      const done = await app.api.renameSelector(from, to, false, html);
      await app.load();
      await refresh();
      open = list?.selectors.find((r) => r.selector === `.${done.to}`)?.id ?? null;
      newName = done.to;
      plan = null;
      message = t('Rinominata .{0} → .{1} in {2} documenti. Pubblica per metterla online.', done.from, done.to, done.docs.length);
    } catch (e) {
      message = errorText(e);
    } finally {
      busy = false;
    }
  }

  /** Rename and delete work on the saved styles: one click saves, then (when asked) renames as planned (C2). */
  async function saveFirst(thenRename: boolean) {
    busy = true;
    message = '';
    try {
      await app.save();
    } finally {
      busy = false;
    }
    if (app.dirty) {
      message = app.status.message || t('Salvataggio non riuscito: rinomina ed eliminazione restano spente.');
      return;
    }
    await refresh();
    if (thenRename) await rename();
  }

  async function remove(ids: string[], what: string) {
    if (ids.length === 0 || app.dirty) return;
    if (!window.confirm(t("Eliminare {0}? Le classi aggiunte da script, props o widget non vengono rilevate. L'eliminazione va in sviluppo e si può annullare ripristinando una versione.", what))) return;
    busy = true;
    message = '';
    try {
      const done = await app.api.deleteSelectors(ids);
      await app.load();
      await refresh();
      open = null;
      message = t('Eliminati: {0}. Pubblica per metterlo online.', done.deleted.join(', '));
    } catch (e) {
      message = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<NamedQueries {app} />
<div class="selectors">
  <div class="toolbar">
    <input type="search" bind:value={query} placeholder={t('Cerca un selettore')} aria-label={t('Cerca un selettore')} />
    <select bind:value={sort} aria-label={t('Ordina per')}>
      <option value="name">{t('Nome')}</option>
      <option value="usage">{t('Uso')}</option>
      <option value="size">{t('Dimensione')}</option>
    </select>
    <select bind:value={origin} aria-label={t('Origine')}>
      <option value="all">{t('Tutti')}</option>
      <option value="entries">{t('Voci')}</option>
      <option value="sheets">{t('Fogli globali')}</option>
    </select>
    <label class="check"><input type="checkbox" bind:checked={unusedOnly} /> {t('Solo inutilizzati')}</label>
    <button onclick={() => void refresh()} disabled={busy} title={t("Ricarica l'elenco")} aria-label={t("Ricarica l'elenco")}>↻</button>
  </div>

  {#if app.dirty}
    <p class="note">
      {t("Salva le modifiche per rinominare o eliminare: l'elenco riflette gli stili salvati.")}
      <button onclick={() => void saveFirst(false)} disabled={busy}>{t('Salva ora')}</button>
    </p>
  {/if}
  {#if list?.truncated}<p class="note">{t('Troppi documenti da analizzare: conteggi parziali, rinomina ed eliminazione disattivate.')}</p>{/if}
  {#if message}<p class="message" role="status">{message}</p>{/if}

  {#if !list}
    <p class="empty">{t('Caricamento…')}</p>
  {:else}
    <div class="summary">
      <span>{t('{0} voci · {1} classi dai fogli globali · {2} documenti', list.selectors.length - fromSheets, fromSheets, list.scanned)}</span>
      {#if app.globals.some((g) => g.css.trim() !== '')}
        <button aria-pressed={bulkOpen} onclick={() => (bulkOpen = !bulkOpen)} title={t("Le regole di ogni blocco usato lasciano i fogli globali per il suo selettore, annidate come in SCSS: prima un'anteprima, poi un solo passo da annullare")}>{t('Nei selettori…')}</button>
      {/if}
      {#if unused.length > 0}
        <button class="danger" disabled={frozen} onclick={() => void remove(unused.map((r) => r.id), t('{0} selettori inutilizzati', unused.length))}>{t('Elimina inutilizzati')}</button>
      {/if}
    </div>
    {#if bulkOpen}<BulkMove {app} onclose={() => (bulkOpen = false)} />{/if}
    <ul class="list">
      {#each rows as row (row.id)}
        <li class:open={open === row.id}>
          <button class="row" aria-expanded={open === row.id} onclick={() => toggle(row)}>
            <code>{row.selector}</code>
            {#if row.sheet !== undefined}<span class="badge sheet" title={t('Definita nel foglio {0}', row.sheet)}>{t('foglio')}</span>{/if}
            <span class="badge" class:unused={row.unused}>{usageLabel(row)}</span>
          </button>
          {#if open === row.id}
            <div class="detail">
              <div class="usage">
                {#if row.always}<p>{t('Senza classi né id: si applica a ogni pagina.')}</p>{/if}
                {#if row.safelisted}<p>{t('Nella safelist (Impostazioni → Histeon): sempre incluso.')}</p>{/if}
                {#if canManage && /^[.#]-?[_a-zA-Z][\w-]*$/.test(row.selector)}
                  <p>
                    {#if row.safelisted}
                      <button disabled={busy} onclick={() => void safelist(row.selector, false)}>{t('Togli dalla safelist')}</button>
                    {:else}
                      <button disabled={busy} onclick={() => void safelist(row.selector, true)} title={t('Le classi che aggiungono script, props o widget non si vedono nelle pagine: nella safelist sono sempre incluse e non risultano inutilizzate')}>{t('Usata da script, props o widget: tienila sempre')}</button>
                    {/if}
                  </p>
                {/if}
                {#if row.docs.length > 0}
                  <p>{t('Usato in:')}</p>
                  <ul>
                    {#each row.docs as d (d.doc)}
                      {@const href = d.post === app.postId ? null : builderLink(d.post)}
                      <li>
                        {#if href}<a {href}>{d.label || d.doc}</a>{:else}{d.label || d.doc}{/if}
                        {#if d.post === app.postId}<small>{t('(questa pagina)')}</small>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if row.theme.length > 0}<p>{t('Nel tema: {0}', row.theme.join(', '))}</p>{/if}
                {#if row.locked > 0}<p>{t('In {0} documenti che non puoi modificare.', row.locked)}</p>{/if}
                {#if row.unused}<p>{t('Nessun documento o template lo usa. Le classi aggiunte da script, props o widget non vengono rilevate.')}</p>{/if}
              </div>

              {#if row.sheet !== undefined}
                <p class="hint">{t('Definita nel foglio globale')} <code>{row.sheet}</code> {tn('({0} regola): si modifica lì, dal pannello CSS → Foglio globale.', '({0} regole): si modifica lì, dal pannello CSS → Foglio globale.', row.rules ?? 0, row.rules ?? 0)}</p>
                <div class="editor">
                  {#key row.id}
                    <CodeEditor value={row.css ?? ''} language="css" readOnly onchange={() => {}} label={t('Regole di {0} nel foglio globale', row.selector)} />
                  {/key}
                </div>
              {:else}
                <div class="editor">
                  {#key row.id}
                    <CodeEditor value={text} language="css" {onchange} {completions} label={t('CSS di {0}', row.selector)} />
                  {/key}
                </div>
              {/if}

              {#if row.rename}
                <form class="rename" onsubmit={(e) => { e.preventDefault(); void preview(); }}>
                  <label for="xb-rename-{row.id}">{t('Rinomina')} <code>.{row.rename}</code> {t('e le sue classi BEM')} (<code>__</code>, <code>--</code>)</label>
                  <div class="line">
                    <input id="xb-rename-{row.id}" bind:value={newName} oninput={() => (plan = null)} spellcheck="false" autocomplete="off" />
                    <!-- The preview only reads: it works with unsaved changes too, and the rename then saves first. -->
                    <button type="submit" disabled={busy || (list?.truncated ?? false) || newName.trim() === row.rename}>{t('Anteprima')}</button>
                  </div>
                </form>
                {#if plan}
                  <ul class="plan">
                    {#each describePlan(plan) as line, i (i)}<li class:blocked={line.startsWith(t('Bloccata'))}>{line}</li>{/each}
                  </ul>
                  {#if plan.html?.length}
                    <!-- Free HTML ({#raw}, core blocks): each occurrence is rewritten only if ticked (C4). -->
                    <fieldset class="free-html" disabled={!plan.htmlAllowed}>
                      <legend>{plan.htmlAllowed ? t('HTML libero: scegli le occorrenze da rinominare') : t('HTML libero: da rinominare a mano (serve il permesso di scrivere HTML senza filtri)')}</legend>
                      {#each plan.html as o (o.id)}
                        <label>
                          <input type="checkbox" checked={pickedHtml[o.id] === true} onchange={(e) => (pickedHtml = { ...pickedHtml, [o.id]: e.currentTarget.checked })} />
                          <span class="where">{o.label || o.doc}</span>
                          <code class="before">{o.before}</code> → <code class="after">{o.after}</code>
                        </label>
                      {/each}
                    </fieldset>
                  {/if}
                  {#if app.dirty}
                    <button class="primary" disabled={!plan.ok || busy || (list?.truncated ?? false)} onclick={() => void saveFirst(true)}>{t('Salva ora e rinomina')}</button>
                  {:else}
                    <button class="primary" disabled={!plan.ok || frozen} onclick={() => void rename()}>{t('Rinomina ovunque')}</button>
                  {/if}
                {/if}
              {/if}

              {#if row.unused && row.sheet === undefined}
                <button class="danger" disabled={frozen} onclick={() => void remove([row.id], row.selector)}>{t('Elimina selettore')}</button>
              {/if}
            </div>
          {/if}
        </li>
      {:else}
        <li class="empty">{query.trim() !== '' || unusedOnly ? t('Nessun selettore corrisponde.') : t('Nessuno stile ancora: scrivili nel pannello CSS.')}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .selectors { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
  .selectors > * { flex: none; min-width: 0; }
  .selectors > .list { flex: 1 1 auto; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--xb-line); }
  .toolbar input[type='search'] { flex: 1 1 120px; min-width: 0; }
  input, select, button { font: 12.5px var(--xb-sans); padding: 5px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--xb-accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  .check { display: flex; gap: 4px; align-items: center; color: var(--xb-muted); white-space: nowrap; font-size: 12px; }
  .check input { padding: 0; }
  .note, .message, .summary { margin: 0; padding: 6px 12px; font-size: 12px; }
  .note { color: var(--xb-muted); background: var(--xb-hover); }
  .message { color: var(--xb-text); background: var(--xb-accent-bg); }
  .summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--xb-muted); border-bottom: 1px solid var(--xb-line); }
  .list { list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 0; }
  .list > li { border-bottom: 1px solid var(--xb-line); }
  .list > li.open { background: var(--xb-hover); }
  .row { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; border: 0; border-radius: 0; background: none; padding: 8px 12px; text-align: left; }
  .row code { font: 12.5px var(--xb-mono); overflow-wrap: anywhere; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--xb-line); color: var(--xb-muted); white-space: nowrap; }
  .row .badge.sheet { margin-left: auto; }
  .hint { margin: 0; color: var(--xb-muted); }
  .badge.unused { color: var(--xb-danger); border-color: var(--xb-danger); background: var(--xb-danger-bg); }
  .detail { display: grid; gap: 10px; padding: 4px 12px 12px; }
  .usage p { margin: 0 0 4px; color: var(--xb-muted); }
  .usage ul { margin: 0 0 4px; padding-left: 18px; }
  .usage a { color: var(--xb-text); }
  .usage small { color: var(--xb-muted); }
  .editor { height: 150px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); overflow: hidden; }
  .rename { display: grid; gap: 4px; color: var(--xb-muted); }
  .rename .line { display: flex; gap: 6px; }
  .rename input { flex: 1; min-width: 0; font-family: var(--xb-mono); }
  .plan { margin: 0; padding-left: 18px; color: var(--xb-muted); }
  .plan .blocked { color: var(--xb-danger); }
  .primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; justify-self: start; }
  .danger { color: var(--xb-danger); justify-self: start; }
  .empty { padding: 16px 12px; color: var(--xb-muted); }
  .free-html { display: grid; gap: 4px; margin: 6px 0; padding: 6px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); font-size: 12px; }
  .free-html legend { padding: 0 4px; color: var(--xb-muted); }
  .free-html label { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .free-html code { font: 11.5px var(--xb-mono); overflow-wrap: anywhere; }
  .free-html .before { color: var(--xb-danger); }
  .free-html .after { color: var(--xb-ok); }
  .free-html .where { color: var(--xb-muted); }
</style>
