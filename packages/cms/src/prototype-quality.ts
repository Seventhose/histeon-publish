import { DEFAULT_SLOT, loopElse, parse as parseDsl, type XbBlock } from "../.generated/histos-dsl/index.js";
import { cmsPostsIndexWritten, cmsTermArchiveRoles } from "./content-model.js";

/**
 * Accessibility and SEO checks of a prototype at import (queue D4). They are warnings in the import report, never
 * a refusal: the redesign starts clean, the user decides. Each document is read from the blocks the import parsed it
 * into, as the import goes, never parsed again (Q4: a second parse of every document, in one call at the end, held the
 * server for seconds). Images and links are read in the document's own markup, with the links folded into a text run
 * and what is written in braces counted as text. Headings and sections are read as the site renders them (A7 trial):
 * each page and post inside the template the build gives it, resolved as the build resolves it (cms-api.ts,
 * documentTemplateRef: a post without data-template takes the single role, the home the front-page role), the pages the
 * build makes from a template alone (a record, an archive, the blog, the 404), and the components and parts each one
 * calls with what fills their slots.
 */

interface QualityDocument {
  kind: string;
  attributes: Record<string, string>;
  source: string;
  /** Where the document starts in the file, for the problems of the renderer's limits. */
  line?: number;
}

/** "home, chi-siamo e altre 3": a few names, then how many more. */
function names(list: readonly string[]): string {
  const shown = list.slice(0, 4).join(", ");
  return list.length > 4 ? `${shown} e altre ${list.length - 4}` : shown;
}

/**
 * The headings of a document in the order they render, each its level, with the name of a slot where the content that
 * fills it renders. Held up to OUTLINE_MAX entries: past them nothing changes what the checks find in a real page, and a
 * chain of components that each call the previous twice cannot make it grow beyond them.
 */
type Outline = Array<number | string>;
const OUTLINE_MAX = 256;

function append(outline: Outline, items: Iterable<number | string>): void {
  for (const item of items) {
    if (outline.length >= OUTLINE_MAX) return;
    outline.push(item);
  }
}

/** An outline with each slot's name replaced by what fills it: nothing for a slot that nothing fills. */
function filled(outline: Outline, fill: (slot: string) => Outline | undefined): Outline {
  const out: Outline = [];
  for (const item of outline) append(out, typeof item === "number" ? [item] : fill(item) ?? []);
  return out;
}

/** What the checks need of some markup, read once. */
interface Reading {
  outline: Outline;
  /** It renders a heading, h1–h6 or role="heading", its components' included; what fills its own slots comes from outside. */
  heading: boolean;
  /** The slots it renders, by name: what fills them is the caller's markup. */
  slots: Set<string>;
  /** Its sections with neither a heading nor a name, for the document it is written in. */
  bare: number;
  /** Its slots that sit inside such a section: the content that fills one must bring the heading. */
  needy: Set<string>;
}

const EMPTY: Reading = { outline: [], heading: false, slots: new Set(), bare: 0, needy: new Set() };

/** The h1 of a reading: an {#if} shows one branch, so of its branches the one with the most h1, then the most headings. */
function h1s(outline: Outline): number {
  return outline.filter((item) => item === 1).length;
}

/**
 * Reads blocks as they render. A heading in any branch of an {#if} or in a loop's body counts for a section around it
 * (a warning must not be wrong), and the outline takes the {#if}'s branch with the most h1 (a single page shows one).
 * `component` gives what a component or part renders, read once for the whole prototype.
 */
