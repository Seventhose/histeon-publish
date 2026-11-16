import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { ArticleBlock, ArticleItem } from "./article-document.js";

/**
 * A WordPress export file (WXR, Strumenti → Esporta), read for a site that has no Histeon plugin. The file is hostile
 * like any other: no DOCTYPE or entities, size limits, and its HTML only reaches the project as article blocks, so nothing
 * of it runs. What has no place in a block (forms, embeds, shortcodes) is counted and said, never dropped in silence.
 */

export const MAX_WXR_BYTES = 256 * 1024 * 1024;
const MAX_WXR_ITEMS = 50_000;
const MAX_ITEM_BYTES = 8 * 1024 * 1024;

export interface WxrTerm { kind: "category" | "post_tag"; slug: string; name: string; parent: string }
export interface WxrItem {
  id: string;
  type: string;
  title: string;
  slug: string;
  status: string;
  /** ISO, in UTC; null when the post was never published. */
  date: string | null;
  excerpt: string;
  content: string;
  terms: Array<{ kind: "category" | "post_tag"; slug: string }>;
  attachmentUrl: string;
  thumbnailId: string;
  /** From Yoast or Rank Math, when the site has them. */
  seoTitle?: string;
  seoDescription?: string;
}
export interface WxrFile { title: string; link: string; language: string; terms: WxrTerm[]; items: WxrItem[] }

const unescapeXml = (value: string): string => value.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/giu, (whole, name: string) => {
  const lower = name.toLowerCase();
  if (lower.startsWith("#")) {
    const code = lower[1] === "x" ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[lower] ?? whole;
});

/** The text of a value: its CDATA, in as many pieces as WordPress cut it, or escaped text. */
function textOf(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("<![CDATA[")) return unescapeXml(trimmed);
  let out = "";
  let at = 0;
  while (at < trimmed.length) {
    const open = trimmed.indexOf("<![CDATA[", at);
    if (open < 0) break;
    const close = trimmed.indexOf("]]>", open + 9);
    if (close < 0) throw new TypeError("Il file di WordPress ha un blocco CDATA non chiuso.");
    out += trimmed.slice(open + 9, close);
    at = close + 3;
  }
  return out;
}

/** The first `<tag …>…</tag>` in order, by scanning: the file is large, and a regular expression would backtrack on it. */
function* elements(source: string, tag: string): Generator<{ attributes: string; body: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    let start = source.indexOf(open, at);
    while (start >= 0 && !/[\s>/]/u.test(source.charAt(start + open.length))) start = source.indexOf(open, start + open.length);
    if (start < 0) return;
    const headEnd = source.indexOf(">", start);
    if (headEnd < 0) return;
    if (source.charAt(headEnd - 1) === "/") {
      yield { attributes: source.slice(start + open.length, headEnd - 1), body: "" };
      at = headEnd + 1;
      continue;
    }
    let cursor = headEnd + 1;
    // A closing tag inside CDATA is text: the content of a post may well quote one.
    let end = source.indexOf(close, cursor);
    let cdata = source.indexOf("<![CDATA[", cursor);
    while (cdata >= 0 && end >= 0 && cdata < end) {
      const cdataEnd = source.indexOf("]]>", cdata);
      if (cdataEnd < 0) return;
      cursor = cdataEnd + 3;
      end = source.indexOf(close, cursor);
      cdata = source.indexOf("<![CDATA[", cursor);
    }
    if (end < 0) return;
    yield { attributes: source.slice(start + open.length, headEnd), body: source.slice(headEnd + 1, end) };
    at = end + close.length;
  }
}
function field(source: string, tag: string): string {
  for (const element of elements(source, tag)) return textOf(element.body);
  return "";
}
const attribute = (attributes: string, name: string): string => unescapeXml(new RegExp(`\\s${name}="([^"]*)"`, "u").exec(attributes)?.[1] ?? "");

/** A title or description of an SEO plugin, unless it is a pattern to fill in (`%%title%%`, `%sitename%`). */
const plainSeo = (value: string | undefined): string => (value && !value.includes("%") ? value : "");

/** Whether a text is a WordPress export, without reading it all. */
export function isWxr(text: string): boolean {
  const head = text.slice(0, 16 * 1024);
  return /<rss[\s>]/u.test(head) && /wordpress\.org\/export\//u.test(head);
}

