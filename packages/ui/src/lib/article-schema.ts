import { DOMParser as ProseParser, DOMSerializer, Fragment, Schema, type Node as ProseNode } from "prosemirror-model";

/**
 * The article as the editor holds it (doc 21 §13). Only what the server accepts exists here, so a paste keeps text,
 * headings, lists and links and drops the rest. `uid` ties a block to the document's own, and `container` to its wrapper.
 */
const place = { uid: { default: null as string | null }, container: { default: null as string | null } };

export type CardProps = Record<string, string | number | boolean>;
export interface CardRow { uid?: string; props: CardProps }
export interface CardPropDefinition { type: string; default?: unknown; label?: string; options?: string[] }
export interface CardDefinition { ref: string; title: string; schema: { props: Record<string, CardPropDefinition> }; areas: string[]; rows?: string; row?: boolean; auto?: boolean; own?: { look: string; fields: Array<{ name?: string; label: string; kind: string }> } }
/** The blocks of this project: the server's list, set when an article opens. */
export const cardLibrary = new Map<string, CardDefinition>();

/** Whether a block says something yet; a choice alone does not. */
export function cardFilled(ref: string, props: CardProps, entries: CardRow[]): boolean {
  const definitions = cardLibrary.get(ref)?.schema.props ?? {};
  return cardLibrary.get(ref)?.auto === true || entries.length > 0 || Object.entries(props).some(([name, value]) => (typeof value === "string" ? definitions[name]?.type !== "enum" && Boolean(value.trim()) : true));
}

export const articleSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { attrs: place, content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    heading: {
      attrs: { ...place, level: { default: 2 } }, content: "inline*", group: "block", defining: true,
      parseDOM: [{ tag: "h1", attrs: { level: 2 } }, { tag: "h2", attrs: { level: 2 } }, { tag: "h3", attrs: { level: 3 } }, { tag: "h4", attrs: { level: 4 } }, { tag: "h5", attrs: { level: 4 } }, { tag: "h6", attrs: { level: 4 } }],
      toDOM: (node) => [`h${node.attrs.level as number}`, 0],
    },
    blockquote: { attrs: place, content: "paragraph+", group: "block", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => ["blockquote", 0] },
    bullet_list: { attrs: place, content: "list_item+", group: "block", parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0] },
    ordered_list: { attrs: place, content: "list_item+", group: "block", parseDOM: [{ tag: "ol" }], toDOM: () => ["ol", 0] },
    list_item: { attrs: { uid: { default: null as string | null } }, content: "paragraph", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => ["li", 0] },
    table: { attrs: place, content: "table_row+", group: "block", isolating: true, parseDOM: [{ tag: "table" }], toDOM: () => ["table", ["tbody", 0]] },
    table_row: { content: "table_cell+", parseDOM: [{ tag: "tr" }], toDOM: () => ["tr", 0] },
    table_cell: { attrs: { header: { default: false } }, content: "inline*", isolating: true, parseDOM: [{ tag: "th", attrs: { header: true } }, { tag: "td" }], toDOM: (node) => [node.attrs.header ? "th" : "td", 0] },
    separator: { attrs: place, group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["hr"] },
    image: {
      attrs: { ...place, src: {}, alt: { default: "" }, width: { default: null as number | null }, height: { default: null as number | null }, caption: { default: "" } },
      group: "block", atom: true, draggable: true, selectable: true,
      toDOM: (node) => ["figure", ["img", { src: node.attrs.src as string, alt: node.attrs.alt as string }]],
    },
    card: {
      attrs: { ...place, ref: {}, props: { default: {} as CardProps }, entries: { default: [] as CardRow[] } },
      group: "block", atom: true, draggable: true, selectable: true,
      // A copy carries its data; what it says is checked like any other block.
      parseDOM: [{ tag: "div[data-card]", getAttrs: (dom) => {
        try {
          const card = JSON.parse((dom as HTMLElement).dataset.card ?? "") as { ref?: unknown; props?: CardProps; entries?: CardRow[] };
          return typeof card.ref === "string" ? { ref: card.ref, props: card.props ?? {}, entries: card.entries ?? [] } : false;
        } catch { return false; }
      } }],
      toDOM: (node) => ["div", { class: "article-card", "data-card": JSON.stringify({ ref: node.attrs.ref as string, props: node.attrs.props as CardProps, entries: node.attrs.entries as CardRow[] }) }],
    },
    note_list: {
      attrs: place, content: "list_item+", group: "block",
      parseDOM: [{ tag: "ol.xb-art-note", priority: 60 }], toDOM: () => ["ol", { class: "xb-art-note" }, 0],
    },
    kept: {
      attrs: { ...place, label: { default: "" }, summary: { default: "" }, fields: { default: [] as KeptField[] }, convert: { default: [] as ArticleBlock[] } }, group: "block", atom: true, draggable: true, selectable: true,
      toDOM: (node) => ["div", { class: "article-kept" }, ["strong", node.attrs.label as string], ["span", node.attrs.summary as string]],
    },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
  },
  marks: {
    link: {
      attrs: { href: {} }, inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute("href") }) }],
      toDOM: (mark) => ["a", { href: mark.attrs.href as string }, 0],
    },
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    underline: { parseDOM: [{ tag: "u" }], toDOM: () => ["u", 0] },
    strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
    sub: { parseDOM: [{ tag: "sub" }], toDOM: () => ["sub", 0] },
    sup: { parseDOM: [{ tag: "sup" }], toDOM: () => ["sup", 0] },
  },
});

