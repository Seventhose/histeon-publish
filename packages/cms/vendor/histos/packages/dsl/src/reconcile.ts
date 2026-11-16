import { childrenOf, type XbBlock } from './tree.ts';

/**
 * Keeps node identity across edits of the HTML panel — docs/spec/dsl.md §1.
 *
 * The DSL does not carry uids, so every re-parse produces fresh ones. reconcileUids() copies uids from the
 * previous tree onto the nodes that are "the same" in the new one: siblings are aligned with a longest common
 * subsequence on a structural signature (block type + tag / component ref / slot name), recursively.
 * Stable uids are what the sanitizer, the versioning merge and the selection in the canvas rely on.
 */
export function reconcileUids(previous: XbBlock[], next: XbBlock[]): XbBlock[] {
  return matchLists(previous, next);
}

function signature(block: XbBlock): string {
  switch (block.name) {
    case 'xb/element':
      return `element:${block.attrs.tag}`;
    case 'xb/component':
      return `component:${block.attrs.ref}`;
    case 'xb/slot':
    case 'xb/slot-fill':
      return `${block.name}:${block.attrs.name}`;
    default:
      return block.name;
  }
}

function matchLists(previous: XbBlock[], next: XbBlock[]): XbBlock[] {
  const matches = lcs(previous.map(signature), next.map(signature));
  return next.map((block, j) => {
    const i = matches.get(j);
    const old = i === undefined ? undefined : previous[i];
    return old ? adopt(block, old) : block;
  });
}

function adopt(block: XbBlock, old: XbBlock): XbBlock {
  const copy = { ...block, attrs: { ...block.attrs, uid: old.attrs.uid } } as XbBlock;
  if ('children' in block) {
    (copy as { children: XbBlock[] }).children = matchLists(childrenOf(old), block.children);
  }
  return copy;
}

/** Index pairs (next → previous) of a longest common subsequence. */
function lcs(a: string[], b: string[]): Map<number, number> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const pairs = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.set(j, i);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
