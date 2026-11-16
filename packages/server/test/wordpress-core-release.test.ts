import { createHash } from "node:crypto";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { downloadVerifiedWordPressCore, type WordPressCoreGet, type WordPressCoreReleaseResponse } from "../src/wordpress-core-release.js";

const checksum = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function zip(files: Array<{ path: string; bytes: Buffer }>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.once("error", reject);
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files) archive.addBuffer(file.bytes, file.path);
  archive.end();
  return ended;
}

function makeFiles(): Array<{ path: string; bytes: Buffer }> {
  return [
    { path: "wordpress/index.php", bytes: Buffer.from("<?php require __DIR__ . '/wp-blog-header.php';") },
    { path: "wordpress/wp-load.php", bytes: Buffer.from("<?php define('ABSPATH', __DIR__ . '/');") },
    { path: "wordpress/wp-admin/install.php", bytes: Buffer.from("<?php require_once __DIR__ . '/../wp-load.php';") },
    ...Array.from({ length: 100 }, (_, index) => ({ path: `wordpress/wp-includes/test-${index}.php`, bytes: Buffer.from(`<?php // fixture ${index}`) })),
  ];
}

function fakeGet(files: Array<{ path: string; bytes: Buffer }>, archive: Buffer, offerOverrides: Record<string, unknown> = {}, alterChecksum = false): WordPressCoreGet {
  const checksums = Object.fromEntries(files.map(({ path, bytes }) => [path.replace(/^wordpress\//u, ""), checksum(bytes)]));
  if (alterChecksum) checksums["index.php"] = "f".repeat(32);
  const responses = new Map<string, WordPressCoreReleaseResponse>([
    ["https://api.wordpress.org/core/version-check/1.7/?locale=en_US", {
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: Buffer.from(JSON.stringify({ offers: [{ current: "7.1.3", version: "7.1.3", download: "https://downloads.wordpress.org/release/wordpress-7.1.3.zip", php_version: "8.0.0", mysql_version: "8.0", ...offerOverrides }] })),
    }],
    ["https://api.wordpress.org/core/checksums/1.0/?version=7.1.3&locale=en_US", {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ checksums })),
    }],
    ["https://downloads.wordpress.org/release/wordpress-7.1.3.zip", {
      status: 200,
      contentType: "application/zip",
      body: archive,
    }],
  ]);
  return async (url) => {
    const response = responses.get(url.href);
    if (!response) throw new Error(`Unexpected request: ${url.href}`);
    return response;
  };
}

describe("release core WordPress verificata", () => {
  it("fissa release e requisiti ufficiali, controlla ogni file e prepara percorsi senza wordpress/", async () => {
    const files = makeFiles();
    const archive = await zip(files);
    const result = await downloadVerifiedWordPressCore(fakeGet(files, archive));

    expect(result).toMatchObject({ version: "7.1.3", locale: "en_US", phpMinimum: "8.0.0", mysqlMinimum: "8.0" });
    expect(result.archiveSha256).toBe(sha256(archive));
    expect(result.files).toHaveLength(files.length);
    expect(result.files[0]).toMatchObject({ path: "index.php", sha256: sha256(files[0]!.bytes) });
    expect(result.files.some((file) => file.path.startsWith("wordpress/"))).toBe(false);
  });

  it("blocca checksum non corrispondenti e URL di download che escono dalla release ufficiale", async () => {
    const files = makeFiles();
    const archive = await zip(files);
    await expect(downloadVerifiedWordPressCore(fakeGet(files, archive, {}, true)))
      .rejects.toMatchObject({ code: "wordpress-release-checksum-mismatch" });
    await expect(downloadVerifiedWordPressCore(fakeGet(files, archive, { download: "https://attacker.example/wordpress-7.1.3.zip" })))
      .rejects.toMatchObject({ code: "wordpress-release-url-invalid" });
  });

  it("rifiuta checksum incompleti e ZIP con file fuori dalla cartella WordPress", async () => {
    const files = makeFiles();
    const extraFile = { path: "other/rogue.php", bytes: Buffer.from("<?php exit;") };
    const archive = await zip([...files, extraFile]);
    await expect(downloadVerifiedWordPressCore(fakeGet(files, archive)))
      .rejects.toMatchObject({ code: "wordpress-release-archive-mismatch" });
    await expect(downloadVerifiedWordPressCore(fakeGet(files.slice(0, 10), archive)))
      .rejects.toThrow(HistosPublishError);
  });
});
