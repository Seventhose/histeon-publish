import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SafeHttpClient, HistosPublishError, readZipSource } from "@histos-publish/core";

const VERSION_CHECK_URL = "https://api.wordpress.org/core/version-check/1.7/?locale=en_US";
const CHECKSUMS_ORIGIN = "https://api.wordpress.org";
const DOWNLOAD_ORIGIN = "https://downloads.wordpress.org";
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_CORE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_CORE_FILES = 20_000;

export interface VerifiedWordPressCoreRelease {
  version: string;
  locale: "en_US";
  phpMinimum: string;
  mysqlMinimum: string;
  archiveSha256: string;
  files: Array<{ path: string; bytes: Buffer; sha256: string }>;
}

export interface WordPressCoreReleaseResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export type WordPressCoreGet = (url: URL, maxBytes: number) => Promise<WordPressCoreReleaseResponse>;

function safeHttpGet(url: URL, maxBytes: number): Promise<WordPressCoreReleaseResponse> {
  const client = new SafeHttpClient({ origin: url.origin, userAgent: "HistosPublish-WordPress-Provisioning/1.0", timeoutMs: 30_000, delayMs: 0, strictOrigin: true });
  return client.get(url, { maxBytes }).then((response) => ({
    status: response.status,
    contentType: Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] ?? "" : response.headers["content-type"] ?? "",
    body: response.body,
  }));
}

function requireJsonResponse(response: WordPressCoreReleaseResponse, label: string): unknown {
  const mediaType = response.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (response.status !== 200 || mediaType !== "application/json" || response.body.byteLength > MAX_API_BYTES) {
    throw new HistosPublishError(`WordPress.org non ha restituito ${label} in un formato valido.`, "wordpress-release-metadata-invalid", 502);
  }
  try { return JSON.parse(response.body.toString("utf8")) as unknown; }
  catch { throw new HistosPublishError(`I dati ${label} di WordPress.org non sono JSON valido.`, "wordpress-release-metadata-invalid", 502); }
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^(?:[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u.test(value);
}

function releaseOffer(value: unknown): { version: string; downloadUrl: URL; phpMinimum: string; mysqlMinimum: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistosPublishError("WordPress.org non ha indicato una release stabile valida.", "wordpress-release-metadata-invalid", 502);
  const offers = (value as Record<string, unknown>).offers;
  if (!Array.isArray(offers) || offers.length === 0 || !offers[0] || typeof offers[0] !== "object" || Array.isArray(offers[0])) {
    throw new HistosPublishError("WordPress.org non ha indicato una release stabile valida.", "wordpress-release-metadata-invalid", 502);
  }
  const offer = offers[0] as Record<string, unknown>;
  const version = offer.current ?? offer.version;
  if (!validVersion(version) || typeof offer.download !== "string" || typeof offer.php_version !== "string" || typeof offer.mysql_version !== "string") {
    throw new HistosPublishError("La release WordPress non contiene versione e requisiti validi.", "wordpress-release-metadata-invalid", 502);
  }
  let downloadUrl: URL;
  try { downloadUrl = new URL(offer.download); }
  catch { throw new HistosPublishError("L’indirizzo della release WordPress non è valido.", "wordpress-release-url-invalid", 502); }
  if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "downloads.wordpress.org" || downloadUrl.pathname !== `/release/wordpress-${version}.zip` || downloadUrl.search || downloadUrl.username || downloadUrl.password) {
    throw new HistosPublishError("WordPress.org ha indicato un archivio fuori dal percorso di release ufficiale.", "wordpress-release-url-invalid", 502);
  }
  return { version, downloadUrl, phpMinimum: offer.php_version, mysqlMinimum: offer.mysql_version };
}

function safeChecksumMap(value: unknown): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistosPublishError("WordPress.org non ha restituito i checksum dei file core.", "wordpress-release-checksums-invalid", 502);
  const raw = (value as Record<string, unknown>).checksums;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HistosPublishError("WordPress.org non ha restituito i checksum dei file core.", "wordpress-release-checksums-invalid", 502);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length < 100 || entries.length > MAX_CORE_FILES) throw new HistosPublishError("Il numero dei checksum WordPress non è plausibile.", "wordpress-release-checksums-invalid", 502);
  const checksums = new Map<string, string>();
  for (const [filePath, checksum] of entries) {
    if (!/^[A-Za-z0-9._/-]{1,255}$/u.test(filePath) || filePath.startsWith("/") || filePath.split("/").some((part) => !part || part === "." || part === "..") || typeof checksum !== "string" || !/^[a-f0-9]{32}$/iu.test(checksum)) {
      throw new HistosPublishError("WordPress.org ha restituito un checksum o un percorso non valido.", "wordpress-release-checksums-invalid", 502);
    }
    checksums.set(filePath, checksum.toLowerCase());
  }
  return checksums;
}

