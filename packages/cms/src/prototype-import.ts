import { createHash } from "node:crypto";
import { defaultTreeAdapter, Parser, Tokenizer, type DefaultTreeAdapterMap, type ParserOptions, type Token, type TokenHandler, type TokenizerOptions, type TreeAdapter } from "parse5";
import postcss, { type ChildNode, type Rule } from "postcss";
import { portToSelectors } from "./selector-port.js";
import { ContractValidationError, isPostPublishedAt, POST_TAXONOMIES, PRODUCT_FIELDS, PRODUCT_TAXONOMIES, PRODUCT_TYPE_KEY, productFields, productSku, productValueIssues, TEMPLATE_ROLES, type StaticPageProfile, type TemplateRole } from "@histos-publish/histos-contract";
import { COMPONENT_REF_PATTERN, findClosingBrace, parse as parseDsl, RAW_TEXT_ELEMENTS, serializeXb, VOID_ELEMENTS, XbSyntaxError, type XbBlock } from "../.generated/histos-dsl/index.js";
import { SITE_TOKEN_PREFIX, changedHistosDesign, validateHistosDesign, validateSiteTokens } from "./histos-design.js";
import { createStaticPageProfile } from "./page-transfer.js";
import { decodeHTMLAttribute } from "entities";
import { formatTransferSrcset, parseTransferSrcset, TRANSFER_SVG_CAMEL_CASE_ATTRIBUTES, TRANSFER_SVG_TAGS, TRANSFER_SVG_TEXT_TAGS, transferMarkupIssues, type TransferMarkupError } from "./transfer-markup.js";
import { imageIntegrityProblem, imageSize, inspectImageForVariants, type ImageVariantSource } from "./image-size.js";
import { inflateSync } from "node:zlib";
import { ARCHIVE_PAGE_NAMES, declaredSlots, expressionProblems, slotProblems, type ComponentCall, type ExpressionDeclarations, type ExpressionProblem, type PropDefinition } from "./prototype-expressions.js";
import { PrototypeQuality } from "./prototype-quality.js";
import { PrototypeStrict, type StrictProblem } from "./prototype-strict.js";
import { pageWideImageRules } from "./picture-markup.js";
// The static build's archive rules (cms-api.ts follows them): main()'s page size, when /blog/ is the posts index.
import { CMS_ARCHIVE_PAGE_SIZE, CMS_MAX_FILTER_LEAVES, cmsFilterLeaves, cmsPostsIndexWritten } from "./content-model.js";
import { collectCssDefinitions, collectCssNames, convertAcssVariables, definedVariablesIn, emptyFrameworkNames, frameworkNameWarnings, frameworkNamesInBlocks, type Conversions, type FrameworkNames } from "./framework-names.js";
import { assertDocumentScript } from "./document-script.js";
import { convertedMediaHash, PROTOTYPE_MAX_BYTES, sniffPrototypeMedia, type PrototypeMediaType } from "./prototype-media.js";
export { CONVERTED_MEDIA_HOST, convertedMediaHash, convertedMediaUrl, PROTOTYPE_MAX_BYTES, sniffPrototypeMedia, type PrototypeMediaType } from "./prototype-media.js";
import { normalizeCmsRenderSettings, type CmsProjectCatalog, type CmsProjectStore } from "./project-repository.js";
import { normalizeShopSettings, type CmsShopSettings } from "./commerce.js";

/**
 * Histeon prototype v1 (docs/progettazione/histos-cms/14-prototipo-histos.md): one HTML file describing a whole site,
 * turned into a Histeon CMS project. The file is read with an HTML5 parser, its parts are validated, the project is
 * built in a temporary catalog with the ordinary store APIs and exported as an `.xbsite` v2 profile, so the real
 * import goes through every transfer check.
 */

const MAX_ASSETS = 500;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_DOCUMENTS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ASSET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const ASSET_REFERENCE = /asset:([a-z0-9][a-z0-9-]{0,62})/gu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
/** CSS references to prototype media become this local path, mapped to the asset in the style entry. */
const CSS_ASSET_PREFIX = "prototype-assets/";

const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Downloads one remote prototype image; the server provides a client limited to public HTTPS addresses. */
export type PrototypeAssetFetcher = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;

export interface PrototypeImportOptions {
  /** Without it, an asset given by URL stops the import, unless placeholders are allowed. */
  fetchAsset?: PrototypeAssetFetcher;
  /** A quick check: remote media are not downloaded and stand in as a 1×1 image (reported). */
  remotePlaceholders?: boolean;
  /** Stops between media and aborts the download in progress (the AI connector's Interrompi and Ferma). */
  signal?: AbortSignal;
  /** Where the import is, phase by phase (queue D3): a big prototype takes a while. */
  onProgress?: (progress: PrototypeImportProgress) => void;
  /**
   * Doc 23 item 109: the bytes the app kept for a site it converted, by hash, or null. Only the app's own routes pass
   * it; without it a converted-media address stops the import, and it is never downloaded.
   */
  convertedMedia?: (sha256: string) => Uint8Array | null;
  /**
   * F1: the strict check's rules (prototype-strict.ts), read from what the import parses: the build then returns
   * `strict`, its problems. Without it nothing changes.
   */
  strict?: boolean;
}

export interface PrototypeImportProgress {
  /** `writing` comes from the app's import: the project is being written and can no longer be cancelled. */
  phase: "media" | "records" | "documents" | "writing";
  done: number;
  total: number;
}

/** Remote media downloaded at the same time: faster, and still polite to the hosts. */
const DOWNLOADS_AT_ONCE = 4;
/** The longest document content and the longest CSS the transfer format takes (site-entity-v2.schema.json). */
const TRANSFER_CONTENT_MAX = 4_194_304;
const TRANSFER_CSS_MAX = 1_048_576;
/** The global sheets and the selector styles a transfer holds: past them the import would only fail at the end, after reading everything. */
const TRANSFER_GLOBALS_MAX = 100;
const TRANSFER_STYLES_MAX = 5_000;
/**
 * The project keeps every style in one document: the global sheets and the selector styles, as JSON (the store's
 * MAX_DOCUMENT_BYTES, in UTF-8 bytes; the transfer format sets no total). It bounds the selector styles' size before
 * they are parsed; what the parse of a sheet that size may hold is bounded by cssParseCost and cssParseHeap
 * (CSS_HEAP_MAX…).
 */
const STYLES_DOCUMENT_MAX = 8 * 1024 * 1024;
const STYLES_TOO_LARGE = "Fogli globali e stili per selettore superano insieme 8 MiB di CSS: il progetto li tiene in un solo documento, di al massimo 8 MiB. Alleggeriscili, o togli le regole che non servono.";

/**
 * What of a sheet of selector styles the styles document holds at least: every character but CSS whitespace, which the
 * styles drop between rules and declarations. Each style keeps its selector and its declarations with their own
 * characters (as UTF-8 bytes, never fewer than these UTF-16 units, escaped in JSON) and adds its id and keys, more than
 * the braces of its rule. Only what the import drops besides whitespace (comments between rules, stray semicolons)
 * makes a sheet count more than it takes, and the import reads those too.
 */
function selectorsWeight(css: string): number {
  let weight = 0;
  for (let index = 0; index < css.length; index++) {
    const code = css.charCodeAt(index);
    if (code !== 32 && code !== 10 && code !== 9 && code !== 12 && code !== 13) weight++;
  }
  return weight;
}

/** Characters as the transfer schema counts them: code points, not UTF-16 units (an emoji is one). */
function codePoints(text: string): number {
  let count = text.length;
  for (let index = 1; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const previous = text.charCodeAt(index - 1);
    if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) count--;
  }
  return count;
}

/**
 * What parsing a sheet holds, bounded before any parse (review 3, finding 6). The build parses each sheet whole with
 * postcss, which holds at once the tree, every word its tokenizer has read (kept to the end of the parse), the tokens
 * of the node it is reading and an index of the lines; the text a node joins from its tokens (a selector, an at-rule's
 * prelude, what stands before a declaration's name, the spaces before a node) stays a string of pieces, 32 bytes a
 * token, and a token of two characters or more is a string of its own (24 to 40 bytes; V8 shares those of one
 * character). Within 8 MiB the densest sheets took 1.4 to 2.6 GB (8 MiB of `&{b:c}` or `a{}`), and one declaration of
 * millions of tokens 2.6 GB (`x x x…`) or 3.5 GB (`:::…`). Words, lines and the run of tokens of one node have each a
 * bound, and what all of them hold together has CSS_HEAP_MAX (review 6): spaces count for nothing in the selector
 * styles' 8 MiB, so 165 nodes of 100,000 tokens, a `:` and two spaces each, were within every bound, ran out of a
 * 700 MB heap and took 912 MB at 1 GB (the verifier's). cssParseHeap counts, from cssParseCost's exact counts, 420
 * bytes a node, 88 a word held, 32 a token, 32 more a token that is a string of its own, 16 a line, and (review 7)
 * where postcss holds text twice: 32 more a token of a selector or an at-rule's prelude that raw() keeps a second time
 * as raws {value, raw} (a comment in it with a space on a side, or after a `,`: such sheets held 2.0 times the count,
 * and the verifier's 126 selectors of 99,000 tokens ran out of an 848 MB heap), and 2 bytes a character of each
 * declaration, whose name, spaces after the colon and value decl() copies flat (40 values of 200,000 spaces in
 * two-byte text held 16 MB the count missed, up to 450 times the count); a declaration's value tokens, which the copy
 * frees, then stand for raws.value.raw. Against what postcss holds at the end of the parse, measured for 44 shapes
 * (pieces of one character or of spaces in a node opening with `[` or in selectors, of one-byte and two-byte text,
 * strings, comments, parentheses, at-words, nested and empty rules, at-rules, declarations, custom properties, lines,
 * selectors and preludes with a comment, nested too, values of spaces, nodes and pieces together), it is 0.12 to 1.00
 * of it, give or take the 0.2 MB of the measure's own noise. A node holds at least 452 bytes of it, so no sheet reaches
 * a million nodes. The build parses one sheet at a time and lets its tree go before the next (what stays, names and
 * the styles' text, is bounded by the sheets' size): the bound is per sheet. A global sheet past it is kept as
 * written and not parsed, like one past the other bounds.
 * Real sheets are far from these bounds: of 557 stylesheets of themes, plugins and apps (WordPress core and editor,
 * WooCommerce, Forminator, Modern Events Calendar, ACSS, Core Framework, Histeon's own…) the densest holds 40 bytes a
 * character, 120 MB at 3 MB, under a third of CSS_HEAP_MAX, and 378 MB scaled to 8 MiB of the selector styles; a
 * utility sheet of 3.2 MB shaped like Tailwind's full build holds 105 MB, ACSS's framework sheet 1.5 MB, Histeon CSS
 * 1 MB; the densest of 341 sheets measured in review 4 would hold, scaled to 8 MiB, 904,000 words and 757,000 lines,
 * and the longest run of tokens is 1,468 (a list of 200 selectors).
 * Measured in review 7 on the whole build, as the smallest --max-old-space-size (to 16 MB) at which it completes, for
 * the densest sheet of each shape within every bound: 592 MB at most, for 6.3 million tokens of one character (`: `)
 * in selectors with a comment, in a file of 30 MB of two-byte text padded with spaces, to convert from ACSS (576 MB
 * without the conversion, 464 MB in 6 MB of one-byte text; in at-rules' preludes or nested rules 448 to 576 MB);
 * one-character pieces in nodes opening with `[` 576 MB (560 MB to convert), strings 528 MB, two-space pieces 512 MB,
 * 4,990 rules of nested rules 480 MB, selectors 464 MB, values of spaces 320 MB, a global sheet of 2 MB of rules to
 * convert 320 MB. At a 700 MB limit the first peaks at 627 MB; with a 4 GB limit V8 lets the garbage take it to 1.4 GB
 * before collecting it (14-prototipo-histos.md §5).
 * Two more things of a parse are no memory to count: a value ending with the word `important` without `!`, which
 * decl() takes back one token at a time copying all it took back (time: CSS_IMPORTANT_MAX), and an inline source map,
 * which postcss decodes and parses (inlineSourceMap): the import takes the one that ends a sheet out first
 * (withoutTrailingSourceMap, review 9), and never parses a sheet that still holds one.
 */
const CSS_WORDS_MAX = 2_000_000;
const CSS_RUN_MAX = 100_000;
const CSS_LINES_MAX = 2_000_000;
const CSS_NODE_BYTES = 420;
const CSS_WORD_BYTES = 88;
const CSS_TOKEN_BYTES = 32;
const CSS_STRING_BYTES = 32;
const CSS_LINE_BYTES = 16;
const CSS_FLAT_BYTES = 2;
const CSS_HEAP_MAX = 384 * 1024 * 1024;
const CSS_HEAP_REAL = "un foglio reale di 3 MB ne tiene meno di un terzo";
/**
 * The characters decl() may copy taking back values that end with the word `important` without `!` (CssParseCost
 * .important), counted from above: past them a sheet is not parsed. The copies grow with the square of such a value:
 * 4,000 pieces of a word and 1,000 spaces, 4 MB, took 7.7 s; at this bound the slowest measured took 20 ms, so the
 * 101 sheets a prototype may hold stay within some 2 s. Real sheets write `!important` (none), or `! important`, taken
 * back only to its `!`.
 */
const CSS_IMPORTANT_MAX = 10_000_000;

/** The heap the parse of a sheet holds at most, in bytes, by its cost (see CSS_HEAP_MAX). */
export function cssParseHeap(cost: CssParseCost): number {
  return cost.nodes * CSS_NODE_BYTES + cost.words * CSS_WORD_BYTES + (cost.tokens + cost.doubled) * CSS_TOKEN_BYTES + cost.strings * CSS_STRING_BYTES + cost.lines * CSS_LINE_BYTES + cost.flat * CSS_FLAT_BYTES;
}

export interface CssParseCost {
  /** Nodes of the tree: rules, at-rules, declarations, comments. */
  nodes: number;
  /** Rules at the top level: in the selector styles, one style each. */
  topRules: number;
  /** The most words the tokenizer holds. */
  words: number;
  /** The most tokens the parser holds for one node or between two (spaces and stray `;`), and where they start. */
  run: number;
  runAt: number;
  /** Lines, which postcss indexes once it gives a node its position. */
  lines: number;
  /** Tokens of the whole sheet, and those V8 holds as a string of their own (two characters or more, or one past U+00FF). */
  tokens: number;
  strings: number;
  /**
   * Tokens that parser.raw() joins a second time: of a rule's selector or an at-rule's prelude where a comment with a
   * space on a side, or after a `,`, makes it keep raws {value, raw}, two strings of pieces over the same tokens.
   */
  doubled: number;
  /** Characters of the declarations, whose name, spaces after the colon and value decl() copies flat. */
  flat: number;
  /** Characters decl() copies taking back, one token at a time, a value that ends with the word `important` (an upper bound), and where the last such declaration starts. */
  important: number;
  importantAt: number;
  /** Where the inline source map postcss would read starts (see inlineSourceMap), or -1. */
  sourceMap: number;
}

/** CSS whitespace as postcss's tokenizer reads it. */
function cssSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13 || code === 12;
}

