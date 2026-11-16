import { childrenOf, type XbBlock } from '@xb/dsl';

/**
 * Edits made while a save is in flight, put on top of what the server stored.
 *
 * A save sends `sent`; the server stores `stored`, which may differ (content filtered for the user's permissions,
 * style entries normalised). Meanwhile the user may have changed `local`. The result keeps every local change
 * and takes the server's version of everything the user did not touch since `sent`: what the server dropped
 * stays dropped, instead of coming back with the next save or hiding until then.
 */

/** Style entries and global sheets, by id: an entry changed locally wins, an untouched one becomes the stored one. */
export function rebaseEntries<T extends { id: string }>(local: readonly T[], sent: readonly T[], stored: readonly T[]): T[] {
  const json = (entry: T | undefined) => (entry === undefined ? '' : JSON.stringify(entry));
  const localById = new Map(local.map((e) => [e.id, e]));
  const sentById = new Map(sent.map((e) => [e.id, e]));
  const untouched = (id: string) => json(localById.get(id)) === json(sentById.get(id));
  // The server's order for what it has, then what only the user has (added during the save).
  const out: T[] = [];
  for (const entry of stored) {
    if (untouched(entry.id)) out.push(entry);
    else if (localById.has(entry.id)) out.push(localById.get(entry.id) as T);
  }
  // Not stored: new during the save (kept), or dropped by the server and untouched since (dropped).
  const storedIds = new Set(stored.map((e) => e.id));
  for (const entry of local) if (!storedIds.has(entry.id) && !untouched(entry.id)) out.push(entry);
  return out;
}

/** A node without its children: what the sanitizer judges and changes, one block at a time. */
function own(block: XbBlock): string {
  const { children: _children, ...rest } = block as XbBlock & { children?: unknown };
  return JSON.stringify(rest);
}

function byUid(blocks: readonly XbBlock[], into = new Map<string, XbBlock>()): Map<string, XbBlock> {
  for (const block of blocks) {
    if (block.attrs.uid !== '' && !into.has(block.attrs.uid)) into.set(block.attrs.uid, block);
    byUid(childrenOf(block), into);
  }
  return into;
}

/**
 * The tree, node by node (uid): a node the user did not change since `sent` takes the stored version of itself
 * (filtered attributes), and goes with what is inside it if the server removed it and nothing in it changed;
 * changed and new nodes stay as the user has them.
 * Returns `local` itself when nothing changes.
 */
export function rebaseTree(local: XbBlock[], sent: readonly XbBlock[], stored: readonly XbBlock[]): XbBlock[] {
  const sentByUid = byUid(sent);
  const storedByUid = byUid(stored);
  const walk = (blocks: XbBlock[]): XbBlock[] => {
    let changed = false;
    const out: XbBlock[] = [];
    for (const block of blocks) {
      const uid = block.attrs.uid;
      const before = sentByUid.get(uid);
      const after = storedByUid.get(uid);
      const untouched = before !== undefined && own(before) === own(block);
      // Removed by the server: gone too, unless the user changed something in it since.
      if (after === undefined && before !== undefined && JSON.stringify(before) === JSON.stringify(block)) {
        changed = true;
        continue;
      }
      const base = untouched && after !== undefined && own(after) !== own(block) ? after : block;
      const children = 'children' in block ? walk(block.children) : null;
      if (base === block && (children === null || children === (block as { children: XbBlock[] }).children)) {
        out.push(block);
        continue;
      }
      changed = true;
      out.push((children !== null && 'children' in base ? { ...base, children } : base) as XbBlock);
    }
    return changed ? out : blocks;
  };
  return walk(local);
}
