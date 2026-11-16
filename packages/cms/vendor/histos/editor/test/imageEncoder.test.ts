import { describe, expect, it } from 'vitest';
import { encodeOptions, fitWithin, lightest, renamed, variantsFor, type Encoded } from '../src/lib/imageEncoder.ts';
import { MAX_BYTES, readImageHeader, refusal } from '../src/lib/imageHeader.ts';
import { IN_PLACE } from '../src/lib/mediaLibrary.ts';

const bytes = (length: number, parts: Array<[number, number[] | string]>) => {
  const b = new Uint8Array(length);
  for (const [at, value] of parts) b.set(typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0)) : value, at);
  return b;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [...le24(n), (n >>> 24) & 255];

/** A PNG signature and IHDR, then optional chunks of the given types (empty), then IDAT. */
function png(width: number, height: number, chunks: string[] = []): Uint8Array {
  const parts: Array<[number, number[] | string]> = [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], [8, be32(13)], [12, 'IHDR'], [16, be32(width)], [20, be32(height)]];
  let at = 33;
  for (const type of [...chunks, 'IDAT']) {
    parts.push([at, be32(0)], [at + 4, type]);
    at += 12;
  }
  return bytes(at + 8, parts);
}

/** SOI, an APP0 of 16 bytes, then a baseline frame header. */
const jpeg = (width: number, height: number) =>
  bytes(64, [[0, [0xff, 0xd8, 0xff, 0xe0, 0, 16]], [6, 'JFIF'], [20, [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3]]]);

const webpLossy = (width: number, height: number) => bytes(40, [[0, 'RIFF'], [8, 'WEBPVP8 '], [23, [0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8]]]);

const webpLossless = (width: number, height: number) => {
  const w = width - 1;
  const h = height - 1;
  return bytes(40, [[0, 'RIFF'], [8, 'WEBPVP8L'], [20, [0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 0x0f]]]);
};

/** The extended WebP: VP8X with its flags, then one image chunk. */
const webpExtended = (width: number, height: number, flags: number, chunk: string) =>
  bytes(60, [[0, 'RIFF'], [4, le32(52)], [8, 'WEBPVP8X'], [16, le32(10)], [20, [flags]], [24, le24(width - 1)], [27, le24(height - 1)], [30, chunk], [34, le32(8)]]);

describe('the header, read before decoding (M5)', () => {
  it('reads the size and kind of JPEG, PNG and WebP', () => {
    expect(readImageHeader(jpeg(4000, 3000))).toEqual({ format: 'jpeg', width: 4000, height: 3000, lossless: false, animated: false });
    expect(readImageHeader(png(800, 600))).toEqual({ format: 'png', width: 800, height: 600, lossless: true, animated: false });
    expect(readImageHeader(webpLossy(640, 480))).toEqual({ format: 'webp', width: 640, height: 480, lossless: false, animated: false });
    expect(readImageHeader(webpLossless(1000, 700))).toEqual({ format: 'webp', width: 1000, height: 700, lossless: true, animated: false });
    expect(readImageHeader(webpExtended(1200, 900, 0x10, 'VP8L'))).toMatchObject({ width: 1200, height: 900, lossless: true, animated: false });
  });

  it('sees animations, which are never touched', () => {
    expect(readImageHeader(png(100, 100, ['acTL']))?.animated).toBe(true);
    expect(readImageHeader(webpExtended(100, 100, 0x02, 'ANIM'))?.animated).toBe(true);
    expect(refusal(1000, readImageHeader(png(100, 100, ['acTL'])))).toBe('animazione');
  });

  it('refuses a decompression bomb, a file too large and an unreadable header without decoding them', () => {
    // 8000 × 6000 is 48 megapixels: over the 40 of the limit, while the file itself may be tiny.
    expect(refusal(2000, readImageHeader(png(8000, 6000)))).toBe('oltre 40 megapixel');
    expect(refusal(2000, readImageHeader(jpeg(6000, 6000)))).toBe(null);
    expect(refusal(MAX_BYTES + 1, readImageHeader(jpeg(100, 100)))).toBe('oltre 32 MB');
    expect(refusal(100, readImageHeader(bytes(64, [[0, 'GIF89a']])))).toBe('intestazione non leggibile');
    expect(readImageHeader(jpeg(0, 100))).toBe(null);
    // A JPEG cut before its frame header: no size, so it goes as it is.
    expect(readImageHeader(jpeg(100, 100).slice(0, 20))).toBe(null);
  });
});

describe('the encoder choices (M5)', () => {
  it("uses Publish's options, lossless sources staying lossless", () => {
    expect(encodeOptions('avif', false)).toEqual({ quality: 60, speed: 8 });
    expect(encodeOptions('webp', false)).toEqual({ quality: 75, method: 4 });
    expect(encodeOptions('webp', true)).toEqual({ lossless: 1, quality: 50, method: 4, exact: 0 });
    // A site's preset (doc 26 voce 209): its quality for lossy files, within 30-95; lossless stays as it is.
    expect(encodeOptions('webp', false, 60)).toEqual({ quality: 60, method: 4 });
    expect(encodeOptions('avif', false, 10)).toEqual({ quality: 30, speed: 8 });
    expect(encodeOptions('webp', true, 60)).toEqual({ lossless: 1, quality: 50, method: 4, exact: 0 });
  });

  it('never makes AVIF of a lossless source, and tries lossy WebP for it too', () => {
    const header = { format: 'png' as const, width: 10, height: 10, lossless: true, animated: false };
    expect(variantsFor(header, ['avif', 'webp'])).toEqual([
      { format: 'webp', lossless: true },
      { format: 'webp', lossless: false },
    ]);
    expect(variantsFor(header, ['avif'])).toEqual([]);
    expect(variantsFor({ ...header, lossless: false }, ['avif', 'webp'])).toEqual([
      { format: 'avif', lossless: false },
      { format: 'webp', lossless: false },
    ]);
  });

  it('keeps the lightest format, and only if it weighs less than the original', () => {
    const file = (format: Encoded['format'], size: number): Encoded => ({ format, buffer: new ArrayBuffer(size) });
    expect(lightest([file('avif', 300), file('webp', 400)], 1000)?.format).toBe('avif');
    expect(lightest([file('avif', 500), file('webp', 400)], 1000)?.format).toBe('webp');
    expect(lightest([file('avif', 1000), file('webp', 1200)], 1000)).toBe(null);
    expect(lightest([file('avif', 0)], 1000)).toBe(null);
    expect(lightest([], 1000)).toBe(null);
  });

  it('names and sizes the result', () => {
    expect(renamed('Foto.Mare.JPG', 'avif')).toBe('Foto.Mare.avif');
    expect(renamed('.png', 'webp')).toBe('immagine.webp');
    expect(fitWithin(4000, 3000, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(1000, 800, 2560)).toEqual({ width: 1000, height: 800 });
  });

  it('compresses in place only the formats whose header it reads (AVIF would always look already light)', () => {
    const samples: Record<string, Uint8Array> = { 'image/jpeg': jpeg(40, 30), 'image/png': png(40, 30), 'image/webp': webpLossy(40, 30) };
    for (const mime of IN_PLACE) expect(readImageHeader(samples[mime] ?? new Uint8Array(64))?.format, mime).toBe(mime.slice(6));
    expect(IN_PLACE).not.toContain('image/avif');
  });
});
