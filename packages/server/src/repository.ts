import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { BuildResult, DeployPhase, SiteConfig } from "@histos-publish/core";

export interface StoredSite {
  id: string;
  name: string;
  config: SiteConfig;
  createdAt: string;
  updatedAt: string;
  sourceUpdatedAt: string;
}

export interface StoredBuild {
  id: string;
  siteId: string;
  status: "ready" | "blocked" | "failed" | "cancelled";
  createdAt: string;
  completedAt?: string;
  bundlePath?: string;
  result?: BuildResult;
  error?: string;
}

export interface StoredDeploy {
  id: string;
  siteId: string;
  buildId: string;
  status: "deployed" | "failed" | "cancelled";
  createdAt: string;
  versionId?: string;
  deploymentId?: string;
  workersDevUrl?: string;
  uploaded?: number;
  files?: number;
  error?: string;
  /** Where a failed Cloudflare publish stopped (doc 23, voce 228): session, upload, version or deploy. */
  failedPhase?: DeployPhase;
  healthCheck?: { status: "ok" | "warning" | "unavailable"; url?: string; statusCode?: number; contentType?: string; contentDisposition?: string; message: string };
}

interface SiteRow { id: string; name: string; config_json: string; created_at: string; updated_at: string; source_updated_at: string | null }
interface BuildRow { id: string; site_id: string; status: StoredBuild["status"]; created_at: string; completed_at: string | null; bundle_path: string | null; result_json: string | null; error: string | null }
interface DeployRow { id: string; site_id: string; build_id: string; status: StoredDeploy["status"]; created_at: string; version_id: string | null; deployment_id: string | null; workers_dev_url: string | null; uploaded: number | null; files: number | null; error: string | null; health_json: string | null; failed_phase: string | null }

