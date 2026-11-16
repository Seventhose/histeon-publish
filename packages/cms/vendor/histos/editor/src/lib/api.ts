import type { Facet, Facets } from './facets.ts';
import type { BuilderConfig } from './config.ts';
import type { Preset, Presets } from './queries.ts';
import type { LoopGroupBy } from '@xb/dsl';
import type { ContentDefs } from './contentHub.ts';
import type { VideoInfo } from './media.ts';
import type { ChecksOutcome } from './checks.ts';
import type { CronInfo, ScheduledLast, ScheduledView } from './schedule.ts';
import { t } from './i18n.ts';

/** Client for the xb/v1 REST API — docs/spec/rest.md. */

/** Histeon CSS design parameters (docs/spec/histos-css.md §1): colours, scales, viewports, radius, widths, fonts. */
export type DesignParams = Record<string, string | number>;
/** How readable a pair of Histeon CSS colour tokens is (WCAG 2 contrast; 4.5:1 for normal text). */
export interface ContrastPair {
  text: string;
  bg: string;
  ratio: number;
  ok: boolean;
  /** A pair of the dark theme (Histeon CSS with the dark theme on). */
  scheme?: 'dark';
}

export interface PropDefinition {
  type: string;
  default?: string | number | boolean | null;
  /** What the builder shows when the component is open by itself (E5); pages use the default. */
  sample?: string | number | boolean;
  label?: string;
  options?: string[];
}

export interface FontsData {
  families: Array<{ family: string; faces: Array<{ weight: string; style: string }> }>;
  /** The @font-face rules, served from the site. */
  css: string;
  canManage: boolean;
  /** Only in GET: families of Google Fonts, bundled with the plugin. */
  catalog?: Array<{ family: string; category: string; weights: number[]; italic: boolean }>;
}

export interface Schema {
  props: Record<string, PropDefinition>;
}

export interface DocumentData {
  id: number;
  type: string;
  title: string;
  status: string;
  content: string;
  head: string;
  base: string;
  merged: number;
  conflicts: Array<{ uid: string; dev: string; prod: string }>;
  published: boolean;
  link: string | false | null;
  script: string;
  scriptEditable: boolean;
  ref: string | null;
  schema: Schema | null;
  /** The page's own look in development (voce 186; lib/pageLook.ts). Absent from older servers. */
  pageStyles?: Array<{ selector: string; css: string }>;
  /** What this user may do on this document (voce 186): `view`, `content` or `look`, and the look's groups. */
  access?: { level: string; groups: string[] };
}

export interface SaveExtras {
  script?: string;
  schema?: Schema;
  ref?: string;
  /** The page's own look, sent only when it changed (voce 186). */
  styles?: Array<{ selector: string; css: string }>;
}

export interface StyleEntry {
  id: string;
  selector: string;
  css: string;
}

export interface GlobalSheet {
  id: string;
  css: string;
}

export interface StylesData {
  styles: StyleEntry[];
  globals: GlobalSheet[];
  /** Named media and container queries (`tablet` → `(width < 64em)`), from the settings in dev. */
  queries?: Record<string, string>;
  head: string;
  base: string;
}

export interface ImportReport {
  release: string;
  site: string;
  documents: Array<{ label: string; target: string; action: string }>;
  issues: string[];
  written: boolean;
  /** Who signed the file (P8): own, trusted, rotated, new, unsigned, invalid, revoked. */
  signature?: { status: string; fingerprint: string; site: string };
}

export interface Change {
  doc: string;
  label: string;
  /** It came from Histeon CMS, not from someone working on the site. */
  sent?: boolean;
}

export interface Deploy {
  id: number;
  created: string;
  release_id: number | null;
  version_id: string;
  status: 'live' | 'superseded' | 'blocked';
  files: number;
  uploaded: number;
  message: string;
  /** For a version that can be put back: the contents withdrawn since it was built, which it would serve again. */
  withdrawn?: { count: number; items: string[] };
}

