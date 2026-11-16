/**
 * The size of an image as a browser shows it, read from its header (queue B6): PNG, GIF, JPEG, WebP and AVIF. Nothing
 * is decoded. As Chromium does: JPEG and PNG follow their EXIF orientation, AVIF its primary image and rotation, GIF
 * its logical screen. A file that does not say its size, says something out of range, or does something not worth
 * guessing (an AVIF crop, an animated AVIF, a GIF whose first frame overflows its screen) gives null: no size is
 * better than a wrong one.
 */

const MAX_SIDE = 65_535;

const be16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const be32 = (bytes: Uint8Array, at: number) => (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
const le16 = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const le24 = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

function size(width: number, height: number): { width: number; height: number } | null {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE ? { width, height } : null;
}

/** The EXIF orientation (1–8) of TIFF data at `tiff`, or 1 when it is not there or not readable. */
function tiffOrientation(bytes: Uint8Array, tiff: number, end: number): number {
  const little = ascii(bytes, tiff, "II");
  if (!little && !ascii(bytes, tiff, "MM")) return 1;
  const u16 = (at: number) => (little ? le16(bytes, at) : be16(bytes, at));
  const u32 = (at: number) => (little ? le16(bytes, at) + le16(bytes, at + 2) * 0x10000 : be32(bytes, at));
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    // The first Orientation that is one SHORT from 1 to 8: others are skipped, as browsers skip them.
    if (u16(entry) !== 0x0112 || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) continue;
    const value = u16(entry + 8);
    if (value >= 1 && value <= 8) return value;
  }
  return 1;
}

/** Whether an APP1 segment of `length` bytes is EXIF as Chromium sees it: "Exif", a zero, at least 7 bytes. */
const isExif = (bytes: Uint8Array, start: number, length: number) => length >= 7 && ascii(bytes, start, "Exif") && bytes[start + 4] === 0;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The CRC-32 of a PNG chunk's type and data, as its last four bytes should say. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = (CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function jpeg(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  let orientation = 1;
  let exifSeen = false;
  let frame: { width: number; height: number } | null = null;
  const result = () => (frame ? (orientation >= 5 ? size(frame.height, frame.width) : size(frame.width, frame.height)) : null);
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return result();
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes, and markers without a length.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // The scan begins: everything that counts came before it.
    if (marker === 0xda || marker === 0xd9) return result();
    const length = be16(bytes, at + 2);
    if (length < 2) return result();
    // The frame header (SOF0–SOF15 but DHT, JPG and DAC) holds the size. EXIF may still follow it, so the walk goes on
    // to the scan; only the first EXIF segment counts, as in browsers. Orientations 5–8 turn the image a quarter.
    if (!frame && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && at + 9 <= bytes.length) frame = { width: be16(bytes, at + 7), height: be16(bytes, at + 5) };
    // The first EXIF segment is the one, even when its TIFF data is not readable (then there is no orientation).
    if (marker === 0xe1 && !exifSeen && isExif(bytes, at + 4, length - 2)) {
      exifSeen = true;
      orientation = tiffOrientation(bytes, at + 10, Math.min(bytes.length, at + 2 + length));
    }
    at += 2 + length;
  }
  return result();
}

/**
 * PNG: IHDR, turned by an eXIf chunk that comes before the image data and whose CRC is right (browsers ignore one after
 * it, or a damaged one). Every chunk is at least 12 bytes, so the walk ends with the file.
 */
function png(bytes: Uint8Array): { width: number; height: number } | null {
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = be32(bytes, at);
    const end = at + 8 + length;
    if (end + 4 > bytes.length || ascii(bytes, at + 4, "IDAT")) break;
    if (ascii(bytes, at + 4, "eXIf") && crc32(bytes, at + 4, end) === be32(bytes, end)) {
      const orientation = tiffOrientation(bytes, at + 8, end);
      return orientation >= 5 ? size(height, width) : size(width, height);
    }
    at = end + 4;
  }
  return size(width, height);
}

