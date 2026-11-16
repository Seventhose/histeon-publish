<script lang="ts">
  import { type Language } from "../lib/i18n.js";
  import type { Site } from "../lib/app-types.js";

  /** Fluent Forms through WordPress, for a site's Worker. */
  let { language, act, formsIds = $bindable(), formsRestUrl = $bindable(), removeTurnstileSecret, selectedSite, turnstileSecret = $bindable(), turnstileSiteKey = $bindable() }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    formsIds: string;
    formsRestUrl: string;
    removeTurnstileSecret: () => Promise<void>;
    selectedSite: Site;
    turnstileSecret: string;
    turnstileSiteKey: string;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<div class="forms-settings">
  <div class="eyebrow">{say("MODULI", "FORMS")}</div>
  <h3>{say("Fluent Forms via WordPress", "Fluent Forms through WordPress")}</h3>
  <p class="field-hint">{say("Gli invii passano dal servizio pubblico di Fluent Forms su WordPress, senza credenziali WordPress. WordPress invia l’email e Fluent SMTP la consegna tramite il provider che configuri lì.", "Submissions use Fluent Forms’ public WordPress endpoint, without WordPress credentials. WordPress sends the email and Fluent SMTP delivers it through the provider you configure there.")}</p>
  <p class="field-hint forms-attribution">{say("Attribuzione: FluentSMTP è sviluppato da WPManageNinja LLC e dai contributori del progetto, con licenza GPL-2.0-or-later. È un software separato: Histeon Publish non lo include e non è affiliato ai suoi autori. Consulta il", "Attribution: FluentSMTP is developed by WPManageNinja LLC and its contributors under GPL-2.0-or-later. It is separate software: Histeon Publish does not bundle it and is not affiliated with its authors. See the")} <a href="https://github.com/WPManageNinja/fluent-smtp" target="_blank" rel="noreferrer">{say("progetto ufficiale FluentSMTP", "official FluentSMTP project")}</a>.</p>
  <div class="settings-grid">
    <div class="wide-field"><label class="field-label" for="forms-rest-url">{say("Indirizzo REST di WordPress", "WordPress REST URL")}</label><input id="forms-rest-url" type="url" bind:value={formsRestUrl} placeholder="https://sito.example/wp-json/" /></div>
    <div><label class="field-label" for="forms-ids">{say("ID dei moduli Fluent Forms", "Fluent Forms IDs")}</label><input id="forms-ids" bind:value={formsIds} placeholder="123, 456" /></div>
    <div><label class="field-label" for="turnstile-site-key">{say("Chiave pubblica Turnstile", "Turnstile site key")}</label><input id="turnstile-site-key" bind:value={turnstileSiteKey} autocomplete="off" /></div>
    <div class="wide-field"><label class="field-label" for="turnstile-secret">{say("Chiave segreta Turnstile", "Turnstile secret key")}</label><input id="turnstile-secret" type="password" bind:value={turnstileSecret} autocomplete="new-password" placeholder={selectedSite.turnstileSecretConfigured ? say("Già salvata; lascia vuoto per mantenerla", "Saved; leave empty to keep it") : say("Salvata nel portachiavi locale", "Stored in the local keyring")} /></div>
  </div>
  <div class="wp-actions"><span class="muted">{selectedSite.turnstileSecretConfigured ? say("Chiave segreta presente nel portachiavi locale", "Secret is in the local keyring") : say("Chiave segreta non ancora configurata", "Secret key not configured")}</span><div><button class="button text small" onclick={() => void act(removeTurnstileSecret)} disabled={!selectedSite.turnstileSecretConfigured}>{say("Rimuovi chiave", "Remove key")}</button></div></div>
  <p class="field-hint">{say("La chiave segreta serve solo per il deploy e resta cifrata nel portachiavi. I moduli con allegati, CAPTCHA integrato o pagamenti restano inattivi. I dati vengono inviati al sito WordPress e non passano dai server di Histeon Publish.", "The secret is needed only for deployment and stays encrypted in the keyring. Forms with uploads, built-in CAPTCHA, or payments stay inactive. Submissions go to WordPress and do not pass through Histeon Publish servers.")}</p>
</div>