export interface DeployStatus {
  config: { account: string; script: string; tokenSet: boolean; fromConfig: boolean; ready: boolean };
  auto: boolean;
  history: Deploy[];
}

export interface Release {
  id: number;
  version: string;
  notes: string;
  created: string;
  authorName: string;
  current: boolean;
  restored_from: number | null;
  /** What the page checks found when the release went out from the builder (V1.5); null when it went out without them. */
  checks?: { errors: number; warnings: number; pages?: { checked: number; total: number } | null } | null;
}

/** GET /releases: the releases, the next free version and the scheduled release with its warnings (§11). */
export interface ReleaseList {
  releases: Release[];
  next: string;
  scheduled?: ScheduledView | null;
  scheduledLast?: ScheduledLast | null;
  cron?: CronInfo;
  timezone?: string;
}

export interface RenderData {
  html: string;
  /** The stored styles as one sheet: only when asked (`render(…, { css: true })`). */
  css?: string;
  /** Site-wide CSS (theme.json, fonts, tokens): left out when `globalHash` matches the one sent. */
  globalCss?: string;
  globalHash: string;
  stylesheets: string[];
}

/** A drawing of the canvas with its site-wide CSS, filled in from the previous drawing when the server left it out. */
export type Preview = RenderData & { globalCss: string };

export interface ReviewComment {
  id: number;
  author: string;
  text: string;
  uid: string;
  status: 'open' | 'resolved';
  at: number;
}

export interface ReviewData {
  comments: ReviewComment[];
  approval: { name: string; at: number; head: string; current: boolean } | null;
}

export interface ComponentInfo {
  id: number;
  ref: string;
  title: string;
  props: Record<string, PropDefinition>;
}

/** The recipes by origin (docs/spec/design-system.md): the site's win over imported ones, which win over Histeon's. */
export interface RecipeSources {
  site: Record<string, string>;
  imported: Record<string, string>;
  histos: Record<string, string>;
}

export interface FrameworkData {
  active: { id: string; label: string };
  /** `value`: from the framework's `:root`, `var()` resolved, when the stylesheet defines it. */
  variables: Array<{ name: string; group: string; value?: string }>;
  classes: Array<{ name: string; group: string }>;
  /** Recipes imported from Automatic.css: name → CSS, expanded by `@name` in the CSS editor. */
  recipes?: Record<string, string>;
}

/** One style entry in the selector manager, with the documents that use it (GET /selectors). */
export interface SelectorUsage {
  id: string;
  selector: string;
  /** The class name when the selector is a single class, so it can be renamed. */
  rename: string | null;
  bytes: number;
  docs: Array<{ doc: string; post: number; label: string }>;
  /** Documents that use it but this user cannot edit. */
  locked: number;
  /** Theme templates that use it. */
  theme: string[];
  always: boolean;
  safelisted: boolean;
  unused: boolean;
  /** Set for a class that has no entry of its own but is defined in this global sheet. */
  sheet?: string;
  /** How many rules of the sheet name it, and those rules (capped). */
  rules?: number;
  css?: string;
}

export interface SelectorList {
  selectors: SelectorUsage[];
  scanned: number;
  truncated: boolean;
}

export interface RenamePlan {
  from: string;
  to: string;
  styles: number;
  docs: Array<{ doc: string; label: string; classes: number }>;
  manual: Array<{ doc: string; label: string }>;
  /** Class attributes in free HTML ({#raw}, core blocks) the rename can rewrite, chosen one by one (C4). */
  html?: Array<{ id: string; doc: string; label: string; before: string; after: string }>;
  /** Whether this user may rewrite free HTML (unfiltered_html). */
  htmlAllowed?: boolean;
  locked: number;
  theme: string[];
  blocked: Array<{ doc: string; label: string }>;
  conflicts: string[];
  ok: boolean;
}

export interface LibraryItem {
  id: number;
  title: string;
  slug: string;
  status: string;
  modified: string;
  /** Built with XB (has xb/* blocks). */
  xb: boolean;
  ref: string;
  url: string;
}

