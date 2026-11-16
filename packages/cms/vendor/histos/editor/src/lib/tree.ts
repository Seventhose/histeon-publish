import { childrenOf, parse, print, randomUid, refToTag, type LoopSource, type XbBlock } from '@xb/dsl';
import { t } from './i18n.ts';

/** Helpers over the XB tree used by the panels. */

export function findBlock(blocks: XbBlock[], uid: string): XbBlock | null {
  for (const block of blocks) {
    if (block.attrs.uid === uid) return block;
    const inner = findBlock(childrenOf(block), uid);
    if (inner) return inner;
  }
  return null;
}

/**
 * Every block by uid, with its parent: built once per tree, so finding a block or its ancestors does not walk the
 * whole page each time (docs/spec/performance.md, large pages).
 */
export interface TreeIndex {
  block: Map<string, XbBlock>;
  parent: Map<string, XbBlock | null>;
}

export function indexTree(blocks: XbBlock[]): TreeIndex {
  const index: TreeIndex = { block: new Map(), parent: new Map() };
  const visit = (list: XbBlock[], parent: XbBlock | null) => {
    for (const block of list) {
      // The first one wins, as in findBlock (uids are unique; a broken document must not change what is found).
      if (!index.block.has(block.attrs.uid)) {
        index.block.set(block.attrs.uid, block);
        index.parent.set(block.attrs.uid, parent);
      }
      visit(childrenOf(block), block);
    }
  };
  visit(blocks, null);
  return index;
}

/** Uids from the root to `uid` (inclusive), or [] when not found, from an index. */
export function pathIn(index: TreeIndex, uid: string): string[] {
  const path: string[] = [];
  for (let block = index.block.get(uid) ?? null; block; block = index.parent.get(block.attrs.uid) ?? null) path.unshift(block.attrs.uid);
  return path;
}

/** Uids from the root to `uid` (inclusive), or [] when not found. */
export function pathTo(blocks: XbBlock[], uid: string): string[] {
  for (const block of blocks) {
    if (block.attrs.uid === uid) return [uid];
    const inner = pathTo(childrenOf(block), uid);
    if (inner.length > 0) return [block.attrs.uid, ...inner];
  }
  return [];
}

/** Returns a copy of the tree with `fn` applied to the block with `uid`. */
export function updateBlock(blocks: XbBlock[], uid: string, fn: (block: XbBlock) => XbBlock): XbBlock[] {
  // Only the path to the block is copied: the rest stays shared with the old tree (and stays the same list when
  // nothing changed), so an edit on a large page does not copy the page.
  let changed = false;
  const next = blocks.map((block) => {
    if (block.attrs.uid === uid) {
      const updated = fn(block);
      changed ||= updated !== block;
      return updated;
    }
    if ('children' in block) {
      const children = updateBlock(block.children, uid, fn);
      if (children !== block.children) {
        changed = true;
        return { ...block, children } as XbBlock;
      }
    }
    return block;
  });
  return changed ? next : blocks;
}

/** Static class names of an element (dynamic `{…}` parts excluded). */
export function staticClasses(block: XbBlock | null): string[] {
  if (!block || block.name !== 'xb/element') return [];
  const value = block.attrs.attributes?.class;
  if (typeof value !== 'string') return [];
  return value
    .replace(/\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .filter((c) => /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(c));
}

/**
 * Class names written inside the class attribute's expressions, as string literals: `{props.scura ? "card--scura" :
 * ""}` gives `card--scura`. The CSS panel offers them next to the static ones (lista della spesa 157: variants).
 */
export function conditionalClasses(block: XbBlock | null): string[] {
  if (!block || block.name !== 'xb/element') return [];
  const value = block.attrs.attributes?.class;
  if (typeof value !== 'string') return [];
  const out = new Set<string>();
  for (const group of value.match(/\{[^}]*\}/g) ?? []) {
    for (const literal of group.match(/"([^"\\]*)"|'([^'\\]*)'/g) ?? []) {
      for (const name of literal.slice(1, -1).split(/\s+/)) if (/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(name)) out.add(name);
    }
  }
  const fixed = new Set(staticClasses(block));
  return [...out].filter((c) => !fixed.has(c));
}

/** The element's id when it is static (no interpolation) and usable as a CSS selector. */
export function staticId(block: XbBlock | null): string | null {
  if (!block || block.name !== 'xb/element') return null;
  const value = block.attrs.attributes?.id;
  return typeof value === 'string' && /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value) ? value : null;
}

/** Label shown in the structure panel. */
export function describe(block: XbBlock): string {
  switch (block.name) {
    case 'xb/element': {
      if (block.attrs.label) return block.attrs.label;
      const classes = staticClasses(block);
      const id = block.attrs.attributes?.id;
      return block.attrs.tag + (typeof id === 'string' && !id.includes('{') ? `#${id}` : '') + (classes.length ? `.${classes.join('.')}` : '');
    }
    case 'xb/text': {
      const text = block.attrs.content.replace(/<[^>]+>/g, '').trim();
      return text.length > 40 ? `${text.slice(0, 40)}…` : text || t('(testo)');
    }
    case 'xb/if':
      return t('Condizione');
    case 'xb/branch':
      return block.attrs.test !== undefined ? t('se {0}', block.attrs.test) : t('altrimenti');
    case 'xb/loop': {
      const s = block.attrs.source;
      return `loop ${s.kind === 'preset' ? `${s.id}()${s.groupBy ? `.groupBy(${JSON.stringify(s.groupBy.field)})` : ''}` : s.expr} as ${block.attrs.as}`;
    }
    case 'xb/component':
      return block.attrs.label ?? `<${refToTag(block.attrs.ref)}>`;
    case 'xb/slot':
      return `{@slot ${block.attrs.name}}`;
    case 'xb/slot-fill':
      return `slot ${block.attrs.name}`;
    case 'xb/raw':
      return t('HTML grezzo');
    case 'xb/passthrough': {
      const name = /^<!-- wp:([^\s]+)/.exec(block.raw)?.[1] ?? t('blocco');
      return `wp:${name}`;
    }
    case 'xb/post-content':
      return '{@content}';
  }
}

