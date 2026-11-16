import { describe, expect, it } from 'vitest';
import { CHECK_RULES, HEAVY_PAGE, LINK_LIMIT, blend, checksOutcome, brokenLinkProblem, brokenStatus, contrast, devOnlyMatcher, headingProblems, headProblems, headStatus, pageWeight, parseColor, pickLinks, probeLinks, probeTarget, siteProblems, vagueLink, weightProblem, type HeadFacts } from '../src/lib/checks.ts';

describe('page checks: the pure parts', () => {
  it('reads computed colours and measures contrast like WCAG', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual([255, 0, 0, 1]);
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual([0, 0, 0, 0.5]);
    expect(parseColor('rgb(0 0 0 / 50%)')).toEqual([0, 0, 0, 0.5]);
    expect(parseColor('transparent')).toBeNull();
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
    expect(contrast([119, 119, 119, 1], [255, 255, 255, 1])).toBeCloseTo(4.48, 1);
    expect(blend([0, 0, 0, 0.5], [255, 255, 255, 1])).toEqual([127.5, 127.5, 127.5, 1]);
  });

  it('knows a link that says nothing', () => {
    expect(vagueLink('Clicca qui')).toBe(true);
    expect(vagueLink('Leggi di più →')).toBe(true);
    expect(vagueLink('Read more…')).toBe(true);
    expect(vagueLink('Leggi il programma del festival')).toBe(false);
  });

  it('finds heading problems', () => {
    expect(headingProblems([2, 3], true).map((p) => p.rule)).toEqual(['h1-missing']);
    expect(headingProblems([2, 3], false)).toEqual([]);
    expect(headingProblems([1, 2, 4, 1], true).map((p) => [p.rule, p.index])).toEqual([
      ['h1-many', 3],
      ['heading-skip', 2],
    ]);
    expect(headingProblems([1, 2, 3, 2, 3], true)).toEqual([]);
  });
});

describe('parseColor: colours as browsers compute Histeon CSS tokens', () => {
  it('oklch, with lightness as a number or a percentage', () => {
    expect(parseColor('oklch(0.534 0.125 247.7)')).toEqual([34, 113, 177, 1]);
    expect(parseColor('oklch(53.4% 0.125 247.7)')).toEqual([34, 113, 177, 1]);
    expect(parseColor('oklch(0.995 0 0)')).toEqual([253, 253, 253, 1]);
    expect(parseColor('oklch(0.2 0.02 250 / 0.5)')?.[3]).toBe(0.5);
    expect(parseColor('oklch(0.5 none none)')).toEqual(parseColor('oklch(0.5 0 0)'));
  });
  it('oklab and color(srgb)', () => {
    expect(parseColor('oklab(1 0 0)')).toEqual([255, 255, 255, 1]);
    expect(parseColor('color(srgb 1 0 0 / 25%)')).toEqual([255, 0, 0, 0.25]);
    expect(parseColor('color(display-p3 1 0 0)')).toBeNull();
  });
  it('contrast of a Histeon CSS pair', () => {
    const text = parseColor('oklch(0.2 0.02 250)')!;
    const bg = parseColor('oklch(0.995 0 0)')!;
    expect(contrast(text, bg)).toBeGreaterThan(14);
  });
});

