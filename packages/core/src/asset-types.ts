import path from "node:path";

/**
 * The extension of a bundle file as Cloudflare reads it for the asset hash: what follows the last dot of the file name,
 * without the dot ("" for `LICENSE`, `CNAME` or `a.b/file`). The manifest and the upload must use this same function,
 * or Cloudflare asks for a hash the upload does not have.
 */
export function assetExtension(filePath: string): string {
  return path.posix.extname(filePath).slice(1);
}

const TEXT = "; charset=utf-8";
const TYPES: Readonly<Record<string, string>> = {
  html: `text/html${TEXT}`, htm: `text/html${TEXT}`, css: `text/css${TEXT}`, js: `text/javascript${TEXT}`, mjs: `text/javascript${TEXT}`,
  json: `application/json${TEXT}`, map: `application/json${TEXT}`, webmanifest: `application/manifest+json${TEXT}`,
  xml: `application/xml${TEXT}`, txt: `text/plain${TEXT}`, csv: `text/csv${TEXT}`, md: `text/markdown${TEXT}`, ics: `text/calendar${TEXT}`,
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", jxl: "image/jxl", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf", wasm: "application/wasm", zip: "application/zip", epub: "application/epub+zip",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
  m4a: "audio/mp4", vtt: `text/vtt${TEXT}`,
};

/**
 * The Content-Type Cloudflare serves for an uploaded asset: it takes the type of the upload part, so every part must
 * carry the type of its file (Wrangler does the same from the extension). Unknown extensions stay a download.
 */
export function assetContentType(filePath: string): string {
  return TYPES[assetExtension(filePath).toLowerCase()] ?? "application/octet-stream";
}
