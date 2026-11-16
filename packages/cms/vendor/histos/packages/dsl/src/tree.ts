/**
 * XB block tree — the in-memory shape of docs/spec/blocks.md.
 * It maps 1:1 to Gutenberg block grammar (see wp.ts) and to the DSL (see parser.ts / printer.ts).
 */

export type AttrValue = string | true;

export type PropValue = string | number | boolean | null | { expr: string } | { tpl: string };

/**
 * A query loop's result in groups (doc 23 of Publish, item 187): `{#loop foto().groupBy("anno") as gruppo}`. Each item
 * of the loop is a group `{key, items}`, as the `groupBy` modifier makes them from a list.
 */
export interface LoopGroupBy {
  field: string;
  how?: string;
}

export type LoopSource =
  | { kind: 'preset'; id: string; args?: Record<string, string>; groupBy?: LoopGroupBy }
  | { kind: 'expr'; expr: string };

export interface ElementBlock {
  name: 'xb/element';
  attrs: { uid: string; tag: string; label?: string; attributes?: Record<string, AttrValue> };
  children: XbBlock[];
}

export interface TextBlock {
  name: 'xb/text';
  attrs: { uid: string; content: string; verbatim?: true };
}

export interface IfBlock {
  name: 'xb/if';
  attrs: { uid: string };
  children: BranchBlock[];
}

export interface BranchBlock {
  name: 'xb/branch';
  /** `test` absent = else branch (must be last). */
  attrs: { uid: string; test?: string };
  children: XbBlock[];
}

export interface LoopBlock {
  name: 'xb/loop';
  attrs: { uid: string; source: LoopSource; as: string; index?: string };
  /** The items' content; a last `xb/branch` without a test is `{:else}`, shown when there are no items. */
  children: XbBlock[];
}

/**
 * The tree with every loop's `{:else}` back at the end of the loop (an insertion "inside" a loop appends after
 * it), and a loop's branches with a test unwrapped into plain content. Unchanged parts keep their identity, and
 * so does the whole tree when nothing is out of place.
 */
export function elseLast(blocks: XbBlock[]): XbBlock[] {
  let changed = false;
  const out = blocks.map((block) => {
    const kids = 'children' in block && Array.isArray(block.children) ? (block.children as XbBlock[]) : null;
    if (!kids) return block;
    let next = elseLast(kids);
    if (block.name === 'xb/loop') {
      const branches = next.filter((c) => c.name === 'xb/branch');
      const last = next[next.length - 1];
      const tidy = branches.length === 0 || (branches.length === 1 && last?.name === 'xb/branch' && last.attrs.test === undefined);
      if (!tidy) {
        const content = next.flatMap((c) => (c.name === 'xb/branch' && c.attrs.test !== undefined ? c.children : c.name === 'xb/branch' ? [] : [c]));
        const empty = next.filter((c): c is BranchBlock => c.name === 'xb/branch' && c.attrs.test === undefined);
        const merged = empty.length ? [{ ...empty[0]!, children: empty.flatMap((b) => b.children) }] : [];
        next = [...content, ...merged];
      }
    }
    if (next === kids) return block;
    changed = true;
    return { ...block, children: next } as XbBlock;
  });
  return changed ? out : blocks;
}

/** The `{:else}` of a loop (its last child, a branch without a test), or null. */
export function loopElse(block: LoopBlock): BranchBlock | null {
  const last = block.children[block.children.length - 1];
  return last && last.name === 'xb/branch' && last.attrs.test === undefined ? last : null;
}

export interface ComponentBlock {
  name: 'xb/component';
  attrs: { uid: string; ref: string; label?: string; props?: Record<string, PropValue> };
  children: SlotFillBlock[];
}

export interface SlotBlock {
  name: 'xb/slot';
  attrs: { uid: string; name: string };
}

export interface SlotFillBlock {
  name: 'xb/slot-fill';
  attrs: { uid: string; name: string };
  children: XbBlock[];
}

export interface RawBlock {
  name: 'xb/raw';
  attrs: { uid: string; content: string };
}

export interface PassthroughBlock {
  name: 'xb/passthrough';
  attrs: { uid: string };
  /** Exactly one foreign block, in canonical serialized form. */
  raw: string;
}

export interface PostContentBlock {
  name: 'xb/post-content';
  attrs: { uid: string };
}

export type XbBlock =
  | ElementBlock
  | TextBlock
  | IfBlock
  | BranchBlock
  | LoopBlock
  | ComponentBlock
  | SlotBlock
  | SlotFillBlock
  | RawBlock
  | PassthroughBlock
  | PostContentBlock;

export type XbBlockName = XbBlock['name'];

export const XB_BLOCK_NAMES: readonly XbBlockName[] = [
  'xb/element',
  'xb/text',
  'xb/if',
  'xb/branch',
  'xb/loop',
  'xb/component',
  'xb/slot',
  'xb/slot-fill',
  'xb/raw',
  'xb/passthrough',
  'xb/post-content',
];

export function childrenOf(block: XbBlock): XbBlock[] {
  return 'children' in block ? block.children : [];
}

/** Deep copy with every `uid` replaced by '' — for comparisons that ignore identity. */
export function stripUids<T extends XbBlock>(blocks: T[]): T[] {
  return blocks.map((b) => {
    const copy = { ...b, attrs: { ...b.attrs, uid: '' } } as T;
    if ('children' in b) (copy as { children: XbBlock[] }).children = stripUids(b.children);
    return copy;
  });
}

export const DEFAULT_SLOT = 'default';

/** Maximum nesting of blocks, enforced by the parser, parseXb and the printer (the server has its own limits). */
export const MAX_NESTING = 128;

export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Elements whose content is not parsed as markup (stored as one verbatim xb/text). */
export const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea']);

/**
 * Inline formatting tags that are folded into an xb/text run when they carry only these attributes
 * (none of them dynamic). See docs/spec/dsl.md §3.4.
 */
export const INLINE_FORMAT: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    a: ['href', 'target', 'rel'],
    abbr: ['title'],
    b: [],
    br: [],
    code: [],
    em: [],
    i: [],
    kbd: [],
    mark: [],
    q: [],
    s: [],
    small: [],
    span: [],
    strong: [],
    sub: [],
    sup: [],
    time: ['datetime'],
    u: [],
    wbr: [],
  }).map(([tag, attrs]) => [tag, new Set(attrs)]),
);

/** Deep copy with fresh uids (duplicate, paste, insert from snippet). */
export function reuid<T extends XbBlock>(blocks: T[], uid: () => string): T[] {
  return blocks.map((b) => {
    const copy = { ...b, attrs: { ...b.attrs, uid: uid() } } as T;
    if ('children' in b) (copy as { children: XbBlock[] }).children = reuid(b.children, uid);
    return copy;
  });
}
