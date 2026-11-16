import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

const DEFAULT_TOKEN = "synthetic-cloudflare-token-000000000000";
const DEFAULT_ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAX_REQUEST_BYTES = 45 * 1024 * 1024;

interface ManifestFile {
  hash: string;
  size: number;
  path: string;
  extension: string;
}

interface InternalSession {
  uploadToken: string;
  completionToken: string;
  manifest: Map<string, ManifestFile>;
  assetManifest: Record<string, { hash: string; size: number }>;
  missing: Set<string>;
  uploaded: Set<string>;
  complete: boolean;
}

interface InternalVersion {
  id: string;
  created_on: string;
  annotations: Record<string, string>;
  workerFirstRoutes: string[] | true;
  assetManifest: Record<string, { hash: string; size: number }>;
  headers?: string;
  redirects?: string;
  workerSource: string;
  /** The site's own `_worker.js`, when the version carries one. */
  siteWorkerSource?: string;
  kvBindings: Array<{ name: string; namespace_id: string }>;
}

interface InternalDeployment {
  id: string;
  created_on: string;
  strategy: "percentage";
  versions: Array<{ version_id: string; percentage: number }>;
  annotations: Record<string, string>;
}

interface InternalScript {
  accountId: string;
  name: string;
  versions: InternalVersion[];
  deployments: InternalDeployment[];
  activeVersionId?: string;
}

interface InternalDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
  enabled: boolean;
  previews_enabled: boolean;
}

interface InternalDnsRecord {
  id: string;
  zone_id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment?: string;
  tags?: string[];
}

export { startFigmaMock, type FigmaMockFile, type FigmaMockHandle, type FigmaMockOptions, type FigmaMockRequest } from "./figma.js";
export type CloudflareMockDnsRecord = Omit<InternalDnsRecord, "id"> & { id?: string };

interface FailureRule {
  method: string;
  path: string;
  status: number;
  message: string;
  retryAfter?: string;
}

export interface CloudflareMockOptions {
  token?: string;
  accountId?: string;
  zones?: Array<{ id: string; name: string; status?: string }>;
  dnsRecords?: CloudflareMockDnsRecord[];
}

export interface CloudflareMockInspection {
  scripts: Record<string, {
    accountId: string;
    name: string;
    activeVersionId?: string;
    versionIds: string[];
    workerFirstRoutes: Array<string[] | true>;
    /** Per version: the site's own `_worker.js`, or null. */
    siteWorkers: Array<string | null>;
    kvBindings: Array<Array<{ name: string; namespace_id: string }>>;
    deployments: InternalDeployment[];
  }>;
  kvNamespaces: Array<{ id: string; title: string }>;
  assets: Array<{ hash: string; bytes: number }>;
  domains: InternalDomain[];
  dnsRecords: InternalDnsRecord[];
  secretNames: string[];
  uploadedAssetCount: number;
  uploadRequestCount: number;
  requestCounts: Record<string, number>;
}

export interface CloudflareMockHandle {
  url: string;
  accountId: string;
  token: string;
  close(): Promise<void>;
  reset(): void;
  state(): CloudflareMockInspection;
  failNext(input: { method: string; path: string; status: number; message?: string; retryAfter?: string }): void;
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  content: Buffer;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(response, status, { success: false, errors: [{ code: 1000, message }], messages: [], result: null }, headers);
}

function ok<T>(response: ServerResponse, result: T, status = 200): void {
  sendJson(response, status, { success: true, errors: [], messages: [], result });
}

async function readBody(request: IncomingMessage, limit = MAX_REQUEST_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) throw new Error("La richiesta mock supera il limite di 45 MiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function parseJson(buffer: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseMultipart(contentType: string | undefined, buffer: Buffer): MultipartPart[] {
  const match = contentType?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/iu);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return [];
  const marker = Buffer.from(`--${boundary}`, "latin1");
  const parts: MultipartPart[] = [];
  let cursor = 0;
  while (cursor < buffer.byteLength) {
    const start = buffer.indexOf(marker, cursor);
    if (start < 0) break;
    const afterMarker = start + marker.byteLength;
    if (buffer.subarray(afterMarker, afterMarker + 2).toString("latin1") === "--") break;
    const headerStart = buffer.subarray(afterMarker, afterMarker + 2).toString("latin1") === "\r\n" ? afterMarker + 2 : afterMarker;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const nextBoundary = buffer.indexOf(marker, headerEnd + 4);
    if (nextBoundary < 0) break;
    let contentEnd = nextBoundary;
    if (buffer.subarray(contentEnd - 2, contentEnd).toString("latin1") === "\r\n") contentEnd -= 2;
    const headerText = buffer.subarray(headerStart, headerEnd).toString("latin1");
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/iu)?.[1] ?? "";
    const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/iu)?.[1];
    if (name) {
      const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/iu)?.[1];
      const partType = headerText.match(/content-type:\s*([^\r\n]+)/iu)?.[1]?.trim();
      parts.push({ name, ...(filename === undefined ? {} : { filename }), ...(partType === undefined ? {} : { contentType: partType }), content: buffer.subarray(headerEnd + 4, contentEnd) });
    }
    cursor = nextBoundary;
  }
  return parts;
}

