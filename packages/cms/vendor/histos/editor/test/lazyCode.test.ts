import { beforeAll, describe, expect, it } from 'vitest';

let codeUrl: (script?: string, page?: string) => string;
beforeAll(async () => {
  // The block editor's globals, as far as the module reads them when it loads.
  (globalThis as unknown as { window: unknown }).window = { wp: { element: { createElement: () => null } } };
  ({ codeUrl } = await import('../src/gutenberg/lazyCode.ts'));
});

// Note 2 of the 3 November 2026 audit: the code module is imported only from this site's own Gutenberg assets.
describe('codeUrl', () => {
  const page = 'https://sito.example/wp-admin/post.php?post=1';
  it('finds the module beside the inspector, with its version', () => {
    expect(codeUrl('https://sito.example/wp-content/plugins/xb/assets/gutenberg/inspector.js?ver=0.5.1', page)).toBe('https://sito.example/wp-content/plugins/xb/assets/gutenberg/inspector-code.js?ver=0.5.1');
  });
  it('imports nothing from another origin or another folder', () => {
    expect(codeUrl('https://cdn.evil.example/assets/gutenberg/inspector.js', page)).toBe('');
    expect(codeUrl('https://sito.example/wp-content/uploads/inspector.js', page)).toBe('');
    expect(codeUrl('data:text/javascript,alert(1)', page)).toBe('');
    expect(codeUrl('', page)).toBe('');
  });
});
