// Copy and paste between XB sites (docs/spec/quick-actions.md §5): an element travels with the styles of the
// classes it uses; on paste, classes that would clash with this site's are kept or renamed, and renamed
// everywhere they appear (elements and selectors).
import { keyClass, parse, parseXb, serializeXb, statements, type XbBlock } from '@xb/dsl';
import { t } from './i18n.ts';
import { stripHandlers } from './speed.ts';

export interface ClipStyle {
  selector: string;
  css: string;
}

export interface Clip {
  xb: 'clip';
  version: 1;
  origin: string;
  markup: string;
  styles: ClipStyle[];
}

const MAX_CLIP = 2_000_000;

/** Static classes of a block tree (expressions in a class attribute are skipped). */
export function classesOf(blocks: XbBlock[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: XbBlock[]) => {
    for (const b of list) {
      if (b.name === 'xb/element') {
        const cls = b.attrs.attributes?.class;
        if (typeof cls === 'string') for (const c of cls.split(/\s+/)) if (c && !c.includes('{') && !c.includes('}')) out.add(c);
      }
      if ('children' in b) walk(b.children as XbBlock[]);
    }
  };
  walk(blocks);
  return out;
}

/** The clip of a selection: its markup and the style entries keyed by the classes it uses. */
export function makeClip(blocks: XbBlock[], styles: ClipStyle[], origin: string): Clip {
  const used = classesOf(blocks);
  return {
    xb: 'clip',
    version: 1,
    origin,
    markup: serializeXb(blocks),
    styles: styles.filter((s) => {
      const key = keyClass(s.selector);
      return key !== null && used.has(key);
    }).map((s) => ({ selector: s.selector, css: s.css })),
  };
}

/** A clip read from the clipboard, checked (shape, sizes, selectors); null when the text is not one. */
export function readClip(text: string): Clip | null {
  if (text.length > MAX_CLIP || !text.trimStart().startsWith('{')) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const d = data as Partial<Clip>;
  if (d?.xb !== 'clip' || d.version !== 1 || typeof d.markup !== 'string' || !Array.isArray(d.styles)) return null;
  const styles = d.styles.filter((s): s is ClipStyle => !!s && typeof s.selector === 'string' && typeof s.css === 'string' && s.selector.length < 500 && !/[{}<;]/.test(s.selector));
  return { xb: 'clip', version: 1, origin: typeof d.origin === 'string' ? d.origin.slice(0, 200) : '', markup: d.markup, styles };
}

export type ClassFate = 'new' | 'same' | 'conflict';

/** What happens to each class of a clip on this site. */
export function planClasses(clip: Clip, site: ClipStyle[], siteSheetClasses: Set<string>): Array<{ name: string; fate: ClassFate }> {
  const byKey = new Map<string, string>();
  for (const s of site) {
    const key = keyClass(s.selector);
    if (key) byKey.set(key, (byKey.get(key) ?? '') + s.css);
  }
  const incoming = new Map<string, string>();
  for (const s of clip.styles) {
    const key = keyClass(s.selector);
    if (key) incoming.set(key, (incoming.get(key) ?? '') + s.css);
  }
  return [...incoming.entries()].map(([name, css]) => {
    const mine = byKey.get(name);
    if (mine === undefined && !siteSheetClasses.has(name)) return { name, fate: 'new' as const };
    return { name, fate: mine !== undefined && normalize(mine) === normalize(css) ? ('same' as const) : ('conflict' as const) };
  });
}

/** CSS compared as declarations, whatever the spacing: `padding: 1rem;` equals `padding:1rem`. */
const normalize = (css: string): string =>
  statements(css)
    .map(([p, b]) => `${p.replace(/\s+/g, ' ').replace(/\s*([:,>+~])\s*/g, '$1').trim()}${b === null ? '' : `{${normalize(b)}}`}`)
    .join(';');

