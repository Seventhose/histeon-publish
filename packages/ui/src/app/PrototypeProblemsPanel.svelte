<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { PrototypeIssueView, PrototypeProblemsView } from "../lib/app-types.js";

  /** A refused prototype with all its problems (E4). */
  let { language, act, busy, cmsPrototypeProblemsPanel = $bindable(), copyPrototypeProblems, prototypeIssuePlace, recheckPrototype, problems, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cmsPrototypeProblemsPanel: HTMLElement | null;
    copyPrototypeProblems: (problems: PrototypeProblemsView) => Promise<void>;
    prototypeIssuePlace: (issue: PrototypeIssueView) => string;
    recheckPrototype: (file: File) => Promise<void>;
    problems: PrototypeProblemsView;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const recheck = $derived(problems.rereadable);
</script>

<section class="panel-card cms-prototype-problems" tabindex="-1" bind:this={cmsPrototypeProblemsPanel} aria-labelledby="cms-prototype-problems-title" data-testid="cms-prototype-problems">
  <h3 id="cms-prototype-problems-title">{problems.total === 1 ? t("cms.problemsTitleOne", { file: problems.file.name }) : t("cms.problemsTitle", { file: problems.file.name, n: problems.total })}</h3>
  <p>{t(problems.downloadUrl ? "cms.problemsHintGenerated" : recheck ? "cms.problemsHintDesktop" : "cms.problemsHint")}</p>
  <ol>
    {#each problems.issues as issue, index (index)}
      {@const place = prototypeIssuePlace(issue)}
      <li>{#if place}<strong>{place}</strong>{" "}{/if}<span>{issue.message}</span></li>
    {/each}
  </ol>
  {#if problems.total > problems.issues.length}<p class="cms-prototype-problems-more" data-testid="cms-prototype-problems-more">{t("cms.problemsMore", { n: problems.total - problems.issues.length })}</p>{/if}
  <div class="cms-prototype-problems-actions">
    <button class="button primary small" type="button" data-testid="cms-prototype-problems-copy" onclick={() => void copyPrototypeProblems(problems)}>{t("cms.problemsCopy")}</button>
    {#if problems.downloadUrl}<a class="button outline small" href={problems.downloadUrl} download={problems.file.name} data-testid="cms-prototype-problems-download">{t("cms.conversionDownload")}</a>{/if}
    {#if recheck}<button class="button outline small" type="button" data-testid="cms-prototype-problems-recheck" disabled={busy} onclick={() => void act(() => recheckPrototype(problems.file))}>{t("cms.problemsRecheck")}</button>{/if}
    <button class="button text small" type="button" data-testid="cms-prototype-problems-close" onclick={() => { onclose(); }}>{t("common.close")}</button>
  </div>
</section>
