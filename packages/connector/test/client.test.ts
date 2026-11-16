import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorClient, RESPONSE_MAX_BYTES } from "../src/client.js";
import { ConnectorError } from "../src/errors.js";
import { HEADERS, signResponse } from "../src/protocol.js";
import { readSessionFile } from "../src/session-file.js";
import { deadPid, defaultResponder, type FakeApp, helloBody, removeDirectory, type Responder, startFakeApp, tempDirectory, VALID_PROTOTYPE, waitFor } from "./fake-app.js";

const posix = process.platform !== "win32";
const apps: FakeApp[] = [];
const directories: string[] = [];

async function fakeApp(respond?: Responder): Promise<FakeApp> {
  const app = await startFakeApp(respond ? { respond } : {});
  apps.push(app);
  return app;
}

function clientFor(app: Pick<FakeApp, "dataDirectory">): ConnectorClient {
  return new ConnectorClient({ dataDirectory: app.dataDirectory, client: "test" });
}

async function failure(promise: Promise<unknown>): Promise<ConnectorError> {
  const error = await promise.then(
    () => new Error("expected the call to fail"),
    (reason: unknown) => reason,
  );
  if (error instanceof ConnectorError) return error;
  throw error;
}

const urls = (app: FakeApp): string[] => app.requests.map((request) => request.url);
const sessionPath = (app: FakeApp): string => path.join(app.dataDirectory, "connector", "session.json");

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    removeDirectory(app.dataDirectory);
  }
  for (const directory of directories.splice(0)) removeDirectory(directory);
});

describe("ConnectorClient: a working app", () => {
  it("says hello once per instance, then signs every call with its body", async () => {
    const app = await fakeApp();
    const client = clientFor(app);
    expect(await client.call("listProjects", { limit: 5 })).toEqual({ ok: true, operation: "listProjects", arguments: { limit: 5 } });
    expect(await client.call("status", {})).toMatchObject({ ok: true, operation: "status" });
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/call"]);
    const [hello, call] = app.requests;
    expect(hello?.method).toBe("GET");
    expect(hello?.body.byteLength).toBe(0);
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body.toString("utf8") ?? "")).toEqual({ operation: "listProjects", arguments: { limit: 5 } });
    for (const request of app.requests) {
      expect(request.validSignature).toBe(true);
      expect(request.headers.host).toBe(`127.0.0.1:${app.port}`);
      expect(request.headers[HEADERS.instance]).toBe(app.instance);
      expect(request.headers[HEADERS.client]).toBe("test");
      // Nothing a browser would send: the app refuses those even with a valid signature.
      for (const name of ["origin", "referer", "cookie", "authorization", "x-histos-token", "transfer-encoding"]) expect(request.headers[name]).toBeUndefined();
      expect(Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-"))).toBe(false);
    }
    expect(call?.headers["content-type"]).toBe("application/json");
  });

  it("shares one hello between concurrent calls", async () => {
    const app = await fakeApp();
    const client = clientFor(app);
    await Promise.all([client.call("status", {}), client.call("listWordPress", {}), client.call("listProjects", {})]);
    expect(urls(app).filter((url) => url === "/v1/hello")).toHaveLength(1);
    expect(urls(app).filter((url) => url === "/v1/call")).toHaveLength(3);
  });

  it("covers the prototype query with the signature and sends the HTML as text/html", async () => {
    const app = await fakeApp();
    const client = clientFor(app);
    const source = { bytes: Buffer.from(VALID_PROTOTYPE), name: "sito caffè?.html", sha256: "x" };
    expect(await client.prototype("import", source, { update: true, download: false })).toMatchObject({ valid: true });
    const request = app.requests[1];
    expect(request?.url).toBe("/v1/prototype?mode=import&update=1&download=0&source=sito-caff-.html");
    expect(request?.validSignature).toBe(true);
    expect(request?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(request?.body.toString("utf8")).toBe(VALID_PROTOTYPE);
  });

  it("turns a signed error into a ConnectorError with the app's code, clean text and exit code", async () => {
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      const call = JSON.parse(request.body.toString("utf8")) as { operation: string };
      if (call.operation === "getProject") return { status: 409, body: { error: "Il progetto‮ esiste\u0007 già.", code: "cms-prototype-update-requires-flag", projectId: "abc" } };
      if (call.operation === "listProjects") return { status: 429, body: { error: "Troppe richieste.", code: "connector-rate-limited" }, headers: { "Retry-After": "30" } };
      if (call.operation === "listBuilds") return { status: 422, body: { error: "No.", code: "Not A Code!" } };
      return { status: 503, body: { code: "connector-busy" } };
    });
    const client = clientFor(app);
    const conflict = await failure(client.call("getProject", { projectId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }));
    expect(conflict.code).toBe("cms-prototype-update-requires-flag");
    expect(conflict.message).toBe("Il progetto esiste già.");
    expect(conflict.exitCode).toBe(2);
    expect(conflict.details).toEqual({ projectId: "abc" });
    const limited = await failure(client.call("listProjects", {}));
    expect(limited.code).toBe("connector-rate-limited");
    expect(limited.message).toBe("Troppe richieste. Riprova fra 30 secondi.");
    expect(limited.exitCode).toBe(1);
    const odd = await failure(client.call("listBuilds", { projectId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }));
    expect(odd.code).toBe("http-422");
    const busy = await failure(client.call("status", {}));
    expect(busy.code).toBe("connector-busy");
    expect(busy.message).toBe("Errore 503.");
    expect(busy.exitCode).toBe(1);
  });

  it("never sends a call whose signal is already aborted", async () => {
    const app = await fakeApp();
    const client = clientFor(app);
    const controller = new AbortController();
    controller.abort();
    expect((await failure(client.call("status", {}, controller.signal))).code).toBe("connector-cancelled");
    expect(urls(app)).toEqual(["/v1/hello"]);
  });

  it("refuses arguments over 64 KiB before contacting the app", async () => {
    const app = await fakeApp();
    const error = await failure(clientFor(app).call("status", { padding: "x".repeat(70 * 1024) }));
    expect(error.code).toBe("connector-invalid-arguments");
    expect(app.requests).toHaveLength(0);
  });
});

