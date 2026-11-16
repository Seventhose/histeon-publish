import { describe, expect, it } from 'vitest';
import { print } from '@xb/dsl';
import { fileHref, focalPoint, imageAttributes, LINK_KINDS, literal, mediaElement, mediaFilter, mediaKind, mapBlocks, mapFromUrl, pageImages, videoBlocks, withFocalPoint, type MediaItem } from '../src/lib/media.ts';

const item = {
  id: 5,
  source_url: 'https://example.test/wp-content/uploads/a.jpg',
  alt_text: 'Un {titolo} pericoloso',
  title: { rendered: 'Foto &amp; <b>titolo</b>' },
  media_details: {
    width: 2000,
    height: 1000,
    sizes: {
      thumbnail: { source_url: 'https://example.test/a-150x150.jpg', width: 150, height: 150 },
      medium: { source_url: 'https://example.test/a-300x150.jpg', width: 300, height: 150 },
      large: { source_url: 'https://example.test/a-1024x512.jpg', width: 1024, height: 512 },
    },
  },
};

describe('media picker', () => {
  it('builds img attributes with same-ratio sizes only', () => {
    const attrs = imageAttributes(item);
    expect(attrs.src).toBe('https://example.test/wp-content/uploads/a.jpg');
    expect(attrs.srcset).toBe('https://example.test/a-300x150.jpg 300w, https://example.test/a-1024x512.jpg 1024w, https://example.test/wp-content/uploads/a.jpg 2000w');
    expect(attrs.sizes).toBe('(max-width: 2000px) 100vw, 2000px');
    expect([attrs.width, attrs.height]).toEqual(['2000', '1000']);
  });

  it('keeps braces literal, so alt text is never read as an expression', () => {
    expect(imageAttributes(item).alt).toBe('Un \\{titolo\\} pericoloso');
    expect(literal('a}b{c')).toBe('a\\}b\\{c');
  });

  it('refuses non-http sources', () => {
    expect(() => imageAttributes({ ...item, source_url: 'javascript:alert(1)' })).toThrow();
    expect(() => imageAttributes({ ...item, source_url: '/relative.jpg' })).toThrow();
  });
});

describe('alternative texts and focal point (M4)', () => {
  it('reads and writes the focal point in the inline style, keeping the rest', () => {
    expect(focalPoint('')).toBeNull();
    expect(focalPoint('width: 10px; object-position: 30% 70%')).toEqual([30, 70]);
    expect(withFocalPoint('width: 10px; object-position: 1% 2%;', [33.4, 120])).toBe('width: 10px; object-position: 33% 100%');
    expect(withFocalPoint('object-position: 1% 2%', null)).toBe('');
    expect(withFocalPoint('', [50, 0])).toBe('object-position: 50% 0%');
  });

  it('lists the page images with their alt, telling missing, decorative and dynamic ones apart', () => {
    const img = (uid: string, attributes: Record<string, string | true>) => ({ name: 'xb/element', attrs: { uid, tag: 'img', attributes } });
    const list = pageImages([img('a', { src: '/a.png' }), img('b', { src: '/b.png', alt: '' }), img('c', { src: '{post.image}', alt: 'x' }), { name: 'xb/element', attrs: { uid: 'p', tag: 'p' } }, img('d', { src: '/d.png', alt: 'Logo \\{x\\}' })]);
    expect(list.map((i) => [i.uid, i.alt, i.dynamic])).toEqual([['a', null, false], ['b', '', false], ['c', 'x', true], ['d', 'Logo \\{x\\}', false]]);
  });
});

describe('video, audio and PDF from the library (M1)', () => {
  const item = (mime: string, extra: Partial<MediaItem> = {}): MediaItem => ({ id: 1, source_url: `https://example.test/wp-content/uploads/file.${mime.split('/')[1]}`, mime_type: mime, ...extra });

  it('knows the kind of a file and the REST filter for it', () => {
    expect(['image/webp', 'video/mp4', 'audio/mpeg', 'application/pdf', 'application/zip'].map((m) => mediaKind(item(m)))).toEqual(['image', 'video', 'audio', 'pdf', null]);
    expect(mediaFilter('pdf')).toEqual({ mime_type: 'application/pdf' });
    expect(mediaFilter('video')).toEqual({ media_type: 'video' });
    expect(mediaFilter('all')).toEqual({});
  });

  it('turns it into the right element, with literal text', () => {
    expect(mediaElement(item('video/mp4', { media_details: { width: 640, height: 360 } }), 'Clip')).toEqual({ tag: 'video', attributes: { src: 'https://example.test/wp-content/uploads/file.mp4', controls: true, preload: 'metadata', width: '640', height: '360' } });
    expect(mediaElement(item('audio/mpeg'), '')).toEqual({ tag: 'audio', attributes: { src: 'https://example.test/wp-content/uploads/file.mpeg', controls: true, preload: 'metadata' } });
    expect(mediaElement(item('application/pdf'), 'Listino {2026}')).toEqual({ tag: 'a', attributes: { href: 'https://example.test/wp-content/uploads/file.pdf' }, text: 'Listino \\{2026\\}' });
    expect(() => mediaElement(item('application/zip'), 'x')).toThrow();
    expect(() => mediaElement({ id: 2, source_url: 'javascript:alert(1)', mime_type: 'video/mp4' }, 'x')).toThrow();
  });
});

