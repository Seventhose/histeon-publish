import { createHash } from "node:crypto";
import postcss from "postcss";
import { keyClass, parseXb, serializeXb, type XbBlock } from "../.generated/histos-dsl/index.js";

/**
 * The sections of a project's pages as a `.xblibrary` file (queue D5), the format of the builder's section library
 * (docs/spec/library.md in the builder): in any Histeon site, Libreria → Importa… adds them, and each one is inserted
 * through the paste dialog, which handles class conflicts. A section is a clip: its markup and the styles of the
 * classes it uses. What another site cannot resolve stays out: components (the receiving site must have them), loops
 * and expressions (queries and data of this project), and media (local to Publish; `url()` in styles too).
 */

const FORMAT = "xb-library";
const VERSION = 1;
const MAX_SECTIONS = 200;
const MAX_CLIP = 2_000_000;
const MEDIA_TAGS = new Set(["img", "picture", "source", "video", "audio"]);

export interface SectionLibraryPage {
  title: string;
  slug: string;
  /** The page's content, as the project stores it (block grammar). */
  content: string;
}

export interface SectionLibraryResult {
  file: { format: string; version: number; site: string; created: string; sections: Array<{ id: string; name: string; clip: string }>; hash: string };
  sections: number;
  notes: string[];
}

