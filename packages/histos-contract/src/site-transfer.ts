import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Ajv, type ErrorObject } from "ajv";
import manifestSchema from "@xb/spec/site-transfer-v2.schema.json" with { type: "json" };
import entitySchema from "@xb/spec/site-entity-v2.schema.json" with { type: "json" };
import referenceSchema from "@xb/spec/site-reference-v2.schema.json" with { type: "json" };
import profileSchema from "@xb/spec/histos-static-page-v1.schema.json" with { type: "json" };
import { canonicalizeJson, type JsonValue } from "./canonical-json.js";
import { cssResourceReferences } from "./css-resources.js";
import { validateCoreFrameworkPresetData } from "./core-preset.js";
import { validateExternalFrameworkConfiguration } from "./framework-config.js";
import { isProductFields, PRODUCT_CAPABILITY, PRODUCT_TAXONOMIES, PRODUCT_TYPE_KEY, productSku, productValueIssues, transferUsesProducts } from "./commerce.js";

export type TransferSelection = { kind: "workspace-head" | "release"; snapshot: string };
/** A content of the site that stayed out of a reading of it because it cannot travel. */
export interface TransferLeftOut {
  kind: "page" | "post" | "component" | "template-part" | "template" | "query";
  title: string;
  reason: string;
  /** A check reading (Histeon 0.5.7): a content the project knows, where a send or a download would stop. */
  blocks?: true;
}

export interface TransferManifest {
  format: "xb-site";
  version: 2;
  generator: { name: "Histos CMS"; version: string; engineCommit: string };
  project: { id: string; name: string; baseUrl?: string; defaultLocale?: string };
  selection: TransferSelection;
  requiredCapabilities: string[];
  profile: "histos-static-page-v1" | "histos-static-project-v1" | "histos-static-project-v2" | "histos-static-project-v3" | "histos-static-project-v4";
  files: Array<{ path: string; bytes: number; sha256: string; mediaType?: string }>;
  leftOut?: TransferLeftOut[];
  manifestHash: string;
}

export interface TransferEntity {
  id: string;
  kind: TransferEntityKind;
  schemaVersion: 1;
  revisionHash: string;
  baseHash?: string;
  payload: Record<string, JsonValue>;
}

export type TransferEntityKind = TransferLiveEntityKind | "tombstone";
export type TransferLiveEntityKind = "document" | "component" | "template-part" | "template" | "styles" | "asset" | "content-type" | "content-record" | "taxonomy" | "term" | "query-preset" | "query-source";

export interface TransferReference {
  ownerId: string;
  blockUid: string;
  path: string;
  targetId: string;
  role: "media" | "document";
  index?: number;
}

export interface StaticPageProfile {
  manifest: TransferManifest;
  entities: TransferEntity[];
  references: TransferReference[];
}

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
ajv.addSchema(manifestSchema);
ajv.addSchema(entitySchema);
ajv.addSchema(referenceSchema);
const validateManifest = ajv.compile(manifestSchema);
const validateEntity = ajv.compile(entitySchema);
const validateReference = ajv.compile(referenceSchema);
const validateProfile = ajv.compile(profileSchema);
const COMPONENT_REF = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]*)*)?$/u;
/** Template roles (docs/spec/cms-bridge.md §12): the WordPress template slug of the same name. */
export const TEMPLATE_ROLES = ["front-page", "home", "index", "single", "page", "archive", "category", "tag", "search", "404"] as const;
export type TemplateRole = typeof TEMPLATE_ROLES[number];
/** The taxonomies native to WordPress posts, always attached to posts only. */
export const POST_TAXONOMIES = ["category", "post_tag"] as const;
const POST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const POST_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

/** A post's publication date: whole seconds in UTC, and a date that exists. */
export function isPostPublishedAt(value: unknown): value is string {
  if (typeof value !== "string" || !POST_DATE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.slice(0, -1) + ".000Z";
}

export class ContractValidationError extends Error {
  constructor(readonly code: string, readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "ContractValidationError";
  }
}

/** One validator per branch of the entity schema's oneOf (page, post, component, styles…), to say what an entity lacks. */
const entityBranches = (entitySchema.oneOf as Array<{ $ref: string }>).map((branch) => {
  const validate = ajv.getSchema(`${entitySchema.$id}${branch.$ref}`);
  if (!validate) throw new Error(`Schema delle entità: ramo ${branch.$ref} non trovato.`);
  return validate;
});

/**
 * An entity's problems as the branch of its own kind sees them. Ajv reports a oneOf with every branch's errors, so a styles
 * entity with one extra key read as "kind must be equal to constant" a dozen times, the useful line far down the list. A
 * branch that refuses the entity's kind (or, for documents, its documentType) is not its branch: its errors are dropped.
 * When no branch is left (an unknown kind) the errors stay as Ajv gave them.
 */
function entityErrors(value: unknown, errors: ErrorObject[] | null | undefined): ErrorObject[] {
  const own: ErrorObject[] = [];
  let matched = false;
  for (const validate of entityBranches) {
    if (validate(value)) return [...(errors ?? [])];
    const branch = validate.errors ?? [];
    if (branch.some((error) => (error.instancePath === "/kind" || error.instancePath === "/payload/documentType") && (error.keyword === "const" || error.keyword === "enum"))) continue;
    matched = true;
    own.push(...branch);
  }
  return matched ? own : [...(errors ?? [])];
}

/** The profile's problems, each entity's narrowed to its own branch (entityErrors) and placed under /entities/N. */
function profileErrors(value: unknown, errors: ErrorObject[] | null | undefined): ErrorObject[] {
  const entities = value && typeof value === "object" && Array.isArray((value as { entities?: unknown }).entities) ? (value as { entities: unknown[] }).entities : [];
  const byEntity = new Map<number, ErrorObject[]>();
  const rest: ErrorObject[] = [];
  for (const error of errors ?? []) {
    const match = /^\/entities\/(\d+)(\/.*)?$/u.exec(error.instancePath);
    const index = match ? Number(match[1]) : -1;
    if (!match || index >= entities.length) { rest.push(error); continue; }
    byEntity.set(index, [...(byEntity.get(index) ?? []), { ...error, instancePath: match[2] ?? "" }]);
  }
  const out = [...rest];
  for (const [index, own] of byEntity) {
    for (const error of entityErrors(entities[index], own)) out.push({ ...error, instancePath: `/entities/${index}${error.instancePath}` });
  }
  return out;
}

function errorsOf(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    // The key an object does not take is the useful word: Ajv leaves it in params only.
    const extra = error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string" ? ` («${error.params.additionalProperty}»)` : "";
    const name = error.keyword === "propertyNames" && typeof error.params.propertyName === "string" ? ` («${error.params.propertyName}»)` : "";
    return `${error.instancePath || "/"}: ${error.message ?? "payload non valido"}${extra}${name} (${error.schemaPath})`;
  });
}

