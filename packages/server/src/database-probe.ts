import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { HistosPublishError } from "@histos-publish/core";
import { openDatabaseSshForward, parseDatabaseSshEndpoint, type DatabaseSshTunnel } from "./database-ssh-tunnel.js";

export interface DatabaseConnectionInput {
  name: string;
  host: string;
  port: number;
  databaseName: string;
  tablePrefix: string;
  username: string;
  password: string;
  caCertificate: string;
  sshTunnel?: DatabaseSshTunnel;
}

export interface DatabaseProbeResult {
  engine: "mysql" | "mariadb";
  serverVersion: string;
  serverComment: string;
  characterSet: string;
  collation: string;
  tableCount: number;
  prefixTableCount: number;
  privilegesVerified: boolean;
  grantedPrivileges: string[];
  missingPrivileges: string[];
  checkedAt: string;
}

export interface StoredDatabaseConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  databaseName: string;
  tablePrefix: string;
  engine: "mysql" | "mariadb";
  serverVersion: string;
  serverComment: string;
  characterSet: string;
  collation: string;
  tableCount: number;
  prefixTableCount: number;
  privilegesVerified: boolean;
  grantedPrivileges: string[];
  missingPrivileges: string[];
  createdAt: string;
  checkedAt: string;
  sshTunnel?: Omit<DatabaseSshTunnel, "password" | "privateKey" | "passphrase">;
}

const WORDPRESS_INSTALL_PRIVILEGES = ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "INSERT", "SELECT", "UPDATE"] as const;

export function evaluateDatabasePrivileges(grants: string[], databaseName: string): Pick<DatabaseProbeResult, "privilegesVerified" | "grantedPrivileges" | "missingPrivileges"> {
  const granted = new Set<string>();
  let sawApplicableGrant = false;
  let hasRoleGrant = false;
  for (const grant of grants) {
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/iu.exec(grant.trim());
    if (!match) {
      if (/^GRANT\s+.+\s+TO\s+/iu.test(grant.trim())) hasRoleGrant = true;
      continue;
    }
    const scope = match[2]!.replaceAll("`", "").replaceAll("\\", "").replace(/\s/gu, "");
    const applies = scope === "*.*" || scope.toLowerCase() === `${databaseName}.*`.toLowerCase();
    if (!applies) continue;
    sawApplicableGrant = true;
    const privileges = match[1]!.split(",").map((value) => value.trim().toUpperCase());
    if (privileges.includes("ALL PRIVILEGES") || privileges.includes("ALL")) {
      for (const privilege of WORDPRESS_INSTALL_PRIVILEGES) granted.add(privilege);
    } else {
      for (const privilege of privileges) {
        const normalized = privilege.replace(/\s*\([^)]*\)$/u, "").trim();
        if ((WORDPRESS_INSTALL_PRIVILEGES as readonly string[]).includes(normalized)) granted.add(normalized);
      }
    }
  }
  const grantedPrivileges = [...granted].sort();
  const missingPrivileges = WORDPRESS_INSTALL_PRIVILEGES.filter((privilege) => !granted.has(privilege));
  const privilegesVerified = missingPrivileges.length === 0 || sawApplicableGrant && !hasRoleGrant;
  return { privilegesVerified, grantedPrivileges, missingPrivileges: privilegesVerified ? missingPrivileges : [] };
}

