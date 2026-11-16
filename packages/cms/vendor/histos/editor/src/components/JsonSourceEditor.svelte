<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import CodeEditor from './CodeEditor.svelte';
  import { addColumn, addRow, cellText, columns, keyProblem, moveRow, removeColumn, removeRow, renameColumn, setCell, setEntry, shapeOf, type Json, type Row } from '../lib/jsonTable.ts';

  // A JSON source, edited as a table (rows of the same keys), as a list of keys (one object) or as code.
  let { name, value, onchange }: { name: string; value: Json; onchange: (value: Json) => void } = $props();

  let view = $state<'visual' | 'code'>('visual');
  let text = $state('');
  let codeError = $state('');
  let newColumn = $state('');
  let columnError = $state('');
  const shape = $derived(shapeOf(value));
  const rows = $derived((shape === 'table' ? value : []) as Row[]);
  const cols = $derived(columns(rows));
  const entries = $derived(shape === 'object' ? Object.entries(value as Record<string, Json>) : []);

  // The code view follows the value, except while it holds the author's own (possibly invalid) text.
  $effect(() => {
    const json = JSON.stringify(value, null, 2);
    if (!codeError) text = json;
  });

  function oncode(next: string) {
    text = next;
    try {
      const parsed = JSON.parse(next) as Json;
      codeError = '';
      onchange(parsed);
    } catch (e) {
      codeError = t('JSON non valido: {0}', e instanceof Error ? e.message : String(e));
    }
  }

  function addCol(event: SubmitEvent) {
    event.preventDefault();
    const key = newColumn.trim();
    const problem = keyProblem(key, shape === 'object' ? entries.map(([k]) => k) : cols);
    if (problem) {
      columnError = problem;
      return;
    }
    columnError = '';
    newColumn = '';
    onchange(shape === 'object' ? { ...(value as Record<string, Json>), [key]: '' } : addColumn(rows, key));
  }

  function rename(from: string, to: string) {
    const key = to.trim();
    if (key === from) return;
    const problem = keyProblem(key, cols.filter((c) => c !== from));
    if (problem) {
      columnError = problem;
      return;
    }
    columnError = '';
    onchange(renameColumn(rows, from, key));
  }
</script>