function read(blocks: readonly XbBlock[], component: (ref: string) => Reading): Reading {
  const result: Reading = { outline: [], heading: false, slots: new Set(), bare: 0, needy: new Set() };
  const add = (part: Reading) => {
    append(result.outline, part.outline);
    result.heading ||= part.heading;
    for (const slot of part.slots) result.slots.add(slot);
    result.bare += part.bare;
    for (const slot of part.needy) result.needy.add(slot);
  };
  for (const block of blocks) {
    if (block.name === "xb/element") {
      const inner = read(block.children, component);
      const tag = block.attrs.tag.toLowerCase();
      const value = (name: string) => {
        const found = block.attrs.attributes?.[name];
        return typeof found === "string" ? found.trim() : "";
      };
      const level = /^h[1-6]$/u.test(tag) ? Number(tag.slice(1)) : 0;
      if (level) {
        append(result.outline, [level]);
        result.heading = true;
      } else if (value("role") === "heading") result.heading = true;
      add(inner);
      if (tag === "section" && !inner.heading && !value("aria-label") && !value("aria-labelledby")) {
        if (inner.slots.size) for (const slot of inner.slots) result.needy.add(slot);
        else result.bare++;
      }
    } else if (block.name === "xb/slot") {
      append(result.outline, [block.attrs.name]);
      result.slots.add(block.attrs.name);
    } else if (block.name === "xb/if" || (block.name === "xb/loop" && loopElse(block))) {
      // A loop with {:else} shows its items or its {:else}, like the two branches of an {#if}.
      const branches = block.name === "xb/if" ? block.children.map((branch) => read(branch.children, component)) : [read(block.children.slice(0, -1), component), read(loopElse(block)!.children, component)];
      const shown = branches.reduce<Reading | undefined>((best, branch) => (!best || h1s(branch.outline) > h1s(best.outline) || (h1s(branch.outline) === h1s(best.outline) && branch.outline.length > best.outline.length) ? branch : best), undefined);
      for (const branch of branches) add({ ...branch, outline: branch === shown ? branch.outline : [] });
    } else if (block.name === "xb/loop" || block.name === "xb/branch" || block.name === "xb/slot-fill") {
      add(read(block.children, component));
    } else if (block.name === "xb/component") {
      const called = component(block.attrs.ref);
      const fills = new Map(block.children.map((fill) => [fill.attrs.name, read(fill.children, component)]));
      // What fills a slot the component does not render is not rendered either.
      const rendered = [...fills].filter(([name]) => called.slots.has(name)).map(([, fill]) => fill);
      append(result.outline, filled(called.outline, (slot) => fills.get(slot)?.outline));
      result.heading ||= called.heading || rendered.some((fill) => fill.heading);
      for (const fill of rendered) for (const slot of fill.slots) result.slots.add(slot);
      for (const fill of fills.values()) {
        result.bare += fill.bare;
        for (const slot of fill.needy) result.needy.add(slot);
      }
      // A section of the component around a slot: this markup fills it, so the heading is this document's to give.
      for (const slot of called.needy) {
        const fill = fills.get(slot);
        if (fill?.heading) continue;
        if (fill?.slots.size) for (const forwarded of fill.slots) result.needy.add(forwarded);
        else result.bare++;
      }
    }
  }
  return result;
}

/**
 * The blocks `read` needs, and nothing else: what a component, part or template keeps until every page has read it,
 * and a page read before them. Text goes; an element that is neither a heading, a section nor role="heading" gives way
 * to its children (read adds their reading and nothing of its own); a loop, a branch outside an {#if} or a fill outside
 * a call give way to theirs too; an {#if} with nothing left goes. So `read` of the result is `read` of the blocks.
 */
function skeleton(blocks: readonly XbBlock[]): XbBlock[] {
  const out: XbBlock[] = [];
  for (const block of blocks) {
    switch (block.name) {
      case "xb/element": {
        const children = skeleton(block.children);
        const tag = block.attrs.tag.toLowerCase();
        const attributes = block.attrs.attributes ?? {};
        const role = attributes.role;
        if (/^h[1-6]$/u.test(tag) || tag === "section" || (typeof role === "string" && role.trim() === "heading")) {
          const kept: Record<string, string> = {};
          for (const name of ["role", "aria-label", "aria-labelledby"]) if (typeof attributes[name] === "string") kept[name] = attributes[name] as string;
          out.push({ name: "xb/element", attrs: { uid: "", tag, attributes: kept }, children });
        } else out.push(...children);
        break;
      }
      case "xb/slot":
        out.push({ name: "xb/slot", attrs: { uid: "", name: block.attrs.name } });
        break;
      case "xb/if": {
        const branches = block.children.map((branch) => ({ name: "xb/branch" as const, attrs: { uid: "" }, children: skeleton(branch.children) }));
        if (branches.some((branch) => branch.children.length)) out.push({ name: "xb/if", attrs: { uid: "" }, children: branches });
        break;
      }
      case "xb/loop": {
        const empty = loopElse(block);
        if (!empty) {
          out.push(...skeleton(block.children));
          break;
        }
        // Items or {:else}, as an {#if} with two branches.
        const branches = [block.children.slice(0, -1), empty.children].map((children) => ({ name: "xb/branch" as const, attrs: { uid: "" }, children: skeleton(children) }));
        if (branches.some((branch) => branch.children.length)) out.push({ name: "xb/if", attrs: { uid: "" }, children: branches });
        break;
      }
      case "xb/branch":
      case "xb/slot-fill":
        out.push(...skeleton(block.children));
        break;
      case "xb/component":
        out.push({ name: "xb/component", attrs: { uid: "", ref: block.attrs.ref }, children: block.children.map((fill) => ({ name: "xb/slot-fill" as const, attrs: { uid: "", name: fill.attrs.name }, children: skeleton(fill.children) })) });
        break;
      default:
        break;
    }
  }
  return out;
}

/** The components and parts some blocks call, by ref, without recursion. */
function callsIn(blocks: readonly XbBlock[]): string[] {
  const calls: string[] = [];
  const stack: XbBlock[] = [...blocks];
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if (block.name === "xb/component") calls.push(block.attrs.ref);
    if ("children" in block) for (const child of block.children as XbBlock[]) stack.push(child);
  }
  return calls;
}

const nonBlank = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
/** Text with the inline tags folded into it left out. */
const withoutTags = (text: string): string => text.replace(/<[^>]*>/gu, "");

