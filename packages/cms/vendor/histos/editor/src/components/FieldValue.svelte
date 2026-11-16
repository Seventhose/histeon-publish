<script lang="ts">
  import { MAX_ROWS, type SubField } from '../lib/contentHub.ts';
  import { MAX_INNER_ROWS, emptyRow, mediaQuery, relatedQuery, rowsOf, subValue, type CoreApi } from '../lib/contentTable.ts';
  import { t, tn } from '../lib/i18n.ts';
  import Self from './FieldValue.svelte';

  // One value of the content table that does not fit in a cell (D6): an image chosen from the media library, a
  // linked content of its type, or the rows of a repeater (with a repeater inside a row, two levels at most).
  // Values go out shaped as the REST schema wants them; WordPress checks them again and refuses what is not valid.
  type Field = { name: string; label: string; type: string; options: Array<{ value: string; label: string }>; postType?: string; sub?: SubField[]; multiple?: boolean };
  let {
    api,
    field,
    value,
    onchange,
    routeFor,
    nested = false,
  }: { api: CoreApi; field: Field; value: unknown; onchange: (value: unknown) => void; routeFor: (postType: string) => string | null; nested?: boolean } = $props();

  type Choice = { id: number; label: string; thumb: string };
  let picking = $state(false);
  let query = $state('');
  let choices = $state<Choice[]>([]);
  let problem = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const id = $derived(Number(value) > 0 ? Number(value) : 0);
  const max = $derived(nested ? MAX_INNER_ROWS : MAX_ROWS);
  const sub = $derived(field.sub ?? []);
  // A repeater at the top edits a copy and saves it with one button; a repeater in a row edits its parent's copy.
  let draft = $state<Array<Record<string, unknown>>>([]);
  let dirty = $state(false);
  $effect(() => {
    if (field.type === 'repeater' && (nested || !dirty)) draft = rowsOf(value, sub, max);
  });

  async function find() {
    problem = '';
    try {
      if (field.type === 'image' || field.type === 'file') {
        const { data } = await api.core<Array<{ id: number; title?: { rendered?: string }; alt_text?: string; source_url?: string; media_details?: { sizes?: Record<string, { source_url?: string }> } }>>('GET', mediaQuery(query, field.type === 'image'));
        choices = data.map((m) => ({ id: m.id, label: m.alt_text || plain(m.title?.rendered ?? '') || `#${m.id}`, thumb: m.media_details?.sizes?.thumbnail?.source_url ?? m.source_url ?? '' }));
      } else {
        const route = routeFor(field.postType ?? '');
        if (!route) {
          problem = t('Il tipo collegato non ha un indirizzo REST.');
          return;
        }
        const { data } = await api.core<Array<{ id: number; title?: { raw?: string; rendered?: string }; status?: string }>>('GET', relatedQuery(route, query));
        choices = data.map((p) => ({ id: p.id, label: (p.title?.raw ?? plain(p.title?.rendered ?? '')) || `#${p.id}`, thumb: '' }));
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      choices = [];
    }
  }

  function plain(html: string): string {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  }

  function open() {
    picking = !picking;
    if (picking) void find();
  }

  function onquery(text: string) {
    query = text;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void find(), 300);
  }

  function choose(choice: number) {
    picking = false;
    onchange(choice);
  }

  function setRows(rows: Array<Record<string, unknown>>) {
    draft = rows;
    if (nested) onchange(rows);
    else dirty = true;
  }

  function setCell(index: number, s: SubField, input: unknown) {
    setRows(draft.map((row, i) => (i === index ? { ...row, [s.name]: s.type === 'repeater' ? input : subValue(s, input) } : row)));
  }

  function move(index: number, by: number) {
    const to = index + by;
    if (to < 0 || to >= draft.length) return;
    const rows = [...draft];
    [rows[index], rows[to]] = [rows[to]!, rows[index]!];
    setRows(rows);
  }

  function save() {
    dirty = false;
    onchange(draft);
  }

  function discard() {
    dirty = false;
    draft = rowsOf(value, sub, max);
  }
</script>