/** Whitespace as JavaScript's `\s` and trim() read it. */
function jsSpace(code: number): boolean {
  return (code >= 9 && code <= 13) || code === 32 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/**
 * Where the source map that postcss would read from `css`, written in it, starts; -1 when there is none. Its Input
 * (lib/previous-map.js) takes the last `/*`, spaces and `# sourceMappingURL=` of the whole text (in a comment, a
 * string, anywhere) up to the next `*\/`, and an annotation that opens with `data:` it decodes and parses as a source
 * map, held with the tree: some 12 bytes a character (1 million names in 9 MB held 80 MB), and on any error in the
 * sheet it reads every mapping for the error's place, which with mappings all alike took 67 seconds for 8 MB and then
 * ran out of stack. Any other annotation it reads only from a file next to the sheet's own, which a parse without `from`
 * has none of.
 */
function inlineSourceMap(css: string): number {
  const marker = "# sourceMappingURL=";
  for (let at = css.lastIndexOf(marker); at !== -1; at = at === 0 ? -1 : css.lastIndexOf(marker, at - 1)) {
    let start = at;
    while (start > 0 && jsSpace(css.charCodeAt(start - 1))) start--;
    if (start < 2 || !css.startsWith("/*", start - 2)) continue;
    // The last `/*\s*# sourceMappingURL=`, postcss's: only it counts.
    const end = css.indexOf("*/", start - 2);
    let value = at + marker.length;
    while (value < end && jsSpace(css.charCodeAt(value))) value++;
    return end !== -1 && value + 5 <= end && css.startsWith("data:", value) ? start - 2 : -1;
  }
  return -1;
}

/**
 * `css` without the inline source map comment that ends it, `/*# sourceMappingURL=data:… *\/` on a line of its own and
 * followed by nothing but spaces, as Sass, Vite and PostCSS end the sheets they compile, and where that comment started
 * in `css`, or -1 (review 9). A published site has no use for it, and the parse would decode it whole. A single line
 * feed takes its place (the lines after it are only spaces). One backwards look from the end, linear: the last `*\/`, the
 * last marker before it with only spaces between it and the `/*` that opens the comment, a `data:` value, no `*\/` in the
 * comment but its own, and only spaces before it on its line. Nothing else is taken out: a map anywhere else (in a
 * string, in the middle of the sheet, after a rule on its line, before another comment) stays, inlineSourceMap finds it
 * if postcss would read it, and the sheet stops at its line (cssParseProblem). Text that only looks like that comment,
 * the end of a comment, url( or string opened on an earlier line, runs to the end of the sheet with it or without it.
 */
function withoutTrailingSourceMap(css: string): { css: string; removed: number } {
  const marker = "# sourceMappingURL=";
  let end = css.length;
  while (end > 0 && cssSpace(css.charCodeAt(end - 1))) end--;
  const close = end - 2;
  if (close < 0 || !css.startsWith("*/", close)) return { css, removed: -1 };
  const at = css.lastIndexOf(marker, close - marker.length);
  if (at === -1) return { css, removed: -1 };
  let open = at;
  while (open > 0 && jsSpace(css.charCodeAt(open - 1))) open--;
  open -= 2;
  if (open < 0 || !css.startsWith("/*", open) || css.indexOf("*/", open + 2) !== close) return { css, removed: -1 };
  let lineStart = open;
  while (lineStart > 0 && css.charCodeAt(lineStart - 1) !== 10 && cssSpace(css.charCodeAt(lineStart - 1))) lineStart--;
  if (lineStart > 0 && css.charCodeAt(lineStart - 1) !== 10) return { css, removed: -1 };
  let value = at + marker.length;
  while (value < close && jsSpace(css.charCodeAt(value))) value++;
  if (value + 5 > close || !css.startsWith("data:", value)) return { css, removed: -1 };
  return { css: `${css.slice(0, open)}\n${css.slice(end)}`, removed: open };
}

/**
 * The cost of parsing `css` with postcss (pinned in package.json), read in one pass and without building anything, as
 * its tokenizer (lib/tokenize.js) and parser (lib/parser.js) read it: tokens (a run of spaces, a word, a string, a
 * comment, `url(…)` and a parenthesis without newline, quote, `(`, `/` or `\` inside it as one, a single character
 * for `{ } : ; ( ) [ ]`), words (kept by the tokenizer, each `(` lets go of the last), the tokens the parser gathers
 * for a declaration, a selector or an at-rule's prelude, which a `;`, `{` or `}` ends only outside brackets (and,
 * after the colon of a custom property, outside its braces), from its first token on (a node that opens with `[`
 * holds everything up to its `]`), and the nodes it makes of them; a declaration that a `}` ends gives back the
 * comments after it, each a node. Exact for every sheet postcss reads, the run included (a test checks it against
 * postcss, on thousands of generated sheets too); one it refuses is counted the same way up to where it would stop.
 * Stops past the bounds above.
 */
export function cssParseCost(css: string): CssParseCost {
  const length = css.length;
  // postcss drops a byte order mark.
  let pos = css.charCodeAt(0) === 0xfeff ? 1 : 0;
  /** Where a string of `quote` that opens at `open` ends, past a quote no `\` escapes; at the end, when none does. */
  const closing = (open: number, quote: string) => {
    for (let end = css.indexOf(quote, open + 1); end !== -1; end = css.indexOf(quote, end + 1)) {
      let escaped = false;
      for (let at = end; css.charCodeAt(at - 1) === 92; at--) escaped = !escaped;
      if (!escaped) return end + 1;
    }
    return length;
  };
  // A word ends at a space, ! " # ' ( ) : ; @ [ \ ] { } or a `/*`; an at-word at a space, " # ' ( ) / ; [ \ ] { }.
  const wordEnd = (code: number, at: number) => cssSpace(code) || code === 33 || code === 34 || code === 35 || code === 39 || code === 40 || code === 41 || code === 58 || code === 59 || code === 64 || code === 91 || code === 92 || code === 93 || code === 123 || code === 125 || (code === 47 && css.charCodeAt(at + 1) === 42);
  const atWordEnd = (code: number) => cssSpace(code) || code === 34 || code === 35 || code === 39 || code === 40 || code === 41 || code === 47 || code === 59 || code === 91 || code === 92 || code === 93 || code === 123 || code === 125;
  const hex = (code: number) => (code >= 48 && code <= 57) || ((code | 0x20) >= 97 && (code | 0x20) <= 102);
  const SPACE = 0, WORD = 1, OTHER = 2, AT_WORD = 3, COMMENT = 4;
  /** Words the tokenizer holds, and which of them are `url` (by how many were held when each came), for `url(`. */
  let held = 0;
  const urls: number[] = [];
  let lastBadParen = -1;
  /** Whether the last word starts with `--`: a declaration it opens is a custom property. */
  let custom = false;
  const cost: CssParseCost = { nodes: 0, topRules: 0, words: 0, run: 0, runAt: 0, lines: 1, tokens: 0, strings: 0, doubled: 0, flat: 0, important: 0, importantAt: 0, sourceMap: inlineSourceMap(css) };
  if (cost.sourceMap !== -1) return cost;
  // postcss splits the sheet at each LF to index its lines.
  for (let index = css.indexOf("\n"); index !== -1 && cost.lines <= CSS_LINES_MAX; index = css.indexOf("\n", index + 1)) cost.lines++;
  if (cost.lines > CSS_LINES_MAX) return cost;
  /** The next token's type, counted (see read). */
  const next = (): number => {
    const from = pos;
    const type = read();
    cost.tokens++;
    // V8 shares the string of one character up to U+00FF; any other token is a string of its own.
    if (pos - from > 1 || css.charCodeAt(from) > 0xff) cost.strings++;
    return type;
  };
  /** The next token's type (a character code for a single character), with `pos` moved past it. */
  const read = (): number => {
    const code = css.charCodeAt(pos);
    if (cssSpace(code)) {
      do pos++; while (pos < length && cssSpace(css.charCodeAt(pos)));
      return SPACE;
    }
    if (code === 91 || code === 93 || code === 123 || code === 125 || code === 58 || code === 59 || code === 41) {
      pos++;
      return code;
    }
    if (code === 40) {
      const url = held > 0 && urls.at(-1) === held;
      if (url) urls.pop();
      if (held > 0) held--;
      const after = css.charCodeAt(pos + 1);
      if (url && after !== 34 && after !== 39 && !cssSpace(after)) {
        pos = Math.min(closing(pos, ")"), length);
        return OTHER;
      }
      if (pos > lastBadParen) {
        const close = css.indexOf(")", pos + 1);
        let bad = close === -1;
        for (let at = pos + 1; !bad && at < close; at++) {
          const inside = css.charCodeAt(at);
          bad = inside === 10 || inside === 13 || inside === 34 || inside === 39 || inside === 40 || inside === 47 || inside === 92;
        }
        if (!bad) {
          pos = close + 1;
          return OTHER;
        }
        lastBadParen = close === -1 ? length : close;
      }
      pos++;
      return 40;
    }
    if (code === 34 || code === 39) {
      pos = closing(pos, code === 34 ? '"' : "'");
      return OTHER;
    }
    if (code === 64) {
      do pos++; while (pos < length && !atWordEnd(css.charCodeAt(pos)));
      return AT_WORD;
    }
    if (code === 92) {
      // A run of `\`: an odd one escapes what follows.
      let at = pos;
      let escapes = true;
      while (css.charCodeAt(at + 1) === 92) {
        at++;
        escapes = !escapes;
      }
      const escaped = css.charCodeAt(at + 1);
      if (escapes && at + 1 < length && escaped !== 47 && !cssSpace(escaped)) {
        at++;
        if (hex(escaped)) {
          while (hex(css.charCodeAt(at + 1))) at++;
          if (css.charCodeAt(at + 1) === 32) at++;
        }
      }
      pos = at + 1;
      custom = false;
      return WORD;
    }
    if (code === 47 && css.charCodeAt(pos + 1) === 42) {
      const close = css.indexOf("*/", pos + 2);
      pos = close === -1 ? length : close + 2;
      return COMMENT;
    }
    const start = pos;
    do pos++; while (pos < length && !wordEnd(css.charCodeAt(pos), pos));
    custom = code === 45 && css.charCodeAt(start + 1) === 45;
    if (pos - start === 3 && css.startsWith("url", start)) urls.push(held + 1);
    if (++held > cost.words) cost.words = held;
    return WORD;
  };
  let run = 0;
  let runAt = pos;
  const count = () => {
    if (++run > cost.run) {
      cost.run = run;
      cost.runAt = runAt;
    }
  };
  const over = () => cost.words > CSS_WORDS_MAX || cost.run > CSS_RUN_MAX || cost.lines > CSS_LINES_MAX || cost.important > CSS_IMPORTANT_MAX || cssParseHeap(cost) > CSS_HEAP_MAX;
  let depth = 0;
  while (pos < length && !over()) {
    if (run === 0) runAt = pos;
    const nodeFrom = pos;
    let type = next();
    // Between nodes: spaces and stray semicolons gather until the next node.
    if (type === SPACE || type === 59) {
      count();
      continue;
    }
    // A comment, a `{` (a rule without selector) or a `}` ends the run, itself read.
    if (type === 125 || type === 123 || type === COMMENT) {
      if (type === 125) depth = Math.max(0, depth - 1);
      else cost.nodes++;
      if (type === 123) {
        if (depth === 0) cost.topRules++;
        depth++;
      }
      count();
      run = 0;
      continue;
    }
    // A node: an at-rule with its prelude (parser.atrule), or a declaration or rule (parser.other).
    const atRule = type === AT_WORD;
    const customProperty = type === WORD && custom;
    const brackets: number[] = [];
    let colon = false;
    let trailingComments = 0;
    let end = -1;
    // The node's tokens (an at-rule's after its name), and what parser.raw() makes of its text (see CssParseCost.doubled):
    // the tokens it joins run from the first that is neither a space nor a comment (an at-rule's prelude gives those
    // before it to raws.afterName) to the last (those after it go to raws.between); `inside` is a comment among them
    // with a space on a side, or after a token ending with `,`, and `open` one whose next token decides.
    let index = 0;
    let rawFirst = -1;
    let rawLast = -1;
    let afterSpace = false;
    let afterComma = false;
    let open = false;
    let inside = false;
    let twice = false;
    // For decl(): the last token neither a space nor a comment, and the last word opening with `!` after a `:`, with
    // where it starts, or the space before it.
    let lastFrom = -1;
    let lastTo = -1;
    let lastType = -1;
    let colonSeen = false;
    let bang = -1;
    let bangFrom = -1;
    let spaceFrom = -1;
    count();
    // parser.other() reads its first token as any later one: a `[` or a `(` opens a bracket that gathers every token up
    // to its `]` or `)` into this node, `;` and braces included, and a `:` makes it a declaration (review 5).
    let first = !atRule;
    while ((first || pos < length) && run <= CSS_RUN_MAX) {
      let from = nodeFrom;
      if (first) first = false;
      else {
        from = pos;
        type = next();
        count();
      }
      if (atRule) {
        if (type === 40 || type === 91) brackets.push(type === 40 ? 41 : 93);
        else if (type === 123 && brackets.length > 0) brackets.push(125);
        else if (type === brackets.at(-1)) brackets.pop();
        if (brackets.length === 0 && (type === 59 || type === 123 || type === 125)) {
          end = type;
          break;
        }
      } else {
        if (type === 40 || type === 91) brackets.push(type === 40 ? 41 : 93);
        else if (customProperty && colon && type === 123) brackets.push(125);
        else if (brackets.length > 0) {
          if (type === brackets.at(-1)) brackets.pop();
        } else if (type === 59 || type === 123 || type === 125) {
          end = type;
          break;
        } else if (type === 58) colon = true;
        if (type === COMMENT) trailingComments++;
        else if (type !== SPACE) trailingComments = 0;
      }
      // raw() keeps the text twice when a comment it joins has a space on a side (none counts as one: the first and the
      // last token are never comments here) or follows a token ending with `,`.
      if (type === SPACE) {
        if (open) inside = true;
        open = false;
        afterSpace = true;
        afterComma = false;
        spaceFrom = from;
      } else if (type === COMMENT) {
        if (rawFirst !== -1) {
          if (afterSpace || afterComma) inside = true;
          else open = true;
        }
        afterSpace = false;
        afterComma = false;
      } else {
        if (inside) twice = true;
        open = false;
        if (rawFirst === -1) rawFirst = index;
        rawLast = index;
        if (type === 58) colonSeen = true;
        else if (colonSeen && type === WORD && css.charCodeAt(from) === 33) {
          bang = index;
          bangFrom = afterSpace ? spaceFrom : from;
        }
        afterSpace = false;
        afterComma = css.charCodeAt(pos - 1) === 44;
        lastFrom = from;
        lastTo = pos;
        lastType = type;
      }
      index++;
    }
    cost.nodes++;
    if (!atRule && colon && !customProperty && end !== 59 && end !== 123) cost.nodes += trailingComments;
    // A rule's selector and an at-rule's prelude keep, with their text, a second one in raws when raw() finds it unclean.
    if (twice && (atRule || end === 123)) cost.doubled += rawLast - rawFirst + 1;
    if (!atRule && end !== 123) {
      // A declaration: decl() copies its name (prop[0]), the spaces after its colon (join) and its value (includes) flat.
      const chars = pos - nodeFrom;
      cost.flat += chars;
      // A value whose last token is the word `important` without `!`: decl() takes back its tokens from the end, one at
      // a time, each time copying all it took back flat (trim), up to a word opening with `!` and the space before it:
      // at most so many tokens times their characters.
      if (lastType === WORD && lastTo - lastFrom <= 9 && css.slice(lastFrom, lastTo).toLowerCase() === "important") {
        cost.important += bang === -1 ? index * chars : (index - bang + 1) * (pos - bangFrom);
        cost.importantAt = nodeFrom;
      }
    }
    if (end === 123) {
      if (!atRule && depth === 0) cost.topRules++;
      depth++;
    } else if (end === 125) depth = Math.max(0, depth - 1);
    run = 0;
  }
  return cost;
}

/** Why the import does not parse a sheet over the bounds of cssParseCost: the message, by name, and the reason alone (`riga N: …` when it has a line). */
interface CssParseProblem {
  message: string;
  reason: string;
  /** Not even kept as written: a project holding it would stop each later parse of it the same way (an inline source map). */
  stop?: true;
}

/**
 * What of the parse of `css` passes the bounds of cssParseCost, if anything; `where` names the sheet and `line` is the
 * file's line where its text starts.
 */
function cssParseProblem(css: string, cost: CssParseCost, where: string, line: number): CssParseProblem | undefined {
  const dotted = (value: number) => String(value).replace(/\B(?=(\d{3})+$)/gu, ".");
  const over = (reason: string): CssParseProblem => ({ message: `${where}: ${reason}: un foglio reale di 8 MiB ne ha meno della metà: va alleggerito.`, reason });
  /** The file's line of the offset `offset` of `css`. */
  const lineAt = (offset: number) => {
    let at = line;
    for (let index = css.indexOf("\n"); index !== -1 && index < offset; index = css.indexOf("\n", index + 1)) at++;
    return at;
  };
  if (cost.sourceMap !== -1) {
    const reason = `riga ${lineAt(cost.sourceMap)}: un source map incorporato (/*# sourceMappingURL=data:… */), che l'analisi del CSS leggerebbe per intero`;
    return { message: `${where}, ${reason}: toglilo, al progetto non serve.`, reason, stop: true };
  }
  if (cost.words > CSS_WORDS_MAX) return over(`più di ${dotted(CSS_WORDS_MAX)} parole di CSS (nomi, valori, selettori), troppe da analizzare`);
  if (cost.lines > CSS_LINES_MAX) return over(`più di ${dotted(CSS_LINES_MAX)} righe, troppe da analizzare`);
  if (cost.run > CSS_RUN_MAX) {
    const reason = `riga ${lineAt(cost.runAt)}: una dichiarazione, un selettore o un intervallo fra due regole di più di ${dotted(CSS_RUN_MAX)} parti, troppo lungo da analizzare`;
    return { message: `${where}, ${reason}. Controlla che parentesi, virgolette e commenti siano chiusi.`, reason };
  }
  if (cost.important > CSS_IMPORTANT_MAX) {
    const reason = `riga ${lineAt(cost.importantAt)}: dichiarazioni lunghe che finiscono con «important» senza «!», che l'analisi rilegge da capo una parte alla volta, troppo lente da analizzare`;
    return { message: `${where}, ${reason}. Scrivi «!important», o togli «important».`, reason };
  }
  if (cssParseHeap(cost) <= CSS_HEAP_MAX) return undefined;
  const reason = `riga ${line}: analizzarlo terrebbe in memoria più di ${CSS_HEAP_MAX / 1_048_576} MB fra regole, parole e parti, troppo`;
  return { message: `${where}, ${reason}: ${CSS_HEAP_REAL}: va alleggerito.`, reason };
}

/**
 * Stops the selector styles when their parse would cost more than the bounds of cssParseCost allow, or when they hold
 * more top-level rules than the transfer takes (TRANSFER_STYLES_MAX), with selectorStyles's own message: their names
 * would be read before it counts them. Every style is made from their parse, which nothing can do without.
 */
function checkSelectorsParseCost(css: string, line: number): void {
  const cost = cssParseCost(css);
  if (cost.topRules > TRANSFER_STYLES_MAX) fail(`Stili per selettore: più di ${TRANSFER_STYLES_MAX} regole. Unisci le regole dello stesso blocco; quelle generali vanno nei fogli globali.`);
  const problem = cssParseProblem(css, cost, "Gli stili per selettore", line);
  if (problem) fail(problem.message);
}
/** Every so many writes the build lets the server answer (progress, cancellation, other requests). */
const YIELD_EVERY = 100;
/** And after so many characters of templates read since it last did: a few large documents take as long as many small ones. */
const YIELD_SOURCE = 256 * 1024;
const yieldToServer = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface PrototypeReport {
  project: { id: string; name: string };
  counts: Record<string, number>;
  downloaded: number;
  /** Remote media not downloaded during a quick check. */
  placeholders: string[];
  /** What stays out of the project, with the line of the file where it is (D1). */
  ignored: Array<{ what: string; why: string; line?: number }>;
  warnings: string[];
  /** Every form of the prototype with its endpoint: an external one receives what visitors type (threat model P17). */
  forms: Array<{ document: string; method: "get" | "post"; action: string; external: boolean }>;
  /**
   * B6: the media of the `<img>` that the build can give modern variants (both sides written, no srcset, no author's
   * `<picture>`, a still sRGB JPEG, PNG, WebP or AVIF), and the others with why not. The build decides for each page
   * (its CSS must not select anything else once the image is in a `<picture>`); `note` says it in words, with the
   * savings when the encoder's cache has measured them.
   */
  images?: { files: number; uses: number; skipped: Array<{ asset: string; why: string }>; note: string };
}

/** A media file the build will likely give variants, as the server looks it up in the encoder's cache (B6). */
export interface PrototypeImageCandidate {
  asset: string;
  uses: number;
  sha256: string;
  bytes: number;
  source: ImageVariantSource;
}

/** One problem of a prototype (E4): the document and line of the file when they are known, and what to change. */
export interface PrototypeIssue {
  document?: string;
  line?: number;
  column?: number;
  message: string;
}

export class PrototypeError extends TypeError {
  /** Every problem found, in the order of the file; one for an error that stops the reading at once. */
  readonly issues: PrototypeIssue[];
  /** How many problems there are: more than `issues` when the list stops at PROTOTYPE_ISSUES_KEPT (E4, the count shown). */
  readonly total: number;
  constructor(message: string, issues?: PrototypeIssue[], total?: number) {
    super(message);
    this.name = "PrototypeError";
    this.issues = issues ?? [{ message }];
    this.total = Math.max(total ?? 0, this.issues.length);
  }
}

/** At most this many problems are listed: past them, fixing the first ones usually changes the rest. */
export const PROTOTYPE_ISSUES_KEPT = 100;
/**
 * The problems of one document held while its lines are found, in the order of the document (about that of its
 * lines); past them each problem is only counted. compactIssues then keeps what the list can still show.
 */
const DOCUMENT_ISSUES_READ = 10_000;

/** "page contatti, riga 93: …", as the report and the agent read it. */
export function formatPrototypeIssue(issue: PrototypeIssue): string {
  return issue.document ? `${issue.document}${issue.line ? `, riga ${issue.line}${issue.column ? `, colonna ${issue.column}` : ""}` : ""}: ${issue.message}` : issue.message;
}

/** The issues in the order of the file: stable, so problems of one line keep their order; those without a line come first (they concern the whole file). */
function inFileOrder(issues: PrototypeIssue[]): PrototypeIssue[] {
  return issues.map((issue, index) => ({ issue, index })).sort((left, right) => (left.issue.line ?? 0) - (right.issue.line ?? 0) || left.index - right.index).map(({ issue }) => issue);
}

/**
 * All the problems at once, in the order of the file, numbered in the message for whoever reads only that. `unlisted`
 * are problems counted but no longer held (compactIssues, and those past a document's DOCUMENT_ISSUES_READ): they are
 * in the count, never in the list.
 */
function allIssuesError(issues: PrototypeIssue[], unlisted = 0): PrototypeError {
  const kept = inFileOrder(issues).slice(0, PROTOTYPE_ISSUES_KEPT);
  const total = issues.length + unlisted;
  if (kept.length === 1 && total === 1) return new PrototypeError(formatPrototypeIssue(kept[0]!), kept, total);
  const more = total - kept.length;
  return new PrototypeError(`Il prototipo ha ${total} errori:\n${kept.map((issue, index) => `${index + 1}. ${formatPrototypeIssue(issue)}`).join("\n")}${more ? `\n… e altri ${more}: correggi questi e ricontrolla.` : ""}`, kept, total);
}

/**
 * Holds only what can still be among the first PROTOTYPE_ISSUES_KEPT of the file and counts the rest in
 * `context.unlisted`: a problem with that many before it (by line, then as found, the order allIssuesError lists them
 * in) stays out of the list whatever comes later, since what comes later is found later. A prototype with millions of
 * problems so holds hundreds, not millions (E4: the build runs on the server's thread). The kept problems stay the
 * same objects in the order they came, so the list and the count are those all of them would give, and refusal()
 * still recognises them.
 */
function compactIssues(context: BuildContext): void {
  if (context.issues.length <= 4 * PROTOTYPE_ISSUES_KEPT) return;
  const kept = new Set(inFileOrder(context.issues).slice(0, PROTOTYPE_ISSUES_KEPT));
  const before = context.issues.length;
  const remaining = context.issues.filter((issue) => kept.has(issue));
  context.issues.splice(0, before, ...remaining);
  context.unlisted += before - remaining.length;
}

function failAll(context: BuildContext): never {
  throw allIssuesError(context.issues, context.unlisted);
}

/**
 * Line numbers by offset for many lookups in one text: its newlines are indexed once, then each lookup is a binary
 * search. Thousands of problems in a template of megabytes must not rescan it from the start each time (E4: the build
 * runs on the server's thread).
 */
function lineFinder(text: string): (offset: number) => number {
  const newlines: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) newlines.push(index);
  return (offset) => {
    // Newlines before the offset, as locate() counts them.
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (newlines[middle]! < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["document"];

interface PrototypeManifest {
  id: string;
  name: string;
  locale?: string;
  timeZone?: string;
  framework: "histos-css" | "none" | "acss";
  /** With framework acss (C1): ACSS names become Histeon CSS names (convert, the default) or stay, for a site with ACSS. */
  acss?: "convert" | "keep";
  design?: Record<string, unknown>;
  /** Doc 28: the site's own variables, name → value, printed as `--xb-site-<name>` (the rules of validateSiteTokens). */
  siteTokens?: Record<string, unknown>;
  /** The shop of the project's products (queue C6): its WordPress site and currency, as written (checked by declarationIssues). */
  shop?: unknown;
}

interface PrototypeAssetDeclaration { name: string; url?: string; data?: string; alt: string; caption: string }

interface PrototypeDocument {
  kind: "component" | "part" | "template" | "page" | "post";
  attributes: Record<string, string>;
  source: string;
  label: string;
  /** Line of the file where the document's content starts, for messages. */
  line: number;
  /** Column of that line where the content starts, just past the `<template …>` tag: a column on the content's first line counts from here. */
  column: number;
  /** Where each attribute of the `<template …>` tag starts in the file: a problem of a value (data-ref, data-slug…) is said there. */
  places?: Readonly<Record<string, Place>>;
}

/** A line and a column of the file, both counted from 1. */
interface Place {
  line: number;
  column: number;
}

/**
 * Where each entry of the content's lists starts in the file (`types[i]`, `records[i]`…, and the fields of each type):
 * JSON.parse keeps no positions, so the problems of a value of the content are said at its entry (contentPlaces).
 */
interface ContentPlaces {
  types: Place[];
  taxonomies: Place[];
  terms: Place[];
  records: Place[];
  queries: Place[];
  /** `fields[i][j]`: field j of type i. */
  fields: Place[][];
}

export interface ParsedPrototype {
  manifest: PrototypeManifest;
  assets: PrototypeAssetDeclaration[];
  content: Record<string, unknown>;
  /** Doc 18 §6.6: the JavaScript of pages (by slug) and components (by ref), never run here. */
  scripts?: { pages: Record<string, string>; components: Record<string, string> };
  /** `unparsed`: a sheet past the bounds of cssParseCost, kept as written and never parsed, and why. */
  globals: Array<{ name: string; css: string; unparsed?: CssParseProblem }>;
  selectors: string | null;
  documents: PrototypeDocument[];
  ignored: Array<{ what: string; why: string; line?: number }>;
  /** What the reading changed and the report says: an inline source map taken out of a sheet. */
  warnings?: string[];
  /** The file line where each global sheet's CSS and the selector styles start, for the warnings about their rules. */
  sheetLines?: { globals: number[]; selectors: number };
  /** Where the manifest's JSON, each of its keys, the content's entries and the asset entries start, for the problems of their values. */
  places?: { manifest?: Place; manifestKeys?: Readonly<Record<string, Place>>; content?: ContentPlaces; assets?: Place[] };
}

function fail(message: string): never {
  throw new PrototypeError(message);
}

function attributesOf(element: Element): Record<string, string> {
  return Object.fromEntries(element.attrs.map((attribute) => [attribute.name, attribute.value]));
}

/** The text between an element's tags, exactly as written (template contents keep their braces and markup). */
function innerSource(html: string, element: Element): string {
  const location = element.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) fail(`L'elemento <${element.tagName}> non è chiuso.`);
  return html.slice(location.startTag.endOffset, location.endTag.startOffset);
}

function jsonPart(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}: JSON non valido.`);
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: serve un oggetto.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) fail(`${label}: serve un testo di al massimo ${max} caratteri.`);
  return value;
}

/** The line of the file where a node starts, for the report (D1); nothing when the parser has no position for it. */
function lineOf(node: { sourceCodeLocation?: { startLine: number } | null }): { line?: number } {
  const line = node.sourceCodeLocation?.startLine;
  return typeof line === "number" ? { line } : {};
}

/**
 * The line of a text node's first visible character (D1). The node starts right after the previous tag, so its own
 * start line is that tag's whenever the text follows on a later line. Before that character there may be spaces,
 * comments, and tags the parser read without making a node of them: text after `</body>` or `</html>` joins the body's
 * last text node, whose span then holds those end tags, and a stray end tag in the body joins two runs of text the same
 * way. A tag inside a text node's span is always one of these, since any other starts an element and ends the text.
 * One pass, no regular expression: a run of megabytes of spaces would overflow a backtracking one.
 */
function textLineOf(html: string, node: { sourceCodeLocation?: { startLine: number; startOffset: number; endOffset: number } | null }): { line?: number } {
  const location = node.sourceCodeLocation;
  if (!location) return {};
  const end = location.endOffset;
  let newlines = 0;
  let index = location.startOffset;
  while (index < end) {
    const code = html.charCodeAt(index);
    if (code === 10) newlines++;
    if (code === 10 || code === 32 || code === 9 || code === 12 || code === 13 || code === 11 || (code > 127 && /\s/u.test(html[index]!))) {
      index++;
      continue;
    }
    // `<!--…-->`, `</…>`, `<!…>` or `<name…>`; anything else is the text itself.
    const comment = html.startsWith("<!--", index);
    if (code !== 60 || (!comment && !/^<[!/]?[A-Za-z]/u.test(html.slice(index, index + 3)))) break;
    const close = comment ? html.indexOf("-->", index + 4) : html.indexOf(">", index + 1);
    if (close < 0 || close >= end) break;
    for (const after = close + (comment ? 3 : 1); index < after; index++) if (html.charCodeAt(index) === 10) newlines++;
  }
  return { line: location.startLine + newlines };
}

/** A value of the file inside a message: never the whole of a long one. */
function shown(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

/** A `data-histos` element the import would not read, with where it is: in an element, or written in text. */
interface LostHistos {
  tag: string;
  value: string;
  line: number | undefined;
  /** The element whose text holds it, when the browser reads it as text (inside <noscript>, <textarea>, <script>…). */
  text?: Element;
}

/** HTML whitespace. */
function htmlSpace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

/** An ASCII letter, which after `<` starts a tag. */
function asciiLetter(code: number): boolean {
  return (code | 0x20) >= 97 && (code | 0x20) <= 122;
}

/** A character of a CSS name (a letter, a digit, `-`, `_`, or past ASCII): `url(` after one is no url. */
function cssNameCode(code: number): boolean {
  return asciiLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 95 || code >= 0x80;
}

/** A character of a JavaScript name or number (a letter, a digit, `_`, `$`, or past ASCII). */
function jsNameCode(code: number): boolean {
  return asciiLetter(code) || (code >= 48 && code <= 57) || code === 95 || code === 36 || code >= 0x80;
}

/** How many open start tags a script's text keeps for the end tags that close them (histosTagIn): each end tag looks through them once. */
const OPENED_KEPT = 64;

/** How deep a script's template literals are followed into their `${…}` (histosTagIn): deeper, a `${` is read as text. */
const JS_TEMPLATES_KEPT = 256;

/** JavaScript words after which a `/` opens a regular expression and a `<` is no comparison: an operand follows them. */
const JS_REGEX_WORDS: ReadonlySet<string> = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** The words after which a `{` opens a block (after the others of JS_REGEX_WORDS it opens an object). */
const JS_BLOCK_WORDS: ReadonlySet<string> = new Set(["do", "else", "try", "finally"]);
/** The words whose `(…)` heads a statement: after its `)` a `/` opens a regular expression (`if (ok) /<p>/.test(x)`). */
const JS_HEAD_WORDS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);
/** How deep a script's braces and parentheses are told apart (histosTagIn): deeper, what follows one is a guess. */
const JS_NESTING_KEPT = 1024;
/** What a script's `{` opens, as histosTagIn tells it from the token before: a block, an object, or either. */
const JS_BLOCK = 1, JS_OBJECT = 2, JS_EITHER = 3;
/**
 * The last token of a script that histosTagIn's lexer keeps for a `{` or a `(`: a punctuator by its own code, or one of
 * these (the start of a statement, a value, a name, `=>`, a word of JS_BLOCK_WORDS, another of JS_REGEX_WORDS, one of
 * JS_HEAD_WORDS).
 */
const JS_START = -1, JS_VALUE = -2, JS_NAME = -3, JS_ARROW = -4, JS_BLOCK_WORD = -5, JS_OPERATOR_WORD = -6, JS_HEAD_WORD = -7;

/** The elements whose content the browser reads as text, one text node (scripting on: <noscript> too). */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);

/**
 * A tag written in text, with the offset where it starts: a start tag with `data-histos` (its `value`), or, in the text
 * of a part of the prototype (histosTagIn's `part`), another sign that the text is markup (a `style`, a `/template`, a
 * `!--`), with no value.
 */
interface HistosTag {
  offset: number;
  tag: string;
  value?: string;
}

/**
 * The text of a <script> or <style> closed by an end tag, while histosTagIn reads it: code, or markup written in the
 * wrong place, which only the whole of it tells (see histosTagIn).
 */
interface RawRegion {
  name: string;
  /** Where its text starts, and where it ends: at its end tag. */
  from: number;
  end: number;
  /** How code is told from markup in it: as the browser reads its CSS or JavaScript, as JSON.parse reads its JSON (see histosTagIn's `standing`). */
  lexer: "css" | "json" | "js";
  /**
   * How far that reading has gone: what lies before it in a comment, a string or a url() is code; in `unsure`, a string
   * its line ended (maybe markup's text, `L'opera`), and in `comment`, the last JavaScript comment.
   */
  lexed: number;
  unsure?: [number, number];
  comment?: [number, number];
  /**
   * Where the reading of a script stands: whether an operand comes next (a `/` opens a regular expression, a `<` is no
   * comparison), inside a template literal, at the start of a line (`-->` opens a comment), and the braces of `${…}`.
   */
  js?: {
    operand: boolean; template: boolean; lineStart: boolean; braces: number[]; depth: number;
    /**
     * The last token (JS_START…), what each open `{` opens (JS_BLOCK…) and whether each open `(` heads a statement, by
     * their depth (up to JS_NESTING_KEPT), and whether `operand` is a guess, after a `}` that may end a block or an
     * object (review 8).
     */
    last: number; kinds: number[]; heads: boolean[]; parens: number; guess: boolean;
  };
  /**
   * In a script, the names of the last start tags standing where markup writes them on one line (at most OPENED_KEPT),
   * and where that line ends: an end tag closing one of them on that line stands so too.
   */
  opened: string[];
  openedLine: number;
  /** The text of a data-histos <style> or JSON <script>, whose every sign counts (see histosTagIn's `part`). */
  part: boolean;
  /** In a part's CSS, up to where a url( read on as CSS reaches, inside which a `url(` is no url (review 9). */
  urlText: number;
  /**
   * A sign that it is markup: it opens with a start tag, it is a <script src> holding anything, or it holds one of the
   * tags below where markup writes them; and the first such tag, besides data-histos ones.
   */
  markup: boolean;
  sign?: HistosTag;
  /** The first data-histos start tag read in it, and the first where markup writes one, also in a region inside it read as markup. */
  found?: HistosTag;
  placedFound?: HistosTag;
  /** Where the first data-histos <template> read in it starts, and the last </template> after it: a whole page is markup. */
  template: number;
  templateEnd: number;
}

/**
 * The first start tag carrying a `data-histos` attribute in `text` read as markup, with the offset where it starts:
 * only what the HTML tokenizer reads as a start tag, `<` and a letter, the name up to a space, `/` or `>`, attributes
 * with their values (quoted or not; of a repeated name the first counts) and the `>` that ends it. A tag the text ends
 * inside is none, nor is anything in a comment, an end tag, `<!…>` or `<?…>`.
 *
 * The text of a <script> or <style> is read up to its first end tag (`</script` and a space, `/` or `>`; the `<!--`
 * escapes of a script are not followed), and is code unless it is markup written in the wrong place (review 5). The
 * browser ends that text only at the matching end tag, so a <script> or <style> left open swallows everything up to the
 * end tag of a later one, or to a lone end tag (a stray one, one in an HTML comment), the pages in between too. Such a
 * text always shows it, and code never does:
 * - it opens with a start tag (`<` and a letter): JavaScript and CSS never do (a page wrapped in a script);
 * - it belongs to a <script src> and holds anything but spaces: the browser never runs that text, so it is never code
 *   (the next lines of the file after `<script src="…">` left open);
 * - it holds, where markup writes a tag, a data-histos start tag of any element (a page, a sheet, the manifest: whole,
 *   or cut by the end tag that closed the text), a start tag of its own element (`<script…` in a script, `<style…` in
 *   a style), a `</head…>` or a `<body…>`: the start tag of the later script or style whose end tag closed it, or the
 *   head's end and the body after a head script left open;
 * - it holds a whole page: a `<template data-histos…>` start tag and, after it, where markup writes a tag, a
 *   `</template…>` end tag;
 * - it ends inside an HTML comment opened where markup writes a tag: the end tag that closed it was written in that
 *   comment, by someone who thought they were writing markup (`<!-- </script> -->`); in a part's CSS a `<!--` without
 *   its `-->` is the token CSS ignores, read on as CSS, which shows nothing by itself (review 9).
 * Where markup writes a tag the text tells by its own language, read as the browser reads it (`standing`, review 7). In
 * a style, anywhere outside the CSS's comments, strings and url(), where CSS never holds a tag: `p{}<style
 * data-histos="global">` on one line too. In a script, where the JavaScript stands for an operand outside its strings,
 * comments, template literals and regular expressions (after `;`, `{`, `=`…: `go();<template data-histos…>`; a `/`
 * after the `)` of an `if (…)` or the `}` of a block opens a regular expression, review 8), as the first thing on its
 * line, or right after the `>` of a tag or comment written so (`<main><template …>`), and an end tag that closes on its
 * line a start tag written so (`<p>x</p><!-- </script> -->`); never after another `>` (`=>`, `->`,
 * `body > <template…>`, a tag in a string `'<main><template…'`), nor a `<` that compares (`i<pages.length`), which is
 * no tag. So a comment or a string that names any tag, a data-histos one of the text's own element and `<body>` too
 * (`// legge <script data-histos="manifest">`, `/* le regole stanno in <style data-histos="global"> *\/`), shows none
 * of these signs; a line of a script that starts with a data-histos tag (in a template literal or a comment of many
 * lines) does, and is refused (review 6). Each sign is read as the tokenizer reads tags. A sign makes the whole text
 * markup, and its first data-histos start tag is lost: the first where markup writes one, else the first that is not
 * code's (in a CSS comment, string or url(), a JavaScript string, block comment, template literal or regular
 * expression it is no element; after `//` on its line, or in a string its line ends, it may be one). The text of a
 * <script> or <style> that its end tag does not close (the rest of the file, or of the text around it) is markup. In
 * the text then read as markup, what a <script> or <style> holds is read by the same rule; the content of any other
 * element the browser reads as text (a <textarea> in a <noscript>) is read as markup, as it would be one level up.
 *
 * `root` says that `text` itself is the text of a <script> or <style> closed by its end tag (`src`: a script with that
 * attribute), read by the rule above; without it, `text` is markup. With `part`, the text of a data-histos <style> (CSS)
 * or JSON <script> (JSON: markup outside its strings or first on a line), whose every sign counts, a `</template>`
 * standing where markup writes it too, and its CSS read on past a comment or a url( that holds `data-histos` and (a
 * comment) another of its kind after it (see lex, tookInLater): the answer is then its first data-histos tag where
 * markup writes one, else its first sign. One pass, each search memoized (the next end tag, quote, `>`, line feed,
 * comment end or `data-histos` is looked for once from where it was last found; a tag cut short by a line that opens
 * with a tag resumes there, past all it read), each region's language read once, and at most two regions open (a
 * script and a style inside it, or the reverse, since a region of the same name ends with the one around it): linear
 * in the length of the text, as the server reads a file of 32 MB synchronously.
 */
function histosTagIn(text: string, root?: { name: "script" | "style"; src: boolean; part?: "css" | "json" }): HistosTag | undefined {
  const length = text.length;
  const at = (index: number) => text.charCodeAt(index);
  /** Each search, by what it looks for: where it started and what it found (-1: nothing). */
  const searches = new Map<string, { from: number; found: number }>();
  /** Where `find(from)`, the first match at or after `from`, is: found again only past the last one. */
  const memoized = (key: string, from: number, find: (from: number) => number): number => {
    const last = searches.get(key);
    if (last && from >= last.from && (last.found === -1 || from <= last.found)) return last.found;
    const found = find(from);
    searches.set(key, { from, found });
    return found;
  };
  const seek = (needle: string, from: number) => memoized(needle, from, (start) => text.indexOf(needle, start));
  /** Past the `>` that ends `<!…>`, `<?…>` or `</ …>` from `from`: up to `to`, when none does before. */
  const toClose = (from: number, to: number) => {
    const close = seek(">", from);
    return close === -1 || close >= to ? to : close + 1;
  };
  /** Past the comment whose text starts at `from`: `-->` or `--!>` end it, or `>` and `->` right away; -1 when none does before `to`. */
  const commentEnd = (from: number, to: number) => {
    if (from < to && at(from) === 62) return from + 1;
    if (from + 1 < to && at(from) === 45 && at(from + 1) === 62) return from + 2;
    const dash = memoized(" --", from, (start) => {
      for (let index = text.indexOf("--", start); index !== -1; index = text.indexOf("--", index + 1)) {
        if (at(index + 2) === 62 || (at(index + 2) === 33 && at(index + 3) === 62)) return index;
      }
      return -1;
    });
    const end = dash === -1 ? -1 : dash + (at(dash + 2) === 62 ? 3 : 4);
    return end > to ? -1 : end;
  };
  /** The first `data-histos` at or after `from`, in any case, or -1. */
  const histosPattern = /data-histos/giu;
  const histosAt = (from: number) => memoized("data-histos", from, (start) => {
    histosPattern.lastIndex = start;
    return histosPattern.exec(text)?.index ?? -1;
  });
  /**
   * Whether a comment or a url() of a part's CSS that runs from `from` to `close` holds `data-histos` (in any case) and,
   * with `opener`, that opener again after it (review 9): then its end is most likely a later sheet's, which the part
   * took in with what came before it, a page, a sheet, a part. A sheet's own comment may name a data-histos element, and
   * no other comment after it.
   */
  const tookInLater = (from: number, close: number, opener?: string): boolean => {
    const histos = histosAt(from);
    if (histos === -1 || histos >= close) return false;
    if (opener === undefined) return true;
    const again = memoized(`${opener} late`, histos, (start) => text.indexOf(opener, start));
    return again !== -1 && again < close;
  };
  /** Where the line after the line feed at `feed` opens with a start tag (spaces, `<` and a letter) before `to`, or -1. */
  const lineTag = (feed: number, to: number) => {
    let next = feed + 1;
    while (next < to && htmlSpace(at(next)) && at(next) !== 10) next++;
    return next + 1 < to && at(next) === 60 && asciiLetter(at(next + 1)) ? next : -1;
  };
  /** Where the end tag of a <script> or <style> whose text starts at `from` starts: `</name` and a space, `/` or `>`; -1 if none. */
  const endTag = (name: string, from: number) => memoized(`</${name}`, from, (start) => {
    for (let close = text.indexOf("</", start); close !== -1; close = text.indexOf("</", close + 2)) {
      const after = at(close + 2 + name.length);
      if ((htmlSpace(after) || after === 47 || after === 62) && text.slice(close + 2, close + 2 + name.length).toLowerCase() === name) return close;
    }
    return -1;
  });
  /**
   * The tag whose name starts at `start`, read to its `>` before `to`: where it ends, its name, its data-histos, whether
   * it has src; none if `to` comes first. A line inside it that opens with a start tag (`<` and a letter) ends it: no
   * tag of markup holds one (attributes on many lines never start with `<`), so the `<` that began it was text, a
   * comparison in code (`i<pages.length` read up to the `>` of a page on a later line), and the reading resumes at the
   * tag that opens the line.
   */
  const readTag = (start: number, to: number): { end: number; name: string; histos: string | undefined; src: boolean } | { resume: number } | undefined => {
    let index = start;
    while (index < to && !htmlSpace(at(index)) && at(index) !== 47 && at(index) !== 62) index++;
    const name = text.slice(start, index).toLowerCase();
    let histos: string | undefined;
    let src = false;
    /** Past the spaces (and with `slash`, the `/`) from `index`: where it stops, or the tag opening a line among them. */
    const spaces = (slash: boolean): number | { resume: number } => {
      while (index < to && (htmlSpace(at(index)) || (slash && at(index) === 47))) {
        if (at(index) === 10) {
          const resume = lineTag(index, to);
          if (resume !== -1) return { resume };
        }
        index++;
      }
      return index;
    };
    for (;;) {
      // Spaces, and a `/` not before `>`, which the tokenizer reads as one.
      const gap = spaces(true);
      if (typeof gap !== "number") return gap;
      if (index >= to) return undefined;
      if (at(index) === 62) return { end: index + 1, name, histos, src };
      // A name runs to a space, `/`, `>` or `=` (one that starts it is part of it).
      const nameStart = index++;
      while (index < to && !htmlSpace(at(index)) && at(index) !== 47 && at(index) !== 62 && at(index) !== 61) index++;
      const attribute = index - nameStart === 11 || index - nameStart === 3 ? text.slice(nameStart, index).toLowerCase() : "";
      const before = spaces(false);
      if (typeof before !== "number") return before;
      let value = "";
      if (index < to && at(index) === 61) {
        index++;
        const after = spaces(false);
        if (typeof after !== "number") return after;
        const quote = at(index);
        if (index < to && (quote === 34 || quote === 39)) {
          const found = seek(text[index]!, index + 1);
          const close = found === -1 || found >= to ? to : found;
          for (let feed = seek("\n", index + 1); feed !== -1 && feed < close; feed = seek("\n", feed + 1)) {
            const resume = lineTag(feed, close);
            if (resume !== -1) return { resume };
          }
          if (close === to) return undefined;
          value = text.slice(index + 1, close);
          index = close + 1;
        } else {
          const valueStart = index;
          while (index < to && !htmlSpace(at(index)) && at(index) !== 62) index++;
          value = text.slice(valueStart, index);
        }
      }
      if (attribute === "data-histos") histos ??= value;
      else if (attribute === "src") src = true;
    }
  };
  /** Where the last tag or comment read where markup writes one ends, past its `>` (-1: none yet). */
  let chainEnd = -1;
  /**
   * Whether the tag whose `<` is at `start` stands where markup writes a tag in a script: nothing but spaces between it
   * and the start of its line, of the text, or the `>` of a tag or comment that stands so itself (`<main><template …>`
   * first on a line), never another `>` (`=>`, `->`, a `>` in a comment or a string). Each call walks back over the
   * spaces before one tag only, which no other call walks: linear in all.
   */
  const placed = (start: number) => {
    let index = start - 1;
    while (index >= 0 && htmlSpace(at(index))) {
      if (at(index) === 10) return true;
      index--;
    }
    return index < 0 || index + 1 === chainEnd;
  };
  /**
   * Reads the JavaScript of the script region `region` on to `to`: strings (to their quote, or to the end of their line,
   * which leaves what they hold unsure), template literals with their `${…}`, regular expressions (where a `/` cannot
   * divide: after an operator, an opening bracket, a word like `return`, the `)` of an `if`, `while`, `for` or `with`
   * head, or a `}` that ends a block; after a `}` that may end an object too, what one holds is unsure, review 8),
   * comments `//`, `<!--` and `-->` at the start of a line (to its end) and `/* *\/` closed before the region's end, all
   * read whole, past `to` when it lies inside them: a tag in a line comment is unsure (the rest of a line after `//`
   * holds whatever follows on it, a page the script swallowed too), in the rest code. `operand`: whether what comes
   * next stands where an operand does, where a `<` is no comparison. Each region is read once: linear in all.
   */
  const lexJs = (region: RawRegion, to: number): void => {
    const js = region.js!;
    let index = region.lexed;
    /** Past the end of the line from `from`, or the region's end. */
    const lineEnd = (from: number) => {
      let end = from;
      while (end < region.end && at(end) !== 10 && at(end) !== 13 && at(end) !== 0x2028 && at(end) !== 0x2029) end++;
      return end;
    };
    while (index < to) {
      const code = at(index);
      if (js.template) {
        if (code === 96) {
          js.template = false;
          js.operand = false;
          js.last = JS_VALUE;
          index++;
        } else if (code === 36 && at(index + 1) === 123 && js.braces.length < JS_TEMPLATES_KEPT) {
          js.braces.push(js.depth++);
          js.template = false;
          js.operand = true;
          // What `${` holds is an expression: a `{` there opens an object.
          js.last = 40;
          index += 2;
        } else index += code === 92 ? 2 : 1;
        continue;
      }
      if (jsSpace(code)) {
        if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) js.lineStart = true;
        index++;
        continue;
      }
      const open = index;
      if ((code === 47 && at(index + 1) === 47) || (code === 60 && text.startsWith("!--", index + 1)) || (code === 45 && js.lineStart && text.startsWith("->", index + 1))) {
        index = lineEnd(index);
        region.comment = [open, index];
        continue;
      }
      js.lineStart = false;
      const guess = js.guess;
      js.guess = false;
      if (code === 47 && at(index + 1) === 42) {
        js.guess = guess;
        // A comment that does not close before the region's end is read on as text: the region would end inside it.
        const close = memoized("*/ js", index + 2, (from) => text.indexOf("*/", from));
        index = close !== -1 && close + 2 <= region.end ? close + 2 : index + 2;
        continue;
      }
      if (code === 34 || code === 39 || (code === 47 && js.operand)) {
        // A string, or a regular expression (`[…]` holds a `/`).
        let closed = false;
        let range = false;
        index++;
        while (index < region.end) {
          const inside = at(index);
          if (inside === 10 || inside === 13 || inside === 0x2028 || inside === 0x2029) break;
          if (inside === 92) index += 2;
          else {
            index++;
            if (code === 47 && inside === 91) range = true;
            else if (range && inside === 93) range = false;
            else if (inside === code && !range) {
              closed = true;
              break;
            }
          }
        }
        // A regular expression read where a `/` might divide is unsure too.
        if (!closed || (code === 47 && guess)) region.unsure = [open, index];
        if (code === 47) while (index < region.end && jsNameCode(at(index))) index++;
        js.operand = false;
        js.last = JS_VALUE;
        continue;
      }
      if (code === 96) {
        js.template = true;
        index++;
        continue;
      }
      if (jsNameCode(code)) {
        // A word or a number: an operand, after which a `/` divides, unless it is one of JS_REGEX_WORDS.
        while (index < region.end && jsNameCode(at(index))) index++;
        const word = index - open <= 10 ? text.slice(open, index) : "";
        js.operand = JS_REGEX_WORDS.has(word);
        js.last = code >= 48 && code <= 57 ? JS_VALUE : JS_BLOCK_WORDS.has(word) ? JS_BLOCK_WORD : js.operand ? JS_OPERATOR_WORD : JS_HEAD_WORDS.has(word) ? JS_HEAD_WORD : JS_NAME;
        continue;
      }
      // After `]` a `/` divides, and after `)` but for the head of an `if`, `while`, `for` or `with` (review 8). After a
      // `}` that ends a block a statement starts, after one that ends an object a `/` divides, and one that may end
      // either (after a value or a `:`) leaves the regular expression after it unsure. After any other punctuator an
      // operand comes. `</` is an end tag's, never a comparison with a regular expression, which would read on through
      // the markup after it.
      let operand = code !== 93 && !(code === 60 && at(index + 1) === 47);
      let last = code === 62 && at(index - 1) === 61 ? JS_ARROW : code;
      if (code === 123) {
        // A `{` opens a block at the start of a statement, after `)`, `=>`, a name (`class A {`) or `else`, `do`, `try`,
        // `finally`; an object after an operator, `(`, `,`, `[`, `return`…
        const before = js.last;
        const kind = before === JS_START || before === 59 || before === 123 || before === 125 || before === 41 || before === JS_ARROW || before === JS_BLOCK_WORD || before === JS_NAME || before === JS_HEAD_WORD ? JS_BLOCK : before === JS_VALUE || before === 58 ? JS_EITHER : JS_OBJECT;
        if (js.depth >= 0 && js.depth < JS_NESTING_KEPT) js.kinds[js.depth] = kind;
        js.depth++;
      } else if (code === 125) {
        let kind = js.depth > 0 && js.depth <= JS_NESTING_KEPT ? js.kinds[js.depth - 1]! : JS_EITHER;
        if (js.braces.length && js.braces.at(-1) === js.depth - 1) {
          js.braces.pop();
          js.template = true;
          kind = JS_OBJECT;
        }
        js.depth--;
        operand = kind !== JS_OBJECT;
        js.guess = kind === JS_EITHER;
        last = kind === JS_OBJECT ? JS_VALUE : JS_START;
      } else if (code === 40) {
        if (js.parens >= 0 && js.parens < JS_NESTING_KEPT) js.heads[js.parens] = js.last === JS_HEAD_WORD;
        js.parens++;
      } else if (code === 41) {
        operand = js.parens > 0 && js.parens <= JS_NESTING_KEPT && js.heads[js.parens - 1]!;
        js.parens--;
      }
      js.operand = operand;
      js.last = last;
      index++;
    }
    region.lexed = index;
  };
  /**
   * Reads the CSS or the JSON of `region` on to `to`, as the browser's CSS tokenizer and JSON.parse read them (a script's
   * JavaScript, as lexJs): a CSS comment that closes before the region's end, a string and an unquoted CSS url() are
   * read whole, past `to` when it lies inside them; a `/*` that does not close before the region's end is read on as
   * text, since the region would end inside that comment. In a part (review 9), so is a url( that holds `data-histos`
   * (in any case) up to its `)` or the region's end, and a comment that holds `data-histos` and another `/*` after it:
   * its `)` or `*\/` is then most likely a later sheet's, which the part took in with the pages and parts before it (see
   * tookInLater). A string the end of its line (or of the region) ends without its quote is no code's:
   * markup's text (`L'opera`) opens one too, so what it holds stays unsure. Whether a comment opened on the way. Each
   * region is read once: linear in all.
   */
  const lex = (region: RawRegion, to: number): boolean => {
    if (region.lexer === "js") {
      lexJs(region, to);
      return false;
    }
    const css = region.lexer === "css";
    let index = region.lexed;
    let comment = false;
    while (index < to) {
      const code = at(index);
      if (css && code === 47 && at(index + 1) === 42) {
        const close = seek("*/", index + 2);
        if (close !== -1 && close + 2 <= region.end && !(region.part && tookInLater(index + 2, close, "/*"))) {
          comment = true;
          index = close + 2;
        } else index += 2;
      } else if (code === 34 || (css && code === 39)) {
        const open = index++;
        let closed = false;
        while (index < region.end) {
          const inside = at(index);
          if (inside === code) {
            index++;
            closed = true;
            break;
          }
          if (inside === 10 || inside === 12 || inside === 13) break;
          index += inside === 92 ? 2 : 1;
        }
        if (!closed) region.unsure = [open, index];
      } else if (css && code === 92) index += 2;
      else if (css && index >= region.urlText && (code | 0x20) === 117 && (at(index + 1) | 0x20) === 114 && (at(index + 2) | 0x20) === 108 && at(index + 3) === 40 && !cssNameCode(at(index - 1))) {
        // `url(`: with a quote after its spaces a function holding a string, else a url up to its `)`.
        let next = index + 4;
        while (next < region.end && cssSpace(at(next))) next++;
        if (at(next) === 34 || at(next) === 39) index = next;
        else {
          while (next < region.end && at(next) !== 41) next += at(next) === 92 ? 2 : 1;
          // In a part, one that holds `data-histos` up to its `)` or the region's end is read on as CSS (review 9): a
          // sheet left open inside it (`url(sfondo.png}`, then a page) would end it at a later sheet's `)` or hide all to
          // the end of the region. A `url(` in what it holds is then no url again: each is read once.
          if (region.part && tookInLater(index + 4, next)) {
            region.urlText = Math.min(next, region.end);
            index += 4;
          } else index = Math.min(next + 1, region.end);
        }
      } else index++;
    }
    region.lexed = index;
    return comment;
  };
  /** Whether `start` lies in `range`. */
  const within = (range: [number, number] | undefined, start: number) => range !== undefined && start >= range[0] && start < range[1];
  /**
   * Where the tag or comment that starts at `start` (its tag up to `end`) stands: `markup` where markup writes one,
   * `code` where code names it, `unsure` else. Outside a region, always markup. In the text of a <style>, markup outside
   * the CSS's comments, strings and url() when no comment opens inside the tag (`(a<b) { /* … *\/` is a comparison in
   * a media query, then a comment), code inside them. In JSON, markup outside its strings or first on its line, code
   * inside them. In a script, markup outside its strings, comments, template literals and regular expressions where an
   * operand stands (after `;`, `{`, `=`…: never a comparison `i<pages.length`), where `placed` says, and an end tag that
   * closes on its line a start tag standing so (`<p>x</p>`); code inside a string, template literal or regular
   * expression; unsure elsewhere: in a comment, after an operand. Inside a string its line ends, unsure anywhere. A tag
   * right after one standing where markup writes it does too (`chainEnd`, which the caller moves).
   */
  const standing = (inside: RawRegion | undefined, start: number, end: number, endTag?: string): "markup" | "code" | "unsure" => {
    if (!inside) return "markup";
    if (inside.lexer === "css" || inside.lexer === "json") {
      if (start >= inside.lexed) lex(inside, start);
      let unsure = within(inside.unsure, start);
      if (inside.lexed === start) {
        if (lex(inside, end)) return "code";
        if (inside.lexed === end) return "markup";
        // Its `>` lies in a string (`(a<b) { content: "…>" }`, or an attribute's quote left open): maybe markup's.
        unsure = true;
      }
      if (inside.lexer === "json" && placed(start)) return "markup";
      return unsure ? "unsure" : "code";
    }
    const js = inside.js!;
    if (start >= inside.lexed) lexJs(inside, start);
    const outside = inside.lexed === start && !js.template;
    if (outside && js.operand) {
      // Markup: what it holds is no JavaScript, and a tag may follow it.
      inside.lexed = end;
      js.last = JS_START;
      js.guess = false;
      return "markup";
    }
    const unsure = outside || within(inside.comment, start) || within(inside.unsure, start);
    let open = -1;
    if (endTag !== undefined) {
      if (start > inside.openedLine) inside.opened.length = 0;
      open = inside.opened.lastIndexOf(endTag);
      if (open !== -1) inside.opened.length = open;
    }
    if (open !== -1 || placed(start)) {
      if (outside) {
        inside.lexed = end;
        js.operand = true;
        js.last = JS_START;
      }
      return "markup";
    }
    return unsure ? "unsure" : "code";
  };
  /** Whether the `<` at `start` in the script region `inside` compares: outside strings, comments and template literals, after an operand, not first on its line. */
  const comparison = (inside: RawRegion, start: number): boolean => {
    if (start >= inside.lexed) lexJs(inside, start);
    return inside.lexed === start && !inside.js!.template && !inside.js!.operand && !placed(start);
  };
  /** Keeps the start tag `name` at `start`, standing where markup writes it in a script, for the end tag that closes it on its line. */
  const keepOpened = (inside: RawRegion, start: number, name: string) => {
    if (start > inside.openedLine) inside.opened.length = 0;
    inside.opened.push(name);
    if (inside.opened.length > OPENED_KEPT) inside.opened.shift();
    const feed = memoized("line end", start, (from) => text.indexOf("\n", from));
    inside.openedLine = feed === -1 ? length : feed;
  };
  /** Marks `region` as markup, by the tag (or comment) `tag` at `offset`. */
  const mark = (region: RawRegion, offset: number, tag: string) => {
    region.markup = true;
    region.sign ??= { offset, tag };
  };
  /** A region for the text of a <script> or <style> from `from` to `end`, with the signs its opening gives. */
  const region = (name: string, from: number, end: number, src: boolean, json = false, part = false): RawRegion => {
    let first = from;
    while (first < end && htmlSpace(at(first))) first++;
    const opensWithTag = first + 1 < end && at(first) === 60 && asciiLetter(at(first + 1));
    let nameEnd = first + 1;
    while (opensWithTag && nameEnd < end && !htmlSpace(at(nameEnd)) && at(nameEnd) !== 47 && at(nameEnd) !== 62) nameEnd++;
    return {
      name, from, end, lexed: from, part, urlText: 0, opened: [], openedLine: -1, template: -1, templateEnd: -1,
      markup: opensWithTag || (src && first < end),
      lexer: json ? "json" : name === "style" ? "css" : "js",
      ...(json || name === "style" ? {} : { js: { operand: true, template: false, lineStart: true, braces: [], depth: 0, last: JS_START, kinds: [], heads: [], parens: 0, guess: false } }),
      ...(opensWithTag ? { sign: { offset: first, tag: text.slice(first + 1, nameEnd).toLowerCase() } } : {}),
    };
  };
  const regions: RawRegion[] = root ? [region(root.name, 0, length, root.src, root.part === "json", root.part !== undefined)] : [];
  /**
   * Closes the innermost region. Read as markup, what it found is the region's around it (or, at the top, the answer:
   * its first data-histos tag where markup writes one, else its first anywhere; for a part, else its first sign);
   * read as code, nothing it holds counts.
   */
  const close = (): HistosTag | undefined => {
    const done = regions.pop()!;
    if (!done.markup && !(done.template >= 0 && done.templateEnd > done.template)) return undefined;
    const outer = regions.at(-1);
    if (!outer) return done.placedFound ?? (done.part ? done.sign : undefined) ?? done.found;
    if (done.found) outer.found ??= done.found;
    if (done.placedFound) outer.placedFound ??= done.placedFound;
    if (outer.template < 0) outer.template = done.template;
    outer.templateEnd = Math.max(outer.templateEnd, done.templateEnd);
    return undefined;
  };
  let index = 0;
  for (;;) {
    while (regions.length && index >= regions.at(-1)!.end) {
      const found = close();
      if (found) return found;
    }
    const inside = regions.at(-1);
    const to = inside?.end ?? length;
    const start = seek("<", index);
    if (start === -1 || start >= to) {
      if (!inside) return undefined;
      index = to;
      continue;
    }
    const next = at(start + 1);
    index = start + 1;
    if (start + 1 < to && asciiLetter(next)) {
      // In a script, a `<` after an operand, outside strings and comments and not first on its line, compares: no tag,
      // and what follows it is read on (a page after `for (…; i<n; …) show();` on the same line).
      if (inside?.lexer === "js" && comparison(inside, start)) continue;
      const tag = readTag(start + 1, to);
      if (!tag) {
        // The rest is inside the tag.
        index = to;
        continue;
      }
      if ("resume" in tag) {
        index = tag.resume;
        continue;
      }
      index = tag.end;
      // In a region, a tag where markup writes one may be a sign; where code names it, it is no element.
      const stands = standing(inside, start, tag.end);
      const markup = stands === "markup";
      if (markup) {
        chainEnd = tag.end;
        if (inside?.lexer === "js") keepOpened(inside, start, tag.name);
      }
      if (tag.histos !== undefined && stands !== "code") {
        const found: HistosTag = { offset: start, tag: tag.name, value: tag.histos };
        if (!inside) return found;
        inside.found ??= found;
        if (tag.name === "template" && inside.template < 0) inside.template = start;
        // A data-histos element starts here, whole or cut where the text ends: each text around it is markup.
        if (markup) {
          inside.placedFound ??= found;
          for (const open of regions) open.markup = true;
        }
      }
      const own = tag.name === inside?.name;
      if (inside && markup && (own || tag.name === "body")) mark(inside, start, tag.name);
      // A start tag of its own element that code names is no element: the text goes on.
      if (own && !markup) continue;
      if (tag.name === "script" || tag.name === "style") {
        const end = endTag(tag.name, tag.end);
        if (end !== -1 && end < to) regions.push(region(tag.name, tag.end, end, tag.name === "script" && tag.src));
        else if (inside?.name === tag.name) {
          // Its end tag is the region's own, which so holds nothing more of its own: it is markup (it holds this start
          // tag), and the new one is read in its place, up to that end tag.
          const found = close();
          if (found) return found;
          regions.push(region(tag.name, tag.end, inside.end, tag.name === "script" && tag.src));
        }
        // Else nothing closes it before the text around it ends: its text is read as markup, with that text.
      }
    } else if (next === 47) {
      // `</name…>` is an end tag, `</>` nothing, `</` and anything else a comment up to `>`; at the end, text.
      if (start + 2 < to && asciiLetter(at(start + 2))) {
        const tag = readTag(start + 2, to);
        if (!tag) {
          index = to;
          continue;
        }
        if ("resume" in tag) {
          index = tag.resume;
          continue;
        }
        index = tag.end;
        const markup = standing(inside, start, tag.end, tag.name) === "markup";
        if (markup) chainEnd = tag.end;
        if (inside && markup && (tag.name === "head" || tag.name === "template")) {
          if (tag.name === "head") mark(inside, start, "/head");
          else {
            inside.templateEnd = start;
            // In a part of the prototype, CSS or JSON, the end of a page is markup by itself.
            if (inside.part) mark(inside, start, "/template");
          }
        }
      } else if (start + 2 < to && at(start + 2) === 62) index = start + 3;
      else if (start + 2 < to) {
        index = toClose(start + 2, to);
        if (standing(inside, start, start) === "markup") chainEnd = index;
      }
    } else if (next === 33 && start + 1 < to) {
      const cdo = inside?.lexer === "css" && inside.part && text.startsWith("--", start + 2);
      const end = cdo ? commentEnd(start + 4, to) : -1;
      if (cdo && (end === -1 || tookInLater(start + 4, end, "<!--"))) {
        // In a part's CSS a `<!--` without its `-->` before the region's end, or whose comment holds `data-histos` and
        // another `<!--` after it, is the token CSS ignores (CDO), read on as CSS (review 9): it hides nothing, and
        // shows nothing by itself. Paired, it hides what it holds, like a comment.
        index = start + 4;
      } else if (cdo) index = end;
      else if (text.startsWith("--", start + 2) && start + 3 < to) {
        const end = commentEnd(start + 4, to);
        const markup = standing(inside, start, start) === "markup";
        // The text ends inside a comment markup opened: the end tag that closed it stands in that comment, a lone
        // `</script>` in `<!-- … -->` (one in a <script> after `<!-- <script` would not close it), and it is markup.
        if (end === -1 && inside && markup) mark(inside, start, "!--");
        index = end === -1 ? to : end;
        if (markup) chainEnd = index;
      } else {
        index = toClose(start + 2, to);
        if (standing(inside, start, start) === "markup") chainEnd = index;
      }
    } else if (next === 63 && start + 1 < to) {
      index = toClose(start + 2, to);
      if (standing(inside, start, start) === "markup") chainEnd = index;
    }
  }
}

/**
 * A `data-histos` tag written in a text node as the file holds it: the text of an element the browser reads as text
 * (<noscript>, <textarea>, <title>, <xmp>, <iframe>, <noembed>, <noframes>, <plaintext>, which takes the rest of the
 * file, a <script> or <style>), or a tag the parser drops where it stands. The page or sheet it opens would vanish with
 * the text. The text of a <script> or <style> closed by its end tag is code unless it is markup in the wrong place, which
 * histosTagIn tells: what a comment, a string or a comparison says about tags is no page; one left open to the end of
 * the file is read as markup. The file's own characters are read, so `&lt;template data-histos…` in a <textarea> is
 * the text it says.
 */
function histosInText(html: string, node: Node, container: Element): LostHistos | undefined {
  const location = node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).sourceCodeLocation : undefined;
  if (!location) return undefined;
  // The text of an element read as text is all that its start tag is followed by, up to the text node's end: parse5
  // starts that node a few characters late after the newline a <textarea> drops (`</`, `&lt;`), which would read a
  // `</ …>` around a tag as text. Elsewhere it starts a run of text that opens with `<` one character late when
  // spaces it dropped come first: that `<` is the run's own, since anything else before a text ends with `>`.
  const startTag = TEXT_ELEMENTS.has(container.tagName) && container.childNodes.length === 1 ? container.sourceCodeLocation?.startTag : undefined;
  const from = startTag ? startTag.endOffset : html.charCodeAt(location.startOffset - 1) === 60 ? location.startOffset - 1 : location.startOffset;
  const source = html.slice(from, location.endOffset);
  const raw = (container.tagName === "script" || container.tagName === "style") && container.sourceCodeLocation?.endTag ? container.tagName : undefined;
  const found = histosTagIn(source, raw ? { name: raw, src: raw === "script" && container.attrs.some((attribute) => attribute.name === "src") } : undefined);
  if (!found) return undefined;
  let line = startTag ? startTag.endLine : location.startLine;
  for (let index = source.indexOf("\n"); index !== -1 && index < found.offset; index = source.indexOf("\n", index + 1)) line++;
  return { tag: found.tag, value: found.value ?? "", line, text: container };
}

/**
 * The first `data-histos` element inside `root`, in the order of the file, template contents included, or written in
 * the text of one: the import reads only those directly in `<head>` or `<body>`, so one further in would be lost
 * without a word. Iterative: an ignored element may be nested as deep as the file allows.
 */
function nestedHistos(html: string, root: Element): LostHistos | undefined {
  const childrenOf = (node: Element): Node[] => (node.tagName === "template" && "content" in node ? (node as DefaultTreeAdapterMap["template"]).content.childNodes : node.childNodes);
  const stack: Array<{ node: Node; parent: Element }> = [];
  const push = (parent: Element) => {
    const children = childrenOf(parent);
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index]!, parent });
  };
  push(root);
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (!("tagName" in next.node)) {
      const written = histosInText(html, next.node, next.parent);
      if (written) return written;
      continue;
    }
    const element = next.node as Element;
    const attribute = element.attrs.find((item) => item.name === "data-histos");
    if (attribute) return { tag: element.tagName, value: attribute.value, line: element.sourceCodeLocation?.startLine };
    push(element);
  }
  return undefined;
}

