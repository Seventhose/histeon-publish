import { HistosPublishError } from "./errors.js";
import { constants as fsConstants } from "node:fs";
import { open, lstat } from "node:fs/promises";

export const CLOUDFLARE_TOKEN_ENV = "HISTOS_CLOUDFLARE_API_TOKEN";
const KEYRING_SERVICE = "histos-publish";
const KEYRING_ACCOUNT = "cloudflare-api-token";

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

export type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;

async function getEntryConstructor(): Promise<KeyringEntryConstructor> {
  try {
    const module = await import("@napi-rs/keyring");
    return module.Entry as KeyringEntryConstructor;
  } catch {
    throw new HistosPublishError("Portachiavi di sistema non disponibile. Avvia o sblocca Secret Service/KWallet, oppure usa HISTOS_CLOUDFLARE_API_TOKEN.", "secret-store-unavailable", 4);
  }
}

export class SystemKeyringSecretStore {
  constructor(
    private readonly entryConstructor?: KeyringEntryConstructor,
    private readonly service = KEYRING_SERVICE,
    private readonly account = KEYRING_ACCOUNT,
  ) {}

  private async entry(): Promise<KeyringEntry> {
    const Entry = this.entryConstructor ?? await getEntryConstructor();
    try {
      return new Entry(this.service, this.account);
    } catch {
      throw new HistosPublishError("Non riesco ad accedere al portachiavi di sistema. Sbloccalo o usa HISTOS_CLOUDFLARE_API_TOKEN.", "secret-store-unavailable", 4);
    }
  }

  async get(): Promise<string | null> {
    try { return await (await this.entry()).getPassword(); }
    catch (error) {
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError("Non riesco a leggere il token dal portachiavi di sistema.", "secret-store-unavailable", 4);
    }
  }

  async set(value: string): Promise<void> {
    try { (await this.entry()).setPassword(value); }
    catch (error) {
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError("Non riesco a salvare il token nel portachiavi di sistema.", "secret-store-unavailable", 4);
    }
  }

  async delete(): Promise<void> {
    try { (await this.entry()).deletePassword(); }
    catch (error) {
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError("Non riesco a rimuovere il token dal portachiavi di sistema.", "secret-store-unavailable", 4);
    }
  }
}

export async function readCloudflareToken(store = new SystemKeyringSecretStore(), env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; source: "environment" | "keyring" }> {
  const environmentToken = env[CLOUDFLARE_TOKEN_ENV]?.trim();
  if (environmentToken) return { token: environmentToken, source: "environment" };
  const token = await store.get();
  if (!token) throw new HistosPublishError("Token Cloudflare assente. Esegui `histos-publish login` oppure imposta HISTOS_CLOUDFLARE_API_TOKEN.", "cloudflare-auth-missing", 4);
  return { token, source: "keyring" };
}

export async function readSecretFile(secretPath: string, label: string): Promise<string> {
  if (process.platform !== "linux") {
    throw new HistosPublishError("L’agente di pubblicazione è supportato solo su Linux.", "agent-platform-unsupported", 2);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(secretPath);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("not-regular");
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(secretPath, flags);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not-regular");
    const mode = info.mode & 0o777;
    const ownPrivate = typeof process.getuid === "function" && info.uid === process.getuid() && (mode === 0o400 || mode === 0o600);
    const systemdCredential = typeof process.getgid === "function" && info.uid === 0 && info.gid === process.getgid() && mode === 0o440;
    if (!ownPrivate && !systemdCredential) throw new Error("permissions");
    if (info.size > 4096) throw new Error("too-large");
    const bytes = await handle.readFile();
    if (bytes.byteLength > 4096) throw new Error("too-large");
    let value = bytes.toString("utf8");
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if (!value) throw new Error("empty");
    return value;
  } catch {
    throw new HistosPublishError("Il file del segreto " + label + " non è valido o non ha proprietario e permessi sicuri.", "agent-secret-file-invalid", 4);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readAgentCloudflareToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const tokenFile = env.HISTOS_CLOUDFLARE_API_TOKEN_FILE;
  const tokenValue = env[CLOUDFLARE_TOKEN_ENV];
  if (tokenFile !== undefined && tokenValue !== undefined) {
    throw new HistosPublishError("Imposta HISTOS_CLOUDFLARE_API_TOKEN_FILE oppure HISTOS_CLOUDFLARE_API_TOKEN, non entrambi.", "agent-secret-ambiguous", 4);
  }
  if (tokenFile !== undefined && tokenFile.length > 0) return readSecretFile(tokenFile, "Cloudflare");
  if (tokenValue && tokenValue.trim() === tokenValue && tokenValue.length <= 4096) return tokenValue;
  throw new HistosPublishError("Token Cloudflare dell’agente assente o non valido. Configura HISTOS_CLOUDFLARE_API_TOKEN_FILE o HISTOS_CLOUDFLARE_API_TOKEN.", "agent-secret-missing", 4);
}
