<script lang="ts">
  import { api } from "../lib/api.js";
  import { translate, type Language } from "../lib/i18n.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";

  /**
   * «Uguale alla proposta», a section of «Pronto per andare online?» shown only for a project that keeps the captured
   * proposal it was born from. Two numbers for each page and width: how much of the page differs from the proposal
   * «con i token» (the project's version) and «senza» (the proposal converted as it is). They do not change the
   * verdict: what the tokens move is explained, not corrected. The photographs are taken by the desktop app; anywhere
   * else the section says «non controllata». «Guarda fianco a fianco» shows the two sites, both still: no script of
   * either runs in these frames. Everything the server says about the pages is shown as text.
   */
  let { language, projectId, version }: {
    language: Language;
    projectId: string;
    /** The project's version in the panel: a new one asks the saved comparison again. */
    version: string;
  } = $props();

  interface Cause { property: string; count: number; examples: string[] }
  interface Causes { paired: number; onlyLeft: number; onlyRight: number; boxes: number; properties: Cause[]; fontsMissing: string[]; heights: [number, number] }
  interface Count { differentPixels: number; totalPixels: number; causes?: Causes }
  interface WidthRow { width: number; withTokens: Count | null; withoutTokens: Count | null }
  interface PageRow { name: string; path: string; found: { withTokens: boolean; withoutTokens: boolean }; widths: WidthRow[] }
  interface Answer { kept: boolean; available: boolean; running: boolean; failed: string | null; built: boolean; current: boolean; result: { checkedAt: string; pages: PageRow[]; notes: string[] } | null }
  interface View { original: string | null; built: string | null; pages: Array<{ name: string; path: string }> }
  type Side = "withTokens" | "withoutTokens";
  const SIDES: Side[] = ["withTokens", "withoutTokens"];
  const STAGE_HEIGHT = 460;

  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const formatDate = (value?: string) => formatDateIn(language, value);

  let answer = $state<Answer | null>(null);
  let problem = $state("");
  let view = $state<View | null>(null);
  let viewPage = $state("/");
  let viewWidth = $state(1280);
  let stageWidth = $state(0);
  const scale = $derived(stageWidth > 0 ? Math.min(1, stageWidth / viewWidth) : 1);
  const address = (id: string) => `/api/cms/v1/projects/${encodeURIComponent(id)}/admin/proposal-compare`;

  /** Reads the state again now (after a comparison was started). */
  let follow: () => void = () => undefined;
  $effect(() => {
    const id = projectId;
    void version;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    view = null;
    problem = "";
    const read = async (): Promise<void> => {
      try {
        const next = await api<Answer>(address(id));
        if (!alive) return;
        answer = next;
        if (next.running) timer = setTimeout(() => void read(), 1500);
      } catch {
        if (alive) answer = null;
      }
    };
    follow = () => { clearTimeout(timer); void read(); };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  });

  async function run(): Promise<void> {
    problem = "";
    try {
      answer = await api<Answer>(address(projectId), { method: "POST", body: "{}" });
      follow();
    } catch (error) {
      problem = error instanceof Error ? error.message : t("ready.proposal.failed");
    }
  }

  async function openView(): Promise<void> {
    problem = "";
    try {
      const next = await api<View>(`${address(projectId)}/view`, { method: "POST", body: "{}" });
      viewPage = next.pages[0]?.path ?? "/";
      view = next;
    } catch (error) {
      problem = error instanceof Error ? error.message : t("ready.proposal.failed");
    }
  }

  /** The share of the page that differs, in words: «uguale», «0,42 %». */
  function share(count: Count): string {
    if (count.differentPixels === 0) return t("ready.proposal.same");
    const percent = (count.differentPixels / count.totalPixels) * 100;
    if (percent < 0.01) return t("ready.proposal.percent", { n: `< ${(0.01).toLocaleString(language === "it" ? "it-IT" : "en-GB")}` });
    return t("ready.proposal.percent", { n: percent.toLocaleString(language === "it" ? "it-IT" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  }
  function cell(page: PageRow, row: WidthRow, side: Side): string {
    const count = row[side];
    if (count) return share(count);
    return page.found[side] ? t("ready.proposal.unmeasured") : t("ready.proposal.missing");
  }
  /** `fontSize` as it is written in a style sheet: `font-size`. */
  const cssName = (property: string) => property.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  const explained = (page: PageRow) => page.widths.flatMap((row) => SIDES.flatMap((side) => { const causes = row[side]?.causes; return causes ? [{ key: `${row.width}-${side}`, width: row.width, side, causes }] : []; }));
  /** A page of one of the two sites: the site's own address, with the page's path under it. */
  const pageUrl = (root: string, path: string) => `${root}${path.replace(/^\//u, "")}`;
  const phase = $derived(!answer ? "unchecked" : answer.running ? "running" : answer.result ? "checked" : "unchecked");
</script>

{#if answer?.kept}
  <section class="match match--{phase}" aria-labelledby="cms-proposal-match-heading" data-testid="cms-proposal-match">
    <p class="match__head"><strong id="cms-proposal-match-heading">{t("ready.proposal.title")}</strong> · <span data-testid="cms-proposal-match-state" data-state={phase}>{t(`ready.proposal.state.${phase}`)}</span></p>
    <p class="match__note">{t("ready.proposal.what")}</p>
    {#if answer.result}
      {@const result = answer.result}
      <table class="match__table" data-testid="cms-proposal-match-table">
        <caption>{t("ready.proposal.caption", { at: formatDate(result.checkedAt) })}</caption>
        <thead>
          <tr><th scope="col">{t("ready.proposal.page")}</th><th scope="col">{t("ready.proposal.width")}</th><th scope="col">{t("ready.proposal.withTokens")}</th><th scope="col">{t("ready.proposal.withoutTokens")}</th></tr>
        </thead>
        <tbody>
          {#each result.pages as page (page.path)}
            {#each page.widths as row, position (row.width)}
              <tr>
                {#if position === 0}<th scope="rowgroup" rowspan={page.widths.length}>{page.name} <code>{page.path}</code></th>{/if}
                <td>{t("ready.proposal.px", { n: row.width })}</td>
                {#each SIDES as side (side)}<td data-testid="cms-proposal-match-{side}" class:match__zero={row[side]?.differentPixels === 0}>{cell(page, row, side)}</td>{/each}
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
      {#if !answer.current}<p class="match__note" data-testid="cms-proposal-match-stale">{t("ready.proposal.stale")}</p>{/if}
      {#each result.notes as note (note)}<p class="match__note">{note}</p>{/each}
      {#if result.pages.some((page) => explained(page).length)}
        <details class="match__why" data-testid="cms-proposal-match-why">
          <summary>{t("ready.proposal.why")}</summary>
          <p class="match__note">{t("ready.proposal.whyHint")}</p>
          {#each result.pages as page (page.path)}
            {#each explained(page) as item (item.key)}
              <h4>{page.name} · {t("ready.proposal.px", { n: item.width })} · {t(`ready.proposal.${item.side}`)}</h4>
              <ul>
                {#if item.causes.fontsMissing.length}<li>{t("ready.proposal.fontsMissing", { fonts: item.causes.fontsMissing.join(", ") })}</li>{/if}
                {#if item.causes.heights[0] !== item.causes.heights[1]}<li>{t("ready.proposal.heights", { before: item.causes.heights[0], after: item.causes.heights[1] })}</li>{/if}
                {#if item.causes.onlyLeft || item.causes.onlyRight}<li>{t("ready.proposal.elements", { left: item.causes.onlyLeft, right: item.causes.onlyRight })}</li>{/if}
                {#if item.causes.boxes}<li>{t("ready.proposal.boxes", { n: item.causes.boxes })}</li>{/if}
                {#each item.causes.properties as cause (cause.property)}
                  <li><code>{cssName(cause.property)}</code> × {cause.count}{#if cause.examples.length}: {cause.examples[0]}{/if}</li>
                {/each}
                {#if !item.causes.properties.length && !item.causes.boxes && !item.causes.onlyLeft && !item.causes.onlyRight && !item.causes.fontsMissing.length}<li>{t("ready.proposal.noCause")}</li>{/if}
              </ul>
            {/each}
          {/each}
        </details>
      {/if}
    {/if}
    {#if answer.failed && !answer.running}<p class="match__problem" role="alert">{answer.failed}</p>{/if}
    {#if problem}<p class="match__problem" role="alert">{problem}</p>{/if}
    <p class="match__actions">
      {#if answer.available}
        <button class="button text small" onclick={() => void run()} disabled={answer.running || !answer.built} aria-busy={answer.running} data-testid="cms-proposal-match-run">{answer.running ? t("ready.proposal.running") : answer.result ? t("ready.proposal.again") : t("ready.proposal.run")}</button>
      {:else}
        <span class="match__note" data-testid="cms-proposal-match-app-only">{t("ready.proposal.appOnly")}</span>
      {/if}
      {#if view}
        <button class="button text small" onclick={() => { view = null; }} data-testid="cms-proposal-match-view-close">{t("ready.proposal.viewClose")}</button>
      {:else}
        <button class="button text small" onclick={() => void openView()} data-testid="cms-proposal-match-view">{t("ready.proposal.view")}</button>
      {/if}
    </p>
    {#if answer.running}<p class="match__note" role="status" aria-live="polite">{t("ready.proposal.runningHint")}</p>{/if}
    {#if view}
      <div class="match__view" data-testid="cms-proposal-match-frames">
        <p class="match__controls">
          <label>{t("ready.proposal.page")} <select bind:value={viewPage}>{#each view.pages as page (page.path)}<option value={page.path}>{page.name}</option>{/each}</select></label>
          <label>{t("ready.proposal.width")} <select bind:value={viewWidth}><option value={1280}>{t("ready.proposal.px", { n: 1280 })}</option><option value={390}>{t("ready.proposal.px", { n: 390 })}</option></select></label>
        </p>
        <div class="match__frames">
          <figure>
            <figcaption>{t("ready.proposal.original")}</figcaption>
            <div class="match__stage" bind:clientWidth={stageWidth} style:height={`${STAGE_HEIGHT}px`}>
              <!-- sandbox="": nothing of the captured page runs, whatever it holds; its own policy says the same. -->
              {#if view.original}<iframe src={pageUrl(view.original, viewPage)} sandbox="" referrerpolicy="no-referrer" title={t("ready.proposal.original")} data-testid="cms-proposal-match-original" style:width={`${viewWidth}px`} style:height={`${Math.round(STAGE_HEIGHT / scale)}px`} style:transform={`scale(${scale})`}></iframe>{:else}<p class="match__note">{t("ready.proposal.noOriginal")}</p>{/if}
            </div>
          </figure>
          <figure>
            <figcaption>{t("ready.proposal.built")}</figcaption>
            <div class="match__stage" style:height={`${STAGE_HEIGHT}px`}>
              {#if view.built}<iframe src={pageUrl(view.built, viewPage)} sandbox="" referrerpolicy="no-referrer" title={t("ready.proposal.built")} data-testid="cms-proposal-match-built" style:width={`${viewWidth}px`} style:height={`${Math.round(STAGE_HEIGHT / scale)}px`} style:transform={`scale(${scale})`}></iframe>{:else}<p class="match__note">{t("ready.proposal.noBuilt")}</p>{/if}
            </div>
          </figure>
        </div>
        <p class="match__note">{t("ready.proposal.viewHint")}</p>
      </div>
    {/if}
  </section>
{/if}

<style>
  .match { display: grid; gap: 6px; padding: 4px 0 4px 10px; border-left: 3px solid #b07a00; }
  .match--checked { border-left-color: var(--line); }
  .match__head, .match__note, .match__actions, .match__controls, .match__problem { margin: 0; }
  .match__note { color: var(--muted); }
  .match__problem { color: var(--danger, #b3261e); }
  .match__actions, .match__controls { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; }
  .match__table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .match__table caption { padding-bottom: 4px; color: var(--muted); text-align: left; }
  .match__table th, .match__table td { padding: 4px 8px 4px 0; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
  .match__table thead th { border-top: 0; font-weight: 700; }
  .match__table tbody th { font-weight: 400; }
  .match__zero { color: var(--mint-ink, #2f6b4f); }
  .match__why summary { cursor: pointer; }
  .match__why h4 { margin: 10px 0 2px; font-size: inherit; }
  .match__why ul { margin: 0; overflow-wrap: anywhere; }
  .match__view { display: grid; gap: 8px; }
  .match__frames { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .match__frames figure { display: grid; gap: 4px; min-width: 0; margin: 0; }
  .match__frames figcaption { font-weight: 700; }
  .match__stage { overflow: hidden; min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .match__stage iframe { display: block; border: 0; background: #fff; transform-origin: 0 0; }
  @media (max-width: 860px) {
    .match__frames { grid-template-columns: 1fr; }
  }
</style>
