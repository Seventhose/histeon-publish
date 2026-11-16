import { findClosingBrace, loopElse, parseExpression, refToTag, type Expr, type XbBlock } from "../.generated/histos-dsl/index.js";
import { TRANSFER_MODIFIERS } from "./page-transfer.js";
import { CMS_DATE_FORMAT_LETTERS, CMS_DATE_TEXT, CMS_RUNTIME_CAPABILITIES } from "./static-renderer.js";
import { TRANSFER_SVG_TAGS } from "./transfer-markup.js";

/**
 * The expressions of a prototype's documents read before the build (A7 hunt, 14-prototipo-histos.md §7): what the
 * transfer refuses only as a bare message of the whole document (a modifier it does not know, a name no scope has, a
 * stray brace) and what the static build refuses only once it renders a page (an unknown letter of a date() format, a
 * literal date that is not ISO, more than 100 decimals, an object written in the text, a prop or a slot the called
 * component does not have, a loop argument a query does not take). Each one is said with the place where it is written.
 * The blocks are the ones the import already parsed: nothing here parses a document again.
 */

/** The modifiers a document may use: those the transfer carries and the renderer applies (static-renderer.ts). */
const MODIFIERS: readonly string[] = CMS_RUNTIME_CAPABILITIES.modifiers.filter((name) => TRANSFER_MODIFIERS.has(name));
const MODIFIER_SET: ReadonlySet<string> = new Set(MODIFIERS);
/** Names an agent writes for a modifier that has another one in Histeon. */
const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  uppercase: "upper", touppercase: "upper", toupper: "upper", lowercase: "lower", tolowercase: "lower", tolower: "lower",
  capitalise: "capitalize", ucfirst: "capitalize", strip: "stripTags", strip_tags: "stripTags", striphtml: "stripTags",
  truncate: "truncateWords o truncateChars", excerpt: "truncateWords", format: "date", formatdate: "date", dateformat: "date",
  todate: "date", tofixed: "number", format_number: "number", numberformat: "number", count: "length", size: "length",
  contains: "includes", has: "includes", implode: "join", stringify: "json", tojson: "json", slugify: "slug",
  fallback: "default", or: "default", substr: "slice", substring: "slice", map: "pluck",
};
/** What a date() letter prints, for the message about a letter whose `\` the string lost. */
const DATE_LETTERS_READ: Readonly<Record<string, string>> = {
  d: "il giorno a due cifre", D: "il giorno della settimana abbreviato", j: "il giorno", l: "il giorno della settimana",
  N: "il numero del giorno della settimana", S: "il suffisso inglese del giorno", w: "il numero del giorno della settimana",
  z: "il giorno dell'anno", W: "la settimana dell'anno", F: "il nome del mese", m: "il mese a due cifre", M: "il nome del mese abbreviato",
  n: "il numero del mese", t: "i giorni del mese", L: "1 negli anni bisestili", o: "l'anno della settimana", Y: "l'anno",
  y: "l'anno a due cifre", a: "am o pm", A: "AM o PM", B: "l'ora Swatch", g: "l'ora", G: "l'ora", h: "l'ora a due cifre",
  H: "l'ora a due cifre", i: "i minuti", s: "i secondi", u: "i microsecondi", v: "i millisecondi", e: "il fuso orario",
  I: "1 con l'ora legale", O: "lo scarto dal fuso", P: "lo scarto dal fuso", T: "la sigla del fuso", Z: "lo scarto in secondi",
  c: "la data ISO", r: "la data RFC 2822", U: "i secondi dal 1970",
};
/** The escapes of the expression lexer (dsl/src/expr.ts): any other character after `\` stands for itself. */
const LEXER_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };
/** The arguments a query preset takes in a loop (content-model.ts, resolveQueryPreset); a prototype's queries have no parameters of their own. */
const LOOP_ARGUMENTS: readonly string[] = ["limit", "offset", "page", "paged", "posts_per_page", "count", "locale"];
/** The prop types whose value is text (static-renderer.ts, componentProps). */
const TEXT_PROP_TYPES: ReadonlySet<string> = new Set(["string", "url", "image", "rich-text", "enum"]);

export interface PropDefinition {
  type: string;
  options?: unknown;
}

