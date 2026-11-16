// Lint of a style entry's CSS (docs/spec/styles.md, «Controllo del CSS»): the same checks for the CSS panel, the
// Checks panel and the agent's tools, so people and agents get the same answers. It reads the text as written
// (declarations, nested rules, at-rules) and never changes it.

export interface CssLintContext {
  /** Custom properties the site defines (framework, tokens, global sheets), with their values when known. */
  variables?: ReadonlyArray<{ name: string; value?: string | undefined }>;
  /** Named media queries, `--tablet` → condition (docs/spec/styles.md §6). */
  queries?: Readonly<Record<string, string>>;
}

export type CssLintCode = 'brace-open' | 'brace-close' | 'unknown-query' | 'unknown-variable' | 'important' | 'empty-value' | 'token-value' | 'not-bem';

export interface CssLintIssue {
  /** Offsets in the CSS text; [0, 0) for the selector itself. */
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  code: CssLintCode;
  /** Names and values the message mentions, in order. */
  args: string[];
  /** The message in Italian; interfaces in other languages build theirs from `code` and `args`. */
  message: string;
}

const SEVERITY: Record<CssLintCode, CssLintIssue['severity']> = {
  'brace-open': 'error',
  'brace-close': 'error',
  'unknown-query': 'warning',
  'unknown-variable': 'warning',
  important: 'warning',
  'empty-value': 'warning',
  'token-value': 'info',
  'not-bem': 'info',
};

/** Messages by code; `{0}`, `{1}` are the args. */
export const CSS_LINT_MESSAGES: Record<CssLintCode, string> = {
  'brace-open': 'Graffa aperta e mai chiusa: la regola non si chiude',
  'brace-close': 'Graffa chiusa senza una aperta',
  'unknown-query': 'Media query con nome sconosciuta: {0}. Il browser la ignora',
  'unknown-variable': 'Variabile sconosciuta: {0}. Non è nel framework, nei token né nei fogli del sito',
  important: '!important: meglio un selettore più preciso',
  'empty-value': 'Dichiarazione senza valore: {0}',
  'token-value': '{0} è il valore di {1}: usa var({1})',
  'not-bem': 'Classe fuori dallo schema BEM (blocco__elemento--modificatore): {0}',
};