/** JSON as WordPress encodes it for the file's hash (JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE). */
function phpJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(`histos-publish:section-library:${seed}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const isElement = (block: XbBlock): block is Extract<XbBlock, { name: "xb/element" }> => block.name === "xb/element";
const childrenOf = (block: XbBlock): XbBlock[] => ("children" in block && Array.isArray(block.children) ? (block.children as XbBlock[]) : []);

/** Why a block cannot travel to another site, or null. */
function blocker(block: XbBlock): "component" | "dynamic" | null {
  if (block.name === "xb/component" || block.name === "xb/slot" || block.name === "xb/slot-fill") return "component";
  if (block.name === "xb/loop" || block.name === "xb/if" || block.name === "xb/branch" || block.name === "xb/post-content") return "dynamic";
  if (block.name === "xb/text" && /(?<!\\)\{/u.test(block.attrs.content)) return "dynamic";
  if (isElement(block) && Object.values(block.attrs.attributes ?? {}).some((value) => typeof value !== "string" || /(?<!\\)\{/u.test(value))) return "dynamic";
  for (const child of childrenOf(block)) {
    const found = blocker(child);
    if (found) return found;
  }
  return null;
}

/** The block without its media; returns how many were dropped. */
function withoutMedia(block: XbBlock): { block: XbBlock; dropped: number } {
  let dropped = 0;
  const visit = (item: XbBlock): XbBlock | null => {
    if (isElement(item) && MEDIA_TAGS.has(item.attrs.tag)) {
      dropped++;
      return null;
    }
    if (!("children" in item) || !Array.isArray(item.children)) return item;
    return { ...item, children: (item.children as XbBlock[]).map(visit).filter((child): child is XbBlock => child !== null) } as XbBlock;
  };
  return { block: visit(block) ?? block, dropped };
}

function classesOf(block: XbBlock, out = new Set<string>()): Set<string> {
  if (isElement(block)) {
    const value = block.attrs.attributes?.class;
    if (typeof value === "string") for (const name of value.split(/\s+/u)) if (name) out.add(name);
  }
  for (const child of childrenOf(block)) classesOf(child, out);
  return out;
}

function elementCount(block: XbBlock): number {
  return (isElement(block) ? 1 : 0) + childrenOf(block).reduce((total, child) => total + elementCount(child), 0);
}

/** A style without what loads files (url(), image-set()), which point at media of this project. */
function portableCss(css: string): { css: string; dropped: boolean } {
  let dropped = false;
  try {
    const root = postcss.parse(css);
    root.walkDecls((declaration) => {
      if (/url\s*\(|image-set/iu.test(declaration.value)) {
        dropped = true;
        declaration.remove();
      }
    });
    return { css: root.toString(), dropped };
  } catch {
    return { css: "", dropped: true };
  }
}

export function sectionLibrary(input: { projectId: string; projectName: string; pages: readonly SectionLibraryPage[]; styles: ReadonlyArray<{ selector: string; css: string }>; created: string }): SectionLibraryResult {
  const sections: SectionLibraryResult["file"]["sections"] = [];
  let withComponents = 0;
  let dynamic = 0;
  let media = 0;
  let cssMedia = 0;
  let overflow = 0;
  const origin = input.projectName.trim().slice(0, 120) || "Histeon Publish";
  for (const page of input.pages) {
    let roots: XbBlock[];
    try {
      roots = parseXb(page.content).blocks;
    } catch {
      continue;
    }
    // A page wrapped in one <main> (or <div>) offers what is inside it.
    const elements = roots.filter(isElement);
    const top = elements.length === 1 && roots.every((block) => isElement(block) || (block.name === "xb/text" && !block.attrs.content.trim())) && ["main", "div"].includes(elements[0]?.attrs.tag ?? "") ? childrenOf(elements[0] as XbBlock) : roots;
    for (const [index, block] of top.entries()) {
      if (block.name === "xb/text" || block.name === "xb/raw") continue;
      if (isElement(block) && elementCount(block) < 2) continue;
      const why = blocker(block);
      if (why === "component") {
        withComponents++;
        continue;
      }
      if (why === "dynamic") {
        dynamic++;
        continue;
      }
      if (!isElement(block)) continue;
      if (sections.length >= MAX_SECTIONS) {
        overflow++;
        continue;
      }
      const portable = withoutMedia(block);
      media += portable.dropped;
      const used = classesOf(portable.block);
      const styles = input.styles.filter((style) => {
        const key = keyClass(style.selector);
        return key !== null && used.has(key);
      }).map((style) => {
        const cleaned = portableCss(style.css);
        if (cleaned.dropped) cssMedia++;
        return { selector: style.selector, css: cleaned.css };
      });
      const clip = JSON.stringify({ xb: "clip", version: 1, origin, markup: serializeXb([portable.block]), styles });
      if (clip.length > MAX_CLIP) {
        overflow++;
        continue;
      }
      const firstClass = [...used][0];
      const label = block.attrs.label?.trim() || `${block.attrs.tag}${firstClass ? `.${firstClass}` : ""}`;
      sections.push({ id: stableUuid(`${input.projectId}:${page.slug}:${index}`), name: `${page.title.trim() || page.slug} · ${label}`.slice(0, 100), clip });
    }
  }
  const notes: string[] = [];
  if (withComponents) notes.push(`${withComponents} ${withComponents === 1 ? "sezione usa componenti ed è rimasta fuori" : "sezioni usano componenti e sono rimaste fuori"}: il sito che le riceve dovrebbe già averli`);
  if (dynamic) notes.push(`${dynamic} ${dynamic === 1 ? "sezione con loop o espressioni è rimasta fuori" : "sezioni con loop o espressioni sono rimaste fuori"}: dipendono da dati di questo progetto`);
  if (media) notes.push(`${media} ${media === 1 ? "immagine tolta" : "immagini tolte"}: i media non viaggiano nella libreria, caricali nel sito che riceve`);
  if (cssMedia) notes.push(`${cssMedia} ${cssMedia === 1 ? "stile" : "stili"} senza le dichiarazioni con url(), che puntavano a media di questo progetto`);
  if (overflow) notes.push(`${overflow} ${overflow === 1 ? "sezione rimasta fuori" : "sezioni rimaste fuori"}: la libreria tiene al massimo ${MAX_SECTIONS} sezioni di 2 MB`);
  return {
    file: { format: FORMAT, version: VERSION, site: `histos-publish:${input.projectId}`, created: input.created, sections, hash: createHash("sha256").update(phpJson(sections)).digest("hex") },
    sections: sections.length,
    notes,
  };
}
