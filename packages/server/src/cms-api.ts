import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fontsData, importGoogleFont, removeFont, videoInfo, type VideoFetcher } from "./builder-extras.js";
import type { FontFetcher } from "./google-fonts.js";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { removeTemporary } from "./remove-temporary.js";
import { planTokenImport, TOKEN_IMPORT_BODY_MAX } from "./cms-token-import.js";
import { DESIGN_SOURCE_FILE_MAX, designPagesFromFile, designPrototypeFromFile, designSourceChoice, designSourceName } from "./cms-design-source.js";
import { FIGMA_TOKEN_ACCOUNT, figmaTokenState, removeFigmaToken, saveFigmaToken, TOKEN_SOURCE_FILE_MAX, tokenSourceFromFigma, tokenSourceFromFile, tokenSourceName } from "./cms-token-source.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { addPagefind, buildBundle, DEFAULT_MAX_FILES, HistosPublishError, type Destination, type DestinationPlanMetadata, type Finding } from "@histos-publish/core";
import { BEHAVIORS_CSS, BEHAVIORS_SCRIPT, pageUsesBehaviors, assertNativeBackupFits, CMS_MAX_RELATION_DEPTH, CMS_RUNTIME_CAPABILITIES, CmsSyncConflictError, changedHistosDesign, cmsMetaDescription, compileCmsStyles, createStaticPageProfile, createTransferTombstone, decodeNativeProjectArchive, decodeStaticPageArchive, encodeNativeProjectArchive, encodeStaticPageArchive, frameworkDataWithExternalCss, histosFrameworkData, withSiteDesign, validateSiteRecipes, validateSiteTokens, HISTOS_DESIGN_DEFAULTS, histosClassOffPatterns, histosContrast, histosExportTokens, histosPreviewCss, histosTokenNames, extensionForMime, postContentWithImage, postImageNode, queryItemWithMedia, renderCmsPage, stylesData, validateHistosDesign, validateHistosTokenOverrides, buildPrototypeProfile, CmsProjectCatalog, parsePrototype, PROTOTYPE_MAX_BYTES, type PrototypeAssetFetcher, type PrototypeImportProgress, type CmsComponent, type CmsComponentSaveResult, type CmsEntity, type CmsProjectStore, type CmsQueryPreset, type CmsRecord, type CmsTerm, type PrototypeImageCandidate, type PrototypeReport, normalizeCmsImageSettings, documentAddress, pageAddress, postAddress, documentSegments, localizeHtml, MAX_XLIFF_BYTES, normalizeShopSettings, normalizeSiteUrl, sectionLibrary, SiteLanguages, UnreadableArchiveError, type SiteLanguageContent } from "@histos-publish/cms";
// The archives' rules, shared with the prototype check and the prototype's quality walk (content-model.ts).
import { ARTICLE_COMPONENT_PREFIX, ARTICLE_LIBRARY, assertDocumentScript, customCard, customCardForm, repeatingCard, ROW_SUFFIX, cardMarkup, type CardDefinition, type CardRules, cleanCard, componentCalls, checkPaste, PasteRefusedError, articleFromHtml, type ArticleBlock, buildWxr, MAX_WXR_BYTES, parseWxr, type WxrExportItem, type WxrFile, readArticle, sniffPrototypeMedia, writeArticle } from "@histos-publish/cms";
import { CMS_ARCHIVE_PAGE_SIZE, cmsArchivePageAddress, cmsArchivePageCount, cmsArchivePaging, cmsArchiveWritten, cmsPostsIndexWritten, cmsTermArchiveIncludesChildren, cmsTermArchiveRoles } from "@histos-publish/cms";
// What every page of a static build inlines (pageCssLowerBound): the Histeon CSS and the project's global sheets.
import { cssResourceReferences, histosGlobalCss } from "@histos-publish/cms";
import { TEMPLATE_ROLES, type TemplateRole } from "@histos-publish/histos-contract";
import { readJson, sendJson } from "./http.js";
import { fetchPrototypeAsset } from "./prototype-assets.js";
import { readWordPressSite, type JsonFetcher } from "./wordpress-site-read.js";
import { checkBuiltSite, readiness, readSavedReadiness, saveReadiness, summarizeBrowserCheck, type BrowserSummary } from "./site-check.js";
import { browserCheckNote, bundleFileAddress, checkPrototype, documentAddresses, previewMachineFailure, profileDigest, prototypeBuildFailed, prototypeBuildRefused, prototypeInvalid, refusalDocument, type PreviewVerify, type PrototypeCheckResult, type PrototypePreviewOutcome } from "./prototype-check.js";
import { checkBuiltLinks } from "./prototype-links.js";
import { checkBuiltPages, loadAxeScript, type OpenPageProbe } from "./prototype-verify.js";
import { keptPageAddress, readKeptProposal, readKeptSiteFiles, type KeptProposal } from "./proposal-store.js";
import { compareProposal, readProposalCompare, saveProposalCompare, type OpenPagePhotos, type ProposalComparePage, type ProposalCompareResult } from "./proposal-compare.js";
import { cmsRenderOrigin, type CmsRenderOrigin } from "@histos-publish/cms";
import { ImportProgressBoard } from "./import-progress.js";
import type { PrototypePreviews } from "./prototype-previews.js";
import type { ImportReport, ImportReports } from "./import-reports.js";
import { prepareBackup, type PendingBackup } from "./connector-files.js";
import { cachedImageSavings, emptyImageVariantSummary, imageVariantSentence, measuredImageNote, writeImageVariants, type ImageVariantLimits, type ImageVariantSummary } from "./image-variants.js";
import { checkRemoteSite } from "./cms-remote-check.js";
import { checkRemoteSiteInBrowser } from "./cms-remote-browser-check.js";
import { parseBringIds } from "./cms-remote-bring.js";
import { applyRemoteSyncPlan, checkRemoteOperation, claimRemotePairing, CmsRemoteCatalog, connectionHisteonNotice, connectRemoteSite, pendingPairingSite, startRemotePairing, createRemoteSyncPlan, isConnectionId, revokeRemotePairing, rollbackRemoteOperation, type CmsRemoteSecretStore } from "./cms-remote.js";
import { answerFrontPageOffer, frontPageOffer } from "./cms-remote-front-page.js";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
/** The routes a static build writes at most (pages, posts, records, every page of every archive, the 404). */
export const MAX_CMS_BUILD_ROUTES = 50_000;
/**
 * Records one type's archive may hold in one language, and posts the posts index may hold: the build reads them all,
 * with their relations, to order and page them. A term's archive has no limit of its own, as WordPress serves one of any
 * size a page at a time: one page lists CMS_ARCHIVE_PAGE_SIZE contents; the contents of a taxonomy's archives are
 * records and posts these limits bound already, read once per taxonomy and language; and each page a term's
 * descendants add to its archive is a route the plan counts, against MAX_CMS_BUILD_ROUTES and the bundle's limits.
 */
const CMS_ARCHIVE_MAX_RECORDS = 10_000;
/** The bytes of a static build's bundle at most (buildBundle's maxBytes): past them it stops with source-too-large. */
const CMS_BUNDLE_MAX_BYTES = 250 * 1024 * 1024;
/** Collisions a route plan keeps to say: the count covers them all. */
const CMS_ROUTE_COLLISIONS_KEPT = 100;
const CMS_BUILD_TIMEOUT_MS = 120_000;
const IMAGE_MIME = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const FONT_MIME_BY_EXTENSION: Record<string, string> = { ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validFontSignature(bytes: Uint8Array, mimeType: string): boolean {
  const signature = Buffer.from(bytes.slice(0, 4)).toString("latin1");
  if (mimeType === "font/woff") return signature === "wOFF";
  if (mimeType === "font/woff2") return signature === "wOF2";
  if (mimeType === "font/otf") return signature === "OTTO";
  if (mimeType === "font/ttf") return signature === "\0\u0001\0\0" || signature === "true";
  return false;
}

export interface CmsPreviewRegistration {
  ticket: string;
  buildId: string;
  bundlePath: string;
}

export interface CmsDestinationInspection {
  schemaVersion: 1;
  destinationId: string;
  label: string;
  kind: "static-cloudflare" | "static-hosting";
  transport: "cloudflare-api" | "ftp" | "ftps" | "sftp";
  checkedAt: string;
  readVerified: true;
  writeVerified: false;
  publicUrl?: string;
  detectedCapabilities: {
    atomicSwitch: boolean;
    rollback: boolean;
    deleteManaged: boolean;
    remoteVerify: boolean;
    runtimeProvision: boolean;
    databaseProbe: boolean;
  };
  evidence: Record<string, unknown>;
  remoteInventory?: { complete: boolean; files: Array<{ path: string; size: number }> };
  findings: Array<{ severity: "warn" | "block"; code: string; message: string }>;
}

export interface CmsPublishPlan extends DestinationPlanMetadata {
  schemaVersion: 1;
  status: "ready" | "blocked";
  planId: string | null;
  projectId: string;
  buildId: string;
  projectRevision: string;
  createdAt: string;
  expiresAt: string;
  build: { fileCount: number; totalBytes: number; sha256: string; homePage: "index.html"; filesPreview: Array<{ path: string; size: number }>; additionalFiles: number };
  destination: {
    id: string;
    label: string;
    kind: CmsDestinationInspection["kind"];
    transport: CmsDestinationInspection["transport"];
    location: string;
    publicUrl?: string;
  };
  inspection: CmsDestinationInspection;
  remoteDiff: {
    status: "complete" | "partial" | "unavailable";
    basis: "path-and-size" | "none";
    counts: { missing: number; sameSize: number; differentSize: number; remoteOnly: number };
    filesPreview: Array<{ path: string; status: "missing" | "same-size" | "different-size" | "remote-only"; localSize?: number; remoteSize?: number }>;
    additionalFiles: number;
    note: string;
  };
  rollbackBackup: { status: "ready" | "blocked" | "not-applicable"; estimatedBytes: number; maxBytes: number; note: string };
  effects: string[];
  findings: CmsDestinationInspection["findings"];
  writeVerified: false;
}

export interface CmsApiContext {
  /** Doc 17 item 4: a browser for the prototype check's preview (the desktop app's hidden window); none in the server alone. */
  openPageProbe?: OpenPageProbe;
  /** «Uguale alla proposta»: a browser that photographs pages (the desktop app's hidden window); none in the server alone. */
  photographPages?: OpenPagePhotos;
  /** «Uguale alla proposta», the side «senza token»: the prototype of a captured site converted without a framework. */
  convertProposalSite?: (files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, name: string, signal?: AbortSignal) => Promise<{ prototype: string; missing: readonly string[] }>;
  /** A sealed, still address for a kept original (on the capture origin), for the frame beside the built site. */
  openProposalOriginal?: (siteDirectory: string) => string;
  /** Test seam: downloads a remote prototype image (default: public HTTPS only, see prototype-assets.ts). */
  fetchPrototypeAsset?: PrototypeAssetFetcher;
  fetchWordPressJson?: JsonFetcher;
  catalog: CmsProjectCatalog;
  remoteCatalog: CmsRemoteCatalog;
  secretStoreFor: (account: string) => CmsRemoteSecretStore;
  dataDirectory: string;
  port: number;
  buildLimits?: Partial<CmsBuildLimits>;
  buildBundle?: typeof buildBundle;
  registerPreview: (preview: CmsPreviewRegistration) => void;
  /** Throwaway builds of checked prototypes (queue A2); without it a check cannot offer a preview. */
  prototypePreviews?: PrototypePreviews;
  /** The last prototype import of each project (queue D1); without it no report is kept. */
  importReports?: ImportReports;
  /** Test seams: the hosts of Google Fonts and of the video providers, for the builder's font panel and video window. */
  fontFetcher?: FontFetcher;
  videoFetcher?: VideoFetcher;
  /** Doc 23 item 109: the bytes of a converted site's media, by hash; only the app's own routes pass it on. */
  convertedMedia?: (sha256: string) => Uint8Array | null;
  /** Where a running check or import is, for the app (queue D3). */
  importProgress?: ImportProgressBoard;
  /**
   * The folder of the image variants' cache (queue B6); null keeps no cache. By default
   * <data>/histos-image-variants, shared by every project and build of the app (entries are keyed by content).
   */
  imageVariantCache?: string | null;
  /** Test seam: the encoder's limits (image-variants.ts). */
  imageVariantLimits?: Partial<ImageVariantLimits>;
  registerBuild: (build: { projectId: string; buildId: string; bundlePath: string; projectRevision: string; files: number; pages: number; assets: number; totalBytes: number; findings: Finding[] }) => void;
  listBuilds: (projectId: string, projectRevision: string) => Promise<unknown[]>;
  /** The project's newest registered build, for the catalog cards (E9); without it the cards do not show one. */
  latestBuild?: (projectId: string) => { createdAt: string; projectRevision: string; bundlePath: string } | null;
  /** A new preview address (5 minutes) for a registered, ready build of the project. */
  previewBuild: (input: { projectId: string; buildId: string }) => Promise<{ previewUrl: string; expiresAt: string }>;
  /** Why the project cannot be deleted now (a publication running, a site that publishes it), or null. */
  projectInUse?: (projectId: string) => string | null;
  /** After a deletion: the project's builds, previews and registry rows go too. */
  forgetProject?: (projectId: string) => Promise<void>;
  exportBuild: (input: { projectId: string; buildId: string }, response: ServerResponse) => Promise<void>;
  createPublishPlan: (input: { projectId: string; buildId: string; targetSiteId: string; projectRevision: string }) => Promise<CmsPublishPlan>;
  executePublishPlan: (input: { projectId: string; planId: string; projectRevision: string; expectedDestinationId?: string }) => Promise<Record<string, unknown>>;
  rollbackDeployment: (input: { projectId: string; buildId: string; deploymentId: string; expectedDestinationId?: string }) => Promise<Record<string, unknown>>;
  inspectDestination: (input: { projectId: string; destinationId: string }) => Promise<CmsDestinationInspection>;
  resolveDestination: (input: { projectId?: string; destinationId: string; databaseConnectionId?: string }) => Destination;
  listBuildDeployments: (projectId: string, buildId: string) => unknown[] | Promise<unknown[]>;
}

export interface CmsBuildLimits {
  maxRoutes: number;
  timeoutMs: number;
  /**
   * Time for the modern image variants (queue B6), on top of timeoutMs: past it the images not encoded yet keep only
   * their original, and the next build goes on from the cache. 0 makes no variant.
   */
  imageTimeoutMs?: number;
}

/** Time the image variants of a build may take (CmsBuildLimits.imageTimeoutMs), besides the build's own. */
export const CMS_IMAGE_VARIANTS_TIMEOUT_MS = 180_000;

export type CmsBuildBundle = typeof buildBundle;

class CmsBuildBudget {
  private routeCount = 0;
  private deadline: number;

  constructor(private readonly signal: AbortSignal, private readonly limits: CmsBuildLimits, startedAt = Date.now()) {
    this.deadline = startedAt + limits.timeoutMs;
  }

  check(): void {
    if (Date.now() >= this.deadline) {
      const seconds = Math.max(1, Math.ceil(this.limits.timeoutMs / 1000));
      throw new HistosPublishError(`La build ha superato il limite di ${seconds} secondi. Riduci il numero di pagine o riprova.`, "cms-build-timeout", 504);
    }
    if (this.signal.aborted) throw new HistosPublishError("La versione è stata annullata perché la richiesta è stata chiusa.", "cms-build-cancelled", 499);
  }

  /** The time a step with its own limit took (the image variants): not counted against the build's. */
  exclude(milliseconds: number): void {
    this.deadline += Math.max(0, milliseconds);
  }

  /** What is left of the build's time. */
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  addRoute(): void {
    this.check();
    if (this.routeCount >= this.limits.maxRoutes) {
      throw new HistosPublishError(`La build supera il limite di ${this.limits.maxRoutes.toLocaleString("it-IT")} pagine generate.`, "cms-build-route-limit", 422);
    }
    this.routeCount += 1;
  }
}

/**
 * The backup saved before an update (D2), from the app or the agent: one its restore accepts. encodeNativeProjectArchive
 * copies the database once, measures that copy and the media exactly and checks the limits before reading any media,
 * then builds the archive from the same copy, so the limits are those the update check reported. Over them (413
 * cms-backup-too-large), or with content a restore would refuse (422 cms-backup-unrestorable: a damaged media file, a
 * database the restore's checks refuse), the update does not start and no backup is saved: the older ones, which can
 * be restored, are not rotated out by one that cannot.
 */
export async function updateBackupArchive(existing: { project: unknown; store: CmsProjectStore }): Promise<Buffer> {
  const project = existing.project as Parameters<typeof encodeNativeProjectArchive>[0];
  try {
    return await encodeNativeProjectArchive(project, existing.store);
  } catch (error) {
    if (error instanceof RangeError) throw new HistosPublishError(`${error.message} Prima di aggiornare salvo un backup del progetto, e il backup supererebbe i suoi limiti: l'aggiornamento non è partito.`, "cms-backup-too-large", 413);
    if (error instanceof TypeError) throw new HistosPublishError(`${error.message} Prima di aggiornare salvo un backup del progetto, e questo backup non si potrebbe ripristinare: l'aggiornamento non è partito.`, "cms-backup-unrestorable", 422);
    throw error;
  }
}

function projectInfo(project: { id: string; name: string; createdAt: string; updatedAt: string; schemaVersion: number }) {
  return { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, schemaVersion: project.schemaVersion };
}

function missingExternalFrameworkCssFindings(content: string): Finding[] {
  const globals = stylesData(content).globals ?? [];
  return globals.flatMap((sheet): Finding[] => {
    const source = sheet.source;
    if (source?.kind !== "user-css" || sheet.css.trim()) return [];
    if (source.frameworkId === "core-framework") {
      return [{ code: "core-framework-css-missing", severity: "warn", file: "styles.css", message: "Il preset Core Framework è conservato, ma non è presente un foglio CSS. Histeon Publish genera CSS offline solo dai preset Core 1.1.0 supportati; questo preset può includere funzioni non supportate. Importa il CSS esportato da Core Framework prima di pubblicare." }];
    }
    if (source.frameworkId === "automatic-css") {
      return [{ code: "automatic-css-missing", severity: "warn", file: "styles.css", message: "La configurazione Automatic.css è conservata, ma non è stato importato il CSS generato. Aggiungi i fogli CSS esportati o generati da ACSS prima di pubblicare." }];
    }
    return [];
  });
}

function documentInfo(entity: CmsEntity, store: CmsProjectStore) {
  const revision = store.getHead(entity.id);
  if (!revision) throw new HistosPublishError("La revisione corrente della pagina non esiste.", "cms-revision-missing", 500);
  return {
    id: entity.alias,
    type: "page",
    title: entity.title,
    status: entity.status,
    content: revision.content,
    head: revision.id,
    base: revision.id,
    merged: 0,
    conflicts: [],
    published: false,
    link: false,
    // Doc 18 §6.6: Histeon Publish runs on the owner's computer, who may write a document's JavaScript as an
    // administrator can on WordPress (unfiltered_html). It runs only on the built site and in the sandboxed preview.
    script: store.getDocumentScript(entity.id),
    scriptEditable: true,
    ref: null,
    schema: null,
    templateRef: entity.templateRef,
  };
}

function postInfo(store: CmsProjectStore, post: CmsEntity) {
  return { ...post, url: postAddress(post, store.getRenderSettings().locale), terms: store.getPostTermIds(post.id) };
}

function componentDocumentInfo(component: CmsComponent, store: CmsProjectStore) {
  return {
    id: component.alias,
    type: "wp_block",
    title: component.title,
    status: "draft",
    content: component.content,
    head: component.headRevision,
    base: component.headRevision,
    merged: 0,
    conflicts: [],
    published: false,
    link: false,
    // WordPress keeps JavaScript for pages, posts and components only (`_xb_script`): parts and templates have none.
    script: component.kind === "component" ? store.getDocumentScript(component.id) : "",
    scriptEditable: component.kind === "component",
    ref: component.ref,
    schema: component.schema,
    documentKind: component.kind,
  };
}

/** The renderer's origin of a render's refusal (cmsRenderOrigin), kept for the refusal renderCmsSafely throws instead. */
const renderRefusalOrigins = new WeakMap<object, CmsRenderOrigin>();

/**
 * Where the render behind a build's error failed (CmsRenderOrigin: the content, or the template, part or component
 * whose blocks were rendering), when a render threw it; the prototype check places the refusal there (refusalDocument).
 */
function renderRefusalOrigin(error: unknown): CmsRenderOrigin | undefined {
  return (typeof error === "object" && error !== null ? renderRefusalOrigins.get(error) : undefined) ?? cmsRenderOrigin(error);
}

/**
 * A render whose refusal says where it happened when the build gives `where` (the address and the template): a
 * template serves many addresses, and the agent fixing it must know which one, and with which template, failed. The
 * refusal keeps the renderer's origin (renderRefusalOrigin), which the message does not say.
 */
/** The blocks the editor offers: the library, with what the project made of it, and the project's own `articolo/…` components. */
function articleCards(store: CmsProjectStore): Array<Omit<CardDefinition, "content"> & { own?: ReturnType<typeof customCardForm> }> {
  const own = store.listComponents().filter((item) => item.kind === "component" && item.ref.startsWith(ARTICLE_COMPONENT_PREFIX));
  const library = ARTICLE_LIBRARY.map(({ content: _content, ...entry }) => ({ ...entry, schema: own.find((item) => item.ref === entry.ref)?.schema ?? entry.schema }));
  return [...library, ...own.filter((item) => !ARTICLE_LIBRARY.some((entry) => entry.ref === item.ref)).map((item) => {
    const rows = own.find((other) => other.ref === `${item.ref}${ROW_SUFFIX}`);
    const row = item.ref.endsWith(ROW_SUFFIX) && own.some((other) => `${other.ref}${ROW_SUFFIX}` === item.ref);
    const definition = store.getEntityByAlias(item.alias);
    const source = (entry: typeof item): string => store.getRevision(store.getEntityByAlias(entry.alias)?.headRevision ?? "")?.content ?? "";
    return { ref: item.ref, title: item.title, schema: item.schema, areas: [], ...(rows ? { rows: rows.ref } : {}), ...(row ? { row: true } : {}), ...(definition ? { own: customCardForm(rows?.schema ?? item.schema, source(rows ?? item)) } : {}) };
  })];
}
export function cardRules(store: CmsProjectStore, ref: string): CardRules | null {
  const library = ARTICLE_LIBRARY.find((entry) => entry.ref === ref);
  const schema = store.getComponentByRef(ref)?.schema ?? library?.schema;
  const rows = library?.rows ?? (store.getComponentByRef(`${ref}${ROW_SUFFIX}`) ? `${ref}${ROW_SUFFIX}` : undefined);
  return schema ? { schema, ...(rows ? { rows } : {}) } : null;
}
/** A block of the library enters the project with its first use, with its rows; a definition the project has stays as it is. */
function installCard(store: CmsProjectStore, ref: string): boolean {
  const definition = ARTICLE_LIBRARY.find((entry) => entry.ref === ref);
  if (!definition) return false;
  const rows = definition.rows ? installCard(store, definition.rows) : false;
  if (store.getComponentByRef(ref)) return rows;
  store.createComponent({ ref, title: definition.title, content: definition.content, schema: definition.schema });
  return true;
}

/** The articles a build left out, and why: an article that cannot be rendered does not stop the site. A page still does. */
interface SkippedPages { count: number; keepGoing?: boolean; skipped: Array<{ address: string; title: string; message: string }> }
const MAX_SKIPPED_PAGES = 20;

/**
 * Whether a refusal only concerns this page. One that recurs is no page's fault (a template, a stylesheet): past a
 * limit, or with nothing else on the site, the build stops as it did and says why.
 */
function skipRefusedPage(stats: SkippedPages, address: string, title: string, error: unknown, written: number): boolean {
  if (!stats.keepGoing || !(error instanceof HistosPublishError) || error.code !== "cms-capability-unavailable") return false;
  stats.skipped.push({ address, title, message: error.message });
  return stats.skipped.length <= MAX_SKIPPED_PAGES || stats.skipped.length <= written;
}

async function renderCmsSafely(input: Parameters<typeof renderCmsPage>[0], where?: string): Promise<Awaited<ReturnType<typeof renderCmsPage>>> {
  try {
    return await renderCmsPage(input);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "cms-capability-unavailable") {
      const message = error instanceof Error ? error.message : "Il documento usa una funzione non supportata dal renderer CMS.";
      const refusal = new HistosPublishError(where ? `${where}: ${message}` : message, "cms-capability-unavailable", 422);
      const origin = cmsRenderOrigin(error);
      if (origin) renderRefusalOrigins.set(refusal, origin);
      throw refusal;
    }
    throw error;
  }
}

/** Where a build render happens, for its refusal: «/category/notizie/ (template site/categoria)». */
function renderPlace(address: string, templateRef?: string | null): string {
  return templateRef ? `${address} (template ${templateRef})` : address;
}

function checkedTypeTemplateRef(store: CmsProjectStore, value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !store.canUseTemplate(value)) {
    throw new HistosPublishError(`Il template ${label} non esiste nel progetto o non contiene lo slot predefinito.` , "cms-type-template-invalid", 400);
  }
  return value;
}

function requireProjectId(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new HistosPublishError("Identificativo progetto non valido.", "cms-project-invalid", 400);
  return value;
}

function requireAlias(value: string | undefined): number {
  const alias = Number(value);
  if (!Number.isSafeInteger(alias) || alias < 1) throw new HistosPublishError("Alias pagina non valido.", "cms-page-invalid", 400);
  return alias;
}

