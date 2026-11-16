<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { BuildResult, Screen, Site } from "../lib/app-types.js";
  import { formatBytes as formatBytesIn, formatDate as formatDateIn } from "../lib/app-format.js";

  /** The report of a build. */
  let { language, act, exportReport, nav, report, reportIsStale, selectedSite }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    exportReport: (format: "json" | "markdown") => Promise<void>;
    nav: (target: Screen) => void;
    report: BuildResult;
    reportIsStale: boolean;
    selectedSite: Site | null;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const formatDate = (value?: string) => formatDateIn(language, value);
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);
</script>

<section class="page-wrap">
  <button class="back-link" onclick={() => nav("site")}>← {t("report.back")}</button>
  <div class="page-heading"><div><div class="eyebrow">{t("report.eyebrow")}</div><h1>{t("report.title")}</h1><p>{t("report.subtitle")}</p></div><div class="heading-actions"><button class="button outline" onclick={() => void act(() => exportReport("json"))}>{t("report.exportJson")} ↓</button><button class="button outline" onclick={() => void act(() => exportReport("markdown"))}>{t("report.exportMd")} ↓</button></div></div>
  <div class="report-summary"><div class="report-status"><span class:good={report.status === "ready"} class:bad={report.status === "blocked"}>{report.status === "ready" ? "✓" : "!"}</span><div><strong>{report.status === "ready" ? say("Pronta per la revisione", "Ready for review") : say("Richiede attenzione", "Needs attention")}</strong><small>{selectedSite?.name} · {formatDate(report.completedAt ?? report.createdAt)}</small></div></div><div class="report-metrics"><div><strong>{report.findings?.filter((item) => item.severity === "block").length ?? 0}</strong><small>{t("report.blocks")}</small></div><div><strong>{report.findings?.filter((item) => item.severity === "warn").length ?? 0}</strong><small>{t("report.warnings")}</small></div><div><strong>{report.files ?? 0}</strong><small>{t("site.files")}</small></div><div><strong>{formatBytes(report.totalBytes)}</strong><small>{t("site.size")}</small></div></div></div>
  {#if reportIsStale}<p class="stale-build-note" role="status">{t("site.staleBody")}</p>{/if}
  <div class="report-grid"><section class="panel-card report-findings"><div class="section-card-header"><div><div class="eyebrow">CONTROLLO</div><h2>{t("report.findings")}</h2></div><span class="count-badge">{report.findings?.length ?? 0}</span></div>{#if !report.findings?.length}<div class="report-empty"><span>✓</span><p>{t("report.noneFindings")}</p><small>{t("report.noSnippet")}</small></div>{:else}<div class="finding-list">{#each report.findings ?? [] as finding}<article class="finding-row"><span class="finding-marker" class:block={finding.severity === "block"}>{finding.severity === "block" ? "!" : "△"}</span><div><div class="finding-meta"><strong>{finding.code}</strong><span>{finding.severity === "block" ? t("common.block") : t("common.warning")}</span></div><p>{finding.message}</p><code>{finding.file}{finding.line ? `:${finding.line}` : ""}</code></div></article>{/each}</div>{/if}</section>
    <aside class="report-side"><section class="panel-card report-subcard"><div class="section-card-header"><h2>{t("report.dynamics")}</h2><span class="count-badge">{report.report?.dynamicFeatures?.length ?? 0}</span></div>{#if report.report?.dynamicFeatures?.length}{#each report.report.dynamicFeatures as feature}<article class="dynamic-item"><span class="dynamic-icon">↗</span><div><strong>{feature.code}</strong><small>{feature.file}</small><p>{feature.message}</p><div class="solution"><b>{t("report.solution")}</b> {feature.solution}</div></div></article>{/each}{:else}<p class="empty-note">{t("report.noDynamics")}</p>{/if}<div class="dynamic-explanation">{t("report.dynamicHelp")}</div></section><section class="panel-card report-subcard"><div class="section-card-header"><h2>{t("report.skipped")}</h2><span class="count-badge">{report.skipped?.length ?? 0}</span></div>{#if report.skipped?.length}<ul class="compact-list">{#each report.skipped as item}<li>{item}</li>{/each}</ul>{:else}<p class="empty-note">{t("report.none")}</p>{/if}</section><section class="panel-card report-subcard"><div class="section-card-header"><h2>{t("report.redirects")}</h2><span class="count-badge">{report.redirects?.length ?? 0}</span></div>{#if report.redirects?.length}<ul class="compact-list">{#each report.redirects as redirect}<li><code>{redirect.from}</code> → <code>{redirect.to}</code> <small>{redirect.status}</small></li>{/each}</ul>{:else}<p class="empty-note">{t("report.none")}</p>{/if}</section><section class="panel-card report-subcard"><div class="section-card-header"><h2>{t("report.external")}</h2><span class="count-badge">{selectedSite?.externalAssets?.length ?? 0}</span></div>{#if selectedSite?.externalAssets?.length}<ul class="compact-list">{#each selectedSite.externalAssets as asset}<li><code>{asset}</code></li>{/each}</ul>{:else}<p class="empty-note">{t("report.noExternal")}</p>{/if}</section></aside></div>
</section>
