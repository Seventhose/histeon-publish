import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";
import { PROTOTYPE_MAX_BYTES, type CmsProjectCatalog, type PrototypeAssetFetcher } from "@histos-publish/cms";
import { CLIENT_SCRIPT_NAME, connectorDirectory, defaultDataDirectory, SESSION_FILE_NAME } from "@histos-publish/connector/data-directory";
import { plain } from "@histos-publish/connector/errors";
import { cleanClientLabel, freshTimestamp, HEADERS, NonceCache, PROTOCOL_VERSION, sameSignature, sha256Hex, signRequest, signResponse, validNonce, validSignatureFormat } from "@histos-publish/connector/protocol";
import { parseSession, processAlive } from "@histos-publish/connector/session-file";
import { CALL_OPERATIONS, isCallOperation, schemaProblem, type CallOperation } from "@histos-publish/connector/tools";
import type { CmsOperationsContext } from "./cms-api.js";
import type { CmsRemoteCatalog, CmsRemoteSecretStore } from "./cms-remote.js";
import { ConnectorActivity, type ConnectorActivityEntry } from "./connector-activity.js";
import { ensurePrivateDirectory, readPrivateFile, requirePrivateDataDirectory, writeExclusiveFile, writePrivateFileAtomic } from "./connector-files.js";
import { ConnectorOperations, type OperationResult } from "./connector-operations.js";
import { ConnectorWordPress, type ConnectorPushView, type ConnectorWordPressMode } from "./connector-wordpress.js";
import { ConnectorChoices } from "./connector-choices.js";
import { ConnectorImports, type ConnectorImportView } from "./connector-imports.js";
import { requestErrorCode, requestErrorStatus, safeErrorIssues, safeErrorIssuesTotal, safeErrorMessage } from "./http.js";
import { PrototypeInvalidError } from "./prototype-check.js";

/**
 * The AI connector of Histeon Publish (docs/progettazione/histos-cms/16-connettore-ai.md): a second loopback listener,
 * off by default, that serves a closed list of operations to the connector client an agent starts. Requests are
 * HMAC-signed with a key that only lives in <data>/connector/session.json (0600) while the connector is on; every
 * response is signed too. Requests from a browser, with another Host, or not signed are refused before the body is
 * read. Nothing here deploys, publishes, reads settings or secrets, or deletes.
 */

export const CONNECTOR_LIMITS = {
  requestsPerMinute: 120,
  heavyQueue: 4,
  heavyWaitSeconds: 30,
  /** Prototype checks are short and come in bursts from agents in parallel (doc 17 item 2): more of them wait, longer. */
  checkQueue: 16,
  checkWaitSeconds: 120,
  checksPerHour: 120,
  importsPerHour: 30,
  buildsPerHour: 30,
  exportsPerHour: 10,
  wordpressPlansPerHour: 6,
  callBodyBytes: 64 * 1024,
  prototypeBytes: PROTOTYPE_MAX_BYTES,
  responseBytes: 4 * 1024 * 1024,
  connections: 32,
} as const;

/** What a busy answer asks to wait before the next try: the client of the connector waits so much and tries again. */
const BUSY_RETRY_SECONDS = 15;

const SETTING_AUTOSTART = "connector.autoStart";
const SETTING_WORDPRESS = "connector.wordpress";
/** When an agent first got through the gate: the guided connection stays folded from then on (queue E10). */
const SETTING_FIRST_CLIENT = "connector.firstClientAt";
const ROUTES: Record<string, "GET" | "POST"> = { "/v1/hello": "GET", "/v1/call": "POST", "/v1/prototype": "POST" };
/** Operations worth a line in the user's activity log; reads only refresh "last seen". */
const RECORDED = new Set(["checkPrototype", "importPrototype", "build", "exportXbsite", "wordpressPush"]);
/** Processes in this program holding a connector lock: a second server on the same data folder gets a 409. */
const LOCKS_IN_PROCESS = new Set<string>();

export interface ConnectorSettings {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface ConnectorServiceOptions {
  dataDirectory: string;
  appVersion: string;
  /** The bundled client (dist/histos-publish-connector.mjs), copied next to session.json when the connector starts. */
  clientScript?: string;
  /** Where .xbsite exports go; <data>/connector/exports when omitted. */
  exportDirectory?: string;
  cms: () => CmsOperationsContext;
  catalog: CmsProjectCatalog;
  remoteCatalog: CmsRemoteCatalog;
  secretStoreFor: (account: string) => CmsRemoteSecretStore;
  listBuilds: (projectId: string, projectRevision: string) => Promise<Array<Record<string, unknown>>>;
  isRegisteredBuild: (projectId: string, buildId: string) => boolean;
  settings: ConnectorSettings;
  /** Every operation runs inside this, so closing the app waits for it like any CMS request. */
  track: (work: Promise<unknown>) => void;
  fetchPrototypeAsset?: PrototypeAssetFetcher;
  /** Test seam: free space required before imports, builds and exports (default 1 GiB). */
  minFreeBytes?: number;
  /**
   * A WordPress send started or stopped waiting for the user: the desktop app shows a system notification and a badge,
   * so a request does not expire while the window is in the background (queue E8).
   */
  onApprovals?: (event: { pending: number; request?: { client: string; host: string; projectName: string; kind?: "wordpress" | "import" } }) => void;
  /** Test seams for the WordPress gate. */
  wordpressPlan?: ConstructorParameters<typeof ConnectorWordPress>[0]["createPlan"];
  wordpressApply?: ConstructorParameters<typeof ConnectorWordPress>[0]["applyPlan"];
}

interface Running {
  server: Server;
  port: number;
  instance: string;
  key: Buffer;
  since: string;
  nonces: NonceCache;
}

interface InFlight {
  controller: AbortController;
  operation: string;
  client: string;
  startedAt: number;
}

class SlidingWindow {
  private readonly times: number[] = [];

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** Seconds to wait, or 0 when the request is counted. */
  take(now = Date.now()): number {
    while (this.times.length && (this.times[0] as number) <= now - this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return Math.max(1, Math.ceil(((this.times[0] as number) + this.windowMs - now) / 1000));
    this.times.push(now);
    return 0;
  }
}

/** Why a heavy operation did not get its turn: the queue was full, or its wait ran out; its place, and how many others wait. */
export interface HeavyBusy {
  position: number;
  waiting: number;
}

/**
 * One heavy operation at a time, in the order they come. A few may wait, each for a bounded time: up to
 * CONNECTOR_LIMITS.heavyQueue of the others for heavyWaitSeconds, and up to checkQueue prototype checks for
 * checkWaitSeconds (doc 17 item 2). A refusal says the place in the queue, so the agent knows it is one at a time.
 */
export class HeavyMutex {
  private busy = false;
  private readonly queue: Array<{ wake: () => void; check: boolean }> = [];

