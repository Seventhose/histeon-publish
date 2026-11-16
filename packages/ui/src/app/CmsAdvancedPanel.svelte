<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsProjectDetails } from "../lib/app-types.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";
  import CmsTokenImport from "./CmsTokenImport.svelte";

  /** Copies, transfer and recoverable deletions of the project. */
  let { language, act, backupCmsProject, busy, enableCmsPostTaxonomies, exportCmsProject, exportCmsSectionLibrary, exportForWordPress, restoreCmsDeletion, selectedCmsProject }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    backupCmsProject: () => Promise<void>;
    busy: boolean;
    enableCmsPostTaxonomies: () => Promise<void>;
    exportCmsProject: () => Promise<void>;
    exportCmsSectionLibrary: () => Promise<void>;
    exportForWordPress: () => Promise<void>;
    restoreCmsDeletion: (id: string) => Promise<void>;
    selectedCmsProject: CmsProjectDetails | null;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const formatDate = (value?: string) => formatDateIn(language, value);
</script>

{#if selectedCmsProject}
  <section class="admin-block admin-form-block" data-testid="cms-transfer">
    <div><h2>{say("Copie e trasferimento", "Copies and transfer")}</h2><p class="muted">{say("Un backup riporta tutto il sito, un file .xbsite lo porta in un altro Histeon, la libreria porta le sezioni nel builder.", "A backup restores the whole site, a .xbsite file moves it to another Histeon, the library brings sections to the builder.")}</p></div>
    <div class="admin-actions">
      <button class="button outline small" onclick={() => void act(backupCmsProject)} disabled={busy}>{t("cms.backup")}</button>
      <button class="button outline small" onclick={() => void act(exportCmsProject)} disabled={busy}>{t("cms.export")}</button>
      <button class="button outline small" onclick={() => void act(exportCmsSectionLibrary)} disabled={busy}>{t("cms.sectionLibrary")}</button>
      <button class="button outline small" onclick={() => void act(exportForWordPress)} disabled={busy} data-testid="cms-export-wordpress">{t("cms.exportWordPress")}</button>
      {#if !selectedCmsProject.taxonomies.some((taxonomy) => taxonomy.key === "category") || !selectedCmsProject.taxonomies.some((taxonomy) => taxonomy.key === "post_tag")}<button class="button outline small" onclick={() => void act(enableCmsPostTaxonomies)} disabled={busy}>{t("cms.createPostTaxonomies")}</button>{/if}
    </div>
  </section>
  <CmsTokenImport {language} {act} {busy} projectId={selectedCmsProject.project.id} />
  {#if selectedCmsProject.recoverableDeletions.length}
    <section class="panel-card cms-settings-panel">
      <div class="panel-head"><span class="step-number" aria-hidden="true">↶</span><div><h2>{t("cms.recoverableDeletions")}</h2><p>{t("cms.recoverableDeletionsHint")}</p></div></div>
      <div class="site-grid">
        {#each selectedCmsProject.recoverableDeletions as deletion (deletion.id)}
          <article class="site-card">
            <div class="site-card-top"><span class="site-icon">↶</span><span class="status-chip stale">{t("cms.deleted")}</span></div>
            <strong>{deletion.label}</strong>
            <p class="muted">{t("cms.deletedAt", { date: formatDate(deletion.deletedAt) })}</p>
            <div class="site-card-actions"><button class="button outline small" disabled={busy} onclick={() => void act(() => restoreCmsDeletion(deletion.id))}>{t("cms.restorePage")}</button></div>
          </article>
        {/each}
      </div>
    </section>
  {/if}
{/if}
