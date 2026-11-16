/**
 * Where the design tokens of «Importa token» come from when they are not plain JSON files (note
 * penpot-figma-a-histeon.md, phases 1b.3 and 2): a whole `.penpot` or `.fig` file the app uploads, or a file of Figma
 * read from its REST API with the token of the keyring. Both give the same answer: the files of tokens as text, one
 * line on what was read, and what could not become a token. The app sends them on to `tokens/import`.
 *
 * Nothing is saved here. The token of Figma is read from the keyring (or the environment), handed to the client and
 * never answered, logged or written; `tokenSourceFromFigma` takes the address of the file, never a token.
 */

import { figmaClient, figmaFileKey, FIGMA_TOKEN_ACCOUNT, FIGMA_TOKEN_ENV, FigmaApiError, HistosPublishError, readFigmaToken, validFigmaToken } from "@histos-publish/core";
import { DESIGN_FILE_MAX, type DesignFileTokens, designFileTokens, figmaApiTokens, TOKEN_FILE_MAX, type TokenFile, type TokenProblem } from "@histos-publish/cms";

/** The largest design file the app uploads: what `designFileTokens` reads. */
export const TOKEN_SOURCE_FILE_MAX = DESIGN_FILE_MAX;
const NAME_MAX = 200;
const SOURCES_MAX = 12;
const PROBLEMS_MAX = 2000;
const TEXT_MAX = 2000;

export interface TokenSourceView {
  kind: DesignFileTokens["kind"];
  summary: string;
  problems: TokenProblem[];
  files: TokenFile[];
}

/** What a source said beside its tokens, sent back by the app with the import so that the report is whole. */
export interface TokenSourceNote {
  summary: string;
  problems: TokenProblem[];
}

interface SecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

function invalid(message: string, code = "cms-tokens-source-invalid"): HistosPublishError {
  return new HistosPublishError(message, code, 400);
}

function view(source: DesignFileTokens): TokenSourceView {
  const size = source.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
  if (size > TOKEN_FILE_MAX) throw invalid("I token letti superano 8 MB: il file ha troppi stili e variabili per un’importazione sola.");
  return { kind: source.kind, summary: source.summary, problems: source.problems.slice(0, PROBLEMS_MAX), files: source.files };
}

/** The name the app gave for the uploaded file: shown in messages only, never a path. */
export function tokenSourceName(raw: string | null): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the text must lose.
  const name = (raw ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").split(/[\\/]/u).at(-1)?.trim() ?? "";
  return name.slice(0, NAME_MAX) || "file di design";
}

/** The tokens of an uploaded `.penpot` or `.fig` file (or of a JSON of tokens). A file that is not read is a 400. */
export async function tokenSourceFromFile(name: string, bytes: Uint8Array): Promise<TokenSourceView> {
  try {
    return view(await designFileTokens(name, bytes));
  } catch (error) {
    if (error instanceof TypeError) throw invalid(error.message);
    throw error;
  }
}

/**
 * The tokens of a file of Figma, read from its API. `body.figma` is the address of the file or its key. The token
 * comes from the store; an error of Figma becomes a 502 with its short message (http.ts maps the exit code 4), a missing token a 409.
 */
export async function tokenSourceFromFigma(body: Record<string, unknown>, store: Pick<SecretStore, "get">, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<TokenSourceView> {
  if (typeof body.figma !== "string" || !body.figma.trim() || body.figma.length > 2000) throw invalid("Incolla l’indirizzo del file di Figma.");
  let key: string;
  try {
    key = figmaFileKey(body.figma);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "Indirizzo del file di Figma non valido.");
  }
  let token: string;
  try {
    token = (await readFigmaToken(store, env)).token;
  } catch (error) {
    if (error instanceof HistosPublishError && error.code === "figma-auth-missing") throw new HistosPublishError("Manca il token di Figma: inseriscilo qui sotto, in «Token di Figma».", "cms-figma-token-missing", 409);
    throw error;
  }
  try {
    return view(await figmaApiTokens(figmaClient(token, env), key, signal));
  } catch (error) {
    if (error instanceof TypeError) throw invalid(error.message);
    if (error instanceof FigmaApiError) throw new HistosPublishError(error.message, "figma-api", 4);
    throw error;
  }
}

/** Whether a token of Figma is there, and where from. Never the token. */
export async function figmaTokenState(store: Pick<SecretStore, "get">, env: NodeJS.ProcessEnv = process.env): Promise<{ configured: boolean; source: "environment" | "keyring" | null; available: boolean }> {
  if (env[FIGMA_TOKEN_ENV]?.trim()) return { configured: true, source: "environment", available: true };
  try {
    const value = await store.get();
    return { configured: Boolean(value), source: value ? "keyring" : null, available: true };
  } catch {
    return { configured: false, source: null, available: false };
  }
}

/** Checks the token with Figma (`GET /v1/me`) and keeps it in the keyring. Answers the state and the name of the account. */
export async function saveFigmaToken(body: Record<string, unknown>, store: SecretStore, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<{ token: Awaited<ReturnType<typeof figmaTokenState>>; handle: string }> {
  if (env[FIGMA_TOKEN_ENV]?.trim()) throw new HistosPublishError("Il token arriva dalla variabile d’ambiente e non può essere modificato dalla UI.", "token-environment-readonly", 2);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!validFigmaToken(token)) throw new HistosPublishError("Inserisci un token di Figma valido.", "cms-figma-token-invalid", 400);
  let handle: string;
  try {
    handle = (await figmaClient(token, env).me(signal)).handle;
  } catch (error) {
    if (error instanceof FigmaApiError) throw new HistosPublishError(error.status === 403 ? "Figma non riconosce questo token." : error.message, "cms-figma-token-refused", 400);
    throw error;
  }
  await store.set(token);
  return { token: { configured: true, source: "keyring", available: true }, handle };
}

export async function removeFigmaToken(store: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<{ token: Awaited<ReturnType<typeof figmaTokenState>> }> {
  if (!env[FIGMA_TOKEN_ENV]?.trim()) await store.delete();
  return { token: await figmaTokenState(store, env) };
}

export { FIGMA_TOKEN_ACCOUNT };

/** The notes of the sources from the body of an import: a short list of `{ summary, problems }`, or nothing. */
export function tokenSourceNotes(raw: unknown): TokenSourceNote[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > SOURCES_MAX) throw new HistosPublishError(`Le fonti dei token sono un elenco, al massimo ${SOURCES_MAX}.`, "cms-tokens-import-invalid", 400);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the text must lose.
  const short = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").slice(0, TEXT_MAX) : "");
  return raw.map((item) => {
    const source = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const problems = Array.isArray(source.problems) ? source.problems.slice(0, PROBLEMS_MAX) : [];
    return {
      summary: short(source.summary),
      problems: problems.flatMap((problem) => {
        const entry = typeof problem === "object" && problem !== null ? problem as Record<string, unknown> : {};
        const token = short(entry.token);
        const why = short(entry.why);
        return token && why ? [{ token, why }] : [];
      }),
    };
  });
}
