import { checkOutsideCopy, OPEN_COPY_BODY_MAX_BYTES, openSealedCopy, startAutomaticCopies } from "./automatic-copies.js";
import { ConvertedMedia } from "./converted-media.js";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import {
  CloudflareClient,
  HistosPublishError,
  SystemKeyringSecretStore,
  attachCustomDomain,
  buildBundle,
  createSiteConfig,
  detectOnlineSite,
  detectSource,
  deployBundle,
  exportBundle,
  inspectCustomDomain,
  isPrivateOriginHost,
  parseSiteConfig,
  planCloudflareManifest,
  readDirectorySource,
  rollbackVersion,
  SITE_WORKER_PATH,
  turnstileSecretAccount,
  validateKvBindingNames,
  validateSiteWorker,
  addFoundKvDeclarations,
  kvBindingsInWorker,
  type ApprovedCnameRecord,
  type BundleFile,
  type BuildEvent,
  type CloudflareDeployment,
  type DeployBundleResult,
  type DeployEvent,
  type DeployPhase,
  type Destination,
  type Finding,
  type CompareRenders,
  type RenderPage,
  type SiteConfig,
} from "@histos-publish/core";
import { AppRepository, type StoredBuild, type StoredDeploy, type StoredSite } from "./repository.js";
import { CmsProjectCatalog, CmsProjectRestoreConflictError, HISTOS_PUBLISH_VERSION, measureSelectable, proposalSite, scriptRenderedSigns, staticSiteProjectId, staticSiteToPrototype, groupConversionNotes, type ProposalSite } from "@histos-publish/cms";
import { handleCmsApi, handlePublicCmsMedia, readableArchiveName, type CmsBuildBundle, type CmsBuildLimits, type CmsDestinationInspection, type CmsOperationsContext, type CmsPublishPlan } from "./cms-api.js";
import { handleConnectorApi } from "./connector-api.js";
import { rewritePreviewCss, rewritePreviewHtml } from "./preview-rewrite.js";
import { removeStalePrototypeScratch } from "./connector-files.js";
import { ConnectorService, type ConnectorServiceOptions } from "./connector-server.js";
import type { OpenPageProbe } from "./prototype-verify.js";
import { defaultDataDirectory } from "@histos-publish/connector/data-directory";
import { CmsBuildRegistry } from "./cms-build-registry.js";
import { resolveCmsDestination as resolveCmsDestinationProfile } from "./cms-destination-resolver.js";
import { CMS_HOSTING_BACKUP_MAX_BYTES, CmsHostingBackupStore, type CmsHostingBackupFile } from "./cms-hosting-backups.js";
import { CmsRemoteCatalog, connectRemoteSite } from "./cms-remote.js";
import { parseDatabaseConnectionInput, probeDatabaseConnection, storedDatabaseConnection, wordpressDatabaseVersionSupported, type StoredDatabaseConnection } from "./database-probe.js";
import { parseDatabaseSshEndpoint, readDatabaseSshHostFingerprint } from "./database-ssh-tunnel.js";
import { ImportManager } from "./imports.js";
import { keepProposal } from "./proposal-store.js";
import { PROPOSAL_ORIGINAL_PREFIX, ProposalOriginals, sendStill, stillPolicy, type OpenPagePhotos } from "./proposal-compare.js";
import { capturedProposalSite, PROPOSAL_FRAME_PREFIX, ProposalFrames, proposalFrameDocument, proposalFrameHeaders } from "./proposal-frame.js";
import { PrototypePreviews } from "./prototype-previews.js";
import { downloadGoogleFonts, otherScriptCodePoints, type FontFetcher } from "./google-fonts.js";
import { ImportProgressBoard } from "./import-progress.js";
import { ImportReports } from "./import-reports.js";
import { captureStaticHostingPreviousFiles, inspectStaticHostingDirectory, parseStaticHostingSettings, publishStaticBundle, restoreStaticHostingBackup, uploadStaticHostingFiles, verifyStaticHostingConnection, withTemporaryStaticHostingFile, type StaticHostingCredentials, type StaticHostingDirectoryInspection, type StaticHostingFile, type StaticHostingProgress, type StaticHostingRollbackFile, type StaticHostingSettings } from "./static-hosting.js";
import { probeWordPressPhpRuntime, type WordPressPhpRuntime, type WordPressRuntimeProbeOptions } from "./wordpress-runtime-probe.js";
import { downloadVerifiedWordPressCore } from "./wordpress-core-release.js";
import { WordPressProvisionCatalog, buildWordPressConfigPlaceholder, buildWordPressProvisionBootstrap, parseWordPressProvisionBootstrapResponse, postWordPressProvisionJson, wordpressProvisionConnectionId, type WordPressProvisionPost, type WordPressProvisionSnapshot } from "./wordpress-provisioner.js";
import { persistWordPressProvisionArtifacts, readVerifiedHistosPluginRelease, readWordPressProvisionArtifacts } from "./wordpress-provision-artifacts.js";
import { buildWordPressDatabaseTlsDropIn } from "./wordpress-db-tls-dropin.js";
import { checkPublishedHome, type PublishedHomeCheck } from "./published-home.js";
import { hasValidOrigin, hasValidToken, isHostAllowed, readJson, requestErrorCode, requestErrorStatus, safeErrorIssues, safeErrorIssuesTotal, safeErrorMessage, sendError, sendJson } from "./http.js";
import { removeTemporary } from "./remove-temporary.js";
import { fetchPrototypeAsset } from "./prototype-assets.js";
import { CONNECTOR_CHOICES_WAIT_MS } from "./connector-choices.js";
import { parseChoiceAnswers, parseRefineSettingsChange, readRefineSettings, refineAsk, refineImportChoices, REFINE_HAIKU_KEY_ACCOUNT, REFINE_LOCAL_KEY_ACCOUNT, REFINE_SETTINGS_KEY, type RefineSettings } from "./import-refine.js";
import type { AskChoices } from "@histos-publish/cms";
import { FOLDERS_SETTING, createFolder, deleteFolder, dropMember, moveToFolder, readFolders, renameFolder, type FolderKind } from "./folders.js";

const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const UI_DIRECTORY = path.resolve(SERVER_DIRECTORY, "../../ui/dist");
const PREVIEW_TTL_MS = 5 * 60 * 1000;
/** How long deleted CMS projects and sites stay in the Cestino before they go for good, at the next start. */
const TRASH_DAYS = 30;
/** HTML and CSS up to this size are rewritten for the preview; larger files are served as they are. */
const PREVIEW_REWRITE_MAX_BYTES = 2 * 1024 * 1024;
const CMS_PUBLISH_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_CMS_BUILD_BYTES = 250 * 1024 * 1024;
const AUTO_PORT_MIN = 49152;
const AUTO_PORT_MAX = 65535;

export interface SecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

export interface CmsDeployAdapters {
  cloudflare?: (input: { accountId: string; script: string; maxFiles?: number; files: BundleFile[]; signal: AbortSignal; onEvent: (event: DeployEvent) => void }) => Promise<DeployBundleResult>;
  hosting?: (input: { settings: StaticHostingSettings; credentials: StaticHostingCredentials; files: StaticHostingFile[]; signal: AbortSignal; onProgress: (progress: StaticHostingProgress) => void }) => Promise<{ uploaded: number; files: number; publicUrl?: string }>;
  hostingSnapshot?: (input: { settings: StaticHostingSettings; credentials: StaticHostingCredentials; files: StaticHostingFile[]; expectedRemoteFiles: StaticHostingDirectoryInspection["remoteFiles"]; expectedInventoryComplete: boolean; signal: AbortSignal }) => Promise<Array<{ path: string; beforeBytes: Buffer | null }>>;
  hostingRestore?: (input: { settings: StaticHostingSettings; credentials: StaticHostingCredentials; entries: CmsHostingBackupFile[]; signal: AbortSignal }) => Promise<{ restored: number; removed: number; alreadyRestored: number }>;
}

export interface CmsRollbackAdapterInput {
  accountId: string;
  script: string;
  versionId: string;
  signal: AbortSignal;
}

export interface LocalServerOptions {
  port?: number;
  dataDirectory?: string;
  /** One copy a day of each site that changed, three kept. Tests turn it off. */
  automaticCopies?: boolean;
  uiDirectory?: string;
  openBrowser?: boolean;
  /** Test seam: downloads remote prototype images instead of the public HTTPS client. */
  /**
   * Doc 27, G3: where the refinement of a conversion sends its batches. Tests point the Claude API at a fake server;
   * the local server is a setting anyway.
   */
  importRefine?: { anthropicBaseUrl?: string; timeoutMs?: number; ask?: (settings: RefineSettings, key: string | null) => AskChoices };
  /** Test seam for the Google Fonts download of a site conversion (B5); the default reaches only Google and GitHub. */
  fontFetcher?: FontFetcher;
  cmsPrototypeAssetFetcher?: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
  /**
   * The AI connector (docs/progettazione/histos-cms/16-connettore-ai.md). Off until the user turns it on; these
   * options only say where its client and exports live.
   */
  connector?: {
    /** The bundled client to copy next to session.json (packages/connector/dist/histos-publish-connector.mjs). */
    clientScript?: string;
    /** Folder for .xbsite exports the agent asks for (default <data>/connector/exports). */
    exportDirectory?: string;
    appVersion?: string;
    /** Test seams. */
    minFreeBytes?: number;
    wordpressPlan?: ConnectorServiceOptions["wordpressPlan"];
    wordpressApply?: ConnectorServiceOptions["wordpressApply"];
    onApprovals?: ConnectorServiceOptions["onApprovals"];
  };
  /** Opens the one-time launch address in the browser (tests replace the system launcher). */
  launchBrowser?: (url: string) => Promise<unknown>;
  secretStoreFactory?: (account: string) => SecretStore;
  renderPage?: RenderPage;
  /** Doc 23 item 101: the desktop app photographs a page before and after the utility conversion. */
  compareRenders?: CompareRenders;
  /** Doc 17 item 4: the desktop app opens the pages of a prototype's preview in a hidden window (overflow and axe). */
  openPageProbe?: OpenPageProbe;
  /** «Uguale alla proposta»: the desktop app photographs the captured proposal and the built site in a hidden window. */
  photographPages?: OpenPagePhotos;
  /** Test seam. When omitted, CMS deployments use the same concrete providers as ordinary site deployments. */
  cmsDeployAdapters?: CmsDeployAdapters;
  /** Test seam for bounded CMS builds; production defaults to 50,000 routes and 120 seconds. */
  cmsBuildLimits?: Partial<CmsBuildLimits>;
  /** Test seam for observing build cancellation and cleanup. */
  cmsBuildBundle?: CmsBuildBundle;
  /** Test seam for a version rollback; production uses Cloudflare's deployment API. */
  cmsRollbackAdapter?: (input: CmsRollbackAdapterInput) => Promise<CloudflareDeployment>;
  /** Test seam for the read-only public home check run after an upload. */
  publishedHomeCheck?: typeof checkPublishedHome;
  /** Test seam for read-only MySQL/MariaDB connectivity checks. */
  databaseProbe?: typeof probeDatabaseConnection;
  /** Test seam for verifying saved FTP/FTPS/SFTP destinations. */
  hostingConnectionVerification?: typeof verifyStaticHostingConnection;
  /** Test seam for read-only remote directory inspection. */
  hostingDirectoryInspection?: typeof inspectStaticHostingDirectory;
  /** Test seam for non-mutating CMS destination inspection. */
  cmsDestinationInspection?: (input: { projectId: string; destinationId: string }) => Promise<CmsDestinationInspection>;
  /** Test seam for the authenticated, temporary remote PHP runtime check. */
  wordpressRuntimeProbe?: (input: WordPressRuntimeProbeOptions) => Promise<WordPressPhpRuntime>;
  /** Test seams for the new WordPress installer; defaults use verified WordPress.org releases and saved hosting credentials. */
  wordpressProvisioning?: {
    downloadCore?: typeof downloadVerifiedWordPressCore;
    loadHistosPlugin?: typeof readVerifiedHistosPluginRelease;
    uploadFiles?: typeof uploadStaticHostingFiles;
    withTemporaryFile?: typeof withTemporaryStaticHostingFile;
    postJson?: WordPressProvisionPost;
    connectRemote?: typeof connectRemoteSite;
  };
}

export interface LocalServerHandle {
  port: number;
  url: string;
  token: string;
  dataDirectory: string;
  /** «Fotografa la proposta»: the origin that serves the proposal's sealed frame; the app's policy lets it be framed. */
  captureOrigin: string;
  close(): Promise<void>;
}

/**
 * A port another program holds (EADDRINUSE), or one Windows reserves for Hyper-V/WSL in the dynamic range and
 * refuses with EACCES: either way, the next candidate is tried.
 */
function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EADDRINUSE" || (process.platform === "win32" && error.code === "EACCES"));
}

function listenOnPort(server: ReturnType<typeof createHttpServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, "127.0.0.1");
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });
}

async function listenOnAvailablePort(server: ReturnType<typeof createHttpServer>, requestedPort: number): Promise<void> {
  if (requestedPort !== 0) {
    await listenOnPort(server, requestedPort);
    return;
  }

  const portCount = AUTO_PORT_MAX - AUTO_PORT_MIN + 1;
  const firstOffset = randomInt(portCount);
  for (let offset = 0; offset < portCount; offset++) {
    const port = AUTO_PORT_MIN + ((firstOffset + offset) % portCount);
    try {
      await listenOnPort(server, port);
      return;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }

  throw new HistosPublishError(
    `Non trovo una porta libera per Histeon Publish nell'intervallo ${AUTO_PORT_MIN}–${AUTO_PORT_MAX}. Chiudi un'applicazione che usa molte porte locali e riprova.`,
    "server-port-exhausted",
    1,
  );
}

interface Job {
  id: string;
  type: "build" | "deploy";
  siteId: string;
  status: "running" | "complete" | "failed" | "cancelled";
  controller: AbortController;
  /** The last phase a Cloudflare publish reached: where it stopped, if it fails (doc 23, voce 228). */
  phase?: DeployPhase;
  events: unknown[];
  subscribers: Set<ServerResponse>;
}

interface PreviewTicket {
  buildId: string;
  bundlePath: string;
  expiresAt: number;
}

interface CmsReadyBuild {
  projectId: string;
  buildId: string;
  bundlePath: string;
  projectRevision: string;
  files: number;
  pages: number;
  assets: number;
  totalBytes: number;
  findings: Finding[];
}

interface PendingCmsPublishPlan {
  response: CmsPublishPlan;
  bundleSha256: string;
  destinationSha256: string;
  inspectionSha256: string;
  expiresAtMs: number;
  state: "ready" | "checking" | "starting" | "started";
  startedResult?: Record<string, unknown>;
}

type CloudflareSettings = NonNullable<SiteConfig["cloudflare"]>;

/** Shared with the connector client, which looks for connector/session.json in the same folder. */
export { defaultDataDirectory };

function configDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "HistosPublish");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "histos-publish");
}

function slugify(value: string): string {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63).replace(/-+$/u, "");
  return slug || "nuovo-sito";
}

/** The proposal `proposalId` of the uploaded `kit proposte` file (its first .html file), as a site for the conversion. */
function proposalSiteOf(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, proposalId: string): ProposalSite {
  const file = files.find((item) => /\.html?$/iu.test(item.path));
  if (!file) throw new HistosPublishError("Il file di proposte manca nell'importazione.", "cms-site-conversion-invalid", 422);
  try {
    return proposalSite(new TextDecoder("utf-8").decode(file.bytes), proposalId);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw new HistosPublishError(error.message, "cms-site-conversion-invalid", 422);
    throw error;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cmsBundleSha256(files: readonly BundleFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const bytes = file.bytes;
    if (!bytes) throw new HistosPublishError("Il bundle contiene un file senza contenuto verificabile.", "cms-build-invalid", 422);
    hash.update(file.path).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function cmsDestinationSha256(site: StoredSite): string {
  return sha256(JSON.stringify({
    id: site.id,
    name: site.name,
    deployTarget: site.config.deployTarget ?? "cloudflare",
    cloudflare: site.config.cloudflare ?? null,
    hosting: site.config.hosting ?? null,
  }));
}

function cmsInspectionSha256(inspection: CmsDestinationInspection): string {
  const { checkedAt: _checkedAt, ...snapshot } = inspection;
  return sha256(JSON.stringify(snapshot));
}

function parseWordPressProvisionInput(value: unknown): { databaseConnectionId: string; siteTitle: string; adminUsername: string; adminEmail: string; adminPassword: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistosPublishError("Completa i dati per il nuovo sito WordPress.", "wordpress-provision-input-invalid", 400);
  const input = value as Record<string, unknown>;
  const databaseConnectionId = typeof input.databaseConnectionId === "string" ? input.databaseConnectionId : "";
  const siteTitle = typeof input.siteTitle === "string" ? input.siteTitle.trim() : "";
  const adminUsername = typeof input.adminUsername === "string" ? input.adminUsername.trim() : "";
  const adminEmail = typeof input.adminEmail === "string" ? input.adminEmail.trim() : "";
  const adminPassword = typeof input.adminPassword === "string" ? input.adminPassword : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(databaseConnectionId)) throw new HistosPublishError("Scegli una connessione MySQL o MariaDB verificata.", "database-connection-missing", 404);
  if (!siteTitle || Buffer.byteLength(siteTitle, "utf8") > 120 || /\p{Cc}/u.test(siteTitle)) throw new HistosPublishError("Il titolo del sito deve contenere da 1 a 120 byte e non includere caratteri di controllo.", "wordpress-provision-site-title-invalid", 400);
  if (!/^[A-Za-z0-9_.-]{1,60}$/u.test(adminUsername)) throw new HistosPublishError("Il nome amministratore può contenere lettere, numeri, punto, trattino e underscore (massimo 60 caratteri).", "wordpress-provision-admin-username-invalid", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(adminEmail) || Buffer.byteLength(adminEmail, "utf8") > 254 || /[\r\n\0]/u.test(adminEmail)) throw new HistosPublishError("Inserisci un indirizzo email valido per l’amministratore WordPress.", "wordpress-provision-admin-email-invalid", 400);
  if (adminPassword.length < 14 || Buffer.byteLength(adminPassword, "utf8") > 4096 || /[\0]/u.test(adminPassword)) throw new HistosPublishError("La password amministratore deve contenere almeno 14 caratteri.", "wordpress-provision-admin-password-invalid", 400);
  return { databaseConnectionId, siteTitle, adminUsername, adminEmail, adminPassword };
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => {
    const match = /(?:^|\D)(\d+)\.(\d+)(?:\.(\d+))?/u.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
  };
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index]! > minimumParts[index]!) return true;
    if (actualParts[index]! < minimumParts[index]!) return false;
  }
  return true;
}

function wordpressProvisionPublic(plan: ReturnType<WordPressProvisionCatalog["get"]>): unknown {
  if (!plan) return null;
  const snapshot = plan.snapshot;
  const bytes = (files: Array<{ bytes: number }>) => files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    id: snapshot.id,
    siteId: snapshot.siteId,
    state: plan.state,
    phase: plan.phase,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    expiresAt: snapshot.expiresAt,
    errorCode: plan.errorCode,
    target: snapshot.target,
    database: snapshot.database,
    siteTitle: snapshot.siteTitle,
    adminUsername: snapshot.adminUsername,
    adminEmail: snapshot.adminEmail,
    wordpress: { version: snapshot.wordpress.version, phpMinimum: snapshot.wordpress.phpMinimum, mysqlMinimum: snapshot.wordpress.mysqlMinimum, fileCount: snapshot.wordpress.files.length, bytes: bytes(snapshot.wordpress.files), archiveSha256: snapshot.wordpress.archiveSha256 },
    histos: { version: snapshot.histos.version, fileCount: snapshot.histos.files.length, bytes: bytes(snapshot.histos.files), archiveSha256: snapshot.histos.archiveSha256 },
    result: plan.result,
  };
}

function displaySource(config: SiteConfig): { kind: SiteConfig["source"]["kind"]; label: string } {
  if (config.source.kind === "url") {
    try { return { kind: "url", label: new URL(config.source.path).hostname }; } catch { return { kind: "url", label: "Sito online" }; }
  }
  if (config.source.kind === "html" || config.source.kind === "zip") return { kind: config.source.kind, label: path.basename(config.source.path) || (config.source.kind === "html" ? "File HTML" : "Archivio ZIP") };
  if (config.source.kind === "cms") return { kind: "cms", label: "Progetto Histeon CMS" };
  return { kind: config.source.kind, label: "Cartella" };
}

/** Where a site's deploy goes, as one string the publish summary repeats back (E6). */
function siteDeployDestination(config: SiteConfig): string {
  return (config.deployTarget ?? "cloudflare") === "ftp"
    ? `ftp|${config.hosting?.protocol ?? ""}|${config.hosting?.host ?? ""}|${config.hosting?.remoteDirectory ?? ""}`
    : `cloudflare|${config.cloudflare?.script ?? ""}`;
}

function safeSite(site: StoredSite, repository: AppRepository): Record<string, unknown> {
  // The site's build is the newest that finished; a newer cancelled or failed one is only the last attempt (E13).
  const build = repository.latestFinishedBuild(site.id);
  const attempt = repository.listBuilds(site.id, 1)[0];
  const deploy = repository.listDeploys(site.id, 1)[0];
  const needsBuild = Boolean(build && Date.parse(build.createdAt) < Date.parse(site.sourceUpdatedAt));
  const deployTarget = site.config.deployTarget ?? "cloudflare";
  const publicUrl = deployTarget === "ftp"
    ? site.config.hosting?.publicUrl ?? deploy?.workersDevUrl ?? null
    : site.config.cloudflare?.domain ? `https://${site.config.cloudflare.domain}` : deploy?.workersDevUrl ?? null;
  return {
    id: site.id,
    name: site.name,
    source: displaySource(site.config),
    ...(site.config.source.kind === "url" ? { sourceUrl: site.config.source.path } : {}),
    // A destination of a Histeon CMS project (E6): the app shows the project instead of a source and a build.
    ...(site.config.source.kind === "cms" ? { cmsProjectId: site.config.source.path } : {}),
    deployTarget,
    deployDestination: siteDeployDestination(site.config),
    hosting: site.config.hosting ?? null,
    hostingCredentialsConfigured: repository.getSetting<boolean>(`hostingCredentials:${site.id}`) ?? false,
    accountId: site.config.cloudflare?.accountId ?? null,
    worker: site.config.cloudflare?.script ?? null,
    domain: site.config.cloudflare?.domain ?? null,
    publicUrl,
    render: site.config.crawl?.render ?? false,
    pagefind: site.config.pagefind ?? false,
    forms: site.config.forms ?? null,
    // The site's own server code, uploaded apart from its files, and the KV archives it is bound to.
    workerModule: site.config.cloudflare?.workerModule ? { name: site.config.cloudflare.workerModule.name } : null,
    kv: site.config.cloudflare?.kv ?? [],
    turnstileSecretConfigured: repository.getSetting<boolean>(`turnstileSecret:${site.id}`) ?? false,
    externalAssets: site.config.rewrite?.externalAssets ?? [],
    wpCredentialsConfigured: repository.getSetting<boolean>(`wpCredentials:${site.id}`) ?? false,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    sourceUpdatedAt: site.sourceUpdatedAt,
    needsBuild,
    lastBuild: build ? { id: build.id, status: build.status, createdAt: build.createdAt, completedAt: build.completedAt, files: build.result?.files, pages: build.result?.pages } : null,
    lastAttempt: attempt && attempt.id !== build?.id ? { id: attempt.id, status: attempt.status, createdAt: attempt.createdAt } : null,
    lastDeploy: deploy ? { id: deploy.id, status: deploy.status, createdAt: deploy.createdAt, versionId: deploy.versionId, deploymentId: deploy.deploymentId, workersDevUrl: deploy.workersDevUrl, healthCheck: deploy.healthCheck } : null,
  };
}

/** Aborted when the client leaves before the answer: a refinement stops asking the model. */
function closedSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

function storeFor(account: string, factory?: LocalServerOptions["secretStoreFactory"]): SecretStore {
  return factory?.(account) ?? new SystemKeyringSecretStore(undefined, "histos-publish", account);
}

async function tokenConfigured(store: SecretStore): Promise<{ configured: boolean; source: "environment" | "keyring" | null; available: boolean }> {
  if (process.env.HISTOS_CLOUDFLARE_API_TOKEN?.trim()) return { configured: true, source: "environment", available: true };
  try {
    const value = await store.get();
    return { configured: Boolean(value), source: value ? "keyring" : null, available: true };
  } catch {
    return { configured: false, source: null, available: false };
  }
}

function cloudflareClient(token: string): CloudflareClient {
  const apiBase = process.env.HISTOS_CLOUDFLARE_API_BASE;
  return new CloudflareClient({ token, ...(apiBase === undefined ? {} : { apiBase }) });
}

async function cloudflareClientFromStore(store: SecretStore): Promise<CloudflareClient> {
  const token = process.env.HISTOS_CLOUDFLARE_API_TOKEN?.trim() || await store.get();
  if (!token) throw new HistosPublishError("Token Cloudflare assente. Inseriscilo in Impostazioni o configura HISTOS_CLOUDFLARE_API_TOKEN.", "cloudflare-auth-missing", 4);
  return cloudflareClient(token);
}

function siteSettings(config: SiteConfig, settingsAccountId: string): CloudflareSettings {
  const current = config.cloudflare ?? {};
  return {
    ...(current.accountId ?? settingsAccountId ? { accountId: current.accountId ?? settingsAccountId } : {}),
    ...(current.script === undefined ? {} : { script: current.script }),
    ...(current.domain === undefined ? {} : { domain: current.domain }),
    ...(current.maxFiles === undefined ? {} : { maxFiles: current.maxFiles }),
    ...(current.workerModule === undefined ? {} : { workerModule: current.workerModule }),
    ...(current.kv === undefined ? {} : { kv: current.kv }),
  };
}

function configuredAccountId(repository: AppRepository): string {
  return process.env.HISTOS_CLOUDFLARE_ACCOUNT_ID?.trim()
    || repository.getSetting<string>("cloudflareAccountId")?.trim()
    || "";
}

