import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { buildWordPressDatabaseTlsDropIn } from "../packages/server/dist/wordpress-db-tls-dropin.js";
import { createTestNetwork } from "./fixtures/docker-test-network.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "histos-publish-wp-db-tls-"));
const suffix = `${process.pid}-${randomBytes(5).toString("hex")}`;
const network = `histos-publish-wptls-${suffix}`;
const databaseContainer = `histos-publish-wptls-db-${suffix}`;
const wordpressContainer = `histos-publish-wptls-wp-${suffix}`;
const databasePassword = `disposable-${randomBytes(18).toString("hex")}`;
const rootPassword = `disposable-${randomBytes(18).toString("hex")}`;
const databaseName = "wordpress_tls_test";
const databaseUser = "wordpress_tls_test";

function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(`Prova WordPress/MariaDB TLS non riuscita nella fase: ${label}.`);
  }
}

function docker(args, label) {
  return run("docker", args, label);
}

function openssl(args, label) {
  return run("openssl", args, label);
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      docker(["exec", databaseContainer, "mariadb-admin", "--protocol=tcp", "-h", "127.0.0.1", "ping", "-u", "root", `-p${rootPassword}`], "avvio MariaDB");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("MariaDB usa e getta non è diventato pronto entro 45 secondi.");
}

async function waitForWordPress(expectedMarker, phpSource, extraEnv = []) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const output = docker(["exec", ...extraEnv.flatMap(([key, value]) => ["-e", `${key}=${value}`]), wordpressContainer, "php", "-r", phpSource], "avvio e verifica WordPress");
      if (output.includes(expectedMarker)) return output;
      if (output.includes("UNEXPECTED_TLS_ACCEPT")) throw new Error("WordPress ha accettato una connessione TLS non verificata.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("ha accettato")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("WordPress usa e getta non ha completato la verifica TLS attesa.");
}

