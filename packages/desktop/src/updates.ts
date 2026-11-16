import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { chmod, lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Updates of the desktop app from the public GitHub releases (docs/spec/aggiornamenti-app.md). The repository is
 * public, so every request goes without a token and without any Authorization header. A release counts only if it is not a draft or a pre-release, its tag is
 * vX.Y.Z and it has `Histeon-Publish-X.Y.Z-linux-x64.AppImage` with its `.minisig`. Before the running AppImage is
 * replaced, the downloaded file must be signed by the release key (minisign: Ed25519 over BLAKE2b-512 of the file and
 * over the trusted comment) and the signed file name must be exactly that asset: an unsigned file is never installed.
 */

export const UPDATE_REPOSITORY = "Seventhose/histeon-publish";
/** Histeon's release key (id 7245FEACC0E94D12), the one that signs the plugins too. */
export const RELEASE_PUBLIC_KEY = "RWQSTenArP5FclHgI0qEErGDYUEQ6gL4cEhpgec49VKtqKfgl2TIAn5W";
export const MAX_APPIMAGE_BYTES = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const API = "https://api.github.com/repos/";
/** DER prefix of an Ed25519 SubjectPublicKeyInfo: the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseAsset { name: string; url: string }
export interface AppRelease { version: string; appImage: ReleaseAsset; signature: ReleaseAsset; page: string }

export class UpdateError extends Error {}

export function appImageName(version: string): string {
  return `Histeon-Publish-${version}-linux-x64.AppImage`;
}

/** Whether version a is newer than b (X.Y.Z, numerically). */
export function isNewer(a: string, b: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)?.slice(1).map(Number) ?? null;
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}

/** The release as the updater needs it, or null when anything is missing. Assets are read through the API URL. */
export function parseRelease(data: unknown, repository = UPDATE_REPOSITORY): AppRelease | null {
  if (!data || typeof data !== "object") return null;
  const release = data as { draft?: unknown; prerelease?: unknown; tag_name?: unknown; html_url?: unknown; assets?: unknown };
  if (release.draft || release.prerelease) return null;
  const version = /^v?(\d+\.\d+\.\d+)$/u.exec(typeof release.tag_name === "string" ? release.tag_name : "")?.[1];
  if (!version) return null;
  const assetPrefix = `${API}${repository}/releases/assets/`;
  const assets = new Map<string, string>();
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const { name, url } = (asset ?? {}) as { name?: unknown; url?: unknown };
    if (typeof name === "string" && typeof url === "string" && url.startsWith(assetPrefix) && /^\d+$/u.test(url.slice(assetPrefix.length))) assets.set(name, url);
  }
  const name = appImageName(version);
  const appImage = assets.get(name);
  const signature = assets.get(`${name}.minisig`);
  if (!appImage || !signature) return null;
  const page = typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : "";
  return { version, appImage: { name, url: appImage }, signature: { name: `${name}.minisig`, url: signature }, page };
}

