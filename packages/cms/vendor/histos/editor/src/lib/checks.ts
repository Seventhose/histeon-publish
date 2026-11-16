// Checks of the page as drawn in the canvas (docs/spec/checks.md): accessibility, SEO and loading, each finding
// pointing to its element (data-xb-uid). The pure parts are tested in test/checks.test.ts; the DOM walk runs on
// the canvas document, whose computed styles are the site's own.

import { t } from './i18n.ts';
import { oklabToRgb, oklchToRgb, rgbToOklch } from './oklch.ts';

export type Severity = 'error' | 'warning' | 'info';
export type Area = 'Accessibilità' | 'SEO' | 'Prestazioni' | 'CSS';

/**
 * Every rule of the Publish window, the only names the server keeps with a release (V1.5). The same list, in the
 * same order, is ReleaseChecks::RULES in plugin/src/Versioning/ReleaseChecks.php (ReleaseChecksTest compares them):
 * a new rule goes in both.
 */
export const CHECK_RULES = [
  'h1-missing',
  'h1-many',
  'heading-skip',
  'heading-empty',
  'img-src',
  'img-alt',
  'img-size',
  'img-big',
  'link-name',
  'link-vague',
  'link-href',
  'link-noopener',
  'button-name',
  'field-label',
  'iframe-title',
  'untranslated',
  'contrast',
  'title-missing',
  'description-missing',
  'lang-missing',
  'canonical-missing',
  'noindex',
  'site-hidden',
  'page-heavy',
  'link-broken',
] as const;

/** The outcome of the checks sent with a release: a reminder, not a proof (the server dates it and decides nothing on it). */
export interface ChecksOutcome {
  errors: number;
  warnings: number;
  rules: Record<string, number>;
  /** When the checks ended, in the browser (milliseconds): the server keeps its own date. */
  at: number;
  /**
   * M-B1: the pages of the release the round checked (loaded and read) of all of them; with fewer, the counts say
   * nothing of the others. Left out when the round could not tell.
   */
  pages?: { checked: number; total: number };
}

/** Errors, things to review (warnings and information, as the window counts them), findings per rule and, given, pages. */
export function checksOutcome(findings: Finding[], at: number, pages?: { checked: number; total: number }): ChecksOutcome {
  const rules: Record<string, number> = {};
  for (const f of findings) if ((CHECK_RULES as readonly string[]).includes(f.rule)) rules[f.rule] = (rules[f.rule] ?? 0) + 1;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const outcome: ChecksOutcome = { errors, warnings: findings.length - errors, rules, at };
  // Never more checked than there are: a total below the checked pages is raised to them.
  if (pages) outcome.pages = { checked: pages.checked, total: Math.max(pages.total, pages.checked) };
  return outcome;
}

export interface Finding {
  rule: string;
  severity: Severity;
  area: Area;
  message: string;
  uid: string | null;
}

type Rgba = [number, number, number, number];

const NUM = String.raw`(-?[\d.]+(?:e-?\d+)?%?|none)`;
const MODERN = new RegExp(String.raw`^(oklch|oklab|color)\(\s*(?:(srgb|srgb-linear)\s+)?` + `${NUM}\\s+${NUM}\\s+${NUM}` + String.raw`(?:\s*\/\s*` + NUM + String.raw`)?\s*\)$`, 'i');

/** A number of a modern colour function: `none` is 0, a percentage is scaled to `full`. */
function channel(v: string | undefined, full = 1): number {
  if (v === undefined || v === 'none') return 0;
  return v.endsWith('%') ? (Number.parseFloat(v) / 100) * full : Number.parseFloat(v);
}

/**
 * A computed colour as RGBA (0–255, alpha 0–1): `rgb()`/`rgba()`, and the `oklch()`, `oklab()` and
 * `color(srgb …)` that browsers return for colours written that way (Histeon CSS tokens). Null for anything else.
 */
