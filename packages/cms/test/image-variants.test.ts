import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { iccProfileIsSrgb, inspectImageForVariants } from "../src/image-size.js";
import { CMS_IMAGE_SETTINGS_DEFAULTS, imageVariantWidths, normalizeCmsImageSettings } from "../src/image-variants.js";

/**
 * Queue B6: which images the build may decode and encode again without changing what the browser shows, read from
 * the header only; and the settings and widths of their variants.
 */

const bytes = (...parts: Array<number[] | string | Buffer>) => Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.isBuffer(part) ? part : Buffer.from(part))));
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const u16 = (value: number) => [(value >>> 8) & 255, value & 255];
const u32le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const u24le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
const pad = (length: number) => new Array<number>(length).fill(0);
const inflate = (data: Uint8Array) => inflateSync(data);

/** An ICC profile with this color space and description, as a `desc` (v2) or `mluc` (v4) tag. */
function icc(space: string, description: string, v4 = false): Buffer {
  const text = v4
    ? bytes("mluc", pad(4), u32(1), u32(12), "enUS", u32(description.length * 2), u32(28), Buffer.from(description, "utf16le").swap16())
    : bytes("desc", pad(4), u32(description.length + 1), description, [0], pad(80));
  const header = bytes(u32(0), pad(12), space, "XYZ ", pad(128 - 24));
  return bytes(header, u32(1), "desc", u32(144), u32(text.length), text);
}

const chunk = (type: string, data: Buffer) => bytes(u32(data.length), type, data, u32(crc32(bytes(type, data)) >>> 0));
function pngFile(width: number, height: number, ...chunks: Buffer[]): Buffer {
  return bytes([0x89], "PNG\r\n\x1a\n", chunk("IHDR", bytes(u32(width), u32(height), [8, 6, 0, 0, 0])), ...chunks, chunk("IDAT", Buffer.from(pad(10))), chunk("IEND", Buffer.alloc(0)));
}
const iccp = (profile: Buffer) => chunk("iCCP", bytes("ICC Profile", [0, 0], deflateSync(profile)));

function jpegFile(width: number, height: number, components = 3, ...segments: Buffer[]): Buffer {
  const sof = bytes([0xff, 0xc0], u16(8 + components * 3), [8], u16(height), u16(width), [components], pad(components * 3));
  return bytes([0xff, 0xd8], ...segments, sof, [0xff, 0xda], u16(4), [0, 0], pad(8));
}
const app2Icc = (profile: Buffer, sequence = 1, count = 1) => bytes([0xff, 0xe2], u16(profile.length + 16), "ICC_PROFILE", [0, sequence, count], profile);

function webpFile(flags: number, ...chunks: Buffer[]): Buffer {
  const body = bytes("WEBP", "VP8X", u32le(10), [flags, 0, 0, 0], u24le(639), u24le(479), ...chunks, "VP8 ", u32le(10), pad(10));
  return bytes("RIFF", u32le(body.length), body);
}
const riffChunk = (type: string, data: Buffer) => bytes(type, u32le(data.length), data, data.length % 2 ? [0] : []);

const box = (type: string, ...content: Array<number[] | string | Buffer>) => {
  const body = bytes(...content);
  return bytes(u32(body.length + 8), type, body);
};
const fullBox = (type: string, ...content: Array<number[] | string | Buffer>) => box(type, [0, 0, 0, 0], ...content);
function avifFile(width: number, height: number, extra: Buffer[] = [], brand = "avif"): Buffer {
  const properties = [fullBox("ispe", u32(width), u32(height)), ...extra];
  const primary = properties.map((_, index) => 0x81 + index);
  const ipma = fullBox("ipma", u32(1), u16(1), [primary.length, ...primary]);
  const meta = fullBox("meta", fullBox("hdlr", pad(4), "pict", pad(13)), fullBox("pitm", u16(1)), box("iprp", box("ipco", ...properties), ipma));
  return bytes(box("ftyp", brand, u32(0), "mif1miaf"), meta, box("mdat", pad(16)));
}
const nclx = (primaries: number, transfer: number) => box("colr", "nclx", u16(primaries), u16(transfer), u16(1), [0x80]);