export function validateTransferManifest(value: unknown): asserts value is TransferManifest {
  if (!validateManifest(value)) throw new ContractValidationError("unsupported-format", errorsOf(validateManifest.errors));
  const manifest = value as unknown as TransferManifest;
  if (manifest.project.defaultLocale !== undefined) {
    try {
      if (Intl.getCanonicalLocales(manifest.project.defaultLocale)[0] !== manifest.project.defaultLocale) throw new Error("locale non canonico");
    } catch { throw new ContractValidationError("payload-invalid", ["/project/defaultLocale: lingua predefinita non canonica"]); }
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (paths.has(file.path)) throw new ContractValidationError("payload-invalid", [`/${file.path}: percorso duplicato nel manifest`]);
    paths.add(file.path);
  }
  if (!paths.has("entities.ndjson") || !paths.has("references.ndjson")) {
    throw new ContractValidationError("payload-invalid", ["/files: entities.ndjson e references.ndjson sono obbligatori"]);
  }
}

export function validateTransferEntity(value: unknown): asserts value is TransferEntity {
  if (!validateEntity(value)) throw new ContractValidationError("payload-invalid", errorsOf(entityErrors(value, validateEntity.errors)));
  const entity = value as TransferEntity;
  if (entity.kind !== "styles") return;
  const globals = entity.payload.globals as Array<Record<string, JsonValue>>;
  for (const global of globals) {
    if (!global.source || typeof global.source !== "object" || Array.isArray(global.source)) continue;
    const source = global.source as Record<string, JsonValue>;
    const sourceUrl = source.sourceUrl;
    if (sourceUrl === undefined) continue;
    if (typeof sourceUrl !== "string" || sourceUrl.length > 2048 || !/^[\x21-\x7e]+$/u.test(sourceUrl)) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/globals: URL di provenienza CSS non valida`]);
    }
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/globals: URL di provenienza CSS non valida`]);
    }
    const authority = sourceUrl.slice(sourceUrl.indexOf("://") + 3).split(/[/?#]/u, 1)[0] ?? "";
    const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
    const domain = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    const validDomain = domain.length <= 253 && domain.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label));
    if (!/^https?:\/\//u.test(sourceUrl) || !authority || !parsed.hostname || parsed.username || parsed.password || authority.includes("@") || authority.includes("%") || sourceUrl.includes("\\") || (isIP(hostname) === 0 && !validDomain)) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/globals: URL di provenienza CSS non valida`]);
    }
  }
}

function validateTombstoneSnapshot(entity: TransferEntity): void {
  if (entity.kind !== "tombstone") return;
  const payload = entity.payload;
  if (typeof payload.entityKind !== "string" || payload.entityKind === "tombstone" ||
      typeof payload.deletedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(payload.deletedAt) || !Number.isFinite(Date.parse(payload.deletedAt)) || new Date(payload.deletedAt).toISOString() !== payload.deletedAt ||
      typeof payload.previousRevisionHash !== "string" || !/^[0-9a-f]{64}$/u.test(payload.previousRevisionHash) ||
      typeof payload.label !== "string" || !payload.label.trim() ||
      !payload.previousPayload || typeof payload.previousPayload !== "object" || Array.isArray(payload.previousPayload)) {
    throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: tombstone non valida`]);
  }
  const snapshot: TransferEntity = {
    id: entity.id,
    kind: payload.entityKind as TransferLiveEntityKind,
    schemaVersion: 1,
    revisionHash: payload.previousRevisionHash,
    payload: payload.previousPayload as Record<string, JsonValue>,
  };
  validateTransferEntity(snapshot);
  const actualHash = createHash("sha256")
    .update(canonicalRevisionPayload(snapshot.kind, snapshot.schemaVersion, snapshot.payload), "utf8")
    .digest("hex");
  if (actualHash !== payload.previousRevisionHash) {
    throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/previousRevisionHash: non corrisponde allo snapshot precedente`]);
  }
}

export function validateTransferReference(value: unknown): asserts value is TransferReference {
  if (!validateReference(value)) throw new ContractValidationError("payload-invalid", errorsOf(validateReference.errors));
}

