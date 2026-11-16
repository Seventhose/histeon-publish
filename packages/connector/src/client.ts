import { randomBytes } from "node:crypto";
import http from "node:http";
import { ConnectorError, connectorOff, plain } from "./errors.js";
import type { PrototypeSource } from "./files.js";
import { cleanClientLabel, freshTimestamp, HEADERS, PROTOCOL_VERSION, sameSignature, signRequest, signResponse, validSignatureFormat } from "./protocol.js";
import { processAlive, readSessionFile, type ConnectorSession } from "./session-file.js";
import type { CallOperation, PrototypeMode } from "./tools.js";

export const HELLO_TIMEOUT_MS = 5_000;
export const CALL_TIMEOUT_MS = 330_000;
export const PROTOTYPE_TIMEOUT_MS = 600_000;
/** The app answers with JSON of at most 4 MiB. */
export const RESPONSE_MAX_BYTES = 4 * 1024 * 1024 + 64 * 1024;
export const CALL_BODY_MAX_BYTES = 64 * 1024;
/**
 * Doc 17 item 2: how many more times an operation goes when the app, signing, answers 429 connector-busy (a heavy
 * operation runs and the queue was full or the wait ran out), and the longest Retry-After followed. Agents in
 * parallel no longer need a lock of their own; a 503 or a rate limit is never tried again.
 */
export const BUSY_RETRIES = 5;
export const BUSY_WAIT_MAX_SECONDS = 60;

export interface ClientOptions {
  dataDirectory: string;
  /** What the agent calls itself (MCP clientInfo), or "cli". Shown to the user, never trusted. */
  client?: string;
  /** In place of BUSY_RETRIES (the tests of the queue: 0). */
  busyRetries?: number;
}

interface Session {
  session: ConnectorSession;
  key: Buffer;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface ConnectorResult {
  status: number;
  body: Record<string, unknown>;
}

const IMPOSTOR = (port: number): ConnectorError => new ConnectorError(
  "connector-impostor",
  `Sulla porta 127.0.0.1:${port} risponde un programma che non è Histeon Publish: non gli ho mandato nulla. Chiudi quel programma, poi riattiva il connettore da Histeon Publish.`,
);

/** Waits `ms`, or rejects with connector-cancelled as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectorError("connector-cancelled", "Operazione annullata."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ConnectorError("connector-cancelled", "Operazione annullata."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function header(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The signed client of the connector protocol. It reads session.json before every request (an app restart only
 * means a new hello), proves the server with a body-less hello before sending any argument or HTML, and refuses
 * any response it cannot verify.
 */
export class ConnectorClient {
  private verified: string | null = null;
  private hello: { instance: string; promise: Promise<void> } | null = null;
  private label: string;

  constructor(private readonly options: ClientOptions) {
    this.label = cleanClientLabel(options.client ?? "agente");
  }

  setClientLabel(value: unknown): void {
    this.label = cleanClientLabel(value);
  }

  /** The current session, or connector-off when the app is closed or the connector is off. */
  private session(): Session {
    const read = readSessionFile(this.options.dataDirectory);
    if (read.state === "absent") throw connectorOff();
    if (!processAlive(read.session.pid)) throw connectorOff();
    return { session: read.session, key: read.key };
  }

  private async proven(current: Session): Promise<void> {
    if (this.verified === current.session.instance) return;
    if (this.hello?.instance !== current.session.instance) {
      const promise = this.sayHello(current).finally(() => {
        if (this.hello?.promise === promise) this.hello = null;
      });
      this.hello = { instance: current.session.instance, promise };
    }
    await this.hello.promise;
  }

  private async sayHello(current: Session): Promise<void> {
    const nonce = randomBytes(16).toString("hex");
    const response = await this.send(current, "GET", "/v1/hello", nonce, Buffer.alloc(0), undefined, HELLO_TIMEOUT_MS);
    const signed = this.verify(current, response, nonce);
    // A signed "busy" or "too many requests" comes from the real app (it holds the key): report it, not an impostor.
    if (signed && (response.status === 429 || response.status === 503)) {
      let answer: Record<string, unknown> = {};
      try {
        answer = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
      } catch {
        answer = {};
      }
      const retryAfter = header(response.headers, "retry-after");
      const code = typeof answer.code === "string" && /^[a-z0-9-]{1,80}$/u.test(answer.code) ? answer.code : response.status === 429 ? "connector-rate-limited" : "connector-busy";
      const message = plain(answer.error, 1000) || "Histeon Publish è occupato.";
      throw new ConnectorError(code, retryAfter && /^[0-9]{1,5}$/u.test(retryAfter) ? `${message} Riprova fra ${retryAfter} secondi.` : message);
    }
    if (response.status !== 200 || !signed) throw IMPOSTOR(current.session.port);
    let body: unknown;
    try {
      body = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw IMPOSTOR(current.session.port);
    }
    const hello = body as Record<string, unknown> | null;
    if (!hello || hello.app !== "histos-publish" || hello.protocol !== PROTOCOL_VERSION || hello.instance !== current.session.instance) throw IMPOSTOR(current.session.port);
    this.verified = current.session.instance;
  }

