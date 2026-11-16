<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { ImportReportView } from "../lib/api.js";
  import type { BuildResult, CmsBuild, CmsProjectDetails, CmsTab } from "../lib/app-types.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";

  /** What the project's page says on top: the WordPress import, the last build, the import report. */
  let { language, act, cmsBuild, cmsBuildSummary = $bindable(), cmsBuilding, cmsImportHistory, cmsImportReport = $bindable(), cmsImportReportPanel = $bindable(), downloadCmsImportReport, launchCmsEditor, openCmsTab, prototypeCounts, report, selectedCmsProject, wordPressReport = $bindable() }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    cmsBuild: CmsBuild | null;
    cmsBuildSummary: HTMLElement | null;
    cmsBuilding: boolean;
    cmsImportHistory: Array<{ id: string; createdAt: string; file: string | null; result: string | null }>;
    cmsImportReport: ImportReportView | null;
    cmsImportReportPanel: HTMLElement | null;
    downloadCmsImportReport: (projectId: string, reportId: string) => Promise<void>;
    launchCmsEditor: (page: { alias: number }, back?: string) => void;
    openCmsTab: (tab: CmsTab, target?: string) => void;
    prototypeCounts: (counts: Record<string, number>) => string;
    report: BuildResult | null;
    selectedCmsProject: CmsProjectDetails | null;
    wordPressReport: { projectId: string; pages: number; posts: number; images: { saved: number; failed: number }; lost: Record<string, number>; skipped: Record<string, number>; failed: string[]; articles: Array<{ title: string; lost: Record<string, number> }>; featuredImages?: { posts: number; removedFromText: string[] } } | null;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const formatDate = (value?: string) => formatDateIn(language, value);

  /** "11 pages in the site: 2 project pages, 9 from posts, content, archives and 404", with the drafts left out. */
  function cmsBuildExplanation(build: CmsBuild, project: CmsProjectDetails): { counts: string; drafts: string } {
    const published = project.pages.filter((page) => page.status === "published").length;
    const generated = Math.max(0, build.pages - published);
    const drafts = project.pages.filter((page) => page.status === "draft").map((page) => page.title || page.slug);
    return {
      counts: t("cms.buildCounts", { pages: build.pages, published, generated }),
      drafts: drafts.length ? t("cms.buildDrafts", { names: drafts.slice(0, 5).join(", ") + (drafts.length > 5 ? ` ${t("cms.buildDraftsMore", { n: drafts.length - 5 })}` : "") }) : "",
    };
  }
  function cmsReportSource(report: ImportReportView): string {
    const time = new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-US", { hour: "2-digit", minute: "2-digit" }).format(new Date(report.at));
    return report.source.kind === "agent" ? t("cms.reportByAgent", { client: report.source.client, time }) : t("cms.reportByApp", { time });
  }
</script>

