import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";

export type CmsDeploymentStatus = "running" | "deployed" | "failed" | "cancelled" | "interrupted";

export interface CmsBuildRecord {
  projectId: string;
  buildId: string;
  bundlePath: string;
  projectRevision: string;
  files: number;
  pages: number;
  assets: number;
  totalBytes: number;
  findings: Array<{ code: string; severity: string; file: string; message: string; line?: number }>;
  createdAt: string;
}

export interface CmsDeploymentRecord {
  id: string;
  projectId: string;
  buildId: string;
  targetSiteId: string;
  status: CmsDeploymentStatus;
  createdAt: string;
  completedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export class CmsBuildRegistry {
  private readonly database: DatabaseSync;

  constructor(dataDirectory: string) {
    this.database = new DatabaseSync(path.join(dataDirectory, "histos-cms-builds.sqlite"));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS cms_builds (
        build_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        bundle_path TEXT NOT NULL,
        project_revision TEXT NOT NULL DEFAULT '',
        files INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0,
        assets INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        findings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cms_deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        build_id TEXT NOT NULL REFERENCES cms_builds(build_id),
        target_site_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT,
        error TEXT,
        owner_pid INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cms_deployments_build_created ON cms_deployments(build_id, created_at DESC);
    `);
    const buildColumns = this.database.prepare("PRAGMA table_info(cms_builds)").all() as Array<{ name: string }>;
    if (!buildColumns.some((column) => column.name === "project_revision")) this.database.exec("ALTER TABLE cms_builds ADD COLUMN project_revision TEXT NOT NULL DEFAULT ''");
    if (!buildColumns.some((column) => column.name === "files")) this.database.exec("ALTER TABLE cms_builds ADD COLUMN files INTEGER NOT NULL DEFAULT 0");
    if (!buildColumns.some((column) => column.name === "pages")) this.database.exec("ALTER TABLE cms_builds ADD COLUMN pages INTEGER NOT NULL DEFAULT 0");
    if (!buildColumns.some((column) => column.name === "assets")) this.database.exec("ALTER TABLE cms_builds ADD COLUMN assets INTEGER NOT NULL DEFAULT 0");
    if (!buildColumns.some((column) => column.name === "total_bytes")) this.database.exec("ALTER TABLE cms_builds ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0");
    const columns = this.database.prepare("PRAGMA table_info(cms_deployments)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "owner_pid")) this.database.exec("ALTER TABLE cms_deployments ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT 0");
    const running = this.database.prepare("SELECT id, owner_pid FROM cms_deployments WHERE status = 'running'").all() as Array<{ id: string; owner_pid: number }>;
    const markInterrupted = this.database.prepare("UPDATE cms_deployments SET status = 'interrupted', completed_at = ?, error = ? WHERE id = ? AND status = 'running'");
    for (const row of running) {
      if (isProcessAlive(row.owner_pid)) continue;
      markInterrupted.run(new Date().toISOString(), "Il server si è chiuso durante il deploy; il risultato sul provider è incerto.", row.id);
    }
  }

  close(): void { this.database.close(); }

  registerBuild(input: Omit<CmsBuildRecord, "createdAt">): void {
    this.database.prepare("INSERT INTO cms_builds(build_id, project_id, bundle_path, project_revision, files, pages, assets, total_bytes, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.buildId, input.projectId, input.bundlePath, input.projectRevision, input.files, input.pages, input.assets, input.totalBytes, JSON.stringify(input.findings), new Date().toISOString());
  }

  getBuild(buildId: string): CmsBuildRecord | null {
    const row = this.database.prepare("SELECT * FROM cms_builds WHERE build_id = ?").get(buildId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      buildId: String(row.build_id), projectId: String(row.project_id), bundlePath: String(row.bundle_path),
      projectRevision: String(row.project_revision ?? ""),
      files: Number(row.files ?? 0), pages: Number(row.pages ?? 0), assets: Number(row.assets ?? 0), totalBytes: Number(row.total_bytes ?? 0),
      findings: JSON.parse(String(row.findings_json)) as CmsBuildRecord["findings"], createdAt: String(row.created_at),
    };
  }

  /** Whether a publication of the project is still running: a deletion waits for it. */
  hasRunningDeployment(projectId: string): boolean {
    return this.database.prepare("SELECT 1 FROM cms_deployments WHERE project_id = ? AND status = 'running' LIMIT 1").get(projectId) !== undefined;
  }

  /** A deleted project's builds and publications leave the registry (its files are the caller's to remove). */
  forgetProject(projectId: string): void {
    this.database.prepare("DELETE FROM cms_deployments WHERE project_id = ?").run(projectId);
    this.database.prepare("DELETE FROM cms_builds WHERE project_id = ?").run(projectId);
  }

  listBuilds(projectId: string, limit = 20): CmsBuildRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.database.prepare("SELECT * FROM cms_builds WHERE project_id = ? ORDER BY created_at DESC, build_id DESC LIMIT ?")
      .all(projectId, safeLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      buildId: String(row.build_id), projectId: String(row.project_id), bundlePath: String(row.bundle_path),
      projectRevision: String(row.project_revision ?? ""),
      files: Number(row.files ?? 0), pages: Number(row.pages ?? 0), assets: Number(row.assets ?? 0), totalBytes: Number(row.total_bytes ?? 0),
      findings: JSON.parse(String(row.findings_json)) as CmsBuildRecord["findings"], createdAt: String(row.created_at),
    }));
  }

  reserveDeployment(input: { id: string; projectId: string; buildId: string; targetSiteId: string }): CmsDeploymentRecord {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const build = this.getBuild(input.buildId);
      if (!build) throw new HistosPublishError("Versione CMS non trovata o scaduta. Crea una nuova versione prima di pubblicare.", "cms-build-missing", 404);
      if (build.projectId !== input.projectId) throw new HistosPublishError("La versione del sito appartiene a un altro progetto.", "cms-build-project-mismatch", 409);
      const active = this.database.prepare("SELECT id FROM cms_deployments WHERE target_site_id = ? AND status = 'running' LIMIT 1").get(input.targetSiteId);
      if (active) throw new HistosPublishError("È già in corso una pubblicazione verso questa destinazione.", "cms-deploy-already-running", 409);
      const createdAt = new Date().toISOString();
      this.database.prepare("INSERT INTO cms_deployments(id, project_id, build_id, target_site_id, status, created_at, owner_pid) VALUES (?, ?, ?, ?, 'running', ?, ?)")
        .run(input.id, input.projectId, input.buildId, input.targetSiteId, createdAt, process.pid);
      this.database.exec("COMMIT");
      return { ...input, status: "running", createdAt, completedAt: null, result: null, error: null };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishDeployment(id: string, status: Exclude<CmsDeploymentStatus, "running" | "interrupted">, detail: { result?: Record<string, unknown>; error?: string }): void {
    this.database.prepare("UPDATE cms_deployments SET status = ?, completed_at = ?, result_json = ?, error = ? WHERE id = ? AND status = 'running'")
      .run(status, new Date().toISOString(), detail.result === undefined ? null : JSON.stringify(detail.result), detail.error ?? null, id);
  }

  listDeployments(projectId: string, buildId: string): CmsDeploymentRecord[] {
    const rows = this.database.prepare("SELECT * FROM cms_deployments WHERE project_id = ? AND build_id = ? ORDER BY created_at DESC")
      .all(projectId, buildId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), projectId: String(row.project_id), buildId: String(row.build_id), targetSiteId: String(row.target_site_id),
      status: String(row.status) as CmsDeploymentStatus, createdAt: String(row.created_at),
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
      result: typeof row.result_json === "string" ? JSON.parse(row.result_json) as Record<string, unknown> : null,
      error: typeof row.error === "string" ? row.error : null,
    }));
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