describe("ConnectorClient: session.json", () => {
  it("is connector-off when there is no data folder, no connector folder or no session file", async () => {
    const empty = tempDirectory("empty");
    directories.push(empty);
    for (const dataDirectory of [path.join(empty, "manca"), empty]) {
      expect((await failure(new ConnectorClient({ dataDirectory }).call("status", {}))).code).toBe("connector-off");
    }
    mkdirSync(path.join(empty, "connector"), { mode: 0o700 });
    chmodSync(path.join(empty, "connector"), 0o700);
    const error = await failure(new ConnectorClient({ dataDirectory: empty }).call("status", {}));
    expect(error.code).toBe("connector-off");
    expect(error.message).toContain("Non riprovare");
  });

  it.runIf(posix)("refuses session.json readable by others (0644) without any request", async () => {
    const app = await fakeApp();
    chmodSync(sessionPath(app), 0o644);
    const error = await failure(clientFor(app).call("status", {}));
    expect(error.code).toBe("connector-unsafe-state");
    expect(error.message).toContain("Permessi troppo aperti");
    expect(app.requests).toHaveLength(0);
  });

  it.runIf(posix)("refuses session.json when it is a symbolic link", async () => {
    const app = await fakeApp();
    // The link points at a perfectly valid 0600 session: the link itself is the problem.
    const real = path.join(app.dataDirectory, "altrove.json");
    renameSync(sessionPath(app), real);
    symlinkSync(real, sessionPath(app));
    const error = await failure(clientFor(app).call("status", {}));
    expect(error.code).toBe("connector-unsafe-state");
    expect(error.message).toContain("non è un file normale");
    expect(app.requests).toHaveLength(0);
  });

  it.runIf(posix)("refuses a connector folder open to others (0755)", async () => {
    const app = await fakeApp();
    chmodSync(path.join(app.dataDirectory, "connector"), 0o755);
    const error = await failure(clientFor(app).call("status", {}));
    expect(error.code).toBe("connector-unsafe-state");
    expect(error.message).toContain("cartella del connettore");
    expect(app.requests).toHaveLength(0);
  });

  it.runIf(posix)("refuses a connector folder that is a link", async () => {
    const app = await fakeApp();
    const real = path.join(app.dataDirectory, "vera");
    renameSync(path.join(app.dataDirectory, "connector"), real);
    symlinkSync(real, path.join(app.dataDirectory, "connector"), "dir");
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-unsafe-state");
    expect(app.requests).toHaveLength(0);
  });

  it("refuses a session file of the wrong shape or size", async () => {
    const app = await fakeApp();
    const client = clientFor(app);
    for (const overrides of [{ extra: 1 }, { v: 2 }, { key: "corta" }, { instance: "ABC" }, { port: 0 }, { pid: 0 }, { startedAt: "ieri" }]) {
      app.writeSession(overrides);
      expect((await failure(client.call("status", {}))).code).toBe("connector-unsafe-state");
    }
    writeFileSync(sessionPath(app), " ".repeat(5000), { mode: 0o600 });
    expect((await failure(client.call("status", {}))).message).toContain("troppo grande");
    expect(app.requests).toHaveLength(0);
    app.writeSession();
    expect(readSessionFile(app.dataDirectory).state).toBe("ok");
  });

  it("is connector-off without any request when the pid in session.json is dead", async () => {
    const app = await fakeApp();
    app.writeSession({ pid: await deadPid() });
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-off");
    expect(app.requests).toHaveLength(0);
  });

  it("is connector-off when nothing listens on the port (ECONNREFUSED)", async () => {
    const app = await fakeApp();
    const spare = http.createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", () => resolve()));
    const port = (spare.address() as AddressInfo).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    app.writeSession({ port });
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-off");
  });
});

