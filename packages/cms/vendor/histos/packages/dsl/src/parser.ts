import { XbSyntaxError, type Warning } from './errors.ts';
import { findClosingBrace, parseExpression, presetCallOf } from './expr.ts';
import { hasInterpolation, isSingleInterpolation } from './interp.ts';
import {
  ATTRIBUTE_NAME_PATTERN,
  COMPONENT_REF_PATTERN,
  COMPONENT_TAG_PATTERN,
  HTML_ELEMENTS,
  IDENTIFIER_PATTERN,
  RESERVED_NAMES,
  SLOT_NAME_PATTERN,
  TAG_PATTERN,
  tagToRef,
} from './names.ts';
import { printAttributes } from './printer.ts';
import {
  DEFAULT_SLOT,
  INLINE_FORMAT,
  MAX_NESTING,
  RAW_TEXT_ELEMENTS,
  VOID_ELEMENTS,
  type AttrValue,
  type BranchBlock,
  type ElementBlock,
  type LoopSource,
  type PropValue,
  type SlotFillBlock,
  type XbBlock,
} from './tree.ts';
import { randomUid, type UidFactory } from './uid.ts';
import { parseBlockGrammar, serializeParsedBlock } from './wp.ts';

/**
 * DSL → XB tree — docs/spec/dsl.md.
 * Single pass, strict (well-formed markup required, no implied end tags), with positioned errors.
 */

export interface ParseOptions {
  uid?: UidFactory;
}

export interface ParseResult {
  blocks: XbBlock[];
  warnings: Warning[];
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  return new Parser(source, options.uid ?? randomUid).parseDocument();
}

/** `code` parts (interpolations, escapes, folded inline markup) are never whitespace-collapsed. */
type TextPart = { kind: 'lit' | 'code'; s: string };

type RawNode =
  | { k: 'text'; parts: TextPart[] }
  /** `inline`: canonical markup when the element can be folded into a text run. `fill`: explicit {#slot}. */
  | { k: 'block'; block: XbBlock; inline?: string; fill?: boolean };

interface Context {
  preserveWs: boolean;
  inComponent: boolean;
}

const WS = /^[ \t\r\n\f]*$/;
const HTML_WS = ' \t\r\n\f';
const BLOCK_DELIMITER = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)\s+(?:\{[\s\S]*?\}\s+)?(\/)?-->/y;

class Parser {
  private pos = 0;
  private depth = 0;
  private readonly warnings: Warning[] = [];

  constructor(
    private readonly src: string,
    private readonly uid: UidFactory,
  ) {}