describe('publish window rules (V1.4): each passes and fails', () => {
  const good: HeadFacts = { title: 'Chi siamo', lang: 'it-IT', description: 'Chi siamo e che cosa facciamo', canonical: 'https://example.test/chi-siamo/', robots: ['max-image-preview:large'] };
  const rules = (facts: HeadFacts, online = true, siteHidden = false) => headProblems(facts, { online, siteHidden }).map((f) => f.rule);

  it('a complete head passes', () => {
    expect(rules(good)).toEqual([]);
  });
  it('title-missing (error)', () => {
    const found = headProblems({ ...good, title: '  ' }, { online: true, siteHidden: false });
    expect(found.map((f) => [f.rule, f.severity])).toEqual([['title-missing', 'error']]);
  });
  it('description-missing (warning)', () => {
    expect(headProblems({ ...good, description: null }, { online: true, siteHidden: false }).map((f) => [f.rule, f.severity])).toEqual([['description-missing', 'warning']]);
    expect(rules({ ...good, description: '' })).toEqual(['description-missing']);
  });
  it('lang-missing (error)', () => {
    expect(headProblems({ ...good, lang: '' }, { online: true, siteHidden: false }).map((f) => [f.rule, f.severity])).toEqual([['lang-missing', 'error']]);
  });
  it('canonical-missing (info), only for a page already online', () => {
    expect(headProblems({ ...good, canonical: null }, { online: true, siteHidden: false }).map((f) => [f.rule, f.severity])).toEqual([['canonical-missing', 'info']]);
    // A page not online yet: WordPress prints the canonical address only once it is published.
    expect(rules({ ...good, canonical: null }, false)).toEqual([]);
  });
  it('noindex (warning), but not when the whole site is hidden', () => {
    expect(headProblems({ ...good, robots: ['noindex, follow'] }, { online: true, siteHidden: false }).map((f) => [f.rule, f.severity])).toEqual([['noindex', 'warning']]);
    expect(rules({ ...good, robots: ['NONE'] })).toEqual(['noindex']);
    expect(rules({ ...good, robots: ['index, follow'] })).toEqual([]);
    expect(rules({ ...good, robots: ['noindex'] }, true, true)).toEqual([]);
  });
  it('site-hidden (warning, never holds Publish), once for the release', () => {
    expect(siteProblems({ blogPublic: true })).toEqual([]);
    expect(siteProblems({ blogPublic: false }).map((f) => [f.rule, f.severity])).toEqual([['site-hidden', 'warning']]);
  });
  it('page-heavy (warning) above 1.5 MB, from the measured sizes', () => {
    expect(pageWeight([{ encodedBodySize: 40_000 }, { encodedBodySize: 900_000 }, {}, { encodedBodySize: -1 }])).toBe(940_000);
    expect(weightProblem(pageWeight([{ encodedBodySize: 40_000 }, { encodedBodySize: 900_000 }]))).toBeNull();
    expect(weightProblem(HEAVY_PAGE)).toBeNull();
    const heavy = weightProblem(pageWeight([{ encodedBodySize: 1_000_000 }, { encodedBodySize: 800_000 }]));
    expect([heavy?.rule, heavy?.severity]).toEqual(['page-heavy', 'warning']);
    expect(heavy?.message).toContain('1.7');
  });
  it('page-heavy uses 1.5 MiB, the threshold of Histeon Publish (site-check.ts HEAVY_PAGE_BYTES)', () => {
    expect(HEAVY_PAGE).toBe(1_572_864);
    expect(weightProblem(1_550_000)).toBeNull();
    expect(weightProblem(1_572_864)).toBeNull();
    expect(weightProblem(1_572_865)?.rule).toBe('page-heavy');
  });
});

