/**
 * The image encoder's worker thread (queue B6): one image per worker, then the worker ends, so that every byte of its
 * WebAssembly memory goes back when it does. It decodes the file, turns it by its orientation, makes each width and
 * encodes each format with jSquash (WebAssembly builds of mozjpeg, the Rust png crate, libwebp, libavif with libaom,
 * libjxl and the Rust resize crate; licences in docs/adr/0012-codificatore-immagini.md).
 *
 * The limits that hold here, whatever the file says (image-variants.ts sets the others before a worker starts):
 * - the WebAssembly memory of the Emscripten codecs together grows to at most `maxWasmBytes`: past it a growth fails
 *   and the codec stops with an error, as it would on a full memory;
 * - the decoded size must be the size read from the header, which the main thread held to the pixel limit before
 *   anything was decoded (a decompression bomb never reaches the decoder);
 * - the main thread ends this worker at its deadline (`terminate`), and V8's heap has its own limit (resourceLimits).
 *
 * Only Node built-ins and the jSquash packages are imported: the desktop build bundles this file on its own.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import decodeAvif, { init as initAvifDecode } from "@jsquash/avif/decode.js";
import encodeAvif, { init as initAvifEncode } from "@jsquash/avif/encode.js";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJxl, { init as initJxlEncode } from "@jsquash/jxl/encode.js";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import resize, { initResize } from "@jsquash/resize/index.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";

export type VariantFormat = "jxl" | "avif" | "webp";

export interface ImageWorkerJob {
  bytes: Uint8Array;
  format: "jpeg" | "png" | "webp" | "avif";
  /** Stored size, as the header says it. */
  width: number;
  height: number;
  orientation: number;
  lossless: boolean;
  /** Widths after the orientation, smallest first; the last may be the image's own. */
  widths: number[];
  formats: VariantFormat[];
  quality: { avif: number; jxl: number; webp: number };
}

export interface ImageWorkerData {
  job: ImageWorkerJob;
  maxWasmBytes: number;
  /** Folder of the .wasm files (the desktop bundle); without it they are read from the jSquash packages. */
  codecDirectory?: string;
}

export interface ImageWorkerOutput {
  format: VariantFormat;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export type ImageWorkerResult =
  | { ok: true; outputs: ImageWorkerOutput[]; timings: { decodeMs: number; resizeMs: number; encodeMs: Record<VariantFormat, number> } }
  | { ok: false; error: string };

/** The .wasm file of each codec: its path in the package, and its flat name in the desktop bundle's folder. */
export const IMAGE_CODEC_FILES = {
  jpegDecode: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  pngDecode: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  webpDecode: "@jsquash/webp/codec/dec/webp_dec.wasm",
  avifDecode: "@jsquash/avif/codec/dec/avif_dec.wasm",
  avifEncode: "@jsquash/avif/codec/enc/avif_enc.wasm",
  jxlEncode: "@jsquash/jxl/codec/enc/jxl_enc.wasm",
  webpEncode: "@jsquash/webp/codec/enc/webp_enc.wasm",
  resize: "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
} as const;

export type ImageCodec = keyof typeof IMAGE_CODEC_FILES;

/** Whether a growth was refused: the codec then fails with its own words, and the report says why. */
let memoryCapHit = false;

/** Every WebAssembly.Memory that grew in this worker: their sizes together never pass `limit`. */
function capWasmMemory(limit: number): void {
  const memories = new Set<WebAssembly.Memory>();
  const grow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function capped(this: WebAssembly.Memory, delta: number): number {
    memories.add(this);
    let total = 0;
    for (const memory of memories) total += memory.buffer.byteLength;
    if (total + delta * 65_536 > limit) {
      memoryCapHit = true;
      throw new RangeError("WebAssembly memory cap");
    }
    return grow.call(this, delta);
  };
}

function codecPath(codec: ImageCodec, directory: string | undefined): string {
  const file = IMAGE_CODEC_FILES[codec];
  if (directory) return `${directory.replace(/[\\/]+$/u, "")}/${file.split("/").pop()}`;
  return createRequire(import.meta.url).resolve(file);
}

const compile = (codec: ImageCodec, directory: string | undefined) => WebAssembly.compile(readFileSync(codecPath(codec, directory)));

interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function imageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  return new (globalThis as unknown as { ImageData: new (data: Uint8ClampedArray, width: number, height: number) => ImageData }).ImageData(data, width, height);
}

