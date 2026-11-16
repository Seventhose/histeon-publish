import { findClosingBrace } from './expr.ts';
import { hasInterpolation, isSingleInterpolation, mapOutsideInterpolations } from './interp.ts';
import { refToTag } from './names.ts';
import {
  DEFAULT_SLOT,
  INLINE_FORMAT,
  MAX_NESTING,
  loopElse,
  RAW_TEXT_ELEMENTS,
  VOID_ELEMENTS,
  type AttrValue,
  type LoopSource,
  type PropValue,
  type XbBlock,
} from './tree.ts';

/**
 * Canonical DSL printer — docs/spec/dsl.md §5.
 * Invariant (tested): parse(print(t)) equals t up to uids, and print(parse(print(t))) === print(t).
 * A fragment that contains text is printed on one line, so the printer never adds whitespace next to text.
 */

export interface PrintOptions {
  indent?: string;
}

export function print(blocks: XbBlock[], options: PrintOptions = {}): string {
  return new Printer(options.indent ?? '  ', null).fragment(blocks, 0, false);
}

/** Source range of every node in the printed text: uid → [from, to). */
export type SourceMap = Map<string, [number, number]>;

const OPEN = '\uE000';
const MID = '\uE001';
const CLOSE = '\uE002';

/**
 * Prints like print() and also returns where each node landed, for selection sync in the HTML panel.
 * Nodes are bracketed with private-use markers while printing, then the markers are stripped.
 * If the content itself contains those code points, the map is left empty rather than wrong.
 */
export function printWithMap(blocks: XbBlock[], options: PrintOptions = {}): { text: string; map: SourceMap } {
  const plain = print(blocks, options);
  if (/[\uE000-\uE002]/.test(plain)) return { text: plain, map: new Map() };
  const nodes: XbBlock[] = [];
  const marked = new Printer(options.indent ?? '  ', nodes).fragment(blocks, 0, false);
  const map: SourceMap = new Map();
  const stack: Array<{ uid: string; from: number }> = [];
  let text = '';
  for (let i = 0; i < marked.length; i++) {
    const c = marked.charAt(i);
    if (c === OPEN) {
      const end = marked.indexOf(MID, i);
      const node = nodes[Number(marked.slice(i + 1, end))];
      if (node) stack.push({ uid: node.attrs.uid, from: text.length });
      i = end;
    } else if (c === CLOSE) {
      const open = stack.pop();
      if (open && !map.has(open.uid)) map.set(open.uid, [open.from, text.length]);
    } else {
      text += c;
    }
  }
  return { text, map };
}

/** Innermost node whose range contains `offset`. */
export function nodeAt(map: SourceMap, offset: number): string | null {
  let best: string | null = null;
  let size = Infinity;
  for (const [uid, [from, to]] of map) {
    if (offset >= from && offset <= to && to - from < size) {
      best = uid;
      size = to - from;
    }
  }
  return best;
}

/**
 * Text content as DSL source that reads back as the same text node. Content from storage is not trusted to be
 * canonical (Gutenberg, REST, other tools can write anything into the attribute), and the printed code is parsed
 * again — with the editing user's privileges — as soon as anyone edits the HTML panel. So:
 * - `{#` `{:` `{/` `{@` and unbalanced `{` become `\{` (literal brace), interpolations stay as they are;
 * - `<` is kept only where it opens or closes an inline formatting tag (docs/spec/dsl.md §3.4), otherwise `&lt;`;
 * - a trailing `\` becomes `&#92;`, so it cannot escape the brace of a following block.
 */
