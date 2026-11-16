import { HISTOS_PUBLISH_VERSION } from "@histos-publish/cms";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, lstat, open, readFile, rm, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Ajv } from "ajv";
import {
  CloudflareApiError, CloudflareClient, HistosPublishError, buildBundle, deployBundle,
  loadBundleFiles, parseSiteConfig, planCloudflareManifest, rollbackVersion, type BuildEvent,
} from "@histos-publish/core";
import { loadAgentSecrets, readAgentConfig } from "./agent-config.js";
import type { AgentConfig, AgentSecrets } from "./agent-config.js";
import { signAgentResponse, verifyAgentRequest } from "./agent-protocol.js";

type JobType = "publish" | "rollback";
type JobStatus = "queued" | "running" | "complete" | "blocked" | "failed" | "cancelled" | "superseded";
type JobPhase = "crawl" | "scan" | "upload" | "version" | "deploy" | "rollback";
type JobError = { code: string; message: string; retryable: boolean };
interface JobProgress { pages: number; assets: number; bytes: number; uploaded: number; to_upload: number }
interface JobFindings { block: number; warn: number; items: Array<{ code: string; severity: "block" | "warn"; file: string }> }
interface JobInput {
  type: JobType; requestId: string; keyId: string; bodyHash: string;
  release?: { version: string; label?: string }; exportToken?: string; paths?: string[]; rollbackTarget?: string;
}
interface AgentJob {
  id: string; type: JobType; status: JobStatus; phase: JobPhase | null; requestId: string; keyId: string;
  release: { version: string; label?: string } | null; rollbackTarget: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  progress: JobProgress; findings: JobFindings; error: JobError | null; result: Record<string, unknown> | null;
  controller?: AbortController; stopCode?: "agent_stopped" | "agent_restarted"; input?: JobInput;
  tokenExpired?: boolean;
}
interface JobRow {
  id: string; type: JobType; status: JobStatus; phase: JobPhase | null; request_id: string; key_id: string; body_sha256: string;
  release_version: string | null; release_label: string | null; rollback_target: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
  progress_json: string; findings_json: string; error_json: string | null; result_json: string | null;
}
interface PublishBody { request_id: string; release: { version: string; label?: string }; export_token: string; paths?: string[] }
interface RollbackBody { request_id: string; target: string }
interface HttpError { status: number; code: string; message: string; retryable: boolean; retryAfter?: number }
interface AgentRuntime { stop: () => Promise<void>; closed: Promise<void> }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPORT_TOKEN = /^([0-9]{10})\.([0-9a-f]{64})$/u;
const INTERNAL_JOB_ERROR: JobError = { code: "internal", message: "Si è verificato un errore interno.", retryable: true };
const requestAjv = new Ajv({ allErrors: true, strict: true });
const validatePublishRequest = requestAjv.compile({
  type: "object", additionalProperties: false, required: ["request_id", "release", "export_token"],
  properties: {
    request_id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    release: {
      type: "object", additionalProperties: false, required: ["version"],
      properties: {
        version: { type: "string", pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$" },
        label: { type: "string", maxLength: 120 },
      },
    },
    export_token: { type: "string", pattern: "^[0-9]{10}\\.[0-9a-f]{64}$" },
    paths: { type: "array", maxItems: 20000, items: { type: "string", minLength: 1, maxLength: 1024 } },
  },
});
const validateRollbackRequest = requestAjv.compile({
  type: "object", additionalProperties: false, required: ["request_id", "target"],
  properties: {
    request_id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    target: { type: "string", pattern: "^[0-9a-f-]{8,64}$" },
  },
});
const validateCancelRequest = requestAjv.compile({ type: "object", additionalProperties: false });
const FIXED_ERRORS: Record<string, JobError> = {
  scan_blocked: { code: "scan_blocked", message: "I controlli hanno bloccato la pubblicazione.", retryable: false },
  export_mode_not_confirmed: { code: "export_mode_not_confirmed", message: "Il sito non ha confermato la modalità di esportazione.", retryable: false },
  export_token_expired: { code: "export_token_expired", message: "Il token di esportazione è scaduto; richiedi una nuova pubblicazione.", retryable: true },
  source_unreachable: { code: "source_unreachable", message: "Il sito non è raggiungibile in questo momento.", retryable: true },
  source_rejected: { code: "source_rejected", message: "La richiesta al sito è stata bloccata dai controlli di rete.", retryable: false },
  cloudflare_error: { code: "cloudflare_error", message: "Cloudflare non ha completato la pubblicazione.", retryable: true },
  rollback_target_unknown: { code: "rollback_target_unknown", message: "La versione indicata non è disponibile per il ripristino.", retryable: false },
  agent_restarted: { code: "agent_restarted", message: "L’agente si è riavviato prima di terminare il lavoro.", retryable: true },
  agent_stopped: { code: "agent_stopped", message: "L’agente si è arrestato prima di terminare il lavoro.", retryable: true },
  internal: INTERNAL_JOB_ERROR,
};

function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function nowIso(): string { return new Date().toISOString(); }
function fixedError(code: string): JobError { return FIXED_ERRORS[code] ?? INTERNAL_JOB_ERROR; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function errorFor(error: unknown, stopCode?: AgentJob["stopCode"], tokenExpired = false): JobError {
  if (stopCode) return fixedError(stopCode);
  if (tokenExpired) return fixedError("export_token_expired");
  if (error instanceof HistosPublishError) {
    if (error.code === "export-mode-not-confirmed") return fixedError("export_mode_not_confirmed");
    if (error.code.startsWith("crawl-dns") || error.code === "crawl-network" || error.code === "crawl-timeout" || error.code === "crawl-retries-exhausted" || error.exitCode === 5) return fixedError("source_unreachable");
    if (error.exitCode === 2) return fixedError("source_rejected");
  }
  if (error instanceof CloudflareApiError) return fixedError("cloudflare_error");
  return fixedError("internal");
}

function routeModel(requestPath: string): string {
  const pathname = requestPath.split("?")[0] ?? "";
  if (/^\/v1\/jobs\/[0-9a-f-]{36}\/cancel$/u.test(pathname)) return "/v1/jobs/:id/cancel";
  if (/^\/v1\/jobs\/[0-9a-f-]{36}$/u.test(pathname)) return "/v1/jobs/:id";
  return pathname;
}
function routeMethod(requestPath: string): string | undefined {
  const pathname = requestPath.split("?")[0] ?? "";
  if (pathname === "/healthz" || pathname === "/v1/jobs" || pathname === "/v1/deployments" || pathname === "/v1/info") return "GET";
  if (pathname === "/v1/publish" || pathname === "/v1/rollback") return "POST";
  if (/^\/v1\/jobs\/[0-9a-f-]{36}$/u.test(pathname)) return "GET";
  if (/^\/v1\/jobs\/[0-9a-f-]{36}\/cancel$/u.test(pathname)) return "POST";
  return undefined;
}
function safeErrorText(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : "unknown";
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redatto]");
  return message
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[url]")
    .replace(/(?:\/(?:[^/\s]+\/){1,}[^/\s]*)/gu, "[percorso]")
    .replace(/[\r\n\0]/gu, " ")
    .slice(0, 500);
}
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[redatto]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
}
function safePublicJob(job: AgentJob, secrets: readonly string[], listMode = false): Record<string, unknown> {
  const release = job.release ? redactValue(job.release, secrets) : null;
  const items = job.findings.items.slice(0, 200).map((item) => ({
    code: redactValue(item.code, secrets), severity: item.severity, file: redactValue(item.file, secrets),
  }));
  return {
    id: job.id, type: job.type, status: job.status, phase: job.phase,
    request_id: job.requestId, release,
    created_at: job.createdAt, started_at: job.startedAt, finished_at: job.finishedAt,
    progress: job.progress,
    findings: { block: job.findings.block, warn: job.findings.warn, ...(listMode ? {} : { items }) },
    error: redactValue(job.error, secrets), result: redactValue(job.result, secrets),
  };
}
function apiError(status: number, code: string, message: string, retryable = false, retryAfter?: number): HttpError {
  return { status, code, message, retryable, ...(retryAfter === undefined ? {} : { retryAfter }) };
}
const ERRORS = {
  invalidRequest: apiError(400, "invalid_request", "La richiesta non rispetta il formato previsto."),
  invalidHost: apiError(400, "invalid_host", "Host non consentito."),
  unauthorized: apiError(401, "unauthorized", "Richiesta non autorizzata."),
  forbidden: apiError(403, "forbidden", "Richiesta non consentita."),
  notFound: apiError(404, "not_found", "Risorsa non trovata."),
  method: apiError(405, "method_not_allowed", "Metodo non consentito."),
  reused: apiError(409, "request_id_reused", "Questo request_id è già stato usato con un contenuto diverso."),
  notCancellable: apiError(409, "not_cancellable", "Il lavoro è già terminato e non può essere annullato."),
  tooLarge: apiError(413, "body_too_large", "Il corpo della richiesta supera il limite consentito."),
  media: apiError(415, "unsupported_media_type", "Invia un corpo JSON con charset UTF-8."),
  internal: apiError(500, "internal", "Si è verificato un errore interno.", true),
  cloudflare: apiError(502, "cloudflare_error", "Non riesco a leggere lo storico Cloudflare.", true),
  shuttingDown: apiError(503, "shutting_down", "L’agente si sta arrestando; riprova tra poco.", true),
};

