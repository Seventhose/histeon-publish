import postcss, { list, type AtRule, type ChildNode, type Container, type Declaration, type Root } from "postcss";
import valueParser, { type Node as ValueNode } from "postcss-value-parser";
import { parseXb, serializeXb, type XbBlock } from "../.generated/histos-dsl/index.js";

/**
 * V5.5: the styles of an added page («pagina aggiunta», add-page.ts) hold only on that page. The format has no place for
 * the CSS of one page (a page's document has no styles; the plugin's «aspetto della pagina» takes a closed grammar of a
 * few properties), so the page carries its own mark and every rule of the page is limited to it:
 *
 * - each top-level element of the page gets `data-histos-pagina="<slug>"` (PAGE_MARK). No element is added: the page's
 *   elements keep their parents, so every rule of the site and of the theme matches them as it did;
 * - the subject of every selector of the page takes `:where(<mark>, <mark> *, html:has(<mark>), body:has(<mark>))`
 *   (`pageFilter`): it matches the page's elements, and `html` and `body` only on the page that holds the mark. Rules on
 *   `body`, `html` and `:root` (the background of the original `<body>`, its variables) stay on those elements, on that
 *   page only. `:where()` has no specificity: inside the page every rule wins and loses as it did;
 * - names that are global in CSS and that the site already uses (`@keyframes`, `@font-face` families, `@counter-style`,
 *   `@property`) take the page's name, and the page's references follow; at-rules that cannot hold for one page only
 *   (`@import`, `@page`, `@view-transition`, `@viewport`) are left out, said in a note.
 */

/** The attribute that marks the elements of an added page. Its value is the page's slug (with a suffix if taken). */
export const PAGE_MARK = "data-histos-pagina";

/**
 * The rule of the images the conversion sized (static-site-prototype.ts, SIZED_MARK and SIZED_CSS, which must stay the
 * same as these): shared by the whole site, never limited to a page.
 */
const SIZED_MARK = "data-histos-sized";
const SIZED_SELECTORS = new Set([`:where(img[${SIZED_MARK}~="width"])`, `:where(img[${SIZED_MARK}~="height"])`]);

/** At-rules that hold for the whole document whatever page they come from: an added page leaves them out. */
const DOCUMENT_AT_RULES = new Set(["import", "page", "view-transition", "viewport", "-ms-viewport"]);

const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

export type RenamedKind = "animazione" | "carattere" | "contatore" | "proprieta";

/** What the page renamed, because the site already has the name. */
export interface PageScopeRename {
  kind: RenamedKind;
  from: string;
  to: string;
}

/** The names that are global in CSS, as the site's styles use them. */
export interface CssNames {
  keyframes: Set<string>;
  /** Font families of `@font-face`, in lowercase (CSS compares them without case). */
  families: Set<string>;
  counterStyles: Set<string>;
  /** Custom properties the site registers (`@property`), declares or reads (`var()`). */
  properties: Set<string>;
}

export interface PageScope {
  /** The value of PAGE_MARK on the page's top-level elements. */
  mark: string;
  /** What every subject of the page's selectors takes. */
  filter: string;
  keyframes: Map<string, string>;
  /** Lowercase family → the page's own name. */
  families: Map<string, string>;
  counterStyles: Map<string, string>;
  properties: Map<string, string>;
  renamed: PageScopeRename[];
}

