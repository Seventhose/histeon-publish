import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HistosPublishError, type DestinationPlanMetadata } from "@histos-publish/core";
import type { TransferLeftOut } from "@histos-publish/histos-contract";
import { MAX_ARCHIVE_BYTES, UUID, validateEntityHeads } from "./cms-remote-transport.js";
import type { HisteonSiteNotice } from "./histeon-version.js";

/** Histeon CMS links and operations kept on this computer (SQLite catalog), and their shared types. */
export interface CmsRemoteSecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

export interface CmsRemoteConnection {
  id: string;
  url: string;
  siteId: string;
  projectId: string | null;
  projectName: string;
  profile: string;
  read: boolean;
  write: boolean;
  publish: boolean;
  connectedAt: string;
  lastCheckedAt: string;
  lastSyncedAt: string | null;
  /**
   * Doc 23 item 175: the site's Histeon as its capabilities said it at the last reading: a version, null when the site
   * does not say it (0.5.1 or earlier); absent until the first reading after this Publish (older catalogs).
   */
  siteHisteon?: string | null;
}

export type CmsSyncAction = "pull" | "push" | "publish";
export type CmsRemoteOperationAction = "push" | "publish";
export type CmsRemoteOperationState =
  | "pending"
  | "applying"
  | "partial"
  | "superseded"
  | "not-found"
  | "complete"
  | "complete-local-changes"
  | "rolled-back"
  | "failed";
export interface CmsRemoteOperation {
  operationId: string;
  connectionId: string;
  projectId: string;
  action: CmsRemoteOperationAction;
  state: CmsRemoteOperationState;
  expectedEntityCount: number;
  createdAt: string;
  updatedAt: string;
  message: string | null;
  rollbackAvailable: boolean;
  rollbackRetryAvailable?: boolean;
  rollbackOfOperationId?: string;
}
export interface CmsRemoteOperationRecord extends CmsRemoteOperation {
  expectedHeads: Record<string, string>;
  archiveHash: string;
  resultHeads: Record<string, string> | null;
}
export type CmsSyncPlanStatus = "new" | "update" | "delete" | "unchanged" | "local-only" | "remote-only" | "conflict";
export type CmsSyncConflictChoice = "keep-local" | "use-remote";
export interface CmsSyncFieldComparison {
  field: string;
  local: string;
  remote: string;
}
export interface CmsSyncPlanEntity {
  id: string;
  kind: string;
  label: string;
  status: CmsSyncPlanStatus;
  canResolve: boolean;
  comparison?: CmsSyncFieldComparison[];
  omittedComparisonFields?: number;
  blockedReason?: "local-missing" | "remote-missing" | "type-changed" | "tombstone-conflict" | "tombstone-unsupported";
  /** A page or a post, for a document: the plan groups them apart (doc 23 items 199-200). */
  documentType?: "page" | "post";
  /**
   * Doc 23 item 200, on a send: why an entry is only on the site. `only-on-site`: the project does not have it;
   * `changed-on-site`: the site changed it after the last common version and the project did not.
   */
  onSite?: "only-on-site" | "changed-on-site";
}
export interface TransferPlan extends DestinationPlanMetadata {
  schemaVersion: 1;
  planId: string | null;
  action: CmsSyncAction;
  connectionId: string;
  project: { id: string; name: string };
  profile: string;
  initializingRemote: boolean;
  expiresAt: string | null;
  applyAllowed: boolean;
  counts: Record<CmsSyncPlanStatus, number>;
  entities: CmsSyncPlanEntity[];
  omittedEntities: number;
  /** What the site has and cannot carry: it stays out of the transfer. */
  leftOut: TransferLeftOut[];
  /** Doc 23 item 175: on a send, the site's Histeon is older than the one Publish knows, and what will not work. */
  histeon?: HisteonSiteNotice;
  /**
   * Doc 23 items 199-200: a download of only some entries («Porta nel progetto», «Risolvi i conflitti»): how many were
   * chosen and how many the plan takes with what they need that the project does not have.
   */
  bring?: { requested: number; total: number };
}