/** Stops the import for a data-histos element that `container` would lose. */
function failLost(lost: LostHistos, container: Element): never {
  const where = lost.text ? `per il browser è testo dentro <${lost.text.tagName}> (riga ${lost.text.sourceCodeLocation?.startLine ?? "?"})` : `è dentro <${container.tagName}> (riga ${container.sourceCodeLocation?.startLine ?? "?"})`;
  fail(`<${shown(lost.tag)} data-histos="${shown(lost.value)}"> (riga ${lost.line ?? "?"}) ${where}: gli elementi con data-histos vanno direttamente in <head> o in <body>, altrimenti non entrano nel progetto.`);
}

/**
 * Stops the import for a part of the prototype left open (review 7): a <style data-histos> or a JSON <script
 * data-histos> without its end tag takes as its text everything up to the next end tag of its kind, a later sheet's or
 * script's, and the pages and parts in between would be stored as its CSS or JSON, without a word. Its text is read as
 * histosTagIn reads a closed <script> or <style>, by the CSS or the JSON it should hold: CSS never holds a tag outside its
 * comments, strings and url(), JSON never outside its strings or first on a line, so a data-histos start tag, a start tag
 * of its own element, a `</template>`, a `</head>` or a `<body>` standing there, a text that opens with a tag, or (JSON
 * only: in CSS a `<!--` without its `-->` is the token CSS ignores, read on) one that ends inside an HTML comment
 * opened there shows it. A url( that holds `data-histos` (to its `)` or the text's end), and a comment (`/* *\/`,
 * `<!-- -->`) that holds `data-histos` and another of its kind after it, are read on as CSS (review 9): a sheet left
 * open inside one would end it at a later sheet's `)`, `*\/` or `-->`, or hide all to the end of its text, past the pages
 * between. Any other comment, string and url() hides what it holds, as in a closed sheet. The message names the first data-histos tag standing there
 * (else the first sign) with its line, and the part with its own.
 */
function failOpenPart(html: string, element: Element): void {
  const location = element.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) return;
  const source = html.slice(location.startTag.endOffset, location.endTag.startOffset);
  const json = element.tagName === "script";
  const found = histosTagIn(source, { name: json ? "script" : "style", src: false, part: json ? "json" : "css" });
  if (!found) return;
  let line = location.startTag.endLine;
  for (let index = source.indexOf("\n"); index !== -1 && index < found.offset; index = source.indexOf("\n", index + 1)) line++;
  const tag = found.value !== undefined ? `<${shown(found.tag)} data-histos="${shown(found.value)}">` : found.tag === "!--" ? "<!--" : `<${shown(found.tag)}>`;
  const role = element.attrs.find((attribute) => attribute.name === "data-histos")?.value ?? "";
  fail(`${tag} (riga ${line}) per il browser è testo dentro <${element.tagName} data-histos="${shown(role)}"> (riga ${location.startLine}), che resta aperto fino al </${element.tagName}> di riga ${location.endTag.startLine}: chiudilo dove finisce il suo ${json ? "JSON" : "CSS"}, altrimenti quel che sta in mezzo non entra nel progetto.`);
}

// ---------------------------------------------------------------- reading the file within bounds

/**
 * What reading the file may cost, before any check runs (finding 7). parse5 builds the whole document, and some of its
 * steps grow faster than the file: a tag's attributes are each compared with those before (a tag with 100,000 of them
 * took 23 s), an end tag looks through every open element and a start tag may (20,000 unclosed elements and as many
 * stray end tags: 13 s), formatting elements left open are copied again at each new paragraph (17 KB of them built
 * 169 MB of elements) and searched at each formatting tag, a second <html> or <body> tag merges its attributes into
 * all those before, and the whole tree costs some 700 bytes an element (790 pages of 10,000 `<x/>` filled the 4 GB
 * of the heap before any check). So the parse is counted as it goes and stops past these bounds, each far above what a
 * real prototype needs (a 2,000-page site of 14 MB: 430,000 elements, 7.8 million units of work, 18,000 kept):
 * - PARSE_NODES_MAX elements and comments created, clones included (2 to 3 s of parsing; 32 MB of markup averaging 8
 *   characters an element, a table of one-digit cells, is within it);
 * - PARSE_WORK_MAX units of the steps above (about 1 to 3 s however they are spent);
 * - PARSE_KEPT_MAX units of tree kept outside the documents (about 150 MB): a document's content is read from the file
 *   as written, never from the tree, so its tree is dropped as it is built and let go whole when its template closes;
 *   what stays is the rest of the file, which the import only reports;
 * - PARSE_TABLE_TEXT_MAX runs of text, or of spaces, written straight in a table, which parse5 holds (some 150 bytes
 *   each) until the next tag to move them before the table: 16 MB of `x ` in a <table> took 2.3 GB. A real table has
 *   a few, the spaces between its tags.
 * Text, attribute values, names and comments are built a character at a time, which V8 holds as 32 bytes a character
 * until the string is read (a run of 31 MB of text or of one attribute value took 1 GB): see flatten.
 */
const PARSE_NODES_MAX = 4_000_000;
const PARSE_WORK_MAX = 200_000_000;
const PARSE_KEPT_MAX = 1_000_000;
const PARSE_TABLE_TEXT_MAX = 100_000;

/** Every so many characters read, the strings parse5 is still building are made flat. */
const FLAT_EVERY = 1 << 20;
/** Where flatten keeps what it reads, so that the read is never optimized away. */
const flatReads = { last: 0 };
/**
 * Makes a string V8 holds as pairs flat. V8 keeps `text += ch` as a pair of its two parts (32 bytes), and parse5 builds
 * its strings that way, a character at a time; reading a character of the string has V8 copy it flat, in place, and
 * let the pairs go. A string shorter than 13 characters is never a pair.
 */
function flatten(text: string | null | undefined): void {
  if (text && text.length > 12) flatReads.last = text.charCodeAt(0);
}

/** The strings of a token: a tag's name and attributes, a comment's text, a doctype's name and identifiers. */
function flattenToken(token: object | null): void {
  if (!token) return;
  const fields = token as { tagName?: string; data?: string; name?: string | null; publicId?: string | null; systemId?: string | null; attrs?: Array<{ name: string; value: string }> };
  flatten(fields.tagName);
  flatten(fields.data);
  flatten(fields.name);
  flatten(fields.publicId);
  flatten(fields.systemId);
  if (fields.attrs) {
    for (const attribute of fields.attrs) {
      flatten(attribute.name);
      flatten(attribute.value);
    }
  }
}

class ReadingBudget {
  nodes = 0;
  work = 0;
  kept = 0;
  /** The line of the last tag read, for the message. */
  line = 1;
  node(): void {
    if (++this.nodes > PARSE_NODES_MAX) fail(`Il prototipo ha più di ${String(PARSE_NODES_MAX).replace(/\B(?=(\d{3})+$)/gu, ".")} elementi e commenti HTML (oltre la riga ${this.line}): troppi da leggere. Alleggeriscilo.`);
  }
  spend(units: number): void {
    this.work += units;
    if (this.work > PARSE_WORK_MAX) fail(`Il markup del prototipo costa troppo da leggere (intorno alla riga ${this.line}): migliaia di elementi aperti e mai chiusi, di tag fuori posto o di attributi in un tag. Chiudi ogni elemento dove si apre e togli i tag in più.`);
  }
  keep(units: number): void {
    this.kept += units;
    if (this.kept > PARSE_KEPT_MAX) fail(`Fuori dai template con data-histos il prototipo ha troppo markup (oltre la riga ${this.line}): quel contenuto non entra nel progetto, toglilo.`);
  }
}

/**
 * parse5's tokenizer, charged for the attributes it compares: each new one with every one the tag already has. The
 * strings it builds a character at a time are made flat once complete, as each token leaves it, and every FLAT_EVERY
 * characters while still growing: a copy of each, a few MB of pairs at most.
 */
class BoundedTokenizer extends Tokenizer {
  private readonly budget: ReadingBudget;
  /** Characters read since the strings in the making were last made flat. */
  private sinceFlat = 0;
  constructor(options: TokenizerOptions, handler: TokenHandler, budget: ReadingBudget) {
    super(options, handler);
    this.budget = budget;
  }
  protected override _leaveAttrName(): void {
    const token = this.currentToken as Token.TagToken;
    if (token.location) this.budget.line = token.location.startLine;
    this.budget.spend(token.attrs.length);
    super._leaveAttrName();
  }
  protected override _callState(cp: number): void {
    super._callState(cp);
    if (++this.sinceFlat < FLAT_EVERY) return;
    this.sinceFlat = 0;
    flatten(this.currentCharacterToken?.chars);
    flatten(this.currentAttr.name);
    flatten(this.currentAttr.value);
    flattenToken(this.currentToken);
  }
  protected override _emitCurrentCharacterToken(nextLocation: Token.Location | null): void {
    flatten(this.currentCharacterToken?.chars);
    super._emitCurrentCharacterToken(nextLocation);
  }
  protected override emitCurrentTagToken(): void {
    flattenToken(this.currentToken);
    super.emitCurrentTagToken();
  }
  protected override emitCurrentComment(token: Token.CommentToken): void {
    flattenToken(token);
    super.emitCurrentComment(token);
  }
  protected override emitCurrentDoctype(token: Token.DoctypeToken): void {
    flattenToken(token);
    super.emitCurrentDoctype(token);
  }
}

/**
 * parse5's parser, charged for what a tag may look through: the open elements (scope checks, implied end tags, the
 * adoption agency) and the active formatting elements (looked for, copied, kept to three alike). These are parse5 8
 * internals (pinned in package.json); prototype-read-bounds.test.ts fails if they change.
 */
class BoundedParser extends Parser<DefaultTreeAdapterMap> {
  private readonly budget: ReadingBudget;
  constructor(options: ParserOptions<DefaultTreeAdapterMap>, budget: ReadingBudget) {
    super(options);
    this.budget = budget;
    this.tokenizer = new BoundedTokenizer(this.options, this, budget);
  }
  private charge(token: Token.TagToken): void {
    if (token.location) this.budget.line = token.location.startLine;
    this.budget.spend(2 + this.openElements.stackTop + this.activeFormattingElements.entries.length);
  }
  override onStartTag(token: Token.TagToken): void {
    this.charge(token);
    super.onStartTag(token);
  }
  override onEndTag(token: Token.TagToken): void {
    this.charge(token);
    super.onEndTag(token);
  }
  override onItemPush(node: DefaultTreeAdapterMap["parentNode"], tid: number, isTop: boolean): void {
    this.budget.spend(1 + this.activeFormattingElements.entries.length);
    super.onItemPush(node, tid, isTop);
  }
  override onCharacter(token: Token.CharacterToken): void {
    super.onCharacter(token);
    this.tableText();
  }
  override onWhitespaceCharacter(token: Token.CharacterToken): void {
    super.onWhitespaceCharacter(token);
    this.tableText();
  }
  override onNullCharacter(token: Token.CharacterToken): void {
    super.onNullCharacter(token);
    this.tableText();
  }
  /** Text written straight in a table waits in pendingCharacterTokens, a token for each run, up to the next tag. */
  private tableText(): void {
    if (this.pendingCharacterTokens.length > PARSE_TABLE_TEXT_MAX) fail(`Il prototipo ha troppo testo scritto direttamente in una tabella (intorno alla riga ${this.budget.line}), fuori dalle celle: è troppo da leggere. Metti il testo nelle celle <td> o fuori dalla tabella.`);
  }
  override onItemPop(node: DefaultTreeAdapterMap["parentNode"], isTop: boolean): void {
    super.onItemPop(node, isTop);
    // parse5 leaves a popped element in its stack's array, past the top, until a deeper one takes the place: an
    // element of a document would stay reachable after its template closed.
    const items = this.openElements.items;
    if (items[this.openElements.stackTop + 1] === node) items[this.openElements.stackTop + 1] = undefined as unknown as typeof node;
  }
}

/** Marks a node of dropped content: a property of the node itself (a WeakSet of millions of live keys took 45 s to fill). */
const DROPPED = Symbol("dropped");
type Droppable = { [DROPPED]?: true };
function isDropped(node: object): boolean {
  return (node as Droppable)[DROPPED] === true;
}
function markDropped(node: object): void {
  (node as Droppable)[DROPPED] = true;
}

/**
 * The tree parse5 builds, without the content of a `<template data-histos>`: that content is read from the file as
 * written (innerSource) and parsed by the DSL, so each node of it is let go as soon as the parser no longer needs it.
 * The parser reads back only the last child of the node it inserts into (to merge text and to give it its place) and
 * the node it inserts before: in dropped content a node keeps just those, and a comment nothing at all. Once the parser
 * closes a dropped element, which it never inserts into again, the element lets go of its children, and a template
 * with data-histos of its whole content: what stays of a document while it is read is the elements still open (each
 * keeps the next), and nothing once it is closed. The rest of the tree is kept, and counted. Where the parser looks a
 * node up among its siblings (inserting before one, detaching one) or merges attributes (a second <html> or <body>
 * tag: 40,000 of them took 58 s), the work is charged too.
 * The adoption agency builds a copy of a formatting element and moves nodes into it before the copy has a place in the
 * tree: nodes from dropped content make it dropped (the algorithm moves nodes only within one tree, and a template's
 * content is one of its own), so markup inside a document is never charged to what is kept outside. Every node made
 * into dropped content is marked, the text nodes too: the agency moves those as well (review 5).
 */
function boundedTreeAdapter(budget: ReadingBudget): TreeAdapter<DefaultTreeAdapterMap> {
  type ParentNode = DefaultTreeAdapterMap["parentNode"];
  type ChildNode = DefaultTreeAdapterMap["childNode"];
  const drop = (node: ChildNode) => {
    markDropped(node);
    if (node.nodeName === "template" && "content" in node) markDropped(node.content);
  };
  /**
   * Whether `node` goes into dropped content: `parent` is part of it, or is an element without a place yet (the
   * adoption agency's copy) and `node` comes from it, which makes the copy part of it too.
   */
  const intoDropped = (parent: ParentNode, node: ChildNode) => {
    if (isDropped(parent)) return true;
    if (!("tagName" in parent) || parent.parentNode !== null || !isDropped(node)) return false;
    markDropped(parent);
    return true;
  };
  /** An element weighs about four attributes, a comment or a text one. */
  const weight = (node: ChildNode) => ("attrs" in node ? 4 + node.attrs.length : 1);
  const prune = (parent: ParentNode, reference?: ChildNode) => {
    parent.childNodes.length = 0;
    if (reference) parent.childNodes.push(reference);
  };
  /** The kept text node written last, and how many runs of text were added to it since it was last made flat. */
  let written: ChildNode | undefined;
  let writes = 0;
  /**
   * parse5 adds each run of text to the text node before it (`value += text`, a pair each, see flatten): a kept node is
   * made flat once its pairs since the last time reach a sixteenth of its length, so each copy is paid by the runs that
   * called for it, and the pairs never hold more than a sixteenth of the text.
   */
  const wrote = (node: ChildNode | undefined) => {
    if (node?.nodeName !== "#text") return;
    if (node !== written) {
      written = node;
      writes = 0;
    }
    const text = node as DefaultTreeAdapterMap["textNode"];
    if (++writes >= 2 && writes >= text.value.length >>> 4) {
      flatten(text.value);
      writes = 0;
    }
  };
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      budget.node();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    createCommentNode(data) {
      budget.node();
      return defaultTreeAdapter.createCommentNode(data);
    },
    setTemplateContent(template, content) {
      defaultTreeAdapter.setTemplateContent(template, content);
      if (isDropped(template) || template.attrs.some((attribute) => attribute.name === "data-histos")) markDropped(content);
    },
    appendChild(parent, node) {
      if (intoDropped(parent, node)) {
        drop(node);
        if (node.nodeName === "#comment") return;
        prune(parent);
      } else budget.keep(weight(node));
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      if (intoDropped(parent, node)) {
        drop(node);
        if (node.nodeName === "#comment") return;
        prune(parent, reference);
      } else {
        budget.keep(weight(node));
        budget.spend(parent.childNodes.length);
      }
      defaultTreeAdapter.insertBefore(parent, node, reference);
    },
    insertText(parent, text) {
      if (isDropped(parent)) {
        prune(parent);
        defaultTreeAdapter.insertText(parent, text);
        // The text node it makes is dropped content too: the adoption agency may move it into its copy (review 5).
        markDropped(parent.childNodes[0]!);
        return;
      }
      if (parent.childNodes.at(-1)?.nodeName !== "#text") budget.keep(1);
      defaultTreeAdapter.insertText(parent, text);
      wrote(parent.childNodes.at(-1));
    },
    insertTextBefore(parent, text, reference) {
      if (isDropped(parent)) {
        prune(parent, reference);
        defaultTreeAdapter.insertTextBefore(parent, text, reference);
        markDropped(parent.childNodes[0]!);
        return;
      }
      budget.keep(1);
      budget.spend(2 * parent.childNodes.length);
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
      wrote(parent.childNodes[parent.childNodes.indexOf(reference) - 1]);
    },
    adoptAttributes(recipient, attrs) {
      // parse5 builds a set of the names the element has, each time: some ten units a name.
      budget.spend(10 * recipient.attrs.length + attrs.length);
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    detachNode(node) {
      // A pruned parent may no longer hold the node: never take another child in its place.
      const parent = node.parentNode;
      if (parent && isDropped(parent)) {
        const index = parent.childNodes.indexOf(node);
        if (index >= 0) parent.childNodes.splice(index, 1);
        node.parentNode = null;
        return;
      }
      budget.spend(parent?.childNodes.length ?? 0);
      defaultTreeAdapter.detachNode(node);
    },
    onItemPop(item) {
      const content = item.nodeName === "template" ? (item as DefaultTreeAdapterMap["template"]).content : undefined;
      if (content && isDropped(content)) content.childNodes.length = 0;
      if (isDropped(item)) item.childNodes.length = 0;
    },
  };
}

/**
 * The prototype's HTML as a browser reads it (scripting on), within the bounds above. Exported for the tests, which
 * check what of the documents' trees stays.
 */
export function readPrototypeHtml(html: string): DefaultTreeAdapterMap["document"] {
  const budget = new ReadingBudget();
  const parser = new BoundedParser({ sourceCodeLocationInfo: true, treeAdapter: boundedTreeAdapter(budget) }, budget);
  parser.tokenizer.write(html, true);
  return parser.document;
}