export class AppRepository {
  readonly dataDirectory: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.dataDirectory = path.dirname(databasePath);
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS builds (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        bundle_path TEXT,
        result_json TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS deploys (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        build_id TEXT NOT NULL REFERENCES builds(id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        version_id TEXT,
        deployment_id TEXT,
        workers_dev_url TEXT,
        uploaded INTEGER,
        files INTEGER,
        error TEXT,
        health_json TEXT,
        failed_phase TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS builds_site_created ON builds(site_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS deploys_site_created ON deploys(site_id, created_at DESC);
    `);
    const deployColumns = this.database.prepare("PRAGMA table_info(deploys)").all() as unknown as Array<{ name: string }>;
    if (!deployColumns.some((column) => column.name === "workers_dev_url")) this.database.exec("ALTER TABLE deploys ADD COLUMN workers_dev_url TEXT");
    if (!deployColumns.some((column) => column.name === "health_json")) this.database.exec("ALTER TABLE deploys ADD COLUMN health_json TEXT");
    if (!deployColumns.some((column) => column.name === "failed_phase")) this.database.exec("ALTER TABLE deploys ADD COLUMN failed_phase TEXT");
    const siteColumns = this.database.prepare("PRAGMA table_info(sites)").all() as unknown as Array<{ name: string }>;
    if (!siteColumns.some((column) => column.name === "source_updated_at")) this.database.exec("ALTER TABLE sites ADD COLUMN source_updated_at TEXT");
    // The Cestino: a site moved there keeps its row, secrets and files until it is deleted for good.
    if (!siteColumns.some((column) => column.name === "deleted_at")) this.database.exec("ALTER TABLE sites ADD COLUMN deleted_at TEXT");
    this.database.exec("UPDATE sites SET source_updated_at = created_at WHERE source_updated_at IS NULL");
  }

  close(): void { this.database.close(); }

  createSite(site: { id: string; name: string; config: SiteConfig }): StoredSite {
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO sites(id, name, config_json, created_at, updated_at, source_updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(site.id, site.name, JSON.stringify(site.config), now, now, now);
    return { ...site, createdAt: now, updatedAt: now, sourceUpdatedAt: now };
  }

  updateSite(id: string, update: { name?: string; config?: SiteConfig }): StoredSite | null {
    const current = this.getSite(id);
    if (!current) return null;
    const name = update.name ?? current.name;
    const config = update.config ?? current.config;
    const updatedAt = new Date().toISOString();
    this.database.prepare("UPDATE sites SET name = ?, config_json = ?, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(config), updatedAt, id);
    return { ...current, name, config, updatedAt };
  }

  markSourceUpdated(id: string): StoredSite | null {
    const current = this.getSite(id);
    if (!current) return null;
    const sourceUpdatedAt = new Date().toISOString();
    this.database.prepare("UPDATE sites SET source_updated_at = ? WHERE id = ?").run(sourceUpdatedAt, id);
    return { ...current, sourceUpdatedAt };
  }

  /** Removes a site; its builds and deploys go with it (ON DELETE CASCADE). False when there is none. */
  deleteSite(id: string): boolean {
    return Number(this.database.prepare("DELETE FROM sites WHERE id = ?").run(id).changes) > 0;
  }

  /** Moves a site to the Cestino: every listing and route stops seeing it; restoreSite brings it back as it was. */
  trashSite(id: string, at = new Date().toISOString()): boolean {
    return Number(this.database.prepare("UPDATE sites SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, id).changes) > 0;
  }

  restoreSite(id: string): boolean {
    return Number(this.database.prepare("UPDATE sites SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(id).changes) > 0;
  }

  /** The sites in the Cestino, most recently moved first, with when. */
  listTrashedSites(): Array<StoredSite & { deletedAt: string }> {
    const rows = this.database.prepare("SELECT * FROM sites WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as unknown as Array<SiteRow & { deleted_at: string }>;
    return rows.map((row) => ({ id: row.id, name: row.name, config: JSON.parse(row.config_json) as SiteConfig, createdAt: row.created_at, updatedAt: row.updated_at, sourceUpdatedAt: row.source_updated_at ?? row.created_at, deletedAt: row.deleted_at }));
  }

  getSite(id: string): StoredSite | null {
    const row = this.database.prepare("SELECT * FROM sites WHERE id = ? AND deleted_at IS NULL").get(id) as unknown as SiteRow | undefined;
    return row ? { id: row.id, name: row.name, config: JSON.parse(row.config_json) as SiteConfig, createdAt: row.created_at, updatedAt: row.updated_at, sourceUpdatedAt: row.source_updated_at ?? row.created_at } : null;
  }

  listSites(): StoredSite[] {
    const rows = this.database.prepare("SELECT * FROM sites WHERE deleted_at IS NULL ORDER BY updated_at DESC").all() as unknown as SiteRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, config: JSON.parse(row.config_json) as SiteConfig, createdAt: row.created_at, updatedAt: row.updated_at, sourceUpdatedAt: row.source_updated_at ?? row.created_at }));
  }

  addBuild(build: StoredBuild): void {
    this.database.prepare("INSERT INTO builds(id, site_id, status, created_at, completed_at, bundle_path, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(build.id, build.siteId, build.status, build.createdAt, build.completedAt ?? null, build.bundlePath ?? null, build.result === undefined ? null : JSON.stringify(build.result), build.error ?? null);
  }

  getBuild(id: string): StoredBuild | null {
    const row = this.database.prepare("SELECT * FROM builds WHERE id = ?").get(id) as unknown as BuildRow | undefined;
    return row ? buildFromRow(row) : null;
  }

  listBuilds(siteId: string, limit = 50): StoredBuild[] {
    const rows = this.database.prepare("SELECT * FROM builds WHERE site_id = ? ORDER BY created_at DESC LIMIT ?").all(siteId, limit) as unknown as BuildRow[];
    return rows.map(buildFromRow);
  }

  /** The newest build that finished (ready or blocked): a cancelled or failed build never replaces it (E13). */
  latestFinishedBuild(siteId: string): StoredBuild | null {
    const row = this.database.prepare("SELECT * FROM builds WHERE site_id = ? AND status IN ('ready', 'blocked') ORDER BY created_at DESC LIMIT 1").get(siteId) as unknown as BuildRow | undefined;
    return row ? buildFromRow(row) : null;
  }

  addDeploy(deploy: StoredDeploy): void {
    this.database.prepare("INSERT INTO deploys(id, site_id, build_id, status, created_at, version_id, deployment_id, workers_dev_url, uploaded, files, error, health_json, failed_phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(deploy.id, deploy.siteId, deploy.buildId, deploy.status, deploy.createdAt, deploy.versionId ?? null, deploy.deploymentId ?? null, deploy.workersDevUrl ?? null, deploy.uploaded ?? null, deploy.files ?? null, deploy.error ?? null, deploy.healthCheck === undefined ? null : JSON.stringify(deploy.healthCheck), deploy.failedPhase ?? null);
  }

  /** The build a deploy of this site put online as this Cloudflare version: what a rollback to it restores. */
  buildForVersion(siteId: string, versionId: string): StoredBuild | null {
    const row = this.database.prepare("SELECT builds.* FROM deploys JOIN builds ON builds.id = deploys.build_id WHERE deploys.site_id = ? AND deploys.version_id = ? ORDER BY deploys.created_at DESC LIMIT 1").get(siteId, versionId) as unknown as BuildRow | undefined;
    return row ? buildFromRow(row) : null;
  }

  listDeploys(siteId: string, limit = 50): StoredDeploy[] {
    const rows = this.database.prepare("SELECT * FROM deploys WHERE site_id = ? ORDER BY created_at DESC LIMIT ?").all(siteId, limit) as unknown as DeployRow[];
    return rows.map(deployFromRow);
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as unknown as { value_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value_json) as T; } catch { return undefined; }
  }

  setSetting(key: string, value: unknown): void {
    this.database.prepare("INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(key, JSON.stringify(value));
  }
}

function buildFromRow(row: BuildRow): StoredBuild {
  return {
    id: row.id,
    siteId: row.site_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.bundle_path === null ? {} : { bundlePath: row.bundle_path }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as BuildResult }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function deployFromRow(row: DeployRow): StoredDeploy {
  return {
    id: row.id,
    siteId: row.site_id,
    buildId: row.build_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.version_id === null ? {} : { versionId: row.version_id }),
    ...(row.deployment_id === null ? {} : { deploymentId: row.deployment_id }),
    ...(row.workers_dev_url === null ? {} : { workersDevUrl: row.workers_dev_url }),
    ...(row.uploaded === null ? {} : { uploaded: row.uploaded }),
    ...(row.files === null ? {} : { files: row.files }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.health_json === null ? {} : { healthCheck: JSON.parse(row.health_json) as NonNullable<StoredDeploy["healthCheck"]> }),
    ...(isDeployPhase(row.failed_phase) ? { failedPhase: row.failed_phase } : {}),
  };
}

const DEPLOY_PHASES: readonly string[] = ["preflight", "session", "upload", "version", "deploy"];
function isDeployPhase(value: string | null): value is DeployPhase {
  return value !== null && DEPLOY_PHASES.includes(value);
}
