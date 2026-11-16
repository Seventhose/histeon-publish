import { latin1 } from "./isomorphic.js";

/**
 * The media types and limits a prototype shares with the converter of doc 18, kept apart from the importer (which
 * needs Node) so the converter runs in the browser too (F6).
 */

/** The largest prototype file the importer reads. */
export const PROTOTYPE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Media of a site converted in the app (doc 23 item 109): the app keeps their bytes in a folder of its own and the
 * prototype names them by hash, so a site with many images no longer passes the 32 MB of the file. `.invalid` never
 * resolves (RFC 2606): only the app's own check and import read these addresses, from its folder, never the network.
 */
export const CONVERTED_MEDIA_HOST = "media.histos.invalid";
export const convertedMediaUrl = (sha256: string): string => `https://${CONVERTED_MEDIA_HOST}/${sha256}`;
/** The hash a converted-media address names, or null when it is not one. */
export function convertedMediaHash(url: string): string | null {
  return /^https:\/\/media\.histos\.invalid\/([0-9a-f]{64})$/u.exec(url)?.[1] ?? null;
}

export type PrototypeMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "font/woff" | "font/woff2";

/** The type of a media file read from its bytes, never from its name; null for anything else. */
export function sniffPrototypeMedia(bytes: Uint8Array): PrototypeMediaType | null {
  const ascii = (start: number, length: number) => latin1(bytes.subarray(start, start + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(8, 4))) return "image/avif";
  if (bytes.length >= 4 && ascii(0, 4) === "wOFF") return "font/woff";
  if (bytes.length >= 4 && ascii(0, 4) === "wOF2") return "font/woff2";
  return null;
}