  async acquire(signal: AbortSignal, check = false): Promise<{ release: () => void } | { busy: HeavyBusy } | null> {
    if (!this.busy) {
      this.busy = true;
      return { release: () => this.release() };
    }
    const alike = this.queue.filter((item) => item.check === check).length;
    if (alike >= (check ? CONNECTOR_LIMITS.checkQueue : CONNECTOR_LIMITS.heavyQueue)) return { busy: { position: this.queue.length + 1, waiting: this.queue.length } };
    return new Promise((resolve) => {
      const entry = {
        check,
        wake: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          resolve({ release: () => this.release() });
        },
      };
      const leave = (): number => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        return index + 1;
      };
      // Interrupted or stopped while waiting: null, a cancellation for the caller.
      const cancel = () => {
        leave();
        resolve(null);
      };
      const timer = setTimeout(() => {
        const position = leave();
        resolve({ busy: { position, waiting: this.queue.length } });
      }, (check ? CONNECTOR_LIMITS.checkWaitSeconds : CONNECTOR_LIMITS.heavyWaitSeconds) * 1000);
      signal.addEventListener("abort", cancel, { once: true });
      this.queue.push(entry);
    });
  }

  /** How many wait now. */
  get waiting(): number {
    return this.queue.length;
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next.wake();
    else this.busy = false;
  }
}

