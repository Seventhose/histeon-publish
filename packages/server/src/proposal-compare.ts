import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { PAGE_SURVEY_SCRIPT, readPageSurvey, surveyDifferences, type SurveyDifferences } from "@histos-publish/cms";
import { keptPageAddress, type KeptProposalPage } from "./proposal-store.js";

/**
 * «Uguale alla proposta»: the captured pages a project keeps (proposal-store.ts) photographed beside the site built
 * from them, at a desktop and a phone width, and the pixels that differ counted. Two numbers for each page and width:
 * «con i token» (the project's latest version, written with Histeon's tokens) and «senza» (the same capture converted
 * without a framework and built in a throwaway folder). The gap between the two is what the tokens moved: it is
 * explained, never corrected, and the verdict «pronto / non pronto» does not read these numbers.
 *
 * The browser is the caller's (OpenPagePhotos: a hidden window of the desktop app). The three sites are untrusted:
 * each is served here on a port of its own, read-only, with a policy that runs no script of the page (STILL_POLICY).
 * What the browser measures, it measures in a world of its own.
 */

/** The widths photographed: a desktop and a phone, as the bench that measured the importer. */
export const COMPARE_WIDTHS = [1280, 390] as const;
/** Two pixels are the same when their three colours differ by this much in all, at most (the bench's tolerance). */
export const COMPARE_TOLERANCE = 48;
/** A photograph stops here: a longer page is compared on its first 9,000 pixels (the bench: 10 tiles of 900). */
export const COMPARE_MAX_HEIGHT = 9000;
const PHOTO_TIMEOUT_MS = 45_000;
const COMPARE_TIMEOUT_MS = 12 * 60_000;

/** A page as the browser painted it: four bytes a pixel, the colours first and the opacity last. */
export interface PagePhoto {
  width: number;
  height: number;
  data: Uint8Array;
  /** What `expression` gave, when one was asked. */
  value?: unknown;
}

export interface PagePhotoInput {
  url: string;
  width: number;
  /** Evaluated in a world apart from the page's scripts once the page is still; a promise is awaited. */
  expression?: string;
  signal: AbortSignal;
}

export interface PagePhotos {
  photograph(input: PagePhotoInput): Promise<PagePhoto>;
  close(): Promise<void>;
}

/**
 * Opens the browser for one comparison. Pages are opened only on `origins` (servers of 127.0.0.1 started here); the
 * only other requests it lets through are images, style sheets, fonts and media over https, which a captured
 * proposal takes from other sites exactly as it did in the frame the person browsed it in. No script of a page runs.
 */
export type OpenPagePhotos = (input: { origins: readonly string[]; signal: AbortSignal }) => Promise<PagePhotos>;

export interface ProposalPixelCount {
  differentPixels: number;
  totalPixels: number;
  /** Why the pixels differ, property by property; absent when the pages could not be surveyed. */
  causes?: SurveyDifferences;
}

export interface ProposalCompareWidth {
  width: number;
  /** null: not measured (the page is not in that site, or the photograph failed). */
  withTokens: ProposalPixelCount | null;
  withoutTokens: ProposalPixelCount | null;
}

export interface ProposalComparePage {
  name: string;
  /** The page's address in the site: `/`, `/menu/`. */
  path: string;
  /** Whether each site has the page at that address. */
  found: { withTokens: boolean; withoutTokens: boolean };
  widths: ProposalCompareWidth[];
}

export interface ProposalCompareResult {
  schemaVersion: 1;
  checkedAt: string;
  /** When the version it compared («con i token») was built. */
  buildAt: string;
  pages: ProposalComparePage[];
  /** What could not be done, in words for the person. */
  notes: string[];
}

/**
 * Pixels that differ between two photographs. A pixel is the same when the three colours differ by `tolerance` in all
 * at most (antialiasing, a font rendered a hair apart). Every pixel of the larger area the smaller photograph lacks
 * counts as different: a page that grew or shrank never passes.
 */
