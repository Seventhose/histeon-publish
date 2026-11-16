import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", async () => {
  const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises");
  return { ...actual, lookup: lookupMock };
});

import { SafeHttpClient } from "../src/crawler-http.js";

const servers: Server[] = [];

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ origin: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Porta fixture non disponibile.");
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  lookupMock.mockReset();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("eccezione di rete privata per l’origine del crawler", () => {
  it("controlla gli header senza scaricare il corpo e blocca reti private in modalità pubblica", async () => {
    const source = await fixture((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(Buffer.alloc(2 * 1024 * 1024, 65));
    });
    const client = new SafeHttpClient({ origin: source.origin, userAgent: "test", timeoutMs: 1000, delayMs: 0, strictOrigin: true });
    const result = await client.probe(source.origin, { headers: { Range: "bytes=0-0" } });
    expect(result).toMatchObject({ status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    expect(source.requests[0]?.headers.range).toBe("bytes=0-0");

    const privateLiteral = new SafeHttpClient({ origin: "https://127.0.0.1", userAgent: "test", timeoutMs: 1000, delayMs: 0, publicOnly: true, strictOrigin: true });
    await expect(privateLiteral.probe("https://127.0.0.1")).rejects.toMatchObject({ code: "crawl-private-network" });

    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const privateDns = new SafeHttpClient({ origin: "https://private-test.example", userAgent: "test", timeoutMs: 1000, delayMs: 0, publicOnly: true, strictOrigin: true });
    await expect(privateDns.probe("https://private-test.example")).rejects.toMatchObject({ code: "crawl-private-network" });
    expect(source.requests).toHaveLength(1);
  });

  it("consente l’origine privata configurata, ma blocca asset privati e risoluzioni miste", async () => {
    const source = await fixture((_request, response) => response.end("sorgente"));
    const asset = await fixture((_request, response) => response.end("asset"));
    lookupMock.mockImplementation(async (hostname: string) => hostname === "origine.test"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }]);
    const origin = source.origin.replace("127.0.0.1", "origine.test");
    const client = new SafeHttpClient({ origin, userAgent: "test", timeoutMs: 1000, delayMs: 0, privateOrigin: true });
    await expect(client.get(origin)).resolves.toMatchObject({ status: 200 });

    const external = new SafeHttpClient({
      origin,
      userAgent: "test",
      timeoutMs: 1000,
      delayMs: 0,
      privateOrigin: true,
      externalAssets: [asset.origin.replace("127.0.0.1", "origine.test")],
    });
    const externalUrl = asset.origin.replace("127.0.0.1", "origine.test");
    await expect(external.get(externalUrl)).rejects.toMatchObject({ code: "crawl-private-network" });
    expect(asset.requests).toHaveLength(0);

    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }, { address: "8.8.8.8", family: 4 }]);
    await expect(new SafeHttpClient({ origin, userAgent: "test", timeoutMs: 1000, delayMs: 0, privateOrigin: true }).get(origin))
      .rejects.toMatchObject({ code: "crawl-private-network" });
  });

  it("mantiene bloccata la sorgente privata senza opzione e non inoltra header dell’origine agli asset", async () => {
    const source = await fixture((_request, response) => response.end("sorgente"));
    const asset = await fixture((_request, response) => response.end("asset"));
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const privateHostnameOrigin = source.origin.replace("127.0.0.1", "privata.test");
    const noOverride = new SafeHttpClient({ origin: privateHostnameOrigin, userAgent: "test", timeoutMs: 1000, delayMs: 0 });
    await expect(noOverride.get(privateHostnameOrigin)).rejects.toMatchObject({ code: "crawl-private-network" });

    const sameLoopbackHostAsset = asset.origin;
    const client = new SafeHttpClient({
      origin: source.origin,
      userAgent: "test",
      timeoutMs: 1000,
      delayMs: 0,
      privateOrigin: true,
      originHeaders: { "X-XB-Export": "synthetic-export-token" },
      externalAssets: [sameLoopbackHostAsset],
    });
    await client.get(source.origin);
    await client.get(sameLoopbackHostAsset);
    expect(source.requests[0]?.headers["x-xb-export"]).toBe("synthetic-export-token");
    expect(asset.requests[0]?.headers["x-xb-export"]).toBeUndefined();
  });

  it("invia JSON con POST soltanto alla stessa origine autorizzata e non memorizza la risposta", async () => {
    const source = await fixture((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => response.end(JSON.stringify({ method: request.method, contentType: request.headers["content-type"], body: JSON.parse(body) })));
    });
    const client = new SafeHttpClient({ origin: source.origin, userAgent: "test", timeoutMs: 1000, delayMs: 0, privateOrigin: true, strictOrigin: true });

    const response = await client.postJson(source.origin, { nonce: "synthetic-nonce" });
    expect(response).toMatchObject({ status: 200, fromCache: false, notModified: false });
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({
      method: "POST",
      contentType: "application/json; charset=utf-8",
      body: { nonce: "synthetic-nonce" },
    });
    await expect(client.postJson(source.origin.replace("127.0.0.1", "other.example"), { nonce: "synthetic-nonce" })).rejects.toMatchObject({ code: "crawl-cross-origin" });
    expect(source.requests).toHaveLength(1);
  });
});
