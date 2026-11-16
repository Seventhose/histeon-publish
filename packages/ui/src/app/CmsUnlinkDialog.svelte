<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsRemoteConnection } from "../lib/app-types.js";

  /** Disconnecting a Histeon site from this computer, and on WordPress. */
  let { language, act, busy, cmsUnlink, tryCmsUnlink, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cmsUnlink: { connection: CmsRemoteConnection; remoteRevocationFailed: boolean };
    tryCmsUnlink: (localOnly?: boolean) => Promise<void>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="cms-unlink-title" tabindex="-1">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => { if (!busy) onclose(); }}>×</button>
    <div class="modal-icon warning-icon">↗</div>
    <div class="eyebrow">HISTOS CMS</div>
    <h2 id="cms-unlink-title">{say("Scollega il sito Histeon", "Disconnect the Histeon site")}</h2>
    <p>{say(`Rimuoverò il collegamento a ${new URL(cmsUnlink.connection.url).hostname} da questo computer. Il progetto locale e il sito WordPress resteranno intatti.`, `I will remove the connection to ${new URL(cmsUnlink.connection.url).hostname} from this computer. The local project and WordPress site will remain intact.`)}</p>
    <div class="modal-warning"><span>!</span>{say("Prima provo a revocare il pairing anche su WordPress, così questo computer non potrà più accedere al sito.", "I will first try to revoke the pairing on WordPress so this computer can no longer access the site.")}</div>
    {#if cmsUnlink.remoteRevocationFailed}
      <div class="modal-warning"><span>!</span>{say("WordPress non ha confermato la revoca. Puoi riprovare oppure scollegare solo da questo computer: in quel caso il pairing potrebbe restare valido su WordPress.", "WordPress did not confirm revocation. Retry, or disconnect only from this computer; the pairing may then remain valid on WordPress.")}</div>
    {/if}
    <div class="modal-actions">
      <button class="button outline" disabled={busy} onclick={() => { if (!busy) onclose(); }}>{t("common.cancel")}</button>
      {#if cmsUnlink.remoteRevocationFailed}<button class="button outline" disabled={busy} onclick={() => void act(() => tryCmsUnlink(true))}>{say("Scollega solo qui", "Disconnect only here")}</button>{/if}
      <button class="button dark" disabled={busy} onclick={() => void act(() => tryCmsUnlink(false))}>{busy ? t("common.loading") : cmsUnlink.remoteRevocationFailed ? say("Riprova la revoca", "Retry revocation") : say("Revoca e scollega", "Revoke and disconnect")} →</button>
    </div>
  </div>
</div>