/**
 * Whether a link's content gives it a name, as a browser reads the markup written: text (an expression, an {#if}, a loop
 * or a slot written in braces is text there), the alt of an image, or what is written inside a component's tags.
 */
function named(blocks: readonly XbBlock[]): boolean {
  const stack: XbBlock[] = [...blocks];
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if (block.name === "xb/text") {
      if (withoutTags(block.attrs.content).trim()) return true;
    } else if (block.name === "xb/element") {
      if (block.attrs.tag.toLowerCase() === "img" && nonBlank(block.attrs.attributes?.alt)) return true;
      stack.push(...block.children);
    } else if (block.name === "xb/component") {
      for (const fill of block.children) stack.push(...fill.children);
    } else if (block.name !== "xb/slot-fill" && block.name !== "xb/branch") return true;
  }
  return false;
}

/** The links folded into a text run (`<a href="…">…</a>`, with no other attribute than href, target and rel) that have no text. */
function emptyTextLinks(text: string): number {
  let count = 0;
  for (let at = text.indexOf("<a"); at !== -1; at = text.indexOf("<a", at + 2)) {
    const after = text[at + 2];
    if (after !== ">" && after !== " " && after !== "\t" && after !== "\n" && after !== "\r" && after !== "\f") continue;
    const open = text.indexOf(">", at);
    const close = open === -1 ? -1 : text.indexOf("</a>", open);
    if (close === -1) break;
    if (!withoutTags(text.slice(open + 1, close)).trim()) count++;
    at = close;
  }
  return count;
}

/** The images without alt and the links without a name that some blocks write. */
function imagesAndLinks(blocks: readonly XbBlock[]): { alt: number; links: number } {
  let alt = 0;
  let links = 0;
  const stack: XbBlock[] = [...blocks];
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if (block.name === "xb/element") {
      const tag = block.attrs.tag.toLowerCase();
      const attributes = block.attrs.attributes ?? {};
      if (tag === "img" && attributes.alt === undefined) alt++;
      if (tag === "a" && !nonBlank(attributes["aria-label"]) && !nonBlank(attributes.title) && !named(block.children)) links++;
    } else if (block.name === "xb/text" && block.attrs.verbatim !== true) links += emptyTextLinks(block.attrs.content);
    if ("children" in block) stack.push(...(block.children as XbBlock[]));
  }
  return { alt, links };
}

/** A text run with a link folded into it. */
const TEXT_LINK = /<a[\t\n\f\r />]/iu;

/** The links folded into a text run, and those of them that open inside another one of the run. */
function textLinks(text: string): { links: number; nested: number } {
  let links = 0;
  let nested = 0;
  let depth = 0;
  for (const tag of text.matchAll(/<(\/?)a(?=[\t\n\f\r />])[^>]*>/giu)) {
    if (tag[1]) depth = Math.max(0, depth - 1);
    else {
      links++;
      if (depth > 0) nested++;
      depth++;
    }
  }
  return { links, nested };
}

/** What a document writes about links inside links (doc 17): its own, and what its calls may add once all are read. */
interface NestedLinks {
  /** Links written inside a link of the same document. */
  nested: number;
  /** Whether it writes a link anywhere (a component that does renders one wherever it is called). */
  hasLink: boolean;
  /** Whether a slot is inside one of its links: what a call puts there is inside a link. */
  slotInLink: boolean;
  /** Its calls: inside one of its links, and whether what it puts in their slots has a link. */
  calls: Array<{ ref: string; inLink: boolean; fillLink: boolean }>;
}

function nestedLinks(blocks: readonly XbBlock[]): NestedLinks {
  const out: NestedLinks = { nested: 0, hasLink: false, slotInLink: false, calls: [] };
  const hasLink = (list: readonly XbBlock[]): boolean => list.some((block) => (block.name === "xb/element" && block.attrs.tag.toLowerCase() === "a") || (block.name === "xb/text" && block.attrs.verbatim !== true && TEXT_LINK.test(block.attrs.content)) || ("children" in block && hasLink(block.children as XbBlock[])));
  const walk = (list: readonly XbBlock[], inLink: boolean): void => {
    for (const block of list) {
      if (block.name === "xb/element") {
        const link = block.attrs.tag.toLowerCase() === "a";
        if (link) {
          out.hasLink = true;
          if (inLink) out.nested++;
        }
        walk(block.children, inLink || link);
      } else if (block.name === "xb/text") {
        if (block.attrs.verbatim !== true && TEXT_LINK.test(block.attrs.content)) {
          const found = textLinks(block.attrs.content);
          out.hasLink ||= found.links > 0;
          out.nested += inLink ? found.links : found.nested;
        }
      } else if (block.name === "xb/slot") {
        if (inLink) out.slotInLink = true;
      } else if (block.name === "xb/component") {
        out.calls.push({ ref: block.attrs.ref, inLink, fillLink: block.children.some((fill) => hasLink(fill.children)) });
        walk(block.children, inLink);
      } else if ("children" in block) walk(block.children as XbBlock[], inLink);
    }
  };
  walk(blocks, false);
  return out;
}

