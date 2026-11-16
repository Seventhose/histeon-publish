import { childrenOf, type XbBlock } from '@xb/dsl';
import { onlyText } from './tree.ts';
import { childBase } from './speed.ts';

/**
 * The structure tree as the rows it shows, in order: only the children of open nodes. The panel draws from this
 * list, and on a large page only the rows in view (docs/spec/performance.md, large pages).
 */
export interface Row {
  block: XbBlock;
  /** The uid, unique in the list even in a document with repeated uids. */
  key: string;
  depth: number;
  /** The BEM base its automatic label reads from (speed.ts). */
  base: string | null;
  expandable: boolean;
  expanded: boolean;
  /** Index of the parent row, -1 at the top. */
  parent: number;
  /** Position among its siblings (1-based) and their number, for assistive technology (aria-posinset, aria-setsize). */
  position: number;
  siblings: number;
}

/** Open at first: the first two levels, except a heading or a paragraph with only text (its text reads on the row). */
export function openByDefault(block: XbBlock, depth: number): boolean {
  return depth < 2 && !onlyText(block);
}

export function visibleRows(tree: XbBlock[], isOpen: (block: XbBlock, depth: number) => boolean): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const visit = (list: XbBlock[], depth: number, base: string | null, parent: number) => {
    list.forEach((block, i) => {
      const children = childrenOf(block);
      const expandable = children.length > 0;
      const expanded = expandable && isOpen(block, depth);
      const uid = block.attrs.uid;
      const key = seen.has(uid) ? `${uid}#${rows.length}` : uid;
      seen.add(uid);
      rows.push({ block, key, depth, base, expandable, expanded, parent, position: i + 1, siblings: list.length });
      if (expanded) visit(children, depth + 1, childBase(block, base), rows.length - 1);
    });
  };
  visit(tree, 0, null, -1);
  return rows;
}

/** Which rows to draw: all of them on a normal page; past `limit`, those in view plus a margin. */
export function rowWindow(count: number, scrollTop: number, height: number, rowHeight: number, limit = 300, margin = 20): [number, number] {
  if (count <= limit) return [0, count];
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - margin);
  const shown = Math.ceil((height || 40 * rowHeight) / rowHeight) + 2 * margin;
  return [first, Math.min(count, first + shown)];
}