export function parseColor(css: string): Rgba | null {
  const value = css.trim();
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  const n = MODERN.exec(value);
  if (!n) return null;
  const fn = n[1]!.toLowerCase();
  const alpha = n[6] === undefined ? 1 : channel(n[6]);
  let rgb: [number, number, number];
  if (fn === 'oklch') rgb = oklchToRgb(channel(n[3]), channel(n[4], 0.4), channel(n[5]));
  else if (fn === 'oklab') rgb = oklabToRgb(channel(n[3]), channel(n[4], 0.4), channel(n[5], 0.4));
  else if ((n[2] ?? '').toLowerCase() === 'srgb') rgb = [channel(n[3]) * 255, channel(n[4]) * 255, channel(n[5]) * 255];
  else return null; // srgb-linear and other spaces: not worth a guess.
  return [...rgb.map((x) => Math.round(Math.min(255, Math.max(0, x)))), alpha] as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** `top` over `bottom` (alpha blending). */
export function blend(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

export function contrast(a: Rgba, b: Rgba): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * The text colour nearest to `fg` that reaches `need` against `back` (lista della spesa 164): same hue and chroma in
 * OKLCH, only the lightness moves, towards dark or light, whichever needs the smaller change. Null when neither does.
 */
export function contrastFix(fg: Rgba, back: Rgba, need: number): { color: string; L: number; darker: boolean } | null {
  const [L, c, h] = rgbToOklch(fg[0], fg[1], fg[2]);
  const passes = (l: number) => {
    const [r, g, b] = oklchToRgb(l, c, h);
    return contrast([r, g, b, 1], back) >= need;
  };
  const search = (from: number, to: number): number | null => {
    if (!passes(to)) return null;
    let [lo, hi] = [from, to];
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (passes(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const dark = search(L, 0);
  const light = search(L, 1);
  const pick = dark === null ? light : light === null ? dark : Math.abs(L - dark) <= Math.abs(light - L) ? dark : light;
  if (pick === null) return null;
  const round = (x: number, d: number) => Number(x.toFixed(d));
  const darker = pick < L;
  // Rounded away from the limit: the written colour still passes.
  const l = darker ? Math.floor(pick * 1000) / 1000 : Math.ceil(pick * 1000) / 1000;
  return { color: `oklch(${l} ${round(c, 3)} ${round(h, 1)})`, L: l, darker };
}

const VAGUE = ['clicca qui', 'clicca', 'qui', 'link', 'leggi', 'leggi di più', 'leggi tutto', 'scopri di più', 'scopri', 'di più', 'continua', 'vai', 'click here', 'here', 'read more', 'more', 'learn more'];

/** A link text that says nothing about where it goes. */
export function vagueLink(text: string): boolean {
  const plain = text.toLowerCase().replace(/[\s.…:»›→>]+$/u, '').replace(/\s+/g, ' ').trim();
  return VAGUE.includes(plain);
}

/** Problems of a page's heading levels, in order: none, several h1, skipped levels. */
export function headingProblems(levels: number[], page: boolean): Array<{ index: number; message: string; severity: Severity; rule: string }> {
  const out: Array<{ index: number; message: string; severity: Severity; rule: string }> = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (page && levels.length > 0 && h1 === 0) out.push({ index: -1, rule: 'h1-missing', severity: 'warning', message: t('La pagina non ha un titolo H1: serve ai motori di ricerca e a chi usa un lettore di schermo') });
  if (h1 > 1) levels.forEach((l, i) => l === 1 && i !== levels.indexOf(1) && out.push({ index: i, rule: 'h1-many', severity: 'warning', message: t('Un secondo H1: una pagina ne ha uno solo') }));
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1] as number;
    const cur = levels[i] as number;
    if (cur > prev + 1) out.push({ index: i, rule: 'heading-skip', severity: 'warning', message: t('Da H{0} a H{1}: un livello saltato', prev, cur) });
  }
  return out;
}

const MAX_PER_RULE = 25;
const MAX_ELEMENTS = 4000;

const uidOf = (el: Element | null): string | null => el?.closest('[data-xb-uid]')?.getAttribute('data-xb-uid') ?? null;
const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
/** Hidden from assistive technology on purpose (a card's duplicate image link, decorative icons). */
const hidden = (el: Element) => !!el.closest('[aria-hidden="true"]');
const named = (el: Element) => !!(el.getAttribute('aria-label')?.trim() || el.getAttribute('aria-labelledby')?.trim() || el.getAttribute('title')?.trim());

/**
 * Every finding for the page drawn in `doc`. `page`: a whole page (not a component or a template part).
 * `quick`: only the rules that need no layout or computed styles (the errors the rail's counter shows); the
 * contrast, image size and translation rules wait for the Checks panel or the publish dialog.
 */
export function runChecks(doc: Document, { page, source = [], quick = false }: { page: boolean; source?: string[]; quick?: boolean }): Finding[] {
  const found: Finding[] = [];
  const count = new Map<string, number>();
  const add = (f: Finding) => {
    const n = (count.get(f.rule) ?? 0) + 1;
    count.set(f.rule, n);
    if (n <= MAX_PER_RULE) found.push(f);
  };
  const win = doc.defaultView;
  const body = doc.body;
  if (!win || !body) return found;
  const all = [...body.querySelectorAll('*')].slice(0, MAX_ELEMENTS);

  for (const img of body.querySelectorAll('img')) {
    const uid = uidOf(img);
    const quiet = hidden(img);
    if (!img.getAttribute('src') && !img.getAttribute('srcset')) {
      add({ rule: 'img-src', severity: 'warning', area: 'Accessibilità', uid, message: t('Immagine senza file: il contenuto non ne ha una. Mettila dentro {#if …} per non lasciare un’immagine vuota') });
      continue;
    }
    if (!quiet && !img.hasAttribute('alt')) add({ rule: 'img-alt', severity: 'error', area: 'Accessibilità', uid, message: t('Immagine senza testo alternativo (alt). Se è solo decorativa, alt=""') });
    if (!img.getAttribute('width') || !img.getAttribute('height')) add({ rule: 'img-size', severity: 'info', area: 'Prestazioni', uid, message: t('Immagine senza width e height: la pagina può saltare mentre carica') });
    if (quick) continue;
    const shown = img.getBoundingClientRect().width;
    if (img.naturalWidth > 1000 && shown > 0 && img.naturalWidth > shown * 2.5 && !img.srcset) {
      add({ rule: 'img-big', severity: 'warning', area: 'Prestazioni', uid, message: t('Immagine di {0}px mostrata a {1}px: usa una misura più piccola o srcset', img.naturalWidth, Math.round(shown)) });
    }
  }

  const headings = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  for (const p of headingProblems(headings.map((h) => Number(h.tagName.slice(1))), page)) {
    add({ rule: p.rule, severity: p.severity, area: p.rule.startsWith('h1') ? 'SEO' : 'Accessibilità', uid: p.index >= 0 ? uidOf(headings[p.index] ?? null) : null, message: p.message });
  }
  for (const h of headings) if (!text(h)) add({ rule: 'heading-empty', severity: 'warning', area: 'Accessibilità', uid: uidOf(h), message: t('{0} vuoto', h.tagName) });

  for (const a of body.querySelectorAll('a')) {
    if (hidden(a)) continue;
    const uid = uidOf(a);
    const label = text(a) || a.querySelector('img[alt]')?.getAttribute('alt')?.trim() || '';
    if (!label && !named(a)) add({ rule: 'link-name', severity: 'error', area: 'Accessibilità', uid, message: t('Link senza testo né nome accessibile: non si sa dove porta') });
    else if (label && vagueLink(label) && !named(a)) add({ rule: 'link-vague', severity: 'warning', area: 'Accessibilità', uid, message: t('Link «{0}»: il testo dovrebbe dire dove porta', label) });
    if (!a.getAttribute('href')) add({ rule: 'link-href', severity: 'warning', area: 'Accessibilità', uid, message: t('Link senza indirizzo: per un’azione serve un <button>') });
    if (a.getAttribute('target') === '_blank' && !/\bnoopener\b|\bnoreferrer\b/.test(a.getAttribute('rel') ?? '')) {
      add({ rule: 'link-noopener', severity: 'warning', area: 'Accessibilità', uid, message: t('Si apre in una nuova scheda senza rel="noopener"') });
    }
  }
  for (const b of body.querySelectorAll('button, [role="button"]')) {
    if (hidden(b)) continue;
    if (!text(b) && !named(b) && !b.querySelector('img[alt]:not([alt=""])')) add({ rule: 'button-name', severity: 'error', area: 'Accessibilità', uid: uidOf(b), message: t('Pulsante senza testo né aria-label') });
  }
  for (const f of body.querySelectorAll('input, select, textarea')) {
    const type = (f.getAttribute('type') ?? '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || hidden(f)) continue;
    const id = f.getAttribute('id');
    const labelled = named(f) || !!f.closest('label') || (!!id && !!doc.querySelector(`label[for="${CSS.escape(id)}"]`));
    if (!labelled) add({ rule: 'field-label', severity: 'error', area: 'Accessibilità', uid: uidOf(f), message: t('Campo senza etichetta (label)') });
  }
  for (const frame of body.querySelectorAll('iframe, [data-xb-embed]')) {
    if (frame.tagName === 'IFRAME' && !frame.getAttribute('title')?.trim()) add({ rule: 'iframe-title', severity: 'error', area: 'Accessibilità', uid: uidOf(frame), message: t('Contenuto incorporato senza title') });
  }

  // A translation: texts identical to the original's are probably not translated yet (Lingua Bridge sends them).
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  if (quick) return found.sort((a, b) => order[a.severity] - order[b.severity]);
  const original = new Set(source.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 12));
  if (original.size) {
    for (const el of all) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) continue;
      const own = text(el);
      if (own.length >= 12 && original.has(own)) add({ rule: 'untranslated', severity: 'warning', area: 'Accessibilità', uid: uidOf(el), message: t('Uguale all’originale, forse non tradotto: «{0}»', own.slice(0, 40)) });
    }
  }

  // Contrast of text on its background, where both are plain colours (an image or gradient behind: skipped).
  // The background of each element is worked out once per round, from its parent's: a page of thousands of texts
  // no longer reads the styles of every ancestor of every text.
  const white: Rgba = [255, 255, 255, 1];
  const backgrounds = new Map<Element, Rgba | null | 'unknown'>();
  const backgroundOf = (n: Element | null): Rgba | null | 'unknown' => {
    if (!n) return null;
    const known = backgrounds.get(n);
    if (known !== undefined) return known;
    const s = win.getComputedStyle(n);
    let result: Rgba | null | 'unknown';
    if (s.backgroundImage && s.backgroundImage !== 'none') result = 'unknown';
    else {
      const c = parseColor(s.backgroundColor);
      if (c && c[3] >= 1) result = c;
      else {
        const below = backgroundOf(n.parentElement);
        result = !c || c[3] === 0 ? below : below === 'unknown' ? 'unknown' : below ? blend(c, below) : c;
      }
    }
    backgrounds.set(n, result);
    return result;
  };
  for (const el of all) {
    if (!(el instanceof win.HTMLElement)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) continue;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = backgroundOf(el);
    if (bg === 'unknown') continue;
    const back = bg && bg[3] < 1 ? blend(bg, white) : (bg ?? white);
    const ratio = contrast(blend(fg, back), back);
    const size = Number.parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      // In plain words, with the nearest colour that passes (lista della spesa 164).
      const fix = contrastFix(blend(fg, back), back, need);
      const message = t('Contrasto {0}:1 (serve almeno {1}:1) per «{2}»: il testo si legge a fatica.', ratio.toFixed(2), need, text(el).slice(0, 30));
      add({ rule: 'contrast', severity: 'warning', area: 'Accessibilità', uid: uidOf(el), message: fix ? `${message} ${fix.darker ? t('Con la stessa tinta, più scuro: {0}.', fix.color) : t('Con la stessa tinta, più chiaro: {0}.', fix.color)}` : `${message} ${t('Cambia lo sfondo: nessuna tinta di questo colore basta.')}` });
    }
  }
  return found.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ── Rules of the publish window only (V1.4): the page's head, the whole site, links and weight ──────────────────
// They read the development preview loaded by PublishChecks.svelte, never the canvas (whose head is the builder's).
// The parts below take plain data, so they are tested without a browser; the DOM reading is in headFacts().

/** What the head of a page says. `robots`: the robots directives of the page, not the preview's own (data-xb-preview). */
export interface HeadFacts {
  title: string;
  lang: string;
  description: string | null;
  canonical: string | null;
  robots: string[];
}

/** Reads the head of a page loaded in the publish window. */
export function headFacts(doc: Document): HeadFacts {
  const meta = (name: string) => [...doc.querySelectorAll('meta[name]')].filter((m) => (m.getAttribute('name') ?? '').trim().toLowerCase() === name);
  return {
    title: (doc.querySelector('head title')?.textContent ?? '').trim(),
    lang: (doc.documentElement.getAttribute('lang') ?? '').trim(),
    description: meta('description')[0]?.getAttribute('content')?.trim() ?? null,
    canonical: doc.querySelector('link[rel~="canonical" i][href]')?.getAttribute('href')?.trim() || null,
    // The preview prints its own `noindex` (Preview.php), marked so it is never taken for the page's.
    robots: [...meta('robots'), ...meta('googlebot')].filter((m) => !m.hasAttribute('data-xb-preview')).map((m) => m.getAttribute('content') ?? ''),
  };
}

/**
 * Findings of a page's head. `online`: the page is already online (its canonical address can be judged: WordPress
 * and the SEO plugins print it only for published pages). `siteHidden`: the whole site asks not to be indexed, which
 * puts a `noindex` on every page: «site-hidden» says it once, the pages do not repeat it.
 */
export function headProblems(facts: HeadFacts, { online, siteHidden }: { online: boolean; siteHidden: boolean }): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, area: Area, message: string) => out.push({ rule, severity, area, message, uid: null });
  if (!facts.title.trim()) add('title-missing', 'error', 'SEO', t('La pagina non ha un titolo (<title>): è il nome nei risultati di ricerca e nella scheda del browser. Dai un titolo alla pagina in WordPress o nel plugin SEO.'));
  if (!facts.description?.trim()) add('description-missing', 'warning', 'SEO', t('La pagina non ha una descrizione (meta description): i motori di ricerca ne prendono un pezzo a caso. Scrivila nel plugin SEO del sito.'));
  if (!facts.lang.trim()) add('lang-missing', 'error', 'Accessibilità', t('La pagina non dichiara la lingua (lang su <html>): un lettore di schermo la legge con la pronuncia sbagliata. Controlla la lingua del sito in Impostazioni → Generali e che il tema la scriva.'));
  if (online && !facts.canonical?.trim()) add('canonical-missing', 'info', 'SEO', t('La pagina non ha un indirizzo canonico (link rel="canonical"): con più indirizzi per la stessa pagina i motori di ricerca scelgono da soli. Attivalo nel plugin SEO o nel tema.'));
  if (!siteHidden && facts.robots.some((r) => /\b(noindex|none)\b/i.test(r))) add('noindex', 'warning', 'SEO', t('La pagina chiede ai motori di ricerca di non mostrarla (robots noindex). Se non è voluto, toglilo nel plugin SEO o nelle impostazioni della pagina.'));
  return out;
}

