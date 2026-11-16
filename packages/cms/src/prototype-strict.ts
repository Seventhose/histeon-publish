import { PRODUCT_TYPE_KEY, productFields } from "@histos-publish/histos-contract";
import { decodeHTMLAttribute } from "entities";
import type { ChildNode, Container, Declaration, Root, Rule } from "postcss";
import { splitList } from "../.generated/histos-dsl/css.js";
import { loopElse, type XbBlock } from "../.generated/histos-dsl/index.js";
import { isAcssClass, PROTOTYPE_NOTE_PREFIX } from "./framework-names.js";

/**
 * F1, the strict check of a prototype (`prototype check --severo`): the house rules the guides write in words
 * (agent-docs 06-stile, 07-histos-css, 14-errori-tipici, the prototype manual §16), said as problems with a place and a
 * remedy a small model can follow. Only what the guides say, never more: what they allow (a framework class, a tag in a
 * global sheet, `1px` of a border, a custom property in `style`) is never a problem, and where a rule cannot tell for
 * certain it says nothing. Like PrototypeQuality it reads what the import already parsed, as the import goes: each
 * document's blocks (add), the selector styles' postcss root (selectors), never the source a second time.
 */

export type StrictLevel = "errore" | "avviso";

export type StrictRule =
  | "classe-non-bem"
  | "utility"
  | "stile-in-linea"
  | "testo-segnaposto"
  | "schede-a-mano"
  | "loop-senza-else"
  | "campo-che-non-esiste"
  | "avviso-del-controllo"
  | "valore-fisso"
  | "testo-da-scrivere"
  | "classe-senza-regola";

/** The level of each rule: an `errore` fails the strict check, an `avviso` is listed. */
export const STRICT_RULE_LEVELS: Readonly<Record<StrictRule, StrictLevel>> = {
  "classe-non-bem": "errore",
  utility: "errore",
  "stile-in-linea": "errore",
  "testo-segnaposto": "errore",
  "schede-a-mano": "errore",
  "loop-senza-else": "errore",
  "campo-che-non-esiste": "errore",
  "avviso-del-controllo": "errore",
  "valore-fisso": "avviso",
  "testo-da-scrivere": "avviso",
  "classe-senza-regola": "avviso",
};

export interface StrictProblem {
  rule: StrictRule;
  level: StrictLevel;
  /** As the import's problems name it: "page contatti", "template site/opera", "stili per selettore". */
  document?: string;
  line?: number;
  /** What and where. */
  message: string;
  /** What to write instead, in one sentence. */
  fix: string;
}

export interface PrototypeStrictResult {
  /** No problem of level `errore`. */
  passed: boolean;
  problems: StrictProblem[];
}

/** What the strict check reads of a document: the import's own (PrototypeDocument). */
export interface StrictDocument {
  kind: string;
  attributes: Record<string, string>;
  line?: number;
}

/** The BEM form of the guides: block, block__element, block--modifier, lower case with hyphens. */
export const BEM_CLASS = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$/u;

/**
 * Utility classes of other frameworks (Tailwind, Bootstrap) by their names: what 14-errori-tipici n. 2 shows
 * (`p-4 flex gap-2 text-xl bg-primary`). Histeon CSS's `xb-*` and ACSS's names are not here: the guides let the
 * converted ones stand, and only a chain of them is a problem (FRAMEWORK_CHAIN).
 */
const UTILITY_NAME = new RegExp(
  `^(?:${[
    "flex",
    "grid",
    "block",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "hidden",
    "invisible",
    "contents",
    "flow-root",
    "relative",
    "absolute",
    "fixed",
    "sticky",
    "static",
    "underline",
    "italic",
    "uppercase",
    "lowercase",
    "capitalize",
    "truncate",
    "clearfix",
    "-?[mp][trblxyse]?-(?:\\d+(?:\\.\\d+)?|px|auto)",
    "(?:gap|gap-x|gap-y|space-x|space-y)-\\d+(?:\\.\\d+)?",
    "(?:w|h|min-w|max-w|min-h|max-h|size)-(?:\\d+(?:\\.\\d+)?|\\d+\\/\\d+|full|screen|auto|px|fit|min|max|xs|sm|md|lg|xl|\\dxl)",
    "text-(?:xs|sm|base|lg|xl|\\dxl|left|center|right|justify|white|black)",
    "(?:text|bg|border|from|to|via|fill|stroke|ring)-[a-z]+-\\d{2,3}",
    "bg-(?:white|black|transparent|primary|secondary|light|dark|muted|success|danger|warning|info)",
    "font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|sans|serif|mono)",
    "(?:items|justify|content|self|place-items|place-content|justify-items|justify-self)-(?:start|end|center|between|around|evenly|stretch|baseline)",
    "flex-(?:row|col|wrap|nowrap|1|auto|initial|none|grow|shrink)(?:-reverse)?",
    "(?:grid-cols|grid-rows|col-span|row-span)-\\d+",
    "rounded(?:-(?:none|sm|md|lg|xl|\\dxl|full))?",
    "shadow(?:-(?:sm|md|lg|xl|\\dxl|none|inner))?",
    "(?:leading|tracking)-(?:none|tight|tighter|snug|normal|relaxed|loose|wide|wider|widest|\\d+)",
    "(?:z|opacity|order)-\\d+",
    "d-(?:none|block|flex|grid|inline|inline-block|inline-flex)",
    "col-(?:\\d{1,2}|(?:xs|sm|md|lg|xl|xxl)-\\d{1,2})",
  ].join("|")})$`,
  "u",
);