function validateComponentPayload(entity: TransferEntity): void {
  const payload = entity.payload;
  if (entity.kind === "template-part") {
    if (!new Set(["header", "footer", "uncategorized"]).has(String(payload.area))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/area: area della parte template non valida`]);
  } else if (payload.area !== undefined) {
    throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/area: area ammessa soltanto per le parti di template`]);
  }
  if (payload.role !== undefined && (entity.kind !== "template" || !(TEMPLATE_ROLES as readonly string[]).includes(String(payload.role)))) {
    throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/role: ruolo ammesso soltanto per i template, fra quelli previsti`]);
  }
  const schema = payload.schema;
  if (typeof payload.ref !== "string" || !COMPONENT_REF.test(payload.ref) || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: schema o riferimento componente non valido`]);
  }
  const schemaRecord = schema as Record<string, JsonValue>;
  if (Object.keys(schemaRecord).length !== 1 || !schemaRecord.props || typeof schemaRecord.props !== "object" || Array.isArray(schemaRecord.props)) {
    throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema: è atteso un oggetto props`]);
  }
  const props = schemaRecord.props as Record<string, JsonValue>;
  if (Object.keys(props).length > 64) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props: massimo 64 proprietà`]);
  for (const [name, raw] of Object.entries(props)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) || ["__proto__", "prototype", "constructor"].includes(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props/${name}: definizione non valida`]);
    }
    const definition = raw as Record<string, JsonValue>;
    const allowedTypes = new Set(["string", "number", "boolean", "url", "image", "rich-text", "enum", "array", "object"]);
    if (Object.keys(definition).some((key) => !["type", "default", "label", "options"].includes(key)) || typeof definition.type !== "string" || !allowedTypes.has(definition.type)) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props/${name}: tipo o campi non supportati`]);
    }
    if (definition.label !== undefined && (typeof definition.label !== "string" || definition.label.length > 120)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props/${name}/label: non valida`]);
    if (definition.options !== undefined && (!Array.isArray(definition.options) || definition.options.length > 100 || definition.options.some((option) => typeof option !== "string" || option.length > 200))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props/${name}/options: non valide`]);
    if (definition.default !== undefined) {
      const valid = definition.default === null || (definition.type === "number" ? typeof definition.default === "number" && Number.isFinite(definition.default)
        : definition.type === "boolean" ? typeof definition.default === "boolean"
        : definition.type === "array" ? Array.isArray(definition.default)
        : definition.type === "object" ? typeof definition.default === "object" && !Array.isArray(definition.default)
        : typeof definition.default === "string");
      if (!valid) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props/${name}/default: tipo non valido`]);
    }
    if (definition.type === "enum" && (!Array.isArray(definition.options) || !definition.options.length || (typeof definition.default === "string" && !definition.options.includes(definition.default)))) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/schema/props/${name}: enum non valida`]);
    }
  }
}

/** The capability of documents' JavaScript (pages, posts, components, parts, templates): WordPress's `_xb_script`. */
export const SCRIPT_CAPABILITY = "documents:script:v1";
/** The most JavaScript a document holds, in UTF-8 bytes: WordPress's `Scripts::MAX_BYTES`. */
export const TRANSFER_SCRIPT_MAX_BYTES = 100_000;

/** Whether an entity of the transfer carries JavaScript; each script is checked against the limit in bytes. */
export function transferUsesScripts(entities: readonly TransferEntity[]): boolean {
  let used = false;
  for (const entity of entities) {
    const script = entity.payload.script;
    if (typeof script !== "string" || script === "") continue;
    // WordPress keeps JavaScript for pages, posts and components only (`_xb_script`).
    if (entity.kind !== "document" && entity.kind !== "component") throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/script: parti e template non hanno JavaScript`]);
    if (Buffer.byteLength(script, "utf8") > TRANSFER_SCRIPT_MAX_BYTES || script.includes("\u0000")) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/script: JavaScript oltre ${TRANSFER_SCRIPT_MAX_BYTES / 1000} kB o con un carattere NUL`]);
    used = true;
  }
  return used;
}

