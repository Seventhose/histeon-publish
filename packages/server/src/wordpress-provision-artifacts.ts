import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readZipSource, HistosPublishError } from "@histos-publish/core";
import type { VerifiedWordPressCoreRelease } from "./wordpress-core-release.js";
import type { WordPressProvisionSnapshot } from "./wordpress-provisioner.js";

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 20_000;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface VerifiedHistosPluginRelease {
  version: string;
  wordpressMinimum: string;
  phpMinimum: string;
  archiveSha256: string;
  files: Array<{ path: string; bytes: Buffer; sha256: string }>;
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.includes("\\") && !/[\0\r\n]/u.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export async function readVerifiedHistosPluginRelease(archivePath: string, checksumPath = `${archivePath}.sha256`): Promise<VerifiedHistosPluginRelease> {
  let archive: Buffer;
  let sidecar: string;
  try {
    archive = await readFile(archivePath);
    sidecar = await readFile(checksumPath, "utf8");
  } catch {
    throw new HistosPublishError("Il pacchetto Histeon per WordPress non è incluso o non è leggibile. Ricostruisci l’app desktop.", "wordpress-plugin-package-missing", 500);
  }
  const expectedArchiveHash = /^([a-f0-9]{64})  histos-wordpress-plugin\.zip\s*$/u.exec(sidecar)?.[1];
  const archiveSha256 = sha256(archive);
  if (!expectedArchiveHash || expectedArchiveHash !== archiveSha256 || archive.byteLength > MAX_ARTIFACT_BYTES) {
    throw new HistosPublishError("Il pacchetto Histeon per WordPress non supera il controllo SHA-256.", "wordpress-plugin-package-checksum-mismatch", 500);
  }

  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-histos-plugin-"));
  const tempArchive = path.join(workDirectory, "plugin.zip");
  try {
    await chmod(workDirectory, 0o700);
    await writeFile(tempArchive, archive, { flag: "wx", mode: 0o600 });
    const extracted = await readZipSource(tempArchive, { maxFiles: 512, maxBytes: MAX_ARTIFACT_BYTES });
    if (extracted.findings.some((finding) => finding.severity === "block") || extracted.strippedRoot) {
      throw new HistosPublishError("Il pacchetto Histeon contiene percorsi non sicuri o una struttura inattesa.", "wordpress-plugin-package-invalid", 500);
    }
    const manifestFile = extracted.files.find((file) => file.path === "histos-publish-manifest.json");
    if (!manifestFile) throw new HistosPublishError("Il pacchetto Histeon non contiene il manifest di provenienza.", "wordpress-plugin-package-invalid", 500);
    let manifest: unknown;
    try { manifest = JSON.parse(manifestFile.bytes.toString("utf8")); }
    catch { throw new HistosPublishError("Il manifest del pacchetto Histeon non è JSON valido.", "wordpress-plugin-package-invalid", 500); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new HistosPublishError("Il manifest del pacchetto Histeon non è valido.", "wordpress-plugin-package-invalid", 500);
    const entry = manifest as Record<string, unknown>;
    const version = typeof entry.pluginVersion === "string" ? entry.pluginVersion : "";
    const wordpressMinimum = typeof entry.wordpressMinimum === "string" ? entry.wordpressMinimum : "";
    const phpMinimum = typeof entry.phpMinimum === "string" ? entry.phpMinimum : "";
    const entries = Array.isArray(entry.files) ? entry.files : [];
    if (entry.format !== "histos-wordpress-plugin-package" || entry.version !== 1 || !/^\d+\.\d+\.\d+$/u.test(version) || !/^\d+\.\d+(?:\.\d+)?$/u.test(wordpressMinimum) || !/^\d+\.\d+(?:\.\d+)?$/u.test(phpMinimum) || entries.length !== extracted.files.length - 1 || entries.length > 512) {
      throw new HistosPublishError("Il manifest del pacchetto Histeon non coincide con i file inclusi.", "wordpress-plugin-package-invalid", 500);
    }
    const indexed = new Map<string, { bytes: number; sha256: string }>();
    for (const item of entries) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new HistosPublishError("Il manifest Histeon contiene una voce non valida.", "wordpress-plugin-package-invalid", 500);
      const file = item as Record<string, unknown>;
      if (typeof file.path !== "string" || !safeRelativePath(file.path) || !file.path.startsWith("xb/") || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256) || indexed.has(file.path)) {
        throw new HistosPublishError("Il manifest Histeon contiene un percorso, una dimensione o un hash non valido.", "wordpress-plugin-package-invalid", 500);
      }
      indexed.set(file.path, { bytes: file.bytes, sha256: file.sha256 });
    }
    const files: VerifiedHistosPluginRelease["files"] = [];
    for (const file of extracted.files) {
      if (file.path === "histos-publish-manifest.json") continue;
      const listed = indexed.get(file.path);
      const actual = sha256(file.bytes);
      if (!listed || listed.bytes !== file.bytes.byteLength || listed.sha256 !== actual) throw new HistosPublishError(`Il file ${file.path} non corrisponde al manifest del pacchetto Histeon.`, "wordpress-plugin-package-checksum-mismatch", 500);
      if (file.path === "xb/SOURCE-PROVENANCE.json") continue;
      files.push({ path: file.path.slice("xb/".length), bytes: file.bytes, sha256: actual });
    }
    if (indexed.size !== entries.length || !files.some((file) => file.path === "xb.php") || !files.some((file) => file.path === "LICENSE") || files.length === 0) {
      throw new HistosPublishError("Il pacchetto Histeon non contiene il runtime del plugin completo.", "wordpress-plugin-package-invalid", 500);
    }
    return { version, wordpressMinimum, phpMinimum, archiveSha256, files: files.sort((left, right) => left.path.localeCompare(right.path, "en")) };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function persistWordPressProvisionArtifacts(directory: string, wordpress: VerifiedWordPressCoreRelease, histos: VerifiedHistosPluginRelease): Promise<Pick<WordPressProvisionSnapshot, "wordpress" | "histos">> {
  if (wordpress.files.length === 0 || histos.files.length === 0 || wordpress.files.length + histos.files.length > MAX_ARTIFACT_FILES) throw new HistosPublishError("I pacchetti di installazione superano i limiti consentiti.", "wordpress-provision-artifacts-too-large", 413);
  const all = [
    ...wordpress.files.map((file) => ({ root: "wordpress", path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    ...histos.files.map((file) => ({ root: "histos", path: file.path, bytes: file.bytes, sha256: file.sha256 })),
  ];
  const totalBytes = all.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_ARTIFACT_BYTES || all.some((file) => !safeRelativePath(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256) || sha256(file.bytes) !== file.sha256)) throw new HistosPublishError("Il contenuto dei pacchetti di installazione non supera i controlli d’integrità.", "wordpress-provision-artifacts-invalid", 500);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const file of all) {
    const destination = path.join(directory, file.root, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
  }
  return {
    wordpress: {
      version: wordpress.version,
      phpMinimum: wordpress.phpMinimum,
      mysqlMinimum: wordpress.mysqlMinimum,
      archiveSha256: wordpress.archiveSha256,
      files: wordpress.files.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes: bytes.byteLength, sha256: digest })),
    },
    histos: {
      version: histos.version,
    wordpressMinimum: histos.wordpressMinimum,
    phpMinimum: histos.phpMinimum,
      archiveSha256: histos.archiveSha256,
      files: histos.files.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes: bytes.byteLength, sha256: digest })),
    },
  };
}

