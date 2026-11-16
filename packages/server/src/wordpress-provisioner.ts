import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";

export type WordPressProvisionState = "planned" | "uploading" | "installing" | "recovering" | "needs-recovery" | "blocked" | "complete" | "expired";

export interface WordPressProvisionSnapshot {
  id: string;
  siteId: string;
  databaseConnectionId: string;
  createdAt: string;
  expiresAt: string;
  siteTitle: string;
  adminUsername: string;
  adminEmail: string;
  locale: "en_US";
  target: {
    protocol: "ftp" | "ftps" | "sftp";
    host: string;
    port: number;
    remoteDirectory: string;
    publicUrl: string;
    username: string;
    allowInsecureFtp?: boolean;
    tlsCaCertificate?: string;
    authMethod?: "password" | "privateKey";
    hostKeyFingerprint?: string;
  };
  database: {
    id: string;
    name: string;
    host: string;
    port: number;
    databaseName: string;
    tablePrefix: string;
    engine: "mysql" | "mariadb";
    serverVersion: string;
  };
  wordpress: {
    version: string;
    phpMinimum: string;
    mysqlMinimum: string;
    archiveSha256: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  histos: {
    version: string;
    wordpressMinimum: string;
    phpMinimum: string;
    archiveSha256: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  databaseDropInSha256: string;
}

export interface WordPressProvisionPlan {
  snapshot: WordPressProvisionSnapshot;
  snapshotSha256: string;
  state: WordPressProvisionState;
  phase: string;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  result: { wordpressVersion: string; histosVersion: string; connectionId: string; siteUrl: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_256 = /^[0-9a-f]{64}$/u;
const HASH = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function parseSnapshot(raw: string, digest: string): WordPressProvisionSnapshot {
  if (HASH(raw) !== digest) throw new HistosPublishError("Il piano di installazione WordPress locale non supera il controllo d’integrità.", "wordpress-provision-plan-corrupt", 500);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new HistosPublishError("Il piano di installazione WordPress locale non è leggibile.", "wordpress-provision-plan-corrupt", 500); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistosPublishError("Il piano di installazione WordPress locale non è valido.", "wordpress-provision-plan-corrupt", 500);
  return value as WordPressProvisionSnapshot;
}

export class WordPressProvisionCatalog {
  private readonly database: DatabaseSync;

  constructor(dataDirectory: string) {
    this.database = new DatabaseSync(path.join(dataDirectory, "histos-wordpress-provision.sqlite"));
    this.database.exec(`CREATE TABLE IF NOT EXISTS wordpress_provision_plans (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error_code TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS wordpress_provision_site_created ON wordpress_provision_plans(site_id, created_at DESC)`);
  }

  close(): void { this.database.close(); }

  create(snapshot: WordPressProvisionSnapshot): WordPressProvisionPlan {
    if (!UUID.test(snapshot.id) || !UUID.test(snapshot.siteId) || !UUID.test(snapshot.databaseConnectionId)) throw new TypeError("Identificativo del piano WordPress non valido.");
    const serialized = JSON.stringify(snapshot);
    const digest = HASH(serialized);
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO wordpress_provision_plans(id, site_id, snapshot_json, snapshot_sha256, state, phase, created_at, updated_at, error_code, result_json) VALUES (?, ?, ?, ?, 'planned', 'ready', ?, ?, NULL, NULL)")
      .run(snapshot.id, snapshot.siteId, serialized, digest, now, now);
    return this.get(snapshot.id)!;
  }

  get(id: string): WordPressProvisionPlan | null {
    const row = this.database.prepare("SELECT * FROM wordpress_provision_plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const snapshot = parseSnapshot(String(row.snapshot_json), String(row.snapshot_sha256));
    let result: WordPressProvisionPlan["result"] = null;
    if (typeof row.result_json === "string") {
      try { result = JSON.parse(row.result_json) as WordPressProvisionPlan["result"]; } catch { throw new HistosPublishError("Il risultato salvato del provisioner non è leggibile.", "wordpress-provision-plan-corrupt", 500); }
    }
    return {
      snapshot,
      snapshotSha256: String(row.snapshot_sha256),
      state: String(row.state) as WordPressProvisionState,
      phase: String(row.phase),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      errorCode: typeof row.error_code === "string" ? row.error_code : null,
      result,
    };
  }

  list(siteId: string): WordPressProvisionPlan[] {
    const rows = this.database.prepare("SELECT id FROM wordpress_provision_plans WHERE site_id = ? ORDER BY created_at DESC LIMIT 20").all(siteId) as Array<{ id: string }>;
    return rows.flatMap(({ id }) => {
      const plan = this.get(id);
      return plan ? [plan] : [];
    });
  }

  claim(id: string): boolean {
    const now = new Date().toISOString();
    return this.database.prepare("UPDATE wordpress_provision_plans SET state = 'uploading', phase = 'upload', updated_at = ?, error_code = NULL WHERE id = ? AND state = 'planned'").run(now, id).changes === 1;
  }

  claimRecovery(id: string, now = new Date()): boolean {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    return this.database.prepare("UPDATE wordpress_provision_plans SET state = 'recovering', phase = 'recovery', updated_at = ?, error_code = NULL WHERE id = ? AND (state IN ('uploading', 'installing', 'needs-recovery') OR (state = 'recovering' AND updated_at <= ?))").run(nowIso, id, staleBefore).changes === 1;
  }

  setState(id: string, state: WordPressProvisionState, phase: string, errorCode: string | null = null, result: WordPressProvisionPlan["result"] = null): void {
    if (!UUID.test(id) || !/^[a-z][a-z0-9-]{0,63}$/u.test(phase) || (errorCode !== null && !/^[a-z][a-z0-9-]{0,80}$/u.test(errorCode))) throw new TypeError("Stato del provisioner non valido.");
    this.database.prepare("UPDATE wordpress_provision_plans SET state = ?, phase = ?, updated_at = ?, error_code = ?, result_json = ? WHERE id = ?")
      .run(state, phase, new Date().toISOString(), errorCode, result === null ? null : JSON.stringify(result), id);
  }

  expirePending(now = new Date()): string[] {
    const nowIso = now.toISOString();
    const rows = this.database.prepare("SELECT id FROM wordpress_provision_plans WHERE state = 'planned' AND json_extract(snapshot_json, '$.expiresAt') <= ?").all(nowIso) as Array<{ id: string }>;
    for (const row of rows) this.setState(row.id, "expired", "expired", "wordpress-provision-plan-expired");
    return rows.map(({ id }) => id);
  }
}

export type WordPressProvisionMode = "install" | "recover";

export function wordpressProvisionConnectionId(planId: string): string {
  if (!UUID.test(planId)) throw new HistosPublishError("Identificativo del piano WordPress non valido.", "wordpress-provision-plan-id-invalid", 400);
  const bytes = createHash("sha256").update(`histos-publish-wordpress-provision:${planId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type WordPressProvisionPost = (url: URL, payload: Record<string, unknown>) => Promise<{ status: number; contentType: string; body: Buffer }>;

export async function postWordPressProvisionJson(url: URL, payload: Record<string, unknown>): Promise<{ status: number; contentType: string; body: Buffer }> {
  const client = new SafeHttpClient({ origin: url.origin, userAgent: "HistosPublish-WordPress-Provision/1.0", timeoutMs: 30_000, delayMs: 0, strictOrigin: true });
  const response = await client.postJson(url, payload, { maxBytes: 16 * 1024 });
  return {
    status: response.status,
    contentType: Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] ?? "" : response.headers["content-type"] ?? "",
    body: response.body,
  };
}

function phpLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\0", "\\0")}'`;
}

/**
 * The wp-config.php uploaded before WordPress itself: every WordPress entry point (setup-config.php, install.php,
 * index.php) loads it and stops, so the core is never configurable by a visitor while it lands, nor after a failed
 * bootstrap. Only this plan's bootstrap replaces it with the real configuration.
 */
export function buildWordPressConfigPlaceholder(planId: string): Buffer {
  if (!UUID.test(planId)) throw new HistosPublishError("I dati temporanei per l’installazione WordPress non sono validi.", "wordpress-provision-bootstrap-invalid", 400);
  return Buffer.from(`<?php
// histos-publish-provisioning-placeholder:${planId}
http_response_code(503);
header('Content-Type: text/plain; charset=utf-8');
header('Retry-After: 300');
echo 'Installazione di WordPress in corso.';
exit;
`, "utf8");
}

export function buildWordPressProvisionBootstrap(planId: string, nonce: string, expiresAt: number, mode: WordPressProvisionMode): Buffer {
  if (!UUID.test(planId) || !/^[a-f0-9]{64}$/u.test(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !["install", "recover"].includes(mode)) {
    throw new HistosPublishError("I dati temporanei per l’installazione WordPress non sono validi.", "wordpress-provision-bootstrap-invalid", 400);
  }
  const nonceHash = HASH(nonce);
  const source = `<?php
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('log_errors', '0');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Content-Type: application/json; charset=utf-8');
const HISTOS_PLAN = ${phpLiteral(planId)};
const HISTOS_NONCE_HASH = '${nonceHash}';
const HISTOS_EXPIRES_AT = ${expiresAt};
const HISTOS_MODE = '${mode}';
const HISTOS_PLACEHOLDER = ${phpLiteral(buildWordPressConfigPlaceholder(planId).toString("utf8"))};
function histos_reply(int $status, string $code, array $extra = []): never {
  http_response_code($status);
  echo json_encode(array_merge(array('probe' => 'histos-wordpress-provision-v1', 'code' => $code), $extra), JSON_UNESCAPED_SLASHES);
  exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') histos_reply(405, 'method-not-allowed');
if (time() > HISTOS_EXPIRES_AT) histos_reply(410, 'bootstrap-expired');
$input = @fopen('php://input', 'rb');
if (!is_resource($input)) histos_reply(400, 'request-body-unavailable');
$raw = stream_get_contents($input, 128 * 1024 + 1);
fclose($input);
if (!is_string($raw) || strlen($raw) > 128 * 1024) histos_reply(413, 'request-too-large');
$payload = json_decode($raw, true);
if (!is_array($payload) || !isset($payload['nonce']) || !is_string($payload['nonce']) || !hash_equals(HISTOS_NONCE_HASH, hash('sha256', $payload['nonce']))) histos_reply(404, 'bootstrap-not-found');
if (($payload['mode'] ?? '') !== HISTOS_MODE || ($payload['planId'] ?? '') !== HISTOS_PLAN) histos_reply(400, 'plan-mismatch');
$lockPath = __DIR__ . '/.histos-publish-provision-' . HISTOS_PLAN . '.lock';
$lock = @fopen($lockPath, 'x');
if (!is_resource($lock)) histos_reply(409, 'operation-in-progress');
@chmod($lockPath, 0600);
register_shutdown_function(static function () use ($lock, $lockPath): void { if (is_resource($lock)) fclose($lock); if (is_file($lockPath)) @unlink($lockPath); });
$configPath = __DIR__ . '/wp-config.php';
$placeholder = is_file($configPath) && hash_equals(HISTOS_PLACEHOLDER, (string) @file_get_contents($configPath));
if (HISTOS_MODE === 'recover') {
  if (!is_file($configPath) || $placeholder) histos_reply(409, 'wordpress-config-not-found');
  require_once __DIR__ . '/wp-load.php';
} elseif (HISTOS_MODE === 'install' && is_file($configPath) && !$placeholder) {
  histos_reply(409, 'installation-already-started');
}
if (HISTOS_MODE === 'recover') {
  if (!function_exists('get_option') || !hash_equals(HISTOS_PLAN, (string) get_option('_histos_publish_provision_plan_id', ''))) histos_reply(409, 'installation-not-owned-by-plan');
  if (!function_exists('is_plugin_active')) require_once ABSPATH . 'wp-admin/includes/plugin.php';
  if (!function_exists('is_plugin_active') || !is_plugin_active('xb/xb.php') || !class_exists('XB\\Remote\\Link')) histos_reply(409, 'histos-plugin-not-ready');
  $userId = (int) get_option('_histos_publish_provision_admin_id', 0);
  if ($userId < 1) histos_reply(409, 'administrator-not-found');
  wp_set_current_user($userId);
  if (!current_user_can('manage_options')) histos_reply(403, 'administrator-capability-missing');
  // A new code on every recovery: the secret is never shown twice, and the previous code stops working.
  $code = \\XB\\Cms\\Link::create('Histeon Publish', true, true, false);
  histos_reply(200, 'recovered', array('planId' => HISTOS_PLAN, 'wordpressVersion' => (string) $GLOBALS['wp_version'], 'pairingCode' => $code, 'siteUrl' => untrailingslashit(home_url())));
}

if (HISTOS_MODE !== 'install' || (file_exists($configPath) && !$placeholder)) histos_reply(409, 'installation-already-started');
$db = $payload['database'] ?? null;
$site = $payload['site'] ?? null;
$salts = $payload['salts'] ?? null;
$admin = $payload['admin'] ?? null;
if (!is_array($db) || !is_array($site) || !is_array($salts) || !is_array($admin)) histos_reply(400, 'installation-input-invalid');
$host = isset($db['host']) && is_string($db['host']) ? $db['host'] : '';
$port = isset($db['port']) && is_int($db['port']) ? $db['port'] : 0;
$databaseName = isset($db['databaseName']) && is_string($db['databaseName']) ? $db['databaseName'] : '';
$databaseUser = isset($db['username']) && is_string($db['username']) ? $db['username'] : '';
$databasePassword = isset($db['password']) && is_string($db['password']) ? $db['password'] : '';
$caCertificate = isset($db['caCertificate']) && is_string($db['caCertificate']) ? $db['caCertificate'] : '';
$tablePrefix = isset($db['tablePrefix']) && is_string($db['tablePrefix']) ? $db['tablePrefix'] : '';
$siteTitle = isset($site['title']) && is_string($site['title']) ? trim($site['title']) : '';
$siteUrl = isset($site['url']) && is_string($site['url']) ? $site['url'] : '';
$adminUsername = isset($admin['username']) && is_string($admin['username']) ? $admin['username'] : '';
$adminEmail = isset($admin['email']) && is_string($admin['email']) ? $admin['email'] : '';
$adminPassword = isset($admin['password']) && is_string($admin['password']) ? $admin['password'] : '';
if ($host === '' || strlen($host) > 253 || preg_match('/^[A-Za-z0-9.:-]+$/', $host) !== 1 || $port < 1 || $port > 65535 || preg_match('/^[A-Za-z0-9_$-]{1,64}$/', $databaseName) !== 1 || preg_match('/^[A-Za-z0-9_]{1,32}$/', $tablePrefix) !== 1) histos_reply(400, 'database-config-invalid');
if ($databaseUser === '' || strlen($databaseUser) > 128 || $databasePassword === '' || strlen($databasePassword) > 4096 || strpos($databaseUser, "\\0") !== false || strpos($databasePassword, "\\0") !== false || strlen($caCertificate) > 64 * 1024) histos_reply(400, 'database-credentials-invalid');
if ($siteTitle === '' || strlen($siteTitle) > 120 || preg_match('/\\p{Cc}/u', $siteTitle) === 1 || filter_var($siteUrl, FILTER_VALIDATE_URL) === false || !str_starts_with($siteUrl, 'https://')) histos_reply(400, 'site-config-invalid');
if (!preg_match('/^[A-Za-z0-9_.-]{1,60}$/', $adminUsername) || filter_var($adminEmail, FILTER_VALIDATE_EMAIL) === false || strlen($adminEmail) > 254 || strlen($adminPassword) < 14 || strlen($adminPassword) > 4096 || strpos($adminPassword, "\\0") !== false) histos_reply(400, 'administrator-config-invalid');
if (count($salts) !== 8) histos_reply(400, 'salts-invalid');
foreach ($salts as $salt) if (!is_string($salt) || !preg_match('/^[a-f0-9]{64}$/', $salt)) histos_reply(400, 'salts-invalid');
if (!extension_loaded('mysqli') || !function_exists('mysqli_ssl_set') || !function_exists('mysqli_get_client_info') || !defined('MYSQLI_CLIENT_SSL') || stripos(mysqli_get_client_info(), 'mysqlnd') !== 0) histos_reply(503, 'database-client-unsupported');
$mysqli = mysqli_init();
if (!$mysqli) histos_reply(503, 'database-client-unsupported');
$caFile = null;
$databaseFailure = null;
$tableCount = null;
try {
  mysqli_report(MYSQLI_REPORT_OFF);
  mysqli_options($mysqli, MYSQLI_OPT_CONNECT_TIMEOUT, 8);
  if ($caCertificate !== '') {
    $caFile = tempnam(sys_get_temp_dir(), 'histos-provision-ca-');
    if ($caFile === false || file_put_contents($caFile, $caCertificate, LOCK_EX) !== strlen($caCertificate)) $databaseFailure = 'database-ca-unavailable';
    else @chmod($caFile, 0600);
  }
  if ($databaseFailure === null) {
    $trustFile = is_string($caFile) && $caFile !== '' ? $caFile : null;
    $trustDir = null;
    if ($trustFile === null) {
      // No CA of its own: mysqlnd verifies the server only when it is given CAs, so give it the system trust store.
      $locations = function_exists('openssl_get_cert_locations') ? openssl_get_cert_locations() : array();
      if (is_array($locations) && is_string($locations['default_cert_file'] ?? null) && is_readable($locations['default_cert_file'])) $trustFile = $locations['default_cert_file'];
      elseif (is_array($locations) && is_string($locations['default_cert_dir'] ?? null) && is_dir($locations['default_cert_dir'])) $trustDir = $locations['default_cert_dir'];
    }
    if ($trustFile === null && $trustDir === null) $databaseFailure = 'database-ca-unavailable';
  }
  if ($databaseFailure === null) {
    mysqli_ssl_set($mysqli, null, null, $trustFile, $trustDir, null);
    $connected = @mysqli_real_connect($mysqli, $host, $databaseUser, $databasePassword, null, $port, null, MYSQLI_CLIENT_SSL);
    if (!$connected) $databaseFailure = 'database-connection-failed';
  }
  if ($databaseFailure === null) {
    $cipherResult = mysqli_query($mysqli, "SHOW STATUS LIKE 'Ssl_cipher'");
    $cipherRow = $cipherResult instanceof mysqli_result ? mysqli_fetch_row($cipherResult) : false;
    if ($cipherResult instanceof mysqli_result) mysqli_free_result($cipherResult);
    if (!is_array($cipherRow) || empty($cipherRow[1])) $databaseFailure = 'database-tls-not-active';
  }
  if ($databaseFailure === null) {
    $statement = mysqli_prepare($mysqli, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'");
    if (!$statement) $databaseFailure = 'database-empty-check-failed';
    else {
      mysqli_stmt_bind_param($statement, 's', $databaseName);
      if (!mysqli_stmt_execute($statement)) $databaseFailure = 'database-empty-check-failed';
      else {
        mysqli_stmt_bind_result($statement, $tableCount);
        if (!mysqli_stmt_fetch($statement)) $databaseFailure = 'database-empty-check-failed';
      }
      mysqli_stmt_close($statement);
      if ($databaseFailure === null && (int) $tableCount !== 0) $databaseFailure = 'database-not-empty';
    }
  }
} catch (Throwable $error) {
  $databaseFailure = 'database-connection-failed';
} finally {
  if ($mysqli instanceof mysqli) @mysqli_close($mysqli);
  if (is_string($caFile) && is_file($caFile)) @unlink($caFile);
}
if ($databaseFailure !== null) histos_reply($databaseFailure === 'database-not-empty' ? 409 : 503, $databaseFailure);

$config = "<?php\\n";
$config .= "define( 'DB_NAME', " . var_export($databaseName, true) . " );\\n";
$config .= "define( 'DB_USER', " . var_export($databaseUser, true) . " );\\n";
$config .= "define( 'DB_PASSWORD', " . var_export($databasePassword, true) . " );\\n";
$dbHost = (strpos($host, ':') !== false && !str_starts_with($host, '[') ? '[' . $host . ']' : $host) . ':' . $port;
$config .= "define( 'DB_HOST', " . var_export($dbHost, true) . " );\\n";
$config .= "define( 'DB_CHARSET', 'utf8mb4' );\\n";
$config .= "define( 'DB_COLLATE', '' );\\n";
$config .= "define( 'AUTH_KEY', " . var_export($salts[0], true) . " );\\n";
$config .= "define( 'SECURE_AUTH_KEY', " . var_export($salts[1], true) . " );\\n";
$config .= "define( 'LOGGED_IN_KEY', " . var_export($salts[2], true) . " );\\n";
$config .= "define( 'NONCE_KEY', " . var_export($salts[3], true) . " );\\n";
$config .= "define( 'AUTH_SALT', " . var_export($salts[4], true) . " );\\n";
$config .= "define( 'SECURE_AUTH_SALT', " . var_export($salts[5], true) . " );\\n";
$config .= "define( 'LOGGED_IN_SALT', " . var_export($salts[6], true) . " );\\n";
$config .= "define( 'NONCE_SALT', " . var_export($salts[7], true) . " );\\n";
$config .= "define( 'WP_HOME', " . var_export($siteUrl, true) . " );\\n";
$config .= "define( 'WP_SITEURL', " . var_export($siteUrl, true) . " );\\n";
$config .= "define( 'WP_DEBUG', false );\\n";
$config .= "\\$table_prefix = " . var_export($tablePrefix, true) . ";\\n";
$config .= "if ( ! defined( 'ABSPATH' ) ) define( 'ABSPATH', __DIR__ . '/' );\\n";
$config .= "require_once ABSPATH . 'wp-settings.php';\\n";
$configTemp = __DIR__ . '/.wp-config-' . HISTOS_PLAN . '.tmp';
clearstatcache(true, $configPath);
$stillPlaceholder = is_file($configPath) && hash_equals(HISTOS_PLACEHOLDER, (string) @file_get_contents($configPath));
if ((file_exists($configPath) && !$stillPlaceholder) || file_exists($configTemp)) histos_reply(409, 'wordpress-config-already-exists');
$previousUmask = umask(0077);
$configHandle = @fopen($configTemp, 'x');
umask($previousUmask);
if (!is_resource($configHandle)) histos_reply(500, 'wordpress-config-write-failed');
@chmod($configTemp, 0600);
$configWritten = fwrite($configHandle, $config);
$configFlushed = fflush($configHandle);
fclose($configHandle);
clearstatcache(true, $configTemp);
$configMode = @fileperms($configTemp);
if ($configWritten !== strlen($config) || !$configFlushed) { @unlink($configTemp); histos_reply(500, 'wordpress-config-write-failed'); }
if (!is_int($configMode) || ($configMode & 0777) !== 0600) { @unlink($configTemp); histos_reply(500, 'wordpress-config-permissions-failed'); }
if (!@rename($configTemp, $configPath)) { @unlink($configTemp); histos_reply(500, 'wordpress-config-write-failed'); }
define('WP_INSTALLING', true);
require_once __DIR__ . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
add_filter('pre_wp_mail', '__return_true');
$installed = wp_install($siteTitle, $adminUsername, $adminEmail, false, '', $adminPassword, 'en_US');
if (!is_array($installed) || empty($installed['user_id']) || !is_blog_installed()) {
  // Configured but not installed: install.php would hand the site to the first visitor. Put the guard back.
  $guardTemp = $configPath . '.histos-guard-' . bin2hex(random_bytes(8));
  if (@file_put_contents($guardTemp, HISTOS_PLACEHOLDER, LOCK_EX) === strlen(HISTOS_PLACEHOLDER)) @rename($guardTemp, $configPath);
  @unlink($guardTemp);
  histos_reply(500, 'wordpress-install-failed');
}
$userId = (int) $installed['user_id'];
wp_set_current_user($userId);
$activation = activate_plugin('xb/xb.php', '', false, true);
if (is_wp_error($activation)) histos_reply(500, 'histos-activation-failed');
update_option('_histos_publish_provision_plan_id', HISTOS_PLAN, false);
update_option('_histos_publish_provision_admin_id', $userId, false);
// Download and send only: publishing stays off until the administrator creates a code that allows it.
$pairingCode = \\XB\\Cms\\Link::create(mb_substr($siteTitle, 0, 80), true, true, false);
histos_reply(200, 'installed', array('planId' => HISTOS_PLAN, 'wordpressVersion' => (string) $GLOBALS['wp_version'], 'pairingCode' => $pairingCode, 'siteUrl' => untrailingslashit(home_url())));
`;
  return Buffer.from(source, "utf8");
}

export interface WordPressProvisionBootstrapResult {
  mode: WordPressProvisionMode;
  planId: string;
  wordpressVersion: string;
  pairingCode: string;
  siteUrl: string;
}

export function parseWordPressProvisionBootstrapResponse(status: number, contentType: string, body: Buffer, expectedPlanId: string, mode: WordPressProvisionMode): WordPressProvisionBootstrapResult {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (status !== 200 || mediaType !== "application/json" || body.byteLength > 16 * 1024) throw new HistosPublishError("Il server WordPress non ha confermato l’installazione. Il piano resta disponibile per il controllo di recupero.", "wordpress-provision-response-invalid", 502);
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new HistosPublishError("La risposta dell’installazione WordPress non è JSON valido. Il piano resta disponibile per il recupero.", "wordpress-provision-response-invalid", 502); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HistosPublishError("La risposta dell’installazione WordPress non è valida. Il piano resta disponibile per il recupero.", "wordpress-provision-response-invalid", 502);
  const data = parsed as Record<string, unknown>;
  const expectedCode = mode === "install" ? "installed" : "recovered";
  const pairingCode = typeof data.pairingCode === "string" ? data.pairingCode : "";
  const wordpressVersion = typeof data.wordpressVersion === "string" ? data.wordpressVersion : "";
  const siteUrl = typeof data.siteUrl === "string" ? data.siteUrl : "";
  let parsedUrl: URL | null = null;
  try { parsedUrl = new URL(siteUrl); } catch { /* input checked below */ }
  if (data.probe !== "histos-wordpress-provision-v1" || data.code !== expectedCode || data.planId !== expectedPlanId || !/^\d+\.\d+(?:\.\d+)?$/u.test(wordpressVersion) || !pairingCode.startsWith("histos-cms-1:") || pairingCode.length > 2048 || !parsedUrl || parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new HistosPublishError("WordPress non ha restituito l’abbinamento Histeon atteso. Il piano resta disponibile per il recupero.", "wordpress-provision-response-invalid", 502);
  }
  return { mode, planId: expectedPlanId, wordpressVersion, pairingCode, siteUrl: parsedUrl.href.replace(/\/$/u, "") };
}