async function packageFiles(archive: Buffer, checksums: Map<string, string>): Promise<VerifiedWordPressCoreRelease["files"]> {
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-wordpress-core-"));
  const archivePath = path.join(workDirectory, "wordpress.zip");
  try {
    await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
    const extracted = await readZipSource(archivePath, { maxFiles: MAX_CORE_FILES, maxBytes: MAX_CORE_ARCHIVE_BYTES });
    if (extracted.findings.some((finding) => finding.severity === "block") || extracted.files.length !== checksums.size) {
      throw new HistosPublishError("L’archivio core WordPress non corrisponde alla lista ufficiale dei file.", "wordpress-release-archive-mismatch", 502);
    }
    const prefix = "wordpress/";
    const output: VerifiedWordPressCoreRelease["files"] = [];
    const seen = new Set<string>();
    for (const file of extracted.files) {
      if (!file.path.startsWith(prefix)) throw new HistosPublishError("L’archivio core contiene file fuori dalla cartella wordpress/.", "wordpress-release-archive-mismatch", 502);
      const relativePath = file.path.slice(prefix.length);
      if (!relativePath || seen.has(relativePath)) throw new HistosPublishError("L’archivio core contiene percorsi duplicati o vuoti.", "wordpress-release-archive-mismatch", 502);
      seen.add(relativePath);
      const expectedMd5 = checksums.get(relativePath);
      const actualMd5 = createHash("md5").update(file.bytes).digest("hex");
      if (!expectedMd5 || actualMd5 !== expectedMd5) throw new HistosPublishError(`Il checksum ufficiale non corrisponde per il file WordPress ${relativePath}.`, "wordpress-release-checksum-mismatch", 502);
      output.push({ path: relativePath, bytes: file.bytes, sha256: createHash("sha256").update(file.bytes).digest("hex") });
    }
    if (seen.size !== checksums.size || !seen.has("index.php") || !seen.has("wp-load.php") || !seen.has("wp-admin/install.php")) {
      throw new HistosPublishError("L’archivio non contiene una struttura WordPress completa.", "wordpress-release-archive-mismatch", 502);
    }
    return output.sort((left, right) => left.path.localeCompare(right.path, "en"));
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function downloadVerifiedWordPressCore(get: WordPressCoreGet = safeHttpGet): Promise<VerifiedWordPressCoreRelease> {
  const offerResponse = await get(new URL(VERSION_CHECK_URL), MAX_API_BYTES);
  const offer = releaseOffer(requireJsonResponse(offerResponse, "la versione stabile"));
  const checksumUrl = new URL("/core/checksums/1.0/", CHECKSUMS_ORIGIN);
  checksumUrl.searchParams.set("version", offer.version);
  checksumUrl.searchParams.set("locale", "en_US");
  const checksumResponse = await get(checksumUrl, MAX_API_BYTES);
  const checksums = safeChecksumMap(requireJsonResponse(checksumResponse, "i checksum"));
  if (checksums.size > MAX_CORE_FILES) throw new HistosPublishError("La release WordPress supera il limite di file installabili.", "wordpress-release-too-large", 502);
  const archiveResponse = await get(offer.downloadUrl, MAX_CORE_ARCHIVE_BYTES);
  if (archiveResponse.status !== 200 || !/^application\/(?:zip|x-zip-compressed)$|^application\/octet-stream$/iu.test(archiveResponse.contentType.split(";", 1)[0]?.trim() ?? "") || archiveResponse.body.byteLength === 0 || archiveResponse.body.byteLength > MAX_CORE_ARCHIVE_BYTES) {
    throw new HistosPublishError("L’archivio core WordPress non è stato scaricato in modo valido.", "wordpress-release-download-invalid", 502);
  }
  const files = await packageFiles(archiveResponse.body, checksums);
  return {
    version: offer.version,
    locale: "en_US",
    phpMinimum: offer.phpMinimum,
    mysqlMinimum: offer.mysqlMinimum,
    archiveSha256: createHash("sha256").update(archiveResponse.body).digest("hex"),
    files,
  };
}
