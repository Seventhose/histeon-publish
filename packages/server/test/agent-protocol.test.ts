import { describe, expect, it } from "vitest";
import { canonicalAgentRequest, signAgentRequest, signAgentResponse, verifyAgentRequest, verifyAgentResponse } from "../src/agent-protocol.js";

const secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const key = Buffer.from(secret, "base64url");
const keyInfo = { id: "k1", secret, bytes: key };
const postBody = Buffer.from('{"request_id":"3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b","release":{"version":"1.4.0","label":"Nuova home"},"export_token":"1793000900.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","paths":["/","/chi-siamo/"]}');
const getPath = "/v1/jobs/7c9e6679-7425-40de-944b-e07fc1f90ae7";

function requestHeaders(input: { method?: string; path?: string; timestamp?: string; nonce?: string; body?: Buffer; id?: string } = {}) {
  const method = input.method ?? "POST";
  const requestPath = input.path ?? "/v1/publish";
  const timestamp = input.timestamp ?? "1793000000";
  const nonce = input.nonce ?? "00112233445566778899aabbccddeeff";
  const body = input.body ?? postBody;
  return {
    "x-histos-key": input.id ?? "k1",
    "x-histos-timestamp": timestamp,
    "x-histos-nonce": nonce,
    "x-histos-signature": signAgentRequest(key, method, requestPath, timestamp, nonce, input.id ?? "k1", body),
  };
}

describe("protocollo HMAC dell’agente", () => {
  it("rispetta i tre vettori pubblicati nella specifica", () => {
    expect(key.byteLength).toBe(32);
    expect(postBody.byteLength).toBe(225);
    expect(signAgentRequest(key, "POST", "/v1/publish", "1793000000", "00112233445566778899aabbccddeeff", "k1", postBody))
      .toBe("v1=291e4cf7828bfbbc48b904891466e1c1af7c5500b44a91bd239fd76f1facd7ee");
    expect(signAgentRequest(key, "GET", getPath, "1793000060", "ffeeddccbbaa99887766554433221100", "k1", Buffer.alloc(0)))
      .toBe("v1=944a1618969472417b5c52f3899ba8e4826b5d8a53029781e31e1cb178b6e2f1");
    const responseBody = Buffer.from('{"job":{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","type":"publish","status":"queued"}}');
    expect(signAgentResponse(key, 202, "00112233445566778899aabbccddeeff", "1793000001", responseBody))
      .toBe("v1=a5bc10303c037fad19a3f9b60a284a4fc17f1b08efe41ef566b924e7d2ee6214");
  });

  it("firma il metodo, il path esatto, il timestamp, il nonce, l’id e i byte grezzi", () => {
    const body = Buffer.from("{}", "utf8");
    const canonical = canonicalAgentRequest("post", "/v1/jobs?limit=20", "1793000000", "00112233445566778899aabbccddeeff", "k1", body);
    expect(canonical.split("\n")).toEqual([
      "HISTOS-AGENT-V1", "POST", "/v1/jobs?limit=20", "1793000000", "00112233445566778899aabbccddeeff", "k1",
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    ]);
  });

  it("accetta solo header, chiave, timestamp e firma corretti entro ±300 secondi", () => {
    const valid = requestHeaders();
    expect(verifyAgentRequest(valid, "POST", "/v1/publish", postBody, [keyInfo], 1793000000)).toMatchObject({ ok: true, nonce: "00112233445566778899aabbccddeeff" });

    for (const invalid of [
      {},
      { ...valid, "x-histos-timestamp": "179300000" },
      { ...valid, "x-histos-nonce": "not-hex" },
      { ...valid, "x-histos-signature": valid["x-histos-signature"]?.slice(3) },
      { ...valid, "x-histos-key": "missing" },
    ]) expect(verifyAgentRequest(invalid, "POST", "/v1/publish", postBody, [keyInfo], 1793000000).ok).toBe(false);

    for (const offset of [-301, 301]) {
      const timestamp = String(1793000000 + offset);
      const stale = requestHeaders({ timestamp });
      expect(verifyAgentRequest(stale, "POST", "/v1/publish", postBody, [keyInfo], 1793000000)).toMatchObject({ ok: false, reason: "stale_timestamp" });
    }
    for (const offset of [-300, 300]) {
      const timestamp = String(1793000000 + offset);
      expect(verifyAgentRequest(requestHeaders({ timestamp }), "POST", "/v1/publish", postBody, [keyInfo], 1793000000).ok).toBe(true);
    }

    const changedSignature = valid["x-histos-signature"]?.replace(/[a-f]/u, "0");
    expect(verifyAgentRequest({ ...valid, "x-histos-signature": changedSignature }, "POST", "/v1/publish", postBody, [keyInfo], 1793000000).ok).toBe(false);
    expect(verifyAgentRequest(valid, "POST", "/v1/publish", Buffer.concat([postBody, Buffer.from(" ")]), [keyInfo], 1793000000).ok).toBe(false);
    expect(verifyAgentRequest(valid, "POST", "/v1/publish?x=1", postBody, [keyInfo], 1793000000).ok).toBe(false);
    expect(verifyAgentRequest(valid, "GET", "/v1/publish", postBody, [keyInfo], 1793000000).ok).toBe(false);
  });

  it("verifica le firme di risposta e le lega a status, timestamp, corpo e nonce", () => {
    const body = Buffer.from('{"job":{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","type":"publish","status":"queued"}}');
    const headers = {
      "x-histos-timestamp": "1793000001",
      "x-histos-signature": signAgentResponse(key, 202, "00112233445566778899aabbccddeeff", "1793000001", body),
    };
    expect(verifyAgentResponse(headers, 202, "00112233445566778899aabbccddeeff", body, key, 1793000001)).toBe(true);
    expect(verifyAgentResponse(headers, 404, "00112233445566778899aabbccddeeff", body, key, 1793000001)).toBe(false);
    expect(verifyAgentResponse(headers, 202, "ffeeddccbbaa99887766554433221100", body, key, 1793000001)).toBe(false);
    expect(verifyAgentResponse(headers, 202, "00112233445566778899aabbccddeeff", Buffer.concat([body, Buffer.from(" ")]), key, 1793000001)).toBe(false);
    expect(verifyAgentResponse(headers, 202, "00112233445566778899aabbccddeeff", body, key, 1793000302)).toBe(false);
  });
});
