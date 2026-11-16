<script lang="ts">
  import type { QueryGroup, QueryRecord } from '../lib/api.ts';
  import { t, tn } from '../lib/i18n.ts';

  // What a query returns, as a visitor would see it: the records as cards, and one record at a time with its keys
  // ("1 of N"), each with the expression to use in the loop, ready to copy or insert.
  let {
    records,
    groups = null,
    group = 'gruppo',
    variable,
    direct,
    kind = 'query',
    loading,
    error,
    oninsert,
  }: {
    records: QueryRecord[] | null;
    /** A loop in groups (doc 23 of Publish, item 205): its groups, each key with how many records; null when not grouped. */
    groups?: QueryGroup[] | null;
    /** The variable of each group in that loop (`gruppo`). */
    group?: string;
    variable: string;
    /** How the source is read without a loop (`data.orari`): the record becomes `data.orari[i]`. */
    direct?: string;
    /** A query of the site (records as visitors see them) or data written by hand. */
    kind?: 'query' | 'json';
    loading: boolean;
    error: string;
    oninsert?: (expression: string) => void;
  } = $props();

  /** Inside the loop (`item.title`) or anywhere on the page, without a loop (`data.eventi[0].title`). */
  let reading = $state<'loop' | 'direct'>('loop');

  let index = $state(0);
  let copied = $state('');
  $effect(() => {
    void records;
    index = 0;
  });
  const record = $derived(records && records.length ? records[Math.min(index, records.length - 1)] : null);
  const image = (r: QueryRecord) => r.fields.find((f) => f.kind === 'image')?.value ?? '';
  const withImages = $derived((records ?? []).some((r) => image(r) !== ''));
  const date = (r: QueryRecord) => {
    const raw = r.fields.find((f) => f.path === 'date')?.value;
    if (!raw) return '';
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString();
  };

  async function copy(expression: string) {
    try {
      await navigator.clipboard.writeText(expression);
    } catch {
      // No clipboard (insecure context): the expression is shown, it can be selected by hand.
    }
    copied = expression;
    setTimeout(() => (copied === expression ? (copied = '') : null), 1500);
  }
</script>

