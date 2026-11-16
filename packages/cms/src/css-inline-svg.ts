import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { bytesFromBase64 } from "./isomorphic.js";

/**
 * A drawing a stylesheet carries inside itself, `url("data:image/svg+xml,…")`: the grain of a background, a wave, the
 * arrow of a select. A browser shows such an image without running its scripts and without loading anything it names,
 * and a transfer accepts a `data:` reference in a sheet (css-resources.ts, CssAssets.php). The conversion still trusts
 * nothing: the drawing stays only if every element and attribute is of a closed list of static ones, and it is
 * written again from its text, so what goes into the sheet has one known shape.
 */

type Node = DefaultTreeAdapterMap["node"];

/** A drawing of a sheet is small: past this it goes. */
const MAX_INLINE_SVG_BYTES = 64 * 1024;
const MAX_INLINE_SVG_ELEMENTS = 2_000;

/** Static shapes, their paint servers, clips, masks, filters and text. No script, link, image, style or animation. */
const ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "text", "tspan", "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "filter", "feblend",
  "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix", "fediffuselighting", "fedisplacementmap",
  "fedistantlight", "fedropshadow", "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "femerge",
  "femergenode", "femorphology", "feoffset", "fepointlight", "fespecularlighting", "fespotlight", "fetile", "feturbulence",
]);
/** The only attributes with a prefix, and the namespaces a drawing may declare. */
const PREFIXED = new Set(["xlink:href", "xml:space", "xml:lang"]);
const NAMESPACES: Readonly<Record<string, string>> = { xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink" };

/** The text of an SVG data URL (percent-encoded or base64), or null when it is not one or does not decode. */
function svgText(reference: string): string | null {
  const match = /^data:image\/svg\+xml((?:;[a-z0-9=-]+)*),([\s\S]*)$/iu.exec(reference.trim());
  if (!match) return null;
  const payload = match[2] ?? "";
  if (payload.length > MAX_INLINE_SVG_BYTES * 3) return null;
  try {
    if (/;base64$/iu.test(match[1] ?? "")) {
      const bytes = bytesFromBase64(payload);
      return bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** True when the value names nothing outside the drawing: a reference is `url(#id)` only. */
function staticValue(value: string): boolean {
  if (value.includes(String.fromCharCode(0)) || /\\|javascript|vbscript|data\s*:|@import|expression|image-set|<|&/iu.test(value)) return false;
  return [...value.matchAll(/url\s*\(([^)]*)\)?/giu)].every((match) => /^\s*(["']?)#[A-Za-z][\w-]*\1\s*$/u.test(match[1] ?? ""));
}

/**
 * The same drawing as a `data:` URL written here, safe inside a quoted CSS string, or null when it is not a static
 * drawing. Refused whole: a doctype, an entity, a comment, a processing instruction or CDATA (what an XML reader and
 * an HTML one read differently); any element or attribute off the lists; an `href` that is not `#id`; an event.
 */
export function staticInlineSvg(reference: string): string | null {
  const text = svgText(reference)?.trim();
  if (!text || text.length > MAX_INLINE_SVG_BYTES || /<[!?]/u.test(text) || !/^<svg[\s>]/iu.test(text)) return null;
  let roots: Node[];
  try {
    roots = parseFragment(text).childNodes;
  } catch {
    return null;
  }
  if (roots.length !== 1) return null;
  let elements = 0;
  const stack: Node[] = [...roots];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.nodeName === "#text") continue;
    if (!("tagName" in node) || !ELEMENTS.has(node.tagName.toLowerCase()) || ++elements > MAX_INLINE_SVG_ELEMENTS) return null;
    for (const attribute of node.attrs) {
      const name = (attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name).toLowerCase();
      if (name in NAMESPACES) {
        if (attribute.value !== NAMESPACES[name]) return null;
        continue;
      }
      if (/^on/u.test(name) || !(PREFIXED.has(name) || /^[a-z][a-z0-9-]*$/u.test(name))) return null;
      if (name === "href" || name === "xlink:href" ? !/^#[A-Za-z][\w-]*$/u.test(attribute.value) : !staticValue(attribute.value)) return null;
    }
    if ("childNodes" in node) for (const child of node.childNodes) stack.push(child as Node);
  }
  // Every character a CSS string or a style element could trip on is percent-encoded: quotes, backslash, <, braces.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text).replace(/['()*!]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
