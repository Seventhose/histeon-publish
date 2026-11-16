import { parseXb, serializeXb, type XbBlock } from "../.generated/histos-dsl/index.js";

/**
 * Segments (doc 20 §5.2): the translatable texts of a document, each with an id that survives editing. A translation is
 * rebuilt from the original's structure with translated texts, so whoever translates never writes markup.
 */

export interface TranslationSegment {
  id: string;
  text: string;
}

export const MAX_SEGMENT_BYTES = 64 * 1024;
export const MAX_DOCUMENT_SEGMENTS = 4000;

const TEXT_ATTRIBUTES = ["alt", "title", "placeholder", "aria-label"] as const;

/** Text worth translating: something other than spaces and expressions. */
function translatable(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\{[^{}]*\}/gu, ""));
}

function walk(blocks: XbBlock[], visit: (block: XbBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    if ("children" in block && Array.isArray(block.children)) walk(block.children as XbBlock[], visit);
  }
}

/** The texts of a document, in reading order: text blocks, visible attributes, text props of components. */
export function documentSegments(content: string, textProp: (ref: string, name: string) => boolean = () => true): TranslationSegment[] {
  const segments: TranslationSegment[] = [];
  const add = (id: string, text: string): void => {
    if (translatable(text)) segments.push({ id, text });
  };
  walk(parseXb(content).blocks, (block) => {
    if (block.name === "xb/text" && !block.attrs.verbatim) add(`${block.attrs.uid}:text`, block.attrs.content);
    if (block.name === "xb/element") {
      const tag = block.attrs.tag.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "svg") return;
      for (const name of TEXT_ATTRIBUTES) {
        const value = block.attrs.attributes?.[name];
        if (typeof value === "string") add(`${block.attrs.uid}:attr:${name}`, value);
      }
    }
    if (block.name === "xb/component") {
      for (const [name, value] of Object.entries(block.attrs.props ?? {})) if (typeof value === "string" && textProp(block.attrs.ref, name)) add(`${block.attrs.uid}:prop:${name}`, value);
    }
  });
  if (segments.length > MAX_DOCUMENT_SEGMENTS) throw new RangeError(`Il documento ha più di ${MAX_DOCUMENT_SEGMENTS} testi da tradurre.`);
  return segments;
}

function expressions(text: string): string[] {
  return (text.match(/\{[^{}]*\}/gu) ?? []).sort();
}

function tags(text: string): string[] {
  return (text.match(/<[^<>]*>/gu) ?? []).sort();
}

/**
 * Whether `target` may replace `source`: plain text with the same expressions and the same inline tags, so a
 * translation can only change words. Throws with the reason; `label` names the segment.
 */
export function assertSegmentText(source: string, target: unknown, label: string): string {
  if (typeof target !== "string" || !target.trim()) throw new TypeError(`Il testo ${label} è vuoto.`);
  if (new TextEncoder().encode(target).length > MAX_SEGMENT_BYTES) throw new RangeError(`Il testo ${label} supera i 64 kB.`);
  if (/\p{Cc}/u.test(target.replace(/[\n\t\r]/gu, ""))) throw new TypeError(`Il testo ${label} contiene caratteri di controllo.`);
  if (JSON.stringify(expressions(source)) !== JSON.stringify(expressions(target))) throw new TypeError(`Il testo ${label} deve tenere le stesse espressioni dell'originale.`);
  if (JSON.stringify(tags(source)) !== JSON.stringify(tags(target))) throw new TypeError(`Il testo ${label} deve tenere gli stessi tag dell'originale.`);
  if (target.replace(/<[^<>]*>/gu, "").includes("<")) throw new TypeError(`Il testo ${label} contiene una parentesi angolare.`);
  return target;
}

/** `content` with each segment of `texts` in place; an id it does not have is ignored, a text it has stays. */
export function applySegments(content: string, texts: ReadonlyMap<string, string>): string {
  const parsed = parseXb(content);
  const replace = (block: XbBlock): void => {
    if (block.name === "xb/text") {
      const text = texts.get(`${block.attrs.uid}:text`);
      if (text !== undefined) block.attrs.content = text;
    }
    if (block.name === "xb/element" && block.attrs.attributes) {
      for (const name of TEXT_ATTRIBUTES) {
        const text = texts.get(`${block.attrs.uid}:attr:${name}`);
        if (text !== undefined && typeof block.attrs.attributes[name] === "string") block.attrs.attributes[name] = text;
      }
    }
    if (block.name === "xb/component" && block.attrs.props) {
      for (const name of Object.keys(block.attrs.props)) {
        const text = texts.get(`${block.attrs.uid}:prop:${name}`);
        if (text !== undefined && typeof block.attrs.props[name] === "string") block.attrs.props[name] = text;
      }
    }
  };
  walk(parsed.blocks, replace);
  return serializeXb(parsed.blocks);
}

/** A translation's texts by id, what lets a follower be rebuilt on a new structure. */
export function segmentMap(content: string): Map<string, string> {
  return new Map(documentSegments(content).map((segment) => [segment.id, segment.text]));
}

/** The texts of templates, parts and components that a page shows as they are: the candidates for strings. */
export function staticTexts(content: string): string[] {
  const out = new Set<string>();
  for (const segment of documentSegments(content)) {
    if (/\{[^{}]*\}/u.test(segment.text)) continue;
    // A text with inline tags reaches the page as separate text nodes: each is a string of its own.
    for (const piece of segment.text.split(/<[^<>]*>/u)) {
      const text = piece.replace(/\s+/gu, " ").trim();
      if (translatable(text)) out.add(text);
    }
  }
  return [...out];
}