export function differentPixels(left: Pick<PagePhoto, "width" | "height" | "data">, right: Pick<PagePhoto, "width" | "height" | "data">, tolerance = COMPARE_TOLERANCE): { differentPixels: number; totalPixels: number } {
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const commonWidth = Math.min(left.width, right.width);
  const commonHeight = Math.min(left.height, right.height);
  const a = left.data;
  const b = right.data;
  let same = 0;
  for (let y = 0; y < commonHeight; y++) {
    let i = y * left.width * 4;
    let j = y * right.width * 4;
    for (let x = 0; x < commonWidth; x++, i += 4, j += 4) {
      if (Math.abs((a[i] ?? 0) - (b[j] ?? 0)) + Math.abs((a[i + 1] ?? 0) - (b[j + 1] ?? 0)) + Math.abs((a[i + 2] ?? 0) - (b[j + 2] ?? 0)) <= tolerance) same += 1;
    }
  }
  return { differentPixels: width * height - same, totalPixels: width * height };
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".jxl": "image/jxl", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm", ".vtt": "text/vtt; charset=utf-8",
};

/**
 * The policy of a site served still: no script at all (not the page's, not a handler in an attribute), no
 * connection, no form, no plugin, no page inside; images, style sheets, fonts and media of the site itself and over
 * https. `sealed` adds the sandbox for a page shown in a frame of the app (`ancestors`: who may frame it); the hidden
 * window of the comparison is not sandboxed by the page, because its own measuring runs beside the page.
 */
export function stillPolicy(options: { ancestors?: readonly string[]; sealed?: boolean } = {}): string {
  const ancestors = options.ancestors?.length ? options.ancestors.join(" ") : "'none'";
  return `default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline' https: data:; img-src 'self' https: data: blob:; font-src 'self' https: data:; media-src 'self' https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}${options.sealed ? "; sandbox" : ""}`;
}

/**
 * A file of the static site in `root` at `pathname` (decoded, from the site's root), as a static host serves it: a
 * folder through its index.html, `/a` as `a.html`. Nothing hidden, nothing outside the folder. `redirect`: a folder
 * asked without its final slash.
 */
export async function stillFile(root: string, pathname: string): Promise<{ absolute: string; size: number; type: string } | { redirect: true } | null> {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) return null;
  const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const segments = relative.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment.startsWith(".") || segment === "..")) return null;
  const boundary = `${path.resolve(root)}${path.sep}`;
  let absolute = path.resolve(root, ...segments);
  if (!absolute.startsWith(boundary)) return null;
  let info = await stat(absolute).catch(() => null);
  if (!info && !path.extname(absolute)) {
    const page = await stat(`${absolute}.html`).catch(() => null);
    if (page?.isFile()) { absolute = `${absolute}.html`; info = page; }
  }
  if (info?.isDirectory()) return { redirect: true };
  if (!info?.isFile()) return null;
  return { absolute, size: info.size, type: TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream" };
}

/**
 * Answers a GET or HEAD for `pathname` of the still site in `root`; false when there is nothing to serve (the caller
 * answers 404). `prefix` is what the site's root is called in the address, for the redirect of a folder.
 */
