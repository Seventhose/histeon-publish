import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";

/**
 * Google Fonts of a converted site as project media (queue B5), only on the user's request: the WOFF2 files of the
 * families the site links, with a local @font-face, so visitors load nothing from Google. Each family is downloaded
 * only if its licence is verified as OFL, Apache 2.0 or UFL in the official google/fonts repository, family by family.
 * Only three hosts are ever contacted, over HTTPS, through the crawler's safe client (public addresses, no
 * redirects, size and time limits).
 */

export type FontFetcher = (url: string, options: { maxBytes: number; accept: string; userAgent?: string; signal?: AbortSignal }) => Promise<{ status: number; body: Uint8Array }>;

const CSS_HOST = "fonts.googleapis.com";
const FILE_HOST = "fonts.gstatic.com";
const LICENSE_HOST = "raw.githubusercontent.com";
const ALLOWED_HOSTS = new Set([CSS_HOST, FILE_HOST, LICENSE_HOST]);
/** A current browser's name: Google serves WOFF2 only to browsers it knows. */
const BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_FAMILIES = 8;
const MAX_FILES = 40;
const MAX_FONT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
/** Always downloaded; any other subset (greek, cyrillic…) only when the text of the site uses its characters. */
const KEPT_SUBSETS = new Set(["latin", "latin-ext"]);
/** Past Latin Extended-B: the characters that say which other subsets a text needs. */
const FIRST_OTHER_SCRIPT = 0x250;
const LICENSES: ReadonlyArray<{ folder: string; value: string; name: string }> = [
  { folder: "ofl", value: "OFL", name: "SIL Open Font License" },
  { folder: "apache", value: "APACHE2", name: "Apache 2.0" },
  { folder: "ufl", value: "UFL", name: "Ubuntu Font Licence" },
];

/** The default fetcher: HTTPS to the three hosts only, through the safe client. */
export const fetchGoogleFontResource: FontFetcher = async (input, options) => {
  const url = new URL(input);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new HistosPublishError("Indirizzo non ammesso per i font.", "fonts-url-invalid", 2);
  }
  const client = new SafeHttpClient({
    origin: url.origin,
    userAgent: options.userAgent ?? "HistosPublish-Fonts/1.0",
    timeoutMs: 20_000,
    delayMs: 0,
    publicOnly: true,
    strictOrigin: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const response = await client.get(url, { maxBytes: options.maxBytes, bypassCache: true, headers: { Accept: options.accept } });
  return { status: response.status, body: response.body };
};

/** The families named by Google Fonts stylesheet addresses (`css2?family=Inter:wght@400;700&family=Roboto+Slab`). */
export function googleFontFamilies(cssUrls: readonly string[]): string[] {
  const families = new Set<string>();
  for (const value of cssUrls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.hostname !== CSS_HOST || !/^\/css2?$/u.test(url.pathname)) continue;
    for (const spec of url.searchParams.getAll("family")) {
      for (const part of spec.split("|")) {
        const name = part.split(":")[0]?.trim() ?? "";
        if (/^[A-Za-z0-9 ]{1,60}$/u.test(name)) families.add(name);
      }
    }
  }
  return [...families].slice(0, MAX_FAMILIES);
}

/** The family's licence as the google/fonts repository states it (folder and METADATA.pb agree), or null. */
async function verifiedLicense(family: string, fetcher: FontFetcher, signal?: AbortSignal): Promise<{ value: string; name: string } | null> {
  const folder = family.toLowerCase().replace(/[^a-z0-9]/gu, "");
  for (const license of LICENSES) {
    let response: { status: number; body: Uint8Array };
    try {
      response = await fetcher(`https://${LICENSE_HOST}/google/fonts/main/${license.folder}/${folder}/METADATA.pb`, { maxBytes: 256 * 1024, accept: "text/plain", ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }
    if (response.status !== 200) continue;
    const metadata = new TextDecoder().decode(response.body);
    const name = /^name:\s*"([^"]+)"/mu.exec(metadata)?.[1];
    const declared = /^license:\s*"([^"]+)"/mu.exec(metadata)?.[1];
    if (declared === license.value && name?.toLowerCase() === family.toLowerCase()) return { value: license.value, name: license.name };
  }
  return null;
}

