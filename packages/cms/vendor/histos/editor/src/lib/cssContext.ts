// Where the mini GUI writes (docs/spec/styles.md §10): a selector's own CSS, or a block nested in it — a state
// (`&:hover`), a width (`@media (--tablet)`), or both (`@media (--tablet) { &:hover {…} }`). The blocks are found
// in the text as written and edited in place: comments and formatting elsewhere stay as they are.
// Pure, tested in test/cssContext.test.ts.
import { statements } from '@xb/dsl';

export const STATES: Array<{ prelude: string; label: string }> = [
  { prelude: '&:hover', label: ':hover' },
  { prelude: '&:focus-visible', label: ':focus-visible' },
  { prelude: '&:active', label: ':active' },
  { prelude: '&::before', label: '::before' },
  { prelude: '&::after', label: '::after' },
];

const norm = (prelude: string) => prelude.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([(),:])\s*/g, '$1').trim().toLowerCase();

interface Found {
  /** Start of the prelude. */
  start: number;
  /** The `{` and the matching `}`. */
  open: number;
  close: number;
}

/** A top-level block of `css` whose prelude is `prelude` (spacing and case aside). */
function find(css: string, prelude: string): Found | null {
  const want = norm(prelude);
  let depth = 0;
  let from = 0;
  let open = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css.charAt(i);
    if (c === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css.charAt(j) !== c) j += css.charAt(j) === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && open >= 0) {
        if (norm(css.slice(from, open)) === want) return { start: from, open, close: i };
        from = i + 1;
        open = -1;
      }
      if (depth < 0) return null;
    } else if (c === ';' && depth === 0) {
      from = i + 1;
    }
  }
  return null;
}

/** The body of the block at `path` (outermost first), '' when it is not written. */
export function bodyAt(css: string, path: string[]): string {
  let body = css;
  for (const prelude of path) {
    const f = find(body, prelude);
    if (!f) return '';
    body = body.slice(f.open + 1, f.close);
  }
  return body;
}

/** Where the body of the block at `path` sits in `css`, for the editor to show it; null when not written. */
export function rangeOf(css: string, path: string[]): { from: number; to: number } | null {
  let offset = 0;
  let body = css;
  for (const prelude of path) {
    const f = find(body, prelude);
    if (!f) return null;
    offset += f.open + 1;
    body = body.slice(f.open + 1, f.close);
  }
  return { from: offset, to: offset + body.length };
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join('\n');

/**
 * `css` with the block at `path` holding `body`: created at the end when missing, removed when it ends up
 * empty. Everything else is left as written.
 */
export function setBodyAt(css: string, path: string[], body: string): string {
  if (path.length === 0) return body;
  const [prelude, ...rest] = path as [string, ...string[]];
  const f = find(css, prelude);
  const inner = setBodyAt(f ? css.slice(f.open + 1, f.close) : '', rest, body);
  const empty = inner.trim() === '';
  if (!f) {
    if (empty) return css;
    const head = css.replace(/\s+$/, '');
    return `${head}${head ? '\n' : ''}${prelude} {\n${indent(inner.trim())}\n}\n`;
  }
  if (empty) {
    const after = css.slice(f.close + 1).replace(/^[ \t]*\n/, '');
    return css.slice(0, f.start).replace(/[ \t]+$/, '') + after;
  }
  const formatted = rest.length === 0 ? `\n${indent(inner.trim())}\n` : inner;
  return css.slice(0, f.open + 1) + formatted + css.slice(f.close);
}

/** The width blocks offered: the site's named queries, then the width the canvas shows. */
export function widthPreludes(queries: Record<string, string>, layoutWidth: number, conditionAt: (w: number, d: 'down' | 'up') => string, css = ''): Array<{ prelude: string; label: string }> {
  const out = [
    ...Object.keys(queries).map((name) => ({ prelude: `@media (--${name})`, label: name })),
    { prelude: `@media ${conditionAt(layoutWidth, 'down')}`, label: `≤ ${layoutWidth}px` },
  ];
  // The @media and @container blocks already written in the selector's CSS, by hand too (C3): the mini GUI
  // reads and writes inside them like inside the ones it offers.
  for (const [prelude, body] of statements(css)) {
    const clean = prelude.replace(/\s+/g, ' ').trim();
    if (body !== null && /^@(media|container)\b/i.test(clean) && !out.some((w) => w.prelude === clean)) out.push({ prelude: clean, label: clean.replace(/^@media /i, '') });
  }
  return out;
}
