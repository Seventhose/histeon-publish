import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseDatabaseConnectionInput, probeDatabaseConnection } from "../packages/server/dist/database-probe.js";
import { startLocalServer } from "../packages/server/dist/server.js";

const host = process.env.HISTOS_PUBLISH_TEST_DB_HOST;
const port = Number(process.env.HISTOS_PUBLISH_TEST_DB_PORT);
const databaseName = process.env.HISTOS_PUBLISH_TEST_DB_NAME;
const tablePrefix = process.env.HISTOS_PUBLISH_TEST_DB_PREFIX;
const username = process.env.HISTOS_PUBLISH_TEST_DB_USER;
const password = process.env.HISTOS_PUBLISH_TEST_DB_PASSWORD;
const caPath = process.env.HISTOS_PUBLISH_TEST_DB_CA_FILE;
const badCaPath = process.env.HISTOS_PUBLISH_TEST_DB_BAD_CA_FILE;
const sshHost = process.env.HISTOS_PUBLISH_TEST_SSH_HOST;
const sshPort = Number(process.env.HISTOS_PUBLISH_TEST_SSH_PORT);
const sshUsername = process.env.HISTOS_PUBLISH_TEST_SSH_USER;
const sshPassword = process.env.HISTOS_PUBLISH_TEST_SSH_PASSWORD;
const sshPrivateKey = process.env.HISTOS_PUBLISH_TEST_SSH_PRIVATE_KEY;
const sshPassphrase = process.env.HISTOS_PUBLISH_TEST_SSH_PASSPHRASE;
const sshHostKeyFingerprint = process.env.HISTOS_PUBLISH_TEST_SSH_FINGERPRINT;

if (!host || !["127.0.0.1", "::1"].includes(host) || isIP(host) === 0) {
  throw new Error("Il test accetta solo un database usa-e-getta in ascolto su 127.0.0.1 o ::1.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535 || !databaseName || !tablePrefix || !username || !password || !caPath || !badCaPath || !sshHost || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535 || !sshUsername || !sshPassword || !sshPrivateKey || !sshPassphrase || !sshHostKeyFingerprint) {
  throw new Error("Imposta i riferimenti del database e del server SSH locale usa-e-getta.");
}

const caCertificate = await readFile(caPath, "utf8");
const badCaCertificate = await readFile(badCaPath, "utf8");
const input = parseDatabaseConnectionInput({
  name: "Verifica MySQL locale",
  host,
  port,
  databaseName,
  tablePrefix,
  username,
  password,
  caCertificate,
});
const result = await probeDatabaseConnection(input);
if (result.tableCount !== 1 || result.prefixTableCount !== 1) {
  throw new Error("Il probe non ha contato correttamente la tabella preesistente col prefisso scelto.");
}
console.log(`Connessione TLS verificata (${result.engine}); ${result.tableCount} tabelle, ${result.prefixTableCount} col prefisso scelto.`);

const sshTunnel = {
  host: sshHost,
  port: sshPort,
  username: sshUsername,
  authMethod: "password",
  password: sshPassword,
  hostKeyFingerprint: sshHostKeyFingerprint,
};
const tunneledResult = await probeDatabaseConnection({ ...input, sshTunnel });
if (tunneledResult.tableCount !== 1 || tunneledResult.prefixTableCount !== 1) {
  throw new Error("Il probe tramite tunnel SSH non ha verificato la tabella attesa.");
}
console.log("Tunnel SSH: host key fissata, canale direct-tcpip e TLS MySQL verificati.");
const keyTunnel = {
  host: sshHost,
  port: sshPort,
  username: sshUsername,
  authMethod: "privateKey",
  privateKey: sshPrivateKey,
  passphrase: sshPassphrase,
  hostKeyFingerprint: sshHostKeyFingerprint,
};
const keyTunnelResult = await probeDatabaseConnection({ ...input, sshTunnel: keyTunnel });
if (keyTunnelResult.tableCount !== 1 || keyTunnelResult.prefixTableCount !== 1) {
  throw new Error("Il probe con chiave SSH cifrata non ha verificato la tabella attesa.");
}
console.log("Tunnel SSH con chiave privata cifrata e passphrase verificato.");

for (const [label, tunnel, expectedCode] of [
  ["chiave host diversa", { ...sshTunnel, hostKeyFingerprint: `SHA256:${sshHostKeyFingerprint.endsWith("A") ? "B" : "A"}${sshHostKeyFingerprint.slice("SHA256:".length + 1)}` }, "database-ssh-hostkey-changed"],
  ["password SSH errata", { ...sshTunnel, password: `${sshPassword}-errata` }, "database-ssh-auth-failed"],
  ["passphrase SSH errata", { ...keyTunnel, passphrase: `${sshPassphrase}-errata` }, "database-ssh-key-invalid"],
]) {
  try {
    await probeDatabaseConnection({ ...input, sshTunnel: tunnel });
    throw new Error(`La prova con ${label} è stata accettata.`);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== expectedCode) {
      throw new Error(`La prova con ${label} non è stata classificata in modo sicuro.`);
    }
  }
  console.log(`Rifiuto ${label} verificato.`);
}

