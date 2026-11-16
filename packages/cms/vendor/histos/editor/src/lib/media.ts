/** Image picker on the WordPress REST API (/wp/v2/media). Pure helpers, tested in test/media.test.ts. */
import { t } from './i18n.ts';
import type { XbBlock } from '@xb/dsl';

export interface MediaItem {
  id: number;
  source_url: string;
  alt_text?: string;
  title?: { rendered?: string };
  mime_type?: string;
  media_details?: {
    width?: number;
    height?: number;
    filesize?: number;
    sizes?: Record<string, { source_url: string; width: number; height: number }>;
  };
}

/** Text written into an XB attribute is a template: braces must be literal (docs/spec/dsl.md §3.5). */
export function literal(value: string): string {
  return value.replace(/[{}]/g, (c) => '\\' + c);
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value); // The REST API returns absolute URLs.
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Attributes of an <img> for a library item: src, srcset with the sizes of the same aspect ratio (cropped
 * thumbnails would distort), sizes, width, height and alt — all as literal template text.
 */
export function imageAttributes(item: MediaItem): Record<string, string> {
  const src = httpUrl(item.source_url);
  if (!src) throw new Error(t('Immagine senza un indirizzo valido'));
  const width = item.media_details?.width ?? 0;
  const height = item.media_details?.height ?? 0;
  const out: Record<string, string> = { src: literal(src) };
  if (width > 0 && height > 0) {
    const ratio = width / height;
    const candidates = new Map<number, string>([[width, src]]);
    for (const size of Object.values(item.media_details?.sizes ?? {})) {
      const url = httpUrl(size.source_url);
      if (url && size.width > 0 && size.height > 0 && Math.abs(size.width / size.height - ratio) / ratio < 0.01) candidates.set(size.width, url);
    }
    if (candidates.size > 1) {
      out.srcset = literal(
        [...candidates.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([w, url]) => `${url.replace(/ /g, '%20')} ${w}w`)
          .join(', '),
      );
      out.sizes = `(max-width: ${width}px) 100vw, ${width}px`;
    }
    out.width = String(width);
    out.height = String(height);
  }
  out.alt = literal(item.alt_text ?? '');
  return out;
}

/** Where an image is held in its box, from its inline style (`object-position: X% Y%`), or null. */
export function focalPoint(style: string): [number, number] | null {
  const m = /(?:^|;)\s*object-position\s*:\s*(-?[\d.]+)%\s+(-?[\d.]+)%\s*(?:;|$)/i.exec(style);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The inline style with the focal point as `object-position` (null removes it); the other declarations stay as
 * written. Rounded to whole percentages.
 */
export function withFocalPoint(style: string, point: [number, number] | null): string {
  const rest = style
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !/^object-position\s*:/i.test(d));
  if (point) {
    const clamp = (n: number) => Math.round(Math.min(100, Math.max(0, n)));
    rest.push(`object-position: ${clamp(point[0])}% ${clamp(point[1])}%`);
  }
  return rest.join('; ');
}

export interface PageImage {
  uid: string;
  /** As written: a URL, or an expression (`{post.image}`). */
  src: string;
  /** null: no alt at all; '' decorative. */
  alt: string | null;
  /** The alt (or the src) is an expression: it comes from the content and is edited there. */
  dynamic: boolean;
}