/** What the expressions of every document are read against, built once from the prototype's declarations. */
export interface ExpressionDeclarations {
  /** The key of each query, with the type of its records ("post" for articles). */
  queryTypes: ReadonlyMap<string, string>;
  /** The props of each component, part and template that the store takes, by data-ref (none when its data-props is not valid). */
  props: ReadonlyMap<string, Readonly<Record<string, PropDefinition>>>;
  /** The components and parts a document may call. */
  callable: (ref: string) => boolean;
  /** Per type, its single relation fields that a published record fills: the linked record, an object. */
  relationObjects: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One problem of an expression: its block, and where in the document it is written. */
export interface ExpressionProblem {
  uid: string;
  message: string;
  /** Text as the block stores it, written so in the document after the block's start; `at` is the problem's offset in it. */
  needle?: string;
  at?: number;
  /** A text run's content and the index in it: the run is matched against the document to find it. */
  text?: string;
  textIndex?: number;
  /** A prop of a component's tag, found by its name past the tag's start. */
  attribute?: string;
  /** A named argument of a loop's query, found by its name past the loop's start: the name, or the value written after it. */
  argument?: { name: string; value: boolean };
}

/** A component or part called in a document, with the slots it fills: checked once the called one is read. */
export interface ComponentCall {
  uid: string;
  ref: string;
  /** Each slot filled, with the uid of its fill: an explicit {#slot name}, or the content written inside the tag. */
  fills: Array<{ uid: string; name: string }>;
}

/**
 * What an expression is, as far as it is known before the build: the page, a record of a loop, the props or the slots of
 * a component, their fields, any other object, or nothing known.
 */
type Shape =
  | { kind: "page" }
  | { kind: "record"; type: string }
  | { kind: "fields"; type: string }
  | { kind: "relation"; field: string }
  | { kind: "props" }
  | { kind: "prop"; name: string }
  | { kind: "slots" }
  | { kind: "slot"; name: string }
  | { kind: "object" }
  | { kind: "number" }
  /** `page.pageLinks` of an archive (A8): a list, printed as text like any list. */
  | { kind: "pageLinks" }
  /** An item of `page.pageLinks`: `{number, url, current}`. */
  | { kind: "pageLink" }
  /** A group of a grouped query loop (`foto().groupBy("anno")`, doc 23 item 187): `{key, items}`. */
  | { kind: "group"; type: string }
  /** The `items` of such a group: records of the query's type, for a loop inside; a list, printed as text like any list. */
  | { kind: "records"; type: string }
  | { kind: "other" };

type Env = ReadonlyMap<string, Shape>;
const PAGE: Shape = { kind: "page" };
/** What `page` has only in an archive (cms-api.ts, the archives' page scope and cmsArchivePaging): empty anywhere else. */
export const ARCHIVE_PAGE_NAMES: readonly string[] = ["totalPages", "totalRecords", "prevUrl", "nextUrl", "pageLinks"];
const ARCHIVE_PAGE_SET: ReadonlySet<string> = new Set(ARCHIVE_PAGE_NAMES);
const OTHER: Shape = { kind: "other" };

/** The slots a component renders (the renderer's findSlots): not those inside a call to another component. */
export function declaredSlots(blocks: readonly XbBlock[]): Set<string> {
  const slots = new Set<string>();
  const stack: XbBlock[] = [...blocks];
  for (let block = stack.pop(); block !== undefined; block = stack.pop()) {
    if (block.name === "xb/slot") slots.add(block.attrs.name);
    if ("children" in block && block.name !== "xb/component") for (const child of block.children as XbBlock[]) stack.push(child);
  }
  return slots;
}

/** The message for slots a call fills that the called component does not render, or none. */
export function slotProblems(call: ComponentCall, slots: ReadonlySet<string>): Array<{ uid: string; name: string; message: string }> {
  const have = slots.size ? `i suoi slot: ${[...slots].map((slot) => (slot === "default" ? "{@slot}" : `{@slot ${slot}}`)).join(", ")}` : "non ha slot";
  return call.fills.filter((fill) => !slots.has(fill.name)).map((fill) => ({
    uid: fill.uid,
    name: fill.name,
    message: fill.name === "default"
      ? `<${refToTag(call.ref)}> ha del contenuto fra i suoi tag, ma ${call.ref} non ha {@slot} dove metterlo (${have}): la build del sito si ferma. Togli quel contenuto, o aggiungi {@slot} a ${call.ref}.`
      : `<${refToTag(call.ref)}> riempie {#slot ${fill.name}}, ma ${call.ref} non ha {@slot ${fill.name}} (${have}): la build del sito si ferma. Usa uno dei suoi slot, o aggiungi {@slot ${fill.name}} a ${call.ref}.`,
  }));
}

/** An expression as written, for a message: never the whole of a long one. */
function written(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function isObjectShape(shape: Shape | undefined): boolean {
  return shape !== undefined && shape.kind !== "number" && shape.kind !== "pageLinks" && shape.kind !== "records" && shape.kind !== "other";
}

/** What to write instead of an object, by what it is. */
function objectAdvice(shape: Shape, text: string): string {
  const base = text.replace(/^\{\s*|\s*\}$/gu, "");
  switch (shape.kind) {
    case "page": return `${base} è la pagina, un oggetto: scrivi un suo dato, per esempio {${base}.title}`;
    case "record": return `${base} è un record del loop, un oggetto: scrivi un suo dato, per esempio {${base}.title}`;
    case "fields": return `${base} sono tutti i campi del record, un oggetto: scrivi un campo, per esempio {${base}.${shape.type === "post" ? "title" : "nome_del_campo"}}`;
    case "relation": return `${base} è il record collegato dal campo relation ${shape.field}, un oggetto: scrivi un suo dato, per esempio {${base}.title}`;
    case "props": return `${base} sono tutte le props, un oggetto: scrivi una prop, per esempio {${base}.titolo}`;
    case "prop": return `${base} è una prop di tipo object: scrivi un suo dato, per esempio {${base}.nome}`;
    case "slots": return `${base} sono tutti gli slot, un oggetto: per mostrare uno slot scrivi {@slot nome}`;
    case "pageLink": return `${base} è un link di page.pageLinks, un oggetto: scrivi {${base}.url}, {${base}.number} o {${base}.current}`;
    case "group": return `${base} è un gruppo del loop, un oggetto: scrivi {${base}.key} per il suo titolo, e i suoi contenuti con {#loop ${base}.items as elemento}`;
    case "slot": return `${base} dice solo se lo slot ${shape.name} è vuoto ({${base}.empty}): per mostrarne il contenuto scrivi {@slot${shape.name === "default" ? "" : ` ${shape.name}`}}`;
    default: return `${base} è un oggetto: scrivi uno dei suoi dati`;
  }
}

/**
 * Reads the expressions of one document; `calls` gets the components it calls, for the check of their slots, and
 * `archiveNames` the names of ARCHIVE_PAGE_NAMES it reads on `page` (doc 17: a template that is never an archive's).
 */
export function expressionProblems(
  blocks: readonly XbBlock[],
  kind: "component" | "part" | "template" | "page" | "post",
  ownRef: string | undefined,
  declarations: ExpressionDeclarations,
  refused: ReadonlySet<string>,
  counted: { total: number },
  max: number,
  calls: ComponentCall[],
  archiveNames?: Set<string>,
): ExpressionProblem[] {
  const found: ExpressionProblem[] = [];
  const report = (problem: ExpressionProblem) => {
    counted.total++;
    if (found.length < max) found.push(problem);
  };
  const reusable = kind !== "page" && kind !== "post";
  /** The loop variables a `{:else}` hides, by the scope inside it (and the scopes made from it): to say why one is missing. */
  const hiddenByElse = new WeakMap<Env, ReadonlySet<string>>();
  const ownProps = reusable && ownRef !== undefined ? declarations.props.get(ownRef) : undefined;
  const ownSlots = reusable ? declaredSlots(blocks) : new Set<string>();
  // The transfer's scope rule (page-transfer.ts, normalizeContentForTransfer): what each kind of document may name.
  const roots = new Map<string, Shape>([["page", PAGE], ["this", PAGE]]);
  if (reusable) {
    roots.set("props", { kind: "props" });
    roots.set("slots", { kind: "slots" });
  }

  /** What a loop's source is, when that is known: an expression the parser refuses is its own problem, said elsewhere. */
  const sourceShape = (source: string, env: Env): Shape | undefined => {
    try {
      return shapeOf(parseExpression(source), env);
    } catch {
      return undefined;
    }
  };

  /** What an expression is, when that is known before the build. */
  const shapeOf = (expr: Expr, env: Env): Shape | undefined => {
    switch (expr.type) {
      case "Literal": return OTHER;
      case "Object": return { kind: "object" };
      case "Array": return OTHER;
      case "Unary": return OTHER;
      case "Identifier": return env.get(expr.name);
      case "Conditional": {
        const consequent = shapeOf(expr.consequent, env);
        return isObjectShape(consequent) && isObjectShape(shapeOf(expr.alternate, env)) ? consequent : undefined;
      }
      case "Binary": {
        if (expr.op !== "??") return OTHER;
        const left = shapeOf(expr.left, env);
        return isObjectShape(left) ? left : undefined;
      }
      case "Member": {
        const object = shapeOf(expr.object, env);
        const property = expr.property;
        // A record of a query has its fields three times over; an article has fields and values, empty, and no meta.
        if (object?.kind === "record" && (property === "fields" || property === "values" || (property === "meta" && object.type !== "post"))) return { kind: "fields", type: object.type };
        if (object?.kind === "record" && property === "terms") return { kind: "object" };
        if ((object?.kind === "record" || object?.kind === "fields") && declarations.relationObjects.get(object.type)?.has(property)) return { kind: "relation", field: property };
        if (object?.kind === "props" && ownProps?.[property]?.type === "object") return { kind: "prop", name: property };
        if (object?.kind === "slots" && ownSlots.has(property)) return { kind: "slot", name: property };
        if (object?.kind === "page" && property === "pageLinks") return { kind: "pageLinks" };
        if (object?.kind === "group" && property === "items") return { kind: "records", type: object.type };
        if (object?.kind === "group" && property === "key") return OTHER;
        return undefined;
      }
      default: return undefined;
    }
  };

  /**
   * Every problem of one expression: `source.slice(start, end)` is the expression, `needle` the text it is found by in
   * the document and `base` where the expression's source starts in it. `interpolated` when it is written in the text
   * or within an attribute's value, where an object stops the build.
   */
  const inspect = (uid: string, source: string, start: number, end: number, env: Env, needle: string, base: number, interpolated: boolean, expected?: PropDefinition & { name: string; ref: string }, textRun?: string) => {
    let expression: Expr;
    try {
      expression = parseExpression(source, start, end);
    } catch {
      // The parser accepted the document: an expression it did not is its own problem, already said.
      return;
    }
    // Said in the order they are written, whatever order the tree is read in.
    const problems: Array<{ message: string; offset: number }> = [];
    const problem = (message: string, offset: number) => problems.push({ message, offset });
    const unknown = new Set<string>();
    const stack: Expr[] = [expression];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      switch (node.type) {
        case "Identifier":
          if (!env.has(node.name) && !unknown.has(node.name)) {
            unknown.add(node.name);
            const names = [...env.keys()];
            if (hiddenByElse.get(env)?.has(node.name)) problem(`{${written(source.slice(start, end))}}: nel {:else} di un loop ${node.name} non c'è: il ramo si mostra quando il loop non ha elementi. Qui ci sono ${names.join(", ")}.`, node.start);
            else problem(`{${written(source.slice(start, end))}}: ${node.name} non è un dato di questo documento, e il trasferimento lo rifiuta. Qui ci sono ${names.join(", ")}${reusable ? "" : " (props e slots solo in componenti, parti e template)"}.`, node.start);
          }
          break;
        case "Member":
          if (archiveNames && node.object.type === "Identifier" && node.object.name === "page" && env.get("page") === PAGE && ARCHIVE_PAGE_SET.has(node.property)) archiveNames.add(node.property);
          stack.push(node.object);
          break;
        case "Index": stack.push(node.object, node.index); break;
        case "Unary": stack.push(node.argument); break;
        case "Binary": stack.push(node.left, node.right); break;
        case "Conditional": stack.push(node.test, node.consequent, node.alternate); break;
        case "Array": stack.push(...node.elements); break;
        case "Object": for (const property of node.properties) stack.push(property.value); break;
        case "Call": {
          for (const argument of node.args) stack.push(argument.value);
          if (node.callee.type !== "Member") break;
          stack.push(node.callee.object);
          const name = node.callee.property;
          if (!MODIFIER_SET.has(name)) {
            const near = MODIFIERS.find((modifier) => modifier.toLowerCase() === name.toLowerCase()) ?? MODIFIER_ALIASES[name.toLowerCase()];
            problem(`il modificatore ${name}() non esiste in Histeon${near ? ` (forse ${near})` : ""}: la build del sito si ferma. I modificatori sono ${MODIFIERS.join(", ")}.`, node.callee.end - name.length);
          } else if (name === "date") dateProblems(node, source, problem);
          else if (name === "number") {
            const decimals = node.args[0]?.value;
            const value = decimals?.type === "Literal" ? numeric(decimals.value) : undefined;
            if (decimals && value !== undefined && Math.trunc(value) > 100) problem(`number(${written(source.slice(decimals.start, decimals.end))}): al massimo 100 decimali, oltre la build del sito si ferma.`, decimals.start);
          }
          break;
        }
        default: break;
      }
    }
    for (const { message, offset } of problems.sort((left, right) => left.offset - right.offset)) report({ uid, message, needle, at: base + offset - start, ...(textRun === undefined ? {} : { text: textRun, textIndex: offset }) });
    const shape = shapeOf(expression, env);
    const whole = (message: string) => report({ uid, message, needle, at: base, ...(textRun === undefined ? {} : { text: textRun, textIndex: start }) });
    if (interpolated && isObjectShape(shape)) whole(`{${written(source.slice(start, end))}}: ${objectAdvice(shape!, source.slice(start, end))}. Un oggetto scritto nel testo o dentro un attributo ferma la build del sito.`);
    if (expected && isObjectShape(shape) && expected.type !== "object") whole(`la prop ${expected.name} di ${expected.ref} è di tipo ${expected.type}, e {${written(source.slice(start, end))}} è un oggetto: la build del sito si ferma. Passa un suo dato, per esempio {${written(source.slice(start, end))}.title}.`);
  };

  /**
   * The braces of a value as the transfer reads them (validateInterpolations): `\{` and `\}` are text, `{…}` an
   * expression, a `}` alone a stray brace. In a text run the inline tags folded into it are skipped, and a brace in one of
   * their attributes is refused. An object stops the build in a text run and within an attribute's value, not as its
   * whole value nor in a prop's text, which print it as nothing (interpolatedAttribute, templateString).
   */
  const interpolations = (uid: string, value: string, env: Env, mode: "text" | "attribute" | "prop") => {
    const text = mode === "text";
    const whole = mode === "attribute" && value.startsWith("{") && closing(value, 0) === value.length - 1;
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === "\\" && (value[index + 1] === "{" || value[index + 1] === "}")) {
        index++;
        continue;
      }
      if (text && char === "<" && /[A-Za-z/]/u.test(value[index + 1] ?? "")) {
        let quote = "";
        let close = index + 1;
        for (; close < value.length; close++) {
          const current = value[close]!;
          if (quote) {
            if (current === quote) quote = "";
            continue;
          }
          if (current === "\"" || current === "'") quote = current;
          else if (current === ">") break;
        }
        if (close >= value.length) return;
        if (/[{}]/u.test(value.slice(index, close + 1))) report({ uid, message: "un link o una formattazione nel testo non ha { o } nei suoi attributi: il trasferimento lo rifiuta. Togli le graffe da quell'attributo.", text: value, textIndex: index });
        index = close;
        continue;
      }
      if (char === "{") {
        const close = closing(value, index);
        if (close < 0) return;
        if (text) inspect(uid, value, index + 1, close, env, value.slice(index, close + 1), 1, true, undefined, value);
        else inspect(uid, value, index + 1, close, env, value, index + 1, mode === "attribute" && !whole);
        index = close;
        continue;
      }
      if (char === "}") {
        const message = `una } da sola${text ? " nel testo" : ""}: il trasferimento e la build del sito la rifiutano. Per scrivere una graffa scrivi \\}; se chiude un'espressione, controlla la { che la apre.`;
        report(text ? { uid, message, text: value, textIndex: index } : { uid, message, needle: value, at: index });
      }
    }
  };

  /** The problems of a call to a component: its props against the component's schema. */
  const callProblems = (block: Extract<XbBlock, { name: "xb/component" }>, env: Env) => {
    const ref = block.attrs.ref;
    const schema = declarations.props.get(ref);
    const tag = refToTag(ref);
    for (const [name, value] of Object.entries(block.attrs.props ?? {})) {
      const definition = schema?.[name];
      if (schema && !definition) {
        const names = Object.keys(schema);
        report({ uid: block.attrs.uid, attribute: name, message: `<${tag} ${name}=…>: ${ref} non ha la prop ${name} (${names.length ? `ha ${names.join(", ")}` : "non ha props"}): la build del sito e l'esportazione si fermano. Dichiarala nel data-props di ${ref}, o toglila.` });
        continue;
      }
      if (value !== null && typeof value === "object") {
        if ("expr" in value) inspect(block.attrs.uid, value.expr, 0, value.expr.length, env, value.expr, 0, false, definition ? { ...definition, name, ref } : undefined);
        else interpolations(block.attrs.uid, value.tpl, env, "prop");
        continue;
      }
      if (!definition || value === null) continue;
      const problem = literalPropProblem(name, value, definition, ref);
      if (problem) report({ uid: block.attrs.uid, attribute: name, message: `<${tag} ${name}=…>: ${problem}` });
    }
  };

  /**
   * The arguments of a query preset in a loop: the names it takes, and literal values it refuses. The builder's built-in
   * main() takes none, and the structure check (prototype-import.ts, structureIssues) refuses any at the loop with how
   * to page and order instead: one loop, one problem, so none of them is read again here.
   */
  const loopArguments = (block: Extract<XbBlock, { name: "xb/loop" }>, env: Env) => {
    const source = block.attrs.source;
    if (source.kind !== "preset" || source.id === "main") return;
    const args = source.args ?? {};
    const literal = (name: string): { value: unknown } | undefined => {
      const text = args[name];
      if (text === undefined) return undefined;
      try {
        const parsed = parseExpression(text);
        return parsed.type === "Literal" ? { value: parsed.value } : undefined;
      } catch {
        return undefined;
      }
    };
    const head = `{#loop ${source.id}(…)}`;
    for (const [name, text] of Object.entries(args)) {
      if (!LOOP_ARGUMENTS.includes(name)) report({ uid: block.attrs.uid, argument: { name, value: false }, message: `${head}: ${name} non è un argomento delle query; si scrivono ${LOOP_ARGUMENTS.join(", ")}. Con un altro la build del sito si ferma.` });
      inspect(block.attrs.uid, text, 0, text.length, env, text, 0, false);
    }
    // The limit is the first of these given (resolveQueryPreset), the offset given or the one of a page.
    const limitName = ["limit", "posts_per_page", "count"].find((name) => args[name] !== undefined);
    const limit = limitName ? literal(limitName) : undefined;
    if (limitName && limit && limit.value !== null) {
      const value = typeof limit.value === "string" && /^\d{1,3}$/u.test(limit.value.trim()) ? Number(limit.value) : limit.value === -1 || limit.value === "-1" ? 100 : limit.value;
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) report({ uid: block.attrs.uid, argument: { name: limitName, value: true }, message: `${head}: ${limitName} è un numero intero da 1 a 100 (-1 per il massimo); con ${written(args[limitName]!)} la build del sito si ferma.` });
    }
    const offset = literal("offset");
    if (offset && offset.value !== null) {
      const value = typeof offset.value === "string" && /^\d{1,7}$/u.test(offset.value.trim()) ? Number(offset.value) : offset.value;
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) report({ uid: block.attrs.uid, argument: { name: "offset", value: true }, message: `${head}: offset è un numero intero da 0 a 1.000.000; con ${written(args.offset!)} la build del sito si ferma.` });
    } else if (args.offset === undefined) {
      const pageName = args.page !== undefined ? "page" : args.paged !== undefined ? "paged" : undefined;
      const page = pageName ? literal(pageName) : undefined;
      if (pageName && page && page.value !== null) {
        const value = typeof page.value === "string" && /^\d{1,7}$/u.test(page.value.trim()) ? Number(page.value) : page.value;
        if (!Number.isSafeInteger(value) || (value as number) < 1) report({ uid: block.attrs.uid, argument: { name: pageName, value: true }, message: `${head}: ${pageName} è un numero intero da 1 in su; con ${written(args[pageName]!)} la build del sito si ferma.` });
      }
    }
    const locale = literal("locale");
    if (locale && (typeof locale.value !== "string" || !validLocale(locale.value))) report({ uid: block.attrs.uid, argument: { name: "locale", value: true }, message: `${head}: locale è il tag di una lingua fra virgolette, per esempio locale: "en-GB"; con ${written(args.locale!)} la build del sito si ferma.` });
  };

  const visit = (block: XbBlock, env: Env): void => {
    const own = !refused.has(block.attrs.uid);
    let childEnv = env;
    switch (block.name) {
      case "xb/text":
        if (own && block.attrs.verbatim !== true) interpolations(block.attrs.uid, block.attrs.content, env, "text");
        break;
      case "xb/element":
        // SVG values are static (the markup check refuses an expression there) and never interpolated.
        if (own && !TRANSFER_SVG_TAGS.has(block.attrs.tag)) {
          for (const value of Object.values(block.attrs.attributes ?? {})) if (typeof value === "string") interpolations(block.attrs.uid, value, env, "attribute");
        }
        break;
      case "xb/branch":
        if (own && block.attrs.test !== undefined) inspect(block.attrs.uid, block.attrs.test, 0, block.attrs.test.length, env, block.attrs.test, 0, false);
        break;
      case "xb/loop": {
        if (own && block.attrs.source.kind === "expr") inspect(block.attrs.uid, block.attrs.source.expr, 0, block.attrs.source.expr.length, env, block.attrs.source.expr, 0, false);
        else if (own) loopArguments(block, env);
        const type = block.attrs.source.kind === "preset" ? declarations.queryTypes.get(block.attrs.source.id) : undefined;
        const grouped = block.attrs.source.kind === "preset" && block.attrs.source.groupBy !== undefined;
        const listed = block.attrs.source.kind === "expr" ? sourceShape(block.attrs.source.expr, env) : undefined;
        const scoped = new Map(env);
        // A grouped query loop (item 187) repeats groups {key, items}; a loop over a group's items, its records.
        scoped.set(block.attrs.as, type !== undefined ? (grouped ? { kind: "group", type } : { kind: "record", type }) : grouped ? OTHER : listed?.kind === "pageLinks" ? { kind: "pageLink" } : listed?.kind === "records" ? { kind: "record", type: listed.type } : OTHER);
        if (block.attrs.index !== undefined) scoped.set(block.attrs.index, { kind: "number" });
        const hidden = hiddenByElse.get(env);
        if (hidden) hiddenByElse.set(scoped, new Set([...hidden].filter((name) => !scoped.has(name))));
        childEnv = scoped;
        break;
      }
      case "xb/component":
        if (own && declarations.callable(block.attrs.ref)) {
          callProblems(block, env);
          calls.push({ uid: block.attrs.uid, ref: block.attrs.ref, fills: block.children.map((fill) => ({ uid: fill.attrs.uid, name: fill.attrs.name })) });
        }
        break;
      default:
        break;
    }
    // A loop's `{:else}` (its last branch, without a test) shows when there are no items: the scope around the loop.
    const empty = block.name === "xb/loop" ? loopElse(block) : null;
    let elseEnv: Env = env;
    if (block.name === "xb/loop" && empty) {
      const names = [block.attrs.as, ...(block.attrs.index !== undefined ? [block.attrs.index] : [])].filter((name) => !env.has(name));
      elseEnv = new Map(env);
      hiddenByElse.set(elseEnv, new Set([...(hiddenByElse.get(env) ?? []), ...names]));
    }
    if ("children" in block) for (const child of block.children as XbBlock[]) visit(child, child === empty ? elseEnv : childEnv);
  };
  for (const block of blocks) visit(block, roots);
  return found;
}