describe("ConnectorClient: proving the server", () => {
  it("against an impostor sends only the body-less hello and throws connector-impostor", async () => {
    const wrongKey = randomBytes(32);
    const app = await fakeApp((request, current) => ({ status: 200, body: helloBody(current), signWith: wrongKey }));
    const client = clientFor(app);
    const error = await failure(client.call("listProjects", { limit: 5 }));
    expect(error.code).toBe("connector-impostor");
    expect(error.message).toContain(`127.0.0.1:${app.port}`);
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0]?.method).toBe("GET");
    expect(app.requests[0]?.url).toBe("/v1/hello");
    expect(app.requests[0]?.body.byteLength).toBe(0);
    expect(app.requests[0]?.headers["content-length"]).toBe("0");
    // A prototype is never sent either.
    const source = { bytes: Buffer.from(VALID_PROTOTYPE), name: "sito.html", sha256: "x" };
    expect((await failure(client.prototype("check", source, {}))).code).toBe("connector-impostor");
    expect(urls(app)).toEqual(["/v1/hello", "/v1/hello"]);
  });

  it.each<[string, Responder]>([
    ["an unsigned hello", (_request, app) => ({ status: 200, body: helloBody(app), signWith: null })],
    ["a hello for another instance", (_request, app) => ({ status: 200, body: { ...helloBody(app), instance: "0".repeat(32) } })],
    ["a hello from another app", (_request, app) => ({ status: 200, body: { ...helloBody(app), app: "histos-builder" } })],
    ["a hello of another protocol version", (_request, app) => ({ status: 200, body: { ...helloBody(app), protocol: 2 } })],
    ["a signed hello that is not JSON", () => ({ status: 200, raw: Buffer.from("ciao") })],
    ["a signed hello with a stale timestamp", (_request, app) => ({ status: 200, body: helloBody(app), timestamp: String(Math.floor(Date.now() / 1000) - 600) })],
    ["a signed 401 hello", () => ({ status: 401, body: { error: "no" } })],
  ])("refuses %s", async (_name, respond) => {
    const app = await fakeApp(respond);
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-impostor");
    expect(urls(app)).toEqual(["/v1/hello"]);
  });

  it("says hello again when session.json names a new instance", async () => {
    const app = await fakeApp();
    const client = clientFor(app);
    await client.call("status", {});
    await client.call("status", {});
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/call"]);
    const before = app.instance;
    app.rotate();
    await client.call("status", {});
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/call", "/v1/hello", "/v1/call"]);
    expect(app.requests[3]?.headers[HEADERS.instance]).toBe(app.instance);
    expect(app.requests[3]?.headers[HEADERS.instance]).not.toBe(before);
    expect(app.requests.every((request) => request.validSignature)).toBe(true);
  });

  it("reads session.json once more when the key rotated between reading it and the hello", async () => {
    let hellos = 0;
    const app = await fakeApp((request, current) => {
      if (request.url !== "/v1/hello") return defaultResponder(request, current);
      hellos += 1;
      if (hellos > 1) return defaultResponder(request, current);
      // The app restarted under the client: the old instance is unknown, the gate answers an unsigned 401.
      current.rotate();
      return { status: 401, body: { error: "Non autorizzato.", code: "connector-unauthorized" }, signWith: null };
    });
    expect(await clientFor(app).call("status", {})).toMatchObject({ ok: true });
    expect(urls(app)).toEqual(["/v1/hello", "/v1/hello", "/v1/call"]);
    expect(app.requests[1]?.validSignature).toBe(true);
    expect(app.requests[2]?.validSignature).toBe(true);
  });

  it("after a 401 caused by a rotation says hello again and retries exactly once", async () => {
    let calls = 0;
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      calls += 1;
      if (calls === 1) {
        current.rotate();
        return { status: 401, body: { error: "Non autorizzato.", code: "connector-unauthorized" }, signWith: null };
      }
      return defaultResponder(request, current);
    });
    expect(await clientFor(app).call("status", {})).toMatchObject({ ok: true });
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/hello", "/v1/call"]);
    expect(app.requests[2]?.headers[HEADERS.instance]).toBe(app.instance);
    expect(app.requests[3]?.validSignature).toBe(true);
  });

  it("does not retry a second time when every call is refused after a rotation", async () => {
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      current.rotate();
      return { status: 401, body: { error: "Non autorizzato.", code: "connector-unauthorized" }, signWith: null };
    });
    const error = await failure(clientFor(app).call("status", {}));
    expect(error.code).toBe("connector-unauthorized");
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/hello", "/v1/call"]);
  });

  it("does not retry a 401 when the instance did not change", async () => {
    const app = await fakeApp((request, current) => (request.url === "/v1/hello" ? defaultResponder(request, current) : { status: 401, body: { code: "connector-unauthorized" }, signWith: null }));
    const error = await failure(clientFor(app).call("status", {}));
    expect(error.code).toBe("connector-unauthorized");
    expect(error.exitCode).toBe(1);
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call"]);
  });

  it("treats an unsigned 500 after the hello as an impostor and proves the server again", async () => {
    const app = await fakeApp((request, current) => (request.url === "/v1/hello" ? defaultResponder(request, current) : { status: 500, body: { error: "boom" }, signWith: null }));
    const client = clientFor(app);
    expect((await failure(client.call("status", {}))).code).toBe("connector-impostor");
    expect((await failure(client.call("status", {}))).code).toBe("connector-impostor");
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/hello", "/v1/call"]);
  });

  it("treats an unsigned gate rejection (413) as rejected, not as an impostor", async () => {
    const app = await fakeApp((request, current) => (request.url === "/v1/hello" ? defaultResponder(request, current) : { status: 413, body: { code: "connector-body-too-large" }, signWith: null }));
    const error = await failure(clientFor(app).call("status", {}));
    expect(error.code).toBe("connector-rejected");
    expect(error.message).toContain("413");
  });

  it.each([400, 403, 404, 405, 411, 413, 415])("after an unsigned %i proves the server again before sending the next body", async (status) => {
    let phase: "refusing" | "impostor" | "app" = "refusing";
    const wrongKey = randomBytes(32);
    const app = await fakeApp((request, current) => {
      if (phase === "impostor") return { status: 200, body: helloBody(current), signWith: wrongKey };
      if (request.url === "/v1/hello" || phase === "app") return defaultResponder(request, current);
      return { status, body: { code: "connector-request-invalid" }, signWith: null };
    });
    const client = clientFor(app);
    const refused = await failure(client.call("status", {}));
    expect(refused.code).toBe("connector-rejected");
    expect(refused.message).toContain(String(status));
    // Whatever now holds the port answers the next hello without the key: the arguments never leave.
    phase = "impostor";
    expect((await failure(client.call("listProjects", { limit: 5 }))).code).toBe("connector-impostor");
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/hello"]);
    phase = "app";
    expect(await client.call("status", {})).toMatchObject({ ok: true });
    expect(urls(app)).toEqual(["/v1/hello", "/v1/call", "/v1/hello", "/v1/hello", "/v1/call"]);
  });

  it("refuses a call response signed for another nonce", async () => {
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      // A replayed answer: a valid signature, but over another request's nonce (the hello's).
      return (response) => {
        const body = Buffer.from(JSON.stringify({ ok: true }));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const other = current.requests[0]?.headers[HEADERS.nonce] as string;
        response.writeHead(200, { "Content-Length": String(body.byteLength), [HEADERS.timestamp]: timestamp, [HEADERS.signature]: signResponse(current.key, 200, other, current.instance, timestamp, body) });
        response.end(body);
      };
    });
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-impostor");
  });
});

