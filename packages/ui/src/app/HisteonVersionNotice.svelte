<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { HisteonSiteNotice } from "../lib/app-types.js";

  /** Doc 23 item 175: the site's Histeon is older than Publish's, and what will not work until it is updated. Never a block. */
  let { language, notice }: { language: Language; notice: HisteonSiteNotice } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<div class="modal-warning histeon-version-notice" role="note" data-testid="histeon-version-notice">
  <span>!</span>
  <div>
    <strong>{notice.site ? t("cms.histeon.older", { site: notice.site, known: notice.known }) : t("cms.histeon.olderUnknown", { known: notice.known })}</strong>
    {#if notice.missing.length}
      <p>{t("cms.histeon.missing")}</p>
      <ul>{#each notice.missing as feature (feature.id)}<li>{t(`cms.histeon.feature.${feature.id}`, { capability: feature.capability ?? "" })} <small>({t("cms.histeon.since", { since: feature.since })})</small></li>{/each}</ul>
    {/if}
    <p>{t("cms.histeon.update")}</p>
  </div>
</div>

<style>
  .histeon-version-notice { margin-top: 8px; }
  .histeon-version-notice p, .histeon-version-notice ul { margin: 4px 0 0; }
  .histeon-version-notice ul { padding-left: 18px; }
</style>
