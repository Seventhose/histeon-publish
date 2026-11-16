import { HistosPublishError, throwIfAborted } from "./errors.js";
import { isIP } from "node:net";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RATE_LIMIT_RETRIES = 2;

export interface CloudflareClientOptions {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  rateLimitRetries?: number;
}

export interface CloudflareAssetSession {
  jwt: string;
  buckets: string[][];
}

/** One asset to upload: its bytes and the Content-Type it is served with. */
export interface AssetUpload {
  bytes: Buffer;
  contentType: string;
}

export interface CloudflareVersionMetadata {
  main_module: "worker.js";
  compatibility_date: string;
  assets: {
    jwt: string;
    config: {
      html_handling: "auto-trailing-slash";
      not_found_handling: "404-page";
      /** true when the site brings its own Worker: every request reaches it first. */
      run_worker_first?: string[] | boolean;
      /** The contents of `_headers` and `_redirects`: Cloudflare reads them here, and ignores other keys of `assets`. */
      _headers?: string;
      _redirects?: string;
    };
  };
  bindings: Array<{ type: "assets"; name: "ASSETS" } | { type: "secret_text"; name: string; text: string } | { type: "kv_namespace"; name: string; namespace_id: string }>;
  keep_bindings: ["secret_text", "kv_namespace"];
  annotations?: Record<string, string>;
}

export interface CloudflareDeployment {
  id: string;
  created_on?: string;
  strategy?: "percentage";
  versions: Array<{ version_id: string; percentage: number }>;
  annotations?: Record<string, string>;
}

export interface CloudflareVersion {
  id: string;
  created_on?: string;
  annotations?: Record<string, string>;
}

export interface CloudflareKvNamespace {
  id: string;
  title: string;
}

/** A module uploaded next to the main `worker.js`, which imports it (the site's own `_worker.js`). */
export interface WorkerModule {
  name: string;
  source: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status?: string;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: "CNAME";
  content: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
  tags?: string[];
}

export interface CloudflareDomain {
  id?: string;
  hostname: string;
  service: string;
  zone_id?: string;
  zone_name?: string;
  enabled?: boolean;
  previews_enabled?: boolean;
}

export class CloudflareApiError extends HistosPublishError {
  constructor(message: string, readonly status: number) {
    super(message, "cloudflare-api", 4);
    this.name = "CloudflareApiError";
  }
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: unknown }>;
  result_info?: { total_pages?: unknown };
}

interface RequestOptions {
  body?: BodyInit;
  contentType?: string;
  bearer?: string;
  signal?: AbortSignal | undefined;
  retryRateLimit?: boolean;
}

function validatedApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HistosPublishError("Indirizzo API Cloudflare non valido.", "cloudflare-config", 2);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost"
    || (isIP(host) === 4 && host.startsWith("127."))
    || host === "[::1]";
  if (url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/")) {
    throw new HistosPublishError("L’indirizzo API non deve contenere credenziali, query o frammenti.", "cloudflare-config", 2);
  }
  if (url.pathname.replace(/\/+$/u, "") !== "/client/v4") {
    throw new HistosPublishError("L’indirizzo API deve terminare con /client/v4.", "cloudflare-config", 2);
  }
  if (url.protocol === "https:" && host !== "api.cloudflare.com") {
    throw new HistosPublishError("Per proteggere il token, l’API HTTPS deve usare api.cloudflare.com.", "cloudflare-config", 2);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HistosPublishError("L’API Cloudflare richiede HTTPS; HTTP è ammesso solo sul loopback per il mock locale.", "cloudflare-config", 2);
  }
  return value.replace(/\/+$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function retryDelay(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new HistosPublishError("Operazione annullata.", "cancelled", 6));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function multipartVersion(metadata: CloudflareVersionMetadata, workerSource: string, modules: readonly WorkerModule[] = []): FormData {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([workerSource], { type: "application/javascript+module" }), "worker.js");
  for (const module of modules) {
    if (module.name === "worker.js" || module.name === "metadata" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}\.js$/u.test(module.name)) {
      throw new HistosPublishError(`Nome di modulo Worker non valido: ${module.name}`, "cloudflare-config", 2);
    }
    form.append(module.name, new Blob([module.source], { type: "application/javascript+module" }), module.name);
  }
  return form;
}

export class CloudflareClient {
  readonly apiBase: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly rateLimitRetries: number;
  private readonly registeredSecrets = new Set<string>();