async function readBytes(request: IncomingMessage, limit: number, label = "La richiesta"): Promise<Uint8Array> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new HistosPublishError(`${label} supera il limite consentito.`, "request-too-large", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const item of request) {
    const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
    size += chunk.byteLength;
    if (size > limit) throw new HistosPublishError(`${label} supera il limite consentito.`, "request-too-large", 413);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** "galleria-2026-10-26.xbsite": the project name and the day, recognisable in a Downloads folder (queue E11). */
export function readableArchiveName(projectName: string, extension: string, suffix = ""): string {
  const slug = projectName.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60).replace(/-+$/u, "") || "progetto";
  const date = new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${slug}-${day}${suffix ? `-${suffix}` : ""}.${extension}`;
}

function sendArchive(response: ServerResponse, name: string, bytes: Buffer): void {
  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(bytes);
}

function sendJsonWithHeaders(response: ServerResponse, status: number, value: unknown, headers: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

function mediaItem(projectId: string, asset: ReturnType<CmsProjectStore["listAssets"]>[number]) {
  return {
    id: asset.alias,
    source_url: `/__cms-media/${projectId}/${asset.id}`,
    alt_text: asset.alt,
    title: { rendered: asset.filename },
    mime_type: asset.mimeType,
    media_details: {},
  };
}

function histosQueryData(store: CmsProjectStore) {
  const state = store.content.listQueryPresets();
  const presets = Object.fromEntries(state.presets.map((preset) => [preset.key, histosPreset(store, preset)]));
  return {
    presets,
    sources: store.content.listQuerySources(),
    types: store.content.listTypes().map((type) => ({ name: type.key, label: type.label })),
    head: state.head,
    base: state.head,
  };
}

function histosPreset(store: CmsProjectStore, preset: CmsQueryPreset) {
  const orderby = preset.orderBy === "publishedAt" ? "date" : preset.orderBy === "order" ? "menu_order" : preset.orderBy;
  const taxQuery = store.content.toHistosTaxQuery(preset.filter);
  const pureTaxFilter = taxQuery !== undefined;
  return {
    type: "posts",
    args: {
      post_type: preset.typeKey,
      xb_type_key: preset.typeKey,
      // As Histeon for WordPress writes them (builder 7ea451a): without a parameter of their own, a loop's `limit` and
      // `offset` still choose, over the number of the query.
      posts_per_page: `$${preset.limitParam ?? "limit"} ?? ${preset.limit}`,
      xb_limit: `$${preset.limitParam ?? "limit"} ?? ${preset.limit}`,
      offset: `$${preset.offsetParam ?? "offset"} ?? ${preset.offset}`,
      orderby,
      xb_order_by: orderby,
      order: preset.order.toUpperCase(),
      xb_label: preset.label,
      ...(preset.filter ? (pureTaxFilter ? { tax_query: taxQuery } : { xb_filter: JSON.stringify(preset.filter) }) : {}),
    },
  };
}

function queryPreviewRecords(store: CmsProjectStore, projectId: string, records: Array<CmsRecord & { url: string }>) {
  return records.map((record) => {
    const type = store.content.getType(record.typeKey);
    const fields: Array<{ path: string; kind: "text" | "url" | "image" | "date" | "number" | "list"; value: string }> = [
      { path: "title", kind: "text", value: record.title },
      { path: "excerpt", kind: "text", value: record.excerpt },
      { path: "date", kind: "date", value: record.publishedAt ?? "" },
    ];
    for (const definition of type?.fields ?? []) {
      if (!definition.public || !Object.hasOwn(record.values, definition.key)) continue;
      const raw = record.values[definition.key];
      const withMedia = (value: unknown): unknown => definition.type === "asset" && typeof value === "string" ? `/__cms-media/${projectId}/${value}` : value;
      const value = Array.isArray(raw) ? raw.map(withMedia) : withMedia(raw);
      const kind = definition.type === "asset" ? "image"
        : definition.type === "url" ? "url"
          : definition.type === "date" || definition.type === "datetime" ? "date"
            : definition.type === "integer" || definition.type === "decimal" ? "number"
              : definition.multiple || definition.type === "relation" ? "list" : "text";
      fields.push({ path: `meta.${definition.key}`, kind, value: typeof value === "string" ? value : JSON.stringify(value ?? "") });
    }
    return { title: record.title, url: record.url, fields };
  });
}

function escapeCmsHtml(value: unknown): string {
  return String(value ?? "").replace(/&(?!(?:[a-z][a-z0-9]+|#\d+|#x[\da-f]+);)/giu, "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function localeRoutePrefix(locale: string, defaultLocale: string): string {
  const canonical = Intl.getCanonicalLocales(locale)[0] ?? defaultLocale;
  return canonical.toLowerCase() === defaultLocale.toLowerCase() ? "" : "/" + canonical.toLowerCase();
}

function recordRoute(typeKey: string, record: Pick<CmsRecord, "slug" | "locale">, defaultLocale: string): string {
  return localeRoutePrefix(record.locale, defaultLocale) + "/" + typeKey + "/" + record.slug + "/";
}

/** The first template that fills one of these roles, in order (docs/spec/cms-bridge.md §12). */
function roleTemplateRef(store: CmsProjectStore, roles: readonly TemplateRole[]): string | null {
  for (const role of roles) {
    const template = store.getTemplateByRole(role);
    if (template && store.canUseTemplate(template.ref)) return template.ref;
  }
  return null;
}

/** The template a page or post renders with: WordPress hierarchy order, the home page's front-page role first. */
function documentTemplateRef(store: CmsProjectStore, document: CmsEntity): string | null {
  if (document.documentType === "post") return document.templateRef ?? roleTemplateRef(store, ["single", "index"]);
  if (document.slug === "home") return roleTemplateRef(store, ["front-page"]) ?? document.templateRef ?? roleTemplateRef(store, ["page", "index"]);
  return document.templateRef ?? roleTemplateRef(store, ["page", "index"]);
}

/** What a template sees as `page` for a post: its fields and its terms with their archive addresses. */
function postScope(store: CmsProjectStore, post: CmsEntity, defaultLocale: string): { id: string; title: string; slug: string; url: string; [key: string]: unknown } {
  const terms = Object.fromEntries(Object.entries(store.getPostTerms(post.id)).map(([taxonomyKey, assigned]) => [taxonomyKey, assigned.map((term) => ({ id: term.id, slug: term.slug, label: term.label, url: taxonomyTermRoute(store, taxonomyKey, term, post.locale ?? defaultLocale, defaultLocale) }))]));
  return { id: post.id, title: post.title, slug: post.slug, url: postAddress(post, defaultLocale), documentType: "post", excerpt: post.excerpt, publishedAt: post.publishedAt, image: postImageNode(post.imageAssetId, store, store.project.id), terms };
}

function documentScope(store: CmsProjectStore, document: CmsEntity, defaultLocale: string): { id: string; title: string; slug: string; url: string; [key: string]: unknown } {
  return { ...plainDocumentScope(store, document, defaultLocale), seo: store.getSeo(document.id) };
}

function plainDocumentScope(store: CmsProjectStore, document: CmsEntity, defaultLocale: string): { id: string; title: string; slug: string; url: string; [key: string]: unknown } {
  return document.documentType === "post" ? postScope(store, document, defaultLocale) : { id: document.id, title: document.title, slug: document.slug, url: pageAddress(document, defaultLocale) };
}

/** What a render gets of the languages: `data.lingua` of the page at `address`, if the project has others. */
function linguaOf(languages: SiteLanguages | undefined, address: string, locale: string): { lingua?: unknown } {
  const data = languages?.data(address, locale);
  return data ? { lingua: data } : {};
}

/**
 * A page or post as the build renders it, with its template and its `page` scope. Media are copied into
 * `buildMediaDirectory` when given, or addressed under `mediaBase` (the proposals page of queue A4 inlines them).
 */
export function renderCmsDocumentPage(input: { store: CmsProjectStore; projectId: string; document: CmsEntity; content: string; annotate?: boolean; mediaBase?: string; buildMediaDirectory?: string; requireFormEndpoints?: boolean; where?: string; languages?: SiteLanguages }): Promise<Awaited<ReturnType<typeof renderCmsPage>>> {
  const { store } = input;
  const templateRef = documentTemplateRef(store, input.document);
  return renderCmsSafely({
    ...(input.annotate ? { annotate: true } : {}),
    store,
    projectId: input.projectId,
    content: input.document.documentType === "post" ? postContentWithImage(input.content, input.document.imageAssetId, templateRef !== null, store, input.projectId) : input.content,
    mediaBase: input.mediaBase ?? "/__cms-media",
    ...(input.buildMediaDirectory ? { buildMediaDirectory: input.buildMediaDirectory } : {}),
    ...store.getRenderSettings(),
    ...(input.document.locale ? { locale: input.document.locale } : {}),
    ...(templateRef ? { templateRef } : {}),
    page: documentScope(store, input.document, store.getRenderSettings().locale),
    ...linguaOf(input.languages, documentAddress(input.document, store.getRenderSettings().locale), input.document.locale ?? store.getRenderSettings().locale),
    requireFormEndpoints: input.requireFormEndpoints === true,
  }, input.where);
}

/**
 * Doc 18 §6.6: the JavaScript a built page carries, each once and in WordPress's order (`Scripts::print_footer`): the
 * page's own, then every component it renders, its template's included (parts and templates have none there).
 */
export function documentScripts(store: CmsProjectStore, document: CmsEntity, content: string): string[] {
  const out: string[] = [];
  const add = (ownerId: string): void => {
    const code = store.getDocumentScript(ownerId);
    if (code.trim()) out.push(code);
  };
  add(document.id);
  const seen = new Set<string>();
  const pending: string[] = [];
  const templateRef = documentTemplateRef(store, document);
  const template = templateRef ? store.getComponentByRef(templateRef) : null;
  if (template) {
    seen.add(template.ref);
    pending.push(...componentCalls(template.content));
  }
  pending.push(...componentCalls(content));
  for (let ref = pending.shift(); ref !== undefined && seen.size < 2000; ref = pending.shift()) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const component = store.getComponentByRef(ref);
    if (!component) continue;
    if (component.kind === "component") add(component.id);
    pending.push(...componentCalls(component.content));
  }
  return out;
}

/**
 * A built page with its scripts, each a module after the content. Inside the element `</script` would end it and
 * `<!--` could bend how it is read: both are written with an escape JavaScript reads as the same text (`<\/script`,
 * `<\u0021--`), valid in strings, templates, regular expressions and comments, the only places a module can hold them.
 */
export function withDocumentScripts(html: string, documentOwn: readonly string[]): string {
  // Doc 23 item 120: a page with tabs, toggles, reveal, videos or maps gets Histeon's own behaviours, the script and
  // style WordPress serves (list item 84 had only the video player): the same markup works the same on both.
  const uses = pageUsesBehaviors(html);
  const scripts = uses ? [...documentOwn, BEHAVIORS_SCRIPT] : documentOwn;
  const head = html.indexOf("</head>");
  if (uses && head >= 0) html = `${html.slice(0, head)}<style>${BEHAVIORS_CSS}</style>${html.slice(head)}`;
  if (!scripts.length) return html;
  const tags = scripts.map((code) => `<script type="module">${code.replace(/<(\/script)/giu, "<\\$1").replace(/<!--/gu, "<\\u0021--")}</script>`).join("");
  const end = html.lastIndexOf("</body>");
  return end < 0 ? html + tags : `${html.slice(0, end)}${tags}${html.slice(end)}`;
}

/**
 * The conversion's part of an import report (doc 18 §9), as the app sends it: only known fields, bounded, as data.
 * Anything else is refused.
 */
function conversionReport(body: Record<string, unknown>): Record<string, unknown> {
  const invalid = () => new HistosPublishError("Il rapporto della conversione non è valido.", "cms-import-report-invalid", 400);
  const allowed = new Set(["file", "framework", "selectable", "notes", "structure"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw invalid();
  const notes = body.notes;
  if (!Array.isArray(notes) || notes.length > 500 || notes.some((note) => typeof note !== "string" || note.length > 400)) throw invalid();
  if (body.framework !== "histos-css" && body.framework !== "acss" && body.framework !== "core" && body.framework !== "none") throw invalid();
  if (body.file !== undefined && (typeof body.file !== "string" || body.file.length > 200)) throw invalid();
  const selectable = body.selectable as Record<string, unknown> | undefined;
  if (selectable !== undefined && (typeof selectable !== "object" || selectable === null || Object.keys(selectable).some((key) => !["original", "selectable", "share"].includes(key)) || !["original", "selectable"].every((key) => Number.isSafeInteger(selectable[key]) && (selectable[key] as number) >= 0) || typeof selectable.share !== "number" || !(selectable.share >= 0 && selectable.share <= 1.5))) throw invalid();
  const structure = body.structure as Record<string, unknown> | undefined;
  if (structure !== undefined && (typeof structure !== "object" || structure === null || Object.keys(structure).some((key) => !["parts", "components", "lists"].includes(key)) || Object.values(structure).some((value) => typeof value !== "boolean"))) throw invalid();
  return { at: new Date().toISOString(), framework: body.framework, notes, ...(body.file !== undefined ? { file: body.file } : {}), ...(selectable ? { selectable } : {}), ...(structure ? { structure } : {}) };
}

/** A term's archive address; `terms` (the taxonomy's, by id) spares reading them again for each term of a loop. */
function taxonomyTermRoute(store: CmsProjectStore, taxonomyKey: string, term: CmsTerm, locale: string, defaultLocale: string, terms?: ReadonlyMap<string, CmsTerm>): string {
  const byId = terms ?? new Map(store.content.listTerms(taxonomyKey).map((item) => [item.id, item]));
  const segments: string[] = [];
  let current: CmsTerm | undefined = term;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    segments.push(current.slug);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  // WordPress addresses tags as /tag/…; categories and other taxonomies keep their key.
  return localeRoutePrefix(locale, defaultLocale) + "/" + (taxonomyKey === "post_tag" ? "tag" : taxonomyKey) + "/" + segments.reverse().join("/") + "/";
}

function renderContentDocumentHead(title: string, locale: string, css: string, excerpt = ""): string {
  const safeCss = css.replace(/<\/style/giu, "<\\/style");
  // The same description as a page rendered with a template (renderCmsPage): the excerpt as text, cut at 160.
  const description = cmsMetaDescription(excerpt);
  const attribute = description.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return "<!doctype html><html lang=\"" + escapeCmsHtml(locale) + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>" + escapeCmsHtml(title) + "</title>" + (description ? "<meta name=\"description\" content=\"" + attribute + "\">" : "") + "<style>body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#20243a}main{max-width:72rem;margin:auto;padding:clamp(1.25rem,4vw,3rem)}article{max-width:52rem;margin:auto}img{max-width:100%;height:auto}dl{display:grid;gap:1rem}dt{font-weight:700}dd{margin:0}</style><style>" + safeCss + "</style></head>";
}

/**
 * The CSS of the build's pages without a template (renderCmsRecordDocument, renderCmsArchiveDocument): what
 * renderCmsPage inlines in every other page, read once and only when such a page is written. The Histeon CSS, the global
 * sheets and the selector styles, with each url() of a sheet or a style rewritten to the build's /media/… copy of its
 * asset, copied there, and a reference without its file refused, as on every page: compileCmsStyles' compiledCss left
 * them as written, a path relative to the page's own address, broken in the build. None without styles, as before
 * (pageCssLowerBound counts 0 then).
 */
function fallbackPageCss(input: { store: CmsProjectStore; projectId: string; mediaRoot: string; requireFormEndpoints: boolean }): () => Promise<string> {
  let css: Promise<string> | null = null;
  return () => {
    css ??= (async () => {
      const entity = input.store.getStyles();
      if (!entity || !input.store.getHead(entity.id)) return "";
      const rendered = await renderCmsSafely({ store: input.store, projectId: input.projectId, content: "", mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot, ...input.store.getRenderSettings(), requireFormEndpoints: input.requireFormEndpoints }, "Gli stili delle pagine senza template");
      return rendered.css;
    })();
    return css;
  };
}

async function renderCmsRecordDocument(input: {
  store: CmsProjectStore;
  projectId: string;
  typeKey: string;
  record: CmsRecord;
  mediaRoot: string;
  locale: string;
  defaultLocale: string;
  /** The CSS of a page without a template (fallbackPageCss), asked only when the record has none. */
  css: () => Promise<string>;
  requireFormEndpoints: boolean;
  formStats: SkippedPages;
  /**
   * The terms of each taxonomy by id, filled at the first record that links one and kept by the caller for the whole
   * build: a record's term addresses walk their parents in it, never reading the taxonomy again for each term of each
   * record.
   */
  termsByTaxonomy: Map<string, ReadonlyMap<string, CmsTerm>>;
  languages?: SiteLanguages;
}): Promise<string> {
  const type = input.store.content.getType(input.typeKey);
  if (!type) throw new HistosPublishError("Il tipo di contenuto della voce non esiste.", "cms-content-type-missing", 422);
  const termsOf = (taxonomyKey: string): ReadonlyMap<string, CmsTerm> => {
    let terms = input.termsByTaxonomy.get(taxonomyKey);
    if (!terms) {
      terms = new Map(input.store.content.listTerms(taxonomyKey).map((term) => [term.id, term]));
      input.termsByTaxonomy.set(taxonomyKey, terms);
    }
    return terms;
  };
  const termRoute = (taxonomyKey: string, term: CmsTerm): string => taxonomyTermRoute(input.store, taxonomyKey, term, input.record.locale, input.defaultLocale, termsOf(taxonomyKey));
  const singleTemplateRef = type.singleTemplateRef ?? roleTemplateRef(input.store, ["single", "index"]);
  if (singleTemplateRef) {
    const recordWithMedia = queryItemWithMedia(input.record, input.store, input.projectId) as CmsRecord;
    const availableFields = recordWithMedia.fields;
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of type.fields) {
      if (!field.public || !Object.hasOwn(availableFields, field.key)) continue;
      fields[field.key] = availableFields[field.key];
    }
    const page = {
      ...input.record,
      url: recordRoute(type.key, input.record, input.defaultLocale),
      fields,
      meta: fields,
      values: fields,
      terms: Object.fromEntries(Object.entries(input.record.terms).map(([taxonomyKey, terms]) => [taxonomyKey, terms.map((term) => ({ id: term.id, slug: term.slug, label: term.label, url: termRoute(taxonomyKey, term) }))])),
      // A product's `product` and main `image` (queue C6), as on WordPress.
      ...(Object.hasOwn(recordWithMedia, "product") ? { product: (recordWithMedia as unknown as Record<string, unknown>).product, image: (recordWithMedia as unknown as Record<string, unknown>).image } : {}),
    };
    const rendered = await renderCmsSafely({ store: input.store, projectId: input.projectId, content: "", mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot, templateRef: singleTemplateRef, page, ...input.store.getRenderSettings(), locale: input.locale, ...linguaOf(input.languages, page.url, input.locale), requireFormEndpoints: input.requireFormEndpoints }, renderPlace(page.url, singleTemplateRef));
    input.formStats.count += rendered.formCount;
    return rendered.html;
  }
  // The build's own words on a record page without a template, in the page's language (its lang, the record's).
  const words = fallbackPageWords(input.record.locale);
  const parts: string[] = [];
  for (const field of type.fields) {
    if (!field.public || !Object.hasOwn(input.record.values, field.key)) continue;
    const raw = input.record.values[field.key];
    const entries = Array.isArray(raw) ? raw : [raw];
    const rendered: string[] = [];
    for (const value of entries) {
      if (value === null || value === undefined || value === "") continue;
      if (field.type === "asset" && typeof value === "string") {
        const asset = await input.store.readAsset(value);
        if (!asset) throw new HistosPublishError("Una voce pubblicata usa un asset mancante.", "cms-content-asset-missing", 422);
        const extensions: Record<string, string> = { "image/avif": "avif", "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
        const extension = extensions[asset.metadata.mimeType];
        if (!extension) throw new HistosPublishError("Un asset della voce usa un formato immagine non supportato dalla versione.", "cms-content-asset-type-invalid", 422);
        const filename = asset.metadata.sha256 + "." + extension;
        await writeFile(path.join(input.mediaRoot, filename), asset.bytes, { mode: 0o600, flag: "wx" }).catch(async (error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        });
        rendered.push("<img src=\"/media/" + filename + "\" alt=\"" + escapeCmsHtml(asset.metadata.alt) + "\">");
      } else if (field.type === "relation" && value && typeof value === "object" && !Array.isArray(value)) {
        const related = value as { title?: unknown; slug?: unknown };
        if (typeof related.slug === "string" && typeof field.targetType === "string") {
          const locale = typeof (related as { locale?: unknown }).locale === "string" ? (related as { locale: string }).locale : input.record.locale;
          rendered.push("<a href=\"" + escapeCmsHtml(recordRoute(field.targetType, { slug: related.slug, locale }, input.defaultLocale)) + "\">" + escapeCmsHtml(related.title) + "</a>");
        }
      } else if (field.type === "url" && typeof value === "string") {
        rendered.push("<a href=\"" + escapeCmsHtml(value) + "\">" + escapeCmsHtml(value) + "</a>");
      } else if ((field.type === "date" || field.type === "datetime") && typeof value === "string") {
        rendered.push("<time datetime=\"" + escapeCmsHtml(value) + "\">" + escapeCmsHtml(value) + "</time>");
      } else if (field.type === "boolean" && typeof value === "boolean") rendered.push(value ? words.yes : words.no);
      else {
        const text = typeof value === "object" ? JSON.stringify(value) : String(value);
        rendered.push(field.type === "rich-text" ? escapeCmsHtml(text).replace(/\r?\n/gu, "<br>") : escapeCmsHtml(text));
      }
    }
    if (rendered.length) parts.push("<div><dt>" + escapeCmsHtml(field.label) + "</dt><dd>" + rendered.join(", ") + "</dd></div>");
  }
  const title = escapeCmsHtml(input.record.title);
  const published = input.record.publishedAt ? "<time datetime=\"" + escapeCmsHtml(input.record.publishedAt) + "\">" + escapeCmsHtml(input.record.publishedAt) + "</time>" : "";
  const excerpt = input.record.excerpt ? "<p>" + escapeCmsHtml(input.record.excerpt) + "</p>" : "";
  const fields = parts.length ? "<dl>" + parts.join("") + "</dl>" : "";
  const taxonomyLinks = Object.entries(input.record.terms).flatMap(([taxonomyKey, terms]) => terms.map((term) => "<a href=\"" + escapeCmsHtml(termRoute(taxonomyKey, term)) + "\">" + escapeCmsHtml(term.label) + "</a>"));
  const taxonomyMarkup = taxonomyLinks.length ? "<nav aria-label=\"" + words.terms + "\">" + taxonomyLinks.join(" ") + "</nav>" : "";
  return renderContentDocumentHead(input.record.title, input.record.locale, await input.css(), input.record.excerpt)
    + "<body><main><article><header><h1>" + title + "</h1>" + published + excerpt + "</header>" + fields + taxonomyMarkup + "</article></main></body></html>";
}

/**
 * The words of the build's own pages (an archive or a record without a template), in the page's language: Italian on
 * an Italian page, English on any other, as WordPress prints its own strings in English for a language it has no
 * translation of. A page in another language never gets Italian words.
 */
function fallbackPageWords(locale: string): { empty: string; pagination: string; yes: string; no: string; terms: string } {
  return /^it(?:-|$)/iu.test(locale)
    ? { empty: "Nessun contenuto.", pagination: "Paginazione", yes: "Sì", no: "No", terms: "Categorie" }
    : { empty: "Nothing found.", pagination: "Pagination", yes: "Yes", no: "No", terms: "Categories" };
}

function renderCmsArchiveDocument(input: { title: string; locale: string; css: string; records: CmsRecord[]; typeKey: string; defaultLocale: string; page: number; pageCount: number; archiveRoute?: string; recordUrl?: (record: CmsRecord) => string }): string {
  const pageSize = CMS_ARCHIVE_PAGE_SIZE;
  const words = fallbackPageWords(input.locale);
  const start = (input.page - 1) * pageSize;
  const entries = input.records.slice(start, start + pageSize).map((record) => {
    const excerpt = record.excerpt ? "<p>" + escapeCmsHtml(record.excerpt) + "</p>" : "";
    return "<li><article><h2><a href=\"" + escapeCmsHtml(input.recordUrl?.(record) ?? recordRoute(input.typeKey, record, input.defaultLocale)) + "\">" + escapeCmsHtml(record.title) + "</a></h2>" + excerpt + "</article></li>";
  }).join("");
  const links: string[] = [];
  for (let page = 1; page <= input.pageCount; page++) {
    const base = input.archiveRoute ?? (localeRoutePrefix(input.locale, input.defaultLocale) + "/" + input.typeKey + "/");
    const href = page === 1 ? base : base + "page/" + page + "/";
    links.push(page === input.page ? "<span aria-current=\"page\">" + page + "</span>" : "<a href=\"" + escapeCmsHtml(href) + "\">" + page + "</a>");
  }
  const pagination = input.pageCount > 1 ? "<nav aria-label=\"" + words.pagination + "\">" + links.join(" ") + "</nav>" : "";
  // An empty archive is still a page, as on WordPress: it says so rather than showing an empty list.
  const list = entries ? "<ul>" + entries + "</ul>" : "<p>" + words.empty + "</p>";
  return renderContentDocumentHead(input.title, input.locale, input.css)
    + "<body><main><header><h1>" + escapeCmsHtml(input.title) + "</h1></header>" + list + pagination + "</main></body></html>";
}

/**
 * The index.html of a route inside the build staging root. Slugs and routes come from the project store, which a
 * restored backup can fill: separators other than "/", dot segments and anything that resolves outside the root
 * are refused on every platform.
 */
export function cmsBuildOutputPath(staticRoot: string, relative: string): string {
  const segments = relative.replace(/\/+$/u, "").split("/");
  if (!relative || relative.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\0:]/u.test(segment))) {
    throw new HistosPublishError("Un percorso CMS generato non è valido.", "cms-build-route-invalid", 500);
  }
  const root = path.resolve(staticRoot);
  const outputPath = path.resolve(root, ...segments, "index.html");
  const inside = path.relative(root, outputPath);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new HistosPublishError("Un percorso CMS generato non è valido.", "cms-build-route-invalid", 500);
  return outputPath;
}

/** A route as the plan keys it: its address without the slashes and in lower case ("" is "/"), as a case-insensitive disk sees it. */
function routeKey(address: string): string {
  return address.replace(/^\/+|\/+$/gu, "").toLowerCase();
}

/** The language of an owner outside the site's own, for a message: « (en-US)». */
function localeNote(locale: string, defaultLocale: string): string {
  return locale.toLowerCase() === defaultLocale.toLowerCase() ? "" : ` (${locale})`;
}

/** The address of page `page` of the archive at `address`: /opera/, /opera/page/2/… */
const archivePageAddress = cmsArchivePageAddress;

/** Whether `locale` is the site's own language. */
function siteLanguage(locale: string, defaultLocale: string): boolean {
  return locale.toLowerCase() === defaultLocale.toLowerCase();
}

/**
 * The languages an archive may be written in: the site's own always (WordPress serves an empty archive too, so a menu
 * link to it never ends on a 404, and its template's empty case renders), and each one its types have published records
 * in. In those other languages an archive is written only with contents of its own (cmsArchiveWritten).
 */
function archiveLocales(store: CmsProjectStore, typeKeys: readonly string[], defaultLocale: string, posts = false): string[] {
  const locales = new Map<string, string>([[defaultLocale.toLowerCase(), defaultLocale]]);
  for (const typeKey of typeKeys) {
    for (const locale of store.content.listRecordLocales(typeKey)) if (!locales.has(locale.toLowerCase())) locales.set(locale.toLowerCase(), locale);
  }
  if (posts) for (const locale of store.content.listPostLocales()) if (!locales.has(locale.toLowerCase())) locales.set(locale.toLowerCase(), locale);
  return [...locales.values()];
}

/**
 * The project's other languages this build writes (doc 20 §5.4): those with a page, post or record in it. Each has its
 * home from the front-page role and its 404, as the site's language does; a project with one language has none, and a
 * record in a language the project does not list keeps only its own pages, as before.
 */
function builtLanguages(store: CmsProjectStore, pages: ReadonlyArray<{ locale?: string | null }>, posts: ReadonlyArray<{ locale?: string | null }>): string[] {
  const listed = store.getProjectLanguages().languages;
  if (!listed.length) return [];
  const present = new Set([...pages, ...posts].flatMap((document) => (document.locale ? [document.locale.toLowerCase()] : [])));
  for (const type of store.content.listTypes()) for (const locale of store.content.listRecordLocales(type.key)) present.add(locale.toLowerCase());
  return listed.map((language) => language.code).filter((code) => present.has(code.toLowerCase()));
}

/** A taxonomy whose terms have archives: attached to a type of the project, or to posts. */
interface ArchivedTaxonomy {
  key: string;
  attachedTypes: string[];
  includesPosts: boolean;
}

/** The taxonomies whose terms have archives: attached to a type of the project, or to posts. */
function archivedTaxonomies(store: CmsProjectStore): ArchivedTaxonomy[] {
  const typeKeys = new Set(store.content.listTypes().map((type) => type.key));
  return store.content.listTaxonomies().flatMap((taxonomy) => {
    const attachedTypes = taxonomy.types.filter((key) => typeKeys.has(key));
    const includesPosts = taxonomy.types.includes("post");
    return attachedTypes.length || includesPosts ? [{ key: taxonomy.key, attachedTypes, includesPosts }] : [];
  });
}

/**
 * Which terms of a taxonomy the published contents of one language are filed under, as the plan and the writer both
 * read them: the records of its types and the published posts in `locale`.
 */
function termAssignments(store: CmsProjectStore, taxonomy: ArchivedTaxonomy, locale: string): Array<{ contentId: string; termId: string; post: boolean }> {
  return store.content.listPublishedTermAssignments(taxonomy.key, { typeKeys: taxonomy.attachedTypes, locale, posts: taxonomy.includesPosts });
}

/**
 * The contents of each term's archive in one language, term by term, as the plan counts them and the writer lists
 * them: the contents filed under the term and, in a hierarchical taxonomy (cmsTermArchiveIncludesChildren), under any
 * of its descendants, each once. Every term is visited once, children before their parent, with the ids of its
 * contents; that set then grows into the parent's, so the caller reads it before asking for the next term. Smaller sets
 * merge into larger ones, so a deep hierarchy costs no more than a flat one (n log n in the assignments, never the
 * terms times their depth), and the walk keeps its own stack, so a chain of thousands of terms is no recursion. A
 * parent cycle, which the store refuses but a damaged project could hold, is cut where the walk meets it.
 */
function* termArchiveContents(terms: readonly CmsTerm[], assignments: ReadonlyArray<{ contentId: string; termId: string }>, hierarchical: boolean): Generator<{ term: CmsTerm; ids: ReadonlySet<string> }> {
  const byId = new Map(terms.map((term) => [term.id, term]));
  const own = new Map<string, Set<string>>();
  for (const pair of assignments) {
    if (!byId.has(pair.termId)) continue;
    const set = own.get(pair.termId);
    if (set) set.add(pair.contentId);
    else own.set(pair.termId, new Set([pair.contentId]));
  }
  const children = new Map<string, CmsTerm[]>();
  const roots: CmsTerm[] = [];
  for (const term of terms) {
    const parent = hierarchical && term.parentId !== null && term.parentId !== term.id ? byId.get(term.parentId) : undefined;
    if (!parent) {
      roots.push(term);
      continue;
    }
    const list = children.get(parent.id);
    if (list) list.push(term);
    else children.set(parent.id, [term]);
  }
  const visited = new Set<string>();
  const sets = new Map<string, Set<string>>();
  // The roots in the store's order, then any term only a cycle leads to, cut there.
  for (const start of [...roots, ...terms]) {
    if (visited.has(start.id)) continue;
    visited.add(start.id);
    sets.set(start.id, own.get(start.id) ?? new Set());
    const stack = [{ term: start, kids: children.get(start.id) ?? [], next: 0 }];
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const kid = top.kids[top.next++];
      if (kid !== undefined) {
        if (!visited.has(kid.id)) {
          visited.add(kid.id);
          sets.set(kid.id, own.get(kid.id) ?? new Set());
          stack.push({ term: kid, kids: children.get(kid.id) ?? [], next: 0 });
        }
        continue;
      }
      stack.pop();
      const ids = sets.get(top.term.id) ?? new Set<string>();
      sets.delete(top.term.id);
      yield { term: top.term, ids };
      const parent = stack.at(-1);
      if (!parent) continue;
      const into = sets.get(parent.term.id) ?? new Set<string>();
      const [large, small] = ids.size > into.size ? [ids, into] : [into, ids];
      for (const id of small) large.add(id);
      sets.set(parent.term.id, large);
    }
  }
}

/**
 * Whether the build writes the posts index /blog/ (cmsPostsIndexWritten): the project has a post, a draft too, and no
 * page of the build takes /blog/. A template with the home role alone makes none. Without published posts it is the
 * empty list, as on WordPress.
 */
function postsIndexWanted(store: CmsProjectStore, pages: ReadonlyArray<{ slug: string; locale?: string | null }>): boolean {
  return cmsPostsIndexWritten({ posts: store.listPosts().filter((post) => post.locale === null).length, blogPage: pages.some((page) => page.slug === "blog" && !page.locale) });
}

/** The posts indexes of a build: the site's (postsIndexWanted) and, in another language, one with published posts and no page at its address. */
function postsIndexLanguages(store: CmsProjectStore, pages: ReadonlyArray<{ slug: string; locale?: string | null }>, defaultLocale: string): string[] {
  const others = store.content.listPostLocales().filter((locale) => !pages.some((page) => page.slug === "blog" && page.locale?.toLowerCase() === locale.toLowerCase()));
  return [...(postsIndexWanted(store, pages) ? [defaultLocale] : []), ...others];
}

/** The order of every archive and of its main() loop, as WordPress's main query: newest first, then by title. */
function archiveOrder(left: CmsRecord, right: CmsRecord): number {
  return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

/**
 * What `{#loop main() as item}` lists on page `page` of an archive (the builder's main query, $wp_query->posts): its
 * records of that page, CMS_ARCHIVE_PAGE_SIZE at most as WordPress's default posts_per_page, each a query item with its
 * address, the same shape a query preset's loop gives.
 */
function mainPage(records: readonly CmsRecord[], page: number, defaultLocale: string): Array<CmsRecord & { url: string }> {
  const start = (page - 1) * CMS_ARCHIVE_PAGE_SIZE;
  return records.slice(start, start + CMS_ARCHIVE_PAGE_SIZE).map((record) => ({ ...record, url: record.typeKey === "post" ? postAddress(record, defaultLocale) : recordRoute(record.typeKey, record, defaultLocale) }));
}

/** An address two contents of the site would both take, with the two, as the build and the prototype check name them. */
export interface CmsRouteCollision {
  address: string;
  first: string;
  second: string;
}

/** The routes a static build writes, planned before it writes any (planCmsRoutes). */
export interface CmsRoutePlan {
  /** Route key (routeKey) → what owns it. Past `maxRoutes` routes are only counted: such a build stops anyway. */
  routes: Map<string, string>;
  /** Every route the build would write. */
  count: number;
  /** The first CMS_ROUTE_COLLISIONS_KEPT collisions, in the build's order; `collisionCount` counts them all. */
  collisions: CmsRouteCollision[];
  collisionCount: number;
  /** Of `count`, the pages of records and posts, and the pages of `archives` archives: what a plan too large is made of. */
  contentPages: number;
  archivePages: number;
  archives: number;
  /** The archive with the most pages, as the messages name it (with its descendants' contents for a term). */
  largestArchive: { name: string; total: number; pages: number } | null;
  /** Bytes of CSS every route's page carries at least (pageCssLowerBound): the bundle holds count times as many. */
  pageCssBytes: number;
}

/**
 * Bytes of CSS that every page of a static build carries in its <style> at least, read from the project's styles: the
 * Histeon CSS (tokens, utilities, the design and its token overrides) and each global sheet less its url() and @import
 * references, which the renderer rewrites into /media/… addresses of any length. Every route is such a page:
 * renderCmsPage (pages, posts, the 404, and records and archives with a template) inlines all of it, and a record or an
 * archive without a template the same CSS (fallbackPageCss). The selector styles, the separators and the escapes only add to it and are left out, so the bound is never above
 * what the build writes, whatever the content. 0 when the project has no styles (a page without a template then carries
 * none) or they do not read (the build says why on its own).
 */
function pageCssLowerBound(store: CmsProjectStore): number {
  try {
    const entity = store.getStyles();
    const revision = entity ? store.getHead(entity.id) : null;
    if (!revision) return 0;
    const data = stylesData(revision.content);
    let bytes = Buffer.byteLength(histosGlobalCss({ articleBlocks: false, design: validateHistosDesign(data.design ?? {}), tokenOverrides: data.tokenOverrides ?? {}, siteTokens: data.siteTokens ?? {}, globals: [] }));
    for (const sheet of data.globals ?? []) {
      let sheetBytes = Buffer.byteLength(sheet.css);
      for (const reference of cssResourceReferences(sheet.css)) sheetBytes -= Buffer.byteLength(sheet.css.slice(reference.start, reference.end));
      bytes += Math.max(0, sheetBytes);
    }
    return bytes;
  } catch {
    return 0;
  }
}

/**
 * Every route a static build of the project writes, with what owns it, planned before anything is written: the pages,
 * the home of the front-page role and the 404, the posts and their index, the records, and every page of every archive
 * (a type's, a term's with its descendants' contents, CMS_ARCHIVE_PAGE_SIZE a page; an empty one in the site's language
 * only, another language's once it has a content: cmsArchiveWritten). The writers follow the same rules and the same
 * walk of the terms (termArchiveContents), so the count is the routes the build writes, to the one. The build refuses
 * the plan's problems before writing (assertCmsRoutePlan) and writes only planned routes; the prototype check lists the
 * same problems as issues (cmsRoutePlanProblems). So two contents that would share an address (a type keyed "tag" with a record named like a
 * tag, a taxonomy keyed "blog" with a term named like a post) are said by name, never as a raw EEXIST from the disk;
 * and a site whose bundle would certainly be over its limits (bundleLimitMessage: a file per route, and in each the CSS
 * every page inlines) is refused before a page is rendered, never after writing them all. The archives' record limits
 * are those of the writers (CMS_ARCHIVE_MAX_RECORDS). `check` runs between reads (a build's budget, a check's
 * cancellation).
 */
export function planCmsRoutes(store: CmsProjectStore, input: { pages: ReadonlyArray<{ slug: string; locale?: string | null }>; posts: ReadonlyArray<{ slug: string; locale?: string | null }>; maxRoutes: number; check?: () => void }): CmsRoutePlan {
  const defaultLocale = store.getRenderSettings().locale;
  const check = input.check ?? (() => undefined);
  const plan: CmsRoutePlan = { routes: new Map(), count: 0, collisions: [], collisionCount: 0, contentPages: 0, archivePages: 0, archives: 0, largestArchive: null, pageCssBytes: pageCssLowerBound(store) };
  const add = (address: string, owner: string): void => {
    plan.count += 1;
    const key = routeKey(address);
    const first = plan.routes.get(key);
    if (first !== undefined) {
      plan.collisionCount += 1;
      if (plan.collisions.length < CMS_ROUTE_COLLISIONS_KEPT) plan.collisions.push({ address, first, second: owner });
    } else if (plan.routes.size <= input.maxRoutes) plan.routes.set(key, owner);
  };
  /** Every page of an archive; `name` without its article, «archivio del tipo opera»; `whole` adds what it holds. */
  const archive = (address: string, total: number, name: string, whole = ""): void => {
    const pages = cmsArchivePageCount(total);
    for (let page = 1; page <= pages; page++) add(archivePageAddress(address, page), page === 1 ? `l'${name}` : `la pagina ${page} dell'${name}`);
    plan.archivePages += pages;
    plan.archives += 1;
    if (!plan.largestArchive || pages > plan.largestArchive.pages) plan.largestArchive = { name: `l'${name}${whole}`, total, pages };
  };
  // The pages of the site's language: a page with a type's address takes the place of its archive there.
  const pageSlugs = new Set(input.pages.filter((page) => !page.locale).map((page) => page.slug));
  for (const page of input.pages) add(pageAddress(page, defaultLocale), `la pagina «${page.slug}»${page.locale ? ` (${page.locale})` : ""}`);
  const frontPage = roleTemplateRef(store, ["front-page"]);
  const notFound = roleTemplateRef(store, ["404"]);
  if (!pageSlugs.has("home") && frontPage) add("/", "la home del modello con ruolo front-page");
  if (notFound) add("/404.html", "la pagina 404");
  for (const language of builtLanguages(store, input.pages, input.posts)) {
    const prefix = localeRoutePrefix(language, defaultLocale);
    if (frontPage && !input.pages.some((page) => page.slug === "home" && page.locale?.toLowerCase() === language.toLowerCase())) add(`${prefix}/`, `la home del template con ruolo front-page (${language})`);
    if (notFound) add(`${prefix}/404.html`, `la pagina 404 (${language})`);
  }
  for (const post of input.posts) add(postAddress(post, defaultLocale), `l'articolo «${post.slug}»${post.locale ? ` (${post.locale})` : ""}`);
  plan.contentPages += input.posts.length;
  for (const locale of postsIndexLanguages(store, input.pages, defaultLocale)) {
    const total = store.content.listRecords({ typeKey: "post", status: "published", locale, limit: 1 }).total;
    if (total > CMS_ARCHIVE_MAX_RECORDS) throw new HistosPublishError("Il progetto supera il limite di 10.000 articoli per versione statica.", "cms-build-content-limit", 422);
    archive(`${localeRoutePrefix(locale, defaultLocale)}/blog/`, total, `elenco degli articoli${localeNote(locale, defaultLocale)}`);
  }
  for (const type of store.content.listTypes()) {
    check();
    // Doc 23 item 122: a type without pages of its own has no record pages and no archive.
    if (!type.public) continue;
    const totals = new Map<string, number>();
    for (const locale of store.content.listRecordLocales(type.key)) {
      let offset = 0;
      let total = 0;
      do {
        check();
        const batch = store.content.listRecords({ typeKey: type.key, locale, status: "published", limit: 100, offset });
        total = batch.total;
        for (const record of batch.items) add(recordRoute(type.key, record, defaultLocale), `il record «${record.slug}» del tipo ${type.key}${localeNote(locale, defaultLocale)}`);
        plan.contentPages += batch.items.length;
        offset += batch.items.length;
        if (offset > CMS_ARCHIVE_MAX_RECORDS) throw new HistosPublishError("Il progetto supera il limite di 10.000 voci per versione statica.", "cms-build-content-limit", 422);
      } while (offset < total && offset > 0);
      totals.set(locale.toLowerCase(), total);
    }
    for (const locale of archiveLocales(store, [type.key], defaultLocale)) {
      // A page with the type's address takes the place of its archive (cms-bridge.md §12).
      if (siteLanguage(locale, defaultLocale) && pageSlugs.has(type.key)) continue;
      const total = totals.get(locale.toLowerCase()) ?? 0;
      if (!cmsArchiveWritten(total, siteLanguage(locale, defaultLocale))) continue;
      archive(`${localeRoutePrefix(locale, defaultLocale)}/${type.key}/`, total, `archivio del tipo ${type.key}${localeNote(locale, defaultLocale)}`);
    }
  }
  for (const taxonomy of archivedTaxonomies(store)) {
    check();
    const terms = store.content.listTerms(taxonomy.key);
    const byId = new Map(terms.map((term) => [term.id, term]));
    const hierarchical = cmsTermArchiveIncludesChildren(taxonomy.key);
    // The terms with a child: their archives list their descendants' contents too, which a message says.
    const parents = new Set(hierarchical ? terms.flatMap((term) => (term.parentId && term.parentId !== term.id ? [term.parentId] : [])) : []);
    for (const locale of archiveLocales(store, taxonomy.attachedTypes, defaultLocale, taxonomy.includesPosts)) {
      check();
      const inSiteLanguage = siteLanguage(locale, defaultLocale);
      // The writer walks the same contents (termArchiveContents) and writes exactly these pages, ten contents a page
      // however many the term and its descendants hold (CMS_ARCHIVE_MAX_RECORDS).
      for (const { term, ids } of termArchiveContents(terms, termAssignments(store, taxonomy, locale), hierarchical)) {
        check();
        if (!cmsArchiveWritten(ids.size, inSiteLanguage)) continue;
        archive(taxonomyTermRoute(store, taxonomy.key, term, locale, defaultLocale, byId), ids.size, `archivio del termine «${term.slug}» (${taxonomy.key})${localeNote(locale, defaultLocale)}`, parents.has(term.id) ? ", con i contenuti dei suoi sottotermini" : "");
      }
    }
  }
  return plan;
}

function routeCollisionMessage(collision: CmsRouteCollision): string {
  return `Due contenuti avrebbero lo stesso indirizzo ${collision.address}: ${collision.first} e ${collision.second}. Cambia lo slug di uno dei due, o la chiave del tipo o della tassonomia.`;
}

/**
 * What a plan too large is made of, for its messages: the parts of its pages (records and posts, archives, the rest;
 * none of a part left out), the archive with the most pages and what it holds when it has more than one, and how to have
 * fewer pages.
 */
function planSizeWords(plan: CmsRoutePlan): { parts: string; largest: string; fewer: string } {
  const number = (value: number) => value.toLocaleString("it-IT");
  const others = plan.count - plan.contentPages - plan.archivePages;
  const parts = [
    ...(plan.contentPages ? [`${number(plan.contentPages)} di record e articoli`] : []),
    ...(plan.archives ? [`${number(plan.archivePages)} di ${plan.archives === 1 ? "un archivio" : `${number(plan.archives)} archivi`}`] : []),
    ...(others ? [others === 1 ? "un'altra" : `${number(others)} altre`] : []),
  ].join(", ");
  const largest = plan.largestArchive && plan.largestArchive.pages > 1 ? ` Fra gli archivi, il più lungo è ${plan.largestArchive.name}: ${number(plan.largestArchive.total)} contenuti, ${number(plan.largestArchive.pages)} pagine.` : "";
  const fewer = `meno record, termini o lingue: ogni archivio ha una pagina ogni ${CMS_ARCHIVE_PAGE_SIZE} contenuti, in ogni lingua, e quello di un termine conta anche i contenuti dei suoi sottotermini`;
  return { parts, largest, fewer };
}

/** Over the route limit: how many pages, of what, the longest archive (a term's with its descendants), what to do. */
function routeLimitMessage(plan: CmsRoutePlan, maxRoutes: number): string {
  const { parts, largest, fewer } = planSizeWords(plan);
  return `La build supera il limite di ${maxRoutes.toLocaleString("it-IT")} pagine generate: il sito ne avrebbe ${plan.count.toLocaleString("it-IT")}, contando pagine, articoli, record e ogni pagina di ogni archivio (${CMS_ARCHIVE_PAGE_SIZE} contenuti l'una, in ogni lingua che ne ha; vuoti solo nella lingua del sito)${parts ? `: ${parts}` : ""}.${largest} Riduci le pagine (${fewer}).`;
}

/**
 * Why the bundle of a planned build would certainly refuse it, or null: what the plan knows for sure before a page is
 * rendered. Every route is one file, which the bundle reads (no address has a dot in a segment, so none is a file it
 * skips), and DEFAULT_MAX_FILES are the most it reads; each file is a page that carries plan.pageCssBytes of CSS at
 * least, so count × pageCssBytes is below what the build writes, and past CMS_BUNDLE_MAX_BYTES the bundle stops with
 * source-too-large once every page is written. A site under both may still be too large (media, page bodies): only the
 * build tells, and nothing here refuses a site that would build.
 */
function bundleLimitMessage(plan: CmsRoutePlan): string | null {
  const number = (value: number) => value.toLocaleString("it-IT");
  const { parts, largest, fewer } = planSizeWords(plan);
  const pages = `${number(plan.count)} pagine (${parts})`;
  const bytes = plan.count * plan.pageCssBytes;
  if (bytes > CMS_BUNDLE_MAX_BYTES) {
    return `Il sito non entra nel pacchetto della build: ${pages}, e ognuna contiene almeno ${number(Math.floor(plan.pageCssBytes / 1024))} KiB di CSS (quello di Histeon e dei fogli globali), cioè almeno ${number(Math.floor(bytes / 1024 / 1024))} MiB, oltre i ${CMS_BUNDLE_MAX_BYTES / 1024 / 1024} MiB del pacchetto: la build si fermerebbe dopo aver scritto tutte le pagine.${largest} Riduci le pagine (${fewer}) o alleggerisci i fogli CSS globali.`;
  }
  if (plan.count > DEFAULT_MAX_FILES) {
    return `Il sito non entra nel pacchetto della build: ${pages}, un file l'una, e il pacchetto ne prende al massimo ${number(DEFAULT_MAX_FILES)}: la build si fermerebbe dopo aver scritto tutte le pagine.${largest} Riduci le pagine (${fewer}).`;
  }
  return null;
}

/**
 * The plan's problems, one message each, as the prototype check lists them: the routes over the limit or, under it, a
 * bundle the build would certainly be refused (bundleLimitMessage), then each collision kept. `total` counts the
 * collisions past those kept too.
 */
export function cmsRoutePlanProblems(plan: CmsRoutePlan, maxRoutes: number): { messages: string[]; total: number } {
  const size = plan.count > maxRoutes ? routeLimitMessage(plan, maxRoutes) : bundleLimitMessage(plan);
  const messages = [...(size ? [size] : []), ...plan.collisions.map(routeCollisionMessage)];
  return { messages, total: messages.length + plan.collisionCount - plan.collisions.length };
}

/**
 * The build's refusal of a plan, before anything is written: over the route limit, a bundle it would certainly be
 * refused, or two contents on one address.
 */
function assertCmsRoutePlan(plan: CmsRoutePlan, maxRoutes: number): void {
  if (plan.count > maxRoutes) throw new HistosPublishError(routeLimitMessage(plan, maxRoutes), "cms-build-route-limit", 422);
  const bundle = bundleLimitMessage(plan);
  if (bundle) throw new HistosPublishError(bundle, "cms-build-size-limit", 422);
  const first = plan.collisions[0];
  if (first) throw new HistosPublishError(`${routeCollisionMessage(first)}${plan.collisionCount > 1 ? ` Non è l'unico: altri ${plan.collisionCount - 1} indirizzi sono contesi.` : ""}`, "cms-build-route-collision", 422);
}

/** A page with its `hreflang` links, before its first </head>: no text before it can hold that (renderCmsPage escapes them). */
function withLanguageLinks(page: string, languages: SiteLanguages | undefined, address: string): string {
  const links = languages?.headLinksOf(address);
  if (!links) return page;
  const end = page.indexOf("</head>");
  return end < 0 ? page : page.slice(0, end) + links + page.slice(end);
}

/** The build's languages (doc 20 §5.5): published pages, posts and records, each with its original, and the plan's routes. */
function buildSiteLanguages(store: CmsProjectStore, routes: Iterable<string>, pages: readonly CmsEntity[], posts: readonly CmsEntity[]): SiteLanguages {
  const languages = store.getProjectLanguages();
  const defaultLocale = languages.defaultLanguage.code;
  const built = new Map([...pages, ...posts].map((document) => [document.id, document]));
  const contents: SiteLanguageContent[] = [];
  const add = (group: string, id: string): void => {
    const document = built.get(id);
    if (document) {
      contents.push({ group, language: document.locale ?? defaultLocale, address: documentAddress(document, defaultLocale) });
      return;
    }
    const record = store.getEntityById(id) ? null : store.content.getRecordById(id);
    if (record?.status === "published") contents.push({ group, language: record.locale, address: recordRoute(record.typeKey, record, defaultLocale) });
  };
  const links = languages.languages.length ? store.listTranslations() : [];
  for (const source of new Set(links.map((link) => link.sourceId))) add(source, source);
  for (const link of links) add(link.sourceId, link.translationId);
  return new SiteLanguages({ languages, contents, routes, siteUrl: store.getSiteUrl(), strings: (language) => store.publishedStrings(language) });
}

/** The languages the canvas shows: every version, drafts too, so the switcher works while a translation is written. */
function canvasLanguages(store: CmsProjectStore): SiteLanguages | undefined {
  if (!store.getProjectLanguages().languages.length) return undefined;
  const pages = store.listPages();
  const posts = store.listPosts();
  const defaultLocale = store.getRenderSettings().locale;
  return buildSiteLanguages(store, [...pages, ...posts].map((document) => documentAddress(document, defaultLocale).replace(/^\/+|\/+$/gu, "").toLowerCase()), pages, posts);
}

/**
 * The builder's language bar (docs/spec/multilingual.md): each language of a page or post with its state, a link to the
 * version in the builder, or to the administration's Lingue to create it; `source`, the original's texts for the
 * untranslated check. Null with one language, or for what has no languages.
 */
function builderLanguages(store: CmsProjectStore, projectId: string, entity: CmsEntity): Record<string, unknown> | null {
  const { defaultLanguage, languages } = store.getProjectLanguages();
  if (!languages.length) return null;
  const own = store.getTranslation(entity.id);
  const sourceId = own?.sourceId ?? entity.id;
  const links = store.listTranslations(sourceId);
  const current = entity.locale ?? defaultLanguage.code;
  const editor = (alias: number) => `/cms-editor.html?project=${encodeURIComponent(projectId)}&document=${alias}`;
  const original = store.getEntityById(sourceId);
  const items = [defaultLanguage, ...languages].map((language) => {
    const id = language.code === defaultLanguage.code ? sourceId : links.find((link) => link.language === language.code)?.translationId;
    const version = id ? store.getEntityById(id) : null;
    if (language.code === current) return { code: language.code, label: language.label, state: "current", url: "" };
    if (!version) return { code: language.code, label: language.label, state: "missing", url: `/#/cms/${projectId}/amministra/lingue` };
    return { code: language.code, label: language.label, state: version.status === "published" ? "publish" : "draft", url: editor(version.alias) };
  });
  const source = own && original ? documentSegments(store.getHead(original.id)?.content ?? "").map((segment) => segment.text.slice(0, 300)).slice(0, 300) : [];
  return { current, items, source };
}

/** The versions whose browser check is running (V1.3): one at a time for each. */
const browserChecksRunning = new Set<string>();
/** V1.6: the connections whose «Verifica nel browser» is running, one at a time each. */
const remoteBrowserChecksRunning = new Set<string>();

/** «Uguale alla proposta»: the projects whose comparison is running, one at a time each, and why the last one failed. */
const proposalComparesRunning = new Set<string>();
const proposalCompareFailures = new Map<string, string>();
/** Conversion, build and photographs of every page: past this the comparison is given up. */
const PROPOSAL_COMPARE_TIMEOUT_MS = 15 * 60_000;

/** What the conversion «senza» did not download, as one note of the comparison: the first three, cut to fit. */
export function proposalMissingNote(missing: readonly string[]): string {
  const said = missing.slice(0, 3).map((note) => note.replace(/\s+/gu, " ").slice(0, 80).trim()).join("; ");
  return `La versione «senza» non ha scaricato tutto, e il suo numero può essere più alto per questo: ${said}${missing.length > 3 ? `; e altre ${missing.length - 3}` : ""}. Rifai il confronto per riprovare.`;
}

/**
 * «Uguale alla proposta»: the kept capture photographed beside the project's latest version («con i token») and
 * beside the same capture converted without a framework and built in a throwaway folder («senza»), saved in the
 * project's `proposal/` folder. A side «senza» that does not convert or build is a note and the first number stands.
 * The fonts and images that conversion asked the network for and did not get are a note too: its number is of a site
 * with a fallback font, and a new comparison asks for them again.
 */
async function runProposalCompare(context: CmsApiContext, project: { name: string }, kept: { about: KeptProposal; folder: string; siteDirectory: string }, build: { createdAt: string; bundlePath: string }, openPhotos: OpenPagePhotos, signal: AbortSignal): Promise<ProposalCompareResult> {
  const notes: string[] = [];
  let outcome: { pages: ProposalComparePage[]; notes: string[] } | null = null;
  let failure: unknown;
  let reason = "";
  let missing: readonly string[] = [];
  const compare = (withoutTokens: string | null) => compareProposal({ pages: kept.about.pages, original: kept.siteDirectory, withTokens: build.bundlePath, withoutTokens, openPhotos, signal });
  if (context.convertProposalSite) {
    try {
      const converted = await context.convertProposalSite(await readKeptSiteFiles(kept.siteDirectory), project.name, signal);
      missing = converted.missing;
      const checked = await checkPrototypeBuild(converted.prototype, {
        scratchRoot: context.dataDirectory,
        signal,
        ...(context.buildBundle ? { buildBundle: context.buildBundle } : {}),
        ...(context.buildLimits ? { buildLimits: context.buildLimits } : {}),
        ...(context.convertedMedia ? { convertedMedia: context.convertedMedia } : {}),
        onBuilt: async (bundlePath) => {
          try { outcome = await compare(bundlePath); } catch (error) { failure = error; }
        },
      });
      if (checked.preview?.status === "unavailable") reason = checked.preview.reason;
    } catch (error) {
      if (signal.aborted) throw error;
      // Said below, with the reason when it is one written for the person: only the number «senza» is missing.
      if (error instanceof HistosPublishError) reason = error.message;
    }
    if (failure) throw failure;
    if (!outcome) notes.push(`La proposta non si è convertita o costruita senza token: il numero «senza» manca.${reason ? ` Motivo: ${reason.replace(/\s+/gu, " ").slice(0, 240)}` : ""}`);
    else if (missing.length) notes.push(proposalMissingNote(missing));
  }
  const measured = outcome ?? await compare(null);
  const result: ProposalCompareResult = { schemaVersion: 1, checkedAt: new Date().toISOString(), buildAt: build.createdAt, pages: measured.pages, notes: [...notes, ...measured.notes].slice(0, 10) };
  await saveProposalCompare(kept.folder, result);
  return result;
}

/**
 * What `admin/proposal-compare` answers: whether the project keeps a capture (`kept`), whether this app can photograph
 * (`available`: the desktop app only), whether a comparison is `running` or the last one `failed` (why, in words),
 * the last comparison saved (`result`) and whether it measured the version the project has now (`current`).
 */
async function proposalCompareAnswer(context: CmsApiContext, project: { id: string; directory: string }): Promise<Record<string, unknown>> {
  const kept = await readKeptProposal(project.directory);
  const result = kept ? await readProposalCompare(kept.folder) : null;
  const build = context.latestBuild?.(project.id) ?? null;
  return { kept: Boolean(kept), available: Boolean(context.photographPages), running: proposalComparesRunning.has(project.id), failed: proposalCompareFailures.get(project.id) ?? null, built: Boolean(build), result, current: Boolean(result && build && result.buildAt === build.createdAt) };
}

/**
 * What `GET admin/site-check` answers (V1.3): the check of the version as before (`check`, `current`, `at`), the
 * verdict with its sections (`readiness`) and whether this app can check in a browser (`browserAvailable`). The
 * report is written beside the version (saveReadiness), with the browser check of that same version when there is one.
 */
async function siteCheckAnswer(context: CmsApiContext, build: { createdAt: string; projectRevision: string; bundlePath: string }, projectRevision: string, browser: BrowserSummary | null): Promise<Record<string, unknown>> {
  const check = await checkBuiltSite(build.bundlePath);
  const verdict = readiness(check, browser);
  // A report that cannot be written does not hide the check: it is only a note beside the version.
  await saveReadiness(build.bundlePath, { checkedAt: new Date().toISOString(), pages: check.pages, readiness: verdict, browser }).catch(() => undefined);
  return { check, current: build.projectRevision === projectRevision, at: build.createdAt, readiness: verdict, browserAvailable: Boolean(context.openPageProbe) };
}

/** sitemap.xml and robots.txt, once the site's address is known (doc 20 §5.6). */
async function writeSiteMaps(staticRoot: string, plan: CmsRoutePlan, languages: SiteLanguages): Promise<void> {
  const addresses = [...plan.routes.keys()].filter((key) => !key.endsWith("404.html")).sort().map((key) => (key ? `/${key}/` : "/"));
  const sitemap = languages.sitemap(addresses);
  const robots = languages.robots();
  if (sitemap) await writeFile(path.join(staticRoot, "sitemap.xml"), sitemap, { mode: 0o600, flag: "wx" });
  if (robots) await writeFile(path.join(staticRoot, "robots.txt"), robots, { mode: 0o600, flag: "wx" });
}

/**
 * Old addresses of the site. `_redirects` for hosts that read it (Cloudflare, Netlify), and a small page at the old
 * address for all the others. An address the site uses again is the site's.
 */
async function writeRedirects(staticRoot: string, plan: CmsRoutePlan, redirects: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
  const free = redirects.filter((entry) => !plan.routes.has(entry.from.replace(/^\/|\/$/gu, "")));
  if (!free.length) return;
  await writeFile(path.join(staticRoot, "_redirects"), free.map((entry) => `${entry.from} ${entry.to} 301`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  for (const entry of free) {
    const folder = path.resolve(staticRoot, `.${entry.from}`);
    if (!folder.startsWith(`${path.resolve(staticRoot)}${path.sep}`)) continue;
    const to = escapeCmsHtml(entry.to);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path.join(folder, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"><a href="${to}">${to}</a>`, { mode: 0o600, flag: "wx" }).catch(() => undefined);
  }
}

/**
 * A search with no server (doc 23): Pagefind indexes the pages it finds, and /cerca/ is the page that asks it. Nothing
 * leaves the visitor's browser. The page is plain enough to sit under any site's look.
 */
async function writeSiteSearch(staticRoot: string, locale: string, signal: AbortSignal): Promise<void> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".html")) files.push({ path: path.relative(staticRoot, full).split(path.sep).join("/"), bytes: await readFile(full) });
    }
  };
  await walk(staticRoot);
  const indexed = await addPagefind(files, signal);
  for (const file of indexed.files) {
    if (!file.path.startsWith("pagefind/")) continue;
    const target = path.join(staticRoot, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { mode: 0o600 });
  }
  const page = `<!doctype html><html lang="${escapeCmsHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Cerca</title><style>body{max-width:680px;margin:40px auto;padding:0 16px;font:17px/1.6 system-ui,sans-serif}input{width:100%;padding:10px;font:inherit}li{margin:16px 0}</style></head><body data-pagefind-ignore><h1>Cerca</h1><form role="search"><input id="q" type="search" aria-label="Cerca nel sito" autofocus></form><ol id="r"></ol><script type="module">const pagefind = await import("/pagefind/pagefind.js");const q = document.getElementById("q");const r = document.getElementById("r");q.closest("form").addEventListener("submit", (e) => e.preventDefault());q.addEventListener("input", async () => {const found = await pagefind.debouncedSearch(q.value);if (found === null) return;const items = await Promise.all(found.results.slice(0, 20).map((item) => item.data()));r.replaceChildren(...items.map((item) => {const li = document.createElement("li");const a = document.createElement("a");a.href = item.url;a.textContent = item.meta.title ?? item.url;const p = document.createElement("div");p.textContent = item.excerpt.replace(/<[^>]*>/g, "");li.append(a, p);return li;}));});</script></body></html>`;
  await mkdir(path.join(staticRoot, "cerca"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(staticRoot, "cerca", "index.html"), page, { mode: 0o600 });
}

const renderSettingsLocale = (store: CmsProjectStore): string => store.getRenderSettings().locale;

/** The feed of the latest posts, for readers and newsletters: it needs the site's address, or its links lead nowhere. */
async function writeFeed(staticRoot: string, name: string, store: CmsProjectStore, locale: string): Promise<void> {
  const site = store.getSiteUrl();
  const posts = store.listPosts().filter((post) => isLive(post) && post.locale === null).sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "")).slice(0, 30);
  if (!site || !posts.length) return;
  const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const items = posts.map((post) => `<item><title>${xml(post.title)}</title><link>${xml(`${site}${postAddress(post, locale)}`)}</link><guid>${xml(`${site}${postAddress(post, locale)}`)}</guid>${post.publishedAt ? `<pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>` : ""}<description>${xml(post.excerpt ?? "")}</description></item>`).join("");
  await writeFile(path.join(staticRoot, "feed.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${xml(name)}</title><link>${xml(site)}</link><description>${xml(name)}</description>${items}</channel></rss>\n`, { mode: 0o600, flag: "wx" });
}

/** A post with a date to come stays out of the site until a version made after that date. */
function isLive(post: CmsEntity, now = Date.now()): boolean {
  return post.status === "published" && !(post.publishedAt && Date.parse(post.publishedAt) > now);
}

/**
 * Writes the index.html of a planned route ("/" and "/404.html" are the root's files), counted by the build's budget.
 * A route the plan does not have is a bug of the build, refused before the disk would say EEXIST or write an unchecked
 * path.
 */
async function writePlannedRoute(input: { staticRoot: string; plan: CmsRoutePlan; budget: CmsBuildBudget; languages?: SiteLanguages }, address: string, page: string): Promise<void> {
  if (!input.plan.routes.has(routeKey(address))) throw new HistosPublishError(`L'indirizzo ${address} non è fra quelli previsti dalla build.`, "cms-build-route-unplanned", 500);
  input.budget.addRoute();
  // A language's 404 sits in its folder, next to its index.html.
  const notFoundFolder = /^\/(.+)\/404\.html$/u.exec(address)?.[1];
  const outputPath = address === "/" ? path.join(input.staticRoot, "index.html") : address === "/404.html" ? path.join(input.staticRoot, "404.html") : notFoundFolder ? path.join(path.dirname(cmsBuildOutputPath(input.staticRoot, notFoundFolder)), "404.html") : cmsBuildOutputPath(input.staticRoot, address.replace(/^\/+/u, ""));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const language = input.languages?.otherLanguageOf(address);
  const localized = language && input.languages ? localizeHtml(page, input.languages.stringsIn(language), input.languages.linksIn(language)) : page;
  await writeFile(outputPath, withLanguageLinks(localized, input.languages, address), { mode: 0o600, flag: "wx" });
}

async function writeCmsRecordRoutes(input: {
  store: CmsProjectStore;
  projectId: string;
  staticRoot: string;
  mediaRoot: string;
  pages: Array<{ slug: string; locale?: string | null }>;
  defaultLocale: string;
  budget: CmsBuildBudget;
  plan: CmsRoutePlan;
  requireFormEndpoints: boolean;
  formStats: SkippedPages;
  languages?: SiteLanguages;
}): Promise<number> {
  const css = fallbackPageCss(input);
  const existingPageSlugs = new Set(input.pages.filter((page) => !page.locale).map((page) => page.slug));
  let routeCount = 0;
  const writeHtml = async (route: string, html: string): Promise<void> => {
    await writePlannedRoute(input, route, html);
    routeCount++;
  };
  const allPresets = input.store.content.listQueryPresets().presets;
  // Each taxonomy's terms, read at the first record page that links one (renderCmsRecordDocument).
  const termsByTaxonomy = new Map<string, ReadonlyMap<string, CmsTerm>>();
  for (const type of input.store.content.listTypes()) {
    input.budget.check();
    if (!type.public) continue; // Doc 23 item 122: shown only by loops, with no address of its own.
    const archiveTemplateRef = type.archiveTemplateRef ?? roleTemplateRef(input.store, ["archive", "index"]);
    const presets = new Map(allPresets.filter((preset) => preset.typeKey === type.key).map((preset) => [preset.key, preset]));
    for (const locale of archiveLocales(input.store, [type.key], input.defaultLocale)) {
      input.budget.check();
      const records: CmsRecord[] = [];
      let offset = 0;
      let total = 0;
      do {
        input.budget.check();
        const batch = input.store.content.listRecords({ typeKey: type.key, locale, status: "published", limit: 100, offset }, CMS_MAX_RELATION_DEPTH);
        total = batch.total;
        records.push(...batch.items);
        offset += batch.items.length;
        if (records.length > CMS_ARCHIVE_MAX_RECORDS || offset > 1_000_000) throw new HistosPublishError("Il progetto supera il limite di 10.000 voci per versione statica.", "cms-build-content-limit", 422);
      } while (offset < total && offset > 0);
      records.sort(archiveOrder);
      for (const record of records) {
        input.budget.check();
        const route = recordRoute(type.key, record, input.defaultLocale);
        const html = await renderCmsRecordDocument({ store: input.store, projectId: input.projectId, typeKey: type.key, record, mediaRoot: input.mediaRoot, locale, defaultLocale: input.defaultLocale, css, requireFormEndpoints: input.requireFormEndpoints, formStats: input.formStats, termsByTaxonomy, ...(input.languages ? { languages: input.languages } : {}) });
        await writeHtml(route, html);
      }
      const isDefaultLocale = siteLanguage(locale, input.defaultLocale);
      if (isDefaultLocale && existingPageSlugs.has(type.key)) continue;
      // Written even with no record in the site's own language, so that its {:else} renders (planCmsRoutes, the same rule).
      if (!cmsArchiveWritten(records.length, isDefaultLocale)) continue;
      const pageCount = cmsArchivePageCount(records.length);
      const archiveAddress = `${localeRoutePrefix(locale, input.defaultLocale)}/${type.key}/`;
      for (let page = 1; page <= pageCount; page++) {
        input.budget.check();
        const route = archivePageAddress(archiveAddress, page);
        const title = type.label;
        let html: string;
        if (archiveTemplateRef) {
          const pageScope = { id: type.id, title, slug: type.key, url: route, typeKey: type.key, page, totalPages: pageCount, totalRecords: records.length, ...cmsArchivePaging(archiveAddress, page, pageCount) };
          const rendered = await renderCmsSafely({
            store: input.store, projectId: input.projectId, content: "", mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot,
            templateRef: archiveTemplateRef, page: pageScope, ...input.store.getRenderSettings(), locale, ...linguaOf(input.languages, route, locale),
            requireFormEndpoints: input.requireFormEndpoints,
            mainQuery: () => mainPage(records, page, input.defaultLocale),
            resolveQuery: (presetKey, args, queryLocale) => {
              const preset = presets.get(presetKey);
              if (!preset) return input.store.content.resolveQueryPreset(presetKey, args, queryLocale);
              const hasPaging = args.offset !== undefined || args.page !== undefined || args.paged !== undefined;
              const limit = args.limit ?? args.posts_per_page ?? args.count ?? preset.limit;
              const pageOffset = page > 1 && !hasPaging && typeof limit === "number" && Number.isSafeInteger(limit) ? { offset: (page - 1) * limit } : {};
              return input.store.content.resolveQueryPreset(presetKey, { ...args, ...pageOffset }, queryLocale);
            },
          }, renderPlace(route, archiveTemplateRef));
          input.formStats.count += rendered.formCount;
          html = rendered.html;
        } else html = renderCmsArchiveDocument({ title, locale, css: await css(), records, typeKey: type.key, defaultLocale: input.defaultLocale, page, pageCount });
        await writeHtml(route, html);
      }
    }
  }
  for (const taxonomy of archivedTaxonomies(input.store)) {
    input.budget.check();
    const termTemplateRef = roleTemplateRef(input.store, cmsTermArchiveRoles(taxonomy.key));
    const allTerms = input.store.content.listTerms(taxonomy.key);
    const termsById = new Map(allTerms.map((term) => [term.id, term]));
    for (const locale of archiveLocales(input.store, taxonomy.attachedTypes, input.defaultLocale, taxonomy.includesPosts)) {
      input.budget.check();
      const isDefaultLocale = siteLanguage(locale, input.defaultLocale);
      const assignments = termAssignments(input.store, taxonomy, locale);
      // The contents filed in this language, read once (records with the relations of a query's items, as on a type's
      // archive) when the first archive that lists some is written.
      let contents: Map<string, CmsRecord> | null = null;
      const readContents = (): Map<string, CmsRecord> => {
        const byId = new Map<string, CmsRecord>();
        const recordIds = [...new Set(assignments.filter((pair) => !pair.post).map((pair) => pair.contentId))];
        for (let offset = 0; offset < recordIds.length; offset += 100) {
          input.budget.check();
          for (const record of input.store.content.listPublishedRecordsByIds(recordIds.slice(offset, offset + 100), CMS_MAX_RELATION_DEPTH)) byId.set(record.id, record);
        }
        const postIds = new Set(assignments.filter((pair) => pair.post).map((pair) => pair.contentId));
        for (let offset = 0; postIds.size > 0; ) {
          input.budget.check();
          const batch = input.store.content.listRecords({ typeKey: "post", status: "published", locale, limit: 100, offset });
          for (const record of batch.items) if (postIds.has(record.id)) byId.set(record.id, record);
          offset += batch.items.length;
          if (offset > CMS_ARCHIVE_MAX_RECORDS) throw new HistosPublishError("Il progetto supera il limite di 10.000 articoli per versione statica.", "cms-build-content-limit", 422);
          if (!batch.items.length || offset >= batch.total) break;
        }
        return byId;
      };
      // The terms as the plan walked them: each with its descendants' contents, an empty one in the site's language only.
      for (const { term, ids } of termArchiveContents(allTerms, assignments, cmsTermArchiveIncludesChildren(taxonomy.key))) {
        input.budget.check();
        if (!cmsArchiveWritten(ids.size, isDefaultLocale)) continue;
        // Read before anything is awaited: the walk merges this set into the parent's once asked for the next term.
        if (ids.size && !contents) contents = readContents();
        const found = contents;
        const records = ids.size && found ? [...ids].flatMap((id) => found.get(id) ?? []).sort(archiveOrder) : [];
        const route = taxonomyTermRoute(input.store, taxonomy.key, term, locale, input.defaultLocale, termsById);
        const pageCount = cmsArchivePageCount(records.length);
        for (let page = 1; page <= pageCount; page++) {
          input.budget.check();
          const pageRoute = archivePageAddress(route, page);
          let html: string;
          if (termTemplateRef) {
            const rendered = await renderCmsSafely({
              store: input.store, projectId: input.projectId, content: "", mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot,
              templateRef: termTemplateRef, page: { id: term.id, title: term.label, slug: term.slug, url: pageRoute, taxonomyKey: taxonomy.key, page, totalPages: pageCount, totalRecords: records.length, ...cmsArchivePaging(route, page, pageCount) },
              ...input.store.getRenderSettings(), locale, ...linguaOf(input.languages, pageRoute, locale), requireFormEndpoints: input.requireFormEndpoints,
              // The term's records and its descendants' (D3): an explicit query loop is not filtered by the term, main() is.
              mainQuery: () => mainPage(records, page, input.defaultLocale),
            }, renderPlace(pageRoute, termTemplateRef));
            input.formStats.count += rendered.formCount;
            html = rendered.html;
          } else html = renderCmsArchiveDocument({ title: term.label, locale, css: await css(), records, typeKey: taxonomy.key, defaultLocale: input.defaultLocale, page, pageCount, archiveRoute: route, recordUrl: (record) => record.typeKey === "post" ? postAddress(record, input.defaultLocale) : recordRoute(record.typeKey, record, input.defaultLocale) });
          await writeHtml(pageRoute, html);
        }
      }
    }
  }
  return routeCount;
}

/**
 * Posts (docs/spec/cms-bridge.md §12): each at /blog/<slug>/, the list at /blog/ when the project has a blog and no
 * page owns that address (postsIndexWanted), and 404.html from the 404 role. Every path is one of the plan's.
 */
async function writeCmsPostRoutes(input: {
  store: CmsProjectStore;
  projectId: string;
  staticRoot: string;
  mediaRoot: string;
  pages: Array<{ slug: string; locale?: string | null }>;
  posts: CmsEntity[];
  defaultLocale: string;
  budget: CmsBuildBudget;
  plan: CmsRoutePlan;
  requireFormEndpoints: boolean;
  formStats: SkippedPages;
  languages?: SiteLanguages;
}): Promise<number> {
  let routeCount = 0;
  const writeHtml = async (address: string, html: string): Promise<void> => {
    await writePlannedRoute(input, address, html);
    routeCount++;
  };
  for (const post of input.posts) {
    input.budget.check();
    const revision = input.store.getHead(post.id);
    if (!revision) continue;
    const templateRef = documentTemplateRef(input.store, post);
    const address = postAddress(post, input.defaultLocale);
    let rendered: Awaited<ReturnType<typeof renderCmsSafely>>;
    try {
      rendered = await renderCmsSafely({ store: input.store, projectId: input.projectId, content: postContentWithImage(revision.content, post.imageAssetId, templateRef !== null, input.store, input.projectId), mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot, ...input.store.getRenderSettings(), ...(post.locale ? { locale: post.locale } : {}), ...linguaOf(input.languages, address, post.locale ?? input.defaultLocale), ...(templateRef ? { templateRef } : {}), page: postScope(input.store, post, input.defaultLocale), requireFormEndpoints: input.requireFormEndpoints }, renderPlace(address, templateRef));
    } catch (error) {
      if (!skipRefusedPage(input.formStats, address, post.title, error, routeCount)) throw error;
      continue;
    }
    input.formStats.count += rendered.formCount;
    // Doc 18 §6.6: a post's JavaScript, and its components', as for a page.
    await writeHtml(address, withDocumentScripts(rendered.html, documentScripts(input.store, post, revision.content)));
  }
  const indexTemplateRef = roleTemplateRef(input.store, ["home", "index"]);
  const indexTemplate = indexTemplateRef ? input.store.getTemplateByRef(indexTemplateRef) : null;
  const css = fallbackPageCss(input);
  const presets = new Map(input.store.content.listQueryPresets().presets.filter((preset) => preset.typeKey === "post").map((preset) => [preset.key, preset]));
  for (const locale of postsIndexLanguages(input.store, input.pages, input.defaultLocale)) {
    const published: CmsRecord[] = [];
    for (let offset = 0; ; ) {
      input.budget.check();
      const batch = input.store.content.listRecords({ typeKey: "post", status: "published", locale, orderBy: "publishedAt", order: "desc", limit: 100, offset });
      published.push(...batch.items);
      offset += batch.items.length;
      if (published.length > CMS_ARCHIVE_MAX_RECORDS) throw new HistosPublishError("Il progetto supera il limite di 10.000 articoli per versione statica.", "cms-build-content-limit", 422);
      if (!batch.items.length || offset >= batch.total) break;
    }
    published.sort(archiveOrder);
    // Written with no published post too: the empty list, with its template's {:else}.
    const pageCount = cmsArchivePageCount(published.length);
    const indexAddress = `${localeRoutePrefix(locale, input.defaultLocale)}/blog/`;
    for (let page = 1; page <= pageCount; page++) {
      input.budget.check();
      const route = archivePageAddress(indexAddress, page);
      let html: string;
      if (indexTemplateRef && indexTemplate) {
        const rendered = await renderCmsSafely({
          store: input.store, projectId: input.projectId, content: "", mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot,
          templateRef: indexTemplateRef, page: { id: indexTemplate.id, title: "Blog", slug: "blog", url: route, typeKey: "post", page, totalPages: pageCount, totalRecords: published.length, ...cmsArchivePaging(indexAddress, page, pageCount) },
          ...input.store.getRenderSettings(), locale, ...linguaOf(input.languages, route, locale), requireFormEndpoints: input.requireFormEndpoints,
          mainQuery: () => mainPage(published, page, input.defaultLocale),
          resolveQuery: (presetKey, args, queryLocale) => {
            const preset = presets.get(presetKey);
            if (!preset) return input.store.content.resolveQueryPreset(presetKey, args, queryLocale);
            const hasPaging = args.offset !== undefined || args.page !== undefined || args.paged !== undefined;
            const limit = args.limit ?? args.posts_per_page ?? args.count ?? preset.limit;
            const pageOffset = page > 1 && !hasPaging && typeof limit === "number" && Number.isSafeInteger(limit) ? { offset: (page - 1) * limit } : {};
            return input.store.content.resolveQueryPreset(presetKey, { ...args, ...pageOffset }, queryLocale);
          },
        }, renderPlace(route, indexTemplateRef));
        input.formStats.count += rendered.formCount;
        html = rendered.html;
      } else html = renderCmsArchiveDocument({ title: "Blog", locale, css: await css(), records: published, typeKey: "post", defaultLocale: input.defaultLocale, page, pageCount, archiveRoute: indexAddress, recordUrl: (record) => postAddress(record, input.defaultLocale) });
      await writeHtml(route, html);
    }
  }
  return routeCount;
}

/** `/` from the front-page role when no published home page exists, and `404.html` from the 404 role. */
async function writeCmsRoleFiles(input: { store: CmsProjectStore; projectId: string; staticRoot: string; mediaRoot: string; pages: Array<{ slug: string; locale?: string | null }>; posts: Array<{ locale?: string | null }>; budget: CmsBuildBudget; plan: CmsRoutePlan; requireFormEndpoints: boolean; formStats: { count: number }; languages?: SiteLanguages }): Promise<void> {
  const defaultLocale = input.store.getRenderSettings().locale;
  const hasHome = (language: string | null) => input.pages.some((page) => page.slug === "home" && (language === null ? !page.locale : page.locale?.toLowerCase() === language.toLowerCase()));
  for (const language of [null, ...builtLanguages(input.store, input.pages, input.posts)]) {
    const prefix = language === null ? "" : localeRoutePrefix(language, defaultLocale);
    const files: Array<{ role: TemplateRole; address: string; title: string; slug: string; skip: boolean }> = [
      { role: "front-page", address: `${prefix}/`, title: "Home", slug: "home", skip: hasHome(language) },
      { role: "404", address: `${prefix}/404.html`, title: "Pagina non trovata", slug: "404", skip: false },
    ];
    for (const entry of files) {
      if (entry.skip) continue;
      const templateRef = roleTemplateRef(input.store, [entry.role]);
      const template = templateRef ? input.store.getTemplateByRef(templateRef) : null;
      if (!templateRef || !template) continue;
      input.budget.check();
      const rendered = await renderCmsSafely({ store: input.store, projectId: input.projectId, content: "", mediaBase: "/__cms-media", buildMediaDirectory: input.mediaRoot, ...input.store.getRenderSettings(), ...(language ? { locale: language } : {}), ...linguaOf(input.languages, entry.address, language ?? defaultLocale), templateRef, page: { id: template.id, title: entry.title, slug: entry.slug, url: entry.address }, requireFormEndpoints: input.requireFormEndpoints }, renderPlace(entry.address, templateRef));
      input.formStats.count += rendered.formCount;
      await writePlannedRoute(input, entry.address, rendered.html);
    }
  }
}

/**
 * A transfer profile that came from a file (an .xbsite or a prototype): a new project, or an update of the project
 * a previous file created, whose common bases live under the project's own id (docs/spec/cms-bridge.md §13).
 */
/** What the operations below need from the server: the catalog, where builds go and how previews are registered. */
export type CmsOperationsContext = Pick<CmsApiContext, "catalog" | "dataDirectory" | "port" | "buildLimits" | "buildBundle" | "registerPreview" | "registerBuild" | "fetchPrototypeAsset" | "prototypePreviews" | "importReports" | "convertedMedia" | "fontFetcher" | "videoFetcher" | "importProgress" | "imageVariantCache" | "imageVariantLimits" | "openPageProbe">;

export interface CmsOperationResult {
  status: number;
  body: Record<string, unknown>;
}

export interface CmsProfileImportOptions {
  report?: unknown;
  /**
   * Whether a file may update the project it was imported as before. The routes of the app always allow it (the
   * user chose the file); the AI connector allows it only when the agent says so explicitly.
   */
  allowUpdate: boolean;
  /** Called with the project about to be updated (null for a new one) right before anything is written. */
  beforeCommit?: (existing: { project: { id: string; name: string }; store: CmsProjectStore } | null) => Promise<void>;
  /**
   * The answer when an update is not allowed; by default a 409 that tells the AI agent to ask the user. It gets the
   * project still open (`existing`), so it can measure what the update would need before the user is asked; it may
   * throw to refuse at once.
   */
  refuseUpdate?: (project: { id: string; name: string }, existing: { project: { id: string; name: string }; store: CmsProjectStore }) => CmsOperationResult | Promise<CmsOperationResult>;
}

/** Names for the entities of a sync conflict, so the user sees which pages or templates, not only their ids. */
function conflictLabels(store: CmsProjectStore, conflicts: ReadonlyArray<{ id: string; kind: string }>): Array<{ id: string; kind: string; label: string }> {
  return conflicts.map((conflict) => {
    let label = "";
    try {
      label = store.getEntityById(conflict.id)?.title ?? store.getComponentById(conflict.id)?.title ?? "";
    } catch {
      label = "";
    }
    return { id: conflict.id, kind: conflict.kind, label: label.slice(0, 120) };
  });
}

/** Imports a decoded .xbsite profile: a new project, or an update of the project the same file created. */
export async function importProfile(
  context: Pick<CmsApiContext, "catalog">,
  decoded: { profile: Awaited<ReturnType<typeof decodeStaticPageArchive>>["profile"]; files: Map<string, Buffer> },
  options: CmsProfileImportOptions,
): Promise<CmsOperationResult> {
  const { report } = options;
  const fileSite = decoded.profile.manifest.project.id;
  const existing = await context.catalog.openProject(fileSite);
  if (existing) {
    try {
      const fromFile = existing.store.hasSyncBases(fileSite);
      if (!fromFile) throw new HistosPublishError("Questa identità di progetto è già presente nel catalogo.", "cms-project-duplicate", 409);
      if (!options.allowUpdate) {
        // Awaited here, inside the try: the store it measures closes in the finally below.
        if (options.refuseUpdate) return await options.refuseUpdate({ id: existing.project.id, name: existing.project.name }, existing);
        throw new HistosPublishError(`Il prototipo aggiornerebbe il progetto «${existing.project.name.slice(0, 120)}». Ripeti con update: true solo se l'utente è d'accordo.`, "cms-prototype-update-requires-flag", 409);
      }
      await options.beforeCommit?.(existing);
    } finally {
      existing.store.close();
    }
    try {
      const updated = await context.catalog.importRemoteStaticPageProfile(decoded.profile, decoded.files, fileSite);
      return { status: 200, body: { project: projectInfo(updated.project), changed: updated.changed, keptLocal: updated.keptLocal, unchanged: updated.unchanged, ...(report ? { report } : {}) } };
    } catch (error) {
      if (error instanceof CmsSyncConflictError) {
        const reopened = await context.catalog.openProject(fileSite);
        let conflicts: Array<{ id: string; kind: string; label?: string }> = error.conflicts;
        if (reopened) {
          try { conflicts = conflictLabels(reopened.store, error.conflicts); }
          finally { reopened.store.close(); }
        }
        return { status: 409, body: { error: error.message, code: "cms-sync-conflict", conflicts, complete: false } };
      }
      if (error instanceof TypeError) throw new HistosPublishError(error.message, "cms-transfer-invalid", 422);
      throw error;
    }
  }
  await options.beforeCommit?.(null);
  let imported: Awaited<ReturnType<CmsProjectCatalog["importStaticPageProfile"]>>;
  try { imported = await context.catalog.importStaticPageProfile(decoded.profile, decoded.files, fileSite); }
  catch (error) {
    if (error instanceof TypeError) throw new HistosPublishError(error.message, "cms-transfer-invalid", 422);
    throw error;
  }
  try {
    return { status: 201, body: { project: projectInfo(imported.project), pages: imported.store.listPages(), styles: imported.store.getStyles(), assets: imported.store.listAssets(), ...(report ? { report } : {}) } };
  } finally {
    imported.store.close();
  }
}

/**
 * Whether the backup an update of the app saves first would fit its limits (512 MiB, number of files) and could be
 * restored, measured as the backup measures itself (withBackupSnapshot: the database copy and its media, nothing read)
 * before the user is asked to confirm: the request to confirm promises that backup, so an update that could not save
 * it is refused at once (413 `cms-backup-too-large`, 422 `cms-backup-unrestorable`), never after the user said yes.
 * The update itself measures again (updateBackupArchive): the project may change in between.
 */
async function assertAppUpdateBackupFits(existing: { project: { id: string; name: string }; store: CmsProjectStore }): Promise<void> {
  try {
    await existing.store.withBackupSnapshot(async ({ sizes }) => assertNativeBackupFits(existing.project as Parameters<typeof encodeNativeProjectArchive>[0], sizes));
  } catch (error) {
    if (error instanceof RangeError) throw new HistosPublishError(`${error.message} Prima di aggiornare salvo un backup del progetto, e il backup supererebbe i suoi limiti: l'aggiornamento non si può fare.`, "cms-backup-too-large", 413);
    if (error instanceof TypeError) throw new HistosPublishError(`${error.message} Prima di aggiornare salvo un backup del progetto, e questo backup non si potrebbe ripristinare: l'aggiornamento non si può fare.`, "cms-backup-unrestorable", 422);
    throw error;
  }
}

/**
 * An import from the app (a .xbsite or a prototype the user chose): a new project is created at once; an update of
 * the project the same file created needs `?update=1`, which the interface sends only after the user confirmed, and
 * the project as it was is saved first (<data>/backups/<project>/, kept only when the update committed). The request
 * to confirm is made only for an update whose backup fits (assertAppUpdateBackupFits).
 */
async function importFromApp(
  context: CmsApiContext,
  confirmed: boolean,
  run: (options: Omit<CmsProfileImportOptions, "report">) => Promise<CmsOperationResult>,
): Promise<CmsOperationResult> {
  let pending: PendingBackup | null = null;
  let result: CmsOperationResult;
  try {
    result = await run({
      allowUpdate: confirmed,
      refuseUpdate: async (project, existing) => {
        await assertAppUpdateBackupFits(existing);
        return {
          status: 409,
          body: { error: `Questo file aggiorna il progetto «${project.name.slice(0, 120)}». Conferma l’aggiornamento: prima salvo un backup del progetto com’è ora.`, code: "cms-import-update-requires-confirmation", project: { id: project.id, name: project.name.slice(0, 120) } },
        };
      },
      beforeCommit: async (existing) => {
        if (existing) pending = await prepareBackup(context.dataDirectory, existing.project.id, await updateBackupArchive(existing));
      },
    });
  } catch (error) {
    await (pending as PendingBackup | null)?.discard();
    throw error;
  }
  const prepared = pending as PendingBackup | null;
  if (prepared && result.status === 200) {
    await prepared.commit();
    return { status: 200, body: { ...result.body, backup: prepared.name } };
  }
  await prepared?.discard();
  return result;
}

async function importProfileFromFile(
  context: CmsApiContext,
  response: ServerResponse,
  decoded: { profile: Awaited<ReturnType<typeof decodeStaticPageArchive>>["profile"]; files: Map<string, Buffer> },
  confirmed: boolean,
): Promise<void> {
  const result = await importFromApp(context, confirmed, (options) => importProfile(context, decoded, options));
  sendJson(response, result.status, result.body);
}

/** A cancelled import stops with the reason it was given, or as cancelled (499). */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof HistosPublishError ? signal.reason : new HistosPublishError("Import annullato.", "cms-import-cancelled", 499);
}

/**
 * Imports a Histeon prototype: built in a private scratch catalog, exported as a profile, then imported like any
 * .xbsite file. `download` fetches remote media (public HTTPS only); without it a remote image is an error.
 */
export async function importPrototypeHtml(
  context: CmsOperationsContext,
  html: string,
  options: { download: boolean; signal?: AbortSignal; onProgress?: (progress: PrototypeImportProgress) => void; origin?: { source: ImportReport["source"]; file: string | null }; expectedProfileDigest?: string; convertedMedia?: (sha256: string) => Uint8Array | null } & Omit<CmsProfileImportOptions, "report">,
): Promise<CmsOperationResult> {
  let parsed: ReturnType<typeof parsePrototype>;
  try { parsed = parsePrototype(html); }
  catch (error) { throw error instanceof TypeError || error instanceof RangeError ? prototypeInvalid(error) : new HistosPublishError(error instanceof Error ? error.message : "Prototipo non valido.", "cms-prototype-invalid", 422); }
  const scratch = path.join(context.dataDirectory, `.prototype-${randomUUID()}`);
  try {
    const temporary = new CmsProjectCatalog(scratch, { durable: false });
    let built: Awaited<ReturnType<typeof buildPrototypeProfile>>;
    const signal = { ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) };
    const kept = options.convertedMedia ? { convertedMedia: options.convertedMedia } : {};
    try { built = await buildPrototypeProfile(parsed, temporary, options.download ? { fetchAsset: context.fetchPrototypeAsset ?? fetchPrototypeAsset, ...signal, ...kept } : { ...signal, ...kept }); }
    catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw prototypeInvalid(error);
      throw error;
    }
    throwIfCancelled(options.signal);
    // The profile and its files are in memory: the scratch catalog goes before the real import answers.
    await removeTemporary(scratch);
    // An approved update (D2): exactly the prototype whose changes the user saw, remote media bytes included.
    if (options.expectedProfileDigest !== undefined && profileDigest(built.profile) !== options.expectedProfileDigest) {
      throw new HistosPublishError("Il prototipo non è più quello controllato (per esempio un media remoto è cambiato): l'aggiornamento non è partito.", "connector-import-stale", 409);
    }
    const beforeCommit = async (existing: Parameters<NonNullable<CmsProfileImportOptions["beforeCommit"]>>[0]): Promise<void> => {
      // The last moment to stop, also after the backup the caller may save: from here the import completes or did not happen.
      throwIfCancelled(options.signal);
      await options.beforeCommit?.(existing);
      throwIfCancelled(options.signal);
      options.onProgress?.({ phase: "writing", done: 0, total: 0 });
    };
    // Doc 23 item 239: whether this very file was opened in a browser by a check of this app, and with what result.
    const browserNote = browserCheckNote(html);
    if (browserNote) built = { ...built, report: { ...built.report, warnings: [...built.report.warnings, browserNote] } };
    const result = await importProfile(context, built, { report: built.report, allowUpdate: options.allowUpdate, beforeCommit, ...(options.refuseUpdate ? { refuseUpdate: options.refuseUpdate } : {}) });
    const project = result.body.project as { id?: unknown } | undefined;
    // The shop of the products (queue C6) is the project's setting, not part of the transfer.
    if (built.shop && (result.status === 200 || result.status === 201) && typeof project?.id === "string") {
      const opened = await context.catalog.openProject(project.id);
      if (opened) {
        try { opened.store.setShopSettings(built.shop); } finally { opened.store.close(); }
      }
    }
    if ((result.status === 200 || result.status === 201) && typeof project?.id === "string") {
      const stored = context.importReports?.record({ projectId: project.id, source: options.origin?.source ?? { kind: "app" }, file: options.origin?.file ?? null, report: await withMeasuredImages(context, project.id, built), body: result.body });
      // Doc 18 §9 (F7): the report stays in the project's history too, beyond this session of the app.
      if (stored) {
        const opened = await context.catalog.openProject(project.id);
        if (opened) {
          try { opened.store.addImportReport({ ...stored }); } finally { opened.store.close(); }
        }
      }
    }
    return result;
  } finally {
    await removeTemporary(scratch);
  }
}

