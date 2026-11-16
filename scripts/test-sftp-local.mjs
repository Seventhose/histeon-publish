import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  Server,
  utils: {
    generateKeyPairSync: generateSshKeyPairSync,
    parseKey,
    sftp: { OPEN_MODE, STATUS_CODE },
  },
} = require("ssh2");
const { fingerprintFromSha256Hex } = await import("../packages/server/dist/sftp-transport.js");
const { captureStaticHostingPreviousFiles, inspectStaticHostingDirectory, parseStaticHostingSettings, publishStaticBundle, restoreStaticHostingBackup, verifyStaticHostingConnection } = await import("../packages/server/dist/static-hosting.js");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const keyPassphrase = "local-only-key-passphrase";
const clientKeys = generateSshKeyPairSync("rsa", {
  bits: 2048,
  passphrase: keyPassphrase,
  cipher: "aes256-cbc",
  comment: "histos-publish-sftp-local-test",
});
const authorizedPublicKey = parseKey(clientKeys.public);
assert(!(authorizedPublicKey instanceof Error), "La chiave pubblica del test deve essere valida.");

const state = {
  directories: new Set(["/", "/public", "/public/site"]),
  files: new Map(),
  handles: new Map(),
  authenticatedUsers: [],
  nextHandle: 1,
  failNextWriteAfterApply: false,
};

function attrs(mode, size = 0) {
  const now = Math.floor(Date.now() / 1000);
  return { mode, size, uid: 1000, gid: 1000, atime: now, mtime: now };
}

function pathEntries(directory) {
  const names = new Set();
  for (const candidate of state.directories) {
    if (candidate === directory) continue;
    const relative = path.posix.relative(directory, candidate);
    if (relative && !relative.startsWith("../") && !relative.includes("/")) names.add(relative);
  }
  for (const candidate of state.files.keys()) {
    const relative = path.posix.relative(directory, candidate);
    if (relative && !relative.startsWith("../") && !relative.includes("/")) names.add(relative);
  }
  return [...names].sort().map((filename) => {
    const fullPath = path.posix.join(directory, filename);
    const isDirectory = state.directories.has(fullPath);
    const size = state.files.get(fullPath)?.length ?? 0;
    return {
      filename,
      longname: `${isDirectory ? "d" : "-"}rwxr-xr-x 1 histos histos ${size} ${filename}`,
      attrs: attrs((isDirectory ? fsConstants.S_IFDIR : fsConstants.S_IFREG) | 0o755, size),
    };
  });
}

