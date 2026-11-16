/**
 * The elements a design is written as, and the components among them (note penpot-figma-a-histeon.md, phase 4).
 *
 * The writer of the prototype (design-prototype.ts) turns every layer into a `DesignOut`. Here those elements get
 * their BEM classes, their HTML and the one rule of their block; and, before that, the ones that repeat are found:
 * copies of one component of the design, or frames with the same name and the same structure, become one component
 * of the prototype, used once for each copy with its props and its slots. Copies that differ only in their
 * declarations are variants: a modifier of the block (`scheda--hover`). A run of cards whose texts and pictures
 * change becomes records of a type, read by a loop on a query.
 *
 * Pure: no network, no credentials, nothing read from or written to disk. The elements it receives are changed in
 * place.
 */

import { designSlug, type DesignNode, genericLayerName } from "./design-tree.js";

export const DESIGN_NARROW = "@media (width < 48rem)";

/** One element to write: its tag, the name its class is made from, its declarations. */
export interface DesignOut {
  tag: string;
  base: string;
  attrs: Array<[string, string]>;
  css: string[];
  narrow: string[];
  children: DesignOut[];
  /** Inner HTML already escaped (a text, the paths of an icon), instead of children. */
  raw: string;
  cls: string;
  /** The words of a text, when its inner HTML is only those words: they can be a prop of a component. */
  text?: string;
  /** For a frame of the design: the name of its layer and the component it is a copy of. */
  origin?: { name: string; component: DesignNode["component"] };
  /** Attributes whose value is an expression of the template language: `src={props.immagine}`. */
  binds?: Array<[string, string]>;
  /** Written after the class, inside the attribute: ` scheda--{props.variante}`. */
  clsCode?: string;
  /** Written in place of the element: a slot, a component with its props, a loop. */
  code?: string;
}

/** One component of the prototype, ready to be written as a `<template data-histos="component">`. */
export interface DesignComponent {
  /** The `data-ref`, which is also the name of the block. */
  ref: string;
  /** The name in the design, for `data-title` and the report. */
  title: string;
  props: Record<string, { type: string; default?: string; options?: string[] }>;
  html: string;
  rule: string;
  copies: number;
  /** The modifiers of the block, without the base one. */
  variants: string[];
  /** Props that carry a text, and slots that carry markup, a picture or a drawing. */
  texts: string[];
  slots: string[];
  /** True when the design itself calls it a component; false for frames that only repeat. */
  declared: boolean;
  /** The key of the type its copies became records of; empty when they did not. */
  type: string;
  /** True for cards side by side that stay uses of the component because their pictures sit differently in each copy, or the copies have variants. */
  uneven: boolean;
  /** True when cards side by side that differed took the look of the first one. */
  uniformed: boolean;
}

/** A type of content deduced from a run of cards: its fields, its records, the queries the page loops on. */
export interface DesignContentType {
  key: string;
  label: string;
  fields: Array<{ key: string; label: string; type: "text" | "asset" }>;
  records: Array<{ slug: string; title: string; order: number; values: Record<string, string> }>;
  queries: Array<{ key: string; label: string; limit: number; offset: number }>;
}

/** What became of the copies of one component of the design. */
export interface DesignFamily {
  name: string;
  /** Copies written as uses of a component of the prototype. */
  made: number;
  /** Copies inside a larger component: part of its markup. */
  nested: number;
  /** Copies left as plain elements of their block. */
  loose: number;
}

export interface DesignComponents {
  components: DesignComponent[];
  types: DesignContentType[];
  families: DesignFamily[];
}

