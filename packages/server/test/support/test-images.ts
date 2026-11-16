import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import encodeAvif, { init as initAvif } from "@jsquash/avif/encode.js";
import decodeAvif, { init as initAvifDecode } from "@jsquash/avif/decode.js";
import encodeJpeg, { init as initJpeg } from "@jsquash/jpeg/encode.js";
import encodePng from "@jsquash/png/encode.js";
import { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebp } from "@jsquash/webp/encode.js";

/**
 * Real small images for the tests of the image variants (queue B6), made here with the same jSquash codecs rather than
 * kept as binary fixtures: a photograph-like gradient with noise (JPEG, WebP, AVIF) and flat graphics (PNG).
 */

const require = createRequire(import.meta.url);
const wasm = (file: string) => WebAssembly.compile(readFileSync(require.resolve(file)));
let ready: Promise<void> | null = null;

async function init(): Promise<void> {
  ready ??= (async () => {
    if (!(globalThis as { ImageData?: unknown }).ImageData) {
      (globalThis as { ImageData?: unknown }).ImageData = class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
      };
    }
    await initJpeg(await wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"));
    await initWebp(await wasm("@jsquash/webp/codec/enc/webp_enc.wasm"));
    await initWebpDecode(await wasm("@jsquash/webp/codec/dec/webp_dec.wasm"));
    await initAvif(await wasm("@jsquash/avif/codec/enc/avif_enc.wasm"));
    await initAvifDecode(await wasm("@jsquash/avif/codec/dec/avif_dec.wasm"));
    await initPng(await wasm("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"));
  })();
  return ready;
}

/**
 * RGBA pixels: a gradient with some noise (a photograph compresses like this); `corner` paints the top-left 16×16
 * red, so an orientation can be checked after decoding.
 */
export function photoPixels(width: number, height: number, corner = false): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed >> 16) % 24;
      const at = (y * width + x) * 4;
      data[at] = (x * 255) / width + noise;
      data[at + 1] = (y * 255) / height + noise;
      data[at + 2] = 128 + Math.sin(x / 23) * 60 + noise;
      data[at + 3] = 255;
      if (corner && x < 16 && y < 16) data.set([255, 0, 0, 255], at);
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

/** Flat graphics with transparency: what a PNG usually holds. */
export function graphicPixels(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (Math.min(width, height) / 3) ** 2;
      data.set(inside ? [30, 90, 200, 255] : (x >> 5) % 2 === (y >> 5) % 2 ? [240, 240, 240, 255] : [0, 0, 0, 0], at);
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

export async function jpeg(image: ImageData, quality = 85): Promise<Buffer> {
  await init();
  return Buffer.from(await encodeJpeg(image, { quality }));
}

export async function png(image: ImageData): Promise<Buffer> {
  await init();
  return Buffer.from(await encodePng(image));
}

export async function webp(image: ImageData, quality = 85): Promise<Buffer> {
  await init();
  return Buffer.from(await encodeWebp(image, { quality }));
}

export async function avif(image: ImageData, quality = 70): Promise<Buffer> {
  await init();
  return Buffer.from(await encodeAvif(image, { quality, speed: 9 }));
}

export async function decodedWebp(bytes: Uint8Array): Promise<ImageData> {
  await init();
  return decodeWebp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export async function decodedAvif(bytes: Uint8Array): Promise<ImageData> {
  await init();
  return (await decodeAvif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)) as ImageData;
}

/** A JPEG with an EXIF APP1 segment saying `orientation`, right after SOI. */
export function withExifOrientation(file: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([file.subarray(0, 2), segment, file.subarray(2)]);
}
