import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signed protocol between the connector client (the MCP server an agent starts) and Histeon Publish
 * (docs/progettazione/histos-cms/16-connettore-ai.md §3). It follows agent-protocol.ts with its own domain line, so a
 * signature of one protocol never verifies in the other: the request MAC covers method, path with query, time, nonce,
 * app instance, client label and the body hash; every response is signed over status, nonce, instance and body.
 */
export const PROTOCOL_VERSION = 1;
export const REQUEST_DOMAIN = "HISTOS-PUBLISH-CONNECTOR-V1";
export const RESPONSE_DOMAIN = "HISTOS-PUBLISH-CONNECTOR-V1-RESPONSE";
/** Seconds a signed request or response stays valid. */
export const MAX_SKEW_SECONDS = 120;

export const HEADERS = {
  instance: "x-hp-instance",
  timestamp: "x-hp-timestamp",
  nonce: "x-hp-nonce",
  client: "x-hp-client",
  signature: "x-hp-signature",
} as const;

const HEX32 = /^[a-f0-9]{32}$/u;
const SIGNATURE = /^v1=[a-f0-9]{64}$/u;
const TIMESTAMP = /^[0-9]{10}$/u;

export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** What a client calls itself, as MCP `clientInfo` says: only safe characters, never trusted for anything. */
export function cleanClientLabel(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[^A-Za-z0-9 ._/-]+/gu, "").trim().slice(0, 60) : "";
  return text || "agente";
}

export function canonicalRequest(method: string, pathWithQuery: string, timestamp: string, nonce: string, instance: string, client: string, body: Uint8Array): string {
  return [REQUEST_DOMAIN, method.toUpperCase(), pathWithQuery, timestamp, nonce, instance, client, sha256Hex(body)].join("\n");
}

export function canonicalResponse(status: number, nonce: string, instance: string, timestamp: string, body: Uint8Array): string {
  return [RESPONSE_DOMAIN, String(status), nonce, instance, timestamp, sha256Hex(body)].join("\n");
}

function mac(key: Uint8Array, text: string): string {
  return "v1=" + createHmac("sha256", key).update(text).digest("hex");
}

export function signRequest(key: Uint8Array, method: string, pathWithQuery: string, timestamp: string, nonce: string, instance: string, client: string, body: Uint8Array): string {
  return mac(key, canonicalRequest(method, pathWithQuery, timestamp, nonce, instance, client, body));
}

export function signResponse(key: Uint8Array, status: number, nonce: string, instance: string, timestamp: string, body: Uint8Array): string {
  return mac(key, canonicalResponse(status, nonce, instance, timestamp, body));
}

/** Constant-time comparison of two `v1=<hex>` signatures. */
export function sameSignature(expected: string, actual: string): boolean {
  if (!SIGNATURE.test(expected) || !SIGNATURE.test(actual)) return false;
  const left = Buffer.from(expected.slice(3), "hex");
  const right = Buffer.from(actual.slice(3), "hex");
  return left.byteLength === 32 && right.byteLength === 32 && timingSafeEqual(left, right);
}

export function freshTimestamp(timestamp: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return TIMESTAMP.test(timestamp) && Math.abs(nowSeconds - Number(timestamp)) <= MAX_SKEW_SECONDS;
}

export function validNonce(value: unknown): value is string {
  return typeof value === "string" && HEX32.test(value);
}

export function validSignatureFormat(value: unknown): value is string {
  return typeof value === "string" && SIGNATURE.test(value);
}

/**
 * Nonces seen in the last few minutes. Full means closed: once the cache holds `max` live entries every new nonce is
 * refused until some expire, so flooding it can never reopen replay (the builder connector's `clear()` did).
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 300_000, private readonly max = 20_000) {}

  /** Whether the nonce was used in the last few minutes (checked before a body is read, remembered after). */
  has(nonce: string, nowMs = Date.now()): boolean {
    const expiry = this.seen.get(nonce);
    return expiry !== undefined && expiry > nowMs;
  }

  /** "ok" when the nonce is new and now remembered; "replayed" or "full" otherwise. */
  remember(nonce: string, nowMs = Date.now()): "ok" | "replayed" | "full" {
    const expiry = this.seen.get(nonce);
    if (expiry !== undefined && expiry > nowMs) return "replayed";
    if (this.seen.size >= this.max) this.prune(nowMs);
    if (this.seen.size >= this.max) return "full";
    this.seen.set(nonce, nowMs + this.ttlMs);
    return "ok";
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(nowMs: number): void {
    for (const [nonce, expiry] of this.seen) if (expiry <= nowMs) this.seen.delete(nonce);
  }
}
