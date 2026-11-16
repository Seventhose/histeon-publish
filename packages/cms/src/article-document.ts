import { parseXb, randomUid, serializeXb, type XbBlock } from "../.generated/histos-dsl/index.js";
import { ARTICLE_INDEX, type Card, cardImages, cardOf, type CardRules, cardTree, cleanCard } from "./article-cards.js";

/**
 * The text of an article as blocks (doc 21 §13): what an editor without HTML shows and sends back. Only this module turns
 * them into the document's markup. A block that does not change comes back exactly as it was, and what is not plain text
 * (a list of attachments, a source line) stays a kept block, which the editor can move or remove and never rewrites.
 */

export interface ArticleItem { uid: string; html: string }
interface ArticlePlace { uid: string; container?: string }
export type ArticleBlock = ArticlePlace & (
  | { type: "paragraph"; html: string }
  | { type: "heading"; level: 2 | 3 | 4; html: string; anchor?: string }
  | { type: "list"; ordered: boolean; items: ArticleItem[]; notes?: boolean }
  | { type: "quote"; items: ArticleItem[] }
  | { type: "image"; src: string; alt: string; width: number | null; height: number | null; caption: string }
  | { type: "table"; rows: string[][]; header: boolean }
  | { type: "separator" }
  | ({ type: "card" } & Card)
  | { type: "kept"; label: string; summary: string; fields?: KeptField[]; convert?: ArticleBlock[] }
);
/** What can change in a block kept as it is: its plain texts and the addresses of its links, never its structure. */
export interface KeptField { uid: string; kind: "text" | "link"; value: string }
export interface ArticleContainer { uid: string; tag: string; className: string }
export interface ArticleDocument { blocks: ArticleBlock[]; containers: ArticleContainer[] }

export const MAX_ARTICLE_BLOCKS = 4000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_KEPT_FIELDS = 40;
const CONTAINER_TAGS = new Set(["div", "section", "article", "main"]);
const INLINE_TAGS = new Set(["strong", "em", "a", "br", "code", "sub", "sup", "u", "s"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string): string => escapeText(text).replaceAll("\"", "&quot;");

function decodeText(text: string): string | null {
  let known = true;
  const decoded = text.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z0-9]{1,31});/giu, (whole, name: string) => {
    if (name.startsWith("#")) {
      const point = Number(/x/iu.test(name.charAt(1)) ? `0x${name.slice(2)}` : name.slice(1));
      if (point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) return String.fromCodePoint(point);
      known = false;
      return whole;
    }
    const value = ENTITIES[name];
    if (value === undefined) known = false;
    return value ?? whole;
  });
  return known ? decoded : null;
}

/** Links an article may carry: the web, mail, the telephone, and addresses of the site itself. */
function safeHref(value: string): boolean {
  return /^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#)/iu.test(value) && !/[\s\p{Cc}]/u.test(value);
}

/**
 * Inline text as `{ tag or text }` pieces, or null when it holds anything but the formats above. `stored` reads the
 * document's own form, where `\{` is a brace and `{` an expression; the editor's HTML has neither.
 */
function pieces(source: string, stored: boolean): string | null {
  const stack: string[] = [];
  let out = "";
  let text = "";
  const flush = (): boolean => {
    const decoded = decodeText(text);
    if (decoded === null) return false;
    out += escapeText(decoded);
    text = "";
    return true;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (stored && char === "\\" && /[{}]/u.test(source.charAt(index + 1))) {
      text += source.charAt(index + 1);
      index += 1;
    } else if (stored && (char === "{" || char === "}")) {
      return null;
    } else if (char === "<" && /[A-Za-z/]/u.test(source.charAt(index + 1))) {
      const end = source.indexOf(">", index + 1);
      if (end < 0 || !flush()) return null;
      const match = /^<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"<>]*")*)\s*\/?>$/iu.exec(source.slice(index, end + 1));
      const tag = match?.[2]?.toLowerCase();
      if (!match || !tag || !INLINE_TAGS.has(tag)) return null;
      const attributes = match[3] ?? "";
      if (match[1]) {
        if (attributes || tag === "br" || stack.pop() !== tag) return null;
        out += `</${tag}>`;
      } else if (tag === "a") {
        const href = /^\s+href="([^"]*)"$/iu.exec(attributes)?.[1];
        const decoded = href === undefined ? null : decodeText(href);
        if (decoded === null || !safeHref(decoded)) return null;
        // In an address a brace would read as an expression; encoded, it is the same address.
        out += `<a href="${escapeAttribute(decoded.replaceAll("{", "%7B").replaceAll("}", "%7D"))}">`;
        stack.push(tag);
      } else {
        if (attributes) return null;
        out += `<${tag}>`;
        if (tag !== "br") stack.push(tag);
      }
      index = end;
    } else text += char;
  }
  return flush() && !stack.length ? out : null;
}