/** Text for the value of an attribute: no quotes, no braces, no line breaks. */
export function designAttr(text: string): string {
  return text.replace(/[{}]/gu, "").replace(/\s+/gu, " ").trim().replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

const signature = (out: DesignOut) => [...out.css, DESIGN_NARROW, ...out.narrow].join(";");

/** The class of one element of a block: `block__base`, with a number when another element with that name has other declarations. `registry` keeps the declarations already seen for each class name. */
function elementClass(out: DesignOut, block: string, registry: Map<string, string[]>): string {
  const key = `${block}__${out.base}`;
  const seen = registry.get(key) ?? [];
  if (!registry.has(key)) registry.set(key, seen);
  let index = seen.indexOf(signature(out));
  if (index < 0) index = seen.push(signature(out)) - 1;
  return index === 0 ? key : `${key}-${index + 1}`;
}

/**
 * Gives every element of a block its BEM class. Two elements with the same name and the same declarations share a
 * class; a different one takes a number. What is written as code (the use of a component, a loop) has no class.
 */
export function nameDesignClasses(root: DesignOut, block: string, registry: Map<string, string[]>): void {
  root.cls = block;
  const visit = (out: DesignOut) => {
    for (const child of out.children) {
      if (child.code !== undefined) continue;
      child.cls = elementClass(child, block, registry);
      visit(child);
    }
  };
  visit(root);
}

/** The element as HTML. */
export function designOutHtml(out: DesignOut): string {
  if (out.code !== undefined) return out.code;
  const bound = new Set((out.binds ?? []).map(([name]) => name));
  const cls = out.cls ? ` class="${designAttr(out.cls)}${out.clsCode ?? ""}"` : "";
  const attrs = `${cls}${out.attrs.filter(([name]) => !bound.has(name)).map(([name, value]) => ` ${name}="${designAttr(value)}"`).join("")}${(out.binds ?? []).map(([name, code]) => ` ${name}={${code}}`).join("")}`;
  if (out.tag === "img" || out.tag === "hr") return `<${out.tag}${attrs}/>`;
  return `<${out.tag}${attrs}>${out.raw}${out.children.map(designOutHtml).join("")}</${out.tag}>`;
}

const ruleBody = (css: readonly string[], narrow: readonly string[]) => `${css.map((line) => `${line};`).join(" ")}${narrow.length ? ` ${DESIGN_NARROW} { ${narrow.map((line) => `${line};`).join(" ")} }` : ""}`;

/**
 * The one rule of a block: its declarations, its `@media`, then every element nested with its own. `extra` are
 * elements of the block that are not under its roots (what the copies of a component put in its slots); `inner` are
 * rules already written, nested last (the modifiers).
 */
export function designBlockRule(block: string, roots: readonly DesignOut[], extra: readonly DesignOut[] = [], inner: readonly string[] = []): string {
  const parts = new Map<string, string>();
  const add = (out: DesignOut) => {
    if (out.cls && out.cls !== block && !parts.has(out.cls) && (out.css.length || out.narrow.length)) parts.set(out.cls, `&${out.cls.slice(block.length)} { ${ruleBody(out.css, out.narrow)} }`);
  };
  const visit = (out: DesignOut) => {
    for (const child of out.children) {
      add(child);
      visit(child);
    }
  };
  for (const root of roots) visit(root);
  for (const out of extra) add(out);
  return `.${block} { ${[ruleBody(roots[0]!.css, roots[0]!.narrow), ...parts.values(), ...inner].filter(Boolean).join(" ")} }`;
}

/** Names a field, a prop or a slot cannot take: the fields every record has, and the prop of the variant. */
const RESERVED_KEYS = new Set(["id", "slug", "locale", "title", "status", "excerpt", "order", "fields", "terms", "meta", "url", "variante", "page", "props", "slots", "this"]);
/** Keys a type cannot take: the types the project already has, and addresses the site already uses. */
const RESERVED_TYPES = new Set(["post", "page", "tag", "category", "blog", "product", "product_cat", "product_tag", "post_tag", "media", "search", "posts", "terms", "main", "users"]);
/** Attributes of a picture or a drawing that change from one copy to the next. */
const MEDIA_ATTRS = new Set(["src", "alt", "width", "height", "viewBox"]);
/** A picture or a drawing, alone or in boxes that hold nothing else: where it sits in its box is content, and each copy of a component may carry it whole in a slot. */
const MEDIA = (out: DesignOut): boolean => out.tag === "img" || out.tag === "svg" || (out.tag === "div" && !out.raw && out.children.length === 1 && MEDIA(out.children[0]!));
/** Modifiers without a name of their own, beyond the base: more than these and the other copies stay plain elements. */
const NUMBERED_MAX = 3;

/** The words of a name as a `data-ref`: every word starts with a letter, so a word that starts with a digit joins the one before. */
function refSlug(name: string): string {
  const words: string[] = [];
  for (const word of name.split("-").filter(Boolean)) {
    if (/^[a-z]/u.test(word) || !words.length) words.push(word);
    else words[words.length - 1] += word;
  }
  return words.join("-").replace(/^[^a-z]+/u, "");
}

/** `a` over `b`: the declarations of `b` that `a` has not, or has with another value; one `a` has and `b` has not is `unset`. */
function declarationsDiff(a: readonly string[], b: readonly string[]): string[] {
  const read = (lines: readonly string[]) => new Map(lines.map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()] as const));
  const [from, to] = [read(a), read(b)];
  return [...[...to].filter(([name, value]) => from.get(name) !== value).map(([name, value]) => `${name}: ${value}`), ...[...from.keys()].filter((name) => !to.has(name)).map((name) => `${name}: unset`)];
}

