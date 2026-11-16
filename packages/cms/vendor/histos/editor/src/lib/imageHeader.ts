// What a picture is, read from its header before anything is decoded (lista migliorie M5): its format, size, whether
// it is lossless or animated. The same reading as Histeon Publish's inspectImageForVariants (ADR 0012 there), for the
// three formats the builder compresses. Tested in test/imageEncoder.test.ts.

export interface ImageHeader {
  format: 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
  /** PNG, or a WebP stored without loss: what is made from it stays without loss. */
  lossless: boolean;
  /** An animated PNG or WebP: the frames would be lost, so it is never touched. */
  animated: boolean;
}

/** Above this a file is never decoded: 40 megapixels are 160 MB of pixels, more is a decompression bomb. */
export const MAX_PIXELS = 40_000_000;
/** Bytes of a file the encoder takes at most. */
export const MAX_BYTES = 32 * 1024 * 1024;

const MAX_SIDE = 65_535;

const be16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const be32 = (b: Uint8Array, at: number) => (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, at: number) => le16(b, at) | ((b[at + 2] ?? 0) << 16);
const le32 = (b: Uint8Array, at: number) => le16(b, at) + le16(b, at + 2) * 0x10000;
const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

const sized = (width: number, height: number) => width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE;

function jpeg(b: Uint8Array): ImageHeader | null {
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // The scan begins: the frame header came before it, or there is none.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = be16(b, at + 2);
    if (length < 2) return null;
    // SOF0–SOF15 but DHT, JPG and DAC hold the size (the stored one: the orientation only swaps the sides).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && at + 9 <= b.length) {
      const width = be16(b, at + 7);
      const height = be16(b, at + 5);
      return sized(width, height) ? { format: 'jpeg', width, height, lossless: false, animated: false } : null;
    }
    at += 2 + length;
  }
  return null;
}

function png(b: Uint8Array): ImageHeader | null {
  const width = be32(b, 16);
  const height = be32(b, 20);
  if (!sized(width, height)) return null;
  let animated = false;
  let at = 8;
  while (at + 12 <= b.length) {
    const length = be32(b, at);
    if (ascii(b, at + 4, 'IDAT')) break;
    // An animated PNG says so before its image data.
    if (ascii(b, at + 4, 'acTL')) animated = true;
    at += 12 + length;
  }
  return { format: 'png', width, height, lossless: true, animated };
}

function webp(b: Uint8Array): ImageHeader | null {
  if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    const width = le16(b, 26) & 0x3fff;
    const height = le16(b, 28) & 0x3fff;
    return sized(width, height) ? { format: 'webp', width, height, lossless: false, animated: false } : null;
  }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const b1 = b[22] ?? 0;
    const width = 1 + ((b[21] ?? 0) | ((b1 & 0x3f) << 8));
    const height = 1 + (((b1 & 0xc0) >> 6) | ((b[23] ?? 0) << 2) | (((b[24] ?? 0) & 0x0f) << 10));
    return sized(width, height) ? { format: 'webp', width, height, lossless: true, animated: false } : null;
  }
  if (ascii(b, 12, 'VP8X')) {
    const width = 1 + le24(b, 24);
    const height = 1 + le24(b, 27);
    if (!sized(width, height)) return null;
    const animated = ((b[20] ?? 0) & 0x02) !== 0;
    // The extended format names its image chunk after the header: VP8L is the lossless one.
    let lossless = false;
    const end = Math.min(b.length, 8 + le32(b, 4));
    let at = 30;
    for (let chunks = 0; at + 8 <= end && chunks < 64; chunks++) {
      if (ascii(b, at, 'VP8L')) lossless = true;
      const length = le32(b, at + 4);
      at += 8 + length + (length & 1);
    }
    return { format: 'webp', width, height, lossless, animated };
  }
  return null;
}

/** The header of a JPEG, PNG or WebP, or null when it is another format or its header does not say its size. */
export function readImageHeader(b: Uint8Array): ImageHeader | null {
  if (b.length < 30) return null;
  if (b[0] === 0x89 && ascii(b, 1, 'PNG') && ascii(b, 12, 'IHDR')) return png(b);
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return webp(b);
  return null;
}

/** Why a file goes as it is instead of being compressed, or null when it can be decoded. */
export function refusal(bytes: number, header: ImageHeader | null): string | null {
  if (bytes > MAX_BYTES) return 'oltre 32 MB';
  if (!header) return 'intestazione non leggibile';
  if (header.animated) return 'animazione';
  if (header.width * header.height > MAX_PIXELS) return 'oltre 40 megapixel';
  return null;
}
