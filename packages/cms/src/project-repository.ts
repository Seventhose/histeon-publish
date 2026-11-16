import { createHash, randomUUID } from "node:crypto";
import { chmod, constants as fsConstants, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync as renameFileSync, rmSync, writeSync } from "node:fs";
import type { ProjectDatabase as DatabaseSync, ProjectDatabaseOpener, ProjectMediaFiles } from "./project-database.js";
import { type ArticleProposal, readArticleProposal } from "./article-proposal.js";
import { receiveSiteTokens } from "./histos-design.js";
import { asFontSheet, FONT_SHEET_ID, type FontSheet } from "./local-fonts.js";
import { openNodeProjectDatabase } from "./project-database-node.js";
import path from "node:path";
import { canonicalizeJson, isPostPublishedAt, PRODUCT_TYPE_KEY, TEMPLATE_ROLES, validateStaticPageProfile, validateTransferEntity, type StaticPageProfile, type TemplateRole, type TransferEntity } from "@histos-publish/histos-contract";
import { CmsContentModel, POST_TYPE_KEY, type CmsRecord, type CmsRecordStatus, type CmsTerm } from "./content-model.js";
import { normalizeCmsImageSettings, type CmsImageSettings } from "./image-variants.js";
import { COMPONENT_REF_PATTERN, parse, parseXb, serializeXb } from "../.generated/histos-dsl/index.js";
import { formatTransferSrcset, parseTransferSrcset } from "./transfer-markup.js";
import { normalizeShopSettings, type CmsCommerceContext, type CmsShopSettings } from "./commerce.js";
import { assertDocumentScript } from "./document-script.js";
import { normalizeSiteUrl } from "./site-languages.js";
import { normalizeStringSource } from "./localize-html.js";
import { buildXliff, parseXliff } from "./translation-xliff.js";
import { applySegments, assertSegmentText, documentSegments, segmentMap, staticTexts, type TranslationSegment } from "./translation-segments.js";
import { canonicalProjectLanguage, documentAddress, languageName, normalizeProjectLanguages, type CmsProjectLanguages, type CmsTranslationKind, type CmsTranslationLink, type CmsTranslationMode, type CmsTranslationState } from "./translations.js";
export { assertDocumentScript, DOCUMENT_SCRIPT_MAX_BYTES } from "./document-script.js";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENTITY_ID = PROJECT_ID;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const COMPONENT_ALIAS_START = 1_000_000_000;
/**
 * Version of the project database schema (PRAGMA user_version). Every change to the tables bumps it: the migration
 * then runs once, inside a transaction, after a snapshot of the old database. Version 1 databases may miss columns
 * added later without a bump, so version 2 re-runs the whole idempotent setup once. Version 4 does the same for
 * cms_document_scripts and cms_import_reports, added at version 3 without a bump: those databases could not open.
 * Version 5 adds the languages (doc 20): entities.locale, cms_translations, cms_strings, cms_translation_memory.
 * Version 6 adds entities.image_asset_id (doc 23 item 119) and cms_content_types.is_public (item 122): 1.24.0 added
 * them without a bump, so its projects from before could not build ("no such column: image_asset_id").
 */
const CMS_DATABASE_SCHEMA_VERSION = 6;

/**
 * Whether group and others have no access. POSIX only: on Windows the mode bits do not describe access (it is the
 * ACL of the user's profile folder, where the projects live), and Node reports 0o666/0o777 for every file.
 */
function privateMode(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

function preserveSchemaMigrationSnapshot(database: DatabaseSync, projectDirectory: string, fromVersion: number, toVersion: number): void {
  const recoveryDirectory = path.join(projectDirectory, "recovery");
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const projectRoot = realpathSync(projectDirectory);
  const recoveryInfo = lstatSync(recoveryDirectory);
  if (recoveryInfo.isSymbolicLink() || !recoveryInfo.isDirectory() || !privateMode(recoveryInfo.mode)) {
    throw new TypeError("La cartella di recupero non è privata e regolare; la migrazione è stata fermata.");
  }
  const recoveryRoot = realpathSync(recoveryDirectory);
  const relative = path.relative(projectRoot, recoveryRoot);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new TypeError("La copia di sicurezza della migrazione uscirebbe dal progetto.");
  }
  const snapshotPath = path.join(recoveryRoot, `before-schema-v${fromVersion}-to-v${toVersion}-${Date.now()}-${randomUUID()}.sqlite`);
  database.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
  const snapshotInfo = lstatSync(snapshotPath);
  if (snapshotInfo.isSymbolicLink() || !snapshotInfo.isFile()) throw new TypeError("La copia di sicurezza della migrazione non è un file regolare.");
  chmodSync(snapshotPath, 0o600);
  if (!privateMode(lstatSync(snapshotPath).mode)) throw new TypeError("La copia di sicurezza della migrazione non è privata.");
}

export type CmsEntityKind = "page" | "styles";
/** A document is a page or a post (docs/spec/cms-bridge.md §12); both live in `entities` with kind `page`. */
export type CmsDocumentType = "page" | "post";
const POST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_POST_EXCERPT = 20_000;
export type CmsComponentKind = "component" | "template-part" | "template";
export type CmsTemplatePartArea = "header" | "footer" | "uncategorized";

export type CmsComponentJsonValue = string | number | boolean | null | CmsComponentJsonValue[] | { [key: string]: CmsComponentJsonValue };

export interface CmsComponentPropDefinition {
  type: string;
  default?: CmsComponentJsonValue;
  label?: string;
  options?: string[];
}

export interface CmsComponentSchema {
  props: Record<string, CmsComponentPropDefinition>;
}

export interface CmsComponent {
  id: string;
  alias: number;
  kind: CmsComponentKind;
  partArea: CmsTemplatePartArea | null;
  ref: string;
  title: string;
  /** Templates only: the WordPress template hierarchy role it fills (front-page, single, 404…). */
  role: TemplateRole | null;
  schema: CmsComponentSchema;
  content: string;
  headRevision: string;
  contentHash: string;
  updatedAt: string;
}

export interface CmsComponentConflict {
  id: string;
  componentId: string;
  expectedHead: string | null;
  actualHead: string;
  proposedContent: string;
  proposedRef: string;
  proposedSchema: CmsComponentSchema;
  proposedHash: string;
  createdAt: string;
}

export type CmsComponentSaveResult =
  | { status: "saved"; component: CmsComponent; revision: CmsComponent }
  | { status: "conflict"; conflict: CmsComponentConflict; current: CmsComponent };

export interface CmsProject {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface CmsRenderSettings {
  locale: string;
  timeZone: string;
}

/** A page or post in the site administration's index. */
export interface CmsAdminDocument { id: string; alias: number; kind: "page" | "post"; title: string; slug: string; status: string; locale: string | null; templateRef: string | null; publishedAt: string | null; head: string; updatedAt: string; address: string }
export interface CmsAdminRecord { id: string; kind: "record"; typeKey: string; title: string; slug: string; status: string; locale: string; head: string; updatedAt: string }
export interface CmsSeo { title: string; description: string; image: string }
export interface CmsRedirect { from: string; to: string }
export interface CmsAdminItem { id: string; alias: number; ref: string; title: string; updatedAt: string; role?: string | null }
export interface CmsAdminIndex {
  pages: CmsAdminDocument[];
  posts: CmsAdminDocument[];
  records: CmsAdminRecord[];
  types: Array<{ key: string; label: string }>;
  taxonomies: Array<{ key: string; label: string }>;
  assets: Array<{ id: string; alias: number; filename: string; alt: string; caption: string; mimeType: string }>;
  templates: CmsAdminItem[];
  parts: CmsAdminItem[];
  components: CmsAdminItem[];
  translations: Array<{ translationId: string; sourceId: string; kind: CmsTranslationKind; language: string; mode: CmsTranslationMode; state: CmsTranslationState }>;
  languages: CmsProjectLanguages;
  siteUrl: string | null;
  siteSearch: boolean;
  renderSettings: CmsRenderSettings;
  imageVariants: boolean;
  shop: CmsShopSettings;
}

/** Read contract required by the shared Histeon renderer; persistence stays behind CmsProjectStore. */
export interface Repository {
  readonly project: CmsProject;
  readonly content: Pick<CmsContentModel, "getType" | "listQuerySources" | "listQueryPresets" | "resolveQueryPreset">;
  getComponentByAlias(alias: number): CmsComponent | null;
  getComponentByRef(ref: string): CmsComponent | null;
  getTemplateByRef(ref: string): CmsComponent | null;
  canUseTemplate(ref: string): boolean;
  getStyles(): CmsEntity | null;
  getFontSheet(): FontSheet | null;
  getHead(entityId: string): CmsRevision | null;
  readAsset(id: string): Promise<{ metadata: CmsAssetMetadata; bytes: Uint8Array } | null>;
  /** What the build needs to describe products (queue C6, commerce.ts); without it a product has no `product`. */
  commerceContext?(): CmsCommerceContext;
  /** A media item of the project by id, for a post's `image` (doc 23 item 119); without it a post has no image. */
  mediaAsset?(id: string): { id: string; alt: string; caption: string; filename: string } | null;
}

export interface CmsAssetMetadata {
  id: string;
  alias: number;
  sha256: string;
  mimeType: string;
  filename: string;
  alt: string;
  caption: string;
  relativePath: string;
}

function containsAsciiSpaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x20) return true;
  }
  return false;
}

let systemRenderDefaults: { locale: string; timeZone: string } | null = null;

function defaultCmsRenderSettings(): CmsRenderSettings {
  // The computer's language and time zone, read once: building an Intl formatter for every page is slow.
  if (!systemRenderDefaults) {
    const defaults = new Intl.DateTimeFormat().resolvedOptions();
    systemRenderDefaults = { locale: defaults.locale || "it-IT", timeZone: defaults.timeZone || "UTC" };
  }
  return normalizeCmsRenderSettings(systemRenderDefaults);
}

/** Intl is slow to build: the same pair is checked once (a big import asks for it on every page, queue D3). */
const normalizedRenderSettings = new Map<string, CmsRenderSettings>();

export function normalizeCmsRenderSettings(value: unknown): CmsRenderSettings {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.locale === "string" && typeof candidate.timeZone === "string") {
      const known = normalizedRenderSettings.get(`${candidate.locale}\u0000${candidate.timeZone}`);
      if (known) return { ...known };
    }
  }
  const normalized = checkCmsRenderSettings(value);
  const candidate = value as { locale: string; timeZone: string };
  if (normalizedRenderSettings.size >= 64) normalizedRenderSettings.clear();
  normalizedRenderSettings.set(`${candidate.locale}\u0000${candidate.timeZone}`, { ...normalized });
  return normalized;
}

function checkCmsRenderSettings(value: unknown): CmsRenderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Impostazioni regionali non valide.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.locale !== "string" || candidate.locale.length < 2 || candidate.locale.length > 64 || containsAsciiSpaceOrControl(candidate.locale)) {
    throw new TypeError("Lingua e formato regionale non validi. Usa un tag BCP 47, per esempio it-IT.");
  }
  if (typeof candidate.timeZone !== "string" || candidate.timeZone.length < 1 || candidate.timeZone.length > 64 || containsAsciiSpaceOrControl(candidate.timeZone)) {
    throw new TypeError("Fuso orario non valido. Usa un identificatore IANA, per esempio Europe/Rome.");
  }
  let locale: string;
  let timeZone: string;
  try {
    locale = Intl.getCanonicalLocales(candidate.locale)[0] ?? "";
    timeZone = new Intl.DateTimeFormat(locale, { timeZone: candidate.timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new TypeError("Lingua o fuso orario non riconosciuti da questo computer.");
  }
  if (!locale || !timeZone) throw new TypeError("Lingua o fuso orario non riconosciuti da questo computer.");
  return { locale, timeZone };
}

export interface CmsEntity {
  id: string;
  kind: CmsEntityKind;
  alias: number;
  slug: string;
  title: string;
  status: "draft" | "published";
  headRevision: string;
  templateRef: string | null;
  documentType: CmsDocumentType;
  /** Posts only: publication date in whole UTC seconds, null for drafts. */
  publishedAt: string | null;
  /** Posts only: plain-text summary. */
  excerpt: string;
  /** Posts only: the featured image, an image of the project's media (doc 23 item 119), or null. */
  imageAssetId: string | null;
  /** The document's language; null is the site's, which follows render.locale (doc 20 §4.2). */
  locale: string | null;
  updatedAt: string;
}

export interface CmsRevision {
  id: string;
  entityId: string;
  parentId: string | null;
  createdAt: string;
  content: string;
  contentHash: string;
  source: "editor" | "import" | "conflict-resolution";
}

export interface CmsConflict {
  id: string;
  entityId: string;
  expectedHead: string | null;
  actualHead: string;
  proposedContent: string;
  proposedHash: string;
  createdAt: string;
}

export type SaveResult =
  | { status: "saved"; entity: CmsEntity; revision: CmsRevision }
  | { status: "conflict"; conflict: CmsConflict; current: CmsRevision };

export class CmsSyncConflictError extends Error {
  constructor(readonly conflicts: Array<{ id: string; kind: string; baseHash: string | null; localHash: string | null; remoteHash: string }>) {
    super("Il sito remoto e la copia locale hanno modifiche concorrenti. Ho fermato il trasferimento prima di applicare i cambiamenti.");
    this.name = "CmsSyncConflictError";
  }
}

/**
 * The project changed while it was being copied (a media file replaced between its check and its link or copy, as a
 * save of the same bytes with another alt does): nothing is wrong with its content, the copy is just not one consistent
 * snapshot, so the operation can simply be repeated. Never a TypeError, so it is not taken for invalid content; `code`
 * and `status` are the ones the server sends (409).
 */
export class CmsProjectChangedError extends Error {
  readonly code = "cms-project-changed";
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "CmsProjectChangedError";
  }
}

/** A project leaves the Cestino only where no project with its id exists: the one refusal of restoreProject a person can solve. */
export class CmsProjectRestoreConflictError extends Error {
  constructor() {
    super("Un progetto con lo stesso identificativo esiste già.");
    this.name = "CmsProjectRestoreConflictError";
  }
}

/**
 * A backup of the project would be refused by its own restore (decodeNativeProjectArchive, importNativeProjectBackup):
 * a media file whose bytes no longer match its sha256 name (truncated by a crash, edited outside the app) or that is
 * gone (deleted outside the app), or a database the restore's checks refuse. Nothing is saved: a backup that cannot be
 * restored is worse than none, since keeping it rotates out an older one that can. The message of a media file says
 * how to repair it: upload the same file again (saveAsset puts it back). A TypeError, as the restore's own refusal;
 * `code` and `status` are the ones the server sends (422).
 */
export class CmsBackupUnrestorableError extends TypeError {
  readonly code = "cms-backup-unrestorable";
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "CmsBackupUnrestorableError";
  }
}

/**
 * What a backup of a project holds, measured exactly: the bytes of its database snapshot (VACUUM INTO, as the backup
 * writes it) and of each media file the snapshot's live assets use, one per file. The backup made before an update and
 * the check that offers the update measure the same thing (encodeNativeProjectArchive, copyProjectForComparison), so
 * assertNativeBackupFits gives both the same answer.
 */
export interface NativeBackupSizes {
  database: number;
  media: ReadonlyArray<{ path: string; bytes: number }>;
}

interface ProjectManifest {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}
interface EntityRow { id: string; kind: CmsEntityKind; alias: number; slug: string; title: string; status: "draft" | "published"; head_revision: string; template_ref?: string | null; document_type?: CmsDocumentType; published_at?: string | null; excerpt?: string; image_asset_id?: string | null; locale?: string | null; updated_at: string }
interface RevisionRow { id: string; entity_id: string; parent_id: string | null; created_at: string; content: string; content_hash: string; source: CmsRevision["source"] }
interface ConflictRow { id: string; entity_id: string; expected_head: string | null; actual_head: string; proposed_content: string; proposed_hash: string; created_at: string }
interface ComponentRow { id: string; alias: number; kind: CmsComponentKind; part_area?: CmsTemplatePartArea; template_role?: TemplateRole | null; ref: string; title: string; head_revision: string; updated_at: string }
interface ComponentRevisionRow { id: string; component_id: string; parent_id: string | null; created_at: string; content: string; content_hash: string; schema_json: string }
interface ComponentConflictRow { id: string; component_id: string; expected_head: string | null; actual_head: string; proposed_content: string; proposed_ref: string; proposed_schema_json: string; proposed_hash: string; created_at: string }

const MAX_PROJECT_STRINGS = 20_000;

/** A record as saveRecord takes it back: relations and terms as ids, the rest as it is. */
function recordWriteInput(record: CmsRecord, fields: ReadonlyArray<{ key: string; type: string; multiple: boolean }>) {
  const relationId = (item: unknown): unknown => item && typeof item === "object" && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : item;
  const values: Record<string, unknown> = Object.fromEntries(fields.flatMap((field) => {
    if (!Object.hasOwn(record.values, field.key)) return [];
    const value = record.values[field.key];
    return [[field.key, field.type === "relation" ? (field.multiple && Array.isArray(value) ? value.map(relationId) : relationId(value)) : value]];
  }));
  return { id: record.id, typeKey: record.typeKey, title: record.title, slug: record.slug, status: record.status, excerpt: record.excerpt, order: record.order, values, terms: Object.fromEntries(Object.entries(record.terms).map(([key, terms]) => [key, terms.map((term) => term.alias)])), expectedHead: record.headRevision };
}

interface TranslationRow { translation_id: string; source_id: string; kind: CmsTranslationKind; language: string; mode: CmsTranslationMode; source_hash: string; created_at: string; updated_at: string }

function translationFromRow(row: TranslationRow): CmsTranslationLink {
  return { translationId: row.translation_id, sourceId: row.source_id, kind: row.kind, language: row.language, mode: row.mode, sourceHash: row.source_hash, createdAt: row.created_at, updatedAt: row.updated_at };
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** The local styles, query preset or query source that a remote entity with another id would overwrite. */
function keyAddressedTwin(localEntities: StaticPageProfile["entities"], remote: StaticPageProfile["entities"][number]): StaticPageProfile["entities"][number] | undefined {
  const keyOf = (entity: StaticPageProfile["entities"][number]): string | null => {
    if (entity.kind === "styles") return "styles";
    if (entity.kind === "query-preset") return typeof entity.payload.key === "string" ? `preset:${entity.payload.key}` : null;
    if (entity.kind === "query-source") return typeof entity.payload.name === "string" ? `source:${entity.payload.name}` : null;
    return null;
  };
  const key = keyOf(remote);
  return key === null ? undefined : localEntities.find((entity) => entity.id !== remote.id && keyOf(entity) === key);
}

function slugify(value: string): string {
  const result = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63).replace(/-+$/u, "");
  return result || "pagina";
}

/** A post slug: the page slug grammar, up to 200 characters as WordPress allows. */
function slugifyPost(value: string): string {
  const result = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 200).replace(/-+$/u, "");
  return result || "articolo";
}

function entityFromRow(row: EntityRow): CmsEntity {
  return { id: row.id, kind: row.kind, alias: row.alias, slug: row.slug, title: row.title, status: row.status, headRevision: row.head_revision, templateRef: row.template_ref ?? null, documentType: row.document_type ?? "page", publishedAt: row.published_at ?? null, excerpt: row.excerpt ?? "", imageAssetId: row.image_asset_id ?? null, locale: row.locale ?? null, updatedAt: row.updated_at };
}

function revisionFromRow(row: RevisionRow): CmsRevision {
  return { id: row.id, entityId: row.entity_id, parentId: row.parent_id, createdAt: row.created_at, content: row.content, contentHash: row.content_hash, source: row.source };
}

function conflictFromRow(row: ConflictRow): CmsConflict {
  return { id: row.id, entityId: row.entity_id, expectedHead: row.expected_head, actualHead: row.actual_head, proposedContent: row.proposed_content, proposedHash: row.proposed_hash, createdAt: row.created_at };
}

function validateComponentSchema(value: unknown): CmsComponentSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Schema del componente non valido.");
  const raw = value as { props?: unknown };
  if (!raw.props || typeof raw.props !== "object" || Array.isArray(raw.props)) throw new TypeError("Lo schema del componente deve contenere props.");
  const entries = Object.entries(raw.props as Record<string, unknown>);
  if (entries.length > 64) throw new RangeError("Un componente può avere al massimo 64 props.");
  const allowedTypes = new Set(["string", "number", "boolean", "url", "image", "rich-text", "enum", "array", "object"]);
  const props: CmsComponentSchema["props"] = Object.create(null) as CmsComponentSchema["props"];
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) || ["__proto__", "prototype", "constructor"].includes(name) || !value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Definizione della prop ${name} non valida.`);
    const definition = value as Record<string, unknown>;
    if (typeof definition.type !== "string" || !allowedTypes.has(definition.type)) throw new TypeError(`Tipo della prop ${name} non supportato.`);
    const next: CmsComponentPropDefinition = { type: definition.type };
    if (definition.default !== undefined) {
      const valid = isComponentJsonValue(definition.default) && (definition.type === "array" ? Array.isArray(definition.default)
        : definition.type === "object" ? !!definition.default && typeof definition.default === "object" && !Array.isArray(definition.default)
          : definition.default === null || (definition.type === "number" ? typeof definition.default === "number" && Number.isFinite(definition.default)
            : definition.type === "boolean" ? typeof definition.default === "boolean" : typeof definition.default === "string"));
      if (!valid) throw new TypeError(`Valore predefinito della prop ${name} non corrisponde al tipo ${definition.type}.`);
      next.default = definition.default as CmsComponentJsonValue;
    }
    if (definition.label !== undefined) {
      if (typeof definition.label !== "string" || definition.label.length > 120) throw new TypeError(`Etichetta della prop ${name} non valida.`);
      next.label = definition.label;
    }
    if (definition.options !== undefined) {
      if (!Array.isArray(definition.options) || definition.options.length > 100 || definition.options.some((option) => typeof option !== "string" || option.length > 200)) throw new TypeError(`Opzioni della prop ${name} non valide.`);
      next.options = definition.options as string[];
    }
    if (definition.type === "enum" && (!next.options || next.options.length === 0)) throw new TypeError(`La prop enum ${name} deve dichiarare almeno un’opzione.`);
    if (definition.type === "enum" && typeof next.default === "string" && !next.options?.includes(next.default)) throw new TypeError(`Il valore predefinito della prop ${name} non è tra le opzioni ammesse.`);
    props[name] = next;
  }
  return { props };
}

function isComponentJsonValue(value: unknown, depth = 0): value is CmsComponentJsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every((item) => isComponentJsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 1000 && entries.every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && isComponentJsonValue(item, depth + 1));
}

function componentFromRows(component: ComponentRow, revision: ComponentRevisionRow): CmsComponent {
  return {
    id: component.id,
    alias: component.alias,
    kind: component.kind ?? "component",
    partArea: component.kind === "template-part" ? component.part_area ?? "uncategorized" : null,
    ref: component.ref,
    title: component.title,
    role: component.kind === "template" ? component.template_role ?? null : null,
    schema: validateComponentSchema(JSON.parse(revision.schema_json) as unknown),
    content: revision.content,
    headRevision: revision.id,
    contentHash: revision.content_hash,
    updatedAt: component.updated_at,
  };
}

function starterDocument(title: string): string {
  const ids = [randomUUID().replaceAll("-", "").slice(0, 10), randomUUID().replaceAll("-", "").slice(0, 10), randomUUID().replaceAll("-", "").slice(0, 10)];
  // The title is plain text: the text block reads inline HTML, so markup characters are escaped.
  const text = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapedTitle = JSON.stringify(text).replaceAll("--", "\\u002d\\u002d");
  return `<!-- wp:xb/element {"uid":"${ids[0]}","tag":"main"} --><!-- wp:xb/element {"uid":"${ids[1]}","tag":"h1"} --><!-- wp:xb/text {"uid":"${ids[2]}","content":${escapedTitle}} /--><!-- /wp:xb/element --><!-- /wp:xb/element -->`;
}

function templateStarterDocument(): string {
  return serializeXb(parse("<main>{@slot}</main>").blocks);
}

function hasDefaultSlot(content: string): boolean {
  const visit = (blocks: ReturnType<typeof parseXb>["blocks"]): boolean => blocks.some((block) =>
    (block.name === "xb/slot" && block.attrs.name === "default") ||
    ("children" in block && block.name !== "xb/component" && visit(block.children)));
  return visit(parseXb(content).blocks);
}

/** Import reports a project keeps (doc 18 §9), and the size of each. */
export const IMPORT_REPORTS_MAX = 20;
export const IMPORT_REPORT_MAX_BYTES = 1024 * 1024;

function assertDocumentContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) throw new RangeError("Il documento supera il limite di 8 MiB.");
  if (content.includes("\0")) throw new TypeError("Il documento non può contenere byte NUL.");
}

function restoreCmsMediaReferences(content: string, projectId: string): string {
  const parsed = parseXb(content);
  const local = (url: string): string => {
    const match = /^histos-media:\/\/([0-9a-f-]{36})$/iu.exec(url);
    return match?.[1] ? `/__cms-media/${projectId}/${match[1].toLowerCase()}` : url;
  };
  const visit = (block: (typeof parsed.blocks)[number]): void => {
    if (block.name === "xb/element" && block.attrs.attributes) {
      const source = block.attrs.attributes.src;
      if (typeof source === "string") block.attrs.attributes.src = local(source);
      const href = block.attrs.attributes.href;
      if (block.attrs.tag === "a" && typeof href === "string") block.attrs.attributes.href = local(href);
      // Each srcset candidate is a media identity of its own; descriptors stay as they are.
      const srcset = block.attrs.attributes.srcset;
      const candidates = typeof srcset === "string" && (block.attrs.tag === "img" || block.attrs.tag === "source") ? parseTransferSrcset(srcset) : null;
      if (candidates) block.attrs.attributes.srcset = formatTransferSrcset(candidates.map((candidate) => ({ ...candidate, url: local(candidate.url) })));
    }
    if (block.name === "xb/component") for (const [name, value] of Object.entries(block.attrs.props ?? {})) if (typeof value === "string") block.attrs.props![name] = local(value);
    if ("children" in block) for (const child of block.children) visit(child);
  };
  for (const block of parsed.blocks) visit(block);
  return serializeXb(parsed.blocks);
}

/** The store input of a post entity the contract validator already accepted. */
function transferPostInput(entity: TransferEntity, projectId: string): { title: string; slug: string; content: string; status: "draft" | "published"; publishedAt: string | null; excerpt: string; imageAssetId: string | null; terms: Record<string, string[]>; templateRef: string | null } {
  const payload = entity.payload;
  if (payload.documentType !== "post" || typeof payload.title !== "string" || typeof payload.slug !== "string" || !POST_SLUG.test(payload.slug) || payload.slug.length > 200 || typeof payload.content !== "string" || (payload.status !== "draft" && payload.status !== "published") || typeof payload.excerpt !== "string" || !payload.terms || typeof payload.terms !== "object" || Array.isArray(payload.terms)) throw new TypeError(`Articolo non valido: ${entity.id}.`);
  const terms: Record<string, string[]> = {};
  for (const [taxonomyKey, ids] of Object.entries(payload.terms)) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new TypeError(`Termini non validi nell'articolo ${entity.id}.`);
    terms[taxonomyKey] = ids as string[];
  }
  return {
    title: payload.title, slug: payload.slug, content: restoreCmsMediaReferences(payload.content, projectId), status: payload.status,
    publishedAt: typeof payload.publishedAt === "string" ? payload.publishedAt : null, excerpt: payload.excerpt,
    // Doc 23 item 119: the key is written only when the post has an image; without it the post has none.
    imageAssetId: typeof payload.image === "string" ? payload.image : null, terms,
    templateRef: typeof payload.templateRef === "string" ? payload.templateRef : null,
  };
}

/**
 * The components and parts of a profile, each after the ones it calls among them (callees first), otherwise in the
 * order given. A profile lists its entities by id, and the store refuses a component created or saved before a new one
 * it calls («richiama …, che non esiste»): a prototype or a project whose components call each other was refused by its
 * own import whenever a caller's id came first. Those on a cycle keep the order of the walk, and the store refuses the
 * cycle. Depth first without recursion, so a long chain needs no stack; `payload.ref` and `payload.content` are strings
 * (the callers check them first).
 */
function calleesFirst<T extends { payload: Record<string, unknown> }>(items: readonly T[]): T[] {
  const byRef = new Map<string, number>();
  items.forEach((item, index) => { if (!byRef.has(String(item.payload.ref))) byRef.set(String(item.payload.ref), index); });
  const { order } = callOrder(items.length, (index) => componentCalls(String(items[index]!.payload.content))
    .map((ref) => byRef.get(ref)).filter((callee): callee is number => callee !== undefined && callee !== index));
  return order.map((index) => items[index]!);
}

/**
 * A depth-first walk of `count` nodes that call each other (`calls`), without recursion, each node read once: the
 * order in which the walk leaves them (each after the ones it calls, in the order given otherwise) and the first cycle
 * it meets, the nodes on it in call order (null: none).
 */
function callOrder(count: number, calls: (index: number) => number[]): { order: number[]; cycle: number[] | null } {
  /** 0: not reached yet, 1: on the walk, 2: left. */
  const state = new Uint8Array(count);
  const order: number[] = [];
  let cycle: number[] | null = null;
  for (let start = 0; start < count; start++) {
    if (state[start] !== 0) continue;
    state[start] = 1;
    const walk: Array<{ index: number; calls: number[]; next: number }> = [{ index: start, calls: calls(start), next: 0 }];
    while (walk.length > 0) {
      const top = walk.at(-1)!;
      const callee = top.calls[top.next++];
      if (callee === undefined) {
        walk.pop();
        state[top.index] = 2;
        order.push(top.index);
      } else if (state[callee] === 0) {
        state[callee] = 1;
        walk.push({ index: callee, calls: calls(callee), next: 0 });
      } else if (state[callee] === 1 && cycle === null) {
        cycle = walk.slice(walk.findIndex((step) => step.index === callee)).map((step) => step.index);
      }
    }
  }
  return { order, cycle };
}

/**
 * The live components and parts of a backup's database call each other without a cycle, as every save of the app
 * keeps them (CmsProjectStore.assertComponentGraphAcyclic). A restore writes them without saving them, so it checks
 * them here; and every backup the app saves passes the same check, so it is never one its restore refuses. A call to
 * a component that is not there, or deleted, is no edge, as in the app. Each component is read once, by componentCalls.
 * Databases of older versions may lack the kinds (all components then) or the deletions.
 *
 * Calls are matched on the whole ref, which has no length limit (COMPONENT_REF_PATTERN): only the message shortens the
 * refs it shows (shownRef). Before, refs were cut to 128 characters and the calls looked up whole, so a cycle among
 * components with longer refs was no cycle here, and a crafted backup brought one back. A ref names one live component
 * in the app's databases (the column is UNIQUE); should a backup's name more, a call is an edge to each of them.
 *
 * `purpose` says who reads the refusal of a cycle. The backup of a project (`backup`) is refused to its user, who can
 * break the cycle in the builder. A restore (`restore`) has no project to open: nothing was created, and what the user
 * can do is restore another backup (one an older version of the app saved, before a restore checked this, may hold a
 * cycle).
 */
function assertBackupComponentsAcyclic(database: DatabaseSync, tables: ReadonlySet<string>, purpose: BackupCheckPurpose): void {
  if (!tables.has("cms_components") || !tables.has("cms_component_revisions")) return;
  const columns = new Set((database.prepare("PRAGMA table_info(cms_components)").all() as Array<{ name: string }>).map((column) => column.name));
  const deletions = tables.has("transfer_tombstones");
  const rows = database.prepare(`SELECT c.ref, r.content FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision ${deletions ? "LEFT JOIN transfer_tombstones t ON t.id = c.id" : ""} WHERE ${columns.has("kind") ? "c.kind IN ('component', 'template-part')" : "1"} ${deletions ? "AND t.id IS NULL" : ""}`).all() as Array<{ ref: unknown; content: unknown }>;
  const byRef = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (typeof row.ref !== "string") return;
    const named = byRef.get(row.ref);
    if (named) named.push(index);
    else byRef.set(row.ref, [index]);
  });
  const { cycle } = callOrder(rows.length, (index) => {
    let called: string[];
    try { called = componentCalls(String(rows[index]!.content)); }
    catch { throw new TypeError(`Il database del backup contiene un componente che non si legge: ${shownRef(String(rows[index]!.ref))}.`); }
    return called.flatMap((ref) => byRef.get(ref) ?? []);
  });
  if (cycle === null) return;
  const names = [...cycle, cycle[0]!].map((index) => shownRef(String(rows[index]!.ref)));
  const shown = (names.length > 8 ? [...names.slice(0, 4), "…", ...names.slice(-3)] : names).join(" → ");
  if (purpose === "restore") throw new TypeError(`Il backup non si può ripristinare: il suo database contiene componenti che si richiamano in un ciclo (${shown}), e i componenti Histeon non possono richiamarsi in modo ricorsivo. Non è stato creato nessun progetto. Ripristina un altro backup di questo progetto, se ne hai uno (per esempio uno più vecchio).`);
  throw new TypeError(`Il database del backup contiene componenti che si richiamano in un ciclo (${shown}): i componenti Histeon non possono richiamarsi in modo ricorsivo. Togli uno di questi richiami nel builder.`);
}

/** Who checks a backup's database (validateBackupDatabase): the app saving a backup of a project, or a restore. */
type BackupCheckPurpose = "backup" | "restore";