function attachSftp(session) {
  session.on("sftp", (accept) => {
    const channel = accept();
    channel.on("REALPATH", (id, requestedPath) => {
      if (!state.directories.has(requestedPath)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      channel.name(id, { filename: requestedPath, longname: requestedPath, attrs: attrs(fsConstants.S_IFDIR | 0o755) });
    });
    channel.on("OPENDIR", (id, directory) => {
      if (!state.directories.has(directory)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(state.nextHandle++);
      state.handles.set(handle.toString("hex"), { kind: "directory", path: directory, read: false });
      channel.handle(id, handle);
    });
    channel.on("READDIR", (id, handle) => {
      const entry = state.handles.get(handle.toString("hex"));
      if (!entry || entry.kind !== "directory") return channel.status(id, STATUS_CODE.FAILURE);
      if (entry.read) return channel.status(id, STATUS_CODE.EOF);
      entry.read = true;
      channel.name(id, pathEntries(entry.path));
    });
    channel.on("MKDIR", (id, directory) => {
      if (state.directories.has(directory)) return channel.status(id, STATUS_CODE.FAILURE);
      const parent = path.posix.dirname(directory);
      if (!state.directories.has(parent)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      state.directories.add(directory);
      channel.status(id, STATUS_CODE.OK);
    });
    const stat = (id, requestedPath) => {
      if (state.directories.has(requestedPath)) return channel.attrs(id, attrs(fsConstants.S_IFDIR | 0o755));
      const content = state.files.get(requestedPath);
      if (content) return channel.attrs(id, attrs(fsConstants.S_IFREG | 0o644, content.length));
      channel.status(id, STATUS_CODE.NO_SUCH_FILE);
    };
    channel.on("STAT", stat);
    channel.on("LSTAT", stat);
    channel.on("OPEN", (id, filename, flags) => {
      if (flags & OPEN_MODE.READ) {
        if (!state.files.has(filename)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
        const handle = Buffer.alloc(4);
        handle.writeUInt32BE(state.nextHandle++);
        state.handles.set(handle.toString("hex"), { kind: "read-file", path: filename });
        return channel.handle(id, handle);
      }
      if (!(flags & OPEN_MODE.WRITE) || !state.directories.has(path.posix.dirname(filename))) {
        return channel.status(id, STATUS_CODE.PERMISSION_DENIED);
      }
      if (flags & OPEN_MODE.TRUNC) state.files.set(filename, Buffer.alloc(0));
      else if (!state.files.has(filename) && !(flags & OPEN_MODE.CREAT)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(state.nextHandle++);
      state.handles.set(handle.toString("hex"), { kind: "file", path: filename });
      channel.handle(id, handle);
    });
    channel.on("READ", (id, handle, offset, length) => {
      const entry = state.handles.get(handle.toString("hex"));
      if (!entry || entry.kind !== "read-file") return channel.status(id, STATUS_CODE.FAILURE);
      const content = state.files.get(entry.path);
      const chunk = content?.subarray(offset, offset + length) ?? Buffer.alloc(0);
      if (!chunk.length) return channel.status(id, STATUS_CODE.EOF);
      channel.data(id, chunk);
    });
    channel.on("WRITE", (id, handle, offset, chunk) => {
      const entry = state.handles.get(handle.toString("hex"));
      if (!entry || entry.kind !== "file") return channel.status(id, STATUS_CODE.FAILURE);
      const current = state.files.get(entry.path) ?? Buffer.alloc(0);
      const updated = Buffer.alloc(Math.max(current.length, offset + chunk.length));
      current.copy(updated);
      chunk.copy(updated, offset);
      state.files.set(entry.path, updated);
      if (state.failNextWriteAfterApply) {
        state.failNextWriteAfterApply = false;
        channel.status(id, STATUS_CODE.FAILURE);
      } else channel.status(id, STATUS_CODE.OK);
    });
    channel.on("CLOSE", (id, handle) => {
      if (!state.handles.delete(handle.toString("hex"))) return channel.status(id, STATUS_CODE.FAILURE);
      channel.status(id, STATUS_CODE.OK);
    });
    channel.on("REMOVE", (id, filename) => {
      if (!state.files.delete(filename)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      channel.status(id, STATUS_CODE.OK);
    });
  });
}

const server = new Server({ hostKeys: [privateKey] }, (connection) => {
  // A client that has not pinned the host key intentionally rejects the
  // handshake before authentication; ssh2 reports that as a connection error.
  connection.on("error", (error) => {
    if (error.code !== 3) throw error;
  });
  connection.on("authentication", (context) => {
    if (context.username === "publisher" && context.method === "password" && context.password === "local-only-password") {
      state.authenticatedUsers.push(`${context.username}:${context.method}`);
      context.accept();
      return;
    }
    if (context.username === "publisher" && context.method === "publickey") {
      const matches = context.key.algo === authorizedPublicKey.type
        && context.key.data.equals(authorizedPublicKey.getPublicSSH());
      if (!matches) return context.reject();
      if (!context.signature) return context.accept();
      if (authorizedPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true) {
        state.authenticatedUsers.push(`${context.username}:${context.method}`);
        return context.accept();
      }
    }
    context.reject();
  });
  connection.on("ready", () => connection.on("session", (accept) => attachSftp(accept())));
});
server.on("error", (error) => { throw error; });

const port = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
try {
  const credentials = { username: "publisher", password: "local-only-password" };
  const unpinned = parseStaticHostingSettings({
    protocol: "sftp",
    host: "127.0.0.1",
    port,
    remoteDirectory: "/public/site",
    username: credentials.username,
  });
  const discovery = await verifyStaticHostingConnection(unpinned, credentials);
  assert.equal(discovery.hostKeyConfirmationRequired, true);
  assert.match(discovery.hostKeyFingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
  assert.deepEqual(state.authenticatedUsers, [], "La lettura dell’impronta non deve autenticarsi.");

  const pinned = parseStaticHostingSettings({ ...unpinned, hostKeyFingerprint: discovery.hostKeyFingerprint });
  assert.deepEqual(await verifyStaticHostingConnection(pinned, credentials), {
    verified: true,
    hostKeyFingerprint: discovery.hostKeyFingerprint,
  });
  assert.equal(state.files.size, 0, "Il file di verifica deve essere rimosso e la rimozione controllata.");

  state.directories.add("/public/site/assets");
  state.files.set("/public/site/index.html", Buffer.from("<!doctype html><h1>Versione precedente</h1>"));
  state.files.set("/public/site/assets/site.css", Buffer.from("h1{color:#654321}"));
  state.files.set("/public/site/solo-remoto.txt", Buffer.from("da conservare"));
  const originalFiles = [
    { path: "index.html", bytes: Buffer.from("<!doctype html><h1>SFTP locale</h1>") },
    { path: "assets/site.css", bytes: Buffer.from("h1{color:#123456}") },
    { path: "assets/nuovo.js", bytes: Buffer.from("console.log('nuovo')") },
  ];
  const remoteBefore = await inspectStaticHostingDirectory(pinned, credentials);
  assert.equal(remoteBefore.remoteInventoryComplete, true);
  const captured = await captureStaticHostingPreviousFiles({
    settings: pinned,
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
  const published = await publishStaticBundle({
    settings: pinned,
    credentials,
    files: originalFiles,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(published, { uploaded: 3, files: 3 });
  assert.equal(state.files.get("/public/site/index.html").toString(), "<!doctype html><h1>SFTP locale</h1>");
  assert.equal(state.files.get("/public/site/assets/site.css").toString(), "h1{color:#123456}");
  assert.equal(state.files.get("/public/site/assets/nuovo.js").toString(), "console.log('nuovo')");
  assert.deepEqual(progress.at(-1), { phase: "upload", completed: 3, total: 3 });

  const backupEntries = captured.map((entry, index) => ({
    ...entry,
    beforeSha256: entry.beforeBytes === null ? null : createHash("sha256").update(entry.beforeBytes).digest("hex"),
    deployedSha256: createHash("sha256").update(originalFiles[index].bytes).digest("hex"),
  }));
  state.files.set("/public/site/index.html", Buffer.from("modifica manuale successiva"));
  await assert.rejects(
    restoreStaticHostingBackup({ settings: pinned, credentials, entries: backupEntries }),
    (error) => error?.code === "cms-hosting-rollback-conflict",
    "Il ripristino deve fermarsi se un file coinvolto è cambiato manualmente.",
  );
  assert.equal(state.files.get("/public/site/assets/site.css").toString(), "h1{color:#123456}", "Il conflitto deve bloccare l’intero ripristino prima di scrivere.");
  state.files.set("/public/site/index.html", originalFiles[0].bytes);
  state.failNextWriteAfterApply = true;
  await assert.rejects(
    restoreStaticHostingBackup({ settings: pinned, credentials, entries: backupEntries }),
    (error) => error?.code === "cms-hosting-rollback-failed",
    "Il test deve interrompere il rollback SFTP dopo la prima scrittura remota.",
  );
  assert.equal(state.files.get("/public/site/index.html").toString(), "<!doctype html><h1>Versione precedente</h1>", "Il server di prova simula una risposta persa dopo aver scritto il file.");
  assert.equal(state.files.get("/public/site/assets/site.css").toString(), "h1{color:#123456}");
  assert.deepEqual(await restoreStaticHostingBackup({ settings: pinned, credentials, entries: backupEntries }), {
    restored: 1,
    removed: 1,
    alreadyRestored: 1,
  });
  assert.equal(state.files.get("/public/site/index.html").toString(), "<!doctype html><h1>Versione precedente</h1>");
  assert.equal(state.files.get("/public/site/assets/site.css").toString(), "h1{color:#654321}");
  assert.equal(state.files.has("/public/site/assets/nuovo.js"), false, "Il rollback deve rimuovere i file creati dal deploy.");
  assert.equal(state.files.get("/public/site/solo-remoto.txt").toString(), "da conservare", "I file estranei alla build devono restare intatti.");

  const wrongPin = parseStaticHostingSettings({
    ...pinned,
    hostKeyFingerprint: fingerprintFromSha256Hex("0".repeat(64)),
  });
  await assert.rejects(verifyStaticHostingConnection(wrongPin, credentials), (error) => error?.code === "hosting-hostkey-changed");
  assert.equal(state.authenticatedUsers.length, 7, "Una chiave host diversa deve bloccare il login.");

  const keySettings = parseStaticHostingSettings({
    ...unpinned,
    remoteDirectory: "/public/key-site",
    authMethod: "privateKey",
    hostKeyFingerprint: discovery.hostKeyFingerprint,
  });
  const keyCredentials = {
    username: "publisher",
    authMethod: "privateKey",
    privateKey: clientKeys.private,
    passphrase: keyPassphrase,
  };
  assert.deepEqual(await verifyStaticHostingConnection(keySettings, keyCredentials), {
    verified: true,
    hostKeyFingerprint: discovery.hostKeyFingerprint,
  });
  const keyPublished = await publishStaticBundle({
    settings: keySettings,
    credentials: keyCredentials,
    files: [{ path: "index.html", bytes: Buffer.from("<!doctype html><h1>Chiave SFTP locale</h1>") }],
  });
  assert.deepEqual(keyPublished, { uploaded: 1, files: 1 });
  assert.equal(state.files.get("/public/key-site/index.html").toString(), "<!doctype html><h1>Chiave SFTP locale</h1>");
  assert.deepEqual(state.authenticatedUsers, [
    "publisher:password",
    "publisher:password",
    "publisher:password",
    "publisher:password",
    "publisher:password",
    "publisher:password",
    "publisher:password",
    "publisher:publickey",
    "publisher:publickey",
  ]);

  process.stdout.write("SFTP locale reale: fingerprint TOFU, password, chiave OpenSSH cifrata, probe puliti, deploy, rollback con hash e rifiuto chiave cambiata superati.\n");
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
