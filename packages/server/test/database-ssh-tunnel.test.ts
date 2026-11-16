import { describe, expect, it } from "vitest";
import { parseDatabaseSshEndpoint, sshFingerprintFromSha256Hex } from "../src/database-ssh-tunnel.js";

describe("tunnel SSH per probe database", () => {
  it("normalizza un endpoint SSH senza schema o percorso", () => {
    expect(parseDatabaseSshEndpoint({ host: " SSH.Example.Test. ", port: "2222" })).toEqual({ host: "ssh.example.test", port: 2222 });
    expect(parseDatabaseSshEndpoint({ host: "2001:db8::1", port: 22 })).toEqual({ host: "2001:db8::1", port: 22 });
  });

  it("rifiuta endpoint ambigui e porta fuori intervallo", () => {
    for (const host of ["https://ssh.example.test", "ssh.example.test/path", "ssh host"]) {
      expect(() => parseDatabaseSshEndpoint({ host, port: 22 })).toThrow();
    }
    expect(() => parseDatabaseSshEndpoint({ host: "ssh.example.test", port: 65536 })).toThrow(/porta SSH/u);
  });

  it("converte la chiave SHA-256 nel formato impronta mostrato all’utente", () => {
    expect(sshFingerprintFromSha256Hex("00".repeat(32))).toBe(`SHA256:${"A".repeat(43)}`);
    expect(() => sshFingerprintFromSha256Hex("00".repeat(31))).toThrow(/Impronta/u);
  });
});