/** GIF: the logical screen, unless the first frame does not fit in it (browsers then grow the canvas). */
function gif(bytes: Uint8Array): { width: number; height: number } | null {
  const width = le16(bytes, 6);
  const height = le16(bytes, 8);
  const flags = bytes[10] ?? 0;
  let at = 13 + ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x2c) {
      if (at + 9 > bytes.length) return null;
      const fits = le16(bytes, at + 1) + le16(bytes, at + 5) <= width && le16(bytes, at + 3) + le16(bytes, at + 7) <= height;
      return fits ? size(width, height) : null;
    }
    if (block !== 0x21) return null;
    // An extension: its label, then sub-blocks until one of length zero.
    at += 2;
    while (at < bytes.length && bytes[at] !== 0) at += 1 + (bytes[at] ?? 0);
    at += 1;
  }
  return null;
}

function webp(bytes: Uint8Array): { width: number; height: number } | null {
  if (ascii(bytes, 12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return size(le16(bytes, 26) & 0x3fff, le16(bytes, 28) & 0x3fff);
  if (ascii(bytes, 12, "VP8L") && bytes[20] === 0x2f) {
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    return size(1 + ((bytes[21] ?? 0) | ((b1 & 0x3f) << 8)), 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
  }
  if (ascii(bytes, 12, "VP8X")) return size(1 + le24(bytes, 24), 1 + le24(bytes, 27));
  return null;
}

interface Box {
  type: string;
  /** Where the box's content starts and ends. */
  start: number;
  end: number;
}

/** The boxes between `start` and `end` (ISO BMFF), at most `limit`; a box that overruns ends the list. */
function boxes(bytes: Uint8Array, start: number, end: number, limit = 256): Box[] {
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end && found.length < limit) {
    let length = be32(bytes, at);
    let header = 8;
    if (length === 1) {
      // A 64-bit size: anything past 4 GB is not a header we read.
      if (be32(bytes, at + 8) !== 0) return found;
      length = be32(bytes, at + 12);
      header = 16;
    } else if (length === 0) length = end - at;
    if (length < header || at + length > end) return found;
    found.push({ type: String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0), start: at + header, end: at + length });
    at += length;
  }
  return found;
}

/**
 * The properties of an AVIF's primary item (`pitm`), linked through `ipma`, in the order the file lists them; null
 * when the header does not say them all. Only the header is read: `meta` must be within the first 256 KB.
 */
function avifPrimaryProperties(bytes: Uint8Array): Box[] | null {
  const limit = Math.min(bytes.length, 256 * 1024);
  const meta = boxes(bytes, 0, limit).find((box) => box.type === "meta");
  if (!meta) return null;
  // meta is a full box: version and flags first.
  const children = boxes(bytes, meta.start + 4, meta.end);
  const pitm = children.find((box) => box.type === "pitm");
  const iprp = children.find((box) => box.type === "iprp");
  if (!pitm || !iprp) return null;
  const primary = bytes[pitm.start] === 0 ? be16(bytes, pitm.start + 4) : be32(bytes, pitm.start + 4);
  const properties = boxes(bytes, iprp.start, iprp.end);
  const ipco = properties.find((box) => box.type === "ipco");
  const ipma = properties.find((box) => box.type === "ipma");
  if (!ipco || !ipma) return null;
  const list = boxes(bytes, ipco.start, ipco.end);
  const version = bytes[ipma.start] ?? 0;
  const wide = ((bytes[ipma.start + 3] ?? 0) & 1) === 1;
  let at = ipma.start + 4;
  const count = be32(bytes, at);
  at += 4;
  for (let entry = 0; entry < count && at < ipma.end; entry++) {
    const item = version < 1 ? be16(bytes, at) : be32(bytes, at);
    at += version < 1 ? 2 : 4;
    const associations = bytes[at] ?? 0;
    at += 1;
    const indexes: number[] = [];
    for (let index = 0; index < associations && at < ipma.end; index++) {
      indexes.push(wide ? be16(bytes, at) & 0x7fff : (bytes[at] ?? 0) & 0x7f);
      at += wide ? 2 : 1;
    }
    if (item !== primary) continue;
    // A property beyond the list read (more than 256, or a box that overran) could be one that changes the size.
    if (indexes.some((index) => index < 1 || index > list.length)) return null;
    return indexes.map((index) => list[index - 1] as Box);
  }
  return null;
}

/**
 * Doc 23 item 241: why these image bytes cannot be a whole image, or null. Only the structure, which costs nothing:
 * a WebP whose RIFF size is not its length or whose chunks overrun it, a PNG without IEND or with a chunk past the
 * end, a GIF without its trailer, a JPEG without image data or its end marker. Invented or cut base64 (a small model
 * writes a "logo" this way) breaks one of these; a decoder would refuse it later, in the build, without a name.
 */
export function imageIntegrityProblem(bytes: Uint8Array): string | null {
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  const u32le = (at: number) => (bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16 | bytes[at + 3]! << 24) >>> 0;
  const u32be = (at: number) => (bytes[at]! << 24 | bytes[at + 1]! << 16 | bytes[at + 2]! << 8 | bytes[at + 3]!) >>> 0;
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    if (u32le(4) + 8 !== bytes.length) return `l'intestazione RIFF dice ${u32le(4) + 8} byte, il file ne ha ${bytes.length}`;
    for (let at = 12; at < bytes.length;) {
      if (at + 8 > bytes.length) return "un blocco WebP è tagliato";
      const size = u32le(at + 4);
      if (at + 8 + size > bytes.length) return `il blocco ${ascii(at, 4).trim()} va oltre la fine del file`;
      at += 8 + size + (size & 1);
    }
    return null;
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    for (let at = 8; ;) {
      if (at + 12 > bytes.length) return "manca la fine dell'immagine (IEND)";
      const size = u32be(at);
      if (at + 12 + size > bytes.length) return `il blocco ${ascii(at + 4, 4)} va oltre la fine del file`;
      if (ascii(at + 4, 4) === "IEND") return null;
      at += 12 + size;
    }
  }
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    let end = bytes.length - 1;
    while (end > 0 && bytes[end] === 0) end--;
    return bytes[end] === 0x3b ? null : "manca la fine del GIF";
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let scan = -1;
    for (let at = 2; at + 1 < bytes.length; at++) if (bytes[at] === 0xff && bytes[at + 1] === 0xda) { scan = at; break; }
    if (scan < 0) return "non ha i dati dell'immagine";
    for (let at = bytes.length - 2; at > scan; at--) if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return null;
    return "manca la fine del JPEG";
  }
  return null;
}

