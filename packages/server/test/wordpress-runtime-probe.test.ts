import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStaticHostingSettings } from "../src/static-hosting.js";
import { buildWordPressPhpProbe, parseWordPressPhpProbeResponse, probeWordPressPhpRuntime, type TemporaryHostingFileRunner, type WordPressRuntimePost } from "../src/wordpress-runtime-probe.js";

const settings = () => parseStaticHostingSettings({
  protocol: "ftps",
  host: "ftp.example.test",
  port: 21,
  remoteDirectory: "/public_html/wp",
  publicUrl: "https://wp.example.test/cms",
});
const credentials = { username: "wp-user", password: "synthetic-password" };
const database = { host: "db.example.test", port: 3306, databaseName: "cms", username: "db-user", password: "synthetic-db-password", caCertificate: "" };
const response = (phpVersion: string, probe = "histos-wordpress-runtime-v1", missingRequiredExtensions: string[] = [], missingRecommendedExtensions: string[] = [], databaseTlsVerified = true, databaseTlsFailure = "") => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: Buffer.from(JSON.stringify({ probe, phpVersion, missingRequiredExtensions, missingRecommendedExtensions, databaseTlsVerified, databaseTlsFailure })),
});

describe("controllo runtime PHP WordPress", () => {
  it("inserisce nel file solo l’hash del nonce e una scadenza breve", () => {
    const nonce = "a".repeat(64);
    const file = buildWordPressPhpProbe(nonce, 2_000, "c".repeat(64));
    const source = file.toString("utf8");
    expect(source).toContain(createHash("sha256").update(nonce).digest("hex"));
    expect(source).not.toContain(nonce);
    expect(source).toContain("time() > 2000");
    expect(source).toContain("PHP_VERSION");
    expect(source).toContain("mysqli_ssl_set");
    expect(source).toContain("SHOW STATUS LIKE 'Ssl_cipher'");
    expect(source).toContain("databaseTlsVerified");
    expect(source).not.toContain(database.password);
    expect(source).not.toContain("wp-config");
  });

  it("distingue minimo PHP, versione raccomandata ed estensioni necessarie", () => {
    expect(parseWordPressPhpProbeResponse(200, "application/json; charset=utf-8", response("8.3.1").body))
      .toEqual({ phpVersion: "8.3.1", phpSupported: true, phpRecommended: false, missingRequiredExtensions: [], missingRecommendedExtensions: [], databaseTlsVerified: true, databaseTlsFailure: null });
    expect(parseWordPressPhpProbeResponse(200, "application/json", response("8.2.99").body))
      .toEqual({ phpVersion: "8.2.99", phpSupported: false, phpRecommended: false, missingRequiredExtensions: [], missingRecommendedExtensions: [], databaseTlsVerified: true, databaseTlsFailure: null });
    expect(parseWordPressPhpProbeResponse(200, "application/json", response("7.3.33").body))
      .toMatchObject({ phpVersion: "7.3.33", phpSupported: false, phpRecommended: false });
    expect(parseWordPressPhpProbeResponse(200, "application/json", response("8.4.1", "histos-wordpress-runtime-v1", ["mysqli"], ["curl"]).body))
      .toMatchObject({ phpSupported: false, phpRecommended: true, missingRequiredExtensions: ["mysqli"], missingRecommendedExtensions: ["curl"], databaseTlsVerified: true });
    expect(parseWordPressPhpProbeResponse(200, "application/json", response("8.4.1", "histos-wordpress-runtime-v1", [], [], false, "client-unsupported").body))
      .toMatchObject({ phpSupported: true, databaseTlsVerified: false, databaseTlsFailure: "client-unsupported" });
    expect(() => parseWordPressPhpProbeResponse(200, "text/plain", Buffer.from("<?php echo PHP_VERSION;")))
      .toThrowError(expect.objectContaining({ code: "wordpress-runtime-response-invalid" }));
    expect(() => parseWordPressPhpProbeResponse(503, "text/plain", Buffer.from("histos-runtime-missing-required-extension")))
      .toThrowError(expect.objectContaining({ code: "wordpress-runtime-required-extensions-missing" }));
    expect(() => parseWordPressPhpProbeResponse(200, "application/json", response("8.3.1", "other").body))
      .toThrowError(expect.objectContaining({ code: "wordpress-runtime-not-executed" }));
  });

  it("usa HTTPS, invia il nonce solo nel POST e lascia al trasporto il controllo di pulizia", async () => {
    const nonce = "b".repeat(64);
    let uploaded: { fileName: string; bytes: Buffer } | undefined;
    let posted: { url: URL; payload: unknown } | undefined;
    const proof = "d".repeat(64);
    const temporaryFileRunner: TemporaryHostingFileRunner = async (input) => {
      uploaded = { fileName: input.fileName, bytes: input.bytes };
      return input.run();
    };
    const postJson: WordPressRuntimePost = async (url, payload) => {
      if ("phase" in payload) return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ probe: "histos-wordpress-runtime-proof-v1", proof })) };
      posted = { url, payload };
      return response("8.4.2");
    };

    const result = await probeWordPressPhpRuntime({ settings: settings(), credentials, database }, {
      temporaryFileRunner,
      postJson,
      nonce: () => nonce,
      proof: () => proof,
      now: () => 10_000,
    });

    expect(result).toEqual({ phpChecked: true, phpVersion: "8.4.2", phpSupported: true, phpRecommended: true, missingRequiredExtensions: [], missingRecommendedExtensions: [], databaseTlsVerified: true, databaseTlsFailure: null, httpsAvailable: true, wordpressMinimumPhp: ">= 7.4", requiredPhp: ">= 8.3", recommendedPhp: ">= 8.4", status: "supported" });
    expect(uploaded?.fileName).toMatch(/^histos-runtime-check-[a-f0-9]{32}\.php$/u);
    expect(uploaded?.bytes.toString("utf8")).not.toContain(nonce);
    expect(uploaded?.bytes.toString("utf8")).toContain(createHash("sha256").update(nonce).digest("hex"));
    expect(posted?.url.href).toMatch(/^https:\/\/wp\.example\.test\/cms\/histos-runtime-check-[a-f0-9]{32}\.php$/u);
    expect(posted?.url.href).not.toContain(nonce);
    expect(posted?.payload).toEqual({ nonce, database });
    expect(uploaded?.bytes.toString("utf8")).not.toContain(database.password);
  });

  it("non invia le credenziali del database a un server che non esegue il file caricato", async () => {
    const temporaryFileRunner: TemporaryHostingFileRunner = async (input) => input.run();
    for (const answer of [
      { status: 200, contentType: "text/html", body: Buffer.from("<html>parked</html>") },
      { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ probe: "histos-wordpress-runtime-proof-v1", proof: "e".repeat(64) })) },
      { status: 404, contentType: "text/plain", body: Buffer.alloc(0) },
    ]) {
      const payloads: unknown[] = [];
      const postJson: WordPressRuntimePost = async (_url, payload) => { payloads.push(payload); return answer; };
      await expect(probeWordPressPhpRuntime({ settings: settings(), credentials, database }, { temporaryFileRunner, postJson, nonce: () => "f".repeat(64), proof: () => "d".repeat(64), now: () => 10_000 }))
        .rejects.toMatchObject({ code: "wordpress-runtime-url-mismatch" });
      expect(JSON.stringify(payloads)).not.toContain(database.password);
      expect(payloads).toEqual([{ nonce: "f".repeat(64), phase: "proof" }]);
    }
  });

  it("si ferma prima di caricare file quando manca HTTPS o manca l’URL pubblico", async () => {
    const temporaryFileRunner: TemporaryHostingFileRunner = async () => { throw new Error("must not upload"); };
    await expect(probeWordPressPhpRuntime({ settings: parseStaticHostingSettings({ protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/wp" }), credentials, database }, { temporaryFileRunner }))
      .rejects.toMatchObject({ code: "wordpress-runtime-url-missing" });
    await expect(probeWordPressPhpRuntime({ settings: parseStaticHostingSettings({ protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/wp", publicUrl: "http://wp.example.test" }), credentials, database }, { temporaryFileRunner }))
      .rejects.toMatchObject({ code: "wordpress-runtime-https-required" });
  });
});