describe('link-broken (V1.4): which links, how they are tried, what is broken', () => {
  const origin = 'https://example.test';
  const base = 'https://example.test/chi-siamo/?xb_preview=1.2.3.abc';

  it('tries only links of the same site, never the admin, the API or a signed preview', () => {
    expect(probeTarget('/contatti/#modulo', base, origin)).toBe('https://example.test/contatti/');
    expect(probeTarget('../servizi/', base, origin)).toBe('https://example.test/servizi/');
    expect(probeTarget('https://altro.test/pagina/', base, origin)).toBeNull();
    expect(probeTarget('mailto:info@example.test', base, origin)).toBeNull();
    expect(probeTarget('tel:+390000', base, origin)).toBeNull();
    expect(probeTarget('javascript:void(0)', base, origin)).toBeNull();
    expect(probeTarget('#sezione', base, origin)).toBeNull(); // the page itself, at its preview address
    expect(probeTarget('/wp-admin/post.php', base, origin)).toBeNull();
    expect(probeTarget('/wp-login.php', base, origin)).toBeNull();
    expect(probeTarget('/wp-json/wp/v2/pages', base, origin)).toBeNull();
    expect(probeTarget('/?rest_route=/wp/v2/pages', base, origin)).toBeNull();
  });

  it('tries each address once, at most 200 per release', () => {
    expect(pickLinks(['https://example.test/a/', null, 'https://example.test/a/', 'https://example.test/b/'])).toEqual({ urls: ['https://example.test/a/', 'https://example.test/b/'], over: 0 });
    const many = Array.from({ length: 250 }, (_, i) => `https://example.test/p${i}/`);
    const picked = pickLinks(many);
    expect(picked.urls).toHaveLength(LINK_LIMIT);
    expect(picked.over).toBe(50);
  });

  it('404 and 410 are broken; any other answer, a network error or a timeout is not', () => {
    expect(brokenStatus(404)).toBe(true);
    expect(brokenStatus(410)).toBe(true);
    for (const s of [200, 301, 403, 405, 500, 503, null, undefined]) expect(brokenStatus(s)).toBe(false);
    expect(brokenLinkProblem('/vecchia/', 404, 'u1')).toMatchObject({ rule: 'link-broken', severity: 'warning', uid: 'u1' });
  });

  it('a HEAD never follows a redirect and never sends cookies; a redirect is reachable, not broken (M-B2)', async () => {
    const seen: RequestInit[] = [];
    const answer = (type: ResponseType, status: number) => ({ type, status }) as Response;
    const fetcher = (async (_url: string, init: RequestInit) => (seen.push(init), _url.endsWith('/altrove/') ? answer('opaqueredirect', 0) : answer('basic', 404))) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    expect(await headStatus(origin + '/altrove/', signal, fetcher)).toBe(0);
    expect(brokenStatus(await headStatus(origin + '/altrove/', signal, fetcher))).toBe(false);
    expect(await headStatus(origin + '/sparita/', signal, fetcher)).toBe(404);
    for (const init of seen) expect(init).toMatchObject({ method: 'HEAD', credentials: 'omit', redirect: 'manual', signal });
  });

  it('probes 4 at a time, each stopped after its timeout', async () => {
    let active = 0;
    let peak = 0;
    const head = (url: string, signal: AbortSignal) =>
      new Promise<number>((resolve, reject) => {
        active++;
        peak = Math.max(peak, active);
        const end = () => active--;
        if (url.endsWith('/lenta/')) {
          signal.addEventListener('abort', () => (end(), reject(new Error('aborted'))));
          return;
        }
        if (url.endsWith('/rete/')) return setTimeout(() => (end(), reject(new TypeError('Failed to fetch'))), 1);
        setTimeout(() => (end(), resolve(url.endsWith('/sparita/') ? 404 : 200)), 2);
      });
    const urls = ['/a/', '/b/', '/c/', '/d/', '/e/', '/sparita/', '/lenta/', '/rete/'].map((p) => origin + p);
    const status = await probeLinks(urls, head, { concurrency: 4, timeout: 30 });
    expect(peak).toBe(4);
    expect(status.get(origin + '/sparita/')).toBe(404);
    expect(status.get(origin + '/a/')).toBe(200);
    expect(status.get(origin + '/lenta/')).toBeNull();
    expect(status.get(origin + '/rete/')).toBeNull();
    expect(status.size).toBe(urls.length);
  });

  it('a page that exists only in development is not a broken link', () => {
    const devOnly = devOnlyMatcher([
      { id: 7, slug: 'nuova-pagina', status: 'draft', url: 'https://example.test/?page_id=7' },
      { id: 8, slug: 'chi-siamo', status: 'publish', url: 'https://example.test/chi-siamo/' },
      { id: 9, slug: 'in-arrivo', status: 'future' },
    ]);
    expect(devOnly('https://example.test/nuova-pagina/')).toBe(true);
    expect(devOnly('https://example.test/?page_id=7')).toBe(true);
    expect(devOnly('https://example.test/?p=9')).toBe(true);
    expect(devOnly('https://example.test/chi-siamo/')).toBe(false);
    expect(devOnly('https://example.test/vecchia-pagina/')).toBe(false);
  });
});

describe('the outcome sent with a release (V1.5)', () => {
  const finding = (rule: string, severity: 'error' | 'warning' | 'info') => ({ rule, severity, area: 'SEO' as const, message: '', uid: null });

  it('counts errors, things to review and findings per known rule', () => {
    const outcome = checksOutcome([finding('img-alt', 'error'), finding('img-alt', 'error'), finding('noindex', 'warning'), finding('img-size', 'info'), finding('css-important', 'warning')], 42);
    expect(outcome).toEqual({ errors: 2, warnings: 3, rules: { 'img-alt': 2, noindex: 1, 'img-size': 1 }, at: 42 });
  });
  it('a clean round is zeros, not nothing', () => {
    expect(checksOutcome([], 7)).toEqual({ errors: 0, warnings: 0, rules: {}, at: 7 });
  });
  it('says how many pages it checked of those of the release (M-B1)', () => {
    expect(checksOutcome([], 7, { checked: 4, total: 10 })).toEqual({ errors: 0, warnings: 0, rules: {}, at: 7, pages: { checked: 4, total: 10 } });
    // Never more checked than there are.
    expect(checksOutcome([], 7, { checked: 3, total: 1 }).pages).toEqual({ checked: 3, total: 3 });
  });
  it('every rule the window can report is in CHECK_RULES, the list the server accepts', () => {
    expect(new Set(CHECK_RULES).size).toBe(CHECK_RULES.length);
    expect(CHECK_RULES.length).toBeLessThanOrEqual(40);
    for (const rule of ['site-hidden', 'page-heavy', 'link-broken', 'title-missing', 'contrast']) expect(CHECK_RULES).toContain(rule);
  });
});
