/**
 * Where a site's files come from. "cms": a Histeon CMS project, by id; the site is only a destination for the
 * project's builds (Cloudflare or hosting settings), and has no build of its own (queue E6).
 */
export type SourceKind = "directory" | "html" | "zip" | "url" | "cms";
export type FindingSeverity = "block" | "warn";

export type DestinationKind = "static-cloudflare" | "static-hosting" | "wordpress-existing" | "wordpress-new";
export type DestinationTransport = "cloudflare-api" | "sftp" | "ftps" | "ftp" | "histos-remote";

/** Runtime capability claims are false until a provider-specific check proves them. */
export interface DestinationCapabilities {
  atomicSwitch: boolean;
  rollback: boolean;
  deleteManaged: boolean;
  remoteVerify: boolean;
  runtimeProvision: boolean;
  databaseProbe: boolean;
}

/** Provider-neutral facts shown before applying a destination plan. */
export interface DestinationPlanTarget {
  id: string;
  label: string;
  kind: DestinationKind;
  transport: DestinationTransport;
  publicUrl?: string;
}

export interface DestinationPlanRecovery {
  status: "ready" | "blocked" | "provider-managed" | "unavailable";
  estimatedBytes: number;
  maxBytes: number;
  note: string;
}

export interface DestinationPlanMetadata {
  destination: DestinationPlanTarget;
  rollback: DestinationPlanRecovery;
}

/** Non-secret fields shared by discovery, dry-run planning, and publication. */
interface DestinationBase {
  schemaVersion: 1;
  destinationId: string;
  label: string;
  publicUrl?: string;
  pathPrefix?: string;
  documentRoot?: string;
  runtimeRequirements?: { phpMinimum?: string; wordpressMinimum?: string; histosContract?: string };
  detectedCapabilities: DestinationCapabilities;
  checkedAt?: string;
}

export interface DestinationDatabase {
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  databaseName: string;
  tablePrefix: string;
  tlsMode: "verify-full";
  caRef?: string;
  tunnelRef?: string;
  secretRef: string;
}

export interface DestinationWordPressLink {
  remoteSiteId: string;
  pairingSecretRef: string;
  histosContract: string;
  publishPermission: boolean;
}

/** A destination profile cannot pair an unrelated site kind with a transport. */
export type Destination =
  | (DestinationBase & {
      kind: "static-cloudflare";
      transport: "cloudflare-api";
      database?: never;
      wordpress?: never;
    })
  | (DestinationBase & {
      kind: "static-hosting";
      transport: Extract<DestinationTransport, "sftp" | "ftps" | "ftp">;
      database?: never;
      wordpress?: never;
    })
  | (DestinationBase & {
      kind: "wordpress-existing";
      transport: "histos-remote";
      database?: never;
      wordpress: DestinationWordPressLink;
    })
  | (DestinationBase & {
      kind: "wordpress-new";
      transport: Extract<DestinationTransport, "sftp" | "ftps" | "ftp">;
      database: DestinationDatabase;
      wordpress?: DestinationWordPressLink;
    });

export interface SourceSpec {
  kind: SourceKind;
  path: string;
  root?: string;
}

export interface SiteConfig {
  schemaVersion: 1;
  name: string;
  source: SourceSpec;
  include?: string[];
  exclude?: string[];
  crawl?: {
    concurrency?: number;
    delayMs?: number;
    timeoutMs?: number;
    maxPages?: number;
    maxDepth?: number;
    maxBytes?: number;
    respectRobots?: boolean;
    ignoreRobots?: boolean;
    siteManaged?: boolean;
    bypassCache?: boolean;
    includeFeeds?: boolean;
    urls?: string[];
    render?: boolean;
  };
  rewrite?: {
    destinationDomain?: string;
    externalAssets?: string[];
    removeEmoji?: boolean;
  };
  dynamic?: {
    hideComments?: boolean;
    wooCommerceCatalog?: boolean;
  };
  pagefind?: boolean;
  forms?: {
    wordpress?: {
      restUrl: string;
      fluentFormIds: number[];
      turnstileSiteKey: string;
    };
  };
  cloudflare?: {
    accountId?: string;
    script?: string;
    domain?: string;
    workersDev?: boolean;
    maxFiles?: number;
    /** The site's own server code, uploaded apart from its files: it enters every build as `_worker.js`. */
    workerModule?: { path: string; name: string };
    /** KV archives for the site's own Worker: `VOTI` (Publish's `<worker>-VOTI`) or `VOTI=voti-logo` (that namespace). */
    kv?: string[];
  };
  deployTarget?: "cloudflare" | "ftp";
  hosting?: {
    protocol: "ftp" | "ftps" | "sftp";
    host: string;
    port: number;
    remoteDirectory: string;
    publicUrl?: string;
    username?: string;
    allowInsecureFtp?: boolean;
    tlsCaCertificate?: string;
    authMethod?: "password" | "privateKey";
    hostKeyFingerprint?: string;
  };
}

export interface Finding {
  code: string;
  severity: FindingSeverity;
  file: string;
  message: string;
  line?: number;
}

