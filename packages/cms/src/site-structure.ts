import { type ImportChoiceBook, RESERVED_TYPE_KEYS } from "./import-choices.js";
import { sha256Hex } from "./isomorphic.js";

/**
 * The structure of a converted site (queue B3). A static site (B1) arrives "flat": every page repeats its header,
 * its footer and its cards. This module recognises what repeats and, only for what the user chooses, rewrites it the
 * Histeon way: a header and footer equal on every page become template parts with a page template; blocks repeated
 * with the same structure of classes become components, whose differing texts, links and images become props (and a
 * slot for the images of a single use); three or more cards in a row become a content type with records, a query and
 * a loop. Without a choice the pages stay exactly as B1 writes them.
 */

export type SiteNode = SiteText | SiteElement;
export interface SiteText {
  kind: "text";
  text: string;
}
export interface SiteElement {
  kind: "element";
  tag: string;
  /** Attributes already sanitized by the conversion (links rewritten, `src` as `asset:<name>`). */
  attrs: Array<[string, string]>;
  children: SiteNode[];
}

export interface StructureOptions {
  /** Header and footer equal on every page → template parts and a page template. */
  parts?: boolean;
  /** Blocks repeated with the same structure → components. */
  components?: boolean;
  /** Three or more uses of a component in a row → a content type with records and a loop (needs components). */
  lists?: boolean;
}

export interface StructureProposal {
  parts: Array<"header" | "footer">;
  components: Array<{ ref: string; uses: number }>;
  lists: Array<{ type: string; records: number }>;
}

export interface StructuredSite {
  pages: Array<{ slug: string; title: string; template: string | null; markup: string }>;
  /** `<template data-histos="part|template|component">` elements, in this order. */
  documents: string[];
  /** The `content` section, when lists became content types. */
  content: { types: unknown[]; records: unknown[]; queries: unknown[] } | null;
  proposal: StructureProposal;
  notes: string[];
}

