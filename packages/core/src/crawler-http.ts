import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { HistosPublishError, throwIfAborted } from "./errors.js";

export interface HttpResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  fromCache: boolean;
  notModified: boolean;
}

export interface HttpResponseMetadata {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
}

export interface HttpClientOptions {
  origin: string;
  userAgent: string;
  timeoutMs: number;
  delayMs: number;
  signal?: AbortSignal;
  cacheDirectory?: string;
  externalAssets?: readonly string[];
  credentials?: { basicUser?: string; basicPassword?: string; cookie?: string };
  privateOrigin?: boolean;
  publicOnly?: boolean;
  strictOrigin?: boolean;
  originHeaders?: Record<string, string>;
  forbiddenValues?: readonly string[];
}

interface CacheEntry {
  status: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  bodyFile: string;
  lastFetched: string;
}

type CacheIndex = Record<string, CacheEntry>;
type PinnedAddresses = LookupAddress[];
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 10_000;

export interface CacheCounters { hit: number; miss: number; notModified: number }

export function sameSiteOrigin(left: string | URL, right: string | URL): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    if (!["http:", "https:"].includes(first.protocol) || !["http:", "https:"].includes(second.protocol)) return false;
    const firstHost = first.hostname.toLowerCase().replace(/^www\./u, "");
    const secondHost = second.hostname.toLowerCase().replace(/^www\./u, "");
    if (firstHost !== secondHost) return false;
    if (first.port || second.port) return first.port === second.port;
    return true;
  } catch { return false; }
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, segment) => ((value << 8) | Number(segment)) >>> 0, 0);
}

function ipv4In(address: string, subnet: string, maskBits: number): boolean {
  const value = ipv4Number(address);
  const network = ipv4Number(subnet);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPrivateIpv4(address: string): boolean {
  return [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ].some(([network, bits]) => ipv4In(address, String(network), Number(bits)));
}

function normalizeIpLiteral(host: string): string {
  return host.replace(/^\[|\]$/gu, "").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const value = normalizeIpLiteral(host);
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" || (isIP(value) === 4 && ipv4In(value, "127.0.0.0", 8));
}

/** The eight 16-bit groups of an IPv6 literal (zone removed), or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let value = address.split("%")[0] ?? address;
  if (isIP(value) !== 6) return null;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    value = `${value.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 ? groups : null;
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * Addresses a crawl must never connect to. IPv6 transition prefixes that carry an IPv4 address (NAT64, 6to4) are judged
 * by that address, so a hostile AAAA record cannot reach an internal IPv4 host through a translating gateway.
 */
export function isPrivateAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  const g = ipv6Groups(normalized);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return true;
  // 64:ff9b::/96 NAT64 well-known prefix: the embedded IPv4 decides. 64:ff9b:1::/48 is for local use only.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 2002::/16 6to4: the embedded IPv4 decides.
  if (g0 === 0x2002) return isPrivateIpv4(ipv4FromGroups(g1, g2));
  // 2001::/32 Teredo, 2001:db8::/32 documentation, 100::/64 discard.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

function isPrivateOriginAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address);
  if (isLoopbackHost(normalized)) return true;
  if (isIP(normalized) === 4) {
    return ipv4In(normalized, "10.0.0.0", 8)
      || ipv4In(normalized, "172.16.0.0", 12)
      || ipv4In(normalized, "192.168.0.0", 16);
  }
  if (isIP(normalized) === 6) {
    const first = Number.parseInt((normalized.split(":")[0] ?? "0") || "0", 16);
    return (first & 0xfe00) === 0xfc00;
  }
  return false;
}

/** True for hostnames and literals that may be authorized as one local/private source origin. */
export function isPrivateOriginHost(hostname: string): boolean {
  const host = normalizeIpLiteral(hostname).toLowerCase().replace(/\.$/u, "");
  if (isLoopbackHost(host)) return true;
  if (isIP(host) > 0) return isPrivateOriginAddress(host);
  return host.endsWith(".local") || host.endsWith(".localhost");
}

function responseHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cacheKey(value: URL): string {
  const normalized = new URL(value);
  const search = normalized.search;
  normalized.hash = "";
  normalized.search = "";
  return `${normalized.href}\u0000${createHash("sha256").update(search).digest("hex")}`;
}

function safeCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.status === "number"
    && typeof entry.bodyFile === "string"
    && /^[a-f0-9]{64}\.body$/u.test(entry.bodyFile)
    && typeof entry.lastFetched === "string";
}

function abortError(signal?: AbortSignal): HistosPublishError {
  return signal?.aborted
    ? new HistosPublishError("Operazione annullata.", "cancelled", 6)
    : new HistosPublishError("Richiesta HTTP interrotta.", "crawl-network", 5);
}

/**
 * Whether a URL lies under an allowed external asset address: the same origin and, unless the address is a whole
 * site, inside its folder. Never a plain string prefix: https://cdn.example would admit https://cdn.example.evil.com.
 */
export function underExternalAsset(url: URL, allowed: URL): boolean {
  if (url.origin !== allowed.origin) return false;
  if (allowed.pathname === "/") return true;
  const prefix = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
  return url.pathname === allowed.pathname || url.pathname.startsWith(prefix);
}

export class SafeHttpClient {
  readonly counters: CacheCounters = { hit: 0, miss: 0, notModified: 0 };
  private readonly origin: URL;
  private readonly allowedExternal: URL[];
  private readonly cache: CacheIndex = {};
  private readonly lastRequestByHost = new Map<string, number>();
  private persistQueue: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | undefined;

  constructor(private readonly options: HttpClientOptions) {
    this.origin = new URL(options.origin);
    this.allowedExternal = (options.externalAssets ?? []).flatMap((value) => {
      try { return [new URL(value)]; } catch { return []; }
    });
  }

  private externalAllowed(url: URL): boolean {
    return this.allowedExternal.some((allowed) => underExternalAsset(url, allowed));
  }

  private isAllowedOrigin(url: URL): boolean {
    return (this.options.strictOrigin ? url.origin === this.origin.origin : sameSiteOrigin(url, this.origin)) || this.externalAllowed(url);
  }

  private async resolvePinned(hostname: string, isOriginRequest: boolean): Promise<PinnedAddresses> {
    const host = normalizeIpLiteral(hostname);
    const privateOrigin = this.options.privateOrigin === true && isOriginRequest && host === normalizeIpLiteral(this.origin.hostname);
    const loopbackSource = isLoopbackHost(this.origin.hostname);
    if (isIP(host) > 0) {
      if (this.options.publicOnly && isPrivateAddress(host)) {
        throw new HistosPublishError("Il controllo pubblico è limitato a indirizzi Internet e blocca le reti private.", "crawl-private-network", 2);
      }
      if (privateOrigin && !isPrivateOriginAddress(host)) {
        throw new HistosPublishError("L’origine privata deve risolvere solo a indirizzi privati o loopback.", "crawl-private-network", 2);
      }
      if (isPrivateAddress(host) && !(loopbackSource && isLoopbackHost(host))) {
        if (!privateOrigin) throw new HistosPublishError("La sorgente risolve a un indirizzo di rete privata e viene bloccata.", "crawl-private-network", 2);
      }
      return [{ address: host, family: isIP(host) as 4 | 6 }];
    }
    let addresses: PinnedAddresses;
    try { addresses = await dnsLookup(host, { all: true, verbatim: true }); }
    catch { throw new HistosPublishError("Il nome host non può essere risolto.", "crawl-dns-failed", 5); }
    if (addresses.length === 0) throw new HistosPublishError("Il nome host non restituisce indirizzi.", "crawl-dns-failed", 5);
    if (this.options.publicOnly && addresses.some((item) => isPrivateAddress(item.address))) {
      throw new HistosPublishError("Il controllo pubblico è limitato a indirizzi Internet e blocca le reti private.", "crawl-private-network", 2);
    }
    if (privateOrigin) {
      if (!addresses.every((item) => isPrivateOriginAddress(item.address))) {
        throw new HistosPublishError("L’origine privata deve risolvere solo a indirizzi privati o loopback.", "crawl-private-network", 2);
      }
      return addresses;
    }
    const allLoopback = addresses.every((item) => isLoopbackHost(item.address));
    if (addresses.some((item) => isPrivateAddress(item.address)) && !(loopbackSource && allLoopback && isLoopbackHost(host))) {
      throw new HistosPublishError("Il nome host risolve a una rete privata; il crawling viene bloccato.", "crawl-private-network", 2);
    }
    return addresses;
  }

