import { defaultTreeAdapter, parse as parseHtml, serialize, type DefaultTreeAdapterMap } from "parse5";
import postcss, { type Declaration, type Root, type Rule } from "postcss";
import { HISTOS_ACSS_MAP } from "./histos-css-assets.generated.js";
import { validateHistosDesign } from "./histos-design.js";
import { PROPOSAL_ACSS_EXTRA } from "./proposal-acss-table.js";

/**
 * The single file `kit proposte` writes: a viewer that shows one proposal at a time, with the data in a
 * <script type="application/json" id="kp-dati"> block. Each proposal carries a complete HTML document (its fonts, a
 * :root with the variables it uses, the compiled CSS, the markup and an optional script). This module only reads that
 * file and tells which framework the variables were written with; it is pure (no file system, no network).
 */

export const PROPOSALS_DATA_ID = "kp-dati";
export const PROPOSALS_MAX = 50;
export const PROPOSAL_DOC_MAX_BYTES = 8 * 1024 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const TITLE_MAX = 200;
const NAME_MAX = 120;
const IDEA_MAX = 500;

export interface ProposalEntry {
  id: string;
  name: string;
  group: string;
  idea: string;
  /** The proposal's HTML document, as the file has it. */
  doc: string;
}

export interface ProposalsFile {
  title: string;
  groups: Array<{ id: string; name: string }>;
  proposals: ProposalEntry[];
}

/** The framework whose variables a proposal's :root uses: Histeon CSS (--xb-*), Automatic.css or none of them. */
export type ProposalFramework = "acss" | "histeon" | "none";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

let acssTokens: Map<string, string> | undefined;

/**
 * Automatic.css name → Histeon CSS token, both without «--»: the builder's table turned around (value → key, in the
 * builder's order), then PROPOSAL_ACSS_EXTRA, which wins. Computed once.
 */
export function proposalAcssTokens(): Map<string, string> {
  if (acssTokens === undefined) {
    const tokens = new Map<string, string>();
    for (const [token, acss] of Object.entries(HISTOS_ACSS_MAP.tokens)) tokens.set(acss, token);
    for (const [acss, token] of Object.entries(PROPOSAL_ACSS_EXTRA)) tokens.set(acss, token);
    acssTokens = tokens;
  }
  return acssTokens;
}

/** True when the HTML has a <script type="application/json" id="kp-dati"> element, as the viewer writes it. */
export function isProposalsFile(html: string): boolean {
  return dataScriptText(html) !== undefined;
}

/** Reads the proposals file. Throws a TypeError with the message for the first thing that is wrong. */
export function readProposalsFile(html: string): ProposalsFile {
  const text = dataScriptText(html);
  if (text === undefined) throw new TypeError("Il file non è un file di proposte di kit proposte: manca il blocco kp-dati.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TypeError("Il blocco kp-dati del file di proposte non è JSON valido.");
  }
  const list = isRecord(data) ? data.proposte : undefined;
  if (!isRecord(data) || !Array.isArray(list)) throw new TypeError("Il blocco kp-dati del file di proposte non ha l'elenco delle proposte.");
  if (list.length === 0) throw new TypeError("Il file di proposte non contiene proposte.");
  if (list.length > PROPOSALS_MAX) throw new TypeError(`Il file di proposte ha ${list.length} proposte: al massimo ${PROPOSALS_MAX}.`);

  const seen = new Set<string>();
  const proposals = list.map((item: unknown, index): ProposalEntry => {
    const raw: Record<string, unknown> = isRecord(item) ? item : {};
    const id = raw.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError(`La proposta ${index + 1} del file non ha un id valido.`);
    if (seen.has(id)) throw new TypeError(`Due proposte del file hanno lo stesso id «${id}».`);
    seen.add(id);
    const doc = raw.doc;
    if (typeof doc !== "string" || doc.trim() === "") throw new TypeError(`La proposta «${id}» non ha il documento HTML.`);
    if (new TextEncoder().encode(doc).byteLength > PROPOSAL_DOC_MAX_BYTES) throw new TypeError(`La proposta «${id}» supera 8 MB.`);
    return {
      id,
      name: nameOf(raw.nome, id, NAME_MAX),
      group: typeof raw.gruppo === "string" ? raw.gruppo.trim() : "",
      idea: trimmedText(raw.idea, IDEA_MAX),
      doc,
    };
  });

  const groups: ProposalsFile["groups"] = [];
  if (Array.isArray(data.gruppi)) {
    for (const item of data.gruppi) {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") continue;
      const id = item.id;
      groups.push({ id, name: nameOf(item.nome, id, NAME_MAX) });
    }
  }

  return { title: trimmedText(data.titolo, TITLE_MAX) || "Proposte", groups, proposals };
}