/** The `}` that closes the `{` at `open`, or -1. */
function closing(value: string, open: number): number {
  try {
    return findClosingBrace(value, open);
  } catch {
    return -1;
  }
}

/** A number as the renderer reads one (isNumericValue): a number, or text that is one. */
function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed) ? Number(trimmed) : undefined;
}

function validLocale(value: string): boolean {
  if (!value) return true;
  try {
    return Boolean(Intl.getCanonicalLocales(value)[0]);
  } catch {
    return false;
  }
}

/**
 * A literal date() format as the renderer reads it, after the expression lexer read its string: `\` and a character
 * become that character (`\n`, `\t` and `\r` a control character), so `"j \d\i F"` reaches date() as `j di F`, whose d and
 * i are the day and the minutes («7 0700 novembre»). A letter that came out of such an escape is one the author wanted
 * written: doubling the backslash keeps it (`\\d` reaches date() as `\d`, the letter d). Any other ASCII letter that is
 * not a format letter stops the render. And the subject of date(), when literal, must be a date the renderer reads.
 */
function dateProblems(node: Extract<Expr, { type: "Call" }>, source: string, problem: (message: string, offset: number) => void): void {
  const subject = node.callee.type === "Member" ? node.callee.object : undefined;
  if (subject?.type === "Literal" && (typeof subject.value === "string" || typeof subject.value === "boolean")) {
    const text = String(subject.value).trim();
    if (text && !CMS_DATE_TEXT.test(text)) problem(`${written(source.slice(subject.start, subject.end))}.date(): date() legge una data ISO (AAAA-MM-GG, o AAAA-MM-GGThh:mm:ss con il fuso) o un timestamp; con questo valore la build del sito si ferma.`, subject.start);
  }
  const format = node.args[0]?.value;
  if (format?.type !== "Literal" || typeof format.value !== "string") return;
  const raw = source.slice(format.start + 1, format.end - 1);
  // The characters the lexer gives date(), each with the letter an escape stood for and where that escape is written.
  const read: Array<{ char: string; escaped?: string; at?: number }> = [];
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "\\" && index + 1 < raw.length) {
      const next = raw[++index]!;
      read.push({ char: LEXER_ESCAPES[next] ?? next, ...(/[A-Za-z]/u.test(next) ? { escaped: next, at: index - 1 } : {}) });
    } else read.push({ char: raw[index]! });
  }
  const lost: string[] = [];
  const doubled = new Set<number>();
  const unknown: string[] = [];
  for (let index = 0; index < read.length; index++) {
    const { char, escaped, at } = read[index]!;
    // date()'s own escape: the character after it is printed as it is.
    if (char === "\\" && index + 1 < read.length) {
      index++;
      continue;
    }
    if (escaped !== undefined) {
      if (!lost.includes(escaped)) lost.push(escaped);
      doubled.add(at!);
    } else if (/[A-Za-z]/u.test(char) && !CMS_DATE_FORMAT_LETTERS.has(char) && !unknown.includes(char)) unknown.push(char);
  }
  const quote = source[format.start] ?? "\"";
  if (lost.length) {
    // The format as it should be written: the backslash of each lost escape doubled.
    let fixed = "";
    for (let index = 0; index < raw.length; index++) fixed += doubled.has(index) ? "\\\\" : raw[index];
    const effects = lost.map((letter) => (LEXER_ESCAPES[letter] ? `\\${letter} diventa ${letter === "n" ? "un a capo" : letter === "t" ? "una tabulazione" : "un ritorno a capo"}` : CMS_DATE_FORMAT_LETTERS.has(letter) ? `\\${letter} diventa ${letter}, cioè ${DATE_LETTERS_READ[letter] ?? "una lettera del formato"}` : `\\${letter} diventa ${letter}, che non è una lettera del formato e ferma la build`));
    problem(`date(${quote}${written(raw)}${quote}): in una stringa di un'espressione una sola \\ prima di una lettera si perde: ${effects.join("; ")}. Per scrivere la lettera com'è raddoppia la barra: date(${quote}${written(fixed)}${quote}).`, format.start);
  }
  if (unknown.length) {
    problem(`date(${quote}${written(raw)}${quote}): ${unknown.join(", ")} non ${unknown.length === 1 ? "è una lettera" : "sono lettere"} del formato delle date (${[...CMS_DATE_FORMAT_LETTERS].join(" ")}), e la build del sito si ferma. Per scrivere una lettera com'è mettile davanti due barre: \\\\${unknown[0]}.`, format.start);
  }
}

