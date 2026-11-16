// The media library over WordPress's REST API, for the public API (window.xb.media…) and the media manager
// (doc 26 voci 209-210, docs/spec/media.md): list with filters, details, alternative text, collections, uploads
// through the encoder, an image made lighter in place, the site's presets. Every call carries the builder's nonce,
// so WordPress's permissions apply (upload_files, edit_post on the file).
import { t } from './i18n.ts';
import { collectionsUrl, compress, fitWithin, type Collection, type Preset, type SitePreset } from './mediaManager.ts';
import { encodeInWorker, lightest, type Format } from './imageEncoder.ts';
import { readImageHeader, refusal } from './imageHeader.ts';
import { mediaFilter, type MediaKind } from './media.ts';

export interface LibraryItem {
  id: number;
  url: string;
  title: string;
  alt: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  collections: number[];
  /** Made lighter in place: weights before and after, and when. */
  compressed: { before: number; after: number; at: number } | null;
}

export interface MediaFilter {
  search?: string;
  type?: MediaKind | 'all';
  /** A collection's id, or 0 for the files in none. */
  collection?: number;
  /** Only images without alternative text (filtered on the page read). */
  missingAlt?: boolean;
  page?: number;
}

interface RestItem {
  id: number;
  source_url?: string;
  title?: { rendered?: string; raw?: string };
  alt_text?: string;
  mime_type?: string;
  media_details?: { width?: number; height?: number; filesize?: number };
  xb_media_collection?: number[];
  xb_compressed?: LibraryItem['compressed'];
}

const FIELDS = 'id,source_url,alt_text,title,media_details,mime_type,xb_media_collection,xb_compressed';

/**
 * Formats an image keeps when made lighter in place: the same format, so its address does not change. Not AVIF:
 * its header is not read here (lib/imageHeader.ts), so it could never be checked and would always come back
 * «already light»; it is already the lightest format the builder writes.
 */
export const IN_PLACE: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

function textOf(html: string): string {
  const d = new DOMParser().parseFromString(html, 'text/html');
  return d.body.textContent ?? '';
}

export function libraryItem(r: RestItem): LibraryItem {
  return {
    id: r.id,
    url: r.source_url ?? '',
    title: r.title?.raw ?? textOf(r.title?.rendered ?? ''),
    alt: r.alt_text ?? '',
    mime: r.mime_type ?? '',
    width: r.media_details?.width ?? 0,
    height: r.media_details?.height ?? 0,
    bytes: r.media_details?.filesize ?? 0,
    collections: Array.isArray(r.xb_media_collection) ? r.xb_media_collection : [],
    compressed: r.xb_compressed ?? null,
  };
}

export class MediaLibrary {
  constructor(
    private readonly mediaUrl: string | null,
    private readonly restUrl: string,
    private readonly nonce: string,
    private readonly encoder: string | null = null,
    private readonly maxBytes = 0,
  ) {}

  private route(suffix = ''): URL {
    if (!this.mediaUrl) throw new Error(t('Libreria media non disponibile.'));
    return new URL(this.mediaUrl + suffix, window.location.href);
  }

  private collectionsRoute(suffix = ''): URL {
    if (!this.mediaUrl) throw new Error(t('Libreria media non disponibile.'));
    return new URL(collectionsUrl(this.mediaUrl) + suffix, window.location.href);
  }

  private async request<T>(url: URL | string, init: RequestInit = {}): Promise<{ data: T; response: Response }> {
    const json = init.body !== undefined && !(init.body instanceof FormData);
    const response = await fetch(url, { credentials: 'same-origin', ...init, headers: { 'X-WP-Nonce': this.nonce, ...(json ? { 'Content-Type': 'application/json' } : {}) } });
    const data = (await response.json().catch(() => null)) as T & { message?: string };
    if (!response.ok) throw new Error((data as { message?: string } | null)?.message ?? t('Errore {0}', response.status));
    return { data, response };
  }

  async list(filter: MediaFilter = {}): Promise<{ items: LibraryItem[]; pages: number }> {
    const url = this.route();
    for (const [key, value] of Object.entries(mediaFilter(filter.missingAlt ? 'image' : (filter.type ?? 'all')))) url.searchParams.set(key, value);
    url.searchParams.set('per_page', '40');
    url.searchParams.set('page', String(Math.max(1, Math.floor(filter.page ?? 1))));
    url.searchParams.set('_fields', FIELDS);
    url.searchParams.set('context', 'edit');
    if (filter.search?.trim()) url.searchParams.set('search', filter.search.trim().slice(0, 100));
    if (filter.collection !== undefined && filter.collection > 0) url.searchParams.set('xb_media_collection', String(filter.collection));
    if (filter.collection === 0) {
      const ids = (await this.collections()).map((c) => c.id);
      if (ids.length) url.searchParams.set('xb_media_collection_exclude', ids.join(','));
    }
    const { data, response } = await this.request<RestItem[]>(url);
    const items = data.map(libraryItem);
    return { items: filter.missingAlt ? items.filter((i) => i.alt.trim() === '') : items, pages: Number(response.headers.get('X-WP-TotalPages') ?? '1') };
  }

  async get(id: number): Promise<LibraryItem> {
    const url = this.route(`/${id}`);
    url.searchParams.set('_fields', FIELDS);
    url.searchParams.set('context', 'edit');
    return libraryItem((await this.request<RestItem>(url)).data);
  }

