import { parse, randomUid, serializeXb, type XbBlock } from "../.generated/histos-dsl/index.js";
import { cleanHtml } from "./article-document.js";
import { HISTOS_ARTICLE_COMPONENTS } from "./histos-css-assets.generated.js";

/**
 * The blocks a writer needs and a paragraph is not (doc 24) are Histeon components under the key `articolo/…`: one
 * definition, so a change of design reaches every article, and an instance per block, whose props are what the editor
 * asks for. A project gets the definition it uses from this library, and may change it; any component of its own under
 * that key is a block as well. Props set by an expression, or an instance with slots, are the builder's: they stay kept.
 */

export const ARTICLE_COMPONENT_PREFIX = "articolo/";
export type CardValue = string | number | boolean;
export type CardProps = Record<string, CardValue>;
export interface CardRow { uid: string; props: CardProps }
export interface Card { ref: string; props: CardProps; entries: CardRow[] }
export interface CardPropDefinition { type: string; default?: unknown; label?: string; options?: string[] }
export interface CardSchema { props: Record<string, CardPropDefinition> }
export interface CardDefinition { ref: string; title: string; schema: CardSchema; areas: string[]; content: string; rows?: string; row?: boolean; auto?: boolean }
/** What writing a block needs of its definition: the props, and the component of its rows if it has any. */
export type CardRules = Pick<CardDefinition, "schema" | "rows">;

export const ARTICLE_LIBRARY: readonly CardDefinition[] = HISTOS_ARTICLE_COMPONENTS as unknown as CardDefinition[];

const MAX_TEXT = 4000;
const MAX_ROWS = 200;

export const ARTICLE_INDEX = "articolo/indice";