/** Histeon Publish's asset hash: the upload part's Content-Type is part of it (see assetHash in packages/core). */
function hashContent(contents: Buffer, extension: string, contentType: string): string {
  return createHash("sha256").update(`${contents.toString("base64")}${extension}\n${contentType}`, "utf8").digest("hex").slice(0, 32);
}

function decodeManifestPath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) return null;
  const encodedSegments = value.slice(1).split("/");
  let segments: string[];
  try { segments = encodedSegments.map((segment) => decodeURIComponent(segment)); }
  catch { return null; }
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("/") || [...segment].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  }))) return null;
  const canonical = `/${segments.map(encodeURIComponent).join("/")}`;
  if (canonical !== value) return null;
  return segments.join("/");
}

function scriptKey(accountId: string, script: string): string {
  return `${accountId}/${script}`;
}

function routePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u");
}

function responseHeadersFor(rules: string | undefined, requestPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rules) return result;
  let current = "";
  for (const line of rules.split(/\r?\n/u)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      current = line.trim();
      continue;
    }
    if (!routePattern(current).test(requestPath)) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) && !/[\r\n]/u.test(value)) result[name] = value;
  }
  return result;
}

function redirectFor(rules: string | undefined, requestPath: string): { destination: string; status: number } | null {
  if (!rules) return null;
  for (const line of rules.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [source, destination, code] = trimmed.split(/\s+/u);
    if (!source || !destination || !routePattern(source).test(requestPath)) continue;
    const status = Number(code ?? 302);
    if ([301, 302, 303, 307, 308].includes(status)) return { destination, status };
  }
  return null;
}

function clearInternalState(
  scripts: Map<string, InternalScript>,
  assets: Map<string, Buffer>,
  assetTypes: Map<string, string>,
  sessions: Map<string, InternalSession>,
  domains: Map<string, InternalDomain>,
  secretNames: Set<string>,
  requestCounts: Map<string, number>,
): void {
  scripts.clear();
  assets.clear();
  assetTypes.clear();
  sessions.clear();
  domains.clear();
  secretNames.clear();
  requestCounts.clear();
}

