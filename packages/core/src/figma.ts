/**
 * The REST API of Figma, read only (note penpot-figma-a-histeon.md, phase 2): the file, some of its nodes, its local
 * variables. The personal access token of the user travels in one header, to `api.figma.com` only; plain HTTP is
 * accepted on the loopback alone, for the local stand-in of the tests. A redirect is an error, never followed.
 *
 * The token never enters a message: what the server answers is shown only as its status and its short `err` text,
 * with the token cut out if the answer echoes it.
 */

import { isIP } from "node:net";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { SystemKeyringSecretStore } from "./secrets.js";

export const FIGMA_TOKEN_ENV = "HISTOS_FIGMA_API_TOKEN";
export const FIGMA_API_BASE_ENV = "HISTOS_FIGMA_API_BASE";
/** The account of the token in the keyring of the system (service `histos-publish`). */
export const FIGMA_TOKEN_ACCOUNT = "figma-api-token";
const DEFAULT_API_BASE = "https://api.figma.com";
const DEFAULT_TIMEOUT_MS = 60_000;
/** The largest answer read: a whole file of Figma as JSON. A larger one is refused, and the `.fig` file is the way. */
export const FIGMA_RESPONSE_MAX = 128 * 1024 * 1024;
/** How many node ids go in one request: the address stays short. */
const NODE_IDS_PER_REQUEST = 100;
const TOKEN_MAX = 512;

export class FigmaApiError extends HistosPublishError {
  constructor(message: string, readonly status: number) {
    super(message, "figma-api", 4);
    this.name = "FigmaApiError";
  }
}

export interface FigmaClientOptions {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** True for a token Figma can have given: printable ASCII without spaces, of a believable length. */
export function validFigmaToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= TOKEN_MAX && /^[\x21-\x7e]+$/u.test(value);
}

function validatedApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HistosPublishError("Indirizzo dell’API di Figma non valido.", "figma-config", 2);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || (isIP(host) === 4 && host.startsWith("127.")) || host === "[::1]";
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/u, "") !== "") {
    throw new HistosPublishError("L’indirizzo dell’API di Figma è solo un’origine: niente credenziali, percorso, query o frammenti.", "figma-config", 2);
  }
  if (url.protocol === "https:" && host !== "api.figma.com") {
    throw new HistosPublishError("Per proteggere il token, l’API di Figma si chiama solo su api.figma.com.", "figma-config", 2);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HistosPublishError("L’API di Figma vuole HTTPS; HTTP è ammesso solo sul loopback, per il server finto delle prove.", "figma-config", 2);
  }
  return url.origin;
}

/**
 * The key of a file from what the user pasted: the key itself, or the address of the file in the browser
 * (`https://www.figma.com/design/<key>/Name?node-id=…`). Throws for anything else: nothing of it reaches the network.
 */