/** A component's ref as a message shows it: at most 128 characters, then «…» (a ref has no length limit). */
function shownRef(ref: string): string {
  return ref.length > 128 ? `${ref.slice(0, 128)}…` : ref;
}

function assertStaticPageProfileBlocks(profile: StaticPageProfile): void {
  for (const entity of profile.entities) {
    if (entity.kind === "tombstone") continue;
    if (entity.kind !== "document" && entity.kind !== "component" && entity.kind !== "template-part" && entity.kind !== "template") continue;
    if (typeof entity.payload.content !== "string") throw new TypeError(`Contenuto mancante nel documento ${entity.id}.`);
    const visit = (blocks: ReturnType<typeof parseXb>["blocks"]): void => {
      for (const block of blocks) {
        // A block of WordPress in an article stays whole: the build prints it cleaned, and it goes back only unchanged.
        if (block.name === "xb/passthrough" && entity.kind === "document") continue;
        if (!new Set(["xb/element", "xb/text", "xb/component", "xb/if", "xb/branch", "xb/loop", "xb/slot", "xb/slot-fill"]).has(block.name)) throw new TypeError(`Il profilo statico non importa il blocco ${block.name}; il progetto non è stato modificato.`);
        if ("children" in block) visit(block.children);
      }
    };
    visit(parseXb(entity.payload.content).blocks);
  }
}

/**
 * How a catalog, and every store it opens, writes. `durable` (the default) flushes each media file to disk before it
 * is renamed into place, so that after a crash the database never names a media file that lost its bytes: what the
 * user's own projects need. A scratch catalog (the build, verify and comparison copies of a prototype check, the
 * build of a prototype import, the proposals) is removed right after use, and a crash leaves nothing of it to read
 * again, so it passes `durable: false` and skips the flushes: a check of a prototype with 500 images made 1,000 of
 * them, synchronously on the server's event loop, for files thrown away a moment later.
 */
export interface CmsProjectCatalogOptions {
  durable?: boolean;
  /**
   * How a project's database opens (project-database.ts): `node:sqlite` unless given. Doc 18 F6 opens it in memory
   * with SQLite for WebAssembly, in the browser.
   */
  openDatabase?: ProjectDatabaseOpener;
  /** Where media bytes live instead of the project's `media` folder (doc 18 F6, in memory in the browser). */
  mediaFiles?: ProjectMediaFiles;
}

/**
 * The components and parts the graph checks of one write transaction read before an index of the calls (graphIndex)
 * may be built: below it a check reads what it reaches, as a single save does.
 */
const GRAPH_INDEX_MIN_WALKED = 256;

/**
 * The live components and parts of the project by the refs they call (`callers`), and the refs each of them calls
 * (`calls`, to take its old calls away when it changes). Templates are not in it: nothing calls them.
 */
interface ComponentCallIndex {
  callers: Map<string, Set<string>>;
  calls: Map<string, string[]>;
}

/**
 * The refs a document calls, each time it calls one, in document order (depth first, without recursion): the refs of
 * the xb/component blocks of parseXb(content), and its errors, exactly. Most documents are read by scanComponentCalls,
 * which gives the same refs without building the tree parseXb builds (about a quarter of the time: the graph checks and
 * the check of every backup the app saves read every component); the others by parseXb itself. A backup of 2,000
 * components of 7 KB, each calling the one before, took 420 ms with the event loop held up to 230 ms; now 285 ms and
 * 85 ms.
 */
export function componentCalls(content: string): string[] {
  const scanned = scanComponentCalls(content);
  if (scanned) return scanned;
  const refs: string[] = [];
  const pending = [...parseXb(content).blocks].reverse();
  for (let block = pending.pop(); block !== undefined; block = pending.pop()) {
    if (block.name === "xb/component") refs.push(block.attrs.ref);
    if ("children" in block) for (let index = block.children.length - 1; index >= 0; index--) pending.push(block.children[index]!);
  }
  return refs;
}

/**
 * The block delimiters of the WordPress block grammar, as parseXb reads them: the `tokenizer` of parse() in
 * @wordpress/block-serialization-default-parser 5.57.0, the version package.json pins (a test checks the installed copy
 * against this one). Groups: 1 closer, 2 namespace with its slash, 3 name, 4 attributes (JSON), 6 void.
 */
// biome-ignore lint/correctness/noEmptyCharacterClassInRegex: `[^]` (any character) as the parser writes it, kept identical.
const BLOCK_DELIMITER = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:(?=([^}]+|}+(?=})|(?!}\s+\/?-->)[^])*)\5|[^]*?)}\s+)?(\/)?-->/g;

/**
 * The xb blocks (by name, without "xb/") scanComponentCalls reads. parseXb converts each of them field by field, and
 * nothing in that throws; it keeps any other block (xb/passthrough, an xb block it does not know, a block of another
 * namespace) as WordPress markup, serialized again by a recursion over its inner blocks and JSON.stringify of their
 * attributes, both of which can overflow the stack on a crafted document.
 */
const CALL_SCAN_BLOCKS = new Set(["element", "text", "if", "branch", "loop", "component", "slot", "slot-fill", "raw", "post-content"]);

/**
 * The blocks scanComponentCalls reads at most one inside the other: half of the depth past which parseXb refuses a
 * document (MAX_NESTING, 128 levels of its conversion, one more than the blocks: an empty list of children counts).
 */
const CALL_SCAN_MAX_DEPTH = 64;

/**
 * Of the blocks each xb block parseXb converts with children keeps (CALL_SCAN_BLOCKS): all of them, or only those of
 * one name (an xb/if keeps its branches, an xb/component its slot fills). The others keep none. An xb/loop keeps all
 * of them but its branches: only its `{:else}`, a last branch without a test (callScanKept).
 */
const CALL_SCAN_CHILDREN = new Map<string, string | null>([["element", null], ["branch", null], ["loop", null], ["slot-fill", null], ["if", "branch"], ["component", "slot-fill"]]);

interface CallScanBlock { name: string; ref: string; tested: boolean; children: CallScanBlock[] }

/** Whether parseXb keeps this child of `parent` (CALL_SCAN_CHILDREN; in a loop, a branch only as its last test-less child). */
function callScanKept(parent: CallScanBlock, child: CallScanBlock, index: number): boolean {
  const kept = CALL_SCAN_CHILDREN.get(parent.name);
  if (kept === undefined) return false;
  if (kept !== null) return child.name === kept;
  if (parent.name === "loop" && child.name === "branch") return index === parent.children.length - 1 && !child.tested;
  return true;
}

/**
 * componentCalls without parseXb, or null when the document is one parseXb must read itself. The delimiters are read
 * as the WordPress parser reads them (BLOCK_DELIMITER, from the start, and stopping where it stops), into the same tree
 * of blocks: a void block or a closer adds a block to the one open around it, or to the top level; a closer ends the
 * innermost open block whatever it names, and with none open the parser reads the rest as HTML and stops; at the end,
 * blocks still open go to the top level, the innermost first. Only the names and the ref of an xb/component are kept:
 * the ref parseXb gives it (its attributes as JSON, "" when they are not an object with a valid ref). HTML between
 * blocks calls nothing. The refs are then those parseXb's tree holds, in the same order, and parseXb could not have
 * thrown: a document with a block it keeps as markup (CALL_SCAN_BLOCKS), or deeper than CALL_SCAN_MAX_DEPTH, is left to
 * it, so a refusal stays its own. The delimiters read are the same, so an error of the expression itself would be too.
 */
export function scanComponentCalls(content: string): string[] | null {
  const delimiter = new RegExp(BLOCK_DELIMITER);
  const top: CallScanBlock[] = [];
  const open: CallScanBlock[] = [];
  for (let match = delimiter.exec(content); match !== null; match = delimiter.exec(content)) {
    const [, closer, namespace, name, attributes, , isVoid] = match;
    if (closer && !isVoid) {
      const ended = open.pop();
      if (!ended) break;
      (open.at(-1)?.children ?? top).push(ended);
      continue;
    }
    if (namespace !== "xb/" || !CALL_SCAN_BLOCKS.has(name!) || open.length >= CALL_SCAN_MAX_DEPTH) return null;
    const block: CallScanBlock = { name: name!, ref: name === "component" ? calledRef(attributes) : "", tested: name === "branch" && branchTested(attributes), children: [] };
    if (isVoid) (open.at(-1)?.children ?? top).push(block);
    else open.push(block);
  }
  for (let block = open.pop(); block !== undefined; block = open.pop()) top.push(block);
  const refs: string[] = [];
  const pending = top.reverse();
  for (let block = pending.pop(); block !== undefined; block = pending.pop()) {
    if (block.name === "component") refs.push(block.ref);
    for (let index = block.children.length - 1; index >= 0; index--) {
      const child = block.children[index]!;
      if (callScanKept(block, child, index)) pending.push(child);
    }
  }
  return refs;
}