function parse(css: string): Root | null {
  try {
    return postcss.parse(css);
  } catch {
    return null;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/su.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function insideKeyframes(node: ChildNode): boolean {
  for (let parent = node.parent; parent && parent.type !== "root"; parent = parent.parent as Container | undefined) {
    if (parent.type === "atrule" && /keyframes$/iu.test((parent as AtRule).name)) return true;
  }
  return false;
}

function insideRule(node: ChildNode): boolean {
  for (let parent = node.parent; parent && parent.type !== "root"; parent = parent.parent as Container | undefined) {
    if (parent.type === "rule") return true;
  }
  return false;
}

/** The family a `@font-face` declares, as written (without quotes), or null. */
function faceFamily(rule: AtRule): string | null {
  let family: string | null = null;
  rule.each((child) => {
    if (child.type === "decl" && child.prop.toLowerCase() === "font-family") family = unquote(child.value);
  });
  return family;
}

/** The global names that `css` defines (and, for custom properties, uses), added to `into`. */
function collectNames(css: string, into: CssNames, uses: boolean): void {
  const root = parse(css);
  if (!root) return;
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (/keyframes$/u.test(name)) into.keyframes.add(unquote(rule.params));
    else if (name === "counter-style") into.counterStyles.add(rule.params.trim());
    else if (name === "property") into.properties.add(rule.params.trim());
    else if (name === "font-face") {
      const family = faceFamily(rule);
      if (family) into.families.add(family.toLowerCase());
    }
  });
  if (!uses) return;
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--")) into.properties.add(decl.prop);
    if (!decl.value.includes("var(")) return;
    valueParser(decl.value).walk((node) => {
      if (node.type === "function" && node.value.toLowerCase() === "var" && node.nodes[0]?.type === "word" && node.nodes[0].value.startsWith("--")) into.properties.add(node.nodes[0].value);
    });
  });
}

function emptyNames(): CssNames {
  return { keyframes: new Set(), families: new Set(), counterStyles: new Set(), properties: new Set() };
}

