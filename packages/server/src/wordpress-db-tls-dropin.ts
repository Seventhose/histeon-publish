import { X509Certificate } from "node:crypto";
import { HistosPublishError } from "@histos-publish/core";

const MAX_CA_BYTES = 64 * 1024;

function validateCertificateAuthority(caCertificate: string): void {
  if (Buffer.byteLength(caCertificate, "utf8") > MAX_CA_BYTES) {
    throw new HistosPublishError("Il certificato CA supera il limite di 64 KiB.", "wordpress-db-ca-too-large", 2);
  }
  const certificates = caCertificate.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  const remainder = caCertificate.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim();
  if (certificates.length === 0 || remainder) {
    throw new HistosPublishError("Il certificato CA del database non è PEM valido.", "wordpress-db-ca-invalid", 2);
  }
  try {
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    throw new HistosPublishError("Il certificato CA del database non è PEM valido.", "wordpress-db-ca-invalid", 2);
  }
}

/**
 * Creates the WordPress `wp-content/db.php` drop-in used by new installations.
 * WordPress' bundled wpdb does not set mysqli TLS options itself; this subclass
 * keeps normal wpdb behavior while requiring TLS and certificate/host checks on
 * every initial or reconnect attempt.
 */
export function buildWordPressDatabaseTlsDropIn(caCertificate: string): Buffer {
  if (caCertificate) validateCertificateAuthority(caCertificate);
  const caBase64 = Buffer.from(caCertificate, "utf8").toString("base64");
  const source = `<?php
/**
 * Histeon Publish verified MySQL/MariaDB TLS drop-in.
 * Generated for a new, empty WordPress installation. Do not remove while the
 * database endpoint requires verified TLS.
 */
if (!defined('ABSPATH') || !defined('WPINC') || !class_exists('wpdb', false)) {
  return;
}

if (!class_exists('HistosPublishVerifiedTlsWpdb', false)) {
  final class HistosPublishVerifiedTlsWpdb extends wpdb {
    private const CA_BASE64 = '${caBase64}';
    private $histos_has_connected = false;

    public function db_connect($allow_bail = true) {
      $this->is_mysql = true;

      if (!extension_loaded('mysqli') || !function_exists('mysqli_ssl_set') || !function_exists('mysqli_get_client_info') || !defined('MYSQLI_CLIENT_SSL')) {
        return $this->histos_tls_bail($allow_bail);
      }

      // The tested mysqlnd driver verifies the CA chain and hostname when a CA
      // is supplied to mysqli_ssl_set(). Other client libraries are not enabled
      // until their verification behavior is covered by the runtime matrix.
      $clientInfo = mysqli_get_client_info();
      if (!is_string($clientInfo) || stripos($clientInfo, 'mysqlnd') !== 0) {
        return $this->histos_tls_bail($allow_bail);
      }

      mysqli_report(MYSQLI_REPORT_OFF);
      $dbh = mysqli_init();
      if (!$dbh) {
        return $this->histos_tls_bail($allow_bail);
      }

      $caFile = null;
      $temporaryCa = null;
      try {
        $caCertificate = self::CA_BASE64 !== '' ? base64_decode(self::CA_BASE64, true) : '';
        if ($caCertificate === false) {
          return $this->histos_tls_bail($allow_bail);
        }
        if ($caCertificate !== '') {
          $caFile = tempnam(sys_get_temp_dir(), 'histos-db-ca-');
          $temporaryCa = $caFile;
          if ($caFile === false || file_put_contents($caFile, $caCertificate, LOCK_EX) !== strlen($caCertificate)) {
            return $this->histos_tls_bail($allow_bail);
          }
          @chmod($caFile, 0600);
        }
        // Without a CA of its own the server is checked against the system trust store, never left unverified.
        $caPath = null;
        if ($caFile === null) {
          $locations = function_exists('openssl_get_cert_locations') ? openssl_get_cert_locations() : array();
          $systemFile = is_array($locations) && isset($locations['default_cert_file']) && is_string($locations['default_cert_file']) ? $locations['default_cert_file'] : '';
          $systemDir = is_array($locations) && isset($locations['default_cert_dir']) && is_string($locations['default_cert_dir']) ? $locations['default_cert_dir'] : '';
          if ($systemFile !== '' && is_readable($systemFile)) {
            $caFile = $systemFile;
          } elseif ($systemDir !== '' && is_dir($systemDir)) {
            $caPath = $systemDir;
          } else {
            return $this->histos_tls_bail($allow_bail);
          }
        }

        // mysqlnd verifies the chain and the host name only when it is given CAs: always give it some.
        mysqli_ssl_set($dbh, null, null, $caFile, $caPath, null);

        $host = $this->dbhost;
        $port = null;
        $socket = null;
        $is_ipv6 = false;
        $host_data = $this->parse_db_host($this->dbhost);
        if (!$host_data) {
          return $this->histos_tls_bail($allow_bail);
        }
        list($host, $port, $socket, $is_ipv6) = $host_data;
        if ($socket !== null) {
          // The managed external database profile uses TCP with verified TLS.
          return $this->histos_tls_bail($allow_bail);
        }
        if ($is_ipv6 && extension_loaded('mysqlnd')) {
          $host = '[' . $host . ']';
        }

        if (!mysqli_options($dbh, MYSQLI_OPT_CONNECT_TIMEOUT, 8)) {
          return $this->histos_tls_bail($allow_bail);
        }
        $clientFlags = defined('MYSQL_CLIENT_FLAGS') ? MYSQL_CLIENT_FLAGS : 0;
        if (defined('MYSQLI_CLIENT_SSL_DONT_VERIFY_SERVER_CERT') && ($clientFlags & MYSQLI_CLIENT_SSL_DONT_VERIFY_SERVER_CERT)) {
          return $this->histos_tls_bail($allow_bail);
        }
        $clientFlags |= MYSQLI_CLIENT_SSL;
        $connected = @mysqli_real_connect($dbh, $host, $this->dbuser, $this->dbpassword, null, $port, null, $clientFlags);
        if (!$connected || mysqli_connect_errno()) {
          return $this->histos_tls_bail($allow_bail);
        }

        $tlsResult = mysqli_query($dbh, "SHOW STATUS LIKE 'Ssl_cipher'");
        $tlsRow = $tlsResult instanceof mysqli_result ? mysqli_fetch_row($tlsResult) : false;
        if ($tlsResult instanceof mysqli_result) {
          mysqli_free_result($tlsResult);
        }
        if (!is_array($tlsRow) || !isset($tlsRow[1]) || !is_string($tlsRow[1]) || $tlsRow[1] === '') {
          mysqli_close($dbh);
          return $this->histos_tls_bail($allow_bail);
        }

        $this->dbh = $dbh;
      } catch (Throwable $error) {
        if ($dbh instanceof mysqli) {
          @mysqli_close($dbh);
        }
        $this->dbh = null;
        return $this->histos_tls_bail($allow_bail);
      } finally {
        if (is_string($temporaryCa) && is_file($temporaryCa)) {
          @unlink($temporaryCa);
        }
      }

      if (!$this->dbh) {
        return $this->histos_tls_bail($allow_bail);
      }

      if (!$this->histos_has_connected) {
        $this->init_charset();
      }
      $this->histos_has_connected = true;
      $this->set_charset($this->dbh);
      $this->ready = true;
      $this->set_sql_mode();
      $this->select($this->dbname, $this->dbh);
      if (!$this->ready) {
        return $this->histos_tls_bail($allow_bail);
      }
      return true;
    }

    private function histos_tls_bail($allow_bail) {
      $this->dbh = null;
      $this->ready = false;
      $this->last_error = 'Histeon Publish requires a verified TLS connection to the configured database.';
      if ($allow_bail) {
        $this->bail('<h1>Database connection not verified</h1><p>Histeon Publish could not establish a TLS connection with a trusted certificate for the configured database host. Check the database CA certificate and hostname.</p>', 'db_connect_fail');
      }
      return false;
    }
  }
}

global $wpdb;
if (!isset($wpdb) && defined('DB_USER') && defined('DB_PASSWORD') && defined('DB_NAME') && defined('DB_HOST')) {
  $wpdb = new HistosPublishVerifiedTlsWpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
}
`;
  return Buffer.from(source, "utf8");
}
