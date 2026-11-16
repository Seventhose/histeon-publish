import { describe, expect, it } from 'vitest';
import { collectionTree, collectionsUrl, compressible, fitWithin, webpName } from '../src/lib/mediaManager.ts';

describe('media manager', () => {
  it('orders collections as a tree and survives loops', () => {
    const tree = collectionTree([
      { id: 3, name: 'Eventi 2026', parent: 2, count: 1 },
      { id: 2, name: 'Eventi', parent: 0, count: 0 },
      { id: 1, name: 'Archivio', parent: 0, count: 4 },
      { id: 5, name: 'Orfana', parent: 99, count: 0 },
      { id: 6, name: 'A', parent: 7, count: 0 },
      { id: 7, name: 'B', parent: 6, count: 0 },
    ]);
    expect(tree.map((c) => `${'-'.repeat(c.depth)}${c.name}`)).toEqual(['Archivio', 'Eventi', '-Eventi 2026', 'Orfana', 'A', 'B']);
  });

  it('decides what and how to compress', () => {
    expect(fitWithin(4000, 3000, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(compressible('image/gif')).toBe(false);
    expect(compressible('image/svg+xml')).toBe(false);
    expect(compressible('image/jpeg')).toBe(true);
    expect(webpName('Foto.Mare.JPG')).toBe('Foto.Mare.webp');
  });

  it('finds the collections route next to the media one', () => {
    expect(collectionsUrl('https://x.it/wp-json/wp/v2/media')).toBe('https://x.it/wp-json/wp/v2/xb_media_collection');
    expect(collectionsUrl('https://x.it/?rest_route=/wp/v2/media')).toBe('https://x.it/?rest_route=/wp/v2/xb_media_collection');
  });
});
