import { XbSyntaxError } from './errors.ts';
import { GROUP_BY_FIELD_PATTERN, GROUP_BY_HOW_PATTERN } from './names.ts';

/**
 * Expression language — docs/spec/dsl.md §4.
 * Deliberately small: no arithmetic, no assignment, no free function calls. Conditionals `a ? b : c` are allowed.
 * Behaviour is added through modifiers (`value.upper()`), resolved from a registry at render time.
 */

export type BinaryOp = '??' | '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=';

interface Span {
  start: number;
  end: number;
}

export type Expr =
  | ({ type: 'Literal'; value: string | number | boolean | null } & Span)
  | ({ type: 'Identifier'; name: string } & Span)
  | ({ type: 'Member'; object: Expr; property: string } & Span)
  | ({ type: 'Index'; object: Expr; index: Expr } & Span)
  | ({ type: 'Call'; callee: Expr; args: Arg[] } & Span)
  | ({ type: 'Unary'; op: '!'; argument: Expr } & Span)
  | ({ type: 'Binary'; op: BinaryOp; left: Expr; right: Expr } & Span)
  | ({ type: 'Conditional'; test: Expr; consequent: Expr; alternate: Expr } & Span)
  | ({ type: 'Array'; elements: Expr[] } & Span)
  | ({ type: 'Object'; properties: { key: string; value: Expr }[] } & Span);

export interface Arg extends Span {
  name?: string;
  value: Expr;
}

export interface ParseExpressionOptions {
  /**
   * Allow `name(key: value, …)` as the whole expression (loop presets only), or followed by one
   * `.groupBy("field", "how"?)` with literal strings (doc 23 of Publish, item 187).
   */
  allowPresetCall?: boolean;
}

/**
 * A loop source's preset call and the `.groupBy(…)` after it, when there is one: `foto(limit: 3).groupBy("anno")`.
 * Null for any other expression. The parser with `allowPresetCall` already refused every other shape.
 */
export function presetCallOf(expr: Expr): { call: Extract<Expr, { type: 'Call' }>; id: string; groupBy?: { field: string; how?: string } } | null {
  if (expr.type !== 'Call') return null;
  if (expr.callee.type === 'Identifier') return { call: expr, id: expr.callee.name };
  const { callee } = expr;
  if (callee.type !== 'Member' || callee.property !== 'groupBy' || callee.object.type !== 'Call' || callee.object.callee.type !== 'Identifier') return null;
  const [field, how] = expr.args.map((arg) => (arg.value.type === 'Literal' && typeof arg.value.value === 'string' ? arg.value.value : null));
  if (typeof field !== 'string' || (how !== undefined && typeof how !== 'string')) return null;
  return { call: callee.object, id: callee.object.callee.name, groupBy: how === undefined ? { field } : { field, how } };
}

const GROUP_BY_SYNTAX = 'groupBy dopo una query vuole il campo e, se serve, il modo, come testi scritti: .groupBy("anno") oppure .groupBy("date", "Y")';

type TokenType = 'num' | 'str' | 'ident' | 'punct' | 'eof';

interface Token extends Span {
  t: TokenType;
  v: string;
  value?: string | number;
}

const PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
};

const TWO_CHAR = new Set(['??', '||', '&&', '==', '!=', '<=', '>=']);
const ONE_CHAR = new Set(['!', '<', '>', '.', ',', ':', '?', '(', ')', '[', ']', '{', '}', '-']);
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