/** Findings of the whole release, said once: WordPress «Scoraggia i motori di ricerca» (`blog_public` off). */
export function siteProblems({ blogPublic }: { blogPublic: boolean }): Finding[] {
  return blogPublic ? [] : [{ rule: 'site-hidden', severity: 'warning', area: 'SEO', uid: null, message: t('Il sito chiede ai motori di ricerca di non indicizzarlo («Scoraggia i motori di ricerca» in Impostazioni → Lettura di WordPress). Se il sito deve farsi trovare, togli quella spunta prima di andare online.') }];
}

/** Above this many bytes a page is heavy: 1,5 MiB, the same threshold as «Controlla il sito» in Histeon Publish. */
export const HEAVY_PAGE = 1.5 * 1024 * 1024;

/** Bytes of a page: the body of its HTML (navigation entry) and of every resource it loaded, as the browser measured them. */
export function pageWeight(entries: Array<{ encodedBodySize?: number }>): number {
  return entries.reduce((n, e) => n + (typeof e.encodedBodySize === 'number' && e.encodedBodySize > 0 ? e.encodedBodySize : 0), 0);
}

/**
 * A page heavier than HEAVY_PAGE. The measure is a lower bound: in the publish window the page runs without its
 * scripts, images below the fold that load lazily are not loaded, and other sites' files without
 * Timing-Allow-Origin count 0. A page found heavy is heavy for sure.
 */
