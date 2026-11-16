import { t } from './i18n.ts';
import { originsOf } from './canvasPolicy.ts';
import { COMBO } from './shortcuts.ts';

/** `wp_get_environment_type()` values. */
export const ENVIRONMENT_TYPES = ['local', 'development', 'staging', 'production'] as const;

export interface TemplateInfo {
  part: boolean;
  slug: string;
  /** Posts the template can be previewed with (empty: it renders a list). */
  samples: Array<{ id: number; title: string }>;
}

function templateInfo(value: unknown): TemplateInfo | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const samples = Array.isArray(v.samples)
    ? v.samples.filter((s): s is { id: number; title: string } => !!s && typeof s === 'object' && Number.isInteger((s as { id?: unknown }).id) && typeof (s as { title?: unknown }).title === 'string')
    : [];
  return { part: v.part === true, slug: typeof v.slug === 'string' ? v.slug : '', samples };
}

/** Server-provided configuration (plugin/src/Admin/BuilderScreen.php). */
/**
 * What the builder page already holds when the bundle starts (V6): the answers of the first requests, written
 * by the server into the page, and the first drawing of the canvas, requested by a small script before the
 * bundle loads. Each is used once, by Api.
 */
export interface BuilderBoot {
  document?: unknown;
  styles?: unknown;
  components?: unknown;
  /** The canvas drawing of `document.content`, or null when that request failed. */
  render?: Promise<unknown>;
}

export interface BuilderConfig {
  /** See BuilderBoot. */
  boot?: BuilderBoot;
  restUrl: string;
  nonce: string;
  postId: number;
  title: string;
  editUrl: string | null;
  viewUrl: string | false | null;
  trusted: boolean;
  canPublish: boolean;
  /** Static Bridge keeps a static copy of the site and refreshes it after each release. */
  staticBridge: boolean;
  /** Publish only after the page checks found no error (Histeon → Impostazioni). */
  checksBlock: boolean;
  /** WordPress lets search engines index the site (Settings → Reading, `blog_public`); read only, for the page checks. */
  blogPublic: boolean;
  /** Administrator: release export and import. */
  canManage: boolean;
  /** Client mode (docs/spec/client-mode.md): only texts and pictures change. */
  contentOnly: boolean;
  /** Client mode with `xb_edit_props` (list 135): literal props of component instances change too. */
  contentProps: boolean;
  /** Client mode on a page he may only see (voce 186): the builder opens, nothing is saved. */
  viewOnly: boolean;
  /** Client mode: the mini GUI groups he may use on this page's own look (voce 186), [] for none. */
  lookGroups: string[];
  /** Fluent Forms is active and this user may edit its forms (docs/spec/fluent-forms.md). */
  fluentForms: boolean;
  /** Set when the document is an FSE template or template part. */
  template: TemplateInfo | null;
  /** WordPress media library over REST (the image picker). */
  media: { url: string | null; canUpload: boolean; maxBytes: number; encoder: string | null };
  locale: string;
  /** The XB screens in wp-admin (overview, this document's versions, releases). */
  admin: { overview: string | null; history: string | null; releases: string | null; templates: string | null };
  /** Dashboard of the installed CSS framework (ACSS or Core Framework), on this site's admin. */
  framework: { id: string; label: string; url: string } | null;
  /** This document's language and its translations, from a language plugin (docs/spec/multilingual.md). */
  languages: Languages | null;
  /** Opened over Gutenberg (an iframe of the editor page): closing hands control back to it. */
  embed: boolean;
  /** The user's changes to the keyboard shortcuts (docs/spec/shortcuts.md). */
  shortcuts: Record<string, string[]>;
  /** Where to download the Histeon Connector (docs/spec/connector.md). */
  connector: string | null;
  /** Origins the canvas may load images, fonts and styles from, besides the builder's own (S5). */
  canvasOrigins: string[];
  /** The icon library bundled with the plugin (E10): a JSON file read when the icon dialog opens. */
  icons: string | null;
  /** Pairing with the Histeon Connector: admin origin, this user's secret, the link that makes a new one. */
  connectorPair: { origin: string; secret: string; rotate: string | null } | null;
  /** What the agent may change on this site, and whether this user may choose it (doc 26 voce 215). */
  agentScopes: { enabled: string[]; canChange: boolean };
  /** Where the builder runs, for window.xb.environment (doc 26 voce 220). */
  environment: { type: (typeof ENVIRONMENT_TYPES)[number]; histeon: string; wordpress: string; multisite: boolean };
}

declare global {
  interface Window {
    xbBuilder?: BuilderConfig;
  }
}

/** A framework dashboard is shown in a frame of the builder only if it is a page of this same admin. */
function frameworkPanel(value: unknown): BuilderConfig['framework'] {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const url = safeUrl(v.url);
  if (!url || typeof v.id !== 'string' || typeof v.label !== 'string') return null;
  const parsed = new URL(url);
  if (parsed.origin !== window.location.origin || !parsed.pathname.endsWith('/wp-admin/admin.php')) return null;
  return { id: v.id, label: v.label, url };
}

