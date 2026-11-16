<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsProjectDetails, Screen, SourceKind, UploadEntry } from "../lib/app-types.js";
  import { formatBytes as formatBytesIn } from "../lib/app-format.js";
  import NewSiteDesign from "./NewSiteDesign.svelte";

  /** A new site: from scratch, a starter, WordPress, an address or local files. */
  let { language, accountId = $bindable(), act, basicPassword = $bindable(), basicUser = $bindable(), busy, cmsProjectName = $bindable(), cmsWordPressSetupSiteId, consentLocalOrigin, consentOrigin, cookie = $bindable(), createCmsProject, createFromStarter, detectSite, detection, filesFromInput, handleDrop, importNewSiteDesign, importNewSitePrototype, importProgress, importWordPressFile, localImportNotice = $bindable(), nav, newSiteDesign = $bindable(), newSitePrototype = $bindable(), saveNewSite, selectFiles, selectedCmsProject, selectedFiles = $bindable(), showCmsConnectionImport, siteName = $bindable(), sourceToSave, urlInput = $bindable(), wordPressAddress = $bindable(), workerName = $bindable(), onBackToProject }: {
    language: Language;
    accountId: string;
    act: (task: () => Promise<void>) => Promise<void>;
    basicPassword: string;
    basicUser: string;
    busy: boolean;
    cmsProjectName: string;
    cmsWordPressSetupSiteId: string;
    consentLocalOrigin: boolean;
    consentOrigin: string;
    cookie: string;
    createCmsProject: () => Promise<void>;
    createFromStarter: (starter: "rivista" | "negozio", settings?: { name: string; locale: string }) => Promise<void>;
    detectSite: (authorized?: boolean) => Promise<void>;
    detection: Record<string, unknown> | null;
    filesFromInput: (event: Event, kind: "directory" | "html" | "zip") => void;
    handleDrop: (event: DragEvent) => Promise<void>;
    importNewSiteDesign: (prototype: File) => Promise<void>;
    importNewSitePrototype: () => Promise<void>;
    importProgress: number;
    importWordPressFile: (file: File | string) => Promise<void>;
    localImportNotice: string;
    nav: (target: Screen) => void;
    newSiteDesign: File | null;
    newSitePrototype: File | null;
    saveNewSite: () => Promise<void>;
    selectFiles: (kind: "directory" | "html" | "zip") => void;
    selectedCmsProject: CmsProjectDetails | null;
    selectedFiles: UploadEntry[];
    showCmsConnectionImport: () => void;
    siteName: string;
    sourceToSave: { kind: SourceKind; path: string } | null;
    urlInput: string;
    wordPressAddress: string;
    workerName: string;
    onBackToProject: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);
</script>