class AgentService {
  private readonly database: DatabaseSync;
  private readonly server: Server;
  private readonly jobs = new Map<string, AgentJob>();
  private readonly pending: AgentJob[] = [];
  private readonly requestTimes = new Map<string, number[]>();
  private readonly publishTimes = new Map<string, number[]>();
  private readonly exportTokens = new Set<string>();
  private readonly bundleDirectory: string;
  private currentJob: AgentJob | null = null;
  private runningPump = false;
  private shuttingDown = false;
  private lastNonceSweep = 0;
  private retentionTimer: ReturnType<typeof setInterval> | undefined;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });

  private constructor(
    private readonly config: AgentConfig,
    private readonly secrets: AgentSecrets,
    database: DatabaseSync,
    private readonly lockPath: string,
  ) {
    this.database = database;
    this.bundleDirectory = path.join(config.dataDir, "bundles");
    this.server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => { void this.handleRequest(request, response); });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
    this.server.maxHeadersCount = 50;
    this.server.maxConnections = 32;
  }

  static async create(configPath: string): Promise<AgentService> {
    if (process.platform !== "linux") throw new HistosPublishError("L’agente di pubblicazione è supportato solo su Linux.", "agent-platform-unsupported", 2);
    const config = await readAgentConfig(configPath);
    const secrets = await loadAgentSecrets(process.env, config);
    const root = config.dataDir;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) {
      throw new HistosPublishError("dataDir deve essere una cartella privata con permessi 0700.", "agent-data-permissions", 4);
    }
    const lockPath = path.join(root, "agent.lock");
    const lock = await open(lockPath, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      let pid = 0;
      try { pid = Number((await readFile(lockPath, "utf8")).trim()); } catch { /* A damaged stale lock is replaced below. */ }
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (killError) { alive = (killError as NodeJS.ErrnoException).code === "EPERM"; }
      }
      if (alive) throw new HistosPublishError("Un altro agente usa questa cartella dati.", "agent-already-running", 2);
      await unlink(lockPath).catch(() => undefined);
      return open(lockPath, "wx", 0o600);
    });
    await lock.writeFile(String(process.pid) + "\n", "utf8");
    await lock.close();
    let database: DatabaseSync | undefined;
    try {
      const bundles = path.join(root, "bundles");
      const tmp = path.join(root, "tmp");
      await mkdir(bundles, { recursive: true, mode: 0o700 });
      const bundleStat = await lstat(bundles);
      if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory() || (bundleStat.mode & 0o077) !== 0) throw new HistosPublishError("La cartella bundles deve essere privata e senza collegamenti simbolici.", "agent-data-permissions", 4);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: false, mode: 0o700 });
      const dbPath = path.join(root, "agent.db");
      try {
        const dbStat = await lstat(dbPath);
        if (dbStat.isSymbolicLink() || !dbStat.isFile() || (dbStat.mode & 0o077) !== 0) throw new HistosPublishError("Il database agente deve essere un file privato.", "agent-data-permissions", 4);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const initial = await open(dbPath, "wx", 0o600);
        await initial.close();
      }
      await chmod(dbPath, 0o600);
      const originalUmask = process.umask(0o077);
      try {
        database = new DatabaseSync(dbPath);
        database.exec([
          "PRAGMA journal_mode = WAL;",
          "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('publish','rollback')), status TEXT NOT NULL, phase TEXT, request_id TEXT NOT NULL, key_id TEXT NOT NULL, body_sha256 TEXT NOT NULL, release_version TEXT, release_label TEXT, rollback_target TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, progress_json TEXT NOT NULL DEFAULT '{}', findings_json TEXT NOT NULL DEFAULT '{\"block\":0,\"warn\":0,\"items\":[]}', error_json TEXT, result_json TEXT, UNIQUE (key_id, request_id));",
          "CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);",
          "CREATE TABLE IF NOT EXISTS nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (key_id, nonce));",
          "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        ].join("\n"));
      } finally {
        process.umask(originalUmask);
      }
      for (const suffix of ["", "-wal", "-shm"]) await chmod(dbPath + suffix, 0o600).catch(() => undefined);
      const version = database.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v?: string } | undefined;
      if (version?.v && version.v !== "1") throw new HistosPublishError("Versione del database agente non supportata.", "agent-database-version", 2);
      database.prepare("INSERT INTO meta(k,v) VALUES('schema_version','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
      const restarted = database.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all() as Array<{ id: string }>;
      for (const row of restarted) {
        database.prepare("UPDATE jobs SET status='failed', phase=NULL, finished_at=?, error_json=? WHERE id=?")
          .run(nowIso(), JSON.stringify(fixedError("agent_restarted")), row.id);
      }
      return new AgentService(config, secrets, database, lockPath);
    } catch (error) {
      database?.close();
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    const row: Record<string, unknown> = { time: nowIso(), event, ...fields };
    let line = JSON.stringify(row);
    for (const secret of [...this.secrets.redact, ...this.exportTokens]) if (secret) line = line.replaceAll(secret, "[redatto]");
    process.stdout.write(line + "\n");
  }

  async start(): Promise<AgentRuntime> {
    if (this.config.listen.allInterfaces) process.stderr.write(JSON.stringify({ event: "warning", code: "listening-all-interfaces" }) + "\n");
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.server.once("error", failed);
      this.server.listen(this.config.listen.port, this.config.listen.host, () => {
        this.server.off("error", failed);
        resolve();
      });
    }).catch(async () => {
      this.database.close();
      await unlink(this.lockPath).catch(() => undefined);
      throw new HistosPublishError("Non riesco ad avviare il server agente.", "agent-listen-failed", 1);
    });
    const host = this.config.listen.host.includes(":") ? "[" + this.config.listen.host + "]" : this.config.listen.host;
    this.log("agent-started", { listen: host + ":" + this.config.listen.port, site: this.config.site.origin, script: this.config.cloudflare.script, apiVersion: 1 });
    this.retentionTimer = setInterval(() => { void this.cleanRetention(); }, 60 * 60 * 1000);
    void this.cleanRetention();
    return { stop: () => this.stop(), closed: this.closed };
  }

  private async stop(): Promise<void> {
    if (this.shuttingDown) return this.closed;
    this.shuttingDown = true;
    this.log("agent-stopping");
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.currentJob) { this.currentJob.stopCode = "agent_stopped"; this.currentJob.controller?.abort(); }
    for (const job of this.pending.splice(0)) {
      job.status = "failed"; job.phase = null; job.finishedAt = nowIso(); job.error = fixedError("agent_stopped");
      this.discardJobInput(job);
      this.persistJob(job);
    }
    const serverClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const timeout = setTimeout(() => this.server.closeAllConnections(), 30_000);
    await Promise.race([Promise.all([serverClosed, this.waitForPump()]), new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
    clearTimeout(timeout);
    this.database.close();
    await unlink(this.lockPath).catch(() => undefined);
    this.resolveClosed();
  }

  private async waitForPump(): Promise<void> {
    while (this.runningPump) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private send(response: ServerResponse, status: number, value?: unknown, auth?: { key: Buffer; nonce: string }, extraHeaders: Record<string, string> = {}): void {
    const body = status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value ?? {}), "utf8");
    response.statusCode = status;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    for (const [name, headerValue] of Object.entries(extraHeaders)) response.setHeader(name, headerValue);
    if (status !== 204) response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (auth) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      response.setHeader("X-Histos-Timestamp", timestamp);
      response.setHeader("X-Histos-Signature", signAgentResponse(auth.key, status, auth.nonce, timestamp, body));
    }
    response.end(body);
  }

  private sendError(response: ServerResponse, error: HttpError, auth?: { key: Buffer; nonce: string }): void {
    this.send(response, error.status, { error: { code: error.code, message: error.message, retryable: error.retryable } }, auth,
      error.retryAfter === undefined ? {} : { "Retry-After": String(error.retryAfter) });
  }

  private async readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 2 * 1024 * 1024) {
        request.resume();
        throw ERRORS.tooLarge;
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = request.method ?? "";
    const requestPath = request.url ?? "/";
    let keyId: string | undefined;
    let auth: { key: Buffer; nonce: string } | undefined;
    try {
      if (response.headersSent) return;
      const host = typeof request.headers.host === "string" ? request.headers.host.toLowerCase() : "";
      const allowedHosts = this.config.listen.allowedHosts.map((item) => item.toLowerCase());
      if (!host || !allowedHosts.includes(host)) {
        this.sendError(response, ERRORS.invalidHost);
        return;
      }
      if (request.headers.origin !== undefined) {
        this.sendError(response, ERRORS.forbidden);
        return;
      }
      const expectedMethod = routeMethod(requestPath);
      if (expectedMethod && method.toUpperCase() !== expectedMethod) {
        response.setHeader("Allow", expectedMethod);
        this.sendError(response, ERRORS.method);
        return;
      }
      let body: Buffer;
      try { body = await this.readBody(request); }
      catch (error) {
        const httpError = isObject(error) && typeof error.status === "number" ? error as unknown as HttpError : ERRORS.internal;
        this.sendError(response, httpError);
        return;
      }
      if (body.byteLength > 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(request.headers["content-type"] ?? ""))) {
        this.sendError(response, ERRORS.media);
        return;
      }
      if (method.toUpperCase() !== "GET" && body.byteLength === 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(request.headers["content-type"] ?? ""))) {
        this.sendError(response, ERRORS.media);
        return;
      }
      if (requestPath.split("?")[0] === "/healthz" && method.toUpperCase() === "GET") {
        this.send(response, 204);
        return;
      }

      const checked = verifyAgentRequest(request.headers, method, requestPath, body, this.secrets.keys);
      if (!checked.ok) {
        this.log("auth-failed", { reason: checked.reason, remote: request.socket.remoteAddress ?? "unknown" });
        this.sendError(response, ERRORS.unauthorized);
        return;
      }
      keyId = checked.key.id;
      const nonceAdded = this.useNonce(checked.key.id, checked.nonce, Number(checked.timestamp));
      if (!nonceAdded) {
        this.log("auth-failed", { reason: "replayed_nonce", remote: request.socket.remoteAddress ?? "unknown" });
        this.sendError(response, ERRORS.unauthorized);
        return;
      }
      auth = { key: checked.key.bytes, nonce: checked.nonce };
      const limit = this.applyRateLimit(checked.key.id, requestPath);
      if (limit) {
        this.sendError(response, limit, auth);
        return;
      }
      if (this.shuttingDown) {
        this.sendError(response, ERRORS.shuttingDown, auth);
        return;
      }
      await this.dispatch(request, response, body, auth, checked.key.id);
    } catch (error) {
      const safe = safeErrorText(error, [...this.secrets.redact, ...this.exportTokens]);
      this.log("agent-error", { route: routeModel(requestPath), code: error instanceof HistosPublishError ? error.code : "internal", message: safe });
      if (!response.headersSent) this.sendError(response, ERRORS.internal, auth);
    } finally {
      this.log("request", {
        method: method.toUpperCase(), route: routeModel(requestPath), status: response.statusCode,
        ...(keyId === undefined ? {} : { key: keyId }), ms: Date.now() - startedAt,
      });
    }
  }

  private useNonce(keyId: string, nonce: string, timestamp: number): boolean {
    try {
      this.database.prepare("INSERT INTO nonces(key_id, nonce, seen_at) VALUES (?, ?, ?)").run(keyId, nonce, timestamp);
    } catch { return false; }
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastNonceSweep >= 60) {
      this.lastNonceSweep = now;
      this.database.prepare("DELETE FROM nonces WHERE seen_at < ?").run(now - 900);
    }
    return true;
  }

  private applyRateLimit(keyId: string, requestPath: string): HttpError | null {
    const now = Date.now();
    const requests = (this.requestTimes.get(keyId) ?? []).filter((value) => value > now - 60_000);
    if (requests.length >= this.config.limits.requestsPerMinute) {
      const retryAfter = Math.max(1, Math.ceil(((requests[0] ?? now) + 60_000 - now) / 1000));
      this.requestTimes.set(keyId, requests);
      return apiError(429, "rate_limited", "Hai superato il limite di richieste. Riprova tra poco.", true, retryAfter);
    }
    requests.push(now);
    this.requestTimes.set(keyId, requests);
    const pathOnly = requestPath.split("?")[0] ?? "";
    if (pathOnly !== "/v1/publish" && pathOnly !== "/v1/rollback") return null;
    const writes = (this.publishTimes.get(keyId) ?? []).filter((value) => value > now - 60 * 60 * 1000);
    if (writes.length >= this.config.limits.publishPerHour) {
      const retryAfter = Math.max(1, Math.ceil(((writes[0] ?? now) + 60 * 60 * 1000 - now) / 1000));
      this.publishTimes.set(keyId, writes);
      return apiError(429, "rate_limited", "Hai superato il limite di pubblicazioni. Riprova più tardi.", true, retryAfter);
    }
    writes.push(now);
    this.publishTimes.set(keyId, writes);
    return null;
  }

  private parseJobRow(row: JobRow): AgentJob {
    return {
      id: row.id, type: row.type, status: row.status, phase: row.phase, requestId: row.request_id, keyId: row.key_id,
      release: row.release_version === null ? null : { version: row.release_version, ...(row.release_label === null ? {} : { label: row.release_label }) },
      rollbackTarget: row.rollback_target,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
      progress: JSON.parse(row.progress_json) as JobProgress,
      findings: JSON.parse(row.findings_json) as JobFindings,
      error: row.error_json === null ? null : JSON.parse(row.error_json) as JobError,
      result: row.result_json === null ? null : JSON.parse(row.result_json) as Record<string, unknown>,
    };
  }

  private findJob(id: string): AgentJob | null {
    const cached = this.jobs.get(id);
    if (cached) return cached;
    const row = this.database.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
    return row ? this.parseJobRow(row) : null;
  }

  private persistJob(job: AgentJob): void {
    const secrets = [...this.secrets.redact, ...this.exportTokens];
    const release = redactValue(job.release, secrets) as AgentJob["release"];
    const rollbackTarget = job.rollbackTarget === null ? null : String(redactValue(job.rollbackTarget, secrets));
    const findings = redactValue(job.findings, secrets) as JobFindings;
    const error = redactValue(job.error, secrets) as JobError | null;
    const result = redactValue(job.result, secrets) as Record<string, unknown> | null;
    this.database.prepare("UPDATE jobs SET status=?, phase=?, release_version=?, release_label=?, rollback_target=?, started_at=?, finished_at=?, progress_json=?, findings_json=?, error_json=?, result_json=? WHERE id=?")
      .run(job.status, job.phase, release?.version ?? null, release?.label ?? null, rollbackTarget, job.startedAt, job.finishedAt, JSON.stringify(job.progress), JSON.stringify(findings),
        error === null ? null : JSON.stringify(error), result === null ? null : JSON.stringify(result), job.id);
    this.jobs.set(job.id, job);
  }

  private makeJob(input: JobInput): AgentJob {
    const secrets = [...this.secrets.redact, ...this.exportTokens, ...(input.exportToken ? [input.exportToken] : [])];
    const release = input.release ? redactValue(input.release, secrets) as JobInput["release"] : undefined;
    const rollbackTarget = input.rollbackTarget === undefined ? undefined : String(redactValue(input.rollbackTarget, secrets));
    const safeInput: JobInput = {
      ...input,
      ...(release === undefined ? {} : { release }),
      ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
    };
    const job: AgentJob = {
      id: randomUUID(), type: input.type, status: "queued", phase: null,
      requestId: input.requestId, keyId: input.keyId,
      release: release ?? null, rollbackTarget: rollbackTarget ?? null,
      createdAt: nowIso(), startedAt: null, finishedAt: null,
      progress: { pages: 0, assets: 0, bytes: 0, uploaded: 0, to_upload: 0 },
      findings: { block: 0, warn: 0, items: [] }, error: null, result: null, input: safeInput,
    };
    this.database.prepare(
      "INSERT INTO jobs(id,type,status,phase,request_id,key_id,body_sha256,release_version,release_label,rollback_target,created_at,started_at,finished_at,progress_json,findings_json,error_json,result_json) VALUES(?,?,?,NULL,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,NULL)",
    ).run(job.id, job.type, job.status, input.requestId, input.keyId, input.bodyHash, job.release?.version ?? null, job.release?.label ?? null, job.rollbackTarget, job.createdAt, JSON.stringify(job.progress), JSON.stringify(job.findings));
    this.jobs.set(job.id, job);
    return job;
  }

  private findIdempotent(keyId: string, requestId: string): { job: AgentJob; bodyHash: string } | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE key_id=? AND request_id=?").get(keyId, requestId) as JobRow | undefined;
    if (!row) return null;
    return { job: this.parseJobRow(row), bodyHash: row.body_sha256 };
  }

  private enqueue(job: AgentJob): void {
    const waiting = this.pending[0];
    if (waiting) {
      waiting.status = "superseded";
      waiting.phase = null;
      waiting.finishedAt = nowIso();
      waiting.error = null;
      this.discardJobInput(waiting);
      this.persistJob(waiting);
      this.pending.shift();
      this.log("job-superseded", { id: waiting.id });
    }
    this.pending.push(job);
    this.log("job-queued", { id: job.id, type: job.type });
    queueMicrotask(() => { void this.pump(); });
  }

  private async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    bodyBytes: Buffer,
    auth: { key: Buffer; nonce: string },
    keyId: string,
  ): Promise<void> {
    const method = request.method?.toUpperCase() ?? "";
    const rawPath = request.url ?? "/";
    const pathname = rawPath.split("?")[0] ?? "";
    if (method === "GET" && pathname === "/v1/info") {
      this.send(response, 200, {
        api_version: 1, agent_version: HISTOS_PUBLISH_VERSION, site: { origin: this.config.site.origin },
        cloudflare: { script: this.config.cloudflare.script }, busy: Boolean(this.currentJob),
        limits: { maxPaths: 20000, exportTokenMaxSeconds: 1800 },
      }, auth);
      return;
    }
    if (method === "POST" && pathname === "/v1/publish") {
      const parsed = this.parsePublishBody(bodyBytes);
      if (!parsed) { this.sendError(response, ERRORS.invalidRequest, auth); return; }
      const bodyHash = sha256(bodyBytes);
      const previous = this.findIdempotent(keyId, parsed.request_id);
      if (previous) {
        if (previous.bodyHash !== bodyHash) { this.sendError(response, ERRORS.reused, auth); return; }
        this.send(response, 200, { job: safePublicJob(previous.job, [...this.secrets.redact, ...this.exportTokens]) }, auth);
        return;
      }
      const jobInput: JobInput = {
        type: "publish", requestId: parsed.request_id, keyId, bodyHash,
        release: parsed.release, exportToken: parsed.export_token,
        ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
      };
      const job = this.makeJob(jobInput);
      this.exportTokens.add(parsed.export_token);
      this.enqueue(job);
      this.send(response, 202, { job: safePublicJob(job, [...this.secrets.redact, ...this.exportTokens]) }, auth);
      return;
    }
    if (method === "POST" && pathname === "/v1/rollback") {
      const parsed = this.parseRollbackBody(bodyBytes);
      if (!parsed) { this.sendError(response, ERRORS.invalidRequest, auth); return; }
      const bodyHash = sha256(bodyBytes);
      const previous = this.findIdempotent(keyId, parsed.request_id);
      if (previous) {
        if (previous.bodyHash !== bodyHash) { this.sendError(response, ERRORS.reused, auth); return; }
        this.send(response, 200, { job: safePublicJob(previous.job, [...this.secrets.redact, ...this.exportTokens]) }, auth);
        return;
      }
      const job = this.makeJob({ type: "rollback", requestId: parsed.request_id, keyId, bodyHash, rollbackTarget: parsed.target });
      this.enqueue(job);
      this.send(response, 202, { job: safePublicJob(job, [...this.secrets.redact, ...this.exportTokens]) }, auth);
      return;
    }
    if (method === "GET" && pathname === "/v1/jobs") {
      const query = new URL(rawPath, "http://agent.invalid").searchParams;
      const values = query.getAll("limit");
      const extraKeys = [...query.keys()].filter((key) => key !== "limit");
      const limit = values.length === 0 ? 20 : Number(values[0]);
      if (values.length > 1 || extraKeys.length > 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        this.sendError(response, ERRORS.invalidRequest, auth); return;
      }
      const rows = this.database.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as JobRow[];
      const jobs = rows.map((row) => safePublicJob(this.jobs.get(row.id) ?? this.parseJobRow(row), [...this.secrets.redact, ...this.exportTokens], true));
      this.send(response, 200, { jobs }, auth);
      return;
    }
    const jobPath = /^\/v1\/jobs\/([0-9a-f-]{36})$/u.exec(pathname);
    if (method === "GET" && jobPath?.[1]) {
      if (!UUID_V4.test(jobPath[1])) { this.sendError(response, ERRORS.notFound, auth); return; }
      const job = this.findJob(jobPath[1]);
      if (!job) { this.sendError(response, ERRORS.notFound, auth); return; }
      this.send(response, 200, { job: safePublicJob(job, [...this.secrets.redact, ...this.exportTokens]) }, auth);
      return;
    }
    const cancelPath = /^\/v1\/jobs\/([0-9a-f-]{36})\/cancel$/u.exec(pathname);
    if (method === "POST" && cancelPath?.[1]) {
      if (!UUID_V4.test(cancelPath[1])) { this.sendError(response, ERRORS.notFound, auth); return; }
      let payload: unknown;
      try { payload = JSON.parse(bodyBytes.toString("utf8")); } catch { this.sendError(response, ERRORS.invalidRequest, auth); return; }
      if (!validateCancelRequest(payload)) { this.sendError(response, ERRORS.invalidRequest, auth); return; }
      const job = this.findJob(cancelPath[1]);
      if (!job) { this.sendError(response, ERRORS.notFound, auth); return; }
      if (new Set<JobStatus>(["complete", "blocked", "failed", "cancelled", "superseded"]).has(job.status)) { this.sendError(response, ERRORS.notCancellable, auth); return; }
      if (job.status === "queued") {
        const index = this.pending.findIndex((item) => item.id === job.id);
        if (index >= 0) this.pending.splice(index, 1);
        job.status = "cancelled"; job.phase = null; job.finishedAt = nowIso(); job.error = null; this.persistJob(job);
        this.discardJobInput(job);
      } else {
        job.controller?.abort();
      }
      this.send(response, 200, { job: safePublicJob(job, [...this.secrets.redact, ...this.exportTokens]) }, auth);
      return;
    }
    if (method === "GET" && pathname === "/v1/deployments") {
      try {
        const deployments = await this.cloudflareClient().listDeployments(this.config.cloudflare.accountId, this.config.cloudflare.script);
        this.send(response, 200, { deployments: deployments.slice(0, 20).map((deployment) => ({
          id: deployment.id, created_on: deployment.created_on ?? null, versions: deployment.versions.slice(0, 20),
          message: typeof deployment.annotations?.["workers/message"] === "string" ? this.redact(deployment.annotations["workers/message"]) : null,
        })) }, auth);
      } catch (error) {
        this.log("agent-error", { route: "/v1/deployments", code: "cloudflare_error", message: safeErrorText(error, this.secrets.redact) });
        this.sendError(response, ERRORS.cloudflare, auth);
      }
      return;
    }
    this.sendError(response, ERRORS.notFound, auth);
  }

  private parsePublishBody(bytes: Buffer): PublishBody | null {
    let body: unknown;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { return null; }
    if (!validatePublishRequest(body)) return null;
    if (!isObject(body) || Object.keys(body).some((key) => !["request_id", "release", "export_token", "paths"].includes(key))) return null;
    if (typeof body.request_id !== "string" || !UUID_V4.test(body.request_id)) return null;
    if (!isObject(body.release) || Object.keys(body.release).some((key) => !["version", "label"].includes(key))) return null;
    if (typeof body.release.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(body.release.version)) return null;
    if (body.release.label !== undefined && (typeof body.release.label !== "string" || body.release.label.length > 120 || /\p{Cc}/u.test(body.release.label))) return null;
    if (typeof body.export_token !== "string") return null;
    const token = EXPORT_TOKEN.exec(body.export_token);
    if (!token) return null;
    const expiry = Number(token[1]);
    const now = Math.floor(Date.now() / 1000);
    if (expiry <= now || expiry > now + 1800) return null;
    let paths: string[] | undefined;
    if (body.paths !== undefined) {
      if (!Array.isArray(body.paths) || body.paths.length > 20000) return null;
      const unique = new Set<string>();
      for (const item of body.paths) {
        if (typeof item !== "string" || item.length < 1 || item.length > 1024 || !item.startsWith("/") || item.startsWith("//")
          || /[?#\\\s\p{Cc}]/u.test(item)) return null;
        let decoded: string;
        try { decoded = decodeURIComponent(item); } catch { return null; }
        if (decoded.split("/").some((part) => part === "." || part === "..")) return null;
        unique.add(item);
      }
      paths = [...unique];
    }
    const release = { version: body.release.version, ...(typeof body.release.label === "string" ? { label: body.release.label } : {}) };
    return { request_id: body.request_id, release, export_token: body.export_token, ...(paths === undefined ? {} : { paths }) };
  }

  private parseRollbackBody(bytes: Buffer): RollbackBody | null {
    let body: unknown;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { return null; }
    if (!validateRollbackRequest(body)) return null;
    if (!isObject(body) || Object.keys(body).some((key) => !["request_id", "target"].includes(key))) return null;
    if (typeof body.request_id !== "string" || !UUID_V4.test(body.request_id) || typeof body.target !== "string" || !/^[0-9a-f-]{8,64}$/u.test(body.target)) return null;
    return { request_id: body.request_id, target: body.target };
  }

  private redact(value: string): string {
    let result = value;
    for (const secret of [...this.secrets.redact, ...this.exportTokens]) if (secret) result = result.replaceAll(secret, "[redatto]");
    return result.slice(0, 1000);
  }

  private discardJobInput(job: AgentJob): void {
    const exportToken = job.input?.exportToken;
    if (exportToken && ![...this.jobs.values()].some((candidate) => candidate !== job
      && (candidate.status === "queued" || candidate.status === "running")
      && candidate.input?.exportToken === exportToken)) {
      this.exportTokens.delete(exportToken);
    }
    delete job.input;
  }

  private cloudflareClient(): CloudflareClient {
    const apiBase = process.env.HISTOS_CLOUDFLARE_API_BASE;
    return new CloudflareClient({ token: this.secrets.cloudflareToken, ...(apiBase ? { apiBase } : {}) });
  }

  private async pump(): Promise<void> {
    if (this.runningPump) return;
    this.runningPump = true;
    try {
      while (this.pending.length > 0 && !this.shuttingDown) {
        const job = this.pending.shift();
        if (!job || job.status !== "queued") continue;
        this.currentJob = job;
        job.status = "running";
        job.startedAt = nowIso();
        job.controller = new AbortController();
        this.persistJob(job);
        this.log("job-started", { id: job.id, type: job.type });
        try {
          if (job.type === "publish") await this.runPublish(job);
          else await this.runRollback(job);
        } catch (error) {
          if (job.stopCode) {
            job.status = "failed";
            job.error = fixedError(job.stopCode);
          } else if (job.controller.signal.aborted && !job.tokenExpired) {
            job.status = "cancelled";
            job.error = null;
          } else {
            job.status = "failed";
            job.error = job.tokenExpired ? fixedError("export_token_expired")
              : job.phase === "upload" || job.phase === "version" || job.phase === "deploy" || job.phase === "rollback"
                ? fixedError(job.phase === "rollback" && error instanceof HistosPublishError && error.code === "rollback-target-unknown" ? "rollback_target_unknown" : "cloudflare_error")
                : errorFor(error, undefined, job.tokenExpired);
            this.log("agent-error", { route: "job", id: job.id, code: job.error.code, message: safeErrorText(error, [...this.secrets.redact, ...this.exportTokens]) });
          }
        } finally {
          job.phase = null;
          job.finishedAt = nowIso();
          this.persistJob(job);
          this.log("job-finished", { id: job.id, type: job.type, status: job.status, ...(job.error ? { error: job.error.code } : {}) });
          this.discardJobInput(job);
          await this.cleanJobBundle(job);
          this.currentJob = null;
        }
      }
    } finally {
      this.runningPump = false;
      if (this.pending.length > 0 && !this.shuttingDown) queueMicrotask(() => { void this.pump(); });
    }
  }

  private setPhase(job: AgentJob, phase: JobPhase): void {
    if (job.phase === phase) return;
    job.phase = phase;
    this.persistJob(job);
    this.log("job-phase", { id: job.id, type: job.type, phase });
  }

  private async runPublish(job: AgentJob): Promise<void> {
    const input = job.input;
    if (!input?.exportToken || !input.release) throw new Error("missing-job-input");
    const tokenMatch = EXPORT_TOKEN.exec(input.exportToken);
    if (!tokenMatch) throw new Error("invalid-export-token");
    const expiresAt = Number(tokenMatch[1]);
    let tokenExpired = false;
    const expiryTimer = setTimeout(() => {
      tokenExpired = true;
      job.tokenExpired = true;
      job.controller?.abort();
    }, Math.max(0, expiresAt * 1000 - Date.now()));
    expiryTimer.unref?.();

    const origin = this.config.site.origin;
    const rawConfig: Record<string, unknown> = {
      schemaVersion: 1,
      name: this.config.site.name,
      source: { kind: "url", path: origin + "/" },
      crawl: { ...this.config.site.crawl, siteManaged: true, ignoreRobots: true, bypassCache: true },
      rewrite: this.config.site.rewrite,
      pagefind: this.config.site.pagefind,
      cloudflare: { accountId: this.config.cloudflare.accountId, script: this.config.cloudflare.script, maxFiles: this.config.cloudflare.maxFiles },
    };
    if (this.config.site.forms) rawConfig.forms = this.config.site.forms;
    const siteConfig = parseSiteConfig(rawConfig);
    const bundlePath = path.join(this.bundleDirectory, job.id);
    let build: Awaited<ReturnType<typeof buildBundle>>;
    try {
      this.setPhase(job, "crawl");
      build = await buildBundle({
        source: siteConfig.source,
        ...(siteConfig.crawl === undefined ? {} : { crawl: siteConfig.crawl }),
        ...(siteConfig.rewrite === undefined ? {} : { rewrite: siteConfig.rewrite }),
        ...(siteConfig.pagefind === undefined ? {} : { pagefind: siteConfig.pagefind }),
        ...(siteConfig.forms ? { forms: siteConfig.forms } : {}),
        outputDirectory: bundlePath,
        ...(siteConfig.crawl?.maxBytes === undefined ? {} : { maxBytes: siteConfig.crawl.maxBytes }),
        crawlConsent: origin,
        privateOrigin: this.config.site.privateNetwork,
        strictOrigin: true,
        originHeaders: { "X-XB-Export": input.exportToken },
        requireEcho: { header: "x-xb-export-render", value: input.exportToken },
        seedPaths: input.paths ?? [],
        notFoundProbe: true,
        blockNativeHistosForms: true,
        forbiddenValues: [...this.secrets.redact, ...this.exportTokens],
        ...(job.controller === undefined ? {} : { signal: job.controller.signal }),
        onEvent: (event: BuildEvent) => {
          if (event.type === "progress") {
            if (event.phase === "crawl") { this.setPhase(job, "crawl"); job.progress.pages = Math.max(job.progress.pages, event.completed); }
            if (event.phase === "assets") { this.setPhase(job, "crawl"); job.progress.assets = Math.max(job.progress.assets, event.completed); }
            if (event.phase === "scan") this.setPhase(job, "scan");
            this.persistJob(job);
          }
        },
      });
    } catch (error) {
      if (tokenExpired) throw new HistosPublishError("Token di esportazione scaduto durante il crawl.", "export-token-expired", 2);
      if (error instanceof HistosPublishError && error.code === "crawl-sensitive-content") {
        job.status = "blocked";
        job.error = fixedError("scan_blocked");
        job.findings = {
          block: 1,
          warn: 0,
          items: [{ code: "agent-secret-content", severity: "block", file: "sorgente" }],
        };
        this.persistJob(job);
        return;
      }
      throw error;
    } finally {
      clearTimeout(expiryTimer);
    }
    if (tokenExpired) throw new HistosPublishError("Token di esportazione scaduto durante il crawl.", "export-token-expired", 2);
    job.progress.pages = Math.max(job.progress.pages, build.pages);
    job.progress.assets = Math.max(job.progress.assets, build.assets);
    job.progress.bytes = Math.max(job.progress.bytes, build.totalBytes);
    job.findings = {
      block: build.findings.filter((item) => item.severity === "block").length,
      warn: build.findings.filter((item) => item.severity === "warn").length,
      items: [...build.findings]
        .sort((left, right) => (left.severity === right.severity ? left.file.localeCompare(right.file, "en") : left.severity === "block" ? -1 : 1))
        .slice(0, 200)
        .map((item) => ({ code: item.code, severity: item.severity, file: item.file })),
    };
    this.persistJob(job);
    if (build.status !== "ready") {
      job.status = "blocked";
      job.error = fixedError("scan_blocked");
      return;
    }
    if (!build.bundlePath) throw new Error("bundle-missing");
    this.setPhase(job, "upload");
    const files = await loadBundleFiles(build.bundlePath);
    planCloudflareManifest(files, this.config.cloudflare.maxFiles);
    job.progress.to_upload = files.length;
    this.persistJob(job);
    const turnstileSecret = this.secrets.turnstileSecret;
    const result = await deployBundle({
      client: this.cloudflareClient(),
      accountId: this.config.cloudflare.accountId,
      script: this.config.cloudflare.script,
      files,
      findings: build.findings,
      ...(build.forms ? { forms: build.forms } : {}),
      ...(turnstileSecret ? { turnstileSecret } : {}),
      message: "Histeon " + input.release.version + (input.release.label ? " — " + input.release.label : ""),
      maxFiles: this.config.cloudflare.maxFiles,
      ...(job.controller === undefined ? {} : { signal: job.controller.signal }),
      onEvent: (event) => {
        if (event.phase === "upload") {
          this.setPhase(job, "upload");
          job.progress.uploaded = Math.max(job.progress.uploaded, event.completed ?? 0);
          job.progress.to_upload = Math.max(job.progress.to_upload, event.total ?? 0);
        } else if (event.phase === "version") this.setPhase(job, "version");
        else if (event.phase === "deploy") this.setPhase(job, "deploy");
        this.persistJob(job);
      },
    });
    job.result = { version_id: result.versionId, deployment_id: result.deployment.id, files: result.files, uploaded: result.uploaded };
    job.status = "complete";
    job.error = null;
    this.persistJob(job);
    await this.keepRecentBundles();
  }

  private async runRollback(job: AgentJob): Promise<void> {
    const target = job.input?.rollbackTarget ?? job.rollbackTarget;
    if (!target) throw new Error("missing-rollback-target");
    this.setPhase(job, "rollback");
    try {
      const deployment = await rollbackVersion({
        client: this.cloudflareClient(), accountId: this.config.cloudflare.accountId,
        script: this.config.cloudflare.script, deploymentOrVersionId: target,
        message: "Ripristino richiesto da Histeon",
        ...(job.controller === undefined ? {} : { signal: job.controller.signal }),
      });
      const version = deployment.versions.find((item) => item.percentage > 0)?.version_id ?? null;
      job.result = { version_id: version, deployment_id: deployment.id };
      job.status = "complete";
      job.error = null;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) throw new HistosPublishError("Versione non trovata.", "rollback-target-unknown", 2);
      throw error;
    }
  }

  private async cleanJobBundle(job: AgentJob): Promise<void> {
    if (job.status === "complete" && this.config.retention.keepBundles > 0) return;
    const target = path.join(this.bundleDirectory, job.id);
    await rm(target, { recursive: true, force: true }).catch((error) => {
      this.log("warning", { code: "bundle-cleanup-failed", id: job.id, message: safeErrorText(error, this.secrets.redact) });
    });
  }

  private async keepRecentBundles(): Promise<void> {
    const keep = this.config.retention.keepBundles;
    const rows = this.database.prepare("SELECT id FROM jobs WHERE status='complete' AND type='publish' ORDER BY finished_at DESC LIMIT -1 OFFSET ?").all(keep) as Array<{ id: string }>;
    for (const row of rows) await rm(path.join(this.bundleDirectory, row.id), { recursive: true, force: true }).catch(() => undefined);
  }

  private async cleanRetention(): Promise<void> {
    try {
      const before = new Date(Date.now() - this.config.retention.jobsDays * 86400_000).toISOString();
      const expired = this.database.prepare("SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?").all(before) as Array<{ id: string }>;
      for (const row of expired) {
        await rm(path.join(this.bundleDirectory, row.id), { recursive: true, force: true }).catch(() => undefined);
        this.database.prepare("DELETE FROM jobs WHERE id=?").run(row.id);
        this.jobs.delete(row.id);
      }
      await this.keepRecentBundles();
      if (expired.length) this.log("retention-cleanup", { jobs: expired.length });
    } catch (error) {
      this.log("warning", { code: "retention-cleanup-failed", message: safeErrorText(error, this.secrets.redact) });
    }
  }
}

export async function startAgent(configPath: string): Promise<AgentRuntime> {
  const service = await AgentService.create(configPath);
  return service.start();
}