  async setAlt(id: number, alt: string): Promise<LibraryItem> {
    const url = this.route(`/${id}`);
    url.searchParams.set('_fields', FIELDS);
    return libraryItem((await this.request<RestItem>(url, { method: 'POST', body: JSON.stringify({ alt_text: alt.slice(0, 500) }) })).data);
  }

  async setCollections(id: number, collections: number[]): Promise<LibraryItem> {
    const url = this.route(`/${id}`);
    url.searchParams.set('_fields', FIELDS);
    return libraryItem((await this.request<RestItem>(url, { method: 'POST', body: JSON.stringify({ xb_media_collection: collections }) })).data);
  }

  async collections(): Promise<Collection[]> {
    const url = this.collectionsRoute();
    url.searchParams.set('per_page', '100');
    url.searchParams.set('_fields', 'id,name,parent,count');
    return (await this.request<Collection[]>(url)).data;
  }

  async createCollection(name: string, parent = 0): Promise<Collection> {
    return (await this.request<Collection>(this.collectionsRoute(), { method: 'POST', body: JSON.stringify({ name, ...(parent > 0 ? { parent } : {}) }) })).data;
  }

  async updateCollection(id: number, change: { name?: string; parent?: number }): Promise<Collection> {
    return (await this.request<Collection>(this.collectionsRoute(`/${id}`), { method: 'POST', body: JSON.stringify(change) })).data;
  }

  /** The collection goes; its files stay in the library, in the others they belong to or in none. */
  async deleteCollection(id: number): Promise<void> {
    const url = this.collectionsRoute(`/${id}`);
    url.searchParams.set('force', 'true');
    await this.request(url, { method: 'DELETE' });
  }

  /** A file into the library through the encoder (images), into a collection when one is given. */
  async upload(file: File, options: { collection?: number; preset?: Preset; maxBytes?: number } = {}): Promise<LibraryItem> {
    const ready = file.type.startsWith('image/') && options.preset ? await compress(file, options.preset, this.encoder) : file;
    const max = options.maxBytes ?? this.maxBytes;
    if (max && ready.size > max) throw new Error(t('supera {0} MB', Math.round(max / 1048576)));
    const body = new FormData();
    body.append('file', ready, ready.name);
    const url = this.route();
    url.searchParams.set('_fields', FIELDS);
    const item = libraryItem((await this.request<RestItem>(url, { method: 'POST', body })).data);
    return options.collection ? this.setCollections(item.id, [options.collection]) : item;
  }

  /**
   * The image made lighter where it is (voce 209): the file at its address, resized to the preset's longest side
   * and written again in its own format, goes back to the server, which redraws the sizes under their names and
   * keeps the original. Nothing is sent when the result is not lighter.
   */
  async compressInPlace(id: number, preset: Preset): Promise<{ before: number; after: number; saved: boolean }> {
    const item = await this.get(id);
    if (!IN_PLACE.includes(item.mime)) throw new Error(t('Si comprimono sul posto solo immagini JPEG, PNG e WebP.'));
    const source = await fetch(item.url, { credentials: 'same-origin', cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(t('Errore {0}', r.status));
      return r.blob();
    });
    const lighter = await sameFormat(new File([source], item.url.split('/').pop() ?? 'immagine', { type: item.mime }), preset, this.encoder);
    if (!lighter || lighter.size >= source.size) return { before: source.size, after: source.size, saved: false };
    const body = new FormData();
    body.append('file', lighter, lighter.name);
    const { data } = await this.request<{ before: number; after: number }>(`${this.restUrl}media/${id}/compress`, { method: 'POST', body });
    return { before: data.before, after: data.after, saved: true };
  }

  async restore(id: number): Promise<void> {
    await this.request(`${this.restUrl}media/${id}/restore`, { method: 'POST', body: '{}' });
  }

  async presets(): Promise<SitePreset[]> {
    return (await this.request<{ presets: SitePreset[] }>(`${this.restUrl}media/presets`)).data.presets;
  }

  async savePresets(presets: SitePreset[]): Promise<SitePreset[]> {
    return (await this.request<{ presets: SitePreset[] }>(`${this.restUrl}media/presets`, { method: 'POST', body: JSON.stringify({ presets }) })).data.presets;
  }
}

/**
 * The same image in its own format, no larger than the preset's longest side: JPEG and PNG with the browser's
 * encoder (JPEG at the preset's quality, PNG lossless, lighter only when smaller), WebP with the builder's
 * encoder when the plugin serves it. Null when the file cannot be read safely (too large, animated, no size).
 */
async function sameFormat(file: File, preset: Preset, encoder: string | null): Promise<File | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const header = readImageHeader(new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer()));
  if (refusal(file.size, header) || !header) return null;
  const quality = preset.quality ?? (file.type === 'image/jpeg' ? 82 : 75);
  if (file.type === 'image/webp' && encoder) {
    const format: Format = 'webp';
    const variants = header.lossless ? [{ format, lossless: true }, { format, lossless: false, quality }] : [{ format, lossless: false, quality }];
    try {
      const best = lightest(await encodeInWorker(encoder, { file, width: header.width, height: header.height, max: preset.max, variants }), file.size);
      return best ? new File([best.buffer], file.name, { type: file.type }) : null;
    } catch {
      return null;
    }
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const size = fitWithin(bitmap.width, bitmap.height, preset.max);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, file.type, file.type === 'image/png' ? undefined : quality / 100));
  return blob && blob.type === file.type ? new File([blob], file.name, { type: file.type }) : null;
}
