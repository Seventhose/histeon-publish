import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { HEADERS, PROTOCOL_VERSION, sameSignature, signRequest, signResponse } from "../src/protocol.js";

/**
 * A stand-in for Histeon Publish on 127.0.0.1: it writes <data>/connector/session.json the way the app does (folder
 * 0700, file 0600, a live pid), records every request it receives, checks the client's MAC with the key it currently
 * holds, and answers through a replaceable responder. Tests use it to count requests and to play an impostor.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Whether the request MAC verifies with the key and instance the fake app held when it arrived. */
  validSignature: boolean;
  /** Set once the client side closed the connection. */
  closed: boolean;
}

export type Reply =
  | {
      status: number;
      body?: unknown;
      /** Exact body bytes instead of JSON.stringify(body). */
      raw?: Buffer;
      /** "app" (default) signs with the session key; a Buffer signs with that key; null sends no signature. */
      signWith?: Buffer | "app" | null;
      /** Response timestamp to sign and send (default: now). */
      timestamp?: string;
      headers?: Record<string, string>;
      /** Answer only after this many milliseconds (a slow app). */
      delayMs?: number;
    }
  | "hang"
  /** Full control of the raw response (streams, broken sockets); the nonce is the request's. */
  | ((response: http.ServerResponse, nonce: string) => void);

export type Responder = (request: RecordedRequest, app: FakeApp) => Reply;

export interface FakeApp {
  dataDirectory: string;
  port: number;
  key: Buffer;
  instance: string;
  requests: RecordedRequest[];
  respond: Responder;
  /** Writes session.json for the current key and instance; `overrides` replace fields as they are written. */
  writeSession(overrides?: Record<string, unknown>): void;
  /** A new key and instance, as after "Ferma" and "Attiva" or an app restart; session.json is rewritten. */
  rotate(): void;
  close(): Promise<void>;
}

export function tempDirectory(prefix: string): string {
  // Never under a dot directory: the connector refuses prototype paths with a component starting with ".".
  return mkdtempSync(path.join(os.tmpdir(), `hp-connector-${prefix}-`));
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export const VALID_PROTOTYPE = `<!doctype html>
<html lang="it" data-histos-prototype="1">
<head><meta charset="utf-8"><title>Caffè Aurora</title></head>
<body><main><h1>Benvenuti</h1></main></body>
</html>
`;

export function helloBody(app: Pick<FakeApp, "instance">): Record<string, unknown> {
  return { app: "histos-publish", protocol: PROTOCOL_VERSION, instance: app.instance, appVersion: "0.1.0-test" };
}

/** The real app's default answers: a signed hello, then a signed echo of the operation or prototype query. */
export const defaultResponder: Responder = (request, app) => {
  if (request.url === "/v1/hello") return { status: 200, body: helloBody(app) };
  if (request.url === "/v1/call") {
    const call = JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
    return { status: 200, body: { ok: true, operation: call.operation, arguments: call.arguments } };
  }
  return { status: 200, body: { valid: true, query: request.url.slice(request.url.indexOf("?") + 1) } };
};

function header(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

export async function startFakeApp(options: { dataDirectory?: string; respond?: Responder } = {}): Promise<FakeApp> {
  const dataDirectory = options.dataDirectory ?? tempDirectory("data");
  const sockets = new Set<Socket>();
  const app: FakeApp = {
    dataDirectory,
    port: 0,
    key: randomBytes(32),
    instance: randomBytes(16).toString("hex"),
    requests: [],
    respond: options.respond ?? defaultResponder,
    writeSession(overrides = {}) {
      const directory = path.join(dataDirectory, "connector");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const file = path.join(directory, "session.json");
      const session = {
        v: 1,
        app: "histos-publish",
        port: app.port,
        instance: app.instance,
        key: app.key.toString("base64url"),
        pid: process.pid,
        appVersion: "0.1.0-test",
        startedAt: new Date().toISOString(),
        ...overrides,
      };
      writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
      chmodSync(file, 0o600);
    },
    rotate() {
      app.key = randomBytes(32);
      app.instance = randomBytes(16).toString("hex");
      app.writeSession();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = request.method ?? "";
      const url = request.url ?? "";
      const nonce = header(request.headers, HEADERS.nonce);
      const expected = signRequest(app.key, method, url, header(request.headers, HEADERS.timestamp), nonce, header(request.headers, HEADERS.instance), header(request.headers, HEADERS.client), body);
      const recorded: RecordedRequest = {
        method,
        url,
        headers: request.headers,
        body,
        validSignature: header(request.headers, HEADERS.instance) === app.instance && sameSignature(expected, header(request.headers, HEADERS.signature)),
        closed: false,
      };
      app.requests.push(recorded);
      response.on("close", () => {
        recorded.closed = true;
      });
      response.on("error", () => undefined);
      const reply = app.respond(recorded, app);
      if (reply === "hang") return;
      if (typeof reply === "function") {
        reply(response, nonce);
        return;
      }
      const bytes = reply.raw ?? Buffer.from(reply.body === undefined ? "" : JSON.stringify(reply.body), "utf8");
      const timestamp = reply.timestamp ?? String(Math.floor(Date.now() / 1000));
      const signWith = reply.signWith === undefined || reply.signWith === "app" ? app.key : reply.signWith;
      const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(bytes.byteLength), Connection: "close", ...reply.headers };
      if (signWith) {
        headers[HEADERS.timestamp] = timestamp;
        headers[HEADERS.signature] = signResponse(signWith, reply.status, nonce, app.instance, timestamp, bytes);
      }
      const send = (): void => {
        if (response.destroyed) return;
        response.writeHead(reply.status, headers);
        response.end(bytes);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  app.port = (server.address() as AddressInfo).port;
  app.writeSession();
  return app;
}

/** The pid of a process that has already exited: what session.json holds after the app crashed. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  if (pid === undefined) throw new Error("no pid");
  // The exit event can come before the kernel reaps the child; wait until signal 0 fails.
  for (let index = 0; index < 100; index++) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the child process did not go away");
}

/** Polls until `condition` holds (at most `timeoutMs`). */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
