import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";
import { FONT_REFERENCE_PREFIX, fontFaces, fontFamilies, imageSize, sniffPrototypeMedia, withFamily, type CmsProjectStore } from "@histos-publish/cms";
import { GOOGLE_FONTS_CATALOG } from "./google-fonts-catalog.js";
import { downloadGoogleFonts, type FontFetcher } from "./google-fonts.js";

/**
 * Two panels of the builder that asked a WordPress site for their data (doc 11): «Font del sito» in the Design system
 * and the Video window. In Histeon Publish they get the same answers from the project, with the same limits and hosts
 * as Histeon for WordPress (Fonts/Rest.php, Media/Video.php).
 */

const mediaUrl = (projectId: string, assetId: string): string => `/__cms-media/${projectId}/${assetId}`;

/** `GET fonts`: the families, their rules as the builder's page loads them, and the catalog. */
export function fontsData(store: CmsProjectStore, projectId: string, withCatalog = true) {
  const sheet = store.getFontSheet();
  const urls = new Map((sheet?.assets ?? []).map((asset) => [asset.reference, mediaUrl(projectId, asset.assetId)]));
  const css = fontFaces(sheet).map((face) => face.rule.replace(`url("${face.reference}")`, `url("${urls.get(face.reference) ?? ""}")`)).join("\n");
  return { families: fontFamilies(sheet), css, canManage: true, ...(withCatalog ? { catalog: GOOGLE_FONTS_CATALOG } : {}) };
}

/**
 * `POST fonts/google`: a family of the catalog, in the weights and styles it has, downloaded once as WOFF2 media of
 * the project (latin and latin-ext), with its licence verified (google-fonts.ts). One request per weight: Google
 * refuses a whole request when one of its weights is missing.
 */
export async function importGoogleFont(store: CmsProjectStore, projectId: string, body: Record<string, unknown>, fetcher?: FontFetcher) {
  const entry = GOOGLE_FONTS_CATALOG.find((item) => item.family === body.family);
  if (!entry) throw new HistosPublishError("Scegli una famiglia dall'elenco.", "cms-fonts-family-unknown", 400);
  const weights = Array.isArray(body.weights) ? [...new Set(body.weights)] : [];
  if (!weights.length || weights.length > 9 || weights.some((weight) => typeof weight !== "number" || !entry.weights.includes(weight))) throw new HistosPublishError("Scegli i pesi fra quelli della famiglia.", "cms-fonts-weights-invalid", 400);
  const italic = body.italic === true;
  if (italic && !entry.italic) throw new HistosPublishError("Questa famiglia non ha il corsivo.", "cms-fonts-italic-missing", 400);
  const family = entry.family.replaceAll(" ", "+");
  const cssUrls = (weights as number[]).flatMap((weight) => [0, ...(italic ? [1] : [])].map((style) => `https://fonts.googleapis.com/css2?family=${family}:ital,wght@${style},${weight}&display=swap`));
  const downloaded = await downloadGoogleFonts({ cssUrls, ...(fetcher ? { fetcher } : {}) });
  const files = downloaded.files.filter((file) => file.path.endsWith(".woff2"));
  const rules = downloaded.files.find((file) => file.path.endsWith(".css"));
  if (!files.length || !rules) throw new HistosPublishError(downloaded.notes.join("; ") || "Il font non è stato scaricato.", "cms-fonts-download-failed", 422);
  const assetIds = new Map<string, string>();
  for (const file of files) {
    if (sniffPrototypeMedia(file.bytes) !== "font/woff2") continue;
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    assetIds.set(name, store.saveAsset({ bytes: file.bytes, mimeType: "font/woff2", filename: name }).id);
  }
  // Each rule of the downloaded sheet, pointing to its file through the sheet's own local path.
  const faces = [...new TextDecoder().decode(rules.bytes).matchAll(/@font-face\s*\{[^{}]*\}/gu)].flatMap((match) => {
    const name = /url\("([^"/]+\.woff2)"\)/u.exec(match[0])?.[1];
    const assetId = name ? assetIds.get(name) : undefined;
    return name && assetId ? [{ rule: match[0].replace(`url("${name}")`, `url("${FONT_REFERENCE_PREFIX}${name}")`), reference: `${FONT_REFERENCE_PREFIX}${name}`, assetId }] : [];
  });
  if (!faces.length) throw new HistosPublishError("Il font non è stato scaricato.", "cms-fonts-download-failed", 422);
  store.setFontSheet(withFamily(store.getFontSheet(), entry.family, faces));
  return fontsData(store, projectId, false);
}

/** `DELETE fonts?family=`: the family's rules go; its files stay among the media, where the user may remove them. */
export function removeFont(store: CmsProjectStore, projectId: string, family: string) {
  if (!fontFamilies(store.getFontSheet()).some((item) => item.family === family)) throw new HistosPublishError("Questo font non è nel progetto.", "cms-fonts-family-missing", 404);
  store.setFontSheet(withFamily(store.getFontSheet(), family, []));
  return fontsData(store, projectId, false);
}

