<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { Site } from "../lib/app-types.js";

  /** Bringing a Worker back to an earlier version. */
  let { language, act, busy, confirmRollback, selectedSite, rollback, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    confirmRollback: () => Promise<void>;
    selectedSite: Site;
    rollback: Record<string, unknown>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<div class="modal-backdrop" role="presentation"><div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="rollback-title" tabindex="-1"><button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button><div class="modal-icon warning-icon">↶</div><div class="eyebrow">CLOUDFLARE</div><h2 id="rollback-title">{t("history.confirm")}</h2><p>{t("history.rollbackText", { worker: selectedSite.worker ?? "—", version: String(rollback.version_id ?? rollback.id ?? "—") })}</p><div class="modal-warning"><span>!</span>{t("history.rollbackWarning")}</div><div class="modal-actions"><button class="button outline" onclick={() => onclose()}>{t("common.cancel")}</button><button class="button dark" disabled={busy} onclick={() => void act(confirmRollback)}>{t("history.confirm")} →</button></div></div></div>