function requireCloudflare(settings: CloudflareSettings): { accountId: string; script: string; maxFiles?: number } {
  if (!settings.accountId || !settings.script) throw new HistosPublishError("Imposta account Cloudflare e nome Worker prima di continuare.", "cloudflare-config", 2);
  if (!/^[0-9a-f]{32}$/iu.test(settings.accountId) || !/^[a-z0-9-]{1,63}$/u.test(settings.script)) throw new HistosPublishError("Account Cloudflare o nome Worker non valido.", "cloudflare-config", 2);
  return { accountId: settings.accountId, script: settings.script, ...(settings.maxFiles === undefined ? {} : { maxFiles: settings.maxFiles }) };
}

function isApprovedCnameRecord(value: unknown): value is ApprovedCnameRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id.length <= 128
    && typeof record.name === "string" && record.name.length <= 255
    && typeof record.content === "string" && record.content.length <= 255
    && typeof record.proxied === "boolean";
}

function buildOptions(config: SiteConfig, outputDirectory: string, signal: AbortSignal, crawlConsent?: string, credentials?: { basicUser?: string; basicPassword?: string; cookie?: string }, onEvent?: (event: BuildEvent) => void, renderPage?: RenderPage, privateOrigin = false) {
  return {
    source: config.source,
    outputDirectory,
    ...(config.include === undefined ? {} : { include: config.include }),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    ...(config.crawl?.maxBytes === undefined ? {} : { maxBytes: config.crawl.maxBytes }),
    ...(config.crawl === undefined ? {} : { crawl: config.crawl }),
    ...(config.rewrite === undefined ? {} : { rewrite: config.rewrite }),
    ...(config.dynamic === undefined ? {} : { dynamic: config.dynamic }),
    ...(config.pagefind === undefined ? {} : { pagefind: config.pagefind }),
    ...(config.forms === undefined ? {} : { forms: config.forms }),
    ...(config.cloudflare?.workerModule === undefined ? {} : { workerPath: config.cloudflare.workerModule.path }),
    ...(crawlConsent === undefined ? {} : { crawlConsent }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(renderPage === undefined ? {} : { renderPage }),
    ...(privateOrigin ? { privateOrigin: true } : {}),
    signal,
    ...(onEvent === undefined ? {} : { onEvent }),
  };
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".jxl": "image/jxl", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf",
    ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  };
  return known[extension] ?? "application/octet-stream";
}

function cleanFileName(value: string, fallback: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (normalized || fallback).slice(0, 80);
}