/**
 * The import's report with the savings of its images (B6) when the encoder's cache already has them: the check's
 * preview build made them, with the same content and the imported project's settings. Nothing is encoded here.
 */
async function withMeasuredImages(context: CmsOperationsContext, projectId: string, built: { report: PrototypeReport; imageCandidates: PrototypeImageCandidate[] }): Promise<PrototypeReport> {
  const images = built.report.images;
  if (!images || !built.imageCandidates.length) return built.report;
  const opened = await context.catalog.openProject(projectId);
  if (!opened) return built.report;
  let settings: ReturnType<CmsProjectStore["getImageSettings"]>;
  try { settings = opened.store.getImageSettings(); }
  finally { opened.store.close(); }
  const cacheDirectory = context.imageVariantCache === undefined ? path.join(context.dataDirectory, "histos-image-variants") : context.imageVariantCache;
  const savings = await cachedImageSavings(built.imageCandidates, settings, cacheDirectory).catch(() => ({ measured: 0, originalBytes: 0, variantBytes: 0 }));
  return { ...built.report, images: { ...images, note: settings.variants ? measuredImageNote(images.note, images.files, savings) : "Immagini moderne: spente nelle impostazioni del progetto." } };
}

/** The .xbsite file of a project: the same bytes as the export route. */
export async function exportXbsiteArchive(project: Parameters<typeof encodeStaticPageArchive>[0], store: CmsProjectStore): Promise<Buffer> {
  try {
    return await encodeStaticPageArchive(project, store, undefined, store.hasSyncBases(project.id) ? project.id : undefined);
  } catch (error) {
    if (error instanceof TypeError) throw new HistosPublishError(error.message, "cms-transfer-invalid", 422);
    throw error;
  }
}

