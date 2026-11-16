import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWordPressDatabaseTlsDropIn } from "../packages/server/dist/wordpress-db-tls-dropin.js";
import { buildWordPressConfigPlaceholder, buildWordPressProvisionBootstrap, parseWordPressProvisionBootstrapResponse } from "../packages/server/dist/wordpress-provisioner.js";
import { readVerifiedHistosPluginRelease } from "../packages/server/dist/wordpress-provision-artifacts.js";
import { createTestNetwork } from "./fixtures/docker-test-network.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "histos-publish-wp-provision-"));
const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
const network = `histos-publish-wpinstall-${suffix}`;
const databaseContainer = `histos-publish-wpinstall-db-${suffix}`;
const wordpressContainer = `histos-publish-wpinstall-wp-${suffix}`;
const wordpressImage = process.env.HISTOS_WP_TEST_IMAGE?.trim() || "wordpress:php8.3-apache";
const databaseImage = process.env.HISTOS_WP_TEST_DATABASE_IMAGE?.trim() || "mariadb:11.4";
const databaseName = "histos_provision_test";
const databaseUser = "histos_provision_test";
const databasePassword = `local-test-${randomBytes(24).toString("hex")}`;
const rootPassword = `local-root-${randomBytes(24).toString("hex")}`;
const planId = randomUUID();
const endpoint = `histos-provision-${randomUUID().replaceAll("-", "")}.php`;
const installNonce = randomBytes(32).toString("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 }).trim();
  } catch {
    throw new Error(`La prova locale WordPress/Histos non è riuscita nella fase «${label}».`);
  }
}
const docker = (args, label) => run("docker", args, label);
const openssl = (args, label) => run("openssl", args, label);

async function waitForDatabase() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", databaseContainer, "mariadb-admin", "--protocol=tcp", "-h", "127.0.0.1", "ping", "-u", "root", `-p${rootPassword}`], "avvio MariaDB locale");
      return;
    } catch {
      try {
        if (docker(["inspect", "--format", "{{.State.Running}}", databaseContainer], "controllo processo MariaDB") !== "true") throw new Error("stopped");
      } catch { throw new Error("MariaDB usa e getta è uscito durante l’avvio. Controlla il montaggio dei certificati TLS."); }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("MariaDB usa e getta non è diventato pronto entro 60 secondi.");
}

async function waitForHttp(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      await response.arrayBuffer();
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  throw new Error("Apache/PHP usa e getta non è diventato raggiungibile entro 60 secondi.");
}

async function extractHistosPlugin(archivePath, outputDirectory) {
  const release = await readVerifiedHistosPluginRelease(archivePath);
  for (const file of release.files) {
    const destination = path.join(outputDirectory, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, file.bytes, { mode: 0o644, flag: "wx" });
  }
  return release;
}

