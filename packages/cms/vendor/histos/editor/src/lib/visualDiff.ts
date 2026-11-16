// Visual comparison before publishing (docs/spec/versioning.md §8): the page online and the same page in
// development, drawn side by side at a large and a small screen, with what changes marked. The same "signature" as
// dev/visual-diff/capture.py: every visible element with its text, box and main computed styles. The pure parts
// are tested in test/visualDiff.test.ts; the frames are sandboxed like the canvas (no scripts run).

import { t, tn } from './i18n.ts';

export interface Viewport {
  name: 'desktop' | 'mobile';
  label: string;
  width: number;
  height: number;
}

export const VIEWPORTS: Viewport[] = [
  { name: 'desktop', label: t('Schermo grande'), width: 1366, height: 900 },
  { name: 'mobile', label: t('Telefono'), width: 390, height: 844 },
];

export interface SigNode {
  /** Tag, class and own text: what identifies an element on both sides. */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Main computed styles, joined. */
  s: string;
}

export interface VisualResult {
  /** Elements only in the development version. */
  added: number[];
  /** Elements only online (indexes in the online signature). */
  removed: number[];
  /** Same element, other look (style) or other size. Indexes in the development signature. */
  changed: number[];
  /** Same element, only moved down or up by what changed above it. */
  moved: number;
  /** Nothing visible changes. */
  same: boolean;
}

/** Animations off and Histeon's own marks hidden, on both sides, before measuring. */
export const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}
#wpadminbar,[data-xb-preview-badge]{display:none!important}html{margin-top:0!important}`;

export const STYLE_PROPS = ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'margin-top', 'margin-bottom', 'padding-top', 'padding-left', 'gap', 'border-top-width', 'border-radius', 'text-align'];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
const SKIP_INSIDE = '#wpadminbar, [data-xb-preview-badge]';

/** Above this many cells (after the common start and end) the pages are too different to align. */
const MAX_CELLS = 4_000_000;
/** Box differences up to this many pixels are rounding. */
const TOLERANCE = 2;

/** The page's visible elements, in document order, and the elements themselves (to mark them). */
export function signature(doc: Document): { nodes: SigNode[]; elements: Element[] } {
  const win = doc.defaultView;
  const nodes: SigNode[] = [];
  const elements: Element[] = [];
  if (!win || !doc.body) return { nodes, elements };
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName) || el.closest(SKIP_INSIDE)) continue;
    const s = win.getComputedStyle(el);
    if (s.display === 'none') continue;
    const r = el.getBoundingClientRect();
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .join(' ')
      .slice(0, 80);
    nodes.push({
      key: `${el.tagName.toLowerCase()}|${(el.getAttribute('class') ?? '').trim()}|${text}`,
      x: Math.round(r.x),
      y: Math.round(r.y + win.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
      s: STYLE_PROPS.map((p) => s.getPropertyValue(p)).join('|'),
    });
    elements.push(el);
  }
  return { nodes, elements };
}

/** Pairs of equal keys, in order (longest common subsequence after the common start and end). */
export function align(a: string[], b: string[]): Array<[number, number]> | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) return null;
  if (n > 0 && m > 0) {
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = a[start + i] === b[start + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/**
 * What changes from `before` (online) to `after` (development). `contains(i, j)` says whether element i of
 * `after` contains element j: a box that only grew because something inside it changed is not marked itself.
 * Null when the pages are too different to align element by element.
 */
export function compare(before: SigNode[], after: SigNode[], contains: (outer: number, inner: number) => boolean = () => false): VisualResult | null {
  const pairs = align(
    before.map((n) => n.key),
    after.map((n) => n.key),
  );
  if (pairs === null) return null;
  const pairedA = new Set(pairs.map(([i]) => i));
  const pairedB = new Set(pairs.map(([, j]) => j));
  const removed = before.map((_, i) => i).filter((i) => !pairedA.has(i));
  const added = after.map((_, j) => j).filter((j) => !pairedB.has(j));
  const styled: number[] = [];
  const resized: number[] = [];
  let moved = 0;
  for (const [i, j] of pairs) {
    const x = before[i]!;
    const y = after[j]!;
    const off = (k: 'x' | 'y' | 'w' | 'h') => Math.abs(x[k] - y[k]) > TOLERANCE;
    if (x.s !== y.s) styled.push(j);
    else if (off('w') || off('h') || off('x')) resized.push(j);
    else if (off('y')) moved++;
  }
  const marked = [...added, ...styled];
  // A resized box is marked only when nothing marked or resized sits inside it: the change is its own.
  const own = resized.filter((j) => !marked.some((k) => contains(j, k)) && !resized.some((k) => k !== j && contains(j, k)));
  const changed = [...styled, ...own].sort((p, q) => p - q);
  return { added, removed, changed, moved, same: added.length + removed.length + changed.length === 0 };
}

/** One line for a result. */
export function describe(r: VisualResult | null): string {
  if (r === null) return t('Pagine troppo diverse per confrontarle elemento per elemento');
  if (r.same) return r.moved > 0 ? tn('Nessuna differenza visibile ({0} elemento spostato di poco)', 'Nessuna differenza visibile ({0} elementi spostati di poco)', r.moved, r.moved) : t('Nessuna differenza visibile');
  const parts: string[] = [];
  if (r.added.length) parts.push(tn('{0} elemento nuovo', '{0} elementi nuovi', r.added.length, r.added.length));
  if (r.removed.length) parts.push(tn('{0} tolto', '{0} tolti', r.removed.length, r.removed.length));
  if (r.changed.length) parts.push(tn("{0} cambiato nell'aspetto", "{0} cambiati nell'aspetto", r.changed.length, r.changed.length));
  if (r.moved) parts.push(tn('{0} spostato', '{0} spostati', r.moved, r.moved));
  return parts.join(', ');
}


/**
 * The «Aspetto» line of the page checks (V7.1): how many pages change at each screen. A page too different to align
 * (null) changes; a comparison that failed (a message) is counted apart, never as «no change».
 */
export function appearanceSummary(rows: Array<{ vp: Viewport['name']; result: VisualResult | null | string }>): { desktop: number; mobile: number; failed: number } {
  const out = { desktop: 0, mobile: 0, failed: 0 };
  for (const row of rows) {
    if (typeof row.result === 'string') out.failed++;
    else if (row.result === null || !row.result.same) out[row.vp]++;
  }
  return out;
}
