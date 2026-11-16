/**
 * Style entry → CSS — docs/spec/styles.md. TypeScript twin of plugin/src/Styles/CssCompiler.php,
 * used for live preview in the builder; both are checked against packages/spec/vectors/css.json.
 */

export function compileCss(selector: string, body: string): string {
  const sel = selector.trim();
  let own = '';
  let hoisted = '';
  for (const [prelude, block] of statements(body)) {
    if (block === null) {
      own += prelude + ';';
      continue;
    }
    if (isBem(prelude)) {
      hoisted += compileCss(joinBem(sel, prelude), block);
    } else if (isGroup(prelude)) {
      const [inside, lifted] = group(sel, prelude, block);
      own += inside;
      hoisted += lifted;
    } else {
      own += prelude + '{' + block + '}';
    }
  }
  return sanitizeCss((own === '' ? '' : sel + '{' + own + '}') + hoisted);
}

/** `&__part` / `&--variant` (every selector of the list): a sibling rule with the concatenated name. */
function isBem(prelude: string): boolean {
  const nested = splitList(prelude);
  return nested.length > 0 && nested.every((part) => /^&(?:__|--)/.test(part));
}

/** `.a, .b` + `&__x` → `.a__x,.b__x`. */
function joinBem(selector: string, prelude: string): string {
  const joined: string[] = [];
  for (const parent of splitList(selector)) {
    for (const part of splitList(prelude)) joined.push(parent + part.slice(1));
  }
  return joined.join(',');
}

/** Conditional group rules that may sit inside a style rule. */
function isGroup(prelude: string): boolean {
  return /^@(?:media|container|supports|layer)\b/i.test(prelude);
}

/**
 * A nested `@media` (or `@container`, `@supports`, `@layer`): what stays nested, as written, and the BEM parts
 * inside it, lifted as `@media …{.card__title{…}}`. Only those parts move, so the cascade is unchanged.
 */
function group(selector: string, prelude: string, block: string): [string, string] {
  let keep = '';
  let lift = '';
  for (const [inner, body] of statements(block)) {
    if (body === null) keep += inner + ';';
    else if (isBem(inner)) lift += compileCss(joinBem(selector, inner), body);
    else if (isGroup(inner)) {
      const [k, l] = group(selector, inner, body);
      keep += k;
      lift += l;
    } else keep += inner + '{' + body + '}';
  }
  if (lift === '') return [prelude + '{' + block + '}', ''];
  return [keep === '' ? '' : prelude + '{' + keep + '}', prelude + '{' + lift + '}'];
}

/**
 * Named media and container queries (docs/spec/styles.md §6): `@media (--tablet)` → `@media (width < 64em)`, in the
 * prelude of a real @media or @container rule only; an unknown name stays as written. Twin of
 * plugin/src/Styles/NamedQueries.php::resolve(), both checked against vectors/css.json `namedQueries`.
 *
 * The substitution comes after the styles were filtered on the server, so it must never put together what the filter
 * did not see (`content:"@media" ur(--x)` printed a url(), threat model T31). Three guards, each enough on its own:
 * the sheet is read as the CSS tokenizer reads it, and only an at-rule where a statement starts counts; its prelude
 * holds no string, comment, escape or `url(`; `(--name)` stands alone, so no name is put together across it.
 */
