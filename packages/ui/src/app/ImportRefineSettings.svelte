<script lang="ts">
  import { api } from "../lib/api.js";
  import type { Language } from "../lib/i18n.js";
  import type { ImportRefineSettingsView } from "../lib/app-types.js";

  /**
   * Doc 27, G3: which model refines the names of an HTML import, for the whole app. The checkbox that uses it is in the
   * import's check dialog («un posto per sito»); here only the provider and its keys, which go to the system keyring.
   */
  let { language, act, busy }: { language: Language; act: (task: () => Promise<void>) => Promise<void>; busy: boolean } = $props();
  const say = (italian: string, english: string) => (language === "it" ? italian : english);

  let view = $state<ImportRefineSettingsView | null>(null);
  let provider = $state<"connettore" | "locale" | "haiku">("connettore");
  let localUrl = $state("");
  let localModel = $state("");
  let localKey = $state("");
  let haikuKey = $state("");
  let saved = $state("");

  function show(next: ImportRefineSettingsView): void {
    view = next;
    provider = next.provider;
    localUrl = next.localUrl;
    localModel = next.localModel;
    localKey = "";
    haikuKey = "";
  }
  $effect(() => {
    void api<ImportRefineSettingsView>("/api/import-refine").then(show).catch(() => undefined);
  });

  async function save(change: Record<string, unknown> = {}): Promise<void> {
    saved = "";
    const body: Record<string, unknown> = { provider, localUrl: localUrl.trim(), localModel: localModel.trim(), ...change };
    if (localKey.trim() && !("localKey" in change)) body.localKey = localKey.trim();
    if (haikuKey.trim() && !("haikuKey" in change)) body.haikuKey = haikuKey.trim();
    show(await api<ImportRefineSettingsView>("/api/import-refine", { method: "PUT", body: JSON.stringify(body) }));
    saved = say("Impostazioni della rifinitura salvate.", "Refinement settings saved.");
  }
</script>

