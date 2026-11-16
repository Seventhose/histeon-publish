import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";
import { withTemporaryStaticHostingFile, type StaticHostingCredentials, type StaticHostingSettings } from "./static-hosting.js";

export interface WordPressPhpRuntime {
  phpChecked: true;
  phpVersion: string;
  phpSupported: boolean;
  phpRecommended: boolean;
  missingRequiredExtensions: string[];
  missingRecommendedExtensions: string[];
  databaseTlsVerified: boolean;
  databaseTlsFailure: WordPressDatabaseTlsFailure | null;
  httpsAvailable: true;
  wordpressMinimumPhp: ">= 7.4";
  requiredPhp: ">= 8.3";
  recommendedPhp: ">= 8.4";
  status: "supported" | "unsupported";
}

export interface WordPressRuntimeProbeOptions {
  settings: StaticHostingSettings;
  credentials: StaticHostingCredentials;
  database: {
    host: string;
    port: number;
    databaseName: string;
    username: string;
    password: string;
    caCertificate: string;
  };
}

export type TemporaryHostingFileRunner = typeof withTemporaryStaticHostingFile;
export type WordPressDatabaseTlsFailure = "client-unsupported" | "connection-failed" | "tls-not-active" | "ca-temp-file-failed" | "ca-unavailable";
export type WordPressRuntimePost = (url: URL, payload: { nonce: string; phase: "proof" } | { nonce: string; database: WordPressRuntimeProbeOptions["database"] }) => Promise<{ status: number; contentType: string; body: Buffer }>;

