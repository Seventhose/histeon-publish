import { HISTOS_PUBLISH_VERSION } from "./version.js";
import { createHash, randomUUID } from "node:crypto";
import yauzl from "yauzl";
import type { Entry as ZipEntry } from "yauzl";
import yazl from "yazl";
import {
  canonicalRevisionPayload,
  canonicalizeJson,
  manifestHashInput,
  parseJsonStrict,
  PRODUCT_CAPABILITY,
  SCRIPT_CAPABILITY,
  transferUsesScripts,
  transferUsesProducts,
  validateStaticPageProfile,
  validateTransferEntity,
  validateTransferManifest,
  type JsonValue,
  type StaticPageProfile,
  type TransferEntity,
  type TransferManifest,
  type TransferReference,
} from "@histos-publish/histos-contract";
import type { CmsProject, CmsProjectStore } from "./project-repository.js";
import { stylesData } from "./histos-css.js";
import { SITE_TOKENS_SHEET_ID, siteTokenDeclarations } from "./histos-design.js";
import { assertCssResourcesBundled } from "./css-resources.js";
import { FONT_SHEET_ID } from "./local-fonts.js";
import { findClosingBrace, GROUP_BY_FIELD_PATTERN, GROUP_BY_HOW_PATTERN, loopElse, parseBlockGrammar, parseExpression, parseXb, serializeXb, type Expr, type XbBlock } from "../.generated/histos-dsl/index.js";
import {
  blocksUseSvgText,
  blocksUseTransferMarkupV1,
  checkTransferBlock,
  decodeTransferAttribute,
  checkTransferBranches,
  checkTransferChildren,
  checkTransferElement,
  checkTransferText,
  childContext,
  formatTransferSrcset,
  isTransferMediaProp,
  isWholeInterpolation,
  parseTransferSrcset,
  TRANSFER_ROOT_CONTEXT,
  TRANSFER_SVG_TAGS,
  TRANSFER_URL_ATTRIBUTES,
  TransferMarkupError,
  transferChildKind,
  transferMediaId,
  type TransferMarkupContext,
} from "./transfer-markup.js";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_TRANSFER_MANIFEST_BYTES = 8 * 1024 * 1024;
const ENGINE_COMMIT = "9bc212050403dd056ac21edfcff398b514e4a3c1";

function stableEntityId(projectId: string, kind: string, key: string): string {
  const namespace = Buffer.from(projectId.replaceAll("-", ""), "hex");
  if (namespace.byteLength !== 16) throw new TypeError("Identificativo del progetto non valido.");
  const digest = createHash("sha1").update(namespace).update(`${kind}:${key}`, "utf8").digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashEntity(entity: Pick<TransferEntity, "kind" | "schemaVersion" | "payload">): string {
  return sha256(Buffer.from(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8"));
}

export function createTransferTombstone(previous: TransferEntity, deletedAt = new Date().toISOString()): TransferEntity {
  validateTransferEntity(previous);
  const supportedKinds = new Set(["document", "content-record", "component", "template-part", "template", "asset"]);
  if (previous.kind === "tombstone" || !supportedKinds.has(previous.kind)) throw new TypeError("Questo tipo di elemento non può essere rimosso in modo recuperabile.");
  if (!Number.isFinite(Date.parse(deletedAt)) || new Date(deletedAt).toISOString() !== deletedAt) throw new TypeError("Data della tombstone non valida.");
  const labelValue = previous.payload.title ?? previous.payload.ref ?? previous.payload.key;
  const payload = {
    entityKind: previous.kind,
    deletedAt,
    label: typeof labelValue === "string" && labelValue.trim() ? labelValue : previous.id,
    previousRevisionHash: previous.revisionHash,
    previousPayload: previous.payload,
  } as Record<string, JsonValue>;
  const tombstone: TransferEntity = {
    id: previous.id,
    kind: "tombstone",
    schemaVersion: 1,
    revisionHash: hashEntity({ kind: "tombstone", schemaVersion: 1, payload }),
    ...(previous.baseHash ? { baseHash: previous.baseHash } : {}),
    payload,
  };
  validateTransferEntity(tombstone);
  return tombstone;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function transferFile(path: string, bytes: Buffer, mediaType: string) {
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes), mediaType };
}

function ndjson(values: unknown[]): Buffer {
  return values.length ? Buffer.from(values.map((value) => canonicalizeJson(json(value))).join("\n") + "\n", "utf8") : Buffer.alloc(0);
}

export const TRANSFER_MODIFIERS: ReadonlySet<string> = new Set([
  "upper", "lower", "capitalize", "trim", "inline", "stripTags", "truncateWords", "truncateChars", "date", "number", "length", "first", "last", "join", "slice", "includes", "pluck", "groupBy", "default", "json", "slug",
]);
/**
 * The elements a transfer profile carries, in two lines of the AI manual kept equal by a test: the HTML elements
 * (TRANSFER_TAGS) and the static inline SVG subset (TRANSFER_SVG_TAGS). The rules are in transfer-markup.ts.
 */
export { TRANSFER_SVG_TAGS, TRANSFER_TAGS } from "./transfer-markup.js";

function validateTransferExpression(source: string, roots: ReadonlySet<string>, ownerId: string): void {
  const expression = parseExpression(source);
  const visit = (node: Expr): void => {
    switch (node.type) {
      case "Literal": return;
      case "Identifier":
        if (!roots.has(node.name)) throw new TypeError(`L’espressione ${node.name} non ha uno scope portabile nel documento ${ownerId}.`);
        return;
      case "Member":
        // `url.path` travels (doc 23, item 189), as in the plugin's ProfileValidator; `url.query` does not.
        if (node.property === "path" && node.object.type === "Identifier" && node.object.name === "url" && !roots.has("url")) return;
        visit(node.object);
        return;
      case "Index": visit(node.object); visit(node.index); return;
      case "Unary": visit(node.argument); return;
      case "Conditional": visit(node.test); visit(node.consequent); visit(node.alternate); return;
      case "Binary": visit(node.left); visit(node.right); return;
      case "Array": for (const item of node.elements) visit(item); return;
      case "Object": for (const property of node.properties) visit(property.value); return;
      case "Call":
        if (node.callee.type !== "Member" || !TRANSFER_MODIFIERS.has(node.callee.property)) {
          throw new TypeError(`Il modifier dell’espressione non è disponibile in Histeon CMS: ${ownerId}.`);
        }
        visit(node.callee.object);
        for (const argument of node.args) visit(argument.value);
        return;
    }
  };
  visit(expression);
}

function validateInterpolations(value: string, roots: ReadonlySet<string>, ownerId: string, inlineText = false): void {
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "\\" && (value[index + 1] === "{" || value[index + 1] === "}")) { index++; continue; }
    if (inlineText && char === "<" && (value[index + 1] === "!" || value[index + 1] === "?")) {
      throw new TransferMarkupError("text", `Il testo non può contenere commenti HTML o istruzioni <? ?>: ${ownerId}.`);
    }
    if (inlineText && char === "<" && /[A-Za-z/]/u.test(value[index + 1] ?? "")) {
      let quote = "";
      let close = index + 1;
      for (; close < value.length; close++) {
        const current = value[close]!;
        if (quote) { if (current === quote) quote = ""; continue; }
        if (current === "\"" || current === "'") { quote = current; continue; }
        if (current === ">") break;
      }
      if (close >= value.length) throw new TypeError(`Markup inline non chiuso nel documento ${ownerId}.`);
      if (/[{}]/u.test(value.slice(index, close + 1))) throw new TypeError(`Gli attributi del markup inline non ammettono valori dinamici: ${ownerId}.`);
      index = close;
      continue;
    }
    if (char === "{") {
      const close = findClosingBrace(value, index);
      validateTransferExpression(value.slice(index + 1, close), roots, ownerId);
      index = close;
      continue;
    }
    if (char === "}") throw new TypeError(`Graffa non escapata nel documento ${ownerId}.`);
  }
}

/**
 * Where media of a document may point. Exporting a local project rewrites `/__cms-media/<project>/<id>` to the portable
 * `histos-media://<id>`; a profile being read must already use `histos-media://` identities of its image assets.
 */
type TransferMediaMode =
  | { mode: "export"; projectId: string; imageAssetIds: ReadonlySet<string> | null }
  | { mode: "import"; imageAssetIds: ReadonlySet<string> | null };