function markdownReport(result: StoredBuild["result"]): string {
  if (!result) return "# Report non disponibile\n";
  const lines = [
    `# Report build Histeon Publish`,
    "",
    `- Stato: **${result.status}**`,
    `- Sorgente: ${result.sourceKind}`,
    `- Pagine: ${result.pages}`,
    `- Asset: ${result.assets}`,
    `- File: ${result.files}`,
    `- Dimensione: ${result.totalBytes} byte`,
    "",
    "## Finding",
    "",
  ];
  if (result.findings.length === 0) lines.push("Nessun finding.");
  else for (const finding of result.findings) lines.push(`- **${finding.severity === "block" ? "Blocco" : "Avviso"}** — \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`: ${finding.message}`);
  lines.push("", "## Pagine saltate", "");
  if (result.skipped.length === 0) lines.push("Nessuna.");
  else for (const item of result.skipped) lines.push(`- ${item}`);
  lines.push("", "## Redirect", "");
  if (!result.redirects?.length) lines.push("Nessuno.");
  else for (const redirect of result.redirects) lines.push(`- ${redirect.from} → ${redirect.to} (${redirect.status})`);
  lines.push("");
  return lines.join("\n");
}

function publicResult(build: StoredBuild): Record<string, unknown> {
  const result = build.result;
  if (!result) return { id: build.id, status: build.status, error: build.error };
  return {
    id: build.id,
    status: build.status,
    createdAt: build.createdAt,
    completedAt: build.completedAt,
    sourceKind: result.sourceKind,
    files: result.files,
    pages: result.pages,
    assets: result.assets,
    totalBytes: result.totalBytes,
    skipped: result.skipped,
    findings: result.findings,
    report: result.report,
    redirects: result.redirects,
    ...(result.worker === undefined ? {} : { worker: result.worker }),
  };
}

function writeDownload(response: ServerResponse, body: Buffer, mime: string, name: string): void {
  response.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": String(body.byteLength),
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServerHandle> {
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new HistosPublishError("La porta deve essere un numero tra 0 e 65535.", "server-port-invalid", 2);
  const dataDirectory = path.resolve(options.dataDirectory ?? defaultDataDirectory());
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const repository = new AppRepository(path.join(dataDirectory, "histos-publish.sqlite"));
  const imports = new ImportManager(dataDirectory);
  const proposalFrames = new ProposalFrames();
  const proposalOriginals = new ProposalOriginals();
  const cmsCatalog = new CmsProjectCatalog(dataDirectory);
  const stopAutomaticCopies = options.automaticCopies === false ? () => undefined : startAutomaticCopies({ outside: async () => {
    const folder = repository.getSetting<string>("copiesOutsideFolder");
    const passphrase = folder ? await storeFor("copies-outside", options.secretStoreFactory).get() : null;
    return folder && passphrase ? { folder, passphrase } : null;
  }, checked: (result) => repository.setSetting("copiesOutsideCheck", { result, at: new Date().toISOString() }), catalog: cmsCatalog, folder: path.join(dataDirectory, "backups", "automatiche") });
  const cmsRemoteCatalog = new CmsRemoteCatalog(dataDirectory);
  const cmsBuildRegistry = new CmsBuildRegistry(dataDirectory);
  const cmsHostingBackupStore = new CmsHostingBackupStore(dataDirectory);
  const wordpressProvisionCatalog = new WordPressProvisionCatalog(dataDirectory);
  await cmsCatalog.initialize();
  // Throwaway previews of checked prototypes (A2): what a crash left goes now, the rest when the app closes.
  const prototypePreviews = new PrototypePreviews(dataDirectory);
  await prototypePreviews.reset();
  const importReports = new ImportReports();
  // Doc 23 item 109: media of converted sites, kept outside their prototype until the check and the import read them.
  const convertedMedia = new ConvertedMedia(dataDirectory);
  const importProgress = new ImportProgressBoard();
  const secretFactory = options.secretStoreFactory;
  const cloudflareStore = storeFor("cloudflare-api-token", secretFactory);
  const consentFile = path.join(configDirectory(), "crawl-consents.json");
  const privateOriginConsentFile = path.join(configDirectory(), "private-origin-consents.json");
  const consentedOrigins = new Set<string>();
  const privateOriginConsents = new Set<string>();
  try {
    const saved: unknown = JSON.parse(await readFile(consentFile, "utf8"));
    if (Array.isArray(saved)) for (const item of saved) if (typeof item === "string") consentedOrigins.add(item);
  } catch { /* The app starts with no saved authorizations. */ }
  try {
    const saved: unknown = JSON.parse(await readFile(privateOriginConsentFile, "utf8"));
    if (Array.isArray(saved)) for (const item of saved) if (typeof item === "string") privateOriginConsents.add(item);
  } catch { /* Local and private origins require a separate explicit authorization. */ }

  const token = randomBytes(32).toString("base64url");
  const launchCodes = new Map<string, number>();
  const jobs = new Map<string, Job>();
  const activeJobs = new Set<Promise<void>>();
  /** CMS requests still running (a cancelled build cleans up after its client left): close() waits for them. */
  const activeCmsRequests = new Set<Promise<unknown>>();
  const activeProvisionPlans = new Set<string>();
  const previews = new Map<string, PreviewTicket>();
  const cmsBuilds = new Map<string, CmsReadyBuild>();
  const cmsPublishPlans = new Map<string, PendingCmsPublishPlan>();
  const uiDirectory = path.resolve(options.uiDirectory ?? UI_DIRECTORY);

  function emit(job: Job, value: unknown): void {
    if ((value as Partial<DeployEvent> | null)?.type === "deploy-progress") job.phase = (value as DeployEvent).phase;
    job.events.push(value);
    if (job.events.length > 1000) job.events.shift();
    const frame = `data: ${JSON.stringify(value)}\n\n`;
    for (const response of job.subscribers) response.write(frame);
  }

  function finishJob(job: Job, status: Job["status"], detail: Record<string, unknown>): void {
    job.status = status;
    emit(job, { type: "job-finished", status, ...detail });
    for (const response of job.subscribers) response.end();
    job.subscribers.clear();
  }

  function createJob(type: Job["type"], siteId: string, run: (job: Job) => Promise<Record<string, unknown>>): Job {
    const job: Job = { id: randomUUID(), type, siteId, status: "running", controller: new AbortController(), events: [], subscribers: new Set() };
    jobs.set(job.id, job);
    const active = Promise.resolve().then(() => run(job)).then(
      (detail) => finishJob(job, "complete", detail),
      (error: unknown) => {
        const cancelled = job.controller.signal.aborted;
        finishJob(job, cancelled ? "cancelled" : "failed", { error: safeErrorMessage(error), code: error instanceof HistosPublishError ? error.code : "error", ...(job.phase === undefined ? {} : { phase: job.phase }) });
      },
    ).finally(() => activeJobs.delete(active));
    activeJobs.add(active);
    return job;
  }

  /**
   * Deletes for good a site in the Cestino: its secrets in the keyring (WordPress, hosting, Turnstile unless another
   * site deploys the same Worker), its builds folder, its previews and its records with their builds and deploys.
   */
  /**
   * «Converti in progetto Histeon» (B1-B5) on a set of files: a site's build, or an upload converted straight from the
   * CMS catalog (doc 18 F1). `body` holds the user's choices (fonts, tokens, structure); anything else is no choice.
   */
  /** Remote media for a conversion: four at a time, 15 MB each, 150 MB in all; a failure is a note, not an error. */
  async function downloadRemoteMedia(urls: readonly string[]): Promise<{ media: Map<string, Uint8Array>; notes: string[]; missing: string[] }> {
    const fetcher = options.cmsPrototypeAssetFetcher ?? fetchPrototypeAsset;
    const media = new Map<string, Uint8Array>();
    const failedHosts = new Set<string>();
    const hosts = new Set<string>();
    let total = 0;
    let next = 0;
    let full = false;
    const worker = async (): Promise<void> => {
      while (next < urls.length && !full) {
        const url = urls[next++] as string;
        const host = new URL(url).hostname;
        try {
          const bytes = await fetcher(url, 15 * 1024 * 1024);
          if (total + bytes.length > 150 * 1024 * 1024) {
            full = true;
            return;
          }
          total += bytes.length;
          media.set(url, bytes);
          hosts.add(host);
        } catch {
          failedHosts.add(host);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
    const notes: string[] = [];
    // What the site asked for and did not get: «Uguale alla proposta» says it beside its numbers.
    const missing: string[] = [];
    if (hosts.size) notes.push(`media scaricati da ${[...hosts].slice(0, 8).join(", ")}${hosts.size > 8 ? "…" : ""}`);
    if (failedHosts.size) missing.push(`media non scaricati da ${[...failedHosts].slice(0, 8).join(", ")}: restano fuori`);
    if (full) missing.push("media remoti oltre 150 MB in tutto: gli altri restano fuori");
    return { media, notes: [...notes, ...missing], missing };
  }

  /**
   * Doc 23 item 101: in the desktop app, the pages the utility conversion changed are photographed before and after,
   * at a desktop and a phone width, and the report says whether they look the same. Only a note: the conversion
   * stays as the cascade check decided, and outside the app (CLI, server alone) nothing is photographed.
   */
  async function checkUtilityVisual(pairs: ReadonlyArray<{ page: string; before: string; after: string }>): Promise<string[]> {
    if (!options.compareRenders || !pairs.length) return [];
    const signal = AbortSignal.timeout(60_000);
    const changed: string[] = [];
    let checked = 0;
    try {
      for (const pair of pairs) {
        const results = await options.compareRenders({ before: pair.before, after: pair.after, widths: [1280, 390], signal });
        checked += 1;
        const worst = results.reduce<{ width: number; share: number } | null>((found, result) => {
          const share = result.totalPixels ? result.differentPixels / result.totalPixels : 0;
          return share > 0 && (!found || share > found.share) ? { width: result.width, share } : found;
        }, null);
        if (worst) changed.push(`${pair.page} (${(worst.share * 100).toLocaleString("it-IT", { maximumFractionDigits: 2 })}% dei pixel a ${worst.width} px)`);
      }
    } catch {
      return [checked ? `controllo visivo delle classi utility interrotto dopo ${checked} pagine${changed.length ? `; diverse: ${changed.join(", ")}` : ""}` : "controllo visivo delle classi utility non riuscito"];
    }
    return [changed.length
      ? `controllo visivo delle classi utility: pagine diverse prima e dopo, da guardare: ${changed.join(", ")}`
      : `controllo visivo delle classi utility: ${checked} ${checked === 1 ? "pagina uguale" : "pagine uguali"} prima e dopo, a 1280 e 390 px`];
  }

  /** Doc 27, G3: the refinement's settings and whether each key is saved; never a key. */
  async function refineSettingsView(): Promise<Record<string, unknown>> {
    const settings = readRefineSettings(repository.getSetting(REFINE_SETTINGS_KEY));
    const saved = async (account: string): Promise<boolean | null> => {
      try {
        return Boolean(await storeFor(account, secretFactory).get());
      } catch {
        return null;
      }
    };
    const localKey = await saved(REFINE_LOCAL_KEY_ACCOUNT);
    const haikuKey = await saved(REFINE_HAIKU_KEY_ACCOUNT);
    return { ...settings, connectorEnabled: connector.enabled, localKeyConfigured: localKey === true, haikuKeyConfigured: haikuKey === true, keyringAvailable: localKey !== null && haikuKey !== null };
  }

  /** The provider of the refinement, with its key from the keyring (a local server may have none). */
  async function refineProvider(site: string): Promise<{ settings: RefineSettings; ask: AskChoices; connector: boolean }> {
    const settings = readRefineSettings(repository.getSetting(REFINE_SETTINGS_KEY));
    // «Claude dal connettore»: the question waits for the agent of the user's plan; no key, no network from here.
    if (settings.provider === "connettore" && !options.importRefine?.ask) {
      if (!connector.enabled) throw new HistosPublishError("Il connettore AI è spento: accendilo in Agente AI, poi chiedi a Claude di rispondere alle scelte dei nomi. Oppure scegli un altro fornitore.", "cms-import-refine-connector-off", 409);
      return { settings, ask: connector.choices.ask(site), connector: true };
    }
    let key: string | null = null;
    try {
      key = await storeFor(settings.provider === "haiku" ? REFINE_HAIKU_KEY_ACCOUNT : REFINE_LOCAL_KEY_ACCOUNT, secretFactory).get();
    } catch (error) {
      if (settings.provider === "haiku") throw error;
    }
    const ask = options.importRefine?.ask?.(settings, key) ?? refineAsk(settings, key, options.importRefine?.anthropicBaseUrl ? { anthropicBaseUrl: options.importRefine.anthropicBaseUrl } : {});
    return { settings, ask, connector: false };
  }

  /** The conversion as the import routes answer it. */
  async function convertFilesToPrototype(...input: Parameters<typeof convertFilesAndMissing>) {
    return (await convertFilesAndMissing(...input)).answer;
  }

  /** The conversion, and beside its answer the notes of the images and fonts it asked the network for and did not get. */
  async function convertFilesAndMissing(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, projectId: string, name: string, body: Record<string, unknown>, signal?: AbortSignal, sourceNotes: readonly string[] = [], captured = false) {
    // `captured`: the files are a proposal photographed in the frame (an upload made by `captured-site`). Never read from
    // the request: such a site keeps its sizes exact (doc 28) and its report lists what waited for a script.
    // Doc 27, G3: the names a person applied from the refinement (or by hand), checked again by the converter.
    const answers = parseChoiceAnswers(body.choices);
    // Histeon proposal (kit proposte): its document is the site; the framework and the design are the proposal's.
    const proposal = typeof body.proposal === "string" ? proposalSiteOf(files, body.proposal) : null;
    const sourceFiles = proposal ? proposal.files : files;
    const siteName = proposal ? proposal.name : name;
    // B3: what the user chose to rewrite as parts, components and lists; anything else is no choice (a proposal
    // starts with components and lists).
    const chosen = typeof body.structure === "object" && body.structure !== null ? body.structure as Record<string, unknown> : proposal ? { components: true, lists: true } : {};
    const structure = { parts: chosen.parts === true, components: chosen.components === true, lists: chosen.components === true && chosen.lists === true };
    // Doc 18 §6.4.1: the framework the values are written with, Histeon CSS when the user chose nothing; `tokens` is
    // the older yes/no.
    const framework = proposal ? "histos-css" : body.framework === "histos-css" || body.framework === "acss" || body.framework === "core" || body.framework === "none" ? body.framework : body.tokens === false ? "none" : "histos-css";
    // Doc 28: outside a captured proposal the exact sizes are a choice of the check dialog, off unless the request says
    // `exact: true` and nothing else. A captured proposal has them whatever the request says (`captured` above), and a
    // request can never make a plain upload pass for one: no «da rifare», no recipes of the proposal.
    const exactChosen = !captured && !proposal && body.exact === true;
    let remoteMedia: ReadonlyMap<string, Uint8Array> = new Map();
    let fontFiles: Array<{ path: string; bytes: Uint8Array }> = [];
    let fontStylesheets: string[] = [];
    const convert = (extra: Array<{ path: string; bytes: Uint8Array }> = fontFiles, extraStylesheets: string[] = fontStylesheets, choices: Record<string, string> = answers) => {
      try {
        return staticSiteToPrototype({ projectId, name: siteName, files: [...sourceFiles, ...extra], extraStylesheets, framework, ...(captured && !proposal ? { exact: true, captured: true } : exactChosen ? { exact: true } : {}), recipes: body.recipes === true, structure, remoteMedia, holdMedia: (bytes, sha256) => convertedMedia.hold(bytes, sha256), ...(proposal ? { design: proposal.design } : {}), ...(Object.keys(choices).length ? { choices } : {}) });
      } catch (error) {
        if (error instanceof RangeError || error instanceof TypeError) throw new HistosPublishError(error.message, "cms-site-conversion-invalid", 422);
        throw error;
      }
    };
    let converted = convert();
    // Doc 18 §6.2: the images and fonts the site takes from other sites are always downloaded, with the prototype
    // import's guarded client (https, public addresses only, no redirects, size and time limits).
    // Two rounds: a stylesheet of a CDN may name fonts and images of its own, asked for once it is read.
    const remoteNotes: string[] = [];
    const missing: string[] = [];
    const attempted = new Set<string>();
    for (let round = 0; round < 2; round++) {
      const wanted = converted.remoteMedia.filter((url) => !attempted.has(url));
      if (!wanted.length) break;
      for (const url of wanted) attempted.add(url);
      const downloaded = await downloadRemoteMedia(wanted);
      remoteMedia = new Map([...remoteMedia, ...downloaded.media]);
      remoteNotes.push(...downloaded.notes);
      missing.push(...downloaded.missing);
      converted = convert();
    }
    let fontNotes: string[] = [...remoteNotes];
    // B5, only when asked: the Google Fonts of the site as media, for families with a verified free licence.
    if (body.fonts === true && converted.googleFonts.length) {
      // The subsets past Latin (Greek, Cyrillic…) only for the characters the pages really hold.
      const pageText = new TextDecoder("utf-8", { fatal: false });
      const codePoints = otherScriptCodePoints(sourceFiles.filter((file) => /\.html?$/iu.test(file.path)).slice(0, 1000).map((file) => pageText.decode(file.bytes)));
      const fonts = await downloadGoogleFonts({ cssUrls: converted.googleFonts, codePoints, ...(options.fontFetcher ? { fetcher: options.fontFetcher } : {}), ...(signal ? { signal } : {}) });
      fontNotes = [...remoteNotes, ...fonts.notes];
      missing.push(...fonts.missing);
      if (fonts.files.length) {
        fontFiles = fonts.files;
        fontStylesheets = ["histos-fonts/google-fonts.css"];
        converted = convert();
      }
    }
    // Doc 27, G3: «Rifinisci i nomi con un modello», only when asked. The model's answers are a table for the person:
    // the prototype stays the one converted with `answers`. A trial conversion leaves out what would clash.
    let refine: Awaited<ReturnType<typeof refineImportChoices>> | undefined;
    if (body.refine === true && converted.choices.length) {
      const provider = await refineProvider(siteName);
      refine = await refineImportChoices({
        choices: converted.choices,
        ask: provider.ask,
        settings: provider.settings,
        // The connector: one question with every choice (up to 200), answered by the agent when the person asks it.
        ...(provider.connector ? { batchSize: 200, maxBatches: 1, timeoutMs: CONNECTOR_CHOICES_WAIT_MS } : {}),
        trial: (extra) => convert(fontFiles, fontStylesheets, { ...answers, ...extra }).choicesRejected.filter((item) => item.id in extra),
        ...(signal ? { signal } : {}),
        ...(options.importRefine?.timeoutMs && !provider.connector ? { timeoutMs: options.importRefine.timeoutMs } : {}),
      });
    }
    const visualNotes = await checkUtilityVisual(converted.utilityVisual);
    // Doc 18 §9: how much of the site stays selectable in the builder, element by element.
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const pages = sourceFiles.filter((file) => /\.html?$/iu.test(file.path) && !/(^|\/)404\.html?$/iu.test(file.path)).slice(0, 1000).map((file) => decoder.decode(file.bytes));
    let selectable: ReturnType<typeof measureSelectable> | null = null;
    try {
      selectable = measureSelectable(pages, converted.html);
    } catch {
      selectable = null;
    }
    const siteNotes = [...sourceNotes, ...(proposal ? proposal.notes : [])];
    const allNotes = [...siteNotes, ...fontNotes, ...converted.report.notes, ...visualNotes];
    const answer = {
      fileName: `${slugify(siteName) || "sito"}-prototipo.html`,
      ...(selectable ? { selectable } : {}),
      prototype: converted.html,
      report: { ...converted.report, notes: allNotes, groups: groupConversionNotes(allNotes) },
      ...(proposal ? { proposal: { ...proposal.proposal, framework: proposal.framework } } : {}),
      googleFonts: converted.googleFonts.length,
      fontsRequested: body.fonts === true,
      // B4: the proposal, as validated design parameters; applied only when the user asked for tokens.
      design: converted.design,
      tokensRequested: converted.tokens,
      framework: converted.framework,
      // Doc 28: the sizes kept exact as the site's variables, and how many.
      exact: converted.exact,
      // "always": a captured proposal, the dialog cannot turn it off; "choice": the person may turn it on and off;
      // "none": a framework without tokens, or a file of kit proposte: nothing to keep exact.
      exactChoice: proposal || (converted.framework !== "histos-css" && converted.framework !== "acss") ? "none" : captured ? "always" : "choice",
      siteVariables: Object.keys(converted.siteTokens).length,
      recipes: converted.recipes,
      recipesAvailable: converted.recipesAvailable,
      structure: converted.structure,
      structureApplied: converted.structureApplied,
      // Doc 27: the choices the refinement can answer, the answers used and those left out.
      choices: converted.choices.length,
      choicesApplied: answers,
      choicesRejected: converted.choicesRejected.slice(0, 200),
      ...(refine ? { refine } : {}),
    };
    return { answer, missing };
  }

  async function purgeSite(siteId: string): Promise<void> {
    const site = repository.listTrashedSites().find((item) => item.id === siteId);
    if (!site) return;
    await storeFor(`wordpress-${site.id}`, secretFactory).delete();
    await storeFor(`hosting-${site.id}`, secretFactory).delete();
    const script = site.config.cloudflare?.script;
    const others = [...repository.listSites(), ...repository.listTrashedSites()].filter((other) => other.id !== site.id);
    if (script && !others.some((other) => other.config.cloudflare?.script === script)) await storeFor(turnstileSecretAccount(script), secretFactory).delete();
    repository.setSetting(`turnstileSecret:${site.id}`, false);
    const sitesRoot = path.resolve(dataDirectory, "sites");
    const folder = path.resolve(sitesRoot, site.id);
    if (path.dirname(folder) === sitesRoot) await removeTemporary(folder);
    for (const [ticket, preview] of previews) if (path.resolve(preview.bundlePath).startsWith(`${folder}${path.sep}`)) previews.delete(ticket);
    repository.deleteSite(site.id);
    forgetFolderMember("sites", site.id);
  }

  /** A project or site deleted for good leaves its folder (in the Cestino it keeps it, for a restore). */
  function forgetFolderMember(kind: FolderKind, id: string): void {
    const folders = readFolders(repository.getSetting(FOLDERS_SETTING));
    if (dropMember(folders, kind, id)) repository.setSetting(FOLDERS_SETTING, folders);
  }
  async function purgeProject(id: string): Promise<void> {
    await cmsCatalog.purgeTrashedProject(id);
    forgetFolderMember("cms", id);
  }

  /** What has been in the Cestino longer than TRASH_DAYS goes for good, at start. Best effort: retried at the next. */
  async function purgeExpiredTrash(): Promise<void> {
    const limit = new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000).toISOString();
    for (const project of await cmsCatalog.listTrashedProjects().catch(() => [])) {
      if (project.deletedAt < limit) await purgeProject(project.id).catch(() => undefined);
    }
    for (const site of repository.listTrashedSites()) {
      if (site.deletedAt < limit) await purgeSite(site.id).catch(() => undefined);
    }
  }

  function requireSite(siteId: string): StoredSite {
    const site = repository.getSite(siteId);
    if (!site) throw new HistosPublishError("Sito non trovato.", "site-missing", 404);
    return site;
  }

  /**
   * The KV archives a site's Worker code uses, written into its settings as if typed there: one `NOME=titolo` for every
   * name the settings do not have yet (an archive of the account when one fits, else `<worker>-NOME`). Names typed
   * by hand stay as they are. Without a token, an account or the KV permission it still writes `<worker>-NOME`.
   */
  async function fillKvFromWorker(siteId: string, found: readonly string[]): Promise<string[]> {
    const site = requireSite(siteId);
    const declared = site.config.cloudflare?.kv ?? [];
    if (found.length === 0) return [];
    const bound = new Set(validateKvBindingNames(declared).map((value) => value.split("=")[0]));
    if (found.every((name) => bound.has(name))) return [];
    const settings = siteSettings(site.config, configuredAccountId(repository));
    let namespaces: Array<{ title: string }> = [];
    if (settings.accountId && /^[0-9a-f]{32}$/iu.test(settings.accountId)) {
      try {
        const client = await cloudflareClientFromStore(cloudflareStore);
        namespaces = await client.listKvNamespaces(settings.accountId, AbortSignal.timeout(15_000));
      } catch { namespaces = []; }
    }
    const { kv, added } = addFoundKvDeclarations(declared, found, settings.script, namespaces);
    if (added.length === 0) return [];
    const current = requireSite(siteId);
    const config = parseSiteConfig({ ...current.config, cloudflare: { ...(current.config.cloudflare ?? {}), kv } });
    repository.updateSite(siteId, { config });
    return added;
  }

  function resolveCmsDestination(input: { destinationId: string; projectId?: string; databaseConnectionId?: string }): Destination {
    // A site created as the destination of one CMS project never receives another project's build (E6), also when
    // it is named as the hosting of a new WordPress.
    const bound = repository.getSite(input.destinationId.replace(/^wordpress-new:/u, ""));
    if (bound?.config.source.kind === "cms" && bound.config.source.path !== input.projectId) {
      throw new HistosPublishError("Questa destinazione pubblica un altro progetto Histeon CMS.", "cms-destination-other-project", 409);
    }
    return resolveCmsDestinationProfile(input, {
      getSite: (siteId) => repository.getSite(siteId),
      getRemoteConnection: (connectionId) => cmsRemoteCatalog.get(connectionId),
      getDatabaseConnection: (connectionId) => storedDatabaseConnections(repository).find((connection) => connection.id === connectionId) ?? null,
      defaultAccountId: configuredAccountId(repository),
    });
  }

  async function inspectCmsDestination(input: { projectId: string; destinationId: string }): Promise<CmsDestinationInspection> {
    const resolved = resolveCmsDestination({ destinationId: input.destinationId, projectId: input.projectId });
    if (resolved.kind !== "static-cloudflare" && resolved.kind !== "static-hosting") throw new HistosPublishError("La verifica statica richiede una destinazione Cloudflare o hosting statico.", "cms-destination-kind-mismatch", 409);
    const site = requireSite(input.destinationId);
    const checkedAt = new Date().toISOString();
    const detectedCapabilities: CmsDestinationInspection["detectedCapabilities"] = {
      atomicSwitch: false,
      rollback: false,
      deleteManaged: false,
      remoteVerify: true,
      runtimeProvision: false,
      databaseProbe: false,
    };

    if ((site.config.deployTarget ?? "cloudflare") === "ftp") {
      if (!site.config.hosting) throw new HistosPublishError("Configura prima l’hosting FTP/FTPS/SFTP.", "hosting-config-missing", 409);
      const settings = parseStaticHostingSettings(site.config.hosting);
      const credentials = await readStaticHostingCredentials(site, secretFactory, repository);
      const directory = await (options.hostingDirectoryInspection ?? inspectStaticHostingDirectory)(settings, credentials);
      const findings: CmsDestinationInspection["findings"] = [];
      if (!directory.isEmpty) findings.push({ severity: "warn", code: "hosting-directory-not-empty", message: "La cartella remota contiene già file. La verifica è di sola lettura; controlla il percorso prima di pubblicare." });
      if (directory.wordpressSignals.length) findings.push({ severity: "block", code: "hosting-wordpress-files-detected", message: "Nella cartella sono presenti file che sembrano appartenere a WordPress. La pubblicazione statica è stata fermata per evitare di sovrascriverli; scegli una cartella dedicata." });
      if (!settings.publicUrl) findings.push({ severity: "warn", code: "hosting-public-url-missing", message: "L’accesso FTP è stato verificato in lettura, ma manca l’indirizzo pubblico del sito per controllarne l’output." });
      return {
        schemaVersion: 1,
        destinationId: site.id,
        label: site.name,
        kind: "static-hosting",
        transport: settings.protocol,
        checkedAt,
        readVerified: true,
        writeVerified: false,
        ...(settings.publicUrl ? { publicUrl: settings.publicUrl } : {}),
        detectedCapabilities,
        evidence: {
          host: settings.host,
          remoteDirectory: settings.remoteDirectory,
          entryCount: directory.entryCount,
          directoryEmpty: directory.isEmpty,
          wordpressSignals: directory.wordpressSignals,
          publicOutputChecked: false,
        },
        remoteInventory: { complete: directory.remoteInventoryComplete, files: directory.remoteFiles },
        findings,
      };
    }

    const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
    const client = await cloudflareClientFromStore(cloudflareStore);
    await client.verifyWorkerScript(target.accountId, target.script);
    const findings: CmsDestinationInspection["findings"] = [];
    const configuredDomain = site.config.cloudflare?.domain;
    let publicUrl: string | undefined;
    if (configuredDomain) {
      try {
        const domains = await client.listWorkerDomains(target.accountId, [configuredDomain]);
        const attached = domains.some((domain) => domain.hostname.toLowerCase() === configuredDomain.toLowerCase()
          && domain.service === target.script && domain.enabled !== false);
        if (attached) publicUrl = `https://${configuredDomain}`;
        else findings.push({ severity: "block", code: "cloudflare-domain-not-connected", message: `Cloudflare non conferma che ${configuredDomain} sia collegato al Worker ${target.script}. Correggi il collegamento del dominio prima di pubblicare.` });
      } catch {
        findings.push({ severity: "block", code: "cloudflare-domain-not-verified", message: "Il Worker esiste, ma non è stato possibile verificare il dominio personalizzato. Controlla i permessi del token e riprova." });
      }
    }
    let workersDevUrl: string | undefined;
    try { workersDevUrl = await client.getWorkersDevUrl(target.accountId, target.script); }
    catch { findings.push({ severity: "warn", code: "cloudflare-workers-dev-not-verified", message: "Non è stato possibile verificare l’indirizzo workers.dev. Controlla i permessi di lettura del Worker e del sottodominio dell’account." }); }
    if (!publicUrl && workersDevUrl) publicUrl = workersDevUrl;
    if (!publicUrl) findings.push({ severity: "block", code: "cloudflare-public-url-unavailable", message: "Worker verificato, ma non è stato trovato un indirizzo pubblico attivo. Attiva workers.dev o collega un dominio prima di pubblicare." });

    return {
      schemaVersion: 1,
      destinationId: site.id,
      label: site.name,
      kind: "static-cloudflare",
      transport: "cloudflare-api",
      checkedAt,
      readVerified: true,
      writeVerified: false,
      ...(publicUrl ? { publicUrl } : {}),
      detectedCapabilities,
      evidence: {
        accountId: target.accountId,
        worker: target.script,
        workerExists: true,
        configuredDomain: configuredDomain ?? null,
        customDomainVerified: Boolean(configuredDomain && publicUrl === `https://${configuredDomain}`),
        workersDevUrl: workersDevUrl ?? null,
        publicOutputChecked: false,
      },
      findings,
    };
  }

  function registerCmsBuild(build: CmsReadyBuild): void {
    const expectedPath = path.resolve(dataDirectory, "histos-cms-builds", build.projectId, build.buildId);
    if (path.resolve(build.bundlePath) !== expectedPath) throw new HistosPublishError("Il percorso della versione del sito non corrisponde al progetto registrato.", "cms-build-path-invalid", 500);
    cmsBuildRegistry.registerBuild(build);
  }

  async function listCmsDeployments(projectId: string, buildId: string) {
    const deployments = cmsBuildRegistry.listDeployments(projectId, buildId);
    return await Promise.all(deployments.map(async (deployment) => {
      if (!await cmsHostingBackupStore.has(deployment.id)) return deployment;
      return {
        ...deployment,
        result: { ...(deployment.result ?? {}), provider: "hosting", rollbackAvailable: true },
      };
    }));
  }

  async function listCmsBuilds(projectId: string, projectRevision: string): Promise<Array<Record<string, unknown>>> {
    const builds = cmsBuildRegistry.listBuilds(projectId, 20);
    const listed: Array<Record<string, unknown>> = [];
    const now = Date.now();
    for (const [ticket, preview] of previews) if (preview.expiresAt <= now) previews.delete(ticket);
    for (const [index, build] of builds.entries()) {
      let status: "ready" | "unavailable" = "unavailable";
      let previewUrl: string | null = null;
      try {
        const expectedPath = path.resolve(dataDirectory, "histos-cms-builds", projectId, build.buildId);
        if (path.resolve(build.bundlePath) !== expectedPath) throw new Error("Percorso versione non canonico.");
        const dataRoot = await realpath(dataDirectory);
        const actualPath = await realpath(expectedPath);
        if (actualPath !== path.join(dataRoot, "histos-cms-builds", projectId, build.buildId) || !(await stat(actualPath)).isDirectory()) throw new Error("Cartella versione assente o non valida.");
        const home = await lstat(path.join(actualPath, "index.html"));
        if (!home.isFile() || home.isSymbolicLink() || home.size === 0) throw new Error("La home versione non è disponibile.");
        status = "ready";
        if (index === 0) {
          await readReadyCmsBuild({ projectId, buildId: build.buildId });
          const ticket = randomBytes(24).toString("base64url");
          previews.set(ticket, { buildId: build.buildId, bundlePath: build.bundlePath, expiresAt: now + PREVIEW_TTL_MS });
          const address = server.address();
          const port = address && typeof address !== "string" ? address.port : requestedPort;
          previewUrl = `http://127.0.0.1:${port}/__preview/${ticket}/${build.buildId}/index.html`;
        }
      } catch {
        // Keep the history row, but never present a missing or invalid bundle as ready.
      }
      listed.push({
        id: build.buildId,
        createdAt: build.createdAt,
        projectRevision: build.projectRevision,
        current: status === "ready" && build.projectRevision === projectRevision,
        status,
        files: build.files,
        pages: build.pages,
        assets: build.assets,
        totalBytes: build.totalBytes,
        findings: build.findings,
        previewUrl,
        deployments: await listCmsDeployments(projectId, build.buildId),
      });
    }
    return listed;
  }

  /** A fresh preview ticket for a registered build (the agent's activity log opens previews older than 5 minutes). */
  async function previewCmsBuild(input: { projectId: string; buildId: string }): Promise<{ previewUrl: string; expiresAt: string }> {
    const { build } = await readReadyCmsBuild(input);
    const now = Date.now();
    for (const [ticket, preview] of previews) if (preview.expiresAt <= now) previews.delete(ticket);
    const ticket = randomBytes(24).toString("base64url");
    previews.set(ticket, { buildId: build.buildId, bundlePath: build.bundlePath, expiresAt: now + PREVIEW_TTL_MS });
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : requestedPort;
    return { previewUrl: `http://127.0.0.1:${port}/__preview/${ticket}/${build.buildId}/index.html`, expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString() };
  }

  async function readReadyCmsBuild(input: { projectId: string; buildId: string }) {
    const build = cmsBuildRegistry.getBuild(input.buildId);
    if (!build) throw new HistosPublishError("Versione CMS non trovata o scaduta. Crea una nuova versione.", "cms-build-missing", 404);
    if (build.projectId !== input.projectId) throw new HistosPublishError("La versione del sito appartiene a un altro progetto.", "cms-build-project-mismatch", 409);
    const expectedPath = path.resolve(dataDirectory, "histos-cms-builds", input.projectId, input.buildId);
    if (path.resolve(build.bundlePath) !== expectedPath) throw new HistosPublishError("Il bundle registrato non appartiene a questo progetto.", "cms-build-path-invalid", 409);
    const dataRoot = await realpath(dataDirectory);
    const actualPath = await realpath(expectedPath).catch(() => null);
    const expectedCanonicalPath = path.join(dataRoot, "histos-cms-builds", input.projectId, input.buildId);
    if (!actualPath || actualPath !== expectedCanonicalPath) throw new HistosPublishError("Il bundle CMS non è più disponibile nella cartella privata del progetto.", "cms-build-path-invalid", 409);
    const bundleInfo = await stat(actualPath).catch(() => null);
    if (!bundleInfo?.isDirectory()) throw new HistosPublishError("Il bundle CMS non è una cartella pronta.", "cms-build-not-ready", 409);

    const source = await readDirectorySource(actualPath, { maxBytes: MAX_CMS_BUILD_BYTES });
    if (source.findings.some((finding) => finding.severity === "block")) throw new HistosPublishError("Il bundle CMS contiene file che non superano la verifica di sicurezza.", "cms-build-invalid", 422);
    const files: BundleFile[] = source.files.map((file) => ({ path: file.path, bytes: file.bytes, size: file.bytes.byteLength }));
    if (!files.length || !files.some((file) => file.path === "index.html")) throw new HistosPublishError("Il bundle CMS non contiene una home page pubblicabile.", "cms-build-invalid", 422);
    return { build, bundlePath: actualPath, files };
  }

  async function createCmsPublishPlan(input: { projectId: string; buildId: string; targetSiteId: string; projectRevision: string }): Promise<CmsPublishPlan> {
    const { build, files } = await readReadyCmsBuild({ projectId: input.projectId, buildId: input.buildId });
    if (!build.projectRevision || build.projectRevision !== input.projectRevision) throw new HistosPublishError("Il progetto è stato modificato dopo questa versione. Crea una versione aggiornata prima di preparare il piano.", "cms-build-stale", 409);
    const destination = resolveCmsDestination({ destinationId: input.targetSiteId, projectId: input.projectId });
    if (destination.kind !== "static-cloudflare" && destination.kind !== "static-hosting") throw new HistosPublishError("Una versione statica può essere inviata solo a Cloudflare o a un hosting statico.", "cms-destination-kind-mismatch", 409);
    const site = requireSite(input.targetSiteId);
    const inspection = await (options.cmsDestinationInspection ?? inspectCmsDestination)({ projectId: input.projectId, destinationId: site.id });
    if (inspection.destinationId !== site.id || inspection.schemaVersion !== 1 || inspection.writeVerified !== false) {
      throw new HistosPublishError("La verifica della destinazione ha restituito un risultato non valido.", "cms-destination-inspection-invalid", 500);
    }

    const createdAt = new Date();
    const expiresAtMs = createdAt.getTime() + CMS_PUBLISH_PLAN_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const bundleDigest = cmsBundleSha256(files);
    const location = inspection.kind === "static-hosting"
      ? `${String(inspection.evidence.host ?? site.config.hosting?.host ?? "hosting")}:${String(site.config.hosting?.port ?? "")} · ${String(inspection.evidence.remoteDirectory ?? site.config.hosting?.remoteDirectory ?? ".")}`
      : `Worker ${String(inspection.evidence.worker ?? site.config.cloudflare?.script ?? "Cloudflare")}`;
    const effects = inspection.kind === "static-hosting"
      ? [
        "Caricherà i file indicati in questa versione nella cartella hosting selezionata.",
        "I file con lo stesso percorso verranno aggiornati; i file remoti non inclusi nella versione non saranno eliminati.",
        "Prima dell’upload conserverà nella cartella dati locale una copia verificata dei file che verranno sostituiti, fino a 256 MiB.",
        "Il ripristino successivo si ferma se rileva modifiche remote intervenute dopo questa pubblicazione.",
        "L’accesso in scrittura verrà verificato dal provider durante il trasferimento.",
      ]
      : [
        "Invierà i file di questa versione al Worker Cloudflare selezionato.",
        "La copia CMS locale non verrà modificata; i file della versione non contengono il database del progetto.",
        "L’accesso in scrittura verrà verificato da Cloudflare durante il deploy.",
      ];
    const remoteDiff = (() => {
      if (inspection.kind !== "static-hosting" || !inspection.remoteInventory) {
        return {
          status: "unavailable" as const,
          basis: "none" as const,
          counts: { missing: 0, sameSize: 0, differentSize: 0, remoteOnly: 0 },
          filesPreview: [],
          additionalFiles: 0,
          note: "Il provider non espone un inventario statico dei file confrontabile con la versione.",
        };
      }
      const localFiles = new Map(files.map((file) => [file.path, file.size ?? file.bytes?.byteLength ?? 0]));
      const remoteFiles = new Map(inspection.remoteInventory.files.map((file) => [file.path, file.size]));
      const diffFiles: NonNullable<CmsPublishPlan["remoteDiff"]>["filesPreview"] = [];
      const counts = { missing: 0, sameSize: 0, differentSize: 0, remoteOnly: 0 };
      for (const [filePath, localSize] of localFiles) {
        const remoteSize = remoteFiles.get(filePath);
        if (remoteSize === undefined) {
          counts.missing += 1;
          diffFiles.push({ path: filePath, status: "missing", localSize });
        } else if (remoteSize === localSize) {
          counts.sameSize += 1;
          diffFiles.push({ path: filePath, status: "same-size", localSize, remoteSize });
        } else {
          counts.differentSize += 1;
          diffFiles.push({ path: filePath, status: "different-size", localSize, remoteSize });
        }
      }
      for (const [filePath, remoteSize] of remoteFiles) {
        if (localFiles.has(filePath)) continue;
        counts.remoteOnly += 1;
        diffFiles.push({ path: filePath, status: "remote-only", remoteSize });
      }
      diffFiles.sort((left, right) => left.path.localeCompare(right.path));
      return {
        status: inspection.remoteInventory.complete ? "complete" as const : "partial" as const,
        basis: "path-and-size" as const,
        counts,
        filesPreview: diffFiles.slice(0, 100),
        additionalFiles: Math.max(0, diffFiles.length - 100),
        note: inspection.remoteInventory.complete
          ? "Confronto per percorso e dimensione soltanto: file della stessa dimensione possono avere contenuti diversi. I file remoti esclusivi vengono conservati."
          : "Inventario remoto parziale per i limiti di scansione: l’assenza di un percorso non prova che non esista. I file remoti esclusivi vengono conservati.",
      };
    })();
    const findings = [...inspection.findings];
    let rollbackBackup: CmsPublishPlan["rollbackBackup"] = {
      status: "not-applicable", estimatedBytes: 0, maxBytes: 0,
      note: "Cloudflare conserva versioni del Worker e usa il ripristino dalla cronologia.",
    };
    if (inspection.kind === "static-hosting") {
      if (!inspection.remoteInventory?.complete) {
        rollbackBackup = {
          status: "blocked", estimatedBytes: 0, maxBytes: CMS_HOSTING_BACKUP_MAX_BYTES,
          note: "L’inventario è parziale o non disponibile: Histeon non può garantire il ripristino dei file che sostituirebbe.",
        };
        findings.push({ severity: "block", code: "hosting-backup-inventory-incomplete", message: "Non posso verificare tutti i file hosting. La pubblicazione statica resta bloccata finché l’inventario non è completo." });
      } else {
        const remoteSizes = new Map(inspection.remoteInventory.files.map((file) => [file.path, file.size]));
        const estimatedBytes = files.reduce((total, file) => {
          const size = remoteSizes.get(file.path) ?? 0;
          return total > CMS_HOSTING_BACKUP_MAX_BYTES - size ? CMS_HOSTING_BACKUP_MAX_BYTES + 1 : total + size;
        }, 0);
        const fits = Number.isSafeInteger(estimatedBytes) && estimatedBytes <= CMS_HOSTING_BACKUP_MAX_BYTES;
        rollbackBackup = {
          status: fits ? "ready" : "blocked",
          estimatedBytes,
          maxBytes: CMS_HOSTING_BACKUP_MAX_BYTES,
          note: fits
            ? "Prima dell’upload verranno salvati localmente i file esistenti che la versione sostituirà. Il ripristino è disponibile solo se quei file non sono stati modificati dopo la pubblicazione."
            : "I file remoti da conservare superano 256 MiB. La pubblicazione è bloccata per non sovrascriverli senza una copia locale verificabile.",
        };
        if (!fits) findings.push({ severity: "block", code: "hosting-backup-too-large", message: rollbackBackup.note });
      }
    }
    const planId = findings.some((finding) => finding.severity === "block") ? null : randomUUID();
    const { remoteInventory: _remoteInventory, ...publicInspection } = inspection;
    const response: CmsPublishPlan = {
      schemaVersion: 1,
      status: planId ? "ready" : "blocked",
      planId,
      rollback: inspection.kind === "static-cloudflare"
        ? {
            status: "provider-managed",
            estimatedBytes: 0,
            maxBytes: 0,
            note: "Il ripristino usa una versione Cloudflare registrata dopo il deploy; non è uno switch atomico.",
          }
        : {
            status: rollbackBackup.status === "ready" ? "ready" : "blocked",
            estimatedBytes: rollbackBackup.estimatedBytes,
            maxBytes: rollbackBackup.maxBytes,
            note: rollbackBackup.note,
          },
      projectId: input.projectId,
      buildId: input.buildId,
      projectRevision: build.projectRevision,
      createdAt: createdAt.toISOString(),
      expiresAt,
      build: {
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + (file.size ?? file.bytes?.byteLength ?? 0), 0),
        sha256: bundleDigest,
        homePage: "index.html",
        filesPreview: files.slice(0, 100).map((file) => ({ path: file.path, size: file.size ?? file.bytes?.byteLength ?? 0 })),
        additionalFiles: Math.max(0, files.length - 100),
      },
      destination: {
        id: site.id,
        label: site.name,
        kind: inspection.kind,
        transport: inspection.transport,
        location,
        ...(inspection.publicUrl ? { publicUrl: inspection.publicUrl } : {}),
      },
      inspection: publicInspection,
      remoteDiff,
      rollbackBackup,
      effects,
      findings,
      writeVerified: false,
    };
    for (const [id, pending] of cmsPublishPlans) {
      if (pending.expiresAtMs <= createdAt.getTime()) cmsPublishPlans.delete(id);
    }
    if (planId) {
      cmsPublishPlans.set(planId, {
        response,
        bundleSha256: bundleDigest,
        destinationSha256: cmsDestinationSha256(site),
        inspectionSha256: cmsInspectionSha256(inspection),
        expiresAtMs,
        state: "ready",
      });
    }
    return response;
  }

  async function rollbackCmsDeployment(input: { projectId: string; buildId: string; deploymentId: string; expectedDestinationId?: string }): Promise<Record<string, unknown>> {
    const previous = cmsBuildRegistry.listDeployments(input.projectId, input.buildId).find((item) => item.id === input.deploymentId);
    if (!previous) throw new HistosPublishError("Pubblicazione CMS non trovata nella cronologia del progetto.", "cms-deployment-missing", 404);
    if (input.expectedDestinationId && previous.targetSiteId !== input.expectedDestinationId) {
      throw new HistosPublishError("La pubblicazione appartiene a un’altra destinazione.", "cms-deployment-destination-mismatch", 409);
    }
    if (previous.result?.provider === "hosting") return rollbackCmsHostingDeployment(input, previous);
    if (previous.status !== "deployed" || previous.result?.provider !== "cloudflare") {
      throw new HistosPublishError("È possibile ripristinare solo una pubblicazione Cloudflare completata.", "cms-deployment-rollback-unsupported", 409);
    }
    const versionId = previous.result.versionId;
    if (typeof versionId !== "string" || !versionId || versionId.length > 128 || /[\r\n\0]/u.test(versionId)) {
      throw new HistosPublishError("La cronologia non contiene una versione Cloudflare ripristinabile.", "cms-deployment-version-missing", 409);
    }
    const site = requireSite(previous.targetSiteId);
    if ((site.config.deployTarget ?? "cloudflare") === "ftp") {
      throw new HistosPublishError("La destinazione non è più un Worker Cloudflare. Il ripristino remoto non è disponibile.", "cms-deployment-rollback-target-changed", 409);
    }
    const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
    if (previous.result.accountId !== target.accountId || previous.result.script !== target.script) {
      throw new HistosPublishError("Account o Worker sono cambiati dopo la pubblicazione. Verifica la destinazione prima di ripristinare.", "cms-deployment-rollback-target-changed", 409);
    }

    const rollbackId = randomUUID();
    cmsBuildRegistry.reserveDeployment({ id: rollbackId, projectId: input.projectId, buildId: input.buildId, targetSiteId: site.id });
    try {
      const rollbackAdapter = options.cmsRollbackAdapter;
      const client = rollbackAdapter ? undefined : await cloudflareClientFromStore(cloudflareStore);
      const job = createJob("deploy", site.id, async (activeJob) => {
        try {
          let result: Awaited<ReturnType<typeof rollbackVersion>>;
          if (rollbackAdapter) {
            result = await rollbackAdapter({ accountId: target.accountId, script: target.script, versionId, signal: activeJob.controller.signal });
          } else {
            if (!client) throw new Error("Client Cloudflare non disponibile per il ripristino.");
            result = await rollbackVersion({ client, accountId: target.accountId, script: target.script, deploymentOrVersionId: versionId, message: `Ripristino build Histeon CMS ${input.buildId}`, signal: activeJob.controller.signal });
          }
          const detail = {
            deployId: rollbackId,
            provider: "cloudflare",
            accountId: target.accountId,
            script: target.script,
            versionId: result.versions.find((item) => item.percentage > 0)?.version_id ?? result.versions[0]?.version_id ?? versionId,
            deploymentId: result.id,
            rollbackOf: previous.id,
          };
          cmsBuildRegistry.finishDeployment(rollbackId, "deployed", { result: detail });
          return detail;
        } catch (error) {
          cmsBuildRegistry.finishDeployment(rollbackId, activeJob.controller.signal.aborted ? "cancelled" : "failed", { error: safeErrorMessage(error) });
          throw error;
        }
      });
      emit(job, { type: "cms-rollback-summary", targetSiteId: site.id, script: target.script, versionId, rollbackOf: previous.id });
      return { jobId: job.id, deployId: rollbackId, targetSiteId: site.id, versionId };
    } catch (error) {
      cmsBuildRegistry.finishDeployment(rollbackId, "failed", { error: safeErrorMessage(error) });
      throw error;
    }
  }

  async function rollbackCmsHostingDeployment(
    input: { projectId: string; buildId: string; deploymentId: string },
    previous: ReturnType<CmsBuildRegistry["listDeployments"]>[number],
  ): Promise<Record<string, unknown>> {
    if (!["deployed", "failed", "cancelled", "interrupted"].includes(previous.status) || previous.result?.rollbackAvailable !== true) {
      throw new HistosPublishError("Questa pubblicazione hosting non dispone di un backup verificabile.", "cms-deployment-rollback-unsupported", 409);
    }
    const site = requireSite(previous.targetSiteId);
    if ((site.config.deployTarget ?? "cloudflare") !== "ftp" || !site.config.hosting) {
      throw new HistosPublishError("La destinazione hosting è cambiata. Ripristina la configurazione FTP/FTPS/SFTP originale prima di procedere.", "cms-deployment-rollback-target-changed", 409);
    }
    const settings = parseStaticHostingSettings(site.config.hosting);
    const destinationSha256 = cmsDestinationSha256(site);
    const entries = await cmsHostingBackupStore.read({
      deploymentId: previous.id,
      projectId: input.projectId,
      destinationSiteId: site.id,
      destinationSha256,
    });
    const credentials = await readStaticHostingCredentials(site, secretFactory, repository);
    const rollbackId = randomUUID();
    cmsBuildRegistry.reserveDeployment({ id: rollbackId, projectId: input.projectId, buildId: input.buildId, targetSiteId: site.id });
    try {
      const job = createJob("deploy", site.id, async (activeJob) => {
        try {
          const result = options.cmsDeployAdapters?.hostingRestore
            ? await options.cmsDeployAdapters.hostingRestore({ settings, credentials, entries, signal: activeJob.controller.signal })
            : await restoreStaticHostingBackup({ settings, credentials, entries, signal: activeJob.controller.signal });
          const healthCheck = await (options.publishedHomeCheck ?? checkPublishedHome)(settings.publicUrl);
          const detail = { deployId: rollbackId, provider: "hosting", protocol: settings.protocol, host: settings.host, remoteDirectory: settings.remoteDirectory, publicUrl: settings.publicUrl ?? null, healthCheck, rollbackOf: previous.id, restoredFiles: result.restored, removedFiles: result.removed, alreadyRestoredFiles: result.alreadyRestored };
          cmsBuildRegistry.finishDeployment(rollbackId, "deployed", { result: detail });
          return detail;
        } catch (error) {
          cmsBuildRegistry.finishDeployment(rollbackId, activeJob.controller.signal.aborted ? "cancelled" : "failed", { error: safeErrorMessage(error) });
          throw error;
        }
      });
      emit(job, { type: "cms-rollback-summary", targetSiteId: site.id, protocol: settings.protocol, remoteDirectory: settings.remoteDirectory, rollbackOf: previous.id });
      return { jobId: job.id, deployId: rollbackId, targetSiteId: site.id, rollbackOf: previous.id };
    } catch (error) {
      cmsBuildRegistry.finishDeployment(rollbackId, "failed", { error: safeErrorMessage(error) });
      throw error;
    }
  }

  async function executeCmsPublishPlan(input: { projectId: string; planId: string; projectRevision: string; expectedDestinationId?: string }): Promise<Record<string, unknown>> {
    const pending = cmsPublishPlans.get(input.planId);
    if (!pending || pending.response.projectId !== input.projectId || (input.expectedDestinationId && pending.response.destination.id !== input.expectedDestinationId)) {
      throw new HistosPublishError("Il piano non esiste più oppure appartiene a un’altra destinazione o progetto. Preparane uno nuovo.", "cms-publish-plan-missing", 404);
    }
    if (pending.state === "started" && pending.startedResult) return pending.startedResult;
    if (pending.state !== "ready") throw new HistosPublishError("La conferma del piano è già in corso. Attendi il risultato prima di riprovare.", "cms-publish-plan-in-progress", 409);
    if (pending.expiresAtMs <= Date.now()) {
      cmsPublishPlans.delete(input.planId);
      throw new HistosPublishError("Il piano di pubblicazione è scaduto. Rivedi la destinazione e preparane uno nuovo.", "cms-publish-plan-expired", 409);
    }

    // Claim synchronously before the first await so two confirmation requests cannot start two uploads.
    pending.state = "checking";
    try {
      const { files } = await readReadyCmsBuild({ projectId: pending.response.projectId, buildId: pending.response.buildId });
      if (cmsBundleSha256(files) !== pending.bundleSha256) throw new HistosPublishError("I file della versione sono cambiati dopo il piano. Crea una nuova versione e rivedi il piano.", "cms-publish-plan-stale", 409);
      if (!pending.response.projectRevision || pending.response.projectRevision !== input.projectRevision) throw new HistosPublishError("Il progetto è cambiato dopo la preparazione della versione. Crea una nuova versione e rivedi il piano.", "cms-publish-plan-stale", 409);
      const destination = resolveCmsDestination({ destinationId: pending.response.destination.id, projectId: input.projectId });
      if (destination.kind !== "static-cloudflare" && destination.kind !== "static-hosting") throw new HistosPublishError("La destinazione non è più un hosting statico.", "cms-destination-kind-mismatch", 409);
      const site = requireSite(pending.response.destination.id);
      if (cmsDestinationSha256(site) !== pending.destinationSha256) throw new HistosPublishError("La configurazione della destinazione è cambiata. Verificala di nuovo e prepara un nuovo piano.", "cms-publish-plan-stale", 409);
      const inspection = await (options.cmsDestinationInspection ?? inspectCmsDestination)({ projectId: input.projectId, destinationId: site.id });
      if (inspection.destinationId !== site.id || inspection.schemaVersion !== 1 || inspection.writeVerified !== false) {
        throw new HistosPublishError("La verifica aggiornata della destinazione non è valida. Prepara un nuovo piano.", "cms-destination-inspection-invalid", 500);
      }
      if (cmsInspectionSha256(inspection) !== pending.inspectionSha256) throw new HistosPublishError("Lo stato della destinazione è cambiato dopo la revisione. Prepara un nuovo piano e controlla le differenze.", "cms-publish-plan-stale", 409);
      const blocker = inspection.findings.find((finding) => finding.severity === "block");
      if (blocker) throw new HistosPublishError(blocker.message, "cms-publish-preflight-blocked", 409);
      pending.state = "starting";
      const started = await deployCmsBuild({ projectId: input.projectId, buildId: pending.response.buildId, targetSiteId: pending.response.destination.id, expectedInspection: inspection });
      pending.startedResult = started;
      pending.state = "started";
      return started;
    } catch (error) {
      cmsPublishPlans.delete(input.planId);
      throw error;
    }
  }

  /** "galleria-2026-10-26-sito.zip" (E11); the id only if the project cannot be read. */
  async function cmsBuildArchiveName(projectId: string): Promise<string> {
    const opened = await cmsCatalog.openProject(projectId).catch(() => null);
    if (!opened) return `histos-${projectId}-sito.zip`;
    try { return readableArchiveName(opened.project.name, "zip", "sito"); }
    finally { opened.store.close(); }
  }

  async function exportCmsBuild(input: { projectId: string; buildId: string }, response: ServerResponse): Promise<void> {
    const { bundlePath } = await readReadyCmsBuild(input);
    const archivePath = path.join(dataDirectory, "exports", `${randomUUID()}.zip`);
    await mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
    try {
      await exportBundle(bundlePath, archivePath);
      const archiveInfo = await stat(archivePath);
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(archiveInfo.size),
        "Content-Disposition": `attachment; filename="${await cmsBuildArchiveName(input.projectId)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(archivePath);
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          response.off("error", onError);
          response.off("finish", onFinish);
          response.off("close", onClose);
          stream.off("error", onError);
          if (error) {
            stream.destroy();
            reject(error);
          } else resolve();
        };
        const onError = (error: Error): void => finish(error);
        const onFinish = (): void => finish();
        const onClose = (): void => {
          if (!response.writableFinished) finish(new Error("Download ZIP interrotto dal client."));
        };
        stream.once("error", onError);
        response.once("error", onError);
        response.once("finish", onFinish);
        response.once("close", onClose);
        stream.pipe(response);
      });
    } finally {
      await rm(archivePath, { force: true }).catch(() => undefined);
    }
  }

  async function deployCmsBuild(input: { projectId: string; buildId: string; targetSiteId: string; expectedInspection: CmsDestinationInspection }): Promise<Record<string, unknown>> {
    const { build, files } = await readReadyCmsBuild(input);
    const site = requireSite(input.targetSiteId);
    const deployId = randomUUID();
    const targetKind = site.config.deployTarget ?? "cloudflare";

    if (targetKind === "ftp") {
      if (!site.config.hosting) throw new HistosPublishError("Configura prima l’hosting FTP/FTPS/SFTP.", "hosting-config-missing", 409);
      const settings = parseStaticHostingSettings(site.config.hosting);
      const credentials = await readStaticHostingCredentials(site, secretFactory, repository);
      const preview = {
        files: files.length,
        totalBytes: files.reduce((total, file) => total + (file.size ?? file.bytes?.byteLength ?? 0), 0),
        protocol: settings.protocol,
        host: settings.host,
        remoteDirectory: settings.remoteDirectory,
        publicUrl: settings.publicUrl ?? null,
      };
      cmsBuildRegistry.reserveDeployment({ id: deployId, projectId: input.projectId, buildId: input.buildId, targetSiteId: site.id });
      try {
        const job = createJob("deploy", site.id, async (activeJob) => {
          let backupSummary: { files: number; storedBytes: number } | null = null;
          try {
            if (input.expectedInspection.kind !== "static-hosting" || input.expectedInspection.destinationId !== site.id
              || !input.expectedInspection.remoteInventory?.complete) {
              throw new HistosPublishError("Il controllo hosting non contiene un inventario completo per il backup. Ripeti la preparazione del piano.", "cms-hosting-backup-inventory-incomplete", 409);
            }
            const hostingFiles = files.map((file) => ({ path: file.path, bytes: file.bytes! }));
            const previousFiles = options.cmsDeployAdapters?.hostingSnapshot
              ? await options.cmsDeployAdapters.hostingSnapshot({
                settings, credentials, files: hostingFiles,
                expectedRemoteFiles: input.expectedInspection.remoteInventory.files,
                expectedInventoryComplete: input.expectedInspection.remoteInventory.complete,
                signal: activeJob.controller.signal,
              })
              : await captureStaticHostingPreviousFiles({
                settings, credentials, files: hostingFiles,
                expectedRemoteFiles: input.expectedInspection.remoteInventory.files,
                expectedInventoryComplete: input.expectedInspection.remoteInventory.complete,
                signal: activeJob.controller.signal,
              });
            const previousByPath = new Map(previousFiles.map((file) => [file.path, file.beforeBytes]));
            if (previousByPath.size !== hostingFiles.length || hostingFiles.some((file) => !previousByPath.has(file.path))) {
              throw new HistosPublishError("Il backup remoto non copre esattamente i file della versione. L’upload non è partito.", "cms-hosting-backup-invalid", 500);
            }
            backupSummary = await cmsHostingBackupStore.create({
              deploymentId: deployId,
              projectId: input.projectId,
              destinationSiteId: site.id,
              destinationSha256: cmsDestinationSha256(site),
              entries: hostingFiles.map((file) => ({ path: file.path, beforeBytes: previousByPath.get(file.path) ?? null, deployedBytes: file.bytes })),
            });
            const result = options.cmsDeployAdapters?.hosting
              ? await options.cmsDeployAdapters.hosting({ settings, credentials, files: hostingFiles, signal: activeJob.controller.signal, onProgress: (progress) => emit(activeJob, { type: "progress", phase: progress.phase, completed: progress.completed, total: progress.total }) })
              : await publishStaticBundle({ settings, credentials, files: hostingFiles, signal: activeJob.controller.signal, onProgress: (progress) => emit(activeJob, { type: "progress", phase: progress.phase, completed: progress.completed, total: progress.total }) });
            const healthCheck = await (options.publishedHomeCheck ?? checkPublishedHome)(result.publicUrl);
            const detail = { deployId, provider: "hosting", uploaded: result.uploaded, files: result.files, protocol: settings.protocol, host: settings.host, remoteDirectory: settings.remoteDirectory, publicUrl: result.publicUrl ?? null, healthCheck, rollbackAvailable: true, backupFiles: backupSummary.files, backupBytes: backupSummary.storedBytes };
            cmsBuildRegistry.finishDeployment(deployId, "deployed", { result: detail });
            return detail;
          } catch (error) {
            const status = activeJob.controller.signal.aborted ? "cancelled" : "failed";
            cmsBuildRegistry.finishDeployment(deployId, status, {
              ...(backupSummary ? { result: { deployId, provider: "hosting", rollbackAvailable: true, backupFiles: backupSummary.files, backupBytes: backupSummary.storedBytes } } : {}),
              error: safeErrorMessage(error),
            });
            throw error;
          }
        });
        emit(job, { type: "deploy-summary", ...preview });
        return { jobId: job.id, deployId, targetSiteId: site.id, ...preview };
      } catch (error) {
        cmsBuildRegistry.finishDeployment(deployId, "failed", { error: safeErrorMessage(error) });
        throw error;
      }
    }

    const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
    const cloudflareFiles = files.map((file) => ({ ...file, size: file.size ?? file.bytes?.byteLength ?? 0 }));
    const manifest = planCloudflareManifest(cloudflareFiles, target.maxFiles);
    const preview = {
      files: files.length,
      manifestEntries: Object.keys(manifest).length,
      totalBytes: files.filter((file) => file.path !== "_headers" && file.path !== "_redirects").reduce((total, file) => total + (file.size ?? file.bytes?.byteLength ?? 0), 0),
      accountId: target.accountId,
      script: target.script,
      domain: site.config.cloudflare?.domain ?? null,
    };
    const client = options.cmsDeployAdapters?.cloudflare ? undefined : await cloudflareClientFromStore(cloudflareStore);
    cmsBuildRegistry.reserveDeployment({ id: deployId, projectId: input.projectId, buildId: input.buildId, targetSiteId: site.id });
    try {
      const job = createJob("deploy", site.id, async (activeJob) => {
        try {
          const result = options.cmsDeployAdapters?.cloudflare
            ? await options.cmsDeployAdapters.cloudflare({ ...target, files: cloudflareFiles, signal: activeJob.controller.signal, onEvent: (event) => emit(activeJob, event) })
            : await deployBundle({ client: client!, accountId: target.accountId, script: target.script, files: cloudflareFiles, findings: build.findings as Finding[], ...(target.maxFiles === undefined ? {} : { maxFiles: target.maxFiles }), signal: activeJob.controller.signal, onEvent: (event) => emit(activeJob, event) });
          const workersDevUrl = client ? await client.getWorkersDevUrl(target.accountId, target.script, activeJob.controller.signal).catch(() => undefined) : undefined;
          const publicHomeUrl = site.config.cloudflare?.domain ? `https://${site.config.cloudflare.domain}` : workersDevUrl;
          const healthCheck = await (options.publishedHomeCheck ?? checkPublishedHome)(publicHomeUrl);
          const detail = { deployId, provider: "cloudflare", versionId: result.versionId, uploaded: result.uploaded, workersDevUrl: workersDevUrl ?? null, healthCheck, ...preview };
          cmsBuildRegistry.finishDeployment(deployId, "deployed", { result: detail });
          return detail;
        } catch (error) {
          const status = activeJob.controller.signal.aborted ? "cancelled" : "failed";
          cmsBuildRegistry.finishDeployment(deployId, status, { error: safeErrorMessage(error) });
          throw error;
        }
      });
      emit(job, { type: "deploy-summary", ...preview });
      return { jobId: job.id, deployId, targetSiteId: site.id, ...preview };
    } catch (error) {
      cmsBuildRegistry.finishDeployment(deployId, "failed", { error: safeErrorMessage(error) });
      throw error;
    }
  }

  function sendJobEvents(response: ServerResponse, id: string): void {
    const job = jobs.get(id);
    if (!job) throw new HistosPublishError("Operazione non trovata o scaduta.", "job-missing", 404);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    for (const event of job.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (job.status !== "running") {
      response.end();
      return;
    }
    job.subscribers.add(response);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    response.on("close", () => {
      clearInterval(heartbeat);
      job.subscribers.delete(response);
    });
  }

  async function saveConsent(origin: string): Promise<void> {
    consentedOrigins.add(origin);
    await mkdir(path.dirname(consentFile), { recursive: true, mode: 0o700 });
    const temporary = `${consentFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...consentedOrigins].sort())}\n`, { mode: 0o600 });
    await rename(temporary, consentFile);
  }

  async function savePrivateOriginConsent(origin: string): Promise<void> {
    privateOriginConsents.add(origin);
    await mkdir(path.dirname(privateOriginConsentFile), { recursive: true, mode: 0o700 });
    const temporary = `${privateOriginConsentFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...privateOriginConsents].sort())}\n`, { mode: 0o600 });
    await rename(temporary, privateOriginConsentFile);
  }

  /** What CMS operations need, shared by the API routes and the AI connector. */
  function cmsOperationsContext(): CmsOperationsContext {
    const address = server.address();
    const cmsPort = address && typeof address !== "string" ? address.port : requestedPort;
    return {
      catalog: cmsCatalog,
      dataDirectory,
      port: cmsPort,
      ...(options.cmsBuildLimits === undefined ? {} : { buildLimits: options.cmsBuildLimits }),
      ...(options.cmsBuildBundle === undefined ? {} : { buildBundle: options.cmsBuildBundle }),
      ...(options.cmsPrototypeAssetFetcher === undefined ? {} : { fetchPrototypeAsset: options.cmsPrototypeAssetFetcher }),
      registerPreview: (preview) => previews.set(preview.ticket, { buildId: preview.buildId, bundlePath: preview.bundlePath, expiresAt: Date.now() + PREVIEW_TTL_MS }),
      registerBuild: registerCmsBuild,
      prototypePreviews,
      importReports,
      convertedMedia: (sha256: string) => convertedMedia.read(sha256),
      ...(options.fontFetcher ? { fontFetcher: options.fontFetcher } : {}),
      ...(options.openPageProbe ? { openPageProbe: options.openPageProbe } : {}),
      importProgress,
    };
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { return ""; }
    });
    if (parts.some((part) => part === "")) throw new HistosPublishError("Percorso API non valido.", "api-path-invalid", 400);

    if (parts[1] === "connector") {
      if (await handleConnectorApi(request, response, parts, url, connector)) return;
    }

    if (parts[1] === "cms") {
      const handling = handleCmsApi(request, response, parts, url, {
        ...cmsOperationsContext(),
        remoteCatalog: cmsRemoteCatalog,
        secretStoreFor: (account) => storeFor(account, secretFactory),
        listBuilds: listCmsBuilds,
        latestBuild: (projectId) => cmsBuildRegistry.listBuilds(projectId, 1)[0] ?? null,
        ...(options.photographPages ? { photographPages: options.photographPages } : {}),
        // «Uguale alla proposta», the side «senza token»: the kept capture converted without a framework, fonts downloaded.
        convertProposalSite: async (files, name, signal) => {
          const converted = await convertFilesAndMissing(files, staticSiteProjectId(randomUUID()), name, { framework: "none", fonts: true }, signal);
          return { prototype: converted.answer.prototype, missing: converted.missing };
        },
        ...(captureOrigin ? { openProposalOriginal: (siteDirectory: string) => `${captureOrigin}${PROPOSAL_ORIGINAL_PREFIX}${proposalOriginals.open(siteDirectory)}/` } : {}),
        previewBuild: previewCmsBuild,
        projectInUse: (projectId) => {
          if (cmsBuildRegistry.hasRunningDeployment(projectId)) return "Una pubblicazione del progetto è ancora in corso: aspetta che finisca, poi eliminalo.";
          const site = repository.listSites().find((candidate) => candidate.config.source.kind === "cms" && candidate.config.source.path === projectId);
          return site ? `Il progetto è la sorgente del sito «${site.name}»: elimina prima il sito, poi il progetto.` : null;
        },
        forgetProject: async (projectId) => {
          // Its builds: the folder (only the one of this project, inside the builds folder), previews and records.
          const buildsRoot = path.resolve(dataDirectory, "histos-cms-builds");
          const folder = path.resolve(buildsRoot, projectId);
          if (path.dirname(folder) === buildsRoot) await removeTemporary(folder);
          for (const [ticket, preview] of previews) if (path.resolve(preview.bundlePath).startsWith(`${folder}${path.sep}`)) previews.delete(ticket);
          for (const [buildId, build] of cmsBuilds) if (build.projectId === projectId) cmsBuilds.delete(buildId);
          cmsBuildRegistry.forgetProject(projectId);
        },
        exportBuild: exportCmsBuild,
        createPublishPlan: createCmsPublishPlan,
        executePublishPlan: executeCmsPublishPlan,
        rollbackDeployment: rollbackCmsDeployment,
        inspectDestination: options.cmsDestinationInspection ?? inspectCmsDestination,
        resolveDestination: resolveCmsDestination,
        listBuildDeployments: listCmsDeployments,
      });
      activeCmsRequests.add(handling);
      let handled: boolean;
      try { handled = await handling; }
      finally { activeCmsRequests.delete(handling); }
      if (handled) return;
    }

    if (method === "GET" && parts.join("/") === "api/bootstrap") {
      const accountId = configuredAccountId(repository);
      const language = repository.getSetting<string>("language") ?? "it";
      const token = await tokenConfigured(cloudflareStore);
      const sites = repository.listSites().map((site) => safeSite(site, repository));
      sendJson(response, 200, { version: HISTOS_PUBLISH_VERSION, accountId, language, dataDirectory, token, sites });
      return;
    }

    if (method === "POST" && parts.join("/") === "api/detect") {
      const body = await readJson(request, 64 * 1024);
      if (typeof body.input !== "string" || body.input.trim().length < 1 || body.input.length > 4096) throw new HistosPublishError("Inserisci un URL valido.", "source-invalid", 2);
      const source = detectSource(body.input.trim());
      if (source.kind !== "url") {
        sendJson(response, 200, { source, networkRequested: false, suggestedName: path.basename(source.path, path.extname(source.path)) || "Nuovo sito", suggestedWorker: slugify(path.basename(source.path) || "nuovo-sito") });
        return;
      }
      const origin = new URL(source.path).origin;
      const privateOrigin = isPrivateOriginHost(new URL(source.path).hostname);
      const needsConsent = !consentedOrigins.has(origin) || (privateOrigin && !privateOriginConsents.has(origin));
      if (needsConsent && (body.authorized !== true || body.authorizedOrigin !== origin)) {
        sendJson(response, 200, { needsConsent: true, origin, source, localOrigin: privateOrigin });
        return;
      }
      if (!consentedOrigins.has(origin)) await saveConsent(origin);
      if (privateOrigin && !privateOriginConsents.has(origin)) await savePrivateOriginConsent(origin);
      const credentials = cleanCredentials(body.credentials);
      const detection = await detectOnlineSite({ sourceUrl: source.path, crawlConsent: origin, ...(credentials === undefined ? {} : { credentials }), ...(privateOrigin ? { privateOrigin: true } : {}) });
      sendJson(response, 200, {
        needsConsent: false,
        source: { kind: "url", path: detection.sourceUrl },
        networkRequested: true,
        detection,
        suggestedName: new URL(detection.sourceUrl).hostname.replace(/^www\./u, ""),
        suggestedWorker: slugify(new URL(detection.sourceUrl).hostname.replace(/^www\./u, "").replace(/\./gu, "-")),
      });
      return;
    }

    if (method === "POST" && parts.join("/") === "api/sites") {
      const body = await readJson(request, 128 * 1024);
      const name = requireSiteName(body.name);
      const source = body.source as SiteConfig["source"] | undefined;
      if (!source || typeof source !== "object" || !["directory", "html", "zip", "url", "cms"].includes(source.kind) || typeof source.path !== "string") {
        throw new HistosPublishError("La sorgente del sito non è valida.", "site-invalid", 2);
      }
      if (source.kind === "cms") {
        // Only an existing project: the site becomes the place where that project's builds are published.
        const project = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(source.path) ? await cmsCatalog.openProject(source.path) : null;
        if (!project) throw new HistosPublishError("Il progetto Histeon CMS da pubblicare non esiste.", "cms-project-missing", 404);
        project.store.close();
      }
      if (source.kind === "url") {
        const origin = new URL(source.path).origin;
        if (!consentedOrigins.has(origin)) throw new HistosPublishError("Conferma prima l’autorizzazione per leggere questo dominio.", "crawl-consent-required", 2);
        if (isPrivateOriginHost(new URL(source.path).hostname) && !privateOriginConsents.has(origin)) throw new HistosPublishError("Autorizza separatamente la lettura di questa sorgente locale o privata.", "crawl-private-consent-required", 2);
      }
      if (body.render === true && source.kind !== "url") throw new HistosPublishError("La modalità render si applica solo a una sorgente online.", "render-source-invalid", 2);
      const defaultAccount = configuredAccountId(repository);
      const cloudflare = body.cloudflare && typeof body.cloudflare === "object" ? body.cloudflare as CloudflareSettings : {};
      if (typeof cloudflare.domain === "string" && cloudflare.domain && !isHostname(cloudflare.domain)) throw new HistosPublishError("Inserisci un dominio valido senza schema o percorso.", "cloudflare-domain-invalid", 2);
      const config = parseSiteConfig({
        ...createSiteConfig(name, source),
        cloudflare: {
          ...(cloudflare.accountId ?? defaultAccount ? { accountId: cloudflare.accountId ?? defaultAccount } : {}),
          ...(typeof cloudflare.script === "string" ? { script: cloudflare.script } : { script: slugify(name) }),
          ...(typeof cloudflare.domain === "string" && cloudflare.domain ? { domain: cloudflare.domain } : {}),
          ...(typeof cloudflare.maxFiles === "number" ? { maxFiles: cloudflare.maxFiles } : {}),
        },
        ...(body.render === true ? { crawl: { render: true } } : {}),
      });
      const site = repository.createSite({ id: randomUUID(), name, config });
      sendJson(response, 201, { site: safeSite(site, repository) });
      return;
    }

    // Deleting a site moves it to the Cestino: only with its exact name, never while one of its builds or deploys runs.
    // It keeps its secrets, files and records there, so restoring it gives it back as it was (purgeSite removes them).
    if (method === "DELETE" && parts[0] === "api" && parts[1] === "sites" && parts.length === 3 && parts[2]) {
      const site = requireSite(parts[2]);
      const body = await readJson(request, 16 * 1024);
      if (typeof body.confirmName !== "string" || body.confirmName.trim() !== site.name) throw new HistosPublishError("Per eliminare il sito scrivi il suo nome esatto.", "site-delete-confirm", 400);
      if ([...jobs.values()].some((job) => job.siteId === site.id && job.status === "running")) throw new HistosPublishError("Una versione o una pubblicazione del sito è ancora in corso: aspetta che finisca, poi eliminalo.", "site-in-use", 409);
      repository.trashSite(site.id);
      for (const [ticket, preview] of previews) if (path.resolve(preview.bundlePath).startsWith(`${path.resolve(dataDirectory, "sites", site.id)}${path.sep}`)) previews.delete(ticket);
      sendJson(response, 200, { trashed: true, id: site.id, name: site.name });
      return;
    }

    // The Cestino: what was deleted, for TRASH_DAYS days, to restore or to delete for good (again with the exact name).
    if (parts[0] === "api" && parts[1] === "trash") {
      if (method === "GET" && parts.length === 2) {
        sendJson(response, 200, {
          retentionDays: TRASH_DAYS,
          projects: await cmsCatalog.listTrashedProjects(),
          sites: repository.listTrashedSites().map((site) => ({ id: site.id, name: site.name, deletedAt: site.deletedAt })),
        });
        return;
      }
      const kind = parts[2];
      const id = parts[3] ?? "";
      if ((kind === "projects" || kind === "sites") && id && parts.length === 5 && parts[4] === "restore" && method === "POST") {
        if (kind === "projects") {
          let restored: boolean;
          try { restored = await cmsCatalog.restoreProject(id); }
          catch (error) {
            // Only the real conflict is told as one; any other failure (a full disk, a permission) keeps its own message.
            if (error instanceof CmsProjectRestoreConflictError) throw new HistosPublishError("Esiste già un progetto con lo stesso identificativo: non posso ripristinarlo.", "trash-conflict", 409);
            throw error;
          }
          if (!restored) throw new HistosPublishError("Non è nel Cestino.", "trash-missing", 404);
        } else if (!repository.restoreSite(id)) throw new HistosPublishError("Non è nel Cestino.", "trash-missing", 404);
        sendJson(response, 200, { restored: true, id });
        return;
      }
      if ((kind === "projects" || kind === "sites") && id && parts.length === 4 && method === "DELETE") {
        const body = await readJson(request, 16 * 1024);
        const name = kind === "projects" ? (await cmsCatalog.listTrashedProjects()).find((item) => item.id === id)?.name : repository.listTrashedSites().find((item) => item.id === id)?.name;
        if (name === undefined) throw new HistosPublishError("Non è nel Cestino.", "trash-missing", 404);
        if (typeof body.confirmName !== "string" || body.confirmName.trim() !== name) throw new HistosPublishError("Per eliminarlo definitivamente scrivi il suo nome esatto.", "trash-confirm", 400);
        if (kind === "projects") await purgeProject(id);
        else await purgeSite(id);
        sendJson(response, 200, { deleted: true, id, name });
        return;
      }
    }

    // Folders that group CMS projects or sites (folders.ts): a name each, and which folder each item is in.
    if (parts[0] === "api" && parts[1] === "folders" && parts.length <= 3) {
      // Read after the body and the lists are in, right before the change: two requests never undo each other.
      const current = () => readFolders(repository.getSetting(FOLDERS_SETTING));
      const id = parts[2] ?? "";
      if (method === "GET" && parts.length === 2) {
        sendJson(response, 200, current());
        return;
      }
      if (method === "POST" && parts.length === 2) {
        const body = await readJson(request, 16 * 1024);
        const folders = current();
        const folder = createFolder(folders, body.kind, body.name);
        repository.setSetting(FOLDERS_SETTING, folders);
        sendJson(response, 201, { folder });
        return;
      }
      if (method === "POST" && id === "move") {
        const body = await readJson(request, 256 * 1024);
        const known = new Set<string>();
        if (body.kind === "cms") {
          const listed = await cmsCatalog.listProjectsWithProblems();
          for (const project of listed.projects) known.add(project.id);
          for (const problem of listed.unavailable) known.add(problem.id);
        } else for (const site of repository.listSites()) known.add(site.id);
        const folders = current();
        const moved = moveToFolder(folders, body.kind, body.ids, body.folderId ?? null, known);
        repository.setSetting(FOLDERS_SETTING, folders);
        sendJson(response, 200, { moved });
        return;
      }
      if (method === "PATCH" && id) {
        const body = await readJson(request, 16 * 1024);
        const folders = current();
        const folder = renameFolder(folders, id, body.name);
        repository.setSetting(FOLDERS_SETTING, folders);
        sendJson(response, 200, { folder });
        return;
      }
      if (method === "DELETE" && id && id !== "move") {
        const folders = current();
        deleteFolder(folders, id);
        repository.setSetting(FOLDERS_SETTING, folders);
        sendJson(response, 200, { deleted: true, id });
        return;
      }
    }

    if (method === "POST" && parts.join("/") === "api/imports") {
      const body = await readJson(request, 4 * 1024 * 1024);
      const result = await imports.start({ name: body.name, kind: body.kind, files: body.files });
      sendJson(response, 201, result);
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "source-import" && parts[2]) {
      const site = requireSite(parts[2]);
      if (site.config.source.kind === "cms") throw new HistosPublishError("Questo sito pubblica un progetto Histeon CMS: aggiorna il progetto, non i file del sito.", "cms-site-source-locked", 409);
      const body = await readJson(request, 4 * 1024 * 1024);
      const result = await imports.start({ name: site.name, kind: body.kind, files: body.files, targetSiteId: site.id });
      sendJson(response, 201, result);
      return;
    }

    const importFile = url.pathname.match(/^\/api\/imports\/([0-9a-f-]{36})\/files\/(.+)$/u);
    if (method === "PUT" && importFile?.[1] && importFile[2]) {
      const result = await imports.receive(importFile[1], importFile[2], request);
      sendJson(response, 201, result);
      return;
    }

    const importInspect = method === "POST" && parts[0] === "api" && parts[1] === "imports" && parts[3] === "inspect" && parts[2];
    if (importInspect && parts[2]) {
      const result = await imports.inspectZip(parts[2]);
      sendJson(response, 200, result);
      return;
    }

    const importComplete = parts[0] === "api" && parts[1] === "imports" && parts[3] === "complete";
    if (method === "POST" && importComplete && parts[2]) {
      const completed = await imports.complete(parts[2]);
      const source = completed.kind === "directory"
        ? { kind: "directory" as const, path: completed.sourcePath }
        : completed.kind === "html"
          ? { kind: "html" as const, path: completed.sourcePath, root: completed.rootPath }
          : { kind: "zip" as const, path: completed.sourcePath };
      const existingSite = completed.replaceExisting ? repository.getSite(completed.siteId) : null;
      if (completed.replaceExisting && !existingSite) throw new HistosPublishError("Il progetto da aggiornare non è più disponibile. La sorgente caricata è rimasta nell’archivio locale.", "site-missing", 404);
      if (existingSite?.config.source.kind === "cms") throw new HistosPublishError("Questo sito pubblica un progetto Histeon CMS: aggiorna il progetto, non i file del sito.", "cms-site-source-locked", 409);
      if (existingSite) {
        const config = parseSiteConfig({ ...existingSite.config, source });
        const updated = repository.updateSite(existingSite.id, { config });
        if (!updated) throw new HistosPublishError("Il progetto non è più disponibile.", "site-missing", 404);
        const refreshed = repository.markSourceUpdated(existingSite.id) ?? updated;
        sendJson(response, 200, { site: safeSite(refreshed, repository), fileCount: completed.fileCount, totalBytes: completed.totalBytes });
        return;
      }
      const accountId = configuredAccountId(repository);
      const config = parseSiteConfig({
        ...createSiteConfig(completed.name, source),
        cloudflare: { ...(accountId ? { accountId } : {}), script: slugify(completed.name) },
      });
      const site = repository.createSite({ id: completed.siteId, name: completed.name, config });
      sendJson(response, 201, { site: safeSite(site, repository), fileCount: completed.fileCount, totalBytes: completed.totalBytes });
      return;
    }

    const importAbort = parts[0] === "api" && parts[1] === "imports" && parts.length === 3;
    if (method === "DELETE" && importAbort && parts[2]) {
      proposalFrames.closeFor(parts[2]);
      await imports.abort(parts[2]);
      sendJson(response, 200, { cancelled: true });
      return;
    }

    if (method === "GET" && parts[0] === "api" && parts[1] === "jobs" && parts[3] === "events" && parts[2]) {
      sendJobEvents(response, parts[2]);
      return;
    }
    if (method === "POST" && parts[0] === "api" && parts[1] === "jobs" && parts[3] === "cancel" && parts[2]) {
      const job = jobs.get(parts[2]);
      if (job?.status !== "running") throw new HistosPublishError("Operazione non attiva.", "job-missing", 404);
      job.controller.abort();
      sendJson(response, 202, { cancelled: true });
      return;
    }

    // B1: the site's latest ready build as a Histeon prototype; the app checks it, shows the preview and imports it
    // like any prototype. Converting the same site again updates the same project.
    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "cms-prototype" && parts[2]) {
      const site = requireSite(parts[2]);
      if (site.config.source.kind === "cms") throw new HistosPublishError("Questo sito pubblica già un progetto Histeon CMS.", "cms-site-build-refused", 409);
      const build = repository.listBuilds(site.id, 20).find((item) => item.status === "ready" && item.bundlePath);
      if (!build?.bundlePath) throw new HistosPublishError("Crea prima una versione pronta del sito: la conversione parte dai suoi file.", "cms-site-build-missing", 409);
      const body = await readJson(request, 64 * 1024);
      const source = await readDirectorySource(build.bundlePath, { maxBytes: 128 * 1024 * 1024 });
      sendJson(response, 200, await convertFilesToPrototype(source.files.map((file) => ({ path: file.path, bytes: file.bytes })), staticSiteProjectId(site.id), site.name, body, closedSignal(response)));
      return;
    }

    // Doc 18 F1: an HTML page, a folder or a ZIP dropped on the CMS catalog becomes a prototype at once, without a
    // site or a build. The upload stays until it is deleted (DELETE /api/imports/:id), so the choices can change.
    if (method === "POST" && parts[0] === "api" && parts[1] === "imports" && parts[3] === "cms-prototype" && parts[2] && parts.length === 4) {
      const body = await readJson(request, 64 * 1024);
      const source = await imports.sourceFiles(parts[2], 128 * 1024 * 1024);
      // Doc 28: a captured proposal keeps the sizes it wrote by hand, as the site's variables. Decided here, from the
      // upload itself and never from the request: whatever the dialog asks for, a proposal stays exact.
      sendJson(response, 200, await convertFilesToPrototype(source.files, staticSiteProjectId(parts[2]), source.name, body, closedSignal(response), source.notes, source.captured === true));
      return;
    }

    // «Fotografa la proposta»: is the uploaded page drawn by its scripts? Then the app can show it alive in a sealed
    // frame (GET /__capture/<ticket>/) and let the person add the pages one by one. Only a hint: nothing is decided here.
    if (method === "POST" && parts[0] === "api" && parts[1] === "imports" && parts[3] === "capture-frame" && parts[2] && parts.length === 4) {
      const source = await imports.sourceFiles(parts[2], 128 * 1024 * 1024);
      const page = source.kind === "html" && !source.captured ? source.files[0] : undefined;
      const signs = page ? scriptRenderedSigns(new TextDecoder().decode(page.bytes)) : { scripted: false, reasons: [] };
      sendJson(response, 200, signs.scripted ? { ...signs, url: `${captureOrigin}${PROPOSAL_FRAME_PREFIX}${proposalFrames.open(parts[2])}/` } : signs);
      return;
    }

    // The pages the frame sent back become an upload of their own: a static site, converted like any other folder.
    if (method === "POST" && parts[0] === "api" && parts[1] === "imports" && parts[3] === "captured-site" && parts[2] && parts.length === 4) {
      const body = await readJson(request, 128 * 1024 * 1024);
      const captured = capturedProposalSite(body.pages);
      const adopted = await imports.adopt(parts[2], captured.site.files, captured.notes, captured.site.pages);
      sendJson(response, 201, { id: adopted.id, pages: captured.site.pages, notes: captured.notes });
      return;
    }

    // After the import: the captured pages stay with the project they became (`<project>/proposal/`), as the
    // original «Uguale alla proposta» compares the built site with.
    if (method === "POST" && parts[0] === "api" && parts[1] === "imports" && parts[3] === "keep-proposal" && parts[2] && parts.length === 4) {
      const body = await readJson(request, 4096);
      const source = await imports.sourceFiles(parts[2], 128 * 1024 * 1024);
      if (!source.captured) throw new HistosPublishError("Questo caricamento non è una proposta fotografata.", "proposal-capture-invalid", 2);
      const opened = typeof body.projectId === "string" && /^[0-9a-f-]{36}$/iu.test(body.projectId) ? await cmsCatalog.openProject(body.projectId) : null;
      if (!opened) throw new HistosPublishError("Progetto non trovato.", "cms-project-missing", 404);
      opened.store.close();
      sendJson(response, 201, await keepProposal(opened.project.directory, source.files, source.capturedPages));
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "build" && parts[2]) {
      const site = requireSite(parts[2]);
      if (site.config.source.kind === "cms") throw new HistosPublishError("Questo sito pubblica un progetto Histeon CMS: crea la versione dal progetto.", "cms-site-build-refused", 409);
      const credentials = await getSiteCredentials(site.id, secretFactory, repository);
      const buildId = randomUUID();
      const outputDirectory = path.join(dataDirectory, "sites", site.id, "builds", buildId);
      await mkdir(path.dirname(outputDirectory), { recursive: true, mode: 0o700 });
      const job = createJob("build", site.id, async (activeJob) => {
        const origin = site.config.source.kind === "url" ? new URL(site.config.source.path).origin : undefined;
        if (origin && !consentedOrigins.has(origin)) throw new HistosPublishError("Conferma prima l’autorizzazione per leggere questo dominio.", "crawl-consent-required", 2);
        const privateOrigin = Boolean(origin && isPrivateOriginHost(new URL(site.config.source.path).hostname));
        if (origin && privateOrigin && !privateOriginConsents.has(origin)) throw new HistosPublishError("Autorizza prima la lettura di questa sorgente locale o privata dalla schermata di rilevamento.", "crawl-private-consent-required", 2);
        try {
          let fallbackRenderer: { renderPage: RenderPage; close(): Promise<void> } | undefined;
          try {
            if (site.config.crawl?.render && !options.renderPage) {
              const { createPlaywrightRenderSession } = await import("@histos-publish/core");
              fallbackRenderer = await createPlaywrightRenderSession();
            }
            const result = await buildBundle(buildOptions(site.config, outputDirectory, activeJob.controller.signal, origin, credentials, (event) => emit(activeJob, event), options.renderPage ?? fallbackRenderer?.renderPage, Boolean(privateOrigin && origin && privateOriginConsents.has(origin))));
            const status = result.status;
            const completedAt = new Date().toISOString();
            const stored: StoredBuild = { id: buildId, siteId: site.id, status, createdAt: completedAt, completedAt, ...(result.bundlePath ? { bundlePath: result.bundlePath } : {}), result };
            repository.addBuild(stored);
            // A _worker.js in the site's ZIP or folder: its KV archives go into the settings, as with a .js uploaded apart.
            const kvAdded = result.worker?.kv?.length ? await fillKvFromWorker(site.id, result.worker.kv) : [];
            return { buildId, buildStatus: status, result: publicResult(stored), ...(kvAdded.length ? { kvAdded } : {}) };
          } finally { await fallbackRenderer?.close(); }
        } catch (error) {
          const cancelled = activeJob.controller.signal.aborted;
          const message = safeErrorMessage(error);
          const status: StoredBuild["status"] = cancelled ? "cancelled" : "failed";
          repository.addBuild({ id: buildId, siteId: site.id, status, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: message });
          throw error;
        }
      });
      sendJson(response, 202, { jobId: job.id, buildId, siteId: site.id });
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "deploy" && parts[2]) {
      const body = await readJson(request, 64 * 1024);
      if (body.confirmed !== true) throw new HistosPublishError("Conferma la pubblicazione nel riepilogo prima di inviare il deploy.", "confirmation-required", 2);
      const site = requireSite(parts[2]);
      // E6: the summary names a destination; if the site's settings changed after it, nothing goes out.
      if (body.expectedDestination !== undefined && body.expectedDestination !== siteDeployDestination(site.config)) {
        throw new HistosPublishError("La destinazione del sito è cambiata dopo il riepilogo: non ho pubblicato nulla. Ripeti «Prepara il sito e pubblica».", "deploy-destination-changed", 6);
      }
      if ((site.config.deployTarget ?? "cloudflare") === "ftp") {
        if (!site.config.hosting) throw new HistosPublishError("Configura prima l’hosting FTP/FTPS/SFTP.", "hosting-config-missing", 2);
        const target = parseStaticHostingSettings(site.config.hosting);
        const build = typeof body.buildId === "string" ? repository.getBuild(body.buildId) : repository.latestFinishedBuild(site.id);
        if (!build || build.siteId !== site.id || build.status !== "ready" || !build.bundlePath) throw new HistosPublishError("Prepara una versione pronta prima di pubblicare.", "build-not-ready", 2);
        if (build.result?.forms?.enabled) throw new HistosPublishError("Questa versione include Fluent Forms via WordPress, che al momento richiede il Worker Cloudflare di Histeon Publish. Scegli Cloudflare oppure disattiva quei moduli prima di pubblicare su hosting statico.", "hosting-forms-unsupported", 2);
        const credentials = await readStaticHostingCredentials(site, secretFactory, repository);
        const source = await readDirectorySource(build.bundlePath);
        // The site's own Worker is server code: it runs only on Cloudflare and never goes out as a public file.
        if (source.files.some((file) => file.path === SITE_WORKER_PATH)) throw new HistosPublishError(`Questa versione contiene il codice del Worker del sito (${SITE_WORKER_PATH}), che funziona solo su Cloudflare. Scegli Cloudflare, oppure togli il codice del Worker e prepara una nuova versione.`, "hosting-worker-unsupported", 2);
        const files = source.files.map((file) => ({ path: file.path, bytes: file.bytes }));
        const deployId = randomUUID();
        const preview = { files: files.length, totalBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0), protocol: target.protocol, host: target.host, remoteDirectory: target.remoteDirectory, publicUrl: target.publicUrl ?? null };
        const job = createJob("deploy", site.id, async (activeJob) => {
          try {
            const result = await publishStaticBundle({
              settings: target,
              credentials,
              files,
              signal: activeJob.controller.signal,
              onProgress: (progress) => emit(activeJob, { type: "progress", phase: progress.phase, completed: progress.completed, total: progress.total }),
            });
            const healthCheck = await (options.publishedHomeCheck ?? checkPublishedHome)(result.publicUrl);
            const stored: StoredDeploy = { id: deployId, siteId: site.id, buildId: build.id, status: "deployed", createdAt: new Date().toISOString(), ...(result.publicUrl === undefined ? {} : { workersDevUrl: result.publicUrl }), uploaded: result.uploaded, files: result.files, healthCheck };
            repository.addDeploy(stored);
            return { deployId, uploaded: result.uploaded, files: result.files, protocol: target.protocol, host: target.host, remoteDirectory: target.remoteDirectory, publicUrl: result.publicUrl ?? null, healthCheck };
          } catch (error) {
            repository.addDeploy({ id: deployId, siteId: site.id, buildId: build.id, status: activeJob.controller.signal.aborted ? "cancelled" : "failed", createdAt: new Date().toISOString(), error: safeErrorMessage(error) });
            throw error;
          }
        });
        emit(job, { type: "deploy-summary", ...preview });
        sendJson(response, 202, { jobId: job.id, deployId, ...preview });
        return;
      }
      const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
      const build = typeof body.buildId === "string" ? repository.getBuild(body.buildId) : repository.latestFinishedBuild(site.id);
      if (!build || build.siteId !== site.id || build.status !== "ready" || !build.bundlePath) throw new HistosPublishError("Prepara una versione pronta prima di pubblicare.", "build-not-ready", 2);
      let turnstileSecret: string | undefined;
      if (build.result?.forms?.enabled) {
        if (!site.config.cloudflare?.script || !(repository.getSetting<boolean>(`turnstileSecret:${site.id}`) ?? false)) throw new HistosPublishError("I moduli sono pronti, ma manca la chiave segreta Turnstile nel portachiavi locale.", "forms-secret-missing", 2);
        turnstileSecret = await storeFor(turnstileSecretAccount(site.config.cloudflare.script), secretFactory).get() ?? undefined;
        if (!turnstileSecret) throw new HistosPublishError("La chiave segreta Turnstile non è disponibile nel portachiavi locale. Inseriscila di nuovo nelle impostazioni del sito.", "forms-secret-missing", 2);
      }
      const client = await cloudflareClientFromStore(cloudflareStore);
      const source = await readDirectorySource(build.bundlePath);
      const files = source.files.map((file) => ({ path: file.path, size: file.bytes.byteLength, bytes: file.bytes }));
      const manifest = planCloudflareManifest(files, target.maxFiles);
      const totalBytes = files.filter((file) => file.path !== "_headers" && file.path !== "_redirects").reduce((total, file) => total + file.size, 0);
      const preview = { files: files.length, manifestEntries: Object.keys(manifest).length, totalBytes, accountId: target.accountId, script: target.script, domain: site.config.cloudflare?.domain ?? null };
      const deployId = randomUUID();
      const job = createJob("deploy", site.id, async (activeJob) => {
        try {
          const result = await deployBundle({ client, accountId: target.accountId, script: target.script, files, ...(site.config.cloudflare?.kv?.length ? { kv: site.config.cloudflare.kv } : {}), ...(build.result?.findings === undefined ? {} : { findings: build.result.findings }), ...(build.result?.forms === undefined ? {} : { forms: build.result.forms }), ...(turnstileSecret === undefined ? {} : { turnstileSecret }), ...(target.maxFiles === undefined ? {} : { maxFiles: target.maxFiles }), signal: activeJob.controller.signal, ...(typeof body.message === "string" ? { message: body.message.slice(0, 1000) } : {}), onEvent: (event) => emit(activeJob, event) });
          const workersDevUrl = await client.getWorkersDevUrl(target.accountId, target.script, activeJob.controller.signal).catch(() => undefined);
          const publicHomeUrl = site.config.cloudflare?.domain ? `https://${site.config.cloudflare.domain}` : workersDevUrl;
          const healthCheck = await (options.publishedHomeCheck ?? checkPublishedHome)(publicHomeUrl);
          const stored: StoredDeploy = { id: deployId, siteId: site.id, buildId: build.id, status: "deployed", createdAt: new Date().toISOString(), versionId: result.versionId, deploymentId: result.deployment.id, ...(workersDevUrl === undefined ? {} : { workersDevUrl }), uploaded: result.uploaded, files: result.files, healthCheck };
          repository.addDeploy(stored);
          return { deployId, versionId: result.versionId, deployment: result.deployment, uploaded: result.uploaded, workersDevUrl, healthCheck, manifestEntries: preview.manifestEntries, totalBytes: preview.totalBytes, accountId: preview.accountId, script: preview.script, domain: preview.domain };
        } catch (error) {
          repository.addDeploy({ id: deployId, siteId: site.id, buildId: build.id, status: activeJob.controller.signal.aborted ? "cancelled" : "failed", createdAt: new Date().toISOString(), error: safeErrorMessage(error), ...(activeJob.phase === undefined ? {} : { failedPhase: activeJob.phase }) });
          throw error;
        }
      });
      emit(job, { type: "deploy-summary", ...preview });
      sendJson(response, 202, { jobId: job.id, deployId, ...preview });
      return;
    }

    if (method === "GET" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "history" && parts[2]) {
      const site = requireSite(parts[2]);
      sendJson(response, 200, { builds: repository.listBuilds(site.id).map(publicResult), deploys: repository.listDeploys(site.id) });
      return;
    }

    if (method === "GET" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "remote-history" && parts[2]) {
      const site = requireSite(parts[2]);
      const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
      const client = await cloudflareClientFromStore(cloudflareStore);
      const [deployments, versions] = await Promise.all([client.listDeployments(target.accountId, target.script), client.listVersions(target.accountId, target.script)]);
      sendJson(response, 200, { deployments, versions, listed: Math.min(deployments.length, versions.length), note: "Cloudflare non dichiara un periodo esatto di conservazione." });
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "rollback" && parts[2]) {
      const body = await readJson(request, 64 * 1024);
      if (body.confirmed !== true || typeof body.id !== "string" || body.id.length > 128) throw new HistosPublishError("Seleziona una versione e conferma il ripristino.", "confirmation-required", 2);
      const site = requireSite(parts[2]);
      const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
      const client = await cloudflareClientFromStore(cloudflareStore);
      const result = await rollbackVersion({ client, accountId: target.accountId, script: target.script, deploymentOrVersionId: body.id });
      // The deploy is recorded under the build that made the restored version, not the last one attempted; a version
      // Publish never recorded has no build to point to, and the deploys table needs one, so nothing is recorded.
      const restored = result.versions.find((version) => version.percentage > 0)?.version_id ?? result.versions[0]?.version_id;
      const build = restored === undefined ? null : repository.buildForVersion(site.id, restored);
      if (build && restored !== undefined) repository.addDeploy({ id: randomUUID(), siteId: site.id, buildId: build.id, status: "deployed", createdAt: new Date().toISOString(), versionId: restored, deploymentId: result.id, uploaded: 0, files: build.result?.files ?? 0 });
      sendJson(response, 200, { deployment: result });
      return;
    }

    if (method === "GET" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "domain-zones" && parts[2]) {
      // The active zones of the account, by name only: «Collega anche www» shows for a zone's main domain (voce 230).
      const site = requireSite(parts[2]);
      const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
      const client = await cloudflareClientFromStore(cloudflareStore);
      const zones = await client.listZones(target.accountId);
      sendJson(response, 200, { zones: zones.filter((zone) => zone.status === undefined || zone.status === "active").map((zone) => zone.name.toLowerCase()) });
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "domain-check" && parts[2]) {
      const body = await readJson(request, 64 * 1024);
      if (typeof body.hostname !== "string") throw new HistosPublishError("Inserisci il dominio da controllare.", "cloudflare-domain-invalid", 2);
      const site = requireSite(parts[2]);
      const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
      const client = await cloudflareClientFromStore(cloudflareStore);
      const result = await inspectCustomDomain({
        client,
        accountId: target.accountId,
        script: target.script,
        hostname: body.hostname,
        includeWww: body.includeWww === true,
      });
      sendJson(response, 200, {
        hostname: result.hostname,
        hostnames: result.hostnames,
        zone: { name: result.zone.name },
        cnameConflicts: result.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied ?? false })),
        workerConflicts: result.workerConflicts,
      });
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "sites" && parts[3] === "domain" && parts[2]) {
      const body = await readJson(request, 64 * 1024);
      if (body.confirmed !== true || typeof body.hostname !== "string") throw new HistosPublishError("Conferma il dominio da collegare prima di proseguire.", "confirmation-required", 2);
      const replaceCnameRecords = body.replaceCnameRecords === undefined ? [] : body.replaceCnameRecords;
      if (!Array.isArray(replaceCnameRecords) || replaceCnameRecords.length > 20 || !replaceCnameRecords.every(isApprovedCnameRecord)) {
        throw new HistosPublishError("La verifica DNS non è più valida. Controlla di nuovo il dominio.", "cloudflare-domain-plan-stale", 2);
      }
      const site = requireSite(parts[2]);
      const target = requireCloudflare(siteSettings(site.config, configuredAccountId(repository)));
      const client = await cloudflareClientFromStore(cloudflareStore);
      const result = await attachCustomDomain({
        client,
        accountId: target.accountId,
        script: target.script,
        hostname: body.hostname,
        includeWww: body.includeWww === true,
        replaceCnameRecords,
      });
      const config = parseSiteConfig({ ...site.config, cloudflare: { ...site.config.cloudflare, ...target, domain: result.hostname } });
      repository.updateSite(site.id, { config });
      sendJson(response, 200, { domain: { hostname: result.hostname, hostnames: result.hostnames, zone: { name: result.zone.name }, replacedCnameRecords: result.replacedCnameRecords } });
      return;
    }

    if (method === "GET" && parts[0] === "api" && parts[1] === "builds" && parts[3] === "report" && parts[2]) {
      const build = repository.getBuild(parts[2]);
      if (!build) throw new HistosPublishError("Versione non trovata.", "build-missing", 404);
      sendJson(response, 200, publicResult(build));
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "builds" && parts[3] === "preview-ticket" && parts[2]) {
      const build = repository.getBuild(parts[2]);
      if (!build?.bundlePath || build.status !== "ready") throw new HistosPublishError("Anteprima disponibile solo per una versione pronta.", "build-not-ready", 2);
      const ticket = randomBytes(32).toString("base64url");
      previews.set(ticket, { buildId: build.id, bundlePath: build.bundlePath, expiresAt: Date.now() + PREVIEW_TTL_MS });
      sendJson(response, 201, { baseUrl: `/__preview/${ticket}/${build.id}/`, expiresInSeconds: PREVIEW_TTL_MS / 1000 });
      return;
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "builds" && parts[3] === "export" && parts[2]) {
      const build = repository.getBuild(parts[2]);
      if (!build?.bundlePath || build.status !== "ready") throw new HistosPublishError("Esporta solo una versione pronta.", "build-not-ready", 2);
      const format = url.searchParams.get("format") ?? "json";
      if (format === "json") {
        const body = Buffer.from(JSON.stringify(publicResult(build), null, 2));
        writeDownload(response, body, "application/json; charset=utf-8", `${cleanFileName(requireSite(build.siteId).name, "report")}-report.json`);
        return;
      }
      if (format === "markdown") {
        const body = Buffer.from(markdownReport(build.result));
        writeDownload(response, body, "text/markdown; charset=utf-8", `${cleanFileName(requireSite(build.siteId).name, "report")}-report.md`);
        return;
      }
      if (format === "zip") {
        const archivePath = path.join(dataDirectory, "exports", `${randomUUID()}.zip`);
        await mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
        try {
          await exportBundle(build.bundlePath, archivePath);
          const archiveInfo = await stat(archivePath);
          response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(archiveInfo.size), "Content-Disposition": `attachment; filename="${cleanFileName(requireSite(build.siteId).name, "site")}.zip"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          await pipeline(createReadStream(archivePath), response);
        } finally {
          await rm(archivePath, { force: true }).catch(() => undefined);
        }
        return;
      }
      throw new HistosPublishError("Formato di export non supportato.", "export-format-invalid", 2);
    }

    if (method === "GET" && parts.join("/") === "api/cloudflare/accounts") {
      const client = await cloudflareClientFromStore(cloudflareStore);
      sendJson(response, 200, { accounts: await client.listAccounts() });
      return;
    }

    if (method === "GET" && parts.join("/") === "api/database-connections") {
      sendJson(response, 200, { connections: storedDatabaseConnections(repository) });
      return;
    }

    if (method === "POST" && parts.join("/") === "api/database-connections/ssh-hostkey") {
      const body = await readJson(request, 8 * 1024);
      const hostKeyFingerprint = await readDatabaseSshHostFingerprint(body);
      sendJson(response, 200, { hostKeyFingerprint });
      return;
    }

    if (method === "POST" && parts.join("/") === "api/database-connections") {
      const body = await readJson(request, 96 * 1024);
      const input = parseDatabaseConnectionInput(body);
      const probe = await (options.databaseProbe ?? probeDatabaseConnection)(input);
      const id = randomUUID();
      const profile = storedDatabaseConnection(input, probe, id);
      const secretStore = storeFor(`database-${id}`, secretFactory);
      await secretStore.set(JSON.stringify({ username: input.username, password: input.password, caCertificate: input.caCertificate, ...(input.sshTunnel ? { sshTunnel: input.sshTunnel } : {}) }));
      try {
        repository.setSetting("databaseConnections", [...storedDatabaseConnections(repository), profile]);
      } catch (error) {
        await secretStore.delete().catch(() => undefined);
        throw error;
      }
      sendJson(response, 201, { connection: profile });
      return;
    }

    const databaseConnectionId = parts[0] === "api" && parts[1] === "database-connections" && parts.length === 3 ? parts[2] : null;
    const databaseConnectionProbe = parts[0] === "api" && parts[1] === "database-connections" && parts.length === 4 && parts[3] === "probe" ? parts[2] : null;
    if (databaseConnectionId && method === "PUT") {
      const connections = storedDatabaseConnections(repository);
      const existing = connections.find((item) => item.id === databaseConnectionId);
      if (!existing) throw new HistosPublishError("Connessione database non trovata.", "database-connection-missing", 2);
      const input = parseDatabaseConnectionInput(await readJson(request, 96 * 1024));
      const probe = await (options.databaseProbe ?? probeDatabaseConnection)(input);
      const updated = storedDatabaseConnection(input, probe, existing.id, existing.createdAt);
      const secretStore = storeFor(`database-${existing.id}`, secretFactory);
      const previousSecret = await secretStore.get();
      await secretStore.set(JSON.stringify({ username: input.username, password: input.password, caCertificate: input.caCertificate, ...(input.sshTunnel ? { sshTunnel: input.sshTunnel } : {}) }));
      try {
        repository.setSetting("databaseConnections", connections.map((item) => item.id === existing.id ? updated : item));
      } catch (error) {
        if (previousSecret === null) await secretStore.delete().catch(() => undefined);
        else await secretStore.set(previousSecret).catch(() => undefined);
        throw error;
      }
      sendJson(response, 200, { connection: updated });
      return;
    }
    if (databaseConnectionProbe && method === "POST") {
      const connection = storedDatabaseConnections(repository).find((item) => item.id === databaseConnectionProbe);
      if (!connection) throw new HistosPublishError("Connessione database non trovata.", "database-connection-missing", 2);
      const secret = await storeFor(`database-${connection.id}`, secretFactory).get();
      if (!secret) throw new HistosPublishError("Credenziali database non disponibili nel portachiavi locale. Reinserisci la connessione.", "database-secret-missing", 2);
      let credentials: unknown;
      try { credentials = JSON.parse(secret); }
      catch { throw new HistosPublishError("Le credenziali database nel portachiavi non sono valide. Reinserisci la connessione.", "database-secret-invalid", 2); }
      const input = parseDatabaseConnectionInput({ ...connection, ...(credentials as Record<string, unknown>) });
      const probe = await (options.databaseProbe ?? probeDatabaseConnection)(input);
      const updated = storedDatabaseConnection(input, probe, connection.id, connection.createdAt);
      repository.setSetting("databaseConnections", storedDatabaseConnections(repository).map((item) => item.id === connection.id ? updated : item));
      sendJson(response, 200, { connection: updated });
      return;
    }
    if (databaseConnectionId && method === "DELETE") {
      const connections = storedDatabaseConnections(repository);
      if (!connections.some((item) => item.id === databaseConnectionId)) throw new HistosPublishError("Connessione database non trovata.", "database-connection-missing", 2);
      await storeFor(`database-${databaseConnectionId}`, secretFactory).delete();
      repository.setSetting("databaseConnections", connections.filter((item) => item.id !== databaseConnectionId));
      sendJson(response, 200, { removed: true });
      return;
    }

    // Doc 27, G3: the provider of «Rifinisci i nomi con un modello», for the whole app (Agente AI).
    if (method === "GET" && parts.join("/") === "api/import-refine") {
      sendJson(response, 200, await refineSettingsView());
      return;
    }
    if (method === "PUT" && parts.join("/") === "api/import-refine") {
      const body = await readJson(request, 16 * 1024);
      const change = parseRefineSettingsChange(body, readRefineSettings(repository.getSetting(REFINE_SETTINGS_KEY)));
      for (const [account, value] of [[REFINE_LOCAL_KEY_ACCOUNT, change.localKey], [REFINE_HAIKU_KEY_ACCOUNT, change.haikuKey]] as const) {
        if (value === null) await storeFor(account, secretFactory).delete();
        else if (value !== undefined) await storeFor(account, secretFactory).set(value);
      }
      repository.setSetting(REFINE_SETTINGS_KEY, change.settings);
      sendJson(response, 200, await refineSettingsView());
      return;
    }

    if (method === "GET" && parts.join("/") === "api/settings") {
      const token = await tokenConfigured(cloudflareStore);
      sendJson(response, 200, {
        accountId: configuredAccountId(repository),
        language: repository.getSetting<string>("language") ?? "it",
        dataDirectory,
        token,
      });
      return;
    }

    if (method === "POST" && parts.join("/") === "api/settings") {
      const body = await readJson(request, 64 * 1024);
      if (typeof body.accountId === "string" && body.accountId !== "" && !/^[0-9a-f]{32}$/iu.test(body.accountId)) throw new HistosPublishError("L’ID account deve contenere 32 caratteri esadecimali.", "cloudflare-config", 2);
      if (typeof body.accountId === "string") repository.setSetting("cloudflareAccountId", body.accountId);
      if (body.language === "it" || body.language === "en") repository.setSetting("language", body.language);
      sendJson(response, 200, await settingsResult(repository, dataDirectory, cloudflareStore));
      return;
    }

    if (parts.join("/") === "api/settings/copies" && method === "GET") {
      sendJson(response, 200, { folder: repository.getSetting<string>("copiesOutsideFolder") ?? "", check: repository.getSetting("copiesOutsideCheck") ?? null });
      return;
    }
    if (parts.join("/") === "api/settings/copies/check" && method === "POST") {
      const folder = repository.getSetting<string>("copiesOutsideFolder");
      const passphrase = folder ? await storeFor("copies-outside", secretFactory).get() : null;
      if (!folder || !passphrase) throw new HistosPublishError("Le copie cifrate non sono attive.", "copies-check-off", 409);
      const check = { result: await checkOutsideCopy({ folder, passphrase }), at: new Date().toISOString() };
      repository.setSetting("copiesOutsideCheck", check);
      sendJson(response, 200, { check });
      return;
    }
    if (parts.join("/") === "api/settings/copies" && method === "PUT") {
      const body = await readJson(request, 16 * 1024);
      const folder = typeof body.folder === "string" ? body.folder.trim() : "";
      if (!folder) {
        repository.setSetting("copiesOutsideFolder", "");
        repository.setSetting("copiesOutsideCheck", null);
        await storeFor("copies-outside", secretFactory).delete();
        sendJson(response, 200, { folder: "" });
        return;
      }
      if (!path.isAbsolute(folder) || !(await stat(folder).then((found) => found.isDirectory(), () => false))) throw new HistosPublishError("Scegli una cartella che esiste.", "copies-folder-invalid", 400);
      if (typeof body.passphrase !== "string" || body.passphrase.length < 12 || body.passphrase.length > 1024) throw new HistosPublishError("La frase deve avere almeno 12 caratteri.", "copies-passphrase-invalid", 400);
      await storeFor("copies-outside", secretFactory).set(body.passphrase);
      repository.setSetting("copiesOutsideFolder", folder);
      sendJson(response, 200, { folder });
      return;
    }
    if (parts.join("/") === "api/settings/copies/open" && method === "POST") {
      const body = await readJson(request, OPEN_COPY_BODY_MAX_BYTES);
      if (typeof body.copy !== "string" || typeof body.passphrase !== "string") throw new HistosPublishError("Serve il file e la sua frase.", "copies-open-invalid", 400);
      try {
        sendJson(response, 200, { archive: (await openSealedCopy(Buffer.from(body.copy, "base64"), body.passphrase)).toString("base64") });
      } catch (error) {
        throw new HistosPublishError(error instanceof Error ? error.message : "Copia non valida.", "copies-open-invalid", 400);
      }
      return;
    }
    if (method === "POST" && parts.join("/") === "api/settings/cloudflare-token") {
      const body = await readJson(request, 16 * 1024);
      if (process.env.HISTOS_CLOUDFLARE_API_TOKEN?.trim()) throw new HistosPublishError("Il token arriva dalla variabile d’ambiente e non può essere modificato dalla UI.", "token-environment-readonly", 2);
      if (typeof body.token !== "string" || body.token.trim().length < 20 || body.token.length > 4096) throw new HistosPublishError("Inserisci un token Cloudflare valido.", "cloudflare-auth-missing", 2);
      const requestedAccountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
      const accountId = requestedAccountId || repository.getSetting<string>("cloudflareAccountId")?.trim() || "";
      if (accountId && !/^[0-9a-f]{32}$/iu.test(accountId)) throw new HistosPublishError("L’ID account deve contenere 32 caratteri esadecimali.", "cloudflare-config", 2);
      const client = cloudflareClient(body.token.trim());
      const verification = await client.verifyToken(accountId || undefined);
      if (verification.status !== "active") throw new HistosPublishError("Cloudflare non ha attivato questo token.", "cloudflare-auth-invalid", 4);
      await cloudflareStore.set(body.token.trim());
      if (accountId) repository.setSetting("cloudflareAccountId", accountId);
      sendJson(response, 200, { token: { configured: true, source: "keyring", available: true }, status: "active", accountOwned: verification.accountOwned ?? false, accountId: accountId || null });
      return;
    }

    if (method === "DELETE" && parts.join("/") === "api/settings/cloudflare-token") {
      if (!process.env.HISTOS_CLOUDFLARE_API_TOKEN?.trim()) await cloudflareStore.delete();
      sendJson(response, 200, { token: await tokenConfigured(cloudflareStore) });
      return;
    }

    const siteCredentials = parts[0] === "api" && parts[1] === "sites" && parts[3] === "credentials" && parts[2];
    if (siteCredentials && parts.length === 4 && parts[2] && method === "GET") {
      requireSite(parts[2]);
      sendJson(response, 200, { configured: repository.getSetting<boolean>(`wpCredentials:${parts[2]}`) ?? false });
      return;
    }
    if (siteCredentials && parts.length === 4 && parts[2] && method === "POST") {
      const site = requireSite(parts[2]);
      const body = await readJson(request, 32 * 1024);
      const credentials = cleanCredentials(body);
      if (!credentials || Object.values(credentials).every((value) => !value)) throw new HistosPublishError("Inserisci almeno una credenziale o un cookie.", "credentials-invalid", 2);
      await storeFor(`wordpress-${site.id}`, secretFactory).set(JSON.stringify(credentials));
      repository.setSetting(`wpCredentials:${site.id}`, true);
      sendJson(response, 200, { configured: true });
      return;
    }
    if (siteCredentials && parts.length === 4 && parts[2] && method === "DELETE") {
      const site = requireSite(parts[2]);
      await storeFor(`wordpress-${site.id}`, secretFactory).delete();
      repository.setSetting(`wpCredentials:${site.id}`, false);
      sendJson(response, 200, { configured: false });
      return;
    }

    const turnstileSecretRoute = parts[0] === "api" && parts[1] === "sites" && parts[3] === "turnstile-secret" && parts[2];
    if (turnstileSecretRoute && parts.length === 4 && parts[2] && method === "POST") {
      const site = requireSite(parts[2]);
      if (!site.config.forms?.wordpress || !site.config.cloudflare?.script) throw new HistosPublishError("Salva prima la configurazione di Fluent Forms e il nome Worker.", "forms-config-missing", 2);
      const body = await readJson(request, 16 * 1024);
      if (typeof body.secret !== "string" || body.secret.length < 16 || body.secret.length > 4096 || /[\r\n\0]/u.test(body.secret)) throw new HistosPublishError("Inserisci una chiave segreta Turnstile valida.", "forms-secret-invalid", 2);
      await storeFor(turnstileSecretAccount(site.config.cloudflare.script), secretFactory).set(body.secret);
      repository.setSetting(`turnstileSecret:${site.id}`, true);
      sendJson(response, 200, { configured: true });
      return;
    }
    if (turnstileSecretRoute && parts.length === 4 && parts[2] && method === "DELETE") {
      const site = requireSite(parts[2]);
      if (site.config.cloudflare?.script) await storeFor(turnstileSecretAccount(site.config.cloudflare.script), secretFactory).delete();
      repository.setSetting(`turnstileSecret:${site.id}`, false);
      sendJson(response, 200, { configured: false });
      return;
    }

    const staticHostingRoute = parts[0] === "api" && parts[1] === "sites" && parts[3] === "hosting" && parts[2];
    const collectWordPressPreflight = async (siteId: string, databaseConnectionId: string) => {
      const destination = resolveCmsDestination({ destinationId: `wordpress-new:${siteId}`, databaseConnectionId });
      if (destination.kind !== "wordpress-new") throw new HistosPublishError("La destinazione non è configurata per installare un nuovo WordPress.", "cms-destination-kind-mismatch", 409);
      const site = requireSite(siteId);
      if (!site.config.hosting) throw new HistosPublishError("Configura e verifica prima la destinazione hosting del sito.", "hosting-config-missing", 409);
      const settings = parseStaticHostingSettings(site.config.hosting);
      const hostingCredentials = await readStaticHostingCredentials(site, secretFactory, repository);
      const connection = storedDatabaseConnections(repository).find((item) => item.id === databaseConnectionId);
      if (!connection) throw new HistosPublishError("Scegli una connessione database salvata e verificata.", "database-connection-missing", 404);
      const savedDatabaseSecret = await storeFor(`database-${connection.id}`, secretFactory).get();
      if (!savedDatabaseSecret) throw new HistosPublishError("Credenziali database non disponibili nel portachiavi locale. Reinserisci la connessione.", "database-secret-missing", 404);
      let databaseCredentials: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(savedDatabaseSecret);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-secret");
        databaseCredentials = parsed as Record<string, unknown>;
      } catch {
        throw new HistosPublishError("Credenziali database nel portachiavi non valide. Reinserisci la connessione.", "database-secret-invalid", 2);
      }
      const input = parseDatabaseConnectionInput({
        name: connection.name,
        host: connection.host,
        port: connection.port,
        databaseName: connection.databaseName,
        tablePrefix: connection.tablePrefix,
        username: databaseCredentials.username,
        password: databaseCredentials.password,
        caCertificate: databaseCredentials.caCertificate,
        ...(databaseCredentials.sshTunnel ? { sshTunnel: databaseCredentials.sshTunnel } : {}),
      });
      const probe = await (options.databaseProbe ?? probeDatabaseConnection)(input);
      const updatedConnection = storedDatabaseConnection(input, probe, connection.id, connection.createdAt);
      repository.setSetting("databaseConnections", storedDatabaseConnections(repository).map((item) => item.id === connection.id ? updatedConnection : item));
      const directory = await (options.hostingDirectoryInspection ?? inspectStaticHostingDirectory)(settings, hostingCredentials);
      const databaseEmpty = probe.tableCount === 0 && probe.prefixTableCount === 0;
      const databaseVersionSupported = wordpressDatabaseVersionSupported(probe.engine, probe.serverVersion);
      const databasePrivilegesReady = probe.privilegesVerified && probe.missingPrivileges.length === 0;
      const httpsConfigured = Boolean(settings.publicUrl && new URL(settings.publicUrl).protocol === "https:");
      const checksPassed = directory.isEmpty && databaseEmpty && databaseVersionSupported && databasePrivilegesReady && httpsConfigured;
      const runtimeDatabase = { host: input.host, port: input.port, databaseName: input.databaseName, tablePrefix: input.tablePrefix, username: input.username, password: input.password, caCertificate: input.caCertificate };
      return { settings, hostingCredentials, runtimeDatabase, updatedConnection, directory, databaseEmpty, databaseVersionSupported, databasePrivilegesReady, httpsConfigured, checksPassed };
    };
    const wordPressPreflightResponse = (state: Awaited<ReturnType<typeof collectWordPressPreflight>>, status: "blocked" | "awaiting-php-check" | "ready-for-install", runtime: {
      phpChecked: boolean; phpVersion: string | null; phpSupported: boolean; phpRecommended: boolean; missingRequiredExtensions: string[]; missingRecommendedExtensions: string[]; httpsAvailable: boolean; httpsConfigured: boolean;
      databaseTlsVerified: boolean; databaseTlsFailure: string | null;
      wordpressMinimumPhp: ">= 7.4"; requiredPhp: ">= 8.3"; recommendedPhp: ">= 8.4"; status: "not-checked" | "supported" | "unsupported";
    }) => ({
      status,
      canInstall: false,
      filesystem: { readable: true, empty: state.directory.isEmpty, entryCount: state.directory.entryCount, wordpressSignals: state.directory.wordpressSignals },
      database: {
        id: state.updatedConnection.id,
        name: state.updatedConnection.name,
        engine: state.updatedConnection.engine,
        serverVersion: state.updatedConnection.serverVersion,
        versionSupported: state.databaseVersionSupported,
        tableCount: state.updatedConnection.tableCount,
        prefixTableCount: state.updatedConnection.prefixTableCount,
        empty: state.databaseEmpty,
        privilegesVerified: state.updatedConnection.privilegesVerified,
        grantedPrivileges: state.updatedConnection.grantedPrivileges,
        missingPrivileges: state.updatedConnection.missingPrivileges,
      },
      runtime,
    });
    const provisionDeps = options.wordpressProvisioning ?? {};
    const pluginArchivePath = process.env.HISTOS_PUBLISH_WORDPRESS_PLUGIN_PATH?.trim()
      || path.resolve(SERVER_DIRECTORY, "../../desktop/dist/histos-wordpress-plugin.zip");
    const provisionPackageDirectory = (planId: string) => path.join(dataDirectory, "wordpress-provision", planId);
    const cleanupProvisionPackage = async (planId: string) => {
      await rm(provisionPackageDirectory(planId), { recursive: true, force: true }).catch(() => undefined);
    };
    const cleanupProvisionSecret = async (planId: string) => {
      await storeFor(`wordpress-provision-${planId}`, secretFactory).delete().catch(() => undefined);
    };
    const expireProvisionPlans = async () => {
      for (const planId of wordpressProvisionCatalog.expirePending()) {
        await cleanupProvisionSecret(planId);
        await cleanupProvisionPackage(planId);
      }
    };
    const targetSnapshot = (settings: StaticHostingSettings, credentials: StaticHostingCredentials, publicUrl: string): WordPressProvisionSnapshot["target"] => ({
      protocol: settings.protocol,
      host: settings.host,
      port: settings.port,
      remoteDirectory: settings.remoteDirectory,
      publicUrl,
      username: credentials.username,
      ...(settings.allowInsecureFtp ? { allowInsecureFtp: true } : {}),
      ...(settings.tlsCaCertificate ? { tlsCaCertificate: settings.tlsCaCertificate } : {}),
      ...(settings.authMethod ? { authMethod: settings.authMethod } : {}),
      ...(settings.hostKeyFingerprint ? { hostKeyFingerprint: settings.hostKeyFingerprint } : {}),
    });
    const assertProvisionPlanMatches = (plan: NonNullable<ReturnType<WordPressProvisionCatalog["get"]>>, state: Awaited<ReturnType<typeof collectWordPressPreflight>>) => {
      const publicUrl = state.settings.publicUrl;
      if (!publicUrl || JSON.stringify(targetSnapshot(state.settings, state.hostingCredentials, publicUrl)) !== JSON.stringify(plan.snapshot.target)) {
        throw new HistosPublishError("La destinazione hosting è cambiata dopo il piano. Verifica di nuovo il sito e prepara un nuovo piano.", "wordpress-provision-target-changed", 409);
      }
      const database = state.updatedConnection;
      if (database.id !== plan.snapshot.database.id || database.host !== plan.snapshot.database.host || database.port !== plan.snapshot.database.port || database.databaseName !== plan.snapshot.database.databaseName || database.tablePrefix !== plan.snapshot.database.tablePrefix || database.engine !== plan.snapshot.database.engine || database.serverVersion !== plan.snapshot.database.serverVersion) {
        throw new HistosPublishError("La connessione al database è cambiata dopo il piano. Verifica di nuovo il database e prepara un nuovo piano.", "wordpress-provision-database-changed", 409);
      }
    };
    const bootstrapRemote = async (plan: NonNullable<ReturnType<WordPressProvisionCatalog["get"]>>, state: Awaited<ReturnType<typeof collectWordPressPreflight>>, mode: "install" | "recover", payload: Record<string, unknown>) => {
      const nonce = randomBytes(32).toString("hex");
      const fileName = `histos-provision-${randomUUID().replaceAll("-", "")}.php`;
      const expiresAt = Math.floor(Date.now() / 1000) + 120;
      let publicUrl: URL;
      try { publicUrl = new URL(state.settings.publicUrl ?? ""); }
      catch { throw new HistosPublishError("L’indirizzo HTTPS del sito non è più valido.", "wordpress-provision-url-invalid", 409); }
      if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new HistosPublishError("Il provisioner richiede l’URL HTTPS pulito del sito.", "wordpress-provision-https-required", 409);
      publicUrl.search = "";
      publicUrl.hash = "";
      if (!publicUrl.pathname.endsWith("/")) publicUrl.pathname += "/";
      const endpoint = new URL(fileName, publicUrl);
      const fileBytes = buildWordPressProvisionBootstrap(plan.snapshot.id, nonce, expiresAt, mode);
      const temporaryFile = provisionDeps.withTemporaryFile ?? withTemporaryStaticHostingFile;
      const postJson = provisionDeps.postJson ?? postWordPressProvisionJson;
      const response = await temporaryFile({
        settings: state.settings,
        credentials: state.hostingCredentials,
        fileName,
        bytes: fileBytes,
        run: () => postJson(endpoint, { ...payload, mode, planId: plan.snapshot.id, nonce }),
      });
      return parseWordPressProvisionBootstrapResponse(response.status, response.contentType, response.body, plan.snapshot.id, mode);
    };
    const connectProvisionedSite = async (pairingCode: string, planId: string) => (provisionDeps.connectRemote ?? connectRemoteSite)(pairingCode, cmsRemoteCatalog, (account) => storeFor(account, secretFactory), wordpressProvisionConnectionId(planId));
    const completeProvisionPlan = async (plan: NonNullable<ReturnType<WordPressProvisionCatalog["get"]>>, bootstrap: Awaited<ReturnType<typeof bootstrapRemote>>) => {
      const connection = await connectProvisionedSite(bootstrap.pairingCode, plan.snapshot.id);
      const result = { wordpressVersion: bootstrap.wordpressVersion, histosVersion: plan.snapshot.histos.version, connectionId: connection.id, siteUrl: bootstrap.siteUrl };
      wordpressProvisionCatalog.setState(plan.snapshot.id, "complete", "complete", null, result);
      await cleanupProvisionSecret(plan.snapshot.id);
      await cleanupProvisionPackage(plan.snapshot.id);
      return wordpressProvisionCatalog.get(plan.snapshot.id)!;
    };
    const runProvisionRecovery = async (plan: NonNullable<ReturnType<WordPressProvisionCatalog["get"]>>) => {
      const site = requireSite(plan.snapshot.siteId);
      const destination = resolveCmsDestination({ destinationId: `wordpress-new:${site.id}`, databaseConnectionId: plan.snapshot.database.id });
      if (destination.kind !== "wordpress-new") throw new HistosPublishError("Il piano non punta a un nuovo WordPress valido.", "cms-destination-kind-mismatch", 409);
      if (!site.config.hosting) throw new HistosPublishError("La configurazione hosting del sito è stata rimossa. Ripristinala per recuperare il piano.", "wordpress-provision-hosting-missing", 409);
      const settings = parseStaticHostingSettings(site.config.hosting);
      const credentials = await readStaticHostingCredentials(site, secretFactory, repository);
      const publicUrl = settings.publicUrl;
      if (!publicUrl || JSON.stringify(targetSnapshot(settings, credentials, publicUrl)) !== JSON.stringify(plan.snapshot.target)) throw new HistosPublishError("La destinazione hosting è cambiata. Ripristina il target salvato nel piano per completare il recupero.", "wordpress-provision-target-changed", 409);
      const state = {
        settings,
        hostingCredentials: credentials,
        runtimeDatabase: { host: plan.snapshot.database.host, port: plan.snapshot.database.port, databaseName: plan.snapshot.database.databaseName, tablePrefix: plan.snapshot.database.tablePrefix, username: "", password: "", caCertificate: "" },
        updatedConnection: storedDatabaseConnections(repository).find((item) => item.id === plan.snapshot.database.id)!,
        directory: { entryCount: 0, isEmpty: false, wordpressSignals: ["recovering-installed-site"], remoteFiles: [], remoteInventoryComplete: false },
        databaseEmpty: false,
        databaseVersionSupported: true,
        databasePrivilegesReady: true,
        httpsConfigured: true,
        checksPassed: true,
      };
      if (!state.updatedConnection) throw new HistosPublishError("La connessione database del piano è stata rimossa. Mantieni le impostazioni originali per recuperare l’installazione.", "wordpress-provision-database-missing", 409);
      const recovery = await bootstrapRemote(plan, state, "recover", {});
      if (recovery.wordpressVersion !== plan.snapshot.wordpress.version || recovery.siteUrl !== plan.snapshot.target.publicUrl.replace(/\/$/u, "")) throw new HistosPublishError("WordPress risponde, ma versione o indirizzo non coincidono con il piano.", "wordpress-provision-recovery-mismatch", 409);
      return completeProvisionPlan(plan, recovery);
    };
    if (staticHostingRoute && parts.length === 5 && parts[2] && parts[4] === "wordpress-install" && method === "GET") {
      const site = requireSite(parts[2]);
      await expireProvisionPlans();
      sendJson(response, 200, { plans: wordpressProvisionCatalog.list(site.id).map((plan) => wordpressProvisionPublic(plan)) });
      return;
    }
    if (staticHostingRoute && parts.length === 5 && parts[2] && parts[4] === "wordpress-install" && method === "POST") {
      const site = requireSite(parts[2]);
      const input = parseWordPressProvisionInput(await readJson(request, 16 * 1024));
      const state = await collectWordPressPreflight(site.id, input.databaseConnectionId);
      if (!state.checksPassed) throw new HistosPublishError("Il piano non è pronto: la directory deve essere vuota, il database deve essere vuoto, i privilegi devono bastare e l’indirizzo deve usare HTTPS.", "wordpress-provision-preflight-blocked", 409);
      const runtime = await (options.wordpressRuntimeProbe ?? probeWordPressPhpRuntime)({ settings: state.settings, credentials: state.hostingCredentials, database: state.runtimeDatabase });
      if (!runtime.phpSupported || !runtime.databaseTlsVerified || !runtime.httpsAvailable) throw new HistosPublishError("Il runtime PHP o la connessione TLS del database non soddisfano i requisiti di Histeon. Non ho modificato il target.", "wordpress-provision-runtime-blocked", 409);
      const core = await (provisionDeps.downloadCore ?? downloadVerifiedWordPressCore)();
      if (!versionAtLeast(runtime.phpVersion, core.phpMinimum) || !versionAtLeast(state.updatedConnection.serverVersion, core.mysqlMinimum)) throw new HistosPublishError("La versione di PHP o MySQL del server non soddisfa i requisiti dichiarati dalla release WordPress corrente.", "wordpress-provision-release-requirement-blocked", 409);
      const histos = await (provisionDeps.loadHistosPlugin ?? readVerifiedHistosPluginRelease)(pluginArchivePath);
      if (!versionAtLeast(runtime.phpVersion, histos.phpMinimum) || !versionAtLeast(core.version, histos.wordpressMinimum)) throw new HistosPublishError(`La release Histeon ${histos.version} richiede WordPress ${histos.wordpressMinimum} e PHP ${histos.phpMinimum}. Il target non è compatibile con questa coppia di release.`, "wordpress-provision-histos-requirement-blocked", 409);
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
      const packageDirectory = provisionPackageDirectory(id);
      let snapshotArtifacts: Awaited<ReturnType<typeof persistWordPressProvisionArtifacts>>;
      try {
        snapshotArtifacts = await persistWordPressProvisionArtifacts(packageDirectory, core, histos);
      } catch (error) {
        await cleanupProvisionPackage(id);
        throw error;
      }
      const publicUrl = state.settings.publicUrl;
      if (!publicUrl) {
        await cleanupProvisionPackage(id);
        throw new HistosPublishError("Inserisci un URL HTTPS pubblico prima di preparare l’installazione.", "wordpress-provision-https-required", 409);
      }
      const dropInHash = createHash("sha256").update(buildWordPressDatabaseTlsDropIn(state.runtimeDatabase.caCertificate)).digest("hex");
      const snapshot: WordPressProvisionSnapshot = {
        id,
        siteId: site.id,
        databaseConnectionId: state.updatedConnection.id,
        createdAt: now.toISOString(),
        expiresAt,
        siteTitle: input.siteTitle,
        adminUsername: input.adminUsername,
        adminEmail: input.adminEmail,
        locale: "en_US",
        target: targetSnapshot(state.settings, state.hostingCredentials, publicUrl),
        database: {
          id: state.updatedConnection.id,
          name: state.updatedConnection.name,
          host: state.updatedConnection.host,
          port: state.updatedConnection.port,
          databaseName: state.updatedConnection.databaseName,
          tablePrefix: state.updatedConnection.tablePrefix,
          engine: state.updatedConnection.engine,
          serverVersion: state.updatedConnection.serverVersion,
        },
        wordpress: snapshotArtifacts.wordpress,
        histos: { ...snapshotArtifacts.histos, wordpressMinimum: histos.wordpressMinimum, phpMinimum: histos.phpMinimum },
        databaseDropInSha256: dropInHash,
      };
      const provisionSecret = storeFor(`wordpress-provision-${id}`, secretFactory);
      try {
        await provisionSecret.set(JSON.stringify({ username: input.adminUsername, email: input.adminEmail, password: input.adminPassword }));
        const plan = wordpressProvisionCatalog.create(snapshot);
        sendJson(response, 201, { plan: wordpressProvisionPublic(plan) });
      } catch (error) {
        await provisionSecret.delete().catch(() => undefined);
        await cleanupProvisionPackage(id);
        throw error;
      }
      return;
    }
    if (staticHostingRoute && parts.length === 6 && parts[2] && parts[4] === "wordpress-install" && parts[5] && method === "GET") {
      const site = requireSite(parts[2]);
      const plan = wordpressProvisionCatalog.get(parts[5]);
      if (!plan || plan.snapshot.siteId !== site.id) throw new HistosPublishError("Piano di installazione WordPress non trovato.", "wordpress-provision-plan-missing", 404);
      sendJson(response, 200, { plan: wordpressProvisionPublic(plan) });
      return;
    }
    if (staticHostingRoute && parts.length === 7 && parts[2] && parts[4] === "wordpress-install" && parts[5] && parts[6] === "apply" && method === "POST") {
      const site = requireSite(parts[2]);
      const planId = parts[5];
      let plan = wordpressProvisionCatalog.get(planId);
      if (!plan || plan.snapshot.siteId !== site.id) throw new HistosPublishError("Piano di installazione WordPress non trovato.", "wordpress-provision-plan-missing", 404);
      if (plan.state === "complete") { sendJson(response, 200, { plan: wordpressProvisionPublic(plan) }); return; }
      if (plan.state === "blocked" || plan.state === "expired") throw new HistosPublishError("Questo piano non è più applicabile. Prepara un nuovo piano dopo aver verificato la destinazione.", "wordpress-provision-plan-not-applicable", 409);
      if (activeProvisionPlans.has(planId)) throw new HistosPublishError("L’installazione WordPress è già in corso per questo piano.", "wordpress-provision-already-running", 409);
      activeProvisionPlans.add(planId);
      let remoteWriteStarted = plan.state !== "planned";
      let claimed = false;
      try {
        if (plan.state !== "planned") {
          if (!wordpressProvisionCatalog.claimRecovery(planId)) throw new HistosPublishError("Un altro controllo di recupero è già in corso per questo piano. Aggiorna lo stato fra poco.", "wordpress-provision-recovery-already-running", 409);
          claimed = true;
          plan = wordpressProvisionCatalog.get(planId)!;
          const recovered = await runProvisionRecovery(plan);
          sendJson(response, 200, { plan: wordpressProvisionPublic(recovered) });
          return;
        }
        if (!wordpressProvisionCatalog.claim(planId)) throw new HistosPublishError("Il piano è già stato avviato o modificato. Ricarica lo stato prima di continuare.", "wordpress-provision-plan-state-changed", 409);
        claimed = true;
        plan = wordpressProvisionCatalog.get(planId)!;
        if (Date.parse(plan.snapshot.expiresAt) <= Date.now()) {
          wordpressProvisionCatalog.setState(planId, "expired", "expired", "wordpress-provision-plan-expired");
          await cleanupProvisionSecret(planId);
          await cleanupProvisionPackage(planId);
          throw new HistosPublishError("Il piano è scaduto. Prepara un nuovo piano prima di installare.", "wordpress-provision-plan-expired", 409);
        }
        const secretRaw = await storeFor(`wordpress-provision-${planId}`, secretFactory).get();
        if (!secretRaw) throw new HistosPublishError("Le credenziali amministratore non sono più nel portachiavi. Prepara di nuovo il piano.", "wordpress-provision-secret-missing", 409);
        let admin: { username: string; email: string; password: string };
        try {
          const parsed: unknown = JSON.parse(secretRaw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-secret");
          const fields = parsed as Record<string, unknown>;
          if (fields.username !== plan.snapshot.adminUsername || fields.email !== plan.snapshot.adminEmail || typeof fields.password !== "string" || fields.password.length < 14) throw new Error("invalid-secret");
          admin = { username: fields.username as string, email: fields.email as string, password: fields.password };
        } catch {
          throw new HistosPublishError("Le credenziali amministratore salvate per questo piano non sono valide.", "wordpress-provision-secret-invalid", 409);
        }
        const state = await collectWordPressPreflight(site.id, plan.snapshot.databaseConnectionId);
        assertProvisionPlanMatches(plan, state);
        if (!state.checksPassed) throw new HistosPublishError("Directory o database non sono più vuoti, oppure i controlli di installazione non sono più validi. Non ho caricato file.", "wordpress-provision-preflight-stale", 409);
        const runtime = await (options.wordpressRuntimeProbe ?? probeWordPressPhpRuntime)({ settings: state.settings, credentials: state.hostingCredentials, database: state.runtimeDatabase });
        if (!runtime.phpSupported || !runtime.databaseTlsVerified || !runtime.httpsAvailable || !versionAtLeast(runtime.phpVersion, plan.snapshot.wordpress.phpMinimum) || !versionAtLeast(runtime.phpVersion, plan.snapshot.histos.phpMinimum) || !versionAtLeast(state.updatedConnection.serverVersion, plan.snapshot.wordpress.mysqlMinimum)) throw new HistosPublishError("Il runtime PHP o database non soddisfa più i requisiti esatti del piano WordPress/Histos.", "wordpress-provision-runtime-stale", 409);
        const artifactFiles = await readWordPressProvisionArtifacts(provisionPackageDirectory(planId), plan.snapshot);
        const dbDropIn = buildWordPressDatabaseTlsDropIn(state.runtimeDatabase.caCertificate);
        if (createHash("sha256").update(dbDropIn).digest("hex") !== plan.snapshot.databaseDropInSha256) throw new HistosPublishError("Il profilo TLS del database è cambiato dopo il piano. Prepara nuovamente l’installazione.", "wordpress-provision-db-dropin-stale", 409);
        if (artifactFiles.some((file) => file.path === "wp-content/db.php")) throw new HistosPublishError("Il pacchetto WordPress contiene un percorso che collide con il drop-in TLS.", "wordpress-provision-file-collision", 500);
        artifactFiles.push({ path: "wp-content/db.php", bytes: dbDropIn });
        if (artifactFiles.some((file) => file.path === "wp-config.php")) throw new HistosPublishError("Il pacchetto WordPress contiene già un wp-config.php.", "wordpress-provision-file-collision", 500);
        // First file on the server: WordPress stays closed (503) until this plan's bootstrap configures it.
        artifactFiles.unshift({ path: "wp-config.php", bytes: buildWordPressConfigPlaceholder(planId) });
        const finalCheck = await collectWordPressPreflight(site.id, plan.snapshot.databaseConnectionId);
        assertProvisionPlanMatches(plan, finalCheck);
        if (!finalCheck.checksPassed) throw new HistosPublishError("La directory o il database non sono più vuoti. Non ho iniziato il caricamento.", "wordpress-provision-preflight-stale", 409);
        remoteWriteStarted = true;
        const upload = provisionDeps.uploadFiles ?? uploadStaticHostingFiles;
        await upload({ settings: finalCheck.settings, credentials: finalCheck.hostingCredentials, files: artifactFiles });
        wordpressProvisionCatalog.setState(planId, "installing", "bootstrap");
        const salts = Array.from({ length: 8 }, () => randomBytes(32).toString("hex"));
        const bootstrap = await bootstrapRemote(plan, finalCheck, "install", {
          database: { host: finalCheck.runtimeDatabase.host, port: finalCheck.runtimeDatabase.port, databaseName: finalCheck.runtimeDatabase.databaseName, tablePrefix: finalCheck.runtimeDatabase.tablePrefix, username: finalCheck.runtimeDatabase.username, password: finalCheck.runtimeDatabase.password, caCertificate: finalCheck.runtimeDatabase.caCertificate },
          site: { title: plan.snapshot.siteTitle, url: plan.snapshot.target.publicUrl },
          admin,
          salts,
        });
        if (bootstrap.wordpressVersion !== plan.snapshot.wordpress.version || bootstrap.siteUrl !== plan.snapshot.target.publicUrl.replace(/\/$/u, "")) throw new HistosPublishError("La risposta del nuovo WordPress non coincide con release e URL selezionati nel piano.", "wordpress-provision-install-result-mismatch", 409);
        const completed = await completeProvisionPlan(plan, bootstrap);
        sendJson(response, 200, { plan: wordpressProvisionPublic(completed) });
        return;
      } catch (error) {
        const current = wordpressProvisionCatalog.get(planId);
        if (claimed && current && current.state !== "complete" && current.state !== "expired") {
          const code = error instanceof HistosPublishError && /^[a-z][a-z0-9-]{0,80}$/u.test(error.code) ? error.code : "wordpress-provision-failed";
          if (remoteWriteStarted) wordpressProvisionCatalog.setState(planId, "needs-recovery", "recovery", code);
          else {
            wordpressProvisionCatalog.setState(planId, "blocked", "preflight-blocked", code);
            await cleanupProvisionSecret(planId);
            await cleanupProvisionPackage(planId);
          }
        }
        throw error;
      } finally {
        activeProvisionPlans.delete(planId);
      }
    }
    if (staticHostingRoute && parts.length === 5 && parts[2] && parts[4] === "inspect" && method === "POST") {
      const site = requireSite(parts[2]);
      if (!site.config.hosting) throw new HistosPublishError("Configura e verifica prima la destinazione hosting del sito.", "hosting-config-missing", 409);
      const settings = parseStaticHostingSettings(site.config.hosting);
      const credentials = await readStaticHostingCredentials(site, secretFactory, repository);
      const directory: StaticHostingDirectoryInspection = await (options.hostingDirectoryInspection ?? inspectStaticHostingDirectory)(settings, credentials);
      sendJson(response, 200, { directory });
      return;
    }
    if (staticHostingRoute && parts.length === 5 && parts[2] && parts[4] === "wordpress-preflight" && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      const databaseConnectionId = typeof body.databaseConnectionId === "string" ? body.databaseConnectionId : "";
      const state = await collectWordPressPreflight(parts[2], databaseConnectionId);
      sendJson(response, 200, wordPressPreflightResponse(state, state.checksPassed ? "awaiting-php-check" : "blocked", {
        phpChecked: false,
        phpVersion: null,
        phpSupported: false,
        phpRecommended: false,
        missingRequiredExtensions: [],
        missingRecommendedExtensions: [],
        databaseTlsVerified: false,
        databaseTlsFailure: null,
        httpsAvailable: false,
        httpsConfigured: state.httpsConfigured,
        wordpressMinimumPhp: ">= 7.4",
        requiredPhp: ">= 8.3",
        recommendedPhp: ">= 8.4",
        status: "not-checked",
      }));
      return;
    }
    if (staticHostingRoute && parts.length === 5 && parts[2] && parts[4] === "wordpress-runtime-check" && method === "POST") {
      const body = await readJson(request, 16 * 1024);
      const databaseConnectionId = typeof body.databaseConnectionId === "string" ? body.databaseConnectionId : "";
      const state = await collectWordPressPreflight(parts[2], databaseConnectionId);
      if (!state.checksPassed) {
        sendJson(response, 200, wordPressPreflightResponse(state, "blocked", {
          phpChecked: false,
          phpVersion: null,
          phpSupported: false,
          phpRecommended: false,
          missingRequiredExtensions: [],
          missingRecommendedExtensions: [],
          databaseTlsVerified: false,
          databaseTlsFailure: null,
          httpsAvailable: false,
          httpsConfigured: state.httpsConfigured,
          wordpressMinimumPhp: ">= 7.4",
          requiredPhp: ">= 8.3",
          recommendedPhp: ">= 8.4",
          status: "not-checked",
        }));
        return;
      }
      const runtime = await (options.wordpressRuntimeProbe ?? probeWordPressPhpRuntime)({ settings: state.settings, credentials: state.hostingCredentials, database: state.runtimeDatabase });
      const status = runtime.phpSupported && runtime.databaseTlsVerified ? "ready-for-install" : "blocked";
      sendJson(response, 200, wordPressPreflightResponse(state, status, { ...runtime, httpsConfigured: state.httpsConfigured }));
      return;
    }
    if (staticHostingRoute && parts.length === 4 && parts[2] && method === "POST") {
      const site = requireSite(parts[2]);
      const body = await readJson(request, 256 * 1024);
      let hosting = parseStaticHostingSettings(body.settings);
      const store = storeFor(`hosting-${site.id}`, secretFactory);
      let previous: Partial<StaticHostingCredentials> = {};
      try {
        const raw = await store.get();
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          previous = {
            ...(typeof parsed.username === "string" ? { username: parsed.username } : {}),
            ...(typeof parsed.password === "string" ? { password: parsed.password } : {}),
            ...(typeof parsed.privateKey === "string" ? { privateKey: parsed.privateKey } : {}),
            ...(typeof parsed.passphrase === "string" ? { passphrase: parsed.passphrase } : {}),
            ...(parsed.authMethod === "privateKey" ? { authMethod: "privateKey" } : parsed.authMethod === "password" ? { authMethod: "password" } : {}),
          };
        }
      } catch {
        if (repository.getSetting<boolean>(`hostingCredentials:${site.id}`) ?? false) {
          throw new HistosPublishError("Non riesco a leggere le credenziali hosting dal portachiavi. Reinseriscile.", "keyring-unavailable", 4);
        }
      }
      const username = typeof body.username === "string" && body.username.trim()
        ? body.username.trim()
        : hosting.username ?? previous.username ?? "";
      const authMethod = hosting.protocol === "sftp" && body.authMethod === "privateKey" ? "privateKey" : "password";
      hosting = { ...hosting, ...(hosting.protocol === "sftp" ? { authMethod } : {}) };
      if (!username || username.length > 255 || /[\0\r\n]/u.test(username)) throw new HistosPublishError("Inserisci il nome utente del server.", "hosting-credentials-invalid", 2);
      const keepPrevious = (previous.authMethod ?? "password") === authMethod;
      const credentials: StaticHostingCredentials = { username, authMethod };
      if (authMethod === "privateKey") {
        const submittedKey = typeof body.privateKey === "string" ? body.privateKey : "";
        const privateKey = submittedKey || (keepPrevious ? previous.privateKey ?? "" : "");
        const submittedPassphrase = typeof body.passphrase === "string" ? body.passphrase : "";
        const passphrase = submittedPassphrase || (keepPrevious ? previous.passphrase ?? "" : "");
        if (!privateKey || privateKey.length > 64 * 1024 || privateKey.includes("\0")) throw new HistosPublishError("Incolla una chiave privata SSH valida. La chiave verrà conservata nel portachiavi locale.", "hosting-credentials-invalid", 2);
        if (passphrase.length > 4096 || /[\0\r\n]/u.test(passphrase)) throw new HistosPublishError("La passphrase SSH non è valida.", "hosting-credentials-invalid", 2);
        credentials.privateKey = privateKey;
        if (passphrase) credentials.passphrase = passphrase;
      } else {
        const submittedPassword = typeof body.password === "string" ? body.password : "";
        const password = submittedPassword || (keepPrevious ? previous.password ?? "" : "");
        if (!password || password.length > 4096 || /[\0\r\n]/u.test(password)) {
          const protocol = hosting.protocol === "sftp" ? "SFTP" : "FTP/FTPS";
          throw new HistosPublishError(`Inserisci la password ${protocol}. Le credenziali saranno cifrate nel portachiavi locale.`, "hosting-credentials-invalid", 2);
        }
        credentials.password = password;
      }

      const previousFingerprint = site.config.hosting?.protocol === "sftp" ? site.config.hosting.hostKeyFingerprint ?? "" : "";
      const submittedFingerprint = typeof hosting.hostKeyFingerprint === "string" ? hosting.hostKeyFingerprint : "";
      const explicitlyConfirmed = typeof body.confirmHostKeyFingerprint === "string" && body.confirmHostKeyFingerprint === submittedFingerprint;
      if (hosting.protocol === "sftp" && submittedFingerprint !== previousFingerprint && !explicitlyConfirmed) {
        const { hostKeyFingerprint: _unusedFingerprint, ...untrustedSettings } = hosting;
        const candidate = await (options.hostingConnectionVerification ?? verifyStaticHostingConnection)(untrustedSettings, credentials);
        if ("hostKeyConfirmationRequired" in candidate) {
          sendJson(response, 200, { hostKeyConfirmationRequired: true, hostKeyFingerprint: candidate.hostKeyFingerprint });
          return;
        }
      }
      const verification = await (options.hostingConnectionVerification ?? verifyStaticHostingConnection)(hosting, credentials);
      if ("hostKeyConfirmationRequired" in verification) {
        sendJson(response, 200, { hostKeyConfirmationRequired: true, hostKeyFingerprint: verification.hostKeyFingerprint });
        return;
      }
      if (hosting.protocol === "sftp") {
        if (!verification.hostKeyFingerprint) throw new HistosPublishError("L’impronta SSH verificata non è disponibile.", "hosting-hostkey-unavailable", 2);
        hosting = { ...hosting, hostKeyFingerprint: verification.hostKeyFingerprint };
      }
      const config = parseSiteConfig({
        ...site.config,
        deployTarget: "ftp",
        hosting: { ...hosting, username },
      });
      await store.set(JSON.stringify(credentials));
      repository.setSetting(`hostingCredentials:${site.id}`, true);
      const updated = repository.updateSite(site.id, { config });
      if (!updated) throw new HistosPublishError("Sito non trovato.", "site-missing", 404);
      sendJson(response, 200, { site: safeSite(updated, repository) });
      return;
    }
    if (staticHostingRoute && parts.length === 4 && parts[2] && method === "DELETE") {
      const site = requireSite(parts[2]);
      await storeFor(`hosting-${site.id}`, secretFactory).delete();
      repository.setSetting(`hostingCredentials:${site.id}`, false);
      sendJson(response, 200, { configured: false });
      return;
    }

    // The site's own server code (`_worker.js`), uploaded apart from the HTML: it is kept in the site's folder and
    // enters every build. One file, an ES module with export default { fetch }.
    if (parts[0] === "api" && parts[1] === "sites" && parts[3] === "worker-module" && parts.length === 4 && parts[2] && (method === "PUT" || method === "DELETE")) {
      const site = requireSite(parts[2]);
      if (site.config.source.kind === "cms") throw new HistosPublishError("Questo sito pubblica un progetto Histeon CMS: il codice del Worker si aggiunge ai siti fatti di file.", "cms-site-source-locked", 409);
      const directory = path.join(dataDirectory, "sites", site.id, "worker");
      const target = path.join(directory, SITE_WORKER_PATH);
      const cloudflare: CloudflareSettings = { ...(site.config.cloudflare ?? {}) };
      let foundKv: string[] = [];
      if (method === "PUT") {
        const body = await readJson(request, 4 * 1024 * 1024 + 64 * 1024);
        const name = typeof body.name === "string" ? path.basename(body.name.trim()).slice(0, 255) : "";
        if (!/\.(?:m?js)$/iu.test(name)) throw new HistosPublishError("Scegli un file JavaScript (.js) con il codice del Worker.", "site-worker-invalid", 2);
        if (typeof body.source !== "string") throw new HistosPublishError("Il codice del Worker non è arrivato.", "site-worker-invalid", 2);
        validateSiteWorker(Buffer.from(body.source, "utf8"), name);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, body.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, target);
        cloudflare.workerModule = { path: target, name };
        foundKv = kvBindingsInWorker(body.source);
      } else {
        await rm(target, { force: true });
        delete cloudflare.workerModule;
      }
      const config = parseSiteConfig({ ...site.config, cloudflare });
      if (!repository.updateSite(site.id, { config })) throw new HistosPublishError("Sito non trovato.", "site-missing", 404);
      repository.markSourceUpdated(site.id);
      const kvAdded = await fillKvFromWorker(site.id, foundKv);
      sendJson(response, 200, { site: safeSite(requireSite(site.id), repository), kvAdded });
      return;
    }

    const siteSettingsRoute = parts[0] === "api" && parts[1] === "sites" && parts.length === 3 && parts[2];
    if (siteSettingsRoute && parts[2] && method === "PATCH") {
      const site = requireSite(parts[2]);
      const body = await readJson(request, 64 * 1024);
      const current = siteSettings(site.config, configuredAccountId(repository));
      const accountId = typeof body.accountId === "string" ? body.accountId.trim() : undefined;
      const cloudflare: CloudflareSettings = {
        ...current,
        ...(accountId ? { accountId } : {}),
        ...(typeof body.script === "string" ? { script: body.script } : {}),
        ...(typeof body.domain === "string" ? { domain: body.domain } : {}),
        ...(typeof body.maxFiles === "number" ? { maxFiles: body.maxFiles } : {}),
      };
      if (Array.isArray(body.kv)) {
        const names = validateKvBindingNames(body.kv.filter((name: unknown): name is string => typeof name === "string"));
        if (names.length > 0) cloudflare.kv = names;
        else delete cloudflare.kv;
      }
      if (accountId === "") delete cloudflare.accountId;
      if (typeof body.render === "boolean" && site.config.source.kind !== "url" && body.render) throw new HistosPublishError("La modalità render si applica solo a una sorgente online.", "render-source-invalid", 2);
      if (cloudflare.domain && !isHostname(cloudflare.domain)) throw new HistosPublishError("Inserisci un dominio valido senza schema o percorso.", "cloudflare-domain-invalid", 2);
      if (cloudflare.accountId && !/^[0-9a-f]{32}$/iu.test(cloudflare.accountId)) throw new HistosPublishError("L’ID account deve contenere 32 caratteri esadecimali.", "cloudflare-config", 2);
      if (cloudflare.script && !/^[a-z0-9-]{1,63}$/u.test(cloudflare.script)) throw new HistosPublishError("Il nome Worker può contenere solo lettere minuscole, numeri e trattini.", "cloudflare-config", 2);
      const configInput: Record<string, unknown> = {
        ...site.config,
        name: site.name,
        cloudflare,
        ...(body.deployTarget === "cloudflare" ? { deployTarget: "cloudflare" } : {}),
        ...(typeof body.pagefind === "boolean" ? { pagefind: body.pagefind } : {}),
        ...(typeof body.render === "boolean" ? { crawl: { ...site.config.crawl, render: body.render } } : {}),
      };
      if (body.forms === null) delete configInput.forms;
      else if (body.forms !== undefined) configInput.forms = body.forms;
      const config = parseSiteConfig(configInput);
      const oldScript = site.config.cloudflare?.script;
      const newScript = config.cloudflare?.script;
      if (oldScript && newScript && oldScript !== newScript && (repository.getSetting<boolean>(`turnstileSecret:${site.id}`) ?? false)) {
        const oldStore = storeFor(turnstileSecretAccount(oldScript), secretFactory);
        const currentSecret = await oldStore.get();
        if (!currentSecret) throw new HistosPublishError("La chiave segreta Turnstile non è disponibile per cambiare il nome Worker. Reinseriscila prima nelle impostazioni.", "forms-secret-missing", 2);
        await storeFor(turnstileSecretAccount(newScript), secretFactory).set(currentSecret);
        await oldStore.delete();
      }
      const updated = repository.updateSite(site.id, { config });
      if (!updated) throw new HistosPublishError("Sito non trovato.", "site-missing", 404);
      sendJson(response, 200, { site: safeSite(updated, repository) });
      return;
    }

    throw new HistosPublishError("Percorso API non trovato.", "api-route-missing", 404);
  }

  /**
   * «Fotografa la proposta»: the uploaded proposal, alive, for the app's sealed frame. It is the only thing the
   * capture origin serves (a port of its own: the proposal's scripts get an origin that is not the app's). One address
   * per ticket and nothing under it; the page's policy (proposal-frame.ts) keeps its scripts away from the network.
   */
  let captureOrigin = "";
  let proposalFrameAncestors: string[] = [];
  async function handleProposalFrame(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (captureOrigin === "" || `http://${request.headers.host?.toLowerCase() ?? ""}` !== captureOrigin) throw new HistosPublishError("Host non consentito.", "preview-missing", 404);
    const url = new URL(request.url ?? "/", captureOrigin);
    if (request.method !== "GET" && request.method !== "HEAD") throw new HistosPublishError("La proposta da fotografare è in sola lettura.", "preview-readonly", 405);
    // «Uguale alla proposta»: a kept original, still, for the frame beside the built site (proposal-compare.ts).
    if (url.pathname.startsWith(PROPOSAL_ORIGINAL_PREFIX)) {
      let pathname = "";
      try { pathname = decodeURIComponent(url.pathname); } catch { /* Not an address: answered below. */ }
      const original = proposalOriginals.resolve(pathname);
      const policy = stillPolicy({ ancestors: proposalFrameAncestors, sealed: true });
      if (!original || !(await sendStill(request, response, original.root, original.pathname, policy, `${PROPOSAL_ORIGINAL_PREFIX}${original.ticket}`))) throw new HistosPublishError("Proposta non trovata o scaduta. Riapri il confronto.", "preview-missing", 404);
      return;
    }
    const importId = proposalFrames.importOf(url.pathname);
    if (!importId) throw new HistosPublishError("Proposta non trovata o scaduta. Sceglila di nuovo.", "preview-missing", 404);
    const source = await imports.sourceFiles(importId, 128 * 1024 * 1024).catch(() => null);
    const page = source?.kind === "html" ? source.files[0] : undefined;
    if (!page) throw new HistosPublishError("Proposta non trovata o scaduta. Sceglila di nuovo.", "preview-missing", 404);
    const body = Buffer.from(proposalFrameDocument(new TextDecoder().decode(page.bytes)), "utf8");
    response.writeHead(200, proposalFrameHeaders(body.byteLength, proposalFrameAncestors));
    response.end(request.method === "HEAD" ? undefined : body);
  }

  async function handlePreview(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") throw new HistosPublishError("L’anteprima è in sola lettura.", "preview-readonly", 405);
    const parts = url.pathname.split("/").filter(Boolean);
    const ticket = parts[1];
    const buildId = parts[2];
    if (!ticket || !buildId) throw new HistosPublishError("Anteprima non valida o scaduta.", "preview-missing", 404);
    const preview = previews.get(ticket);
    if (!preview || preview.buildId !== buildId || preview.expiresAt < Date.now()) {
      if (preview) previews.delete(ticket);
      throw new HistosPublishError("Anteprima non valida o scaduta. Riaprila dalla versione.", "preview-missing", 404);
    }
    // A preview in use stays open: it lapses PREVIEW_TTL_MS after its last page or file, not after it was opened.
    preview.expiresAt = Math.max(preview.expiresAt, Date.now() + PREVIEW_TTL_MS);
    const encodedPath = parts.slice(3).join("/");
    let filePath: string;
    try { filePath = encodedPath ? encodedPath.split("/").map(decodeURIComponent).join("/") : "index.html"; }
    catch { throw new HistosPublishError("Percorso anteprima non valido.", "preview-path-invalid", 404); }
    // A folder is served through its index.html, as a static host does ("/opera/" is a page).
    const normalized = !encodedPath ? "index.html" : url.pathname.endsWith("/") ? `${filePath}/index.html` : filePath;
    // No hidden entry anywhere in the path (the build keeps its own metadata in .histos-publish/).
    if (normalized.split("/").some((segment) => segment.startsWith(".")) || normalized.includes("\\")) throw new HistosPublishError("Percorso anteprima non valido.", "preview-path-invalid", 404);
    const boundary = `${path.resolve(preview.bundlePath)}${path.sep}`;
    if (!path.resolve(preview.bundlePath, ...normalized.split("/")).startsWith(boundary)) throw new HistosPublishError("Percorso anteprima non valido.", "preview-path-invalid", 404);
    let absolute = path.resolve(preview.bundlePath, ...normalized.split("/"));
    let info = await stat(absolute).catch(() => null);
    // A clean address without extension ("/chi-siamo") can be a page file, as hosts with clean URLs serve it.
    if (!info && !url.pathname.endsWith("/") && !path.extname(normalized)) {
      const page = await stat(`${absolute}.html`).catch(() => null);
      if (page?.isFile()) {
        absolute = `${absolute}.html`;
        info = page;
      }
    }
    if (info?.isDirectory() && !url.pathname.endsWith("/")) {
      // Without the final slash the page's relative addresses would resolve one level up.
      response.writeHead(308, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      response.end();
      return;
    }
    if (info?.isDirectory()) info = null;
    if (!info?.isFile() || info.size > 100 * 1024 * 1024) throw new HistosPublishError("File anteprima non trovato.", "preview-file-missing", 404);
    const mime = contentType(absolute);
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Length": String(info.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "SAMEORIGIN",
    };
    // The sandboxed page has an opaque origin, and browsers load fonts in CORS mode: without this they never apply.
    if (mime.startsWith("font/")) headers["Access-Control-Allow-Origin"] = "*";
    if (mime.startsWith("text/html")) headers["Content-Security-Policy"] = "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; sandbox allow-scripts";
    // A built site addresses pages and media from the root, as once published: inside the preview those addresses
    // get the preview prefix, so images load and internal links stay in the preview (preview-rewrite.ts).
    const rewritable = mime.startsWith("text/html") ? rewritePreviewHtml : mime.startsWith("text/css") ? rewritePreviewCss : null;
    if (rewritable && info.size <= PREVIEW_REWRITE_MAX_BYTES) {
      const body = Buffer.from(rewritable(await readFile(absolute, "utf8"), `/__preview/${ticket}/${buildId}`), "utf8");
      headers["Content-Length"] = String(body.byteLength);
      response.writeHead(200, headers);
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    // pipeline() closes the file when the client goes away; .pipe() would keep it open.
    else pipeline(createReadStream(absolute), response).catch(() => undefined);
  }

  async function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") throw new HistosPublishError("Risorsa non trovata.", "static-not-found", 404);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new HistosPublishError("Percorso non valido.", "static-not-found", 404); }
    const target = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const absolute = path.resolve(uiDirectory, target);
    if (!absolute.startsWith(`${uiDirectory}${path.sep}`)) throw new HistosPublishError("Risorsa non trovata.", "static-not-found", 404);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) {
      if (path.extname(target) || target.startsWith("api/")) throw new HistosPublishError("Risorsa non trovata.", "static-not-found", 404);
      return serveStatic(request, response, new URL("/", url));
    }
    if (info.size > 20 * 1024 * 1024) throw new HistosPublishError("Risorsa UI troppo grande.", "static-too-large", 413);
    const mime = contentType(absolute);
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Length": String(info.size),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": absolute.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    };
    if (mime.startsWith("text/html")) headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'" + (captureOrigin ? ` ${captureOrigin}` : "") + "; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    // pipeline() closes the file when the client goes away; .pipe() would keep it open.
    else pipeline(createReadStream(absolute), response).catch(() => undefined);
  }

  await removeStalePrototypeScratch(dataDirectory);
  const connector = new ConnectorService({
    dataDirectory,
    appVersion: options.connector?.appVersion ?? "0.0.0-dev",
    ...(options.connector?.clientScript ? { clientScript: options.connector.clientScript } : {}),
    ...(options.connector?.exportDirectory ? { exportDirectory: options.connector.exportDirectory } : {}),
    ...(options.connector?.minFreeBytes === undefined ? {} : { minFreeBytes: options.connector.minFreeBytes }),
    ...(options.connector?.wordpressPlan ? { wordpressPlan: options.connector.wordpressPlan } : {}),
    ...(options.connector?.wordpressApply ? { wordpressApply: options.connector.wordpressApply } : {}),
    ...(options.connector?.onApprovals ? { onApprovals: options.connector.onApprovals } : {}),
    cms: cmsOperationsContext,
    catalog: cmsCatalog,
    remoteCatalog: cmsRemoteCatalog,
    secretStoreFor: (account) => storeFor(account, secretFactory),
    listBuilds: listCmsBuilds,
    isRegisteredBuild: (projectId, buildId) => cmsBuildRegistry.getBuild(buildId)?.projectId === projectId,
    settings: { get: (key) => repository.getSetting(key), set: (key, value) => repository.setSetting(key, value) },
    track: (work) => {
      activeCmsRequests.add(work);
      void work.finally(() => activeCmsRequests.delete(work)).catch(() => undefined);
    },
    ...(options.cmsPrototypeAssetFetcher === undefined ? {} : { fetchPrototypeAsset: options.cmsPrototypeAssetFetcher }),
  });
  // "Riattiva all'avvio" is the user's explicit choice; a failure leaves the connector off, never the app.

  const trashSweep = purgeExpiredTrash().catch(() => undefined);
  activeCmsRequests.add(trashSweep);
  void trashSweep.finally(() => activeCmsRequests.delete(trashSweep));

  const server = createHttpServer((request, response) => {
    void (async () => {
      const port = (server.address() as { port: number } | null)?.port ?? requestedPort;
      if (!isHostAllowed(request, port)) { sendError(response, 403, "Host non consentito.", "host-rejected"); return; }
      const host = request.headers.host ?? `127.0.0.1:${port}`;
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/__cms-media/")) {
        const parts = url.pathname.split("/").filter(Boolean).map((part) => {
          try { return decodeURIComponent(part); } catch { return ""; }
        });
        if (parts.some((part) => part === "")) throw new HistosPublishError("Percorso media non valido.", "cms-media-missing", 404);
        await handlePublicCmsMedia(request, response, parts, cmsCatalog);
        return;
      }
      if (url.pathname.startsWith("/__preview/")) { await handlePreview(request, response, url); return; }
      if (url.pathname === "/__session/launch") {
        // The browser opened by the CLI receives a one-time code, not the session token: the code travels in the
        // launcher's command line, which other local accounts may read, and is useless once this page redeems it.
        if (request.method !== "POST" || !hasValidOrigin(request, port)) { sendError(response, 403, "Origine della richiesta non consentita.", "origin-rejected"); return; }
        const body = await readJson(request, 1024);
        const code = typeof body.code === "string" ? body.code : "";
        const expiresAt = launchCodes.get(code);
        launchCodes.delete(code);
        if (expiresAt === undefined || expiresAt < Date.now()) { sendError(response, 401, "Il collegamento di avvio è scaduto. Riavvia histos-publish ui.", "launch-code-invalid"); return; }
        sendJson(response, 200, { token });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!hasValidToken(request, token)) { sendError(response, 401, "Sessione non valida. Riapri la pagina dall’app.", "auth-required"); return; }
        if (!["GET", "HEAD"].includes(request.method ?? "GET") && !hasValidOrigin(request, port)) { sendError(response, 403, "Origine della richiesta non consentita.", "origin-rejected"); return; }
        await handleApi(request, response, url);
        return;
      }
      await serveStatic(request, response, url);
    })().catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const issues = safeErrorIssues(error);
      sendError(response, requestErrorStatus(error), safeErrorMessage(error), requestErrorCode(error), issues, safeErrorIssuesTotal(error, issues?.length ?? 0));
    });
  });

  await listenOnAvailablePort(server, requestedPort);
  const address = server.address();
  if (!address || typeof address === "string") throw new HistosPublishError("Il server locale non ha ricevuto una porta valida.", "server-start-failed", 1);
  // The capture origin: a port the system gives, on 127.0.0.1 only, for the proposal's sealed frame and nothing else.
  const captureServer = createHttpServer((request, response) => {
    void handleProposalFrame(request, response).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      sendError(response, requestErrorStatus(error), safeErrorMessage(error), requestErrorCode(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    captureServer.once("error", reject);
    captureServer.listen(0, "127.0.0.1", () => resolve());
  });
  const captureAddress = captureServer.address();
  if (!captureAddress || typeof captureAddress === "string") throw new HistosPublishError("Il server locale non ha ricevuto una porta valida.", "server-start-failed", 1);
  captureOrigin = `http://127.0.0.1:${captureAddress.port}`;
  // Who may frame the proposal: the app in the browser (this server) and the desktop app (its own scheme).
  proposalFrameAncestors = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`, "app:"];
  if (connector.autoStart) await connector.start().catch(() => undefined);
  const url = `http://127.0.0.1:${address.port}/#token=${token}`;
  if (options.openBrowser !== false) {
    const code = randomBytes(32).toString("base64url");
    launchCodes.set(code, Date.now() + 120_000);
    const launchUrl = `http://127.0.0.1:${address.port}/#launch=${code}`;
    void (options.launchBrowser ?? ((target: string) => open(target, { wait: false })))(launchUrl).catch(() => undefined);
  }

  return {
    port: address.port,
    url,
    token,
    dataDirectory,
    captureOrigin,
    close: async () => {
      stopAutomaticCopies();
      captureServer.close();
      captureServer.closeAllConnections();
      await connector.stop("app-closing").catch(() => undefined);
      for (const job of jobs.values()) if (job.status === "running") job.controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        // Once the desktop window is closed, any remaining keep-alive or SSE
        // sockets belong to that renderer. Stop accepting requests first, then
        // close those sockets so shutdown cannot wait forever on an abandoned
        // event stream.
        server.closeAllConnections();
      });
      await Promise.allSettled([...activeJobs]);
      // Requests whose client left still close their project databases; a stuck one cannot hold the exit forever.
      let stopWaiting: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...activeCmsRequests]),
        new Promise<void>((resolve) => { stopWaiting = setTimeout(resolve, 10_000); }),
      ]);
      clearTimeout(stopWaiting);
      proposalFrames.clear();
      proposalOriginals.clear();
      await imports.cleanup();
      await prototypePreviews.reset().catch(() => undefined);
      repository.close();
      cmsRemoteCatalog.close();
      cmsBuildRegistry.close();
      wordpressProvisionCatalog.close();
    },
  };
}

