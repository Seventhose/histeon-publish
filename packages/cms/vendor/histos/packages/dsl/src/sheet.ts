// Where a class is styled inside a global sheet: the rules whose selector names it, with their offsets, so the
// CSS panel can show a class's rules in place (migrated sites keep almost all their CSS in one global sheet).

export interface SheetRule {
  /** Offset of the selector's first character and just past the closing brace. */
  from: number;
  to: number;
  /** At-rule preludes around it, outermost first (`@media (width > 600px)`). */
  within: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the selector list names `.name` as a class (not a prefix of a longer one). */
export function namesClass(selector: string, name: string): boolean {
  const plain = selector.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]/g, ' ');
  return new RegExp(`\\.${escapeRegExp(name)}(?![\\w-]|\\\\)`).test(plain);
}

/**
 * Rules of `css` whose selector names `.name`, in source order. Nested rules count through their outermost
 * style rule; @media, @supports, @container and @layer blocks are looked into. Comments and strings are skipped.
 */
export function rulesFor(css: string, name: string, limit = 200): SheetRule[] {
  return rulesWhere(css, (prelude) => namesClass(prelude, name), limit);
}

/** Like rulesFor, for any test on the rule's selector list. */
export function rulesWhere(css: string, test: (prelude: string) => boolean, limit = 200): SheetRule[] {
  const out: SheetRule[] = [];
  // Stack of open blocks: an at-rule (looked into) or a style rule (whose range we may record).
  const stack: Array<{ kind: 'at'; prelude: string } | { kind: 'rule'; from: number; match: boolean }> = [];
  let start = 0; // where the current prelude begins
  let i = 0;
  const skipSpace = (p: number) => {
    while (p < css.length && /\s/.test(css.charAt(p))) p++;
    return p;
  };
  while (i < css.length && out.length < limit) {
    const c = css.charAt(i);
    if (c === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      if (css.slice(start, i).trim().startsWith('/*')) start = i;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css.charAt(j) !== c) j += css.charAt(j) === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '{') {
      const from = skipSpace(start);
      const prelude = css.slice(from, i).trim();
      const inRule = stack.some((s) => s.kind === 'rule');
      if (prelude.startsWith('@') || inRule) stack.push(inRule ? { kind: 'rule', from, match: false } : { kind: 'at', prelude });
      else stack.push({ kind: 'rule', from, match: test(prelude) });
      start = i + 1;
    } else if (c === '}') {
      const open = stack.pop();
      if (open?.kind === 'rule' && open.match && !stack.some((s) => s.kind === 'rule')) {
        const within = stack.flatMap((s) => (s.kind === 'at' ? [s.prelude] : []));
        out.push({ from: open.from, to: i + 1, within });
      }
      start = i + 1;
    } else if (c === ';' && !stack.some((s) => s.kind === 'rule')) {
      start = i + 1;
    }
    i++;
  }
  return out;
}

/**
 * One declaration per line, two-space indents: how a rule reads in the CSS panel. Strings, comments and
 * `url(…;…)` are kept as written. Idempotent, so showing a formatted rule again changes nothing.
 */
export function prettyRule(css: string): string {
  let out = '';
  let depth = 0;
  let parens = 0;
  const newline = () => {
    out = out.trimEnd() + '\n' + '  '.repeat(Math.max(0, depth));
  };
  for (let i = 0; i < css.length; i++) {
    const c = css.charAt(i);
    if (c === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop - 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css.charAt(j) !== c) j += css.charAt(j) === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j;
    } else if (c === '(') {
      parens++;
      out += c;
    } else if (c === ')') {
      parens = Math.max(0, parens - 1);
      out += c;
    } else if (c === '{' && parens === 0) {
      out = out.trimEnd() + ' {';
      depth++;
      newline();
    } else if (c === ';' && parens === 0) {
      out += ';';
      newline();
    } else if (c === '}' && parens === 0) {
      depth--;
      out = out.trimEnd();
      out += '\n' + '  '.repeat(Math.max(0, depth)) + '}';
      newline();
    } else if (/\s/.test(c)) {
      if (out !== '' && !/\s$/.test(out)) out += ' ';
    } else {
      out += c;
    }
  }
  return out.trimEnd();
}

/** Whether the braces of a rule close where they open (outside strings and comments): safe to splice back. */
export function balanced(css: string): boolean {
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css.charAt(i);
    if (c === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css.charAt(j) !== c && css.charAt(j) !== '\n') j += css.charAt(j) === '\\' ? 2 : 1;
      if (css.charAt(j) !== c) return false;
      i = j;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}