export const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "wbr"]);
/** Attributes that may differ between the uses of one component: they become its props. */
const VARYING_ATTRIBUTES = new Set(["href", "src", "alt", "title"]);
/** Tags that are not blocks: they frame the page. */
const FRAME_TAGS = new Set(["header", "footer", "main", "body"]);
/** Active state of a menu item, which differs page by page: left out of the shared header. */
export const ACTIVE_CLASS = /^(?:is-)?(?:active|current|selected)$/iu;
const MIN_USES = 3;
const MAX_COMPONENTS = 30;
/** The shared limits of Histeon CMS and WordPress (site-transfer.ts): props per component, types, records per query. */
const MAX_PROPS = 64;
const MAX_LISTS = 30;
const MAX_LIST_ITEMS = 100;
const MAX_PROP_VALUE = 2_000;
/** An entity written as text ("&copy;"): in a prop it would be decoded once more when rendered. */
const ENTITY_LIKE = /&(?=(?:[a-z][a-z0-9]+|#\d+|#x[\da-f]+);)/giu;
const RECORDS_DATE = "2026-01-01T00:00:00Z";

export function escapeText(value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("{", "\\{").replaceAll("}", "\\}");
  // A backslash at the end would escape what follows (the DSL writes it as an entity too).
  return escaped.endsWith("\\") && !escaped.endsWith("\\\\") ? `${escaped.slice(0, -1)}&#92;` : escaped;
}

export function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function renderAttributes(attrs: ReadonlyArray<[string, string]>): string {
  return attrs.map(([name, value]) => (value === "" && name === "reversed" ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`)).join("");
}

/** The markup of sanitized nodes, as the prototype holds it (B1 writes the same). */
/** The visible text of a node, spaces folded, at most `max` characters. */
export function nodeText(node: SiteNode, max = 120): string {
  let out = "";
  const visit = (current: SiteNode): void => {
    if (out.length > max) return;
    if (current.kind === "text") out += ` ${current.text}`;
    else if (current.tag !== "script" && current.tag !== "style") for (const child of current.children) visit(child);
  };
  visit(node);
  return out.replace(/\s+/gu, " ").trim().slice(0, max);
}

/** An element said in a line, for the context of an import choice (import-choices.ts): tag, where it is, its text. */
export function describeElement(element: SiteElement, ancestors: readonly SiteElement[] = []): string {
  const classes = (node: SiteElement): string => (node.attrs.find(([name]) => name === "class")?.[1] ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join("");
  const near = [...ancestors].reverse().find((ancestor) => classes(ancestor) || ["header", "footer", "main", "nav", "section", "article", "aside"].includes(ancestor.tag));
  const text = nodeText(element);
  const image = element.tag === "img" ? (element.attrs.find(([name]) => name === "src")?.[1] ?? "") : "";
  return [`<${element.tag}${classes(element)}>`, near ? `dentro <${near.tag}${classes(near)}>` : "", text ? `testo: «${text}»` : "", image ? `immagine: ${image}` : ""].filter(Boolean).join("; ");
}

export function renderNodes(nodes: readonly SiteNode[]): string {
  let out = "";
  for (const node of nodes) out += renderNode(node);
  return out;
}

function renderNode(node: SiteNode): string {
  if (node.kind === "text") return escapeText(node.text);
  const attributes = renderAttributes(node.attrs);
  return VOID_TAGS.has(node.tag) ? `<${node.tag}${attributes}>` : `<${node.tag}${attributes}>${renderNodes(node.children)}</${node.tag}>`;
}

const isBlank = (node: SiteNode): boolean => node.kind === "text" && node.text.trim() === "";
const significant = (nodes: readonly SiteNode[]): SiteNode[] => nodes.filter((node) => !isBlank(node));
const attribute = (element: SiteElement, name: string): string | undefined => element.attrs.find(([key]) => key === name)?.[1];

/** The first (or last) element of a page, when it has that tag. */
function edgeElement(nodes: readonly SiteNode[], tag: string, edge: "first" | "last"): SiteElement | null {
  const list = significant(nodes);
  const node = edge === "first" ? list[0] : list.at(-1);
  return node?.kind === "element" && node.tag === tag ? node : null;
}

/** A copy without the active state of menu items (class active/current/selected, aria-current). */
function withoutActiveState(node: SiteNode): { node: SiteNode; changed: boolean } {
  if (node.kind === "text") return { node, changed: false };
  let changed = false;
  const attrs: Array<[string, string]> = [];
  for (const [name, value] of node.attrs) {
    if (name === "aria-current") {
      changed = true;
      continue;
    }
    if (name === "class") {
      const tokens = value.split(/\s+/u).filter(Boolean);
      const kept = tokens.filter((token) => !ACTIVE_CLASS.test(token));
      if (kept.length !== tokens.length) changed = true;
      if (kept.length) attrs.push([name, kept.join(" ")]);
      continue;
    }
    attrs.push([name, value]);
  }
  const children = node.children.map((child) => {
    const copy = withoutActiveState(child);
    changed ||= copy.changed;
    return copy.node;
  });
  return { node: { kind: "element", tag: node.tag, attrs, children }, changed };
}

/** "card-opera" → "CardOpera", "site/header" → "Site.Header": how a document is used in markup. */
function componentTag(ref: string): string {
  return ref.split("/").map((segment) => segment.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")).join(".");
}

/** A component ref from a class: lower-case words that start with a letter, joined by "-". */
function refFromClass(value: string): string {
  const words = value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").split(/[^a-z0-9]+/u).map((word) => word.replace(/^[0-9]+/u, "")).filter(Boolean);
  return words.slice(0, 4).join("-").slice(0, 48).replace(/-+$/u, "") || "blocco";
}

function letters(index: number): string {
  let out = "";
  let value = index;
  do {
    out = String.fromCharCode(97 + (value % 26)) + out;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return out;
}

function slugify(value: string, max = 60): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max).replace(/-+$/u, "");
}

interface Shape {
  signature: string;
  elements: number;
  /** The subtree holds pre or code, where whitespace matters: not a component. */
  preformatted: boolean;
}

/** The shape of every element: tag, fixed attributes, the names of varying ones, the shapes of its children. */
function shapes(pages: ReadonlyArray<{ nodes: SiteNode[] }>): Map<SiteElement, Shape> {
  const out = new Map<SiteElement, Shape>();
  const visit = (node: SiteNode): Shape | null => {
    if (node.kind === "text") return node.text.trim() ? { signature: "#", elements: 0, preformatted: false } : null;
    const children = node.children.map(visit).filter((shape): shape is Shape => shape !== null);
    const fixed = node.attrs.filter(([name]) => !VARYING_ATTRIBUTES.has(name)).map(([name, value]) => `${name}=${value}`).sort();
    const varying = node.attrs.filter(([name]) => VARYING_ATTRIBUTES.has(name)).map(([name]) => name).sort();
    const signature = sha256Hex(JSON.stringify([node.tag, fixed, varying, children.map((child) => child.signature)]));
    const shape = {
      signature,
      elements: 1 + children.reduce((total, child) => total + child.elements, 0),
      preformatted: node.tag === "pre" || node.tag === "code" || children.some((child) => child.preformatted),
    };
    out.set(node, shape);
    return shape;
  };
  for (const page of pages) for (const node of page.nodes) visit(node);
  return out;
}

/** The uses of the candidate shapes, outermost first: a use is not looked into. */
function usesOf(pages: ReadonlyArray<{ nodes: SiteNode[] }>, candidates: ReadonlySet<string>, shapeOf: Map<SiteElement, Shape>): Map<string, SiteElement[]> {
  const uses = new Map<string, SiteElement[]>();
  const visit = (node: SiteNode): void => {
    if (node.kind === "text") return;
    const signature = shapeOf.get(node)?.signature;
    if (signature && candidates.has(signature)) {
      const list = uses.get(signature);
      if (list) list.push(node);
      else uses.set(signature, [node]);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const page of pages) for (const node of page.nodes) visit(node);
  return uses;
}

interface PropSpec {
  key: string;
  type: "string" | "url" | "image";
}

interface ComponentPlan {
  ref: string;
  tag: string;
  signature: string;
  /** The component's markup, with `{props.*}` where uses differ. */
  markup: string;
  props: PropSpec[];
  /** The props of images (source and alternative text): a single use passes the whole image in a slot instead. */
  imageProps: Set<string>;
  /** Per use: prop values, and the slot fills for images of a single use. */
  values: Map<SiteElement, { props: Record<string, string>; slots: Array<{ name: string; markup: string }> }>;
}

const TEXT_PROP: Readonly<Record<string, string>> = { h1: "titolo", h2: "titolo", h3: "titolo", h4: "titolo", h5: "titolo", h6: "titolo", p: "testo", a: "etichetta", li: "voce" };

/** A prop value the markup can hold as it is: no braces (expressions), no backslash, not both kinds of quotes, no media. */
function propValueOk(value: string): boolean {
  return value.length <= MAX_PROP_VALUE && !/[{}\\]/u.test(value) && !(value.includes('"') && value.includes("'")) && !value.includes("asset:");
}

function quoteProp(value: string): string {
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/**
 * A component from uses of one shape: the first use is the model; where the uses differ, a prop. An image whose
 * source differs is a slot for single uses, since an `asset:` cannot travel in a prop; with `withImageProps` (a component
 * of a list) it is also a prop for the loop (`{#if props.immagine}<img src={props.immagine}>{/if}`), which WordPress
 * accepts only after transfer-markup W2. Null when a differing value cannot be a prop.
 */
function planComponent(ref: string, signature: string, uses: SiteElement[], withImageProps: boolean): ComponentPlan | null {
  const props: PropSpec[] = [];
  const imageProps = new Set<string>();
  const names = new Set<string>();
  const values = new Map<SiteElement, { props: Record<string, string>; slots: Array<{ name: string; markup: string }> }>(uses.map((use) => [use, { props: {}, slots: [] }]));
  let slotCount = 0;
  let ok = true;
  const propName = (base: string, type: PropSpec["type"]): string => {
    let name = base;
    for (let counter = 2; names.has(name); counter++) name = `${base}_${counter}`;
    names.add(name);
    props.push({ key: name, type });
    return name;
  };
  const setValues = (key: string, list: string[], fromText = false): void => {
    uses.forEach((use, index) => {
      const value = list[index] ?? "";
      if (!propValueOk(value)) ok = false;
      // Text shows entities as written; a prop is decoded when rendered, so "&copy;" keeps its "&" as "&amp;".
      (values.get(use) as { props: Record<string, string> }).props[key] = fromText ? value.replace(ENTITY_LIKE, "&amp;") : value;
    });
  };

  const render = (model: SiteNode, peers: SiteNode[], parentTag: string): string => {
    if (model.kind === "text") {
      const texts = [model, ...peers].map((node) => (node as SiteText).text.replace(/\s+/gu, " ").trim());
      if (texts.every((text) => text === texts[0])) return escapeText(model.text);
      const key = propName(TEXT_PROP[parentTag] ?? "testo", "string");
      setValues(key, texts, true);
      const lead = /^\s*/u.exec(model.text)?.[0] ?? "";
      const trail = /\s*$/u.exec(model.text)?.[0] ?? "";
      return `${lead ? " " : ""}{props.${key}}${trail ? " " : ""}`;
    }
    const elements = [model, ...peers] as SiteElement[];
    const differs = (name: string): boolean => elements.some((element) => attribute(element, name) !== attribute(model, name));
    if (model.tag === "img" && differs("src") && !withImageProps) {
      const slot = slotCount === 0 ? "media" : `media_${slotCount + 1}`;
      slotCount++;
      elements.forEach((element, index) => {
        (values.get(uses[index] as SiteElement) as { slots: Array<{ name: string; markup: string }> }).slots.push({ name: slot, markup: renderNode(element) });
      });
      return `{@slot ${slot}}`;
    }
    if (model.tag === "img" && differs("src")) {
      const key = propName("immagine", "image");
      imageProps.add(key);
      // The value is the asset itself ("asset:<name>"), checked below: it reaches the markup only through a record.
      elements.forEach((element, index) => {
        const entry = values.get(uses[index] as SiteElement) as { props: Record<string, string> };
        entry.props[key] = attribute(element, "src") ?? "";
      });
      let alt: string;
      if (differs("alt")) {
        const altKey = propName(`${key}_alt`, "string");
        imageProps.add(altKey);
        setValues(altKey, elements.map((element) => attribute(element, "alt") ?? ""));
        alt = ` alt={props.${altKey}}`;
      } else alt = attribute(model, "alt") === undefined ? "" : ` alt="${escapeAttribute(attribute(model, "alt") ?? "")}"`;
      const fixed = model.attrs.filter(([name]) => name !== "src" && name !== "alt");
      const slot = slotCount === 0 ? "media" : `media_${slotCount + 1}`;
      slotCount++;
      elements.forEach((element, index) => {
        (values.get(uses[index] as SiteElement) as { slots: Array<{ name: string; markup: string }> }).slots.push({ name: slot, markup: renderNode(element) });
      });
      return `{#if props.${key}}<img${renderAttributes(fixed)} src={props.${key}}${alt}>{/if}{@slot ${slot}}`;
    }
    let attributes = "";
    for (const [name, value] of model.attrs) {
      if (!VARYING_ATTRIBUTES.has(name) || !differs(name)) {
        attributes += renderAttributes([[name, value]]);
        continue;
      }
      const key = propName(name === "href" ? "link" : name === "alt" ? "alt" : "suggerimento", name === "href" ? "url" : "string");
      setValues(key, elements.map((element) => attribute(element, name) ?? ""));
      attributes += ` ${name}={props.${key}}`;
    }
    if (VOID_TAGS.has(model.tag)) return `<${model.tag}${attributes}>`;
    const peerChildren = peers.map((peer) => significant((peer as SiteElement).children));
    let index = 0;
    let inner = "";
    for (const child of model.children) {
      if (isBlank(child)) {
        inner += escapeText((child as SiteText).text);
        continue;
      }
      inner += render(child, peerChildren.map((list) => list[index] as SiteNode), model.tag);
      index++;
    }
    return `<${model.tag}${attributes}>${inner}</${model.tag}>`;
  };
  const [model, ...peers] = uses;
  if (!model) return null;
  const markup = render(model, peers, "");
  // An image source is an asset: a prop of type image may hold it only through a record (lists); single uses fill the slot.
  for (const prop of props) if (prop.type === "image") for (const entry of values.values()) if (!/^asset:[a-z0-9][a-z0-9-]{0,62}$/u.test(entry.props[prop.key] ?? "")) ok = false;
  if (!ok || props.length > MAX_PROPS) return null;
  return { ref, tag: componentTag(ref), signature, markup, props, imageProps, values };
}

/** A use of a component in a page: props as attributes, images as slot fills. Image props are for loops only. */
function useMarkup(plan: ComponentPlan, element: SiteElement): string {
  const entry = plan.values.get(element);
  if (!entry) return renderNode(element);
  const attributes = plan.props.filter((prop) => !plan.imageProps.has(prop.key)).map((prop) => ` ${prop.key}=${quoteProp(entry.props[prop.key] ?? "")}`).join("");
  if (!entry.slots.length) return `<${plan.tag}${attributes} />`;
  return `<${plan.tag}${attributes}>${entry.slots.map((slot) => `{#slot ${slot.name}}${slot.markup}{/slot}`).join("")}</${plan.tag}>`;
}

function propsJson(props: readonly PropSpec[]): string {
  return JSON.stringify(Object.fromEntries(props.map((prop) => [prop.key, { type: prop.type, default: prop.type === "url" ? "/" : "" }])));
}

function attributeValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Doc 27: a component's props under their answered names, in its markup, its uses' values and its image props. */
function renameProps(plan: ComponentPlan, keyOf: ReadonlyMap<string, string>): void {
  const finalOf = (key: string): string => keyOf.get(key) ?? key;
  // Only the places this file writes a prop: `{props.x}`, `{#if props.x}`, `={props.x}`; site text is left alone.
  plan.markup = plan.markup.replace(/(\{#if |\{|=\{)props\.([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, lead: string, key: string) => `${lead}props.${finalOf(key)}}`);
  plan.props = plan.props.map((prop) => ({ ...prop, key: finalOf(prop.key) }));
  plan.imageProps = new Set([...plan.imageProps].map(finalOf));
  for (const entry of plan.values.values()) entry.props = Object.fromEntries(Object.entries(entry.props).map(([key, value]) => [finalOf(key), value]));
}

export function structureSite(pages: ReadonlyArray<{ slug: string; title: string; nodes: SiteNode[] }>, options: StructureOptions = {}, choices?: { book: ImportChoiceBook; origin: ReadonlyMap<string, string> }): StructuredSite {
  const notes: string[] = [];
  const proposal: StructureProposal = { parts: [], components: [], lists: [] };
  let working = pages.map((page) => ({ ...page, nodes: [...page.nodes] }));

  // ------------------------------------------------------------------ header and footer
  const parts: Array<{ area: "header" | "footer"; markup: string; changed: boolean }> = [];
  if (working.length >= 2) {
    for (const [area, edge] of [["header", "first"], ["footer", "last"]] as const) {
      const found = working.map((page) => edgeElement(page.nodes, area, edge));
      if (found.some((element) => element === null)) continue;
      const raw = (found as SiteElement[]).map((element) => renderNode(element));
      if (raw.every((markup) => markup === raw[0])) {
        proposal.parts.push(area);
        parts.push({ area, markup: raw[0] ?? "", changed: false });
        continue;
      }
      // Different only in the menu's active item: that goes.
      const normalized = (found as SiteElement[]).map((element) => withoutActiveState(element));
      const markups = normalized.map((item) => renderNode(item.node));
      if (markups.some((markup) => markup !== markups[0])) continue;
      proposal.parts.push(area);
      parts.push({ area, markup: markups[0] ?? "", changed: true });
    }
  }
  const usingParts = options.parts === true && parts.length > 0;
  if (usingParts) {
    working = working.map((page) => {
      const edges = new Set(parts.map((part) => edgeElement(page.nodes, part.area, part.area === "header" ? "first" : "last")));
      return { ...page, nodes: page.nodes.filter((node) => !(node.kind === "element" && edges.has(node))) };
    });
    notes.push(`${parts.map((part) => (part.area === "header" ? "testata" : "piè di pagina")).join(" e ")} uguali su tutte le pagine: ora ${parts.length === 1 ? "una parte" : "parti"} di template, con il template «Pagina»`);
    if (parts.some((part) => part.changed)) notes.push("la voce attiva del menu era diversa in ogni pagina: nella parte condivisa non c'è più, si aggiunge dal builder");
  }

  // ------------------------------------------------------------------ repeated blocks
  // Blocks inside the header and footer are not looked at: they become parts, or stay as they are.
  const scope = working.map((page) => ({ ...page, nodes: page.nodes.filter((node) => !(node.kind === "element" && FRAME_TAGS.has(node.tag) && node.tag !== "main")) }));
  const shapeOf = shapes(scope);
  const counts = new Map<string, number>();
  const sample = new Map<string, SiteElement>();
  for (const [element, shape] of shapeOf) {
    if (FRAME_TAGS.has(element.tag) || shape.elements < 3 || shape.preformatted || !attribute(element, "class")?.trim()) continue;
    counts.set(shape.signature, (counts.get(shape.signature) ?? 0) + 1);
    if (!sample.has(shape.signature)) sample.set(shape.signature, element);
  }
  const initial = [...counts].filter(([, count]) => count >= MIN_USES).map(([signature]) => signature);
  /** Shapes that cannot be components (props that do not fit) or come after the first MAX_COMPONENTS. */
  const refused = new Set<string>();
  let uses = new Map<string, SiteElement[]>();
  let plans = new Map<string, ComponentPlan>();
  let overflowComponents = false;
  // Outer blocks hide the inner ones: each round starts again from every candidate but the refused ones, so a block
  // that cannot be a component lets the blocks inside it be; a candidate keeps only if it has its minimum of uses.
  for (let round = 0; round < 12; round++) {
    let candidates = new Set(initial.filter((signature) => !refused.has(signature)));
    for (let step = 0; step < 8; step++) {
      uses = usesOf(scope, candidates, shapeOf);
      const kept = new Set([...candidates].filter((signature) => (uses.get(signature)?.length ?? 0) >= MIN_USES));
      if (kept.size === candidates.size) break;
      candidates = kept;
    }
    const ordered = [...candidates].sort((left, right) => (uses.get(right)?.length ?? 0) - (uses.get(left)?.length ?? 0));
    if (ordered.length > MAX_COMPONENTS) {
      overflowComponents = true;
      for (const signature of ordered.slice(MAX_COMPONENTS)) refused.add(signature);
      continue;
    }
    plans = new Map();
    const usedRefs = new Set(["site/header", "site/footer"]);
    let changed = false;
    for (const signature of ordered) {
      // Doc 27: from the default names of the classes, so a component's default (and its choice's id) stays the same.
      const sampleClass = (attribute(sample.get(signature) as SiteElement, "class") ?? "").split(/\s+/u).map((name) => choices?.origin.get(name) ?? name).join(" ");
      let base = refFromClass(sampleClass);
      // "p", "h1", "b-r" would read as HTML tags (P, H1, BR), which must be lower-case.
      if (!/[a-z]/u.test(componentTag(base))) base = `${base}-blocco`;
      let ref = base;
      for (let counter = 1; usedRefs.has(ref); counter++) ref = `${base}-${letters(counter)}`;
      const plan = planComponent(ref, signature, uses.get(signature) ?? [], false);
      if (!plan) {
        refused.add(signature);
        changed = true;
        continue;
      }
      usedRefs.add(ref);
      plans.set(signature, plan);
    }
    if (!changed) break;
  }
  for (const plan of plans.values()) proposal.components.push({ ref: plan.ref, uses: plan.values.size });
  if (overflowComponents && options.components === true) notes.push(`blocchi ripetuti oltre i primi ${MAX_COMPONENTS} lasciati come sono`);
  const usingComponents = options.components === true && plans.size > 0;

  // ------------------------------------------------------------------ lists
  interface ListPlan { type: string; label: string; query: string; plan: ComponentPlan; items: SiteElement[]; first: SiteElement }
  const lists: ListPlan[] = [];
  // The shop's catalog (`product`) and the taxonomies are reserved too: a list named so would not import.
  const typeKeys = new Set(RESERVED_TYPE_KEYS);
  const typeCounters = new Map<string, number>();
  let longLists = 0;
  let extraLists = 0;
  const findRuns = (nodes: readonly SiteNode[]): void => {
    let run: SiteElement[] = [];
    let runPlan: ComponentPlan | null = null;
    const close = (): void => {
      if (runPlan && run.length > MAX_LIST_ITEMS) longLists++;
      else if (runPlan && run.length >= MIN_USES && lists.length >= MAX_LISTS) extraLists++;
      else if (runPlan && run.length >= MIN_USES) {
        const base = runPlan.ref.slice(0, 40);
        let type = base;
        for (let counter = typeCounters.get(base) ?? 1; typeKeys.has(type); counter++) {
          type = `${base}-${letters(counter)}`;
          typeCounters.set(base, counter + 1);
        }
        typeKeys.add(type);
        const query = `${type.replaceAll("-", "_")}_elenco`;
        lists.push({ type, label: `Elenco ${runPlan.ref}`, query, plan: runPlan, items: run, first: run[0] as SiteElement });
        proposal.lists.push({ type, records: run.length });
      }
      run = [];
      runPlan = null;
    };
    for (const node of nodes) {
      if (isBlank(node)) continue;
      const found = node.kind === "element" ? plans.get(shapeOf.get(node)?.signature ?? "") : undefined;
      // Only a use the plan knows: a block of the same shape inside another one is not.
      const plan = found && node.kind === "element" && found.values.has(node) ? found : undefined;
      if (plan && (plan === runPlan || runPlan === null)) {
        runPlan = plan;
        run.push(node as SiteElement);
        continue;
      }
      close();
      if (plan) {
        runPlan = plan;
        run.push(node as SiteElement);
      } else if (node.kind === "element") findRuns(node.children);
    }
    close();
  };
  for (const page of scope) findRuns(page.nodes);
  const usingLists = usingComponents && options.lists === true && lists.length > 0;
  if (usingComponents && options.lists === true) {
    if (longLists) notes.push(`${longLists === 1 ? "un elenco" : `${longLists} elenchi`} oltre ${MAX_LIST_ITEMS} elementi ${longLists === 1 ? "resta fatto" : "restano fatti"} di componenti: una query ne mostra al massimo ${MAX_LIST_ITEMS}`);
    if (extraLists) notes.push(`elenchi oltre i primi ${MAX_LISTS} lasciati come componenti`);
  }
  const listOf = new Map<SiteElement, ListPlan>();
  if (usingLists) {
    // Components of a list carry their images as props too, for the loop.
    const inLists = new Set(lists.map((list) => list.plan.signature));
    const withoutLoop = new Set<string>();
    for (const signature of inLists) {
      const previous = plans.get(signature) as ComponentPlan;
      const replanned = planComponent(previous.ref, signature, uses.get(signature) ?? [], true);
      // A loop cannot fill slots: without image props the list would lose its images, so it stays as uses.
      if (replanned) plans.set(signature, replanned);
      else withoutLoop.add(signature);
    }
    for (const list of lists) {
      if (withoutLoop.has(list.plan.signature)) continue;
      list.plan = plans.get(list.plan.signature) as ComponentPlan;
      for (const item of list.items) listOf.set(item, list);
    }
    if (withoutLoop.size) notes.push("un elenco le cui immagini non possono diventare prop resta fatto di componenti");
  }

  // ------------------------------------------------------------------ names (doc 27)
  // The components, props and content types this conversion writes are choices: an answer replaces a default name
  // where it fits the rules and collides with nothing; the defaults above were made without looking at any answer.
  if (choices && usingComponents) {
    const finalPlans = [...plans.values()];
    const refs = choices.book.pickNames(
      "componente",
      finalPlans.map((plan) => ({ key: plan.ref, value: plan.ref, context: `${plan.values.size} usi; ${describeElement([...plan.values.keys()][0] as SiteElement)}` })),
      new Set(["site/header", "site/footer"]),
      (value, finals) => {
        const tag = componentTag(value);
        if (!/[a-z]/u.test(tag)) return "il nome si leggerebbe come un tag HTML";
        return [...finals].some((other) => other !== value && componentTag(other) === tag) ? "il tag del componente è già di un altro" : null;
      },
    );
    for (const plan of finalPlans) {
      const defaultRef = plan.ref;
      const keys = choices.book.pickNames(
        "prop",
        plan.props.map((prop) => {
          const samples = [...plan.values.values()].slice(0, 2).map((entry) => (entry.props[prop.key] ?? "").slice(0, 60)).filter(Boolean);
          return { key: `${defaultRef}.${prop.key}`, value: prop.key, context: `campo ${prop.type} del componente ${defaultRef}${samples.length ? `; esempi: «${samples.join("», «")}»` : ""}` };
        }),
        new Set(),
      );
      const keyOf = new Map(plan.props.map((prop) => [prop.key, keys.get(`${defaultRef}.${prop.key}`) ?? prop.key]));
      plan.ref = refs.get(defaultRef) ?? defaultRef;
      plan.tag = componentTag(plan.ref);
      if ([...keyOf].some(([key, final]) => key !== final)) renameProps(plan, keyOf);
    }
    if (usingLists) {
      const live = lists.filter((list) => list.items.some((item) => listOf.has(item)));
      const types = choices.book.pickNames(
        "tipo",
        live.map((list) => ({ key: list.type, value: list.type, context: `elenco di ${list.items.length} elementi fatti col componente ${list.plan.ref}; il primo: ${describeElement(list.first)}` })),
        RESERVED_TYPE_KEYS,
      );
      for (const list of live) {
        const type = types.get(list.type) ?? list.type;
        if (type !== list.type) {
          list.type = type;
          list.query = `${type.replaceAll("-", "_")}_elenco`;
          list.label = type.charAt(0).toUpperCase() + type.slice(1).replaceAll("-", " ");
        } else list.label = `Elenco ${list.plan.ref}`;
      }
    }
  }

  // ------------------------------------------------------------------ the pages, rewritten
  const write = (nodes: readonly SiteNode[]): string => {
    let out = "";
    const done = new Set<ListPlan>();
    for (const node of nodes) {
      if (node.kind === "text") {
        out += escapeText(node.text);
        continue;
      }
      const list = listOf.get(node);
      if (list) {
        if (!done.has(list)) {
          done.add(list);
          const attributes = list.plan.props.map((prop) => ` ${prop.key}={item.fields.${prop.key}}`).join("");
          out += `{#loop ${list.query}() as item}<${list.plan.tag}${attributes} />{/loop}`;
        }
        continue;
      }
      const plan = usingComponents ? plans.get(shapeOf.get(node)?.signature ?? "") : undefined;
      if (plan?.values.has(node)) {
        out += useMarkup(plan, node);
        continue;
      }
      const attributes = renderAttributes(node.attrs);
      out += VOID_TAGS.has(node.tag) ? `<${node.tag}${attributes}>` : `<${node.tag}${attributes}>${write(node.children)}</${node.tag}>`;
    }
    return out;
  };
  const outPages = working.map((page) => ({ slug: page.slug, title: page.title, template: usingParts ? "site/page" : null, markup: write(page.nodes).trim() }));

  const documents: string[] = [];
  if (usingParts) {
    for (const part of parts) {
      const ref = `site/${part.area}`;
      documents.push(`<template data-histos="part" data-ref="${ref}" data-area="${part.area}" data-title="${part.area === "header" ? "Testata" : "Piè di pagina"}">${part.markup}</template>`);
    }
    const header = parts.some((part) => part.area === "header") ? "<Site.Header />" : "";
    const footer = parts.some((part) => part.area === "footer") ? "<Site.Footer />" : "";
    documents.push(`<template data-histos="template" data-ref="site/page" data-title="Pagina">${header}{@slot}${footer}</template>`);
  }
  if (usingComponents) {
    for (const plan of plans.values()) {
      documents.push(`<template data-histos="component" data-ref="${plan.ref}" data-title="${attributeValue(`Blocco ${plan.ref}`)}" data-props="${attributeValue(propsJson(plan.props))}">${plan.markup}</template>`);
    }
    notes.push(`${plans.size === 1 ? "1 blocco ripetuto diventa un componente" : `${plans.size} blocchi ripetuti diventano componenti`}: ${[...plans.values()].map((plan) => `${plan.ref} (${plan.values.size} usi)`).join(", ")}`);
  }

  let content: StructuredSite["content"] = null;
  if (usingLists) {
    const types: unknown[] = [];
    const records: unknown[] = [];
    const queries: unknown[] = [];
    for (const list of lists) {
      if (!list.items.some((item) => listOf.has(item))) continue;
      const fields = list.plan.props.map((prop) => {
        const values = list.items.map((item) => list.plan.values.get(item)?.props[prop.key] ?? "");
        const urlOk = values.every((value) => (value.startsWith("/") && !value.startsWith("//")) || /^https?:\/\//iu.test(value));
        const type = prop.type === "image" ? "asset" : prop.type === "url" && urlOk ? "url" : "text";
        return { key: prop.key, label: prop.key.replaceAll("_", " "), type, required: false, public: true, multiple: false };
      });
      types.push({ key: list.type, label: list.label, fields });
      const slugs = new Set<string>();
      const slugCounters = new Map<string, number>();
      list.items.forEach((item, index) => {
        const props = list.plan.values.get(item)?.props ?? {};
        const firstText = list.plan.props.find((prop) => prop.type === "string" && !list.plan.imageProps.has(prop.key));
        // The title is plain text: the "&amp;" a prop needs for an entity written as text goes.
        const title = (firstText ? props[firstText.key] ?? "" : "").replace(/&amp;(?=(?:[a-z][a-z0-9]+|#\d+|#x[\da-f]+);)/giu, "&").trim().slice(0, 200) || `${list.label} ${index + 1}`;
        let slug = slugify(title) || `elemento-${index + 1}`;
        if (slugs.has(slug)) {
          const base = slugify(title, 52) || "elemento";
          let counter = slugCounters.get(base) ?? 2;
          while (slugs.has(`${base}-${counter}`)) counter++;
          slug = `${base}-${counter}`;
          slugCounters.set(base, counter + 1);
        }
        slugs.add(slug);
        const values = Object.fromEntries(list.plan.props.map((prop) => [prop.key, props[prop.key] ?? ""]).filter(([, value]) => value !== ""));
        records.push({ type: list.type, slug, title, status: "published", publishedAt: RECORDS_DATE, order: index + 1, values });
      });
      queries.push({ key: list.query, label: list.label, type: list.type, limit: Math.min(list.items.length, 100), orderBy: "order", order: "asc" });
    }
    content = types.length ? { types, records, queries } : null;
    if (types.length) notes.push(`${types.length === 1 ? "1 elenco diventa un tipo di contenuto" : `${types.length} elenchi diventano tipi di contenuto`} con ${records.length} record e un loop: ogni record ha anche una sua pagina`);
  }
  return { pages: outPages, documents, content, proposal, notes };
}