export async function readWordPressProvisionArtifacts(directory: string, snapshot: WordPressProvisionSnapshot): Promise<Array<{ path: string; bytes: Buffer }>> {
  const root = await realpath(directory).catch(() => {
    throw new HistosPublishError("I file verificati del piano WordPress non sono più disponibili. Crea un nuovo piano.", "wordpress-provision-artifacts-missing", 409);
  });
  const output: Array<{ path: string; bytes: Buffer }> = [];
  const readGroup = async (group: "wordpress" | "histos", entries: Array<{ path: string; bytes: number; sha256: string }>) => {
    for (const entry of entries) {
      if (!safeRelativePath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new HistosPublishError("Il manifest locale del piano WordPress non è valido.", "wordpress-provision-artifacts-invalid", 500);
      const absolute = path.resolve(root, group, ...entry.path.split("/"));
      if (!absolute.startsWith(`${root}${path.sep}`)) throw new HistosPublishError("Un percorso del piano WordPress esce dalla cartella privata.", "wordpress-provision-artifacts-invalid", 500);
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) throw new HistosPublishError(`Il file verificato ${entry.path} non è più disponibile o ha dimensione diversa.`, "wordpress-provision-artifacts-changed", 409);
      const bytes = await readFile(absolute);
      if (sha256(bytes) !== entry.sha256) throw new HistosPublishError(`Il file verificato ${entry.path} è cambiato dopo la preparazione del piano.`, "wordpress-provision-artifacts-changed", 409);
      output.push({ path: group === "wordpress" ? entry.path : `wp-content/plugins/xb/${entry.path}`, bytes });
    }
  };
  await readGroup("wordpress", snapshot.wordpress.files);
  await readGroup("histos", snapshot.histos.files);
  output.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return output;
}
