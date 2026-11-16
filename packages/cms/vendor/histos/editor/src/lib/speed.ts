// Quick actions of the builder, for working faster: a component from the selection,
// SVG code turned into elements, BEM class names for a block's children.
import { childrenOf, findClosingBrace, loopElse, parseExpression, type ElementBlock, type Expr, type XbBlock } from '@xb/dsl';
import { t } from './i18n.ts';

/** Roots every component sees (plugin/src/Render/Context.php GLOBAL_ROOTS). */
export const GLOBAL_ROOTS = ['this', 'site', 'user', 'url', 'data', 'facets'];

// ------------------------------------------------------------------ free variables

/** The `{…}` expressions of a text or attribute value (escaped braces are text). */
export function interpolations(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '\\' && (value.charAt(i + 1) === '{' || value.charAt(i + 1) === '}')) {
      i++;
      continue;
    }
    if (c === '{') {
      const close = findClosingBrace(value, i);
      out.push(value.slice(i + 1, close));
      i = close;
    }
  }
  return out;
}

function rootsOf(expr: Expr, out: Set<string>): void {
  switch (expr.type) {
    case 'Identifier':
      out.add(expr.name);
      break;
    case 'Member':
      rootsOf(expr.object, out);
      break;
    case 'Index':
      rootsOf(expr.object, out);
      rootsOf(expr.index, out);
      break;
    case 'Call':
      rootsOf(expr.callee, out);
      for (const a of expr.args) rootsOf(a.value, out);
      break;
    case 'Unary':
      rootsOf(expr.argument, out);
      break;
    case 'Binary':
      rootsOf(expr.left, out);
      rootsOf(expr.right, out);
      break;
    case 'Conditional':
      rootsOf(expr.test, out);
      rootsOf(expr.consequent, out);
      rootsOf(expr.alternate, out);
      break;
    case 'Array':
      for (const e of expr.elements) rootsOf(e, out);
      break;
    case 'Object':
      for (const p of expr.properties) rootsOf(p.value, out);
      break;
    default:
      break;
  }
}

function rootsOfSource(source: string, out: Set<string>): void {
  try {
    rootsOf(parseExpression(source), out);
  } catch {
    // An expression that does not parse is reported by the HTML panel; it adds no root here.
  }
}

/** Names a subtree reads that it does not define itself (loop variables are defined for their children). */
export function freeRoots(blocks: XbBlock[], bound: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const use = (names: Set<string>) => names.forEach((n) => !bound.has(n) && out.add(n));
  for (const block of blocks) {
    const found = new Set<string>();
    switch (block.name) {
      case 'xb/text':
        if (!block.attrs.verbatim) interpolations(block.attrs.content).forEach((e) => rootsOfSource(e, found));
        break;
      case 'xb/element':
        for (const value of Object.values(block.attrs.attributes ?? {})) if (typeof value === 'string') interpolations(value).forEach((e) => rootsOfSource(e, found));
        break;
      case 'xb/branch':
        if (block.attrs.test) rootsOfSource(block.attrs.test, found);
        break;
      case 'xb/loop':
        if (block.attrs.source.kind === 'expr') rootsOfSource(block.attrs.source.expr, found);
        else for (const v of Object.values(block.attrs.source.args ?? {})) rootsOfSource(v, found);
        break;
      case 'xb/component':
        for (const v of Object.values(block.attrs.props ?? {})) {
          if (v && typeof v === 'object' && 'expr' in v) rootsOfSource(v.expr, found);
          else if (v && typeof v === 'object' && 'tpl' in v) interpolations(v.tpl).forEach((e) => rootsOfSource(e, found));
        }
        break;
      default:
        break;
    }
    use(found);
    const inner = new Set(bound);
    let kids = childrenOf(block);
    if (block.name === 'xb/loop') {
      inner.add(block.attrs.as);
      if (block.attrs.index) inner.add(block.attrs.index);
      // {:else} is shown when there are no items: the loop's names do not exist there.
      const empty = loopElse(block);
      if (empty) {
        kids = kids.slice(0, -1);
        freeRoots(empty.children, bound).forEach((n) => out.add(n));
      }
    }
    freeRoots(kids, inner).forEach((n) => out.add(n));
  }
  return out;
}

