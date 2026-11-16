import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection } from "node:net";

const require = createRequire(import.meta.url);
const { Server, utils: { generateKeyPairSync: generateSshKeyPairSync, parseKey } } = require("ssh2");

/** Starts a loopback-only SSH server for database tunnel integration tests. */
export async function startLocalSshTunnelServer({ username = "publisher", password = "local-only-password", forwardPort } = {}) {
  if (!Number.isInteger(forwardPort) || forwardPort < 1 || forwardPort > 65535) {
    throw new TypeError("Il server SSH locale richiede una porta di inoltro valida.");
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const parsedHostKey = parseKey(privateKey);
  if (parsedHostKey instanceof Error) throw parsedHostKey;
  const hostKeyFingerprint = `SHA256:${createHash("sha256").update(parsedHostKey.getPublicSSH()).digest("base64").replace(/=+$/u, "")}`;
  const clientKeyPassphrase = "local-only-db-tunnel-key-passphrase";
  const clientKeyPair = generateSshKeyPairSync("rsa", {
    bits: 2048,
    passphrase: clientKeyPassphrase,
    cipher: "aes256-cbc",
    comment: "histos-publish-db-tunnel-local-test",
  });
  const authorizedPublicKey = parseKey(clientKeyPair.public);
  if (authorizedPublicKey instanceof Error) throw authorizedPublicKey;
  const activeClients = new Set();
  const activeSockets = new Set();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    activeClients.add(client);
    client.on("error", () => {});
    client.once("close", () => activeClients.delete(client));
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === username && context.password === password) context.accept();
      else if (context.method === "publickey" && context.username === username) {
        const matches = context.key.algo === authorizedPublicKey.type && context.key.data.equals(authorizedPublicKey.getPublicSSH());
        if (matches && !context.signature) return context.accept();
        if (matches && authorizedPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true) return context.accept();
        context.reject();
      } else context.reject();
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        if (info.destIP !== "127.0.0.1" || Number(info.destPort) !== forwardPort) {
          reject();
          return;
        }
        const channel = accept();
        const upstream = createConnection({ host: "127.0.0.1", port: forwardPort });
        activeSockets.add(channel);
        activeSockets.add(upstream);
        channel.once("close", () => activeSockets.delete(channel));
        upstream.once("close", () => activeSockets.delete(upstream));
        channel.on("error", () => upstream.destroy());
        upstream.on("error", () => channel.destroy());
        channel.pipe(upstream);
        upstream.pipe(channel);
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Il server SSH locale non ha ottenuto una porta loopback.");

  return {
    host: "127.0.0.1",
    port: address.port,
    username,
    password,
    privateKey: clientKeyPair.private,
    passphrase: clientKeyPassphrase,
    hostKeyFingerprint,
    async close() {
      for (const socket of activeSockets) socket.destroy();
      for (const client of activeClients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