/**
 * Doc 23 item 238: a prototype straight to the .xbsite WordPress imports, with no project in the app. The same
 * steps as an import (buildPrototypeProfile, the project made from the profile) in a private folder under
 * `scratchRoot`, removed before answering; the package is the one hp_export_xbsite would give for the project the
 * import would create, with the same identities. Remote media are downloaded only with `download`: without it a
 * remote image stops the export, as it stops an import, never a placeholder in the package.
 */
export async function exportPrototypeXbsite(
  html: string,
  options: { scratchRoot: string; download?: boolean; fetchAsset?: PrototypeAssetFetcher; signal?: AbortSignal },
): Promise<{ archive: Buffer; report: PrototypeReport }> {
  let parsed: ReturnType<typeof parsePrototype>;
  try { parsed = parsePrototype(html); }
  catch (error) { throw error instanceof TypeError || error instanceof RangeError ? prototypeInvalid(error) : new HistosPublishError(error instanceof Error ? error.message : "Prototipo non valido.", "cms-prototype-invalid", 422); }
  await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = path.join(options.scratchRoot, `.prototype-export-${randomUUID()}`);
  try {
    await mkdir(scratch, { mode: 0o700 });
    const signal = options.signal ? { signal: options.signal } : {};
    let built: Awaited<ReturnType<typeof buildPrototypeProfile>>;
    try { built = await buildPrototypeProfile(parsed, new CmsProjectCatalog(path.join(scratch, "build"), { durable: false }), options.download ? { fetchAsset: options.fetchAsset ?? fetchPrototypeAsset, ...signal } : signal); }
    catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw prototypeInvalid(error);
      throw error;
    }
    throwIfCancelled(options.signal);
    const imported = await new CmsProjectCatalog(path.join(scratch, "project"), { durable: false }).importStaticPageProfile(built.profile, built.files);
    try {
      return { archive: await exportXbsiteArchive(imported.project, imported.store), report: built.report };
    } finally {
      imported.store.close();
    }
  } finally {
    await removeTemporary(scratch);
  }
}

/** Files and bytes of a folder, every file counted (the bundle reads each one). */
async function folderUsage(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files++;
        bytes += (await lstat(full)).size;
      }
    }
  };
  await walk(root);
  return { files, bytes };
}

/** Room kept in the bundle for what the bundle adds itself (a search index, a manifest). */
const BUNDLE_ROOM_KEPT = { files: 200, bytes: 4 * 1024 * 1024 };

/**
 * The modern image variants of a written build (queue B6, writeImageVariants), with the project's settings, within
 * their own time and the room the bundle still has (CMS_BUNDLE_MAX_BYTES and DEFAULT_MAX_FILES minus what the build
 * wrote): an image past either keeps its original. A cancelled build stops here as cancelled.
 */
async function writeBuildImageVariants(context: CmsOperationsContext, store: CmsProjectStore, staticRoot: string, limits: CmsBuildLimits, signal: AbortSignal): Promise<ImageVariantSummary> {
  const settings = store.getImageSettings();
  const imageTimeoutMs = limits.imageTimeoutMs ?? CMS_IMAGE_VARIANTS_TIMEOUT_MS;
  if (!settings.variants || imageTimeoutMs <= 0) return emptyImageVariantSummary(false);
  const usage = await folderUsage(staticRoot);
  try {
    return await writeImageVariants({
      staticRoot,
      settings,
      cacheDirectory: context.imageVariantCache === undefined ? path.join(context.dataDirectory, "histos-image-variants") : context.imageVariantCache,
      deadline: Date.now() + imageTimeoutMs,
      signal,
      room: { files: Math.max(0, DEFAULT_MAX_FILES - usage.files - BUNDLE_ROOM_KEPT.files), bytes: Math.max(0, CMS_BUNDLE_MAX_BYTES - usage.bytes - BUNDLE_ROOM_KEPT.bytes) },
      ...(context.imageVariantLimits ? { limits: context.imageVariantLimits } : {}),
    });
  } catch (error) {
    if (signal.aborted) throw new HistosPublishError("La versione è stata annullata perché la richiesta è stata chiusa.", "cms-build-cancelled", 499);
    throw error;
  }
}

/** A warning only when variants were meant and could not be made for the machine's reasons (time, memory, encoder). */
function imageVariantFindings(images: ImageVariantSummary): Finding[] {
  const troubles = images.skipped.filter((item) => /^(?:tempo scaduto|memoria|errore del codificatore|il codificatore)/u.test(item.reason));
  if (!troubles.length) return [];
  return [{ code: "cms-image-variants-incomplete", severity: "warn", file: "Immagini", message: `Varianti moderne non pronte per ${troubles.reduce((sum, item) => sum + item.count, 0)} immagini: ${troubles.map((item) => item.reason).join("; ")}. Quelle immagini restano nel formato originale.` }];
}

/**
 * Builds the static site of a project into <data>/histos-cms-builds/<project>/<build>. With `previewAlias` it is an
 * unregistered draft preview of that page; with `throwaway` an unregistered preview of the published pages in that
 * folder (a checked prototype, queue A2); otherwise a registered build of the published pages. `signal` cancels it.
 */
export async function buildCmsProject(
  context: CmsOperationsContext,
  opened: { project: { id: string }; store: CmsProjectStore },
  /** `keepGoing`: an article that cannot be built is left out and reported; a check, which must say so, leaves it off. */
  options: { previewAlias?: number; throwaway?: { directory: string }; signal?: AbortSignal; keepGoing?: boolean } = {},
): Promise<Record<string, unknown>> {
  const { project, store } = opened;
  let previewPage: CmsEntity | null = null;
  if (options.previewAlias !== undefined) {
    const alias = requireAlias(String(options.previewAlias));
    previewPage = store.getEntityByAlias(alias);
    if (!previewPage || previewPage.kind !== "page") throw new HistosPublishError("La pagina da visualizzare non esiste nel progetto.", "cms-page-missing", 404);
  }
  // Only a registered build is held to the publishing rules (form endpoints) and to a coherent project revision.
  const projectRevision = previewPage || options.throwaway ? null : store.getProjectRevision();
  const buildId = randomUUID();
  const limits: CmsBuildLimits = {
    maxRoutes: context.buildLimits?.maxRoutes ?? MAX_CMS_BUILD_ROUTES,
    timeoutMs: context.buildLimits?.timeoutMs ?? CMS_BUILD_TIMEOUT_MS,
    imageTimeoutMs: context.buildLimits?.imageTimeoutMs ?? CMS_IMAGE_VARIANTS_TIMEOUT_MS,
  };
  if (!Number.isSafeInteger(limits.imageTimeoutMs) || (limits.imageTimeoutMs ?? 0) < 0) throw new HistosPublishError("I limiti interni della versione del sito non sono validi.", "cms-build-limits-invalid", 500);
  if (!Number.isSafeInteger(limits.maxRoutes) || limits.maxRoutes < 1 || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 0) {
    throw new HistosPublishError("I limiti interni della versione del sito non sono validi.", "cms-build-limits-invalid", 500);
  }
  const controller = new AbortController();
  const budget = new CmsBuildBudget(controller.signal, limits);
  const abortOnSignal = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abortOnSignal, { once: true });
  let timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  timeout.unref?.();
  let stagingRoot: string | null = null;
  let keepOutput = false;
  let outputCanBeRemoved = false;
  const outputDirectory = options.throwaway ? path.join(options.throwaway.directory, buildId) : path.join(context.dataDirectory, "histos-cms-builds", project.id, buildId);
  try {
    budget.check();
    stagingRoot = await mkdtemp(path.join(os.tmpdir(), "histos-cms-stage-"));
    const staticRoot = path.join(stagingRoot, "source");
    const mediaRoot = path.join(staticRoot, "media");
    await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(outputDirectory), { recursive: true, mode: 0o700 });
    const pages = store.listPages().filter((page) => page.status === "published" || page.id === previewPage?.id);
    if (pages.length === 0 && previewPage?.documentType !== "post") throw new HistosPublishError("Il progetto non ha pagine incluse nella versione. Seleziona almeno una pagina dal catalogo CMS.", "cms-build-no-published-pages", 422);
    const posts = store.listPosts().filter((post) => isLive(post) || (previewPage?.documentType === "post" && post.id === previewPage.id));
    // Every address before any is written: two contents on one, or more routes than the limit, stop the build here
    // with both named, never as a raw EEXIST halfway (the prototype check reports the same plan's problems).
    const plan = planCmsRoutes(store, { pages, posts, maxRoutes: limits.maxRoutes, check: () => budget.check() });
    assertCmsRoutePlan(plan, limits.maxRoutes);
    const languages = buildSiteLanguages(store, plan.routes.keys(), pages, posts);
    const formStats: SkippedPages = { count: 0, skipped: [], ...(options.keepGoing ? { keepGoing: true } : {}) };
    const requireFormEndpoints = projectRevision !== null;
    for (const page of pages) {
      const revision = store.getHead(page.id);
      if (!revision) continue;
      const address = pageAddress(page, store.getRenderSettings().locale);
      const rendered = await renderCmsDocumentPage({ store, projectId: project.id, document: page, content: revision.content, buildMediaDirectory: mediaRoot, requireFormEndpoints, where: renderPlace(address, documentTemplateRef(store, page)), languages });
      formStats.count += rendered.formCount;
      budget.check();
      await writePlannedRoute({ staticRoot, plan, budget, languages }, address, withDocumentScripts(rendered.html, documentScripts(store, page, revision.content)));
    }
    await writeCmsRoleFiles({ store, projectId: project.id, staticRoot, mediaRoot, pages, posts, budget, plan, requireFormEndpoints, formStats, languages });
    const postRoutes = await writeCmsPostRoutes({ store, projectId: project.id, staticRoot, mediaRoot, pages, posts, defaultLocale: store.getRenderSettings().locale, budget, plan, requireFormEndpoints, formStats, languages });
    const contentRoutes = postRoutes + await writeCmsRecordRoutes({ store, projectId: project.id, staticRoot, mediaRoot, pages, defaultLocale: store.getRenderSettings().locale, budget, plan, requireFormEndpoints, formStats, languages });
    await writeSiteMaps(staticRoot, plan, languages);
    await writeRedirects(staticRoot, plan, store.getRedirects());
    await writeFeed(staticRoot, (project as { name?: string }).name ?? store.getSiteUrl() ?? "", store, renderSettingsLocale(store));
    if (store.getSiteSearch()) await writeSiteSearch(staticRoot, store.getRenderSettings().locale, controller.signal);
    budget.check();
    // The image variants (queue B6) have their own time: the build's stops while they run.
    clearTimeout(timeout);
    const variantsStarted = Date.now();
    const images = await writeBuildImageVariants(context, store, staticRoot, limits, controller.signal);
    budget.exclude(Date.now() - variantsStarted);
    timeout = setTimeout(() => controller.abort(), budget.remaining());
    timeout.unref?.();
    budget.check();
    try {
      await lstat(outputDirectory);
      throw new HistosPublishError("La cartella per la nuova versione esiste già. Genera un nuovo ID e riprova.", "cms-build-output-collision", 409);
    } catch (error) {
      if (error instanceof HistosPublishError) throw error;
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    outputCanBeRemoved = true;
    const result = await (context.buildBundle ?? buildBundle)({ source: { kind: "directory", path: staticRoot }, outputDirectory, signal: controller.signal, maxBytes: CMS_BUNDLE_MAX_BYTES });
    budget.check();
    if (result.status === "ready" && result.bundlePath && projectRevision !== null && store.getProjectRevision() !== projectRevision) {
      await rm(outputDirectory, { recursive: true, force: true });
      throw new HistosPublishError("Il progetto è cambiato mentre veniva preparata la versione. Ripeti la versione per includere una copia coerente.", "cms-build-source-changed", 409);
    }
    const stylesEntity = store.getStyles();
    const stylesRevision = stylesEntity ? store.getHead(stylesEntity.id) : null;
    const findings: Finding[] = [
      ...result.findings,
      ...(formStats.count > 0 ? [{
        code: "cms-form-endpoint-unverified",
        severity: "warn" as const,
        file: "Moduli CMS",
        message: `${formStats.count} modulo/i inviano i dati direttamente agli endpoint configurati. Histeon Publish ne ha verificato soltanto URL e metodo: non ha contattato i servizi né verificato consegna, privacy o pagina di conferma.`,
      }] : []),
      ...(stylesRevision ? missingExternalFrameworkCssFindings(stylesRevision.content) : []),
      ...imageVariantFindings(images),
      ...formStats.skipped.map((page) => ({ code: "cms-page-skipped", severity: "warn" as const, file: page.address, message: `«${page.title}» è rimasta fuori dal sito: ${page.message}` })),
      ...(languages.active && !store.getSiteUrl() ? [{ code: "cms-site-url-missing", severity: "warn" as const, file: "Lingue", message: "Il sito ha più lingue ma non il suo indirizzo: i link hreflang restano relativi e la sitemap non viene scritta. Aggiungilo nelle impostazioni del sito." }] : []),
    ];
    let previewUrl: string | null = null;
    if (result.status === "ready" && result.bundlePath) {
      // A draft or prototype preview is ephemeral and must never become eligible for publication.
      if (!previewPage && !options.throwaway) {
        context.registerBuild({ projectId: project.id, buildId, bundlePath: result.bundlePath, projectRevision: projectRevision!, files: result.files, pages: result.pages, assets: result.assets, totalBytes: result.totalBytes, findings });
        keepOutput = true;
      }
      const ticket = randomBytes(24).toString("base64url");
      context.registerPreview({ ticket, buildId, bundlePath: result.bundlePath });
      keepOutput = true;
      const previewPath = previewPage ? `${documentAddress(previewPage, store.getRenderSettings().locale).slice(1)}index.html` : "index.html";
      previewUrl = `http://127.0.0.1:${context.port}/__preview/${ticket}/${buildId}/${previewPath}`;
    } else if (result.bundlePath) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
    const { bundlePath: _privateBundlePath, ...publicResult } = result;
    return { ...publicResult, findings, id: buildId, previewUrl, contentRoutes, images, imagesNote: imageVariantSentence(images), current: result.status === "ready" && projectRevision === store.getProjectRevision(), deployments: [] };
  } catch (error) {
    if (!keepOutput && outputCanBeRemoved) await removeTemporary(outputDirectory);
    if (controller.signal.aborted || error instanceof HistosPublishError && error.code === "cancelled") budget.check();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortOnSignal);
    if (stagingRoot) await removeTemporary(stagingRoot);
  }
}

/**
 * Refusals of a build that come from the project itself, whatever the machine: the site does not build (a renderer
 * capability, the plan's limits and collisions or an address outside it, missing content, a reserved, oversized or
 * colliding output: the real build of the imported project would stop the same way). Any other
 * refusal of the project (a cms- code answered 4xx) counts too; a timeout, a busy folder, a cancellation or a disk
 * error does not, nor PREVIEW_ONLY_REFUSALS.
 */
const SITE_BUILD_REFUSALS: ReadonlySet<string> = new Set([
  "cms-capability-unavailable", "cms-build-route-collision", "cms-build-route-limit", "cms-build-content-limit", "cms-build-route-invalid",
  "cms-content-type-missing", "cms-content-asset-missing", "cms-content-asset-type-invalid", "reserved-generated-path", "source-too-large",
  "source-too-many-files", "path-collision", "cms-build-route-unplanned",
]);

/**
 * Refusals that find nothing wrong with the site: a project whose pages are all drafts is a valid prototype (one an
 * agent prepares for review before publishing, which the import takes); its build has no page to write yet, so only
 * its preview is unavailable. What that build would render besides its pages is still rendered
 * (renderPublishedContent), so that a published record, post or archive that does not build is still refused.
 */
const PREVIEW_ONLY_REFUSALS: ReadonlySet<string> = new Set(["cms-build-no-published-pages"]);

function siteBuildRefusal(error: unknown): error is HistosPublishError {
  if (!(error instanceof HistosPublishError) || PREVIEW_ONLY_REFUSALS.has(error.code)) return false;
  if (SITE_BUILD_REFUSALS.has(error.code)) return true;
  return error.code.startsWith("cms-") && error.exitCode >= 400 && error.exitCode < 500 && ![408, 409, 429, 499].includes(error.exitCode);
}

const documentOf = (document: string | undefined): { document?: string } => (document ? { document } : {});

/**
 * What an error of a throwaway build means for the check (prototypeBuild). A cancellation is rethrown. A site that does
 * not build (siteBuildRefusal) throws the check's refusal (D8) with the document it belongs to: the one whose blocks
 * were rendering (refusalDocument, by the render's origin), the page or post at its address, the template it names.
 * What is no fault of the site (a timeout, a busy folder, PREVIEW_ONLY_REFUSALS, the machine's failure:
 * previewMachineFailure) is returned: the reason the preview is unavailable. Any other error, which only the rendering
 * of the project's own content throws, is the site's too (prototypeBuildFailed, every path of `folders` hidden), at
 * the template, part or component whose blocks were rendering when a render threw it (its message names no address).
 */
function previewFailure(error: unknown, store: CmsProjectStore, folders: readonly string[], signal?: AbortSignal): string {
  if (signal?.aborted) throw error;
  if (error instanceof HistosPublishError && error.code === "cms-build-cancelled") throw error;
  if (siteBuildRefusal(error)) throw prototypeBuildRefused([{ message: error.message, ...documentOf(refusalDocument(documentAddresses(store), error.message, renderRefusalOrigin(error))) }]);
  if (error instanceof HistosPublishError) return error.message;
  const machine = previewMachineFailure(error);
  if (machine) return machine;
  const origin = renderRefusalOrigin(error);
  throw prototypeBuildFailed(error, folders, origin && origin.kind !== "content" ? `${origin.kind} ${origin.ref}` : undefined);
}

/**
 * What the build of a project with no published page (cms-build-no-published-pages) would write besides its pages,
 * rendered as buildCmsProject renders it once a page is published (the same plan, limits, budget and writers; form
 * endpoints not required, as for every preview) into a private staging folder, then removed: the front-page and 404
 * templates, the published posts and their index, the published records and every archive. It throws what that build
 * would throw; nothing is bundled, scanned or served. The steps are buildCmsProject's after its pages: a change there
 * belongs here too.
 */
async function renderPublishedContent(context: CmsOperationsContext, opened: { project: { id: string }; store: CmsProjectStore }, signal?: AbortSignal): Promise<void> {
  const { project, store } = opened;
  const limits: CmsBuildLimits = {
    maxRoutes: context.buildLimits?.maxRoutes ?? MAX_CMS_BUILD_ROUTES,
    timeoutMs: context.buildLimits?.timeoutMs ?? CMS_BUILD_TIMEOUT_MS,
  };
  const controller = new AbortController();
  const budget = new CmsBuildBudget(controller.signal, limits);
  const abortOnSignal = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abortOnSignal, { once: true });
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  timeout.unref?.();
  let stagingRoot: string | null = null;
  try {
    budget.check();
    // Named as the build's own staging, so that a raw EEXIST is read the same way (prototypeBuildFailed).
    stagingRoot = await mkdtemp(path.join(os.tmpdir(), "histos-cms-stage-"));
    const staticRoot = path.join(stagingRoot, "source");
    const mediaRoot = path.join(staticRoot, "media");
    await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
    const pages: CmsEntity[] = [];
    const posts = store.listPosts().filter((post) => isLive(post));
    const plan = planCmsRoutes(store, { pages, posts, maxRoutes: limits.maxRoutes, check: () => budget.check() });
    assertCmsRoutePlan(plan, limits.maxRoutes);
    const formStats: SkippedPages = { count: 0, skipped: [] };
    const defaultLocale = store.getRenderSettings().locale;
    await writeCmsRoleFiles({ store, projectId: project.id, staticRoot, mediaRoot, pages, posts, budget, plan, requireFormEndpoints: false, formStats });
    await writeCmsPostRoutes({ store, projectId: project.id, staticRoot, mediaRoot, pages, posts, defaultLocale, budget, plan, requireFormEndpoints: false, formStats });
    await writeCmsRecordRoutes({ store, projectId: project.id, staticRoot, mediaRoot, pages, defaultLocale, budget, plan, requireFormEndpoints: false, formStats });
    budget.check();
  } catch (error) {
    if (controller.signal.aborted || error instanceof HistosPublishError && error.code === "cancelled") budget.check();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortOnSignal);
    if (stagingRoot) await removeTemporary(stagingRoot);
  }
}

/** A throwaway build of a checked prototype that builds and could be published: buildCmsProject's id, address and findings. */
interface ThrowawayBuild {
  id: string;
  previewUrl: string;
  findings: Finding[];
  images?: ImageVariantSummary;
  /** Doc 17 item 4: the internal links of its pages that have no page (checkBuiltLinks), with a browser overflow and axe (checkBuiltPages). */
  verify: PreviewVerify;
}

/**
 * The throwaway build of a checked prototype into `directory` (buildCmsProject's `throwaway`: never registered), for
 * buildPrototypePreview and checkPrototypeBuild: the build when the site builds and publishing would take it,
 * otherwise the outcome that says why there is nothing to show. A site that does not build throws the check's
 * refusal (previewFailure). A project with only drafts has no build, and its published content is still rendered
 * (renderPublishedContent): refused when it does not build, the preview unavailable with the reason otherwise. A
 * bundle that publishing would block gives its blocking findings (publishBlocks), each with the document of its page
 * (documentAddresses, read once).
 */
async function prototypeBuild(context: CmsOperationsContext, opened: { project: { id: string }; store: CmsProjectStore }, directory: string, signal?: AbortSignal): Promise<{ built: ThrowawayBuild } | { outcome: PrototypePreviewOutcome }> {
  const folders = [context.dataDirectory, directory];
  let built: Record<string, unknown>;
  try {
    built = await buildCmsProject(context, opened, { throwaway: { directory }, ...(signal ? { signal } : {}) });
  } catch (error) {
    const reason = previewFailure(error, opened.store, folders, signal);
    if (!(error instanceof HistosPublishError && PREVIEW_ONLY_REFUSALS.has(error.code))) return { outcome: { status: "unavailable", reason } };
    try {
      await renderPublishedContent(context, opened, signal);
    } catch (failure) {
      return { outcome: { status: "unavailable", reason: `${reason} ${previewFailure(failure, opened.store, folders, signal)}` } };
    }
    return { outcome: { status: "unavailable", reason } };
  }
  const findings = Array.isArray(built.findings) ? built.findings as Finding[] : [];
  if (built.status !== "ready" || typeof built.previewUrl !== "string" || typeof built.id !== "string") {
    // A bundle blocked from publishing: the site builds, and publishing it would stop at these findings.
    const blocking = findings.filter((finding) => finding.severity === "block");
    if (built.status === "blocked" && blocking.length) {
      let addresses: ReadonlyMap<string, string> | undefined;
      const items = blocking.slice(0, 100).map((finding) => {
        const address = bundleFileAddress(finding.file);
        if (address) addresses ??= documentAddresses(opened.store);
        return { file: finding.file, ...(finding.line ? { line: finding.line } : {}), message: finding.message, ...documentOf(address ? addresses?.get(address) : undefined) };
      });
      return { outcome: { status: "unavailable", reason: "Il sito si costruisce, ma i controlli di sicurezza fermerebbero la pubblicazione: i motivi sono fra gli avvisi.", findings: findings.length, publishBlocks: { items, total: blocking.length } } };
    }
    return { outcome: { status: "unavailable", reason: "La versione dell'anteprima non è pronta: controlla gli avvisi dopo l'import.", findings: findings.length } };
  }
  const root = path.join(directory, built.id);
  const links = await checkBuiltLinks(root, signal);
  let verify: PreviewVerify = { pages: links.pages, brokenLinks: links.brokenLinks, ...(links.brokenTotal > links.brokenLinks.length ? { brokenTotal: links.brokenTotal } : {}) };
  // With a browser (the app's hidden window, the CLI's Playwright): sideways scrolling and axe on the built pages.
  if (context.openPageProbe) {
    let axe: Awaited<ReturnType<typeof loadAxeScript>> | null = null;
    try { axe = await loadAxeScript(); } catch { /* Said below: nothing checked in the browser. */ }
    const pages = axe ? await checkBuiltPages(root, context.openPageProbe, { axe, ...(signal ? { signal } : {}) }) : { opened: 0, overflow: [], axe: [], failures: ["axe-core non è installato con l'app: scorrimento e accessibilità non controllati."] };
    verify = { ...verify, ...pages };
  }
  return { built: { id: built.id, previewUrl: built.previewUrl, findings, verify, ...(built.images ? { images: built.images as ImageVariantSummary } : {}) } };
}