export function iconFor(block: XbBlock): string {
  switch (block.name) {
    case 'xb/element':
      return '<>';
    case 'xb/text':
      return 'T';
    case 'xb/if':
    case 'xb/branch':
      return '?';
    case 'xb/loop':
      return '↻';
    case 'xb/component':
      return '◆';
    case 'xb/slot':
    case 'xb/slot-fill':
      return '▭';
    case 'xb/passthrough':
      return 'W';
    default:
      return '•';
  }
}

// ------------------------------------------------------------------ structural edits (pure)

/** Parent children list and index of `uid`; parent null = root. */
export function locate(blocks: XbBlock[], uid: string, parent: XbBlock | null = null): { parent: XbBlock | null; index: number } | null {
  const index = blocks.findIndex((b) => b.attrs.uid === uid);
  if (index >= 0) return { parent, index };
  for (const block of blocks) {
    const found = locate(childrenOf(block), uid, block);
    if (found) return found;
  }
  return null;
}

function replaceChildren(blocks: XbBlock[], parentUid: string | null, fn: (children: XbBlock[]) => XbBlock[]): XbBlock[] {
  if (parentUid === null) return fn(blocks);
  return updateBlock(blocks, parentUid, (b) => ('children' in b ? ({ ...b, children: fn(b.children) } as XbBlock) : b));
}

/**
 * What to select once `uid` is removed: the next sibling, else the previous one, else the parent (null at the top
 * of an empty page). Deleting element after element then needs no new click.
 */
export function selectionAfterRemoval(blocks: XbBlock[], index: TreeIndex, uid: string): string | null {
  const parent = index.parent.get(uid) ?? null;
  const siblings = parent ? childrenOf(parent) : blocks;
  const at = siblings.findIndex((b) => b.attrs.uid === uid);
  if (at < 0) return null;
  return (siblings[at + 1] ?? siblings[at - 1] ?? parent)?.attrs.uid ?? null;
}

export function removeBlock(blocks: XbBlock[], uid: string): XbBlock[] {
  const at = locate(blocks, uid);
  if (!at) return blocks;
  return replaceChildren(blocks, at.parent?.attrs.uid ?? null, (children) => children.filter((_, i) => i !== at.index));
}

export function insertAfter(blocks: XbBlock[], uid: string, inserted: XbBlock[]): XbBlock[] {
  const at = locate(blocks, uid);
  if (!at) return [...blocks, ...inserted];
  return replaceChildren(blocks, at.parent?.attrs.uid ?? null, (children) => [
    ...children.slice(0, at.index + 1),
    ...inserted,
    ...children.slice(at.index + 1),
  ]);
}

export function moveBlock(blocks: XbBlock[], uid: string, delta: -1 | 1): XbBlock[] {
  const at = locate(blocks, uid);
  if (!at) return blocks;
  return replaceChildren(blocks, at.parent?.attrs.uid ?? null, (children) => {
    const target = at.index + delta;
    if (target < 0 || target >= children.length) return children;
    const copy = [...children];
    const [moved] = copy.splice(at.index, 1);
    if (moved) copy.splice(target, 0, moved);
    return copy;
  });
}

/** Out of its parent, right after it (Alt+←); the same tree when it cannot go there. */
export function outdentBlock(blocks: XbBlock[], uid: string): XbBlock[] {
  const at = locate(blocks, uid);
  return at?.parent ? moveTo(blocks, uid, at.parent.attrs.uid, 'after') : blocks;
}

/** Into the previous sibling, at its end (Alt+→); the same tree when there is no container right before it. */
export function indentBlock(blocks: XbBlock[], uid: string): XbBlock[] {
  const at = locate(blocks, uid);
  if (!at) return blocks;
  const previous = (at.parent ? childrenOf(at.parent) : blocks)[at.index - 1];
  return previous && acceptsChildren(previous) ? moveTo(blocks, uid, previous.attrs.uid, 'inside') : blocks;
}