function tokenize(src: string, start: number, end: number): Token[] {
  const out: Token[] = [];
  let i = start;
  while (i < end) {
    const c = src.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(?:\.\d+)?/.exec(src.slice(i, end));
      const text = m ? m[0] : c;
      out.push({ t: 'num', v: text, value: Number(text), start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= end) throw new XbSyntaxError('Stringa non chiusa', src, i);
        const d = src.charAt(j);
        if (d === c) break;
        if (d === '\\') {
          const e = src.charAt(j + 1);
          value += ESCAPES[e] ?? e;
          j += 2;
          continue;
        }
        value += d;
        j++;
      }
      out.push({ t: 'str', v: src.slice(i, j + 1), value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i, end));
      const text = m ? m[0] : c;
      out.push({ t: 'ident', v: text, start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==') {
      throw new XbSyntaxError(`Operatore "${three}" non supportato: "==" e "!=" sono già stretti`, src, i);
    }
    const two = src.slice(i, i + 2);
    if (i + 2 <= end && TWO_CHAR.has(two)) {
      out.push({ t: 'punct', v: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(c)) {
      out.push({ t: 'punct', v: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new XbSyntaxError(`Carattere inatteso "${c}" nell'espressione`, src, i);
  }
  out.push({ t: 'eof', v: '', start: end, end });
  return out;
}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 1000;

class ExprParser {
  private i = 0;
  private depth = 0;
  private readonly presetCalls: Expr[] = [];

  constructor(
    private readonly src: string,
    private readonly toks: Token[],
    private readonly opts: ParseExpressionOptions,
  ) {}

  parse(): Expr {
    const first = this.peek();
    if (first.t === 'eof') throw new XbSyntaxError('Espressione vuota', this.src, first.start);
    const root = this.parseConditional();
    const rest = this.peek();
    if (rest.t !== 'eof') throw new XbSyntaxError(`Token inatteso "${rest.v}"`, this.src, rest.start);
    const call = this.presetCalls[0];
    if (call && (this.presetCalls.length > 1 || (root !== call && !this.isPresetGroupBy(root, call)))) {
      throw new XbSyntaxError(
        "Un preset di loop deve essere l'intera sorgente del loop: dopo la query è ammesso solo .groupBy(\"campo\") o .groupBy(\"campo\", \"modo\")",
        this.src,
        call.start,
      );
    }
    return root;
  }

  /** `preset(…).groupBy("field", "how"?)` (item 187): one groupBy right after the call, with literal strings. */
  private isPresetGroupBy(root: Expr, call: Expr): boolean {
    if (root.type !== 'Call' || root.callee.type !== 'Member' || root.callee.object !== call || root.callee.property !== 'groupBy') return false;
    const values = root.args.map((arg) => (arg.value.type === 'Literal' && typeof arg.value.value === 'string' ? arg.value.value : null));
    const [field, how] = values;
    if (values.length < 1 || values.length > 2 || typeof field !== 'string' || (values.length === 2 && typeof how !== 'string')) {
      throw new XbSyntaxError(GROUP_BY_SYNTAX, this.src, root.callee.start);
    }
    if (!GROUP_BY_FIELD_PATTERN.test(field)) throw new XbSyntaxError(`Campo di groupBy non valido "${field.slice(0, 80)}": un nome o un percorso con punti (fields.anno)`, this.src, root.callee.start);
    if (typeof how === 'string' && !GROUP_BY_HOW_PATTERN.test(how)) throw new XbSyntaxError('Modo di groupBy non valido: "letter" o un formato di data ("Y", "F Y"), al massimo 32 caratteri', this.src, root.callee.start);
    return true;
  }

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (t.t !== 'eof') this.i++;
    return t;
  }

  private isPunct(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.t === 'punct' && t.v === v;
  }

  private expect(v: string): Token {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) {
      throw new XbSyntaxError(`Atteso "${v}", trovato "${t.v || 'fine'}"`, this.src, t.start);
    }
    return t;
  }

  /** `test ? a : b` — lowest precedence, right-associative. */
  private parseConditional(): Expr {
    if (++this.depth > MAX_DEPTH) throw new XbSyntaxError('Espressione troppo annidata', this.src, this.peek().start);
    try {
      return this.parseConditionalInner();
    } finally {
      this.depth--;
    }
  }

  private parseConditionalInner(): Expr {
    const test = this.parseBinary(1);
    if (!this.isPunct('?')) return test;
    this.next();
    const consequent = this.parseConditional();
    this.expect(':');
    const alternate = this.parseConditional();
    return { type: 'Conditional', test, consequent, alternate, start: test.start, end: alternate.end };
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prec = t.t === 'punct' ? PRECEDENCE[t.v] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { type: 'Binary', op: t.v as BinaryOp, left, right, start: left.start, end: right.end };
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.t === 'punct' && t.v === '!') {
      if (++this.depth > MAX_DEPTH) throw new XbSyntaxError('Espressione troppo annidata', this.src, t.start);
      this.next();
      try {
        const argument = this.parseUnary();
        return { type: 'Unary', op: '!', argument, start: t.start, end: argument.end };
      } finally {
        this.depth--;
      }
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.t) {
      case 'num':
        return { type: 'Literal', value: t.value as number, start: t.start, end: t.end };
      case 'str':
        return { type: 'Literal', value: t.value as string, start: t.start, end: t.end };
      case 'ident':
        if (t.v === 'true' || t.v === 'false') {
          return { type: 'Literal', value: t.v === 'true', start: t.start, end: t.end };
        }
        if (t.v === 'null') return { type: 'Literal', value: null, start: t.start, end: t.end };
        return { type: 'Identifier', name: t.v, start: t.start, end: t.end };
      case 'punct':
        return this.parsePunctPrimary(t);
      default:
        throw new XbSyntaxError('Espressione incompleta', this.src, t.start);
    }
  }

  private parsePunctPrimary(t: Token): Expr {
    if (t.v === '-') {
      const n = this.next();
      if (n.t !== 'num') throw new XbSyntaxError('"-" è ammesso solo davanti a un numero', this.src, t.start);
      return { type: 'Literal', value: -(n.value as number), start: t.start, end: n.end };
    }
    if (t.v === '(') {
      const inner = this.parseConditional();
      this.expect(')');
      return inner;
    }
    if (t.v === '[') {
      const elements: Expr[] = [];
      while (!this.isPunct(']')) {
        if (elements.length >= MAX_ELEMENTS) throw new XbSyntaxError('Troppi elementi nella lista', this.src, t.start);
        elements.push(this.parseConditional());
        if (!this.isPunct(']')) this.expect(',');
      }
      const close = this.expect(']');
      return { type: 'Array', elements, start: t.start, end: close.end };
    }
    if (t.v === '{') {
      const properties: { key: string; value: Expr }[] = [];
      while (!this.isPunct('}')) {
        const k = this.next();
        if (k.t !== 'ident' && k.t !== 'str') {
          throw new XbSyntaxError('Chiave di oggetto non valida', this.src, k.start);
        }
        this.expect(':');
        properties.push({ key: k.t === 'str' ? (k.value as string) : k.v, value: this.parseConditional() });
        if (!this.isPunct('}')) this.expect(',');
      }
      const close = this.expect('}');
      return { type: 'Object', properties, start: t.start, end: close.end };
    }
    throw new XbSyntaxError(`Token inatteso "${t.v}"`, this.src, t.start);
  }

  private parsePostfix(expr: Expr): Expr {
    let e = expr;
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const name = this.next();
        if (name.t !== 'ident') throw new XbSyntaxError('Atteso un nome dopo "."', this.src, name.start);
        e = { type: 'Member', object: e, property: name.v, start: e.start, end: name.end };
        if (this.isPunct('(')) {
          const { args, end } = this.parseArgs(false);
          e = { type: 'Call', callee: e, args, start: e.start, end };
        }
        continue;
      }
      if (this.isPunct('[')) {
        this.next();
        const index = this.parseConditional();
        const close = this.expect(']');
        e = { type: 'Index', object: e, index, start: e.start, end: close.end };
        continue;
      }
      if (this.isPunct('(')) {
        if (e.type !== 'Identifier' || !this.opts.allowPresetCall) {
          throw new XbSyntaxError(
            'Chiamata a funzione non consentita: usa un modificatore (es. valore.upper())',
            this.src,
            this.peek().start,
          );
        }
        const { args, end } = this.parseArgs(true);
        e = { type: 'Call', callee: e, args, start: e.start, end };
        this.presetCalls.push(e);
        continue;
      }
      return e;
    }
  }

  private parseArgs(named: boolean): { args: Arg[]; end: number } {
    this.expect('(');
    const args: Arg[] = [];
    const seen = new Set<string>();
    while (!this.isPunct(')')) {
      const start = this.peek().start;
      const isNamed = this.peek().t === 'ident' && this.isPunct(':', 1);
      if (isNamed !== named) {
        throw new XbSyntaxError(
          named
            ? 'Gli argomenti di un preset devono essere nominati (es. limit: 3)'
            : 'I modificatori accettano solo argomenti posizionali',
          this.src,
          start,
        );
      }
      let name: string | undefined;
      if (isNamed) {
        name = this.next().v;
        this.next();
        if (seen.has(name)) throw new XbSyntaxError(`Argomento "${name}" duplicato`, this.src, start);
        seen.add(name);
      }
      const value = this.parseConditional();
      args.push(name === undefined ? { value, start, end: value.end } : { name, value, start, end: value.end });
      if (!this.isPunct(')')) this.expect(',');
    }
    return { args, end: this.expect(')').end };
  }
}

/** Parses `source.slice(start, end)`; positions in the AST and in errors are absolute offsets in `source`. */
export function parseExpression(
  source: string,
  start = 0,
  end = source.length,
  opts: ParseExpressionOptions = {},
): Expr {
  return new ExprParser(source, tokenize(source, start, end), opts).parse();
}

/**
 * Given the index of a `{`, returns the index of its matching `}`.
 * String literals inside are skipped, so `{a ?? "}"}` works.
 */
export function findClosingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source.charAt(i);
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source.charAt(i) !== c) {
        if (source.charAt(i) === '\\') i++;
        i++;
      }
      if (i >= source.length) break;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new XbSyntaxError('Parentesi graffa "{" non chiusa', source, open);
}