class GateRejection extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function mediaType(request: IncomingMessage): string {
  return (header(request, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function readExact(request: IncomingMessage, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (length === 0) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > length) {
        reject(new GateRejection(400, "connector-body-invalid"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => size === length ? resolve(Buffer.concat(chunks)) : reject(new GateRejection(400, "connector-body-invalid")));
    request.on("error", reject);
    request.on("aborted", () => reject(new GateRejection(400, "connector-body-invalid")));
  });
}

/** A signed hello to a port, answered by a connector with this instance within 2 seconds. */
function probeHello(port: number, instance: string, key: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const client = "histos-publish-lock-check";
    const empty = Buffer.alloc(0);
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/v1/hello",
      agent: false,
      setHost: false,
      headers: {
        Host: `127.0.0.1:${port}`,
        Connection: "close",
        "Content-Length": "0",
        [HEADERS.instance]: instance,
        [HEADERS.timestamp]: timestamp,
        [HEADERS.nonce]: nonce,
        [HEADERS.client]: client,
        [HEADERS.signature]: signRequest(key, "GET", "/v1/hello", timestamp, nonce, instance, client, empty),
      },
      timeout: 2_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 4096) request.destroy();
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        const answered = header(response as unknown as IncomingMessage, HEADERS.timestamp);
        const signature = header(response as unknown as IncomingMessage, HEADERS.signature);
        if (response.statusCode !== 200 || !answered || !freshTimestamp(answered) || !validSignatureFormat(signature) || !sameSignature(signResponse(key, 200, nonce, instance, answered, body), signature)) {
          resolve(false);
          return;
        }
        try {
          resolve((JSON.parse(body.toString("utf8")) as { instance?: unknown }).instance === instance);
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

/** The reason of a failure for the activity log: first line, no markup fragments, at most 160 characters. */
function logMessage(message: string): string {
  return plain((message.split("\n")[0] ?? "").replace(/<[^<>]{0,300}>/gu, "‹…›"), 160);
}

function quote(value: string): string {
  if (process.platform === "win32") return /[\s"&|<>^]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
  return /^[A-Za-z0-9_./:=@%+-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

/** Where Node is: the commands carry its absolute path, because Claude Desktop and Codex may start without the
 * shell's PATH (nvm, Homebrew, Volta). Searched in PATH, then in the usual install folders (queue E10). */
export interface NodeRuntime {
  path: string | null;
  version: string | null;
  /** Major version 18 or later, which the connector client needs. */
  supported: boolean;
}

/** Where to look for Node, in order: PATH first, then where installers and version managers put it. */
export async function nodeFolders(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): Promise<string[]> {
  const folders = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter((folder) => (platform === "win32" ? path.win32 : path.posix).isAbsolute(folder));
  if (platform === "win32") folders.push(path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "nodejs"));
  else folders.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(home, ".volta", "bin"));
  try {
    const versions = (await readdir(path.join(home, ".nvm", "versions", "node"))).filter((name) => /^v\d+\.\d+\.\d+$/u.test(name));
    versions.sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
    for (const version of versions) folders.push(path.join(home, ".nvm", "versions", "node", version, "bin"));
  } catch {
    // No nvm.
  }
  return [...new Set(folders)];
}

/**
 * The first Node 18 or later among executable files named node in the folders; if none is, the first that answers
 * `--version` at all (an old system Node must not hide a newer one installed with nvm or Volta).
 */
export async function findNode(folders: string[], platform: NodeJS.Platform = process.platform): Promise<NodeRuntime> {
  const name = platform === "win32" ? "node.exe" : "node";
  let old: NodeRuntime | null = null;
  for (const folder of folders) {
    const candidate = path.join(folder, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (platform !== "win32") await access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const version = await new Promise<string | null>((resolve) => {
      execFile(candidate, ["--version"], { timeout: 3_000, windowsHide: true, maxBuffer: 4096 }, (error, stdout) => resolve(error ? null : /^v\d+\.\d+\.\d+$/u.exec(stdout.trim())?.[0] ?? null));
    });
    if (!version) continue;
    if (Number(version.slice(1).split(".")[0]) >= 18) return { path: candidate, version, supported: true };
    old ??= { path: candidate, version, supported: false };
  }
  return old ?? { path: null, version: null, supported: false };
}

export interface ConnectorSnapshot {
  node: NodeRuntime | null;
  enabled: boolean;
  autoStart: boolean;
  since: string | null;
  running: Array<{ operation: string; client: string; startedAt: string }>;
  /** WordPress sends and project updates waiting for the user's decision. */
  pending: Array<ConnectorPushView | ConnectorImportView>;
  activity: ConnectorActivityEntry[];
  lastSeq: number;
  rejected: number;
  clients: Array<{ name: string; lastSeen: string; calls: number }>;
  /** An agent connected at least once, in this or an earlier session. */
  connectedBefore: boolean;
  commands: Record<string, string>;
  wordpress: ReturnType<ConnectorWordPress["connections"]>;
  exportDirectory: string;
  limits: typeof CONNECTOR_LIMITS;
}

export class ConnectorService {
  readonly directory: string;
  readonly exportDirectory: string;
  private readonly defaultExportDirectory: string;
  private running: Running | null = null;
  private starting: Promise<void> | null = null;
  private rejected = 0;
  private readonly clients = new Map<string, { lastSeen: number; calls: number }>();
  private readonly inFlight = new Set<InFlight>();
  private readonly requestWindow = new SlidingWindow(60_000, CONNECTOR_LIMITS.requestsPerMinute);
  private readonly hourly = {
    checkPrototype: new SlidingWindow(3_600_000, CONNECTOR_LIMITS.checksPerHour),
    importPrototype: new SlidingWindow(3_600_000, CONNECTOR_LIMITS.importsPerHour),
    build: new SlidingWindow(3_600_000, CONNECTOR_LIMITS.buildsPerHour),
    exportXbsite: new SlidingWindow(3_600_000, CONNECTOR_LIMITS.exportsPerHour),
  } as Record<string, SlidingWindow>;
  private readonly heavy = new HeavyMutex();
  private node: NodeRuntime | null = null;
  private nodeSearch: Promise<void> | null = null;
  private nodeCheckedAt = 0;
  readonly activity: ConnectorActivity;
  readonly wordpress: ConnectorWordPress;
  readonly imports: ConnectorImports;
  /** Doc 27: the names of an HTML import that the agent answers (hp_import_choices). */
  readonly choices = new ConnectorChoices();
  private readonly operations: ConnectorOperations;

  constructor(private readonly options: ConnectorServiceOptions) {
    this.directory = connectorDirectory(options.dataDirectory);
    this.defaultExportDirectory = path.join(this.directory, "exports");
    this.exportDirectory = path.resolve(options.exportDirectory ?? this.defaultExportDirectory);
    this.activity = new ConnectorActivity(this.directory);
    this.wordpress = new ConnectorWordPress({
      remoteCatalog: options.remoteCatalog,
      projects: options.catalog,
      secretStoreFor: options.secretStoreFor,
      mode: (connectionId) => this.wordpressMode(connectionId),
      active: () => this.running !== null,
      track: (work) => options.track(work),
      ...(options.wordpressPlan ? { createPlan: options.wordpressPlan } : {}),
      ...(options.wordpressApply ? { applyPlan: options.wordpressApply } : {}),
      onEvent: (view) => {
        try {
          options.onApprovals?.({ pending: this.pendingCount(), ...(view.state === "pending" ? { request: { client: view.client, host: view.host, projectName: view.project.name, kind: "wordpress" } } : {}) });
        } catch {
          // A notification problem never affects the send.
        }
        if (view.state === "pending") return;
        this.activity.add({ client: view.client, operation: "wordpressPush", outcome: view.state === "applied" ? "ok" : "error", ...(view.error ? { code: view.error.code } : {}), durationMs: 0, project: view.project, facts: { state: view.state, host: view.host, new: view.counts.new ?? 0, update: view.counts.update ?? 0, delete: view.counts.delete ?? 0 } });
      },
    });
    this.imports = new ConnectorImports({
      apply: (input) => this.operations.applyApprovedImport(input),
      active: () => this.running !== null,
      track: (work) => options.track(work),
      // The data folder this server runs on (startLocalServer's dataDirectory) may be outside the home and not the
      // default one: a failed update's message names no part of it either.
      privateFolders: [path.resolve(options.dataDirectory)],
      onEvent: (view) => {
        try {
          options.onApprovals?.({ pending: this.pendingCount(), ...(view.state === "pending" ? { request: { client: view.client, host: view.host, projectName: view.project.name, kind: "import" } } : {}) });
        } catch {
          // A notification problem never affects the update.
        }
        if (view.state === "pending" || view.state === "applying") return;
        const result = view.result ?? {};
        const count = (value: unknown) => (typeof value === "number" ? value : 0);
        const facts: Record<string, string | number | boolean> = view.state === "applied"
          ? { state: "applied", result: "aggiornato", changed: count(result.changed), keptLocal: count(result.keptLocal) }
          : { state: view.state };
        this.activity.add({ client: view.client, operation: "importPrototype", outcome: view.state === "applied" ? "ok" : "error", ...(view.error ? { code: view.error.code } : {}), durationMs: 0, project: view.project, file: view.file, facts });
      },
    });
    this.operations = new ConnectorOperations({
      cms: options.cms,
      catalog: options.catalog,
      dataDirectory: options.dataDirectory,
      connectorDirectory: this.directory,
      exportDirectory: this.exportDirectory,
      defaultExportDirectory: this.defaultExportDirectory,
      appVersion: options.appVersion,
      wordpress: this.wordpress,
      imports: this.imports,
      choices: this.choices,
      listBuilds: options.listBuilds,
      isRegisteredBuild: options.isRegisteredBuild,
      ...(options.fetchPrototypeAsset ? { fetchPrototypeAsset: options.fetchPrototypeAsset } : {}),
      ...(options.minFreeBytes === undefined ? {} : { minFreeBytes: options.minFreeBytes }),
      limits: { ...CONNECTOR_LIMITS },
      since: () => this.running?.since ?? null,
    });
  }

  get enabled(): boolean {
    return this.running !== null;
  }

  get autoStart(): boolean {
    return this.options.settings.get<boolean>(SETTING_AUTOSTART) === true;
  }

  setAutoStart(value: boolean): void {
    this.options.settings.set(SETTING_AUTOSTART, value);
  }

  hasWordPressConnection(connectionId: string): boolean {
    return Boolean(this.options.remoteCatalog.get(connectionId));
  }

  wordpressMode(connectionId: string): ConnectorWordPressMode {
    const modes = this.options.settings.get<Record<string, unknown>>(SETTING_WORDPRESS) ?? {};
    const mode = Object.hasOwn(modes, connectionId) ? modes[connectionId] : undefined;
    return mode === "dry-run" || mode === "confirm" || mode === "auto" ? mode : "off";
  }

  setWordPressMode(connectionId: string, mode: ConnectorWordPressMode): void {
    if (!this.options.remoteCatalog.get(connectionId)) throw new HistosPublishError("Collegamento WordPress non trovato.", "cms-remote-connection-missing", 404);
    const current = this.options.settings.get<Record<string, unknown>>(SETTING_WORDPRESS) ?? {};
    const next: Record<string, ConnectorWordPressMode> = {};
    for (const [id, value] of Object.entries(current)) if ((value === "dry-run" || value === "confirm" || value === "auto") && this.options.remoteCatalog.get(id)) next[id] = value;
    if (mode === "off") delete next[connectionId];
    else next[connectionId] = mode;
    this.options.settings.set(SETTING_WORDPRESS, next);
  }

  /** Looks for Node on each start, and again every 15 s while the screen asks and none fit (the user may install it). */
  private searchNode(): void {
    this.nodeSearch ??= nodeFolders().then((folders) => findNode(folders)).then((found) => {
      this.node = found;
    }, () => {
      this.node = { path: null, version: null, supported: false };
    }).finally(() => {
      this.nodeCheckedAt = Date.now();
      this.nodeSearch = null;
    });
  }

  /** Turns the connector on (idempotent). */
  async start(): Promise<void> {
    this.searchNode();
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async open(): Promise<void> {
    await requirePrivateDataDirectory(this.options.dataDirectory);
    await ensurePrivateDirectory(this.directory);
    const instance = randomBytes(16).toString("hex");
    const key = randomBytes(32);
    const since = new Date().toISOString();
    await this.acquireLock(instance, since);
    const server = createServer({ requestTimeout: 120_000, headersTimeout: 10_000 });
    try {
      server.maxConnections = CONNECTOR_LIMITS.connections;
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") reject(new Error("Nessuna porta."));
          else resolve(address.port);
        });
      });
      const running: Running = { server, port, instance, key, since, nonces: new NonceCache() };
      server.on("request", (request: IncomingMessage, response: ServerResponse) => this.handle(running, request, response, false));
      server.on("checkContinue", (request: IncomingMessage, response: ServerResponse) => this.handle(running, request, response, true));
      server.on("clientError", (_error, socket) => socket.destroy());
      // Live before session.json exists, so a client that reads the file at once is never refused.
      this.running = running;
      const session = { v: 1, app: "histos-publish", port, instance, key: key.toString("base64url"), pid: process.pid, appVersion: this.options.appVersion, startedAt: since };
      if (!parseSession(JSON.stringify(session))) throw new HistosPublishError("La versione dell'app non è valida per il connettore.", "connector-start-failed", 500);
      await writePrivateFileAtomic(path.join(this.directory, SESSION_FILE_NAME), `${JSON.stringify(session)}\n`);
      if (this.options.clientScript) await this.copyClient(this.options.clientScript);
    } catch (error) {
      this.running = null;
      // session.json goes before the port is freed, so no client sends to whatever binds the port next.
      await this.removeIfMine(SESSION_FILE_NAME, instance);
      server.close();
      server.closeAllConnections();
      await this.releaseLock(instance);
      throw error;
    }
  }

  /** A fresh copy of the client at every start: always the app's version, and any tampering is repaired. */
  private async copyClient(source: string): Promise<void> {
    await writePrivateFileAtomic(path.join(this.directory, CLIENT_SCRIPT_NAME), await readFile(source));
  }

  private async acquireLock(instance: string, since: string): Promise<void> {
    const file = path.join(this.directory, "lock");
    if (LOCKS_IN_PROCESS.has(file)) throw new HistosPublishError("Il connettore è già attivo in un'altra finestra di Histeon Publish.", "connector-already-active", 409);
    const content = `${JSON.stringify({ pid: process.pid, startedAt: since, instance })}\n`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeExclusiveFile(file, content);
        LOCKS_IN_PROCESS.add(file);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let lock: { pid?: unknown; startedAt?: unknown; instance?: unknown } = {};
        try {
          lock = JSON.parse((await readPrivateFile(file, 4096)) ?? "{}") as typeof lock;
        } catch {
          lock = {};
        }
        if (await this.lockHolderAlive(lock)) {
          throw new HistosPublishError("Il connettore è già attivo in un'altra finestra di Histeon Publish.", "connector-already-active", 409);
        }
        await rm(file, { force: true });
      }
    }
    throw new HistosPublishError("Non riesco a prendere il controllo del connettore.", "connector-start-failed", 500);
  }

