import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { getCACertificates } from "node:tls";
import { HistosPublishError } from "@histos-publish/core";
import { PRODUCT_CAPABILITY, SCRIPT_CAPABILITY } from "@histos-publish/histos-contract";
import type { CmsRemoteConnection, ParsedLink } from "./cms-remote-catalog.js";

/** The signed HTTP transport of the Histeon CMS bridge (builder docs/spec/cms-bridge.md §2) and its response checks. */
export const CODE_PREFIX = "histos-cms-1:";
export const PROFILE = "histos-static-page-v1";
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const REMOTE_NAMESPACE = "/xb/v1/cms/v1";
/** The site's home and posts page as Publish reads and sets them (builder docs/spec/cms-bridge.md §18). */
export const FRONT_PAGE_CAPABILITY = "histos-front-page-v1";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const PENDING_REASONS = new Set(["next-release", "published-fields", "deletion"]);

export function isPendingItem(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && typeof item.id === "string" && UUID.test(item.id) && typeof item.reason === "string" && PENDING_REASONS.has(item.reason);
}

export function parsePairingCode(input: string): ParsedLink {
  if (input.length > 16_384 || !input.startsWith(CODE_PREFIX))
    throw new HistosPublishError("Il codice di collegamento Histeon non è valido.", "cms-remote-code-invalid", 400);
  const encoded = input.slice(CODE_PREFIX.length);
  const raw = Buffer.from(encoded, "base64url");
  if (raw.toString("base64url") !== encoded)
    throw new HistosPublishError("Il codice di collegamento Histeon non è valido.", "cms-remote-code-invalid", 400);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new HistosPublishError("Il codice di collegamento Histeon non è valido.", "cms-remote-code-invalid", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HistosPublishError("Il codice di collegamento Histeon non è valido.", "cms-remote-code-invalid", 400);
  const item = value as Record<string, unknown>;
  if (typeof item.url !== "string" || typeof item.secret !== "string" || item.secret.length > 128)
    throw new HistosPublishError("Il codice di collegamento Histeon non è valido.", "cms-remote-code-invalid", 400);
  const secret = Buffer.from(item.secret, "base64url");
  if (secret.byteLength !== 32 || secret.toString("base64url") !== item.secret)
    throw new HistosPublishError("Il segreto del collegamento non è valido.", "cms-remote-code-invalid", 400);
  const scopes =
    item.scopes && typeof item.scopes === "object" && !Array.isArray(item.scopes)
      ? (item.scopes as Record<string, unknown>)
      : {};
  if (scopes.read !== true)
    throw new HistosPublishError(
      "Il codice deve permettere di scaricare il sito: crealo in WordPress con «Scaricare il sito» attivo.",
      "cms-remote-read-scope-required",
      403,
    );
  const url = validateRemoteUrl(item.url);
  return { url, secret, read: true, write: scopes.write === true, publish: scopes.publish === true };
}

export function validateRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HistosPublishError("L’indirizzo nel codice Histeon non è valido.", "cms-remote-url-invalid", 400);
  }
  if (
    (url.protocol !== "https:" && !(isLocalHost(url.hostname) && url.protocol === "http:")) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HistosPublishError(
      "Il sito remoto deve usare HTTPS e non può includere credenziali, query o frammenti nell’indirizzo.",
      "cms-remote-url-invalid",
      400,
    );
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/u, "");
}

/** A development site on this computer (Local, wp-env, DDEV…): it may use http, or a certificate only the system trusts. */
export function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