async function requestJson(baseUrl, fileName, payload) {
  const response = await fetch(`${baseUrl}/${encodeURIComponent(fileName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  try {
    return { response: parseWordPressProvisionBootstrapResponse(response.status, contentType, body, payload.planId, payload.mode), status: response.status, body };
  } catch (error) {
    let diagnostic = body.toString("utf8").slice(0, 1200);
    for (const secret of [payload.nonce, payload.database?.password, payload.admin?.password, ...(payload.salts ?? [])].filter(Boolean)) diagnostic = diagnostic.replaceAll(secret, "[redacted]");
    throw new Error(`Risposta bootstrap locale non valida (HTTP ${response.status} ${response.statusText}, ${contentType}, ${body.length} byte): ${diagnostic || error?.code || "corpo vuoto"}`);
  }
}

try {
  await chmod(tempRoot, 0o700);
  const imageDigest = docker(["image", "inspect", wordpressImage, "--format", "{{index .RepoDigests 0}}"], "identificazione immagine WordPress");

  const tlsDirectory = path.join(tempRoot, "tls");
  const pluginDirectory = path.join(tempRoot, "plugin");
  await mkdir(tlsDirectory, { mode: 0o700 });
  await chmod(tlsDirectory, 0o755);
  await mkdir(pluginDirectory, { mode: 0o755 });
  const caKey = path.join(tlsDirectory, "ca-key.pem");
  const caCert = path.join(tlsDirectory, "ca.pem");
  const serverKey = path.join(tlsDirectory, "server-key.pem");
  const serverCsr = path.join(tlsDirectory, "server.csr");
  const serverCert = path.join(tlsDirectory, "server-cert.pem");
  const serverExt = path.join(tlsDirectory, "server.ext");
  const caSerial = path.join(tlsDirectory, "ca.srl");
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "2", "-subj", "/CN=Histeon Publish disposable provision CA"], "creazione CA locale");
  await chmod(caCert, 0o644);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-subj", "/CN=db.test"], "creazione certificato MariaDB locale");
  await chmod(serverKey, 0o644);
  await writeFile(serverExt, "subjectAltName=DNS:db.test\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  openssl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-CAserial", caSerial, "-out", serverCert, "-days", "2", "-extfile", serverExt], "firma certificato MariaDB locale");

  const caCertificate = await readFile(caCert, "utf8");
  const dbDropIn = path.join(tempRoot, "db.php");
  await writeFile(dbDropIn, buildWordPressDatabaseTlsDropIn(caCertificate), { mode: 0o644 });
  const pluginArchive = path.join(repositoryRoot, "packages/desktop/dist/histos-wordpress-plugin.zip");
  const histos = await extractHistosPlugin(pluginArchive, pluginDirectory);

  createTestNetwork((subnet) => docker(["network", "create", ...subnet, network, "--label", "com.histospublish.local-test=wordpress-provision-bootstrap"], "creazione rete isolata"));
  docker([
    "run", "-d", "--name", databaseContainer, "--label", "com.histospublish.local-test=wordpress-provision-bootstrap",
    "--network", network, "--network-alias", "db.test",
    "-e", `MARIADB_ROOT_PASSWORD=${rootPassword}`, "-e", `MARIADB_DATABASE=${databaseName}`,
    "-e", `MARIADB_USER=${databaseUser}`, "-e", `MARIADB_PASSWORD=${databasePassword}`,
    "--mount", `type=bind,src=${tlsDirectory},dst=/tls,readonly`, databaseImage,
    "--ssl-ca=/tls/ca.pem", "--ssl-cert=/tls/server-cert.pem", "--ssl-key=/tls/server-key.pem", "--require-secure-transport=ON",
  ], "avvio MariaDB TLS isolato");
  await waitForDatabase();

  docker([
    "run", "-d", "--name", wordpressContainer, "--label", "com.histospublish.local-test=wordpress-provision-bootstrap",
    "--network", network, "-p", "127.0.0.1::80", wordpressImage,
  ], "avvio WordPress senza configurazione");
  const portLine = docker(["port", wordpressContainer, "80/tcp"], "porta WordPress locale").split("\n")[0] ?? "";
  const port = /127\.0\.0\.1:(\d+)$/u.exec(portLine)?.[1];
  if (!port) throw new Error("Docker non ha assegnato la porta loopback per WordPress.");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(baseUrl);
  const versionOutput = docker(["exec", wordpressContainer, "php", "-r", "require '/var/www/html/wp-includes/version.php'; echo $wp_version;"], "versione WordPress locale");
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(versionOutput)) throw new Error("L’immagine di prova non contiene una versione WordPress leggibile.");

  const pluginDestination = `${wordpressContainer}:/var/www/html/wp-content/plugins/xb`;
  docker(["cp", pluginDirectory, pluginDestination], "installazione locale dei file Histeon");
  docker(["cp", dbDropIn, `${wordpressContainer}:/var/www/html/wp-content/db.php`], "installazione drop-in TLS");
  docker(["exec", wordpressContainer, "chown", "-R", "www-data:www-data", "/var/www/html/wp-content/plugins/xb", "/var/www/html/wp-content/db.php"], "permessi del runtime locale");
  docker(["exec", wordpressContainer, "test", "-w", "/var/www/html"], "verifica scrittura di wp-config.php");

  // The guard Histeon Publish uploads first: while it stands, no WordPress page can configure or install the site.
  const placeholderPath = path.join(tempRoot, "wp-config-placeholder.php");
  await writeFile(placeholderPath, buildWordPressConfigPlaceholder(planId), { mode: 0o644 });
  docker(["cp", placeholderPath, `${wordpressContainer}:/var/www/html/wp-config.php`], "installazione wp-config.php di guardia");
  for (const page of ["/wp-admin/setup-config.php?step=1", "/wp-admin/install.php", "/"]) {
    const guarded = await fetch(`${baseUrl}${page}`, { redirect: "manual" });
    const text = await guarded.text();
    if (guarded.status < 400 || /name="(?:dbname|uname|pwd|weblog_title|user_name|admin_password)"/iu.test(text)) throw new Error(`${page} è raggiungibile mentre l’installazione è in corso (HTTP ${guarded.status}).`);
  }

  const bootstrap = buildWordPressProvisionBootstrap(planId, installNonce, Math.floor(Date.now() / 1000) + 120, "install");
  const bootstrapSource = bootstrap.toString("utf8");
  if ([databasePassword, databaseUser, "Histeon-Provision-Test-Admin-Password-93!"].some((secret) => bootstrapSource.includes(secret))) throw new Error("Il bootstrap generato contiene credenziali che devono viaggiare solo nel POST.");
  const bootstrapLocalPath = path.join(tempRoot, endpoint);
  await writeFile(bootstrapLocalPath, bootstrap, { mode: 0o644 });
  docker(["cp", bootstrapLocalPath, `${wordpressContainer}:/var/www/html/${endpoint}`], "installazione bootstrap monouso");

  const coreVersion = versionOutput;
  const adminPassword = "Histeon-Provision-Test-Admin-Password-93!";
  const salts = Array.from({ length: 8 }, () => randomBytes(32).toString("hex"));
  const installPayload = {
    mode: "install", planId, nonce: installNonce,
    database: { host: "db.test", port: 3306, databaseName, tablePrefix: "histos_setup_", username: databaseUser, password: databasePassword, caCertificate },
    site: { title: "Histeon provisioning locale", url: "https://demo.example.test" },
    admin: { username: "histos-admin", email: "admin@example.test", password: adminPassword },
    salts,
  };
  const installed = await requestJson(baseUrl, endpoint, installPayload);
  if (installed.response.wordpressVersion !== coreVersion || installed.response.siteUrl !== "https://demo.example.test") throw new Error("Il bootstrap non ha restituito la versione WP o l’URL attesi.");

  const validation = `require '/var/www/html/wp-load.php'; $active = get_option('active_plugins', array()); $user = get_user_by('login', 'histos-admin'); $plan = get_option('_histos_publish_provision_plan_id'); $admin = (int) get_option('_histos_publish_provision_admin_id'); global $wp_version, $wpdb; if (!in_array('xb/xb.php', $active, true) || !$user || !wp_check_password('${adminPassword}', $user->user_pass, $user->ID) || $plan !== '${planId}' || $admin !== (int) $user->ID || $wp_version !== '${coreVersion}') { fwrite(STDERR, 'installed state mismatch'); exit(2); } $cipher = $wpdb->get_row('SHOW STATUS LIKE "Ssl_cipher"', ARRAY_N); if (!is_array($cipher) || empty($cipher[1])) { fwrite(STDERR, 'database TLS inactive'); exit(3); } echo 'PROVISION_INSTALL_OK';`;
  const installCheck = docker(["exec", wordpressContainer, "php", "-r", validation], "verifica installazione WordPress e Histeon");
  if (!installCheck.includes("PROVISION_INSTALL_OK")) throw new Error("La verifica locale non ha confermato l’installazione WordPress e Histeon.");
  const configMode = docker(["exec", wordpressContainer, "stat", "-c", "%a", "/var/www/html/wp-config.php"], "controllo permessi configurazione");
  if (configMode !== "600") throw new Error("wp-config.php non è stato creato con permessi 0600.");
  const remainingCa = docker(["exec", wordpressContainer, "sh", "-lc", "find /tmp -maxdepth 1 -name 'histos-provision-ca-*' -print"], "controllo rimozione CA temporanea");
  if (remainingCa) throw new Error("Il bootstrap non ha rimosso il certificato CA temporaneo.");

  const recoveryEndpoint = `histos-provision-${randomUUID().replaceAll("-", "")}.php`;
  const recoveryNonce = randomBytes(32).toString("hex");
  const recoveryLocalPath = path.join(tempRoot, recoveryEndpoint);
  await writeFile(recoveryLocalPath, buildWordPressProvisionBootstrap(planId, recoveryNonce, Math.floor(Date.now() / 1000) + 120, "recover"), { mode: 0o644 });
  docker(["cp", recoveryLocalPath, `${wordpressContainer}:/var/www/html/${recoveryEndpoint}`], "installazione endpoint locale di recupero");
  const recovered = await requestJson(baseUrl, recoveryEndpoint, { mode: "recover", planId, nonce: recoveryNonce });
  if (recovered.response.wordpressVersion !== coreVersion || recovered.response.siteUrl !== "https://demo.example.test" || !recovered.response.pairingCode.startsWith("histos-cms-1:") || recovered.response.pairingCode === installed.response.pairingCode) throw new Error("Il recupero locale deve emettere un nuovo codice Histeon CMS: il segreto non si mostra due volte.");

  const replay = await fetch(`${baseUrl}/${encodeURIComponent(endpoint)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(installPayload), redirect: "error" });
  const replayPayload = await replay.json().catch(() => null);
  if (replay.status !== 409 || replayPayload?.code !== "installation-already-started") throw new Error("Il bootstrap non ha bloccato un secondo tentativo di installazione.");

  console.log(`Bootstrap WordPress ${coreVersion} + Histeon ${histos.version}: installazione standard, database TLS, wp-config 0600, pairing e recupero superati.`);
  console.log(`Immagine di prova: ${imageDigest}. Nessun sito esterno è stato contattato.`);
} finally {
  for (const container of [wordpressContainer, databaseContainer]) {
    try { docker(["rm", "-f", "-v", container], "pulizia container usa e getta"); } catch {}
  }
  try { docker(["network", "rm", network], "pulizia rete usa e getta"); } catch {}
  await rm(tempRoot, { recursive: true, force: true });
}
