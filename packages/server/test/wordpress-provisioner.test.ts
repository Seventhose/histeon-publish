import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import {
  WordPressProvisionCatalog,
  buildWordPressProvisionBootstrap,
  parseWordPressProvisionBootstrapResponse,
  wordpressProvisionConnectionId,
  type WordPressProvisionSnapshot,
} from "../src/wordpress-provisioner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function snapshot(overrides: Partial<WordPressProvisionSnapshot> = {}): WordPressProvisionSnapshot {
  const id = randomUUID();
  const file = Buffer.from("verified artifact");
  const fileHash = createHash("sha256").update(file).digest("hex");
  const now = new Date();
  return {
    id,
    siteId: randomUUID(),
    databaseConnectionId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    siteTitle: "Histeon test",
    adminUsername: "site-admin",
    adminEmail: "admin@example.test",
    locale: "en_US",
    target: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/demo", publicUrl: "https://demo.example.test", username: "ftp-test" },
    database: { id: randomUUID(), name: "Staging", host: "db.example.test", port: 3306, databaseName: "demo", tablePrefix: "wp_demo_", engine: "mariadb", serverVersion: "10.11.10-MariaDB" },
    wordpress: { version: "7.1.3", phpMinimum: "8.3", mysqlMinimum: "8.0", archiveSha256: "a".repeat(64), files: [{ path: "index.php", bytes: file.byteLength, sha256: fileHash }] },
    histos: { version: "0.3.1", wordpressMinimum: "6.9", phpMinimum: "8.3", archiveSha256: "b".repeat(64), files: [{ path: "xb.php", bytes: file.byteLength, sha256: fileHash }] },
    databaseDropInSha256: "c".repeat(64),
    ...overrides,
  };
}

describe("WordPress provisioning journal and bootstrap", () => {
  it("keeps the snapshot immutable and claims install/recovery once at a time", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-wp-provision-journal-"));
    roots.push(directory);
    const catalog = new WordPressProvisionCatalog(directory);
    try {
      const plan = catalog.create(snapshot());
      expect(plan.state).toBe("planned");
      expect(catalog.claim(plan.snapshot.id)).toBe(true);
      expect(catalog.claim(plan.snapshot.id)).toBe(false);
      expect(catalog.claimRecovery(plan.snapshot.id)).toBe(true);
      expect(catalog.get(plan.snapshot.id)?.state).toBe("recovering");
      expect(catalog.claimRecovery(plan.snapshot.id)).toBe(false);
      const afterLease = new Date(Date.now() + 5 * 60_000);
      expect(catalog.claimRecovery(plan.snapshot.id, afterLease)).toBe(true);
      expect(catalog.get(plan.snapshot.id)?.state).toBe("recovering");
    } finally { catalog.close(); }
  });

  it("expires only plans that have not started", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-wp-provision-expiry-"));
    roots.push(directory);
    const catalog = new WordPressProvisionCatalog(directory);
    try {
      const expired = catalog.create(snapshot({ expiresAt: "2026-10-23T00:00:00.000Z" }));
      const active = catalog.create(snapshot({ expiresAt: "2026-10-23T00:00:00.000Z" }));
      expect(catalog.claim(active.snapshot.id)).toBe(true);
      expect(catalog.expirePending(new Date("2026-10-24T00:00:00.000Z"))).toEqual([expired.snapshot.id]);
      expect(catalog.get(expired.snapshot.id)?.state).toBe("expired");
      expect(catalog.get(active.snapshot.id)?.state).toBe("uploading");
    } finally { catalog.close(); }
  });

  it("detects a snapshot altered outside the provision catalog", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-wp-provision-integrity-"));
    roots.push(directory);
    const catalog = new WordPressProvisionCatalog(directory);
    const plan = catalog.create(snapshot());
    catalog.close();
    const database = new DatabaseSync(path.join(directory, "histos-wordpress-provision.sqlite"));
    database.prepare("UPDATE wordpress_provision_plans SET snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...plan.snapshot, siteTitle: "altered" }), plan.snapshot.id);
    database.close();
    const reopened = new WordPressProvisionCatalog(directory);
    try {
      expect(() => reopened.get(plan.snapshot.id)).toThrowError(expect.objectContaining({ code: "wordpress-provision-plan-corrupt" }));
    } finally { reopened.close(); }
  });

  it("builds one-time install and recovery scripts without embedding database or admin credentials", () => {
    const plan = snapshot();
    const nonce = "f".repeat(64);
    const install = buildWordPressProvisionBootstrap(plan.id, nonce, Math.floor(Date.now() / 1000) + 120, "install").toString("utf8");
    const recovery = buildWordPressProvisionBootstrap(plan.id, nonce, Math.floor(Date.now() / 1000) + 120, "recover").toString("utf8");
    expect(install).toContain("define('WP_INSTALLING', true)");
    expect(install).toContain("wp_install($siteTitle, $adminUsername, $adminEmail, false, '', $adminPassword, 'en_US')");
    expect(install).toContain("information_schema.tables");
    expect(install).toContain("fopen($configTemp, 'x')");
    expect(install).toContain("wordpress-config-permissions-failed");
    expect(install).toContain("\\$table_prefix = ");
    expect(install).toContain("stream_get_contents($input, 128 * 1024 + 1)");
    expect(install).not.toContain("file_get_contents('php://input')");
    expect(recovery).toContain("installation-not-owned-by-plan");
    expect(recovery).toContain("XB\\Cms\\Link::create(");
    for (const source of [install, recovery]) {
      expect(source).not.toContain(nonce);
      expect(source).not.toContain("db_password_private");
      expect(source).not.toContain("admin_password_private");
      expect(source).toContain("HISTOS_NONCE_HASH");
    }
  });

  it("parses only the expected HTTPS bootstrap response and derives stable connection IDs", () => {
    const planId = randomUUID();
    const body = Buffer.from(JSON.stringify({ probe: "histos-wordpress-provision-v1", code: "installed", planId, wordpressVersion: "7.1.3", pairingCode: "histos-cms-1:abc", siteUrl: "https://demo.example.test" }));
    expect(parseWordPressProvisionBootstrapResponse(200, "application/json; charset=utf-8", body, planId, "install")).toMatchObject({ planId, wordpressVersion: "7.1.3", mode: "install" });
    expect(() => parseWordPressProvisionBootstrapResponse(200, "application/json", body, randomUUID(), "install")).toThrow(HistosPublishError);
    const first = wordpressProvisionConnectionId(planId);
    expect(first).toBe(wordpressProvisionConnectionId(planId));
    expect(first).not.toBe(wordpressProvisionConnectionId(randomUUID()));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
