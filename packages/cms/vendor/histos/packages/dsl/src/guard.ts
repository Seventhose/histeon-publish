import { parse } from './parser.ts';
import { escapeRaw, escapeRawText, escapeText, printAttributes, print } from './printer.ts';
import { INLINE_FORMAT, VOID_ELEMENTS, type XbBlock } from './tree.ts';
import { hasInterpolation } from './interp.ts';

/**
 * Whether the printed DSL of a tree reads back as the same structure.
 *
 * The HTML panel shows print(tree) and, on the first edit, saves parse(text) with the editing user's
 * privileges. Stored content is not trusted to be canonical, so if printing and parsing do not agree on the
 * structure — elements, attributes, blocks, expressions — an edit could silently turn someone else's text
 * into markup. The panel is then read-only (fail closed). Differences that cannot change structure are
 * ignored: whitespace and quoting inside text, inline formatting folded into text, the escapes the printer adds.
 */
export function roundTrips(blocks: XbBlock[]): boolean {
  try {
    const expected = JSON.stringify(normalize(blocks.map((b) => escaped(b))));
    const actual = JSON.stringify(normalize(parse(print(blocks), { uid: () => 'x' }).blocks));
    return expected === actual;
  } catch {
    return false;
  }
}

/** The tree with the printer's escapes applied, i.e. what parsing the printed text should give. */
function escaped(block: XbBlock, parentTag = ''): XbBlock {
  switch (block.name) {
    case 'xb/text':
      return { ...block, attrs: { ...block.attrs, content: block.attrs.verbatim ? escapeRawText(parentTag, block.attrs.content) : escapeText(block.attrs.content) } };
    case 'xb/raw':
      return { ...block, attrs: { ...block.attrs, content: escapeRaw(block.attrs.content) } };
    case 'xb/element':
      return { ...block, children: block.children.map((c) => escaped(c, block.attrs.tag)) };
    default:
      return 'children' in block ? ({ ...block, children: (block.children as XbBlock[]).map((c) => escaped(c)) } as XbBlock) : block;
  }
}

type Node = { text: string } | { name: string; attrs: Record<string, unknown>; children?: Node[]; raw?: string };

/** Siblings with text runs merged, inline formatting folded in, raw (whitespace and quotes kept). */
function items(blocks: XbBlock[]): Node[] {
  const out: Node[] = [];
  for (const block of blocks) {
    const text = asText(block);
    const node: Node = text !== undefined ? { text } : structural(block);
    const last = out[out.length - 1];
    if ('text' in node && last && 'text' in last) last.text += node.text;
    else out.push(node);
  }
  return out;
}

function normalize(blocks: XbBlock[]): Node[] {
  return items(blocks)
    .map((n) => ('text' in n ? { text: n.text.replace(/[\s"']+/g, '') } : n))
    .filter((n) => !('text' in n) || n.text !== '');
}

function structural(block: XbBlock): Node {
  const { uid: _uid, ...attrs } = block.attrs as { uid: string } & Record<string, unknown>;
  if (block.name === 'xb/element' && block.attrs.attributes) {
    attrs.attributes = Object.fromEntries(
      Object.entries(block.attrs.attributes)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('&quot;', '"') : v]),
    );
  }
  const node: Node = { name: block.name, attrs };
  if ('children' in block) node.children = normalize(block.children as XbBlock[]);
  if (block.name === 'xb/passthrough') node.raw = block.raw;
  return node;
}

/**
 * What reads back as text: a text node, or an inline formatting element (docs/spec/dsl.md §3.4) whose content
 * is itself only text once its own inline children are folded — the parser folds bottom-up, so
 * `<strong>a <a href="/">b</a> c</strong>` stored as three nodes is still one text run.
 */
function asText(block: XbBlock): string | undefined {
  if (block.name === 'xb/text') return block.attrs.verbatim ? undefined : block.attrs.content;
  if (block.name !== 'xb/element') return undefined;
  const allowed = INLINE_FORMAT.get(block.attrs.tag);
  if (!allowed || block.attrs.label !== undefined) return undefined;
  for (const [name, value] of Object.entries(block.attrs.attributes ?? {})) {
    if (!allowed.has(name) || typeof value !== 'string' || hasInterpolation(value)) return undefined;
  }
  const open = `<${block.attrs.tag}${printAttributes(block.attrs.attributes)}>`;
  if (VOID_ELEMENTS.has(block.attrs.tag)) return block.children.length === 0 ? open : undefined;
  const inner = items(block.children);
  const [only, ...rest] = inner;
  if (rest.length > 0 || (only && !('text' in only))) return undefined;
  return open + (only && 'text' in only ? only.text : '') + `</${block.attrs.tag}>`;
}
