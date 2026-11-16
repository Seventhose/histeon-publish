/**
 * The last pass of a page in another language (doc 20 §5.5): a whole text node, or a whole alt, title, placeholder or
 * aria-label, becomes its published string, and an internal link goes to the same content in that language. It reads
 * the HTML our renderer wrote, one token at a time and never backwards, so its time is linear in the page. Nothing
 * changes inside script, style, textarea, code, pre or comments, and a link with hreflang (the language switcher) stays.
 */

const RAW_ELEMENTS = new Set(["script", "style", "textarea", "code", "pre"]);
const TEXT_ATTRIBUTES = new Set(["alt", "title", "placeholder", "aria-label"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", nbsp: " " };

/** A text as strings compare it: entities read, runs of space folded, no space around it. */
export function normalizeStringSource(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gu, (_, name: string) => ENTITIES[name] ?? "").replace(/\s+/gu, " ").trim();
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d || code === 0x0c;
}

/** The end of the tag that starts at `start`, past any `>` inside a quoted value, or -1. */
function tagEnd(html: string, start: number): number {
  let quote = 0;
  for (let index = start; index < html.length; index += 1) {
    const code = html.charCodeAt(index);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 0x22 || code === 0x27) quote = code;
    else if (code === 0x3e) return index;
  }
  return -1;
}

function tagName(tag: string): string {
  let end = 1;
  while (end < tag.length && !isSpace(tag.charCodeAt(end)) && tag[end] !== ">" && tag[end] !== "/") end += 1;
  return tag.slice(1, end).toLowerCase();
}

/** A site address with what follows it: "/chi-siamo/#team" → ["/chi-siamo/", "#team"]; null for anything else. */
function internalAddress(value: string): [string, string] | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  const end = value.search(/[?#]/u);
  return end < 0 ? [value, ""] : [value.slice(0, end), value.slice(end)];
}

function localizeTag(tag: string, strings: ReadonlyMap<string, string>, links: ReadonlyMap<string, string>): string {
  const name = tagName(tag);
  const link = name === "a" && !/\shreflang\s*=/iu.test(tag);
  return tag.replace(/([\s"'])([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/gu, (whole, before: string, attribute: string, value: string) => {
    const key = attribute.toLowerCase();
    if (TEXT_ATTRIBUTES.has(key)) {
      const translated = strings.get(normalizeStringSource(value));
      return translated === undefined ? whole : `${before}${attribute}="${escapeAttribute(translated)}"`;
    }
    if (link && key === "href") {
      const address = internalAddress(value);
      const target = address ? links.get(address[0]) : undefined;
      return address && target ? `${before}${attribute}="${escapeAttribute(target + address[1])}"` : whole;
    }
    return whole;
  });
}

function localizeText(text: string, strings: ReadonlyMap<string, string>): string {
  if (!strings.size) return text;
  const translated = strings.get(normalizeStringSource(text));
  if (translated === undefined) return text;
  const lead = /^\s*/u.exec(text)?.[0] ?? "";
  const trail = /\s*$/u.exec(text)?.[0] ?? "";
  return `${lead}${escapeText(translated)}${trail}`;
}

export function localizeHtml(html: string, strings: ReadonlyMap<string, string>, links: ReadonlyMap<string, string>): string {
  if (!strings.size && !links.size) return html;
  const out: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      out.push(localizeText(html.slice(index), strings));
      break;
    }
    if (open > index) out.push(localizeText(html.slice(index, open), strings));
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      const end = close < 0 ? html.length : close + 3;
      out.push(html.slice(open, end));
      index = end;
      continue;
    }
    const end = tagEnd(html, open);
    if (end < 0) {
      out.push(html.slice(open));
      break;
    }
    const tag = html.slice(open, end + 1);
    const name = tagName(tag);
    if (tag[1] === "/" || tag[1] === "!" || !name) {
      out.push(tag);
      index = end + 1;
      continue;
    }
    out.push(localizeTag(tag, strings, links));
    index = end + 1;
    if (RAW_ELEMENTS.has(name)) {
      // Everything up to the element's closing tag is left as it is.
      const closing = new RegExp(`</${name}`, "giu");
      closing.lastIndex = index;
      const stop = closing.exec(html)?.index ?? html.length;
      out.push(html.slice(index, stop));
      index = stop;
    }
  }
  return out.join("");
}