export function validateStaticPageProfile(value: unknown): asserts value is StaticPageProfile {
  if (!validateProfile(value)) throw new ContractValidationError("payload-invalid", errorsOf(profileErrors(value, validateProfile.errors)));
  const profile = value as unknown as StaticPageProfile;
  validateTransferManifest(profile.manifest);
  for (const entity of profile.entities) {
    validateTransferEntity(entity);
    validateTombstoneSnapshot(entity);
  }
  for (const reference of profile.references) validateTransferReference(reference);
  const ids = new Set<string>();
  const entityById = new Map<string, TransferEntity>();
  for (const entity of profile.entities) {
    if (ids.has(entity.id)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: identità duplicata`]);
    const expectedRevisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8")
      .digest("hex");
    if (entity.revisionHash !== expectedRevisionHash) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/revisionHash: hash della revisione non valido`]);
    }
    ids.add(entity.id);
    entityById.set(entity.id, entity);
  }
  const activeEntities = profile.entities.filter((entity) => entity.kind !== "tombstone");
  const documents = activeEntities.filter((entity) => entity.kind === "document");
  const pageCount = documents.filter((entity) => entity.payload.documentType === "page").length;
  const posts = documents.filter((entity) => entity.payload.documentType === "post");
  const hasRoles = activeEntities.some((entity) => entity.kind === "template" && entity.payload.role !== undefined);
  const reusableKinds = new Set(["component", "template-part"]);
  const componentCount = activeEntities.filter((entity) => reusableKinds.has(entity.kind)).length;
  const templateCount = activeEntities.filter((entity) => entity.kind === "template").length;
  const stylesCount = activeEntities.filter((entity) => entity.kind === "styles").length;
  if (pageCount < 1 || stylesCount !== 1) throw new ContractValidationError("capability-unavailable", ["Il profilo richiede almeno una pagina e un solo snapshot stili."]);
  const componentCapability = "components:definition:v1";
  const usesTemplates = templateCount > 0 || profile.entities.some((entity) => entity.kind === "template-part");
  const contentTypes = activeEntities.filter((entity) => entity.kind === "content-type");
  const contentRecords = activeEntities.filter((entity) => entity.kind === "content-record");
  const taxonomies = activeEntities.filter((entity) => entity.kind === "taxonomy");
  const terms = activeEntities.filter((entity) => entity.kind === "term");
  const queryPresets = activeEntities.filter((entity) => entity.kind === "query-preset");
  const querySources = activeEntities.filter((entity) => entity.kind === "query-source");
  const hasRelationalContent = contentTypes.length + contentRecords.length + taxonomies.length + terms.length + queryPresets.length + querySources.length > 0;
  const expectedProfile = posts.length || hasRoles ? "histos-static-project-v4" : hasRelationalContent ? "histos-static-project-v3" : usesTemplates ? "histos-static-project-v2" : componentCount > 0 ? "histos-static-project-v1" : "histos-static-page-v1";
  const expectedCapabilities = new Set(["documents:page:v1", "styles:global:v1", "media:asset:v1"]);
  if (componentCount) expectedCapabilities.add(componentCapability);
  if (usesTemplates) expectedCapabilities.add("templates:definition:v1");
  if (contentTypes.length) expectedCapabilities.add("content:types:v1");
  if (contentRecords.length) expectedCapabilities.add("content:records:v1");
  if (taxonomies.length || terms.length) expectedCapabilities.add("content:taxonomies:v1");
  if (queryPresets.length || querySources.length) expectedCapabilities.add("content:queries:v1");
  if (posts.length) expectedCapabilities.add("documents:post:v1");
  if (hasRoles) expectedCapabilities.add("templates:roles:v1");
  if (transferUsesProducts(activeEntities)) expectedCapabilities.add(PRODUCT_CAPABILITY);
  // Doc 18 §6.6: a document's JavaScript travels only under its own capability, so a site that does not know it
  // refuses the whole transfer instead of dropping or running what it cannot check.
  if (transferUsesScripts(activeEntities)) expectedCapabilities.add(SCRIPT_CAPABILITY);
  if (profile.manifest.profile !== expectedProfile || profile.manifest.requiredCapabilities.length !== expectedCapabilities.size || profile.manifest.requiredCapabilities.some((capability) => !expectedCapabilities.has(capability))) {
    throw new ContractValidationError("capability-unavailable", ["Profilo e capability devono corrispondere esattamente ai dati presenti nel trasferimento."]);
  }
  const refs = new Set<string>();
  const templates = new Set<string>();
  const roles = new Set<string>();
  for (const entity of activeEntities) {
    if (!reusableKinds.has(entity.kind) && entity.kind !== "template") continue;
    validateComponentPayload(entity);
    if (entity.kind === "template") {
      const payload = entity.payload;
      const templateRef = payload.ref;
      const templateContent = payload.content;
      if (typeof templateRef !== "string" || typeof templateContent !== "string") throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: template Histeon non valido`]);
      if (!/<!--\s*wp:xb\/slot\s+\{[^}]*"name"\s*:\s*"default"[^}]*\}\s*\/-->/u.test(templateContent)) {
        throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/content: manca lo slot predefinito richiesto per una pagina`]);
      }
      if (templates.has(templateRef)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: riferimento template duplicato`]);
      templates.add(templateRef);
      if (payload.role !== undefined) {
        if (roles.has(String(payload.role))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/role: un solo template per ruolo`]);
        roles.add(String(payload.role));
      }
    }
    const ref = entity.payload.ref;
    if (typeof ref !== "string" || refs.has(ref)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: riferimento componente duplicato o non valido`]);
    refs.add(ref);
  }
  for (const entity of posts) {
    const payload = entity.payload;
    if (typeof payload.slug !== "string" || payload.slug.length > 200 || !POST_SLUG.test(payload.slug)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/slug: lo slug dell'articolo non è canonico`]);
    if (payload.status === "published" ? !isPostPublishedAt(payload.publishedAt) : payload.publishedAt !== null) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/publishedAt: data non coerente con lo stato`]);
  }
  for (const entity of activeEntities) {
    if (entity.kind === "document" && entity.payload.templateRef !== undefined && entity.payload.templateRef !== null && (typeof entity.payload.templateRef !== "string" || !templates.has(entity.payload.templateRef))) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/templateRef: il template assegnato non esiste nel profilo`]);
    }
  }
  for (const reference of profile.references) {
    if (!ids.has(reference.ownerId) || !ids.has(reference.targetId)) throw new ContractValidationError("payload-invalid", [`/references/${reference.ownerId}/${reference.blockUid}: riferimento non risolto`]);
    const owner = entityById.get(reference.ownerId);
    const target = entityById.get(reference.targetId);
    const validOwner = owner?.kind === "document" || reusableKinds.has(owner?.kind ?? "") || owner?.kind === "template";
    const validTarget = reference.role === "media" ? target?.kind === "asset" : reusableKinds.has(target?.kind ?? "");
    // A srcset reference names the candidate it stands for; a src reference has no index.
    const validPath = reference.role === "media"
      ? (reference.path === "attrs.attributes.src" && reference.index === undefined) || (reference.path === "attrs.attributes.href" && reference.index === undefined) || (/^attrs\.props\.[A-Za-z_$][A-Za-z0-9_$]*$/u.test(reference.path) && reference.index === undefined) || (reference.path === "attrs.attributes.srcset" && Number.isInteger(reference.index) && (reference.index ?? -1) >= 0)
      : reference.path === "attrs.ref";
    if (!validOwner || !validTarget || !validPath) throw new ContractValidationError("payload-invalid", [`/references/${reference.ownerId}/${reference.blockUid}: tipo, percorso o destinazione non validi`]);
  }

  const byKindKey = new Map<string, TransferEntity>();
  for (const entity of profile.entities) {
    const key = entity.kind === "content-type" || entity.kind === "taxonomy" ? entity.payload.key
      : entity.kind === "query-preset" ? entity.payload.key
        : entity.kind === "query-source" ? entity.payload.name
          : undefined;
    if (typeof key === "string") {
      const compound = `${entity.kind}\0${key}`;
      if (byKindKey.has(compound)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: chiave ${key} duplicata per ${entity.kind}`]);
      byKindKey.set(compound, entity);
    }
  }
  const typesByKey = new Map(contentTypes.map((entity) => [String(entity.payload.key), entity]));
  const taxonomiesByKey = new Map(taxonomies.map((entity) => [String(entity.payload.key), entity]));
  const termsById = new Map(terms.map((entity) => [entity.id, entity]));
  const recordsById = new Map(contentRecords.map((entity) => [entity.id, entity]));
  const assetsById = new Map(profile.entities.filter((entity) => entity.kind === "asset").map((entity) => [entity.id, entity]));
  for (const entity of activeEntities) {
    if (entity.kind !== "styles") continue;
    const payloadStyles = entity.payload.styles as Array<Record<string, JsonValue>>;
    const payloadGlobals = entity.payload.globals as Array<Record<string, JsonValue>>;
    for (const global of payloadGlobals) {
      if (global.source && typeof global.source === "object" && !Array.isArray(global.source)) {
        const source = global.source as Record<string, JsonValue>;
        if (source.preset !== undefined) validateCoreFrameworkPresetData(source.preset, source.frameworkId);
        if (source.configuration !== undefined) validateExternalFrameworkConfiguration(source.configuration);
      }
    }
    for (const rule of [...payloadStyles, ...payloadGlobals]) {
      const mappings = rule.assets;
      const references = new Set<string>();
      if (mappings !== undefined) {
        if (!Array.isArray(mappings) || mappings.length > 500) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: mappatura media CSS oltre i limiti`]);
        for (const mapping of mappings) {
          if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || typeof mapping.reference !== "string" || !mapping.reference.trim() || typeof mapping.assetId !== "string" || references.has(mapping.reference)) {
            throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: riferimento media CSS duplicato o non valido`]);
          }
          const target = assetsById.get(mapping.assetId);
          const mediaType = target?.payload.mediaType;
          if (target?.kind !== "asset" || typeof mediaType !== "string" || !["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "font/otf", "font/ttf", "font/woff", "font/woff2"].includes(mediaType)) {
            throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: riferimento media CSS non risolto o formato non supportato`]);
          }
          references.add(mapping.reference);
        }
      }
      const css = rule.css;
      if (typeof css !== "string") continue;
      const resources = cssResourceReferences(css);
      if (resources.some((resource) => resource.kind === "import" && !resource.external)) {
        throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: @import locale non trasferibile nel profilo CMS`]);
      }
      for (const resource of resources) {
        if (resource.kind === "url" && !resource.external && !references.has(resource.value)) {
          throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: URL CSS locale senza media collegato (${resource.value})`]);
        }
      }
    }
  }
  const templatesByRef = new Map(profile.entities.filter((entity) => entity.kind === "template").map((entity) => [String(entity.payload.ref), entity]));
  if (templatesByRef.size !== templateCount) throw new ContractValidationError("payload-invalid", ["I riferimenti template del trasferimento devono essere univoci."]);
  for (const entity of contentTypes) {
    const key = String(entity.payload.key);
    // Doc 23 item 122: a type without pages of its own has no templates to render them.
    if (entity.payload.public === false && (entity.payload.singleTemplateRef !== undefined || entity.payload.archiveTemplateRef !== undefined)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload: un tipo senza pagine proprie non ha template di singolo o archivio`]);
    for (const property of ["singleTemplateRef", "archiveTemplateRef"] as const) {
      const ref = entity.payload[property];
      if (ref !== undefined && (typeof ref !== "string" || !templatesByRef.has(ref))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/${property}: template non incluso nel trasferimento`]);
    }
    const fields = entity.payload.fields as Array<Record<string, JsonValue>>;
    const fieldKeys = new Set<string>();
    for (const field of fields) {
      const fieldKey = String(field.key);
      if (fieldKeys.has(fieldKey)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/fields: campo duplicato ${fieldKey}`]);
      fieldKeys.add(fieldKey);
      if (field.type === "relation" && (typeof field.targetType !== "string" || !typesByKey.has(field.targetType))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/fields/${fieldKey}: tipo relazione non presente nel trasferimento`]);
      if (field.type === "enum" && (!Array.isArray(field.options) || !field.options.length)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/fields/${fieldKey}: mancano le opzioni enum`]);
      if (field.type !== "relation" && field.targetType !== undefined || field.type !== "enum" && field.options !== undefined) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/fields/${fieldKey}: opzioni incompatibili con il tipo`]);
    }
  }
  for (const entity of contentTypes) {
    if (entity.payload.key === "post" || entity.payload.key === "page") throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/key: post e page sono tipi predefiniti`]);
    if ((PRODUCT_TAXONOMIES as readonly JsonValue[]).includes(entity.payload.key ?? null)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/key: product_cat e product_tag sono le tassonomie dei prodotti`]);
    // The shop's products (queue C6): fixed fields, the same in every project and in WooCommerce.
    if (entity.payload.key === PRODUCT_TYPE_KEY && !isProductFields(entity.payload.fields)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/fields: il tipo product ha esattamente i campi del prodotto`]);
  }
  if (contentTypes.length > 30 || taxonomies.length > 30 || queryPresets.length > 128 || querySources.length > 50) throw new ContractValidationError("payload-invalid", ["Il profilo relazionale supera i limiti comuni tra Histeon CMS e WordPress."]);
  if (contentTypes.some((type) => String(type.payload.key) === String(taxonomies.find((taxonomy) => taxonomy.payload.key === type.payload.key)?.payload.key))) throw new ContractValidationError("payload-invalid", ["Una chiave non può identificare sia un tipo sia una tassonomia."]);
  for (const entity of taxonomies) {
    const typeKeys = entity.payload.types as string[];
    if ((POST_TAXONOMIES as readonly string[]).includes(String(entity.payload.key)) && (typeKeys.length !== 1 || typeKeys[0] !== "post")) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/types: categorie e tag valgono soltanto per gli articoli`]);
    if ((PRODUCT_TAXONOMIES as readonly string[]).includes(String(entity.payload.key)) && (typeKeys.length !== 1 || typeKeys[0] !== PRODUCT_TYPE_KEY)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/types: le categorie e i tag dei prodotti valgono soltanto per i prodotti`]);
    if (typeKeys.some((key) => key !== "post" && !typesByKey.has(key))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/types: la tassonomia collega un tipo non incluso nel trasferimento`]);
  }
  for (const entity of terms) {
    const taxonomy = taxonomiesByKey.get(String(entity.payload.taxonomyKey));
    if (!taxonomy) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/taxonomyKey: tassonomia non inclusa nel trasferimento`]);
    const parentId = entity.payload.parentId;
    if (typeof parentId === "string") {
      const parent = termsById.get(parentId);
      if (!parent || parent.payload.taxonomyKey !== entity.payload.taxonomyKey || parent.id === entity.id) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/parentId: termine genitore non valido`]);
    }
  }
  for (const entity of terms) {
    const ancestors = new Set<string>([entity.id]);
    let next = entity.payload.parentId;
    while (typeof next === "string") {
      if (ancestors.has(next)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/parentId: ciclo nella gerarchia dei termini`]);
      ancestors.add(next);
      next = termsById.get(next)?.payload.parentId;
    }
  }
  for (const entity of contentRecords) {
    const payload = entity.payload;
    const type = typesByKey.get(String(payload.typeKey));
    if (!type) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/typeKey: tipo non incluso nel trasferimento`]);
    const fields = type.payload.fields as Array<Record<string, JsonValue>>;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(payload.slug))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/slug: lo slug non è canonico`]);
    try {
      const locale = Intl.getCanonicalLocales(String(payload.locale))[0];
      if (locale !== payload.locale) throw new Error("locale non canonico");
    } catch { throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/locale: lingua non canonica`]); }
    if (payload.status === "published" && (typeof payload.publishedAt !== "string" || !Number.isFinite(Date.parse(payload.publishedAt))) || payload.status !== "published" && payload.publishedAt !== null) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/publishedAt: data non coerente con lo stato`]);
    const fieldByKey = new Map(fields.map((field) => [String(field.key), field]));
    const values = payload.values as Record<string, JsonValue>;
    for (const field of fields) if (field.required === true && (!Object.hasOwn(values, String(field.key)) || values[String(field.key)] === null || values[String(field.key)] === "" || Array.isArray(values[String(field.key)]) && (values[String(field.key)] as JsonValue[]).length === 0)) {
      throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${String(field.key)}: campo obbligatorio mancante`]);
    }
    for (const [fieldKey, value] of Object.entries(values)) {
      const field = fieldByKey.get(fieldKey);
      if (!field) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: campo non dichiarato`]);
      const valuesList = field.multiple === true ? Array.isArray(value) ? value as JsonValue[] : null : Array.isArray(value) ? null : [value];
      if (!valuesList) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: cardinalità non valida`]);
      for (const item of valuesList) {
        if (item === null || item === "") continue;
        if (field.type === "relation") {
          if (typeof item !== "string" || recordsById.get(item)?.payload.typeKey !== field.targetType) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: record collegato non presente o di tipo errato`]);
        } else if (field.type === "asset" && (typeof item !== "string" || !assetsById.has(item))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: asset collegato non presente`]);
        else if ((field.type === "text" || field.type === "rich-text" || field.type === "date" || field.type === "datetime" || field.type === "enum" || field.type === "url") && typeof item !== "string") throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: valore testuale non valido`]);
        else if (field.type === "integer" && (typeof item !== "number" || !Number.isSafeInteger(item))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: intero non valido`]);
        else if (field.type === "decimal" && (typeof item !== "number" || !Number.isFinite(item))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: numero non valido`]);
        else if (field.type === "boolean" && typeof item !== "boolean") throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: valore booleano non valido`]);
        else if (field.type === "enum" && !(field.options as string[]).includes(String(item))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${fieldKey}: opzione non dichiarata`]);
      }
    }
    const recordTerms = payload.terms as Record<string, string[]>;
    for (const [taxonomyKey, termIds] of Object.entries(recordTerms)) {
      const taxonomy = taxonomiesByKey.get(taxonomyKey);
      if (!taxonomy || !(taxonomy.payload.types as string[]).includes(String(payload.typeKey))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/terms/${taxonomyKey}: tassonomia non collegata al tipo`]);
      for (const termId of termIds) if (termsById.get(termId)?.payload.taxonomyKey !== taxonomyKey) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/terms/${taxonomyKey}: termine non incluso o di tassonomia errata`]);
    }
  }
  for (const entity of posts) {
    const postTerms = entity.payload.terms;
    if (!postTerms || typeof postTerms !== "object" || Array.isArray(postTerms)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/terms: termini non validi`]);
    for (const [taxonomyKey, termIds] of Object.entries(postTerms as Record<string, JsonValue>)) {
      const taxonomy = taxonomiesByKey.get(taxonomyKey);
      if (!taxonomy || !(taxonomy.payload.types as string[]).includes("post")) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/terms/${taxonomyKey}: tassonomia non collegata agli articoli`]);
      if (!Array.isArray(termIds) || termIds.some((termId) => typeof termId !== "string" || termsById.get(termId)?.payload.taxonomyKey !== taxonomyKey)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/terms/${taxonomyKey}: termine non incluso o di tassonomia errata`]);
    }
    // Doc 23 item 119: the featured image is an image asset of the profile.
    if (entity.payload.image !== undefined) {
      const image = entityById.get(String(entity.payload.image));
      if (image?.kind !== "asset" || !String(image.payload.mediaType ?? "").startsWith("image/")) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/image: l'immagine dell'articolo non è un'immagine del trasferimento`]);
    }
  }
  const productSkus = new Set<string>();
  for (const entity of contentRecords) {
    if (entity.payload.typeKey !== PRODUCT_TYPE_KEY) continue;
    const values = entity.payload.values as Record<string, JsonValue>;
    const issues = productValueIssues({ title: entity.payload.title, excerpt: entity.payload.excerpt, values });
    if (issues.length) throw new ContractValidationError("payload-invalid", issues.map((issue) => `/entities/${entity.id}/payload: ${issue}`));
    const sku = productSku(values);
    if (sku !== null) {
      if (productSkus.has(sku)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/sku: lo SKU ${sku} è già di un altro prodotto`]);
      productSkus.add(sku);
    }
  }
  const recordSlugs = new Set<string>();
  for (const entity of contentRecords) {
    const key = `${String(entity.payload.typeKey)}\0${String(entity.payload.locale)}\0${String(entity.payload.slug)}`;
    if (recordSlugs.has(key)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}: tipo, lingua e slug duplicati`]);
    recordSlugs.add(key);
  }
  for (const entity of contentRecords) {
    for (const field of (typesByKey.get(String(entity.payload.typeKey))?.payload.fields as Array<Record<string, JsonValue>>) ?? []) {
      if (field.type !== "relation") continue;
      const value = (entity.payload.values as Record<string, JsonValue>)[String(field.key)];
      const targets = field.multiple === true && Array.isArray(value) ? value : [value];
      if (entity.payload.status === "published" && targets.some((targetId) => typeof targetId === "string" && recordsById.get(targetId)?.payload.status !== "published")) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/values/${String(field.key)}: un record pubblicato non può riferire un record non pubblicato`]);
    }
  }
  for (const entity of queryPresets) {
    if (entity.payload.typeKey !== "post" && !typesByKey.has(String(entity.payload.typeKey))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/typeKey: tipo query non incluso nel trasferimento`]);
    const key = String(entity.payload.key);
    if (["posts", "terms", "main", "users"].includes(key)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/key: nome riservato`]);
    if (entity.payload.filter !== undefined) {
      const checkFilter = (filter: JsonValue, depth: number): void => {
        if (!filter || typeof filter !== "object" || Array.isArray(filter) || depth > 4) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/filter: filtro non valido`]);
        const candidate = filter as Record<string, JsonValue>;
        if (Object.keys(candidate).length === 1 && (Array.isArray(candidate.and) || Array.isArray(candidate.or))) {
          const group = (candidate.and ?? candidate.or) as JsonValue[];
          if (!group.length || group.length > 32) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/filter: gruppo vuoto o troppo grande`]);
          for (const child of group) checkFilter(child, depth + 1);
          return;
        }
        if (typeof candidate.taxonomyKey === "string") {
          const taxonomy = taxonomiesByKey.get(candidate.taxonomyKey);
          if (Object.keys(candidate).some((name) => !["taxonomyKey", "termIds", "operator"].includes(name)) || !taxonomy || !(taxonomy.payload.types as string[]).includes(String(entity.payload.typeKey)) || !Array.isArray(candidate.termIds) || !candidate.termIds.length || candidate.termIds.length > 100 || !["IN", "NOT IN", "AND"].includes(String(candidate.operator)) || candidate.termIds.some((id) => typeof id !== "string" || termsById.get(id)?.payload.taxonomyKey !== candidate.taxonomyKey)) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/filter: filtro tassonomia non valido`]);
          return;
        }
        const fieldPath = typeof candidate.field === "string" ? candidate.field.split(".") : [];
        let field: Record<string, JsonValue> | undefined;
        let currentTypeKey = String(entity.payload.typeKey);
        if (fieldPath.length > 0 && fieldPath.length <= 4 && fieldPath.every((part) => /^[a-z][a-z0-9_]{0,62}$/u.test(part))) {
          for (let index = 0; index < fieldPath.length; index += 1) {
            const currentType = typesByKey.get(currentTypeKey);
            const currentFields = currentType?.payload.fields as Array<Record<string, JsonValue>> | undefined;
            const resolved = currentFields?.find((item) => item.key === fieldPath[index]);
            if (!resolved || resolved.public !== true) { field = undefined; break; }
            if (index < fieldPath.length - 1) {
              if (resolved.type !== "relation" || typeof resolved.targetType !== "string" || !typesByKey.has(resolved.targetType)) { field = undefined; break; }
              currentTypeKey = resolved.targetType;
            } else field = resolved;
          }
        }
        const ops = new Set(["eq", "ne", "in", "lt", "lte", "gt", "gte", "contains", "exists"]);
        if (Object.keys(candidate).some((name) => !["field", "op", "value"].includes(name)) || !field || field.public !== true || field.type !== "relation" && field.multiple === true || !ops.has(String(candidate.op)) || candidate.op !== "exists" && !Object.hasOwn(candidate, "value") || ["asset", "rich-text"].includes(String(field.type))) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/filter: filtro campo non valido o non pubblico`]);
        if (candidate.op === "exists" && Object.hasOwn(candidate, "value")) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/filter: exists non accetta value`]);
        if (field.type === "relation") {
          const target = typeof candidate.value === "string" ? recordsById.get(candidate.value) : undefined;
          if (candidate.op !== "exists" && (candidate.op !== "eq" || field.multiple === true || !target || target.payload.typeKey !== field.targetType || target.payload.status !== "published")) {
            throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/filter: filtro relazione non valido o record collegato assente/non pubblicato`]);
          }
          return;
        }
        if (candidate.op !== "exists") {
          const validValue = (value: JsonValue): boolean => {
            if (field.type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
            if (field.type === "decimal") return typeof value === "number" && Number.isFinite(value);
            if (field.type === "boolean") return typeof value === "boolean";
            if (typeof value !== "string" || value.length > 4096) return false;
            return field.type !== "enum" || Array.isArray(field.options) && (field.options as string[]).includes(value);
          };
          const value = candidate.value!;
          if (candidate.op === "in") {
            if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some((item) => !validValue(item))) {
              throw new ContractValidationError("payload-invalid", ["Filtro in non valido per il tipo del campo."]);
            }
          } else if (Array.isArray(value) || value !== null && typeof value === "object" || !validValue(value)) {
            throw new ContractValidationError("payload-invalid", ["Valore non valido per il tipo del campo."]);
          }
          if (candidate.op === "contains" && typeof value !== "string") {
            throw new ContractValidationError("payload-invalid", ["contains richiede un valore testuale."]);
          }
        }
      };
      checkFilter(entity.payload.filter, 0);
    }
  }
  const queryNames = new Set([...queryPresets.map((entity) => String(entity.payload.key)), ...querySources.map((entity) => String(entity.payload.name))]);
  if (queryNames.size !== queryPresets.length + querySources.length) throw new ContractValidationError("payload-invalid", ["Una query e una sorgente dati usano lo stesso nome."]);
  if (querySources.some((entity) => ["posts", "terms", "main", "users"].includes(String(entity.payload.name)))) throw new ContractValidationError("payload-invalid", ["Una sorgente dati usa un nome riservato."]);
  let sourceBytes = 0;
  for (const entity of querySources) {
    const bytes = Buffer.byteLength(canonicalizeJson(entity.payload.data as JsonValue), "utf8");
    sourceBytes += bytes;
    if (bytes > 262144 || sourceBytes > 1048576) throw new ContractValidationError("payload-invalid", [`/entities/${entity.id}/payload/data: limite sorgenti dati superato`]);
  }

  const graph = new Map<string, string[]>();
  for (const reference of profile.references) {
    if (reference.role !== "document" || !reusableKinds.has(entityById.get(reference.ownerId)?.kind ?? "")) continue;
    graph.set(reference.ownerId, [...(graph.get(reference.ownerId) ?? []), reference.targetId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ContractValidationError("payload-invalid", [`/references/${id}: i componenti non possono richiamarsi in modo ricorsivo`]);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const entity of activeEntities) if (reusableKinds.has(entity.kind)) visit(entity.id);
}

export function canonicalRevisionPayload(kind: TransferEntity["kind"], schemaVersion: 1, payload: Record<string, JsonValue>): string {
  // WordPress 7.1 writes a backslash in block attributes as \u005c, earlier versions and Histeon as \\: the same document.
  const same = typeof (payload as { content?: unknown })?.content === "string" ? { ...(payload as object), content: (payload as { content: string }).content.replaceAll("\\u005c", "\\\\") } : payload;
  return canonicalizeJson({ kind, schemaVersion, payload: same } as JsonValue);
}

export function manifestHashInput(manifest: Omit<TransferManifest, "manifestHash"> | TransferManifest): string {
  const { manifestHash: _ignored, ...body } = manifest as TransferManifest;
  return canonicalizeJson(body as unknown as JsonValue);
}
