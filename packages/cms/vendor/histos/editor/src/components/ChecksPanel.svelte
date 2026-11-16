<script lang="ts">
  import type { Area, Finding } from '../lib/checks.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t, tn } from '../lib/i18n.ts';

  // Checks of the page as drawn (docs/spec/checks.md). A click on a finding selects its element and shows it.
  let { app, findings, onrecheck, onshow, onalts }: { app: BuilderState; findings: Finding[]; onrecheck: () => void; onshow: () => void; onalts?: () => void } = $props();

  const AREAS: Area[] = ['Accessibilità', 'SEO', 'Prestazioni', 'CSS'];
  let filter = $state<Area | null>(null);
  const shown = $derived(filter ? findings.filter((f) => f.area === filter) : findings);
  const count = (area: Area | null, severity?: Finding['severity']) => findings.filter((f) => (!area || f.area === area) && (!severity || f.severity === severity)).length;
  const LABEL = { error: t('Errore'), warning: t('Da rivedere'), info: t('Consiglio') } as const;
  const AREA_LABEL: Record<Area, string> = { Accessibilità: t('Accessibilità'), SEO: 'SEO', Prestazioni: t('Prestazioni'), CSS: 'CSS' };

  function show(f: Finding) {
    if (!f.uid) return;
    app.select(f.uid);
    onshow();
  }
</script>

<div class="checks">
  <div class="summary">
    <button class:on={filter === null} aria-pressed={filter === null} onclick={() => (filter = null)}>{t('Tutti')} <b>{findings.length}</b></button>
    {#each AREAS as area (area)}
      <button class:on={filter === area} aria-pressed={filter === area} onclick={() => (filter = area)}>{AREA_LABEL[area]} <b>{count(area)}</b>{#if count(area, 'error')}<span class="dot" title={tn('{0} errore', '{0} errori', count(area, 'error'), count(area, 'error'))}></span>{/if}</button>
    {/each}
    {#if onalts && findings.some((f) => f.rule === 'img-alt')}<button onclick={onalts}>{t('Tutti i testi alternativi…')}</button>{/if}
    <button class="again" onclick={onrecheck}>{t('Ricontrolla')}</button>
  </div>
  {#if shown.length === 0}
    <p class="ok">{filter ? t('Nessun problema trovato per {0}.', AREA_LABEL[filter]) : t('Nessun problema trovato.')} {t('I controlli guardano la pagina come è disegnata nella tela: non sostituiscono una verifica con un lettore di schermo.')}</p>
  {:else}
    <ul>
      {#each shown as f, i (i)}
        <li class={f.severity}>
          <span class="sev">{LABEL[f.severity]}</span>
          <span class="msg">{f.message}</span>
          <span class="area">{AREA_LABEL[f.area] ?? f.area}</span>
          {#if f.uid}<button onclick={() => show(f)}>{t('Mostra')}</button>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .checks { display: grid; gap: 12px; align-content: start; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .summary button { font: 500 12.5px var(--xb-sans); padding: 5px 10px; border-radius: 999px; border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .summary button.on { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); }
  .summary .again { margin-left: auto; border-radius: var(--xb-r); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--xb-danger); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  li { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--xb-line); border-left-width: 3px; border-radius: var(--xb-r); background: var(--xb-bg); font-size: 13px; }
  li.error { border-left-color: var(--xb-danger); }
  li.warning { border-left-color: var(--xb-coral); }
  li.info { border-left-color: var(--xb-accent); }
  .sev { font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.04em; color: var(--xb-muted); }
  .area { font-size: 11.5px; color: var(--xb-muted); }
  li button { font: 500 12px var(--xb-sans); padding: 3px 9px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .ok { color: var(--xb-muted); margin: 0; }
</style>