describe("quali immagini hanno varianti: solo l'intestazione, nulla di decodificato (B6)", () => {
  it("JPEG, PNG, WebP e AVIF fermi e sRGB: le misure salvate, l'orientamento, se sono senza perdita", () => {
    expect(inspectImageForVariants(jpegFile(800, 600), inflate)).toEqual({ format: "jpeg", width: 800, height: 600, orientation: 1, lossless: false });
    expect(inspectImageForVariants(jpegFile(800, 600, 1), inflate)).toMatchObject({ format: "jpeg" });
    expect(inspectImageForVariants(pngFile(320, 200), inflate)).toEqual({ format: "png", width: 320, height: 200, orientation: 1, lossless: true });
    expect(inspectImageForVariants(webpFile(0), inflate)).toEqual({ format: "webp", width: 640, height: 480, orientation: 1, lossless: false });
    expect(inspectImageForVariants(avifFile(1200, 900), inflate)).toEqual({ format: "avif", width: 1200, height: 900, orientation: 1, lossless: false });
    expect(inspectImageForVariants(avifFile(1200, 900, [nclx(1, 13)]), inflate)).toMatchObject({ format: "avif" });
  });

  it("le animazioni non si toccano: GIF, PNG animato, WebP animato, AVIF animato", () => {
    expect(inspectImageForVariants(bytes("GIF89a", pad(30)), inflate)).toBe("GIF: resta com'è");
    expect(inspectImageForVariants(pngFile(320, 200, chunk("acTL", Buffer.from(pad(8)))), inflate)).toBe("PNG animato: le animazioni non si toccano");
    expect(inspectImageForVariants(webpFile(0x02), inflate)).toBe("WebP animato: le animazioni non si toccano");
    expect(inspectImageForVariants(avifFile(1200, 900, [], "avis"), inflate)).toBe("AVIF animato: le animazioni non si toccano");
    expect(inspectImageForVariants(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), inflate)).toBe("formato senza varianti (solo JPEG, PNG, WebP e AVIF)");
  });

  it("un profilo colore diverso da sRGB, un JPEG CMYK o un AVIF HDR cambierebbero i colori: restano originali", () => {
    const p3 = icc("RGB ", "Display P3");
    const srgb = icc("RGB ", "sRGB IEC61966-2.1");
    expect(iccProfileIsSrgb(srgb)).toBe(true);
    expect(iccProfileIsSrgb(icc("RGB ", "sRGB built-in", true))).toBe(true);
    expect(iccProfileIsSrgb(p3)).toBe(false);
    expect(iccProfileIsSrgb(icc("GRAY", "sRGB"))).toBe(false);
    expect(inspectImageForVariants(jpegFile(800, 600, 3, app2Icc(srgb)), inflate)).toMatchObject({ format: "jpeg" });
    expect(inspectImageForVariants(jpegFile(800, 600, 3, app2Icc(p3)), inflate)).toBe("profilo colore diverso da sRGB: i colori cambierebbero");
    // A profile in two APP2 chunks is joined in its sequence order.
    expect(inspectImageForVariants(jpegFile(800, 600, 3, app2Icc(p3.subarray(100), 2, 2), app2Icc(p3.subarray(0, 100), 1, 2)), inflate)).toBe("profilo colore diverso da sRGB: i colori cambierebbero");
    expect(inspectImageForVariants(jpegFile(800, 600, 4), inflate)).toBe("JPEG in CMYK: i colori cambierebbero");
    expect(inspectImageForVariants(pngFile(320, 200, iccp(srgb)), inflate)).toMatchObject({ format: "png" });
    expect(inspectImageForVariants(pngFile(320, 200, iccp(p3)), inflate)).toBe("profilo colore diverso da sRGB: i colori cambierebbero");
    expect(inspectImageForVariants(pngFile(320, 200, chunk("gAMA", Buffer.from(u32(100000)))), inflate)).toBe("gamma PNG diversa da sRGB: i colori cambierebbero");
    expect(inspectImageForVariants(pngFile(320, 200, chunk("gAMA", Buffer.from(u32(45455)))), inflate)).toMatchObject({ format: "png" });
    // sRGB says it: a gAMA beside it is not read, as in Chromium.
    expect(inspectImageForVariants(pngFile(320, 200, chunk("sRGB", Buffer.from([0])), chunk("gAMA", Buffer.from(u32(100000)))), inflate)).toMatchObject({ format: "png" });
    expect(inspectImageForVariants(webpFile(0x20, riffChunk("ICCP", p3)), inflate)).toBe("profilo colore diverso da sRGB: i colori cambierebbero");
    expect(inspectImageForVariants(webpFile(0x20, riffChunk("ICCP", srgb)), inflate)).toMatchObject({ format: "webp" });
    expect(inspectImageForVariants(avifFile(1200, 900, [nclx(12, 13)]), inflate)).toBe("spazio colore AVIF diverso da sRGB: i colori cambierebbero");
    expect(inspectImageForVariants(avifFile(1200, 900, [nclx(9, 16)]), inflate)).toBe("spazio colore AVIF diverso da sRGB: i colori cambierebbero");
    expect(inspectImageForVariants(avifFile(1200, 900, [box("colr", "prof", p3)]), inflate)).toBe("profilo colore diverso da sRGB: i colori cambierebbero");
  });

  it("un AVIF ritagliato, ruotato o specchiato non si indovina; un WebP girato dal suo EXIF nemmeno", () => {
    expect(inspectImageForVariants(avifFile(1200, 900, [box("irot", [1])]), inflate)).toBe("AVIF ritagliato, ruotato o specchiato");
    expect(inspectImageForVariants(avifFile(1200, 900, [box("imir", [0])]), inflate)).toBe("AVIF ritagliato, ruotato o specchiato");
    expect(inspectImageForVariants(avifFile(1200, 900, [box("clap", pad(32))]), inflate)).toBe("AVIF ritagliato, ruotato o specchiato");
    const exif = bytes("Exif\0\0", "MM", u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(6), [0, 0], u32(0));
    expect(inspectImageForVariants(webpFile(0x08, riffChunk("EXIF", exif)), inflate)).toBe("WebP con orientamento EXIF: i browser non lo mostrano tutti allo stesso modo");
  });

  it("l'orientamento EXIF di JPEG e PNG passa al codificatore con le misure salvate", () => {
    const tiff = bytes("MM", u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(6), [0, 0], u32(0));
    const app1 = bytes([0xff, 0xe1], u16(tiff.length + 8), "Exif\0\0", tiff);
    expect(inspectImageForVariants(jpegFile(800, 600, 3, app1), inflate)).toEqual({ format: "jpeg", width: 800, height: 600, orientation: 6, lossless: false });
    expect(inspectImageForVariants(pngFile(320, 200, chunk("eXIf", tiff)), inflate)).toMatchObject({ width: 320, height: 200, orientation: 6 });
  });

  it("una bomba di decompressione si rifiuta dall'intestazione: oltre 40 megapixel non si decodifica", () => {
    // 65,535 × 65,535 pixels in a few hundred bytes: 17 GB once decoded.
    expect(inspectImageForVariants(pngFile(65_535, 65_535), inflate)).toBe("oltre 40 megapixel: non si decodifica");
    expect(inspectImageForVariants(jpegFile(8000, 6000), inflate)).toBe("oltre 40 megapixel: non si decodifica");
    expect(inspectImageForVariants(jpegFile(8000, 5000), inflate)).toMatchObject({ format: "jpeg" });
    expect(inspectImageForVariants(jpegFile(1000, 1000), inflate, 999_999)).toBe("oltre 1 megapixel: non si decodifica");
    // A compressed ICC profile that would inflate past its limit is no profile: the file is not decoded.
    expect(inspectImageForVariants(pngFile(320, 200, chunk("iCCP", bytes("x", [0, 0], deflateSync(Buffer.alloc(8 * 1024 * 1024))))), (data) => {
      try { return inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 }); } catch { return null; }
    })).toBe("profilo colore diverso da sRGB: i colori cambierebbero");
  });

  it("intestazioni rotte o troncate danno un motivo, mai un'eccezione", () => {
    for (const file of [Buffer.alloc(0), Buffer.from("RIFF"), jpegFile(0, 600), pngFile(0, 10), avifFile(0, 0), bytes([0xff, 0xd8, 0xff, 0xc0, 0, 1])]) {
      expect(typeof inspectImageForVariants(file, inflate)).toBe("string");
    }
  });
});