/** Only http(s) URLs (absolute, or relative to this page) end up in an href or a navigation. */
export interface LanguageItem {
  code: string;
  label: string;
  state: 'current' | 'publish' | 'draft' | 'missing';
  /** Same-site admin link: open the translation in the builder, or create it. */
  url: string | null;
}
export interface Languages {
  current: string;
  items: LanguageItem[];
  /** The original's texts (a translation only), for the untranslated-text check. */
  source: string[];
}

/** Only well-formed entries, links of this site only (the server checked them already). */
export function languagesOf(value: unknown): Languages | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { current?: unknown; items?: unknown; source?: unknown };
  const items: LanguageItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!it || typeof it !== 'object') continue;
    const { code, label, state, url } = it as Record<string, unknown>;
    if (typeof code !== 'string' || !/^[A-Za-z0-9-]{1,35}$/.test(code)) continue;
    if (state !== 'current' && state !== 'publish' && state !== 'draft' && state !== 'missing') continue;
    const href = safeUrl(url);
    items.push({ code, label: typeof label === 'string' ? label : code.toUpperCase(), state, url: href && new URL(href).origin === window.location.origin ? href : null });
  }
  if (!items.length) return null;
  return {
    current: typeof raw.current === 'string' ? raw.current : '',
    items,
    source: (Array.isArray(raw.source) ? raw.source : []).filter((t): t is string => typeof t === 'string').slice(0, 300),
  };
}

export function pairOf(value: unknown): { origin: string; secret: string; rotate: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const { origin, secret, rotate } = value as Record<string, unknown>;
  if (typeof origin !== 'string' || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const href = safeUrl(rotate);
  return { origin, secret, rotate: href && new URL(href).origin === window.location.origin ? href : null };
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Only well-formed entries: command id => combinations (the server checked them already). */
function shortcutsOf(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [id, combos] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(combos)) out[id] = combos.filter((c): c is string => typeof c === 'string' && COMBO.test(c));
  }
  return out;
}

function environmentOf(value: unknown): BuilderConfig['environment'] {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const type = ENVIRONMENT_TYPES.find((e) => e === v.type) ?? 'production';
  return { type, histeon: typeof v.histeon === 'string' ? v.histeon : '', wordpress: typeof v.wordpress === 'string' ? v.wordpress : '', multisite: v.multisite === true };
}

export function readConfig(): BuilderConfig {
  const config = window.xbBuilder;
  if (!config) throw new Error(t('Configurazione del builder mancante'));
  return {
    ...config,
    editUrl: safeUrl(config.editUrl),
    viewUrl: config.viewUrl === false ? false : safeUrl(config.viewUrl),
    postId: Number.isInteger(config.postId) ? config.postId : 0,
    trusted: config.trusted === true,
    canPublish: config.canPublish === true,
    staticBridge: config.staticBridge === true,
    checksBlock: config.checksBlock === true,
    blogPublic: config.blogPublic !== false,
    canManage: config.canManage === true,
    contentOnly: config.contentOnly === true,
    contentProps: config.contentOnly === true && config.contentProps === true,
    viewOnly: config.contentOnly === true && config.viewOnly === true,
    lookGroups: config.contentOnly === true && Array.isArray(config.lookGroups) ? config.lookGroups.filter((g): g is string => typeof g === 'string') : [],
    fluentForms: config.fluentForms === true,
    embed: config.embed === true && window.parent !== window,
    shortcuts: shortcutsOf(config.shortcuts),
    connector: safeUrl(config.connector),
    icons: safeUrl(config.icons),
    canvasOrigins: originsOf(Array.isArray(config.canvasOrigins) ? config.canvasOrigins.filter((o): o is string => typeof o === 'string') : []),
    connectorPair: pairOf(config.connectorPair),
    environment: environmentOf(config.environment),
    agentScopes: {
      enabled: Array.isArray(config.agentScopes?.enabled) ? config.agentScopes.enabled.filter((s): s is string => typeof s === 'string') : [],
      canChange: config.agentScopes?.canChange === true,
    },
    framework: frameworkPanel(config.framework),
    languages: languagesOf(config.languages),
    admin: {
      overview: safeUrl((config.admin as { overview?: unknown } | undefined)?.overview),
      history: safeUrl((config.admin as { history?: unknown } | undefined)?.history),
      releases: safeUrl((config.admin as { releases?: unknown } | undefined)?.releases),
      templates: safeUrl((config.admin as { templates?: unknown } | undefined)?.templates),
    },
    template: templateInfo(config.template),
    media: {
      url: safeUrl((config.media as { url?: unknown } | undefined)?.url),
      canUpload: (config.media as { canUpload?: unknown } | undefined)?.canUpload === true,
      maxBytes: Number((config.media as { maxBytes?: unknown } | undefined)?.maxBytes) || 0,
      // The image encoder's worker (lista migliorie M5), served by the plugin.
      encoder: safeUrl((config.media as { encoder?: unknown } | undefined)?.encoder),
    },
  };
}
