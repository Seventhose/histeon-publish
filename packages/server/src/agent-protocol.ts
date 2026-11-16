import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AgentKey } from "./agent-config.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export function canonicalAgentRequest(method: string, requestPath: string, timestamp: string, nonce: string, keyId: string, body: Buffer): string {
  return [
    "HISTOS-AGENT-V1",
    method.toUpperCase(),
    requestPath,
    timestamp,
    nonce,
    keyId,
    sha256(body),
  ].join("\n");
}

export function signAgentRequest(key: Buffer, method: string, requestPath: string, timestamp: string, nonce: string, keyId: string, body: Buffer): string {
  return "v1=" + createHmac("sha256", key).update(canonicalAgentRequest(method, requestPath, timestamp, nonce, keyId, body)).digest("hex");
}

export function signAgentResponse(key: Buffer, status: number, nonce: string, timestamp: string, body: Buffer): string {
  const canonical = [
    "HISTOS-AGENT-V1-RESPONSE",
    String(status),
    nonce,
    timestamp,
    sha256(body),
  ].join("\n");
  return "v1=" + createHmac("sha256", key).update(canonical).digest("hex");
}

export function verifyAgentResponse(
  headers: Record<string, string | string[] | undefined>,
  status: number,
  nonce: string,
  body: Buffer,
  key: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const timestamp = header("x-histos-timestamp");
  const signature = header("x-histos-signature");
  if (!timestamp || !/^[0-9]{10}$/u.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300
    || !signature || !/^v1=[a-f0-9]{64}$/u.test(signature) || !/^[a-f0-9]{32}$/u.test(nonce)) return false;
  const expected = Buffer.from(signAgentResponse(key, status, nonce, timestamp, body).slice(3), "hex");
  const actual = Buffer.from(signature.slice(3), "hex");
  return expected.byteLength === 32 && actual.byteLength === 32 && timingSafeEqual(expected, actual);
}

export type AuthFailure = "bad_format" | "unknown_key" | "stale_timestamp" | "bad_signature";
export type AuthResult = { ok: true; key: AgentKey; timestamp: string; nonce: string } | { ok: false; reason: AuthFailure };

export function verifyAgentRequest(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  requestPath: string,
  body: Buffer,
  keys: readonly AgentKey[],
  nowSeconds = Math.floor(Date.now() / 1000),
): AuthResult {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const keyId = header("x-histos-key");
  const timestamp = header("x-histos-timestamp");
  const nonce = header("x-histos-nonce");
  const signature = header("x-histos-signature");
  if (!keyId || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(keyId)
    || !timestamp || !/^[0-9]{10}$/u.test(timestamp)
    || !nonce || !/^[a-f0-9]{32}$/u.test(nonce)
    || !signature || !/^v1=[a-f0-9]{64}$/u.test(signature)) return { ok: false, reason: "bad_format" };
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return { ok: false, reason: "unknown_key" };
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return { ok: false, reason: "stale_timestamp" };
  const expectedHex = signAgentRequest(key.bytes, method, requestPath, timestamp, nonce, keyId, body).slice(3);
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(signature.slice(3), "hex");
  if (expected.byteLength !== 32 || actual.byteLength !== 32 || !timingSafeEqual(expected, actual)) return { ok: false, reason: "bad_signature" };
  return { ok: true, key, timestamp, nonce };
}
