import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCloudflareMock } from "../../cf-mock/src/index.js";
import { HistosPublishError } from "@histos-publish/core";
import type { DatabaseConnectionInput, DatabaseProbeResult } from "../src/database-probe.js";
import type { StaticHostingCredentials, StaticHostingDirectoryInspection, StaticHostingSettings, StaticHostingFile } from "../src/static-hosting.js";
import type { WordPressPhpRuntime, WordPressRuntimeProbeOptions } from "../src/wordpress-runtime-probe.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

describe("server locale e sessione del browser", () => {
  let server: LocalServerHandle;
  let dataDirectory: string;
  let uiDirectory: string;
  let secrets: Map<string, string>;
  let databaseProbeInputs: DatabaseConnectionInput[];
  let databaseProbeFails: boolean;
  let hostingDirectoryResult: StaticHostingDirectoryInspection;
  let hostingDirectoryInputs: Array<{ settings: StaticHostingSettings; credentials: StaticHostingCredentials }>;
  let wordpressRuntimeProbeInputs: WordPressRuntimeProbeOptions[];
  let wordpressRuntimeProbeResult: WordPressPhpRuntime;
  let provisionUploadedFiles: StaticHostingFile[][];
  let provisionBootstrapPayloads: Array<Record<string, unknown>>;
  let provisionTemporaryFiles: string[];
  let provisionConnectionIds: string[];
  let databaseProbeResult: DatabaseProbeResult = {
    engine: "mariadb",
    serverVersion: "10.11.10-MariaDB",
    serverComment: "MariaDB Server",
    characterSet: "utf8mb4",
    collation: "utf8mb4_general_ci",
    tableCount: 0,
    prefixTableCount: 0,
    privilegesVerified: true,
    grantedPrivileges: ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "INSERT", "SELECT", "UPDATE"],
    missingPrivileges: [],
    checkedAt: "2026-10-23T20:00:00.000Z",
  };

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-server-test-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-server-test-ui-"));
    secrets = new Map();
    databaseProbeInputs = [];
    databaseProbeFails = false;
    databaseProbeResult = {
      engine: "mariadb",
      serverVersion: "10.11.10-MariaDB",
      serverComment: "MariaDB Server",
      characterSet: "utf8mb4",
      collation: "utf8mb4_general_ci",
      tableCount: 0,
      prefixTableCount: 0,
      privilegesVerified: true,
      grantedPrivileges: ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "INSERT", "SELECT", "UPDATE"],
      missingPrivileges: [],
      checkedAt: "2026-10-23T20:00:00.000Z",
    };
    hostingDirectoryResult = { entryCount: 0, isEmpty: true, wordpressSignals: [], remoteFiles: [], remoteInventoryComplete: true };
    hostingDirectoryInputs = [];
    wordpressRuntimeProbeInputs = [];
    provisionUploadedFiles = [];
    provisionBootstrapPayloads = [];
    provisionTemporaryFiles = [];
    provisionConnectionIds = [];
    wordpressRuntimeProbeResult = { phpChecked: true, phpVersion: "8.3.10", phpSupported: true, phpRecommended: false, missingRequiredExtensions: [], missingRecommendedExtensions: [], databaseTlsVerified: true, databaseTlsFailure: null, httpsAvailable: true, wordpressMinimumPhp: ">= 7.4", requiredPhp: ">= 8.3", recommendedPhp: ">= 8.4", status: "supported" };
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test locale</title>");
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const coreBytes = Buffer.from("<?php // verified WordPress core");
    const histosEntry = Buffer.from("<?php // verified Histeon plugin");
    const histosLicense = Buffer.from("GPL-3.0-or-later");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, publishedHomeCheck: async (url) => ({ status: url ? "ok" : "unavailable", ...(url ? { url } : {}), message: "Verifica di prova." }), databaseProbe: async (input) => { databaseProbeInputs.push(input); if (databaseProbeFails) throw new HistosPublishError("Il database ha rifiutato utente o password.", "database-auth-failed", 401); return databaseProbeResult; }, hostingConnectionVerification: async () => ({ verified: true }), hostingDirectoryInspection: async (settings, credentials) => { hostingDirectoryInputs.push({ settings, credentials }); return hostingDirectoryResult; }, wordpressRuntimeProbe: async (input) => { wordpressRuntimeProbeInputs.push(input); return wordpressRuntimeProbeResult; }, wordpressProvisioning: {
      downloadCore: async () => ({ version: "7.1.3", locale: "en_US", phpMinimum: "8.0", mysqlMinimum: "8.0", archiveSha256: "a".repeat(64), files: [{ path: "index.php", bytes: coreBytes, sha256: hash(coreBytes) }] }),
      loadHistosPlugin: async () => ({ version: "0.3.1", wordpressMinimum: "6.9", phpMinimum: "8.3", archiveSha256: "b".repeat(64), files: [{ path: "xb.php", bytes: histosEntry, sha256: hash(histosEntry) }, { path: "LICENSE", bytes: histosLicense, sha256: hash(histosLicense) }] }),
      uploadFiles: async ({ files }) => { provisionUploadedFiles.push(files); return { uploaded: files.length, files: files.length, publicUrl: "https://wp.example.test" }; },
      withTemporaryFile: async <T,>({ fileName, run }: { settings: StaticHostingSettings; credentials: StaticHostingCredentials; fileName: string; bytes: Buffer; run: () => Promise<T> }) => { provisionTemporaryFiles.push(fileName); return run(); },
      postJson: async (_url, payload) => { provisionBootstrapPayloads.push(payload); return { status: 200, contentType: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify({ probe: "histos-wordpress-provision-v1", code: payload.mode === "recover" ? "recovered" : "installed", planId: payload.planId, wordpressVersion: "7.1.3", pairingCode: "histos-cms-1:test", siteUrl: "https://wp.example.test" })) }; },
      connectRemote: async (_pairingCode, _catalog, _storeFor, connectionId) => {
        const id = connectionId ?? randomUUID();
        provisionConnectionIds.push(id);
        return { id, url: "https://wp.example.test", siteId: randomUUID(), projectId: null, projectName: "Nuovo sito", profile: "histos-static-page-v1", read: true, write: true, publish: false, connectedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), lastSyncedAt: null };
      },
    }, secretStoreFactory: (account) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value) => { secrets.set(account, value); },
      delete: async () => { secrets.delete(account); },
    }) });
  });

  afterEach(async () => {
    await server.close();
    await Promise.all([rm(dataDirectory, { recursive: true, force: true }), rm(uiDirectory, { recursive: true, force: true })]);
  });

  it("nega API senza token e accetta il token solo sull’host loopback previsto", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(server.port).toBeGreaterThanOrEqual(49152);
    expect(server.port).toBeLessThanOrEqual(65535);
    const anonymous = await fetch(`${base}/api/bootstrap`);
    expect(anonymous.status).toBe(401);

    const authenticated = await fetch(`${base}/api/bootstrap`, { headers: { "X-Histos-Token": server.token } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ sites: [], token: { configured: false } });

    const spoofedHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/api/bootstrap", headers: { Host: `attacker.test:${server.port}`, "X-Histos-Token": server.token } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
    expect(spoofedHost).toBe(403);
  });

  it("richiede Origin locale sulle modifiche e non abilita CORS", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json" };
    const rejected = await fetch(`${base}/api/settings`, { method: "POST", headers: { ...headers, Origin: "https://attacker.test" }, body: JSON.stringify({ language: "en" }) });
    expect(rejected.status).toBe(403);

    const saved = await fetch(`${base}/api/settings`, { method: "POST", headers: { ...headers, Origin: base }, body: JSON.stringify({ language: "en" }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ language: "en" });
    expect(saved.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("apre una copia cifrata solo entro la dimensione di una copia, non fino a 1 GiB", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    // 800 MiB: more than the largest sealed copy in base64 (about 683 MiB), less than the old 1 GiB.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/api/settings/copies/open", method: "POST", headers: { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base, "Content-Length": String(800 * 1024 * 1024) } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      request.once("error", (error) => { if (!request.destroyed) reject(error); });
      request.write("{");
    });
    expect(status).toBe(413);
  });

  it("verifica un Account API Token con l’ID account e lo salva nelle impostazioni", async () => {
    const cloudflare = await startCloudflareMock();
    const previousApiBase = process.env.HISTOS_CLOUDFLARE_API_BASE;
    process.env.HISTOS_CLOUDFLARE_API_BASE = cloudflare.url;
    try {
      cloudflare.failNext({ method: "GET", path: "/client/v4/user/tokens/verify", status: 401, message: "Invalid API Token" });
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/settings/cloudflare-token`, {
        method: "POST",
        headers: { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ token: cloudflare.token, accountId: cloudflare.accountId }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ accountOwned: true, accountId: cloudflare.accountId, status: "active" });
      expect(secrets.get("cloudflare-api-token")).toBe(cloudflare.token);
      const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { "X-Histos-Token": server.token } });
      await expect(bootstrap.json()).resolves.toMatchObject({ accountId: cloudflare.accountId, token: { configured: true } });
    } finally {
      if (previousApiBase === undefined) delete process.env.HISTOS_CLOUDFLARE_API_BASE;
      else process.env.HISTOS_CLOUDFLARE_API_BASE = previousApiBase;
      await cloudflare.close();
    }
  });

  it("verifica, salva e rimuove una connessione MariaDB senza restituire le credenziali", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/database-connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Hosting prove",
        host: "db.example.test",
        port: 3307,
        databaseName: "histos_demo",
        tablePrefix: "wp_demo_",
        username: "wp_probe",
        password: "non-deve-tornare-in-risposta",
        caCertificate: "",
        sshTunnel: { host: "ssh.example.test", port: 22, username: "ssh_probe", authMethod: "password", password: "ssh-password-non-da-restituire", hostKeyFingerprint: `SHA256:${"A".repeat(43)}` },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { connection: Record<string, unknown> };
    expect(createdBody.connection).toMatchObject({ name: "Hosting prove", engine: "mariadb", tableCount: 0, prefixTableCount: 0 });
    expect(JSON.stringify(createdBody)).not.toContain("non-deve-tornare-in-risposta");
    expect(JSON.stringify(createdBody)).not.toContain("ssh-password-non-da-restituire");
    expect(JSON.stringify(createdBody)).not.toContain("wp_probe");
    expect(databaseProbeInputs[0]).toMatchObject({ username: "wp_probe", password: "non-deve-tornare-in-risposta", sshTunnel: { username: "ssh_probe", password: "ssh-password-non-da-restituire" } });
    expect(secrets.size).toBe(1);

    const listed = await fetch(`${base}/api/database-connections`, { headers: { "X-Histos-Token": server.token } });
    const listedBody = await listed.json() as { connections: Array<Record<string, unknown>> };
    expect(listedBody.connections).toHaveLength(1);
    expect(JSON.stringify(listedBody)).not.toContain("non-deve-tornare-in-risposta");
    expect(JSON.stringify(listedBody)).not.toContain("wp_probe");
    expect(JSON.stringify(listedBody)).not.toContain("ssh-password-non-da-restituire");

    const id = String(createdBody.connection.id);
    const checked = await fetch(`${base}/api/database-connections/${id}/probe`, { method: "POST", headers });
    expect(checked.status).toBe(200);
    expect(databaseProbeInputs).toHaveLength(2);
    expect(databaseProbeInputs[1]).toMatchObject({ username: "wp_probe", password: "non-deve-tornare-in-risposta" });

    const updated = await fetch(`${base}/api/database-connections/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "Hosting aggiornato", host: "db.example.test", port: 3307, databaseName: "histos_demo", tablePrefix: "wp_demo_", username: "wp_probe_2", password: "nuova-password", caCertificate: "", sshTunnel: { host: "ssh.example.test", port: 22, username: "ssh_probe_2", authMethod: "password", password: "nuova-password-ssh", hostKeyFingerprint: `SHA256:${"A".repeat(43)}` } }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { connection: Record<string, unknown> };
    expect(updatedBody.connection).toMatchObject({ id, name: "Hosting aggiornato" });
    expect(JSON.stringify(updatedBody)).not.toContain("wp_probe_2");
    expect(JSON.stringify(updatedBody)).not.toContain("nuova-password");
    expect(databaseProbeInputs[2]).toMatchObject({ username: "wp_probe_2", password: "nuova-password", sshTunnel: { username: "ssh_probe_2", password: "nuova-password-ssh" } });
    expect(JSON.parse(secrets.get(`database-${id}`) ?? "{}" )).toMatchObject({ username: "wp_probe_2", password: "nuova-password", sshTunnel: { username: "ssh_probe_2", password: "nuova-password-ssh" } });

    databaseProbeFails = true;
    const failedUpdate = await fetch(`${base}/api/database-connections/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "Non salvare", host: "db.example.test", port: 3307, databaseName: "histos_demo", tablePrefix: "wp_demo_", username: "bad_user", password: "bad_password", caCertificate: "" }),
    });
    expect(failedUpdate.status).toBe(401);
    expect(JSON.parse(secrets.get(`database-${id}`) ?? "{}" )).toMatchObject({ username: "wp_probe_2", password: "nuova-password", sshTunnel: { username: "ssh_probe_2", password: "nuova-password-ssh" } });
    const afterFailedUpdate = await fetch(`${base}/api/database-connections`, { headers: { "X-Histos-Token": server.token } });
    expect(await afterFailedUpdate.json()).toMatchObject({ connections: [expect.objectContaining({ id, name: "Hosting aggiornato" })] });
    databaseProbeFails = false;

    const removed = await fetch(`${base}/api/database-connections/${id}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    expect(secrets.size).toBe(0);
    expect(await (await fetch(`${base}/api/database-connections`, { headers: { "X-Histos-Token": server.token } })).json()).toMatchObject({ connections: [] });
  });

  it("non salva una connessione MySQL quando il controllo non riesce", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    databaseProbeFails = true;
    const response = await fetch(`${base}/api/database-connections`, {
      method: "POST",
      headers: { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ name: "DB errato", host: "db.example.test", port: 3306, databaseName: "demo", tablePrefix: "wp_", username: "wp_probe", password: "secret", caCertificate: "" }),
    });
    expect(response.status).toBe(401);
    expect(secrets.size).toBe(0);
    expect(await (await fetch(`${base}/api/database-connections`, { headers: { "X-Histos-Token": server.token } })).json()).toMatchObject({ connections: [] });
  });

  it("ispeziona la cartella hosting salvata senza esporre o modificare le credenziali", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Sito per preflight", source: { kind: "directory", path: dataDirectory } }),
    });
    expect(created.status).toBe(201);
    const { site } = await created.json() as { site: { id: string } };
    const saved = await fetch(`${base}/api/sites/${site.id}/hosting`, {
      method: "POST",
      headers,
      body: JSON.stringify({ settings: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/demo", publicUrl: "https://demo.example.test" }, username: "ftp_user_private", password: "ftp_password_private" }),
    });
    expect(saved.status).toBe(200);
    const result = await fetch(`${base}/api/sites/${site.id}/hosting/inspect`, { method: "POST", headers });
    expect(result.status).toBe(200);
    const responseText = await result.text();
    expect(JSON.parse(responseText)).toEqual({ directory: { entryCount: 0, isEmpty: true, wordpressSignals: [], remoteFiles: [], remoteInventoryComplete: true } });
    expect(responseText).not.toContain("ftp_user_private");
    expect(responseText).not.toContain("ftp_password_private");
    expect(hostingDirectoryInputs[0]).toMatchObject({
      settings: { protocol: "ftps", remoteDirectory: "/public_html/demo" },
      credentials: { username: "ftp_user_private", password: "ftp_password_private" },
    });

    hostingDirectoryResult = { entryCount: 2, isEmpty: false, wordpressSignals: ["wp-admin", "wp-config.php"], remoteFiles: [], remoteInventoryComplete: true };
    const occupied = await fetch(`${base}/api/sites/${site.id}/hosting/inspect`, { method: "POST", headers });
    expect(await occupied.json()).toEqual({ directory: { entryCount: 2, isEmpty: false, wordpressSignals: ["wp-admin", "wp-config.php"], remoteFiles: [], remoteInventoryComplete: true } });
  });

  it("prepara il preflight WordPress solo se file, database, versione e permessi sono compatibili", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Target WordPress", source: { kind: "directory", path: dataDirectory } }),
    });
    const { site } = await created.json() as { site: { id: string } };
    const hostingSaved = await fetch(`${base}/api/sites/${site.id}/hosting`, {
      method: "POST",
      headers,
      body: JSON.stringify({ settings: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/wp-target", publicUrl: "https://wp.example.test" }, username: "ftp_user_private", password: "ftp_password_private" }),
    });
    expect(hostingSaved.status).toBe(200);
    const databaseSaved = await fetch(`${base}/api/database-connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Database vuoto", host: "db.example.test", port: 3306, databaseName: "wp_target", tablePrefix: "wp_", username: "db_user_private", password: "db_password_private", caCertificate: "" }),
    });
    expect(databaseSaved.status).toBe(201);
    const { connection } = await databaseSaved.json() as { connection: { id: string } };
    const completeDatabaseProbeResult = { ...databaseProbeResult };

    const result = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-preflight`, {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseConnectionId: connection.id }),
    });
    expect(result.status).toBe(200);
    const responseText = await result.text();
    expect(JSON.parse(responseText)).toMatchObject({
      status: "awaiting-php-check",
      canInstall: false,
      filesystem: { readable: true, empty: true, entryCount: 0 },
      database: { empty: true, versionSupported: true, privilegesVerified: true, missingPrivileges: [] },
      runtime: { phpChecked: false, httpsAvailable: false, httpsConfigured: true, wordpressMinimumPhp: ">= 7.4", requiredPhp: ">= 8.3", recommendedPhp: ">= 8.4", status: "not-checked" },
    });
    expect(responseText).not.toContain("ftp_password_private");
    expect(responseText).not.toContain("db_password_private");

    databaseProbeResult = { ...completeDatabaseProbeResult, missingPrivileges: ["DROP"] };
    const incompletePrivileges = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-preflight`, {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseConnectionId: connection.id }),
    });
    expect(incompletePrivileges.status).toBe(200);
    expect(await incompletePrivileges.json()).toMatchObject({
      status: "blocked",
      canInstall: false,
      database: { privilegesVerified: true, missingPrivileges: ["DROP"] },
    });
    expect(wordpressRuntimeProbeInputs).toHaveLength(0);
    databaseProbeResult = completeDatabaseProbeResult;
    expect(databaseProbeInputs).toHaveLength(3);
    expect(databaseProbeInputs[2]).toMatchObject({ username: "db_user_private", password: "db_password_private" });

    const runtime = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-runtime-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseConnectionId: connection.id }),
    });
    expect(runtime.status).toBe(200);
    const runtimeText = await runtime.text();
    expect(JSON.parse(runtimeText)).toMatchObject({
      status: "ready-for-install",
      canInstall: false,
      runtime: { phpChecked: true, phpVersion: "8.3.10", phpSupported: true, phpRecommended: false, missingRequiredExtensions: [], missingRecommendedExtensions: [], databaseTlsVerified: true, databaseTlsFailure: null, httpsAvailable: true, httpsConfigured: true, wordpressMinimumPhp: ">= 7.4", requiredPhp: ">= 8.3", recommendedPhp: ">= 8.4", status: "supported" },
    });
    expect(runtimeText).not.toContain("ftp_password_private");
    expect(runtimeText).not.toContain("db_password_private");
    expect(wordpressRuntimeProbeInputs).toHaveLength(1);
    expect(wordpressRuntimeProbeInputs[0]).toMatchObject({
      settings: { protocol: "ftps", publicUrl: "https://wp.example.test" },
      credentials: { username: "ftp_user_private", password: "ftp_password_private" },
      database: { host: "db.example.test", port: 3306, databaseName: "wp_target", username: "db_user_private", password: "db_password_private" },
    });
    expect(databaseProbeInputs).toHaveLength(4);

    databaseProbeResult = { ...databaseProbeResult, tableCount: 4, prefixTableCount: 2 };
    hostingDirectoryResult = { entryCount: 3, isEmpty: false, wordpressSignals: ["wp-admin", "wp-config.php"], remoteFiles: [], remoteInventoryComplete: true };
    const blocked = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-preflight`, {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseConnectionId: connection.id }),
    });
    expect(await blocked.json()).toMatchObject({
      status: "blocked",
      canInstall: false,
      filesystem: { empty: false, entryCount: 3, wordpressSignals: ["wp-admin", "wp-config.php"] },
      database: { empty: false, tableCount: 4, prefixTableCount: 2 },
    });
    const blockedRuntime = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-runtime-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ databaseConnectionId: connection.id }),
    });
    expect(await blockedRuntime.json()).toMatchObject({ status: "blocked", canInstall: false, runtime: { phpChecked: false, status: "not-checked" } });
    expect(wordpressRuntimeProbeInputs).toHaveLength(1);
  });

  it("prepara e applica un piano WordPress+Histeon senza esporre password e si arresta in modo idempotente", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ name: "Nuovo WordPress", source: { kind: "directory", path: dataDirectory } }) });
    expect(created.status).toBe(201);
    const { site } = await created.json() as { site: { id: string } };
    const hosting = await fetch(`${base}/api/sites/${site.id}/hosting`, {
      method: "POST", headers,
      body: JSON.stringify({ settings: { protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/wp-target", publicUrl: "https://wp.example.test" }, username: "ftp_provision_user", password: "ftp_provision_password" }),
    });
    expect(hosting.status).toBe(200);
    const databaseResponse = await fetch(`${base}/api/database-connections`, {
      method: "POST", headers,
      body: JSON.stringify({ name: "Nuovo DB", host: "db.example.test", port: 3306, databaseName: "wp_target", tablePrefix: "wp_demo_", username: "db_provision_user", password: "db_provision_password", caCertificate: "", sshTunnel: { host: "ssh.example.test", port: 22, username: "ssh_provision_user", authMethod: "password", password: "ssh_provision_password", hostKeyFingerprint: `SHA256:${"A".repeat(43)}` } }),
    });
    expect(databaseResponse.status).toBe(201);
    const { connection } = await databaseResponse.json() as { connection: { id: string } };
    expect(secrets.get(`database-${connection.id}`)).toContain("ssh_provision_password");
    expect(JSON.stringify(await (await fetch(`${base}/api/database-connections`, { headers: { "X-Histos-Token": server.token } })).json())).not.toContain("ssh_provision_password");
    const preflight = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-runtime-check`, { method: "POST", headers, body: JSON.stringify({ databaseConnectionId: connection.id }) });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({ status: "ready-for-install" });
    expect(wordpressRuntimeProbeInputs[0]?.database).toMatchObject({ host: "db.example.test", username: "db_provision_user", password: "db_provision_password" });
    expect(wordpressRuntimeProbeInputs[0]?.database).not.toHaveProperty("sshTunnel");
    expect(JSON.stringify(wordpressRuntimeProbeInputs[0]?.database)).not.toContain("ssh_provision_password");

    const input = { databaseConnectionId: connection.id, siteTitle: "Il mio sito", adminUsername: "site-admin", adminEmail: "admin@example.test", adminPassword: "password-admin-lunga-e-segreta" };
    const prepared = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-install`, { method: "POST", headers, body: JSON.stringify(input) });
    expect(prepared.status).toBe(201);
    const preparedText = await prepared.text();
    const { plan } = JSON.parse(preparedText) as { plan: { id: string; state: string; target: { remoteDirectory: string }; database: { databaseName: string }; wordpress: { version: string }; histos: { version: string } } };
    expect(plan).toMatchObject({ state: "planned", target: { remoteDirectory: "/public_html/wp-target" }, database: { databaseName: "wp_target" }, wordpress: { version: "7.1.3" }, histos: { version: "0.3.1" } });
    expect(preparedText).not.toContain(input.adminPassword);
    expect(preparedText).not.toContain("ftp_provision_password");
    expect(preparedText).not.toContain("db_provision_password");
    expect(provisionUploadedFiles).toHaveLength(0);
    expect(secrets.get(`wordpress-provision-${plan.id}`)).toContain(input.adminPassword);

    const listed = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-install`, { headers: { "X-Histos-Token": server.token } });
    expect(await listed.json()).toMatchObject({ plans: [expect.objectContaining({ id: plan.id, state: "planned" })] });
    const installed = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-install/${plan.id}/apply`, { method: "POST", headers, body: "{}" });
    expect(installed.status).toBe(200);
    const installedBody = await installed.json() as { plan: { id: string; state: string; result: { wordpressVersion: string; histosVersion: string; siteUrl: string; connectionId: string } } };
    expect(installedBody.plan).toMatchObject({ id: plan.id, state: "complete", result: { wordpressVersion: "7.1.3", histosVersion: "0.3.1", siteUrl: "https://wp.example.test" } });
    expect(provisionUploadedFiles).toHaveLength(1);
    expect(provisionUploadedFiles[0]?.map((file) => file.path)).toContain("wp-content/plugins/xb/xb.php");
    expect(provisionUploadedFiles[0]?.map((file) => file.path)).toContain("wp-content/db.php");
    // The guard goes up first: WordPress stays closed until the bootstrap writes the real configuration.
    expect(provisionUploadedFiles[0]?.[0]?.path).toBe("wp-config.php");
    expect(provisionUploadedFiles[0]?.[0]?.bytes.toString("utf8")).toContain("histos-publish-provisioning-placeholder:");
    expect(provisionTemporaryFiles).toHaveLength(1);
    expect(provisionTemporaryFiles[0]).toMatch(/^histos-provision-[a-f0-9]{32}\.php$/u);
    expect(provisionConnectionIds).toEqual([installedBody.plan.result.connectionId]);
    expect(provisionBootstrapPayloads).toHaveLength(1);
    expect(provisionBootstrapPayloads[0]?.database).toMatchObject({ host: "db.example.test", username: "db_provision_user", password: "db_provision_password" });
    expect(provisionBootstrapPayloads[0]?.database).not.toHaveProperty("sshTunnel");
    expect(JSON.stringify(provisionBootstrapPayloads[0])).not.toContain("ssh_provision_password");
    expect(secrets.has(`wordpress-provision-${plan.id}`)).toBe(false);
    expect([...secrets.values()].some((value) => value.includes(input.adminPassword))).toBe(false);

    const replay = await fetch(`${base}/api/sites/${site.id}/hosting/wordpress-install/${plan.id}/apply`, { method: "POST", headers, body: "{}" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ plan: { id: plan.id, state: "complete" } });
    expect(provisionUploadedFiles).toHaveLength(1);
    expect(provisionConnectionIds).toHaveLength(1);
  });

  it("non ispeziona cartelle senza una destinazione hosting già verificata", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Senza hosting", source: { kind: "directory", path: dataDirectory } }),
    });
    const { site } = await created.json() as { site: { id: string } };
    const result = await fetch(`${base}/api/sites/${site.id}/hosting/inspect`, { method: "POST", headers });
    expect(result.status).toBe(409);
    expect(hostingDirectoryInputs).toHaveLength(0);
  });

  it("serve la UI locale senza CORS e mostra il consenso prima dell’accesso remoto", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const response = await fetch(`${base}/api/detect`, {
      method: "POST",
      headers: { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ input: "https://example.test" }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({ needsConsent: true, origin: "https://example.test" });
    expect(result.networkRequested).toBeUndefined();
  });

  it("salva la chiave Turnstile nel portachiavi e non la restituisce alle API", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Demo form",
        source: { kind: "directory", path: dataDirectory },
        cloudflare: { accountId: "a".repeat(32), script: "demo-form" },
      }),
    });
    expect(created.status).toBe(201);
    const { site } = await created.json() as { site: { id: string } };
    const config = await fetch(`${base}/api/sites/${site.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ forms: { wordpress: { restUrl: "https://wp.example.test/wp-json/", fluentFormIds: [123], turnstileSiteKey: "public-site-key" } } }),
    });
    expect(config.status).toBe(200);
    const secret = "synthetic-turnstile-secret-123456";
    const saved = await fetch(`${base}/api/sites/${site.id}/turnstile-secret`, { method: "POST", headers, body: JSON.stringify({ secret }) });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ configured: true });
    expect(secrets.get("turnstile-demo-form")).toBe(secret);
    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { "X-Histos-Token": server.token } });
    const body = await bootstrap.text();
    expect(body).toContain('"turnstileSecretConfigured":true');
    expect(body).toContain("public-site-key");
    expect(body).not.toContain(secret);
  });
});