/** @deprecated Keep the established API name while callers migrate to TransferPlan. */
export type CmsSyncPlan = TransferPlan;

export interface PendingSyncPlan {
  connectionId: string;
  action: CmsSyncAction;
  projectId: string;
  remoteFingerprint: string;
  localFingerprint: string | null;
  resolvableConflictIds: string[];
  expiresAt: number;
  /** A download of only these entries (doc 23 items 199-200): decided by the server when the plan was made. */
  only?: string[];
}

export interface ParsedLink {
  url: string;
  secret: Buffer;
  read: boolean;
  write: boolean;
  publish: boolean;
}

export class CmsRemoteCatalog {
  private readonly database: DatabaseSync;
  private readonly syncPlans = new Map<string, PendingSyncPlan>();

  constructor(dataDirectory: string) {
    this.database = new DatabaseSync(path.join(dataDirectory, "histos-cms-catalog.sqlite"));
    this.database.exec(`CREATE TABLE IF NOT EXISTS remote_connections (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      site_id TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT NOT NULL,
      profile TEXT NOT NULL,
      can_read INTEGER NOT NULL,
      can_write INTEGER NOT NULL,
      can_publish INTEGER NOT NULL,
      connected_at TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS remote_operations (
      operation_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action TEXT NOT NULL,
      state TEXT NOT NULL,
      expected_heads TEXT NOT NULL,
      archive_hash TEXT NOT NULL,
      previous_archive BLOB,
      request_archive BLOB,
      result_heads TEXT,
      rollback_of_operation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS remote_operations_connection_updated ON remote_operations(connection_id, updated_at DESC)`);
    const operationColumns = this.database.prepare("PRAGMA table_info(remote_operations)").all() as Array<Record<string, unknown>>;
    if (!operationColumns.some((column) => column.name === "previous_archive")) {
      this.database.exec("ALTER TABLE remote_operations ADD COLUMN previous_archive BLOB");
    }
    if (!operationColumns.some((column) => column.name === "request_archive")) {
      this.database.exec("ALTER TABLE remote_operations ADD COLUMN request_archive BLOB");
    }
    if (!operationColumns.some((column) => column.name === "result_heads")) {
      this.database.exec("ALTER TABLE remote_operations ADD COLUMN result_heads TEXT");
    }
    const connectionColumns = this.database.prepare("PRAGMA table_info(remote_connections)").all() as Array<Record<string, unknown>>;
    // Doc 23 item 175: NULL until a reading, '' when the site does not say its Histeon, or its version.
    if (!connectionColumns.some((column) => column.name === "site_histeon")) {
      this.database.exec("ALTER TABLE remote_connections ADD COLUMN site_histeon TEXT");
    }
    // Doc 23 item 201: NULL until the user answers the proposal of the site's home page, then "accepted" or "declined".
    if (!connectionColumns.some((column) => column.name === "front_page_offer")) {
      this.database.exec("ALTER TABLE remote_connections ADD COLUMN front_page_offer TEXT");
    }
    if (!operationColumns.some((column) => column.name === "rollback_of_operation_id")) {
      this.database.exec("ALTER TABLE remote_operations ADD COLUMN rollback_of_operation_id TEXT");
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS remote_operations_rollback_parent
        ON remote_operations(connection_id, rollback_of_operation_id, state)
        WHERE rollback_of_operation_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS remote_operations_one_active_rollback
        ON remote_operations(connection_id, rollback_of_operation_id)
        WHERE rollback_of_operation_id IS NOT NULL AND state IN ('pending', 'applying', 'partial');
    `);
  }

  list(): CmsRemoteConnection[] {
    const rows = this.database.prepare("SELECT * FROM remote_connections ORDER BY connected_at DESC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(connectionFromRow);
  }

  get(id: string): CmsRemoteConnection | null {
    const row = this.database.prepare("SELECT * FROM remote_connections WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? connectionFromRow(row) : null;
  }

  add(input: Omit<CmsRemoteConnection, "connectedAt" | "lastCheckedAt" | "lastSyncedAt">): CmsRemoteConnection {
    const now = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO remote_connections(id, url, site_id, project_id, project_name, profile, can_read, can_write, can_publish, connected_at, checked_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        input.id,
        input.url,
        input.siteId,
        input.projectId,
        input.projectName,
        input.profile,
        Number(input.read),
        Number(input.write),
        Number(input.publish),
        now,
        now,
      );
    return this.get(input.id)!;
  }

  updateRemote(
    id: string,
    patch: { projectId?: string | null; projectName?: string; lastCheckedAt?: string; lastSyncedAt?: string; siteHisteon?: string | null },
  ): void {
    const current = this.get(id);
    if (!current) throw new Error("Collegamento remoto non trovato.");
    const siteHisteon = patch.siteHisteon === undefined ? current.siteHisteon : patch.siteHisteon;
    this.database
      .prepare(
        "UPDATE remote_connections SET project_id = ?, project_name = ?, checked_at = ?, synced_at = ?, site_histeon = ? WHERE id = ?",
      )
      .run(
        patch.projectId === undefined ? current.projectId : patch.projectId,
        patch.projectName ?? current.projectName,
        patch.lastCheckedAt ?? current.lastCheckedAt,
        patch.lastSyncedAt ?? current.lastSyncedAt,
        siteHisteon === undefined ? null : siteHisteon ?? "",
        id,
      );
  }

  /** The user's answer to the proposal of the site's home and posts page (doc 23 item 201), or null before one. */
  frontPageAnswer(id: string): "accepted" | "declined" | null {
    const row = this.database.prepare("SELECT front_page_offer FROM remote_connections WHERE id = ?").get(id) as { front_page_offer?: unknown } | undefined;
    return row?.front_page_offer === "accepted" || row?.front_page_offer === "declined" ? row.front_page_offer : null;
  }

  setFrontPageAnswer(id: string, answer: "accepted" | "declined"): void {
    if (!this.get(id)) throw new Error("Collegamento remoto non trovato.");
    this.database.prepare("UPDATE remote_connections SET front_page_offer = ? WHERE id = ?").run(answer, id);
  }

  updateConnection(
    id: string,
    patch: Pick<CmsRemoteConnection, "url" | "siteId" | "projectId" | "projectName" | "profile" | "read" | "write" | "publish">,
  ): void {
    if (!this.get(id)) throw new Error("Collegamento remoto non trovato.");
    this.database.prepare("UPDATE remote_connections SET url = ?, site_id = ?, project_id = ?, project_name = ?, profile = ?, can_read = ?, can_write = ?, can_publish = ?, checked_at = ? WHERE id = ?")
      .run(patch.url, patch.siteId, patch.projectId, patch.projectName, patch.profile, Number(patch.read), Number(patch.write), Number(patch.publish), new Date().toISOString(), id);
  }

  remove(id: string): boolean {
    for (const [planId, plan] of this.syncPlans) {
      if (plan.connectionId === id) this.syncPlans.delete(planId);
    }
    this.database.prepare("DELETE FROM remote_operations WHERE connection_id = ?").run(id);
    return this.database.prepare("DELETE FROM remote_connections WHERE id = ?").run(id).changes > 0;
  }

  recordOperation(input: {
    operationId: string;
    connectionId: string;
    projectId: string;
    action: CmsRemoteOperationAction;
    expectedHeads: Record<string, string>;
    archiveHash: string;
    previousArchive?: Uint8Array | null;
    requestArchive?: Uint8Array | null;
    rollbackOfOperationId?: string;
    supersedeOperationId?: string;
  }): CmsRemoteOperation {
    if (
      !UUID.test(input.operationId) ||
      !UUID.test(input.connectionId) ||
      !UUID.test(input.projectId) ||
      Object.keys(input.expectedHeads).length > 10_000 ||
      !/^[0-9a-f]{64}$/u.test(input.archiveHash) ||
      (input.rollbackOfOperationId !== undefined && !UUID.test(input.rollbackOfOperationId)) ||
      (input.previousArchive !== undefined && input.previousArchive !== null && input.previousArchive.byteLength > MAX_ARCHIVE_BYTES) ||
      (input.requestArchive !== undefined && input.requestArchive !== null && input.requestArchive.byteLength > MAX_ARCHIVE_BYTES) ||
      (input.requestArchive !== undefined && input.requestArchive !== null && input.rollbackOfOperationId === undefined) ||
      (input.supersedeOperationId !== undefined && (!UUID.test(input.supersedeOperationId) || input.rollbackOfOperationId === undefined || input.requestArchive === undefined || input.requestArchive === null))
    )
      throw new TypeError("Registro operazione remota non valido.");
    if (Object.entries(input.expectedHeads).some(([id, hash]) => !UUID.test(id) || !/^[0-9a-f]{64}$/u.test(hash)))
      throw new TypeError("Le revisioni dell’operazione remota non sono valide.");
    if (input.rollbackOfOperationId) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const original = this.database.prepare("SELECT project_id, state FROM remote_operations WHERE connection_id = ? AND operation_id = ?").get(input.connectionId, input.rollbackOfOperationId) as { project_id: string; state: string } | undefined;
        if (!original || original.project_id !== input.projectId || !["complete", "complete-local-changes"].includes(original.state)) {
          throw new HistosPublishError("L’invio originale non è più disponibile per il ripristino.", "cms-remote-rollback-state-invalid", 409);
        }
        if (input.supersedeOperationId) {
          const previousAttempt = this.database.prepare("SELECT rollback_of_operation_id, state FROM remote_operations WHERE connection_id = ? AND operation_id = ?").get(input.connectionId, input.supersedeOperationId) as { rollback_of_operation_id: string | null; state: string } | undefined;
          if (previousAttempt?.rollback_of_operation_id !== input.rollbackOfOperationId || !["partial", "not-found"].includes(previousAttempt.state)) {
            throw new HistosPublishError("Il ripristino parziale è cambiato mentre veniva preparato un nuovo tentativo.", "cms-remote-rollback-state-invalid", 409);
          }
          this.database.prepare("UPDATE remote_operations SET state = 'superseded', updated_at = ?, message = ? WHERE connection_id = ? AND operation_id = ? AND state IN ('partial', 'not-found')")
            .run(new Date().toISOString(), `Sostituito dal tentativo verificato ${input.operationId}.`, input.connectionId, input.supersedeOperationId);
        }
        const active = this.database.prepare("SELECT operation_id FROM remote_operations WHERE connection_id = ? AND rollback_of_operation_id = ? AND state IN ('pending', 'applying', 'partial') LIMIT 1").get(input.connectionId, input.rollbackOfOperationId) as { operation_id: string } | undefined;
        if (active) {
          throw new HistosPublishError("Un ripristino è già in corso o in attesa di verifica. Controlla prima l’operazione in cronologia.", "cms-remote-rollback-in-progress", 409);
        }
        this.insertOperationRow(input);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") {
          throw new HistosPublishError("Un ripristino è già in corso o in attesa di verifica. Controlla prima l’operazione in cronologia.", "cms-remote-rollback-in-progress", 409);
        }
        throw error;
      }
    } else {
      this.insertOperationRow(input);
    }
    this.database
      .prepare(`DELETE FROM remote_operations WHERE connection_id = ? AND state IN ('superseded', 'not-found', 'complete', 'complete-local-changes', 'rolled-back', 'failed') AND operation_id NOT IN (
      SELECT operation_id FROM remote_operations WHERE connection_id = ? AND state IN ('superseded', 'not-found', 'complete', 'complete-local-changes', 'rolled-back', 'failed') ORDER BY updated_at DESC LIMIT 20
    ) AND operation_id NOT IN (
      SELECT rollback_of_operation_id FROM remote_operations WHERE connection_id = ? AND rollback_of_operation_id IS NOT NULL AND (state IN ('pending', 'applying', 'partial') OR (state = 'not-found' AND request_archive IS NOT NULL))
    )`)
      .run(input.connectionId, input.connectionId, input.connectionId);
    const operation = this.getOperation(input.connectionId, input.operationId);
    if (!operation) throw new Error("Operazione remota non disponibile dopo la registrazione.");
    return operation;
  }

  private insertOperationRow(input: {
    operationId: string;
    connectionId: string;
    projectId: string;
    action: CmsRemoteOperationAction;
    expectedHeads: Record<string, string>;
    archiveHash: string;
    previousArchive?: Uint8Array | null;
    requestArchive?: Uint8Array | null;
    rollbackOfOperationId?: string;
  }): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO remote_operations(operation_id, connection_id, project_id, action, state, expected_heads, archive_hash, previous_archive, request_archive, result_heads, rollback_of_operation_id, created_at, updated_at, message) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, ?, ?, NULL)",
      )
      .run(
        input.operationId,
        input.connectionId,
        input.projectId,
        input.action,
        JSON.stringify(input.expectedHeads),
        input.archiveHash,
        input.previousArchive === undefined || input.previousArchive === null ? null : Buffer.from(input.previousArchive),
        input.requestArchive === undefined || input.requestArchive === null ? null : Buffer.from(input.requestArchive),
        input.rollbackOfOperationId ?? null,
        now,
        now,
      );
  }

  updateOperation(
    connectionId: string,
    operationId: string,
    state: CmsRemoteOperationState,
    message: string | null = null,
    resultHeads?: Record<string, string>,
  ): void {
    const serializedHeads = resultHeads === undefined ? null : JSON.stringify(validateEntityHeads(resultHeads));
    this.database
      .prepare(
        "UPDATE remote_operations SET state = ?, updated_at = ?, message = ?, result_heads = COALESCE(?, result_heads) WHERE connection_id = ? AND operation_id = ?",
      )
      .run(state, new Date().toISOString(), message?.slice(0, 240) ?? null, serializedHeads, connectionId, operationId);
  }

  completeRollback(input: {
    connectionId: string;
    originalOperationId: string;
    rollbackOperationId: string;
    state: "complete" | "complete-local-changes";
    resultHeads: Record<string, string>;
    message: string;
  }): void {
    const serializedHeads = JSON.stringify(validateEntityHeads(input.resultHeads));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rollback = this.database.prepare("SELECT rollback_of_operation_id, project_id, state, result_heads FROM remote_operations WHERE connection_id = ? AND operation_id = ?").get(input.connectionId, input.rollbackOperationId) as { rollback_of_operation_id: string | null; project_id: string; state: string; result_heads: string | null } | undefined;
      const original = this.database.prepare("SELECT project_id, state FROM remote_operations WHERE connection_id = ? AND operation_id = ?").get(input.connectionId, input.originalOperationId) as { project_id: string; state: string } | undefined;
      if (rollback?.rollback_of_operation_id !== input.originalOperationId || rollback.project_id !== original?.project_id) {
        throw new HistosPublishError("Il journal del ripristino non corrisponde all’invio originale.", "cms-remote-rollback-journal-invalid", 409);
      }
      const savedHeads = rollback.result_heads === null ? null : validateEntityHeads(JSON.parse(rollback.result_heads) as unknown);
      const savedHeadEntries = savedHeads === null ? null : Object.entries(savedHeads).sort(([left], [right]) => left.localeCompare(right));
      const requestedHeadEntries = Object.entries(validateEntityHeads(input.resultHeads)).sort(([left], [right]) => left.localeCompare(right));
      if (
        ["complete", "complete-local-changes"].includes(rollback.state) &&
        original.state === "rolled-back" &&
        rollback.state === input.state &&
        JSON.stringify(savedHeadEntries) === JSON.stringify(requestedHeadEntries)
      ) {
        this.database.exec("COMMIT");
        return;
      }
      if (!["pending", "applying", "partial"].includes(rollback.state) || !["complete", "complete-local-changes"].includes(original.state)) {
        throw new HistosPublishError("L’invio originale o il ripristino sono cambiati prima della conferma.", "cms-remote-rollback-state-invalid", 409);
      }
      const now = new Date().toISOString();
      this.database.prepare("UPDATE remote_operations SET state = ?, updated_at = ?, message = ?, result_heads = ? WHERE connection_id = ? AND operation_id = ?")
        .run(input.state, now, input.message.slice(0, 240), serializedHeads, input.connectionId, input.rollbackOperationId);
      const parent = this.database.prepare("UPDATE remote_operations SET state = 'rolled-back', updated_at = ?, message = ? WHERE connection_id = ? AND operation_id = ? AND project_id = ? AND state IN ('complete', 'complete-local-changes')")
        .run(now, `Ripristinato dall’operazione ${input.rollbackOperationId}.`, input.connectionId, input.originalOperationId, rollback.project_id);
      if (parent.changes !== 1) throw new HistosPublishError("L’invio originale è cambiato mentre veniva registrato il ripristino.", "cms-remote-rollback-state-invalid", 409);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private hasRollbackClaim(connectionId: string, operationId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM remote_operations WHERE connection_id = ? AND rollback_of_operation_id = ? AND (state IN ('pending', 'applying', 'partial', 'complete', 'complete-local-changes') OR (state = 'not-found' AND request_archive IS NOT NULL)) LIMIT 1").get(connectionId, operationId));
  }

  getOperation(connectionId: string, operationId: string): CmsRemoteOperationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM remote_operations WHERE connection_id = ? AND operation_id = ?")
      .get(connectionId, operationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expectedHeads = JSON.parse(String(row.expected_heads)) as unknown;
    if (!expectedHeads || typeof expectedHeads !== "object" || Array.isArray(expectedHeads))
      throw new Error("Registro locale dell’operazione remota danneggiato.");
    const resultHeads = row.result_heads === null || row.result_heads === undefined ? null : JSON.parse(String(row.result_heads)) as unknown;
    if (null !== resultHeads && (!resultHeads || typeof resultHeads !== "object" || Array.isArray(resultHeads)))
      throw new Error("Esito locale dell’operazione remota danneggiato.");
    return {
      operationId: String(row.operation_id),
      connectionId: String(row.connection_id),
      projectId: String(row.project_id),
      action: row.action === "publish" ? "publish" : "push",
      state: String(row.state) as CmsRemoteOperationState,
      expectedEntityCount: Object.keys(expectedHeads).length,
      expectedHeads: expectedHeads as Record<string, string>,
      archiveHash: String(row.archive_hash),
      resultHeads: null === resultHeads ? null : validateEntityHeads(resultHeads),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      message: typeof row.message === "string" ? row.message : null,
      ...(typeof row.rollback_of_operation_id === "string" ? { rollbackOfOperationId: row.rollback_of_operation_id } : {}),
      rollbackRetryAvailable: typeof row.rollback_of_operation_id === "string" && ["partial", "not-found"].includes(String(row.state)) && row.request_archive instanceof Uint8Array,
      rollbackAvailable: ["complete", "complete-local-changes"].includes(String(row.state))
        && row.previous_archive instanceof Uint8Array
        && null !== resultHeads
        && !this.hasRollbackClaim(connectionId, operationId),
    };
  }

  getOperationPreviousArchive(connectionId: string, operationId: string): Buffer | null {
    const row = this.database
      .prepare("SELECT previous_archive FROM remote_operations WHERE connection_id = ? AND operation_id = ?")
      .get(connectionId, operationId) as Record<string, unknown> | undefined;
    if (!row || row.previous_archive === null || row.previous_archive === undefined) return null;
    if (!(row.previous_archive instanceof Uint8Array)) throw new Error("Backup locale dell’operazione remota danneggiato.");
    return Buffer.from(row.previous_archive);
  }

  getOperationRequestArchive(connectionId: string, operationId: string): Buffer | null {
    const row = this.database
      .prepare("SELECT request_archive FROM remote_operations WHERE connection_id = ? AND operation_id = ?")
      .get(connectionId, operationId) as Record<string, unknown> | undefined;
    if (!row || row.request_archive === null || row.request_archive === undefined) return null;
    if (!(row.request_archive instanceof Uint8Array)) throw new Error("Archivio della richiesta remota danneggiato.");
    return Buffer.from(row.request_archive);
  }

  listOperations(connectionId: string): CmsRemoteOperation[] {
    // Keep every unresolved operation visible even when a connection has a long
    // completed history. A simple LIMIT 20 could hide an older pending push,
    // leaving the user with no way to recover it from the UI.
    const active = this.database
      .prepare(
        "SELECT * FROM remote_operations WHERE connection_id = ? AND state NOT IN ('superseded', 'not-found', 'complete', 'complete-local-changes', 'rolled-back', 'failed') ORDER BY updated_at DESC",
      )
      .all(connectionId) as Array<Record<string, unknown>>;
    const completed = this.database
      .prepare(
        "SELECT * FROM remote_operations WHERE connection_id = ? AND state IN ('superseded', 'not-found', 'complete', 'complete-local-changes', 'rolled-back', 'failed') ORDER BY updated_at DESC LIMIT 20",
      )
      .all(connectionId) as Array<Record<string, unknown>>;
    return [...active, ...completed]
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .map((row) => {
        const heads = JSON.parse(String(row.expected_heads)) as Record<string, string>;
        const rollbackHeads = row.result_heads === null || row.result_heads === undefined ? null : JSON.parse(String(row.result_heads)) as unknown;
        return {
          operationId: String(row.operation_id),
          connectionId: String(row.connection_id),
          projectId: String(row.project_id),
          action: row.action === "publish" ? "publish" : "push",
          state: String(row.state) as CmsRemoteOperationState,
          expectedEntityCount: Object.keys(heads).length,
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          message: typeof row.message === "string" ? row.message : null,
          ...(typeof row.rollback_of_operation_id === "string" ? { rollbackOfOperationId: row.rollback_of_operation_id } : {}),
          rollbackRetryAvailable: typeof row.rollback_of_operation_id === "string" && ["partial", "not-found"].includes(String(row.state)) && row.request_archive instanceof Uint8Array,
          rollbackAvailable: ["complete", "complete-local-changes"].includes(String(row.state))
            && row.previous_archive instanceof Uint8Array
            && Boolean(rollbackHeads && typeof rollbackHeads === "object" && !Array.isArray(rollbackHeads))
            && !this.hasRollbackClaim(connectionId, String(row.operation_id)),
        };
      });
  }

  saveSyncPlan(plan: PendingSyncPlan): string {
    const now = Date.now();
    for (const [id, pending] of this.syncPlans) if (pending.expiresAt <= now) this.syncPlans.delete(id);
    while (this.syncPlans.size >= 32) this.syncPlans.delete(this.syncPlans.keys().next().value as string);
    const id = randomUUID();
    this.syncPlans.set(id, plan);
    return id;
  }

  takeSyncPlan(id: string): PendingSyncPlan | null {
    const plan = this.syncPlans.get(id);
    this.syncPlans.delete(id);
    return plan && plan.expiresAt > Date.now() ? plan : null;
  }

  getSyncPlan(id: string): PendingSyncPlan | null {
    const plan = this.syncPlans.get(id);
    if (!plan || plan.expiresAt <= Date.now()) {
      this.syncPlans.delete(id);
      return null;
    }
    return plan;
  }

  close(): void {
    this.database.close();
  }
}

export function connectionFromRow(row: Record<string, unknown>): CmsRemoteConnection {
  return {
    id: String(row.id),
    url: String(row.url),
    siteId: String(row.site_id),
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    projectName: String(row.project_name),
    profile: String(row.profile),
    read: row.can_read === 1,
    write: row.can_write === 1,
    publish: row.can_publish === 1,
    connectedAt: String(row.connected_at),
    lastCheckedAt: String(row.checked_at),
    lastSyncedAt: typeof row.synced_at === "string" ? row.synced_at : null,
    ...(typeof row.site_histeon === "string" ? { siteHisteon: row.site_histeon === "" ? null : row.site_histeon } : {}),
  };
}
