<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { Screen } from "../lib/app-types.js";

  /** Where prototypes, .xbsite and .histosproject files arrive: dropped, or chosen. */
  let { language, busy, cmsArchiveDropActive, cmsImportInput = $bindable(), cmsImportOpener = $bindable(), handleCmsArchiveDragLeave, handleCmsArchiveDragOver, handleCmsArchiveDrop, importCmsArchiveInput, nav }: {
    language: Language;
    busy: boolean;
    cmsArchiveDropActive: boolean;
    cmsImportInput: HTMLInputElement | null;
    cmsImportOpener: HTMLElement | null;
    handleCmsArchiveDragLeave: (event: DragEvent) => void;
    handleCmsArchiveDragOver: (event: DragEvent) => void;
    handleCmsArchiveDrop: (event: DragEvent) => void;
    importCmsArchiveInput: (event: Event) => void;
    nav: (target: Screen) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<div class="cms-import-drop-zone" class:active={cmsArchiveDropActive} role="region" aria-label={t("cms.importZone")} data-testid="cms-import-zone" ondragover={handleCmsArchiveDragOver} ondragleave={handleCmsArchiveDragLeave} ondrop={handleCmsArchiveDrop}>
  <span class="cms-import-drop-icon" aria-hidden="true">⇩</span>
  <div><strong>{t("cms.importZoneTitle")}</strong><small>{t("cms.importZoneHint")}</small></div>
  <div class="cms-import-zone-actions">
    <button class="button primary cms-import-button" type="button" onclick={(event) => { cmsImportOpener = event.currentTarget; cmsImportInput?.click(); }} disabled={busy}>{t("cms.importChoose")}</button><input bind:this={cmsImportInput} class="visually-hidden" tabindex="-1" aria-hidden="true" data-testid="cms-import-input" type="file" accept=".html,.htm,text/html,.xbsite,.histosproject,application/zip" onchange={importCmsArchiveInput} disabled={busy} />
    <button class="button text small cms-agent-link" type="button" data-testid="cms-import-agent" onclick={() => nav("agent")}>{t("agent.catalogLink")}</button>
  </div>
</div>