/** The editor's HTML as the document writes it: braces escaped, so a typed brace is never an expression. */
function storedText(html: string): string {
  return html.replace(/(<[^>]*>)|[{}]/gu, (whole, tag: string | undefined) => tag ?? `\\${whole}`);
}

/** A text with its inline formats reduced to them, or escaped whole when it holds anything else: what `.inline()` prints. */
export function inlineHtml(value: string): string {
  return pieces(value, false) ?? escapeText(value.replace(/<[^>]*>/gu, ""));
}

/**
 * The way back from each footnote: the paragraph that calls it gets an address, the note a link to it. A paragraph is
 * as exact as this goes: the text of a link has no address of its own in the transfer profile, and needs none here.
 */
function noteReturns(blocks: ArticleBlock[]): { anchorOf: (block: ArticleBlock) => string | null; returnOf: (note: number) => string | null } {
  const returns = new Map<number, string>();
  const anchors = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    const called = [...block.html.matchAll(/href="#nota-(\d+)"/gu)].map((match) => Number(match[1]));
    const first = called[0];
    if (first === undefined) continue;
    anchors.set(block.uid, `rif-${first}`);
    for (const note of called) if (!returns.has(note)) returns.set(note, `rif-${first}`);
  }
  return { anchorOf: (block) => anchors.get(block.uid) ?? null, returnOf: (note) => returns.get(note) ?? null };
}

/** Checks text from the editor: only the inline formats, or a refusal. */
export function cleanHtml(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) throw new TypeError("Testo dell'articolo non valido.");
  const clean = pieces(value, false);
  if (clean === null) throw new TypeError("Il testo dell'articolo contiene un formato non ammesso.");
  return clean;
}

/** The way back from a footnote to the paragraph that calls it: added at the end of the line, never kept as text. */
const NOTE_RETURN = / ?<a href="#rif-\d+">↩<\/a>$/u;

type Element = Extract<XbBlock, { name: "xb/element" }>;
const isElement = (block: XbBlock): block is Element => block.name === "xb/element";
const isBlank = (block: XbBlock): boolean => block.name === "xb/text" && !block.attrs.content.trim();
const solid = (blocks: XbBlock[] | undefined): XbBlock[] => (blocks ?? []).filter((block) => !isBlank(block));
const attributeNames = (block: Element): string[] => Object.keys(block.attrs.attributes ?? {});
const onlyClass = (block: Element): boolean => attributeNames(block).every((name) => name === "class");
const attribute = (block: Element, name: string): string => {
  const value = block.attrs.attributes?.[name];
  return typeof value === "string" ? value : "";
};

/** The inline text of an element whose children are only text, in the editor's HTML. */
function inlineOf(block: Element): string | null {
  const children = block.children ?? [];
  if (!children.every((child) => child.name === "xb/text" && !child.attrs.verbatim)) return null;
  return pieces(children.map((child) => (child.name === "xb/text" ? child.attrs.content : "")).join(""), true);
}

function itemsOf(block: Element, tag: string, notes = false): ArticleItem[] | null {
  const items: ArticleItem[] = [];
  for (const child of solid(block.children)) {
    if (!isElement(child) || child.attrs.tag !== tag) return null;
    if (notes ? attributeNames(child).join() !== "id" || attribute(child, "id") !== `nota-${items.length + 1}` : attributeNames(child).length) return null;
    const html = inlineOf(child);
    if (html === null) return null;
    items.push({ uid: child.attrs.uid, html: notes ? html.replace(NOTE_RETURN, "") : html });
  }
  return items.length ? items : null;
}

