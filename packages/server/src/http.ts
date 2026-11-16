import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { HistosPublishError } from "@histos-publish/core";
import { defaultDataDirectory } from "@histos-publish/connector/data-directory";
import { PrototypeInvalidError } from "./prototype-check.js";

export function isHostAllowed(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host?.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function hasValidOrigin(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host?.toLowerCase();
  if (!origin || !host) return false;
  return origin === `http://${host}`
    && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}

export function hasValidToken(request: IncomingMessage, token: string): boolean {
  const header = request.headers["x-histos-token"];
  if (typeof header !== "string") return false;
  const expected = Buffer.from(token, "utf8");
  const actual = Buffer.from(header, "utf8");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export async function readJson(request: IncomingMessage, maximum = 4 * 1024 * 1024): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximum) throw new HistosPublishError("La richiesta supera la dimensione massima consentita.", "request-too-large", 413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) throw new HistosPublishError("La richiesta supera la dimensione massima consentita.", "request-too-large", 413);
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HistosPublishError("Il corpo della richiesta non è JSON valido.", "request-invalid", 400); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HistosPublishError("Il corpo della richiesta deve essere un oggetto JSON.", "request-invalid", 400);
  return parsed as Record<string, unknown>;
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

/** `issuesTotal` goes out only with a list that is shorter than it (E4: the first 100 of 150 problems). */
export function sendError(response: ServerResponse, status: number, message: string, code = "error", issues?: SafeIssue[], issuesTotal?: number): void {
  sendJson(response, status, { error: message, code, ...(issues?.length ? { issues, ...(issuesTotal !== undefined && issuesTotal > issues.length ? { issuesTotal } : {}) } : {}) });
}

/** A problem of a refused prototype (E4) as a client receives it. */
export interface SafeIssue {
  document?: string;
  line?: number;
  column?: number;
  message: string;
}

/** The most problems a client receives; past them it gets the count (safeErrorIssuesTotal). */
const SAFE_ISSUES_KEPT = 100;

/**
 * The problems an error lists (a refused prototype, E4), cleaned as its message is: at most 100, each short, with
 * `scrub` applied first (the connector hides its data folder). Slugs and template refs stay (see safeErrorMessage).
 */
export function safeErrorIssues(error: unknown, scrub: (text: string) => string = (text) => text): SafeIssue[] | undefined {
  const issues = error instanceof HistosPublishError ? (error as { issues?: unknown }).issues : undefined;
  if (!Array.isArray(issues) || !issues.length) return undefined;
  const keepSlugs = error instanceof PrototypeInvalidError;
  const clean = (text: string, max: number) => safeErrorMessage(new Error(scrub(text)), { keepSlugs }).slice(0, max);
  const position = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);
  return issues.slice(0, SAFE_ISSUES_KEPT).flatMap((issue: unknown): SafeIssue[] => {
    if (!issue || typeof issue !== "object" || typeof (issue as { message?: unknown }).message !== "string") return [];
    const { document, line, column, message } = issue as { document?: unknown; line?: unknown; column?: unknown; message: string };
    const at = position(line);
    const col = position(column);
    return [{ ...(typeof document === "string" ? { document: clean(document, 200) } : {}), ...(at ? { line: at } : {}), ...(at && col ? { column: col } : {}), message: clean(message, 600) }];
  });
}

/**
 * How many problems a refused prototype has in all, when that is more than the `listed` ones a client receives (the
 * importer keeps the first 100 and counts the rest, E4); undefined otherwise, so the list stands for the whole.
 */
export function safeErrorIssuesTotal(error: unknown, listed: number): number | undefined {
  if (!(error instanceof PrototypeInvalidError) || listed < 1) return undefined;
  const total = Math.max(error.total, error.issues.length);
  return Number.isSafeInteger(total) && total > listed ? total : undefined;
}

/**
 * Errors of the CMS package carry their own `code` (`cms-…`) and HTTP `status`, without depending on core's
 * HistosPublishError (see static-renderer and project-repository).
 */
function taggedCmsError(error: unknown): { code: string; status: number } | null {
  if (!(error instanceof Error) || error instanceof HistosPublishError) return null;
  const { code, status } = error as Error & { code?: unknown; status?: unknown };
  return typeof code === "string" && /^cms-[a-z0-9-]{1,80}$/u.test(code) && typeof status === "number" && [400, 404, 409, 413, 422].includes(status) ? { code, status } : null;
}

/** The stable error code sent to the client. */
export function requestErrorCode(error: unknown): string {
  if (error instanceof HistosPublishError) return error.code;
  return taggedCmsError(error)?.code ?? "error";
}

export function requestErrorStatus(error: unknown): number {
  const tagged = taggedCmsError(error);
  if (tagged) return tagged.status;
  if (error instanceof HistosPublishError) {
    if (error.code === "cloudflare-api" && "status" in error && error.status === 404) return 404;
    if (error.code === "cms-build-timeout") return 504;
    if (error.code === "cms-remote-timeout") return 504;
    if (error.code === "cms-remote-unreachable" || error.code === "cms-remote-certificate") return 502;
    if (error.code === "cms-build-cancelled" || error.code === "cms-import-cancelled") return 499;
    if (error.code.startsWith("cms-") && [400, 404, 405, 409, 413, 415, 422].includes(error.exitCode)) return error.exitCode;
    if (["site-missing", "build-missing", "job-missing", "api-route-missing", "static-not-found", "preview-missing", "preview-file-missing", "preview-path-invalid", "import-missing", "cms-project-missing", "cms-page-missing", "cms-media-missing", "cms-revision-missing", "database-connection-missing", "database-secret-missing"].includes(error.code)) return 404;
    if (error.code === "database-auth-failed") return 401;
    if (error.code === "database-unreachable") return 503;
    if (error.code === "database-probe-failed") return 502;
    if (error.code === "hosting-config-missing") return 409;
    if (error.code === "site-delete-confirm") return 400;
    if (error.code === "trash-confirm") return 400;
    if (error.code === "trash-missing") return 404;
    if (error.code === "trash-conflict") return 409;
    if (error.code === "folder-invalid") return 400;
    if (error.code === "folder-missing") return 404;
    if (error.code === "site-in-use") return 409;
    if (error.code === "api-path-invalid") return 400;
    if (error.code === "host-rejected" || error.code === "origin-rejected") return 403;
    if (error.code === "preview-readonly") return 405;
    if (error.code === "request-too-large" || error.code === "static-too-large") return 413;
    if (error.exitCode === 3) return 422;
    if (error.exitCode === 4) return 502;
    if (error.exitCode === 5) return 502;
    if (error.exitCode === 6) return 409;
    if (error.code === "confirmation-required") return 428;
    return error.exitCode === 2 ? 400 : 500;
  }
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    if ("code" in error && typeof error.code === "string" && error.code.startsWith("cms-")) return error.status;
    return error.status === 404 ? 404 : error.status === 401 ? 401 : 502;
  }
  return 500;
}