/** Classes of Histeon CSS or ACSS on one element from which they are a chain (07-histos-css: `xb-p-m xb-bg-surface xb-rounded-m …`). */
const FRAMEWORK_CHAIN = 3;

/** Fill text: lorem ipsum and the words that say a text is a stand-in (17-mestiere: «Mai lorem ipsum»). */
const PLACEHOLDER_TEXT =
  /\b(?:lorem\s+ipsum|ipsum\s+dolor|dolor\s+sit\s+amet|testo\s+segnaposto|testo\s+fittizio|placeholder\s+text|dummy\s+text)\b/iu;
/** The honest stand-in the guides ask for when the true text is missing: listed, never a failure. */
const TO_WRITE = /\[\s*testo da scrivere\s*\]/iu;

/** Tags whose rows are a table's or a list's of options, never cards: not compared for schede-a-mano. */
const NOT_CARDS: ReadonlySet<string> = new Set(["tr", "td", "th", "option", "source", "track", "col"]);
/** Classed elements inside each sibling from which three alike are cards: a menu's `li > a` has one. */
const CARD_PARTS = 2;
const CARD_COPIES = 3;

/** `x.fields.name` where `x` is a root or a loop variable (not a field of a field). */
const FIELD_REFERENCE = /(?<![\w$.])([A-Za-z_][\w]*)\.fields\.([A-Za-z_][\w]*)/gu;

/** A property's initials: margin-top → mt, padding → p, font-size → fs. */
const initials = (property: string): string =>
  property
    .split("-")
    .map((part) => part.charAt(0))
    .join("");

/** A class name the guides would take, for the remedy: `blueText` → `blue-text`, `Card_Title-big` → `card-title-big`. */
function bemName(name: string): string {
  const out = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^[^a-z]+|-+$/gu, "");
  return out || "blocco";
}

