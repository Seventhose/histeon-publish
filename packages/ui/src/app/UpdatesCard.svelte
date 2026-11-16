<script lang="ts">
  import type { Language } from "../lib/i18n.js";

  /** Settings → Data → Updates: the desktop app's own updates from the public releases, without a token (desktop app-updates.ts). */
  let { language }: { language: Language } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;

  interface UpdateState {
    current: string;
    canInstall: boolean;
    available: { version: string; page: string } | null;
    checkedAt: string | null;
    error: string | null;
    installed: string | null;
    busy: boolean;
  }

  const bridge = window.histosDesktop?.updates;
  let update = $state<UpdateState | null>(null);
  let working = $state(false);
  /** A call the bridge refused (IPC error): update.error only carries what the check itself found. */
  let failure = $state("");

  const read = (value: unknown) => { if (value && typeof value === "object") update = value as UpdateState; failure = ""; };
  const fail = (error: unknown) => { failure = error instanceof Error ? error.message : String(error); };
  async function run(task: () => Promise<unknown>) {
    if (working) return;
    working = true;
    try { read(await task()); } catch (error) { fail(error); } finally { working = false; }
  }
  $effect(() => { if (bridge) void bridge.status().then(read, fail); });
  const checked = (value: string | null) => value ? new Date(value).toLocaleString(language === "it" ? "it-IT" : "en-GB", { dateStyle: "short", timeStyle: "short" }) : "—";
</script>

{#if bridge}
  <section class="panel-card settings-data" data-testid="settings-updates">
    <div class="section-card-header"><div><div class="eyebrow">{say("AGGIORNAMENTI", "UPDATES")}</div><h2>{say("Aggiornamenti dell’app", "App updates")}</h2></div><span class="storage-icon" aria-hidden="true">↻</span></div>
    {#if failure}<p class="field-hint update-error" role="alert">{failure}</p>{/if}
    {#if update}
      <div class="credential-status"><span class="status-light on"></span><span>{say("Dalle release pubbliche su GitHub", "From the public GitHub releases")}</span></div>
      <p class="muted">{say(`Versione installata: ${update.current}. Ultimo controllo: ${checked(update.checkedAt)}.`, `Installed version: ${update.current}. Last check: ${checked(update.checkedAt)}.`)}</p>
      {#if update.installed}
        <p>{say(`La versione ${update.installed} è installata e verificata. Riavvia per usarla.`, `Version ${update.installed} is installed and verified. Restart to use it.`)}</p>
        <div class="form-actions"><button class="button primary" onclick={() => void bridge.restart()}>{say("Riavvia ora", "Restart now")} →</button></div>
      {:else if update.available}
        <p>{say(`È disponibile la versione ${update.available.version}.`, `Version ${update.available.version} is available.`)}</p>
        {#if update.canInstall}
          <div class="form-actions"><button class="button primary" disabled={working || update.busy} onclick={() => void run(bridge.install)}>{working ? say("Scarico e verifico…", "Downloading and verifying…") : say("Installa", "Install")} →</button></div>
          <p class="field-hint">{say("Il file viene installato solo se è firmato con la chiave di rilascio.", "The file is installed only if it is signed with the release key.")}</p>
        {:else}
          <p class="field-hint">{say("Questa installazione non è un’AppImage: scarica la nuova versione dalla release su GitHub.", "This install is not an AppImage: download the new version from the GitHub release.")}</p>
        {/if}
      {:else if update.checkedAt && !update.error}
        <p class="muted">{say("Nessuna versione più nuova.", "No newer version.")}</p>
      {/if}
      {#if update.error}<p class="field-hint update-error" role="alert">{update.error}</p>{/if}
      <p class="field-hint">{say("L’app chiede a GitHub all’avvio e ogni 12 ore se c’è una versione nuova, senza token e senza inviare nient’altro.", "The app asks GitHub at start and every 12 hours for a new version, without a token and without sending anything else.")}</p>
      <div class="form-actions">
        <button class="button outline" disabled={working || update.busy} onclick={() => void run(bridge.check)}>{say("Controlla ora", "Check now")}</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .update-error { color: var(--danger); }
</style>
