// The builder's image encoder (lista migliorie M5): the same jSquash codecs and options as Histeon Publish (ADR 0012
// there), in a Web Worker served by the plugin (src/media/encoder.worker.ts). This side holds the choices, tested in
// test/imageEncoder.test.ts, and the worker's client.

import type { ImageHeader } from './imageHeader.ts';

// No JPEG XL: one file in an <img>, which Chrome and Firefox do not show. It stays in Publish, inside a <picture>
// with fallbacks, and comes here only when the builder makes such a <picture>.
export type Format = 'avif' | 'webp';

export const MIME: Record<Format, string> = { avif: 'image/avif', webp: 'image/webp' };

/**
 * Publish's options, so the two make the same files: one visual level measured with SSIM (WebP 75, AVIF 60),
 * the speed for the time of an upload.
 */
export function encodeOptions(format: Format, lossless: boolean, quality?: number): Record<string, number | boolean> {
  // A site's own preset (doc 26 voce 209) may ask another quality for lossy files, within sensible bounds.
  const q = quality === undefined ? undefined : Math.min(95, Math.max(30, Math.round(quality)));
  if (format === 'avif') return { quality: q ?? 60, speed: 8 };
  return lossless ? { lossless: 1, quality: 50, method: 4, exact: 0 } : { quality: q ?? 75, method: 4 };
}

/** One file to make: a format, with or without loss. */
export interface Variant {
  format: Format;
  lossless: boolean;
  /** Quality of a lossy file, from a site's preset; Publish's level when absent. */
  quality?: number;
}

/**
 * The files to try for a source. A lossy source: each format, lossy. A lossless one (PNG, lossless WebP): each
 * format without loss but AVIF (lossy only, as in Publish), and also lossy WebP, as the builder made before M5. Here
 * the builder differs from Publish on purpose: a graphic resized to the preset's size often weighs more without loss
 * than its original, which would then be sent at full size.
 */
export function variantsFor(header: ImageHeader, wanted: readonly Format[], quality?: number): Variant[] {
  const lossy = (format: Format): Variant => (quality === undefined ? { format, lossless: false } : { format, lossless: false, quality });
  if (!header.lossless) return wanted.map(lossy);
  const own = wanted.filter((format) => format !== 'avif').map((format) => ({ format, lossless: true }));
  return wanted.includes('webp') ? [...own, lossy('webp')] : own;
}

export interface Encoded {
  format: Format;
  buffer: ArrayBuffer;
}

/** The lightest file, if it is lighter than the original: a format is kept only where it weighs less. */
export function lightest(files: readonly Encoded[], original: number): Encoded | null {
  let best: Encoded | null = null;
  for (const file of files) if (file.buffer.byteLength > 0 && file.buffer.byteLength < (best?.buffer.byteLength ?? original)) best = file;
  return best;
}

/** The size that fits within `max` on its longest side, never larger than the source; 0 keeps the size. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (max <= 0 || (width <= max && height <= max)) return { width, height };
  const scale = max / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const renamed = (name: string, format: Format): string => `${name.replace(/\.[a-z0-9]+$/i, '') || 'immagine'}.${format}`;

/** What the worker is asked: the file, the decoded size its header promises, the longest side wanted. */
export interface EncodeJob {
  file: Blob;
  width: number;
  height: number;
  max: number;
  variants: Variant[];
}

export type EncodeReply = { id: number; ok: true; files: Encoded[] } | { id: number; ok: false; error: string };

/** One image at most this long, decoding and every format: past it the worker is ended, its memory with it. */
export const JOB_TIMEOUT_MS = 60_000;
/** An idle worker is ended: its codecs hold hundreds of MB of WebAssembly memory. */
const IDLE_MS = 20_000;

let worker: Worker | null = null;
let workerUrl = '';
let idle: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;

function stop(): void {
  worker?.terminate();
  worker = null;
}

/**
 * Encodes in the worker at `url`. Rejects when the worker cannot run (no URL, the page's CSP, no WebAssembly), on
 * its errors and past the time limit; the caller then has its own fallback.
 */
export function encodeInWorker(url: string, job: EncodeJob, timeoutMs = JOB_TIMEOUT_MS): Promise<Encoded[]> {
  clearTimeout(idle);
  if (worker && workerUrl !== url) stop();
  if (!worker) {
    worker = new Worker(url, { type: 'module', name: 'xb-image-encoder' });
    workerUrl = url;
  }
  const own = worker;
  const id = nextId++;
  return new Promise<Encoded[]>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      own.removeEventListener('message', onMessage);
      own.removeEventListener('error', onError);
      idle = setTimeout(stop, IDLE_MS);
    };
    const timer = setTimeout(() => {
      done();
      stop();
      reject(new Error('tempo scaduto'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent<EncodeReply>) => {
      if (event.data?.id !== id) return;
      done();
      if (event.data.ok) resolve(event.data.files);
      else reject(new Error(event.data.error));
    };
    // A worker that does not load (CSP, missing file) or that dies: it is not reused.
    const onError = (event: ErrorEvent | Event) => {
      done();
      stop();
      reject(new Error('message' in event && event.message ? event.message : 'worker non disponibile'));
    };
    own.addEventListener('message', onMessage);
    own.addEventListener('error', onError);
    own.postMessage({ id, ...job });
  });
}
