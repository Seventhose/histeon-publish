import { randomUUID } from "node:crypto";
import { HistosPublishError } from "@histos-publish/core";
import type { CmsProjectCatalog } from "@histos-publish/cms";
import { plain } from "@histos-publish/connector/errors";
import { applyRemoteSyncPlan, createRemoteSyncPlan, type CmsRemoteCatalog, type CmsRemoteSecretStore } from "./cms-remote.js";
import { safeErrorMessage } from "./http.js";

/**
 * The connector's gate in front of WordPress (docs/progettazione/histos-cms/16-connettore-ai.md §2.6): it can only
 * send a project IN DEVELOPMENT to a site the user enabled, never initialize a site, publish, pull or roll back. The
 * plan action is the literal "push"; the agent never sees or passes a plan id; deletions always wait for the user.
 */

/**
 * What the agent may send to one site: nothing, only the dry run (doc 23, voce 203: it sees what would change, never
 * sends), a send the user approves, or a send without asking (deletions and replaced media still wait for the user).
 */
export type ConnectorWordPressMode = "off" | "dry-run" | "confirm" | "auto";
export const CONNECTOR_WORDPRESS_MODES: readonly ConnectorWordPressMode[] = ["off", "dry-run", "confirm", "auto"];

/** Whether the mode lets the agent ask for a real send (one the user approves, or one without asking). */
export function modeCanSend(mode: ConnectorWordPressMode): boolean {
  return mode === "confirm" || mode === "auto";
}
export type ConnectorPushState = "pending" | "applying" | "applied" | "rejected" | "expired" | "failed";

export const WORDPRESS_PLANS_PER_HOUR = 6;
export const WORDPRESS_OPEN_REQUESTS = 2;
const ENTITIES_SHOWN = 50;
const CONFLICTS_SHOWN = 100;
const REQUESTS_KEPT = 50;

interface PushRequest {
  requestId: string;
  planId: string;
  connectionId: string;
  projectId: string;
  projectName: string;
  host: string;
  client: string;
  counts: Record<string, number>;
  entities: Array<{ kind: string; label: string; status: string }>;
  omitted: number;
  createdAt: number;
  expiresAt: number;
  state: ConnectorPushState;
  needsApproval: boolean;
  /** The send replaces media already on the site: WordPress applies that at once, not at the next release. */
  replacesMedia: boolean;
  result?: { operationId: string | null; complete: boolean; waitingForRelease: number };
  error?: { code: string; message: string };
  waiters: Set<() => void>;
  timer?: NodeJS.Timeout;
  /** Applied within the agent's own call, which logs it: no second activity entry. */
  quiet?: boolean;
}

export interface ConnectorPushView {
  requestId: string;
  state: ConnectorPushState;
  host: string;
  client: string;
  project: { id: string; name: string };
  counts: Record<string, number>;
  entities: Array<{ kind: string; label: string; status: string }>;
  omitted: number;
  expiresAt: string;
  replacesMedia: boolean;
  result?: PushRequest["result"];
  error?: PushRequest["error"];
}

export interface ConnectorWordPressDeps {
  remoteCatalog: CmsRemoteCatalog;
  projects: CmsProjectCatalog;
  secretStoreFor: (account: string) => CmsRemoteSecretStore;
  mode: (connectionId: string) => ConnectorWordPressMode;
  /** Whether the connector is still on: checked again right before applying. */
  active: () => boolean;
  createPlan?: typeof createRemoteSyncPlan;
  applyPlan?: typeof applyRemoteSyncPlan;
  /** A request changed state outside an agent call (approved, rejected, expired, applied, failed). */
  onEvent?: (view: ConnectorPushView) => void;
  /** A send the user approved runs after the API answered: closing the app waits for it like any CMS request. */
  track?: (work: Promise<unknown>) => void;
  now?: () => number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "sito WordPress";
  }
}

function errorCode(error: unknown): string {
  return error instanceof HistosPublishError && /^[a-z0-9-]{1,80}$/u.test(error.code) ? error.code : "connector-wordpress-failed";
}