/** Reads and validates the structure of a prototype file. Pure: no store, no network. */
export function parsePrototype(input: string): ParsedPrototype {
  if (Buffer.byteLength(input, "utf8") > PROTOTYPE_MAX_BYTES) fail("Il prototipo supera i 32 MB.");
  // Line ends as HTML reads them: CR LF and a lone CR are one LF. The parser counts lines that way, and the documents'
  // offsets (template lines, lineFinder, textLineOf, the DSL's own positions) count "\n": with CR alone every problem
  // of a document would land on its first line. The content is then what a browser reads from the file.
  const html = input.includes("\r") ? input.replace(/\r\n?/gu, "\n") : input;
  const document = readPrototypeHtml(html);
  const ignored: ParsedPrototype["ignored"] = [];
  const parts = { manifest: [] as string[], assets: [] as string[], content: [] as string[], scripts: [] as string[] };
  const partLines = { manifest: 0, assets: 0, content: 0, scripts: 0 };
  /** Where each JSON part's text starts, just past its `<script …>` tag, as for a template's content. */
  const partStarts: Partial<Record<keyof typeof parts, Place>> = {};
  const globals: ParsedPrototype["globals"] = [];
  const selectors: string[] = [];
  /** The line where each sheet's text starts (global sheets in order), for the messages of cssParseProblem. */
  const sheetLines = { globals: [] as number[], selectors: 0 };
  const documents: PrototypeDocument[] = [];
  let marked = false;

  const visit = (node: Node, insideBody: boolean): void => {
    if (!("childNodes" in node)) return;
    for (const child of node.childNodes) {
      if (child.nodeName === "#text") {
        // A tag the parser dropped where it stands (a second <head> in the body) is part of the text around it.
        const lost = "tagName" in node ? histosInText(html, child, node as Element) : undefined;
        if (lost) failLost(lost, node as Element);
        if (insideBody && "value" in child && child.value.trim()) ignored.push({ what: "testo", why: "fuori dai template: non entra nel progetto", ...textLineOf(html, child) });
        continue;
      }
      if (!("tagName" in child)) continue;
      const element = child as Element;
      const attributes = attributesOf(element);
      // The attribute counts as written, also empty: `data-histos=""` is an unknown section, never no section (§2).
      const hasRole = Object.hasOwn(attributes, "data-histos");
      const role = attributes["data-histos"] ?? "";
      if (element.tagName === "html" && attributes["data-histos-prototype"] === "1") marked = true;
      if (element.tagName === "script") {
        if (attributes.type === "application/json" && (role === "manifest" || role === "assets" || role === "content" || role === "scripts")) {
          failOpenPart(html, element);
          parts[role].push(innerSource(html, element));
          partLines[role] = element.sourceCodeLocation?.startLine ?? 0;
          partStarts[role] = { line: element.sourceCodeLocation?.startTag?.endLine ?? partLines[role], column: element.sourceCodeLocation?.startTag?.endCol ?? 1 };
        } else if (hasRole) {
          fail(`<script data-histos="${shown(role)}">: sezione sconosciuta o senza type="application/json". I <script> con data-histos sono solo manifest, assets, content e scripts, sempre con type="application/json"; pagine e articoli sono <template data-histos="page"> e <template data-histos="post"> nel <body>.`);
        } else {
          // Its text is the browser's too: a page after a <script> left open would vanish into it.
          const lost = nestedHistos(html, element);
          if (lost) failLost(lost, element);
          ignored.push({ what: "script", why: "il JavaScript dell'anteprima non entra nel progetto", ...lineOf(element) });
        }
        continue;
      }
      if (element.tagName === "style") {
        const sheetLine = element.sourceCodeLocation?.startTag?.endLine ?? 0;
        if (role === "global" || role === "selectors") failOpenPart(html, element);
        if (role === "global") {
          globals.push({ name: text(attributes["data-name"] ?? "Foglio globale", "Nome del foglio globale", 120), css: innerSource(html, element) });
          sheetLines.globals.push(sheetLine);
        } else if (role === "selectors") {
          selectors.push(innerSource(html, element));
          sheetLines.selectors = sheetLine;
        }
        else if (hasRole) fail(`<style data-histos="${shown(role)}">: sezione sconosciuta.`);
        else {
          const lost = nestedHistos(html, element);
          if (lost) failLost(lost, element);
          ignored.push({ what: "style", why: "senza data-histos: non entra nel progetto", ...lineOf(element) });
        }
        continue;
      }
      if (element.tagName === "link" && !hasRole) {
        ignored.push({ what: `link ${attributes.rel ?? ""} ${attributes.href ?? ""}`.trim(), why: "le risorse esterne non entrano nel progetto", ...lineOf(element) });
        continue;
      }
      if (element.tagName === "template" && hasRole) {
        if (!["component", "part", "template", "page", "post"].includes(role)) fail(`<template data-histos="${shown(role)}">: tipo di documento sconosciuto.`);
        const label = attributes["data-ref"] ?? attributes["data-slug"] ?? "?";
        const line = element.sourceCodeLocation?.startTag?.endLine ?? element.sourceCodeLocation?.startLine ?? 0;
        // parse5's end column is the one right after the tag's `>`, counted as the DSL parser counts (UTF-16 units).
        const column = element.sourceCodeLocation?.startTag?.endCol ?? 1;
        const places = Object.fromEntries(Object.entries(element.sourceCodeLocation?.attrs ?? {}).map(([name, place]) => [name, { line: place.startLine, column: place.startCol }]));
        documents.push({ kind: role as PrototypeDocument["kind"], attributes, source: innerSource(html, element), label: `${role} ${label} (riga ${line})`, line, column, places });
        continue;
      }
      if (hasRole) fail(`<${element.tagName} data-histos="${shown(role)}">: data-histos vale solo su script, style e template.`);
      // No other element of the body is entered, nor a template without data-histos anywhere: each stays out of the
      // project whole, so a data-histos element inside one (a page wrapped in <main>, a sheet in a <div>, a plain
      // template around a page, whose content the parser keeps apart) stops the import instead of vanishing with it (§2).
      if (insideBody || element.tagName === "template") {
        const nested = nestedHistos(html, element);
        if (nested) failLost(nested, element);
        ignored.push({ what: `<${element.tagName}>`, why: element.tagName === "template" ? "senza data-histos: non entra nel progetto" : "fuori dai template: non entra nel progetto", ...lineOf(element) });
        continue;
      }
      visit(element, insideBody || element.tagName === "body");
    }
  };
  visit(document, false);

  if (!marked) fail('Il file non è un prototipo Histeon: manca data-histos-prototype="1" su <html>.');
  if (parts.manifest.length !== 1) fail("Il prototipo deve avere esattamente un manifest.");
  if (globals.length > TRANSFER_GLOBALS_MAX) fail(`Il prototipo ha ${globals.length} fogli globali: al massimo ${TRANSFER_GLOBALS_MAX}. Uniscili, e le regole dei blocchi vanno negli stili per selettore.`);
  if (parts.assets.length > 1 || parts.content.length > 1 || parts.scripts.length > 1 || selectors.length > 1) fail("Media, contenuti, script e stili per selettore possono comparire una sola volta.");
  if (documents.length > MAX_DOCUMENTS) fail(`Il prototipo supera ${MAX_DOCUMENTS} documenti.`);
  // The inline source map that ends a sheet leaves it before anything measures, parses or keeps it (review 9): the
  // report says where it was. One anywhere else still stops the sheet, in cssParseProblem.
  const warnings: string[] = [];
  const withoutSourceMaps = (css: string, where: string, line: number): string => {
    const stripped = withoutTrailingSourceMap(css);
    if (stripped.removed === -1) return css;
    let at = line;
    for (let feed = css.indexOf("\n"); feed !== -1 && feed < stripped.removed; feed = css.indexOf("\n", feed + 1)) at++;
    warnings.push(`${where}, riga ${at}: tolto il source map incorporato (/*# sourceMappingURL=data:… */), che al sito pubblicato non serve.`);
    return stripped.css;
  };
  for (const [index, sheet] of globals.entries()) sheet.css = withoutSourceMaps(sheet.css, `Il foglio globale «${sheet.name}»`, sheetLines.globals[index]!);
  if (selectors[0] !== undefined) selectors[0] = withoutSourceMaps(selectors[0], "Gli stili per selettore", sheetLines.selectors);

  const rawManifest = plainObject(jsonPart(parts.manifest[0]!, `Manifest (riga ${partLines.manifest})`), "Manifest");
  if (rawManifest.format !== "histos-prototype" || rawManifest.version !== 1) fail("Manifest: format deve essere histos-prototype e version 1.");
  const allowedManifest = new Set(["format", "version", "id", "name", "locale", "timeZone", "framework", "acss", "design", "siteTokens", "shop"]);
  for (const key of Object.keys(rawManifest)) if (!allowedManifest.has(key)) fail(`Manifest: campo sconosciuto ${key}.`);
  if (typeof rawManifest.id !== "string" || !UUID.test(rawManifest.id)) fail("Manifest: id deve essere un UUID minuscolo.");
  const framework = rawManifest.framework ?? "histos-css";
  if (framework !== "histos-css" && framework !== "none" && framework !== "acss") fail("Manifest: framework può essere histos-css, acss o none.");
  if (rawManifest.acss !== undefined && (framework !== "acss" || (rawManifest.acss !== "convert" && rawManifest.acss !== "keep"))) fail('Manifest: acss vale solo con framework "acss" e può essere "convert" o "keep".');
  const manifest: PrototypeManifest = {
    id: rawManifest.id,
    name: text(rawManifest.name, "Manifest: name", 120).trim(),
    framework,
    ...(framework === "acss" ? { acss: rawManifest.acss === "keep" ? "keep" as const : "convert" as const } : {}),
    ...(rawManifest.locale !== undefined ? { locale: text(rawManifest.locale, "Manifest: locale", 64) } : {}),
    ...(rawManifest.timeZone !== undefined ? { timeZone: text(rawManifest.timeZone, "Manifest: timeZone", 64) } : {}),
    ...(rawManifest.design !== undefined ? { design: plainObject(rawManifest.design, "Manifest: design") } : {}),
    ...(rawManifest.siteTokens !== undefined ? { siteTokens: plainObject(rawManifest.siteTokens, "Manifest: siteTokens") } : {}),
    ...(rawManifest.shop !== undefined ? { shop: rawManifest.shop } : {}),
  };

  // The build parses each sheet whole (C1/C2 names, the ACSS conversion, the styles) before it measures what it keeps,
  // and a parse holds some hundred bytes per byte of CSS: a sheet of 30 MB would end the process, past any catch. So
  // the limits are measured here first, on the sheets as written, and only what the exact measure would refuse too is
  // refused: a global sheet is kept as written, and the styles document (STYLES_DOCUMENT_MAX) holds at least every
  // global sheet and the selector styles' weight. Media references only lengthen a sheet; the ACSS conversion shortens
  // a reference by less than half (a test keeps it so), so for a prototype to convert twice the limit is the margin;
  // its selector styles are measured exactly once converted, before they are parsed (buildPrototypeProfile).
  const margin = manifest.acss === "convert" ? 2 : 1;
  for (const sheet of globals) if (sheet.css.length > margin * TRANSFER_CSS_MAX && codePoints(sheet.css) > margin * TRANSFER_CSS_MAX) fail(`Il foglio globale «${sheet.name}» supera 1 MB di CSS: dividilo in più fogli.`);
  const stylesWeight = globals.reduce((sum, sheet) => sum + sheet.css.length, selectors[0] === undefined ? 0 : selectorsWeight(selectors[0]));
  if (stylesWeight > margin * STYLES_DOCUMENT_MAX) fail(STYLES_TOO_LARGE);
  // Within these sizes, what each parse would hold (the build parses one sheet at a time). The ACSS conversion renames a
  // variable to another name, which postcss reads as the same tokens: the sheets are measured once, as written. A global
  // sheet is kept as written and parsed only for its names, so one past the bounds is not parsed at all: like a sheet
  // postcss cannot read, its classes all count as defined, and the report says why (review 5). The selector styles
  // cannot do without their parse.
  for (const [index, sheet] of globals.entries()) {
    const problem = cssParseProblem(sheet.css, cssParseCost(sheet.css), `Il foglio globale «${sheet.name}»`, sheetLines.globals[index]!);
    if (problem?.stop) fail(problem.message);
    if (problem) sheet.unparsed = problem;
  }
  if (selectors[0] !== undefined) checkSelectorsParseCost(selectors[0], sheetLines.selectors);

  const { assets, assetPlaces } = parseAssets(parts.assets[0], partLines.assets, partStarts.assets);

  const content = parts.content.length ? plainObject(jsonPart(parts.content[0]!, `Contenuti (riga ${partLines.content})`), "Contenuti") : {};
  // The sections a small model invents most (posts, pages, menus) get what to write instead.
  for (const key of Object.keys(content)) if (!["types", "taxonomies", "terms", "records", "queries"].includes(key)) fail(`Contenuti: sezione sconosciuta ${shown(key)}. Le sezioni di content sono solo types, taxonomies, terms, records e queries.${/^(posts?|pages?|articles?|articoli|pagine)$/iu.test(key) ? " Pagine e articoli non stanno in content: scrivili come <template data-histos=\"page\"> e <template data-histos=\"post\"> nel <body>." : /^menus?$/iu.test(key) ? " Un menu si scrive come <nav> nella parte della testata." : ""}`);
  if (!documents.some((item) => item.kind === "page" && item.attributes["data-slug"] === "home")) fail("Il prototipo deve avere una pagina con data-slug=\"home\".");
  const scripts = parts.scripts.length ? prototypeScripts(jsonPart(parts.scripts[0]!, `Script (riga ${partLines.scripts})`), documents) : undefined;
  const places = {
    ...(partStarts.manifest ? { manifest: partStarts.manifest, manifestKeys: keyPlaces(parts.manifest[0]!, partStarts.manifest) } : {}),
    ...(parts.content[0] !== undefined && partStarts.content ? { content: contentPlaces(parts.content[0], partStarts.content) } : {}),
    ...(assetPlaces.length ? { assets: assetPlaces } : {}),
  };
  return { manifest, assets, content, ...(scripts ? { scripts } : {}), globals, selectors: selectors[0] ?? null, documents, ignored, places, sheetLines, ...(warnings.length ? { warnings } : {}) };
}

/**
 * The scripts part (doc 18 §6.6): `{"pages": {"<slug>": "…"}, "components": {"<ref>": "…"}}`, each the JavaScript a
 * document carries, as text that nothing here runs: a page or a component the prototype does not have, text over
 * DOCUMENT_SCRIPT_MAX_BYTES or a NUL character stop the reading.
 */
function prototypeScripts(value: unknown, documents: readonly PrototypeDocument[]): { pages: Record<string, string>; components: Record<string, string> } {
  const part = plainObject(value, "Script");
  for (const key of Object.keys(part)) if (key !== "pages" && key !== "components") fail(`Script: sezione sconosciuta ${shown(key)}.`);
  const slugs = new Set(documents.filter((item) => item.kind === "page").map((item) => item.attributes["data-slug"] ?? ""));
  // WordPress keeps JavaScript for pages and components only: parts and templates have none.
  const refs = new Set(documents.filter((item) => item.kind === "component").map((item) => (item.attributes["data-ref"] ?? "").trim()));
  const read = (key: "pages" | "components", known: ReadonlySet<string>, what: string): Record<string, string> => {
    if (part[key] === undefined) return {};
    const entries = plainObject(part[key], `Script: ${key}`);
    const out: Record<string, string> = {};
    for (const [name, code] of Object.entries(entries)) {
      if (!known.has(name)) fail(`Script: ${what} ${shown(name)} non c'è nel prototipo.`);
      try {
        assertDocumentScript(code);
      } catch (error) {
        fail(`Script di ${what} ${shown(name)}: ${error instanceof Error ? error.message : "non valido"}`);
      }
      if (code.trim()) out[name] = code;
    }
    return out;
  };
  return { pages: read("pages", slugs, "pagina"), components: read("components", refs, "componente") };
}

/** The fields a media entry may have. */
const ASSET_FIELDS: ReadonlySet<string> = new Set(["name", "url", "data", "alt", "caption"]);

/**
 * The media part (`<script data-histos="assets">`), `json` as written, `line` its tag's line and `start` where its text
 * starts. Every problem of every entry is an issue of the document «assets» at the entry's line and column, all of them
 * at once (E4); only JSON that does not parse stops at once, as for the other parts. Returns the media and where each
 * entry starts, for the problems the build finds in them.
 */
function parseAssets(json: string | undefined, line: number, start: Place | undefined): { assets: PrototypeAssetDeclaration[]; assetPlaces: Place[] } {
  if (json === undefined) return { assets: [], assetPlaces: [] };
  const raw = jsonPart(json, `Media (riga ${line})`);
  const places = start ? listPlaces(json, start, MAX_ASSETS) : { items: [] };
  const issues: PrototypeIssue[] = [];
  const problem = (place: Place | undefined, message: string) => issues.push({ document: "assets", ...(place ? { line: place.line, column: place.column } : { line }), message });
  if (!Array.isArray(raw) || raw.length > MAX_ASSETS) {
    // Past the limit, the first entry too many: the entries are not read, there may be millions.
    problem(Array.isArray(raw) ? places.items[MAX_ASSETS] : places.root, `Media: serve un elenco di al massimo ${MAX_ASSETS} voci${Array.isArray(raw) ? `, ne ha ${raw.length}` : ""}.`);
    throw allIssuesError(issues);
  }
  const names = new Set<string>();
  const assets: PrototypeAssetDeclaration[] = [];
  for (const [index, value] of raw.entries()) {
    const place = places.items[index];
    if (!isObject(value)) {
      problem(place, `Media ${index + 1}: serve un oggetto.`);
      continue;
    }
    const unknown = Object.keys(value).filter((key) => !ASSET_FIELDS.has(key));
    if (unknown.length) problem(place, `Media ${index + 1}: ${unknown.length === 1 ? "campo sconosciuto" : "campi sconosciuti"} ${unknown.slice(0, 5).map(shown).join(", ")}${unknown.length > 5 ? ` e altri ${unknown.length - 5}` : ""}.`);
    const name = typeof value.name === "string" && ASSET_NAME.test(value.name) && !names.has(value.name) ? value.name : undefined;
    if (name === undefined) problem(place, `Media ${index + 1}: nome mancante, non valido o ripetuto.`);
    else names.add(name);
    // Every other problem names the media by its name, or by its number when the name is the problem.
    const label = `Media ${name ?? index + 1}`;
    const { url, data, alt, caption } = value;
    if ((url === undefined) === (data === undefined)) problem(place, `${label}: serve esattamente uno tra url e data.`);
    if (url !== undefined && (typeof url !== "string" || !/^https:\/\/[^\s]+$/u.test(url) || url.length > 2048)) problem(place, `${label}: url deve essere un indirizzo https://.`);
    if (data !== undefined && (typeof data !== "string" || !/^data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=\s]+$/iu.test(data))) problem(place, `${label}: data deve essere un data URI in base64.`);
    for (const [field, text, max] of [["alt", alt, 1000], ["caption", caption, 4000]] as const) {
      if (text !== undefined && (typeof text !== "string" || text.length > max)) problem(place, `${label}: ${field}: serve un testo di al massimo ${max} caratteri.`);
    }
    // With any problem nothing is returned: the list of them is.
    if (name !== undefined) assets.push({ name, ...(typeof url === "string" ? { url } : {}), ...(typeof data === "string" ? { data } : {}), alt: typeof alt === "string" ? alt : "", caption: typeof caption === "string" ? caption : "" });
  }
  if (issues.length) throw allIssuesError(issues);
  return { assets, assetPlaces: places.items };
}

/**
 * Where the root value of `json` starts, and the first `max + 1` entries of the list it is, read from the JSON as
 * written in one pass without recursion (it parsed, so it is valid): `start` is where its text starts in the file, past
 * the `<script …>` tag, so the first line's columns count from there.
 */
function listPlaces(json: string, start: Place, max: number): { root?: Place; items: Place[] } {
  const items: Place[] = [];
  let root: Place | undefined;
  let line = start.line;
  // Where the current line starts, as an offset of `json`: the first line starts at the tag's column.
  let lineStart = -(start.column - 1);
  let depth = 0;
  // At the list's own level, a value starts after `[` or `,`.
  let entry = true;
  for (let index = 0; index < json.length && items.length <= max; index++) {
    const code = json.charCodeAt(index);
    if (code === 10) {
      line++;
      lineStart = index + 1;
      continue;
    }
    if (code === 32 || code === 9 || code === 13) continue;
    const place = { line, column: index - lineStart + 1 };
    if (depth === 0) root ??= place;
    if (depth === 1 && entry && code !== 93) {
      items.push(place);
      entry = false;
    }
    if (code === 34) index = jsonStringEnd(json, index);
    else if (code === 91 || code === 123) depth++;
    else if (code === 93 || code === 125) depth--;
    else if (code === 44 && depth === 1) entry = true;
  }
  return { ...(root ? { root } : {}), items };
}

/** Past the string that starts at `start` (its opening quote): the offset of its closing quote. */
function jsonStringEnd(json: string, start: number): number {
  for (let index = start + 1; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (code === 92) index++;
    else if (code === 34) return index;
  }
  return json.length;
}

/**
 * Where each entry of the content's lists starts, read from the JSON as written, in one pass without recursion (the
 * JSON parsed, so it is valid, and may be nested as deep as the file allows). `start` is where the JSON's text starts
 * in the file: past the `<script …>` tag, so the first line's columns count from there. A list given twice keeps the
 * places of the last, as JSON.parse keeps its value.
 */
function contentPlaces(json: string, start: Place): ContentPlaces {
  const places: ContentPlaces = { types: [], taxonomies: [], terms: [], records: [], queries: [], fields: [] };
  const sections: ReadonlySet<string> = new Set(["types", "taxonomies", "terms", "records", "queries"]);
  // The open containers: an object with the key being read, a list with the index of its current item.
  const stack: Array<{ list: boolean; key: string; index: number }> = [];
  let line = start.line;
  // Where the current line starts, as an offset of `json`: the first line starts at the tag's column.
  let lineStart = -(start.column - 1);
  let expectKey = false;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (code === 10) {
      line++;
      lineStart = index + 1;
      continue;
    }
    if (code === 32 || code === 9 || code === 13 || code === 58) continue;
    const top = stack.at(-1);
    if (code === 44) {
      if (top?.list) top.index++;
      else expectKey = true;
      continue;
    }
    if (code === 125 || code === 93) {
      stack.pop();
      expectKey = false;
      continue;
    }
    if (code === 34 && top && !top.list && expectKey) {
      const end = jsonStringEnd(json, index);
      // A name longer than this cannot be one the import reads, even written with escapes.
      top.key = end - index <= 64 ? (JSON.parse(json.slice(index, end + 1)) as string) : "";
      if (stack.length === 1 && sections.has(top.key)) places[top.key as Exclude<keyof ContentPlaces, "fields">] = [];
      if (stack.length === 1 && top.key === "types") places.fields = [];
      index = end;
      expectKey = false;
      continue;
    }
    // A value starts here: an entry of a list of the content, or a field of a type, keeps its place.
    const place = { line, column: index - lineStart + 1 };
    const [root, list, entry, fields] = stack;
    if (stack.length === 2 && root && !root.list && list?.list && sections.has(root.key)) places[root.key as Exclude<keyof ContentPlaces, "fields">][list.index] = place;
    if (stack.length === 4 && root?.key === "types" && list?.list && entry && !entry.list && entry.key === "fields" && fields?.list) {
      const ofType = places.fields[list.index] ?? [];
      ofType[fields.index] = place;
      places.fields[list.index] = ofType;
    }
    if (code === 123) {
      stack.push({ list: false, key: "", index: 0 });
      expectKey = true;
    } else if (code === 91) stack.push({ list: true, key: "", index: 0 });
    else if (code === 34) index = jsonStringEnd(json, index);
    else {
      // A number, true, false or null: up to the next space, comma or bracket.
      for (let next = json.charCodeAt(index + 1); index + 1 < json.length && next !== 44 && next !== 93 && next !== 125 && next !== 32 && next !== 10 && next !== 9 && next !== 13; next = json.charCodeAt(index + 1)) index++;
    }
  }
  return places;
}

/**
 * Where each key of a JSON object starts (its opening quote), read as written: a problem of the manifest's language or
 * time zone is said at its key, not where the JSON starts. One pass, as contentPlaces; a key given twice keeps the
 * place of the last, as JSON.parse keeps its value.
 */
function keyPlaces(json: string, start: Place): Record<string, Place> {
  const places: Record<string, Place> = Object.create(null) as Record<string, Place>;
  let line = start.line;
  let lineStart = -(start.column - 1);
  let depth = 0;
  let expectKey = false;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (code === 10) {
      line++;
      lineStart = index + 1;
    } else if (code === 123 || code === 91) {
      depth++;
      expectKey = code === 123 && depth === 1;
    } else if (code === 125 || code === 93) depth--;
    else if (code === 44 && depth === 1) expectKey = true;
    else if (code === 34) {
      const end = jsonStringEnd(json, index);
      if (expectKey && depth === 1 && end - index <= 64) places[JSON.parse(json.slice(index, end + 1)) as string] = { line, column: index - lineStart + 1 };
      expectKey = false;
      index = end;
    }
  }
  return places;
}

/** Recognises an allowed media type from its first bytes; the declared type never decides. */

/** A transparent 1×1 PNG standing in for a remote image during a quick check. */
const PLACEHOLDER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const EXTENSIONS: Record<PrototypeMediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "font/woff": "woff", "font/woff2": "woff2" };

/**
 * A stable UUID (v5 layout) for one entity of the prototype: the same file always yields the same ids. Exported for the
 * browser's «pagina aggiunta» (V5.4), which names a page, a renamed media or a sheet as an import of the same project would.
 */
export function stableId(projectId: string, kind: string, key: string): string {
  const bytes = createHash("sha256").update(`histos-prototype\0${projectId}\0${kind}\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Block uids derived from the document, so an unchanged document keeps its uids at the next import. */
function uidFactory(seed: string): () => string {
  let counter = 0;
  return () => {
    counter++;
    return "p" + createHash("sha256").update(`${seed}\0${counter}`).digest("hex").slice(0, 11).replace(/[^a-z0-9]/gu, "0");
  };
}

interface BuildContext {
  projectId: string;
  assetIds: Map<string, string>;
  usedAssets: Set<string>;
  forms: PrototypeReport["forms"];
  /** The problems of the documents (E4), reported together once every document is read: those that can still be listed (compactIssues). */
  issues: PrototypeIssue[];
  /** The problems counted but not held: they make the count, never the list. */
  unlisted: number;
  /** The `data-ref` of the prototype's components, parts and templates, with their kind: a document may call (`<CardOpera>`) the first two. */
  reusable: ReadonlyMap<string, PrototypeDocument["kind"]>;
  /** The keys of the queries the content declares, what a `{#loop name()}` may read. */
  queryKeys: ReadonlySet<string>;
  /** Entity id → its name in the file ("page contatti"), so that no message shows an internal id (E4). */
  labels: Map<string, string>;
  /** Framework names met (C2) and, for an ACSS prototype to convert, what the conversion skips (C1). */
  names: FrameworkNames;
  convert?: { defined: ReadonlySet<string>; ruleClasses: ReadonlySet<string>; conversions: Conversions };
  /** The size of each image file (B6), as the browser shows it. */
  assetSizes: Map<string, { width: number; height: number }>;
  /** The type each media file has, read from its bytes: a font named where an image goes is refused with its place (E4). */
  assetTypes: Map<string, PrototypeMediaType>;
  /** Each <img src="asset:…"> without width or height, with the side it has, for the report: the markup stays as written. */
  unsizedImages: Array<{ asset: string; where: string; width?: string; height?: string }>;
  /** B6: the media of each `<img>` with both sides, no srcset of its own and no author's `<picture>` around it, and its uses. */
  variantImages: Map<string, number>;
  /** What the expressions of every document are read against (prototype-expressions.ts). */
  expressions: ExpressionDeclarations;
  /** The slots of each component and part read so far, by data-ref: a call to it is checked against them. */
  slots: Map<string, ReadonlySet<string>>;
  /** Calls to a component or part not read yet when their document was (the home, one declared later): checked at the end. */
  pendingCalls: PendingCall[];
  /** Accessibility and SEO (D4), read from the blocks each document was parsed into: no document is parsed twice. */
  quality?: PrototypeQuality;
  /** F1: the strict check's rules, only when asked (PrototypeImportOptions.strict), read the same way. */
  strict?: PrototypeStrict;
  /** Template data-ref → the first page, post or type's records it renders as a single page (singularTemplateUses). */
  singularTemplateUses?: ReadonlyMap<string, SingularTemplateUse>;
  /** The templates some type lists its records with (its archiveTemplate). */
  archiveTemplateRefs?: ReadonlySet<string>;
}

/** Who renders a template as a single page, and how to give it another one: for the message of a main() loop there. */
interface SingularTemplateUse {
  name: string;
  fix: string;
}

/**
 * The templates a page, a post or a type's records render with as a single page, as the build resolves them
 * (cms-api.ts, documentTemplateRef and renderCmsRecordDocument), each with the first one that does: a post's and a
 * page's data-template (the home's only without a front-page role, which takes its place), a type's singleTemplate. A
 * draft counts: it renders so once published, and in the app's preview already. {#loop main()} there has no archive to
 * list (structureIssues).
 */
function singularTemplateUses(prototype: ParsedPrototype): Map<string, SingularTemplateUse> {
  const uses = new Map<string, SingularTemplateUse>();
  const frontPage = prototype.documents.some((item) => item.kind === "template" && item.attributes["data-role"]?.trim() === "front-page");
  const add = (ref: unknown, use: SingularTemplateUse) => {
    if (typeof ref === "string" && ref && !uses.has(ref)) uses.set(ref, use);
  };
  for (const item of prototype.documents) {
    if (item.kind !== "page" && item.kind !== "post") continue;
    const slug = shown(item.attributes["data-slug"] ?? "");
    if (item.kind === "page" && slug === "home" && frontPage) continue;
    add(item.attributes["data-template"], item.kind === "page" ? { name: `la pagina ${slug}`, fix: "Dai a quella pagina un altro data-template" } : { name: `l'articolo ${slug}`, fix: "Dai a quell'articolo un altro data-template" });
  }
  const types = Array.isArray(prototype.content.types) ? prototype.content.types : [];
  for (const type of types) {
    if (!type || typeof type !== "object" || typeof (type as { key?: unknown }).key !== "string") continue;
    const key = shown((type as { key: string }).key);
    add((type as { singleTemplate?: unknown }).singleTemplate, { name: `ogni record del tipo ${key}`, fix: `Dai al tipo ${key} un altro singleTemplate` });
  }
  return uses;
}

/** A call whose slots wait for the component it calls, with how to find its place once it is known to be wrong. */
interface PendingCall {
  call: ComponentCall;
  document: string;
  /** The place of the call, or of the {#slot name} that fills `slot`, in the file. */
  place: (slot: string) => { line: number; column?: number };
}

/** The slots each pending call fills that its component does not render, as issues; the calls are then done. */
function pendingCallIssues(context: BuildContext): void {
  for (const pending of context.pendingCalls.splice(0)) {
    const slots = context.slots.get(pending.call.ref);
    // A component that did not parse has its own problem; its calls are not checked against nothing.
    if (!slots) continue;
    for (const problem of slotProblems(pending.call, slots)) context.issues.push({ document: pending.document, ...pending.place(problem.name), message: problem.message });
    compactIssues(context);
  }
}

/**
 * B6: what to write on each image that shifts the page while it loads. Without sides, the file's; with one numeric
 * side, the other in proportion (copying the file's pair would change the side the author chose).
 */
/** The import's part of B6: which images can have variants, read from their headers (inspectImageForVariants). */
function variantImagesReport(uses: Map<string, number>, media: Map<string, { bytes: Uint8Array }>, placeholders: Set<string>): { report: NonNullable<PrototypeReport["images"]>; candidates: PrototypeImageCandidate[] } | undefined {
  if (!uses.size) return undefined;
  const candidates: PrototypeImageCandidate[] = [];
  const skipped: Array<{ asset: string; why: string }> = [];
  for (const [asset, count] of uses) {
    const bytes = media.get(asset)?.bytes;
    if (!bytes || placeholders.has(asset)) {
      skipped.push({ asset, why: "si sa dopo lo scaricamento dei media remoti" });
      continue;
    }
    const source = inspectImageForVariants(bytes, (data) => {
      try { return inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 }); } catch { return null; }
    });
    if (typeof source === "string") skipped.push({ asset, why: source });
    else candidates.push({ asset, uses: count, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, source });
  }
  const usesCount = candidates.reduce((sum, item) => sum + item.uses, 0);
  const parts = [candidates.length
    ? `Immagini moderne: ${candidates.length === 1 ? "un file" : `${candidates.length} file`} (${usesCount === 1 ? "un <img>" : `${usesCount} <img>`}) ${candidates.length === 1 ? "avrà" : "avranno"} varianti JPEG XL, AVIF e WebP alla versione, dove il CSS della pagina lo permette; il risparmio si misura alla versione.`
    : "Immagini moderne: nessuna immagine avrà varianti alla build."];
  if (skipped.length) parts.push(`Restano come sono: ${skipped.slice(0, 5).map((item) => `${item.asset} (${item.why})`).join("; ")}${skipped.length > 5 ? ` e altre ${skipped.length - 5}` : ""}.`);
  return { report: { files: candidates.length, uses: usesCount, skipped: skipped.slice(0, 100), note: parts.join(" ") }, candidates };
}

/**
 * Doc 17 item 1: the rules of the prototype's sheets that would take the modern formats from every image of the pages,
 * said where they are. The build says the rules of one image (`.card > img`), page by page, with `--preview`.
 */
function pageWideImageWarnings(prototype: ParsedPrototype): string[] {
  const sheets = prototype.globals.filter((sheet) => !sheet.unparsed);
  const names = sheets.map((sheet) => `Il foglio globale «${sheet.name}»`);
  const starts = sheets.map((sheet) => prototype.sheetLines?.globals[prototype.globals.indexOf(sheet)] ?? 0);
  const css = sheets.map((sheet) => sheet.css);
  if (prototype.selectors) {
    css.push(prototype.selectors);
    names.push("Gli stili per selettore");
    starts.push(prototype.sheetLines?.selectors ?? 0);
  }
  // A sheet postcss cannot read is said elsewhere: nothing to add here.
  return pageWideImageRules(css).map((rule) => {
    const line = starts[rule.sheet]! > 0 ? starts[rule.sheet]! + rule.line - 1 : rule.line;
    return `${names[rule.sheet]}, riga ${line}: ${rule.rule.length > 120 ? `${rule.rule.slice(0, 120)}…` : rule.rule} toglie i formati moderni (JPEG XL, AVIF, WebP) a tutte le immagini delle pagine: ${rule.advice} (manuale, §3.1).`;
  });
}

function unsizedImagesWarning(images: BuildContext["unsizedImages"], sizes: Map<string, { width: number; height: number }>, placeholders: Set<string>): string {
  const advice = new Map<string, string>();
  for (const image of images) {
    const size = sizes.get(image.asset);
    const given = image.width ?? image.height;
    // Without a readable size the advice is the same for every use of the file.
    const key = placeholders.has(image.asset) || !size ? image.asset : `${image.asset}|${image.width ?? ""}|${image.height ?? ""}`;
    if (advice.has(key)) continue;
    let text: string;
    if (placeholders.has(image.asset)) text = `${image.asset}: misure note dopo lo scaricamento dei media remoti`;
    else if (!size) text = `${image.asset}: misure non leggibili dal file`;
    else if (given === undefined) text = `${image.asset} width="${size.width}" height="${size.height}"`;
    else if (!/^\d{1,5}$/u.test(given.trim()) || Number(given) < 1) text = `${image.asset}: scrivi anche ${image.width === undefined ? "width" : "height"} (il file è ${size.width}×${size.height})`;
    else if (image.width !== undefined) text = `${image.asset} height="${Math.max(1, Math.round((Number(given) * size.height) / size.width))}" (con il suo width="${given.trim()}")`;
    else text = `${image.asset} width="${Math.max(1, Math.round((Number(given) * size.width) / size.height))}" (con il suo height="${given.trim()}")`;
    advice.set(key, text);
  }
  const places = [...new Set(images.map((image) => image.where.replace(/ \(riga \d+\)$/u, "")))];
  const list = [...advice.values()];
  return `Immagini: ${images.length === 1 ? "una senza" : `${images.length} senza`} width o height (in ${places.slice(0, 4).join(", ")}${places.length > 4 ? ` e altre ${places.length - 4}` : ""}): la pagina si sposta mentre si caricano. Da scrivere: ${list.slice(0, 8).join("; ")}${list.length > 8 ? `; e altre ${list.length - 8}` : ""}.`;
}

function assetUrl(context: BuildContext, name: string, where: string): string {
  const id = context.assetIds.get(name);
  if (!id) fail(`${where}: il media asset:${name} non è dichiarato.`);
  context.usedAssets.add(name);
  return `/__cms-media/${context.projectId}/${id}`;
}

/**
 * The URL of a media file where the transfer takes only an image (`src`, `srcset`). A font there would be refused by
 * the transfer much later, by its internal id and without the document's line: here it is named as the file names it.
 */
function imageAssetUrl(context: BuildContext, name: string, where: string): string {
  const url = assetUrl(context, name, where);
  const type = context.assetTypes.get(name);
  if (type !== undefined && !IMAGE_TYPES.has(type)) fail(`${where}: asset:${name} è un carattere (${type}), non un'immagine: in src e srcset va un media immagine; un carattere si usa nel CSS, con url("asset:${name}") in @font-face.`);
  return url;
}

/**
 * `asset:<name>` becomes the project media URL only where a transfer keeps media portable: the `src` of an element,
 * each candidate of `srcset` on `img` and `source`, descriptors kept, and the `href` of an `a` (a link to the file,
 * doc 23 item 121); CSS and record fields have their own mapping. Anywhere else (other links, props, text) the address
 * would stay a Publish-only URL and break on WordPress, so it is refused with the portable alternative.
 */