function requireSiteName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 80) throw new HistosPublishError("Il nome del sito deve contenere da 1 a 80 caratteri.", "site-invalid", 2);
  return value.trim();
}

function cleanCredentials(value: unknown): { basicUser?: string; basicPassword?: string; cookie?: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const output: { basicUser?: string; basicPassword?: string; cookie?: string } = {};
  for (const key of ["basicUser", "basicPassword", "cookie"] as const) {
    const item = record[key];
    if (item === undefined || item === "") continue;
    if (typeof item !== "string" || item.length > 4096 || item.includes("\r") || item.includes("\n") || item.includes("\0")) throw new HistosPublishError("Le credenziali superano i limiti consentiti o contengono caratteri non ammessi.", "credentials-invalid", 2);
    output[key] = item;
  }
  if (Boolean(output.basicUser) !== Boolean(output.basicPassword)) throw new HistosPublishError("Inserisci insieme nome utente e password Basic Auth.", "credentials-invalid", 2);
  return output;
}

function isHostname(value: string): boolean {
  if (value.length > 253 || value.includes(":") || value.includes("/") || value.includes("@")) return false;
  const labels = value.replace(/\.$/u, "").split(".");
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label));
}

async function getSiteCredentials(siteId: string, factory: LocalServerOptions["secretStoreFactory"], repository: AppRepository): Promise<{ basicUser?: string; basicPassword?: string; cookie?: string } | undefined> {
  if (!(repository.getSetting<boolean>(`wpCredentials:${siteId}`) ?? false)) return undefined;
  try {
    const raw = await storeFor(`wordpress-${siteId}`, factory).get();
    if (!raw) throw new HistosPublishError("Le credenziali WordPress configurate non sono disponibili nel portachiavi. Reinseriscile nelle impostazioni del sito.", "keyring-secret-missing", 4);
    const credentials = cleanCredentials(JSON.parse(raw));
    if (!credentials) throw new HistosPublishError("Le credenziali WordPress nel portachiavi non sono valide. Reinseriscile nelle impostazioni del sito.", "keyring-secret-invalid", 4);
    return credentials;
  } catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw new HistosPublishError("Non riesco ad accedere al portachiavi per leggere le credenziali WordPress.", "keyring-unavailable", 4);
  }
}