/**
 * The throwaway preview of a checked prototype (queue A2): the project the check imported into its scratch catalog,
 * built outside the registry (prototypeBuild). When the preview cannot be made (no previews in this app, a project
 * with only drafts, a full disk or another error of the machine, previewMachineFailure; a timeout, a busy folder) it
 * is "unavailable" with the reason, and the prototype stays valid. When the site itself does not build
 * (siteBuildRefusal, or any other error, which only the rendering of the project's own content throws; for a project
 * with only drafts, its published content) the prototype is invalid: this throws the check's refusal
 * (PrototypeInvalidError, 422 cms-prototype-invalid) with the reason as an issue and the document whose blocks were
 * rendering, so that no answer says valid while the build fails (D8). A site that builds but whose bundle would be
 * blocked from publishing (a secret, a server path in the content) stays valid: its preview is unavailable and the
 * blocking findings go to the check (publishBlocks), which lists them among the warnings. Only a cancellation stops
 * the check otherwise.
 */
export async function buildPrototypePreview(context: CmsOperationsContext, opened: { project: { id: string }; store: CmsProjectStore }, signal?: AbortSignal): Promise<PrototypePreviewOutcome> {
  const previews = context.prototypePreviews;
  if (!previews) return { status: "unavailable", reason: "L'anteprima del prototipo non è disponibile in questa app." };
  const result = await prototypeBuild(context, opened, previews.root, signal);
  if ("outcome" in result) return result.outcome;
  previews.track(result.built.id);
  return { status: "ready", buildId: result.built.id, previewUrl: result.built.previewUrl, expiresAt: new Date(Date.now() + PREVIEW_ADDRESS_TTL_MS).toISOString(), findings: result.built.findings.length, verify: result.built.verify, ...(result.built.images ? { images: result.built.images } : {}) };
}

/** What `preview` says in a check without a server when the site builds (checkPrototypeBuild). */
export const PROTOTYPE_BUILT_NOTE = "Il sito si costruisce. Qui non c'è un indirizzo di anteprima: per vederla, controlla il prototipo nell'app (un agente collegato all'app usa hp_check_prototype con preview: true).";

/**
 * A prototype check with the build its preview would make, for a caller with no server to show a preview (the CLI's
 * `histos-publish prototype check --preview`): checkPrototype with the same throwaway build as the app's check
 * (prototypeBuild) into a private folder of `scratchRoot` (mode 0700), never registered or served, removed before
 * this returns. So the same refusals (a site that does not build, D8, placed at its document) and the same warnings
 * (a bundle that publishing would block) as the app's check and hp_check_prototype with preview: true; instead of an
 * address, `preview` is { status: "built", findings, note: PROTOTYPE_BUILT_NOTE } when the site builds, or
 * "unavailable" with the reason. No catalog is compared: the outcome is "create". With `openPageProbe` (the CLI's
 * `prototype verify`, Playwright) the built pages are also opened in that browser (checkBuiltPages, doc 17 item 4).
 */
/** The picture of a site's card: the first image of its home page, or of its latest posts. */
function projectCover(store: CmsProjectStore, projectId: string): string | null {
  const home = store.listPages()[0];
  const candidates = [...(home ? [home] : []), ...store.listPosts().slice(-6).reverse()];
  const pattern = new RegExp(`/__cms-media/${projectId}/([0-9a-f-]{36})`, "u");
  for (const entity of candidates) {
    const found = pattern.exec(store.getRevision(entity.headRevision)?.content ?? "");
    if (found) return `/__cms-media/${projectId}/${found[1]}`;
  }
  return null;
}

const SPREAD_KEYS = ["design", "tokenOverrides", "siteTokens", "siteRecipes"] as const;

/**
 * One site's look on others: its Histeon CSS panel, tokens and recipes, nothing else (doc 23). Without `apply` it only says
 * what would change. With it, each site gets a copy first, so the change can be undone from that file.
 */
export async function spreadDesign(input: { catalog: CmsProjectCatalog; dataDirectory: string; from: string; to: readonly string[]; apply: boolean }): Promise<{ results: Array<{ id: string; name: string; changes: string[]; applied: boolean }> }> {
  const source = await input.catalog.openProject(input.from);
  if (!source) throw new TypeError("Il sito di partenza non esiste.");
  let look: Record<string, unknown>;
  try {
    const styles = source.store.getStyles();
    const data = styles ? stylesData(source.store.getHead(styles.id)?.content ?? "{}") as unknown as Record<string, unknown> : {};
    look = Object.fromEntries(SPREAD_KEYS.map((key) => [key, data[key] ?? {}]));
  } finally {
    source.store.close();
  }
  const results: Array<{ id: string; name: string; changes: string[]; applied: boolean }> = [];
  for (const id of input.to) {
    if (id === input.from) continue;
    const target = await input.catalog.openProject(id);
    if (!target) continue;
    try {
      const styles = target.store.getStyles();
      const head = styles ? target.store.getHead(styles.id) : null;
      if (!styles || !head) continue;
      const current = stylesData(head.content) as unknown as Record<string, unknown>;
      const changes: string[] = [];
      for (const key of SPREAD_KEYS) {
        const before = (current[key] ?? {}) as Record<string, unknown>;
        const after = (look[key] ?? {}) as Record<string, unknown>;
        for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) changes.push(name);
      }
      let applied = false;
      if (input.apply && changes.length) {
        const folder = path.join(input.dataDirectory, "backups", "prima-dello-stile", id);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(path.join(folder, `${new Date().toISOString().replaceAll(":", "-")}.histosproject`), await encodeNativeProjectArchive(target.project, target.store), { mode: 0o600 });
        const saved = target.store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({ ...current, ...look }) });
        applied = saved.status === "saved";
        if (applied) await input.catalog.saveManifest(target.project);
      }
      results.push({ id, name: target.project.name, changes: changes.slice(0, 40), applied });
    } finally {
      target.store.close();
    }
  }
  return { results };
}

export interface WordPressImportReport {
  projectId: string;
  name: string;
  pages: number;
  posts: number;
  terms: number;
  images: { saved: number; failed: number };
  /** What has no place in the project: forms, embeds, shortcodes, tables turned to text. */
  lost: Record<string, number>;
  /** Contents of kinds Publish does not take, with how many (custom post types, menus…). */
  skipped: Record<string, number>;
  failed: string[];
  /** What each article lost, so that it can be looked at: the totals alone do not say where. */
  articles: Array<{ title: string; lost: Record<string, number> }>;
  /**
   * Doc 23 items 119 and 177: posts whose featured image came and is their image (`page.image`), and the titles of those
   * whose text began with that same image, taken out of the text so that it does not show twice.
   */
  featuredImages: { posts: number; removedFromText: string[] };
}

/**
 * A site from WordPress's own export, without any plugin on it (doc 22 §R6). Pages and posts become article blocks and
 * images are fetched into the project, the way an imported site's are; everything else is listed in the report.
 */
export async function importWordPressExport(input: { catalog: CmsProjectCatalog; text: string; fetchAsset: PrototypeAssetFetcher; signal?: AbortSignal; onProgress?: (progress: PrototypeImportProgress) => void }): Promise<WordPressImportReport> {
  return importWordPressContent({ ...input, file: parseWxr(input.text) });
}

