import { describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { evaluateDatabasePrivileges, parseDatabaseConnectionInput, storedDatabaseConnection, wordpressDatabaseVersionSupported } from "../src/database-probe.js";

const validInput = {
  name: "Database test",
  host: "db.example.test",
  port: 3306,
  databaseName: "histos_db",
  tablePrefix: "wp_histos_",
  username: "wp_user",
  password: "password with spaces",
  caCertificate: "",
};

describe("connessioni MySQL/MariaDB", () => {
  it("normalizza l’host e conserva gli spazi intenzionali nella password", () => {
    expect(parseDatabaseConnectionInput({ ...validInput, host: "DB.Example.Test." })).toMatchObject({
      host: "db.example.test",
      port: 3306,
      databaseName: "histos_db",
      tablePrefix: "wp_histos_",
      password: "password with spaces",
    });
  });

  it("accetta IP IPv4 e IPv6 ma rifiuta URL, percorsi e nomi host ambigui", () => {
    expect(parseDatabaseConnectionInput({ ...validInput, host: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(parseDatabaseConnectionInput({ ...validInput, host: "::1" }).host).toBe("::1");
    for (const host of ["https://db.example.test", "db.example.test/path", "db host", "-invalid.example"]) {
      expect(() => parseDatabaseConnectionInput({ ...validInput, host })).toThrow(HistosPublishError);
    }
  });

  it("convalida nome database, prefisso e CA prima di aprire la rete", () => {
    expect(() => parseDatabaseConnectionInput({ ...validInput, databaseName: "db; DROP TABLE users" })).toThrow(/nome del database/u);
    expect(() => parseDatabaseConnectionInput({ ...validInput, tablePrefix: "wp-" })).toThrow(/prefisso/u);
    expect(() => parseDatabaseConnectionInput({ ...validInput, caCertificate: "-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----" })).toThrow(/PEM valido/u);
  });

  it("conserva il pin SSH e non restituisce chiave privata o passphrase nel profilo", () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-material\n-----END OPENSSH PRIVATE KEY-----";
    const input = parseDatabaseConnectionInput({
      ...validInput,
      sshTunnel: {
        host: "SSH.Example.Test.",
        port: 2222,
        username: "deploy-user",
        authMethod: "privateKey",
        privateKey,
        passphrase: "secret-passphrase",
        hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
    });
    expect(input.sshTunnel).toMatchObject({ host: "ssh.example.test", port: 2222, username: "deploy-user", authMethod: "privateKey" });
    const profile = storedDatabaseConnection(input, {
      engine: "mariadb",
      serverVersion: "11.4.9-MariaDB",
      serverComment: "MariaDB Server",
      characterSet: "utf8mb4",
      collation: "utf8mb4_unicode_ci",
      tableCount: 0,
      prefixTableCount: 0,
      privilegesVerified: false,
      grantedPrivileges: [],
      missingPrivileges: [],
      checkedAt: "2026-10-25T00:00:00.000Z",
    }, "test-profile");
    expect(profile.sshTunnel).toMatchObject({ host: "ssh.example.test", port: 2222, username: "deploy-user", authMethod: "privateKey" });
    expect(JSON.stringify(profile)).not.toContain(privateKey);
    expect(JSON.stringify(profile)).not.toContain("secret-passphrase");
  });

  it("rifiuta un tunnel senza impronta confermata o con autenticazione incompleta", () => {
    const sshTunnel = { host: "ssh.example.test", port: 22, username: "deploy-user", authMethod: "password", password: "secret" };
    expect(() => parseDatabaseConnectionInput({ ...validInput, sshTunnel })).toThrow(/chiave host SSH/u);
    expect(() => parseDatabaseConnectionInput({ ...validInput, sshTunnel: { ...sshTunnel, hostKeyFingerprint: `SHA256:${"A".repeat(43)}`, password: "" } })).toThrow(/password SSH/u);
  });

  it("verifica i permessi WordPress solo per il database selezionato e non presume i privilegi ereditati da un ruolo", () => {
    const required = "ALTER, CREATE, DELETE, DROP, INDEX, INSERT, SELECT, UPDATE";
    expect(evaluateDatabasePrivileges([`GRANT ${required} ON \`histos\\_db\`.* TO 'wp_user'@'%'`], "histos_db")).toMatchObject({
      privilegesVerified: true,
      grantedPrivileges: ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "INSERT", "SELECT", "UPDATE"],
      missingPrivileges: [],
    });
    expect(evaluateDatabasePrivileges(["GRANT SELECT ON `other_db`.* TO 'wp_user'@'%'"], "histos_db")).toMatchObject({ privilegesVerified: false, missingPrivileges: [] });
    expect(evaluateDatabasePrivileges(["GRANT `installer_role` TO 'wp_user'@'%'"], "histos_db")).toMatchObject({ privilegesVerified: false, missingPrivileges: [] });
    expect(evaluateDatabasePrivileges(["GRANT SELECT, INSERT ON `histos_db`.* TO 'wp_user'@'%'"], "histos_db")).toMatchObject({
      privilegesVerified: true,
      grantedPrivileges: ["INSERT", "SELECT"],
      missingPrivileges: ["ALTER", "CREATE", "DELETE", "DROP", "INDEX", "UPDATE"],
    });
  });

  it("applica i requisiti database consigliati da WordPress senza accettare versioni non interpretabili", () => {
    expect(wordpressDatabaseVersionSupported("mysql", "8.0.40-log")).toBe(true);
    expect(wordpressDatabaseVersionSupported("mysql", "5.7.44")).toBe(false);
    expect(wordpressDatabaseVersionSupported("mariadb", "10.11.10-MariaDB")).toBe(true);
    expect(wordpressDatabaseVersionSupported("mariadb", "5.5.5-10.11.10-MariaDB")).toBe(true);
    expect(wordpressDatabaseVersionSupported("mariadb", "10.6.21-MariaDB")).toBe(false);
    expect(wordpressDatabaseVersionSupported("mysql", "version unknown")).toBe(false);
  });
});
