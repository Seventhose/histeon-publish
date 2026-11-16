import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";
import type { WxrFile, WxrItem, WxrTerm } from "@histos-publish/cms";

/**
 * A WordPress site read through its public REST API, with no file and no plugin (doc 23). Only what the site shows to
 * anyone: published pages and posts. The same safe client as the crawler: https, public addresses, size and time limits.
 */

export type JsonFetcher = (url: string, signal?: AbortSignal) => Promise<unknown>;

const MAX_PAGES_OF_RESULTS = 100;

export const fetchPublicJson: JsonFetcher = async (input, signal) => {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password) throw new HistosPublishError("L'indirizzo del sito deve iniziare con https://.", "wordpress-site-url-invalid", 422);
  const client = new SafeHttpClient({ origin: url.origin, userAgent: "HistosPublish-Import/1.0", timeoutMs: 30_000, delayMs: 0, publicOnly: true, strictOrigin: true, ...(signal ? { signal } : {}) });
  const response = await client.get(url, { maxBytes: 32 * 1024 * 1024, bypassCache: true, headers: { Accept: "application/json" } });
  if (response.status === 400 || response.status === 404) return null;
  if (response.status !== 200) throw new HistosPublishError(`Il sito risponde ${response.status}.`, "wordpress-site-status", 422);
  try { return JSON.parse(new TextDecoder().decode(response.body)) as unknown; } catch { return null; }
};

const decode = (value: string): string => value
  .replace(/&#(\d{1,7});/gu, (_whole, code: string) => String.fromCodePoint(Number(code) || 32))
  .replace(/&#x([\da-f]{1,6});/giu, (_whole, code: string) => String.fromCodePoint(Number.parseInt(code, 16) || 32))
  .replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&nbsp;", " ").replaceAll("&amp;", "&");
const plain = (value: string): string => decode(value.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
type Json = Record<string, unknown>;
const rendered = (value: unknown): string => (typeof value === "object" && value !== null && typeof (value as Json).rendered === "string" ? (value as Json).rendered as string : "");

export async function readWordPressSite(input: { url: string; fetchJson?: JsonFetcher; signal?: AbortSignal }): Promise<WxrFile> {
  const fetchJson = input.fetchJson ?? fetchPublicJson;
  const trimmed = input.url.trim().replace(/\/+$/u, "");
  const base = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const root = await fetchJson(`${base}/wp-json/`, input.signal) as Json | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.namespaces) || !root.namespaces.includes("wp/v2")) {
    throw new HistosPublishError("Questo sito non espone le API di WordPress: usa il file di Strumenti → Esporta.", "wordpress-site-no-api", 422);
  }
  const all = async (route: string): Promise<Json[]> => {
    const out: Json[] = [];
    for (let page = 1; page <= MAX_PAGES_OF_RESULTS; page += 1) {
      const batch = await fetchJson(`${base}/wp-json/wp/v2/${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`, input.signal);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch as Json[]);
      if (batch.length < 100) break;
    }
    return out;
  };
  const [categories, tags, pages, posts] = [await all("categories"), await all("tags"), await all("pages?_embed=1"), await all("posts?_embed=1")];
  const slugs = (entries: Json[]) => new Map(entries.map((entry) => [entry.id, String(entry.slug ?? "")]));
  const categorySlugs = slugs(categories);
  const tagSlugs = slugs(tags);
  const terms: WxrTerm[] = [
    ...categories.map((term) => ({ kind: "category" as const, slug: String(term.slug ?? ""), name: decode(String(term.name ?? "")), parent: categorySlugs.get(term.parent) ?? "" })),
    ...tags.map((term) => ({ kind: "post_tag" as const, slug: String(term.slug ?? ""), name: decode(String(term.name ?? "")), parent: "" })),
  ];
  const items: WxrItem[] = [];
  for (const [type, entries] of [["page", pages], ["post", posts]] as const) {
    for (const entry of entries) {
      const embedded = (entry._embedded ?? {}) as Json;
      const media = (Array.isArray(embedded["wp:featuredmedia"]) ? embedded["wp:featuredmedia"][0] : null) as Json | null;
      const thumbnailId = media && typeof media.source_url === "string" ? `media-${String(media.id)}` : "";
      if (thumbnailId && !items.some((item) => item.id === thumbnailId)) items.push({ id: thumbnailId, type: "attachment", title: plain(rendered(media?.title)), slug: "", status: "inherit", date: null, excerpt: "", content: "", terms: [], attachmentUrl: String(media?.source_url), thumbnailId: "" });
      const yoast = (entry.yoast_head_json ?? {}) as Json;
      const gmt = typeof entry.date_gmt === "string" ? entry.date_gmt : "";
      items.push({
        id: String(entry.id), type, title: plain(rendered(entry.title)), slug: String(entry.slug ?? ""), status: "publish",
        date: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(gmt) ? `${gmt}Z` : null,
        excerpt: plain(rendered(entry.excerpt)), content: rendered(entry.content),
        terms: [...((entry.categories ?? []) as unknown[]).map((id) => ({ kind: "category" as const, slug: categorySlugs.get(id) ?? "" })), ...((entry.tags ?? []) as unknown[]).map((id) => ({ kind: "post_tag" as const, slug: tagSlugs.get(id) ?? "" }))].filter((term) => term.slug),
        attachmentUrl: "", thumbnailId,
        ...(typeof yoast.title === "string" ? { seoTitle: decode(yoast.title) } : {}),
        ...(typeof yoast.description === "string" ? { seoDescription: decode(yoast.description) } : {}),
      });
    }
  }
  return { title: plain(String(root.name ?? "")), link: base, language: "", terms, items };
}
