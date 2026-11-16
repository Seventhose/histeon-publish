import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startFigmaMock, type FigmaMockHandle } from "../../cf-mock/src/figma.js";
import { FIGMA_TOKEN_ENV, FigmaApiError, FigmaClient, figmaClient, figmaFileKey, readFigmaToken, validFigmaToken } from "../src/figma.js";

// Not a real token: the shape of one, for the stand-in only.
const TOKEN = "figd_prova-NONVERO_0123456789abcdefABCDEF";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const FILE = { name: "Kit", document: { id: "0:0", type: "DOCUMENT", children: [] }, styles: {} };

describe("chiave di un file di Figma", () => {
  it("accetta la chiave e l'indirizzo del file, e nient'altro", () => {
    expect(figmaFileKey(` ${KEY} `)).toBe(KEY);
    expect(figmaFileKey(`https://www.figma.com/design/${KEY}/Il-mio-kit?node-id=1-2&t=abc`)).toBe(KEY);
    expect(figmaFileKey(`https://figma.com/file/${KEY}`)).toBe(KEY);
    for (const refused of ["", "corta", `http://www.figma.com/design/${KEY}/x`, `https://figma.com.evil.example/design/${KEY}/x`, `https://evil.example/design/${KEY}`, `https://www.figma.com/community/file/${KEY}`, `${KEY}/../../v1/me`, `${KEY}?x=1`]) {
      expect(() => figmaFileKey(refused), refused).toThrowError(expect.objectContaining({ code: "figma-file-key" }));
    }
  });
});

