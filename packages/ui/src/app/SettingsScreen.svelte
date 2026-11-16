<script lang="ts">
  import CopiesCard from "../CopiesCard.svelte";
  import UpdatesCard from "./UpdatesCard.svelte";
  import { translate, type Language } from "../lib/i18n.js";
  import type { CloudflareAccount, DatabaseConnection, Screen } from "../lib/app-types.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";

  /** The app's settings: appearance, account, token, database connections, data. */
  let { language, act, busy, cancelDatabaseConnectionEdit, cloudflareAccounts, dataDirectoryDisplay, databaseCaCertificate = $bindable(), databaseConnectionName = $bindable(), databaseConnections, databaseHost = $bindable(), databaseName = $bindable(), databasePassword = $bindable(), databasePort = $bindable(), databaseSshAuthMethod = $bindable(), databaseSshHost = $bindable(), databaseSshHostKeyConfirmed = $bindable(), databaseSshHostKeyFingerprint = $bindable(), databaseSshHostKeyIdentity = $bindable(), databaseSshPassphrase = $bindable(), databaseSshPassword = $bindable(), databaseSshPort = $bindable(), databaseSshPrivateKey = $bindable(), databaseSshUsername = $bindable(), databaseTablePrefix = $bindable(), databaseUseSshTunnel = $bindable(), databaseUsername = $bindable(), discoverCloudflareAccounts, downloadErrorLog, editDatabaseConnection, editingDatabaseConnectionId, nav, recheckDatabaseConnection, removeToken, saveDatabaseConnection, saveSettings, setTheme, settingsAccountId = $bindable(), settingsLanguage = $bindable(), settingsTab = $bindable(), settingsToken = $bindable(), settingsTokenState, theme, verifyAndSaveToken, verifyDatabaseSshHostKey, onRemoveDatabase }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cancelDatabaseConnectionEdit: () => void;
    cloudflareAccounts: CloudflareAccount[];
    dataDirectoryDisplay: string;
    databaseCaCertificate: string;
    databaseConnectionName: string;
    databaseConnections: DatabaseConnection[];
    databaseHost: string;
    databaseName: string;
    databasePassword: string;
    databasePort: number;
    databaseSshAuthMethod: "password" | "privateKey";
    databaseSshHost: string;
    databaseSshHostKeyConfirmed: boolean;
    databaseSshHostKeyFingerprint: string;
    databaseSshHostKeyIdentity: string;
    databaseSshPassphrase: string;
    databaseSshPassword: string;
    databaseSshPort: number;
    databaseSshPrivateKey: string;
    databaseSshUsername: string;
    databaseTablePrefix: string;
    databaseUseSshTunnel: boolean;
    databaseUsername: string;
    discoverCloudflareAccounts: () => Promise<void>;
    downloadErrorLog: () => void;
    editDatabaseConnection: (connection: DatabaseConnection) => void;
    editingDatabaseConnectionId: string | null;
    nav: (target: Screen) => void;
    recheckDatabaseConnection: (id: string) => Promise<void>;
    removeToken: () => Promise<void>;
    saveDatabaseConnection: () => Promise<void>;
    saveSettings: () => Promise<void>;
    setTheme: (next: "system" | "light" | "dark") => void;
    settingsAccountId: string;
    settingsLanguage: Language;
    settingsTab: "account" | "database" | "data";
    settingsToken: string;
    settingsTokenState: { configured: boolean; source: string | null; available: boolean } | null;
    theme: "system" | "light" | "dark";
    verifyAndSaveToken: () => Promise<void>;
    verifyDatabaseSshHostKey: () => Promise<void>;
    onRemoveDatabase: (connection: DatabaseConnection) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  const formatDate = (value?: string) => formatDateIn(language, value);
</script>