export function buildWordPressPhpProbe(nonce: string, expiresAt: number, proof: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(nonce) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new HistosPublishError("I dati temporanei del controllo PHP non sono validi.", "wordpress-runtime-probe-invalid", 2);
  }
  if (!/^[a-f0-9]{64}$/u.test(proof)) throw new HistosPublishError("I dati temporanei del controllo PHP non sono validi.", "wordpress-runtime-probe-invalid", 2);
  const nonceHash = createHash("sha256").update(nonce, "utf8").digest("hex");
  const source = `<?php
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
if (!extension_loaded('json') || !extension_loaded('hash')) {
  header('Content-Type: text/plain; charset=utf-8');
  http_response_code(503);
  echo 'histos-runtime-missing-required-extension';
  exit;
}
header('Content-Type: application/json; charset=utf-8');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); exit; }
$raw = file_get_contents('php://input');
if (!is_string($raw) || strlen($raw) > 80 * 1024) { http_response_code(400); exit; }
$payload = json_decode($raw, true);
$nonce = is_array($payload) && isset($payload['nonce']) && is_string($payload['nonce']) ? $payload['nonce'] : '';
if (time() > ${expiresAt} || !hash_equals('${nonceHash}', hash('sha256', $nonce))) { http_response_code(404); exit; }
if (is_array($payload) && ($payload['phase'] ?? '') === 'proof') { echo json_encode(['probe' => 'histos-wordpress-runtime-proof-v1', 'proof' => '${proof}']); exit; }
$required = ['json', 'hash', 'mysqli'];
$recommended = ['curl', 'dom', 'exif', 'fileinfo', 'imagick', 'intl', 'mbstring', 'openssl', 'xml', 'zip'];
$missingRequired = array_values(array_filter($required, static function ($extension) { return !extension_loaded($extension); }));
$missingRecommended = array_values(array_filter($recommended, static function ($extension) { return !extension_loaded($extension); }));
$databaseTlsVerified = false;
$databaseTlsFailure = 'connection-failed';
$db = is_array($payload) && isset($payload['database']) && is_array($payload['database']) ? $payload['database'] : null;
if ($db && !in_array('mysqli', $missingRequired, true)) {
  $host = isset($db['host']) && is_string($db['host']) ? $db['host'] : '';
  $port = isset($db['port']) && is_int($db['port']) ? $db['port'] : 0;
  $databaseName = isset($db['databaseName']) && is_string($db['databaseName']) ? $db['databaseName'] : '';
  $username = isset($db['username']) && is_string($db['username']) ? $db['username'] : '';
  $password = isset($db['password']) && is_string($db['password']) ? $db['password'] : '';
  $caCertificate = isset($db['caCertificate']) && is_string($db['caCertificate']) ? $db['caCertificate'] : '';
  $hostValid = strlen($host) > 0 && strlen($host) <= 253 && preg_match('/^[A-Za-z0-9.:-]+$/', $host) === 1;
  $databaseValid = preg_match('/^[A-Za-z0-9_$-]{1,64}$/', $databaseName) === 1;
  $credentialsValid = strlen($username) > 0 && strlen($username) <= 128 && strlen($password) > 0 && strlen($password) <= 4096 && strpos($username, "\\0") === false && strpos($password, "\\0") === false;
  if (!$hostValid || $port < 1 || $port > 65535 || !$databaseValid || !$credentialsValid || strlen($caCertificate) > 64 * 1024) {
    $databaseTlsFailure = 'connection-failed';
  } elseif (!function_exists('mysqli_ssl_set') || !function_exists('mysqli_get_client_info') || !defined('MYSQLI_CLIENT_SSL') || stripos(mysqli_get_client_info(), 'mysqlnd') !== 0) {
    $databaseTlsFailure = 'client-unsupported';
  } else {
    $caFile = null;
    $mysqli = null;
    try {
      mysqli_report(MYSQLI_REPORT_OFF);
      $mysqli = mysqli_init();
      if ($mysqli) {
        mysqli_options($mysqli, MYSQLI_OPT_CONNECT_TIMEOUT, 8);
        if ($caCertificate !== '') {
          $caFile = tempnam(sys_get_temp_dir(), 'histos-runtime-ca-');
          if ($caFile === false || file_put_contents($caFile, $caCertificate, LOCK_EX) !== strlen($caCertificate)) {
            $databaseTlsFailure = 'ca-temp-file-failed';
          } else {
            @chmod($caFile, 0600);
          }
        }
        if ($databaseTlsFailure !== 'ca-temp-file-failed') {
          $trustFile = is_string($caFile) && $caFile !== '' ? $caFile : null;
          $trustDir = null;
          if ($trustFile === null) {
            // No CA of its own: mysqlnd verifies the server only when it is given CAs, so give it the system trust store.
            $locations = function_exists('openssl_get_cert_locations') ? openssl_get_cert_locations() : array();
            if (is_array($locations) && is_string($locations['default_cert_file'] ?? null) && is_readable($locations['default_cert_file'])) $trustFile = $locations['default_cert_file'];
            elseif (is_array($locations) && is_string($locations['default_cert_dir'] ?? null) && is_dir($locations['default_cert_dir'])) $trustDir = $locations['default_cert_dir'];
          }
          if ($trustFile === null && $trustDir === null) $databaseTlsFailure = 'ca-unavailable';
        }
        if ($databaseTlsFailure !== 'ca-temp-file-failed' && $databaseTlsFailure !== 'ca-unavailable') {
          mysqli_ssl_set($mysqli, null, null, $trustFile, $trustDir, null);
          $connected = @mysqli_real_connect($mysqli, $host, $username, $password, $databaseName, $port, null, MYSQLI_CLIENT_SSL);
          if ($connected) {
            $cipherResult = mysqli_query($mysqli, "SHOW STATUS LIKE 'Ssl_cipher'");
            $cipherRow = $cipherResult instanceof mysqli_result ? mysqli_fetch_row($cipherResult) : false;
            if ($cipherResult instanceof mysqli_result) { mysqli_free_result($cipherResult); }
            if (is_array($cipherRow) && isset($cipherRow[1]) && is_string($cipherRow[1]) && $cipherRow[1] !== '') {
              $databaseTlsVerified = true;
              $databaseTlsFailure = '';
            } else {
              $databaseTlsFailure = 'tls-not-active';
            }
          }
        }
      }
    } catch (Throwable $error) {
      $databaseTlsVerified = false;
      $databaseTlsFailure = 'connection-failed';
    } finally {
      if ($mysqli instanceof mysqli) { @mysqli_close($mysqli); }
      if (is_string($caFile) && is_file($caFile)) { @unlink($caFile); }
    }
  }
}
echo json_encode([
  'probe' => 'histos-wordpress-runtime-v1',
  'phpVersion' => PHP_VERSION,
  'missingRequiredExtensions' => $missingRequired,
  'missingRecommendedExtensions' => $missingRecommended,
  'databaseTlsVerified' => $databaseTlsVerified,
  'databaseTlsFailure' => $databaseTlsFailure
], JSON_UNESCAPED_SLASHES);
`;
  return Buffer.from(source, "utf8");
}