describe("impostazioni e larghezze delle varianti (B6)", () => {
  it("valori predefiniti, normalizzazione e rifiuti con il perché", () => {
    expect(normalizeCmsImageSettings(undefined)).toEqual({ variants: true, widths: [480, 960, 1600], quality: { avif: 60, jxl: 75, webp: 75 } });
    expect(normalizeCmsImageSettings({ widths: [960, 480, 960], quality: { jxl: 80 } })).toEqual({ variants: true, widths: [480, 960], quality: { avif: 60, jxl: 80, webp: 75 } });
    expect(normalizeCmsImageSettings({ variants: false })).toMatchObject({ variants: false });
    expect(() => normalizeCmsImageSettings({ variants: "sì" })).toThrow(TypeError);
    expect(() => normalizeCmsImageSettings({ widths: [] })).toThrow(/da 1 a 6/u);
    expect(() => normalizeCmsImageSettings({ widths: [4000] })).toThrow(/fra 64 e 2560/u);
    expect(() => normalizeCmsImageSettings({ quality: { webp: 101 } })).toThrow(/WEBP è un numero intero da 1 a 100/u);
    expect(Object.isFrozen(CMS_IMAGE_SETTINGS_DEFAULTS)).toBe(true);
  });

  it("mai ingrandite: le larghezze sotto quella del file, poi il file stesso fino a 2560 px e 8 megapixel", () => {
    expect(imageVariantWidths(1200, 800, CMS_IMAGE_SETTINGS_DEFAULTS)).toEqual([480, 960, 1200]);
    expect(imageVariantWidths(400, 300, CMS_IMAGE_SETTINGS_DEFAULTS)).toEqual([400]);
    expect(imageVariantWidths(1600, 900, CMS_IMAGE_SETTINGS_DEFAULTS)).toEqual([480, 960, 1600]);
    expect(imageVariantWidths(6000, 4000, CMS_IMAGE_SETTINGS_DEFAULTS)).toEqual([480, 960, 1600, 2560]);
    // A tall panorama: 2000 × 10000 would be 20 megapixels at its own width; the top is 1264 wide (8 MP).
    expect(imageVariantWidths(2000, 10_000, CMS_IMAGE_SETTINGS_DEFAULTS)).toEqual([480, 960, 1264]);
  });
});