export function weightProblem(bytes: number): Finding | null {
  if (bytes <= HEAVY_PAGE) return null;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return { rule: 'page-heavy', severity: 'warning', area: 'Prestazioni', uid: null, message: t('La pagina pesa almeno {0} MB (oltre 1,5 MB): al telefono si carica piano. Usa immagini più piccole (WebP o AVIF, misure giuste, srcset) e togli i file che non servono.', mb) };
}

/** At most this many links tried per release, this many at a time, each for at most this long. */
export const LINK_LIMIT = 200;
export const LINK_CONCURRENCY = 4;
export const LINK_TIMEOUT = 5000;

/**
 * The address worth a HEAD for a link of a page, or null: only links of the same site (`origin`), never another
 * site; never the admin, the login, the REST API or a signed preview link (an anchor of the page itself resolves to
 * the preview address, so it is left out too). The fragment is dropped.
 */
export function probeTarget(href: string, base: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) return null;
  if (url.searchParams.has('xb_preview') || url.searchParams.has('rest_route') || /\/(wp-admin|wp-json)(\/|$)|\/wp-login\.php$/.test(url.pathname)) return null;
  url.hash = '';
  return url.href;
}

/** The addresses to try, each once, in order, at most `limit`; `over`: how many were left out. */
export function pickLinks(targets: Array<string | null>, limit = LINK_LIMIT): { urls: string[]; over: number } {
  const unique = [...new Set(targets.filter((u): u is string => u !== null))];
  return { urls: unique.slice(0, limit), over: Math.max(0, unique.length - limit) };
}