/** A literal value of a prop against its type, as componentProps reads it at the build; the problem, or none. */
function literalPropProblem(name: string, value: string | number | boolean, definition: PropDefinition, ref: string): string | undefined {
  const type = definition.type;
  const is = `la prop ${name} di ${ref} è di tipo ${type}`;
  const stops = "la build del sito si ferma";
  if (type === "number") {
    if (typeof value === "number") return undefined;
    if (typeof value === "string" && numeric(value) !== undefined) return `${is}, e fra virgolette è un testo: ${stops}. Scrivi ${name}={${value.trim()}}.`;
    return `${is}: ${value === true ? "scritta senza valore vale true" : `«${written(String(value))}» non è un numero`}, e ${stops}. Scrivi un numero fra graffe, per esempio ${name}={3}.`;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return undefined;
    if (value === "true" || value === "false") return `${is}, e fra virgolette è un testo: ${stops}. Scrivi ${name}={${value}}${value === "true" ? ` o solo ${name}` : ""}.`;
    return `${is}: ${typeof value === "number" ? `il numero ${value}` : `«${written(String(value))}»`} non è true o false, e ${stops}. Scrivi ${name}={true} o ${name}={false}.`;
  }
  if (TEXT_PROP_TYPES.has(type)) {
    if (typeof value !== "string") return `${is}: ${value === true ? "scritta senza valore vale true" : `${String(value)} fra graffe non è un testo`}, e ${stops}. Scrivi ${name}="${value === true ? "…" : String(value)}".`;
    const options = Array.isArray(definition.options) ? definition.options.filter((option): option is string => typeof option === "string") : [];
    if (type === "enum" && options.length && !options.includes(value)) return `${is} e vale uno fra ${options.slice(0, 8).join(", ")}${options.length > 8 ? "…" : ""}: con «${written(value)}» ${stops}.`;
    return undefined;
  }
  if (type === "array" || type === "object") return `${is}: un valore scritto${value === true ? " senza valore" : ""} così non è ${type === "array" ? "un elenco" : "un oggetto"}, e ${stops}. Passalo con un'espressione, per esempio ${name}={props.${name}}.`;
  return undefined;
}