const MEDIA_PATH = /^\/__cms-media\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/iu;

function mediaViolation(message: string): never {
  throw new TransferMarkupError("media", message);
}

/** The asset id one media URL of a document stands for, or a `media` violation. */
function portableMediaId(value: string, media: TransferMediaMode, ownerId: string): string {
  let id: string | null = null;
  if (media.mode === "export") {
    const local = MEDIA_PATH.exec(value);
    if (local?.[1]?.toLowerCase() === media.projectId.toLowerCase() && local[2]) id = local[2].toLowerCase();
  }
  id ??= transferMediaId(value);
  if (id === null) {
    mediaViolation(`Il documento ${ownerId} usa un’immagine che non è un media del progetto (${value.slice(0, 80)}): caricala nella libreria media per trasferirla.`);
  }
  if (media.imageAssetIds && !media.imageAssetIds.has(id)) mediaViolation(`Il documento ${ownerId} fa riferimento a un media assente dal trasferimento o che non è un’immagine: ${id}.`);
  return id;
}

/**
 * The builder's built-in loop sources that a transfer carries without a query preset of the project (the builder's
 * ProfileValidator::TRANSFER_BUILTIN_QUERY_PRESETS, for every owner: page, post, component, part, template): `main`,
 * WordPress's main query, $wp_query->posts, the only one Histeon renders (static-renderer.ts, mainQuery). The project
 * cannot declare a query with that name (content-model.ts reserves it), and its arguments are expressions read like any
 * other: the builder ignores them, and the prototype check refuses them where they are written (prototype-import.ts,
 * structureIssues), as it refuses main() where it lists nothing.
 */
const TRANSFER_BUILTIN_QUERY_PRESETS: ReadonlySet<string> = new Set(["main"]);

function normalizeContentForTransfer(
  content: string,
  media: TransferMediaMode,
  ownerId: string,
  componentIdsByRef: ReadonlyMap<string, string> = new Map(),
  ownerKind: "document" | "component" | "template-part" | "template" = "document",
  queryPresetKeys: ReadonlySet<string> = new Set(),
  hasDataSources = false,
  paste = false,
): { content: string; references: TransferReference[]; blocks: XbBlock[] } {
  const parsed = parseXb(content);
  try {
    checkTransferBranches(parseBlockGrammar(content));
  } catch (error) {
    if (error instanceof TransferMarkupError) throw new TransferMarkupError(error.reason, `${error.message} Documento: ${ownerId}.`);
    throw error;
  }
  if (parsed.issues.length) throw new TypeError(`Il documento ${ownerId} richiede riparazioni prima del trasferimento: ${parsed.issues[0]}`);
  const output: TransferReference[] = [];
  const uids = new Set<string>();
  const allowSlots = ownerKind !== "document";
  const initialRoots = new Set(ownerKind === "document" ? ["page", "this"] : ["props", "slots", "page", "this"]);
  if (hasDataSources) initialRoots.add("data");
  const visit = (block: XbBlock, parent: XbBlock["name"] | null, roots: ReadonlySet<string>, ctx: TransferMarkupContext): void => {
    const name = block.name;
    // A block of WordPress that left the site whole: it can only go back there unchanged, and WordPress checks that.
    if (name === "xb/passthrough" && ownerKind === "document") {
      if (uids.has(block.attrs.uid)) throw new TypeError(`UID Histeon duplicato nel documento ${ownerId}: ${block.attrs.uid}.`);
      uids.add(block.attrs.uid);
      // Not inside svg, select, option, textarea or picture, where the parser would read its HTML otherwise (audit note 88).
      checkTransferBlock(name, ctx);
      return;
    }
    if (!["xb/element", "xb/text", "xb/component", "xb/if", "xb/branch", "xb/loop", "xb/slot", "xb/slot-fill"].includes(name)) {
      throw new TypeError(`Il profilo CMS non trasferisce il blocco ${block.name}; il documento resta locale.`);
    }
    if (uids.has(block.attrs.uid)) throw new TypeError(`UID Histeon duplicato nel documento ${ownerId}: ${block.attrs.uid}.`);
    uids.add(block.attrs.uid);
    if (name === "xb/branch" && parent !== "xb/if" && parent !== "xb/loop") throw new TransferMarkupError("context", `Un ramo condizionale è fuori da xb/if e da un loop nel documento ${ownerId}.`);
    if (name === "xb/slot-fill" && parent !== "xb/component") throw new TypeError(`Uno slot-riempimento è fuori da xb/component nel documento ${ownerId}.`);
    if (name === "xb/slot" && !allowSlots) throw new TypeError(`Lo slot ${block.attrs.name} è ammesso solo in componenti o template: ${ownerId}.`);
    if (parent === "xb/if" && name !== "xb/branch") throw new TypeError(`xb/if può contenere soltanto xb/branch: ${ownerId}.`);
    if (parent === "xb/component" && name !== "xb/slot-fill") throw new TypeError(`xb/component può contenere soltanto xb/slot-fill: ${ownerId}.`);
    checkTransferBlock(name, ctx);
    if (block.name === "xb/if") {
      if (!block.children.length || block.children[0]?.attrs.test === undefined || block.children.slice(0, -1).some((branch) => branch.attrs.test === undefined)) {
        throw new TypeError(`La struttura dei rami di xb/if non è valida nel documento ${ownerId}.`);
      }
      for (const branch of block.children) if (branch.attrs.test !== undefined) validateTransferExpression(branch.attrs.test, roots, ownerId);
    }
    if (block.name === "xb/loop") {
      if (block.attrs.source.kind === "expr") validateTransferExpression(block.attrs.source.expr, roots, ownerId);
      else {
        if (!queryPresetKeys.has(block.attrs.source.id) && !TRANSFER_BUILTIN_QUERY_PRESETS.has(block.attrs.source.id)) throw new TypeError(`La query ${block.attrs.source.id} non è inclusa nel trasferimento CMS.`);
        for (const expression of Object.values(block.attrs.source.args ?? {})) validateTransferExpression(expression, roots, ownerId);
        // A query's result in groups (doc 23, item 187), as the plugin's ProfileValidator: {field, how?}, texts only.
        const groupBy = block.attrs.source.groupBy;
        if (groupBy !== undefined && (Object.keys(groupBy).some((key) => key !== "field" && key !== "how") || !GROUP_BY_FIELD_PATTERN.test(groupBy.field) || (groupBy.how !== undefined && !GROUP_BY_HOW_PATTERN.test(groupBy.how)))) {
          throw new TypeError(`Il raggruppamento della query ${block.attrs.source.id} non è valido nel documento ${ownerId}.`);
        }
      }
    }
    if (block.name === "xb/text") {
      checkTransferText(block.attrs.content, block.attrs.verbatim === true, ctx);
      if (block.attrs.verbatim !== true) validateInterpolations(block.attrs.content, roots, ownerId, true);
    }
    if (block.name === "xb/element") {
      const tag = block.attrs.tag;
      const attributes = block.attrs.attributes ?? {};
      checkTransferElement(tag, attributes, ctx);
      checkTransferChildren(tag, block.children.map(transferChildKind));
      // A form pasted from outside sends its data to this site only: on WordPress the restricted tier writes no form at all.
      if (paste && tag === "form" && typeof attributes.action === "string" && !isSameSiteAction(decodeTransferAttribute(attributes.action, "L’action del modulo"))) {
        throw new TransferMarkupError("form", `Un modulo nel documento ${ownerId} manda i dati a un altro sito (${attributes.action.slice(0, 80)}): da fuori si incolla solo un modulo con un percorso di questo sito. Un modulo verso un servizio esterno si scrive nel prototipo o nel pannello del codice.`);
      }
      if (paste) for (const [attribute, value] of Object.entries(attributes)) {
        if (typeof value === "string" && PASTE_URL_ATTRIBUTES.has(attribute) && /[{}]/u.test(value) && !isPastePathExpression(value)) {
          throw new TransferMarkupError("dynamic", `L’attributo ${attribute} di <${tag}> nel documento ${ownerId} può essere dinamico solo come un dato intero ({post.url}, {props.link}): niente testo, letterali o modificatori attorno.`);
        }
      }
      // SVG values are static by the element check: only HTML values can hold expressions.
      if (!TRANSFER_SVG_TAGS.has(tag)) for (const value of Object.values(attributes)) if (typeof value === "string") validateInterpolations(value, roots, ownerId);
      const src = attributes.src;
      if (src !== undefined && src !== "") {
        if (src === true) mediaViolation(`L’attributo src di <${tag}> nel documento ${ownerId} deve indicare un media del progetto.`);
        // Only a component's image prop as a whole is dynamic (`{props.immagine}`); any other expression is refused.
        if (isWholeInterpolation(src) && !isTransferMediaProp(src)) mediaViolation(`L’attributo src di <${tag}> nel documento ${ownerId} può essere dinamico solo come {props.nome} di un componente.`);
        if (!isTransferMediaProp(src)) {
          const targetId = portableMediaId(src, media, ownerId);
          attributes.src = `histos-media://${targetId}`;
          output.push({ ownerId, blockUid: block.attrs.uid, path: "attrs.attributes.src", targetId, role: "media" });
        }
      }
      // Doc 23 item 121: a link to a media file of the project travels as its identity, like a src.
      const href = attributes.href;
      if (tag === "a" && typeof href === "string" && (MEDIA_PATH.test(href) || transferMediaId(href) !== null)) {
        const targetId = portableMediaId(href, media, ownerId);
        attributes.href = `histos-media://${targetId}`;
        output.push({ ownerId, blockUid: block.attrs.uid, path: "attrs.attributes.href", targetId, role: "media" });
      }
      const srcset = attributes.srcset;
      if ((tag === "img" || tag === "source") && typeof srcset === "string") {
        const candidates = parseTransferSrcset(srcset) ?? mediaViolation(`Il srcset di <${tag}> nel documento ${ownerId} non è un elenco di media del progetto.`);
        const portable = candidates.map((candidate, index) => {
          const targetId = portableMediaId(candidate.url, media, ownerId);
          output.push({ ownerId, blockUid: block.attrs.uid, path: "attrs.attributes.srcset", targetId, role: "media", index });
          return { url: `histos-media://${targetId}`, descriptor: candidate.descriptor };
        });
        attributes.srcset = formatTransferSrcset(portable);
      }
    }
    if (block.name === "xb/component") for (const [name, value] of Object.entries(block.attrs.props ?? {})) {
      if (typeof value === "object" && value !== null && "expr" in value) validateTransferExpression(value.expr, roots, ownerId);
      if (typeof value === "object" && value !== null && "tpl" in value) validateInterpolations(value.tpl, roots, ownerId);
      // An image written in a prop of the instance travels like the src of an element.
      if (typeof value === "string" && (MEDIA_PATH.test(value) || transferMediaId(value))) {
        const targetId = portableMediaId(value, media, ownerId);
        block.attrs.props![name] = `histos-media://${targetId}`;
        output.push({ ownerId, blockUid: block.attrs.uid, path: `attrs.props.${name}`, targetId, role: "media" });
      }
    }
    if (block.name === "xb/component") {
      const targetId = componentIdsByRef.get(block.attrs.ref);
      if (!targetId) throw new TypeError(`Il componente Histeon ${block.attrs.ref} non appartiene al progetto e non può essere trasferito.`);
      output.push({ ownerId, blockUid: block.attrs.uid, path: "attrs.ref", targetId, role: "document" });
    }
    if ("children" in block) {
      const childRoots = block.name === "xb/loop" ? new Set([...roots, block.attrs.as, ...(block.attrs.index ? [block.attrs.index] : [])]) : roots;
      const nextContext = block.name === "xb/element" ? childContext(ctx, block.attrs.tag) : ctx;
      // A loop's `{:else}` (its last branch, without a test) shows when there are no items: no loop variable in it.
      const empty = block.name === "xb/loop" ? loopElse(block) : null;
      for (const child of block.children) {
        if (block.name === "xb/loop" && child.name === "xb/branch" && child !== empty) throw new TransferMarkupError("context", `Il ramo di un loop è solo {:else}, senza condizione e in fondo, nel documento ${ownerId}.`);
        visit(child, block.name, child === empty ? roots : childRoots, nextContext);
      }
    }
  };
  try {
    for (const block of parsed.blocks) visit(block, null, initialRoots, TRANSFER_ROOT_CONTEXT);
  } catch (error) {
    // Name the document: the markup checks only know the element.
    if (error instanceof TransferMarkupError && !error.message.includes(ownerId)) throw new TransferMarkupError(error.reason, `${error.message} Documento: ${ownerId}.`);
    throw error;
  }
  return { content: serializeXb(parsed.blocks), references: output, blocks: parsed.blocks };
}

