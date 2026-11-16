import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBundle, HistosPublishError } from "@histos-publish/core";
import { decodeStaticPageArchive } from "@histos-publish/cms";
import { ConnectorClient, ConnectorError, defaultDataDirectory, HEADERS, readSessionFile, runTool, signRequest, signResponse, type CallOperation, type ToolValue } from "@histos-publish/connector";
import type { CmsBuildBundle } from "../src/cms-api.js";
import { CmsRemoteCatalog, type CmsSyncPlan, type CmsSyncPlanEntity } from "../src/cms-remote.js";
import { CONNECTOR_LIMITS } from "../src/connector-server.js";
import { startLocalServer, type LocalServerHandle, type LocalServerOptions } from "../src/server.js";

// D2: the project can change right before a media file is linked into the comparison copy, and chosen media files can
// be measured bigger than they are (lstat only, as the backup's sizes are measured); S4: a folder can fail to be made,
// with the error a test chooses; every other call is unchanged.
const fsHooks = vi.hoisted(() => ({ beforeLink: null as null | ((source: string) => void), inflated: new Set<string>(), mkdirFailure: null as null | ((target: string) => Error | null) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      fsHooks.beforeLink?.(String(args[0]));
      return actual.link(...args);
    },
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      const failure = fsHooks.mkdirFailure?.(String(args[0]));
      if (failure) throw failure;
      return actual.mkdir(...args);
    }) as typeof actual.mkdir,
    lstat: (async (...args: unknown[]) => {
      const info = await (actual.lstat as (...input: unknown[]) => Promise<{ size: number | bigint }>)(...args);
      const name = /[0-9a-f]{64}$/u.exec(String(args[0]))?.[0];
      if (name && fsHooks.inflated.has(name)) info.size = typeof info.size === "bigint" ? BigInt(513 * 1024 * 1024) : 513 * 1024 * 1024;
      return info;
    }) as typeof actual.lstat,
  };
});

/**
 * The AI connector end to end inside the app (docs/progettazione/histos-cms/16-connettore-ai.md §6.2): the session API
 * that turns it on and off, the gate in front of the second listener, and the operations with the prototype fixture.
 * Signed calls go through the real client; gate cases are raw requests signed with the protocol helpers.
 */

const FIXTURE_PATH = fileURLToPath(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url));
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");
const FIXTURE_PROJECT_ID = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4YaMBAAL8AS3/gzpXAAAAAElFTkSuQmCC", "base64");
const REMOTE_IMAGE = "https://media.example.test/ehi.png";
const REMOTE_TEXTURE = "https://media.example.test/texture.png";
/** The fixture with both media given by URL: an import or check with downloadRemoteMedia fetches them in order. */
const REMOTE_FIXTURE = FIXTURE
  .replace(/\{ "name": "ehi", "data": "[^"]+",/u, `{ "name": "ehi", "url": "${REMOTE_IMAGE}",`)
  .replace(/\{ "name": "texture", "data": "[^"]+" \}/u, `{ "name": "texture", "url": "${REMOTE_TEXTURE}" }`);
/** Text of the fixture that is content, not a name: it must never reach the activity log. */
const CONTENT_MARKERS = ["Studio Ehi", "Scrivimi", "C'era una volta", "Quadretti, libri"];
const UNAUTHORIZED = JSON.stringify({ error: "Non autorizzato.", code: "connector-unauthorized" });
const POSIX = process.platform !== "win32";

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Session {
  port: number;
  instance: string;
  key: Buffer;
}

function mode(stats: { mode: number }): string {
  return (stats.mode & 0o777).toString(8);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condizione non raggiunta in tempo.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A raw HTTP request on loopback, with exactly the headers given (no Host of its own). */
function send(port: number, input: { method: string; path: string; headers: Record<string, string>; body?: Buffer }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: input.method, path: input.path, headers: input.headers, agent: false, setHost: false });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.end(input.body ?? Buffer.alloc(0));
  });
}

/** Writes only a request head and keeps the socket open: the answer must come without the body ever being sent. */
function headOnly(port: number, head: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Nessuna risposta: il server aspettava il corpo."));
    }, 3_000);
    const finish = () => {
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/iu.exec(data.slice(0, end))?.[1] ?? "0");
      if (Buffer.byteLength(data.slice(end + 4)) < length) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: Number(data.slice(9, 12)), body: data.slice(end + 4) });
    };
    socket.on("connect", () => socket.write(head));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      finish();
    });
    socket.on("error", () => undefined);
  });
}

function signedHeaders(session: Session, method: string, target: string, body: Buffer, options: { timestamp?: string; nonce?: string; instance?: string; contentType?: string } = {}): { headers: Record<string, string>; nonce: string } {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(16).toString("hex");
  const instance = options.instance ?? session.instance;
  const headers: Record<string, string> = {
    Host: `127.0.0.1:${session.port}`,
    Connection: "close",
    "Content-Length": String(body.byteLength),
    [HEADERS.instance]: instance,
    [HEADERS.timestamp]: timestamp,
    [HEADERS.nonce]: nonce,
    [HEADERS.client]: "vitest",
    [HEADERS.signature]: signRequest(session.key, method, target, timestamp, nonce, instance, "vitest", body),
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;
  return { headers, nonce };
}

function signedBy(session: Session, response: RawResponse, nonce: string): boolean {
  const timestamp = response.headers[HEADERS.timestamp];
  const signature = response.headers[HEADERS.signature];
  return typeof timestamp === "string" && signature === signResponse(session.key, response.status, nonce, session.instance, timestamp, response.body);
}

async function rejection(work: Promise<unknown>): Promise<ConnectorError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("La chiamata doveva essere rifiutata.");
}