  /**
   * Whether a lock left in the folder belongs to a connector that is really running. A live pid is not enough: after
   * a crash and a reboot the pid may belong to any process. A window that took the lock in the last 15 seconds is
   * still starting; otherwise its session.json must carry the same instance and its port must answer a signed hello.
   */
  private async lockHolderAlive(lock: { pid?: unknown; startedAt?: unknown; instance?: unknown }): Promise<boolean> {
    const { pid } = lock;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid || !processAlive(pid)) return false;
    const started = typeof lock.startedAt === "string" ? Date.parse(lock.startedAt) : Number.NaN;
    if (Number.isFinite(started) && Date.now() - started < 15_000) return true;
    let session: ReturnType<typeof parseSession> = null;
    try {
      session = parseSession((await readPrivateFile(path.join(this.directory, SESSION_FILE_NAME), 4096)) ?? "");
    } catch {
      session = null;
    }
    if (!session || session.instance !== lock.instance || session.pid !== pid) return false;
    return probeHello(session.port, session.instance, Buffer.from(session.key, "base64url"));
  }

  private async releaseLock(instance: string): Promise<void> {
    const file = path.join(this.directory, "lock");
    await this.removeIfMine("lock", instance);
    LOCKS_IN_PROCESS.delete(file);
  }

  /** Removes session.json or lock only while it still holds this instance (another window may have taken over). */
  private async removeIfMine(name: string, instance: string): Promise<void> {
    const file = path.join(this.directory, name);
    try {
      const text = await readPrivateFile(file, 4096);
      if (!text) return;
      const value = JSON.parse(text) as { instance?: unknown };
      if (value.instance === instance) await rm(file, { force: true });
    } catch {
      // Not ours, or already gone.
    }
  }

  /**
   * Turns the connector off: no more requests, running operations cancelled, approvals refused, files removed.
   * "user" (Ferma) also clears the restart-at-launch choice; closing the app keeps it.
   */
  async stop(reason: "user" | "app-closing"): Promise<void> {
    if (reason === "user") this.setAutoStart(false);
    await this.starting?.catch(() => undefined);
    const running = this.running;
    if (!running) return;
    this.running = null;
    for (const item of this.inFlight) item.controller.abort();
    this.wordpress.discardAll("Il connettore è stato fermato.");
    this.imports.discardAll("Il connettore è stato fermato.");
    // session.json first: until the port is freed, requests still reach this listener and get 401 (running is
    // null); once it is freed, no client reads a session that points to it, so no body goes to a new owner.
    await this.removeIfMine(SESSION_FILE_NAME, running.instance);
    await new Promise<void>((resolve) => {
      running.server.close(() => resolve());
      running.server.closeAllConnections();
    });
    await this.releaseLock(running.instance);
    await this.operations.discardDrafts();
    await this.activity.flush();
  }

  /** Cancels what the agent is running now ("Interrompi"); the connector stays on. */
  interrupt(): number {
    for (const item of this.inFlight) item.controller.abort();
    return this.inFlight.size + this.imports.interrupt();
  }

  decide(requestId: string, decision: "approve" | "reject"): ConnectorPushView | ConnectorImportView {
    return this.imports.has(requestId) ? this.imports.decide(requestId, decision) : this.wordpress.decide(requestId, decision);
  }

  private pendingCount(): number {
    return this.wordpress.approvals().length + this.imports.approvals().length;
  }

  commands(): Record<string, string> {
    const script = path.join(this.directory, CLIENT_SCRIPT_NAME);
    // The agent's client does not inherit HISTOS_PUBLISH_DATA_DIR: compare with the folder it would find on its own.
    const { HISTOS_PUBLISH_DATA_DIR: _override, ...environment } = process.env;
    const extra = path.resolve(this.options.dataDirectory) === path.resolve(defaultDataDirectory(environment)) ? [] : ["--data-dir", this.options.dataDirectory];
    const args = [script, "mcp", ...extra];
    // The absolute path when Node was found: apps started from the desktop do not see the shell's PATH.
    const node = this.node?.supported && this.node.path ? this.node.path : "node";
    const line = [node, ...args].map(quote).join(" ");
    return {
      claudeCode: `claude mcp add --scope user histos-publish -- ${line}`,
      codex: `codex mcp add histos-publish -- ${line}`,
      codexToml: `[mcp_servers.histos-publish]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 180\n`,
      // ChatGPT's desktop app starts local stdio servers too, and shares Codex's ~/.codex/config.toml: the same block,
      // or its own form (Settings → MCP servers → Add server → STDIO) with this command.
      chatgptDesktop: line,
      chatgptToml: `[mcp_servers.histos-publish]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 180\n`,
      claudeDesktop: `${JSON.stringify({ mcpServers: { "histos-publish": { command: node, args } } }, null, 2)}\n`,
      generic: line,
      // Typed in a terminal, which has the PATH; a quoted path first would not even run in PowerShell.
      cli: ["node", script, "help", ...extra].map(quote).join(" "),
    };
  }

  snapshot(after = 0): ConnectorSnapshot {
    if (!this.nodeSearch && (!this.node || (!this.node.supported && Date.now() - this.nodeCheckedAt > 15_000))) this.searchNode();
    return {
      node: this.node,
      enabled: this.running !== null,
      autoStart: this.autoStart,
      since: this.running?.since ?? null,
      running: [...this.inFlight].map((item) => ({ operation: item.operation, client: item.client, startedAt: new Date(item.startedAt).toISOString() })),
      pending: [...this.wordpress.approvals(), ...this.imports.approvals()],
      activity: this.activity.list(after),
      lastSeq: this.activity.lastSeq,
      rejected: this.rejected,
      clients: [...this.clients].map(([name, value]) => ({ name, lastSeen: new Date(value.lastSeen).toISOString(), calls: value.calls })).sort((left, right) => right.lastSeen.localeCompare(left.lastSeen)).slice(0, 10),
      connectedBefore: this.clients.size > 0 || typeof this.options.settings.get<string>(SETTING_FIRST_CLIENT) === "string",
      commands: this.commands(),
      wordpress: this.wordpress.connections(),
      exportDirectory: this.exportDirectory,
      limits: CONNECTOR_LIMITS,
    };
  }

  // ------------------------------------------------------------------------------------------------ the gate

  private reject(response: ServerResponse, request: IncomingMessage, status: number, code: string): void {
    if (status === 401 || status === 403) this.rejected += 1;
    const message = status === 401 ? "Non autorizzato." : status === 403 ? "Richiesta rifiutata." : status === 404 ? "Non trovato." : status === 405 ? "Metodo non consentito." : status === 411 ? "Serve Content-Length." : status === 413 ? "Richiesta troppo grande." : status === 415 ? "Tipo di contenuto non accettato." : "Richiesta non valida.";
    const body = JSON.stringify({ error: message, code: status === 401 ? "connector-unauthorized" : code });
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", Connection: "close", "X-Content-Type-Options": "nosniff" });
    // The body of a refused request is never read: the socket goes once the answer is out.
    response.end(body, () => request.destroy());
  }

  private signed(running: Running, response: ServerResponse, nonce: string, status: number, value: Record<string, unknown>, extra: Record<string, string> = {}): void {
    if (response.headersSent || response.destroyed) return;
    let body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.byteLength > CONNECTOR_LIMITS.responseBytes) {
      status = 500;
      body = Buffer.from(JSON.stringify({ error: "La risposta sarebbe troppo grande.", code: "connector-response-too-large" }), "utf8");
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
      Connection: "close",
      "X-Content-Type-Options": "nosniff",
      [HEADERS.timestamp]: timestamp,
      [HEADERS.signature]: signResponse(running.key, status, nonce, running.instance, timestamp, body),
      ...extra,
    });
    response.end(body);
  }

  private handle(running: Running, request: IncomingMessage, response: ServerResponse, expectContinue: boolean): void {
    void this.serve(running, request, response, expectContinue).catch((error: unknown) => {
      if (error instanceof GateRejection) this.reject(response, request, error.status, error.code);
      else if (!response.headersSent) this.reject(response, request, 400, "connector-request-invalid");
      else response.destroy();
    });
  }

  private async serve(running: Running, request: IncomingMessage, response: ServerResponse, expectContinue: boolean): Promise<void> {
    const method = request.method ?? "";
    // 1. Exact Host: no DNS rebinding, no "localhost".
    if (header(request, "host") !== `127.0.0.1:${running.port}`) throw new GateRejection(403, "connector-host-rejected");
    // 2. Nothing a browser sends: web pages are refused even with a valid signature.
    if (request.headers.origin !== undefined || request.headers.referer !== undefined || request.headers.cookie !== undefined || Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-"))) {
      throw new GateRejection(403, "connector-browser-rejected");
    }
    // 3. Route and method, with no CORS at all.
    const target = request.url ?? "";
    const queryAt = target.indexOf("?");
    const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
    const route = ROUTES[pathname];
    if (method === "OPTIONS") throw new GateRejection(405, "connector-method-not-allowed");
    if (!route || !Object.hasOwn(ROUTES, pathname)) throw new GateRejection(404, "connector-route-missing");
    if (method !== route) throw new GateRejection(405, "connector-method-not-allowed");
    if (pathname !== "/v1/prototype" && queryAt >= 0) throw new GateRejection(404, "connector-route-missing");
    // 4–7. Signature headers, this instance, a fresh time, an unused nonce. The UI session token never works here.
    if (request.headers["x-histos-token"] !== undefined || request.headers.authorization !== undefined) throw new GateRejection(401, "connector-unauthorized");
    const instance = header(request, HEADERS.instance);
    const timestamp = header(request, HEADERS.timestamp);
    const nonce = header(request, HEADERS.nonce);
    const client = header(request, HEADERS.client);
    const signature = header(request, HEADERS.signature);
    if (!instance || instance !== running.instance || !timestamp || !freshTimestamp(timestamp) || !validNonce(nonce) || !client || cleanClientLabel(client) !== client || !validSignatureFormat(signature)) {
      throw new GateRejection(401, "connector-unauthorized");
    }
    if (running.nonces.has(nonce)) throw new GateRejection(401, "connector-unauthorized");
    // 8. A declared, bounded body of the right type, refused before reading.
    if (request.headers["transfer-encoding"] !== undefined) throw new GateRejection(411, "connector-length-required");
    const declared = header(request, "content-length");
    if (declared === undefined && method !== "GET") throw new GateRejection(411, "connector-length-required");
    if (declared !== undefined && !/^[0-9]{1,10}$/u.test(declared)) throw new GateRejection(400, "connector-body-invalid");
    const length = declared === undefined ? 0 : Number(declared);
    const limit = pathname === "/v1/hello" ? 0 : pathname === "/v1/call" ? CONNECTOR_LIMITS.callBodyBytes : CONNECTOR_LIMITS.prototypeBytes;
    if (length > limit) throw new GateRejection(413, "connector-body-too-large");
    if (pathname === "/v1/call" && mediaType(request) !== "application/json") throw new GateRejection(415, "connector-type-invalid");
    if (pathname === "/v1/prototype" && mediaType(request) !== "text/html") throw new GateRejection(415, "connector-type-invalid");
    // 9. The body, then the MAC over everything.
    if (expectContinue) response.writeContinue();
    const body = await readExact(request, length);
    if (!sameSignature(signRequest(running.key, method, target, timestamp, nonce, instance, client, body), signature)) throw new GateRejection(401, "connector-unauthorized");
    // 10. Only now the nonce is remembered, so nobody without the key can fill the cache.
    const remembered = running.nonces.remember(nonce);
    if (remembered === "replayed") throw new GateRejection(401, "connector-unauthorized");
    if (remembered === "full") {
      this.signed(running, response, nonce, 503, { error: "Troppe richieste in poco tempo: riprova fra qualche minuto.", code: "connector-busy" }, { "Retry-After": "300" });
      return;
    }
    if (this.running !== running) throw new GateRejection(401, "connector-unauthorized");
    // 11. Request rate.
    const wait = this.requestWindow.take();
    if (wait > 0) {
      this.signed(running, response, nonce, 429, { error: `Troppe richieste: al massimo ${CONNECTOR_LIMITS.requestsPerMinute} al minuto.`, code: "connector-rate-limited" }, { "Retry-After": String(wait) });
      return;
    }
    const seen = this.clients.get(client) ?? { lastSeen: 0, calls: 0 };
    this.clients.set(client, { lastSeen: Date.now(), calls: seen.calls + 1 });
    if (this.clients.size > 50) this.clients.delete(this.clients.keys().next().value as string);
    if (this.options.settings.get<string>(SETTING_FIRST_CLIENT) === undefined) {
      try {
        this.options.settings.set(SETTING_FIRST_CLIENT, new Date().toISOString());
      } catch {
        // Only the guide's folding depends on it.
      }
    }
    // 12. Dispatch on the closed list.
    if (pathname === "/v1/hello") {
      this.signed(running, response, nonce, 200, { app: "histos-publish", protocol: PROTOCOL_VERSION, instance: running.instance, appVersion: this.options.appVersion });
      return;
    }
    if (pathname === "/v1/call") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        parsed = null;
      }
      const call = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      if (!call || Object.keys(call).some((name) => name !== "operation" && name !== "arguments")) {
        this.signed(running, response, nonce, 400, { error: "Richiesta non valida.", code: "connector-request-invalid" });
        return;
      }
      if (!isCallOperation(call.operation)) {
        this.signed(running, response, nonce, 400, { error: "Operazione sconosciuta.", code: "connector-unknown-operation" });
        return;
      }
      const args = call.arguments === undefined ? {} : call.arguments;
      const problem = schemaProblem(CALL_OPERATIONS[call.operation].schema, args);
      if (problem) {
        this.signed(running, response, nonce, 400, { error: problem, code: "connector-invalid-arguments" });
        return;
      }
      const operation: CallOperation = call.operation;
      await this.run(running, request, response, nonce, client, operation, CALL_OPERATIONS[operation].heavy, (signal) => this.operations.call(operation, args as Record<string, unknown>, { client, signal }));
      return;
    }
    const query = new URLSearchParams(target.slice(queryAt + 1));
    const names = [...query.keys()];
    const allowed = new Set(["mode", "update", "download", "source", "preview", "strict"]);
    const mode = query.get("mode");
    const flag = (name: string) => query.get(name) ?? "0";
    const source = query.get("source") ?? "prototipo.html";
    if (queryAt < 0 || names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length || (mode !== "check" && mode !== "import")
      || !["0", "1"].includes(flag("update")) || !["0", "1"].includes(flag("download")) || !["0", "1"].includes(flag("preview")) || !["0", "1"].includes(flag("strict")) || !/^[A-Za-z0-9._-]{1,120}$/u.test(source)
      || (mode === "check" && flag("update") === "1") || (mode === "import" && (flag("preview") === "1" || flag("strict") === "1"))) {
      this.signed(running, response, nonce, 400, { error: "Parametri del prototipo non validi.", code: "connector-request-invalid" });
      return;
    }
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      this.signed(running, response, nonce, 422, { error: "Il prototipo non è testo UTF-8 valido.", code: "connector-file-invalid" });
      return;
    }
    const operation = mode === "check" ? "checkPrototype" : "importPrototype";
    const sha256 = sha256Hex(body);
    // The file is known before the work starts, so a failure is logged with it too.
    const file = { name: source, bytes: body.byteLength, sha256: sha256.slice(0, 12) };
    // A preview is a build too (A2): it takes one of the hourly builds, only once the prototype proved valid.
    const takeBuild = () => (this.hourly.build?.take() ?? 0) === 0;
    await this.run(running, request, response, nonce, client, operation, true, (signal) => this.operations.prototype({ mode, html, update: flag("update") === "1", download: flag("download") === "1", preview: flag("preview") === "1", strict: flag("strict") === "1", takeBuild, source, sha256, signal, client }), { file });
  }

  private async run(running: Running, request: IncomingMessage, response: ServerResponse, nonce: string, client: string, operation: string, heavy: boolean, work: (signal: AbortSignal) => Promise<OperationResult>, before: { file?: { name: string; bytes: number; sha256: string } } = {}): Promise<void> {
    const item: InFlight = { controller: new AbortController(), operation, client, startedAt: Date.now() };
    const onClose = () => {
      if (!response.writableFinished) item.controller.abort();
    };
    response.on("close", onClose);
    this.inFlight.add(item);
    const started = Date.now();
    const task = (async () => {
      let release: (() => void) | null = null;
      try {
        if (heavy) {
          const turn = await this.heavy.acquire(item.controller.signal, operation === "checkPrototype");
          // Interrupted or stopped while waiting: a cancellation, not "busy, retry in 30 seconds" (the agent would retry).
          if (!turn || item.controller.signal.aborted) {
            if (turn && "release" in turn) turn.release();
            throw new HistosPublishError("Operazione annullata.", "connector-cancelled", 499);
          }
          if ("busy" in turn) {
            // The client signed by the app retries by itself after Retry-After (doc 17 item 2): the agent sees this only past its tries.
            const { position, waiting } = turn.busy;
            this.signed(running, response, nonce, 429, { error: `Histeon Publish fa un'operazione pesante alla volta, e questa non ha avuto il suo turno (posizione in coda: ${position}; altre in attesa: ${waiting}).`, code: "connector-busy", queue: { position, waiting } }, { "Retry-After": String(BUSY_RETRY_SECONDS) });
            return;
          }
          release = turn.release;
        }
        if (item.controller.signal.aborted) throw new HistosPublishError("Operazione annullata.", "connector-cancelled", 499);
        // Counted only when the operation really runs: a refusal for "busy" does not use up the hourly quota.
        const wait = this.hourly[operation]?.take() ?? 0;
        if (wait > 0) {
          this.signed(running, response, nonce, 429, { error: "Limite orario raggiunto per questa operazione: riprova più tardi.", code: "connector-rate-limited" }, { "Retry-After": String(wait) });
          return;
        }
        const result = await work(item.controller.signal);
        this.signed(running, response, nonce, result.status, result.body);
        if (RECORDED.has(operation)) {
          const { outcome, code, ...trace } = result.trace ?? {};
          const failed = (outcome ?? (result.status < 300 ? "ok" : "error")) === "error";
          const failure = code ?? (typeof result.body.code === "string" ? result.body.code : undefined);
          const reason = failed && typeof result.body.error === "string" ? { message: logMessage(result.body.error) } : {};
          this.activity.add({ client, operation, outcome: failed ? "error" : outcome === "pending" ? "pending" : "ok", ...(failed && failure ? { code: failure } : {}), ...reason, durationMs: Date.now() - started, ...before, ...trace });
        }
      } catch (error) {
        const cancelled = item.controller.signal.aborted && !(error instanceof HistosPublishError);
        const status = cancelled ? 499 : error instanceof HistosPublishError && error.exitCode >= 400 && error.exitCode <= 599 ? error.exitCode : requestErrorStatus(error);
        const code = cancelled ? "connector-cancelled" : requestErrorCode(error);
        // The data folder first, then the secret scrub: a long folder name must not be half hidden and then missed.
        const raw = error instanceof Error ? error.message : "Operazione non riuscita.";
        const scrub = (text: string) => text.split(this.options.dataDirectory).join("<dati>");
        // A refused prototype keeps its slugs and template refs (they come from the agent's own file, E4).
        const message = plain(safeErrorMessage(new Error(scrub(raw)), { keepSlugs: error instanceof PrototypeInvalidError }), 1000);
        // E4: a refused prototype lists every problem, so the agent fixes them all in one round; past the first 100,
        // `issuesTotal` says how many there are in all.
        const issues = safeErrorIssues(error, scrub)?.map((issue) => ({ ...issue, ...(issue.document ? { document: plain(issue.document, 200) } : {}), message: plain(issue.message, 600) }));
        const issuesTotal = safeErrorIssuesTotal(error, issues?.length ?? 0);
        this.signed(running, response, nonce, status >= 400 && status <= 599 ? status : 500, { error: message, code, ...(issues?.length ? { issues, ...(issuesTotal ? { issuesTotal } : {}) } : {}) });
        if (RECORDED.has(operation)) this.activity.add({ client, operation, outcome: "error", code, message: logMessage(message), durationMs: Date.now() - started, ...before });
      } finally {
        release?.();
        this.inFlight.delete(item);
        response.off("close", onClose);
      }
    })();
    this.options.track(task);
    await task;
  }
}
