// Pasting a clip (docs/spec/quick-actions.md §5), shared by the paste dialog and the public API's paste(): the clip
// restricted by the server unless this tab copied it, its classes planned against this site's, and the insertion
// with the classes kept or renamed as chosen.
import { keyClass, randomUid, reuid, type XbBlock } from '@xb/dsl';
import { classesOf, clipBlocks, componentRefs, freeName, planClasses, renameClasses, renameSelector, type Clip, type ClassFate } from './clip.ts';
import { rulesFor } from './sheet.ts';
import { restrictClip } from './pasteTrust.ts';
import type { BuilderState } from './state.svelte.ts';

export interface PreparedPaste {
  clip: Clip;
  blocks: XbBlock[];
  plan: Array<{ name: string; fate: ClassFate }>;
  /** Components the clip uses that this site does not have: they stay empty. */
  missing: string[];
}

export type ClassChoice = 'keep' | 'rename';

/** The clip ready to insert. @param trusted Only for what this tab copied itself: anything else goes to the server first. */
export async function preparePaste(app: BuilderState, incoming: Clip, trusted = false): Promise<PreparedPaste> {
  const clip = trusted ? incoming : await restrictClip(app.api, incoming);
  const blocks = reuid(clipBlocks(clip).blocks, randomUid);
  const sheetClasses = new Set<string>();
  for (const g of app.globals) for (const c of classesOf(blocks)) if (rulesFor(g.css, c).length) sheetClasses.add(c);
  const known = new Set(app.components.map((c) => c.ref));
  return {
    clip,
    blocks,
    plan: planClasses(clip, app.styles, sheetClasses),
    missing: [...componentRefs(blocks)].filter((r) => !known.has(r)),
  };
}

/**
 * Inserts the prepared clip after or inside the selection, like the + menu. A class in conflict is renamed unless
 * `choice` keeps this site's; new and renamed classes bring their styles. Returns the uids inserted and the renames.
 */
export function applyPaste(app: BuilderState, prepared: PreparedPaste, choice: Record<string, ClassChoice> = {}): { uids: string[]; renames: Map<string, string> } {
  const { clip, blocks, plan } = prepared;
  const taken = new Set([...classesOf(app.tree), ...app.styles.map((s) => s.selector.replace(/^\./, ''))]);
  const map = new Map<string, string>();
  for (const p of plan) {
    if (p.fate === 'conflict' && (choice[p.name] ?? 'rename') === 'rename') {
      const fresh = freeName(p.name, taken);
      taken.add(fresh);
      map.set(p.name, fresh);
    }
  }
  for (const s of clip.styles) {
    // The selector's own class, as planClasses keyed it: `.card-2` and `.card__title` are not `.card`.
    const key = keyClass(s.selector);
    const fate = plan.find((p) => p.name === key)?.fate;
    const renamed = renameSelector(s.selector, map);
    // New classes and renamed ones bring their styles; identical or kept ones use this site's.
    if (fate === 'new' || renamed !== s.selector) app.upsertStyle(renamed, s.css);
  }
  const inserted = renameClasses(blocks, map);
  app.insert(inserted);
  return { uids: inserted.map((b) => b.attrs.uid), renames: map };
}
