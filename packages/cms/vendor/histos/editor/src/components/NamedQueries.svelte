<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { queryProblem } from '../lib/cssActions.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Named media and container queries (docs/spec/styles.md §6): written once, used as `@media (--tablet)`.
  // Saved in dev with the site settings; the preview uses them at once, the site after a release.
  let { app }: { app: BuilderState } = $props();

  let open = $state(false);
  let rows = $state<Array<{ name: string; query: string }>>([]);
  let heads = $state<{ head: string; base: string } | null>(null);
  let saved = $state('');
  let message = $state('');
  let busy = $state(false);

  const problems = $derived(rows.map((r) => queryProblem(r.name, r.query)).filter((p): p is string => p !== null));
  const duplicate = $derived(rows.some((r, i) => rows.findIndex((x) => x.name === r.name) !== i));
  const dirty = $derived(saved !== '' && JSON.stringify(rows) !== saved);

  async function load() {
    try {
      const data = await app.api.getNamedQueries();
      rows = Object.entries(data.queries).map(([name, query]) => ({ name, query }));
      heads = { head: data.head, base: data.base };
      saved = JSON.stringify(rows);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    if (open && !heads) void load();
  });

  async function save() {
    if (!heads || problems.length || duplicate) return;
    busy = true;
    message = '';
    try {
      const queries = Object.fromEntries(rows.map((r) => [r.name, r.query.trim()]));
      const done = await app.api.saveNamedQueries(queries, heads.head, heads.base);
      heads = { head: done.head, base: done.base };
      saved = JSON.stringify(rows);
      app.queries = queries;
      message = t('Salvate in sviluppo: l’anteprima le usa già, il sito dopo la prossima release.');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="named">
  <button class="toggle" onclick={() => (open = !open)} aria-expanded={open}>{t('Media query con nome')} {open ? '▾' : '▸'}</button>
  {#if open}
    <p class="help">{t('Scrivi la condizione una volta e usala ovunque:')} <code>@media (--tablet) {'{ … }'}</code> {t('o')} <code>@container card (--tablet)</code>.</p>
    <table>
      <tbody>
        {#each rows as row, i (i)}
          <tr>
            <td><input class="mono" bind:value={row.name} aria-label={t('Nome della media query {0}', i + 1)} spellcheck="false" /></td>
            <td><input class="mono" bind:value={row.query} aria-label={t('Condizione della media query {0}', row.name)} placeholder="(width < 64em)" spellcheck="false" /></td>
            <td><button class="icon" onclick={() => (rows = rows.filter((_, j) => j !== i))} aria-label={t('Elimina {0}', row.name)}>×</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="row">
      <button onclick={() => (rows = [...rows, { name: `query-${rows.length + 1}`, query: '(width < 48em)' }])}>+ Media query</button>
      <button class="primary" onclick={save} aria-label={t('Salva le media query')} disabled={!dirty || busy || problems.length > 0 || duplicate}>{t('Salva')}{dirty ? ' •' : ''}</button>
    </div>
    {#if duplicate}<p class="problem">{t('Due media query hanno lo stesso nome.')}</p>{/if}
    {#each problems as p (p)}<p class="problem">{p}</p>{/each}
    {#if message}<p class="help" role="status">{message}</p>{/if}
  {/if}
</section>

<style>
  .named { display: grid; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--xb-line); font-size: 13px; }
  .toggle { justify-self: start; border: 0; background: none; padding: 2px 0; color: var(--xb-text); font: 600 12px var(--xb-sans); cursor: pointer; }
  .help { margin: 0; color: var(--xb-muted); font-size: 12px; }
  .problem { margin: 0; color: var(--xb-danger); font-size: 12px; }
  table { border-collapse: collapse; width: min(100%, 560px); }
  td { padding: 2px; }
  input { width: 100%; font: 12px var(--xb-mono); padding: 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .row { display: flex; gap: 8px; }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
  .icon { border: 0; color: var(--xb-muted); }
</style>