export function resolveNamedQueries(css: string, queries: Record<string, string>): string {
  if (!css.includes('(--')) return css;
  let out = '';
  let copied = 0;
  let stack = ''; // The brackets left open.
  let round = 0; // How many of them are `(` or `[`: inside those nothing is a statement.
  let start = true; // A statement can start here.
  let atRule = false; // At the top level, the statement under way started with an at-keyword: a `;` ends it.
  const keyword = /@(?:media|container)(?![a-zA-Z0-9_\\-]|[^\x00-\x7F])/iy;
  for (let i = 0; i < css.length; ) {
    const c = css.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (c === '@' && start && round === 0) {
      atRule = stack === '';
      start = false;
      keyword.lastIndex = i;
      const m = keyword.exec(css);
      if (m === null) {
        i++;
        continue;
      }
      const from = i + m[0].length;
      // The prelude ends at the first `{` or `;`, and at the `}` that closes the block it is written in.
      const prelude = /^[^{};]*/.exec(css.slice(from))?.[0] ?? '';
      i = from;
      if (from < copied || prelude === '' || /["'\\]|\/\*|url\(/i.test(prelude)) continue;
      out += css.slice(copied, from) + substituteQueries(prelude, queries);
      copied = from + prelude.length;
      continue;
    }
    if (c === '"' || c === "'") {
      // A string ends at its quote, at a new line (left there) or where the sheet ends.
      for (i++; i < css.length && css.charAt(i) !== c && !'\n\r\f'.includes(css.charAt(i)); i++) {
        if (css.charAt(i) === '\\') i++;
      }
      if (i < css.length && css.charAt(i) === c) i++;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '(' || c === '[' || c === '{') {
      stack += c;
      i++;
      if (c === '{') {
        start = round === 0;
        continue;
      }
      round++;
    } else if (c === ')' || c === ']' || c === '}') {
      i++;
      // Only the bracket that matches closes: any other is a character like the rest.
      if (stack !== '' && stack.charAt(stack.length - 1) === (c === ')' ? '(' : c === ']' ? '[' : '{')) {
        stack = stack.slice(0, -1);
        if (c === '}') {
          start = round === 0;
          atRule = false;
          continue;
        }
        round--;
      }
    } else if (c === ';') {
      i++;
      // Inside a block a `;` ends a declaration; at the top level it ends only an at-rule (`@layer a;`).
      if (round === 0 && (stack !== '' || atRule)) {
        start = true;
        atRule = false;
        continue;
      }
    } else {
      i++;
    }
    start = false;
  }
  return out === '' ? css : out + css.slice(copied);
}

/** A condition that can be written into a sheet: twin of NamedQueries::condition(). */
function isCondition(query: unknown): query is string {
  if (typeof query !== 'string' || query === '' || query.length > 200) return false;
  if (!/^[a-zA-Z0-9 ().,:<>=/%+*-]+$/.test(query) || /url\s*\(|image-set|src\s*\(|expression|\/\/|\/\*|\*\/|<\s*\/|<!/i.test(query)) return false;
  let depth = 0;
  for (const c of query) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** The `(--name)` of a prelude replaced with their conditions, each only where it stands alone. */
function substituteQueries(prelude: string, queries: Record<string, string>): string {
  const isName = (c: string): boolean => c !== '' && (/[a-zA-Z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80);
  return prelude.replace(/\(--([a-z][a-z0-9-]{0,30})\)/g, (whole: string, name: string, at: number) => {
    const query = Object.prototype.hasOwnProperty.call(queries, name) ? queries[name] : undefined;
    const after = prelude.charAt(at + whole.length);
    if (!isCondition(query) || (at > 0 && isName(prelude.charAt(at - 1))) || isName(after) || after === '(') return whole;
    // `@media(--tablet)`: a space, so the condition never continues the at-keyword.
    return (at === 0 ? ' ' : '') + query;
  });
}

/**
 * Prevents breaking out of the surrounding <style> element: only `</` can end it (raw text), so only that is
 * escaped. A bare `<` stays, as range media queries need it: `@media (width < 48em)`.
 */
export function sanitizeCss(css: string): string {
  return css.replace(/<\//g, '\\3C /');
}

/** The class that decides whether a style entry is needed on a page (first class of the selector). */
export function keyClass(selector: string): string | null {
  return /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/.exec(selector)?.[1] ?? null;
}

export function statements(body: string): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  let buffer = '';
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === '/' && body.charAt(i + 1) === '*') {
      const end = body.indexOf('*/', i + 2);
      i = end < 0 ? body.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(body, i);
      buffer += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === ';') {
      if (buffer.trim() !== '') out.push([buffer.trim(), null]);
      buffer = '';
      continue;
    }
    if (c === '{') {
      const close = blockEnd(body, i);
      out.push([buffer.trim(), body.slice(i + 1, close)]);
      buffer = '';
      i = close;
      continue;
    }
    buffer += c;
  }
  if (buffer.trim() !== '') out.push([buffer.trim(), null]);
  return out;
}

export function splitList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buffer = '';
  for (const c of selector) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += c;
  }
  parts.push(buffer.trim());
  return parts.filter((p) => p !== '');
}

function stringEnd(text: string, open: number): number {
  const quote = text.charAt(open);
  for (let i = open + 1; i < text.length; i++) {
    if (text.charAt(i) === '\\') i++;
    else if (text.charAt(i) === quote) return i;
  }
  return text.length - 1;
}

function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"' || c === "'") i = stringEnd(text, i);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return text.length;
}