/** AVIF keeps the size in the `ispe` property of its primary item; `irot` turns it. */
function avif(bytes: Uint8Array): { width: number; height: number } | null {
  const linked = avifPrimaryProperties(bytes);
  if (!linked) return null;
  // A crop (clap) changes the size in ways not worth guessing.
  if (linked.some((box) => box.type === "clap")) return null;
  const ispe = linked.find((box) => box.type === "ispe");
  if (!ispe || ispe.end - ispe.start < 12) return null;
  const width = be32(bytes, ispe.start + 4);
  const height = be32(bytes, ispe.start + 8);
  const irot = linked.find((box) => box.type === "irot");
  const quarter = irot && irot.end > irot.start ? ((bytes[irot.start] ?? 0) & 3) % 2 === 1 : false;
  return quarter ? size(height, width) : size(width, height);
}

export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG") && ascii(bytes, 12, "IHDR")) return png(bytes);
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return gif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webp(bytes);
  // An animated AVIF (major brand avis) shows its track's size, not its primary item's: not read.
  if (ascii(bytes, 4, "ftyp") && ascii(bytes, 8, "avif")) return avif(bytes);
  return null;
}

/** The pixel formats the build makes modern variants of (queue B6): never GIF, SVG or an animation. */
export type ImageVariantFormat = "jpeg" | "png" | "webp" | "avif";