export function parseWxr(text: string): WxrFile {
  if (Buffer.byteLength(text, "utf8") > MAX_WXR_BYTES) throw new RangeError("Il file di WordPress supera i 256 MB.");
  if (!isWxr(text)) throw new TypeError("Questo file non è un'esportazione di WordPress.");
  const firstItem = text.indexOf("<item>");
  const head = firstItem < 0 ? text : text.slice(0, firstItem);
  if (/<!DOCTYPE|<!ENTITY/iu.test(head)) throw new TypeError("Il file di WordPress contiene una dichiarazione non ammessa.");
  const terms: WxrTerm[] = [];
  for (const { body } of elements(head, "wp:category")) terms.push({ kind: "category", slug: field(body, "wp:category_nicename"), name: field(body, "wp:cat_name"), parent: field(body, "wp:category_parent") });
  for (const { body } of elements(head, "wp:tag")) terms.push({ kind: "post_tag", slug: field(body, "wp:tag_slug"), name: field(body, "wp:tag_name"), parent: "" });
  const items: WxrItem[] = [];
  for (const { body } of elements(text, "item")) {
    if (items.length >= MAX_WXR_ITEMS) throw new RangeError("Il file di WordPress supera i 50 000 contenuti.");
    if (Buffer.byteLength(body, "utf8") > MAX_ITEM_BYTES) continue;
    const metadata = new Map<string, string>();
    for (const meta of elements(body, "wp:postmeta")) metadata.set(field(meta.body, "wp:meta_key"), field(meta.body, "wp:meta_value"));
    const itemTerms: WxrItem["terms"] = [];
    for (const category of elements(body, "category")) {
      const domain = attribute(category.attributes, "domain");
      const slug = attribute(category.attributes, "nicename");
      if ((domain === "category" || domain === "post_tag") && slug) itemTerms.push({ kind: domain, slug });
    }
    const gmt = field(body, "wp:post_date_gmt");
    items.push({
      id: field(body, "wp:post_id"), type: field(body, "wp:post_type"), title: field(body, "title"), slug: field(body, "wp:post_name"), status: field(body, "wp:status"),
      date: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(gmt) && !gmt.startsWith("0000") ? `${gmt.replace(" ", "T")}Z` : null,
      excerpt: field(body, "excerpt:encoded"), content: field(body, "content:encoded"), terms: itemTerms, attachmentUrl: field(body, "wp:attachment_url"), thumbnailId: metadata.get("_thumbnail_id") ?? "",
      seoTitle: plainSeo(metadata.get("_yoast_wpseo_title") ?? metadata.get("rank_math_title")),
      seoDescription: plainSeo(metadata.get("_yoast_wpseo_metadesc") ?? metadata.get("rank_math_description")),
    });
  }
  return { title: field(head, "title"), link: field(head, "link"), language: field(head, "language"), terms, items };
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const isElement = (node: Node): node is Element => "tagName" in node;
const isText = (node: Node): node is DefaultTreeAdapterMap["textNode"] => node.nodeName === "#text";
const attr = (node: Element, name: string): string => node.attrs.find((entry) => entry.name === name)?.value ?? "";

const FORMATS: Record<string, string> = { strong: "strong", b: "strong", em: "em", i: "em", u: "u", s: "s", del: "s", strike: "s", code: "code", sub: "sub", sup: "sup" };
const BLOCKS = /^(?:p|div|h[1-6]|ul|ol|blockquote|figure|table|hr|pre|section|article|aside|header|footer|main|form|iframe|video|audio|embed|object|details)$/u;
const WRAPPERS = new Set(["div", "section", "article", "aside", "header", "footer", "main", "center", "span", "font", "details", "figcaption"]);
const DROPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "link", "meta"]);
const LOST = new Set(["embed", "object", "form", "canvas"]);
const EMBEDS = new Set(["iframe", "video", "audio"]);
const safeHref = (href: string): boolean => /^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#)/iu.test(href) && !/[\s\p{Cc}]/u.test(href);
const escapeText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export interface ArticleConversion {
  blocks: ArticleBlock[];
  /** What has no place in an article, by name, with how many times. */
  lost: Record<string, number>;
  /** Addresses of the images it uses, to fetch. */
  images: string[];
}

/** Paragraphs of the classic editor are blank lines: WordPress turns them into `<p>` only when it prints the page. */
function autoParagraphs(html: string): string {
  if (/<(?:p|div|h[1-6]|ul|ol|table|blockquote|figure)[\s>]/iu.test(html)) return html;
  return html.split(/\n\s*\n/u).map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => `<p>${chunk.replaceAll("\n", "<br>")}</p>`).join("");
}

