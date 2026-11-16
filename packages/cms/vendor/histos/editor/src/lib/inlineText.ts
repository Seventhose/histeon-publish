// Text written directly in the canvas (docs/spec/inline-text.md). What comes back from the editable element goes
// through the DSL parser, which accepts only text with the inline formatting it can represent (strong, em, a…):
// anything else is refused, so typing in the page can never add markup the builder cannot show or round-trip.
import { childrenOf, INLINE_FORMAT, parse, print, type XbBlock } from '@xb/dsl';
import { t } from './i18n.ts';

/** An unescaped `{`: the text holds an expression (`{item.title}`), which is edited as code, not in the page. */
const EXPRESSION = /(^|[^\\])\{/;
/** Elements whose text the canvas can take over: not raw text, not void. */
const NOT_EDITABLE = new Set(['script', 'style', 'textarea', 'title', 'svg', 'math', 'img', 'input', 'select', 'video', 'audio', 'iframe']);

/** The element's single text, when it can be written in the canvas: static text with inline formatting only. */
export function inlineTarget(block: XbBlock | null): (XbBlock & { name: 'xb/element' }) | null {
  if (!block || block.name !== 'xb/element' || NOT_EDITABLE.has(block.attrs.tag)) return null;
  const kids = childrenOf(block);
  if (kids.length !== 1) return null;
  const text = kids[0] as XbBlock;
  if (text.name !== 'xb/text' || text.attrs.verbatim || EXPRESSION.test(text.attrs.content)) return null;
  return block;
}

/** Why an element's text is not written in the canvas, for the status line; null when it is. */
export function inlineRefusal(block: XbBlock | null): string | null {
  if (inlineTarget(block)) return null;
  if (block?.name === 'xb/element' && childrenOf(block).some((k) => k.name === 'xb/text' && EXPRESSION.test(k.attrs.content))) {
    return t('Testo dinamico: le espressioni si modificano nel pannello HTML');
  }
  return null;
}

/**
 * The text content for `tag` from the editable element's HTML (braces already escaped in its text nodes), or
 * null when it is not plain text with inline formatting. Empty is allowed.
 */
export function inlineContent(tag: string, html: string): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  let blocks: XbBlock[];
  try {
    blocks = parse(`<${tag}>${html}</${tag}>`).blocks;
  } catch {
    return null;
  }
  const [only, ...rest] = blocks;
  if (!only || rest.length > 0 || only.name !== 'xb/element') return null;
  const kids = childrenOf(only);
  if (kids.length === 0) return '';
  if (kids.length !== 1) return null;
  const text = kids[0] as XbBlock;
  return text.name === 'xb/text' && !EXPRESSION.test(text.attrs.content) ? text.attrs.content : null;
}

/**
 * Whether a link typed or pasted in the canvas may keep its address: relative, `#`, or http(s), mailto and tel.
 * Browsers drop tabs and line breaks inside a scheme, so `java\tscript:` counts as `javascript:`.
 */
export function safeHref(href: string): boolean {
  const clean = href.replace(/[\t\n\r]/g, '').replace(/^[\s\u0000-\u001f]+/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
  return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme[1]!.toLowerCase());
}

/**
 * The code of `block` with `html` as its content, for the HTML panel: text written in the canvas that the canvas
 * cannot take is handed over there as typed, instead of being thrown away.
 */
export function draftCode(block: XbBlock & { name: 'xb/element' }, html: string): string {
  const mark = 'xbdraftmark0content';
  const [text] = childrenOf(block);
  const holder = { name: 'xb/text', attrs: { uid: text?.attrs.uid ?? '', content: mark } } as XbBlock;
  return print([{ ...block, children: [holder] } as XbBlock]).replace(mark, () => html);
}

/**
 * Tidies what the browser's editing left in the element before it is read: b/i become strong/em, unknown tags
 * give way to their text, attributes the inline formatting does not allow are dropped, braces in text are
 * escaped (typed text is never an expression). Browser only (works on the canvas document).
 */
export function tidyInline(root: Element): void {
  const doc = root.ownerDocument;
  const rename = (el: Element, tag: string) => {
    const next = doc.createElement(tag);
    for (const a of [...el.attributes]) next.setAttribute(a.name, a.value);
    next.append(...el.childNodes);
    el.replaceWith(next);
    return next;
  };
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        child.textContent = (child.textContent ?? '').replace(/[{}]/g, (m) => `\\${m}`);
      } else if (child.nodeType === 1) {
        let el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === 'b') el = rename(el, 'strong');
        else if (tag === 'i') el = rename(el, 'em');
        const allowed = INLINE_FORMAT.get(el.tagName.toLowerCase());
        if (!allowed) {
          walk(el);
          el.replaceWith(...el.childNodes);
          continue;
        }
        for (const a of [...el.attributes]) if (!allowed.has(a.name)) el.removeAttribute(a.name);
        const href = el.getAttribute('href');
        if (href !== null && !safeHref(href)) el.removeAttribute('href');
        walk(el);
      } else {
        child.remove();
      }
    }
  };
  walk(root);
  // A lone trailing <br> is the browser's placeholder for an empty line, not content.
  if (root.lastChild?.nodeName === 'BR') root.lastChild.remove();
}
