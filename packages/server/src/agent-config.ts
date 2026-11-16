import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv";
import { HistosPublishError, readAgentCloudflareToken, readSecretFile } from "@histos-publish/core";

export interface AgentConfig {
  schemaVersion: 1;
  listen: { host: string; port: number; allInterfaces: boolean; allowedHosts: string[] };
  dataDir: string;
  site: {
    name: string; origin: string; privateNetwork: boolean;
    crawl: { concurrency: number; delayMs: number; timeoutMs: number; maxPages: number; maxDepth: number; maxBytes: number; includeFeeds: boolean };
    rewrite: { externalAssets: string[] }; pagefind: boolean;
    forms?: { wordpress: { restUrl: string; fluentFormIds: number[]; turnstileSiteKey: string } };
  };
  cloudflare: { accountId: string; script: string; maxFiles: number };
  limits: { publishPerHour: number; requestsPerMinute: number };
  retention: { jobsDays: number; keepBundles: number };
}

export interface AgentKey { id: string; secret: string; bytes: Buffer }
export interface AgentSecrets { cloudflareToken: string; turnstileSecret?: string; keys: AgentKey[]; redact: string[] }

export const AGENT_CONFIG_SCHEMA: AnySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object", additionalProperties: false, required: ["schemaVersion", "dataDir", "site", "cloudflare"],
  properties: {
    schemaVersion: { const: 1 },
    dataDir: { type: "string", minLength: 1, pattern: "^/" },
    listen: { type: "object", additionalProperties: false, properties: {
      host: { type: "string", default: "127.0.0.1" }, port: { type: "integer", minimum: 1024, maximum: 65535, default: 8787 },
      allInterfaces: { type: "boolean", default: false },
      allowedHosts: {
        type: "array", minItems: 1, maxItems: 8, uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 255, pattern: "^(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+):[0-9]{1,5}$" },
      },
    } },
    site: { type: "object", additionalProperties: false, required: ["name", "origin"], properties: {
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }, origin: { type: "string", minLength: 8, maxLength: 2048 },
      privateNetwork: { type: "boolean", default: false },
      crawl: { type: "object", additionalProperties: false, properties: {
        concurrency: { type: "integer", minimum: 1, maximum: 8, default: 4 }, delayMs: { type: "integer", minimum: 0, maximum: 30000, default: 50 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 60000 }, maxPages: { type: "integer", minimum: 1, maximum: 20000, default: 5000 },
        maxDepth: { type: "integer", minimum: 0, maximum: 20, default: 12 }, maxBytes: { type: "integer", minimum: 1, maximum: 1073741824, default: 536870912 },
        includeFeeds: { type: "boolean", default: false },
      } },
      rewrite: { type: "object", additionalProperties: false, properties: {
        externalAssets: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4096 }, default: [] },
      } },
      pagefind: { type: "boolean", default: false },
      forms: { type: "object", additionalProperties: false, required: ["wordpress"], properties: {
        wordpress: { type: "object", additionalProperties: false, required: ["restUrl", "fluentFormIds", "turnstileSiteKey"], properties: {
          restUrl: { type: "string", minLength: 12, maxLength: 2048 },
          fluentFormIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 2147483647 } },
          turnstileSiteKey: { type: "string", minLength: 1, maxLength: 200 },
        } },
      } },
    } },
    cloudflare: { type: "object", additionalProperties: false, required: ["accountId", "script"], properties: {
      accountId: { type: "string", pattern: "^[0-9a-f]{32}$" }, script: { type: "string", pattern: "^[a-z0-9-]{1,63}$" },
      maxFiles: { type: "integer", minimum: 1, maximum: 100000, default: 20000 },
    } },
    limits: { type: "object", additionalProperties: false, properties: {
      publishPerHour: { type: "integer", minimum: 1, maximum: 600, default: 30 },
      requestsPerMinute: { type: "integer", minimum: 10, maximum: 6000, default: 120 },
    } },
    retention: { type: "object", additionalProperties: false, properties: {
      jobsDays: { type: "integer", minimum: 1, maximum: 3650, default: 90 },
      keepBundles: { type: "integer", minimum: 0, maximum: 5, default: 1 },
    } },
  },
};

const validateConfig = new Ajv({ allErrors: true, strict: true, useDefaults: true }).compile<AgentConfig>(AGENT_CONFIG_SCHEMA);

function isLoopback(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" || (isIP(value) === 4 && value.startsWith("127."));
}

