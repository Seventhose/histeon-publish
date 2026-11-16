// The image encoder's Web Worker (lista migliorie M5), built on its own into plugin/assets/builder/media/ by
// vite.media.config.ts and started by lib/imageEncoder.ts. The browser decodes (createImageBitmap, which also turns
// the picture by its EXIF orientation and brings its colours to sRGB); jSquash resizes and encodes, with the
// single-threaded codecs only: the builder page is not cross-origin isolated, so threads are never available. The
// .wasm files are served by the plugin next to this script, never by a CDN, and compiled here, inside the worker.

import avifFactory from '@jsquash/avif/codec/enc/avif_enc.js';
import avifWasm from '@jsquash/avif/codec/enc/avif_enc.wasm?url';
import { defaultOptions as avifDefaults } from '@jsquash/avif/meta.js';
import webpFactory from '@jsquash/webp/codec/enc/webp_enc.js';
import webpWasm from '@jsquash/webp/codec/enc/webp_enc.wasm?url';
import webpSimdFactory from '@jsquash/webp/codec/enc/webp_enc_simd.js';
import webpSimdWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';
import { defaultOptions as webpDefaults } from '@jsquash/webp/meta.js';
import initResize, { resize } from '@jsquash/resize/lib/resize/pkg/squoosh_resize.js';
import resizeWasm from '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm?url';
import { simd } from 'wasm-feature-detect';
import { encodeOptions, fitWithin, type EncodeJob, type EncodeReply, type Encoded, type Format } from '../lib/imageEncoder.ts';

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type Codec = { encode(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: object): Uint8Array | null };
type Factory = (options: object) => Promise<Codec>;

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<EncodeJob & { id: number }>) => void): void;
  postMessage(message: EncodeReply, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

/** A .wasm served by the plugin; a server that does not send application/wasm still gets it compiled. */
async function compile(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  try {
    return await WebAssembly.compileStreaming(response.clone());
  } catch {
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

/** An Emscripten codec on a module compiled here (what jSquash's init(module) does). */
async function emscripten(factory: unknown, url: string): Promise<Codec> {
  const module = await compile(url);
  return (factory as Factory)({
    noInitialRun: true,
    instantiateWasm(imports: WebAssembly.Imports, callback: (instance: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(module, imports);
      callback(instance);
      return instance.exports;
    },
  });
}

const codecs = new Map<Format | 'resize', Promise<Codec | void>>();
function codec(format: Format): Promise<Codec> {
  if (!codecs.has(format)) {
    const loading =
      format === 'avif'
        ? emscripten(avifFactory, avifWasm)
        : simd().then((fast) => (fast ? emscripten(webpSimdFactory, webpSimdWasm) : emscripten(webpFactory, webpWasm)));
    // A codec that failed to load is tried again with the next image.
    loading.catch(() => codecs.delete(format));
    codecs.set(format, loading);
  }
  return codecs.get(format) as Promise<Codec>;
}

const DEFAULTS: Record<Format, object> = { avif: avifDefaults, webp: webpDefaults };

async function encode(format: Format, pixels: Pixels, lossless: boolean, quality?: number): Promise<Encoded> {
  const own = encodeOptions(format, lossless, quality);
  const options = { ...DEFAULTS[format], ...own };
  const input = format === 'avif' ? new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength) : pixels.data;
  const output = (await codec(format)).encode(input, pixels.width, pixels.height, options);
  if (!output) throw new Error(`${format}: codifica non riuscita`);
  // A copy of exactly the file's bytes: the codec's view may sit in a larger buffer.
  return { format, buffer: output.slice().buffer };
}

/** Lanczos3 as in Publish; the browser's own scaling is not the same filter, and its files would differ. */
async function resized(pixels: Pixels, width: number, height: number): Promise<Pixels> {
  if (width === pixels.width && height === pixels.height) return pixels;
  if (!codecs.has('resize')) codecs.set('resize', compile(resizeWasm).then(async (module) => void (await initResize(module))));
  await codecs.get('resize');
  const data = resize(new Uint8Array(pixels.data.buffer), pixels.width, pixels.height, width, height, 3, true, false);
  return { data: new Uint8ClampedArray(data.buffer), width, height };
}

async function decode(job: EncodeJob): Promise<Pixels> {
  const bitmap = await createImageBitmap(job.file, { imageOrientation: 'from-image' });
  try {
    // The decoded size must be the one the header promised (turned or not): the limits were checked on it.
    const same = (bitmap.width === job.width && bitmap.height === job.height) || (bitmap.width === job.height && bitmap.height === job.width);
    if (!same) throw new Error("le misure decodificate non sono quelle dell'intestazione");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas non disponibile');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data: image.data, width: image.width, height: image.height };
  } finally {
    bitmap.close();
  }
}

scope.addEventListener('message', async (event) => {
  const { id, ...job } = event.data;
  try {
    const source = await decode(job);
    const size = fitWithin(source.width, source.height, job.max);
    const pixels = await resized(source, size.width, size.height);
    const files: Encoded[] = [];
    for (const variant of job.variants) files.push(await encode(variant.format, pixels, variant.lossless, variant.quality));
    scope.postMessage({ id, ok: true, files }, files.map((file) => file.buffer));
  } catch (error) {
    scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