/** A name not used here yet: card → card-2, card-3… */
export function freeName(name: string, taken: Set<string>): string {
  for (let i = 2; ; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
}

/**
 * A class under a renamed block: the block itself, or one of its BEM parts (`card__title`, `card--dark`), which the
 * block's nested CSS (`&__title`) styles under the new name. Anything else stays as it is.
 */
function renamed(name: string, map: Map<string, string>): string | undefined {
  const whole = map.get(name);
  if (whole !== undefined) return whole;
  const m = /^(.+?)(__|--)(.*)$/.exec(name);
  if (!m) return undefined;
  const block = map.get(m[1]!);
  return block === undefined ? undefined : `${block}${m[2]}${m[3]}`;
}

/** Renames classes in elements (static tokens only) and in selectors (whole class names and their BEM parts). */
export function renameClasses(blocks: XbBlock[], map: Map<string, string>): XbBlock[] {
  if (!map.size) return blocks;
  return blocks.map((b) => {
    let next = b;
    if (b.name === 'xb/element' && typeof b.attrs.attributes?.class === 'string') {
      const cls = b.attrs.attributes.class.split(/(\s+)/).map((t) => renamed(t, map) ?? t).join('');
      next = { ...b, attrs: { ...b.attrs, attributes: { ...b.attrs.attributes, class: cls } } };
    }
    if ('children' in next) next = { ...next, children: renameClasses(next.children as XbBlock[], map) } as XbBlock;
    return next;
  });
}

export function renameSelector(selector: string, map: Map<string, string>): string {
  return selector.replace(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g, (m, name: string) => {
    const next = renamed(name, map);
    return next === undefined ? m : `.${next}`;
  });
}

/** The clip's blocks, parsed; markup issues are returned to report. */
export function clipBlocks(clip: Clip): { blocks: XbBlock[]; issues: string[] } {
  return parseXb(clip.markup);
}

/** Elements never taken from pasted HTML: they run code, load documents or change how the page works. */
const DROP = 'script, style, link, meta, base, iframe, frame, frameset, object, embed, applet, noscript, template, form';

/**
 * HTML copied from another site or tool, as builder elements: event handlers removed before parsing (see
 * svgToBlocks), active elements dropped, `javascript:` and `data:` addresses removed, braces escaped so nothing
 * becomes an expression. Classes stay: they are what the paste dialog remaps. Browser only.
 */
export function htmlToBlocks(html: string, uid: () => string): { blocks: XbBlock[]; dropped: number } {
  if (html.length > MAX_CLIP) throw new Error(t('Testo troppo lungo da incollare.'));
  const doc = new DOMParser().parseFromString(stripHandlers(html), 'text/html');
  let dropped = 0;
  doc.body.querySelectorAll(DROP).forEach((el) => {
    el.remove();
    dropped++;
  });
  const esc = (v: string) => v.replace(/[{}]/g, (c) => `\\${c}`);
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name.startsWith('xb:') || !/^[a-z_:][a-z0-9_.:-]*$/.test(name)) {
        el.removeAttribute(attr.name);
        dropped++;
      } else if (['href', 'src', 'action', 'formaction', 'xlink:href', 'poster'].includes(name) && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
        dropped++;
      } else if (/[{}]/.test(attr.value)) {
        el.setAttribute(attr.name, esc(attr.value));
      }
    }
  });
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue && /[{}]/.test(n.nodeValue)) n.nodeValue = esc(n.nodeValue);
  return { blocks: parse(doc.body.innerHTML.trim(), { uid }).blocks, dropped };
}

/** Component refs used by blocks, to warn about the ones this site lacks. */
export function componentRefs(blocks: XbBlock[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: XbBlock[]) => {
    for (const b of list) {
      if (b.name === 'xb/component') out.add(b.attrs.ref);
      if ('children' in b) walk(b.children as XbBlock[]);
    }
  };
  walk(blocks);
  return out;
}
