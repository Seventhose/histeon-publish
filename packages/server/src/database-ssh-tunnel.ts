import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";
import { HistosPublishError } from "@histos-publish/core";

export interface DatabaseSshEndpoint {
  host: string;
  port: number;
}

export interface DatabaseSshTunnel extends DatabaseSshEndpoint {
  username: string;
  authMethod: "password" | "privateKey";
  hostKeyFingerprint: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export function parseDatabaseSshEndpoint(value: unknown): DatabaseSshEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HistosPublishError("Completa l’host e la porta del server SSH.", "database-ssh-config-invalid", 2);
  }
  const input = value as Record<string, unknown>;
  const rawHost = typeof input.host === "string" ? input.host.trim() : "";
  const host = isIP(rawHost) ? rawHost : domainToASCII(rawHost.replace(/\.$/u, "").toLowerCase());
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  const validDomain = host.length > 0 && host.length <= 253 && host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
  if (!host || (!isIP(host) && !validDomain) || /[\s/@?#\\\0]/u.test(rawHost) || rawHost.includes("://")) {
    throw new HistosPublishError("Inserisci un host SSH senza protocollo o percorso.", "database-ssh-host-invalid", 2);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HistosPublishError("La porta SSH deve essere un numero tra 1 e 65535.", "database-ssh-port-invalid", 2);
  return { host, port };
}

export function sshFingerprintFromSha256Hex(hexHash: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(hexHash)) throw new TypeError("Impronta SSH SHA-256 non valida.");
  return `SHA256:${Buffer.from(hexHash, "hex").toString("base64").replace(/=+$/u, "")}`;
}

function fingerprintError(fingerprint: string): HistosPublishError {
  return new HistosPublishError(`La chiave host SSH non coincide con quella confermata. Impronta ricevuta: ${fingerprint}. Verifica il server e conferma la nuova chiave prima di riprovare.`, "database-ssh-hostkey-changed", 2);
}

function sshConnectionError(error: unknown, actualFingerprint: string, expectedFingerprint: string): HistosPublishError {
  if (actualFingerprint && actualFingerprint !== expectedFingerprint) return fingerprintError(actualFingerprint);
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/authentication.*failed|all configured authentication methods failed|no valid auth methods/u.test(message)) {
    return new HistosPublishError("Il server SSH ha rifiutato l’utente o la credenziale.", "database-ssh-auth-failed", 2);
  }
  if (/private.?key|passphrase|bad decrypt|unable to decrypt|malformed openssh/u.test(message)) {
    return new HistosPublishError("La chiave privata SSH o la sua passphrase non è valida.", "database-ssh-key-invalid", 2);
  }
  return new HistosPublishError("Il server SSH ha rifiutato la connessione.", "database-ssh-connect-failed", 4);
}

/** Reads an SSH host key without authenticating or sending any user credential. */
export async function readDatabaseSshHostFingerprint(endpointInput: unknown): Promise<string> {
  const endpoint = parseDatabaseSshEndpoint(endpointInput);
  const client = new Client();
  return await new Promise<string>((resolve, reject) => {
    let actualFingerprint = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else if (actualFingerprint) resolve(actualFingerprint);
      else reject(new Error("Il server SSH non ha presentato una chiave host verificabile."));
    };
    client.on("error", (error) => finish(actualFingerprint ? undefined : error));
    client.once("close", () => finish(actualFingerprint ? undefined : new Error("Il server SSH ha chiuso la connessione prima di presentare la chiave host.")));
    client.once("ready", () => finish(actualFingerprint ? undefined : new Error("Il server SSH non ha presentato una chiave host verificabile.")));
    timeout = setTimeout(() => finish(new Error("Il server SSH non ha risposto entro il tempo previsto.")), 15_000);
    try {
      client.connect({
        host: endpoint.host,
        port: endpoint.port,
        username: "histos-host-key-check",
        readyTimeout: 12_000,
        hostHash: "sha256",
        hostVerifier: (hexHash: string) => {
          actualFingerprint = sshFingerprintFromSha256Hex(hexHash);
          return false;
        },
      });
    } catch (error) {
      finish(error);
    }
  });
}

/** Opens one bounded SSH direct-tcpip stream to the selected database endpoint. */
export async function openDatabaseSshForward(
  tunnel: DatabaseSshTunnel,
  databaseHost: string,
  databasePort: number,
): Promise<{ client: Client; stream: Duplex }> {
  const endpoint = parseDatabaseSshEndpoint(tunnel);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(tunnel.hostKeyFingerprint)) {
    throw new HistosPublishError("Verifica e conferma prima la chiave host del server SSH.", "database-ssh-hostkey-unconfirmed", 2);
  }
  const client = new Client();
  return await new Promise<{ client: Client; stream: Duplex }>((resolve, reject) => {
    let actualFingerprint = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: unknown, stream?: Duplex) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) {
        client.end();
        reject(error);
      } else if (stream) {
        resolve({ client, stream });
      } else {
        client.end();
        reject(new Error("Il tunnel SSH non ha aperto il canale del database."));
      }
    };
    client.on("error", (error) => {
      if (!settled) finish(sshConnectionError(error, actualFingerprint, tunnel.hostKeyFingerprint));
      else if (error) return;
    });
    client.once("close", () => {
      if (!settled) finish(new HistosPublishError("Il server SSH ha chiuso il tunnel prima di raggiungere il database.", "database-ssh-connect-failed", 4));
    });
    timeout = setTimeout(() => finish(new HistosPublishError("Il server SSH non ha aperto il tunnel entro il tempo previsto.", "database-ssh-timeout", 4)), 20_000);
    try {
      client.connect({
        host: endpoint.host,
        port: endpoint.port,
        username: tunnel.username,
        readyTimeout: 15_000,
        hostHash: "sha256",
        hostVerifier: (hexHash: string) => {
          actualFingerprint = sshFingerprintFromSha256Hex(hexHash);
          return actualFingerprint === tunnel.hostKeyFingerprint;
        },
        ...(tunnel.authMethod === "privateKey"
          ? { ...(tunnel.privateKey ? { privateKey: tunnel.privateKey } : {}), ...(tunnel.passphrase ? { passphrase: tunnel.passphrase } : {}) }
          : (tunnel.password ? { password: tunnel.password } : {})),
      });
      client.once("ready", () => {
        client.forwardOut("127.0.0.1", 0, databaseHost, databasePort, (error, stream) => {
          if (error) {
            finish(new HistosPublishError("Il server SSH non consente di aprire un tunnel verso questo database.", "database-ssh-forward-rejected", 4));
            return;
          }
          finish(undefined, stream);
        });
      });
    } catch (error) {
      finish(sshConnectionError(error, actualFingerprint, tunnel.hostKeyFingerprint));
    }
  });
}