export function wordpressDatabaseVersionSupported(engine: "mysql" | "mariadb", serverVersion: string): boolean {
  const mariadbVersion = engine === "mariadb" ? /(?:^|\D)(\d+)\.(\d+)(?:\.(\d+))?\s*-?\s*mariadb/iu.exec(serverVersion) : null;
  const version = mariadbVersion ?? /(?:^|\D)(\d+)\.(\d+)(?:\.(\d+))?/u.exec(serverVersion);
  if (!version) return false;
  const actual = [Number(version[1]), Number(version[2]), Number(version[3] ?? 0)];
  const required = engine === "mariadb" ? [10, 11, 0] : [8, 0, 0];
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

export function parseDatabaseConnectionInput(value: unknown): DatabaseConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HistosPublishError("Completa i dati della connessione MySQL o MariaDB.", "database-config-invalid", 2);
  }
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const rawHost = typeof input.host === "string" ? input.host.trim() : "";
  const hostIsIp = Boolean(isIP(rawHost));
  const host = hostIsIp ? rawHost : domainToASCII(rawHost.replace(/\.$/u, "").toLowerCase());
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  const databaseName = typeof input.databaseName === "string" ? input.databaseName.trim() : "";
  const tablePrefix = typeof input.tablePrefix === "string" ? input.tablePrefix.trim() : "";
  const username = typeof input.username === "string" ? input.username : "";
  const password = typeof input.password === "string" ? input.password : "";
  const caCertificate = typeof input.caCertificate === "string" ? input.caCertificate.trim() : "";
  let sshTunnel: DatabaseSshTunnel | undefined;

  if (!name || name.length > 120 || /[\0\r\n]/u.test(name)) throw new HistosPublishError("Dai un nome breve a questa connessione.", "database-name-invalid", 2);
  const validDomain = host.length > 0 && host.length <= 253 && host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
  if (!host || host.length > 253 || (!hostIsIp && !validDomain) || /[\s/@?#\\\0]/u.test(rawHost) || rawHost.includes("://")) {
    throw new HistosPublishError("Inserisci il nome host del database senza protocollo o percorso.", "database-host-invalid", 2);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HistosPublishError("La porta deve essere un numero tra 1 e 65535.", "database-port-invalid", 2);
  if (!/^[A-Za-z0-9_$-]{1,64}$/u.test(databaseName)) throw new HistosPublishError("Il nome del database contiene caratteri non supportati.", "database-name-invalid", 2);
  if (!/^[A-Za-z0-9_]{1,32}$/u.test(tablePrefix)) throw new HistosPublishError("Il prefisso deve contenere da 1 a 32 lettere, numeri o underscore.", "database-prefix-invalid", 2);
  if (!username || username.length > 128 || /[\0\r\n]/u.test(username)) throw new HistosPublishError("Inserisci il nome dell’utente MySQL o MariaDB.", "database-username-invalid", 2);
  if (!password || password.length > 4096 || password.includes("\0")) throw new HistosPublishError("Inserisci la password del database.", "database-password-invalid", 2);
  if (caCertificate.length > 64 * 1024) throw new HistosPublishError("Il certificato CA supera il limite di 64 KiB.", "database-ca-invalid", 2);
  if (caCertificate) {
    try {
      const certificates = caCertificate.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
      const remainder = caCertificate.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim();
      if (certificates.length === 0 || remainder) throw new Error("invalid-pem");
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch {
      throw new HistosPublishError("Il certificato CA non è un PEM valido. Puoi lasciare vuoto il campo per usare le CA del sistema.", "database-ca-invalid", 2);
    }
  }

  if (input.sshTunnel !== undefined && input.sshTunnel !== null) {
    if (!input.sshTunnel || typeof input.sshTunnel !== "object" || Array.isArray(input.sshTunnel)) {
      throw new HistosPublishError("La configurazione del tunnel SSH non è valida.", "database-ssh-config-invalid", 2);
    }
    const tunnel = input.sshTunnel as Record<string, unknown>;
    const endpoint = parseDatabaseSshEndpoint(tunnel);
    const tunnelUsername = typeof tunnel.username === "string" ? tunnel.username.trim() : "";
    const authMethod = tunnel.authMethod === "privateKey" ? "privateKey" : tunnel.authMethod === "password" ? "password" : null;
    const hostKeyFingerprint = typeof tunnel.hostKeyFingerprint === "string" ? tunnel.hostKeyFingerprint.trim() : "";
    const tunnelPassword = typeof tunnel.password === "string" ? tunnel.password : "";
    const privateKey = typeof tunnel.privateKey === "string" ? tunnel.privateKey : "";
    const passphrase = typeof tunnel.passphrase === "string" ? tunnel.passphrase : "";
    if (!tunnelUsername || tunnelUsername.length > 128 || /[\0\r\n]/u.test(tunnelUsername)) throw new HistosPublishError("Inserisci l’utente del server SSH.", "database-ssh-username-invalid", 2);
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(hostKeyFingerprint)) throw new HistosPublishError("Verifica e conferma la chiave host SSH prima di salvare il database.", "database-ssh-hostkey-unconfirmed", 2);
    if (authMethod === "password" && (!tunnelPassword || tunnelPassword.length > 4096 || tunnelPassword.includes("\0"))) throw new HistosPublishError("Inserisci la password SSH.", "database-ssh-password-invalid", 2);
    if (authMethod === "privateKey" && (!privateKey || privateKey.length > 128 * 1024 || !/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(privateKey.trim()) || !/-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/u.test(privateKey.trim()))) throw new HistosPublishError("Inserisci una chiave privata SSH PEM valida.", "database-ssh-key-invalid", 2);
    if (passphrase.length > 4096 || passphrase.includes("\0")) throw new HistosPublishError("La passphrase SSH non è valida.", "database-ssh-passphrase-invalid", 2);
    if (!authMethod) throw new HistosPublishError("Scegli password o chiave privata per il server SSH.", "database-ssh-auth-invalid", 2);
    sshTunnel = {
      ...endpoint,
      username: tunnelUsername,
      authMethod,
      hostKeyFingerprint,
      ...(authMethod === "password" ? { password: tunnelPassword } : { privateKey, ...(passphrase ? { passphrase } : {}) }),
    };
  }

  return { name, host, port, databaseName, tablePrefix, username, password, caCertificate, ...(sshTunnel ? { sshTunnel } : {}) };
}

function databaseError(error: unknown): HistosPublishError {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (/CERT|TLS|SSL|HANDSHAKE|PROTOCOL_TLS|VERIFY|SELF_SIGNED/u.test(code)) {
    return new HistosPublishError("Il certificato TLS del database non è valido per questo host. Controlla CA, nome host e validità del certificato.", "database-tls-invalid", 2);
  }
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_NOT_SUPPORTED_AUTH_MODE") {
    return new HistosPublishError("Il database ha rifiutato utente o password.", "database-auth-failed", 2);
  }
  if (code === "ER_BAD_DB_ERROR") return new HistosPublishError("Il database indicato non esiste o l’utente non può accedervi.", "database-not-found", 2);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return new HistosPublishError("Non riesco a raggiungere il database. Controlla host, porta e accesso remoto dell’hosting.", "database-unreachable", 4);
  }
  return new HistosPublishError("La verifica del database non è riuscita. Controlla impostazioni, certificato e privilegi dell’utente.", "database-probe-failed", 4);
}

