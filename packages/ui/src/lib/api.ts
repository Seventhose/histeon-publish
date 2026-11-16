const SESSION_KEY = "histos-publish-session";

/**
 * Reads the session from the address. With the token (desktop app, tests) it is ready at once; with a one-time
 * launch code (browser opened by the CLI) it returns a promise that redeems the code first. Callers start loading
 * only once the session exists, and without a code nothing waits.
 */
export function initializeSession(): string | Promise<string> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fromFragment = fragment.get("token");
  const launch = fragment.get("launch");
  if (fromFragment || launch) history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  if (fromFragment) sessionStorage.setItem(SESSION_KEY, fromFragment);
  else if (launch) return redeemLaunchCode(launch);
  return sessionStorage.getItem(SESSION_KEY) ?? "";
}

async function redeemLaunchCode(code: string): Promise<string> {
  // A browser opened by the CLI gets a one-time code; the session token is fetched once and kept in this tab only.
  const response = await fetch("/__session/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), credentials: "omit", redirect: "error" });
  const body = response.ok ? await response.json() as { token?: unknown } : null;
  if (typeof body?.token === "string") sessionStorage.setItem(SESSION_KEY, body.token);
  return sessionStorage.getItem(SESSION_KEY) ?? "";
}

function token(): string {
  return sessionStorage.getItem(SESSION_KEY) ?? "";
}

export async function api<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Histos-Token", token());
  if (options.body !== undefined && typeof options.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(pathname, { ...options, headers, credentials: "omit", redirect: "error" });
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) throw apiError(body, response.status, `Richiesta non riuscita (${response.status}).`);
  return body as T;
}

/**
 * An error the server returned, with its `code` (E13): the app shows the message for the code in the user's language,
 * and the server's own text as the technical detail. `request-failed` when the server sent no code.
 */
export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function apiError(body: unknown, status: number, fallback: string): ApiError {
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const message = typeof record.error === "string" ? record.error : fallback;
  const code = typeof record.code === "string" && /^[a-z0-9-]{1,80}$/u.test(record.code) ? record.code : "request-failed";
  return new ApiError(message, code, status);
}

export async function uploadFile(pathname: string, file: File): Promise<void> {
  const response = await fetch(pathname, {
    method: "PUT",
    headers: { "X-Histos-Token": token(), "Content-Type": "application/octet-stream" },
    body: file,
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    let value: unknown = null;
    try { value = await response.json(); } catch { /* Keep the generic message. */ }
    throw apiError(value, response.status, `Caricamento non riuscito (${response.status}).`);
  }
}

export async function download(pathname: string, body: Record<string, unknown>, fallbackName: string): Promise<void> {
  const headers = new Headers({ "Content-Type": "application/json", "X-Histos-Token": token() });
  const response = await fetch(pathname, { method: "POST", headers, body: JSON.stringify(body), credentials: "omit", redirect: "error" });
  if (!response.ok) throw await failure(response, `Export non riuscito (${response.status}).`);
  await saveResponse(response, fallbackName);
}

/** A file served by GET (the connector's AI manual), saved like `download` without a request body. */
export async function downloadGet(pathname: string, fallbackName: string): Promise<void> {
  const response = await fetch(pathname, { headers: { "X-Histos-Token": token() }, credentials: "omit", redirect: "error" });
  if (!response.ok) throw await failure(response, `Download non riuscito (${response.status}).`);
  await saveResponse(response, fallbackName);
}

/** A text resource (the AI manual, for "copy the instructions"): the body as is, never parsed as JSON. */
/** A file of the site's media, with its own type: the server checks both. */
export async function uploadMedia(projectId: string, file: File): Promise<{ id: string } | null> {
  const response = await fetch(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/media?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "X-Histos-Token": token(), "Content-Type": file.type || "application/octet-stream" },
    body: file,
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw await failure(response, `Caricamento non riuscito (${response.status}).`);
  const answer = await response.json().catch(() => null) as { asset_id?: string } | null;
  return answer?.asset_id ? { id: answer.asset_id } : null;
}

/** A text file sent as it is, answered in JSON (an XLIFF to read back). */
export async function uploadText<T>(pathname: string, file: File): Promise<T> {
  const response = await fetch(pathname, { method: "POST", headers: { "X-Histos-Token": token(), "Content-Type": "application/xml" }, body: file, credentials: "omit", redirect: "error" });
  if (!response.ok) throw await failure(response, `Caricamento non riuscito (${response.status}).`);
  return await response.json() as T;
}

export async function fetchText(pathname: string): Promise<string> {
  const response = await fetch(pathname, { headers: { "X-Histos-Token": token() }, credentials: "omit", redirect: "error" });
  if (!response.ok) throw await failure(response, `Richiesta non riuscita (${response.status}).`);
  return response.text();
}

async function failure(response: Response, fallback: string): Promise<ApiError> {
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    // Keep the generic message.
  }
  return apiError(value, response.status, fallback);
}