/** The global names of the site's styles (its sheets, and its styles by selector written as rules). */
export function siteCssNames(css: readonly string[]): CssNames {
  const names = emptyNames();
  for (const text of css) collectNames(text, names, true);
  return names;
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** `:where([mark], [mark] *, html:has([mark]), body:has([mark]))` for one page. */
export function pageFilter(mark: string): string {
  const attribute = `[${PAGE_MARK}=${quoted(mark)}]`;
  return `:where(${attribute},${attribute} *,html:has(${attribute}),body:has(${attribute}))`;
}

/**
 * The scope of the page with this slug, against the site's CSS (`siteCss`: every sheet and every style of the site as
 * text) and the page's own sheets: the mark (the slug, with `-2`, `-3`… if the site's styles already name it, for
 * example those of a page with that slug deleted since), the filter, and the global names to rename.
 */
export function pageScope(slug: string, siteCss: readonly string[], pageCss: readonly string[]): PageScope {
  const site = siteCssNames(siteCss);
  let mark = slug;
  for (let counter = 2; siteCss.some((css) => css.includes(`${PAGE_MARK}=${quoted(mark)}`)); counter++) mark = `${slug}-${counter}`;
  const own = emptyNames();
  for (const css of pageCss) collectNames(css, own, false);
  const scope: PageScope = { mark, filter: pageFilter(mark), keyframes: new Map(), families: new Map(), counterStyles: new Map(), properties: new Map(), renamed: [] };
  const fresh = (wanted: string, taken: (name: string) => boolean): string => {
    let name = wanted;
    for (let counter = 2; taken(name); counter++) name = `${wanted}-${counter}`;
    return name;
  };
  for (const name of own.keyframes) {
    if (!site.keyframes.has(name)) continue;
    const to = fresh(`${name}--${mark}`, (candidate) => site.keyframes.has(candidate) || own.keyframes.has(candidate));
    scope.keyframes.set(name, to);
    scope.renamed.push({ kind: "animazione", from: name, to });
  }
  for (const name of own.counterStyles) {
    if (!site.counterStyles.has(name)) continue;
    const to = fresh(`${name}--${mark}`, (candidate) => site.counterStyles.has(candidate) || own.counterStyles.has(candidate));
    scope.counterStyles.set(name, to);
    scope.renamed.push({ kind: "contatore", from: name, to });
  }
  for (const name of own.properties) {
    if (!site.properties.has(name)) continue;
    const to = fresh(`${name}--${mark}`, (candidate) => site.properties.has(candidate) || own.properties.has(candidate));
    scope.properties.set(name, to);
    scope.renamed.push({ kind: "proprieta", from: name, to });
  }
  // Families: written as the page writes them, compared without case.
  const written = new Map<string, string>();
  for (const css of pageCss) {
    parse(css)?.walkAtRules(/^font-face$/iu, (rule) => {
      const family = faceFamily(rule);
      if (family && !written.has(family.toLowerCase())) written.set(family.toLowerCase(), family);
    });
  }
  for (const [lower, family] of written) {
    if (!site.families.has(lower)) continue;
    const to = fresh(`${family} ${mark}`, (candidate) => site.families.has(candidate.toLowerCase()) || written.has(candidate.toLowerCase()));
    scope.families.set(lower, to);
    scope.renamed.push({ kind: "carattere", from: family, to });
  }
  return scope;
}

function isHex(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/u.test(char);
}

/**
 * One selector (not a list) with `filter` added to its subject: the last compound, before its first pseudo-element
 * (`::before`, `::-webkit-scrollbar`, the legacy `:before`, `:after`, `:first-line`, `:first-letter`). The selector is
 * read character by character, with its strings, escapes, brackets and parentheses. A selector that ends with a
 * combinator (not a selector at all) stays as it is: it matched nothing before and still matches nothing.
 */
export function scopeSelector(selector: string, filter: string): string {
  const text = selector.trimEnd();
  let depth = 0;
  let quote = "";
  let inCompound = false;
  let pseudoAt = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\\") {
      if (depth === 0 && !inCompound) {
        inCompound = true;
        pseudoAt = -1;
      }
      if (isHex(text[index + 1])) {
        let end = index + 1;
        while (end < text.length && end - index <= 6 && isHex(text[end])) end++;
        if (text[end] === "\r" && text[end + 1] === "\n") end++;
        if (text[end] !== undefined && /\s/u.test(text[end] as string)) end++;
        index = end - 1;
      } else index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      if (depth === 0 && !inCompound) {
        inCompound = true;
        pseudoAt = -1;
      }
      depth++;
      continue;
    }
    if (char === ")" || char === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;
    if (/\s/u.test(char) || char === ">" || char === "+" || char === "~") {
      inCompound = false;
      continue;
    }
    if (!inCompound) {
      inCompound = true;
      pseudoAt = -1;
    }
    if (char !== ":") continue;
    if (text[index + 1] === ":") {
      if (pseudoAt < 0) pseudoAt = index;
      index++;
      continue;
    }
    let end = index + 1;
    while (end < text.length && /[\w-]/u.test(text[end] as string)) end++;
    if (pseudoAt < 0 && text[end] !== "(" && LEGACY_PSEUDO_ELEMENTS.has(text.slice(index + 1, end).toLowerCase())) pseudoAt = index;
  }
  if (!inCompound) return selector;
  const at = pseudoAt >= 0 ? pseudoAt : text.length;
  return `${text.slice(0, at)}${filter}${text.slice(at)}`;
}

/** A selector list (`.a, .b::before`) with each selector's subject limited to the page. */
export function scopeSelectorList(selector: string, filter: string): string {
  return list.comma(selector).map((item) => scopeSelector(item, filter)).join(",");
}

/** The value's top-level nodes split at commas. */
function segments(nodes: ValueNode[]): ValueNode[][] {
  const out: ValueNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === "div" && node.value === ",") out.push([]);
    else out.at(-1)!.push(node);
  }
  return out;
}

/** In one comma segment of a font list, the family at its end (all of it, or the end of `font`'s first part) renamed. */
function renameFamilyAtEnd(segment: ValueNode[], families: ReadonlyMap<string, string>, wholeOnly: boolean): boolean {
  const solid = segment.filter((node) => node.type !== "space" && node.type !== "comment");
  const last = solid.at(-1);
  if (!last) return false;
  if (last.type === "string") {
    const to = families.get(last.value.toLowerCase());
    if (!to || (wholeOnly && solid.length !== 1)) return false;
    last.value = to;
    return true;
  }
  for (let count = solid.length; count >= 1; count--) {
    if (wholeOnly && count !== solid.length) break;
    const words = solid.slice(solid.length - count);
    if (!words.every((node) => node.type === "word")) continue;
    const to = families.get(words.map((node) => node.value).join(" ").toLowerCase());
    if (!to) continue;
    const first = words[0]!;
    Object.assign(first, { type: "string", value: to, quote: '"', unclosed: false });
    // The other words of the old name (and the spaces between them) go.
    segment.splice(segment.indexOf(first) + 1);
    return true;
  }
  return false;
}