export function signature(
  secret: Buffer,
  method: string,
  route: string,
  time: string,
  nonce: string,
  body: Uint8Array,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}\n${route}\n${time}\n${nonce}\n${bodyHash}`)
    .digest("hex");
}

export function remoteUrl(base: string, route: string): string {
  return `${base}/?rest_route=${encodeURIComponent(route)}`;
}

export async function requestRemote(
  connection: Pick<CmsRemoteConnection, "url">,
  secret: Buffer,
  method: "GET" | "POST",
  route: string,
  body: Uint8Array = new Uint8Array(),
  maxBytes = 4 * 1024 * 1024,
  contentType = "application/zip",
  extraHeaders: Record<string, string> = {},
): Promise<{ bytes: Buffer; contentType: string; headers: Headers }> {
  const time = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const target = new URL(remoteUrl(connection.url, route));
  const init = {
    method,
    headers: {
      "X-Histos-Time": time,
      "X-Histos-Nonce": nonce,
      "X-Histos-Signature": signature(secret, method, route, time, nonce, body),
      ...(method === "POST" ? { "Content-Type": contentType } : {}),
      Accept: method === "GET" && route.endsWith("/export") ? "application/zip" : "application/json",
      ...extraHeaders,
    },
    ...(method === "POST" ? { body: Buffer.from(body) } : {}),
    signal: AbortSignal.timeout(method === "POST" ? 120_000 : 30_000),
  };
  return exchange(target, init, maxBytes);
}

/**
 * Doc 23 item 237: the one unsigned request of the bridge, the claim of a pairing code (`/pair`). It carries the
 * PKCE verifier only Publish knows; the site answers once, with the code, and forgets the claim.
 */
export async function claimPairingCode(siteUrl: string, claim: string, verifier: string): Promise<string> {
  const body = Buffer.from(JSON.stringify({ claim, verifier }), "utf8");
  const target = new URL(remoteUrl(validateRemoteUrl(siteUrl), `${REMOTE_NAMESPACE}/pair`));
  const result = await exchange(target, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body, signal: AbortSignal.timeout(30_000) }, 32 * 1024);
  let value: unknown;
  try { value = JSON.parse(result.bytes.toString("utf8")) as unknown; } catch { value = null; }
  const code = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).code : undefined;
  if (typeof code !== "string" || !code.startsWith(CODE_PREFIX)) throw new HistosPublishError("Il sito non ha dato un codice di collegamento valido.", "cms-remote-code-invalid", 502);
  return code;
}

/** One request to a site: local sites with the system's certificates too, no redirects, the body within its limit. */
async function exchange(target: URL, init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal }, maxBytes: number): Promise<{ bytes: Buffer; contentType: string; headers: Headers }> {
  let response: Response;
  try {
    response =
      target.protocol === "https:" && isLocalHost(target.hostname)
        ? await localRequest(target, init, localTrust())
        : await fetch(target, { method: init.method, headers: init.headers, signal: init.signal, redirect: "manual", ...(init.body ? { body: new Uint8Array(init.body) } : {}) });
  } catch (error) {
    throw unreachable(error);
  }
  if (response.status >= 300 && response.status < 400)
    throw new HistosPublishError(
      "Il sito remoto ha reindirizzato la richiesta. Controlla URL e HTTPS e ricollega il sito.",
      "cms-remote-redirect",
      502,
    );
  const bytes = await readLimited(response, response.ok ? maxBytes : 64 * 1024);
  if (!response.ok) {
    let message = `Il sito remoto ha risposto HTTP ${response.status}.`;
    let remoteCode = "";
    try {
      const error = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (typeof error.message === "string") message = error.message.slice(0, 500);
      if (typeof error.code === "string" && /^[a-z0-9_]{1,64}$/u.test(error.code)) remoteCode = error.code;
    } catch {
      /* Keep the generic status message. */
    }
    throw new CmsRemoteRejectedError(message, response.status, remoteCode);
  }
  return { bytes, contentType: response.headers.get("content-type") ?? "", headers: response.headers };
}

/**
 * The certificates a local development site may use: Node's bundle plus the system store, where Local and the like
 * add the certificate of each site. Node alone knows only its bundle, so without these Publish refused a site the
 * browser opens. Public sites keep Node's bundle alone.
 */
let localCertificates: string[] | undefined;
function localTrust(): string[] {
  if (!localCertificates) {
    let system: string[] = [];
    try {
      system = getCACertificates("system");
    } catch {
      /* A Node without access to the system store: its bundle only. */
    }
    localCertificates = [...new Set([...getCACertificates("default"), ...system])];
  }
  return localCertificates;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** One request over node:https with these certificates, answered as a fetch Response; redirects are not followed. */
export function localRequest(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal },
  ca: string[],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: init.method, headers: init.headers, ca, signal: init.signal }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const status = incoming.statusCode ?? 502;
      if (NULL_BODY.has(status)) incoming.resume();
      resolve(
        new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
          status,
          statusText: incoming.statusMessage ?? "",
          headers,
        }),
      );
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

/** Why the site could not be reached, in words and with the system's code, instead of a bare «fetch failed». */
export function unreachable(error: unknown): HistosPublishError {
  if (error instanceof HistosPublishError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError")
    return new HistosPublishError("Il sito remoto non ha risposto in tempo.", "cms-remote-timeout", 504);
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const raw = (cause as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" && /^[A-Z0-9_]{1,64}$/u.test(raw) ? raw : "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/u.test(code))
    return new HistosPublishError(
      `Il certificato HTTPS del sito non è riconosciuto (${code}). Su un sito pubblico serve un certificato valido; su un sito locale, che il sistema si fidi del suo certificato.`,
      "cms-remote-certificate",
      502,
    );
  return new HistosPublishError(
    `Histeon Publish non raggiunge il sito${code ? ` (${code})` : ""}. Controlla che il sito sia acceso e che l’indirizzo sia giusto.`,
    "cms-remote-unreachable",
    502,
  );
}

/** A refusal from the remote site, with the bridge's error code when it sent one (e.g. xb_cms_inactive). */
export class CmsRemoteRejectedError extends HistosPublishError {
  constructor(message: string, status: number, readonly remoteCode: string) {
    super(message, "cms-remote-rejected", status);
  }
}

export async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new HistosPublishError(
      "La risposta remota supera il limite consentito.",
      "cms-remote-response-too-large",
      413,
    );
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HistosPublishError(
        "La risposta remota supera il limite consentito.",
        "cms-remote-response-too-large",
        413,
      );
    }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks);
}

export function validateCapabilities(value: unknown): {
  siteId: string;
  projectId: string | null;
  projectName: string;
  write: boolean;
  publish: boolean;
  canInitializeProject: boolean;
  profiles: string[];
  /** Markup profiles the site reads beyond the base transfer rules (histos-transfer-markup-v1). */
  markup: string[];
  /** Shop capabilities the site has (queue C6): commerce:products:v1 when WooCommerce is active. */
  commerce: string[];
  /** Doc 18 §6.6: documents:script:v1 when the link's WordPress user may store JavaScript (unfiltered_html). */
  scripts: string[];
  /** Doc 23 item 125: the site's PHP, when its Histeon says it (null for older ones). */
  php: string | null;
  /** The site's Histeon version, when it says it. */
  histeon: string | null;
  /** The readings the site's export answers (`check` since Histeon 0.5.7, doc 23 item 197); empty for older sites. */
  readings: string[];
  /** Doc 23 item 201: the site reads and sets its home and posts page for Publish (histos-front-page-v1). */
  frontPage: boolean;
  /** V1.6: the site gives the signed preview links of its changed pages (`/preview-links`, with the read permission). */
  previewLinks: boolean;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HistosPublishError(
      "Il sito non restituisce un contratto Histeon CMS valido: aggiorna Histeon su WordPress.",
      "cms-remote-contract-invalid",
      422,
    );
  const item = value as Record<string, unknown>;
  const caps =
    item.capabilities && typeof item.capabilities === "object" ? (item.capabilities as Record<string, unknown>) : {};
  const allowedProfiles = new Set([
    PROFILE,
    "histos-static-project-v1",
    "histos-static-project-v2",
    "histos-static-project-v3",
    "histos-static-project-v4",
  ]);
  const profiles = Array.isArray(caps.profiles)
    ? [
        ...new Set(
          caps.profiles.filter(
            (profile): profile is string => typeof profile === "string" && allowedProfiles.has(profile),
          ),
        ),
      ]
    : [];
  if (
    item.contractVersion !== 2 ||
    typeof item.profile !== "string" ||
    !allowedProfiles.has(item.profile) ||
    !profiles.includes(PROFILE) ||
    !profiles.includes(item.profile) ||
    typeof item.siteId !== "string" ||
    !UUID.test(item.siteId) ||
    caps.read !== true
  )
    throw new HistosPublishError(
      "Il sito non supporta il profilo Histeon richiesto o non autorizza la lettura.",
      "cms-remote-profile-unavailable",
      422,
    );
  const allowedMarkup = new Set(["histos-transfer-markup-v1", "histos-media-links-v1", "histos-url-path-v1", "histos-loop-group-v1", "histos-svg-text-v1"]);
  const markup = Array.isArray(caps.markup)
    ? [...new Set(caps.markup.filter((entry): entry is string => typeof entry === "string" && allowedMarkup.has(entry)))]
    : [];
  const commerce = Array.isArray(caps.commerce) && caps.commerce.includes(PRODUCT_CAPABILITY) ? [PRODUCT_CAPABILITY] : [];
  const scripts = Array.isArray(caps.scripts) && caps.scripts.includes(SCRIPT_CAPABILITY) ? [SCRIPT_CAPABILITY] : [];
  const environment = item.environment && typeof item.environment === "object" ? (item.environment as Record<string, unknown>) : {};
  const canInitializeProject = item.canInitializeProject === true;
  const projectId = canInitializeProject
    ? null
    : typeof item.projectId === "string" && UUID.test(item.projectId)
      ? item.projectId
      : null;
  return {
    siteId: item.siteId,
    projectId,
    projectName: typeof item.projectName === "string" ? item.projectName.slice(0, 120) : "Sito Histeon",
    write: caps.write === true,
    publish: caps.publish === true,
    canInitializeProject,
    profiles,
    markup,
    commerce,
    scripts,
    php: typeof environment.php === "string" && /^\d{1,2}\.\d{1,2}(?:\.\d{1,3})?/u.test(environment.php) ? environment.php.slice(0, 20) : null,
    histeon: typeof environment.histeon === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}/u.test(environment.histeon) ? environment.histeon.slice(0, 40) : null,
    readings: Array.isArray(caps.readings) ? ["adopt", "read", "linked", "check"].filter((reading) => (caps.readings as unknown[]).includes(reading)) : [],
    frontPage: Array.isArray(caps.siteSettings) && caps.siteSettings.includes(FRONT_PAGE_CAPABILITY),
    previewLinks: caps.previewLinks === true,
  };
}

export function validateEntityHeads(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Le revisioni Remote non sono valide.");
  const heads: Record<string, string> = {};
  for (const [id, hash] of Object.entries(value)) {
    if (!UUID.test(id) || typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash))
      throw new TypeError("Le revisioni Remote non sono valide.");
    heads[id] = hash;
  }
  if (Object.keys(heads).length > 10_000) throw new TypeError("Il registro Remote supera il limite di entità.");
  return heads;
}