describe("client dell'API di Figma", () => {
  let mock: FigmaMockHandle | null = null;
  let other: Server | null = null;
  afterEach(async () => {
    await mock?.close();
    mock = null;
    if (other) await new Promise<void>((resolve) => other!.close(() => resolve()));
    other = null;
  });

  it("chiama solo api.figma.com in HTTPS, o il loopback in HTTP per il server finto", () => {
    expect(new FigmaClient({ token: TOKEN }).apiBase).toBe("https://api.figma.com");
    expect(new FigmaClient({ token: TOKEN, apiBase: "http://127.0.0.1:9/" }).apiBase).toBe("http://127.0.0.1:9");
    for (const refused of ["https://api.figma.com.evil.example", "https://evil.example", "http://api.figma.com", "http://192.168.1.4:8080", "https://user:pass@api.figma.com", "https://api.figma.com/v2", "https://api.figma.com?x=1", "ftp://127.0.0.1", "niente"]) {
      expect(() => new FigmaClient({ token: TOKEN, apiBase: refused }), refused).toThrowError(expect.objectContaining({ code: "figma-config" }));
    }
    expect(() => figmaClient(TOKEN, { HISTOS_FIGMA_API_BASE: "https://evil.example" })).toThrowError(expect.objectContaining({ code: "figma-config" }));
  });

  it("rifiuta un token vuoto, con spazi o con un a capo", () => {
    for (const refused of ["", "corto", `${TOKEN}\r\nX-Altro: 1`, `${TOKEN} `, "x".repeat(600)]) {
      expect(validFigmaToken(refused)).toBe(false);
      expect(() => new FigmaClient({ token: refused })).toThrowError(expect.objectContaining({ code: "figma-auth-missing" }));
    }
  });

  it("manda il token in X-Figma-Token e legge file, nodi e variabili", async () => {
    mock = await startFigmaMock({ token: TOKEN, files: { [KEY]: { file: FILE, nodes: { "1:2": { document: { id: "1:2" } } }, variables: { variables: {}, variableCollections: {} } } } });
    const client = new FigmaClient({ token: TOKEN, apiBase: mock.origin });
    expect(await client.me()).toEqual({ handle: "Prova" });
    expect(await client.file(KEY)).toMatchObject({ name: "Kit" });
    // An id the file does not have is left out; a hostile id never reaches the address.
    expect(await client.nodes(KEY, ["1:2", "9:9", "1:2", "x&ids=7", "a,b"])).toEqual({ "1:2": { document: { id: "1:2" } } });
    expect(await client.localVariables(KEY)).toMatchObject({ meta: { variables: {} } });
    expect(mock.requests.every((request) => request.token === TOKEN && request.credentialHeaders.length === 0 && request.method === "GET")).toBe(true);
    expect(mock.requests.map((request) => request.url)).toEqual(["/v1/me", `/v1/files/${KEY}`, `/v1/files/${KEY}/nodes?ids=1%3A2%2C9%3A9`, `/v1/files/${KEY}/variables/local`]);
    expect(mock.requests.some((request) => request.url.includes(TOKEN))).toBe(false);
  });

  it("senza il piano Enterprise le variabili sono null, gli altri rifiuti sono errori", async () => {
    mock = await startFigmaMock({ token: TOKEN, files: { [KEY]: { file: FILE } } });
    const client = new FigmaClient({ token: TOKEN, apiBase: mock.origin });
    expect(await client.localVariables(KEY)).toBeNull();
    await expect(client.file("ZzZzZzZzZzZzZzZzZzZz")).rejects.toMatchObject({ name: "FigmaApiError", status: 404 });
    const wrong = new FigmaClient({ token: `${TOKEN}x`, apiBase: mock.origin });
    await expect(wrong.me()).rejects.toMatchObject({ status: 403 });
    await expect(wrong.localVariables(KEY)).resolves.toBeNull();
  });

  it("un server che ripete il token nell'errore non lo fa arrivare nel messaggio", async () => {
    mock = await startFigmaMock({ token: TOKEN, echoToken: true, files: { [KEY]: { file: FILE } } });
    const client = new FigmaClient({ token: TOKEN, apiBase: mock.origin });
    const error = await client.file(KEY).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaApiError);
    expect((error as Error).message).toContain("[token rimosso]");
    expect(JSON.stringify(error) + (error as Error).message + String((error as Error).stack)).not.toContain(TOKEN);
  });

  it("non segue un rinvio: l'altro indirizzo non riceve niente", async () => {
    let received = 0;
    other = createServer((_request, response) => {
      received += 1;
      response.end("{}");
    });
    await new Promise<void>((resolve) => other!.listen(0, "127.0.0.1", resolve));
    mock = await startFigmaMock({ token: TOKEN, redirectTo: `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1/files/${KEY}`, files: { [KEY]: { file: FILE } } });
    const client = new FigmaClient({ token: TOKEN, apiBase: mock.origin });
    await expect(client.file(KEY)).rejects.toMatchObject({ status: 302 });
    expect(received).toBe(0);
  });

  it("ferma una risposta troppo grande e una rete che non risponde", async () => {
    mock = await startFigmaMock({ token: TOKEN, oversize: 200_000, files: { [KEY]: { file: FILE } } });
    const small = new FigmaClient({ token: TOKEN, apiBase: mock.origin, maxBytes: 50_000 });
    await expect(small.file(KEY)).rejects.toMatchObject({ status: 413 });
    const chunked = new FigmaClient({ token: TOKEN, apiBase: mock.origin, maxBytes: 50_000, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(60_000)); controller.close(); } })) });
    await expect(chunked.file(KEY)).rejects.toMatchObject({ status: 413 });
    const down = new FigmaClient({ token: TOKEN, apiBase: "http://127.0.0.1:9", fetch: async () => { throw new Error(`connect ECONNREFUSED con ${TOKEN}`); } });
    const error = await down.me().catch((caught: unknown) => caught) as Error;
    expect(error.message).toContain("non raggiungibile");
    expect(error.message).not.toContain(TOKEN);
  });

  it("legge il token dall'ambiente prima che dal portachiavi, e dice quando manca", async () => {
    const store = { get: async () => "dal-portachiavi-0123456789" };
    expect(await readFigmaToken(store, { [FIGMA_TOKEN_ENV]: ` ${TOKEN} ` })).toEqual({ token: TOKEN, source: "environment" });
    expect(await readFigmaToken(store, {})).toEqual({ token: "dal-portachiavi-0123456789", source: "keyring" });
    await expect(readFigmaToken({ get: async () => null }, {})).rejects.toMatchObject({ code: "figma-auth-missing" });
  });
});