{#if field.multiple}
  <span class="muted">{t('Più valori: si modificano nel pannello «Campi» dell’editor a blocchi.')}</span>
{:else if field.type === 'image' || field.type === 'file' || field.type === 'post'}
  <span class="pick">
    <span>{id ? `#${id}` : '—'}</span>
    <button type="button" class="link" onclick={open} aria-expanded={picking}>{field.type === 'image' ? t('Scegli immagine') : field.type === 'file' ? t('Scegli file') : t('Scegli contenuto')}</button>
    {#if id}<button type="button" class="link" onclick={() => onchange(0)}>{t('Togli')}</button>{/if}
  </span>
  {#if picking}
    <div class="chooser" role="group" aria-label={t('Scegli: {0}', field.label)}>
      <input type="search" value={query} oninput={(e) => onquery(e.currentTarget.value)} placeholder={t('Cerca')} aria-label={t('Cerca: {0}', field.label)} />
      {#if problem}<p class="problem" role="status">{problem}</p>{/if}
      <div class="choices" class:images={field.type === 'image'}>
        {#each choices as c (c.id)}
          <button type="button" class="choice" class:current={c.id === id} onclick={() => choose(c.id)} title={c.label}>
            {#if c.thumb}<img src={c.thumb} alt="" loading="lazy" />{/if}
            <span>{c.label}</span>
          </button>
        {:else}
          <span class="muted">{t('Nessun risultato.')}</span>
        {/each}
      </div>
    </div>
  {/if}
{:else if field.type === 'repeater'}
  <div class="rows" class:nested>
    {#each draft as row, index (index)}
      <div class="row">
        <span class="n">{index + 1}</span>
        {#each sub as s (s.name)}
          <label class="cell" class:wide={s.type === 'repeater' || s.type === 'textarea'}>
            <span>{s.label}</span>
            {#if s.type === 'repeater' || s.type === 'image' || s.type === 'file'}
              <Self {api} field={{ name: s.name, label: s.label, type: s.type, options: s.options, sub: s.sub ?? [] }} value={row[s.name]} onchange={(v) => setCell(index, s, v)} {routeFor} nested />
            {:else if s.type === 'toggle'}
              <input type="checkbox" checked={!!row[s.name]} onchange={(e) => setCell(index, s, e.currentTarget.checked)} />
            {:else if s.type === 'select'}
              <select value={String(row[s.name] ?? '')} onchange={(e) => setCell(index, s, e.currentTarget.value)}>
                <option value="">—</option>
                {#each s.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
              </select>
            {:else if s.type === 'textarea'}
              <textarea rows="2" value={String(row[s.name] ?? '')} onchange={(e) => setCell(index, s, e.currentTarget.value)}></textarea>
            {:else}
              <input
                type={s.type === 'number' ? 'number' : s.type === 'date' ? 'date' : s.type === 'time' ? 'time' : s.type === 'url' ? 'url' : 'text'}
                step={s.type === 'number' ? 'any' : undefined}
                value={row[s.name] === null || row[s.name] === undefined ? '' : String(row[s.name])}
                onchange={(e) => setCell(index, s, e.currentTarget.value)}
              />
            {/if}
          </label>
        {/each}
        <span class="tools">
          <button type="button" class="icon" onclick={() => move(index, -1)} disabled={index === 0} aria-label={t('Sposta su la riga {0}', index + 1)}>↑</button>
          <button type="button" class="icon" onclick={() => move(index, 1)} disabled={index === draft.length - 1} aria-label={t('Sposta giù la riga {0}', index + 1)}>↓</button>
          <button type="button" class="icon" onclick={() => setRows(draft.filter((_, i) => i !== index))} aria-label={t('Elimina la riga {0}', index + 1)}>✕</button>
        </span>
      </div>
    {/each}
    <div class="bar">
      <button type="button" onclick={() => setRows([...draft, emptyRow(sub)])} disabled={draft.length >= max}>+ {t('Riga')}</button>
      <span class="muted">{tn('{0} riga', '{0} righe', draft.length, draft.length)}{draft.length >= max ? ` · ${t('massimo {0}', max)}` : ''}</span>
      {#if !nested && dirty}
        <button type="button" class="primary" onclick={save}>{t('Salva le righe')}</button>
        <button type="button" onclick={discard}>{t('Annulla')}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .pick { display: inline-flex; gap: 8px; align-items: center; }
  .chooser { display: grid; gap: 6px; margin-top: 6px; max-width: 520px; }
  .choices { display: flex; flex-wrap: wrap; gap: 6px; }
  .choice { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; max-width: 120px; padding: 4px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; font: 12px var(--xb-sans); }
  .choice.current { border-color: var(--xb-accent); }
  .choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; }
  .images .choice img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; }
  .rows { display: grid; gap: 6px; }
  .rows.nested { padding-left: 8px; border-left: 2px solid var(--xb-line); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; padding: 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); }
  .n { font: 600 11px var(--xb-sans); color: var(--xb-muted); align-self: center; }
  .cell { display: grid; gap: 2px; font-size: 11px; color: var(--xb-muted); min-width: 120px; }
  .cell.wide { flex-basis: 100%; }
  .cell input:not([type='checkbox']), .cell select, .cell textarea { font: 12.5px var(--xb-sans); padding: 4px 6px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .tools { display: inline-flex; gap: 2px; margin-left: auto; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.icon { padding: 2px 6px; }
  button.link { border: 0; padding: 0; color: var(--xb-link); text-decoration: underline; }
  button.primary { background: var(--xb-accent); border-color: var(--xb-accent); color: #fff; font-weight: 600; }
  input[type='search'] { font: 12.5px var(--xb-sans); padding: 4px 6px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .muted { color: var(--xb-muted); font-size: 12px; }
  .problem { margin: 0; color: var(--xb-danger); font-size: 12px; }
</style>
