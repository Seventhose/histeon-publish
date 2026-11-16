<script lang="ts">
  import { plural, stateLabel, translate, type Language } from "../lib/i18n.js";
  import type { HistoryData, Screen } from "../lib/app-types.js";
  import { deployFailure, formatBytes as formatBytesIn, formatDate as formatDateIn } from "../lib/app-format.js";

  /** A site's builds and publications, local and on Cloudflare. */
  let { language, act, historyData, nav, refreshRemoteHistory, remoteHistory, showReport, onRollback }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    historyData: HistoryData;
    nav: (target: Screen) => void;
    refreshRemoteHistory: () => Promise<void>;
    remoteHistory: { deployments: Array<Record<string, unknown>>; versions: Array<Record<string, unknown>>; note?: string } | null;
    showReport: (buildId?: string) => Promise<void>;
    onRollback: (item: Record<string, unknown>) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const n = (key: string, count: number, values: Record<string, string | number> = {}) => plural(language, key, count, values);
  const stateOf = (status: string) => stateLabel(language, status);
  const formatDate = (value?: string) => formatDateIn(language, value);
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);
</script>

<section class="page-wrap"><button class="back-link" onclick={() => nav("site")}>← {t("new.back")}</button><div class="page-heading"><div><div class="eyebrow">{t("history.eyebrow")}</div><h1>{t("history.title")}</h1><p>{t("history.subtitle")}</p></div><button class="button outline" onclick={() => void act(refreshRemoteHistory)}>{t("history.refresh")} ↻</button></div>
  <div class="history-columns"><section class="panel-card"><div class="section-card-header"><div><div class="eyebrow">LOCALE</div><h2>{t("history.local")}</h2></div><span class="count-badge">{historyData.builds.length + historyData.deploys.length}</span></div><div class="timeline">{#each historyData.builds as item}<article class="timeline-entry"><span class="timeline-dot build-dot"></span><div class="timeline-content"><div class="timeline-top"><strong>{t("history.build")} · {stateOf(item.status).label}</strong><time>{formatDate(item.createdAt)}</time></div><p>{n("count.files", item.files ?? 0)} · {n("count.pages", item.pages ?? 0)} · {formatBytes(item.totalBytes)}</p><button class="button text small" onclick={() => void act(() => showReport(item.id))}>{t("site.report")} →</button></div></article>{/each}{#each historyData.deploys as item}<article class="timeline-entry"><span class="timeline-dot deploy-dot"></span><div class="timeline-content"><div class="timeline-top"><strong>{t("history.deploy")} · {stateOf(String(item.status ?? "")).label}</strong><time>{formatDate(String(item.createdAt ?? ""))}</time></div><p>{say("Versione", "Version")} {String(item.versionId ?? "—")}</p>{#if item.status === "failed" && deployFailure(language, item.error, item.failedPhase)}<p class="history-error">{deployFailure(language, item.error, item.failedPhase)}</p>{/if}</div></article>{/each}{#if !historyData.builds.length && !historyData.deploys.length}<p class="empty-note">{t("history.noLocal")}</p>{/if}</div></section>
    <section class="panel-card"><div class="section-card-header"><div><div class="eyebrow">{say("REMOTO", "REMOTE")}</div><h2>{t("history.remote")}</h2></div><span class="remote-icon" aria-hidden="true">◈</span></div>{#if remoteHistory}<p class="history-note">{remoteHistory.note ?? t("history.limit")}</p><div class="timeline">{#each remoteHistory.deployments as item}<article class="timeline-entry"><span class="timeline-dot remote-dot"></span><div class="timeline-content"><div class="timeline-top"><strong>{say("Deployment", "Deployment")} · {String(item.id ?? "")}</strong><time>{formatDate(String(item.created_on ?? item.created_at ?? ""))}</time></div><p>{say("Versione", "Version")} {String(item.version_id ?? "—")}</p><button class="button text small" onclick={() => onRollback(item)}>{t("history.rollback")} →</button></div></article>{/each}{#each remoteHistory.versions as item}<article class="timeline-entry"><span class="timeline-dot remote-dot"></span><div class="timeline-content"><div class="timeline-top"><strong>{say("Versione", "Version")} · {String(item.id ?? "")}</strong><time>{formatDate(String(item.created_on ?? ""))}</time></div><button class="button text small" onclick={() => onRollback(item)}>{t("history.rollback")} →</button></div></article>{/each}{#if !remoteHistory.deployments.length && !remoteHistory.versions.length}<p class="empty-note">{t("history.noRemote")}</p>{/if}</div>{:else}<div class="remote-empty"><span>◈</span><p>{say("Carica lo storico Cloudflare solo quando vuoi consultarlo.", "Load Cloudflare history only when you want to review it.")}</p><button class="button outline" onclick={() => void act(refreshRemoteHistory)}>{t("history.refresh")} →</button></div>{/if}</section></div>
</section>