/** The attributes of a delimiter as parseXb reads them: the object of its JSON, or {} for none, invalid or not an object. */
function delimiterAttributes(attributes: string | undefined): Record<string, unknown> {
  let parsed: unknown = {};
  if (attributes) {
    try { parsed = JSON.parse(attributes) as unknown; }
    catch { parsed = null; }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** The ref parseXb gives an xb/component with these attributes (the JSON of its delimiter, if any): "" for none valid. */
function calledRef(attributes: string | undefined): string {
  const ref = delimiterAttributes(attributes).ref;
  return typeof ref === "string" && COMPONENT_REF_PATTERN.test(ref) ? ref : "";
}

/** Whether parseXb gives an xb/branch with these attributes a test (a string `test`): one with a test is no `{:else}`. */
function branchTested(attributes: string | undefined): boolean {
  return typeof delimiterAttributes(attributes).test === "string";
}

export class CmsProjectStore implements Repository {
  readonly project: CmsProject;
  readonly directory: string;
  readonly mediaDirectory: string;
  readonly content: CmsContentModel;
  private readonly database: DatabaseSync;
  /** Media bytes kept elsewhere than the `media` folder (CmsProjectCatalogOptions.mediaFiles), or null. */
  private readonly mediaFiles: ProjectMediaFiles | null;
  /** Whether media files are flushed to disk before they are renamed into place (CmsProjectCatalogOptions). */
  private readonly durable: boolean;
  private transactionDepth = 0;
  /**
   * Inside one write transaction only: the calls of the live components (ComponentCallIndex), once the graph checks of
   * the transaction have read as many components as the project has (`graphWalked`, against `graphIndexAt`), so that
   * from then on it costs less than reading them again. assertComponentGraphAcyclic keeps it up to date as each
   * component is created or saved; anything else that changes which calls are live (a deletion, a restore, a part of
   * the transaction undone) drops it, and the transaction's end too. It is sound only while this connection holds the
   * write lock (BEGIN IMMEDIATE: no other connection writes in the meantime), so it never outlives the transaction.
   */
  private graphIndex: ComponentCallIndex | null = null;
  private graphWalked = 0;
  private graphIndexAt = GRAPH_INDEX_MIN_WALKED;

  constructor(project: CmsProject, options: CmsProjectCatalogOptions = {}) {
    this.project = project;
    this.directory = project.directory;
    this.mediaDirectory = path.join(project.directory, "media");
    this.durable = options.durable ?? true;
    this.database = (options.openDatabase ?? openNodeProjectDatabase)(path.join(project.directory, "content.sqlite"));
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const versionRow = this.database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const schemaVersion = Number(versionRow?.user_version ?? 0);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > CMS_DATABASE_SCHEMA_VERSION) {
      this.database.close();
      throw new TypeError("La versione dello schema SQLite non è supportata da questa versione di Histeon Publish.");
    }
    const existingTables = this.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number };
    if (schemaVersion < CMS_DATABASE_SCHEMA_VERSION && existingTables.count > 0) {
      try { preserveSchemaMigrationSnapshot(this.database, project.directory, schemaVersion, CMS_DATABASE_SCHEMA_VERSION); }
      catch (error) { this.database.close(); throw error; }
    }
    if (schemaVersion < CMS_DATABASE_SCHEMA_VERSION) this.migrate();
    this.content = new CmsContentModel(this.database);
    this.mediaFiles = options.mediaFiles ?? null;
    if (this.mediaFiles) return;
    // Made where there is none. Anything else there (a symlink, a file) stays as it is and the project still opens:
    // every read and write of media then refuses it with MEDIA_FOLDER_NOT_REAL. Before, a symlink to a missing folder,
    // or a file, made the whole project unavailable («errore di lettura»), while a symlink to a folder was followed.
    if (!lstatSync(this.mediaDirectory, { throwIfNoEntry: false })) {
      try { mkdirSync(this.mediaDirectory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }

  /** Brings the schema to CMS_DATABASE_SCHEMA_VERSION in one transaction, then checks integrity. */
  private migrate(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('page', 'styles')),
        alias INTEGER NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
        head_revision TEXT NOT NULL,
        template_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        parent_id TEXT REFERENCES revisions(id),
        created_at TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('editor', 'import', 'conflict-resolution'))
      );
      CREATE INDEX IF NOT EXISTS revisions_entity_created ON revisions(entity_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        expected_head TEXT,
        actual_head TEXT NOT NULL,
        proposed_content TEXT NOT NULL,
        proposed_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_revision TEXT REFERENCES revisions(id)
      );
      CREATE INDEX IF NOT EXISTS conflicts_entity_open ON conflicts(entity_id, resolved_at);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        alias INTEGER NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        alt TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assets_hash ON assets(sha256);
      CREATE TABLE IF NOT EXISTS sync_bases (
        remote_site_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        remote_project_id TEXT NOT NULL,
        base_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(remote_site_id, entity_id)
      );
      CREATE TABLE IF NOT EXISTS transfer_tombstones (
        id TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        entity_json TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'remote' CHECK(scope IN ('remote', 'local'))
      );
      CREATE TABLE IF NOT EXISTS cms_import_reports (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cms_document_scripts (
        owner_id TEXT PRIMARY KEY,
        script TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cms_components (
        id TEXT PRIMARY KEY,
        alias INTEGER NOT NULL UNIQUE CHECK(alias >= 1000000000),
        kind TEXT NOT NULL DEFAULT 'component' CHECK(kind IN ('component', 'template-part', 'template')),
        part_area TEXT NOT NULL DEFAULT 'uncategorized' CHECK(part_area IN ('header', 'footer', 'uncategorized')),
        ref TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        head_revision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cms_component_revisions (
        id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL REFERENCES cms_components(id),
        parent_id TEXT REFERENCES cms_component_revisions(id),
        created_at TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        schema_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cms_component_revisions_created ON cms_component_revisions(component_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS cms_component_conflicts (
        id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL REFERENCES cms_components(id),
        expected_head TEXT,
        actual_head TEXT NOT NULL,
        proposed_content TEXT NOT NULL,
        proposed_ref TEXT NOT NULL,
        proposed_schema_json TEXT NOT NULL,
        proposed_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_revision TEXT REFERENCES cms_component_revisions(id)
      );
      CREATE INDEX IF NOT EXISTS cms_component_conflicts_open ON cms_component_conflicts(component_id, resolved_at);
    `);
    const entityColumns = this.database.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    if (!entityColumns.some((column) => column.name === "status")) this.database.exec("ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published'))");
    if (!entityColumns.some((column) => column.name === "template_ref")) this.database.exec("ALTER TABLE entities ADD COLUMN template_ref TEXT");
    if (!entityColumns.some((column) => column.name === "document_type")) this.database.exec("ALTER TABLE entities ADD COLUMN document_type TEXT NOT NULL DEFAULT 'page' CHECK(document_type IN ('page', 'post'))");
    if (!entityColumns.some((column) => column.name === "locale")) this.database.exec("ALTER TABLE entities ADD COLUMN locale TEXT");
    if (!entityColumns.some((column) => column.name === "published_at")) this.database.exec("ALTER TABLE entities ADD COLUMN published_at TEXT");
    if (!entityColumns.some((column) => column.name === "excerpt")) this.database.exec("ALTER TABLE entities ADD COLUMN excerpt TEXT NOT NULL DEFAULT ''");
    if (!entityColumns.some((column) => column.name === "image_asset_id")) this.database.exec("ALTER TABLE entities ADD COLUMN image_asset_id TEXT");
    const tombstoneColumns = this.database.prepare("PRAGMA table_info(transfer_tombstones)").all() as Array<{ name: string }>;
    if (!tombstoneColumns.some((column) => column.name === "scope")) this.database.exec("ALTER TABLE transfer_tombstones ADD COLUMN scope TEXT NOT NULL DEFAULT 'remote' CHECK(scope IN ('remote', 'local'))");
    const componentColumns = this.database.prepare("PRAGMA table_info(cms_components)").all() as Array<{ name: string }>;
    if (!componentColumns.some((column) => column.name === "kind")) this.database.exec("ALTER TABLE cms_components ADD COLUMN kind TEXT NOT NULL DEFAULT 'component' CHECK(kind IN ('component', 'template-part', 'template'))");
    if (!componentColumns.some((column) => column.name === "part_area")) this.database.exec("ALTER TABLE cms_components ADD COLUMN part_area TEXT NOT NULL DEFAULT 'uncategorized' CHECK(part_area IN ('header', 'footer', 'uncategorized'))");
    if (!componentColumns.some((column) => column.name === "template_role")) this.database.exec(`ALTER TABLE cms_components ADD COLUMN template_role TEXT CHECK(template_role IS NULL OR (kind = 'template' AND template_role IN (${TEMPLATE_ROLES.map((role) => `'${role}'`).join(", ")})))`);
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS cms_components_template_role ON cms_components(template_role) WHERE template_role IS NOT NULL");
    const assetColumns = this.database.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
    if (!assetColumns.some((column) => column.name === "alias")) {
      this.database.exec("ALTER TABLE assets ADD COLUMN alias INTEGER");
      this.database.exec("UPDATE assets SET alias = (SELECT COUNT(*) FROM assets AS earlier WHERE earlier.rowid <= assets.rowid) WHERE alias IS NULL");
      this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS assets_alias ON assets(alias)");
    }
      CmsContentModel.migrate(this.database);
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS cms_post_terms(post_id TEXT NOT NULL REFERENCES entities(id), taxonomy_id TEXT NOT NULL REFERENCES cms_taxonomies(id), term_id TEXT NOT NULL REFERENCES cms_terms(id), ordinal INTEGER NOT NULL, PRIMARY KEY(post_id, term_id), UNIQUE(post_id, taxonomy_id, ordinal));
        CREATE INDEX IF NOT EXISTS cms_post_terms_term ON cms_post_terms(taxonomy_id, term_id, post_id);
        CREATE INDEX IF NOT EXISTS entities_document_locale ON entities(document_type, locale, slug);
        CREATE TABLE IF NOT EXISTS cms_translations(translation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('page','post','record')), language TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'follow' CHECK(mode IN ('follow','independent')), source_hash TEXT NOT NULL DEFAULT '', source_snapshot TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_id, language));
        CREATE INDEX IF NOT EXISTS cms_translations_language ON cms_translations(language, kind);
        CREATE TABLE IF NOT EXISTS cms_strings(source_hash TEXT NOT NULL, language TEXT NOT NULL, context TEXT NOT NULL, source TEXT NOT NULL, translation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')), updated_at TEXT NOT NULL, PRIMARY KEY(source_hash, language));
        CREATE TABLE IF NOT EXISTS cms_translation_memory(source_hash TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source_hash, language));
      `);
      this.database.exec(`PRAGMA user_version = ${CMS_DATABASE_SCHEMA_VERSION}`);
      const integrity = this.database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      const foreignKeyFailures = this.database.prepare("PRAGMA foreign_key_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || foreignKeyFailures.length > 0) {
        throw new TypeError("La verifica d'integrità SQLite non è riuscita dopo la migrazione.");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back the failed transaction. */ }
      this.database.close();
      throw error;
    }
  }

  /** Idempotent: a route that closes the store early (to delete the project) leaves its own finally harmless. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
  private closed = false;

  getProjectRevision(): string {
    const calculate = (): string => {
      const queries: Array<[string, string]> = [
        // The memory's reading mark changes on a read: it is no change to the project.
        // Nor is a proposal of the agent waiting for the writer (doc 23 item 94): it is not part of the site.
        ["project_meta", "SELECT key, value FROM project_meta WHERE key NOT LIKE 'memory.learned.%' AND key NOT LIKE 'proposal.%' ORDER BY key"],
        ["documents", "SELECT e.id, e.kind, e.alias, e.slug, e.title, e.status, e.head_revision, e.template_ref, e.document_type, e.published_at, e.excerpt, e.updated_at, r.content_hash FROM entities e LEFT JOIN revisions r ON r.id = e.head_revision ORDER BY e.id"],
        ["post_terms", "SELECT post_id, taxonomy_id, term_id, ordinal FROM cms_post_terms ORDER BY post_id, taxonomy_id, ordinal, term_id"],
        ["components", "SELECT c.id, c.alias, c.kind, c.part_area, c.template_role, c.ref, c.title, c.head_revision, c.updated_at, r.content_hash, r.schema_json FROM cms_components c LEFT JOIN cms_component_revisions r ON r.id = c.head_revision ORDER BY c.id"],
        ["assets", "SELECT id, alias, sha256, mime_type, filename, alt, caption, relative_path FROM assets ORDER BY id"],
        ["sync_bases", "SELECT remote_site_id, entity_id, remote_project_id, base_hash, updated_at FROM sync_bases ORDER BY remote_site_id, entity_id"],
        ["transfer_tombstones", "SELECT id, entity_kind, deleted_at, entity_json, scope FROM transfer_tombstones ORDER BY id"],
        ["document_conflicts", "SELECT id, entity_id, expected_head, actual_head, proposed_hash, created_at, resolved_at, resolution_revision FROM conflicts ORDER BY id"],
        ["component_conflicts", "SELECT id, component_id, expected_head, actual_head, proposed_hash, created_at, resolved_at, resolution_revision FROM cms_component_conflicts ORDER BY id"],
        ["identity_registry", "SELECT id, kind, created_at, deleted_at FROM cms_identity_registry ORDER BY id"],
        ["content_types", "SELECT t.id, t.key, t.label, t.single_template_ref, t.archive_template_ref, t.head_revision, t.updated_at, r.content_hash FROM cms_content_types t LEFT JOIN cms_type_revisions r ON r.id = t.head_revision ORDER BY t.id"],
        ["field_definitions", "SELECT id, type_id, key, label, field_type, required, is_public, multiple, config_json, ordinal FROM cms_field_defs ORDER BY type_id, ordinal, id"],
        ["records", "SELECT r.id, r.type_id, r.slug, r.locale, r.title, r.status, r.published_at, r.excerpt, r.order_no, r.parent_id, r.head_revision, r.updated_at, rev.content_hash FROM cms_records r LEFT JOIN cms_record_revisions rev ON rev.id = r.head_revision ORDER BY r.id"],
        ["field_values", "SELECT record_id, field_id, ordinal, text_value, number_value, bool_value, json_value, asset_id FROM cms_field_values ORDER BY record_id, field_id, ordinal"],
        ["record_relations", "SELECT record_id, field_id, target_id, ordinal FROM cms_record_relations ORDER BY record_id, field_id, ordinal, target_id"],
        ["content_conflicts", "SELECT id, entity_id, entity_kind, expected_head, actual_head, proposed_json, created_at, resolved_at FROM cms_content_conflicts ORDER BY id"],
        ["query_state", "SELECT s.id, s.head_revision, r.content_hash FROM cms_query_state s LEFT JOIN cms_query_revisions r ON r.id = s.head_revision ORDER BY s.id"],
        ["query_presets", "SELECT key, label, type_id, builtin_type, limit_no, limit_param, offset_no, offset_param, order_by, direction, filter_json, head_revision, updated_at FROM cms_query_presets ORDER BY key"],
        ["query_sources", "SELECT name, data_json, updated_at FROM cms_query_sources ORDER BY name"],
        ["taxonomies", "SELECT t.id, t.key, t.label, t.for_posts, t.head_revision, t.updated_at, r.content_hash FROM cms_taxonomies t LEFT JOIN cms_taxonomy_revisions r ON r.id = t.head_revision ORDER BY t.id"],
        ["taxonomy_types", "SELECT taxonomy_id, type_id FROM cms_taxonomy_types ORDER BY taxonomy_id, type_id"],
        ["terms", "SELECT t.id, t.taxonomy_id, t.slug, t.label, t.parent_id, t.head_revision, t.updated_at, r.content_hash FROM cms_terms t LEFT JOIN cms_term_revisions r ON r.id = t.head_revision ORDER BY t.id"],
        ["record_terms", "SELECT record_id, taxonomy_id, term_id, ordinal FROM cms_record_terms ORDER BY record_id, taxonomy_id, ordinal, term_id"],
      ];
      // Doc 18 §6.6: documents' JavaScript, only once there is some, so a project without scripts keeps its revision.
      if (this.database.prepare("SELECT 1 FROM cms_document_scripts LIMIT 1").get()) queries.push(["document_scripts", "SELECT owner_id, script FROM cms_document_scripts ORDER BY owner_id"]);
      // Doc 20: the same for what the languages add.
      if (this.database.prepare("SELECT 1 FROM entities WHERE locale IS NOT NULL LIMIT 1").get()) queries.push(["document_locales", "SELECT id, locale FROM entities WHERE locale IS NOT NULL ORDER BY id"]);
      if (this.database.prepare("SELECT 1 FROM cms_translations LIMIT 1").get()) queries.push(["translations", "SELECT translation_id, source_id, kind, language, mode, source_hash FROM cms_translations ORDER BY translation_id"]);
      if (this.database.prepare("SELECT 1 FROM cms_strings LIMIT 1").get()) queries.push(["strings", "SELECT source_hash, language, context, source, translation, status FROM cms_strings ORDER BY source_hash, language"]);
      const digest = createHash("sha256").update(`histos-project-v1\0${this.project.id}\0${this.project.name}\0`);
      for (const [name, query] of queries) {
        digest.update(name).update("\0");
        for (const row of this.database.prepare(query).all() as Array<Record<string, unknown>>) {
          digest.update(JSON.stringify(row)).update("\n");
        }
      }
      return digest.digest("hex");
    };
    if (this.transactionDepth > 0) return calculate();
    this.database.exec("BEGIN");
    try {
      const revision = calculate();
      this.database.exec("COMMIT");
      return revision;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original query error. */ }
      throw error;
    }
  }

  getRenderSettings(): CmsRenderSettings {
    const row = this.database.prepare("SELECT key, value FROM project_meta WHERE key IN ('render.locale', 'render.timeZone')").all() as Array<{ key: string; value: string }>;
    const values = new Map(row.map((item) => [item.key, item.value]));
    const defaults = defaultCmsRenderSettings();
    if (!values.has("render.locale") && !values.has("render.timeZone")) return defaults;
    return normalizeCmsRenderSettings({ locale: values.get("render.locale") ?? defaults.locale, timeZone: values.get("render.timeZone") ?? defaults.timeZone });
  }

  /** The shop the project sells through (commerce.ts): its WordPress site and currency, from project_meta. */
  getShopSettings(): CmsShopSettings {
    const rows = this.database.prepare("SELECT key, value FROM project_meta WHERE key IN ('shop.url', 'shop.currency')").all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    try {
      return normalizeShopSettings({ url: values.get("shop.url") ?? null, currency: values.get("shop.currency") ?? null });
    } catch {
      // A value written by an older or another tool: the shop is then unknown, never a broken build.
      return normalizeShopSettings(null);
    }
  }

  setShopSettings(value: unknown): CmsShopSettings {
    const settings = normalizeShopSettings(value);
    this.transaction(() => {
      const write = this.database.prepare("INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      const remove = this.database.prepare("DELETE FROM project_meta WHERE key = ?");
      if (settings.url === null) remove.run("shop.url");
      else write.run("shop.url", settings.url);
      write.run("shop.currency", settings.currency);
    });
    return settings;
  }

  mediaAsset(id: string): { id: string; alt: string; caption: string; filename: string } | null {
    return (this.database.prepare("SELECT a.id, a.alt, a.caption, a.filename FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE a.id = ? AND t.id IS NULL").get(id) as { id: string; alt: string; caption: string; filename: string } | undefined) ?? null;
  }

  commerceContext(): CmsCommerceContext {
    const assetRow = this.database.prepare("SELECT a.id, a.alt, a.caption, a.filename FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE a.id = ? AND t.id IS NULL");
    return {
      shop: this.getShopSettings(),
      defaultLocale: this.getRenderSettings().locale,
      asset: (id) => (assetRow.get(id) as { id: string; alt: string; caption: string; filename: string } | undefined) ?? null,
      termPath: (_taxonomyKey, term) => {
        const path = [term.slug];
        const seen = new Set([term.id]);
        let parentId = term.parentId;
        while (parentId && !seen.has(parentId) && path.length < 64) {
          seen.add(parentId);
          const parent = this.content.getTermById(parentId);
          if (!parent) break;
          path.unshift(parent.slug);
          parentId = parent.parentId;
        }
        return path;
      },
    };
  }

  setRenderSettings(value: unknown): CmsRenderSettings {
    const settings = normalizeCmsRenderSettings(value);
    // Its documents are written in that language with a folder of their own: the two would be one language twice.
    const { defaultLanguage, languages } = this.getProjectLanguages();
    if (languages.some((language) => language.code.toLowerCase() === settings.locale.toLowerCase())) throw new TypeError(`${settings.locale} è già un'altra lingua del progetto: toglila prima di farne la lingua del sito.`);
    // Documents follow the site's language, records keep theirs: with translations they would stop being the originals.
    if (languages.length && settings.locale.toLowerCase() !== defaultLanguage.code.toLowerCase() && this.contentLanguages().some((language) => language.toLowerCase() === defaultLanguage.code.toLowerCase())) throw new TypeError(`Ci sono record in ${defaultLanguage.code}: togli le altre lingue, o spostali, prima di cambiare la lingua del sito.`);
    this.transaction(() => {
      const write = this.database.prepare("INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      write.run("render.locale", settings.locale);
      write.run("render.timeZone", settings.timeZone);
    });
    return settings;
  }

  /** Whether the build makes the site searchable, with its own page at /cerca/. */
  getSiteSearch(): boolean {
    return (this.database.prepare("SELECT value FROM project_meta WHERE key = 'site.search'").get() as { value: string } | undefined)?.value === "1";
  }

  setSiteSearch(on: boolean): boolean {
    if (on) this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('site.search', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    else this.database.prepare("DELETE FROM project_meta WHERE key = 'site.search'").run();
    return on;
  }

  /** The site's public address (doc 20 §5.6), or null while the project does not know it. */
  getSiteUrl(): string | null {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = 'site.url'").get() as { value: string } | undefined;
    try { return normalizeSiteUrl(row?.value); } catch { return null; }
  }

  setSiteUrl(value: unknown): string | null {
    const url = normalizeSiteUrl(value);
    if (url === null) this.database.prepare("DELETE FROM project_meta WHERE key = 'site.url'").run();
    else this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('site.url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(url);
    return url;
  }

  /** The site's language and the others of the project (doc 20 §4.1). */
  getProjectLanguages(): CmsProjectLanguages {
    const defaultLocale = this.getRenderSettings().locale;
    const defaultLanguage = { code: defaultLocale, label: languageName(defaultLocale) };
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = 'languages'").get() as { value: string } | undefined;
    if (!row) return { defaultLanguage, languages: [] };
    try {
      return { defaultLanguage, languages: normalizeProjectLanguages(JSON.parse(row.value), defaultLocale) };
    } catch {
      // A value written by an older or another tool: no other language, never a broken build.
      return { defaultLanguage, languages: [] };
    }
  }

  /** Replaces the list. A language that still has contents stays: nothing is deleted by taking it off (doc 20 §4.1). */
  setProjectLanguages(value: unknown): CmsProjectLanguages {
    const languages = normalizeProjectLanguages(value, this.getRenderSettings().locale);
    const kept = new Set(languages.map((language) => language.code.toLowerCase()));
    const used = new Set(this.contentLanguages().map((language) => language.toLowerCase()));
    return this.transaction(() => {
      // Only what the list drops: a record in a language the project never listed stops nobody from adding another.
      for (const { code } of this.getProjectLanguages().languages) {
        if (!kept.has(code.toLowerCase()) && used.has(code.toLowerCase())) throw new TypeError(`La lingua ${code} ha ancora dei contenuti: spostali nel Cestino prima di toglierla.`);
      }
      this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('languages', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ languages }));
      return this.getProjectLanguages();
    });
  }

  /** Every language some live page, post or record is written in. */
  contentLanguages(): string[] {
    const documents = this.database.prepare("SELECT DISTINCT e.locale AS locale FROM entities e LEFT JOIN transfer_tombstones t ON t.id = e.id WHERE e.locale IS NOT NULL AND t.id IS NULL").all() as Array<{ locale: string }>;
    const records = this.database.prepare("SELECT DISTINCT r.locale AS locale FROM cms_records r JOIN cms_identity_registry identity ON identity.id = r.id AND identity.deleted_at IS NULL").all() as Array<{ locale: string }>;
    return [...new Set([...documents, ...records].map((row) => row.locale))].sort();
  }

  /** What a translation follows: the texts of a document or record, not its status or order (doc 20 §4.3). */
  translationSourceHash(id: string): string | null {
    const entity = this.getEntityById(id);
    if (entity) {
      const revision = this.getHead(id);
      return revision ? digest(JSON.stringify([entity.title, entity.excerpt, revision.contentHash])) : null;
    }
    const record = this.content.getRecordById(id);
    return record ? digest(JSON.stringify([record.title, record.excerpt, record.values])) : null;
  }

  /** Which props of a component hold words a page shows; a link or a variant is no text to translate. */
  private textPropOf(): (ref: string, name: string) => boolean {
    return (ref, name) => { const type = this.getComponentByRef(ref)?.schema.props[name]?.type; return type === "string" || type === "rich-text"; };
  }

  /** The kind and language of a live page, post or record, or null; `locale` null is the site's language. */
  private translatableContent(id: string): { kind: CmsTranslationKind; locale: string | null; updatedAt: string; status: string } | null {
    const entity = this.getEntityById(id);
    if (entity) return entity.kind === "page" ? { kind: entity.documentType === "post" ? "post" : "page", locale: entity.locale, updatedAt: entity.updatedAt, status: entity.status } : null;
    const record = this.content.getRecordById(id);
    if (!record) return null;
    const siteLanguage = record.locale.toLowerCase() === this.getRenderSettings().locale.toLowerCase();
    return { kind: "record", locale: siteLanguage ? null : record.locale, updatedAt: record.updatedAt, status: record.status };
  }

  /**
   * A new version of a page, post or record in `language`, always a draft (doc 20 §5.1). "copy" follows the original;
   * "empty" and "link" are independent: an empty page, or `linkId`, a content of the same kind moved to this language.
   */
  createTranslation(input: { sourceId: string; language: string; mode?: "copy" | "empty" | "link"; linkId?: string; slug?: string; title?: string }): CmsTranslationLink {
    const language = canonicalProjectLanguage(input.language);
    if (!this.getProjectLanguages().languages.some((item) => item.code === language)) throw new TypeError(`La lingua ${language} non è fra quelle del progetto.`);
    const source = this.translatableContent(input.sourceId);
    if (!source) throw new TypeError("L'originale non esiste.");
    if (source.locale !== null || this.getTranslation(input.sourceId)) throw new TypeError("Si traduce l'originale, nella lingua del sito: questa è già una traduzione.");
    const mode = input.mode ?? "copy";
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT translation_id FROM cms_translations WHERE source_id = ? AND language = ?").get(input.sourceId, language) as { translation_id: string } | undefined;
      if (existing) {
        if (this.translatableContent(existing.translation_id)) throw new TypeError(`La traduzione in ${language} esiste già.`);
        if (this.isTransferEntityDeleted(existing.translation_id) || this.content.isRecordDeleted(existing.translation_id)) throw new TypeError(`La traduzione in ${language} è nel Cestino: ripristinala o eliminala.`);
        this.database.prepare("DELETE FROM cms_translations WHERE translation_id = ?").run(existing.translation_id);
      }
      const translationId = mode === "link" ? this.linkedTranslation(input.linkId, input.sourceId, source.kind, language) : source.kind === "record" ? this.content.joinTransaction(() => this.recordTranslation(input, language, mode)) : this.documentTranslation(input, source.kind, language, mode);
      const now = new Date().toISOString();
      this.database.prepare("INSERT INTO cms_translations(translation_id, source_id, kind, language, mode, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(translationId, input.sourceId, source.kind, language, mode === "copy" ? "follow" : "independent", this.translationSourceHash(input.sourceId) ?? "", now, now);
      this.markAligned(translationId, input.sourceId);
      if (mode === "copy") this.learnTranslationMemory(language);
      if (mode === "copy") this.rebuildTranslation(this.getTranslation(translationId)!, this.contentSegments(input.sourceId), new Map());
      return this.getTranslation(translationId)!;
    });
  }

  /** The draft of a page or post in `language`, with its original's fields and, for a copy, its content and script. */
  private documentTranslation(input: { sourceId: string; slug?: string; title?: string }, kind: "page" | "post", language: string, mode: "copy" | "empty"): string {
    const source = this.getEntityById(input.sourceId)!;
    const fields = { title: input.title?.trim() || source.title, slug: input.slug?.trim() || source.slug, status: "draft" as const, templateRef: source.templateRef, locale: language, ...(mode === "copy" ? { content: this.getHead(source.id)!.content } : {}) };
    const created = kind === "post" ? this.createPost({ ...fields, excerpt: mode === "copy" ? source.excerpt : "", imageAssetId: source.imageAssetId, terms: this.getPostTermIds(source.id) }) : this.createPage(fields);
    if (mode === "copy") {
      const script = this.getDocumentScript(source.id);
      if (script) this.setDocumentScript(created.id, script);
    }
    return created.id;
  }

  private recordTranslation(input: { sourceId: string; slug?: string; title?: string }, language: string, mode: "copy" | "empty"): string {
    const source = this.content.getRecordById(input.sourceId)!;
    const type = this.content.getType(source.typeKey);
    if (!type) throw new TypeError(`Il tipo ${source.typeKey} non esiste.`);
    const written = recordWriteInput(source, type.fields);
    delete written.values.sku;
    const saved = this.content.saveRecord({ typeKey: source.typeKey, title: input.title?.trim() || source.title, slug: input.slug?.trim() || source.slug, locale: language, status: "draft", excerpt: mode === "copy" ? source.excerpt : "", order: source.order, ...(mode === "empty" ? {} : { values: written.values }), terms: written.terms, expectedHead: null });
    if (saved.status !== "saved") throw new TypeError("Non riesco a salvare la traduzione della voce.");
    return saved.record.id;
  }

  /** An existing content of the site's language becomes the version in `language`, with no change to its text. */
  private linkedTranslation(linkId: string | undefined, sourceId: string, kind: CmsTranslationKind, language: string): string {
    const linked = linkId ? this.translatableContent(linkId) : null;
    if (!linkId || !linked || linked.kind !== kind) throw new TypeError("Il contenuto da collegare non esiste o è di un altro tipo.");
    if (linkId === sourceId) throw new TypeError("Un contenuto non può essere la traduzione di sé stesso.");
    if (this.getTranslation(linkId) || this.database.prepare("SELECT 1 FROM cms_translations WHERE source_id = ? LIMIT 1").get(linkId)) throw new TypeError("Il contenuto da collegare è già legato a un altro.");
    if (kind === "record") {
      const record = this.content.getRecordById(linkId)!;
      if (record.locale.toLowerCase() !== language.toLowerCase()) throw new TypeError(`Il record da collegare deve essere già in ${language}.`);
      return linkId;
    }
    const entity = this.getEntityById(linkId)!;
    if (this.database.prepare("SELECT 1 FROM entities e LEFT JOIN transfer_tombstones t ON t.id = e.id WHERE e.kind = 'page' AND e.document_type = ? AND e.slug = ? AND e.locale IS ? AND e.id <> ? AND t.id IS NULL").get(entity.documentType, entity.slug, language, linkId)) throw new TypeError(`In ${language} esiste già un contenuto con slug ${entity.slug}.`);
    this.database.prepare("UPDATE entities SET locale = ?, updated_at = ? WHERE id = ?").run(language, new Date().toISOString(), linkId);
    return linkId;
  }

  getTranslation(translationId: string): CmsTranslationLink | null {
    const row = this.database.prepare("SELECT * FROM cms_translations WHERE translation_id = ?").get(translationId) as unknown as TranslationRow | undefined;
    return row ? translationFromRow(row) : null;
  }

  /** The links of the project, or of one original; one whose translation is in the Cestino or gone stays out. */
  listTranslations(sourceId?: string): CmsTranslationLink[] {
    const rows = (sourceId
      ? this.database.prepare("SELECT * FROM cms_translations WHERE source_id = ? ORDER BY language").all(sourceId)
      : this.database.prepare("SELECT * FROM cms_translations ORDER BY source_id, language").all()) as unknown as TranslationRow[];
    return rows.map(translationFromRow).filter((link) => this.translatableContent(link.translationId) !== null);
  }

  /** How a translation stands now (doc 20 §4.3): only a follower can be stale, and only when the original's texts moved. */
  translationState(link: CmsTranslationLink): CmsTranslationState {
    const translation = this.translatableContent(link.translationId);
    if (!translation) return "missing";
    if (translation.status !== "published") return "draft";
    if (link.mode === "independent") return "published";
    const source = this.translatableContent(link.sourceId);
    if (!source || source.updatedAt <= link.updatedAt) return "published";
    return this.translationSourceHash(link.sourceId) === link.sourceHash ? "published" : "stale";
  }

  /** Marks a translation as level with its original as it is now. */
  markTranslationCurrent(translationId: string): CmsTranslationLink {
    const link = this.getTranslation(translationId);
    if (!link) throw new TypeError("Traduzione inesistente.");
    this.markAligned(translationId, link.sourceId);
    return this.getTranslation(translationId)!;
  }

  /** Follows the original, from its present state, or goes its own way. */
  setTranslationMode(translationId: string, mode: CmsTranslationMode): CmsTranslationLink {
    if (mode !== "follow" && mode !== "independent") throw new TypeError("Modo della traduzione non valido.");
    const link = this.getTranslation(translationId);
    if (!link) throw new TypeError("Traduzione inesistente.");
    if (mode === "follow") {
      // A page born on its own has other blocks: rebuilding it on the original's would throw its text away.
      const own = new Set(this.contentSegments(translationId).map((segment) => segment.id));
      const blocks = this.contentSegments(link.sourceId).filter((segment) => segment.id !== "title" && segment.id !== "excerpt");
      if (blocks.length && !blocks.some((segment) => own.has(segment.id))) throw new TypeError("Questa versione ha una struttura sua: non può seguire l'originale senza perdere il suo testo. Crea una copia da tradurre.");
    }
    this.database.prepare("UPDATE cms_translations SET mode = ?, updated_at = ? WHERE translation_id = ?").run(mode, new Date().toISOString(), translationId);
    return mode === "follow" ? this.markTranslationCurrent(translationId) : this.getTranslation(translationId)!;
  }

  /** The content stays, on its own: it is no longer a version of the original. */
  removeTranslationLink(translationId: string): boolean {
    return this.database.prepare("DELETE FROM cms_translations WHERE translation_id = ?").run(translationId).changes > 0;
  }

  /**
   * What the site administration moves through (doc 21 §6.1): every content of the project by its columns, never its
   * revisions or field values, so a project of thousands reads in milliseconds. A translation's state comes from the
   * same rows: only one whose original moved after it needs the original's texts.
   */
  adminIndex(): CmsAdminIndex {
    const defaultLocale = this.getRenderSettings().locale;
    const documents = this.database.prepare("SELECT e.id, e.alias, e.title, e.slug, e.status, e.document_type, e.locale, e.template_ref, e.published_at, e.head_revision, e.updated_at FROM entities e LEFT JOIN transfer_tombstones t ON t.id = e.id WHERE e.kind = 'page' AND t.id IS NULL ORDER BY e.alias").all() as Array<{ id: string; alias: number; title: string; slug: string; status: string; document_type: "page" | "post"; locale: string | null; template_ref: string | null; published_at: string | null; head_revision: string; updated_at: string }>;
    const records = this.database.prepare("SELECT r.id, t.key AS type_key, r.title, r.slug, r.status, r.locale, r.head_revision, r.updated_at FROM cms_records r JOIN cms_content_types t ON t.id = r.type_id JOIN cms_identity_registry identity ON identity.id = r.id AND identity.deleted_at IS NULL ORDER BY t.key, r.order_no, r.id").all() as Array<{ id: string; type_key: string; title: string; slug: string; status: string; locale: string; head_revision: string; updated_at: string }>;
    const toDocument = (row: (typeof documents)[number]): CmsAdminDocument => ({ id: row.id, alias: row.alias, kind: row.document_type, title: row.title, slug: row.slug, status: row.status, locale: row.locale, templateRef: row.template_ref, publishedAt: row.published_at, head: row.head_revision, updatedAt: row.updated_at, address: documentAddress({ slug: row.slug, locale: row.locale, documentType: row.document_type }, defaultLocale) });
    const pages = documents.filter((row) => row.document_type === "page").map(toDocument);
    const posts = documents.filter((row) => row.document_type === "post").map(toDocument);
    const known = new Map<string, { status: string; updatedAt: string }>();
    for (const row of documents) known.set(row.id, { status: row.status, updatedAt: row.updated_at });
    for (const row of records) known.set(row.id, { status: row.status, updatedAt: row.updated_at });
    const links = this.database.prepare("SELECT * FROM cms_translations ORDER BY source_id, language").all() as unknown as TranslationRow[];
    const translations = links.flatMap((row) => {
      const link = translationFromRow(row);
      const version = known.get(link.translationId);
      if (!version) return [];
      const source = known.get(link.sourceId);
      let state: CmsTranslationState = version.status === "published" ? "published" : "draft";
      if (state === "published" && link.mode === "follow" && source && source.updatedAt > link.updatedAt && this.translationSourceHash(link.sourceId) !== link.sourceHash) state = "stale";
      return [{ translationId: link.translationId, sourceId: link.sourceId, kind: link.kind, language: link.language, mode: link.mode, state }];
    });
    const summary = (item: CmsComponent) => ({ id: item.id, alias: item.alias, ref: item.ref, title: item.title, updatedAt: item.updatedAt });
    return {
      pages, posts,
      records: records.map((row) => ({ id: row.id, kind: "record" as const, typeKey: row.type_key, title: row.title, slug: row.slug, status: row.status, locale: row.locale, head: row.head_revision, updatedAt: row.updated_at })),
      types: this.content.listTypes().map((type) => ({ key: type.key, label: type.label })),
      taxonomies: this.content.listTaxonomies().map((taxonomy) => ({ key: taxonomy.key, label: taxonomy.label })),
      assets: this.listAssets().map((asset) => ({ id: asset.id, alias: asset.alias, filename: asset.filename, alt: asset.alt, caption: asset.caption, mimeType: asset.mimeType })),
      templates: this.listTemplates().map((item) => ({ ...summary(item), role: item.role ?? null })), parts: this.listTemplateParts().map(summary), components: this.listComponents().filter((item) => item.kind === "component").map(summary),
      translations,
      languages: this.getProjectLanguages(),
      siteUrl: this.getSiteUrl(),
      siteSearch: this.getSiteSearch(),
      renderSettings: this.getRenderSettings(),
      imageVariants: this.getImageSettings().variants,
      shop: this.getShopSettings(),
    };
  }

  /** Everything that can have versions: pages, posts and records in the site's language. */
  translationOriginals(): Array<{ id: string; kind: string; title: string; slug: string }> {
    const defaultLocale = this.getRenderSettings().locale;
    const originals = [...this.listPages(), ...this.listPosts()].filter((document) => document.locale === null).map((document) => ({ id: document.id, kind: document.documentType as string, title: document.title, slug: document.slug }));
    for (const type of this.content.listTypes()) {
      for (let offset = 0; ; offset += 100) {
        const page = this.content.listRecords({ typeKey: type.key, locale: defaultLocale, status: "any", includePrivate: true, limit: 100, offset });
        originals.push(...page.items.map((record) => ({ id: record.id, kind: type.key, title: record.title, slug: record.slug })));
        if (!page.items.length || offset + page.items.length >= page.total) break;
      }
    }
    return originals;
  }

  /** The originals still to translate in `language` as XLIFF, or all of them. */
  exportTranslationXliff(language: string, all: boolean): string {
    const code = canonicalProjectLanguage(language);
    if (!this.getProjectLanguages().languages.some((item) => item.code === code)) throw new TypeError(`La lingua ${code} non è fra quelle del progetto.`);
    const defaultLocale = this.getRenderSettings().locale;
    this.learnTranslationMemory(code);
    const contents = this.translationOriginals().flatMap(({ id: sourceId }) => {
      const source = this.translationSource(sourceId, code, false);
      if (source.state === "published" && !all) return [];
      const link = this.translationOf(sourceId, code);
      if (link?.mode === "independent") return [];
      return [{ sourceId, sourceHash: this.translationSourceHash(sourceId) ?? "", title: source.segments.find((segment) => segment.id === "title")?.text ?? "", segments: source.segments, targets: { ...source.memory, ...source.existing } }];
    });
    return buildXliff({ sourceLanguage: defaultLocale, targetLanguage: code, contents });
  }

  /**
   * A translated XLIFF, content by content: each goes into its draft through saveTranslationSegments, or stays out with
   * its reason (a published version, an original changed since the export, a text refused), never half-written.
   */
  importTranslationXliff(language: string, text: string): { saved: number; left: number; skipped: Array<{ title: string; reason: string }> } {
    let saved = 0;
    let left = 0;
    const skipped: Array<{ title: string; reason: string }> = [];
    const code = canonicalProjectLanguage(language);
    const files = parseXliff(text);
    const other = files.find((file) => file.targetLanguage && file.targetLanguage.toLowerCase() !== code.toLowerCase());
    if (other) throw new TypeError(`Questo file è in ${other.targetLanguage}, non in ${code}: scegli la sua lingua.`);
    for (const file of files) {
      const title = this.contentSegments(file.sourceId).find((segment) => segment.id === "title")?.text ?? file.sourceId;
      if (!Object.keys(file.segments).length) {
        if (file.unreadable) skipped.push({ title, reason: `${file.unreadable} testi con marcatori non leggibili: esportali come testo semplice.` });
        continue;
      }
      if (this.translationSourceHash(file.sourceId) !== file.sourceHash) {
        skipped.push({ title, reason: "L'originale è cambiato dopo l'esportazione: esporta di nuovo." });
        continue;
      }
      try {
        left += this.saveTranslationSegments({ sourceId: file.sourceId, language, segments: file.segments }).left;
        saved += 1;
      } catch (error) {
        skipped.push({ title, reason: error instanceof Error ? error.message : "Rifiutato." });
      }
    }
    return { saved, left, skipped };
  }

  /** Context and glossary for whoever translates (doc 20 §5.8): plain text, read by the agent as data. */
  getTranslationBrief(): string {
    return (this.database.prepare("SELECT value FROM project_meta WHERE key = 'translation.brief'").get() as { value: string } | undefined)?.value ?? "";
  }

  setTranslationBrief(value: unknown): string {
    if (typeof value !== "string" || value.length > 20_000 || value.includes("\0")) throw new TypeError("Contesto e glossario hanno al massimo 20.000 caratteri.");
    if (value.trim()) this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('translation.brief', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
    else this.database.prepare("DELETE FROM project_meta WHERE key = 'translation.brief'").run();
    return value.trim() ? value : "";
  }

  /** Drafts of many contents in one language, in one transaction; one already translated is left as it is. */
  bulkCreateTranslations(ids: readonly string[], language: string): number {
    return this.transaction(() => {
      let created = 0;
      for (const id of ids) {
        if (this.translationOf(id, language)) continue;
        this.createTranslation({ sourceId: id, language });
        created += 1;
      }
      return created;
    });
  }

  /** A status for many contents, in one transaction: all of them or none (doc 21 §6.3). */
  bulkSetStatus(ids: readonly string[], status: "draft" | "published"): number {
    return this.transaction(() => {
      for (const id of ids) {
        const entity = this.getEntityById(id);
        if (entity?.kind === "page" && entity.documentType === "post") this.updatePostMetadata(id, { title: entity.title, slug: entity.slug, status, ...(status === "published" && entity.publishedAt ? { publishedAt: entity.publishedAt } : {}) });
        else if (entity?.kind === "page") this.updatePageMetadata(id, { title: entity.title, slug: entity.slug, status });
        else {
          const record = entity ? null : this.content.getRecordById(id);
          if (!record) throw new TypeError("Uno dei contenuti scelti non esiste.");
          const saved = this.content.joinTransaction(() => this.content.saveRecord({ ...recordWriteInput(record, this.content.getType(record.typeKey)?.fields ?? []), status, ...(status === "published" ? { publishedAt: record.publishedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z") } : { publishedAt: null }) }));
          if (saved.status !== "saved") throw new TypeError(`Il record ${record.title} è cambiato in un'altra finestra.`);
        }
      }
      return ids.length;
    });
  }

  /** The texts of a content: title, summary, then the document's segments or a record's text fields. */
  private contentSegments(id: string): TranslationSegment[] {
    const entity = this.getEntityById(id);
    if (entity) {
      const revision = this.getHead(id);
      return [{ id: "title", text: entity.title }, ...(entity.excerpt ? [{ id: "excerpt", text: entity.excerpt }] : []), ...(revision ? documentSegments(revision.content, this.textPropOf()) : [])];
    }
    const record = this.content.getRecordById(id);
    if (!record) return [];
    const type = this.content.getType(record.typeKey);
    // An SKU is a code, not a text: WooCommerce keeps one product per SKU, so the original's stays the original's.
    const fields = (type?.fields ?? []).filter((field) => (field.type === "text" || field.type === "rich-text") && !field.multiple && typeof record.values[field.key] === "string" && record.values[field.key] && !(record.typeKey === PRODUCT_TYPE_KEY && field.key === "sku"));
    return [{ id: "title", text: record.title }, ...(record.excerpt ? [{ id: "excerpt", text: record.excerpt }] : []), ...fields.map((field) => ({ id: `field:${field.key}`, text: record.values[field.key] as string }))];
  }

  /** The translation of the original in `language`, or null. */
  private translationOf(sourceId: string, language: string): CmsTranslationLink | null {
    return this.listTranslations(sourceId).find((link) => link.language.toLowerCase() === language.toLowerCase()) ?? null;
  }

  private markAligned(translationId: string, sourceId: string): void {
    this.database.prepare("UPDATE cms_translations SET source_hash = ?, source_snapshot = ?, updated_at = ? WHERE translation_id = ?").run(this.translationSourceHash(sourceId) ?? "", JSON.stringify(Object.fromEntries(this.contentSegments(sourceId).map((segment) => [segment.id, segment.text]))), new Date().toISOString(), translationId);
  }

  /** What a translator needs (doc 20 §5.8): the original's segments, the known sentences, and what the version has now. */
  translationSource(sourceId: string, language: string, learn = true): { sourceId: string; language: string; segments: TranslationSegment[]; memory: Record<string, string>; existing: Record<string, string>; state: CmsTranslationState; published: boolean } {
    const code = canonicalProjectLanguage(language);
    if (!this.translatableContent(sourceId)) throw new TypeError("L'originale non esiste.");
    if (learn) this.learnTranslationMemory(code);
    const segments = this.contentSegments(sourceId);
    const link = this.translationOf(sourceId, code);
    const known = this.memoryFor(code, segments.map((segment) => segment.text));
    const memory = Object.fromEntries(segments.flatMap((segment) => { const target = known.get(segment.text); return target ? [[segment.id, target]] : []; }));
    const existing = link ? this.translatedSegments(link, segments) : {};
    return { sourceId, language: code, segments, memory, existing, state: link ? this.translationState(link) : "missing", published: link ? this.translatableContent(link.translationId)?.status === "published" : false };
  }

  /** The texts a version has for the original's segments, leaving out those still in the original's words. */
  private translatedSegments(link: CmsTranslationLink, segments: readonly TranslationSegment[]): Record<string, string> {
    const own = new Map(this.contentSegments(link.translationId).map((segment) => [segment.id, segment.text]));
    return Object.fromEntries(segments.flatMap((segment) => { const text = own.get(segment.id); return text !== undefined && text !== segment.text ? [[segment.id, text]] : []; }));
  }

  /**
   * Writes segments into a draft, created if missing (doc 20 §5.2). The version is rebuilt on the original's structure:
   * what is written here, then what it already had, then the memory, otherwise the original's words. A published
   * version or an independent one is refused: nothing here reaches a page that is online.
   */
  saveTranslationSegments(input: { sourceId: string; language: string; segments: unknown; slug?: string }): { link: CmsTranslationLink; left: number } {
    const language = canonicalProjectLanguage(input.language);
    if (!input.segments || typeof input.segments !== "object" || Array.isArray(input.segments)) throw new TypeError("I testi tradotti devono essere un oggetto id → testo.");
    const source = this.contentSegments(input.sourceId);
    if (!source.length) throw new TypeError("L'originale non esiste.");
    const byId = new Map(source.map((segment) => [segment.id, segment.text]));
    const given = new Map<string, string>();
    for (const [id, text] of Object.entries(input.segments as Record<string, unknown>)) {
      const original = byId.get(id);
      if (original === undefined) throw new TypeError(`Il testo ${id} non è fra quelli dell'originale.`);
      given.set(id, assertSegmentText(original, text, id));
    }
    return this.transaction(() => {
      const link = this.translationOf(input.sourceId, language) ?? this.createTranslation({ sourceId: input.sourceId, language, ...(input.slug ? { slug: input.slug } : {}) });
      if (link.mode === "independent") throw new TypeError("Questa traduzione è indipendente: non segue i testi dell'originale.");
      if (this.translatableContent(link.translationId)?.status === "published") throw new TypeError("La traduzione è pubblicata: si corregge dall'amministrazione, mai dal connettore.");
      const left = this.rebuildTranslation(link, source, given);
      return { link: this.getTranslation(link.translationId)!, left };
    });
  }

  /** Rebuilds a draft on the original as it is now; returns how many texts remain in the original's words. */
  private rebuildTranslation(link: CmsTranslationLink, source: readonly TranslationSegment[], given: ReadonlyMap<string, string>): number {
    if (!source.length) throw new TypeError("L'originale non c'è più, o è nel Cestino: ripristinalo prima.");
    const row = this.database.prepare("SELECT source_snapshot FROM cms_translations WHERE translation_id = ?").get(link.translationId) as { source_snapshot: string };
    const snapshot = row.source_snapshot ? JSON.parse(row.source_snapshot) as Record<string, string> : null;
    const own = new Map(this.contentSegments(link.translationId).map((segment) => [segment.id, segment.text]));
    const memory = this.memoryFor(link.language, source.map((segment) => segment.text));
    const texts = new Map<string, string>();
    let left = 0;
    for (const segment of source) {
      // A text the original changed does not keep the old translation: the sentence is another one now.
      const stillThere = snapshot === null || snapshot[segment.id] === segment.text;
      const kept = stillThere ? own.get(segment.id) : undefined;
      const text = given.get(segment.id) ?? (kept !== undefined && kept !== segment.text ? kept : memory.get(segment.text));
      if (text === undefined) left += 1;
      texts.set(segment.id, text ?? segment.text);
    }
    const entity = this.getEntityById(link.translationId);
    if (entity) {
      const sourceEntity = this.getEntityById(link.sourceId)!;
      const content = applySegments(this.getHead(sourceEntity.id)!.content, texts);
      const saved = this.saveDocument({ entityId: entity.id, expectedHead: entity.headRevision, content });
      if (saved.status === "conflict") throw new TypeError("La traduzione è cambiata in un'altra finestra.");
      const fields = { title: texts.get("title") ?? entity.title, slug: entity.slug, status: "draft" as const };
      if (entity.documentType === "post") this.updatePostMetadata(entity.id, { ...fields, excerpt: texts.get("excerpt") ?? "" });
      else this.updatePageMetadata(entity.id, fields);
    } else {
      const record = this.content.getRecordById(link.translationId)!;
      const fields = this.content.getType(record.typeKey)?.fields ?? [];
      const written = recordWriteInput(record, fields);
      // The original's values, with the translated texts on top: a price it changed or a text it dropped follows.
      const values = recordWriteInput(this.content.getRecordById(link.sourceId)!, fields).values;
      if (Object.hasOwn(values, "sku") && record.typeKey === PRODUCT_TYPE_KEY) delete values.sku;
      for (const [id, text] of texts) if (id.startsWith("field:")) values[id.slice(6)] = text;
      this.content.joinTransaction(() => {
        const saved = this.content.saveRecord({ ...written, values, title: texts.get("title") ?? record.title, excerpt: texts.get("excerpt") ?? "" });
        if (saved.status !== "saved") throw new TypeError("La traduzione è cambiata in un'altra finestra.");
      });
    }
    this.markAligned(link.translationId, link.sourceId);
    return left;
  }

  /** «Aggiorna la bozza» (doc 20 §5.3): only a draft that follows; a published version is never rebuilt. */
  updateTranslationDraft(translationId: string): { link: CmsTranslationLink; left: number } {
    const link = this.getTranslation(translationId);
    if (!link) throw new TypeError("Traduzione inesistente.");
    if (link.mode !== "follow") throw new TypeError("Questa traduzione è indipendente.");
    if (this.translatableContent(translationId)?.status === "published") throw new TypeError("Una traduzione pubblicata non si ricostruisce mai: vai alla frase e correggila.");
    return this.transaction(() => ({ left: this.rebuildTranslation(link, this.contentSegments(link.sourceId), new Map()), link: this.getTranslation(translationId)! }));
  }

  /** The texts the original changed since the version was last level with it: before, now, and the version's text. */
  translationChanges(translationId: string): { known: boolean; changes: Array<{ id: string; before: string | null; now: string | null; translation: string | null }> } {
    const link = this.getTranslation(translationId);
    if (!link) throw new TypeError("Traduzione inesistente.");
    const row = this.database.prepare("SELECT source_snapshot FROM cms_translations WHERE translation_id = ?").get(translationId) as { source_snapshot: string };
    if (!row.source_snapshot) return { known: false, changes: [] };
    const before = JSON.parse(row.source_snapshot) as Record<string, string>;
    const now = new Map(this.contentSegments(link.sourceId).map((segment) => [segment.id, segment.text]));
    const own = new Map(this.contentSegments(translationId).map((segment) => [segment.id, segment.text]));
    const ids = [...new Set([...Object.keys(before), ...now.keys()])];
    return { known: true, changes: ids.flatMap((id) => (before[id] ?? null) === (now.get(id) ?? null) ? [] : [{ id, before: before[id] ?? null, now: now.get(id) ?? null, translation: own.get(id) ?? null }]) };
  }

  private memoryFor(language: string, sources: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    const read = this.database.prepare("SELECT target FROM cms_translation_memory WHERE source_hash = ? AND language = ?");
    for (const source of new Set(sources)) {
      const row = read.get(digest(source), language) as { target: string } | undefined;
      if (row) found.set(source, row.target);
    }
    return found;
  }

  /**
   * Teaches the memory what is online in `language`: sentences of published versions that follow their original, each
   * read once (doc 20 §4.4). A draft teaches nothing until someone has reviewed it.
   */
  learnTranslationMemory(language: string): number {
    const key = `memory.learned.${language}`;
    const since = (this.database.prepare("SELECT value FROM project_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? "";
    let learned = 0;
    const now = new Date().toISOString();
    this.transaction(() => {
      const write = this.database.prepare("INSERT INTO cms_translation_memory(source_hash, language, source, target, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_hash, language) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at");
      for (const link of this.listTranslations()) {
        if (link.mode !== "follow" || link.language !== language) continue;
        const version = this.translatableContent(link.translationId);
        if (version?.status !== "published" || version.updatedAt < since) continue;
        // A version behind its original says what the original said then: it teaches nothing about the words of now.
        if (this.translationSourceHash(link.sourceId) !== link.sourceHash) continue;
        const own = new Map(this.contentSegments(link.translationId).map((segment) => [segment.id, segment.text]));
        for (const segment of this.contentSegments(link.sourceId)) {
          const target = own.get(segment.id);
          if (target === undefined || target === segment.text) continue;
          write.run(digest(segment.text), language, segment.text, target, now);
          learned += 1;
        }
      }
      this.database.prepare("INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, now);
    });
    return learned;
  }

  /** The project's fonts (the builder's «Font del sito»): their @font-face rules and media, or null. */
  getFontSheet(): FontSheet | null {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = 'fonts.sheet'").get() as { value: string } | undefined;
    if (!row) return null;
    try {
      return asFontSheet({ id: FONT_SHEET_ID, ...(JSON.parse(row.value) as object) });
    } catch {
      return null;
    }
  }

  /** Keeps the project's fonts; null removes them. Every media named must be one of the project's. */
  setFontSheet(sheet: FontSheet | null): void {
    if (sheet === null) {
      this.database.prepare("DELETE FROM project_meta WHERE key = 'fonts.sheet'").run();
      return;
    }
    const checked = asFontSheet({ id: FONT_SHEET_ID, ...sheet });
    if (!checked) throw new TypeError("I font del progetto non sono regole @font-face valide.");
    const known = new Set(this.listAssets().map((asset) => asset.id));
    if (checked.assets.some((asset) => !known.has(asset.assetId))) throw new TypeError("Un font del progetto non è fra i suoi media.");
    this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('fonts.sheet', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(checked));
  }

  /** Doc 23 item 94: the agent's proposal for an article, waiting for the writer; null when there is none. */
  getArticleProposal(entityId: string): ArticleProposal | null {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = ?").get(`proposal.article.${entityId}`) as { value: string } | undefined;
    return readArticleProposal(row?.value);
  }

  /** Keeps the proposal for an article, replacing an earlier one; null removes it. */
  setArticleProposal(entityId: string, proposal: ArticleProposal | null): void {
    if (!this.getEntityById(entityId)) throw new Error("Articolo non trovato.");
    if (proposal === null) this.database.prepare("DELETE FROM project_meta WHERE key = ?").run(`proposal.article.${entityId}`);
    else this.database.prepare("INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`proposal.article.${entityId}`, JSON.stringify(proposal));
  }

  /** The strings of a language: what templates, parts and components show, and the terms, with their translations. */
  listStrings(language: string): Array<{ sourceHash: string; source: string; context: string; translation: string; status: "missing" | "draft" | "published" }> {
    const code = canonicalProjectLanguage(language);
    const stored = new Map((this.database.prepare("SELECT source_hash, source, context, translation, status FROM cms_strings WHERE language = ?").all(code) as Array<{ source_hash: string; source: string; context: string; translation: string; status: "draft" | "published" }>).map((row) => [row.source_hash, row]));
    const out = new Map<string, { sourceHash: string; source: string; context: string; translation: string; status: "missing" | "draft" | "published" }>();
    const add = (source: string, context: string): void => {
      const sourceHash = digest(normalizeStringSource(source));
      if (out.has(sourceHash)) return;
      const row = stored.get(sourceHash);
      out.set(sourceHash, { sourceHash, source, context: row?.context ?? context, translation: row?.translation ?? "", status: row?.status ?? "missing" });
    };
    for (const [kind, list] of [["template", this.listTemplates()], ["part", this.listTemplateParts()], ["component", this.listComponents().filter((item) => item.kind === "component")]] as const) {
      for (const item of list) for (const text of staticTexts(item.content)) add(text, kind);
    }
    for (const taxonomy of this.content.listTaxonomies()) for (const term of this.content.listTerms(taxonomy.key)) add(term.label, "term");
    for (const row of stored.values()) add(row.source, row.context);
    return [...out.values()].slice(0, MAX_PROJECT_STRINGS);
  }

  /** Writes strings: plain text only (doc 20 §7). An empty translation takes the string away. */
  saveStrings(language: string, items: unknown, status: "draft" | "published"): number {
    const code = canonicalProjectLanguage(language);
    if (!this.getProjectLanguages().languages.some((item) => item.code === code)) throw new TypeError(`La lingua ${code} non è fra quelle del progetto.`);
    if (!Array.isArray(items) || items.length > 2000) throw new TypeError("Le stringhe sono un elenco di al massimo 2000 voci.");
    const now = new Date().toISOString();
    return this.transaction(() => {
      let saved = 0;
      for (const item of items) {
        if (!item || typeof item !== "object") throw new TypeError("Stringa non valida.");
        const { source, translation, context } = item as { source?: unknown; translation?: unknown; context?: unknown };
        if (typeof source !== "string" || !source.trim() || source.length > 4096) throw new TypeError("Il testo originale di una stringa non è valido.");
        const sourceHash = digest(normalizeStringSource(source));
        if (status === "draft" && (this.database.prepare("SELECT status FROM cms_strings WHERE source_hash = ? AND language = ?").get(sourceHash, code) as { status?: string } | undefined)?.status === "published") throw new TypeError(`La stringa «${source.slice(0, 40)}» è pubblicata: non si cambia da qui.`);
        if (translation === "") {
          this.database.prepare("DELETE FROM cms_strings WHERE source_hash = ? AND language = ?").run(sourceHash, code);
          continue;
        }
        if (typeof translation !== "string" || translation.length > 4096 || /[<>\p{Cc}]/u.test(translation)) throw new TypeError("Una stringa è solo testo, senza parentesi angolari.");
        if (typeof context !== "string" || !/^[a-z]{1,20}$/u.test(context)) throw new TypeError("Il contesto di una stringa non è valido.");
        this.database.prepare("INSERT INTO cms_strings(source_hash, language, context, source, translation, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_hash, language) DO UPDATE SET context = excluded.context, source = excluded.source, translation = excluded.translation, status = excluded.status, updated_at = excluded.updated_at").run(sourceHash, code, context, normalizeStringSource(source), translation, status, now);
        saved += 1;
      }
      if ((this.database.prepare("SELECT COUNT(*) AS n FROM cms_strings").get() as { n: number }).n > MAX_PROJECT_STRINGS) throw new RangeError(`Un progetto ha al massimo ${MAX_PROJECT_STRINGS} stringhe.`);
      return saved;
    });
  }

  /** The published strings of a language, by their text as the page shows it. */
  publishedStrings(language: string): Map<string, string> {
    return new Map((this.database.prepare("SELECT source, translation FROM cms_strings WHERE language = ? AND status = 'published'").all(language) as Array<{ source: string; translation: string }>).map((row) => [row.source, row.translation]));
  }

  /** The project's image variants (queue B6): on by default, with CMS_IMAGE_SETTINGS_DEFAULTS. */
  getImageSettings(): CmsImageSettings {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = 'images.settings'").get() as { value: string } | undefined;
    if (!row) return normalizeCmsImageSettings(undefined);
    try { return normalizeCmsImageSettings(JSON.parse(row.value)); }
    catch { return normalizeCmsImageSettings(undefined); }
  }

  setImageSettings(value: unknown): CmsImageSettings {
    const settings = normalizeCmsImageSettings(value);
    this.transaction(() => {
      this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('images.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
    });
    return settings;
  }

  async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const depth = this.transactionDepth;
    const savepoint = `cms_atomic_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth = depth + 1;
    try {
      const result = await this.content.withOuterTransaction(operation);
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.rollback(depth, savepoint);
      throw error;
    } finally {
      this.transactionDepth = depth;
      if (depth === 0) this.resetComponentGraphIndex();
    }
  }

  /** Forgets the index of calls (graphIndex) and what the transaction's checks read: the write transaction ended. */
  private resetComponentGraphIndex(): void {
    this.graphIndex = null;
    this.graphWalked = 0;
    this.graphIndexAt = GRAPH_INDEX_MIN_WALKED;
  }

  /**
   * Drops the index of calls (graphIndex) in the open transaction: the live calls changed otherwise than by a create or
   * a save. The checks then read what they reach again, until that costs as much as building it anew.
   */
  private dropComponentGraphIndex(): void {
    this.graphIndex = null;
    this.graphWalked = 0;
  }

  /** Undoes a failed transaction. SQLite may have rolled back by itself (a full disk, an I/O error): then there is nothing left to undo, and the error to report is the original one. */
  private rollback(depth: number, savepoint: string): void {
    // What was undone may have changed calls the index holds: it is dropped, whatever SQLite still had to undo.
    this.dropComponentGraphIndex();
    if (!this.database.isTransaction) return;
    if (depth === 0) this.database.exec("ROLLBACK");
    else {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
  }

  private transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `cms_tx_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth = depth + 1;
    try {
      const result = operation();
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.rollback(depth, savepoint);
      throw error;
    } finally {
      this.transactionDepth = depth;
      if (depth === 0) this.resetComponentGraphIndex();
    }
  }

  createPage(input: { title: string; slug?: string; content?: string; id?: string; status?: "draft" | "published"; templateRef?: string | null; locale?: string | null }): CmsEntity {
    const title = input.title.trim();
    if (!title) throw new TypeError("Il titolo della pagina è obbligatorio.");
    const content = input.content ?? starterDocument(title);
    assertDocumentContent(content);
    const id = input.id ?? randomUUID();
    if (!PROJECT_ID.test(id)) throw new TypeError("Identificativo della pagina non valido.");
    if (input.templateRef !== undefined && input.templateRef !== null && !this.canUseTemplate(input.templateRef)) throw new TypeError(`Il template ${input.templateRef} non contiene uno slot Histeon predefinito per la pagina.`);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const slug = slugify(input.slug?.trim() || title);
    this.transaction(() => {
      const alias = Number((this.database.prepare("SELECT COALESCE(MAX(alias), 0) + 1 AS next FROM entities").get() as { next: number }).next);
      if (alias >= COMPONENT_ALIAS_START) throw new RangeError("Numero massimo di pagine raggiunto.");
      if (this.database.prepare("SELECT 1 FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.slug = ? AND e.locale IS ? AND e.kind = 'page' AND e.document_type = 'page' AND t.id IS NULL").get(slug, input.locale ?? null)) throw new Error(`Esiste già una pagina con slug ${slug}.`);
      this.database.prepare("INSERT INTO entities(id, kind, alias, slug, title, status, head_revision, template_ref, locale, created_at, updated_at) VALUES (?, 'page', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, alias, slug, title, input.status ?? "draft", revisionId, input.templateRef ?? null, input.locale ?? null, now, now);
      this.database.prepare("INSERT INTO revisions(id, entity_id, parent_id, created_at, content, content_hash, source) VALUES (?, ?, NULL, ?, ?, ?, 'editor')")
        .run(revisionId, id, now, content, digest(content));
    });
    return this.getEntityById(id)!;
  }

  createStyles(content = JSON.stringify({ styles: [], globals: [], compiledCss: "" }), entityId: string = randomUUID()): CmsEntity {
    parseJson(content);
    const existing = this.database.prepare("SELECT * FROM entities WHERE kind = 'styles' LIMIT 1").get() as unknown as EntityRow | undefined;
    if (existing) return entityFromRow(existing);
    const id = entityId;
    if (!PROJECT_ID.test(id)) throw new TypeError("Identificativo degli stili non valido.");
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      const alias = Number((this.database.prepare("SELECT COALESCE(MAX(alias), 0) + 1 AS next FROM entities").get() as { next: number }).next);
      if (alias >= COMPONENT_ALIAS_START) throw new RangeError("Numero massimo di documenti raggiunto.");
      this.database.prepare("INSERT INTO entities(id, kind, alias, slug, title, head_revision, created_at, updated_at) VALUES (?, 'styles', ?, 'styles', 'Stili globali', ?, ?, ?)")
        .run(id, alias, revisionId, now, now);
      this.database.prepare("INSERT INTO revisions(id, entity_id, parent_id, created_at, content, content_hash, source) VALUES (?, ?, NULL, ?, ?, ?, 'editor')")
        .run(revisionId, id, now, content, digest(content));
    });
    return this.getEntityById(id)!;
  }

  getStyles(): CmsEntity | null {
    const row = this.database.prepare("SELECT * FROM entities WHERE kind = 'styles' LIMIT 1").get() as unknown as EntityRow | undefined;
    return row ? entityFromRow(row) : null;
  }

  listPages(): CmsEntity[] {
    const rows = this.database.prepare("SELECT e.* FROM entities e LEFT JOIN transfer_tombstones t ON t.id = e.id WHERE e.kind = 'page' AND e.document_type = 'page' AND t.id IS NULL ORDER BY e.alias").all() as unknown as EntityRow[];
    return rows.map(entityFromRow);
  }

  /** Posts, newest first (drafts, which have no date, after the dated ones). */
  listPosts(): CmsEntity[] {
    const rows = this.database.prepare("SELECT e.* FROM entities e LEFT JOIN transfer_tombstones t ON t.id = e.id WHERE e.kind = 'page' AND e.document_type = 'post' AND t.id IS NULL ORDER BY e.published_at IS NULL, e.published_at DESC, e.alias DESC").all() as unknown as EntityRow[];
    return rows.map(entityFromRow);
  }

  /** The terms of a post, by taxonomy key, as term ids in their saved order. */
  getPostTermIds(id: string): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.content.postTerms(id)).map(([taxonomyKey, terms]) => [taxonomyKey, terms.map((term) => term.id)]));
  }

  getPostTerms(id: string): Record<string, CmsTerm[]> {
    return this.content.postTerms(id);
  }

  createPost(input: { title: string; slug?: string; content?: string; id?: string; status?: "draft" | "published"; publishedAt?: string | null; excerpt?: string; imageAssetId?: string | null; terms?: Record<string, string[]>; templateRef?: string | null; locale?: string | null }): CmsEntity {
    const title = input.title.trim();
    if (!title || title.length > 500) throw new TypeError("Il titolo dell'articolo è obbligatorio e non può superare 500 caratteri.");
    const content = input.content ?? starterDocument(title);
    assertDocumentContent(content);
    const id = input.id ?? randomUUID();
    if (!PROJECT_ID.test(id)) throw new TypeError("Identificativo dell'articolo non valido.");
    const status = input.status ?? "draft";
    const fields = this.checkedPostFields({ status, publishedAt: input.publishedAt, excerpt: input.excerpt ?? "", templateRef: input.templateRef ?? null });
    const imageAssetId = this.checkedPostImage(input.imageAssetId ?? null);
    const slug = slugifyPost(input.slug?.trim() || title);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      const alias = Number((this.database.prepare("SELECT COALESCE(MAX(alias), 0) + 1 AS next FROM entities").get() as { next: number }).next);
      if (alias >= COMPONENT_ALIAS_START) throw new RangeError("Numero massimo di documenti raggiunto.");
      if (this.database.prepare("SELECT 1 FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.slug = ? AND e.locale IS ? AND e.kind = 'page' AND e.document_type = 'post' AND t.id IS NULL").get(slug, input.locale ?? null)) throw new Error(`Esiste già un articolo con slug ${slug}.`);
      this.database.prepare("INSERT INTO entities(id, kind, alias, slug, title, status, head_revision, template_ref, document_type, published_at, excerpt, image_asset_id, locale, created_at, updated_at) VALUES (?, 'page', ?, ?, ?, ?, ?, ?, 'post', ?, ?, ?, ?, ?, ?)")
        .run(id, alias, slug, title, status, revisionId, fields.templateRef, fields.publishedAt, fields.excerpt, imageAssetId, input.locale ?? null, now, now);
      this.database.prepare("INSERT INTO revisions(id, entity_id, parent_id, created_at, content, content_hash, source) VALUES (?, ?, NULL, ?, ?, ?, 'editor')")
        .run(revisionId, id, now, content, digest(content));
      this.writePostTerms(id, input.terms ?? {});
    });
    return this.getEntityById(id)!;
  }

  updatePostMetadata(id: string, input: { title: string; slug: string; status: "draft" | "published"; publishedAt?: string | null; excerpt?: string; imageAssetId?: string | null; terms?: Record<string, string[]>; templateRef?: string | null }): CmsEntity {
    const title = input.title.trim();
    if (!title || title.length > 500) throw new TypeError("Il titolo dell'articolo non è valido.");
    const movedPost = this.getEntityById(id);
    const current = this.database.prepare("SELECT template_ref, published_at, excerpt, image_asset_id, locale FROM entities WHERE id = ? AND kind = 'page' AND document_type = 'post'").get(id) as { template_ref: string | null; published_at: string | null; excerpt: string; image_asset_id: string | null; locale: string | null } | undefined;
    if (!current) throw new Error("Articolo inesistente.");
    const slug = slugifyPost(input.slug);
    const fields = this.checkedPostFields({
      status: input.status,
      publishedAt: input.publishedAt === undefined ? current.published_at : input.publishedAt,
      excerpt: input.excerpt ?? current.excerpt,
      templateRef: input.templateRef === undefined ? current.template_ref : input.templateRef,
    });
    // Left out, the image stays; null takes it away.
    const imageAssetId = input.imageAssetId === undefined ? current.image_asset_id : this.checkedPostImage(input.imageAssetId);
    this.transaction(() => {
      const duplicate = this.database.prepare("SELECT e.id FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.kind = 'page' AND e.document_type = 'post' AND e.slug = ? AND e.locale IS ? AND e.id <> ? AND t.id IS NULL").get(slug, current.locale, id) as { id: string } | undefined;
      if (duplicate) throw new Error(`Esiste già un articolo con slug ${slug}.`);
      // Only a rename that goes through leaves the old address leading to the new one, in the same transaction.
      if (movedPost && movedPost.status === "published" && movedPost.locale === null && slug !== movedPost.slug) this.rememberRedirect(`/blog/${movedPost.slug}/`, `/blog/${slug}/`);
      this.database.prepare("UPDATE entities SET title = ?, slug = ?, status = ?, template_ref = ?, published_at = ?, excerpt = ?, image_asset_id = ?, updated_at = ? WHERE id = ? AND kind = 'page' AND document_type = 'post'")
        .run(title, slug, input.status, fields.templateRef, fields.publishedAt, fields.excerpt, imageAssetId, new Date().toISOString(), id);
      if (input.terms !== undefined) this.writePostTerms(id, input.terms);
    });
    return this.getEntityById(id)!;
  }

  /** Date, summary and template of a post, checked as the transfer profile checks them. */
  private checkedPostFields(input: { status: "draft" | "published"; publishedAt: string | null | undefined; excerpt: string; templateRef: string | null }): { publishedAt: string | null; excerpt: string; templateRef: string | null } {
    if (input.status !== "draft" && input.status !== "published") throw new TypeError("Stato dell'articolo non valido.");
    let publishedAt: string | null = null;
    if (input.status === "published") {
      publishedAt = input.publishedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
      if (!isPostPublishedAt(publishedAt)) throw new TypeError("La data di pubblicazione deve avere la forma AAAA-MM-GGThh:mm:ssZ.");
    }
    if (typeof input.excerpt !== "string" || input.excerpt.length > MAX_POST_EXCERPT || input.excerpt.includes("\0")) throw new TypeError("Il riassunto dell'articolo supera 20.000 caratteri o non è valido.");
    if (input.templateRef !== null && !this.canUseTemplate(input.templateRef)) throw new TypeError(`Il template ${input.templateRef} non contiene uno slot Histeon predefinito.`);
    return { publishedAt, excerpt: input.excerpt, templateRef: input.templateRef };
  }

  /** The featured image of a post (doc 23 item 119): null, or an image of the project's media library. */
  private checkedPostImage(assetId: string | null): string | null {
    if (assetId === null) return null;
    if (typeof assetId !== "string" || !PROJECT_ID.test(assetId)) throw new TypeError("L'immagine dell'articolo non è valida.");
    const row = this.database.prepare("SELECT a.mime_type FROM assets a LEFT JOIN transfer_tombstones t ON t.id = a.id WHERE a.id = ? AND t.id IS NULL").get(assetId) as { mime_type: string } | undefined;
    if (!row) throw new TypeError("L'immagine dell'articolo non è fra i media del progetto.");
    if (!row.mime_type.startsWith("image/")) throw new TypeError("L'immagine dell'articolo deve essere un'immagine, non un altro tipo di file.");
    return assetId.toLowerCase();
  }

  /** Replaces the terms of a post; each taxonomy must be attached to posts and each term must belong to it. */
  private writePostTerms(postId: string, terms: Record<string, string[]>): void {
    if (!terms || typeof terms !== "object" || Array.isArray(terms) || Object.keys(terms).length > 64) throw new TypeError("Termini dell'articolo non validi.");
    const rows: Array<{ taxonomyId: string; termId: string; ordinal: number }> = [];
    for (const [taxonomyKey, ids] of Object.entries(terms)) {
      const taxonomy = this.content.getTaxonomy(taxonomyKey);
      if (!taxonomy || taxonomy.key !== taxonomyKey || !taxonomy.types.includes(POST_TYPE_KEY)) throw new TypeError(`La tassonomia ${taxonomyKey} non è collegata agli articoli.`);
      if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) throw new TypeError(`Elenco termini non valido per ${taxonomyKey}.`);
      ids.forEach((termId, ordinal) => {
        const term = typeof termId === "string" ? this.content.getTermById(termId) : null;
        if (!term || term.taxonomyKey !== taxonomyKey) throw new TypeError(`Il termine ${String(termId)} non appartiene alla tassonomia ${taxonomyKey}.`);
        rows.push({ taxonomyId: taxonomy.id, termId: term.id, ordinal });
      });
    }
    this.database.prepare("DELETE FROM cms_post_terms WHERE post_id = ?").run(postId);
    const insert = this.database.prepare("INSERT INTO cms_post_terms(post_id, taxonomy_id, term_id, ordinal) VALUES (?, ?, ?, ?)");
    for (const row of rows) insert.run(postId, row.taxonomyId, row.termId, row.ordinal);
  }

  getEntityById(id: string): CmsEntity | null {
    if (!ENTITY_ID.test(id)) return null;
    const row = this.database.prepare("SELECT e.* FROM entities e LEFT JOIN transfer_tombstones t ON t.id = e.id WHERE e.id = ? AND t.id IS NULL").get(id) as unknown as EntityRow | undefined;
    return row ? entityFromRow(row) : null;
  }

  getEntityByAlias(alias: number): CmsEntity | null {
    if (!Number.isSafeInteger(alias) || alias < 1) return null;
    const row = this.database.prepare("SELECT e.* FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.alias = ? AND t.id IS NULL").get(alias) as unknown as EntityRow | undefined;
    return row ? entityFromRow(row) : null;
  }

  listComponents(): CmsComponent[] {
    const rows = this.database.prepare("SELECT c.* FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.kind IN ('component', 'template-part') AND t.id IS NULL ORDER BY c.ref").all() as unknown as ComponentRow[];
    return rows.map((row) => this.getComponentById(row.id)).filter((item): item is CmsComponent => item !== null);
  }

  listTemplates(): CmsComponent[] {
    const rows = this.database.prepare("SELECT c.* FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.kind = 'template' AND t.id IS NULL ORDER BY c.title, c.ref").all() as unknown as ComponentRow[];
    return rows.map((row) => this.getComponentById(row.id)).filter((item): item is CmsComponent => item !== null);
  }

  listTemplateParts(): CmsComponent[] {
    const rows = this.database.prepare("SELECT c.* FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.kind = 'template-part' AND t.id IS NULL ORDER BY c.title, c.ref").all() as unknown as ComponentRow[];
    return rows.map((row) => this.getComponentById(row.id)).filter((item): item is CmsComponent => item !== null);
  }

  getComponentById(id: string): CmsComponent | null {
    if (!ENTITY_ID.test(id)) return null;
    const component = this.database.prepare("SELECT c.* FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.id = ? AND t.id IS NULL").get(id) as unknown as ComponentRow | undefined;
    if (!component) return null;
    const revision = this.database.prepare("SELECT * FROM cms_component_revisions WHERE id = ? AND component_id = ?").get(component.head_revision, component.id) as unknown as ComponentRevisionRow | undefined;
    if (!revision) throw new Error("La revisione corrente del componente non esiste.");
    return componentFromRows(component, revision);
  }

  /**
   * The JavaScript of a document (page, post or component), doc 18 §6.6: what WordPress keeps in
   * `_xb_script`. It is not part of the content, so no paste, import of markup or canvas render ever sees it; the
   * build prints it after the content as a module, and the site preview runs it in its sandbox.
   */
  getDocumentScript(ownerId: string): string {
    if (!ENTITY_ID.test(ownerId)) return "";
    const row = this.database.prepare("SELECT script FROM cms_document_scripts WHERE owner_id = ?").get(ownerId) as { script: string } | undefined;
    return row?.script ?? "";
  }

  /** Stores (or removes, with "") the JavaScript of a document; at most DOCUMENT_SCRIPT_MAX_BYTES, as on WordPress. */
  setDocumentScript(ownerId: string, script: string): void {
    if (!ENTITY_ID.test(ownerId)) throw new TypeError("Documento non valido per il JavaScript.");
    assertDocumentScript(script);
    if (script.trim() === "") this.database.prepare("DELETE FROM cms_document_scripts WHERE owner_id = ?").run(ownerId);
    else this.database.prepare("INSERT INTO cms_document_scripts(owner_id, script, updated_at) VALUES(?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET script = excluded.script, updated_at = excluded.updated_at").run(ownerId, script, new Date().toISOString());
  }

  /**
   * Doc 18 §9 (F7): the reports of the imports that made or updated the project, kept in its database (and so in its
   * backups), the newest IMPORT_REPORTS_MAX. They are not part of the project's revision: reading them changes nothing.
   */
  addImportReport(report: Record<string, unknown>): string {
    const json = JSON.stringify(report);
    if (Buffer.byteLength(json, "utf8") > IMPORT_REPORT_MAX_BYTES) throw new RangeError("Il rapporto d'import è troppo grande per essere conservato.");
    const id = randomUUID();
    this.database.prepare("INSERT INTO cms_import_reports(id, created_at, report_json) VALUES(?, ?, ?)").run(id, new Date().toISOString(), json);
    this.database.prepare("DELETE FROM cms_import_reports WHERE id NOT IN (SELECT id FROM cms_import_reports ORDER BY created_at DESC, rowid DESC LIMIT ?)").run(IMPORT_REPORTS_MAX);
    return id;
  }

  /** The kept import reports, newest first, with what the list shows. */
  listImportReports(): Array<{ id: string; createdAt: string; file: string | null; result: string | null }> {
    const rows = this.database.prepare("SELECT id, created_at, report_json FROM cms_import_reports ORDER BY created_at DESC, rowid DESC").all() as Array<{ id: string; created_at: string; report_json: string }>;
    return rows.map((row) => {
      const report = JSON.parse(row.report_json) as { file?: unknown; result?: unknown };
      return { id: row.id, createdAt: row.created_at, file: typeof report.file === "string" ? report.file : null, result: typeof report.result === "string" ? report.result : null };
    });
  }

  getImportReport(id: string): Record<string, unknown> | null {
    if (!ENTITY_ID.test(id)) return null;
    const row = this.database.prepare("SELECT report_json FROM cms_import_reports WHERE id = ?").get(id) as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as Record<string, unknown> : null;
  }

  /** Adds the conversion's part (notes, measure, framework) to the newest report, as the app sends it after an import. */
  attachConversionReport(conversion: Record<string, unknown>): string | null {
    const row = this.database.prepare("SELECT id, report_json FROM cms_import_reports ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string; report_json: string } | undefined;
    if (!row) return null;
    const json = JSON.stringify({ ...(JSON.parse(row.report_json) as Record<string, unknown>), conversion });
    if (Buffer.byteLength(json, "utf8") > IMPORT_REPORT_MAX_BYTES) throw new RangeError("Il rapporto d'import è troppo grande per essere conservato.");
    this.database.prepare("UPDATE cms_import_reports SET report_json = ? WHERE id = ?").run(json, row.id);
    return row.id;
  }

  getComponentByAlias(alias: number): CmsComponent | null {
    if (!Number.isSafeInteger(alias) || alias < COMPONENT_ALIAS_START) return null;
    const row = this.database.prepare("SELECT id FROM cms_components WHERE alias = ?").get(alias) as { id: string } | undefined;
    return row ? this.getComponentById(row.id) : null;
  }

  getComponentByRef(ref: string): CmsComponent | null {
    if (!COMPONENT_REF_PATTERN.test(ref)) return null;
    const row = this.database.prepare("SELECT id FROM cms_components WHERE ref = ?").get(ref) as { id: string } | undefined;
    return row ? this.getComponentById(row.id) : null;
  }

  getTemplateByRef(ref: string): CmsComponent | null {
    const document = this.getComponentByRef(ref);
    return document?.kind === "template" ? document : null;
  }

  canUseTemplate(ref: string): boolean {
    const template = this.getTemplateByRef(ref);
    return !!template && hasDefaultSlot(template.content);
  }

  createTemplate(input: { ref: string; title: string; id?: string; content?: string; schema?: unknown }): CmsComponent {
    const content = input.content ?? templateStarterDocument();
    return this.createComponent({
      ...input,
      kind: "template",
      content,
      schema: input.schema ?? { props: { page: { type: "object", default: { title: "", slug: "", url: "/" } } } },
    });
  }

  createTemplatePart(input: { ref: string; title: string; id?: string; content?: string; schema?: unknown; area?: CmsTemplatePartArea }): CmsComponent {
    return this.createComponent({ ...input, kind: "template-part", content: input.content ?? "" });
  }

  createComponent(input: { id?: string; kind?: CmsComponentKind; ref: string; title: string; content?: string; schema?: unknown; area?: CmsTemplatePartArea }): CmsComponent {
    const ref = input.ref.trim();
    const title = input.title.trim();
    if (!COMPONENT_REF_PATTERN.test(ref)) throw new TypeError("Chiave del componente non valida secondo la grammatica Histeon.");
    if (!title || title.length > 160) throw new TypeError("Il nome del componente deve contenere da 1 a 160 caratteri.");
    const content = input.content ?? "";
    assertDocumentContent(content);
    const kind = input.kind ?? "component";
    if (!["component", "template-part", "template"].includes(kind)) throw new TypeError("Tipo documento Histeon non valido.");
    const partArea = kind === "template-part" ? input.area ?? "uncategorized" : "uncategorized";
    if (!["header", "footer", "uncategorized"].includes(partArea)) throw new TypeError("Area della parte modello non valida.");
    const schema = validateComponentSchema(input.schema ?? { props: {} });
    const schemaJson = canonicalizeJson(schema);
    const contentHash = digest(canonicalizeJson({ content, ref, schema }));
    const id = input.id ?? randomUUID();
    if (!PROJECT_ID.test(id)) throw new TypeError("Identificativo del componente non valido.");
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM cms_components WHERE ref = ?").get(ref)) throw new Error(`Esiste già un componente con chiave ${ref}.`);
      const highestEntity = Number((this.database.prepare("SELECT COALESCE(MAX(alias), 0) AS max FROM entities").get() as { max: number }).max);
      if (highestEntity >= COMPONENT_ALIAS_START) throw new RangeError("Gli alias delle pagine occupano lo spazio riservato ai componenti.");
      const highestComponent = Number((this.database.prepare("SELECT COALESCE(MAX(alias), ?) AS max FROM cms_components").get(COMPONENT_ALIAS_START - 1) as { max: number }).max);
      const alias = Math.max(COMPONENT_ALIAS_START, highestComponent + 1);
      this.database.prepare("INSERT INTO cms_components(id, alias, kind, part_area, ref, title, head_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, alias, kind, partArea, ref, title, revisionId, now, now);
      this.database.prepare("INSERT INTO cms_component_revisions(id, component_id, parent_id, created_at, content, content_hash, schema_json) VALUES (?, ?, NULL, ?, ?, ?, ?)")
        .run(revisionId, id, now, content, contentHash, schemaJson);
      this.assertComponentGraphAcyclic(id);
      if (kind === "template") {
        if (!hasDefaultSlot(content)) throw new TypeError("Un modello di pagina deve contenere uno slot Histeon predefinito {@slot}.");
        this.assertTemplateReferencesValid(content);
      }
      return this.getComponentById(id)!;
    });
  }

  saveComponent(input: { alias: number; expectedHead: string; content: string; ref: string; schema: unknown }): CmsComponentSaveResult {
    assertDocumentContent(input.content);
    const ref = input.ref.trim();
    if (!COMPONENT_REF_PATTERN.test(ref)) throw new TypeError("Chiave del componente non valida secondo la grammatica Histeon.");
    const schema = validateComponentSchema(input.schema);
    const schemaJson = canonicalizeJson(schema);
    const contentHash = digest(canonicalizeJson({ content: input.content, ref, schema }));
    const now = new Date().toISOString();
    return this.transaction(() => {
      const component = this.database.prepare("SELECT * FROM cms_components WHERE alias = ?").get(input.alias) as unknown as ComponentRow | undefined;
      if (!component) throw new Error("Componente inesistente.");
      const current = this.getComponentById(component.id);
      if (!current) throw new Error("La revisione corrente del componente non esiste.");
      if (input.expectedHead !== current.headRevision) {
        const conflictId = randomUUID();
        this.database.prepare("INSERT INTO cms_component_conflicts(id, component_id, expected_head, actual_head, proposed_content, proposed_ref, proposed_schema_json, proposed_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(conflictId, component.id, input.expectedHead, current.headRevision, input.content, ref, schemaJson, contentHash, now);
        const conflict: CmsComponentConflict = { id: conflictId, componentId: component.id, expectedHead: input.expectedHead, actualHead: current.headRevision, proposedContent: input.content, proposedRef: ref, proposedSchema: schema, proposedHash: contentHash, createdAt: now };
        return { status: "conflict", conflict, current };
      }
      const knownRef = this.database.prepare("SELECT id FROM cms_components WHERE ref = ? AND id <> ?").get(ref, component.id) as { id: string } | undefined;
      if (knownRef) throw new Error(`Esiste già un componente con chiave ${ref}.`);
      if (ref !== component.ref && this.isComponentRefUsed(component.ref, component.id)) {
        throw new Error(`Non posso rinominare ${component.ref}: una pagina o un altro componente lo usa già.`);
      }
      if (contentHash === current.contentHash) return { status: "saved", component: current, revision: current };
      const revisionId = randomUUID();
      this.database.prepare("INSERT INTO cms_component_revisions(id, component_id, parent_id, created_at, content, content_hash, schema_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(revisionId, component.id, current.headRevision, now, input.content, contentHash, schemaJson);
      this.database.prepare("UPDATE cms_components SET ref = ?, head_revision = ?, updated_at = ? WHERE id = ?")
        .run(ref, revisionId, now, component.id);
      if (component.kind === "template") {
        if (!hasDefaultSlot(input.content)) throw new TypeError("Un modello di pagina deve conservare lo slot Histeon predefinito {@slot}.");
        this.assertTemplateReferencesValid(input.content);
      }
      this.assertComponentGraphAcyclic(component.id);
      const saved = this.getComponentById(component.id)!;
      return { status: "saved", component: saved, revision: saved };
    });
  }

  updateComponentTitle(id: string, title: string): CmsComponent {
    const clean = title.trim();
    if (!clean || clean.length > 160) throw new TypeError("Il nome del componente deve contenere da 1 a 160 caratteri.");
    const result = this.database.prepare("UPDATE cms_components SET title = ?, updated_at = ? WHERE id = ?").run(clean, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error("Componente inesistente.");
    return this.getComponentById(id)!;
  }

  updateTemplatePartArea(id: string, area: CmsTemplatePartArea): CmsComponent {
    if (!["header", "footer", "uncategorized"].includes(area)) throw new TypeError("Area della parte modello non valida.");
    const result = this.database.prepare("UPDATE cms_components SET part_area = ?, updated_at = ? WHERE id = ? AND kind = 'template-part'").run(area, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error("Parte di modelli inesistente.");
    return this.getComponentById(id)!;
  }

  /** Gives a template its role in the template hierarchy, or takes it away; one template per role. */
  setTemplateRole(id: string, role: TemplateRole | null): CmsComponent {
    if (role !== null && !(TEMPLATE_ROLES as readonly string[]).includes(role)) throw new TypeError("Ruolo del modello non valido.");
    return this.transaction(() => {
      const template = this.getComponentById(id);
      if (!template || template.kind !== "template") throw new Error("Template inesistente.");
      if (role !== null) {
        const holder = this.database.prepare("SELECT c.title FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.template_role = ? AND c.id <> ? AND t.id IS NULL").get(role, id) as { title: string } | undefined;
        if (holder) throw new Error(`Il ruolo ${role} è già del template «${holder.title}».`);
        // A deleted template keeps its row: free the role so the unique index never blocks a live template.
        this.database.prepare("UPDATE cms_components SET template_role = NULL WHERE template_role = ? AND id <> ?").run(role, id);
      }
      this.database.prepare("UPDATE cms_components SET template_role = ?, updated_at = ? WHERE id = ? AND kind = 'template'").run(role, new Date().toISOString(), id);
      return this.getComponentById(id)!;
    });
  }

  getTemplateByRole(role: TemplateRole): CmsComponent | null {
    const row = this.database.prepare("SELECT c.id FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.kind = 'template' AND c.template_role = ? AND t.id IS NULL").get(role) as { id: string } | undefined;
    return row ? this.getComponentById(row.id) : null;
  }

  private isComponentRefUsed(ref: string, excludedComponentId: string): boolean {
    if (this.database.prepare("SELECT 1 FROM entities WHERE template_ref = ? LIMIT 1").get(ref)) return true;
    const documents = this.database.prepare(`
      SELECT r.content FROM entities e JOIN revisions r ON r.id = e.head_revision
      UNION ALL
      SELECT r.content FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision WHERE c.id <> ?
    `).all(excludedComponentId) as Array<{ content: string }>;
    for (const { content } of documents) {
      const hasRef = (blocks: ReturnType<typeof parseXb>["blocks"]): boolean => blocks.some((block) =>
        (block.name === "xb/component" && block.attrs.ref === ref) || ("children" in block && hasRef(block.children)));
      if (hasRef(parseXb(content).blocks)) return true;
    }
    return false;
  }

  /**
   * Each component a template calls is a live component or part of this project. Only the refs it calls are looked up,
   * each once: before, every component of the project was read (listComponents) at each template created or saved, so
   * a prototype with a thousand components and as many templates read a million of them.
   */
  private assertTemplateReferencesValid(content: string): void {
    const lookup = this.database.prepare("SELECT 1 FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision AND r.component_id = c.id LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.ref = ? AND c.kind IN ('component', 'template-part') AND t.id IS NULL");
    const known = new Set<string>();
    for (const ref of componentCalls(content)) {
      if (known.has(ref)) continue;
      if (!lookup.get(ref)) throw new TypeError(`Il template richiama ${ref}, che non è un componente o una parte del template di questo progetto.`);
      known.add(ref);
    }
  }

  /**
   * After the component or part `componentId` changed in the open transaction (created, saved, or restored from a
   * recoverable deletion: `restoring`): each component it calls exists, and no component calls itself, directly or
   * through others. The graph was acyclic before, since every write that makes a call live goes through here, and only
   * the calls of `componentId` changed (or, for a restore, its calls and the calls to it came back): a new component,
   * or a renamed one, takes a ref that nothing calls (saveComponent refuses to rename a used one, and a deleted one
   * keeps its ref), so a new cycle can only run through `componentId`. So only what it reaches is read, each component
   * once, instead of every component of the project at every save, and a project with a component left calling a
   * deleted one still saves the others. Templates are no part of the graph: nothing calls them, and
   * assertTemplateReferencesValid checks their calls.
   *
   * A component nothing calls is on no cycle: once the transaction holds the index of calls (graphIndex), a component
   * no live component calls is not walked at all. Components created and then saved in the order they depend on each
   * other (a prototype, a transfer: each calling the ones before) are then checked in linear time, where each save
   * used to walk all the ones before it.
   *
   * A restored component may call one that is still deleted: that call is no edge, as for any other component (the
   * user restores them in any order). A cycle it would close is refused with the components on it, and the caller's
   * transaction leaves the deletion as it was.
   */
  private assertComponentGraphAcyclic(componentId: string, restoring = false): void {
    const changed = this.database.prepare("SELECT c.ref, c.kind, r.content FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.id = ? AND t.id IS NULL")
      .get(componentId) as { ref: string; kind: CmsComponentKind; content: string } | undefined;
    if (!changed || changed.kind === "template") return;
    const lookup = this.database.prepare("SELECT c.id, r.content FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.ref = ? AND c.kind IN ('component', 'template-part') AND t.id IS NULL");
    /** The live component or part each ref names, read once per check. */
    const named = new Map<string, { id: string; content: string } | null>();
    const target = (ref: string) => {
      if (!named.has(ref)) named.set(ref, (lookup.get(ref) as { id: string; content: string } | undefined) ?? null);
      return named.get(ref)!;
    };
    const ownCalls = componentCalls(changed.content);
    /** What the walk reaches: the component, its ref, and the one whose call reached it first (null: `componentId`). */
    const pending: Array<{ id: string; content: string; ref: string; from: string | null }> = [];
    for (const ref of ownCalls) {
      const called = target(ref);
      if (called) pending.push({ ...called, ref, from: null });
      else if (!restoring) throw new TypeError(`Il componente ${changed.ref} richiama ${ref}, che non esiste nel progetto.`);
    }
    const index = this.graphIndex;
    if (index) {
      // The index follows the change first: a component that calls itself is then among its own callers.
      for (const ref of index.calls.get(componentId) ?? []) index.callers.get(ref)?.delete(componentId);
      index.calls.set(componentId, ownCalls);
      for (const ref of ownCalls) {
        const callers = index.callers.get(ref);
        if (callers) callers.add(componentId);
        else index.callers.set(ref, new Set([componentId]));
      }
      if (!index.callers.get(changed.ref)?.size) return;
    }
    // Whether `componentId` is among what its calls reach, depth first and without recursion.
    const reached = new Map<string, { ref: string; from: string | null }>();
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next.id === componentId) throw this.componentCycle(changed.ref, next.from, reached, restoring ? (changed.kind === "template-part" ? "la parte di modelli" : "il componente") : null);
      if (reached.has(next.id)) continue;
      reached.set(next.id, { ref: next.ref, from: next.from });
      // A call that names nothing (left by a component deleted since, not by this change) is no edge.
      for (const ref of componentCalls(next.content)) {
        const called = target(ref);
        if (called && !reached.has(called.id)) pending.push({ ...called, ref, from: next.id });
      }
    }
    if (index) return;
    this.graphWalked += reached.size;
    // Only inside an outer transaction (an import, a transfer: more checks follow), once its checks have read as many
    // components as the project has: from then on the index costs less than reading them again.
    if (this.transactionDepth < 2 || this.graphWalked < this.graphIndexAt) return;
    const live = Number((this.database.prepare("SELECT COUNT(*) AS count FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.kind IN ('component', 'template-part') AND t.id IS NULL").get() as { count: number }).count);
    if (this.graphWalked < live) {
      this.graphIndexAt = live;
      return;
    }
    const built: ComponentCallIndex = { callers: new Map(), calls: new Map() };
    const rows = this.database.prepare("SELECT c.id, r.content FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision LEFT JOIN transfer_tombstones t ON t.id = c.id WHERE c.kind IN ('component', 'template-part') AND t.id IS NULL").all() as Array<{ id: string; content: string }>;
    for (const row of rows) {
      const refs = componentCalls(row.content);
      built.calls.set(row.id, refs);
      for (const ref of refs) {
        const callers = built.callers.get(ref);
        if (callers) callers.add(row.id);
        else built.callers.set(ref, new Set([row.id]));
      }
    }
    this.graphIndex = built;
  }

  /**
   * The refusal of a cycle through `ref`, found by the walk of assertComponentGraphAcyclic: `last` is the component whose
   * call came back to it (null: it calls itself), `reached` how the walk got to each one. For a restore (`restoring`
   * names what is restored) the message names the components on the cycle, at most eight, and how to break it.
   */
  private componentCycle(ref: string, last: string | null, reached: Map<string, { ref: string; from: string | null }>, restoring: string | null): TypeError {
    if (restoring === null) return new TypeError("I componenti Histeon non possono richiamarsi in modo ricorsivo.");
    // Back from the last component on the cycle to the first one `ref` calls (the walk's first-reached links form a tree).
    const backwards: string[] = [];
    for (let at = last; at !== null && backwards.length <= reached.size; at = reached.get(at)?.from ?? null) backwards.push(reached.get(at)?.ref ?? "?");
    const hops = backwards.reverse();
    const cycle = [ref, ...hops, ref];
    const shown = cycle.length > 8 ? [...cycle.slice(0, 4), "…", ...cycle.slice(-3)] : cycle;
    const caller = hops.at(-1) ?? ref;
    return new TypeError(`Non è possibile ripristinare ${restoring} ${ref}: chiuderebbe un ciclo di richiami (${shown.join(" → ")}), e i componenti Histeon non possono richiamarsi in modo ricorsivo. Togli prima uno di questi richiami, per esempio quello a ${ref} in ${caller}, poi ripristinalo.`);
  }

  listComponentConflicts(alias: number): CmsComponentConflict[] {
    const component = this.getComponentByAlias(alias);
    if (!component) return [];
    const rows = this.database.prepare("SELECT * FROM cms_component_conflicts WHERE component_id = ? AND resolved_at IS NULL ORDER BY created_at DESC")
      .all(component.id) as unknown as ComponentConflictRow[];
    return rows.map((row) => ({
      id: row.id,
      componentId: row.component_id,
      expectedHead: row.expected_head,
      actualHead: row.actual_head,
      proposedContent: row.proposed_content,
      proposedRef: row.proposed_ref,
      proposedSchema: validateComponentSchema(JSON.parse(row.proposed_schema_json) as unknown),
      proposedHash: row.proposed_hash,
      createdAt: row.created_at,
    }));
  }

  resolveComponentConflict(conflictId: string, content: string, ref: string, schema: unknown): CmsComponentSaveResult {
    const row = this.database.prepare("SELECT * FROM cms_component_conflicts WHERE id = ? AND resolved_at IS NULL").get(conflictId) as unknown as ComponentConflictRow | undefined;
    if (!row) throw new Error("Conflitto componente inesistente o già risolto.");
    const component = this.getComponentById(row.component_id);
    if (!component) throw new Error("Componente del conflitto inesistente.");
    const result = this.saveComponent({ alias: component.alias, expectedHead: row.actual_head, content, ref, schema });
    if (result.status === "saved") this.database.prepare("UPDATE cms_component_conflicts SET resolved_at = ?, resolution_revision = ? WHERE id = ?")
      .run(new Date().toISOString(), result.revision.headRevision, conflictId);
    return result;
  }

  /** What a page says to search engines and social networks, when it is not its title and excerpt. */
  getSeo(id: string): CmsSeo {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = ?").get(`seo.${id}`) as { value: string } | undefined;
    if (!row) return { title: "", description: "", image: "" };
    // A value damaged outside the app reads as no SEO, like the other readings, instead of breaking the page.
    let saved: unknown;
    try { saved = JSON.parse(row.value); } catch { saved = null; }
    return { title: "", description: "", image: "", ...(saved !== null && typeof saved === "object" && !Array.isArray(saved) ? saved as Partial<CmsSeo> : {}) };
  }

  setSeo(id: string, value: { title?: unknown; description?: unknown; image?: unknown }): CmsSeo {
    const text = (entry: unknown, limit: number): string => (typeof entry === "string" ? entry.replace(/\s+/gu, " ").trim().slice(0, limit) : "");
    const seo = { title: text(value.title, 200), description: text(value.description, 400), image: text(value.image, 2000) };
    if (seo.image && !/^(?:https:\/\/|\/__cms-media\/)/u.test(seo.image)) throw new TypeError("L'immagine per i social deve essere dei media del sito o un indirizzo https.");
    if (!seo.title && !seo.description && !seo.image) this.database.prepare("DELETE FROM project_meta WHERE key = ?").run(`seo.${id}`);
    else this.database.prepare("INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`seo.${id}`, JSON.stringify(seo));
    return seo;
  }

  /** Old addresses that lead to the new ones: written when a published content changes address. */
  getRedirects(): CmsRedirect[] {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = 'site.redirects'").get() as { value: string } | undefined;
    if (!row) return [];
    try {
      const saved = JSON.parse(row.value) as unknown;
      return Array.isArray(saved) ? saved as CmsRedirect[] : [];
    } catch { return []; }
  }

  setRedirects(value: unknown): CmsRedirect[] {
    if (!Array.isArray(value) || value.length > 2000) throw new TypeError("Elenco dei reindirizzamenti non valido.");
    const path = /^\/[A-Za-z0-9._~%/-]{0,500}$/u;
    const redirects = value.map((entry) => {
      const item = entry as { from?: unknown; to?: unknown };
      if (typeof item.from !== "string" || typeof item.to !== "string" || !path.test(item.from) || !path.test(item.to) || item.from === item.to || item.from === "/") throw new TypeError("Un reindirizzamento non è valido.");
      return { from: item.from, to: item.to };
    });
    if (redirects.length) this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('site.redirects', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(redirects));
    else this.database.prepare("DELETE FROM project_meta WHERE key = 'site.redirects'").run();
    return redirects;
  }

  /** A published content moved: the old address follows it, and a chain becomes one step. */
  private rememberRedirect(from: string, to: string): void {
    if (from === to) return;
    const kept = this.getRedirects().filter((entry) => entry.from !== from && entry.from !== to).map((entry) => (entry.to === from ? { ...entry, to } : entry));
    this.setRedirects([...kept, { from, to }].slice(-2000));
  }

  /** Which folder each file of the library is in, by name: a view of the library, not a place on disk. */
  getMediaFolders(): Record<string, string> {
    const row = this.database.prepare("SELECT value FROM project_meta WHERE key = 'media.folders'").get() as { value: string } | undefined;
    if (!row) return {};
    try {
      const saved = JSON.parse(row.value) as unknown;
      return saved !== null && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, string> : {};
    } catch { return {}; }
  }

  setMediaFolders(value: unknown): Record<string, string> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Cartelle dei media non valide.");
    const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => /^[0-9a-f-]{36}$/u.test(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1].trim())).map(([id, name]) => [id, name.trim().slice(0, 80)] as const).slice(0, 100_000);
    this.database.prepare("INSERT INTO project_meta(key, value) VALUES ('media.folders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(Object.fromEntries(entries)));
    return Object.fromEntries(entries);
  }

  /** Ids of the media something uses: documents, components, records. A file named nowhere else can go. */
  usedAssetIds(): Set<string> {
    const used = new Set<string>();
    const scan = (text: string): void => { for (const id of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu) ?? []) used.add(id); };
    for (const statement of [
      "SELECT r.content AS text FROM entities e JOIN revisions r ON r.id = e.head_revision",
      "SELECT r.content AS text FROM cms_components c JOIN cms_component_revisions r ON r.id = c.head_revision",
      "SELECT r.payload_json AS text FROM cms_records c JOIN cms_record_revisions r ON r.id = c.head_revision",
      "SELECT asset_id AS text FROM cms_field_values WHERE asset_id IS NOT NULL",
      "SELECT image_asset_id AS text FROM entities WHERE image_asset_id IS NOT NULL",
    ]) for (const row of this.database.prepare(statement).all() as Array<{ text: string }>) scan(row.text);
    return used;
  }

  /** One category or tag on several articles, all or none. */
  bulkAddTerm(ids: readonly string[], taxonomyKey: string, termId: string): number {
    return this.transaction(() => {
      for (const id of ids) {
        const post = this.getEntityById(id);
        if (!post || post.documentType !== "post") throw new TypeError("Si possono categorizzare solo gli articoli.");
        const terms = this.getPostTermIds(id);
        if (terms[taxonomyKey]?.includes(termId)) continue;
        this.updatePostMetadata(id, { title: post.title, slug: post.slug, status: post.status, terms: { ...terms, [taxonomyKey]: [...(terms[taxonomyKey] ?? []), termId] } });
      }
      return ids.length;
    });
  }

  getRevision(id: string): CmsRevision | null {
    if (!ENTITY_ID.test(id)) return null;
    const row = this.database.prepare("SELECT * FROM revisions WHERE id = ?").get(id) as unknown as RevisionRow | undefined;
    return row ? revisionFromRow(row) : null;
  }

  getHead(entityId: string): CmsRevision | null {
    const entity = this.getEntityById(entityId);
    return entity ? this.getRevision(entity.headRevision) : null;
  }

  saveDocument(input: { entityId: string; expectedHead: string | null; content: string; source?: CmsRevision["source"] }): SaveResult {
    assertDocumentContent(input.content);
    const entity = this.getEntityById(input.entityId);
    if (!entity) throw new Error("Pagina inesistente.");
    const now = new Date().toISOString();
    const hash = digest(input.content);
    return this.transaction(() => {
      const currentRow = this.database.prepare("SELECT * FROM entities WHERE id = ?").get(input.entityId) as unknown as EntityRow | undefined;
      if (!currentRow) throw new Error("Pagina inesistente.");
      const current = this.database.prepare("SELECT * FROM revisions WHERE id = ?").get(currentRow.head_revision) as unknown as RevisionRow;
      if (input.expectedHead !== currentRow.head_revision) {
        const conflictId = randomUUID();
        this.database.prepare("INSERT INTO conflicts(id, entity_id, expected_head, actual_head, proposed_content, proposed_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(conflictId, input.entityId, input.expectedHead, currentRow.head_revision, input.content, hash, now);
        return {
          status: "conflict",
          conflict: { id: conflictId, entityId: input.entityId, expectedHead: input.expectedHead, actualHead: currentRow.head_revision, proposedContent: input.content, proposedHash: hash, createdAt: now },
          current: revisionFromRow(current),
        };
      }
      if (current.content_hash === hash) {
        return { status: "saved", entity: entityFromRow(currentRow), revision: revisionFromRow(current) };
      }
      const revisionId = randomUUID();
      const source = input.source ?? "editor";
      this.database.prepare("INSERT INTO revisions(id, entity_id, parent_id, created_at, content, content_hash, source) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(revisionId, input.entityId, currentRow.head_revision, now, input.content, hash, source);
      this.database.prepare("UPDATE entities SET head_revision = ?, updated_at = ? WHERE id = ?")
        .run(revisionId, now, input.entityId);
      const updatedRow = this.database.prepare("SELECT * FROM entities WHERE id = ?").get(input.entityId) as unknown as EntityRow;
      return { status: "saved", entity: entityFromRow(updatedRow), revision: { id: revisionId, entityId: input.entityId, parentId: currentRow.head_revision, createdAt: now, content: input.content, contentHash: hash, source } };
    });
  }

  listRevisions(entityId: string, limit = 100): CmsRevision[] {
    const rows = this.database.prepare("SELECT * FROM revisions WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?").all(entityId, Math.max(1, Math.min(500, limit))) as unknown as RevisionRow[];
    return rows.map(revisionFromRow);
  }

  listConflicts(entityId?: string): CmsConflict[] {
    const rows = entityId
      ? this.database.prepare("SELECT * FROM conflicts WHERE entity_id = ? AND resolved_at IS NULL ORDER BY created_at DESC").all(entityId)
      : this.database.prepare("SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC").all();
    return (rows as unknown as ConflictRow[]).map(conflictFromRow);
  }

  resolveConflict(conflictId: string, content: string): SaveResult {
    assertDocumentContent(content);
    const row = this.database.prepare("SELECT * FROM conflicts WHERE id = ? AND resolved_at IS NULL").get(conflictId) as unknown as ConflictRow | undefined;
    if (!row) throw new Error("Conflitto inesistente o già risolto.");
    const result = this.saveDocument({ entityId: row.entity_id, expectedHead: row.actual_head, content, source: "conflict-resolution" });
    if (result.status === "conflict") return result;
    this.database.prepare("UPDATE conflicts SET resolved_at = ?, resolution_revision = ? WHERE id = ?").run(new Date().toISOString(), result.revision.id, conflictId);
    return result;
  }

  /**
   * Saves an image or font: one row per bytes, alt and caption (the same three again give the row already there), one
   * file per bytes, which rows with the same bytes share. The file is put in place by storeMediaFile even when the row
   * exists already: saving the same bytes again repairs a media file that went missing or lost its bytes outside the
   * app, the repair the refusal of a backup holding it tells the user to make (damagedMedia, missingMedia).
   *
   * An upload with no alt and no caption (the builder's, POST …/media: its texts are given afterwards, on the row it
   * gets back) of bytes the library holds already gets the row of those bytes, one with no texts if there is one,
   * otherwise the oldest: in the library an item is its image, and the builder inserts it with the alt of the row it
   * gets back. Before, an image with an alt (every image of a prototype that has one) got a second row at each upload of
   * the same file, an item the app cannot delete, and following the repair advice of a backup added one every time.
   * Rows deleted recoverably are never given back (their media is not served, the image would show broken), and an
   * explicit id (an import) always gets that id.
   */
  saveAsset(input: { bytes: Uint8Array; mimeType: string; filename: string; alt?: string; caption?: string; id?: string }): { id: string; alias: number; sha256: string; mimeType: string; filename: string; alt: string; caption: string; relativePath: string } {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const alt = input.alt ?? "";
    const caption = input.caption ?? "";
    const live = "SELECT a.* FROM assets a LEFT JOIN transfer_tombstones t ON t.id = a.id WHERE t.id IS NULL AND a.sha256 = ?";
    const existing = input.id
      ? this.database.prepare("SELECT * FROM assets WHERE id = ?").get(input.id) as unknown as AssetRow | undefined
      : alt === "" && caption === ""
        ? this.database.prepare(`${live} ORDER BY (a.alt = '' AND a.caption = '') DESC, a.alias LIMIT 1`).get(sha256) as unknown as AssetRow | undefined
        : this.database.prepare(`${live} AND a.alt = ? AND a.caption = ? ORDER BY a.alias LIMIT 1`).get(sha256, alt, caption) as unknown as AssetRow | undefined;
    if (existing && input.id && (existing.sha256 !== sha256 || existing.alt !== alt || existing.caption !== caption)) throw new Error("L’identità asset richiesta esiste già con contenuto o metadati diversi.");
    const relativePath = `media/sha256/${sha256.slice(0, 2)}/${sha256}`;
    if (this.mediaFiles) this.mediaFiles.store(sha256, input.bytes);
    else storeMediaFile(this.mediaDirectory, sha256, input.bytes, this.durable);
    if (existing) return assetFromRow(existing);
    const id = input.id ?? randomUUID();
    if (!PROJECT_ID.test(id)) throw new TypeError("Identificativo dell’immagine non valido.");
    const alias = Number((this.database.prepare("SELECT COALESCE(MAX(alias), 0) + 1 AS next FROM assets").get() as { next: number }).next);
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO assets(id, alias, sha256, mime_type, filename, alt, caption, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, alias, sha256, input.mimeType, path.basename(input.filename), alt, caption, relativePath, now);
    return { id, alias, sha256, mimeType: input.mimeType, filename: path.basename(input.filename), alt, caption, relativePath };
  }

  listAssets(): Array<{ id: string; alias: number; sha256: string; mimeType: string; filename: string; alt: string; caption: string; relativePath: string }> {
    const rows = this.database.prepare("SELECT a.* FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE t.id IS NULL ORDER BY a.created_at, a.id").all() as unknown as AssetRow[];
    return rows.map(assetFromRow);
  }

  getAssetByAlias(alias: number): ReturnType<typeof assetFromRow> | null {
    if (!Number.isSafeInteger(alias) || alias < 1) return null;
    const row = this.database.prepare("SELECT a.* FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE a.alias = ? AND t.id IS NULL").get(alias) as unknown as AssetRow | undefined;
    return row ? assetFromRow(row) : null;
  }

  updateAsset(alias: number, input: { alt?: string; caption?: string }): ReturnType<typeof assetFromRow> | null {
    const current = this.getAssetByAlias(alias);
    if (!current) return null;
    const alt = input.alt ?? current.alt;
    const caption = input.caption ?? current.caption;
    if (alt.length > 2000 || caption.length > 8000) throw new RangeError("I metadati dell’immagine superano il limite consentito.");
    this.database.prepare("UPDATE assets SET alt = ?, caption = ? WHERE alias = ?").run(alt, caption, alias);
    return this.getAssetByAlias(alias);
  }

  replaceAsset(input: { id: string; bytes: Uint8Array; mimeType: string; filename: string; alt: string; caption: string }): ReturnType<typeof assetFromRow> {
    const current = this.database.prepare("SELECT * FROM assets WHERE id = ?").get(input.id) as unknown as AssetRow | undefined;
    if (!current) return this.saveAsset(input);
    if (input.alt.length > 2000 || input.caption.length > 8000) throw new RangeError("I metadati dell’immagine superano il limite consentito.");
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const relativePath = `media/sha256/${sha256.slice(0, 2)}/${sha256}`;
    // As saveAsset: never written in place (a crash mid-write left a truncated file under the final name, kept forever
    // after since an existing file was never rewritten), and a damaged or missing file with these bytes is repaired.
    if (this.mediaFiles) this.mediaFiles.store(sha256, input.bytes);
    else storeMediaFile(this.mediaDirectory, sha256, input.bytes, this.durable);
    this.database.prepare("UPDATE assets SET sha256 = ?, mime_type = ?, filename = ?, alt = ?, caption = ?, relative_path = ? WHERE id = ?")
      .run(sha256, input.mimeType, path.basename(input.filename), input.alt, input.caption, relativePath, input.id);
    return this.getAssetByAlias(current.alias)!;
  }

  updatePageMetadata(id: string, input: { title: string; slug: string; status: "draft" | "published"; templateRef?: string | null }): CmsEntity {
    const title = input.title.trim();
    const slug = slugify(input.slug);
    if (!title || title.length > 500) throw new TypeError("Il titolo della pagina non è valido.");
    const moved = this.getEntityById(id);
    const current = this.database.prepare("SELECT template_ref, locale FROM entities WHERE id = ? AND kind = 'page' AND document_type = 'page'").get(id) as { template_ref: string | null; locale: string | null } | undefined;
    if (!current) throw new Error("Pagina inesistente.");
    const templateRef = input.templateRef === undefined ? current.template_ref : input.templateRef;
    if (templateRef !== null && !this.canUseTemplate(templateRef)) throw new TypeError(`Il template ${templateRef} non contiene uno slot Histeon predefinito per la pagina.`);
    this.transaction(() => {
      const duplicate = this.database.prepare("SELECT e.id FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.kind = 'page' AND e.document_type = 'page' AND e.slug = ? AND e.locale IS ? AND e.id <> ? AND t.id IS NULL").get(slug, current.locale, id) as { id: string } | undefined;
      if (duplicate) throw new Error(`Esiste già una pagina con slug ${slug}.`);
      // Only a rename that goes through leaves the old address leading to the new one, in the same transaction.
      if (moved && moved.status === "published" && moved.slug !== slug && moved.slug !== "home" && moved.locale === null) this.rememberRedirect(`/${moved.slug}/`, `/${slug}/`);
      this.database.prepare("UPDATE entities SET title = ?, slug = ?, status = ?, template_ref = ?, updated_at = ? WHERE id = ? AND kind = 'page'")
        .run(title, slug, input.status, templateRef, new Date().toISOString(), id);
    });
    const entity = this.getEntityById(id);
    if (!entity || entity.kind !== "page") throw new Error("Pagina inesistente.");
    return entity;
  }

  /** Whether anything in this project was ever synchronized with that remote site. */
  hasSyncBases(remoteSiteId: string): boolean {
    return this.database.prepare("SELECT 1 FROM sync_bases WHERE remote_site_id = ? LIMIT 1").get(remoteSiteId) !== undefined;
  }

  getSyncBase(remoteSiteId: string, entityId: string): { remoteSiteId: string; entityId: string; remoteProjectId: string; baseHash: string; updatedAt: string } | null {
    const row = this.database.prepare("SELECT remote_site_id, entity_id, remote_project_id, base_hash, updated_at FROM sync_bases WHERE remote_site_id = ? AND entity_id = ?").get(remoteSiteId, entityId) as { remote_site_id: string; entity_id: string; remote_project_id: string; base_hash: string; updated_at: string } | undefined;
    return row ? { remoteSiteId: row.remote_site_id, entityId: row.entity_id, remoteProjectId: row.remote_project_id, baseHash: row.base_hash, updatedAt: row.updated_at } : null;
  }

  deleteSyncBase(remoteSiteId: string, entityId: string): boolean {
    if (!ENTITY_ID.test(remoteSiteId) || !ENTITY_ID.test(entityId)) throw new TypeError("Identità della base comune non valida.");
    return this.database.prepare("DELETE FROM sync_bases WHERE remote_site_id = ? AND entity_id = ?").run(remoteSiteId, entityId).changes > 0;
  }

  isTransferEntityDeleted(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM transfer_tombstones WHERE id = ?").get(id));
  }

  listTransferTombstones(scope?: "remote" | "local"): TransferEntity[] {
    const rows = (scope
      ? this.database.prepare("SELECT entity_json FROM transfer_tombstones WHERE scope=? ORDER BY id").all(scope)
      : this.database.prepare("SELECT entity_json FROM transfer_tombstones ORDER BY id").all()) as Array<{ entity_json: string }>;
    return rows.map((row) => JSON.parse(row.entity_json) as TransferEntity);
  }

  applyTransferTombstone(entity: TransferEntity, verifiedCurrentHash: string): void {
    this.applyTransferTombstones([{ entity, verifiedCurrentHash }]);
  }

  applyTransferTombstones(deletions: Array<{ entity: TransferEntity; verifiedCurrentHash: string; scope?: "remote" | "local" }>): void {
    const allowedKinds = new Set(["document", "content-record", "component", "template-part", "template", "asset"]);
    const prepared = deletions.map(({ entity, verifiedCurrentHash, scope = "remote" }) => {
      validateTransferEntity(entity);
      const entityKind = String(entity.payload.entityKind);
      if (entity.kind !== "tombstone" || !allowedKinds.has(entityKind)) throw new TypeError("Questo tipo di cancellazione non è ancora applicabile localmente.");
      if (!/^[0-9a-f]{64}$/u.test(verifiedCurrentHash) || entity.payload.previousRevisionHash !== verifiedCurrentHash) throw new TypeError("La cancellazione non corrisponde alla revisione locale verificata.");
      const deletedAt = entity.payload.deletedAt;
      if (typeof deletedAt !== "string") throw new TypeError("Data della tombstone non valida.");
      return { entity, entityKind, deletedAt, scope };
    });
    const deletionIds = prepared.map(({ entity }) => entity.id);
    if (new Set(deletionIds).size !== deletionIds.length) throw new TypeError("Una stessa entità compare più volte nel piano di cancellazione.");
    this.transaction(() => {
      // A deleted component's calls are no longer live: the index of calls of the open transaction is dropped.
      this.dropComponentGraphIndex();
      for (const { entity, entityKind } of prepared) {
        if (entityKind === "document") {
          const current = this.database.prepare("SELECT e.id FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.id=? AND e.kind='page' AND t.id IS NULL").get(entity.id);
          if (!current) throw new TypeError(`La pagina ${entity.id} non esiste più nel progetto locale.`);
        } else if (entityKind === "content-record") {
          if (!this.content.getRecordById(entity.id, true)) throw new TypeError(`Il record CMS ${entity.id} non esiste più nel progetto locale.`);
        } else if (["component", "template-part", "template"].includes(entityKind)) {
          const current = this.database.prepare("SELECT c.kind FROM cms_components c LEFT JOIN transfer_tombstones t ON t.id=c.id WHERE c.id=? AND t.id IS NULL").get(entity.id) as { kind: string } | undefined;
          if (!current || current.kind !== entityKind) throw new TypeError(`Il contenuto Histeon ${entity.id} non esiste più nel progetto locale o ha cambiato tipo.`);
        } else if (entityKind === "asset") {
          const current = this.database.prepare("SELECT a.id FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE a.id=? AND t.id IS NULL").get(entity.id);
          if (!current) throw new TypeError(`Il media Histeon ${entity.id} non esiste più nel progetto locale.`);
        }
      }
      const recordDeletions = prepared.filter(({ entityKind }) => entityKind === "content-record").map(({ entity, deletedAt }) => ({ id: entity.id, deletedAt }));
      this.content.markRecordsDeleted(recordDeletions);
      for (const { entity, entityKind, deletedAt, scope } of prepared) {
        const result = this.database.prepare("INSERT INTO transfer_tombstones(id,entity_kind,deleted_at,entity_json,scope) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
          .run(entity.id, entityKind, deletedAt, canonicalizeJson(entity as never), scope);
        if (result.changes !== 1) throw new TypeError("Una cancellazione recuperabile esiste già per questa identità.");
      }
    });
  }

  /**
   * Takes a recoverable deletion back. A component or part brings back its calls, and the calls of the components that
   * call it: it never went through saveComponent, so the graph is checked here, as a save checks it
   * (assertComponentGraphAcyclic). While it was deleted a call to it was no edge, so another component could be saved
   * calling one that calls it: restoring it would close that cycle, and is refused (a TypeError naming the components
   * on it); the deletion stays as it was. A call of the restored component to one still deleted is no edge: the user
   * restores them in any order.
   */
  restoreTransferTombstone(id: string): boolean {
    if (!ENTITY_ID.test(id)) return false;
    const row = this.database.prepare("SELECT entity_kind FROM transfer_tombstones WHERE id=?").get(id) as { entity_kind: string } | undefined;
    if (!row) return false;
    if (row.entity_kind === "document") {
      const page = this.database.prepare("SELECT slug, document_type, locale FROM entities WHERE id=? AND kind='page'").get(id) as { slug: string; document_type: CmsDocumentType; locale: string | null } | undefined;
      if (!page) return false;
      const collision = this.database.prepare("SELECT 1 FROM entities e LEFT JOIN transfer_tombstones t ON t.id=e.id WHERE e.kind='page' AND e.document_type=? AND e.slug=? AND e.locale IS ? AND e.id<>? AND t.id IS NULL").get(page.document_type, page.slug, page.locale, id);
      if (collision) throw new TypeError(page.document_type === "post" ? "Non è possibile ripristinare l'articolo: un altro articolo usa già questo indirizzo." : "Non è possibile ripristinare la pagina: un’altra pagina usa già questo indirizzo.");
    }
    if (row.entity_kind === "content-record" && !this.content.isRecordDeleted(id)) return false;
    if (["component", "template-part", "template"].includes(row.entity_kind)) {
      const entity = this.database.prepare("SELECT kind FROM cms_components WHERE id=?").get(id) as { kind: string } | undefined;
      if (!entity || entity.kind !== row.entity_kind) return false;
    }
    if (row.entity_kind === "asset" && !this.database.prepare("SELECT 1 FROM assets WHERE id=?").get(id)) return false;
    return this.transaction(() => {
      if (row.entity_kind === "content-record" && !this.content.restoreRecord(id)) return false;
      const restored = this.database.prepare("DELETE FROM transfer_tombstones WHERE id=?").run(id).changes > 0;
      if (restored && (row.entity_kind === "component" || row.entity_kind === "template-part")) {
        // Its calls are live again, and the index of calls (if the transaction has one) does not hold them.
        this.dropComponentGraphIndex();
        this.assertComponentGraphAcyclic(id, true);
      }
      return restored;
    });
  }

  async createDeletionRecoveryBackup(operationId: string): Promise<string> {
    if (!PROJECT_ID.test(operationId)) throw new TypeError("Identificativo operazione di recupero non valido.");
    const directory = path.join(this.directory, "recovery");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || !privateMode(info.mode)) throw new TypeError("La cartella di recupero non è privata e regolare.");
    const projectRoot = await realpath(this.directory);
    const recoveryRoot = await realpath(directory);
    const relative = path.relative(projectRoot, recoveryRoot);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new TypeError("La cartella di recupero esce dal progetto.");
    const target = path.join(recoveryRoot, `before-delete-${operationId}.sqlite`);
    try {
      const existing = await readFile(target);
      if (existing.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new TypeError("La copia di recupero già presente non è SQLite.");
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const bytes = await this.createDatabaseSnapshot();
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (existing.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new TypeError("La copia di recupero concorrente non è SQLite.");
    }
    return target;
  }

  setSyncBase(remoteSiteId: string, remoteProjectId: string, entityId: string, baseHash: string): void {
    if (!ENTITY_ID.test(remoteSiteId) || !ENTITY_ID.test(remoteProjectId) || !ENTITY_ID.test(entityId) || !/^[0-9a-f]{64}$/u.test(baseHash)) throw new TypeError("Base comune remoto non valida.");
    this.database.prepare("INSERT INTO sync_bases(remote_site_id, entity_id, remote_project_id, base_hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(remote_site_id, entity_id) DO UPDATE SET remote_project_id = excluded.remote_project_id, base_hash = excluded.base_hash, updated_at = excluded.updated_at")
      .run(remoteSiteId, entityId, remoteProjectId, baseHash, new Date().toISOString());
  }

  /**
   * The media file at `relativePath`, named `sha256`, after the checks every read of it makes (the same a restore makes on
   * a backup holding it): a sha256 path whose folder and name match the digest, in the project's media folder as a real
   * folder (assertMediaFolderReadable: the refusal its writes make), a regular file (never a symlink), inside the
   * project. `bytes` is its size, measured without reading it.
   */
  private async mediaFile(relativePath: string, sha256: string): Promise<{ resolved: string; bytes: number }> {
    const match = PROJECT_MEDIA_PATH.exec(relativePath);
    if (!match || match[2] !== sha256 || match[1] !== sha256.slice(0, 2)) throw new TypeError("Percorso media del progetto non valido.");
    await assertMediaFolderReadable(this.mediaDirectory);
    const target = path.join(this.directory, relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("Il file media non è un file regolare del progetto.");
    const root = await realpath(this.directory);
    const resolved = await realpath(target);
    if (!strictlyInside(root, resolved)) throw new TypeError("Il file media esce dalla cartella del progetto.");
    return { resolved, bytes: info.size };
  }

  /**
   * `use` of `media`, one file a backup holds, after the checks of mediaFile. A file gone from the project (deleted or
   * moved outside the app), before the checks or while `use` reads it, is a backup its restore would refuse, as a
   * damaged one is: missingMedia, never the raw ENOENT with the data folder's path in it.
   */
  private async backupMediaFile<T>(media: { relativePath: string; sha256: string; filename: string }, use: (file: { resolved: string; bytes: number }) => T | Promise<T>): Promise<T> {
    try { return await use(await this.mediaFile(media.relativePath, media.sha256)); }
    catch (error) { throw notFound(error) ? missingMedia(media.filename) : error; }
  }

  /** The file of live asset `id` after the checks of mediaFile. Null when there is no such asset. */
  private async assetFile(id: string): Promise<{ row: AssetRow; resolved: string } | null> {
    const row = this.database.prepare("SELECT a.* FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE a.id = ? AND t.id IS NULL").get(id) as unknown as AssetRow | undefined;
    if (!row) return null;
    return { row, resolved: (await this.mediaFile(row.relative_path, row.sha256)).resolved };
  }

  async readAsset(id: string): Promise<{ metadata: CmsAssetMetadata; bytes: Uint8Array } | null> {
    if (this.mediaFiles) {
      const row = this.database.prepare("SELECT a.* FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE a.id = ? AND t.id IS NULL").get(id) as unknown as AssetRow | undefined;
      const bytes = row ? this.mediaFiles.read(row.sha256) : undefined;
      return row && bytes ? { metadata: assetFromRow(row), bytes } : null;
    }
    const file = await this.assetFile(id);
    return file ? { metadata: assetFromRow(file.row), bytes: await readFile(file.resolved) } : null;
  }

  async checkpoint(): Promise<void> {
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
  }

  /**
   * Writes a copy of the database into `target`, which must not exist or be empty. VACUUM INTO reads in one
   * transaction: in WAL mode the copy is what was committed when it started, whatever other connections are writing
   * (their open transactions are not in it, and they are not blocked).
   */
  snapshotDatabaseInto(target: string): void {
    if (this.transactionDepth > 0 || this.database.isTransaction) throw new Error("La copia del database non può partire dentro una transazione.");
    this.database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  }

  async createDatabaseSnapshot(): Promise<Buffer> {
    return this.withSnapshotPath(async (snapshotPath) => {
      const quotedPath = snapshotPath.replaceAll("'", "''");
      this.database.exec(`VACUUM INTO '${quotedPath}'`);
      return await readFile(snapshotPath);
    });
  }

  /**
   * `use` of a new path for a database snapshot in the project folder (`.snapshot-<uuid>.sqlite`: SNAPSHOT_NAME), which
   * is removed when `use` settles. Meanwhile its name is in SNAPSHOTS_IN_USE, so no sweep of this process removes it,
   * whatever store or catalog runs the sweep. The project folder is swept first (sweepStaleSnapshots): a crash or a hard
   * kill while `use` ran leaves the copy of the whole database behind, and before nothing removed it.
   */
  private async withSnapshotPath<T>(use: (snapshotPath: string) => Promise<T>): Promise<T> {
    await sweepStaleSnapshots(this.directory);
    const name = `.snapshot-${randomUUID()}.sqlite`;
    const snapshotPath = path.join(this.directory, name);
    SNAPSHOTS_IN_USE.add(name);
    try {
      return await use(snapshotPath);
    } finally {
      try { await rm(snapshotPath, { force: true }); }
      finally { SNAPSHOTS_IN_USE.delete(name); }
    }
  }

  /**
   * One backup of the project, as its restore must find it, for `use` (encodeNativeProjectArchive). The database is
   * copied once, as createDatabaseSnapshot does (VACUUM INTO, here into a private file), and the copy passes the
   * restore's own checks. The media are the files of the copy's live assets, one per file (rows with the same bytes and
   * another alt or caption share it): those of the snapshot, not of the project now, so an asset saved or removed
   * meanwhile never leaves the database and the files apart. `sizes` are exact and cost no reading: the copy measured on
   * disk, the media after the checks readAsset makes, so the limits can be checked before anything is read. `read` gives
   * the bytes of one of those files with their sha256, a media file after the same checks again and only if its bytes
   * still match its name. Refusals a restore would make are CmsBackupUnrestorableError, a media file gone from the
   * project (measured or read) among them, and those of a media file say how to repair it (damagedMedia, missingMedia).
   * The copy is removed when `use` settles, and one a crash left is swept (withSnapshotPath).
   */
  async withBackupSnapshot<T>(use: (snapshot: { sizes: NativeBackupSizes; read: (filePath: string) => Promise<{ bytes: Buffer; sha256: string }> }) => Promise<T>): Promise<T> {
    return this.withSnapshotPath(async (snapshotPath) => {
      // Created empty and private first: VACUUM INTO fills an empty file and keeps its mode.
      await writeFile(snapshotPath, new Uint8Array(), { flag: "wx", mode: 0o600 });
      this.snapshotDatabaseInto(snapshotPath);
      const files = backupDatabaseMedia(snapshotPath);
      const media: Array<{ path: string; bytes: number }> = [];
      for (const file of files.values()) media.push({ path: file.relativePath, bytes: await this.backupMediaFile(file, (found) => found.bytes) });
      const sizes: NativeBackupSizes = { database: (await lstat(snapshotPath)).size, media };
      return await use({
        sizes,
        read: async (filePath) => {
          if (filePath === "content.sqlite") {
            const bytes = await readFile(snapshotPath);
            return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
          }
          const file = files.get(filePath);
          if (!file) throw new TypeError("Il file non fa parte del backup.");
          const bytes = await this.backupMediaFile(file, (found) => readFile(found.resolved));
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (sha256 !== file.sha256) throw damagedMedia(file.filename);
          return { bytes, sha256 };
        },
      });
    });
  }
}

/**
 * The database snapshots this process is using now, by file name (SNAPSHOT_NAME: a fresh UUID each), whatever store
 * took them, so that no sweep of this process removes one (sweepStaleSnapshots). Several stores of the same project may
 * be open at once, each from its own catalog.
 */
const SNAPSHOTS_IN_USE = new Set<string>();

/** The name of a database snapshot in a project folder (CmsProjectStore.withSnapshotPath), and nothing else. */
const SNAPSHOT_NAME = /^\.snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/u;

/**
 * How old a snapshot no store of this process is using must be before a sweep removes it: another process may be using
 * it (the desktop app and `histos-publish ui` open the same data folder by default). An hour, as for the scratch
 * folders of prototype checks (removeStalePrototypeScratch): a snapshot lives while a backup is made from it, seconds.
 */
const SNAPSHOT_STALE_MS = 3_600_000;

/**
 * Removes from the project folder `directory` the database snapshots a crash or a hard kill left there (each a full
 * copy of the database; withSnapshotPath removes its own when it settles): only entries named as a snapshot
 * (SNAPSHOT_NAME), regular files by lstat (never a symlink, nor what it points to; never a folder), not in use in this
 * process (SNAPSHOTS_IN_USE, looked at again right before the removal) and older than SNAPSHOT_STALE_MS. unlink never
 * follows a symlink, so an entry swapped after lstat costs only that entry. Best effort: what it cannot read or remove
 * stays, and it never fails the snapshot or the start it runs before.
 */
async function sweepStaleSnapshots(directory: string): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); }
  catch { return; }
  const limit = Date.now() - SNAPSHOT_STALE_MS;
  for (const name of names) {
    if (!SNAPSHOT_NAME.test(name) || SNAPSHOTS_IN_USE.has(name)) continue;
    const file = path.join(directory, name);
    try {
      const found = await lstat(file);
      if (!found.isFile() || found.mtimeMs >= limit || SNAPSHOTS_IN_USE.has(name)) continue;
      await unlink(file);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

interface AssetRow { id: string; alias: number; sha256: string; mime_type: string; filename: string; alt: string; caption: string; relative_path: string }
function assetFromRow(row: AssetRow): CmsAssetMetadata {
  return { id: row.id, alias: row.alias, sha256: row.sha256, mimeType: row.mime_type, filename: row.filename, alt: row.alt, caption: row.caption, relativePath: row.relative_path };
}
function parseJson(content: string): unknown {
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) throw new RangeError("Il documento supera il limite di 8 MiB.");
  try { return JSON.parse(content) as unknown; } catch { throw new TypeError("Il documento deve contenere JSON valido."); }
}

/**
 * Writes `bytes` into a new private file at `filePath` (never over an existing one), all of them: writeSync may write
 * fewer bytes than asked (a disk almost full writes what fits, and only the next call fails with ENOSPC), and a file
 * cut short this way would be renamed under a sha256 name its bytes no longer match. Flushed to disk before it is
 * closed, so the rename that publishes it never outlives its bytes in a crash (a file of zeros or none at all, under a
 * name the database already gives an asset), unless the file is a scratch copy's (`durable` false: removed after use,
 * nothing reads it after a crash).
 */
function writeFileSyncSafe(filePath: string, bytes: Uint8Array, durable: boolean): void {
  const fd = openSync(filePath, "wx", 0o600);
  try {
    for (let written = 0; written < bytes.byteLength;) {
      const count = writeSync(fd, bytes, written, bytes.byteLength - written);
      if (count <= 0) throw new Error("Il file media non si scrive per intero.");
      written += count;
    }
    if (durable) fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Whether the media file at `target` is a regular file holding exactly `bytes` (the bytes its sha256 name was made
 * from). Never through a symlink, never blocking on a special file swapped in after lstat: such an entry, a file of
 * another size or other bytes, or none at all, is one storeMediaFile replaces. So is one it cannot open or read, for
 * whatever reason (EACCES or EPERM: its permissions changed outside the app; EIO; gone or swapped since lstat): it is
 * not known to hold the bytes, and the rename that replaces it needs no access to it. Before, such an error reached
 * the user, a 500 with the data folder's path, and no upload of those bytes could save. Read a MiB at a time, as the
 * bytes it is compared with are in memory already.
 */
function mediaFileHolds(target: string, bytes: Uint8Array): boolean {
  let fd: number | undefined;
  try {
    const found = lstatSync(target, { throwIfNoEntry: false });
    if (!found?.isFile() || found.size !== bytes.byteLength) return false;
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== bytes.byteLength) return false;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, bytes.byteLength)));
    for (let offset = 0; offset < bytes.byteLength;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.byteLength, bytes.byteLength - offset), offset);
      if (read === 0 || !buffer.subarray(0, read).equals(bytes.subarray(offset, offset + read))) return false;
      offset += read;
    }
    // Nothing past the bytes compared: a file that grew since fstat holds other bytes.
    return readSync(fd, buffer, 0, 1, bytes.byteLength) === 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Only read: nothing of it to lose. */ }
    }
  }
}

/**
 * Moves the entry at `entry` (a file, a symlink, a folder: never followed) aside, to a free name next to it that says
 * so, so that what the app expects can take its name. Nothing is deleted: it was put there outside the app, and may be
 * someone's. Renamed, so it stays on the same file system, in the same private folder.
 */
function moveAside(entry: string): void {
  renameSyncSafe(entry, `${entry}.displaced-${randomUUID()}`);
}

/**
 * The refusal of every read and every write of media while the project's media folder is there but is not a real
 * folder: a symlink (lstat: whatever it points to, inside the project or out of it), a file, anything the store never
 * puts there. The same for both, and it says what to do, without a path. The project's folder is the boundary of what
 * the app reads and writes for it (threat model P5: real paths checked against the root, symlinks out of it blocked; as
 * P27 does for the agent's reads, every level is checked with lstat), and media are written with bytes that come from
 * outside (an upload, a prototype, the agent's import), so they are never written through a link to a place someone
 * chose; a symlink there can only come from outside the app (a process of the same user, P29). Reads used to
 * follow such a folder while it stayed inside the project and refuse it otherwise («esce dalla cartella del
 * progetto»), and a backup that met it asked for an upload that could only be refused: now reads, writes, backups and
 * the copy of a project all refuse it the same way. Allowing it instead would move the boundary to wherever the link
 * points, for writes from the agent too. A media folder moved to another disk goes back into the project as a real
 * folder; nothing in it is lost meanwhile, as the app never moves or deletes it.
 */
const MEDIA_FOLDER_NOT_REAL = "La cartella media del progetto non è una cartella vera (per esempio è un collegamento a un'altra cartella o a un altro disco): Histeon Publish non legge e non salva media fuori dalla cartella del progetto. Riporta i media in una cartella «media» vera dentro la cartella del progetto.";

/**
 * Refuses (MEDIA_FOLDER_NOT_REAL) a media folder at `mediaDirectory` that is there and is not a real folder, before a
 * read of a media file in it. One that is not there is no refusal: its files are missing, as the read then finds
 * (missingMedia for a backup), and the upload that repairs one makes the folder again (mediaFolder).
 */
async function assertMediaFolderReadable(mediaDirectory: string): Promise<void> {
  let found: Awaited<ReturnType<typeof lstat>>;
  try { found = await lstat(mediaDirectory); }
  catch (error) {
    if (notFound(error)) return;
    throw error;
  }
  if (!found.isDirectory()) throw new TypeError(MEDIA_FOLDER_NOT_REAL);
}

/**
 * The folder of the media file named `sha256`, media/sha256/<its first two digits>, as a real folder inside the
 * project's media folder. Each level is checked with lstat and made private where it is missing, so nothing is
 * created or written through a symlink. A level that is not a folder (a file, a symlink, anything the app never puts
 * there) was put there outside the app: it is moved aside (moveAside), and the folder takes its place. Before, the
 * upload that the refusal of a backup tells the user to make, to repair a media file whose folder had become a file,
 * failed with a raw EEXIST and the data folder's path. The media folder itself is never replaced: it is the project's
 * boundary, made by the store, and if it is not a real folder no media is written (MEDIA_FOLDER_NOT_REAL, as reads).
 */
function mediaFolder(mediaDirectory: string, sha256: string): string {
  const media = lstatSync(mediaDirectory, { throwIfNoEntry: false });
  if (media && !media.isDirectory()) throw new TypeError(MEDIA_FOLDER_NOT_REAL);
  if (!media) {
    try { mkdirSync(mediaDirectory, { mode: 0o700 }); }
    catch (error) {
      // Made by a concurrent save of the same project: only a real folder will do.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(mediaDirectory).isDirectory()) throw new TypeError(MEDIA_FOLDER_NOT_REAL);
    }
  }
  let folder = mediaDirectory;
  for (const name of ["sha256", sha256.slice(0, 2)]) {
    folder = path.join(folder, name);
    const found = lstatSync(folder, { throwIfNoEntry: false });
    if (found?.isDirectory()) continue;
    if (found) moveAside(folder);
    try { mkdirSync(folder, { mode: 0o700 }); }
    catch (error) {
      // Made by a concurrent save of the same project: only a real folder will do.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(folder).isDirectory()) throw error;
    }
  }
  return folder;
}

/**
 * Puts `bytes` into the project's media folder, as the file named by their sha256 (in mediaFolder), the one way media
 * files are written: unless a regular file there holds exactly them already (mediaFileHolds), they go into a new
 * private file next to it, written exclusively and in full (writeFileSyncSafe, flushed to disk when `durable`), which
 * is then renamed over the name. Atomic: a reader finds the old file or the new one, never a part of it. And the
 * inode that was there is left as it is (a comparison copy may hold a hard link to it:
 * CmsProjectCatalog.copyProjectForComparison); a symlink there is replaced, never followed, and a folder there is
 * moved aside (moveAside), as nothing can be renamed over it. So saving the same bytes again repairs the file every
 * asset with those bytes shares when it went missing, was truncated, edited or made unreadable outside the app, which
 * is how the refusal of a backup holding it tells the user to repair it.
 */
function storeMediaFile(mediaDirectory: string, sha256: string, bytes: Uint8Array, durable: boolean): void {
  const target = path.join(mediaFolder(mediaDirectory, sha256), sha256);
  if (mediaFileHolds(target, bytes)) return;
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) moveAside(target);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSyncSafe(temp, bytes, durable);
    renameSyncSafe(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
/**
 * Windows refuses to replace a file another handle has open (a concurrent read of the same project): EPERM,
 * EACCES or EBUSY for a moment. The atomic rename is tried again for up to about two seconds before it fails.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 20;

function renameRetryable(error: unknown, attempt: number): boolean {
  return attempt < RENAME_ATTEMPTS && RENAME_RETRY_CODES.has((error as { code?: string } | null)?.code ?? "");
}

function renameSyncSafe(source: string, destination: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameFileSync(source, destination);
      return;
    } catch (error) {
      if (!renameRetryable(error, attempt)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 10);
    }
  }
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!renameRetryable(error, attempt)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
}

/**
 * The checks the restore of a backup makes on its database (`file`, opened read-only) before anything else reads it:
 * integrity, internal references, no triggers, views or virtual tables, slugs and posts of the form the editor gives
 * them (slugs become build paths), components that never call themselves (assertBackupComponentsAcyclic). TypeError
 * for a database the restore refuses. A backup saved before an update runs them too (backupDatabaseMedia), so it is
 * never one its restore refuses. `purpose` words the refusal of a cycle for its reader (assertBackupComponentsAcyclic).
 */
function validateBackupDatabase(file: string, purpose: BackupCheckPurpose): void {
  const validationDb = openNodeProjectDatabase(file, { readOnly: true });
  try {
    validationDb.exec("PRAGMA query_only = ON");
    const integrity = validationDb.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") throw new TypeError("Il database del backup non supera il controllo d’integrità.");
    if (validationDb.prepare("PRAGMA foreign_key_check").all().length > 0) throw new TypeError("Il database del backup contiene riferimenti interni non validi.");
    const unsafe = validationDb.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get() as { name: string } | undefined;
    if (unsafe) throw new TypeError(`Il database del backup contiene uno schema non consentito: ${unsafe.name}.`);
    const virtualTable = validationDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%' LIMIT 1").get() as { name: string } | undefined;
    if (virtualTable) throw new TypeError(`Il database del backup contiene una tabella virtuale non consentita: ${virtualTable.name}.`);
    // Slugs become build paths: a backup carries them as written, so they must have the form the editor gives them.
    const tables = new Set((validationDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    const hasDocumentTypes = tables.has("entities") && (validationDb.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>).some((column) => column.name === "document_type");
    const pageWhere = hasDocumentTypes ? "WHERE kind = 'page' AND document_type = 'page'" : "WHERE kind = 'page'";
    for (const [table, where] of [["entities", pageWhere], ["cms_records", ""], ["cms_terms", ""]] as const) {
      if (!tables.has(table)) continue;
      const invalid = validationDb.prepare(`SELECT slug FROM ${table} ${where}`).all().find((row) => { const slug = (row as { slug?: unknown }).slug; return typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 63; });
      if (invalid) throw new TypeError("Il database del backup contiene un indirizzo non valido.");
    }
    if (hasDocumentTypes) {
      // Posts: their own slug length, a date that matches the status, a bounded summary.
      const posts = validationDb.prepare("SELECT slug, status, published_at, excerpt FROM entities WHERE document_type = 'post'").all() as Array<{ slug: unknown; status: unknown; published_at: unknown; excerpt: unknown }>;
      if (posts.some((post) => typeof post.slug !== "string" || post.slug.length > 200 || !POST_SLUG.test(post.slug) || (post.status === "published" ? !isPostPublishedAt(post.published_at) : post.published_at !== null) || typeof post.excerpt !== "string" || post.excerpt.length > MAX_POST_EXCERPT)) {
        throw new TypeError("Il database del backup contiene un articolo non valido.");
      }
      if (validationDb.prepare("SELECT 1 FROM entities WHERE kind <> 'page' AND document_type <> 'page' LIMIT 1").get()) throw new TypeError("Il database del backup contiene un documento di tipo non valido.");
    }
    if (tables.has("cms_post_terms")) {
      const mismatched = validationDb.prepare("SELECT 1 FROM cms_post_terms pt JOIN cms_terms term ON term.id = pt.term_id JOIN entities e ON e.id = pt.post_id JOIN cms_taxonomies tax ON tax.id = pt.taxonomy_id WHERE term.taxonomy_id <> pt.taxonomy_id OR e.document_type <> 'post' OR tax.for_posts <> 1 LIMIT 1").get();
      if (mismatched) throw new TypeError("Il database del backup assegna agli articoli termini non validi.");
    }
    assertBackupComponentsAcyclic(validationDb, tables, purpose);
  } finally { validationDb.close(); }
}

/**
 * The database snapshot at `file` as a backup holds it: it must pass validateBackupDatabase, as its restore does
 * (CmsBackupUnrestorableError otherwise), and the result is the files of the media its live assets use (assets not
 * removed by a transfer), one per path, with the name of one asset that uses it.
 */
function backupDatabaseMedia(file: string): Map<string, { relativePath: string; sha256: string; filename: string }> {
  try { validateBackupDatabase(file, "backup"); }
  catch (error) {
    if (error instanceof TypeError) throw new CmsBackupUnrestorableError(error.message);
    throw error;
  }
  const database = openNodeProjectDatabase(file, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const rows = database.prepare("SELECT a.relative_path, a.sha256, MIN(a.filename) AS filename FROM assets a LEFT JOIN transfer_tombstones t ON t.id=a.id WHERE t.id IS NULL GROUP BY a.relative_path, a.sha256 ORDER BY a.relative_path").all() as Array<{ relative_path: unknown; sha256: unknown; filename: unknown }>;
    const media = new Map<string, { relativePath: string; sha256: string; filename: string }>();
    for (const row of rows) {
      const relativePath = String(row.relative_path);
      const sha256 = String(row.sha256);
      // One path, two digests: at most one of them can be its name.
      if (media.has(relativePath)) throw new TypeError("Percorso media del progetto non valido.");
      media.set(relativePath, { relativePath, sha256, filename: String(row.filename) });
    }
    return media;
  } finally { database.close(); }
}

/**
 * How the user repairs a media file a backup cannot hold (damagedMedia, missingMedia): the app has no other copy of
 * it, and saving the same bytes again puts the file back in place (CmsProjectStore.saveAsset, storeMediaFile), whatever
 * alt and caption the new upload has, without a second item in the library. The same bytes: the builder's media
 * picker starts on its «Web» compression, which sends a WebP made from the image instead (other bytes, a new item,
 * nothing repaired), so the message names «Originale», the choice of its compression menu (PRESETS in the builder's
 * mediaManager.ts) that sends the file as it is. A folder on the file's path that is no longer one is put back too
 * (mediaFolder), so the advice holds for every refusal that gives it.
 */
const MEDIA_REPAIR = "Per ripararlo carica di nuovo lo stesso file (la stessa immagine o lo stesso font) dal builder scegliendo «Originale» nel menu della compressione: Histeon Publish lo riconosce dai suoi byte e lo rimette al suo posto.";

/** A media file whose bytes no longer match its sha256 name: a backup holding it cannot be restored. */
function damagedMedia(filename: string): CmsBackupUnrestorableError {
  return new CmsBackupUnrestorableError(`Il media «${filename.slice(0, 120)}» è danneggiato: il suo file non ha più i byte con cui è stato salvato (forse è stato troncato o modificato fuori da Histeon Publish). ${MEDIA_REPAIR}`);
}

/**
 * A media file gone from the project (deleted or moved outside the app: the app never removes one), or a folder on its
 * path that is no longer one: a backup holding it cannot be restored either. Never the raw ENOENT, whose message names
 * the data folder. Both are repaired as MEDIA_REPAIR says: the upload puts the file, and its folders, back (mediaFolder).
 */
function missingMedia(filename: string): CmsBackupUnrestorableError {
  return new CmsBackupUnrestorableError(`Il media «${filename.slice(0, 120)}» manca: il suo file non è più nella cartella del progetto (forse è stato cancellato o spostato fuori da Histeon Publish). ${MEDIA_REPAIR}`);
}

/** Whether `error` says a path, or a folder on it, is not there (ENOENT, ENOTDIR). */
function notFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Whether `candidate` is below `root` (both real paths), not `root` itself. */
function strictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const PROJECT_MEDIA_PATH = /^media\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/u;
/**
 * link() errors that mean «no hard link here»: another file system, links refused (fs.protected_hardlinks, some
 * network shares), too many links, no links at all (FAT; Windows reports ERROR_INVALID_FUNCTION as EISDIR). The
 * destination is a fresh path in a private folder and the source a checked regular file, so none of them hides
 * another problem: the copy that follows fails by itself if the file cannot be read.
 */
const NO_HARD_LINK = new Set(["EXDEV", "EPERM", "EMLINK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"]);

/**
 * Puts one media file of the project at `sourceRoot` (a real path) into the copy at `staging`, after the checks
 * readAsset makes: a sha256 path that matches the row, in a media folder that is a real folder (MEDIA_FOLDER_NOT_REAL),
 * a regular file (never a symlink), inside the project. A hard link must land on the very inode that was checked and a copy must be another file of the same size, so a file
 * swapped in the meantime is refused, as a change of the project (CmsProjectChangedError: repeat the copy) and not as
 * invalid content; the next copy checks the new file from the start. Only a copy gets its mode set: chmod on a link
 * would change the original. The bytes placed must still match the sha256 name, as a restore requires of every media
 * file of a backup (CmsBackupUnrestorableError otherwise): a file truncated or edited in place keeps its name but not
 * its bytes. A file that is not there, before or while it is linked or copied, is refused the same way (missingMedia):
 * the app never removes a media file, and storeMediaFile replaces one by an atomic rename, so its name is never
 * missing for a moment; it was deleted or moved outside the app. The result is the file's size, as a backup holding it
 * measures it.
 */
async function copyProjectMedia(sourceRoot: string, staging: string, asset: { relativePath: string; sha256: string; filename: string }): Promise<number> {
  const match = PROJECT_MEDIA_PATH.exec(asset.relativePath);
  if (!match || match[2] !== asset.sha256 || match[1] !== asset.sha256.slice(0, 2)) throw new TypeError("Percorso media del progetto non valido.");
  // An operation on the project's file: "not found" is that file (link and copyFile also name the destination, but its
  // folder was just made in the private staging folder this copy holds).
  const fromSource = <T>(operation: Promise<T>): Promise<T> => operation.catch((error: unknown) => { throw notFound(error) ? missingMedia(asset.filename) : error; });
  await assertMediaFolderReadable(path.join(sourceRoot, "media"));
  const source = path.join(sourceRoot, ...asset.relativePath.split("/"));
  const checked = await fromSource(lstat(source, { bigint: true }));
  if (checked.isSymbolicLink() || !checked.isFile()) throw new TypeError("Il file media non è un file regolare del progetto.");
  const resolved = await fromSource(realpath(source));
  if (!strictlyInside(sourceRoot, resolved)) throw new TypeError("Il file media esce dalla cartella del progetto.");
  const destination = path.join(staging, ...asset.relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let linked = true;
  try { await fromSource(link(resolved, destination)); }
  catch (error) {
    if (!NO_HARD_LINK.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    linked = false;
    // A reflink where the file system has them (btrfs, XFS, APFS), otherwise a plain copy; never over an existing file.
    await fromSource(copyFile(resolved, destination, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE));
  }
  const placed = await lstat(destination, { bigint: true });
  const sameInode = placed.dev === checked.dev && placed.ino === checked.ino;
  if (!placed.isFile() || (linked ? !sameInode : sameInode || placed.size !== checked.size)) throw new CmsProjectChangedError("Il file media è cambiato durante la copia del progetto.");
  if (!linked) {
    const after = await fromSource(lstat(resolved, { bigint: true }));
    if (!after.isFile() || after.dev !== checked.dev || after.ino !== checked.ino) throw new CmsProjectChangedError("Il file media è cambiato durante la copia del progetto.");
    await chmod(destination, 0o600);
  }
  // The copy's own name for the checked inode (or its own copy of it), in a private folder: read as it is.
  if (await fileSha256(destination) !== asset.sha256) throw damagedMedia(asset.filename);
  return Number(checked.size);
}

/**
 * The sha256 of the file at `file`, read a MiB at a time and closed before the result: on Windows the folder holding
 * it can then be renamed at once.
 */
async function fileSha256(file: string): Promise<string> {
  const digest = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

// Kept synchronous to match node:sqlite's transaction boundary for page and asset metadata.
/** A project that exists on disk but cannot be opened; the message never contains a path. */
function projectUnavailable(id: string, cause: unknown): Error {
  const reason = cause instanceof SyntaxError ? "il file project.json non è leggibile"
    : cause instanceof TypeError ? cause.message.replace(/\.$/u, "")
    : (cause as { code?: string } | null)?.code === "ERR_SQLITE_ERROR" ? "il database del progetto non si apre (bloccato o danneggiato)"
    : "errore di lettura";
  return Object.assign(new Error(`Il progetto ${id} esiste ma non si può aprire: ${reason}. I suoi file non sono stati toccati.`), { code: "cms-project-unavailable", status: 409 });
}

export class CmsProjectCatalog {
  readonly projectsDirectory: string;
  /** Whether the stores this catalog opens flush media files to disk (CmsProjectCatalogOptions; default true). */
  readonly durable: boolean;
  /** How its projects' databases open (project-database.ts); `node:sqlite` unless given. */
  private readonly openDatabase: ProjectDatabaseOpener | undefined;

  /** The sweep of the catalog's projects (sweepProjectSnapshots), started by the first initialize(). */
  private snapshotSweep: Promise<void> | null = null;

  constructor(dataDirectory: string, options: CmsProjectCatalogOptions = {}) {
    this.projectsDirectory = path.join(dataDirectory, "histos-projects");
    this.durable = options.durable ?? true;
    this.openDatabase = options.openDatabase;
  }

  /**
   * Makes the projects folder, private, where there is none. The first call, the app's start for the user's catalog,
   * also sweeps its projects of the database snapshots a crash left (sweepProjectSnapshots); every call waits for it.
   */
  async initialize(): Promise<void> {
    await mkdir(this.projectsDirectory, { recursive: true, mode: 0o700 });
    this.snapshotSweep ??= this.sweepProjectSnapshots().then(() => this.sweepDeletedProjects());
    await this.snapshotSweep;
  }

  /** The folders of deletions a crash interrupted (deleteProject): already out of the catalog, removed now. Best effort. */
  private async sweepDeletedProjects(): Promise<void> {
    try {
      const root = await this.projectsRoot();
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(".deleting-")) await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {
      // A folder that cannot be read now is tried again at the next start.
    }
  }

  /**
   * sweepStaleSnapshots in each project folder of the catalog: entries of the projects folder named as a project, real
   * folders by lstat (a symlink is not followed: openProject never opens one). Staging folders (`.import-…`) are no
   * projects of the catalog and are left alone. Best effort: never fails.
   */
  private async sweepProjectSnapshots(): Promise<void> {
    try {
      const root = await this.projectsRoot();
      for (const name of await readdir(root)) {
        if (!PROJECT_ID.test(name)) continue;
        const directory = path.join(root, name);
        const found = await lstat(directory).catch(() => null);
        if (found?.isDirectory()) await sweepStaleSnapshots(directory);
      }
    } catch {
      // The projects folder cannot be read: openProject and listProjects say why.
    }
  }

  async createProject(name: string, seed: { id?: string; page?: { id: string; title: string; slug: string; content: string; status: "draft" | "published" }; styles?: { id: string; content: string } } = {}, staging = false): Promise<{ project: CmsProject; store: CmsProjectStore }> {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120) throw new TypeError("Il nome del progetto deve contenere da 1 a 120 caratteri.");
    await this.initialize();
    const id = seed.id ?? randomUUID();
    if (!PROJECT_ID.test(id)) throw new TypeError("Identificativo progetto non valido.");
    const directory = path.join(await this.projectsRoot(), staging ? `.import-${randomUUID()}` : id);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await mkdir(path.join(directory, "media"), { recursive: false, mode: 0o700 });
    const now = new Date().toISOString();
    const project: CmsProject = { id, name: cleanName, directory, createdAt: now, updatedAt: now, schemaVersion: 1 };
    await writeProjectManifest(directory, project);
    const store = new CmsProjectStore(project, { durable: this.durable, ...(this.openDatabase ? { openDatabase: this.openDatabase } : {}) });
    store.createPage(seed.page ?? { title: "Home", slug: "home" });
    store.createStyles(seed.styles?.content, seed.styles?.id);
    store.close();
    const reopened = new CmsProjectStore(project, { durable: this.durable, ...(this.openDatabase ? { openDatabase: this.openDatabase } : {}) });
    return { project, store: reopened };
  }

  async importStaticPageProfile(profile: StaticPageProfile, archiveFiles: Map<string, Buffer>, remoteSiteId?: string): Promise<{ project: CmsProject; store: CmsProjectStore }> {
    validateStaticPageProfile(profile);
    assertStaticPageProfileBlocks(profile);
    if (profile.entities.some((entity) => entity.kind === "tombstone")) {
      throw new TypeError("Un archivio nuovo non può applicare cancellazioni senza una base collegata e una copia precedente da verificare.");
    }
    const pages = profile.entities.filter((entity) => entity.kind === "document" && entity.payload.documentType === "page");
    const posts = profile.entities.filter((entity) => entity.kind === "document" && entity.payload.documentType === "post");
    const components = profile.entities.filter((entity) => entity.kind === "component" || entity.kind === "template-part");
    const templates = profile.entities.filter((entity) => entity.kind === "template");
    const style = profile.entities.find((entity) => entity.kind === "styles");
    const assets = profile.entities.filter((entity) => entity.kind === "asset");
    if (!style || pages.length < 1) throw new TypeError("Il profilo non contiene pagine e stili.");
    const first = pages[0]!;
    const firstPayload = first.payload;
    if (firstPayload.documentType !== "page" || typeof firstPayload.title !== "string" || typeof firstPayload.slug !== "string" || typeof firstPayload.content !== "string" || (firstPayload.status !== "draft" && firstPayload.status !== "published")) throw new TypeError("La prima pagina del profilo non è valida.");
    const already = await this.openProject(profile.manifest.project.id);
    if (already) {
      already.store.close();
      throw new Error("Un progetto con questa identità è già presente.");
    }
    // The fonts travel as the `histos-fonts` global sheet and live apart from the styles (local-fonts.ts).
    const receivedFonts = Array.isArray(style.payload.globals) ? (style.payload.globals as Array<Record<string, unknown>>).map((sheet) => asFontSheet(sheet)).find(Boolean) ?? null : null;
    // The site's variables travel as the `histos-site-tokens` sheet and go back to `siteTokens` (doc 28).
    const receivedStyles = receiveSiteTokens(style.payload, FONT_SHEET_ID);
    const { project, store } = await this.createProject(profile.manifest.project.name, {
      id: profile.manifest.project.id,
      page: { id: first.id, title: firstPayload.title, slug: firstPayload.slug, content: restoreCmsMediaReferences(firstPayload.content, profile.manifest.project.id), status: firstPayload.status },
      styles: { id: style.id, content: JSON.stringify(receivedFonts ? { ...receivedStyles, globals: (receivedStyles.globals as Array<Record<string, unknown>>).filter((sheet) => sheet.id !== FONT_SHEET_ID) } : receivedStyles) },
    }, true);
    try {
      if (typeof profile.manifest.project.defaultLocale === "string") {
        store.setRenderSettings({ ...store.getRenderSettings(), locale: profile.manifest.project.defaultLocale });
      }
      for (const entity of components) {
        const payload = entity.payload;
        if (typeof payload.title !== "string" || typeof payload.ref !== "string" || typeof payload.content !== "string" || !payload.schema || typeof payload.schema !== "object" || Array.isArray(payload.schema)) throw new TypeError(`Componente non valido: ${entity.id}.`);
      }
      // One transaction for the components and templates: the graph checks of the store share it, so a chain of
      // components each calling the one before is checked in linear time (assertComponentGraphAcyclic). A failure
      // removes the staging folder anyway.
      await store.atomic(() => {
        for (const entity of calleesFirst(components)) {
          const payload = entity.payload as Record<string, string>;
          const input = { id: entity.id, title: payload.title!, ref: payload.ref!, schema: entity.payload.schema, content: restoreCmsMediaReferences(payload.content!, profile.manifest.project.id) };
          if (entity.kind === "template-part") store.createTemplatePart({ ...input, area: payload.area as CmsTemplatePartArea });
          else store.createComponent(input);
        }
        for (const entity of templates) {
          const payload = entity.payload;
          if (typeof payload.title !== "string" || typeof payload.ref !== "string" || typeof payload.content !== "string" || !payload.schema || typeof payload.schema !== "object" || Array.isArray(payload.schema)) throw new TypeError(`Template non valido: ${entity.id}.`);
          store.createTemplate({ id: entity.id, title: payload.title, ref: payload.ref, schema: payload.schema, content: restoreCmsMediaReferences(payload.content, profile.manifest.project.id) });
          if (typeof payload.role === "string") store.setTemplateRole(entity.id, payload.role as TemplateRole);
        }
      });
      if (typeof firstPayload.templateRef === "string") store.updatePageMetadata(first.id, { title: firstPayload.title, slug: firstPayload.slug, status: firstPayload.status, templateRef: firstPayload.templateRef });
      for (const entity of pages.slice(1)) {
        const payload = entity.payload;
        if (payload.documentType !== "page" || typeof payload.title !== "string" || typeof payload.slug !== "string" || typeof payload.content !== "string" || (payload.status !== "draft" && payload.status !== "published")) throw new TypeError(`Pagina non valida: ${entity.id}.`);
        store.createPage({ id: entity.id, title: payload.title, slug: payload.slug, content: restoreCmsMediaReferences(payload.content, profile.manifest.project.id), status: payload.status, templateRef: typeof payload.templateRef === "string" ? payload.templateRef : null });
      }
      for (const entity of assets) {
        const payload = entity.payload;
        if (typeof payload.path !== "string" || typeof payload.mediaType !== "string" || typeof payload.title !== "string" || typeof payload.alt !== "string" || typeof payload.caption !== "string") throw new TypeError(`Asset non valido: ${entity.id}.`);
        const bytes = archiveFiles.get(payload.path);
        if (!bytes) throw new TypeError(`Manca il blob ${payload.path}.`);
        store.saveAsset({ id: entity.id, bytes, mimeType: payload.mediaType, filename: payload.title, alt: payload.alt, caption: payload.caption });
      }
      if (receivedFonts) store.setFontSheet(receivedFonts);
      const contentTypes = profile.entities.filter((entity) => entity.kind === "content-type");
      const taxonomies = profile.entities.filter((entity) => entity.kind === "taxonomy");
      const terms = profile.entities.filter((entity) => entity.kind === "term");
      const contentRecords = profile.entities.filter((entity) => entity.kind === "content-record");
      const queryPresets = profile.entities.filter((entity) => entity.kind === "query-preset");
      const querySources = profile.entities.filter((entity) => entity.kind === "query-source");
      const typeFieldsByKey = new Map<string, Array<Record<string, unknown>>>();
      for (const entity of contentTypes) {
        const payload = entity.payload;
        if (typeof payload.key !== "string" || typeof payload.label !== "string" || !Array.isArray(payload.fields)) throw new TypeError(`Tipo di contenuto non valido: ${entity.id}.`);
        const fields = payload.fields as Array<Record<string, unknown>>;
        typeFieldsByKey.set(payload.key, fields);
        const stagedFields = fields.map((field) => ({ ...field, required: false }));
        const singleTemplateRef = typeof payload.singleTemplateRef === "string" ? payload.singleTemplateRef : null;
        const archiveTemplateRef = typeof payload.archiveTemplateRef === "string" ? payload.archiveTemplateRef : null;
        for (const ref of [singleTemplateRef, archiveTemplateRef]) if (ref !== null && !store.canUseTemplate(ref)) throw new TypeError(`Il tipo ${payload.key} richiama il template ${ref}, non presente o privo dello slot Histeon predefinito.`);
        const saved = store.content.saveType({ id: entity.id, key: payload.key, label: payload.label, fields: stagedFields, singleTemplateRef, archiveTemplateRef, public: (payload as { public?: unknown }).public !== false, expectedHead: null });
        if (saved.status !== "saved") throw new Error(`Conflitto durante l’importazione del tipo ${payload.key}.`);
      }
      for (const entity of taxonomies) {
        const payload = entity.payload;
        if (typeof payload.key !== "string" || typeof payload.label !== "string" || !Array.isArray(payload.types)) throw new TypeError(`Tassonomia non valida: ${entity.id}.`);
        const saved = store.content.saveTaxonomy({ id: entity.id, key: payload.key, label: payload.label, types: payload.types, expectedHead: null });
        if (saved.status !== "saved") throw new Error(`Conflitto durante l’importazione della tassonomia ${payload.key}.`);
      }
      const pendingTerms = [...terms];
      while (pendingTerms.length) {
        const index = pendingTerms.findIndex((entity) => entity.payload.parentId === null || typeof entity.payload.parentId === "string" && store.content.getTermById(entity.payload.parentId) !== null);
        if (index < 0) throw new TypeError("La gerarchia dei termini contiene riferimenti non risolti o ciclici.");
        const [entity] = pendingTerms.splice(index, 1);
        if (!entity) throw new Error("Termine non disponibile durante l’importazione.");
        const payload = entity.payload;
        if (typeof payload.taxonomyKey !== "string" || typeof payload.slug !== "string" || typeof payload.label !== "string" || (payload.parentId !== null && typeof payload.parentId !== "string")) throw new TypeError(`Termine non valido: ${entity.id}.`);
        const saved = store.content.saveTerm({ id: entity.id, taxonomyKey: payload.taxonomyKey, slug: payload.slug, label: payload.label, parentId: payload.parentId, expectedHead: null });
        if (saved.status !== "saved") throw new Error(`Conflitto durante l’importazione del termine ${payload.slug}.`);
      }
      const recordTermAliases = (payload: Record<string, import("@histos-publish/histos-contract").JsonValue>): Record<string, number[]> => {
        const source = payload.terms;
        if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("Assegnazioni tassonomie della voce non valide.");
        return Object.fromEntries(Object.entries(source).map(([taxonomyKey, ids]) => {
          if (!Array.isArray(ids)) throw new TypeError(`Elenco termini non valido per ${taxonomyKey}.`);
          const aliases = ids.map((termId) => {
            if (typeof termId !== "string") throw new TypeError(`Identificativo termine non valido per ${taxonomyKey}.`);
            const term = store.content.getTermById(termId);
            if (!term || term.taxonomyKey !== taxonomyKey) throw new TypeError(`Il termine ${termId} non è presente nella tassonomia ${taxonomyKey}.`);
            return term.alias;
          });
          return [taxonomyKey, aliases];
        }));
      };
      const recordInput = (entity: typeof contentRecords[number], stageRelations: boolean) => {
        const payload = entity.payload;
        if (typeof payload.typeKey !== "string" || typeof payload.title !== "string" || typeof payload.slug !== "string" || typeof payload.locale !== "string" || (payload.status !== "draft" && payload.status !== "published" && payload.status !== "archived") || typeof payload.excerpt !== "string" || typeof payload.order !== "number" || !payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) throw new TypeError(`Record CMS non valido: ${entity.id}.`);
        const fields = typeFieldsByKey.get(payload.typeKey);
        if (!fields) throw new TypeError(`Il tipo ${payload.typeKey} del record non è presente.`);
        const originalValues = payload.values as Record<string, unknown>;
        const values = stageRelations ? Object.fromEntries(Object.entries(originalValues).filter(([key]) => fields.find((field) => field.key === key)?.type !== "relation")) : originalValues;
        return { id: entity.id, typeKey: payload.typeKey, title: payload.title, slug: payload.slug, locale: payload.locale, status: payload.status as CmsRecordStatus, publishedAt: typeof payload.publishedAt === "string" ? payload.publishedAt : null, excerpt: payload.excerpt, order: payload.order, values, terms: recordTermAliases(payload), expectedHead: null as string | null };
      };
      for (const entity of contentRecords) {
        const saved = store.content.saveRecord(recordInput(entity, true));
        if (saved.status !== "saved") throw new Error(`Conflitto durante l’importazione del record ${entity.id}.`);
      }
      for (const entity of contentRecords) {
        const record = store.content.getRecordById(entity.id, true);
        if (!record) throw new Error(`Il record ${entity.id} non è stato creato.`);
        const saved = store.content.saveRecord({ ...recordInput(entity, false), expectedHead: record.headRevision });
        if (saved.status !== "saved") throw new Error(`Conflitto durante il completamento del record ${entity.id}.`);
      }
      for (const entity of contentTypes) {
        const payload = entity.payload;
        const current = typeof payload.key === "string" ? store.content.getType(payload.key) : null;
        if (!current) throw new Error(`Il tipo ${String(payload.key)} è scomparso durante l’importazione.`);
        const saved = store.content.saveType({ id: entity.id, key: String(payload.key), label: String(payload.label), fields: payload.fields, singleTemplateRef: typeof payload.singleTemplateRef === "string" ? payload.singleTemplateRef : null, archiveTemplateRef: typeof payload.archiveTemplateRef === "string" ? payload.archiveTemplateRef : null, public: payload.public !== false, expectedHead: current.headRevision });
        if (saved.status !== "saved") throw new Error(`Conflitto durante il completamento del tipo ${String(payload.key)}.`);
      }
      // Posts after the terms they use.
      for (const entity of posts) store.createPost({ id: entity.id, ...transferPostInput(entity, profile.manifest.project.id) });
      for (const entity of queryPresets) {
        const payload = entity.payload;
        if (typeof payload.key !== "string" || typeof payload.label !== "string" || typeof payload.typeKey !== "string" || typeof payload.limit !== "number" || typeof payload.orderBy !== "string" || (payload.order !== "asc" && payload.order !== "desc")) throw new TypeError(`Query non valida: ${entity.id}.`);
        const saved = store.content.saveQueryPreset({ key: payload.key, label: payload.label, typeKey: payload.typeKey, limit: payload.limit, ...(typeof payload.limitParam === "string" ? { limitParam: payload.limitParam } : {}), offset: typeof payload.offset === "number" ? payload.offset : 0, ...(typeof payload.offsetParam === "string" ? { offsetParam: payload.offsetParam } : {}), orderBy: payload.orderBy, order: payload.order, ...(payload.filter !== undefined ? { filter: payload.filter } : {}), expectedHead: null });
        if (saved.status !== "saved") throw new Error(`Conflitto durante l’importazione della query ${payload.key}.`);
      }
      if (querySources.length) {
        const sources = Object.fromEntries(querySources.map((entity) => {
          if (typeof entity.payload.name !== "string") throw new TypeError(`Nome sorgente non valido: ${entity.id}.`);
          return [entity.payload.name, { type: "json", data: entity.payload.data }];
        }));
        store.content.saveQuerySources(sources);
      }
      // Doc 18 §6.6: each document's JavaScript, already checked against its limit by validateStaticPageProfile.
      for (const entity of [...pages, ...posts, ...components, ...templates]) {
        const script = entity.payload.script;
        if (typeof script === "string" && script !== "") store.setDocumentScript(entity.id, script);
      }
      if (remoteSiteId) for (const entity of profile.entities) store.setSyncBase(remoteSiteId, profile.manifest.project.id, entity.id, entity.revisionHash);
      await store.checkpoint();
      await this.saveManifest(project);
      store.close();
      const finalDirectory = path.join(await this.projectsRoot(), project.id);
      await renameWithRetry(project.directory, finalDirectory);
      const imported = await this.openProject(project.id);
      if (!imported) throw new Error("Il progetto importato non è riapribile.");
      return imported;
    } catch (error) {
      try { store.close(); } catch { /* already closed after checkpoint */ }
      await rm(project.directory, { recursive: true, force: true });
      throw error;
    }
  }

  async importNativeProjectBackup(input: { project: Omit<CmsProject, "directory">; files: Map<string, Buffer> }): Promise<{ project: CmsProject; store: CmsProjectStore }> {
    const { project: metadata, files } = input;
    if (!PROJECT_ID.test(metadata.id) || metadata.schemaVersion !== 1 || !metadata.name.trim() || metadata.name.length > 120) throw new TypeError("Metadati del backup Histeon non validi.");
    const database = files.get("content.sqlite");
    if (!database || !Buffer.from(database.subarray(0, 16)).equals(Buffer.from("SQLite format 3\0", "binary"))) throw new TypeError("Il backup non contiene un database SQLite valido.");
    await this.initialize();
    const duplicate = await this.openProject(metadata.id);
    if (duplicate) {
      duplicate.store.close();
      throw new TypeError("Un progetto con questa identità esiste già. Apri o rimuovi il progetto esistente prima di ripristinare il backup.");
    }
    const staging = path.join(await this.projectsRoot(), `.import-${randomUUID()}`);
    const destination = path.join(await this.projectsRoot(), metadata.id);
    let installed = false;
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      await mkdir(path.join(staging, "media"), { recursive: false, mode: 0o700 });
      const storedProject: CmsProject = { ...metadata, directory: staging };
      await writeProjectManifest(staging, storedProject);
      await writeFile(path.join(staging, "content.sqlite"), database, { mode: 0o600, flag: "wx" });
      for (const [relative, bytes] of files) {
        if (relative === "content.sqlite") continue;
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (!/^media\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/u.test(relative) || relative.split("/").at(-1) !== digest || relative.split("/")[2] !== digest.slice(0, 2)) throw new TypeError(`Percorso o hash media non valido: ${relative}.`);
        const target = path.join(staging, relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      }
      validateBackupDatabase(path.join(staging, "content.sqlite"), "restore");
      const candidate = new CmsProjectStore(storedProject, { durable: this.durable, ...(this.openDatabase ? { openDatabase: this.openDatabase } : {}) });
      try {
        candidate.listPages();
        candidate.listPosts();
        candidate.listComponents();
        candidate.content.listTypes();
        candidate.content.listTaxonomies();
        // One file per path: rows with the same bytes and another alt or caption share it, as in the backup.
        const dbAssets = [...new Set(candidate.listAssets().map((asset) => asset.relativePath))].sort();
        const archiveAssets = [...files.keys()].filter((filePath) => filePath.startsWith("media/")).sort();
        if (dbAssets.length !== archiveAssets.length || dbAssets.some((filePath, index) => filePath !== archiveAssets[index])) throw new TypeError("I media dichiarati nel database non corrispondono ai file del backup.");
        for (const asset of candidate.listAssets()) if (!await candidate.readAsset(asset.id)) throw new TypeError(`Media mancante nel backup: ${asset.filename}.`);
        await candidate.checkpoint();
      } finally { candidate.close(); }
      await Promise.all([rm(`${path.join(staging, "content.sqlite")}-wal`, { force: true }), rm(`${path.join(staging, "content.sqlite")}-shm`, { force: true })]);
      await renameWithRetry(staging, destination);
      installed = true;
      const restoredProject: CmsProject = { ...metadata, directory: destination };
      await writeProjectManifest(destination, restoredProject);
      const restored = await this.openProject(metadata.id);
      if (!restored) throw new TypeError("Il progetto ripristinato non supera la riapertura di verifica.");
      return restored;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (installed) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * A working copy of project `id` in `target`, a scratch catalog outside this one, for a dry run that must leave the
   * project as it is (queue D2: what an update would change). It is the project importNativeProjectBackup gives for a
   * backup of this one, without the archive in memory and its 512 MiB limit: the database is a VACUUM INTO snapshot,
   * consistent while the app writes, and the media of the snapshot's live assets are hard links, or copies (reflinks
   * where the file system has them) across file systems or where links are refused. Null when there is no such project.
   *
   * Like a restore, it refuses what a backup of the project could not bring back (CmsBackupUnrestorableError): a
   * database the restore's checks refuse, a media file that is gone or whose bytes no longer match its sha256 name
   * (the message says how to repair it, as the backup's does: missingMedia, damagedMedia). And it measures
   * what that backup would hold, exactly and from the copy itself (`backup`: the snapshot as written, each media file
   * once), the same sizes the backup made before the update measures (CmsProjectStore.withBackupSnapshot), so a check
   * that says the backup fits is never contradicted by the update it offers.
   *
   * A hard link shares the inode with the original, so the copy is safe only because nothing writes into an existing
   * media file in place. Every media write creates a new file exclusively (O_EXCL) and renames it into place or keeps
   * the file already there: saveAsset and replaceAsset (also behind importStaticPageProfile) go through storeMediaFile,
   * which keeps a file that holds the bytes already and otherwise writes `<target>.<uuid>.tmp` and renames it over the
   * target, which replaces the copy's directory entry and leaves the original's inode alone (it only reads the file it
   * keeps); importNativeProjectBackup writes with O_EXCL into its own staging folder. Tombstones and their restore only
   * touch the database, and removing the scratch folder only unlinks the copy's names. Nothing chmods, truncates or
   * retimes a media file (the copy below sets the mode of copies only), and the database, manifest and recovery files
   * of the copy are its own files. A new media write must stay exclusive-or-rename, or this method must copy instead
   * of linking.
   */
  async copyProjectForComparison(id: string, target: CmsProjectCatalog, signal?: AbortSignal): Promise<{ project: CmsProject; store: CmsProjectStore; backup: NativeBackupSizes } | null> {
    const source = await this.openProject(id);
    if (!source) return null;
    const { project } = source;
    // The fields a backup carries (openProject checked them), nothing else from project.json.
    const metadata: Omit<CmsProject, "directory"> = { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, schemaVersion: project.schemaVersion };
    let staging: string | undefined;
    let destination: string | undefined;
    let installed = false;
    try {
      try {
        // Never a project of the user's catalog: the copy lives only in the scratch catalog, which the caller removes.
        // Checked on the names before anything is created, then on the real paths.
        const roots = [path.resolve(this.projectsDirectory), await this.projectsRoot()];
        const outside = (copies: string): boolean => roots.every((root) => copies !== root && !strictlyInside(root, copies));
        if (!outside(path.resolve(target.projectsDirectory))) throw new TypeError("La copia di confronto deve stare fuori dal catalogo dei progetti.");
        await target.initialize();
        const copiesRoot = await target.projectsRoot();
        if (!outside(copiesRoot)) throw new TypeError("La copia di confronto deve stare fuori dal catalogo dei progetti.");
        const copiesInfo = await lstat(copiesRoot);
        if (!copiesInfo.isDirectory() || !privateMode(copiesInfo.mode)) throw new TypeError("La cartella della copia di confronto non è privata.");
        const duplicate = await target.openProject(id);
        if (duplicate) {
          duplicate.store.close();
          throw new TypeError("La copia di confronto di questo progetto esiste già.");
        }
        staging = path.join(copiesRoot, `.import-${randomUUID()}`);
        destination = path.join(copiesRoot, id);
        await mkdir(staging, { recursive: false, mode: 0o700 });
        await mkdir(path.join(staging, "media"), { recursive: false, mode: 0o700 });
        // Created empty and private first: VACUUM INTO fills an empty file and keeps its mode.
        const database = path.join(staging, "content.sqlite");
        await writeFile(database, new Uint8Array(), { flag: "wx", mode: 0o600 });
        source.store.snapshotDatabaseInto(database);
      } finally {
        source.store.close();
      }
      signal?.throwIfAborted();
      // What a restore would check first, and what the backup's database would measure: the snapshot as written, before
      // any connection opens it.
      const database = path.join(staging, "content.sqlite");
      const media = backupDatabaseMedia(database);
      const backup: { database: number; media: Array<{ path: string; bytes: number }> } = { database: (await lstat(database)).size, media: [] };
      await writeProjectManifest(staging, { ...metadata, directory: staging });
      // The media of the snapshot, not of the project now: an asset added since is not in the copied database. Rows
      // with the same bytes and other alt or caption share one file.
      const sourceRoot = await realpath(project.directory);
      for (const asset of media.values()) {
        signal?.throwIfAborted();
        backup.media.push({ path: asset.relativePath, bytes: await copyProjectMedia(sourceRoot, staging, asset) });
      }
      signal?.throwIfAborted();
      // A fresh folder onto a name just found free: retried as any rename Windows can refuse for a moment (a file inside
      // still open for an antivirus scan).
      await renameWithRetry(staging, destination);
      installed = true;
      const copy = await target.openProject(id);
      if (!copy) throw new TypeError("La copia di confronto del progetto non si riapre.");
      return { ...copy, backup };
    } catch (error) {
      if (staging) await rm(staging, { recursive: true, force: true });
      if (installed && destination) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * A download from a linked site into its project. With `only` (doc 23 items 199-200), a download of just those
   * entries: the others of the profile are neither applied nor marked as shared, and the project's settings stay as
   * they are. The caller decides `only` (the server's plan, with what the chosen entries need); this method checks only
   * that the ids are in the profile, and the project must exist already.
   */
  async importRemoteStaticPageProfile(profile: StaticPageProfile, archiveFiles: Map<string, Buffer>, remoteSiteId: string, resolutions: Record<string, "keep-local" | "use-remote"> = {}, options: { only?: ReadonlySet<string> } = {}): Promise<{ project: CmsProject; changed: string[]; keptLocal: string[]; unchanged: string[] }> {
    validateStaticPageProfile(profile);
    assertStaticPageProfileBlocks(profile);
    if (!ENTITY_ID.test(remoteSiteId)) throw new TypeError("Identità del sito remoto non valida.");
    const only = options.only;
    if (only && (only.size === 0 || [...only].some((id) => !profile.entities.some((entity) => entity.id === id && entity.kind !== "tombstone" && entity.kind !== "styles")))) {
      throw new TypeError("I contenuti da portare nel progetto non corrispondono al sito.");
    }
    const scoped = only ? profile.entities.filter((entity) => only.has(entity.id)) : profile.entities;
    const existing = await this.openProject(profile.manifest.project.id);
    if (!existing && only) throw new TypeError("Per portare dei contenuti nel progetto serve il progetto su questo computer.");
    if (!existing) {
      const imported = await this.importStaticPageProfile(profile, archiveFiles, remoteSiteId);
      const project = imported.project;
      imported.store.close();
      return { project, changed: profile.entities.map((entity) => entity.id), keptLocal: [], unchanged: [] };
    }

    const { project, store } = existing;
    try {
      const { createDraftImportProfile, createStaticPageProfile } = await import("./page-transfer.js");
      const local = await createStaticPageProfile(project, store);
      const localById = new Map(local.profile.entities.map((entity) => [entity.id, entity]));
      const localDraft = createDraftImportProfile(local.profile, local.files);
      const localDraftById = new Map(localDraft.profile.entities.map((entity) => [entity.id, entity]));
      const syncConflict = (id: string, kind: string, remoteHash: string): CmsSyncConflictError => new CmsSyncConflictError([{
        id,
        kind,
        baseHash: store.getSyncBase(remoteSiteId, id)?.baseHash ?? null,
        localHash: localById.get(id)?.revisionHash ?? null,
        remoteHash,
      }]);
      const conflicts: Array<{ id: string; kind: string; baseHash: string | null; localHash: string | null; remoteHash: string }> = [];
      const resolvedConflictIds = new Set<string>();
      const keptLocal: string[] = [];
      const apply: typeof profile.entities = [];
      const deletions: typeof profile.entities = [];
      const keepLocalPublication: Array<{ id: string; status: "published"; publishedAt?: string }> = [];
      for (const remote of scoped) {
        const current = localById.get(remote.id);
        const localDraftEntity = localDraftById.get(remote.id);
        const base = store.getSyncBase(remoteSiteId, remote.id);
        if (remote.kind === "tombstone") {
          if (current?.kind === "tombstone" && current.revisionHash === remote.revisionHash) continue;
          const previousHash = remote.payload.previousRevisionHash;
          const entityKind = String(remote.payload.entityKind);
          const previouslyLinkedDeletableEntity = ["document", "content-record", "component", "template-part", "template", "asset"].includes(entityKind)
            && current !== undefined
            && current.kind === remote.payload.entityKind
            && typeof previousHash === "string"
            && base?.baseHash === previousHash
            && current.revisionHash === previousHash;
          if (previouslyLinkedDeletableEntity) {
            apply.push(remote);
            deletions.push(remote);
          } else {
            conflicts.push({ id: remote.id, kind: "tombstone", baseHash: base?.baseHash ?? null, localHash: current?.revisionHash ?? null, remoteHash: remote.revisionHash });
          }
          continue;
        }
        if (current?.revisionHash === remote.revisionHash) continue;
        if (current?.kind === "tombstone") {
          conflicts.push({ id: remote.id, kind: remote.kind, baseHash: base?.baseHash ?? null, localHash: current.revisionHash, remoteHash: remote.revisionHash });
          continue;
        }
        if (!current && !base) {
          // Styles, query presets and query sources are applied by singleton or key, not by id: a remote entity
          // with an unknown id would replace the local one silently. Same key, other id: the user decides.
          const twin = keyAddressedTwin(local.profile.entities, remote);
          if (twin) {
            conflicts.push({ id: remote.id, kind: remote.kind, baseHash: null, localHash: twin.revisionHash, remoteHash: remote.revisionHash });
            continue;
          }
          apply.push(remote);
          continue;
        }
        const localUnchanged = Boolean(
          current && base && (current.revisionHash === base.baseHash || localDraftEntity?.revisionHash === base.baseHash),
        );
        const remoteUnchanged = Boolean(base && remote.revisionHash === base.baseHash);
        if (localUnchanged && remoteUnchanged) continue;
        if (localUnchanged && current) {
          apply.push(remote);
          if (base && localDraftEntity?.revisionHash === base.baseHash && current.revisionHash !== base.baseHash) {
            if (current.kind === "document" && current.payload.status === "published" && remote.payload.status === "draft") {
              keepLocalPublication.push({ id: remote.id, status: "published", ...(typeof current.payload.publishedAt === "string" ? { publishedAt: current.payload.publishedAt } : {}) });
            } else if (
              current.kind === "content-record" && current.payload.status === "published" && remote.payload.status === "draft"
            ) {
              if (typeof current.payload.publishedAt !== "string") {
                throw new TypeError(`Manca la data di pubblicazione locale del record ${current.id}.`);
              }
              keepLocalPublication.push({
                id: remote.id,
                status: "published",
                publishedAt: current.payload.publishedAt,
              });
            }
          }
          continue;
        }
        if (remoteUnchanged) continue;
        if (current && current.kind === remote.kind) {
          const choice = resolutions[remote.id];
          if (choice === "keep-local") {
            resolvedConflictIds.add(remote.id);
            keptLocal.push(remote.id);
            continue;
          }
          if (choice === "use-remote") {
            resolvedConflictIds.add(remote.id);
            apply.push(remote);
            continue;
          }
        }
        conflicts.push({ id: remote.id, kind: remote.kind, baseHash: base?.baseHash ?? null, localHash: current?.revisionHash ?? null, remoteHash: remote.revisionHash });
      }
      if (Object.keys(resolutions).some((id) => !resolvedConflictIds.has(id))) throw new TypeError("La scelta indicata non corrisponde a un conflitto modificabile del piano.");
      if (conflicts.length) throw new CmsSyncConflictError(conflicts);

      const publicationById = new Map(keepLocalPublication.map((item) => [item.id, item]));
      const effectiveApply: typeof profile.entities = apply.map((entity) => {
        const publication = publicationById.get(entity.id);
        if (!publication) return entity;
        const payload: typeof entity.payload = {
          ...entity.payload,
          status: publication.status,
          ...(entity.kind === "content-record" || entity.kind === "document" && entity.payload.documentType === "post" ? { publishedAt: publication.publishedAt ?? null } : {}),
        };
        return { ...entity, payload };
      });

      const recoveryBackup = deletions.length
        ? await store.createDeletionRecoveryBackup(profile.manifest.selection.snapshot)
        : null;

      const incomingSlugs = new Map<string, string>();
      const localSlugs = new Map(store.listPages().map((page) => [page.slug, page.id]));
      const incomingPostSlugs = new Map<string, string>();
      const localPostSlugs = new Map(store.listPosts().map((post) => [post.slug, post.id]));
      for (const entity of profile.entities.filter((item) => item.kind === "document" && item.payload.documentType === "post")) {
        const { slug } = transferPostInput(entity, project.id);
        const seen = incomingPostSlugs.get(slug);
        const localId = localPostSlugs.get(slug);
        if ((seen && seen !== entity.id) || (localId && localId !== entity.id && apply.some((candidate) => candidate.id === entity.id))) throw new TypeError(`Lo slug remoto ${slug} è già usato da un altro articolo locale.`);
        incomingPostSlugs.set(slug, entity.id);
      }
      for (const entity of profile.entities.filter((item) => item.kind === "document" && item.payload.documentType !== "post")) {
        const payload = entity.payload;
        if (payload.documentType !== "page" || typeof payload.title !== "string" || typeof payload.slug !== "string" || !payload.slug || slugify(payload.slug) !== payload.slug || typeof payload.content !== "string" || (payload.status !== "draft" && payload.status !== "published")) throw new TypeError(`Pagina remota non valida: ${entity.id}.`);
        const seen = incomingSlugs.get(payload.slug);
        const localId = localSlugs.get(payload.slug);
        if ((seen && seen !== entity.id) || (localId && localId !== entity.id && apply.some((candidate) => candidate.id === entity.id))) throw new TypeError(`Lo slug remoto ${payload.slug} è già usato da un’altra pagina locale.`);
        incomingSlugs.set(payload.slug, entity.id);
      }
      for (const entity of profile.entities.filter((item) => item.kind === "asset")) {
        const payload = entity.payload;
        if (typeof payload.path !== "string" || typeof payload.mediaType !== "string" || typeof payload.title !== "string" || typeof payload.alt !== "string" || typeof payload.caption !== "string") throw new TypeError(`Asset remoto non valido: ${entity.id}.`);
        if (!archiveFiles.has(payload.path)) throw new TypeError(`Manca il file media remoto ${payload.path}.`);
      }
      const incomingComponentRefs = new Map<string, string>();
      const incomingComponentIds = new Set(scoped.filter((item) => item.kind === "component" || item.kind === "template-part").map((item) => item.id));
      const reusableEntities = scoped.filter((item) => item.kind === "component" || item.kind === "template-part" || item.kind === "template");
      for (const entity of reusableEntities) {
        const payload = entity.payload;
        if (typeof payload.title !== "string" || typeof payload.ref !== "string" || typeof payload.content !== "string" || !payload.schema || typeof payload.schema !== "object" || Array.isArray(payload.schema)) throw new TypeError(`Componente remoto non valido: ${entity.id}.`);
        if (entity.kind === "template-part" && !["header", "footer", "uncategorized"].includes(String(payload.area))) throw new TypeError(`Area parte template remota non valida: ${entity.id}.`);
        const duplicateRef = incomingComponentRefs.get(payload.ref);
        if (duplicateRef && duplicateRef !== entity.id) throw new TypeError(`Il riferimento componente remoto ${payload.ref} è duplicato.`);
        incomingComponentRefs.set(payload.ref, entity.id);
      }
      for (const localComponent of store.listComponents()) {
        if (incomingComponentRefs.has(localComponent.ref) && incomingComponentRefs.get(localComponent.ref) !== localComponent.id && !incomingComponentIds.has(localComponent.id)) {
          throw new TypeError(`Il riferimento ${localComponent.ref} è usato da un componente locale non incluso nel sito remoto.`);
        }
      }

      const changed: string[] = [];
      await store.atomic(async () => {
      if (!only && typeof profile.manifest.project.defaultLocale === "string") {
        store.setRenderSettings({ ...store.getRenderSettings(), locale: profile.manifest.project.defaultLocale });
      }
      for (const entity of effectiveApply.filter((item) => item.kind === "asset")) {
        const payload = entity.payload;
        if (typeof payload.path !== "string" || typeof payload.mediaType !== "string" || typeof payload.title !== "string" || typeof payload.alt !== "string" || typeof payload.caption !== "string") throw new TypeError(`Asset remoto non valido: ${entity.id}.`);
        const bytes = archiveFiles.get(payload.path);
        if (!bytes) throw new TypeError(`Manca il file media remoto ${payload.path}.`);
        store.replaceAsset({ id: entity.id, bytes, mimeType: payload.mediaType, filename: payload.title, alt: payload.alt, caption: payload.caption });
        changed.push(entity.id);
      }
      const applyingReusable = effectiveApply.filter((item) => item.kind === "component" || item.kind === "template-part");
      for (const entity of applyingReusable) {
        const payload = entity.payload;
        if (typeof payload.title !== "string" || typeof payload.ref !== "string" || typeof payload.content !== "string" || !payload.schema || typeof payload.schema !== "object" || Array.isArray(payload.schema)) throw new TypeError(entity.kind === "component" ? `Componente remoto non valido: ${entity.id}.` : `Parte di template remota non valida: ${entity.id}.`);
      }
      // Components and parts together, each after those it calls among them: the profile lists them by id, and one
      // created or saved before a new one it calls was refused (a component calling a part was, always).
      for (const entity of calleesFirst(applyingReusable)) {
        const payload = entity.payload as Record<string, string>;
        const kind = entity.kind as "component" | "template-part";
        const content = restoreCmsMediaReferences(payload.content!, project.id);
        const current = store.getComponentById(entity.id);
        if (current && current.kind !== kind) throw new TypeError(`L’entità ${entity.id} cambia tipo da ${current.kind} a ${kind}; trasferimento fermato.`);
        if (!current) {
          if (kind === "template-part") store.createTemplatePart({ id: entity.id, title: payload.title!, ref: payload.ref!, content, schema: entity.payload.schema, area: payload.area as CmsTemplatePartArea });
          else store.createComponent({ id: entity.id, title: payload.title!, ref: payload.ref!, schema: entity.payload.schema, content });
        } else {
          const saved = store.saveComponent({ alias: current.alias, expectedHead: current.headRevision, content, ref: payload.ref!, schema: entity.payload.schema });
          if (saved.status === "conflict") throw syncConflict(entity.id, kind, entity.revisionHash);
          store.updateComponentTitle(entity.id, payload.title!);
          if (kind === "template-part") store.updateTemplatePartArea(entity.id, payload.area as CmsTemplatePartArea);
        }
        changed.push(entity.id);
      }
      for (const entity of effectiveApply.filter((item) => item.kind === "template")) {
        const payload = entity.payload;
        if (typeof payload.title !== "string" || typeof payload.ref !== "string" || typeof payload.content !== "string" || !payload.schema || typeof payload.schema !== "object" || Array.isArray(payload.schema)) throw new TypeError(`Template remoto non valido: ${entity.id}.`);
        const content = restoreCmsMediaReferences(payload.content, project.id);
        const current = store.getComponentById(entity.id);
        if (current && current.kind !== "template") throw new TypeError(`L’entità ${entity.id} cambia tipo da ${current.kind} a template; trasferimento fermato.`);
        if (!current) store.createTemplate({ id: entity.id, title: payload.title, ref: payload.ref, schema: payload.schema, content });
        else {
          const saved = store.saveComponent({ alias: current.alias, expectedHead: current.headRevision, content, ref: payload.ref, schema: payload.schema });
          if (saved.status === "conflict") throw syncConflict(entity.id, "template", entity.revisionHash);
          store.updateComponentTitle(entity.id, payload.title);
        }
        changed.push(entity.id);
      }
      // Roles move between templates in one step: release every incoming role first, then assign them.
      const applyingTemplates = effectiveApply.filter((item) => item.kind === "template");
      for (const entity of applyingTemplates) store.setTemplateRole(entity.id, null);
      for (const entity of applyingTemplates) if (typeof entity.payload.role === "string") store.setTemplateRole(entity.id, entity.payload.role as TemplateRole);
      const applyingPosts = effectiveApply.filter((item) => item.kind === "document" && item.payload.documentType === "post");
      for (const entity of applyingPosts) {
        // Content and fields now; terms once the incoming terms exist.
        const input = transferPostInput(entity, project.id);
        const current = store.getEntityById(entity.id);
        if (current && current.documentType !== "post") throw new TypeError(`Il documento ${entity.id} cambia da pagina ad articolo; trasferimento fermato.`);
        const { terms: _terms, ...fields } = input;
        if (!current) store.createPost({ id: entity.id, ...fields, terms: {} });
        else {
          const head = store.getHead(entity.id);
          if (!head) throw new Error(`Manca la revisione dell'articolo ${entity.id}.`);
          const saved = store.saveDocument({ entityId: entity.id, expectedHead: head.id, content: input.content, source: "import" });
          if (saved.status === "conflict") throw syncConflict(entity.id, "document", entity.revisionHash);
          store.updatePostMetadata(entity.id, fields);
        }
        changed.push(entity.id);
      }
      for (const entity of effectiveApply.filter((item) => item.kind === "document" && item.payload.documentType !== "post")) {
        const payload = entity.payload;
        if (payload.documentType !== "page" || typeof payload.title !== "string" || typeof payload.slug !== "string" || typeof payload.content !== "string" || (payload.status !== "draft" && payload.status !== "published")) throw new TypeError(`Pagina remota non valida: ${entity.id}.`);
        const current = store.getEntityById(entity.id);
        if (current && current.documentType !== "page") throw new TypeError(`Il documento ${entity.id} cambia da articolo a pagina; trasferimento fermato.`);
        const content = restoreCmsMediaReferences(payload.content, project.id);
        const templateRef = typeof payload.templateRef === "string" ? payload.templateRef : null;
        if (!current) store.createPage({ id: entity.id, title: payload.title, slug: payload.slug, content, status: payload.status, templateRef });
        else {
          const head = store.getHead(entity.id);
          if (!head) throw new Error(`Manca la revisione della pagina ${entity.id}.`);
          const saved = store.saveDocument({ entityId: entity.id, expectedHead: head.id, content, source: "import" });
          if (saved.status === "conflict") throw syncConflict(entity.id, "document", entity.revisionHash);
          store.updatePageMetadata(entity.id, { title: payload.title, slug: payload.slug, status: payload.status, templateRef });
        }
        changed.push(entity.id);
      }
      for (const entity of effectiveApply.filter((item) => item.kind === "styles")) {
        // The fonts travel as the `histos-fonts` global sheet and live apart from the styles here (local-fonts.ts).
        const globals = Array.isArray(entity.payload.globals) ? entity.payload.globals as Array<Record<string, unknown>> : [];
        const fonts = globals.map((sheet) => asFontSheet(sheet)).find(Boolean) ?? null;
        // The site's variables travel as the `histos-site-tokens` sheet and go back to `siteTokens` (doc 28).
        const received = receiveSiteTokens(entity.payload, FONT_SHEET_ID);
        const content = JSON.stringify(fonts ? { ...received, globals: (received.globals as Array<Record<string, unknown>>).filter((sheet) => sheet.id !== FONT_SHEET_ID) } : received);
        if (fonts) store.setFontSheet(fonts);
        const current = store.getStyles();
        if (!current) throw new Error("Archivio stili locale non inizializzato.");
        const head = store.getHead(current.id);
        if (!head) throw new Error("Manca la revisione degli stili.");
        const saved = store.saveDocument({ entityId: current.id, expectedHead: head.id, content, source: "import" });
        if (saved.status === "conflict") throw syncConflict(entity.id, "styles", entity.revisionHash);
        changed.push(entity.id);
      }

      // Relational entities have dependencies: types precede taxonomies, terms,
      // and records; records use stable entity IDs and need all relation targets
      // present before their final values can be saved.
      // A partial download leaves out the site's types the project does not have and does not take.
      const relationalTypes = profile.entities.filter((item) => item.kind === "content-type" && (!only || only.has(item.id) || store.content.getType(item.id) !== null));
      const applyingTypes = effectiveApply.filter((item) => item.kind === "content-type");
      const applyingTypeIds = new Set(applyingTypes.map((item) => item.id));
      const applyingTaxonomies = effectiveApply.filter((item) => item.kind === "taxonomy");
      const applyingTerms = effectiveApply.filter((item) => item.kind === "term");
      const applyingRecords = effectiveApply.filter((item) => item.kind === "content-record");
      const applyingQueryPresets = effectiveApply.filter((item) => item.kind === "query-preset");
      const applyingQuerySources = effectiveApply.filter((item) => item.kind === "query-source");
      const typePayload = (entity: typeof relationalTypes[number]) => {
        const payload = entity.payload;
        if (typeof payload.key !== "string" || typeof payload.label !== "string" || !Array.isArray(payload.fields)) {
          throw new TypeError(`Tipo di contenuto remoto non valido: ${entity.id}.`);
        }
        return {
          key: payload.key,
          label: payload.label,
          fields: payload.fields as Array<Record<string, unknown>>,
          singleTemplateRef: typeof payload.singleTemplateRef === "string" ? payload.singleTemplateRef : null,
          archiveTemplateRef: typeof payload.archiveTemplateRef === "string" ? payload.archiveTemplateRef : null,
          public: payload.public !== false,
        };
      };
      const saveType = (entity: typeof relationalTypes[number], definition: ReturnType<typeof typePayload>, fields = definition.fields) => {
        const current = store.content.getType(entity.id);
        const saved = store.content.saveType({
          id: entity.id,
          key: definition.key,
          label: definition.label,
          fields,
          singleTemplateRef: definition.singleTemplateRef,
          archiveTemplateRef: definition.archiveTemplateRef,
          public: definition.public,
          expectedHead: current?.headRevision ?? null,
        });
        if (saved.status !== "saved") {
          throw syncConflict(entity.id, "content-type", entity.revisionHash);
        }
      };

      // Create relation-free stubs first so mutually related types can be
      // installed without depending on profile ordering.
      for (const entity of applyingTypes) {
        if (store.content.getType(entity.id)) continue;
        const definition = typePayload(entity);
        const fields = definition.fields
          .filter((field) => field.type !== "relation")
          .map((field) => ({ ...field, required: false }));
        saveType(entity, definition, fields);
      }

      const typeFinalDefinitions = new Map<string, { entity: typeof relationalTypes[number]; definition: ReturnType<typeof typePayload> }>();
      for (const entity of relationalTypes) {
        const remoteDefinition = typePayload(entity);
        const current = store.content.getType(entity.id);
        if (!current && !applyingTypeIds.has(entity.id)) {
          throw new TypeError(`Il tipo remoto ${remoteDefinition.key} non è presente nel progetto locale né tra le modifiche da importare.`);
        }
        const finalDefinition = applyingTypeIds.has(entity.id) ? remoteDefinition : current ? {
          key: current.key,
          label: current.label,
          fields: current.fields.map((field) => ({ ...field })) as unknown as Array<Record<string, unknown>>,
          singleTemplateRef: current.singleTemplateRef,
          archiveTemplateRef: current.archiveTemplateRef,
          public: current.public,
        } : remoteDefinition;
        const requiresRelationStaging = applyingRecords.length > 0 && finalDefinition.fields.some((field) => field.type === "relation" && field.required === true);
        if (requiresRelationStaging) {
          typeFinalDefinitions.set(entity.id, { entity, definition: finalDefinition });
          const stagedFields = finalDefinition.fields.map((field) => field.type === "relation" ? { ...field, required: false } : field);
          saveType(entity, finalDefinition, stagedFields);
        } else if (applyingTypeIds.has(entity.id)) {
          saveType(entity, remoteDefinition);
          changed.push(entity.id);
        }
      }

      for (const entity of applyingTaxonomies) {
        const payload = entity.payload;
        if (typeof payload.key !== "string" || typeof payload.label !== "string" || !Array.isArray(payload.types)) throw new TypeError(`Tassonomia remota non valida: ${entity.id}.`);
        const current = store.content.getTaxonomy(entity.id);
        const saved = store.content.saveTaxonomy({
          id: entity.id,
          key: payload.key,
          label: payload.label,
          types: payload.types,
          expectedHead: current?.headRevision ?? null,
        });
        if (saved.status !== "saved") {
          throw syncConflict(entity.id, "taxonomy", entity.revisionHash);
        }
        changed.push(entity.id);
      }

      // Detach changed parent links first, then rebuild the validated remote
      // hierarchy from roots downward. This also handles safe re-parenting
      // where the old and new trees have different ancestry.
      for (const entity of applyingTerms) {
        const payload = entity.payload;
        if (typeof payload.taxonomyKey !== "string" || typeof payload.slug !== "string" || typeof payload.label !== "string" || payload.parentId !== null && typeof payload.parentId !== "string") throw new TypeError(`Termine remoto non valido: ${entity.id}.`);
        const current = store.content.getTermById(entity.id);
        if (current?.parentId && current.parentId !== payload.parentId) {
          const staged = store.content.saveTerm({ id: entity.id, taxonomyKey: current.taxonomyKey, slug: current.slug, label: current.label, parentId: null, expectedHead: current.headRevision });
          if (staged.status !== "saved") throw syncConflict(entity.id, "term", entity.revisionHash);
        }
      }
      const pendingTerms = [...applyingTerms];
      const pendingTermIds = new Set(pendingTerms.map((entity) => entity.id));
      while (pendingTerms.length) {
        const index = pendingTerms.findIndex((entity) => entity.payload.parentId === null || typeof entity.payload.parentId === "string" && !pendingTermIds.has(entity.payload.parentId));
        if (index < 0) throw new TypeError("La gerarchia dei termini remoti contiene riferimenti ciclici o irrisolti.");
        const [entity] = pendingTerms.splice(index, 1);
        if (!entity) throw new Error("Termine non disponibile durante l’importazione.");
        pendingTermIds.delete(entity.id);
        const payload = entity.payload;
        if (typeof payload.taxonomyKey !== "string" || typeof payload.slug !== "string" || typeof payload.label !== "string" || payload.parentId !== null && typeof payload.parentId !== "string") throw new TypeError(`Termine remoto non valido: ${entity.id}.`);
        const current = store.content.getTermById(entity.id);
        const saved = store.content.saveTerm({
          id: entity.id,
          taxonomyKey: payload.taxonomyKey,
          slug: payload.slug,
          label: payload.label,
          parentId: payload.parentId,
          expectedHead: current?.headRevision ?? null,
        });
        if (saved.status !== "saved") throw syncConflict(entity.id, "term", entity.revisionHash);
        changed.push(entity.id);
      }

      const typeFieldsByKey = new Map(relationalTypes.map((entity) => [typePayload(entity).key, typePayload(entity).fields]));
      const recordTermAliases = (payload: Record<string, unknown>): Record<string, number[]> => {
        const source = payload.terms;
        if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("Assegnazioni tassonomie della voce remota non valide.");
        return Object.fromEntries(Object.entries(source as Record<string, unknown>).map(([taxonomyKey, ids]) => {
          if (!Array.isArray(ids)) throw new TypeError(`Elenco termini remoto non valido per ${taxonomyKey}.`);
          return [taxonomyKey, ids.map((termId) => {
            if (typeof termId !== "string") throw new TypeError(`Identificativo termine remoto non valido per ${taxonomyKey}.`);
            const term = store.content.getTermById(termId);
            if (!term || term.taxonomyKey !== taxonomyKey) throw new TypeError(`Il termine ${termId} non è presente nella tassonomia ${taxonomyKey}.`);
            return term.alias;
          })];
        }));
      };
      const recordInput = (entity: typeof applyingRecords[number], omitRelations: boolean) => {
        const payload = entity.payload;
        if (typeof payload.typeKey !== "string" || typeof payload.title !== "string" || typeof payload.slug !== "string" || typeof payload.locale !== "string" || (payload.status !== "draft" && payload.status !== "published" && payload.status !== "archived") || typeof payload.excerpt !== "string" || typeof payload.order !== "number" || !payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) throw new TypeError(`Record CMS remoto non valido: ${entity.id}.`);
        const fields = typeFieldsByKey.get(payload.typeKey);
        if (!fields) throw new TypeError(`Il tipo ${payload.typeKey} del record remoto non è presente nel profilo.`);
        const sourceValues = payload.values as Record<string, unknown>;
        const values = omitRelations ? Object.fromEntries(Object.entries(sourceValues).filter(([key]) => fields.find((field) => field.key === key)?.type !== "relation")) : sourceValues;
        return {
          id: entity.id,
          typeKey: payload.typeKey,
          title: payload.title,
          slug: payload.slug,
          locale: payload.locale,
          status: payload.status as CmsRecordStatus,
          publishedAt: typeof payload.publishedAt === "string" ? payload.publishedAt : null,
          excerpt: payload.excerpt,
          order: payload.order,
          values,
          terms: recordTermAliases(payload),
        };
      };
      for (const entity of applyingRecords) {
        const current = store.content.getRecordById(entity.id, true);
        const saved = store.content.saveRecord({ ...recordInput(entity, true), expectedHead: current?.headRevision ?? null });
        if (saved.status !== "saved") throw syncConflict(entity.id, "content-record", entity.revisionHash);
      }
      for (const entity of applyingRecords) {
        const current = store.content.getRecordById(entity.id, true);
        if (!current) throw new TypeError(`Il record ${entity.id} è scomparso durante l’importazione.`);
        const saved = store.content.saveRecord({ ...recordInput(entity, false), expectedHead: current.headRevision });
        if (saved.status !== "saved") throw syncConflict(entity.id, "content-record", entity.revisionHash);
        changed.push(entity.id);
      }

      for (const { entity, definition } of typeFinalDefinitions.values()) {
        saveType(entity, definition);
        if (applyingTypeIds.has(entity.id)) changed.push(entity.id);
      }
      for (const entity of applyingPosts) {
        const { content: _content, ...fields } = transferPostInput(entity, project.id);
        store.updatePostMetadata(entity.id, fields);
      }

      for (const entity of applyingQueryPresets) {
        const payload = entity.payload;
        if (typeof payload.key !== "string" || typeof payload.label !== "string" || typeof payload.typeKey !== "string" || typeof payload.limit !== "number" || typeof payload.orderBy !== "string" || (payload.order !== "asc" && payload.order !== "desc")) throw new TypeError(`Query remota non valida: ${entity.id}.`);
        const current = store.content.listQueryPresets().presets.find((preset) => preset.key === payload.key);
        const saved = store.content.saveQueryPreset({
          key: payload.key,
          label: payload.label,
          typeKey: payload.typeKey,
          limit: payload.limit,
          ...(typeof payload.limitParam === "string" ? { limitParam: payload.limitParam } : {}),
          offset: typeof payload.offset === "number" ? payload.offset : 0,
          ...(typeof payload.offsetParam === "string" ? { offsetParam: payload.offsetParam } : {}),
          orderBy: payload.orderBy,
          order: payload.order,
          ...(payload.filter !== undefined ? { filter: payload.filter } : {}),
          expectedHead: current?.headRevision ?? null,
        });
        if (saved.status !== "saved") throw syncConflict(entity.id, "query-preset", entity.revisionHash);
        changed.push(entity.id);
      }
      if (applyingQuerySources.length) {
        const sources = store.content.listQuerySources();
        for (const entity of applyingQuerySources) {
          const payload = entity.payload;
          if (typeof payload.name !== "string" || !Object.hasOwn(payload, "data")) throw new TypeError(`Sorgente query remota non valida: ${entity.id}.`);
          sources[payload.name] = { type: "json", data: payload.data };
        }
        store.content.saveQuerySources(sources);
        changed.push(...applyingQuerySources.map((entity) => entity.id));
      }
      if (deletions.length) {
        if (!recoveryBackup) throw new Error("Manca la copia di recupero prima della cancellazione.");
        const currentAfterUpdates = await createStaticPageProfile(project, store);
        const deletingIds = new Set(deletions.map((entity) => entity.id));
        const deletingRecordIds = deletions.filter((entity) => entity.payload.entityKind === "content-record").map((entity) => entity.id);
        for (const tombstone of deletions) {
          const previousHash = tombstone.payload.previousRevisionHash;
          const previous = currentAfterUpdates.profile.entities.find((entity) => entity.id === tombstone.id);
          const entityKind = tombstone.payload.entityKind;
          const referenced = entityKind === "content-record"
            ? store.content.hasIncomingRecordRelations(tombstone.id, deletingRecordIds)
            : currentAfterUpdates.profile.references.some((reference) => reference.targetId === tombstone.id && !deletingIds.has(reference.ownerId));
          if (!previous || previous.kind !== entityKind || previous.revisionHash !== previousHash || referenced) {
            throw new TypeError(`“${String(tombstone.payload.label)}” è cambiato o ha ancora collegamenti. Nessuna cancellazione è stata applicata.`);
          }
        }
        const verifiedDeletions: Array<{ entity: TransferEntity; verifiedCurrentHash: string }> = [];
        for (const tombstone of deletions) {
          const previous = currentAfterUpdates.profile.entities.find((entity) => entity.id === tombstone.id);
          if (!previous || previous.kind !== tombstone.payload.entityKind) throw new TypeError(`L’elemento ${tombstone.id} non è presente nella revisione verificata.`);
          verifiedDeletions.push({ entity: tombstone, verifiedCurrentHash: previous.revisionHash });
        }
        store.applyTransferTombstones(verifiedDeletions);
        changed.push(...verifiedDeletions.map(({ entity }) => entity.id));
      }
      // Doc 18 §6.6: the JavaScript of every document applied, set or cleared as the remote revision has it.
      for (const entity of effectiveApply) {
        if (entity.kind !== "document" && entity.kind !== "component" && entity.kind !== "template-part" && entity.kind !== "template") continue;
        store.setDocumentScript(entity.id, typeof entity.payload.script === "string" ? entity.payload.script : "");
      }
      for (const entity of scoped) store.setSyncBase(remoteSiteId, profile.manifest.project.id, entity.id, entity.revisionHash);
      await this.saveManifest(project);
      });
      return { project, changed, keptLocal, unchanged: scoped.filter((entity) => !changed.includes(entity.id) && !keptLocal.includes(entity.id)).map((entity) => entity.id) };
    } finally { store.close(); }
  }

  /**
   * The project, or null when there is no project with this id. A project that exists but cannot be opened (damaged
   * manifest, schema from a newer version, failed integrity check, locked database) throws a
   * `cms-project-unavailable` error instead: its data must not look gone.
   */
  async openProject(id: string): Promise<{ project: CmsProject; store: CmsProjectStore } | null> {
    if (!PROJECT_ID.test(id)) return null;
    let projectsRoot: string;
    try { projectsRoot = await realpath(this.projectsDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const directory = path.join(projectsRoot, id);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try { entry = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw projectUnavailable(id, error);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
    try {
      const resolved = await realpath(directory);
      if (path.dirname(resolved) !== projectsRoot) return null;
      const manifest = JSON.parse(await readFile(path.join(directory, "project.json"), "utf8")) as ProjectManifest;
      if (manifest.id !== id || manifest.schemaVersion !== 1 || typeof manifest.name !== "string" || typeof manifest.createdAt !== "string" || typeof manifest.updatedAt !== "string") {
        throw new TypeError("Il file project.json non è valido.");
      }
      const project: CmsProject = { ...manifest, directory: resolved };
      return { project, store: new CmsProjectStore(project, { durable: this.durable, ...(this.openDatabase ? { openDatabase: this.openDatabase } : {}) }) };
    } catch (error) {
      throw projectUnavailable(id, error);
    }
  }

  /**
   * Removes a project from the catalog and from disk. Its folder first leaves the catalog by an atomic rename to a
   * hidden name (`.deleting-…`, which no listing reads), so a failure there, such as a project whose files the system
   * still holds, changes nothing; then the folder is removed. False when there is no such project. A folder a crash
   * left half removed goes at the next start (initialize).
   */
  async deleteProject(id: string): Promise<boolean> {
    if (!PROJECT_ID.test(id)) return false;
    await this.initialize();
    const root = await this.projectsRoot();
    const directory = path.join(root, id);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try { entry = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
    const doomed = path.join(root, `.deleting-${id}-${randomUUID()}`);
    await rename(directory, doomed);
    await rm(doomed, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  }

  /** The projects folder's Cestino: hidden (no project id), so no listing of the catalog sees what is in it. */
  private async trashRoot(): Promise<string> {
    const root = path.join(await this.projectsRoot(), ".trash");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  /**
   * Moves a project to the Cestino, whole, with an atomic rename: nothing is copied or removed, and restoreProject puts
   * it back as it was. When it went is written next to it (`.trashed.json`). False when there is no such project.
   */
  async trashProject(id: string, at = new Date().toISOString()): Promise<boolean> {
    if (!PROJECT_ID.test(id)) return false;
    await this.initialize();
    const root = await this.projectsRoot();
    const directory = path.join(root, id);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try { entry = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
    const trash = await this.trashRoot();
    const target = path.join(trash, id);
    // An older copy of the same project already in the Cestino goes for good: the newer one replaces it.
    await this.purgeTrashedProject(id);
    await rename(directory, target);
    await writeFile(path.join(target, ".trashed.json"), `${JSON.stringify({ deletedAt: at })}\n`, { mode: 0o600 });
    return true;
  }

  /** The projects in the Cestino, most recently moved first, with when. One whose files cannot be read is left out. */
  async listTrashedProjects(): Promise<Array<{ id: string; name: string; deletedAt: string }>> {
    await this.initialize();
    const trash = await this.trashRoot();
    const out: Array<{ id: string; name: string; deletedAt: string }> = [];
    for (const entry of await readdir(trash, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(trash, entry.name, "project.json"), "utf8")) as { name?: unknown };
        const trashed = JSON.parse(await readFile(path.join(trash, entry.name, ".trashed.json"), "utf8")) as { deletedAt?: unknown };
        if (typeof manifest.name === "string" && typeof trashed.deletedAt === "string") out.push({ id: entry.name, name: manifest.name, deletedAt: trashed.deletedAt });
      } catch {
        // Not readable now: it stays in the Cestino folder and the next listing tries again.
      }
    }
    return out.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  /** Puts a project back from the Cestino. False when it is not there; an error when a project with its id exists. */
  async restoreProject(id: string): Promise<boolean> {
    if (!PROJECT_ID.test(id)) return false;
    await this.initialize();
    const source = path.join(await this.trashRoot(), id);
    try { if (!(await lstat(source)).isDirectory()) return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const target = path.join(await this.projectsRoot(), id);
    try {
      await lstat(target);
      throw new CmsProjectRestoreConflictError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, target);
    await rm(path.join(target, ".trashed.json"), { force: true });
    return true;
  }

  /** Deletes for good a project in the Cestino (out of the Cestino by a rename first, as deleteProject). */
  async purgeTrashedProject(id: string): Promise<boolean> {
    if (!PROJECT_ID.test(id)) return false;
    const source = path.join(await this.trashRoot(), id);
    try { if (!(await lstat(source)).isDirectory()) return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const doomed = path.join(await this.projectsRoot(), `.deleting-${id}-${randomUUID()}`);
    await rename(source, doomed);
    await rm(doomed, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  }

  async listProjects(): Promise<CmsProject[]> {
    return (await this.listProjectsWithProblems()).projects;
  }

  /** The projects that open, and the ones that exist but do not, with the reason. */
  async listProjectsWithProblems(): Promise<{ projects: CmsProject[]; unavailable: Array<{ id: string; message: string }> }> {
    await this.initialize();
    const entries = await readdir(this.projectsDirectory, { withFileTypes: true });
    const projects: CmsProject[] = [];
    const unavailable: Array<{ id: string; message: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
      try {
        const opened = await this.openProject(entry.name);
        if (!opened) continue;
        opened.store.close();
        projects.push(opened.project);
      } catch (error) {
        unavailable.push({ id: entry.name, message: error instanceof Error ? error.message : "Progetto non leggibile." });
      }
    }
    return { projects: projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), unavailable };
  }

  /**
   * The projects folder as the file system names it. On Windows the temporary folder can be a short 8.3 name
   * (RUNNER~1) while realpath() returns the long one: every project path is built from this form so the
   * containment checks compare like with like.
   */
  private async projectsRoot(): Promise<string> {
    return realpath(this.projectsDirectory);
  }

  async saveManifest(project: CmsProject): Promise<void> {
    if (!PROJECT_ID.test(project.id)) throw new TypeError("Percorso progetto non valido.");
    const projectsRoot = await realpath(this.projectsDirectory);
    const resolved = await realpath(project.directory);
    const directoryName = path.basename(resolved);
    const validName = directoryName === project.id || /^\.import-[0-9a-f-]{36}$/u.test(directoryName);
    if (path.dirname(resolved) !== projectsRoot || !validName || resolved !== project.directory) throw new TypeError("Percorso progetto non valido.");
    const updated = { ...project, updatedAt: new Date().toISOString() };
    await writeProjectManifest(resolved, updated);
  }
}

async function writeProjectManifest(directory: string, project: CmsProject): Promise<void> {
  const target = path.join(directory, "project.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  const { directory: _privateDirectory, ...manifest } = project;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try {
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeIncompleteProject(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