  private initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const directory = this.options.cacheDirectory;
        if (!directory) return;
        await mkdir(path.join(directory, "objects"), { recursive: true, mode: 0o700 });
        try {
          const parsed: unknown = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed)) if (safeCacheEntry(value)) this.cache[key] = value;
          }
        } catch { /* A missing or damaged cache is treated as empty. */ }
      })();
    }
    return this.initialization;
  }

  private async waitForHost(hostname: string): Promise<void> {
    const delay = this.options.delayMs;
    const now = Date.now();
    const scheduled = Math.max(now, this.lastRequestByHost.get(hostname) ?? 0);
    this.lastRequestByHost.set(hostname, scheduled + delay);
    const wait = scheduled - now;
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = (): void => {
          clearTimeout(timer);
          this.options.signal?.removeEventListener("abort", onAbort);
          reject(abortError(this.options.signal));
        };
        const done = (): void => {
          this.options.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        timer = setTimeout(done, wait);
        this.options.signal?.addEventListener("abort", onAbort, { once: true });
        if (this.options.signal?.aborted) onAbort();
      });
    }
    throwIfAborted(this.options.signal);
  }

  private async request(
    url: URL,
    headers: Record<string, string>,
    maxBytes: number,
    pinned: PinnedAddresses,
    method: "GET" | "POST" = "GET",
    body?: Buffer,
    readBody = true,
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    const transport = url.protocol === "https:" ? https : http;
    const hostname = normalizeIpLiteral(url.hostname);
    const lookup: LookupFunction = (_lookupHost, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, pinned);
      else {
        const address = pinned[0];
        if (!address) callback(Object.assign(new Error("No pinned DNS address"), { code: "ENOTFOUND" }), "", 0);
        else callback(null, address.address, address.family);
      }
    };
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const request = transport.request(url, {
        method,
        headers,
        lookup,
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
      }, (response) => {
        if (!readBody) {
          response.once("error", () => undefined);
          settled = true;
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.alloc(0) });
          response.destroy();
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > maxBytes) {
            request.destroy(new HistosPublishError("La risposta supera il limite di dimensione consentito.", "crawl-response-too-large", 2));
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
        });
        response.once("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      const requestTimer = setTimeout(() => request.destroy(new HistosPublishError("La richiesta ha superato il tempo massimo.", "crawl-timeout", 5)), this.options.timeoutMs);
      const onAbort = (): void => { request.destroy(abortError(this.options.signal)); };
      this.options.signal?.addEventListener("abort", onAbort, { once: true });
      request.setTimeout(this.options.timeoutMs, () => request.destroy(new HistosPublishError("La richiesta ha superato il tempo massimo.", "crawl-timeout", 5)));
      request.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.once("close", () => {
        clearTimeout(requestTimer);
        this.options.signal?.removeEventListener("abort", onAbort);
      });
      request.end(body);
    });
  }

  private async saveCache(key: string, response: { status: number; headers: IncomingHttpHeaders; body: Buffer }): Promise<void> {
    const directory = this.options.cacheDirectory;
    if (!directory || response.status < 200 || response.status >= 300) return;
    const digest = createHash("sha256").update(key).digest("hex");
    const bodyFile = `${digest}.body`;
    const objectPath = path.join(directory, "objects", bodyFile);
    const contentType = responseHeader(response.headers["content-type"]);
    const etag = responseHeader(response.headers.etag);
    const lastModified = responseHeader(response.headers["last-modified"]);
    const entry: CacheEntry = {
      status: response.status,
      ...(contentType === undefined ? {} : { contentType }),
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      bodyFile,
      lastFetched: new Date().toISOString(),
    };
    this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => {
      const temporaryBody = `${objectPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryBody, response.body, { mode: 0o600 });
      await rename(temporaryBody, objectPath);
      this.cache[key] = entry;
      await this.pruneCache(directory);
      const indexPath = path.join(directory, "index.json");
      const temporaryIndex = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryIndex, `${JSON.stringify(this.cache)}\n`, { mode: 0o600 });
      await rename(temporaryIndex, indexPath);
    });
    await this.persistQueue;
  }

  private assertNoForbiddenValue(body: Buffer): void {
    if ((this.options.forbiddenValues ?? []).some((value) => value.length > 0 && body.includes(Buffer.from(value, "utf8")))) {
      throw new HistosPublishError("La risposta contiene un dato riservato dell’agente.", "crawl-sensitive-content", 2);
    }
  }

  private async pruneCache(directory: string): Promise<void> {
    const entries: Array<{ key: string; bodyFile: string; size: number; fetched: number }> = [];
    let totalBytes = 0;
    for (const [key, entry] of Object.entries(this.cache)) {
      try {
        const info = await stat(path.join(directory, "objects", entry.bodyFile));
        if (!info.isFile()) throw new Error("Cache entry is not a regular file");
        entries.push({ key, bodyFile: entry.bodyFile, size: info.size, fetched: Date.parse(entry.lastFetched) || 0 });
        totalBytes += info.size;
      } catch {
        delete this.cache[key];
      }
    }
    entries.sort((left, right) => left.fetched - right.fetched);
    while (entries.length > MAX_CACHE_ENTRIES || totalBytes > MAX_CACHE_BYTES) {
      const oldest = entries.shift();
      if (!oldest) break;
      delete this.cache[oldest.key];
      totalBytes -= oldest.size;
      await unlink(path.join(directory, "objects", oldest.bodyFile)).catch(() => undefined);
    }
  }

  async get(input: string | URL, options: { maxBytes?: number; bypassCache?: boolean; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
    await this.initialize();
    throwIfAborted(this.options.signal);
    const url = new URL(input);
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new HistosPublishError("Il crawler accetta solo HTTP e HTTPS.", "crawl-url-invalid", 2);
    if (url.username || url.password) throw new HistosPublishError("Le credenziali non possono essere inserite nell’URL.", "crawl-url-invalid", 2);
    if (!this.isAllowedOrigin(url)) throw new HistosPublishError("La richiesta esce dall’origine o dall’elenco degli asset autorizzati.", "crawl-cross-origin", 2);
    const pinned = await this.resolvePinned(url.hostname, url.origin === this.origin.origin);
    await this.waitForHost(url.hostname);
    const user = url.origin === this.origin.origin ? this.options.credentials?.basicUser ?? process.env.HISTOS_WP_BASIC_USER : undefined;
    const password = url.origin === this.origin.origin ? this.options.credentials?.basicPassword ?? process.env.HISTOS_WP_BASIC_PASSWORD : undefined;
    const cookie = url.origin === this.origin.origin ? this.options.credentials?.cookie ?? process.env.HISTOS_WP_COOKIE : undefined;
    const authParts = [user && password ? `${user}\u0000${password}` : "", cookie ?? ""].filter(Boolean);
    const authScope = authParts.length === 0 ? "anon" : createHash("sha256").update(authParts.join("\u0000")).digest("hex");
    const key = `${cacheKey(url)}\u0000${authScope}`;
    const previous = options.bypassCache ? undefined : this.cache[key];
    const requestHeaders: Record<string, string> = {
      "User-Agent": this.options.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/css,application/json,image/avif,image/webp,image/png,image/*,*/*;q=0.5",
      "Accept-Encoding": "identity",
      ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
      ...(previous?.lastModified ? { "If-Modified-Since": previous.lastModified } : {}),
      ...(options.bypassCache ? { "Cache-Control": "no-cache", Pragma: "no-cache" } : {}),
      ...(url.origin === this.origin.origin ? this.options.originHeaders : {}),
      ...options.headers,
    };
    if (user && password && (url.protocol === "https:" || isLoopbackHost(url.hostname))) {
      requestHeaders.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    }
    if (cookie && (url.protocol === "https:" || isLoopbackHost(url.hostname))) requestHeaders.Cookie = cookie;
    let response: { status: number; headers: IncomingHttpHeaders; body: Buffer };
    try { response = await this.request(url, requestHeaders, options.maxBytes ?? 25 * 1024 * 1024, pinned); }
    catch (error) {
      if (this.options.signal?.aborted) throw abortError(this.options.signal);
      throw error instanceof HistosPublishError ? error : new HistosPublishError("La richiesta al sito non è riuscita.", "crawl-network", 5);
    }
    if (response.status === 304 && previous && this.options.cacheDirectory) {
      try {
        const body = await readFile(path.join(this.options.cacheDirectory, "objects", previous.bodyFile));
        this.assertNoForbiddenValue(body);
        this.counters.hit += 1;
        this.counters.notModified += 1;
        return {
          url: url.href,
          status: previous.status,
          headers: { ...response.headers, "content-type": previous.contentType, etag: previous.etag, "last-modified": previous.lastModified },
          body,
          fromCache: true,
          notModified: true,
        };
      } catch { /* Retry once without validators when the local object is missing. */ }
    }
    if (response.status === 304) {
      const unconditionalHeaders = { ...requestHeaders };
      delete unconditionalHeaders["If-None-Match"];
      delete unconditionalHeaders["If-Modified-Since"];
      await this.waitForHost(url.hostname);
      response = await this.request(url, unconditionalHeaders, options.maxBytes ?? 25 * 1024 * 1024, pinned);
    }
    this.assertNoForbiddenValue(response.body);
    this.counters.miss += 1;
    if (!options.bypassCache && response.status >= 200 && response.status < 300) await this.saveCache(key, response);
    return { url: url.href, ...response, fromCache: false, notModified: false };
  }

  /** Checks response headers without downloading the response body. DNS is pinned and origin/private-network rules still apply. */
  async probe(input: string | URL, options: { headers?: Record<string, string> } = {}): Promise<HttpResponseMetadata> {
    throwIfAborted(this.options.signal);
    const url = new URL(input);
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new HistosPublishError("Il controllo HTTP accetta solo HTTP e HTTPS.", "crawl-url-invalid", 2);
    if (url.username || url.password) throw new HistosPublishError("Le credenziali non possono essere inserite nell’URL.", "crawl-url-invalid", 2);
    if (!this.isAllowedOrigin(url)) throw new HistosPublishError("La richiesta esce dall’origine autorizzata.", "crawl-cross-origin", 2);
    const pinned = await this.resolvePinned(url.hostname, url.origin === this.origin.origin);
    await this.waitForHost(url.hostname);
    const headers = {
      "User-Agent": this.options.userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      ...options.headers,
    };
    try {
      const response = await this.request(url, headers, 0, pinned, "GET", undefined, false);
      return { url: url.href, status: response.status, headers: response.headers };
    } catch (error) {
      if (this.options.signal?.aborted) throw abortError(this.options.signal);
      throw error instanceof HistosPublishError ? error : new HistosPublishError("Il controllo HTTP non è riuscito.", "crawl-network", 5);
    }
  }

  /** Sends a small JSON POST to the already-authorized origin, with the same DNS pinning and private-network protections as the crawler. */
  async postJson(input: string | URL, payload: unknown, options: { maxBytes?: number; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
    await this.initialize();
    throwIfAborted(this.options.signal);
    const url = new URL(input);
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password) {
      throw new HistosPublishError("Il controllo remoto richiede un indirizzo HTTP o HTTPS senza credenziali.", "crawl-url-invalid", 2);
    }
    if (!this.isAllowedOrigin(url)) throw new HistosPublishError("La richiesta esce dall’origine autorizzata.", "crawl-cross-origin", 2);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const pinned = await this.resolvePinned(url.hostname, url.origin === this.origin.origin);
    await this.waitForHost(url.hostname);
    const headers = {
      "User-Agent": this.options.userAgent,
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.byteLength),
      ...options.headers,
    };
    let response: { status: number; headers: IncomingHttpHeaders; body: Buffer };
    try { response = await this.request(url, headers, options.maxBytes ?? 8192, pinned, "POST", body); }
    catch (error) {
      if (this.options.signal?.aborted) throw abortError(this.options.signal);
      throw error instanceof HistosPublishError ? error : new HistosPublishError("La richiesta HTTPS al sito non è riuscita.", "crawl-network", 5);
    }
    this.assertNoForbiddenValue(response.body);
    return { url: url.href, ...response, fromCache: false, notModified: false };
  }
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  return responseHeader(headers[name.toLowerCase()]);
}

export function isLoopbackUrl(value: string | URL): boolean {
  try { return isLoopbackHost(new URL(value).hostname); } catch { return false; }
}