/** Can `block` take arbitrary children (as opposed to a fixed structure)? */
export function acceptsChildren(block: XbBlock): boolean {
  switch (block.name) {
    case 'xb/element':
      return !VOID.has(block.attrs.tag) && !['script', 'style', 'textarea'].includes(block.attrs.tag);
    case 'xb/branch':
    case 'xb/loop':
    case 'xb/slot-fill':
      return true;
    default:
      return false;
  }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Where an insertion goes relative to the selection; 'auto' is inside a container, otherwise after. */
export type InsertPosition = 'auto' | 'before' | 'after' | 'inside';

/** Where an insertion at `position` really lands: 'inside' only where children are accepted. */
export function insertLanding(target: XbBlock | null, position: InsertPosition): 'end' | 'before' | 'after' | 'inside' {
  if (!target) return 'end';
  if (position === 'before' || position === 'after') return position;
  return acceptsChildren(target) ? 'inside' : 'after';
}

/**
 * Inserts next to the selection: by default inside it (as last child) when it accepts children, otherwise
 * after it; before, after or inside when asked; at the end of the document when nothing is selected.
 */
export function insertAtSelection(blocks: XbBlock[], selected: string | null, inserted: XbBlock[], position: InsertPosition = 'auto'): XbBlock[] {
  const target = selected ? findBlock(blocks, selected) : null;
  if (!target || !selected) return [...blocks, ...inserted];
  if (position === 'before') {
    const at = locate(blocks, selected);
    if (at) return replaceChildren(blocks, at.parent?.attrs.uid ?? null, (children) => [...children.slice(0, at.index), ...inserted, ...children.slice(at.index)]);
  }
  if (position === 'after') return insertAfter(blocks, selected, inserted);
  if (acceptsChildren(target)) {
    return updateBlock(blocks, selected, (b) => ({ ...b, children: [...childrenOf(b), ...inserted] }) as XbBlock);
  }
  return insertAfter(blocks, selected, inserted);
}

// ------------------------------------------------------------------ drag and drop (pure)

export type DropPosition = 'before' | 'after' | 'inside';

/**
 * Where a drop lands on a row, by height: the top quarter before, the bottom quarter after, the middle inside (or
 * the nearer edge when inside is not allowed). In order of preference; the caller keeps the first one allowed.
 */
export function dropCandidates(y: number, height: number): DropPosition[] {
  const h = height || 1;
  return y < h / 4 ? ['before'] : y > (h * 3) / 4 ? ['after'] : ['inside', y < h / 2 ? 'before' : 'after'];
}

function contains(block: XbBlock, uid: string): boolean {
  return childrenOf(block).some((c) => c.attrs.uid === uid || contains(c, uid));
}

/** The parent a drop lands in (null = document root), or undefined when the target does not exist. */
function destination(blocks: XbBlock[], target: string, position: DropPosition): XbBlock | null | undefined {
  if (position === 'inside') return findBlock(blocks, target) ?? undefined;
  const at = locate(blocks, target);
  return at ? at.parent : undefined;
}

/**
 * Whether `uid` may be dropped at `position` of `target`: never into itself, branches only inside an if (the
 * else branch stays last), slot fills only inside a component, everything else only where children are free.
 */
export function canDrop(blocks: XbBlock[], uid: string, target: string, position: DropPosition): boolean {
  if (uid === target) return false;
  const moved = findBlock(blocks, uid);
  if (!moved || contains(moved, target)) return false;
  const parent = destination(blocks, target, position);
  if (parent === undefined) return false;
  if (moved.name === 'xb/branch') {
    // A loop's {:else} stays its loop's last child: it does not move.
    if (locate(blocks, uid)?.parent?.name === 'xb/loop') return false;
    if (parent?.name !== 'xb/if' || parent.attrs.uid !== locate(blocks, uid)?.parent?.attrs.uid) return false;
    const after = moveUnchecked(blocks, uid, target, position);
    const branches = childrenOf(findBlock(after, parent.attrs.uid) as XbBlock);
    return branches.every((b, i) => b.name !== 'xb/branch' || (b.attrs as { test?: string }).test !== undefined || i === branches.length - 1);
  }
  if (moved.name === 'xb/slot-fill') return parent?.name === 'xb/component';
  return parent === null || acceptsChildren(parent);
}

function moveUnchecked(blocks: XbBlock[], uid: string, target: string, position: DropPosition): XbBlock[] {
  const moved = findBlock(blocks, uid);
  if (!moved) return blocks;
  const without = removeBlock(blocks, uid);
  if (position === 'inside') return updateBlock(without, target, (b) => ({ ...b, children: [...childrenOf(b), moved] }) as XbBlock);
  const at = locate(without, target);
  if (!at) return blocks;
  return replaceChildren(without, at.parent?.attrs.uid ?? null, (children) => {
    const copy = [...children];
    copy.splice(position === 'before' ? at.index : at.index + 1, 0, moved);
    return copy;
  });
}

/** Moves `uid` next to or into `target`; the tree is returned unchanged when the move is not allowed. */
export function moveTo(blocks: XbBlock[], uid: string, target: string, position: DropPosition): XbBlock[] {
  return canDrop(blocks, uid, target, position) ? moveUnchecked(blocks, uid, target, position) : blocks;
}

// ------------------------------------------------------------------ HTML panel scope (pure)

/**
 * The node the HTML panel shows for a selection: the element itself; for a text, its parent; for a branch, its
 * if; for a slot fill, its component — the smallest piece that prints and parses back on its own.
 */
export function scopeFor(blocks: XbBlock[] | TreeIndex, uid: string | null): string | null {
  if (!uid) return null;
  const index = Array.isArray(blocks) ? indexTree(blocks) : blocks;
  const block = index.block.get(uid);
  if (!block) return null;
  if (block.name === 'xb/text' || block.name === 'xb/branch' || block.name === 'xb/slot-fill') {
    const parent = index.parent.get(uid) ?? null;
    return parent ? scopeFor(index, parent.attrs.uid) : null;
  }
  return uid;
}

/** Replaces one node with a list (possibly empty, possibly several siblings) in place. */
export function replaceBlock(blocks: XbBlock[], uid: string, replacement: XbBlock[]): XbBlock[] {
  const at = locate(blocks, uid);
  if (!at) return blocks;
  return replaceChildren(blocks, at.parent?.attrs.uid ?? null, (children) => [
    ...children.slice(0, at.index),
    ...replacement,
    ...children.slice(at.index + 1),
  ]);
}

/** Blocks that can become the repeated template of a loop: elements and components (wrap in a loop). */
export function canWrapInLoop(blocks: XbBlock[], uid: string | null): boolean {
  const block = uid ? findBlock(blocks, uid) : null;
  return !!block && (block.name === 'xb/element' || block.name === 'xb/component');
}

/**
 * Wraps a block in a loop over a named query: the block becomes the template repeated for every record, with the
 * record as `as` (item). `count` is passed when the query reads it. Returns the tree unchanged if it cannot wrap.
 */
export function wrapInLoop(blocks: XbBlock[], uid: string, source: LoopSource, as: string, newUid: () => string): XbBlock[] {
  if (!canWrapInLoop(blocks, uid)) return blocks;
  const block = findBlock(blocks, uid) as XbBlock;
  const clean: LoopSource = source.kind === 'preset' && source.args && Object.keys(source.args).length === 0 ? { kind: 'preset', id: source.id } : source;
  const loop: XbBlock = { name: 'xb/loop', attrs: { uid: newUid(), source: clean, as }, children: [block] };
  return replaceBlock(blocks, uid, [loop]);
}

/**
 * Wraps a block in a loop over a query's result in groups (doc 23 of Publish, item 205): the outer loop repeats a title
 * per group, `{gruppo.key}`, and an inner loop over `gruppo.items` repeats the block for each record, as `as`. The
 * source is the query with its `groupBy`, the same `source.groupBy` the code and Gutenberg write.
 */
export function wrapInGroups(blocks: XbBlock[], uid: string, source: LoopSource & { kind: 'preset' }, group: string, as: string, newUid: () => string): XbBlock[] {
  if (!canWrapInLoop(blocks, uid) || !source.groupBy) return blocks;
  const block = findBlock(blocks, uid) as XbBlock;
  const clean: LoopSource = source.args && Object.keys(source.args).length === 0 ? { kind: 'preset', id: source.id, groupBy: source.groupBy } : source;
  const title = parse(`<h2>{${group}.key}</h2>`, { uid: newUid }).blocks;
  const items: XbBlock = { name: 'xb/loop', attrs: { uid: newUid(), source: { kind: 'expr', expr: `${group}.items` }, as }, children: [block] };
  const loop: XbBlock = { name: 'xb/loop', attrs: { uid: newUid(), source: clean, as: group }, children: [...title, items] };
  return replaceBlock(blocks, uid, [loop]);
}

/**
 * Whether a template has the block of the page's content (`{@content}`, «Contenuto del post»), anywhere in it. A
 * template without it does not travel to Histeon Publish: the site's whole reading stops on it (doc 23 of Publish,
 * items 190 and 204; PageProfile::validate wants the default slot in every template).
 */
export function hasPostContent(blocks: XbBlock[]): boolean {
  return blocks.some((block) => block.name === 'xb/post-content' || hasPostContent(childrenOf(block)));
}

/** Wraps a block in a new element (`<div>`, `<section>`, `<a>`…): the block becomes its only child. */
export function wrapBlock(blocks: XbBlock[], uid: string, tag: string, newUid: () => string): XbBlock[] {
  const block = findBlock(blocks, uid);
  if (!block || !/^[a-z][a-z0-9-]*$/.test(tag)) return blocks;
  const wrapper = { name: 'xb/element', attrs: { uid: newUid(), tag }, children: [block] } as XbBlock;
  return replaceBlock(blocks, uid, [wrapper]);
}

/** An element whose children can take its place (unwrap): an element with children. */
export function canUnwrap(block: XbBlock | null): boolean {
  return !!block && block.name === 'xb/element' && childrenOf(block).length > 0;
}

/** Removes an element and keeps its children where it was. */
export function unwrapBlock(blocks: XbBlock[], uid: string): XbBlock[] {
  const block = findBlock(blocks, uid);
  if (!canUnwrap(block)) return blocks;
  return replaceBlock(blocks, uid, childrenOf(block as XbBlock));
}

/** The parent element or component of a node, if any. */
export function parentOf(blocks: XbBlock[], uid: string): string | null {
  return locate(blocks, uid)?.parent?.attrs.uid ?? null;
}

// ------------------------------------------------------------------ content hint (structure rows)

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** A heading tag, or an element whose class says it is a title (`card__title`, `titolo`, `heading`). */
function isHeading(block: XbBlock & { name: 'xb/element' }): boolean {
  const cls = block.attrs.attributes?.class;
  return HEADINGS.has(block.attrs.tag) || (typeof cls === 'string' && /(^|[\s_-])(title|titolo|heading|headline)(\s|$|[_-])/i.test(cls));
}

const HINT_PROPS = ['title', 'heading', 'titolo', 'label', 'text', 'testo', 'name', 'alt'];

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Eacute: 'É', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù', euro: '€', copy: '©', deg: '°', middot: '·',
};