const REQUIRED_EXTENSIONS = ["json", "hash", "mysqli"] as const;
const RECOMMENDED_EXTENSIONS = ["curl", "dom", "exif", "fileinfo", "imagick", "intl", "mbstring", "openssl", "xml", "zip"] as const;

function extensionList(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > allowed.length || value.some((item) => typeof item !== "string" || !allowed.includes(item)) || new Set(value).size !== value.length) {
    throw new HistosPublishError("La risposta del controllo delle estensioni PHP non è valida. WordPress non verrà installato.", "wordpress-runtime-response-invalid", 4);
  }
  return [...value] as string[];
}

export function parseWordPressPhpProbeResponse(statusCode: number, contentType: string, body: Buffer): {
  phpVersion: string;
  phpSupported: boolean;
  phpRecommended: boolean;
  missingRequiredExtensions: string[];
  missingRecommendedExtensions: string[];
  databaseTlsVerified: boolean;
  databaseTlsFailure: WordPressDatabaseTlsFailure | null;
} {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (statusCode === 503 && mediaType === "text/plain" && body.toString("utf8").trim() === "histos-runtime-missing-required-extension") {
    throw new HistosPublishError("La versione PHP del server non include JSON o Hash, requisiti necessari per eseguire WordPress e completare il controllo sicuro.", "wordpress-runtime-required-extensions-missing", 4);
  }
  if (statusCode !== 200 || mediaType !== "application/json" || body.byteLength > 2048) {
    throw new HistosPublishError("Il server non ha restituito una risposta PHP valida. Il file temporaneo verrà rimosso e WordPress non verrà installato.", "wordpress-runtime-response-invalid", 4);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); }
  catch { throw new HistosPublishError("Il server non ha restituito il risultato JSON del controllo PHP. WordPress non verrà installato.", "wordpress-runtime-response-invalid", 4); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HistosPublishError("La risposta del controllo PHP non è valida. WordPress non verrà installato.", "wordpress-runtime-response-invalid", 4);
  }
  const result = parsed as Record<string, unknown>;
  const phpVersion = typeof result.phpVersion === "string" ? result.phpVersion : "";
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(phpVersion);
  if (result.probe !== "histos-wordpress-runtime-v1" || !match) {
    throw new HistosPublishError("Il server non sta eseguendo il controllo PHP temporaneo. Verifica che la cartella sia servita tramite PHP.", "wordpress-runtime-not-executed", 4);
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const phpVersionSupported = version[0]! > 8 || version[0] === 8 && version[1]! >= 3;
  const phpRecommended = version[0]! > 8 || version[0] === 8 && version[1]! >= 4;
  const missingRequiredExtensions = extensionList(result.missingRequiredExtensions, REQUIRED_EXTENSIONS);
  const missingRecommendedExtensions = extensionList(result.missingRecommendedExtensions, RECOMMENDED_EXTENSIONS);
  const phpSupported = phpVersionSupported && missingRequiredExtensions.length === 0;
  const tlsFailures: WordPressDatabaseTlsFailure[] = ["client-unsupported", "connection-failed", "tls-not-active", "ca-temp-file-failed", "ca-unavailable"];
  if (typeof result.databaseTlsVerified !== "boolean" || typeof result.databaseTlsFailure !== "string" || (result.databaseTlsFailure !== "" && !tlsFailures.includes(result.databaseTlsFailure as WordPressDatabaseTlsFailure)) || result.databaseTlsVerified === (result.databaseTlsFailure !== "")) {
    throw new HistosPublishError("Il controllo temporaneo non ha verificato il collegamento TLS fra PHP e database. WordPress non verrà installato.", "wordpress-runtime-database-tls-invalid", 4);
  }
  const databaseTlsFailure = result.databaseTlsFailure === "" ? null : result.databaseTlsFailure as WordPressDatabaseTlsFailure;
  return { phpVersion, phpSupported, phpRecommended, missingRequiredExtensions, missingRecommendedExtensions, databaseTlsVerified: result.databaseTlsVerified, databaseTlsFailure };
}