export async function importWordPressContent(input: { catalog: CmsProjectCatalog; file: WxrFile; fetchAsset: PrototypeAssetFetcher; signal?: AbortSignal; onProgress?: (progress: PrototypeImportProgress) => void }): Promise<WordPressImportReport> {
  const { file } = input;
  const report: Omit<WordPressImportReport, "projectId" | "name"> = { pages: 0, posts: 0, terms: 0, images: { saved: 0, failed: 0 }, lost: {}, skipped: {}, failed: [], articles: [], featuredImages: { posts: 0, removedFromText: [] } };
  const attachments = new Map(file.items.filter((item) => item.type === "attachment" && item.attachmentUrl).map((item) => [item.id, item]));
  const contents = file.items.filter((item) => {
    if (item.type === "page" || item.type === "post") return item.status !== "trash" && item.status !== "auto-draft";
    if (item.type !== "attachment") report.skipped[item.type || "?"] = (report.skipped[item.type || "?"] ?? 0) + 1;
    return false;
  }).map((item) => {
    const conversion = articleFromHtml(item.content);
    const thumbnail = attachments.get(item.thumbnailId);
    // The featured image opens the article, unless the text already has it. On a post whose image comes, this first
    // block is taken out again below (doc 23 item 177): the post shows it as `page.image`.
    const prepended = Boolean(thumbnail && !conversion.images.includes(thumbnail.attachmentUrl));
    if (thumbnail && prepended) {
      conversion.blocks.unshift({ type: "image", uid: "", src: thumbnail.attachmentUrl, alt: thumbnail.title, width: null, height: null, caption: "" });
      conversion.images.push(thumbnail.attachmentUrl);
    }
    for (const [name, count] of Object.entries(conversion.lost)) report.lost[name] = (report.lost[name] ?? 0) + count;
    return { item, conversion, prepended };
  });
  const wanted = [...new Set(contents.flatMap((entry) => entry.conversion.images))].filter((url) => url.startsWith("https://"));
  const media = new Map<string, Uint8Array>();
  let next = 0;
  let total = 0;
  const worker = async (): Promise<void> => {
    while (next < wanted.length && total < 1024 * 1024 * 1024 && !input.signal?.aborted) {
      const url = wanted[next++] as string;
      try {
        const bytes = await input.fetchAsset(url, 15 * 1024 * 1024, input.signal);
        total += bytes.length;
        media.set(url, bytes);
      } catch { /* It stays out and the report counts it. */ }
      input.onProgress?.({ phase: "media", done: next, total: wanted.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));
  input.signal?.throwIfAborted();
  const name = (file.title.trim() || "Sito WordPress").slice(0, 120);
  const opened = await input.catalog.createProject(name);
  const { project, store } = opened;
  try {
    const language = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(file.language) ? file.language : "it-IT";
    store.setRenderSettings({ ...store.getRenderSettings(), locale: language });
    const addresses = new Map<string, string>();
    for (const [url, bytes] of media) {
      const mimeType = sniffPrototypeMedia(bytes);
      if (!mimeType?.startsWith("image/")) continue;
      const filename = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "immagine").slice(0, 200) || "immagine";
      const asset = store.saveAsset({ bytes, mimeType, filename });
      addresses.set(url, `/__cms-media/${project.id}/${asset.id}`);
      report.images.saved += 1;
    }
    // Terms: their parents first, whatever the order in the file.
    for (const [key, label] of [["category", "Categorie"], ["post_tag", "Tag"]] as const) store.content.saveTaxonomy({ key, label, types: ["post"] });
    const termIds = new Map<string, string>();
    const open = [...file.terms].filter((term) => term.slug && term.name);
    for (let progress = true; progress && open.length;) {
      progress = false;
      for (const term of [...open]) {
        if (term.parent && !termIds.has(`${term.kind}:${term.parent}`) && open.some((other) => other.kind === term.kind && other.slug === term.parent)) continue;
        open.splice(open.indexOf(term), 1);
        progress = true;
        const saved = store.content.saveTerm({ taxonomyKey: term.kind, slug: term.slug, label: term.name.slice(0, 120), parentId: term.parent ? termIds.get(`${term.kind}:${term.parent}`) ?? null : null });
        if (saved.status === "saved") { termIds.set(`${term.kind}:${term.slug}`, saved.term.id); report.terms += 1; }
      }
    }
    const homePage = store.listPages()[0];
    const imageAssets = new Map(store.listAssets().filter((asset) => asset.mimeType.startsWith("image/")).map((asset) => [asset.id, asset]));
    const assetOf = (url: string): string | undefined => /\/([0-9a-f-]{36})$/u.exec(addresses.get(url) ?? "")?.[1];
    for (const [position, { item, conversion, prepended }] of contents.entries()) {
      if (position % 25 === 0) input.onProgress?.({ phase: "documents", done: position, total: contents.length });
      const lost = { ...conversion.lost };
      const title = (item.title.trim() || "Senza titolo").slice(0, 500);
      // Doc 23 item 119: the featured image that came is also the post's image.
      const thumbnailUrl = item.type === "post" ? attachments.get(item.thumbnailId)?.attachmentUrl : undefined;
      const thumbnailId = thumbnailUrl ? assetOf(thumbnailUrl) : undefined;
      const imageAssetId = thumbnailId && imageAssets.has(thumbnailId) ? thumbnailId : null;
      // Doc 23 item 177: a template that shows `page.image` would show it twice. The block put on top above goes; of the
      // text, only its very first block, and only when it is the same media of the project (same address, or the same
      // file under another one) without a caption.
      const own = imageAssetId !== null && prepended ? conversion.blocks.slice(1) : conversion.blocks;
      const first = own[0];
      const doubled = imageAssetId !== null && first?.type === "image" && !first.caption && assetOf(first.src) === imageAssetId;
      if (imageAssetId) report.featuredImages.posts += 1;
      if (doubled) {
        if (report.featuredImages.removedFromText.length < 500) report.featuredImages.removedFromText.push(title.slice(0, 200));
        // The text's description of the image is kept on the media, where `page.image` reads it.
        const media = imageAssets.get(imageAssetId);
        if (media && !media.alt && first.alt.trim()) {
          const updated = store.updateAsset(media.alias, { alt: first.alt.trim().slice(0, 2000) });
          if (updated) imageAssets.set(imageAssetId, { ...media, alt: updated.alt });
        }
      }
      const blocks = (doubled ? own.slice(1) : own).flatMap((block): ArticleBlock[] => {
        if (block.type !== "image") return [block];
        const address = addresses.get(block.src);
        if (address) return [{ ...block, src: address }];
        // An image that did not come stays as its address: the article says where it was, and nothing goes unnoticed.
        report.images.failed += 1;
        lost["immagine non scaricata"] = (lost["immagine non scaricata"] ?? 0) + 1;
        const words = (block.alt || block.src.split(/[?#]/u)[0]?.split("/").pop() || "Immagine").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        return /^https:\/\//iu.test(block.src) && !/["\s]/u.test(block.src) ? [{ type: "paragraph", uid: "", html: `<a href="${block.src.replaceAll("&", "&amp;")}">${words}</a>` }] : [];
      });
      if (Object.keys(lost).length && report.articles.length < 500) report.articles.push({ title: item.title.slice(0, 200), lost });
      const slug = item.slug || undefined;
      const status = item.status === "publish" ? "published" as const : "draft" as const;
      try {
        const content = writeArticle("", blocks, { mediaBase: `/__cms-media/${project.id}`, rulesOf: (ref) => cardRules(store, ref) });
        for (const block of blocks) if (block.type === "card") installCard(store, block.ref);
        if (item.type === "post") {
          const terms: Record<string, string[]> = {};
          for (const term of item.terms) {
            const id = termIds.get(`${term.kind}:${term.slug}`);
            if (id) terms[term.kind] = [...(terms[term.kind] ?? []), id];
          }
          const post = store.createPost({ title, ...(slug ? { slug } : {}), content, status, publishedAt: status === "published" ? item.date ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z") : null, excerpt: item.excerpt.slice(0, 2000), imageAssetId, terms });
          if (item.seoTitle || item.seoDescription) store.setSeo(post.id, { title: item.seoTitle, description: item.seoDescription });
          report.posts += 1;
        } else if (homePage && slug === homePage.slug) {
          store.saveDocument({ entityId: homePage.id, expectedHead: homePage.headRevision, content });
          report.pages += 1;
        } else {
          const page = store.createPage({ title, ...(slug ? { slug } : {}), content, status });
          if (item.seoTitle || item.seoDescription) store.setSeo(page.id, { title: item.seoTitle, description: item.seoDescription });
          report.pages += 1;
        }
      } catch (error) {
        report.failed.push(`${title}: ${error instanceof Error ? error.message : "non importato"}`.slice(0, 300));
      }
    }
    report.failed = report.failed.slice(0, 50);
    await input.catalog.saveManifest(project);
    return { projectId: project.id, name, ...report };
  } finally {
    store.close();
  }
}

export async function checkPrototypeBuild(html: string, options: { scratchRoot: string; download?: boolean; strict?: boolean; fetchAsset?: PrototypeAssetFetcher; signal?: AbortSignal; onProgress?: (progress: PrototypeImportProgress) => void; buildBundle?: CmsBuildBundle; buildLimits?: Partial<CmsBuildLimits>; openPageProbe?: OpenPageProbe; convertedMedia?: (sha256: string) => Uint8Array | null; onBuilt?: (bundlePath: string) => Promise<void> }): Promise<PrototypeCheckResult> {
  await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(path.join(options.scratchRoot, ".prototype-build-"));
  const builds = path.join(folder, "builds");
  const context: CmsOperationsContext = {
    catalog: new CmsProjectCatalog(path.join(folder, "catalog"), { durable: false }),
    dataDirectory: folder,
    port: 0,
    registerPreview: () => undefined,
    registerBuild: () => undefined,
    ...(options.buildBundle ? { buildBundle: options.buildBundle } : {}),
    ...(options.buildLimits ? { buildLimits: options.buildLimits } : {}),
    ...(options.openPageProbe ? { openPageProbe: options.openPageProbe } : {}),
    ...(options.convertedMedia ? { convertedMedia: options.convertedMedia } : {}),
  };
  try {
    return await checkPrototype(html, {
      scratchRoot: options.scratchRoot,
      ...(options.convertedMedia ? { convertedMedia: options.convertedMedia } : {}),
      ...(options.download ? { download: true } : {}),
      ...(options.strict ? { strict: true } : {}),
      ...(options.fetchAsset ? { fetchAsset: options.fetchAsset } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      preview: async (opened, signal) => {
        const result = await prototypeBuild(context, opened, builds, signal);
        if ("outcome" in result) return result.outcome;
        // «Uguale alla proposta»: the built site, for as long as the caller looks at it, before it is removed.
        try { await options.onBuilt?.(path.join(builds, result.built.id)); }
        finally { await rm(path.join(builds, result.built.id), { recursive: true, force: true }); }
        return { status: "built", findings: result.built.findings.length, note: PROTOTYPE_BUILT_NOTE, verify: result.built.verify, ...(result.built.images ? { images: result.built.images } : {}) };
      },
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Same lifetime as every preview address the server hands out (server.ts PREVIEW_TTL_MS). */
const PREVIEW_ADDRESS_TTL_MS = 5 * 60 * 1000;

/** A new address for a throwaway prototype preview that is still on disk. */
export async function reopenPrototypePreview(context: CmsOperationsContext, buildId: string): Promise<{ previewUrl: string; expiresAt: string }> {
  const folder = await context.prototypePreviews?.folder(buildId);
  if (!folder) throw new HistosPublishError("L'anteprima di questo prototipo non c'è più: ricontrolla il file.", "cms-prototype-preview-missing", 404);
  const ticket = randomBytes(24).toString("base64url");
  context.registerPreview({ ticket, buildId, bundlePath: folder });
  return { previewUrl: `http://127.0.0.1:${context.port}/__preview/${ticket}/${buildId}/index.html`, expiresAt: new Date(Date.now() + PREVIEW_ADDRESS_TTL_MS).toISOString() };
}

export async function handleCmsApi(request: IncomingMessage, response: ServerResponse, segments: string[], url: URL, context: CmsApiContext): Promise<boolean> {
  if (segments[1] !== "cms" || segments[2] !== "v1") return false;
  const parts = [...segments.slice(0, 2), ...segments.slice(3)];
  const method = request.method ?? "GET";
  if (parts[2] === "destinations" && parts.length === 4 && (parts[3] === "plan" || parts[3] === "apply" || parts[3] === "rollback")) {
    if (method !== "POST") throw new HistosPublishError("Usa POST per preparare o applicare un piano di destinazione.", "cms-method-not-allowed", 405);
    const body = await readJson(request, 64 * 1024);
    if (typeof body.destinationId !== "string" || body.destinationId.length > 128) {
      throw new HistosPublishError("Seleziona una destinazione salvata valida.", "cms-destination-invalid", 400);
    }
    const destinationId = body.destinationId;
    const projectId = body.projectId === undefined ? undefined : typeof body.projectId === "string" && UUID.test(body.projectId) ? body.projectId : null;
    if (projectId === null) throw new HistosPublishError("Identificativo del progetto CMS non valido.", "cms-project-invalid", 400);
    const destination = context.resolveDestination({ destinationId, ...(projectId ? { projectId } : {}) });

    if (parts[3] === "rollback") {
      if (body.confirmed !== true) throw new HistosPublishError("Conferma il ripristino prima di continuare.", "confirmation-required", 428);
      if (destination.kind !== "static-cloudflare" && destination.kind !== "static-hosting") {
        throw new HistosPublishError("Il ripristino remoto WordPress non è ancora supportato da questo collegamento.", "cms-destination-rollback-unsupported", 409);
      }
      if (!projectId || typeof body.buildId !== "string" || !UUID.test(body.buildId) || typeof body.deploymentId !== "string" || !UUID.test(body.deploymentId)) {
        throw new HistosPublishError("Il progetto, la versione e la pubblicazione da ripristinare non sono validi.", "cms-deployment-invalid", 400);
      }
      const result = await context.rollbackDeployment({ projectId, buildId: body.buildId, deploymentId: body.deploymentId, expectedDestinationId: destinationId });
      sendJson(response, 202, result);
      return true;
    }

    if (parts[3] === "plan") {
      if (destination.kind === "wordpress-existing") {
        if (body.action !== "pull" && body.action !== "push" && body.action !== "publish") {
          throw new HistosPublishError("Per WordPress scegli scarica, invia bozze o pubblica.", "cms-remote-action-invalid", 400);
        }
        const connectionId = destinationId.slice("wordpress:".length);
        // Doc 23 items 199-200: a download of only some entries of the site, which the plan completes and checks.
        const only = parseBringIds(body.only);
        if (only && body.action !== "pull") throw new HistosPublishError("Si portano nel progetto contenuti solo scaricando.", "cms-remote-bring-invalid", 400);
        const plan = await createRemoteSyncPlan({ action: body.action, connectionId, ...(projectId ? { projectId } : {}), ...(only ? { only } : {}) }, context.remoteCatalog, context.catalog, context.secretStoreFor);
        if (plan.destination.id !== destinationId || (projectId && plan.action !== "pull" && plan.project.id !== projectId)) {
          throw new HistosPublishError("Il piano WordPress non corrisponde alla destinazione o al progetto richiesto.", "cms-destination-plan-invalid", 500);
        }
        sendJson(response, 200, plan);
        return true;
      }
      if (destination.kind !== "static-cloudflare" && destination.kind !== "static-hosting") {
        throw new HistosPublishError("Questa destinazione richiede il flusso guidato di installazione WordPress.", "cms-destination-operation-unsupported", 409);
      }
      if (body.action !== "deploy" || !projectId || typeof body.buildId !== "string" || !UUID.test(body.buildId)) {
        throw new HistosPublishError("Per pubblicare file statici seleziona progetto, versione e azione di deploy.", "cms-destination-plan-invalid", 400);
      }
      const openedProject = await context.catalog.openProject(projectId);
      if (!openedProject) throw new HistosPublishError("Progetto CMS non trovato.", "cms-project-missing", 404);
      try {
        const plan = await context.createPublishPlan({ projectId, buildId: body.buildId, targetSiteId: destinationId, projectRevision: openedProject.store.getProjectRevision() });
        if (plan.projectId !== projectId || plan.buildId !== body.buildId || plan.destination.id !== destinationId || plan.writeVerified !== false) {
          throw new HistosPublishError("Il piano di pubblicazione non corrisponde alla richiesta.", "cms-destination-plan-invalid", 500);
        }
        sendJson(response, 200, plan);
      } finally {
        openedProject.store.close();
      }
      return true;
    }

    if (body.confirmed !== true) throw new HistosPublishError("Conferma il piano prima di applicarlo.", "confirmation-required", 428);
    if (typeof body.planId !== "string" || !UUID.test(body.planId)) throw new HistosPublishError("Il piano non è valido o è scaduto. Preparane uno nuovo.", "cms-destination-plan-invalid", 400);
    if (destination.kind === "wordpress-existing") {
      if (body.action !== "pull" && body.action !== "push" && body.action !== "publish") throw new HistosPublishError("L’azione WordPress del piano non è valida.", "cms-remote-action-invalid", 400);
      const connectionId = destinationId.slice("wordpress:".length);
      const rawResolutions = body.resolutions === undefined ? {} : body.resolutions;
      if (!rawResolutions || typeof rawResolutions !== "object" || Array.isArray(rawResolutions) || Object.keys(rawResolutions).length > 250) throw new HistosPublishError("Le scelte dei conflitti non sono valide.", "cms-sync-resolution-invalid", 400);
      const resolutions: Record<string, "keep-local" | "use-remote"> = {};
      for (const [id, choice] of Object.entries(rawResolutions)) {
        if (!UUID.test(id) || (choice !== "keep-local" && choice !== "use-remote")) throw new HistosPublishError("Le scelte dei conflitti non sono valide.", "cms-sync-resolution-invalid", 400);
        resolutions[id] = choice;
      }
      try {
        const result = await applyRemoteSyncPlan({ connectionId, planId: body.planId, ...(projectId ? { expectedProjectId: projectId } : {}), resolutions }, context.remoteCatalog, context.catalog, context.secretStoreFor);
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof CmsSyncConflictError) {
          sendJson(response, 409, { error: error.message, code: "cms-sync-conflict", conflicts: error.conflicts, complete: false });
          return true;
        }
        throw error;
      }
      return true;
    }
    if (destination.kind !== "static-cloudflare" && destination.kind !== "static-hosting") {
      throw new HistosPublishError("Questa destinazione non supporta l’applicazione di un piano statico.", "cms-destination-operation-unsupported", 409);
    }
    if (body.action !== "deploy" || !projectId) throw new HistosPublishError("Il piano statico richiede progetto e azione di deploy.", "cms-destination-plan-invalid", 400);
    const openedProject = await context.catalog.openProject(projectId);
    if (!openedProject) throw new HistosPublishError("Progetto CMS non trovato.", "cms-project-missing", 404);
    try {
      const result = await context.executePublishPlan({ projectId, planId: body.planId, projectRevision: openedProject.store.getProjectRevision(), expectedDestinationId: destinationId });
      sendJson(response, 202, result);
    } finally {
      openedProject.store.close();
    }
    return true;
  }
  if (parts[2] === "figma-token" && parts.length === 3) {
    // The token of the REST API of Figma, in the keyring: whether it is there, never what it is (cms-token-source.ts).
    const store = context.secretStoreFor(FIGMA_TOKEN_ACCOUNT);
    if (method === "GET") {
      sendJson(response, 200, { token: await figmaTokenState(store) });
      return true;
    }
    if (method === "POST") {
      sendJson(response, 200, await saveFigmaToken(await readJson(request, 16 * 1024), store));
      return true;
    }
    if (method === "DELETE") {
      sendJson(response, 200, await removeFigmaToken(store));
      return true;
    }
  }
  if (parts[2] === "design-file" && parts.length === 4 && (parts[3] === "pages" || parts[3] === "prototype")) {
    // «Nuovo sito da Penpot o Figma» (cms-design-source.ts): the uploaded file answers its pages and frames, then
    // one frame as a prototype. Nothing is saved: the app sends the prototype to projects/import-prototype.
    if (method !== "POST") throw new HistosPublishError("Usa POST per caricare il file di design.", "cms-method-not-allowed", 405);
    const name = designSourceName(url.searchParams.get("name"));
    // The choices are read before the body: a wrong address is refused without reading half a gigabyte.
    const choice = parts[3] === "prototype" ? designSourceChoice(url.searchParams) : null;
    const bytes = await readBytes(request, DESIGN_SOURCE_FILE_MAX, "Il file di design");
    sendJson(response, 200, choice ? await designPrototypeFromFile(name, bytes, choice) : await designPagesFromFile(name, bytes));
    return true;
  }
  if (parts[2] === "connections" && parts.length === 3) {
    if (method === "GET") {
      sendJson(response, 200, { connections: context.remoteCatalog.list().map((connection) => ({ ...connection, operations: context.remoteCatalog.listOperations(connection.id), histeon: connectionHisteonNotice(connection) })) });
      return true;
    }
    if (method === "POST") {
      const body = await readJson(request, 20 * 1024);
      if (typeof body.code !== "string") throw new HistosPublishError("Incolla il codice di collegamento creato in Histeon WordPress.", "cms-remote-code-invalid", 400);
      if (body.connectionId !== undefined && (typeof body.connectionId !== "string" || !isConnectionId(body.connectionId))) {
        throw new HistosPublishError("Seleziona un collegamento Histeon valido da aggiornare.", "cms-remote-connection-id-invalid", 400);
      }
      const connection = await connectRemoteSite(body.code, context.remoteCatalog, context.secretStoreFor, body.connectionId as string | undefined);
      sendJson(response, body.connectionId ? 200 : 201, { connection: { ...connection, histeon: connectionHisteonNotice(connection) } });
      return true;
    }
  }
  // Doc 23 item 237: pairing from the site, in one click (cms-remote.ts, startRemotePairing).
  if (parts[2] === "pairings" && parts.length === 3 && method === "POST") {
    const body = await readJson(request, 4 * 1024);
    if (typeof body.siteUrl !== "string" || body.siteUrl.length > 2048) throw new HistosPublishError("Scrivi l'indirizzo del sito WordPress.", "cms-remote-url-invalid", 400);
    sendJson(response, 201, startRemotePairing(body.siteUrl));
    return true;
  }
  if (parts[2] === "pairings" && parts.length === 4 && method === "GET") {
    const site = pendingPairingSite(parts[3]!);
    if (!site) throw new HistosPublishError("Questo abbinamento non è stato avviato da Histeon Publish, o è scaduto.", "cms-pairing-unknown", 404);
    sendJson(response, 200, { siteUrl: site });
    return true;
  }
  if (parts[2] === "pairings" && parts.length === 5 && parts[4] === "claim" && method === "POST") {
    const body = await readJson(request, 4 * 1024);
    if (typeof body.claim !== "string") throw new HistosPublishError("Il link di abbinamento non è valido.", "cms-pairing-invalid", 400);
    const connection = await claimRemotePairing({ state: parts[3]!, claim: body.claim }, context.remoteCatalog, context.secretStoreFor);
    sendJson(response, 201, { connection: { ...connection, histeon: connectionHisteonNotice(connection) } });
    return true;
  }
  if (parts[2] === "connections" && [4, 5, 7].includes(parts.length) && isConnectionId(parts[3]!)) {
    const connection = context.remoteCatalog.get(parts[3]!);
    if (!connection) throw new HistosPublishError("Collegamento remoto non trovato.", "cms-remote-connection-missing", 404);
    if (parts.length === 4 && method === "DELETE") {
      const localOnly = url.searchParams.get("localOnly") === "true";
      const remoteAccess = localOnly ? "left-active" : await revokeRemotePairing(connection, context.secretStoreFor);
      context.remoteCatalog.remove(connection.id);
      await context.secretStoreFor(`cms-remote-${connection.id}`).delete();
      sendJson(response, 200, { removed: true, id: connection.id, remoteAccess });
      return true;
    }
    if (parts[4] === "plan" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (body.action !== "pull" && body.action !== "push" && body.action !== "publish") throw new HistosPublishError("Scegli scarica aggiornamenti, invia bozze o pubblica.", "cms-remote-action-invalid", 400);
      const destination = context.resolveDestination({ destinationId: `wordpress:${connection.id}`, ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}) });
      if (destination.kind !== "wordpress-existing" || (body.action !== "pull" && !destination.wordpress.publishPermission)) {
        throw new HistosPublishError("Questo collegamento WordPress non consente l’operazione richiesta.", "cms-remote-write-forbidden", 403);
      }
      const plan = await createRemoteSyncPlan({ action: body.action, connectionId: connection.id, ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}) }, context.remoteCatalog, context.catalog, context.secretStoreFor);
      sendJson(response, 200, plan);
      return true;
    }
    if (parts[4] === "check" && parts.length === 5 && method === "POST") {
      // Doc 23 item 197: the site's own reading, named content by content, before any send. It only reads.
      const body = await readJson(request, 4096);
      const projectId = body.projectId === undefined ? undefined : typeof body.projectId === "string" && UUID.test(body.projectId) ? body.projectId : null;
      if (projectId === null) throw new HistosPublishError("Identificativo del progetto CMS non valido.", "cms-project-invalid", 400);
      const result = await checkRemoteSite({ connectionId: connection.id, ...(projectId ? { projectId } : {}) }, context.remoteCatalog, context.catalog, context.secretStoreFor);
      sendJson(response, 200, result);
      return true;
    }
    if (parts[4] === "check" && parts[5] === "browser" && parts.length === 6 && method === "POST") {
      // V1.6, threat model T32: the pages that change in development opened in the hidden window, axe and the external
      // links. The signed links stay inside checkRemoteSiteInBrowser; the answer names pages without the token.
      await readJson(request, 1024);
      if (!context.openPageProbe) throw new HistosPublishError("La verifica nel browser c'è solo nell'app desktop.", "cms-site-check-no-browser", 409);
      if (remoteBrowserChecksRunning.has(connection.id)) throw new HistosPublishError("La verifica nel browser di questo sito è già in corso.", "cms-site-check-browser-running", 409);
      remoteBrowserChecksRunning.add(connection.id);
      try {
        let axe: Awaited<ReturnType<typeof loadAxeScript>> | null = null;
        try { axe = await loadAxeScript(); } catch { /* Said by the report: accessibility not checked. */ }
        sendJson(response, 200, await checkRemoteSiteInBrowser({ connectionId: connection.id }, context.remoteCatalog, context.secretStoreFor, { openProbe: context.openPageProbe, axe }));
      } finally {
        remoteBrowserChecksRunning.delete(connection.id);
      }
      return true;
    }
    // Doc 23 item 201: after a send with publishing, the proposal of the site's home and posts page, and the user's
    // answer. The pages come from the project on the server; the app only says yes or no.
    if (parts[4] === "front-page" && parts.length === 5 && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      sendJson(response, 200, { offer: await frontPageOffer({ connectionId: connection.id, projectId }, context.remoteCatalog, context.catalog, context.secretStoreFor) });
      return true;
    }
    if (parts[4] === "front-page" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 1024);
      if (Object.keys(body).length !== 2 || typeof body.projectId !== "string" || typeof body.accept !== "boolean") throw new HistosPublishError("Rispondi sì o no alla proposta della pagina iniziale.", "cms-front-page-answer-invalid", 400);
      sendJson(response, 200, await answerFrontPageOffer({ connectionId: connection.id, projectId: body.projectId, accept: body.accept }, context.remoteCatalog, context.catalog, context.secretStoreFor));
      return true;
    }
    if (parts[4] === "operations" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, { operations: context.remoteCatalog.listOperations(connection.id) });
      return true;
    }
    if (parts[4] === "operations" && parts.length === 7 && parts[6] === "check" && method === "POST") {
      if (!isConnectionId(parts[5]!)) throw new HistosPublishError("Identificativo operazione remota non valido.", "cms-remote-operation-invalid", 400);
      const result = await checkRemoteOperation({ connectionId: connection.id, operationId: parts[5]! }, context.remoteCatalog, context.catalog, context.secretStoreFor);
      sendJson(response, 200, result);
      return true;
    }
    if (parts[4] === "operations" && parts.length === 7 && parts[6] === "rollback" && method === "POST") {
      if (!isConnectionId(parts[5]!)) throw new HistosPublishError("Identificativo operazione remota non valido.", "cms-remote-operation-invalid", 400);
      const body = await readJson(request, 4096);
      if (body.confirmed !== true) throw new HistosPublishError("Conferma il ripristino prima di modificare il sito WordPress.", "confirmation-required", 428);
      const result = await rollbackRemoteOperation({ connectionId: connection.id, operationId: parts[5]! }, context.remoteCatalog, context.catalog, context.secretStoreFor);
      sendJson(response, 200, result);
      return true;
    }
    if (parts[4] === "apply" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 64 * 1024);
      if (typeof body.planId !== "string") throw new HistosPublishError("Rivedi di nuovo le modifiche prima di applicarle.", "cms-sync-plan-invalid", 400);
      const rawResolutions = body.resolutions === undefined ? {} : body.resolutions;
      if (!rawResolutions || typeof rawResolutions !== "object" || Array.isArray(rawResolutions) || Object.keys(rawResolutions).length > 250) throw new HistosPublishError("Le scelte dei conflitti non sono valide.", "cms-sync-resolution-invalid", 400);
      const resolutions: Record<string, "keep-local" | "use-remote"> = {};
      for (const [id, choice] of Object.entries(rawResolutions)) {
        if (!UUID.test(id) || (choice !== "keep-local" && choice !== "use-remote")) throw new HistosPublishError("Le scelte dei conflitti non sono valide.", "cms-sync-resolution-invalid", 400);
        resolutions[id] = choice;
      }
      try {
        const result = await applyRemoteSyncPlan({ connectionId: connection.id, planId: body.planId, resolutions }, context.remoteCatalog, context.catalog, context.secretStoreFor);
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof CmsSyncConflictError) {
          sendJson(response, 409, { error: error.message, code: "cms-sync-conflict", conflicts: error.conflicts, complete: false });
          return true;
        }
        throw error;
      }
      return true;
    }
    if (parts[4] === "sync" && parts.length === 5) {
      if (method !== "POST") throw new HistosPublishError("Usa il metodo POST per avviare la revisione di una sincronizzazione.", "cms-method-not-allowed", 405);
      throw new HistosPublishError("La sincronizzazione diretta è disattivata. Crea un piano, rivedi il diff e applica solo quel piano.", "cms-sync-plan-required", 428);
    }
  }
  if (parts[2] === "projects" && parts.length === 3) {
    if (method === "GET") {
      const listed = await context.catalog.listProjectsWithProblems();
      // E9: where each project comes from and what it holds, for the catalog cards (one project open at a time).
      const connected = new Set(context.remoteCatalog.list().map((connection) => connection.projectId).filter((id): id is string => typeof id === "string"));
      const projects: Array<Record<string, unknown>> = [];
      const unavailable = [...listed.unavailable];
      for (const project of listed.projects) {
        // One project that fails now (gone meanwhile, a damaged database) is listed as unavailable, not a 500.
        try {
          const opened = await context.catalog.openProject(project.id);
          if (!opened) continue;
          try {
            const origin = connected.has(project.id) ? "wordpress" : opened.store.hasSyncBases(project.id) ? "file" : "local";
            // The last build, and whether the project changed after it.
            const build = context.latestBuild?.(project.id) ?? null;
            const lastBuild = build ? { at: build.createdAt, current: build.projectRevision === opened.store.getProjectRevision() } : null;
            projects.push({ ...projectInfo(project), summary: { pages: opened.store.listPages().length, posts: opened.store.listPosts().length, origin, lastBuild, cover: projectCover(opened.store, project.id) } });
          } finally {
            opened.store.close();
          }
        } catch (error) {
          unavailable.push({ id: project.id, message: error instanceof Error ? error.message.slice(0, 300) : "Progetto non leggibile." });
        }
      }
      sendJson(response, 200, { projects, unavailable });
      return true;
    }
    if (method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (typeof body.name !== "string") throw new HistosPublishError("Il nome del progetto è obbligatorio.", "cms-project-name-invalid", 400);
      const created = await context.catalog.createProject(body.name);
      const project = projectInfo(created.project);
      const pages = created.store.listPages();
      const styles = created.store.getStyles();
      created.store.close();
      sendJson(response, 201, { project, pages, styles });
      return true;
    }
  }

  if (parts[2] === "projects" && parts[3] === "import" && parts.length === 4 && method === "POST") {
    const contentType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/zip") throw new HistosPublishError("Carica un archivio .xbsite v2.", "cms-transfer-type-invalid", 415);
    const archive = Buffer.from(await readBytes(request, MAX_TRANSFER_BYTES, "L’archivio .xbsite"));
    let decoded: Awaited<ReturnType<typeof decodeStaticPageArchive>>;
    try { decoded = await decodeStaticPageArchive(archive); }
    catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Archivio .xbsite non valido.", error instanceof UnreadableArchiveError ? "cms-archive-invalid" : "cms-transfer-invalid", 422); }
    await importProfileFromFile(context, response, decoded, url.searchParams.get("update") === "1");
    return true;
  }

  if (parts[2] === "projects" && parts[3] === "spread-design" && parts.length === 4 && method === "POST") {
    const body = await readJson(request, 64 * 1024);
    const ids = body.to;
    if (typeof body.from !== "string" || !UUID.test(body.from) || !Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== "string" || !UUID.test(id))) throw new HistosPublishError("Siti non validi.", "cms-spread-invalid", 400);
    sendJson(response, 200, await spreadDesign({ catalog: context.catalog, dataDirectory: context.dataDirectory, from: body.from, to: ids as string[], apply: body.apply === true }));
    return true;
  }
  if (parts[2] === "projects" && parts[3] === "import-wordpress" && parts.length === 4 && method === "POST") {
    const fromSite = (request.headers["content-type"] ?? "").startsWith("application/json");
    const bytes = await readBytes(request, MAX_WXR_BYTES, "Il file di WordPress");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(new HistosPublishError("Import annullato.", "cms-import-cancelled", 499)); };
    response.once("close", abort);
    try {
      const fetchAsset = context.fetchPrototypeAsset ?? fetchPrototypeAsset;
      const progressToken = ImportProgressBoard.token(url.searchParams.get("progress"));
      const board = context.importProgress;
      const onProgress = progressToken && board ? { onProgress: (progress: PrototypeImportProgress) => board.set(progressToken, progress) } : {};
      if (fromSite) {
        const address = (JSON.parse(text) as { url?: unknown }).url;
        if (typeof address !== "string" || !address.trim()) throw new TypeError("Scrivi l'indirizzo del sito.");
        const file = await readWordPressSite({ url: address, signal: controller.signal, ...(context.fetchWordPressJson ? { fetchJson: context.fetchWordPressJson } : {}) });
        sendJson(response, 201, await importWordPressContent({ catalog: context.catalog, file, fetchAsset, signal: controller.signal, ...onProgress }));
      } else sendJson(response, 201, await importWordPressExport({ catalog: context.catalog, text, fetchAsset, signal: controller.signal, ...onProgress }));
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw new HistosPublishError(error.message, "cms-wordpress-import-invalid", 422);
      throw error;
    } finally {
      response.off("close", abort);
    }
    return true;
  }
  if (parts[2] === "projects" && parts[3] === "import-prototype" && parts.length === 4 && method === "POST") {
    const contentType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "text/html") throw new HistosPublishError("Carica un prototipo Histeon (.html).", "cms-prototype-type-invalid", 415);
    // ?check=1 checks everything an import would and writes nothing: remote media stand in as placeholders unless
    // ?download=1 asks to fetch them too (docs/progettazione/histos-cms/15-coda-import-html.md, A1).
    const check = url.searchParams.get("check") === "1";
    const download = check ? url.searchParams.get("download") === "1" : url.searchParams.get("download") !== "0";
    const html = new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(request, PROTOTYPE_MAX_BYTES, "Il prototipo"));
    // D3: the app may name a progress entry (?progress=<uuid>) and read it while this request runs.
    const progressToken = ImportProgressBoard.token(url.searchParams.get("progress"));
    const board = context.importProgress;
    const onProgress = progressToken && board ? { onProgress: (progress: PrototypeImportProgress) => board.set(progressToken, progress) } : {};
    if (!check) {
      // A client that leaves (the app's Annulla) stops the import before it writes the project.
      const controller = new AbortController();
      const abort = () => { if (!response.writableEnded) controller.abort(new HistosPublishError("Import annullato.", "cms-import-cancelled", 499)); };
      response.once("close", abort);
      try {
        const result = await importFromApp(context, url.searchParams.get("update") === "1", (options) => importPrototypeHtml(context, html, { download, signal: controller.signal, ...onProgress, ...options, ...(context.convertedMedia ? { convertedMedia: context.convertedMedia } : {}) }));
        sendJson(response, result.status, result.body);
      } finally {
        response.off("close", abort);
        if (progressToken) board?.finish(progressToken);
      }
      return true;
    }
    if (check) {
      // ?preview=1 also builds a throwaway preview of the checked prototype (A2); a client that leaves stops it.
      const preview = url.searchParams.get("preview") === "1" ? { preview: (opened: { project: { id: string }; store: CmsProjectStore }, signal?: AbortSignal) => buildPrototypePreview(context, opened, signal) } : {};
      const controller = new AbortController();
      const abort = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", abort);
      let checked: Awaited<ReturnType<typeof checkPrototype>>;
      try {
        // An update compared with placeholders for its remote media is no comparison: each placeholder differs from the
        // image the project holds, so every remote media would read as modified, and one whose alt text was edited in
        // Publish as a conflict, while the update (which downloads them) would change nothing there. Such a check stops
        // as soon as it knows it is an update the project can take (its backup measured and read: a damaged or busy
        // project is refused here, before any download), with no list, no dry run and no preview, all of which would be
        // thrown away: `changesNeedDownload` asks for the check again with ?download=1, as the app does at once, and
        // `backupUnavailable` says the update cannot run at all.
        checked = await checkPrototype(html, { scratchRoot: context.dataDirectory, download, askDownloadForUpdate: true, catalog: context.catalog, signal: controller.signal, ...onProgress, ...preview, ...(context.fetchPrototypeAsset ? { fetchAsset: context.fetchPrototypeAsset } : {}), ...(context.convertedMedia ? { convertedMedia: context.convertedMedia } : {}) });
      } finally {
        response.off("close", abort);
        if (progressToken) board?.finish(progressToken);
      }
      // The project an update would change, by the name the user sees in Publish (it may have been renamed).
      const existing = checked.outcome === "create" ? null : await context.catalog.openProject(checked.report.project.id);
      const existingProject = existing ? { id: existing.project.id, name: existing.project.name } : null;
      existing?.store.close();
      sendJson(response, 200, { ...checked, ...(existingProject ? { existingProject } : {}) });
      return true;
    }
  }

  if (parts[2] === "import-progress" && parts.length === 4) {
    if (method !== "GET") throw new HistosPublishError("Usa GET per leggere l'avanzamento.", "cms-method-not-allowed", 405);
    const token = ImportProgressBoard.token(parts[3] ?? null);
    sendJson(response, 200, { progress: token ? context.importProgress?.get(token) ?? null : null });
    return true;
  }

  // Doc 18 §9 (F7): the import reports a project keeps, listed, downloaded as JSON, and completed with the conversion's
  // part (notes, measure, framework) that only the app's check dialog knows.
  if (parts[2] === "projects" && parts[4] === "import-reports" && (parts.length === 5 || parts.length === 6)) {
    const projectId = requireProjectId(parts[3]);
    const opened = await context.catalog.openProject(projectId);
    if (!opened) throw new HistosPublishError("Progetto CMS non trovato.", "cms-project-missing", 404);
    try {
      if (parts.length === 5 && method === "GET") {
        sendJson(response, 200, { reports: opened.store.listImportReports() });
        return true;
      }
      if (parts.length === 6 && parts[5] === "conversion" && method === "POST") {
        const body = await readJson(request, 512 * 1024);
        const id = opened.store.attachConversionReport(conversionReport(body));
        if (!id) throw new HistosPublishError("Il progetto non ha ancora un rapporto d'import.", "cms-import-report-missing", 404);
        sendJson(response, 200, { id });
        return true;
      }
      if (parts.length === 6 && method === "GET") {
        const report = opened.store.getImportReport(parts[5] ?? "");
        if (!report) throw new HistosPublishError("Rapporto d'import non trovato.", "cms-import-report-missing", 404);
        const body = Buffer.from(`${JSON.stringify({ format: "histos-import-report", version: 1, projectId, ...report }, null, 2)}\n`, "utf8");
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(body.byteLength),
          "Content-Disposition": `attachment; filename="rapporto-import-${(parts[5] ?? "").slice(0, 8)}.json"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
        return true;
      }
      throw new HistosPublishError("Metodo non ammesso per i rapporti d'import.", "cms-method-not-allowed", 405);
    } finally {
      opened.store.close();
    }
  }

  if (parts[2] === "projects" && parts.length === 5 && parts[4] === "import-report") {
    if (method !== "GET") throw new HistosPublishError("Usa GET per leggere il rapporto d'import.", "cms-method-not-allowed", 405);
    const report = context.importReports?.get(parts[3] ?? "");
    if (!report) throw new HistosPublishError("Per questo progetto non c'è un rapporto d'import in questa sessione dell'app.", "cms-import-report-missing", 404);
    sendJson(response, 200, { report });
    return true;
  }

  if (parts[2] === "prototype-previews" && parts.length === 5 && parts[4] === "preview") {
    if (method !== "POST") throw new HistosPublishError("Usa POST per riaprire un'anteprima.", "cms-method-not-allowed", 405);
    sendJson(response, 200, await reopenPrototypePreview(context, parts[3] ?? ""));
    return true;
  }

  if (parts[2] === "projects" && parts[3] === "restore" && parts.length === 4 && method === "POST") {
    const contentType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/zip") throw new HistosPublishError("Carica un backup .histosproject.", "cms-project-backup-type-invalid", 415);
    const archive = Buffer.from(await readBytes(request, MAX_TRANSFER_BYTES, "Il backup .histosproject"));
    let decoded: Awaited<ReturnType<typeof decodeNativeProjectArchive>>;
    try { decoded = await decodeNativeProjectArchive(archive); }
    catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Backup Histeon non valido.", error instanceof UnreadableArchiveError ? "cms-archive-invalid" : "cms-project-backup-invalid", 422); }
    try {
      const restored = await context.catalog.importNativeProjectBackup(decoded);
      let details: Record<string, unknown>;
      try { details = { project: projectInfo(restored.project), pages: restored.store.listPages(), styles: restored.store.getStyles(), assets: restored.store.listAssets(), contentTypes: restored.store.content.listTypes(), taxonomies: restored.store.content.listTaxonomies() }; }
      finally { restored.store.close(); }
      sendJson(response, 201, details);
    } catch (error) {
      if (error instanceof HistosPublishError) throw error;
      const duplicate = error instanceof Error && error.message.includes("identità esiste già");
      throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a ripristinare il backup.", duplicate ? "cms-project-duplicate" : "cms-project-backup-invalid", duplicate ? 409 : 422);
    }
    return true;
  }

  if (parts[2] !== "projects" || parts.length < 4) return false;
  const projectId = requireProjectId(parts[3]);
  const opened = await context.catalog.openProject(projectId);
  if (!opened) throw new HistosPublishError("Progetto CMS non trovato.", "cms-project-missing", 404);
  const { project, store } = opened;
  try {
    // Deleting a project moves it to the Cestino: only with its exact name, as the user types or pastes it in the
    // confirmation; never while it is publishing or a site publishes it. The folder moves whole (trashProject) and can
    // come back; its builds go now (a restored project builds again).
    if (parts.length === 4 && method === "DELETE") {
      const body = await readJson(request, 16 * 1024);
      if (typeof body.confirmName !== "string" || body.confirmName.trim() !== project.name) throw new HistosPublishError("Per eliminare il progetto scrivi il suo nome esatto.", "cms-project-delete-confirm", 400);
      const busy = context.projectInUse?.(project.id) ?? null;
      if (busy) throw new HistosPublishError(busy, "cms-project-in-use", 409);
      store.close();
      let deleted: boolean;
      try {
        deleted = await context.catalog.trashProject(project.id);
      } catch (error) {
        // The system's own message may name folders of this computer: it stays out of the answer.
        void error;
        throw new HistosPublishError("Il progetto è in uso e non si può eliminare adesso: chiudi l’editor del progetto e riprova.", "cms-project-in-use", 409);
      }
      if (!deleted) throw new HistosPublishError("Progetto CMS non trovato.", "cms-project-missing", 404);
      await context.forgetProject?.(project.id);
      sendJson(response, 200, { trashed: true, id: project.id, name: project.name });
      return true;
    }
    if (parts[4] === "destinations" && parts[5] === "inspect" && parts.length === 6) {
      if (method !== "POST") throw new HistosPublishError("Usa POST per verificare una destinazione.", "cms-method-not-allowed", 405);
      const body = await readJson(request, 16 * 1024);
      if (typeof body.destinationId !== "string" || !UUID.test(body.destinationId)) {
        throw new HistosPublishError("Seleziona una destinazione salvata valida.", "cms-destination-invalid", 400);
      }
      const inspection = await context.inspectDestination({ projectId: project.id, destinationId: body.destinationId });
      if (inspection.destinationId !== body.destinationId || inspection.schemaVersion !== 1 || inspection.writeVerified !== false) {
        throw new HistosPublishError("La verifica della destinazione ha restituito un risultato non valido.", "cms-destination-inspection-invalid", 500);
      }
      sendJson(response, 200, inspection);
      return true;
    }
    if (parts[4] === "publish-plan" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (typeof body.buildId !== "string" || !UUID.test(body.buildId)) throw new HistosPublishError("Versione CMS non valida o scaduta. Crea una nuova versione prima di preparare il piano.", "cms-build-missing", 404);
      if (typeof body.targetSiteId !== "string" || !UUID.test(body.targetSiteId)) throw new HistosPublishError("Scegli una destinazione Publish valida.", "cms-deploy-target-invalid", 400);
      const plan = await context.createPublishPlan({ projectId: project.id, buildId: body.buildId, targetSiteId: body.targetSiteId, projectRevision: store.getProjectRevision() });
      if (plan.projectId !== project.id || plan.buildId !== body.buildId || plan.destination.id !== body.targetSiteId || plan.writeVerified !== false) {
        throw new HistosPublishError("Il piano di pubblicazione restituito non corrisponde alla richiesta.", "cms-publish-plan-invalid", 500);
      }
      sendJson(response, 200, plan);
      return true;
    }
    if (parts.length === 4 && method === "GET") {
      const recoverableDeletions = store.listTransferTombstones().map((entity) => ({
        id: entity.id,
        kind: entity.payload.entityKind,
        label: entity.payload.label,
        deletedAt: entity.payload.deletedAt,
      }));
      sendJson(response, 200, { project: projectInfo(project), pages: store.listPages(), posts: store.listPosts().map((post) => postInfo(store, post)), taxonomies: store.content.listTaxonomies(), components: store.listComponents().filter((item) => item.kind === "component").map(({ id, alias, ref, title, headRevision }) => ({ id, alias, ref, title, headRevision })), templates: store.listTemplates().map((item) => ({ id: item.id, alias: item.alias, ref: item.ref, title: item.title, role: item.role, headRevision: item.headRevision, hasDefaultSlot: store.canUseTemplate(item.ref) })), templateParts: store.listTemplateParts().map((item) => ({ id: item.id, alias: item.alias, ref: item.ref, title: item.title, headRevision: item.headRevision })), styles: store.getStyles(), assets: store.listAssets(), contentTypes: store.content.listTypes(), queryPresets: store.content.listQueryPresets().presets, renderSettings: store.getRenderSettings(), imageSettings: store.getImageSettings(), siteUrl: store.getSiteUrl(), recoverableDeletions });
      return true;
    }
    if (parts[4] === "recovery" && parts[5] === "tombstones" && parts.length === 7 && method === "POST") {
      const entityId = parts[6];
      if (!entityId || !UUID.test(entityId)) throw new HistosPublishError("Identificativo dell’elemento da ripristinare non valido.", "cms-recovery-entity-invalid", 400);
      try {
        if (!store.restoreTransferTombstone(entityId)) throw new HistosPublishError("Non è stata trovata una cancellazione recuperabile per questo elemento.", "cms-recovery-tombstone-missing", 404);
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a ripristinare l’elemento.", "cms-recovery-restore-conflict", 409);
      }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { restored: true, id: entityId });
      return true;
    }
    if (parts[4] === "trash" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 32 * 1024);
      const connectionId = typeof body.connectionId === "string" && body.connectionId.trim() ? body.connectionId : null;
      if ((body.connectionId !== undefined && body.connectionId !== null && body.connectionId !== "" && !connectionId) || !Array.isArray(body.entityIds) || body.entityIds.length < 1 || body.entityIds.length > 100 || body.entityIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
        throw new HistosPublishError("Seleziona da 1 a 100 elementi validi e, se vuoi sincronizzare la cancellazione, un collegamento WordPress.", "cms-trash-request-invalid", 400);
      }
      const entityIds = body.entityIds as string[];
      if (new Set(entityIds).size !== entityIds.length) throw new HistosPublishError("Lo stesso elemento è stato selezionato più di una volta.", "cms-trash-duplicate-entity", 400);
      const connection = connectionId ? context.remoteCatalog.get(connectionId) : null;
      if (connectionId && (!connection || !connection.write)) throw new HistosPublishError("Serve un collegamento Histeon WordPress con permesso di invio bozze.", "cms-trash-connection-unavailable", 403);
      if (connection?.projectId && connection.projectId !== project.id) throw new HistosPublishError("Il collegamento WordPress appartiene a un altro progetto.", "cms-trash-project-mismatch", 409);

      const currentProfile = await createStaticPageProfile(project, store, undefined, connection?.siteId);
      const currentById = new Map(currentProfile.profile.entities.map((entity) => [entity.id, entity]));
      const deletingIds = new Set(entityIds);
      const selected: Array<{ previous: (typeof currentProfile.profile.entities)[number]; baseHash: string }> = [];
      for (const id of entityIds) {
        const previous = currentById.get(id);
        if (!previous || previous.kind === "tombstone") throw new HistosPublishError("L’elemento non è disponibile o è già nel Cestino.", "cms-trash-entity-missing", 404);
        if (!["document", "content-record", "component", "template-part", "template", "asset"].includes(previous.kind)) {
          throw new HistosPublishError("Questo tipo di elemento non può essere rimosso in modo recuperabile.", "cms-trash-kind-unsupported", 422);
        }
        const base = connection ? store.getSyncBase(connection.siteId, id) : null;
        if (connection && (!base || base.remoteProjectId !== project.id || base.baseHash !== previous.revisionHash)) {
          throw new HistosPublishError("L’elemento non ha una base comune invariata con questo WordPress. Scarica o invia gli aggiornamenti prima di eliminarlo.", "cms-trash-base-conflict", 409);
        }
        if (!connection && context.remoteCatalog.list().some((linked) => store.getSyncBase(linked.siteId, id))) {
          throw new HistosPublishError("Questo elemento è già collegato a WordPress. Scegli il sito corrispondente per preparare anche la cancellazione remota.", "cms-trash-sync-target-required", 409);
        }
        selected.push({ previous, baseHash: base?.baseHash ?? previous.revisionHash });
      }

      const deletingPages = selected.filter(({ previous }) => previous.kind === "document" && previous.payload.documentType === "page").length;
      const activePages = currentProfile.profile.entities.filter((entity) => entity.kind === "document" && entity.payload.documentType === "page").length;
      if (deletingPages >= activePages && deletingPages > 0) throw new HistosPublishError("Il progetto deve mantenere almeno una pagina. Sposta le altre nel Cestino separatamente.", "cms-trash-last-page", 409);
      const deletingRecordIds = selected.filter(({ previous }) => previous.kind === "content-record").map(({ previous }) => previous.id);
      for (const { previous } of selected) {
        const externalProfileReference = currentProfile.profile.references.some((reference) => reference.targetId === previous.id && !deletingIds.has(reference.ownerId));
        const externalRecordReference = previous.kind === "content-record" && store.content.hasIncomingRecordRelations(previous.id, deletingRecordIds);
        const externalAssetReference = previous.kind === "asset" && store.content.hasIncomingAssetReferences(previous.id, deletingRecordIds);
        const assignedTemplateReference = previous.kind === "template"
          && [...store.listPages(), ...store.listPosts()].some((page) => page.templateRef === previous.payload.ref && !deletingIds.has(page.id));
        if (externalProfileReference || externalRecordReference || externalAssetReference || assignedTemplateReference) {
          throw new HistosPublishError(`“${String(previous.payload.title ?? previous.payload.ref ?? previous.payload.key ?? previous.id)}” ha ancora riferimenti attivi. Includi nel batch tutti i contenuti collegati oppure rimuovi prima i collegamenti.`, "cms-trash-referenced", 409);
        }
      }

      const deletedAt = new Date().toISOString();
      const tombstones = selected.map(({ previous, baseHash }) => createTransferTombstone({ ...previous, baseHash }, deletedAt));
      try {
        await store.createDeletionRecoveryBackup(randomUUID());
        store.applyTransferTombstones(tombstones.map((entity, index) => ({ entity, verifiedCurrentHash: selected[index]!.previous.revisionHash, scope: connection ? "remote" : "local" })));
        await context.catalog.saveManifest(project);
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare la copia di recupero.", "cms-trash-apply-failed", 409);
      }
      sendJson(response, 200, { deleted: tombstones.map((entity) => ({ id: entity.id, kind: entity.payload.entityKind, label: entity.payload.label, deletedAt })), recoveryAvailable: true, remoteSyncRequired: Boolean(connection), scope: connection ? "remote" : "local" });
      return true;
    }
    if (parts[4] === "settings" && parts.length === 5 && method === "PATCH") {
      const body = await readJson(request, 16 * 1024);
      let renderSettings: ReturnType<typeof store.setRenderSettings>;
      // B6: `images` changes the modern image variants (on or off, widths, qualities); what it leaves out stays.
      let imageSettings = store.getImageSettings();
      if (body.images !== undefined) {
        if (!body.images || typeof body.images !== "object" || Array.isArray(body.images)) throw new HistosPublishError("Impostazioni delle immagini non valide.", "cms-image-settings-invalid", 400);
        try { normalizeCmsImageSettings({ ...imageSettings, ...body.images }); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Impostazioni delle immagini non valide.", "cms-image-settings-invalid", 400); }
      }
      // Everything is checked before anything is written: a refusal leaves the settings as they were.
      const name = typeof body.name === "string" ? body.name.replace(/\p{Cc}/gu, " ").trim() : "";
      if (body.name !== undefined && (!name || name.length > 120)) throw new HistosPublishError("Il nome del progetto ha da 1 a 120 caratteri.", "cms-project-name-invalid", 400);
      if (body.siteUrl !== undefined) {
        try { normalizeSiteUrl(body.siteUrl); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Indirizzo del sito non valido.", "cms-site-url-invalid", 400); }
      }
      if (body.shop !== undefined) {
        try { normalizeShopSettings(body.shop); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Impostazioni del negozio non valide.", "cms-shop-invalid", 400); }
      }
      try { renderSettings = store.setRenderSettings({ locale: body.locale, timeZone: body.timeZone }); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Impostazioni regionali non valide.", "cms-render-settings-invalid", 400); }
      if (typeof body.search === "boolean") store.setSiteSearch(body.search);
      if (body.images !== undefined) imageSettings = store.setImageSettings({ ...imageSettings, ...(body.images as Record<string, unknown>) });
      if (name) project.name = name;
      if (body.siteUrl !== undefined) store.setSiteUrl(body.siteUrl);
      if (body.shop !== undefined) store.setShopSettings(body.shop);
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { renderSettings, imageSettings, siteUrl: store.getSiteUrl() });
      return true;
    }
    if (parts[4] === "builds" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, { builds: await context.listBuilds(project.id, store.getProjectRevision()) });
      return true;
    }
    if (parts[4] === "builds" && parts.length === 7 && parts[6] === "preview" && method === "POST") {
      const buildId = parts[5];
      if (!buildId || !UUID.test(buildId)) throw new HistosPublishError("Versione CMS non valida.", "cms-build-missing", 404);
      sendJson(response, 200, await context.previewBuild({ projectId: project.id, buildId }));
      return true;
    }
    if (parts[4] === "builds" && parts[6] === "deployments" && parts.length === 7 && method === "GET") {
      if (!parts[5] || !UUID.test(parts[5])) throw new HistosPublishError("Versione CMS non valida.", "cms-build-missing", 404);
      sendJson(response, 200, { deployments: await context.listBuildDeployments(project.id, parts[5]) });
      return true;
    }
    if (parts[4] === "builds" && parts[6] === "deployments" && parts[8] === "rollback" && parts.length === 9 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (body.confirmed !== true) throw new HistosPublishError("Conferma il ripristino della pubblicazione prima di continuare.", "confirmation-required", 428);
      if (!parts[5] || !UUID.test(parts[5])) throw new HistosPublishError("Versione CMS non valida.", "cms-build-missing", 404);
      if (!parts[7] || !UUID.test(parts[7])) throw new HistosPublishError("Pubblicazione CMS non valida.", "cms-deployment-missing", 404);
      const result = await context.rollbackDeployment({ projectId: project.id, buildId: parts[5], deploymentId: parts[7] });
      sendJson(response, 202, result);
      return true;
    }
    if (parts[4] === "builds" && parts.length === 7 && parts[6] === "export" && method === "POST") {
      if (!parts[5] || !UUID.test(parts[5])) throw new HistosPublishError("Versione CMS non valida.", "cms-build-missing", 404);
      await context.exportBuild({ projectId: project.id, buildId: parts[5] }, response);
      return true;
    }
    if (parts[4] === "bootstrap" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, {
        apiVersion: 1,
        projectId: project.id,
        engine: { sourceCommit: "9bc212050403dd056ac21edfcff398b514e4a3c1", runtime: "histos-ts", contractVersion: 1 },
        revision: store.getProjectRevision(),
        capabilities: {
          documents: ["page", "component", "template", "template-part"], blocks: [...CMS_RUNTIME_CAPABILITIES.blocks],
          expressions: { status: "partial", features: [...CMS_RUNTIME_CAPABILITIES.expressions], modifiers: true, modifierNames: [...CMS_RUNTIME_CAPABILITIES.modifiers], customModifiers: false, loops: true, queryPresets: true, arbitrary: false },
          runtimeLimits: CMS_RUNTIME_CAPABILITIES.limits,
          forms: CMS_RUNTIME_CAPABILITIES.forms,
          components: { definitions: true, literalProps: true, dynamicProps: true, namedSlots: true, emptySlotMetadata: true, transfer: false }, templates: true, templateParts: true,
          queries: true, contentTypes: true, relations: true, queryFeatures: { postTypePresets: true, jsonSources: true, taxonomyFilters: true, authorFilters: false, pagination: true }, media: true, styles: true,
          design: { compiledCss: true, parameterGenerator: true, tokenOverrides: true, contrast: true },
          transfer: { available: false, read: [], write: [], profile: null },
        },
        mapping: { document: url.searchParams.get("document") ?? null },
      });
      return true;
    }
    if (parts[4] === "builder-config" && parts.length === 5 && method === "GET") {
      const alias = requireAlias(url.searchParams.get("document") ?? undefined);
      const entity = store.getEntityByAlias(alias);
      const component = entity ? null : store.getComponentByAlias(alias);
      if (!component && (!entity || entity.kind !== "page")) throw new HistosPublishError("Documento CMS non trovato.", "cms-document-missing", 404);
      const title = component?.title ?? entity!.title;
      sendJson(response, 200, {
        // Keep builder API calls same-origin. The desktop app serves the UI on
        // app:// and proxies relative /api requests to its loopback server;
        // using the incoming HTTP Host here would make strict CSP reject saves.
        restUrl: `/api/cms/v1/projects/${project.id}/`, nonce: "", postId: alias, title,
        cmsMediaBase: `/__cms-media/${project.id}`,
        editUrl: null, viewUrl: null, trusted: false, canPublish: false, staticBridge: false, checksBlock: false, canManage: false,
        contentOnly: false, localCms: true, previewable: entity?.kind === "page", fluentForms: false,
        // E12: "←" goes back to this project in the app, by its name.
        returnTo: /^amministra(?:\/[a-z0-9_-]{1,80})?$/u.test(url.searchParams.get("back") ?? "")
          ? { url: `/#/cms/${project.id}/${url.searchParams.get("back")}`, label: "Amministrazione" }
          : { url: `/#/cms/${project.id}`, label: project.name },
        template: component && (component.kind === "template" || component.kind === "template-part") ? { part: component.kind === "template-part", slug: component.ref, samples: [] } : null,
        locale: store.getRenderSettings().locale,
        media: { url: `/api/cms/v1/projects/${project.id}/media`, canUpload: true, maxBytes: MAX_MEDIA_BYTES },
        admin: { overview: null, history: null, releases: null, templates: null }, framework: null, languages: entity ? builderLanguages(store, project.id, entity) : null, embed: false,
        shortcuts: {}, connector: null, connectorPair: null,
      });
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "index" && parts.length === 6 && method === "GET") {
      // The client keeps the index; `known` is the revision it has, so an unchanged project costs one short answer.
      const index = JSON.stringify(store.adminIndex());
      const revision = createHash("sha256").update(index).digest("base64url");
      if (url.searchParams.get("known") === revision) sendJson(response, 200, { unchanged: true, revision });
      else sendJson(response, 200, { revision, ...(JSON.parse(index) as Record<string, unknown>) });
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "bulk" && parts.length === 6 && method === "POST") {
      const body = await readJson(request, 256 * 1024);
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length) throw new HistosPublishError("Scegli da 1 a 500 contenuti.", "cms-bulk-invalid", 400);
      if (body.action !== "publish" && body.action !== "draft" && body.action !== "translate" && body.action !== "term") throw new HistosPublishError("Azione non valida.", "cms-bulk-invalid", 400);
      let done: number;
      try {
        if (body.action === "term") {
          if (typeof body.taxonomy !== "string" || typeof body.term !== "string") throw new TypeError("Scegli la categoria.");
          done = store.bulkAddTerm(ids as string[], body.taxonomy, body.term);
        } else if (body.action === "translate") {
          if (typeof body.language !== "string") throw new TypeError("Scegli la lingua.");
          const language = body.language;
          done = store.bulkCreateTranslations(ids as string[], language);
        } else done = store.bulkSetStatus(ids as string[], body.action === "publish" ? "published" : "draft");
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "L'azione non è riuscita: nulla è cambiato.", "cms-bulk-failed", 422);
      }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { done });
      return true;
    }
    if (parts[4] === "languages" && parts.length === 5) {
      if (method === "GET") {
        sendJson(response, 200, store.getProjectLanguages());
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(request, 16 * 1024);
        let languages: ReturnType<typeof store.setProjectLanguages>;
        try { languages = store.setProjectLanguages(body); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Lingue non valide.", "cms-languages-invalid", 422); }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, languages);
        return true;
      }
    }
    if (parts[4] === "translations" && parts.length === 5) {
      if (method === "GET") {
        sendJson(response, 200, { translations: store.listTranslations().map((link) => ({ ...link, state: store.translationState(link) })) });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 16 * 1024);
        if (typeof body.sourceId !== "string" || !UUID.test(body.sourceId) || typeof body.language !== "string" || (body.mode !== undefined && body.mode !== "copy" && body.mode !== "empty" && body.mode !== "link") || (body.linkId !== undefined && (typeof body.linkId !== "string" || !UUID.test(body.linkId))) || (body.slug !== undefined && typeof body.slug !== "string") || (body.title !== undefined && typeof body.title !== "string")) throw new HistosPublishError("La richiesta di traduzione non è valida.", "cms-translation-invalid", 400);
        let link: ReturnType<typeof store.createTranslation>;
        try { link = store.createTranslation({ sourceId: body.sourceId, language: body.language, ...(body.mode ? { mode: body.mode } : {}), ...(body.linkId ? { linkId: body.linkId } : {}), ...(body.slug ? { slug: body.slug } : {}), ...(body.title ? { title: body.title } : {}) }); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare la traduzione.", "cms-translation-invalid", 422); }
        await context.catalog.saveManifest(project);
        sendJson(response, 201, { translation: { ...link, state: store.translationState(link) } });
        return true;
      }
    }
    if (parts[4] === "translations" && parts[5] === "source" && parts.length === 6 && method === "GET") {
      const sourceId = url.searchParams.get("sourceId") ?? "";
      const language = url.searchParams.get("language") ?? "";
      if (!UUID.test(sourceId)) throw new HistosPublishError("Originale non valido.", "cms-translation-invalid", 400);
      try { sendJson(response, 200, store.translationSource(sourceId, language)); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Originale non valido.", "cms-translation-invalid", 422); }
      return true;
    }
    if (parts[4] === "translations" && parts[5] === "segments" && parts.length === 6 && method === "POST") {
      const body = await readJson(request, 8 * 1024 * 1024);
      if (typeof body.sourceId !== "string" || !UUID.test(body.sourceId) || typeof body.language !== "string") throw new HistosPublishError("La richiesta di traduzione non è valida.", "cms-translation-invalid", 400);
      let saved: ReturnType<typeof store.saveTranslationSegments>;
      try { saved = store.saveTranslationSegments({ sourceId: body.sourceId, language: body.language, segments: body.segments, ...(typeof body.slug === "string" ? { slug: body.slug } : {}) }); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare la traduzione.", "cms-translation-invalid", 422); }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { translation: { ...saved.link, state: store.translationState(saved.link) }, left: saved.left });
      return true;
    }
    if (parts[4] === "translations" && parts[5] === "xliff" && parts.length === 6) {
      const language = url.searchParams.get("language") ?? "";
      if (method === "GET") {
        let xliff: string;
        try { xliff = store.exportTranslationXliff(language, url.searchParams.get("all") === "1"); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a esportare.", "cms-translation-invalid", 422); }
        response.writeHead(200, { "Content-Type": "application/xliff+xml; charset=utf-8", "Content-Disposition": `attachment; filename="traduzione-${language.replace(/[^A-Za-z0-9-]/gu, "")}.xlf"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
        response.end(xliff);
        return true;
      }
      if (method === "POST") {
        const bytes = await readBytes(request, MAX_XLIFF_BYTES);
        let result: ReturnType<typeof store.importTranslationXliff>;
        try { result = store.importTranslationXliff(language, Buffer.from(bytes).toString("utf8")); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "File XLIFF non valido.", "cms-xliff-invalid", 422); }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, result);
        return true;
      }
    }
    if (parts[4] === "admin" && parts[5] === "content" && parts.length === 7 && method === "GET") {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      if (!entity || entity.kind !== "page") throw new HistosPublishError("Contenuto non trovato.", "cms-document-missing", 404);
      sendJson(response, 200, { excerpt: entity.excerpt, publishedAt: entity.publishedAt, imageAssetId: entity.imageAssetId, terms: entity.documentType === "post" ? store.getPostTermIds(entity.id) : {} });
      return true;
    }
    // «Fotografa la proposta»: the capture the project keeps (proposal-store.ts), or null. Names and addresses only.
    if (parts[4] === "admin" && parts[5] === "proposal" && parts.length === 6 && method === "GET") {
      sendJson(response, 200, { kept: (await readKeptProposal(project.directory))?.about ?? null });
      return true;
    }
    // «Uguale alla proposta»: the last comparison saved (GET), a new one started (POST: the desktop app only, one at a time).
    if (parts[4] === "admin" && parts[5] === "proposal-compare" && parts.length === 6 && (method === "GET" || method === "POST")) {
      if (method === "POST") {
        const kept = await readKeptProposal(project.directory);
        if (!kept) throw new HistosPublishError("Questo progetto non conserva una proposta fotografata.", "cms-proposal-missing", 404);
        const build = context.latestBuild?.(project.id);
        if (!build) throw new HistosPublishError("Prima prepara il sito: il confronto fotografa l'ultima versione.", "cms-site-check-no-build", 409);
        if (!context.photographPages) throw new HistosPublishError("Il confronto con la proposta c'è solo nell'app desktop.", "cms-proposal-compare-no-browser", 409);
        if (proposalComparesRunning.has(project.id)) throw new HistosPublishError("Il confronto con la proposta di questo progetto è già in corso.", "cms-proposal-compare-running", 409);
        // It takes minutes on a site of many pages: started here, followed with GET (`running`, then `result` or `failed`).
        const projectId = project.id;
        proposalComparesRunning.add(projectId);
        proposalCompareFailures.delete(projectId);
        void runProposalCompare(context, { name: project.name }, kept, { createdAt: build.createdAt, bundlePath: build.bundlePath }, context.photographPages, AbortSignal.timeout(PROPOSAL_COMPARE_TIMEOUT_MS))
          .catch((error: unknown) => { proposalCompareFailures.set(projectId, error instanceof HistosPublishError ? error.message.slice(0, 300) : "Il confronto con la proposta non è riuscito."); })
          .finally(() => { proposalComparesRunning.delete(projectId); });
      }
      sendJson(response, method === "POST" ? 202 : 200, await proposalCompareAnswer(context, project));
      return true;
    }
    // The two sites of the comparison for the eye: the kept original, still and sealed on the capture origin, and the
    // latest version in a closed preview. Addresses that lapse five minutes after their last file.
    if (parts[4] === "admin" && parts[5] === "proposal-compare" && parts[6] === "view" && parts.length === 7 && method === "POST") {
      const kept = await readKeptProposal(project.directory);
      if (!kept) throw new HistosPublishError("Questo progetto non conserva una proposta fotografata.", "cms-proposal-missing", 404);
      const build = context.latestBuild?.(project.id);
      let built: string | null = null;
      if (build) {
        const ticket = randomBytes(24).toString("base64url");
        const buildId = randomUUID();
        context.registerPreview({ ticket, buildId, bundlePath: build.bundlePath });
        built = `/__preview/${ticket}/${buildId}/`;
      }
      sendJson(response, 200, { original: context.openProposalOriginal?.(kept.siteDirectory) ?? null, built, pages: kept.about.pages.map((page) => ({ name: page.name, path: keptPageAddress(page) })) });
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "site-check" && parts.length === 6 && method === "GET") {
      const build = context.latestBuild?.(project.id);
      if (!build) throw new HistosPublishError("Prima prepara il sito: il controllo legge l'ultima versione.", "cms-site-check-no-build", 409);
      sendJson(response, 200, await siteCheckAnswer(context, build, store.getProjectRevision(), (await readSavedReadiness(build.bundlePath))?.browser ?? null));
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "site-check" && parts[6] === "browser" && parts.length === 7 && method === "POST") {
      const build = context.latestBuild?.(project.id);
      if (!build) throw new HistosPublishError("Prima prepara il sito: il controllo legge l'ultima versione.", "cms-site-check-no-build", 409);
      if (!context.openPageProbe) throw new HistosPublishError("La verifica nel browser c'è solo nell'app desktop.", "cms-site-check-no-browser", 409);
      if (browserChecksRunning.has(build.bundlePath)) throw new HistosPublishError("La verifica nel browser di questa versione è già in corso.", "cms-site-check-browser-running", 409);
      browserChecksRunning.add(build.bundlePath);
      try {
        let axe: Awaited<ReturnType<typeof loadAxeScript>> | null = null;
        try { axe = await loadAxeScript(); } catch { /* Said by the report: nothing opened, accessibility not checked. */ }
        const pages = axe ? await checkBuiltPages(build.bundlePath, context.openPageProbe, { axe }) : { opened: 0, overflow: [], axe: [], failures: ["axe-core non è installato con l'app."] };
        sendJson(response, 200, await siteCheckAnswer(context, build, store.getProjectRevision(), summarizeBrowserCheck(pages, new Date().toISOString())));
      } finally {
        browserChecksRunning.delete(build.bundlePath);
      }
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "media-folders" && parts.length === 6 && (method === "GET" || method === "PUT")) {
      if (method === "PUT") store.setMediaFolders((await readJson(request, 1024 * 1024)).folders);
      sendJson(response, 200, { folders: store.getMediaFolders() });
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "media-usage" && parts.length === 6 && method === "GET") {
      sendJson(response, 200, { used: [...store.usedAssetIds()] });
      return true;
    }
    // Filters of the articles table: which terms each post has, read once when the table opens.
    if (parts[4] === "admin" && parts[5] === "post-terms" && parts.length === 6 && method === "GET") {
      const taxonomies = store.content.listTaxonomies().filter((taxonomy) => taxonomy.types.includes("post")).map((taxonomy) => ({ key: taxonomy.key, label: taxonomy.label, terms: store.content.listTerms(taxonomy.key).map((term) => ({ id: term.id, label: term.label })) }));
      const media = new RegExp(`/__cms-media/${project.id}/[0-9a-f-]{36}`, "u");
      sendJson(response, 200, { taxonomies, posts: Object.fromEntries(store.listPosts().map((post) => [post.id, store.getPostTermIds(post.id)])), covers: Object.fromEntries(store.listPosts().flatMap((post) => { const found = media.exec(store.getRevision(post.headRevision)?.content ?? "")?.[0]; return found ? [[post.id, found]] : []; })) });
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "seo" && parts.length === 7 && (method === "GET" || method === "PUT")) {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      if (!entity || entity.kind !== "page") throw new HistosPublishError("Contenuto non trovato.", "cms-document-missing", 404);
      if (method === "GET") {
        sendJson(response, 200, { seo: store.getSeo(entity.id) });
        return true;
      }
      try {
        sendJson(response, 200, { seo: store.setSeo(entity.id, await readJson(request, 64 * 1024)) });
      } catch (error) {
        if (error instanceof TypeError) throw new HistosPublishError(error.message, "cms-seo-invalid", 422);
        throw error;
      }
      await context.catalog.saveManifest(project);
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "redirects" && parts.length === 6 && (method === "GET" || method === "PUT")) {
      if (method === "GET") {
        sendJson(response, 200, { redirects: store.getRedirects() });
        return true;
      }
      try {
        sendJson(response, 200, { redirects: store.setRedirects((await readJson(request, 512 * 1024)).redirects) });
      } catch (error) {
        if (error instanceof TypeError) throw new HistosPublishError(error.message, "cms-redirects-invalid", 422);
        throw error;
      }
      await context.catalog.saveManifest(project);
      return true;
    }
    // The site as a WordPress export file. Images stay behind: the format has only their addresses, and they have none yet.
    if (parts[4] === "export-wordpress" && parts.length === 5 && method === "GET") {
      const terms = (["category", "post_tag"] as const).flatMap((kind) => {
        const list = store.content.listTerms(kind);
        const slugOf = new Map(list.map((term) => [term.id, term.slug]));
        return list.map((term) => ({ kind, id: term.id, slug: term.slug, name: term.label, parent: term.parentId ? slugOf.get(term.parentId) ?? "" : "" }));
      });
      const byId = new Map(terms.map((term) => [term.id, term]));
      let imagesLeft = 0;
      const htmlOf = async (document: CmsEntity): Promise<string> => {
        const rendered = await renderCmsSafely({ store, projectId: project.id, content: store.getRevision(document.headRevision)?.content ?? "", mediaBase: "/__cms-media", ...store.getRenderSettings() });
        const body = /<body>([\s\S]*)<\/body>/u.exec(rendered.html)?.[1] ?? "";
        return body.replace(/<img\b[^>]*\bsrc="\/__cms-media[^>]*>/gu, () => { imagesLeft += 1; return ""; });
      };
      const items: WxrExportItem[] = [];
      // Doc 23 item 119: a post's featured image goes as an attachment with its address on the published site
      // (`/media/<sha256>.<ext>`, where the build puts it); without the site's address it stays behind, like the others.
      const siteUrl = store.getSiteUrl();
      const assets = new Map(store.listAssets().map((asset) => [asset.id, asset]));
      const thumbnailOf = (document: CmsEntity): WxrExportItem["thumbnail"] => {
        const asset = document.imageAssetId ? assets.get(document.imageAssetId) : undefined;
        if (!asset) return undefined;
        if (!siteUrl) { imagesLeft += 1; return undefined; }
        return { id: 1_000_000 + asset.alias, url: `${siteUrl.replace(/\/+$/u, "")}/media/${asset.sha256}.${extensionForMime(asset.mimeType)}`, title: asset.filename, alt: asset.alt };
      };
      for (const document of [...store.listPages(), ...store.listPosts()].filter((entry) => entry.locale === null)) {
        const isPost = document.documentType === "post";
        const thumbnail = isPost ? thumbnailOf(document) : undefined;
        items.push({ id: document.alias, type: isPost ? "post" : "page", title: document.title, slug: document.slug, status: document.status, date: document.publishedAt ?? document.updatedAt, excerpt: document.excerpt ?? "", html: await htmlOf(document), terms: isPost ? Object.values(store.getPostTermIds(document.id)).flat().flatMap((id) => { const term = byId.get(id); return term ? [{ kind: term.kind, slug: term.slug, name: term.name }] : []; }) : [], ...(thumbnail ? { thumbnail } : {}) });
      }
      const xml = buildWxr({ title: project.name, link: store.getSiteUrl() ?? "https://esempio.it", language: store.getRenderSettings().locale, terms, items });
      response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${project.id}.xml"`, "X-Histos-Images-Left": String(imagesLeft), "Cache-Control": "no-store" });
      response.end(xml);
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "article" && parts[7] === "revisions" && parts.length === 9 && method === "GET") {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      const revision = store.getRevision(parts[8]!);
      if (!entity || !revision || revision.entityId !== entity.id) throw new HistosPublishError("Questa versione dell'articolo non esiste.", "cms-document-missing", 404);
      sendJson(response, 200, { document: readArticle(revision.content) });
      return true;
    }
    // The article's saved versions, newest first; restoring one is a new save, so nothing is lost.
    if (parts[4] === "admin" && parts[5] === "article" && parts[7] === "revisions" && parts.length === 8 && (method === "GET" || method === "POST")) {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      if (!entity || entity.kind !== "page") throw new HistosPublishError("Articolo non trovato.", "cms-document-missing", 404);
      if (method === "GET") {
        const words = (content: string) => (content.replace(/<!--[\s\S]*?-->/gu, " ").match(/\p{L}+/gu) ?? []).length;
        sendJson(response, 200, { revisions: store.listRevisions(entity.id, 50).map((revision) => ({ id: revision.id, createdAt: revision.createdAt, source: revision.source, words: words(revision.content) })) });
        return true;
      }
      const body = await readJson(request, 64 * 1024);
      const revision = typeof body.revision === "string" ? store.getRevision(body.revision) : null;
      if (!revision || revision.entityId !== entity.id || typeof body.head !== "string") throw new HistosPublishError("Questa versione dell'articolo non esiste.", "cms-document-invalid", 400);
      const saved = store.saveDocument({ entityId: entity.id, expectedHead: body.head, content: revision.content });
      if (saved.status === "conflict") {
        sendJson(response, 409, { error: "L'articolo è cambiato in un'altra finestra: ricaricalo prima di continuare.", code: "cms-revision-conflict" });
        return true;
      }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { head: saved.entity.headRevision, document: readArticle(revision.content) });
      return true;
    }
    // Doc 21 §13: an article's text as blocks, for the editor without HTML. Markup is written only here.
    if (parts[4] === "admin" && parts[5] === "article-card" && parts[6] === "new" && parts.length === 7 && method === "POST") {
      const body = await readJson(request, 64 * 1024);
      try {
        const fields = (Array.isArray(body.fields) ? body.fields : []).map((field) => ({ label: String((field as { label?: unknown }).label ?? ""), kind: ["area", "link", "image"].includes(String((field as { kind?: unknown }).kind)) ? (field as { kind: "area" | "link" | "image" }).kind : "text" as const }));
        const look = body.look === "scheda" || body.look === "citazione" ? body.look : "riquadro";
        const taken = new Set(store.listComponents().map((item) => item.ref));
        const made = body.repeats === true ? repeatingCard({ title: String(body.title ?? ""), fields, look }, taken) : { card: customCard({ title: String(body.title ?? ""), fields, look }, taken), row: null };
        const { card, row } = made;
        if (row) store.createComponent({ ref: row.ref, title: row.title, content: row.content, schema: row.schema });
        store.createComponent({ ref: card.ref, title: card.title, content: card.content, schema: card.schema });
        await context.catalog.saveManifest(project);
        sendJson(response, 201, { ref: card.ref, title: card.title, schema: card.schema, areas: [], ...(row ? { rows: row.ref } : {}), own: customCardForm(row?.schema ?? card.schema, row?.content ?? card.content) });
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "Blocco non valido.", "cms-article-invalid", 422);
      }
      return true;
    }
    // A block of one's own, changed: fields keep their names, so what articles wrote in them stays.
    if (parts[4] === "admin" && parts[5] === "article-card" && parts[6] === "own" && parts.length === 7 && method === "PUT") {
      const body = await readJson(request, 64 * 1024);
      const ref = String(body.ref ?? "");
      const main = store.getComponentByRef(ref);
      if (!ref.startsWith(ARTICLE_COMPONENT_PREFIX) || !main || ARTICLE_LIBRARY.some((entry) => entry.ref === ref)) throw new HistosPublishError("Questo blocco non si può cambiare qui.", "cms-article-invalid", 422);
      try {
        const fields = (Array.isArray(body.fields) ? body.fields : []).map((field) => {
          const entry = field as { label?: unknown; kind?: unknown; name?: unknown };
          return { label: String(entry.label ?? ""), kind: ["area", "link", "image"].includes(String(entry.kind)) ? entry.kind as "area" | "link" | "image" : "text" as const, ...(typeof entry.name === "string" ? { name: entry.name } : {}) };
        });
        const look = body.look === "scheda" || body.look === "citazione" ? body.look : "riquadro";
        const row = store.getComponentByRef(`${ref}${ROW_SUFFIX}`);
        const made = customCard({ title: String(body.title ?? ""), fields, look, ...(row ? { ref: row.ref } : { ref }) }, new Set());
        const target = row ?? main;
        const saved = store.saveComponent({ alias: target.alias, expectedHead: target.headRevision, content: made.content, ref: target.ref, schema: made.schema });
        if (saved.status === "conflict") throw new TypeError("Il blocco è cambiato in un'altra finestra.");
        store.updateComponentTitle(main.id, made.title);
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { ref, title: made.title, schema: row ? main.schema : made.schema, areas: [], ...(row ? { rows: row.ref } : {}), own: customCardForm(made.schema, made.content) });
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "Blocco non valido.", "cms-article-invalid", 422);
      }
      return true;
    }
    // A block as the page will show it, for the editor: the definition enters the project with its first use.
    if (parts[4] === "admin" && parts[5] === "article-card" && parts.length === 6 && method === "POST") {
      const body = await readJson(request, 1024 * 1024);
      let card: ReturnType<typeof cleanCard>;
      try {
        card = cleanCard(body, (ref) => cardRules(store, ref), `/__cms-media/${project.id}`, new Set(Array.isArray(body.known) ? body.known.filter((item): item is string => typeof item === "string") : []));
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "Blocco non valido.", "cms-article-invalid", 422);
      }
      if (installCard(store, card.ref)) await context.catalog.saveManifest(project);
      const rendered = await renderCmsSafely({ store, projectId: project.id, content: cardMarkup(card, cardRules(store, card.ref)?.rows), mediaBase: "/__cms-media", ...store.getRenderSettings() });
      sendJson(response, 200, { html: rendered.html.replace(/<style>[\s\S]*?<\/style>/u, "") });
      return true;
    }
    // The page as the site shows it, each element with the id of its block: the editor's preview, where a click leads to the text.
    if (parts[4] === "admin" && parts[5] === "article" && parts[7] === "preview" && parts.length === 8 && method === "GET") {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      if (!entity || entity.kind !== "page") throw new HistosPublishError("Articolo non trovato.", "cms-document-missing", 404);
      const rendered = await renderCmsDocumentPage({ store, projectId: project.id, document: entity, content: store.getRevision(entity.headRevision)?.content ?? "", annotate: true });
      sendJson(response, 200, { html: rendered.html });
      return true;
    }
    // Doc 23 item 94: the writer is done with the agent's proposal (all of it accepted or discarded).
    if (parts[4] === "admin" && parts[5] === "article" && parts.length === 8 && parts[7] === "proposal" && method === "DELETE") {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      if (!entity || entity.kind !== "page") throw new HistosPublishError("Articolo non trovato.", "cms-document-missing", 404);
      store.setArticleProposal(entity.id, null);
      sendJson(response, 200, { removed: true });
      return true;
    }
    if (parts[4] === "admin" && parts[5] === "article" && parts.length === 7 && (method === "GET" || method === "PUT")) {
      const entity = store.getEntityByAlias(requireAlias(parts[6]));
      if (!entity || entity.kind !== "page") throw new HistosPublishError("Articolo non trovato.", "cms-document-missing", 404);
      const content = store.getRevision(entity.headRevision)?.content ?? "";
      const document = readArticle(content);
      // A first text goes into the wrapper the site's other articles have: the template's styles expect it.
      const fallback = document.blocks.length ? null : store.listPosts().filter((post) => post.id !== entity.id).slice(0, 30).map((post) => readArticle(store.getRevision(post.headRevision)?.content ?? "").containers[0]).find(Boolean) ?? null;
      if (method === "GET") {
        // Doc 23 item 94: the agent's proposal, if one waits for the writer.
        const proposal = store.getArticleProposal(entity.id);
        sendJson(response, 200, { head: entity.headRevision, document, cards: articleCards(store), ...(proposal ? { proposal } : {}) });
        return true;
      }
      const body = await readJson(request, 8 * 1024 * 1024);
      if (typeof body.head !== "string") throw new HistosPublishError("La revisione attesa non è valida.", "cms-document-invalid", 400);
      let next: string;
      try {
        next = writeArticle(content, body.blocks, { mediaBase: `/__cms-media/${project.id}`, fallback, rulesOf: (ref) => cardRules(store, ref) });
        for (const block of readArticle(next).blocks) if (block.type === "card") installCard(store, block.ref);
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "Articolo non valido.", "cms-article-invalid", 422);
      }
      if (next === content && body.head === entity.headRevision) {
        sendJson(response, 200, { head: entity.headRevision, document });
        return true;
      }
      const saved = store.saveDocument({ entityId: entity.id, expectedHead: body.head, content: next });
      if (saved.status === "conflict") {
        sendJson(response, 409, { error: "L'articolo è cambiato in un'altra finestra: ricaricalo prima di continuare.", code: "cms-revision-conflict" });
        return true;
      }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { head: saved.entity.headRevision, document: readArticle(next) });
      return true;
    }
    if (parts[4] === "translation-brief" && parts.length === 5) {
      if (method === "GET") {
        sendJson(response, 200, { brief: store.getTranslationBrief() });
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(request, 64 * 1024);
        try { sendJson(response, 200, { brief: store.setTranslationBrief(body.brief) }); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Testo non valido.", "cms-translation-invalid", 422); }
        return true;
      }
    }
    if (parts[4] === "strings" && parts.length === 5) {
      const language = url.searchParams.get("language") ?? "";
      if (method === "GET") {
        try { sendJson(response, 200, { strings: store.listStrings(language) }); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Lingua non valida.", "cms-strings-invalid", 422); }
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(request, 8 * 1024 * 1024);
        let saved: number;
        try { saved = store.saveStrings(language, body.strings, body.status === "draft" ? "draft" : "published"); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Stringhe non valide.", "cms-strings-invalid", 422); }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { saved });
        return true;
      }
    }
    if (parts[4] === "translations" && parts.length === 7 && parts[6] === "changes" && method === "GET") {
      if (!UUID.test(parts[5]!) || !store.getTranslation(parts[5]!)) throw new HistosPublishError("Traduzione inesistente.", "cms-translation-missing", 404);
      sendJson(response, 200, store.translationChanges(parts[5]!));
      return true;
    }
    if (parts[4] === "translations" && parts.length === 7 && parts[6] === "update-draft" && method === "POST") {
      if (!UUID.test(parts[5]!) || !store.getTranslation(parts[5]!)) throw new HistosPublishError("Traduzione inesistente.", "cms-translation-missing", 404);
      let updated: ReturnType<typeof store.updateTranslationDraft>;
      try { updated = store.updateTranslationDraft(parts[5]!); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco ad aggiornare la bozza.", "cms-translation-invalid", 422); }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { translation: { ...updated.link, state: store.translationState(updated.link) }, left: updated.left });
      return true;
    }
    if (parts[4] === "translations" && parts.length === 6 && (method === "PATCH" || method === "DELETE")) {
      const id = parts[5]!;
      if (!UUID.test(id) || !store.getTranslation(id)) throw new HistosPublishError("Traduzione inesistente.", "cms-translation-missing", 404);
      if (method === "DELETE") {
        store.removeTranslationLink(id);
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { removed: true });
        return true;
      }
      const body = await readJson(request, 1024);
      if (body.action !== "mark-current" && body.mode !== "follow" && body.mode !== "independent") throw new HistosPublishError("La richiesta di traduzione non è valida.", "cms-translation-invalid", 400);
      const link = body.action === "mark-current" ? store.markTranslationCurrent(id) : store.setTranslationMode(id, body.mode as "follow" | "independent");
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { translation: { ...link, state: store.translationState(link) } });
      return true;
    }
    if (parts[4] === "types" && parts.length === 5) {
      if (method === "GET") {
        sendJson(response, 200, { types: store.content.listTypes() });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 256 * 1024);
        try {
          const singleTemplateRef = checkedTypeTemplateRef(store, body.singleTemplateRef, "singolo");
          const archiveTemplateRef = checkedTypeTemplateRef(store, body.archiveTemplateRef, "archivio");
          const saved = store.content.saveType({ key: body.key as string, label: body.label as string, fields: body.fields, singleTemplateRef, archiveTemplateRef, ...(typeof body.public === "boolean" ? { public: body.public } : {}), expectedHead: null });
          if (saved.status === "conflict") throw new HistosPublishError("Il tipo è stato creato in un’altra finestra. Ricarica l’elenco.", "cms-content-conflict", 409);
          await context.catalog.saveManifest(project);
          sendJson(response, 201, { contentType: saved.contentType });
        } catch (error) {
          if (error instanceof HistosPublishError) throw error;
          throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare il tipo.", "cms-content-type-invalid", 400);
        }
        return true;
      }
    }
    if (parts[4] === "types" && parts.length === 6) {
      if (method === "GET") {
        const contentType = store.content.getType(parts[5]!);
        if (!contentType) throw new HistosPublishError("Tipo di contenuto non trovato.", "cms-content-type-missing", 404);
        sendJson(response, 200, { contentType });
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(request, 256 * 1024);
        if (typeof body.head !== "string") throw new HistosPublishError("Indica la revisione del tipo che stai modificando.", "cms-content-head-required", 400);
        const current = store.content.getType(parts[5]!);
        if (!current) throw new HistosPublishError("Tipo di contenuto non trovato.", "cms-content-type-missing", 404);
        try {
          const singleTemplateRef = body.singleTemplateRef === undefined ? current.singleTemplateRef : checkedTypeTemplateRef(store, body.singleTemplateRef, "singolo");
          const archiveTemplateRef = body.archiveTemplateRef === undefined ? current.archiveTemplateRef : checkedTypeTemplateRef(store, body.archiveTemplateRef, "archivio");
          const saved = store.content.saveType({ id: current.id, key: current.key, label: body.label as string, fields: body.fields, singleTemplateRef, archiveTemplateRef, ...(typeof body.public === "boolean" ? { public: body.public } : {}), expectedHead: body.head });
          if (saved.status === "conflict") {
            sendJson(response, 409, { code: "cms-content-conflict", error: "Il tipo è cambiato in un’altra finestra.", current: saved.current });
            return true;
          }
          await context.catalog.saveManifest(project);
          sendJson(response, 200, { contentType: saved.contentType });
        } catch (error) {
          if (error instanceof HistosPublishError) throw error;
          throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare il tipo.", "cms-content-type-invalid", 400);
        }
        return true;
      }
    }
    if (parts[4] === "taxonomies" && parts.length === 5) {
      if (method === "GET") {
        sendJson(response, 200, { taxonomies: store.content.listTaxonomies() });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 64 * 1024);
        try {
          const saved = store.content.saveTaxonomy({ key: body.key as string, label: body.label as string, types: body.types, expectedHead: null });
          if (saved.status === "conflict") throw new HistosPublishError("La tassonomia è cambiata in un’altra finestra. Ricarica l’elenco.", "cms-content-conflict", 409);
          await context.catalog.saveManifest(project);
          sendJson(response, 201, { taxonomy: saved.taxonomy, terms: [] });
        } catch (error) {
          if (error instanceof HistosPublishError) throw error;
          throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare la tassonomia.", "cms-taxonomy-invalid", 400);
        }
        return true;
      }
    }
    if (parts[4] === "taxonomies" && parts.length === 6) {
      const key = parts[5]!;
      const current = store.content.getTaxonomy(key);
      if (!current) throw new HistosPublishError("Tassonomia non trovata.", "cms-taxonomy-missing", 404);
      if (method === "GET") {
        sendJson(response, 200, { taxonomy: current, terms: store.content.listTerms(current.key) });
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(request, 64 * 1024);
        if (typeof body.head !== "string") throw new HistosPublishError("Indica la revisione della tassonomia che stai modificando.", "cms-content-head-required", 400);
        try {
          const saved = store.content.saveTaxonomy({ id: current.id, key: current.key, label: body.label as string, types: body.types, expectedHead: body.head });
          if (saved.status === "conflict") {
            sendJson(response, 409, { code: "cms-content-conflict", error: "La tassonomia è cambiata in un’altra finestra.", current: saved.current });
            return true;
          }
          await context.catalog.saveManifest(project);
          sendJson(response, 200, { taxonomy: saved.taxonomy, terms: store.content.listTerms(current.key) });
        } catch (error) {
          if (error instanceof HistosPublishError) throw error;
          throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare la tassonomia.", "cms-taxonomy-invalid", 400);
        }
        return true;
      }
    }
    if (parts[4] === "taxonomies" && parts.length === 7 && parts[6] === "terms" && method === "GET") {
      const taxonomy = store.content.getTaxonomy(parts[5]!);
      if (!taxonomy) throw new HistosPublishError("Tassonomia non trovata.", "cms-taxonomy-missing", 404);
      sendJson(response, 200, { taxonomy, terms: store.content.listTerms(taxonomy.key) });
      return true;
    }
    if (parts[4] === "taxonomies" && parts.length === 7 && parts[6] === "terms" && method === "POST") {
      const taxonomy = store.content.getTaxonomy(parts[5]!);
      if (!taxonomy) throw new HistosPublishError("Tassonomia non trovata.", "cms-taxonomy-missing", 404);
      const body = await readJson(request, 64 * 1024);
      try {
        const saved = store.content.saveTerm({ taxonomyKey: taxonomy.key, slug: body.slug as string, label: body.label as string, ...(typeof body.parentAlias === "number" || body.parentAlias === null ? { parentAlias: body.parentAlias as number | null } : {}), expectedHead: null });
        if (saved.status === "conflict") throw new HistosPublishError("Il termine è cambiato in un’altra finestra.", "cms-content-conflict", 409);
        await context.catalog.saveManifest(project);
        sendJson(response, 201, { term: saved.term });
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare il termine.", "cms-term-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "taxonomies" && parts.length === 8 && parts[6] === "terms" && method === "PUT") {
      const taxonomy = store.content.getTaxonomy(parts[5]!);
      if (!taxonomy) throw new HistosPublishError("Tassonomia non trovata.", "cms-taxonomy-missing", 404);
      const alias = Number(parts[7]);
      const current = store.content.getTermByAlias(alias);
      if (!current || current.taxonomyKey !== taxonomy.key) throw new HistosPublishError("Termine tassonomia non trovato.", "cms-term-missing", 404);
      const body = await readJson(request, 64 * 1024);
      if (typeof body.head !== "string") throw new HistosPublishError("Indica la revisione del termine che stai modificando.", "cms-content-head-required", 400);
      try {
        const saved = store.content.saveTerm({ alias, taxonomyKey: taxonomy.key, slug: body.slug as string, label: body.label as string, ...(typeof body.parentAlias === "number" || body.parentAlias === null ? { parentAlias: body.parentAlias as number | null } : {}), expectedHead: body.head });
        if (saved.status === "conflict") {
          sendJson(response, 409, { code: "cms-content-conflict", error: "Il termine è cambiato in un’altra finestra.", current: saved.current });
          return true;
        }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { term: saved.term });
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare il termine.", "cms-term-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "records" && parts.length === 5 && method === "GET") {
      const typeKey = url.searchParams.get("type");
      if (!typeKey) throw new HistosPublishError("Scegli il tipo di contenuto da interrogare.", "cms-record-type-required", 400);
      const rawFilter = url.searchParams.get("filter");
      let filter: unknown;
      try { filter = rawFilter ? JSON.parse(rawFilter) as unknown : undefined; }
      catch { throw new HistosPublishError("Il filtro della query deve essere JSON valido.", "cms-record-filter-invalid", 400); }
      const status = url.searchParams.get("status") ?? "any";
      if (!new Set(["draft", "published", "archived", "any"]).has(status)) throw new HistosPublishError("Stato voce non valido.", "cms-record-query-invalid", 400);
      try {
        const result = store.content.listRecords({ typeKey, status: status as "draft" | "published" | "archived" | "any", ...(url.searchParams.get("locale") ? { locale: url.searchParams.get("locale")! } : {}), ...(url.searchParams.get("orderBy") ? { orderBy: url.searchParams.get("orderBy")! } : {}), ...(url.searchParams.has("q") ? { search: url.searchParams.get("q") ?? "" } : {}), order: url.searchParams.get("order") === "desc" ? "desc" : "asc", limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50, offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0, includePrivate: true, ...(filter === undefined ? {} : { filter: filter as never }) });
        sendJson(response, 200, result);
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "La query non è valida.", "cms-record-query-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "records" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 512 * 1024);
      try {
        const saved = store.content.createRecord({ typeKey: body.typeKey as string, title: body.title as string, ...(typeof body.slug === "string" ? { slug: body.slug } : {}), locale: typeof body.locale === "string" ? body.locale : store.getRenderSettings().locale, ...(typeof body.status === "string" ? { status: body.status as "draft" | "published" | "archived" } : {}), ...(typeof body.publishedAt === "string" ? { publishedAt: body.publishedAt } : {}), ...(typeof body.excerpt === "string" ? { excerpt: body.excerpt } : {}), ...(typeof body.order === "number" ? { order: body.order } : {}), values: body.values, ...(body.terms !== undefined ? { terms: body.terms } : {}) });
        if (saved.status === "conflict") throw new HistosPublishError("La voce è stata creata in un’altra finestra. Ricarica l’elenco.", "cms-content-conflict", 409);
        await context.catalog.saveManifest(project);
        sendJson(response, 201, { record: saved.record });
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare la voce.", "cms-record-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "records" && parts.length === 6) {
      if (method === "GET") {
        const record = store.content.getRecordById(parts[5]!, true);
        if (!record) throw new HistosPublishError("Voce non trovata.", "cms-record-missing", 404);
        sendJson(response, 200, { record });
        return true;
      }
      if (method === "PUT") {
        const body = await readJson(request, 512 * 1024);
        if (typeof body.head !== "string" || typeof body.typeKey !== "string") throw new HistosPublishError("Indica tipo e revisione attesa della voce.", "cms-content-head-required", 400);
        try {
          const saved = store.content.saveRecord({ id: parts[5]!, typeKey: body.typeKey, title: body.title as string, expectedHead: body.head, ...(typeof body.slug === "string" ? { slug: body.slug } : {}), ...(typeof body.locale === "string" ? { locale: body.locale } : {}), ...(typeof body.status === "string" ? { status: body.status as "draft" | "published" | "archived" } : {}), ...(typeof body.publishedAt === "string" || body.publishedAt === null ? { publishedAt: body.publishedAt as string | null } : {}), ...(typeof body.excerpt === "string" ? { excerpt: body.excerpt } : {}), ...(typeof body.order === "number" ? { order: body.order } : {}), values: body.values, ...(body.terms !== undefined ? { terms: body.terms } : {}) });
          if (saved.status === "conflict") {
            sendJson(response, 409, { code: "cms-content-conflict", error: "La voce è cambiata in un’altra finestra.", current: saved.current });
            return true;
          }
          await context.catalog.saveManifest(project);
          sendJson(response, 200, { record: saved.record });
        } catch (error) {
          if (error instanceof HistosPublishError) throw error;
          throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare la voce.", "cms-record-invalid", 400);
        }
        return true;
      }
    }
    if (parts[4] === "queries" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, histosQueryData(store));
      return true;
    }
    if (parts[4] === "queries" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 1024 * 1024);
      if (typeof body.head !== "string" || typeof body.base !== "string") throw new HistosPublishError("Ricarica la lista query e riprova: manca la revisione attesa.", "cms-content-head-required", 400);
      if (body.head !== body.base) throw new HistosPublishError("Questa versione del CMS non può unire due modifiche query concorrenti. Ricarica prima di salvare.", "cms-content-base-mismatch", 409);
      try {
        const saved = store.content.saveQueryPresets({ presets: body.presets, ...(body.sources !== undefined ? { sources: body.sources } : {}), expectedHead: body.head });
        if (saved.status === "conflict") {
          sendJson(response, 409, { code: "cms-content-conflict", error: "Le query sono state modificate in un’altra finestra. Ricarica prima di salvare.", current: histosQueryData(store), head: saved.head });
          return true;
        }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { head: saved.head, base: saved.head });
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare le query Histeon.", "cms-query-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "queries" && parts.length === 6 && parts[5] === "test" && method === "POST") {
      const body = await readJson(request, 128 * 1024);
      if (typeof body.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(body.id)) throw new HistosPublishError("Nome della query non valido.", "cms-query-invalid", 400);
      const preset = body.preset;
      const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params as Record<string, unknown> : {};
      try {
        const records = store.content.previewQueryDefinition(preset, params, store.getRenderSettings().locale);
        sendJson(response, 200, { items: queryPreviewRecords(store, project.id, records) });
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "La query non può essere provata.", "cms-query-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "queries" && parts.length === 6 && parts[5] === "options" && method === "GET") {
      const typeKey = url.searchParams.get("type");
      const taxonomies = store.content.listTaxonomies().filter((taxonomy) => !typeKey || taxonomy.types.includes(typeKey)).map((taxonomy) => ({ name: taxonomy.key, label: taxonomy.label, terms: store.content.listTerms(taxonomy.key).map((term) => ({ id: term.alias, name: term.label, slug: term.slug, count: term.count })) }));
      sendJson(response, 200, { taxonomies, authors: [], roles: [] });
      return true;
    }
    if (parts[4] === "query-presets" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, store.content.listQueryPresets());
      return true;
    }
    if (parts[4] === "query-presets" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 128 * 1024);
      try {
        const saved = store.content.saveQueryPreset({ key: body.key as string, label: body.label as string, typeKey: body.typeKey as string, ...(typeof body.limit === "number" ? { limit: body.limit } : {}), ...(typeof body.limitParam === "string" || body.limitParam === null ? { limitParam: body.limitParam as string | null } : {}), ...(typeof body.offset === "number" ? { offset: body.offset } : {}), ...(typeof body.offsetParam === "string" || body.offsetParam === null ? { offsetParam: body.offsetParam as string | null } : {}), ...(typeof body.orderBy === "string" ? { orderBy: body.orderBy } : {}), ...(body.order === "asc" || body.order === "desc" ? { order: body.order } : {}), ...(body.filter !== undefined ? { filter: body.filter } : {}), expectedHead: body.expectedHead === null || typeof body.expectedHead === "string" ? body.expectedHead : null });
        if (saved.status === "conflict") {
          sendJson(response, 409, { code: "cms-content-conflict", error: "La query è cambiata in un’altra finestra.", current: saved.current, head: saved.head });
          return true;
        }
        await context.catalog.saveManifest(project);
        sendJson(response, 201, saved);
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare la query.", "cms-query-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "query-presets" && parts.length === 6 && method === "PUT") {
      const body = await readJson(request, 128 * 1024);
      const current = store.content.listQueryPresets().presets.find((preset) => preset.key === parts[5]);
      if (!current) throw new HistosPublishError("Query non trovata.", "cms-query-missing", 404);
      if (typeof body.head !== "string") throw new HistosPublishError("Indica la revisione della query che stai modificando.", "cms-content-head-required", 400);
      try {
        const saved = store.content.saveQueryPreset({ key: current.key, label: body.label as string, typeKey: body.typeKey as string, ...(typeof body.limit === "number" ? { limit: body.limit } : {}), ...(typeof body.limitParam === "string" || body.limitParam === null ? { limitParam: body.limitParam as string | null } : {}), ...(typeof body.offset === "number" ? { offset: body.offset } : {}), ...(typeof body.offsetParam === "string" || body.offsetParam === null ? { offsetParam: body.offsetParam as string | null } : {}), ...(typeof body.orderBy === "string" ? { orderBy: body.orderBy } : {}), ...(body.order === "asc" || body.order === "desc" ? { order: body.order } : {}), ...(body.filter !== undefined ? { filter: body.filter } : {}), expectedHead: body.head });
        if (saved.status === "conflict") {
          sendJson(response, 409, { code: "cms-content-conflict", error: "La query è cambiata in un’altra finestra.", current: saved.current, head: saved.head });
          return true;
        }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, saved);
      } catch (error) {
        if (error instanceof HistosPublishError) throw error;
        throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a salvare la query.", "cms-query-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "query-presets" && parts.length === 7 && parts[6] === "preview" && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      try {
        const items = store.content.resolveQueryPreset(parts[5]!, body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {}, typeof body.locale === "string" ? body.locale : store.getRenderSettings().locale);
        sendJson(response, 200, { items, total: items.length });
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "La query non può essere eseguita.", "cms-query-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "pages" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (typeof body.title !== "string") throw new HistosPublishError("Il titolo della pagina è obbligatorio.", "cms-page-title-invalid", 400);
      const page = store.createPage({ title: body.title, ...(typeof body.slug === "string" ? { slug: body.slug } : {}) });
      await context.catalog.saveManifest(project);
      sendJson(response, 201, { page });
      return true;
    }
    if (parts[4] === "pages" && parts.length === 6 && method === "PATCH") {
      const alias = requireAlias(parts[5]);
      const entity = store.getEntityByAlias(alias);
      if (!entity || entity.kind !== "page" || entity.documentType !== "page") throw new HistosPublishError("Pagina CMS non trovata.", "cms-page-missing", 404);
      const body = await readJson(request, 16 * 1024);
      // Each control sends only its own field: a status or a template left out stays as it is.
      if (body.status !== undefined && body.status !== "draft" && body.status !== "published") throw new HistosPublishError("Scegli bozza o inclusione nella versione.", "cms-page-status-invalid", 400);
      if (typeof body.head !== "string" || store.getHead(entity.id)?.id !== body.head) throw new HistosPublishError("La pagina è cambiata in un’altra finestra. Ricarica il catalogo prima di cambiare stato.", "cms-page-revision-conflict", 409);
      if (body.templateRef !== undefined && body.templateRef !== null && typeof body.templateRef !== "string") throw new HistosPublishError("Il modello selezionato non è valido.", "cms-template-invalid", 400);
      if ((body.title !== undefined && typeof body.title !== "string") || (body.slug !== undefined && typeof body.slug !== "string")) throw new HistosPublishError("Titolo o indirizzo non validi.", "cms-page-invalid", 400);
      let page: CmsEntity;
      try { page = store.updatePageMetadata(entity.id, { title: typeof body.title === "string" ? body.title : entity.title, slug: typeof body.slug === "string" ? body.slug : entity.slug, status: body.status === undefined ? entity.status : body.status as "draft" | "published", ...(body.templateRef !== undefined ? { templateRef: body.templateRef as string | null } : {}) }); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Il modello non può essere assegnato alla pagina.", "cms-template-invalid", 400); }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { page });
      return true;
    }
    if (parts[4] === "posts" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, { posts: store.listPosts().map((post) => postInfo(store, post)) });
      return true;
    }
    if (parts[4] === "posts" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (typeof body.title !== "string") throw new HistosPublishError("Il titolo dell'articolo è obbligatorio.", "cms-post-title-invalid", 400);
      if (body.slug !== undefined && typeof body.slug !== "string") throw new HistosPublishError("L'indirizzo dell'articolo non è valido.", "cms-post-invalid", 400);
      let post: CmsEntity;
      try { post = store.createPost({ title: body.title, ...(typeof body.slug === "string" ? { slug: body.slug } : {}), ...(body.blank === true ? { content: "" } : {}) }); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare l'articolo.", "cms-post-invalid", 400); }
      await context.catalog.saveManifest(project);
      sendJson(response, 201, { post: postInfo(store, post) });
      return true;
    }
    if (parts[4] === "posts" && parts.length === 6 && method === "PATCH") {
      const alias = requireAlias(parts[5]);
      const entity = store.getEntityByAlias(alias);
      if (!entity || entity.kind !== "page" || entity.documentType !== "post") throw new HistosPublishError("Articolo CMS non trovato.", "cms-post-missing", 404);
      const body = await readJson(request, 64 * 1024);
      if (typeof body.head !== "string" || store.getHead(entity.id)?.id !== body.head) throw new HistosPublishError("L'articolo è cambiato in un’altra finestra. Ricarica il catalogo prima di modificarlo.", "cms-post-revision-conflict", 409);
      if (body.status !== "draft" && body.status !== "published") throw new HistosPublishError("Scegli bozza o pubblicato.", "cms-post-status-invalid", 400);
      const optionalString = (value: unknown, label: string): string | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== "string") throw new HistosPublishError(`${label} non è valido.`, "cms-post-invalid", 400);
        return value;
      };
      const title = optionalString(body.title, "Il titolo") ?? entity.title;
      const slug = optionalString(body.slug, "L'indirizzo") ?? entity.slug;
      const excerpt = optionalString(body.excerpt, "Il riassunto");
      if (body.publishedAt !== undefined && body.publishedAt !== null && typeof body.publishedAt !== "string") throw new HistosPublishError("La data di pubblicazione non è valida.", "cms-post-invalid", 400);
      if (body.templateRef !== undefined && body.templateRef !== null && typeof body.templateRef !== "string") throw new HistosPublishError("Il modello selezionato non è valido.", "cms-template-invalid", 400);
      // Doc 23 item 119: the featured image, a media id or null to take it away; left out, it stays.
      if (body.imageAssetId !== undefined && body.imageAssetId !== null && (typeof body.imageAssetId !== "string" || !UUID.test(body.imageAssetId))) throw new HistosPublishError("L'immagine dell'articolo non è valida.", "cms-post-invalid", 400);
      let terms: Record<string, string[]> | undefined;
      if (body.terms !== undefined) {
        if (!body.terms || typeof body.terms !== "object" || Array.isArray(body.terms)) throw new HistosPublishError("I termini dell'articolo non sono validi.", "cms-post-invalid", 400);
        terms = {};
        for (const [taxonomyKey, ids] of Object.entries(body.terms as Record<string, unknown>)) {
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !UUID.test(id))) throw new HistosPublishError("I termini dell'articolo non sono validi.", "cms-post-invalid", 400);
          terms[taxonomyKey] = ids as string[];
        }
      }
      let post: CmsEntity;
      try {
        post = store.updatePostMetadata(entity.id, {
          title, slug, status: body.status,
          ...(body.publishedAt !== undefined ? { publishedAt: body.publishedAt as string | null } : {}),
          ...(excerpt !== undefined ? { excerpt } : {}),
          ...(body.imageAssetId !== undefined ? { imageAssetId: body.imageAssetId as string | null } : {}),
          ...(terms !== undefined ? { terms } : {}),
          ...(body.templateRef !== undefined ? { templateRef: body.templateRef as string | null } : {}),
        });
      } catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco ad aggiornare l'articolo.", "cms-post-invalid", 400); }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { post: postInfo(store, post) });
      return true;
    }
    if (parts[4] === "templates" && parts.length === 7 && parts[6] === "role" && method === "PUT") {
      const alias = requireAlias(parts[5]);
      const template = store.getComponentByAlias(alias);
      if (!template || template.kind !== "template") throw new HistosPublishError("Modello CMS non trovato.", "cms-template-missing", 404);
      const body = await readJson(request, 4 * 1024);
      if (body.role !== null && (typeof body.role !== "string" || !(TEMPLATE_ROLES as readonly string[]).includes(body.role))) throw new HistosPublishError("Ruolo del modello non valido.", "cms-template-role-invalid", 400);
      let updated: CmsComponent;
      try { updated = store.setTemplateRole(template.id, body.role as TemplateRole | null); }
      catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco ad assegnare il ruolo.", "cms-template-role-invalid", 409); }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { template: { id: updated.id, alias: updated.alias, ref: updated.ref, title: updated.title, role: updated.role } });
      return true;
    }
    if (parts[4] === "library" && parts.length === 5 && method === "GET") {
      const type = url.searchParams.get("type");
      if (type !== "page" && type !== "post" && type !== "wp_block") throw new HistosPublishError("Tipo di contenuto non supportato.", "cms-library-type-invalid", 400);
      if (type === "post") throw new HistosPublishError("Le voci relazionali si gestiscono dal pannello Contenuti del progetto.", "cms-capability-unavailable", 422);
      const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200).toLocaleLowerCase("it-IT");
      const matches = (...values: string[]) => !search || values.some((value) => value.toLocaleLowerCase("it-IT").includes(search));
      const items = type === "page"
        ? store.listPages().filter((page) => matches(page.title, page.slug)).map((page) => ({ id: page.alias, title: page.title, slug: page.slug, status: page.status === "published" ? "publish" : "draft", modified: page.updatedAt, xb: true, ref: "", url: "" }))
        : store.listComponents().filter((component) => matches(component.title, component.ref)).map((component) => ({ id: component.alias, title: component.title, slug: component.ref, status: "draft", modified: component.updatedAt, xb: true, ref: component.ref, url: "" }));
      sendJson(response, 200, { items });
      return true;
    }
    if (parts[4] === "templates" && parts.length === 5) {
      if (method === "GET") {
        const templates = store.listTemplates().map((item) => ({
          type: "wp_template" as const, id: item.id, slug: item.ref, title: item.title, source: "custom", post: item.alias,
          group: "templates", groupLabel: "Modello di pagina", groupOrder: 1, description: "Modello Histeon di questo progetto.",
        }));
        const parts = store.listTemplateParts().map((item) => ({
          type: "wp_template_part" as const, id: item.id, slug: item.ref, title: item.title, source: "custom", post: item.alias,
          group: "template-parts", groupLabel: "Parti di modelli", groupOrder: 2, description: "Parte riutilizzabile del modello.",
        }));
        sendJson(response, 200, { items: [...templates, ...parts] });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 16 * 1024);
        if (typeof body.ref !== "string" || typeof body.title !== "string") throw new HistosPublishError("Inserisci la chiave e il nome del modello.", "cms-template-invalid", 400);
        let template: CmsComponent;
        try { template = store.createTemplate({ ref: body.ref, title: body.title }); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare il modello.", "cms-template-invalid", 400); }
        await context.catalog.saveManifest(project);
        sendJson(response, 201, componentDocumentInfo(template, store));
        return true;
      }
    }
    if (parts[4] === "template-parts" && parts.length === 5) {
      if (method === "GET") {
        sendJson(response, 200, { templateParts: store.listTemplateParts().map((item) => ({ id: item.id, alias: item.alias, ref: item.ref, title: item.title, headRevision: item.headRevision })) });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 16 * 1024);
        if (typeof body.ref !== "string" || typeof body.title !== "string") throw new HistosPublishError("Inserisci la chiave e il nome della parte di modelli.", "cms-template-part-invalid", 400);
        let templatePart: CmsComponent;
        try { templatePart = store.createTemplatePart({ ref: body.ref, title: body.title }); }
        catch (error) { throw new HistosPublishError(error instanceof Error ? error.message : "Non riesco a creare la parte di modelli.", "cms-template-part-invalid", 400); }
        await context.catalog.saveManifest(project);
        sendJson(response, 201, componentDocumentInfo(templatePart, store));
        return true;
      }
    }
    if (parts[4] === "documents" && parts.length === 6) {
      const alias = requireAlias(parts[5]);
      const entity = store.getEntityByAlias(alias);
      const component = entity ? null : store.getComponentByAlias(alias);
      if (!entity && !component) throw new HistosPublishError("Documento CMS non trovato.", "cms-document-missing", 404);
      if (method === "GET") {
        sendJson(response, 200, component ? componentDocumentInfo(component, store) : documentInfo(entity!, store));
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 8 * 1024 * 1024);
        if (typeof body.content !== "string" || typeof body.head !== "string") throw new HistosPublishError("Il documento o la revisione attesa non sono validi.", "cms-document-invalid", 400);
        // Doc 18 §6.6: the document's JavaScript, checked before anything is saved; written once the content is.
        const script = body.script === undefined ? undefined : body.script;
        if (script !== undefined) {
          if (component && component.kind !== "component" && script !== "") throw new HistosPublishError("Parti e modello non hanno JavaScript: mettilo nella pagina o in un componente.", "cms-document-script-invalid", 422);
          try {
            assertDocumentScript(script);
          } catch (error) {
            throw new HistosPublishError(error instanceof Error ? error.message : "JavaScript non valido.", "cms-document-script-invalid", 422);
          }
        }
        if (component) {
          let saved: CmsComponentSaveResult;
          try {
            saved = store.saveComponent({ alias, expectedHead: body.head, content: body.content, ref: typeof body.ref === "string" ? body.ref : component.ref, schema: body.schema ?? component.schema });
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("Non posso rinominare ")) throw new HistosPublishError(error.message, "cms-component-ref-in-use", 409);
            throw error;
          }
          if (saved.status === "conflict") {
            sendJson(response, 409, { error: "Il componente è cambiato in un’altra finestra. Il testo e le props inviati sono conservati come conflitto.", code: "cms-revision-conflict", conflict: saved.conflict, current: componentDocumentInfo(saved.current, store) });
            return true;
          }
          if (script !== undefined && saved.component.kind === "component") store.setDocumentScript(saved.component.id, script);
          await context.catalog.saveManifest(project);
          sendJson(response, 200, componentDocumentInfo(saved.component, store));
          return true;
        }
        if (!entity || entity.kind !== "page") throw new HistosPublishError("Pagina CMS non trovata.", "cms-page-missing", 404);
        const saved = store.saveDocument({ entityId: entity.id, expectedHead: body.head, content: body.content });
        if (saved.status === "conflict") {
          sendJson(response, 409, { error: "La pagina è cambiata in un’altra finestra. Il testo inviato è conservato come conflitto.", code: "cms-revision-conflict", conflict: saved.conflict, current: saved.current });
          return true;
        }
        if (script !== undefined) store.setDocumentScript(saved.entity.id, script);
        await context.catalog.saveManifest(project);
        sendJson(response, 200, documentInfo(saved.entity, store));
        return true;
      }
    }
    if (parts[4] === "styles" && parts.length === 5) {
      const entity = store.getStyles();
      if (!entity) throw new HistosPublishError("Archivio stili non inizializzato.", "cms-styles-missing", 500);
      if (method === "GET") {
        const revision = store.getHead(entity.id)!;
        const styles = compileCmsStyles(revision.content);
        sendJson(response, 200, { ...styles, head: revision.id, base: revision.id });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 4 * 1024 * 1024);
        if (!Array.isArray(body.styles) || !Array.isArray(body.globals) || typeof body.head !== "string") throw new HistosPublishError("Gli stili ricevuti non sono validi.", "cms-styles-invalid", 400);
        const current = stylesData(store.getHead(entity.id)!.content);
        const content = JSON.stringify({ ...current, styles: body.styles, globals: body.globals, compiledCss: "" });
        const incoming = stylesData(content);
        const assetIds = new Set(store.listAssets().map((asset) => asset.id));
        for (const sheet of incoming.globals ?? []) for (const asset of sheet.assets ?? []) {
          if (!assetIds.has(asset.assetId)) throw new HistosPublishError(`Il file collegato al CSS ${asset.reference} non esiste più nel progetto.`, "cms-css-asset-missing", 422);
        }
        for (const style of incoming.styles ?? []) for (const asset of style.assets ?? []) {
          if (!assetIds.has(asset.assetId)) throw new HistosPublishError(`Il file collegato al CSS ${asset.reference} non esiste più nel progetto.`, "cms-css-asset-missing", 422);
        }
        const saved = store.saveDocument({ entityId: entity.id, expectedHead: body.head, content });
        if (saved.status === "conflict") {
          sendJson(response, 409, { error: "Gli stili sono cambiati in un’altra finestra. La versione inviata è conservata come conflitto.", code: "cms-revision-conflict", conflict: saved.conflict, current: saved.current });
          return true;
        }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { ...compileCmsStyles(saved.revision.content), head: saved.revision.id, base: saved.revision.id });
        return true;
      }
    }
    if (parts[4] === "tokens" && parts.length === 5) {
      const entity = store.getStyles();
      if (!entity) throw new HistosPublishError("Archivio stili non inizializzato.", "cms-styles-missing", 500);
      if (method === "GET") {
        const revision = store.getHead(entity.id)!;
        const current = stylesData(revision.content);
        const design = validateHistosDesign(current.design ?? {});
        const tokens = validateHistosTokenOverrides(current.tokenOverrides ?? {}, new Set(histosTokenNames()));
        sendJson(response, 200, {
          tokens, names: histosTokenNames(), editable: true, head: revision.id, base: revision.id,
          design, defaults: HISTOS_DESIGN_DEFAULTS, contrast: histosContrast(design),
          // The site's own variables and recipes (builder docs/spec/design-system.md); no imported recipes here.
          siteTokens: validateSiteTokens(current.siteTokens ?? {}),
          recipes: { site: validateSiteRecipes(current.siteRecipes ?? {}), imported: {}, histos: histosFrameworkData().recipes },
        });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, 64 * 1024);
        if (typeof body.head !== "string" || typeof body.base !== "string") throw new HistosPublishError("La revisione degli stili non è valida.", "cms-styles-head-required", 400);
        let tokens: Record<string, string>;
        let design: Record<string, string | number> | undefined;
        let siteTokens: Record<string, string> | undefined;
        let siteRecipes: Record<string, string> | undefined;
        try {
          tokens = validateHistosTokenOverrides(body.tokens, new Set(histosTokenNames()));
          if (body.design !== undefined && body.design !== null) design = changedHistosDesign(validateHistosDesign(body.design));
          // Without them in the request, the saved ones stay.
          if (body.siteTokens !== undefined && body.siteTokens !== null) siteTokens = validateSiteTokens(body.siteTokens);
          if (body.recipes !== undefined && body.recipes !== null) siteRecipes = validateSiteRecipes(body.recipes);
        } catch (error) {
          throw new HistosPublishError(error instanceof Error ? error.message : "I token di design non sono validi.", "cms-design-invalid", 400);
        }
        const current = stylesData(store.getHead(entity.id)!.content);
        const content = JSON.stringify({ ...current, tokenOverrides: tokens, ...(design !== undefined ? { design } : {}), ...(siteTokens !== undefined ? { siteTokens } : {}), ...(siteRecipes !== undefined ? { siteRecipes } : {}), compiledCss: "" });
        const saved = store.saveDocument({ entityId: entity.id, expectedHead: body.head, content });
        if (saved.status === "conflict") {
          sendJson(response, 409, { error: "Il sistema di design è cambiato in un’altra finestra. I valori inviati restano disponibili come conflitto.", code: "cms-revision-conflict", conflict: saved.conflict, current: saved.current });
          return true;
        }
        await context.catalog.saveManifest(project);
        sendJson(response, 200, { head: saved.revision.id, base: body.base });
        return true;
      }
    }
    if (parts[4] === "tokens" && parts[5] === "source" && parts.length === 7 && method === "POST") {
      // Where the tokens come from when they are not plain JSON (cms-token-source.ts): an uploaded .penpot or .fig
      // file, or a file of Figma read from its API with the token of the keyring. Nothing is saved.
      if (parts[6] === "file") {
        const name = tokenSourceName(url.searchParams.get("name"));
        sendJson(response, 200, await tokenSourceFromFile(name, await readBytes(request, TOKEN_SOURCE_FILE_MAX, "Il file di design")));
        return true;
      }
      if (parts[6] === "figma") {
        sendJson(response, 200, await tokenSourceFromFigma(await readJson(request, 16 * 1024), context.secretStoreFor(FIGMA_TOKEN_ACCOUNT)));
        return true;
      }
    }
    if (parts[4] === "tokens" && parts[5] === "import" && parts.length === 6 && method === "POST") {
      // Design tokens of Figma or Penpot over the saved design (cms-token-import.ts): a report, or with `apply` a save.
      const entity = store.getStyles();
      if (!entity) throw new HistosPublishError("Archivio stili non inizializzato.", "cms-styles-missing", 500);
      const current = stylesData(store.getHead(entity.id)!.content);
      const plan = planTokenImport(await readJson(request, TOKEN_IMPORT_BODY_MAX), current);
      if (!plan.apply) {
        sendJson(response, 200, { ...plan.view, applied: false, head: plan.head });
        return true;
      }
      const saved = store.saveDocument({ entityId: entity.id, expectedHead: plan.head, content: JSON.stringify({ ...current, design: plan.design, siteTokens: plan.siteTokens, compiledCss: "" }) });
      if (saved.status === "conflict") {
        sendJson(response, 409, { error: "Il sistema di design è cambiato in un’altra finestra. I valori inviati restano disponibili come conflitto.", code: "cms-revision-conflict", conflict: saved.conflict, current: saved.current });
        return true;
      }
      await context.catalog.saveManifest(project);
      sendJson(response, 200, { ...plan.view, applied: true, head: saved.revision.id });
      return true;
    }
    if (parts[4] === "components" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, store.listComponents().map((component) => ({ id: component.alias, ref: component.ref, title: component.title, props: component.schema.props })));
      return true;
    }
    if (parts[4] === "components" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 8 * 1024 * 1024);
      if (typeof body.ref !== "string" || typeof body.title !== "string" || (body.content !== undefined && typeof body.content !== "string")) throw new HistosPublishError("Chiave, nome o contenuto del componente non validi.", "cms-component-invalid", 400);
      const component = store.createComponent({ ref: body.ref, title: body.title, ...(typeof body.content === "string" ? { content: body.content } : {}), ...(body.schema !== undefined ? { schema: body.schema } : {}) });
      await context.catalog.saveManifest(project);
      sendJson(response, 201, componentDocumentInfo(component, store));
      return true;
    }
    if (parts[4] === "framework" && parts.length === 5 && method === "GET") {
      const stylesEntity = store.getStyles();
      const stylesRevision = stylesEntity ? store.getHead(stylesEntity.id) : null;
      const data = stylesRevision ? stylesData(stylesRevision.content) : {};
      sendJson(response, 200, withSiteDesign(frameworkDataWithExternalCss(data.globals ?? []), data));
      return true;
    }
    if (parts[4] === "design" && parts[5] === "preview" && parts.length === 6 && method === "POST") {
      const body = await readJson(request, 64 * 1024);
      try {
        const design = validateHistosDesign(body.design);
        // «Esporta i token (DTCG)» and «Importa i token» of the panel ask for every printed token too (the live preview stays small).
        sendJson(response, 200, { css: histosPreviewCss(design), classesOff: histosClassOffPatterns(design), design, contrast: histosContrast(design), ...(body.tokens === true ? { tokens: histosExportTokens(design) } : {}) });
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "I parametri Histeon CSS non sono validi.", "cms-design-invalid", 400);
      }
      return true;
    }
    if (parts[4] === "paste" && parts[5] === "sanitize" && parts.length === 6 && method === "POST") {
      // The builder's restricted tier for the clipboard (docs/spec/quick-actions.md): taken whole or refused (checkPaste).
      // The content is capped (PASTE_MAX_CONTENT_BYTES, 413); the styles can add up to 500 × 64 KiB of CSS at most.
      const body = await readJson(request, 2 * 1024 * 1024);
      const pasteContext = {
        projectId: project.id,
        imageAssetIds: new Set(store.listAssets().filter((asset) => /^(?:image\/|application\/pdf$)/u.test(asset.mimeType)).map((asset) => asset.id)),
        componentRefs: store.listComponents().map((component) => component.ref),
        queryPresetKeys: new Set(store.content.listQueryPresets().presets.map((preset) => preset.key)),
        hasDataSources: Object.keys(store.content.listQuerySources()).length > 0,
      };
      try {
        sendJson(response, 200, checkPaste(body, pasteContext));
      } catch (error) {
        if (error instanceof PasteRefusedError) throw new HistosPublishError(error.message, `cms-paste-${error.reason}`, error.reason === "invalid" ? 400 : error.reason === "too-large" ? 413 : 422);
        throw error;
      }
      return true;
    }
    if (parts[4] === "render" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 8 * 1024 * 1024);
      if (typeof body.content !== "string") throw new HistosPublishError("Il documento da visualizzare non è valido.", "cms-document-invalid", 400);
      const componentAlias = Number.isSafeInteger(body.post_id) ? Number(body.post_id) : null;
      const entity = componentAlias === null ? null : store.getEntityByAlias(componentAlias);
      const page = entity?.kind === "page" ? documentScope(store, entity, store.getRenderSettings().locale) : undefined;
      const pageTemplateRef = entity?.kind === "page" ? documentTemplateRef(store, entity) : null;
      const renderComponent = componentAlias === null ? null : store.getComponentByAlias(componentAlias);
      const pageLocale = entity?.kind === "page" ? entity.locale ?? store.getRenderSettings().locale : store.getRenderSettings().locale;
      const rendered = await renderCmsSafely({ store, projectId: project.id, content: body.content, mediaBase: "/__cms-media", annotate: true, articleBlocks: true, ...store.getRenderSettings(), locale: pageLocale, ...linguaOf(entity?.kind === "page" ? canvasLanguages(store) : undefined, entity?.kind === "page" ? documentAddress(entity, store.getRenderSettings().locale) : "", pageLocale), ...(pageTemplateRef ? { templateRef: pageTemplateRef } : {}), ...(page ? { page } : {}), ...(renderComponent ? { rootComponentAlias: componentAlias! } : {}) });
      const style = store.getStyles();
      const revision = style ? store.getHead(style.id) : null;
      const styles = revision ? compileCmsStyles(revision.content) : compileCmsStyles("{}");
      sendJson(response, 200, { html: rendered.html.replace(/<style>[\s\S]*?<\/style>/u, ""), css: rendered.styleCss, globalCss: rendered.globalCss, stylesheets: [] });
      return true;
    }
    // The builder's «Font del sito» panel and Video window (doc 11): the same answers WordPress gives, from the project.
    if (parts[4] === "fonts" && parts.length === 5 && method === "GET") {
      sendJson(response, 200, fontsData(store, project.id));
      return true;
    }
    if (parts[4] === "fonts" && parts.length === 6 && parts[5] === "google" && method === "POST") {
      const answer = await importGoogleFont(store, project.id, await readJson(request, 4 * 1024), context.fontFetcher);
      await context.catalog.saveManifest(project);
      sendJson(response, 200, answer);
      return true;
    }
    if (parts[4] === "fonts" && parts.length === 5 && method === "DELETE") {
      const answer = removeFont(store, project.id, url.searchParams.get("family") ?? "");
      await context.catalog.saveManifest(project);
      sendJson(response, 200, answer);
      return true;
    }
    if (parts[4] === "video" && parts.length === 5 && method === "POST") {
      const answer = await videoInfo(store, project.id, await readJson(request, 4 * 1024), context.videoFetcher);
      await context.catalog.saveManifest(project);
      sendJsonWithHeaders(response, 200, answer, { "Cache-Control": "no-store, private" });
      return true;
    }
    if (parts[4] === "media" && parts.length === 5) {
      if (method === "GET") {
        const query = (url.searchParams.get("search") ?? "").trim().toLowerCase();
        // Images, as the editor's image picker asks; PDF with mime_type=application/pdf, as its picker of a file to link
        // asks (doc 23, item 176). Fonts never: they are not media of a page.
        const pdf = url.searchParams.get("mime_type") === "application/pdf";
        const listed = store.listAssets().filter((item) => (pdf ? item.mimeType === "application/pdf" : item.mimeType.startsWith("image/")) && (!query || item.filename.toLowerCase().includes(query) || item.alt.toLowerCase().includes(query)));
        sendJsonWithHeaders(response, 200, listed.map((asset) => mediaItem(project.id, asset)), { "X-WP-Total": String(listed.length), "X-WP-TotalPages": "1" });
        return true;
      }
      if (method === "POST") {
        const requestedMime = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const filename = url.searchParams.get("filename") ?? "immagine";
        const extension = path.extname(filename).toLowerCase();
        let mimeType = requestedMime;
        if (!IMAGE_MIME.has(requestedMime)) {
          mimeType = extension === ".pdf" ? "application/pdf" : FONT_MIME_BY_EXTENSION[extension] ?? "";
          if (!mimeType) throw new HistosPublishError("Carica un’immagine JPEG, PNG, WebP, GIF o AVIF, un PDF oppure un font WOFF, WOFF2, TTF o OTF.", "cms-media-type-invalid", 400);
        }
        const bytes = await readBytes(request, MAX_MEDIA_BYTES);
        if (!bytes.byteLength) throw new HistosPublishError("Il file è vuoto.", "cms-media-empty", 400);
        if (mimeType === "application/pdf" && Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new HistosPublishError("Il file non è un PDF.", "cms-media-pdf-invalid", 400);
        if (mimeType.startsWith("font/") && !validFontSignature(bytes, mimeType)) throw new HistosPublishError("Il contenuto del file non corrisponde al formato del font dichiarato.", "cms-media-font-invalid", 400);
        const asset = store.saveAsset({ bytes, mimeType, filename });
        await context.catalog.saveManifest(project);
        sendJson(response, 201, { ...mediaItem(project.id, asset), asset_id: asset.id });
        return true;
      }
    }
    if (parts[4] === "media" && parts.length === 6 && method === "POST") {
      const alias = requireAlias(parts[5]);
      const body = await readJson(request, 16 * 1024);
      if (body.alt_text !== undefined && typeof body.alt_text !== "string") throw new HistosPublishError("Testo alternativo non valido.", "cms-media-metadata-invalid", 400);
      const asset = store.updateAsset(alias, { ...(typeof body.alt_text === "string" ? { alt: body.alt_text } : {}) });
      if (!asset) throw new HistosPublishError("Immagine non trovata.", "cms-media-missing", 404);
      sendJson(response, 200, mediaItem(project.id, asset));
      return true;
    }
    if (parts[4] === "build" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (body.previewAlias !== undefined && (typeof body.previewAlias !== "number" || !Number.isSafeInteger(body.previewAlias))) throw new HistosPublishError("Pagina da visualizzare non valida.", "cms-page-invalid", 400);
      // A client that leaves cancels its build.
      const controller = new AbortController();
      const abortOnResponseClose = () => {
        if (!response.writableFinished) controller.abort();
      };
      response.once("close", abortOnResponseClose);
      try {
        sendJson(response, 200, await buildCmsProject(context, { project, store }, { keepGoing: true, ...(body.previewAlias === undefined ? {} : { previewAlias: body.previewAlias as number }), signal: controller.signal }));
      } finally {
        response.off("close", abortOnResponseClose);
      }
      return true;
    }
    if (parts[4] === "deploy" && parts.length === 5 && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      if (body.confirmed !== true) throw new HistosPublishError("Conferma il piano di pubblicazione prima di inviare il deploy.", "confirmation-required", 428);
      if (typeof body.planId !== "string" || !UUID.test(body.planId)) throw new HistosPublishError("Il piano di pubblicazione è mancante o non valido. Preparane uno nuovo.", "cms-publish-plan-invalid", 400);
      sendJson(response, 202, await context.executePublishPlan({ projectId: project.id, planId: body.planId, projectRevision: store.getProjectRevision() }));
      return true;
    }
    if (parts[4] === "export" && parts.length === 5 && method === "POST") {
      sendArchive(response, readableArchiveName(project.name, "xbsite"), await exportXbsiteArchive(project, store));
      return true;
    }
    // D5: the sections of the pages as a .xblibrary file for the builder's section library (another Histeon site).
    if (parts[4] === "section-library" && parts.length === 5 && method === "POST") {
      const pages = store.listPages().map((page) => ({ title: page.title, slug: page.slug, content: store.getHead(page.id)?.content ?? "" }));
      const stylesEntity = store.getStyles();
      const stylesContent = stylesEntity ? store.getHead(stylesEntity.id)?.content : undefined;
      const styles = stylesContent ? (stylesData(stylesContent).styles ?? []).map((style) => ({ selector: style.selector, css: style.css })) : [];
      const library = sectionLibrary({ projectId: project.id, projectName: project.name, pages, styles, created: new Date().toISOString() });
      sendJson(response, 200, { fileName: readableArchiveName(project.name, "xblibrary", "sezioni"), file: library.file, sections: library.sections, notes: library.notes });
      return true;
    }
    if (parts[4] === "backup" && parts.length === 5 && method === "POST") {
      const archive = await encodeNativeProjectArchive(project, store);
      sendArchive(response, readableArchiveName(project.name, "histosproject"), archive);
      return true;
    }
    return false;
  } finally {
    store.close();
  }
}