/** Text of a text block as a reader sees it: no tags, entities read, spaces collapsed; expressions stay. */
function plainText(content: string): string {
  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    .replace(/\\([{}])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A few words, cut at a word boundary: what a structure row has room for. */
export function shorten(text: string, max = 28): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** The text inside a block, in reading order, first `limit` nodes at most. */
function textsIn(blocks: XbBlock[], limit = 300): Array<{ text: string; heading: boolean; direct: boolean; alt?: boolean }> {
  const out: Array<{ text: string; heading: boolean; direct: boolean; alt?: boolean }> = [];
  let seen = 0;
  const walk = (list: XbBlock[], inHeading: boolean, depth: number) => {
    for (const b of list) {
      if (++seen > limit) return;
      if (b.name === 'xb/text') {
        const text = plainText(b.attrs.content);
        // Counters, numbers and arrows ("01 / 07", "→") are not what a block is about.
        if (text && (/\{.+\}/.test(text) || (text.match(/\p{L}/gu) ?? []).length >= 3)) out.push({ text, heading: inHeading, direct: depth === 0 });
      } else if (b.name === 'xb/element' && b.attrs.tag === 'img') {
        const alt = b.attrs.attributes?.alt;
        if (typeof alt === 'string' && alt.trim()) out.push({ text: plainText(alt), heading: false, direct: false, alt: true });
      } else if (b.name === 'xb/component') {
        const hint = componentText(b);
        if (hint) out.push({ text: hint, heading: false, direct: false });
      } else if (b.name !== 'xb/raw' && b.name !== 'xb/passthrough' && b.name !== 'xb/slot') {
        walk(childrenOf(b), inHeading || (b.name === 'xb/element' && isHeading(b)), depth + 1);
      }
    }
  };
  walk(blocks, false, 0);
  return out;
}

function componentText(block: XbBlock & { name: 'xb/component' }): string | null {
  const props = (block.attrs.props ?? {}) as Record<string, unknown>;
  for (const name of [...HINT_PROPS, ...Object.keys(props)]) {
    const v = props[name];
    if (typeof v === 'string' && v.trim() && !/^https?:|^\//.test(v.trim())) return plainText(v);
  }
  return null;
}

/**
 * The most important text of a node, short, for its row in the structure: a heading inside it first, then its
 * first real text, an image's alt only when there is nothing else; a component's main text prop. Null when there
 * is none, when it equals the row's label, or when the row is open (its children show their own text).
 */
export function contentHint(block: XbBlock, childrenVisible = false): string | null {
  // An open row has its children right below, and they show their own text: no repetition.
  if (childrenVisible) return null;
  let text: string | null = null;
  if (block.name === 'xb/component') {
    text = componentText(block);
  } else if (block.name === 'xb/element') {
    if (block.attrs.tag === 'img') {
      const alt = block.attrs.attributes?.alt;
      text = typeof alt === 'string' && alt.trim() ? plainText(alt) : null;
    } else if (onlyText(block)) {
      // Words with their bold and line breaks: the whole sentence, not its first piece.
      text = plainText(wordsOf(childrenOf(block))) || null;
    } else {
      const own = isHeading(block);
      const texts = textsIn(childrenOf(block));
      // A heading first, then real text, and an image's alt only when there is nothing else.
      const pick = (own ? texts[0] : texts.find((t) => t.heading)) ?? texts.find((t) => !t.alt) ?? texts[0];
      text = pick?.text ?? null;
    }
  }
  if (!text) return null;
  const label = 'label' in block.attrs ? block.attrs.label : undefined;
  if (label && label.trim().toLowerCase() === text.trim().toLowerCase()) return null;
  return shorten(text);
}

// ------------------------------------------------------------------ readable names (structure rows)

/** What a tag is, in words. */
const TAG_ROLES: Record<string, string> = {
  section: t('Sezione'), header: t('Intestazione'), footer: t('Piè di pagina'), nav: t('Navigazione'), main: t('Contenuto'), article: t('Articolo'),
  aside: t('Barra laterale'), div: t('Contenitore'), span: t('Testo'), p: t('Paragrafo'), a: t('Link'), button: t('Pulsante'), img: t('Immagine'),
  picture: t('Immagine'), figure: t('Figura'), figcaption: t('Didascalia'), ul: t('Elenco'), ol: t('Elenco numerato'), li: t('Voce'), dl: t('Definizioni'),
  form: t('Modulo'), input: t('Campo'), textarea: t('Campo di testo'), select: t('Scelta'), label: t('Etichetta'), svg: t('Icona'), video: t('Video'),
  audio: t('Audio'), iframe: t('Incorporato'), table: t('Tabella'), blockquote: t('Citazione'), time: t('Data'), address: t('Indirizzo'),
  details: t('Apri e chiudi'), summary: t('Titolo apri e chiudi'), dialog: t('Finestra'), hr: t('Separatore'), br: t('A capo'), strong: t('Grassetto'),
  em: t('Corsivo'), small: t('Testo piccolo'), code: t('Codice'), pre: t('Codice'), fieldset: t('Gruppo di campi'), legend: t('Titolo del gruppo'),
};
/** Tags whose own meaning beats a class: an h2 is a heading whatever it is called. */
const SPECIFIC_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'img', 'picture', 'ul', 'ol', 'li', 'form', 'input', 'textarea', 'select', 'label', 'svg', 'video', 'audio', 'iframe', 'table', 'figcaption', 'time', 'hr', 'br']);
/** The usual words of BEM names (English, Italian, short forms), in words. */
const CLASS_WORDS: Record<string, string> = {
  hd: t('Intestazione'), head: t('Intestazione'), header: t('Intestazione'), heading: t('Titolo'), title: t('Titolo'), titolo: t('Titolo'), t: t('Titolo'),
  ttl: t('Titolo'), subtitle: t('Sottotitolo'), sub: t('Sottotitolo'), kicker: t('Occhiello'), eyebrow: t('Occhiello'), k: t('Occhiello'), overline: t('Occhiello'),
  body: t('Corpo'), bd: t('Corpo'), content: t('Contenuto'), inner: t('Contenitore'), wrap: t('Contenitore'), wrapper: t('Contenitore'), container: t('Contenitore'),
  ft: t('Piè'), foot: t('Piè'), footer: t('Piè di pagina'), text: t('Testo'), txt: t('Testo'), x: t('Testo'), excerpt: t('Riassunto'), desc: t('Descrizione'),
  description: t('Descrizione'), lead: t('Introduzione'), intro: t('Introduzione'), img: t('Immagine'), image: t('Immagine'), media: t('Media'), pic: t('Immagine'),
  photo: t('Foto'), thumb: t('Miniatura'), cover: t('Copertina'), icon: t('Icona'), ico: t('Icona'), logo: t('Logo'), btn: t('Pulsante'), button: t('Pulsante'),
  cta: t('Invito all’azione'), link: t('Link'), links: t('Link'), list: t('Elenco'), items: t('Elenco'), item: t('Voce'), grid: t('Griglia'), row: t('Riga'),
  col: t('Colonna'), column: t('Colonna'), cols: t('Colonne'), card: t('Scheda'), tile: t('Scheda'), meta: t('Dati'), date: t('Data'), author: t('Autore'),
  tag: t('Etichetta'), tags: t('Etichette'), badge: t('Etichetta'), label: t('Etichetta'), nav: t('Navigazione'), menu: t('Menu'), search: t('Ricerca'),
  form: t('Modulo'), field: t('Campo'), input: t('Campo'), caption: t('Didascalia'), quote: t('Citazione'), price: t('Prezzo'), avatar: t('Avatar'),
  hero: t('Hero'), banner: t('Banner'), slider: t('Carosello'), slide: t('Diapositiva'), track: t('Binario'), dots: t('Pallini'), arrows: t('Frecce'),
  prev: t('Precedente'), next: t('Successivo'), pager: t('Paginazione'), pagination: t('Paginazione'), main: t('Contenuto'), side: t('Laterale'),
  sidebar: t('Barra laterale'), aside: t('Barra laterale'), section: t('Sezione'), page: t('Pagina'), overlay: t('Sovrapposizione'), bg: t('Sfondo'),
  background: t('Sfondo'), actions: t('Azioni'), action: t('Azione'), social: t('Social'), copy: t('Testo'), more: t('Altro'), count: t('Contatore'),
};

/** The meaningful word of a BEM class: its element (`card__title` → title) or its block without the prefix. */
function classWord(cls: string): string {
  const base = cls.split('--')[0] ?? cls;
  const element = base.includes('__') ? base.slice(base.lastIndexOf('__') + 2) : '';
  const word = element || base.slice(base.lastIndexOf('-') + 1);
  return word.toLowerCase();
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).replace(/[-_]+/g, ' ');

/**
 * A name a person reads at a glance, for a structure row: what the node is ("Titolo H1", "Scheda", "Immagine",
 * "Ripeti per ogni item"). A heading or a link is named by its tag; a generic box by the word of its BEM class.
 * Null when the row already reads well (a label, a text, a component).
 */
export function roleName(block: XbBlock): string | null {
  if (block.name === 'xb/loop') return t('Ripeti per ogni {0}', block.attrs.as);
  if (block.name !== 'xb/element' || block.attrs.label) return null;
  const tag = block.attrs.tag.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return t('Titolo {0}', tag.toUpperCase());
  const tagRole = TAG_ROLES[tag] ?? null;
  if (SPECIFIC_TAGS.has(tag)) return tagRole;
  const cls = staticClasses(block)[0];
  if (!cls) return tagRole ?? tag;
  const word = classWord(cls);
  const known = CLASS_WORDS[word];
  if (known) return known;
  if (word.length < 2 || /^\d+$/.test(word)) return tagRole ?? tag;
  return tag === 'div' || tag === 'span' || !tagRole ? capital(word) : `${tagRole} ${word}`;
}

/** Inline formatting: inside a text it is part of the words, not a part of the page (E4). */
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);