export interface KeptField { uid: string; kind: "text" | "link"; value: string }
export interface ArticleItem { uid?: string; html: string }
export interface ArticleBlock {
  type: "paragraph" | "heading" | "list" | "quote" | "image" | "table" | "separator" | "card" | "kept";
  uid?: string;
  container?: string;
  html?: string;
  level?: number;
  ordered?: boolean;
  items?: ArticleItem[];
  src?: string;
  alt?: string;
  width?: number | null;
  height?: number | null;
  caption?: string;
  label?: string;
  summary?: string;
  rows?: string[][];
  header?: boolean;
  ref?: string;
  props?: CardProps;
  entries?: CardRow[];
  notes?: boolean;
  fields?: KeptField[];
  /** Doc 23 item 111: the article blocks a kept block can become, when the writer asks. */
  convert?: ArticleBlock[];
}

const safe = document.implementation.createHTMLDocument("");
const parser = ProseParser.fromSchema(articleSchema);
const serializer = DOMSerializer.fromSchema(articleSchema);

/** Inline text from HTML, read in a document with no browsing context: nothing in it loads or runs. */
function inline(html: string): Fragment {
  const holder = safe.createElement("div");
  holder.innerHTML = html;
  return parser.parseSlice(holder, { preserveWhitespace: "full", context: articleSchema.nodes.paragraph!.create().resolve(0) }).content;
}
function htmlOf(node: ProseNode): string {
  const holder = safe.createElement("div");
  holder.appendChild(serializer.serializeFragment(node.content, { document: safe }));
  return holder.innerHTML;
}

export function toDocument(blocks: ArticleBlock[]): ProseNode {
  const { nodes } = articleSchema;
  const at = (block: ArticleBlock) => ({ uid: block.uid ?? null, container: block.container ?? null });
  const paragraph = (item: ArticleItem) => nodes.paragraph!.create({ uid: item.uid ?? null }, inline(item.html));
  const content = blocks.map((block) => {
    switch (block.type) {
      case "heading": return nodes.heading!.create({ ...at(block), level: block.level }, inline(block.html ?? ""));
      case "quote": return nodes.blockquote!.create(at(block), (block.items ?? []).map(paragraph));
      case "list": return (block.notes ? nodes.note_list! : block.ordered ? nodes.ordered_list! : nodes.bullet_list!).create(at(block), (block.items ?? []).map((item) => nodes.list_item!.create({ uid: item.uid ?? null }, nodes.paragraph!.create(null, inline(item.html)))));
      case "image": return nodes.image!.create({ ...at(block), src: block.src, alt: block.alt ?? "", width: block.width ?? null, height: block.height ?? null, caption: block.caption ?? "" });
      case "separator": return nodes.separator!.create(at(block));
      case "table": return nodes.table!.create(at(block), (block.rows ?? []).map((row, position) => nodes.table_row!.create(null, row.map((cell) => nodes.table_cell!.create({ header: Boolean(block.header) && position === 0 }, inline(cell))))));
      case "card": return nodes.card!.create({ ...at(block), ref: block.ref, props: block.props ?? {}, entries: block.entries ?? [] });
      case "kept": return nodes.kept!.create({ ...at(block), label: block.label ?? "", summary: block.summary ?? "", fields: block.fields ?? [], convert: block.convert ?? [] });
      default: return nodes.paragraph!.create(at(block), inline(block.html ?? ""));
    }
  });
  return nodes.doc!.create(null, content.length ? content : [nodes.paragraph!.create()]);
}

