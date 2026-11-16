import path from "node:path";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_INVALID = /[<>:"|?*]/u;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function safeBundlePath(value: string): boolean {
  return value.startsWith("/")
    && !value.includes("..")
    && !value.includes("\\")
    && !value.includes("?")
    && !value.includes("#")
    && !hasControlCharacters(value)
    && !/\.php(?:\/|$)/iu.test(value)
    && Buffer.byteLength(value, "utf8") < 1024;
}

export function pageFileForPath(value: string): string | null {
  if (!safeBundlePath(value)) return null;
  const trimmed = value.replace(/^\/+|\/+$/gu, "");
  return trimmed === "" ? "index.html" : `${trimmed}/index.html`;
}

export function fileForPath(value: string): string | null {
  if (!safeBundlePath(value)) return null;
  const trimmed = value.replace(/^\/+|\/+$/gu, "");
  return trimmed === "" ? "index.html" : trimmed;
}

export function normalizeRelativePath(value: string): { path: string; changed: boolean } | null {
  const slashed = value.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/u.test(slashed) || hasControlCharacters(slashed)) return null;
  const normalized = slashed.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." || WINDOWS_INVALID.test(part) || part.endsWith(".") || part.endsWith(" ") || WINDOWS_RESERVED.test(part))) return null;
  return { path: segments.join("/"), changed: normalized !== slashed };
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function relativeUrl(fromOutputPath: string, toOutputPath: string): string {
  const fromDirectory = path.posix.dirname(fromOutputPath);
  const relative = path.posix.relative(fromDirectory, toOutputPath);
  return (relative || path.posix.basename(toOutputPath)).split("/").map(encodeURIComponent).join("/");
}

export function safeZipEntryName(name: string): { path: string; changed: boolean } | null {
  if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/u.test(name) || hasControlCharacters(name)) return null;
  const directoryEntry = name.endsWith("/");
  const trimmed = directoryEntry ? name.slice(0, -1) : name;
  if (trimmed === "") return null;
  const safe = normalizeRelativePath(trimmed);
  if (!safe) return null;
  return { path: safe.path + (directoryEntry ? "/" : ""), changed: safe.changed };
}