export async function handlePublicCmsMedia(request: IncomingMessage, response: ServerResponse, parts: string[], catalog: CmsProjectCatalog): Promise<boolean> {
  if (parts[0] !== "__cms-media") return false;
  if ((request.method ?? "GET") !== "GET" && (request.method ?? "GET") !== "HEAD") throw new HistosPublishError("Risorsa media in sola lettura.", "cms-media-readonly", 405);
  const projectId = requireProjectId(parts[1]);
  const assetId = parts[2];
  if (!assetId || !UUID.test(assetId)) throw new HistosPublishError("Immagine non trovata.", "cms-media-missing", 404);
  const opened = await catalog.openProject(projectId);
  if (!opened) throw new HistosPublishError("Progetto CMS non trovato.", "cms-project-missing", 404);
  try {
    const asset = await opened.store.readAsset(assetId);
    if (!asset) throw new HistosPublishError("Immagine non trovata.", "cms-media-missing", 404);
    const body = Buffer.from(asset.bytes);
    response.writeHead(200, {
      "Content-Type": asset.metadata.mimeType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return true;
  } finally {
    opened.store.close();
  }
}

function mimeExtension(mimeType: string): string {
  const extension: Record<string, string> = { "image/avif": "avif", "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const value = extension[mimeType];
  if (!value) throw new HistosPublishError("Tipo immagine non pubblicabile.", "cms-media-type-invalid", 422);
  return value;
}