export function fromDocument(doc: ProseNode): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  doc.forEach((node) => {
    const place = { ...(node.attrs.uid ? { uid: node.attrs.uid as string } : {}), ...(node.attrs.container ? { container: node.attrs.container as string } : {}) };
    const items = (): ArticleItem[] => {
      const list: ArticleItem[] = [];
      node.forEach((child) => {
        const text = child.type.name === "list_item" ? child.firstChild! : child;
        list.push({ ...(child.attrs.uid ? { uid: child.attrs.uid as string } : {}), html: htmlOf(text) });
      });
      return list;
    };
    switch (node.type.name) {
      case "heading": blocks.push({ ...place, type: "heading", level: node.attrs.level as number, html: htmlOf(node) }); break;
      case "blockquote": blocks.push({ ...place, type: "quote", items: items() }); break;
      case "bullet_list": case "ordered_list": blocks.push({ ...place, type: "list", ordered: node.type.name === "ordered_list", items: items() }); break;
      case "image": blocks.push({ ...place, type: "image", src: node.attrs.src as string, alt: node.attrs.alt as string, width: node.attrs.width as number | null, height: node.attrs.height as number | null, caption: node.attrs.caption as string }); break;
      case "separator": blocks.push({ ...place, type: "separator" }); break;
      case "table": {
        const rows: string[][] = [];
        node.forEach((row) => {
          const cells: string[] = [];
          row.forEach((cell) => { cells.push(htmlOf(cell)); });
          rows.push(cells);
        });
        blocks.push({ ...place, type: "table", rows, header: Boolean(node.firstChild?.firstChild?.attrs.header) });
        break;
      }
      // A block still being filled in stays on the sheet and is saved when it says something.
      case "card": if (cardFilled(node.attrs.ref as string, node.attrs.props as CardProps, node.attrs.entries as CardRow[])) blocks.push({ ...place, type: "card", ref: node.attrs.ref as string, props: node.attrs.props as CardProps, entries: node.attrs.entries as CardRow[] }); break;
      case "note_list": blocks.push({ ...place, type: "list", ordered: true, notes: true, items: items() }); break;
      case "kept": blocks.push({ ...place, type: "kept", fields: node.attrs.fields as KeptField[] }); break;
      default: blocks.push({ ...place, type: "paragraph", html: htmlOf(node) });
    }
  });
  // A new block goes in the wrapper of what stands around it, where the template's styles reach it.
  blocks.forEach((block, position) => {
    if (block.uid || block.container) return;
    const near = [...blocks.slice(0, position).reverse(), ...blocks.slice(position + 1)].find((other) => other.container);
    if (near?.container) block.container = near.container;
  });
  return blocks;
}

/**
 * The ids the server gave, set on the blocks it saved, as positions and values: without them each save would make new
 * blocks, and translations would lose their texts. Lines left empty are not saved, so they are skipped here.
 */
export function savedIds(doc: ProseNode, blocks: ArticleBlock[]): Array<{ pos: number; uid: string; container?: string | undefined }> {
  const changes: Array<{ pos: number; uid: string; container?: string | undefined }> = [];
  const empty = (node: ProseNode): boolean => (node.type.name === "paragraph" && !node.textContent.trim() && !node.childCount) || (node.type.name === "card" && !cardFilled(node.attrs.ref as string, node.attrs.props as CardProps, node.attrs.entries as CardRow[]));
  let next = 0;
  doc.forEach((node, offset) => {
    if (empty(node)) return;
    const block = blocks[next];
    next += 1;
    if (!block?.uid) return;
    if (node.attrs.uid !== block.uid || (node.attrs.container ?? undefined) !== block.container) changes.push({ pos: offset, uid: block.uid, container: block.container });
    if (!block.items) return;
    let inner = offset + 1;
    node.forEach((child, _at, position) => {
      const item = block.items?.[position];
      if (item?.uid && child.attrs.uid !== item.uid) changes.push({ pos: inner, uid: item.uid });
      inner += child.nodeSize;
    });
  });
  return changes;
}