function imageOf(block: Element): Pick<Extract<ArticleBlock, { type: "image" }>, "type" | "src" | "alt" | "width" | "height" | "caption"> | null {
  const number = (image: Element, name: string): number | null => {
    const value = Number(attribute(image, name));
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  const read = (image: Element, caption: string) => {
    const src = attribute(image, "src");
    if (!src || !attributeNames(image).every((name) => ["src", "alt", "width", "height", "class"].includes(name))) return null;
    return { type: "image" as const, src, alt: attribute(image, "alt"), width: number(image, "width"), height: number(image, "height"), caption };
  };
  if (block.attrs.tag === "img") return read(block, "");
  if (block.attrs.tag !== "figure" || !onlyClass(block)) return null;
  const children = solid(block.children);
  const image = children[0];
  if (!image || !isElement(image) || image.attrs.tag !== "img" || children.length > 2) return null;
  const caption = children[1];
  if (!caption) return read(image, "");
  if (!isElement(caption) || caption.attrs.tag !== "figcaption" || attributeNames(caption).length) return null;
  const html = inlineOf(caption);
  return html === null ? null : read(image, html);
}

/** A table of plain cells; one that joins cells or has a caption stays as it is. */
function tableOf(block: Element): { rows: string[][]; header: boolean } | null {
  if (!onlyClass(block)) return null;
  const rows: string[][] = [];
  let header = false;
  const walk = (children: XbBlock[] | undefined): boolean => solid(children).every((child) => {
    if (!isElement(child)) return false;
    if (/^(?:thead|tbody|tfoot)$/u.test(child.attrs.tag)) return attributeNames(child).length === 0 && walk(child.children);
    if (child.attrs.tag !== "tr" || attributeNames(child).length) return false;
    const row: string[] = [];
    for (const cell of solid(child.children)) {
      if (!isElement(cell) || !/^t[dh]$/u.test(cell.attrs.tag) || attributeNames(cell).length) return false;
      const html = inlineOf(cell);
      if (html === null) return false;
      if (cell.attrs.tag === "th" && rows.length === 0) header = true;
      row.push(html);
    }
    rows.push(row);
    return true;
  });
  return walk(block.children) && rows.length && rows.every((row) => row.length === rows[0]?.length) ? { rows, header } : null;
}

function plainText(blocks: XbBlock[]): string {
  return blocks.map((block) => (block.name === "xb/text" ? block.attrs.content.replace(/<[^>]*>/gu, "") : isElement(block) ? plainText(block.children ?? []) : "")).join(" ").replace(/\s+/gu, " ").trim();
}

/** A block of the editor, or null when it has to stay as it is. */
function plain(block: XbBlock): ArticleBlock | null {
  const card = cardOf(block);
  if (card) return { type: "card", uid: (block.attrs as { uid: string }).uid, ...card };
  if (!isElement(block)) return null;
  const uid = block.attrs.uid;
  const tag = block.attrs.tag;
  if (tag === "img" || tag === "figure") {
    const image = imageOf(block);
    return image ? { ...image, uid } : null;
  }
  if (tag === "hr") return attributeNames(block).length ? null : { type: "separator", uid };
  if (tag === "table") {
    const table = tableOf(block);
    return table ? { type: "table", uid, ...table } : null;
  }
  // An anchor on a heading is where the table of contents points.
  if (/^h[2-4]$/u.test(tag) && attributeNames(block).every((name) => name === "class" || name === "id")) {
    const html = inlineOf(block);
    if (html === null) return null;
    const anchor = attribute(block, "id");
    return { type: "heading", uid, level: Number(tag.charAt(1)) as 2 | 3 | 4, html, ...(anchor ? { anchor } : {}) };
  }
  // The address a footnote returns to: written with the article, not a thing to edit.
  if (tag === "p" && attributeNames(block).join() === "id" && /^rif-\d+$/u.test(attribute(block, "id"))) {
    const html = inlineOf(block);
    return html === null ? null : { type: "paragraph", uid, html };
  }
  if (!onlyClass(block)) return null;
  // Footnotes are text of the article: each line keeps the address its number in the text points to.
  if (tag === "ol" && attribute(block, "class") === "xb-art-note") {
    const items = itemsOf(block, "li", true);
    return items ? { type: "list", uid, ordered: true, items, notes: true } : null;
  }
  // A class on a paragraph or a heading is a part of the template's design (a source line, say), not text to format.
  if (attribute(block, "class") && !/^h[2-4]$/u.test(tag)) return null;
  if (tag === "p" || /^h[2-4]$/u.test(tag)) {
    const html = inlineOf(block);
    if (html === null) return null;
    return tag === "p" ? { type: "paragraph", uid, html } : { type: "heading", uid, level: Number(tag.charAt(1)) as 2 | 3 | 4, html };
  }
  if (tag === "ul" || tag === "ol") {
    const items = itemsOf(block, "li");
    return items ? { type: "list", uid, ordered: tag === "ol", items } : null;
  }
  if (tag === "blockquote") {
    const items = itemsOf(block, "p");
    if (items) return { type: "quote", uid, items };
    const html = inlineOf(block);
    return html === null ? null : { type: "quote", uid, items: [{ uid: block.attrs.uid, html }] };
  }
  return null;
}

/**
 * The plain text of a link's content: its texts, and spans that are only text. A span `sr` (words for screen readers,
 * like «(sito esterno)») is left out: the blocks it becomes say it their own way. Null for anything else.
 */
function linkText(nodes: XbBlock[] | undefined): string | null {
  let out = "";
  for (const node of nodes ?? []) {
    if (node.name === "xb/text") {
      if (node.attrs.verbatim) return null;
      const html = pieces(node.attrs.content, true);
      const value = html === null || html.includes("<") ? null : decodeText(html);
      if (value === null) return null;
      out += value;
    } else if (isElement(node) && node.attrs.tag === "span" && onlyClass(node)) {
      if (attribute(node, "class").split(/\s+/u).includes("sr")) continue;
      const inner = linkText(node.children);
      if (inner === null) return null;
      out += inner;
    } else return null;
  }
  return out.replace(/\s+/gu, " ").trim();
}

/** The address and text of an element that holds one link and nothing else, or null. */
function soleLink(block: Element): { href: string; text: string } | null {
  const children = solid(block.children);
  const link = children[0];
  if (children.length !== 1 || !link || !isElement(link) || link.attrs.tag !== "a" || !attributeNames(link).every((name) => name === "href" || name === "class")) return null;
  const href = attribute(link, "href");
  const text = linkText(link.children);
  return text && safeHref(href) && !/[{}]/u.test(href) ? { href, text } : null;
}

const classWords = (block: Element): string[] => attribute(block, "class").split(/\s+/u).filter(Boolean).flatMap((name) => name.split(/__|--/u));

/**
 * Doc 23 item 111: what the importer left as kept blocks in existing sites and the article blocks now say, ready to
 * replace them when the writer asks (never on its own: the look changes to the blocks' own). The list of attached
 * documents (a `…documenti` section of links, with its title) becomes a heading and a «Documento» block per file; the
 * source line (a paragraph `…fonte` holding one link) becomes a «Fonte» block. Anything else is not converted.
 */
function convertible(block: XbBlock, uid: string): ArticleBlock[] | null {
  if (!isElement(block)) return null;
  const tag = block.attrs.tag;
  if (tag === "p" && classWords(block).includes("fonte") && attributeNames(block).every((name) => name === "class")) {
    const link = soleLink(block);
    return link ? [{ type: "card", uid: `${uid}-fonte`, ref: "articolo/fonte", props: { label: link.text, link: link.href }, entries: [] }] : null;
  }
  if (!/^(?:section|div|aside)$/u.test(tag) || !(classWords(block).includes("documenti") || /documenti/iu.test(attribute(block, "aria-label")))) return null;
  if (!attributeNames(block).every((name) => name === "class" || name === "aria-label")) return null;
  const out: ArticleBlock[] = [];
  const children = solid(block.children);
  const first = children[0];
  if (first && isElement(first) && /^h[2-4]$/u.test(first.attrs.tag) && onlyClass(first)) {
    const title = linkText(first.children);
    if (title === null) return null;
    if (title) out.push({ type: "heading", uid: `${uid}-titolo`, level: Number(first.attrs.tag.charAt(1)) as 2 | 3 | 4, html: escapeText(title) });
    children.shift();
  }
  const list = children[0];
  if (children.length !== 1 || !list || !isElement(list) || !/^[uo]l$/u.test(list.attrs.tag) || !onlyClass(list)) return null;
  for (const item of solid(list.children)) {
    if (!isElement(item) || item.attrs.tag !== "li" || !onlyClass(item)) return null;
    const link = soleLink(item);
    if (!link) return null;
    out.push({ type: "card", uid: `${uid}-doc${out.length}`, ref: "articolo/documento", props: { label: link.text, href: link.href }, entries: [] });
  }
  return out.some((entry) => entry.type === "card") ? out : null;
}

function kept(block: XbBlock, uid: string): ArticleBlock {
  if (block.name === "xb/passthrough") {
    const name = /<!--\s*wp:(?:core\/)?([a-z0-9/-]+)/u.exec(block.raw)?.[1] ?? "";
    return { type: "kept", uid, label: `WordPress: ${name}`, summary: block.raw.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 140) };
  }
  const className = isElement(block) ? attribute(block, "class").split(/\s+/u)[0]?.split("__").pop()?.replaceAll("-", " ") : "";
  const label = isElement(block) ? attribute(block, "aria-label") || className || block.attrs.tag : block.name === "xb/text" ? "testo" : block.name.replace(/^xb\//u, "");
  const fields = keptFields(block);
  const convert = convertible(block, uid);
  return { type: "kept", uid, label, summary: plainText([block]).slice(0, 140), ...(fields.length ? { fields } : {}), ...(convert ? { convert } : {}) };
}

function keptFields(block: XbBlock): KeptField[] {
  const out: KeptField[] = [];
  const visit = (node: XbBlock): void => {
    if (out.length >= MAX_KEPT_FIELDS) return;
    if (node.name === "xb/text" && !node.attrs.verbatim && node.attrs.content.trim()) {
      const html = pieces(node.attrs.content, true);
      const value = html === null || html.includes("<") ? null : decodeText(html);
      if (value !== null) out.push({ uid: node.attrs.uid, kind: "text", value });
    }
    if (isElement(node) && node.attrs.tag === "a" && safeHref(attribute(node, "href")) && !/[{}]/u.test(attribute(node, "href"))) out.push({ uid: node.attrs.uid, kind: "link", value: attribute(node, "href") });
    if ("children" in node) for (const child of node.children as XbBlock[]) visit(child);
  };
  // Only an element is the site's own markup: a component or a block of WordPress has other ways to change.
  if (isElement(block)) visit(block);
  return out;
}

/** The kept tree with these texts and addresses: the same nodes, the same ids, nothing else touched. */
function withKeptFields(block: XbBlock, fields: KeptField[]): XbBlock {
  const changes = new Map(fields.map((field) => [`${field.kind}:${field.uid}`, field.value]));
  const visit = (node: XbBlock): XbBlock => {
    if (node.name === "xb/text") {
      const value = changes.get(`text:${node.attrs.uid}`);
      return value === undefined ? node : { ...node, attrs: { ...node.attrs, content: storedText(escapeText(value)) } } as XbBlock;
    }
    if (!isElement(node)) return node;
    const href = changes.get(`link:${node.attrs.uid}`);
    return { ...node, attrs: href === undefined ? node.attrs : { ...node.attrs, attributes: { ...node.attrs.attributes, href } }, children: (node.children ?? []).map(visit) } as XbBlock;
  };
  return visit(block);
}

interface Reading { document: ArticleDocument; originals: Map<string, XbBlock>; containers: Map<string, Element> }

function reading(content: string): Reading {
  const blocks: ArticleBlock[] = [];
  const originals = new Map<string, XbBlock>();
  const containers = new Map<string, Element>();
  const uidOf = (block: XbBlock): string => {
    const uid = "attrs" in block && typeof (block.attrs as { uid?: unknown }).uid === "string" ? (block.attrs as { uid: string }).uid : `kept-${originals.size}`;
    return uid;
  };
  const add = (block: XbBlock, container?: string): void => {
    const uid = uidOf(block);
    originals.set(uid, block);
    blocks.push({ ...(plain(block) ?? kept(block, uid)), ...(container ? { container } : {}) });
  };
  // Ids the document lacks are made up in order: reading it again gives the same ones, so a kept block is found.
  let made = 0;
  const madeUid = (): string => {
    made += 1;
    return `a${made.toString(16).padStart(9, "0")}`;
  };
  for (const block of solid(parseXb(content, madeUid).blocks)) {
    // A plain wrapper of the template's design: its text is the article, and the wrapper stays around it.
    if (isElement(block) && CONTAINER_TAGS.has(block.attrs.tag) && onlyClass(block)) {
      containers.set(block.attrs.uid, block);
      for (const child of solid(block.children)) add(child, block.attrs.uid);
    } else add(block);
  }
  return { document: { blocks, containers: [...containers.values()].map((block) => ({ uid: block.attrs.uid, tag: block.attrs.tag, className: attribute(block, "class") })) }, originals, containers };
}

export function readArticle(content: string): ArticleDocument {
  return reading(content).document;
}

function element(uid: string, tag: string, attributes: Record<string, string>, children: XbBlock[]): XbBlock {
  return { name: "xb/element", attrs: { uid, tag, ...(Object.keys(attributes).length ? { attributes } : {}) }, children } as XbBlock;
}
const textBlock = (uid: string, html: string): XbBlock => ({ name: "xb/text", attrs: { uid, content: storedText(html) } }) as XbBlock;

/** Whether two blocks say the same, wherever they stand: the keys of what the editor sends may come in any order. */
function same(left: ArticleBlock, right: ArticleBlock): boolean {
  const facts = (block: ArticleBlock): string => JSON.stringify(Object.entries(block).filter(([key]) => key !== "container").sort(([a], [b]) => a.localeCompare(b)));
  return facts(left) === facts(right);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Blocco dell'articolo non valido.");
  return value as Record<string, unknown>;
}

/** The blocks sent by the editor, checked: nothing here is trusted, and no markup comes through. */
function cleanBlock(value: unknown, mediaBase: string, rulesOf: (ref: string) => CardRules | null, knownImages: ReadonlySet<string>): ArticleBlock {
  const block = record(value);
  const uid = typeof block.uid === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(block.uid) ? block.uid : randomUid();
  const place = { uid, ...(typeof block.container === "string" ? { container: block.container } : {}) };
  const items = (): ArticleItem[] => {
    if (!Array.isArray(block.items) || !block.items.length || block.items.length > MAX_ARTICLE_BLOCKS) throw new TypeError("Elenco dell'articolo non valido.");
    return block.items.map((entry) => {
      const item = record(entry);
      return { uid: typeof item.uid === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(item.uid) ? item.uid : randomUid(), html: cleanHtml(item.html) };
    });
  };
  switch (block.type) {
    case "paragraph": return { ...place, type: "paragraph", html: cleanHtml(block.html) };
    case "heading":
      if (block.level !== 2 && block.level !== 3 && block.level !== 4) throw new TypeError("Livello del titolo non valido.");
      return { ...place, type: "heading", level: block.level, html: cleanHtml(block.html) };
    case "list": return { ...place, type: "list", ordered: block.ordered === true || block.notes === true, items: items(), ...(block.notes === true ? { notes: true } : {}) };
    case "quote": return { ...place, type: "quote", items: items() };
    case "separator": return { ...place, type: "separator" };
    case "card": return { ...place, type: "card", ...cleanCard(block, rulesOf, mediaBase, knownImages) };
    case "table": {
      if (!Array.isArray(block.rows) || !block.rows.length || block.rows.length > 500) throw new TypeError("Tabella dell'articolo non valida.");
      const rows = block.rows.map((row) => {
        if (!Array.isArray(row) || !row.length || row.length > 50) throw new TypeError("Tabella dell'articolo non valida.");
        return row.map((cell) => cleanHtml(cell));
      });
      if (rows.some((row) => row.length !== rows[0]?.length)) throw new TypeError("Le righe della tabella hanno lunghezze diverse.");
      return { ...place, type: "table", rows, header: block.header === true };
    }
    case "kept": {
      const fields = (Array.isArray(block.fields) ? block.fields : []).slice(0, MAX_KEPT_FIELDS).map((entry) => {
        const field = record(entry);
        if (typeof field.uid !== "string" || typeof field.value !== "string" || (field.kind !== "text" && field.kind !== "link") || Buffer.byteLength(field.value, "utf8") > MAX_TEXT_BYTES) throw new TypeError("Campo del blocco non valido.");
        if (field.kind === "link" && (!safeHref(field.value) || /[{}]/u.test(field.value))) throw new TypeError("Un collegamento del blocco non è valido.");
        return { uid: field.uid, kind: field.kind, value: field.value } as KeptField;
      });
      return { ...place, type: "kept", label: "", summary: "", fields };
    }
    case "image": {
      if (typeof block.src !== "string" || (!block.src.startsWith(`${mediaBase}/`) && !block.known)) throw new TypeError("Immagine dell'articolo non valida.");
      const size = (entry: unknown): number | null => (Number.isInteger(entry) && (entry as number) > 0 && (entry as number) < 100_000 ? entry as number : null);
      return { ...place, type: "image", src: block.src, alt: typeof block.alt === "string" ? block.alt.slice(0, 2000) : "", width: size(block.width), height: size(block.height), caption: block.caption ? cleanHtml(block.caption) : "" };
    }
    default: throw new TypeError("Tipo di blocco dell'articolo sconosciuto.");
  }
}

/**
 * The document with these blocks. `fallback` is the wrapper a first text goes into, the one other articles of the site
 * have: the template's styles expect it. Blocks left unchanged are the original ones, byte for byte.
 */
export function writeArticle(content: string, incoming: unknown, options: { mediaBase: string; fallback?: { tag: string; className: string } | null; rulesOf?: (ref: string) => CardRules | null }): string {
  if (!Array.isArray(incoming) || incoming.length > MAX_ARTICLE_BLOCKS) throw new TypeError("Blocchi dell'articolo non validi.");
  const { document, originals, containers } = reading(content);
  const rulesOf = options.rulesOf ?? (() => null);
  const known = new Map(document.blocks.map((block) => [block.uid, block]));
  const used = new Set<string>();
  const fresh = (uid: string): string => {
    const next = used.has(uid) ? randomUid() : uid;
    used.add(next);
    return next;
  };
  const originalTree = (uid: string): Element | null => {
    const block = originals.get(uid);
    return block && isElement(block) ? block : null;
  };
  /** A list's or quote's items, each kept when its text did not change. */
  const itemBlocks = (uid: string, tag: string, items: ArticleItem[], before: ArticleItem[]): XbBlock[] => {
    const children = solid(originalTree(uid)?.children);
    return items.map((item) => {
      const place = before.findIndex((entry) => entry.uid === item.uid && entry.html === item.html);
      const child = children[place];
      if (place >= 0 && child && isElement(child) && child.attrs.tag === tag && !used.has(item.uid)) { used.add(item.uid); return child; }
      const id = fresh(item.uid);
      const previous = children.find((entry) => isElement(entry) && entry.attrs.uid === item.uid);
      const text = previous && isElement(previous) ? solid(previous.children)[0] : undefined;
      return element(id, tag, {}, [textBlock(text?.name === "xb/text" ? text.attrs.uid : randomUid(), item.html)]);
    });
  };
  const classOf = (uid: string, tags: RegExp): Record<string, string> => {
    const tree = originalTree(uid);
    return tree && tags.test(tree.attrs.tag) && attribute(tree, "class") ? { class: attribute(tree, "class") } : {};
  };
  /** The text of a rewritten block keeps its id: translations are tied to it. */
  const textOf = (uid: string, html: string): XbBlock => {
    const child = solid(originalTree(uid)?.children)[0];
    return textBlock(child?.name === "xb/text" && !used.has(child.attrs.uid) ? child.attrs.uid : randomUid(), html);
  };
  const build = (block: ArticleBlock): XbBlock | null => {
    const before = known.get(block.uid);
    if (block.type === "kept") {
      const original = originals.get(block.uid);
      if (before?.type !== "kept" || !original || used.has(block.uid)) return null;
      used.add(block.uid);
      const known = new Map((before.fields ?? []).map((field) => [`${field.kind}:${field.uid}`, field.value]));
      const changed = (block.fields ?? []).filter((field) => known.has(`${field.kind}:${field.uid}`) && known.get(`${field.kind}:${field.uid}`) !== field.value);
      return changed.length ? withKeptFields(original, changed) : original;
    }
    if (before && !used.has(block.uid) && same(block, before)) {
      used.add(block.uid);
      return originals.get(block.uid) ?? null;
    }
    const uid = fresh(block.uid);
    switch (block.type) {
      case "paragraph":
        if (!block.html.replace(/<br>/gu, "").trim()) return null;
        return element(uid, "p", {}, [textOf(block.uid, block.html)]);
      case "heading":
        if (!block.html.trim()) return null;
        return element(uid, `h${block.level}`, { ...classOf(block.uid, /^h[2-4]$/u), ...(block.anchor ? { id: block.anchor } : {}) }, [textOf(block.uid, block.html)]);
      case "list": {
        const items = itemBlocks(block.uid, "li", block.items, before?.type === "list" ? before.items : []);
        if (!block.notes) return element(uid, block.ordered ? "ol" : "ul", {}, items);
        return element(uid, "ol", { class: "xb-art-note" }, items.map((item, position) => (isElement(item) ? { ...item, attrs: { ...item.attrs, attributes: { id: `nota-${position + 1}` } } } as XbBlock : item)));
      }
      case "quote": return element(uid, "blockquote", {}, itemBlocks(block.uid, "p", block.items, before?.type === "quote" ? before.items : []));
      case "separator": return element(uid, "hr", {}, []);
      case "card": return cardTree(block, uid, rulesOf(block.ref)?.rows);
      case "table": {
        const row = (cells: string[], tag: string): XbBlock => element(randomUid(), "tr", {}, cells.map((cell) => element(randomUid(), tag, {}, cell ? [textBlock(randomUid(), cell)] : [])));
        const [first, ...rest] = block.rows;
        const parts = [
          ...(block.header && first ? [element(randomUid(), "thead", {}, [row(first, "th")])] : []),
          element(randomUid(), "tbody", {}, (block.header ? rest : block.rows).map((cells) => row(cells, "td"))),
        ];
        return element(uid, "table", classOf(block.uid, /^table$/u), parts);
      }
      case "image": {
        const tree = originalTree(block.uid);
        const image = tree?.attrs.tag === "img" ? tree : solid(tree?.children).find((child): child is Element => isElement(child) && child.attrs.tag === "img");
        const attributes = {
          ...(image && attribute(image, "class") ? { class: attribute(image, "class") } : {}),
          src: block.src, alt: block.alt,
          ...(block.width ? { width: String(block.width) } : {}),
          ...(block.height ? { height: String(block.height) } : {}),
        };
        const children = [element(image?.attrs.uid ?? randomUid(), "img", attributes, [])];
        if (block.caption) children.push(element(randomUid(), "figcaption", {}, [textBlock(randomUid(), block.caption)]));
        return element(uid, "figure", classOf(block.uid, /^figure$/u), children);
      }
    }
  };
  const mediaBase = options.mediaBase;
  const clean = incoming.map((value) => {
    const entry = record(value);
    // An image already in the article keeps its address, whatever it is.
    const prior = typeof entry.uid === "string" ? known.get(entry.uid) : undefined;
    return cleanBlock(prior?.type === "image" && prior.src === entry.src ? { ...entry, known: true } : entry, mediaBase, rulesOf, new Set(prior?.type === "card" ? cardImages(prior, rulesOf) : []));
  });
  // The table of contents is made from the headings each time: it cannot go stale, and nobody writes it.
  const hasIndex = clean.some((block) => block.type === "card" && block.ref === ARTICLE_INDEX);
  if (hasIndex) {
    const anchors = new Set<string>();
    const rows: Card["entries"] = [];
    const earlier = document.blocks.find((block) => block.type === "card" && block.ref === ARTICLE_INDEX) as Card | undefined;
    for (const block of clean) {
      if (block.type !== "heading" || block.level > 3) continue;
      const title = block.html.replace(/<[^>]*>/gu, "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").trim();
      const base = title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "sezione";
      let anchor = base;
      for (let number = 2; anchors.has(anchor); number += 1) anchor = `${base}-${number}`;
      anchors.add(anchor);
      block.anchor = anchor;
      rows.push({ uid: earlier?.entries[rows.length]?.uid ?? randomUid(), props: { title, link: `#${anchor}` } });
    }
    for (const block of clean) if (block.type === "card" && block.ref === ARTICLE_INDEX) block.entries = rows;
  }
  const out: XbBlock[] = [];
  let open = null as { key: string; children: XbBlock[] } | null;
  const fallback = options.fallback && !originals.size ? options.fallback : null;
  const seen = new Set<string>();
  const notes = noteReturns(clean);
  const withReturns = (block: ArticleBlock, built: XbBlock): XbBlock => {
    if (!isElement(built)) return built;
    if (block.type === "paragraph") {
      const anchor = notes.anchorOf(block);
      return { ...built, attrs: { ...built.attrs, attributes: anchor ? { id: anchor } : {} } } as XbBlock;
    }
    if (block.type !== "list" || !block.notes) return built;
    return { ...built, children: (built.children ?? []).map((item, position) => {
      if (!isElement(item)) return item;
      const back = notes.returnOf(position + 1);
      const children = solid(item.children).map((child) => {
        if (child.name !== "xb/text") return child;
        const text = child.attrs.content.replace(NOTE_RETURN, "");
        return { ...child, attrs: { ...child.attrs, content: back ? `${text} <a href="#${back}">↩</a>` : text } } as XbBlock;
      });
      return { ...item, children };
    }) } as XbBlock;
  };
  for (const block of clean) {
    const made = build(block);
    if (!made) continue;
    const built = withReturns(block, made);
    const key = block.container && containers.has(block.container) ? block.container : fallback ? "fallback" : "";
    if (!key) { open = null; out.push(built); continue; }
    if (open?.key !== key) {
      open = { key, children: [] };
      const wrapper = containers.get(key);
      const uid = wrapper && !seen.has(key) ? wrapper.attrs.uid : randomUid();
      seen.add(key);
      const className = wrapper ? attribute(wrapper, "class") : fallback?.className ?? "";
      out.push(element(uid, wrapper?.attrs.tag ?? fallback?.tag ?? "div", className ? { class: className } : {}, open.children));
    }
    open.children.push(built);
  }
  return serializeXb(out);
}
