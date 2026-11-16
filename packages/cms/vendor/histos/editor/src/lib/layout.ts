// Where the builder's panels sit: three areas around the canvas, each with its panels in order. Pure functions,
// so moves can be tested and a layout read back from the browser can never break the page.

import { t } from './i18n.ts';

export type PanelId = 'structure' | 'properties' | 'html' | 'css' | 'js' | 'recipes';
export type Area = 'left' | 'right' | 'bottom';

export const PANEL_TITLES: Record<PanelId, string> = {
  structure: t('Struttura'),
  properties: t('Proprietà'),
  html: 'HTML',
  css: 'CSS',
  js: 'JavaScript',
  recipes: t('Ricette'),
};
export const AREA_TITLES: Record<Area, string> = { left: t('a sinistra'), right: t('a destra'), bottom: t('in basso') };
const IDS = Object.keys(PANEL_TITLES) as PanelId[];
const AREAS: Area[] = ['left', 'right', 'bottom'];

export interface Layout {
  areas: Record<Area, PanelId[]>;
  /** Panels reduced to their header. */
  collapsed: PanelId[];
  /** Width of the side areas and height of the bottom one (0 hides the bottom area). */
  sizes: Record<Area, number>;
  /** Share of its area each panel takes (1 when absent): moved by the separators between panels. */
  weights: Partial<Record<PanelId, number>>;
  /** The panel shown alone in its area, kept across visits. */
  maximized: PanelId | null;
}

export const DEFAULT_LAYOUT: Layout = {
  areas: { left: [], right: ['structure', 'properties', 'recipes'], bottom: ['html', 'css', 'js'] },
  collapsed: ['recipes'],
  sizes: { left: 280, right: 300, bottom: 300 },
  weights: {},
  maximized: null,
};

/** A panel's share stays within these, so none can be squeezed to nothing. */
const WEIGHT: [number, number] = [0.15, 8];

const LIMITS: Record<Area, [number, number]> = { left: [200, 640], right: [220, 640], bottom: [0, 2000] };

/** Smallest and largest size of an area (the bottom one's 0 hides it). */
export function sizeLimits(area: Area): [number, number] {
  return LIMITS[area];
}

export function clampSize(area: Area, value: number): number {
  const [min, max] = LIMITS[area];
  if (!Number.isFinite(value)) return DEFAULT_LAYOUT.sizes[area];
  return Math.round(area === 'bottom' && value < 60 ? 0 : Math.min(max, Math.max(min, value)));
}

/** Any stored value → a valid layout: every panel exactly once, unknown ones dropped, sizes within limits. */
export function normalize(raw: unknown): Layout {
  const value = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof Layout, unknown>>) : {};
  const areasIn = value.areas && typeof value.areas === 'object' ? (value.areas as Record<string, unknown>) : {};
  const seen = new Set<PanelId>();
  const areas: Record<Area, PanelId[]> = { left: [], right: [], bottom: [] };
  for (const area of AREAS) {
    const list = Array.isArray(areasIn[area]) ? (areasIn[area] as unknown[]) : [];
    for (const id of list) {
      if (typeof id === 'string' && (IDS as string[]).includes(id) && !seen.has(id as PanelId)) {
        seen.add(id as PanelId);
        areas[area].push(id as PanelId);
      }
    }
  }
  // A panel the stored layout does not have (one added since, like the recipes) comes as it is by default.
  const added = IDS.filter((id) => !seen.has(id));
  for (const area of AREAS) for (const id of DEFAULT_LAYOUT.areas[area]) if (!seen.has(id)) areas[area].push(id);
  const collapsed = [...(Array.isArray(value.collapsed) ? IDS.filter((id) => (value.collapsed as unknown[]).includes(id)) : []), ...added.filter((id) => DEFAULT_LAYOUT.collapsed.includes(id))];
  const sizesIn = value.sizes && typeof value.sizes === 'object' ? (value.sizes as Record<string, unknown>) : {};
  const sizes = { left: 0, right: 0, bottom: 0 };
  for (const area of AREAS) sizes[area] = clampSize(area, typeof sizesIn[area] === 'number' ? (sizesIn[area] as number) : DEFAULT_LAYOUT.sizes[area]);
  const weightsIn = value.weights && typeof value.weights === 'object' ? (value.weights as Record<string, unknown>) : {};
  const weights: Partial<Record<PanelId, number>> = {};
  for (const id of IDS) {
    const w = weightsIn[id];
    if (typeof w === 'number' && Number.isFinite(w)) weights[id] = Math.min(WEIGHT[1], Math.max(WEIGHT[0], w));
  }
  const maximized = typeof value.maximized === 'string' && (IDS as string[]).includes(value.maximized) ? (value.maximized as PanelId) : null;
  return { areas, collapsed, sizes, weights, maximized };
}

/**
 * The separator between panels `a` and `b` of one area moved: `a` now measures `aPx` of the `totalPx` they share.
 * Their weights split the same total in that proportion; neither goes below a fifth of the shared space's floor.
 */
export function shareBetween(layout: Layout, a: PanelId, b: PanelId, aPx: number, totalPx: number, minPx = 80): Layout {
  if (totalPx <= 0) return layout;
  const sum = (layout.weights[a] ?? 1) + (layout.weights[b] ?? 1);
  const px = Math.min(totalPx - minPx, Math.max(minPx, aPx));
  const wa = Math.min(WEIGHT[1], Math.max(WEIGHT[0], (sum * px) / totalPx));
  const wb = Math.min(WEIGHT[1], Math.max(WEIGHT[0], sum - wa));
  return { ...layout, weights: { ...layout.weights, [a]: Math.round(wa * 1000) / 1000, [b]: Math.round(wb * 1000) / 1000 } };
}

export function areaOf(layout: Layout, id: PanelId): Area {
  return AREAS.find((area) => layout.areas[area].includes(id)) ?? 'right';
}

/** Moves a panel to `area` at `index` (clamped; the index counts the area's panels without the moved one). */
export function movePanel(layout: Layout, id: PanelId, area: Area, index: number): Layout {
  const areas = { left: [...layout.areas.left], right: [...layout.areas.right], bottom: [...layout.areas.bottom] };
  for (const a of AREAS) areas[a] = areas[a].filter((p) => p !== id);
  const at = Math.max(0, Math.min(areas[area].length, Math.round(index)));
  areas[area].splice(at, 0, id);
  const sizes = { ...layout.sizes };
  if (area === 'bottom' && sizes.bottom === 0) sizes.bottom = DEFAULT_LAYOUT.sizes.bottom;
  return { ...layout, areas, sizes };
}

/** One step earlier (-1) or later (+1) in its own area. */
export function shiftPanel(layout: Layout, id: PanelId, delta: -1 | 1): Layout {
  const area = areaOf(layout, id);
  return movePanel(layout, id, area, layout.areas[area].indexOf(id) + delta);
}

export function toggleCollapsed(layout: Layout, id: PanelId): Layout {
  const collapsed = layout.collapsed.includes(id) ? layout.collapsed.filter((p) => p !== id) : [...layout.collapsed, id];
  return { ...layout, collapsed };
}

export function resize(layout: Layout, area: Area, value: number): Layout {
  return { ...layout, sizes: { ...layout.sizes, [area]: clampSize(area, value) } };
}