/** A declaration with the page's renamed names in its value (and its own name, for a renamed custom property). */
function renameDeclaration(decl: Declaration, scope: PageScope): void {
  if (scope.properties.has(decl.prop)) decl.prop = scope.properties.get(decl.prop)!;
  if (!scope.keyframes.size && !scope.families.size && !scope.counterStyles.size && !scope.properties.size) return;
  const prop = decl.prop.toLowerCase();
  const custom = prop.startsWith("--");
  const parsed = valueParser(decl.value);
  let changed = false;
  if (scope.properties.size) {
    parsed.walk((node) => {
      if (node.type === "function" && node.value.toLowerCase() === "var" && node.nodes[0]?.type === "word" && scope.properties.has(node.nodes[0].value)) {
        node.nodes[0].value = scope.properties.get(node.nodes[0].value)!;
        changed = true;
      }
    });
  }
  const parentName = decl.parent?.type === "atrule" ? (decl.parent as AtRule).name.toLowerCase() : "";
  if (scope.keyframes.size && (custom || /^(-[a-z]+-)?animation(-name)?$/u.test(prop))) {
    for (const node of parsed.nodes) {
      if (node.type === "word" && scope.keyframes.has(node.value)) {
        node.value = scope.keyframes.get(node.value)!;
        changed = true;
      }
    }
  }
  if (scope.counterStyles.size) {
    const listProp = custom || prop === "list-style" || prop === "list-style-type" || (parentName === "counter-style" && (prop === "system" || prop === "fallback"));
    if (listProp) {
      for (const node of parsed.nodes) {
        if (node.type === "word" && scope.counterStyles.has(node.value)) {
          node.value = scope.counterStyles.get(node.value)!;
          changed = true;
        }
      }
    }
    parsed.walk((node) => {
      if (node.type !== "function" || !/^counters?$/iu.test(node.value)) return;
      const style = segments(node.nodes).at(-1)?.find((item) => item.type === "word");
      if (style && segments(node.nodes).length > (node.value.toLowerCase() === "counters" ? 2 : 1) && scope.counterStyles.has(style.value)) {
        style.value = scope.counterStyles.get(style.value)!;
        changed = true;
      }
    });
  }
  if (scope.families.size && (custom || prop === "font-family" || prop === "font")) {
    const parts = segments(parsed.nodes);
    const commas = parsed.nodes.filter((node) => node.type === "div" && node.value === ",");
    let renamed = false;
    for (const [index, segment] of parts.entries()) {
      // In `font`, the family list starts at the end of the first part (after the size); elsewhere a part is a family.
      if (renameFamilyAtEnd(segment, scope.families, !(prop === "font" && index === 0))) renamed = true;
    }
    if (renamed) {
      parsed.nodes = parts.flatMap((segment, index) => (index ? [commas[index - 1]!, ...segment] : segment));
      changed = true;
    }
  }
  if (changed) decl.value = parsed.toString();
}

/** The page's renamed global names, in the at-rules that define them and in the declarations that use them. */
function renameNames(root: Root, scope: PageScope): void {
  root.walk((node) => {
    if (node.type === "decl") {
      renameDeclaration(node, scope);
      return;
    }
    if (node.type !== "atrule") return;
    const name = node.name.toLowerCase();
    if (/keyframes$/u.test(name) && scope.keyframes.has(unquote(node.params))) node.params = scope.keyframes.get(unquote(node.params))!;
    else if (name === "counter-style" && scope.counterStyles.has(node.params.trim())) node.params = scope.counterStyles.get(node.params.trim())!;
    else if (name === "property" && scope.properties.has(node.params.trim())) node.params = scope.properties.get(node.params.trim())!;
    else if (name === "font-face") {
      node.each((child) => {
        if (child.type !== "decl" || child.prop.toLowerCase() !== "font-family") return;
        const to = scope.families.get(unquote(child.value).toLowerCase());
        if (to) child.value = quoted(to);
      });
    }
  });
}

