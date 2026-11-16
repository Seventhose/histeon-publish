import { describe, expect, it } from 'vitest';
import type { Api, Change } from '../src/lib/api.ts';
import { MAX_PAGES, pageTargets } from '../src/lib/pages.ts';

/** The pages of a release for the Publish window: what is checked, what is left out, and how many in all (M-B1). */
describe('pageTargets', () => {
  const api = { previewLink: async (id: number) => ({ url: `/?page_id=${id}&xb_preview=x`, live: `/pagina-${id}/` }) } as unknown as Api;
  const changes = (n: number): Change[] => Array.from({ length: n }, (_, i) => ({ doc: `post:${i + 1}`, label: `Pagina ${i + 1}` }) as unknown as Change);

  it('counts the pages left out past MAX_PAGES in the total', async () => {
    const found = await pageTargets(api, 0, changes(10), false);
    expect(found.targets).toHaveLength(MAX_PAGES);
    expect(found.skipped).toHaveLength(10 - MAX_PAGES);
    expect(found.total).toBe(10);
  });
  it('all pages within the limit: total equals the targets', async () => {
    const found = await pageTargets(api, 0, changes(3), false);
    expect(found.targets).toHaveLength(3);
    expect(found.total).toBe(3);
  });
});