/** A status that means «this page does not exist». Anything else, a network error or a timeout included, is not «broken». */
export const brokenStatus = (status: number | null | undefined): boolean => status === 404 || status === 410;

/**
 * One HEAD from the browser, without cookies and without following redirects (M-B2): a same-site link that sends
 * elsewhere would otherwise start a request to another address, or to the local network, in the name of whoever
 * publishes. A redirect already says «reachable»: the browser gives an opaque answer (status 0), never «broken».
 */
export async function headStatus(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<number> {
  const response = await fetcher(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', redirect: 'manual', signal });
  return response.type === 'opaqueredirect' ? 0 : response.status;
}

/**
 * Tries every address with `head(url, signal)` (a HEAD from the browser), `concurrency` at a time, each stopped after
 * `timeout` ms. The status of each, or null when the request failed or took too long.
 */
export async function probeLinks(urls: string[], head: (url: string, signal: AbortSignal) => Promise<number>, { concurrency = LINK_CONCURRENCY, timeout = LINK_TIMEOUT, signal }: { concurrency?: number; timeout?: number; signal?: AbortSignal } = {}): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next++] as string;
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), timeout);
      const cancel = () => stop.abort();
      signal?.addEventListener('abort', cancel);
      try {
        out.set(url, await head(url, stop.signal));
      } catch {
        out.set(url, null);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker));
  return out;
}