function resolveAssetReferences(blocks: XbBlock[], context: BuildContext, where: string, insidePicture = false): void {
  for (const block of blocks) {
    if (block.name === "xb/element") {
      for (const [name, value] of Object.entries(block.attrs.attributes ?? {})) {
        if (typeof value !== "string" || !value.includes("asset:")) continue;
        if (name === "srcset" && (block.attrs.tag === "img" || block.attrs.tag === "source")) {
          const candidates = parseTransferSrcset(value);
          if (!candidates) fail(`${where}: srcset non valido (${value.slice(0, 80)}): al massimo 16 sorgenti "asset:nome 2x" separate da virgole.`);
          block.attrs.attributes![name] = formatTransferSrcset(candidates.map((candidate) => {
            const match = /^asset:([a-z0-9][a-z0-9-]{0,62})$/u.exec(candidate.url);
            if (!match) fail(`${where}: in srcset ogni sorgente è asset:<nome> (trovato ${candidate.url.slice(0, 80)}).`);
            return { ...candidate, url: imageAssetUrl(context, match[1]!, where) };
          }));
          continue;
        }
        const match = /^asset:([a-z0-9][a-z0-9-]{0,62})$/u.exec(value.trim());
        if (name === "src" && match && block.attrs.tag.toLowerCase() === "img") {
          // B6: an image without both sides makes the page shift while it loads. It is reported with the sides to
          // write, never changed: width and height alter the layout where the CSS sets only one side (a logo 40px high).
          const side = (wanted: string) => Object.entries(block.attrs.attributes ?? {}).find(([key]) => key.toLowerCase() === wanted)?.[1];
          // A side counts only when the browser reads it as one: digits, maybe a fraction or trailing text ("320px"),
          // never a percentage, a word or nothing. An expression is left to the author.
          // The number as Chromium reads it (as long as it goes, then never % or *); a bare attribute is no size.
          const reads = (value: unknown) => (typeof value === "string" ? /^[\t\n\f\r ]*(?=(\d+(?:\.\d*)?))\1(?![%*])/u.test(value) : value !== undefined && value !== true);
          const width = side("width");
          const height = side("height");
          if (!reads(width) || !reads(height)) context.unsizedImages.push({ asset: match[1] as string, where, ...(typeof width === "string" && reads(width) ? { width } : {}), ...(typeof height === "string" && reads(height) ? { height } : {}) });
          else if (!insidePicture && side("srcset") === undefined) context.variantImages.set(match[1] as string, (context.variantImages.get(match[1] as string) ?? 0) + 1);
        }
        const link = name === "href" && block.attrs.tag.toLowerCase() === "a";
        if ((name !== "src" && !link) || !match) fail(`${where}: asset: si usa solo come valore intero di src (<img src="asset:nome">) e di href su un link (<a href="asset:nome">), come sorgente di srcset su img e source, nel CSS con url() e nei campi asset dei record; in ${name} non resterebbe portabile su WordPress.`);
        block.attrs.attributes![name] = imageAssetUrl(context, match[1]!, where);
      }
    } else if (block.name === "xb/text" && /=[ \t\n\r\f]*["']asset:/u.test(block.attrs.content)) {
      fail(`${where}: asset: in un link dentro il testo non resterebbe portabile su WordPress; un link al file di un media è un elemento a sé, <a href="asset:nome">…</a>, e per un'immagine c'è <img src="asset:nome">.`);
    } else if (block.name === "xb/component") {
      for (const [name, value] of Object.entries(block.attrs.props ?? {})) {
        const text = typeof value === "string" ? value : value && typeof value === "object" && "tpl" in value ? value.tpl : "";
        if (text.includes("asset:")) fail(`${where}: la prop ${name} di <${block.attrs.ref}> usa asset:, che in una prop non resta portabile su WordPress. Passa l'immagine in uno slot ({#slot media}<img src="asset:nome" alt="…">{/slot}) o da un campo asset di un record.`);
      }
    }
    if ("children" in block) resolveAssetReferences(block.children as XbBlock[], context, where, insidePicture || (block.name === "xb/element" && block.attrs.tag.toLowerCase() === "picture"));
  }
}

const SVG_NAMESPACES: Readonly<Record<string, string>> = { xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink" };

/**
 * SVG written for a browser, made transferable without losing anything: the namespace declarations of `<svg>` (useless
 * in HTML) are dropped, and the camel-case attributes and, inside a drawing, the camel-case tags (`linearGradient`)
 * take their canonical case. Anything else stays as written, so the transfer refuses it with its reason.
 */
function normalizePrototypeMarkup(blocks: XbBlock[], insideSvg = false): void {
  for (const block of blocks) {
    if (block.name === "xb/element" && insideSvg) {
      const canonical = TRANSFER_SVG_TEXT_TAGS.find((candidate) => candidate !== block.attrs.tag && candidate.toLowerCase() === block.attrs.tag);
      if (canonical) block.attrs.tag = canonical;
    }
    if (block.name === "xb/element" && TRANSFER_SVG_TAGS.has(block.attrs.tag) && block.attrs.attributes) {
      const attributes = block.attrs.attributes;
      const normalized: typeof attributes = {};
      for (const [name, value] of Object.entries(attributes)) {
        if (block.attrs.tag === "svg" && SVG_NAMESPACES[name] !== undefined && value === SVG_NAMESPACES[name]) continue;
        const canonical = TRANSFER_SVG_CAMEL_CASE_ATTRIBUTES.find((candidate) => candidate.toLowerCase() === name);
        normalized[canonical && !Object.hasOwn(attributes, canonical) ? canonical : name] = value;
      }
      block.attrs.attributes = normalized;
      if (!Object.keys(normalized).length) delete block.attrs.attributes;
    }
    if ("children" in block) normalizePrototypeMarkup(block.children as XbBlock[], insideSvg || (block.name === "xb/element" && block.attrs.tag === "svg"));
  }
}

/** The forms of a document, for the report: an external endpoint is listed in the warnings too. */
function collectForms(blocks: XbBlock[], context: BuildContext, where: string): void {
  for (const block of blocks) {
    if (block.name === "xb/element" && block.attrs.tag === "form") {
      const action = block.attrs.attributes?.action;
      const method = block.attrs.attributes?.method;
      const normalizedMethod = typeof method === "string" ? method.toLowerCase() : "";
      // An invalid form is refused by the transfer with its reason; here only valid endpoints are listed.
      if (typeof action === "string" && (normalizedMethod === "get" || normalizedMethod === "post")) {
        // Classified as the browser reads it: `https&#58;//…` is external too.
        const decoded = decodeHTMLAttribute(action);
        let external = true;
        try {
          external = new URL(decoded, "https://histos-publish.invalid/").origin !== "https://histos-publish.invalid";
        } catch {
          external = true;
        }
        context.forms.push({ document: where, method: normalizedMethod, action: decoded, external });
      }
    }
    if ("children" in block) collectForms(block.children as XbBlock[], context, where);
  }
}

/** The DSL parser's own patterns (parser.ts), so that elementStarts() reads a template the way the parser does. */
const DSL_TAG_NAME = /[A-Za-z][A-Za-z0-9.:-]*/uy;
const DSL_ATTRIBUTE_NAME = /[^\s"'<>/={}]+/uy;
const DSL_UNQUOTED_VALUE = /[^\s"'<>=`{}]+/uy;
const DSL_SPACE = /\s*/uy;
const DSL_CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9.:-]*\s*>/uy;
const DSL_BLOCK_DELIMITER = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)\s+(?:\{[\s\S]*?\}\s+)?(\/)?-->/uy;

/**
 * Where each element, component and loop of a template starts, by the offset where it ends. The DSL is strict (every
 * element closed, no implied end tags, every `{#loop …}` closed by its `{/loop}` around whole elements), so pairing
 * start and end tags, and loop heads with their ends, reads the tree the parser reads, once everything the parser does
 * not read as a tag or a block is skipped as it skips it: comments and inline Gutenberg blocks, `{#raw}`, expressions
 * (its own brace matching), attribute values quoted (with their `{…}` and `\{` escapes), braced or bare (`href=/` is a
 * value, not a self-closing slash) and raw text. A `{#loop` the parser did not read as a loop (in a comment, an escaped
 * brace, a string of an expression, `{#raw}`) is never paired. Only a template the parser accepted is read; should the
 * pairing still go wrong (an end that does not close what is on top), what was found so far is kept and the rest falls
 * back to the parent's line, never another block's. `openEnds` gets, for each element with content and each loop, where
 * its start tag or its head ends (by where it starts): where its first child may start.
 */
function elementStarts(source: string, openEnds = new Map<number, number>()): Map<number, number> {
  const starts = new Map<number, number>();
  // What is open, innermost last: an element by its tag name, a loop by null (a name never matches it).
  const open: Array<{ start: number; name: string | null }> = [];
  const sticky = (pattern: RegExp, from: number): string | undefined => {
    pattern.lastIndex = from;
    return pattern.exec(source)?.[0];
  };
  const pastSpace = (from: number): number => from + (sticky(DSL_SPACE, from)?.length ?? 0);
  /** Past the brace that closes the one at `from`, as the parser finds it. */
  const pastBraces = (from: number): number => {
    try {
      return findClosingBrace(source, from) + 1;
    } catch {
      return source.length;
    }
  };
  /** Past an inline Gutenberg block, kept whole by the parser (xb/passthrough): what it holds is not the template's. */
  const pastPassthrough = (from: number): number => {
    let depth = 0;
    let scan = from;
    for (;;) {
      const next = source.indexOf("<!--", scan);
      if (next < 0) return source.length;
      DSL_BLOCK_DELIMITER.lastIndex = next;
      const delimiter = DSL_BLOCK_DELIMITER.exec(source);
      if (!delimiter) {
        scan = next + 4;
        continue;
      }
      scan = next + delimiter[0].length;
      if (delimiter[1]) depth--;
      else if (!delimiter[3]) depth++;
      if (depth === 0) return scan;
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (source.startsWith("<!--", index)) {
      if (/^<!--\s+wp:/u.test(source.slice(index, index + 64))) index = pastPassthrough(index);
      else {
        const end = source.indexOf("-->", index + 4);
        index = end < 0 ? source.length : end + 3;
      }
    } else if (char === "\\" && (source[index + 1] === "{" || source[index + 1] === "}")) index += 2;
    else if (source.startsWith("{#raw}", index)) {
      const end = source.indexOf("{/raw}", index + 6);
      index = end < 0 ? source.length : end + 6;
    } else if (char === "{") {
      const end = pastBraces(index);
      // parseBlockTag(): `{#loop` and a space open a loop, its head ends at its brace, and `{/loop}` closes the loop on
      // top (expectBlockClose), around whole elements. Any other brace block or expression is skipped whole, its body read.
      if (source.startsWith("{#loop", index) && /\s/u.test(source[index + 6] ?? "")) {
        openEnds.set(index, end);
        open.push({ start: index, name: null });
      } else if (source.startsWith("{/loop}", index)) {
        const top = open.pop();
        if (!top || top.name !== null) return starts;
        starts.set(end, top.start);
      }
      index = end;
    } else if (char === "<" && source[index + 1] === "/") {
      const close = sticky(DSL_CLOSE_TAG, index);
      if (!close) return starts;
      // expectCloseTag(): the end tag names the element on top, exactly.
      const top = open.pop();
      if (!top || sticky(DSL_TAG_NAME, index + 2) !== top.name) return starts;
      index += close.length;
      starts.set(index, top.start);
    } else if (char === "<" && /[A-Za-z]/u.test(source[index + 1] ?? "")) {
      const start = index;
      const name = sticky(DSL_TAG_NAME, index + 1)!;
      index += 1 + name.length;
      let selfClosing = false;
      // parseAttributes(): spaces, then `/>`, `>` or an attribute, its value after `=` when there is one.
      for (;;) {
        index = pastSpace(index);
        if (source.startsWith("/>", index)) {
          selfClosing = true;
          index += 2;
          break;
        }
        if (index >= source.length || source[index] === ">") {
          index++;
          break;
        }
        const attribute = sticky(DSL_ATTRIBUTE_NAME, index);
        if (!attribute) return starts;
        index = pastSpace(index + attribute.length);
        if (source[index] !== "=") continue;
        index = pastSpace(index + 1);
        const quote = source[index];
        if (quote === '"' || quote === "'") {
          for (index++; index < source.length && source[index] !== quote;) {
            if (source[index] === "\\" && (source[index + 1] === "{" || source[index + 1] === "}")) index += 2;
            else if (source[index] === "{") index = pastBraces(index);
            else index++;
          }
          index++;
        } else if (quote === "{") index = pastBraces(index);
        else index += sticky(DSL_UNQUOTED_VALUE, index)?.length ?? 0;
      }
      if (selfClosing || VOID_ELEMENTS.has(name)) starts.set(index, start);
      else if (RAW_TEXT_ELEMENTS.has(name)) {
        openEnds.set(start, index);
        const close = new RegExp(`</${name}\\s*>`, "giu");
        close.lastIndex = index;
        const found = close.exec(source);
        index = found ? found.index + found[0].length : source.length;
        starts.set(index, start);
      } else {
        openEnds.set(start, index);
        open.push({ start, name });
      }
    } else index++;
  }
  return starts;
}

/** Hints for the problems an agent or a person meets most (E4): what to write instead. */
function issueMessage(error: TransferMarkupError, reusable?: ReadonlyMap<string, PrototypeDocument["kind"]>): string {
  const message = error.message.replace(/ nel profilo trasferibile/gu, "");
  if (error.reason === "attribute" && /\bon[a-z]+\b/u.test(message) && /attributo/iu.test(message)) return `${message} Histeon non importa JavaScript: per un'azione usa un link o un modulo (manuale, §6 e §17.3).`;
  // A component called by its data-ref (<concert-card />), the slip small models make most: say the tag that calls it.
  const called = error.reason === "tag" ? /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>/u.exec(message)?.[1] : undefined;
  const kind = called ? reusable?.get(called) : undefined;
  if (called && (kind === "component" || kind === "part")) return `${message} Un ${kind === "part" ? "parte" : "componente"} si richiama con il suo nome in PascalCase, non con il data-ref: per data-ref="${called}" scrivi <${pascalTag(called)} … />.`;
  if (error.reason === "tag") return `${message} Gli elementi ammessi sono nel manuale, §17.2; icone, pulsanti e moduli in §17.3.`;
  if (error.reason === "style") return `${message} Sposta lo stile negli stili per selettore.`;
  return message;
}

/** A problem of a document as an issue: its own place when the message starts with the document's label. */
function documentIssue(message: string, item: PrototypeDocument, where: string): PrototypeIssue {
  const own = `${item.label}: `;
  return message.startsWith(own) ? { document: where, line: item.line, message: message.slice(own.length) } : { document: where, line: item.line, message };
}

/** How the issues name a document: "page contatti", "template site/page". */
function documentName(item: PrototypeDocument): string {
  return `${item.kind} ${item.attributes["data-ref"] ?? item.attributes["data-slug"] ?? "?"}`;
}

/**
 * A template's content as the project stores it, or null when it has problems: they go to `context.issues`, every one
 * with its line, and the import reports them all once every document is read (E4). The caller then keeps what the
 * document had (a page template its `{@slot}`), so that no later check reports a problem these ones caused.
 */
function documentContent(item: PrototypeDocument, context: BuildContext, warnings: string[]): string | null {
  // What the trim skips, so that a position in the template becomes one of the file.
  const leadLength = item.source.length - item.source.trimStart().length;
  const lead = item.source.slice(0, leadLength);
  const source = item.source.slice(leadLength).trimEnd();
  const before = lead.split("\n").length - 1;
  const fileLine = (line: number) => item.line + before + line - 1;
  // The template's first line starts past the `<template …>` tag, or past the indentation when it starts on a later line.
  const firstColumn = before === 0 ? item.column + lead.length : lead.length - lead.lastIndexOf("\n");
  const fileColumn = (line: number, column: number) => (line === 1 ? firstColumn + column - 1 : column);
  let lines: ((offset: number) => number) | undefined;
  /** The template's line of an offset; the index is built once, only for a template with something to report. */
  const lineAt = (offset: number): number => {
    lines ??= lineFinder(source);
    return lines(offset);
  };
  const where = documentName(item);
  // The parser names each block once it has read it, calling the factory as its own method: `this.pos` is then where
  // the block ends, which elementStarts() turns into where it starts. Without a position a problem keeps the template's line.
  const ends = new Map<string, number>();
  const next = uidFactory(`${context.projectId}\0${where}`);
  const uid = function (this: { pos?: unknown } | undefined): string {
    const id = next();
    if (typeof this?.pos === "number") ends.set(id, this.pos);
    return id;
  };
  let parsed: ReturnType<typeof parseDsl>;
  try {
    parsed = parseDsl(source, { uid });
  } catch (error) {
    // The parser's own position is relative to the template: the file's line and column replace it.
    if (error instanceof XbSyntaxError) context.issues.push({ document: where, line: fileLine(error.line), column: fileColumn(error.line, error.column), message: `${error.message.replace(/\s*\(riga \d+, colonna \d+\)\.?$/u, "").replace(/\.$/u, "")}.` });
    else context.issues.push({ document: where, line: item.line, message: `${error instanceof Error ? error.message : "template non valido"}.` });
    return null;
  }
  for (const warning of parsed.warnings) warnings.push(`${where} (riga ${fileLine(lineAt(warning.offset))}): ${warning.message}`);
  try {
    normalizePrototypeMarkup(parsed.blocks);
    frameworkNamesInBlocks(parsed.blocks, where, context.names, context.convert);
    resolveAssetReferences(parsed.blocks, context, item.label);
    collectForms(parsed.blocks, context, where);
  } catch (error) {
    if (!(error instanceof PrototypeError)) throw error;
    context.issues.push(documentIssue(error.message, item, where));
    return null;
  }
  // Every problem counts; a document holds the first DOCUMENT_ISSUES_READ, and compactIssues then keeps only what the
  // report can still list (the first PROTOTYPE_ISSUES_KEPT of the whole file).
  // The markup check names every block it refused, also past those it keeps: the structure check skips each of them,
  // or a component it refused (inside <svg>, say) would be counted again as a structure problem.
  const counted = { total: 0, refused: new Set<string>() };
  const markup = transferMarkupIssues(parsed.blocks, DOCUMENT_ISSUES_READ, counted);
  const calls: ComponentCall[] = [];
  const ref = item.kind === "page" || item.kind === "post" ? undefined : item.attributes["data-ref"]?.trim();
  // Doc 17: a template that is never an archive's (a role of one page, or none and only pages, posts or records use
  // it) reads the archive's names of `page` as nothing. A role that may list (index, front-page, search) is not said.
  const singularRole = ["single", "page", "404"].includes(item.attributes["data-role"]?.trim() ?? "");
  const neverArchive = item.kind === "template" && ref !== undefined && !context.archiveTemplateRefs?.has(ref) && (item.attributes["data-role"] === undefined ? context.singularTemplateUses?.has(ref) === true : singularRole);
  const archiveNames = neverArchive ? new Set<string>() : undefined;
  const found: Array<Omit<ExpressionProblem, "message"> & { message: string; slot?: string; head?: true }> = [
    ...markup.map(({ uid: blockUid, error }) => ({ uid: blockUid, message: issueMessage(error, context.reusable) })),
    ...structureIssues(parsed.blocks, item, context, counted.refused, counted),
    ...expressionProblems(parsed.blocks, item.kind, ref, context.expressions, counted.refused, counted, DOCUMENT_ISSUES_READ, calls, archiveNames),
  ];
  if (archiveNames?.size) {
    const listed = ARCHIVE_PAGE_NAMES.filter((name) => archiveNames.has(name)).map((name) => `page.${name}`);
    warnings.push(`${where}: ${listed.join(", ")} ${listed.length === 1 ? "esiste" : "esistono"} solo nei template d'archivio, e questo template non lo è mai: qui ${listed.length === 1 ? "vale" : "valgono"} sempre vuoto. Paginazione e conteggi vanno nel template d'archivio; per una lista vuota usa {:else} nel loop.`);
  }
  // The slots this one renders, for the calls to it; each call against the slots of the one it calls, once that is read.
  if (ref && !context.slots.has(ref)) context.slots.set(ref, declaredSlots(parsed.blocks));
  const openEnds = new Map<number, number>();
  let starts: Map<number, number> | undefined;
  const startOfEnd = (end: number | undefined): number | undefined => {
    starts ??= elementStarts(source, openEnds);
    return end === undefined ? undefined : starts.get(end);
  };
  /** A place of the trimmed template as a place of the file. */
  const filePlace = (offset: number): { line: number; column: number } => {
    const line = lineAt(offset);
    return { line: fileLine(line), column: fileColumn(line, offset - (source.lastIndexOf("\n", offset - 1) + 1) + 1) };
  };
  /** Where `{#slot name}` is written past a call's start: its fill's place. */
  const slotAt = (start: number, name: string): number | undefined => {
    for (let at = source.indexOf("{#slot", start); at !== -1; at = source.indexOf("{#slot", at + 6)) {
      if (new RegExp(`^\\{#slot\\s+${name.replace(/[^A-Za-z0-9_-]/gu, "")}\\s*\\}`, "u").test(source.slice(at, at + name.length + 32))) return at;
    }
    return undefined;
  };
  for (const call of calls) {
    const slots = context.slots.get(call.ref);
    if (slots) {
      for (const problem of slotProblems(call, slots)) {
        counted.total++;
        if (found.length < 3 * DOCUMENT_ISSUES_READ) found.push({ uid: call.uid, slot: problem.name, message: problem.message });
      }
      continue;
    }
    // Read later: only where the call ends is kept, and the template's text, to find its place should it be wrong.
    const end = ends.get(call.uid);
    context.pendingCalls.push({
      call,
      document: where,
      place: (slot) => {
        const start = startOfEnd(end);
        if (start === undefined) return { line: item.line };
        return filePlace(slot === "default" ? start : slotAt(start, slot) ?? start);
      },
    });
  }
  if (!found.length) {
    context.quality?.add(item, parsed.blocks);
    // The line of a block, from where the parser ended it: found only for a document with something to say.
    context.strict?.add(item, parsed.blocks, (blockUid) => {
      const start = startOfEnd(ends.get(blockUid));
      return start === undefined ? undefined : filePlace(start).line;
    });
    return serializeXb(parsed.blocks);
  }
  context.unlisted += counted.total - found.length;
  startOfEnd(undefined);
  /** Past spaces and the comments the parser drops (not in literal text): where what follows `from` starts. */
  const pastSkipped = (from: number, comments: boolean): number => {
    let at = from;
    for (;;) {
      DSL_SPACE.lastIndex = at;
      at += DSL_SPACE.exec(source)![0].length;
      // parseComment(): an inline Gutenberg block is a block of its own, any other comment is dropped.
      if (!comments || !source.startsWith("<!--", at) || /^<!--\s+\/?wp:/u.test(source.slice(at, at + 64))) return at;
      const close = source.indexOf("-->", at + 4);
      if (close < 0) return at;
      at = close + 3;
    }
  };
  /**
   * Each block's start. Elements, components and loops have their own (a loop's `{#loop`, paired with the `{/loop}` it
   * ends with), and `{#raw}` its exact one. Any other block that follows a sibling, or opens its parent's content,
   * starts right past it, spaces and comments aside: the parser names a text run (inline links and formatting folded
   * into it) only once the parent is read, and an `{#if}` once it is closed, so their own ends say nothing of their
   * starts. The rest (branches, slot fills, what follows a text run) take their parent's start, and with none the
   * template's line. `ownStart` holds the blocks whose start is their own: only there is a loop's head said by column.
   */
  const blockStart = new Map<string, number>();
  const ownStart = new Set<string>();
  const walk = (blocks: XbBlock[], inherited: number | undefined, from: number | undefined) => {
    let previousEnd = from;
    for (const block of blocks) {
      const end = ends.get(block.attrs.uid);
      const own = (block.name === "xb/element" || block.name === "xb/component" || block.name === "xb/loop") && end !== undefined ? startOfEnd(end) : block.name === "xb/raw" && end !== undefined ? end - "{#raw}{/raw}".length - block.attrs.content.length : undefined;
      const follows = previousEnd !== undefined && block.name !== "xb/branch" && block.name !== "xb/slot-fill";
      const start = own ?? (follows ? pastSkipped(previousEnd!, !(block.name === "xb/text" && block.attrs.verbatim === true)) : inherited);
      if (start !== undefined) blockStart.set(block.attrs.uid, start);
      if (own !== undefined) ownStart.add(block.attrs.uid);
      if ("children" in block) walk(block.children as XbBlock[], start, own === undefined ? undefined : openEnds.get(own));
      previousEnd = block.name === "xb/text" ? undefined : end;
    }
  };
  walk(parsed.blocks, undefined, 0);
  /**
   * The exact place of what a problem names past its block's start, within the block: a prop or an attribute of the
   * tag, an expression as written, the fill of a slot, a character of a text run. A text run is matched against the
   * template from where it starts, its runs of spaces against any spaces (the parser makes them one); the problems of one
   * run come in its order, so the match goes on from the last one and reads the run once. None when it cannot be told.
   */
  const resumed = new Map<string, { index: number; at: number }>();
  const exact = (problem: (typeof found)[number], start: number | undefined): number | undefined => {
    if (start === undefined) return undefined;
    const end = Math.max(start, ends.get(problem.uid) ?? source.length);
    if (problem.slot !== undefined) return problem.slot === "default" ? start : slotAt(start, problem.slot);
    // The loop's own `{#loop`; a start it only inherits (its parent's, or one past a sibling) names no column, since the
    // first `{#loop` past it may be another loop's.
    if (problem.head) return ownStart.has(problem.uid) && source.startsWith("{#loop", start) ? start : undefined;
    if (problem.attribute !== undefined) {
      const tagEnd = openEnds.get(start) ?? end;
      for (let at = source.indexOf(problem.attribute, start); at !== -1 && at < tagEnd; at = source.indexOf(problem.attribute, at + 1)) {
        if (/\s/u.test(source[at - 1] ?? "") && /[\s=/>]/u.test(source[at + problem.attribute.length] ?? "")) return at;
      }
      return undefined;
    }
    if (problem.argument !== undefined) {
      // `name: value` in the loop's own head: a name that is a whole word, then its colon. Past a start the loop only
      // inherits, the name may be another loop's argument: no column.
      if (!ownStart.has(problem.uid) || source[start] !== "{") return undefined;
      const { name, value } = problem.argument;
      let close = end;
      try { close = findClosingBrace(source, start) + 1; } catch { /* the parser read it whole */ }
      const head = source.slice(start, close);
      for (let index = head.indexOf(name); index !== -1; index = head.indexOf(name, index + 1)) {
        if (/[A-Za-z0-9_$]/u.test(head[index - 1] ?? "")) continue;
        const colon = /^\s*:\s*/u.exec(head.slice(index + name.length));
        if (colon) return start + index + (value ? name.length + colon[0].length : 0);
      }
      return undefined;
    }
    if (problem.textIndex !== undefined && problem.text !== undefined) {
      const text = problem.text;
      const space = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
      const from = resumed.get(problem.uid);
      let index = from && from.index <= problem.textIndex ? from.index : 0;
      let at = from && from.index <= problem.textIndex ? from.at : start;
      while (index < problem.textIndex) {
        if (space(text[index])) {
          while (index < text.length && space(text[index])) index++;
          while (at < end && space(source[at])) at++;
        } else if (source[at] === text[index]) {
          index++;
          at++;
        } else {
          at = -1;
          break;
        }
      }
      if (at >= 0) {
        resumed.set(problem.uid, { index, at });
        if (!space(text[problem.textIndex])) while (at < end && space(source[at])) at++;
        return at;
      }
    }
    if (problem.needle === undefined) return undefined;
    const at = source.slice(start, end).indexOf(problem.needle);
    return at === -1 ? undefined : start + at + (problem.at ?? 0);
  };
  for (const problem of found) {
    const start = blockStart.get(problem.uid);
    const offset = exact(problem, start);
    context.issues.push(offset === undefined ? { document: where, line: start === undefined ? item.line : fileLine(lineAt(start)), message: problem.message } : { document: where, ...filePlace(offset), message: problem.message });
  }
  compactIssues(context);
  return null;
}

/**
 * The first names of a set for a message ("a, b, c…"): read up to the ninth, never a copy of all of them. A prototype
 * may declare millions of query keys, and every document is checked against them (E4).
 */
function choices(names: Iterable<string>): string {
  const first: string[] = [];
  for (const name of names) {
    if (first.length === 9) break;
    first.push(name);
  }
  return `${first.slice(0, 8).map(shown).join(", ")}${first.length > 8 ? "…" : ""}`;
}

/** The blocks a transfer carries in a document (normalizeContentForTransfer); what each other one is, for its message. */
const TRANSFER_BLOCKS: ReadonlySet<string> = new Set(["xb/element", "xb/text", "xb/component", "xb/if", "xb/branch", "xb/loop", "xb/slot", "xb/slot-fill"]);
const UNTRANSFERABLE_BLOCKS: Readonly<Record<string, string>> = {
  "xb/raw": "{#raw} non si trasferisce: scrivi il markup senza {#raw}.",
  "xb/passthrough": "un blocco Gutenberg scritto come commento (<!-- wp:… -->) non si trasferisce: scrivi direttamente il suo HTML.",
  "xb/post-content": "{@content} non si trasferisce: il contenuto di una pagina o di un articolo entra nel suo template con {@slot}.",
};

/**
 * The problems of a document's structure that the transfer would find only once the project is exported, one at a
 * time and with no line (E4): a block it does not carry ({#raw}, a Gutenberg block written inline, {@content}), a
 * {@slot} in a page or a post, a component or a query the prototype does not declare. They are read against the
 * prototype itself, in the order of the document. A block the markup check refused is not reported again; what it
 * holds is read, since fixing its attribute would not fix that. Each one counts; the first DOCUMENT_ISSUES_READ are kept.
 */
function structureIssues(blocks: readonly XbBlock[], item: PrototypeDocument, context: BuildContext, refused: ReadonlySet<string>, counted: { total: number }): Array<{ uid: string; message: string; head?: true }> {
  const found: Array<{ uid: string; message: string; head?: true }> = [];
  const report = (uid: string, message: string, head?: true) => {
    counted.total++;
    if (found.length < DOCUMENT_ISSUES_READ) found.push({ uid, message, ...(head ? { head } : {}) });
  };
  /**
   * A loop's source, said at that loop's own `{#loop` in the file (documentContent pairs each loop head with the
   * `{/loop}` it ends with): its line and column, whatever text or other loops come before it in the same element.
   */
  const loopReport = (uid: string, message: string) => report(uid, message, true);
  const written = item.kind === "page" ? "una pagina" : item.kind === "post" ? "un articolo" : null;
  const visit = (block: XbBlock): void => {
    const uid = block.attrs.uid;
    if (refused.has(uid)) {
      // Reported by the markup check.
    } else if (!TRANSFER_BLOCKS.has(block.name)) {
      report(uid, UNTRANSFERABLE_BLOCKS[block.name] ?? `il blocco ${block.name} non si trasferisce.`);
    } else if (block.name === "xb/slot" && written) {
      report(uid, `{@slot} vale solo nei template e nei componenti, non in ${written}.`);
    } else if (block.name === "xb/component" && context.reusable.get(block.attrs.ref) !== "component" && context.reusable.get(block.attrs.ref) !== "part") {
      const ref = shown(block.attrs.ref);
      report(uid, context.reusable.has(block.attrs.ref)
        ? `${ref} è un template: un documento richiama solo componenti e parti, e una pagina sceglie il suo template con data-template.`
        : `il componente ${ref} non è nel prototipo: dichiaralo con <template data-histos="component" data-ref="${ref}"> (o "part" per una parte di template).`);
    } else if (block.name === "xb/loop" && block.attrs.source.kind !== "expr" && block.attrs.source.id === "main") {
      // The builder's built-in main query (blocks.md §3), which the transfer carries (page-transfer.ts): the records of
      // the archive the template shows, paged by the build as WordPress pages its main query. A template with an archive
      // role, or with none (a type's archiveTemplate), is an archive's; a page, a post, a component, a part, a template
      // of another role, or one a page, a post or a type's records render with, is not, and its build would refuse the
      // loop. The builder's built-in main ignores its arguments, so the check refuses them where they are written.
      const role = item.kind === "template" ? item.attributes["data-role"]?.trim() : undefined;
      const singular = ["front-page", "index", "single", "page", "search", "404"];
      const use = item.kind === "template" ? context.singularTemplateUses?.get(item.attributes["data-ref"]?.trim() ?? "") : undefined;
      if (Object.keys(block.attrs.source.args ?? {}).length) loopReport(uid, `{#loop main()}: main() non accetta argomenti, e WordPress li ignora: elenca i contenuti dell'archivio ${CMS_ARCHIVE_PAGE_SIZE} per pagina, dal più recente, e le pagine seguenti sono …/page/2/, …/page/3/ (page.page e page.totalPages dicono quale). Scrivi main(); per un altro numero o un altro ordine usa una query dichiarata in queries, con limit, orderBy e order.`);
      else if (written) loopReport(uid, `{#loop main()}: main() elenca i contenuti di un archivio e vale solo nei template d'archivio, non in ${written}: qui usa una query dichiarata in queries.`);
      else if (item.kind !== "template") loopReport(uid, `{#loop main()}: main() vale solo nei template d'archivio, non in ${item.kind === "part" ? "una parte" : "un componente"}: scrivi il loop nel template e passa ogni contenuto al componente con una prop.`);
      else if (role && singular.includes(role)) loopReport(uid, `{#loop main()}: main() elenca i contenuti di un archivio, e il ruolo ${role} non è un archivio${role === "index" ? " (index fa anche da pagina e da articolo)" : ""}: usalo in un template con ruolo archive, category, tag o home, o nell'archiveTemplate di un tipo.`);
      else if (use) loopReport(uid, `{#loop main()}: main() elenca i contenuti di un archivio, ma con questo template si mostra anche ${use.name}, che non è un archivio: lì la build del sito si ferma. ${use.fix}, o qui usa una query dichiarata in queries.`);
    } else if (block.name === "xb/loop" && block.attrs.source.kind !== "expr" && !context.queryKeys.has(block.attrs.source.id)) {
      loopReport(uid, `{#loop}: la query ${shown(block.attrs.source.id)} non è fra quelle dei contenuti: ${context.queryKeys.size ? `scegli fra ${choices(context.queryKeys)}` : "dichiarala in queries"}.`);
    }
    if ("children" in block) for (const child of block.children as XbBlock[]) visit(child);
  };
  for (const block of blocks) visit(block);
  return found;
}

/** CSS with `url("asset:<name>")`: the reference becomes a local path mapped to the project asset. */
function cssWithAssets(css: string, context: BuildContext, where: string): { css: string; assets: Array<{ reference: string; assetId: string }> } {
  const assets = new Map<string, string>();
  const out = css.replace(/url\(\s*(["']?)asset:([a-z0-9][a-z0-9-]{0,62})\1\s*\)/gu, (_match, _quote, name: string) => {
    assetUrl(context, name, where);
    assets.set(CSS_ASSET_PREFIX + name, context.assetIds.get(name)!);
    return `url("${CSS_ASSET_PREFIX}${name}")`;
  });
  if (/asset:/u.test(out)) fail(`${where}: asset: si usa nel CSS solo dentro url().`);
  if (/@import\b/iu.test(out)) fail(`${where}: @import non è ammesso.`);
  // The browser resolves escapes in names: "@im\70ort" is an @import too.
  if (/@[\w-]*\\/u.test(out)) fail(`${where}: le regole @ scritte con escape non sono ammesse.`);
  return { css: out, assets: [...assets].map(([reference, assetId]) => ({ reference, assetId })) };
}

/** One rule per selector, as in the single-file format: nested states and @media stay inside the rule. */
function selectorStyles(css: string, context: BuildContext, onParsed?: (root: ReturnType<typeof postcss.parse>) => void): Array<{ id: string; selector: string; css: string; assets?: Array<{ reference: string; assetId: string }> }> {
  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(css);
  } catch (error) {
    fail(`Stili per selettore: ${error instanceof Error ? error.message : "CSS non valido"}.`);
  }
  onParsed?.(root);
  const seen = new Set<string>();
  const styles: ReturnType<typeof selectorStyles> = [];
  for (const node of root.nodes as ChildNode[]) {
    if (node.type === "comment") continue;
    if (node.type !== "rule") fail(`Stili per selettore: ${node.type === "atrule" ? `@${node.name}` : node.type} fuori da una regola; mettilo dentro la regola del selettore.`);
    // The transfer takes so many: past them each style would still be measured, named and written, only to be refused at the end.
    if (styles.length === TRANSFER_STYLES_MAX) fail(`Stili per selettore: più di ${TRANSFER_STYLES_MAX} regole. Unisci le regole dello stesso blocco; quelle generali vanno nei fogli globali.`);
    const rule = node as Rule;
    const selector = rule.selector.trim();
    if (!selector || selector.length > 1024 || seen.has(selector)) fail(`Stili per selettore: selettore vuoto, troppo lungo o ripetuto (${selector.slice(0, 60)}).`);
    seen.add(selector);
    const body = (rule.nodes ?? []).map((child) => child.type === "decl" ? `${child.toString()};` : child.toString()).join("\n");
    const resolved = cssWithAssets(body, context, `Stile ${selector}`);
    const id = stableId(context.projectId, "style", selector);
    context.labels.set(id, `stile ${selector.slice(0, 120)}`);
    styles.push({ id, selector, css: resolved.css, ...(resolved.assets.length ? { assets: resolved.assets } : {}) });
  }
  return styles;
}

function decodeDataUri(data: string): Uint8Array {
  const base64 = data.slice(data.indexOf(",") + 1).replace(/\s+/gu, "");
  return Buffer.from(base64, "base64");
}

function referenceList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label}: serve un elenco di testi.`);
  return value as string[];
}

// ---------------------------------------------------------------- the values of the prototype, before any is saved

/*
 * Every name and value of the prototype that the project's store, the transfer or the static build would refuse only
 * later, one at a time and with no line (A7 trial: a template's data-ref="site/404" was refused by the store alone, as
 * a «componente», with no document and no line), is checked here first, against the same rules: the data-ref of each
 * component, part and template; the slug, title, status, date, terms and template of each page and post; the keys,
 * slugs, references and values of the content; the manifest's language and time zone. Each problem is an issue with its
 * place in the file, all of them together (E4). The rules are those of content-model.ts (KEY, FIELD_KEY,
 * RESERVED_RECORD_KEYS, FIELD_TYPES, the query keys, orders and filters, the record values of bindValue),
 * project-repository.ts (COMPONENT_REF_PATTERN, slugs), site-transfer.ts (counts, enum options, relation types) and
 * cms-api.ts (the static build: the «blog» type, the records of a type). prototype-issues.test.ts holds the grammars of
 * the names to the store's own, value by value, so that they cannot drift apart unseen.
 */
const TYPE_KEY = /^[a-z][a-z0-9_-]{0,62}$/u;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/u;
const QUERY_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const RESERVED_QUERY_KEYS: ReadonlySet<string> = new Set(["posts", "terms", "main", "users"]);
/** What every record already has (content-model.ts): a field may not take these names. */
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(["id", "typeId", "typeKey", "slug", "locale", "title", "status", "publishedAt", "excerpt", "order", "updatedAt", "fields", "terms", "meta", "url"]);
const FIELD_TYPES: ReadonlySet<string> = new Set(["text", "rich-text", "integer", "decimal", "boolean", "date", "datetime", "enum", "url", "asset", "relation"]);
/** How a query may order records and posts (content-model.ts, listRecords and listPostRecords); a record may also be ordered by a public field. */
const RECORD_ORDERS: ReadonlySet<string> = new Set(["order", "title", "slug", "publishedAt", "updatedAt"]);
const POST_ORDERS: ReadonlySet<string> = new Set([...RECORD_ORDERS, "createdAt"]);
/** What the transfer carries at most (site-transfer.ts), and what the static build writes per type and language (cms-api.ts). */
const MAX_TYPES = 30;
const MAX_TAXONOMIES = 30;
const MAX_QUERIES = 128;
const MAX_FIELDS = 64;
const MAX_TERMS_PER_TAXONOMY = 100;
const MAX_RECORDS_BUILT = 10_000;
const KIND_NAMES = { component: "un componente", part: "una parte", template: "un template" } as const;
const REF_EXAMPLES = { component: "card-opera", part: "site/header", template: "site/page" } as const;

/** The store's slug of a text (project-repository.ts, content-model.ts): what an invalid slug or name could become. */
function slugOf(value: string, max = 63): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max).replace(/-+$/u, "");
}

/** A valid data-ref close to an invalid one, when there is one: `Card_Opera` → `card-opera`; `site/404` has none. */
/** The tag that calls a data-ref: card-opera → CardOpera, site/header → Site.Header. */
function pascalTag(ref: string): string {
  return ref.split("/").map((segment) => segment.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")).join(".");
}

function suggestedRef(ref: string): string | undefined {
  const suggestion = ref.split("/").map((segment) => slugOf(segment)).join("/");
  return COMPONENT_REF_PATTERN.test(suggestion) && suggestion.length <= 128 ? suggestion : undefined;
}

function refMessage(kind: keyof typeof KIND_NAMES, ref: string): string {
  const suggestion = suggestedRef(ref);
  return `data-ref="${shown(ref)}" non è un nome valido per ${KIND_NAMES[kind]}. Un data-ref è una parola, o due separate da una «/»: ogni parola comincia con una lettera minuscola e prosegue con minuscole e cifre, e dopo un trattino viene sempre una lettera (card-opera, site/header). ${suggestion ? `Qui va bene ${suggestion}.` : "Per esempio site/404 diventa site/pagina-non-trovata."}`;
}

/**
 * A slug outside the grammar, with how to write it. The store would turn a term's or a record's into its own form (Q5:
 * the import used to let it, and the address changed under the links written to it), so that one says the form and
 * where else to write it; a page's or an article's is refused by the import as written.
 */
function slugMessage(slug: string, max: number, owner?: { kind: "term" } | { kind: "record"; type: string }): string {
  const suggestion = slugOf(slug, max);
  const rule = `lo slug «${shown(slug)}» non va bene: solo lettere minuscole senza accenti, cifre e un trattino fra due parole, al massimo ${max} caratteri`;
  if (!suggestion) return `${rule} (per esempio ${owner?.kind === "term" ? "notte" : owner ? "ehi" : "chi-siamo"}).`;
  if (!owner) return `${rule}. Scrivi data-slug="${suggestion}".`;
  const changed = `Il progetto lo cambierebbe in ${suggestion}, e con lui l'indirizzo ${owner.kind === "term" ? "del termine" : "del record"}`;
  return owner.kind === "term"
    ? `${rule}. ${changed}: scrivi "slug": "${suggestion}", e lo stesso slug dove il termine è nominato (parent, terms dei record, data-terms degli articoli, filtri delle query).`
    : `${rule}. ${changed}: scrivi "slug": "${suggestion}", e "${shown(owner.type)}/${suggestion}" nei campi relation che lo collegano.`;
}

/** The key of a type or a taxonomy that an invalid one could become: `Opere d'arte` → `opere-d-arte`. */
const fixedKey = (key: string): string => slugOf(key).replace(/^[^a-z]+/u, "");

function keyMessage(key: string, what: string): string {
  const suggestion = fixedKey(key);
  return `la chiave «${shown(key)}» non va bene per ${what}: comincia con una lettera minuscola e prosegue con minuscole, cifre, «-» o «_», al massimo 63 caratteri${suggestion ? ` (qui: ${suggestion})` : " (per esempio opere)"}.`;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** As text() checks a value, without stopping: a text that is not blank and not longer than `max`. */
const isText = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
/** content-model.ts's datetime: ISO, with seconds and an explicit zone, on a day that exists. */
const isDateTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/u.test(value) && isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

/**
 * An optional number of the content as the import reads it (a query's limit and offset, a record's order): a JSON
 * number, or nothing, null included; any other value it drops for the default. Dropping one is refused only where that
 * changes the site (Q5): text that reads as another number than the default (that number, to say how to write it), or a
 * value that reads as no number ("dropped"). Text that reads as the default changes nothing, and so passes.
 */
function droppedNumber(value: unknown, fallback: number): number | "dropped" | undefined {
  if (value === undefined || value === null || typeof value === "number") return undefined;
  const reading = typeof value === "string" && /^\s*[+-]?\d+(?:\.\d+)?\s*$/u.test(value) ? Number(value) : undefined;
  if (reading === undefined) return "dropped";
  return reading === fallback ? undefined : reading;
}

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

/** The place of an issue: its line and, when known, its column. */
function at(place: Place | undefined): { line?: number; column?: number } {
  return place ? { line: place.line, column: place.column } : {};
}

/** The prop types a component's schema takes (project-repository.ts, validateComponentSchema). */
const PROP_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "url", "image", "rich-text", "enum", "array", "object"]);

/**
 * What the expressions of the documents are read against (prototype-expressions.ts), from the declarations alone, never
 * a document's source: the type of each query's records, the props of each component, part and template as the store
 * will hold them (data-props, or the store's own: none for a component or a part, `page` for a template; nothing when
 * data-props is not a schema the store takes, which is its own problem), and the single relation fields that a
 * published record fills, whose value the build gives as the linked record, an object.
 */
function expressionDeclarations(prototype: ParsedPrototype, reusable: ReadonlyMap<string, PrototypeDocument["kind"]>): ExpressionDeclarations {
  const queryTypes = new Map<string, string>();
  for (const query of Array.isArray(prototype.content.queries) ? prototype.content.queries : []) {
    if (isObject(query) && typeof query.key === "string" && typeof query.type === "string" && !queryTypes.has(query.key)) queryTypes.set(query.key, query.type);
  }
  const props = new Map<string, Readonly<Record<string, PropDefinition>>>();
  const seen = new Set<string>();
  for (const item of prototype.documents) {
    if (item.kind !== "component" && item.kind !== "part" && item.kind !== "template") continue;
    const ref = item.attributes["data-ref"]?.trim() ?? "";
    if (seen.has(ref)) continue;
    seen.add(ref);
    const written = item.attributes["data-props"];
    if (written === undefined) {
      props.set(ref, item.kind === "template" ? { page: { type: "object" } } : {});
      continue;
    }
    let schema: unknown;
    try { schema = JSON.parse(written); } catch { schema = undefined; }
    if (!isObject(schema) || !Object.values(schema).every((definition) => isObject(definition) && typeof definition.type === "string" && PROP_TYPES.has(definition.type))) continue;
    props.set(ref, schema as Record<string, PropDefinition>);
  }
  const relationObjects = new Map<string, Set<string>>();
  const relationFields = new Map<string, Set<string>>();
  for (const type of Array.isArray(prototype.content.types) ? prototype.content.types : []) {
    if (!isObject(type) || typeof type.key !== "string" || !Array.isArray(type.fields)) continue;
    // A query gives the public fields alone (listRecords without includePrivate): a private one is nothing there.
    const single = new Set(type.fields.filter((field): field is Record<string, unknown> => isObject(field) && field.type === "relation" && field.multiple !== true && field.public === true && typeof field.key === "string").map((field) => field.key as string));
    if (single.size) relationFields.set(type.key, single);
  }
  for (const record of Array.isArray(prototype.content.records) ? prototype.content.records : []) {
    if (!isObject(record) || typeof record.type !== "string" || !isObject(record.values) || !(record.status === undefined || record.status === null || record.status === "published")) continue;
    for (const key of relationFields.get(record.type) ?? []) {
      const value = record.values[key];
      if (typeof value === "string" && value) {
        const filled = relationObjects.get(record.type) ?? new Set<string>();
        filled.add(key);
        relationObjects.set(record.type, filled);
      }
    }
  }
  return { queryTypes, props, relationObjects, callable: (ref) => reusable.get(ref) === "component" || reusable.get(ref) === "part" };
}

/**
 * The records each record points to in a required relation field, of the field's type and other than itself (a record
 * may point to itself: its row exists when its values are bound), with the field: what must be saved before it.
 */
function requiredTargets(raw: unknown, index: number, records: ReadonlyMap<string, { type: string; index: number }>, types: ReadonlyMap<string, { fields: Map<string, Record<string, unknown>> }>): Array<{ target: number; field: string }> {
  if (!isObject(raw) || typeof raw.type !== "string" || !isObject(raw.values)) return [];
  const declared = types.get(raw.type);
  if (!declared) return [];
  const targets: Array<{ target: number; field: string }> = [];
  for (const [key, field] of declared.fields) {
    if (field.type !== "relation" || field.required !== true) continue;
    for (const value of [raw.values[key]].flat()) {
      const target = typeof value === "string" ? records.get(value) : undefined;
      if (target && target.type === field.targetType && target.index !== index) targets.push({ target: target.index, field: key });
    }
  }
  return targets;
}

/**
 * Q6: a record whose type has a required relation is saved with it, after the records it points to (buildPrototypeProfile);
 * records that point to each other through required relations, in a circle, can never be saved, whichever comes
 * first, and the store said only that one «non appartiene al tipo», of the wrong one. Each circle (a strongly connected
 * group, found without recursion) is said once, at its first record in the file, with one round of it named.
 */
function requiredRelationCircles(recordList: readonly unknown[], records: ReadonlyMap<string, { type: string; index: number }>, types: ReadonlyMap<string, { fields: Map<string, Record<string, unknown>> }>, report: (index: number, message: string) => void): void {
  const edges = (index: number) => requiredTargets(recordList[index], index, records, types);
  const order = new Map<number, number>();
  const low = new Map<number, number>();
  const open = new Set<number>();
  const held: number[] = [];
  for (const start of recordList.keys()) {
    if (order.has(start) || !edges(start).length) continue;
    const visit = (node: number) => {
      order.set(node, order.size);
      low.set(node, order.get(node)!);
      held.push(node);
      open.add(node);
      return { node, targets: edges(node), next: 0 };
    };
    const work = [visit(start)];
    while (work.length) {
      const top = work.at(-1)!;
      const edge = top.targets[top.next++];
      if (edge) {
        if (!order.has(edge.target)) work.push(visit(edge.target));
        else if (open.has(edge.target)) low.set(top.node, Math.min(low.get(top.node)!, order.get(edge.target)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(top.node)!));
      if (low.get(top.node) !== order.get(top.node)) continue;
      const group: number[] = [];
      for (let member = held.pop(); member !== undefined; member = held.pop()) {
        open.delete(member);
        group.push(member);
        if (member === top.node) break;
      }
      if (group.length < 2) continue;
      // One round, the shortest from the group's first record back to it.
      const members = new Set(group);
      const first = Math.min(...group);
      const previous = new Map<number, { from: number; field: string }>();
      const queue = [first];
      let closing: { from: number; field: string } | undefined;
      for (let head = 0; head < queue.length && !closing; head++) {
        for (const { target, field } of edges(queue[head]!)) {
          if (!members.has(target)) continue;
          if (target === first) {
            closing = { from: queue[head]!, field };
            break;
          }
          if (!previous.has(target)) {
            previous.set(target, { from: queue[head]!, field });
            queue.push(target);
          }
        }
      }
      if (!closing) continue;
      const round = [{ node: closing.from, field: closing.field }];
      for (let node = closing.from; node !== first;) {
        const step = previous.get(node)!;
        round.unshift({ node: step.from, field: step.field });
        node = step.from;
      }
      const name = (index: number) => {
        const raw = recordList[index] as Record<string, unknown>;
        return `${shown(String(raw.type))}/${shown(String(raw.slug))}`;
      };
      const shownRound = round.length > 8 ? [...round.slice(0, 4), { node: -1, field: "" }, ...round.slice(-3)] : round;
      const steps = shownRound.map(({ node, field }) => (node === -1 ? "…" : `${name(node)} (campo ${field})`)).join(" → ");
      report(first, `i record si collegano in cerchio con campi relation obbligatori: ${steps} → ${name(first)}${group.length > round.length ? `, e il giro tocca ${group.length} record` : ""}. Il progetto salva un record solo dopo quelli che collega in un campo obbligatorio, quindi nessuno di questi si può salvare: togli "required": true da uno di questi campi, o il collegamento da uno di questi record.`);
    }
  }
}

/**
 * The checks of the values (see above), every problem in `context.issues`. Nothing is saved yet: when there is any, the
 * build reads the documents for their own problems and stops before creating the project. Never reads the source or the
 * data-title of a component, part or template: those are read where it is created, which lets the server answer as it goes.
 */
function declarationIssues(prototype: ParsedPrototype, context: BuildContext): void {
  const report = (issue: PrototypeIssue) => {
    context.issues.push(issue);
    compactIssues(context);
  };
  const { content, manifest } = prototype;
  const places = prototype.places?.content;

  // The manifest: the project's language and time zone, as the store takes them, each at its key in the JSON.
  const manifestPlace = (key: string) => ({ document: "manifest", ...at(prototype.places?.manifestKeys?.[key] ?? prototype.places?.manifest) });
  if (manifest.locale !== undefined) {
    try { normalizeCmsRenderSettings({ locale: manifest.locale, timeZone: "UTC" }); } catch { report({ ...manifestPlace("locale"), message: `locale «${shown(manifest.locale)}» non è una lingua che Histeon riconosce: scrivi un tag BCP 47, per esempio it-IT o en-GB.` }); }
  }
  if (manifest.timeZone !== undefined) {
    try { normalizeCmsRenderSettings({ locale: "en", timeZone: manifest.timeZone }); } catch { report({ ...manifestPlace("timeZone"), message: `timeZone «${shown(manifest.timeZone)}» non è un fuso orario che Histeon riconosce: scrivi un nome IANA, per esempio Europe/Rome.` }); }
  }
  if (manifest.shop !== undefined) {
    try { normalizeShopSettings(manifest.shop); } catch (error) { report({ ...manifestPlace("shop"), message: error instanceof Error ? error.message : String(error) }); }
  }

  // Components, parts and templates: their data-ref, area and role. Every name written counts as declared, also one
  // refused here, so that what refers to it is not refused again for that.
  const refs = new Map<string, PrototypeDocument>();
  const templates = new Set<string>();
  const writtenTemplates = new Set<string>();
  const roles = new Map<string, PrototypeDocument>();
  // The templates the build may render: named by a page, an article or a type, or holding a role.
  const namedTemplates = new Set<string>();
  for (const item of prototype.documents) if (item.attributes["data-template"] !== undefined) namedTemplates.add(item.attributes["data-template"]);
  for (const type of Array.isArray(content.types) ? content.types : []) {
    if (!isObject(type)) continue;
    for (const ref of [type.singleTemplate, type.archiveTemplate]) if (typeof ref === "string") namedTemplates.add(ref);
  }
  for (const item of prototype.documents) {
    if (item.kind !== "component" && item.kind !== "part" && item.kind !== "template") continue;
    const document = documentName(item);
    const place = (attribute: string) => ({ document, line: item.line, ...at(item.places?.[attribute]) });
    const ref = item.attributes["data-ref"]?.trim() ?? "";
    if (item.kind === "template" && ref) writtenTemplates.add(ref);
    const first = refs.get(ref);
    if (!ref) report({ ...place("data-ref"), message: `manca data-ref: ${KIND_NAMES[item.kind]} ha bisogno del suo nome, per esempio data-ref="${REF_EXAMPLES[item.kind]}".` });
    else if (ref.length > 128) report({ ...place("data-ref"), message: `data-ref ha ${ref.length} caratteri: al massimo 128.` });
    else if (!COMPONENT_REF_PATTERN.test(ref)) report({ ...place("data-ref"), message: refMessage(item.kind, ref) });
    else if (first) report({ ...place("data-ref"), message: `data-ref="${shown(ref)}" ripetuto: è già di ${documentName(first)} (riga ${first.line}), e ogni componente, parte e template ha il suo.` });
    else {
      refs.set(ref, item);
      if (item.kind === "template") templates.add(ref);
    }
    // The area of a part; on another document the build does not read it.
    const area = item.attributes["data-area"];
    if (item.kind === "part" && area !== undefined && !["header", "footer", "uncategorized"].includes(area)) report({ ...place("data-area"), message: `data-area="${shown(area)}": può essere header, footer o uncategorized.` });
    // The props: a JSON object, which the build reads before the store checks each prop. A template's replace the
    // `page` prop it has without them, and the build passes every template the page through that prop.
    const props = item.attributes["data-props"];
    if (props !== undefined) {
      let schema: unknown;
      try { schema = JSON.parse(props); } catch { schema = undefined; }
      if (!isObject(schema)) report({ ...place("data-props"), message: `data-props è un oggetto JSON con le props, per esempio data-props='{"titolo":{"type":"string","default":""}}'.` });
      else if (item.kind === "template" && (namedTemplates.has(ref) || item.attributes["data-role"] !== undefined) && (!isObject(schema.page) || schema.page.type !== "object")) report({ ...place("data-props"), message: `un template con data-props ha anche la prop page, di tipo object: la build gli passa la pagina in quella prop, e senza la build del sito si ferma su ogni pagina che lo usa. Aggiungi "page": {"type": "object"}.` });
    }
    const role = item.attributes["data-role"];
    if (role === undefined) continue;
    const holder = roles.get(role);
    if (item.kind !== "template") report({ ...place("data-role"), message: "data-role vale solo per i template." });
    else if (!(TEMPLATE_ROLES as readonly string[]).includes(role)) report({ ...place("data-role"), message: `data-role="${shown(role)}": ruolo non valido o già usato. I ruoli sono ${TEMPLATE_ROLES.join(", ")}.` });
    else if (holder) report({ ...place("data-role"), message: `data-role="${role}": ruolo non valido o già usato, è già di ${documentName(holder)} (riga ${holder.line}). Ogni ruolo va a un solo template: togli data-role, e le pagine che usano questo template lo scelgono con data-template.` });
    else roles.set(role, item);
  }
  /** What follows the name of a template that the prototype does not declare. */
  const notATemplate = () => `non è un template del prototipo: ${templates.size ? `scegli fra ${choices(templates)}` : "aggiungi un <template data-histos=\"template\"> con quel data-ref"}.`;

  // The lists of the content: each problem at its entry.
  const section = (name: Exclude<keyof ContentPlaces, "fields">): unknown[] => {
    const value = content[name];
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    report({ document: "contenuti", message: `${name} deve essere un elenco.` });
    return [];
  };
  const entry = (name: Exclude<keyof ContentPlaces, "fields">, index: number, label: string) => ({ document: label, ...at(places?.[name][index]) });
  const named = (prefix: string, value: unknown, index: number) => `${prefix} ${typeof value === "string" && value ? shown(value) : index + 1}`;
  // The posts index /blog/, by the build's own rule (cmsPostsIndexWritten, cms-api.ts postsIndexWanted): written when the
  // prototype has a post, a draft too, and no published page takes /blog/. The check plans the same route (prototype-check.ts).
  const postsIndex = cmsPostsIndexWritten({
    posts: prototype.documents.filter((item) => item.kind === "post").length,
    blogPage: prototype.documents.some((item) => item.kind === "page" && item.attributes["data-slug"] === "blog" && item.attributes["data-status"] !== "draft"),
  });

  /** A type whose key is valid: its valid fields, and the key of every field it writes (a value of a refused one is not refused again). */
  interface DeclaredType { fields: Map<string, Record<string, unknown>>; written: Set<string> }
  const types = new Map<string, DeclaredType>();
  const writtenTypes = new Set<string>();
  const typeList = section("types");
  if (typeList.length > MAX_TYPES) report({ document: "contenuti", ...at(places?.types[MAX_TYPES]), message: `${typeList.length} tipi di contenuto: il trasferimento ne porta al massimo ${MAX_TYPES}.` });
  // Every name written counts as declared, and so does the name its fix gives it: what refers to it by either is not
  // refused again for its problem. So for taxonomies, terms and records below.
  for (const raw of typeList) if (isObject(raw) && typeof raw.key === "string") writtenTypes.add(raw.key).add(fixedKey(raw.key));
  /** Relation fields, checked once every type is known: one may point to a type declared after its own. */
  const relationTargets: Array<{ target: unknown; name: string; where: { document: string; line?: number; column?: number } }> = [];
  for (const [index, raw] of typeList.entries()) {
    const where = entry("types", index, named("tipo", isObject(raw) ? raw.key : undefined, index));
    if (!isObject(raw)) {
      report({ ...where, message: "un tipo è un oggetto con key, label e fields." });
      continue;
    }
    const key = raw.key;
    let valid = false;
    if (typeof key !== "string" || !key) report({ ...where, message: "manca key, il nome tecnico del tipo (per esempio opera): è anche il suo indirizzo, /opera/." });
    else if (!TYPE_KEY.test(key)) report({ ...where, message: keyMessage(key, "un tipo") });
    else if (key === "post" || key === "page" || key === "category" || key === "post_tag") report({ ...where, message: `la chiave «${key}» è riservata (post, page, category e post_tag sono di Histeon): scegline un'altra.${key === "post" || key === "page" ? ` Articoli e pagine non si dichiarano come tipi: scrivili come <template data-histos="${key}"> nel <body>.` : key === "category" ? " Le categorie degli articoli sono una tassonomia, non un tipo: dichiarala in taxonomies (key «category», types [\"post\"]) e mettine i termini in terms." : ""}` });
    else if ((PRODUCT_TAXONOMIES as readonly string[]).includes(key)) report({ ...where, message: `la chiave «${key}» è riservata alle categorie e ai tag dei prodotti: scegline un'altra.` });
    else if (types.has(key)) report({ ...where, message: `il tipo «${key}» è dichiarato due volte.` });
    else if (key === "blog" && postsIndex) report({ ...where, message: "il tipo «blog» prende l'indirizzo /blog/, che con degli articoli (anche solo in bozza) è l'elenco degli articoli: la build del sito si ferma. Chiamalo in un altro modo, per esempio notizie." });
    else valid = true;
    if (!isText(raw.label, 120)) report({ ...where, message: "label: serve un testo di al massimo 120 caratteri." });
    for (const property of ["singleTemplate", "archiveTemplate"] as const) {
      const ref = raw[property];
      // null and "" are no template, as the store reads them (normalizeTemplateRef): the build takes the role's.
      if (ref === undefined || ref === null || ref === "") continue;
      if (typeof ref !== "string") report({ ...where, message: `${property} è il data-ref di un template, scritto come testo.` });
      else if (!writtenTemplates.has(ref)) report({ ...where, message: `${property} «${shown(ref)}» ${notATemplate()}` });
    }
    const fields = new Map<string, Record<string, unknown>>();
    const written = new Set<string>();
    const rawFields = raw.fields ?? [];
    if (key === PRODUCT_TYPE_KEY) {
      // The shop's products (queue C6): their fields are WooCommerce's, given by the import, never written.
      if (!Array.isArray(rawFields) || rawFields.length) report({ ...where, message: `il tipo product è il catalogo del negozio e ha già i suoi campi (${PRODUCT_FIELDS.map((field) => field.key).join(", ")}): togli fields.` });
      for (const field of PRODUCT_FIELDS) {
        fields.set(field.key, { ...field });
        written.add(field.key);
      }
    } else if (!Array.isArray(rawFields) || rawFields.length > MAX_FIELDS) report({ ...where, message: `fields è un elenco di al massimo ${MAX_FIELDS} campi.` });
    else for (const [fieldIndex, field] of rawFields.entries()) {
      const fieldWhere = { ...where, ...at(places?.fields[index]?.[fieldIndex]) };
      if (!isObject(field)) {
        report({ ...fieldWhere, message: `il campo ${fieldIndex + 1} è un oggetto con key, label e type.` });
        continue;
      }
      const fieldKey = field.key;
      // A record's value may already use the name the fix gives the key ("prezzo" for "Prezzo"): not refused again.
      const fixed = typeof fieldKey === "string" ? slugOf(fieldKey).replaceAll("-", "_") : "";
      if (typeof fieldKey === "string") written.add(fieldKey).add(fixed);
      const name = typeof fieldKey === "string" ? `il campo «${shown(fieldKey)}»` : `il campo ${fieldIndex + 1}`;
      let fieldValid = false;
      if (typeof fieldKey !== "string" || !FIELD_KEY.test(fieldKey)) report({ ...fieldWhere, message: `${name}: la chiave comincia con una lettera minuscola e prosegue con minuscole, cifre o «_», senza trattini, al massimo 63 caratteri${FIELD_KEY.test(fixed) ? ` (qui: ${fixed})` : " (per esempio data_inizio)"}.` });
      else if (RESERVED_FIELD_KEYS.has(fieldKey)) report({ ...fieldWhere, message: `${name}: ${fieldKey} è già un dato di ogni record (${[...RESERVED_FIELD_KEYS].join(", ")}): chiamalo in un altro modo.` });
      else if (fields.has(fieldKey)) report({ ...fieldWhere, message: `${name} è ripetuto nel tipo.` });
      else fieldValid = true;
      if (!isText(field.label, 120)) report({ ...fieldWhere, message: `${name}: label è un testo di al massimo 120 caratteri.` });
      const type = field.type;
      if (typeof type !== "string" || !FIELD_TYPES.has(type)) report({ ...fieldWhere, message: `${name}: type «${typeof type === "string" ? shown(type) : String(type)}» non è un tipo di campo; i tipi sono ${[...FIELD_TYPES].join(", ")}.` });
      const options = field.options;
      if (type === "enum" && options === undefined) report({ ...fieldWhere, message: `${name}: un campo enum elenca i valori ammessi in options, per esempio "options": ["piccolo", "grande"].` });
      else if (options !== undefined && type !== "enum") report({ ...fieldWhere, message: `${name}: options vale solo per un campo enum.` });
      else if (options !== undefined && (!Array.isArray(options) || options.length < 1 || options.length > 100 || options.some((option) => typeof option !== "string" || !option || option.length > 200) || new Set(options).size !== options.length)) report({ ...fieldWhere, message: `${name}: options è un elenco da 1 a 100 testi diversi, ognuno di al massimo 200 caratteri.` });
      if (type === "relation") relationTargets.push({ target: field.targetType, name, where: fieldWhere });
      else if (field.targetType !== undefined) report({ ...fieldWhere, message: `${name}: targetType vale solo per un campo relation.` });
      if (fieldValid) fields.set(fieldKey as string, field);
    }
    if (valid) types.set(key as string, { fields, written });
  }
  for (const { target, name, where } of relationTargets) {
    if (typeof target !== "string" || !writtenTypes.has(target)) report({ ...where, message: `${name}: targetType è la key del tipo dei record collegati${typeof target === "string" ? `, e «${shown(target)}» non è fra i tipi` : ""}${types.size ? ` (${choices(types.keys())})` : ""}.` });
  }

  // Taxonomies, attached to declared types or to posts.
  const taxonomies = new Map<string, string[]>();
  const writtenTaxonomies = new Set<string>();
  const taxonomyList = section("taxonomies");
  if (taxonomyList.length > MAX_TAXONOMIES) report({ document: "contenuti", ...at(places?.taxonomies[MAX_TAXONOMIES]), message: `${taxonomyList.length} tassonomie: il trasferimento ne porta al massimo ${MAX_TAXONOMIES}.` });
  for (const [index, raw] of taxonomyList.entries()) {
    const where = entry("taxonomies", index, named("tassonomia", isObject(raw) ? raw.key : undefined, index));
    if (!isObject(raw)) {
      report({ ...where, message: "una tassonomia è un oggetto con key, label e types." });
      continue;
    }
    const key = raw.key;
    if (typeof key === "string") writtenTaxonomies.add(key).add(fixedKey(key));
    let valid = false;
    if (typeof key !== "string" || !key) report({ ...where, message: "manca key, il nome tecnico della tassonomia (per esempio tema): è anche il suo indirizzo, /tema/…." });
    else if (!TYPE_KEY.test(key)) report({ ...where, message: keyMessage(key, "una tassonomia") });
    else if (key === "post" || key === "page") report({ ...where, message: `la chiave «${key}» è riservata ai documenti di Histeon: scegline un'altra.` });
    else if (taxonomies.has(key)) report({ ...where, message: `la tassonomia «${key}» è dichiarata due volte.` });
    else if (writtenTypes.has(key)) report({ ...where, message: `«${key}» è già la key di un tipo: tipi e tassonomie hanno key diverse.` });
    else valid = true;
    if (!isText(raw.label, 120)) report({ ...where, message: "label: serve un testo di al massimo 120 caratteri." });
    const attached = raw.types ?? [];
    if (!Array.isArray(attached) || attached.length > 64 || attached.some((item) => typeof item !== "string") || new Set(attached).size !== attached.length) report({ ...where, message: "types è un elenco di al massimo 64 tipi diversi: le key dei tipi, e post per gli articoli." });
    else {
      for (const type of attached as string[]) if (type !== "post" && !writtenTypes.has(type)) report({ ...where, message: `types: «${shown(type)}» non è un tipo dichiarato (${types.size ? `${choices(types.keys())}, o ` : ""}post per gli articoli).` });
      if ((POST_TAXONOMIES as readonly string[]).includes(key as string) && (attached.length !== 1 || attached[0] !== "post")) report({ ...where, message: `${key as string} vale solo per gli articoli: "types": ["post"].` });
      if ((PRODUCT_TAXONOMIES as readonly string[]).includes(key as string) && (attached.length !== 1 || attached[0] !== PRODUCT_TYPE_KEY)) report({ ...where, message: `${key as string} vale solo per i prodotti: "types": ["product"].` });
    }
    if (valid) taxonomies.set(key as string, Array.isArray(attached) ? attached.filter((item): item is string => typeof item === "string") : []);
  }

  // Terms: canonical slugs, as the store would make them, never silently another address.
  const terms = new Set<string>();
  const writtenTerms = new Set<string>();
  /** Each term declared once, by "taxonomy/slug", with its index in the list; and the parent each one names. */
  const termIndex = new Map<string, number>();
  const parents = new Map<number, string>();
  const termList = section("terms");
  for (const raw of termList) if (isObject(raw) && typeof raw.taxonomy === "string" && typeof raw.slug === "string") writtenTerms.add(`${raw.taxonomy}/${raw.slug}`).add(`${raw.taxonomy}/${slugOf(raw.slug)}`);
  for (const [index, raw] of termList.entries()) {
    const label = isObject(raw) && typeof raw.taxonomy === "string" && typeof raw.slug === "string" ? `termine ${shown(raw.taxonomy)}/${shown(raw.slug)}` : `termine ${index + 1}`;
    const where = entry("terms", index, label);
    if (!isObject(raw)) {
      report({ ...where, message: "un termine è un oggetto con taxonomy, slug e label." });
      continue;
    }
    const { taxonomy, slug, parent } = raw;
    if (typeof taxonomy !== "string" || !writtenTaxonomies.has(taxonomy)) report({ ...where, message: `taxonomy è la key di una tassonomia dichiarata${taxonomies.size ? `: ${choices(taxonomies.keys())}` : ", e il prototipo non ne dichiara"}.` });
    if (typeof slug !== "string" || !slug) report({ ...where, message: "manca slug, l'indirizzo del termine (per esempio notte)." });
    else if (slug.length > 63 || !SLUG.test(slug)) report({ ...where, message: slugMessage(slug, 63, { kind: "term" }) });
    else if (typeof taxonomy === "string" && terms.has(`${taxonomy}/${slug}`)) report({ ...where, message: `il termine ${shown(taxonomy)}/${slug} è dichiarato due volte.` });
    else if (typeof taxonomy === "string") {
      terms.add(`${taxonomy}/${slug}`);
      termIndex.set(`${taxonomy}/${slug}`, index);
    }
    if (!isText(raw.label, 120)) report({ ...where, message: "label: serve un testo di al massimo 120 caratteri." });
    // A parent that is not there, or the term itself, would leave the term waiting for it: the build said only that one was missing somewhere.
    if (parent !== undefined && parent !== null && typeof taxonomy === "string" && (typeof parent !== "string" || parent === slug || !writtenTerms.has(`${taxonomy}/${parent}`))) report({ ...where, message: parent === slug ? "un termine non può essere il genitore di sé stesso." : `parent è lo slug di un altro termine di ${shown(taxonomy)}, dichiarato in terms.` });
    else if (typeof parent === "string" && typeof taxonomy === "string" && typeof slug === "string") parents.set(index, `${taxonomy}/${parent}`);
  }
  // A circle of parents (a → b → a) leaves every term in it waiting for another: the build said only «un genitore manca
  // o la gerarchia è circolare», with no term. Each circle is said once, at its first term in the file, and named.
  const climbed = new Map<number, number>();
  for (const [index] of termList.entries()) {
    if (climbed.has(index)) continue;
    const path: number[] = [];
    let at: number | undefined = index;
    while (at !== undefined && !climbed.has(at)) {
      climbed.set(at, index);
      path.push(at);
      const parentKey = parents.get(at);
      at = parentKey === undefined ? undefined : termIndex.get(parentKey);
    }
    // A term already climbed from this start closes a circle; one climbed from another start was told then.
    if (at === undefined || climbed.get(at) !== index) continue;
    const circle = path.slice(path.indexOf(at));
    const first = Math.min(...circle);
    const name = (term: number) => { const raw = termList[term] as Record<string, unknown>; return `${String(raw.taxonomy)}/${String(raw.slug)}`; };
    const from = circle.indexOf(first);
    const ordered = [...circle.slice(from), ...circle.slice(0, from), first].map(name);
    report({ ...entry("terms", first, `termine ${shown(name(first))}`), message: `i genitori dei termini fanno un giro: ${ordered.map(shown).join(" → ")}. Ogni termine sale fino a uno senza parent, e così nessuno di questi si può salvare: togli il parent di uno di loro.` });
  }
  /**
   * The problems of a list of terms of a taxonomy, as a record, a post or a query names them; one message, or none. A
   * term twice is refused in what a record or a post is filed under (the store's normalizeRecordTerms, writePostTerms),
   * never in a query's filter, which the store compiles as it is.
   */
  const termsIssue = (taxonomy: string, slugs: unknown, owner: string, repeats: "refused" | "allowed"): string | undefined => {
    if (!writtenTaxonomies.has(taxonomy)) return `la tassonomia «${shown(taxonomy)}» non è dichiarata${taxonomies.size ? ` (${choices(taxonomies.keys())})` : ""}.`;
    const attached = taxonomies.get(taxonomy);
    if (attached && !attached.includes(owner)) return `la tassonomia ${taxonomy} non è collegata ${owner === "post" ? "agli articoli" : `al tipo ${owner}`}: aggiungi "${owner}" ai suoi types.`;
    if (!Array.isArray(slugs) || slugs.some((item) => typeof item !== "string")) return `i termini di ${taxonomy} sono un elenco di slug, per esempio ["notte"].`;
    if (slugs.length > MAX_TERMS_PER_TAXONOMY) return `${slugs.length} termini di ${taxonomy}: al massimo ${MAX_TERMS_PER_TAXONOMY}.`;
    if (repeats === "refused" && new Set(slugs).size !== slugs.length) return `un termine di ${taxonomy} è ripetuto.`;
    const missing = (slugs as string[]).find((slug) => !writtenTerms.has(`${taxonomy}/${slug}`));
    return missing === undefined ? undefined : `il termine ${shown(taxonomy)}/${shown(missing)} non è dichiarato in terms.`;
  };

  // Records: first their names and states, which relations point to, then each one.
  const recordList = section("records");
  /** Each record declared once, by "type/slug": its type, its index, and whether it is published (unknown with an invalid status). */
  const records = new Map<string, { type: string; index: number; published: boolean | undefined }>();
  const writtenRecords = new Set<string>();
  for (const raw of recordList) if (isObject(raw) && typeof raw.type === "string" && typeof raw.slug === "string") writtenRecords.add(`${raw.type}/${raw.slug}`).add(`${raw.type}/${slugOf(raw.slug)}`);
  const built = new Map<string, number>();
  const productSkus = new Set<string>();
  for (const [index, raw] of recordList.entries()) {
    const label = isObject(raw) && typeof raw.type === "string" && typeof raw.slug === "string" ? `record ${shown(raw.type)}/${shown(raw.slug)}` : `record ${index + 1}`;
    const where = entry("records", index, label);
    if (!isObject(raw)) {
      report({ ...where, message: "un record è un oggetto con type, slug, title e values." });
      continue;
    }
    const { type, slug, status } = raw;
    const declared = typeof type === "string" ? types.get(type) : undefined;
    if (typeof type !== "string" || !writtenTypes.has(type)) report({ ...where, message: `type è la key di un tipo dichiarato${types.size ? `: ${choices(types.keys())}` : ", e il prototipo non ne dichiara"}.` });
    if (typeof slug !== "string" || !slug) report({ ...where, message: "manca slug, l'indirizzo del record (per esempio ehi)." });
    else if (slug.length > 63 || !SLUG.test(slug)) report({ ...where, message: slugMessage(slug, 63, { kind: "record", type: String(type) }) });
    else if (typeof type === "string" && records.has(`${type}/${slug}`)) report({ ...where, message: `il record ${shown(type)}/${slug} è dichiarato due volte: tipo e slug sono unici.` });
    if (!isText(raw.title, 240)) report({ ...where, message: "title: serve un testo di al massimo 240 caratteri." });
    // null is no status, as the import reads it: published. Any other value is its own problem, and nothing is
    // derived from it (Q7): neither its date, nor whether a published record may point to it, nor the build's count.
    const validStatus = status === undefined || status === null || status === "draft" || status === "published" || status === "archived";
    if (!validStatus) report({ ...where, message: `status «${shown(String(status))}»: può essere published, draft o archived.` });
    const published = status === undefined || status === null || status === "published";
    if (published && !isPostPublishedAt(raw.publishedAt)) report({ ...where, message: typeof raw.publishedAt === "string" && UTC_SECOND.test(raw.publishedAt) ? `publishedAt «${raw.publishedAt}» non è una data che esiste.` : "un record pubblicato vuole publishedAt in UTC (AAAA-MM-GGThh:mm:ssZ)." });
    let locale = manifest.locale === undefined ? "" : canonicalLocale(manifest.locale) ?? "";
    // The import reads a locale written as text, and null as none; any other value it drops for the site's language.
    if (typeof raw.locale === "string") {
      const canonical = raw.locale.length >= 2 && raw.locale.length <= 64 ? canonicalLocale(raw.locale) : undefined;
      if (!canonical) report({ ...where, message: `locale «${shown(raw.locale)}» non è una lingua: scrivi un tag BCP 47, per esempio en-GB.` });
      else locale = canonical;
    } else if (raw.locale !== undefined && raw.locale !== null) report({ ...where, message: `locale è il tag di una lingua fra virgolette, per esempio "locale": "en-GB": scritto così il progetto non lo legge, e il record resterebbe nella lingua del sito${locale ? ` (${locale})` : ""}.` });
    const order = droppedNumber(raw.order, 0);
    if (order === "dropped") report({ ...where, message: `order è un numero intero senza virgolette, per esempio "order": 2: scritto così il progetto non lo legge, e il record avrebbe order 0.` });
    else if (order !== undefined) report({ ...where, message: `order «${shown(String(raw.order))}» è scritto come testo e il progetto non lo legge: il record avrebbe order 0. Scrivi il numero senza virgolette: "order": ${order}.` });
    else if (typeof raw.order === "number" && !Number.isSafeInteger(raw.order)) report({ ...where, message: "order è un numero intero." });
    if (raw.excerpt !== undefined && (typeof raw.excerpt !== "string" || raw.excerpt.length > 20_000)) report({ ...where, message: "excerpt: serve un testo di al massimo 20000 caratteri." });
    if (typeof type === "string" && typeof slug === "string" && SLUG.test(slug) && !records.has(`${type}/${slug}`)) records.set(`${type}/${slug}`, { type, index, published: validStatus ? published : undefined });
    // The static build writes at most so many records of a type in a language: past them it would stop, after a valid check.
    const group = `${String(type)}\0${locale}`;
    if (declared && published) built.set(group, (built.get(group) ?? 0) + 1);
    if (declared && published && built.get(group) === MAX_RECORDS_BUILT + 1) report({ ...where, message: `il tipo ${type as string} ha più di ${MAX_RECORDS_BUILT.toLocaleString("it-IT")} record pubblicati${locale ? ` in ${locale}` : ""}: il sito statico ne costruisce al massimo ${MAX_RECORDS_BUILT.toLocaleString("it-IT")} per tipo e lingua. Dividili fra più tipi o lasciane alcuni in bozza.` });
    const recordTerms = raw.terms ?? {};
    if (!isObject(recordTerms) || Object.keys(recordTerms).length > 64) report({ ...where, message: "terms è un oggetto con al massimo 64 tassonomie, per esempio { \"tema\": [\"notte\"] }." });
    else if (typeof type === "string") {
      for (const [taxonomy, slugs] of Object.entries(recordTerms)) {
        const problem = termsIssue(taxonomy, slugs, type, "refused");
        if (problem) report({ ...where, message: `terms: ${problem}` });
      }
    }
    const values = raw.values ?? {};
    if (!isObject(values)) report({ ...where, message: "values è un oggetto, campo per campo." });
    // Without a type known, its fields are not.
    else if (declared) {
      for (const key of Object.keys(values)) if (!declared.written.has(key)) report({ ...where, message: `il campo ${shown(key)} non è del tipo${declared.fields.size ? ` (${choices(declared.fields.keys())})` : ""}.` });
      for (const [key, field] of declared.fields) {
        const problem = valueIssue(field, values[key], Object.hasOwn(values, key), published);
        if (problem) report({ ...where, message: `il campo ${key} ${problem}` });
      }
      if (type === PRODUCT_TYPE_KEY) {
        // What WooCommerce keeps without loss (queue C6): prices, the SKU, plain text.
        for (const problem of productValueIssues({ title: raw.title, excerpt: raw.excerpt ?? "", values })) report({ ...where, message: `prodotto: ${problem}` });
        const sku = productSku(values);
        if (sku !== null && productSkus.has(sku)) report({ ...where, message: `prodotto: sku «${shown(sku)}» è già di un altro prodotto: WooCommerce vuole uno SKU per prodotto.` });
        else if (sku !== null) productSkus.add(sku);
      }
    }
  }
  requiredRelationCircles(recordList, records, types, (index, message) => {
    const raw = recordList[index] as Record<string, unknown>;
    report({ ...entry("records", index, `record ${shown(String(raw.type))}/${shown(String(raw.slug))}`), message });
  });
  /** The problem of one value of a record (bindValue in content-model.ts, the import's assets and relations), or none. */
  function valueIssue(field: Record<string, unknown>, value: unknown, given: boolean, published: boolean): string | undefined {
    const empty = (item: unknown) => item === null || item === undefined || item === "";
    if (field.required === true && (!given || empty(value) || (Array.isArray(value) && value.length === 0))) return "è obbligatorio e manca.";
    if (!given) return undefined;
    if (field.multiple === true ? !Array.isArray(value) : Array.isArray(value)) return field.multiple === true ? "vuole un elenco di valori." : "vuole un valore solo, non un elenco.";
    const items: unknown[] = Array.isArray(value) ? value : [value];
    if (items.length > 1000) return "ha più di 1000 valori.";
    for (const item of items) {
      if (empty(item)) {
        if (field.required === true) return "è obbligatorio e ha un valore vuoto.";
        continue;
      }
      switch (field.type) {
        case "text":
        case "rich-text":
          if (typeof item !== "string" || item.length > 1_000_000) return "vuole un testo, al massimo di 1 MB.";
          break;
        case "integer":
          if (!Number.isSafeInteger(item)) return "vuole un numero intero.";
          break;
        case "decimal":
          if (typeof item !== "number" || !Number.isFinite(item)) return "vuole un numero.";
          break;
        case "boolean":
          if (typeof item !== "boolean") return "vuole true o false.";
          break;
        case "date":
          if (typeof item !== "string" || !isDate(item)) return `vuole una data AAAA-MM-GG che esiste (trovato ${shown(String(item))}).`;
          break;
        case "datetime":
          if (!isDateTime(item)) return `vuole data e ora con il fuso, per esempio 2026-11-07T18:30:00+01:00 (trovato ${shown(String(item))}).`;
          break;
        case "enum":
          if (typeof item !== "string" || !Array.isArray(field.options) || !field.options.includes(item)) return `vale uno fra ${Array.isArray(field.options) ? choices(field.options.filter((option): option is string => typeof option === "string")) : "le sue options"} (trovato ${shown(String(item))}).`;
          break;
        case "url":
          if (typeof item !== "string" || item.length > 2048 || !((item.startsWith("/") && !item.startsWith("//")) || /^https?:\/\//iu.test(item))) return `vuole un indirizzo http(s) o un percorso del sito che comincia con / (trovato ${shown(String(item))}).`;
          break;
        case "asset":
          if (typeof item !== "string" || !item.startsWith("asset:")) return "vuole asset:<nome>.";
          if (!context.assetIds.has(item.slice("asset:".length))) return `usa ${shown(item)}, che non è fra i media dichiarati.`;
          break;
        case "relation": {
          const target = typeof item === "string" ? records.get(item) : undefined;
          if (typeof item !== "string" || !writtenRecords.has(item)) return "vuole \"<tipo>/<slug>\" di un record dichiarato.";
          if (target && target.type !== field.targetType) return `collega ${shown(item)}, che non è un record di ${String(field.targetType)}.`;
          if (target && published && target.published === false) return `collega ${shown(item)}, che non è pubblicato: un record pubblicato collega solo record pubblicati.`;
          break;
        }
      }
    }
    return undefined;
  }

  // Queries.
  const queryKeys = new Set<string>();
  const queryList = section("queries");
  if (queryList.length > MAX_QUERIES) report({ document: "contenuti", ...at(places?.queries[MAX_QUERIES]), message: `${queryList.length} query: il trasferimento ne porta al massimo ${MAX_QUERIES}.` });
  for (const [index, raw] of queryList.entries()) {
    const where = entry("queries", index, named("query", isObject(raw) ? raw.key : undefined, index));
    if (!isObject(raw)) {
      report({ ...where, message: "una query è un oggetto con key, label e type." });
      continue;
    }
    const { key, type } = raw;
    if (typeof key !== "string" || !key) report({ ...where, message: "manca key, il nome con cui la usa un loop (per esempio opere_recenti, per {#loop opere_recenti() as opera})." });
    else if (!QUERY_KEY.test(key)) report({ ...where, message: `la chiave «${shown(key)}» non va bene per una query: comincia con una lettera o «_» e prosegue con lettere, cifre o «_», senza trattini, al massimo 64 caratteri${QUERY_KEY.test(key.replaceAll("-", "_")) ? ` (qui: ${key.replaceAll("-", "_")})` : " (per esempio opere_recenti)"}.` });
    else if (RESERVED_QUERY_KEYS.has(key)) report({ ...where, message: `«${key}» è un nome riservato di Histeon (posts, terms, main e users): scegline un altro.` });
    else if (queryKeys.has(key)) report({ ...where, message: `la query «${key}» è dichiarata due volte.` });
    else queryKeys.add(key);
    if (!isText(raw.label, 120)) report({ ...where, message: "label: serve un testo di al massimo 120 caratteri." });
    const posts = type === "post";
    const declared = typeof type === "string" ? types.get(type) : undefined;
    if (typeof type !== "string" || (!posts && !writtenTypes.has(type))) report({ ...where, message: `type è la key di un tipo dichiarato${types.size ? ` (${choices(types.keys())})` : ""}, o post per gli articoli.` });
    // The import reads limit, offset, order and orderBy only when written as the store takes them, and null as none;
    // any other value it drops for the default (Q5). Refused where that changes the query, with how to write it.
    const numberField = (name: "limit" | "offset", min: number, max: number, fallback: number, effect: string) => {
      const value = raw[name];
      const range = `${name} è un numero intero da ${min} a ${max.toLocaleString("it-IT")}`;
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < min || value > max) report({ ...where, message: `${range}.` });
        return;
      }
      const dropped = droppedNumber(value, fallback);
      if (dropped === undefined) return;
      if (dropped === "dropped" || !Number.isSafeInteger(dropped) || dropped < min || dropped > max) report({ ...where, message: `${range}, senza virgolette, per esempio "${name}": 6: scritto così il progetto non lo legge, e ${effect}.` });
      else report({ ...where, message: `${name} «${shown(String(value))}» è scritto come testo e il progetto non lo legge: ${effect}. Scrivi il numero senza virgolette: "${name}": ${dropped}.` });
    };
    numberField("limit", 1, 100, 10, "la query mostrerebbe 10 voci");
    numberField("offset", 0, 1_000_000, 0, "la query partirebbe dalla prima voce");
    const order = raw.order;
    if (order !== undefined && order !== null && order !== "asc" && order !== "desc") {
      // "ASC" changes nothing: ascending is what the query does without an order.
      const read = typeof order === "string" ? order.trim().toLowerCase() : "";
      if (read === "desc") report({ ...where, message: `order «${shown(String(order))}» non conta: si scrive in minuscolo, "order": "desc"; scritto così la query ordinerebbe dal primo all'ultimo, come con "asc".` });
      else if (read !== "asc") report({ ...where, message: `order può essere "asc" (dal primo all'ultimo, il predefinito) o "desc" (dall'ultimo al primo), in minuscolo: «${shown(String(order))}» il progetto non lo legge, e la query ordinerebbe come con "asc".` });
    }
    const orderBy = raw.orderBy;
    if (orderBy !== undefined && orderBy !== null && typeof orderBy !== "string") report({ ...where, message: `orderBy è il nome di un dato o di un campo fra virgolette, per esempio "orderBy": "title": scritto così il progetto non lo legge, e la query ordinerebbe per order.` });
    else if (typeof orderBy === "string" && (posts || declared)) {
      const field = declared ? declared.fields.get(orderBy) : undefined;
      const orders = posts ? POST_ORDERS : RECORD_ORDERS;
      // Doc 23 item 232: a field with more values has no first one WordPress could sort by, so it orders nothing.
      const sortable = field && field.public === true && field.multiple !== true && !["relation", "asset", "rich-text"].includes(String(field.type));
      if (!orders.has(orderBy) && !sortable) report({ ...where, message: `orderBy «${shown(orderBy)}» non ordina ${posts ? "gli articoli" : "questi record"}: ${[...orders].join(", ")}${posts ? "" : ", o un campo pubblico del tipo con un solo valore che non sia relation, asset o rich-text"}.` });
    }
    // null is no filter, for the import and the store.
    if (raw.filter !== undefined && raw.filter !== null && (posts || declared)) {
      const problem = filterIssue(raw.filter, posts ? "post" : type as string, 0);
      if (problem) report({ ...where, message: `filter: ${problem}` });
    }
  }
  /** The problem of a query's filter that the import maps (taxonomies and terms) and the store compiles, or none; a field filter is the store's. */
  function filterIssue(filter: unknown, owner: string, depth: number): string | undefined {
    if (depth > 4) return "i filtri annidati arrivano al massimo a quattro livelli.";
    if (depth === 0 && cmsFilterLeaves(filter) > CMS_MAX_FILTER_LEAVES) return `un filtro ha al massimo ${CMS_MAX_FILTER_LEAVES} condizioni in tutto, contando quelle di ogni gruppo.`;
    if (!isObject(filter)) return "un filtro è un oggetto, per esempio { \"taxonomyKey\": \"tema\", \"terms\": [\"notte\"], \"operator\": \"IN\" }.";
    if ("and" in filter || "or" in filter) {
      const list = "and" in filter ? filter.and : filter.or;
      if (!Array.isArray(list) || list.length < 1 || list.length > 32) return "un gruppo and o or ha da 1 a 32 condizioni.";
      for (const item of list) {
        const problem = filterIssue(item, owner, depth + 1);
        if (problem) return problem;
      }
      return undefined;
    }
    if (!("taxonomyKey" in filter)) return owner === "post" ? "gli articoli si filtrano solo per tassonomia: { \"taxonomyKey\": \"category\", \"terms\": [\"…\"], \"operator\": \"IN\" }." : undefined;
    if (typeof filter.taxonomyKey !== "string") return "taxonomyKey è la key di una tassonomia.";
    if (!Array.isArray(filter.terms) || filter.terms.length < 1) return `terms elenca da 1 a ${MAX_TERMS_PER_TAXONOMY} slug di termini di ${shown(filter.taxonomyKey)}.`;
    const problem = termsIssue(filter.taxonomyKey, filter.terms, owner, "allowed");
    if (problem) return problem;
    if (filter.operator !== "IN" && filter.operator !== "NOT IN" && filter.operator !== "AND") return "operator può essere IN, NOT IN o AND.";
    return undefined;
  }

  // Pages and posts: their slug, title, state, date, terms and template. A repeated slug is the build's to say.
  for (const item of prototype.documents) {
    if (item.kind !== "page" && item.kind !== "post") continue;
    const document = documentName(item);
    const place = (attribute: string) => ({ document, line: item.line, ...at(item.places?.[attribute]) });
    const max = item.kind === "post" ? 200 : 63;
    const slug = item.attributes["data-slug"];
    if (!slug?.trim()) report({ ...place("data-slug"), message: `manca data-slug, l'indirizzo ${item.kind === "post" ? "dell'articolo (per esempio un-antico-sogno)" : "della pagina (per esempio chi-siamo)"}.` });
    else if (slug.length > max || !SLUG.test(slug)) report({ ...place("data-slug"), message: slugMessage(slug, max) });
    if (!isText(item.attributes["data-title"], 500)) report({ ...place("data-title"), message: "data-title: serve un testo di al massimo 500 caratteri." });
    const status = item.attributes["data-status"];
    if (status !== undefined && status !== "draft" && status !== "published") report({ ...place("data-status"), message: "data-status può essere draft o published." });
    const template = item.attributes["data-template"];
    if (template !== undefined && !writtenTemplates.has(template)) report({ ...place("data-template"), message: `data-template="${shown(template)}" ${notATemplate()}` });
    if (item.kind !== "post") continue;
    const publishedAt = item.attributes["data-published-at"];
    if (status !== "draft" && !isPostPublishedAt(publishedAt)) report({ ...place("data-published-at"), message: publishedAt !== undefined && UTC_SECOND.test(publishedAt) ? `data-published-at «${publishedAt}» non è una data che esiste.` : "un articolo pubblicato vuole data-published-at in UTC (AAAA-MM-GGThh:mm:ssZ)." });
    const excerpt = item.attributes["data-excerpt"];
    if (excerpt !== undefined && excerpt.length > 20_000) report({ ...place("data-excerpt"), message: "data-excerpt: serve un testo di al massimo 20000 caratteri." });
    const image = item.attributes["data-image"];
    if (image !== undefined) {
      const name = /^asset:([a-z0-9][a-z0-9-]{0,62})$/u.exec(image)?.[1];
      if (!name) report({ ...place("data-image"), message: `data-image vuole asset:<nome> di un'immagine dichiarata (trovato ${shown(image)}).` });
      else if (!context.assetIds.has(name)) report({ ...place("data-image"), message: `data-image usa asset:${name}, che non è fra i media dichiarati.` });
    }
    const written = item.attributes["data-terms"];
    if (written === undefined) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(written); } catch { parsed = undefined; }
    if (!isObject(parsed) || Object.keys(parsed).length > 64) {
      report({ ...place("data-terms"), message: "data-terms è un oggetto JSON con al massimo 64 tassonomie, per esempio data-terms='{\"category\":[\"racconti\"]}'." });
      continue;
    }
    for (const [taxonomy, slugs] of Object.entries(parsed)) {
      const problem = termsIssue(taxonomy, slugs, "post", "refused");
      if (problem) report({ ...place("data-terms"), message: `data-terms: ${problem}` });
    }
  }
}

/**
 * Builds the project from a parsed prototype in `catalog` (a temporary one) and exports it as a transfer profile.
 * The temporary catalog is the caller's to delete.
 */
export async function buildPrototypeProfile(
  prototype: ParsedPrototype,
  catalog: Pick<CmsProjectCatalog, "createProject">,
  options: PrototypeImportOptions = {},
): Promise<{ profile: StaticPageProfile; files: Map<string, Buffer>; report: PrototypeReport; imageCandidates: PrototypeImageCandidate[]; shop?: CmsShopSettings; strict?: StrictProblem[] }> {
  const { manifest } = prototype;
  const projectId = manifest.id;
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  // What documents may call, as the build will declare it (refs trimmed as the build trims them): a document is read
  // against these before any is created (E4).
  const reusable = new Map(prototype.documents.filter((item) => item.kind === "component" || item.kind === "part" || item.kind === "template").map((item) => [item.attributes["data-ref"]?.trim() ?? "", item.kind]));
  // A data-ref outside the grammar is refused at its own place (declarationIssues). A tag calls it by the name its fix
  // would give it (<Site.Header /> for "Site/Header"): that call is not a second problem.
  for (const [ref, kind] of [...reusable]) {
    const fixed = COMPONENT_REF_PATTERN.test(ref) ? undefined : suggestedRef(ref);
    if (fixed && !reusable.has(fixed)) reusable.set(fixed, kind);
  }
  const declaredQueries = Array.isArray(prototype.content.queries) ? prototype.content.queries : [];
  const queryKeys = new Set(declaredQueries.flatMap((query: unknown) => (query && typeof query === "object" && typeof (query as { key?: unknown }).key === "string" ? [(query as { key: string }).key] : [])));
  const context: BuildContext = { projectId, assetIds: new Map(prototype.assets.map((asset) => [asset.name, stableId(projectId, "asset", asset.name)])), usedAssets: new Set(), assetSizes: new Map(), assetTypes: new Map(), unsizedImages: [], variantImages: new Map(), forms: [], names: emptyFrameworkNames(), issues: [], unlisted: 0, reusable, queryKeys, labels: new Map(), expressions: expressionDeclarations(prototype, reusable), slots: new Map(), pendingCalls: [] };
  // Where {#loop main()} has no archive to list: a template a page, a post or a type's records render with.
  context.singularTemplateUses = singularTemplateUses(prototype);
  context.archiveTemplateRefs = new Set((Array.isArray(prototype.content.types) ? prototype.content.types : []).flatMap((type: unknown) => (type && typeof type === "object" && typeof (type as { archiveTemplate?: unknown }).archiveTemplate === "string" ? [(type as { archiveTemplate: string }).archiveTemplate] : [])));
  // Every entity is named in a message as the file names it (E4); media first, the rest as they are created.
  for (const [name, id] of context.assetIds) context.labels.set(id, `asset:${name}`);
  // C1: what the prototype defines itself keeps its ACSS name, so the conversion knows it before the first document.
  // Any `--name:` in a document counts (a style attribute defines it there), and so does every class with a rule.
  const converting = manifest.framework === "acss" && manifest.acss !== "keep";
  if (prototype.warnings) warnings.push(...prototype.warnings);
  // Doc 28: the site's variables of the manifest have a value: a `var(--xb-site-…)` that reads one is not «senza valore».
  // An invalid object is refused below, where the styles are saved, with its message.
  if (manifest.siteTokens) for (const name of Object.keys(manifest.siteTokens)) context.names.definedVariables.add(`${SITE_TOKEN_PREFIX}${name}`);
  for (const sheet of prototype.globals) {
    // A sheet past the parse bounds is read without parsing it, as one postcss cannot read (parsePrototype).
    collectCssNames(context.names, sheet.css, `foglio ${sheet.name}`, undefined, sheet.unparsed?.reason);
    if (sheet.unparsed) warnings.push(`${sheet.unparsed.message} Il foglio entra nel progetto così com'è, ma l'import non ne legge le regole.`);
  }
  // The selector styles of a prototype to convert are parsed only once converted, and measured exactly before: as
  // written they may be up to twice the limit (parsePrototype's margin), and so would their parse. The conversion changes
  // references alone, never a selector or a definition, so the names read from the converted sheet are those of the
  // sheet as written; its definitions, which the conversion needs first, are read without parsing.
  if (prototype.selectors && converting) collectCssDefinitions(context.names, prototype.selectors);
  else if (prototype.selectors) collectCssNames(context.names, prototype.selectors, "stili per selettore");
  if (converting) {
    const defined = new Set(context.names.definedVariables);
    for (const item of prototype.documents) definedVariablesIn(item.source, defined);
    if (prototype.selectors) {
      // The conversions are counted once, with the styles: here the sheet is only read. The global sheets are not
      // converted yet, so half of them counts.
      const selectors = convertAcssVariables(prototype.selectors, defined, new Map());
      if (selectorsWeight(selectors) + prototype.globals.reduce((sum, sheet) => sum + sheet.css.length, 0) / 2 > STYLES_DOCUMENT_MAX) fail(STYLES_TOO_LARGE);
      collectCssNames(context.names, selectors, "stili per selettore");
    }
    context.convert = { defined, ruleClasses: new Set(context.names.ruleClasses), conversions: new Map() };
  }
  // References are read again from the CSS as converted, with the styles.
  context.names.variables.clear();

  /**
   * Before each document of a loop over them: every YIELD_EVERY documents (with the progress, when the loop reports it)
   * and once YIELD_SOURCE characters of templates were read since the last time, the server answers (progress,
   * cancellation, other requests). A few large documents block it no longer than many small ones.
   */
  let unyielded = 0;
  const pace = async (index: number, item: PrototypeDocument, progress?: () => void): Promise<void> => {
    const every = (index + 1) % YIELD_EVERY === 0;
    if (every) progress?.();
    if (every || unyielded >= YIELD_SOURCE) {
      unyielded = 0;
      await yieldToServer();
      options.signal?.throwIfAborted();
    }
    unyielded += item.source.length;
  };

  // The values of the prototype (A7), before anything is downloaded or saved. With any problem nothing is created: the
  // documents are still read for their own problems, so that the list is the whole one (E4).
  // Each document is read as the site renders it as the import parses it, between the yields of its loop: for D4's
  // warnings and the renderer's limits of nesting (PrototypeQuality), never parsed a second time.
  const quality = new PrototypeQuality({ ...(manifest.locale ? { locale: manifest.locale } : {}), documents: prototype.documents, content: prototype.content });
  context.quality = quality;
  if (options.strict) context.strict = new PrototypeStrict({ content: prototype.content, documents: prototype.documents, ...(prototype.places?.content ? { places: { records: prototype.places.content.records } } : {}) });
  declarationIssues(prototype, context);
  if (context.issues.length) {
    for (const [index, item] of prototype.documents.entries()) {
      await pace(index, item, () => options.onProgress?.({ phase: "documents", done: index + 1, total: prototype.documents.length }));
      documentContent(item, context, []);
    }
    pendingCallIssues(context);
    failAll(context);
  }

  // Media first: documents and styles point to them.
  const media = new Map<string, { bytes: Uint8Array; mimeType: PrototypeMediaType }>();
  let total = 0;
  let downloaded = 0;
  const placeholders: string[] = [];
  let images: ReturnType<typeof variantImagesReport> | undefined;
  let strictProblems: StrictProblem[] | undefined;
  /** A problem of one media, at its entry in the media part. */
  const entries = new Map(prototype.assets.map((asset, index) => [asset.name, prototype.places?.assets?.[index]]));
  const mediaIssue = (name: string, message: string): PrototypeIssue => ({ document: "assets", ...at(entries.get(name)), message });
  // Media the app kept from a site it converted: read from its folder, checked against their hash, never downloaded.
  const kept = new Map<string, Uint8Array>();
  const keptIssues: PrototypeIssue[] = [];
  for (const asset of prototype.assets) {
    const hash = asset.url ? convertedMediaHash(asset.url) : null;
    if (hash === null) continue;
    const bytes = options.convertedMedia?.(hash) ?? null;
    if (bytes && createHash("sha256").update(bytes).digest("hex") === hash) kept.set(asset.name, bytes);
    else keptIssues.push(mediaIssue(asset.name, `Media ${asset.name}: veniva da un sito convertito in Histeon Publish e non c'è più: converti di nuovo il sito.`));
  }
  if (keptIssues.length) throw allIssuesError(keptIssues);
  const remote = prototype.assets.filter((asset) => !asset.data && !kept.has(asset.name) && !(!options.fetchAsset && options.remotePlaceholders));
  if (remote.length && !options.fetchAsset) throw allIssuesError(remote.map((asset) => mediaIssue(asset.name, `Media ${asset.name}: è remoto e lo scaricamento delle immagini remote non è attivo.`)));
  // D3: remote media DOWNLOADS_AT_ONCE at a time; the first failure stops the others and the import.
  const fetched = new Map<string, Uint8Array>();
  if (remote.length && options.fetchAsset) {
    // A signal already aborted never fires its event: nothing is downloaded.
    options.signal?.throwIfAborted();
    const fetchAsset = options.fetchAsset;
    const controller = new AbortController();
    const stop = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", stop, { once: true });
    let next = 0;
    // The limits hold while downloading: memory never holds more than they allow (inline media are within the file's 32 MB).
    let fetchedBytes = 0;
    let failure: PrototypeIssue | null = null;
    const worker = async (): Promise<void> => {
      while (failure === null && next < remote.length && !controller.signal.aborted) {
        const asset = remote[next++] as PrototypeAssetDeclaration;
        try {
          const bytes = await fetchAsset(asset.url as string, MAX_ASSET_BYTES, controller.signal);
          if (bytes.length > MAX_ASSET_BYTES) throw new RangeError(`Media ${asset.name}: supera 15 MB.`);
          fetchedBytes += bytes.length;
          if (fetchedBytes > MAX_TOTAL_ASSET_BYTES) {
            // All of them, not this one.
            failure ??= { message: "I media del prototipo superano 200 MB in tutto." };
            controller.abort();
            return;
          }
          fetched.set(asset.name, bytes);
          options.onProgress?.({ phase: "media", done: fetched.size, total: remote.length });
        } catch (error) {
          failure ??= mediaIssue(asset.name, error instanceof RangeError ? error.message : `Media ${asset.name}: non scaricato (${error instanceof Error ? error.message : "errore di rete"}).`);
          controller.abort();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, remote.length) }, worker));
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
    // A cancellation is not a broken prototype.
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Import annullato.");
    const failed = failure as PrototypeIssue | null;
    if (failed) throw allIssuesError([failed]);
  }
  // Every media's own problem, at its entry; past 200 MB in all, the check stops there.
  const mediaIssues: PrototypeIssue[] = [];
  for (const asset of prototype.assets) {
    options.signal?.throwIfAborted();
    let bytes: Uint8Array;
    if (asset.data) bytes = decodeDataUri(asset.data);
    else if (kept.has(asset.name)) bytes = kept.get(asset.name) as Uint8Array;
    else if (!options.fetchAsset && options.remotePlaceholders) {
      bytes = PLACEHOLDER_PNG;
      placeholders.push(asset.name);
    } else {
      bytes = fetched.get(asset.name) as Uint8Array;
      downloaded++;
    }
    if (!bytes.length) {
      // Each source its own words: a placeholder is never empty, a download may be (a 200 with no body).
      mediaIssues.push(mediaIssue(asset.name, asset.data ? `Media ${asset.name}: data URI vuoto.` : `Media ${asset.name}: il download non ha dato byte.`));
      continue;
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      mediaIssues.push(mediaIssue(asset.name, `Media ${asset.name}: supera 15 MB.`));
      continue;
    }
    total += bytes.length;
    if (total > MAX_TOTAL_ASSET_BYTES) {
      mediaIssues.push({ message: "I media del prototipo superano 200 MB in tutto." });
      break;
    }
    const mimeType = sniffPrototypeMedia(bytes);
    if (!mimeType) {
      mediaIssues.push(mediaIssue(asset.name, `Media ${asset.name}: non è PNG, JPEG, GIF, WebP, AVIF, WOFF o WOFF2 (SVG non è ammesso).`));
      continue;
    }
    // Doc 23 item 241: an image whose bytes cannot be whole, named, before the build's decoder fails on it nameless.
    const broken = IMAGE_TYPES.has(mimeType) && bytes !== PLACEHOLDER_PNG ? imageIntegrityProblem(bytes) : null;
    if (broken) {
      mediaIssues.push(mediaIssue(asset.name, `Media ${asset.name}: non è un'immagine leggibile (${broken}). Usa il file vero, o togli il media e quello che lo usa: non scrivere mai a mano o a memoria i dati base64 di un'immagine.`));
      continue;
    }
    context.assetTypes.set(asset.name, mimeType);
    // A placeholder's 1×1 is not the image's size.
    if (IMAGE_TYPES.has(mimeType) && bytes !== PLACEHOLDER_PNG) {
      const measured = imageSize(bytes);
      if (measured) context.assetSizes.set(asset.name, measured);
    }
    media.set(asset.name, { bytes, mimeType });
  }
  if (mediaIssues.length) throw allIssuesError(mediaIssues);

  const pageDocuments = prototype.documents.filter((item) => item.kind === "page");
  const home = pageDocuments.find((item) => item.attributes["data-slug"] === "home")!;
  const homeContent = documentContent(home, context, warnings);
  context.labels.set(stableId(projectId, "page", "home"), "page home");
  // Its title and status were checked with every other page's (declarationIssues): never a published home by mistake.
  const homeTitle = text(home.attributes["data-title"], "data-title", 500);
  const homeStatus = home.attributes["data-status"];
  const contentPlaces = prototype.places?.content;
  /**
   * What the store still refuses in one value of the content or in a page, with its place in the file (E4): a rule that
   * declarationIssues does not repeat (a field filter of a query, say) never comes as a bare message of the store.
   */
  const placed = <T>(document: string, place: { line?: number; column?: number } | undefined, save: () => T): T => {
    try {
      return save();
    } catch (error) {
      if (error instanceof PrototypeError || !(error instanceof TypeError || error instanceof RangeError)) throw error;
      const issue = { document, ...place, message: error.message };
      throw new PrototypeError(formatPrototypeIssue(issue), [issue]);
    }
  };
  let opened: CmsProjectStore | undefined;
  try {
    const { project, store } = await catalog.createProject(manifest.name, {
      id: projectId,
      page: { id: stableId(projectId, "page", "home"), title: homeTitle, slug: "home", content: homeContent ?? "", status: homeStatus === "draft" ? "draft" : "published" },
      styles: { id: stableId(projectId, "styles", "styles"), content: JSON.stringify({ styles: [], globals: [], compiledCss: "" }) },
    });
    opened = store;
    // One transaction for the whole project (queue D3): thousands of pages and records, not one commit each.
    await store.atomic(async () => {
      if (manifest.locale || manifest.timeZone) {
        const current = store.getRenderSettings();
        placed("manifest", prototype.places?.manifest, () => store.setRenderSettings({ locale: manifest.locale ?? current.locale, timeZone: manifest.timeZone ?? current.timeZone }));
      }
      if (manifest.shop !== undefined) placed("manifest", prototype.places?.manifest, () => store.setShopSettings(manifest.shop));
      for (const asset of prototype.assets) {
        const item = media.get(asset.name)!;
        store.saveAsset({ id: context.assetIds.get(asset.name)!, bytes: item.bytes, mimeType: item.mimeType, filename: `${asset.name}.${EXTENSIONS[item.mimeType]}`, alt: asset.alt, caption: asset.caption });
        count("media");
      }

      // Components, parts and templates exist before anything uses them; their content follows once all exist.
      const reusable = prototype.documents.filter((item) => item.kind === "component" || item.kind === "part" || item.kind === "template");
      const refs = new Set<string>();
      /** The templates a page or a post may name in data-template. */
      const templates = new Set<string>();
      const roles = new Set<string>();
      const created: Array<{ item: PrototypeDocument; id: string }> = [];
      for (const [index, item] of reusable.entries()) {
        // Creating thousands of them takes a while too: the server answers (cancellation, other requests) every so many.
        if ((index + 1) % YIELD_EVERY === 0) {
          await yieldToServer();
          options.signal?.throwIfAborted();
        }
        const ref = text(item.attributes["data-ref"], `${item.label}: data-ref`, 128).trim();
        if (refs.has(ref)) fail(`${item.label}: data-ref ripetuto.`);
        refs.add(ref);
        const title = text(item.attributes["data-title"] ?? ref, `${item.label}: data-title`, 160);
        const id = stableId(projectId, item.kind, ref);
        context.labels.set(id, `${item.kind} ${ref}`);
        if (item.kind === "template") {
          templates.add(ref);
          store.createTemplate({ id, ref, title });
        }
        else if (item.kind === "part") {
          const area = item.attributes["data-area"] ?? "uncategorized";
          if (!["header", "footer", "uncategorized"].includes(area)) fail(`${item.label}: data-area può essere header, footer o uncategorized.`);
          store.createTemplatePart({ id, ref, title, area: area as "header" | "footer" | "uncategorized" });
        } else store.createComponent({ id, ref, title });
        created.push({ item, id });
      }
      for (const [index, { item, id }] of created.entries()) {
        await pace(index, item);
        const component = store.getComponentById(id)!;
        const schema = item.attributes["data-props"] !== undefined ? { props: plainObject(jsonPart(item.attributes["data-props"], `${item.label}: data-props`), `${item.label}: data-props`) } : component.schema;
        // With problems the document keeps the content it was created with (a page template its {@slot}) and still
        // gets its props: what the store would then refuse is a consequence, not a problem of the file (E4).
        const content = documentContent(item, context, warnings) ?? component.content;
        try {
          const saved = store.saveComponent({ alias: component.alias, expectedHead: component.headRevision, content, ref: component.ref, schema });
          if (saved.status !== "saved") fail(`${item.label}: salvataggio in conflitto.`);
        } catch (error) {
          // What the store refuses in a document (its props, a missing {@slot}, a part it names) is that document's
          // problem, with its place: the save is undone (a savepoint) and the reading goes on.
          if (error instanceof PrototypeError || !(error instanceof TypeError || error instanceof RangeError)) throw error;
          context.issues.push({ document: documentName(item), line: item.line, message: error.message });
        }
        const role = item.attributes["data-role"];
        if (item.kind === "template" && role !== undefined) {
          if (!(TEMPLATE_ROLES as readonly string[]).includes(role) || roles.has(role)) fail(`${item.label}: ruolo non valido o già usato (${role}).`);
          roles.add(role);
          store.setTemplateRole(id, role as TemplateRole);
        } else if (role !== undefined) fail(`${item.label}: data-role vale solo per i template.`);
        count(item.kind === "part" ? "parts" : `${item.kind}s`);
      }

      // Styles and design. An ACSS prototype's variables take their Histeon CSS names first (C1).
      const converted = (css: string, where: string, unparsed?: string) => {
        const out = context.convert ? convertAcssVariables(css, context.convert.defined, context.convert.conversions) : css;
        collectCssNames(context.names, out, where, undefined, unparsed);
        return out;
      };
      const sheetsCss = prototype.globals.map((sheet) => converted(sheet.css, `foglio ${sheet.name}`, sheet.unparsed?.reason));
      const selectorsCss = prototype.selectors ? converted(prototype.selectors, "stili per selettore") : "";
      // The rules of each block the content uses go into the block's selector, nested as SCSS, as the editor's «Nei
      // selettori» does (selector-port.ts): one place to read and edit each block, the cascade unchanged. A sheet that
      // could not be parsed, or a result past the transfer's limits, leaves the CSS as written; the button stays.
      // F1: the strict check reads the selector styles as written from the first parse of them, the port's or the styles'.
      const strict = context.strict;
      const readSelectors = strict ? (root: ReturnType<typeof postcss.parse>) => strict.selectors(root, prototype.sheetLines?.selectors ?? 0) : undefined;
      const candidate = prototype.globals.some((sheet) => sheet.unparsed) ? null : portToSelectors(sheetsCss, selectorsCss, new Set(context.names.classes.keys()), readSelectors);
      const port = candidate && candidate.entries <= TRANSFER_STYLES_MAX && candidate.longest <= TRANSFER_CSS_MAX / 2 ? candidate : null;
      const globals = prototype.globals.map((sheet, index) => {
        const resolved = cssWithAssets(port?.sheets[index] ?? sheetsCss[index]!, context, `Foglio ${sheet.name}`);
        // The transfer format takes at most 1 MB of CSS per sheet and per selector.
        if (codePoints(resolved.css) > TRANSFER_CSS_MAX) fail(`Il foglio globale «${sheet.name}» supera 1 MB di CSS: dividilo in più fogli.`);
        const id = stableId(projectId, "global", `${index}`);
        context.labels.set(id, `foglio ${sheet.name}`);
        return { id, css: resolved.css, ...(resolved.assets.length ? { assets: resolved.assets } : {}) };
      });
      const selectorsText = port?.selectors ?? selectorsCss;
      const styles = selectorsText.trim() ? selectorStyles(selectorsText, context, port ? undefined : readSelectors) : [];
      for (const style of styles) if (codePoints(style.css) > TRANSFER_CSS_MAX) fail(`Lo stile di ${style.selector.slice(0, 120)} supera 1 MB di CSS.`);
      let design: ReturnType<typeof changedHistosDesign> | undefined;
      try {
        design = manifest.design ? changedHistosDesign(validateHistosDesign(manifest.design)) : undefined;
      } catch (error) {
        // Said where it is: the manifest's design, whose parameters are those of §12 of the manual.
        if (error instanceof TypeError) fail(`Manifest, design: ${error.message.replace(/\.$/u, "")}${/^Parametro sconosciuto/u.test(error.message) ? " (i parametri ammessi sono nel §12 del manuale)" : ""}.`);
        throw error;
      }
      let siteTokens: Record<string, string> = {};
      try {
        siteTokens = validateSiteTokens(manifest.siteTokens ?? {});
      } catch (error) {
        if (error instanceof TypeError) fail(`Manifest, siteTokens: ${error.message.replace(/\.$/u, "")}.`);
        throw error;
      }
      const siteTokensPart = Object.keys(siteTokens).length ? { siteTokens } : {};
      // Measured as the import of the transfer stores it (design, token overrides and queries always written), the
      // longer of the two, and said by name: never as the store's bare limit of a document.
      const keptBytes = Buffer.byteLength(JSON.stringify({ styles, globals, compiledCss: "", design: design ?? {}, tokenOverrides: {}, ...siteTokensPart, queries: {} }), "utf8");
      if (keptBytes > STYLES_DOCUMENT_MAX) fail(STYLES_TOO_LARGE.replace("8 MiB di CSS:", `8 MiB (${(keptBytes / 1024 / 1024).toFixed(2).replace(".", ",")} MiB come il progetto li salva):`));
      const stylesEntity = store.getStyles()!;
      const stylesHead = store.getHead(stylesEntity.id)!;
      const savedStyles = store.saveDocument({ entityId: stylesEntity.id, expectedHead: stylesHead.id, content: JSON.stringify({ styles, globals, compiledCss: "", ...(design && Object.keys(design).length ? { design } : {}), ...siteTokensPart }) });
      if (savedStyles.status !== "saved") fail("Gli stili non sono stati salvati.");
      counts.styles = styles.length;
      counts.globals = globals.length;
      if (port) counts.selectorRules = port.rules;

      // Content model.
      const content = prototype.content;
      const types = Array.isArray(content.types) ? content.types : content.types === undefined ? [] : fail("Contenuti: types deve essere un elenco.");
      for (const [index, raw] of types.entries()) {
        const type = plainObject(raw, "Tipo di contenuto");
        const key = text(type.key, "Tipo: key", 63);
        context.labels.set(stableId(projectId, "type", key), `tipo ${key}`);
        const saved = placed(`tipo ${key}`, contentPlaces?.types[index], () => store.content.saveType({
          // The product type's fields are the shop's own (queue C6): the prototype does not write them.
          id: stableId(projectId, "type", key), key, label: text(type.label, `Tipo ${key}: label`, 120), fields: key === PRODUCT_TYPE_KEY ? productFields() : type.fields ?? [],
          singleTemplateRef: typeof type.singleTemplate === "string" ? type.singleTemplate : null,
          archiveTemplateRef: typeof type.archiveTemplate === "string" ? type.archiveTemplate : null,
          // Doc 23 item 122: `"public": false` for a type shown only by loops, with no pages of its own.
          ...(type.public === false ? { public: false } : {}),
          expectedHead: null,
        }));
        if (saved.status !== "saved") fail(`Tipo ${key}: non salvato.`);
        count("types");
      }
      const taxonomies = Array.isArray(content.taxonomies) ? content.taxonomies : content.taxonomies === undefined ? [] : fail("Contenuti: taxonomies deve essere un elenco.");
      for (const [index, raw] of taxonomies.entries()) {
        const taxonomy = plainObject(raw, "Tassonomia");
        const key = text(taxonomy.key, "Tassonomia: key", 63);
        context.labels.set(stableId(projectId, "taxonomy", key), `tassonomia ${key}`);
        const saved = placed(`tassonomia ${key}`, contentPlaces?.taxonomies[index], () => store.content.saveTaxonomy({ id: stableId(projectId, "taxonomy", key), key, label: text(taxonomy.label, `Tassonomia ${key}: label`, 120), types: taxonomy.types ?? [], expectedHead: null }));
        if (saved.status !== "saved") fail(`Tassonomia ${key}: non salvata.`);
        count("taxonomies");
      }
      const termIds = new Map<string, string>();
      const terms = Array.isArray(content.terms) ? content.terms : content.terms === undefined ? [] : fail("Contenuti: terms deve essere un elenco.");
      // Parents before children, in as many passes as the hierarchy is deep.
      let waiting = terms.map((raw, index) => ({ term: plainObject(raw, "Termine"), index }));
      for (let pass = 0; waiting.length && pass <= terms.length; pass++) {
        const next: typeof waiting = [];
        for (const { term, index } of waiting) {
          const taxonomy = text(term.taxonomy, "Termine: taxonomy", 63);
          const slug = text(term.slug, `Termine di ${taxonomy}: slug`, 63);
          const parent = term.parent === undefined || term.parent === null ? null : text(term.parent, `Termine ${taxonomy}/${slug}: parent`, 63);
          if (parent !== null && !termIds.has(`${taxonomy}/${parent}`)) { next.push({ term, index }); continue; }
          const id = stableId(projectId, "term", `${taxonomy}/${slug}`);
          context.labels.set(id, `termine ${taxonomy}/${slug}`);
          const saved = placed(`termine ${taxonomy}/${slug}`, contentPlaces?.terms[index], () => store.content.saveTerm({ id, taxonomyKey: taxonomy, slug, label: text(term.label, `Termine ${taxonomy}/${slug}: label`, 120), parentId: parent === null ? null : termIds.get(`${taxonomy}/${parent}`)!, expectedHead: null }));
          if (saved.status !== "saved") fail(`Termine ${taxonomy}/${slug}: non salvato.`);
          termIds.set(`${taxonomy}/${slug}`, id);
          count("terms");
        }
        if (next.length === waiting.length) fail("Termini: un genitore manca o la gerarchia è circolare.");
        waiting = next;
      }
      const termRef = (taxonomy: string, slug: string, where: string): string => termIds.get(`${taxonomy}/${slug}`) ?? fail(`${where}: il termine ${taxonomy}/${slug} non è dichiarato.`);

      const records = (Array.isArray(content.records) ? content.records : content.records === undefined ? [] : fail("Contenuti: records deve essere un elenco.")).map((raw) => plainObject(raw, "Record"));
      const recordIds = new Map(records.map((record) => {
        const key = `${text(record.type, "Record: type", 63)}/${text(record.slug, "Record: slug", 63)}`;
        const id = stableId(projectId, "record", key);
        context.labels.set(id, `record ${key}`);
        return [key, id] as const;
      }));
      if (recordIds.size !== records.length) fail("Record: tipo e slug devono essere unici.");
      const typeFields = new Map(store.content.listTypes().map((type) => [type.key, type.fields]));
      /** A record as the store saves it, with no relation, with the required ones only, or with all of them. */
      const recordInput = (record: Record<string, unknown>, relations: "none" | "required" | "all") => {
        const typeKey = record.type as string;
        const slug = record.slug as string;
        const where = `Record ${typeKey}/${slug}`;
        const fields = typeFields.get(typeKey) ?? fail(`${where}: il tipo non è dichiarato.`);
        const values: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(plainObject(record.values ?? {}, `${where}: values`))) {
          const field = fields.find((item) => item.key === key);
          if (!field) fail(`${where}: il campo ${key} non è del tipo.`);
          const one = (item: unknown): unknown => {
            if (field.type === "asset") {
              if (typeof item !== "string" || !item.startsWith("asset:")) fail(`${where}: il campo ${key} vuole asset:<nome>.`);
              const name = item.slice("asset:".length);
              assetUrl(context, name, where);
              return context.assetIds.get(name);
            }
            if (field.type === "relation") {
              const id = typeof item === "string" ? recordIds.get(item) : undefined;
              if (!id) fail(`${where}: il campo ${key} vuole "<tipo>/<slug>" di un record dichiarato.`);
              return id;
            }
            return item;
          };
          if (field.type === "relation" && (relations === "none" || (relations === "required" && !field.required))) continue;
          values[key] = Array.isArray(value) ? value.map(one) : one(value);
        }
        const recordTerms: Record<string, number[]> = {};
        for (const [taxonomy, slugs] of Object.entries(plainObject(record.terms ?? {}, `${where}: terms`))) {
          recordTerms[taxonomy] = referenceList(slugs, `${where}: terms.${taxonomy}`).map((termSlug) => store.content.getTermById(termRef(taxonomy, termSlug, where))!.alias);
        }
        return {
          id: recordIds.get(`${typeKey}/${slug}`)!, typeKey, slug, title: text(record.title, `${where}: title`, 240),
          locale: typeof record.locale === "string" ? record.locale : store.getRenderSettings().locale,
          status: (record.status ?? "published") as "draft" | "published" | "archived",
          publishedAt: record.status === "draft" || record.status === "archived" ? null : typeof record.publishedAt === "string" && UTC_SECOND.test(record.publishedAt) ? record.publishedAt : fail(`${where}: un record pubblicato vuole publishedAt in UTC (AAAA-MM-GGThh:mm:ssZ).`),
          excerpt: text(record.excerpt, `${where}: excerpt`, 20_000, false), order: typeof record.order === "number" ? record.order : 0,
          values, terms: recordTerms,
        };
      };
      const recordName = (record: Record<string, unknown>) => `record ${String(record.type)}/${String(record.slug)}`;
      /**
       * The order the records are saved in. A record goes in without its relations, which a second save adds once every
       * record exists; but one whose type has a required relation cannot be saved without it (the store checks that the
       * record it points to exists). Those are saved first with their required relations alone, after the records these
       * point to: those without required relations first, in the order of the file, then the others in the order of their
       * required relations (the records they point to first, without recursion). Their other relations may point to any
       * record, one saved later or one pointing back: they come with the second save, as everyone's (Q6; a circle of
       * required relations is refused before, by declarationIssues).
       */
      const requiresRelation = (record: Record<string, unknown>) => (typeFields.get(record.type as string) ?? []).some((field) => field.type === "relation" && field.required);
      const recordIndex = new Map(records.map((record, index) => [`${String(record.type)}/${String(record.slug)}`, index]));
      const targetsOf = (record: Record<string, unknown>): number[] => {
        const values = isObject(record.values) ? record.values : {};
        const targets: number[] = [];
        for (const field of typeFields.get(record.type as string) ?? []) {
          if (field.type !== "relation" || !field.required) continue;
          for (const value of [values[field.key]].flat()) {
            const target = typeof value === "string" ? recordIndex.get(value) : undefined;
            if (target !== undefined) targets.push(target);
          }
        }
        return targets;
      };
      const order: number[] = [];
      for (const [index, record] of records.entries()) if (!requiresRelation(record)) order.push(index);
      const withRelations = new Set<number>();
      const visited = new Set(order);
      for (const [start, record] of records.entries()) {
        if (visited.has(start)) continue;
        visited.add(start);
        const stack = [{ index: start, targets: targetsOf(record), next: 0 }];
        for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
          const target = top.targets[top.next++];
          if (target !== undefined) {
            const pointed = records[target];
            if (pointed && !visited.has(target)) {
              visited.add(target);
              stack.push({ index: target, targets: targetsOf(pointed), next: 0 });
            }
            continue;
          }
          stack.pop();
          order.push(top.index);
          withRelations.add(top.index);
        }
      }
      for (const [position, index] of order.entries()) {
        const record = records[index] as Record<string, unknown>;
        const saved = placed(recordName(record), contentPlaces?.records[index], () => store.content.saveRecord({ ...recordInput(record, withRelations.has(index) ? "required" : "none"), expectedHead: null }));
        if (saved.status !== "saved") fail(`Record ${String(record.type)}/${String(record.slug)}: non salvato.`);
        count("records");
        if ((position + 1) % YIELD_EVERY === 0) {
          options.onProgress?.({ phase: "records", done: position + 1, total: records.length });
          await yieldToServer();
          options.signal?.throwIfAborted();
        }
      }
      for (const [index, record] of records.entries()) {
        // The pass over relations yields too, so a cancellation and the progress requests are heard.
        if ((index + 1) % YIELD_EVERY === 0) {
          await yieldToServer();
          options.signal?.throwIfAborted();
        }
        // Relations point to records saved above: a second save only for types that have them, and not for a record
        // saved with all its relations already (every one required).
        const relationFields = (typeFields.get(record.type as string) ?? []).filter((field) => field.type === "relation");
        if (!relationFields.length || (withRelations.has(index) && relationFields.every((field) => field.required))) continue;
        const input = recordInput(record, "all");
        const current = store.content.getRecordById(input.id, true)!;
        const saved = placed(recordName(record), contentPlaces?.records[index], () => store.content.saveRecord({ ...input, expectedHead: current.headRevision }));
        if (saved.status !== "saved") fail(`Record ${input.typeKey}/${input.slug}: relazioni non salvate.`);
      }

      const queries = Array.isArray(content.queries) ? content.queries : content.queries === undefined ? [] : fail("Contenuti: queries deve essere un elenco.");
      const mapFilter = (filter: unknown, where: string): unknown => {
        if (!filter || typeof filter !== "object") return filter;
        if (Array.isArray(filter)) return filter.map((item) => mapFilter(item, where));
        const source = filter as Record<string, unknown>;
        if (typeof source.taxonomyKey === "string" && Array.isArray(source.terms)) {
          const { terms: slugs, ...rest } = source;
          return { ...rest, termIds: referenceList(slugs, `${where}: terms`).map((slug) => termRef(source.taxonomyKey as string, slug, where)) };
        }
        return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, key === "value" && typeof value === "string" && recordIds.has(value) ? recordIds.get(value) : mapFilter(value, where)]));
      };
      for (const [index, raw] of queries.entries()) {
        const query = plainObject(raw, "Query");
        const key = text(query.key, "Query: key", 64);
        const saved = placed(`query ${key}`, contentPlaces?.queries[index], () => store.content.saveQueryPreset({
          key, label: text(query.label, `Query ${key}: label`, 120), typeKey: text(query.type, `Query ${key}: type`, 63),
          ...(typeof query.limit === "number" ? { limit: query.limit } : {}), ...(typeof query.offset === "number" ? { offset: query.offset } : {}),
          ...(typeof query.orderBy === "string" ? { orderBy: query.orderBy } : {}), ...(query.order === "asc" || query.order === "desc" ? { order: query.order } : {}),
          ...(query.filter !== undefined ? { filter: mapFilter(query.filter, `Query ${key}`) } : {}),
          expectedHead: null,
        }));
        if (saved.status !== "saved") fail(`Query ${key}: non salvata.`);
        count("queries");
      }

      // Pages and posts.
      const slugs = new Set<string>(["page:home"]);
      // A template a page or a post names is one of the prototype's (declarationIssues).
      const homeTemplate = home.attributes["data-template"];
      if (homeTemplate && templates.has(homeTemplate)) {
        const page = store.getEntityById(stableId(projectId, "page", "home"))!;
        store.updatePageMetadata(page.id, { title: page.title, slug: page.slug, status: page.status, templateRef: homeTemplate });
      }
      count("pages");
      const writtenDocuments = prototype.documents.filter((item) => item.kind === "page" || item.kind === "post");
      for (const [index, item] of writtenDocuments.entries()) {
        await pace(index, item, () => options.onProgress?.({ phase: "documents", done: index + 1, total: writtenDocuments.length }));
        const slug = text(item.attributes["data-slug"], `${item.label}: data-slug`, item.kind === "post" ? 200 : 63);
        if (!SLUG.test(slug)) fail(`${item.label}: lo slug usa solo minuscole, cifre e trattini.`);
        // The home is read first, before the project exists; a second page with its slug is a repeated slug like any other.
        if (item.kind === "page" && slug === "home") {
          if (item !== home) fail(`${item.label}: slug ripetuto.`);
          continue;
        }
        if (slugs.has(`${item.kind}:${slug}`)) fail(`${item.label}: slug ripetuto.`);
        slugs.add(`${item.kind}:${slug}`);
        const status = item.attributes["data-status"] === "draft" ? "draft" : "published";
        if (item.attributes["data-status"] !== undefined && !["draft", "published"].includes(item.attributes["data-status"])) fail(`${item.label}: data-status può essere draft o published.`);
        const title = text(item.attributes["data-title"], `${item.label}: data-title`, 500);
        const templateRef = item.attributes["data-template"] ?? null;
        const body = documentContent(item, context, warnings);
        context.labels.set(stableId(projectId, item.kind, slug), `${item.kind} ${slug}`);
        if (item.kind === "page") {
          placed(documentName(item), { line: item.line }, () => store.createPage({ id: stableId(projectId, "page", slug), title, slug, content: body ?? "", status, templateRef: templateRef !== null && templates.has(templateRef) ? templateRef : null }));
          count("pages");
        } else {
          const publishedAt = item.attributes["data-published-at"] ?? null;
          if (status === "published" && (!publishedAt || !UTC_SECOND.test(publishedAt))) fail(`${item.label}: un articolo pubblicato vuole data-published-at in UTC (AAAA-MM-GGThh:mm:ssZ).`);
          const postTerms: Record<string, string[]> = {};
          if (item.attributes["data-terms"] !== undefined) {
            for (const [taxonomy, termSlugs] of Object.entries(plainObject(jsonPart(item.attributes["data-terms"], `${item.label}: data-terms`), `${item.label}: data-terms`))) {
              postTerms[taxonomy] = referenceList(termSlugs, `${item.label}: data-terms.${taxonomy}`).map((termSlug) => termRef(taxonomy, termSlug, item.label));
            }
          }
          // Doc 23 item 119: the featured image, an image of the declared media.
          let imageAssetId: string | null = null;
          const image = item.attributes["data-image"];
          if (image !== undefined) {
            const name = /^asset:([a-z0-9][a-z0-9-]{0,62})$/u.exec(image)?.[1];
            if (!name) fail(`${item.label} (riga ${item.line}): data-image vuole asset:<nome> di un'immagine dichiarata.`);
            const type = context.assetTypes.get(name);
            if (type !== undefined && !IMAGE_TYPES.has(type)) fail(`${item.label} (riga ${item.line}): data-image usa asset:${name}, che è un carattere (${type}), non un'immagine.`);
            imageAssetId = assetUrl(context, name, `${item.label} (riga ${item.line}): data-image`).split("/").pop()!;
          }
          placed(documentName(item), { line: item.line }, () => store.createPost({ id: stableId(projectId, "post", slug), title, slug, content: body ?? "", status, publishedAt: status === "published" ? publishedAt : null, excerpt: text(item.attributes["data-excerpt"], `${item.label}: data-excerpt`, 20_000, false), imageAssetId, terms: postTerms, templateRef: templateRef !== null && templates.has(templateRef) ? templateRef : null }));
          count("posts");
        }
      }
      // E4: every document is read; their problems go out together, before a transfer would stop at the first one.
      pendingCallIssues(context);
      if (context.issues.length) failAll(context);
      for (const name of context.assetIds.keys()) if (!context.usedAssets.has(name)) warnings.push(`Il media ${name} non è usato: è comunque nella libreria.`);
      const postTaxonomies = POST_TAXONOMIES.filter((key) => store.content.listTaxonomies().some((taxonomy) => taxonomy.key === key));
      if ((counts.posts ?? 0) > 0 && postTaxonomies.length === 0) {
        warnings.push("Gli articoli non hanno categorie né tag: aggiungi le tassonomie category o post_tag se il sito li usa.");
      }
      if (manifest.framework === "none") warnings.push("framework none: gli stili non usano i token di Histeon CSS.");
      if (store.content.getType(PRODUCT_TYPE_KEY)) {
        // Queue C6: the static site shows the catalogue; only WordPress with WooCommerce sells.
        const shop = store.getShopSettings();
        warnings.push(shop.url
          ? `Prodotti: il sito statico mostra prezzi e pulsanti ma non vende, perché il carrello c'è solo su WordPress: «aggiungi al carrello» porta alla pagina del prodotto su ${new URL(shop.url).host}. Ordini, clienti e pagamenti restano a WooCommerce.`
          : "Prodotti: il sito statico mostra prezzi e pulsanti ma non vende, perché il carrello c'è solo su WordPress, e senza shop.url nel manifest i link «aggiungi al carrello» mancano (item.product.addToCartUrl è vuoto). Ordini, clienti e pagamenti restano a WooCommerce.");
      }
      for (const form of context.forms.filter((item) => item.external)) {
        let host = form.action;
        try { host = new URL(form.action).host; } catch { /* the transfer refuses an invalid endpoint */ }
        warnings.push(`${form.document}: il modulo invia i dati (${form.method.toUpperCase()}) a ${host}.`);
      }
      warnings.push(...frameworkNameWarnings(context.names, { framework: manifest.framework, ...(manifest.acss ? { acss: manifest.acss } : {}), ...(context.convert ? { conversions: context.convert.conversions } : {}) }));
      if (context.unsizedImages.length) warnings.push(unsizedImagesWarning(context.unsizedImages, context.assetSizes, new Set(placeholders)));
      images = variantImagesReport(context.variantImages, media, new Set(placeholders));
      if (images?.candidates.length) warnings.push(...pageWideImageWarnings(prototype));
      // D4: accessibility and SEO, as warnings; nothing is refused for them.
      warnings.push(...quality.warnings());
      // The pages that would pass a limit of the renderer through their template and components: the static build
      // stops on them. A warning, not a refusal: the project itself is saved whole, only its static build stops.
      for (const problem of quality.limits()) warnings.push(`Build del sito: ${formatPrototypeIssue(problem)}`);
      strictProblems = context.strict?.problems({ ruleClasses: context.names.selectorClasses, unreadable: context.names.unreadable.size > 0 });

    });
    options.signal?.throwIfAborted();
    // The transfer format holds at most 4 MB of content per document: said by name here, not as a schema report. It is
    // measured as the transfer writes it (media as histos-media://, characters as code points).
    const transferLength = (content: string) => codePoints(content.replaceAll(`/__cms-media/${projectId}/`, "histos-media://"));
    for (const document of [...store.listPages(), ...store.listPosts()]) {
      if (transferLength(store.getHead(document.id)?.content ?? "") > TRANSFER_CONTENT_MAX) fail(document.documentType === "post" ? `L'articolo ${document.slug} supera i 4 MB di contenuto: dividilo o alleggeriscilo.` : `La pagina ${document.slug} supera i 4 MB di contenuto: dividila o alleggeriscila.`);
    }
    for (const item of [...store.listComponents(), ...store.listTemplates()]) {
      const kind = item.kind === "template" ? "Il template" : item.kind === "template-part" ? "La parte" : "Il componente";
      if (transferLength(item.content) > TRANSFER_CONTENT_MAX) fail(`${kind} ${item.ref} supera i 4 MB di contenuto: ${item.kind === "template-part" ? "dividila o alleggeriscila" : "dividilo o alleggeriscilo"}.`);
    }
    // Doc 18 §6.6: each document's JavaScript, as text; the import never runs it.
    for (const [slug, code] of Object.entries(prototype.scripts?.pages ?? {})) {
      const page = store.listPages().find((item) => item.slug === slug);
      if (page) store.setDocumentScript(page.id, code);
    }
    for (const [ref, code] of Object.entries(prototype.scripts?.components ?? {})) {
      const component = store.getComponentByRef(ref);
      if (component) store.setDocumentScript(component.id, code);
    }
    const scriptCount = prototype.scripts ? Object.keys(prototype.scripts.pages).length + Object.keys(prototype.scripts.components).length : 0;
    if (scriptCount) warnings.push(`${scriptCount === 1 ? "un documento ha" : `${scriptCount} documenti hanno`} JavaScript: gira nel sito pubblicato e nell'anteprima isolata, mai nel builder; su WordPress lo salva solo chi ha il permesso unfiltered_html.`);
    let exported: Awaited<ReturnType<typeof createStaticPageProfile>>;
    try {
      exported = await createStaticPageProfile(project, store);
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
      // The contract already narrows each entity to the branch of its kind. A key the format does not take names itself
      // first, then a limit passed; what is left only says what the entity is not.
      const rank = (issue: string) => /must NOT have additional properties|must match pattern .*\(«/u.test(issue) ? 0 : /must NOT have more than/u.test(issue) ? 1 : 2;
      const issues = error.issues.map((issue, index) => ({ issue, index })).sort((a, b) => rank(a.issue) - rank(b.issue) || a.index - b.index).map(({ issue }) => issue);
      fail(`Il progetto non rispetta i limiti del formato di trasferimento (${error.issues.length === 1 ? "un problema" : `${error.issues.length} problemi`}): ${issues.slice(0, 2).map((issue) => issue.slice(0, 160)).join("; ")}.`);
    }
    store.close();
    if (placeholders.length) warnings.push(`Controllo rapido: ${placeholders.length} media remoti non scaricati (${placeholders.slice(0, 5).join(", ")}${placeholders.length > 5 ? "…" : ""}).`);
    // The shop's settings are the project's, not the transfer's (WordPress keeps its own): the importer applies them.
    return { ...exported, report: { project: { id: projectId, name: manifest.name }, counts, downloaded, placeholders, ignored: prototype.ignored, warnings, forms: context.forms, ...(images ? { images: images.report } : {}) }, imageCandidates: images?.candidates ?? [], ...(manifest.shop !== undefined ? { shop: normalizeShopSettings(manifest.shop) } : {}), ...(strictProblems ? { strict: strictProblems } : {}) };
  } catch (error) {
    try { opened?.close(); } catch { /* already closed */ }
    throw refusal(error, context, options.signal);
  }
}