<div class="preview" aria-busy={loading}>
  <div class="head">
    <strong>{t('Dati')}</strong>
    <span class="muted">
      {#if loading}{t('aggiornamento…')}{:else if records}{records.length === 0 ? t('nessun risultato') : (kind === 'json' ? tn('{0} riga', '{0} righe', records.length, records.length + (records.length >= 20 ? '+' : '')) : tn('{0} risultato', '{0} risultati', records.length, records.length + (records.length >= 20 ? '+' : ''))) + (kind === 'query' ? t(', come li vede chi visita') : '')}{/if}
    </span>
  </div>
  {#if error}<p class="error">{error}</p>{/if}

  {#if groups && !loading}
    <div class="groups" aria-label={t('Gruppi del loop')}>
      <p class="count"><strong>{tn('{0} gruppo', '{0} gruppi', groups.length, groups.length + (groups.length >= 100 ? '+' : ''))}</strong> {t('nel loop: ognuno ripete il suo titolo, poi i suoi contenuti.')}</p>
      {#if groups.length}
        <ul>
          {#each groups as g, i (i)}
            <li><span class="key">{g.key || t('(senza valore)')}</span> <span class="muted">{tn('{0} contenuto', '{0} contenuti', g.count, g.count)}</span></li>
          {/each}
        </ul>
        <p class="muted">{t('Il titolo del gruppo è')} <code>{`{${group}.key}`}</code>; {t('le chiavi qui sotto valgono nel loop interno su')} <code>{`{${group}.items}`}</code>.</p>
      {/if}
    </div>
  {/if}

  {#if records && records.length > 0}
    <ul class="cards" aria-label={t('Risultati')}>
      {#each records as r, i (i)}
        <li>
          <button class:active={i === index} onclick={() => (index = i)}>
            {#if image(r)}<img src={image(r)} alt="" loading="lazy" />{:else if withImages}<span class="ph" aria-hidden="true">▤</span>{/if}
            <span class="t">{r.title || t('(senza titolo)')}</span>
            {#if date(r)}<span class="d">{date(r)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>

    {#if record}
      <div class="record">
        {#if direct}
          <div class="reading" role="tablist" aria-label={t('Come leggere i dati')}>
            <button role="tab" aria-selected={reading === 'loop'} class:active={reading === 'loop'} onclick={() => (reading = 'loop')}>{t('Nel loop')}</button>
            <button role="tab" aria-selected={reading === 'direct'} class:active={reading === 'direct'} onclick={() => (reading = 'direct')}>{t('Senza loop')}</button>
          </div>
        {/if}
        <div class="nav">
          <button onclick={() => (index = Math.max(0, index - 1))} disabled={index === 0} aria-label={t('Record precedente')}>◂</button>
          <span>{t('Record {0} di {1}', index + 1, records.length)}</span>
          <button onclick={() => (index = Math.min(records.length - 1, index + 1))} disabled={index >= records.length - 1} aria-label={t('Record successivo')}>▸</button>
        </div>
        <table>
          <tbody>
            {#each record.fields as f (f.path)}
              {@const expression = reading === 'direct' && direct ? `{${direct}[${index}].${f.path}}` : `{${variable}.${f.path}}`}
              <tr>
                <td class="key"><code>{expression}</code></td>
                <td class="value">
                  {#if f.kind === 'image'}<img src={f.value} alt="" />{:else}<span title={f.value}>{f.value}</span>{/if}
                </td>
                <td class="actions">
                  <button onclick={() => copy(expression)} title={t("Copia l'espressione")}>{copied === expression ? '✓' : t('Copia')}</button>
                  {#if oninsert}<button onclick={() => oninsert(expression)} title={t("Inserisci come testo nell'elemento selezionato")}>{t('Inserisci')}</button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="muted hint">
          {#if reading === 'direct' && direct}
            {t('Senza loop: si legge questo record in qualunque punto della pagina, con')} <code>{`{${direct}[${index}].chiave}`}</code>.
          {:else}
            {t('Le chiavi valgono dentro il loop')} (<code>{variable}</code>).{#if kind === 'query' && variable === 'item'} {t('I campi personalizzati pubblici si leggono con')} <code>{`{${variable}.meta.chiave}`}</code>.{/if}
          {/if}
        </p>
      </div>
    {/if}
  {:else if records && !loading}
    <p class="muted empty">{kind === 'json' ? t('La sorgente è vuota: aggiungi una riga.') : t('Nessun contenuto corrisponde, per chi visita il sito: controlla tipo e filtri.')}</p>
  {/if}
</div>

<style>
  .preview { display: grid; gap: 10px; align-content: start; font-size: 13px; min-width: 0; }
  .head { display: flex; gap: 10px; align-items: baseline; }
  .muted { color: var(--xb-muted); font-size: 12px; }
  .error { margin: 0; color: var(--xb-danger); }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .cards button { width: 100%; display: grid; gap: 4px; padding: 6px; border: 1px solid var(--xb-line); border-radius: 8px; background: var(--xb-bg); color: var(--xb-text); text-align: left; cursor: pointer; font: 12px var(--xb-sans); }
  .cards button.active { border-color: var(--xb-accent); background: var(--xb-accent-bg); }
  .cards img, .ph { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: var(--xb-r-sm); background: var(--xb-hover); display: grid; place-items: center; color: var(--xb-muted); }
  .t { font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .d { color: var(--xb-muted); font-size: 11px; }
  .record { border: 1px solid var(--xb-line); border-radius: 8px; overflow: hidden; background: var(--xb-bg); }
  .nav { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--xb-line); background: var(--xb-panel); }
  .nav button, .actions button { border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); border-radius: var(--xb-r-sm); padding: 2px 8px; cursor: pointer; font: 12px var(--xb-sans); }
  .nav button:disabled { opacity: 0.4; cursor: default; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  td { padding: 6px 10px; border-bottom: 1px solid var(--xb-line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  .key { width: 42%; }
  .key code { font: 11.5px var(--xb-mono); color: var(--xb-syn-class); word-break: break-all; }
  .value span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--xb-text); }
  .value img { max-height: 40px; max-width: 100%; border-radius: var(--xb-r-sm); }
  .actions { width: 132px; text-align: right; white-space: nowrap; }
  .hint { margin: 0; padding: 8px 10px; border-top: 1px solid var(--xb-line); }
  .reading { display: flex; gap: 2px; padding: 6px 10px 0; background: var(--xb-panel); }
  .reading button { border: 0; background: none; padding: 4px 10px; border-radius: var(--xb-r); cursor: pointer; color: var(--xb-muted); font: 12px var(--xb-sans); }
  .reading button.active { background: var(--xb-bg); color: var(--xb-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
  .empty { padding: 20px 0; }
  .groups { display: grid; gap: 6px; padding: 8px 10px; border: 1px solid var(--xb-line); border-radius: 8px; background: var(--xb-panel); }
  .groups p { margin: 0; }
  .groups ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .groups li { padding: 2px 8px; border: 1px solid var(--xb-line); border-radius: 999px; background: var(--xb-bg); font-size: 12px; }
  .groups .key { font-weight: 600; }
  .groups code { font: 11.5px var(--xb-mono); }
</style>