/**
 * One of the page's sheets, limited to the page: every selector's subject takes the filter (keyframe steps and rules
 * nested in a rule, relative to one already limited, stay as written), the renamed names follow, and the at-rules that
 * hold for the whole document go, each with a note. Null for a sheet postcss cannot read: it cannot be limited, so it
 * does not enter the site.
 */
export function scopeSheet(css: string, scope: PageScope): { css: string; notes: string[] } | null {
  const root = parse(css);
  if (!root) return null;
  const notes: string[] = [];
  root.walk((node) => {
    if (node.type === "atrule" && DOCUMENT_AT_RULES.has(node.name.toLowerCase())) {
      notes.push(`Regola @${node.name.toLowerCase()} della pagina non importata: varrebbe per tutto il sito`);
      node.remove();
      return;
    }
    if (node.type !== "rule" || insideKeyframes(node) || insideRule(node)) return;
    node.selectors = node.selectors.map((selector) => scopeSelector(selector, scope.filter));
  });
  renameNames(root, scope);
  return { css: root.toString(), notes };
}

/** The body of a style by selector (declarations and nested blocks) with the page's renamed names; as it is otherwise. */
export function renameInStyleBody(css: string, scope: PageScope): string {
  if (!scope.renamed.length) return css;
  const root = parse(`x{${css}}`);
  if (!root) return css;
  renameNames(root, scope);
  const text = root.toString();
  return text.slice(text.indexOf("{") + 1, text.lastIndexOf("}"));
}

// ------------------------------------------------------------------------------------- styles by selector, as the plugin

/*
 * The plugin compiles a style by selector (`CssCompiler::compile`, plugin/src/Styles/CssCompiler.php of the builder): its
 * body's declarations and nested blocks stay under the selector, and a BEM part (`&__title`, `&--large`, also inside
 * `@media`, `@container`, `@supports`, `@layer`) becomes a rule of its own, `.card__title`, after it. A limited selector
 * (`.card:where(…)`) cannot take a BEM part (`.card:where(…)__title` is no class), so an added style is split here into
 * the rules the plugin would print, in the same order, each limited on its own. The reading below is the plugin's, step
 * by step, so that the rules are the ones the plugin prints.
 */

const PHP_SPACE = " \t\n\r\0\u000b";

function phpTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PHP_SPACE.includes(value[start] as string)) start++;
  while (end > start && PHP_SPACE.includes(value[end - 1] as string)) end--;
  return value.slice(start, end);
}

function stringEnd(text: string, open: number): number {
  const quote = text[open];
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === quote) return index;
  }
  return text.length - 1;
}

function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") index = stringEnd(text, index);
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return text.length;
}

/** `CssCompiler::statements`: the top-level statements of a body, `[declaration, null]` or `[prelude, block]`. */
function statements(body: string): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  let buffer = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (char === "/" && body[index + 1] === "*") {
      const end = body.indexOf("*/", index + 2);
      index = end < 0 ? body.length : end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(body, index);
      buffer += body.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === ";") {
      if (phpTrim(buffer) !== "") out.push([phpTrim(buffer), null]);
      buffer = "";
      continue;
    }
    if (char === "{") {
      const close = blockEnd(body, index);
      out.push([phpTrim(buffer), body.slice(index + 1, close)]);
      buffer = "";
      index = close;
      continue;
    }
    buffer += char;
  }
  if (phpTrim(buffer) !== "") out.push([phpTrim(buffer), null]);
  return out;
}

/** `CssCompiler::split_list`: a selector list split at its top-level commas. */
function splitList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(phpTrim(buffer));
      buffer = "";
      continue;
    }
    buffer += char;
  }
  parts.push(phpTrim(buffer));
  return parts.filter((part) => part !== "");
}

