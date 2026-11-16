import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signAgentRequest, signAgentResponse, verifyAgentRequest, verifyAgentResponse } from "../../server/src/agent-protocol.js";
import {
  canonicalRequest,
  canonicalResponse,
  cleanClientLabel,
  freshTimestamp,
  MAX_SKEW_SECONDS,
  NonceCache,
  REQUEST_DOMAIN,
  RESPONSE_DOMAIN,
  sameSignature,
  sha256Hex,
  signRequest,
  signResponse,
  validNonce,
  validSignatureFormat,
} from "../src/protocol.js";

interface Vector {
  name: string;
  key: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  instance: string;
  client: string;
  body: string;
  status: number;
  responseTimestamp: string;
  responseBody: string;
  bodySha256: string;
  requestSignature: string;
  responseSignature: string;
}

// Computed once by an independent implementation of the design's canonical form and frozen: if one of these
// changes, every connector client already copied next to session.json stops talking to the app.
const { vectors } = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] };

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
const keyOf = (vector: Vector): Buffer => Buffer.from(vector.key, "base64url");

describe("connector protocol v1: frozen vectors", () => {
  it("has vectors for the hello, a call and a prototype with a query", () => {
    expect(vectors.map((vector) => vector.name)).toEqual(["hello", "call", "prototype-with-query"]);
    for (const vector of vectors) expect(keyOf(vector).byteLength).toBe(32);
  });

  it.each(vectors)("$name: request MAC and response signature match", (vector) => {
    const key = keyOf(vector);
    expect(sha256Hex(bytes(vector.body))).toBe(vector.bodySha256);
    expect(canonicalRequest(vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, bytes(vector.body)))
      .toBe([REQUEST_DOMAIN, vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, vector.bodySha256].join("\n"));
    expect(signRequest(key, vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, bytes(vector.body))).toBe(vector.requestSignature);
    // The method is canonicalised to upper case, so a lower-case caller signs the same request.
    expect(signRequest(key, vector.method.toLowerCase(), vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, bytes(vector.body))).toBe(vector.requestSignature);
    expect(signResponse(key, vector.status, vector.nonce, vector.instance, vector.responseTimestamp, bytes(vector.responseBody))).toBe(vector.responseSignature);
  });

  it.each(vectors)("$name: every covered field changes the request MAC", (vector) => {
    const key = keyOf(vector);
    const sign = (patch: Partial<Vector>, signingKey = key): string => {
      const item = { ...vector, ...patch };
      return signRequest(signingKey, item.method, item.path, item.timestamp, item.nonce, item.instance, item.client, bytes(item.body));
    };
    const variants = [
      sign({ method: vector.method === "GET" ? "POST" : "GET" }),
      sign({ path: `${vector.path}x` }),
      sign({ timestamp: String(Number(vector.timestamp) + 1) }),
      sign({ nonce: `${vector.nonce.slice(0, 31)}${vector.nonce.endsWith("0") ? "1" : "0"}` }),
      sign({ instance: `${vector.instance.slice(0, 31)}${vector.instance.endsWith("0") ? "1" : "0"}` }),
      sign({ client: `${vector.client}x` }),
      sign({ body: `${vector.body} ` }),
      sign({}, Buffer.alloc(32, 7)),
    ];
    for (const variant of variants) expect(variant).not.toBe(vector.requestSignature);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it.each(vectors)("$name: every covered field changes the response signature", (vector) => {
    const key = keyOf(vector);
    const body = bytes(vector.responseBody);
    const variants = [
      signResponse(key, vector.status + 1, vector.nonce, vector.instance, vector.responseTimestamp, body),
      signResponse(key, vector.status, "0".repeat(32), vector.instance, vector.responseTimestamp, body),
      signResponse(key, vector.status, vector.nonce, "1".repeat(32), vector.responseTimestamp, body),
      signResponse(key, vector.status, vector.nonce, vector.instance, String(Number(vector.responseTimestamp) + 1), body),
      signResponse(key, vector.status, vector.nonce, vector.instance, vector.responseTimestamp, bytes(`${vector.responseBody} `)),
    ];
    for (const variant of variants) expect(variant).not.toBe(vector.responseSignature);
  });
});

describe("domain separation", () => {
  it("request and response canonical forms start with different domain lines", () => {
    const vector = vectors[0] as Vector;
    const request = canonicalRequest(vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, bytes(vector.body));
    const response = canonicalResponse(vector.status, vector.nonce, vector.instance, vector.responseTimestamp, bytes(vector.responseBody));
    expect(request.split("\n")[0]).toBe("HISTOS-PUBLISH-CONNECTOR-V1");
    expect(response.split("\n")[0]).toBe("HISTOS-PUBLISH-CONNECTOR-V1-RESPONSE");
    expect(RESPONSE_DOMAIN).not.toBe(REQUEST_DOMAIN);
  });

  it.each(vectors)("$name: an agent-protocol signature never verifies here, and a connector signature never verifies there", (vector) => {
    const key = keyOf(vector);
    const body = bytes(vector.body);
    const responseBody = bytes(vector.responseBody);
    // Same key and inputs; the agent protocol's key id is the closest thing it has to the instance.
    const agentRequest = signAgentRequest(key, vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, body);
    const connectorRequest = signRequest(key, vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, body);
    expect(sameSignature(connectorRequest, agentRequest)).toBe(false);
    // Even with the client label the agent protocol does not have, set so the field lists line up as far as they can.
    const connectorWithoutClient = signRequest(key, vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, "", body);
    expect(sameSignature(connectorWithoutClient, agentRequest)).toBe(false);

    const headers = { "x-histos-key": vector.instance, "x-histos-timestamp": vector.timestamp, "x-histos-nonce": vector.nonce, "x-histos-signature": connectorRequest };
    const keys = [{ id: vector.instance, secret: vector.key, bytes: key }];
    const now = Number(vector.timestamp);
    expect(verifyAgentRequest(headers, vector.method, vector.path, body, keys, now)).toEqual({ ok: false, reason: "bad_signature" });
    // Sanity check of the harness: the agent's own signature does verify there.
    expect(verifyAgentRequest({ ...headers, "x-histos-signature": agentRequest }, vector.method, vector.path, body, keys, now).ok).toBe(true);

    const agentResponse = signAgentResponse(key, vector.status, vector.nonce, vector.responseTimestamp, responseBody);
    const connectorResponse = signResponse(key, vector.status, vector.nonce, vector.instance, vector.responseTimestamp, responseBody);
    expect(sameSignature(connectorResponse, agentResponse)).toBe(false);
    const responseHeaders = { "x-histos-timestamp": vector.responseTimestamp, "x-histos-signature": connectorResponse };
    expect(verifyAgentResponse(responseHeaders, vector.status, vector.nonce, responseBody, key, Number(vector.responseTimestamp))).toBe(false);
    expect(verifyAgentResponse({ ...responseHeaders, "x-histos-signature": agentResponse }, vector.status, vector.nonce, responseBody, key, Number(vector.responseTimestamp))).toBe(true);
  });

  it("a response signature never stands in for a request signature", () => {
    const vector = vectors[1] as Vector;
    const key = keyOf(vector);
    const response = signResponse(key, vector.status, vector.nonce, vector.instance, vector.timestamp, bytes(vector.body));
    expect(sameSignature(signRequest(key, vector.method, vector.path, vector.timestamp, vector.nonce, vector.instance, vector.client, bytes(vector.body)), response)).toBe(false);
  });
});

describe("sameSignature", () => {
  const good = (vectors[0] as Vector).requestSignature;

  it("accepts the same signature and rejects a different one", () => {
    expect(sameSignature(good, good)).toBe(true);
    expect(sameSignature(good, (vectors[1] as Vector).requestSignature)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["no prefix", good.slice(3)],
    ["other version", `v2=${good.slice(3)}`],
    ["upper-case hex", `v1=${good.slice(3).toUpperCase()}`],
    ["63 hex digits", good.slice(0, -1)],
    ["65 hex digits", `${good}0`],
    ["not hex", `v1=${"g".repeat(64)}`],
    ["trailing newline", `${good}\n`],
    ["leading space", ` ${good}`],
  ])("rejects a malformed signature (%s) on either side", (_name, malformed) => {
    expect(sameSignature(good, malformed)).toBe(false);
    expect(sameSignature(malformed, good)).toBe(false);
    expect(sameSignature(malformed, malformed)).toBe(false);
    expect(validSignatureFormat(malformed)).toBe(false);
  });

  it("validSignatureFormat accepts only v1=<64 lower-case hex>", () => {
    expect(validSignatureFormat(good)).toBe(true);
    expect(validSignatureFormat(undefined)).toBe(false);
    expect(validSignatureFormat(["v1=", good])).toBe(false);
  });
});

describe("freshTimestamp", () => {
  const now = 1_793_000_000;

  it(`accepts at most ${MAX_SKEW_SECONDS} seconds either way`, () => {
    expect(MAX_SKEW_SECONDS).toBe(120);
    expect(freshTimestamp(String(now), now)).toBe(true);
    expect(freshTimestamp(String(now - 120), now)).toBe(true);
    expect(freshTimestamp(String(now + 120), now)).toBe(true);
    expect(freshTimestamp(String(now - 121), now)).toBe(false);
    expect(freshTimestamp(String(now + 121), now)).toBe(false);
  });

  it.each(["", "179300000", "17930000000", "1793000000.5", " 1793000000", "1793000000\n", "-179300000", "1e9000000x"])("rejects a malformed timestamp %j", (value) => {
    expect(freshTimestamp(value, now)).toBe(false);
  });

  it("uses the clock when no time is given", () => {
    expect(freshTimestamp(String(Math.floor(Date.now() / 1000)))).toBe(true);
    expect(freshTimestamp("1000000000")).toBe(false);
  });
});

describe("validNonce and cleanClientLabel", () => {
  it("accepts only 32 lower-case hex digits as a nonce", () => {
    expect(validNonce("00112233445566778899aabbccddeeff")).toBe(true);
    for (const value of ["", "00112233445566778899AABBCCDDEEFF", "00112233445566778899aabbccddeef", "00112233445566778899aabbccddeeff0", 42, null]) {
      expect(validNonce(value)).toBe(false);
    }
  });

  it("keeps only safe characters, at most 60, with a default", () => {
    expect(cleanClientLabel("claude-code 2.1.0")).toBe("claude-code 2.1.0");
    expect(cleanClientLabel("evil\nX-Injected: 1‮")).toBe("evilX-Injected 1");
    expect(cleanClientLabel("a".repeat(80))).toBe("a".repeat(60));
    expect(cleanClientLabel("  ")).toBe("agente");
    expect(cleanClientLabel(undefined)).toBe("agente");
    expect(cleanClientLabel({ name: "x" })).toBe("agente");
  });
});

describe("NonceCache", () => {
  const nonce = (index: number): string => index.toString(16).padStart(32, "0");

  it("refuses a replay", () => {
    const cache = new NonceCache(1000, 10);
    expect(cache.remember(nonce(1), 0)).toBe("ok");
    expect(cache.remember(nonce(1), 1)).toBe("replayed");
    expect(cache.remember(nonce(2), 1)).toBe("ok");
    expect(cache.size).toBe(2);
  });

  it("has() only looks: a nonce is not remembered until remember()", () => {
    const cache = new NonceCache(1000, 10);
    expect(cache.has(nonce(1), 0)).toBe(false);
    expect(cache.has(nonce(1), 0)).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.remember(nonce(1), 0)).toBe("ok");
    expect(cache.has(nonce(1), 1)).toBe(true);
  });

  it("forgets a nonce once its time is up", () => {
    const cache = new NonceCache(1000, 10);
    expect(cache.remember(nonce(1), 0)).toBe("ok");
    expect(cache.has(nonce(1), 999)).toBe(true);
    expect(cache.remember(nonce(1), 999)).toBe("replayed");
    expect(cache.has(nonce(1), 1000)).toBe(false);
    expect(cache.remember(nonce(1), 1000)).toBe("ok");
    expect(cache.has(nonce(1), 1999)).toBe(true);
  });

  it("when full it answers full and stays closed instead of clearing", () => {
    const cache = new NonceCache(1000, 3);
    for (let index = 0; index < 3; index++) expect(cache.remember(nonce(index), 0)).toBe("ok");
    expect(cache.remember(nonce(3), 10)).toBe("full");
    expect(cache.remember(nonce(4), 20)).toBe("full");
    expect(cache.size).toBe(3);
    // Nothing was dropped: the nonces already seen are still refused, the new ones were never let in.
    for (let index = 0; index < 3; index++) {
      expect(cache.has(nonce(index), 30)).toBe(true);
      expect(cache.remember(nonce(index), 30)).toBe("replayed");
    }
    expect(cache.has(nonce(3), 30)).toBe(false);
    expect(cache.remember(nonce(3), 999)).toBe("full");
  });

  it("reopens only as entries expire, one slot per expired nonce", () => {
    const cache = new NonceCache(1000, 3);
    expect(cache.remember(nonce(0), 0)).toBe("ok");
    expect(cache.remember(nonce(1), 500)).toBe("ok");
    expect(cache.remember(nonce(2), 500)).toBe("ok");
    expect(cache.remember(nonce(3), 1000)).toBe("ok");
    expect(cache.size).toBe(3);
    expect(cache.remember(nonce(4), 1000)).toBe("full");
    expect(cache.remember(nonce(1), 1000)).toBe("replayed");
  });

  it("uses the documented defaults: five minutes and 20 000 entries", () => {
    const cache = new NonceCache();
    expect(cache.remember(nonce(1), 0)).toBe("ok");
    expect(cache.has(nonce(1), 299_999)).toBe(true);
    expect(cache.has(nonce(1), 300_000)).toBe(false);
    const full = new NonceCache();
    for (let index = 0; index < 20_000; index++) full.remember(nonce(index), 0);
    expect(full.size).toBe(20_000);
    expect(full.remember(nonce(20_000), 1)).toBe("full");
  });
});