/** Why a selection cannot become a component as it is (null: it can). */
export function componentProblem(blocks: XbBlock[]): string | null {
  const local = [...freeRoots(blocks)].filter((n) => !GLOBAL_ROOTS.includes(n)).sort();
  if (local.length) {
    return t(
      'La selezione usa {0}, che esiste solo qui (per esempio la variabile di un loop): dentro un componente si vedono solo {1} e le sue props. Crea il componente da un elemento che non la usa, oppure includi anche il loop.',
      local.map((n) => `"${n}"`).join(', '),
      GLOBAL_ROOTS.join(', '),
    );
  }
  if (blocks.some((b) => b.name === 'xb/slot')) return t('La selezione contiene uno slot del componente che stai modificando.');
  return null;
}

/** A component key from a label: "Scheda evento" → "scheda-evento". */
export function refFrom(label: string): string {
  const slug = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .replace(/-([0-9])/g, '$1')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'componente';
}

// ------------------------------------------------------------------ SVG

/** SVG elements and attributes kept (plugin/src/Security/MarkupPolicy.php: no animation, scripts or foreign content). */
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text', 'tspan', 'textPath', 'defs', 'symbol', 'use', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'title', 'desc']);
const MAX_SVG = 200_000;

const escapeBraces = (s: string): string => s.replace(/[{}]/g, (c) => `\\${c}`);

/**
 * Removes `on…=` attributes from markup text: after whitespace, `/` or a closing quote (where HTML starts a new
 * attribute), any case, quoted or not.
 */
const HANDLER = /(?<=[\s/"'])(on[a-z0-9_-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

export function stripHandlers(code: string): string {
  return code.replace(HANDLER, '');
}

/**
 * What svgToBlocks keeps of one SVG attribute: the stored name and value, or nothing; `dropped` names what the author
 * should hear was removed. No namespace declarations (`xmlns`, `xmlns:xlink`): an SVG inline in HTML needs none, and
 * Histeon CMS transfers refuse them (docs/spec/transfer-markup.md §5).
 */
export function svgAttribute(name: string, value: string): { keep?: [string, string]; dropped?: string } {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return { dropped: name };
  if (lower.startsWith('xmlns')) return {};
  if ((lower === 'href' || lower === 'xlink:href') && !value.trim().startsWith('#')) return { dropped: `${name}="${value.slice(0, 30)}"` };
  if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name)) return {};
  return { keep: [name === 'xlink:href' ? 'href' : name, escapeBraces(value)] };
}

/**
 * SVG code as builder elements, cleaned: only the drawing elements above; no event handlers, no style elements,
 * references only to the same document (`#id`), braces escaped so nothing becomes an expression. The server
 * filters again on save for authors without unfiltered_html.
 */
export function svgToBlocks(source: string, uid: () => string): { blocks: XbBlock[]; dropped: string[] } {
  if (source.length > MAX_SVG) throw new Error(t('SVG troppo grande (al massimo 200 KB).'));
  let code = source;
  const handlers = [...source.matchAll(HANDLER)].map((m) => m[1] ?? 'on…');
  // Event handler attributes go before any parsing: Chromium compiles them (and reports them to the CSP) even in
  // documents that never run scripts. The node filter below drops any that survive this textual pass.
  code = stripHandlers(code);
  // The HTML parser of DOMParser builds an inert document: no script runs and no event handler fires. The XML
  // parser ('image/svg+xml') fires the SVG load event, so an `onload` would try to run in the builder's page.
  const doc = new DOMParser().parseFromString(code, 'text/html');
  const roots = Array.from(doc.body.children);
  const root = roots[0];
  if (roots.length !== 1 || !root || root.localName !== 'svg') throw new Error(t('Non è un SVG valido: incolla un solo elemento <svg>.'));
  const dropped = new Set<string>(handlers);
  const convert = (node: Element, depth: number): XbBlock | null => {
    const tag = node.localName;
    if (!SVG_TAGS.has(tag) || depth > 64) {
      dropped.add(`<${tag}>`);
      return null;
    }
    const attributes: Record<string, string> = {};
    for (const attr of Array.from(node.attributes)) {
      const kept = svgAttribute(attr.name, attr.value);
      if (kept.dropped) dropped.add(kept.dropped);
      if (kept.keep) attributes[kept.keep[0]] = kept.keep[1];
    }
    const children: XbBlock[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        const block = convert(child as Element, depth + 1);
        if (block) children.push(block);
      } else if (child.nodeType === 3 && (child.textContent ?? '').trim() && ['text', 'tspan', 'textPath', 'title', 'desc'].includes(tag)) {
        children.push({ name: 'xb/text', attrs: { uid: uid(), content: escapeBraces(child.textContent ?? '') } });
      }
    }
    const block: ElementBlock = { name: 'xb/element', attrs: { uid: uid(), tag, ...(Object.keys(attributes).length ? { attributes } : {}) }, children };
    return block;
  };
  const svg = convert(root, 0);
  if (!svg) throw new Error(t('Non è un SVG valido.'));
  return { blocks: [svg], dropped: [...dropped] };
}

