import { describe, expect, it } from "vitest";
import { resolveCmsDestination } from "../src/cms-destination-resolver.js";
import type { CmsRemoteConnection } from "../src/cms-remote.js";
import type { StoredDatabaseConnection } from "../src/database-probe.js";
import type { StoredSite } from "../src/repository.js";

const ids = {
  cloudflare: "11111111-1111-4111-8111-111111111111",
  hosting: "22222222-2222-4222-8222-222222222222",
  wordpress: "33333333-3333-4333-8333-333333333333",
  newWordPress: "44444444-4444-4444-8444-444444444444",
  database: "55555555-5555-4555-8555-555555555555",
};

function site(id: string, name: string, config: StoredSite["config"]): StoredSite {
  return { id, name, config, createdAt: "2026-10-25T10:00:00.000Z", updatedAt: "2026-10-25T10:00:00.000Z", sourceUpdatedAt: "2026-10-25T10:00:00.000Z" };
}

const baseConfig: StoredSite["config"] = { schemaVersion: 1, name: "Fixture", source: { kind: "html", path: "/tmp/index.html" } };
const remote: CmsRemoteConnection = {
  id: ids.wordpress,
  url: "https://wp.example.test",
  siteId: "wp-remote-site-id",
  projectId: "local-project-id",
  projectName: "WordPress fixture",
  profile: "histos-static-project-v3",
  read: true,
  write: true,
  publish: true,
  connectedAt: "2026-10-25T10:00:00.000Z",
  lastCheckedAt: "2026-10-25T10:01:00.000Z",
  lastSyncedAt: null,
};
const database: StoredDatabaseConnection = {
  id: ids.database,
  name: "Verified MariaDB",
  host: "db.example.test",
  port: 3306,
  databaseName: "wp_demo",
  tablePrefix: "wp_",
  engine: "mariadb",
  serverVersion: "11.4.9-MariaDB",
  serverComment: "MariaDB Server",
  characterSet: "utf8mb4",
  collation: "utf8mb4_unicode_ci",
  tableCount: 0,
  prefixTableCount: 0,
  privilegesVerified: true,
  grantedPrivileges: ["CREATE", "INSERT", "SELECT"],
  missingPrivileges: [],
  createdAt: "2026-10-25T10:00:00.000Z",
  checkedAt: "2026-10-25T10:00:00.000Z",
  sshTunnel: { host: "ssh.example.test", port: 22, username: "tunnel", authMethod: "privateKey", hostKeyFingerprint: `SHA256:${"a".repeat(43)}` },
};

function lookups(sites: StoredSite[] = []): Parameters<typeof resolveCmsDestination>[1] {
  return {
    getSite: (siteId) => sites.find((candidate) => candidate.id === siteId) ?? null,
    getRemoteConnection: (connectionId) => connectionId === remote.id ? remote : null,
    getDatabaseConnection: (connectionId) => connectionId === database.id ? database : null,
    defaultAccountId: "9f8e6accf10cbbfa9bc0a4f15b0e441a",
  };
}

describe("resolver delle destinazioni CMS", () => {
  it("risolve Cloudflare e hosting statico dal profilo salvato senza esporre segreti", () => {
    const cloudflareSite = site(ids.cloudflare, "Worker CMS", { ...baseConfig, cloudflare: { script: "worker-cms" } });
    const hostingSite = site(ids.hosting, "Statico SFTP", {
      ...baseConfig,
      deployTarget: "ftp",
      hosting: { protocol: "sftp", host: "ssh.example.test", port: 22, remoteDirectory: "/var/www/site", publicUrl: "https://static.example.test", username: "publisher" },
    });
    const lookup = lookups([cloudflareSite, hostingSite]);

    expect(resolveCmsDestination({ destinationId: ids.cloudflare }, lookup)).toMatchObject({
      kind: "static-cloudflare", transport: "cloudflare-api", destinationId: ids.cloudflare, label: "Worker CMS",
    });
    const resolvedHosting = resolveCmsDestination({ destinationId: ids.hosting }, lookup);
    expect(resolvedHosting).toMatchObject({ kind: "static-hosting", transport: "sftp", documentRoot: "/var/www/site", publicUrl: "https://static.example.test" });
    expect(JSON.stringify([resolvedHosting])).not.toContain("password");
  });

  it("risolve WordPress Histeon usando l’identità e il riferimento segreto, rispettando lo scope", () => {
    const resolved = resolveCmsDestination({ destinationId: `wordpress:${remote.id}`, projectId: "local-project-id" }, lookups());
    expect(resolved).toMatchObject({
      kind: "wordpress-existing", transport: "histos-remote", publicUrl: remote.url,
      wordpress: { remoteSiteId: remote.siteId, pairingSecretRef: `cms-remote-${remote.id}`, histosContract: "histos-static-project-v3", publishPermission: true },
    });
    expect(() => resolveCmsDestination({ destinationId: `wordpress:${remote.id}`, projectId: "another-project" }, lookups())).toThrow(/altro progetto/u);
  });

  it("risolve il nuovo WordPress con HTTPS, trasporto file e profilo DB senza includere credenziali", () => {
    const target = site(ids.newWordPress, "Nuovo WP", {
      ...baseConfig,
      deployTarget: "ftp",
      hosting: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html", publicUrl: "https://wp.example.test", username: "publisher" },
    });
    const lookup = lookups([target]);
    const input = { destinationId: `wordpress-new:${target.id}`, databaseConnectionId: database.id };
    const resolved = resolveCmsDestination(input, lookup);
    expect(resolved).toMatchObject({
      kind: "wordpress-new", transport: "ftps", publicUrl: "https://wp.example.test/", documentRoot: "/public_html",
      database: { engine: "mariadb", databaseName: "wp_demo", tlsMode: "verify-full", secretRef: `database-${database.id}`, tunnelRef: `database-${database.id}` },
    });
    expect(JSON.stringify(resolved)).not.toContain("password");
    expect(() => resolveCmsDestination({ destinationId: `wordpress-new:${target.id}` }, lookup)).toThrow(/Scegli una connessione/u);
  });

  it("rifiuta identità o configurazioni incoerenti invece di indovinare il provider", () => {
    const lookup = lookups([site(ids.cloudflare, "Worker incompleto", baseConfig)]);
    expect(() => resolveCmsDestination({ destinationId: "not-a-destination" }, lookup)).toThrow(/Identificativo del sito/u);
    expect(() => resolveCmsDestination({ destinationId: ids.cloudflare }, lookup)).toThrow(/Account ID Cloudflare/u);
    expect(() => resolveCmsDestination({ destinationId: `wordpress:${ids.cloudflare}` }, lookup)).toThrow(/Collegamento WordPress non trovato/u);
  });
});
