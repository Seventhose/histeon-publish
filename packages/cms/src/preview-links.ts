import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MATHML = "http://www.w3.org/1998/Math/MathML";

/** Elements that a document's named properties expose by `name` (DOM clobbering of the page's script). */
const NAMED = new Set(["img", "embed", "object", "form", "iframe"]);
/** SVG elements that could set a link's address after the page is written. */
const ANIMATIONS = new Set(["set", "animate"]);
/**
 * Elements whose content the HTML parsers do not agree on (Chromium's newer <select> keeps links that parse5 drops): a
 * page with them is refused rather than guessed. The renderer never writes them today.
 */
const UNSURE = new Set(["select", "option", "optgroup", "datalist"]);
/** CSS attribute selectors on href: in the preview the address is in data-histos-href. */
const HREF_SELECTOR = /\[(\s*)((?:[\w-]+|\*)?\|)?href(?=\s*[\]=~|^$*])/giu;

interface Edit {
  start: number;
  end: number;
  text: string;
}

const attributeText = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/**
 * A rendered page for a preview that must never leave it (the proposals page, queue A4). Each link keeps an `href`, so
 * `:link` and `:any-link` styles stay the same, but it points at a fragment; the real address moves to
 * `data-histos-href`, for the page's own script to follow, and CSS selectors on `[href]` follow it there. Activating a
 * link without the script (a middle click, «Apri in una nuova scheda», dragging) can only reach the proposals page
 * itself. `ping` goes; `target` and `download` stay, for the styles, and do nothing in a frame without popups or
 * downloads.
 *
 * The page is parsed as the preview frame parses it (scripting off, so `<noscript>` holds markup), and only the
 * affected bytes change: everything else is the build's output, byte for byte, and no parse5 tree survives the call.
 * What the renderer never writes and could hide an address is refused (a TypeError, for the caller to name the page)
 * or switched off: a repeated attribute or two with no space between them, a <select>, MathML, HTML inside SVG (where
 * parse5 and browsers close elements differently), a declarative shadow root.
 */
