import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { imageIntegrityProblem, imageSize } from "../src/image-size.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const bytes = (...parts: Array<number[] | string | Buffer>) => Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.isBuffer(part) ? part : Buffer.from(part))));
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const u16le = (value: number) => [value & 255, (value >>> 8) & 255];
const u24le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
const pad = (length: number) => new Array<number>(length).fill(0);

// A whole file, IEND included (doc 23 item 241: the import refuses an image that cannot be whole).
const PNG_640x480 = bytes([0x89], "PNG\r\n\x1a\n", u32(13), "IHDR", u32(640), u32(480), [8, 6, 0, 0, 0], pad(4), u32(0), "IEND", pad(4));
/** A GIF screen of 300×200 and its first frame (left, top, width, height). */
const gifWithFrame = (left: number, top: number, width: number, height: number) => bytes("GIF89a", u16le(300), u16le(200), [0, 0, 0], [0x21, 0xf9, 4, 0, 0, 0, 0, 0], [0x2c], u16le(left), u16le(top), u16le(width), u16le(height), [0], pad(8));
const GIF_300x200 = gifWithFrame(0, 0, 300, 200);
const JPEG_800x600 = bytes([0xff, 0xd8, 0xff, 0xe0], [0, 16], "JFIF\0", pad(9), [0xff, 0xc0, 0, 17, 8], [600 >> 8, 600 & 255, 800 >> 8, 800 & 255], pad(20));
const WEBP_X_1920x1080 = bytes("RIFF", u32(0), "WEBPVP8X", [10, 0, 0, 0], [0, 0, 0, 0], u24le(1919), u24le(1079), pad(10));
const WEBP_L_100x50 = bytes("RIFF", u32(0), "WEBPVP8L", [5, 0, 0, 0], [0x2f], [(99) & 255, ((99 >> 8) & 0x3f) | ((49 & 3) << 6), (49 >> 2) & 255, (49 >> 10) & 0x0f], pad(10));
const u16 = (value: number) => [(value >>> 8) & 255, value & 255];
const box = (type: string, ...content: Array<number[] | string | Buffer>) => {
  const body = bytes(...content);
  return bytes(u32(body.length + 8), type, body);
};
const fullBox = (type: string, ...content: Array<number[] | string | Buffer>) => box(type, [0, 0, 0, 0], ...content);
/** An AVIF header: the primary item's properties (ispe, maybe irot) and, before them, a thumbnail's ispe. */
function avifHeader(width: number, height: number, extra: Buffer[] = []): Buffer {
  const properties = [fullBox("ispe", u32(160), u32(120)), fullBox("ispe", u32(width), u32(height)), ...extra];
  // Item 2, the thumbnail, has property 1; item 1, the primary, has 2 and the extras.
  const primary = [0x82, ...extra.map((_, index) => 0x83 + index)];
  const ipma = fullBox("ipma", u32(2), u16(2), [1, 0x81], u16(1), [primary.length, ...primary]);
  const meta = fullBox("meta", fullBox("hdlr", pad(4), "pict", pad(13)), fullBox("pitm", u16(1)), box("iprp", box("ipco", ...properties), ipma));
  return bytes(box("ftyp", "avif", u32(0), "mif1miaf"), meta, box("mdat", pad(16)));
}
const AVIF_1200x900 = avifHeader(1200, 900);
/** A JPEG whose EXIF says how to turn it: the browser shows it with the sides swapped for 5–8. */
/** TIFF data with these IFD0 entries: [tag, type, count, value]. */
function tiff(order: "MM" | "II", entries: Array<[number, number, number, number]>): Buffer {
  const big = order === "MM";
  const w16 = (value: number) => (big ? u16(value) : u16le(value));
  const w32 = (value: number) => (big ? u32(value) : [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
  return bytes(order, w16(42), w32(8), w16(entries.length), ...entries.map(([tag, type, count, value]) => bytes(w16(tag), w16(type), w32(count), w16(value), [0, 0])), w32(0));
}
const app1 = (data: Buffer) => bytes([0xff, 0xe1], u16(data.length + 2), data);
const SOF_800x600 = bytes([0xff, 0xc0, 0, 17, 8], u16(600), u16(800), pad(10));
const SOS = bytes([0xff, 0xda], u16(4), [0, 0], pad(8));
function jpegWithOrientation(orientation: number, order: "MM" | "II"): Buffer {
  return bytes([0xff, 0xd8], app1(bytes("Exif\0\0", tiff(order, [[0x0112, 3, 1, orientation]]))), SOF_800x600, SOS);
}
/** A PNG chunk with its CRC (or a wrong one). */
const chunk = (type: string, data: Buffer, damaged = false) => bytes(u32(data.length), type, data, u32((crc32(bytes(type, data)) ^ (damaged ? 1 : 0)) >>> 0));
/** A PNG of 320×200 with an eXIf chunk before or after the image data, maybe after other chunks. */
function pngWithExif(orientation: number, where: "before" | "after", options: { before?: number; damaged?: boolean } = {}): Buffer {
  const exif = chunk("eXIf", tiff("MM", [[0x0112, 3, 1, orientation]]), options.damaged);
  const idat = chunk("IDAT", Buffer.from(pad(10)));
  const text = Array.from({ length: options.before ?? 0 }, () => chunk("tEXt", Buffer.from("k\0v", "latin1")));
  return bytes([0x89], "PNG\r\n\x1a\n", chunk("IHDR", bytes(u32(320), u32(200), [8, 6, 0, 0, 0])), ...text, where === "before" ? exif : idat, where === "before" ? idat : exif);
}

describe("misure delle immagini (B6)", () => {
  it("legge larghezza e altezza da PNG, GIF, JPEG, WebP e AVIF", () => {
    expect(imageSize(PNG_640x480)).toEqual({ width: 640, height: 480 });
    expect(imageSize(GIF_300x200)).toEqual({ width: 300, height: 200 });
    expect(imageSize(JPEG_800x600)).toEqual({ width: 800, height: 600 });
    expect(imageSize(WEBP_X_1920x1080)).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(WEBP_L_100x50)).toEqual({ width: 100, height: 50 });
    expect(imageSize(AVIF_1200x900)).toEqual({ width: 1200, height: 900 });
  });

  it("misura come la mostra il browser: orientamento EXIF dei JPEG, elemento primario e rotazione degli AVIF", () => {
    expect(imageSize(jpegWithOrientation(1, "MM"))).toEqual({ width: 800, height: 600 });
    expect(imageSize(jpegWithOrientation(6, "MM"))).toEqual({ width: 600, height: 800 });
    expect(imageSize(jpegWithOrientation(8, "II"))).toEqual({ width: 600, height: 800 });
    expect(imageSize(jpegWithOrientation(3, "II"))).toEqual({ width: 800, height: 600 });
    // The thumbnail's ispe comes first in the file: the primary item's is the one that counts.
    expect(imageSize(avifHeader(1200, 900, [box("irot", [1])]))).toEqual({ width: 900, height: 1200 });
    expect(imageSize(avifHeader(1200, 900, [box("irot", [2])]))).toEqual({ width: 1200, height: 900 });
    // A crop is not guessed.
    expect(imageSize(avifHeader(1200, 900, [box("clap", pad(32))]))).toBeNull();
    // PNG: an eXIf before the image data turns it; one after is ignored, as browsers do.
    expect(imageSize(pngWithExif(6, "before"))).toEqual({ width: 200, height: 320 });
    expect(imageSize(pngWithExif(6, "after"))).toEqual({ width: 320, height: 200 });
    // However many chunks come first; a damaged eXIf is ignored, as browsers ignore it.
    expect(imageSize(pngWithExif(6, "before", { before: 1100 }))).toEqual({ width: 200, height: 320 });
    expect(imageSize(pngWithExif(6, "before", { damaged: true }))).toEqual({ width: 320, height: 200 });
  });

  it("legge l'EXIF come Chromium: il primo segmento EXIF, anche dopo il frame, e solo un'orientazione SHORT valida", () => {
    // Only the first EXIF segment counts.
    expect(imageSize(bytes([0xff, 0xd8], app1(bytes("Exif\0\0", tiff("MM", [[0x0112, 3, 1, 1]]))), app1(bytes("Exif\0\0", tiff("MM", [[0x0112, 3, 1, 6]]))), SOF_800x600, SOS))).toEqual({ width: 800, height: 600 });
    // EXIF after the frame header, before the scan.
    expect(imageSize(bytes([0xff, 0xd8], SOF_800x600, app1(bytes("Exif\0\0", tiff("II", [[0x0112, 3, 1, 6]]))), SOS))).toEqual({ width: 600, height: 800 });
    // Any byte after "Exif\0".
    expect(imageSize(bytes([0xff, 0xd8], app1(bytes("Exif\0\xff", tiff("MM", [[0x0112, 3, 1, 6]]))), SOF_800x600, SOS))).toEqual({ width: 600, height: 800 });
    // A first EXIF segment with unreadable TIFF data is still the one: no orientation, the later one does not count.
    for (const first of [bytes("Exif\0\0MM"), bytes("Exif\0\0MM\0+"), bytes("Exif\0\0", pad(10))]) {
      expect(imageSize(bytes([0xff, 0xd8], app1(first), app1(bytes("Exif\0\0", tiff("MM", [[0x0112, 3, 1, 6]]))), SOF_800x600, SOS))).toEqual({ width: 800, height: 600 });
    }
    // Too short to be one (under 7 bytes): skipped.
    expect(imageSize(bytes([0xff, 0xd8], app1(bytes("Exif\0")), app1(bytes("Exif\0\0", tiff("MM", [[0x0112, 3, 1, 6]]))), SOF_800x600, SOS))).toEqual({ width: 600, height: 800 });
    // A LONG, or a SHORT with two values, is not the orientation; the next valid one is.
    expect(imageSize(bytes([0xff, 0xd8], app1(bytes("Exif\0\0", tiff("MM", [[0x0112, 4, 1, 6], [0x0112, 3, 2, 6], [0x0112, 3, 1, 9], [0x0112, 3, 1, 8]]))), SOF_800x600, SOS))).toEqual({ width: 600, height: 800 });
    expect(imageSize(bytes([0xff, 0xd8], app1(bytes("Exif\0\0", tiff("MM", [[0x0112, 4, 1, 6]]))), SOF_800x600, SOS))).toEqual({ width: 800, height: 600 });
  });

  it("non indovina dove il browser mostra altro: AVIF animati, proprietà oltre l'elenco, GIF con il primo frame fuori dallo schermo", () => {
    expect(imageSize(Buffer.concat([box("ftyp", "avis", u32(0), "avifmif1"), avifHeader(1200, 900).subarray(box("ftyp", "avif", u32(0), "mif1miaf").length)]))).toBeNull();
    // ipma points at property 3 of a list of two.
    const pointing = avifHeader(1200, 900);
    const ipma = pointing.indexOf(Buffer.from("ipma"));
    // After the type: version and flags, the count, the thumbnail's entry (item, count, one index), the primary's item and count.
    pointing[ipma + 4 + 4 + 4 + 4 + 2 + 1] = 0x83;
    expect(imageSize(pointing)).toBeNull();
    expect(imageSize(gifWithFrame(10, 10, 300, 200))).toBeNull();
    expect(imageSize(gifWithFrame(10, 10, 100, 100))).toEqual({ width: 300, height: 200 });
  });

  it("non indovina: file troncati, misure fuori scala o formati sconosciuti danno null", () => {
    expect(imageSize(PNG_640x480.subarray(0, 20))).toBeNull();
    expect(imageSize(bytes([0x89], "PNG\r\n\x1a\n", u32(13), "IHDR", u32(0), u32(480), pad(20)))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xda], pad(30)))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1], pad(30)))).toBeNull();
    expect(imageSize(bytes("<svg></svg>", pad(20)))).toBeNull();
    // An AVIF without its primary item, or with boxes that overrun the file.
    expect(imageSize(bytes(box("ftyp", "avif", u32(0)), fullBox("meta", fullBox("pitm", u16(1)))))).toBeNull();
    expect(imageSize(bytes(box("ftyp", "avif", u32(0)), u32(4096), "meta", pad(40)))).toBeNull();
    // EXIF that points outside its segment keeps the frame's size.
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xe1], u16(16), "Exif\0\0MM", u16(42), u32(4000), [0xff, 0xc0, 0, 17, 8], u16(600), u16(800), pad(20)))).toEqual({ width: 800, height: 600 });
  });

  it("all'import il rapporto dà le misure delle immagini senza width e height, e il markup resta com'è", async () => {
    const example = await readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
    const html = example
      .replace(/"data": "data:image\/png;base64,([^"]+)"(, "alt": "Ehi, con cornice")/u, `"data": "data:image/png;base64,${PNG_640x480.toString("base64")}"$2`)
      .replace('{ "name": "texture",', `{ "name": "nebbia", "data": "data:image/avif;base64,${avifHeader(1200, 900, [box("clap", pad(32))]).toString("base64")}" },\n  { "name": "texture",`)
      .replace(/(<template data-histos="page" data-slug="home"[^>]*>)/u, '$1<p><img src="asset:ehi" alt="Senza misure"><img src="asset:ehi" alt="Con misure" width="64" height="48"><img src="asset:ehi" alt="Solo larghezza" width="320"><img src="asset:nebbia" alt="Nebbia"><img src="asset:ehi" alt="Percentuale" width="100%" height="auto"><img src="asset:nebbia" alt="Nebbia larga" width="100"><img src="asset:ehi" alt="Nude" width height><img src="asset:ehi" alt="Due punti" width="64.0.1" height="48"></p>');
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-image-size-"));
    roots.push(root);
    const built = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root));
    const home = built.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === "home");
    const content = String(home?.payload.content ?? "");
    // Nothing added: width and height change the layout where the CSS sets only one side.
    expect(content).not.toContain('"640"');
    const warning = built.report.warnings.find((item) => item.startsWith("Immagini:")) ?? "";
    // The fixture's own two images and six new ones; those with both sides are not counted. Upper-case names never
    // get here: the transfer profile (A6) refuses them.
    // Sides the browser cannot read as a size (100%, auto) do not count either.
    // A bare attribute is no size either; "64.0.1" reads as 64, as in browsers.
    expect(warning).toMatch(/^Immagini: 8 senza width o height \(in /u);
    expect(warning).toContain('ehi width="640" height="480"');
    // One side written: the other in proportion, not the file's pair.
    expect(warning).toContain('ehi height="240" (con il suo width="320")');
    // One line per file whose size is unknown, however it is used.
    expect(warning.match(/nebbia: misure non leggibili dal file/gu)).toHaveLength(1);
    // No global sheet of its own.
    const styles = built.profile.entities.find((entity) => entity.kind === "styles");
    expect(JSON.stringify(styles?.payload)).not.toContain("img[width]");
    // Media used only in CSS are used: the styles are read before the unused ones are listed.
    expect(built.report.warnings.join("\n")).not.toMatch(/Il media texture non è usato/u);
  });

  it("senza immagini da misurare il rapporto non ne parla", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-image-size-"));
    roots.push(root);
    const html = (await readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8")).replaceAll('<img src="asset:ehi"', '<img width="32" height="32" src="asset:ehi"');
    const built = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root));
    expect(built.report.warnings.join("\n")).not.toMatch(/^Immagini:/mu);
  });
});