/** The DSL blocks of a document; none when it does not parse (the import refused it already, a warning never throws). */
function blocksOf(source: string): XbBlock[] {
  try {
    return parseDsl(source).blocks;
  } catch {
    return [];
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A language tag as the project stores it, in lower case to compare; none for a missing or invalid one. */
function canonicalLocale(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The renderer's limits (static-renderer.ts, renderCmsPage): a block more than 64 levels down, a {#loop} inside six
 * others, a component called with 16 already open stop the build of the page. They count through what a page renders:
 * its template (applied as a call, its blocks one level down), the components and parts it calls, what fills their
 * slots (one level below the slot, with the loops around the slot, and in the caller's chain of components). Each is
 * known before the build, as the most any branch of an {#if} and any loop's body reaches (a loop with no item renders
 * nothing, but its blocks are the document's).
 */
const MAX_BLOCK_DEPTH = 64;
const MAX_LOOP_DEPTH = 6;
const MAX_COMPONENT_DEPTH = 16;

/**
 * What blocks render to, for those limits: a block holding no loop, slot or call is only how many levels it holds
 * (`leaf`); any other keeps its children, one level down (`nest`, a loop counting one loop more), its slot or its call.
 */
type Depth =
  | { kind: "leaf"; height: number }
  | { kind: "nest"; loop: boolean; children: Depth[] }
  | { kind: "slot"; name: string }
  | { kind: "call"; ref: string; fills: Array<{ name: string; children: Depth[] }> };

function nest(loop: boolean, children: Depth[]): Depth {
  if (loop || !children.every((child) => child.kind === "leaf")) return { kind: "nest", loop, children };
  // Thousands of children are no spread of arguments.
  let height = 0;
  for (const child of children) height = Math.max(height, 1 + (child as { height: number }).height);
  return { kind: "leaf", height };
}

function depthSkeleton(blocks: readonly XbBlock[]): Depth[] {
  return blocks.flatMap((block): Depth | Depth[] => {
    switch (block.name) {
      case "xb/slot": return { kind: "slot", name: block.attrs.name };
      case "xb/component": return { kind: "call", ref: block.attrs.ref, fills: block.children.map((fill) => ({ name: fill.attrs.name, children: depthSkeleton(fill.children) })) };
      // One branch renders, its blocks one level below the {#if}: the deepest of them all.
      case "xb/if": return nest(false, block.children.flatMap((branch) => depthSkeleton(branch.children)));
      case "xb/loop": {
        // Its {:else} renders one level down too, but outside the loop (static-renderer.ts): a sibling with no loop.
        const empty = loopElse(block);
        return empty ? [nest(true, depthSkeleton(block.children.slice(0, -1))), nest(false, depthSkeleton(empty.children))] : nest(true, depthSkeleton(block.children));
      }
      default: return nest(false, "children" in block ? depthSkeleton(block.children as XbBlock[]) : []);
    }
  });
}

/** How far some blocks reach: their deepest level, their most loops one inside another, their longest chain of components, and where each slot renders. */
interface Reach {
  depth: number;
  loops: number;
  chain: number;
  slots: Map<string, { depth: number; loops: number }>;
}

/** Reads `nodes` rendered `depth` levels down, inside `loops` loops, with `stack` components open; callees by their reach. */
function reach(nodes: readonly Depth[], depth: number, loops: number, stack: number, callee: (ref: string) => Reach | undefined, into: Reach): Reach {
  for (const node of nodes) {
    into.depth = Math.max(into.depth, depth);
    if (node.kind === "leaf") into.depth = Math.max(into.depth, depth + node.height);
    else if (node.kind === "nest") {
      const inside = loops + (node.loop ? 1 : 0);
      into.loops = Math.max(into.loops, inside);
      reach(node.children, depth + 1, inside, stack, callee, into);
    } else if (node.kind === "slot") {
      const at = into.slots.get(node.name);
      into.slots.set(node.name, { depth: Math.max(at?.depth ?? 0, depth), loops: Math.max(at?.loops ?? 0, loops) });
    } else {
      const called = callee(node.ref);
      if (!called) continue;
      into.depth = Math.max(into.depth, depth + called.depth);
      into.loops = Math.max(into.loops, loops + called.loops);
      into.chain = Math.max(into.chain, stack + called.chain);
      // What fills a slot renders below it, in the caller's chain; a slot the component does not have renders nothing.
      for (const fill of node.fills) {
        const slot = called.slots.get(fill.name);
        if (slot) reach(fill.children, depth + slot.depth + 1, loops + slot.loops, stack, callee, into);
      }
    }
  }
  return into;
}

const emptyReach = (): Reach => ({ depth: 0, loops: 0, chain: 0, slots: new Map() });

/** What one page or post gives the checks of headings and sections, as rendered in its template. */
interface PageResult {
  h1: number;
  skip?: string;
  /** Its template wraps its content in a section without a heading, and the content brings none. */
  bare: boolean;
}

/** What one document gives the checks, kept until they are put together in the order of the file. */
interface DocumentResult {
  alt: number;
  links: number;
  nesting: NestedLinks;
  /** Its own sections without a heading; for a component, part or template known once all of them are read. */
  bare?: number;
  page?: PageResult;
  /** How far a page or a post reaches in its template, for the renderer's limits. */
  reach?: Reach;
}

const KINDS: ReadonlySet<string> = new Set(["page", "post", "component", "part", "template"]);

/**
 * The checks, document by document as the import parses them (add), put together at the end (warnings). A component,
 * part or template keeps what its headings need (skeleton) until every one is read, since a page renders them; a page
 * read once they all are is checked at once and keeps nothing. Without the import, prototypeQualityWarnings parses.
 */
export class PrototypeQuality {
  private readonly locale: string | undefined;
  private readonly documents: readonly QualityDocument[];
  private readonly content: Record<string, unknown>;
  /** Components, parts and templates by their data-ref; each read once, a component however many call it. */
  private readonly reusable = new Map<string, QualityDocument>();
  private readonly roles = new Map<string, string>();
  private readonly skeletons = new Map<QualityDocument, XbBlock[]>();
  private readonly depths = new Map<QualityDocument, Depth[]>();
  /** Pages and posts read before every component was: their skeletons, checked at the end. */
  private readonly waiting = new Map<QualityDocument, { blocks: XbBlock[]; depths: Depth[] }>();
  private readonly results = new Map<QualityDocument, DocumentResult>();
  private readings: Map<QualityDocument, Reading> | undefined;
  private reaches: Map<QualityDocument, Reach> | undefined;
  private completed = false;

  constructor(input: { locale?: string; documents: readonly QualityDocument[]; content?: Record<string, unknown> }) {
    this.locale = input.locale;
    this.documents = input.documents;
    this.content = input.content ?? {};
    for (const document of input.documents) {
      if (document.kind !== "component" && document.kind !== "part" && document.kind !== "template") continue;
      const ref = document.attributes["data-ref"]?.trim();
      if (!ref || this.reusable.has(ref)) continue;
      this.reusable.set(ref, document);
      const role = document.attributes["data-role"];
      if (document.kind === "template" && role !== undefined && !this.roles.has(role)) this.roles.set(role, ref);
    }
  }

  /** One document, from the blocks it was parsed into. */
  add(document: QualityDocument, blocks: readonly XbBlock[]): void {
    if (!KINDS.has(document.kind) || this.results.has(document)) return;
    const result: DocumentResult = { ...imagesAndLinks(blocks), nesting: nestedLinks(blocks) };
    this.results.set(document, result);
    const ref = document.attributes["data-ref"]?.trim();
    if (document.kind !== "page" && document.kind !== "post" && ref !== undefined && this.reusable.get(ref) === document) {
      this.skeletons.set(document, skeleton(blocks));
      this.depths.set(document, depthSkeleton(blocks));
    } else if (this.skeletons.size === this.reusable.size) this.finish(document, result, read(blocks, this.component), depthSkeleton(blocks));
    else this.waiting.set(document, { blocks: skeleton(blocks), depths: depthSkeleton(blocks) });
  }

  /**
   * How far a component, part or template reaches when called: its blocks one level below the call, its own chain of
   * components counted. Callees first, without recursion; one that calls itself, refused by the import, reads as nothing
   * where it closes the circle.
   */
  private reachOf = (ref: string): Reach | undefined => {
    const called = this.reusable.get(ref);
    if (!called) return undefined;
    if (!this.reaches) {
      const reaches = new Map<QualityDocument, Reach>();
      this.reaches = reaches;
      const visited = new Set<QualityDocument>();
      const lookup = (name: string) => {
        const item = this.reusable.get(name);
        return item ? reaches.get(item) : undefined;
      };
      const callsOf = (nodes: readonly Depth[]): string[] => {
        const calls: string[] = [];
        const stack = [...nodes];
        for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
          if (node.kind === "nest") stack.push(...node.children);
          else if (node.kind === "call") {
            calls.push(node.ref);
            for (const fill of node.fills) stack.push(...fill.children);
          }
        }
        return calls;
      };
      for (const start of this.reusable.values()) {
        if (visited.has(start)) continue;
        visited.add(start);
        const work = [{ item: start, calls: callsOf(this.depths.get(start) ?? []), next: 0 }];
        for (let top = work.at(-1); top !== undefined; top = work.at(-1)) {
          const call = top.calls[top.next++];
          if (call !== undefined) {
            const callee = this.reusable.get(call);
            if (callee && !visited.has(callee)) {
              visited.add(callee);
              work.push({ item: callee, calls: callsOf(this.depths.get(callee) ?? []), next: 0 });
            }
            continue;
          }
          work.pop();
          reaches.set(top.item, reach(this.depths.get(top.item) ?? [], 1, 0, 1, lookup, { ...emptyReach(), chain: 1 }));
        }
      }
    }
    return this.reaches.get(called);
  };

  /** How far a page reaches as the build renders it: in its template, applied as a call, or alone from the top. */
  private pageReach(template: string | undefined, depths: Depth[]): Reach {
    const nodes: Depth[] = template ? [{ kind: "call", ref: template, fills: [{ name: DEFAULT_SLOT, children: depths }] }] : depths;
    return reach(nodes, 0, 0, 0, this.reachOf, emptyReach());
  }

  /** What a component or part renders, once every one is read: callees first, without recursion. */
  private readonly component = (ref: string): Reading => {
    const called = this.reusable.get(ref);
    return called && called.kind !== "template" ? this.read(called) : EMPTY;
  };

  private read(document: QualityDocument): Reading {
    if (!this.readings) {
      const readings = new Map<QualityDocument, Reading>();
      this.readings = readings;
      // A chain of thousands of components, each calling the previous, must not exhaust the stack. One that calls
      // itself, through others or not, is refused by the import: here what closes the circle reads as nothing.
      const visited = new Set<QualityDocument>();
      const frame = (item: QualityDocument) => {
        visited.add(item);
        const blocks = this.skeletons.get(item) ?? [];
        return { item, blocks, calls: callsIn(blocks), next: 0 };
      };
      const lookup = (ref: string): Reading => {
        const called = this.reusable.get(ref);
        return called && called.kind !== "template" ? readings.get(called) ?? EMPTY : EMPTY;
      };
      for (const start of this.reusable.values()) {
        if (visited.has(start)) continue;
        const stack = [frame(start)];
        for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
          const call = top.calls[top.next++];
          if (call !== undefined) {
            const callee = this.reusable.get(call);
            if (callee && callee.kind !== "template" && !visited.has(callee)) stack.push(frame(callee));
            continue;
          }
          stack.pop();
          readings.set(top.item, read(top.blocks, lookup));
        }
      }
    }
    return this.readings.get(document) ?? EMPTY;
  }

  private role(...list: string[]): string | undefined {
    return list.map((item) => this.roles.get(item)).find((ref) => ref !== undefined);
  }

  /** The template a page or a post renders with, as the build resolves it (cms-api.ts, documentTemplateRef). */
  private templateOf(document: QualityDocument): string | undefined {
    const named = document.attributes["data-template"];
    const declared = named !== undefined && this.reusable.get(named)?.kind === "template" ? named : undefined;
    if (document.kind === "post") return declared ?? this.role("single", "index");
    if (document.attributes["data-slug"] === "home") return this.role("front-page") ?? declared ?? this.role("page", "index");
    return declared ?? this.role("page", "index");
  }

  /** Headings and sections of one page as it renders: `own` is what the page writes, in its template's default slot. */
  private checkPage(template: string | undefined, own: Reading | undefined): PageResult {
    const frame = template ? this.reusable.get(template) : undefined;
    const around = frame ? this.read(frame) : undefined;
    const outline = around ? filled(around.outline, (slot) => (slot === DEFAULT_SLOT ? own?.outline : undefined)) : own?.outline ?? [];
    const headings = outline.filter((item): item is number => typeof item === "number");
    let skip: string | undefined;
    for (let index = 1; index < headings.length && skip === undefined; index++) {
      const previous = headings[index - 1] as number;
      const current = headings[index] as number;
      if (current > previous + 1) skip = `da h${previous} a h${current}`;
    }
    // The template's section around the page's content: the page must bring the heading.
    return { h1: headings.filter((level) => level === 1).length, ...(skip ? { skip } : {}), bare: Boolean(around?.needy.has(DEFAULT_SLOT) && !own?.heading) };
  }

  /** A document whose reading is known: its sections, and as a page or a post its headings and its reach in its template. */
  private finish(document: QualityDocument, result: DocumentResult, own: Reading, depths?: Depth[]): void {
    result.bare = own.bare;
    if (document.kind !== "page" && document.kind !== "post") return;
    const template = this.templateOf(document);
    result.page = this.checkPage(template, own);
    if (depths) result.reach = this.pageReach(template, depths);
  }

  /** Every document read: the pages that waited for the components, the sections of the components themselves. */
  private complete(): void {
    if (this.completed) return;
    this.completed = true;
    for (const [document, { blocks, depths }] of this.waiting) this.finish(document, this.results.get(document)!, read(blocks, this.component), depths);
    this.waiting.clear();
    for (const document of this.skeletons.keys()) this.finish(document, this.results.get(document)!, this.read(document));
  }

  /**
   * The pages the build makes from a template alone, the archives exactly as cms-api.ts plans them (planCmsRoutes, by the
   * rules of content-model.ts): each type's records; its archive, in the site's language even with no record unless a
   * published page takes its address, and in another language with a record published in it; the archive of every term
   * of a taxonomy attached to a type or to posts, which each term has in the site's language, empty too; the posts index
   * when there is a post, a draft too, and no published page «blog» (cmsPostsIndexWritten); the 404. Without a
   * template the build writes a page of its own.
   */
  private generated(): Array<{ name: string; template: string | undefined }> {
    const content = this.content;
    const list = (key: string) => (Array.isArray(content[key]) ? (content[key] as unknown[]).filter(isObject) : []);
    const records = list("records");
    const posts = this.documents.filter((document) => document.kind === "post");
    // The pages the build writes, the published ones: a draft takes no address.
    const pageSlugs = new Set(this.documents.filter((document) => document.kind === "page" && document.attributes["data-status"] !== "draft").map((document) => document.attributes["data-slug"]));
    const published = (status: unknown) => status === undefined || status === null || status === "published";
    const site = canonicalLocale(this.locale);
    const otherLanguage = (record: Record<string, unknown>) => site !== undefined && typeof record.locale === "string" && canonicalLocale(record.locale) !== site;
    const generated: Array<{ name: string; template: string | undefined }> = [];
    const declared = (value: unknown) => (typeof value === "string" && this.reusable.get(value)?.kind === "template" ? value : undefined);
    const typeKeys = new Set<string>();
    for (const type of list("types")) {
      if (typeof type.key !== "string") continue;
      typeKeys.add(type.key);
      const own = records.filter((record) => record.type === type.key && published(record.status));
      if (own.length) generated.push({ name: `i record di ${type.key}`, template: declared(type.singleTemplate) ?? this.role("single", "index") });
      if (!pageSlugs.has(type.key) || own.some(otherLanguage)) generated.push({ name: `l'archivio di ${type.key}`, template: declared(type.archiveTemplate) ?? this.role("archive", "index") });
    }
    const terms = list("terms");
    for (const taxonomy of list("taxonomies")) {
      const key = taxonomy.key;
      if (typeof key !== "string") continue;
      const attached = Array.isArray(taxonomy.types) && taxonomy.types.some((type) => type === "post" || (typeof type === "string" && typeKeys.has(type)));
      if (attached && terms.some((term) => term.taxonomy === key)) generated.push({ name: `i termini di ${key}`, template: this.role(...cmsTermArchiveRoles(key)) });
    }
    if (cmsPostsIndexWritten({ posts: posts.length, blogPage: pageSlugs.has("blog") })) generated.push({ name: "il blog", template: this.role("home", "index") });
    generated.push({ name: "la pagina 404", template: this.role("404") });
    return generated;
  }

  /**
   * The pages that pass a limit of the renderer, the static build stopping on them: each page or post at its document,
   * each page the build makes from a template alone at the template. The import says them as warnings of the build.
   */
  limits(): Array<{ document: string; line?: number; message: string }> {
    this.complete();
    const problems: Array<{ document: string; line?: number; message: string }> = [];
    const check = (document: QualityDocument, reached: Reach, template: string | undefined, generated?: string) => {
      const name = `${document.kind} ${document.attributes["data-slug"] ?? document.attributes["data-ref"] ?? "?"}`;
      const where = generated ? `per ${generated}, ${template} e quello che chiama` : template ? `nel template ${template}, con i componenti e le parti che chiama` : "con i componenti e le parti che chiama";
      const said = (message: string) => problems.push({ document: name, ...(document.line ? { line: document.line } : {}), message });
      if (reached.depth > MAX_BLOCK_DEPTH) said(`${where}, un blocco arriva a ${reached.depth} livelli uno dentro l'altro: la build del sito si ferma oltre ${MAX_BLOCK_DEPTH}. Togli i livelli che non servono (un div che contiene solo un altro div, un componente che ne avvolge un altro).`);
      if (reached.loops > MAX_LOOP_DEPTH) said(`${where}, ${reached.loops} {#loop} stanno uno dentro l'altro: la build del sito si ferma oltre ${MAX_LOOP_DEPTH}.`);
      if (reached.chain > MAX_COMPONENT_DEPTH) said(`${where}, ${reached.chain} componenti stanno uno dentro l'altro${template && !generated ? ", il template compreso" : ""}: la build del sito si ferma oltre ${MAX_COMPONENT_DEPTH}.`);
    };
    for (const document of this.documents) {
      const reached = this.results.get(document)?.reach;
      if (reached) check(document, reached, this.templateOf(document));
    }
    for (const page of this.generated()) {
      const template = page.template ? this.reusable.get(page.template) : undefined;
      if (template && page.template) check(template, this.pageReach(page.template, []), page.template, page.name);
    }
    return problems;
  }

  warnings(): string[] {
    const warnings: string[] = [];
    if (!this.locale) warnings.push("SEO e accessibilità: il manifest non dice la lingua (locale), quindi lang delle pagine resta quella predefinita.");
    this.complete();
    const noH1: string[] = [];
    const manyH1: string[] = [];
    const skips: string[] = [];
    const noAlt = new Map<string, number>();
    const emptyLinks = new Map<string, number>();
    const linksInLinks = new Map<string, number>();
    // Whether a component, part or template renders a link wherever it is called: its own or one of its callees'.
    const rendersLink = new Map<string, boolean>();
    const renders = (ref: string, seen: Set<string>): boolean => {
      const known = rendersLink.get(ref);
      if (known !== undefined) return known;
      const callee = this.reusable.get(ref);
      const nesting = callee ? this.results.get(callee)?.nesting : undefined;
      if (!nesting || seen.has(ref)) return false;
      seen.add(ref);
      const value = nesting.hasLink || nesting.calls.some((call) => renders(call.ref, seen));
      rendersLink.set(ref, value);
      return value;
    };
    const bareSections = new Map<string, number>();
    const titles = new Map<string, string[]>();
    const noExcerpt: string[] = [];
    const nameOf = (document: QualityDocument) => document.attributes["data-slug"] ?? document.attributes["data-ref"] ?? document.kind;
    const countIn = (map: Map<string, number>, name: string, count = 1) => {
      if (count) map.set(name, (map.get(name) ?? 0) + count);
    };
    const pageChecks = (name: string, page: PageResult) => {
      if (page.h1 === 0) noH1.push(name);
      if (page.h1 > 1) manyH1.push(name);
      if (page.skip) skips.push(`${name} (${page.skip})`);
      if (page.bare) countIn(bareSections, name);
    };

    for (const document of this.documents) {
      const result = this.results.get(document);
      if (!result) continue;
      const name = nameOf(document);
      countIn(noAlt, name, result.alt);
      countIn(emptyLinks, name, result.links);
      // A link inside a link: written so, a component that renders one called inside a link, or a link put in a slot
      // that a component writes inside one of its links.
      countIn(linksInLinks, name, result.nesting.nested + result.nesting.calls.filter((call) => {
        const callee = this.reusable.get(call.ref);
        return (call.inLink && renders(call.ref, new Set())) || (call.fillLink && callee !== undefined && this.results.get(callee)?.nesting.slotInLink === true);
      }).length);
      // Each section is counted in the document that writes it.
      countIn(bareSections, name, result.bare ?? 0);
      if (document.kind !== "page" && document.kind !== "post") continue;
      const title = (document.attributes["data-title"] ?? "").trim().toLowerCase();
      if (title) titles.set(title, [...(titles.get(title) ?? []), name]);
      if (document.kind === "post" && !(document.attributes["data-excerpt"] ?? "").trim()) noExcerpt.push(name);
      if (result.page) pageChecks(name, result.page);
    }

    // The pages the build makes from a template alone, named by the template to fix: "site/opere per l'archivio di opera".
    for (const page of this.generated()) if (page.template) pageChecks(`${page.template} per ${page.name}`, this.checkPage(page.template, undefined));

    const total = (map: Map<string, number>) => [...map.values()].reduce((sum, value) => sum + value, 0);
    if (noAlt.size) warnings.push(`Accessibilità: ${total(noAlt)} immagini senza alt (in ${names([...noAlt.keys()])}). Per un'immagine decorativa scrivi alt="".`);
    if (emptyLinks.size) warnings.push(`Accessibilità: ${total(emptyLinks)} link senza testo né aria-label (in ${names([...emptyLinks.keys()])}).`);
    if (linksInLinks.size) {
      const count = total(linksInLinks);
      warnings.push(`HTML: ${count === 1 ? "un link" : `${count} link`} dentro un altro link (in ${names([...linksInLinks.keys()])}): il browser chiude il primo link prima del secondo e la pagina esce rotta. Togli il link interno, o fai del contenitore un elemento che non è un link.`);
    }
    if (noH1.length) warnings.push(`Accessibilità e SEO: ${noH1.length === 1 ? "una pagina" : `${noH1.length} pagine`} senza titolo h1 (${names(noH1)}).`);
    if (manyH1.length) warnings.push(`Accessibilità e SEO: più di un h1 in ${names(manyH1)}.`);
    if (skips.length) warnings.push(`Accessibilità: i titoli saltano un livello in ${names(skips)}.`);
    if (bareSections.size) {
      const count = total(bareSections);
      warnings.push(`Accessibilità: ${count === 1 ? "una section" : `${count} section`} senza titolo né aria-label (in ${names([...bareSections.keys()])}): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div.`);
    }
    const duplicates = [...titles.values()].filter((list) => list.length > 1).flat();
    if (duplicates.length) warnings.push(`SEO: pagine con lo stesso titolo (${names(duplicates)}): i risultati di ricerca non le distinguono.`);
    if (noExcerpt.length) warnings.push(`SEO: ${noExcerpt.length === 1 ? "un articolo" : `${noExcerpt.length} articoli`} senza riassunto, che fa da descrizione (${names(noExcerpt)}).`);
    return warnings;
  }
}

/** The checks of a prototype's documents outside the import, which hands PrototypeQuality the blocks it parsed: each is parsed here once. */
export function prototypeQualityWarnings(input: { locale?: string; documents: readonly QualityDocument[]; content?: Record<string, unknown> }): string[] {
  const quality = new PrototypeQuality(input);
  for (const document of input.documents) quality.add(document, blocksOf(document.source));
  return quality.warnings();
}