/** The attributes that hold an address: in a paste, only a whole data path may make them dynamic (checkPastedContent). */
const PASTE_URL_ATTRIBUTES: ReadonlySet<string> = new Set([...TRANSFER_URL_ATTRIBUTES, "src", "srcset", "action", "formaction", "xlink:href"]);

/**
 * A URL attribute's value that is one data path read whole, `{post.url}`, `{props.link}`, `{page.nextUrl}`: identifiers
 * and dotted names only. A literal (`{'javascript:…'}`), a modifier, an operator, an index or text around the braces
 * (`java{''}script:`) could build any address. A path can still read a literal of the same paste (a loop over a
 * literal list, a literal component prop), so the real guard is the build, which refuses an active scheme in the
 * `href`, `src`, `poster` and `xlink:href` it prints (static-renderer.ts, safeUrlAttribute); `cite` and the other
 * URL attributes are never followed by a browser.
 */
function isPastePathExpression(value: string): boolean {
  if (!isWholeInterpolation(value)) return false;
  let expression: Expr;
  try {
    expression = parseExpression(value.slice(1, -1));
  } catch {
    return false;
  }
  for (let node: Expr = expression; ; node = node.object) {
    if (node.type === "Identifier") return true;
    if (node.type !== "Member") return false;
  }
}

/**
 * A form action that stays on this site, read as a browser reads the address: tab, LF and CR anywhere and the control
 * characters and spaces in front are dropped; then no scheme (`https:`) and no `//host` (or `\\host`) may lead.
 */
function isSameSiteAction(decoded: string): boolean {
  let start = 0;
  while (start < decoded.length && decoded.charCodeAt(start) <= 0x20) start++;
  const address = [...decoded.slice(start)].filter((char) => char !== "\t" && char !== "\n" && char !== "\r").join("");
  return !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/]{2})/u.test(address);
}

/** What the project of a paste has, for checkPastedContent: its media, components, parts and queries. */
export interface PasteProjectContext {
  projectId: string;
  imageAssetIds: ReadonlySet<string>;
  componentRefs: readonly string[];
  queryPresetKeys: ReadonlySet<string>;
  hasDataSources: boolean;
}

/**
 * The builder's restricted tier for the clipboard in the local CMS (`POST paste/sanitize`): the content as a transfer
 * of the project would read it (normalizeContentForTransfer, as a component: props, slots, page and this), so nothing
 * enters by a paste that the project could not export. That is: no repair by parseXb, branches as written
 * (checkTransferBranches), only the blocks a transfer carries, histos-transfer-markup-v1, scopes, components and
 * queries of the project, media only of this project (`/__cms-media/<project>/…`, its `histos-media://` assets) or a
 * whole `{props.x}`; and, stricter than a transfer, an address attribute dynamic only as a whole data path
 * (isPastePathExpression). Throws TransferMarkupError or TypeError with the first reason.
 */
