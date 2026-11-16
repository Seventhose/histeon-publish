import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWordPressDatabaseTlsDropIn } from "../src/wordpress-db-tls-dropin.js";

const caCertificate = readFileSync(fileURLToPath(new URL("./fixtures/wordpress-db-ca.pem", import.meta.url)), "utf8");

describe("drop-in TLS verificato per WordPress", () => {
  it("richiede mysqli TLS, verifica CA e hostname e controlla il cipher anche dopo un reconnect", () => {
    const source = buildWordPressDatabaseTlsDropIn(caCertificate).toString("utf8");
    const encodedCa = Buffer.from(caCertificate, "utf8").toString("base64");

    expect(source).toContain(`private const CA_BASE64 = '${encodedCa}'`);
    expect(source).not.toContain(caCertificate);
    expect(source).toContain("mysqli_get_client_info()");
    expect(source).toContain("stripos($clientInfo, 'mysqlnd') !== 0");
    expect(source).toContain("MYSQLI_CLIENT_SSL");
    expect(source).toContain("SHOW STATUS LIKE 'Ssl_cipher'");
    expect(source).toContain("$this->histos_has_connected");
    expect(source).toContain("@unlink($temporaryCa)");
    expect(source).toContain("HistosPublishVerifiedTlsWpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST)");
  });

  it("consente la CA pubblica di sistema senza incorporare certificati", () => {
    const source = buildWordPressDatabaseTlsDropIn("").toString("utf8");

    expect(source).toContain("private const CA_BASE64 = ''");
    expect(source).toContain("mysqli_get_client_info()");
    expect(source).toContain("MYSQLI_CLIENT_SSL");
    // mysqlnd verifies only when given CAs: without one, the system trust store is passed, never nothing.
    expect(source).toContain("openssl_get_cert_locations()");
    expect(source).toContain("mysqli_ssl_set($dbh, null, null, $caFile, $caPath, null)");
  });

  it("rifiuta CA malformate e oltre il limite", () => {
    expect(() => buildWordPressDatabaseTlsDropIn("not-a-certificate"))
      .toThrowError(expect.objectContaining({ code: "wordpress-db-ca-invalid" }));
    expect(() => buildWordPressDatabaseTlsDropIn(`${caCertificate}\n${" ".repeat(64 * 1024)}`))
      .toThrowError(expect.objectContaining({ code: "wordpress-db-ca-too-large" }));
  });
});
