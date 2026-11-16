<script lang="ts">
  import { type Language } from "../lib/i18n.js";
  import type { DatabaseConnection, HostingDirectoryInspection, Site, WordPressPreflight, WordPressProvisionPlan } from "../lib/app-types.js";
  import { formatBytes as formatBytesIn, formatDate as formatDateIn } from "../lib/app-format.js";

  /** A new WordPress on a site's hosting: read-only checks, then the plan and the install. */
  let { language, act, applyWordPressInstall, busy, databaseConnections, hostingDirectoryInspection, inspectHostingDirectory, prepareWordPressInstall, selectedSite, verifyWordPressPreflight, verifyWordPressRuntime, wordPressDatabaseTlsStatus, wordpressDatabaseConnectionId = $bindable(), wordpressPreflight = $bindable(), wordpressProvisionAdminEmail = $bindable(), wordpressProvisionAdminPassword = $bindable(), wordpressProvisionAdminUsername = $bindable(), wordpressProvisionPlan = $bindable(), wordpressProvisionPlans, wordpressProvisionSiteTitle = $bindable() }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    applyWordPressInstall: (planId: string) => Promise<void>;
    busy: boolean;
    databaseConnections: DatabaseConnection[];
    hostingDirectoryInspection: HostingDirectoryInspection | null;
    inspectHostingDirectory: () => Promise<void>;
    prepareWordPressInstall: () => Promise<void>;
    selectedSite: Site;
    verifyWordPressPreflight: () => Promise<void>;
    verifyWordPressRuntime: () => Promise<void>;
    wordPressDatabaseTlsStatus: (runtime: WordPressPreflight["runtime"]) => string;
    wordpressDatabaseConnectionId: string;
    wordpressPreflight: WordPressPreflight | null;
    wordpressProvisionAdminEmail: string;
    wordpressProvisionAdminPassword: string;
    wordpressProvisionAdminUsername: string;
    wordpressProvisionPlan: WordPressProvisionPlan | null;
    wordpressProvisionPlans: WordPressProvisionPlan[];
    wordpressProvisionSiteTitle: string;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const formatDate = (value?: string) => formatDateIn(language, value);
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);
</script>

