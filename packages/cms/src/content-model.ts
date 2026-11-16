import { createHash, randomUUID } from "node:crypto";
import type { ProjectDatabase as DatabaseSync, ProjectStatement as StatementSync } from "./project-database.js";
import { canonicalizeJson, isProductFields, PRODUCT_TAXONOMIES, PRODUCT_TYPE_KEY, productSku, productValueIssues } from "@histos-publish/histos-contract";
import { postAddress } from "./translations.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY = /^[a-z][a-z0-9_-]{0,62}$/u;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/u;
const RESERVED_RECORD_KEYS = new Set(["id", "typeId", "typeKey", "slug", "locale", "title", "status", "publishedAt", "excerpt", "order", "updatedAt", "fields", "terms", "meta", "url"]);
const FIELD_TYPES = new Set(["text", "rich-text", "integer", "decimal", "boolean", "date", "datetime", "enum", "url", "asset", "relation"]);
const MAX_RECORDS_PER_QUERY = 100;
export const CMS_MAX_RELATION_DEPTH = 3;
const MAX_RELATION_EXPANSION_RECORDS = 1_000;
const RELATION_EXPANSION_BATCH_SIZE = 500;
const MAX_FILTER_DEPTH = 4;
/**
 * Leaf conditions of one filter, across its groups (audit note 85): four levels of 32 would make a million. The same
 * limit on WordPress (PageProfile::MAX_FILTER_LEAVES) and in the prototype check.
 */
export const CMS_MAX_FILTER_LEAVES = 256;

/** The leaf conditions of a filter, counted until the limit is passed (then limit + 1); groups beyond the depth count as leaves. */
export function cmsFilterLeaves(filter: unknown, limit = CMS_MAX_FILTER_LEAVES, depth = 0): number {
  if (depth <= MAX_FILTER_DEPTH && filter !== null && typeof filter === "object" && !Array.isArray(filter) && ("and" in filter || "or" in filter)) {
    const list = "and" in filter ? (filter as { and: unknown }).and : (filter as { or: unknown }).or;
    if (!Array.isArray(list)) return 1;
    let total = 0;
    for (const item of list) {
      total += cmsFilterLeaves(item, limit - total, depth + 1);
      if (total > limit) return total;
    }
    return total;
  }
  return 1;
}

function assertFilterLeaves(filter: unknown): void {
  if (cmsFilterLeaves(filter) > CMS_MAX_FILTER_LEAVES) throw new RangeError(`Un filtro ha più di ${CMS_MAX_FILTER_LEAVES} condizioni in tutto: semplificalo o dividilo in più query.`);
}

export type CmsFieldType = "text" | "rich-text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "enum" | "url" | "asset" | "relation";
export interface CmsFieldDefinition {
  key: string;
  label: string;
  type: CmsFieldType;
  required: boolean;
  public: boolean;
  multiple: boolean;
  options?: string[];
  targetType?: string;
}
export interface CmsContentType {
  id: string;
  key: string;
  label: string;
  fields: CmsFieldDefinition[];
  singleTemplateRef: string | null;
  archiveTemplateRef: string | null;
  /**
   * Doc 23 item 122: false for a type without pages of its own (no address, archive or template; shown only by loops),
   * as WordPress's `public: false`. True by default.
   */
  public: boolean;
  headRevision: string;
  updatedAt: string;
}
export type CmsRecordStatus = "draft" | "published" | "archived";
export interface CmsRecord {
  id: string;
  typeId: string;
  typeKey: string;
  slug: string;
  locale: string;
  title: string;
  status: CmsRecordStatus;
  publishedAt: string | null;
  excerpt: string;
  order: number;
  fields: Record<string, unknown>;
  values: Record<string, unknown>;
  terms: Record<string, CmsTerm[]>;
  headRevision: string;
  updatedAt: string;
}
export type CmsRecordFilter =
  | { and: CmsRecordFilter[] }
  | { or: CmsRecordFilter[] }
  | { taxonomyKey: string; termIds: string[]; operator: "IN" | "NOT IN" | "AND" }
  | { field: string; op: "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte" | "contains" | "exists"; value?: unknown };
export interface CmsTaxonomy { id: string; key: string; label: string; types: string[]; headRevision: string; updatedAt: string }
export interface CmsTerm { id: string; alias: number; taxonomyKey: string; slug: string; label: string; parentId: string | null; parentAlias: number | null; count: number; headRevision: string; updatedAt: string }
export interface CmsRecordQuery {
  typeKey: string;
  locale?: string;
  /** With `locale`: the records of this language too, while they have no published version in `locale`. */
  fallbackLocale?: string;
  status?: CmsRecordStatus | "any";
  includePrivate?: boolean;
  filter?: CmsRecordFilter;
  orderBy?: string;
  order?: "asc" | "desc";
  search?: string;
  limit?: number;
  offset?: number;
}
export interface CmsRecordPage { items: CmsRecord[]; total: number }
export interface CmsQueryPreset {
  key: string;
  label: string;
  typeKey: string;
  limit: number;
  limitParam?: string;
  offset: number;
  offsetParam?: string;
  orderBy: string;
  order: "asc" | "desc";
  filter?: CmsRecordFilter;
  headRevision: string;
  updatedAt: string;
}
export type CmsTypeSaveResult = { status: "saved"; contentType: CmsContentType } | { status: "conflict"; current: CmsContentType | null; expectedHead: string | null };
export type CmsRecordSaveResult = { status: "saved"; record: CmsRecord } | { status: "conflict"; current: CmsRecord | null; expectedHead: string | null };
export type CmsQueryPresetSaveResult = { status: "saved"; preset: CmsQueryPreset; head: string } | { status: "conflict"; current: CmsQueryPreset | null; expectedHead: string | null; head: string };
export type CmsQueriesSaveResult = { status: "saved"; presets: CmsQueryPreset[]; head: string } | { status: "conflict"; presets: CmsQueryPreset[]; expectedHead: string; head: string };

interface FieldRow { id: string; type_id: string; key: string; label: string; field_type: CmsFieldType; required: number; is_public: number; multiple: number; config_json: string; ordinal: number }
interface TypeRow { id: string; key: string; label: string; single_template_ref?: string | null; archive_template_ref?: string | null; is_public?: number | null; head_revision: string; updated_at: string }
interface RecordRow { id: string; type_id: string; type_key?: string; slug: string; locale: string; title: string; status: CmsRecordStatus; published_at: string | null; excerpt: string; order_no: number; head_revision: string; updated_at: string }
interface ValueRow { record_id: string; field_id: string; ordinal: number; text_value: string | null; number_value: number | null; bool_value: number | null; json_value: string | null; asset_id: string | null }
interface RelationRow { record_id: string; field_id: string; target_id: string; ordinal: number }
interface QueryPresetRow { key: string; label: string; type_id: string | null; builtin_type?: string | null; limit_no: number; limit_param?: string | null; offset_no?: number; offset_param?: string | null; order_by: string; direction: "asc" | "desc"; filter_json: string | null; head_revision: string; updated_at: string }
interface TaxonomyRow { id: string; key: string; label: string; for_posts?: number; head_revision: string; updated_at: string }
interface PostRow { id: string; slug: string; title: string; status: "draft" | "published"; published_at: string | null; excerpt: string; image_asset_id: string | null; alias: number; head_revision: string; locale: string | null; updated_at: string }
interface TermRow { id: string; alias: number; taxonomy_id: string; taxonomy_key: string; slug: string; label: string; parent_id: string | null; head_revision: string; updated_at: string }
export type CmsTaxonomySaveResult = { status: "saved"; taxonomy: CmsTaxonomy } | { status: "conflict"; current: CmsTaxonomy | null; expectedHead: string | null };
export type CmsTermSaveResult = { status: "saved"; term: CmsTerm } | { status: "conflict"; current: CmsTerm | null; expectedHead: string | null };

function hash(value: unknown): string { return createHash("sha256").update(canonicalizeJson(value as never), "utf8").digest("hex"); }
function slugify(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63).replace(/-+$/u, "") || "record"; }
/** The built-in post type (docs/spec/cms-bridge.md §12): posts are documents, not records, but queries can list them. */
export const POST_TYPE_KEY = "post";
/** Keys the content model reserves: the built-in document types. */
const RESERVED_TYPE_KEYS = new Set(["post", "page"]);
/** WordPress-native taxonomies, attached to posts only. */
export const POST_TAXONOMY_KEYS = new Set(["category", "post_tag"]);
/** The static address of a post. */
export function postUrl(slug: string): string {
  return "/blog/" + slug + "/";
}

/*
 * The archives of the static build (cms-api.ts, planCmsRoutes and the writers that follow its plan) as WordPress serves
 * them, written once here for the build, the prototype check and the prototype's quality walk (prototype-quality.ts),
 * which must all name the same pages:
 * - every archive lists CMS_ARCHIVE_PAGE_SIZE contents a page, WordPress's default posts_per_page (Settings → Reading,
 *   «Blog pages show at most 10»), with a template or without one: one archive has one pagination, and /opera/page/2/
 *   lists the same records whether a template renders it, its {#loop main()} or the build's own page;
 * - an archive with no published content is written in the site's language only (WordPress serves an empty term or
 *   type archive, so a menu link to it is never a 404); another language gets one once something is published in it;
 * - the posts index /blog/ exists when the project has a post, a draft too (the blog is started), and no page the
 *   build writes takes /blog/; a template with the home role alone makes none;
 * - a term's archive lists the contents of its descendant terms too in a hierarchical taxonomy (WordPress's
 *   include_children): every taxonomy but post_tag, which WordPress keeps flat.
 */
/** Contents per page of every archive: WordPress's default posts_per_page. */
export const CMS_ARCHIVE_PAGE_SIZE = 10;

/** The pages of an archive of `total` contents: one at least, the empty archive's own. */
export function cmsArchivePageCount(total: number): number {
  return Math.max(1, Math.ceil(total / CMS_ARCHIVE_PAGE_SIZE));
}

/** At most this many links in `page.pageLinks` of an archive: its first pages (A8, as the builder on WordPress). */
export const CMS_ARCHIVE_PAGE_LINKS = 100;

/** The address of page `page` of the archive at `address` (`/opera/`): the address itself, then `/opera/page/2/`. */
export function cmsArchivePageAddress(address: string, page: number): string {
  return page === 1 ? address : `${address}page/${page}/`;
}

/** A link of `page.pageLinks`: the page's number, its address, and whether it is the page shown. */
export interface CmsArchivePageLink {
  number: number;
  url: string;
  current: boolean;
}

/**
 * The links between the pages of an archive (A8), in its page scope next to `page`, `totalPages` and `totalRecords`:
 * `prevUrl` and `nextUrl` are "" where there is no such page, `pageLinks` has pages 1..totalPages, the first
 * CMS_ARCHIVE_PAGE_LINKS of them. Addresses as the build writes them (cmsArchivePageAddress), with the trailing slash.
 */
export function cmsArchivePaging(address: string, page: number, totalPages: number): { prevUrl: string; nextUrl: string; pageLinks: CmsArchivePageLink[] } {
  const pageLinks: CmsArchivePageLink[] = [];
  for (let number = 1; number <= Math.min(totalPages, CMS_ARCHIVE_PAGE_LINKS); number++) pageLinks.push({ number, url: cmsArchivePageAddress(address, number), current: number === page });
  return {
    prevUrl: page > 1 ? cmsArchivePageAddress(address, page - 1) : "",
    nextUrl: page < totalPages ? cmsArchivePageAddress(address, page + 1) : "",
    pageLinks,
  };
}

/** Whether the build writes an archive with `total` published contents in a language: always in the site's own. */
export function cmsArchiveWritten(total: number, siteLanguage: boolean): boolean {
  return total > 0 || siteLanguage;
}

/** Whether the build writes the posts index /blog/: the project has `posts` (drafts counted) and no page takes /blog/. */
export function cmsPostsIndexWritten(input: { posts: number; blogPage: boolean }): boolean {
  return input.posts > 0 && !input.blogPage;
}

/** Whether a term's archive lists its descendants' contents too: WordPress's hierarchical taxonomies, all but post_tag. */
export function cmsTermArchiveIncludesChildren(taxonomyKey: string): boolean {
  return taxonomyKey !== "post_tag";
}

/** The template roles a term's archive renders with, the first one present winning (WordPress's template hierarchy). */
export function cmsTermArchiveRoles(taxonomyKey: string): ReadonlyArray<"category" | "tag" | "archive" | "index"> {
  return taxonomyKey === "category" ? ["category", "archive", "index"] : taxonomyKey === "post_tag" ? ["tag", "archive", "index"] : ["archive", "index"];
}
/** The computer's language, read once (ContentModel.projectLocale). */
let systemLocale: string | undefined;