function isPrivateAddress(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isIP(value) === 4) {
    const parts = value.split(".").map(Number);
    const first = parts[0] ?? 0, second = parts[1] ?? 0;
    return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  if (isIP(value) === 6) return value === "::1" || /^(?:fc|fd)/iu.test(value);
  return false;
}

function isAllowedHostHeader(value: string): boolean {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):([0-9]{1,5})$/iu.exec(value);
  if (!match?.[1] || !match[2]) return false;
  const hostname = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
  const validHostname = match[1].startsWith("[")
    ? isIP(hostname) === 6
    : isIP(hostname) > 0 || (hostname.length <= 253 && hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)));
  const port = Number(match[2]);
  return validHostname && port >= 1 && port <= 65535;
}

function validateSemantics(config: AgentConfig): AgentConfig {
  const host = config.listen.host;
  const allInterfacesHost = host === "0.0.0.0" || host === "::";
  if (isIP(host) === 0) throw new HistosPublishError("listen.host deve essere un indirizzo IP letterale.", "agent-config-invalid", 2);
  if (allInterfacesHost && !config.listen.allInterfaces) throw new HistosPublishError("Per ascoltare su tutte le interfacce imposta listen.allInterfaces: true.", "agent-config-invalid", 2);
  if (!allInterfacesHost && !isLoopback(host) && !isPrivateAddress(host)) throw new HistosPublishError("listen.host deve essere loopback o un indirizzo di rete privata.", "agent-config-invalid", 2);
  if (!path.isAbsolute(config.dataDir)) throw new HistosPublishError("dataDir deve essere un percorso assoluto.", "agent-config-invalid", 2);
  if (!config.listen.allowedHosts?.length) config.listen.allowedHosts = [(host.includes(":") ? "[" + host + "]" : host) + ":" + config.listen.port];
  if (config.listen.allowedHosts.some((value) => value.length > 255 || !isAllowedHostHeader(value))) {
    throw new HistosPublishError("listen.allowedHosts contiene un valore host:porta non valido.", "agent-config-invalid", 2);
  }
  let origin: URL;
  try { origin = new URL(config.site.origin); } catch { throw new HistosPublishError("site.origin non è un URL valido.", "agent-config-invalid", 2); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || (origin.pathname !== "/" && origin.pathname !== "") || origin.search || origin.hash) {
    throw new HistosPublishError("site.origin deve contenere solo schema, host e porta, senza credenziali o percorso.", "agent-config-invalid", 2);
  }
  if (origin.protocol === "http:" && !isLoopback(origin.hostname) && !config.site.privateNetwork) {
    throw new HistosPublishError("Un’origine HTTP non cifrata richiede loopback o site.privateNetwork: true.", "agent-config-invalid", 2);
  }
  config.site.origin = origin.origin;
  return config;
}