describe('a link to a file of the library (Publish doc 23, item 176)', () => {
  const item = (mime: string, url = 'https://example.test/wp-content/uploads/listino-{2026}.pdf'): MediaItem => ({ id: 1, source_url: url, mime_type: mime });

  it('gives the address of the attachment file of an image or a PDF', () => {
    expect(LINK_KINDS).toEqual(['pdf', 'image']);
    // The URL parser encodes braces: nothing in the address can read as an expression.
    expect(fileHref(item('application/pdf'))).toBe('https://example.test/wp-content/uploads/listino-%7B2026%7D.pdf');
    expect(fileHref(item('image/jpeg', 'https://example.test/wp-content/uploads/a.jpg'))).toBe('https://example.test/wp-content/uploads/a.jpg');
  });

  it('refuses video, audio, other files and addresses that are not http(s)', () => {
    for (const mime of ['video/mp4', 'audio/mpeg', 'application/zip']) expect(() => fileHref(item(mime))).toThrow();
    expect(() => fileHref(item('application/pdf', 'javascript:alert(1)'))).toThrow();
  });
});

describe('video that loads on click (E9)', () => {
  const info = { provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Un {video}', watch: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', embed: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', poster: { id: 5, url: 'https://sito.test/wp-content/uploads/video-youtube.jpg', width: 480, height: 360 } } as const;
  let n = 0;
  const uid = () => `v${++n}`;

  it('is a link to the video with the poster served by the site, and the player address for the script', () => {
    const html = print(videoBlocks(info, uid));
    expect(html).toContain('<figure class="xb-video" data-xb-video="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ">');
    expect(html).toContain('<a class="xb-video__play" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" aria-label="Riproduci il video: Un \\{video\\}">');
    expect(html).toContain('<img src="https://sito.test/wp-content/uploads/video-youtube.jpg" alt="" width="480" height="360" loading="lazy"');
    expect(html).toContain('<span class="xb-video__icon" aria-hidden="true"></span>');
    expect(html).not.toContain('ytimg');
  });

  it('works without a poster too', () => {
    const html = print(videoBlocks({ ...info, title: '', poster: null }, uid));
    expect(html).not.toContain('<img');
    expect(html).toContain('aria-label="Riproduci il video"');
  });
});

describe('map that loads on click (E11)', () => {
  it('reads OpenStreetMap and Google Maps links, and nothing else', () => {
    const osm = mapFromUrl('https://www.openstreetmap.org/?mlat=45.4642&mlon=9.19#map=16/45.4642/9.1900');
    expect(osm).toEqual({ provider: 'OpenStreetMap', embed: 'https://www.openstreetmap.org/export/embed.html?bbox=9.185%2C45.4602%2C9.195%2C45.4682&layer=mapnik&marker=45.4642%2C9.19', link: 'https://www.openstreetmap.org/?mlat=45.4642&mlon=9.19#map=16/45.4642/9.19' });
    expect(mapFromUrl('https://www.openstreetmap.org/#map=12/41.9/12.5')?.embed).toContain('marker=41.9%2C12.5');
    const google = mapFromUrl('https://www.google.com/maps/place/Duomo/@45.4642,9.19,17z/data=x');
    expect(google?.embed).toBe('https://maps.google.com/maps?q=45.4642%2C9.19&z=17&output=embed');
    const embed = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2797';
    expect(mapFromUrl(`<iframe src="${embed}" width="600"></iframe>`)?.embed).toBe(embed);
    expect(mapFromUrl('https://evil.example/maps?q=1,2')).toBeNull();
    expect(mapFromUrl('https://www.google.com/maps/embed?pb=x" onload="alert(1)')).toBeNull();
  });

  it('is a link to the map with a label, and the player address for the script', () => {
    let n = 0;
    const html = print(mapBlocks(mapFromUrl('https://www.openstreetmap.org/#map=12/41.9/12.5')!, 'Sede {Roma}', () => `m${++n}`));
    expect(html).toContain('<figure class="xb-map" data-xb-map="https://www.openstreetmap.org/export/embed.html?bbox=');
    expect(html).toContain('<a class="xb-map__open" href="https://www.openstreetmap.org/#map=12/41.9/12.5">');
    expect(html).toContain('Sede \\{Roma\\}');
    expect(html).toContain('Carica la mappa (OpenStreetMap)');
  });
});