// ------------------------------------------------------------------ Auto-BEM

const PART: Record<string, string> = {
  h1: 'title', h2: 'title', h3: 'title', h4: 'subtitle', h5: 'subtitle', h6: 'subtitle',
  p: 'text', span: 'label', small: 'note', strong: 'strong', em: 'em',
  img: 'image', picture: 'picture', figure: 'figure', figcaption: 'caption', video: 'video', svg: 'icon',
  a: 'link', button: 'button', ul: 'list', ol: 'list', li: 'item', nav: 'nav',
  header: 'header', footer: 'footer', time: 'date', blockquote: 'quote', form: 'form', input: 'input', label: 'label',
  div: 'inner', section: 'section', article: 'article',
};

const slugPart = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The block name of an element: its first class, else its label or tag. */
export function bemBase(block: ElementBlock): string {
  const cls = typeof block.attrs.attributes?.class === 'string' ? block.attrs.attributes.class.trim().split(/\s+/)[0] ?? '' : '';
  if (cls && !cls.includes('{')) return cls;
  return slugPart(block.attrs.label ?? '') || block.attrs.tag;
}

/**
 * Gives every descendant element without a class a BEM element class (`card__title`, `card__text`…), named from
 * its label or tag. Elements that already have a class, SVG internals and component instances are left alone.
 * Returns the new tree and the classes added.
 */
export function applyBem(block: ElementBlock): { block: ElementBlock; added: string[]; base: string } {
  const base = bemBase(block);
  const added: string[] = [];
  const visit = (b: XbBlock): XbBlock => {
    if (b.name === 'xb/element') {
      const hasClass = typeof b.attrs.attributes?.class === 'string' && b.attrs.attributes.class.trim() !== '';
      const svgInside = b.attrs.tag !== 'svg' && SVG_TAGS.has(b.attrs.tag);
      let next: ElementBlock = b;
      if (!hasClass && !svgInside) {
        const cls = `${base}__${slugPart(b.attrs.label ?? '') || PART[b.attrs.tag] || b.attrs.tag}`;
        next = { ...b, attrs: { ...b.attrs, attributes: { class: cls, ...(b.attrs.attributes ?? {}) } } };
        if (!added.includes(cls)) added.push(cls);
      }
      return b.attrs.tag === 'svg' ? next : { ...next, children: next.children.map(visit) };
    }
    if (b.name === 'xb/component') return b;
    if ('children' in b) return { ...b, children: (b.children as XbBlock[]).map(visit) } as XbBlock;
    return b;
  };
  const root: ElementBlock = typeof block.attrs.attributes?.class === 'string' && block.attrs.attributes.class.trim() ? block : { ...block, attrs: { ...block.attrs, attributes: { class: base, ...(block.attrs.attributes ?? {}) } } };
  return { block: { ...root, children: root.children.map(visit) }, added, base };
}

/**
 * The block name an element gives its children: its first class, else what it received. Components start
 * their own naming, so nothing crosses them.
 */
export function childBase(block: XbBlock, base: string | null): string | null {
  if (block.name === 'xb/component') return null;
  if (block.name !== 'xb/element') return base;
  const cls = typeof block.attrs.attributes?.class === 'string' ? (block.attrs.attributes.class.trim().split(/\s+/)[0] ?? '') : '';
  return cls && !cls.includes('{') ? cls : base;
}

/**
 * The automatic label of an element in the structure: an element without its own label and class, inside a
 * block that has one, reads as its BEM name (an h2 in `.card` → `card__title`), the name "Classi BEM" would give.
 */
export function autoLabel(block: XbBlock, base: string | null): string | null {
  if (block.name !== 'xb/element' || block.attrs.label || base === null) return null;
  const cls = block.attrs.attributes?.class;
  if (typeof cls === 'string' && cls.trim() !== '') return null;
  if (block.attrs.tag !== 'svg' && SVG_TAGS.has(block.attrs.tag)) return null;
  return `${base}__${PART[block.attrs.tag] ?? block.attrs.tag}`;
}

/** A label as the DSL stores it (`xb:label`): one line, no braces (they would read as an expression), 60 characters. */
export function cleanLabel(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export { escapeBraces };