<section class="page-wrap narrow">
  <button class="back-link" onclick={() => cmsWordPressSetupSiteId && selectedCmsProject ? onBackToProject() : nav("home")}>← {cmsWordPressSetupSiteId && selectedCmsProject ? say("Torna al progetto CMS", "Back to the CMS project") : t("new.back")}</button>
  <div class="page-heading compact"><div><div class="eyebrow">{t("new.eyebrow")}</div><h1>{t("new.title")}</h1><p>{t("new.subtitle")}</p></div></div>
  <div class="new-ways">
    <form class="panel-card cms-new-project" onsubmit={(event) => { event.preventDefault(); void act(createCmsProject); }}>
        <h2>{t("new.fromScratch")}</h2><p class="muted">{t("new.fromScratchHint")}</p>
        <div class="input-action"><input bind:value={cmsProjectName} maxlength="120" placeholder={t("cms.projectName")} aria-label={t("cms.projectName")} required /><button class="button primary" type="submit" disabled={busy}>{t("cms.createProject")}</button></div>
      </form>
    <section class="panel-card new-way-starters"><h2>{t("new.fromStarter")}</h2><p class="muted">{t("new.fromStarterHint")}</p><div class="admin-actions">{#each [["rivista", "new.starterMagazine"], ["negozio", "new.starterShop"]] as const as [key, label] (key)}<button class="button outline" disabled={busy} onclick={() => void act(() => createFromStarter(key))} data-testid="new-starter-{key}">{t(label)}</button>{/each}</div></section>
    <section class="panel-card new-way-wp"><h2>{t("new.fromWordPress")}</h2><p class="muted">{t("new.wpFileHint")}</p><div class="admin-actions"><button class="button primary" onclick={() => document.getElementById("wordpress-export-file")?.click()} disabled={busy} data-testid="new-wordpress-file">{t("new.wpFile")}</button><button class="button text" onclick={() => { nav("home"); showCmsConnectionImport(); }}>{t("new.wpLinked")}</button></div><form class="input-action new-way-address" onsubmit={(event) => { event.preventDefault(); const address = wordPressAddress; void act(() => importWordPressFile(address)); }}><input bind:value={wordPressAddress} aria-label={t("new.wpAddress")} placeholder={t("new.wpAddress")} data-testid="new-wordpress-address" /><button class="button outline small" disabled={busy || !wordPressAddress.trim()}>{t("new.wpAddressGo")}</button></form><input id="wordpress-export-file" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".xml,text/xml,application/xml" onchange={(event) => { const picked = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (picked) void act(() => importWordPressFile(picked)); }} /></section>
    <NewSiteDesign {language} {act} {busy} bind:file={newSiteDesign} onPrototype={importNewSiteDesign} />
  </div>
  {#if localImportNotice}<div class="integration-note" role="status"><span>↗</span><p>{localImportNotice}</p><button class="icon-button" aria-label={t("common.close")} onclick={() => localImportNotice = ""}>×</button></div>{/if}
  <div class="wizard-grid">
    <section class="wizard-main">
      <form class="panel-card" onsubmit={(event) => { event.preventDefault(); void act(() => detectSite()); }}>
        <div class="panel-head"><span class="step-number">01</span><div><h2>{say("Da un indirizzo web", "From a web address")}</h2><p>{say("Individuiamo le tecnologie prima di scaricare le pagine.", "We identify the technologies before downloading pages.")}</p></div></div>
        <label class="field-label" for="source-url">{t("new.urlLabel")}</label>
        <div class="input-action"><input id="source-url" type="text" placeholder={t("new.urlPlaceholder")} bind:value={urlInput} required /><button class="button dark" type="submit" disabled={busy}>{t("new.detect")} <span>→</span></button></div>
        {#if consentOrigin}
          <div class="consent-card"><span class="consent-lock">⌑</span><div><h3>{consentLocalOrigin ? say("Autorizzazione per sorgente locale", "Authorize local source") : t("new.consentTitle")}</h3><p>{consentLocalOrigin ? say(`Histeon leggerà l’origine locale o privata ${consentOrigin}. L’accesso resta limitato a questa origine; le altre destinazioni private continuano a essere bloccate. I file verranno inviati a Cloudflare solo quando avvierai la pubblicazione.`, `Histeon will read the local or private origin ${consentOrigin}. Access stays limited to this origin; other private destinations remain blocked. Files are sent to Cloudflare only when you start publishing.`) : t("new.consentBody", { origin: consentOrigin })}</p><button class="button primary" type="button" disabled={busy} onclick={() => void act(() => detectSite(true))}>{consentLocalOrigin ? say("Autorizza questo sito", "Authorize this site") : t("new.authorize")} →</button></div></div>
        {/if}
        {#if detection && !consentOrigin && detection.detection}
          {@const found = detection.detection as Record<string, unknown>}
          <div class="detection-card"><div class="detection-head"><span class="detection-check">✓</span><div><strong>{t("new.detected")}</strong><small>{String(found.engine ?? "generic") === "wordpress" ? t("new.wordpress") : t("new.generic")}</small></div></div><div class="signal-tags">{#if (found.integrations as Record<string, unknown> | undefined)?.histos}<span class="signal-tag coral">{t("new.histos")}</span>{/if}{#if (found.integrations as Record<string, unknown> | undefined)?.staticBridge}<span class="signal-tag">{t("new.bridge")}</span>{/if}{#each (found.technologies as string[] | undefined) ?? [] as technology}<span class="signal-tag">{technology}</span>{/each}</div><p class="signal-caption">{t("new.signals")}: {((found.wordpressSignals as string[] | undefined) ?? []).join(" · ") || t("new.none")}</p></div>
        {/if}
      </form>

      <section class="panel-card local-picker">
        <div class="panel-head"><span class="step-number">02</span><div><h2>{t("new.localTitle")}</h2><p>{say("Scegli una cartella completa oppure un singolo file.", "Choose a complete folder or a single file.")}</p></div></div>
        <div class="picker-actions"><button class="button outline" onclick={() => selectFiles("directory")}>▣ {t("new.folder")}</button><button class="button outline" onclick={() => selectFiles("html")}>▤ {t("new.html")}</button><button class="button outline" onclick={() => selectFiles("zip")}>▧ {t("new.zip")}</button></div>
        <input id="file-directory" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" webkitdirectory multiple onchange={(event) => filesFromInput(event, "directory")} />
        <input id="file-html" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" onchange={(event) => filesFromInput(event, "html")} />
        <input id="file-zip" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".zip,application/zip" onchange={(event) => filesFromInput(event, "zip")} />
        <div class="drop-zone" role="region" aria-label={t("new.drop")} ondragover={(event) => event.preventDefault()} ondrop={(event) => void handleDrop(event)}><span class="drop-icon" aria-hidden="true">⇧</span><strong>{t("new.drop")}</strong><small>{t("new.dropHint")}</small></div>
        {#if newSitePrototype}
          <div class="integration-note new-site-prototype" role="status" data-testid="new-site-prototype"><span aria-hidden="true">▦</span><p>{t("new.prototypeNotice")}</p><button class="button primary small" type="button" onclick={() => void act(importNewSitePrototype)} disabled={busy}>{t("new.prototypeImport")}</button></div>
        {/if}
        {#if selectedFiles.length}<div class="selection-summary"><span class="selection-icon">✓</span><span><strong>{selectedFiles.length} {t("common.files")}</strong><small>{formatBytes(selectedFiles.reduce((sum, entry) => sum + entry.file.size, 0))}</small></span><button class="icon-button" aria-label={say("Rimuovi selezione", "Remove selection")} onclick={() => { selectedFiles = []; newSitePrototype = null; }}>×</button></div>{/if}
      </section>
    </section>

    <aside class="wizard-side">
      <section class="panel-card site-details-form">
        <div class="side-card-title"><span>↗</span><div><h2>{say("Dettagli del sito", "Site details")}</h2><small>{say("Puoi modificarli anche più avanti.", "You can change these later.")}</small></div></div>
        <label class="field-label" for="site-name">{t("new.siteName")}</label><input id="site-name" bind:value={siteName} maxlength="80" placeholder={t("new.siteNamePlaceholder")} />
        <label class="field-label" for="worker-name">{t("new.workerName")}</label><input id="worker-name" bind:value={workerName} maxlength="63" placeholder={t("new.workerNamePlaceholder")} />
        <label class="field-label" for="cloudflare-account">{t("new.account")}</label><input id="cloudflare-account" bind:value={accountId} maxlength="32" placeholder={t("new.accountPlaceholder")} /><small class="field-hint">{t("new.accountHint")}</small>
        <p class="field-hint">{say("Il dominio si collega dalla schermata del sito, dopo averlo creato.", "You can connect a domain from the site screen after creating it.")}</p>
      </section>
      {#if sourceToSave?.kind === "url"}<details class="panel-card credentials-details">
        <summary><span class="credentials-mark">⌑</span><span><strong>{t("new.credentials")}</strong><small>{t("new.credentialsHint")}</small></span><span class="summary-chevron" aria-hidden="true">＋</span></summary>
        <label class="field-label" for="basic-user">{t("new.user")}</label><input id="basic-user" autocomplete="username" bind:value={basicUser} />
        <label class="field-label" for="basic-password">{t("new.password")}</label><input id="basic-password" type="password" autocomplete="new-password" bind:value={basicPassword} />
        <label class="field-label" for="session-cookie">{t("new.cookie")}</label><input id="session-cookie" type="password" autocomplete="off" bind:value={cookie} />
      </details>{/if}
      <button class="button primary full" data-testid="new-site-save" disabled={busy || !siteName.trim() || (!sourceToSave && selectedFiles.length === 0)} onclick={() => void act(saveNewSite)}>{busy && selectedFiles.length ? `${t("new.upload")} ${importProgress}/${selectedFiles.length}` : t("new.save")} <span>→</span></button>
      {#if selectedFiles.length}<div class="upload-bar" aria-label={`${importProgress} ${t("new.uploadProgress")}`}><span style={`width:${selectedFiles.length ? (importProgress / selectedFiles.length) * 100 : 0}%`}></span></div>{/if}
      <p class="privacy-hint"><span aria-hidden="true">◉</span> {say("I file vengono letti e salvati solo in questa cartella locale.", "Files are read and saved only in this local data folder.")}</p>
    </aside>
  </div>
</section>