/** blocco, blocco__elemento, blocco--modificatore, blocco__elemento--modificatore; words joined by `-`. */
const BEM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
/** Values worth a token: lengths other than zero, and colours. */
const TOKENISH = /^(?:-?(?:\d*\.)?\d+(?:px|rem|em)|#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^)]*\))$/i;

/** Custom properties a stylesheet defines (`--name:`), for the lint context. */
export function definedVariables(css: string): string[] {
  return [...new Set([...stripComments(css).matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map((m) => m[1] as string))];
}

/** The problems of `css`, the body of the style entry for `selector`, in text order. */
export function cssLint(selector: string, css: string, context: CssLintContext = {}): CssLintIssue[] {
  const issues: CssLintIssue[] = [];
  const add = (from: number, to: number, code: CssLintCode, ...args: string[]) =>
    issues.push({ from, to, severity: SEVERITY[code], code, args, message: fill(CSS_LINT_MESSAGES[code], args) });

  const known = context.variables && context.variables.length > 0 ? new Set([...context.variables.map((v) => v.name), ...definedVariables(css)]) : null;
  const tokenOf = new Map<string, string>();
  for (const v of context.variables ?? []) {
    const value = v.value ? normalize(v.value) : '';
    if (value && TOKENISH.test(value) && !tokenOf.has(value)) tokenOf.set(value, v.name);
  }

  for (const cls of classesOf(selector)) if (!BEM.test(cls)) add(0, 0, 'not-bem', cls);

  const declaration = (text: string, at: number) => {
    const lead = text.length - text.trimStart().length;
    const body = text.trim();
    if (body === '') return;
    const colon = topLevelIndex(body, ':');
    if (colon < 0) return;
    const prop = body.slice(0, colon).trim();
    const start = at + lead;
    const valueStart = start + colon + 1;
    // Strings blanked out, same length: text in `content: "…"` is not CSS.
    const value = maskStrings(body.slice(colon + 1));
    if (value.trim() === '') {
      add(start, start + body.length, 'empty-value', prop);
      return;
    }
    const important = /!\s*important\s*$/i.exec(value);
    if (important) add(valueStart + important.index, valueStart + important.index + important[0].length, 'important');
    if (prop.startsWith('--')) return;
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = m[1] as string;
      if (known && !known.has(name) && !name.startsWith('--wp--')) {
        const from = valueStart + (m.index ?? 0) + m[0].indexOf(name);
        add(from, from + name.length, 'unknown-variable', name);
      }
    }
    if (tokenOf.size === 0) return;
    for (const [word, offset] of topLevelWords(important ? value.slice(0, important.index) : value)) {
      const name = tokenOf.get(normalize(word));
      if (name) add(valueStart + offset, valueStart + offset + word.length, 'token-value', word, name);
    }
  };

  const prelude = (text: string, at: number) => {
    const body = text.trim();
    const start = at + (text.length - text.trimStart().length);
    if (/^@(media|container)\b/i.test(body)) {
      for (const m of body.matchAll(/\(\s*(--[\w-]+)\s*\)/g)) {
        const name = m[1] as string;
        if (!(name in (context.queries ?? {}))) {
          const from = start + (m.index ?? 0) + m[0].indexOf(name);
          add(from, from + name.length, 'unknown-query', name);
        }
      }
      return;
    }
    if (body.startsWith('@')) return;
    for (const m of body.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      if (!BEM.test(m[1] as string)) add(start + (m.index ?? 0), start + (m.index ?? 0) + m[0].length, 'not-bem', m[1] as string);
    }
    // `&__part` and `&--mod` join the entry's class (styles.md §2).
    const own = classesOf(selector).at(-1);
    for (const m of body.matchAll(/&((?:__|--)[\w-]+)/g)) {
      const joined = own ? own + (m[1] as string) : null;
      if (joined && !BEM.test(joined)) add(start + (m.index ?? 0), start + (m.index ?? 0) + m[0].length, 'not-bem', joined);
    }
  };

  const opens: number[] = [];
  let start = 0;
  let parens = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css.charAt(i);
    if (c === '/' && css.charAt(i + 1) === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = stringEnd(css, i);
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens = Math.max(0, parens - 1);
    else if (c === ';' && parens === 0) {
      declaration(withoutComments(css, start, i), start);
      start = i + 1;
    } else if (c === '{') {
      prelude(withoutComments(css, start, i), start);
      opens.push(i);
      parens = 0;
      start = i + 1;
    } else if (c === '}') {
      declaration(withoutComments(css, start, i), start);
      if (opens.length === 0) add(i, i + 1, 'brace-close');
      else opens.pop();
      parens = 0;
      start = i + 1;
    }
  }
  declaration(withoutComments(css, start, css.length), start);
  for (const open of opens) add(open, open + 1, 'brace-open');
  return issues.sort((a, b) => a.from - b.from);
}

function fill(text: string, args: string[]): string {
  return text.replace(/\{(\d+)\}/g, (all, n: string) => args[Number(n)] ?? all);
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function classesOf(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] as string);
}

/** `text[from, to)` with comments blanked out, same length (offsets stay valid). */
function withoutComments(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/\/\*[\s\S]*?(\*\/|$)/g, (m) => ' '.repeat(m.length));
}

function maskStrings(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c !== '"' && c !== "'") {
      out += c;
      continue;
    }
    const end = stringEnd(text, i);
    out += c + ' '.repeat(Math.max(0, Math.min(end, text.length - 1) - i - 1)) + (end < text.length ? c : '');
    i = end;
  }
  return out;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
}

/** Index of `char` outside parentheses and strings, or -1. */
function topLevelIndex(text: string, char: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"' || c === "'") i = stringEnd(text, i);
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

/** Space-separated words of a value outside parentheses (a function call is one word), with their offsets. */
function topLevelWords(value: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  let depth = 0;
  let from = -1;
  for (let i = 0; i <= value.length; i++) {
    const c = value.charAt(i);
    const space = i === value.length || ((c === ' ' || c === ',' || c === '/' || c === '\n' || c === '\t') && depth === 0);
    if (!space && from < 0) from = i;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (space && from >= 0) {
      out.push([value.slice(from, i), from]);
      from = -1;
    }
  }
  return out;
}

function stringEnd(text: string, open: number): number {
  const quote = text.charAt(open);
  for (let i = open + 1; i < text.length; i++) {
    if (text.charAt(i) === '\\') i++;
    else if (text.charAt(i) === quote) return i;
  }
  return text.length;
}