export const safeLink = (value: string): boolean => /^(?:https?:\/\/|mailto:|#|\/(?!\/))/iu.test(value) && !/[\s\p{Cc}"<>{}]/u.test(value);

type Instance = Extract<XbBlock, { name: "xb/component" }>;

function literalProps(block: Instance): CardProps | null {
  const props: CardProps = {};
  for (const [name, value] of Object.entries(block.attrs.props ?? {})) {
    if (!["string", "number", "boolean"].includes(typeof value)) return null;
    props[name] = value as CardValue;
  }
  return props;
}

/** The card an instance is, or null. */
export function cardOf(block: XbBlock): Card | null {
  if (block.name !== "xb/component" || !block.attrs.ref.startsWith(ARTICLE_COMPONENT_PREFIX)) return null;
  const props = literalProps(block);
  if (!props) return null;
  const entries: CardRow[] = [];
  let rowRef: string | null = null;
  for (const fill of block.children) {
    if (fill.attrs.name !== "default") return null;
    for (const child of fill.children) {
      if (child.name === "xb/text" && !child.attrs.content.trim()) continue;
      const row = child.name === "xb/component" && !child.children.length ? literalProps(child) : null;
      if (!row || (rowRef && rowRef !== (child as Instance).attrs.ref)) return null;
      rowRef = (child as Instance).attrs.ref;
      entries.push({ uid: (child as Instance).attrs.uid, props: row });
    }
  }
  return { ref: block.attrs.ref, props, entries };
}

const instance = (uid: string, ref: string, props: CardProps, children: XbBlock[] = []): XbBlock => ({ name: "xb/component", attrs: { uid, ref, ...(Object.keys(props).length ? { props } : {}) }, children }) as XbBlock;

export function cardTree(card: Card, uid: string, rowRef: string | undefined): XbBlock {
  if (!rowRef || !card.entries.length) return instance(uid, card.ref, card.props);
  return instance(uid, card.ref, card.props, [{ name: "xb/slot-fill", attrs: { uid: randomUid(), name: "default" }, children: card.entries.map((row) => instance(row.uid, rowRef, row.props)) } as XbBlock]);
}

export const cardMarkup = (card: Card, rowRef: string | undefined): string => serializeXb([cardTree(card, randomUid(), rowRef)]);

/** An image of the site's media, or one the block already had (a site's own address after a return from WordPress). */
function checkImage(value: string, mediaBase: string, known: ReadonlySet<string>): string {
  if (!value.startsWith(`${mediaBase}/`) && !known.has(value)) throw new TypeError("Un'immagine del blocco non è dei media del sito.");
  return value;
}

function cleanValue(definition: CardPropDefinition, value: unknown, mediaBase: string, known: ReadonlySet<string>): CardValue | undefined {
  const text = typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
  switch (definition.type) {
    case "string": return text || undefined;
    case "rich-text": return text ? cleanHtml(text) : undefined;
    case "url":
      if (text && !safeLink(text)) throw new TypeError("Un collegamento del blocco non è valido.");
      return text || undefined;
    case "image": return text ? checkImage(text, mediaBase, known) : undefined;
    case "enum":
      if (text && !definition.options?.includes(text)) throw new TypeError("Una scelta del blocco non è valida.");
      return text || undefined;
    case "number": return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    default: return undefined;
  }
}

function cleanProps(schema: CardSchema, sent: unknown, mediaBase: string, known: ReadonlySet<string>): CardProps {
  const values = (sent ?? {}) as Record<string, unknown>;
  const props: CardProps = {};
  for (const [name, definition] of Object.entries(schema.props)) {
    const clean = Object.hasOwn(values, name) ? cleanValue(definition, values[name], mediaBase, known) : undefined;
    if (clean !== undefined) props[name] = clean;
  }
  return props;
}

/** What the editor sent, checked against the component's own definition: no prop it does not have, nothing that is not plain data. */
export function cleanCard(value: Record<string, unknown>, rulesOf: (ref: string) => CardRules | null, mediaBase: string, known: ReadonlySet<string>): Card {
  const ref = typeof value.ref === "string" ? value.ref : "";
  const rules = ref.startsWith(ARTICLE_COMPONENT_PREFIX) ? rulesOf(ref) : null;
  if (!rules) throw new TypeError("Blocco sconosciuto.");
  const rowRules = rules.rows ? rulesOf(rules.rows) : null;
  const entries = rowRules && Array.isArray(value.entries) ? value.entries.slice(0, MAX_ROWS).map((row) => {
    const entry = (row ?? {}) as Record<string, unknown>;
    return { uid: typeof entry.uid === "string" && /^[a-z0-9]{8,16}$/u.test(entry.uid) ? entry.uid : randomUid(), props: cleanProps(rowRules.schema, entry.props, mediaBase, known) };
  }).filter((row) => Object.keys(row.props).length) : [];
  return { ref, props: cleanProps(rules.schema, value.props, mediaBase, known), entries };
}

/** The component of the rows of a block of one's own: its ref and this. */
export const ROW_SUFFIX = "-riga";
export type CustomCardLook = "riquadro" | "scheda" | "citazione";
export interface CustomCardField { label: string; kind: "text" | "area" | "link" | "image"; name?: string }

/**
 * A block made without HTML: a name, its fields and a look among the library's. What it prints comes from here, never
 * from what was typed, which only names the fields: the result is a component like the others, to change in the builder.
 */
export function customCard(input: { title: string; fields: CustomCardField[]; look: CustomCardLook; ref?: string }, takenRefs: ReadonlySet<string>): Pick<CardDefinition, "ref" | "title" | "schema" | "content"> {
  const title = input.title.trim().slice(0, 80);
  const fields = input.fields.filter((field) => field.label.trim()).slice(0, 12);
  if (!title || !fields.length) throw new TypeError("Serve un nome e almeno un campo.");
  const base = title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/^[^a-z]+/u, "").slice(0, 40) || "blocco";
  let ref = input.ref ?? `${ARTICLE_COMPONENT_PREFIX}${base}`;
  for (let number = 2; !input.ref && (takenRefs.has(ref) || ARTICLE_LIBRARY.some((entry) => entry.ref === ref)); number += 1) ref = `${ARTICLE_COMPONENT_PREFIX}${base}-${number}`;
  const props: CardSchema["props"] = {};
  // A field keeps its name when the block changes: what articles wrote in it stays. New fields take free names.
  const kept = new Set(fields.map((field) => field.name).filter((name): name is string => typeof name === "string" && /^campo\d{1,3}$/u.test(name)));
  let next = 1;
  const free = (): string => { while (kept.has(`campo${next}`)) next += 1; kept.add(`campo${next}`); return `campo${next}`; };
  const lines = fields.map((field, position) => {
    const name = field.name && /^campo\d{1,3}$/u.test(field.name) ? field.name : free();
    props[name] = { type: field.kind === "area" ? "rich-text" : field.kind === "link" ? "url" : field.kind === "image" ? "image" : "string", label: field.label.trim().slice(0, 80) };
    const value = `props.${name}`;
    const body = field.kind === "image" ? `<img src={${value}} alt="" loading="lazy"/>`
      : field.kind === "link" ? `<a class="xb-art-link" href={${value}}>{${value}}</a>`
        : field.kind === "area" ? `<p class="xb-art-testo">{${value}.inline()}</p>`
          : `<p class="${position === 0 ? "xb-art-titolo" : "xb-art-testo"}">{${value}}</p>`;
    return `{#if ${value}}${body}{/if}`;
  }).join("");
  const source = input.look === "citazione" ? `<figure class="xb-art-citazione">${lines}</figure>`
    : input.look === "scheda" ? `<div class="xb-art-autore"><div class="xb-art-corpo">${lines}</div></div>`
      : `<aside class="xb-art-riquadro xb-art-riquadro-nota">${lines}</aside>`;
  return { ref, title, schema: { props }, content: serializeXb(parse(source).blocks) };
}