export function escapeText(content: string): string {
  const kept = keptInlineTags(content);
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const c = content.charAt(i);
    const next = content.charAt(i + 1);
    if (c === '\\' && (next === '{' || next === '}')) {
      out += c + next;
      i++;
    } else if (c === '{') {
      let close = -1;
      if (next !== '' && !'#:/@'.includes(next)) {
        try {
          close = findClosingBrace(content, i);
        } catch {
          close = -1;
        }
      }
      if (close < 0) {
        out += '\\{';
      } else {
        out += content.slice(i, close + 1);
        i = close;
      }
    } else if (c === '<' && /[A-Za-z/!]/.test(next)) {
      const length = kept.get(i);
      if (length !== undefined) {
        out += content.slice(i, i + length);
        i += length - 1;
      } else {
        out += '&lt;';
      }
    } else if (c === '\\' && i === content.length - 1) {
      out += '&#92;';
    } else if (c === '<' && i === content.length - 1) {
      // A trailing `<` would join the next node's text when printed (`<` + `!x`, `<` + `b>`).
      out += '&lt;';
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Inline tags that may stay as markup: allowed by the folding rule and properly paired (an unpaired open or
 * close tag would make the parser fail or nest wrongly). Returns offset → length of each kept tag.
 * Tags inside interpolations are not markup, so `{…}` is skipped the same way escapeText skips it.
 */
function keptInlineTags(content: string): Map<number, number> {
  const kept = new Map<number, number>();
  const open: Array<{ tag: string; at: number; length: number }> = [];
  for (let i = 0; i < content.length; i++) {
    const c = content.charAt(i);
    if (c === '\\') {
      i++;
    } else if (c === '{' && !'#:/@'.includes(content.charAt(i + 1))) {
      try {
        i = findClosingBrace(content, i);
      } catch {
        // Unbalanced: escaped as a literal brace.
      }
    } else if (c === '<') {
      const m = INLINE_TAG.exec(content.slice(i, i + 2048));
      if (!m || !inlineTagAllowed(m[1] === '/', m[2] as string, m[3] as string)) continue;
      const tag = m[2] as string;
      const length = m[0].length;
      if (m[1] === '/') {
        const top = open[open.length - 1];
        if (top && top.tag === tag) {
          open.pop();
          kept.set(top.at, top.length);
          kept.set(i, length);
        }
      } else if (VOID_ELEMENTS.has(tag) || m[4] === '/') {
        kept.set(i, length);
      } else {
        open.push({ tag, at: i, length });
      }
      i += length - 1;
    }
  }
  return kept;
}

/** An inline tag as the parser folds it: static attributes only, no braces. */
const INLINE_TAG = /^<(\/?)([a-z][a-z0-9]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*(?:\s*=\s*(?:"[^"{}]*"|'[^'{}]*'|[^\s"'<>=`{}]+))?)*)\s*(\/?)>/;

const INLINE_ATTRIBUTE = /\s+([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"[^"{}]*"|'[^'{}]*'|[^\s"'<>=`{}]+))?/y;

/** Same rule as the parser's folding: a known inline tag with only its allowed, static attributes. */
function inlineTagAllowed(closing: boolean, tag: string, attributes: string): boolean {
  const allowed = INLINE_FORMAT.get(tag);
  if (!allowed) return false;
  if (closing) return attributes.trim() === '';
  INLINE_ATTRIBUTE.lastIndex = 0;
  const seen = new Set<string>();
  for (let m = INLINE_ATTRIBUTE.exec(attributes); m; m = INLINE_ATTRIBUTE.exec(attributes)) {
    const name = m[1] as string;
    if (!allowed.has(name) || seen.has(name)) return false;
    seen.add(name);
    if (INLINE_ATTRIBUTE.lastIndex === attributes.length) break;
  }
  return attributes.trim() === '' || INLINE_ATTRIBUTE.lastIndex === attributes.length;
}

/** Content of script/style/textarea: a closing tag inside it would end the element early, so it is neutralized (the server does the same when rendering). */
export function escapeRawText(tag: string, content: string): string {
  return content.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

/** xb/raw content cannot contain its own terminator: the brace becomes an HTML entity (same rendering). */
export function escapeRaw(content: string): string {
  return content.replaceAll('{/raw}', '&#123;/raw}');
}

export function quoteAttribute(value: string): string {
  let hasDouble = false;
  let hasSingle = false;
  mapOutsideInterpolations(value, (text) => {
    hasDouble ||= text.includes('"');
    hasSingle ||= text.includes("'");
    return text;
  });
  if (!hasDouble) return `"${value}"`;
  if (!hasSingle) return `'${value}'`;
  return `"${mapOutsideInterpolations(value, (text) => text.replace(/"/g, '&quot;'))}"`;
}

export function printAttribute(name: string, value: AttrValue): string {
  if (value === true) return name;
  if (isSingleInterpolation(value)) return `${name}=${value}`;
  return `${name}=${quoteAttribute(value)}`;
}

export function printAttributes(attributes: Record<string, AttrValue> | undefined): string {
  if (!attributes) return '';
  return Object.entries(attributes)
    .map(([name, value]) => ' ' + printAttribute(name, value))
    .join('');
}

export function printProp(name: string, value: PropValue): string {
  if (value === true) return name;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return `${name}={${JSON.stringify(value)}}`;
  }
  if (typeof value === 'string') {
    // A literal containing "{" would be re-read as a template: print it as a string expression.
    return hasInterpolation(value) ? `${name}={${JSON.stringify(value)}}` : printAttribute(name, value);
  }
  if ('expr' in value) return `${name}={${value.expr}}`;
  return `${name}=${quoteAttribute(value.tpl)}`;
}

export function printLoopSource(source: LoopSource): string {
  if (source.kind === 'expr') return source.expr;
  const args = Object.entries(source.args ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  // `.groupBy("anno", "Y")` after the call (doc 23 of Publish, item 187); the field and the mode are literal strings.
  const group = source.groupBy
    ? `.groupBy(${JSON.stringify(source.groupBy.field)}${source.groupBy.how === undefined ? '' : `, ${JSON.stringify(source.groupBy.how)}`})`
    : '';
  return `${source.id}(${args})${group}`;
}

class Printer {
  constructor(
    private readonly indent: string,
    /** When set, nodes are bracketed with markers indexing into this list (printWithMap). */
    private readonly marks: XbBlock[] | null,
  ) {}

  private level = 0;

  private pad(depth: number): string {
    return this.indent.repeat(depth);
  }

  fragment(blocks: XbBlock[], depth: number, preserve: boolean): string {
    if (preserve || blocks.some((b) => b.name === 'xb/text')) {
      return blocks.map((b) => this.node(b, depth, preserve)).join('');
    }
    return blocks.map((b) => this.pad(depth) + this.node(b, depth, preserve)).join('\n');
  }

  /** Content between an opening and a closing tag at `depth`. */
  private body(children: XbBlock[], depth: number, preserve: boolean): string {
    if (children.length === 0) return '';
    if (preserve || children.some((b) => b.name === 'xb/text')) return this.fragment(children, depth + 1, preserve);
    return '\n' + this.fragment(children, depth + 1, false) + '\n' + this.pad(depth);
  }

  private node(block: XbBlock, depth: number, preserve: boolean): string {
    if (++this.level > MAX_NESTING) throw new RangeError(`Annidamento oltre ${MAX_NESTING} livelli`);
    try {
      return this.mark(block, this.nodeText(block, depth, preserve));
    } finally {
      this.level--;
    }
  }

  /** Brackets the printed text of a node (printWithMap); identity when not mapping. */
  private mark(block: XbBlock, text: string): string {
    if (!this.marks) return text;
    this.marks.push(block);
    return OPEN + String(this.marks.length - 1) + MID + text + CLOSE;
  }

  private nodeText(block: XbBlock, depth: number, preserve: boolean): string {
    switch (block.name) {
      case 'xb/element': {
        const { tag, label, attributes } = block.attrs;
        const open = `<${tag}${label !== undefined ? ` xb:label=${quoteAttribute(label)}` : ''}${printAttributes(attributes)}>`;
        if (VOID_ELEMENTS.has(tag)) return open;
        if (RAW_TEXT_ELEMENTS.has(tag)) {
          return open + block.children.map((c) => (c.name === 'xb/text' ? this.mark(c, escapeRawText(tag, c.attrs.content)) : '')).join('') + `</${tag}>`;
        }
        return open + this.body(block.children, depth, preserve || tag === 'pre') + `</${tag}>`;
      }
      case 'xb/text':
        return escapeText(block.attrs.content);
      case 'xb/if':
        return (
          block.children
            .map((branch, i) => {
              const test = branch.attrs.test;
              const head = i === 0 ? `{#if ${test ?? 'true'}}` : test !== undefined ? `{:else if ${test}}` : '{:else}';
              return this.mark(branch, head + this.body(branch.children, depth, preserve));
            })
            .join('') + '{/if}'
        );
      case 'xb/branch':
        return this.body(block.children, depth, preserve);
      case 'xb/loop': {
        const { source, as, index } = block.attrs;
        const empty = loopElse(block);
        const items = empty ? block.children.slice(0, -1) : block.children;
        const tail = empty ? this.mark(empty, '{:else}' + this.body(empty.children, depth, preserve)) : '';
        return `{#loop ${printLoopSource(source)} as ${as}${index ? `, ${index}` : ''}}` + this.body(items, depth, preserve) + tail + '{/loop}';
      }
      case 'xb/component': {
        const tag = refToTag(block.attrs.ref);
        const label = block.attrs.label !== undefined ? ` xb:label=${quoteAttribute(block.attrs.label)}` : '';
        const props = Object.entries(block.attrs.props ?? {})
          .map(([name, value]) => ' ' + printProp(name, value))
          .join('');
        const open = `<${tag}${label}${props}`;
        const fills = block.children;
        if (fills.length === 0) return `${open} />`;
        const only = fills[0];
        if (fills.length === 1 && only && only.attrs.name === DEFAULT_SLOT) {
          return `${open}>` + this.mark(only, this.body(only.children, depth, preserve)) + `</${tag}>`;
        }
        const inner = fills
          .map((fill) => this.pad(depth + 1) + this.mark(fill, `{#slot ${fill.attrs.name}}` + this.body(fill.children, depth + 1, preserve) + '{/slot}'))
          .join('\n');
        return `${open}>\n${inner}\n${this.pad(depth)}</${tag}>`;
      }
      case 'xb/slot':
        return block.attrs.name === DEFAULT_SLOT ? '{@slot}' : `{@slot ${block.attrs.name}}`;
      case 'xb/slot-fill':
        return `{#slot ${block.attrs.name}}` + this.body(block.children, depth, preserve) + '{/slot}';
      case 'xb/raw':
        return `{#raw}${escapeRaw(block.attrs.content)}{/raw}`;
      case 'xb/passthrough':
        return block.raw;
      case 'xb/post-content':
        return '{@content}';
    }
  }
}
