import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalSshTunnelServer } from "./fixtures/local-ssh-tunnel-server.mjs";
import { createTestNetwork } from "./fixtures/docker-test-network.mjs";

const image = "mariadb:11.4";
const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "histos-db-probe-container-"));
const tlsDirectory = path.join(tempRoot, "tls");
const network = `histos-db-probe-${suffix}`;
const container = `histos-db-probe-db-${suffix}`;
const databaseName = `histos_probe_${randomBytes(4).toString("hex")}`;
const username = `histos_probe_${randomBytes(4).toString("hex")}`;
const password = `probe-${randomBytes(24).toString("hex")}`;
const rootPassword = `root-${randomBytes(24).toString("hex")}`;
const prefix = "histos_probe_";
let proxy;
let sshServer;
let networkCreated = false;
let containerCreated = false;
const proxySockets = new Set();

function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 }).trim();
  } catch {
    throw new Error(`Test probe database non riuscito nella fase: ${label}.`);
  }
}

function docker(args, label) {
  return run("docker", args, label);
}

function openssl(args, label) {
  return run("openssl", args, label);
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", container, "mariadb-admin", "--protocol=tcp", "-h", "127.0.0.1", "ping", "-u", "root", `-p${rootPassword}`], "avvio MariaDB locale");
      return;
    } catch {
      try {
        if (docker(["inspect", "--format", "{{.State.Running}}", container], "controllo MariaDB locale") !== "true") throw new Error("stopped");
      } catch {
        throw new Error("MariaDB usa-e-getta è uscito durante l’avvio.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("MariaDB usa-e-getta non è diventato pronto entro 60 secondi.");
}

try {
  const imageId = docker(["image", "inspect", image, "--format", "{{.Id}}"], "verifica immagine locale");
  await chmod(tempRoot, 0o700);
  await mkdir(tlsDirectory, { mode: 0o755 });

  const caKey = path.join(tlsDirectory, "ca-key.pem");
  const caCertificatePath = path.join(tlsDirectory, "ca.pem");
  const serverKey = path.join(tlsDirectory, "server-key.pem");
  const serverRequest = path.join(tlsDirectory, "server.csr");
  const serverCertificatePath = path.join(tlsDirectory, "server-cert.pem");
  const serverExtensions = path.join(tlsDirectory, "server.ext");
  const caSerial = path.join(tlsDirectory, "ca.srl");
  const badCaKey = path.join(tlsDirectory, "bad-ca-key.pem");
  const badCaCertificatePath = path.join(tlsDirectory, "bad-ca.pem");

  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCertificatePath, "-days", "2", "-subj", "/CN=Histeon Publish disposable probe CA"], "creazione CA");
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverRequest, "-subj", "/CN=127.0.0.1"], "creazione certificato MariaDB");
  await chmod(serverKey, 0o644);
  await writeFile(serverExtensions, "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  openssl(["x509", "-req", "-in", serverRequest, "-CA", caCertificatePath, "-CAkey", caKey, "-CAcreateserial", "-CAserial", caSerial, "-out", serverCertificatePath, "-days", "2", "-extfile", serverExtensions], "firma certificato MariaDB");
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", badCaKey, "-out", badCaCertificatePath, "-days", "2", "-subj", "/CN=Histeon Publish unrelated probe CA"], "creazione CA non attendibile");

  createTestNetwork((subnet) => docker(["network", "create", ...subnet, "--internal", network, "--label", "com.histospublish.local-test=database-probe"], "creazione rete isolata"));
  networkCreated = true;
  docker([
    "run", "-d", "--name", container, "--label", "com.histospublish.local-test=database-probe", "--label", `com.histospublish.local-test-id=${suffix}`,
    "--network", network,
    "-e", `MARIADB_ROOT_PASSWORD=${rootPassword}`, "-e", `MARIADB_DATABASE=${databaseName}`,
    "-e", `MARIADB_USER=${username}`, "-e", `MARIADB_PASSWORD=${password}`,
    "--mount", `type=bind,src=${tlsDirectory},dst=/tls,readonly`, image,
    "--ssl-ca=/tls/ca.pem", "--ssl-cert=/tls/server-cert.pem", "--ssl-key=/tls/server-key.pem", "--require-secure-transport=ON",
  ], "avvio MariaDB TLS isolato");
  containerCreated = true;
  await waitForDatabase();
  docker([
    "exec", container, "mariadb", "--batch", "--skip-column-names", "-u", "root", `-p${rootPassword}`,
    databaseName, "--execute", `CREATE TABLE ${prefix}existing (id INT NOT NULL PRIMARY KEY)`,
  ], "creazione fixture preesistente");

  const networkAddresses = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container], "indirizzo MariaDB isolato"));
  const databaseAddress = networkAddresses?.[network]?.IPAddress;
  if (!databaseAddress) throw new Error("Docker non ha assegnato un indirizzo alla rete interna MariaDB.");
  proxy = createServer((client) => {
    const upstream = createConnection({ host: databaseAddress, port: 3306 });
    proxySockets.add(client);
    proxySockets.add(upstream);
    client.once("close", () => proxySockets.delete(client));
    upstream.once("close", () => proxySockets.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const port = proxy.address().port;
  sshServer = await startLocalSshTunnelServer({ forwardPort: port });

  const env = {
    ...process.env,
    HISTOS_PUBLISH_TEST_DB_HOST: "127.0.0.1",
    HISTOS_PUBLISH_TEST_DB_PORT: port,
    HISTOS_PUBLISH_TEST_DB_NAME: databaseName,
    HISTOS_PUBLISH_TEST_DB_PREFIX: prefix,
    HISTOS_PUBLISH_TEST_DB_USER: username,
    HISTOS_PUBLISH_TEST_DB_PASSWORD: password,
    HISTOS_PUBLISH_TEST_DB_CA_FILE: caCertificatePath,
    HISTOS_PUBLISH_TEST_DB_BAD_CA_FILE: badCaCertificatePath,
    HISTOS_PUBLISH_TEST_SSH_HOST: sshServer.host,
    HISTOS_PUBLISH_TEST_SSH_PORT: String(sshServer.port),
    HISTOS_PUBLISH_TEST_SSH_USER: sshServer.username,
    HISTOS_PUBLISH_TEST_SSH_PASSWORD: sshServer.password,
    HISTOS_PUBLISH_TEST_SSH_PRIVATE_KEY: sshServer.privateKey,
    HISTOS_PUBLISH_TEST_SSH_PASSPHRASE: sshServer.passphrase,
    HISTOS_PUBLISH_TEST_SSH_FINGERPRINT: sshServer.hostKeyFingerprint,
  };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "test-database-probe-local.mjs")], { cwd: process.cwd(), env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) throw new Error(`Il test del probe database è terminato con codice ${result.code ?? result.signal ?? "non disponibile"}.`);
  const preservedTable = docker([
    "exec", container, "mariadb", "--batch", "--skip-column-names", "-u", "root", `-p${rootPassword}`,
    databaseName, "--execute", `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${databaseName}' AND table_name='${prefix}existing' AND table_type='BASE TABLE'`,
  ], "verifica conservazione della tabella");
  if (preservedTable !== "1") throw new Error("Il probe database ha modificato o rimosso la tabella preesistente.");
  console.log("La tabella preesistente è rimasta intatta durante il probe.");
  console.log(`Immagine locale ${image} (${imageId}); rete Docker interna, porta loopback casuale e nessun pull.`);
} finally {
  await sshServer?.close();
  for (const socket of proxySockets) socket.destroy();
  if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
  if (containerCreated) {
    try { docker(["rm", "-f", "-v", container], "pulizia database usa-e-getta"); } catch {}
  }
  if (networkCreated) {
    try { docker(["network", "rm", network], "pulizia rete usa-e-getta"); } catch {}
  }
  await rm(tempRoot, { recursive: true, force: true });
}