export interface TemplateItem {
  type: 'wp_template' | 'wp_template_part';
  id: string;
  slug: string;
  title: string;
  source: string;
  /** Database post, 0 while the template is still a theme file. */
  post: number;
  /** What it is for, as the server classifies it (Templates::classify): shared with the admin screen. */
  group: string;
  groupLabel: string;
  groupOrder: number;
  description: string;
}

/** One record of a query, as a loop sees it: `fields[].path` goes after `item.` in an expression. */
export interface QueryRecord {
  title: string;
  url: string;
  fields: Array<{ path: string; kind: 'text' | 'url' | 'image' | 'date' | 'number' | 'list'; value: string }>;
}

/** A group of a grouped query loop in the preview: its key (the title the group gets) and how many records it holds. */
export interface QueryGroup {
  key: string;
  count: number;
}

export interface QueryOptions {
  /** `more`: the taxonomy has more terms than those listed; the others are searched (`queryTerms`). */
  taxonomies: Array<{ name: string; label: string; terms: Array<{ id: number; name: string; slug: string; count: number }>; more?: boolean }>;
  authors: Array<{ id: number; name: string }>;
  roles?: Array<{ name: string; label: string }>;
}

/** A JSON data source (docs/spec/data.md), kept with the queries in the site settings. */
/** A source written in the builder, or read from an address (doc 26 voce 214, docs/spec/data.md). */
export type JsonSource = { type: 'json'; data: unknown } | { type: 'url'; url: string; path?: string; ttl?: number };

export interface AgentSessionInfo {
  user: number;
  userName: string;
  mine: boolean;
  started: number;
  last: number;
  writes: number;
  active: boolean;
  docs: Array<{ doc: string; label: string }>;
}

export interface SiteScript {
  id: string;
  label: string;
  src: string;
  /** `site`, or `type:<post type>` for the pages of one type and its archive. */
  scope: string;
  position: 'head' | 'footer';
  strategy: 'defer' | 'async' | 'module' | 'blocking';
  /** Required for a file of another site: `sha384-…`. */
  integrity: string;
}

export interface SiteScriptsData {
  scripts: SiteScript[];
  canWrite: boolean;
  types: string[];
  head: string;
  base: string;
}

export interface AgentContentItem {
  id: number;
  type: string;
  typeLabel: string;
  title: string;
  status: string;
  modified: string;
}

export interface AgentContent {
  id: number;
  type: string;
  title: string;
  excerpt: string;
  status: string;
  link: string;
  fields: Record<string, unknown>;
}

export interface QueriesData {
  presets: Presets;
  sources?: Record<string, JsonSource>;
  /** Post types loops may list (viewable, or allowed by an administrator). */
  types: Array<{ name: string; label: string }>;
  head: string;
  base: string;
}

/** A custom field of another plugin (ACF, SCF, JetEngine, Meta Box), with whether pages can read it. */
export interface ProviderField {
  id: string;
  provider: string;
  name: string;
  label: string;
  type: string;
  group: string;
  groupLabel: string;
  postTypes: string[];
  /** The options page the field belongs to (D5): read as site.options.<page>.<name>. */
  optionsPage?: string | null;
  /** Published by the plugin itself in the REST API: already public. */
  rest: boolean;
  supported: boolean;
  sub: Array<{ name: string; label: string; type: string }>;
  readable: boolean;
}

/** Content Hub (docs/spec/content.md): definitions in dev, the live ones, and the fields of other plugins. */
export interface ContentData {
  content: ContentDefs;
  live: ContentDefs;
  publicFields: string[];
  providers: Array<{ id: string; label: string; fields: ProviderField[] }>;
  /** `rest`: the route of the type in WordPress's REST API (`wp/v2/evento`), when the user can edit it there. */
  /** `count`: contents of the type (not trashed), so removing a published type can say what it leaves. */
  postTypes: Array<{ name: string; label: string; own: boolean; rest?: string | null; count?: number }>;
  /** Taxonomies whose terms this user may manage, with their REST route (doc 26 voce 212). Absent from older servers. */
  termTaxonomies?: Array<{ name: string; label: string; hierarchical: boolean; rest: string }>;
  canManage: boolean;
  head: string;
  base: string;
}