/** Fetches a resource from one of the video hosts only: public addresses, no redirects, size and time limits. */
export type VideoFetcher = (url: string, maxBytes: number) => Promise<{ status: number; body: Uint8Array }>;
const VIDEO_HOSTS = new Set(["www.youtube.com", "vimeo.com", "i.ytimg.com", "i.vimeocdn.com"]);
const fetchVideoResource: VideoFetcher = async (input, maxBytes) => {
  const url = new URL(input);
  if (url.protocol !== "https:" || !VIDEO_HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new HistosPublishError("Indirizzo non ammesso per il video.", "video-url-invalid", 400);
  const client = new SafeHttpClient({ origin: url.origin, userAgent: "HistosPublish-Video/1.0", timeoutMs: 15_000, delayMs: 0, publicOnly: true, strictOrigin: true });
  const response = await client.get(url, { maxBytes, bypassCache: true });
  return { status: response.status, body: response.body };
};

/** The provider and id of a YouTube or Vimeo address, or null (Media/Video.php `parse`). */
export function parseVideo(value: string): { provider: "youtube" | "vimeo"; id: string } | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  let id = "";
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"].includes(host)) id = url.pathname === "/watch" ? url.searchParams.get("v") ?? "" : /^\/(?:embed|shorts|live)\/([^/]+)$/u.exec(url.pathname)?.[1] ?? "";
  else if (host === "youtu.be") id = url.pathname.slice(1);
  else if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    const vimeo = /^\/(?:video\/)?(\d{1,12})\/?$/u.exec(url.pathname)?.[1];
    return vimeo ? { provider: "vimeo", id: vimeo } : null;
  } else return null;
  return /^[A-Za-z0-9_-]{11}$/u.test(id) ? { provider: "youtube", id } : null;
}

/**
 * `POST video`: title and poster of a YouTube or Vimeo video, the poster downloaded once into the project's media.
 * Nothing of the video loads in the page before the click: the builder writes a link around the poster.
 */
export async function videoInfo(store: CmsProjectStore, projectId: string, body: Record<string, unknown>, fetcher: VideoFetcher = fetchVideoResource) {
  const video = typeof body.url === "string" ? parseVideo(body.url) : null;
  if (!video) throw new HistosPublishError("Serve l'indirizzo di un video YouTube o Vimeo.", "cms-video-url-invalid", 400);
  const watch = video.provider === "youtube" ? `https://www.youtube.com/watch?v=${video.id}` : `https://vimeo.com/${video.id}`;
  let title = "";
  let thumbnail = "";
  try {
    const endpoint = video.provider === "youtube" ? "https://www.youtube.com/oembed?format=json&url=" : "https://vimeo.com/api/oembed.json?url=";
    const answer = await fetcher(endpoint + encodeURIComponent(watch), 64 * 1024);
    if (answer.status === 200) {
      const data = JSON.parse(new TextDecoder().decode(answer.body)) as { title?: unknown; thumbnail_url?: unknown };
      title = typeof data.title === "string" ? data.title.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200) : "";
      thumbnail = typeof data.thumbnail_url === "string" ? data.thumbnail_url : "";
    }
  } catch {
    // Without its oEmbed the video still goes in, with no title.
  }
  return { provider: video.provider, id: video.id, title, watch, embed: video.provider === "youtube" ? `https://www.youtube-nocookie.com/embed/${video.id}` : `https://player.vimeo.com/video/${video.id}`, poster: await videoPoster(store, projectId, video, thumbnail, fetcher) };
}

async function videoPoster(store: CmsProjectStore, projectId: string, video: { provider: string; id: string }, thumbnail: string, fetcher: VideoFetcher) {
  const filename = `video-${video.provider}-${video.id}`;
  let asset = store.listAssets().find((item) => item.filename.startsWith(`${filename}.`));
  if (!asset) {
    const source = video.provider === "youtube" ? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` : /^https:\/\/i\.vimeocdn\.com\/video\/[A-Za-z0-9_.-]+$/u.test(thumbnail) ? thumbnail : "";
    if (!source) return null;
    try {
      const answer = await fetcher(source, 3 * 1024 * 1024);
      const type = answer.status === 200 ? sniffPrototypeMedia(answer.body) : null;
      const extension = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : type === "image/webp" ? "webp" : null;
      if (!extension) return null;
      const saved = store.saveAsset({ bytes: answer.body, mimeType: type as string, filename: `${filename}.${extension}` });
      asset = store.listAssets().find((item) => item.id === saved.id);
    } catch {
      return null;
    }
  }
  if (!asset) return null;
  const stored = await store.readAsset(asset.id);
  const size = stored ? imageSize(stored.bytes) : null;
  return { id: asset.alias, url: mediaUrl(projectId, asset.id), width: size?.width ?? 0, height: size?.height ?? 0 };
}