describe("ConnectorClient: the app's queue (doc 17, voce 2)", () => {
  const busyAnswer = (retryAfter: string) => ({ status: 429, body: { error: "Histeon Publish fa un'operazione pesante alla volta, e questa non ha avuto il suo turno (posizione in coda: 5; altre in attesa: 4).", code: "connector-busy", queue: { position: 5, waiting: 4 } }, headers: { "Retry-After": retryAfter } });

  it("tries again by itself after a signed 429 connector-busy, waiting the Retry-After, the same body each time", async () => {
    let busy = 2;
    const app = await fakeApp((request, current) => {
      if (request.url !== "/v1/hello" && busy > 0) {
        busy--;
        return busyAnswer("0");
      }
      return defaultResponder(request, current);
    });
    const client = clientFor(app);
    expect(await client.prototype("check", { bytes: Buffer.from(VALID_PROTOTYPE), name: "a.html", sha256: "x" }, {})).toBeDefined();
    const posts = app.requests.filter((request) => request.url.startsWith("/v1/prototype"));
    expect(posts).toHaveLength(3);
    for (const post of posts) expect(post.body.toString("utf8")).toBe(VALID_PROTOTYPE);
  });

  it("past its tries says so, with the place in the queue; a rate limit or a 503 is never tried again", async () => {
    const answers: Array<() => { status: number; body: unknown; headers?: Record<string, string> }> = [() => busyAnswer("0")];
    const app = await fakeApp((request, current) => (request.url === "/v1/hello" ? defaultResponder(request, current) : answers[0]!()));
    const client = new ConnectorClient({ dataDirectory: app.dataDirectory, client: "test", busyRetries: 2 });
    const error = await failure(client.call("build", { projectId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }));
    expect(error).toMatchObject({ code: "connector-busy", exitCode: 1, details: { queue: { position: 5, waiting: 4 } } });
    expect(error.message).toBe("Histeon Publish fa un'operazione pesante alla volta, e questa non ha avuto il suo turno (posizione in coda: 5; altre in attesa: 4). Ho già riprovato 2 volte. Riprova fra 0 secondi.");
    expect(urls(app).filter((url) => url === "/v1/call")).toHaveLength(3);
    answers[0] = () => ({ status: 429, body: { error: "Limite orario raggiunto per questa operazione: riprova più tardi.", code: "connector-rate-limited" }, headers: { "Retry-After": "0" } });
    expect((await failure(client.call("build", { projectId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }))).code).toBe("connector-rate-limited");
    answers[0] = () => ({ status: 503, body: { error: "Troppe richieste in poco tempo: riprova fra qualche minuto.", code: "connector-busy" }, headers: { "Retry-After": "0" } });
    expect((await failure(client.call("build", { projectId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }))).code).toBe("connector-busy");
    expect(urls(app).filter((url) => url === "/v1/call")).toHaveLength(5);
  });

  it("an abort while it waits stops at once, with no other request", async () => {
    const app = await fakeApp((request, current) => (request.url === "/v1/hello" ? defaultResponder(request, current) : busyAnswer("30")));
    const client = clientFor(app);
    const controller = new AbortController();
    const pending = failure(client.call("build", { projectId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }, controller.signal));
    await waitFor(() => urls(app).includes("/v1/call"));
    const started = Date.now();
    controller.abort();
    expect((await pending).code).toBe("connector-cancelled");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(urls(app).filter((url) => url === "/v1/call")).toHaveLength(1);
  });
});