/** A proposal ready to be a prototype: its document as one index.html page, with the variables Histeon CSS reads. */
export interface ProposalSite {
  /** «<titolo del file> · <nome della proposta>», cut to 80 characters. */
  name: string;
  title: string;
  proposal: { id: string; name: string };
  framework: ProposalFramework;
  files: Array<{ path: string; bytes: Uint8Array }>;
  /** The Histeon CSS design of the proposal's colors, for staticSiteToPrototype's `design`. */
  design: Record<string, string>;
  notes: string[];
}

const SITE_NAME_MAX = 80;
const FRAMEWORK_NOTE: Record<ProposalFramework, string> = {
  acss: "con ACSS",
  histeon: "con Histeon CSS",
  none: "senza le variabili di un framework",
};

/**
 * The proposal `proposalId` of a proposals file, as the site of a Histeon prototype: its variables converted (see
 * convertProposalVariables), its colors as `design`, and the notes that say what changed. Throws a TypeError when the
 * file or the proposal is not there.
 */
export function proposalSite(html: string, proposalId: string): ProposalSite {
  const file = readProposalsFile(html);
  const proposal = file.proposals.find((item) => item.id === proposalId);
  if (proposal === undefined) throw new TypeError(`Il file di proposte non ha la proposta «${proposalId}».`);
  const framework = proposalFramework(proposal.doc);
  const converted = convertProposalVariables(proposal.doc, framework);
  const name = Array.from(`${file.title} · ${proposal.name}`).slice(0, SITE_NAME_MAX).join("");
  return {
    name,
    title: file.title,
    proposal: { id: proposal.id, name: proposal.name },
    framework,
    files: [{ path: "index.html", bytes: new TextEncoder().encode(converted.doc) }],
    design: converted.design,
    notes: [`proposta «${proposal.id} · ${proposal.name}» dal file «${file.title}», scritta ${FRAMEWORK_NOTE[framework]}`, ...converted.notes],
  };
}

/**
 * The framework of a proposal's document: the names of the custom properties of its top-level `:root` rules. A
 * `--xb-` name means Histeon CSS; otherwise a name that Automatic.css has in proposalAcssTokens() means ACSS.
 */
export function proposalFramework(doc: string): ProposalFramework {
  const tokens = proposalAcssTokens();
  let histeon = false;
  let acss = false;
  for (const element of elementsOf(parseHtml(doc).childNodes, "style")) {
    const root = parseCss(textOf(element));
    if (root === undefined) continue;
    for (const rule of root.nodes) {
      if (rule.type !== "rule" || rule.selector.trim() !== ":root") continue;
      for (const declaration of rule.nodes) {
        if (declaration.type !== "decl" || !declaration.prop.startsWith("--")) continue;
        if (declaration.prop.startsWith("--xb-")) histeon = true;
        else if (tokens.has(declaration.prop.slice(2))) acss = true;
      }
    }
  }
  if (histeon) return "histeon";
  return acss ? "acss" : "none";
}

function dataScriptText(html: string): string | undefined {
  for (const element of elementsOf(parseHtml(html).childNodes, "script")) {
    if (attribute(element, "id") !== PROPOSALS_DATA_ID) continue;
    const type = attribute(element, "type")?.toLowerCase().replace(/\s/gu, "");
    if (type === "application/json") return textOf(element);
  }
  return undefined;
}