/** The class value with every `{…}` replaced by a NUL: the names written around an expression are not static. */
function maskExpressions(value: string): string {
  let out = "";
  let depth = 0;
  for (const char of value) {
    if (char === "{") {
      if (depth === 0) out += "\0";
      depth++;
    } else if (char === "}" && depth > 0) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

/** The static class names of a `class` value: none written next to an expression (`card--{x}`). */
function staticClasses(value: string): string[] {
  const decoded = value.includes("&") ? decodeHTMLAttribute(value) : value;
  return maskExpressions(decoded)
    .split(/[\t\n\f\r ]+/u)
    .filter((name) => name && !name.includes("\0"));
}

const stringAttribute = (block: XbBlock, name: string): string | undefined => {
  if (block.name !== "xb/element") return undefined;
  const value = block.attrs.attributes?.[name];
  return typeof value === "string" ? value : undefined;
};

/** Every declaration of a `style` value sets a custom property: the dynamic value the guides allow (`--progress: …`). */
const onlyCustomProperties = (style: string): boolean =>
  style
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => part.startsWith("--"));

// ---------------------------------------------------------------- fixed values in the selector styles

/** What a value of each property may write by hand: lengths (px only where rem is a measure the guides use), colors. */
const SPACE_PROPERTIES =
  /^(?:margin|padding)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?$|^(?:gap|row-gap|column-gap)$/u;
const TEXT_PROPERTIES = /^font-size$/u;
const RADIUS_PROPERTIES = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/u;
const WIDTH_PROPERTIES = /^(?:width|max-width|min-width)$/u;
const SHADOW_PROPERTIES = /^(?:box-shadow|text-shadow)$/u;
const COLOR_PROPERTIES =
  /^(?:color|background|background-color|border|border-(?:top|right|bottom|left|inline|block)|border(?:-(?:top|right|bottom|left|inline|block))?-color|outline|outline-color|fill|stroke|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|column-rule-color)$/u;

const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(px|rem|em)$/iu;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/iu;
const NAMED_COLORS: ReadonlySet<string> = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse " +
    "chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey " +
    "darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush " +
    "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta " +
    "maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange " +
    "orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue " +
    "slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

/** The words of a value outside any function (`var()`, `min()`, `clamp()` hold what the guides recommend), and its top-level functions. */
function topLevel(value: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let word = "";
  for (const char of value) {
    if (char === "(") {
      if (depth === 0) word += "(";
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && (/\s/u.test(char) || char === "," || char === "/")) {
      if (word) words.push(word);
      word = "";
    } else if (depth === 0) word += char;
  }
  if (word) words.push(word);
  return words;
}

/** The values written by hand in a declaration of a selector rule, by kind; none for what the guides allow. */
function fixedValues(declaration: Declaration): { lengths: string[]; colors: string[] } {
  const property = declaration.prop.toLowerCase();
  const lengths: string[] = [];
  const colors: string[] = [];
  if (property.startsWith("--")) return { lengths, colors };
  const space = SPACE_PROPERTIES.test(property) || TEXT_PROPERTIES.test(property) || RADIUS_PROPERTIES.test(property);
  const width = WIDTH_PROPERTIES.test(property);
  const shadow = SHADOW_PROPERTIES.test(property);
  const color = COLOR_PROPERTIES.test(property) || shadow;
  if (!space && !width && !color) return { lengths, colors };
  for (const word of topLevel(declaration.value)) {
    const length = LENGTH.exec(word);
    if (length) {
      if (Number.parseFloat(word) === 0) continue;
      const unit = length[1]!.toLowerCase();
      if (space || (shadow && unit === "px") || (width && unit === "px")) lengths.push(word);
      continue;
    }
    if (color && (HEX_COLOR.test(word) || COLOR_FUNCTION.test(word) || NAMED_COLORS.has(word.toLowerCase())))
      colors.push(COLOR_FUNCTION.test(word) ? `${word.slice(0, word.indexOf("("))}(…)` : word);
  }
  return { lengths, colors };
}

/** The token family to write instead, by property. */
function tokenAdvice(property: string): string {
  if (TEXT_PROPERTIES.test(property)) return "un token di testo, per esempio var(--xb-text-m) o var(--xb-h2)";
  if (RADIUS_PROPERTIES.test(property)) return "un token di raggio, per esempio var(--xb-radius-m)";
  if (WIDTH_PROPERTIES.test(property))
    return "una larghezza fluida: var(--xb-width-content), min(…, 100%) o un valore in rem o ch";
  if (SHADOW_PROPERTIES.test(property)) return "un token d'ombra, per esempio var(--xb-shadow-m)";
  if (SPACE_PROPERTIES.test(property)) return "un token di spazio, per esempio var(--xb-space-m)";
  return "un token di colore, per esempio var(--xb-primary) o var(--xb-text), e la palette in design nel manifest";
}

// ---------------------------------------------------------------- classes in the selectors

/** The classes a selector names, outside strings and attribute selectors (`[class*="btn--"]` is no class of its own). */
function selectorClasses(selector: string): string[] {
  const bare = selector.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, "").replace(/\[[^\]]*\]/gu, "");
  const out: string[] = [];
  for (const match of bare.matchAll(/\.(-?(?:\\.|[A-Za-z_\u0080-\uffff])(?:\\.|[\w\u0080-\uffff-])*)/gu))
    out.push(match[1]!.replace(/\\(.)/gu, "$1"));
  return out;
}

/** A nested selector with `&` resolved against its parents, as Histeon compiles the selector styles. */
function resolved(selector: string, parents: readonly string[]): string[] {
  if (!parents.length) return [selector];
  return parents
    .slice(0, 64)
    .map((parent) => (selector.includes("&") ? selector.replaceAll("&", parent) : `${parent} ${selector}`));
}

// ---------------------------------------------------------------- the check

interface Place {
  document: string;
  line?: number;
}

interface Counted extends Place {
  count: number;
}

/** A loop variable's type: what `x.fields.<name>` is read against; none where it is not certain. */
type Scope = ReadonlyMap<string, string | undefined>;

interface Walk {
  document: string;
  /** The block whose line a problem inside takes: the nearest element, loop or component. */
  anchor?: string;
  inNav: boolean;
  scope: Scope;
  /** The tests of the {#if} branches around: a loop counted there before it needs no {:else}. */
  tests: readonly string[];
  /** The type `page` is, in a template only one type's records render with. */
  pageType?: string;
  /** The type `main()` lists, in a template only one type's archive renders with. */
  archiveType?: string;
}

/**
 * The strict rules, document by document as the import parses them (add), the selector styles once they are parsed
 * (selectors), put together at the end (problems). There is no reading outside the import: the strict check is the
 * import's, with its parse.
 */
export class PrototypeStrict {
  /** Each type's fields, by key; the product type's are the shop's own. */
  private readonly typeFields = new Map<string, ReadonlySet<string>>();
  /** The type each declared query lists, when it is one with fields. */
  private readonly queryTypes = new Map<string, string>();
  /** Template → the type `page` is there, for a template no page, post or role uses and only one type's records render with. */
  private readonly pageTypes = new Map<string, string>();
  /** Template → the type `main()` lists, for a template only one type's archive renders with and nothing else. */
  private readonly archiveTypes = new Map<string, string>();
  private readonly found: StrictProblem[] = [];
  /** Classes in the markup, by name: their first place and how many times. */
  private readonly markupClasses = new Map<string, Counted>();
  private readonly cssNonBem = new Map<string, Counted>();
  /** Selector rules that set one property alone on one class: `.mt-4 { margin-top: 1rem }`. */
  private readonly loneRules = new Map<string, { property: string; value: string }>();
  private readonly fieldsSeen = new Set<string>();
  private cssRead = false;