function isBem(prelude: string): boolean {
  const nested = splitList(prelude);
  return nested.length > 0 && nested.every((part) => /^&(?:__|--)/u.test(part));
}

function joinBem(selector: string, prelude: string): string {
  return splitList(selector).flatMap((parent) => splitList(prelude).map((part) => parent + part.slice(1))).join(",");
}

function isGroup(prelude: string): boolean {
  return /^@(?:media|container|supports|layer)\b/iu.test(prelude);
}

type StyleRule = { selector: string; css: string };

function bemGroup(selector: string, prelude: string, block: string): [string, StyleRule[]] {
  let keep = "";
  const lift: StyleRule[] = [];
  for (const [inner, body] of statements(block)) {
    if (body === null) keep += `${inner};`;
    else if (isBem(inner)) lift.push(...styleRules(joinBem(selector, inner), body));
    else if (isGroup(inner)) {
      const [kept, lifted] = bemGroup(selector, inner, body);
      keep += kept;
      lift.push(...lifted);
    } else keep += `${inner}{${body}}`;
  }
  if (!lift.length) return [`${prelude}{${block}}`, []];
  return [keep === "" ? "" : `${prelude}{${keep}}`, lift.map((rule) => ({ selector: rule.selector, css: `${prelude}{${rule.css}}` }))];
}

/**
 * The rules the plugin prints for the style `selector { body }`, in its order, each as a selector and a body without
 * BEM parts: the style itself (when it has something of its own), then each BEM part. A body without BEM parts is one
 * rule, the style as it is.
 */
export function styleRules(selector: string, body: string): StyleRule[] {
  const parts = statements(body);
  if (!parts.some(([prelude, block]) => block !== null && (isBem(prelude) || isGroup(prelude)))) return [{ selector, css: body }];
  let own = "";
  const hoisted: StyleRule[] = [];
  for (const [prelude, block] of parts) {
    if (block === null) own += `${prelude};`;
    else if (isBem(prelude)) hoisted.push(...styleRules(joinBem(selector, prelude), block));
    else if (isGroup(prelude)) {
      const [inside, lifted] = bemGroup(selector, prelude, block);
      own += inside;
      hoisted.push(...lifted);
    } else own += `${prelude}{${block}}`;
  }
  if (!hoisted.length) return [{ selector, css: body }];
  return [...(own === "" ? [] : [{ selector, css: own }]), ...hoisted];
}

/** The sheet of the images the conversion sized (only its two `:where(img[data-histos-sized…])` rules). */
export function isSizedSheet(css: string): boolean {
  const root = parse(css);
  if (!root) return false;
  let rules = 0;
  let other = false;
  root.each((node) => {
    if (node.type === "comment") return;
    if (node.type !== "rule" || !node.selectors.every((selector) => SIZED_SELECTORS.has(selector.replace(/\s+/gu, "")))) other = true;
    else rules++;
  });
  return rules > 0 && !other;
}

/**
 * The page's content with PAGE_MARK on each of its top-level elements (inside a top-level condition or loop, on the
 * first elements of each). Nothing else changes; text at the top level, outside any element, has no mark.
 */
export function markPageContent(content: string, mark: string): { content: string; marked: number } {
  const parsed = parseXb(content);
  if (parsed.issues.length) throw new TypeError(`La pagina richiede riparazioni prima di essere aggiunta: ${parsed.issues[0]}`);
  let marked = 0;
  const visit = (blocks: XbBlock[]): XbBlock[] => blocks.map((block) => {
    if (block.name === "xb/element") {
      marked++;
      return { ...block, attrs: { ...block.attrs, attributes: { ...(block.attrs.attributes ?? {}), [PAGE_MARK]: mark } } };
    }
    if (block.name === "xb/if" || block.name === "xb/branch" || block.name === "xb/loop") return { ...block, children: visit(block.children) } as XbBlock;
    return block;
  });
  return { content: serializeXb(visit(parsed.blocks)), marked };
}