export function inertPreviewLinks(html: string): string {
  let unclear: { code: string; at: number } | null = null;
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: false,
    onParseError: (error) => {
      if (error.code === "duplicate-attribute" || error.code === "missing-whitespace-between-attributes") unclear ??= { code: error.code, at: error.startOffset };
    },
  });
  // Of two equal attributes the browser keeps the first, and two attributes run together end where the browser says:
  // what a rewrite would remove there is a guess.
  if (unclear !== null) {
    const { code, at } = unclear as { code: string; at: number };
    throw new TypeError(`Anteprima: ${code === "duplicate-attribute" ? "un attributo ripetuto" : "due attributi senza spazio fra loro"} nello stesso tag (carattere ${at}).`);
  }
  const edits: Edit[] = [];
  // The parser re-creates a formatting element (an <a> around a block) with the same source tag: one edit per tag.
  const handled = new Set<number>();
  /** Each node, and whether it sits inside SVG. */
  const stack: Array<[Node, boolean]> = [[document, false]];
  while (stack.length) {
    const [node, inSvg] = stack.pop() as [Node, boolean];
    let skipChildren = false;
    let childrenInSvg = inSvg;
    if ("tagName" in node) {
      const element = node as Element;
      const location = element.sourceCodeLocation;
      const tag = element.tagName.toLowerCase();
      if (element.namespaceURI === MATHML) throw new TypeError("Anteprima: MathML non è ammesso nelle anteprime.");
      // An HTML element inside SVG (in <title>, <desc>, <foreignObject>) is where parse5 and browsers may close
      // elements differently, and so build different links.
      if (element.namespaceURI === HTML && inSvg) throw new TypeError(`Anteprima: <${tag}> dentro un SVG non è ammesso nelle anteprime.`);
      if (element.namespaceURI === SVG) childrenInSvg = true;
      const attribute = (name: string, prefix?: string) => element.attrs.find((item) => item.name === name && (prefix === undefined ? !item.prefix : item.prefix === prefix));
      // After a "/" a space stays, or "/>" would make a foreign element self-closing; elsewhere nothing stays. The last
      // attribute of a tag takes the white space before it too: a CR left just before ">" makes Chromium drop the line
      // break after the tag. An attribute written with no value and then "=" takes the "=" with it.
      const remove = (key: string) => {
        const range = location?.attrs?.[key];
        const startTag = location?.startTag;
        if (!range || !startTag) return;
        const nameEnd = startTag.startOffset + 1 + element.tagName.length;
        const valueless = !html.slice(range.startOffset, range.endOffset).includes("=");
        const equals = valueless ? /^[\t\n\f\r ]*=(?=[\t\n\f\r ]*(?:\/?>|$))/u.exec(html.slice(range.endOffset, startTag.endOffset)) : null;
        const end = range.endOffset + (equals ? equals[0].length : 0);
        let start = range.startOffset;
        if (/^[\t\n\f\r ]*\/?>$/u.test(html.slice(end, startTag.endOffset))) while (start > nameEnd && /[\t\n\f\r ]/u.test(html[start - 1] ?? "")) start--;
        edits.push({ start, end, text: html[start - 1] === "/" ? " " : "" });
      };
      if (element.namespaceURI === HTML && UNSURE.has(tag)) throw new TypeError(`Anteprima: <${tag}> non è ammesso nelle anteprime.`);
      const startTag = location?.startTag?.startOffset;
      if (location && startTag !== undefined && handled.has(startTag)) {
        // A copy the parser made: the source tag is already rewritten.
      } else if (location) {
        if (startTag !== undefined) handled.add(startTag);
        const isLink = (element.namespaceURI === HTML && (tag === "a" || tag === "area")) || (element.namespaceURI === SVG && tag === "a");
        if (element.namespaceURI === SVG && ANIMATIONS.has(tag) && /^(?:xlink:)?href$/iu.test(attribute("attributeName")?.value.trim() ?? "")) {
          // An animation that would set an address: the whole element goes.
          edits.push({ start: location.startOffset, end: location.endOffset, text: "" });
          skipChildren = true;
        } else if (isLink) {
          // In SVG, href wins over xlink:href; on an HTML element xlink:href is no link and stays.
          const target = attribute("href")?.value ?? (element.namespaceURI === SVG ? attribute("href", "xlink")?.value : undefined);
          for (const key of ["href", "ping", "data-histos-href", ...(element.namespaceURI === SVG ? ["xlink:href"] : [])]) remove(key);
          if (target !== undefined && location.startTag) {
            // Right after the tag name: these come first, so a repeated href later in the tag is ignored by the browser.
            const at = location.startTag.startOffset + 1 + element.tagName.length;
            edits.push({ start: at, end: at, text: ` href="#histos-preview-link" data-histos-href="${attributeText(target)}"` });
          }
        }
        if (element.namespaceURI === HTML && NAMED.has(tag)) remove("name");
        // A declarative shadow root hides its links from the page's script: the template stays a template.
        if (element.namespaceURI === HTML && tag === "template") for (const key of ["shadowrootmode", "shadowroot"]) remove(key);
        if (tag === "style") {
          for (const child of element.childNodes) {
            const range = child.sourceCodeLocation;
            if (child.nodeName !== "#text" || !range) continue;
            const css = html.slice(range.startOffset, range.endOffset);
            const rewritten = css.replace(HREF_SELECTOR, "[$1$2data-histos-href");
            if (rewritten !== css) edits.push({ start: range.startOffset, end: range.endOffset, text: rewritten });
          }
        }
      }
    }
    if (skipChildren) continue;
    // One at a time: a spread of a huge sibling list would overflow the call stack.
    const children = "childNodes" in node ? node.childNodes : [];
    for (let index = children.length - 1; index >= 0; index--) stack.push([children[index] as Node, childrenInSvg]);
    const content = "content" in node ? (node as DefaultTreeAdapterMap["template"]).content : null;
    if (content) for (let index = content.childNodes.length - 1; index >= 0; index--) stack.push([content.childNodes[index] as Node, childrenInSvg]);
  }
  if (edits.length === 0) return html;
  edits.sort((left, right) => left.start - right.start || left.end - right.end);
  const parts: string[] = [];
  let from = 0;
  for (const edit of edits) {
    // Edits never overlap: attributes, an insertion before them, a style's text, a removed element without inner edits.
    if (edit.start < from) throw new Error("Anteprima: modifiche dei link sovrapposte.");
    parts.push(html.slice(from, edit.start), edit.text);
    from = edit.end;
  }
  parts.push(html.slice(from));
  // join gives one flat string: nothing of the original slices is kept alive through a rope.
  return parts.join("");
}