async function readStaticHostingCredentials(site: StoredSite, factory: LocalServerOptions["secretStoreFactory"], repository: AppRepository): Promise<StaticHostingCredentials> {
  if (!(repository.getSetting<boolean>(`hostingCredentials:${site.id}`) ?? false)) {
    throw new HistosPublishError("Verifica e salva prima le credenziali del server FTP/FTPS/SFTP.", "hosting-credentials-missing", 2);
  }
  try {
    const raw = await storeFor(`hosting-${site.id}`, factory).get();
    if (!raw) throw new Error("secret missing");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.username !== "string" || !parsed.username) throw new Error("secret invalid");
    const authMethod = site.config.hosting?.protocol === "sftp" ? site.config.hosting.authMethod ?? "password" : "password";
    if (authMethod === "privateKey") {
      if (typeof parsed.privateKey !== "string" || !parsed.privateKey) throw new Error("secret invalid");
      return {
        username: parsed.username,
        privateKey: parsed.privateKey,
        ...(typeof parsed.passphrase === "string" ? { passphrase: parsed.passphrase } : {}),
        authMethod,
      };
    }
    if (typeof parsed.password !== "string" || !parsed.password) throw new Error("secret invalid");
    return { username: parsed.username, password: parsed.password, authMethod };
  } catch {
    throw new HistosPublishError("Le credenziali hosting non sono disponibili nel portachiavi locale. Reinseriscile nelle impostazioni.", "keyring-secret-missing", 4);
  }
}