/**
 * What a copy with other declarations changes of the model, class by class: the modifier of the block. Null when
 * two elements that share a class in the model change in two ways: a modifier cannot tell them apart.
 */
function variantDiff(model: DesignOut, sample: DesignOut): Map<string, { css: string[]; narrow: string[] }> | null {
  const seen = new Map<string, string>();
  const diff = new Map<string, { css: string[]; narrow: string[] }>();
  const visit = (a: DesignOut, b: DesignOut): boolean => {
    if (MEDIA(a)) return true;
    const change = { css: declarationsDiff(a.css, b.css), narrow: declarationsDiff(a.narrow, b.narrow) };
    const text = JSON.stringify(change);
    if (seen.has(a.cls) && seen.get(a.cls) !== text) return false;
    seen.set(a.cls, text);
    if (change.css.length || change.narrow.length) diff.set(a.cls, change);
    return a.children.every((child, index) => visit(child, b.children[index]!));
  };
  return visit(model, sample) ? diff : null;
}

/** The values of a variant (`Size=Large, State=Hover`) that differ from those of the base one, as a slug. */
function variantLabel(variant: string, base: string): string {
  const read = (text: string) => new Map(text.split(",").map((part) => part.split("=").map((piece) => piece.trim())).filter((pair) => pair.length === 2).map(([name, value]) => [name!, value!] as const));
  const [own, other] = [read(variant), read(base)];
  const values = own.size ? [...own].filter(([name, value]) => other.get(name) !== value).map(([, value]) => value) : [variant];
  return designSlug(values.join(" "));
}

/**
 * Finds the elements that repeat under the blocks of a page and writes each group as one component. A group is the
 * copies of one component of the design, or the frames with one name, that have the same structure; frames with a
 * name the tool gave count only when three or more are side by side. The larger groups are taken first: a copy
 * inside a larger component stays in its markup. Each copy is replaced, in its block, by the use of the component.
 * `taken` holds the names of the blocks already written, and receives the new ones. With `uniform`, cards side by
 * side all take the look of the first one, and its place for the picture: so they can be records.
 */
