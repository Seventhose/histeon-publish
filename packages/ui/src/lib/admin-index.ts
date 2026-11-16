import { api } from "./api.js";

/** The site administration's index (doc 21 §6): kept here per project, shown at once and checked behind the scenes. */

export type AdminState = "missing" | "draft" | "published" | "stale";
export interface AdminDocument { id: string; alias: number; kind: "page" | "post"; title: string; slug: string; status: string; locale: string | null; templateRef: string | null; publishedAt: string | null; head: string; updatedAt: string; address: string }
export interface AdminRecord { id: string; kind: "record"; typeKey: string; title: string; slug: string; status: string; locale: string; head: string; updatedAt: string }
export interface AdminItem { id: string; alias: number; ref: string; title: string; updatedAt: string; role?: string | null }
export interface AdminAsset { id: string; alias: number; filename: string; alt: string; caption: string; mimeType: string }
export interface AdminLink { translationId: string; sourceId: string; kind: "page" | "post" | "record"; language: string; mode: "follow" | "independent"; state: AdminState }
export interface AdminLanguage { code: string; label: string }
export interface AdminIndex {
  revision: string;
  pages: AdminDocument[];
  posts: AdminDocument[];
  records: AdminRecord[];
  types: Array<{ key: string; label: string }>;
  taxonomies: Array<{ key: string; label: string }>;
  assets: AdminAsset[];
  templates: AdminItem[];
  parts: AdminItem[];
  components: AdminItem[];
  translations: AdminLink[];
  languages: { defaultLanguage: AdminLanguage; languages: AdminLanguage[] };
  siteUrl: string | null;
  siteSearch: boolean;
  renderSettings: { locale: string; timeZone: string };
  imageVariants: boolean;
  shop: { url: string | null; currency: string };
}

const kept = new Map<string, AdminIndex>();

export function keptAdminIndex(projectId: string): AdminIndex | null {
  return kept.get(projectId) ?? null;
}

/** The index as the server has it now; the same object when nothing changed. */
export async function readAdminIndex(projectId: string): Promise<AdminIndex> {
  const known = kept.get(projectId);
  const query = known ? `?known=${encodeURIComponent(known.revision)}` : "";
  const answer = await api<AdminIndex | { unchanged: true; revision: string }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/index${query}`);
  if ("unchanged" in answer && known) return known;
  kept.set(projectId, answer as AdminIndex);
  return answer as AdminIndex;
}

export function forgetAdminIndex(projectId: string): void {
  kept.delete(projectId);
}

/** The versions of each original, by its id. */
export function versionsBySource(links: readonly AdminLink[]): Map<string, AdminLink[]> {
  const out = new Map<string, AdminLink[]>();
  for (const link of links) {
    const list = out.get(link.sourceId);
    if (list) list.push(link);
    else out.set(link.sourceId, [link]);
  }
  return out;
}

/** Lower case and without accents, what the searches of the administration compare. */
export function searchable(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface AdminFilter {
  search: string;
  status: string;
  language: string;
}

/** The rows a table shows: in the site's language unless a language is chosen, translations under their originals. */
export function filterDocuments(items: readonly AdminDocument[], filter: AdminFilter): AdminDocument[] {
  const search = searchable(filter.search.trim());
  return items.filter((item) => {
    if (filter.status && item.status !== filter.status) return false;
    if (filter.language === "" && item.locale !== null) return false;
    if (filter.language !== "" && filter.language !== "*" && item.locale !== filter.language) return false;
    return !search || searchable(`${item.title} ${item.slug}`).includes(search);
  });
}

/** How far each language is: of the originals in the site's language, how many are online, in draft, to update. */
export function languageProgress(index: AdminIndex): Array<{ code: string; label: string; total: number; published: number; draft: number; stale: number; missing: number; percent: number }> {
  const total = [...index.pages, ...index.posts].filter((item) => item.locale === null).length + index.records.filter((record) => record.locale === index.languages.defaultLanguage.code).length;
  return index.languages.languages.map((language) => {
    const links = index.translations.filter((link) => link.language === language.code);
    const published = links.filter((link) => link.state === "published").length;
    return { code: language.code, label: language.label, total, published, draft: links.filter((link) => link.state === "draft").length, stale: links.filter((link) => link.state === "stale").length, missing: Math.max(0, total - links.length), percent: total ? Math.round((published / total) * 100) : 0 };
  });
}

export type AdminSort = "title" | "address" | "status" | "updatedAt";

export function sortDocuments(items: readonly AdminDocument[], key: AdminSort, direction: 1 | -1): AdminDocument[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return [...items].sort((left, right) => direction * collator.compare(left[key], right[key]) || left.alias - right.alias);
}

/** The first rows of a list as a window of a scrolling table: which ones to draw. */
export function tableWindow(total: number, scrollTop: number, viewport: number, rowHeight: number, overscan = 8): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  return { start, end: Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan) };
}