function contentUrl(typeKey: string, slug: string, locale: string, defaultLocale: string): string {
  if (typeKey === POST_TYPE_KEY) return postAddress({ slug, locale }, defaultLocale);
  const normalizedLocale = Intl.getCanonicalLocales(locale)[0] ?? defaultLocale;
  const prefix = normalizedLocale.toLowerCase() === defaultLocale.toLowerCase() ? "" : "/" + normalizedLocale.toLowerCase();
  return prefix + "/" + typeKey + "/" + slug + "/";
}
function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} deve essere un oggetto.`);
  return value as Record<string, unknown>;
}
function validJson(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every((item) => validJson(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 1000 && entries.every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && validJson(item, depth + 1));
}
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function isValidDateTime(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/u.test(value)
    && isValidDate(value.slice(0, 10))
    && Number.isFinite(Date.parse(value));
}
function normalizeFields(value: unknown): CmsFieldDefinition[] {
  if (!Array.isArray(value) || value.length > 64) throw new TypeError("Un tipo può avere al massimo 64 campi.");
  const seen = new Set<string>();
  return value.map((raw) => {
    const field = jsonObject(raw, "Il campo");
    if (typeof field.key !== "string" || !FIELD_KEY.test(field.key) || RESERVED_RECORD_KEYS.has(field.key) || seen.has(field.key)) throw new TypeError(`Chiave campo non valida o duplicata: ${String(field.key)}.`);
    if (typeof field.label !== "string" || !field.label.trim() || field.label.length > 120) throw new TypeError(`Etichetta del campo ${field.key} non valida.`);
    if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) throw new TypeError(`Tipo del campo ${field.key} non supportato.`);
    seen.add(field.key);
    const definition: CmsFieldDefinition = {
      key: field.key, label: field.label.trim(), type: field.type as CmsFieldType,
      required: field.required === true, public: field.public === true, multiple: field.multiple === true,
    };
    if (field.options !== undefined) {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 100 || field.options.some((item) => typeof item !== "string" || !item || item.length > 200) || new Set(field.options).size !== field.options.length) throw new TypeError(`Le opzioni del campo ${field.key} non sono valide.`);
      definition.options = field.options as string[];
    }
    if (definition.type === "enum" && !definition.options) throw new TypeError(`Il campo enum ${field.key} deve elencare le opzioni ammesse.`);
    if (definition.type === "relation") {
      if (typeof field.targetType !== "string" || !KEY.test(field.targetType)) throw new TypeError(`Il campo relazione ${field.key} deve indicare un tipo di destinazione.`);
      definition.targetType = field.targetType;
    } else if (field.targetType !== undefined) throw new TypeError(`Il campo ${field.key} non è una relazione.`);
    return definition;
  });
}

/** A statement compiled once per model: compiling the same SQL for every record was most of a big import (D3). */
type Prepare = (sql: string) => StatementSync;

function typeFromRow(prepare: Prepare, row: TypeRow): CmsContentType {
  const fields = prepare("SELECT * FROM cms_field_defs WHERE type_id = ? ORDER BY ordinal, key").all(row.id) as unknown as FieldRow[];
  return {
    id: row.id, key: row.key, label: row.label,
    fields: fields.map((field) => ({ key: field.key, label: field.label, type: field.field_type, required: field.required === 1, public: field.is_public === 1, multiple: field.multiple === 1, ...JSON.parse(field.config_json) as Pick<CmsFieldDefinition, "options" | "targetType"> })),
    singleTemplateRef: row.single_template_ref ?? null,
    archiveTemplateRef: row.archive_template_ref ?? null,
    public: row.is_public !== 0,
    headRevision: row.head_revision, updatedAt: row.updated_at,
  };
}

function normalizeTemplateRef(value: unknown, fallback: string | null, label: string): string | null {
  const candidate = value === undefined ? fallback : value;
  if (candidate === null || candidate === "") return null;
  if (typeof candidate !== "string" || candidate.length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]*)*)?$/u.test(candidate)) {
    throw new TypeError(`Il riferimento template ${label} non è valido.`);
  }
  return candidate;
}

function bindValue(prepare: Prepare, recordId: string, field: CmsFieldDefinition, fieldId: string, value: unknown, ordinal: number, publishedRecord: boolean): void {
  const entries = field.multiple ? (Array.isArray(value) ? value : null) : (Array.isArray(value) ? null : [value]);
  if (!entries) throw new TypeError(`Il campo ${field.key} ${field.multiple ? "deve essere una lista" : "non accetta una lista"}.`);
  if (entries.length > 1000) throw new RangeError(`Il campo ${field.key} supera il limite di valori.`);
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index];
    if (field.required && (item === null || item === undefined || item === "")) throw new TypeError(`Il campo obbligatorio ${field.key} non può essere vuoto.`);
    if (item === null || item === undefined || item === "") {
      prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, json_value) VALUES (?, ?, ?, 'null')").run(recordId, fieldId, ordinal + index);
      continue;
    }
    switch (field.type) {
      case "text": case "rich-text":
        if (typeof item !== "string" || item.length > 1_000_000) throw new TypeError(`Il campo ${field.key} deve contenere testo entro 1 MB.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, text_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "integer":
        if (!Number.isSafeInteger(item)) throw new TypeError(`Il campo ${field.key} richiede un intero sicuro.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, number_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "decimal":
        if (typeof item !== "number" || !Number.isFinite(item)) throw new TypeError(`Il campo ${field.key} richiede un numero finito.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, number_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "boolean":
        if (typeof item !== "boolean") throw new TypeError(`Il campo ${field.key} richiede true o false.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, bool_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item ? 1 : 0); break;
      case "date":
        if (typeof item !== "string" || !isValidDate(item)) throw new TypeError(`Il campo ${field.key} richiede una data YYYY-MM-DD.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, text_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "datetime":
        if (!isValidDateTime(item)) throw new TypeError(`Il campo ${field.key} richiede una data ISO con orario e fuso esplicito.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, text_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "enum":
        if (typeof item !== "string" || !field.options?.includes(item)) throw new TypeError(`Il valore del campo ${field.key} non è tra le opzioni ammesse.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, text_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "url":
        if (typeof item !== "string" || item.length > 2048 || !(item.startsWith("/") && !item.startsWith("//") || /^https?:\/\//iu.test(item))) throw new TypeError(`Il campo ${field.key} deve contenere un URL http(s) o un percorso del sito.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, text_value) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "asset":
        if (typeof item !== "string" || !UUID.test(item) || !prepare("SELECT 1 FROM assets WHERE id = ?").get(item)) throw new TypeError(`L’asset del campo ${field.key} non esiste nel progetto.`);
        prepare("INSERT INTO cms_field_values(record_id, field_id, ordinal, asset_id) VALUES (?, ?, ?, ?)").run(recordId, fieldId, ordinal + index, item); break;
      case "relation": {
        if (typeof item !== "string" || !UUID.test(item)) throw new TypeError(`Il campo relazione ${field.key} contiene un ID non valido.`);
        const target = prepare("SELECT r.id, t.key AS type_key FROM cms_records r JOIN cms_content_types t ON t.id = r.type_id JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE r.id = ?").get(item) as { id: string; type_key: string } | undefined;
        if (!target || target.type_key !== field.targetType) throw new TypeError(`Il record collegato al campo ${field.key} non appartiene al tipo ${field.targetType}.`);
        const targetStatus = prepare("SELECT r.status FROM cms_records r JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE r.id = ?").get(item) as { status: CmsRecordStatus };
        if (publishedRecord && targetStatus.status !== "published") throw new TypeError(`Il record collegato al campo ${field.key} non è ancora pubblicato.`);
        prepare("INSERT INTO cms_record_relations(record_id, field_id, target_id, ordinal) VALUES (?, ?, ?, ?)").run(recordId, fieldId, item, ordinal + index); break;
      }
    }
  }
}

export class CmsContentModel {
  private transactionDepth = 0;

  /** Shares an enclosing project-store transaction without opening a second SQLite transaction. */
  async withOuterTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const depth = this.transactionDepth;
    this.transactionDepth = depth + 1;
    try { return await operation(); }
    finally { this.transactionDepth = depth; }
  }

  /**
   * The model's own statements: a cache keyed by the database (a WeakMap) would keep every database alive, since a
   * statement holds its database.
   */
  private readonly statements = new Map<string, StatementSync>();
  private readonly prepare: Prepare = (sql) => {
    const known = this.statements.get(sql);
    if (known) return known;
    // Queries with a list of ids differ in length: the cache stays small by forgetting them all at once.
    if (this.statements.size >= 256) this.statements.clear();
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  };

  constructor(private readonly db: DatabaseSync) {}

  /**
   * Creates or upgrades the content tables. Runs only inside the project's schema migration
   * (CmsProjectStore), never on an ordinary open.
   */
  static migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cms_identity_registry(id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS cms_content_types(id TEXT PRIMARY KEY REFERENCES cms_identity_registry(id), key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, single_template_ref TEXT, archive_template_ref TEXT, head_revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_type_revisions(id TEXT PRIMARY KEY, type_id TEXT NOT NULL REFERENCES cms_content_types(id), parent_id TEXT REFERENCES cms_type_revisions(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_field_defs(id TEXT PRIMARY KEY, type_id TEXT NOT NULL REFERENCES cms_content_types(id), key TEXT NOT NULL, label TEXT NOT NULL, field_type TEXT NOT NULL, required INTEGER NOT NULL CHECK(required IN (0,1)), is_public INTEGER NOT NULL CHECK(is_public IN (0,1)), multiple INTEGER NOT NULL CHECK(multiple IN (0,1)), config_json TEXT NOT NULL, ordinal INTEGER NOT NULL, UNIQUE(type_id, key));
      CREATE TABLE IF NOT EXISTS cms_records(id TEXT PRIMARY KEY REFERENCES cms_identity_registry(id), type_id TEXT NOT NULL REFERENCES cms_content_types(id), slug TEXT NOT NULL, locale TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published','archived')), published_at TEXT, excerpt TEXT NOT NULL DEFAULT '', order_no INTEGER NOT NULL DEFAULT 0, parent_id TEXT REFERENCES cms_records(id), head_revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(type_id, locale, slug));
      CREATE INDEX IF NOT EXISTS cms_records_type_status_order ON cms_records(type_id, status, locale, order_no, id);
      CREATE TABLE IF NOT EXISTS cms_record_revisions(id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES cms_records(id), parent_id TEXT REFERENCES cms_record_revisions(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('editor','import','conflict-resolution')));
      CREATE INDEX IF NOT EXISTS cms_record_revisions_head ON cms_record_revisions(record_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS cms_field_values(record_id TEXT NOT NULL REFERENCES cms_records(id), field_id TEXT NOT NULL REFERENCES cms_field_defs(id), ordinal INTEGER NOT NULL, text_value TEXT, number_value REAL, bool_value INTEGER CHECK(bool_value IS NULL OR bool_value IN (0,1)), json_value TEXT, asset_id TEXT REFERENCES assets(id), PRIMARY KEY(record_id, field_id, ordinal), CHECK((text_value IS NOT NULL) + (number_value IS NOT NULL) + (bool_value IS NOT NULL) + (json_value IS NOT NULL) + (asset_id IS NOT NULL) = 1));
      CREATE INDEX IF NOT EXISTS cms_field_values_text ON cms_field_values(field_id, text_value, record_id);
      CREATE INDEX IF NOT EXISTS cms_field_values_number ON cms_field_values(field_id, number_value, record_id);
      CREATE INDEX IF NOT EXISTS cms_field_values_bool ON cms_field_values(field_id, bool_value, record_id);
      CREATE TABLE IF NOT EXISTS cms_record_relations(record_id TEXT NOT NULL REFERENCES cms_records(id), field_id TEXT NOT NULL REFERENCES cms_field_defs(id), target_id TEXT NOT NULL REFERENCES cms_records(id), ordinal INTEGER NOT NULL, PRIMARY KEY(record_id, field_id, target_id), UNIQUE(record_id, field_id, ordinal));
      CREATE INDEX IF NOT EXISTS cms_record_relations_target ON cms_record_relations(field_id, target_id, record_id);
      CREATE TABLE IF NOT EXISTS cms_content_conflicts(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, entity_kind TEXT NOT NULL CHECK(entity_kind IN ('content-type','record')), expected_head TEXT, actual_head TEXT, proposed_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS cms_query_state(id INTEGER PRIMARY KEY CHECK(id=1), head_revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_query_revisions(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES cms_query_revisions(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_query_presets(key TEXT PRIMARY KEY, label TEXT NOT NULL, type_id TEXT NOT NULL REFERENCES cms_content_types(id), limit_no INTEGER NOT NULL CHECK(limit_no BETWEEN 1 AND 100), limit_param TEXT, offset_no INTEGER NOT NULL DEFAULT 0 CHECK(offset_no BETWEEN 0 AND 1000000), offset_param TEXT, order_by TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('asc','desc')), filter_json TEXT, head_revision TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_query_sources(name TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_taxonomies(id TEXT PRIMARY KEY REFERENCES cms_identity_registry(id), key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, head_revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_taxonomy_types(taxonomy_id TEXT NOT NULL REFERENCES cms_taxonomies(id) ON DELETE CASCADE, type_id TEXT NOT NULL REFERENCES cms_content_types(id) ON DELETE CASCADE, PRIMARY KEY(taxonomy_id,type_id));
      CREATE TABLE IF NOT EXISTS cms_taxonomy_revisions(id TEXT PRIMARY KEY, taxonomy_id TEXT NOT NULL REFERENCES cms_taxonomies(id), parent_id TEXT REFERENCES cms_taxonomy_revisions(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_terms(alias INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE REFERENCES cms_identity_registry(id), taxonomy_id TEXT NOT NULL REFERENCES cms_taxonomies(id), slug TEXT NOT NULL, label TEXT NOT NULL, parent_id TEXT REFERENCES cms_terms(id), head_revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(taxonomy_id,slug));
      CREATE INDEX IF NOT EXISTS cms_terms_taxonomy_parent ON cms_terms(taxonomy_id,parent_id,alias);
      CREATE TABLE IF NOT EXISTS cms_term_revisions(id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES cms_terms(id), parent_id TEXT REFERENCES cms_term_revisions(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cms_record_terms(record_id TEXT NOT NULL REFERENCES cms_records(id), taxonomy_id TEXT NOT NULL REFERENCES cms_taxonomies(id), term_id TEXT NOT NULL REFERENCES cms_terms(id), ordinal INTEGER NOT NULL, PRIMARY KEY(record_id,term_id), UNIQUE(record_id,taxonomy_id,ordinal));
      CREATE INDEX IF NOT EXISTS cms_record_terms_term ON cms_record_terms(taxonomy_id,term_id,record_id);
    `);
    const typeColumns = db.prepare("PRAGMA table_info(cms_content_types)").all() as Array<{ name: string }>;
    if (!typeColumns.some((column) => column.name === "single_template_ref")) db.exec("ALTER TABLE cms_content_types ADD COLUMN single_template_ref TEXT");
    if (!typeColumns.some((column) => column.name === "is_public")) db.exec("ALTER TABLE cms_content_types ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1");
    if (!typeColumns.some((column) => column.name === "archive_template_ref")) db.exec("ALTER TABLE cms_content_types ADD COLUMN archive_template_ref TEXT");
    const queryColumns = db.prepare("PRAGMA table_info(cms_query_presets)").all() as Array<{ name: string }>;
    if (!queryColumns.some((column) => column.name === "limit_param")) db.exec("ALTER TABLE cms_query_presets ADD COLUMN limit_param TEXT");
    if (!queryColumns.some((column) => column.name === "offset_no")) db.exec("ALTER TABLE cms_query_presets ADD COLUMN offset_no INTEGER NOT NULL DEFAULT 0 CHECK(offset_no BETWEEN 0 AND 1000000)");
    if (!queryColumns.some((column) => column.name === "offset_param")) db.exec("ALTER TABLE cms_query_presets ADD COLUMN offset_param TEXT");
    if (!queryColumns.some((column) => column.name === "builtin_type")) {
      // A query over posts has no content type row: type_id becomes optional, with exactly one of the two set.
      db.exec(`
        CREATE TABLE cms_query_presets_v3(key TEXT PRIMARY KEY, label TEXT NOT NULL, type_id TEXT REFERENCES cms_content_types(id), builtin_type TEXT CHECK(builtin_type IS NULL OR builtin_type = 'post'), limit_no INTEGER NOT NULL CHECK(limit_no BETWEEN 1 AND 100), limit_param TEXT, offset_no INTEGER NOT NULL DEFAULT 0 CHECK(offset_no BETWEEN 0 AND 1000000), offset_param TEXT, order_by TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('asc','desc')), filter_json TEXT, head_revision TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK((type_id IS NULL) <> (builtin_type IS NULL)));
        INSERT INTO cms_query_presets_v3(key,label,type_id,builtin_type,limit_no,limit_param,offset_no,offset_param,order_by,direction,filter_json,head_revision,updated_at) SELECT key,label,type_id,NULL,limit_no,limit_param,offset_no,offset_param,order_by,direction,filter_json,head_revision,updated_at FROM cms_query_presets;
        DROP TABLE cms_query_presets;
        ALTER TABLE cms_query_presets_v3 RENAME TO cms_query_presets;
      `);
    }
    const taxonomyColumns = db.prepare("PRAGMA table_info(cms_taxonomies)").all() as Array<{ name: string }>;
    if (!taxonomyColumns.some((column) => column.name === "for_posts")) db.exec("ALTER TABLE cms_taxonomies ADD COLUMN for_posts INTEGER NOT NULL DEFAULT 0 CHECK(for_posts IN (0,1))");
    db.exec(`
      INSERT OR IGNORE INTO cms_identity_registry(id, kind, created_at) SELECT id, kind, created_at FROM entities;
      INSERT OR IGNORE INTO cms_identity_registry(id, kind, created_at) SELECT id, kind, created_at FROM cms_components;
      INSERT OR IGNORE INTO cms_identity_registry(id, kind, created_at) SELECT id, 'asset', created_at FROM assets;
    `);
  }

  listTypes(): CmsContentType[] {
    return (this.prepare("SELECT * FROM cms_content_types ORDER BY label, key").all() as unknown as TypeRow[]).map((row) => typeFromRow(this.prepare, row));
  }

  getType(keyOrId: string): CmsContentType | null {
    const row = this.prepare("SELECT * FROM cms_content_types WHERE key = ? OR id = ?").get(keyOrId, keyOrId) as unknown as TypeRow | undefined;
    return row ? typeFromRow(this.prepare, row) : null;
  }

  listTaxonomies(): CmsTaxonomy[] {
    const rows = this.prepare("SELECT * FROM cms_taxonomies ORDER BY label,key").all() as unknown as TaxonomyRow[];
    return rows.map((row) => this.taxonomyFromRow(row));
  }

  getTaxonomy(keyOrId: string): CmsTaxonomy | null {
    const row = this.prepare("SELECT * FROM cms_taxonomies WHERE key=? OR id=?").get(keyOrId, keyOrId) as unknown as TaxonomyRow | undefined;
    return row ? this.taxonomyFromRow(row) : null;
  }

  saveTaxonomy(input: { id?: string; key: string; label: string; types?: unknown; expectedHead?: string | null }): CmsTaxonomySaveResult {
    if (typeof input.key !== "string" || !KEY.test(input.key)) throw new TypeError("La chiave tassonomia deve usare lettere minuscole, numeri, trattini o underscore.");
    if (typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 120) throw new TypeError("Il nome della tassonomia è obbligatorio e non può superare 120 caratteri.");
    const id = input.id ?? randomUUID();
    if (!UUID.test(id)) throw new TypeError("Identificativo tassonomia non valido.");
    const existing = this.getTaxonomy(id);
    if (existing && existing.key !== input.key) throw new TypeError("La chiave di una tassonomia esistente non può essere cambiata.");
    if (!existing && input.expectedHead !== undefined && input.expectedHead !== null) return { status: "conflict", current: null, expectedHead: input.expectedHead };
    const typeKeys = input.types === undefined ? existing?.types ?? [] : input.types;
    if (!Array.isArray(typeKeys) || typeKeys.length > 64 || typeKeys.some((key) => typeof key !== "string") || new Set(typeKeys).size !== typeKeys.length) throw new TypeError("Indica al massimo 64 tipi distinti per la tassonomia.");
    if (RESERVED_TYPE_KEYS.has(input.key)) throw new TypeError(`La chiave ${input.key} è riservata a un tipo predefinito.`);
    const forPosts = (typeKeys as string[]).includes(POST_TYPE_KEY);
    if (POST_TAXONOMY_KEYS.has(input.key) && (typeKeys.length !== 1 || !forPosts)) throw new TypeError("Categorie e tag valgono soltanto per gli articoli.");
    if ((PRODUCT_TAXONOMIES as readonly string[]).includes(input.key) && (typeKeys.length !== 1 || typeKeys[0] !== PRODUCT_TYPE_KEY)) throw new TypeError("Le categorie e i tag dei prodotti valgono soltanto per i prodotti.");
    const types = (typeKeys as string[]).filter((key) => key !== POST_TYPE_KEY).map((key) => {
      const type = this.getType(key);
      if (!type) throw new TypeError("Tipo tassonomia non trovato: " + key + ".");
      return type;
    });
    const definition = { key: input.key, label: input.label.trim(), types: [...types.map((type) => type.key), ...(forPosts ? [POST_TYPE_KEY] : [])].sort() };
    const payload = canonicalizeJson(definition as never);
    const revision = randomUUID();
    const now = new Date().toISOString();
    return this.transaction(() => {
      const current = this.getTaxonomy(id);
      if (current && (input.expectedHead === undefined || input.expectedHead !== current.headRevision)) return { status: "conflict", current, expectedHead: input.expectedHead ?? null } as const;
      if (this.prepare("SELECT 1 FROM cms_taxonomies WHERE key=? AND id<>?").get(input.key, id)) throw new TypeError("Esiste già la tassonomia " + input.key + ".");
      if (this.prepare("SELECT 1 FROM cms_content_types WHERE key=?").get(input.key)) throw new TypeError("Il nome tecnico è già usato da un tipo di contenuto.");
      if (current && !forPosts && current.types.includes(POST_TYPE_KEY) && this.prepare("SELECT 1 FROM cms_post_terms WHERE taxonomy_id=? LIMIT 1").get(id)) throw new TypeError("La tassonomia è ancora usata da articoli: togli prima i termini dagli articoli.");
      if (!current) {
        this.prepare("INSERT INTO cms_identity_registry(id,kind,created_at) VALUES(?,'taxonomy',?)").run(id, now);
        this.prepare("INSERT INTO cms_taxonomies(id,key,label,for_posts,head_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, input.key, definition.label, forPosts ? 1 : 0, revision, now, now);
      } else this.prepare("UPDATE cms_taxonomies SET label=?,for_posts=?,head_revision=?,updated_at=? WHERE id=?").run(definition.label, forPosts ? 1 : 0, revision, now, id);
      this.prepare("DELETE FROM cms_taxonomy_types WHERE taxonomy_id=?").run(id);
      const insertType = this.prepare("INSERT INTO cms_taxonomy_types(taxonomy_id,type_id) VALUES(?,?)");
      for (const type of types) insertType.run(id, type.id);
      this.prepare("INSERT INTO cms_taxonomy_revisions(id,taxonomy_id,parent_id,created_at,payload_json,content_hash) VALUES(?,?,?,?,?,?)").run(revision, id, current?.headRevision ?? null, now, payload, hash(definition));
      return { status: "saved", taxonomy: this.getTaxonomy(id)! } as const;
    });
  }

  listTerms(taxonomyKey: string): CmsTerm[] {
    const taxonomy = this.getTaxonomy(taxonomyKey);
    if (!taxonomy) throw new TypeError("Tassonomia non trovata: " + taxonomyKey + ".");
    const rows = this.prepare("SELECT term.*, tax.key AS taxonomy_key FROM cms_terms term JOIN cms_taxonomies tax ON tax.id=term.taxonomy_id WHERE term.taxonomy_id=? ORDER BY term.parent_id,term.label,term.alias").all(taxonomy.id) as unknown as TermRow[];
    return rows.map((row) => this.termFromRow(row));
  }

  getTermByAlias(alias: number): CmsTerm | null {
    if (!Number.isSafeInteger(alias) || alias < 1) return null;
    const row = this.prepare("SELECT term.*, tax.key AS taxonomy_key FROM cms_terms term JOIN cms_taxonomies tax ON tax.id=term.taxonomy_id WHERE term.alias=?").get(alias) as unknown as TermRow | undefined;
    return row ? this.termFromRow(row) : null;
  }

  getTermById(id: string): CmsTerm | null {
    const row = this.prepare("SELECT term.*, tax.key AS taxonomy_key FROM cms_terms term JOIN cms_taxonomies tax ON tax.id=term.taxonomy_id WHERE term.id=?").get(id) as unknown as TermRow | undefined;
    return row ? this.termFromRow(row) : null;
  }

  saveTerm(input: { id?: string; alias?: number; taxonomyKey: string; slug: string; label: string; parentId?: string | null; parentAlias?: number | null; expectedHead?: string | null }): CmsTermSaveResult {
    const taxonomy = this.getTaxonomy(input.taxonomyKey);
    if (!taxonomy) throw new TypeError("Tassonomia non trovata: " + input.taxonomyKey + ".");
    if (typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 120) throw new TypeError("Il nome del termine è obbligatorio e non può superare 120 caratteri.");
    if (typeof input.slug !== "string" || !input.slug.trim() || input.slug.length > 120) throw new TypeError("L'indirizzo del termine è obbligatorio.");
    const slug = slugify(input.slug);
    if (input.id !== undefined && !UUID.test(input.id)) throw new TypeError("Identificativo termine non valido.");
    const currentByAlias = input.alias === undefined ? null : this.getTermByAlias(input.alias);
    const currentById = input.id === undefined ? null : this.getTermById(input.id);
    if (currentByAlias && currentById && currentByAlias.id !== currentById.id) throw new TypeError("Alias e identificativo indicano due termini diversi.");
    const current = currentById ?? currentByAlias;
    if (input.alias !== undefined && !current) throw new TypeError("Termine tassonomia non trovato.");
    if (current && current.taxonomyKey !== taxonomy.key) throw new TypeError("Il termine non appartiene alla tassonomia scelta.");
    const id = current?.id ?? input.id ?? randomUUID();
    if (input.parentId !== undefined && input.parentAlias !== undefined) throw new TypeError("Indica il termine genitore con l’identificativo o con l’alias, non entrambi.");
    const parent = input.parentId !== undefined ? input.parentId === null ? null : this.getTermById(input.parentId)
      : input.parentAlias === undefined || input.parentAlias === null ? null : this.getTermByAlias(input.parentAlias);
    if (input.parentId !== undefined && input.parentId !== null && !UUID.test(input.parentId)) throw new TypeError("Identificativo del termine genitore non valido.");
    if (input.parentId !== undefined && input.parentId !== null && !parent) throw new TypeError("Il termine genitore non esiste.");
    if (input.parentAlias !== undefined && input.parentAlias !== null && !parent) throw new TypeError("Il termine genitore non esiste.");
    if (parent && parent.taxonomyKey !== taxonomy.key) throw new TypeError("Il termine genitore deve appartenere alla stessa tassonomia.");
    if (parent?.id === id) throw new TypeError("Un termine non può essere genitore di sé stesso.");
    let ancestor = parent?.parentId ?? null;
    while (ancestor) {
      if (ancestor === id) throw new TypeError("La gerarchia dei termini non può contenere cicli.");
      ancestor = (this.prepare("SELECT parent_id FROM cms_terms WHERE id=?").get(ancestor) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
    const definition = { taxonomyKey: taxonomy.key, slug, label: input.label.trim(), parentId: parent?.id ?? null };
    const payload = canonicalizeJson(definition as never);
    const now = new Date().toISOString();
    const revision = randomUUID();
    if (!current && input.expectedHead !== undefined && input.expectedHead !== null) return { status: "conflict", current: null, expectedHead: input.expectedHead };
    return this.transaction(() => {
      const dbCurrent = current ? this.getTermByAlias(current.alias) : null;
      if (dbCurrent && (input.expectedHead === undefined || input.expectedHead !== dbCurrent.headRevision)) return { status: "conflict", current: dbCurrent, expectedHead: input.expectedHead ?? null } as const;
      const duplicate = this.prepare("SELECT id FROM cms_terms WHERE taxonomy_id=? AND slug=? AND id<>?").get(taxonomy.id, slug, id);
      if (duplicate) throw new TypeError("Esiste già un termine con indirizzo " + slug + ".");
      if (!dbCurrent) {
        this.prepare("INSERT INTO cms_identity_registry(id,kind,created_at) VALUES(?,'term',?)").run(id, now);
        this.prepare("INSERT INTO cms_terms(id,taxonomy_id,slug,label,parent_id,head_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, taxonomy.id, slug, definition.label, parent?.id ?? null, revision, now, now);
      } else this.prepare("UPDATE cms_terms SET slug=?,label=?,parent_id=?,head_revision=?,updated_at=? WHERE id=?").run(slug, definition.label, parent?.id ?? null, revision, now, id);
      this.prepare("INSERT INTO cms_term_revisions(id,term_id,parent_id,created_at,payload_json,content_hash) VALUES(?,?,?,?,?,?)").run(revision, id, dbCurrent?.headRevision ?? null, now, payload, hash(definition));
      return { status: "saved", term: this.getTermById(id)! } as const;
    });
  }

  toHistosTaxQuery(filter: CmsRecordFilter | undefined): unknown | undefined {
    if (!filter) return undefined;
    const taxNodes: Array<{ taxonomyKey: string; termIds: string[]; operator: "IN" | "NOT IN" | "AND" }> = [];
    let relation: "AND" | "OR" = "AND";
    if ("taxonomyKey" in filter) taxNodes.push(filter);
    else if ("and" in filter || "or" in filter) {
      const children = "and" in filter ? filter.and : filter.or;
      if (!children.every((node) => "taxonomyKey" in node)) return undefined;
      relation = "or" in filter ? "OR" : "AND";
      taxNodes.push(...children as Array<Extract<CmsRecordFilter, { taxonomyKey: string }>>);
    } else return undefined;
    const clauses = taxNodes.map((node) => ({
      taxonomy: node.taxonomyKey, field: "term_id", operator: node.operator,
      terms: node.termIds.map((id) => this.getTermById(id)?.alias).filter((alias): alias is number => alias !== undefined),
    }));
    if (clauses.some((clause) => clause.terms.length === 0)) return undefined;
    return clauses.length === 1 ? clauses : { relation, ...Object.fromEntries(clauses.map((clause, index) => [String(index), clause])) };
  }

  fromHistosTaxQuery(value: unknown, typeKey?: string): CmsRecordFilter | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) && (!value || typeof value !== "object")) throw new TypeError("La tax_query deve essere un elenco di condizioni Histeon.");
    const source = value as unknown[] | Record<string, unknown>;
    if (Array.isArray(source) && source.length === 0) return undefined;
    const relation = !Array.isArray(source) && source.relation === "OR" ? "OR" : "AND";
    const entries = Array.isArray(source) ? source : Object.entries(source).filter(([key]) => key !== "relation").sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, item]) => item);
    if (!entries.length || entries.length > 32) throw new TypeError("La tax_query deve contenere da 1 a 32 condizioni.");
    const filters = entries.map((raw): CmsRecordFilter => {
      const clause = jsonObject(raw, "La condizione tax_query");
      if (typeof clause.taxonomy !== "string") throw new TypeError("Ogni condizione tax_query deve indicare una tassonomia.");
      if (clause.field !== undefined && clause.field !== "term_id") throw new TypeError("Sono supportati solo i filtri tax_query basati sull’ID del termine.");
      const taxonomy = this.getTaxonomy(clause.taxonomy);
      if (!taxonomy) throw new TypeError(`La tassonomia Histeon ${clause.taxonomy} non esiste.`);
      if (typeKey && !taxonomy.types.includes(typeKey)) throw new TypeError(`La tassonomia ${taxonomy.key} non è collegata al tipo ${typeKey}.`);
      const rawTerms = Array.isArray(clause.terms) ? clause.terms : [clause.terms];
      if (rawTerms.length < 1 || rawTerms.length > 100) throw new TypeError("Una condizione tax_query deve indicare da 1 a 100 termini.");
      const termIds = rawTerms.map((rawTerm) => {
        const alias = typeof rawTerm === "number" ? rawTerm : typeof rawTerm === "string" && /^\d+$/u.test(rawTerm) ? Number(rawTerm) : NaN;
        const term = Number.isSafeInteger(alias) ? this.getTermByAlias(alias) : null;
        if (!term || term.taxonomyKey !== taxonomy.key) throw new TypeError(`La tax_query contiene un termine che non appartiene a ${taxonomy.key}.`);
        return term.id;
      });
      const operator = clause.operator === "AND" || clause.operator === "NOT IN" ? clause.operator : "IN";
      return { taxonomyKey: taxonomy.key, termIds, operator };
    });
    return filters.length === 1 ? filters[0]! : relation === "OR" ? { or: filters } : { and: filters };
  }

  private termFromRow(row: TermRow): CmsTerm {
    const parent = row.parent_id ? this.prepare("SELECT alias FROM cms_terms WHERE id=?").get(row.parent_id) as { alias: number } | undefined : undefined;
    const count = Number((this.prepare("SELECT COUNT(*) AS n FROM cms_record_terms WHERE term_id=?").get(row.id) as { n: number }).n);
    return { id: row.id, alias: row.alias, taxonomyKey: row.taxonomy_key, slug: row.slug, label: row.label, parentId: row.parent_id, parentAlias: parent?.alias ?? null, count, headRevision: row.head_revision, updatedAt: row.updated_at };
  }

  private taxonomyFromRow(row: TaxonomyRow): CmsTaxonomy {
    const types = (this.prepare("SELECT t.key FROM cms_taxonomy_types x JOIN cms_content_types t ON t.id=x.type_id WHERE x.taxonomy_id=? ORDER BY t.key").all(row.id) as Array<{ key: string }>).map((item) => item.key);
    if (row.for_posts === 1) { types.push(POST_TYPE_KEY); types.sort(); }
    return { id: row.id, key: row.key, label: row.label, types, headRevision: row.head_revision, updatedAt: row.updated_at };
  }

  listQueryPresets(): { presets: CmsQueryPreset[]; head: string } {
    const state = this.prepare("SELECT head_revision FROM cms_query_state WHERE id=1").get() as { head_revision: string } | undefined;
    const rows = this.prepare("SELECT p.*, COALESCE(t.key, p.builtin_type) AS type_key FROM cms_query_presets p LEFT JOIN cms_content_types t ON t.id=p.type_id WHERE t.id IS NOT NULL OR p.builtin_type IS NOT NULL ORDER BY p.key").all() as unknown as Array<QueryPresetRow & { type_key: string }>;
    return { presets: rows.map((row) => ({ key: row.key, label: row.label, typeKey: row.type_key, limit: row.limit_no, ...(row.limit_param ? { limitParam: row.limit_param } : {}), offset: row.offset_no ?? 0, ...(row.offset_param ? { offsetParam: row.offset_param } : {}), orderBy: row.order_by, order: row.direction, ...(row.filter_json ? { filter: JSON.parse(row.filter_json) as CmsRecordFilter } : {}), headRevision: row.head_revision, updatedAt: row.updated_at })), head: state?.head_revision ?? "" };
  }

  listQuerySources(): Record<string, { type: "json"; data: unknown }> {
    const rows = this.prepare("SELECT name, data_json FROM cms_query_sources ORDER BY name").all() as Array<{ name: string; data_json: string }>;
    const result = Object.create(null) as Record<string, { type: "json"; data: unknown }>;
    for (const row of rows) result[row.name] = { type: "json", data: JSON.parse(row.data_json) as unknown };
    return result;
  }

  saveQuerySources(value: unknown): { head: string } {
    const sources = jsonObject(value, "Le sorgenti dati");
    if (Object.keys(sources).length > 128) throw new RangeError("Un progetto può avere al massimo 128 sorgenti dati.");
    for (const [name, raw] of Object.entries(sources)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) || ["posts", "terms", "main", "users"].includes(name) || this.listQueryPresets().presets.some((preset) => preset.key === name)) throw new TypeError(`Nome sorgente non valido, riservato o già usato da una query: ${name}.`);
      const definition = jsonObject(raw, `La sorgente ${name}`);
      if (definition.type !== "json" || !Object.hasOwn(definition, "data") || !validJson(definition.data)) throw new TypeError(`La sorgente ${name} deve contenere JSON valido.`);
      if (Buffer.byteLength(canonicalizeJson(definition.data as never), "utf8") > 1024 * 1024) throw new RangeError(`La sorgente ${name} supera 1 MiB.`);
    }
    return this.transaction(() => {
      const nextJson = canonicalizeJson(sources as never);
      const previous = this.listQuerySources();
      if (nextJson !== canonicalizeJson(previous as never)) {
        const now = new Date().toISOString();
        this.prepare("DELETE FROM cms_query_sources").run();
        const insert = this.prepare("INSERT INTO cms_query_sources(name,data_json,updated_at) VALUES(?,?,?)");
        for (const [name, raw] of Object.entries(sources)) insert.run(name, canonicalizeJson((raw as Record<string, unknown>).data as never), now);
        const state = this.prepare("SELECT head_revision FROM cms_query_state WHERE id=1").get() as { head_revision: string } | undefined;
        const revision = randomUUID();
        const change = { sources: sources };
        this.prepare("INSERT INTO cms_query_revisions(id,parent_id,created_at,payload_json,content_hash) VALUES(?,?,?,?,?)").run(revision, state?.head_revision ?? null, now, canonicalizeJson(change as never), hash(change));
        this.prepare("INSERT INTO cms_query_state(id,head_revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET head_revision=excluded.head_revision").run(revision);
      }
      return { head: this.listQueryPresets().head };
    });
  }

  saveQueryPreset(input: { key: string; label: string; typeKey: string; limit?: number; limitParam?: string | null; offset?: number; offsetParam?: string | null; orderBy?: string; order?: "asc" | "desc"; filter?: unknown; expectedHead: string | null }): CmsQueryPresetSaveResult {
    if (typeof input.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(input.key) || ["posts", "terms", "main", "users"].includes(input.key)) throw new TypeError("Il nome della query non è valido o è riservato da Histeon.");
    if (typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 120) throw new TypeError("Il nome della query è obbligatorio e non può superare 120 caratteri.");
    const forPosts = input.typeKey === POST_TYPE_KEY;
    const contentType = forPosts ? null : this.getType(input.typeKey);
    if (!forPosts && !contentType) throw new TypeError(`Tipo di contenuto non trovato: ${input.typeKey}.`);
    const type = { key: forPosts ? POST_TYPE_KEY : contentType!.key, id: contentType?.id ?? null };
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS_PER_QUERY) throw new RangeError("La query può mostrare da 1 a 100 voci.");
    const limitParam = input.limitParam ?? null;
    if (limitParam !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(limitParam)) throw new TypeError("Il parametro dinamico del limite query non è valido.");
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError("L’offset della query deve essere compreso tra 0 e 1.000.000.");
    const offsetParam = input.offsetParam ?? null;
    if (offsetParam !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(offsetParam)) throw new TypeError("Il parametro dinamico dell’offset query non è valido.");
    const orderBy = input.orderBy ?? "order";
    const order = input.order ?? "asc";
    if (order !== "asc" && order !== "desc") throw new TypeError("Ordinamento della query non valido.");
    const filter = input.filter === undefined || input.filter === null ? undefined : input.filter;
    if (filter !== undefined && !validJson(filter)) throw new TypeError("Il filtro della query non è JSON valido.");
    // Compile and execute the same query path used by the builder before persisting the preset.
    this.listRecords({ typeKey: type.key, status: "published", limit, orderBy, order, ...(filter === undefined ? {} : { filter: filter as CmsRecordFilter }) });
    const currentState = this.listQueryPresets();
    const existing = currentState.presets.find((item) => item.key === input.key) ?? null;
    if (existing && input.expectedHead !== existing.headRevision || !existing && input.expectedHead !== null) return { status: "conflict", current: existing, expectedHead: input.expectedHead, head: currentState.head };
    const definition = { key: input.key, label: input.label.trim(), typeKey: type.key, limit, ...(limitParam ? { limitParam } : {}), offset, ...(offsetParam ? { offsetParam } : {}), orderBy, order, ...(filter === undefined ? {} : { filter }) };
    const payload = canonicalizeJson(definition as never);
    const nextHead = randomUUID();
    const now = new Date().toISOString();
    return this.transaction(() => {
      const state = this.prepare("SELECT head_revision FROM cms_query_state WHERE id=1").get() as { head_revision: string } | undefined;
      const current = this.prepare("SELECT p.*, COALESCE(t.key, p.builtin_type) AS type_key FROM cms_query_presets p LEFT JOIN cms_content_types t ON t.id=p.type_id WHERE p.key=?").get(input.key) as unknown as (QueryPresetRow & { type_key: string }) | undefined;
      if ((current?.head_revision ?? null) !== input.expectedHead) {
        return { status: "conflict", current: current ? { key: current.key, label: current.label, typeKey: current.type_key, limit: current.limit_no, ...(current.limit_param ? { limitParam: current.limit_param } : {}), offset: current.offset_no ?? 0, ...(current.offset_param ? { offsetParam: current.offset_param } : {}), orderBy: current.order_by, order: current.direction, ...(current.filter_json ? { filter: JSON.parse(current.filter_json) as CmsRecordFilter } : {}), headRevision: current.head_revision, updatedAt: current.updated_at } : null, expectedHead: input.expectedHead, head: state?.head_revision ?? "" } as const;
      }
      this.prepare("INSERT INTO cms_query_revisions(id,parent_id,created_at,payload_json,content_hash) VALUES(?,?,?,?,?)").run(nextHead, state?.head_revision ?? null, now, payload, hash(definition));
      if (current) this.prepare("UPDATE cms_query_presets SET label=?, type_id=?, builtin_type=?, limit_no=?, limit_param=?, offset_no=?, offset_param=?, order_by=?, direction=?, filter_json=?, head_revision=?, updated_at=? WHERE key=?").run(definition.label, type.id, forPosts ? POST_TYPE_KEY : null, limit, limitParam, offset, offsetParam, orderBy, order, filter === undefined ? null : JSON.stringify(filter), nextHead, now, input.key);
      else this.prepare("INSERT INTO cms_query_presets(key,label,type_id,builtin_type,limit_no,limit_param,offset_no,offset_param,order_by,direction,filter_json,head_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.key, definition.label, type.id, forPosts ? POST_TYPE_KEY : null, limit, limitParam, offset, offsetParam, orderBy, order, filter === undefined ? null : JSON.stringify(filter), nextHead, now);
      this.prepare("INSERT INTO cms_query_state(id,head_revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET head_revision=excluded.head_revision").run(nextHead);
      const saved = this.listQueryPresets().presets.find((item) => item.key === input.key)!;
      return { status: "saved", preset: saved, head: nextHead } as const;
    });
  }

  saveQueryPresets(input: { presets: unknown; sources?: unknown; expectedHead: string }): CmsQueriesSaveResult {
    const current = this.listQueryPresets();
    if (typeof input.expectedHead !== "string") throw new TypeError("La revisione delle query è obbligatoria.");
    if (input.expectedHead !== current.head) return { status: "conflict", presets: current.presets, expectedHead: input.expectedHead, head: current.head };
    const source = jsonObject(input.presets, "Le query");
    if (Object.keys(source).length > 128) throw new RangeError("Un progetto può avere al massimo 128 query personalizzate.");
    const sources = input.sources === undefined ? undefined : jsonObject(input.sources, "Le sorgenti dati");
    if (sources && Object.keys(sources).length > 128) throw new RangeError("Un progetto può avere al massimo 128 sorgenti dati.");
    const planned = Object.entries(source).map(([key, raw]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || ["posts", "terms", "main", "users"].includes(key)) throw new TypeError(`Nome query non valido o riservato: ${key}.`);
      if (sources && Object.hasOwn(sources, key)) throw new TypeError(`Il nome ${key} è già usato da una sorgente dati.`);
      const preset = jsonObject(raw, `La query ${key}`);
      if (preset.type !== "posts") throw new TypeError(`La query ${key} deve usare il tipo posts compatibile con i loop Histeon.`);
      const args = jsonObject(preset.args, `I parametri della query ${key}`);
      const allowedArgs = new Set(["post_type", "posts_per_page", "number", "offset", "page", "paged", "orderby", "order", "xb_type_key", "xb_limit", "xb_order_by", "xb_label", "xb_filter", "tax_query"]);
      for (const name of Object.keys(args)) if (!allowedArgs.has(name)) throw new TypeError(`Il parametro ${name} della query ${key} non è ancora supportato dal CMS relazionale.`);
      const typeKey = typeof args.xb_type_key === "string" ? args.xb_type_key : args.post_type;
      if (typeof typeKey !== "string" || typeKey !== POST_TYPE_KEY && !this.getType(typeKey)) throw new TypeError(`La query ${key} deve selezionare un tipo Histeon esistente in post_type.`);
      const rawLimit = args.xb_limit ?? args.posts_per_page ?? args.number ?? 10;
      let limitParam: string | undefined;
      let limit: number;
      if (typeof rawLimit === "number") limit = rawLimit === -1 ? MAX_RECORDS_PER_QUERY : rawLimit;
      else if (typeof rawLimit === "string" && /^-?\d{1,3}$/u.test(rawLimit)) limit = Number(rawLimit) === -1 ? MAX_RECORDS_PER_QUERY : Number(rawLimit);
      else if (typeof rawLimit === "string") {
        const dynamic = /^\$([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s*\?\?\s*(\d{1,3}))?$/u.exec(rawLimit.trim());
        if (!dynamic) throw new TypeError(`Il limite della query ${key} deve essere un numero oppure un parametro come "$count ?? 6".`);
        // `$limit` is the loop's own argument, which every query takes: not a parameter of this one.
        if (dynamic[1] !== "limit") limitParam = dynamic[1];
        limit = dynamic[2] ? Number(dynamic[2]) : 10;
      } else throw new TypeError(`Il limite della query ${key} non è valido.`);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS_PER_QUERY) throw new RangeError(`La query ${key} deve mostrare da 1 a ${MAX_RECORDS_PER_QUERY} record; -1 indica il massimo sicuro di ${MAX_RECORDS_PER_QUERY}.`);
      let offset = 0;
      let offsetParam: string | undefined;
      const rawOffset = args.offset;
      if (rawOffset !== undefined) {
        if (typeof rawOffset === "number" || typeof rawOffset === "string" && /^\d{1,7}$/u.test(rawOffset.trim())) offset = Number(rawOffset);
        else if (typeof rawOffset === "string") {
          const dynamic = /^\$([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s*\?\?\s*(\d{1,7}))?$/u.exec(rawOffset.trim());
          if (!dynamic) throw new TypeError(`L’offset della query ${key} deve essere un numero oppure un parametro come "$offset ?? 0".`);
          // The same for `$offset`, the loop's own argument.
          if (dynamic[1] !== "offset") offsetParam = dynamic[1];
          offset = dynamic[2] ? Number(dynamic[2]) : 0;
        } else throw new TypeError(`L’offset della query ${key} non è valido.`);
      } else if (args.page !== undefined || args.paged !== undefined) {
        const page = Number(args.page ?? args.paged);
        if (!Number.isSafeInteger(page) || page < 1) throw new RangeError(`La pagina della query ${key} deve essere un intero positivo.`);
        offset = (page - 1) * limit;
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError(`L’offset della query ${key} deve essere compreso tra 0 e 1.000.000.`);
      const orderInput = typeof args.order === "string" ? args.order.toLowerCase() : "desc";
      if (orderInput !== "asc" && orderInput !== "desc") throw new TypeError(`La query ${key} contiene un ordine non valido.`);
      const orderByInput = args.xb_order_by ?? args.orderby ?? "date";
      if (orderByInput !== "date" && orderByInput !== "menu_order" && orderByInput !== "title" && orderByInput !== "publishedAt" && orderByInput !== "order") throw new TypeError(`L’ordinamento ${String(orderByInput)} della query ${key} non è supportato.`);
      const orderBy = orderByInput === "date" ? "publishedAt" : orderByInput === "menu_order" ? "order" : orderByInput;
      const filterValue = args.xb_filter;
      let filter: unknown = filterValue;
      if (typeof filterValue === "string") {
        try { filter = JSON.parse(filterValue) as unknown; }
        catch { throw new TypeError(`Il filtro della query ${key} non contiene JSON valido.`); }
      }
      if (filter !== undefined) jsonObject(filter, `Il filtro della query ${key}`);
      const taxonomyFilter = this.fromHistosTaxQuery(args.tax_query, typeKey);
      if (taxonomyFilter) filter = filter === undefined ? taxonomyFilter : { and: [filter as CmsRecordFilter, taxonomyFilter] };
      const label = typeof args.xb_label === "string" && args.xb_label.trim() ? args.xb_label.trim() : key;
      // Validate the entire batch through the exact query path before opening the write transaction.
      this.listRecords({ typeKey, status: "published", limit, offset, orderBy, order: orderInput, ...(filter === undefined ? {} : { filter: filter as CmsRecordFilter }) });
      return { key, label, typeKey, limit, ...(limitParam ? { limitParam } : {}), offset, ...(offsetParam ? { offsetParam } : {}), orderBy, order: orderInput as "asc" | "desc", ...(filter === undefined ? {} : { filter }) };
    });
    if (sources) {
      for (const [name, raw] of Object.entries(sources)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) || ["posts", "terms", "main", "users"].includes(name) || Object.hasOwn(source, name)) throw new TypeError(`Nome sorgente non valido, riservato o già usato da una query: ${name}.`);
        const definition = jsonObject(raw, `La sorgente ${name}`);
        if (definition.type !== "json" || !Object.hasOwn(definition, "data") || !validJson(definition.data)) throw new TypeError(`La sorgente ${name} deve contenere JSON valido.`);
        const serialized = canonicalizeJson(definition.data as never);
        if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new RangeError(`La sorgente ${name} supera 1 MiB.`);
      }
    }
    return this.transaction(() => {
      const latest = this.listQueryPresets();
      if (latest.head !== input.expectedHead) return { status: "conflict", presets: latest.presets, expectedHead: input.expectedHead, head: latest.head } as const;
      for (const preset of planned) {
        const existing = this.listQueryPresets().presets.find((item) => item.key === preset.key);
        const saved = this.saveQueryPreset({ ...preset, expectedHead: existing?.headRevision ?? null });
        if (saved.status !== "saved") throw new Error("La revisione della query è cambiata durante il salvataggio atomico.");
      }
      const wanted = new Set(planned.map((preset) => preset.key));
      for (const obsolete of this.listQueryPresets().presets) {
        if (wanted.has(obsolete.key)) continue;
        const state = this.prepare("SELECT head_revision FROM cms_query_state WHERE id=1").get() as { head_revision: string } | undefined;
        const revision = randomUUID();
        const now = new Date().toISOString();
        const deletion = { deleted: obsolete.key };
        this.prepare("INSERT INTO cms_query_revisions(id,parent_id,created_at,payload_json,content_hash) VALUES(?,?,?,?,?)").run(revision, state?.head_revision ?? null, now, canonicalizeJson(deletion), hash(deletion));
        this.prepare("DELETE FROM cms_query_presets WHERE key=?").run(obsolete.key);
        this.prepare("INSERT INTO cms_query_state(id,head_revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET head_revision=excluded.head_revision").run(revision);
      }
      if (sources) {
        const previousSources = this.listQuerySources();
        const nextSourceJson = canonicalizeJson(sources as never);
        const previousSourceJson = canonicalizeJson(previousSources as never);
        if (nextSourceJson !== previousSourceJson) {
          const now = new Date().toISOString();
          this.prepare("DELETE FROM cms_query_sources").run();
          const insertSource = this.prepare("INSERT INTO cms_query_sources(name,data_json,updated_at) VALUES(?,?,?)");
          for (const [name, definition] of Object.entries(sources)) insertSource.run(name, canonicalizeJson((definition as Record<string, unknown>).data as never), now);
          const state = this.prepare("SELECT head_revision FROM cms_query_state WHERE id=1").get() as { head_revision: string } | undefined;
          const revision = randomUUID();
          const sourceChange = { sources: JSON.parse(nextSourceJson) as unknown };
          this.prepare("INSERT INTO cms_query_revisions(id,parent_id,created_at,payload_json,content_hash) VALUES(?,?,?,?,?)").run(revision, state?.head_revision ?? null, now, canonicalizeJson(sourceChange), hash(sourceChange));
          this.prepare("INSERT INTO cms_query_state(id,head_revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET head_revision=excluded.head_revision").run(revision);
        }
      }
      const result = this.listQueryPresets();
      return { status: "saved", presets: result.presets, head: result.head } as const;
    });
  }

  /**
   * The published records of a saved query. locale is the page's language, which the query lists; without one it is the
   * project's (projectLocale), the language a record saved without one is written in. A URL has the prefix of its
   * language against the project's, so a page in English lists /en/… addresses (doc 20 §2.2).
   */
  resolveQueryPreset(key: string, args: Record<string, unknown> = {}, locale: string = this.projectLocale()): Array<CmsRecord & { url: string }> {
    const preset = this.listQueryPresets().presets.find((item) => item.key === key);
    if (!preset) return [];
    const allowed = new Set(["limit", "posts_per_page", "count", "locale", "offset", "page", "paged", ...(preset.limitParam ? [preset.limitParam] : []), ...(preset.offsetParam ? [preset.offsetParam] : [])]);
    for (const name of Object.keys(args)) if (!allowed.has(name)) throw new TypeError(`Il parametro ${name} non è supportato dalla query ${key}.`);
    const rawLimit = (preset.limitParam ? args[preset.limitParam] : undefined) ?? args.limit ?? args.posts_per_page ?? args.count ?? preset.limit;
    const limitValue = rawLimit === -1 || rawLimit === "-1" ? MAX_RECORDS_PER_QUERY : typeof rawLimit === "string" && /^\d{1,3}$/u.test(rawLimit.trim()) ? Number(rawLimit) : rawLimit;
    if (!Number.isSafeInteger(limitValue) || (limitValue as number) < 1 || (limitValue as number) > MAX_RECORDS_PER_QUERY) throw new RangeError(`La query ${key} deve mostrare da 1 a ${MAX_RECORDS_PER_QUERY} record; -1 indica il massimo sicuro.`);
    const offsetOverride = args.offset ?? (preset.offsetParam ? args[preset.offsetParam] : undefined);
    let offset = preset.offset;
    if (offsetOverride !== undefined) {
      offset = typeof offsetOverride === "string" && /^\d{1,7}$/u.test(offsetOverride.trim()) ? Number(offsetOverride) : offsetOverride as number;
    } else if (args.page !== undefined || args.paged !== undefined) {
      const pageValue = args.page ?? args.paged;
      const page = typeof pageValue === "string" && /^\d{1,7}$/u.test(pageValue.trim()) ? Number(pageValue) : pageValue;
      if (!Number.isSafeInteger(page) || (page as number) < 1) throw new RangeError(`La pagina della query ${key} deve essere un intero positivo.`);
      offset = ((page as number) - 1) * (limitValue as number);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError(`L’offset della query ${key} deve essere compreso tra 0 e 1.000.000.`);
    const queryLocale = args.locale === undefined ? locale : args.locale;
    if (typeof queryLocale !== "string") throw new TypeError(`La lingua della query ${key} non è valida.`);
    // A page in another language lists the records of the site until they have their version: an empty list is worse.
    const fallback = args.locale === undefined ? { fallbackLocale: this.projectLocale() } : {};
    const result = this.listRecords({ typeKey: preset.typeKey, locale: queryLocale, ...fallback, status: "published", limit: limitValue as number, offset, orderBy: preset.orderBy, order: preset.order, ...(preset.filter ? { filter: preset.filter } : {}) }, CMS_MAX_RELATION_DEPTH);
    // A type without pages of its own (doc 23 item 122) gives its records no address: a link to them would be a 404.
    const addressed = preset.typeKey === POST_TYPE_KEY || this.getType(preset.typeKey)?.public !== false;
    return result.items.map((item) => ({ ...item, url: addressed ? contentUrl(preset.typeKey, item.slug, item.locale, this.projectLocale()) : "" }));
  }

  previewQueryDefinition(value: unknown, params: Record<string, unknown> = {}, locale: string = this.projectLocale()): Array<CmsRecord & { url: string }> {
    const preset = jsonObject(value, "La query da provare");
    if (preset.type !== "posts") throw new TypeError("Per ora il CMS supporta le anteprime delle query Histeon di tipo posts.");
    const args = jsonObject(preset.args, "I parametri della query");
    const allowed = new Set(["post_type", "posts_per_page", "number", "offset", "page", "paged", "orderby", "order", "xb_type_key", "xb_limit", "xb_order_by", "xb_label", "xb_filter", "tax_query"]);
    for (const key of Object.keys(args)) if (!allowed.has(key)) throw new TypeError(`Il parametro ${key} non è supportato dal CMS relazionale.`);
    const typeKey = typeof args.xb_type_key === "string" ? args.xb_type_key : args.post_type;
    if (typeof typeKey !== "string" || typeKey !== POST_TYPE_KEY && !this.getType(typeKey)) throw new TypeError("Scegli un tipo di contenuto Histeon prima di provare la query.");
    const rawLimit = args.xb_limit ?? args.posts_per_page ?? args.number ?? 10;
    let limit = 10;
    let parameter: string | undefined;
    if (typeof rawLimit === "number") limit = rawLimit === -1 ? MAX_RECORDS_PER_QUERY : rawLimit;
    else if (typeof rawLimit === "string" && /^-?\d{1,3}$/u.test(rawLimit.trim())) limit = Number(rawLimit) === -1 ? MAX_RECORDS_PER_QUERY : Number(rawLimit);
    else if (typeof rawLimit === "string") {
      const dynamic = /^\$([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s*\?\?\s*(\d{1,3}))?$/u.exec(rawLimit.trim());
      if (!dynamic) throw new TypeError("Il limite deve essere un numero o un parametro come \"$count ?? 6\".");
      parameter = dynamic[1] ?? undefined;
      if (!parameter) throw new TypeError("Il nome del parametro limite non è valido.");
      limit = dynamic[2] ? Number(dynamic[2]) : 10;
      if (params[parameter] !== undefined) limit = typeof params[parameter] === "number" ? params[parameter] as number : Number(params[parameter]);
    } else throw new TypeError("Il limite della query non è valido.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS_PER_QUERY) throw new RangeError(`La query deve mostrare da 1 a ${MAX_RECORDS_PER_QUERY} record; -1 indica il massimo sicuro.`);
    let offset = 0;
    const rawOffset = args.offset;
    if (rawOffset !== undefined) {
      const resolved = typeof rawOffset === "string" && /^\$([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s*\?\?\s*(\d{1,7}))?$/u.exec(rawOffset.trim());
      if (resolved) {
        const name = resolved[1]!;
        const fallback = resolved[2] ? Number(resolved[2]) : 0;
        const value = params[name] ?? fallback;
        offset = typeof value === "string" && /^\d{1,7}$/u.test(value.trim()) ? Number(value) : value as number;
      } else offset = typeof rawOffset === "string" && /^\d{1,7}$/u.test(rawOffset.trim()) ? Number(rawOffset) : rawOffset as number;
    } else if (args.page !== undefined || args.paged !== undefined) {
      const rawPage = args.page ?? args.paged;
      const resolved = typeof rawPage === "string" && /^\$([A-Za-z_][A-Za-z0-9_]{0,63})(?:\s*\?\?\s*(\d{1,7}))?$/u.exec(rawPage.trim());
      const pageValue = resolved ? params[resolved[1]!] ?? (resolved[2] ? Number(resolved[2]) : 1) : rawPage;
      const page = typeof pageValue === "string" && /^\d{1,7}$/u.test(pageValue.trim()) ? Number(pageValue) : pageValue as number;
      if (!Number.isSafeInteger(page) || page < 1) throw new RangeError("La pagina della query deve essere un intero positivo.");
      offset = (page - 1) * limit;
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError("L’offset della query deve essere compreso tra 0 e 1.000.000.");
    const orderValue = typeof args.order === "string" ? args.order.toLowerCase() : "desc";
    if (orderValue !== "asc" && orderValue !== "desc") throw new TypeError("L’ordine della query non è valido.");
    const orderByValue = args.xb_order_by ?? args.orderby ?? "date";
    if (orderByValue !== "date" && orderByValue !== "menu_order" && orderByValue !== "title" && orderByValue !== "publishedAt" && orderByValue !== "order") throw new TypeError(`L’ordinamento ${String(orderByValue)} non è supportato.`);
    let filter: unknown = args.xb_filter;
    if (typeof filter === "string") {
      try { filter = JSON.parse(filter) as unknown; }
      catch { throw new TypeError("Il filtro query non contiene JSON valido."); }
    }
    if (filter !== undefined) jsonObject(filter, "Il filtro query");
    const taxonomyFilter = this.fromHistosTaxQuery(args.tax_query, typeKey);
    if (taxonomyFilter) filter = filter === undefined ? taxonomyFilter : { and: [filter as CmsRecordFilter, taxonomyFilter] };
    const orderBy = orderByValue === "date" ? "publishedAt" : orderByValue === "menu_order" ? "order" : orderByValue;
    const queryLocale = typeof params.locale === "string" ? params.locale : locale;
    const fallback = typeof params.locale === "string" ? {} : { fallbackLocale: this.projectLocale() };
    const result = this.listRecords({ typeKey, locale: queryLocale, ...fallback, status: "published", limit, offset, orderBy, order: orderValue, ...(filter === undefined ? {} : { filter: filter as CmsRecordFilter }) }, CMS_MAX_RELATION_DEPTH);
    const addressed = typeKey === POST_TYPE_KEY || this.getType(typeKey)?.public !== false;
    return result.items.map((item) => ({ ...item, url: addressed ? contentUrl(typeKey, item.slug, item.locale, this.projectLocale()) : "" }));
  }

  saveType(input: { id?: string; key: string; label: string; fields: unknown; singleTemplateRef?: string | null; archiveTemplateRef?: string | null; public?: boolean; expectedHead?: string | null }): CmsTypeSaveResult {
    if (typeof input.key !== "string" || !KEY.test(input.key)) throw new TypeError("La chiave del tipo deve iniziare con una lettera e usare solo lettere minuscole, numeri, trattini o underscore.");
    if (RESERVED_TYPE_KEYS.has(input.key) || POST_TAXONOMY_KEYS.has(input.key) || (PRODUCT_TAXONOMIES as readonly string[]).includes(input.key)) throw new TypeError(`La chiave ${input.key} è riservata a un tipo predefinito.`);
    if (typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 120) throw new TypeError("Il nome del tipo è obbligatorio e non può superare 120 caratteri.");
    const fields = normalizeFields(input.fields);
    // The shop's products (queue C6): their fields are WooCommerce's, the same in every project.
    if (input.key === PRODUCT_TYPE_KEY && !isProductFields(fields)) throw new TypeError("Il tipo product è il catalogo del negozio: i suoi campi sono fissi (regular_price, sale_price, sku, stock_status, image, gallery).");
    const id = input.id ?? randomUUID();
    if (!UUID.test(id)) throw new TypeError("Identificativo del tipo non valido.");
    const existing = this.getType(id);
    const singleTemplateRef = normalizeTemplateRef(input.singleTemplateRef, existing?.singleTemplateRef ?? null, "singolo");
    const archiveTemplateRef = normalizeTemplateRef(input.archiveTemplateRef, existing?.archiveTemplateRef ?? null, "archivio");
    if (existing && existing.key !== input.key) throw new TypeError("La chiave tecnica di un tipo esistente non può essere cambiata.");
    if (!existing && input.expectedHead !== undefined && input.expectedHead !== null) return { status: "conflict", current: null, expectedHead: input.expectedHead };
    const updatedAt = new Date().toISOString();
    const isPublic = input.public === undefined ? (existing?.public ?? true) : input.public !== false;
    // Written only when off, so the fingerprints of the types saved before item 122 stay the same.
    const definition = { key: input.key, label: input.label.trim(), fields, singleTemplateRef: isPublic ? singleTemplateRef : null, archiveTemplateRef: isPublic ? archiveTemplateRef : null, ...(isPublic ? {} : { public: false }) };
    const contentHash = hash(definition);
    return this.transaction(() => {
      const current = this.getType(id);
      if (current && (input.expectedHead === undefined || input.expectedHead !== current.headRevision)) {
        this.prepare("INSERT INTO cms_content_conflicts(id, entity_id, entity_kind, expected_head, actual_head, proposed_json, created_at) VALUES (?, ?, 'content-type', ?, ?, ?, ?)")
          .run(randomUUID(), id, input.expectedHead ?? null, current.headRevision, canonicalizeJson(definition as never), updatedAt);
        return { status: "conflict", current, expectedHead: input.expectedHead ?? null } as const;
      }
      const duplicate = this.prepare("SELECT id FROM cms_content_types WHERE key = ? AND id <> ?").get(input.key, id);
      if (duplicate) throw new TypeError(`Esiste già il tipo ${input.key}.`);
      if (this.prepare("SELECT 1 FROM cms_taxonomies WHERE key=?").get(input.key)) throw new TypeError("Il nome tecnico è già usato da una tassonomia.");
      const now = updatedAt;
      const revisionId = randomUUID();
      const payload = canonicalizeJson(definition as never);
      if (!current) {
        this.prepare("INSERT INTO cms_identity_registry(id, kind, created_at) VALUES (?, 'content-type', ?)").run(id, now);
        this.prepare("INSERT INTO cms_content_types(id, key, label, single_template_ref, archive_template_ref, is_public, head_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.key, definition.label, definition.singleTemplateRef, definition.archiveTemplateRef, isPublic ? 1 : 0, revisionId, now, now);
      } else {
        const removed = current.fields.filter((before) => !fields.some((after) => after.key === before.key));
        for (const field of removed) if (this.prepare("SELECT 1 FROM cms_field_values WHERE field_id = ? LIMIT 1").get(this.fieldId(id, field.key)) || this.prepare("SELECT 1 FROM cms_record_relations WHERE field_id = ? LIMIT 1").get(this.fieldId(id, field.key))) throw new TypeError(`Il campo ${field.key} contiene dati e non può essere rimosso.`);
        this.prepare("UPDATE cms_content_types SET label = ?, single_template_ref = ?, archive_template_ref = ?, is_public = ?, head_revision = ?, updated_at = ? WHERE id = ?").run(definition.label, definition.singleTemplateRef, definition.archiveTemplateRef, isPublic ? 1 : 0, revisionId, now, id);
        const currentFields = new Map(current.fields.map((field) => [field.key, field]));
        for (const field of fields) {
          const before = currentFields.get(field.key);
          if (!before) continue;
          const fieldId = this.fieldId(id, field.key);
          const hasData = this.prepare("SELECT 1 FROM cms_field_values WHERE field_id = ? LIMIT 1").get(fieldId) || this.prepare("SELECT 1 FROM cms_record_relations WHERE field_id = ? LIMIT 1").get(fieldId);
          if (!hasData) continue;
          if (before.type !== field.type) throw new TypeError(`Il campo ${field.key} contiene dati e non può cambiare tipo.`);
          if (before.multiple !== field.multiple) throw new TypeError(`Il campo ${field.key} contiene dati e non può cambiare configurazione multiple.`);
          if (before.targetType !== field.targetType) throw new TypeError(`Il campo relazione ${field.key} contiene dati e non può cambiare tipo di destinazione.`);
          if (before.type === "enum" && field.type === "enum") {
            const used = this.prepare("SELECT DISTINCT text_value AS value FROM cms_field_values WHERE field_id=?").all(fieldId) as Array<{ value: string | null }>;
            if (used.some((item) => item.value !== null && !field.options?.includes(item.value))) throw new TypeError(`Il campo ${field.key} contiene valori che mancano nelle nuove opzioni.`);
          }
        }
        this.prepare("DELETE FROM cms_field_defs WHERE type_id = ? AND key NOT IN (SELECT value FROM json_each(?))").run(id, JSON.stringify(fields.map((field) => field.key)));
      }
      this.prepare("INSERT INTO cms_type_revisions(id, type_id, parent_id, created_at, payload_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)").run(revisionId, id, current?.headRevision ?? null, now, payload, contentHash);
      const insertField = this.prepare("INSERT INTO cms_field_defs(id, type_id, key, label, field_type, required, is_public, multiple, config_json, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(type_id,key) DO UPDATE SET label=excluded.label, field_type=excluded.field_type, required=excluded.required, is_public=excluded.is_public, multiple=excluded.multiple, config_json=excluded.config_json, ordinal=excluded.ordinal");
      for (const [ordinal, field] of fields.entries()) {
        insertField.run(randomUUID(), id, field.key, field.label, field.type, field.required ? 1 : 0, field.public ? 1 : 0, field.multiple ? 1 : 0, JSON.stringify({ ...(field.options ? { options: field.options } : {}), ...(field.targetType ? { targetType: field.targetType } : {}) }), ordinal);
      }
      return { status: "saved", contentType: this.getType(id)! } as const;
    });
  }

  createRecord(input: { typeKey: string; title: string; slug?: string; locale?: string; status?: CmsRecordStatus; publishedAt?: string | null; excerpt?: string; order?: number; values?: unknown; terms?: unknown }): CmsRecordSaveResult {
    return this.saveRecord({ ...input, expectedHead: null });
  }

  /**
   * The project's language, what a new record is written in when no locale is given: the store's render settings
   * (project-repository.ts, getRenderSettings), which this database holds in project_meta, and without them the
   * computer's language, as the store reads it then; it-IT only when neither is a valid tag. The prototype import, the
   * records API and the transfer give a record's locale themselves; this is the default for any other writer, so a
   * record saved without one is never in another language than the site (and its archive in the site's own), and for
   * a query resolved without a page language (resolveQueryPreset, previewQueryDefinition), so the two always agree.
   * The computer's language is read once per process, like the store's (building an Intl formatter is slow).
   */
  private projectLocale(): string {
    let stored: unknown;
    try {
      stored = (this.prepare("SELECT value FROM project_meta WHERE key = 'render.locale'").get() as { value?: unknown } | undefined)?.value;
    } catch {
      // A database without the store's tables (a bare content model): no project language.
    }
    systemLocale ??= new Intl.DateTimeFormat().resolvedOptions().locale || "";
    for (const candidate of [stored, systemLocale]) {
      if (typeof candidate !== "string" || !candidate) continue;
      try {
        const locale = Intl.getCanonicalLocales(candidate)[0];
        if (locale) return locale;
      } catch {
        // Not a tag: the next one.
      }
    }
    return "it-IT";
  }

  saveRecord(input: { id?: string; typeKey: string; title: string; slug?: string; locale?: string; status?: CmsRecordStatus; publishedAt?: string | null; excerpt?: string; order?: number; values?: unknown; terms?: unknown; expectedHead?: string | null }): CmsRecordSaveResult {
    const type = this.getType(input.typeKey);
    if (!type) throw new TypeError(`Tipo di contenuto non trovato: ${input.typeKey}.`);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 240) throw new TypeError("Il titolo della voce è obbligatorio e non può superare 240 caratteri.");
    const slug = slugify(input.slug?.trim() || title);
    const status = input.status ?? "draft";
    if (!new Set(["draft", "published", "archived"]).has(status)) throw new TypeError("Stato della voce non valido.");
    const excerpt = input.excerpt ?? "";
    if (typeof excerpt !== "string" || excerpt.length > 20_000) throw new TypeError("Il sommario supera 20.000 caratteri.");
    const order = input.order ?? 0;
    if (!Number.isSafeInteger(order)) throw new TypeError("L’ordine della voce deve essere un intero sicuro.");
    const values = jsonObject(input.values ?? {}, "I valori della voce");
    if (!validJson(values)) throw new TypeError("I valori della voce non sono JSON sicuri.");
    for (const name of Object.keys(values)) if (!type.fields.some((field) => field.key === name)) throw new TypeError(`Il tipo ${type.key} non dichiara il campo ${name}.`);
    for (const field of type.fields) {
      const value = values[field.key];
      if (field.required && (!Object.hasOwn(values, field.key) || value === null || value === "" || Array.isArray(value) && value.length === 0)) throw new TypeError(`Il campo obbligatorio ${field.label} è mancante.`);
    }
    if (type.key === PRODUCT_TYPE_KEY) {
      const issues = productValueIssues({ title, excerpt: input.excerpt ?? "", values });
      if (issues.length) throw new TypeError(`Prodotto «${title}»: ${issues.join(" ")}`);
    }
    const id = input.id ?? randomUUID();
    if (!UUID.test(id)) throw new TypeError("Identificativo della voce non valido.");
    const existingRow = this.prepare("SELECT * FROM cms_records WHERE id = ?").get(id) as unknown as RecordRow | undefined;
    if (existingRow && this.isRecordDeleted(id)) throw new TypeError("La voce è stata eliminata da una sincronizzazione. Ripristinala prima di modificarla.");
    const current = existingRow ? this.getRecordById(id, true) : null;
    if (existingRow && existingRow.type_id !== type.id) throw new TypeError("Il tipo di una voce esistente non può essere cambiato.");
    // A record keeps its language when it is saved again without one; a new one takes the project's.
    const locale = input.locale ?? current?.locale ?? this.projectLocale();
    let canonicalLocale: string;
    try { canonicalLocale = Intl.getCanonicalLocales(locale)[0] ?? ""; if (!canonicalLocale) throw new Error(); } catch { throw new TypeError("La lingua della voce deve essere un tag BCP 47 valido."); }
    const now = new Date().toISOString();
    const termAssignments = this.normalizeRecordTerms(input.terms, current, type.key);
    const publishedAt = status === "published" ? (input.publishedAt ?? current?.publishedAt ?? now) : null;
    if (publishedAt !== null && !isValidDateTime(publishedAt)) throw new TypeError("La data di pubblicazione deve essere una data ISO con fuso esplicito.");
    const definition = { id, typeId: type.id, typeKey: type.key, slug, locale: canonicalLocale, title, status, publishedAt, excerpt, order, values, terms: termAssignments };
    const payloadJson = canonicalizeJson(definition as never);
    const revisionHash = hash(definition);
    const revisionId = randomUUID();
    return this.transaction(() => {
      const dbCurrent = this.prepare("SELECT * FROM cms_records WHERE id = ?").get(id) as unknown as RecordRow | undefined;
      if (dbCurrent && (input.expectedHead === undefined || input.expectedHead !== dbCurrent.head_revision)) {
        this.prepare("INSERT INTO cms_content_conflicts(id, entity_id, entity_kind, expected_head, actual_head, proposed_json, created_at) VALUES (?, ?, 'record', ?, ?, ?, ?)")
          .run(randomUUID(), id, input.expectedHead ?? null, dbCurrent.head_revision, payloadJson, now);
        return { status: "conflict", current: this.getRecordById(id, true), expectedHead: input.expectedHead ?? null } as const;
      }
      const duplicate = this.prepare("SELECT id FROM cms_records WHERE type_id = ? AND locale = ? AND slug = ? AND id <> ?").get(type.id, canonicalLocale, slug, id);
      if (duplicate) throw new TypeError(`Esiste già un record ${type.label} con slug ${slug} nella lingua ${locale}.`);
      const sku = type.key === PRODUCT_TYPE_KEY ? productSku(values) : null;
      // WooCommerce keeps one product per SKU, in every language.
      if (sku !== null && this.prepare("SELECT 1 FROM cms_field_values v JOIN cms_identity_registry identity ON identity.id=v.record_id AND identity.deleted_at IS NULL WHERE v.field_id = ? AND v.text_value = ? AND v.record_id <> ? LIMIT 1").get(this.fieldId(type.id, "sku"), sku, id)) throw new TypeError(`Lo SKU ${sku} è già di un altro prodotto.`);
      if (dbCurrent?.status === "published" && status !== "published") {
        const incoming = this.prepare("SELECT parent.id FROM cms_record_relations rel JOIN cms_records parent ON parent.id=rel.record_id WHERE rel.target_id=? AND parent.status='published' LIMIT 1").get(id);
        if (incoming) throw new TypeError("Una voce pubblicata è collegata a questo elemento. Rimuovi prima il collegamento o ritira la voce collegata.");
      }
      if (!dbCurrent) {
        this.prepare("INSERT INTO cms_identity_registry(id, kind, created_at) VALUES (?, 'record', ?)").run(id, now);
        this.prepare("INSERT INTO cms_records(id, type_id, slug, locale, title, status, published_at, excerpt, order_no, head_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, type.id, slug, canonicalLocale, title, status, publishedAt, excerpt, order, revisionId, now, now);
      } else {
        this.prepare("UPDATE cms_records SET slug=?, locale=?, title=?, status=?, published_at=?, excerpt=?, order_no=?, head_revision=?, updated_at=? WHERE id=?").run(slug, canonicalLocale, title, status, publishedAt, excerpt, order, revisionId, now, id);
        this.prepare("DELETE FROM cms_field_values WHERE record_id = ?").run(id);
        this.prepare("DELETE FROM cms_record_relations WHERE record_id = ?").run(id);
      }
      this.prepare("DELETE FROM cms_record_terms WHERE record_id=?").run(id);
      const insertTerm = this.prepare("INSERT INTO cms_record_terms(record_id,taxonomy_id,term_id,ordinal) VALUES(?,?,?,?)");
      for (const [ordinal, term] of termAssignments.entries()) insertTerm.run(id, term.taxonomyId, term.termId, ordinal);
      for (const field of type.fields) {
        if (!Object.hasOwn(values, field.key)) continue;
        const fieldId = this.fieldId(type.id, field.key);
        bindValue(this.prepare, id, field, fieldId, values[field.key], 0, status === "published");
      }
      this.prepare("INSERT INTO cms_record_revisions(id, record_id, parent_id, created_at, payload_json, content_hash, source) VALUES (?, ?, ?, ?, ?, ?, 'editor')").run(revisionId, id, dbCurrent?.head_revision ?? null, now, payloadJson, revisionHash);
      return { status: "saved", record: this.getRecordById(id, true)! } as const;
    });
  }

  listRecords(input: CmsRecordQuery, relationDepth = 0): CmsRecordPage {
    if (input.typeKey === POST_TYPE_KEY) return this.listPostRecords(input);
    if (!Number.isSafeInteger(relationDepth) || relationDepth < 0 || relationDepth > CMS_MAX_RELATION_DEPTH) throw new RangeError(`La profondità delle relazioni deve essere compresa tra 0 e ${CMS_MAX_RELATION_DEPTH}.`);
    const type = this.getType(input.typeKey);
    if (!type) throw new TypeError(`Tipo di contenuto non trovato: ${input.typeKey}.`);
    const limit = input.limit ?? 50; const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS_PER_QUERY || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError("Limite o offset della query fuori dai valori ammessi.");
    const params: Array<string | number | null> = [type.id];
    const clauses = ["r.type_id = ?", "EXISTS (SELECT 1 FROM cms_identity_registry identity WHERE identity.id=r.id AND identity.deleted_at IS NULL)"];
    if (input.status === undefined) clauses.push("r.status = 'published'");
    else if (input.status !== "any") { clauses.push("r.status = ?"); params.push(input.status); }
    if (input.locale) {
      let locale: string;
      try { locale = Intl.getCanonicalLocales(input.locale)[0] ?? ""; } catch { locale = ""; }
      if (!locale) throw new TypeError("La lingua della query deve essere un tag BCP 47 valido.");
      if (input.fallbackLocale && input.fallbackLocale !== locale) {
        clauses.push("(r.locale = ? OR (r.locale = ? AND NOT EXISTS (SELECT 1 FROM cms_translations link JOIN cms_records version ON version.id = link.translation_id WHERE link.source_id = r.id AND lower(link.language) = lower(?) AND version.status = 'published')))");
        params.push(locale, input.fallbackLocale, locale);
      } else { clauses.push("r.locale = ?"); params.push(locale); }
    }
    if (input.search !== undefined) {
      const search = input.search.trim();
      if (search.length > 120 || /[\0\r\n]/u.test(search)) throw new TypeError("La ricerca delle voci deve avere al massimo 120 caratteri e non contenere ritorni a capo.");
      if (search) {
        const escaped = search.replace(/[\\%_]/gu, "\\$&");
        clauses.push("(r.title LIKE ? ESCAPE '\\' OR r.slug LIKE ? ESCAPE '\\')");
        params.push(`%${escaped}%`, `%${escaped}%`);
      }
    }
    if (input.filter) clauses.push(this.compileFilter(input.filter, type, input.includePrivate === true, params, 0));
    const direction = input.order === "desc" ? "DESC" : "ASC";
    const orderBy = input.orderBy ?? "order";
    const coreOrder: Record<string, string> = { order: "r.order_no", title: "r.title COLLATE NOCASE", slug: "r.slug", publishedAt: "r.published_at", updatedAt: "r.updated_at" };
    let orderSql = coreOrder[orderBy];
    if (!orderSql) {
      const field = type.fields.find((item) => item.key === orderBy);
      if (!field || !input.includePrivate && !field.public || ["relation", "asset", "rich-text"].includes(field.type)) throw new TypeError(`Il campo ${orderBy} non può ordinare questa query.`);
      const fieldId = this.fieldId(type.id, field.key);
      orderSql = `(SELECT ${field.type === "integer" || field.type === "decimal" ? "number_value" : "text_value"} FROM cms_field_values ov WHERE ov.record_id=r.id AND ov.field_id='${fieldId.replaceAll("'", "''")}' AND ov.ordinal=0)`;
    }
    const where = clauses.join(" AND ");
    const total = Number((this.prepare(`SELECT COUNT(*) AS n FROM cms_records r WHERE ${where}`).get(...params) as { n: number }).n);
    const rows = this.prepare(`SELECT r.*, t.key AS type_key FROM cms_records r JOIN cms_content_types t ON t.id=r.type_id WHERE ${where} ORDER BY ${orderSql} ${direction}, r.id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as RecordRow[];
    return { items: this.hydrate(rows, input.includePrivate === true, relationDepth), total };
  }

  getRecordById(id: string, includePrivate = true, relationDepth = 0): CmsRecord | null {
    if (!Number.isSafeInteger(relationDepth) || relationDepth < 0 || relationDepth > CMS_MAX_RELATION_DEPTH) throw new RangeError(`La profondità delle relazioni deve essere compresa tra 0 e ${CMS_MAX_RELATION_DEPTH}.`);
    const row = this.prepare("SELECT r.*, t.key AS type_key FROM cms_records r JOIN cms_content_types t ON t.id=r.type_id JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE r.id = ?").get(id) as unknown as RecordRow | undefined;
    return row ? this.hydrate([row], includePrivate, relationDepth)[0] ?? null : null;
  }

  isRecordDeleted(id: string): boolean {
    return Boolean(this.prepare("SELECT 1 FROM cms_identity_registry WHERE id=? AND kind='record' AND deleted_at IS NOT NULL").get(id));
  }

  hasIncomingRecordRelations(id: string, excludingOwnerIds: readonly string[] = []): boolean {
    if (excludingOwnerIds.length === 0) {
      return Boolean(this.prepare("SELECT 1 FROM cms_record_relations relation JOIN cms_identity_registry owner ON owner.id=relation.record_id AND owner.deleted_at IS NULL WHERE relation.target_id=? LIMIT 1").get(id));
    }
    if (excludingOwnerIds.some((ownerId) => !UUID.test(ownerId))) throw new TypeError("Identità delle voci da escludere non valida.");
    const placeholders = excludingOwnerIds.map(() => "?").join(",");
    return Boolean(this.prepare(`SELECT 1 FROM cms_record_relations relation JOIN cms_identity_registry owner ON owner.id=relation.record_id AND owner.deleted_at IS NULL WHERE relation.target_id=? AND owner.id NOT IN (${placeholders}) LIMIT 1`).get(id, ...excludingOwnerIds));
  }

  hasIncomingAssetReferences(id: string, excludingOwnerIds: readonly string[] = []): boolean {
    if (excludingOwnerIds.some((ownerId) => !UUID.test(ownerId))) throw new TypeError("Identità delle voci da escludere non valida.");
    const ownerFilter = excludingOwnerIds.length ? `AND owner.id NOT IN (${excludingOwnerIds.map(() => "?").join(",")})` : "";
    return Boolean(this.prepare(`SELECT 1 FROM cms_field_values value JOIN cms_identity_registry owner ON owner.id=value.record_id AND owner.deleted_at IS NULL WHERE value.asset_id=? ${ownerFilter} LIMIT 1`).get(id, ...excludingOwnerIds));
  }

  markRecordDeleted(id: string, deletedAt: string): void {
    this.markRecordsDeleted([{ id, deletedAt }]);
  }

  markRecordsDeleted(deletions: Array<{ id: string; deletedAt: string }>): void {
    if (deletions.length === 0) return;
    const uniqueIds = new Set<string>();
    for (const deletion of deletions) {
      if (!UUID.test(deletion.id) || uniqueIds.has(deletion.id) || !Number.isFinite(Date.parse(deletion.deletedAt)) || new Date(deletion.deletedAt).toISOString() !== deletion.deletedAt) {
        throw new TypeError("Identità o data di eliminazione della voce non valida.");
      }
      uniqueIds.add(deletion.id);
    }
    const ownerIds = [...uniqueIds];
    for (const deletion of deletions) {
      if (this.hasIncomingRecordRelations(deletion.id, ownerIds)) throw new TypeError("La voce non può essere eliminata: altri contenuti CMS la usano in un campo relazione e non sono inclusi nello stesso batch.");
      if (!this.getRecordById(deletion.id, true)) throw new TypeError("La voce collegata non è presente o è già stata eliminata.");
    }
    for (const deletion of deletions) {
      const result = this.prepare("UPDATE cms_identity_registry SET deleted_at=? WHERE id=? AND kind='record' AND deleted_at IS NULL").run(deletion.deletedAt, deletion.id);
      if (result.changes !== 1) throw new TypeError("La voce collegata non è presente o è già stata eliminata.");
    }
  }

  restoreRecord(id: string): boolean {
    if (!UUID.test(id)) return false;
    const result = this.prepare("UPDATE cms_identity_registry SET deleted_at=NULL WHERE id=? AND kind='record' AND deleted_at IS NOT NULL").run(id);
    return result.changes === 1;
  }

  listRecordLocales(typeKey: string, status: CmsRecordStatus = "published"): string[] {
    const type = this.getType(typeKey);
    if (!type) throw new TypeError("Tipo di contenuto non trovato: " + typeKey + ".");
    return (this.prepare("SELECT DISTINCT r.locale FROM cms_records r JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE r.type_id = ? AND r.status = ? ORDER BY r.locale").all(type.id, status) as Array<{ locale: string }>).map((row) => row.locale);
  }

  /**
   * Which terms of a taxonomy the published contents of one language are filed under, as pairs, in one read and without
   * the contents: the records of `typeKeys` in `locale` and, with `posts`, the published posts in `locale`.
   * The static build counts and fills its term archives from them (cms-api.ts): the same contents a published
   * listRecords gives, never a draft, a record in the trash or a post removed by a transfer.
   */
  listPublishedTermAssignments(taxonomyKey: string, input: { typeKeys: readonly string[]; locale: string; posts: boolean }): Array<{ contentId: string; termId: string; post: boolean }> {
    const taxonomy = this.getTaxonomy(taxonomyKey);
    if (!taxonomy) throw new TypeError("Tassonomia non trovata: " + taxonomyKey + ".");
    let locale: string;
    try { locale = Intl.getCanonicalLocales(input.locale)[0] ?? ""; } catch { locale = ""; }
    if (!locale) throw new TypeError("La lingua della query deve essere un tag BCP 47 valido.");
    const pairs: Array<{ contentId: string; termId: string; post: boolean }> = [];
    const typeIds = input.typeKeys.flatMap((key) => {
      const type = key === POST_TYPE_KEY ? null : this.getType(key);
      return type ? [type.id] : [];
    });
    // One statement per type: no list of placeholders grows with the project.
    for (const typeId of typeIds) {
      const rows = this.prepare("SELECT rt.record_id AS content_id, rt.term_id FROM cms_record_terms rt JOIN cms_records r ON r.id=rt.record_id JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE rt.taxonomy_id=? AND r.type_id=? AND r.status='published' AND r.locale=? ORDER BY rt.record_id, rt.term_id").all(taxonomy.id, typeId, locale) as Array<{ content_id: string; term_id: string }>;
      for (const row of rows) pairs.push({ contentId: row.content_id, termId: row.term_id, post: false });
    }
    if (input.posts && taxonomy.types.includes(POST_TYPE_KEY)) {
      const language = this.postLanguageClause(locale);
      const rows = this.prepare(`SELECT pt.post_id AS content_id, pt.term_id FROM cms_post_terms pt JOIN entities e ON e.id=pt.post_id WHERE pt.taxonomy_id=? AND e.kind='page' AND e.document_type='post' AND e.status='published' AND ${language.clause} AND NOT EXISTS (SELECT 1 FROM transfer_tombstones tomb WHERE tomb.id=e.id) ORDER BY pt.post_id, pt.term_id`).all(taxonomy.id, ...language.params) as Array<{ content_id: string; term_id: string }>;
      for (const row of rows) pairs.push({ contentId: row.content_id, termId: row.term_id, post: true });
    }
    return pairs;
  }

  /**
   * Published records by id, as a published listRecords gives them (public fields, relations to `relationDepth`), read
   * a hundred at a time: the static build reads a term archive's records by the ids of its assignments. The id of a
   * draft, of a record in the trash or of no record is left out.
   */
  listPublishedRecordsByIds(ids: readonly string[], relationDepth = 0): CmsRecord[] {
    if (!Number.isSafeInteger(relationDepth) || relationDepth < 0 || relationDepth > CMS_MAX_RELATION_DEPTH) throw new RangeError(`La profondità delle relazioni deve essere compresa tra 0 e ${CMS_MAX_RELATION_DEPTH}.`);
    const records: CmsRecord[] = [];
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    for (let offset = 0; offset < unique.length; offset += MAX_RECORDS_PER_QUERY) {
      const batch = unique.slice(offset, offset + MAX_RECORDS_PER_QUERY);
      const rows = this.prepare(`SELECT r.*, t.key AS type_key FROM cms_records r JOIN cms_content_types t ON t.id=r.type_id JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE r.status='published' AND r.id IN (${batch.map(() => "?").join(",")}) ORDER BY r.id`).all(...batch) as unknown as RecordRow[];
      records.push(...this.hydrate(rows, false, relationDepth));
    }
    return records;
  }

  private fieldId(typeId: string, key: string): string {
    const row = this.prepare("SELECT id FROM cms_field_defs WHERE type_id = ? AND key = ?").get(typeId, key) as { id: string } | undefined;
    if (!row) throw new TypeError(`Il campo ${key} non è definito nel tipo.`);
    return row.id;
  }

  private normalizeRecordTerms(value: unknown, current: CmsRecord | null, typeKey: string): Array<{ taxonomyId: string; termId: string }> {
    const input = value === undefined ? Object.fromEntries(Object.entries(current?.terms ?? {}).map(([key, terms]) => [key, terms.map((term) => term.alias)])) : jsonObject(value, "I termini della voce");
    if (Object.keys(input).length > 64) throw new RangeError("Una voce può essere collegata a un massimo di 64 tassonomie.");
    const result: Array<{ taxonomyId: string; termId: string }> = [];
    const seen = new Set<string>();
    for (const [taxonomyKey, aliases] of Object.entries(input)) {
      const taxonomy = this.getTaxonomy(taxonomyKey);
      if (!taxonomy) throw new TypeError("Tassonomia non trovata: " + taxonomyKey + ".");
      // A term of a taxonomy not linked to the record's type would save here and make the .xbsite export fail later.
      if (!taxonomy.types.includes(typeKey)) throw new TypeError(`La tassonomia ${taxonomy.key} non è collegata al tipo ${typeKey}: collegala al tipo o togli i suoi termini dalla voce.`);
      if (!Array.isArray(aliases) || aliases.length > 100) throw new TypeError("Ogni tassonomia accetta da 0 a 100 termini per voce.");
      for (const alias of aliases) {
        if (!Number.isSafeInteger(alias) || (alias as number) < 1) throw new TypeError("Alias termine non valido.");
        const term = this.getTermByAlias(alias as number);
        if (!term || term.taxonomyKey !== taxonomyKey) throw new TypeError("Un termine selezionato non appartiene alla tassonomia " + taxonomyKey + ".");
        if (seen.has(term.id)) throw new TypeError("Lo stesso termine è stato selezionato più volte.");
        seen.add(term.id);
        result.push({ taxonomyId: taxonomy.id, termId: term.id });
      }
    }
    return result;
  }

  /** The terms of a post, by taxonomy, in their saved order. */
  postTerms(postId: string): Record<string, CmsTerm[]> {
    const rows = this.prepare("SELECT pt.term_id, tax.key AS taxonomy_key FROM cms_post_terms pt JOIN cms_taxonomies tax ON tax.id=pt.taxonomy_id WHERE pt.post_id=? ORDER BY tax.key, pt.ordinal").all(postId) as Array<{ term_id: string; taxonomy_key: string }>;
    const result: Record<string, CmsTerm[]> = {};
    for (const row of rows) {
      const term = this.getTermById(row.term_id);
      if (!term) continue;
      const terms = result[row.taxonomy_key] ?? [];
      terms.push(term);
      result[row.taxonomy_key] = terms;
    }
    return result;
  }

  /** The posts of one language: a post with no language of its own is in the site's. */
  private postLanguageClause(locale: string): { clause: string; params: string[] } {
    return locale.toLowerCase() === this.projectLocale().toLowerCase() ? { clause: "(e.locale IS NULL OR lower(e.locale) = lower(?))", params: [locale] } : { clause: "lower(e.locale) = lower(?)", params: [locale] };
  }

  /** The languages of the published posts besides the site's. */
  listPostLocales(): string[] {
    return (this.prepare("SELECT DISTINCT e.locale FROM entities e WHERE e.kind='page' AND e.document_type='post' AND e.status='published' AND e.locale IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transfer_tombstones tomb WHERE tomb.id = e.id) ORDER BY e.locale").all() as Array<{ locale: string }>).map((row) => row.locale);
  }

  /**
   * Published posts as query items, so a loop can list them like records. Posts have no fields: filters may only use
   * taxonomies attached to posts, and the order is by date, title, alias or update. With `locale`, only that language's.
   */
  private listPostRecords(input: CmsRecordQuery): CmsRecordPage {
    const limit = input.limit ?? 50; const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS_PER_QUERY || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError("Limite o offset della query fuori dai valori ammessi.");
    const params: Array<string | number | null> = [];
    const clauses = ["e.kind = 'page'", "e.document_type = 'post'", "NOT EXISTS (SELECT 1 FROM transfer_tombstones tomb WHERE tomb.id = e.id)"];
    if (input.status === undefined || input.status === "published") clauses.push("e.status = 'published'");
    else if (input.status === "draft") clauses.push("e.status = 'draft'");
    else if (input.status !== "any") return { items: [], total: 0 };
    let requestedLocale: string | undefined;
    if (input.locale) {
      try { requestedLocale = Intl.getCanonicalLocales(input.locale)[0]; } catch { throw new TypeError("La lingua della query deve essere un tag BCP 47 valido."); }
      if (requestedLocale) {
        const language = this.postLanguageClause(requestedLocale);
        if (input.fallbackLocale && input.fallbackLocale !== requestedLocale) {
          const original = this.postLanguageClause(input.fallbackLocale);
          clauses.push(`(${language.clause} OR (${original.clause} AND NOT EXISTS (SELECT 1 FROM cms_translations link JOIN entities version ON version.id = link.translation_id WHERE link.source_id = e.id AND lower(link.language) = lower(?) AND version.status = 'published')))`);
          params.push(...language.params, ...original.params, requestedLocale);
        } else {
          clauses.push(language.clause);
          params.push(...language.params);
        }
      }
    }
    if (input.search !== undefined) {
      const search = input.search.trim();
      if (search.length > 120 || /[\0\r\n]/u.test(search)) throw new TypeError("La ricerca deve avere al massimo 120 caratteri e non contenere ritorni a capo.");
      if (search) {
        const escaped = search.replace(/[\\%_]/gu, "\\$&");
        clauses.push("(e.title LIKE ? ESCAPE '\\' OR e.slug LIKE ? ESCAPE '\\')");
        params.push(`%${escaped}%`, `%${escaped}%`);
      }
    }
    if (input.filter) clauses.push(this.compilePostFilter(input.filter, params, 0));
    const direction = input.order === "desc" ? "DESC" : "ASC";
    const orderSql: Record<string, string> = { order: "e.alias", title: "e.title COLLATE NOCASE", slug: "e.slug", publishedAt: "e.published_at", updatedAt: "e.updated_at", createdAt: "e.created_at" };
    const order = orderSql[input.orderBy ?? "publishedAt"];
    if (!order) throw new TypeError(`Il campo ${String(input.orderBy)} non può ordinare gli articoli.`);
    const where = clauses.join(" AND ");
    const total = Number((this.prepare(`SELECT COUNT(*) AS n FROM entities e WHERE ${where}`).get(...params) as { n: number }).n);
    const rows = this.prepare(`SELECT e.id, e.slug, e.title, e.status, e.published_at, e.excerpt, e.image_asset_id, e.alias, e.head_revision, e.locale, e.updated_at FROM entities e WHERE ${where} ORDER BY ${order} ${direction}, e.id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as PostRow[];
    return {
      total,
      items: rows.map((row) => ({
        id: row.id, typeId: POST_TYPE_KEY, typeKey: POST_TYPE_KEY, slug: row.slug, locale: row.locale ?? requestedLocale ?? this.projectLocale(), title: row.title, status: row.status,
        publishedAt: row.published_at, excerpt: row.excerpt, imageAssetId: row.image_asset_id, order: row.alias, fields: {}, values: {}, terms: this.postTerms(row.id),
        headRevision: row.head_revision, updatedAt: row.updated_at,
      })),
    };
  }

  private compilePostFilter(filter: CmsRecordFilter, params: Array<string | number | null>, depth: number): string {
    if (depth > MAX_FILTER_DEPTH) throw new RangeError("I filtri annidati superano il limite di quattro livelli.");
    if (depth === 0) assertFilterLeaves(filter);
    if ("and" in filter || "or" in filter) {
      const list = "and" in filter ? filter.and : filter.or;
      if (!Array.isArray(list) || list.length < 1 || list.length > 32) throw new TypeError("Un gruppo filtro deve contenere da 1 a 32 condizioni.");
      const operator = "and" in filter ? "AND" : "OR";
      return `(${list.map((item) => this.compilePostFilter(item, params, depth + 1)).join(` ${operator} `)})`;
    }
    if (!("taxonomyKey" in filter)) throw new TypeError("Gli articoli si filtrano soltanto per categorie, tag o altre tassonomie degli articoli.");
    const taxonomy = this.getTaxonomy(filter.taxonomyKey);
    if (!taxonomy || !taxonomy.types.includes(POST_TYPE_KEY)) throw new TypeError(`La tassonomia ${String(filter.taxonomyKey)} non è collegata agli articoli.`);
    if (!Array.isArray(filter.termIds) || filter.termIds.length < 1 || filter.termIds.length > 100) throw new TypeError("Il filtro tassonomia deve contenere da 1 a 100 termini.");
    const terms = filter.termIds.map((id) => {
      if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("Identificativo termine filtro non valido.");
      const term = this.getTermById(id);
      if (!term || term.taxonomyKey !== taxonomy.key) throw new TypeError(`Il termine non appartiene alla tassonomia ${taxonomy.key}.`);
      return term.id;
    });
    const marks = terms.map(() => "?").join(",");
    if (filter.operator === "IN" || filter.operator === "NOT IN") {
      params.push(taxonomy.id, ...terms);
      return `${filter.operator === "IN" ? "" : "NOT "}EXISTS (SELECT 1 FROM cms_post_terms pt WHERE pt.post_id=e.id AND pt.taxonomy_id=? AND pt.term_id IN (${marks}))`;
    }
    if (filter.operator === "AND") {
      params.push(taxonomy.id, ...terms, terms.length);
      return `(SELECT COUNT(DISTINCT pt.term_id) FROM cms_post_terms pt WHERE pt.post_id=e.id AND pt.taxonomy_id=? AND pt.term_id IN (${marks})) = ?`;
    }
    throw new TypeError("Operatore tassonomia non supportato.");
  }

  private compileFilter(filter: CmsRecordFilter, type: CmsContentType, includePrivate: boolean, params: Array<string | number | null>, depth: number): string {
    if (depth > MAX_FILTER_DEPTH) throw new RangeError("I filtri annidati superano il limite di quattro livelli.");
    if (depth === 0) assertFilterLeaves(filter);
    if ("and" in filter || "or" in filter) {
      const list = "and" in filter ? filter.and : filter.or;
      if (!Array.isArray(list) || list.length < 1 || list.length > 32) throw new TypeError("Un gruppo filtro deve contenere da 1 a 32 condizioni.");
      const operator = "and" in filter ? "AND" : "OR";
      return `(${list.map((item) => this.compileFilter(item, type, includePrivate, params, depth + 1)).join(` ${operator} `)})`;
    }
    if ("taxonomyKey" in filter) {
      const taxonomy = this.getTaxonomy(filter.taxonomyKey);
      if (!taxonomy) throw new TypeError(`Tassonomia filtro non trovata: ${filter.taxonomyKey}.`);
      if (!taxonomy.types.includes(type.key)) throw new TypeError(`La tassonomia ${taxonomy.key} non è collegata al tipo ${type.key}.`);
      if (!Array.isArray(filter.termIds) || filter.termIds.length < 1 || filter.termIds.length > 100) throw new TypeError("Il filtro tassonomia deve contenere da 1 a 100 termini.");
      const terms = filter.termIds.map((id) => {
        if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("Identificativo termine filtro non valido.");
        const term = this.getTermById(id);
        if (!term || term.taxonomyKey !== taxonomy.key) throw new TypeError(`Il termine non appartiene alla tassonomia ${taxonomy.key}.`);
        return term.id;
      });
      const marks = terms.map(() => "?").join(",");
      if (filter.operator === "IN") {
        params.push(taxonomy.id, ...terms);
        return `EXISTS (SELECT 1 FROM cms_record_terms tr WHERE tr.record_id=r.id AND tr.taxonomy_id=? AND tr.term_id IN (${marks}))`;
      }
      if (filter.operator === "NOT IN") {
        params.push(taxonomy.id, ...terms);
        return `NOT EXISTS (SELECT 1 FROM cms_record_terms tr WHERE tr.record_id=r.id AND tr.taxonomy_id=? AND tr.term_id IN (${marks}))`;
      }
      if (filter.operator === "AND") {
        params.push(taxonomy.id, ...terms, terms.length);
        return `(SELECT COUNT(DISTINCT tr.term_id) FROM cms_record_terms tr WHERE tr.record_id=r.id AND tr.taxonomy_id=? AND tr.term_id IN (${marks})) = ?`;
      }
      throw new TypeError("Operatore tassonomia non supportato.");
    }
    return this.compileFieldFilter(filter, type, "r", includePrivate, params, 0);
  }

  private compileFieldFilter(filter: Extract<CmsRecordFilter, { field: string }>, type: CmsContentType, recordAlias: string, includePrivate: boolean, params: Array<string | number | null>, relationDepth: number): string {
    const path = filter.field.split(".");
    if (path.length > CMS_MAX_RELATION_DEPTH + 1 || path.some((key) => !FIELD_KEY.test(key))) throw new TypeError(`Il percorso del campo ${filter.field} supera la profondità o il formato ammessi.`);
    if (path.length > 1) {
      const relation = type.fields.find((item) => item.key === path[0]);
      if (!relation || relation.type !== "relation" || !relation.targetType || !includePrivate && !relation.public) throw new TypeError(`Il percorso filtro ${filter.field} contiene una relazione non disponibile.`);
      if (relationDepth >= CMS_MAX_RELATION_DEPTH) throw new RangeError(`Il percorso filtro supera ${CMS_MAX_RELATION_DEPTH} relazioni.`);
      const targetType = this.getType(relation.targetType);
      if (!targetType) throw new TypeError(`Il tipo collegato al percorso filtro ${filter.field} non esiste.`);
      const alias = `target${relationDepth}`;
      const fieldId = this.fieldId(type.id, relation.key);
      params.push(fieldId, targetType.id);
      const nested = this.compileFieldFilter({ ...filter, field: path.slice(1).join(".") }, targetType, alias, includePrivate, params, relationDepth + 1);
      const publicTarget = includePrivate ? "" : ` AND ${alias}.status='published'`;
      return `EXISTS (SELECT 1 FROM cms_record_relations relation${relationDepth} JOIN cms_records ${alias} ON ${alias}.id=relation${relationDepth}.target_id JOIN cms_identity_registry identity${relationDepth} ON identity${relationDepth}.id=${alias}.id AND identity${relationDepth}.deleted_at IS NULL WHERE relation${relationDepth}.record_id=${recordAlias}.id AND relation${relationDepth}.field_id=? AND ${alias}.type_id=?${publicTarget} AND (${nested}))`;
    }
    const fieldKey = path[0]!;
    const field = type.fields.find((item) => item.key === fieldKey);
    if (!field || !includePrivate && !field.public) throw new TypeError(`Il campo filtro ${filter.field} non è disponibile nella query pubblica.`);
    const fieldId = this.fieldId(type.id, field.key);
    if (field.type === "relation") {
      if (filter.op === "exists") { params.push(fieldId); return `EXISTS (SELECT 1 FROM cms_record_relations fr WHERE fr.record_id=${recordAlias}.id AND fr.field_id=?)`; }
      if (filter.op === "eq" && typeof filter.value === "string" && UUID.test(filter.value)) {
        if (field.multiple) throw new TypeError(`Il filtro di uguaglianza non è supportato per la relazione multipla ${field.key}; usa “ha un record collegato”.`);
        const target = this.getRecordById(filter.value, true);
        if (!target || target.typeKey !== field.targetType || !includePrivate && target.status !== "published") throw new TypeError(`Il record del filtro relazione ${field.key} non esiste, non è pubblicato o non appartiene al tipo collegato.`);
        params.push(fieldId, filter.value);
        return `EXISTS (SELECT 1 FROM cms_record_relations fr WHERE fr.record_id=${recordAlias}.id AND fr.field_id=? AND fr.target_id=?)`;
      }
      throw new TypeError(`L’operatore ${filter.op} non è supportato per il campo relazione ${field.key}.`);
    }
    if (field.type === "asset") throw new TypeError(`Il campo asset ${field.key} non si può filtrare.`);
    if (field.multiple) throw new TypeError(`Il campo multiplo ${field.key} non si può filtrare con un singolo valore.`);
    if (filter.op === "exists") { params.push(fieldId); return `EXISTS (SELECT 1 FROM cms_field_values fv WHERE fv.record_id=${recordAlias}.id AND fv.field_id=? AND (fv.json_value IS NULL OR fv.json_value <> 'null'))`; }
    const column = ["integer", "decimal"].includes(field.type) ? "number_value" : field.type === "boolean" ? "bool_value" : "text_value";
    const expr = `(SELECT fv.${column} FROM cms_field_values fv WHERE fv.record_id=${recordAlias}.id AND fv.field_id=? AND fv.ordinal=0)`;
    if (filter.op === "in") {
      if (!Array.isArray(filter.value) || filter.value.length < 1 || filter.value.length > 100) throw new TypeError(`Il filtro in del campo ${field.key} deve contenere da 1 a 100 valori.`);
      params.push(fieldId);
      const values = filter.value.map((value) => { this.validateFilterValue(field, value); params.push(field.type === "boolean" ? (value ? 1 : 0) : value as string | number); return "?"; });
      return `${expr} IN (${values.join(",")})`;
    }
    if (!["eq", "ne", "lt", "lte", "gt", "gte", "contains"].includes(filter.op)) throw new TypeError(`Operatore filtro sconosciuto: ${String(filter.op)}.`);
    this.validateFilterValue(field, filter.value);
    params.push(fieldId, field.type === "boolean" ? (filter.value ? 1 : 0) : filter.value as string | number);
    if (filter.op === "contains") {
      params[params.length - 1] = String(filter.value).replace(/[\\%_]/gu, "\\$&");
      return `${expr} LIKE '%' || ? || '%' ESCAPE '\\'`;
    }
    const op = filter.op === "eq" ? "=" : filter.op === "ne" ? "<>" : filter.op === "lt" ? "<" : filter.op === "lte" ? "<=" : filter.op === "gt" ? ">" : ">=";
    return `${expr} ${op} ?`;
  }

  private validateFilterValue(field: CmsFieldDefinition, value: unknown): void {
    const valid = ["integer", "decimal"].includes(field.type) ? typeof value === "number" && Number.isFinite(value)
      : field.type === "boolean" ? typeof value === "boolean"
      : typeof value === "string" && value.length <= 4096;
    if (!valid || field.type === "enum" && !field.options?.includes(String(value))) throw new TypeError(`Valore filtro non valido per il campo ${field.key}.`);
  }

  private hydrate(rows: RecordRow[], includePrivate: boolean, relationDepth = 0, expansionState?: { recordIds: Set<string> }): CmsRecord[] {
    if (!rows.length) return [];
    const state = expansionState ?? { recordIds: new Set<string>() };
    const ids = rows.map((row) => row.id); const marks = ids.map(() => "?").join(",");
    const values = this.prepare(`SELECT fv.*, f.key, f.field_type, f.is_public, f.multiple FROM cms_field_values fv JOIN cms_field_defs f ON f.id=fv.field_id WHERE fv.record_id IN (${marks}) ORDER BY fv.record_id, f.ordinal, fv.ordinal`).all(...ids) as unknown as Array<ValueRow & { key: string; field_type: CmsFieldType; is_public: number; multiple: number }>;
    const relations = this.prepare(`SELECT rel.*, f.key, f.is_public, f.multiple, target.id AS target_record_id, target.title AS target_title, target.slug AS target_slug, target.locale AS target_locale, target.status AS target_status FROM cms_record_relations rel JOIN cms_field_defs f ON f.id=rel.field_id JOIN cms_records target ON target.id=rel.target_id JOIN cms_identity_registry target_identity ON target_identity.id=target.id AND target_identity.deleted_at IS NULL WHERE rel.record_id IN (${marks}) ORDER BY rel.record_id, f.ordinal, rel.ordinal`).all(...ids) as unknown as Array<RelationRow & { key: string; is_public: number; multiple: number; target_record_id: string; target_title: string; target_slug: string; target_locale: string; target_status: CmsRecordStatus }>;
    const parentStatus = new Map(rows.map((row) => [row.id, row.status]));
    const targetIds = relationDepth > 0
      ? [...new Set(relations.filter((relation) => (includePrivate || relation.is_public === 1) && (parentStatus.get(relation.record_id) !== "published" || relation.target_status === "published")).map((relation) => relation.target_record_id))]
      : [];
    for (const id of targetIds) {
      state.recordIds.add(id);
      if (state.recordIds.size > MAX_RELATION_EXPANSION_RECORDS) throw new RangeError(`L’espansione delle relazioni supera il limite di ${MAX_RELATION_EXPANSION_RECORDS.toLocaleString("it-IT")} record per query.`);
    }
    const expandedTargets = new Map<string, CmsRecord>();
    for (let offset = 0; offset < targetIds.length; offset += RELATION_EXPANSION_BATCH_SIZE) {
      const batchIds = targetIds.slice(offset, offset + RELATION_EXPANSION_BATCH_SIZE);
      const batchMarks = batchIds.map(() => "?").join(",");
      const targetRows = this.prepare(`SELECT r.*, t.key AS type_key FROM cms_records r JOIN cms_content_types t ON t.id=r.type_id JOIN cms_identity_registry identity ON identity.id=r.id AND identity.deleted_at IS NULL WHERE r.id IN (${batchMarks}) ORDER BY r.id`).all(...batchIds) as unknown as RecordRow[];
      for (const target of this.hydrate(targetRows, includePrivate, relationDepth - 1, state)) expandedTargets.set(target.id, target);
    }
    const termRows = this.prepare(`SELECT rt.record_id, term.*, tax.key AS taxonomy_key FROM cms_record_terms rt JOIN cms_terms term ON term.id=rt.term_id JOIN cms_taxonomies tax ON tax.id=rt.taxonomy_id WHERE rt.record_id IN (${marks}) ORDER BY rt.record_id, tax.key, rt.ordinal`).all(...ids) as unknown as Array<{ record_id: string } & TermRow>;
    const termsByRecord = new Map<string, Record<string, CmsTerm[]>>();
    for (const id of ids) termsByRecord.set(id, Object.create(null) as Record<string, CmsTerm[]>);
    for (const row of termRows) {
      const buckets = termsByRecord.get(row.record_id)!;
      let taxonomyTerms = buckets[row.taxonomy_key];
      if (!taxonomyTerms) {
        taxonomyTerms = [];
        buckets[row.taxonomy_key] = taxonomyTerms;
      }
      taxonomyTerms.push(this.termFromRow(row));
    }
    const byRecord = new Map<string, Record<string, unknown>>();
    for (const row of rows) byRecord.set(row.id, Object.create(null) as Record<string, unknown>);
    for (const value of values) {
      if (!includePrivate && value.is_public !== 1) continue;
      const target = byRecord.get(value.record_id)!;
      const item = value.asset_id ?? (value.json_value !== null ? JSON.parse(value.json_value) : value.bool_value !== null ? value.bool_value === 1 : value.number_value ?? value.text_value);
      const current = target[value.key];
      if (value.multiple === 1) target[value.key] = [...(Array.isArray(current) ? current : []), item];
      else target[value.key] = item;
    }
    for (const relation of relations) {
      if (!includePrivate && relation.is_public !== 1) continue;
      if (relation.target_status !== "published" && parentStatus.get(relation.record_id) === "published") continue;
      const target = byRecord.get(relation.record_id)!;
      const expanded = expandedTargets.get(relation.target_record_id);
      const item = { id: relation.target_record_id, title: relation.target_title, slug: relation.target_slug, locale: relation.target_locale, ...(expanded ? { fields: expanded.fields } : {}) };
      const current = target[relation.key];
      if (relation.multiple === 1) target[relation.key] = [...(Array.isArray(current) ? current : []), item];
      else target[relation.key] = item;
    }
    return rows.map((row) => {
      const typeKey = row.type_key ?? (this.prepare("SELECT key FROM cms_content_types WHERE id = ?").get(row.type_id) as { key: string }).key;
      const recordValues = byRecord.get(row.id)!;
      return { id: row.id, typeId: row.type_id, typeKey, slug: row.slug, locale: row.locale, title: row.title, status: row.status, publishedAt: row.published_at, date: row.published_at, excerpt: row.excerpt, order: row.order_no, fields: recordValues, meta: recordValues, values: recordValues, terms: termsByRecord.get(row.id)!, headRevision: row.head_revision, updatedAt: row.updated_at, ...recordValues };
    });
  }

  /** Runs `operation` inside a transaction its caller holds on this database, which commits or undoes it. */
  joinTransaction<T>(operation: () => T): T {
    this.transactionDepth++;
    try { return operation(); } finally { this.transactionDepth--; }
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth++;
      try { return operation(); } finally { this.transactionDepth--; }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.transactionDepth = 0; }
  }
}
