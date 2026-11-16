import { describe, expect, it } from 'vitest';
import { allowedOrigin, canvasCsp, originsOf } from '../src/lib/canvasPolicy.ts';

const base = 'https://sito.test/wp-admin/admin.php?action=xb_builder';

describe('what the canvas may load (S5)', () => {
  it('limits media, fonts and styles to the site and the declared origins', () => {
    const csp = canvasCsp(['https://cdn.sito.test', 'https://fonts.example']);
    expect(csp).toContain("img-src 'self' data: blob: https://cdn.sito.test https://fonts.example;");
    expect(csp).toContain("font-src 'self' data: https://cdn.sito.test https://fonts.example;");
    expect(csp).toContain("media-src 'self' https://cdn.sito.test https://fonts.example;");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://cdn.sito.test https://fonts.example;");
    expect(csp).not.toMatch(/(img|font|media|style)-src [^;]*\*/);
    expect(csp).toContain("script-src 'none'");
  });

  it('keeps only real origins (https, or http for local sites), never paths or wildcards', () => {
    expect(originsOf(['https://cdn.sito.test/path/x.css', 'http://localhost:8080/a', 'javascript:alert(1)', '*', 'https://a.test;img-src *', ''])).toEqual(['https://cdn.sito.test', 'http://localhost:8080']);
  });

  it('says whether an address may be loaded', () => {
    const allowed = ['https://cdn.sito.test'];
    expect(allowedOrigin('/wp-content/uploads/a.jpg', allowed, base)).toBe(true);
    expect(allowedOrigin('https://sito.test/wp-content/uploads/a.jpg', allowed, base)).toBe(true);
    expect(allowedOrigin('https://cdn.sito.test/a.jpg', allowed, base)).toBe(true);
    expect(allowedOrigin('data:image/png;base64,AAAA', allowed, base)).toBe(true);
    expect(allowedOrigin('https://altro.example/a.jpg', allowed, base)).toBe(false);
    expect(allowedOrigin('//altro.example/a.jpg', allowed, base)).toBe(false);
  });
});
