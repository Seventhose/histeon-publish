<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { ImportProgressView, SiteConversionView } from "../lib/app-types.js";

  /** Updating a project from its prototype: the update runs under this dialog. */
  let { language, act, busy, cancelCmsImport, cmsImportOpener, cmsImportProgress, importCmsArchive, pendingUpdate, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cancelCmsImport: () => void;
    cmsImportOpener: HTMLElement | null;
    cmsImportProgress: ImportProgressView | null;
    importCmsArchive: (file: File, confirmedUpdate?: boolean, conversion?: SiteConversionView) => Promise<void>;
    pendingUpdate: { file: File; project: { id: string; name: string } };
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy, returnFocus: cmsImportOpener }} aria-labelledby="cms-import-update-title" tabindex="-1" data-testid="cms-import-update">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => { if (!busy) onclose(); }}>×</button>
    <div class="modal-icon warning-icon">↻</div>
    <div class="eyebrow">HISTOS CMS</div>
    <h2 id="cms-import-update-title">{t("cms.importUpdateTitle", { name: pendingUpdate.project.name })}</h2>
    <p>{t("cms.importUpdateBody", { file: pendingUpdate.file.name })}</p>
    <div class="modal-warning"><span>!</span>{t("cms.importUpdateBackup")}</div>
    <!-- The update runs under this dialog: its progress, and «Annulla» to stop it, are here. -->
    {#if busy && cmsImportProgress}<p class="modal-progress" role="status">{cmsImportProgress.phase ? t(`cms.progress.${cmsImportProgress.phase}`, { done: cmsImportProgress.done ?? 0, total: cmsImportProgress.total ?? 0 }) : t("cms.progressImport")}</p>{/if}
    <div class="modal-actions">
      {#if busy && cmsImportProgress && cmsImportProgress.phase !== "writing"}<button class="button outline" onclick={cancelCmsImport}>{t("cms.importCancel")}</button>
      {:else}<button class="button outline" disabled={busy} onclick={() => { if (!busy) onclose(); }}>{t("common.cancel")}</button>{/if}
      <button class="button dark" disabled={busy} onclick={() => void act(() => importCmsArchive(pendingUpdate.file, true))}>{busy ? t("common.loading") : t("cms.importUpdateConfirm")} →</button>
    </div>
  </div>
</div>