export interface BundleFile {
  path: string;
  size: number;
  bytes?: Buffer;
  sourcePath?: string;
}

export interface ManifestEntry {
  hash: string;
  size: number;
}

export interface BundleMeta {
  schemaVersion: 1;
  sourceKind: SourceKind;
  sourcePath: string;
  createdAt: string;
  pages: number;
  assets: number;
  files: number;
  totalBytes: number;
  skipped: string[];
  findings: Finding[];
  redirects?: RedirectRule[];
  report?: CrawlReport;
  pagefind?: { enabled: boolean; indexedPages: number };
  forms?: FormsBuildResult;
  worker?: { origin: "source" | "file"; bytes: number; kv?: string[] };
  status?: "ready" | "blocked";
}

export interface FormsBuildResult {
  enabled: boolean;
  adapter: "wordpress-fluent-forms";
  restUrl: string;
  turnstileSiteKey: string;
  fluentFormIds: number[];
  attachedForms: number;
  unsupportedFiles: string[];
  unmatchedIds: number[];
  linkedFiles: string[];
}

export interface RedirectRule {
  from: string;
  to: string;
  status: 301 | 308;
}

export interface DynamicFeature {
  code: string;
  file: string;
  message: string;
  solution: string;
}

export interface CrawlReport {
  engine: "generic" | "wordpress";
  sourceUrl: string;
  pagesDiscovered: number;
  pagesDownloaded: number;
  assetsDownloaded: number;
  pagesSkipped: string[];
  cache: { hit: number; miss: number; notModified: number };
  signals: string[];
  technologies: string[];
  dynamicFeatures: DynamicFeature[];
  redirects: RedirectRule[];
}

export type BuildEvent =
  | { type: "start"; sourceKind: SourceKind }
  | { type: "progress"; phase: "crawl" | "assets" | "scan" | "copy" | "rewrite" | "pagefind" | "forms"; completed: number; total?: number }
  | { type: "finding"; finding: Finding }
  | { type: "complete"; files: number; bytes: number; blocked: boolean }
  | { type: "cancelled" };

export interface RenderedRequest {
  url: string;
  type: string;
}

export interface RenderedPage {
  html: string;
  finalUrl: string;
  requests: RenderedRequest[];
  idleTimedOut?: boolean;
}

export interface RenderPageContext {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  maxRequests: number;
  signal: AbortSignal;
  fetchResource: (url: string, maxBytes: number) => Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>;
}

export type RenderPage = (context: RenderPageContext) => Promise<RenderedPage>;

/** Doc 23 item 101: two documents photographed at the same widths, with scripts off and no network. */
export interface RenderComparisonInput {
  before: string;
  after: string;
  widths: readonly number[];
  signal: AbortSignal;
}

export interface RenderComparison {
  width: number;
  /** The taller of the two photographs, in CSS pixels (at most the comparison's height limit). */
  height: number;
  /** Pixels that differ, counting every pixel of the taller photograph that the other one lacks. */
  differentPixels: number;
  totalPixels: number;
}

export type CompareRenders = (input: RenderComparisonInput) => Promise<RenderComparison[]>;

export interface BuildOptions {
  source: SourceSpec;
  credentials?: { basicUser?: string; basicPassword?: string; cookie?: string };
  outputDirectory?: string;
  checkOnly?: boolean;
  include?: string[];
  exclude?: string[];
  maxBytes?: number;
  crawl?: SiteConfig["crawl"];
  rewrite?: SiteConfig["rewrite"];
  dynamic?: SiteConfig["dynamic"];
  pagefind?: boolean;
  forms?: SiteConfig["forms"];
  /** A JS file added to the build as `_worker.js`, the site's own Worker. */
  workerPath?: string;
  cacheDirectory?: string;
  crawlConsent?: string;
  renderPage?: RenderPage;
  /** Agent-only origin controls. These are deliberately not part of SiteConfig. */
  privateOrigin?: boolean;
  strictOrigin?: boolean;
  originHeaders?: Record<string, string>;
  requireEcho?: { header: string; value: string };
  seedPaths?: string[];
  notFoundProbe?: boolean;
  blockNativeHistosForms?: boolean;
  /** Agent-only values rejected before an HTTP response can enter a cache or bundle. */
  forbiddenValues?: string[];
  signal?: AbortSignal;
  onEvent?: (event: BuildEvent) => void;
}

export interface BuildResult {
  status: "ready" | "blocked";
  sourceKind: SourceKind;
  bundlePath?: string;
  files: number;
  pages: number;
  assets: number;
  totalBytes: number;
  skipped: string[];
  findings: Finding[];
  manifest: Record<string, ManifestEntry>;
  report?: CrawlReport;
  redirects?: RedirectRule[];
  pagefind?: { enabled: boolean; indexedPages: number };
  forms?: FormsBuildResult;
  /** The site's own Worker in the build (`_worker.js`): where it came from, its size and the KV archives its code uses. */
  worker?: { origin: "source" | "file"; bytes: number; kv?: string[] };
}
