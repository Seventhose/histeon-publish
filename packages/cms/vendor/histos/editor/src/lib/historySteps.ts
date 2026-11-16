// The undo history in words (docs/spec/history-panel.md): each step is named by comparing the state before it with
// the state after, so no edit has to describe itself. Pure, tested in test/historySteps.test.ts.
import { childrenOf, type XbBlock } from '@xb/dsl';
import type { GlobalSheet, StyleEntry } from './api.ts';
import { t } from './i18n.ts';
import { describe } from './tree.ts';

export interface StepState {
  tree: XbBlock[];
  styles: StyleEntry[];
  globals: GlobalSheet[];
  /** The page's own look (voce 186). */
  pageStyles?: Array<{ selector: string; css: string }>;
}

interface Flat {
  block: XbBlock;
  parent: string | null;
  index: number;
  /** The block's own data, without its children. */
  own: string;
}

function flatten(blocks: XbBlock[], parent: string | null = null, out = new Map<string, Flat>()): Map<string, Flat> {
  blocks.forEach((block, index) => {
    const { attrs } = block;
    out.set(attrs.uid, { block, parent, index, own: JSON.stringify({ name: block.name, attrs, raw: 'raw' in block ? block.raw : undefined }) });
    flatten(childrenOf(block), attrs.uid, out);
  });
  return out;
}

const list = (names: string[]) => (names.length <= 2 ? names.join(', ') : t('{0} e altri {1}', names.slice(0, 2).join(', '), names.length - 2));

/** What changed from `before` to `after`, in a few words. */
export function describeStep(before: StepState, after: StepState): string {
  const parts: string[] = [];
  const a = flatten(before.tree);
  const b = flatten(after.tree);
  const added = [...b.keys()].filter((uid) => !a.has(uid));
  const removed = [...a.keys()].filter((uid) => !b.has(uid));
  // Only the outermost of what came or went: a section added with its contents is one thing.
  const top = (uids: string[], map: Map<string, Flat>) => uids.filter((uid) => !uids.includes(map.get(uid)?.parent ?? ''));
  const addedTop = top(added, b);
  const removedTop = top(removed, a);
  if (addedTop.length) parts.push(t('Aggiunto {0}', list(addedTop.map((u) => describe(b.get(u)!.block)))));
  if (removedTop.length) parts.push(t('Eliminato {0}', list(removedTop.map((u) => describe(a.get(u)!.block)))));
  const moved: string[] = [];
  const changed: string[] = [];
  const texts: string[] = [];
  for (const [uid, now] of b) {
    const was = a.get(uid);
    if (!was) continue;
    if (was.parent !== now.parent) moved.push(describe(now.block));
    if (was.own !== now.own) (now.block.name === 'xb/text' ? texts : changed).push(describe(now.block));
  }
  if (moved.length) parts.push(t('Spostato {0}', list(moved)));
  else if (!addedTop.length && !removedTop.length) {
    // Same blocks, same parents: a different order among siblings is a move too.
    const order = (m: Map<string, Flat>) => [...m.values()].map((f) => `${f.parent}:${f.block.attrs.uid}`).join('|');
    if (order(a) !== order(b)) parts.push(t('Spostato un elemento'));
  }
  if (texts.length) parts.push(t('Testo «{0}»', list(texts)));
  if (changed.length) parts.push(t('Modificato {0}', list(changed)));

  const css = (styles: Array<{ selector: string; css: string }>) => new Map(styles.map((s) => [s.selector, s.css]));
  const sa = css(before.styles);
  const sb = css(after.styles);
  const selectors = [...new Set([...sa.keys(), ...sb.keys()])].filter((sel) => sa.get(sel) !== sb.get(sel));
  if (selectors.length) parts.push(t('CSS di {0}', list(selectors)));
  const ga = new Map(before.globals.map((g) => [g.id, g.css]));
  const gb = new Map(after.globals.map((g) => [g.id, g.css]));
  const sheets = [...new Set([...ga.keys(), ...gb.keys()])].filter((id) => ga.get(id) !== gb.get(id));
  if (sheets.length) parts.push(sheets.length === 1 ? t('Foglio {0}', sheets[0]!) : t('Fogli {0}', list(sheets)));
  const pa = css(before.pageStyles ?? []);
  const pb = css(after.pageStyles ?? []);
  const own = [...new Set([...pa.keys(), ...pb.keys()])].filter((sel) => pa.get(sel) !== pb.get(sel));
  if (own.length) parts.push(t('Aspetto di {0} su questa pagina', list(own)));
  return parts.length ? parts.join(' · ') : t('Nessuna modifica visibile');
}