export class ConnectorWordPress {
  private readonly requests = new Map<string, PushRequest>();
  private readonly planTimes: number[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorWordPressDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The connected sites with only what the agent needs: never secrets, scopes beyond write, or history. */
  connections(): Array<{ connectionId: string; host: string; projectId: string | null; projectName: string; canWrite: boolean; mode: ConnectorWordPressMode }> {
    return this.deps.remoteCatalog.list().map((connection) => ({
      connectionId: connection.id,
      host: plain(hostOf(connection.url), 200),
      projectId: connection.projectId,
      projectName: plain(connection.projectName, 120),
      canWrite: connection.write,
      mode: this.deps.mode(connection.id),
    }));
  }

  private view(request: PushRequest): ConnectorPushView {
    return {
      requestId: request.requestId,
      state: request.state,
      host: request.host,
      client: request.client,
      project: { id: request.projectId, name: request.projectName },
      counts: request.counts,
      entities: request.entities,
      omitted: request.omitted,
      expiresAt: new Date(request.expiresAt).toISOString(),
      replacesMedia: request.replacesMedia,
      ...(request.result ? { result: request.result } : {}),
      ...(request.error ? { error: request.error } : {}),
    };
  }

  private settle(request: PushRequest, state: ConnectorPushState, error?: { code: string; message: string }): void {
    request.state = state;
    if (error) request.error = error;
    if (request.timer) clearTimeout(request.timer);
    if (state !== "applying" && state !== "pending") this.deps.remoteCatalog.takeSyncPlan(request.planId);
    for (const wake of request.waiters) wake();
    request.waiters.clear();
    if (!request.quiet) this.deps.onEvent?.(this.view(request));
  }

  private open(): PushRequest[] {
    return [...this.requests.values()].filter((request) => request.state === "pending" || request.state === "applying");
  }

  private expireOld(): void {
    const now = this.now();
    for (const request of this.requests.values()) {
      if (request.state === "pending" && request.expiresAt <= now) this.settle(request, "expired", { code: "connector-wordpress-expired", message: "La richiesta è scaduta: nessuno l'ha approvata in tempo." });
    }
    const finished = [...this.requests.values()].filter((request) => request.state !== "pending" && request.state !== "applying");
    for (const request of finished.slice(0, Math.max(0, this.requests.size - REQUESTS_KEPT))) this.requests.delete(request.requestId);
  }

  async push(input: { projectId: string; connectionId: string; dryRun: boolean; client: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.expireOld();
    const connection = this.deps.remoteCatalog.get(input.connectionId);
    if (!connection) throw new HistosPublishError("Collegamento WordPress non trovato.", "cms-remote-connection-missing", 404);
    if (this.deps.mode(connection.id) === "off") {
      throw new HistosPublishError("L'utente non ha permesso al connettore di inviare a questo sito. Se serve, chiedigli di sceglierlo in Histeon Publish, nel progetto: Pubblicazione → Siti collegati → «Invio dell'agente AI a questo sito».", "connector-wordpress-off", 403);
    }
    // «Solo prove»: refused here, before any plan or rate slot, whatever the agent passes.
    if (!input.dryRun && !modeCanSend(this.deps.mode(connection.id))) {
      throw new HistosPublishError("L'utente ha permesso all'agente solo l'invio di prova a questo sito: usa dryRun: true. Per un invio vero chiedigli di cambiare il permesso in Histeon Publish, nel progetto: Pubblicazione → Siti collegati → «Invio dell'agente AI a questo sito».", "connector-wordpress-dry-run-only", 403);
    }
    if (!connection.write) throw new HistosPublishError("Questo collegamento non permette l'invio.", "cms-remote-write-scope-required", 403);
    if (connection.projectId === null) {
      throw new HistosPublishError("Il primo invio a questo sito lo fa l'utente da Histeon Publish.", "connector-wordpress-initializing", 409);
    }
    if (connection.projectId !== input.projectId) {
      throw new HistosPublishError("Il sito WordPress è collegato a un altro progetto.", "connector-wordpress-project-mismatch", 409);
    }
    const now = this.now();
    while (this.planTimes.length && (this.planTimes[0] as number) <= now - 3_600_000) this.planTimes.shift();
    if (this.planTimes.length >= WORDPRESS_PLANS_PER_HOUR) {
      throw new HistosPublishError(`Al massimo ${WORDPRESS_PLANS_PER_HOUR} piani WordPress all'ora: riprova più tardi.`, "connector-rate-limited", 429);
    }
    // A request still waiting for the same site will be replaced (below, only by an applicable send), so it does not
    // count against the limit; a dry run or a failed plan never cancels what the user is about to approve.
    if (this.open().filter((request) => !(request.connectionId === connection.id && request.state === "pending")).length >= WORDPRESS_OPEN_REQUESTS) {
      throw new HistosPublishError("Ci sono già due invii in attesa: aspetta che l'utente decida.", "connector-wordpress-busy", 429);
    }
    this.planTimes.push(now);
    const plan = await (this.deps.createPlan ?? createRemoteSyncPlan)({ action: "push", connectionId: connection.id, projectId: input.projectId }, this.deps.remoteCatalog, this.deps.projects, this.deps.secretStoreFor);
    const discard = () => {
      if (plan.planId) this.deps.remoteCatalog.takeSyncPlan(plan.planId);
    };
    // Interrompi, Ferma or an MCP cancellation while the plan was prepared: nothing is registered or applied.
    if (signal?.aborted || !this.deps.active()) {
      discard();
      throw new HistosPublishError("Operazione annullata.", "connector-cancelled", 499);
    }
    if (plan.action !== "push" || plan.initializingRemote || plan.project.id !== input.projectId || plan.connectionId !== connection.id) {
      discard();
      throw new HistosPublishError("Il piano WordPress non corrisponde alla richiesta: non l'ho applicato.", "connector-wordpress-plan-invalid", 500);
    }
    const counts = Object.fromEntries(Object.entries(plan.counts).map(([key, value]) => [key, Number(value) || 0]));
    const entities = plan.entities.filter((entity) => entity.status !== "unchanged").slice(0, ENTITIES_SHOWN).map((entity) => ({ kind: plain(entity.kind, 40), label: plain(entity.label, 120), status: entity.status }));
    const changed = plan.entities.filter((entity) => entity.status !== "unchanged").length + plan.omittedEntities;
    const omitted = Math.max(0, changed - entities.length);
    if (!plan.applyAllowed || !plan.planId) {
      discard();
      const conflicts = plan.entities.filter((entity) => entity.status === "conflict").slice(0, CONFLICTS_SHOWN).map((entity) => ({ kind: plain(entity.kind, 40), label: plain(entity.label, 120) }));
      return { state: "not-applicable", reason: "Ci sono conflitti con WordPress: li risolve l'utente in Histeon Publish.", counts, conflicts };
    }
    // WordPress replaces the bytes of an existing attachment in place even on a development import, so the live site
    // changes at once: such a send always waits for the user. Entities beyond the plan's list cannot be ruled out.
    const replacesMedia = plan.omittedEntities > 0 || plan.entities.some((entity) => entity.kind === "asset" && entity.status === "update");
    if (input.dryRun) {
      discard();
      return { state: "dry-run", counts, entities, omitted, replacesMedia };
    }
    for (const request of this.open()) {
      if (request.connectionId === connection.id && request.state === "pending") this.settle(request, "expired", { code: "connector-wordpress-superseded", message: "Sostituita da una nuova richiesta." });
    }
    const request: PushRequest = {
      requestId: randomUUID(),
      planId: plan.planId,
      connectionId: connection.id,
      projectId: input.projectId,
      projectName: plain(plan.project.name, 120),
      host: plain(hostOf(connection.url), 200),
      client: input.client,
      counts,
      entities,
      omitted,
      createdAt: now,
      expiresAt: plan.expiresAt ? Date.parse(plan.expiresAt) : now + 600_000,
      state: "pending",
      needsApproval: this.deps.mode(connection.id) !== "auto" || (counts.delete ?? 0) > 0 || replacesMedia,
      replacesMedia,
      waiters: new Set(),
    };
    this.requests.set(request.requestId, request);
    if (!request.needsApproval) {
      request.quiet = true;
      await this.apply(request);
      return { ...this.view(request) };
    }
    request.timer = setTimeout(() => this.expireOld(), Math.max(0, request.expiresAt - this.now()) + 50);
    request.timer.unref?.();
    this.deps.onEvent?.(this.view(request));
    return { ...this.view(request), message: "Chiedi all'utente di approvare l'invio in Histeon Publish, poi controlla con hp_wordpress_push_status." };
  }

  private async apply(request: PushRequest): Promise<void> {
    request.state = "applying";
    if (request.timer) clearTimeout(request.timer);
    const pending = this.deps.remoteCatalog.getSyncPlan(request.planId);
    // The permission is read again: «Mai» or «Solo prove» chosen while the request waited refuses it.
    if (!this.deps.active() || !modeCanSend(this.deps.mode(request.connectionId))) {
      this.settle(request, "rejected", { code: "connector-wordpress-off", message: "Il connettore o il permesso d'invio sono stati spenti." });
      return;
    }
    if (!pending || pending.action !== "push" || pending.connectionId !== request.connectionId || pending.projectId !== request.projectId) {
      this.settle(request, "failed", { code: "connector-wordpress-plan-changed", message: "Il piano non è più valido: ripeti la richiesta." });
      return;
    }
    try {
      const result = await (this.deps.applyPlan ?? applyRemoteSyncPlan)({ connectionId: request.connectionId, planId: request.planId, expectedProjectId: request.projectId, resolutions: {} }, this.deps.remoteCatalog, this.deps.projects, this.deps.secretStoreFor);
      const report = result.report && typeof result.report === "object" ? result.report as Record<string, unknown> : {};
      request.result = {
        operationId: typeof report.operationId === "string" ? report.operationId : null,
        complete: result.complete === true,
        waitingForRelease: Array.isArray(report.pending) ? report.pending.length : 0,
      };
      this.settle(request, "applied");
    } catch (error) {
      this.settle(request, "failed", { code: errorCode(error), message: plain(safeErrorMessage(error), 500) });
    }
  }

  async status(requestId: string, waitSeconds: number, signal?: AbortSignal): Promise<ConnectorPushView> {
    this.expireOld();
    const request = this.requests.get(requestId);
    if (!request) throw new HistosPublishError("Richiesta d'invio sconosciuta o troppo vecchia.", "connector-wordpress-request-missing", 404);
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

  /** Requests waiting for the user, for the approval banner. */
  approvals(): ConnectorPushView[] {
    this.expireOld();
    return [...this.requests.values()].filter((request) => request.state === "pending").map((request) => this.view(request));
  }

  /** The user's decision from the app. Approving starts the send and returns at once. */
  decide(requestId: string, decision: "approve" | "reject"): ConnectorPushView {
    this.expireOld();
    const request = this.requests.get(requestId);
    if (!request || request.state !== "pending") throw new HistosPublishError("Questa richiesta non è più in attesa.", "connector-approval-missing", 404);
    if (decision === "reject") this.settle(request, "rejected", { code: "connector-wordpress-rejected", message: "L'utente ha rifiutato l'invio." });
    else {
      const work = this.apply(request);
      this.deps.track?.(work);
      void work;
    }
    return this.view(request);
  }

  /** The connector stopped: every request still waiting is refused and its plan dropped. */
  discardAll(message: string): void {
    for (const request of this.requests.values()) {
      if (request.state === "pending") this.settle(request, "rejected", { code: "connector-stopped", message });
    }
  }
}