/** The pixels as a browser shows them: EXIF orientation 2–8 mirrors and turns them (1 leaves them). */
function orient(image: Pixels, orientation: number): Pixels {
  if (orientation <= 1 || orientation > 8) return image;
  const { width, height } = image;
  const swap = orientation >= 5;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const source = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
  const target = new Uint32Array(outWidth * outHeight);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let tx: number;
      let ty: number;
      switch (orientation) {
        case 2: tx = width - 1 - x; ty = y; break;
        case 3: tx = width - 1 - x; ty = height - 1 - y; break;
        case 4: tx = x; ty = height - 1 - y; break;
        case 5: tx = y; ty = x; break;
        case 6: tx = height - 1 - y; ty = x; break;
        case 7: tx = height - 1 - y; ty = width - 1 - x; break;
        default: tx = y; ty = width - 1 - x; break;
      }
      target[ty * outWidth + tx] = source[y * width + x] as number;
    }
  }
  return { data: new Uint8ClampedArray(target.buffer), width: outWidth, height: outHeight };
}

const now = () => performance.now();

async function run(data: ImageWorkerData): Promise<ImageWorkerResult> {
  if (!(globalThis as { ImageData?: unknown }).ImageData) {
    (globalThis as { ImageData?: unknown }).ImageData = class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    };
  }
  capWasmMemory(data.maxWasmBytes);
  const { job } = data;
  const directory = data.codecDirectory;
  const input = job.bytes.buffer.slice(job.bytes.byteOffset, job.bytes.byteOffset + job.bytes.byteLength) as ArrayBuffer;
  let started = now();
  let decoded: Pixels | null;
  switch (job.format) {
    case "jpeg":
      await initJpegDecode(await compile("jpegDecode", directory));
      // The stored pixels (jSquash's preserveOrientation: true would turn them by its own reading of EXIF): the
      // orientation is applied below, from the header as the browser reads it (image-size.ts).
      decoded = await decodeJpeg(input, { preserveOrientation: false });
      break;
    case "png":
      await initPngDecode(await compile("pngDecode", directory));
      decoded = await decodePng(input);
      break;
    case "webp":
      await initWebpDecode(await compile("webpDecode", directory));
      decoded = await decodeWebp(input);
      break;
    default:
      await initAvifDecode(await compile("avifDecode", directory));
      decoded = await decodeAvif(input);
  }
  if (!decoded || decoded.width !== job.width || decoded.height !== job.height || decoded.data.length !== job.width * job.height * 4) {
    return { ok: false, error: "le misure decodificate non sono quelle dell'intestazione" };
  }
  const shown = orient(decoded, job.orientation);
  decoded = null;
  const decodeMs = now() - started;
  const encoders: Record<VariantFormat, (image: ImageData) => Promise<ArrayBuffer>> = {
    avif: (image) => encodeAvif(image, { quality: job.quality.avif, speed: 8 }),
    jxl: (image) => encodeJxl(image, job.lossless ? { lossless: true, effort: 3 } : { quality: job.quality.jxl, effort: 4 }),
    webp: (image) => encodeWebp(image, job.lossless ? { lossless: 1, quality: 50, method: 4, exact: 0 } : { quality: job.quality.webp, method: 4 }),
  };
  if (job.formats.includes("avif")) await initAvifEncode(await compile("avifEncode", directory));
  if (job.formats.includes("jxl")) await initJxlEncode(await compile("jxlEncode", directory));
  if (job.formats.includes("webp")) await initWebpEncode(await compile("webpEncode", directory));
  if (job.widths.some((width) => width !== shown.width)) await initResize(await compile("resize", directory));
  const outputs: ImageWorkerOutput[] = [];
  const encodeMs: Record<VariantFormat, number> = { avif: 0, jxl: 0, webp: 0 };
  let resizeMs = 0;
  // Largest first, each width made from the one above it.
  let current: Pixels = shown;
  for (const width of [...job.widths].sort((left, right) => right - left)) {
    const height = Math.max(1, Math.round((shown.height * width) / shown.width));
    if (width !== current.width || height !== current.height) {
      started = now();
      current = await resize(imageData(current.data, current.width, current.height), { width, height, method: "lanczos3", fitMethod: "stretch", premultiply: true, linearRGB: false });
      resizeMs += now() - started;
    }
    for (const format of job.formats) {
      started = now();
      const encoded = await encoders[format](imageData(current.data, current.width, current.height));
      encodeMs[format] += now() - started;
      outputs.push({ format, width, height, bytes: new Uint8Array(encoded) });
    }
  }
  if (memoryCapHit) return { ok: false, error: `memoria del codificatore oltre ${Math.round(data.maxWasmBytes / 1024 / 1024)} MiB` };
  return { ok: true, outputs, timings: { decodeMs, resizeMs, encodeMs } };
}

if (parentPort && workerData && typeof workerData === "object" && "job" in workerData) {
  const port = parentPort;
  run(workerData as ImageWorkerData).then(
    (result) => port.postMessage(result, result.ok ? result.outputs.map((output) => output.bytes.buffer as ArrayBuffer) : []),
    (error: unknown) => port.postMessage({ ok: false, error: memoryCapHit ? `memoria del codificatore oltre ${Math.round((workerData as ImageWorkerData).maxWasmBytes / 1024 / 1024)} MiB` : `errore del codificatore: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}` } satisfies ImageWorkerResult),
  );
}