export async function sendStill(request: IncomingMessage, response: ServerResponse, root: string, pathname: string, policy: string, prefix = ""): Promise<boolean> {
  const file = await stillFile(root, pathname);
  if (!file) return false;
  if ("redirect" in file) {
    response.writeHead(308, { Location: `${prefix}${pathname.split("/").map(encodeURIComponent).join("/")}/`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end();
    return true;
  }
  const headers: Record<string, string> = { "Content-Type": file.type, "Content-Length": String(file.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (file.type.startsWith("text/html") || file.type === "image/svg+xml") headers["Content-Security-Policy"] = policy;
  // A sandboxed page has an opaque origin and fonts load in CORS mode: without this they never apply.
  if (file.type.startsWith("font/")) headers["Access-Control-Allow-Origin"] = "*";
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else await pipeline(createReadStream(file.absolute), response).catch(() => undefined);
  return true;
}

/** The still site in `root` on a port of its own of 127.0.0.1, for the time of a comparison. */
async function serveStill(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  let host = "";
  const policy = stillPolicy();
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const missing = () => { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Non trovato."); };
    if ((request.method !== "GET" && request.method !== "HEAD") || request.headers.host !== host) return missing();
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname); } catch { return missing(); }
    if (!(await sendStill(request, response, root, pathname, policy))) missing();
  };
  const server = createServer((request, response) => { answer(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  host = `127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`;
  return { origin: `http://${host}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function validPhoto(photo: PagePhoto): boolean {
  return Number.isSafeInteger(photo.width) && Number.isSafeInteger(photo.height) && photo.width > 0 && photo.height > 0 && photo.height <= COMPARE_MAX_HEIGHT * 4 && photo.data.byteLength === photo.width * photo.height * 4;
}

/**
 * Photographs each kept page in the three sites and counts. `withTokens` and `withoutTokens` are the folders of the
 * two built sites, or null when one is not there (said by the caller's notes). A photograph that fails leaves its
 * number out and is a note; only a cancellation of `signal` throws.
 */
export async function compareProposal(input: {
  pages: readonly KeptProposalPage[];
  original: string;
  withTokens: string | null;
  withoutTokens: string | null;
  openPhotos: OpenPagePhotos;
  signal?: AbortSignal;
  widths?: readonly number[];
  timeoutMs?: number;
}): Promise<{ pages: ProposalComparePage[]; notes: string[] }> {
  const widths = input.widths ?? COMPARE_WIDTHS;
  const notes: string[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, input.timeoutMs ?? COMPARE_TIMEOUT_MS);
  const sides = [["withTokens", input.withTokens], ["withoutTokens", input.withoutTokens]] as const;
  const servers: Array<{ origin: string; close(): Promise<void> }> = [];
  let photos: PagePhotos | undefined;
  try {
    const original = await serveStill(input.original);
    servers.push(original);
    const built: Record<"withTokens" | "withoutTokens", { origin: string; root: string } | null> = { withTokens: null, withoutTokens: null };
    for (const [side, root] of sides) {
      if (!root) continue;
      const served = await serveStill(root);
      servers.push(served);
      built[side] = { origin: served.origin, root };
    }
    photos = await input.openPhotos({ origins: servers.map((server) => server.origin), signal: controller.signal });
    const browser = photos;
    const photograph = async (url: string, width: number): Promise<PagePhoto | null> => {
      const one = new AbortController();
      const stop = () => one.abort();
      controller.signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, PHOTO_TIMEOUT_MS);
      try {
        const photo = await Promise.race([
          browser.photograph({ url, width, expression: PAGE_SURVEY_EXPRESSION, signal: one.signal }),
          new Promise<never>((_resolve, reject) => one.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
        ]);
        return validPhoto(photo) ? photo : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", stop);
      }
    };
    const pages: ProposalComparePage[] = [];
    let failed = 0;
    for (const page of input.pages) {
      const address = keptPageAddress(page);
      const encoded = address.split("/").map(encodeURIComponent).join("/");
      const found = { withTokens: false, withoutTokens: false };
      for (const [side] of sides) {
        const site = built[side];
        const file = site ? await stillFile(site.root, address) : null;
        found[side] = Boolean(file && !("redirect" in file));
      }
      const measured: ProposalCompareWidth[] = [];
      for (const width of widths) {
        const row: ProposalCompareWidth = { width, withTokens: null, withoutTokens: null };
        if (found.withTokens || found.withoutTokens) {
          input.signal?.throwIfAborted();
          const before = controller.signal.aborted ? null : await photograph(`${original.origin}${encoded}`, width);
          if (!before) failed += 1;
          for (const [side] of sides) {
            const site = built[side];
            if (!before || !site || !found[side]) continue;
            input.signal?.throwIfAborted();
            const after = controller.signal.aborted ? null : await photograph(`${site.origin}${encoded}`, width);
            if (!after) { failed += 1; continue; }
            const count: ProposalPixelCount = differentPixels(before, after);
            const left = readPageSurvey(before.value);
            const right = readPageSurvey(after.value);
            if (left && right && count.differentPixels > 0) count.causes = surveyDifferences(left, right);
            row[side] = count;
          }
        }
        measured.push(row);
      }
      pages.push({ name: page.name, path: address, found, widths: measured });
    }
    input.signal?.throwIfAborted();
    if (controller.signal.aborted) notes.push("Il confronto si è fermato per il tempo: i numeri che mancano non sono stati misurati.");
    else if (failed) notes.push(`${failed} ${failed === 1 ? "fotografia non è riuscita" : "fotografie non sono riuscite"}: i numeri che mancano non sono stati misurati.`);
    return { pages, notes };
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", abort);
    await photos?.close().catch(() => undefined);
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  }
}

/** The survey as the browser receives it: PAGE_SURVEY_SCRIPT called on the page's own document. */
const PAGE_SURVEY_EXPRESSION = `(${PAGE_SURVEY_SCRIPT})({})`;

const COMPARE_FILE = "compare.json";

function countOf(value: unknown): ProposalPixelCount | null {
  if (typeof value !== "object" || value === null) return null;
  const count = value as Record<string, unknown>;
  if (!Number.isSafeInteger(count.differentPixels) || !Number.isSafeInteger(count.totalPixels) || (count.totalPixels as number) < 1 || (count.differentPixels as number) < 0 || (count.differentPixels as number) > (count.totalPixels as number)) return null;
  const causes = typeof count.causes === "object" && count.causes !== null ? count.causes as SurveyDifferences : undefined;
  return { differentPixels: count.differentPixels as number, totalPixels: count.totalPixels as number, ...(causes && Array.isArray(causes.properties) ? { causes } : {}) };
}

/** The last comparison saved in the project's `proposal/` folder, or null (none, or one that does not read). */
export async function readProposalCompare(proposalFolder: string): Promise<ProposalCompareResult | null> {
  try {
    const saved = JSON.parse(await readFile(path.join(proposalFolder, COMPARE_FILE), "utf8")) as Partial<ProposalCompareResult>;
    if (saved.schemaVersion !== 1 || typeof saved.checkedAt !== "string" || typeof saved.buildAt !== "string" || !Array.isArray(saved.pages)) return null;
    const pages: ProposalComparePage[] = [];
    for (const page of saved.pages.slice(0, 20)) {
      if (typeof page?.name !== "string" || typeof page.path !== "string" || !Array.isArray(page.widths)) return null;
      pages.push({
        name: page.name.slice(0, 80),
        path: page.path.slice(0, 300),
        found: { withTokens: page.found?.withTokens === true, withoutTokens: page.found?.withoutTokens === true },
        widths: page.widths.slice(0, 4).filter((row) => Number.isSafeInteger(row?.width)).map((row) => ({ width: row.width, withTokens: countOf(row.withTokens), withoutTokens: countOf(row.withoutTokens) })),
      });
    }
    return { schemaVersion: 1, checkedAt: saved.checkedAt.slice(0, 40), buildAt: saved.buildAt.slice(0, 40), pages, notes: Array.isArray(saved.notes) ? saved.notes.filter((note): note is string => typeof note === "string").slice(0, 10).map((note) => note.slice(0, 400)) : [] };
  } catch {
    return null;
  }
}

/** Saves the comparison beside the capture it measured: written beside and moved in place. */
export async function saveProposalCompare(proposalFolder: string, result: ProposalCompareResult): Promise<void> {
  const temporary = path.join(proposalFolder, `.compare-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    await rename(temporary, path.join(proposalFolder, COMPARE_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Where the capture origin shows a kept original, still: `/__original/<ticket>/<page>`. */
export const PROPOSAL_ORIGINAL_PREFIX = "/__original/";
const ORIGINAL_TICKET = /^[A-Za-z0-9_-]{32}$/u;
const ORIGINALS_KEPT = 8;
const ORIGINAL_TTL_MS = 5 * 60 * 1000;

/**
 * The kept originals open for the side-by-side view: a ticket names the folder of a captured site. In memory; a
 * ticket lapses five minutes after its last file, like a preview's.
 */
export class ProposalOriginals {
  private readonly tickets = new Map<string, { root: string; expiresAt: number }>();

  open(siteDirectory: string, now = Date.now()): string {
    for (const [ticket, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(ticket);
    while (this.tickets.size >= ORIGINALS_KEPT) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { root: siteDirectory, expiresAt: now + ORIGINAL_TTL_MS });
    return ticket;
  }

  /** The site and the path inside it an address names, or null. */
  resolve(pathname: string, now = Date.now()): { root: string; ticket: string; pathname: string } | null {
    if (!pathname.startsWith(PROPOSAL_ORIGINAL_PREFIX)) return null;
    const rest = pathname.slice(PROPOSAL_ORIGINAL_PREFIX.length);
    const slash = rest.indexOf("/");
    const ticket = slash < 0 ? rest : rest.slice(0, slash);
    if (slash < 0 || !ORIGINAL_TICKET.test(ticket)) return null;
    const entry = this.tickets.get(ticket);
    if (!entry || entry.expiresAt < now) {
      this.tickets.delete(ticket);
      return null;
    }
    entry.expiresAt = now + ORIGINAL_TTL_MS;
    return { root: entry.root, ticket, pathname: rest.slice(slash) };
  }

  clear(): void {
    this.tickets.clear();
  }
}