<section class="page-wrap narrow" data-settings-tab={settingsTab}><div class="page-heading"><div><div class="eyebrow">{t("settings.eyebrow")}</div><h1>{t("settings.title")}</h1><p>{t("settings.subtitle")}</p></div></div>
  <div class="settings-theme" role="group" aria-label={t("settings.theme")}><span class="field-label">{t("settings.theme")}</span>{#each [["system", "settings.themeSystem"], ["light", "settings.themeLight"], ["dark", "settings.themeDark"]] as const as [key, label] (key)}<button class:active={theme === key} aria-pressed={theme === key} onclick={() => setTheme(key)}>{t(label)}</button>{/each}</div>
  <div class="settings-tabs" role="group" aria-label={t("settings.title")}>{#each [["account", t("settings.tabAccount")], ["database", t("db.title")], ["data", t("settings.tabData")]] as const as [key, label] (key)}<button class:active={settingsTab === key} aria-pressed={settingsTab === key} onclick={() => { settingsTab = key; }}>{label}</button>{/each}</div>
  <div class="settings-page-grid"><section class="panel-card settings-account"><div class="section-card-header"><div><div class="eyebrow">ACCOUNT</div><h2>{t("settings.cloudflare")}</h2></div><span class="remote-icon" aria-hidden="true">◈</span></div><label class="field-label" for="settings-account">{t("settings.accountId")}</label><div class="input-action">{#if cloudflareAccounts.length}<select id="settings-account" bind:value={settingsAccountId}><option value="">{say("Scegli un account", "Choose an account")}</option>{#each cloudflareAccounts as account}<option value={account.id}>{account.name} · {account.id}</option>{/each}</select>{:else}<input id="settings-account" bind:value={settingsAccountId} maxlength="32" placeholder={say("32 caratteri esadecimali", "32 hexadecimal characters")} />{/if}<button class="button outline" onclick={() => void act(discoverCloudflareAccounts)} disabled={!settingsTokenState?.configured}>{say("Trova account", "Find account")}</button></div>{#if !cloudflareAccounts.length}<p class="field-hint">{say("Con un token che include Account Settings Read, Histeon trova l’ID per te. Altrimenti puoi inserirlo qui.", "With a token that includes Account Settings Read, Histeon finds the ID for you. Otherwise, enter it here.")}</p>{/if}<label class="field-label" for="settings-language">{t("settings.language")}</label><select id="settings-language" bind:value={settingsLanguage}><option value="it">Italiano</option><option value="en">English</option></select><div class="form-actions"><button class="button primary" onclick={() => void act(saveSettings)}>{t("settings.save")} →</button></div></section>
    <section class="panel-card settings-account"><div class="section-card-header"><div><div class="eyebrow">CREDENZIALI</div><h2>{t("settings.token")}</h2></div><span class="keyring-icon" aria-hidden="true">⌑</span></div><div class="credential-status"><span class="status-light" class:on={settingsTokenState?.configured}></span><span>{settingsTokenState?.source === "environment" ? t("settings.tokenEnv") : settingsTokenState?.available === false ? t("settings.tokenUnavailable") : settingsTokenState?.configured ? t("settings.tokenSet") : t("settings.tokenMissing")}</span></div>{#if settingsTokenState?.source !== "environment"}<label class="field-label" for="api-token">{t("settings.token")}</label><input id="api-token" type="password" autocomplete="new-password" bind:value={settingsToken} placeholder={t("settings.tokenPlaceholder")} /><div class="form-actions"><button class="button outline" onclick={() => void act(removeToken)} disabled={!settingsTokenState?.configured}>{t("settings.remove")}</button><button class="button dark" onclick={() => void act(verifyAndSaveToken)} disabled={!settingsToken.trim()}>{t("settings.verifySave")} →</button></div>{/if}</section>
    <section class="panel-card database-settings-card">
      <div class="section-card-header"><div><div class="eyebrow">CONNESSIONI</div><h2>{t("db.title")}</h2></div><span class="keyring-icon" aria-hidden="true">⌑</span></div>
      <p class="field-hint">{t("db.intro")}</p>
      <div class="settings-grid">
        <div><label class="field-label" for="database-connection-name">{t("db.name")}</label><input id="database-connection-name" bind:value={databaseConnectionName} maxlength="120" autocomplete="off" /></div>
        <div><label class="field-label" for="database-host">{t("db.host")}</label><input id="database-host" bind:value={databaseHost} autocomplete="off" placeholder="db.example.it" /></div>
        <div><label class="field-label" for="database-port">{t("db.port")}</label><input id="database-port" type="number" min="1" max="65535" bind:value={databasePort} /></div>
        <div><label class="field-label" for="database-schema">{t("db.database")}</label><input id="database-schema" bind:value={databaseName} autocomplete="off" /></div>
        <div><label class="field-label" for="database-prefix">{t("db.prefix")}</label><input id="database-prefix" bind:value={databaseTablePrefix} maxlength="32" autocomplete="off" placeholder="wp_" /></div>
        <div><label class="field-label" for="database-user">{t("db.user")}</label><input id="database-user" bind:value={databaseUsername} autocomplete="username" /></div>
        <div><label class="field-label" for="database-password">{t("db.password")}</label><input id="database-password" type="password" bind:value={databasePassword} autocomplete="new-password" /></div>
        {#if editingDatabaseConnectionId}<p class="wide-field muted database-credentials-hint">{say("Per aggiornare il profilo, inserisci di nuovo utente e password. Il portachiavi non restituisce i valori salvati.", "To update this profile, enter the username and password again. The keyring never returns saved values.")}</p>{/if}
        <div class="wide-field"><label class="field-label" for="database-ca">{t("db.ca")}</label><textarea id="database-ca" rows="4" bind:value={databaseCaCertificate} autocomplete="off" spellcheck="false"></textarea><p class="muted">{t("db.caHint")}</p></div>
        <div class="wide-field database-ssh-toggle"><label><input id="database-ssh-enabled" type="checkbox" bind:checked={databaseUseSshTunnel} /> {say("Raggiungi il database tramite un tunnel SSH", "Reach the database through an SSH tunnel")}</label><p class="muted">{say("Usalo se il database è accessibile dal server SSH ma non direttamente dal computer. Il tunnel verifica solo questo collegamento: per installare WordPress anche PHP sull’hosting deve poter raggiungere il database.", "Use this if the database is reachable from the SSH server but not directly from this computer. The tunnel checks only this connection: PHP on the hosting server must also reach the database to install WordPress.")}</p></div>
        {#if databaseUseSshTunnel}
          <div class="wide-field settings-grid database-ssh-fields">
            <div><label class="field-label" for="database-ssh-host">{say("Host SSH", "SSH host")}</label><input id="database-ssh-host" bind:value={databaseSshHost} autocomplete="off" placeholder="ssh.example.it" oninput={() => { databaseSshHostKeyFingerprint = ""; databaseSshHostKeyIdentity = ""; databaseSshHostKeyConfirmed = false; }} /></div>
            <div><label class="field-label" for="database-ssh-port">{say("Porta SSH", "SSH port")}</label><input id="database-ssh-port" type="number" min="1" max="65535" bind:value={databaseSshPort} oninput={() => { databaseSshHostKeyFingerprint = ""; databaseSshHostKeyIdentity = ""; databaseSshHostKeyConfirmed = false; }} /></div>
            <div><label class="field-label" for="database-ssh-user">{say("Utente SSH", "SSH username")}</label><input id="database-ssh-user" bind:value={databaseSshUsername} autocomplete="username" /></div>
            <div><label class="field-label" for="database-ssh-auth">{say("Autenticazione SSH", "SSH authentication")}</label><select id="database-ssh-auth" bind:value={databaseSshAuthMethod}><option value="password">{say("Password", "Password")}</option><option value="privateKey">{say("Chiave privata", "Private key")}</option></select></div>
            {#if databaseSshAuthMethod === "password"}
              <div class="wide-field"><label class="field-label" for="database-ssh-password">{say("Password SSH", "SSH password")}</label><input id="database-ssh-password" type="password" bind:value={databaseSshPassword} autocomplete="new-password" /></div>
            {:else}
              <div class="wide-field"><label class="field-label" for="database-ssh-key">{say("Chiave privata SSH", "SSH private key")}</label><textarea id="database-ssh-key" rows="5" bind:value={databaseSshPrivateKey} autocomplete="off" spellcheck="false"></textarea></div>
              <div class="wide-field"><label class="field-label" for="database-ssh-passphrase">{say("Passphrase della chiave, se presente", "Key passphrase, if set")}</label><input id="database-ssh-passphrase" type="password" bind:value={databaseSshPassphrase} autocomplete="new-password" /></div>
            {/if}
            <div class="wide-field"><button class="button outline small" type="button" onclick={() => void act(verifyDatabaseSshHostKey)} disabled={busy || !databaseSshHost.trim()}>{say("Rileva la chiave host", "Read host key")} →</button>
              {#if databaseSshHostKeyFingerprint}<label class="field-label database-ssh-fingerprint-confirm"><input type="checkbox" bind:checked={databaseSshHostKeyConfirmed} disabled={databaseSshHostKeyIdentity !== `${databaseSshHost.trim().toLowerCase()}:${databaseSshPort}`} /> {say("Confermo che l’impronta del server SSH è corretta:", "I confirm this SSH server fingerprint is correct:")} <code>{databaseSshHostKeyFingerprint}</code></label>{/if}
            </div>
          </div>
        {/if}
      </div>
      <div class="form-actions">{#if editingDatabaseConnectionId}<button class="button outline" onclick={cancelDatabaseConnectionEdit} disabled={busy}>{t("db.cancelEdit")}</button>{/if}<button class="button primary" onclick={() => void act(saveDatabaseConnection)} disabled={busy || !databaseConnectionName.trim() || !databaseHost.trim() || !databaseName.trim() || !databaseTablePrefix.trim() || !databaseUsername.trim() || !databasePassword || databaseUseSshTunnel && (!databaseSshUsername.trim() || !databaseSshHostKeyConfirmed || databaseSshHostKeyIdentity !== `${databaseSshHost.trim().toLowerCase()}:${databaseSshPort}` || databaseSshAuthMethod === "password" && !databaseSshPassword || databaseSshAuthMethod === "privateKey" && !databaseSshPrivateKey.trim())}>{editingDatabaseConnectionId ? t("db.update") : t("db.verifySave")} →</button></div>
      <p class="muted database-readonly-note">{t("db.readOnly")}</p>
      <div class="database-connection-list">
        {#each databaseConnections as connection (connection.id)}
          <article class="database-connection-row">
            <div class="database-connection-heading"><div><strong>{connection.name}</strong><small>{connection.host}:{connection.port} · {connection.databaseName} · {connection.tablePrefix}</small>{#if connection.sshTunnel}<small>{say("Tunnel SSH", "SSH tunnel")}: {connection.sshTunnel.username}@{connection.sshTunnel.host}:{connection.sshTunnel.port} · {connection.sshTunnel.hostKeyFingerprint}</small>{/if}</div><span class="status-chip ready">{connection.engine === "mariadb" ? "MariaDB" : connection.engine === "mysql" ? "MySQL" : connection.engine}</span></div>
            <div class="database-connection-stats"><span><b>{t("db.version")}</b>{connection.serverVersion}</span><span><b>{t("db.tables")}</b>{connection.tableCount}</span><span><b>{t("db.prefixed")}</b>{connection.prefixTableCount}</span><span><b>{t("db.lastCheck")}</b>{formatDate(connection.checkedAt)}</span></div>
            <p class="database-privilege-status" class:verified={connection.privilegesVerified && connection.missingPrivileges.length === 0} class:incomplete={!connection.privilegesVerified || connection.missingPrivileges.length > 0}>{connection.privilegesVerified ? connection.missingPrivileges.length ? say(`Permessi per WordPress mancanti: ${connection.missingPrivileges.join(", ")}.`, `Missing WordPress privileges: ${connection.missingPrivileges.join(", ")}.`) : say("Permessi richiesti per l’installazione WordPress verificati.", "Required WordPress installation privileges verified.") : say("Il database risponde, ma il provider non consente di verificare i permessi d’installazione.", "The database responds, but this provider does not allow installation privileges to be verified.")}</p>
            {#if connection.tableCount > 0}<p class="database-existing-tables">{say("Il database contiene già tabelle. La verifica non ne modifica nessuna.", "The database already contains tables. This check does not change them.")}</p>{/if}
            <div class="wp-actions"><button class="button text small" onclick={() => editDatabaseConnection(connection)} disabled={busy}>{t("db.edit")}</button><button class="button text small" onclick={() => void act(() => recheckDatabaseConnection(connection.id))} disabled={busy}>{t("db.recheck")}</button><button class="button text small" onclick={() => onRemoveDatabase(connection)} disabled={busy}>{t("db.remove")}</button></div>
          </article>
        {:else}
          <p class="empty-note">{t("db.empty")}</p>
        {/each}
      </div>
    </section>
    <section class="panel-card settings-data"><div class="section-card-header"><div><div class="eyebrow">ARCHIVIO</div><h2>{t("settings.data")}</h2></div><span class="storage-icon" aria-hidden="true">⌂</span></div><code class="path-display">{dataDirectoryDisplay || "—"}</code><p class="muted">{t("settings.dataHint")}</p></section>
    <CopiesCard {language} />
          <section class="panel-card settings-data"><h2>{t("settings.log")}</h2><p class="muted">{t("settings.logHint")}</p><button class="button outline small" onclick={downloadErrorLog} data-testid="settings-log">{t("settings.logDownload")}</button></section>
    <UpdatesCard {language} />
    <section class="panel-card privacy-card settings-data"><div class="section-card-header"><div><div class="eyebrow">{say("PRIVACY", "PRIVACY")}</div><h2>{t("settings.privacy")}</h2></div><span class="privacy-icon" aria-hidden="true">◉</span></div><p>{t("settings.privacyBody")}</p><ul><li>{say("Token e password nel portachiavi del sistema.", "Tokens and passwords stay in the system keyring.")}</li><li>{say("Connessione al server consentita solo dal computer locale.", "The server accepts local connections only.")}</li><li>{say("Nessuna telemetria o sincronizzazione automatica.", "No telemetry or automatic synchronization.")}</li></ul></section>
    <section class="panel-card agent-pointer-card settings-data"><div class="section-card-header"><div><div class="eyebrow">{t("connector.eyebrow")}</div><h2>{t("agent.title")}</h2></div><span class="agent-pointer-mark" aria-hidden="true">✦</span></div><p class="muted">{t("agent.settingsBody")}</p><div class="form-actions"><button class="button outline" data-testid="settings-open-agent" onclick={() => nav("agent")}>{t("agent.settingsOpen")}</button></div></section></div>
</section>