/** The code points past Latin of a text, for `usesRange()`; at most 4096 different ones are remembered. */
export function otherScriptCodePoints(texts: Iterable<string>): Set<number> {
  const found = new Set<number>();
  for (const text of texts) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code >= FIRST_OTHER_SCRIPT && found.size < 4096) found.add(code);
    }
  }
  return found;
}

/** Whether a `unicode-range` value (`U+0370-0377, U+03A3-03FF, U+4??`) covers one of the code points. */
function usesRange(range: string, codePoints: ReadonlySet<number>): boolean {
  if (!codePoints.size) return false;
  for (const part of range.split(",")) {
    const match = /^U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/u.exec(part.trim());
    if (!match) continue;
    const from = Number.parseInt((match[1] ?? "").replaceAll("?", "0"), 16);
    const to = match[2] ? Number.parseInt(match[2], 16) : Number.parseInt((match[1] ?? "").replaceAll("?", "F"), 16);
    for (const code of codePoints) if (code >= from && code <= to) return true;
  }
  return false;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

/** Why a download failed, for a note: short, one line. */
function reason(error: unknown): string {
  return (error instanceof Error && error.message ? error.message : "errore di rete").replace(/\s+/gu, " ").slice(0, 120);
}

/**
 * Downloads the WOFF2 files of the verified families of `cssUrls`. Returns the files (paths under `histos-fonts/`), a
 * stylesheet `histos-fonts/google-fonts.css` that points to them, and what was done or skipped. The latin subsets
 * always; another subset only when `codePoints` (the characters of the site's pages, `otherScriptCodePoints()`) holds
 * one of its `unicode-range`: a page with Greek words gets the family's Greek file, and no site gets files it never shows.
 *
 * `missing` are the notes of what the site asked for and did not get (the page will show a fallback font): nothing of a
 * verified family is left out in silence. A stylesheet or a file that fails is asked for once more. Google writes a
 * file's address either as `/s/<family>/<version>/<name>.woff2` or as `/l/font?kit=…` (a file cut on request, as with
 * `text=`): both are read, and what makes a file a font is its host and its first bytes, not its name.
 */
export async function downloadGoogleFonts(input: { cssUrls: readonly string[]; fetcher?: FontFetcher; signal?: AbortSignal; codePoints?: ReadonlySet<number>; retryDelayMs?: number }): Promise<{ files: Array<{ path: string; bytes: Uint8Array }>; notes: string[]; missing: string[] }> {
  const signal = input.signal ? { signal: input.signal } : {};
  // One more try after a pause: a single lost connection must not leave a family without its files.
  const fetcher: FontFetcher = async (url, options) => {
    const ask = input.fetcher ?? fetchGoogleFontResource;
    try {
      const response = await ask(url, options);
      if (response.status < 500 && response.status !== 429) return response;
    } catch (error) {
      if (input.signal?.aborted || (error instanceof HistosPublishError && error.code === "fonts-url-invalid")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs ?? 400));
    input.signal?.throwIfAborted();
    return ask(url, options);
  };
  const noteSet = new Set<string>();
  const notes = { push: (note: string) => { noteSet.add(note); } };
  const unreadable = new Map<string, number>();
  const families = googleFontFamilies(input.cssUrls);
  const verified = new Map<string, string>();
  for (const family of families) {
    const license = await verifiedLicense(family, fetcher, input.signal);
    if (license) verified.set(family.toLowerCase(), license.name);
    else notes.push(`font «${family}» non scaricato: licenza non verificata come OFL, Apache o UFL`);
  }
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const faces: string[] = [];
  const seen = new Set<string>();
  const withFiles = new Set<string>();
  let total = 0;
  for (const cssUrl of input.cssUrls) {
    if (!verified.size) break;
    let url: URL;
    try {
      url = new URL(cssUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== CSS_HOST || !/^\/css2?$/u.test(url.pathname)) continue;
    let css: string;
    try {
      const response = await fetcher(url.href, { maxBytes: 512 * 1024, accept: "text/css", userAgent: BROWSER_AGENT, ...signal });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      css = new TextDecoder().decode(response.body);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      notes.push(`foglio dei font non scaricato (${reason(error)})`);
      continue;
    }
    // Google writes each face after a comment naming its subset.
    for (const match of css.matchAll(/(?:\/\*\s*([a-z-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/gu)) {
      const subset = match[1] ?? "latin";
      const body = match[2] ?? "";
      const family = /font-family:\s*['"]?([^;'"]+)['"]?;/u.exec(body)?.[1]?.trim() ?? "";
      const style = /font-style:\s*(normal|italic);/u.exec(body)?.[1] ?? "normal";
      const weight = /font-weight:\s*([0-9]{3}(?: [0-9]{3})?);/u.exec(body)?.[1] ?? "400";
      const range = /unicode-range:\s*([^;]+);/u.exec(body)?.[1]?.trim() ?? "";
      const source = /src:\s*url\(["']?(https:\/\/fonts\.gstatic\.com\/[^)\s"'\\]{1,600})["']?\)\s*format\(['"]woff2['"]\)/u.exec(body)?.[1];
      if (!verified.has(family.toLowerCase())) continue;
      if (!KEPT_SUBSETS.has(subset) && !(input.codePoints && usesRange(range, input.codePoints))) continue;
      if (!source || !/^U\+[0-9A-Fa-f?, U+-]{1,2000}$/u.test(range || "U+0-10FFFF")) {
        unreadable.set(family, (unreadable.get(family) ?? 0) + 1);
        continue;
      }
      // A face Google did not label with its subset is told from the others by its range.
      const key = `${family}|${style}|${weight}|${subset}${match[1] ? "" : `|${range}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (files.length >= MAX_FILES) {
        notes.push(`oltre ${MAX_FILES} file di font: gli altri non sono stati scaricati`);
        break;
      }
      let bytes: Uint8Array;
      try {
        const response = await fetcher(source, { maxBytes: MAX_FONT_BYTES, accept: "font/woff2", ...signal });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        bytes = response.body;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        notes.push(`file del font «${family}» non scaricato (${reason(error)})`);
        continue;
      }
      // Only real WOFF2 bytes become media.
      if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "wOF2") {
        notes.push(`file del font «${family}» non scaricato (non è un WOFF2)`);
        continue;
      }
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) {
        notes.push("i font superano 12 MB: gli altri non sono stati scaricati");
        break;
      }
      const base = `histos-fonts/${slug(family)}-${weight.replace(" ", "-")}-${style}-${subset}`;
      let path = `${base}.woff2`;
      for (let copy = 2; files.some((file) => file.path === path); copy++) path = `${base}-${copy}.woff2`;
      files.push({ path, bytes });
      withFiles.add(family.toLowerCase());
      faces.push(`@font-face {\n  font-family: "${family.replace(/["\\]/gu, "")}";\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url("${path.slice("histos-fonts/".length)}") format("woff2");${range ? `\n  unicode-range: ${range};` : ""}\n}`);
    }
  }
  for (const [family, count] of unreadable) notes.push(`font «${family}»: ${count === 1 ? "una variante ha" : `${count} varianti hanno`} un indirizzo o un intervallo di caratteri che non si legge, e non ${count === 1 ? "è stata scaricata" : "sono state scaricate"}`);
  // A verified family that ends with no file must not pass in silence: the page would show a fallback font.
  for (const family of families) {
    if (verified.has(family.toLowerCase()) && !withFiles.has(family.toLowerCase())) notes.push(`font «${family}»: nessun file scaricato, il sito userà il carattere di ripiego`);
  }
  const missing = [...noteSet];
  if (faces.length) {
    files.push({ path: "histos-fonts/google-fonts.css", bytes: new TextEncoder().encode(faces.join("\n")) });
    return { files, missing, notes: [...missing, `${faces.length} file di font scaricati come media (${[...verified.values()].filter((value, index, all) => all.indexOf(value) === index).join(", ")}): i visitatori non li caricano più da Google`] };
  }
  return { files, notes: missing, missing };
}
