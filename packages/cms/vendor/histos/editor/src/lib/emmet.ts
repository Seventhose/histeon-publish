// Emmet-style abbreviations in the HTML panel (docs/spec/html-panel.md): `section.hero>h2.hero__title{Ciao}+p*2`
// then Tab. Our own small subset, no dependency: tags, .class, #id, [attr="v"], {text}, *N with $ numbering,
// > child, + sibling, ^ up, (groups). Pure, tested in test/emmet.test.ts.
import { HTML_ELEMENTS, VOID_ELEMENTS } from '@xb/dsl';

interface Node {
  tag: string;
  classes: string[];
  id: string | null;
  attrs: Array<[string, string | null]>;
  text: string | null;
  count: number;
  children: Node[];
  group: boolean;
}

const MAX = 200;
/** Inside these, an implicit tag is their usual child. */
const IMPLICIT: Record<string, string> = { ul: 'li', ol: 'li', table: 'tr', tbody: 'tr', thead: 'tr', tr: 'td', select: 'option', nav: 'a', dl: 'dt' };

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string {
    return this.s.charAt(this.i);
  }
  eat(c: string): boolean {
    if (this.s.charAt(this.i) !== c) return false;
    this.i++;
    return true;
  }
  name(numbered = false): string {
    const m = (numbered ? /^[a-zA-Z_$][\w$:-]*/ : /^[a-zA-Z][\w:-]*/).exec(this.s.slice(this.i));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }
  until(close: string): string {
    const end = this.s.indexOf(close, this.i);
    if (end < 0) throw new Error('unclosed');
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out;
  }
}

function element(r: Reader): Node {
  const node: Node = { tag: '', classes: [], id: null, attrs: [], text: null, count: 1, children: [], group: false };
  if (r.eat('(')) {
    node.group = true;
    node.children = list(r);
    if (!r.eat(')')) throw new Error('group');
  } else {
    node.tag = r.name();
    for (;;) {
      if (r.eat('.')) {
        const c = r.name(true);
        if (!c) throw new Error('class');
        node.classes.push(c);
      } else if (r.eat('#')) {
        const id = r.name(true);
        if (!id) throw new Error('id');
        node.id = id;
      } else if (r.eat('[')) {
        const body = r.until(']');
        for (const m of body.matchAll(/([a-zA-Z_:][\w:.-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g)) {
          node.attrs.push([m[1] as string, m[2] ?? m[3] ?? m[4] ?? null]);
        }
      } else if (r.eat('{')) {
        node.text = r.until('}');
      } else break;
    }
    if (!node.tag && !node.classes.length && !node.id && !node.attrs.length && node.text === null) throw new Error('empty');
  }
  if (r.eat('*')) {
    const m = /^\d+/.exec(r.s.slice(r.i));
    if (!m) throw new Error('count');
    r.i += m[0].length;
    node.count = Math.min(Number(m[0]), 50);
  }
  return node;
}

/** Siblings joined by +, each possibly with children after >; ^ climbs back up (handled by the caller). */
function list(r: Reader): Node[] {
  const roots: Node[] = [];
  const stack: Node[][] = [roots];
  let last: Node | null = null;
  for (;;) {
    const node = element(r);
    (stack.at(-1) as Node[]).push(node);
    last = node;
    const c = r.peek();
    if (c === '>') {
      r.i++;
      stack.push(last.children);
    } else if (c === '+') {
      r.i++;
    } else if (c === '^') {
      while (r.eat('^')) if (stack.length > 1) stack.pop();
    } else break;
  }
  return roots;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function render(nodes: Node[], parent: string, depth: number, out: string[], budget: { n: number }): void {
  for (const node of nodes) {
    for (let k = 1; k <= node.count; k++) {
      if (--budget.n < 0) throw new Error('too big');
      const num = (s: string) => s.replace(/\$+/g, (m) => String(k).padStart(m.length, '0'));
      if (node.group) {
        render(node.children, parent, depth, out, budget);
        continue;
      }
      const tag = node.tag || IMPLICIT[parent] || 'div';
      const pad = '  '.repeat(depth);
      const attrs = [
        ...(node.id ? [`id="${escapeAttr(num(node.id))}"`] : []),
        ...(node.classes.length ? [`class="${escapeAttr(node.classes.map(num).join(' '))}"`] : []),
        ...node.attrs.map(([a, v]) => (v === null ? a : `${a}="${escapeAttr(num(v))}"`)),
      ];
      const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
      if (VOID_ELEMENTS.has(tag)) {
        out.push(pad + open);
        continue;
      }
      // Typed text is text, never an expression: braces in it are escaped for the DSL.
      const text = node.text === null ? '' : num(node.text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string).replace(/[{}]/g, (c) => `\\${c}`);
      if (node.children.length === 0) {
        out.push(`${pad}${open}${text}</${tag}>`);
        continue;
      }
      out.push(pad + open + text);
      render(node.children, tag, depth + 1, out, budget);
      out.push(`${pad}</${tag}>`);
    }
  }
}

/** The HTML for an abbreviation, or null when it is not one (then Tab just indents). */
export function expandAbbreviation(abbr: string, indent = ''): string | null {
  const a = abbr.trim();
  if (!a || a.length > 500) return null;
  // A plain word must be an HTML tag: Tab after an ordinary word in a text never turns it into markup.
  if (/^[a-zA-Z][\w-]*$/.test(a) && !HTML_ELEMENTS.has(a.toLowerCase())) return null;
  try {
    const r = new Reader(a);
    const nodes = list(r);
    if (r.i !== a.length) return null;
    const out: string[] = [];
    render(nodes, '', 0, out, { n: MAX });
    return out.map((line, i) => (i === 0 ? line : indent + line)).join('\n');
  } catch {
    return null;
  }
}

/**
 * The abbreviation right before the cursor on a line: from the last space (outside [..] and {..}) or '>' of
 * markup. Null when there is none.
 */
export function abbreviationBefore(line: string): string | null {
  let depthSq = 0;
  let depthCurly = 0;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === '[') depthSq++;
    else if (c === ']') depthSq--;
    else if (c === '{') depthCurly++;
    else if (c === '}') depthCurly--;
    else if (depthSq === 0 && depthCurly === 0 && (c === ' ' || c === '\t')) start = i + 1;
  }
  // After a closed tag on the same line: `<p>x</p>ul>li` starts after the last `>` of markup.
  const tagEnd = line.lastIndexOf('</');
  if (tagEnd >= 0) {
    const close = line.indexOf('>', tagEnd);
    if (close >= start) start = close + 1;
  }
  const abbr = line.slice(start);
  // Quotes or `=` outside [..] and {..}: markup being written, not an abbreviation.
  const bare = abbr.replace(/\[[^\]]*\]|\{[^}]*\}/g, '');
  return abbr && !abbr.startsWith('<') && !/["'=<]/.test(bare) ? abbr : null;
}

/** Where the cursor goes in an expansion: inside the first empty element, else at the end. */
export function cursorIn(html: string): number {
  const empty = html.search(/><\/[a-zA-Z][\w:-]*>/);
  return empty >= 0 ? empty + 1 : html.length;
}