for (const [label, changedInput, expectedCode] of [
  ["CA errata", { ...input, caCertificate: badCaCertificate }, "database-tls-invalid"],
  ["password errata", { ...input, password: `${password}-errata` }, "database-auth-failed"],
]) {
  try {
    await probeDatabaseConnection(changedInput);
    throw new Error(`La prova con ${label.toLowerCase()} è stata accettata.`);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== expectedCode) {
      throw new Error(`La prova con ${label.toLowerCase()} non è stata classificata in modo sicuro.`);
    }
  }
  console.log(`Rifiuto ${label.toLowerCase()} verificato senza dettagli del driver.`);
}

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-db-probe-api-"));
const uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-db-probe-ui-"));
const secrets = new Map();
let server;
try {
  await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>local probe</title>");
  server = await startLocalServer({
    dataDirectory,
    uiDirectory,
    openBrowser: false,
    secretStoreFactory: (account) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value) => { secrets.set(account, value); },
      delete: async () => { secrets.delete(account); },
    }),
  });
  const baseUrl = new URL(server.url).origin;
  const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: baseUrl };
  const sshHostKey = await fetch(`${baseUrl}/api/database-connections/ssh-hostkey`, {
    method: "POST",
    headers,
    body: JSON.stringify({ host: sshHost, port: sshPort }),
  });
  const sshHostKeyBody = await sshHostKey.json();
  if (sshHostKey.status !== 200 || sshHostKeyBody.hostKeyFingerprint !== sshHostKeyFingerprint) {
    throw new Error("L’API non ha rilevato in modo anonimo l’impronta SSH corretta.");
  }
  const request = {
    name: "Database MariaDB usa-e-getta",
    host,
    port,
    databaseName,
    tablePrefix,
    username,
    password,
    caCertificate,
    sshTunnel,
  };
  const created = await fetch(`${baseUrl}/api/database-connections`, { method: "POST", headers, body: JSON.stringify(request) });
  if (created.status !== 201) throw new Error(`L’API locale non ha salvato la connessione verificata (HTTP ${created.status}).`);
  const createdBody = await created.json();
  const profile = createdBody.connection;
  if (
    JSON.stringify(createdBody).includes(password)
    || Object.hasOwn(profile ?? {}, "username")
    || Object.hasOwn(profile ?? {}, "password")
    || Object.hasOwn(profile ?? {}, "caCertificate")
    || Object.hasOwn(profile ?? {}, "credentials")
    || JSON.stringify(createdBody).includes(sshPassword)
    || Object.hasOwn(profile?.sshTunnel ?? {}, "password")
    || Object.hasOwn(profile?.sshTunnel ?? {}, "privateKey")
    || Object.hasOwn(profile?.sshTunnel ?? {}, "passphrase")
  ) {
    throw new Error("L’API locale ha restituito credenziali o certificato nella risposta.");
  }
  if (profile?.sshTunnel?.hostKeyFingerprint !== sshHostKeyFingerprint) throw new Error("Il profilo non ha conservato la sola configurazione pubblica del tunnel SSH.");
  if (profile?.privilegesVerified !== true || profile?.missingPrivileges?.length !== 0) {
    throw new Error("La verifica reale non ha confermato i privilegi richiesti per WordPress.");
  }
  if (profile.tableCount !== 1 || profile.prefixTableCount !== 1) throw new Error("Il profilo non ha riportato correttamente la tabella preesistente.");
  const id = createdBody.connection?.id;
  if (typeof id !== "string" || secrets.size !== 1) throw new Error("Profilo o segreto keyring non salvato correttamente.");
  const savedSecret = JSON.parse(secrets.get(`database-${id}`) ?? "{}");
  if (savedSecret.sshTunnel?.password !== sshPassword) throw new Error("Le credenziali SSH non sono state salvate nel portachiavi.");

  const rechecked = await fetch(`${baseUrl}/api/database-connections/${encodeURIComponent(id)}/probe`, { method: "POST", headers });
  if (rechecked.status !== 200 || JSON.stringify(await rechecked.json()).includes(password)) throw new Error("La ricontrollata API non è riuscita o ha esposto il segreto.");

  const invalid = await fetch(`${baseUrl}/api/database-connections`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, name: "Credenziali errate", password: `${password}-errata` }),
  });
  if (invalid.status !== 401 || secrets.size !== 1) throw new Error("Credenziali non valide accettate dall’API o salvate nel portachiavi.");

  const removed = await fetch(`${baseUrl}/api/database-connections/${encodeURIComponent(id)}`, { method: "DELETE", headers });
  if (removed.status !== 200 || secrets.size !== 0) throw new Error("L’API non ha rimosso il profilo e il segreto.");
  console.log("API locale: rilevamento host key, tunnel SSH, portachiavi, ricontrollo, rifiuto credenziali errate e rimozione superati.");
} finally {
  await server?.close();
  await Promise.all([rm(dataDirectory, { recursive: true, force: true }), rm(uiDirectory, { recursive: true, force: true })]);
}