/** What the site's PHP offers the builder (docs/spec/php.md). */
export interface SiteExtensions {
  data: Array<{ name: string; description: string }>;
  modifiers: string[];
  blocks: Array<{ name: string; title: string }>;
}

export interface FacetTest {
  error?: string;
  total: number;
  pages: number;
  titles: string[];
  filters: Array<{ key: string; label: string; options: Array<{ value: string; label: string; count: number | null; selected: boolean }> }>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  constructor(private readonly config: BuilderConfig) {}

  /** A first answer the page already holds (BuilderConfig.boot), once; later calls ask the server. */
  private boot<T>(key: 'document' | 'styles' | 'components'): Promise<T> | null {
    const boot = this.config.boot;
    if (!boot || boot[key] === undefined) return null;
    const value = boot[key] as T;
    delete boot[key];
    return Promise.resolve(value);
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': this.config.nonce, Accept: 'application/json' },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    if (signal) init.signal = signal;
    const response = await fetch(this.config.restUrl + route, init);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (data ?? {}) as { message?: string; code?: string };
      throw new ApiError(error.message ?? t('Errore {0}', response.status), response.status, error.code ?? 'xb_error');
    }
    return data as T;
  }

  /** A route of WordPress's own REST API (`wp/v2/evento`), with the same nonce: WordPress checks every permission. */
  private coreUrl(route: string): string {
    const base = this.config.restUrl;
    const root = base.slice(0, base.lastIndexOf('xb/v1'));
    // Plain permalinks: `?rest_route=/xb/v1/` — further parameters follow with `&`.
    return root + (root.includes('?') ? route.replace('?', '&') : route);
  }

  async core<T>(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<{ data: T; total: number }> {
    const init: RequestInit = { method, credentials: 'same-origin', headers: { 'X-WP-Nonce': this.config.nonce, Accept: 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    const response = await fetch(this.coreUrl(route), init);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (data ?? {}) as { message?: string; code?: string };
      throw new ApiError(error.message ?? t('Errore {0}', response.status), response.status, error.code ?? 'rest_error');
    }
    return { data: data as T, total: Number(response.headers.get('X-WP-Total') ?? 0) };
  }

  getDocument(id: number): Promise<DocumentData> {
    const boot = id === this.config.postId ? this.boot<DocumentData>('document') : null;
    if (boot) return boot.then((doc) => (this.bootContent = doc.content, doc));
    return this.call('GET', `documents/${id}`);
  }

  /** The content the page's own first drawing was requested for (V6). */
  private bootContent: string | null = null;

  /**
   * Saves in development. The answer repeats the content only when the server changed it (filters, a merge):
   * otherwise it is `unchanged` and the content is the one sent.
   */
  async saveDocument(id: number, content: string, head: string, base: string, extras: SaveExtras = {}): Promise<DocumentData> {
    const doc = await this.call<DocumentData & { unchanged?: boolean }>('POST', `documents/${id}`, { content, head, base, lean: true, ...extras });
    return doc.unchanged ? { ...doc, content } : doc;
  }

  getChanges(): Promise<Change[]> {
    return this.call('GET', 'changes');
  }

  exportRelease(id: number): Promise<Record<string, unknown>> {
    return this.call('GET', `releases/${id}/export`);
  }

  importRelease(data: unknown, write: boolean, choice: { trust?: boolean; allowUnsigned?: boolean } = {}): Promise<ImportReport> {
    return this.call('POST', 'releases/import', { data, write, ...choice });
  }

  diffChange(doc: string): Promise<{ doc: string; label: string; prod: Record<string, unknown> | null; dev: Record<string, unknown> | null }> {
    return this.call('GET', `changes/diff?doc=${encodeURIComponent(doc)}`);
  }

  listReleases(): Promise<ReleaseList> {
    return this.call('GET', 'releases');
  }

  /** «Programma per…» (docs/spec/versioning.md §11): `at` as the datetime field writes it, in the site's time zone. */
  scheduleRelease(at: string, version: string, notes: string, docs: string[], checks: ChecksOutcome | null = null): Promise<ScheduledView> {
    return this.call('POST', 'releases/schedule', checks ? { at, version, notes, docs, checks } : { at, version, notes, docs });
  }

  /** Cancels the scheduled release; with `last`, closes the line with the outcome of the last one instead. */
  cancelSchedule(last = false): Promise<{ cancelled?: boolean; dismissed?: boolean }> {
    return this.call('DELETE', 'releases/schedule', last ? { last: true } : undefined);
  }

  /** checks: the outcome of a finished round of page checks, kept with the release as a reminder; left out when there is none. */
  publish(version: string, notes: string, docs: string[], checks: ChecksOutcome | null = null): Promise<{ id: number; version: string; docs: string[]; merged: number; conflicts: number }> {
    return this.call('POST', 'releases', checks ? { version, notes, docs, checks } : { version, notes, docs });
  }

  restore(id: number, keepContent: boolean): Promise<{ id: number; version: string; docs: string[] }> {
    return this.call('POST', `releases/${id}/restore`, { keepContent });
  }

  deployStatus(): Promise<DeployStatus> {
    return this.call('GET', 'deploy');
  }

  deploy(): Promise<{ id: number; version: string; files: number; uploaded: number; warnings?: string[] }> {
    return this.call('POST', 'deploy');
  }

  rollbackDeploy(id: number): Promise<{ id: number; version: string; warnings?: string[] }> {
    return this.call('POST', `deploy/${id}/rollback`);
  }

  /** Hosts a source may be read from (doc 26 voce 214), chosen by an administrator. */
  sourceHosts(): Promise<{ hosts: string[]; canChange: boolean }> {
    return this.call('GET', 'sources/hosts');
  }

  saveSourceHosts(hosts: string[]): Promise<{ hosts: string[]; canChange: boolean }> {
    return this.call('POST', 'sources/hosts', { hosts });
  }

  /** The data at an address, read now without keeping a copy: the preview of a source by address. */
  testSource(url: string, path = ''): Promise<{ data: unknown }> {
    return this.call('POST', 'sources/test', { url, path });
  }

  /** What the agent may change on this site (doc 26 voce 215). */
  agentScopes(): Promise<{ enabled: string[]; canChange: boolean }> {
    return this.call('GET', 'agent-scopes');
  }

  saveAgentScopes(scopes: string[]): Promise<{ enabled: string[]; canChange: boolean }> {
    return this.call('POST', 'agent-scopes', { scopes });
  }

  /** Contents for the agent (voce 216): search, read, change title, excerpt and fields. */
  searchContent(search = '', type = '', page = 1): Promise<{ items: AgentContentItem[]; pages: number }> {
    return this.call('GET', `agent/contents?search=${encodeURIComponent(search)}&type=${encodeURIComponent(type)}&page=${page}`);
  }

  getAgentContent(id: number): Promise<AgentContent> {
    return this.call('GET', `agent/contents/${id}`);
  }

  updateAgentContent(id: number, change: { title?: string; excerpt?: string; fields?: Record<string, unknown> }): Promise<AgentContent> {
    return this.call('POST', `agent/contents/${id}`, change);
  }

  library(type: 'page' | 'post' | 'wp_block', search = ''): Promise<{ items: LibraryItem[] }> {
    return this.call('GET', `library?type=${type}&search=${encodeURIComponent(search)}`);
  }

  listTemplates(): Promise<{ items: TemplateItem[] }> {
    return this.call('GET', 'templates');
  }

  openTemplate(type: string, id: string): Promise<{ post: number }> {
    return this.call('POST', 'templates', { type, id });
  }

  getNamedQueries(): Promise<{ queries: Record<string, string>; head: string; base: string }> {
    return this.call('GET', 'named-queries');
  }

  saveNamedQueries(queries: Record<string, string>, head: string, base: string): Promise<{ head: string; base: string }> {
    return this.call('POST', 'named-queries', { queries, head, base });
  }

  extensions(): Promise<SiteExtensions> {
    return this.call('GET', 'extensions');
  }

  /** The user's changes to the keyboard shortcuts (docs/spec/shortcuts.md). */
  saveShortcuts(shortcuts: Record<string, string[]>): Promise<{ shortcuts: Record<string, string[]> }> {
    return this.call('POST', 'shortcuts', { shortcuts });
  }

  /** Facets of the settings in dev (docs/spec/facets.md). */
  /** Comments and approval left on the signed preview (docs/spec/review.md). */
  reviewComments(postId: number): Promise<ReviewData> {
    return this.call('GET', `review/comments?post=${postId}`);
  }

  setCommentStatus(id: number, status: 'open' | 'resolved'): Promise<{ ok: true }> {
    return this.call('POST', `review/comments/${id}`, { status });
  }

  deleteComment(id: number): Promise<{ ok: true }> {
    return this.call('DELETE', `review/comments/${id}`);
  }

  /** A YouTube or Vimeo video for the page (E9): title, player addresses, the poster downloaded into the library. */
  videoInfo(url: string): Promise<VideoInfo> {
    return this.call('POST', 'video', { url });
  }

  /** The site's local fonts and the Google Fonts catalog bundled with the plugin (E2, docs/spec/fonts.md). */
  getFonts(): Promise<FontsData> {
    return this.call('GET', 'fonts');
  }

  /** Downloads a Google Fonts family to the site, once, on the server (administrators). */
  importGoogleFont(family: string, weights: number[], italic: boolean): Promise<FontsData> {
    return this.call('POST', 'fonts/google', { family, weights, italic });
  }

  removeFont(family: string): Promise<FontsData> {
    return this.call('DELETE', `fonts?family=${encodeURIComponent(family)}`);
  }

  /** Histeon Tokens values of the site, in dev (docs/spec/design-system.md). */
  getTokens(): Promise<{ tokens: Record<string, string>; names: string[]; editable: boolean; head: string; base: string; design?: DesignParams; defaults?: DesignParams; contrast?: ContrastPair[]; siteTokens?: Record<string, string>; recipes?: RecipeSources }> {
    return this.call('GET', 'tokens');
  }

  /** Token values and, with Histeon CSS, the design parameters (docs/spec/histos-css.md §1): one dev commit. */
  saveTokens(tokens: Record<string, string>, head: string, base: string, design?: DesignParams, site?: { siteTokens?: Record<string, string>; recipes?: Record<string, string> }): Promise<{ head: string; base: string }> {
    return this.call('POST', 'tokens', { tokens, head, base, ...(design === undefined ? {} : { design }), ...(site?.siteTokens ? { siteTokens: site.siteTokens } : {}), ...(site?.recipes ? { recipes: site.recipes } : {}) });
  }

  /** The tokens some design parameters change, as `:root{…}` built by the server from validated values. Nothing is saved. */
  previewDesign(design: DesignParams): Promise<{ css: string; design: DesignParams; contrast?: ContrastPair[] }> {
    return this.call('POST', 'design/preview', { design });
  }

  /** Every token some design parameters print, light and dark (null without the dark theme), for the DTCG export. */
  async designTokens(design: DesignParams): Promise<{ light: Record<string, string>; dark: Record<string, string> | null }> {
    const r = await this.call<{ tokens?: { light?: Record<string, string>; dark?: Record<string, string> | null } }>('POST', 'design/preview', { design, tokens: true });
    return { light: r.tokens?.light ?? {}, dark: r.tokens?.dark ?? null };
  }

  getFacets(): Promise<{ facets: Facets; head: string; base: string }> {
    return this.call('GET', 'facets');
  }

  saveFacets(facets: Facets, head: string, base: string): Promise<{ head: string; base: string }> {
    return this.call('POST', 'facets', { facets, head, base });
  }

  testFacet(facet: Facet, params: Record<string, string>, signal?: AbortSignal): Promise<FacetTest> {
    return this.call('POST', 'facets/test', { facet, params }, signal);
  }

  getContent(): Promise<ContentData> {
    return this.call('GET', 'content');
  }

  /** Moves the contents of a type to another one, or trashes them; up to 200 per call (`left`: what remains). */
  moveContentItems(type: string, action: 'trash' | 'move', to = ''): Promise<{ done: number; skipped: number; left: number }> {
    return this.call('POST', 'content/items', { type, action, to });
  }

  saveContent(content: ContentDefs, publicFields: string[], head: string, base: string): Promise<{ head: string; base: string }> {
    return this.call('POST', 'content', { content, publicFields, head, base });
  }

  /** The AI agent's sessions with changes (lista della spesa 158): own, and everyone's for an administrator. */
  getAgentSessions(): Promise<AgentSessionInfo[]> {
    return this.call('GET', 'agent-sessions');
  }

  /** Keeps or undoes what an agent's session changed. */
  agentSession(user: number, action: 'keep' | 'undo'): Promise<{ kept?: boolean; restored?: string[]; failed?: Record<string, string> }> {
    return this.call('POST', `agent-sessions/${user}`, { action });
  }

  /** The site's own scripts (lista della spesa 148): the development copy, and whether this user may change it. */
  getSiteScripts(): Promise<SiteScriptsData> {
    return this.call('GET', 'site-scripts');
  }

  saveSiteScripts(scripts: SiteScript[], head: string, base: string): Promise<{ head: string; base: string }> {
    return this.call('POST', 'site-scripts', { scripts, head, base });
  }

  getQueries(): Promise<QueriesData> {
    return this.call('GET', 'queries');
  }

  saveQueries(presets: Presets, head: string, base: string, sources?: Record<string, JsonSource>): Promise<{ head: string; base: string }> {
    return this.call('POST', 'queries', { presets, head, base, ...(sources ? { sources } : {}) });
  }

  /** With `groupBy` (a grouped loop, doc 23 of Publish item 205) also its groups: each key with how many records. */
  testQuery(id: string, preset: Preset, params: Record<string, unknown>, signal?: AbortSignal, groupBy?: LoopGroupBy): Promise<{ items: QueryRecord[]; groups?: QueryGroup[] }> {
    return this.call('POST', 'queries/test', groupBy ? { id, preset, params, groupBy } : { id, preset, params }, signal);
  }

  /** Taxonomies with their terms and authors, for the visual query builder. */
  /** Terms of a taxonomy by name, or by id (`include`), beyond the 200 of `queryOptions` (doc 26 voce 222). */
  queryTerms(taxonomy: string, search: string, include: number[] = []): Promise<{ terms: Array<{ id: number; name: string; slug: string; count: number }> }> {
    return this.call('GET', `queries/terms?taxonomy=${encodeURIComponent(taxonomy)}&search=${encodeURIComponent(search)}&include=${include.join(',')}`);
  }

  queryOptions(type: string): Promise<QueryOptions> {
    return this.call('GET', `queries/options?type=${encodeURIComponent(type)}`);
  }

  /** The signed dev preview of a post, and its page as visitors see it now (null: none, or not online yet). */
  /** `as`: the role the page is seen as (lista della spesa 161), one of `roles`; '' for the real visitor. */
  /** `ttl`: how long the link lasts, 3600, 86400, 172800 or 604800 (the server refuses any other); none: 48 hours. */
  previewLink(postId: number, context = 0, as = '', ttl?: number): Promise<{ url: string; expires?: number | null; live?: string | null; roles?: Record<string, string> }> {
    return this.call('GET', `preview-link?post=${postId}&context=${context}${as ? `&as=${encodeURIComponent(as)}` : ''}${ttl ? `&ttl=${ttl}` : ''}`);
  }

  createComponent(ref: string, title: string, content = ''): Promise<DocumentData> {
    return this.call('POST', 'components', { ref, title, content });
  }

  /** Pasted markup and styles held to the restricted tier (docs/spec/quick-actions.md §5). */
  sanitizePaste(content: string, styles: Array<{ selector: string; css: string }>): Promise<{ content: string; styles: Array<{ selector: string; css: string }> }> {
    return this.call('POST', 'paste/sanitize', { content, styles });
  }

  render(postId: number, content: string, signal?: AbortSignal, context = 0, options: { css?: boolean; known?: Preview | null; schema?: string } = {}): Promise<Preview> {
    const known = options.known ?? null;
    // The drawing the page asked for before the bundle ran, if it is of this very content.
    const early = this.config.boot?.render;
    if (early && this.bootContent === content && postId === this.config.postId && context === 0 && !options.css && !known && !options.schema) {
      delete this.config.boot!.render;
      this.bootContent = null;
      return early.then((data) => (data && typeof data === 'object' && 'html' in data ? ({ ...(data as RenderData), globalCss: (data as RenderData).globalCss ?? '' }) : this.render(postId, content, signal, context, options)));
    }
    const extra = options.schema ? { schema: options.schema } : {};
    return this.call<RenderData>('POST', 'render', { post_id: postId, content, context, css: options.css === true, global_hash: known?.globalHash ?? '', ...extra }, signal).then((data) => ({
      ...data,
      globalCss: data.globalCss ?? (known && known.globalHash === data.globalHash ? known.globalCss : ''),
    }));
  }

  getStyles(): Promise<StylesData> {
    return this.boot<StylesData>('styles') ?? this.call('GET', 'styles');
  }

  saveStyles(styles: StyleEntry[], globals: GlobalSheet[], head: string, base: string): Promise<StylesData> {
    return this.call('POST', 'styles', { styles, globals, head, base });
  }

  getFramework(): Promise<FrameworkData> {
    return this.call('GET', 'framework');
  }

  listSelectors(): Promise<SelectorList> {
    return this.call('GET', 'selectors');
  }

  renameSelector(from: string, to: string, dryRun: boolean, html: Array<{ id: string; before: string }> = []): Promise<RenamePlan> {
    return this.call('POST', 'selectors/rename', { from, to, dryRun, html });
  }

  /** A class or id always included in the CSS (safelist, Settings → Histeon): C6. */
  setSafelisted(name: string, on: boolean): Promise<{ safelist: string[] }> {
    return this.call('POST', 'selectors/safelist', { name, on });
  }

  deleteSelectors(ids: string[]): Promise<{ deleted: string[] }> {
    return this.call('POST', 'selectors/delete', { ids });
  }

  listComponents(): Promise<ComponentInfo[]> {
    return this.boot<ComponentInfo[]>('components') ?? this.call('GET', 'components');
  }

  // ---- section library (docs/spec/library.md)
  listSections(): Promise<{ sections: LibrarySection[] }> {
    return this.call('GET', 'sections');
  }

  saveSection(name: string, clip: string): Promise<{ id: string }> {
    return this.call('POST', 'sections', { name, clip });
  }

  getSection(id: string): Promise<{ clip: string }> {
    return this.call('GET', `sections/${encodeURIComponent(id)}`);
  }

  deleteSection(id: string): Promise<{ deleted: boolean }> {
    return this.call('DELETE', `sections/${encodeURIComponent(id)}`);
  }

  exportSections(): Promise<unknown> {
    return this.call('GET', 'sections/export');
  }

  /** `media`: pictures the file carried and this site now has (M2). */
  importSections(data: unknown): Promise<{ added: number; skipped: number; media?: number }> {
    return this.call('POST', 'sections/import', { data });
  }

  /** Fluent Forms' forms, and its editor's addresses (docs/spec/fluent-forms.md). */
  fluentForms(): Promise<{ forms: Array<{ id: number; title: string }>; editUrl: string; newUrl: string; block: string }> {
    return this.call('GET', 'integrations/fluentforms');
  }
}

/** A section of the library, without its clip. */
export interface LibrarySection {
  id: string;
  name: string;
  origin: string;
  author: number;
  created: string;
  size: number;
}