function storedDatabaseConnections(repository: AppRepository): StoredDatabaseConnection[] {
  const saved = repository.getSetting<unknown>("databaseConnections");
  if (!Array.isArray(saved)) return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  return saved.flatMap((item): StoredDatabaseConnection[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== "string" || !uuid.test(value.id)
      || typeof value.name !== "string" || value.name.length > 120
      || typeof value.host !== "string" || value.host.length > 253
      || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.databaseName !== "string" || value.databaseName.length > 64
      || typeof value.tablePrefix !== "string" || value.tablePrefix.length > 32
      || value.engine !== "mysql" && value.engine !== "mariadb"
      || typeof value.serverVersion !== "string" || typeof value.serverComment !== "string"
      || typeof value.characterSet !== "string" || typeof value.collation !== "string"
      || typeof value.tableCount !== "number" || !Number.isSafeInteger(value.tableCount) || value.tableCount < 0
      || typeof value.prefixTableCount !== "number" || !Number.isSafeInteger(value.prefixTableCount) || value.prefixTableCount < 0
      || typeof value.createdAt !== "string" || typeof value.checkedAt !== "string"
    ) return [];
    let sshTunnel: StoredDatabaseConnection["sshTunnel"];
    if (value.sshTunnel && typeof value.sshTunnel === "object" && !Array.isArray(value.sshTunnel)) {
      const candidate = value.sshTunnel as Record<string, unknown>;
      try {
        const endpoint = parseDatabaseSshEndpoint(candidate);
        const username = typeof candidate.username === "string" ? candidate.username : "";
        const authMethod = candidate.authMethod === "password" || candidate.authMethod === "privateKey" ? candidate.authMethod : null;
        const hostKeyFingerprint = typeof candidate.hostKeyFingerprint === "string" ? candidate.hostKeyFingerprint : "";
        if (username && username.length <= 128 && authMethod && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(hostKeyFingerprint)) {
          sshTunnel = { ...endpoint, username, authMethod, hostKeyFingerprint };
        }
      } catch {
        sshTunnel = undefined;
      }
    }
    return [{
      id: value.id,
      name: value.name,
      host: value.host,
      port: value.port,
      databaseName: value.databaseName,
      tablePrefix: value.tablePrefix,
      engine: value.engine,
      serverVersion: value.serverVersion.slice(0, 128),
      serverComment: value.serverComment.slice(0, 255),
      characterSet: value.characterSet.slice(0, 64),
      collation: value.collation.slice(0, 128),
      tableCount: value.tableCount,
      prefixTableCount: value.prefixTableCount,
      privilegesVerified: value.privilegesVerified === true,
      grantedPrivileges: Array.isArray(value.grantedPrivileges) ? value.grantedPrivileges.filter((privilege): privilege is string => typeof privilege === "string" && privilege.length <= 32).slice(0, 32) : [],
      missingPrivileges: Array.isArray(value.missingPrivileges) ? value.missingPrivileges.filter((privilege): privilege is string => typeof privilege === "string" && privilege.length <= 32).slice(0, 32) : [],
      createdAt: value.createdAt,
      checkedAt: value.checkedAt,
      ...(sshTunnel ? { sshTunnel } : {}),
    }];
  });
}

async function settingsResult(repository: AppRepository, dataDirectory: string, store: SecretStore): Promise<Record<string, unknown>> {
  return {
    accountId: configuredAccountId(repository),
    language: repository.getSetting<string>("language") ?? "it",
    dataDirectory,
    token: await tokenConfigured(store),
  };
}
