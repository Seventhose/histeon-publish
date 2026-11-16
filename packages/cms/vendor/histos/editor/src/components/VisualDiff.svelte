<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import type { Change } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { VIEWPORTS, compare, describe, signature, type Viewport, type VisualResult } from '../lib/visualDiff.ts';
  import { loadFrame, pageTargets, settle, type PageTarget } from '../lib/pages.ts';

  // Optional visual check in the Publish window (docs/spec/versioning.md §8): each page that changes, plus the page
  // open in the builder (styles and components show through it), online and in development, side by side.
  /** active: a comparison is on screen (the window widens for it). */
  let { app, changes, active = $bindable(false) }: { app: BuilderState; changes: Change[]; active?: boolean } = $props();

  interface Row {
    target: PageTarget & { live: string };
    vp: Viewport;
    result: VisualResult | null | 'loading' | string;
  }

  let rows = $state<Row[]>([]);
  let skipped = $state<string[]>([]);
  let running = $state(false);
  let shown = $state<Row | null>(null);
  let error = $state('');
  let stageWidth = $state(700);
  let before: HTMLIFrameElement | undefined = $state();
  let after: HTMLIFrameElement | undefined = $state();
  /** Marked elements in the development frame, to step through them. */
  let marks: Element[] = [];
  let markIndex = $state(-1);
  let markCount = $state(0);

  const scale = $derived(shown ? Math.min(1, (stageWidth - 16) / 2 / shown.vp.width) : 1);

  /** Marks what changed: new or different in development, gone in the online page. */
  function mark(doc: Document, elements: Element[], indexes: number[], kind: 'dev' | 'live') {
    const width = Math.max(2, Math.ceil(2 / scale));
    const style = doc.createElement('style');
    const color = kind === 'dev' ? 'rgb(255 90 78 / 0.9)' : 'rgb(37 99 235 / 0.85)';
    style.textContent = `[data-xb-vd]{outline:${width}px solid ${color}!important;outline-offset:-${Math.ceil(width / 2)}px!important}`;
    doc.head?.append(style);
    for (const i of indexes) elements[i]?.setAttribute('data-xb-vd', '');
  }

  /** The frames are pictures: links do not navigate, and the two scroll together. */
  function wire(a: Document, b: Document) {
    for (const d of [a, b]) d.addEventListener('click', (e) => e.preventDefault(), true);
    let syncing = false;
    const follow = (from: Document, to: Document) => () => {
      if (syncing) return;
      syncing = true;
      to.defaultView?.scrollTo(0, from.defaultView?.scrollY ?? 0);
      requestAnimationFrame(() => (syncing = false));
    };
    a.defaultView?.addEventListener('scroll', follow(a, b));
    b.defaultView?.addEventListener('scroll', follow(b, a));
  }

  async function check(row: Row): Promise<void> {
    shown = row;
    marks = [];
    markIndex = -1;
    markCount = 0;
    await new Promise((r) => requestAnimationFrame(r));
    if (!before || !after) return;
    try {
      const [a, b] = await Promise.all([loadFrame(before, row.target.live), loadFrame(after, row.target.dev)]);
      await Promise.all([settle(a), settle(b)]);
      const sa = signature(a);
      const sb = signature(b);
      const result = compare(sa.nodes, sb.nodes, (outer, inner) => sb.elements[outer]!.contains(sb.elements[inner]!));
      row.result = result;
      if (result) {
        mark(b, sb.elements, [...result.added, ...result.changed], 'dev');
        mark(a, sa.elements, result.removed, 'live');
        marks = [...result.added, ...result.changed].sort((p, q) => p - q).map((i) => sb.elements[i]!);
        markCount = marks.length;
      }
      wire(a, b);
    } catch (e) {
      row.result = e instanceof Error ? e.message : String(e);
    }
    rows = [...rows];
  }

  export async function run() {
    running = true;
    active = true;
    error = '';
    try {
      const found = await pageTargets(app.api, app.postId, changes, true);
      skipped = found.skipped;
      const list = found.targets.filter((t): t is PageTarget & { live: string } => t.live !== null);
      rows = list.flatMap((target) => VIEWPORTS.map((vp) => ({ target, vp, result: 'loading' as const })));
      for (const row of rows) await check(row);
      shown = rows.find((r) => typeof r.result === 'object' && r.result !== null && !r.result.same) ?? rows[0] ?? null;
      if (shown && rows.length > 1) await check(shown);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }

  function next() {
    if (marks.length === 0) return;
    markIndex = (markIndex + 1) % marks.length;
    marks[markIndex]?.scrollIntoView({ block: 'center' });
  }

  const differs = $derived(rows.filter((r) => typeof r.result === 'object' && r.result !== null && !r.result.same).length);
</script>

<section class="vd" aria-label={t('Confronto visivo')}>
  <div class="head">
    <div>
      <strong>{t('Confronto visivo')}</strong>
      <span class="muted">{t('facoltativo: la pagina online e quella in sviluppo, a schermo grande e su telefono, con le differenze segnate')}</span>
    </div>
    <button type="button" onclick={run} disabled={running}>{running ? t('Confronto…') : rows.length ? t('Rifai il confronto') : t('Confronta')}</button>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if rows.length}
    <table>
      <tbody>
        {#each rows as row (row.target.id + row.vp.name)}
          <tr class:current={shown === row}>
            <td>{row.target.label}</td>
            <td class="muted">{row.vp.label}</td>
            <td>
              {#if row.result === 'loading'}<span class="muted">{t('in attesa')}</span>
              {:else if typeof row.result === 'string'}<span class="error">{row.result}</span>
              {:else}<span class:ok={row.result?.same} class:warn={!row.result?.same}>{describe(row.result)}</span>{/if}
            </td>
            <td><button type="button" class="link" disabled={running} onclick={() => check(row)}>{t('Mostra')}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if !running}<p class="muted" role="status">{differs === 0 ? t('Nessuna differenza visibile nelle pagine confrontate.') : tn('{0} confronto mostra differenze: guardale prima di pubblicare.', '{0} confronti mostrano differenze: guardale prima di pubblicare.', differs, differs)}</p>{/if}
  {/if}
  {#each skipped as note (note)}<p class="muted">{note}</p>{/each}
  {#if shown}
    <div class="legend">
      <span><i class="live"></i>{t('Online')} <small>{t('(in blu ciò che sparisce)')}</small></span>
      <span><i class="dev"></i>{t('In sviluppo')} <small>{t('(in corallo ciò che è nuovo o cambia)')}</small></span>
      {#if markCount}<button type="button" class="link" onclick={next}>{t('Prossima differenza ({0}/{1})', markIndex + 1, markCount)}</button>{/if}
    </div>
    <div class="stage" bind:clientWidth={stageWidth}>
      {#each [[t('Online'), 'before'], [t('In sviluppo'), 'after']] as [title, which] (which)}
        <div class="box" style:width="{shown.vp.width * scale}px" style:height="{shown.vp.height * scale}px">
          {#if which === 'before'}
            <iframe bind:this={before} title="{title}: {shown.target.label}" sandbox="allow-same-origin" style:width="{shown.vp.width}px" style:height="{shown.vp.height}px" style:transform="scale({scale})"></iframe>
          {:else}
            <iframe bind:this={after} title="{title}: {shown.target.label}" sandbox="allow-same-origin" style:width="{shown.vp.width}px" style:height="{shown.vp.height}px" style:transform="scale({scale})"></iframe>
          {/if}
        </div>
      {/each}
    </div>
    <p class="muted">{t('Le pagine sono mostrate senza i loro script, come nella tela: ciò che uno script disegna dopo il caricamento non entra nel confronto.')}</p>
  {/if}
</section>

<style>
  .vd { border: 1px solid var(--xb-line); border-radius: var(--xb-r); padding: 8px 12px; display: grid; gap: 8px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .head div { display: grid; gap: 2px; font-size: 13px; }
  .muted { color: var(--xb-muted); font-size: 12px; margin: 0; }
  .error { color: var(--xb-danger); font-size: 12px; margin: 0; }
  .ok { color: var(--xb-ok); }
  .warn { color: var(--xb-coral); font-weight: 600; }
  table { border-collapse: collapse; font-size: 12.5px; width: 100%; }
  td { padding: 4px 6px; border-top: 1px solid var(--xb-line); vertical-align: top; }
  tr.current td { background: var(--xb-hover); }
  .link { border: 0; padding: 2px 4px; color: var(--xb-link); font-size: 12px; background: none; cursor: pointer; }
  .legend { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 12px; }
  .legend i { display: inline-block; inline-size: 10px; block-size: 10px; border-radius: 2px; margin-inline-end: 5px; }
  .legend i.live { background: rgb(37 99 235); }
  .legend i.dev { background: rgb(255 90 78); }
  .legend small { color: var(--xb-muted); }
  .stage { display: flex; gap: 16px; justify-content: center; }
  .box { overflow: hidden; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: #fff; flex: none; }
  iframe { border: 0; transform-origin: 0 0; display: block; background: #fff; }
</style>