function phrasing(list: XbBlock[]): boolean {
  return list.every((k) => k.name === 'xb/text' || (k.name === 'xb/element' && INLINE.has(k.attrs.tag.toLowerCase()) && phrasing(childrenOf(k))));
}

/** The words of phrasing content as markup, a line break read as a space. */
function wordsOf(list: XbBlock[]): string {
  return list
    .map((k) => (k.name === 'xb/text' ? k.attrs.content : k.name !== 'xb/element' ? '' : k.attrs.tag === 'br' || k.attrs.tag === 'wbr' ? ' ' : wordsOf(childrenOf(k))))
    .join('');
}

/**
 * An element whose content is text, with its inline formatting (bold, italics, links, line breaks): its row stays
 * closed and shows the words on the same line. An imported paragraph reads «Il giusto legge…», not «Paragrafo» over
 * «Testo», «Grassetto», «A capo».
 */
export function onlyText(block: XbBlock): boolean {
  if (block.name !== 'xb/element') return false;
  const kids = childrenOf(block);
  return kids.length > 0 && phrasing(kids) && plainText(wordsOf(kids)) !== '';
}

/** What names a section or a box, unshortened: its first heading, then its aria-label, then its id in words. */
function sectionText(block: XbBlock): string | null {
  if (block.name !== 'xb/element' || block.attrs.label) return null;
  if (VOID.has(block.attrs.tag) || isHeading(block) || onlyText(block)) return null;
  const heading = textsIn(childrenOf(block)).find((t) => t.heading);
  if (heading) return heading.text;
  const aria = block.attrs.attributes?.['aria-label'];
  if (typeof aria === 'string' && aria.trim() && !aria.includes('{')) return plainText(aria);
  const id = staticId(block);
  if (id && (id.match(/[a-z]/gi) ?? []).length >= 3 && !/\d{3}/.test(id)) return capital(id.replace(/^[-_]+/, ''));
  return null;
}

