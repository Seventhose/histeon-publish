import { childrenOf, type XbBlock } from '@xb/dsl';

/**
 * Search and replace in the page (E13): in the words of the texts (never inside tags or `{expressions}`), in whole
 * class names, in link addresses. Pure: the caller applies the new tree in one undo step.
 */
export interface ReplaceOptions {
  text: boolean;
  classes: boolean;
  links: boolean;
  matchCase: boolean;
}

export interface ReplaceMatch {
  uid: string;
  where: 'text' | 'class' | 'link';
  before: string;
  after: string;
}

/** Text as it is stored in a text node: markup characters as entities, braces escaped (docs/spec/dsl.md §3.5). */
function stored(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[{}]/g, (c) => '\\' + c);
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Tags and expressions: what a replacement never touches inside a text. */
const PROTECTED = /(<[^>]*>|(?<!\\)\{[^}]*\})/;

function readable(content: string): string {
  return content.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\\([{}])/g, '$1').replace(/\s+/g, ' ').trim();
}

function snippet(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function replaceInTree(blocks: XbBlock[], find: string, replacement: string, options: ReplaceOptions): { tree: XbBlock[]; count: number; matches: ReplaceMatch[] } {
  const matches: ReplaceMatch[] = [];
  let count = 0;
  if (!find) return { tree: blocks, count, matches };
  const flags = options.matchCase ? 'g' : 'gi';
  const inText = new RegExp(escapeRe(stored(find)), flags);
  const withText = stored(replacement);
  const inLink = new RegExp(escapeRe(find), flags);

  const visit = (list: XbBlock[]): XbBlock[] => {
    let changed = false;
    const out = list.map((block) => {
      let next = block;
      if (options.text && block.name === 'xb/text') {
        let n = 0;
        const content = block.attrs.content
          .split(PROTECTED)
          .map((part, i) => (i % 2 === 1 ? part : part.replace(inText, () => (++n, withText))))
          .join('');
        if (n) {
          count += n;
          matches.push({ uid: block.attrs.uid, where: 'text', before: snippet(readable(block.attrs.content)), after: snippet(readable(content)) });
          next = { ...block, attrs: { ...block.attrs, content } };
        }
      }
      if (next.name === 'xb/element') {
        const attributes = { ...(next.attrs.attributes ?? {}) };
        let touched = false;
        const cls = attributes.class;
        if (options.classes && typeof cls === 'string') {
          const same = (c: string) => (options.matchCase ? c === find : c.toLowerCase() === find.toLowerCase());
          const tokens = cls.split(/(\s+)/);
          const renamed = tokens.map((token) => (same(token) ? replacement : token));
          const n = tokens.filter(same).length;
          if (n) {
            count += n;
            touched = true;
            attributes.class = renamed.join('').trim();
            matches.push({ uid: next.attrs.uid, where: 'class', before: `.${cls.trim().split(/\s+/).join('.')}`, after: `.${attributes.class.split(/\s+/).join('.')}` });
          }
        }
        const href = attributes.href;
        if (options.links && typeof href === 'string') {
          let n = 0;
          const rewritten = href.replace(inLink, () => (++n, replacement.replace(/[{}]/g, (c) => '\\' + c)));
          if (n) {
            count += n;
            touched = true;
            attributes.href = rewritten;
            matches.push({ uid: next.attrs.uid, where: 'link', before: snippet(href), after: snippet(rewritten) });
          }
        }
        if (touched) next = { ...next, attrs: { ...next.attrs, attributes } } as XbBlock;
      }
      const kids = childrenOf(next);
      if (kids.length) {
        const visited = visit(kids);
        if (visited !== kids) next = { ...next, children: visited } as XbBlock;
      }
      if (next !== block) changed = true;
      return next;
    });
    return changed ? out : list;
  };
  const tree = visit(blocks);
  return { tree, count, matches };
}