export async function probeWordPressPhpRuntime(
  options: WordPressRuntimeProbeOptions,
  dependencies: {
    temporaryFileRunner?: TemporaryHostingFileRunner;
    postJson?: WordPressRuntimePost;
    now?: () => number;
    nonce?: () => string;
    proof?: () => string;
  } = {},
): Promise<WordPressPhpRuntime> {
  const publicUrl = options.settings.publicUrl;
  if (!publicUrl) throw new HistosPublishError("Inserisci l’indirizzo HTTPS pubblico del sito prima di verificare PHP.", "wordpress-runtime-url-missing", 2);
  let baseUrl: URL;
  try { baseUrl = new URL(publicUrl); }
  catch { throw new HistosPublishError("L’indirizzo pubblico del sito non è valido.", "wordpress-runtime-url-invalid", 2); }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || !baseUrl.hostname) {
    throw new HistosPublishError("Il controllo WordPress richiede l’indirizzo HTTPS pubblico senza credenziali.", "wordpress-runtime-https-required", 2);
  }
  baseUrl.hash = "";
  baseUrl.search = "";
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const fileName = `histos-runtime-check-${randomUUID().replaceAll("-", "")}.php`;
  const now = dependencies.now?.() ?? Date.now();
  const nonce = dependencies.nonce?.() ?? randomBytes(32).toString("hex");
  const expiresAt = Math.floor(now / 1000) + 120;
  const probeUrl = new URL(fileName, baseUrl);
  const probe = new SafeHttpClient({
    origin: baseUrl.origin,
    userAgent: "HistosPublish-WordPress-Preflight/1.0",
    timeoutMs: 10_000,
    delayMs: 0,
    strictOrigin: true,
  });
  const postJson: WordPressRuntimePost = dependencies.postJson ?? (async (url, payload) => {
    const response = await probe.postJson(url, payload, { maxBytes: 2048 });
    return {
      status: response.status,
      contentType: Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] ?? "" : response.headers["content-type"] ?? "",
      body: response.body,
    };
  });
  const temporaryFileRunner = dependencies.temporaryFileRunner ?? withTemporaryStaticHostingFile;
  // The proof travels only inside the file uploaded through the authenticated hosting channel. The database
  // credentials go to publicUrl only after it answered with that proof: it runs this very file, not another server.
  const proof = dependencies.proof?.() ?? randomBytes(32).toString("hex");
  const response = await temporaryFileRunner({
    settings: options.settings,
    credentials: options.credentials,
    fileName,
    bytes: buildWordPressPhpProbe(nonce, expiresAt, proof),
    run: async () => {
      const hello = await postJson(probeUrl, { nonce, phase: "proof" });
      let answered: unknown;
      try { answered = hello.status === 200 ? JSON.parse(hello.body.toString("utf8")) : null; } catch { answered = null; }
      const received = answered && typeof answered === "object" && (answered as { probe?: unknown }).probe === "histos-wordpress-runtime-proof-v1" ? (answered as { proof?: unknown }).proof : null;
      if (typeof received !== "string" || received.length !== proof.length || !timingSafeEqual(Buffer.from(received), Buffer.from(proof))) {
        throw new HistosPublishError("L’indirizzo pubblico non esegue il file appena caricato sull’hosting: controlla che punti alla stessa cartella. Le credenziali del database non sono state inviate.", "wordpress-runtime-url-mismatch", 4);
      }
      return postJson(probeUrl, { nonce, database: options.database });
    },
  });
  const result = parseWordPressPhpProbeResponse(response.status, response.contentType, response.body);
  return {
    phpChecked: true,
    ...result,
    httpsAvailable: true,
    wordpressMinimumPhp: ">= 7.4",
    requiredPhp: ">= 8.3",
    recommendedPhp: ">= 8.4",
    status: result.phpSupported && result.databaseTlsVerified ? "supported" : "unsupported",
  };
}
