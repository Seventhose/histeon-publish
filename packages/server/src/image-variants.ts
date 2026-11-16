import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { inflateSync } from "node:zlib";
import { IMAGE_VARIANT_MAX_PIXELS, imageVariantWidths, inspectImageForVariants, pictureImages, PICTURE_SKIP_TEXT, wrapPictures, type CmsImageSettings, type ImageVariantSource, type PictureSource, type PictureSourceType } from "@histos-publish/cms";
import type { ImageWorkerData, ImageWorkerJob, ImageWorkerResult, VariantFormat } from "./image-worker.js";

/**
 * Modern image variants of a static build (queue B6). After the pages are written, every `<img>` of the build's media
 * that can become a `<picture>` without changing the page (picture-markup.ts) gets JPEG XL, AVIF and WebP files at a
 * few widths, encoded in worker threads (image-worker.ts) and kept in a cache by the file's content and the settings,
 * so a rebuild encodes nothing that did not change. Variants are an optimization: an image that cannot have them
 * (its header, a limit, the time, the bundle's room) keeps its `src` and the summary says why; the build never fails
 * for them.
 */

/** The jSquash packages the cache was made with: a cache entry of other versions is never reused. */
export const IMAGE_CODEC_VERSIONS = "avif 2.1.1, jxl 1.3.0, webp 1.5.0, jpeg 1.6.0, png 3.1.1, resize 2.1.1; options 1";

export interface ImageVariantLimits {
  /** Bytes of a file the encoder takes at most. */
  maxFileBytes: number;
  /** Pixels a file may have before it is decoded (a decompression bomb is refused here). */
  maxPixels: number;
  /** Time for one image, decoding and every variant: the worker is ended past it. */
  jobTimeoutMs: number;
  /** WebAssembly memory of one worker's codecs together. */
  maxWasmBytes: number;
  /** Workers at once, in the whole process. */
  concurrency: number;
}

export const IMAGE_VARIANT_LIMITS: Readonly<ImageVariantLimits> = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxPixels: IMAGE_VARIANT_MAX_PIXELS,
  jobTimeoutMs: 60_000,
  maxWasmBytes: 1024 * 1024 * 1024,
  concurrency: Math.max(1, Math.min(4, os.availableParallelism() - 1, Math.floor(os.totalmem() / (3 * 1024 * 1024 * 1024)))),
});

/** The worker's file: next to this module once built (dist, or the desktop bundle), the built copy from the sources. */
function workerUrl(): URL {
  const sibling = new URL("./image-worker.js", import.meta.url);
  return existsSync(fileURLToPath(sibling)) ? sibling : new URL("../dist/image-worker.js", import.meta.url);
}

/** The desktop bundle keeps the .wasm files in image-codecs/ next to the worker; elsewhere the packages have them. */
function codecDirectory(url: URL): string | undefined {
  const folder = fileURLToPath(new URL("./image-codecs/", url));
  return existsSync(folder) ? folder : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Workers.

/** Workers running in the process, and the jobs waiting for one: a finished job hands its place to the first. */
let running = 0;
const waiting: Array<() => void> = [];

async function slot(concurrency: number, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (running < concurrency) running++;
  else {
    await new Promise<void>((resolve, reject) => {
      const take = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        const index = waiting.indexOf(take);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Codifica annullata."));
      };
      waiting.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
}

/**
 * Encodes one image in a worker of its own, within the limits; the worker ends with the job, or at `timeoutMs`, or
 * when `signal` aborts. Never throws for the image: a failure is `{ ok: false, error }` (timeout: true when the time
 * ran out, so that the cache does not keep it).
 */
export async function encodeImageInWorker(job: ImageWorkerJob, options: { limits?: Partial<ImageVariantLimits>; timeoutMs?: number; signal?: AbortSignal; url?: URL } = {}): Promise<ImageWorkerResult & { timeout?: true }> {
  const limits = { ...IMAGE_VARIANT_LIMITS, ...options.limits };
  const signal = options.signal ?? new AbortController().signal;
  if (job.bytes.length > limits.maxFileBytes) return { ok: false, error: `oltre ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB` };
  if (job.width * job.height > limits.maxPixels) return { ok: false, error: `oltre ${Math.round(limits.maxPixels / 1_000_000)} megapixel: non si decodifica` };
  const release = await slot(limits.concurrency, signal);
  try {
    const url = options.url ?? workerUrl();
    const directory = codecDirectory(url);
    const data: ImageWorkerData = { job, maxWasmBytes: limits.maxWasmBytes, ...(directory ? { codecDirectory: directory } : {}) };
    const worker = new Worker(url, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 }, stdout: true, stderr: true });
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise<ImageWorkerResult & { timeout?: true }>((resolve) => {
      let settled = false;
      const finish = (result: ImageWorkerResult & { timeout?: true }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        void worker.terminate();
        resolve(result);
      };
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? limits.jobTimeoutMs, limits.jobTimeoutMs));
      const timer = setTimeout(() => finish({ ok: false, error: `oltre ${Math.ceil(timeoutMs / 1000)} secondi`, timeout: true }), timeoutMs);
      const abort = () => finish({ ok: false, error: "annullato", timeout: true });
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: ImageWorkerResult) => finish(message));
      worker.once("error", (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish({ ok: false, error: /memory/iu.test(message) ? "memoria del codificatore esaurita" : `errore del codificatore: ${message.slice(0, 200)}` });
      });
      worker.once("exit", (code) => finish({ ok: false, error: `il codificatore si è fermato (${code})` }));
    });
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cache.