describe("immagini che non possono essere intere (doc 23, voce 241)", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4YaMBAAL8AS9dV6R3AAAAAElFTkSuQmCC", "base64");
  const webp = Buffer.from("UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoQAAwAAoBCJaACdLoAA5gA/vD6K/8Q50OdDmtz15T4laAA", "base64");
  const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  it("un'immagine intera passa", () => {
    expect(imageIntegrityProblem(png)).toBeNull();
    expect(imageIntegrityProblem(webp)).toBeNull();
    expect(imageIntegrityProblem(gif)).toBeNull();
    expect(imageIntegrityProblem(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x01, 0xff, 0xd9]))).toBeNull();
  });
  it("una tagliata o con l'intestazione inventata dice perché", () => {
    expect(imageIntegrityProblem(png.subarray(0, png.length - 12))).toBe("manca la fine dell'immagine (IEND)");
    expect(imageIntegrityProblem(webp.subarray(0, 40))).toBe("l'intestazione RIFF dice 60 byte, il file ne ha 40");
    const lying = Buffer.from(webp);
    lying.writeUInt32LE(40, 4);
    lying.writeUInt32LE(40, 16);
    expect(imageIntegrityProblem(Buffer.concat([lying.subarray(0, 48)]))).toBe("il blocco VP8 va oltre la fine del file");
    expect(imageIntegrityProblem(gif.subarray(0, gif.length - 1))).toBe("manca la fine del GIF");
    expect(imageIntegrityProblem(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]))).toBe("non ha i dati dell'immagine");
    expect(imageIntegrityProblem(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x01]))).toBe("manca la fine del JPEG");
  });
});