<section class="panel-card import-refine-settings" data-testid="import-refine-settings" aria-labelledby="import-refine-title">
  <div class="eyebrow">{say("IMPORTAZIONE HTML", "HTML IMPORT")}</div>
  <h2 id="import-refine-title">{say("Rifinitura dei nomi con un modello", "Refining names with a model")}</h2>
  <p class="field-hint">{say("Quando converti un sito HTML, il convertitore dà nomi prudenti ma generici a classi, componenti, campi e tipi. Un modello può proporne di più chiari: tu li vedi in una tabella e applichi quelli che vuoi. Qui scegli il modello, per tutta l’app; la casella per usarlo è nella finestra di controllo dell’importazione.", "When you convert an HTML site, the converter gives prudent but generic names to classes, components, fields and types. A model can propose clearer ones: you see them in a table and apply the ones you want. Choose the model here, for the whole app; the checkbox that uses it is in the import check dialog.")}</p>
  {#if view}
    <fieldset class="import-refine-provider">
      <legend class="field-label">{say("Fornitore", "Provider")}</legend>
      <label><input type="radio" name="import-refine-provider" value="connettore" bind:group={provider} disabled={busy} /> {say("Claude dal connettore (consigliato): il Claude del tuo abbonamento, in Claude Code o Claude Desktop con il connettore acceso; nessuna chiave", "Claude through the connector (recommended): the Claude of your plan, in Claude Code or Claude Desktop with the connector on; no key")}</label>
      <label><input type="radio" name="import-refine-provider" value="locale" bind:group={provider} disabled={busy} /> {say("Modello locale: un server come llama-server, gratuito, il sito non esce dal computer; nella prova i modelli locali hanno dato nomi poco utili", "Local model: a server such as llama-server, free, the site never leaves this computer; in the test local models gave names of little use")}</label>
      <label><input type="radio" name="import-refine-provider" value="haiku" bind:group={provider} disabled={busy} /> {say("Claude Haiku 5.5, con la tua chiave API di Anthropic: costa crediti e i testi brevi del sito vanno ad Anthropic", "Claude Haiku 5.5, with your Anthropic API key: it costs credits and short texts of the site go to Anthropic")}</label>
    </fieldset>
    {#if provider === "connettore"}
      <p class="field-hint" data-testid="import-refine-connector-hint">{view.connectorEnabled ? say("Il connettore è acceso. Quando importi un sito con «Rifinisci i nomi», scrivi a Claude: «Rispondi alle scelte dei nomi di Histeon Publish». Claude legge le scelte con hp_import_choices e risponde; tu applichi i nomi che vuoi.", "The connector is on. When you import a site with «Refine the names», write to Claude: «Answer the Histeon Publish name choices». Claude reads them with hp_import_choices and answers; you apply the names you want.") : say("Il connettore è spento: accendilo qui sopra, poi collega Claude Code o Claude Desktop come dice il riquadro del connettore.", "The connector is off: turn it on above, then connect Claude Code or Claude Desktop as the connector panel says.")}</p>
    {:else if provider === "locale"}
      <div class="settings-grid">
        <div class="wide-field"><label class="field-label" for="import-refine-url">{say("Indirizzo del server", "Server address")}</label><input id="import-refine-url" type="url" bind:value={localUrl} maxlength="200" placeholder="http://127.0.0.1:18080" autocomplete="off" /><p class="field-hint">{say("Un server compatibile con le API di OpenAI: llama-server, LM Studio, Ollama.", "A server compatible with the OpenAI API: llama-server, LM Studio, Ollama.")}</p></div>
        <div><label class="field-label" for="import-refine-model">{say("Nome del modello", "Model name")}</label><input id="import-refine-model" bind:value={localModel} maxlength="80" autocomplete="off" /></div>
        <div><label class="field-label" for="import-refine-local-key">{say("Chiave del server (facoltativa)", "Server key (optional)")}</label><input id="import-refine-local-key" type="password" bind:value={localKey} autocomplete="new-password" placeholder={view.localKeyConfigured ? say("Già salvata; lascia vuoto per tenerla", "Saved; leave empty to keep it") : say("Quella di --api-key, se c’è", "The one of --api-key, if any")} /></div>
      </div>
      <div class="wp-actions"><span class="muted">{view.localKeyConfigured ? say("Chiave del server nel portachiavi", "Server key in the keyring") : say("Nessuna chiave del server", "No server key")}</span><div><button class="button text small" type="button" disabled={busy || !view.localKeyConfigured} onclick={() => void act(() => save({ localKey: null }))}>{say("Rimuovi chiave", "Remove key")}</button></div></div>
    {:else}
      <div class="settings-grid">
        <div class="wide-field"><label class="field-label" for="import-refine-haiku-key">{say("Chiave API di Anthropic", "Anthropic API key")}</label><input id="import-refine-haiku-key" type="password" bind:value={haikuKey} autocomplete="new-password" placeholder={view.haikuKeyConfigured ? say("Già salvata; lascia vuoto per tenerla", "Saved; leave empty to keep it") : "sk-ant-…"} /></div>
      </div>
      <div class="wp-actions"><span class="muted">{view.haikuKeyConfigured ? say("Chiave di Anthropic nel portachiavi", "Anthropic key in the keyring") : say("Nessuna chiave di Anthropic: senza, la rifinitura non parte", "No Anthropic key: without it the refinement does not start")}</span><div><button class="button text small" type="button" disabled={busy || !view.haikuKeyConfigured} onclick={() => void act(() => save({ haikuKey: null }))}>{say("Rimuovi chiave", "Remove key")}</button></div></div>
    {/if}
    {#if !view.keyringAvailable}<p class="modal-warning" role="note"><span>!</span>{say("Il portachiavi di sistema non risponde: le chiavi non si possono salvare né leggere.", "The system keyring does not answer: keys cannot be saved or read.")}</p>{/if}
    <div class="form-actions"><button class="button dark" type="button" data-testid="import-refine-save" disabled={busy} onclick={() => void act(() => save())}>{say("Salva", "Save")} →</button></div>
    {#if saved}<p class="field-hint" role="status">{saved}</p>{/if}
  {/if}
</section>
