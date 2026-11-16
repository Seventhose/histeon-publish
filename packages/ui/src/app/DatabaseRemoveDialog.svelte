<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { DatabaseConnection } from "../lib/app-types.js";

  /** Removing a database connection from this computer. */
  let { language, act, busy, confirmRemoveDatabaseConnection, databaseRemoval, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    confirmRemoveDatabaseConnection: () => Promise<void>;
    databaseRemoval: DatabaseConnection;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal-card database-remove-modal" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="database-remove-title" tabindex="-1">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <div class="modal-icon warning-icon">⌑</div>
    <div class="eyebrow">{t("db.title")}</div>
    <h2 id="database-remove-title">{t("db.removeConfirmTitle")}</h2>
    <p>{t("db.removeConfirmBody", { name: databaseRemoval.name })}</p>
    <div class="modal-warning"><span>!</span>{say("La password e l’eventuale CA verranno eliminate dal portachiavi locale. Nessuna tabella remota sarà modificata.", "The password and optional CA will be removed from the local keyring. No remote table will be changed.")}</div>
    <div class="modal-actions"><button class="button outline" onclick={() => onclose()}>{t("common.cancel")}</button><button class="button dark" disabled={busy} onclick={() => void act(confirmRemoveDatabaseConnection)}>{t("db.remove")} →</button></div>
  </div>
</div>