export function designComponents(roots: readonly DesignOut[], options: { taken: Set<string>; records: boolean; uniform?: boolean }): DesignComponents {
  const up = new Map<DesignOut, DesignOut>();
  const order = new Map<DesignOut, number>();
  const candidates: DesignOut[] = [];
  const walk = (out: DesignOut) => {
    for (const child of out.children) {
      up.set(child, out);
      order.set(child, order.size);
      if (child.origin && child.children.length) candidates.push(child);
      walk(child);
    }
  };
  for (const root of roots) walk(root);
  const memo = <T>(make: (out: DesignOut) => T) => {
    const known = new Map<DesignOut, T>();
    const read = (out: DesignOut): T => {
      if (!known.has(out)) known.set(out, make(out));
      return known.get(out)!;
    };
    return read;
  };
  // The structure: tags and the attributes that do not change with the content. The look: every declaration, except those of pictures and drawings, which each copy may carry in a slot.
  const shapeOf: (out: DesignOut) => string = memo((out) => `${out.tag}[${out.attrs.filter(([name]) => !MEDIA(out) || !MEDIA_ATTRS.has(name)).map(([name, value]) => `${name}=${value}`).join("|")}](${out.children.map((child) => shapeOf(child)).join(",")})`);
  const lookOf: (out: DesignOut) => string = memo((out) => (MEDIA(out) ? "" : `${signature(out)}(${out.children.map((child) => lookOf(child)).join(",")})`));
  const sizeOf: (out: DesignOut) => number = memo((out) => 1 + out.children.reduce((sum, child) => sum + sizeOf(child), 0));
  /** The element and what is under it, parents first; a picture in its boxes is one leaf. */
  const flat = (out: DesignOut): DesignOut[] => (MEDIA(out) ? [out] : [out, ...out.children.flatMap(flat)]);
  const whole = (out: DesignOut): string => `${out.tag}|${out.attrs.join("|")}|${out.raw}|${signature(out)}(${out.children.map(whole).join(",")})`;
  const copyOf = (out: DesignOut): DesignOut => ({ ...out, children: out.children.map(copyOf) });
  /** The picture of a leaf, under its boxes; null for a drawing. */
  const pictureOf = (out: DesignOut): DesignOut | null => (out.tag === "img" ? out : out.tag === "div" && out.children.length === 1 ? pictureOf(out.children[0]!) : null);
  /** The copies under each parent; true when every parent has three or more, one after the other. */
  const runsOf = (list: readonly DesignOut[]) => {
    const runs = new Map<DesignOut, DesignOut[]>();
    for (const out of list) runs.set(up.get(out)!, [...(runs.get(up.get(out)!) ?? []), out]);
    return { runs, sideBySide: [...runs].every(([parent, run]) => run.length >= 3 && run.every((out, index) => parent.children.indexOf(out) === parent.children.indexOf(run[0]!) + index)) };
  };
  const familyOf = (out: DesignOut) => (out.origin?.component ? designSlug(out.origin.component.name) : genericLayerName(out.origin?.name ?? "") ? "" : designSlug(out.origin?.name ?? ""));

  const groups = new Map<string, DesignOut[]>();
  for (const out of candidates) {
    const family = familyOf(out);
    // Frames the designer never named are one family only side by side, under one parent.
    const key = `${family || `~${order.get(up.get(out)!) ?? "radice"}`}|${shapeOf(out)}`;
    groups.set(key, [...(groups.get(key) ?? []), out]);
  }
  const sorted = [...groups].sort((a, b) => sizeOf(b[1][0]!) - sizeOf(a[1][0]!) || order.get(a[1][0]!)! - order.get(b[1][0]!)!);

  const claimed = new Set<DesignOut>();
  const inside = (out: DesignOut) => {
    for (let parent = up.get(out); parent; parent = up.get(parent)) if (claimed.has(parent)) return true;
    return false;
  };
  const reserve = (base: string): string => {
    const first = refSlug(base) || "scheda";
    let name = first;
    for (let n = 1; options.taken.has(name); n += 1) name = `${first}-${String.fromCharCode(97 + (n % 26))}${n >= 26 ? "x".repeat(Math.floor(n / 26)) : ""}`;
    options.taken.add(name);
    return name;
  };
  const result: DesignComponents = { components: [], types: [], families: [] };

  for (const [key, all] of sorted) {
    const family = key.slice(0, key.indexOf("|"));
    const generic = family.startsWith("~");
    const members = all.filter((out) => !inside(out));
    const declared = members.some((out) => out.origin?.component);
    const least = generic ? 3 : 2;
    const content = flat(all[0]!).some((out) => !out.children.length && (out.raw !== "" || out.tag === "img"));
    if (members.length < least || (!declared && (sizeOf(all[0]!) < (generic ? 4 : 3) || !content))) continue;

    // Copies with the same declarations are one variant; the one most copies have is the base.
    const uniformed = options.uniform === true && runsOf(members).sideBySide && new Set(members.map((out) => lookOf(out))).size > 1;
    const looks = new Map<string, DesignOut[]>();
    for (const out of members) looks.set(uniformed ? "" : lookOf(out), [...(looks.get(uniformed ? "" : lookOf(out)) ?? []), out]);
    const sets = [...looks.values()].sort((a, b) => b.length - a.length);
    const model = sets[0]![0]!;
    const title = (model.origin?.component?.name ?? model.origin?.name ?? "").trim() || "Scheda";
    const block = reserve(generic ? "scheda" : family);
    const registry = new Map<string, string[]>();
    nameDesignClasses(model, block, registry);
    const common = (set: readonly DesignOut[]) => {
      const variants = new Set(set.map((out) => out.origin?.component?.variant ?? ""));
      return variants.size === 1 ? [...variants][0]! : undefined;
    };
    const baseVariant = common(sets[0]!);
    const modifiers: Array<{ name: string; members: DesignOut[]; rule: string }> = [];
    let numbered = 0;
    for (const set of sets.slice(1)) {
      const diff = variantDiff(model, set[0]!);
      if (!diff) continue;
      const variant = common(set);
      let name = variant && baseVariant !== undefined && variant !== baseVariant ? variantLabel(variant, baseVariant) : "";
      if (!name || name === "base" || modifiers.some((modifier) => modifier.name === name)) {
        // A copy unlike the others is a variant only of something that repeats, or of what the design itself calls one component.
        if (numbered >= NUMBERED_MAX || (sets[0]!.length < 2 && !declared)) continue;
        numbered += 1;
        name = String(numbered + 1);
      }
      const own = diff.get(block);
      const rule = `&--${name} { ${[own ? ruleBody(own.css, own.narrow) : "", ...[...diff].filter(([cls]) => cls !== block).map(([cls, change]) => `& .${cls} { ${ruleBody(change.css, change.narrow)} }`)].filter(Boolean).join(" ")} }`;
      modifiers.push({ name, members: set, rule });
    }
    const kept = [...sets[0]!, ...modifiers.flatMap((modifier) => modifier.members)].sort((a, b) => order.get(a)! - order.get(b)!);
    if (kept.length < least) {
      options.taken.delete(block);
      continue;
    }

    // What changes from one copy to the next, leaf by leaf: a text is a prop, markup a slot, a picture or a drawing a slot with its element.
    const flats = kept.map(flat);
    const modelFlat = flats[kept.indexOf(model)]!;
    type Kind = "string" | "inner" | "element" | "image";
    const slots: Array<{ index: number; kind: Kind; key: string }> = [];
    const keys = new Set<string>();
    const keyOf = (base: string) => {
      let first = base.replace(/-/gu, "_").replace(/[^a-z0-9_]/gu, "");
      if (!/^[a-z]/u.test(first)) first = `campo_${first}`;
      if (RESERVED_KEYS.has(first)) first = `${first}_campo`;
      let name = first;
      for (let n = 2; keys.has(name); n += 1) name = `${first}_${n}`;
      keys.add(name);
      return name;
    };
    let heading = -1;
    let firstText = -1;
    for (let index = 0; index < modelFlat.length; index += 1) {
      const nodes = flats.map((list) => list[index]!);
      const first = nodes[0]!;
      if ((first.children.length && !MEDIA(first)) || first.tag === "hr") continue;
      const plain = nodes.every((node) => node.text !== undefined && node.text.trim() !== "");
      if (MEDIA(first)) {
        if (nodes.every((node) => whole(node) === whole(first))) continue;
        const even = options.uniform === true && nodes.every((node) => pictureOf(node) !== null);
        slots.push({ index, kind: even || (first.tag === "img" && nodes.every((node) => signature(node) === signature(first))) ? "image" : "element", key: "" });
      } else if (nodes.some((node) => node.raw !== "")) {
        if (plain && heading < 0 && /^h[1-6]$/u.test(first.tag)) heading = index;
        if (plain && firstText < 0) firstText = index;
        if (nodes.every((node) => node.raw === first.raw)) continue;
        slots.push({ index, kind: plain ? "string" : "inner", key: "" });
      }
    }

    // A run of three or more cards side by side, with a picture that changes and nothing a record cannot hold, becomes records.
    const { runs, sideBySide } = runsOf(kept);
    const titleIndex = heading >= 0 ? heading : firstText;
    const asRecords = options.records && !modifiers.length && sideBySide && titleIndex >= 0 && slots.some((slot) => slot.kind === "image") && slots.every((slot) => slot.kind === "image" || slot.kind === "string");
    if (asRecords && !slots.some((slot) => slot.index === titleIndex)) slots.push({ index: titleIndex, kind: "string", key: "" });
    slots.sort((a, b) => a.index - b.index);
    for (const slot of slots) slot.key = keyOf(modelFlat[slot.index]!.base);
    const titleKey = slots.find((slot) => slot.index === titleIndex)?.key ?? "";

    // The pictures and drawings each copy carries take their class from the block, numbered like any other element.
    const tag = block.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
    const extra: DesignOut[] = [];
    const carried = new Map<string, DesignOut[]>();
    for (const slot of slots.filter((item) => item.kind === "element" || (item.kind === "image" && !asRecords))) {
      const copies = flats.map((list) => copyOf(list[slot.index]!));
      const name = (copy: DesignOut) => {
        copy.cls = elementClass(copy, block, registry);
        extra.push(copy);
        copy.children.forEach(name);
      };
      copies.forEach(name);
      carried.set(slot.key, copies);
    }
    for (const slot of slots.filter((item) => item.kind === "inner")) carried.set(slot.key, flats.map((list) => ({ ...list[slot.index]! })));
    const props: DesignComponent["props"] = {};
    for (const slot of slots) {
      const leaf = modelFlat[slot.index]!;
      if (slot.kind === "string") {
        props[slot.key] = { type: "string" };
        leaf.raw = `{props.${slot.key}}`;
      } else if (slot.kind === "inner") leaf.raw = `{@slot ${slot.key}}`;
      else if (slot.kind === "image" && asRecords) {
        props[slot.key] = { type: "image" };
        const alts = new Set(flats.map((list) => pictureOf(list[slot.index]!)!.attrs.find(([name]) => name === "alt")?.[1] ?? ""));
        const picture = pictureOf(leaf)!;
        picture.binds = [["src", `props.${slot.key}`], ...(alts.size > 1 && titleKey ? [["alt", `props.${titleKey}`] as [string, string]] : [])];
        // One place for every picture: none is cut to fill it.
        if (flats.some((list) => signature(pictureOf(list[slot.index]!)!) !== signature(picture))) picture.css = picture.css.map((line) => (line === "object-fit: cover" ? "object-fit: contain" : line));
      } else leaf.code = `{@slot ${slot.key}}`;
    }
    if (modifiers.length) {
      props.variante = { type: "enum", default: "base", options: ["base", ...modifiers.map((modifier) => modifier.name)] };
      model.clsCode = ` ${block}--{props.variante}`;
    }
    const use = (attrs: string, filled: ReadonlyArray<[string, string]>) => (filled.length ? `<${tag}${attrs}>${filled.map(([name, html]) => `{#slot ${name}}${html}{/slot}`).join("")}</${tag}>` : `<${tag}${attrs} />`);
    const code = (text: string): DesignOut => ({ tag: "", base: "", attrs: [], css: [], narrow: [], children: [], raw: "", cls: "", code: text });
    const component: DesignComponent = {
      ref: block, title, props, html: "", rule: "", copies: kept.length, variants: modifiers.map((modifier) => modifier.name),
      texts: slots.filter((slot) => slot.kind === "string").map((slot) => slot.key), slots: slots.filter((slot) => slot.kind !== "string" && !(slot.kind === "image" && asRecords)).map((slot) => slot.key), declared, type: "", uniformed,
      uneven: options.records && !asRecords && sideBySide && slots.some((slot) => slot.kind === "image" || slot.kind === "element"),
    };

    if (asRecords) {
      const first = refSlug(block).replace(/-/gu, "_");
      const typeKey = RESERVED_TYPES.has(first) ? `scheda_${first}` : first;
      const scoped = (scope: string) => use(slots.map((slot) => ` ${slot.key}={${slot.index === titleIndex ? `${scope}.title` : `${scope}.fields.${slot.key}`}}`).join(""), []);
      const fields = slots.filter((slot) => slot.index !== titleIndex).map((slot) => ({ key: slot.key, label: slot.key.replace(/_/gu, " ").replace(/^./u, (letter) => letter.toUpperCase()), type: slot.kind === "image" ? ("asset" as const) : ("text" as const) }));
      const slugs = new Set<string>();
      const records = kept.map((out, index) => {
        const list = flats[index]!;
        const name = list[titleIndex]!.text!.trim().slice(0, 200);
        const base = designSlug(name) || "voce";
        let slug = base;
        for (let n = 2; slugs.has(slug); n += 1) slug = `${base}-${n}`;
        slugs.add(slug);
        const values: Record<string, string> = {};
        for (const slot of slots) if (slot.index !== titleIndex) values[slot.key] = slot.kind === "image" ? (pictureOf(list[slot.index]!)!.attrs.find(([attr]) => attr === "src")?.[1] ?? "") : list[slot.index]!.text!;
        return { slug, title: name, order: index + 1, values };
      });
      const queries: DesignContentType["queries"] = [];
      let offset = 0;
      for (const [parent, run] of runs) {
        const query = { key: `${typeKey}_elenco${queries.length ? `_${queries.length + 1}` : ""}`, label: `${title}${queries.length ? ` ${queries.length + 1}` : ""}`, limit: run.length, offset };
        queries.push(query);
        offset += run.length;
        parent.children.splice(parent.children.indexOf(run[0]!), run.length, code(`{#loop ${query.key}() as voce}${scoped("voce")}{/loop}`));
      }
      result.types.push({ key: typeKey, label: title, fields, records, queries });
      component.type = typeKey;
    } else {
      kept.forEach((out, index) => {
        const list = flats[index]!;
        const modifier = modifiers.find((item) => item.members.includes(out));
        const attrs = `${slots.filter((slot) => slot.kind === "string").map((slot) => ` ${slot.key}="${designAttr(list[slot.index]!.text!)}"`).join("")}${modifier ? ` variante="${modifier.name}"` : ""}`;
        const filled = slots.filter((slot) => slot.kind !== "string").map((slot): [string, string] => [slot.key, slot.kind === "inner" ? carried.get(slot.key)![index]!.raw : designOutHtml(carried.get(slot.key)![index]!)]);
        const parent = up.get(out)!;
        parent.children[parent.children.indexOf(out)] = code(use(attrs, filled));
      });
    }
    // The copies are read before the model is changed into the template; its markup is written last.
    component.html = designOutHtml(model);
    component.rule = designBlockRule(block, [model], extra, modifiers.map((modifier) => modifier.rule));
    result.components.push(component);
    for (const out of kept) claimed.add(out);
  }

  const families = new Map<string, DesignFamily>();
  for (const out of candidates) {
    const name = out.origin?.component?.name;
    if (!name) continue;
    const family = families.get(name) ?? { name, made: 0, nested: 0, loose: 0 };
    families.set(name, family);
    family[claimed.has(out) ? "made" : inside(out) ? "nested" : "loose"] += 1;
  }
  result.families = [...families.values()];
  return result;
}
