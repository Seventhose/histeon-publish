<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { DomainPlan, Site } from "../lib/app-types.js";

  /** What connecting the domain would do, before it does. */
  let { language, act, attachDomain, busy, domainPlan, selectedSite, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    attachDomain: () => Promise<void>;
    busy: boolean;
    domainPlan: DomainPlan;
    selectedSite: Site;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal-card domain-modal" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy }} aria-labelledby="domain-title" tabindex="-1"><button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button><div class="modal-icon">◎</div><div class="eyebrow">{say("DOMINIO PERSONALIZZATO", "CUSTOM DOMAIN")}</div><h2 id="domain-title">{say("Collega il dominio", "Connect the domain")}</h2><p>{say("Histeon ha controllato la zona Cloudflare", "Histeon checked the Cloudflare zone")} <strong>{domainPlan.zone.name}</strong>. {say("Collegherà questo Worker:", "It will connect this Worker:")} <strong>{selectedSite.worker ?? "—"}</strong>.</p><div class="domain-hostnames"><strong>{say("Indirizzi che verranno collegati", "Hostnames to connect")}</strong>{#each domainPlan.hostnames as hostname}<span>{hostname}</span>{/each}</div>
    {#if domainPlan.workerConflicts.length > 0}<div class="modal-warning"><span>!</span><div>{say("Non posso procedere: questi nomi sono già collegati a un altro Worker.", "I cannot continue: these names are already connected to another Worker.")}<ul>{#each domainPlan.workerConflicts as conflict}<li><strong>{conflict.hostname}</strong> → Worker {conflict.service}</li>{/each}</ul></div></div>
    {:else if domainPlan.cnameConflicts.length > 0}<div class="modal-warning"><span>!</span><div><strong>{say("Ho trovato voci CNAME da sostituire", "I found CNAME records to replace")}</strong><ul>{#each domainPlan.cnameConflicts as record}<li><strong>{record.name}</strong> → {record.content} ({record.proxied ? say("proxy Cloudflare attivo", "Cloudflare proxy on") : say("solo DNS", "DNS only")})</li>{/each}</ul><p>{say("Se confermi, Histeon rimuove solo queste voci e le sostituisce con quelle del Worker. Se il nome serviva un altro sito, quel traffico passerà al Worker.", "If you confirm, Histeon removes only these records and replaces them with the Worker records. If the hostname served another site, its traffic will move to the Worker.")}</p></div></div>
    {:else}<p class="domain-clear">{say("Non ho trovato CNAME in conflitto. Cloudflare creerà le voci DNS e il certificato HTTPS.", "No conflicting CNAME was found. Cloudflare will create DNS records and the HTTPS certificate.")}</p>{/if}
    <p class="modal-note">{say("Le voci email (MX e TXT) e gli altri hostname non vengono modificati.", "Email records (MX and TXT) and other hostnames will not be changed.")}</p><div class="modal-actions"><button class="button outline" onclick={() => onclose()}>{t("common.cancel")}</button><button class="button primary" disabled={busy || !selectedSite.worker || domainPlan.workerConflicts.length > 0} onclick={() => void act(attachDomain)}>{domainPlan.cnameConflicts.length > 0 ? say("Sostituisci e collega", "Replace and connect") : say("Conferma e collega", "Confirm and connect")} →</button></div></div>
</div>
