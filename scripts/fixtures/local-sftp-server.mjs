import { createHash, generateKeyPairSync } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  Server,
  utils: { parseKey, sftp: { OPEN_MODE, STATUS_CODE } },
} = require("ssh2");

function attributes(mode, size = 0) {
  const now = Math.floor(Date.now() / 1000);
  return { mode, size, uid: 1000, gid: 1000, atime: now, mtime: now };
}

function createSftpSession(session, state) {
  session.on("sftp", (accept) => {
    const channel = accept();
    channel.on("REALPATH", (id, requestedPath) => {
      if (!state.directories.has(requestedPath)) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      channel.name(id, { filename: requestedPath, longname: requestedPath, attrs: attributes(fsConstants.S_IFDIR | 0o755) });
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
      const names = new Set();
      for (const candidate of state.directories) {
        const relative = path.posix.relative(entry.path, candidate);
        if (relative && !relative.startsWith("../") && !relative.includes("/")) names.add(relative);
      }
      for (const candidate of state.files.keys()) {
        const relative = path.posix.relative(entry.path, candidate);
        if (relative && !relative.startsWith("../") && !relative.includes("/")) names.add(relative);
      }
      channel.name(id, [...names].sort().map((filename) => {
        const fullPath = path.posix.join(entry.path, filename);
        const isDirectory = state.directories.has(fullPath);
        const size = state.files.get(fullPath)?.length ?? 0;
        return {
          filename,
          longname: `${isDirectory ? "d" : "-"}rwxr-xr-x 1 histos histos ${size} ${filename}`,
          attrs: attributes((isDirectory ? fsConstants.S_IFDIR : fsConstants.S_IFREG) | 0o755, size),
        };
      }));
    });
    channel.on("MKDIR", (id, directory) => {
      if (state.directories.has(directory)) return channel.status(id, STATUS_CODE.FAILURE);
      if (!state.directories.has(path.posix.dirname(directory))) return channel.status(id, STATUS_CODE.NO_SUCH_FILE);
      state.directories.add(directory);
      channel.status(id, STATUS_CODE.OK);
    });
    channel.on("STAT", (id, requestedPath) => {
      if (state.directories.has(requestedPath)) return channel.attrs(id, attributes(fsConstants.S_IFDIR | 0o755));
      const content = state.files.get(requestedPath);
      if (content) return channel.attrs(id, attributes(fsConstants.S_IFREG | 0o644, content.length));
      channel.status(id, STATUS_CODE.NO_SUCH_FILE);
    });
    channel.on("OPEN", (id, filename, flags) => {
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
    channel.on("WRITE", (id, handle, offset, chunk) => {
      const entry = state.handles.get(handle.toString("hex"));
      if (!entry || entry.kind !== "file") return channel.status(id, STATUS_CODE.FAILURE);
      const current = state.files.get(entry.path) ?? Buffer.alloc(0);
      const updated = Buffer.alloc(Math.max(current.length, offset + chunk.length));
      current.copy(updated);
      chunk.copy(updated, offset);
      state.files.set(entry.path, updated);
      channel.status(id, STATUS_CODE.OK);
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

/** Starts a loopback-only SFTP server for tests. Credentials and content stay local. */
export async function startLocalSftpServer({ username = "publisher", password = "local-only-password", authorizedPublicKey } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const parsedHostKey = parseKey(privateKey);
  if (parsedHostKey instanceof Error) throw parsedHostKey;
  const fingerprint = `SHA256:${createHash("sha256").update(parsedHostKey.getPublicSSH()).digest("base64").replace(/=+$/u, "")}`;
  const state = {
    directories: new Set(["/", "/public"]),
    files: new Map(),
    handles: new Map(),
    authenticatedUsers: [],
    nextHandle: 1,
  };
  const server = new Server({ hostKeys: [privateKey] }, (connection) => {
    // Intentionally unpinned clients stop during handshake before authentication.
    connection.on("error", (error) => { if (error.code !== 3) throw error; });
    connection.on("authentication", (context) => {
      if (context.username === username && context.method === "password" && context.password === password) {
        state.authenticatedUsers.push(`${context.username}:${context.method}`);
        context.accept();
        return;
      }
      if (authorizedPublicKey && context.username === username && context.method === "publickey") {
        const matches = context.key.algo === authorizedPublicKey.type
          && context.key.data.equals(authorizedPublicKey.getPublicSSH());
        if (matches && !context.signature) return context.accept();
        if (matches && authorizedPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true) {
          state.authenticatedUsers.push(`${context.username}:${context.method}`);
          return context.accept();
        }
      }
      context.reject();
    });
    connection.on("ready", () => connection.on("session", (accept) => createSftpSession(accept(), state)));
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
  return {
    host: "127.0.0.1",
    port,
    fingerprint,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
