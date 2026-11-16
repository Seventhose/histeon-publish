/**
 * A local stand-in for the REST API of Figma, for the tests only: `GET /v1/me`, `/v1/files/:key`,
 * `/v1/files/:key/nodes?ids=` and `/v1/files/:key/variables/local`. It listens on the loopback, wants the token in
 * `X-Figma-Token`, keeps what was asked, and can misbehave on request (echo the token in an error, redirect, answer
 * too much) so that the client is tested against it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FigmaMockFile {
  /** The answer of `GET /v1/files/:key`: `name`, `document`, `styles`… */
  file: Record<string, unknown>;
  /** The nodes by id, each `{ document }`, for `…/nodes`. */
  nodes?: Record<string, unknown>;
  /** The answer of `…/variables/local`; without it the stand-in answers 403, as Figma does below Enterprise. */
  variables?: Record<string, unknown>;
}

export interface FigmaMockOptions {
  /** The only token accepted. */
  token: string;
  files?: Record<string, FigmaMockFile>;
  /** Every refusal repeats the token it received in its `err` text: a server that leaks. */
  echoToken?: boolean;
  /** `GET /v1/files/:key` answers 302 to this address. */
  redirectTo?: string;
  /** `GET /v1/files/:key` answers this many bytes of JSON, whatever the file. */
  oversize?: number;
}

export interface FigmaMockRequest {
  method: string;
  url: string;
  /** The value of `X-Figma-Token`, as received. */
  token: string;
  /** The names of the other headers that could carry a credential, when present. */
  credentialHeaders: string[];
}

export interface FigmaMockHandle {
  /** `http://127.0.0.1:<port>`: what `HISTOS_FIGMA_API_BASE` takes. */
  origin: string;
  requests: FigmaMockRequest[];
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(text)), ...headers });
  response.end(text);
}

export async function startFigmaMock(options: FigmaMockOptions): Promise<FigmaMockHandle> {
  const requests: FigmaMockRequest[] = [];
  const files = options.files ?? {};
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://figma.mock");
    const header = request.headers["x-figma-token"];
    const token = Array.isArray(header) ? header.join(",") : header ?? "";
    requests.push({ method: request.method ?? "", url: request.url ?? "", token, credentialHeaders: ["authorization", "cookie"].filter((name) => request.headers[name] !== undefined) });
    const refuse = (status: number, err: string) => send(response, status, { status, err: options.echoToken ? `${err} (token ${token})` : err });
    if (request.method !== "GET") {
      refuse(405, "Method not allowed");
      return;
    }
    if (token !== options.token) {
      refuse(403, "Invalid token");
      return;
    }
    if (options.echoToken) {
      refuse(400, "Bad request");
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/v1/me") {
      send(response, 200, { id: "1", handle: "Prova", email: "prova@example.test" });
      return;
    }
    const entry = parts[0] === "v1" && parts[1] === "files" && parts[2] ? files[parts[2]] : undefined;
    if (!entry) {
      refuse(404, "Not found");
      return;
    }
    if (parts.length === 3) {
      if (options.redirectTo) {
        response.writeHead(302, { Location: options.redirectTo });
        response.end();
        return;
      }
      if (options.oversize) {
        send(response, 200, JSON.stringify({ name: "x".repeat(options.oversize) }));
        return;
      }
      send(response, 200, entry.file);
      return;
    }
    if (parts.length === 4 && parts[3] === "nodes") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const nodes: Record<string, unknown> = {};
      for (const id of ids) nodes[id] = entry.nodes?.[id] ?? null;
      send(response, 200, { name: entry.file.name, nodes });
      return;
    }
    if (parts.length === 5 && parts[3] === "variables" && parts[4] === "local") {
      if (!entry.variables) {
        refuse(403, "Limited by Figma plan");
        return;
      }
      send(response, 200, { status: 200, error: false, meta: entry.variables });
      return;
    }
    refuse(404, "Not found");
  };
  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