async function saveResponse(response: Response, fallbackName: string): Promise<void> {
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = disposition.match(/filename="([^"]+)"/u)?.[1] ?? fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function uploadTransferArchive<T>(pathname: string, file: File, contentType = "application/zip", signal?: AbortSignal): Promise<T> {
  const response = await fetch(pathname, {
    method: "POST",
    headers: { "X-Histos-Token": token(), "Content-Type": contentType },
    body: file,
    credentials: "omit",
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Import non riuscito (${response.status}).`;
    throw new ImportError(message, response.status, typeof body === "object" && body !== null ? body as Record<string, unknown> : {});
  }
  return body as T;
}

/** A refused import, with the server's code and details (the project an update would touch, the conflicts). */
export class ImportError extends ApiError {
  constructor(message: string, status: number, readonly body: Record<string, unknown>) {
    super(message, typeof body.code === "string" ? body.code : "", status);
    this.name = "ImportError";
  }
}

export async function followJob(jobId: string, onEvent: (event: Record<string, unknown>) => void): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events`, {
    headers: { "X-Histos-Token": token() },
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok || !response.body) throw new Error("Non riesco a seguire l’avanzamento dell’operazione.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const frame of events) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data) continue;
      try { onEvent(JSON.parse(data) as Record<string, unknown>); } catch { /* Ignore malformed progress frames. */ }
    }
    if (done) break;
  }
}

// ------------------------------------------------------------------------------------------------ AI connector
// Mirrors ConnectorSnapshot in packages/server/src/connector-server.ts. Every string in it can come from an agent or
// a remote site (client names, project names, hosts): the UI shows it as text only, never as HTML.

export type ConnectorWordPressMode = "off" | "dry-run" | "confirm" | "auto";
export type ConnectorPushState = "pending" | "applying" | "applied" | "rejected" | "expired" | "failed";

export interface ConnectorActivityEntry {
  seq: number;
  at: string;
  /** The name the agent gives itself: declared, not verified. */
  client: string;
  operation: string;
  outcome: "ok" | "error" | "pending";
  code?: string;
  durationMs: number;
  project?: { id: string; name: string };
  file?: { name: string; bytes: number; sha256: string };
  /** For a failure: the first line of the agent's message, cleaned by the server (at most 160 characters). */
  message?: string;
  /** Small facts the UI turns into a sentence: counts, valid/outcome, build status, host. */
  facts?: Record<string, string | number | boolean>;
}

export interface ConnectorPushView {
  /** "import": an agent's update of an existing project, waiting like a WordPress send (D2). */
  kind?: "wordpress" | "import";
  /** For an import: the prototype file. */
  file?: { name: string; bytes: number; sha256: string };
  requestId: string;
  state: ConnectorPushState;
  host: string;
  client: string;
  project: { id: string; name: string };
  counts: Record<string, number>;
  entities: Array<{ kind: string; label: string; status: string }>;
  omitted: number;
  expiresAt: string;
  /** The send replaces media already on the site: WordPress shows them at once, not at the next release. */
  replacesMedia?: boolean;
  result?: { operationId: string | null; complete: boolean; waitingForRelease: number };
  error?: { code: string; message: string };
}

export interface ConnectorWordPressSite {
  connectionId: string;
  host: string;
  projectId: string | null;
  projectName: string;
  canWrite: boolean;
  mode: ConnectorWordPressMode;
}