/**
 * The name of a section or a box for its structure row, open or closed (E4): «I giusti» for a section whose first
 * heading says so. Null for a node with a hand-given name, a heading, a text row, or nothing to say.
 */
export function sectionName(block: XbBlock): string | null {
  const text = sectionText(block);
  return text ? shorten(text) : null;
}

/** A step of the path above the canvas (E4): the hand-given name, the section's heading, the words, or the role. */
export function crumbName(block: XbBlock): string {
  const label = 'label' in block.attrs ? block.attrs.label : undefined;
  if (label) return label;
  const section = sectionText(block);
  if (section) return shorten(section, 24);
  if (onlyText(block)) {
    const words = plainText(wordsOf(childrenOf(block)));
    if (words) return shorten(words, 24);
  }
  return roleName(block) ?? describe(block);
}

// ------------------------------------------------------------------ search (structure, E8)

/** What a node is found by: its words, its tag, classes and id, its hand-given name, its role in words. */
function searchable(block: XbBlock): string {
  const parts: string[] = [];
  if (block.name === 'xb/text') parts.push(plainText(block.attrs.content));
  else if (block.name === 'xb/element') {
    parts.push(block.attrs.tag, ...staticClasses(block));
    const id = staticId(block);
    if (id) parts.push(`#${id}`);
    if (block.attrs.label) parts.push(block.attrs.label);
    for (const name of ['alt', 'aria-label', 'title', 'href', 'src']) {
      const value = block.attrs.attributes?.[name];
      if (typeof value === 'string') parts.push(value);
    }
    if (onlyText(block)) parts.push(plainText(wordsOf(childrenOf(block))));
  } else if (block.name === 'xb/component') {
    parts.push(block.attrs.ref, refToTag(block.attrs.ref), block.attrs.label ?? '', componentText(block) ?? '');
  } else {
    parts.push(describe(block));
  }
  const role = roleName(block);
  if (role) parts.push(role);
  return parts.join(' ').toLowerCase();
}

