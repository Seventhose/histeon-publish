// Spacing handles and dragging on the canvas (docs/spec/canvas-handles.md): the pure parts, tested in
// test/handles.test.ts. Values snap to the framework's spacing scale, measured in the page itself.

export type Side = 'padding-top' | 'padding-right' | 'padding-bottom' | 'padding-left' | 'margin-top' | 'margin-bottom';

export const SIDES: Side[] = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom'];

/** How a pointer move changes a side: dragging a padding edge inwards, or a margin edge outwards, grows it. */
export function grow(side: Side, dx: number, dy: number): number {
  switch (side) {
    case 'padding-top':
      return dy;
    case 'padding-bottom':
      return -dy;
    case 'padding-left':
      return dx;
    case 'padding-right':
      return -dx;
    case 'margin-top':
      return -dy;
    case 'margin-bottom':
      return dy;
  }
}

export interface Step {
  label: string;
  value: string;
  px: number;
}

/** The step nearest to `px` (ties: the smaller); without a scale, whole pixels. */
export function snap(px: number, steps: Step[], free = false): Step {
  const clean = Math.max(0, Math.round(px));
  if (free || steps.length === 0) return { label: `${clean}px`, value: clean === 0 ? '0' : `${clean}px`, px: clean };
  let best = steps[0] as Step;
  for (const s of steps) if (Math.abs(s.px - px) < Math.abs(best.px - px)) best = s;
  return best;
}

import type { DropPosition } from './tree.ts';

export type { DropPosition };

/** Where a drop lands on a target box: top quarter before, bottom quarter after, the middle inside when allowed. */
export function dropAt(y: number, top: number, height: number, allowed: (p: DropPosition) => boolean): DropPosition | null {
  const h = height || 1;
  const at = y - top;
  const candidates: DropPosition[] = at < h / 4 ? ['before'] : at > (h * 3) / 4 ? ['after'] : ['inside', at < h / 2 ? 'before' : 'after'];
  return candidates.find(allowed) ?? null;
}
