import { randomUUID } from "node:crypto";
import { HistosPublishError } from "@histos-publish/core";
import { plain } from "@histos-publish/connector/errors";
import { hideFilePaths, safeErrorMessage } from "./http.js";
import { PrototypeInvalidError, type PrototypeChanges } from "./prototype-check.js";
import type { ConnectorPushView } from "./connector-wordpress.js";

/**
 * Updates of an existing project that an agent asked for with `update: true` (queue D2 for the agent): the prototype
 * waits in memory and the update runs only after the user approves it in the app, next to the WordPress sends, with
 * what it would change. Agreement in the chat is not enough. Ten minutes to decide; "Ferma" refuses what waits.
 */

export type ConnectorImportState = "pending" | "applying" | "applied" | "rejected" | "expired" | "failed";

/** Prototypes waiting at once: each one is kept in memory (up to the 32 MiB of an upload). */
export const IMPORT_OPEN_REQUESTS = 2;
export const IMPORT_APPROVAL_MS = 10 * 60_000;
const ENTITIES_SHOWN = 50;
const REQUESTS_KEPT = 50;

/** What the agent's update did, once approved and applied. */
export interface ConnectorImportOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface ImportRequest {
  requestId: string;
  projectId: string;
  projectName: string;
  client: string;
  file: { name: string; bytes: number; sha256: string };
  /** The prototype itself, dropped as soon as the request is settled. */
  html: string | null;
  download: boolean;
  /** The state the user saw the changes of: the update refuses to run on anything else. */
  basis: PrototypeChanges["basis"];
  /** Set while the approved update runs: "Interrompi" and "Ferma" abort it. */
  controller?: AbortController;
  counts: Record<string, number>;
  entities: Array<{ kind: string; label: string; status: string }>;
  omitted: number;
  expiresAt: number;
  state: ConnectorImportState;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  waiters: Set<() => void>;
  timer?: NodeJS.Timeout;
}

/**
 * The text of a failed approved update as the agent reads it (hp_import_status): cleaned as the connector cleans any
 * error it answers with, file paths first (an fs error of the backup or of the import names a file of the data folder,
 * with the user's name in it; `folders` are hidden whole, as the home is), then what looks like a token, then control
 * and invisible characters.
 */
function agentMessage(text: string, error: unknown, folders: readonly string[]): string {
  // A refused prototype keeps its slugs and template refs, as on the connector's other paths (E4).
  return plain(safeErrorMessage(new Error(hideFilePaths(text, error, folders)), { keepSlugs: error instanceof PrototypeInvalidError }), 500);
}

/** The banner shows import requests in the same shape as WordPress sends, with `kind: "import"` and the file. */
export type ConnectorImportView = Omit<ConnectorPushView, "result"> & { kind: "import"; file: { name: string; bytes: number; sha256: string }; result?: Record<string, unknown> };

export interface ConnectorImportsDeps {
  /** Runs the update with the prototype the user approved (backup first). */
  apply: (input: { html: string; download: boolean; client: string; source: string; sha256: string; basis: PrototypeChanges["basis"]; signal: AbortSignal }) => Promise<ConnectorImportOutcome>;
  /** Whether the connector is still on: checked again right before applying. */
  active: () => boolean;
  /** A request changed state outside an agent call (approved, rejected, expired, applied, failed). */
  onEvent?: (view: ConnectorImportView) => void;
  /** An approved update runs after the API answered: closing the app waits for it. */
  track?: (work: Promise<unknown>) => void;
  /**
   * The folders a message to the agent never names, any part of them, besides the home and the default data folder
   * (hideFilePaths): the data folder the server runs on (ConnectorService passes it), which may be elsewhere.
   */
  privateFolders?: readonly string[];
  now?: () => number;
}

export class ConnectorImports {
  private readonly requests = new Map<string, ImportRequest>();
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorImportsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private view(request: ImportRequest): ConnectorImportView {
    return {
      kind: "import",
      requestId: request.requestId,
      state: request.state,
      host: "",
      client: request.client,
      project: { id: request.projectId, name: request.projectName },
      file: { name: request.file.name, bytes: request.file.bytes, sha256: request.file.sha256.slice(0, 12) },
      counts: request.counts,
      entities: request.entities,
      omitted: request.omitted,
      expiresAt: new Date(request.expiresAt).toISOString(),
      replacesMedia: false,
      ...(request.result ? { result: request.result } : {}),
      ...(request.error ? { error: request.error } : {}),
    };
  }

  private settle(request: ImportRequest, state: ConnectorImportState, error?: { code: string; message: string }): void {
    request.state = state;
    if (error) request.error = error;
    if (request.timer) clearTimeout(request.timer);
    if (state !== "pending" && state !== "applying") request.html = null;
    for (const wake of request.waiters) wake();
    request.waiters.clear();
    this.deps.onEvent?.(this.view(request));
  }

  private open(): ImportRequest[] {
    return [...this.requests.values()].filter((request) => request.state === "pending" || request.state === "applying");
  }

  private expireOld(): void {
    const now = this.now();
    for (const request of this.requests.values()) {
      if (request.state === "pending" && request.expiresAt <= now) this.settle(request, "expired", { code: "connector-import-expired", message: "La richiesta è scaduta: nessuno l'ha approvata in tempo." });
    }
    const finished = [...this.requests.values()].filter((request) => request.state !== "pending" && request.state !== "applying");
    for (const request of finished.slice(0, Math.max(0, this.requests.size - REQUESTS_KEPT))) this.requests.delete(request.requestId);
  }