export async function startCloudflareMock(options: CloudflareMockOptions = {}): Promise<CloudflareMockHandle> {
  const token = options.token ?? DEFAULT_TOKEN;
  const accountId = options.accountId ?? DEFAULT_ACCOUNT;
  const zones = options.zones ?? [{ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "example.test", status: "active" }];
  const dnsRecords = new Map((options.dnsRecords ?? []).map((record) => {
    const complete: InternalDnsRecord = { ...record, id: record.id ?? randomUUID() };
    return [complete.id, complete];
  }));
  const initialDnsRecords = [...dnsRecords].map(([id, record]) => [id, { ...record }] as const);
  const scripts = new Map<string, InternalScript>();
  const assets = new Map<string, Buffer>();
  /** The Content-Type of each uploaded asset: Cloudflare serves the type of the upload part. */
  const assetTypes = new Map<string, string>();
  const sessions = new Map<string, InternalSession>();
  const completionTokens = new Map<string, InternalSession>();
  const domains = new Map<string, InternalDomain>();
  const secretNames = new Set<string>();
  const kvNamespaces = new Map<string, { id: string; title: string }>();
  const requestCounts = new Map<string, number>();
  const failures: FailureRule[] = [];
  let uploadRequestCount = 0;
  let uploadedAssetCount = 0;

  const state = (): CloudflareMockInspection => {
    const inspectedScripts: CloudflareMockInspection["scripts"] = {};
    for (const script of scripts.values()) {
      inspectedScripts[scriptKey(script.accountId, script.name)] = {
        accountId: script.accountId,
        name: script.name,
        ...(script.activeVersionId === undefined ? {} : { activeVersionId: script.activeVersionId }),
        versionIds: script.versions.map((version) => version.id),
        workerFirstRoutes: script.versions.map((version) => version.workerFirstRoutes === true ? true : [...version.workerFirstRoutes]),
        siteWorkers: script.versions.map((version) => version.siteWorkerSource ?? null),
        kvBindings: script.versions.map((version) => version.kvBindings.map((binding) => ({ ...binding }))),
        deployments: structuredClone(script.deployments),
      };
    }
    return {
      scripts: inspectedScripts,
      assets: [...assets].map(([hash, contents]) => ({ hash, bytes: contents.byteLength })),
      domains: [...domains.values()].map((domain) => ({ ...domain })),
      dnsRecords: [...dnsRecords.values()].map((record) => ({ ...record })),
      secretNames: [...secretNames].sort(),
      kvNamespaces: [...kvNamespaces.values()].map((namespace) => ({ ...namespace })),
      uploadedAssetCount,
      uploadRequestCount,
      requestCounts: Object.fromEntries(requestCounts),
    };
  };

  const failNext = (input: { method: string; path: string; status: number; message?: string; retryAfter?: string }): void => {
    failures.push({
      method: input.method.toUpperCase(),
      path: input.path,
      status: input.status,
      message: input.message ?? "Errore sintetico del mock Cloudflare.",
      ...(input.retryAfter === undefined ? {} : { retryAfter: input.retryAfter }),
    });
  };

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendError(response, error instanceof Error && error.message.includes("45 MiB") ? 413 : 500, "Errore interno del mock Cloudflare.");
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = `${request.method ?? "GET"} ${requestUrl.pathname}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);

    if (requestUrl.pathname === "/__state" && request.method === "GET") {
      sendJson(response, 200, state());
      return;
    }
    if (requestUrl.pathname === "/__reset" && request.method === "GET") {
      clearInternalState(scripts, assets, assetTypes, sessions, domains, secretNames, requestCounts);
      dnsRecords.clear();
      for (const [id, record] of initialDnsRecords) dnsRecords.set(id, { ...record });
      completionTokens.clear();
      uploadRequestCount = 0;
      uploadedAssetCount = 0;
      kvNamespaces.clear();
      failures.splice(0, failures.length);
      sendJson(response, 200, { reset: true });
      return;
    }
    // The next request matching method and path fails: what failNext does, for a browser test (doc 23, voce 228).
    if (requestUrl.pathname === "/__fail-next" && request.method === "POST") {
      const body = parseJson(await readBody(request, 64 * 1024));
      if (typeof body?.method !== "string" || typeof body.path !== "string" || typeof body.status !== "number") {
        sendJson(response, 400, { error: "Servono method, path e status." });
        return;
      }
      failNext({ method: body.method, path: body.path, status: body.status, ...(typeof body.message === "string" ? { message: body.message } : {}) });
      sendJson(response, 200, { queued: true });
      return;
    }
    if (requestUrl.pathname.startsWith("/__site/")) {
      serveSite(request, response, requestUrl);
      return;
    }

    const failureIndex = failures.findIndex((failure) => failure.method === (request.method ?? "GET") && failure.path === requestUrl.pathname);
    if (failureIndex >= 0) {
      const failure = failures.splice(failureIndex, 1)[0];
      if (!failure) return;
      sendError(response, failure.status, failure.message, failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter });
      return;
    }

    const apiPath = requestUrl.pathname.startsWith("/client/v4") ? requestUrl.pathname.slice("/client/v4".length) : requestUrl.pathname;
    if (!apiPath.startsWith("/")) {
      sendError(response, 404, "Endpoint non trovato.");
      return;
    }

    if (apiPath === "/user/tokens/verify" && request.method === "GET") {
      if (!hasBearer(request, token)) {
        sendError(response, 401, "Token Cloudflare non valido.");
        return;
      }
      ok(response, { id: "synthetic-token-id", status: "active" });
      return;
    }

    if (apiPath === `/accounts/${accountId}/tokens/verify` && request.method === "GET") {
      if (!hasBearer(request, token)) {
        sendError(response, 401, "Token Cloudflare non valido.");
        return;
      }
      ok(response, { id: "synthetic-account-token-id", status: "active" });
      return;
    }

    if (apiPath === "/accounts" && request.method === "GET") {
      if (!hasBearer(request, token)) { sendError(response, 401, "Token Cloudflare non valido."); return; }
      ok(response, [{ id: accountId, name: "Account Cloudflare simulato", type: "standard" }]);
      return;
    }

    if (apiPath === `/accounts/${accountId}/storage/kv/namespaces` && request.method === "GET") {
      if (!hasBearer(request, token)) { sendError(response, 401, "Token Cloudflare non valido."); return; }
      const perPage = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get("per_page") ?? 20) || 20));
      const page = Math.max(1, Number(requestUrl.searchParams.get("page") ?? 1) || 1);
      const all = [...kvNamespaces.values()];
      const slice = all.slice((page - 1) * perPage, page * perPage);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, errors: [], messages: [], result: slice, result_info: { page, per_page: perPage, count: slice.length, total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / perPage)) } }));
      return;
    }

    if (apiPath === `/accounts/${accountId}/storage/kv/namespaces` && request.method === "POST") {
      if (!hasBearer(request, token)) { sendError(response, 401, "Token Cloudflare non valido."); return; }
      const body = parseJson(await readBody(request, 64 * 1024));
      const title = typeof body?.title === "string" ? body.title : "";
      if (!title || title.length > 512) { sendError(response, 400, "Titolo dell’archivio KV non valido."); return; }
      if ([...kvNamespaces.values()].some((namespace) => namespace.title === title)) { sendError(response, 400, "Esiste già un archivio KV con questo titolo."); return; }
      const namespace = { id: randomUUID().replaceAll("-", ""), title };
      kvNamespaces.set(namespace.id, namespace);
      ok(response, { ...namespace, supports_url_encoding: true });
      return;
    }

    if (apiPath === `/accounts/${accountId}/workers/subdomain` && request.method === "GET") {
      if (!hasBearer(request, token)) { sendError(response, 401, "Token Cloudflare non valido."); return; }
      ok(response, { subdomain: "account-finto" });
      return;
    }
    const scriptSubdomainRoute = apiPath.match(/^\/accounts\/([0-9a-f]{32})\/workers\/scripts\/([a-z0-9-]{1,63})\/subdomain$/iu);
    if (scriptSubdomainRoute && request.method === "GET") {
      if (!hasBearer(request, token)) { sendError(response, 401, "Token Cloudflare non valido."); return; }
      const script = scripts.get(scriptKey(scriptSubdomainRoute[1] ?? "", scriptSubdomainRoute[2] ?? ""));
      if (!script) { sendError(response, 404, "Worker inesistente."); return; }
      ok(response, { enabled: true, previews_enabled: true });
      return;
    }

    if (apiPath.endsWith("/workers/assets/upload") && request.method === "POST") {
      const uploadToken = bearerValue(request);
      const session = uploadToken ? sessions.get(uploadToken) : undefined;
      if (!session || session.complete || !session.uploadToken) {
        sendError(response, 401, "JWT di upload non valido o scaduto.");
        return;
      }
      if (requestUrl.searchParams.get("base64") !== "true") {
        sendError(response, 400, "L’upload degli asset richiede base64=true.");
        return;
      }
      const body = await readBody(request);
      const parts = parseMultipart(request.headers["content-type"], body);
      if (parts.length === 0) {
        sendError(response, 400, "Upload multipart senza file.");
        return;
      }
      uploadRequestCount += 1;
      for (const part of parts) {
        const expected = session.manifest.get(part.name);
        if (!expected || !session.missing.has(expected.hash)) {
          sendError(response, 400, "Hash non richiesto nella sessione.");
          return;
        }
        const base64 = part.content.toString("utf8");
        const content = Buffer.from(base64, "base64");
        if (content.toString("base64") !== base64 || content.byteLength !== expected.size || hashContent(content, expected.extension, part.contentType ?? "application/octet-stream") !== expected.hash) {
          sendError(response, 400, "Hash mismatch.");
          return;
        }
        assets.set(expected.hash, content);
        assetTypes.set(expected.hash, part.contentType ?? "application/octet-stream");
        session.uploaded.add(expected.hash);
        uploadedAssetCount += 1;
      }
      if (session.uploaded.size === session.missing.size) {
        session.complete = true;
        completionTokens.set(session.completionToken, session);
        ok(response, { jwt: session.completionToken }, 201);
      } else {
        ok(response, {});
      }
      return;
    }

    if (!hasBearer(request, token)) {
      sendError(response, 401, "Token Cloudflare non valido.");
      return;
    }

    const sessionRoute = apiPath.match(/^\/accounts\/([0-9a-f]{32})\/workers\/scripts\/([a-z0-9-]{1,63})\/assets-upload-session$/iu);
    if (sessionRoute && request.method === "POST") {
      const body = parseJson(await readBody(request, 10 * 1024 * 1024));
      const rawManifest = body?.manifest;
      if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
        sendError(response, 400, "Manifest non valido.");
        return;
      }
      const manifest = new Map<string, ManifestFile>();
      const hashMap = new Map<string, ManifestFile>();
      const assetManifest: Record<string, { hash: string; size: number }> = {};
      for (const [encodedPath, value] of Object.entries(rawManifest)) {
        const decodedPath = decodeManifestPath(encodedPath);
        const entry = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
        if (!decodedPath) {
          sendError(response, 400, "Manifest path must be URI encoded.");
          return;
        }
        if (typeof entry?.hash !== "string" || !/^[0-9a-f]{32}$/u.test(entry.hash) || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0) {
          sendError(response, 400, "Manifest non valido: hash o dimensione errati.");
          return;
        }
        const extension = path.posix.extname(decodedPath).slice(1);
        const item: ManifestFile = { hash: entry.hash, size: Number(entry.size), path: decodedPath, extension };
        manifest.set(entry.hash, item);
        hashMap.set(entry.hash, item);
        assetManifest[encodedPath] = { hash: item.hash, size: item.size };
      }
      if (manifest.size === 0) {
        sendError(response, 400, "Manifest vuoto.");
        return;
      }
      const missing = new Set([...hashMap.keys()].filter((hash) => !assets.has(hash)));
      const missingList = [...missing];
      const buckets: string[][] = [];
      for (let index = 0; index < missingList.length; index += 3) buckets.push(missingList.slice(index, index + 3));
      const uploadToken = `mock-upload-${randomUUID()}`;
      const completionToken = missing.size === 0 ? `mock-complete-${randomUUID()}` : `mock-complete-${randomUUID()}`;
      const session: InternalSession = { uploadToken, completionToken, manifest: hashMap, assetManifest, missing, uploaded: new Set(), complete: missing.size === 0 };
      sessions.set(uploadToken, session);
      if (session.complete) completionTokens.set(completionToken, session);
      ok(response, { jwt: missing.size === 0 ? completionToken : uploadToken, buckets });
      return;
    }

    const scriptRoute = apiPath.match(/^\/accounts\/([0-9a-f]{32})\/workers\/scripts\/([a-z0-9-]{1,63})(?:\/(versions|deployments|secrets|script-settings))?$/iu);
    if (scriptRoute) {
      const routeAccount = scriptRoute[1] ?? "";
      const name = scriptRoute[2] ?? "";
      const action = scriptRoute[3];
      const key = scriptKey(routeAccount, name);
      let script = scripts.get(key);

      if (action === "script-settings" && request.method === "GET") {
        if (!script) {
          sendError(response, 404, "Worker inesistente.");
          return;
        }
        ok(response, { id: script.name, created_on: script.versions[0]?.created_on ?? null });
        return;
      }

      if (action === "versions" && request.method === "POST") {
        if (!script) {
          sendError(response, 404, "Worker inesistente: crea il primo script con PUT.");
          return;
        }
        const upload = await readMultipartVersion(request);
        const created = createVersion(script, upload.metadata, upload.workerSource, completionTokens, secretNames, upload.siteWorkerSource);
        if (!created) {
          sendError(response, 400, "Versione non valida o JWT di completamento non valido.");
          return;
        }
        ok(response, { id: created.id }, 201);
        return;
      }

      if (!action && request.method === "PUT") {
        const upload = await readMultipartVersion(request);
        if (script) {
          sendError(response, 409, "Il Worker esiste già.");
          return;
        }
        script = { accountId: routeAccount, name, versions: [], deployments: [] };
        const created = createVersion(script, upload.metadata, upload.workerSource, completionTokens, secretNames, upload.siteWorkerSource);
        if (!created) {
          sendError(response, 400, "Versione iniziale non valida o JWT di completamento non valido.");
          return;
        }
        const deployment: InternalDeployment = {
          id: randomUUID(),
          created_on: new Date().toISOString(),
          strategy: "percentage",
          versions: [{ version_id: created.id, percentage: 100 }],
          annotations: { "workers/message": "Creazione iniziale" },
        };
        script.deployments.push(deployment);
        script.activeVersionId = created.id;
        scripts.set(key, script);
        ok(response, { id: name, version_id: created.id }, 200);
        return;
      }

      if (action === "versions" && request.method === "GET") {
        if (!script) {
          sendError(response, 404, "Worker inesistente.");
          return;
        }
        ok(response, script.versions.map(({ id, created_on, annotations }) => ({ id, created_on, annotations })));
        return;
      }

      if (action === "deployments" && request.method === "GET") {
        if (!script) {
          sendError(response, 404, "Worker inesistente.");
          return;
        }
        ok(response, { deployments: script.deployments });
        return;
      }

      if (action === "deployments" && request.method === "POST") {
        if (!script) {
          sendError(response, 404, "Worker inesistente.");
          return;
        }
        const body = parseJson(await readBody(request, 1024 * 1024));
        const versions = Array.isArray(body?.versions) ? body.versions : [];
        const validVersions = versions.filter((value): value is { version_id: string; percentage: number } => {
          if (typeof value !== "object" || value === null) return false;
          const item = value as Record<string, unknown>;
          return typeof item.version_id === "string" && typeof item.percentage === "number" && Number.isFinite(item.percentage);
        });
        const total = validVersions.reduce((sum, version) => sum + version.percentage, 0);
        const allExist = validVersions.every((version) => script?.versions.some((item) => item.id === version.version_id));
        if (body?.strategy !== "percentage" || validVersions.length !== versions.length || total !== 100 || !allExist) {
          sendError(response, 400, "Deployment non valido: strategia percentage, versioni esistenti e percentuali totali a 100 richieste.");
          return;
        }
        const annotations = stringRecord(body?.annotations);
        const deployment: InternalDeployment = {
          id: randomUUID(),
          created_on: new Date().toISOString(),
          strategy: "percentage",
          versions: validVersions,
          annotations,
        };
        script.deployments.push(deployment);
        const activeVersionId = validVersions.find((version) => version.percentage === 100)?.version_id ?? validVersions[0]?.version_id;
        if (activeVersionId) script.activeVersionId = activeVersionId;
        ok(response, deployment, 201);
        return;
      }

      if (action === "secrets" && request.method === "PUT") {
        const body = parseJson(await readBody(request, 1024 * 1024));
        if (typeof body?.name !== "string" || body.type !== "secret_text" || typeof body.text !== "string") {
          sendError(response, 400, "Il secret deve essere di tipo secret_text.");
          return;
        }
        secretNames.add(`${key}/${body.name}`);
        ok(response, { name: body.name, type: "secret_text" }, 200);
        return;
      }
    }

    if (apiPath === "/zones" && request.method === "GET") {
      const queryAccount = requestUrl.searchParams.get("account.id");
      if (queryAccount && queryAccount !== accountId) {
        ok(response, []);
        return;
      }
      const page = Number(requestUrl.searchParams.get("page") ?? "1");
      const perPage = Number(requestUrl.searchParams.get("per_page") ?? "50");
      const start = Math.max(0, (page - 1) * perPage);
      ok(response, zones.slice(start, start + perPage));
      return;
    }

    const dnsRecordsRoute = apiPath.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/u);
    if (dnsRecordsRoute?.[1] && request.method === "GET" && !dnsRecordsRoute[2]) {
      const exactName = requestUrl.searchParams.get("name.exact")?.toLowerCase();
      const type = requestUrl.searchParams.get("type")?.toUpperCase();
      const records = [...dnsRecords.values()].filter((record) => record.zone_id === dnsRecordsRoute[1]
        && (!exactName || record.name.toLowerCase() === exactName)
        && (!type || record.type === type));
      ok(response, records);
      return;
    }
    if (dnsRecordsRoute?.[1] && dnsRecordsRoute[2] && request.method === "DELETE") {
      const record = dnsRecords.get(dnsRecordsRoute[2]);
      if (!record || record.zone_id !== dnsRecordsRoute[1]) { sendError(response, 404, "Record DNS inesistente."); return; }
      dnsRecords.delete(record.id);
      ok(response, { id: record.id });
      return;
    }
    if (dnsRecordsRoute?.[1] && !dnsRecordsRoute[2] && request.method === "POST") {
      const body = parseJson(await readBody(request, 1024 * 1024));
      const zone = zones.find((item) => item.id === dnsRecordsRoute[1]);
      if (!zone || body?.type !== "CNAME" || typeof body.name !== "string" || typeof body.content !== "string") {
        sendError(response, 400, "Record DNS non valido.");
        return;
      }
      const record: InternalDnsRecord = {
        id: randomUUID(), zone_id: zone.id, name: body.name, type: "CNAME", content: body.content,
        ttl: typeof body.ttl === "number" ? body.ttl : 1, proxied: body.proxied === true,
        ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
        ...(Array.isArray(body.tags) && body.tags.every((tag: unknown) => typeof tag === "string") ? { tags: body.tags as string[] } : {}),
      };
      if ([...dnsRecords.values()].some((candidate) => candidate.zone_id === zone.id && candidate.name.toLowerCase() === record.name.toLowerCase() && candidate.type === "CNAME")) {
        sendError(response, 400, "Esiste già un record CNAME con questo nome.");
        return;
      }
      dnsRecords.set(record.id, record);
      ok(response, record, 201);
      return;
    }

    if (apiPath === `/accounts/${accountId}/workers/domains` && request.method === "GET") {
      const hostname = requestUrl.searchParams.get("hostname")?.toLowerCase();
      ok(response, [...domains.values()].filter((domain) => !hostname || domain.hostname.toLowerCase() === hostname));
      return;
    }

    const workerDomainRoute = apiPath.match(new RegExp(`^/accounts/${accountId}/workers/domains/([^/]+)$`, "u"));
    if (workerDomainRoute?.[1] && request.method === "DELETE") {
      const existing = [...domains.entries()].find(([, domain]) => domain.id === workerDomainRoute[1]);
      if (!existing) { sendError(response, 404, "Dominio Worker inesistente."); return; }
      domains.delete(existing[0]);
      ok(response, null);
      return;
    }

    if (apiPath === `/accounts/${accountId}/workers/domains` && request.method === "PUT") {
      const body = parseJson(await readBody(request, 1024 * 1024));
      const zone = zones.find((item) => item.id === body?.zone_id && item.name === body?.zone_name && (!item.status || item.status === "active"));
      if (typeof body?.hostname !== "string" || typeof body.service !== "string" || !zone || body.enabled !== true || body.previews_enabled !== false) {
        sendError(response, 400, "Dominio non valido: Worker e zona attiva richiesti.");
        return;
      }
      const hostname = body.hostname;
      if ([...dnsRecords.values()].some((record) => record.zone_id === zone.id && record.name.toLowerCase() === hostname.toLowerCase() && record.type === "CNAME")) {
        sendError(response, 400, "Elimina il record CNAME esistente prima di aggiungere un dominio personalizzato.");
        return;
      }
      const existing = domains.get(hostname);
      const domain: InternalDomain = {
        id: existing?.id ?? randomUUID(),
        hostname,
        service: body.service,
        zone_id: zone.id,
        zone_name: zone.name,
        enabled: true,
        previews_enabled: false,
      };
      domains.set(body.hostname, domain);
      ok(response, domain, 200);
      return;
    }

    sendError(response, 404, "Endpoint non trovato.");
  }

  async function readMultipartVersion(request: IncomingMessage): Promise<{ metadata: Record<string, unknown>; workerSource: string; siteWorkerSource?: string }> {
    const body = await readBody(request);
    const parts = parseMultipart(request.headers["content-type"], body);
    const metadataPart = parts.find((part) => part.name === "metadata");
    const workerPart = parts.find((part) => part.name === "worker.js");
    const siteWorkerPart = parts.find((part) => part.name === "_worker.js");
    const metadata = metadataPart ? parseJson(metadataPart.content) : null;
    return { metadata: metadata ?? {}, workerSource: workerPart?.content.toString("utf8") ?? "", ...(siteWorkerPart ? { siteWorkerSource: siteWorkerPart.content.toString("utf8") } : {}) };
  }

  function createVersion(script: InternalScript, metadata: Record<string, unknown>, workerSource: string, completions: Map<string, InternalSession>, registeredSecretNames: Set<string>, siteWorkerSource?: string): InternalVersion | null {
    const assetsMetadata = typeof metadata.assets === "object" && metadata.assets !== null ? metadata.assets as Record<string, unknown> : null;
    const jwt = assetsMetadata?.jwt;
    const session = typeof jwt === "string" ? completions.get(jwt) : undefined;
    const bindings = Array.isArray(metadata.bindings) ? metadata.bindings as Array<Record<string, unknown>> : [];
    const keptBindings = Array.isArray(metadata.keep_bindings) ? metadata.keep_bindings : [];
    const hasAssetsBinding = bindings.some((binding) => binding.type === "assets" && binding.name === "ASSETS");
    const config = typeof assetsMetadata?.config === "object" && assetsMetadata.config !== null ? assetsMetadata.config as Record<string, unknown> : null;
    if (!assetsMetadata || metadata.main_module !== "worker.js" || workerSource.length === 0 || !session?.complete || !hasAssetsBinding || JSON.stringify(keptBindings) !== '["secret_text","kv_namespace"]') return null;
    if (config?.html_handling !== "auto-trailing-slash" || config?.not_found_handling !== "404-page") return null;
    const formSecret = bindings.find((binding) => binding.type === "secret_text" && binding.name === "TURNSTILE_SECRET");
    const runWorkerFirst = config.run_worker_first;
    if (siteWorkerSource !== undefined) {
      // A site's own Worker: the main module imports it and sees every request.
      if (runWorkerFirst !== true || !workerSource.includes('from "./_worker.js"') || !/\bexport\s+default\b/u.test(siteWorkerSource)) return null;
    } else {
      if (!Array.isArray(runWorkerFirst) || !runWorkerFirst.every((route): route is string => typeof route === "string")) return null;
      const expectedWorkerFirst = ["/", "/index.html", ...(formSecret ? ["/xb-form"] : [])];
      if (JSON.stringify(runWorkerFirst) !== JSON.stringify(expectedWorkerFirst)) return null;
    }
    const kvBindings: Array<{ name: string; namespace_id: string }> = [];
    for (const binding of bindings.filter((item) => item.type === "kv_namespace")) {
      if (typeof binding.name !== "string" || typeof binding.namespace_id !== "string" || !kvNamespaces.has(binding.namespace_id)) return null;
      kvBindings.push({ name: binding.name, namespace_id: binding.namespace_id });
    }
    if (formSecret && (typeof formSecret.text !== "string" || formSecret.text.length < 16 || !workerSource.includes("/xb-form"))) return null;
    if (formSecret) registeredSecretNames.add(`${scriptKey(script.accountId, script.name)}/${formSecret.name}`);
    const annotations = stringRecord(metadata.annotations);
    const version: InternalVersion = {
      id: randomUUID(),
      created_on: new Date().toISOString(),
      annotations,
      workerFirstRoutes: runWorkerFirst === true ? true : [...(runWorkerFirst as string[])],
      assetManifest: session.assetManifest,
      // Like Cloudflare: the rules are read from assets.config only; other keys of assets are ignored.
      ...(typeof config._headers === "string" ? { headers: config._headers } : {}),
      ...(typeof config._redirects === "string" ? { redirects: config._redirects } : {}),
      workerSource,
      ...(siteWorkerSource === undefined ? {} : { siteWorkerSource }),
      kvBindings,
    };
    script.versions.push(version);
    return version;
  }

  function serveSite(request: IncomingMessage, response: ServerResponse, requestUrl: URL): void {
    const urlParts = requestUrl.pathname.slice("/__site/".length).split("/");
    const encodedScript = urlParts.shift() ?? "";
    let scriptName: string;
    try { scriptName = decodeURIComponent(encodedScript); }
    catch { response.writeHead(400).end("Percorso non valido"); return; }
    const script = [...scripts.values()].find((item) => item.name === scriptName && item.activeVersionId);
    const version = script?.versions.find((item) => item.id === script.activeVersionId);
    if (!script || !version) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Worker non distribuito");
      return;
    }
    let requestedPath = `/${urlParts.join("/")}`;
    if (requestedPath === "/") requestedPath = "/index.html";
    const redirect = redirectFor(version.redirects, requestedPath);
    if (redirect) {
      response.writeHead(redirect.status, { location: redirect.destination, ...responseHeadersFor(version.headers, requestedPath) }).end();
      return;
    }
    let assetPath = requestedPath;
    if (assetPath.endsWith("/")) assetPath += "index.html";
    if (!version.assetManifest[assetPath] && !requestedPath.endsWith("/") && !path.posix.extname(requestedPath)) {
      if (version.assetManifest[`${requestedPath}/index.html`]) {
        response.writeHead(307, { location: `${requestedPath}/` }).end();
        return;
      }
      if (version.assetManifest[`${requestedPath}.html`]) assetPath = `${requestedPath}.html`;
    }
    const file = version.assetManifest[assetPath];
    if (!file) {
      const notFound = version.assetManifest["/404.html"];
      const notFoundBytes = notFound ? assets.get(notFound.hash) : undefined;
      response.writeHead(404, { "content-type": notFoundBytes ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", ...responseHeadersFor(version.headers, requestedPath) });
      response.end(request.method === "HEAD" ? undefined : notFoundBytes ?? Buffer.from("Not Found"));
      return;
    }
    const content = assets.get(file.hash);
    if (!content) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Asset non presente nel mock");
      return;
    }
    response.writeHead(200, {
      "content-type": assetTypes.get(file.hash) ?? "application/octet-stream",
      "content-length": String(content.byteLength),
      ...responseHeadersFor(version.headers, requestedPath),
    });
    response.end(request.method === "HEAD" ? undefined : content);
  }

  function bearerValue(request: IncomingMessage): string | undefined {
    const value = request.headers.authorization;
    const match = typeof value === "string" ? value.match(/^Bearer\s+(.+)$/iu) : null;
    return match?.[1];
  }

  function hasBearer(request: IncomingMessage, expected: string): boolean {
    return bearerValue(request) === expected;
  }

  function stringRecord(value: unknown): Record<string, string> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) if (typeof item === "string") result[key] = item;
    return result;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Il mock Cloudflare non ha ottenuto una porta locale.");

  return {
    url: `http://127.0.0.1:${address.port}/client/v4`,
    accountId,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    reset: () => {
      clearInternalState(scripts, assets, assetTypes, sessions, domains, secretNames, requestCounts);
      completionTokens.clear();
      failures.splice(0, failures.length);
      uploadRequestCount = 0;
      uploadedAssetCount = 0;
      kvNamespaces.clear();
    },
    state,
    failNext,
  };
}
