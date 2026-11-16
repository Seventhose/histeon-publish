import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { persistWordPressProvisionArtifacts, readVerifiedHistosPluginRelease, readWordPressProvisionArtifacts } from "../src/wordpress-provision-artifacts.js";
import type { VerifiedWordPressCoreRelease } from "../src/wordpress-core-release.js";
import type { WordPressProvisionSnapshot } from "../src/wordpress-provisioner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function zip(files: Array<{ path: string; bytes: Buffer }>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.once("error", reject);
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files) archive.addBuffer(file.bytes, file.path, { mtime: new Date("2026-01-01T00:00:00.000Z"), mode: 0o644 });
  archive.end();
  return ended;
}

async function writePluginPackage(directory: string): Promise<string> {
  const runtime = [
    { path: "xb/xb.php", bytes: Buffer.from("<?php // Histeon plugin entry") },
    { path: "xb/LICENSE", bytes: Buffer.from("GPL-3.0-or-later") },
    { path: "xb/SOURCE-PROVENANCE.json", bytes: Buffer.from("{}\n") },
  ];
  const manifest = Buffer.from(`${JSON.stringify({
    format: "histos-wordpress-plugin-package",
    version: 1,
    pluginVersion: "0.3.1",
    wordpressMinimum: "6.9",
    phpMinimum: "8.3",
    sourceCommit: "9bc212050403dd056ac21edfcff398b514e4a3c1",
    files: runtime.map(({ path: filePath, bytes }) => ({ path: filePath, bytes: bytes.byteLength, sha256: sha256(bytes) })),
  }, null, 2)}\n`);
  const archive = await zip([...runtime, { path: "histos-publish-manifest.json", bytes: manifest }]);
  const archivePath = path.join(directory, "histos-wordpress-plugin.zip");
  await writeFile(archivePath, archive, { mode: 0o600 });
  await writeFile(`${archivePath}.sha256`, `${sha256(archive)}  histos-wordpress-plugin.zip\n`, { mode: 0o600 });
  return archivePath;
}

describe("artefatti immutabili del provisioner WordPress", () => {
  it("verifica sidecar, manifest e ogni file prima di estrarre il runtime Histeon", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-wp-plugin-package-"));
    roots.push(directory);
    const archive = await writePluginPackage(directory);
    const plugin = await readVerifiedHistosPluginRelease(archive);
    expect(plugin).toMatchObject({ version: "0.3.1", wordpressMinimum: "6.9", phpMinimum: "8.3" });
    expect(plugin.files.map((file) => file.path)).toEqual(["LICENSE", "xb.php"]);
    await writeFile(`${archive}.sha256`, `${"0".repeat(64)}  histos-wordpress-plugin.zip\n`);
    await expect(readVerifiedHistosPluginRelease(archive)).rejects.toMatchObject({ code: "wordpress-plugin-package-checksum-mismatch" });
  });

  it("conserva i file dei pacchetti con permessi locali e verifica ogni byte prima dell’upload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-wp-artifact-store-"));
    roots.push(directory);
    const archivePath = await writePluginPackage(directory);
    const histos = await readVerifiedHistosPluginRelease(archivePath);
    const coreBytes = Buffer.from("<?php // verified WordPress core");
    const core: VerifiedWordPressCoreRelease = {
      version: "7.1.3", locale: "en_US", phpMinimum: "8.0", mysqlMinimum: "8.0",
      archiveSha256: "b".repeat(64),
      files: [{ path: "index.php", bytes: coreBytes, sha256: sha256(coreBytes) }],
    };
    const planId = "06d87a4f-2775-4a1b-8c67-b3cd3f0c6951";
    const artifactsDirectory = path.join(directory, "private", planId);
    const persisted = await persistWordPressProvisionArtifacts(artifactsDirectory, core, histos);
    const snapshot = {
      wordpress: persisted.wordpress,
      histos: { ...persisted.histos, wordpressMinimum: histos.wordpressMinimum, phpMinimum: histos.phpMinimum },
    } as WordPressProvisionSnapshot;
    const files = await readWordPressProvisionArtifacts(artifactsDirectory, snapshot);
    expect(files.map((file) => file.path)).toEqual(["index.php", "wp-content/plugins/xb/LICENSE", "wp-content/plugins/xb/xb.php"]);
    expect(files.find((file) => file.path === "index.php")?.bytes).toEqual(coreBytes);
    await writeFile(path.join(artifactsDirectory, "wordpress", "index.php"), Buffer.from("changed"));
    await expect(readWordPressProvisionArtifacts(artifactsDirectory, snapshot)).rejects.toMatchObject({ code: "wordpress-provision-artifacts-changed" });
    const manifest = await readFile(`${archivePath}.sha256`, "utf8");
    expect(manifest).toMatch(/^[a-f0-9]{64}  histos-wordpress-plugin\.zip\n$/u);
  });
});