  /** A new update waiting for the user; an older one for the same project is replaced. */
  request(input: { projectId: string; projectName: string; client: string; html: string; download: boolean; file: ImportRequest["file"]; changes: PrototypeChanges }): ConnectorImportView {
    if (!this.deps.active()) throw new HistosPublishError("Il connettore è stato fermato.", "connector-stopped", 503);
    this.expireOld();
    for (const request of this.open()) {
      if (request.projectId === input.projectId && request.state === "pending") this.settle(request, "expired", { code: "connector-import-superseded", message: "Sostituita da una nuova richiesta." });
    }
    if (this.open().length >= IMPORT_OPEN_REQUESTS) throw new HistosPublishError("Ci sono già aggiornamenti in attesa della conferma dell'utente: aspetta che li decida.", "connector-import-busy", 429);
    const { changes } = input;
    const listed = [
      ...changes.added.map((item) => ({ ...item, status: "new" })),
      ...changes.modified.map((item) => ({ ...item, status: "update" })),
      ...changes.removed.map((item) => ({ ...item, status: "delete" })),
      ...changes.keptLocal.map((item) => ({ ...item, status: "kept" })),
    ];
    const request: ImportRequest = {
      requestId: randomUUID(),
      projectId: input.projectId,
      projectName: plain(input.projectName, 120),
      client: input.client,
      file: input.file,
      html: input.html,
      download: input.download,
      basis: changes.basis,
      counts: { new: changes.added.length, update: changes.modified.length, delete: changes.removed.length, kept: changes.keptLocal.length, unchanged: changes.unchanged },
      entities: listed.slice(0, ENTITIES_SHOWN).map((item) => ({ kind: plain(item.kind, 40), label: plain(item.label, 120), status: item.status })),
      omitted: Math.max(0, listed.length - ENTITIES_SHOWN) + changes.omitted,
      expiresAt: this.now() + IMPORT_APPROVAL_MS,
      state: "pending",
      waiters: new Set(),
    };
    this.requests.set(request.requestId, request);
    request.timer = setTimeout(() => this.expireOld(), IMPORT_APPROVAL_MS + 50);
    request.timer.unref?.();
    this.deps.onEvent?.(this.view(request));
    return this.view(request);
  }

  private async apply(request: ImportRequest): Promise<void> {
    request.state = "applying";
    if (request.timer) clearTimeout(request.timer);
    const html = request.html;
    if (!this.deps.active() || html === null) {
      this.settle(request, "rejected", { code: "connector-stopped", message: "Il connettore è stato fermato." });
      return;
    }
    request.controller = new AbortController();
    try {
      const outcome = await this.deps.apply({ html, download: request.download, client: request.client, source: request.file.name, sha256: request.file.sha256, basis: request.basis, signal: request.controller.signal });
      if (outcome.status === 200) {
        request.result = outcome.body;
        this.settle(request, "applied");
      } else {
        const code = typeof outcome.body.code === "string" ? outcome.body.code : "connector-import-failed";
        const message = agentMessage(typeof outcome.body.error === "string" ? outcome.body.error : "Aggiornamento non riuscito.", undefined, this.deps.privateFolders ?? []);
        request.result = { ...outcome.body, ...(typeof outcome.body.error === "string" ? { error: message } : {}) };
        this.settle(request, "failed", { code: plain(code, 80), message });
      }
    } catch (error) {
      const cancelled = request.controller.signal.aborted;
      const code = cancelled ? "connector-cancelled" : error instanceof HistosPublishError && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : "connector-import-failed";
      this.settle(request, "failed", { code, message: cancelled ? "Aggiornamento interrotto prima di cambiare il progetto." : agentMessage(error instanceof Error ? error.message : "Aggiornamento non riuscito.", error, this.deps.privateFolders ?? []) });
    } finally {
      delete request.controller;
    }
  }

  /** "Interrompi": approved updates still running stop before they change the project. */
  interrupt(): number {
    const running = [...this.requests.values()].filter((request) => request.controller);
    for (const request of running) request.controller?.abort();
    return running.length;
  }

  async status(requestId: string, waitSeconds: number, signal?: AbortSignal): Promise<ConnectorImportView> {
    this.expireOld();
    const request = this.requests.get(requestId);
    if (!request) throw new HistosPublishError("Richiesta d'aggiornamento sconosciuta o troppo vecchia.", "connector-import-request-missing", 404);
    if ((request.state === "pending" || request.state === "applying") && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          request.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitSeconds * 1000);
        signal?.addEventListener("abort", done, { once: true });
        request.waiters.add(done);
      });
      this.expireOld();
    }
    return this.view(request);
  }

  has(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  /** Requests waiting for the user, for the approval banner. */
  approvals(): ConnectorImportView[] {
    this.expireOld();
    return [...this.requests.values()].filter((request) => request.state === "pending").map((request) => this.view(request));
  }

  /** The user's decision from the app. Approving starts the update and returns at once. */
  decide(requestId: string, decision: "approve" | "reject"): ConnectorImportView {
    this.expireOld();
    const request = this.requests.get(requestId);
    if (request?.state !== "pending") throw new HistosPublishError("Questa richiesta non è più in attesa.", "connector-approval-missing", 404);
    if (decision === "reject") this.settle(request, "rejected", { code: "connector-import-rejected", message: "L'utente ha rifiutato l'aggiornamento." });
    else {
      const work = this.apply(request);
      this.deps.track?.(work);
      void work;
    }
    return this.view(request);
  }

  /** The connector stopped: every update still waiting is refused and its prototype dropped; a running one stops. */
  discardAll(message: string): void {
    this.interrupt();
    for (const request of this.requests.values()) {
      if (request.state === "pending") this.settle(request, "rejected", { code: "connector-stopped", message });
    }
  }
}
