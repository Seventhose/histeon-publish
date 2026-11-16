<script lang="ts">
  import { plural, stateLabel, translate, type Language } from "../lib/i18n.js";
  import type { JobState } from "../lib/app-types.js";
  import { deployFailure } from "../lib/app-format.js";

  /** The build or publish running on a site, with its log, and how the last one ended. */
  let { language, act, activeJob, cancelJob, progressFilter = $bindable() }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    activeJob: JobState | null;
    cancelJob: () => Promise<void>;
    progressFilter: string;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const n = (key: string, count: number, values: Record<string, string | number> = {}) => plural(language, key, count, values);
  const stateOf = (status: string) => stateLabel(language, status);

  function eventText(event: Record<string, unknown>): string {
    if (event.type === "progress") {
      const phase = event.phase === "pagefind" ? say("Ricerca Pagefind", "Pagefind search") : event.phase === "forms" ? say("Moduli Fluent Forms", "Fluent Forms") : event.phase === "connect" ? say("Connessione FTP/FTPS", "FTP/FTPS connection") : event.phase === "upload" ? say("Caricamento file", "Uploading files") : String(event.phase ?? "");
      return `${phase}: ${String(event.completed ?? 0)}${event.total ? ` / ${String(event.total)}` : ""}`;
    }
    if (event.type === "finding") {
      const finding = event.finding as Record<string, unknown> | undefined;
      return t("build.event.finding", { severity: finding?.severity === "block" ? t("common.block") : t("common.warning"), message: String(finding?.message ?? "") });
    }
    if (event.type === "job-finished") return `${stateOf(String(event.status ?? "complete")).label}${typeof event.error === "string" ? ` — ${event.error}` : ""}`;
    if (event.type === "complete") return `${stateOf("complete").label}: ${n("count.files", Number(event.files ?? 0))}`;
    return String(event.type ?? say("Operazione", "Operation"));
  }

  /** Why the publish failed and where it stopped (voce 228): the message of its last event. */
  const failure = $derived.by(() => {
    const end = activeJob?.events.filter((event) => event.type === "job-finished").at(-1);
    return end ? deployFailure(language, end.error, end.phase) : undefined;
  });
</script>

{#if activeJob && activeJob.status === "running"}
  <section class="panel-card progress-card"><div class="progress-head"><span class="spinner small-spinner"></span><div><div class="eyebrow">{activeJob.type === "build" ? t("progress.title") : say("Pubblicazione in corso", "Publishing")}</div><h2>{activeJob.status === "running" ? t("progress.wait") : t("progress.completed")}</h2></div><button class="button soft small" onclick={() => void act(cancelJob)}>{t("progress.cancel")}</button></div><div class="progress-meta"><span>{activeJob.events.length} {t("progress.logs").toLowerCase()}</span><label>{t("progress.filter")} <select bind:value={progressFilter}><option value="all">{t("progress.all")}</option><option value="warnings">{t("progress.warnings")}</option><option value="blocks">{t("progress.blocks")}</option></select></label></div><ol class="event-list">{#each activeJob.events.filter((event) => progressFilter === "all" || (progressFilter === "warnings" && event.type === "finding" && (event.finding as Record<string, unknown> | undefined)?.severity === "warn") || (progressFilter === "blocks" && event.type === "finding" && (event.finding as Record<string, unknown> | undefined)?.severity === "block")) as event, index}<li><span class="event-index">{String(index + 1).padStart(2, "0")}</span><span>{eventText(event)}</span></li>{/each}</ol></section>
{/if}
{#if activeJob && activeJob.status !== "running"}<div class="inline-status" role="status"><span>{activeJob.status === "complete" ? "✓" : "!"}</span>{activeJob.status === "complete" ? t("progress.completed") : activeJob.status === "cancelled" ? t("progress.cancelled") : t("progress.failed")}{#if activeJob.status === "failed" && failure}<small class="inline-status-detail">{failure}</small>{/if}</div>{/if}
