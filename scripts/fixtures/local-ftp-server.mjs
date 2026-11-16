import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

function normalizeRemotePath(currentDirectory, candidate) {
  const combined = candidate.startsWith("/") ? candidate : path.posix.join(currentDirectory, candidate);
  const normalized = path.posix.normalize(combined);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/** Starts a small FTP protocol server on loopback for transport integration tests. */
export async function startLocalFtpServer({ username = "publisher", password = "local-only-password", secure = false, host = "127.0.0.1" } = {}) {
  if (!/^127(?:\.\d{1,3}){3}$/u.test(host)) throw new Error("Local FTP tests may bind only to IPv4 loopback.");
  const tlsContext = secure ? createSecureContext({
    key: await readFile(new URL("./certs/ftps-test-key.pem", import.meta.url)),
    cert: await readFile(new URL("./certs/ftps-test-cert.pem", import.meta.url)),
  }) : undefined;
  const state = {
    directories: new Set(["/"]),
    files: new Map(),
    authenticatedUsers: [],
    commands: [],
    failNextUploadAfterWrite: false,
  };
  const controlSockets = new Set();
  const server = createServer((rawControlSocket) => {
    let controlSocket = rawControlSocket;
    controlSockets.add(rawControlSocket);
    // A client may reset a connection (common on Windows and during TLS shutdown): the fixture drops that socket
    // instead of crashing the whole test process with an unhandled 'error' event.
    rawControlSocket.on("error", () => rawControlSocket.destroy());
    let buffer = "";
    let currentDirectory = "/";
    let passiveServer;
    let pendingDataSocket;
    let pendingUpload;
    let pendingDownload;
    let pendingListing;
    let protectedData = false;

    async function closePassiveServer() {
      const active = passiveServer;
      passiveServer = undefined;
      pendingDataSocket?.destroy();
      pendingDataSocket = undefined;
      if (active?.listening) await new Promise((resolve) => active.close(() => resolve()));
    }

    function finishUpload(dataSocket, filename) {
      const chunks = [];
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        state.files.set(normalizeRemotePath(currentDirectory, filename), Buffer.concat(chunks));
        if (state.failNextUploadAfterWrite) {
          state.failNextUploadAfterWrite = false;
          controlSocket.write("451 Simulated interruption after writing the file.\r\n");
        } else controlSocket.write("226 Transfer complete.\r\n");
      };
      dataSocket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      dataSocket.once("end", complete);
      dataSocket.once("close", complete);
      dataSocket.once("error", () => dataSocket.destroy());
    }

    function finishDownload(dataSocket, filename) {
      const remotePath = normalizeRemotePath(currentDirectory, filename);
      const bytes = state.files.get(remotePath);
      if (!bytes) {
        dataSocket.destroy();
        reply(550, "File unavailable");
        return;
      }
      dataSocket.end(bytes);
      dataSocket.once("finish", () => reply(226, "Transfer complete."));
    }

    function finishListing(dataSocket, directory) {
      const lines = [];
      for (const candidate of state.directories) {
        if (candidate === directory) continue;
        const name = path.posix.relative(directory, candidate);
        if (!name || name.startsWith("../") || name.includes("/")) continue;
        lines.push(`drwxr-xr-x 1 histos histos 0 Jan 01 00:00 ${name}`);
      }
      for (const [candidate, bytes] of state.files) {
        const name = path.posix.relative(directory, candidate);
        if (!name || name.startsWith("../") || name.includes("/")) continue;
        lines.push(`-rw-r--r-- 1 histos histos ${bytes.length} Jan 01 00:00 ${name}`);
      }
      dataSocket.end(lines.length ? `${lines.join("\r\n")}\r\n` : "");
      dataSocket.once("finish", () => reply(226, "Transfer complete."));
    }

    function reply(code, message) {
      if (!controlSocket.destroyed) controlSocket.write(`${code} ${message}\r\n`);
    }

    async function command(line) {
      const separator = line.indexOf(" ");
      const verb = (separator === -1 ? line : line.slice(0, separator)).toUpperCase();
      const argument = separator === -1 ? "" : line.slice(separator + 1);
      state.commands.push(verb);

      if (verb === "USER") {
        reply(331, "Password required");
      } else if (verb === "PASS") {
        if (argument !== password) return reply(530, "Login incorrect");
        state.authenticatedUsers.push(username);
        reply(230, "Login successful");
      } else if (verb === "AUTH") {
        if (!secure || argument.toUpperCase() !== "TLS") return reply(502, "TLS is not available");
        reply(234, "Proceed with TLS negotiation");
        rawControlSocket.pause();
        rawControlSocket.off("data", handleControlData);
        controlSocket = new TLSSocket(rawControlSocket, { isServer: true, secureContext: tlsContext });
        controlSocket.on("error", () => rawControlSocket.destroy());
        controlSocket.setEncoding("utf8");
        controlSocket.on("data", handleControlData);
        rawControlSocket.resume();
      } else if (verb === "FEAT") {
        controlSocket.write("211-Features\r\n211 End\r\n");
      } else if (verb === "PBSZ") {
        reply(200, "PBSZ set to 0");
      } else if (verb === "PROT") {
        protectedData = argument.toUpperCase() === "P";
        reply(200, `Protection ${protectedData ? "private" : "clear"}`);
      } else if (verb === "TYPE" || verb === "STRU" || verb === "OPTS") {
        reply(200, "Command okay");
      } else if (verb === "PWD") {
        reply(257, `\"${currentDirectory}\" is the current directory`);
      } else if (verb === "CWD") {
        const destination = normalizeRemotePath(currentDirectory, argument || "/");
        if (!state.directories.has(destination)) return reply(550, "Directory unavailable");
        currentDirectory = destination;
        reply(250, "Directory changed");
      } else if (verb === "MKD") {
        const destination = normalizeRemotePath(currentDirectory, argument);
        if (state.directories.has(destination)) return reply(550, "Directory already exists");
        if (!state.directories.has(path.posix.dirname(destination))) return reply(550, "Parent directory unavailable");
        state.directories.add(destination);
        reply(257, `\"${destination}\" created`);
      } else if (verb === "EPSV") {
        await closePassiveServer();
        passiveServer = createServer((rawDataSocket) => {
          rawDataSocket.on("error", () => rawDataSocket.destroy());
          const dataSocket = secure && protectedData ? new TLSSocket(rawDataSocket, { isServer: true, secureContext: tlsContext }) : rawDataSocket;
          if (dataSocket !== rawDataSocket) dataSocket.on("error", () => rawDataSocket.destroy());
          if (pendingUpload) {
            const filename = pendingUpload;
            pendingUpload = undefined;
            finishUpload(dataSocket, filename);
          } else if (pendingDownload) {
            const filename = pendingDownload;
            pendingDownload = undefined;
            finishDownload(dataSocket, filename);
          } else if (pendingListing) {
            const directory = pendingListing;
            pendingListing = undefined;
            finishListing(dataSocket, directory);
          } else {
            pendingDataSocket?.destroy();
            pendingDataSocket = dataSocket;
          }
        });
        await new Promise((resolve, reject) => {
          passiveServer.once("error", reject);
          passiveServer.listen(0, host, () => {
            passiveServer.off("error", reject);
            resolve();
          });
        });
        const address = passiveServer.address();
        if (!address || typeof address === "string") throw new Error("FTP passive socket has no TCP address.");
        reply(229, `Entering Extended Passive Mode (|||${address.port}|)`);
      } else if (verb === "STOR") {
        if (!pendingDataSocket && !passiveServer) return reply(425, "Use EPSV first");
        reply(150, "Opening data connection");
        if (pendingDataSocket) {
          const dataSocket = pendingDataSocket;
          pendingDataSocket = undefined;
          finishUpload(dataSocket, argument);
        } else pendingUpload = argument;
      } else if (verb === "RETR") {
        if (!pendingDataSocket && !passiveServer) return reply(425, "Use EPSV first");
        const filename = normalizeRemotePath(currentDirectory, argument);
        if (!state.files.has(filename)) return reply(550, "File unavailable");
        reply(150, "Opening data connection");
        if (pendingDataSocket) {
          const dataSocket = pendingDataSocket;
          pendingDataSocket = undefined;
          finishDownload(dataSocket, argument);
        } else pendingDownload = argument;
      } else if (verb === "LIST" || verb === "MLSD") {
        if (!pendingDataSocket && !passiveServer) return reply(425, "Use EPSV first");
        const listArgument = verb === "LIST" ? argument.replace(/^-a\s*/u, "").trim() : argument.trim();
        const directory = normalizeRemotePath(currentDirectory, listArgument || ".");
        if (!state.directories.has(directory)) return reply(550, "Directory unavailable");
        reply(150, "Opening data connection");
        if (pendingDataSocket) {
          const dataSocket = pendingDataSocket;
          pendingDataSocket = undefined;
          finishListing(dataSocket, directory);
        } else pendingListing = directory;
      } else if (verb === "DELE") {
        const filename = normalizeRemotePath(currentDirectory, argument);
        if (!state.files.delete(filename)) return reply(550, "File unavailable");
        reply(250, "File deleted");
      } else if (verb === "QUIT") {
        reply(221, "Goodbye");
        controlSocket.end();
      } else if (verb === "NOOP") {
        reply(200, "Command okay");
      } else {
        reply(502, "Command not implemented");
      }
    }

    controlSocket.write("220 Histeon Publish local FTP test server\r\n");
    function handleControlData(chunk) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let boundary = buffer.indexOf("\r\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        void command(line).catch((error) => {
          reply(451, "Local FTP test error");
          controlSocket.destroy(error);
        });
        boundary = buffer.indexOf("\r\n");
      }
    }
    controlSocket.on("data", handleControlData);
    rawControlSocket.once("close", () => {
      controlSockets.delete(rawControlSocket);
      void closePassiveServer();
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
  return {
    host,
    port,
    state,
    async close() {
      for (const socket of controlSockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
