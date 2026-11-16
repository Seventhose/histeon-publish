import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCloudflareMock, type CloudflareMockHandle } from "../../cf-mock/src/index.js";
import { signAgentRequest, verifyAgentResponse } from "../src/agent-protocol.js";
import { generateAgentKey } from "../src/agent-config.js";
import { startAgent } from "../src/agent.js";

interface OriginFixture {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}
interface AgentHarness {
  directory: string;
  dataDir: string;
  configPath: string;
  base: string;
  port: number;
  keyId: string;
  key: Buffer;
  cloudflareToken: string;
  mock: CloudflareMockHandle;
  runtime: Awaited<ReturnType<typeof startAgent>>;
  startAgain(): Promise<void>;
  close(): Promise<void>;
}
interface SignedResponse { status: number; headers: Headers; bytes: Buffer; nonce: string; json: Record<string, unknown> | null }

let currentHarness: AgentHarness | undefined;
let currentFixture: OriginFixture | undefined;
const originalEnvironment: Map<string, string | undefined> = new Map();

function setTestEnvironment(name: string, value: string | undefined): void {
  if (!originalEnvironment.has(name)) originalEnvironment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  await currentHarness?.close().catch(() => undefined);
  currentHarness = undefined;
  await currentFixture?.close().catch(() => undefined);
  currentFixture = undefined;
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnvironment.clear();
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Porta locale non assegnata.");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startOrigin(options: { echo?: boolean; html?: string | ((exportToken: string) => string); noEchoPath?: string; delayFirstRootMs?: number } = {}): Promise<OriginFixture> {
  const requests: string[] = [];
  let delayedRoot = false;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    requests.push(url.pathname + url.search);
    const exportToken = request.headers["x-xb-export"];
    const send = (status: number, contentType: string, body: string): void => {
      const echo = options.echo !== false && url.pathname !== options.noEchoPath && typeof exportToken === "string"
        ? { "X-XB-Export-Render": exportToken }
        : {};
      response.writeHead(status, { "Content-Type": contentType, ...echo });
      response.end(body);
    };
    const handle = (): void => {
      if (url.pathname === "/robots.txt" || /\.(?:xml)$/u.test(url.pathname) || url.pathname === "/wp-json/" || url.pathname.startsWith("/wp-json/")) {
        send(404, "text/plain; charset=utf-8", "Not Found");
        return;
      }
      if (url.pathname.startsWith("/histos-404-")) {
        send(404, "text/html; charset=utf-8", "<!doctype html><html><head><title>Pagina non trovata</title></head><body><h1>fixture-404-page</h1></body></html>");
        return;
      }
      if (url.pathname === "/favicon.ico") {
        send(404, "text/plain; charset=utf-8", "Not Found");
        return;
      }
      if (url.pathname.endsWith("/style.css")) {
        send(200, "text/css; charset=utf-8", "body { color: #223; }");
        return;
      }
      let title = "Home";
      if (url.pathname === "/about/" || url.pathname === "/about") title = "About page";
      else if (url.pathname === "/orphan-one/" || url.pathname === "/orphan-one") title = "Orphan one";
      else if (url.pathname === "/orphan-two/" || url.pathname === "/orphan-two") title = "Orphan two";
      else if (url.pathname === "/orphan-three/" || url.pathname === "/orphan-three") title = "Orphan three";
      else if (url.pathname !== "/") {
        send(404, "text/plain; charset=utf-8", "Not Found");
        return;
      }
      const suppliedHtml = typeof options.html === "function" ? options.html(String(exportToken ?? "")) : options.html;
      send(200, "text/html; charset=utf-8", suppliedHtml ?? `<!doctype html><html lang="it"><head><meta name="generator" content="WordPress"><link rel="stylesheet" href="/wp-content/themes/demo/style.css"><title>${title}</title></head><body><main><h1>${title}</h1><a href="/about/">About</a></main></body></html>`);
    };
    if (url.pathname === "/" && options.delayFirstRootMs && !delayedRoot) {
      delayedRoot = true;
      setTimeout(handle, options.delayFirstRootMs);
    } else handle();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP non avviata.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function makeHarness(options: { origin?: string; script?: string; cloudflareToken?: string; timeoutMs?: number } = {}): Promise<AgentHarness> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-agent-test-"));
  const dataDir = path.join(directory, "data");
  const mockToken = options.cloudflareToken ?? `test-token-${randomBytes(12).toString("hex")}`;
  const mock = await startCloudflareMock({ token: mockToken });
  const keyId = "test-key";
  const keysPath = path.join(directory, "agent-keys.json");
  const secret = await generateAgentKey(keysPath, keyId);
  const key = Buffer.from(secret, "base64url");
  const port = await freePort();
  const configPath = path.join(directory, "agent.json");
  const config = {
    schemaVersion: 1,
    listen: { host: "127.0.0.1", port, allowedHosts: [`127.0.0.1:${port}`] },
    dataDir,
    site: {
      name: "fixture-site",
      origin: options.origin ?? "http://127.0.0.1:1",
      privateNetwork: true,
      crawl: { concurrency: 2, delayMs: 0, timeoutMs: options.timeoutMs ?? 3000, maxPages: 50, maxDepth: 5, maxBytes: 20 * 1024 * 1024, includeFeeds: false },
      rewrite: { externalAssets: [] },
      pagefind: false,
    },
    cloudflare: { accountId: mock.accountId, script: options.script ?? "agent-fixture", maxFiles: 20000 },
    limits: { publishPerHour: 30, requestsPerMinute: 120 },
    retention: { jobsDays: 90, keepBundles: 1 },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  setTestEnvironment("HISTOS_CLOUDFLARE_API_TOKEN_FILE", undefined);
  setTestEnvironment("HISTOS_CLOUDFLARE_API_TOKEN", mockToken);
  setTestEnvironment("HISTOS_AGENT_KEYS_FILE", keysPath);
  setTestEnvironment("HISTOS_CLOUDFLARE_API_BASE", mock.url);
  let runtime = await startAgent(configPath);
  let closed = false;
  const result: AgentHarness = {
    directory, dataDir, configPath, base: `http://127.0.0.1:${port}`, port, keyId, key,
    cloudflareToken: mockToken, mock, runtime,
    async startAgain() { runtime = await startAgent(configPath); result.runtime = runtime; },
    async close() {
      if (closed) return;
      closed = true;
      await runtime.stop();
      await mock.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return result;
}

async function signedRequest(
  harness: AgentHarness,
  method: string,
  requestPath: string,
  body?: Buffer,
  options: { nonce?: string; timestamp?: string; signature?: string; origin?: string } = {},
): Promise<SignedResponse> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(16).toString("hex");
  const bytes = body ?? Buffer.alloc(0);
  const signature = options.signature ?? signAgentRequest(harness.key, method, requestPath, timestamp, nonce, harness.keyId, bytes);
  const headers: Record<string, string> = {
    "X-Histos-Key": harness.keyId,
    "X-Histos-Timestamp": timestamp,
    "X-Histos-Nonce": nonce,
    "X-Histos-Signature": signature,
  };
  if (method !== "GET" || body) headers["Content-Type"] = "application/json";
  if (options.origin) headers.Origin = options.origin;
  const response = await fetch(harness.base + requestPath, { method, headers, ...(method === "GET" ? {} : { body: bytes }) });
  const responseBytes = Buffer.from(await response.arrayBuffer());
  const text = responseBytes.toString("utf8");
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 204 health check. */ }
  return { status: response.status, headers: response.headers, bytes: responseBytes, nonce, json };
}

function responseIsSigned(response: SignedResponse, key: Buffer, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return verifyAgentResponse({
    "x-histos-timestamp": response.headers.get("x-histos-timestamp") ?? undefined,
    "x-histos-signature": response.headers.get("x-histos-signature") ?? undefined,
  }, response.status, response.nonce, response.bytes, key, nowSeconds);
}

async function publish(harness: AgentHarness, options: { paths?: string[]; exportToken?: string; label?: string; requestId?: string } = {}): Promise<{ id: string; response: SignedResponse; body: Buffer }> {
  const token = options.exportToken ?? `${Math.floor(Date.now() / 1000) + 900}.${"a".repeat(64)}`;
  const body = Buffer.from(JSON.stringify({
    request_id: options.requestId ?? randomUUID(),
    release: { version: "1.0.0", ...(options.label ? { label: options.label } : {}) },
    export_token: token,
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  }));
  const response = await signedRequest(harness, "POST", "/v1/publish", body);
  const job = response.json?.job as { id?: unknown } | undefined;
  if (typeof job?.id !== "string") throw new Error(`La richiesta di pubblicazione ha risposto ${response.status}.`);
  return { id: job.id, response, body };
}

async function waitForFinalJob(harness: AgentHarness, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const response = await signedRequest(harness, "GET", `/v1/jobs/${id}`);
    expect(response.status).toBe(200);
    expect(responseIsSigned(response, harness.key)).toBe(true);
    const job = response.json?.job as Record<string, unknown> | undefined;
    if (job && ["complete", "blocked", "failed", "cancelled", "superseded"].includes(String(job.status))) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Il job ${id} non è terminato nel tempo previsto.`);
}

// The publishing agent is a Linux service (docs/spec/agente-di-pubblicazione.md): it refuses to start elsewhere.
describe.skipIf(process.platform !== "linux")("agente di pubblicazione con rete locale e mock Cloudflare", () => {
  it("applica Host/Origin/metodo/content-type/dimensione e firma solo le risposte autenticate", async () => {
    currentHarness = await makeHarness();
    const harness = currentHarness;

    const healthy = await fetch(`${harness.base}/healthz`);
    expect(healthy.status).toBe(204);
    expect(await healthy.text()).toBe("");

    const info = await signedRequest(harness, "GET", "/v1/info");
    expect(info.status).toBe(200);
    expect(responseIsSigned(info, harness.key)).toBe(true);
    expect(info.json).toMatchObject({ api_version: 1, site: { origin: "http://127.0.0.1:1" }, cloudflare: { script: "agent-fixture" } });
    expect(JSON.stringify(info.json)).not.toContain(harness.cloudflareToken);
    const missing = await signedRequest(harness, "GET", "/not-a-route");
    expect(missing.status).toBe(404);
    expect(responseIsSigned(missing, harness.key)).toBe(true);

    const missingAuth = await fetch(`${harness.base}/v1/info`);
    const missingBytes = Buffer.from(await missingAuth.arrayBuffer());
    const badSignature = await signedRequest(harness, "GET", "/v1/info", undefined, { signature: "v1=" + "0".repeat(64) });
    const staleSignature = await signedRequest(harness, "GET", "/v1/info", undefined, {
      timestamp: String(Math.floor(Date.now() / 1000) - 301),
    });
    expect(missingAuth.status).toBe(401);
    expect(badSignature.status).toBe(401);
    expect(staleSignature.status).toBe(401);
    expect(badSignature.bytes.equals(missingBytes)).toBe(true);
    expect(staleSignature.bytes.equals(missingBytes)).toBe(true);
    for (const response of [badSignature, staleSignature]) expect(response.headers.get("x-histos-signature")).toBeNull();

    const withOrigin = await signedRequest(harness, "GET", "/v1/info", undefined, { origin: harness.base });
    expect(withOrigin.status).toBe(403);
    expect(withOrigin.headers.get("x-histos-signature")).toBeNull();
    const wrongMethod = await signedRequest(harness, "POST", "/v1/info", Buffer.from("{}"));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(wrongMethod.headers.get("x-histos-signature")).toBeNull();

    const unsupported = await fetch(`${harness.base}/v1/publish`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    const tooLarge = await fetch(`${harness.base}/v1/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers.get("x-histos-signature")).toBeNull();
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get("x-histos-signature")).toBeNull();

    const badHost = await new Promise<{ status: number; body: Buffer; signed: boolean }>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: harness.port, path: "/v1/info", headers: { Host: `attacker.invalid:${harness.port}` } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), signed: response.headers["x-histos-signature"] !== undefined }));
      });
      request.once("error", reject);
      request.end();
    });
    expect(badHost.status).toBe(400);
    expect(badHost.body.equals(Buffer.from('{"error":{"code":"invalid_host","message":"Host non consentito.","retryable":false}}'))).toBe(true);
    expect(badHost.signed).toBe(false);
  });

  it("rifiuta tutti i percorsi seed che possono uscire dal sito o superano i limiti", async () => {
    currentHarness = await makeHarness();
    const harness = currentHarness;
    const invalidPaths = [
      ["/../fuori"], ["/%2e%2e/fuori"], ["//example.test"], ["/pagina?x=1"], ["/pagina#frammento"],
      ["/pagina\\altra"], ["/riga\nnuova"], ["/" + "a".repeat(1024)], ["/%"],
      Array.from({ length: 20001 }, () => "/pagina"),
    ];
    for (const paths of invalidPaths) {
      const body = Buffer.from(JSON.stringify({
        request_id: randomUUID(), release: { version: "1.0.0" },
        export_token: `${Math.floor(Date.now() / 1000) + 900}.${"a".repeat(64)}`,
        paths,
      }));
      const response = await signedRequest(harness, "POST", "/v1/publish", body);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: "invalid_request", retryable: false } });
      expect(responseIsSigned(response, harness.key)).toBe(true);
    }
  });

  it("rifiuta un nonce ripetuto anche dopo il riavvio e marca i job pendenti come agent_restarted", async () => {
    currentHarness = await makeHarness();
    const harness = currentHarness;
    await expect(startAgent(harness.configPath)).rejects.toMatchObject({ code: "agent-already-running", exitCode: 2 });
    const nonce = "00112233445566778899aabbccddeeff";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const first = await signedRequest(harness, "GET", "/v1/info", undefined, { nonce, timestamp });
    expect(first.status).toBe(200);
    const duplicate = await signedRequest(harness, "GET", "/v1/info", undefined, { nonce, timestamp });
    expect(duplicate.status).toBe(401);
    expect(duplicate.bytes.equals((await fetch(`${harness.base}/v1/info`).then(async (response) => Buffer.from(await response.arrayBuffer()))))).toBe(true);

    await harness.runtime.stop();
    const database = new DatabaseSync(path.join(harness.dataDir, "agent.db"));
    const jobId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    database.prepare("INSERT INTO jobs(id,type,status,phase,request_id,key_id,body_sha256,release_version,release_label,rollback_target,created_at,started_at,finished_at,progress_json,findings_json,error_json,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(jobId, "publish", "queued", null, randomUUID(), harness.keyId, "a".repeat(64), "1.0.0", null, null, new Date().toISOString(), null, null,
        JSON.stringify({ pages: 0, assets: 0, bytes: 0, uploaded: 0, to_upload: 0 }), JSON.stringify({ block: 0, warn: 0, items: [] }), null, null);
    database.close();
    await harness.startAgain();

    const replayAfterRestart = await signedRequest(harness, "GET", "/v1/info", undefined, { nonce, timestamp });
    expect(replayAfterRestart.status).toBe(401);
    expect(replayAfterRestart.bytes.equals(duplicate.bytes)).toBe(true);
    const restartedJob = await signedRequest(harness, "GET", `/v1/jobs/${jobId}`);
    expect(restartedJob.status).toBe(200);
    expect(restartedJob.json?.job).toMatchObject({ status: "failed", error: { code: "agent_restarted", retryable: true } });
  });

  it("rende idempotente request_id, rifiuta il riuso con un altro corpo e sostituisce la richiesta in coda", async () => {
    currentFixture = await startOrigin({ delayFirstRootMs: 1200 });
    currentHarness = await makeHarness({ origin: currentFixture.origin });
    const harness = currentHarness;
    const requestId = randomUUID();
    const first = await publish(harness, { requestId });
    expect(first.response.status).toBe(202);
    const same = await signedRequest(harness, "POST", "/v1/publish", first.body);
    expect(same.status).toBe(200);
    expect((same.json?.job as { id?: string })?.id).toBe(first.id);

    const reusedBody = Buffer.from(JSON.stringify({
      request_id: requestId,
      release: { version: "1.0.0", label: "corpo diverso" },
      export_token: `${Math.floor(Date.now() / 1000) + 900}.${"b".repeat(64)}`,
    }));
    const reused = await signedRequest(harness, "POST", "/v1/publish", reusedBody);
    expect(reused.status).toBe(409);
    expect(responseIsSigned(reused, harness.key)).toBe(true);

    const unknownField = await signedRequest(harness, "POST", "/v1/publish", Buffer.from(JSON.stringify({
      request_id: randomUUID(),
      release: { version: "1.0.0" },
      export_token: `${Math.floor(Date.now() / 1000) + 900}.${"a".repeat(64)}`,
      wordpress_url: "https://attacker.example",
    })));
    expect(unknownField.status).toBe(400);
    expect(unknownField.json).toMatchObject({ error: { code: "invalid_request", retryable: false } });
    expect(responseIsSigned(unknownField, harness.key)).toBe(true);

    while (!currentFixture.requests.some((request) => request === "/" || request.startsWith("/?"))) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await publish(harness, { label: "release due" });
    const third = await publish(harness, { label: "release tre" });
    const superseded = await waitForFinalJob(harness, second.id);
    expect(superseded).toMatchObject({ status: "superseded" });
    const finalJob = await waitForFinalJob(harness, third.id);
    expect(["complete", "blocked", "failed"]).toContain(finalJob.status);
  });

  it("pubblica su mock Cloudflare, include le pagine seed e serve la pagina 404 acquisita", async () => {
    currentFixture = await startOrigin();
    currentHarness = await makeHarness({ origin: currentFixture.origin });
    const harness = currentHarness;
    const created = await publish(harness, { paths: ["/orphan-one/", "/orphan-two/", "/orphan-three/"] });
    expect(created.response.status).toBe(202);
    expect(responseIsSigned(created.response, harness.key)).toBe(true);
    const job = await waitForFinalJob(harness, created.id);
    expect(job).toMatchObject({ status: "complete", error: null });
    const result = job.result as { deployment_id?: string; files?: number };
    expect(result.deployment_id).toBeTruthy();
    expect(result.files).toBeGreaterThanOrEqual(5);
    const publicBase = harness.mock.url.replace(/\/client\/v4$/u, "") + "/__site/agent-fixture/";
    for (const page of ["orphan-one", "orphan-two", "orphan-three"]) {
      const response = await fetch(`${publicBase}${page}/`);
      expect(response.status).toBe(200);
      expect((await response.text()).toLowerCase()).toContain(page.replace("-", " "));
    }
    const missing = await fetch(`${publicBase}mai-esistita/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("fixture-404-page");

    const deployments = await signedRequest(harness, "GET", "/v1/deployments");
    expect(deployments.status).toBe(200);
    expect(responseIsSigned(deployments, harness.key)).toBe(true);
    const listedDeployments = deployments.json as { deployments: Array<{ id: string }> };
    expect(listedDeployments.deployments.some((item) => item.id === result.deployment_id)).toBe(true);
    expect(harness.mock.state().scripts[`${harness.mock.accountId}/agent-fixture`]?.deployments).toHaveLength(2);

    const rollback = await signedRequest(harness, "POST", "/v1/rollback", Buffer.from(JSON.stringify({ request_id: randomUUID(), target: result.deployment_id })));
    expect(rollback.status).toBe(202);
    const rollbackId = (rollback.json?.job as { id?: string })?.id;
    expect(rollbackId).toBeTruthy();
    expect(await waitForFinalJob(harness, rollbackId as string)).toMatchObject({ status: "complete" });

    const unknownRollback = await signedRequest(harness, "POST", "/v1/rollback", Buffer.from(JSON.stringify({ request_id: randomUUID(), target: "deadbeef" })));
    const unknownId = (unknownRollback.json?.job as { id?: string })?.id;
    expect(unknownId).toBeTruthy();
    expect(await waitForFinalJob(harness, unknownId as string)).toMatchObject({ status: "failed", error: { code: "rollback_target_unknown" } });
  });

  it("blocca il job se una pagina HTML non conferma la modalità export", async () => {
    currentFixture = await startOrigin({ noEchoPath: "/about/" });
    currentHarness = await makeHarness({ origin: currentFixture.origin });
    const harness = currentHarness;
    const noEcho = await publish(harness);
    const failedEcho = await waitForFinalJob(harness, noEcho.id);
    expect(failedEcho).toMatchObject({ status: "failed", error: { code: "export_mode_not_confirmed" } });
    expect(harness.mock.state().scripts[`${harness.mock.accountId}/agent-fixture`]).toBeUndefined();
  });

  it("blocca i moduli nativi Histeon senza inviare il deploy", async () => {
    currentFixture = await startOrigin({ html: '<!doctype html><html><head><meta name="generator" content="WordPress"></head><body><input type="hidden" name="xb_form" value="contact"></body></html>' });
    currentHarness = await makeHarness({ origin: currentFixture.origin });
    const harness = currentHarness;
    const formJob = await publish(harness);
    const blocked = await waitForFinalJob(harness, formJob.id);
    expect(blocked).toMatchObject({ status: "blocked", error: { code: "scan_blocked" } });
    expect((blocked.findings as { items: Array<{ code: string }> }).items.some((item) => item.code === "histos-forms-unsupported")).toBe(true);
    expect(harness.mock.state().scripts[`${harness.mock.accountId}/agent-fixture`]).toBeUndefined();
  });

  it("blocca un nonce WordPress rilevato nello scanner", async () => {
    currentFixture = await startOrigin({ html: '<!doctype html><html><head></head><body><script>const requestData={"nonce":"0123456789"};</script></body></html>' });
    currentHarness = await makeHarness({ origin: currentFixture.origin });
    const harness = currentHarness;
    const created = await publish(harness);
    const blocked = await waitForFinalJob(harness, created.id);
    expect(blocked).toMatchObject({ status: "blocked", error: { code: "scan_blocked" } });
    expect((blocked.findings as { items: Array<{ code: string }> }).items.some((item) => item.code === "wordpress-nonce")).toBe(true);
    expect(harness.mock.state().scripts[`${harness.mock.accountId}/agent-fixture`]).toBeUndefined();
  });

  it("fallisce se il token di export scade durante il crawl", async () => {
    currentFixture = await startOrigin({ delayFirstRootMs: 2500 });
    currentHarness = await makeHarness({ origin: currentFixture.origin, timeoutMs: 5000 });
    const harness = currentHarness;
    const expiring = await publish(harness, { exportToken: `${Math.floor(Date.now() / 1000) + 2}.${"c".repeat(64)}` });
    expect(await waitForFinalJob(harness, expiring.id)).toMatchObject({ status: "failed", error: { code: "export_token_expired", retryable: true } });
    expect(harness.mock.state().scripts[`${harness.mock.accountId}/agent-fixture`]).toBeUndefined();
  });

  it("non salva segreti nelle release, nei file del bundle, nel database o nei log", async () => {
    const cloudflareToken = "test-token-never-persist-this-value";
    currentFixture = await startOrigin({ html: (exportToken) => `<!doctype html><html><head></head><body><p>${cloudflareToken}</p><p>${exportToken}</p></body></html>` });
    let stdout = "";
    let stderr = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write);
    currentHarness = await makeHarness({ origin: currentFixture.origin, cloudflareToken });
    const harness = currentHarness;
    const releaseLabel = `release-${cloudflareToken}`;
    const exportToken = `${Math.floor(Date.now() / 1000) + 900}.${"d".repeat(64)}`;
    const created = await publish(harness, { label: releaseLabel, exportToken });
    const result = await waitForFinalJob(harness, created.id);
    expect(result).toMatchObject({ status: "blocked", error: { code: "scan_blocked" } });
    expect(result.findings).toMatchObject({ items: [{ code: "agent-secret-content", severity: "block" }] });
    expect(created.response.bytes.toString("utf8")).not.toContain(cloudflareToken);
    expect(created.response.bytes.toString("utf8")).not.toContain(exportToken);
    await harness.runtime.stop();
    const inspect = async (directory: string): Promise<string[]> => {
      const output: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) output.push(...await inspect(item));
        else output.push(await readFile(item, "utf8").catch(() => ""));
      }
      return output;
    };
    const persisted = (await inspect(harness.dataDir)).join("\n");
    expect(persisted).not.toContain(cloudflareToken);
    expect(persisted).not.toContain(releaseLabel);
    expect(persisted).not.toContain(exportToken);
    expect(stdout).not.toContain(cloudflareToken);
    expect(stdout).not.toContain(releaseLabel);
    expect(stdout).not.toContain(exportToken);
    expect(stderr).not.toContain(cloudflareToken);
    expect(stderr).not.toContain(exportToken);
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("annulla un job durante il crawl e non distribuisce asset su Cloudflare", async () => {
    currentFixture = await startOrigin({ delayFirstRootMs: 1200 });
    currentHarness = await makeHarness({ origin: currentFixture.origin });
    const harness = currentHarness;
    const created = await publish(harness);
    while (!currentFixture.requests.some((request) => request === "/" || request.startsWith("/?"))) await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await signedRequest(harness, "POST", `/v1/jobs/${created.id}/cancel`, Buffer.from("{}"));
    expect(cancelled.status).toBe(200);
    const final = await waitForFinalJob(harness, created.id);
    expect(final).toMatchObject({ status: "cancelled", error: null });
    expect(harness.mock.state().scripts[`${harness.mock.accountId}/agent-fixture`]).toBeUndefined();
  });

});