/**
 * A still image the build can decode and encode again without changing what the browser shows: its stored size (before
 * the EXIF orientation, as the decoder gives the pixels), the orientation a browser applies (JPEG and PNG, 1–8), and
 * whether the file is lossless (PNG, WebP VP8L), which its variants then stay.
 */
export interface ImageVariantSource {
  format: ImageVariantFormat;
  width: number;
  height: number;
  orientation: number;
  lossless: boolean;
}

/** Above this, a file is never decoded: 40 megapixels are 160 MB of pixels, and more is a decompression bomb. */
export const IMAGE_VARIANT_MAX_PIXELS = 40_000_000;

const ICC_SCAN_BYTES = 4 * 1024 * 1024;

/** The description of an ICC profile (its `desc` tag, v2 text or v4 `mluc`), or "" when it has none readable. */
function iccDescription(icc: Uint8Array): string {
  if (icc.length < 132) return "";
  const count = Math.min(be32(icc, 128), 256);
  for (let index = 0; index < count; index++) {
    const entry = 132 + index * 12;
    if (entry + 12 > icc.length) return "";
    if (!ascii(icc, entry, "desc")) continue;
    const at = be32(icc, entry + 4);
    const length = be32(icc, entry + 8);
    if (at + Math.min(length, 12) > icc.length || length < 12) return "";
    if (ascii(icc, at, "desc")) {
      const characters = Math.min(be32(icc, at + 8), 256, icc.length - at - 12);
      return String.fromCharCode(...icc.subarray(at + 12, at + 12 + Math.max(0, characters))).replace(/\0+$/u, "");
    }
    if (ascii(icc, at, "mluc")) {
      if (be32(icc, at + 8) < 1 || at + 28 > icc.length) return "";
      const characters = Math.min(be32(icc, at + 20), 512);
      const start = at + be32(icc, at + 24);
      let text = "";
      for (let offset = 0; offset + 1 < characters && start + offset + 1 < icc.length; offset += 2) text += String.fromCharCode(be16(icc, start + offset));
      return text;
    }
    return "";
  }
  return "";
}

/**
 * Whether an ICC profile is sRGB, the color space of a file with no profile: an RGB profile whose description says
 * sRGB. The decoders give the pixels as stored and the variants carry no profile, so any other profile (Display P3 of
 * a phone, Adobe RGB, a gray or CMYK profile) would change the colors: such a file keeps only its original.
 */
export function iccProfileIsSrgb(icc: Uint8Array): boolean {
  return icc.length >= 132 && ascii(icc, 16, "RGB ") && /srgb/iu.test(iccDescription(icc));
}

function jpegVariant(bytes: Uint8Array): ImageVariantSource | string {
  let at = 2;
  let orientation = 1;
  let exifSeen = false;
  let frame: { width: number; height: number; components: number } | null = null;
  const icc: Array<{ sequence: number; data: Uint8Array }> = [];
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = be16(bytes, at + 2);
    if (length < 2) break;
    if (!frame && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && at + 10 <= bytes.length) {
      frame = { width: be16(bytes, at + 7), height: be16(bytes, at + 5), components: bytes[at + 9] ?? 0 };
    }
    if (marker === 0xe1 && !exifSeen && isExif(bytes, at + 4, length - 2)) {
      exifSeen = true;
      orientation = tiffOrientation(bytes, at + 10, Math.min(bytes.length, at + 2 + length));
    }
    // ICC_PROFILE chunks (APP2), joined in their sequence order.
    if (marker === 0xe2 && length >= 16 && ascii(bytes, at + 4, "ICC_PROFILE") && bytes[at + 15] === 0) {
      const sum = icc.reduce((total, chunk) => total + chunk.data.length, 0);
      if (sum < ICC_SCAN_BYTES) icc.push({ sequence: bytes[at + 16] ?? 0, data: bytes.subarray(at + 18, Math.min(bytes.length, at + 2 + length)) });
    }
    at += 2 + length;
  }
  if (!frame || !size(frame.width, frame.height)) return "le misure non si leggono dall'intestazione";
  if (frame.components !== 1 && frame.components !== 3) return "JPEG in CMYK: i colori cambierebbero";
  if (icc.length) {
    const chunks = icc.sort((left, right) => left.sequence - right.sequence).map((chunk) => chunk.data);
    const profile = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      profile.set(chunk, offset);
      offset += chunk.length;
    }
    if (!iccProfileIsSrgb(profile)) return "profilo colore diverso da sRGB: i colori cambierebbero";
  }
  return { format: "jpeg", width: frame.width, height: frame.height, orientation, lossless: false };
}