const EXPRESSION = /(^|[^\\])\{/;

/** The page's images in document order, for the table of alternative texts. */
export function pageImages(blocks: Iterable<{ name: string; attrs: { uid: string; tag?: string; attributes?: Record<string, string | true> } }>): PageImage[] {
  const out: PageImage[] = [];
  for (const b of blocks) {
    if (b.name !== 'xb/element' || b.attrs.tag !== 'img') continue;
    const attributes = b.attrs.attributes ?? {};
    const src = typeof attributes.src === 'string' ? attributes.src : '';
    const alt = attributes.alt === undefined ? null : attributes.alt === true ? '' : attributes.alt;
    out.push({ uid: b.attrs.uid, src, alt, dynamic: EXPRESSION.test(src) || (alt !== null && EXPRESSION.test(alt)) });
  }
  return out;
}

/** What the media manager can pick (M1): images only, or anything the page can show or link to. */
export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

/** The kind of a library item from its MIME type, or null for what the builder does not insert. */
export function mediaKind(item: MediaItem): MediaKind | null {
  const mime = (item.mime_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return null;
}

/**
 * The kinds of file a link can point to from the Properties panel (doc 23 of Histeon Publish, item 176): images and
 * PDF, the media a transfer of Histeon CMS carries with a link (histos-media-links-v1).
 */
export const LINK_KINDS: readonly MediaKind[] = ['pdf', 'image'];

/**
 * The address of a library file for the `href` of a link, as literal template text: the attachment's own file on
 * WordPress, `/__cms-media/<project>/<id>` in the local CMS of Publish. Only images and PDF.
 */
export function fileHref(item: MediaItem): string {
  const kind = mediaKind(item);
  const url = httpUrl(item.source_url);
  if (!url || !kind || !LINK_KINDS.includes(kind)) throw new Error(t('Si collega solo un’immagine o un PDF della libreria'));
  return literal(url);
}

/** The REST filter of the media list for a kind (`media_type`, or `mime_type` for PDF). */
export function mediaFilter(kind: MediaKind | 'all'): Record<string, string> {
  if (kind === 'all') return {};
  if (kind === 'pdf') return { mime_type: 'application/pdf' };
  return { media_type: kind };
}

/** The element a library item becomes in the page: <img>, <video controls>, <audio controls> or a link to the PDF. */
export function mediaElement(item: MediaItem, title: string): { tag: string; attributes: Record<string, string | true>; text?: string } {
  const kind = mediaKind(item);
  if (kind === 'image') return { tag: 'img', attributes: imageAttributes(item) };
  const src = httpUrl(item.source_url);
  if (!kind || !src) throw new Error(t('Questo file non si può inserire nella pagina'));
  if (kind === 'pdf') return { tag: 'a', attributes: { href: literal(src) }, text: literal(title || src.split('/').pop() || 'PDF') };
  const attributes: Record<string, string | true> = { src: literal(src), controls: true, preload: 'metadata' };
  const { width, height } = item.media_details ?? {};
  if (kind === 'video' && width && height) {
    attributes.width = String(width);
    attributes.height = String(height);
  }
  return { tag: kind, attributes };
}

/** What the server answers for a YouTube or Vimeo address (POST xb/v1/video, E9). */
export interface VideoInfo {
  provider: string;
  id: string;
  title: string;
  watch: string;
  embed: string;
  poster: { id: number; url: string; width: number; height: number } | null;
}

/**
 * A video that asks nothing of YouTube or Vimeo before the click (E9): a link to the video around the poster
 * the site keeps; Histeon's behaviours script reads data-xb-video and puts the player there on click.
 */
export function videoBlocks(info: VideoInfo, uid: () => string): XbBlock[] {
  const label = info.title ? t('Riproduci il video: {0}', info.title) : t('Riproduci il video');
  const children: XbBlock[] = [];
  if (info.poster) {
    const attributes: Record<string, string> = { src: literal(info.poster.url), alt: '' };
    if (info.poster.width && info.poster.height) {
      attributes.width = String(info.poster.width);
      attributes.height = String(info.poster.height);
    }
    attributes.loading = 'lazy';
    children.push({ name: 'xb/element', attrs: { uid: uid(), tag: 'img', attributes }, children: [] });
  }
  children.push({ name: 'xb/element', attrs: { uid: uid(), tag: 'span', attributes: { class: 'xb-video__icon', 'aria-hidden': 'true' } }, children: [] });
  return [
    {
      name: 'xb/element',
      attrs: { uid: uid(), tag: 'figure', attributes: { class: 'xb-video', 'data-xb-video': literal(info.embed) } },
      children: [{ name: 'xb/element', attrs: { uid: uid(), tag: 'a', attributes: { class: 'xb-video__play', href: literal(info.watch), 'aria-label': literal(label) } }, children }],
    },
  ];
}

/** A map to load on click (E11): the provider, the address of its embeddable map, a link to open it on its site. */
export interface MapInfo {
  provider: 'OpenStreetMap' | 'Google Maps';
  embed: string;
  link: string;
}

const num = (value: number) => String(Math.round(value * 10000) / 10000);
const coord = (value: string | null, limit: number): number | null => {
  const n = value === null || value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

/**
 * The map in an OpenStreetMap or Google Maps link (or in the <iframe> code they give), as an address to embed;
 * null for anything else. Only these forms come out, and the page script accepts nothing more.
 */
export function mapFromUrl(input: string): MapInfo | null {
  const src = /<iframe[^>]*\ssrc="([^"]+)"/i.exec(input)?.[1] ?? input.trim();
  let url: URL;
  try {
    url = new URL(src.replace(/&amp;/g, '&'));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'www.openstreetmap.org' || host === 'openstreetmap.org') {
    const hash = /^#map=(\d{1,2})\/(-?[\d.]+)\/(-?[\d.]+)/.exec(url.hash);
    const zoom = Math.min(19, Math.max(1, Number(hash?.[1] ?? 15)));
    const mlat = coord(url.searchParams.get('mlat'), 90);
    const mlon = coord(url.searchParams.get('mlon'), 180);
    const clat = coord(hash?.[2] ?? null, 90) ?? mlat;
    const clon = coord(hash?.[3] ?? null, 180) ?? mlon;
    if (clat === null || clon === null) return null;
    const [lat, lon] = mlat !== null && mlon !== null ? [mlat, mlon] : [clat, clon];
    const scale = 2 ** (16 - zoom);
    const [dLat, dLon] = [0.004 * scale, 0.005 * scale];
    const bbox = [clon - dLon, clat - dLat, clon + dLon, clat + dLat].map(num).join(',');
    return {
      provider: 'OpenStreetMap',
      embed: `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${num(lat)},${num(lon)}`)}`,
      link: `https://www.openstreetmap.org/${mlat !== null && mlon !== null ? `?mlat=${num(mlat)}&mlon=${num(mlon)}` : ''}#map=${zoom}/${num(clat)}/${num(clon)}`,
    };
  }
  if (/^(www\.|maps\.)?google\.[a-z.]{2,6}$/.test(host) && url.pathname.startsWith('/maps')) {
    const pb = url.searchParams.get('pb');
    if (url.pathname.startsWith('/maps/embed')) {
      return pb && /^[\w!.*:%-]+$/.test(pb) ? { provider: 'Google Maps', embed: `https://www.google.com/maps/embed?pb=${pb}`, link: 'https://www.google.com/maps' } : null;
    }
    const at = /@(-?[\d.]+),(-?[\d.]+)(?:,(\d{1,2}(?:\.\d+)?)z)?/.exec(url.pathname);
    const lat = coord(at?.[1] ?? null, 90);
    const lon = coord(at?.[2] ?? null, 180);
    const zoom = Math.round(Math.min(21, Math.max(1, Number(at?.[3] ?? 15))));
    const q = lat !== null && lon !== null ? `${num(lat)},${num(lon)}` : (url.searchParams.get('q') ?? '').slice(0, 200);
    if (!q.trim()) return null;
    return { provider: 'Google Maps', embed: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=${zoom}&output=embed`, link: `https://www.google.com/maps?q=${encodeURIComponent(q)}` };
  }
  return null;
}

/** A map that asks nothing of the provider before the click (E11): a link to it, labelled; the script loads the map. */
export function mapBlocks(map: MapInfo, label: string, uid: () => string): XbBlock[] {
  const text = (content: string, cls: string): XbBlock => ({ name: 'xb/element', attrs: { uid: uid(), tag: 'span', attributes: { class: cls } }, children: [{ name: 'xb/text', attrs: { uid: uid(), content: literal(content.replace(/&/g, '&amp;').replace(/</g, '&lt;')) } }] });
  return [
    {
      name: 'xb/element',
      attrs: { uid: uid(), tag: 'figure', attributes: { class: 'xb-map', 'data-xb-map': literal(map.embed) } },
      children: [
        {
          name: 'xb/element',
          attrs: { uid: uid(), tag: 'a', attributes: { class: 'xb-map__open', href: literal(map.link) } },
          children: [text(label.trim() || t('Mappa'), 'xb-map__label'), text(t('Carica la mappa ({0})', map.provider), 'xb-map__hint')],
        },
      ],
    },
  ];
}