export function figmaFileKey(input: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9]{15,64}$/u.test(value)) return value;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch { /* Not an address: refused below. */ }
  const host = url?.hostname.toLowerCase();
  const match = url && url.protocol === "https:" && (host === "figma.com" || host === "www.figma.com")
    ? /^\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]{15,64})(?:\/|$)/u.exec(url.pathname)
    : null;
  if (!match?.[1]) throw new HistosPublishError("Serve l’indirizzo di un file di Figma (https://www.figma.com/design/…) o la sua chiave.", "figma-file-key", 2);
  return match[1];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class FigmaClient {
  readonly apiBase: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: FigmaClientOptions) {
    if (!validFigmaToken(options.token)) throw new HistosPublishError("Token di Figma mancante o non valido.", "figma-auth-missing", 4);
    this.token = options.token;
    this.apiBase = validatedApiBase(options.apiBase ?? DEFAULT_API_BASE);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? FIGMA_RESPONSE_MAX;
  }

  /** The text without the token, and without what looks like one. */
  private redact(value: string): string {
    return value.split(this.token).join("[token rimosso]").replace(/\bfig[a-z]_[A-Za-z0-9_-]{8,}/gu, "[token rimosso]").slice(0, 300);
  }

  /** Who the token belongs to: only the name shown in Figma, to tell the user the token works. */
  async me(signal?: AbortSignal): Promise<{ handle: string }> {
    const body = asRecord(await this.request("/v1/me", signal));
    return { handle: typeof body?.handle === "string" ? body.handle.slice(0, 200) : "" };
  }

  /** The whole file: document, styles, components. */
  file(key: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/v1/files/${encodeURIComponent(figmaFileKey(key))}`, signal);
  }

  /** The nodes with these ids, by id; an id the file does not have is left out. */
  async nodes(key: string, ids: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const found: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const wanted = [...new Set(ids)].filter((id) => /^[0-9A-Za-z:;,-]{1,200}$/u.test(id) && !id.includes(","));
    for (let start = 0; start < wanted.length; start += NODE_IDS_PER_REQUEST) {
      const query = new URLSearchParams({ ids: wanted.slice(start, start + NODE_IDS_PER_REQUEST).join(",") });
      const body = asRecord(await this.request(`/v1/files/${encodeURIComponent(figmaFileKey(key))}/nodes?${query.toString()}`, signal));
      for (const [id, node] of Object.entries(asRecord(body?.nodes) ?? {})) if (node) found[id] = node;
    }
    return found;
  }

  /** The local variables of the file, or null when the plan of the user does not give them (403: Enterprise only). */
  async localVariables(key: string, signal?: AbortSignal): Promise<unknown | null> {
    try {
      return await this.request(`/v1/files/${encodeURIComponent(figmaFileKey(key))}/variables/local`, signal);
    } catch (error) {
      if (error instanceof FigmaApiError && error.status === 403) return null;
      throw error;
    }
  }

  private async request(pathname: string, outer?: AbortSignal): Promise<unknown> {
    throwIfAborted(outer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    try {
      const response = await this.fetcher(`${this.apiBase}${pathname}`, { method: "GET", headers: { "X-Figma-Token": this.token, Accept: "application/json" }, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new FigmaApiError("Figma ha risposto con un rinvio a un altro indirizzo: non seguito.", response.status);
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > this.maxBytes) {
        await response.body?.cancel();
        throw new FigmaApiError("Il file è troppo grande per essere letto dall’API: salva il file .fig da Figma e importa quello.", 413);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > this.maxBytes) {
            controller.abort(new Error("too-large"));
            throw new FigmaApiError("Il file è troppo grande per essere letto dall’API: salva il file .fig da Figma e importa quello.", 413);
          }
          chunks.push(chunk);
        }
      }
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { /* A malformed answer is reported without echoing its body. */ }
      if (response.status !== 200) {
        const record = asRecord(body);
        const said = typeof record?.err === "string" ? record.err : typeof record?.message === "string" ? record.message : "";
        const why = response.status === 403 ? "il token non può leggere questo file, o è scaduto"
          : response.status === 404 ? "il file non c’è, o il token non lo vede"
            : response.status === 429 ? "troppe richieste: riprova più tardi"
              : "";
        throw new FigmaApiError(this.redact(`Figma ha risposto ${response.status}${why ? `: ${why}` : ""}${said ? ` (${said})` : ""}.`), response.status);
      }
      if (body === null) throw new FigmaApiError("Figma ha risposto con un testo che non è JSON.", 502);
      return body;
    } catch (error) {
      if (error instanceof HistosPublishError) throw error;
      if (outer?.aborted) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
      if (controller.signal.aborted) throw new FigmaApiError("La richiesta a Figma è scaduta.", 408);
      throw new FigmaApiError(`Figma non raggiungibile: ${this.redact(error instanceof Error ? error.message : "errore di rete")}`, 0);
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface FigmaTokenStore { get(): Promise<string | null> }

/** The token of Figma: the environment first, then the keyring. Throws when there is none. */
export async function readFigmaToken(store: FigmaTokenStore = new SystemKeyringSecretStore(undefined, "histos-publish", FIGMA_TOKEN_ACCOUNT), env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; source: "environment" | "keyring" }> {
  const environmentToken = env[FIGMA_TOKEN_ENV]?.trim();
  if (environmentToken) return { token: environmentToken, source: "environment" };
  const token = await store.get();
  if (!token) throw new HistosPublishError(`Token di Figma assente. Inseriscilo nelle impostazioni di Histeon Publish, oppure imposta ${FIGMA_TOKEN_ENV}.`, "figma-auth-missing", 4);
  return { token, source: "keyring" };
}

/** A client with the token and, for the tests, the address of the local stand-in from the environment. */
export function figmaClient(token: string, env: NodeJS.ProcessEnv = process.env): FigmaClient {
  const apiBase = env[FIGMA_API_BASE_ENV];
  return new FigmaClient({ token, ...(apiBase === undefined ? {} : { apiBase }) });
}