  constructor(input: {
    content: Record<string, unknown>;
    documents: readonly StrictDocument[];
    places?: { records?: ReadonlyArray<{ line: number } | undefined> };
  }) {
    const list = (key: string) =>
      (Array.isArray(input.content[key]) ? (input.content[key] as unknown[]) : []).map((item) =>
        item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {},
      );
    const singles = new Map<string, Set<string>>();
    const archives = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, template: unknown, type: string) => {
      if (typeof template !== "string") return;
      map.set(template, (map.get(template) ?? new Set()).add(type));
    };
    for (const type of list("types")) {
      if (typeof type.key !== "string") continue;
      const fields =
        type.key === PRODUCT_TYPE_KEY ? productFields() : Array.isArray(type.fields) ? (type.fields as unknown[]) : [];
      this.typeFields.set(
        type.key,
        new Set(
          fields.flatMap((field) =>
            field && typeof field === "object" && typeof (field as { key?: unknown }).key === "string"
              ? [(field as { key: string }).key]
              : [],
          ),
        ),
      );
      add(singles, type.singleTemplate, type.key);
      add(archives, type.archiveTemplate, type.key);
    }
    for (const query of list("queries"))
      if (typeof query.key === "string" && typeof query.type === "string" && this.typeFields.has(query.type))
        this.queryTypes.set(query.key, query.type);
    // A template a page or a post names, or with a role, renders other things too: there `page` is not certainly a record.
    const named = new Set(
      input.documents
        .filter((item) => item.kind === "page" || item.kind === "post")
        .map((item) => item.attributes["data-template"]),
    );
    for (const item of input.documents) {
      const ref = item.attributes["data-ref"]?.trim();
      if (item.kind !== "template" || !ref || item.attributes["data-role"] !== undefined || named.has(ref)) continue;
      const single = singles.get(ref);
      const archive = archives.get(ref);
      if (single?.size === 1 && !archive) this.pageTypes.set(ref, [...single][0]!);
      if (archive?.size === 1 && !single) this.archiveTypes.set(ref, [...archive][0]!);
    }
    // The records' texts: a title or a value of lorem ipsum is fill text like any other.
    for (const [index, record] of list("records").entries()) {
      const texts = [
        record.title,
        record.excerpt,
        ...(record.values && typeof record.values === "object"
          ? Object.values(record.values as Record<string, unknown>).flat()
          : []),
      ].filter((value): value is string => typeof value === "string");
      const where = {
        document: `record ${String(record.type)}/${String(record.slug)}`,
        ...(input.places?.records?.[index]?.line ? { line: input.places.records[index]!.line } : {}),
      };
      if (texts.some((text) => PLACEHOLDER_TEXT.test(text)))
        this.say(
          "testo-segnaposto",
          where,
          "un testo del record è di riempimento (lorem ipsum o simili).",
          "Scrivi il testo vero del record; se non lo hai, «[testo da scrivere]» e dillo all'utente.",
        );
      else if (texts.some((text) => TO_WRITE.test(text)))
        this.say(
          "testo-da-scrivere",
          where,
          "il record ha ancora «[testo da scrivere]».",
          "Chiedi all'utente il testo vero e mettilo al posto del segnaposto.",
        );
    }
  }

  private say(rule: StrictRule, place: Place, message: string, fix: string): void {
    this.found.push({
      rule,
      level: STRICT_RULE_LEVELS[rule],
      document: place.document,
      ...(place.line ? { line: place.line } : {}),
      message,
      fix,
    });
  }

  /** The selector styles, from the root the import parsed them into; `line` is the file's line where their text starts. */
  selectors(root: Root, line: number): void {
    if (this.cssRead) return;
    this.cssRead = true;
    const fileLine = (node: ChildNode) =>
      line > 0 && node.source?.start?.line ? line + node.source.start.line - 1 : undefined;
    const document = "stili per selettore";
    for (const node of root.nodes) {
      if (node.type !== "rule" || node.nodes.length !== 1 || node.nodes[0]!.type !== "decl") continue;
      const only = /^\.([a-z0-9_-]+)$/iu.exec(node.selector.trim());
      const declaration = node.nodes[0] as Declaration;
      if (only && !declaration.prop.startsWith("--"))
        this.loneRules.set(only[1]!, {
          property: declaration.prop.toLowerCase(),
          value: declaration.value.trim().toLowerCase(),
        });
    }
    const walk = (container: Container, parents: readonly string[], inRoot: boolean): void => {
      for (const node of container.nodes ?? []) {
        if (node.type === "rule") {
          const rule = node as Rule;
          const selectors = splitList(rule.selector).flatMap((selector) => resolved(selector.trim(), parents));
          for (const selector of selectors) {
            for (const name of selectorClasses(selector)) {
              if (BEM_CLASS.test(name)) continue;
              const seen = this.cssNonBem.get(name);
              if (seen) seen.count++;
              else
                this.cssNonBem.set(name, { document, ...(fileLine(rule) ? { line: fileLine(rule)! } : {}), count: 1 });
            }
          }
          // `:root` holds the site's values: a fixed value there is the token itself.
          if (inRoot || selectors.some((selector) => /:root\b/iu.test(selector))) walk(rule, selectors, true);
          else {
            this.fixedValues(rule, selectors[0] ?? rule.selector, fileLine);
            walk(rule, selectors, false);
          }
        } else if (node.type === "atrule") {
          // Keyframes and font faces are no block's style.
          if (/^(?:-\w+-)?keyframes$|^font-face$/iu.test(node.name)) continue;
          walk(node, parents, inRoot);
        }
      }
    };
    walk(root, [], false);
  }

  private fixedValues(rule: Rule, selector: string, fileLine: (node: ChildNode) => number | undefined): void {
    for (const node of rule.nodes ?? []) {
      if (node.type !== "decl") continue;
      const { lengths, colors } = fixedValues(node);
      const written = [...lengths, ...colors];
      if (!written.length) continue;
      const line = fileLine(node);
      this.say(
        "valore-fisso",
        { document: "stili per selettore", ...(line ? { line } : {}) },
        `${selector}: ${node.prop}: ${node.value} scrive a mano ${written.join(", ")}.`,
        `Usa ${tokenAdvice(node.prop.toLowerCase())}; un valore fisso solo quando nessun token va bene.`,
      );
    }
  }

  /** One document, from the blocks the import parsed it into; `lineOf` gives the file's line where a block starts. */
  add(document: StrictDocument, blocks: readonly XbBlock[], lineOf?: (uid: string) => number | undefined): void {
    const name = `${document.kind} ${document.attributes["data-ref"] ?? document.attributes["data-slug"] ?? "?"}`;
    const lines = new Map<string, number | undefined>();
    const at = (uid: string | undefined): Place => {
      let line = document.line;
      if (uid && lineOf) {
        if (!lines.has(uid)) lines.set(uid, lineOf(uid));
        line = lines.get(uid) ?? document.line;
      }
      return { document: name, ...(line ? { line } : {}) };
    };
    // Counted per document, said once with the first place.
    const styles: Counted = { ...at(undefined), count: 0 };
    const fill: Counted = { ...at(undefined), count: 0 };
    const toWrite: Counted = { ...at(undefined), count: 0 };
    const chains: Counted & { example?: string } = { ...at(undefined), count: 0 };
    const count = (counted: Counted, anchor: string | undefined) => {
      if (!counted.count++) Object.assign(counted, at(anchor));
    };
    const texts = (value: string, anchor: string | undefined) => {
      if (PLACEHOLDER_TEXT.test(value)) count(fill, anchor);
      else if (TO_WRITE.test(value)) count(toWrite, anchor);
    };
    for (const key of ["data-title", "data-excerpt"]) {
      const value = document.attributes[key];
      if (value !== undefined) texts(value, undefined);
    }
    const fields = (expression: string, walk: Walk) => {
      if (!expression.includes(".fields.")) return;
      for (const match of expression.matchAll(FIELD_REFERENCE)) {
        const [written, root, field] = match as unknown as [string, string, string];
        const type = root === "page" ? walk.pageType : walk.scope.get(root);
        const known = type === undefined ? undefined : this.typeFields.get(type);
        if (!known || known.has(field)) continue;
        const key = `${name}\0${written}`;
        if (this.fieldsSeen.has(key)) continue;
        this.fieldsSeen.add(key);
        const has = [...known].sort();
        this.say(
          "campo-che-non-esiste",
          at(walk.anchor),
          `{${written}}: il tipo ${type} non ha il campo ${field}${has.length ? ` (ha ${has.slice(0, 8).join(", ")}${has.length > 8 ? "…" : ""})` : ", non ha campi"}: vale sempre vuoto.`,
          has.length
            ? `Scrivi un campo del tipo ${type} (${has.slice(0, 4).join(", ")}${has.length > 4 ? "…" : ""}), oppure aggiungi ${field} ai fields del tipo in content.types.`
            : `Aggiungi ${field} ai fields del tipo ${type} in content.types, o togli ${written}.`,
        );
      }
    };
    const element = (block: Extract<XbBlock, { name: "xb/element" }>, walk: Walk) => {
      const attributes = block.attrs.attributes ?? {};
      const classValue = attributes.class;
      if (typeof classValue === "string") {
        const names = staticClasses(classValue);
        let framework = 0;
        for (const item of names) {
          const seen = this.markupClasses.get(item);
          if (seen) seen.count++;
          else this.markupClasses.set(item, { ...at(block.attrs.uid), count: 1 });
          if (item.startsWith("xb-") || isAcssClass(item)) framework++;
        }
        if (framework >= FRAMEWORK_CHAIN) {
          count(chains, block.attrs.uid);
          chains.example ??= names.join(" ");
        }
      }
      const style = attributes.style;
      if (typeof style === "string" && style.trim() && !onlyCustomProperties(style)) count(styles, block.attrs.uid);
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== "string") continue;
        if (key === "alt" || key === "title" || key === "aria-label" || key === "placeholder" || key === "content")
          texts(value, block.attrs.uid);
        if (value.includes("{")) fields(value, walk);
      }
    };
    /** Three or more alike siblings written by hand: same tag and classes, same classed parts inside. */
    const copies = (list: readonly XbBlock[], walk: Walk) => {
      if (walk.inNav) return;
      const groups = new Map<string, { count: number; uid: string; tag: string; classes: string }>();
      for (const block of list) {
        if (block.name !== "xb/element" || NOT_CARDS.has(block.attrs.tag.toLowerCase())) continue;
        const own = staticClasses(stringAttribute(block, "class") ?? "");
        if (!own.length) continue;
        const parts: string[] = [];
        const stack = [...block.children].reverse();
        for (let item = stack.pop(); item !== undefined && parts.length < 64; item = stack.pop()) {
          if (item.name === "xb/element") {
            const classes = staticClasses(stringAttribute(item, "class") ?? "");
            if (classes.length) parts.push(`${item.attrs.tag}.${[...classes].sort().join(".")}`);
          }
          if (item.name === "xb/component") parts.push(`<${item.attrs.ref}>`);
          if ("children" in item) stack.push(...[...(item.children as XbBlock[])].reverse());
        }
        if (parts.filter((part) => !part.startsWith("<")).length < CARD_PARTS) continue;
        const key = `${block.attrs.tag}.${[...own].sort().join(".")}|${parts.join(",")}`;
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { count: 1, uid: block.attrs.uid, tag: block.attrs.tag, classes: own.join(".") });
      }
      for (const group of groups.values()) {
        if (group.count < CARD_COPIES) continue;
        this.say(
          "schede-a-mano",
          at(group.uid),
          `${group.count} ${group.tag}.${group.classes} fratelli con la stessa struttura, scritti a mano.`,
          'Fanne un componente (<template data-histos="component">) chiamato in un loop su una query dei record, o con le sue props: si corregge una volta e vale ovunque.',
        );
      }
    };
    const visit = (list: readonly XbBlock[], walk: Walk): void => {
      copies(list, walk);
      for (const block of list) {
        switch (block.name) {
          case "xb/element": {
            const inside = {
              ...walk,
              anchor: block.attrs.uid,
              inNav: walk.inNav || block.attrs.tag.toLowerCase() === "nav",
            };
            element(block, inside);
            visit(block.children, inside);
            break;
          }
          case "xb/text":
            if (block.attrs.verbatim === true) break;
            texts(block.attrs.content.replace(/<[^>]*>/gu, ""), walk.anchor);
            if (block.attrs.content.includes("{")) fields(block.attrs.content, walk);
            break;
          case "xb/if":
            for (const branch of block.children) {
              if (branch.attrs.test !== undefined) fields(branch.attrs.test, walk);
              visit(
                branch.children,
                branch.attrs.test === undefined ? walk : { ...walk, tests: [...walk.tests, branch.attrs.test] },
              );
            }
            break;
          case "xb/loop": {
            const source = block.attrs.source;
            let type: string | undefined;
            let counted = false;
            if (source.kind === "preset") {
              type = source.groupBy
                ? undefined
                : source.id === "main"
                  ? walk.archiveType
                  : this.queryTypes.get(source.id);
              counted =
                source.id === "main" && walk.tests.some((test) => /\bpage\.total(?:Records|Pages)\b/u.test(test));
            } else {
              fields(source.expr, walk);
              const expression = source.expr.trim();
              counted = walk.tests.some((test) => test.includes(expression));
            }
            // The lists the guides ask a case for: a query, main(), a list in props, a field (n. 6). The terms of a
            // post or the links of a pagination may be empty without a word.
            const listed =
              source.kind === "preset" || /(?:^|[^\w.$])props\./u.test(source.expr) || source.expr.includes(".fields.");
            const empty = loopElse(block);
            if (listed && !empty && !counted) {
              const written = source.kind === "preset" ? `${source.id}()` : source.expr.trim();
              this.say(
                "loop-senza-else",
                at(block.attrs.uid),
                `{#loop ${written} as ${block.attrs.as}} non ha {:else}: quando la lista è vuota la sezione resta muta.`,
                `Aggiungi in fondo al loop {:else}<p>…</p> con una frase che dice cosa manca, per esempio «Nessun elemento.».`,
              );
            }
            const scope = new Map(walk.scope);
            scope.set(block.attrs.as, type);
            if (block.attrs.index) scope.set(block.attrs.index, undefined);
            const inside = { ...walk, anchor: block.attrs.uid, scope };
            visit(empty ? block.children.slice(0, -1) : block.children, inside);
            // In {:else} the loop's variable is not there (the import says so): the scope around.
            if (empty) visit(empty.children, { ...walk, anchor: block.attrs.uid });
            break;
          }
          case "xb/component": {
            const inside = { ...walk, anchor: block.attrs.uid };
            for (const value of Object.values(block.attrs.props ?? {})) {
              if (typeof value === "string") texts(value, block.attrs.uid);
              else if (value && typeof value === "object") fields("expr" in value ? value.expr : value.tpl, inside);
            }
            for (const fill of block.children) visit(fill.children, inside);
            break;
          }
          case "xb/branch":
          case "xb/slot-fill":
            visit(block.children, walk);
            break;
          default:
            break;
        }
      }
    };
    const ref = document.attributes["data-ref"]?.trim();
    const template = document.kind === "template" && ref ? ref : undefined;
    visit(blocks, {
      document: name,
      inNav: false,
      scope: new Map(),
      tests: [],
      ...(template && this.pageTypes.has(template) ? { pageType: this.pageTypes.get(template)! } : {}),
      ...(template && this.archiveTypes.has(template) ? { archiveType: this.archiveTypes.get(template)! } : {}),
    });
    if (styles.count)
      this.say(
        "stile-in-linea",
        styles,
        `${styles.count === 1 ? "un attributo style" : `${styles.count} attributi style`} nel markup${styles.count > 1 ? " (il primo qui)" : ""}.`,
        'Togli style e dai all\'elemento una classe BEM con lo stile nella sua regola in <style data-histos="selectors">; in style resta solo una variabile (--nome: valore).',
      );
    if (fill.count)
      this.say(
        "testo-segnaposto",
        fill,
        `${fill.count === 1 ? "un testo" : `${fill.count} testi`} di riempimento (lorem ipsum o simili)${fill.count > 1 ? ", il primo qui" : ""}.`,
        "Scrivi il testo vero dato dall'utente o preso dal sito; se manca, «[testo da scrivere]» e dillo all'utente.",
      );
    if (toWrite.count)
      this.say(
        "testo-da-scrivere",
        toWrite,
        `${toWrite.count === 1 ? "un segnaposto" : `${toWrite.count} segnaposto`} «[testo da scrivere]»${toWrite.count > 1 ? ", il primo qui" : ""}.`,
        "Chiedi all'utente i testi che mancano e mettili al posto dei segnaposto.",
      );
    if (chains.count)
      this.say(
        "utility",
        chains,
        `${chains.count === 1 ? "un elemento ha" : `${chains.count} elementi hanno`} una catena di classi utility${chains.example ? ` (class="${chains.example.slice(0, 80)}")` : ""}${chains.count > 1 ? ", il primo qui" : ""}.`,
        "Dai all'elemento una classe BEM e scrivi i valori di quelle utility nella sua regola, con i token --xb-*.",
      );
  }

  /**
   * The problems, once every document and the styles are read: the classes are said once each, at their first place.
   * `ruleClasses` are those any selector of the project's CSS names (FrameworkNames.selectorClasses); `unreadable`
   * when a sheet could not be read as the browser reads it, so that no class is said without a rule.
   */
  problems(input: { ruleClasses?: ReadonlySet<string>; unreadable?: boolean } = {}): StrictProblem[] {
    const out = [...this.found];
    const say = (rule: StrictRule, place: Place, message: string, fix: string) =>
      out.push({
        rule,
        level: STRICT_RULE_LEVELS[rule],
        document: place.document,
        ...(place.line ? { line: place.line } : {}),
        message,
        fix,
      });
    const times = (count: number) => (count === 1 ? "" : `, usata ${count} volte (la prima qui)`);
    const nonBem = new Set<string>();
    for (const [name, place] of this.markupClasses) {
      if (BEM_CLASS.test(name)) continue;
      nonBem.add(name);
      say(
        "classe-non-bem",
        place,
        `la classe ${name} non è BEM${times(place.count)}${this.cssNonBem.has(name) ? "; ha anche una regola negli stili per selettore" : ""}.`,
        `Scrivi le classi in minuscolo con i trattini, nella forma blocco, blocco__parte o blocco--variante: per esempio ${bemName(name)}${this.cssNonBem.has(name) ? ", e cambia la sua regola" : ""}.`,
      );
    }
    for (const [name, place] of this.cssNonBem) {
      if (nonBem.has(name)) continue;
      say(
        "classe-non-bem",
        place,
        `il selettore nomina la classe ${name}, che non è BEM.`,
        `Scrivi le classi in minuscolo con i trattini, nella forma blocco, blocco__parte o blocco--variante: per esempio ${bemName(name)}.`,
      );
    }
    const utilities = new Set<string>();
    /** A block of its own: the markup has its parts or variants (`grid__item`), or a rule styles it with more than one declaration. */
    const isBlock = (name: string) =>
      [...this.markupClasses.keys()].some((other) => other.startsWith(`${name}__`) || other.startsWith(`${name}--`)) ||
      (input.ruleClasses?.has(name) === true && !this.loneRules.has(name));
    for (const [name, place] of this.markupClasses) {
      if (name.includes("__") || name.includes("--") || name.startsWith("xb-")) continue;
      const lone = this.loneRules.get(name);
      const byRule =
        lone !== undefined &&
        (name === lone.value ||
          name === `${lone.property}-${lone.value}` ||
          (name.includes("-") && name.split("-")[0] === initials(lone.property)));
      // A framework's name is a utility only when nothing shows it is the project's own block (`.grid` with `grid__item`).
      if (!byRule && !(UTILITY_NAME.test(name) && !isBlock(name))) continue;
      utilities.add(name);
      say(
        "utility",
        place,
        `${name} è una classe utility${lone ? ` (.${name} { ${lone.property}: ${lone.value} })` : ""}${times(place.count)}.`,
        `Togli ${name} e scrivi ${lone ? `${lone.property}: …` : "quella proprietà"} nella regola della classe BEM dell'elemento, con un token --xb-*.`,
      );
    }
    // Only with every sheet read: a class whose rule may be in a sheet the import could not read is not said. Nor a
    // part or a variant of a block that has rules (`hero__body` beside `.hero`): a part without a style of its own is
    // a block's structure, and saying it would be noise. What is left is a block nothing styles at all.
    if (input.ruleClasses && !input.unreadable) {
      const blockOf = (name: string) => name.split(/__|--/u)[0]!;
      const styledBlocks = new Set([...input.ruleClasses].map(blockOf));
      for (const [name, place] of this.markupClasses) {
        if (
          input.ruleClasses.has(name) ||
          utilities.has(name) ||
          styledBlocks.has(blockOf(name)) ||
          name.startsWith("xb-") ||
          isAcssClass(name) ||
          !BEM_CLASS.test(name)
        )
          continue;
        say(
          "classe-senza-regola",
          place,
          `la classe ${name} non ha nessuna regola nel CSS del progetto${times(place.count)}.`,
          `Scrivi la regola di .${name} in <style data-histos="selectors">, o togli la classe se non serve.`,
        );
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- the check's own warnings

/**
 * The warnings of the check that only say what the import did or what the site will do, never something to fix: a
 * note («Nota: …»), a source map taken out, a media file nobody uses, the hint about categories, the choice of no
 * framework, the shop that only WordPress sells with, an external form, the JavaScript a document has, the remote media
 * the quick check did not download, the rules that keep modern image formats away (a matter of weight, not of form).
 */
const INFORMATION: readonly RegExp[] = [
  /tolto il source map incorporato/u,
  /^Il media \S+ non è usato: è comunque nella libreria\.$/u,
  /^Gli articoli non hanno categorie né tag/u,
  /^framework none: /u,
  /^Prodotti: il sito statico mostra prezzi/u,
  /: il modulo invia i dati \((?:GET|POST)\) a /u,
  /^(?:un documento ha|\d+ documenti hanno) JavaScript: /u,
  /^Controllo rapido: \d+ media remoti non scaricati/u,
  /toglie i formati moderni \(JPEG XL, AVIF, WebP\)/u,
];

/** Whether a warning of the check is something to fix: what the strict check fails on. */
export function strictWarningCounts(warning: string): boolean {
  return !warning.startsWith(PROTOTYPE_NOTE_PREFIX) && !INFORMATION.some((pattern) => pattern.test(warning));
}

/**
 * The strict check's answer: the problems of the rules, with every warning of the check that asks for a change as a
 * problem of its own (avviso-del-controllo), errors first in the order found; passed when there is no error.
 */
export function strictResult(problems: readonly StrictProblem[], warnings: readonly string[]): PrototypeStrictResult {
  const fromWarnings: StrictProblem[] = warnings.filter(strictWarningCounts).map((warning) => ({
    rule: "avviso-del-controllo",
    level: "errore",
    message: warning,
    fix: "Fai quello che l'avviso chiede, poi ricontrolla: nel controllo severo ogni avviso va risolto.",
  }));
  const all = [...problems, ...fromWarnings];
  const sorted = [
    ...all.filter((problem) => problem.level === "errore"),
    ...all.filter((problem) => problem.level !== "errore"),
  ];
  return { passed: !sorted.some((problem) => problem.level === "errore"), problems: sorted };
}