{#if selectedCmsProject}
  {#if wordPressReport?.projectId === selectedCmsProject.project.id}
    {@const left = [...Object.entries(wordPressReport.lost), ...Object.entries(wordPressReport.skipped)]}
    <section class="panel-card import-summary" data-testid="wordpress-report">
      <button class="modal-close" aria-label={t("common.close")} onclick={() => wordPressReport = null}>×</button>
      <h2>{t("cms.wordpressReport")}</h2>
      <p class="muted">{t("cms.wordpressImported", { name: selectedCmsProject.project.name, pages: wordPressReport.pages, posts: wordPressReport.posts, images: wordPressReport.images.saved })}{wordPressReport.images.failed ? ` ${t("cms.wordpressImagesFailed", { n: wordPressReport.images.failed })}` : ""}</p>
      {#if left.length}<p><strong>{t("cms.wordpressReportSkipped")}:</strong> {left.map(([name, count]) => `${name} (${count})`).join(", ")}</p>{/if}
      {#if wordPressReport.failed.length}<details><summary>{t("cms.wordpressReportFailed")}: {wordPressReport.failed.length}</summary><ul>{#each wordPressReport.failed as line (line)}<li>{line}</li>{/each}</ul></details>{/if}
      {#if wordPressReport.featuredImages?.posts}<p data-testid="cms-wordpress-featured">{t("cms.wordpressFeatured", { n: wordPressReport.featuredImages.posts })}</p>{/if}
      {#if wordPressReport.featuredImages?.removedFromText.length}<details data-testid="cms-wordpress-featured-removed"><summary>{t("cms.wordpressFeaturedRemoved", { n: wordPressReport.featuredImages.removedFromText.length })}</summary><ul>{#each wordPressReport.featuredImages.removedFromText as title, position (position)}<li>{title}</li>{/each}</ul></details>{/if}
      {#if wordPressReport.articles.length}<details data-testid="cms-wordpress-articles"><summary>{t("cms.wordpressReportArticles", { n: wordPressReport.articles.length })}</summary><ul>{#each wordPressReport.articles as article, position (position)}<li>{article.title}: {Object.entries(article.lost).map(([name, count]) => `${name} (${count})`).join(", ")}</li>{/each}</ul></details>{/if}
    </section>
  {/if}
  {#if cmsBuilding}
    <p class="cms-build-summary is-running" role="status"><span class="cms-build-spinner" aria-hidden="true"></span>{t("cms.buildRunning")}</p>
  {:else if cmsBuild && cmsBuild.status !== "unavailable"}
    {@const explanation = cmsBuildExplanation(cmsBuild, selectedCmsProject)}
    <section class="cms-build-summary" class:is-ready={cmsBuild.status === "ready"} class:is-blocked={cmsBuild.status !== "ready"} tabindex="-1" bind:this={cmsBuildSummary} aria-labelledby="cms-build-summary-title" data-testid="cms-build-summary">
      <div>
        <strong id="cms-build-summary-title">{cmsBuild.status === "ready" && cmsBuild.current === false ? say("Versione precedente", "Previous build") : cmsBuild.status === "ready" ? t("cms.buildReady") : t("cms.buildBlocked")}</strong>
        {#if cmsBuild.current !== false}<span>{explanation.counts}</span>{#if explanation.drafts}<span>{explanation.drafts}</span>{/if}{#if cmsBuild.imagesNote}<span data-testid="cms-build-images">{cmsBuild.imagesNote}</span>{/if}{/if}
      </div>
      <div class="cms-build-summary-actions">
        {#if cmsBuild.previewUrl}<a class="button primary small" href={cmsBuild.previewUrl} target="_blank" rel="noreferrer">{t("cms.openPreview")}</a>{/if}
        <button class="button text small" type="button" onclick={() => openCmsTab("publish", "cms-build-result")}>{t("cms.buildDetails")}</button>
      </div>
    </section>
  {/if}
  {#if cmsImportReport && cmsImportReport.projectId === selectedCmsProject.project.id}
    {@const imported = cmsImportReport}
    {@const pages = selectedCmsProject.pages}
    <section class="panel-card cms-import-report" tabindex="-1" bind:this={cmsImportReportPanel} aria-labelledby="cms-import-report-title" data-testid="cms-import-report">
      <div class="cms-import-report-head">
        <div>
          <div class="eyebrow">{t("cms.reportEyebrow")}</div>
          <h2 id="cms-import-report-title">{imported.result === "updated" ? t("cms.reportUpdated") : t("cms.reportCreated")}</h2>
          <p class="muted">{[imported.file, cmsReportSource(imported)].filter(Boolean).join(" · ")}</p>
        </div>
        <button class="modal-close" aria-label={t("cms.reportClose")} onclick={() => cmsImportReport = null}>×</button>
      </div>
      <p>{t("cms.reportCounts", { counts: prototypeCounts(imported.counts) || t("cms.checkEmpty") })}{#if imported.result === "updated"} {t("cms.reportChanges", { changed: imported.changed ?? 0, kept: imported.keptLocal ?? 0, unchanged: imported.unchanged ?? 0 })}{/if}</p>
      {#if pages.length > 0}
        <div class="cms-import-report-pages">
          <strong>{t("cms.reportPages")}</strong>
          <ul>
            {#each pages.slice(0, 12) as page (page.id)}<li><span>{page.title || page.slug}</span><button class="button text small" aria-label={`${t("cms.reportOpenBuilder")}: ${page.title || page.slug}`} onclick={() => launchCmsEditor(page)}>{t("cms.reportOpenBuilder")} →</button></li>{/each}
          </ul>
          {#if pages.length > 12}<small class="muted">{t("cms.reportMore", { n: pages.length - 12 })}</small>{/if}
        </div>
      {/if}
      {#if imported.ignored.length > 0}
        <details class="cms-check-list" data-testid="cms-import-report-ignored">
          <summary>{t("cms.checkIgnored", { n: imported.ignored.length + imported.omitted.ignored })}</summary>
          <ul>{#each imported.ignored as item, index (index)}<li><strong>{item.what}</strong>{#if item.line}{" "}<span class="muted">({t("cms.problemsLine", { line: item.line })})</span>{/if} — {item.why}</li>{/each}</ul>
          {#if imported.omitted.ignored > 0}<small class="muted">{t("cms.reportMore", { n: imported.omitted.ignored })}</small>{/if}
        </details>
      {/if}
      {#if imported.warnings.length > 0}
        <details class="cms-check-list" open data-testid="cms-import-report-warnings">
          <summary>{t("cms.checkWarnings", { n: imported.warnings.length + imported.omitted.warnings })}</summary>
          <ul>{#each imported.warnings as warning, index (index)}<li>{warning}</li>{/each}</ul>
          {#if imported.omitted.warnings > 0}<small class="muted">{t("cms.reportMore", { n: imported.omitted.warnings })}</small>{/if}
        </details>
      {/if}
      {#if imported.placeholders.length > 0}<p class="muted">{t("cms.reportPlaceholders", { n: imported.placeholders.length + imported.omitted.placeholders })}</p>{/if}
      {#if imported.images}<p class="muted" data-testid="cms-import-report-images">{imported.images.note}</p>{/if}
      {#if cmsImportHistory.length}
        {@const reportProject = imported.projectId}
        <details class="cms-import-history" data-testid="cms-import-history" open>
          <summary>{t("cms.reportHistory", { n: cmsImportHistory.length })}</summary>
          <ul>{#each cmsImportHistory as entry (entry.id)}<li><button class="button outline small" type="button" onclick={() => void act(() => downloadCmsImportReport(reportProject, entry.id))}>{t("cms.reportDownload")}</button> {formatDate(entry.createdAt)}{entry.file ? ` · ${entry.file}` : ""}</li>{/each}</ul>
        </details>
      {/if}
    </section>
  {/if}
{/if}
