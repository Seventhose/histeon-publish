// The canvas at any width (docs/spec/styles.md §8): no fixed devices, the page is drawn at the width
// you drag it to, and a media or container query can start from exactly that width. Pure, tested in
// test/canvasWidth.test.ts.

export const MIN_WIDTH = 240;
export const MAX_WIDTH = 3840;

export function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number.isFinite(width) ? width : MIN_WIDTH)));
}

const ROOT_PX = 16;

/** `40em`, `64rem`, `1024px` → px (em and rem at the browser default of 16px); null otherwise. */
function toPx(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(px|em|rem)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === 'px' ? n : n * ROOT_PX);
}

/**
 * Where the site's named queries switch, as widths for the ruler over the canvas: `(width < 40em)` → 640,
 * `(min-width: 1024px)` → 1024. Conditions that are not a single width (orientation, ranges) are left out.
 */
export function breakpointsFrom(queries: Record<string, string>): Array<{ name: string; px: number }> {
  const out: Array<{ name: string; px: number }> = [];
  for (const [name, query] of Object.entries(queries)) {
    const range = /^\(\s*width\s*(?:<|<=|>|>=)\s*([\d.]+(?:px|em|rem))\s*\)$/.exec(query.trim());
    const classic = /^\(\s*(?:min|max)-width\s*:\s*([\d.]+(?:px|em|rem))\s*\)$/.exec(query.trim());
    const px = toPx((range ?? classic)?.[1] ?? '');
    if (px !== null && px >= MIN_WIDTH && px <= MAX_WIDTH) out.push({ name, px });
  }
  return out.sort((a, b) => a.px - b.px || a.name.localeCompare(b.name));
}

/** The condition for "up to this width" or "from this width up", in the range syntax XB writes elsewhere. */
export function conditionAt(width: number, direction: 'down' | 'up'): string {
  return `(width ${direction === 'down' ? '<=' : '>='} ${clampWidth(width)}px)`;
}

/**
 * Adds an empty `@media …` / `@container …` block at the end of a rule body, ready to type in; an identical
 * block already there is reused (nothing is added twice).
 */
export function appendQueryBlock(css: string, prelude: string): string {
  const escaped = prelude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  if (new RegExp(`${escaped}\\s*\\{`).test(css)) return css;
  const body = css.replace(/\s+$/, '');
  return `${body}${body ? '\n' : ''}${prelude} {\n  \n}\n`;
}

/** Whether a width condition holds at `width` px: `(width < 40em)`, `(min-width: 768px)`…; null if not one width. */
export function holdsAt(query: string, width: number): { holds: boolean; bound: number; upper: boolean } | null {
  const q = query.trim();
  const range = /^\(\s*width\s*(<|<=|>|>=)\s*([\d.]+(?:px|em|rem))\s*\)$/.exec(q);
  const classic = /^\(\s*(min|max)-width\s*:\s*([\d.]+(?:px|em|rem))\s*\)$/.exec(q);
  const op = range ? range[1]! : classic ? (classic[1] === 'max' ? '<=' : '>=') : null;
  const px = toPx((range ?? classic)?.[2] ?? '');
  if (op === null || px === null) return null;
  const holds = op === '<' ? width < px : op === '<=' ? width <= px : op === '>' ? width > px : width >= px;
  return { holds, bound: px, upper: op.startsWith('<') };
}

/**
 * Where an edit goes when the canvas shows `width` px (docs/spec/styles.md §10): the site's named query that holds
 * there, the narrowest of the «up to» ones (or else the widest of the «from» ones); without one, the canvas width
 * itself (`@media (width <= 768px)`).
 */
export function widthPrelude(queries: Record<string, string>, width: number): string {
  let best: { name: string; bound: number; upper: boolean } | null = null;
  for (const [name, query] of Object.entries(queries)) {
    const at = holdsAt(query, width);
    if (!at?.holds) continue;
    const better = !best || (at.upper && !best.upper) || (at.upper === best.upper && (at.upper ? at.bound < best.bound : at.bound > best.bound));
    if (better) best = { name, bound: at.bound, upper: at.upper };
  }
  return best ? `@media (--${best.name})` : `@media ${conditionAt(width, 'down')}`;
}
