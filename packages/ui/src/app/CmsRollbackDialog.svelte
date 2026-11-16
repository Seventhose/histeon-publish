<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";

  /** Bringing a destination back to an earlier publication. */
  let { language, act, busy, cmsRollback, confirmCmsRollback, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cmsRollback: { projectId: string; buildId: string; deploymentId: string; destinationId: string; destinationName: string; provider: "cloudflare" | "hosting"; worker: string; versionId: string };
    confirmCmsRollback: () => Promise<void>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="cms-rollback-title" tabindex="-1">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <div class="modal-icon warning-icon">↶</div><div class="eyebrow">{cmsRollback.provider === "hosting" ? "FTP / FTPS / SFTP · HISTOS CMS" : "CLOUDFLARE · HISTOS CMS"}</div>
    <h2 id="cms-rollback-title">{say("Conferma il ripristino", "Confirm rollback")}</h2>
    {#if cmsRollback.provider === "hosting"}<p>{say(`Su ${cmsRollback.destinationName} ripristinerò i file che questa pubblicazione ha sostituito e rimuoverò quelli creati dalla stessa pubblicazione.`, `On ${cmsRollback.destinationName}, I’ll restore files replaced by this publish and remove files it created.`)}</p>
    {:else}<p>{say(`Il traffico del Worker ${cmsRollback.worker} passerà alla versione ${cmsRollback.versionId}.`, `Traffic for Worker ${cmsRollback.worker} will move to version ${cmsRollback.versionId}.`)}</p>{/if}
    <p>{cmsRollback.destinationName}</p>
    <div class="modal-warning"><span>!</span>{cmsRollback.provider === "hosting"
      ? say("Prima controllerò gli hash dei file remoti. Se rilevo modifiche successive alla pubblicazione, mi fermerò senza sovrascriverle. Hosting generici non garantiscono un cambio atomico: se il collegamento si interrompe, controlla il sito e la cronologia.", "I’ll check remote file hashes first. If I find edits made after this publish, I’ll stop without overwriting them. Generic hosting does not guarantee an atomic switch; if the connection drops, check the site and its history.")
      : say("Il cambiamento diventerà visibile sul sito dopo la conferma. Histeon registrerà il risultato nella cronologia del progetto.", "The change will become visible on the site after confirmation. Histeon will record the result in the project history.")}</div>
    <div class="modal-actions"><button class="button outline" disabled={busy} onclick={() => onclose()}>{t("common.cancel")}</button><button class="button dark" disabled={busy} onclick={() => void act(confirmCmsRollback)}>{say("Conferma ripristino", "Confirm rollback")} →</button></div>
  </div>
</div>
