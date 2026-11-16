/**
 * Previews live under /__preview/<ticket>/<build>/ on the app's own origin, but a built site addresses its pages and
 * media from the root ("/media/…", "/opera/"), as it will once published. Served as they are, those addresses leave
 * the preview: images answer 404 and the first internal link opens the app. These functions put the preview prefix
 * in front of every root-relative address of an HTML or CSS response, only while it is served as a preview; the build
 * on disk, what gets published, is never changed. Absolute and protocol-relative URLs, fragments and relative paths
 * stay as they are. The prefix is made of a ticket and a build id the server minted, so nothing is injected.
 */

import { rewriteSrcset as rewriteSrcsetCandidates } from "@histos-publish/core";

/** Attributes whose value is one URL. */
const URL_ATTRIBUTES = new Set(["href", "src", "poster", "action", "formaction", "data", "cite", "background", "xlink:href", "data-src", "data-href"]);
/** Attributes whose value is a srcset: candidates separated by commas, each a URL and an optional descriptor. */
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset", "data-srcset"]);
/** Elements whose content is raw text: never parsed as tags. Style content is CSS and gets rewritten too. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);

function rootRelative(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\");
}

/** One address: prefixed when it starts at the root of the site, unchanged otherwise. Leading spaces are kept. */
export function rewriteRootUrl(value: string, prefix: string): string {
  const leading = value.length - value.trimStart().length;
  const url = value.slice(leading);
  return rootRelative(url) ? `${value.slice(0, leading)}${prefix}${url}` : value;
}

/** Each candidate parsed as the HTML spec says (a data: URI keeps its commas), then rewritten. */
function rewriteSrcset(value: string, prefix: string): string {
  return rewriteSrcsetCandidates(value, (url) => rewriteRootUrl(url, prefix));
}

/** A quote as it appears in CSS, or in a style attribute where the serializer escaped it. */
const QUOTE = `(?:["']|&quot;|&#0*3[49];|&#x0*2[27];|&apos;)`;
/** The prefix goes right before the "/" of a root-relative address; "//host" and "/\\host" stay as they are. */
const ROOT = "(\\/(?![\\/\\\\]))";
/**
 * CSS: url(…) in every quoting style, @import "…" and strings in image-set(). Each pattern only inserts the prefix
 * in front of the address and never scans ahead for a closing parenthesis or quote, so it runs in linear time on any
 * input (a stylesheet of a crawled site is untrusted and is rewritten on the server's request thread).
 */
export function rewritePreviewCss(css: string, prefix: string): string {
  return css
    .replace(new RegExp(`(url\\(\\s*${QUOTE}?)${ROOT}`, "giu"), `$1${prefix}$2`)
    .replace(new RegExp(`(@import\\s+${QUOTE})${ROOT}`, "giu"), `$1${prefix}$2`)
    .replace(/(?:-webkit-)?image-set\((?:[^()]|\([^()]{0,256}\)){0,4096}/giu, (body) => body.replace(new RegExp(`(${QUOTE})${ROOT}`, "gu"), `$1${prefix}$2`));
}

function rewriteRefresh(value: string, prefix: string): string {
  return value.replace(/(;\s*url\s*=\s*['"]?)(\/(?![\/\\]))/iu, `$1${prefix}$2`);
}

/**
 * HTML: a small tokenizer, enough for the markup the app itself serializes. It walks tags with properly quoted
 * attribute values (a ">" inside quotes does not end the tag), skips comments and raw-text elements, and rewrites
 * URL attributes, srcset candidates, style attributes, <style> content and a meta refresh.
 */
export function rewritePreviewHtml(html: string, prefix: string): string {
  let output = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      output += html.slice(index);
      break;
    }
    output += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      const end = close < 0 ? html.length : close + 3;
      output += html.slice(open, end);
      index = end;
      continue;
    }
    const name = /^<([a-zA-Z][a-zA-Z0-9:-]*)/u.exec(html.slice(open, open + 64));
    if (!name) {
      // A stray "<" in text is just a character; "</tag>", "<!doctype>" and "<?…>" are copied up to the next ">".
      if (!/^<[/!?]/u.test(html.slice(open, open + 2))) {
        output += "<";
        index = open + 1;
        continue;
      }
      const close = html.indexOf(">", open + 1);
      const end = close < 0 ? html.length : close + 1;
      output += html.slice(open, end);
      index = end;
      continue;
    }
    const tag = (name[1] as string).toLowerCase();
    let cursor = open + (name[0] as string).length;
    let rebuilt = name[0] as string;
    let refresh = false;
    let selfClosed = false;
    while (cursor < html.length) {
      const spaces = /^[\s/]*/u.exec(html.slice(cursor, cursor + 256))?.[0] ?? "";
      if (spaces.includes("/") && html[cursor + spaces.length] === ">") selfClosed = true;
      rebuilt += spaces;
      cursor += spaces.length;
      if (cursor >= html.length || html[cursor] === ">") break;
      const attribute = /^([^\s"'>/=]+)(\s*=\s*)?/u.exec(html.slice(cursor, cursor + 512));
      if (!attribute) {
        rebuilt += html[cursor];
        cursor += 1;
        continue;
      }
      cursor += attribute[0].length;
      const attributeName = attribute[1] as string;
      if (!attribute[2]) {
        rebuilt += attribute[0];
        continue;
      }
      let quote = "";
      let value: string;
      const first = html[cursor];
      if (first === '"' || first === "'") {
        quote = first;
        const close = html.indexOf(quote, cursor + 1);
        const end = close < 0 ? html.length : close;
        value = html.slice(cursor + 1, end);
        cursor = close < 0 ? html.length : close + 1;
      } else {
        const unquoted = /^[^\s>]*/u.exec(html.slice(cursor))?.[0] ?? "";
        value = unquoted;
        cursor += unquoted.length;
      }
      const lower = attributeName.toLowerCase();
      if (lower === "http-equiv" && value.toLowerCase() === "refresh") refresh = true;
      let next = value;
      if (URL_ATTRIBUTES.has(lower)) next = rewriteRootUrl(value, prefix);
      else if (SRCSET_ATTRIBUTES.has(lower)) next = rewriteSrcset(value, prefix);
      else if (lower === "style") next = rewritePreviewCss(value, prefix);
      rebuilt += `${attribute[0]}${quote}${next}${quote}`;
    }
    if (tag === "meta" && refresh) {
      rebuilt = rebuilt.replace(/(\scontent\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu, (whole, head: string, double: string | undefined, single: string | undefined, bare: string | undefined) =>
        double !== undefined ? `${head}"${rewriteRefresh(double, prefix)}"` : single !== undefined ? `${head}'${rewriteRefresh(single, prefix)}'` : bare !== undefined ? `${head}${rewriteRefresh(bare, prefix)}` : whole);
    }
    if (cursor < html.length) {
      rebuilt += ">";
      cursor += 1;
    }
    output += rebuilt;
    index = cursor;
    if (RAW_TEXT.has(tag) && !selfClosed) {
      const closing = new RegExp(`</${tag}\\s*>`, "iu").exec(html.slice(index));
      const end = closing ? index + closing.index : html.length;
      const content = html.slice(index, end);
      output += tag === "style" ? rewritePreviewCss(content, prefix) : content;
      index = end;
    }
  }
  return output;
}