  parseDocument(): ParseResult {
    const ctx: Context = { preserveWs: false, inComponent: false };
    const raws = this.parseFragment(ctx);
    if (this.pos < this.src.length) {
      const found = /^(<\/[^>]*>|\{[:/][^}]*\})/.exec(this.src.slice(this.pos))?.[0] ?? this.src.charAt(this.pos);
      throw this.error(`Chiusura inattesa ${found}`);
    }
    return { blocks: this.finish(raws, ctx), warnings: this.warnings };
  }

  // ---------------------------------------------------------------- helpers

  private error(message: string, at = this.pos): XbSyntaxError {
    return new XbSyntaxError(message, this.src, at);
  }

  private at(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  private skipWs(): void {
    while (/\s/.test(this.src.charAt(this.pos))) this.pos++;
  }

  private match(re: RegExp): RegExpExecArray | null {
    const sticky = new RegExp(re.source, 'y');
    sticky.lastIndex = this.pos;
    const m = sticky.exec(this.src);
    if (m) this.pos += m[0].length;
    return m;
  }

  /** Validates `{…}` starting at `open`; returns the index of the closing brace. */
  private interpolation(open: number): number {
    const close = findClosingBrace(this.src, open);
    parseExpression(this.src, open + 1, close);
    return close;
  }

  // ---------------------------------------------------------------- fragments

  private parseFragment(ctx: Context): RawNode[] {
    if (++this.depth > MAX_NESTING) throw this.error(`Annidamento oltre ${MAX_NESTING} livelli`);
    try {
      return this.parseFragmentBody(ctx);
    } finally {
      this.depth--;
    }
  }

  private parseFragmentBody(ctx: Context): RawNode[] {
    const raws: RawNode[] = [];
    while (this.pos < this.src.length) {
      if (this.at('</') || this.at('{:') || this.at('{/')) break;
      if (this.at('<!--')) {
        this.parseComment(raws);
      } else if (this.at('<') && /[A-Za-z]/.test(this.src.charAt(this.pos + 1))) {
        raws.push(this.parseTag(ctx));
      } else if (this.at('{#')) {
        raws.push(this.parseBlockTag(ctx));
      } else if (this.at('{@')) {
        raws.push({ k: 'block', block: this.parseAtTag() });
      } else {
        const before = this.pos;
        this.parseText(raws);
        // Every branch must consume input: a construct no branch handles is a bug, never an endless loop.
        if (this.pos === before) throw this.error(`Carattere inatteso "${this.src.charAt(this.pos)}"`);
      }
    }
    return raws;
  }

  private parseText(raws: RawNode[]): void {
    const last = raws[raws.length - 1];
    const node: RawNode = last && last.k === 'text' ? last : { k: 'text', parts: [] };
    if (node !== last) raws.push(node);
    let lit = '';
    const flush = () => {
      if (lit !== '') node.parts.push({ kind: 'lit', s: lit });
      lit = '';
    };
    while (this.pos < this.src.length) {
      const c = this.src.charAt(this.pos);
      const next = this.src.charAt(this.pos + 1);
      // `<!` other than a comment (`<!DOCTYPE`, `<![CDATA[`) is plain text, like any `<` not starting a tag.
      if (c === '<' && (/[A-Za-z/]/.test(next) || this.src.startsWith('<!--', this.pos))) break;
      if (c === '\\' && (next === '{' || next === '}')) {
        flush();
        node.parts.push({ kind: 'code', s: c + next });
        this.pos += 2;
        continue;
      }
      if (c === '{') {
        if ('#:/@'.includes(next)) break;
        flush();
        const close = this.interpolation(this.pos);
        node.parts.push({ kind: 'code', s: this.src.slice(this.pos, close + 1) });
        this.pos = close + 1;
        continue;
      }
      lit += c;
      this.pos++;
    }
    flush();
  }

  private parseComment(raws: RawNode[]): void {
    if (/^<!--\s+wp:/.test(this.src.slice(this.pos, this.pos + 64))) {
      raws.push({ k: 'block', block: this.parsePassthrough() });
      return;
    }
    if (/^<!--\s+\/wp:/.test(this.src.slice(this.pos, this.pos + 64))) {
      throw this.error('Chiusura di blocco Gutenberg senza apertura');
    }
    const end = this.src.indexOf('-->', this.pos + 4);
    if (end < 0) throw this.error('Commento HTML non chiuso');
    this.warnings.push({ message: 'Commento HTML rimosso (i commenti non sono conservati)', offset: this.pos });
    this.pos = end + 3;
  }

  /** A foreign Gutenberg block written inline, kept verbatim inside xb/passthrough. */
  private parsePassthrough(): XbBlock {
    const start = this.pos;
    let depth = 0;
    let scan = start;
    for (;;) {
      const next = this.src.indexOf('<!--', scan);
      if (next < 0) throw this.error('Blocco Gutenberg non chiuso', start);
      BLOCK_DELIMITER.lastIndex = next;
      const m = BLOCK_DELIMITER.exec(this.src);
      if (!m) {
        if (next === start) throw this.error('Delimitatore di blocco Gutenberg non valido', start);
        scan = next + 4;
        continue;
      }
      scan = next + m[0].length;
      if (m[1]) depth--;
      else if (!m[3]) depth++;
      if (depth === 0) break;
    }
    this.pos = scan;
    const parsed = parseBlockGrammar(this.src.slice(start, scan)).filter(
      (b) => b.blockName !== null || b.innerHTML.trim() !== '',
    );
    const block = parsed[0];
    if (parsed.length !== 1 || !block || block.blockName === null) {
      throw this.error('Blocco Gutenberg non valido', start);
    }
    if (block.blockName.startsWith('xb/')) {
      throw this.error('I blocchi xb/ si scrivono in DSL, non come commenti Gutenberg', start);
    }
    return { name: 'xb/passthrough', attrs: { uid: this.uid() }, raw: serializeParsedBlock(block) };
  }

  // ---------------------------------------------------------------- tags

  private parseTag(ctx: Context): RawNode {
    const start = this.pos;
    this.pos++;
    const name = this.match(/[A-Za-z][A-Za-z0-9.:-]*/)?.[0] ?? '';
    const { list, selfClosing } = this.parseAttributes(start);
    return /^[A-Z]/.test(name)
      ? { k: 'block', block: this.buildComponent(name, list, selfClosing, start) }
      : this.buildElement(name, list, selfClosing, start, ctx);
  }

  private parseAttributes(tagStart: number): { list: Array<[string, AttrValue, number]>; selfClosing: boolean } {
    const list: Array<[string, AttrValue, number]> = [];
    const seen = new Set<string>();
    for (;;) {
      this.skipWs();
      if (this.at('/>')) {
        this.pos += 2;
        return { list, selfClosing: true };
      }
      if (this.at('>')) {
        this.pos++;
        return { list, selfClosing: false };
      }
      if (this.pos >= this.src.length) throw this.error('Tag non chiuso', tagStart);
      const nameStart = this.pos;
      const name = this.match(/[^\s"'<>/={}]+/)?.[0];
      if (!name) throw this.error(`Carattere inatteso "${this.src.charAt(this.pos)}" nel tag`);
      if (seen.has(name)) throw this.error(`Attributo "${name}" duplicato`, nameStart);
      seen.add(name);
      this.skipWs();
      let value: AttrValue = true;
      if (this.at('=')) {
        this.pos++;
        this.skipWs();
        value = this.parseAttributeValue();
      }
      list.push([name, value, nameStart]);
    }
  }

  private parseAttributeValue(): string {
    const q = this.src.charAt(this.pos);
    if (q === '"' || q === "'") {
      const open = this.pos++;
      let out = '';
      for (;;) {
        if (this.pos >= this.src.length) throw this.error('Valore di attributo non chiuso', open);
        const c = this.src.charAt(this.pos);
        if (c === q) {
          this.pos++;
          return out;
        }
        const next = this.src.charAt(this.pos + 1);
        if (c === '\\' && (next === '{' || next === '}')) {
          out += c + next;
          this.pos += 2;
        } else if (c === '{') {
          const close = this.interpolation(this.pos);
          out += this.src.slice(this.pos, close + 1);
          this.pos = close + 1;
        } else {
          out += c;
          this.pos++;
        }
      }
    }
    if (q === '{') {
      const close = this.interpolation(this.pos);
      const value = this.src.slice(this.pos, close + 1);
      this.pos = close + 1;
      return value;
    }
    const value = this.match(/[^\s"'<>=`{}]+/)?.[0];
    if (!value) throw this.error('Valore di attributo mancante');
    return value;
  }

  private expectCloseTag(name: string, openAt: number): void {
    if (!this.at('</')) {
      const what = this.pos >= this.src.length ? 'la fine del documento' : `"${this.src.slice(this.pos, this.pos + 12)}…"`;
      throw this.error(`<${name}> non chiuso: trovato ${what}`, openAt);
    }
    const closeAt = this.pos;
    this.pos += 2;
    const found = this.match(/[A-Za-z][A-Za-z0-9.:-]*/)?.[0] ?? '';
    this.skipWs();
    if (found !== name || !this.at('>')) throw this.error(`Atteso </${name}>, trovato </${found}>`, closeAt);
    this.pos++;
  }

  private takeLabel(name: string, value: AttrValue, at: number): string {
    if (name !== 'xb:label' || typeof value !== 'string' || hasInterpolation(value)) {
      throw this.error(`Pseudo-attributo "${name}" sconosciuto o non valido (ammesso: xb:label="testo")`, at);
    }
    return value;
  }

  private buildElement(
    tag: string,
    list: Array<[string, AttrValue, number]>,
    selfClosing: boolean,
    start: number,
    ctx: Context,
  ): RawNode {
    if (!TAG_PATTERN.test(tag)) throw this.error(`Nome di tag non valido "${tag}"`, start + 1);
    const attributes: Record<string, AttrValue> = {};
    let label: string | undefined;
    for (const [name, value, at] of list) {
      if (name.startsWith('xb:')) label = this.takeLabel(name, value, at);
      else if (!ATTRIBUTE_NAME_PATTERN.test(name) || RESERVED_NAMES.has(name)) throw this.error(`Nome di attributo non valido "${name}"`, at);
      else attributes[name] = value;
    }

    let children: XbBlock[] = [];
    if (RAW_TEXT_ELEMENTS.has(tag) && !selfClosing) {
      const close = new RegExp(`</${tag}\\s*>`, 'gi');
      close.lastIndex = this.pos;
      const m = close.exec(this.src);
      if (!m) throw this.error(`<${tag}> non chiuso`, start);
      const content = this.src.slice(this.pos, m.index);
      this.pos = m.index + m[0].length;
      if (content !== '') children = [{ name: 'xb/text', attrs: { uid: this.uid(), content, verbatim: true } }];
    } else if (!VOID_ELEMENTS.has(tag) && !selfClosing) {
      const childCtx: Context = { preserveWs: ctx.preserveWs || tag === 'pre', inComponent: false };
      const raws = this.parseFragment(childCtx);
      this.expectCloseTag(tag, start);
      children = this.finish(raws, childCtx);
    }

    const attrs: ElementBlock['attrs'] = { uid: this.uid(), tag };
    if (label !== undefined) attrs.label = label;
    if (Object.keys(attributes).length > 0) attrs.attributes = attributes;
    const block: ElementBlock = { name: 'xb/element', attrs, children };
    const inline = this.inlineMarkup(block);
    return inline === undefined ? { k: 'block', block } : { k: 'block', block, inline };
  }

  /** docs/spec/dsl.md §3.4: plain inline formatting is folded into the surrounding text run. */
  private inlineMarkup(block: ElementBlock): string | undefined {
    const allowed = INLINE_FORMAT.get(block.attrs.tag);
    if (!allowed || block.attrs.label !== undefined) return undefined;
    for (const [name, value] of Object.entries(block.attrs.attributes ?? {})) {
      if (!allowed.has(name) || typeof value !== 'string' || hasInterpolation(value)) return undefined;
    }
    const [only, ...rest] = block.children;
    if (rest.length > 0) return undefined;
    if (only && (only.name !== 'xb/text' || only.attrs.verbatim)) return undefined;
    const open = `<${block.attrs.tag}${printAttributes(block.attrs.attributes)}>`;
    if (VOID_ELEMENTS.has(block.attrs.tag)) return open;
    return open + (only ? only.attrs.content : '') + `</${block.attrs.tag}>`;
  }

  private buildComponent(
    tag: string,
    list: Array<[string, AttrValue, number]>,
    selfClosing: boolean,
    start: number,
  ): XbBlock {
    if (!COMPONENT_TAG_PATTERN.test(tag)) throw this.error(`Nome di componente non valido "${tag}"`, start + 1);
    if (tag === tag.toUpperCase() && HTML_ELEMENTS.has(tag.toLowerCase())) {
      throw this.error(`"${tag}": i tag HTML vanno in minuscolo, l'iniziale maiuscola indica un componente`, start + 1);
    }
    const ref = tagToRef(tag);
    if (!COMPONENT_REF_PATTERN.test(ref)) throw this.error(`Nome di componente non valido "${tag}"`, start + 1);
    const props: Record<string, PropValue> = {};
    let label: string | undefined;
    for (const [name, value, at] of list) {
      if (name.startsWith('xb:')) label = this.takeLabel(name, value, at);
      else if (!IDENTIFIER_PATTERN.test(name) || RESERVED_NAMES.has(name)) throw this.error(`Nome di prop non valido "${name}"`, at);
      else props[name] = toProp(value);
    }
    let children: SlotFillBlock[] = [];
    if (!selfClosing) {
      const ctx: Context = { preserveWs: false, inComponent: true };
      const raws = this.parseFragment(ctx);
      this.expectCloseTag(tag, start);
      children = this.buildFills(raws, ctx, start);
    }
    const attrs: { uid: string; ref: string; label?: string; props?: Record<string, PropValue> } = { uid: this.uid(), ref };
    if (label !== undefined) attrs.label = label;
    if (Object.keys(props).length > 0) attrs.props = props;
    return { name: 'xb/component', attrs, children };
  }

  private buildFills(raws: RawNode[], ctx: Context, start: number): SlotFillBlock[] {
    const fills: SlotFillBlock[] = [];
    const loose: RawNode[] = [];
    let defaultAt = -1;
    for (const r of raws) {
      if (r.k === 'block' && r.fill && r.block.name === 'xb/slot-fill') {
        if (fills.some((f) => f.attrs.name === (r.block as SlotFillBlock).attrs.name)) {
          throw this.error(`Slot "${r.block.attrs.name}" riempito due volte`, start);
        }
        fills.push(r.block);
      } else if (!(r.k === 'text' && r.parts.every((p) => p.kind === 'lit' && WS.test(p.s)))) {
        if (defaultAt < 0) defaultAt = fills.length;
        loose.push(r);
      }
    }
    const children = this.finish(loose, ctx);
    if (children.length > 0) {
      if (fills.some((f) => f.attrs.name === DEFAULT_SLOT)) {
        throw this.error('Contenuto libero e {#slot default} non possono coesistere', start);
      }
      fills.splice(defaultAt, 0, { name: 'xb/slot-fill', attrs: { uid: this.uid(), name: DEFAULT_SLOT }, children });
    }
    return fills;
  }

  // ---------------------------------------------------------------- {#…} {@…}

  private expectBlockClose(keyword: string, openAt: number): void {
    const close = `{/${keyword}}`;
    if (this.at(close)) {
      this.pos += close.length;
      return;
    }
    const what = this.pos >= this.src.length ? 'la fine del documento' : `"${this.src.slice(this.pos, this.pos + 12)}…"`;
    throw this.error(`{#${keyword}} non chiuso: atteso ${close}, trovato ${what}`, openAt);
  }

  private parseBlockTag(ctx: Context): RawNode {
    const open = this.pos;
    const close = findClosingBrace(this.src, open);
    const head = this.src.slice(open + 2, close);
    const keyword = /^[a-z]+/.exec(head)?.[0] ?? '';
    const childCtx: Context = { preserveWs: ctx.preserveWs, inComponent: false };
    const bodyStart = open + 2 + keyword.length;

    switch (keyword) {
      case 'if': {
        if (!/^\s/.test(this.src.charAt(bodyStart))) throw this.error('Sintassi: {#if condizione}', open);
        parseExpression(this.src, bodyStart, close);
        this.pos = close + 1;
        const branches: BranchBlock[] = [];
        let test: string | undefined = this.src.slice(bodyStart, close).trim();
        let sawElse = false;
        for (;;) {
          const raws = this.parseFragment(childCtx);
          const attrs: { uid: string; test?: string } = { uid: this.uid() };
          if (test !== undefined) attrs.test = test;
          branches.push({ name: 'xb/branch', attrs, children: this.finish(raws, childCtx) });
          if (!this.at('{:')) break;
          const at = this.pos;
          const c = findClosingBrace(this.src, at);
          const inner = this.src.slice(at + 2, c);
          const elseIf = /^\s*else\s+if\s+/.exec(inner);
          if (sawElse) throw this.error('Nessun ramo è ammesso dopo {:else}', at);
          if (elseIf) {
            parseExpression(this.src, at + 2 + elseIf[0].length, c);
            test = this.src.slice(at + 2 + elseIf[0].length, c).trim();
          } else if (inner.trim() === 'else') {
            test = undefined;
            sawElse = true;
          } else {
            throw this.error(`Ramo non valido {:${inner.trim()}}`, at);
          }
          this.pos = c + 1;
        }
        this.expectBlockClose('if', open);
        return { k: 'block', block: { name: 'xb/if', attrs: { uid: this.uid() }, children: branches } };
      }

      case 'loop': {
        const body = this.src.slice(bodyStart, close);
        const as = splitLoopHead(body);
        if (!/^\s/.test(body) || !as) throw this.error('Sintassi: {#loop sorgente as elemento, indice}', open);
        const sourceEnd = bodyStart + as.index;
        const expr = parseExpression(this.src, bodyStart, sourceEnd, { allowPresetCall: true });
        let source: LoopSource;
        const preset = presetCallOf(expr);
        if (preset) {
          const args: Record<string, string> = {};
          for (const arg of preset.call.args) args[arg.name as string] = this.src.slice(arg.value.start, arg.value.end);
          source = Object.keys(args).length > 0 ? { kind: 'preset', id: preset.id, args } : { kind: 'preset', id: preset.id };
          // `{#loop foto().groupBy("anno") as gruppo}` (doc 23 of Publish, item 187): each item is a group {key, items}.
          if (preset.groupBy) source.groupBy = preset.groupBy;
        } else {
          source = { kind: 'expr', expr: this.src.slice(bodyStart, sourceEnd).trim() };
        }
        this.pos = close + 1;
        const raws = this.parseFragment(childCtx);
        const children = this.finish(raws, childCtx);
        // `{:else}`: what the loop shows when it has no items (docs/spec/dsl.md), as a last branch without a test.
        if (this.at('{:')) {
          const at = this.pos;
          const c = findClosingBrace(this.src, at);
          if (this.src.slice(at + 2, c).trim() !== 'else') throw this.error(`Ramo non valido in un loop: {:${this.src.slice(at + 2, c).trim()}} (ammesso solo {:else})`, at);
          this.pos = c + 1;
          const empty = this.parseFragment(childCtx);
          children.push({ name: 'xb/branch', attrs: { uid: this.uid() }, children: this.finish(empty, childCtx) });
          if (this.at('{:')) throw this.error('Un loop ha un solo {:else}', this.pos);
        }
        this.expectBlockClose('loop', open);
        const attrs: { uid: string; source: LoopSource; as: string; index?: string } = {
          uid: this.uid(),
          source,
          as: as[1] as string,
        };
        if (as[2]) attrs.index = as[2];
        return { k: 'block', block: { name: 'xb/loop', attrs, children } };
      }

      case 'slot': {
        if (!ctx.inComponent) throw this.error('{#slot} è ammesso solo come figlio diretto di un componente', open);
        const name = head.slice(4).trim();
        if (!SLOT_NAME_PATTERN.test(name)) throw this.error(`Nome di slot non valido "${name}"`, open);
        this.pos = close + 1;
        const raws = this.parseFragment(childCtx);
        this.expectBlockClose('slot', open);
        return {
          k: 'block',
          fill: true,
          block: { name: 'xb/slot-fill', attrs: { uid: this.uid(), name }, children: this.finish(raws, childCtx) },
        };
      }

      case 'raw': {
        if (head !== 'raw') throw this.error('Sintassi: {#raw}…{/raw}', open);
        const end = this.src.indexOf('{/raw}', close + 1);
        if (end < 0) throw this.error('{#raw} non chiuso', open);
        const content = this.src.slice(close + 1, end);
        this.pos = end + '{/raw}'.length;
        return { k: 'block', block: { name: 'xb/raw', attrs: { uid: this.uid(), content } } };
      }

      default:
        throw this.error(`Blocco sconosciuto {#${keyword}}`, open);
    }
  }

  private parseAtTag(): XbBlock {
    const open = this.pos;
    const close = findClosingBrace(this.src, open);
    const inner = this.src.slice(open + 2, close).trim();
    this.pos = close + 1;
    if (inner === 'content') return { name: 'xb/post-content', attrs: { uid: this.uid() } };
    const slot = /^slot(?:\s+(\S+))?$/.exec(inner);
    if (slot) {
      const name = slot[1] ?? DEFAULT_SLOT;
      if (!SLOT_NAME_PATTERN.test(name)) throw this.error(`Nome di slot non valido "${name}"`, open);
      return { name: 'xb/slot', attrs: { uid: this.uid(), name } };
    }
    throw this.error(`Tag sconosciuto {@${inner}}`, open);
  }

  // ---------------------------------------------------------------- whitespace & text runs

  /** docs/spec/dsl.md §3.3. */
  private finish(raws: RawNode[], ctx: Context): XbBlock[] {
    const items = ctx.preserveWs
      ? raws
      : raws.filter(
          (r) => !(r.k === 'text' && r.parts.every((p) => p.kind === 'lit' && WS.test(p.s)) && r.parts.some((p) => p.s.includes('\n'))),
        );
    const out: XbBlock[] = [];
    let i = 0;
    while (i < items.length) {
      const first = items[i] as RawNode;
      if (first.k === 'block' && first.inline === undefined) {
        out.push(first.block);
        i++;
        continue;
      }
      const runStart = i;
      const parts: TextPart[] = [];
      for (let r = items[i]; r && (r.k === 'text' || r.inline !== undefined); r = items[++i]) {
        if (r.k === 'text') parts.push(...r.parts);
        else parts.push({ kind: 'code', s: r.inline as string });
      }
      const content = runContent(parts, ctx.preserveWs, runStart === 0, i === items.length);
      if (content !== '') out.push({ name: 'xb/text', attrs: { uid: this.uid(), content } });
    }
    return out;
  }
}

function runContent(input: TextPart[], preserve: boolean, atStart: boolean, atEnd: boolean): string {
  if (preserve) return input.map((p) => p.s).join('');
  const parts: TextPart[] = [];
  for (const p of input) {
    const prev = parts[parts.length - 1];
    if (prev && prev.kind === 'lit' && p.kind === 'lit') prev.s += p.s;
    else parts.push({ ...p });
  }
  const first = parts[0];
  if (atStart && first?.kind === 'lit') first.s = stripNewlineWs(first.s, 'start');
  const last = parts[parts.length - 1];
  if (atEnd && last?.kind === 'lit') last.s = stripNewlineWs(last.s, 'end');
  return parts.map((p) => (p.kind === 'lit' ? p.s.replace(/[ \t\r\n\f]+/g, ' ') : p.s)).join('');
}

/**
 * `source as item, index`: finds the last " as " and checks what follows. Linear in the length of the head
 * (an unanchored regex here backtracks quadratically on long runs of whitespace).
 */
function splitLoopHead(body: string): { index: number; 1: string; 2: string | undefined } | null {
  const isWs = (c: string) => c !== '' && /\s/.test(c);
  let at = body.lastIndexOf('as');
  while (at > 0 && !(isWs(body.charAt(at - 1)) && isWs(body.charAt(at + 2)))) at = body.lastIndexOf('as', at - 1);
  if (at <= 0) return null;
  const tail = /^\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*$/.exec(body.slice(at + 2));
  if (!tail) return null;
  let index = at;
  while (index > 0 && isWs(body.charAt(index - 1))) index--;
  return { index, 1: tail[1] as string, 2: tail[2] };
}

/** Removes the leading (or trailing) whitespace run when it contains a newline. Linear: no regex backtracking. */
function stripNewlineWs(s: string, side: 'start' | 'end'): string {
  let newline = false;
  if (side === 'start') {
    let i = 0;
    for (; i < s.length && HTML_WS.includes(s.charAt(i)); i++) newline ||= s.charAt(i) === '\n';
    return newline ? s.slice(i) : s;
  }
  let i = s.length;
  for (; i > 0 && HTML_WS.includes(s.charAt(i - 1)); i--) newline ||= s.charAt(i - 1) === '\n';
  return newline ? s.slice(0, i) : s;
}

function toProp(value: AttrValue): PropValue {
  if (value === true) return true;
  if (isSingleInterpolation(value)) {
    const inner = value.slice(1, -1);
    const expr = parseExpression(inner);
    return expr.type === 'Literal' ? expr.value : { expr: inner.trim() };
  }
  return hasInterpolation(value) ? { tpl: value } : value;
}
