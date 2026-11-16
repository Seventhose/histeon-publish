<script lang="ts">
  import { stateLabel, translate, type Language } from "../lib/i18n.js";
  import type { CmsBuild, CmsReadinessItem, CmsSiteCheck, CmsBuildDeployment, CmsProjectDetails, CmsPublishPlan, CmsPublishedHomeCheck, CmsRemoteConnection, CmsRemoteOperation, CmsRemoteOperationState, DatabaseConnection, HostingDirectoryInspection, Site, WordPressPreflight, WordPressProvisionPlan } from "../lib/app-types.js";
  import { formatBytes as formatBytesIn, formatDate as formatDateIn } from "../lib/app-format.js";
  import HisteonVersionNotice from "./HisteonVersionNotice.svelte";
  import AgentSendMode from "./AgentSendMode.svelte";
  import CmsRemoteSiteCheck from "./CmsRemoteSiteCheck.svelte";
  import ProposalMatch from "./ProposalMatch.svelte";

  /** The project's «Pubblicazione» section: site check, destinations, a new WordPress, the build and its history, linked sites. */
  let { language, act, applyWordPressInstall, beginCmsUnlink, buildCmsProject, busy, checkCmsRemoteOperation, checkCmsSite, verifyCmsSiteInBrowser, closeCmsSyncPlan, cmsBuild, cmsBuildHistory, cmsBuilding, cmsConnections, cmsDeployHealthCheck, cmsDeploySiteId = $bindable(), cmsLiveDeploymentId, cmsPairingCode = $bindable(), cmsPublishDestinations, cmsPublishPlan = $bindable(), cmsPublishPlanConfirmed = $bindable(), cmsPublishWaysOpen = $bindable(), cmsSiteCheck, cmsWordPressSetupSiteId = $bindable(), connectCmsSite, createCmsDestinationSite, databaseConnections, deployCmsProject, downloadCmsStaticZip, exportCmsStaticBuild, hostingDirectoryInspection, inspectHostingDirectory, loadSettings, openSite, prepareCmsDestinationPlan, prepareCmsRemoteRollback, prepareCmsRollback, prepareWordPressInstall, pullCmsSite, pushCmsProject, selectedCmsProject, selectedSite, sites, verifyWordPressPreflight, verifyWordPressRuntime, wordPressDatabaseTlsStatus, wordpressDatabaseConnectionId = $bindable(), wordpressPreflight = $bindable(), wordpressProvisionAdminEmail = $bindable(), wordpressProvisionAdminPassword = $bindable(), wordpressProvisionAdminUsername = $bindable(), wordpressProvisionPlan = $bindable(), wordpressProvisionPlans, wordpressProvisionSiteTitle = $bindable() }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    applyWordPressInstall: (planId: string) => Promise<void>;
    buildCmsProject: () => Promise<void>;
    busy: boolean;
    /** «Scollega» here too: everything about a linked site is in its own project (doc 23). */
    beginCmsUnlink: (connection: CmsRemoteConnection) => void;
    checkCmsRemoteOperation: (connection: CmsRemoteConnection, operation: CmsRemoteOperation) => Promise<void>;
    checkCmsSite: () => Promise<void>;
    verifyCmsSiteInBrowser: () => Promise<void>;
    closeCmsSyncPlan: () => void;
    cmsBuild: CmsBuild | null;
    cmsBuildHistory: CmsBuild[];
    cmsBuilding: boolean;
    cmsConnections: CmsRemoteConnection[];
    cmsDeployHealthCheck: CmsPublishedHomeCheck | null;
    cmsDeploySiteId: string;
    cmsLiveDeploymentId: string | null;
    cmsPairingCode: string;
    cmsPublishDestinations: () => Array<{ id: string; label: string; kind: "static" | "wordpress" | "new-wordpress" }>;
    cmsPublishPlan: CmsPublishPlan | null;
    cmsPublishPlanConfirmed: boolean;
    cmsPublishWaysOpen: boolean;
    cmsSiteCheck: CmsSiteCheck | null;
    cmsWordPressSetupSiteId: string;
    connectCmsSite: () => Promise<void>;
    createCmsDestinationSite: () => Promise<void>;
    databaseConnections: DatabaseConnection[];
    deployCmsProject: () => Promise<void>;
    downloadCmsStaticZip: () => Promise<void>;
    exportCmsStaticBuild: () => Promise<void>;
    hostingDirectoryInspection: HostingDirectoryInspection | null;
    inspectHostingDirectory: () => Promise<void>;
    loadSettings: () => Promise<void>;
    openSite: (id: string, navigateToSite?: boolean) => Promise<void>;
    prepareCmsDestinationPlan: () => Promise<void>;
    prepareCmsRemoteRollback: (connection: CmsRemoteConnection, operation: CmsRemoteOperation, resumePartial?: boolean) => Promise<void>;
    prepareCmsRollback: (build: CmsBuild, deployment: CmsBuildDeployment) => void;
    prepareWordPressInstall: () => Promise<void>;
    pullCmsSite: (connection: CmsRemoteConnection) => Promise<void>;
    pushCmsProject: (connection: CmsRemoteConnection, action?: "push" | "publish") => Promise<void>;
    selectedCmsProject: CmsProjectDetails | null;
    selectedSite: Site | null;
    sites: Site[];
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
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  /** A line of the verdict: what was found and how many times (an axe rule by its name). */
  const readinessLine = (item: CmsReadinessItem): string => item.rule.startsWith("axe:") ? t("ready.rule.axe", { rule: item.rule.slice(4), n: item.count }) : t(`ready.rule.${item.rule}`, { n: item.count, total: item.total ?? item.count });
  const stateOf = (status: string) => stateLabel(language, status);
  const formatDate = (value?: string) => formatDateIn(language, value);
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);

  function cmsDeploymentStatusText(status: string): string {
    return stateOf(status).label;
  }
  function cmsRemoteOperationStatusText(operation: CmsRemoteOperation): string {
    const labels: Record<CmsRemoteOperationState, [string, string]> = {
      pending: ["Da controllare", "Needs checking"], applying: ["In corso", "In progress"], partial: ["Interrotta", "Interrupted"], superseded: ["Sostituita dopo verifica", "Superseded after verification"],
      "not-found": ["Non trovata", "Not found"], complete: ["Completata", "Complete"], "complete-local-changes": ["Completata, con modifiche locali", "Complete, local changes"], failed: ["Rifiutata", "Rejected"],
      "rolled-back": ["Ripristinata", "Rolled back"],
    };
    return say(...labels[operation.state]);
  }
  function cmsRemoteOperationVisible(operation: CmsRemoteOperation): boolean {
    return ["pending", "applying", "partial", "superseded", "not-found", "complete-local-changes"].includes(operation.state)
      || (operation.rollbackAvailable && ["complete", "complete-local-changes"].includes(operation.state));
  }