describe("ConnectorClient: a busy app answering the hello", () => {
  it.each<[number, string, string, string]>([
    [429, "connector-rate-limited", "Troppe richieste: al massimo 120 al minuto.", "12"],
    [503, "connector-busy", "Troppe richieste in poco tempo: riprova fra qualche minuto.", "300"],
  ])("reports a signed %i as the app's own code with the wait, never as an impostor", async (status, code, message, retryAfter) => {
    let busy = true;
    const app = await fakeApp((request, current) => {
      if (busy && request.url === "/v1/hello") return { status, body: { error: message, code }, headers: { "Retry-After": retryAfter } };
      return defaultResponder(request, current);
    });
    const client = clientFor(app);
    const error = await failure(client.call("listProjects", { limit: 5 }));
    expect(error.code).toBe(code);
    expect(error.message).toBe(`${message} Riprova fra ${retryAfter} secondi.`);
    expect(urls(app)).toEqual(["/v1/hello"]);
    // A busy answer proves nothing: the next call says hello again before its body.
    busy = false;
    expect(await client.call("listProjects", { limit: 5 })).toMatchObject({ ok: true });
    expect(urls(app)).toEqual(["/v1/hello", "/v1/hello", "/v1/call"]);
  });

  it("falls back to the status for a signed 429 or 503 without a usable code or Retry-After", async () => {
    const answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [
      { status: 429, body: { error: "Troppe richieste." } },
      { status: 503, body: { code: "Not A Code!" }, headers: { "Retry-After": "domani" } },
    ];
    let index = 0;
    const app = await fakeApp(() => answers[index] as { status: number; body: unknown });
    const client = clientFor(app);
    const limited = await failure(client.call("status", {}));
    expect(limited.code).toBe("connector-rate-limited");
    expect(limited.message).toBe("Troppe richieste.");
    index = 1;
    const busy = await failure(client.call("status", {}));
    expect(busy.code).toBe("connector-busy");
    expect(busy.message).toBe("Histeon Publish è occupato.");
    expect(urls(app)).toEqual(["/v1/hello", "/v1/hello"]);
  });

  it.each<[string, Responder]>([
    ["an unsigned 429", () => ({ status: 429, body: { error: "Troppe richieste.", code: "connector-rate-limited" }, headers: { "Retry-After": "5" }, signWith: null })],
    ["a 503 signed with another key", () => ({ status: 503, body: { error: "Occupato.", code: "connector-busy" }, signWith: randomBytes(32) })],
  ])("still treats %s to the hello as an impostor", async (_name, respond) => {
    const app = await fakeApp(respond);
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-impostor");
    expect(urls(app)).toEqual(["/v1/hello"]);
  });
});

