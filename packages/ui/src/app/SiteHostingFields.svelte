<script lang="ts">
  import { type Language } from "../lib/i18n.js";
  import type { HostingAuthMethod, HostingProtocol, Site } from "../lib/app-types.js";

  /** Where a site goes by FTP, FTPS or SFTP: the server, the access, its identity. */
  let { language, act, allowInsecureFtp = $bindable(), clearHostingTlsCa, hostingAuthMethod = $bindable(), hostingHost = $bindable(), hostingHostKeyConfirmed = $bindable(), hostingPassphrase = $bindable(), hostingPassword = $bindable(), hostingPort = $bindable(), hostingPrivateKey = $bindable(), hostingProtocol = $bindable(), hostingProtocolChanged, hostingPublicUrl = $bindable(), hostingRemoteDirectory = $bindable(), hostingTlsCaCertificate = $bindable(), hostingTlsCaFilename = $bindable(), hostingUsername = $bindable(), observedHostingHostKeyFingerprint, removeHostingCredentials, selectedSite, onCertificateLoaded }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    allowInsecureFtp: boolean;
    clearHostingTlsCa: () => void;
    hostingAuthMethod: HostingAuthMethod;
    hostingHost: string;
    hostingHostKeyConfirmed: boolean;
    hostingPassphrase: string;
    hostingPassword: string;
    hostingPort: number;
    hostingPrivateKey: string;
    hostingProtocol: HostingProtocol;
    hostingProtocolChanged: () => void;
    hostingPublicUrl: string;
    hostingRemoteDirectory: string;
    hostingTlsCaCertificate: string;
    hostingTlsCaFilename: string;
    hostingUsername: string;
    observedHostingHostKeyFingerprint: string;
    removeHostingCredentials: () => Promise<void>;
    selectedSite: Site;
    onCertificateLoaded: (message: string) => void;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<p class="field-hint">{say("Va bene per hosting condivisi e VPS che accettano file statici. Usa SFTP per un VPS o FTPS per un hosting; FTP non cifra la password. La destinazione riceve solo i file della versione e i file remoti non vengono cancellati.", "Works with shared hosting and VPSs that serve static files. Use SFTP for a VPS or FTPS for hosting; FTP does not encrypt the password. Only the version files are uploaded, and existing remote files are not deleted.")}</p>
