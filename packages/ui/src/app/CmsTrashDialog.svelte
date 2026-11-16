<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { plural, translate, type Language } from "../lib/i18n.js";
  import type { CmsRemoteConnection } from "../lib/app-types.js";

  /** The selection of a project going to its trash, here or on a linked site too. */
  let { language, act, busy, cmsTrashConnectionId = $bindable(), cmsTrashConnections, cmsTrashSelection, trashCmsSelection, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cmsTrashConnectionId: string;
    cmsTrashConnections: CmsRemoteConnection[];
    cmsTrashSelection: string[];
    trashCmsSelection: () => Promise<void>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const n = (key: string, count: number, values: Record<string, string | number> = {}) => plural(language, key, count, values);
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="cms-trash-title" tabindex="-1">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <div class="modal-icon warning-icon">↶</div>
    <div class="eyebrow">HISTOS CMS</div>
    <h2 id="cms-trash-title">{t("cms.trashConfirmTitle")}</h2>
    <p>{n("cms.trashConfirmBody", cmsTrashSelection.length)}</p>
    {#if cmsTrashConnections.length}
      <label class="field-label">{t("cms.trashDestination")}
        <select bind:value={cmsTrashConnectionId}>
          <option value="">{t("cms.trashLocalOnly")}</option>
          {#each cmsTrashConnections as connection (connection.id)}<option value={connection.id}>{connection.projectName || new URL(connection.url).hostname} · {new URL(connection.url).hostname}</option>{/each}
        </select>
      </label>
    {/if}
    <div class="modal-warning"><span>i</span>{t(cmsTrashConnectionId ? "cms.trashRemoteConfirmNote" : "cms.trashLocalConfirmNote")}</div>
    <div class="modal-actions"><button class="button outline" disabled={busy} onclick={() => onclose()}>{t("common.cancel")}</button><button class="button dark" disabled={busy || cmsTrashSelection.length === 0} onclick={() => void act(trashCmsSelection)}>{busy ? t("common.loading") : t("cms.trashPrepare")} →</button></div>
  </div>
</div>