export async function probeDatabaseConnection(input: DatabaseConnectionInput): Promise<DatabaseProbeResult> {
  let connection: Awaited<ReturnType<typeof createConnection>> | undefined;
  let sshClient: Awaited<ReturnType<typeof openDatabaseSshForward>>["client"] | undefined;
  try {
    const tunnel = input.sshTunnel ? await openDatabaseSshForward(input.sshTunnel, input.host, input.port) : undefined;
    sshClient = tunnel?.client;
    connection = await createConnection({
      host: input.host,
      port: input.port,
      user: input.username,
      password: input.password,
      database: input.databaseName,
      ...(tunnel ? { stream: tunnel.stream } : {}),
      connectTimeout: 8_000,
      multipleStatements: false,
      ssl: {
        rejectUnauthorized: true,
        ...(input.caCertificate ? { ca: input.caCertificate } : {}),
      },
    });
    const [metadataRows] = await connection.query<RowDataPacket[]>(
      "SELECT VERSION() AS serverVersion, @@version_comment AS serverComment, @@character_set_server AS characterSet, @@collation_server AS collation",
    );
    const metadata = metadataRows[0];
    if (!metadata) throw new Error("database-metadata-missing");
    const serverVersion = String(metadata.serverVersion ?? "");
    const serverComment = String(metadata.serverComment ?? "");
    const engine = /mariadb/iu.test(`${serverVersion} ${serverComment}`) ? "mariadb" : /mysql/iu.test(`${serverVersion} ${serverComment}`) ? "mysql" : null;
    if (!engine) throw new HistosPublishError("Il server raggiunto non dichiara MySQL o MariaDB.", "database-engine-unsupported", 2);
    const [tableRows] = await connection.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS tableCount, COALESCE(SUM(CASE WHEN LEFT(table_name, CHAR_LENGTH(?)) = ? THEN 1 ELSE 0 END), 0) AS prefixTableCount FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
      [input.tablePrefix, input.tablePrefix, input.databaseName],
    );
    const tables = tableRows[0];
    if (!tables) throw new Error("database-table-metadata-missing");
    let privileges: Pick<DatabaseProbeResult, "privilegesVerified" | "grantedPrivileges" | "missingPrivileges"> = {
      privilegesVerified: false,
      grantedPrivileges: [],
      missingPrivileges: [],
    };
    try {
      const [grantRows] = await connection.query<RowDataPacket[]>("SHOW GRANTS");
      privileges = evaluateDatabasePrivileges(grantRows.map((row) => String(Object.values(row)[0] ?? "")), input.databaseName);
    } catch {
      // Some managed database services hide grant metadata; never claim permissions are verified in that case.
    }
    return {
      engine,
      serverVersion,
      serverComment,
      characterSet: String(metadata.characterSet ?? ""),
      collation: String(metadata.collation ?? ""),
      tableCount: Number(tables.tableCount ?? 0),
      prefixTableCount: Number(tables.prefixTableCount ?? 0),
      ...privileges,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw databaseError(error);
  } finally {
    await connection?.end().catch(() => undefined);
    sshClient?.end();
  }
}

export function storedDatabaseConnection(input: DatabaseConnectionInput, result: DatabaseProbeResult, id: string, createdAt = new Date().toISOString()): StoredDatabaseConnection {
  return {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    databaseName: input.databaseName,
    tablePrefix: input.tablePrefix,
    ...result,
    createdAt,
    ...(input.sshTunnel ? { sshTunnel: {
      host: input.sshTunnel.host,
      port: input.sshTunnel.port,
      username: input.sshTunnel.username,
      authMethod: input.sshTunnel.authMethod,
      hostKeyFingerprint: input.sshTunnel.hostKeyFingerprint,
    } } : {}),
  };
}