export function checkPastedContent(content: string, project: PasteProjectContext): void {
  const components = new Map(project.componentRefs.map((ref, index) => [ref, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
  normalizeContentForTransfer(content, { mode: "export", projectId: project.projectId, imageAssetIds: project.imageAssetIds }, "incollato", components, "component", project.queryPresetKeys, project.hasDataSources, true);
}

/**
 * Checks one document of a profile as an import does (shared fixtures, docs/spec/cms-bridge.md §14): the markup, the
 * expression scopes and the media identities, which must be image assets in `assetIds`. A violation of the markup
 * throws TransferMarkupError with its reason code.
 */
export function validateTransferDocument(
  content: string,
  options: { ownerKind?: "document" | "component" | "template-part" | "template"; assetIds?: readonly string[]; ownerId?: string; componentRefs?: readonly string[] } = {},
): TransferReference[] {
  const ownerId = options.ownerId ?? "00000000-0000-4000-8000-000000000000";
  const components = new Map((options.componentRefs ?? []).map((ref, index) => [ref, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
  return normalizeContentForTransfer(content, { mode: "import", imageAssetIds: new Set(options.assetIds ?? []) }, ownerId, components, options.ownerKind ?? "document").references;
}

/** True when a profile needs a reader of histos-transfer-markup-v1: SVG, picture, details, srcset media or verbatim text. */
export function profileUsesTransferMarkupV1(profile: StaticPageProfile): boolean {
  if (profile.references.some((reference) => reference.path === "attrs.attributes.srcset")) return true;
  return profile.entities.some((entity) => ["document", "component", "template-part", "template"].includes(entity.kind)
    && typeof entity.payload.content === "string" && blocksUseTransferMarkupV1(parseXb(entity.payload.content).blocks));
}

/** True when a profile links a media file (`<a href="histos-media://…">`, doc 23 item 121): the site must read it. */
/** Whether an expression of the profile reads `url.path`: a site without histos-url-path-v1 would refuse it (item 189). */
export function profileUsesUrlPath(profile: StaticPageProfile): boolean {
  return profile.entities.some((entity) => typeof entity.payload.content === "string" && /(?<![\w$.])url\s*\.\s*path\b/u.test(entity.payload.content));
}

/** Whether a loop of the profile groups a query's result (`foto().groupBy("anno")`, item 187): it needs histos-loop-group-v1. */
export function profileUsesLoopGroup(profile: StaticPageProfile): boolean {
  return profile.entities.some((entity) => typeof entity.payload.content === "string" && /"groupBy":\{/u.test(entity.payload.content));
}

/**
 * Whether a drawing of the profile has text, gradients, inline style or states (blocksUseSvgText): it needs a site
 * that reads histos-svg-text-v1.
 */
export function profileUsesSvgText(profile: StaticPageProfile): boolean {
  return profile.entities.some((entity) => ["document", "component", "template-part", "template"].includes(entity.kind)
    && typeof entity.payload.content === "string" && /"tag":"svg"/u.test(entity.payload.content) && blocksUseSvgText(parseXb(entity.payload.content).blocks));
}

export function profileUsesMediaLinks(profile: StaticPageProfile): boolean {
  return profile.references.some((reference) => reference.path === "attrs.attributes.href");
}

function profileImageAssetIds(profile: StaticPageProfile): Set<string> {
  return new Set(profile.entities.filter((entity) => entity.kind === "asset" && typeof entity.payload.mediaType === "string" && /^(?:image\/|application\/pdf$)/u.test(entity.payload.mediaType)).map((entity) => entity.id));
}

function referenceKey(reference: TransferReference): string {
  return `${reference.blockUid}\0${reference.path}\0${reference.targetId}\0${reference.role}\0${reference.index ?? ""}`;
}

function declaredComponentSlots(blocks: XbBlock[]): Set<string> {
  const slots = new Set<string>();
  const visit = (items: XbBlock[]): void => {
    for (const block of items) {
      if (block.name === "xb/slot") slots.add(block.attrs.name);
      if ("children" in block && block.name !== "xb/component") visit(block.children);
    }
  };
  visit(blocks);
  return slots;
}

function assertComponentBindings(profile: StaticPageProfile, owner: TransferEntity, blocks: XbBlock[]): void {
  const definitions = new Map(profile.entities.filter((entity) => ["component", "template-part"].includes(entity.kind)).map((entity) => [
    String(entity.payload.ref),
    { entity, schema: entity.payload.schema as { props: Record<string, unknown> }, blocks: parseXb(String(entity.payload.content)).blocks },
  ]));
  const visit = (items: XbBlock[]): void => {
    for (const block of items) {
      if (block.name === "xb/component") {
        const definition = definitions.get(block.attrs.ref);
        if (!definition) throw new TypeError(`Il componente ${block.attrs.ref} non è definito nel profilo.`);
        const declaredProps = definition.schema.props ?? {};
        for (const prop of Object.keys(block.attrs.props ?? {})) if (!Object.hasOwn(declaredProps, prop)) {
          throw new TypeError(`La prop ${prop} non è definita dal componente ${block.attrs.ref}.`);
        }
        const declaredSlots = declaredComponentSlots(definition.blocks);
        const suppliedSlots = new Set<string>();
        for (const fill of block.children) {
          if (suppliedSlots.has(fill.attrs.name)) throw new TypeError(`Lo slot ${fill.attrs.name} è fornito più volte al componente ${block.attrs.ref}.`);
          suppliedSlots.add(fill.attrs.name);
          if (!declaredSlots.has(fill.attrs.name)) throw new TypeError(`Lo slot ${fill.attrs.name} non è definito dal componente ${block.attrs.ref}.`);
        }
      }
      if ("children" in block) visit(block.children);
    }
  };
  try {
    visit(blocks);
  } catch (error) {
    if (error instanceof Error) throw new TypeError(`${error.message} Proprietario: ${owner.id}.`);
    throw error;
  }
}

function assertProfileDocumentContent(profile: StaticPageProfile): void {
  const componentIdsByRef = new Map(profile.entities.filter((entity) => ["component", "template-part"].includes(entity.kind)).map((entity) => [String(entity.payload.ref), entity.id]));
  const queryPresetKeys = new Set(profile.entities.filter((entity) => entity.kind === "query-preset").map((entity) => String(entity.payload.key)));
  const hasDataSources = profile.entities.some((entity) => entity.kind === "query-source");
  const media: TransferMediaMode = { mode: "import", imageAssetIds: profileImageAssetIds(profile) };
  for (const entity of profile.entities) {
    if (entity.kind !== "document" && !["component", "template-part", "template"].includes(entity.kind)) continue;
    if (typeof entity.payload.content !== "string") throw new TypeError(`Contenuto mancante nel documento ${entity.id}.`);
    const normalized = normalizeContentForTransfer(entity.payload.content, media, entity.id, componentIdsByRef, entity.kind as "document" | "component" | "template-part" | "template", queryPresetKeys, hasDataSources);
    assertComponentBindings(profile, entity, normalized.blocks);
    const declared = profile.references.filter((reference) => reference.ownerId === entity.id);
    const key = referenceKey;
    if (canonicalizeJson(normalized.references.sort((a, b) => key(a).localeCompare(key(b)))) !== canonicalizeJson(declared.sort((a, b) => key(a).localeCompare(key(b))))) {
      throw new TypeError(`I riferimenti del documento ${entity.id} non corrispondono al suo contenuto.`);
    }
  }
}

export async function createStaticPageProfile(project: CmsProject, store: CmsProjectStore, version = HISTOS_PUBLISH_VERSION, remoteSiteId?: string): Promise<{ profile: StaticPageProfile; files: Map<string, Buffer> }> {
  const entities: TransferEntity[] = [];
  const references: TransferReference[] = [];
  const files = new Map<string, Buffer>();
  const components = store.listComponents();
  const componentIdsByRef = new Map(components.map((component) => [component.ref, component.id]));
  const templates = store.listTemplates();
  const hasRoles = templates.some((template) => template.role !== null);
  const hasTemplates = templates.length > 0 || components.some((component) => component.kind === "template-part");
  const contentTypes = store.content.listTypes();
  const taxonomies = store.content.listTaxonomies();
  const queryState = store.content.listQueryPresets();
  const querySources = store.content.listQuerySources();
  const queryPresetKeys = new Set(queryState.presets.map((preset) => preset.key));
  const hasRelationalContent = contentTypes.length + taxonomies.length + queryState.presets.length + Object.keys(querySources).length > 0;
  const hasDataSources = Object.keys(querySources).length > 0;
  const media: TransferMediaMode = { mode: "export", projectId: project.id, imageAssetIds: new Set(store.listAssets().filter((asset) => /^(?:image\/|application\/pdf$)/u.test(asset.mimeType)).map((asset) => asset.id)) };
  // A slug is unique within one language here, and within the whole site in the profile, as WordPress wants it.
  const transferSlug = (document: { slug: string; locale: string | null }): string => document.locale ? `${document.slug}-${document.locale.toLowerCase()}` : document.slug;
  for (const page of store.listPages()) {
    const revision = store.getHead(page.id);
    if (!revision) throw new Error(`Manca la revisione della pagina ${page.id}.`);
    const normalized = normalizeContentForTransfer(revision.content, media, page.id, componentIdsByRef, "document", queryPresetKeys, hasDataSources);
    // Keep the authored status in the portable profile. The Remote v2 endpoint
    // (`/import` or `/publish`) is the explicit operation that decides whether
    // WordPress applies the page as a draft or publishes it.
    const payload = json({ documentType: "page", title: page.title, slug: transferSlug(page), status: page.status, content: normalized.content, script: store.getDocumentScript(page.id), ...(page.templateRef ? { templateRef: page.templateRef } : {}) }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: page.id, kind: "document", schemaVersion: 1, revisionHash: hashEntity({ kind: "document", schemaVersion: 1, payload }), payload };
    const syncBase = remoteSiteId ? store.getSyncBase(remoteSiteId, page.id) : null;
    if (syncBase) entity.baseHash = syncBase.baseHash;
    entities.push(entity);
    references.push(...normalized.references);
  }

  const posts = store.listPosts();
  for (const post of posts) {
    const revision = store.getHead(post.id);
    if (!revision) throw new Error(`Manca la revisione dell'articolo ${post.id}.`);
    const normalized = normalizeContentForTransfer(revision.content, media, post.id, componentIdsByRef, "document", queryPresetKeys, hasDataSources);
    const payload = json({
      documentType: "post", title: post.title, slug: transferSlug(post), status: post.status, content: normalized.content, script: store.getDocumentScript(post.id),
      publishedAt: post.status === "published" ? post.publishedAt : null, excerpt: post.excerpt, terms: Object.fromEntries(Object.entries(store.getPostTermIds(post.id)).map(([taxonomy, ids]) => [taxonomy, [...ids].sort()])),
      ...(post.templateRef ? { templateRef: post.templateRef } : {}),
      // Doc 23 item 119: written only when there is one, so a post without an image keeps its fingerprint.
      ...(post.imageAssetId ? { image: post.imageAssetId } : {}),
    }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: post.id, kind: "document", schemaVersion: 1, revisionHash: hashEntity({ kind: "document", schemaVersion: 1, payload }), payload };
    const syncBase = remoteSiteId ? store.getSyncBase(remoteSiteId, post.id) : null;
    if (syncBase) entity.baseHash = syncBase.baseHash;
    entities.push(entity);
    references.push(...normalized.references);
  }

  for (const component of components) {
    const kind = component.kind === "template-part" ? "template-part" : "component";
    const normalized = normalizeContentForTransfer(component.content, media, component.id, componentIdsByRef, kind, queryPresetKeys, hasDataSources);
    const payload = json({ title: component.title, ref: component.ref, schema: component.schema, content: normalized.content, script: store.getDocumentScript(component.id), status: "published", ...(component.kind === "template-part" ? { area: component.partArea ?? "uncategorized" } : {}) }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: component.id, kind, schemaVersion: 1, revisionHash: hashEntity({ kind, schemaVersion: 1, payload }), payload };
    const syncBase = remoteSiteId ? store.getSyncBase(remoteSiteId, component.id) : null;
    if (syncBase) entity.baseHash = syncBase.baseHash;
    entities.push(entity);
    references.push(...normalized.references);
  }

  for (const template of templates) {
    const normalized = normalizeContentForTransfer(template.content, media, template.id, componentIdsByRef, "template", queryPresetKeys, hasDataSources);
    const payload = json({ title: template.title, ref: template.ref, schema: template.schema, content: normalized.content, script: store.getDocumentScript(template.id), status: "published", ...(template.role ? { role: template.role } : {}) }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: template.id, kind: "template", schemaVersion: 1, revisionHash: hashEntity({ kind: "template", schemaVersion: 1, payload }), payload };
    const syncBase = remoteSiteId ? store.getSyncBase(remoteSiteId, template.id) : null;
    if (syncBase) entity.baseHash = syncBase.baseHash;
    entities.push(entity);
    references.push(...normalized.references);
  }

  const styles = store.getStyles();
  const styleRevision = styles ? store.getHead(styles.id) : null;
  if (!styles || !styleRevision) throw new Error("Il progetto non ha una revisione degli stili.");
  const styleData = stylesData(styleRevision.content);
  const fontSheet = store.getFontSheet();
  assertCssResourcesBundled([
    ...(styleData.globals ?? []).map((sheet, index) => ({ label: sheet.source?.name ?? sheet.id ?? `foglio globale ${index + 1}`, css: sheet.css, ...(sheet.assets ? { assets: sheet.assets } : {}) })),
    ...(styleData.styles ?? []).map((style, index) => ({ label: style.selector || `stile ${index + 1}`, css: style.css, ...(style.assets ? { assets: style.assets } : {}) })),
  ]);
  const stylePayload = json({
    styles: (styleData.styles ?? []).map((entry, index) => ({ id: entry.id ?? `style-${index + 1}`, selector: entry.selector, css: entry.css, ...(entry.assets?.length ? { assets: entry.assets } : {}) })),
    // The site's own variables (`--xb-site-…`) travel as one more global sheet: WordPress prints it as it is, so the
    // selectors that use them keep their values. The site's recipes stay in the project (they only help the editor).
    globals: [
      ...(styleData.globals ?? []).map((entry, index) => ({ id: entry.id ?? `global-${index + 1}`, css: entry.css, ...(entry.source ? { source: entry.source } : {}), ...(entry.assets?.length ? { assets: entry.assets } : {}) })),
      ...(siteTokenDeclarations(styleData.siteTokens ?? {}) ? [{ id: SITE_TOKENS_SHEET_ID, css: `:root{${siteTokenDeclarations(styleData.siteTokens ?? {})}}` }] : []),
      // The project's fonts, as WordPress prints any global sheet: received back, they return to their place.
      ...(fontSheet ? [{ id: FONT_SHEET_ID, css: fontSheet.css, assets: fontSheet.assets }] : []),
    ],
    compiledCss: "",
    design: styleData.design ?? {},
    tokenOverrides: styleData.tokenOverrides ?? {},
    queries: styleData.queries ?? {},
  }) as Record<string, JsonValue>;
  const styleEntity: TransferEntity = { id: styles.id, kind: "styles", schemaVersion: 1, revisionHash: hashEntity({ kind: "styles", schemaVersion: 1, payload: stylePayload }), payload: stylePayload };
  const styleBase = remoteSiteId ? store.getSyncBase(remoteSiteId, styles.id) : null;
  if (styleBase) styleEntity.baseHash = styleBase.baseHash;
  entities.push(styleEntity);

  for (const asset of store.listAssets()) {
    const stored = await store.readAsset(asset.id);
    if (!stored) throw new Error(`Manca il file media ${asset.id}.`);
    const path = `media/${asset.sha256}`;
    if (!files.has(path)) files.set(path, Buffer.from(stored.bytes));
    const payload = json({ sha256: asset.sha256, mediaType: asset.mimeType, bytes: stored.bytes.byteLength, path, alt: asset.alt, title: asset.filename, caption: asset.caption }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: asset.id, kind: "asset", schemaVersion: 1, revisionHash: hashEntity({ kind: "asset", schemaVersion: 1, payload }), payload };
    const syncBase = remoteSiteId ? store.getSyncBase(remoteSiteId, asset.id) : null;
    if (syncBase) entity.baseHash = syncBase.baseHash;
    entities.push(entity);
  }

  for (const contentType of contentTypes) {
    const payload = json({ key: contentType.key, label: contentType.label, fields: contentType.fields, ...(contentType.singleTemplateRef ? { singleTemplateRef: contentType.singleTemplateRef } : {}), ...(contentType.archiveTemplateRef ? { archiveTemplateRef: contentType.archiveTemplateRef } : {}), ...(contentType.public === false ? { public: false } : {}) }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: contentType.id, kind: "content-type", schemaVersion: 1, revisionHash: hashEntity({ kind: "content-type", schemaVersion: 1, payload }), payload };
    const base = remoteSiteId ? store.getSyncBase(remoteSiteId, contentType.id) : null;
    if (base) entity.baseHash = base.baseHash;
    entities.push(entity);
  }
  for (const taxonomy of taxonomies) {
    const payload = json({ key: taxonomy.key, label: taxonomy.label, types: taxonomy.types }) as Record<string, JsonValue>;
    const entity: TransferEntity = { id: taxonomy.id, kind: "taxonomy", schemaVersion: 1, revisionHash: hashEntity({ kind: "taxonomy", schemaVersion: 1, payload }), payload };
    const base = remoteSiteId ? store.getSyncBase(remoteSiteId, taxonomy.id) : null;
    if (base) entity.baseHash = base.baseHash;
    entities.push(entity);
    for (const term of store.content.listTerms(taxonomy.key)) {
      const termPayload = json({ taxonomyKey: term.taxonomyKey, slug: term.slug, label: term.label, parentId: term.parentId }) as Record<string, JsonValue>;
      const termEntity: TransferEntity = { id: term.id, kind: "term", schemaVersion: 1, revisionHash: hashEntity({ kind: "term", schemaVersion: 1, payload: termPayload }), payload: termPayload };
      const termBase = remoteSiteId ? store.getSyncBase(remoteSiteId, term.id) : null;
      if (termBase) termEntity.baseHash = termBase.baseHash;
      entities.push(termEntity);
    }
  }
  for (const contentType of contentTypes) {
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = store.content.listRecords({ typeKey: contentType.key, status: "any", includePrivate: true, limit, offset });
      for (const record of page.items) {
        const values = Object.fromEntries(contentType.fields.flatMap((field) => {
          if (!Object.hasOwn(record.values, field.key)) return [];
          const value = record.values[field.key];
          if (field.type !== "relation") return [[field.key, value]];
          const relationId = (item: unknown): unknown => item && typeof item === "object" && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : item;
          return [[field.key, field.multiple && Array.isArray(value) ? value.map(relationId) : relationId(value)]];
        }));
        const payload = json({
          typeKey: record.typeKey, slug: record.slug, locale: record.locale, title: record.title, status: record.status,
          publishedAt: record.publishedAt, excerpt: record.excerpt, order: record.order, values,
          terms: Object.fromEntries(Object.entries(record.terms).map(([taxonomyKey, assigned]) => [taxonomyKey, assigned.map((term) => term.id)])),
        }) as Record<string, JsonValue>;
        const entity: TransferEntity = { id: record.id, kind: "content-record", schemaVersion: 1, revisionHash: hashEntity({ kind: "content-record", schemaVersion: 1, payload }), payload };
        const base = remoteSiteId ? store.getSyncBase(remoteSiteId, record.id) : null;
        if (base) entity.baseHash = base.baseHash;
        entities.push(entity);
      }
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
  }
  for (const preset of queryState.presets) {
    const payload = json({ key: preset.key, label: preset.label, typeKey: preset.typeKey, limit: preset.limit, ...(preset.limitParam ? { limitParam: preset.limitParam } : {}), offset: preset.offset, ...(preset.offsetParam ? { offsetParam: preset.offsetParam } : {}), orderBy: preset.orderBy, order: preset.order, ...(preset.filter ? { filter: preset.filter } : {}) }) as Record<string, JsonValue>;
    const id = stableEntityId(project.id, "query-preset", preset.key);
    const entity: TransferEntity = { id, kind: "query-preset", schemaVersion: 1, revisionHash: hashEntity({ kind: "query-preset", schemaVersion: 1, payload }), payload };
    const base = remoteSiteId ? store.getSyncBase(remoteSiteId, id) : null;
    if (base) entity.baseHash = base.baseHash;
    entities.push(entity);
  }
  for (const [name, source] of Object.entries(querySources)) {
    const payload = json({ name, data: source.data }) as Record<string, JsonValue>;
    const id = stableEntityId(project.id, "query-source", name);
    const entity: TransferEntity = { id, kind: "query-source", schemaVersion: 1, revisionHash: hashEntity({ kind: "query-source", schemaVersion: 1, payload }), payload };
    const base = remoteSiteId ? store.getSyncBase(remoteSiteId, id) : null;
    if (base) entity.baseHash = base.baseHash;
    entities.push(entity);
  }

  for (const storedTombstone of store.listTransferTombstones("remote")) {
    const base = remoteSiteId ? store.getSyncBase(remoteSiteId, storedTombstone.id) : null;
    entities.push(base ? { ...storedTombstone, baseHash: base.baseHash } : storedTombstone);
  }

  entities.sort((left, right) => left.id.localeCompare(right.id));
  references.sort((left, right) => `${left.ownerId}\0${left.blockUid}\0${left.path}\0${left.targetId}\0${left.index ?? ""}`.localeCompare(`${right.ownerId}\0${right.blockUid}\0${right.path}\0${right.targetId}\0${right.index ?? ""}`));
  const entityBytes = ndjson(entities);
  const referenceBytes = ndjson(references);
  files.set("entities.ndjson", entityBytes);
  files.set("references.ndjson", referenceBytes);
  const manifestBase: Omit<TransferManifest, "manifestHash"> = {
    format: "xb-site", version: 2,
    generator: { name: "Histos CMS", version, engineCommit: ENGINE_COMMIT },
    project: { id: project.id, name: project.name, defaultLocale: store.getRenderSettings().locale },
    selection: { kind: "workspace-head", snapshot: randomUUID() },
    requiredCapabilities: ["documents:page:v1", "styles:global:v1", "media:asset:v1", ...(components.length ? ["components:definition:v1"] : []), ...(hasTemplates ? ["templates:definition:v1"] : []), ...(contentTypes.length ? ["content:types:v1"] : []), ...(entities.some((entity) => entity.kind === "content-record") ? ["content:records:v1"] : []), ...(taxonomies.length ? ["content:taxonomies:v1"] : []), ...(queryState.presets.length || hasDataSources ? ["content:queries:v1"] : []), ...(posts.length ? ["documents:post:v1"] : []), ...(hasRoles ? ["templates:roles:v1"] : []), ...(transferUsesProducts(entities) ? [PRODUCT_CAPABILITY] : []), ...(transferUsesScripts(entities) ? [SCRIPT_CAPABILITY] : [])],
    profile: posts.length || hasRoles ? "histos-static-project-v4" : hasRelationalContent ? "histos-static-project-v3" : hasTemplates ? "histos-static-project-v2" : components.length ? "histos-static-project-v1" : "histos-static-page-v1",
    files: [...files.entries()].map(([path, bytes]) => transferFile(path, bytes, path.endsWith(".ndjson") ? "application/x-ndjson" : "application/octet-stream")).sort((a, b) => a.path.localeCompare(b.path)),
  };
  const manifest = { ...manifestBase, manifestHash: sha256(Buffer.from(manifestHashInput(manifestBase), "utf8")) } satisfies TransferManifest;
  const profile: StaticPageProfile = { manifest, entities, references };
  validateStaticPageProfile(profile);
  return { profile, files };
}

/**
 * WordPress Remote `/import` always stores incoming published pages and records as drafts.
 * Build the exact profile for that operation without changing the authored local project.
 */
export function createDraftImportProfile(
  profile: StaticPageProfile,
  files: Map<string, Buffer>,
): { profile: StaticPageProfile; files: Map<string, Buffer> } {
  validateStaticPageProfile(profile);
  const declaredFiles = new Map(profile.manifest.files.map((file) => [file.path, file]));
  const suppliedManifest = files.get("site.json");
  if (suppliedManifest && !suppliedManifest.equals(Buffer.from(canonicalizeJson(profile.manifest), "utf8"))) {
    throw new TypeError("site.json non corrisponde al profilo trasferito.");
  }
  const profileFiles = new Map([...files].filter(([filePath]) => filePath !== "site.json"));
  if (declaredFiles.size !== profileFiles.size) throw new TypeError("I file trasferiti non corrispondono al manifest.");
  for (const [filePath, file] of declaredFiles) {
    const bytes = profileFiles.get(filePath);
    if (!bytes || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new TypeError(`Integrità non valida per ${filePath}.`);
    }
  }

  let changed = false;
  const entities = profile.entities.map((entity): TransferEntity => {
    const status = entity.payload.status;
    if (entity.kind === "document" && status === "published") {
      changed = true;
      const payload = { ...entity.payload, status: "draft" as const, ...(entity.payload.documentType === "post" ? { publishedAt: null } : {}) };
      return { ...entity, payload, revisionHash: hashEntity({ kind: entity.kind, schemaVersion: entity.schemaVersion, payload }) };
    }
    if (entity.kind === "content-record" && status === "published") {
      changed = true;
      const payload = { ...entity.payload, status: "draft" as const, publishedAt: null };
      return { ...entity, payload, revisionHash: hashEntity({ kind: entity.kind, schemaVersion: entity.schemaVersion, payload }) };
    }
    if (["component", "template-part", "template"].includes(entity.kind) && status === "published") {
      changed = true;
      const payload = { ...entity.payload, status: "draft" as const };
      return { ...entity, payload, revisionHash: hashEntity({ kind: entity.kind, schemaVersion: entity.schemaVersion, payload }) };
    }
    return entity;
  });
  if (!changed) return { profile, files: profileFiles };

  const nextFiles = new Map(profileFiles);
  const entityBytes = ndjson(entities);
  nextFiles.set("entities.ndjson", entityBytes);
  const manifestBase: Omit<TransferManifest, "manifestHash"> = {
    ...profile.manifest,
    files: profile.manifest.files.map((file) => file.path === "entities.ndjson"
      ? { ...file, bytes: entityBytes.byteLength, sha256: sha256(entityBytes) }
      : file),
  };
  const manifest: TransferManifest = {
    ...manifestBase,
    manifestHash: sha256(Buffer.from(manifestHashInput(manifestBase), "utf8")),
  };
  const projected = { ...profile, manifest, entities };
  validateStaticPageProfile(projected);
  return { profile: projected, files: nextFiles };
}

/** With `baseSiteId`, every entity carries the common base recorded for that site (or for the file it came from). */
export async function encodeStaticPageArchive(project: CmsProject, store: CmsProjectStore, version?: string, baseSiteId?: string): Promise<Buffer> {
  const { profile, files } = await createStaticPageProfile(project, store, version, baseSiteId);
  return encodeStaticPageProfileArchive(profile, files);
}

/**
 * What an archive is checked for before it is written, here and in the browser bundle of doc 18 F6 (which zips with
 * fflate): the profile valid, its documents' content in the transfer rules, every file the one the manifest declares.
 */
export function checkProfileForArchive(profile: StaticPageProfile, files: ReadonlyMap<string, Uint8Array>): void {
  validateStaticPageProfile(profile);
  assertProfileDocumentContent(profile);
  const declared = new Map(profile.manifest.files.map((file) => [file.path, file]));
  if (declared.size !== files.size) throw new TypeError("I file trasferiti non corrispondono al manifest.");
  for (const [name, info] of declared) {
    const bytes = files.get(name);
    if (!bytes || bytes.byteLength !== info.bytes || sha256(bytes) !== info.sha256) throw new TypeError(`Integrità non valida per ${name}.`);
  }
}

/** Encode an already validated profile. Used by shared fixture tests and Remote v2 clients. */
export async function encodeStaticPageProfileArchive(profile: StaticPageProfile, files: Map<string, Buffer>): Promise<Buffer> {
  checkProfileForArchive(profile, files);
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(canonicalizeJson(profile.manifest), "utf8"), "site.json", { mode: 0o100600, mtime: new Date(0) });
  for (const [name, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) zip.addBuffer(bytes, name, { mode: 0o100600, mtime: new Date(0) });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => {
      const archive = Buffer.concat(chunks);
      if (archive.byteLength > MAX_ARCHIVE_BYTES) reject(new RangeError("L’archivio supera il limite di 512 MiB."));
      else resolve(archive);
    });
    zip.end();
  });
}

/** A file that is not a readable ZIP. What the ZIP library says (in English) stays as the cause (E13). */
export class UnreadableArchiveError extends TypeError {
  constructor(cause: unknown) {
    super("Il file non è un archivio ZIP leggibile: forse è incompleto o danneggiato.", { cause });
    this.name = "UnreadableArchiveError";
  }
}

/** The ZIP library's refusal as the user reads it: a forbidden path (strictFileNames), or an unreadable file. */
export function unreadableArchive(cause: unknown): TypeError {
  if (cause instanceof Error && /relative path|absolute path|invalid characters in fileName/iu.test(cause.message)) return new TypeError("Percorso ZIP non consentito.", { cause });
  return new UnreadableArchiveError(cause);
}

function readArchiveEntries(archive: Buffer): Promise<Map<string, Buffer>> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new RangeError("L’archivio supera il limite di 512 MiB.");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError || !zip) { reject(unreadableArchive(openError)); return; }
      const entries = new Map<string, Buffer>();
      const names = new Set<string>();
      let total = 0;
      let failed = false;
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(error);
      };
      zip.on("error", (error: Error) => fail(unreadableArchive(error)));
      zip.on("end", () => { if (!failed) resolve(entries); });
      zip.on("entry", (entry: ZipEntry) => {
        const name = entry.fileName;
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        const compressed = entry.compressedSize;
        if (entries.size >= MAX_ARCHIVE_ENTRIES || mode === 0o120000 || name.endsWith("/") || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === "" || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+$/u.test(name)) {
          fail(new TypeError(`Percorso ZIP non consentito: ${name.slice(0, 100)}`)); return;
        }
        const key = name.toLocaleLowerCase("en-US");
        if (names.has(key)) { fail(new TypeError(`Voce ZIP duplicata: ${name}`)); return; }
        names.add(key);
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_ARCHIVE_BYTES || total + entry.uncompressedSize > MAX_ARCHIVE_BYTES || (entry.uncompressedSize > 1024 * 1024 && (compressed === 0 || entry.uncompressedSize / compressed > 1000))) {
          fail(new RangeError(`Dimensione o rapporto di compressione non consentito: ${name}`)); return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(unreadableArchive(streamError)); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > entry.uncompressedSize || total + size > MAX_ARCHIVE_BYTES) { stream.destroy(new RangeError("Voce ZIP oltre il limite dichiarato.")); return; }
            chunks.push(chunk);
          });
          stream.once("error", (error: Error) => fail(error instanceof RangeError ? error : unreadableArchive(error)));
          stream.once("end", () => {
            if (size !== entry.uncompressedSize) { fail(new TypeError(`Dimensione ZIP non coerente: ${name}`)); return; }
            total += size;
            entries.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function readNdjson(bytes: Buffer, path: string): JsonValue[] {
  if (!bytes.byteLength) return [];
  if (!bytes.byteLength || bytes[bytes.byteLength - 1] !== 0x0a) throw new TypeError(`${path} deve terminare con LF.`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line === "" || line.endsWith("\r"))) throw new TypeError(`${path} contiene righe vuote o CRLF.`);
  return lines.map((line) => {
    const value = parseJsonStrict(line);
    if (canonicalizeJson(value) !== line) throw new TypeError(`${path} contiene JSON non canonico.`);
    return value;
  });
}

/** One content of an archive that this Publish cannot read, named (doc 23 item 197). */
export interface ArchiveEntityProblem { id: string; kind: string; title: string; reason: string }
export interface ArchiveInspection {
  /** Contents read. */
  entities: number;
  /** Each content that does not pass Publish's checks, all of them, with the first reason of each. */
  problems: ArchiveEntityProblem[];
  /** What the site itself left out of its reading (`manifest.leftOut`), when the manifest says it. */
  leftOut: Array<{ kind: string; title: string; reason: string; blocks: boolean }>;
  /** Why the archive as a whole is unreadable, when no single content explains it; null when it reads. */
  whole: string | null;
}

const MAX_INSPECTION_PROBLEMS = 500;
const problemText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, 400);
const inspectedTitle = (entity: Record<string, unknown>): string => {
  const payload = entity.payload && typeof entity.payload === "object" && !Array.isArray(entity.payload) ? entity.payload as Record<string, unknown> : {};
  for (const key of ["title", "label", "name", "slug", "key", "ref"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return typeof entity.id === "string" ? entity.id.slice(0, 36) : "";
};

/**
 * Doc 23 item 197: an archive of a site read content by content, so that one content Publish cannot read does not hide
 * the others: each is checked as decodeStaticPageArchive() would (schema, revision, the template's page-content block,
 * markup and expressions), and every failure is listed with its content's name. Then the whole archive is decoded:
 * a failure no single content explains (references, capabilities) is `whole`. Reads only; nothing here is trusted.
 */
export async function inspectStaticPageArchive(archive: Buffer): Promise<ArchiveInspection> {
  const entries = await readArchiveEntries(archive);
  const result: ArchiveInspection = { entities: 0, problems: [], leftOut: [], whole: null };
  const manifestBytes = entries.get("site.json");
  let manifest: Record<string, unknown> = {};
  try {
    const value = manifestBytes && manifestBytes.byteLength <= MAX_TRANSFER_MANIFEST_BYTES ? parseJsonStrict(manifestBytes) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) manifest = value as Record<string, unknown>;
  } catch { /* said below, by the whole decoding */ }
  if (Array.isArray(manifest.leftOut)) {
    for (const item of manifest.leftOut.slice(0, MAX_INSPECTION_PROBLEMS)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const { kind, title, reason, blocks } = item as Record<string, unknown>;
      // `blocks`: a check reading (Histeon 0.5.7) names a content the project knows, at which a send would stop.
      if (typeof kind === "string" && typeof title === "string" && typeof reason === "string") result.leftOut.push({ kind: kind.slice(0, 40), title: title.slice(0, 160), reason: reason.slice(0, 400), blocks: blocks === true });
    }
  }
  let entities: Array<Record<string, unknown>> = [];
  try {
    entities = readNdjson(entries.get("entities.ndjson") ?? Buffer.alloc(0), "entities.ndjson").filter((value): value is Record<string, JsonValue> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  } catch (error) {
    result.whole = problemText(error);
    return result;
  }
  result.entities = entities.length;
  const componentIdsByRef = new Map(entities.filter((entity) => entity.kind === "component" || entity.kind === "template-part").map((entity) => [String((entity.payload as Record<string, unknown> | undefined)?.ref), String(entity.id)]));
  const queryPresetKeys = new Set(entities.filter((entity) => entity.kind === "query-preset").map((entity) => String((entity.payload as Record<string, unknown> | undefined)?.key)));
  const hasDataSources = entities.some((entity) => entity.kind === "query-source");
  const imageAssetIds = new Set(entities.filter((entity) => entity.kind === "asset" && /^(?:image\/|application\/pdf$)/u.test(String((entity.payload as Record<string, unknown> | undefined)?.mediaType))).map((entity) => String(entity.id)));
  for (const raw of entities) {
    if (result.problems.length >= MAX_INSPECTION_PROBLEMS) break;
    try {
      validateTransferEntity(raw);
      const entity = raw as unknown as TransferEntity;
      if (entity.revisionHash !== hashEntity(entity)) throw new TypeError("La revisione non corrisponde al contenuto.");
      if (entity.kind === "template" && !/<!--\s*wp:xb\/slot\s+\{[^}]*"name"\s*:\s*"default"[^}]*\}\s*\/-->/u.test(String(entity.payload.content))) {
        throw new TypeError("manca lo slot predefinito richiesto per una pagina");
      }
      if (["document", "component", "template-part", "template"].includes(entity.kind)) {
        if (typeof entity.payload.content !== "string") throw new TypeError("Contenuto mancante.");
        normalizeContentForTransfer(entity.payload.content, { mode: "import", imageAssetIds }, entity.id, componentIdsByRef, entity.kind as "document" | "component" | "template-part" | "template", queryPresetKeys, hasDataSources);
      }
    } catch (error) {
      result.problems.push({ id: typeof raw.id === "string" ? raw.id.slice(0, 36) : "", kind: typeof raw.kind === "string" ? raw.kind.slice(0, 40) : "", title: inspectedTitle(raw), reason: problemText(error) });
    }
  }
  if (result.problems.length === 0) {
    try { await decodeStaticPageArchive(archive); } catch (error) { result.whole = problemText(error); }
  }
  return result;
}

export async function decodeStaticPageArchive(archive: Buffer): Promise<{ profile: StaticPageProfile; files: Map<string, Buffer> }> {
  const entries = await readArchiveEntries(archive);
  const manifestBytes = entries.get("site.json");
  if (!manifestBytes) throw new TypeError("Manca site.json nell’archivio.");
  if (manifestBytes.byteLength > MAX_TRANSFER_MANIFEST_BYTES) throw new RangeError("Il manifest site.json supera 8 MiB.");
  const manifestValue = parseJsonStrict(manifestBytes);
  validateTransferManifest(manifestValue);
  const manifest = manifestValue as unknown as TransferManifest;
  const { manifestHash, ...manifestBase } = manifest;
  if (sha256(Buffer.from(manifestHashInput(manifestBase), "utf8")) !== manifestHash) throw new TypeError("Hash del manifest non valido.");
  const declared = new Map(manifest.files.map((file) => [file.path, file]));
  if (entries.size !== declared.size + 1) throw new TypeError("L’archivio contiene file mancanti o non dichiarati.");
  for (const [name, info] of declared) {
    const bytes = entries.get(name);
    if (!bytes || bytes.byteLength !== info.bytes || sha256(bytes) !== info.sha256) throw new TypeError(`Integrità non valida per ${name}.`);
  }
  const entities = readNdjson(entries.get("entities.ndjson") ?? Buffer.alloc(0), "entities.ndjson") as unknown as TransferEntity[];
  const references = readNdjson(entries.get("references.ndjson") ?? Buffer.alloc(0), "references.ndjson") as unknown as TransferReference[];
  const profile: StaticPageProfile = { manifest, entities, references };
  validateStaticPageProfile(profile);
  assertProfileDocumentContent(profile);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  for (const entity of entities) {
    if (entity.revisionHash !== hashEntity(entity)) throw new TypeError(`Hash di revisione non valido per ${entity.id}.`);
    if (entity.kind === "asset") {
      const path = String(entity.payload.path);
      const bytes = entries.get(path);
      if (!bytes || bytes.byteLength !== entity.payload.bytes || sha256(bytes) !== entity.payload.sha256) throw new TypeError(`Blob asset non coerente per ${entity.id}.`);
    }
  }
  for (const reference of references) {
    const owner = entityById.get(reference.ownerId);
    const target = entityById.get(reference.targetId);
    if (!owner || !["document", "component", "template-part", "template"].includes(owner.kind) || !target) throw new TypeError(`Riferimento non supportato: ${reference.ownerId}/${reference.blockUid}.`);
    const content = owner.payload.content;
    if (typeof content !== "string") throw new TypeError(`Contenuto documento mancante: ${reference.ownerId}.`);
    const parsed = parseXb(content);
    let matched = false;
    const find = (block: (typeof parsed.blocks)[number]): void => {
      if (reference.role === "media" && target.kind === "asset" && reference.path === "attrs.attributes.src" && reference.index === undefined && block.name === "xb/element" && block.attrs.uid === reference.blockUid && block.attrs.attributes?.src === `histos-media://${reference.targetId}`) matched = true;
      if (reference.role === "media" && target.kind === "asset" && reference.path === "attrs.attributes.href" && reference.index === undefined && block.name === "xb/element" && block.attrs.tag === "a" && block.attrs.uid === reference.blockUid && block.attrs.attributes?.href === `histos-media://${reference.targetId}`) matched = true;
      if (reference.role === "media" && target.kind === "asset" && reference.path.startsWith("attrs.props.") && block.name === "xb/component" && block.attrs.uid === reference.blockUid && block.attrs.props?.[reference.path.slice(12)] === `histos-media://${reference.targetId}`) matched = true;
      if (reference.role === "media" && target.kind === "asset" && reference.path === "attrs.attributes.srcset" && reference.index !== undefined && block.name === "xb/element" && block.attrs.uid === reference.blockUid) {
        const srcset = block.attrs.attributes?.srcset;
        const candidate = typeof srcset === "string" ? parseTransferSrcset(srcset)?.[reference.index] : undefined;
        if (candidate?.url === `histos-media://${reference.targetId}`) matched = true;
      }
      if (reference.role === "document" && ["component", "template-part"].includes(target.kind) && reference.path === "attrs.ref" && block.name === "xb/component" && block.attrs.uid === reference.blockUid && block.attrs.ref === target.payload.ref) matched = true;
      if ("children" in block) for (const child of block.children) find(child);
    };
    for (const block of parsed.blocks) find(block);
    if (!matched) throw new TypeError(`Riferimento non corrispondente al documento ${reference.ownerId}.`);
  }
  return { profile, files: entries };
}