const SRGB_CHROMATICITIES = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];

function pngVariant(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array | null): ImageVariantSource | string {
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  if (!size(width, height)) return "le misure non si leggono dall'intestazione";
  let at = 8;
  let orientation = 1;
  let exifSeen = false;
  let srgb = false;
  let profile: string | null = null;
  let gamma: number | null = null;
  let chromaticities: number[] | null = null;
  while (at + 12 <= bytes.length) {
    const length = be32(bytes, at);
    const end = at + 8 + length;
    if (end + 4 > bytes.length || ascii(bytes, at + 4, "IDAT")) break;
    // An animated PNG shows its frames in browsers: never touched.
    if (ascii(bytes, at + 4, "acTL")) return "PNG animato: le animazioni non si toccano";
    if (ascii(bytes, at + 4, "eXIf") && !exifSeen && crc32(bytes, at + 4, end) === be32(bytes, end)) {
      exifSeen = true;
      orientation = tiffOrientation(bytes, at + 8, end);
    }
    if (ascii(bytes, at + 4, "sRGB")) srgb = true;
    if (ascii(bytes, at + 4, "gAMA") && length === 4) gamma = be32(bytes, at + 8);
    if (ascii(bytes, at + 4, "cHRM") && length === 32) chromaticities = Array.from({ length: 8 }, (_, index) => be32(bytes, at + 8 + index * 4));
    if (ascii(bytes, at + 4, "iCCP")) {
      // The profile name (1–79 bytes), a zero, the compression method, then the zlib data.
      const name = bytes.subarray(at + 8, Math.min(end, at + 8 + 80)).indexOf(0);
      const icc = name > 0 ? inflate(bytes.subarray(at + 8 + name + 2, end)) : null;
      profile = icc && iccProfileIsSrgb(icc) ? "srgb" : "other";
    }
    at = end + 4;
  }
  // As Chromium reads them: the ICC profile first, then sRGB, then gAMA and cHRM.
  if (profile === "other") return "profilo colore diverso da sRGB: i colori cambierebbero";
  if (!profile && !srgb) {
    if (gamma !== null && Math.abs(gamma - 45455) > 500) return "gamma PNG diversa da sRGB: i colori cambierebbero";
    if (chromaticities?.some((value, index) => Math.abs(value - (SRGB_CHROMATICITIES[index] as number)) > 1000)) return "primari PNG diversi da sRGB: i colori cambierebbero";
  }
  return { format: "png", width, height, orientation, lossless: true };
}

