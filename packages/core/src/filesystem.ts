import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { isPathInside, normalizeRelativePath } from "./paths.js";
import type { Finding } from "./types.js";

export const DEFAULT_MAX_FILES = 20_000;
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_EXCLUDES = ["node_modules/**", ".git/**", ".DS_Store", "Thumbs.db", "desktop.ini"];

export interface SourceFile {
  path: string;
  bytes: Buffer;
  size?: number;
  sourcePath?: string;
}

export interface ReadSourceOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  maxFiles?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ReadSourceResult {
  files: SourceFile[];
  skipped: string[];
  findings: Finding[];
}

function globMatches(value: string, pattern: string): boolean {
  const candidate = value.replaceAll("\\", "/");
  const glob = pattern.replaceAll("\\", "/");
  if (glob.length > 512) return false;
  const rows = Array.from({ length: candidate.length + 1 }, () => new Uint8Array(glob.length + 1));
  const firstRow = rows[0];
  if (!firstRow) return false;
  firstRow[0] = 1;
  for (let patternIndex = 0; patternIndex < glob.length; patternIndex += 1) {
    const token = glob[patternIndex] ?? "";
    const nextToken = glob[patternIndex + 1] ?? "";
    const afterGlobstarSlash = token === "*" && nextToken === "*" && glob[patternIndex + 2] === "/";
    const globstar = token === "*" && nextToken === "*";
    const singleStar = token === "*" && !globstar;
    const doubleStarEnd = globstar ? patternIndex + 2 : patternIndex + 1;
    for (let valueIndex = 0; valueIndex <= candidate.length; valueIndex += 1) {
      const currentRow = rows[valueIndex];
      const nextRow = rows[valueIndex + 1];
      if (currentRow?.[patternIndex] !== 1) continue;
      if (afterGlobstarSlash) currentRow[patternIndex + 3] = 1;
      else if (globstar) currentRow[doubleStarEnd] = 1;
      else if (singleStar) currentRow[patternIndex + 1] = 1;
      else if (token === "?") {
        if (valueIndex < candidate.length && candidate[valueIndex] !== "/" && nextRow) nextRow[patternIndex + 1] = 1;
      } else if (valueIndex < candidate.length && candidate[valueIndex] === token) {
        if (nextRow) nextRow[patternIndex + 1] = 1;
      }
      if ((globstar || singleStar) && valueIndex < candidate.length && (globstar || candidate[valueIndex] !== "/")) {
        if (nextRow) nextRow[patternIndex] = 1;
      }
    }
    if (globstar) patternIndex += afterGlobstarSlash ? 2 : 1;
  }
  return rows.at(-1)?.[glob.length] === 1;
}

function isExcludedPath(pathName: string, exclude: readonly string[]): boolean {
  if (pathName.split("/").some((segment) => segment.startsWith("."))) return true;
  const excluded = [...DEFAULT_EXCLUDES, ...exclude].some((pattern) => globMatches(pathName, pattern));
  return excluded;
}

/** The default excludes (version folders, dependencies, system files), the folder itself included: `.git` as `.git/**`. */
function isDefaultExcluded(pathName: string): boolean {
  return DEFAULT_EXCLUDES.some((pattern) => globMatches(pathName, pattern) || globMatches(`${pathName}/`, pattern));
}

function isIncludedFile(pathName: string, include: readonly string[]): boolean {
  return include.length === 0 || include.some((pattern) => globMatches(pathName, pattern));
}

export async function readDirectorySource(rootPath: string, options: ReadSourceOptions = {}): Promise<ReadSourceResult> {
  const root = await realpath(rootPath).catch(() => {
    throw new HistosPublishError("La cartella sorgente non esiste o non è accessibile.", "source-unreachable", 5);
  });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new HistosPublishError("La sorgente deve essere una cartella reale, non un collegamento simbolico.", "source-invalid", 2);
  }

  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const files: SourceFile[] = [];
  const skipped: string[] = [];
  const findings: Finding[] = [];
  const names = new Set<string>();
  let totalBytes = 0;

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    throwIfAborted(options.signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      throwIfAborted(options.signal);
      const rawPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const normalized = normalizeRelativePath(rawPath);
      if (!normalized) {
        skipped.push(rawPath);
        findings.push({ code: "unsafe-path", severity: "block", file: rawPath, message: "Il nome del file non è sicuro su Linux e Windows." });
        continue;
      }
      // The default excludes come first: a site kept in git has a .git folder, never published and never a block.
      if (isDefaultExcluded(normalized.path)) {
        skipped.push(normalized.path);
        continue;
      }
      if (normalized.path.split("/").some((segment) => /^\.env(?:\.|$)/iu.test(segment)
        || segment === ".git"
        || segment === ".htaccess"
        || segment === ".user.ini"
        || /^wp-config(?:-[^/]*)?\.php$/iu.test(segment)
        || /\.(?:sql|bak|log)$/iu.test(segment))) {
        findings.push({ code: "sensitive-file", severity: "block", file: normalized.path, message: "Il nome indica configurazione privata o metadati di versione." });
        skipped.push(normalized.path);
        continue;
      }
      if (normalized.path.split("/").some((segment) => /^\./u.test(segment))) {
        skipped.push(normalized.path);
        continue;
      }
      if (isExcludedPath(normalized.path, exclude)) {
        skipped.push(normalized.path);
        continue;
      }
      const absolutePath = path.join(directory, child.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        skipped.push(normalized.path);
        findings.push({ code: "symlink-skipped", severity: "warn", file: normalized.path, message: "Il collegamento simbolico è stato escluso dalla sorgente." });
        continue;
      }
      if (stat.isDirectory()) {
        await visit(absolutePath, normalized.path);
        continue;
      }
      if (!isIncludedFile(normalized.path, include)) {
        skipped.push(normalized.path);
        continue;
      }
      if (!stat.isFile()) {
        skipped.push(normalized.path);
        continue;
      }

      const collisionKey = normalized.path.toLocaleLowerCase("en-US");
      if (names.has(collisionKey)) {
        throw new HistosPublishError(`Collisione di nomi non sicura per Windows: ${normalized.path}`, "path-collision", 2);
      }
      names.add(collisionKey);
      if (normalized.changed) {
        findings.push({ code: "unicode-normalized", severity: "warn", file: normalized.path, message: "Il nome è stato normalizzato in Unicode NFC." });
      }
      if (files.length >= maxFiles) {
        throw new HistosPublishError(`La sorgente supera il limite di ${maxFiles} file.`, "source-too-many-files", 2);
      }
      if (totalBytes + stat.size > maxBytes) {
        throw new HistosPublishError(`La sorgente supera il limite di ${Math.floor(maxBytes / 1024 / 1024)} MiB.`, "source-too-large", 2);
      }
      const finalPath = await realpath(absolutePath);
      if (!isPathInside(root, finalPath)) {
        skipped.push(normalized.path);
        findings.push({ code: "path-escaped-root", severity: "block", file: normalized.path, message: "Il file esce dalla cartella sorgente consentita." });
        continue;
      }
      const bytes = await readFile(finalPath);
      totalBytes += bytes.byteLength;
      files.push({ path: normalized.path, bytes, sourcePath: finalPath });
    }
  };

  await visit(root, "");
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { files, skipped, findings };
}