try {
  const tlsDirectory = path.join(tempRoot, "tls");
  const wpDbDropin = path.join(tempRoot, "db.php");
  await mkdir(tlsDirectory);

  const caKey = path.join(tlsDirectory, "ca-key.pem");
  const caCert = path.join(tlsDirectory, "ca.pem");
  const serverKey = path.join(tlsDirectory, "server-key.pem");
  const serverCsr = path.join(tlsDirectory, "server.csr");
  const serverCert = path.join(tlsDirectory, "server-cert.pem");
  const serverExt = path.join(tlsDirectory, "server.ext");
  const serial = path.join(tlsDirectory, "ca.srl");

  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "2", "-subj", "/CN=Histeon Publish disposable WordPress TLS test CA"], "creazione CA del test");
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-subj", "/CN=db.test"], "creazione certificato MariaDB");
  await chmod(serverKey, 0o644);
  await writeFile(serverExt, "subjectAltName=DNS:db.test\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  openssl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-CAserial", serial, "-out", serverCert, "-days", "2", "-extfile", serverExt], "firma certificato MariaDB");
  const caCertificate = await readFile(caCert, "utf8");
  await writeFile(wpDbDropin, buildWordPressDatabaseTlsDropIn(caCertificate), { mode: 0o644 });

  createTestNetwork((subnet) => docker(["network", "create", ...subnet, network], "creazione rete isolata"));
  docker([
    "run", "-d", "--name", databaseContainer, "--label", "com.histospublish.local-test=wordpress-db-tls",
    "--network", network, "--network-alias", "db.test", "--network-alias", "wrong.test",
    "-e", `MARIADB_ROOT_PASSWORD=${rootPassword}`, "-e", `MARIADB_DATABASE=${databaseName}`,
    "-e", `MARIADB_USER=${databaseUser}`, "-e", `MARIADB_PASSWORD=${databasePassword}`,
    "--mount", `type=bind,src=${tlsDirectory},dst=/tls,readonly`, "mariadb:11.4",
    "--ssl-ca=/tls/ca.pem", "--ssl-cert=/tls/server-cert.pem", "--ssl-key=/tls/server-key.pem", "--require-secure-transport=ON",
  ], "avvio MariaDB isolato");
  await waitForDatabase();

  docker([
    "run", "-d", "--name", wordpressContainer, "--label", "com.histospublish.local-test=wordpress-db-tls",
    "--network", network,
    "-e", "WORDPRESS_DB_HOST=db.test:3306", "-e", `WORDPRESS_DB_NAME=${databaseName}`,
    "-e", `WORDPRESS_DB_USER=${databaseUser}`, "-e", `WORDPRESS_DB_PASSWORD=${databasePassword}`,
    "-e", "WORDPRESS_TABLE_PREFIX=histos_tls_", "--mount", `type=bind,src=${wpDbDropin},dst=/var/www/html/wp-content/db.php,readonly`,
    "wordpress:php8.3-apache",
  ], "avvio WordPress isolato");

  const installPhp = `define('WP_INSTALLING', true); require '/var/www/html/wp-load.php'; require ABSPATH . 'wp-admin/includes/upgrade.php'; add_filter('pre_wp_mail', static function () { return true; }); global $wpdb; if (!($wpdb instanceof HistosPublishVerifiedTlsWpdb)) { fwrite(STDERR, 'unexpected wpdb class'); exit(1); } $installed = wp_install('Histeon Publish TLS Test', 'histos_tls_admin', 'admin@example.test', false, '', 'Disposable-WP-Test-Password-97', 'en_US'); if (empty($installed['user_id']) || !is_blog_installed()) { fwrite(STDERR, 'standard WordPress installation failed'); exit(1); } $wpdb->close(); if (!$wpdb->db_connect()) { fwrite(STDERR, 'verified TLS reconnect failed'); exit(1); } $one = $wpdb->get_var('SELECT 1'); $row = $wpdb->get_row('SHOW STATUS LIKE "Ssl_cipher"', ARRAY_N); if ($one !== '1' || !is_array($row) || empty($row[1])) { fwrite(STDERR, 'verified TLS query failed'); exit(1); } if (glob(sys_get_temp_dir() . '/histos-db-ca-*')) { fwrite(STDERR, 'temporary CA file was not removed'); exit(1); } echo 'WORDPRESS_INSTALL_TLS_OK';`;
  await waitForWordPress("WORDPRESS_INSTALL_TLS_OK", installPhp);
  console.log("WordPress install standarde, query MySQL cifrata, riconnessione TLS e rimozione CA temporanea superati.");

  const rejectPhp = `register_shutdown_function(static function () { echo "TLS_REJECTION_CHECKED"; }); define('SHORTINIT', true); require '/var/www/html/wp-load.php'; echo 'UNEXPECTED_TLS_ACCEPT';`;
  const wrongHostOutput = await waitForWordPress("TLS_REJECTION_CHECKED", rejectPhp, [["WORDPRESS_DB_HOST", "wrong.test:3306"]]);
  if (wrongHostOutput.includes("UNEXPECTED_TLS_ACCEPT")) throw new Error("WordPress ha accettato un certificato con hostname errato.");
  console.log("Il runtime WordPress ha rifiutato un certificato valido per un hostname diverso.");

  const wrongCaKey = path.join(tlsDirectory, "wrong-ca-key.pem");
  const wrongCaCert = path.join(tlsDirectory, "wrong-ca.pem");
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", wrongCaKey, "-out", wrongCaCert, "-days", "2", "-subj", "/CN=Histeon Publish unrelated test CA"], "creazione CA errata");
  const wrongCa = await readFile(wrongCaCert, "utf8");
  await writeFile(wpDbDropin, buildWordPressDatabaseTlsDropIn(wrongCa), { mode: 0o644 });
  const wrongCaOutput = await waitForWordPress("TLS_REJECTION_CHECKED", rejectPhp);
  if (wrongCaOutput.includes("UNEXPECTED_TLS_ACCEPT")) throw new Error("WordPress ha accettato una CA del database non attendibile.");
  console.log("Il runtime WordPress ha rifiutato una CA non attendibile.");

  // Without a CA the drop-in must still authenticate the server, against the system trust store, which does not
  // know this disposable CA: an encrypted but unverified connection is refused.
  await writeFile(wpDbDropin, buildWordPressDatabaseTlsDropIn(""), { mode: 0o644 });
  const noCaOutput = await waitForWordPress("TLS_REJECTION_CHECKED", rejectPhp);
  if (noCaOutput.includes("UNEXPECTED_TLS_ACCEPT")) throw new Error("WordPress ha accettato senza CA un certificato che il sistema non riconosce.");
  console.log("Senza CA il runtime WordPress verifica con le CA di sistema e rifiuta un certificato sconosciuto.");
} finally {
  for (const container of [wordpressContainer, databaseContainer]) {
    try { docker(["rm", "-f", "-v", container], "pulizia container usa e getta"); } catch {}
  }
  try { docker(["network", "rm", network], "pulizia rete usa e getta"); } catch {}
  await rm(tempRoot, { recursive: true, force: true });
}