/**
 * The nodes that match a search of the structure, in reading order (E8): every word of the query must be found
 * (text, tag, class, id, name, role). A text inside a paragraph shown on one row is found as that row.
 */
export function searchTree(blocks: XbBlock[], query: string, limit = 500): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: string[] = [];
  const walk = (list: XbBlock[]) => {
    for (const b of list) {
      if (out.length >= limit) return;
      const hay = searchable(b);
      if (words.every((w) => hay.includes(w))) out.push(b.attrs.uid);
      // A paragraph read as one row: its pieces are not rows of their own.
      if (!onlyText(b)) walk(childrenOf(b));
    }
  };
  walk(blocks);
  return out;
}

// ------------------------------------------------------------------ several nodes at once (E7)

/** Uids in reading order. */
export function documentOrder(blocks: XbBlock[]): string[] {
  const out: string[] = [];
  const walk = (list: XbBlock[]) => {
    for (const b of list) {
      out.push(b.attrs.uid);
      walk(childrenOf(b));
    }
  };
  walk(blocks);
  return out;
}

/** The outermost of the given nodes, in reading order: one inside another goes with it. */
export function outermost(index: TreeIndex, uids: string[]): string[] {
  const set = new Set(uids);
  return uids.filter((uid) => !pathIn(index, uid).slice(0, -1).some((up) => set.has(up)));
}

/**
 * Siblings next to each other wrapped together in one new element; null when they are not all children of the
 * same parent, one after the other.
 */