  private verify(current: Session, response: RawResponse, nonce: string): boolean {
    const timestamp = header(response.headers, HEADERS.timestamp);
    const signature = header(response.headers, HEADERS.signature);
    if (!timestamp || !freshTimestamp(timestamp) || !validSignatureFormat(signature)) return false;
    return sameSignature(signResponse(current.key, response.status, nonce, current.session.instance, timestamp, response.body), signature);
  }

  private send(current: Session, method: "GET" | "POST", pathWithQuery: string, nonce: string, body: Buffer, contentType: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<RawResponse> {
    const { port, instance } = current.session;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      Connection: "close",
      "Content-Length": String(body.byteLength),
      [HEADERS.instance]: instance,
      [HEADERS.timestamp]: timestamp,
      [HEADERS.nonce]: nonce,
      [HEADERS.client]: this.label,
      [HEADERS.signature]: signRequest(current.key, method, pathWithQuery, timestamp, nonce, instance, this.label, body),
    };
    if (contentType) headers["Content-Type"] = contentType;
    return new Promise((resolve, reject) => {
      // Cancelled while the hello was running (MCP notifications/cancelled): no request at all. Creating one and
      // destroying it here would emit "socket hang up" on the next tick with no listener yet, and crash the process.
      if (signal?.aborted) {
        reject(new ConnectorError("connector-cancelled", "Operazione annullata."));
        return;
      }
      let settled = false;
      const finish = (error: ConnectorError | null, value?: RawResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value as RawResponse);
      };
      const request = http.request({ host: "127.0.0.1", port, method, path: pathWithQuery, headers, agent: false, setHost: false });
      // Before anything can destroy the request: every later failure, including our own destroy(), lands here.
      request.on("error", (error: NodeJS.ErrnoException) => {
        finish(new ConnectorError("connector-transport", "Connessione con Histeon Publish interrotta.", 1, { errno: error.code ?? "unknown" }));
      });
      const timer = setTimeout(() => {
        finish(new ConnectorError("connector-timeout", "Histeon Publish non ha risposto in tempo. Controlla nell'app se l'operazione è finita prima di riprovare."));
        request.destroy();
      }, timeoutMs);
      const onAbort = (): void => {
        finish(new ConnectorError("connector-cancelled", "Operazione annullata."));
        request.destroy();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("response", (response) => {
        const declared = Number(response.headers["content-length"] ?? "0");
        if (!Number.isFinite(declared) || declared > RESPONSE_MAX_BYTES) {
          finish(new ConnectorError("connector-bad-response", "La risposta di Histeon Publish non è valida: non la uso."));
          request.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > RESPONSE_MAX_BYTES) {
            finish(new ConnectorError("connector-bad-response", "La risposta di Histeon Publish non è valida: non la uso."));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish(null, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", (error: NodeJS.ErrnoException) => finish(new ConnectorError("connector-transport", "Connessione con Histeon Publish interrotta.", 1, { errno: error.code ?? "unknown" })));
      });
      request.end(body);
    });
  }

  /** After a broken connection: was the app stopped, restarted, or did only this connection fail? */
  private explainTransport(before: Session): ConnectorError {
    let after: Session | null = null;
    try {
      after = this.session();
    } catch {
      return new ConnectorError("connector-off", "Histeon Publish si è chiuso, oppure il connettore è stato fermato, durante l'operazione. Non riprovare finché l'utente non te lo dice.");
    }
    if (after.session.instance !== before.session.instance) {
      return new ConnectorError("connector-restarted", "Histeon Publish si è riavviato durante l'operazione: controlla con hp_list_projects o hp_builds e riprova.");
    }
    return new ConnectorError("connector-connection-lost", "La connessione con Histeon Publish si è interrotta: controlla con hp_list_projects o hp_builds prima di riprovare.");
  }

  private async request(method: "GET" | "POST", pathWithQuery: string, body: Buffer, contentType: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ConnectorResult> {
    // `rotated`: one fresh read of session.json after a new key, at most; `busy`: the tries after connector-busy.
    let rotated = false;
    let busy = 0;
    for (;;) {
      const current = this.session();
      const nonce = randomBytes(16).toString("hex");
      let response: RawResponse;
      try {
        try {
          await this.proven(current);
        } catch (error) {
          // The app may have rotated its key between reading session.json and the hello: read it once more.
          if (error instanceof ConnectorError && error.code === "connector-impostor" && !rotated && this.session().session.instance !== current.session.instance) {
            rotated = true;
            continue;
          }
          throw error;
        }
        response = await this.send(current, method, pathWithQuery, nonce, body, contentType, timeoutMs, signal);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "connector-transport") {
          this.verified = null;
          if (error.details?.errno === "ECONNREFUSED") throw connectorOff();
          throw this.explainTransport(current);
        }
        throw error;
      }
      const signed = this.verify(current, response, nonce);
      if (!signed) {
        if (response.status === 401) {
          // A new key after the app restarted or the connector was turned off and on: one fresh hello, one retry.
          this.verified = null;
          const fresh = this.session();
          if (!rotated && fresh.session.instance !== current.session.instance) {
            rotated = true;
            continue;
          }
          throw new ConnectorError("connector-unauthorized", "Histeon Publish ha rifiutato la richiesta. Se l'utente ha appena riattivato il connettore riprova una volta; altrimenti avvisalo.");
        }
        if (response.status === 400 || response.status === 403 || response.status === 404 || response.status === 405 || response.status === 411 || response.status === 413 || response.status === 415) {
          // Whoever answered without signing must prove itself again before the next body.
          this.verified = null;
          throw new ConnectorError("connector-rejected", `Histeon Publish ha rifiutato la richiesta (HTTP ${response.status}).`);
        }
        this.verified = null;
        throw new ConnectorError("connector-impostor", `La risposta sulla porta 127.0.0.1:${current.session.port} non è firmata da Histeon Publish: non la uso. Avvisa l'utente.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body.toString("utf8"));
      } catch {
        throw new ConnectorError("connector-bad-response", "La risposta di Histeon Publish non è valida: non la uso.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConnectorError("connector-bad-response", "La risposta di Histeon Publish non è valida: non la uso.");
      const result = parsed as Record<string, unknown>;
      if (response.status >= 200 && response.status < 300) return { status: response.status, body: result };
      const { error, code, ...details } = result;
      const retryAfter = header(response.headers, "retry-after");
      const seconds = retryAfter && /^[0-9]{1,5}$/u.test(retryAfter) ? Number(retryAfter) : null;
      // The app's own queue (signed, so not an impostor): wait as it asks, then the same request again.
      if (response.status === 429 && code === "connector-busy" && busy < (this.options.busyRetries ?? BUSY_RETRIES)) {
        busy++;
        await pause(Math.min(seconds ?? BUSY_WAIT_MAX_SECONDS, BUSY_WAIT_MAX_SECONDS) * 1000, signal);
        continue;
      }
      const message = `${plain(error, 1000) || `Errore ${response.status}.`}${busy > 0 ? ` Ho già riprovato ${busy === 1 ? "una volta" : `${busy} volte`}.` : ""}`;
      throw new ConnectorError(
        typeof code === "string" && /^[a-z0-9-]{1,80}$/u.test(code) ? code : `http-${response.status}`,
        seconds !== null ? `${message} Riprova fra ${retryAfter} secondi.` : message,
        response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429 ? 2 : 1,
        Object.keys(details).length ? details : undefined,
      );
    }
  }

  /** One operation of the closed list on `/v1/call`. */
  async call(operation: CallOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = Buffer.from(JSON.stringify({ operation, arguments: args }), "utf8");
    if (body.byteLength > CALL_BODY_MAX_BYTES) throw new ConnectorError("connector-invalid-arguments", "Argomenti troppo lunghi.", 2);
    return (await this.request("POST", "/v1/call", body, "application/json", CALL_TIMEOUT_MS, signal)).body;
  }

  /** A prototype check or import on `/v1/prototype`; the query is covered by the signature. */
  async prototype(mode: PrototypeMode, source: PrototypeSource, flags: { update?: boolean; download?: boolean; preview?: boolean; strict?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const name = source.name.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 120) || "prototipo.html";
    const query = new URLSearchParams({ mode, update: flags.update ? "1" : "0", download: flags.download ? "1" : "0", source: name });
    // Only when asked: an app from before the preview (A2) refuses a parameter it does not know.
    if (flags.preview) query.set("preview", "1");
    // F1, the same way: an app from before the strict check refuses it rather than answering without it.
    if (flags.strict) query.set("strict", "1");
    return (await this.request("POST", `/v1/prototype?${query.toString()}`, source.bytes, "text/html; charset=utf-8", PROTOTYPE_TIMEOUT_MS, signal)).body;
  }
}
