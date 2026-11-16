<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import type { Change } from '../lib/api.ts';
  import { LINK_LIMIT, brokenLinkProblem, checksOutcome, brokenStatus, devOnlyMatcher, headFacts, headStatus, headProblems, pageWeight, pickLinks, probeLinks, probeTarget, runChecks, siteProblems, weightProblem, type ChecksOutcome, type Finding } from '../lib/checks.ts';
  import { loadFrame, pageTargets, settle, type PageTarget } from '../lib/pages.ts';
  import { VIEWPORTS, appearanceSummary, compare, signature, type VisualResult } from '../lib/visualDiff.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The page checks (docs/spec/checks.md) on the development version of every page that changes, from the Publish
  // window. With «Blocca la pubblicazione se i controlli trovano errori» on, they run by themselves and errors
  // keep Publish disabled; otherwise they are a button. Pages load in a sandboxed frame: no script of theirs runs.
  // Besides the canvas rules: the head of each page, the site closed to search engines (once), the page weight and,
  // after the pages, the links of the same site (HEAD from this browser, without cookies; never another site).
  /**
   * blogPublic: WordPress lets search engines index the site. onlook: opens the visual comparison. outcome: the
   * counts sent with the release (V1.5), only once the pages and their links are all checked; null before.
   */
  let { app, changes, block = false, blogPublic = true, onlook, errors = $bindable(0), ready = $bindable(true), outcome = $bindable(null) }: { app: BuilderState; changes: Change[]; block?: boolean; blogPublic?: boolean; onlook?: () => void; errors?: number; ready?: boolean; outcome?: ChecksOutcome | null } = $props();

  interface PageResult {
    target: PageTarget;
    findings: Finding[] | string;
  }

  const order: Record<Finding['severity'], number> = { error: 0, warning: 1, info: 2 };
  const sorted = (list: Finding[]) => [...list].sort((a, b) => order[a.severity] - order[b.severity]);

  let results = $state<PageResult[]>([]);
  let site = $state<Finding[]>([]);
  let skipped = $state<string[]>([]);
  /** M-B1: the pages of the release, checked or not; at least one when the list itself could not be read. */
  let pageTotal = 0;
  let running = $state(false);
  let probing = $state(false);
  let linkNote = $state('');
  let open = $state<Record<number, boolean>>({});
  let frame: HTMLIFrameElement | undefined = $state();
  /** Ran once by itself (blocking mode); then only on request. */
  let started = false;
  /** Stops the link requests when the window closes or the checks start again. */
  let stop: AbortController | null = null;

  // «Aspetto» (V7.1): only on request, because it loads every page twice more (online and in development) at two
  // widths, in a frame of its own.
  let look = $state<{ desktop: number; mobile: number; failed: number; pages: number } | 'loading' | string | null>(null);
  let lookFrame: HTMLIFrameElement | undefined = $state();
  let lookSize = $state({ width: VIEWPORTS[0]!.width, height: VIEWPORTS[0]!.height });

  const errorsOf = (r: PageResult) => (typeof r.findings === 'string' ? 0 : r.findings.filter((f) => f.severity === 'error').length);
  const warningsOf = (r: PageResult) => (typeof r.findings === 'string' ? 0 : r.findings.filter((f) => f.severity !== 'error').length);

  export async function run() {
    stop?.abort();
    stop = new AbortController();
    const signal = stop.signal;
    running = true;
    ready = false;
    outcome = null;
    results = [];
    linkNote = '';
    site = siteProblems({ blogPublic });
    /** Links of every page: which page, the address as written, where it resolves, its element. */
    const links: Array<{ page: number; href: string; target: string | null; uid: string | null }> = [];
    pageTotal = 0;
    try {
      const found = await pageTargets(app.api, app.postId, changes, false);
      skipped = found.skipped;
      pageTotal = found.total;
      for (const target of found.targets) {
        if (!frame) break;
        try {
          const doc = await loadFrame(frame, target.dev);
          await settle(doc);
          const perf = doc.defaultView?.performance;
          const weight = perf ? pageWeight([...perf.getEntriesByType('navigation'), ...perf.getEntriesByType('resource')] as PerformanceResourceTiming[]) : 0;
          const heavy = weightProblem(weight);
          const findings = [...runChecks(doc, { page: true }), ...headProblems(headFacts(doc), { online: target.live !== null, siteHidden: !blogPublic }), ...(heavy ? [heavy] : [])];
          for (const a of doc.querySelectorAll('a[href]')) {
            if (a.closest('[data-xb-preview-badge], #wpadminbar')) continue;
            const href = a.getAttribute('href') ?? '';
            links.push({ page: results.length, href, target: probeTarget(href, doc.baseURI, window.location.origin), uid: a.closest('[data-xb-uid]')?.getAttribute('data-xb-uid') ?? null });
          }
          results = [...results, { target, findings: sorted(findings) }];
        } catch (e) {
          results = [...results, { target, findings: e instanceof Error ? e.message : String(e) }];
        }
      }
    } catch (e) {
      skipped = [e instanceof Error ? e.message : String(e)];
      pageTotal = Math.max(pageTotal, results.length + 1);
    } finally {
      frame?.removeAttribute('src');
      // A page that could not be checked counts as an error when publishing is blocked on errors.
      errors = site.filter((f) => f.severity === 'error').length + results.reduce((n, r) => n + errorsOf(r) + (block && typeof r.findings === 'string' ? 1 : 0), 0);
      running = false;
      ready = true;
    }
    // Broken links are warnings: they never hold «Pubblica», so they are tried after the pages.
    await checkLinks(links, signal);
    // Only a whole round counts: checks started again or stopped leave no outcome.
    // A page that did not load is not checked: `pages` says so (M-B1), so «0 errori» is never read as the whole release.
    if (!signal.aborted) outcome = checksOutcome([...site, ...results.flatMap((r) => (typeof r.findings === 'string' ? [] : r.findings))], Date.now(), { checked: results.filter((r) => typeof r.findings !== 'string').length, total: pageTotal });
  }

  async function checkLinks(links: Array<{ page: number; href: string; target: string | null; uid: string | null }>, signal: AbortSignal) {
    const { urls, over } = pickLinks(links.map((l) => l.target));
    if (urls.length === 0) return;
    probing = true;
    try {
      const status = await probeLinks(urls, (url, s) => headStatus(url, s), { signal });
      if (signal.aborted) return;
      let devOnly = (_url: string) => false;
      if (urls.some((u) => brokenStatus(status.get(u)))) {
        // A page that exists only in development answers 404 to visitors: not a broken link of this release.
        const lists = await Promise.all((['page', 'post'] as const).map((type) => app.api.library(type).then((l) => l.items).catch(() => [])));
        devOnly = devOnlyMatcher(lists.flat());
      }
      const add = new Map<number, Finding[]>();
      let broken = 0;
      for (const link of links) {
        const code = link.target === null ? null : status.get(link.target);
        if (link.target === null || !brokenStatus(code) || devOnly(link.target)) continue;
        broken++;
        add.set(link.page, [...(add.get(link.page) ?? []), brokenLinkProblem(link.href, code as number, link.uid)].slice(0, 25));
      }
      if (signal.aborted) return;
      results = results.map((r, i) => (add.has(i) && typeof r.findings !== 'string' ? { ...r, findings: sorted([...r.findings, ...add.get(i)!]) } : r));
      linkNote =
        tn('{0} link dello stesso sito provato', '{0} link dello stesso sito provati', urls.length, urls.length) +
        (broken ? ' ' + tn('({0} rotto)', '({0} rotti)', broken, broken) : '') +
        (over ? ' ' + t('Oltre i {0} link di una release: {1} non provati.', LINK_LIMIT, over) : '');
    } finally {
      probing = false;
    }
  }

  async function measureLook() {
    look = 'loading';
    try {
      const found = await pageTargets(app.api, app.postId, changes, true);
      const rows: Array<{ vp: (typeof VIEWPORTS)[number]['name']; result: VisualResult | null | string }> = [];
      const pages = found.targets.filter((p): p is PageTarget & { live: string } => p.live !== null);
      for (const vp of VIEWPORTS) {
        lookSize = { width: vp.width, height: vp.height };
        await new Promise((r) => requestAnimationFrame(r));
        for (const page of pages) {
          if (!lookFrame) break;
          try {
            const before = await loadFrame(lookFrame, page.live);
            await settle(before);
            const a = signature(before).nodes;
            const after = await loadFrame(lookFrame, page.dev);
            await settle(after);
            const b = signature(after);
            rows.push({ vp: vp.name, result: compare(a, b.nodes, (outer, inner) => b.elements[outer]!.contains(b.elements[inner]!)) });
          } catch (e) {
            rows.push({ vp: vp.name, result: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      look = { ...appearanceSummary(rows), pages: pages.length };
    } catch (e) {
      look = e instanceof Error ? e.message : String(e);
    } finally {
      lookFrame?.removeAttribute('src');
    }
  }

  $effect(() => {
    if (block && frame && !started) {
      started = true;
      void run();
    }
  });

  $effect(() => () => stop?.abort());
</script>

<section class="pc" aria-label={t('Controlli prima di pubblicare')}>
  <div class="head">
    <div>
      <strong>{t('Controlli delle pagine')}</strong>
      <span class="muted">{block ? t('obbligatori: con errori non si pubblica') : t('facoltativi: accessibilità, SEO e prestazioni della versione in sviluppo')}</span>
    </div>
    <button type="button" onclick={run} disabled={running || probing}>{running ? t('Controllo…') : probing ? t('Controllo dei link…') : results.length ? t('Rifai i controlli') : t('Controlla')}</button>
  </div>
  {#if site.length}
    <ul>
      {#each site as f (f.rule)}
        <li class={f.severity}><span class="area">{f.area}</span> {f.message}</li>
      {/each}
    </ul>
  {/if}
  {#each results as r (r.target.id)}
    {@const e = errorsOf(r)}
    {@const w = warningsOf(r)}
    <div class="page">
      <span>{r.target.label}</span>
      {#if typeof r.findings === 'string'}
        <span class="error">{r.findings}</span>
      {:else if r.findings.length === 0}
        <span class="ok">{t('nessuna segnalazione')}</span>
      {:else}
        <button type="button" class="link" aria-expanded={!!open[r.target.id]} onclick={() => (open = { ...open, [r.target.id]: !open[r.target.id] })}>
          <span class:error={e > 0}>{tn('{0} errore', '{0} errori', e, e)}</span>{t(', {0} da rivedere', w)}
        </button>
      {/if}
    </div>
    {#if open[r.target.id] && typeof r.findings !== 'string'}
      <ul>
        {#each r.findings as f, i (i)}
          <li class={f.severity}><span class="area">{f.area}</span> {f.message}</li>
        {/each}
      </ul>
    {/if}
  {/each}
  {#if probing}<p class="muted" role="status">{t('Controllo dei link dello stesso sito…')}</p>{:else if linkNote}<p class="muted">{linkNote}</p>{/if}
  {#each skipped as note (note)}<p class="muted">{note}</p>{/each}
  <div class="page look">
    {#if look === null}
      <span class="muted">{t('Aspetto: quante pagine cambiano rispetto al sito online, a schermo grande e al telefono')}</span>
      <button type="button" class="link" onclick={measureLook}>{t('Calcola')}</button>
    {:else if look === 'loading'}
      <span class="muted" role="status">{t('Aspetto: confronto in corso…')}</span>
    {:else if typeof look === 'string'}
      <span class="error">{look}</span>
      <button type="button" class="link" onclick={measureLook}>{t('Calcola')}</button>
    {:else}
      <span>
        {#if look.pages === 0}{t('Aspetto: nessuna pagina è già online, niente da confrontare')}
        {:else}{tn('Aspetto: {0} pagina cambia a schermo grande, {1} al telefono', 'Aspetto: {0} pagine cambiano a schermo grande, {1} al telefono', look.desktop, look.desktop, look.mobile)}{#if look.failed}{' '}<span class="muted">{tn('({0} confronto non riuscito)', '({0} confronti non riusciti)', look.failed, look.failed)}</span>{/if}{/if}
      </span>
      {#if onlook && look.pages > 0}<button type="button" class="link" onclick={onlook}>{t('Guarda')}</button>{/if}
    {/if}
  </div>
  {#if block && !running && errors > 0}<p class="error" role="alert">{t('Correggi gli errori nel builder, salva e rifai i controlli: poi si può pubblicare.')}</p>{/if}
  <iframe bind:this={frame} title={t('Pagina in controllo')} sandbox="allow-same-origin" class="work" aria-hidden="true" tabindex="-1"></iframe>
  <iframe bind:this={lookFrame} title={t('Pagina in confronto')} sandbox="allow-same-origin" class="work" style:width="{lookSize.width}px" style:height="{lookSize.height}px" aria-hidden="true" tabindex="-1"></iframe>
</section>

<style>
  .pc { border: 1px solid var(--xb-line); border-radius: var(--xb-r); padding: 8px 12px; display: grid; gap: 6px; position: relative; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .head div { display: grid; gap: 2px; font-size: 13px; }
  .muted { color: var(--xb-muted); font-size: 12px; margin: 0; }
  .error { color: var(--xb-danger); font-size: 12px; margin: 0; }
  .ok { color: var(--xb-ok); font-size: 12px; }
  .page { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; border-top: 1px solid var(--xb-line); padding-top: 4px; }
  .link { border: 0; padding: 0; color: var(--xb-link); font-size: 12px; background: none; cursor: pointer; }
  ul { margin: 0; padding: 0 0 0 4px; list-style: none; display: grid; gap: 3px; font-size: 12px; }
  li { padding-left: 8px; border-left: 3px solid var(--xb-line); }
  li.error { border-color: var(--xb-danger); color: var(--xb-text); }
  li.warning { border-color: var(--xb-coral); }
  .area { color: var(--xb-muted); font-size: 11px; margin-right: 4px; }
  /* Laid out at a desktop width (the checks measure images and styles) but never seen. */
  .work { position: fixed; left: -20000px; top: 0; width: 1366px; height: 900px; border: 0; visibility: hidden; }
</style>