<div class="settings-grid">
  <div><label class="field-label" for="hosting-protocol">{say("Protocollo", "Protocol")}</label><select id="hosting-protocol" bind:value={hostingProtocol} onchange={hostingProtocolChanged}><option value="sftp">{say("SFTP (SSH, consigliato per VPS)", "SFTP (SSH, recommended for a VPS)")}</option><option value="ftps">{say("FTPS (consigliato per hosting)", "FTPS (recommended for hosting)")}</option><option value="ftp">{say("FTP (non cifrato)", "FTP (not encrypted)")}</option></select></div>
  <div><label class="field-label" for="hosting-host">Server</label><input id="hosting-host" bind:value={hostingHost} placeholder={hostingProtocol === "sftp" ? say("ssh.esempio.it", "ssh.example.com") : say("ftp.esempio.it", "ftp.example.com")} autocomplete="off" /></div>
  <div><label class="field-label" for="hosting-port">{say("Porta", "Port")}</label><input id="hosting-port" type="number" min="1" max="65535" bind:value={hostingPort} /></div>
  <div><label class="field-label" for="hosting-directory">{say("Cartella del sito sul server", "Site folder on the server")}</label><input id="hosting-directory" bind:value={hostingRemoteDirectory} placeholder="public_html" /></div>
  <div class="wide-field"><label class="field-label" for="hosting-url">{say("Indirizzo pubblico del sito (facoltativo)", "Public address of the site (optional)")}</label><input id="hosting-url" type="url" bind:value={hostingPublicUrl} placeholder={say("https://esempio.it", "https://example.com")} /></div>
  <div><label class="field-label" for="hosting-user">{say("Nome utente", "Username")}</label><input id="hosting-user" bind:value={hostingUsername} autocomplete="username" /></div>
  {#if hostingProtocol === "sftp"}
    <div><label class="field-label" for="hosting-auth-method">{say("Accesso SFTP", "SFTP access")}</label><select id="hosting-auth-method" bind:value={hostingAuthMethod}><option value="password">Password</option><option value="privateKey">{say("Chiave privata SSH", "SSH private key")}</option></select></div>
    {#if hostingAuthMethod === "privateKey"}
      <div class="wide-field"><label class="field-label" for="hosting-private-key">{say("Chiave privata SSH", "SSH private key")}</label><textarea id="hosting-private-key" rows="5" bind:value={hostingPrivateKey} autocomplete="off" spellcheck="false" placeholder={selectedSite.hostingCredentialsConfigured ? say("Già salvata; lascia vuoto per mantenerla", "Saved; leave empty to keep it") : "-----BEGIN OPENSSH PRIVATE KEY-----"}></textarea></div>
      <div class="wide-field"><label class="field-label" for="hosting-passphrase">{say("Passphrase della chiave (se presente)", "Key passphrase (if any)")}</label><input id="hosting-passphrase" type="password" bind:value={hostingPassphrase} autocomplete="new-password" /></div>
    {:else}
      <div><label class="field-label" for="hosting-password">{say("Password SFTP", "SFTP password")}</label><input id="hosting-password" type="password" bind:value={hostingPassword} autocomplete="new-password" placeholder={selectedSite.hostingCredentialsConfigured ? say("Salvata; lascia vuoto per mantenerla", "Saved; leave empty to keep it") : say("Salvata nel portachiavi locale", "Stored in the local keyring")} /></div>
    {/if}
  {:else}
    <div><label class="field-label" for="hosting-password">Password</label><input id="hosting-password" type="password" bind:value={hostingPassword} autocomplete="new-password" placeholder={selectedSite.hostingCredentialsConfigured ? say("Salvata; lascia vuoto per mantenerla", "Saved; leave empty to keep it") : say("Salvata nel portachiavi locale", "Stored in the local keyring")} /></div>
  {/if}
  {#if hostingProtocol === "ftps"}
    <div class="wide-field">
      <label class="field-label" for="hosting-tls-ca">{say("Certificato CA FTPS (facoltativo)", "FTPS CA certificate (optional)")}</label>
      <input id="hosting-tls-ca" type="file" accept=".pem,.crt,.cer,application/x-pem-file" onchange={(event) => void act(async () => {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 65_536) throw new Error(say("Il certificato CA non può superare 64 KiB.", "The CA certificate cannot exceed 64 KiB."));
        hostingTlsCaCertificate = await file.text();
        hostingTlsCaFilename = file.name;
        onCertificateLoaded(say("Certificato caricato; salvalo per verificarlo e usarlo con FTPS.", "Certificate loaded; save to validate and use it with FTPS."));
      })} />
      {#if hostingTlsCaCertificate}
        <p class="field-hint">{hostingTlsCaFilename || say("CA salvata nel progetto", "CA saved in the project")}. {say("La verifica del certificato server resta attiva; il PEM verrà incluso nei backup del progetto.", "Server certificate verification remains enabled; this PEM will be included in project backups.")}</p>
        <button class="button text small" type="button" onclick={clearHostingTlsCa}>{say("Rimuovi CA personalizzata", "Remove custom CA")}</button>
      {:else}
        <p class="field-hint">{say("Usala solo se il provider ti ha fornito una CA privata. Il certificato deve essere PEM valido; non disattiviamo la verifica TLS.", "Use only if your provider supplied a private CA. The certificate must be valid PEM; TLS verification is never disabled.")}</p>
      {/if}
    </div>
  {/if}
</div>
{#if hostingProtocol === "ftp"}<label class="domain-option" for="allow-insecure-ftp"><input id="allow-insecure-ftp" type="checkbox" bind:checked={allowInsecureFtp} /><span>{say("Confermo che il provider non offre FTPS: FTP non cifra nome utente e password.", "I confirm my provider does not offer FTPS: FTP does not encrypt the username or password.")}</span></label>{/if}
{#if hostingProtocol === "sftp"}<p class="field-hint">{say("SFTP usa il client integrato e funziona su Linux, macOS e Windows. Alla prima connessione mostriamo l’impronta SSH: confrontala con quella del provider. Password e chiave privata vengono inviate solo dopo la conferma.", "SFTP uses the built-in client on Linux, macOS, and Windows. On first connection we show the SSH fingerprint: compare it with the one from your provider. The password or private key is sent only after you confirm it.")}</p>{/if}
{#if observedHostingHostKeyFingerprint}<div class="host-key-confirmation"><strong>{say("Controlla l’identità del server", "Verify the server identity")}</strong><code>{observedHostingHostKeyFingerprint}</code><label class="domain-option" for="confirm-host-key"><input id="confirm-host-key" type="checkbox" bind:checked={hostingHostKeyConfirmed} /><span>{say("Ho confrontato questa impronta con quella del pannello del provider o con il supporto ufficiale.", "I compared this fingerprint with the hosting control panel or official support.")}</span></label></div>{/if}
{#if selectedSite.hostingCredentialsConfigured}<div class="wp-actions"><span class="muted">{say("Credenziali presenti nel portachiavi locale", "Credentials stored in the local keyring")}</span><button class="button text small" onclick={() => void act(removeHostingCredentials)}>{say("Rimuovi credenziali", "Remove credentials")}</button></div>{/if}