</script>

{#if selectedCmsProject}
  <section class="panel-card cms-deploy-controls cms-unified-publish">
    <div class="panel-head"><span class="step-number" aria-hidden="true">↗</span><div><h2 id="cms-publish-heading" tabindex="-1">{say("Pubblicazione", "Publishing")}</h2><p>{t("cms.deployHint")}</p></div><button class="button text small" onclick={() => void act(buildCmsProject)} disabled={busy} aria-busy={cmsBuilding}>{cmsBuilding ? t("cms.building") : t("cms.createBuild")}</button><button class="button text small" onclick={() => void act(checkCmsSite)} disabled={busy} data-testid="cms-site-check">{t("check.run")}</button></div>
    {#if cmsSiteCheck}
      {@const found = cmsSiteCheck.check}
      <div class="site-check" data-testid="cms-site-check-result">
        {#if cmsSiteCheck.readiness}
          {@const ready = cmsSiteCheck.readiness}
          <section class="readiness readiness--{ready.verdict}" aria-labelledby="cms-readiness-heading" data-testid="cms-readiness">
            <h3 class="readiness__title" id="cms-readiness-heading">{t("ready.title")}</h3>
            <p class="readiness__verdict" data-testid="cms-readiness-verdict" data-verdict={ready.verdict}><strong>{t(`ready.verdict.${ready.verdict}`)}</strong> {t(`ready.hint.${ready.verdict}`)}</p>
            <ul class="readiness__sections">
              {#each ready.sections as section (section.id)}
                <li class="readiness__section readiness__section--{section.state}" data-testid="cms-readiness-{section.id}">
                  <span class="readiness__name">{t(`ready.section.${section.id}`)}</span> · <span class="readiness__state">{t(`ready.state.${section.state}`)}</span>
                  {#if section.items.length}
                    <ul class="readiness__items">{#each section.items as item (item.rule)}<li>{readinessLine(item)}{#if item.pages.length}: {#each item.pages as address, position (address)}{position ? ", " : ""}<code>{address}</code>{/each}{/if}</li>{/each}</ul>
                  {/if}
                  {#if section.id === "accessibility" && section.state === "unchecked"}
                    <p class="readiness__note">{t("ready.unchecked")}</p>
                    {#if cmsSiteCheck.browserAvailable}<button class="button text small" onclick={() => void act(verifyCmsSiteInBrowser)} disabled={busy} data-testid="cms-readiness-verify">{t("ready.verify")}</button>{:else}<p class="readiness__note">{t("ready.verifyAppOnly")}</p>{/if}
                  {:else if section.id === "accessibility" && ready.browserCheckedAt}
                    <p class="readiness__note">{t("ready.verifiedAt", { at: formatDate(ready.browserCheckedAt) })}</p>
                  {/if}
                </li>
              {/each}
            </ul>
            <ProposalMatch {language} projectId={selectedCmsProject.project.id} version={cmsBuild?.id ?? ""} />
          </section>
        {/if}
        <strong>{found.brokenLinks.length + found.heavyImages.length + found.missingAlt.length + found.noDescription.length + found.sameTitle.length + found.sameDescription.length ? t("check.found", { pages: found.pages }) : t("check.clean", { pages: found.pages })}</strong>
        {#if found.brokenLinks.length}<details open><summary>{t("check.links", { n: found.brokenLinks.length })}</summary><ul>{#each found.brokenLinks as item (`${item.page}${item.link}`)}<li><code>{item.link}</code> {t("check.in")} <code>{item.page}</code></li>{/each}</ul></details>{/if}
        {#if found.sameTitle.length}<details open data-testid="cms-site-check-titles"><summary>{t("check.sameTitle", { n: found.sameTitle.length })}</summary><ul>{#each found.sameTitle as item (item.text)}<li><strong>{item.text}</strong>: {#each item.pages as page, position (page)}{position ? ", " : ""}<code>{page}</code>{/each}</li>{/each}</ul></details>{/if}
        {#if found.sameDescription.length}<details><summary>{t("check.sameDescription", { n: found.sameDescription.length })}</summary><ul>{#each found.sameDescription as item (item.text)}<li>{item.text.slice(0, 90)}: {#each item.pages as page, position (page)}{position ? ", " : ""}<code>{page}</code>{/each}</li>{/each}</ul></details>{/if}
        {#if found.heavyImages.length}<details><summary>{t("check.heavy", { n: found.heavyImages.length })}</summary><ul>{#each found.heavyImages as item (item.file)}<li><code>{item.file}</code> · {item.kilobytes} KB</li>{/each}</ul></details>{/if}
        {#if found.missingAlt.length}<details><summary>{t("check.alt", { n: found.missingAlt.length })}</summary><ul>{#each found.missingAlt as item (`${item.page}${item.image}`)}<li><code>{item.page}</code></li>{/each}</ul></details>{/if}
        {#if found.noDescription.length}<details><summary>{t("check.description", { n: found.noDescription.length })}</summary><ul>{#each found.noDescription as item (item)}<li><code>{item}</code></li>{/each}</ul></details>{/if}
      </div>
    {/if}
    {#if cmsPublishDestinations().length}
      <label class="field-label" for="cms-deploy-destination">{t("cms.destination")}</label>
      <select id="cms-deploy-destination" bind:value={cmsDeploySiteId} onchange={() => { cmsPublishPlan = null; cmsPublishPlanConfirmed = false; cmsWordPressSetupSiteId = ""; closeCmsSyncPlan(); }}>
        <option value="">{t("cms.chooseDestination")}</option>
        {#each cmsPublishDestinations() as destination (destination.id)}<option value={destination.id}>{destination.label}</option>{/each}
      </select>
      {#if cmsDeploySiteId.startsWith("wordpress:")}
        <p class="field-hint">{say("WordPress riceve il progetto Histeon e i contenuti pubblicabili tramite il collegamento autorizzato. Non serve una versione statica.", "WordPress receives the Histeon project and publishable content through its authorized connection. No static build is needed.")}</p>
      {:else if cmsDeploySiteId.startsWith("wordpress-new:")}
        <p class="field-hint">{say("Apro il setup per un nuovo WordPress usando un hosting FTP/FTPS/SFTP già configurato. Prima passerai da verifica database, runtime PHP e piano; non parte nessuna installazione automatica.", "I’ll open setup for a new WordPress site using an existing FTP/FTPS/SFTP profile. You’ll review the database, PHP runtime, and plan first; no installation starts automatically.")}</p>
      {:else}
        <p class="field-hint">{say("Cloudflare e hosting ricevono i file statici prodotti dalla versione. Se serve, la creo prima di preparare il piano.", "Cloudflare and hosting receive the static build files. I’ll create a build first if needed.")}</p>
      {/if}
      <button class="button dark" onclick={() => void act(prepareCmsDestinationPlan)} disabled={busy || !cmsDeploySiteId}>
        {#if cmsDeploySiteId.startsWith("wordpress-new:")}{say("Configura nuovo WordPress", "Set up new WordPress")}{:else if cmsDeploySiteId.startsWith("wordpress:") || (cmsBuild?.status === "ready" && cmsBuild.current !== false)}{say("Rivedi piano di pubblicazione", "Review publish plan")}{:else}{say("Prepara il sito e rivedi il piano", "Build and review publish plan")}{/if}
      </button>
    {/if}
    {#if cmsPublishDestinations().length === 0 || cmsPublishWaysOpen}
      <div class="cms-publish-ways" data-testid="cms-publish-ways">
        <p class="field-hint">{cmsPublishDestinations().length === 0 ? t("cms.waysIntro") : t("cms.waysMore")}</p>
        <article class="cms-publish-way">
          <strong>{t("cms.wayZip")}</strong>
          <p>{t("cms.wayZipHint")}</p>
          <button class="button outline small" type="button" data-testid="cms-way-zip" onclick={() => void act(downloadCmsStaticZip)} disabled={busy}>{t("cms.wayZipAction")}</button>
        </article>
        <article class="cms-publish-way">
          <strong>{t("cms.wayHosting")}</strong>
          <p>{t("cms.wayHostingHint")}</p>
          <button class="button outline small" type="button" data-testid="cms-way-hosting" onclick={() => void act(createCmsDestinationSite)} disabled={busy}>{t("cms.wayHostingAction")}</button>
        </article>
        <article class="cms-publish-way">
          <strong>{t("cms.wayWordPress")}</strong>
          <p>{t("cms.wayWordPressHint")}</p>
          <form class="input-action" onsubmit={(event) => { event.preventDefault(); void act(connectCmsSite); }}>
            <input aria-label={t("cms.wayWordPressCode")} bind:value={cmsPairingCode} autocomplete="off" spellcheck="false" placeholder={t("cms.wayWordPressCode")} data-testid="cms-way-wordpress-code" />
            <button class="button outline small" type="submit" disabled={busy || !cmsPairingCode.trim()}>{t("cms.wayWordPressAction")}</button>
          </form>
        </article>
      </div>
    {:else}
      <button class="button text small" type="button" onclick={() => cmsPublishWaysOpen = true}>{t("cms.waysOpen")}</button>
    {/if}
  </section>
  {#if selectedCmsProject && selectedSite && cmsWordPressSetupSiteId === selectedSite.id && cmsDeploySiteId === `wordpress-new:${selectedSite.id}`}
    <section class="panel-card cms-wordpress-setup" aria-labelledby="cms-wordpress-setup-title">
      <div class="panel-head"><span class="step-number" aria-hidden="true">WP</span><div><h2 id="cms-wordpress-setup-title">{say("Configura WordPress per", "Set up WordPress for")} {selectedCmsProject.project.name}</h2><p>{say("Passaggi guidati: destinazione, database, controlli e piano. L’installazione parte solo dopo la tua conferma finale.", "Guided setup: destination, database, checks, and plan. Installation starts only after your final confirmation.")}</p></div><button class="button text small" type="button" onclick={() => cmsWordPressSetupSiteId = ""}>{say("Chiudi", "Close")}</button></div>
      <div class="cms-wordpress-target" aria-label={say("Destinazione WordPress selezionata", "Selected WordPress destination")}>
        <strong>{selectedSite.name}</strong>
        <span>{selectedSite.hosting?.protocol.toUpperCase()} · {selectedSite.hosting?.host}:{selectedSite.hosting?.port} · {selectedSite.hosting?.remoteDirectory}</span>
        <a href={selectedSite.hosting?.publicUrl ?? "#"} target="_blank" rel="noreferrer">{selectedSite.hosting?.publicUrl} ↗</a>
      </div>
      {#if !selectedSite.hostingCredentialsConfigured || !selectedSite.hosting}
        <p class="field-hint" role="alert">{say("Manca il profilo hosting salvato. Apri le impostazioni del sito, completa e verifica la connessione, poi torna qui.", "The saved hosting profile is missing. Open the site settings, complete and verify the connection, then return here.")}</p>
        <button class="button outline small" onclick={() => void act(() => openSite(selectedSite!.id))}>{say("Apri impostazioni hosting", "Open hosting settings")}</button>
      {:else}
        <div class="cms-wordpress-checks">
          <label class="field-label" for="cms-wordpress-database">{say("Database per il nuovo WordPress", "Database for the new WordPress site")}</label>
          <select id="cms-wordpress-database" bind:value={wordpressDatabaseConnectionId} onchange={() => wordpressPreflight = null} disabled={busy || databaseConnections.length === 0}>
            <option value="">{say("Scegli una connessione verificata", "Choose a verified connection")}</option>
            {#each databaseConnections as connection (connection.id)}<option value={connection.id}>{connection.name} · {connection.engine} · {connection.serverVersion}</option>{/each}
          </select>
          {#if !databaseConnections.length}
            <p class="field-hint">{say("Aggiungi e verifica una connessione da Impostazioni → MySQL / MariaDB.", "Add and verify a connection in Settings → MySQL / MariaDB.")}</p>
            <button class="button outline small" onclick={() => void act(loadSettings)}>{say("Apri impostazioni database", "Open database settings")}</button>
          {/if}
          <div class="cms-wordpress-step-actions">
            <button class="button outline small" onclick={() => void act(inspectHostingDirectory)} disabled={busy}>{say("Controlla cartella (sola lettura)", "Inspect folder (read-only)")}</button>
            <button class="button dark small" onclick={() => void act(verifyWordPressPreflight)} disabled={busy || !wordpressDatabaseConnectionId}>{say("Verifica database e cartella", "Check database and folder")}</button>
          </div>
          {#if hostingDirectoryInspection}
            <div class="directory-inspection" class:is-empty={hostingDirectoryInspection.isEmpty} class:is-occupied={!hostingDirectoryInspection.isEmpty} aria-live="polite">
              <strong>{hostingDirectoryInspection.isEmpty ? say("Cartella vuota", "Empty folder") : say("Cartella già occupata", "Folder already contains files")}</strong>
              <span>{say(`${hostingDirectoryInspection.entryCount} elementi rilevati.`, `${hostingDirectoryInspection.entryCount} entries detected.`)}</span>
              {#if hostingDirectoryInspection.wordpressSignals.length}<small>{say(`File WordPress rilevati: ${hostingDirectoryInspection.wordpressSignals.join(", ")}.`, `WordPress files detected: ${hostingDirectoryInspection.wordpressSignals.join(", ")}.`)}</small>{/if}
            </div>
          {/if}
          {#if wordpressPreflight?.status === "awaiting-php-check"}
            <div class="cms-wordpress-runtime-step">
              <p class="field-hint">{say("Ora verifichiamo PHP, HTTPS e TLS verso il database. Il controllo usa per pochi secondi un file PHP protetto da token e verifica che venga rimosso. Non installa WordPress.", "Next we check PHP, HTTPS, and database TLS. The check briefly uses a token-protected PHP file and verifies its removal. It does not install WordPress.")}</p>
              <button class="button outline small" onclick={() => void act(verifyWordPressRuntime)} disabled={busy}>{say("Verifica PHP, HTTPS e database", "Check PHP, HTTPS, and database")}</button>
            </div>
          {/if}
        </div>
        {#if wordpressPreflight}
          <div class="wordpress-preflight-result" class:is-blocked={wordpressPreflight.status === "blocked"} class:is-pending={wordpressPreflight.status === "awaiting-php-check"} aria-live="polite">
            <strong>{wordpressPreflight.status === "blocked" ? say("Controlli bloccati", "Checks blocked") : wordpressPreflight.status === "ready-for-install" ? say("Prerequisiti superati; installazione non avviata", "Prerequisites passed; installation has not started") : say("File e database verificati", "Files and database checked")}</strong>
            <span>{say(`Cartella: ${wordpressPreflight.filesystem.entryCount} elementi${wordpressPreflight.filesystem.empty ? ", vuota" : ", già occupata"}.`, `Folder: ${wordpressPreflight.filesystem.entryCount} entries${wordpressPreflight.filesystem.empty ? ", empty" : ", already occupied"}.`)}</span>
            <span>{say(`Database: ${wordpressPreflight.database.engine} ${wordpressPreflight.database.serverVersion}, ${wordpressPreflight.database.tableCount} tabelle.`, `Database: ${wordpressPreflight.database.engine} ${wordpressPreflight.database.serverVersion}, ${wordpressPreflight.database.tableCount} tables.`)}</span>
            <span>{wordpressPreflight.database.privilegesVerified ? wordpressPreflight.database.missingPrivileges.length ? say(`Permessi mancanti: ${wordpressPreflight.database.missingPrivileges.join(", ")}.`, `Missing privileges: ${wordpressPreflight.database.missingPrivileges.join(", ")}.`) : say("Permessi database verificati.", "Database permissions verified.") : say("Permessi database non verificati.", "Database permissions not verified.")}</span>
            {#if wordpressPreflight.filesystem.wordpressSignals.length}<small>{say(`Elementi WordPress rilevati: ${wordpressPreflight.filesystem.wordpressSignals.join(", ")}.`, `WordPress entries detected: ${wordpressPreflight.filesystem.wordpressSignals.join(", ")}.`)}</small>{/if}
            <p>{say(`PHP ${wordpressPreflight.runtime.phpChecked ? wordpressPreflight.runtime.phpVersion : "non ancora verificato"} · HTTPS ${wordpressPreflight.runtime.httpsAvailable ? "verificato" : wordpressPreflight.runtime.httpsConfigured ? "configurato, non verificato" : "da configurare"} · database TLS ${wordpressPreflight.runtime.databaseTlsVerified ? "verificato" : "da verificare"}. L’installazione non è partita.`, `PHP ${wordpressPreflight.runtime.phpChecked ? wordpressPreflight.runtime.phpVersion : "not checked yet"} · HTTPS ${wordpressPreflight.runtime.httpsAvailable ? "verified" : wordpressPreflight.runtime.httpsConfigured ? "configured, not verified" : "needs setup"} · database TLS ${wordpressPreflight.runtime.databaseTlsVerified ? "verified" : "not checked"}. Installation has not started.`)}</p>
            {#if wordpressPreflight.runtime.phpChecked && wordpressPreflight.runtime.missingRequiredExtensions.length}<small>{say(`Estensioni PHP obbligatorie mancanti: ${wordpressPreflight.runtime.missingRequiredExtensions.join(", ")}.`, `Required PHP extensions missing: ${wordpressPreflight.runtime.missingRequiredExtensions.join(", ")}.`)}</small>{/if}
            {#if wordpressPreflight.runtime.databaseTlsFailure}<small>{wordPressDatabaseTlsStatus(wordpressPreflight.runtime)}</small>{/if}
          </div>
        {/if}
        {#if wordpressPreflight?.status === "ready-for-install"}
          <section class="wordpress-provision-form" aria-labelledby="cms-wordpress-provision-title">
            <div class="eyebrow">{say("NUOVO WORDPRESS", "NEW WORDPRESS SITE")}</div>
            <h3 id="cms-wordpress-provision-title">{say("Crea WordPress con Histeon", "Create WordPress with Histeon")}</h3>
            <p class="field-hint">{say("Preparo un piano con percorso, database e versioni. L’installazione modifica solo cartella e database vuoti verificati.", "I’ll prepare a plan with the path, database, and versions. Installation only writes to the verified empty folder and database.")}</p>
            <div class="settings-grid">
              <div class="wide-field"><label class="field-label" for="cms-wordpress-title">{say("Titolo del sito", "Site title")}</label><input id="cms-wordpress-title" bind:value={wordpressProvisionSiteTitle} maxlength="120" autocomplete="organization-title" /></div>
              <div><label class="field-label" for="cms-wordpress-admin-user">{say("Utente amministratore", "Administrator username")}</label><input id="cms-wordpress-admin-user" bind:value={wordpressProvisionAdminUsername} maxlength="60" autocomplete="username" /></div>
              <div><label class="field-label" for="cms-wordpress-admin-email">{say("Email amministratore", "Administrator email")}</label><input id="cms-wordpress-admin-email" type="email" bind:value={wordpressProvisionAdminEmail} maxlength="254" autocomplete="email" /></div>
              <div class="wide-field"><label class="field-label" for="cms-wordpress-admin-password">{say("Password amministratore", "Administrator password")}</label><input id="cms-wordpress-admin-password" type="password" bind:value={wordpressProvisionAdminPassword} minlength="14" maxlength="4096" autocomplete="new-password" /><small class="field-hint">{say("Almeno 14 caratteri. Resta nel portachiavi locale fino al completamento o al recupero.", "At least 14 characters. Stored in the local keyring until completion or recovery.")}</small></div>
            </div>
            <button class="button outline small" onclick={() => void act(prepareWordPressInstall)} disabled={busy || !wordpressProvisionSiteTitle.trim() || !wordpressProvisionAdminUsername.trim() || !wordpressProvisionAdminEmail.trim() || wordpressProvisionAdminPassword.length < 14}>{say("Prepara il piano d’installazione", "Prepare installation plan")} →</button>
          </section>
        {/if}
        {#if wordpressProvisionPlans.length > 1}
          <div class="wordpress-provision-history"><label class="field-label" for="cms-wordpress-plan-history">{say("Piani WordPress recenti", "Recent WordPress plans")}</label><select id="cms-wordpress-plan-history" value={wordpressProvisionPlan?.id ?? ""} onchange={(event) => wordpressProvisionPlan = wordpressProvisionPlans.find((plan) => plan.id === event.currentTarget.value) ?? null}>{#each wordpressProvisionPlans as plan (plan.id)}<option value={plan.id}>{plan.siteTitle} · {plan.state} · {formatDate(plan.updatedAt)}</option>{/each}</select></div>
        {/if}
        {#if wordpressProvisionPlan}
          <div class="wordpress-provision-plan" class:is-complete={wordpressProvisionPlan.state === "complete"} class:is-blocked={wordpressProvisionPlan.state === "blocked" || wordpressProvisionPlan.state === "expired"} aria-live="polite">
            <div class="wordpress-provision-plan-heading"><div><strong>{wordpressProvisionPlan.state === "complete" ? say("WordPress e Histeon installati", "WordPress and Histeon installed") : wordpressProvisionPlan.state === "planned" ? say("Piano pronto per la revisione", "Plan ready for review") : ["needs-recovery", "recovering", "uploading", "installing"].includes(wordpressProvisionPlan.state) ? say("Operazione da verificare o riprendere", "Operation needs review or recovery") : say("Piano interrotto", "Plan stopped")}</strong><small>{say(`Creato ${formatDate(wordpressProvisionPlan.createdAt)} · valido fino al ${formatDate(wordpressProvisionPlan.expiresAt)}`, `Created ${formatDate(wordpressProvisionPlan.createdAt)} · expires ${formatDate(wordpressProvisionPlan.expiresAt)}`)}</small></div><span class="provision-state">{wordpressProvisionPlan.state}</span></div>
            <div class="wordpress-provision-summary"><div><small>{say("Cartella sul server", "Server folder")}</small><strong>{wordpressProvisionPlan.target.remoteDirectory}</strong><span>{wordpressProvisionPlan.target.protocol.toUpperCase()} · {wordpressProvisionPlan.target.host}:{wordpressProvisionPlan.target.port}</span></div><div><small>{say("Database vuoto", "Empty database")}</small><strong>{wordpressProvisionPlan.database.databaseName}</strong><span>{wordpressProvisionPlan.database.engine} {wordpressProvisionPlan.database.serverVersion} · {say("prefisso", "prefix")} {wordpressProvisionPlan.database.tablePrefix}</span></div><div><small>WordPress</small><strong>{wordpressProvisionPlan.wordpress.version}</strong><span>{wordpressProvisionPlan.wordpress.fileCount} {say("file", "files")} · {formatBytes(wordpressProvisionPlan.wordpress.bytes)}</span></div><div><small>Histeon</small><strong>{wordpressProvisionPlan.histos.version}</strong><span>{wordpressProvisionPlan.histos.fileCount} {say("file", "files")} · {formatBytes(wordpressProvisionPlan.histos.bytes)}</span></div></div>
            <p class="field-hint">{say(`URL: ${wordpressProvisionPlan.target.publicUrl}. Amministratore: ${wordpressProvisionPlan.adminUsername} (${wordpressProvisionPlan.adminEmail}).`, `URL: ${wordpressProvisionPlan.target.publicUrl}. Administrator: ${wordpressProvisionPlan.adminUsername} (${wordpressProvisionPlan.adminEmail}).`)}</p>
            {#if wordpressProvisionPlan.errorCode}<small class="provision-error">{say(`Ultimo passaggio: ${wordpressProvisionPlan.errorCode}. File e database non vengono azzerati automaticamente.`, `Last step: ${wordpressProvisionPlan.errorCode}. Files and database are never cleared automatically.`)}</small>{/if}
            {#if wordpressProvisionPlan.state === "planned"}<button class="button primary small" onclick={() => void act(() => applyWordPressInstall(wordpressProvisionPlan!.id))} disabled={busy}>{say("Installa WordPress e Histeon", "Install WordPress and Histeon")} →</button>
            {:else if ["uploading", "installing", "recovering", "needs-recovery"].includes(wordpressProvisionPlan.state)}<button class="button outline small" onclick={() => void act(() => applyWordPressInstall(wordpressProvisionPlan!.id))} disabled={busy}>{say("Verifica e riprendi il piano", "Check and resume the plan")} →</button>
            {:else if wordpressProvisionPlan.state === "complete" && wordpressProvisionPlan.result}<a class="public-link" href={wordpressProvisionPlan.result.siteUrl} target="_blank" rel="noreferrer">{wordpressProvisionPlan.result.siteUrl} ↗</a><p class="field-hint">{say("WordPress e Histeon sono installati. Il collegamento è selezionato nel progetto; non ho trasferito i contenuti.", "WordPress and Histeon are installed. The connection is selected in this project; no content has been transferred.")}</p>{/if}
          </div>
        {/if}
      {/if}
    </section>
  {/if}
  {#if cmsBuild}
    <section class="panel-card cms-build-result" id="cms-build-result">
      <div class="panel-head"><span class="step-number" aria-hidden="true">▣</span><div><h2>{cmsBuild.status === "unavailable" ? say("Versione non disponibile", "Build unavailable") : cmsBuild.status === "ready" && cmsBuild.current === false ? say("Versione precedente", "Previous build") : cmsBuild.status === "ready" ? t("cms.buildReady") : t("cms.buildBlocked")}</h2><p>{cmsBuild.pages} {t("cms.pages").toLowerCase()} · {cmsBuild.files} {t("site.files")} · {formatBytes(cmsBuild.totalBytes)}</p></div></div>
      {#if cmsBuild.previewUrl}<a class="button primary" href={cmsBuild.previewUrl} target="_blank" rel="noreferrer">{t("cms.openPreview")}</a>{/if}
      {#if cmsBuild.status === "unavailable"}<p class="cms-build-history-note" role="status">{say("I file di questa versione non sono più disponibili. Creane una nuova per continuare.", "The files for this build are no longer available. Create a new build to continue.")}</p>{:else if cmsBuild.current === false}<p class="cms-build-history-note" role="status">{say("Il contenuto del progetto è cambiato dopo questa versione. Puoi aprire o scaricare la copia, ma per pubblicare devi creare una versione aggiornata.", "The project changed after this build. You can open or download this copy, but you must create an updated build before publishing.")}</p>{/if}
      {#if cmsBuild.status === "ready"}
        <div class="cms-static-export">
          <button class="button outline" onclick={() => void act(exportCmsStaticBuild)} disabled={busy}>{t("cms.downloadStaticZip")}</button>
          <p class="field-hint">{t("cms.staticZipHint")}</p>
        </div>
        {#if cmsBuild.current !== false && cmsPublishPlan && cmsPublishPlan.destination.id === cmsDeploySiteId}<div class="cms-deploy-controls">
            {#if cmsPublishPlan}
              <div class="cms-publish-plan" role={cmsPublishPlan.status === "blocked" ? "alert" : "status"}>
                <div class="cms-publish-plan-heading"><strong>{cmsPublishPlan.status === "ready" ? say("Piano pronto per la revisione", "Publish plan ready for review") : say("Pubblicazione bloccata", "Publishing is blocked")}</strong><span>{say("Scade", "Expires")} {formatDate(cmsPublishPlan.expiresAt)}</span></div>
                <p><strong>{say("Destinazione", "Destination")}:</strong> {cmsPublishPlan.destination.label} · {cmsPublishPlan.destination.transport} · {cmsPublishPlan.destination.location}</p>
                {#if cmsPublishPlan.destination.publicUrl}<p><strong>{say("Indirizzo pubblico", "Public address")}:</strong> <a href={cmsPublishPlan.destination.publicUrl} target="_blank" rel="noreferrer">{cmsPublishPlan.destination.publicUrl} ↗</a></p>{/if}
                <p><strong>{say("Versione", "Build")}:</strong> {cmsPublishPlan.build.fileCount} {t("common.files")} · {formatBytes(cmsPublishPlan.build.totalBytes)} · home {cmsPublishPlan.build.homePage}</p>
                {#if cmsPublishPlan.rollbackBackup.status !== "not-applicable"}<div class="cms-plan-write-note"><strong>{say("Backup e ripristino hosting", "Hosting backup and restore")}</strong> · {formatBytes(cmsPublishPlan.rollbackBackup.estimatedBytes)} / {formatBytes(cmsPublishPlan.rollbackBackup.maxBytes)}<p>{cmsPublishPlan.rollbackBackup.note}</p></div>{:else}<div class="cms-plan-write-note"><strong>{say("Ripristino", "Rollback")}</strong><p>{cmsPublishPlan.rollback.note}</p></div>{/if}
                <p class="cms-plan-digest"><strong>SHA-256:</strong> <code>{cmsPublishPlan.build.sha256}</code></p>
                <p class="cms-plan-digest"><strong>{say("Revisione progetto", "Project revision")}:</strong> <code>{cmsPublishPlan.projectRevision}</code></p>
                <details class="cms-plan-files"><summary>{say("File inclusi", "Included files")} ({cmsPublishPlan.build.filesPreview.length}{cmsPublishPlan.build.additionalFiles ? ` + ${cmsPublishPlan.build.additionalFiles}` : ""})</summary><ul>{#each cmsPublishPlan.build.filesPreview as file (file.path)}<li><code>{file.path}</code><span>{formatBytes(file.size)}</span></li>{/each}</ul>{#if cmsPublishPlan.build.additionalFiles}<p>{say("Altri file inclusi", "Additional files included")}: {cmsPublishPlan.build.additionalFiles}</p>{/if}</details>
                <section class="cms-remote-diff" aria-label={say("Confronto file remoto", "Remote file comparison")}>
                  <h3>{say("Confronto con l’hosting", "Compare with hosting")}</h3>
                  {#if cmsPublishPlan.remoteDiff.status === "unavailable"}
                    <p>{say("Il provider non fornisce un elenco di file confrontabile.", "The provider does not provide a comparable file list.")}</p>
                  {:else}
                    <ul>
                      <li>{say("Non trovati nell’inventario", "Not found in inventory")}: {cmsPublishPlan.remoteDiff.counts.missing}</li>
                      <li>{say("Stesso percorso e dimensione", "Same path and size")}: {cmsPublishPlan.remoteDiff.counts.sameSize}</li>
                      <li>{say("Stesso percorso, dimensione diversa", "Same path, different size")}: {cmsPublishPlan.remoteDiff.counts.differentSize}</li>
                      <li>{say("Solo sul server e conservati", "Only on server and kept")}: {cmsPublishPlan.remoteDiff.counts.remoteOnly}</li>
                    </ul>
                    <p>{cmsPublishPlan.remoteDiff.note}</p>
                    {#if cmsPublishPlan.remoteDiff.filesPreview.length}<details class="cms-plan-files"><summary>{say("Dettaglio confronto", "Comparison details")} ({cmsPublishPlan.remoteDiff.filesPreview.length}{cmsPublishPlan.remoteDiff.additionalFiles ? ` + ${cmsPublishPlan.remoteDiff.additionalFiles}` : ""})</summary><ul>{#each cmsPublishPlan.remoteDiff.filesPreview as file (`${file.path}:${file.status}`)}<li><code>{file.path}</code><span>{file.status === "missing" ? say("da caricare", "upload") : file.status === "same-size" ? say("stessa dimensione", "same size") : file.status === "different-size" ? say("dimensione diversa", "size differs") : say("conservato", "kept")}</span></li>{/each}</ul>{#if cmsPublishPlan.remoteDiff.additionalFiles}<p>{say("Altre differenze", "More differences")}: {cmsPublishPlan.remoteDiff.additionalFiles}</p>{/if}</details>{/if}
                  {/if}
                </section>
                <ul class="cms-plan-effects">{#each cmsPublishPlan.effects as effect (effect)}<li>{effect}</li>{/each}</ul>
                <p class="cms-plan-write-note">{say("La verifica ha letto la destinazione, ma non ha provato la scrittura. Il provider verificherà il permesso durante il deploy dopo la tua conferma.", "The destination was checked for reading, not writing. The provider will check write access during deployment after you confirm.")}</p>
                {#each cmsPublishPlan.findings as finding (finding.code)}<p class="inspection-finding"><strong>{finding.severity === "block" ? t("common.block") : t("common.warning")}</strong> · {finding.message}</p>{/each}
                {#if cmsPublishPlan.status === "ready" && cmsPublishPlan.planId}
                  <label class="cms-plan-confirm"><input type="checkbox" bind:checked={cmsPublishPlanConfirmed} /><span>{say(`Confermo l’invio di ${cmsPublishPlan.build.fileCount} file a ${cmsPublishPlan.destination.label}.`, `I confirm publishing ${cmsPublishPlan.build.fileCount} files to ${cmsPublishPlan.destination.label}.`)}</span></label>
                  <button class="button dark" onclick={() => void act(deployCmsProject)} disabled={busy || !cmsPublishPlanConfirmed}>{say("Conferma e pubblica", "Confirm and publish")}</button>
                {/if}
              </div>
            {/if}
        </div>{/if}
      {/if}
      {#if cmsBuild.findings.length}
        <ul class="cms-build-findings">
          {#each cmsBuild.findings as finding, index (`${finding.file}-${index}`)}
            <li><strong>{finding.severity === "block" ? t("common.block") : t("common.warning")}</strong> · <code>{finding.code}</code> · {finding.file}: {finding.message}</li>
          {/each}
        </ul>
      {/if}
    </section>
    {#if cmsDeployHealthCheck}
      <section class="panel-card publish-health" class:warning={cmsDeployHealthCheck.status !== "ok"}>
        <div class="section-card-header"><h2>{say("Controllo del sito pubblicato", "Published site check")}</h2><span class="status-chip" class:ready={cmsDeployHealthCheck.status === "ok"} class:stale={cmsDeployHealthCheck.status !== "ok"}>{cmsDeployHealthCheck.status === "ok" ? "OK" : say("Da controllare", "Needs attention")}</span></div>
        <p>{cmsDeployHealthCheck.message}</p>
        {#if cmsDeployHealthCheck.url}<a class="public-link" href={cmsDeployHealthCheck.url} target="_blank" rel="noreferrer">{cmsDeployHealthCheck.url} ↗</a>{/if}
      </section>
    {/if}
  {/if}
  {#if cmsBuildHistory.length}
    <section class="panel-card cms-build-history" aria-labelledby="cms-build-history-title">
      <div class="section-card-header"><div><div class="eyebrow">{say("REGISTRO LOCALE", "LOCAL LOG")}</div><h2 id="cms-build-history-title">{say("Cronologia", "History")}</h2></div><span class="count-badge">{cmsBuildHistory.length}</span></div>
      <div class="timeline">
        {#each cmsBuildHistory as savedBuild (savedBuild.id)}
          <article class="timeline-entry">
            <span class="timeline-dot build-dot"></span>
            <div class="timeline-content">
              <div class="timeline-top"><strong>{say("Versione", "Build")} · {savedBuild.status === "unavailable" ? say("non disponibile", "unavailable") : savedBuild.current ? say("aggiornata", "current") : say("precedente", "previous")}</strong>{#if savedBuild.createdAt}<time>{formatDate(savedBuild.createdAt)}</time>{/if}</div>
              <p>{savedBuild.pages} {t("cms.pages").toLowerCase()} · {savedBuild.files} {t("site.files")} · {formatBytes(savedBuild.totalBytes)}</p>
              {#each savedBuild.deployments ?? [] as deployment (deployment.id)}
                <div class="cms-build-history-deploy">
                  <strong>{say("Pubblicazione", "Publish")} · {cmsDeploymentStatusText(deployment.status)}</strong>{#if deployment.id === cmsLiveDeploymentId}<span class="status-chip ready" data-testid="cms-live-now">{t("history.liveNow")}</span>{/if}
                  <small>{sites.find((site) => site.id === deployment.targetSiteId)?.name ?? say("Destinazione non più configurata", "Destination no longer configured")} · {formatDate(deployment.completedAt ?? deployment.createdAt)}</small>
                  {#if deployment.status === "interrupted"}<small class="cms-build-history-note">{say("Il server si è chiuso durante il trasferimento. L’esito sul provider è incerto: verifica il sito prima di riprovare.", "The server closed during transfer. The provider result is uncertain; check the site before retrying.")}</small>{:else if deployment.error}<small class="cms-build-history-note">{deployment.error}</small>{/if}
                  {#if deployment.result?.healthCheck?.url}<a class="public-link" href={deployment.result.healthCheck.url} target="_blank" rel="noreferrer">{deployment.result.healthCheck.url} ↗</a>{:else if deployment.result?.publicUrl}<a class="public-link" href={deployment.result.publicUrl} target="_blank" rel="noreferrer">{deployment.result.publicUrl} ↗</a>{:else if deployment.result?.workersDevUrl}<a class="public-link" href={deployment.result.workersDevUrl} target="_blank" rel="noreferrer">{deployment.result.workersDevUrl} ↗</a>{/if}
                  {#if deployment.status === "deployed" && deployment.result?.provider === "cloudflare" && deployment.result.versionId && sites.find((site) => site.id === deployment.targetSiteId)?.deployTarget !== "ftp"}<button class="button text small" onclick={() => void act(async () => prepareCmsRollback(savedBuild, deployment))}>{say("Ripristina questa versione Cloudflare", "Restore this Cloudflare version")} →</button>{:else if ["deployed", "failed", "cancelled", "interrupted"].includes(deployment.status) && deployment.result?.provider === "hosting" && deployment.result.rollbackAvailable === true}<button class="button text small" onclick={() => void act(async () => prepareCmsRollback(savedBuild, deployment))}>{say("Ripristina i file hosting precedenti", "Restore previous hosting files")} →</button>{/if}
                </div>
              {/each}
              {#if savedBuild.status === "ready" && savedBuild.previewUrl && savedBuild.id !== cmsBuild?.id}<a class="button text small" href={savedBuild.previewUrl} target="_blank" rel="noreferrer">{t("cms.openPreview")} →</a>{/if}
            </div>
          </article>
        {/each}
      </div>
    </section>
  {/if}
  {#if cmsConnections.length}
    <section class="panel-card cms-remote-panel" id="cms-linked-sites" aria-labelledby="cms-linked-sites-title">
      <div class="panel-head"><span class="step-number" aria-hidden="true">WP</span><div><h2 id="cms-linked-sites-title" tabindex="-1">{t("cms.linkedSites")}</h2><p>{t("cms.linkedHint")}</p></div></div>
      {#each cmsConnections as connection (connection.id)}
        <article class="cms-remote-row">
          <div><strong>{connection.projectName || new URL(connection.url).hostname}</strong><p class="muted">{new URL(connection.url).hostname} · {connection.write ? t("cms.readWrite") : t("cms.readOnly")} · {t("cms.lastSync").toLowerCase()} {formatDate(connection.lastCheckedAt)}</p></div>
          <div class="cms-remote-actions">
            <button class="button outline small" onclick={() => void act(() => pullCmsSite(connection))} disabled={busy || !connection.read}>{t("cms.pullUpdates")}</button>
            <button class="button primary small" onclick={() => void act(() => pushCmsProject(connection, "push"))} disabled={busy || !connection.write || (connection.projectId !== null && connection.projectId !== selectedCmsProject.project.id)}>{t("cms.sendDrafts")}</button>
            <button class="button text small" onclick={() => beginCmsUnlink(connection)} disabled={busy}>{t("cms.unlink")}</button>
          </div>
          {#if connection.projectId !== null && connection.projectId !== selectedCmsProject.project.id}<p class="field-hint">{t("cms.wrongProject")}</p>{/if}
          {#if connection.histeon}<HisteonVersionNotice {language} notice={connection.histeon} />{/if}
          <CmsRemoteSiteCheck {language} {act} {busy} {connection} projectId={connection.projectId === null || connection.projectId === selectedCmsProject.project.id ? selectedCmsProject.project.id : null} />
          <AgentSendMode {language} {act} {busy} {connection} />
          {#if connection.operations?.some((operation) => operation.projectId === selectedCmsProject?.project.id && cmsRemoteOperationVisible(operation))}
            <div class="cms-operation-list" role="region" aria-label={say("Invii remoti da verificare", "Remote sends to review")}>
              {#each (connection.operations ?? []).filter((operation) => operation.projectId === selectedCmsProject?.project.id && cmsRemoteOperationVisible(operation)) as operation (operation.operationId)}
                {@const rollbackParent = operation.rollbackOfOperationId ? (connection.operations ?? []).find((candidate) => candidate.operationId === operation.rollbackOfOperationId) : null}
                <div class="cms-operation-row">
                  <span><strong>{operation.rollbackOfOperationId ? say("Ripristino compensativo", "Compensating restore") : operation.action === "publish" ? say("Pubblicazione", "Publish") : say("Invio in sviluppo", "Send to development")} · {cmsRemoteOperationStatusText(operation)}</strong><small>{operation.message ?? say("Controlla WordPress prima di inviare di nuovo.", "Check WordPress before sending again.")} · {formatDate(operation.updatedAt)}</small></span>
                  {#if ["pending", "applying", "partial"].includes(operation.state)}<button class="button outline small" disabled={busy} onclick={() => void act(() => checkCmsRemoteOperation(connection, operation))}>{say("Controlla esito", "Check result")}</button>{/if}
                  {#if operation.rollbackRetryAvailable && ["partial", "not-found"].includes(operation.state) && rollbackParent}<button class="button primary small" disabled={busy || !connection.read || !connection.write} onclick={() => void act(() => prepareCmsRemoteRollback(connection, rollbackParent, true))}>{say("Verifica e riprendi", "Verify and resume")}</button>{/if}
                  {#if !operation.rollbackOfOperationId && ["partial", "not-found", "complete-local-changes"].includes(operation.state)}<button class="button primary small" disabled={busy || !connection.write} onclick={() => void act(() => pushCmsProject(connection, operation.action))}>{say("Rivedi nuovo piano", "Review a new plan")}</button>{/if}
                  {#if operation.rollbackOfOperationId && operation.state === "complete-local-changes"}<button class="button primary small" disabled={busy || !connection.write} onclick={() => void act(() => pushCmsProject(connection, operation.action))}>{say("Rivedi nuovo piano", "Review a new plan")}</button>{/if}
                  {#if operation.rollbackAvailable && ["complete", "complete-local-changes"].includes(operation.state)}<button class="button outline small" disabled={busy || !connection.read || !connection.write} onclick={() => void act(() => prepareCmsRemoteRollback(connection, operation))}>{say("Ripristina", "Restore")}</button>{/if}
                </div>
              {/each}
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
{/if}

<style>
  .readiness { display: grid; gap: 6px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .readiness__title { margin: 0; font-size: 15px; }
  .readiness__verdict { margin: 0; }
  .readiness--pronto .readiness__verdict strong { color: var(--mint-ink, #2f6b4f); }
  .readiness--da-guardare .readiness__verdict strong { color: #7a5200; }
  .readiness--non-pronto .readiness__verdict strong { color: #9a3b26; }
  .readiness__sections { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .readiness__section { padding: 4px 0 4px 10px; border-left: 3px solid var(--line); }
  .readiness__section--ok { border-left-color: var(--mint-ink, #2f6b4f); }
  .readiness__section--warning, .readiness__section--unchecked { border-left-color: #b07a00; }
  .readiness__section--error { border-left-color: #9a3b26; }
  .readiness__name { font-weight: 700; }
  .readiness__items { margin: 4px 0 0; }
  .readiness__note { margin: 4px 0 0; color: var(--muted); }
</style>
