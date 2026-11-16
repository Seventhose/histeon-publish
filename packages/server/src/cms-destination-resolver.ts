import { HistosPublishError, type Destination, type DestinationCapabilities } from "@histos-publish/core";
import type { CmsRemoteConnection } from "./cms-remote.js";
import type { StoredDatabaseConnection } from "./database-probe.js";
import type { StoredSite } from "./repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID = /^[0-9a-f]{32}$/iu;
const WORKER_NAME = /^[a-z0-9-]{1,63}$/u;

export interface CmsDestinationResolverInput {
  destinationId: string;
  projectId?: string;
  databaseConnectionId?: string;
}

export interface CmsDestinationResolverLookups {
  getSite: (siteId: string) => StoredSite | null;
  getRemoteConnection: (connectionId: string) => CmsRemoteConnection | null;
  getDatabaseConnection: (connectionId: string) => StoredDatabaseConnection | null;
  defaultAccountId?: string;
}

const noCapabilities = (): DestinationCapabilities => ({
  atomicSwitch: false,
  rollback: false,
  deleteManaged: false,
  remoteVerify: false,
  runtimeProvision: false,
  databaseProbe: false,
});

function invalid(message = "Destinazione CMS non valida."): never {
  throw new HistosPublishError(message, "cms-destination-invalid", 400);
}

function siteById(siteId: string, lookups: CmsDestinationResolverLookups): StoredSite {
  if (!UUID.test(siteId)) invalid("Identificativo del sito di destinazione non valido.");
  const site = lookups.getSite(siteId);
  if (!site) throw new HistosPublishError("Sito di destinazione non trovato.", "site-missing", 404);
  return site;
}

export function resolveCmsDestination(input: CmsDestinationResolverInput, lookups: CmsDestinationResolverLookups): Destination {
  const { destinationId } = input;
  if (typeof destinationId !== "string" || !destinationId) invalid();

  if (destinationId.startsWith("wordpress:")) {
    const connectionId = destinationId.slice("wordpress:".length);
    if (!UUID.test(connectionId)) invalid("Identificativo del collegamento WordPress non valido.");
    const connection = lookups.getRemoteConnection(connectionId);
    if (!connection) throw new HistosPublishError("Collegamento WordPress non trovato.", "cms-remote-connection-missing", 404);
    if (input.projectId && connection.projectId && connection.projectId !== input.projectId) {
      throw new HistosPublishError("Il collegamento WordPress appartiene a un altro progetto.", "cms-remote-project-mismatch", 409);
    }
    return {
      schemaVersion: 1,
      destinationId,
      label: connection.projectName || new URL(connection.url).hostname,
      ...(connection.url ? { publicUrl: connection.url } : {}),
      kind: "wordpress-existing",
      transport: "histos-remote",
      detectedCapabilities: { ...noCapabilities(), remoteVerify: Boolean(connection.lastCheckedAt) },
      checkedAt: connection.lastCheckedAt,
      wordpress: {
        remoteSiteId: connection.siteId,
        pairingSecretRef: `cms-remote-${connection.id}`,
        histosContract: connection.profile,
        publishPermission: connection.write && connection.publish,
      },
    };
  }

  if (destinationId.startsWith("wordpress-new:")) {
    const siteId = destinationId.slice("wordpress-new:".length);
    const site = siteById(siteId, lookups);
    if (site.config.deployTarget !== "ftp" || !site.config.hosting) {
      throw new HistosPublishError("Il sito non ha un profilo hosting per un nuovo WordPress.", "hosting-config-missing", 409);
    }
    const hosting = site.config.hosting;
    if (!hosting.host || !hosting.remoteDirectory || !hosting.publicUrl) {
      throw new HistosPublishError("Completa server, cartella e URL HTTPS del profilo hosting.", "hosting-config-incomplete", 409);
    }
    let publicUrl: URL;
    try { publicUrl = new URL(hosting.publicUrl); }
    catch { throw new HistosPublishError("L’URL pubblico del nuovo WordPress non è valido.", "hosting-url-invalid", 400); }
    if (publicUrl.protocol !== "https:") throw new HistosPublishError("Il nuovo WordPress richiede un URL pubblico HTTPS.", "hosting-https-required", 409);
    if (!input.databaseConnectionId || !UUID.test(input.databaseConnectionId)) {
      throw new HistosPublishError("Scegli una connessione MySQL o MariaDB verificata.", "database-connection-missing", 404);
    }
    const database = lookups.getDatabaseConnection(input.databaseConnectionId);
    if (!database) throw new HistosPublishError("Connessione database non trovata.", "database-connection-missing", 404);
    return {
      schemaVersion: 1,
      destinationId,
      label: site.name,
      publicUrl: publicUrl.toString(),
      documentRoot: hosting.remoteDirectory,
      kind: "wordpress-new",
      transport: hosting.protocol,
      runtimeRequirements: { phpMinimum: ">= 8.3" },
      detectedCapabilities: { ...noCapabilities(), runtimeProvision: true, databaseProbe: true },
      database: {
        engine: database.engine,
        host: database.host,
        port: database.port,
        databaseName: database.databaseName,
        tablePrefix: database.tablePrefix,
        tlsMode: "verify-full",
        ...(database.sshTunnel ? { tunnelRef: `database-${database.id}` } : {}),
        secretRef: `database-${database.id}`,
      },
    };
  }

  const site = siteById(destinationId, lookups);
  if (site.config.deployTarget === "ftp") {
    const hosting = site.config.hosting;
    if (!hosting) throw new HistosPublishError("Configura prima l’hosting FTP/FTPS/SFTP.", "hosting-config-missing", 409);
    if (!hosting.host || !hosting.remoteDirectory) throw new HistosPublishError("Completa server e cartella del profilo hosting.", "hosting-config-incomplete", 409);
    return {
      schemaVersion: 1,
      destinationId: site.id,
      label: site.name,
      ...(hosting.publicUrl ? { publicUrl: hosting.publicUrl } : {}),
      documentRoot: hosting.remoteDirectory,
      kind: "static-hosting",
      transport: hosting.protocol,
      detectedCapabilities: { ...noCapabilities(), remoteVerify: true },
    };
  }

  const accountId = site.config.cloudflare?.accountId || lookups.defaultAccountId || "";
  const worker = site.config.cloudflare?.script || "";
  if (!ACCOUNT_ID.test(accountId) || !WORKER_NAME.test(worker)) invalid("Configura un Account ID Cloudflare e un nome Worker valido prima di pubblicare.");
  return {
    schemaVersion: 1,
    destinationId: site.id,
    label: site.name,
    ...(site.config.cloudflare?.domain ? { publicUrl: `https://${site.config.cloudflare.domain}` } : {}),
    kind: "static-cloudflare",
    transport: "cloudflare-api",
    detectedCapabilities: { ...noCapabilities(), remoteVerify: true },
  };
}
