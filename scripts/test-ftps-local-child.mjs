import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startLocalFtpServer } from "./fixtures/local-ftp-server.mjs";

const { captureStaticHostingPreviousFiles, inspectStaticHostingDirectory, parseStaticHostingSettings, publishStaticBundle, restoreStaticHostingBackup, verifyStaticHostingConnection } = await import("../packages/server/dist/static-hosting.js");
const tlsCaCertificate = await readFile(new URL("./fixtures/certs/ftps-test-cert.pem", import.meta.url), "utf8");
const localFtps = await startLocalFtpServer({ secure: true });
let hostnameMismatchFtps;
try {
  hostnameMismatchFtps = await startLocalFtpServer({ secure: true, host: "127.0.0.2" });
  const credentials = { username: "publisher", password: "local-only-password" };
  const untrustedSettings = parseStaticHostingSettings({
    protocol: "ftps",
    host: localFtps.host,
    port: localFtps.port,
    remoteDirectory: "/public/secure-site",
    username: "publisher",
  });
  await assert.rejects(
    verifyStaticHostingConnection(untrustedSettings, credentials),
    (error) => error instanceof Error && /self[- ]signed certificate/u.test(error.message),
    "La verifica FTPS deve rifiutare la CA non fornita dall’utente.",
  );
  assert.deepEqual(localFtps.state.authenticatedUsers, [], "Non inviare credenziali prima che il certificato sia fidato.");

  const settings = parseStaticHostingSettings({
    protocol: "ftps",
    host: localFtps.host,
    port: localFtps.port,
    remoteDirectory: "/public/secure-site",
    username: "publisher",
    tlsCaCertificate,
  });
  const hostnameMismatchSettings = parseStaticHostingSettings({
    protocol: "ftps",
    host: hostnameMismatchFtps.host,
    port: hostnameMismatchFtps.port,
    remoteDirectory: "/public/secure-site",
    username: "publisher",
    tlsCaCertificate,
  });
  await assert.rejects(
    verifyStaticHostingConnection(hostnameMismatchSettings, credentials),
    (error) => error instanceof Error && /IP: 127\.0\.0\.2 is not in the cert's list/u.test(error.message),
    "Una CA fidata non deve autorizzare un certificato valido per un altro host.",
  );
  assert.deepEqual(hostnameMismatchFtps.state.authenticatedUsers, [], "Il controllo hostname deve avvenire prima dell’invio delle credenziali.");
  assert.deepEqual(await verifyStaticHostingConnection(settings, credentials), { verified: true });
  assert.equal(localFtps.state.files.size, 0, "Il probe FTPS temporaneo deve essere rimosso.");
  assert.ok(localFtps.state.commands.includes("AUTH"), "FTPS deve negoziare TLS sul canale di controllo.");
  assert.ok(localFtps.state.commands.includes("PROT"), "FTPS deve cifrare anche il canale dati.");

  localFtps.state.directories.add("/public");
  localFtps.state.directories.add("/public/secure-site");
  localFtps.state.directories.add("/public/secure-site/assets");
  localFtps.state.files.set("/public/secure-site/index.html", Buffer.from("<!doctype html><h1>FTPS precedente</h1>"));
  localFtps.state.files.set("/public/secure-site/solo-remoto.txt", Buffer.from("da conservare"));
  const files = [
    { path: "index.html", bytes: Buffer.from("<!doctype html><h1>FTPS locale</h1>") },
    { path: "assets/site.css", bytes: Buffer.from("h1{color:#123456}") },
  ];
  const remoteBefore = await inspectStaticHostingDirectory(settings, credentials);
  assert.equal(remoteBefore.remoteInventoryComplete, true);
  const captured = await captureStaticHostingPreviousFiles({
    settings,
    credentials,
    files,
    expectedRemoteFiles: remoteBefore.remoteFiles,
    expectedInventoryComplete: remoteBefore.remoteInventoryComplete,
  });
  assert.deepEqual(captured.map((entry) => entry.beforeBytes?.toString() ?? null), ["<!doctype html><h1>FTPS precedente</h1>", null]);

  const result = await publishStaticBundle({
    settings,
    credentials,
    files,
  });
  assert.deepEqual(result, { uploaded: 2, files: 2 });
  assert.equal(localFtps.state.files.get("/public/secure-site/index.html").toString(), "<!doctype html><h1>FTPS locale</h1>");
  const rollbackEntries = captured.map((entry, index) => ({
    ...entry,
    beforeSha256: entry.beforeBytes === null ? null : createHash("sha256").update(entry.beforeBytes).digest("hex"),
    deployedSha256: createHash("sha256").update(files[index].bytes).digest("hex"),
  }));
  localFtps.state.failNextUploadAfterWrite = true;
  await assert.rejects(
    restoreStaticHostingBackup({ settings, credentials, entries: rollbackEntries }),
    (error) => error?.code === "cms-hosting-rollback-failed",
    "Il test deve interrompere il rollback FTPS dopo la prima scrittura remota.",
  );
  assert.deepEqual(await restoreStaticHostingBackup({ settings, credentials, entries: rollbackEntries }), {
    restored: 0,
    removed: 1,
    alreadyRestored: 1,
  });
  assert.equal(localFtps.state.files.get("/public/secure-site/index.html").toString(), "<!doctype html><h1>FTPS precedente</h1>");
  assert.equal(localFtps.state.files.has("/public/secure-site/assets/site.css"), false);
  assert.equal(localFtps.state.files.get("/public/secure-site/solo-remoto.txt").toString(), "da conservare");
  assert.equal(localFtps.state.authenticatedUsers.length, 6);
  process.stdout.write("FTPS locale reale: CA/hostname validati prima del login, canali TLS, backup precedente, deploy, rollback verificato e file estranei conservati.\n");
} finally {
  await localFtps.close();
  await hostnameMismatchFtps?.close();
}