function webpVariant(bytes: Uint8Array): ImageVariantSource | string {
  const measured = webp(bytes);
  if (!measured) return "le misure non si leggono dall'intestazione";
  let lossless = ascii(bytes, 12, "VP8L");
  if (ascii(bytes, 12, "VP8X")) {
    const flags = bytes[20] ?? 0;
    if (flags & 0x02) return "WebP animato: le animazioni non si toccano";
    const riffEnd = Math.min(bytes.length, 8 + le16(bytes, 4) + le16(bytes, 6) * 0x10000);
    let at = 12;
    for (let chunks = 0; at + 8 <= riffEnd && chunks < 64; chunks++) {
      const length = le16(bytes, at + 4) + le16(bytes, at + 6) * 0x10000;
      const start = at + 8;
      const end = Math.min(riffEnd, start + length);
      if (ascii(bytes, at, "VP8L")) lossless = true;
      if (ascii(bytes, at, "ICCP") && !iccProfileIsSrgb(bytes.subarray(start, end))) return "profilo colore diverso da sRGB: i colori cambierebbero";
      // Some browsers turn a WebP by its EXIF, Chromium does not: a turned one is not worth guessing.
      if (ascii(bytes, at, "EXIF")) {
        const tiff = ascii(bytes, start, "Exif") ? start + 6 : start;
        if (tiffOrientation(bytes, tiff, end) !== 1) return "WebP con orientamento EXIF: i browser non lo mostrano tutti allo stesso modo";
      }
      at = start + length + (length & 1);
    }
  }
  return { format: "webp", width: measured.width, height: measured.height, orientation: 1, lossless };
}

function avifVariant(bytes: Uint8Array): ImageVariantSource | string {
  const linked = avifPrimaryProperties(bytes);
  const ispe = linked?.find((box) => box.type === "ispe");
  if (!linked || !ispe || ispe.end - ispe.start < 12) return "le misure non si leggono dall'intestazione";
  if (linked.some((box) => box.type === "clap" || box.type === "irot" || box.type === "imir")) return "AVIF ritagliato, ruotato o specchiato";
  const width = be32(bytes, ispe.start + 4);
  const height = be32(bytes, ispe.start + 8);
  if (!size(width, height)) return "le misure non si leggono dall'intestazione";
  for (const colr of linked.filter((box) => box.type === "colr")) {
    if (ascii(bytes, colr.start, "nclx")) {
      const primaries = be16(bytes, colr.start + 4);
      const transfer = be16(bytes, colr.start + 6);
      // BT.709 (sRGB) or unspecified primaries, an SDR transfer: anything else (P3, BT.2020, PQ, HLG) would change.
      if (![1, 2].includes(primaries) || ![1, 2, 6, 13].includes(transfer)) return "spazio colore AVIF diverso da sRGB: i colori cambierebbero";
    } else if ((ascii(bytes, colr.start, "prof") || ascii(bytes, colr.start, "rICC")) && !iccProfileIsSrgb(bytes.subarray(colr.start + 4, colr.end))) {
      return "profilo colore diverso da sRGB: i colori cambierebbero";
    }
  }
  return { format: "avif", width, height, orientation: 1, lossless: false };
}

/**
 * Whether the build can make modern variants of an image (queue B6), read from its header only, nothing decoded: the
 * source to decode, or why not, in words for the report. Never GIF or SVG, nor an animated PNG, WebP or AVIF; never a
 * file whose colors would change (a profile other than sRGB, CMYK, HDR), an AVIF with a crop, rotation or mirror, or
 * more than `maxPixels` (a decompression bomb is refused here, before any decoding). `inflate` opens a PNG's
 * compressed ICC profile; it returns null past its own limit.
 */
export function inspectImageForVariants(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array | null, maxPixels = IMAGE_VARIANT_MAX_PIXELS): ImageVariantSource | string {
  if (bytes.length < 24) return "il file non è un'immagine leggibile";
  let found: ImageVariantSource | string;
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG") && ascii(bytes, 12, "IHDR")) found = pngVariant(bytes, inflate);
  else if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "GIF: resta com'è";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) found = jpegVariant(bytes);
  else if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) found = webpVariant(bytes);
  else if (ascii(bytes, 4, "ftyp") && ascii(bytes, 8, "avis")) return "AVIF animato: le animazioni non si toccano";
  else if (ascii(bytes, 4, "ftyp") && ascii(bytes, 8, "avif")) found = avifVariant(bytes);
  else return "formato senza varianti (solo JPEG, PNG, WebP e AVIF)";
  if (typeof found === "string") return found;
  if (found.width * found.height > maxPixels) return `oltre ${Math.round(maxPixels / 1_000_000)} megapixel: non si decodifica`;
  return found;
}
