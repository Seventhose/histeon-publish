import type { ImportReportView } from "./api.js";
import type { Language } from "./i18n.js";

// The shapes App.svelte and the components split from it share: what the server sends and what the app keeps.

export type Screen = "home" | "new" | "site" | "report" | "history" | "settings" | "activity" | "preview" | "guide" | "cms" | "admin" | "agent" | "trash";
export type SourceKind = "directory" | "html" | "zip" | "url" | "cms";
export type DeployTarget = "cloudflare" | "ftp";
export type HostingProtocol = "ftp" | "ftps" | "sftp";
export type HostingAuthMethod = "password" | "privateKey";
export interface HostingSettings { protocol: HostingProtocol; host: string; port: number; remoteDirectory: string; publicUrl?: string; username?: string; allowInsecureFtp?: boolean; tlsCaCertificate?: string; authMethod?: HostingAuthMethod; hostKeyFingerprint?: string }
export interface Site {
  id: string; name: string; source: { kind: SourceKind; label: string }; accountId: string | null; worker: string | null;
  sourceUrl?: string; deployTarget?: DeployTarget;
  /** A destination of this Histeon CMS project only (E6): no source and no build of its own. */
  cmsProjectId?: string;
  /** Where a deploy goes now, as the server compares it with the confirmed summary. */
  deployDestination?: string; hosting?: HostingSettings | null; hostingCredentialsConfigured?: boolean;
  domain: string | null; publicUrl: string | null; createdAt: string; updatedAt: string; render?: boolean;
  externalAssets?: string[]; wpCredentialsConfigured?: boolean;
  pagefind?: boolean;
  forms?: { wordpress?: { restUrl: string; fluentFormIds: number[]; turnstileSiteKey: string } } | null;
  turnstileSecretConfigured?: boolean;
  /** The site's own server code (`_worker.js`), uploaded apart from its files. */
  workerModule?: { name: string } | null;
  /** KV bindings of the site's own Worker, for example ["VOTI"]. */
  kv?: string[];
  lastBuild: { id: string; status: string; createdAt: string; files?: number; pages?: number } | null;
  /** A newer build that was cancelled or failed: it does not replace `lastBuild` (E13). */
  lastAttempt?: { id: string; status: string; createdAt: string } | null;
  lastDeploy: { id: string; status: string; createdAt: string; versionId?: string; workersDevUrl?: string; healthCheck?: { status: "ok" | "warning" | "unavailable"; url?: string; statusCode?: number; contentType?: string; message: string } } | null;
  needsBuild?: boolean;
}
export interface BuildResult {
  id: string; status: string; createdAt?: string; completedAt?: string; sourceKind?: SourceKind;
  files?: number; pages?: number; assets?: number; totalBytes?: number; skipped?: string[];
  findings?: Array<{ code: string; severity: "block" | "warn"; file: string; message: string; line?: number }>;
  report?: { engine?: string; dynamicFeatures?: Array<{ code: string; file: string; message: string; solution: string }>; technologies?: string[] };
  redirects?: Array<{ from: string; to: string; status: number }>;
  pagefind?: { enabled: boolean; indexedPages: number };
  forms?: { enabled: boolean; adapter: string; restUrl: string; turnstileSiteKey: string; fluentFormIds: number[]; attachedForms: number; unsupportedFiles: string[]; unmatchedIds: number[] };
  worker?: { origin: "source" | "file"; bytes: number; kv?: string[] };
}
export interface HistoryData { builds: BuildResult[]; deploys: Array<Record<string, unknown>> }
export interface DomainPlan {
  hostname: string;
  hostnames: string[];
  zone: { name: string };
  cnameConflicts: Array<{ id: string; name: string; content: string; proxied: boolean }>;
  workerConflicts: Array<{ hostname: string; service: string }>;
}
export interface CloudflareAccount { id: string; name: string }
export interface DatabaseSshTunnelProfile { host: string; port: number; username: string; authMethod: "password" | "privateKey"; hostKeyFingerprint: string }
export interface DatabaseConnection { id: string; name: string; host: string; port: number; databaseName: string; tablePrefix: string; engine: "mysql" | "mariadb"; serverVersion: string; serverComment: string; characterSet: string; collation: string; tableCount: number; prefixTableCount: number; privilegesVerified: boolean; grantedPrivileges: string[]; missingPrivileges: string[]; createdAt: string; checkedAt: string; sshTunnel?: DatabaseSshTunnelProfile }
export interface HostingDirectoryInspection { entryCount: number; isEmpty: boolean; wordpressSignals: string[] }
export interface WordPressPreflight {
  status: "blocked" | "awaiting-php-check" | "ready-for-install";
  canInstall: false;
  filesystem: { readable: boolean; empty: boolean; entryCount: number; wordpressSignals: string[] };
  database: { id: string; name: string; engine: "mysql" | "mariadb"; serverVersion: string; versionSupported: boolean; tableCount: number; prefixTableCount: number; empty: boolean; privilegesVerified: boolean; grantedPrivileges: string[]; missingPrivileges: string[] };
  runtime: { phpChecked: boolean; phpVersion: string | null; phpSupported: boolean; phpRecommended: boolean; missingRequiredExtensions: string[]; missingRecommendedExtensions: string[]; databaseTlsVerified: boolean; databaseTlsFailure: string | null; httpsAvailable: boolean; httpsConfigured: boolean; wordpressMinimumPhp: string; requiredPhp: string; recommendedPhp: string; status: "not-checked" | "supported" | "unsupported" };
}
export type WordPressProvisionStatus = "planned" | "uploading" | "installing" | "recovering" | "needs-recovery" | "blocked" | "complete" | "expired";
export interface WordPressProvisionPlan {
  id: string; siteId: string; state: WordPressProvisionStatus; phase: string; createdAt: string; updatedAt: string; expiresAt: string; errorCode: string | null;
  target: { protocol: HostingProtocol; host: string; port: number; remoteDirectory: string; publicUrl: string };
  database: { name: string; host: string; port: number; databaseName: string; tablePrefix: string; engine: "mysql" | "mariadb"; serverVersion: string };
  siteTitle: string; adminUsername: string; adminEmail: string;
  wordpress: { version: string; phpMinimum: string; mysqlMinimum: string; fileCount: number; bytes: number; archiveSha256: string };
  histos: { version: string; wordpressMinimum: string; phpMinimum: string; fileCount: number; bytes: number; archiveSha256: string };
  result: { wordpressVersion: string; histosVersion: string; connectionId: string; siteUrl: string } | null;
}
export interface JobState { id: string; type: "build" | "deploy"; status: string; events: Array<Record<string, unknown>>; buildId?: string; }
export interface UploadEntry { file: File; path: string }
export interface Bootstrap { version: string; accountId: string; language: Language; dataDirectory: string; sites: Site[]; token: { configured: boolean; source: string | null; available: boolean } }
export interface CmsProject { id: string; name: string; createdAt: string; updatedAt: string; schemaVersion: number; summary?: { pages: number; posts: number; origin: "file" | "wordpress" | "local"; lastBuild?: { at: string; current: boolean } | null; cover?: string | null } }
export interface CmsPage { id: string; alias: number; slug: string; title: string; status: "draft" | "published"; headRevision: string; templateRef: string | null; updatedAt: string; locale?: string | null }
export interface CmsComponent { id: string; alias: number; ref: string; title: string; headRevision: string }
export interface CmsTemplate { id: string; alias: number; ref: string; title: string; headRevision: string; hasDefaultSlot?: boolean; role?: string | null }
export interface CmsPost { id: string; alias: number; slug: string; title: string; status: "draft" | "published"; headRevision: string; templateRef: string | null; publishedAt: string | null; excerpt: string; terms: Record<string, string[]>; url: string; updatedAt: string }
export interface CmsTaxonomyInfo { id: string; key: string; label: string; types: string[] }
export interface CmsTermInfo { id: string; slug: string; label: string; parentId?: string | null }
export interface CmsRenderSettings { locale: string; timeZone: string }
export interface CmsPublishedHomeCheck { status: "ok" | "warning" | "unavailable"; url?: string; statusCode?: number; contentType?: string; contentDisposition?: string; message: string }
export interface CmsPlanDestination { id: string; label: string; kind: "static-cloudflare" | "static-hosting" | "wordpress-existing" | "wordpress-new"; transport: "cloudflare-api" | HostingProtocol | "histos-remote"; publicUrl?: string }
export interface CmsPlanRollback { status: "ready" | "blocked" | "provider-managed" | "unavailable"; estimatedBytes: number; maxBytes: number; note: string }
export interface CmsDestinationInspection { schemaVersion: 1; destinationId: string; label: string; kind: "static-cloudflare" | "static-hosting"; transport: "cloudflare-api" | HostingProtocol; checkedAt: string; readVerified: boolean; writeVerified: boolean; publicUrl?: string; detectedCapabilities: { atomicSwitch: boolean; rollback: boolean; deleteManaged: boolean; remoteVerify: boolean; runtimeProvision: boolean; databaseProbe: boolean }; evidence: Record<string, unknown>; remoteInventory?: { complete: boolean; files: Array<{ path: string; size: number }> }; findings: Array<{ severity: "warn" | "block"; code: string; message: string }> }
export interface CmsPublishPlan { schemaVersion: 1; status: "ready" | "blocked"; planId: string | null; projectId: string; buildId: string; projectRevision: string; createdAt: string; expiresAt: string; build: { fileCount: number; totalBytes: number; sha256: string; homePage: "index.html"; filesPreview: Array<{ path: string; size: number }>; additionalFiles: number }; destination: CmsPlanDestination & { kind: "static-cloudflare" | "static-hosting"; transport: "cloudflare-api" | HostingProtocol; location: string }; rollback: CmsPlanRollback; inspection: CmsDestinationInspection; remoteDiff: { status: "complete" | "partial" | "unavailable"; basis: "path-and-size" | "none"; counts: { missing: number; sameSize: number; differentSize: number; remoteOnly: number }; filesPreview: Array<{ path: string; status: "missing" | "same-size" | "different-size" | "remote-only"; localSize?: number; remoteSize?: number }>; additionalFiles: number; note: string }; rollbackBackup: { status: "ready" | "blocked" | "not-applicable"; estimatedBytes: number; maxBytes: number; note: string }; effects: string[]; findings: CmsDestinationInspection["findings"]; writeVerified: false }
export interface CmsProjectDetails { project: CmsProject; pages: CmsPage[]; posts: CmsPost[]; taxonomies: CmsTaxonomyInfo[]; components: CmsComponent[]; templates: CmsTemplate[]; templateParts: CmsTemplate[]; styles: { id: string; alias: number } | null; assets: Array<{ id: string; filename: string }>; renderSettings: CmsRenderSettings; imageSettings?: { variants: boolean }; recoverableDeletions: Array<{ id: string; kind: string; label: string; deletedAt: string }> }
export interface CmsBuildDeployment { id: string; targetSiteId: string; status: string; createdAt: string; completedAt: string | null; result: { provider?: string; rollbackAvailable?: boolean; backupBytes?: number; accountId?: string; script?: string; versionId?: string; healthCheck?: CmsPublishedHomeCheck; publicUrl?: string | null; workersDevUrl?: string | null } | null; error: string | null }
export interface CmsBuild { id: string; status: "ready" | "blocked" | "unavailable"; current?: boolean; createdAt?: string; files: number; pages: number; assets: number; totalBytes: number; previewUrl: string | null; findings: Array<{ code: string; severity: "block" | "warn"; file: string; message: string }>; deployments?: CmsBuildDeployment[]; imagesNote?: string | null }
export type CmsRemoteOperationState = "pending" | "applying" | "partial" | "superseded" | "not-found" | "complete" | "complete-local-changes" | "rolled-back" | "failed";
export interface CmsRemoteOperation { operationId: string; connectionId: string; projectId: string; action: "push" | "publish"; state: CmsRemoteOperationState; expectedEntityCount: number; createdAt: string; updatedAt: string; message: string | null; rollbackAvailable: boolean; rollbackRetryAvailable?: boolean; rollbackOfOperationId?: string }
/** Doc 23 item 175: the site's Histeon is older than the one Publish knows, and what does not work until it is updated. */
export interface HisteonSiteNotice { site: string | null; known: string; missing: Array<{ id: string; since: string; capability?: string }> }
export interface CmsRemoteConnection { id: string; url: string; siteId: string; projectId: string | null; projectName: string; profile: string; read: boolean; write: boolean; publish: boolean; connectedAt: string; lastCheckedAt: string; lastSyncedAt: string | null; operations?: CmsRemoteOperation[]; histeon?: HisteonSiteNotice | null }
export type CmsSyncPlanStatus = "new" | "update" | "delete" | "unchanged" | "local-only" | "remote-only" | "conflict";
export type CmsSyncConflictChoice = "keep-local" | "use-remote";
export interface CmsSyncPlan { schemaVersion: 1; destination: CmsPlanDestination & { kind: "wordpress-existing"; transport: "histos-remote" }; rollback: CmsPlanRollback; planId: string | null; action: "pull" | "push" | "publish"; connectionId: string; project: { id: string; name: string }; profile: string; initializingRemote: boolean; expiresAt: string | null; applyAllowed: boolean; counts: Record<CmsSyncPlanStatus, number>; entities: Array<{ id: string; kind: string; label: string; status: CmsSyncPlanStatus; canResolve: boolean; comparison?: Array<{ field: string; local: string; remote: string }>; omittedComparisonFields?: number; blockedReason?: "local-missing" | "remote-missing" | "type-changed" | "tombstone-conflict" | "tombstone-unsupported"; documentType?: "page" | "post"; onSite?: "only-on-site" | "changed-on-site" }>; omittedEntities: number; leftOut?: Array<{ kind: string; title: string; reason: string }>; histeon?: HisteonSiteNotice; bring?: { requested: number; total: number } }
/** Doc 23 item 197: «Controlla il sito», the site's reading named content by content. */
export interface CmsRemoteSiteProblem { where: "site" | "project"; kind: string; title: string; reason: string; remedy: string; message?: string; blocking: boolean }
/** «Pronto per andare online?» (V1.3): the verdict of the built version, by section. */
export interface CmsReadinessItem { rule: string; level: "error" | "warning"; count: number; pages: string[]; total?: number }
export interface CmsReadinessSection { id: "links" | "images" | "search" | "weight" | "accessibility"; title: string; state: "ok" | "warning" | "error" | "unchecked"; items: CmsReadinessItem[] }
export interface CmsReadiness { verdict: "pronto" | "da-guardare" | "non-pronto"; sections: CmsReadinessSection[]; browserCheckedAt: string | null }
/** GET admin/site-check: the check of the latest version, its verdict, and whether this app can check in a browser. */
export interface CmsSiteCheck {
  check: { pages: number; brokenLinks: Array<{ page: string; link: string }>; heavyImages: Array<{ file: string; kilobytes: number }>; missingAlt: Array<{ page: string; image: string }>; noDescription: string[]; sameTitle: Array<{ text: string; pages: string[] }>; sameDescription: Array<{ text: string; pages: string[] }> };
  current: boolean;
  readiness?: CmsReadiness;
  browserAvailable?: boolean;
}
export interface CmsRemoteSiteCheck { checkedAt: string; host: string; read: number; problems: CmsRemoteSiteProblem[]; canSend: boolean; stoppedEarly: boolean }
/** V1.6, «Verifica nel browser» of the linked WP site: pages named without the preview token, never the signed links. */
export interface CmsRemoteBrowserLink { url: string; status?: number; pages: string[] }
export interface CmsRemoteBrowserCheck {
  checkedAt: string;
  host: string;
  pages: Array<{ doc: string; title: string; page: string }>;
  skipped: number;
  opened: number;
  axe: Array<{ id: string; impact: string | null; help: string; helpUrl: string; pages: string[]; targets: string[]; count: number }>;
  overflow: Array<{ page: string; width: number; scrollWidth: number; elements: string[] }>;
  failures?: string[];
  links: { found: number; checked: number; broken: CmsRemoteBrowserLink[]; unreachable: CmsRemoteBrowserLink[]; untested: CmsRemoteBrowserLink[] };
}
export type DeleteKind = "project" | "site";
/** The Cestino, as the server lists it: read with the catalogs and after every delete or restore. */
export interface TrashEntry { id: string; name: string; deletedAt: string }
/** A name each, and which folder each project or site is in (server folders.ts); one level, no nesting. */
export type ListKind = "cms" | "sites";
export interface FolderInfo { id: string; kind: ListKind; name: string; createdAt: string }
/** One problem of a refused prototype (E4), with its place in the file when the server knows it. */
export interface PrototypeIssueView { document?: string; line?: number; column?: number; message: string }
/**
 * E4: a refused prototype with all its problems, under the import buttons instead of a notice at the top. `file` is
 * the one the user chose; `rereadable` when the desktop app can read it again from disk for «Ricontrolla» (a file of
 * the user's with a .html path, never one made in memory). `total` counts every problem when `issues` holds only the
 * first ones. A prototype made from a site (B1) has no file of the user's: `downloadUrl` gives it to correct.
 */