describe("connettore AI", () => {
  let server: LocalServerHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let workDirectory: string;
  let base: string;
  let children: ChildProcess[];
  let hangBuilds: boolean;
  let hungBuilds: AbortSignal[];
  let fetchedAssets: string[];
  let planCalls: Array<{ action: string; connectionId: string; projectId?: string }>;
  let applyCalls: unknown[];
  let approvalEvents: Array<{ pending: number; request?: { client: string; host: string; projectName: string } }> = [];
  let client: ConnectorClient;
  /** Overrides of the next fake WordPress plan, and an error for the fake apply to throw. */
  let planShape: { applyAllowed?: boolean; counts?: Partial<CmsSyncPlan["counts"]>; entities?: CmsSyncPlanEntity[] };
  let applyFailure: Error | null;
  /** The remote media download the app uses; the default answers at once with a 1×1 PNG. */
  let assetFetcher: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Extra folders a test created, removed after it. */
  let cleanup: string[];

  const bundle: CmsBuildBundle = async (options) => {
    if (!hangBuilds) return buildBundle(options);
    const signal = options.signal as AbortSignal;
    hungBuilds.push(signal);
    return new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("bundle annullato"));
      else signal.addEventListener("abort", () => reject(new Error("bundle annullato")), { once: true });
    });
  };

  const wordpressPlan: NonNullable<NonNullable<LocalServerOptions["connector"]>["wordpressPlan"]> = async (input, catalog) => {
    planCalls.push({ ...input });
    const planId = catalog.saveSyncPlan({ connectionId: input.connectionId, action: input.action, projectId: input.projectId as string, remoteFingerprint: "remoto", localFingerprint: "locale", resolvableConflictIds: [], expiresAt: Date.now() + 600_000 });
    return {
      schemaVersion: 1, planId, action: input.action, connectionId: input.connectionId, project: { id: input.projectId as string, name: "Galleria" }, profile: "histos-static-project-v4",
      initializingRemote: false, expiresAt: new Date(Date.now() + 600_000).toISOString(), applyAllowed: planShape.applyAllowed ?? true,
      counts: { new: 1, update: 0, delete: 0, unchanged: 0, "local-only": 0, "remote-only": 0, conflict: 0, ...planShape.counts },
      entities: planShape.entities ?? [{ id: randomUUID(), kind: "page", label: "Home", status: "new", canResolve: false }], omittedEntities: 0,
    } as unknown as CmsSyncPlan;
  };

  async function start(connector: Partial<NonNullable<LocalServerOptions["connector"]>> = {}): Promise<LocalServerHandle> {
    server = await startLocalServer({
      dataDirectory,
      uiDirectory,
      openBrowser: false,
      secretStoreFactory: () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined }),
      cmsBuildBundle: bundle,
      cmsPrototypeAssetFetcher: (url: string, maxBytes: number, signal?: AbortSignal) => assetFetcher(url, maxBytes, signal),
      connector: {
        appVersion: "0.1.15",
        minFreeBytes: 0,
        wordpressPlan,
        wordpressApply: async (input) => {
          applyCalls.push(input);
          if (applyFailure) throw applyFailure;
          return { complete: true, report: { operationId: "operazione-1", pending: [] } };
        },
        onApprovals: (event) => approvalEvents.push(event),
        ...connector,
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    return server;
  }

  function api(pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    if (!server) throw new Error("Server di test non avviato.");
    return fetch(`${base}${pathname}`, {
      method: init.method ?? "GET",
      headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  async function setConnector(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await api("/api/connector", { method: "POST", body });
    const value = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value;
  }

  async function snapshot(): Promise<Record<string, unknown> & { enabled: boolean; autoStart: boolean; running: unknown[]; pending: unknown[]; activity: Array<Record<string, unknown>>; rejected: number }> {
    const response = await api("/api/connector");
    expect(response.status).toBe(200);
    return await response.json() as Awaited<ReturnType<typeof snapshot>>;
  }

  function session(): Session {
    const read = readSessionFile(dataDirectory);
    if (read.state !== "ok") throw new Error("Il connettore non è acceso.");
    return { port: read.session.port, instance: read.session.instance, key: read.key };
  }

  const tool = (name: string, input: Record<string, unknown> = {}): Promise<ToolValue> => runTool(name, input, { client, cwd: workDirectory });

  /** A signed raw call, for the HTTP status the agent's client turns into an error code. */
  async function signedCall(operation: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const current = session();
    const body = Buffer.from(JSON.stringify({ operation, arguments: args }));
    const { headers, nonce } = signedHeaders(current, "POST", "/v1/call", body, { contentType: "application/json" });
    const response = await send(current.port, { method: "POST", path: "/v1/call", headers, body });
    expect(signedBy(current, response, nonce)).toBe(true);
    return { status: response.status, body: JSON.parse(response.body.toString("utf8")) as Record<string, unknown> };
  }

  /** A signed raw prototype upload; resolves with the signed answer. */
  function signedPrototype(query: string, html: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const current = session();
    const bytes = Buffer.from(html);
    const target = `/v1/prototype?${query}`;
    const { headers, nonce } = signedHeaders(current, "POST", target, bytes, { contentType: "text/html; charset=utf-8" });
    return send(current.port, { method: "POST", path: target, headers, body: bytes }).then((response) => {
      expect(signedBy(current, response, nonce)).toBe(true);
      return { status: response.status, body: JSON.parse(response.body.toString("utf8")) as Record<string, unknown> };
    });
  }

  function addWordPressConnection(): string {
    const remote = new CmsRemoteCatalog(dataDirectory);
    const connectionId = randomUUID();
    try {
      remote.add({ id: connectionId, url: "https://wp.example.test", siteId: randomUUID(), projectId: FIXTURE_PROJECT_ID, projectName: "Galleria", profile: "histos-static-project-v4", read: true, write: true, publish: false });
    } finally {
      remote.close();
    }
    return connectionId;
  }

  /** A download that only ends when its signal aborts (or, if the signal never comes, fails after three seconds). */
  function hangingDownloads(): Array<{ url: string; signal: AbortSignal | undefined }> {
    const fetches: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    assetFetcher = (url, _maxBytes, signal) => {
      fetches.push({ url, signal });
      return new Promise<Uint8Array>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("scaricamento mai interrotto")), 3_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    };
    return fetches;
  }
  const call = (operation: string, args: Record<string, unknown> = {}) => client.call(operation as CallOperation, args);

  async function prototypeFile(name: string, html: string): Promise<string> {
    const target = path.join(workDirectory, name);
    await writeFile(target, html);
    return target;
  }

  async function importFixture(): Promise<string> {
    const imported = await tool("hp_import_prototype", { path: FIXTURE_PATH }) as { result: string; project: { id: string } };
    expect(imported).toMatchObject({ result: "creato", project: { id: FIXTURE_PROJECT_ID, name: "Galleria" } });
    return imported.project.id;
  }

  async function activityLog(): Promise<string> {
    return await readFile(path.join(dataDirectory, "connector", "activity.jsonl"), "utf8").catch(() => "");
  }

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-connector-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-connector-ui-"));
    workDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-connector-work-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    children = [];
    hangBuilds = false;
    hungBuilds = [];
    fetchedAssets = [];
    planCalls = [];
    applyCalls = [];
    approvalEvents = [];
    planShape = {};
    applyFailure = null;
    assetFetcher = async (url) => {
      fetchedAssets.push(url);
      return new Uint8Array(PNG);
    };
    cleanup = [];
    client = new ConnectorClient({ dataDirectory, client: "vitest", busyRetries: 0 });
    await start();
  });

  afterEach(async () => {
    fsHooks.beforeLink = null;
    fsHooks.inflated.clear();
    fsHooks.mkdirFailure = null;
    for (const child of children) child.kill("SIGKILL");
    if (server) await server.close();
    server = null;
    if (process.platform === "linux") {
      const open: string[] = [];
      for (const fd of await readdir("/proc/self/fd").catch(() => [] as string[])) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
        if (target.startsWith(dataDirectory)) open.push(target.slice(dataDirectory.length));
      }
      expect(open, "files left open after the server closed").toEqual([]);
    }
    await Promise.all([dataDirectory, uiDirectory, workDirectory, ...cleanup].map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  });

  describe("ciclo di vita", () => {
    it("è spento di default e solo la sessione dell'app lo può accendere", async () => {
      const state = await snapshot();
      expect(state).toMatchObject({ enabled: false, autoStart: false, since: null, running: [], pending: [] });
      expect(await exists(path.join(dataDirectory, "connector", "session.json"))).toBe(false);
      expect(await tool("hp_status")).toMatchObject({ app: "chiuso o connettore spento" });
      expect(await rejection(call("listProjects"))).toMatchObject({ code: "connector-off" });

      const anonymous = await fetch(`${base}/api/connector`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "auth-required" });
      const foreign = await api("/api/connector", { method: "POST", body: { enabled: true }, headers: { Origin: "http://evil.test" } });
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ code: "origin-rejected" });
      const noOrigin = await fetch(`${base}/api/connector`, { method: "POST", headers: { "X-Histos-Token": (server as LocalServerHandle).token, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
      expect(noOrigin.status).toBe(403);
      const extra = await api("/api/connector", { method: "POST", body: { enabled: true, scope: "tutto" } });
      expect(extra.status).toBe(400);
      expect(await extra.json()).toMatchObject({ code: "connector-request-invalid" });

      expect(await snapshot()).toMatchObject({ enabled: false });
      expect(await exists(path.join(dataDirectory, "connector", "session.json"))).toBe(false);
    });

    it("all'accensione scrive cartella 0700 e session.json 0600, e close() li rimuove", async () => {
      const directory = path.join(dataDirectory, "connector");
      // A folder left too open by someone else is closed again, never trusted as it is.
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);
      const state = await setConnector({ enabled: true });
      expect(state).toMatchObject({ enabled: true, autoStart: false });
      const read = readSessionFile(dataDirectory);
      if (read.state !== "ok") throw new Error("session.json mancante.");
      expect(read.session).toMatchObject({ v: 1, app: "histos-publish", pid: process.pid, appVersion: "0.1.15" });
      expect(read.session.port).not.toBe((server as LocalServerHandle).port);
      if (POSIX) {
        expect(mode(await lstat(directory))).toBe("700");
        expect(mode(await lstat(path.join(directory, "session.json")))).toBe("600");
        expect(mode(await lstat(path.join(directory, "lock")))).toBe("600");
      }
      expect(JSON.parse(await readFile(path.join(directory, "lock"), "utf8"))).toMatchObject({ pid: process.pid, instance: read.session.instance });
      // The key is only in session.json: never in the snapshot or in the commands to copy.
      expect(JSON.stringify(await snapshot())).not.toContain(read.session.key);
      // Turning it on twice keeps the same instance.
      await setConnector({ enabled: true });
      const again = readSessionFile(dataDirectory);
      expect(again.state === "ok" && again.session.instance).toBe(read.session.instance);
      expect(await tool("hp_status")).toMatchObject({ app: "aperto", appVersion: "0.1.15", protocol: 1 });

      await (server as LocalServerHandle).close();
      server = null;
      expect(await exists(path.join(directory, "session.json"))).toBe(false);
      expect(await exists(path.join(directory, "lock"))).toBe(false);
      expect(await rejection(call("listProjects"))).toMatchObject({ code: "connector-off" });
    });

    it("con il lock di un altro processo vivo risponde 409 e non scrive nulla", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
      children.push(child);
      await new Promise((resolve) => child.once("spawn", resolve));
      const directory = path.join(dataDirectory, "connector");
      await mkdir(directory, { mode: 0o700 });
      const lock = `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), instance: "f".repeat(32) })}\n`;
      await writeFile(path.join(directory, "lock"), lock, { mode: 0o600 });
      const response = await api("/api/connector", { method: "POST", body: { enabled: true } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "connector-already-active" });
      expect(await readFile(path.join(directory, "lock"), "utf8")).toBe(lock);
      expect(await exists(path.join(directory, "session.json"))).toBe(false);
      expect(await snapshot()).toMatchObject({ enabled: false });
    });

    it("sostituisce il lock di un processo che non esiste più", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
      await new Promise((resolve) => child.once("spawn", resolve));
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      const directory = path.join(dataDirectory, "connector");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(path.join(directory, "lock"), `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), instance: "f".repeat(32) })}\n`, { mode: 0o600 });
      await setConnector({ enabled: true });
      const read = readSessionFile(dataDirectory);
      expect(JSON.parse(await readFile(path.join(directory, "lock"), "utf8"))).toMatchObject({ pid: process.pid, instance: read.state === "ok" ? read.session.instance : "" });
    });

    it("«Ferma» annulla la build, rifiuta le approvazioni, spegne la riattivazione e rimuove i file", async () => {
      const remote = new CmsRemoteCatalog(dataDirectory);
      const connectionId = randomUUID();
      try {
        remote.add({ id: connectionId, url: "https://wp.example.test", siteId: randomUUID(), projectId: FIXTURE_PROJECT_ID, projectName: "Galleria", profile: "histos-static-project-v4", read: true, write: true, publish: false });
      } finally {
        remote.close();
      }
      expect(await setConnector({ enabled: true, autoStart: true })).toMatchObject({ enabled: true, autoStart: true });
      const setMode = await api(`/api/connector/wordpress/${connectionId}`, { method: "PUT", body: { mode: "confirm" } });
      expect(setMode.status).toBe(200);
      const projectId = await importFixture();

      const pending = await call("wordpressPush", { projectId, connectionId }) as { state: string; requestId: string };
      expect(pending).toMatchObject({ state: "pending", host: "wp.example.test" });
      expect(planCalls).toEqual([{ action: "push", connectionId, projectId }]);
      expect((await snapshot()).pending).toHaveLength(1);

      hangBuilds = true;
      const build = call("build", { projectId });
      build.catch(() => undefined);
      await waitFor(() => hungBuilds.length === 1);
      const stopped = await setConnector({ enabled: false });
      expect(stopped).toMatchObject({ enabled: false, autoStart: false, pending: [] });
      expect(hungBuilds[0]?.aborted).toBe(true);
      expect(await rejection(build)).toBeInstanceOf(ConnectorError);
      await waitFor(async () => (await snapshot()).running.length === 0);
      expect(applyCalls).toEqual([]);
      const approve = await api(`/api/connector/approvals/${pending.requestId}`, { method: "POST", body: { decision: "approve" } });
      expect(approve.status).toBe(404);
      expect(await approve.json()).toMatchObject({ code: "connector-approval-missing" });
      expect((await snapshot()).activity).toContainEqual(expect.objectContaining({ operation: "wordpressPush", outcome: "error", code: "connector-stopped" }));
      expect(await exists(path.join(dataDirectory, "connector", "session.json"))).toBe(false);
      expect(await exists(path.join(dataDirectory, "connector", "lock"))).toBe(false);
      expect(await rejection(call("listProjects"))).toMatchObject({ code: "connector-off" });
    }, 30_000);

    it("«Ferma» lascia session.json e lock di un'altra istanza", async () => {
      await setConnector({ enabled: true });
      const directory = path.join(dataDirectory, "connector");
      const current = readSessionFile(dataDirectory);
      if (current.state !== "ok") throw new Error("session.json mancante.");
      const foreignSession = `${JSON.stringify({ ...current.session, instance: "e".repeat(32), key: randomBytes(32).toString("base64url") })}\n`;
      const foreignLock = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), instance: "e".repeat(32) })}\n`;
      await writeFile(path.join(directory, "session.json"), foreignSession, { mode: 0o600 });
      await writeFile(path.join(directory, "lock"), foreignLock, { mode: 0o600 });
      await setConnector({ enabled: false });
      expect(await readFile(path.join(directory, "session.json"), "utf8")).toBe(foreignSession);
      expect(await readFile(path.join(directory, "lock"), "utf8")).toBe(foreignLock);
      await rm(path.join(directory, "session.json"));
      await rm(path.join(directory, "lock"));
    });

    it("con la riattivazione scelta riparte all'avvio con una chiave nuova", async () => {
      expect(await setConnector({ autoStart: true })).toMatchObject({ enabled: false, autoStart: false });
      await setConnector({ enabled: true, autoStart: true });
      const first = session();
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });
      await (server as LocalServerHandle).close();
      server = null;
      expect(await exists(path.join(dataDirectory, "connector", "session.json"))).toBe(false);

      const restarted = await start();
      expect(await snapshot()).toMatchObject({ enabled: true, autoStart: true });
      const second = session();
      expect(second.instance).not.toBe(first.instance);
      expect(second.key.equals(first.key)).toBe(false);
      // The same client picks the new session up without being restarted.
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });

      await setConnector({ enabled: false });
      await restarted.close();
      server = null;
      await start();
      expect(await snapshot()).toMatchObject({ enabled: false, autoStart: false });
      expect(await exists(path.join(dataDirectory, "connector", "session.json"))).toBe(false);
    });

    /** Records, for every listener that stops accepting, whether session.json was still there at that moment. */
    function watchClose(): { closing: Array<{ port: number | null; session: boolean }>; restore: () => void } {
      const sessionFile = path.join(dataDirectory, "connector", "session.json");
      const closing: Array<{ port: number | null; session: boolean }> = [];
      const original = http.Server.prototype.close;
      const spy = vi.spyOn(http.Server.prototype, "close").mockImplementation(function (this: http.Server, ...args: Parameters<http.Server["close"]>) {
        const address = this.address();
        closing.push({ port: address && typeof address === "object" ? address.port : null, session: existsSync(sessionFile) });
        return original.apply(this, args);
      });
      return { closing, restore: () => spy.mockRestore() };
    }

    it("«Ferma» toglie session.json prima che la porta del connettore smetta di accettare", async () => {
      await setConnector({ enabled: true });
      const { port } = session();
      const watch = watchClose();
      try {
        await setConnector({ enabled: false });
      } finally {
        watch.restore();
      }
      // Once the port is free nobody can read a session that points to it: no body goes to whoever binds it next.
      expect(watch.closing).toEqual([{ port, session: false }]);
      expect(await rejection(call("listProjects"))).toMatchObject({ code: "connector-off" });
    });

    it("se l'accensione fallisce dopo aver scritto session.json lo toglie prima di chiudere la porta", async () => {
      await (server as LocalServerHandle).close();
      server = null;
      // The client copy fails after session.json was written: the failure path of the start.
      await start({ clientScript: path.join(workDirectory, "manca.mjs") });
      const uiPort = (server as LocalServerHandle).port;
      const watch = watchClose();
      const response = await api("/api/connector", { method: "POST", body: { enabled: true } }).finally(() => watch.restore());
      expect(response.status).not.toBe(200);
      expect(watch.closing.filter((item) => item.port !== uiPort)).toEqual([{ port: expect.any(Number), session: false }]);
      expect(await exists(path.join(dataDirectory, "connector", "session.json"))).toBe(false);
      expect(await exists(path.join(dataDirectory, "connector", "lock"))).toBe(false);
      expect(await snapshot()).toMatchObject({ enabled: false });
      expect(await rejection(call("listProjects"))).toMatchObject({ code: "connector-off" });
    });

    async function liveChild(): Promise<number> {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
      children.push(child);
      await new Promise((resolve) => child.once("spawn", resolve));
      return child.pid as number;
    }

    async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
      const listener = http.createServer(handler);
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
      const port = (listener.address() as net.AddressInfo).port;
      return {
        port,
        close: () => new Promise<void>((resolve) => {
          listener.close(() => resolve());
          listener.closeAllConnections();
        }),
      };
    }

    it("sostituisce il lock vecchio di un processo vivo quando nessun connettore risponde per lui", async () => {
      const pid = await liveChild();
      const directory = path.join(dataDirectory, "connector");
      await mkdir(directory, { mode: 0o700 });
      const instance = "f".repeat(32);
      // Older than the 15 seconds a starting window may take: after a crash and a reboot the pid may be anyone's.
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      let strangerHellos = 0;
      const stranger = await listen((_request, response) => {
        // Something else holds the port: it answers the hello, but without the key.
        strangerHellos += 1;
        const body = JSON.stringify({ app: "histos-publish", protocol: 1, instance, appVersion: "0.1.15" });
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
      });
      const spare = await listen(() => undefined);
      await spare.close();
      const sessionFor = (overrides: Record<string, unknown>) => `${JSON.stringify({ v: 1, app: "histos-publish", port: stranger.port, instance, key: randomBytes(32).toString("base64url"), pid, appVersion: "0.1.15", startedAt, ...overrides })}\n`;
      const cases: Array<[string, string | null]> = [
        ["senza session.json", null],
        ["con session.json di un'altra istanza", sessionFor({ instance: "e".repeat(32) })],
        ["con session.json di un altro processo", sessionFor({ pid: process.pid })],
        ["con una porta chiusa", sessionFor({ port: spare.port })],
        ["con una porta che risponde senza la chiave", sessionFor({})],
      ];
      try {
        for (const [name, sessionText] of cases) {
          await writeFile(path.join(directory, "lock"), `${JSON.stringify({ pid, startedAt, instance })}\n`, { mode: 0o600 });
          if (sessionText) await writeFile(path.join(directory, "session.json"), sessionText, { mode: 0o600 });
          else await rm(path.join(directory, "session.json"), { force: true });
          const response = await api("/api/connector", { method: "POST", body: { enabled: true } });
          expect(response.status, name).toBe(200);
          const read = readSessionFile(dataDirectory);
          if (read.state !== "ok") throw new Error(`session.json mancante: ${name}`);
          expect(read.session.pid, name).toBe(process.pid);
          expect(JSON.parse(await readFile(path.join(directory, "lock"), "utf8")), name).toMatchObject({ pid: process.pid, instance: read.session.instance });
          expect(await tool("hp_status"), name).toMatchObject({ app: "aperto" });
          await setConnector({ enabled: false });
        }
      } finally {
        await stranger.close();
      }
      // Only a session.json with the lock's own instance and pid is worth a hello.
      expect(strangerHellos).toBe(1);
    });

    it("con il lock vecchio di un connettore che risponde con la sua chiave resta 409", async () => {
      const pid = await liveChild();
      const directory = path.join(dataDirectory, "connector");
      await mkdir(directory, { mode: 0o700 });
      const instance = "a".repeat(32);
      const key = randomBytes(32);
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const hellos: boolean[] = [];
      const holder = await listen((request, response) => {
        const value = (name: string) => String(request.headers[name] ?? "");
        hellos.push(value(HEADERS.signature) === signRequest(key, "GET", request.url ?? "", value(HEADERS.timestamp), value(HEADERS.nonce), value(HEADERS.instance), value(HEADERS.client), Buffer.alloc(0)));
        const body = Buffer.from(JSON.stringify({ app: "histos-publish", protocol: 1, instance, appVersion: "0.1.15" }));
        const timestamp = String(Math.floor(Date.now() / 1000));
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.byteLength, [HEADERS.timestamp]: timestamp, [HEADERS.signature]: signResponse(key, 200, value(HEADERS.nonce), instance, timestamp, body) });
        response.end(body);
      });
      const lock = `${JSON.stringify({ pid, startedAt, instance })}\n`;
      const sessionText = `${JSON.stringify({ v: 1, app: "histos-publish", port: holder.port, instance, key: key.toString("base64url"), pid, appVersion: "0.1.15", startedAt })}\n`;
      await writeFile(path.join(directory, "lock"), lock, { mode: 0o600 });
      await writeFile(path.join(directory, "session.json"), sessionText, { mode: 0o600 });
      try {
        const response = await api("/api/connector", { method: "POST", body: { enabled: true } });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "connector-already-active" });
      } finally {
        await holder.close();
      }
      expect(hellos).toEqual([true]);
      expect(await readFile(path.join(directory, "lock"), "utf8")).toBe(lock);
      expect(await readFile(path.join(directory, "session.json"), "utf8")).toBe(sessionText);
      expect(await snapshot()).toMatchObject({ enabled: false });
    });

    it.runIf(POSIX)("non parte se la cartella dati è scrivibile da altri utenti", async () => {
      const sessionFile = path.join(dataDirectory, "connector", "session.json");
      try {
        for (const unsafe of [0o777, 0o770]) {
          await chmod(dataDirectory, unsafe);
          const response = await api("/api/connector", { method: "POST", body: { enabled: true } });
          expect(response.status, unsafe.toString(8)).toBe(409);
          expect(await response.json()).toMatchObject({ code: "connector-unsafe-directory" });
          expect(await exists(sessionFile)).toBe(false);
          expect(await snapshot()).toMatchObject({ enabled: false });
        }
        for (const safe of [0o700, 0o755]) {
          await chmod(dataDirectory, safe);
          expect(await setConnector({ enabled: true }), safe.toString(8)).toMatchObject({ enabled: true });
          expect(await exists(sessionFile)).toBe(true);
          await setConnector({ enabled: false });
        }
      } finally {
        await chmod(dataDirectory, 0o700);
      }
    });

    it("trova Node e lo scrive nei comandi; ricorda che un agente si è già collegato (E10)", async () => {
      const before = await snapshot();
      expect(before.connectedBefore).toBe(false);
      await setConnector({ enabled: true });
      let node: { path: string | null; version: string | null; supported: boolean } | null = null;
      await waitFor(async () => {
        node = (await snapshot()).node as typeof node;
        return node !== null;
      });
      const found = node as unknown as { path: string | null; version: string | null; supported: boolean };
      // The test itself runs on a Node new enough, reachable from PATH or the usual folders.
      expect(found.supported).toBe(true);
      expect(path.isAbsolute(found.path as string)).toBe(true);
      const commands = (await snapshot()).commands as Record<string, string>;
      const desktop = JSON.parse(commands.claudeDesktop as string) as { mcpServers: Record<string, { command: string }> };
      expect(desktop.mcpServers["histos-publish"]?.command).toBe(found.path);
      expect(commands.codexToml).toContain(`command = ${JSON.stringify(found.path)}`);
      // ChatGPT desktop: its STDIO form takes the whole command; its file is Codex's, so the block is the same.
      expect(commands.chatgptDesktop).toBe(commands.generic);
      expect(commands.chatgptToml).toBe(commands.codexToml);
      // The command typed in a terminal keeps the bare name: a quoted path first does not run in PowerShell.
      expect(commands.cli?.startsWith("node ")).toBe(true);
      expect((await snapshot()).connectedBefore).toBe(false);
      expect(await tool("hp_status")).toMatchObject({ app: "aperto" });
      expect((await snapshot()).connectedBefore).toBe(true);
      // Remembered after a restart, when no agent has spoken to the new process yet.
      await (server as LocalServerHandle).close();
      server = null;
      await start();
      expect(await snapshot()).toMatchObject({ connectedBefore: true, clients: [] });
    });

    it("i comandi da copiare passano --data-dir se il client non troverebbe da solo la cartella dati", async () => {
      const names = ["HISTOS_PUBLISH_DATA_DIR", "XDG_DATA_HOME", "APPDATA"] as const;
      const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      const lines = (commands: Record<string, string>) => ["claudeCode", "codex", "generic", "cli"].map((name) => commands[name] as string);
      const desktopArgs = (commands: Record<string, string>) => (JSON.parse(commands.claudeDesktop as string) as { mcpServers: Record<string, { args: string[] }> }).mcpServers["histos-publish"]?.args;
      try {
        // Only the app was started with the variable: the agent's client does not inherit it.
        process.env.HISTOS_PUBLISH_DATA_DIR = dataDirectory;
        const pointed = (await snapshot()).commands as Record<string, string>;
        for (const line of lines(pointed)) expect(line).toContain(`--data-dir ${dataDirectory}`);
        expect(desktopArgs(pointed)).toEqual([expect.any(String), "mcp", "--data-dir", dataDirectory]);

        // A data folder at the true platform default: the client finds it on its own.
        const home = await mkdtemp(path.join(os.tmpdir(), "histos-connector-home-"));
        cleanup.push(home);
        process.env.XDG_DATA_HOME = home;
        process.env.APPDATA = home;
        delete process.env.HISTOS_PUBLISH_DATA_DIR;
        const platformDefault = defaultDataDirectory();
        expect(path.dirname(platformDefault)).toBe(home);
        await mkdir(platformDefault, { mode: 0o700 });
        await (server as LocalServerHandle).close();
        server = null;
        cleanup.push(dataDirectory);
        dataDirectory = platformDefault;
        await start();
        const found = (await snapshot()).commands as Record<string, string>;
        for (const line of lines(found)) expect(line).not.toContain("--data-dir");
        expect(desktopArgs(found)).toEqual([path.join(platformDefault, "connector", "histos-publish-connector.mjs"), "mcp"]);
        // Still none when the app itself was pointed there with the variable.
        process.env.HISTOS_PUBLISH_DATA_DIR = platformDefault;
        for (const line of lines((await snapshot()).commands as Record<string, string>)) expect(line).not.toContain("--data-dir");
      } finally {
        for (const name of names) {
          if (saved[name] === undefined) delete process.env[name];
          else process.env[name] = saved[name];
        }
      }
    });
  });

  describe("WordPress", () => {
    it("invia solo con il permesso dell'utente e applica dopo l'approvazione nell'app", async () => {
      const remote = new CmsRemoteCatalog(dataDirectory);
      const connectionId = randomUUID();
      try {
        remote.add({ id: connectionId, url: "https://wp.example.test", siteId: randomUUID(), projectId: FIXTURE_PROJECT_ID, projectName: "Galleria", profile: "histos-static-project-v4", read: true, write: true, publish: false });
      } finally {
        remote.close();
      }
      await setConnector({ enabled: true });
      const projectId = await importFixture();
      expect(await tool("hp_list_wordpress")).toEqual({ sites: [{ connectionId, host: "wp.example.test", projectId, projectName: "Galleria", canWrite: true, mode: "off" }] });
      expect(await rejection(tool("hp_wordpress_push", { projectId, connectionId }))).toMatchObject({ code: "connector-wordpress-off", exitCode: 2 });
      expect(planCalls).toEqual([]);

      // Only the app widens what the connector may do.
      const invalidMode = await api(`/api/connector/wordpress/${connectionId}`, { method: "PUT", body: { mode: "sempre" } });
      expect(invalidMode.status).toBe(400);
      const missing = await api(`/api/connector/wordpress/${randomUUID()}`, { method: "PUT", body: { mode: "auto" } });
      expect(missing.status).toBe(404);
      expect(await (await api(`/api/connector/wordpress/${connectionId}`)).json()).toEqual({ connectionId, mode: "off" });
      expect((await api(`/api/connector/wordpress/${randomUUID()}`)).status).toBe(404);
      expect(await (await api(`/api/connector/wordpress/${connectionId}`, { method: "PUT", body: { mode: "confirm" } })).json()).toEqual({ connectionId, mode: "confirm" });
      // The project's «Siti collegati» card reads the same choice.
      expect(await (await api(`/api/connector/wordpress/${connectionId}`)).json()).toEqual({ connectionId, mode: "confirm" });

      const pending = await tool("hp_wordpress_push", { projectId, connectionId }) as { state: string; requestId: string };
      expect(pending).toMatchObject({ state: "pending", counts: { new: 1 } });
      // The desktop app is told at once, to notify the user even with the window in the background (E8).
      expect(approvalEvents.at(-1)).toEqual({ pending: 1, request: { client: "vitest", host: "wp.example.test", projectName: "Galleria", kind: "wordpress" } });
      expect(planCalls).toEqual([{ action: "push", connectionId, projectId }]);
      expect(await tool("hp_wordpress_push_status", { requestId: pending.requestId })).toMatchObject({ state: "pending" });
      expect((await snapshot()).pending).toEqual([expect.objectContaining({ requestId: pending.requestId, host: "wp.example.test", client: "vitest", project: { id: projectId, name: "Galleria" } })]);

      const waiting = tool("hp_wordpress_push_status", { requestId: pending.requestId, waitSeconds: 10 });
      const approved = await api(`/api/connector/approvals/${pending.requestId}`, { method: "POST", body: { decision: "approve" } });
      expect(approved.status).toBe(200);
      expect(await waiting).toMatchObject({ state: "applied", result: { operationId: "operazione-1", complete: true } });
      expect(applyCalls).toEqual([expect.objectContaining({ connectionId, expectedProjectId: projectId, resolutions: {} })]);
      expect(approvalEvents.at(-1)).toEqual({ pending: 0 });
      const again = await api(`/api/connector/approvals/${pending.requestId}`, { method: "POST", body: { decision: "approve" } });
      expect(again.status).toBe(404);
      expect(await again.json()).toMatchObject({ code: "connector-approval-missing" });
      expect((await snapshot()).activity).toContainEqual(expect.objectContaining({ operation: "wordpressPush", outcome: "ok", facts: expect.objectContaining({ state: "applied", host: "wp.example.test" }) }));

      const manual = await api("/api/connector/manual");
      expect(manual.status).toBe(200);
      expect(manual.headers.get("content-disposition")).toContain("prototipo-histos-manuale-ai.md");
      await waitFor(async () => (await activityLog()).length > 0);
      expect(await (await api("/api/connector/activity", { method: "DELETE" })).json()).toEqual({ cleared: true });
      expect(await exists(path.join(dataDirectory, "connector", "activity.jsonl"))).toBe(false);
      expect((await snapshot()).activity).toEqual([]);
    }, 30_000);

    it("con «solo prove» l'agente fa l'invio di prova, mai quello vero, anche chiamando l'operazione da sé (voce 203)", async () => {
      const connectionId = addWordPressConnection();
      await setConnector({ enabled: true });
      const projectId = await importFixture();
      expect(await (await api(`/api/connector/wordpress/${connectionId}`, { method: "PUT", body: { mode: "dry-run" } })).json()).toEqual({ connectionId, mode: "dry-run" });
      expect(await (await api(`/api/connector/wordpress/${connectionId}`)).json()).toEqual({ connectionId, mode: "dry-run" });
      expect(await tool("hp_list_wordpress")).toMatchObject({ sites: [expect.objectContaining({ connectionId, mode: "dry-run" })] });
      expect(await tool("hp_wordpress_push", { projectId, connectionId, dryRun: true })).toMatchObject({ state: "dry-run", counts: { new: 1 } });
      expect(await rejection(tool("hp_wordpress_push", { projectId, connectionId }))).toMatchObject({ code: "connector-wordpress-dry-run-only" });
      expect(await rejection(tool("hp_wordpress_push", { projectId, connectionId, dryRun: false }))).toMatchObject({ code: "connector-wordpress-dry-run-only" });
      await expect(call("wordpressPush", { projectId, connectionId })).rejects.toMatchObject({ code: "connector-wordpress-dry-run-only" });
      expect(planCalls).toHaveLength(1);
      expect(applyCalls).toEqual([]);
      expect((await snapshot()).pending).toEqual([]);
    });

    it("l'errore di un sito arriva all'agente con l'identità del documento, non come segreto (voce 198)", async () => {
      const connectionId = addWordPressConnection();
      await setConnector({ enabled: true });
      expect((await api(`/api/connector/wordpress/${connectionId}`, { method: "PUT", body: { mode: "auto" } })).status).toBe(200);
      const projectId = await importFixture();
      const documentId = "5c0a7e1b-2d3f-4a5b-8c6d-7e8f9a0b1c2d";
      applyFailure = new HistosPublishError(`Testata: The expression scope is not portable in ${documentId}: url.`, "cms-remote-apply-failed", 502);
      const failed = await call("wordpressPush", { projectId, connectionId }) as { state: string; error: { message: string } };
      applyFailure = null;
      expect(failed).toMatchObject({ state: "failed", error: { code: "cms-remote-apply-failed" } });
      expect(failed.error.message).toContain(`not portable in ${documentId}: url`);
      expect(failed.error.message).not.toContain("segreto rimosso");
    });

    it("registra nell'attività l'esito vero di un invio senza conferma: fallito, con conflitti o applicato", async () => {
      const connectionId = addWordPressConnection();
      await setConnector({ enabled: true });
      expect((await api(`/api/connector/wordpress/${connectionId}`, { method: "PUT", body: { mode: "auto" } })).status).toBe(200);
      const projectId = await importFixture();

      // The call answers 200 in every case: only the activity log tells the user what happened.
      applyFailure = new HistosPublishError("WordPress ha rifiutato l'invio.", "cms-remote-apply-failed", 502);
      expect(await call("wordpressPush", { projectId, connectionId })).toMatchObject({ state: "failed", error: { code: "cms-remote-apply-failed" } });
      applyFailure = null;
      planShape = { applyAllowed: false, counts: { conflict: 1 }, entities: [{ id: randomUUID(), kind: "page", label: "Home", status: "conflict", canResolve: true }] };
      expect(await call("wordpressPush", { projectId, connectionId })).toMatchObject({ state: "not-applicable" });
      planShape = {};
      expect(await call("wordpressPush", { projectId, connectionId })).toMatchObject({ state: "applied" });
      expect(applyCalls).toHaveLength(2);

      const pushes = (await snapshot()).activity.filter((entry) => entry.operation === "wordpressPush");
      expect(pushes).toEqual([
        expect.objectContaining({ client: "vitest", outcome: "error", code: "cms-remote-apply-failed", facts: expect.objectContaining({ state: "failed", host: "wp.example.test" }) }),
        expect.objectContaining({ client: "vitest", outcome: "error", code: "connector-wordpress-conflicts", facts: expect.objectContaining({ state: "not-applicable" }) }),
        expect.objectContaining({ client: "vitest", outcome: "ok", facts: expect.objectContaining({ state: "applied", host: "wp.example.test" }) }),
      ]);
      expect(pushes[2]).not.toHaveProperty("code");
      await waitFor(async () => (await activityLog()).split("\n").filter((line) => line.includes('"wordpressPush"')).length === 3);
      const logged = (await activityLog()).split("\n").filter((line) => line.includes('"wordpressPush"')).map((line) => JSON.parse(line) as { outcome: string; code?: string });
      expect(logged.map((entry) => [entry.outcome, entry.code ?? null])).toEqual([["error", "cms-remote-apply-failed"], ["error", "connector-wordpress-conflicts"], ["ok", null]]);
    }, 30_000);
  });

  describe("barriera d'ingresso", () => {
    beforeEach(async () => {
      await setConnector({ enabled: true });
    });

    it("rifiuta richieste da browser, con un altro Host o con OPTIONS anche se firmate", async () => {
      const current = session();
      for (const extra of [{ Origin: `http://127.0.0.1:${current.port}` }, { "Sec-Fetch-Site": "same-origin" }, { Referer: "http://evil.test/" }, { Cookie: "a=b" }]) {
        const { headers } = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0));
        const response = await send(current.port, { method: "GET", path: "/v1/hello", headers: { ...headers, ...extra } });
        expect(response.status, JSON.stringify(extra)).toBe(403);
        expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ code: "connector-browser-rejected" });
      }
      for (const host of [`localhost:${current.port}`, "evil.test", `127.0.0.1:${current.port + 1}`]) {
        const { headers } = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0));
        const response = await send(current.port, { method: "GET", path: "/v1/hello", headers: { ...headers, Host: host } });
        expect(response.status, host).toBe(403);
        expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ code: "connector-host-rejected" });
      }
      const preflight = await send(current.port, { method: "OPTIONS", path: "/v1/call", headers: { Host: `127.0.0.1:${current.port}`, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-hp-signature" } });
      expect(preflight.status).toBe(405);
      expect(Object.keys(preflight.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
      const unknownRoute = await send(current.port, { method: "GET", path: "/api/cms/v1/projects", headers: { Host: `127.0.0.1:${current.port}` } });
      expect(unknownRoute.status).toBe(404);
    });

    it("chiede Content-Length e risponde 413 senza leggere il corpo", async () => {
      const current = session();
      const body = Buffer.from(JSON.stringify({ operation: "status", arguments: {} }));
      const { headers } = signedHeaders(current, "POST", "/v1/call", body, { contentType: "application/json" });
      const { "Content-Length": _length, ...chunkedHeaders } = headers;
      const chunked = await send(current.port, { method: "POST", path: "/v1/call", headers: { ...chunkedHeaders, "Transfer-Encoding": "chunked" }, body });
      expect(chunked.status).toBe(411);

      for (const [target, length, type] of [["/v1/call", CONNECTOR_LIMITS.callBodyBytes + 1, "application/json"], ["/v1/prototype?mode=check&update=0&download=0&source=a.html", CONNECTOR_LIMITS.prototypeBytes + 1, "text/html"]] as const) {
        const signed = signedHeaders(current, "POST", target, Buffer.alloc(0), { contentType: type }).headers;
        const head = [`POST ${target} HTTP/1.1`, ...Object.entries({ ...signed, "Content-Length": String(length) }).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n");
        const answer = await headOnly(current.port, head);
        expect(answer.status, target).toBe(413);
        expect(JSON.parse(answer.body)).toMatchObject({ code: "connector-body-too-large" });
      }
      const wrongType = signedHeaders(current, "POST", "/v1/call", body, { contentType: "text/plain" });
      expect((await send(current.port, { method: "POST", path: "/v1/call", headers: wrongType.headers, body })).status).toBe(415);
    });

    it("risponde 401 tutti uguali a firme, tempi, nonce, istanze, corpi o query sbagliati", async () => {
      const current = session();
      const bodies: string[] = [];
      const refused = async (input: { method: string; path: string; headers: Record<string, string>; body?: Buffer }) => {
        const response = await send(current.port, input);
        expect(response.status, input.path).toBe(401);
        expect(response.headers[HEADERS.signature]).toBeUndefined();
        bodies.push(response.body.toString("utf8"));
      };
      const before = (await snapshot()).rejected;

      const stale = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0), { timestamp: String(Math.floor(Date.now() / 1000) - 600) });
      await refused({ method: "GET", path: "/v1/hello", headers: stale.headers });

      const fresh = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0));
      const hello = await send(current.port, { method: "GET", path: "/v1/hello", headers: fresh.headers });
      expect(hello.status).toBe(200);
      expect(signedBy(current, hello, fresh.nonce)).toBe(true);
      expect(JSON.parse(hello.body.toString("utf8"))).toEqual({ app: "histos-publish", protocol: 1, instance: current.instance, appVersion: "0.1.15" });
      await refused({ method: "GET", path: "/v1/hello", headers: fresh.headers });

      const foreignInstance = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0), { instance: randomBytes(16).toString("hex") });
      await refused({ method: "GET", path: "/v1/hello", headers: foreignInstance.headers });

      const wrongKey = signedHeaders({ ...current, key: randomBytes(32) }, "GET", "/v1/hello", Buffer.alloc(0));
      await refused({ method: "GET", path: "/v1/hello", headers: wrongKey.headers });

      const body = Buffer.from(JSON.stringify({ operation: "listProjects", arguments: { limit: 10 } }));
      const tampered = Buffer.from(JSON.stringify({ operation: "listProjects", arguments: { limit: 99 } }));
      const tamperedBody = signedHeaders(current, "POST", "/v1/call", body, { contentType: "application/json" });
      await refused({ method: "POST", path: "/v1/call", headers: tamperedBody.headers, body: tampered });

      const html = Buffer.from(FIXTURE);
      const checkTarget = "/v1/prototype?mode=check&update=0&download=0&source=a.html";
      const tamperedQuery = signedHeaders(current, "POST", checkTarget, html, { contentType: "text/html; charset=utf-8" });
      await refused({ method: "POST", path: checkTarget.replace("mode=check", "mode=import"), headers: tamperedQuery.headers, body: html });

      const withToken = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0));
      await refused({ method: "GET", path: "/v1/hello", headers: { ...withToken.headers, "X-Histos-Token": (server as LocalServerHandle).token } });

      expect(new Set(bodies)).toEqual(new Set([UNAUTHORIZED]));
      expect(bodies).toHaveLength(7);
      expect((await snapshot()).rejected).toBe(before + 7);
      // The tampered query never became an import.
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });

      // A connector signature means nothing to the session API on the UI port.
      const uiPort = (server as LocalServerHandle).port;
      const onUi = signedHeaders({ ...current, port: uiPort }, "GET", "/api/cms/v1/projects", Buffer.alloc(0));
      const ui = await send(uiPort, { method: "GET", path: "/api/cms/v1/projects", headers: onUi.headers });
      expect(ui.status).toBe(401);
      expect(JSON.parse(ui.body.toString("utf8"))).toMatchObject({ code: "auth-required" });
    });

    it("limita le richieste firmate al minuto con una risposta firmata", async () => {
      const current = session();
      let limited: { response: RawResponse; nonce: string } | null = null;
      for (let index = 0; index <= CONNECTOR_LIMITS.requestsPerMinute && !limited; index++) {
        const { headers, nonce } = signedHeaders(current, "GET", "/v1/hello", Buffer.alloc(0));
        const response = await send(current.port, { method: "GET", path: "/v1/hello", headers });
        if (response.status === 429) limited = { response, nonce };
        else expect(response.status).toBe(200);
      }
      if (!limited) throw new Error("Nessun limite raggiunto.");
      expect(signedBy(current, limited.response, limited.nonce)).toBe(true);
      expect(JSON.parse(limited.response.body.toString("utf8"))).toMatchObject({ code: "connector-rate-limited" });
      expect(Number(limited.response.headers["retry-after"])).toBeGreaterThan(0);
    }, 30_000);

    it("accetta solo le operazioni dell'elenco chiuso, con i loro argomenti", async () => {
      for (const operation of ["deploy", "publish", "deleteProject", "settings", "nope", "__proto__", "constructor", "toString"]) {
        expect(await rejection(call(operation)), operation).toMatchObject({ code: "connector-unknown-operation", exitCode: 2 });
      }
      expect(await rejection(call("status", { extra: true }))).toMatchObject({ code: "connector-invalid-arguments" });
      expect(await rejection(call("getProject", { projectId: "../../etc" }))).toMatchObject({ code: "connector-invalid-arguments" });
      expect(await rejection(call("listProjects", { limit: 1e9 }))).toMatchObject({ code: "connector-invalid-arguments" });
      expect(await rejection(call("getProject", { projectId: randomUUID() }))).toMatchObject({ code: "cms-project-missing" });

      const current = session();
      const body = Buffer.from(JSON.stringify({ operation: "status", arguments: {}, planId: randomUUID() }));
      const extraKey = signedHeaders(current, "POST", "/v1/call", body, { contentType: "application/json" });
      const response = await send(current.port, { method: "POST", path: "/v1/call", headers: extraKey.headers, body });
      expect(response.status).toBe(400);
      expect(signedBy(current, response, extraKey.nonce)).toBe(true);
      expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ code: "connector-request-invalid" });

      const html = Buffer.from(FIXTURE);
      for (const target of ["/v1/prototype?mode=deploy", "/v1/prototype?mode=check&update=1", "/v1/prototype?mode=import&path=/etc/passwd", "/v1/prototype?mode=import&mode=check"]) {
        const signed = signedHeaders(current, "POST", target, html, { contentType: "text/html" });
        const answer = await send(current.port, { method: "POST", path: target, headers: signed.headers, body: html });
        expect(answer.status, target).toBe(400);
        expect(signedBy(current, answer, signed.nonce)).toBe(true);
      }
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });
    });
  });

  describe("operazioni", () => {
    beforeEach(async () => {
      await setConnector({ enabled: true });
    });

    it("Claude dal connettore: la domanda sui nomi aspetta l'agente e la sua risposta diventa la tabella da applicare (doc 27)", async () => {
      expect((await api("/api/import-refine", { method: "PUT", body: { provider: "connettore" } })).status).toBe(200);
      expect(await tool("hp_import_choices")).toMatchObject({ question: null });
      const corpus = fileURLToPath(new URL("../../cms/test/fixtures/import-corpus/utility-tailwind", import.meta.url));
      const files = await Promise.all(["index.html", "tw.css"].map(async (name) => ({ name, bytes: await readFile(path.join(corpus, name)) })));
      const plan = await (await api("/api/imports", { method: "POST", body: { name: "officina", kind: "directory", files: files.map((file) => ({ path: file.name, size: file.bytes.length })) } })).json() as { id: string };
      for (const file of files) {
        const put = await fetch(`${base}/api/imports/${plan.id}/files/${file.name}`, { method: "PUT", headers: { "X-Histos-Token": (server as LocalServerHandle).token, Origin: base, "Content-Type": "application/octet-stream" }, body: file.bytes });
        expect(put.status).toBe(201);
      }
      const converting = api(`/api/imports/${plan.id}/cms-prototype`, { method: "POST", body: { refine: true } }).then(async (response) => ({ status: response.status, body: await response.json() as { prototype: string; refine?: { provider: string; rows: Array<{ id: string; after: string }>; rejected: Array<{ id: string; motivo: string }> } } }));
      const asked = await tool("hp_import_choices", { waitSeconds: 20 }) as { question: { requestId: string; site: string; count: number; system: string; choices: string } };
      expect(asked.question).toMatchObject({ site: "officina", count: 16 });
      expect(asked.question.choices).toContain("classe:header__box");
      expect(asked.question.system).toContain("blocco__elemento");
      const answer = { scelte: [{ id: "classe:header__box", valore: "header__contenitore" }, { id: "classe:header__nav", valore: "Menu Grande" }] };
      expect(await tool("hp_import_choices_answer", { requestId: asked.question.requestId, scelte: JSON.stringify(answer) })).toMatchObject({ received: 2 });
      const converted = await converting;
      expect(converted.status).toBe(200);
      expect(converted.body.refine).toMatchObject({ provider: "connettore", rows: [{ id: "classe:header__box", after: "header__contenitore" }] });
      expect(converted.body.refine?.rejected).toEqual([expect.objectContaining({ id: "classe:header__nav" })]);
      // The prototype changes only when the person applies the rows.
      expect(converted.body.prototype).toContain("header__box");
      expect(await rejection(tool("hp_import_choices_answer", { requestId: asked.question.requestId, scelte: JSON.stringify(answer) }))).toMatchObject({ code: "connector-choices-missing" });
    }, 60_000);

    it("un prototipo rifiutato arriva all'agente con i suoi slug lunghi, non come segreti (E4)", async () => {
      const html = FIXTURE.replace('data-slug="contatti"', 'data-slug="storia-della-nostra-associazione"').replace("<p>Scrivimi.</p>", '<p onclick="a()">Scrivimi.</p>');
      const refused = await signedPrototype("mode=check&update=0&download=0&source=rotto.html", html);
      expect(refused).toMatchObject({ status: 422, body: { code: "cms-prototype-invalid", issues: [expect.objectContaining({ document: "page storia-della-nostra-associazione" })] } });
      expect(refused.body.error).toMatch(/page storia-della-nostra-associazione, riga \d+: /u);
      expect(refused.body).not.toHaveProperty("issuesTotal");
      expect(JSON.stringify(refused.body)).not.toMatch(/segreto rimosso|[0-9a-f]{8}-[0-9a-f]{4}-/u);
      // The same through the agent's tool.
      const invalid = await rejection(tool("hp_check_prototype", { path: await prototypeFile("rotto.html", html) }));
      expect(invalid).toMatchObject({ code: "cms-prototype-invalid", details: { issues: [expect.objectContaining({ document: "page storia-della-nostra-associazione" })] } });
      expect(invalid.message).not.toContain("segreto rimosso");
    });

    it("con preview: true il controllo dà un'anteprima usa-e-getta; il registro tiene l'id, non l'indirizzo (A2)", async () => {
      const checked = await tool("hp_check_prototype", { path: FIXTURE_PATH, preview: true }) as { valid: boolean; preview: { status: string; buildId: string; previewUrl: string } };
      expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "ready" } });
      const home = await fetch(checked.preview.previewUrl);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Studio Ehi");
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });
      // Not a build the agent can read files from or publish.
      expect(await rejection(call("readBuildFile", { projectId: FIXTURE_PROJECT_ID, buildId: checked.preview.buildId }))).toMatchObject({ code: expect.stringMatching(/missing|not-found|invalid/u) });
      await waitFor(async () => (await snapshot()).activity.some((entry) => entry.operation === "checkPrototype"));
      const entry = (await snapshot()).activity.find((item) => item.operation === "checkPrototype") as { facts: Record<string, unknown> };
      expect(entry.facts).toMatchObject({ valid: true, outcome: "create", previewBuildId: checked.preview.buildId });
      const ticket = new URL(checked.preview.previewUrl).pathname.split("/")[2] as string;
      await (server as LocalServerHandle).close();
      server = null;
      // The ticket never reaches the log on disk.
      expect(await readFile(path.join(dataDirectory, "connector", "activity.jsonl"), "utf8")).not.toContain(ticket);
      await start();
      await setConnector({ enabled: true });
      // Without preview the answer has none; with import, the parameter is refused.
      expect(await tool("hp_check_prototype", { path: FIXTURE_PATH })).not.toHaveProperty("preview");
      expect(await signedPrototype("mode=import&update=0&download=0&source=a.html&preview=1", FIXTURE)).toMatchObject({ status: 400, body: { code: "connector-request-invalid" } });
      expect((await signedPrototype("mode=check&update=0&download=0&source=a.html&preview=2", FIXTURE)).status).toBe(400);
      expect(await rejection(tool("hp_import_prototype", { path: FIXTURE_PATH, preview: true }))).toMatchObject({ code: "connector-invalid-arguments" });
    });

    it("con strict: true il controllo dà strict.passed e i problemi con regola, riga e rimedio; senza, la risposta non cambia (F1)", async () => {
      // The fixture lists two queries without {:else}: valid, yet not strict. A copy in the work folder: a checkout
      // under a folder starting with «.» (a worktree in .claude/) would be refused before the check.
      const file = await prototypeFile("severo.html", FIXTURE);
      const checked = await tool("hp_check_prototype", { path: file, strict: true }) as { valid: boolean; strict: { passed: boolean; omitted: number; problems: Array<{ rule: string; level: string; document?: string; line?: number; message: string; fix: string }> } };
      expect(checked).toMatchObject({ valid: true, outcome: "create", strict: { passed: false, omitted: 0 } });
      const loop = checked.strict.problems.find((problem) => problem.rule === "loop-senza-else");
      expect(loop).toMatchObject({ level: "errore", document: expect.any(String), line: expect.any(Number), fix: expect.stringContaining("{:else}") });
      await waitFor(async () => (await snapshot()).activity.some((entry) => entry.operation === "checkPrototype"));
      const entry = (await snapshot()).activity.find((item) => item.operation === "checkPrototype") as { facts: Record<string, unknown> };
      expect(entry.facts).toMatchObject({ valid: true, strictPassed: false, strictProblems: checked.strict.problems.length });
      // Without strict the answer has none; with import, or a value other than 0 and 1, the parameter is refused.
      expect(await tool("hp_check_prototype", { path: file })).not.toHaveProperty("strict");
      expect(await signedPrototype("mode=import&update=0&download=0&source=a.html&strict=1", FIXTURE)).toMatchObject({ status: 400, body: { code: "connector-request-invalid" } });
      expect((await signedPrototype("mode=check&update=0&download=0&source=a.html&strict=2", FIXTURE)).status).toBe(400);
      expect(await rejection(tool("hp_import_prototype", { path: file, strict: true }))).toMatchObject({ code: "connector-invalid-arguments" });
    });

    it("con preview: true un sito che non si costruisce dà all'agente un prototipo non valido, con il motivo (D8)", async () => {
      // Seven nested loops: the import takes them, the renderer stops at six.
      const nested = "{#loop [1] as a}{#loop [1] as b}{#loop [1] as c}{#loop [1] as d}{#loop [1] as e}{#loop [1] as f}{#loop [1] as g}<p>x</p>{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}";
      const html = FIXTURE.replace("<p>Scrivimi.</p>", `<p>Scrivimi.</p>${nested}`).replace('data-slug="contatti" data-title="Contatti" data-template="site/page" data-status="draft"', 'data-slug="contatti" data-title="Contatti" data-template="site/page"');
      const file = await prototypeFile("senza-build.html", html);
      // Before: { valid: true, preview: { status: "unavailable", reason } }, and an agent reading `valid` went on.
      const refused = await rejection(tool("hp_check_prototype", { path: file, preview: true }));
      expect(refused).toMatchObject({ code: "cms-prototype-invalid", details: { issues: [{ message: "La versione del sito si ferma: /contatti/ (template site/page): I loop annidati superano il limite di 6." }] } });
      // Without the preview nothing is built, and the check cannot know.
      expect(await tool("hp_check_prototype", { path: file })).toMatchObject({ valid: true });
    });

    it("con preview: true un prototipo con sole bozze è valido, con l'anteprima non disponibile e il motivo (B2)", async () => {
      const drafts = FIXTURE.replace('data-slug="home" data-title="Home" data-template="site/page">', 'data-slug="home" data-title="Home" data-template="site/page" data-status="draft">');
      // Before (round 5): 422 «La versione del sito si ferma: Il progetto non ha pagine incluse nella versione…».
      expect(await tool("hp_check_prototype", { path: await prototypeFile("bozze.html", drafts), preview: true })).toMatchObject({ valid: true, outcome: "create", preview: { status: "unavailable", reason: "Il progetto non ha pagine incluse nella versione. Seleziona almeno una pagina dal catalogo CMS." } });
    });

    it("con preview: true un sito che la pubblicazione fermerebbe è valido, e l'agente legge i motivi fra gli avvisi (B2)", async () => {
      const leak = FIXTURE.replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti, libri, racconti. Archivio in /home/andrea/sito.</p>");
      const checked = await tool("hp_check_prototype", { path: await prototypeFile("percorso.html", leak), preview: true }) as { valid: boolean; preview: Record<string, unknown>; report: { warnings: string[] } };
      // Before (round 5): 422 «La build bloccherebbe la pubblicazione del sito: index.html: Il contenuto espone un percorso del server.».
      expect(checked).toMatchObject({ valid: true, preview: { status: "unavailable", reason: "Il sito si costruisce, ma i controlli di sicurezza fermerebbero la pubblicazione: i motivi sono fra gli avvisi." } });
      expect(checked.report.warnings).toContainEqual(expect.stringMatching(/^La pubblicazione si fermerebbe: index\.html, riga \d+: Il contenuto espone un percorso del server\. Il file viene da page home, riga 87 del prototipo\.$/u));
      expect(checked.preview).not.toHaveProperty("publishBlocks");
    });

    it("un aggiornamento approvato parte solo sul progetto che l'utente ha visto confrontare (D2)", async () => {
      const projectId = await importFixture();
      const changed = await prototypeFile("nuovo.html", FIXTURE.replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti e viaggi.</p>"));
      const asked = await tool("hp_import_prototype", { path: changed, update: true }) as { requestId: string; counts: Record<string, number> };
      expect(asked.counts).toMatchObject({ update: 1 });
      // Meanwhile the user changes the project in Publish (another page, so no conflict at all).
      const details = await (await api(`/api/cms/v1/projects/${projectId}`)).json() as { pages: Array<{ alias: number; slug: string }> };
      const contacts = details.pages.find((page) => page.slug === "contatti");
      if (!contacts) throw new Error("Pagina contatti mancante.");
      const document = await (await api(`/api/cms/v1/projects/${projectId}/documents/${contacts.alias}`)).json() as { content: string; head: string };
      const saved = await api(`/api/cms/v1/projects/${projectId}/documents/${contacts.alias}`, { method: "POST", body: { content: document.content.replace("Scrivimi.", "Scrivimi qui."), head: document.head } });
      expect(saved.status).toBe(200);
      expect((await api(`/api/connector/approvals/${asked.requestId}`, { method: "POST", body: { decision: "approve" } })).status).toBe(200);
      const followed = await tool("hp_import_status", { requestId: asked.requestId, waitSeconds: 20 });
      expect(followed).toMatchObject({ state: "failed", error: { code: "connector-import-stale" } });
      // Nothing changed and no backup was kept.
      const home = details.pages.find((page) => page.slug === "home");
      if (!home) throw new Error("Home mancante.");
      expect((await (await api(`/api/cms/v1/projects/${projectId}/documents/${home.alias}`)).json() as { content: string }).content).not.toContain("viaggi");
      expect(await exists(path.join(dataDirectory, "connector", "backups", projectId))).toBe(false);
    });

    it("non chiede di approvare un aggiornamento il cui backup non starebbe nei limiti: 413 subito (D2)", async () => {
      // The fixture copied outside folders that start with «.», which the connector does not read from.
      const galleria = await prototypeFile("galleria.html", FIXTURE);
      const imported = await tool("hp_import_prototype", { path: galleria }) as { project: { id: string } };
      const projectId = imported.project.id;
      const details = await (await api(`/api/cms/v1/projects/${projectId}`)).json() as { assets: Array<{ sha256: string }> };
      const [asset] = details.assets;
      if (!asset) throw new Error("Media mancante.");
      // One media file measured at 513 MiB, as a project with a few dozen large photos weighs: the comparison has no
      // size limit, the backup an update saves first has.
      fsHooks.inflated.add(asset.sha256);
      const checked = await tool("hp_check_prototype", { path: galleria });
      expect(checked).toMatchObject({ valid: true, outcome: "update", changes: { added: [], modified: [], conflicts: [] }, backupUnavailable: "Il progetto supera il limite di 512 MiB." });
      const refused = await rejection(tool("hp_import_prototype", { path: galleria, update: true }));
      expect(refused).toMatchObject({ code: "connector-import-too-large", exitCode: 2 });
      expect(refused.message).toMatch(/^Il progetto supera il limite di 512 MiB\. .*né dall'app/u);
      // No request the user could approve only to see it fail, and no backup.
      expect((await snapshot()).pending).toEqual([]);
      expect(approvalEvents.some((event) => event.pending > 0)).toBe(false);
      expect(await exists(path.join(dataDirectory, "connector", "backups"))).toBe(false);
      await waitFor(async () => (await activityLog()).includes("connector-import-too-large"));
      // Once the project fits again, the same file goes to the user as before.
      fsHooks.inflated.clear();
      expect(await tool("hp_import_prototype", { path: galleria, update: true })).toMatchObject({ result: "in-attesa", state: "pending" });
    }, 30_000);

    it("un media danneggiato ferma l'aggiornamento approvato senza salvare un backup che non si ripristina, e le richieste nuove (D2)", async () => {
      const galleria = await prototypeFile("galleria.html", FIXTURE);
      const imported = await tool("hp_import_prototype", { path: galleria }) as { project: { id: string } };
      const projectId = imported.project.id;
      const details = await (await api(`/api/cms/v1/projects/${projectId}`)).json() as { assets: Array<{ sha256: string }>; pages: Array<{ alias: number; slug: string }> };
      const [asset] = details.assets;
      if (!asset) throw new Error("Media mancante.");
      // A request made while the project was sound...
      const changed = await prototypeFile("nuovo.html", FIXTURE.replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti e viaggi.</p>"));
      const asked = await tool("hp_import_prototype", { path: changed, update: true }) as { requestId: string };
      // ...then a media file is truncated in place (a crash, another program): its name stays, its bytes do not.
      const file = path.join(dataDirectory, "histos-projects", projectId, "media", "sha256", asset.sha256.slice(0, 2), asset.sha256);
      const bytes = await readFile(file);
      await writeFile(file, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
      expect((await api(`/api/connector/approvals/${asked.requestId}`, { method: "POST", body: { decision: "approve" } })).status).toBe(200);
      // Before: applied, with a backup the restore refuses («Hash del media non coerente»), which also rotated out an older one.
      const followed = await tool("hp_import_status", { requestId: asked.requestId, waitSeconds: 20 });
      expect(followed).toMatchObject({ state: "failed", error: { code: "cms-backup-unrestorable" } });
      expect(await exists(path.join(dataDirectory, "connector", "backups", projectId))).toBe(false);
      const home = details.pages.find((page) => page.slug === "home");
      if (!home) throw new Error("Home mancante.");
      expect((await (await api(`/api/cms/v1/projects/${projectId}/documents/${home.alias}`)).json() as { content: string }).content).not.toContain("viaggi");
      // A new request is refused at once with the reason, and never reaches the user.
      const refused = await rejection(tool("hp_import_prototype", { path: changed, update: true }));
      expect(refused).toMatchObject({ code: "cms-backup-unrestorable", exitCode: 2 });
      expect(refused.message).toMatch(/è danneggiato: .*l'aggiornamento non si può fare\.$/u);
      expect((await snapshot()).pending).toEqual([]);
    }, 30_000);

    it("un aggiornamento approvato che fallisce non nomina la cartella dati del server, nemmeno fuori dalla home (S4)", async () => {
      // A data folder that is neither in the home nor the default one, with spaces in its last part.
      await (server as LocalServerHandle).close();
      server = null;
      cleanup.push(dataDirectory);
      dataDirectory = path.join(dataDirectory, "Histeon dati di Anna");
      await mkdir(dataDirectory, { mode: 0o700 });
      expect(path.relative(os.homedir(), dataDirectory).startsWith("..") || process.platform === "win32").toBe(true);
      client = new ConnectorClient({ dataDirectory, client: "vitest", busyRetries: 0 });
      await start();
      await setConnector({ enabled: true });
      const galleria = await prototypeFile("galleria.html", FIXTURE);
      await tool("hp_import_prototype", { path: galleria });
      const changed = await prototypeFile("nuovo.html", FIXTURE.replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti e viaggi.</p>"));
      const asked = await tool("hp_import_prototype", { path: changed, update: true }) as { requestId: string };
      // The backup folder cannot be made, with an error that names it in its text only (no `path`, as a wrapper writes it).
      fsHooks.mkdirFailure = (target) => target.endsWith(`${path.sep}backups`) ? new Error(`Non creo la cartella ${target}: permesso negato.`) : null;
      expect((await api(`/api/connector/approvals/${asked.requestId}`, { method: "POST", body: { decision: "approve" } })).status).toBe(200);
      const followed = await tool("hp_import_status", { requestId: asked.requestId, waitSeconds: 20 });
      // Before: «Non creo la cartella [percorso rimosso] dati di Anna/connector/backups: permesso negato.»
      expect(followed).toMatchObject({ state: "failed", error: { code: "connector-import-failed", message: "Non creo la cartella [percorso rimosso]: permesso negato." } });
      expect(JSON.stringify(followed)).not.toContain("di Anna");
    }, 30_000);

    it("un media sostituito durante il confronto chiede di ripetere (409), non di correggere il prototipo (D2)", async () => {
      const galleria = await prototypeFile("galleria.html", FIXTURE);
      await tool("hp_import_prototype", { path: galleria });
      // Right before a media file is linked into the copy, a new file with the same bytes is renamed over it, as
      // storeMediaFile does when it puts back a file that no longer held them (a sound one it keeps, so saving the same
      // image with another alt never does this): the link lands on another inode than the one checked.
      const replaceOnce = () => {
        fsHooks.beforeLink = (linked) => {
          fsHooks.beforeLink = null;
          copyFileSync(linked, `${linked}.nuovo`);
          renameSync(`${linked}.nuovo`, linked);
        };
      };
      for (const work of [() => tool("hp_check_prototype", { path: galleria }), () => tool("hp_import_prototype", { path: galleria, update: true })]) {
        replaceOnce();
        const changed = await rejection(work());
        expect(changed).toMatchObject({ code: "cms-project-changed", exitCode: 2, message: "Il progetto è cambiato durante il confronto: ripeti il controllo." });
      }
      expect((await snapshot()).pending).toEqual([]);
      // Repeated, it works.
      expect(await tool("hp_import_prototype", { path: galleria, update: true })).toMatchObject({ result: "in-attesa" });
    }, 30_000);

    it("controlla, importa, aggiorna con backup e si ferma davanti ai conflitti", async () => {
      const checked = await tool("hp_check_prototype", { path: FIXTURE_PATH });
      expect(checked).toMatchObject({ valid: true, outcome: "create", report: { project: { id: FIXTURE_PROJECT_ID, name: "Galleria" }, counts: { pages: 2 } }, file: { name: "prototipo-esempio.html", path: FIXTURE_PATH } });
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [], omitted: 0 });
      expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".prototype"))).toEqual([]);

      const broken = await prototypeFile("rotto.html", FIXTURE.replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p>\n  {#if}"));
      const invalid = await rejection(tool("hp_check_prototype", { path: broken }));
      expect(invalid).toMatchObject({ code: "cms-prototype-invalid", exitCode: 2 });
      expect(invalid.message).toMatch(/page contatti, riga \d+, colonna 3: /u);
      // E4: the agent gets the list too, to fix every problem in one round.
      expect((invalid as { details?: { issues?: Array<{ document: string; line: number; column: number }> } }).details?.issues).toEqual([expect.objectContaining({ document: "page contatti", column: 3 })]);

      const projectId = await importFixture();
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [{ id: projectId, name: "Galleria" }] });
      // D1: the app keeps the agent's import report, with who imported and from which file.
      const stored = await api(`/api/cms/v1/projects/${projectId}/import-report`);
      expect(stored.status).toBe(200);
      expect((await stored.json() as { report: unknown }).report).toMatchObject({ source: { kind: "agent", client: "vitest" }, file: "prototipo-esempio.html", result: "created", counts: { pages: 2 } });
      expect(await tool("hp_project", { projectId })).toMatchObject({ project: { id: projectId }, fromFile: true, posts: 1 });
      expect(await tool("hp_check_prototype", { path: FIXTURE_PATH })).toMatchObject({ valid: true, outcome: "update", existingProject: { id: projectId, name: "Galleria" }, changes: { added: [], modified: [], conflicts: [] } });

      const refused = await rejection(tool("hp_import_prototype", { path: FIXTURE_PATH }));
      expect(refused).toMatchObject({ code: "cms-prototype-update-requires-flag" });
      expect(await exists(path.join(dataDirectory, "connector", "backups"))).toBe(false);

      // D2: update: true does not update at once; it asks the user in the app, with what would change.
      const asked = await tool("hp_import_prototype", { path: FIXTURE_PATH, update: true }) as { result: string; requestId: string };
      expect(asked).toMatchObject({ result: "in-attesa", kind: "import", state: "pending", project: { id: projectId, name: "Galleria" }, file: { name: "prototipo-esempio.html" }, counts: { new: 0, update: 0, delete: 0 } });
      expect(await exists(path.join(dataDirectory, "connector", "backups"))).toBe(false);
      expect((await snapshot()).pending).toEqual([expect.objectContaining({ kind: "import", requestId: asked.requestId })]);
      expect(approvalEvents.at(-1)).toMatchObject({ pending: 1, request: { kind: "import", projectName: "Galleria", client: "vitest" } });
      // Refused: nothing changes and the agent sees why.
      const refusedAnswer = await api(`/api/connector/approvals/${asked.requestId}`, { method: "POST", body: { decision: "reject" } });
      expect(refusedAnswer.status).toBe(200);
      expect(await tool("hp_import_status", { requestId: asked.requestId })).toMatchObject({ state: "rejected", error: { code: "connector-import-rejected" } });
      expect(await exists(path.join(dataDirectory, "connector", "backups"))).toBe(false);
      // Approved: backup first, then the update; the agent follows it with hp_import_status.
      const second = await tool("hp_import_prototype", { path: FIXTURE_PATH, update: true }) as { requestId: string };
      const approvedAnswer = await api(`/api/connector/approvals/${second.requestId}`, { method: "POST", body: { decision: "approve" } });
      expect(approvedAnswer.status).toBe(200);
      const followed = await tool("hp_import_status", { requestId: second.requestId, waitSeconds: 20 }) as { state: string; result: { result: string; backup: string } };
      expect(followed).toMatchObject({ state: "applied", result: { result: "aggiornato", project: { id: projectId } } });
      expect((await snapshot()).pending).toEqual([]);
      const updated = followed.result;
      expect(updated.backup).toMatch(/^\d{8}-\d{6}Z-[0-9a-f]{6}\.histosproject$/u);
      const backups = path.join(dataDirectory, "connector", "backups");
      const backupFile = path.join(backups, projectId, updated.backup);
      expect((await stat(backupFile)).size).toBeGreaterThan(0);
      if (POSIX) {
        expect(mode(await stat(backupFile))).toBe("600");
        expect(mode(await stat(backups))).toBe("700");
        expect(mode(await stat(path.join(backups, projectId)))).toBe("700");
      }

      // The user edits the contact page in Publish, then the agent sends a prototype that changes it too.
      const details = await (await api(`/api/cms/v1/projects/${projectId}`)).json() as { pages: Array<{ alias: number; slug: string }> };
      const contacts = details.pages.find((page) => page.slug === "contatti");
      if (!contacts) throw new Error("Pagina contatti mancante.");
      const document = await (await api(`/api/cms/v1/projects/${projectId}/documents/${contacts.alias}`)).json() as { content: string; head: string };
      expect(document.content).toContain("Scrivimi.");
      const saved = await api(`/api/cms/v1/projects/${projectId}/documents/${contacts.alias}`, { method: "POST", body: { content: document.content.replace("Scrivimi.", "Scrivimi in Publish."), head: document.head } });
      expect(saved.status, await saved.clone().text()).toBe(200);
      const changed = await prototypeFile("cambiato.html", FIXTURE.replace("<p>Scrivimi.</p>", "<p>Scrivimi dal prototipo.</p>"));
      const conflict = await rejection(tool("hp_import_prototype", { path: changed, update: true }));
      expect(conflict).toMatchObject({ code: "cms-sync-conflict", exitCode: 2 });
      const conflicts = (conflict.details as { conflicts: Array<{ id: string; kind: string }> }).conflicts;
      expect(conflicts.length).toBeGreaterThan(0);
      for (const item of conflicts) expect(item).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/u), kind: expect.any(String), label: expect.any(String) });
      expect(conflicts).toContainEqual(expect.objectContaining({ kind: "page", label: "Contatti" }));
      // A conflict never becomes a request for the user.
      expect((await snapshot()).pending).toEqual([]);
      const after = await (await api(`/api/cms/v1/projects/${projectId}/documents/${contacts.alias}`)).json() as { content: string };
      expect(after.content).toContain("Scrivimi in Publish.");
      // A refused update leaves the backups as they were: only the one of the update that committed.
      expect((await readdir(path.join(backups, projectId))).filter((name) => name.endsWith(".histosproject"))).toEqual([updated.backup]);

      await waitFor(async () => (await activityLog()).split("\n").filter(Boolean).length >= 7);
      const log = await activityLog();
      for (const marker of CONTENT_MARKERS) expect(log).not.toContain(marker);
      expect(log).not.toContain(dataDirectory);
      expect(log).not.toContain(session().key.toString("base64url"));
      const entries = log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { operation: string; outcome: string; code?: string });
      expect(entries.map((entry) => entry.operation)).toEqual(expect.arrayContaining(["checkPrototype", "importPrototype"]));
      expect(entries).toContainEqual(expect.objectContaining({ operation: "importPrototype", outcome: "error", code: "cms-sync-conflict" }));
      expect(entries).toContainEqual(expect.objectContaining({ operation: "importPrototype", outcome: "pending" }));
      expect(entries).toContainEqual(expect.objectContaining({ operation: "importPrototype", outcome: "error", code: "connector-import-rejected" }));
      expect(entries).toContainEqual(expect.objectContaining({ operation: "importPrototype", outcome: "ok", facts: expect.objectContaining({ state: "applied", result: "aggiornato" }) }));
      if (POSIX) expect(mode(await stat(path.join(dataDirectory, "connector", "activity.jsonl")))).toBe("600");
    }, 30_000);

    it("scarica i media remoti solo se l'agente lo chiede", async () => {
      const remoteVariant = FIXTURE.replace(/\{ "name": "ehi", "data": "[^"]+",/u, `{ "name": "ehi", "url": "${REMOTE_IMAGE}",`);
      expect(remoteVariant).toContain(REMOTE_IMAGE);
      const file = await prototypeFile("remoto.html", remoteVariant);
      expect(await tool("hp_check_prototype", { path: file })).toMatchObject({ valid: true, report: { placeholders: ["ehi"], downloaded: 0 } });
      // The note on modern formats reaches the agent without a preview too (doc 17), with why an image keeps its src.
      const sized = await prototypeFile("remoto-misure.html", remoteVariant.replace('<img src="asset:ehi" alt="Logo">', '<img src="asset:ehi" alt="Logo" width="1" height="1">'));
      expect(await tool("hp_check_prototype", { path: sized })).toMatchObject({ report: { images: { files: 0, uses: 0, note: expect.stringMatching(/^Immagini moderne: nessuna immagine avrà varianti alla build\. Restano come sono: ehi \(/u), skipped: [{ asset: "ehi", why: "si sa dopo lo scaricamento dei media remoti" }] } } });
      const refused = await rejection(tool("hp_import_prototype", { path: file }));
      expect(refused).toMatchObject({ code: "cms-prototype-invalid" });
      expect(refused.message).toContain("ehi");
      expect(fetchedAssets).toEqual([]);
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });

      const imported = await tool("hp_import_prototype", { path: file, downloadRemoteMedia: true });
      expect(imported).toMatchObject({ result: "creato", report: { downloaded: 1 } });
      expect(fetchedAssets).toEqual([REMOTE_IMAGE]);
    }, 30_000);

    it("«Interrompi» ferma lo scaricamento dei media remoti di un import o di un controllo", async () => {
      const fetches = hangingDownloads();
      for (const mode of ["import", "check"] as const) {
        fetches.length = 0;
        const answer = signedPrototype(`mode=${mode}&update=0&download=1&source=remoto.html`, REMOTE_FIXTURE);
        // D3: the remote media download together (up to four at a time).
        await waitFor(() => fetches.length === 2);
        expect(fetches.map((item) => item.url).sort()).toEqual([REMOTE_IMAGE, REMOTE_TEXTURE].sort());
        expect(fetches.some((item) => item.signal?.aborted), mode).toBe(false);
        expect(await (await api("/api/connector/interrupt", { method: "POST" })).json()).toEqual({ interrupted: 1 });
        expect(await answer, mode).toMatchObject({ status: 499, body: { code: "connector-cancelled" } });
        expect(fetches.every((item) => item.signal?.aborted), mode).toBe(true);
        // Nothing else is asked for.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(fetches, mode).toHaveLength(2);
      }

      // The agent's tool reports a cancellation, not a broken prototype.
      fetches.length = 0;
      const file = await prototypeFile("remoto.html", REMOTE_FIXTURE);
      const imported = tool("hp_import_prototype", { path: file, downloadRemoteMedia: true });
      imported.catch(() => undefined);
      await waitFor(() => fetches.length === 2);
      await api("/api/connector/interrupt", { method: "POST" });
      expect(await rejection(imported)).toMatchObject({ code: "connector-cancelled" });
      expect(fetches).toHaveLength(2);

      expect(await tool("hp_list_projects")).toMatchObject({ projects: [] });
      expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".prototype"))).toEqual([]);
      expect((await snapshot()).activity.filter((entry) => entry.operation === "importPrototype" || entry.operation === "checkPrototype")).toEqual([
        expect.objectContaining({ operation: "importPrototype", outcome: "error", code: "connector-cancelled" }),
        expect.objectContaining({ operation: "checkPrototype", outcome: "error", code: "connector-cancelled" }),
        expect.objectContaining({ operation: "importPrototype", outcome: "error", code: "connector-cancelled" }),
      ]);
    }, 30_000);

    it("«Ferma» interrompe lo scaricamento dei media remoti e non crea il progetto", async () => {
      const fetches = hangingDownloads();
      const file = await prototypeFile("remoto.html", REMOTE_FIXTURE);
      const imported = tool("hp_import_prototype", { path: file, downloadRemoteMedia: true });
      imported.catch(() => undefined);
      await waitFor(() => fetches.length === 2);
      await setConnector({ enabled: false });
      expect(fetches.every((item) => item.signal?.aborted)).toBe(true);
      // The signed 499 may still leave before the port closes; otherwise the agent finds the connector off.
      expect(["connector-cancelled", "connector-off"]).toContain((await rejection(imported)).code);
      await waitFor(async () => (await snapshot()).running.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fetches).toHaveLength(2);
      expect(await (await api("/api/cms/v1/projects")).json()).toMatchObject({ projects: [] });
      expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".prototype"))).toEqual([]);
    }, 30_000);

    it("il registro dice perché un'operazione non è riuscita, con il file, e le build si riaprono in anteprima (E5)", async () => {
      const broken = await prototypeFile("rotto.html", FIXTURE.replace("<p>Scrivimi.</p>", '<p onclick="alert(1)">Scrivimi.</p>'));
      expect(await rejection(tool("hp_import_prototype", { path: broken }))).toMatchObject({ code: "cms-prototype-invalid" });
      const projectId = await importFixture();
      const built = await tool("hp_build", { projectId }) as { buildId: string };
      await waitFor(async () => (await activityLog()).split("\n").filter(Boolean).length >= 3);
      const entries = (await activityLog()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { operation: string; outcome: string; code?: string; message?: string; file?: { name: string }; facts?: Record<string, unknown> });
      const failed = entries.find((entry) => entry.operation === "importPrototype" && entry.outcome === "error");
      expect(failed).toMatchObject({ code: "cms-prototype-invalid", file: { name: "rotto.html" } });
      expect(failed?.message).toMatch(/onclick/u);
      expect(failed?.message?.length ?? 0).toBeLessThanOrEqual(161);
      expect(failed?.message).not.toMatch(/[<>]/u);
      const buildEntry = entries.find((entry) => entry.operation === "build");
      expect(buildEntry?.facts).toMatchObject({ status: "ready", draft: false, buildId: built.buildId });

      // A registered build gets a fresh preview address from the app's session API; unknown or foreign builds do not.
      const preview = await api(`/api/cms/v1/projects/${projectId}/builds/${built.buildId}/preview`, { method: "POST", body: {} });
      expect(preview.status).toBe(200);
      const { previewUrl } = await preview.json() as { previewUrl: string };
      expect((await fetch(previewUrl)).status).toBe(200);
      expect((await api(`/api/cms/v1/projects/${projectId}/builds/${randomUUID()}/preview`, { method: "POST", body: {} })).status).toBe(404);
    });

    it("costruisce, serve l'anteprima sulla porta dell'app e legge solo file dentro la build", async () => {
      const projectId = await importFixture();
      const built = await tool("hp_build", { projectId }) as { buildId: string; status: string; previewUrl: string; draft: boolean };
      expect(built).toMatchObject({ status: "ready", draft: false, current: true });
      expect(new URL(built.previewUrl).port).toBe(String((server as LocalServerHandle).port));
      const preview = await fetch(built.previewUrl);
      expect(preview.status).toBe(200);
      expect(await preview.text()).toContain("Studio Ehi");
      expect(await tool("hp_builds", { projectId })).toMatchObject({ builds: [{ id: built.buildId, status: "ready", current: true, previewUrl: expect.stringContaining("/__preview/") }] });

      const index = await tool("hp_build_file", { projectId, buildId: built.buildId }) as { path: string; text: string; contentType: string };
      expect(index).toMatchObject({ path: "index.html", contentType: "text/html", truncated: false });
      expect(index.text).toContain("Studio Ehi");
      expect(await tool("hp_build_file", { projectId, buildId: built.buildId, path: "blog/un-antico-sogno/" })).toMatchObject({ path: "blog/un-antico-sogno/index.html" });

      // The server checks paths again: the client is not trusted to have done it.
      for (const bad of ["../x.html", "%2e%2e/x.html", "a\\..\\x.html", "blog/../index.html", ".hidden.html"]) {
        expect(await rejection(call("readBuildFile", { projectId, buildId: built.buildId, path: bad })), bad).toMatchObject({ code: "connector-invalid-arguments" });
      }
      // Absolute paths and empty segments are refused by the schema, before the file reader runs.
      for (const bad of ["/etc/passwd", "blog//index.html"]) {
        expect(await rejection(call("readBuildFile", { projectId, buildId: built.buildId, path: bad })), bad).toMatchObject({ code: "connector-invalid-arguments" });
      }
      const outside = path.join(workDirectory, "segreto.html");
      await writeFile(outside, "SEGRETO-FUORI-DALLA-BUILD");
      const buildRoot = path.join(dataDirectory, "histos-cms-builds", projectId, built.buildId);
      expect(await exists(path.join(buildRoot, "index.html"))).toBe(true);
      await symlink(outside, path.join(buildRoot, "collegato.html"));
      await mkdir(path.join(workDirectory, "cartella"));
      await writeFile(path.join(workDirectory, "cartella", "index.html"), "SEGRETO-FUORI-DALLA-BUILD");
      await symlink(path.join(workDirectory, "cartella"), path.join(buildRoot, "cartella"));
      for (const linked of ["collegato.html", "cartella/index.html", "cartella/"]) {
        const refused = await rejection(call("readBuildFile", { projectId, buildId: built.buildId, path: linked }));
        expect(refused, linked).toMatchObject({ code: "connector-build-file-missing" });
        expect(refused.message).not.toContain("SEGRETO");
      }
      expect(await rejection(call("readBuildFile", { projectId, buildId: built.buildId, path: "manca.html" }))).toMatchObject({ code: "connector-build-file-missing" });
      expect(await rejection(call("readBuildFile", { projectId, buildId: built.buildId, path: "immagine.png" }))).toMatchObject({ code: "connector-build-file-type" });
      expect(await rejection(call("readBuildFile", { projectId, buildId: randomUUID() }))).toMatchObject({ code: "cms-build-missing" });
      expect(await rejection(call("readBuildFile", { projectId: randomUUID(), buildId: built.buildId }))).toMatchObject({ code: "cms-build-missing" });

      // A draft preview of one page is readable too, and never becomes a registered build.
      const details = await (await api(`/api/cms/v1/projects/${projectId}`)).json() as { pages: Array<{ alias: number; slug: string }> };
      const contacts = details.pages.find((page) => page.slug === "contatti");
      const draft = await tool("hp_build", { projectId, page: contacts?.alias }) as { buildId: string; previewUrl: string };
      expect(draft).toMatchObject({ status: "ready", draft: true });
      expect(draft.previewUrl).toContain("contatti/index.html");
      expect(await tool("hp_build_file", { projectId, buildId: draft.buildId, path: "contatti/index.html" })).toMatchObject({ text: expect.stringContaining("Scrivimi.") });
      expect((await tool("hp_builds", { projectId }) as { builds: Array<{ id: string }> }).builds.map((item) => item.id)).toEqual([built.buildId]);

      const log = await activityLog();
      for (const marker of CONTENT_MARKERS) expect(log).not.toContain(marker);
    }, 30_000);

    it("tiene tre anteprime di bozza per progetto, toglie la più vecchia e a «Ferma» le cancella tutte", async () => {
      const projectId = await importFixture();
      const registered = await tool("hp_build", { projectId }) as { buildId: string; draft: boolean };
      expect(registered.draft).toBe(false);
      const details = await (await api(`/api/cms/v1/projects/${projectId}`)).json() as { pages: Array<{ alias: number; slug: string }> };
      const page = details.pages.find((item) => item.slug === "contatti")?.alias;
      const builds = path.join(dataDirectory, "histos-cms-builds", projectId);
      const drafts: string[] = [];
      for (let index = 0; index < 4; index++) {
        const draft = await tool("hp_build", { projectId, page }) as { buildId: string; draft: boolean };
        expect(draft.draft).toBe(true);
        expect(await exists(path.join(builds, draft.buildId, "contatti", "index.html"))).toBe(true);
        drafts.push(draft.buildId);
      }
      const [oldest, second, third, newest] = drafts as [string, string, string, string];
      // The fourth draft pushes the first one out, folder and all.
      await waitFor(async () => !(await exists(path.join(builds, oldest))));
      for (const id of [second, third, newest]) expect(await exists(path.join(builds, id))).toBe(true);
      expect(await signedCall("readBuildFile", { projectId, buildId: oldest, path: "contatti/index.html" })).toMatchObject({ status: 404, body: { code: "cms-build-missing" } });
      expect(await rejection(tool("hp_build_file", { projectId, buildId: oldest, path: "contatti/index.html" }))).toMatchObject({ code: "cms-build-missing" });
      expect(await tool("hp_build_file", { projectId, buildId: newest, path: "contatti/index.html" })).toMatchObject({ text: expect.stringContaining("Scrivimi.") });

      await setConnector({ enabled: false });
      for (const id of drafts) expect(await exists(path.join(builds, id)), id).toBe(false);
      expect(await exists(path.join(builds, registered.buildId, "index.html"))).toBe(true);
      // Turned on again, the connector no longer knows the drafts; the registered build is still readable.
      await setConnector({ enabled: true });
      expect(await signedCall("readBuildFile", { projectId, buildId: newest })).toMatchObject({ status: 404, body: { code: "cms-build-missing" } });
      expect(await tool("hp_build_file", { projectId, buildId: registered.buildId })).toMatchObject({ path: "index.html", text: expect.stringContaining("Studio Ehi") });
    }, 60_000);

    it("esporta un .xbsite privato con un nome generato dall'app", async () => {
      const projectId = await importFixture();
      const exported = await tool("hp_export_xbsite", { projectId }) as { path: string; bytes: number; sha256: string };
      expect(path.basename(exported.path)).toMatch(/^[a-z0-9-]+-\d{8}-\d{6}-[0-9a-f]{4}\.xbsite$/u);
      expect(path.basename(exported.path)).toMatch(/^galleria-/u);
      expect(path.dirname(exported.path)).toBe(await realpath(path.join(dataDirectory, "connector", "exports")));
      const bytes = await readFile(exported.path);
      expect(bytes.byteLength).toBe(exported.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(exported.sha256);
      if (POSIX) {
        expect(mode(await stat(exported.path))).toBe("600");
        expect(mode(await stat(path.dirname(exported.path)))).toBe("700");
      }
      const decoded = await decodeStaticPageArchive(bytes);
      expect(decoded.profile.manifest.project.id).toBe(projectId);
      const second = await tool("hp_export_xbsite", { projectId }) as { path: string };
      expect(second.path).not.toBe(exported.path);
      await waitFor(async () => (await activityLog()).includes("exportXbsite"));
      const log = await activityLog();
      expect(log).not.toContain(exported.path);
      for (const marker of CONTENT_MARKERS) expect(log).not.toContain(marker);
    }, 30_000);

    it("mette in coda al massimo quattro operazioni pesanti e rifiuta la sesta", async () => {
      const projectId = await importFixture();
      hangBuilds = true;
      const first = call("build", { projectId });
      first.catch(() => undefined);
      await waitFor(() => hungBuilds.length === 1);
      const queued = [call("build", { projectId }), call("exportXbsite", { projectId }), call("build", { projectId }), call("exportXbsite", { projectId })];
      for (const pending of queued) pending.catch(() => undefined);
      await waitFor(async () => (await snapshot()).running.length === 5);
      const busy = await rejection(call("build", { projectId }));
      expect(busy).toMatchObject({ code: "connector-busy", exitCode: 1, details: { queue: { position: 5, waiting: 4 } } });
      expect(busy.message).toBe("Histeon Publish fa un'operazione pesante alla volta, e questa non ha avuto il suo turno (posizione in coda: 5; altre in attesa: 4). Riprova fra 15 secondi.");
      // Light operations do not wait for heavy ones.
      expect(await tool("hp_list_projects")).toMatchObject({ projects: [{ id: projectId }] });
      expect(hungBuilds).toHaveLength(1);

      const interrupted = await api("/api/connector/interrupt", { method: "POST" });
      expect(await interrupted.json()).toEqual({ interrupted: 5 });
      const settled = await Promise.allSettled([first, ...queued]);
      for (const outcome of settled) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(["cms-build-cancelled", "connector-cancelled"]).toContain((outcome.reason as ConnectorError).code);
      }
      expect(hungBuilds).toHaveLength(1);
      expect(hungBuilds[0]?.aborted).toBe(true);
      expect((await snapshot()).running).toEqual([]);
      expect(await exists(path.join(dataDirectory, "connector", "exports"))).toBe(false);
    }, 60_000);
  });
});