/** The headers of every request: no credentials of any kind. */
function headers(accept: string): Record<string, string> {
  return { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Histeon-Publish-updater" };
}

export async function latestRelease(fetchImpl: FetchLike = fetch, repository = UPDATE_REPOSITORY): Promise<AppRelease | null> {
  const response = await fetchImpl(`${API}${repository}/releases/latest`, { headers: headers("application/vnd.github+json"), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status === 403 || response.status === 429) throw new UpdateError("GitHub non ha risposto alla richiesta (limite di richieste raggiunto): riprova più tardi.");
  if (response.status === 404) return null;
  if (!response.ok) throw new UpdateError(`GitHub ha risposto ${response.status}.`);
  return parseRelease(await response.json(), repository);
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new UpdateError("File troppo grande.");
  const reader = response.body?.getReader();
  if (!reader) throw new UpdateError("Risposta vuota.");
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new UpdateError("File troppo grande.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * A release asset of the public repository. GitHub answers the API URL with a redirect to a short-lived signed URL
 * on its download host, which only GitHub's hosts may be.
 */
export async function downloadAsset(url: string, limit: number, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  if (!url.startsWith(API)) throw new UpdateError("Indirizzo del file non ammesso.");
  const first = await fetchImpl(url, { headers: headers("application/octet-stream"), redirect: "manual", signal: AbortSignal.timeout(30_000) });
  let response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location") ?? "";
    let target: URL;
    try { target = new URL(location); } catch { throw new UpdateError("Reindirizzamento non valido."); }
    if (target.protocol !== "https:" || !(target.hostname === "github.com" || target.hostname.endsWith(".githubusercontent.com")) || target.username || target.password) {
      throw new UpdateError("Reindirizzamento verso un host non ammesso.");
    }
    response = await fetchImpl(target.href, { headers: { Accept: "application/octet-stream", "User-Agent": "Histeon-Publish-updater" }, redirect: "error", signal: AbortSignal.timeout(600_000) });
  }
  if (!response.ok) throw new UpdateError(`Download non riuscito (${response.status}).`);
  return readLimited(response, limit);
}

/** The trusted comment, if `data` is signed by the minisign public key with this .minisig text; throws otherwise. */
export function verifyMinisign(data: Buffer, signature: string, publicKey: string): string {
  const raw = Buffer.from(publicKey.trim(), "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new UpdateError("Chiave pubblica non valida.");
  if (Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES) throw new UpdateError("Firma troppo lunga.");
  const lines = signature.replaceAll("\r", "").split("\n").map((line) => line.trim()).filter(Boolean);
  const [untrusted = "", signed = "", trusted = "", globalLine = ""] = lines;
  if (lines.length !== 4 || !untrusted.startsWith("untrusted comment:") || !trusted.startsWith("trusted comment: ")) throw new UpdateError("Firma illeggibile.");
  const sig = Buffer.from(signed, "base64");
  const global = Buffer.from(globalLine, "base64");
  if (sig.length !== 74 || global.length !== 64) throw new UpdateError("Firma illeggibile.");
  if (sig.subarray(0, 2).toString("latin1") !== "ED") throw new UpdateError("Algoritmo di firma sconosciuto.");
  if (!sig.subarray(2, 10).equals(raw.subarray(2, 10))) throw new UpdateError("Firmato con un’altra chiave.");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10, 42)]), format: "der", type: "spki" });
  const ed25519 = sig.subarray(10, 74);
  const digest = createHash("blake2b512").update(data).digest();
  if (!verify(null, digest, key, ed25519)) throw new UpdateError("La firma non corrisponde al file.");
  const comment = trusted.slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([ed25519, Buffer.from(comment, "utf8")]), key, global)) throw new UpdateError("Il commento firmato è stato alterato.");
  return comment;
}

/** Checks a downloaded AppImage against its release: signed by the key, for exactly this asset, newer than `current`. */
export function checkDownload(release: AppRelease, data: Buffer, signature: string, current: string, publicKey = RELEASE_PUBLIC_KEY): void {
  if (!isNewer(release.version, current)) throw new UpdateError("Non è una versione più nuova.");
  const comment = verifyMinisign(data, signature, publicKey);
  const signed = /(?:^|\t)file:([^\t]+)/u.exec(comment)?.[1] ?? "";
  if (signed !== release.appImage.name) throw new UpdateError("La firma è di un altro file.");
  if (data.subarray(0, 4).toString("latin1") !== "\x7fELF") throw new UpdateError("Il file non è un’AppImage.");
}

/**
 * Replaces the AppImage at `target` with `data`: written next to it, made executable, then renamed over it in one
 * step. The running app keeps its own copy until it restarts. A target that is a link or not a file is refused.
 */
export async function replaceAppImage(target: string, data: Buffer): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile()) throw new UpdateError("L’AppImage in uso non è un file normale: aggiornala a mano.");
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.part`);
  try {
    const handle = await open(temporary, "wx", 0o700);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