export function wrapSiblings(blocks: XbBlock[], uids: string[], tag: string, newUid: () => string): XbBlock[] | null {
  if (!uids.length || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const places = uids.map((uid) => locate(blocks, uid));
  const parent = places[0]?.parent?.attrs.uid ?? null;
  if (places.some((p) => !p || (p.parent?.attrs.uid ?? null) !== parent)) return null;
  const indices = places.map((p) => p!.index).sort((a, b) => a - b);
  if (indices.some((at, i) => i > 0 && at !== indices[i - 1]! + 1)) return null;
  return replaceChildren(blocks, parent, (children) => {
    const first = indices[0]!;
    const wrapper = { name: 'xb/element', attrs: { uid: newUid(), tag }, children: children.slice(first, first + indices.length) } as XbBlock;
    return [...children.slice(0, first), wrapper, ...children.slice(first + indices.length)];
  });
}

/** What an element is, as the second half of a BEM class (the importer of Histeon Publish uses the same words). */
const CLASS_ROLE: Readonly<Record<string, string>> = { a: 'link', span: 'text', p: 'text', img: 'image', picture: 'image', figure: 'figure', figcaption: 'caption', h1: 'title', h2: 'title', h3: 'title', h4: 'title', h5: 'title', h6: 'title', ul: 'list', ol: 'list', li: 'item', button: 'button', section: 'section', header: 'header', footer: 'footer', nav: 'nav', form: 'form', input: 'field', label: 'label' };

/**
 * A class for an element that has none (docs/progettazione import, doc 18 F5): `<block>__<role>` after the nearest
 * ancestor with a class (its block part), or the role alone; a number when the name is taken in the document.
 */
export function suggestedClass(blocks: XbBlock[], uid: string, inner?: string): string {
  // With `inner`, the class is for a `<inner>` inside `uid` (that is not a block yet): `uid` is its parent.
  const path = pathTo(blocks, uid).map((id) => findBlock(blocks, id));
  const self = path.at(-1);
  const tag = inner ?? (self?.name === 'xb/element' ? self.attrs.tag : 'div');
  const role = CLASS_ROLE[tag] ?? tag.replace(/[^a-z0-9-]/g, '') ?? 'box';
  const owner = (inner ? path : path.slice(0, -1)).reverse().find((block) => block?.name === 'xb/element' && typeof block.attrs.attributes?.class === 'string' && block.attrs.attributes.class.trim() !== '');
  const ownerClass = owner?.name === 'xb/element' ? String(owner.attrs.attributes?.class ?? '').trim().split(/\s+/)[0] ?? '' : '';
  const base = ownerClass ? `${ownerClass.split(/__|--/)[0]}__${role}` : role;
  const taken = new Set<string>();
  const walk = (list: XbBlock[]): void => {
    for (const block of list) {
      if (block.name === 'xb/element' && typeof block.attrs.attributes?.class === 'string') for (const name of block.attrs.attributes.class.split(/\s+/)) taken.add(name);
      walk(childrenOf(block));
    }
  };
  walk(blocks);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}

/**
 * «Rendi elemento» (doc 18 F5): the `index`-th `<tag>` inside the element `uid` (document order, its descendants
 * included, as the canvas counts them) is a piece of a text run (a link, a `span` in a sentence). It gets the class
 * `className`, so the DSL keeps it as an element of its own. The element is printed, changed at that tag, and parsed
 * again, keeping its uid. Null when it holds components, loops or conditions (the canvas order may differ there), or
 * when that tag is not found.
 */
export function promoteInline(blocks: XbBlock[], uid: string, tag: string, index: number, className: string): { blocks: XbBlock[]; uid: string } | null {
  const block = findBlock(blocks, uid);
  if (!block || block.name !== 'xb/element' || !/^[a-z][a-z0-9]*$/.test(tag) || !/^[a-z][a-z0-9_-]*$/.test(className)) return null;
  const dynamic = (list: XbBlock[]): boolean => list.some((b) => b.name !== 'xb/element' && b.name !== 'xb/text' ? true : dynamic(childrenOf(b)));
  if (dynamic(childrenOf(block))) return null;
  const printed = print([block]);
  const pattern = new RegExp(`<${tag}(?=[\\s>/])`, 'g');
  let seen = -1;
  let at = -1;
  for (const match of printed.matchAll(pattern)) {
    // The element itself is the first match when it has the same tag: the canvas counts only what is inside.
    if (match.index === 0) continue;
    if (++seen === index) {
      at = match.index ?? -1;
      break;
    }
  }
  if (at < 0) return null;
  const end = printed.indexOf('>', at);
  const open = printed.slice(at, end + 1);
  if (/\sclass=/.test(open)) return null;
  const changed = `${printed.slice(0, at + tag.length + 1)} class="${className}"${printed.slice(at + tag.length + 1)}`;
  let parsed: XbBlock[];
  try {
    parsed = parse(changed, { uid: randomUid }).blocks;
  } catch {
    return null;
  }
  const replacement = parsed[0];
  if (parsed.length !== 1 || !replacement || replacement.name !== 'xb/element') return null;
  const kept: XbBlock = { ...replacement, attrs: { ...replacement.attrs, uid } };
  const promoted = (function find(list: XbBlock[]): string | null {
    for (const b of list) {
      if (b.name === 'xb/element' && b.attrs.tag === tag && String(b.attrs.attributes?.class ?? '') === className) return b.attrs.uid;
      const inner = find(childrenOf(b));
      if (inner) return inner;
    }
    return null;
  })(childrenOf(kept));
  if (!promoted) return null;
  return { blocks: updateBlock(blocks, uid, () => kept), uid: promoted };
}