/**
 * What the build throws for an error met along the way. No internal id in a message (E4): an entity is named as the file
 * names it. And a problem met after some documents had theirs, whatever refused it (a check here or the store's), goes
 * out together with them, never in their place. Only what the server reads as a refused prototype (a TypeError or a
 * RangeError) is touched: a cancellation stays a cancellation, a disk or database error stays itself.
 */
function refusal(error: unknown, context: BuildContext, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted || !(error instanceof TypeError || error instanceof RangeError)) return error;
  let found: TypeError | RangeError = error;
  if (!(found instanceof PrototypeError) && /[0-9a-f]{8}-[0-9a-f]{4}-/u.test(found.message)) {
    const named = found.message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, (id) => context.labels.get(id) ?? id);
    if (named !== found.message) found = new PrototypeError(named);
  }
  if (!context.issues.length) return found;
  // An error that already lists the collected problems (failAll) shares their objects: it is the report itself.
  const collected = new Set(context.issues);
  const extra = found instanceof PrototypeError ? found.issues : [{ message: found.message }];
  return extra.some((issue) => collected.has(issue)) ? found : allIssuesError([...context.issues, ...extra], context.unlisted);
}

/**
 * A check without import: the profile goes through the same catalog import as a real one, in a scratch catalog the
 * caller deletes. Returns whether the real catalog would create, update or refuse the project.
 */
export async function verifyPrototypeProfile(
  built: { profile: StaticPageProfile; files: Map<string, Buffer> },
  scratch: CmsProjectCatalog,
): Promise<void> {
  const imported = await scratch.importStaticPageProfile(built.profile, built.files);
  imported.store.close();
}