const EXTENSIONS: Record<VariantFormat, string> = { jxl: "jxl", avif: "avif", webp: "webp" };
const TYPES: Record<VariantFormat, PictureSourceType> = { jxl: "image/jxl", avif: "image/avif", webp: "image/webp" };
/** The order of the `<source>` elements: a browser takes the first it can show. */
const SOURCE_ORDER: VariantFormat[] = ["jxl", "avif", "webp"];

interface CachedFile {
  format: VariantFormat;
  width: number;
  height: number;
  sha256: string;
  bytes: number;
}

type CachedResult = { ok: true; files: CachedFile[] } | { ok: false; error: string };

/** The default size of the cache: past it, the entries used least recently go. */
export const IMAGE_VARIANT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Encoded variants by the source file's SHA-256 and everything that shapes them (widths, formats, qualities, codec
 * versions): `<key>/entry.json` and the files `<sha256>.<ext>`, written to a private folder and renamed into place, so
 * a build never reads half an entry. A failure that would repeat (a file the decoder refuses) is kept too; a timeout is
 * not.
 */
export class ImageVariantCache {
  constructor(readonly directory: string, private readonly maxBytes = IMAGE_VARIANT_CACHE_MAX_BYTES) {}

  static key(input: { sourceSha256: string; widths: number[]; formats: VariantFormat[]; quality: CmsImageSettings["quality"]; lossless: boolean; orientation: number }): string {
    return createHash("sha256").update(JSON.stringify({ codecs: IMAGE_CODEC_VERSIONS, ...input })).digest("hex");
  }

  private folder(key: string): string {
    if (!/^[0-9a-f]{64}$/u.test(key)) throw new TypeError("Chiave della cache non valida.");
    return path.join(this.directory, key.slice(0, 2), key);
  }

  async get(key: string): Promise<CachedResult | null> {
    const folder = this.folder(key);
    let entry: CachedResult;
    try { entry = JSON.parse(await readFile(path.join(folder, "entry.json"), "utf8")) as CachedResult; }
    catch { return null; }
    if (!entry || typeof entry !== "object" || (entry.ok && !Array.isArray(entry.files))) return null;
    if (entry.ok) {
      for (const file of entry.files) {
        if (!/^[0-9a-f]{64}$/u.test(file.sha256) || !(file.format in EXTENSIONS)) return null;
        const size = await stat(path.join(folder, `${file.sha256}.${EXTENSIONS[file.format]}`)).then((info) => info.size, () => -1);
        if (size !== file.bytes) return null;
      }
    }
    const now = new Date();
    await utimes(path.join(folder, "entry.json"), now, now).catch(() => undefined);
    return entry;
  }

  filePath(key: string, file: CachedFile): string {
    return path.join(this.folder(key), `${file.sha256}.${EXTENSIONS[file.format]}`);
  }