/** A run long enough to be a token: hidden from error messages, unless it is a slug a prototype refusal names. */
const SECRET_RUN = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{28,}\b/gu;
/** The tokens of known services, by their prefix: hidden in every message, slug-shaped or not (xoxb-…). */
const SERVICE_TOKEN = /(?:sk_live_|sk_test_|ghp_|xox[baprs]-)[A-Za-z0-9_-]+/gu;
const UUID_INSIDE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
/** A run that is one UUID and nothing else: the identity of a document, a template, a record (doc 23, voce 198). */
const UUID_ALONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** What says that the run after it is a credential: «token: …», «password=…», «X-Api-Key …», «Authorization: …». */
const CREDENTIAL_BEFORE = /(?:token|secret|segreto|password|passwd|parola\s+d.ordine|key|chiave|authorization|auth|credential\w*|credenzial\w*|bearer|basic)["'\s:=]{0,4}$/iu;
/** What says that the run after it names a Cloudflare Worker: «Worker “…”», «Worker …» (doc 23, voce 229). */
const WORKER_BEFORE = /\bworker\s*["'“«`]?$/iu;
/** A Cloudflare Worker name: lowercase letters, digits and hyphens, at most 63 characters. */
const WORKER_NAME = /^[a-z0-9-]{1,63}$/u;

/**
 * A UUID alone is an identity, not a secret (voce 198: «…not portable in [segreto rimosso]: url» lost the document
 * the site named). No secret of Publish or of its sites has that shape (keys and tickets are base64url or hex, the link
 * secret is 32 bytes of base64url), but a third-party key may: one right after a word that names a credential, or
 * after «Bearer», stays hidden. A Worker name right after «Worker» is an identity too (voce 229: «Worker
 * [segreto rimosso] has no deployments»), when it reads as a slug: a random run after that word stays hidden.
 */
function identityRun(run: string, offset: number, text: string): boolean {
  const before = text.slice(Math.max(0, offset - 32), offset);
  if (WORKER_BEFORE.test(before)) return WORKER_NAME.test(run) && slugLike(run);
  return UUID_ALONE.test(run) && !CREDENTIAL_BEFORE.test(before);
}

/**
 * A long run that reads as a page slug or a template ref of a prototype ("storia-della-nostra-associazione"): two or
 * more lowercase words joined by hyphens, each of at most 20 characters, a word with a digit at most 6 (a year, "h2o"),
 * and no UUID anywhere (an internal id). Tokens fail it: base64url has capitals and "_", hex and base32 keys have long
 * random words with digits (key-…, …-us6), a UUID is refused outright.
 */
function slugLike(run: string): boolean {
  // A name the importer accepts as a slug or a ref (lowercase, digits, hyphens), even one long word; never a UUID, nor
  // a word that reads as random: a long run of hex digits, or a long word with several digits (a base-36 token).
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(run) || UUID_INSIDE.test(run)) return false;
  return !run.split("-").some((word) => (word.length >= 16 && /^[0-9a-f]+$/u.test(word)) || (word.length >= 12 && (word.match(/[0-9]/gu)?.length ?? 0) >= 3));
}

/**
 * The message of an error as a client may read it, with what looks like a token hidden. A prototype refusal (E4)
 * keeps its slugs and template refs (`keepSlugs`, the default for PrototypeInvalidError): they come from the file the
 * client itself sent, and hidden they read as a security problem and lose the place to fix. Any other error hides
 * every long run, since a lowercase passphrase is slug-shaped too, but not a UUID alone (identityRun): a site names
 * the document it refuses by its identity.
 */
export function safeErrorMessage(error: unknown, options: { keepSlugs?: boolean } = {}): string {
  const message = error instanceof Error ? error.message : "Operazione non riuscita.";
  const keepSlugs = options.keepSlugs ?? error instanceof PrototypeInvalidError;
  return message
    .replace(SECRET_RUN, (run: string, offset: number, text: string) => (identityRun(run, offset, text) || (keepSlugs && slugLike(run)) ? run : "[segreto rimosso]"))
    .replace(SERVICE_TOKEN, "[segreto rimosso]");
}

const PATH_HIDDEN = "[percorso rimosso]";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** How much of a message hideFilePaths keeps: the client gets less anyway. */
const MESSAGE_KEPT = 4096;
/** How many times a message is decoded at most (readings): a JSON line in the JSON of a log, escaped once more. */
const DECODINGS = 3;
/**
 * How many more times a message is decoded when DECODINGS were not enough, only to find the private folders in it
 * (readings' `beyond`): each decoding halves a run of backslashes, so that past them a message of MESSAGE_KEPT has
 * runs of one at most.
 */
const BEYOND_DECODINGS = 16;
/** How many more times hideFilePaths reads a message with the private folders a path took a part of as found. */
const RETRIES = 2;
/**
 * Where a private folder was (the user's home, the data folder: privateFolders) while the patterns below run: one
 * character of the Private Use Area, which no message of the app writes, and which every pattern reads as the start of
 * an absolute path. So nothing in the folder's name (a space, a quote, an apostrophe) can end the path that goes on
 * from it, quoted or not. It never goes out: FOLDER_REST hides each one the other patterns left.
 */
const FOLDER_MARK = "\uE000";
/**
 * What opens a quoted absolute path (quotedPaths), as Node's file errors write it ("lstat '/home/anna/…'"), a file URL
 * or a private folder too: a quote, then where a path starts, or a path already hidden (one an error names, as in
 * "'[percorso rimosso]/x y'"). Not a quote right after a letter or a digit: that is an elision ("l'/home/anna/x, c'è
 * 'ENOENT'"), and a path from there would run on to a later quote and take the words in between with it.
 */
const QUOTE_OPENING = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(['"\`])(?:file:)?(?:\\uE000|\\/|[A-Za-z]:[\\\\/]|\\\\\\\\|${escapeRegExp(PATH_HIDDEN)})`, "uy");
/** What makes a quote no end of a quoted path: a letter, a digit or "_" right after it ("/home/o'brien/x"). */
const NAME_START = /^[\p{L}\p{N}_]/u;
/**
 * An absolute POSIX path of two or more parts that starts a word: "/home/anna/x", "/tmp/a/", or one with a private
 * folder further on ("/var" and FOLDER_MARK, from "/var/home/anna"; "/" and FOLDER_MARK, from "/C:/Users/anna"). Not
 * the path of a URL ("https://host/a/b": its slashes follow ":", "/" or a letter), nor "e/o" or "1/2", nor the rest of
 * a private folder (FOLDER_REST takes it). Wherever it may start, so may a private folder (startsPath): it never takes
 * half of one. BARE_POSIX_PATH_AT is the same path where a looser rule lets one start (hiddenParts).
 */
const BARE_POSIX_PATH = /(?<![\w.:/~@%+\-\\\uE000])\/(?:[^\s'"`/\\<>|\uE000]+|(?=\uE000))(?:[/\uE000][^\s'"`/\\<>|\uE000]*)+/gu;
const BARE_POSIX_PATH_AT = /\/(?:[^\s'"`/\\<>|\uE000]+|(?=\uE000))(?:[/\uE000][^\s'"`/\\<>|\uE000]*)+/uy;
/** An absolute Windows path: a drive ("C:\…", "C:/…") or a share ("\\server\…", a name with no slash in it). */
const BARE_WINDOWS_PATH = /(?<![\w\\\uE000])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+\\)[^\s'"`<>|]*/gu;
const BARE_WINDOWS_PATH_AT = /(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+\\)[^\s'"`<>|]*/uy;
/** A private folder (FOLDER_MARK) not in a path already hidden, with the rest of the path in it up to a space. */
const FOLDER_REST = /\uE000[^\s'"`<>|]*/gu;
/**
 * What is left of a path cut by a space, right after a hidden one: the words that follow it with a separator in them
 * ("Publish\dati\x.png" after "C:\…\Histeon"), never a URL. "e/o" or a date right after a path goes with it.
 */
const PATH_REST = new RegExp(`${escapeRegExp(PATH_HIDDEN)}(?: +(?!\\S*:\\/\\/)[^\\s'"\`<>|]*[\\\\/][^\\s'"\`<>|]*)+`, "gu");
/** The punctuation that ends a sentence after a bare path, which stays ("… in /a/b: riprova."). */
const SENTENCE_END = /[.,;:!?)\]]+$/u;
const SEPARATOR = /[\\/]/u;
/** What ends a path written without quotes, as the patterns above read it: a space, a quote, "<", ">", "|". */
const PATH_END = /[\s'"`<>|]/u;
/**
 * What may glue the text right after it to a name, a host or a URL, so that no path starts there (startsPath reads
 * the rest): an ASCII letter or digit, "_.~%@+-", a separator, ":". Any other character glues nothing, as for
 * BARE_POSIX_PATH: a space, a quote, a bracket ("]" too), "=", ",", a letter outside ASCII.
 */
const MAY_GLUE = /[A-Za-z0-9_.~%@+\-\\/:]/u;
/** What a name is made of, as the word right before a path reads it: "ui", "v2", "x_y", "a.b", "~", "..", "50%". */
const NAME_CHAR = /[A-Za-z0-9_.~%@+-]/u;
/**
 * A word right before a path that glues nothing to it: dashes or pluses alone (a list, a line of a diff: "-/home/…"),
 * a short option and its value ("-d/home/…"), one that ends in an ellipsis (".../home/…") or in "@" (no host comes
 * after "@" and a separator: "f@/home/…", as Safari writes a stack).
 */
const LOOSE_WORD = /^(?:[-+]+|-[A-Za-z]|.*\.\.\.|.*@)$/u;
/**
 * A web address, from its scheme to a space, a quote or a backslash (no URL holds one), also with its slashes escaped
 * as PHP writes them in JSON ("https:\/\/example.com\/data", or "https:\\/\\/…" before a reading decodes the JSON
 * that escaped it again): a private folder in it belongs to the site, unless what is right before it glues nothing
 * ("https://x.org/a=/data", startsPath).
 */
const WEB_ADDRESS = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\\*\/\\*\/(?:[^\s'"`<>|\\]|\\+\/)*/gu;
/**
 * An address whose path is a path of a file system, up to where its path starts: a file URL ("file:", "file:///",
 * "file://host"), one with no host at all ("webpack:///home/…", "vscode:///…": "scheme:" and the path from its first
 * slash), a file transfer (sftp, scp, ssh, smb), an editor's link to a file ("vscode://file/…") or a server of this
 * computer (localhost, 127.x.x.x, [::1]), whose paths a development server maps to files ("/@fs/home/anna/…"). Not
 * inside a word, but after "+", "." or "-" (a list, "-file:///home/…"; "svn+ssh://…"); and at a boundary of a
 * reading, whatever is before it (localAddresses: "Errore\u001b[31mfile:///home/…"). Only the end matters (where the
 * path starts), so LOCAL_ADDRESS reads a scheme from its last part: what follows its last "+", "." or "-" (a digit
 * first too: "x-2:///…"), or the whole of one without them. Each try then reads one part, never the rest of a run of
 * "a-a-a-…" from each "-" of it, which takes the square of its length. LOCAL_ADDRESS_AT is the same at one place, with
 * a whole scheme of 32 characters at most: in a long run of letters that sequences cut, each try is short.
 */
const localAddress = (scheme: string) => String.raw`(?:file:|${scheme}:(?=\/\/\/)|(?:sftp|scp|ssh|smb):\/\/[^\s'"${"`"}<>|\\/]*|${scheme}:\/\/(?:[^\s'"${"`"}<>|\\/@]*@)?(?:localhost|[^\s'"${"`"}<>|\\/@:]*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|file)(?::\d{0,5})?(?![^\s'"${"`"}<>|\\/?#]))`;
const LOCAL_ADDRESS = new RegExp(`(?<![A-Za-z0-9])${localAddress("(?:(?<=[+.-])[A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*)")}`, "giu");
const LOCAL_ADDRESS_AT = new RegExp(localAddress("[A-Za-z][A-Za-z0-9+.-]{0,31}"), "iuy");
/** addressKinds: a position in a web address, or in the path of a local one (LOCAL_ADDRESS) to a space or a quote. */
const IN_WEB_ADDRESS = 1;
const IN_LOCAL_PATH = 2;
/**
 * An escape a message may hold (readings): one of JSON ("\n", "\t", "\u001b", "\"", "\\", "\/"), a byte as C, Python
 * or PHP write one ("\x2f", "\x1b[31m") or a character a shell escapes, a space or ASCII punctuation
 * ("/home/anna\ rossi", "o\'brien").
 */
const ESCAPE = /\\(?:([bfnrt])|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|([\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]))/gu;
const ESCAPED_LETTER: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
/**
 * The escape character as a terminal gets it, as `cat -v` shows it ("^[") or as its symbol ("␛"); and CSI, the
 * escape and "[" or its 8-bit form (U+009B, "M-^[" in `cat -v`).
 */
const ESC = String.raw`(?:\u001b|\^\[|\u241b)`;
const CSI = String.raw`(?:${ESC}\[|\u009b|M-\^\[)`;
/**
 * What ends a terminal sequence (an ECMA-48 final byte in `range`), unless it starts a path or another sequence: not
 * the letter of a drive ("\u001b[C:\Users\anna"), not the backslash of an ESCAPE a reading decodes
 * ("\u009b1\u006d/home/…", "\u001b\\/home/…", "␛\[31m/home/…" a shell escaped, the "\\" of a share
 * "\u001b\\\\server\…"), not the "^" of "^[" ("\u001b[^[[31m"); "/" is no final byte.
 */
const FINAL = (range: string) => String.raw`(?!\^\[|M-\^\[)(?:[${range}](?!:[\\/])|\\(?![bfnrt]|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]))`;
/**
 * A control sequence of a terminal as ECMA-48 writes it: CSI, parameters (0x30–0x3F: digits, ";", ":", "<=>?"),
 * intermediates (0x20–0x2E: never "/", which starts a path) and a final byte (0x40–0x7E, FINAL): "\u001b[31m",
 * "\u001b[?25l", "\u001b[38:2:255:0:0m"; or an escape, intermediates and a final byte (0x30–0x7E but "[", which is
 * CSI): the choice of a character set ("\u001b(B", as tput sgr0 writes it), "\u001b7" and "\u001b8" (tput sc and rc),
 * "\u001b\\" (the end of a string), "\u001b]" (the start of one, whose text stays to be read). Digits, signs and one
 * last character: no sequence holds a character of a path. Group 1 or 2, the final byte: without it (an escape alone,
 * "\u001b(" or "\u001b[31" right before "/home/…") nothing goes, but a boundary is left (terminalSequences).
 */
const TERMINAL_SEQUENCE = new RegExp(String.raw`${CSI}[\x30-\x3F]*[\x20-\x2E]*(${FINAL(String.raw`\x40-\x5B\x5D-\x7E`)})?|${ESC}[\x20-\x2E]*(${FINAL(String.raw`\x30-\x5A\x5D-\x7E`)})?`, "gu");
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/gu;
/**
 * What the path of a local address keeps written as "%XX" in a decoded reading: what would end a path there (a space,
 * a quote), "%" itself, a control character. So "file:///home/anna%20rossi/Sito%20di%20prova/x.html" stays one path,
 * and the private folders are also looked for spelled so (privateFoldersPattern). A separator is decoded:
 * "http://localhost:4321/?file=%2Fhome%2Fanna" or "…=C%3A%5CUsers%5Canna" holds a path.
 */
const KEPT_ENCODED = /[\s'"`<>|%\p{Cc}]/u;
/** What a URL may not hold, where its "%XX" end (percentEscapes): not an apostrophe, which it may ("o'brien"). */
const URL_END = /[\s"`<>|\\]/u;

/**
 * The folders whose names must not reach a client: `extra` (the data folder the app was started with), the user's
 * home, and the data folder the app uses by default (defaultDataDirectory: HISTOS_PUBLISH_DATA_DIR, XDG_DATA_HOME or
 * APPDATA may put it outside the home).
 */
function privateFolders(extra: readonly string[]): string[] {
  const folders = [...extra];
  // No home to be found (no HOME, no user entry) leaves the others; the error being cleaned must still go out.
  try { folders.push(homedir()); } catch { /* No home folder. */ }
  try { folders.push(defaultDataDirectory()); } catch { /* No default data folder either. */ }
  return folders;
}

/** `char` as a URL writes it: "%XX" for each of its UTF-8 bytes. */
const percentEncoded = (char: string) => [...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");

/**
 * The parts of each private folder that is one of its own (not "/", nor "C:"), and of each on a drive also without it
 * (`driveless`: "C:\Users\anna" as "\Users\anna", which names it on the same drive): so nothing between the drive and
 * its ":" (a terminal sequence, "C\u001b[1m:\Users\anna") keeps the rest of the folder from being found.
 */
function folderParts(folders: readonly string[]): Array<{ parts: string[]; driveless: boolean }> {
  const found: Array<{ parts: string[]; driveless: boolean }> = [];
  for (const folder of folders) {
    const parts = folder.replace(/[\\/]+$/u, "").split(/[\\/]+/u);
    if (parts.length < 2 || parts.join("").length === 0) continue;
    found.push({ parts, driveless: false });
    if (/^[A-Za-z]:$/u.test(parts[0] as string)) found.push({ parts: ["", ...parts.slice(1)], driveless: true });
  }
  return found;
}

/**
 * The private folders as one pattern: either slash for a separator, in any case (Windows and macOS ignore it), as
 * written, as a file URL writes it ("/home/anna%20rossi": as encodeURI, and as a decoded reading leaves one, a
 * KEPT_ENCODED character either way: pathToFileURL's "/home/anna%20rossi%20[x]", "o'brien"; a name with "%XX" in it
 * decoded too) or with a quote in a name as JSON writes it ("a\"b"); the longer first, so the data folder inside the
 * home goes whole. A folder that starts with a separator is
 * found from the first separator of a run, never from inside one: one try per run, not one per separator in it, each
 * scanning the rest of the run. Where a match counts is folderSpans' business. `reach` exceeds any match written with
 * single separators, or with each character escaped ("\u0061"), to find one that the cut at MESSAGE_KEPT would split.
 * Null when none is a folder of its own ("/", "C:").
 */
function privateFoldersPattern(folders: readonly string[]): { pattern: RegExp; reach: number } | null {
  const variants = new Set<string>();
  let longest = 0;
  // A name Windows allows but a URL cannot spell (a lone surrogate) is only matched as written.
  const encoded = (part: string) => { try { return encodeURI(part); } catch { return part; } };
  const asWritten = (part: string) => escapeRegExp(part).replaceAll('"', '\\\\*"');
  const asDecoded = (part: string) => [...part].map((char) => (KEPT_ENCODED.test(char) ? `(?:${escapeRegExp(char)}|${percentEncoded(char)})` : escapeRegExp(char))).join("");
  // A name with "%XX" in it ("100%41"), written as it is in a file URL, as a decoded reading leaves it ("100A").
  const percentsDecoded = (part: string) => {
    const edits: Edit[] = [];
    percentsIn(part, 0, part.length, edits);
    return edited(plainReading(part), edits).text;
  };
  const driveless = new Set<string>();
  for (const { parts, driveless: withoutDrive } of folderParts(folders)) {
    for (const spellings of [parts.map(asWritten), parts.map(encoded).map(asWritten), parts.map(asDecoded), parts.map(percentsDecoded).map(asDecoded)]) {
      const spelled = spellings.join("[\\\\/]+");
      (withoutDrive ? driveless : variants).add(parts[0] === "" ? `(?<![\\\\/])${spelled}` : spelled);
    }
    longest = Math.max(longest, parts.map(encoded).join("/").length);
  }
  if (variants.size === 0) return null;
  const byLength = (set: Set<string>) => [...set].sort((a, b) => b.length - a.length).join("|");
  // A folder written without its drive is the group "driveless" (folderSpans), after the others.
  const all = byLength(variants) + (driveless.size > 0 ? `|(?<driveless>${byLength(driveless)})` : "");
  return { pattern: new RegExp(all, "giu"), reach: 6 * longest + 64 };
}

/**
 * The private folders as one pattern however a message decoded past DECODINGS may still spell them (readings'
 * `beyond`): each character as it is or as a file URL writes it (KEPT_ENCODED), with backslashes before it
 * ("anna\\\ rossi", "c\\#dev"), or as "\uXXXX" or "\xXX" after one or more ("\\u0061nna"); a run of slashes and
 * backslashes for a separator; in any case. From the start of a run of separators only, never from inside one (a match
 * cannot start right after a slash or a backslash). Null when none is a folder of its own.
 */
function looseFoldersPattern(folders: readonly string[]): RegExp | null {
  const variants = new Set<string>();
  const spelled = (char: string) => {
    const units = Array.from({ length: char.length }, (_, index) => String.raw`\\+u${char.charCodeAt(index).toString(16).padStart(4, "0")}`).join("");
    const plain = KEPT_ENCODED.test(char) ? `(?:${escapeRegExp(char)}|${percentEncoded(char)})` : escapeRegExp(char);
    const byte = char.length === 1 && char.charCodeAt(0) < 0x100 ? String.raw`|\\+x${char.charCodeAt(0).toString(16).padStart(2, "0")}` : "";
    return String.raw`(?:\\*${plain}|${units}${byte})`;
  };
  for (const { parts } of folderParts(folders)) {
    // A drive may follow a slash ("file:///C:/Users/…"), never a backslash.
    const start = parts[0] === "" ? String.raw`(?<![\\/])` : String.raw`(?<!\\)`;
    variants.add(start + parts.map((part) => [...part].map(spelled).join("")).join(String.raw`[\\/]+`));
  }
  if (variants.size === 0) return null;
  return new RegExp([...variants].sort((a, b) => b.length - a.length).join("|"), "giu");
}

/**
 * A text the patterns read (a reading of a message, readings) and, for each of its characters, the part of the
 * message it stands for: `from[i]` to `to[i]`, exclusive. One character for itself; all of an escape it was decoded
 * from ("\n", "\u001b", "%23"); a whole private folder, for FOLDER_MARK. `loose`: a backslash an escape wrote (the
 * "\\" of JSON), which glues nothing to what follows it, as the start of a JSON line does not. `boundary`, one more
 * than the text: a terminal sequence was right before the character (removed, or left as it is without its final
 * byte, terminalSequences), which glues nothing to it ("Errore\u001b[31m/home/…" is "Errore" and a path) and ends no
 * path ("/home/\u001b[1manna rossi" is one).
 */
interface Reading { text: string; from: Int32Array; to: Int32Array; loose: Uint8Array; boundary: Uint8Array }
/**
 * A change to a Reading: what is from `start` to `end` becomes `text`; `loose`, its characters. With no text, what
 * was there goes, and leaves a boundary (Reading) before what follows; with nothing in between either (`start` =
 * `end`), only that boundary.
 */
type Edit = readonly [start: number, end: number, text: string, loose: boolean];

/** `text` as a Reading of itself. */
function plainReading(text: string): Reading {
  const from = new Int32Array(text.length);
  const to = new Int32Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    from[index] = index;
    to[index] = index + 1;
  }
  return { text, from, to, loose: new Uint8Array(text.length), boundary: new Uint8Array(text.length + 1) };
}

/**
 * `reading` with `edits` made, in order and apart: each new character stands for all that the part it replaces stood
 * for; an edit with no text leaves a boundary before the next character (Reading).
 */
function edited(reading: Reading, edits: readonly Edit[]): Reading {
  if (edits.length === 0) return reading;
  let length = reading.text.length;
  for (const [start, end, text] of edits) length += text.length - (end - start);
  const from = new Int32Array(length);
  const to = new Int32Array(length);
  const loose = new Uint8Array(length);
  const boundary = new Uint8Array(length + 1);
  const parts: string[] = [];
  let read = 0;
  let write = 0;
  // A boundary for the next character written: one an edit with no text left, or one that was before what went.
  let pending = 0;
  const copy = (until: number) => {
    if (until <= read) return;
    parts.push(reading.text.slice(read, until));
    if (until - read < 32) {
      // Short parts between many edits (a run of sequences): copied one by one, cheaper than four views each.
      for (let at = read, into = write; at < until; at += 1, into += 1) {
        from[into] = reading.from[at] as number;
        to[into] = reading.to[at] as number;
        loose[into] = reading.loose[at] as number;
        boundary[into] = reading.boundary[at] as number;
      }
    } else {
      from.set(reading.from.subarray(read, until), write);
      to.set(reading.to.subarray(read, until), write);
      loose.set(reading.loose.subarray(read, until), write);
      boundary.set(reading.boundary.subarray(read, until), write);
    }
    boundary[write] = (boundary[write] as number) | pending;
    pending = 0;
    write += until - read;
  };
  for (const [start, end, text, isLoose] of edits) {
    copy(start);
    if (text.length === 0) {
      pending = 1;
      read = Math.max(read, end);
      continue;
    }
    parts.push(text);
    from.fill(reading.from[start] as number, write, write + text.length);
    to.fill(reading.to[end - 1] as number, write, write + text.length);
    loose.fill(isLoose ? 1 : 0, write, write + text.length);
    boundary[write] = (reading.boundary[start] as number) | pending;
    pending = 0;
    write += text.length;
    read = end;
  }
  copy(reading.text.length);
  boundary[length] = (reading.boundary[reading.text.length] as number) | pending;
  return { text: parts.join(""), from, to, loose, boundary };
}

/**
 * Each TERMINAL_SEQUENCE of `text`: one with its final byte goes, one without stays as it is (nothing it would take is
 * surely its own: "\u001b[/home/…", "\u009b/home/…"); either leaves a boundary before what follows. `kept`: the final
 * byte of each stays, and the rest of it is a space, which ends a path ("/home/anna/x\u001b8") and glues nothing. Which
 * it was is not known: a letter is the end of "\u001b[31m" before "/home/…" and inside "/home/\u001b[1manna", but the
 * first letter of an address after an escape with nothing else, or one whose "[" an escape wrote ("\u001bsftp://…",
 * "\u001b\u005bssh://…"); so a reading where one went is read both ways (readings).
 */
function terminalSequences(text: string, kept = false): Edit[] {
  const edits: Edit[] = [];
  TERMINAL_SEQUENCE.lastIndex = 0;
  for (let match = TERMINAL_SEQUENCE.exec(text); match; match = TERMINAL_SEQUENCE.exec(text)) {
    const end = match.index + match[0].length;
    const final = match[1] ?? match[2];
    if (final === undefined) edits.push([end, end, "", false]);
    else if (!kept) edits.push([match.index, end, "", false]);
    else edits.push([match.index, end - final.length, " ", false]);
  }
  return edits;
}

/**
 * Each LOCAL_ADDRESS of `reading`, [start, end of what is before its path], in order and apart: also one that starts at
 * a boundary (a terminal sequence was there), glued to the word before it as written ("Errore\u001b[31mfile:///…").
 */
function localAddresses(reading: Reading): Array<[number, number]> {
  const { text, boundary } = reading;
  const found: Array<[number, number]> = [];
  let next = boundary.indexOf(1, 1);
  const atBoundaries = (until: number) => {
    while (next >= 0 && next < until) {
      const at = next;
      next = boundary.indexOf(1, at + 1);
      // After anything but a letter or a digit, LOCAL_ADDRESS finds it itself.
      if (!/[A-Za-z]/u.test(text[at] ?? "") || !/[A-Za-z0-9]/u.test(text[at - 1] as string)) continue;
      LOCAL_ADDRESS_AT.lastIndex = at;
      const match = LOCAL_ADDRESS_AT.exec(text);
      if (!match || at + match[0].length > until) continue;
      found.push([at, at + match[0].length]);
      while (next >= 0 && next < at + match[0].length) next = boundary.indexOf(1, next + 1);
    }
  };
  for (const match of text.matchAll(LOCAL_ADDRESS)) {
    atBoundaries(match.index);
    found.push([match.index, match.index + match[0].length]);
    while (next >= 0 && next < match.index + match[0].length) next = boundary.indexOf(1, next + 1);
  }
  atBoundaries(text.length + 1);
  return found;
}

/** The character the UTF-8 sequence at `index` of `bytes` encodes, and how many bytes it takes; null for none. */
function utf8At(bytes: readonly number[], index: number): { point: number; size: number } | null {
  const lead = bytes[index] as number;
  if (lead < 0x80) return { point: lead, size: 1 };
  const [size, least] = lead >= 0xc2 && lead <= 0xdf ? [2, 0x80] : lead >= 0xe0 && lead <= 0xef ? [3, 0x800] : lead >= 0xf0 && lead <= 0xf4 ? [4, 0x10000] : [0, 0];
  if (size === 0 || index + size > bytes.length) return null;
  let point = lead & (0xff >> (size + 1));
  for (let next = index + 1; next < index + size; next += 1) {
    const byte = bytes[next] as number;
    if ((byte & 0xc0) !== 0x80) return null;
    point = (point << 6) | (byte & 0x3f);
  }
  return point < least || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? null : { point, size };
}

/**
 * Each "%XX" in the path of a local address (LOCAL_ADDRESS, to URL_END) as the character it encodes, one UTF-8
 * sequence at a time, unless it is KEPT_ENCODED or is no UTF-8.
 */
function percentEscapes(reading: Reading): Edit[] {
  const { text } = reading;
  const edits: Edit[] = [];
  let reach = 0;
  for (const [, after] of localAddresses(reading)) {
    const start = Math.max(after, reach);
    let end = start;
    while (end < text.length && !URL_END.test(text[end] as string)) end += 1;
    reach = end;
    percentsIn(text, start, end, edits);
  }
  return edits;
}

/** The "%XX" of `text` from `start` to `end` decoded as percentEscapes decodes them, added to `edits`. */
function percentsIn(text: string, start: number, end: number, edits: Edit[]): void {
  for (const run of text.slice(start, end).matchAll(PERCENT_RUN)) {
    const at = start + run.index;
    const bytes = Array.from({ length: run[0].length / 3 }, (_, index) => Number.parseInt(run[0].slice(3 * index + 1, 3 * index + 3), 16));
    for (let index = 0; index < bytes.length;) {
      const code = utf8At(bytes, index);
      if (code === null) { index += 1; continue; }
      const char = String.fromCodePoint(code.point);
      if (!KEPT_ENCODED.test(char)) edits.push([at + 3 * index, at + 3 * (index + code.size), char, false]);
      index += code.size;
    }
  }
}

/**
 * `reading` decoded once more (readings), or null when there is nothing left to decode; `kept`, the same with the final
 * bytes of the terminal sequences kept (terminalSequences), when one went.
 */
function decodedOnce(reading: Reading): { next: Reading; kept: Reading | null } | null {
  const escapes: Edit[] = [...reading.text.matchAll(ESCAPE)].map((match) => {
    const [whole, letter, unit, byte, mark] = match;
    const code = unit ?? byte;
    const char = letter ? ESCAPED_LETTER[letter] as string : code ? String.fromCharCode(Number.parseInt(code, 16)) : mark as string;
    return [match.index, match.index + whole.length, char, char === "\\"];
  });
  const decoded = edited(reading, escapes);
  const sequences = terminalSequences(decoded.text);
  let next = edited(decoded, sequences);
  next = edited(next, percentEscapes(next));
  // A boundary alone (a sequence without its final byte, found again) decodes nothing.
  if (next.text === reading.text) return null;
  const kept = sequences.some(([start, end]) => end > start) ? edited(decoded, terminalSequences(decoded.text, true)) : null;
  return { next, kept: kept && edited(kept, percentEscapes(kept)) };
}

/**
 * The readings of a message the patterns run on (`found`): the message as it is, without the sequences of a terminal
 * (TERMINAL_SEQUENCE, each a boundary, Reading), and also as it is and with their final bytes kept when one went (a
 * final byte may have been the first letter of an address: "\u001b[ssh://…", "\u001bsftp://…"); then decoded, each a
 * Reading of the one before decoded once more, so that what an escape wrote is what it stands for, and each escape a
 * plain boundary: a line of a JSON string ("\nfile:///home/…", "\u001b[31m/home/…"), a quote or a slash JSON escaped
 * ("Errore:\/home\/anna"), a space a shell escaped ("/home/anna\ rossi"), a character of a file URL ("c%23dev"), each
 * also with its final bytes kept where a sequence went ("\\u001bsftp://…": terminalSequences); and again, for a JSON
 * string inside another, up to DECODINGS times. Each reading may also be wrong: "C:\Users\nadia" is a path as written
 * and a line break decoded. So the patterns run on each of them, and what any of them hides is hidden (hideFilePaths). `beyond`: when
 * DECODINGS were not enough, the last of them and the message decoded further, up to BEYOND_DECODINGS more times, in
 * which every private folder goes however it is spelled (looseFoldersPattern); none otherwise.
 */
function readings(text: string): { found: Reading[]; beyond: Reading[] } {
  const plain = plainReading(text);
  const first = edited(plain, terminalSequences(text));
  const found = first.text === text ? [first] : [first, plain, edited(plain, terminalSequences(text, true))];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal sequence starts with the escape character.
  if (!/[\\%\u001b\u009b]/u.test(text)) return { found, beyond: [] };
  // Decoded from the message as written: a sequence is read where the escapes are decoded, so that a final byte never
  // takes the backslash of an escape ("\u009b1\u006d/home/…" is a colour and a path).
  let last = plain;
  for (let count = 0; count < DECODINGS; count += 1) {
    const once = decodedOnce(last);
    if (!once) return { found, beyond: [] };
    // The same as the message without its sequences (they were all it had to decode), and so its `kept` too.
    if (once.next.text !== first.text) found.push(once.next, ...(once.kept ? [once.kept] : []));
    last = once.next;
  }
  // Only while an escape is left: sequences alone nested deeper (each reading takes one level) spell no folder. Each
  // further reading, and the last one, is read: one more decoding may also undo a folder ("C:\Users\bob" of a Windows
  // home has "\b" in it).
  const beyond: Reading[] = [];
  for (let next = last.text.includes("\\") ? decodedOnce(last)?.next : null; next; next = next.text.includes("\\") && beyond.length <= BEYOND_DECODINGS ? decodedOnce(next)?.next : null) {
    if (beyond.length === 0) beyond.push(last);
    beyond.push(next);
  }
  return { found, beyond };
}

/**
 * For each position of `text`, the address it is in: IN_LOCAL_PATH in the path of a LOCAL_ADDRESS, up to a space or a
 * quote; IN_WEB_ADDRESS anywhere else in a WEB_ADDRESS; 0 elsewhere. A terminal sequence never makes a local address a
 * web one: a web address with a boundary of the reading in its scheme, its host or its port, or right before its path
 * ("http://localhost:51\u009b73/…", "http://127.0.0.\u001b[1:8080/…", "s\u001b[cp://…"), may be a local one that the
 * sequence cut, and its path is read as a local path. Linear: a local path that runs on into the next one is filled
 * once.
 */
function addressKinds(reading: Reading): Uint8Array {
  const { text, boundary } = reading;
  const kinds = new Uint8Array(text.length + 1);
  const cut: number[] = [];
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const end = match.index + match[0].length;
    kinds.fill(IN_WEB_ADDRESS, match.index, end);
    // Its path starts at the first "/", "\", "?" or "#" after the "//" (escaped too) of the scheme.
    let path = match.index + (/^[^:]*:\\*\/\\*\//u.exec(match[0])?.[0].length ?? 0);
    while (path < end && !/[\\/?#]/u.test(text[path] as string)) path += 1;
    if (boundary.subarray(match.index + 1, path + 1).includes(1)) cut.push(path);
  }
  for (const paths of [cut, localAddresses(reading).map(([, after]) => after)]) {
    let reach = 0;
    for (const after of paths) {
      const from = Math.max(after, reach);
      let end = from;
      while (end < text.length && !PATH_END.test(text[end] as string)) end += 1;
      kinds.fill(IN_LOCAL_PATH, from, end);
      reach = end;
    }
  }
  return kinds;
}

/** The ASCII word right before `index` (NAME_CHAR), at most its last 64 characters. */
function nameBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && index - start < 64 && NAME_CHAR.test(text[start - 1] as string)) start -= 1;
  return text.slice(start, index);
}

/**
 * Whether a path may start at `index` of `reading` (a separator, or the drive of "C:\…"), for what is right before it
 * (`kinds`: addressKinds of the text, read only when needed). It may at the start of the text; at a boundary of the
 * reading, where a terminal sequence was ("Errore\u001b[31m/home/…", "\u001b7/home/…", in a web address too: hiding
 * too much there is the safe side); after a character that glues nothing (MAY_GLUE), a line break, a tab or a quote an
 * escape wrote among them ("\n/home/…" of JSON, decoded);
 * after ":" unless "//" follows, the authority of a URL ("Errore:/home/…", "PATH=/usr/bin:/home/…"); anywhere in the
 * path of a local address ("http://127.0.0.1:43129/home/…", "vscode://file/home/…", "file:///mnt/x/home/…");
 * outside a web address, after a backslash an escape wrote (Reading's `loose`: "x\\/home/…" of JSON). Not glued to
 * a name: the ASCII word right before it ("ui/data", "v2/x", "~/data", "../data", "a_/home"), unless that word glues
 * nothing (LOOSE_WORD: "-/…", "-d/…", ".../…", "@/…"). In a web address every MAY_GLUE character glues
 * ("https://example.com/data/x", "https://x.org/-/data", "https://data.example.com"). A drive is glued only by an
 * ASCII letter, a digit, "_" or a backslash, as BARE_WINDOWS_PATH reads it ("x.C:\…" is a path, "xC:\…" is not), or
 * a short option takes it ("-dC:\…").
 */
function startsPath(reading: Reading, index: number, kinds: () => Uint8Array): boolean {
  if (index === 0 || reading.boundary[index] === 1) return true;
  const { text } = reading;
  const before = text[index - 1] as string;
  if (!MAY_GLUE.test(before)) return true;
  const kind = kinds()[index];
  if (kind === IN_LOCAL_PATH) return true;
  if (before === ":") return !(SEPARATOR.test(text[index] ?? "") && SEPARATOR.test(text[index + 1] ?? ""));
  const drive = text[index + 1] === ":" && /[A-Za-z]/u.test(text[index] as string);
  if (kind === IN_WEB_ADDRESS && !drive) return false;
  if (reading.loose[index - 1] === 1) return true;
  if (before === "\\") return false;
  if (drive) return !/[A-Za-z0-9_]/u.test(before) || /^-[A-Za-z]$/u.test(nameBefore(text, index));
  return before !== "/" && LOOSE_WORD.test(nameBefore(text, index));
}

/**
 * For each position of `text`, whether an absolute file path began before it with nothing in between that ends a path
 * written without quotes (PATH_END): a separator or a drive ("C:\") where a path may start (`starts`). A private
 * folder further on in one ("/var/home/anna", "\\?\C:\Users\anna") is still that folder; one in a web address glued to
 * it is not ("\nhttps://example.com/data", a JSON line break right after a space).
 */
function insideAbsolutePaths(text: string, starts: (index: number) => boolean, kinds: Uint8Array): Uint8Array {
  const inside = new Uint8Array(text.length + 1);
  let open = false;
  for (let index = 0; index < text.length; index += 1) {
    inside[index] = open && kinds[index] !== IN_WEB_ADDRESS ? 1 : 0;
    const char = text[index] as string;
    if (PATH_END.test(char)) open = false;
    else if (!open && (SEPARATOR.test(char) || (/[A-Za-z]/u.test(char) && text[index + 1] === ":" && SEPARATOR.test(text[index + 2] ?? ""))) && starts(index)) open = true;
  }
  inside[text.length] = open && kinds[text.length] !== IN_WEB_ADDRESS ? 1 : 0;
  return inside;
}

/** A private folder found in a reading, where it is in the message: `from` to `to`, and to the end of its path (`rest`). */
interface Occurrence { from: number; to: number; rest: number }

/**
 * Where the private folders are in `reading`, in order (`spans`): each one found where a path may have it, that is
 * where a path starts (startsPath, which also takes the path of a file URL or of another local address), right after
 * backslashes an escape wrote before a slash ("x\\/home/anna" of JSON), further on in an absolute path
 * (insideAbsolutePaths) or in the path a private folder found before goes on with ("/home/anna rossi/x/data"), right
 * after a path already hidden, or anywhere `taken` says (one a path took a part of, hideFilePaths). Not at the host of
 * a web address ("https://data.example.com"), nor in its path after the host or a name
 * ("https://example.com/data/x.png", "https://example.com:8080/a/data", with the data folder "/data"), nor glued to a
 * name ("ui/data/card"): those are `refused`. After a character that glues nothing ("https://x.org/a,/data") one
 * counts even in a web address: hiding too much there is the safe side.
 */
function folderSpans(reading: Reading, pattern: RegExp, taken: (start: number) => boolean): { spans: Array<[number, number]>; refused: Array<[number, number]> } {
  const { text } = reading;
  const spans: Array<[number, number]> = [];
  const refused: Array<[number, number]> = [];
  // Read once, and only for a folder whose place the character before it leaves in doubt.
  let addresses: Uint8Array | undefined;
  const kinds = () => (addresses ??= addressKinds(reading));
  const starts = (index: number) => startsPath(reading, index, kinds);
  let absolute: Uint8Array | undefined;
  const inAbsolutePath = (at: number) => {
    absolute ??= insideAbsolutePaths(text, starts, kinds());
    return absolute[at] === 1;
  };
  // Whether the text since the end of the last folder found holds nothing that ends a path (PATH_END), read once.
  let goesOn = false;
  let read = 0;
  const afterFolder = (at: number) => {
    for (; read < at; read += 1) if (PATH_END.test(text[read] as string)) goesOn = false;
    return goesOn;
  };
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const at = match.index;
    const backslashes = /^\\+(?=\/)/u.exec(match[0])?.[0].length ?? 0;
    // Written without its drive right after one ("C:", or the "m:" of "C\u001b[1m:\Users\anna"), it counts only where
    // that drive starts a path: "xC:\Users\anna" is no path, as BARE_WINDOWS_PATH reads it.
    const gluedDrive = match.groups?.driveless !== undefined && text[at - 1] === ":" && /[A-Za-z]/u.test(text[at - 2] ?? "") && !starts(at - 2);
    if (taken(at) || (!gluedDrive && (afterFolder(at) || starts(at) || (backslashes > 0 && starts(at + backslashes)) || text.endsWith(PATH_HIDDEN, at) || inAbsolutePath(at)))) {
      spans.push([at, at + match[0].length]);
      goesOn = true;
      read = at + match[0].length;
    } else {
      refused.push([at, at + match[0].length]);
      pattern.lastIndex = at + 1; // Not here: one character on, the same text may still hold one.
    }
  }
  return { spans, refused };
}

/**
 * Each quoted absolute path of `text`, whole, spaces included: from a QUOTE_OPENING to the first same quote on its line
 * with no letter, digit or "_" right after it (an apostrophe in a name, "/home/o'brien/x", does not end it). In a text
 * cut at MESSAGE_KEPT (`cut`) one left open goes on to the end, where the cut is. [start, end, closed], found in one
 * pass: looking for the closing quote anew from each opening one, as a pattern does, takes the square of the length.
 */
function quotedPaths(text: string, cut: boolean): Array<[number, number, boolean]> {
  const { length } = text;
  // From the end: where the next line break is, and the next quote of each kind that may close a path.
  const nextBreak = new Int32Array(length + 1).fill(length);
  const nextClosing = { "'": new Int32Array(length + 1).fill(length), '"': new Int32Array(length + 1).fill(length), "`": new Int32Array(length + 1).fill(length) };
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = text[index] as string;
    nextBreak[index] = char === "\n" ? index : nextBreak[index + 1] as number;
    for (const next of [nextClosing["'"], nextClosing['"'], nextClosing["`"]]) next[index] = next[index + 1] as number;
    if (char === "'" || char === '"' || char === "`") {
      if (!NAME_START.test(text.slice(index + 1, index + 3))) nextClosing[char][index] = index;
    }
  }
  const found: Array<[number, number, boolean]> = [];
  for (let index = 0; index < length; index += 1) {
    const char = text[index] as string;
    if (char !== "'" && char !== '"' && char !== "`") continue;
    const closings = nextClosing[char];
    QUOTE_OPENING.lastIndex = index;
    if (!QUOTE_OPENING.test(text)) continue;
    const closing = closings[index + 1] as number;
    const lineEnd = nextBreak[index + 1] as number;
    if (closing < lineEnd) {
      found.push([index, closing + 1, true]);
      index = closing;
    } else if (cut && lineEnd === length) {
      found.push([index, length, false]);
      break;
    }
  }
  return found;
}

/**
 * The paths of `marked` (a Reading, its private folders already FOLDER_MARK), marked in `hidden`, which holds what is
 * hidden already (the paths an error names): each quoted absolute path whole, to its own closing quote, a space in a
 * later part included ("open '/home/anna/Sito di Anna.html'"); then each unquoted one, and a private folder with the
 * rest of its path up to a space; last, what is left after a hidden path of one cut by a space. Each step reads the
 * text as the steps before left it, a hidden part written PATH_HIDDEN. `cut`: the text was cut, and a quoted path the
 * cut leaves open goes to the end.
 */
function hiddenParts(marked: Reading, hidden: Uint8Array, cut: boolean): void {
  const loose = marked.loose.includes(1) || marked.boundary.includes(1);
  let text = "";
  let start = new Int32Array(0);
  let end = new Int32Array(0);
  let shown = new Uint8Array(0);
  // The text as the steps before left it, written again only when a step hid something: for each of its characters,
  // the part of `marked` it stands for, and whether it is shown.
  let changed = true;
  const render = () => {
    if (!changed) return;
    changed = false;
    let length = 0;
    for (let index = 0; index < marked.text.length; index += 1) {
      if (hidden[index] !== 1) length += 1;
      else if (index === 0 || hidden[index - 1] !== 1) length += PATH_HIDDEN.length;
    }
    const parts: string[] = [];
    start = new Int32Array(length);
    end = new Int32Array(length);
    shown = new Uint8Array(length);
    let write = 0;
    for (let index = 0; index < marked.text.length;) {
      let next = index + 1;
      while (next < marked.text.length && (hidden[next] === 1) === (hidden[index] === 1)) next += 1;
      if (hidden[index] === 1) {
        parts.push(PATH_HIDDEN);
        start.fill(index, write, write + PATH_HIDDEN.length);
        end.fill(next, write, write + PATH_HIDDEN.length);
        write += PATH_HIDDEN.length;
      } else {
        parts.push(marked.text.slice(index, next));
        for (let at = index; at < next; at += 1, write += 1) {
          start[write] = at;
          end[write] = at + 1;
          shown[write] = 1;
        }
      }
      index = next;
    }
    text = parts.join("");
  };
  const hide = (from: number, to: number) => {
    if (from >= to) return;
    hidden.fill(1, start[from], end[to - 1]);
    changed = true;
  };
  // The punctuation that ends a sentence stays, and so does a backslash that escapes the quote after the path ("\"").
  const bare = (at: number, match: string) => {
    let kept = SENTENCE_END.exec(match)?.[0].length ?? 0;
    if (kept === 0 && /["'`]/u.test(text[at + match.length] ?? "") && (/\\+$/u.exec(match)?.[0].length ?? 0) % 2 === 1) kept = 1;
    hide(at, at + match.length - kept);
  };
  // Where `marked` is in an address (addressKinds), read once and only for a boundary.
  let addresses: Uint8Array | undefined;
  const inAddress = (at: number) => {
    addresses ??= addressKinds(marked);
    return addresses[at] !== 0;
  };
  // Each path of `pattern`, and where `sticky` finds one right after a backslash an escape wrote or at a boundary (a
  // terminal sequence was there) but in an address, past those found. In an address the boundary starts no path the
  // address without its sequences would not have: a colour of a development server ("http://localhost:\u001b[1m4321
  // \u001b[22m/chi-siamo/") or of a link ("https://x.org/a\u001b[0m/b/c") leaves its path; a private folder there is
  // still found at the boundary (folderSpans, startsPath).
  const step = (pattern: RegExp, sticky?: RegExp) => {
    render();
    const found: Array<[number, string]> = [...text.matchAll(pattern)].map((match) => [match.index, match[0]]);
    if (sticky && loose) {
      let next = 0;
      let covered = 0;
      for (let index = 1; index < text.length; index += 1) {
        for (; next < found.length && (found[next] as [number, string])[0] <= index; next += 1) covered = Math.max(covered, (found[next] as [number, string])[0] + (found[next] as [number, string])[1].length);
        if (index < covered) continue;
        const afterLoose = shown[index - 1] === 1 && marked.loose[start[index - 1] as number] === 1;
        if (!afterLoose && !(shown[index] === 1 && marked.boundary[start[index] as number] === 1 && !inAddress(start[index] as number))) continue;
        sticky.lastIndex = index;
        const match = sticky.exec(text);
        if (!match) continue;
        bare(index, match[0]);
        covered = index + match[0].length;
      }
    }
    for (const [at, match] of found) bare(at, match);
  };
  render();
  for (const [from, to, closed] of quotedPaths(text, cut)) hide(from + 1, closed ? to - 1 : to);
  step(BARE_POSIX_PATH, BARE_POSIX_PATH_AT);
  step(BARE_WINDOWS_PATH, BARE_WINDOWS_PATH_AT);
  step(FOLDER_REST);
  step(PATH_REST);
}

/**
 * The paths of `reading`, marked in `mask` (positions of the message), and each private folder found in it, added to
 * `found`. `taken`: where a private folder starts that a path took a part of (hideFilePaths); `named`: the paths an
 * error names, hidden whatever else.
 */
function hidePaths(reading: Reading, folders: RegExp | null, taken: ReadonlySet<number>, named: Uint8Array, cut: boolean, mask: Uint8Array, found: Occurrence[]): void {
  const { spans, refused } = folders ? folderSpans(reading, folders, (at) => taken.has(reading.from[at] as number) || (at > 0 && named[reading.from[at - 1] as number] === 1)) : { spans: [], refused: [] };
  if (spans.length + refused.length > 0) {
    // Where the path each position is in ends (PATH_END), read once from the end.
    const pathEnd = new Int32Array(reading.text.length + 1).fill(reading.text.length);
    for (let index = reading.text.length - 1; index >= 0; index -= 1) pathEnd[index] = PATH_END.test(reading.text[index] as string) ? index : pathEnd[index + 1] as number;
    for (const [start, end] of [...spans, ...refused]) {
      const rest = Math.max(end, pathEnd[end] as number);
      found.push({ from: reading.from[start] as number, to: reading.to[end - 1] as number, rest: reading.to[rest - 1] as number });
    }
  }
  const marked = edited(reading, spans.map(([start, end]): Edit => [start, end, FOLDER_MARK, false]));
  const hidden = new Uint8Array(marked.text.length);
  // What an error names is hidden from the start; a private folder in it is too, but by the steps, with its path.
  for (let index = 0; index < marked.text.length; index += 1) if (named[marked.from[index] as number] === 1 && marked.text[index] !== FOLDER_MARK) hidden[index] = 1;
  hiddenParts(marked, hidden, cut);
  for (let index = 0; index < marked.text.length;) {
    if (hidden[index] !== 1) { index += 1; continue; }
    let next = index;
    while (next < marked.text.length && hidden[next] === 1) next += 1;
    mask.fill(1, marked.from[index], marked.to[next - 1]);
    index = next;
  }
}

/**
 * Every match of `pattern` (looseFoldersPattern) in `reading`, wherever it is, as an Occurrence: to the end of its
 * path (PATH_END).
 */
function everyFolder(reading: Reading, pattern: RegExp | null): Occurrence[] {
  if (!pattern) return [];
  const { text } = reading;
  const found: Occurrence[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const to = match.index + match[0].length;
    if (end < to) for (end = to; end < text.length && !PATH_END.test(text[end] as string);) end += 1;
    found.push({ from: reading.from[match.index] as number, to: reading.to[to - 1] as number, rest: reading.to[end - 1] as number });
  }
  return found;
}

/** Whether `occurrence` is hidden in part only: some of it is in `mask`, some is not (`sums`: running count of `mask`). */
const hiddenInPart = (occurrence: Occurrence, sums: Int32Array) => {
  const hidden = (sums[occurrence.to] as number) - (sums[occurrence.from] as number);
  return hidden > 0 && hidden < occurrence.to - occurrence.from;
};
const runningSums = (mask: Uint8Array) => {
  const sums = new Int32Array(mask.length + 1);
  for (let index = 0; index < mask.length; index += 1) sums[index + 1] = (sums[index] as number) + (mask[index] as number);
  return sums;
};

/**
 * A message with the file paths in it hidden, for a client that must not learn where the app keeps its data nor the
 * user's name in it (the AI agent: the connector shows it neither the data folder nor any absolute path). The paths an
 * error names (`path` and `dest` of Node's file errors) go exactly, however written. The patterns run on each reading
 * of the message (readings: as written, and decoded, so that an escape of JSON or of a shell, a sequence of a terminal
 * or "%XX" in a file URL is what it stands for), and a part any reading hides is hidden in the message as written. In
 * each, every private folder (privateFolders: the home, the data folder, `folders`) becomes FOLDER_MARK wherever a path
 * may have it (folderSpans: not in a web address, not glued to a name) and however it is spelled, so that nothing in
 * its name can end the path that goes on from it; then the paths themselves (hiddenParts). A private folder left
 * where it was must come out whole: one a path took a part of ("ui/home/anna" of "/srv/x ui/home/anna rossi") counts
 * as found when the readings are read again, up to RETRIES times; past them, it goes with the rest of its path. A
 * message that DECODINGS do not decode whole (a JSON string in another, in another, with a shell escape in it) loses
 * every private folder in it however spelled and wherever it is (readings' `beyond`, looseFoldersPattern), with the
 * rest of its path. The secret scrub (safeErrorMessage) comes after. Only the first 4 KiB are kept: a path the cut
 * would split goes whole, a private folder left as it is goes, and a quoted path the cut leaves open goes to the end.
 */
export function hideFilePaths(text: string, error?: unknown, folders: readonly string[] = []): string {
  const privates = privateFolders(folders);
  const pattern = privateFoldersPattern(privates);
  const cut = text.length > MESSAGE_KEPT;
  // Past the cut, as far as a private folder the cut would split may go, so that it is found whole.
  const source = cut ? text.slice(0, MESSAGE_KEPT + (pattern?.reach ?? 64)) : text;
  const { found: allReadings, beyond } = readings(source);
  // Past DECODINGS, every private folder goes, however spelled and wherever it is, with the rest of its path.
  const loose = beyond.length > 0 ? looseFoldersPattern(privates) : null;
  const spelled = beyond.flatMap((view) => everyFolder(view, loose));
  const named = new Uint8Array(source.length + 1);
  if (error && typeof error === "object") {
    for (const key of ["path", "dest"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value !== "string" || value.length <= 1) continue;
      for (const view of allReadings) {
        for (let at = view.text.indexOf(value); at >= 0; at = view.text.indexOf(value, at + value.length)) named.fill(1, view.from[at], view.to[at + value.length - 1]);
      }
    }
  }
  const taken = new Set<number>();
  let mask = named;
  let found: Occurrence[] = [];
  for (let round = 0; ; round += 1) {
    mask = named.slice();
    found = [];
    for (const view of allReadings) hidePaths(view, pattern?.pattern ?? null, taken, named, cut, mask, found);
    for (const occurrence of spelled) {
      mask.fill(1, occurrence.from, Math.max(occurrence.to, occurrence.rest));
      found.push(occurrence);
    }
    const sums = runningSums(mask);
    const halves = found.filter((occurrence) => hiddenInPart(occurrence, sums));
    if (halves.length === 0) break;
    if (round < RETRIES) {
      for (const occurrence of halves) taken.add(occurrence.from);
      continue;
    }
    // Still in part: each goes with the rest of its path, until none is left so.
    for (let left = halves; left.length > 0;) {
      for (const occurrence of left) mask.fill(1, occurrence.from, Math.max(occurrence.to, occurrence.rest));
      const next = runningSums(mask);
      left = found.filter((occurrence) => hiddenInPart(occurrence, next));
    }
    break;
  }
  let end = source.length;
  if (cut) {
    end = MESSAGE_KEPT;
    // A hidden part the cut would split goes whole; a private folder it would split goes too: none is hidden in part
    // any more, so one the cut splits is left as it is.
    while (end < source.length && mask[end - 1] === 1 && mask[end] === 1) end += 1;
    for (let moved = true; moved;) {
      moved = false;
      for (const occurrence of found) {
        if (occurrence.from < end && occurrence.to > end) { end = occurrence.from; moved = true; }
      }
    }
  }
  let result = "";
  for (let index = 0; index < end;) {
    let next = index;
    while (next < end && (mask[next] === 1) === (mask[index] === 1)) next += 1;
    result += mask[index] === 1 ? PATH_HIDDEN : source.slice(index, next);
    index = next;
  }
  return result;
}