/**
 * A block of one's own with its fields repeated: each row is an instance of a second component, as the library's rows
 * are, so every row has its own texts and translations.
 */
export function repeatingCard(input: { title: string; fields: CustomCardField[]; look: CustomCardLook; ref?: string }, takenRefs: ReadonlySet<string>): { card: Pick<CardDefinition, "ref" | "title" | "schema" | "content">; row: Pick<CardDefinition, "ref" | "title" | "schema" | "content"> } {
  const shell = customCard(input, takenRefs);
  const row = customCard({ ...input, title: `${shell.title} (riga)`, ref: `${shell.ref}${ROW_SUFFIX}` }, takenRefs);
  return { card: { ...shell, schema: { props: {} }, content: serializeXb(parse(`<div class="xb-art-gruppo">{@slot}</div>`).blocks) }, row };
}

/** What a block of one's own was made from, read back from its definition to change it. */
export function customCardForm(schema: CardSchema, content: string): { fields: CustomCardField[]; look: CustomCardLook } {
  const kinds: Record<string, CustomCardField["kind"]> = { "rich-text": "area", url: "link", image: "image" };
  return {
    fields: Object.entries(schema.props).map(([name, prop]) => ({ name, label: String(prop.label ?? name), kind: kinds[prop.type] ?? "text" })),
    look: content.includes("xb-art-citazione") ? "citazione" : content.includes("xb-art-autore") ? "scheda" : "riquadro",
  };
}

/** The addresses of the images a card holds. */
export function cardImages(card: Card, rulesOf: (ref: string) => CardRules | null): string[] {
  const rules = rulesOf(card.ref);
  const images = (props: CardProps, schema: CardSchema | undefined): string[] => Object.entries(props).flatMap(([name, value]) => (schema?.props[name]?.type === "image" && typeof value === "string" ? [value] : []));
  const rowSchema = rules?.rows ? rulesOf(rules.rows)?.schema : undefined;
  return [...images(card.props, rules?.schema), ...card.entries.flatMap((row) => images(row.props, rowSchema))];
}
