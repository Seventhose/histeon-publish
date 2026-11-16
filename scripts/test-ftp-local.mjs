import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalFtpServer } from "./fixtures/local-ftp-server.mjs";

const { captureStaticHostingPreviousFiles, inspectStaticHostingDirectory, parseStaticHostingSettings, publishStaticBundle, restoreStaticHostingBackup, verifyStaticHostingConnection } = await import("../packages/server/dist/static-hosting.js");
const localFtp = await startLocalFtpServer();
try {
  const settings = parseStaticHostingSettings({
    protocol: "ftp",
    host: localFtp.host,
    port: localFtp.port,
    remoteDirectory: "/public/site",
    username: "publisher",
    allowInsecureFtp: true,
  });
  const credentials = { username: "publisher", password: "local-only-password" };

  assert.deepEqual(await verifyStaticHostingConnection(settings, credentials), { verified: true });
  assert.equal(localFtp.state.files.size, 0, "Il file temporaneo di verifica va rimosso dal server FTP.");
  assert.equal(localFtp.state.authenticatedUsers.length, 1, "La verifica FTP deve autenticarsi una volta.");
  assert.ok(localFtp.state.commands.includes("EPSV"), "Il client deve usare un canale dati passivo.");
  assert.ok(localFtp.state.commands.includes("DELE"), "La verifica deve rimuovere il probe caricato.");

  localFtp.state.directories.add("/public");
  localFtp.state.directories.add("/public/site");
  localFtp.state.directories.add("/public/site/assets");
  localFtp.state.files.set("/public/site/index.html", Buffer.from("<!doctype html><h1>Versione precedente</h1>"));
  localFtp.state.files.set("/public/site/assets/site.css", Buffer.from("h1{color:#654321}"));
  localFtp.state.files.set("/public/site/solo-remoto.txt", Buffer.from("da conservare"));

  const originalFiles = [
    { path: "index.html", bytes: Buffer.from("<!doctype html><h1>FTP locale</h1>") },
    { path: "assets/site.css", bytes: Buffer.from("h1{color:#123456}") },
    { path: "assets/nuovo.js", bytes: Buffer.from("console.log('nuovo')") },
  ];
  const remoteBefore = await inspectStaticHostingDirectory(settings, credentials);
  assert.equal(remoteBefore.remoteInventoryComplete, true);
  const captured = await captureStaticHostingPreviousFiles({
    settings,
    credentials,
    files: originalFiles,
    expectedRemoteFiles: remoteBefore.remoteFiles,
    expectedInventoryComplete: remoteBefore.remoteInventoryComplete,
  });
  assert.deepEqual(captured.map((entry) => entry.beforeBytes?.toString() ?? null), [
    "<!doctype html><h1>Versione precedente</h1>",
    "h1{color:#654321}",
    null,
  ]);

  const progress = [];
  const result = await publishStaticBundle({
    settings,
    credentials,
    files: originalFiles,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result, { uploaded: 3, files: 3 });
  assert.equal(localFtp.state.files.get("/public/site/index.html").toString(), "<!doctype html><h1>FTP locale</h1>");
  assert.equal(localFtp.state.files.get("/public/site/assets/site.css").toString(), "h1{color:#123456}");
  assert.equal(localFtp.state.files.get("/public/site/assets/nuovo.js").toString(), "console.log('nuovo')");
  assert.deepEqual(progress.at(-1), { phase: "upload", completed: 3, total: 3 });

  const backupEntries = captured.map((entry, index) => ({
    ...entry,
    beforeSha256: entry.beforeBytes === null ? null : createHash("sha256").update(entry.beforeBytes).digest("hex"),
    deployedSha256: createHash("sha256").update(originalFiles[index].bytes).digest("hex"),
  }));
  localFtp.state.files.set("/public/site/index.html", Buffer.from("modifica manuale successiva"));
  await assert.rejects(
    restoreStaticHostingBackup({ settings, credentials, entries: backupEntries }),
    (error) => error?.code === "cms-hosting-rollback-conflict",
    "Il ripristino deve fermarsi se un file coinvolto è cambiato manualmente.",
  );
  assert.equal(localFtp.state.files.get("/public/site/assets/site.css").toString(), "h1{color:#123456}", "Il conflitto deve bloccare l’intero ripristino prima di scrivere.");
  localFtp.state.files.set("/public/site/index.html", originalFiles[0].bytes);
  localFtp.state.failNextUploadAfterWrite = true;
  await assert.rejects(
    restoreStaticHostingBackup({ settings, credentials, entries: backupEntries }),
    (error) => error?.code === "cms-hosting-rollback-failed",
    "Il test deve interrompere il rollback dopo la prima scrittura remota.",
  );
  assert.equal(localFtp.state.files.get("/public/site/index.html").toString(), "<!doctype html><h1>Versione precedente</h1>", "Il server di prova simula una risposta persa dopo aver scritto il file.");
  assert.equal(localFtp.state.files.get("/public/site/assets/site.css").toString(), "h1{color:#123456}");
  assert.deepEqual(await restoreStaticHostingBackup({ settings, credentials, entries: backupEntries }), {
    restored: 1,
    removed: 1,
    alreadyRestored: 1,
  });
  assert.equal(localFtp.state.files.get("/public/site/index.html").toString(), "<!doctype html><h1>Versione precedente</h1>");
  assert.equal(localFtp.state.files.get("/public/site/assets/site.css").toString(), "h1{color:#654321}");
  assert.equal(localFtp.state.files.has("/public/site/assets/nuovo.js"), false, "Il rollback deve rimuovere i file creati dal deploy.");
  assert.equal(localFtp.state.files.get("/public/site/solo-remoto.txt").toString(), "da conservare", "I file estranei alla build devono restare intatti.");
  assert.ok(localFtp.state.authenticatedUsers.length >= 5);
  process.stdout.write("FTP locale reale: backup dei soli file interessati, conflitto manuale bloccato, ripristino verificato e file remoti estranei conservati.\n");

  const ftpsTest = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "test-ftps-local-child.mjs")], {
    stdio: "inherit",
    timeout: 45_000,
  });
  if (ftpsTest.error) throw ftpsTest.error;
  assert.equal(ftpsTest.status, 0, "L’integrazione FTPS locale con CA esplicita deve passare.");
} finally {
  await localFtp.close();
}