function elementsOf(nodes: readonly Node[], tagName: string): Element[] {
  const found: Element[] = [];
  const visit = (children: readonly Node[]): void => {
    for (const node of children) {
      if (!isElement(node)) continue;
      if (node.tagName === tagName) found.push(node);
      visit(node.childNodes);
      if (node.tagName === "template" && "content" in node) visit(node.content.childNodes);
    }
  };
  visit(nodes);
  return found;
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function textOf(element: Element): string {
  return element.childNodes.map((node) => (node.nodeName === "#text" ? (node as TextNode).value : "")).join("");
}

function parseCss(css: string): Root | undefined {
  try {
    return postcss.parse(css);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string trimmed and cut to `max` characters; anything else is "". */
function trimmedText(value: unknown, max: number): string {
  return typeof value === "string" ? Array.from(value.trim()).slice(0, max).join("") : "";
}

/** The trimmed name, cut to `max`, or the id when there is no name. */
function nameOf(value: unknown, id: string, max: number): string {
  return trimmedText(value, max) || id;
}

/** What convertProposalVariables gives back: `doc` is the proposal's document with its variables converted. */
export interface ProposalVariablesResult {
  doc: string;
  /** Colors for the `design` of the manifest: family → value, with `<family>_on: "1"` where the color is on. */
  design: Record<string, string>;
  renamed: Array<{ from: string; to: string; count: number }>;
  /** Variables the proposal uses that Histeon CSS does not read, with «--». */
  unmapped: string[];
  /** Custom properties taken out of the top-level :root because nothing uses them, with «--». */
  dropped: string[];
  notes: string[];
}

const DESIGN_FAMILIES = ["primary", "secondary", "tertiary", "accent", "neutral"];
const HISTEON_DESIGN_FAMILIES = [...DESIGN_FAMILIES, "success", "warning", "danger", "info"];
const ON_FAMILIES = new Set(["secondary", "tertiary", "accent", "success", "warning", "danger", "info"]);
const NOTE_LIST_MAX = 8;
const RESOLVE_LEVELS_MAX = 10;
const NO_FRAMEWORK_NOTE = "la proposta non usa le variabili di ACSS né di Histeon CSS: i valori restano com'erano";
const UNREADABLE_SHEET_NOTE = "un foglio di stile della proposta non si legge: lasciato com'è";
/** var(--name) or var(--name, fallback); the fallback may hold one level of parentheses. */
const VAR_REFERENCE = /var\(\s*--([A-Za-z0-9_-]+)(?:\s*,\s*((?:[^()]|\([^()]*\))*))?\)/gu;
/** The start of var(--name); the name is the first capture. */
const VAR_NAME = /var\(\s*--([A-Za-z0-9_-]+)/gu;

/**
 * Turns the variables of one proposal into the names Histeon CSS reads. With ACSS, every name in the table of
 * proposalAcssTokens() becomes its --xb-* token. With either framework, the :root keeps only what the proposal still
 * uses, and the colors of the :root go to the `design` of the manifest.
 */
export function convertProposalVariables(doc: string, framework: ProposalFramework): ProposalVariablesResult {
  if (framework === "none") return { doc, design: {}, renamed: [], unmapped: [], dropped: [], notes: [NO_FRAMEWORK_NOTE] };
  const isHisteon = framework === "histeon";
  const tokens = proposalAcssTokens();
  const html = parseHtml(doc);
  const sheets = elementsOf(html.childNodes, "style").map((element) => ({ element, root: parseCss(textOf(element)) }));
  const readable = sheets.flatMap((sheet) => (sheet.root ? [sheet.root] : []));
  const unreadable = sheets.filter((sheet) => sheet.root === undefined);

  // The values of the custom properties of the top-level :root rules; the last one wins.
  const rootValues = new Map<string, string>();
  for (const root of readable) for (const rule of topLevelRoots(root)) for (const decl of customDeclarations(rule)) rootValues.set(decl.prop, decl.value.trim());

  // The design colors, read before the names change.
  const prefix = isHisteon ? "--xb-" : "--";
  const design: Record<string, string> = {};
  const kept: string[] = [];
  const unread: string[] = [];
  for (const family of isHisteon ? HISTEON_DESIGN_FAMILIES : DESIGN_FAMILIES) {
    const name = `${prefix}${family}`;
    const raw = rootValues.get(name);
    if (raw === undefined) continue;
    const value = resolveVariables(raw, rootValues, 0);
    if (!isUsableColor(family, value)) {
      unread.push(name);
      continue;
    }
    design[family] = value;
    kept.push(family);
    if (ON_FAMILIES.has(family)) design[`${family}_on`] = "1";
  }

  // ACSS names become Histeon CSS tokens, in the style sheets that were read and then in the style attributes.
  const renamed = new Map<string, { to: string; count: number }>();
  const renameIn = (value: string): string =>
    value.replace(VAR_NAME, (match: string, name: string) => {
      const token = tokens.get(name);
      if (token === undefined) return match;
      const from = `--${name}`;
      const entry = renamed.get(from) ?? { to: `--${token}`, count: 0 };
      entry.count += 1;
      renamed.set(from, entry);
      return `${match.slice(0, match.length - name.length - 2)}--${token}`;
    });
  if (framework === "acss") {
    for (const root of readable) {
      root.walkDecls((decl) => {
        const next = renameIn(decl.value);
        if (next !== decl.value) decl.value = next;
      });
    }
    for (const element of allElements(html.childNodes)) for (const attr of element.attrs) if (attr.name === "style") attr.value = renameIn(attr.value);
    // A shade of a family that is off by default (--tertiary-light) without the family's own color: the family is
    // turned on, or its --xb-* tokens would not exist.
    for (const { to } of renamed.values()) {
      const family = /^--xb-([a-z]+)(?:-|$)/u.exec(to)?.[1];
      if (family && ON_FAMILIES.has(family) && DESIGN_FAMILIES.includes(family) && design[`${family}_on`] === undefined) design[`${family}_on`] = "1";
    }
  }

  // The :root declarations the framework provides go: ACSS names are in the table, Histeon CSS ones start with xb-.
  let histeonTokens = 0;
  for (const root of readable) {
    for (const rule of topLevelRoots(root)) {
      for (const decl of customDeclarations(rule)) {
        const name = decl.prop.slice(2);
        const provided = isHisteon ? name.startsWith("xb-") : tokens.has(name);
        if (!provided) continue;
        decl.remove();
        if (isHisteon) histeonTokens += 1;
      }
    }
  }

  // The names in use: the values outside the top-level :root rules and the style attributes (a sheet that does not
  // read is taken as text), then the names used by the definitions that stay, as far as they go.
  const used = new Set<string>();
  for (const sheet of sheets) {
    if (sheet.root === undefined) for (const name of namesIn(textOf(sheet.element))) used.add(name);
    else {
      sheet.root.walkDecls((decl) => {
        if (!insideTopLevelRoot(decl)) for (const name of namesIn(decl.value)) used.add(name);
      });
    }
  }
  for (const element of allElements(html.childNodes)) for (const attr of element.attrs) if (attr.name === "style") for (const name of namesIn(attr.value)) used.add(name);
  const definitions: Array<{ name: string; decl: Declaration }> = [];
  for (const root of readable) for (const rule of topLevelRoots(root)) for (const decl of customDeclarations(rule)) definitions.push({ name: decl.prop, decl });
  let grown = true;
  while (grown) {
    grown = false;
    for (const { name, decl } of definitions) {
      if (!used.has(name)) continue;
      for (const ref of namesIn(decl.value)) {
        if (used.has(ref)) continue;
        used.add(ref);
        grown = true;
      }
    }
  }
  const dropped: string[] = [];
  for (const { name, decl } of definitions) {
    if (used.has(name)) continue;
    decl.remove();
    if (!dropped.includes(name)) dropped.push(name);
  }
  for (const root of readable) for (const rule of topLevelRoots(root)) if (!rule.nodes.some((node) => node.type === "decl")) rule.remove();
  const unmapped = [...used].filter((name) => !name.startsWith("--xb-"));

  for (const sheet of sheets) {
    if (sheet.root === undefined) continue;
    const css = sheet.root.toString();
    if (css !== textOf(sheet.element)) setText(sheet.element, css);
  }

  const renamedList = [...renamed].map(([from, entry]) => ({ from, to: entry.to, count: entry.count }));
  const notes: string[] = [];
  if (framework === "acss" && renamedList.length > 0) {
    const count = renamedList.length === 1 ? "1 variabile convertita" : `${renamedList.length} variabili convertite`;
    notes.push(`ACSS → Histeon CSS: ${count} (${listOf(renamedList.map((item) => `${item.from} → ${item.to}`))})`);
  }
  if (kept.length > 0) notes.push(`colori della proposta nel design di Histeon CSS: ${kept.join(", ")}`);
  if (unread.length > 0) notes.push(`colori che Histeon CSS non legge, lasciati al design di serie: ${unread.join(", ")}`);
  if (unmapped.length === 1) notes.push(`variabile senza corrispondenza in Histeon CSS, resta nel :root del prototipo: ${listOf(unmapped)}`);
  else if (unmapped.length > 1) notes.push(`variabili senza corrispondenza in Histeon CSS, restano nel :root del prototipo: ${listOf(unmapped)}`);
  if (dropped.length > 0) notes.push(`variabili non più usate tolte dal :root: ${listOf(dropped)}`);
  if (histeonTokens > 0) notes.push(`token di Histeon CSS presi dal design del progetto, non dal :root della proposta: ${histeonTokens}`);
  if (unreadable.length > 0) notes.push(UNREADABLE_SHEET_NOTE);

  return { doc: serialize(html), design, renamed: renamedList, unmapped, dropped, notes };
}

/** The top-level :root rules of a style sheet. */
function topLevelRoots(root: Root): Rule[] {
  return root.nodes.filter((node): node is Rule => node.type === "rule" && node.selector.trim() === ":root");
}

/** The custom properties («--x») declared in a rule. */
function customDeclarations(rule: Rule): Declaration[] {
  return rule.nodes.filter((node): node is Declaration => node.type === "decl" && node.prop.startsWith("--"));
}

function insideTopLevelRoot(decl: Declaration): boolean {
  const parent = decl.parent as Rule | undefined;
  return parent?.type === "rule" && parent.parent?.type === "root" && parent.selector.trim() === ":root";
}

/** The names («--x») of the variables a value uses. */
function namesIn(value: string): string[] {
  return [...value.matchAll(VAR_NAME)].map((match) => `--${match[1] ?? ""}`);
}

/** A value with each var(--y) or var(--y, fallback) replaced by the value of --y, or by the fallback (trimmed); up to 10 levels. */
function resolveVariables(value: string, values: ReadonlyMap<string, string>, level: number): string {
  if (level >= RESOLVE_LEVELS_MAX) return value;
  return value.replace(VAR_REFERENCE, (match: string, name: string, fallback: string | undefined) => {
    const found = values.get(`--${name}`);
    if (found !== undefined) return resolveVariables(found, values, level + 1);
    const trimmed = fallback?.trim() ?? "";
    return trimmed === "" ? match : resolveVariables(trimmed, values, level + 1);
  });
}

/** True when validateHistosDesign takes the value for that family. */
function isUsableColor(family: string, value: string): boolean {
  try {
    validateHistosDesign({ [family]: value });
    return true;
  } catch {
    return false;
  }
}

/** The first NOTE_LIST_MAX items separated by «, », then «e altre N» for the rest. */
function listOf(items: readonly string[]): string {
  const shown = items.slice(0, NOTE_LIST_MAX).join(", ");
  const rest = items.length - NOTE_LIST_MAX;
  return rest > 0 ? `${shown} e altre ${rest}` : shown;
}

/** Every element of the tree, template contents included. */
function allElements(nodes: readonly Node[]): Element[] {
  const found: Element[] = [];
  const visit = (children: readonly Node[]): void => {
    for (const node of children) {
      if (!isElement(node)) continue;
      found.push(node);
      visit(node.childNodes);
      if (node.tagName === "template" && "content" in node) visit(node.content.childNodes);
    }
  };
  visit(nodes);
  return found;
}

function setText(element: Element, text: string): void {
  element.childNodes = [];
  defaultTreeAdapter.insertText(element, text);
}