/**
 * Whether an address is a page that exists only in development (draft, pending, scheduled or private in WordPress):
 * visitors get a 404 there today, but that is not a broken link of the release. `items`: the site's pages and posts
 * (the builder's library), matched by id in `?p=`/`?page_id=`, by address, or by the last part of the path.
 */
export function devOnlyMatcher(items: Array<{ id: number; slug: string; status: string; url?: string }>): (url: string) => boolean {
  const hidden = items.filter((i) => i.status !== 'publish');
  const ids = new Set(hidden.map((i) => String(i.id)));
  const slugs = new Set(hidden.map((i) => i.slug).filter((s) => s !== ''));
  const urls = new Set(hidden.map((i) => i.url ?? '').filter((u) => u !== ''));
  return (address: string) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }
    if (urls.has(address)) return true;
    const id = url.searchParams.get('page_id') ?? url.searchParams.get('p');
    if (id !== null && ids.has(id)) return true;
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last !== undefined && slugs.has(decodeURIComponent(last));
  };
}

/** The finding of a broken link: its address as the page wrote it, and the status. */
export function brokenLinkProblem(href: string, status: number, uid: string | null): Finding {
  return { rule: 'link-broken', severity: 'warning', area: 'SEO', uid, message: t('Link a una pagina che non esiste ({0}): {1}. Correggi l’indirizzo o togli il link.', status, href.slice(0, 120)) };
}