describe("ConnectorClient: response limits and broken connections", () => {
  it("refuses a response whose declared length is over the cap, before reading it", async () => {
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      return (response) => {
        response.writeHead(200, { "Content-Length": String(RESPONSE_MAX_BYTES + 1) });
        response.write(Buffer.alloc(1024, 0x20));
      };
    });
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-bad-response");
  });

  it("stops reading a streamed response once it passes the cap", async () => {
    let written = 0;
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      return (response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        const chunk = Buffer.alloc(256 * 1024, 0x20);
        const pump = (): void => {
          while (!response.destroyed && written < RESPONSE_MAX_BYTES * 3) {
            written += chunk.byteLength;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          response.end();
        };
        pump();
      };
    });
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-bad-response");
    expect(written).toBeLessThan(RESPONSE_MAX_BYTES * 3);
  });

  it("refuses a signed body that is not a JSON object", async () => {
    for (const raw of ["non json", "[1,2]", "null", "42"]) {
      const app = await fakeApp((request, current) => (request.url === "/v1/hello" ? defaultResponder(request, current) : { status: 200, raw: Buffer.from(raw) }));
      expect((await failure(clientFor(app).call("status", {}))).code, raw).toBe("connector-bad-response");
    }
  });

  it("treats a response cut off in the middle of its body as a lost connection", async () => {
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      return (response) => {
        response.writeHead(200, { "Content-Length": "1000" });
        response.write(Buffer.alloc(10, 0x7b), () => setTimeout(() => response.socket?.destroy(), 20));
      };
    });
    expect((await failure(clientFor(app).call("status", {}))).code).toBe("connector-connection-lost");
  });

  it("explains a connection that breaks during a call: lost, restarted or stopped", async () => {
    const dead = await deadPid();
    let mode: "lost" | "restarted" | "stopped" = "lost";
    const app = await fakeApp((request, current) => {
      if (request.url === "/v1/hello") return defaultResponder(request, current);
      return (response) => {
        if (mode === "restarted") current.rotate();
        if (mode === "stopped") current.writeSession({ pid: dead });
        response.socket?.destroy();
      };
    });
    const client = clientFor(app);
    expect((await failure(client.call("status", {}))).code).toBe("connector-connection-lost");
    mode = "restarted";
    expect((await failure(client.call("status", {}))).code).toBe("connector-restarted");
    mode = "stopped";
    expect((await failure(client.call("status", {}))).code).toBe("connector-off");
  });
});