{#if selectedSite.hostingCredentialsConfigured && selectedSite.hosting}
  <div class="hosting-directory-tools">
    <button class="button outline small" onclick={() => void act(inspectHostingDirectory)} disabled={busy}>{say("Controlla la cartella in sola lettura", "Inspect the directory (read-only)")}</button>
    <p class="field-hint">{say("Utile prima di preparare un nuovo WordPress. Elenca gli elementi senza creare cartelle, caricare file o cancellare contenuti.", "Useful before preparing a new WordPress install. Lists entries without creating folders, uploading files, or deleting content.")}</p>
  </div>
  <div class="wordpress-preflight-tools">
    <label class="field-label" for="wordpress-database-profile">{say("Database per il nuovo WordPress", "Database for the new WordPress site")}</label>
    <select id="wordpress-database-profile" bind:value={wordpressDatabaseConnectionId} onchange={() => wordpressPreflight = null} disabled={busy || databaseConnections.length === 0}>
      <option value="">{say("Scegli una connessione verificata", "Choose a verified connection")}</option>
      {#each databaseConnections as connection (connection.id)}<option value={connection.id}>{connection.name} · {connection.engine} · {connection.serverVersion}</option>{/each}
    </select>
    {#if !databaseConnections.length}<p class="field-hint">{say("Aggiungi e verifica prima la connessione da Impostazioni → MySQL / MariaDB.", "Add and verify a connection first in Settings → MySQL / MariaDB.")}</p>{/if}
    <button class="button outline small" onclick={() => void act(verifyWordPressPreflight)} disabled={busy || !wordpressDatabaseConnectionId}>{say("Verifica prerequisiti WordPress", "Check WordPress prerequisites")}</button>
    {#if wordpressPreflight?.status === "awaiting-php-check"}
      <p class="field-hint">{say("Carichiamo per pochi secondi un file PHP protetto da un token temporaneo. Le credenziali database viaggiano solo nel corpo di una richiesta HTTPS al tuo hosting: non sono scritte nel file. Il file viene rimosso e la rimozione è verificata; se fallisce, il flusso si ferma.", "We briefly upload a PHP file protected by a temporary token. Database credentials are sent only in the body of an HTTPS request to your hosting; they are not written to the file. We remove the file and verify its removal; if cleanup fails, the flow stops.")}</p>
      <button class="button outline small" onclick={() => void act(verifyWordPressRuntime)} disabled={busy}>{say("Verifica PHP, HTTPS e database", "Check PHP, HTTPS, and database")}</button>
    {/if}
  </div>
{/if}
{#if hostingDirectoryInspection}
  <div class="directory-inspection" class:is-empty={hostingDirectoryInspection.isEmpty} class:is-occupied={!hostingDirectoryInspection.isEmpty} aria-live="polite">
    <strong>{hostingDirectoryInspection.isEmpty ? say("Cartella vuota", "Empty directory") : say("Cartella già occupata", "Directory already contains files")}</strong>
    <span>{say(`${hostingDirectoryInspection.entryCount} elementi rilevati.`, `${hostingDirectoryInspection.entryCount} entries detected.`)}</span>
    {#if hostingDirectoryInspection.wordpressSignals.length}
      <small>{say(`Elementi compatibili con WordPress: ${hostingDirectoryInspection.wordpressSignals.join(", ")}.`, `WordPress-related entries: ${hostingDirectoryInspection.wordpressSignals.join(", ")}.`)}</small>
    {/if}
  </div>
{/if}
{#if wordpressPreflight}
  <div class="wordpress-preflight-result" class:is-blocked={wordpressPreflight.status === "blocked"} class:is-pending={wordpressPreflight.status === "awaiting-php-check"} aria-live="polite">
    <strong>{wordpressPreflight.status === "blocked" ? say("Preflight WordPress bloccato", "WordPress preflight blocked") : wordpressPreflight.status === "ready-for-install" ? say("Prerequisiti superati; installazione non avviata", "Prerequisites passed; installation has not started") : say("Controlli file e database superati", "File and database checks passed")}</strong>
    <span>{say(`Cartella: ${wordpressPreflight.filesystem.entryCount} elementi${wordpressPreflight.filesystem.empty ? ", vuota" : ", già occupata"}.`, `Directory: ${wordpressPreflight.filesystem.entryCount} entries${wordpressPreflight.filesystem.empty ? ", empty" : ", already in use"}.`)}</span>
    <span>{say(`Database: ${wordpressPreflight.database.engine} ${wordpressPreflight.database.serverVersion}, ${wordpressPreflight.database.tableCount} tabelle.`, `Database: ${wordpressPreflight.database.engine} ${wordpressPreflight.database.serverVersion}, ${wordpressPreflight.database.tableCount} tables.`)}</span>
    <span>{wordpressPreflight.database.privilegesVerified ? wordpressPreflight.database.missingPrivileges.length ? say(`Permessi mancanti: ${wordpressPreflight.database.missingPrivileges.join(", ")}.`, `Missing privileges: ${wordpressPreflight.database.missingPrivileges.join(", ")}.`) : say("Permessi database verificati.", "Database privileges verified.") : say("Permessi non verificabili con questo hosting.", "Could not verify permissions with this database host.")}</span>
    {#if wordpressPreflight.filesystem.wordpressSignals.length}<small>{say(`File WordPress rilevati: ${wordpressPreflight.filesystem.wordpressSignals.join(", ")}.`, `WordPress files detected: ${wordpressPreflight.filesystem.wordpressSignals.join(", ")}.`)}</small>{/if}
    <p>{say(`Runtime PHP: ${wordpressPreflight.runtime.phpChecked ? `${wordpressPreflight.runtime.phpVersion}${wordpressPreflight.runtime.phpSupported ? " (compatibile con Histeon)" : " (sotto il minimo richiesto da Histeon)"}${wordpressPreflight.runtime.phpRecommended ? " · raccomandato per produzione" : ` · consigliato ${wordpressPreflight.runtime.recommendedPhp} per produzione`}` : "non ancora verificato"} (WordPress richiede ${wordpressPreflight.runtime.wordpressMinimumPhp}; Histeon richiede ${wordpressPreflight.runtime.requiredPhp}); HTTPS ${wordpressPreflight.runtime.httpsAvailable ? "raggiungibile e verificato" : wordpressPreflight.runtime.httpsConfigured ? "configurato, non ancora verificato" : "da configurare"}. L’installazione non è stata avviata.`, `PHP runtime: ${wordpressPreflight.runtime.phpChecked ? `${wordpressPreflight.runtime.phpVersion}${wordpressPreflight.runtime.phpSupported ? " (compatible with Histeon)" : " (below the Histeon minimum)"}${wordpressPreflight.runtime.phpRecommended ? " · recommended for production" : ` · ${wordpressPreflight.runtime.recommendedPhp} recommended for production`}` : "not checked yet"} (WordPress minimum ${wordpressPreflight.runtime.wordpressMinimumPhp}; Histeon minimum ${wordpressPreflight.runtime.requiredPhp}); HTTPS ${wordpressPreflight.runtime.httpsAvailable ? "reachable and verified" : wordpressPreflight.runtime.httpsConfigured ? "configured, not yet verified" : "must be configured"}. Installation has not started.`)}</p>
    <span>{wordPressDatabaseTlsStatus(wordpressPreflight.runtime)}</span>
    {#if wordpressPreflight.runtime.phpChecked && wordpressPreflight.runtime.missingRequiredExtensions.length}<small>{say(`Estensioni PHP obbligatorie mancanti: ${wordpressPreflight.runtime.missingRequiredExtensions.join(", ")}.`, `Required PHP extensions missing: ${wordpressPreflight.runtime.missingRequiredExtensions.join(", ")}.`)}</small>{/if}
    {#if wordpressPreflight.runtime.phpChecked && wordpressPreflight.runtime.missingRecommendedExtensions.length}<small>{say(`Estensioni PHP raccomandate assenti: ${wordpressPreflight.runtime.missingRecommendedExtensions.join(", ")}. WordPress può funzionare, ma alcune funzioni potrebbero essere limitate.`, `Recommended PHP extensions missing: ${wordpressPreflight.runtime.missingRecommendedExtensions.join(", ")}. Some functionality may be limited.`)}</small>{/if}
  </div>
{/if}
{#if wordpressPreflight?.status === "ready-for-install"}
  <section class="wordpress-provision-form" aria-labelledby="wordpress-provision-title">
    <div class="eyebrow">{say("NUOVO WORDPRESS", "NEW WORDPRESS SITE")}</div>
    <h3 id="wordpress-provision-title">{say("Crea WordPress con Histeon", "Create WordPress with Histeon")}</h3>
    <p class="field-hint">{say("Prima preparo un piano verificabile. Il pulsante finale carica i pacchetti solo nella cartella vuota indicata e installa nel database vuoto scelto. Non vengono cancellati file né svuotato il database.", "First I prepare a reviewable plan. The final button uploads packages only to the empty folder shown and installs into the selected empty database. No files are deleted and no database is cleared.")}</p>
    <div class="settings-grid">
      <div class="wide-field"><label class="field-label" for="wordpress-provision-site-title">{say("Titolo del sito", "Site title")}</label><input id="wordpress-provision-site-title" bind:value={wordpressProvisionSiteTitle} maxlength="120" autocomplete="organization-title" /></div>
      <div><label class="field-label" for="wordpress-provision-admin-user">{say("Utente amministratore", "Administrator username")}</label><input id="wordpress-provision-admin-user" bind:value={wordpressProvisionAdminUsername} maxlength="60" autocomplete="username" /></div>
      <div><label class="field-label" for="wordpress-provision-admin-email">{say("Email amministratore", "Administrator email")}</label><input id="wordpress-provision-admin-email" type="email" bind:value={wordpressProvisionAdminEmail} maxlength="254" autocomplete="email" /></div>
      <div class="wide-field"><label class="field-label" for="wordpress-provision-admin-password">{say("Password amministratore", "Administrator password")}</label><input id="wordpress-provision-admin-password" type="password" bind:value={wordpressProvisionAdminPassword} minlength="14" maxlength="4096" autocomplete="new-password" /><small class="field-hint">{say("Almeno 14 caratteri. La conserviamo nel portachiavi locale fino alla fine o al recupero del piano.", "At least 14 characters. It stays in the local keyring until the plan completes or is recovered.")}</small></div>
    </div>
    <button class="button outline small" onclick={() => void act(prepareWordPressInstall)} disabled={busy || !wordpressProvisionSiteTitle.trim() || !wordpressProvisionAdminUsername.trim() || !wordpressProvisionAdminEmail.trim() || wordpressProvisionAdminPassword.length < 14}>{say("Prepara il piano d’installazione", "Prepare installation plan")} →</button>
  </section>
{/if}
{#if wordpressProvisionPlans.length > 1}
  <div class="wordpress-provision-history">
    <label class="field-label" for="wordpress-provision-history">{say("Piani WordPress recenti", "Recent WordPress plans")}</label>
    <select id="wordpress-provision-history" value={wordpressProvisionPlan?.id ?? ""} onchange={(event) => wordpressProvisionPlan = wordpressProvisionPlans.find((plan) => plan.id === event.currentTarget.value) ?? null}>
      {#each wordpressProvisionPlans as plan (plan.id)}<option value={plan.id}>{plan.siteTitle} · {plan.state} · {formatDate(plan.updatedAt)}</option>{/each}
    </select>
  </div>
{/if}
{#if wordpressProvisionPlan}
  <div class="wordpress-provision-plan" class:is-complete={wordpressProvisionPlan.state === "complete"} class:is-blocked={wordpressProvisionPlan.state === "blocked" || wordpressProvisionPlan.state === "expired"} aria-live="polite">
    <div class="wordpress-provision-plan-heading">
      <div><strong>{wordpressProvisionPlan.state === "complete" ? say("WordPress e Histeon installati", "WordPress and Histeon installed") : wordpressProvisionPlan.state === "planned" ? say("Piano pronto per la revisione", "Plan ready for review") : ["needs-recovery", "recovering", "uploading", "installing"].includes(wordpressProvisionPlan.state) ? say("Operazione da verificare o riprendere", "Operation needs a check or recovery") : wordpressProvisionPlan.state === "expired" ? say("Piano scaduto", "Plan expired") : say("Piano interrotto", "Plan stopped")}</strong><small>{say(`Creato ${formatDate(wordpressProvisionPlan.createdAt)} · valido fino al ${formatDate(wordpressProvisionPlan.expiresAt)}`, `Created ${formatDate(wordpressProvisionPlan.createdAt)} · expires ${formatDate(wordpressProvisionPlan.expiresAt)}`)}</small></div>
      <span class="provision-state">{wordpressProvisionPlan.state}</span>
    </div>
    <div class="wordpress-provision-summary">
      <div><small>{say("Cartella sul server", "Server folder")}</small><strong>{wordpressProvisionPlan.target.remoteDirectory}</strong><span>{wordpressProvisionPlan.target.protocol.toUpperCase()} · {wordpressProvisionPlan.target.host}:{wordpressProvisionPlan.target.port}</span></div>
      <div><small>{say("Database vuoto", "Empty database")}</small><strong>{wordpressProvisionPlan.database.databaseName}</strong><span>{wordpressProvisionPlan.database.engine} {wordpressProvisionPlan.database.serverVersion} · {say("prefisso", "prefix")} {wordpressProvisionPlan.database.tablePrefix}</span></div>
      <div><small>WordPress</small><strong>{wordpressProvisionPlan.wordpress.version}</strong><span>{wordpressProvisionPlan.wordpress.fileCount} {say("file", "files")} · {formatBytes(wordpressProvisionPlan.wordpress.bytes)} · PHP ≥ {wordpressProvisionPlan.wordpress.phpMinimum}</span></div>
      <div><small>Histeon</small><strong>{wordpressProvisionPlan.histos.version}</strong><span>{wordpressProvisionPlan.histos.fileCount} {say("file", "files")} · {formatBytes(wordpressProvisionPlan.histos.bytes)} · PHP ≥ {wordpressProvisionPlan.histos.phpMinimum}</span></div>
    </div>
    <p class="field-hint">{say(`URL pubblico: ${wordpressProvisionPlan.target.publicUrl}. Titolo: ${wordpressProvisionPlan.siteTitle}. Amministratore: ${wordpressProvisionPlan.adminUsername} (${wordpressProvisionPlan.adminEmail}).`, `Public URL: ${wordpressProvisionPlan.target.publicUrl}. Title: ${wordpressProvisionPlan.siteTitle}. Administrator: ${wordpressProvisionPlan.adminUsername} (${wordpressProvisionPlan.adminEmail}).`)}</p>
    {#if wordpressProvisionPlan.errorCode}<small class="provision-error">{say(`Ultimo passaggio da controllare: ${wordpressProvisionPlan.errorCode}. I file e il database non vengono azzerati automaticamente.`, `Last step to check: ${wordpressProvisionPlan.errorCode}. Files and database are never cleared automatically.`)}</small>{/if}
    {#if wordpressProvisionPlan.state === "planned"}
      <button class="button primary small" onclick={() => void act(() => applyWordPressInstall(wordpressProvisionPlan!.id))} disabled={busy}>{say("Installa WordPress e Histeon in questa destinazione", "Install WordPress and Histeon at this destination")} →</button>
    {:else if ["uploading", "installing", "recovering", "needs-recovery"].includes(wordpressProvisionPlan.state)}
      <button class="button outline small" onclick={() => void act(() => applyWordPressInstall(wordpressProvisionPlan!.id))} disabled={busy}>{say("Verifica e riprendi il piano", "Check and resume this plan")} →</button>
    {:else if wordpressProvisionPlan.state === "complete" && wordpressProvisionPlan.result}
      <a class="public-link" href={wordpressProvisionPlan.result.siteUrl} target="_blank" rel="noreferrer">{wordpressProvisionPlan.result.siteUrl} ↗</a>
      <p class="field-hint">{say("Il nuovo sito è collegato al catalogo Histeon e disponibile nel selettore Pubblicazione del progetto. Puoi ancora rivedere il piano di trasferimento; non ho importato o pubblicato contenuti.", "The new site is connected to the Histeon catalog and is available in the project's Publishing selector. You can still review the transfer plan; no content has been imported or published.")}</p>
    {/if}
  </div>
{/if}
