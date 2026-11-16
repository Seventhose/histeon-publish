<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsRemoteConnection, CmsRemoteOperation } from "../lib/app-types.js";

  /** Restoring what a send to WordPress replaced. */
  let { language, act, busy, cmsRemoteRollback, confirmCmsRemoteRollback, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cmsRemoteRollback: { connection: CmsRemoteConnection; operation: CmsRemoteOperation; resumePartial: boolean };
    confirmCmsRemoteRollback: () => Promise<void>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="cms-remote-rollback-title" tabindex="-1">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <div class="modal-icon warning-icon">↶</div><div class="eyebrow">HISTOS WORDPRESS · REMOTE</div>
    <h2 id="cms-remote-rollback-title">{cmsRemoteRollback.resumePartial ? say("Verificare e riprendere il ripristino?", "Verify and resume the restore?") : say("Ripristinare la copia precedente?", "Restore the previous copy?")}</h2>
    <p>{cmsRemoteRollback.resumePartial
      ? say(`WordPress ha registrato un ripristino interrotto. Riprovo solo se ogni revisione è ancora quella dell’invio o quella del ripristino previsto su ${new URL(cmsRemoteRollback.connection.url).hostname}; le modifiche estranee bloccano l’operazione.`, `WordPress recorded an interrupted restore. I’ll retry only if every revision still matches either the original send or its intended restore on ${new URL(cmsRemoteRollback.connection.url).hostname}; unrelated changes block it.`)
      : say(`Ripristinerò i contenuti Histeon salvati prima di questo invio su ${new URL(cmsRemoteRollback.connection.url).hostname}. Procedo solo se WordPress non è cambiato dopo l’invio.`, `I’ll restore the Histeon content saved before this send on ${new URL(cmsRemoteRollback.connection.url).hostname}. I’ll proceed only if WordPress has not changed since then.`)}</p>
    <div class="modal-warning"><span>!</span>{say("Plugin e hook WordPress possono eseguire di nuovo le proprie azioni durante il ripristino. Le email inviate o le chiamate API già eseguite non si possono annullare.", "WordPress plugins and hooks may run again during restoration. Emails already sent and API calls already made cannot be undone.")}</div>
    <div class="modal-actions"><button class="button outline" disabled={busy} onclick={() => onclose()}>{t("common.cancel")}</button><button class="button dark" disabled={busy} onclick={() => void act(confirmCmsRemoteRollback)}>{cmsRemoteRollback.resumePartial ? say("Verifica e riprendi", "Verify and resume") : say("Conferma ripristino", "Confirm restore")} →</button></div>
  </div>
</div>
