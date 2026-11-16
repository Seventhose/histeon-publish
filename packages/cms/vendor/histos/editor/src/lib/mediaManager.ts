// Media manager (docs/spec/media.md): nested collections, compression before upload. Pure helpers are tested
// in test/mediaManager.test.ts; compress() runs in the browser.

import { t } from './i18n.ts';
import { MIME, encodeInWorker, fitWithin, lightest, renamed, variantsFor, type Format } from './imageEncoder.ts';
import { readImageHeader, refusal } from './imageHeader.ts';

export { fitWithin } from './imageEncoder.ts';

export interface Collection {
  id: number;
  name: string;
  parent: number;
  count: number;
}

/** Collections as a tree, depth first, each with its depth; a parent missing or a loop puts a node at the top. */
export function collectionTree(list: Collection[]): Array<Collection & { depth: number }> {
  const byParent = new Map<number, Collection[]>();
  const ids = new Set(list.map((c) => c.id));
  for (const c of list) {
    const parent = ids.has(c.parent) && c.parent !== c.id ? c.parent : 0;
    byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
  }
  const out: Array<Collection & { depth: number }> = [];
  const seen = new Set<number>();
  const walk = (parent: number, depth: number) => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(c.id) || depth > 20) continue;
      seen.add(c.id);
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(0, 0);
  for (const c of list) if (!seen.has(c.id)) out.push({ ...c, depth: 0 });
  return out;
}

export interface Preset {
  /** `web`, `light`, `original`, or the id of one of the site's own presets (doc 26 voce 209). */
  id: string;
  label: string;
  max: number;
  /** Tried in the encoder (lista migliorie M5); the lightest is kept, and only if it weighs less than the original. */
  formats: Format[];
  /** Quality of lossy files, for a site's own preset; Publish's level otherwise. */
  quality?: number;
}

/** A preset of the site as the server keeps it (POST xb/v1/media/presets). */
export interface SitePreset {
  id: string;
  label: string;
  max: number;
  formats: Format[];
  quality: number;
}

export const fromSite = (p: SitePreset): Preset => ({ id: p.id, label: p.label, max: p.max, formats: p.formats, quality: p.quality });

export const PRESETS: Preset[] = [
  { id: 'web', label: t('Web (max 2560 px, AVIF o WebP)'), max: 2560, formats: ['avif', 'webp'] },
  { id: 'light', label: t('Leggera (max 1600 px, AVIF o WebP)'), max: 1600, formats: ['avif', 'webp'] },
  { id: 'original', label: t('Originale'), max: 0, formats: [] },
];

/** Raster photos and graphics are compressed; GIF (animation), SVG and others are sent as they are. */
export function compressible(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
}

export const webpName = (name: string): string => `${name.replace(/\.[a-z0-9]+$/i, '') || 'immagine'}.webp`;

/** The REST route of the collections, next to wp/v2/media (pretty or plain permalinks). */
export function collectionsUrl(mediaUrl: string): string {
  return mediaUrl.replace(/wp\/v2\/media(?=$|[?&#])/, 'wp/v2/xb_media_collection');
}

/**
 * Resizes and converts in the browser before the upload (docs/spec/media.md): in the image encoder's worker when
 * the plugin serves it (`encoder`), AVIF or WebP as the preset says, the lightest kept. The header is read first:
 * a file too large, animated, or whose size cannot be read goes as it is, never decoded. Without the worker (no URL,
 * no WebAssembly, the worker failing) the browser's own WebP encoder is used, as before M5. The original is kept
 * when nothing made is lighter.
 */
export async function compress(file: File, preset: Preset, encoder: string | null = null): Promise<File> {
  if (preset.id === 'original' || !compressible(file.type) || typeof createImageBitmap !== 'function') return file;
  const header = readImageHeader(new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer()));
  if (refusal(file.size, header) || !header) return file;
  if (encoder) {
    try {
      const variants = variantsFor(header, preset.formats, preset.quality);
      const files = await encodeInWorker(encoder, { file, width: header.width, height: header.height, max: preset.max, variants });
      const best = lightest(files, file.size);
      return best ? new File([best.buffer], renamed(file.name, best.format), { type: MIME[best.format] }) : file;
    } catch {
      // Falls through to the browser's encoder.
    }
  }
  return canvasWebp(file, preset);
}

async function canvasWebp(file: File, preset: Preset): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const size = fitWithin(bitmap.width, bitmap.height, preset.max);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', (preset.quality ?? 75) / 100));
  if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file;
  return new File([blob], webpName(file.name), { type: 'image/webp' });
}