export interface PrototypeProblemsView { file: File; issues: PrototypeIssueView[]; total: number; rereadable: boolean; downloadUrl?: string }
/** What a site conversion (B1) said, kept with the check: notes, fonts (B5) and the design proposal (B4). */
/** Doc 27, G3: the provider of «Rifinisci i nomi con un modello», as the server shows it (never a key). */
export interface ImportRefineSettingsView { provider: "connettore" | "locale" | "haiku"; connectorEnabled: boolean; localUrl: string; localModel: string; localKeyConfigured: boolean; haikuKeyConfigured: boolean; keyringAvailable: boolean }
/** One name a model proposes for a conversion: shown as text, applied only by the person. */
export interface RefineRowView { id: string; kind: "classe" | "componente" | "prop" | "tipo" | "alt"; before: string; after: string; context: string }
export interface RefineView { provider: "connettore" | "locale" | "haiku"; model: string; choices: number; asked: number; rows: RefineRowView[]; suggestions: RefineRowView[]; rejected: Array<{ id: string; motivo: string; after?: string }>; batches: Array<{ size: number; ok: boolean; error?: string; ms: number }>; skipped: number; ms: number }
/** What a conversion is asked: the earlier choices of the dialog travel with every new conversion of the same site. */
export interface ConversionOptions { fonts?: boolean; framework?: ImportFramework | undefined; recipes?: boolean | undefined; /** Doc 28: the sizes written by hand stay exact, as the site's variables. */ exact?: boolean | undefined; structure?: SiteStructureChoice | undefined; choices?: Record<string, string> | undefined; refine?: boolean; refineView?: RefineView | undefined }
export interface SiteConversionView { choices: number; choicesApplied: Record<string, string>; choicesRejected: Array<{ id: string; motivo: string }>; refine?: RefineView; notes: string[]; groups?: Array<{ kind: "removed" | "script" | "breakpoint" | "redo" | "check"; items: string[] }>; siteId: string; selectable?: { original: number; selectable: number; share: number }; googleFonts: number; fontsRequested: boolean; design: Record<string, string>; tokensRequested: boolean; framework: ImportFramework; /** Doc 28: the exact sizes are on, and whether the dialog may change that ("always": a captured proposal). */ exact: boolean; exactChoice: "always" | "choice" | "none"; recipes: boolean; recipesAvailable: boolean; structure: SiteStructureView; structureApplied: SiteStructureChoice }
/** The framework a converted site's values are written with (doc 18 §6.4.1); Histeon CSS unless the user picks another. */
export type ImportFramework = "histos-css" | "acss" | "core" | "none";
export interface SiteStructureView { parts: Array<"header" | "footer">; components: Array<{ ref: string; uses: number }>; lists: Array<{ type: string; records: number }> }
export interface SiteStructureChoice { parts: boolean; components: boolean; lists: boolean }
export type CmsTab = "pages" | "posts" | "content" | "templates" | "media" | "publish" | "settings";
export interface PrototypeReport { counts: Record<string, number>; downloaded: number; ignored: Array<{ what: string; why: string; line?: number }>; warnings: string[]; images?: { files: number; uses: number; note: string } }
export interface PrototypeCheckView {
  valid: boolean;
  outcome: "create" | "update" | "refused-duplicate";
  existingProject?: { id: string; name: string };
  report: PrototypeReport & { project: { id: string; name: string }; placeholders?: string[] };
  /** Unavailable with `findings`: the site builds, and what stops its bundle is first among the warnings. */
  preview?: { status: "ready"; buildId: string; previewUrl: string; expiresAt: string; findings: number } | { status: "unavailable"; reason: string; findings?: number };
  /** For an update: what it would change, from a dry run on a copy of the project (D2). */
  changes?: PrototypeChangesView;
  /** For an update: why the backup saved first would not fit its limits, so the update cannot run (D2). */
  backupUnavailable?: string;
  /** For an update checked without its remote media: no `changes`, the check must run again with them (?download=1). */
  changesNeedDownload?: boolean;
}
export interface PrototypeChangeView { id: string; kind: string; label: string }
export interface PrototypeChangesView { added: PrototypeChangeView[]; modified: PrototypeChangeView[]; removed: PrototypeChangeView[]; keptLocal: PrototypeChangeView[]; conflicts: PrototypeChangeView[]; unchanged: number; omitted: number }
export interface ImportProgressView { kind: "check" | "import" | "refine"; /** A refinement waiting for Claude through the AI connector. */ connector?: boolean; phase?: "media" | "records" | "documents" | "writing"; done?: number; total?: number }