  async put(key: string, result: CachedResult, bytes: Map<string, Uint8Array>): Promise<void> {
    const folder = this.folder(key);
    const staging = path.join(this.directory, `.staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      if (result.ok) for (const file of result.files) await writeFile(path.join(staging, `${file.sha256}.${EXTENSIONS[file.format]}`), bytes.get(file.sha256) as Uint8Array, { mode: 0o600 });
      await writeFile(path.join(staging, "entry.json"), JSON.stringify(result), { mode: 0o600 });
      await mkdir(path.dirname(folder), { recursive: true, mode: 0o700 });
      await rm(folder, { recursive: true, force: true });
      await rename(staging, folder);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // Another build put the same entry first: the same bytes.
      if (existsSync(path.join(folder, "entry.json"))) return;
      throw error;
    }
  }

  /** Removes the entries used least recently until the cache is under its size, and leftovers of a stopped write. */
  async prune(): Promise<void> {
    const entries: Array<{ folder: string; used: number; bytes: number }> = [];
    let total = 0;
    for (const prefix of await readdir(this.directory).catch(() => [] as string[])) {
      const parent = path.join(this.directory, prefix);
      if (prefix.startsWith(".staging-")) {
        const age = Date.now() - (await stat(parent).then((info) => info.mtimeMs, () => Date.now()));
        if (age > 60 * 60 * 1000) await rm(parent, { recursive: true, force: true });
        continue;
      }
      if (!/^[0-9a-f]{2}$/u.test(prefix)) continue;
      for (const key of await readdir(parent).catch(() => [] as string[])) {
        const folder = path.join(parent, key);
        let bytes = 0;
        for (const name of await readdir(folder).catch(() => [] as string[])) bytes += await stat(path.join(folder, name)).then((info) => info.size, () => 0);
        const used = await stat(path.join(folder, "entry.json")).then((info) => info.mtimeMs, () => 0);
        entries.push({ folder, used, bytes });
        total += bytes;
      }
    }
    if (total <= this.maxBytes) return;
    for (const entry of entries.sort((left, right) => left.used - right.used)) {
      if (total <= this.maxBytes * 0.8) break;
      await rm(entry.folder, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The build's step.

/** What the build did with its images, for its findings, the check and the report. */
export interface ImageVariantSummary {
  enabled: boolean;
  /** Distinct media files that got variants, and the `<img>` that became a `<picture>`. */
  images: number;
  pictures: number;
  /** Bytes of those files as they are, and of the smallest full-width variant of each (what a modern browser gets). */
  originalBytes: number;
  variantBytes: number;
  /** Files and bytes added to the build. */
  files: number;
  addedBytes: number;
  /** Images per format kept in their `<picture>`. */
  formats: Record<VariantFormat, number>;
  /** Why an image kept only its `src`: the reason, how many uses, a few of the files. */
  skipped: Array<{ reason: string; count: number; examples: string[] }>;
  cached: number;
  encoded: number;
  milliseconds: number;
}

export function emptyImageVariantSummary(enabled: boolean): ImageVariantSummary {
  return { enabled, images: 0, pictures: 0, originalBytes: 0, variantBytes: 0, files: 0, addedBytes: 0, formats: { jxl: 0, avif: 0, webp: 0 }, skipped: [], cached: 0, encoded: 0, milliseconds: 0 };
}

const kib = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The summary in one sentence, for the build's findings and the check's warnings; null when there is nothing to say. */
export function imageVariantSentence(summary: ImageVariantSummary): string | null {
  if (!summary.enabled) return null;
  const parts: string[] = [];
  if (summary.images > 0) {
    const saved = summary.originalBytes > 0 ? Math.round((1 - summary.variantBytes / summary.originalBytes) * 100) : 0;
    const formats = SOURCE_ORDER.filter((format) => summary.formats[format] > 0).map((format) => `${format === "jxl" ? "JPEG XL" : format.toUpperCase()} ${summary.formats[format]}`).join(", ");
    parts.push(`Immagini moderne: ${summary.images} ${summary.images === 1 ? "immagine ha" : "immagini hanno"} le varianti (${summary.pictures} <picture>; ${formats}). A piena larghezza un browser recente scarica ${kib(summary.variantBytes)} invece di ${kib(summary.originalBytes)} (−${saved}%), meno sugli schermi piccoli; la build aggiunge ${summary.files} file, ${kib(summary.addedBytes)}.`);
  }
  if (summary.skipped.length) {
    const total = summary.skipped.reduce((sum, item) => sum + item.count, 0);
    parts.push(`${summary.images > 0 ? "Restano" : "Immagini moderne: restano"} col solo src ${total} ${total === 1 ? "immagine" : "immagini"}: ${summary.skipped.slice(0, 6).map((item) => `${item.count} ${item.reason} (${item.examples.slice(0, 2).join(", ")})`).join("; ")}.`);
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * The sources an image keeps, in the order browsers try them: from the last to the first, each must be smaller at full
 * width than the original and than every source kept after it. The qualities give the formats one visual quality
 * (CMS_IMAGE_SETTINGS_DEFAULTS), and every browser that shows JPEG XL shows AVIF and WebP too, so a heavier source
 * listed first would only make those browsers download more.
 */
function keptSources(files: CachedFile[], originalBytes: number): Array<{ format: VariantFormat; files: CachedFile[] }> {
  const kept: Array<{ format: VariantFormat; files: CachedFile[] }> = [];
  let smallest = originalBytes;
  for (const format of [...SOURCE_ORDER].reverse()) {
    const own = files.filter((file) => file.format === format).sort((left, right) => left.width - right.width);
    const top = own.at(-1);
    if (!top || top.bytes >= smallest) continue;
    smallest = top.bytes;
    kept.unshift({ format, files: own });
  }
  return kept;
}

/** The job and cache key of an image for these settings: the same as the build's (writeImageVariants). */
function variantPlan(source: ImageVariantSource, sha256: string, settings: CmsImageSettings): { widths: number[]; formats: VariantFormat[]; key: string } {
  const shown = source.orientation >= 5 ? { width: source.height, height: source.width } : { width: source.width, height: source.height };
  const widths = imageVariantWidths(shown.width, shown.height, settings);
  const formats: VariantFormat[] = source.lossless ? ["jxl", "webp"] : ["jxl", "avif", "webp"];
  return { widths, formats, key: ImageVariantCache.key({ sourceSha256: sha256, widths, formats, quality: settings.quality, lossless: source.lossless, orientation: source.orientation }) };
}

/**
 * What the cache already knows of the import's candidates (PrototypeImageCandidate): how many were measured (by the
 * check's preview build, or an earlier build), and their bytes at full width before and after. Nothing is encoded.
 */
export async function cachedImageSavings(candidates: ReadonlyArray<{ sha256: string; bytes: number; source: ImageVariantSource }>, settings: CmsImageSettings, cacheDirectory: string | null): Promise<{ measured: number; originalBytes: number; variantBytes: number }> {
  const result = { measured: 0, originalBytes: 0, variantBytes: 0 };
  if (!cacheDirectory || !settings.variants) return result;
  const cache = new ImageVariantCache(cacheDirectory);
  for (const candidate of candidates) {
    const entry = await cache.get(variantPlan(candidate.source, candidate.sha256, settings).key);
    if (!entry?.ok) continue;
    const kept = keptSources(entry.files, candidate.bytes);
    if (!kept.length) continue;
    result.measured++;
    result.originalBytes += candidate.bytes;
    result.variantBytes += Math.min(...kept.map((source) => (source.files.at(-1) as CachedFile).bytes));
  }
  return result;
}

/** The import's note with what the cache measured: the savings, when every candidate has been measured. */
export function measuredImageNote(note: string, files: number, savings: { measured: number; originalBytes: number; variantBytes: number }): string {
  if (!savings.measured || savings.originalBytes <= 0) return note;
  const percent = Math.round((1 - savings.variantBytes / savings.originalBytes) * 100);
  const measured = `${savings.measured === files ? "misurato" : `misurato su ${savings.measured} file di ${files}`}: a piena larghezza un browser recente scarica ${kib(savings.variantBytes)} invece di ${kib(savings.originalBytes)} (−${percent}%).`;
  return note.replace("il risparmio si misura alla versione.", measured);
}

const MEDIA_FILE = /^\/media\/([0-9a-f]{64})\.(jpg|png|webp|avif)$/u;

async function htmlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".html")) found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

function inflateProfile(data: Uint8Array): Uint8Array | null {
  try { return inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 }); }
  catch { return null; }
}

interface Planned {
  src: string;
  /** The media file, read again when its turn comes: a site's images are never all in memory at once. */
  file: string;
  sha256: string;
  originalBytes: number;
  key: string;
  job: Omit<ImageWorkerJob, "bytes">;
  result?: CachedResult;
  fromCache?: boolean;
  /** Why the encoder had no time for it. */
  timedOut?: string;
  /** The kept sources and their files. */
  sources?: Array<{ format: VariantFormat; files: CachedFile[] }>;
}

/**
 * Makes the variants of a written build in `staticRoot` (pages and `media/`): finds the images that can have them
 * (pictureImages), encodes what the cache does not have until `deadline`, keeps per image only the formats whose
 * full-width file is smaller than the original and than every format after it (a browser takes the first it shows, and
 * the browsers that show JPEG XL show AVIF and WebP too), within `room` (bytes and files the bundle still takes),
 * copies the files into `media/` and rewrites the pages. `signal` stops it as a cancelled build.
 */
export async function writeImageVariants(input: {
  staticRoot: string;
  settings: CmsImageSettings;
  cacheDirectory: string | null;
  deadline: number;
  signal: AbortSignal;
  room: { bytes: number; files: number };
  limits?: Partial<ImageVariantLimits>;
}): Promise<ImageVariantSummary> {
  const started = Date.now();
  const summary = emptyImageVariantSummary(input.settings.variants);
  if (!input.settings.variants) return summary;
  const limits = { ...IMAGE_VARIANT_LIMITS, ...input.limits };
  const skipped = new Map<string, { count: number; examples: Set<string> }>();
  const skip = (reason: string, src: string, count = 1) => {
    const item = skipped.get(reason) ?? { count: 0, examples: new Set<string>() };
    item.count += count;
    if (item.examples.size < 3) item.examples.add(src.replace(/^\/media\//u, "").slice(0, 16) + (src.length > 23 ? "…" : ""));
    skipped.set(reason, item);
  };
  const uses = new Map<string, number>();
  const pages: string[] = [];
  for (const file of await htmlFiles(input.staticRoot)) {
    input.signal.throwIfAborted();
    const html = await readFile(file, "utf8");
    if (!html.includes("/media/")) continue;
    const page = pictureImages(html);
    for (const item of page.skipped) skip(item.reason === "css" ? `${PICTURE_SKIP_TEXT.css}${item.detail ? ` (${item.detail.slice(0, 80)})` : ""}` : PICTURE_SKIP_TEXT[item.reason], item.src);
    if (!page.images.length) continue;
    pages.push(file);
    for (const image of page.images) uses.set(image.src, (uses.get(image.src) ?? 0) + 1);
  }
  const cache = input.cacheDirectory ? new ImageVariantCache(input.cacheDirectory) : null;
  const planned: Planned[] = [];
  for (const [src, count] of uses) {
    const match = MEDIA_FILE.exec(src) as RegExpExecArray;
    const file = path.join(input.staticRoot, "media", `${match[1]}.${match[2]}`);
    const bytes = await readFile(file).catch(() => null);
    if (!bytes) {
      skip("file assente dalla build", src, count);
      continue;
    }
    if (bytes.length > limits.maxFileBytes) {
      skip(`oltre ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB`, src, count);
      continue;
    }
    const source = inspectImageForVariants(bytes, inflateProfile, limits.maxPixels);
    if (typeof source === "string") {
      skip(source, src, count);
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { widths, formats, key } = variantPlan(source, sha256, input.settings);
    const job = { format: source.format, width: source.width, height: source.height, orientation: source.orientation, lossless: source.lossless, widths, formats, quality: input.settings.quality };
    planned.push({ src, file, sha256, originalBytes: bytes.length, key, job });
  }
  // The cache first, then the encoder for the rest, as many at once as the limits take, until the deadline.
  const encoded = new Map<string, Map<string, Uint8Array>>();
  for (const item of planned) {
    const hit = cache ? await cache.get(item.key) : null;
    if (hit) {
      item.result = hit;
      item.fromCache = true;
    }
  }
  const queue = planned.filter((item) => !item.result);
  const encode = async (item: Planned): Promise<void> => {
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) return;
    const bytes = await readFile(item.file);
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
      item.result = { ok: false, error: "il file è cambiato durante la versione" };
      return;
    }
    const result = await encodeImageInWorker({ ...item.job, bytes }, { limits, timeoutMs: remaining, signal: input.signal });
    input.signal.throwIfAborted();
    if (!result.ok) {
      if (result.timeout) {
        item.timedOut = result.error;
        return;
      }
      item.result = { ok: false, error: result.error };
      await cache?.put(item.key, item.result, new Map()).catch(() => undefined);
      return;
    }
    const files = new Map<string, Uint8Array>();
    const list: CachedFile[] = result.outputs.map((output) => {
      const sha256 = createHash("sha256").update(output.bytes).digest("hex");
      files.set(sha256, output.bytes);
      return { format: output.format, width: output.width, height: output.height, sha256, bytes: output.bytes.length };
    });
    item.result = { ok: true, files: list };
    encoded.set(item.key, files);
    summary.encoded++;
    await cache?.put(item.key, item.result, files).catch(() => undefined);
  };
  // As many runners as workers: each reads its file when it starts, never before.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limits.concurrency, queue.length)) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await encode(item);
  }));
  input.signal.throwIfAborted();
  for (const item of planned) {
    if (!item.result) {
      skip(`tempo scaduto${item.timedOut && item.timedOut !== "annullato" ? ` (${item.timedOut})` : ""}: la prossima build riprende dalla cache`, item.src, uses.get(item.src));
      continue;
    }
    if (!item.result.ok) {
      skip(item.result.error, item.src, uses.get(item.src));
      continue;
    }
    if (item.fromCache) summary.cached++;
    const kept = keptSources(item.result.files, item.originalBytes);
    if (!kept.length) {
      skip("nessun formato moderno più leggero dell'originale", item.src, uses.get(item.src));
      continue;
    }
    item.sources = kept;
  }
  // The bundle's room: each image's files, and about a kilobyte of markup for each of its <picture>.
  let roomBytes = input.room.bytes;
  let roomFiles = input.room.files;
  const written = new Set<string>();
  const sourcesBySrc = new Map<string, PictureSource[]>();
  for (const item of planned) {
    if (!item.sources) continue;
    const files = item.sources.flatMap((source) => source.files).filter((file) => !written.has(file.sha256));
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0) + 1024 * (uses.get(item.src) ?? 1);
    if (bytes > roomBytes || files.length > roomFiles) {
      skip("il pacchetto della versione non ha più spazio", item.src, uses.get(item.src));
      continue;
    }
    // Every file read and checked first: one that another build removed or changed meanwhile leaves the image as it is.
    const contents: Array<{ file: CachedFile; data: Uint8Array }> = [];
    for (const file of files) {
      const data = encoded.get(item.key)?.get(file.sha256) ?? await readFile((cache as ImageVariantCache).filePath(item.key, file)).catch(() => null);
      if (!data || createHash("sha256").update(data).digest("hex") !== file.sha256) break;
      contents.push({ file, data });
    }
    if (contents.length !== files.length) {
      skip("la cache è cambiata durante la versione: la prossima versione la rifà", item.src, uses.get(item.src));
      continue;
    }
    for (const { file, data } of contents) {
      const target = path.join(input.staticRoot, "media", `${file.sha256}.${EXTENSIONS[file.format]}`);
      await writeFile(target, data, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      written.add(file.sha256);
      summary.files++;
      summary.addedBytes += file.bytes;
    }
    roomBytes -= bytes;
    roomFiles -= files.length;
    sourcesBySrc.set(item.src, item.sources.map((source) => ({ type: TYPES[source.format], candidates: source.files.map((file) => ({ url: `/media/${file.sha256}.${EXTENSIONS[file.format]}`, width: file.width })) })));
    summary.images++;
    summary.originalBytes += item.originalBytes;
    summary.variantBytes += Math.min(...item.sources.map((source) => (source.files.at(-1) as CachedFile).bytes));
    for (const source of item.sources) summary.formats[source.format]++;
  }
  for (const file of pages) {
    input.signal.throwIfAborted();
    const page = pictureImages(await readFile(file, "utf8"));
    const result = wrapPictures(page, (src) => sourcesBySrc.get(src));
    for (const item of result.skipped) skip(`${PICTURE_SKIP_TEXT.css}${item.detail ? ` (${item.detail.slice(0, 80)})` : ""}`, item.src);
    summary.pictures += result.wrapped.length;
    if (result.wrapped.length) await writeFile(file, result.html, { mode: 0o600 });
  }
  summary.skipped = [...skipped].map(([reason, item]) => ({ reason, count: item.count, examples: [...item.examples] })).sort((left, right) => right.count - left.count);
  summary.milliseconds = Date.now() - started;
  await cache?.prune().catch(() => undefined);
  return summary;
}