export interface ConnectorSnapshot {
  /** Node found on this computer (null while the app is still looking): the commands use its absolute path. */
  node: { path: string | null; version: string | null; supported: boolean } | null;
  enabled: boolean;
  autoStart: boolean;
  since: string | null;
  running: Array<{ operation: string; client: string; startedAt: string }>;
  /** WordPress sends waiting for the user's decision. */
  pending: ConnectorPushView[];
  /** Only the entries after the `after` sequence asked for. */
  activity: ConnectorActivityEntry[];
  lastSeq: number;
  /** Requests the gate refused (bad key, browser origin) since the connector started. */
  rejected: number;
  clients: Array<{ name: string; lastSeen: string; calls: number }>;
  /** An agent connected at least once, in this or an earlier session. */
  connectedBefore: boolean;
  /** claudeCode, codex, codexToml, claudeDesktop, generic, cli: ready to paste, without secrets. */
  commands: Record<string, string>;
  wordpress: ConnectorWordPressSite[];
  exportDirectory: string;
  limits: Record<string, number>;
}

/** `/api/connector*`: the user's controls for the AI connector (session token and Origin like every API call). */
/** A fresh 5-minute preview address for a registered build (the agent's activity log, E5). */
export async function previewCmsBuild(projectId: string, buildId: string): Promise<string> {
  const result = await api<{ previewUrl: string }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}/preview`, { method: "POST", body: "{}" });
  return result.previewUrl;
}

/** The last prototype import of a project (queue D1), kept by the app while it runs. Every string is shown as text. */
export interface ImportReportView {
  projectId: string;
  at: string;
  source: { kind: "app" } | { kind: "agent"; client: string };
  file: string | null;
  result: "created" | "updated";
  counts: Record<string, number>;
  downloaded: number;
  placeholders: string[];
  ignored: Array<{ what: string; why: string; line?: number }>;
  warnings: string[];
  omitted: { placeholders: number; ignored: number; warnings: number };
  /** B6: the images that get modern variants at the build, in words (with the savings when measured). */
  images?: { files: number; uses: number; note: string };
  changed?: number;
  keptLocal?: number;
  unchanged?: number;
}

export async function fetchImportReport(projectId: string): Promise<ImportReportView> {
  return (await api<{ report: ImportReportView }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/import-report`)).report;
}

/** A new address for the throwaway preview of a checked prototype (A2), while it is still on disk. */
export async function previewPrototype(buildId: string): Promise<string> {
  const result = await api<{ previewUrl: string }>(`/api/cms/v1/prototype-previews/${encodeURIComponent(buildId)}/preview`, { method: "POST", body: "{}" });
  return result.previewUrl;
}

export const connectorApi = {
  snapshot: (after = 0) => api<ConnectorSnapshot>(`/api/connector?after=${after}`),
  /** Turning on with the restart choice sends both fields together; `enabled: false` is "Ferma". */
  update: (body: { enabled?: boolean; autoStart?: boolean }) => api<ConnectorSnapshot>("/api/connector", { method: "POST", body: JSON.stringify(body) }),
  interrupt: () => api<{ interrupted: number }>("/api/connector/interrupt", { method: "POST" }),
  wordPressMode: (connectionId: string) => api<{ connectionId: string; mode: ConnectorWordPressMode }>(`/api/connector/wordpress/${encodeURIComponent(connectionId)}`),
  setWordPressMode: (connectionId: string, mode: ConnectorWordPressMode) =>
    api<{ connectionId: string; mode: ConnectorWordPressMode }>(`/api/connector/wordpress/${encodeURIComponent(connectionId)}`, { method: "PUT", body: JSON.stringify({ mode }) }),
  decide: (requestId: string, decision: "approve" | "reject") =>
    api<ConnectorPushView>(`/api/connector/approvals/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify({ decision }) }),
  clearActivity: () => api<{ cleared: boolean }>("/api/connector/activity", { method: "DELETE" }),
  downloadManual: () => downloadGet("/api/connector/manual", "prototipo-histos-manuale-ai.md"),
  manualText: () => fetchText("/api/connector/manual"),
};