/** The blocks of a post's HTML, from the block editor or the classic one: its `<!-- wp:… -->` comments are only comments here. */
export function articleFromHtml(html: string): ArticleConversion {
  const blocks: ArticleBlock[] = [];
  const lost: Record<string, number> = {};
  const images: string[] = [];
  const lose = (name: string): void => { lost[name] = (lost[name] ?? 0) + 1; };
  let pending = "";
  const flush = (): void => {
    const text = pending.replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/gu, "");
    if (text.replace(/<[^>]*>/gu, "").trim()) {
      // Lowercase, as WordPress's own: «[Anna 00:12]» in a transcript is text.
      if (/\[[a-z][a-z0-9_-]*(?:\s[^\]]*)?\]/u.test(text)) lose("shortcode");
      blocks.push({ type: "paragraph", uid: "", html: text });
    }
    pending = "";
  };
  const addImage = (image: Element, caption = ""): void => {
    const src = attr(image, "src").replace(/^\/\//u, "https://");
    if (!/^https?:\/\//iu.test(src)) { lose("immagine"); return; }
    images.push(src);
    const size = (name: string): number | null => { const value = Number(attr(image, name)); return Number.isInteger(value) && value > 0 && value < 100_000 ? value : null; };
    blocks.push({ type: "image", uid: "", src, alt: attr(image, "alt").slice(0, 2000), width: size("width"), height: size("height"), caption });
  };
  /** A player of the old site as the block that leads to it, so that a video is not lost; what has no block is. */
  const addEmbed = (node: Element): void => {
    const first = (name: string): Element | undefined => node.childNodes.find((child): child is Element => isElement(child) && child.tagName === name);
    const src = (attr(node, "src") || (first("source") ? attr(first("source")!, "src") : "")).replace(/^\/\//u, "https://");
    const title = attr(node, "title").slice(0, 300);
    const named = (url: string): string => title || decodeURIComponent(url.split(/[?#]/u)[0]?.split("/").pop() ?? "") || "Video";
    const youtube = /^https:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,})/iu.exec(src)?.[1];
    const vimeo = /^https:\/\/player\.vimeo\.com\/video\/(\d+)/iu.exec(src)?.[1];
    const card = (ref: string, url: string): void => { blocks.push({ type: "card", uid: "", ref, props: { url, title: named(url) }, entries: [] }); };
    if (youtube) card("articolo/video", `https://www.youtube.com/watch?v=${youtube}`);
    else if (vimeo) card("articolo/video", `https://vimeo.com/${vimeo}`);
    else if (node.tagName === "video" && /^https:\/\//iu.test(src)) card("articolo/video", src);
    else if (node.tagName === "audio" && /^https:\/\//iu.test(src)) card("articolo/audio", src);
    else lose(node.tagName);
  };
  /** Inline HTML of what is inside an element: formats kept, the rest unwrapped; an image closes the text around it. */
  const inline = (nodes: Node[], splitImages: boolean): string => {
    let out = "";
    for (const node of nodes) {
      if (isText(node)) out += escapeText(node.value);
      else if (isElement(node)) {
        const tag = node.tagName;
        if (DROPPED.has(tag)) continue;
        if (EMBEDS.has(tag)) {
          if (splitImages) { pending += out; out = ""; flush(); addEmbed(node); } else lose(tag);
          continue;
        }
        if (LOST.has(tag)) { lose(tag); continue; }
        if (tag === "br") out += "<br>";
        else if (tag === "img") {
          if (splitImages) { pending += out; out = ""; flush(); addImage(node); }
        } else if (tag === "a" && safeHref(attr(node, "href"))) {
          const inner = inline(node.childNodes, splitImages);
          if (inner.replace(/<[^>]*>/gu, "").trim()) out += `<a href="${escapeText(attr(node, "href")).replaceAll("\"", "&quot;")}">${inner}</a>`;
          else out += inner;
        } else if (FORMATS[tag]) {
          const inner = inline(node.childNodes, splitImages);
          if (inner.trim()) out += `<${FORMATS[tag]}>${inner}</${FORMATS[tag]}>`;
        } else out += inline(node.childNodes, splitImages);
      }
    }
    return out;
  };
  const items = (node: Element, tag: string): ArticleItem[] => node.childNodes.filter((child): child is Element => isElement(child) && child.tagName === tag).map((child) => ({ uid: "", html: inline(child.childNodes.filter((entry) => !(isElement(entry) && /^[uo]l$/u.test(entry.tagName))), false).trim() })).filter((item) => item.html);
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (isText(node)) { pending += escapeText(node.value); continue; }
      if (!isElement(node)) continue;
      const tag = node.tagName;
      if (DROPPED.has(tag)) continue;
      if (EMBEDS.has(tag)) { flush(); addEmbed(node); continue; }
      if (LOST.has(tag)) { flush(); lose(tag); continue; }
      if (!BLOCKS.test(tag) && !WRAPPERS.has(tag) && tag !== "img" && !(tag === "a" && node.childNodes.some((child) => isElement(child) && child.tagName === "img"))) {
        pending += inline([node], false);
        continue;
      }
      if (tag === "span" || tag === "font" || tag === "center") { walk(node.childNodes); continue; }
      flush();
      if (tag === "p") { pending += inline(node.childNodes, true); flush(); }
      else if (/^h[1-6]$/u.test(tag)) {
        const text = inline(node.childNodes, false).trim();
        if (text) blocks.push({ type: "heading", uid: "", level: Math.min(4, Math.max(2, Number(tag.charAt(1)))) as 2 | 3 | 4, html: text });
      } else if (tag === "ul" || tag === "ol") {
        const list = items(node, "li");
        if (list.length) blocks.push({ type: "list", uid: "", ordered: tag === "ol", items: list });
      } else if (tag === "blockquote") {
        const paragraphs = node.childNodes.filter((child): child is Element => isElement(child) && child.tagName === "p");
        const quoted = (paragraphs.length ? paragraphs.map((child) => inline(child.childNodes, false).trim()) : [inline(node.childNodes, false).trim()]).filter(Boolean).map((text) => ({ uid: "", html: text }));
        if (quoted.length) blocks.push({ type: "quote", uid: "", items: quoted });
      } else if (tag === "hr") blocks.push({ type: "separator", uid: "" });
      else if (tag === "pre") {
        const text = inline(node.childNodes, false).trim();
        if (text) blocks.push({ type: "paragraph", uid: "", html: `<code>${text.replace(/<[^>]*>/gu, "").replaceAll("\n", "<br>")}</code>` });
      } else if (tag === "img") addImage(node);
      else if (tag === "a") { const image = node.childNodes.find((child): child is Element => isElement(child) && child.tagName === "img"); if (image) addImage(image); }
      else if (tag === "figure") {
        const found: Element[] = [];
        const look = (list: Node[]): void => { for (const entry of list) if (isElement(entry)) { if (entry.tagName === "img") found.push(entry); else look(entry.childNodes); } };
        look(node.childNodes);
        const caption = node.childNodes.find((child): child is Element => isElement(child) && child.tagName === "figcaption");
        if (!found.length) walk(node.childNodes);
        for (const [position, image] of found.entries()) addImage(image, position === 0 && caption ? inline(caption.childNodes, false).trim() : "");
      } else if (tag === "table") {
        const rows: Element[] = [];
        const look = (list: Node[]): void => { for (const entry of list) if (isElement(entry)) { if (entry.tagName === "tr") rows.push(entry); else look(entry.childNodes); } };
        look(node.childNodes);
        // A plain grid is a table of the editor; one with joined cells has no such form, and its rows become lines.
        const grid = rows.map((row) => row.childNodes.filter((cell): cell is Element => isElement(cell) && (cell.tagName === "td" || cell.tagName === "th")));
        if (grid.length && grid[0]?.length && grid.every((cells) => cells.length === grid[0]?.length && cells.every((cell) => !attr(cell, "colspan") && !attr(cell, "rowspan")))) {
          blocks.push({ type: "table", uid: "", rows: grid.map((cells) => cells.map((cell) => inline(cell.childNodes, false).trim())), header: grid[0]?.every((cell) => cell.tagName === "th") ?? false });
          flush();
          continue;
        }
        lose("tabella");
        for (const row of rows) {
          const cells = row.childNodes.filter((cell): cell is Element => isElement(cell) && (cell.tagName === "td" || cell.tagName === "th")).map((cell) => inline(cell.childNodes, false).trim()).filter(Boolean);
          if (cells.length) blocks.push({ type: "paragraph", uid: "", html: cells.join(" · ") });
        }
      } else walk(node.childNodes);
      flush();
    }
  };
  walk(parseFragment(autoParagraphs(html.replace(/<!--[\s\S]*?-->/gu, ""))).childNodes);
  flush();
  return { blocks, lost, images: [...new Set(images)] };
}
