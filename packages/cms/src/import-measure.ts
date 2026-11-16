import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";
import { childrenOf, parse as parseDsl, type XbBlock } from "../.generated/histos-dsl/index.js";

/**
 * How much of a site stays clickable after the conversion (doc 18 §9, the importer's measure of quality): the
 * elements of the original pages against the `xb/element` blocks of the converted pages. Only those carry
 * `data-xb-uid` in the builder's canvas. An element dropped, unwrapped or folded into a text run is lost to the
 * canvas, and so is one moved into a part or a component (the page shows it, the page document does not have it).
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** Inline formatting the builder keeps in a text run (doc 18 §6.3): inside a sentence it is text, not an element. */
const INLINE = new Set(["a", "abbr", "b", "code", "em", "i", "kbd", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);
/** Elements that are not page content, or never selectable on their own. */
const NOT_CONTENT = new Set(["script", "style", "noscript", "template", "link", "meta", "base", "title", "head", "br", "wbr"]);
const SVG_INSIDE = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "g", "title", "desc", "defs", "use", "symbol", "stop", "lineargradient", "radialgradient", "clippath", "mask"]);

export interface SelectableMeasure {
  /** Elements in the original pages (body only, without scripts, styles and line breaks). */
  original: number;
  /** `xb/element` blocks in the converted pages. */
  selectable: number;
  /** selectable / original, 0-1 (1 when the site has no element). */
  share: number;
}

/**
 * Counts the content elements of an HTML page: the body's, without scripts, styles, line breaks or SVG drawing parts,
 * and without the inline formatting of a sentence (an inline tag with no class or id whose parent has text of its
 * own): the builder edits that as text, in place, by design.
 */
export function countOriginalElements(html: string): number {
  return countOriginalParts(html).required;
}

/**
 * V5.3c: the elements of a page as countOriginalElements counts them (`required`), and apart the inline tags of a
 * sentence it leaves out (`inSentence`): the conversion may still make one selectable (a link the CSS styles gets a
 * class), and measureSelectable then counts it in the total too.
 */
export function countOriginalParts(html: string): { required: number; inSentence: number } {
  const document = parseHtml(html);
  const html_ = document.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "html");
  const body = html_?.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "body");
  let count = 0;
  let inSentenceCount = 0;
  const walk = (node: Node, inSvg: boolean): void => {
    if (!("tagName" in node)) return;
    const tag = node.tagName.toLowerCase();
    if (NOT_CONTENT.has(tag)) return;
    const parent = node.parentNode as Element | null;
    const inSentence = INLINE.has(tag) && !node.attrs.some((attribute) => attribute.name === "class" || attribute.name === "id")
      && (parent?.childNodes ?? []).some((sibling) => sibling.nodeName === "#text" && (sibling as DefaultTreeAdapterMap["textNode"]).value.trim() !== "");
    if (!(inSvg && SVG_INSIDE.has(tag))) {
      if (inSentence) inSentenceCount++;
      else count++;
    }
    for (const child of node.childNodes ?? []) walk(child, inSvg || tag === "svg");
    if (tag === "template" && "content" in node) for (const child of (node as unknown as { content: { childNodes: Node[] } }).content.childNodes) walk(child, inSvg);
  };
  for (const child of body?.childNodes ?? []) walk(child, false);
  return { required: count, inSentence: inSentenceCount };
}

/** Counts the `xb/element` blocks of the converted pages of a prototype (its `template[data-histos=page|post]`). */
export function countSelectableElements(prototypeHtml: string): number {
  const document = parseHtml(prototypeHtml, { sourceCodeLocationInfo: true });
  let count = 0;
  const countBlocks = (blocks: readonly XbBlock[], inSvg: boolean): void => {
    for (const block of blocks) {
      const tag = block.name === "xb/element" ? block.attrs.tag.toLowerCase() : "";
      if (block.name === "xb/element" && !(inSvg && SVG_INSIDE.has(tag))) count++;
      countBlocks(childrenOf(block), inSvg || tag === "svg");
    }
  };
  const visit = (node: Node): void => {
    if (!("tagName" in node)) return;
    if (node.tagName === "template") {
      const kind = node.attrs.find((attr) => attr.name === "data-histos")?.value;
      if (kind === "page" || kind === "post") {
        const source = templateSource(prototypeHtml, node);
        countBlocks(parseDsl(source).blocks, false);
      }
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  for (const child of document.childNodes) visit(child);
  return count;
}

/** The text between a template's tags, as written (the DSL reads it, not the HTML parser). */
function templateSource(html: string, node: Element): string {
  const location = node.sourceCodeLocation;
  if (location?.startTag && location.endTag) return html.slice(location.startTag.endOffset, location.endTag.startOffset);
  return "";
}

/**
 * The measure over a whole site: its pages (without `404`), against the converted prototype. The two counts agree
 * (V5.3c): the inline tags of a sentence join the total only as far as the converted pages have more selectable
 * elements than the required ones, and `selectable` is never more than the total («70 su 69» could not be true).
 */
export function measureSelectable(pages: readonly string[], prototypeHtml: string): SelectableMeasure {
  let required = 0;
  let inSentence = 0;
  for (const html of pages) {
    const parts = countOriginalParts(html);
    required += parts.required;
    inSentence += parts.inSentence;
  }
  const converted = countSelectableElements(prototypeHtml);
  const original = required + Math.min(inSentence, Math.max(0, converted - required));
  const selectable = Math.min(converted, original);
  return { original, selectable, share: original === 0 ? 1 : selectable / original };
}