export async function readAgentConfig(configPath: string): Promise<AgentConfig> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(configPath);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 64 * 1024) throw new Error("file");
    handle = await open(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o022) !== 0) throw new Error("permissions");
    const parsed: unknown = JSON.parse((await handle.readFile()).toString("utf8"));
    if (!validateConfig(parsed)) {
      const details = (validateConfig.errors ?? []).map((item) => item.instancePath || "/").join(", ");
      throw new HistosPublishError("Configurazione agente non valida nei campi: " + (details || "JSON"), "agent-config-invalid", 2);
    }
    const config = parsed as AgentConfig;
    config.listen ??= { host: "127.0.0.1", port: 8787, allInterfaces: false, allowedHosts: [] };
    config.listen.allInterfaces ??= false;
    config.site.privateNetwork ??= false;
    config.site.crawl ??= { concurrency: 4, delayMs: 50, timeoutMs: 60000, maxPages: 5000, maxDepth: 12, maxBytes: 536870912, includeFeeds: false };
    config.site.rewrite ??= { externalAssets: [] };
    config.site.pagefind ??= false;
    config.cloudflare.maxFiles ??= 20000;
    config.limits ??= { publishPerHour: 30, requestsPerMinute: 120 };
    config.retention ??= { jobsDays: 90, keepBundles: 1 };
    return validateSemantics(config);
  } catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError("File di configurazione agente assente, non leggibile o con permessi non sicuri.", "agent-config-invalid", 2);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function loadAgentSecrets(env: NodeJS.ProcessEnv = process.env, config?: AgentConfig): Promise<AgentSecrets> {
  if (process.platform !== "linux") throw new HistosPublishError("L’agente di pubblicazione è supportato solo su Linux.", "agent-platform-unsupported", 2);
  const cloudflareToken = await readAgentCloudflareToken(env);
  const keysFile = env.HISTOS_AGENT_KEYS_FILE;
  if (!keysFile) throw new HistosPublishError("Configura HISTOS_AGENT_KEYS_FILE con il file delle chiavi HMAC.", "agent-keys-missing", 4);
  let parsed: unknown;
  try { parsed = JSON.parse(await readSecretFile(keysFile, "chiavi HMAC")); }
  catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError("Il file delle chiavi HMAC non è valido.", "agent-keys-invalid", 4);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { keys?: unknown }).keys)) {
    throw new HistosPublishError("Il file delle chiavi HMAC non ha il formato previsto.", "agent-keys-invalid", 4);
  }
  const rawKeys = (parsed as { keys: unknown[] }).keys;
  if (rawKeys.length < 1 || rawKeys.length > 2) throw new HistosPublishError("Il file deve contenere una o due chiavi HMAC.", "agent-keys-invalid", 4);
  const ids = new Set<string>();
  const keys: AgentKey[] = rawKeys.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HistosPublishError("Una chiave HMAC non è valida.", "agent-keys-invalid", 4);
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(item.id) || ids.has(item.id)) throw new HistosPublishError("Un ID di chiave HMAC non è valido o è duplicato.", "agent-keys-invalid", 4);
    if (typeof item.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(item.secret)) throw new HistosPublishError("Una chiave HMAC deve contenere 43 caratteri base64url.", "agent-keys-invalid", 4);
    const bytes = Buffer.from(item.secret, "base64url");
    if (bytes.byteLength !== 32 || bytes.toString("base64url") !== item.secret) throw new HistosPublishError("Una chiave HMAC non decodifica in 32 byte.", "agent-keys-invalid", 4);
    ids.add(item.id);
    return { id: item.id, secret: item.secret, bytes };
  });
  let turnstileSecret: string | undefined;
  if (config?.site.forms) {
    const file = env.HISTOS_TURNSTILE_SECRET_FILE;
    if (!file) throw new HistosPublishError("Il sito usa Fluent Forms: configura HISTOS_TURNSTILE_SECRET_FILE.", "agent-secret-missing", 4);
    turnstileSecret = await readSecretFile(file, "Turnstile");
  }
  return { cloudflareToken, ...(turnstileSecret ? { turnstileSecret } : {}), keys, redact: [cloudflareToken, ...keys.flatMap((key) => [key.secret, key.bytes.toString("hex")]), ...(turnstileSecret ? [turnstileSecret] : [])] };
}

export async function generateAgentKey(keysPath: string, id: string): Promise<string> {
  if (process.platform !== "linux") throw new HistosPublishError("Il comando agent-key è supportato solo su Linux.", "agent-platform-unsupported", 2);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(id)) throw new HistosPublishError("L’ID deve usare lettere minuscole, numeri e trattini, per un massimo di 32 caratteri.", "agent-key-id-invalid", 2);
  let keys: Array<{ id: string; secret: string }> = [];
  try {
    const info = await lstat(keysPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new HistosPublishError("Il file delle chiavi deve essere un file regolare, non un collegamento simbolico.", "agent-key-file-invalid", 4);
    const parsed: unknown = JSON.parse(await readSecretFile(keysPath, "chiavi HMAC"));
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) throw new Error("format");
    keys = (parsed as { keys: Array<{ id: string; secret: string }> }).keys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof HistosPublishError) throw error;
      throw new HistosPublishError("Il file delle chiavi esistente non è valido.", "agent-key-file-invalid", 4);
    }
  }
  if (keys.some((key) => key.id === id)) throw new HistosPublishError("Questo ID esiste già nel file delle chiavi.", "agent-key-id-exists", 2);
  if (keys.length >= 2) throw new HistosPublishError("Rimuovi prima la chiave vecchia.", "agent-key-rotation-limit", 2);
  const secret = randomBytes(32).toString("base64url");
  keys.push({ id, secret });
  const temporary = path.join(path.dirname(keysPath), "." + path.basename(keysPath) + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ keys }, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, keysPath);
    await chmod(keysPath, 0o600);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new HistosPublishError("Non riesco a creare in modo sicuro il file delle chiavi.", "agent-key-write-failed", 4);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return secret;
}