  constructor(options: CloudflareClientOptions) {
    if (!options.token || /[\r\n]/u.test(options.token)) {
      throw new HistosPublishError("Token Cloudflare mancante o non valido.", "cloudflare-auth-missing", 4);
    }
    this.token = options.token;
    this.registeredSecrets.add(options.token);
    this.apiBase = validatedApiBase(options.apiBase ?? DEFAULT_API_BASE);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitRetries = options.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
  }

  registerSecret(value: string): void {
    if (value) this.registeredSecrets.add(value);
  }

  async verifyToken(accountId?: string, signal?: AbortSignal): Promise<{ id?: string; status?: string; expires_on?: string; accountOwned?: boolean }> {
    if (accountId && !/^[0-9a-f]{32}$/iu.test(accountId)) {
      throw new HistosPublishError("L’ID account Cloudflare deve contenere 32 caratteri esadecimali.", "cloudflare-config", 2);
    }
    try {
      return await this.request<{ id?: string; status?: string; expires_on?: string }>("GET", "/user/tokens/verify", { signal });
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 401) throw error;
      if (!accountId) {
        throw new HistosPublishError("Cloudflare non riconosce il token. Se lo hai creato come Account API Token (per esempio limitato a Workers specifici), inserisci l’ID account Cloudflare e riprova.", "cloudflare-auth-invalid", 4);
      }
      const result = await this.request<{ id?: string; status?: string; expires_on?: string }>("GET", `/accounts/${encodeURIComponent(accountId)}/tokens/verify`, { signal });
      return { ...result, accountOwned: true };
    }
  }

  async listAccounts(signal?: AbortSignal): Promise<CloudflareAccount[]> {
    const accounts: CloudflareAccount[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({ per_page: "50", page: String(page) });
      let result: unknown;
      try {
        result = await this.request<unknown>("GET", `/accounts?${query.toString()}`, { signal });
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 403) {
          throw new CloudflareApiError("Per trovare automaticamente l’account serve il permesso Account Settings Read. Puoi anche inserire manualmente l’ID account.", 403);
        }
        throw error;
      }
      if (!Array.isArray(result)) break;
      for (const item of result) {
        const account = asRecord(item);
        if (typeof account?.id === "string" && /^[0-9a-f]{32}$/iu.test(account.id) && typeof account.name === "string") {
          accounts.push({ id: account.id, name: account.name });
        }
      }
      const info = asRecord(this.lastResultInfo);
      const totalPages = Number(info?.total_pages ?? page);
      if (!Number.isFinite(totalPages) || page >= totalPages || result.length < 50) break;
    }
    return accounts;
  }

  async createAssetUploadSession(accountId: string, script: string, manifest: Record<string, { hash: string; size: number }>, signal?: AbortSignal): Promise<CloudflareAssetSession> {
    const result = await this.request<unknown>("POST", `${scriptPath(accountId, script)}/assets-upload-session`, {
      body: JSON.stringify({ manifest }),
      contentType: "application/json",
      signal,
    });
    const record = asRecord(result);
    const jwt = record?.jwt;
    if (typeof jwt !== "string" || jwt.length === 0 || !Array.isArray(record?.buckets)) {
      throw new CloudflareApiError("La risposta di Cloudflare non contiene una sessione di upload valida.", 502);
    }
    this.registeredSecrets.add(jwt);
    const buckets: string[][] = [];
    for (const bucket of record.buckets) {
      if (!Array.isArray(bucket) || !bucket.every((hash) => typeof hash === "string" && /^[0-9a-f]{32}$/u.test(hash))) {
        throw new CloudflareApiError("Cloudflare ha restituito un gruppo di asset non valido.", 502);
      }
      buckets.push(bucket as string[]);
    }
    return { jwt, buckets };
  }

  /** Uploads assets by hash; each part carries the Content-Type Cloudflare will serve the asset with. */
  async uploadAssetBucket(accountId: string, jwt: string, files: ReadonlyMap<string, AssetUpload>, signal?: AbortSignal): Promise<string | undefined> {
    if (files.size === 0) return undefined;
    const form = new FormData();
    for (const [hash, file] of files) {
      form.append(hash, new Blob([file.bytes.toString("base64")], { type: file.contentType }), hash);
    }
    const result = await this.request<unknown>("POST", `/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`, {
      body: form,
      bearer: jwt,
      signal,
    });
    const completion = asRecord(result)?.jwt;
    if (typeof completion === "string" && completion.length > 0) {
      this.registeredSecrets.add(completion);
      return completion;
    }
    return undefined;
  }

  async uploadVersion(accountId: string, script: string, metadata: CloudflareVersionMetadata, workerSource: string, signal?: AbortSignal, modules: readonly WorkerModule[] = []): Promise<string> {
    const path = `${scriptPath(accountId, script)}/versions`;
    let response: unknown;
    try {
      response = await this.request<unknown>("POST", path, { body: multipartVersion(metadata, workerSource, modules), signal });
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
      await this.request("PUT", scriptPath(accountId, script), { body: multipartVersion(metadata, workerSource, modules), signal });
      response = await this.request<unknown>("POST", path, { body: multipartVersion(metadata, workerSource, modules), signal });
    }
    const id = asRecord(response)?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new CloudflareApiError("La risposta di Cloudflare non contiene l’ID della versione.", 502);
    }
    return id;
  }

  async deployVersion(accountId: string, script: string, versionId: string, message: string, signal?: AbortSignal): Promise<CloudflareDeployment> {
    const result = await this.request<unknown>("POST", `${scriptPath(accountId, script)}/deployments`, {
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": truncateUtf8(message, 1000) },
      }),
      contentType: "application/json",
      signal,
    });
    const deployment = asRecord(result);
    if (!deployment || typeof deployment.id !== "string") {
      throw new CloudflareApiError("La risposta di Cloudflare non contiene l’ID del deployment.", 502);
    }
    return {
      id: deployment.id,
      ...(typeof deployment.created_on === "string" ? { created_on: deployment.created_on } : {}),
      ...(deployment.strategy === "percentage" ? { strategy: "percentage" as const } : {}),
      versions: Array.isArray(deployment.versions) ? deployment.versions as CloudflareDeployment["versions"] : [{ version_id: versionId, percentage: 100 }],
      ...(asRecord(deployment.annotations) ? { annotations: deployment.annotations as Record<string, string> } : {}),
    };
  }

  async listDeployments(accountId: string, script: string, signal?: AbortSignal): Promise<CloudflareDeployment[]> {
    const result = await this.request<unknown>("GET", `${scriptPath(accountId, script)}/deployments`, { signal });
    const record = asRecord(result);
    if (!record || !Array.isArray(record.deployments)) return [];
    return record.deployments.filter((entry): entry is CloudflareDeployment => {
      const item = asRecord(entry);
      return typeof item?.id === "string" && Array.isArray(item.versions);
    });
  }

  async listVersions(accountId: string, script: string, signal?: AbortSignal): Promise<CloudflareVersion[]> {
    const result = await this.request<unknown>("GET", `${scriptPath(accountId, script)}/versions?per_page=100`, { signal });
    const record = asRecord(result);
    const list = Array.isArray(result) ? result : Array.isArray(record?.versions) ? record.versions : [];
    return list.filter((entry): entry is CloudflareVersion => {
      const item = asRecord(entry);
      return typeof item?.id === "string";
    });
  }

  async verifyWorkerScript(accountId: string, script: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request<unknown>("GET", `${scriptPath(accountId, script)}/script-settings`, { signal });
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      if (error.status === 403) {
        throw new CloudflareApiError("Per verificare il Worker serve Workers Scripts Read sull’account Cloudflare selezionato.", 403);
      }
      if (error.status === 404) {
        // The same 404 arrives for a Worker that exists but was never deployed: its versions tell the two apart.
        const exists = await this.listVersions(accountId, script, signal).then(() => true, () => false);
        if (exists) {
          throw new CloudflareApiError(`Il Worker “${script}” esiste ma non ha ancora una versione pubblicata: premi Prepara e pubblica.`, 404);
        }
        throw new CloudflareApiError(`Il Worker “${script}” non esiste nell’account Cloudflare selezionato. Controlla il nome oppure pubblica prima una build.`, 404);
      }
      throw error;
    }
  }

  async getWorkersDevUrl(accountId: string, script: string, signal?: AbortSignal): Promise<string | undefined> {
    const [accountResult, workerResult] = await Promise.all([
      this.request<unknown>("GET", `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, { signal }),
      this.request<unknown>("GET", `${scriptPath(accountId, script)}/subdomain`, { signal }),
    ]);
    const account = asRecord(accountResult);
    const worker = asRecord(workerResult);
    const subdomain = account?.subdomain;
    if (worker?.enabled !== true || typeof subdomain !== "string" || !/^[a-z0-9-]+$/iu.test(subdomain)) return undefined;
    return `https://${script}.${subdomain}.workers.dev`;
  }

  async listZones(accountId: string, signal?: AbortSignal): Promise<CloudflareZone[]> {
    const zones: CloudflareZone[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({ "account.id": accountId, per_page: "50", page: String(page) });
      const result = await this.request<unknown>("GET", `/zones?${query.toString()}`, { signal });
      if (!Array.isArray(result)) break;
      for (const item of result) {
        const zone = asRecord(item);
        if (typeof zone?.id === "string" && typeof zone.name === "string") {
          zones.push({ id: zone.id, name: zone.name, ...(typeof zone.status === "string" ? { status: zone.status } : {}) });
        }
      }
      const info = asRecord(this.lastResultInfo);
      const totalPages = Number(info?.total_pages ?? page);
      if (!Number.isFinite(totalPages) || page >= totalPages || result.length < 50) break;
    }
    return zones;
  }

  async listCnameRecords(zoneId: string, hostname: string, signal?: AbortSignal): Promise<CloudflareDnsRecord[]> {
    const query = new URLSearchParams({ "name.exact": hostname, type: "CNAME", per_page: "100" });
    let result: unknown;
    try {
      result = await this.request<unknown>("GET", `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`, { signal });
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 403) {
        throw new CloudflareApiError("Per controllare il dominio serve il permesso DNS Read sulla zona Cloudflare.", 403);
      }
      throw error;
    }
    if (!Array.isArray(result)) return [];
    return result.flatMap((item): CloudflareDnsRecord[] => {
      const record = asRecord(item);
      if (typeof record?.id !== "string" || typeof record.name !== "string" || record.type !== "CNAME" || typeof record.content !== "string") return [];
      return [{
        id: record.id,
        name: record.name,
        type: "CNAME",
        content: record.content,
        ...(typeof record.ttl === "number" ? { ttl: record.ttl } : {}),
        ...(typeof record.proxied === "boolean" ? { proxied: record.proxied } : {}),
        ...(typeof record.comment === "string" ? { comment: record.comment } : {}),
        ...(Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string") ? { tags: record.tags as string[] } : {}),
      }];
    });
  }

  async deleteDnsRecord(zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, { signal });
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 403) {
        throw new CloudflareApiError("Per sostituire il record CNAME serve il permesso DNS Write sulla zona Cloudflare.", 403);
      }
      throw error;
    }
  }

  async restoreDnsRecord(zoneId: string, record: CloudflareDnsRecord, signal?: AbortSignal): Promise<void> {
    const existing = await this.listCnameRecords(zoneId, record.name, signal);
    if (existing.length > 0) {
      const alreadyRestored = existing.some((candidate) => candidate.content === record.content
        && (candidate.ttl ?? 1) === (record.ttl ?? 1)
        && (candidate.proxied ?? false) === (record.proxied ?? false)
        && candidate.comment === record.comment
        && JSON.stringify(candidate.tags ?? []) === JSON.stringify(record.tags ?? []));
      if (alreadyRestored) return;
      throw new CloudflareApiError(`Non posso ripristinare ${record.name}: esiste già un CNAME diverso.`, 409);
    }
    await this.request<unknown>("POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      body: JSON.stringify({
        type: "CNAME",
        name: record.name,
        content: record.content,
        ttl: record.ttl ?? 1,
        proxied: record.proxied ?? false,
        ...(record.comment === undefined ? {} : { comment: record.comment }),
        ...(record.tags === undefined ? {} : { tags: record.tags }),
      }),
      contentType: "application/json",
      signal,
    });
  }

  async listWorkerDomains(accountId: string, hostnames?: readonly string[], signal?: AbortSignal): Promise<CloudflareDomain[]> {
    const filters = hostnames?.length ? hostnames : [undefined];
    const domains: CloudflareDomain[] = [];
    for (const hostname of filters) {
      const query = hostname ? `?${new URLSearchParams({ hostname }).toString()}` : "";
      const result = await this.request<unknown>("GET", `/accounts/${encodeURIComponent(accountId)}/workers/domains${query}`, { signal });
      if (!Array.isArray(result)) continue;
      domains.push(...result.flatMap((item): CloudflareDomain[] => {
        const domain = asRecord(item);
        if (typeof domain?.hostname !== "string" || typeof domain.service !== "string") return [];
        return [{
          ...(typeof domain.id === "string" ? { id: domain.id } : {}),
          hostname: domain.hostname,
          service: domain.service,
          ...(typeof domain.zone_id === "string" ? { zone_id: domain.zone_id } : {}),
          ...(typeof domain.zone_name === "string" ? { zone_name: domain.zone_name } : {}),
          ...(typeof domain.enabled === "boolean" ? { enabled: domain.enabled } : {}),
          ...(typeof domain.previews_enabled === "boolean" ? { previews_enabled: domain.previews_enabled } : {}),
        }];
      }));
    }
    return [...new Map(domains.map((domain) => [`${domain.hostname.toLowerCase()}/${domain.id ?? domain.service}`, domain])).values()];
  }

  async detachDomain(accountId: string, domainId: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`, { signal });
  }

  private lastResultInfo: unknown;

  async attachDomain(accountId: string, hostname: string, script: string, zone: CloudflareZone, signal?: AbortSignal): Promise<CloudflareDomain> {
    let result: unknown;
    try {
      result = await this.request<unknown>("PUT", `/accounts/${encodeURIComponent(accountId)}/workers/domains`, {
        body: JSON.stringify({ hostname, service: script, zone_id: zone.id, zone_name: zone.name, enabled: true, previews_enabled: false }),
        contentType: "application/json",
        signal,
      });
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 403) {
        throw new CloudflareApiError("Per collegare il dominio automaticamente, Cloudflare richiede Workers Scripts Write con ambito account. Questo permesso può modificare i Worker dell’account; se non vuoi concederlo, collega il dominio da Workers & Pages nel pannello Cloudflare.", 403);
      }
      throw error;
    }
    const domain = asRecord(result);
    return {
      ...(typeof domain?.id === "string" ? { id: domain.id } : {}),
      hostname,
      service: script,
      zone_id: zone.id,
      zone_name: zone.name,
      enabled: true,
      previews_enabled: false,
    };
  }

  /** Every KV namespace of the account, read page by page. */
  async listKvNamespaces(accountId: string, signal?: AbortSignal): Promise<CloudflareKvNamespace[]> {
    const namespaces: CloudflareKvNamespace[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      let result: unknown;
      try {
        result = await this.request<unknown>("GET", `${kvPath(accountId)}?${query.toString()}`, { signal });
      } catch (error) {
        throw kvPermissionError(error);
      }
      if (!Array.isArray(result)) break;
      for (const item of result) {
        const namespace = asRecord(item);
        if (typeof namespace?.id === "string" && /^[0-9a-f]{32}$/iu.test(namespace.id) && typeof namespace.title === "string") {
          namespaces.push({ id: namespace.id, title: namespace.title });
        }
      }
      const info = asRecord(this.lastResultInfo);
      const totalPages = Number(info?.total_pages ?? page);
      if (!Number.isFinite(totalPages) || page >= totalPages || result.length < 100) break;
    }
    return namespaces;
  }

  async createKvNamespace(accountId: string, title: string, signal?: AbortSignal): Promise<CloudflareKvNamespace> {
    let result: unknown;
    try {
      result = await this.request<unknown>("POST", kvPath(accountId), { body: JSON.stringify({ title }), contentType: "application/json", signal });
    } catch (error) {
      throw kvPermissionError(error);
    }
    const namespace = asRecord(result);
    if (typeof namespace?.id !== "string" || !/^[0-9a-f]{32}$/iu.test(namespace.id)) {
      throw new CloudflareApiError("La risposta di Cloudflare non contiene l’ID dell’archivio KV.", 502);
    }
    return { id: namespace.id, title: typeof namespace.title === "string" ? namespace.title : title };
  }

  /** The namespace with this title, created when the account does not have it yet. */
  async ensureKvNamespace(accountId: string, title: string, signal?: AbortSignal): Promise<CloudflareKvNamespace> {
    const existing = (await this.listKvNamespaces(accountId, signal)).find((namespace) => namespace.title === title);
    return existing ?? await this.createKvNamespace(accountId, title, signal);
  }

  async putSecret(accountId: string, script: string, name: string, value: string, signal?: AbortSignal): Promise<void> {
    this.registerSecret(value);
    await this.request("PUT", `${scriptPath(accountId, script)}/secrets`, {
      body: JSON.stringify({ name, text: value, type: "secret_text" }),
      contentType: "application/json",
      signal,
    });
  }

  private redact(value: string, bearer?: string): string {
    let safe = value;
    for (const secret of this.registeredSecrets) {
      if (secret) safe = safe.replaceAll(secret, "[segreto rimosso]");
    }
    if (bearer) safe = safe.replaceAll(bearer, "[segreto rimosso]");
    return safe
      .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/giu, "Bearer [segreto rimosso]")
      .replace(/\b(?:eyJ[A-Za-z0-9._-]{12,}|(?:sk_live_|sk_test_|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,})\b/gu, "[segreto rimosso]");
  }

  private async request<T>(method: string, pathname: string, options: RequestOptions = {}): Promise<T> {
    const retries = options.retryRateLimit === false ? 0 : this.rateLimitRetries;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      throwIfAborted(options.signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${options.bearer ?? this.token}`);
      if (options.contentType) headers.set("Content-Type", options.contentType);
      try {
        const response = await this.fetcher(`${this.apiBase}${pathname}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: options.body }),
          redirect: "manual",
          signal,
        });
        if (response.status === 429 && attempt < retries) {
          await response.body?.cancel();
          await wait(retryDelay(response.headers.get("retry-after"), attempt), options.signal);
          continue;
        }
        const raw = await response.text();
        if (raw.length > 1_048_576) throw new CloudflareApiError(`La risposta Cloudflare (${response.status}) supera la dimensione attesa.`, response.status);
        let envelope: CloudflareEnvelope<T> | null = null;
        try { envelope = asRecord(JSON.parse(raw)) as CloudflareEnvelope<T> | null; }
        catch { /* A malformed response is reported without echoing its body. */ }
        this.lastResultInfo = envelope?.result_info;
        if (response.status >= 300 || envelope?.success !== true) {
          const details = Array.isArray(envelope?.errors)
            ? envelope.errors.map((error) => typeof error?.message === "string" ? this.redact(error.message, options.bearer) : "").filter(Boolean).join("; ")
            : "";
          const message = details ? `Cloudflare ha risposto ${response.status}: ${details}` : `Cloudflare ha risposto ${response.status}.`;
          throw new CloudflareApiError(this.redact(message, options.bearer), response.status);
        }
        return envelope.result as T;
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        if (options.signal?.aborted) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
        if (controller.signal.aborted) throw new CloudflareApiError("La richiesta Cloudflare è scaduta.", 408);
        const message = error instanceof Error ? this.redact(error.message, options.bearer) : "errore di rete";
        throw new CloudflareApiError(`Cloudflare non raggiungibile: ${message}`, 0);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new CloudflareApiError("Cloudflare ha superato i tentativi consentiti per il limite di richieste.", 429);
  }
}

function kvPath(accountId: string): string {
  if (!/^[0-9a-f]{32}$/iu.test(accountId)) throw new HistosPublishError("L’ID account Cloudflare deve contenere 32 caratteri esadecimali.", "cloudflare-config", 2);
  return `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`;
}

/** The message for a token that cannot use KV namespaces. */
export const KV_PERMISSION_HINT = "Aggiungi al token il permesso Account › Workers KV Storage › Edit: in Cloudflare apri Profilo › Token API, modifica il token e aggiungi la riga Account, Workers KV Storage, Edit; poi pubblica di nuovo.";

/**
 * A token without Workers KV Storage: Cloudflare answers 403, or 401 «Authentication error» (code 10000) for an
 * account token limited to some Workers. Both become the message on the missing permission.
 */
function kvPermissionError(error: unknown): unknown {
  if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
    return new CloudflareApiError(`Cloudflare ha negato l’accesso agli archivi KV (${error.status}). ${KV_PERMISSION_HINT}`, error.status);
  }
  return error;
}

function scriptPath(accountId: string, script: string): string {
  if (!/^[0-9a-f]{32}$/iu.test(accountId)) throw new HistosPublishError("L’ID account Cloudflare deve contenere 32 caratteri esadecimali.", "cloudflare-config", 2);
  if (!/^[a-z0-9-]{1,63}$/u.test(script)) throw new HistosPublishError("Il nome Worker deve contenere solo lettere minuscole, numeri e trattini.", "cloudflare-config", 2);
  return `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(script)}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const characters = [...value];
  let result = "";
  for (const character of characters) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}