<div class="json">
  <div class="bar">
    <div class="segmented" role="tablist" aria-label={t('Vista della sorgente')}>
      <button role="tab" aria-selected={view === 'visual'} class:active={view === 'visual'} onclick={() => (view = 'visual')}>{t('Visuale')}</button>
      <button role="tab" aria-selected={view === 'code'} class:active={view === 'code'} onclick={() => (view = 'code')}>{t('Codice')}</button>
    </div>
    {#if view === 'visual' && shape === 'table'}<span class="muted">{t('{0} righe · {1} colonne', rows.length, cols.length)}</span>{/if}
  </div>

  {#if view === 'code'}
    <div class="code"><CodeEditor value={text} language="javascript" onchange={oncode} label={t('Dati JSON della sorgente {0}', name)} /></div>
    {#if codeError}<p class="problem">{codeError}</p>{/if}
  {:else if shape === 'table'}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="tools" aria-label={t('Ordine')}></th>
            {#each cols as col (col)}
              <th>
                <span class="head">
                  <input value={col} aria-label={t('Nome della colonna {0}', col)} onchange={(e) => rename(col, e.currentTarget.value)} spellcheck="false" />
                  <button class="icon" onclick={() => onchange(removeColumn(rows, col))} aria-label={t('Elimina la colonna {0}', col)} title={t('Elimina la colonna')}>×</button>
                </span>
              </th>
            {/each}
            <th class="tools"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, i (i)}
            <tr>
              <td class="tools">
                <button class="icon" onclick={() => onchange(moveRow(rows, i, -1))} disabled={i === 0} aria-label={t('Sposta su la riga {0}', i + 1)}>▴</button>
                <button class="icon" onclick={() => onchange(moveRow(rows, i, 1))} disabled={i === rows.length - 1} aria-label={t('Sposta giù la riga {0}', i + 1)}>▾</button>
              </td>
              {#each cols as col (col)}
                <td><input value={cellText(row[col])} aria-label={t('{0}, riga {1}', col, i + 1)} onchange={(e) => onchange(setCell(rows, i, col, e.currentTarget.value))} /></td>
              {/each}
              <td class="tools"><button class="icon" onclick={() => onchange(removeRow(rows, i))} aria-label={t('Elimina la riga {0}', i + 1)} title={t('Elimina la riga')}>×</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="row">
      <button onclick={() => onchange(addRow(rows))} disabled={cols.length === 0}>{t('+ Riga')}</button>
      <form onsubmit={addCol}>
        <input bind:value={newColumn} placeholder={t('nuova_colonna')} aria-label={t('Nome della nuova colonna')} spellcheck="false" />
        <button type="submit" disabled={newColumn.trim() === ''}>{t('+ Colonna')}</button>
      </form>
    </div>
    {#if columnError}<p class="problem">{columnError}</p>{/if}
  {:else if shape === 'object'}
    <table>
      <tbody>
        {#each entries as [key, v] (key)}
          <tr>
            <th><code>{key}</code></th>
            <td><input value={cellText(v)} aria-label={key} onchange={(e) => onchange(setEntry(value as Row, key, e.currentTarget.value))} /></td>
            <td class="tools"><button class="icon" onclick={() => onchange(Object.fromEntries(entries.filter(([k]) => k !== key)))} aria-label={t('Elimina {0}', key)}>×</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <form class="row" onsubmit={addCol}>
      <input bind:value={newColumn} placeholder={t('chiave')} aria-label={t('Nuova chiave')} spellcheck="false" />
      <button type="submit" disabled={newColumn.trim() === ''}>{t('+ Chiave')}</button>
    </form>
    {#if columnError}<p class="problem">{columnError}</p>{/if}
  {:else}
    <p class="muted">{t('Questa sorgente ha una struttura annidata: si modifica nella vista Codice.')}</p>
    <pre>{JSON.stringify(value, null, 2).slice(0, 4000)}</pre>
  {/if}
</div>

<style>
  .json { display: grid; gap: 8px; min-width: 0; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 10px; }
  .muted { color: var(--xb-muted); font-size: 12px; }
  .problem { margin: 0; color: var(--xb-danger); font-size: 12px; }
  .code { height: 280px; border: 1px solid var(--xb-line); }
  .table-wrap { overflow: auto; max-height: 360px; border: 1px solid var(--xb-line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--xb-line); padding: 2px; text-align: left; }
  thead th { position: sticky; top: 0; background: var(--xb-panel); z-index: 1; }
  .head { display: flex; align-items: center; }
  input { width: 100%; min-width: 90px; font: 12.5px var(--xb-sans); padding: 5px 6px; border: 1px solid transparent; border-radius: var(--xb-r-sm); background: transparent; color: var(--xb-text); }
  input:hover, input:focus { border-color: var(--xb-line); background: var(--xb-bg); }
  thead input { font: 600 12px var(--xb-mono); }
  .tools { width: 1%; white-space: nowrap; }
  .icon { border: 0; background: none; color: var(--xb-muted); cursor: pointer; padding: 2px 4px; font-size: 13px; }
  .icon:disabled { opacity: 0.3; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row form { display: flex; gap: 6px; }
  .row input, form.row input { width: 160px; border-color: var(--xb-line); background: var(--xb-bg); font-family: var(--xb-mono); }
  button:not(.icon) { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .segmented { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--xb-hover); }
  .segmented button { border: 0; padding: 4px 10px; border-radius: var(--xb-r); color: var(--xb-muted); }
  .segmented button.active { background: var(--xb-bg); color: var(--xb-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
  pre { margin: 0; max-height: 280px; overflow: auto; font: 12px var(--xb-mono); background: var(--xb-panel); padding: 8px; border-radius: var(--xb-r); }
</style>
