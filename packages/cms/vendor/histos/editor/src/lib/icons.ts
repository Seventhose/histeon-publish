import type { XbBlock } from '@xb/dsl';
import { svgToBlocks } from './speed.ts';

/**
 * The icon library (E10, docs/spec/icons.md): Lucide (ISC), bundled with the plugin as plugin/assets/icons/lucide.json
 * (scripts/icons-lucide.py). An icon goes into the page as an inline SVG drawn with the text colour: no font of
 * icons, no CDN.
 */
export type IconNodes = Array<[string, Record<string, string>]>;
export interface IconLibrary {
  name: string;
  version: string;
  license: string;
  icons: Record<string, IconNodes>;
}

const TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const ATTRS = new Set(['fill', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points']);
const VALUE = /^[0-9a-zA-Z .,-]*$/;

/** Names that match every word of the query: the exact name first, then those that start with it, then the rest. */
export function searchIcons(names: string[], query: string, limit = 240): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const joined = q.replace(/\s+/g, '-');
  const words = q.split(/[\s-]+/).filter(Boolean);
  const rank = (name: string) => (name === joined ? 0 : name.startsWith(joined) ? 1 : name.includes(joined) ? 2 : 3);
  return names
    .filter((name) => words.every((w) => name.includes(w)))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}

/** The icon as SVG markup; only drawing elements and geometry, anything else is refused. */
export function iconMarkup(name: string, nodes: IconNodes): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`icona non valida: ${name}`);
  const children = nodes
    .map(([tag, attrs]) => {
      if (!TAGS.has(tag)) throw new Error(`icona non valida: ${name}`);
      const list = Object.entries(attrs).map(([key, value]) => {
        if (!ATTRS.has(key) || typeof value !== 'string' || !VALUE.test(value)) throw new Error(`icona non valida: ${name}`);
        return ` ${key}="${value}"`;
      });
      return `<${tag}${list.join('')}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="icon icon--${name}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

/** The icon as page elements, through the same cleaning as a pasted SVG. */
export function iconBlocks(name: string, nodes: IconNodes, uid: () => string): { blocks: XbBlock[]; dropped: string[] } {
  return svgToBlocks(iconMarkup(name, nodes), uid);
}
