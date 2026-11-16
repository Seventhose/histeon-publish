// The builder's public JavaScript API (docs/spec/js-api.md): `window.xb`, for tools and agents running in the
// builder page. It only does what the builder's own controls do, on the same state, with the same checks: no
// new permission, and every save still goes through the server's filters and versioning.
import { childrenOf, cssLint, parse, parseXb, print, randomUid, reconcileUids, roundTrips, serializeXb, type XbBlock } from '@xb/dsl';
import { canDrop, conditionalClasses, describe, findBlock, replaceBlock, staticClasses, staticId } from './tree.ts';
import { lintContext } from './cssLint.ts';
import { makeClip, readClip } from './clip.ts';
import { copiedHere, rememberCopy } from './pasteTrust.ts';
import { applyPaste, preparePaste } from './pastePlan.ts';
import { sectionBrief } from './sectionBrief.ts';
import { runChecks } from './checks.ts';
import { removeAttribute, setAttribute, setText } from './attributes.ts';
import type { BuilderState } from './state.svelte.ts';
import type { AgentContent, AgentContentItem, ContentData, JsonSource, PropDefinition, QueriesData, SiteExtensions } from './api.ts';
import type { Preset as QueryPreset } from './queries.ts';
import { componentProblem } from './speed.ts';
import { PRESETS, fromSite, type Collection, type Preset } from './mediaManager.ts';
import type { LibraryItem, MediaFilter, MediaLibrary } from './mediaLibrary.ts';
import type { Facets } from './facets.ts';

export const API_VERSION = 1;

type Event = 'change' | 'select' | 'save';
type Listener = (detail: unknown) => void;

/** Computed styles getView reports: layout, box, type and colour, the properties a visual change touches. */
const VIEW_PROPERTIES = ['display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'grid-template-columns', 'flex-direction', 'justify-content', 'align-items', 'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'border', 'border-radius', 'box-shadow', 'opacity', 'overflow'];

export interface AgentView {
  canvas: { width: number; height: number };
  selection: {
    uid: string;
    label: string;
    tag: string;
    selectors: string[];
    styles: Array<{ selector: string; css: string }>;
    computed: Record<string, string> | null;
    box: { x: number; y: number; width: number; height: number } | null;
  } | null;
  outline: Array<{ uid: string; tag: string; class: string; box: { x: number; y: number; width: number; height: number } }>;
}

/** Where the builder runs (lista 220): for tools and agents that adapt to it. */
export interface XbEnvironment {
  /** `wp_get_environment_type()`: local, development, staging or production. */
  type: 'local' | 'development' | 'staging' | 'production';
  histeon: string;
  wordpress: string;
  multisite: boolean;
  /** The builder's language (`it_IT`, `en_US`…). */
  locale: string;
  /** The site's CSS framework, as the Framework panel names it. */
  framework: string;
  /** What the builder edits and saves: always the development version, publishing is a person's. */
  version: 'dev';
}

export interface XbApi {
  version: number;
  environment: XbEnvironment;
  /** The page as builder HTML (the HTML panel's text). */
  getHtml(): string;
  /** Replaces the page with builder HTML; uids of unchanged elements are kept. Throws on a syntax error. */
  setHtml(html: string): void;
  /** A copy of the block tree. */
  getTree(): XbBlock[];
  getSelection(): string | null;
  select(uid: string | null): void;
  /** Builder HTML of one element. */
  getElementHtml(uid: string): string | null;
  /** Inserts builder HTML inside or after the selection, like the + menu. Returns the new uids. */
  insert(html: string): string[];
  /**
   * Copies elements with their styles as the builder's clipboard does (Ctrl+C): the clip, a text to paste here, in
   * another tab or on another Histeon site.
   */
  copy(uids: string[]): string;
  /**
   * Pastes a clip like Ctrl+V, after or inside `target` (or the selection): what this tab did not copy goes through
   * the server's checks first; a class that clashes with this site's is renamed, or keeps this site's with
   * `classes: 'keep'`. Returns the new uids.
   */
  paste(clip: string, options?: { target?: string | null; classes?: 'rename' | 'keep' }): Promise<string[]>;
  remove(uid: string): void;
  /** Replaces the text of an element that holds only text (expressions `{…}` allowed), as the Properties panel. */
  setText(uid: string, text: string): void;
  /** Sets one attribute of an element; `null` removes it, `true` writes it without a value. */
  setAttribute(uid: string, name: string, value: string | true | null): void;
  /** Moves an element before, after or inside another one, where the structure panel allows it. */
  move(uid: string, target: string, position: 'before' | 'after' | 'inside'): void;
  /** CSS of a selector (`.card`), as written in the CSS panel. */
  getCss(selector: string): string;
  setCss(selector: string, css: string): void;
  /** Selectors with styles. */
  listStyles(): string[];
  /** The CSS lint of the CSS panel for a selector's CSS (docs/spec/styles.md): what an agent should fix. */
  lintCss(selector: string, css: string): AgentWarning[];
  /** Markup the site's way of styling would not want: classes outside BEM, chains of utilities, inline styles. */
  lintHtml(html: string): AgentWarning[];
  /** The Checks panel on the page as drawn (alt, contrast, headings, CSS of the selectors used), read only. */
  getChecks(): AgentWarning[];
  /**
   * What the person sees (lista della spesa 159), read only: the selected element with its selectors and their CSS,
   * its computed styles and box in the canvas, the canvas width, and the boxes of the page's top elements.
   */
  getView(): AgentView;
  /** The open document: id, type, title, component key, unsaved changes. */
  getDocument(): { id: number; type: string; title: string; ref: string | null; dirty: boolean; published: boolean } | null;
  /** The site's CSS framework: its variables (names, groups and, when the stylesheet says, values) and classes. */
  getFramework(): { framework: string; variables: Array<{ name: string; group: string; value?: string }>; classes: Array<{ name: string; group: string }> };
  /** The site's components with their props. */
  getComponents(): Array<{ ref: string; title: string; props: Record<string, unknown> }>;
  /** The preview as rendered by the server (dev version), after the pending changes. */
  render(): Promise<{ html: string; css: string }>;
  /**
   * What an agent needs to know about this site to work its way (docs/spec/connector.md §5): framework and its
   * variables by group with their values, semantic tokens, named media queries, the names loops can read (loop
   * queries, data sources, facets, content types and fields), BEM blocks already styled, components.
   */
  getBrief(): Promise<SiteBrief>;
  /** The site's library sections (lista della spesa 166): ids and names, no markup. */
  listSections(): Promise<Array<{ id: string; name: string; origin: string }>>;
  /** A library section as instructions: its parts, roles and layout with this project's tokens, never its markup. */
  getSectionBrief(id: string): Promise<string>;
  /** Turns an element into a new component (`ref` like `card` or `ui/card`); the element becomes an instance. */
  createComponent(uid: string, ref: string, title: string): Promise<void>;
  /** BEM classes for an element's children without a class (`block__part`); returns the classes added. */
  applyBem(uid: string): string[];
  // Media library (doc 26 voci 209-210): WordPress's permissions apply; no file is ever deleted from here.
  listMedia(filter?: MediaFilter): Promise<{ items: LibraryItem[]; pages: number }>;
  getMedia(id: number): Promise<LibraryItem>;
  /** A file into the library, through the builder's encoder for images (preset `web` unless another is named). */
  uploadMedia(file: File, options?: { collection?: number; preset?: string }): Promise<LibraryItem>;
  setMediaAlt(id: number, alt: string): Promise<LibraryItem>;
  /** All the collections a file belongs to ([] takes it out of every one). */
  setMediaCollections(id: number, collections: number[]): Promise<LibraryItem>;
  listCollections(): Promise<Collection[]>;
  createCollection(name: string, parent?: number): Promise<Collection>;
  updateCollection(id: number, change: { name?: string; parent?: number }): Promise<Collection>;
  /** The collection goes; its files stay in the library. */
  deleteCollection(id: number): Promise<void>;
  /** An image made lighter where it is, same address, original kept (voce 209). */
  compressMedia(id: number, preset?: string): Promise<{ before: number; after: number; saved: boolean }>;
  /** Presets for uploading and compressing: Histeon's and the site's. */
  listMediaPresets(): Promise<Array<{ id: string; label: string; max: number; formats: string[]; quality?: number }>>;
  // Contents (voce 216): only title, excerpt and fields; the status never changes.
  searchContent(search?: string, type?: string, page?: number): Promise<{ items: AgentContentItem[]; pages: number }>;
  getContent(id: number): Promise<AgentContent>;
  updateContent(id: number, change: { title?: string; excerpt?: string; fields?: Record<string, unknown> }): Promise<AgentContent>;
  // Loop queries and JSON sources (voce 217), in development, with the checks of the Queries panel.
  getQuery(name: string): Promise<QueryPreset | null>;
  setQuery(name: string, query: QueryPreset | null): Promise<void>;
  getSource(name: string): Promise<unknown>;
  setSource(name: string, data: unknown): Promise<void>;
  // Components (voce 218).
  /** A component's definition: its markup as builder HTML (with `{@slot}`), its props. */
  getComponent(ref: string): Promise<{ ref: string; title: string; html: string; props: Record<string, PropDefinition> }>;
  /** Changes a component's markup and/or props in development; every page that uses it follows. */
  updateComponent(ref: string, change: { html?: string; props?: Record<string, PropDefinition> }): Promise<{ unusedProps: string[] }>;
  undo(): void;
  redo(): void;
  /** Saves in development (Ctrl+S). */
  save(): Promise<void>;
  isDirty(): boolean;
  on(event: Event, listener: Listener): () => void;
}

/** A finding for an agent: a stable code, how serious, the message (Italian, like the agents' manual). */
export interface AgentWarning {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  uid?: string | null;
}

/** From this many framework classes on one element, the style belongs in the element's own block (BEM). */
export const UTILITY_CHAIN = 4;

/** Warnings about markup, for agents (I1): each class or element once, in document order. */
export function markupWarnings(blocks: XbBlock[], frameworkClasses: ReadonlySet<string>): AgentWarning[] {
  const out: AgentWarning[] = [];
  const seen = new Set<string>();
  const BEM = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
  const walk = (list: XbBlock[]) => {
    for (const block of list) {
      if (block.name === 'xb/element') {
        const attributes = block.attrs.attributes ?? {};
        const raw = typeof attributes.class === 'string' ? attributes.class : '';
        const classes = raw.includes('{') ? [] : raw.split(/\s+/).filter(Boolean);
        const utilities = classes.filter((c) => frameworkClasses.has(c));
        if (utilities.length >= UTILITY_CHAIN) {
          out.push({ code: 'utility-chain', severity: 'warning', uid: block.attrs.uid, message: `<${block.attrs.tag}> ha ${utilities.length} classi utility (${utilities.join(' ')}): dagli una classe BEM e scrivi lo stile con set-css` });
        }
        for (const c of classes) {
          if (frameworkClasses.has(c) || BEM.test(c) || seen.has(c)) continue;
          seen.add(c);
          out.push({ code: 'not-bem', severity: 'info', uid: block.attrs.uid, message: `Classe fuori dallo schema BEM (blocco__elemento--modificatore): ${c}` });
        }
        if (typeof attributes.style === 'string' && attributes.style.trim() !== '') {
          out.push({ code: 'inline-style', severity: 'warning', uid: block.attrs.uid, message: `Stile in linea su <${block.attrs.tag}>: spostalo nel CSS del suo selettore` });
        }
      }
      walk(childrenOf(block));
    }
  };
  walk(blocks);
  return out;
}

export interface SiteBrief {
  document: ReturnType<XbApi['getDocument']>;
  framework: {
    name: string;
    tokens: string[];
    /** Up to BRIEF_GROUP names per group; `more` says how many were left out. */
    groups: Record<string, string[]>;
    more: Record<string, number>;
    /** Values of the listed variables and tokens, `var()` resolved (`space-m` → `clamp(1rem, …)`). */
    values: Record<string, string>;
    classCount: number;
  };
  /** Named media queries, `@media (--tablet)`: not the loop queries below. */
  mediaQueries: Record<string, string>;
  /** Names a loop or an expression can read on this site, up to BRIEF_LIST each. */
  data: BriefData;
  blocks: Array<{ block: string; parts: string[] }>;
  otherSelectors: string[];
  components: Array<{ ref: string; title: string; props: string[] }>;
}

export interface BriefData {
  /** Loop queries saved in the Queries section: `{#loop name(param: …) as x}`. */
  loopQueries: Array<{ name: string; type: string; params: string[] }>;
  /** `data.name`: JSON sources and the PHP data the site registers. */
  sources: Array<{ name: string; kind: 'json' | 'php'; description?: string }>;
  /** `facets.name`: lists with filters, with the query each filters. */
  facets: Array<{ name: string; query: string; filters: string[] }>;
  /** Content types loops can list, with the fields of Histeon' own (`item.fields.name`). */
  types: Array<{ name: string; label: string; fields: string[] }>;
  /** Fields of other plugins (ACF, Meta Box…) an administrator made readable: `.fields.name`. */
  publicFields: string[];
  /** Entries left out by the caps, per list. */
  more: Record<string, number>;
}

export const BRIEF_GROUP = 80;
export const BRIEF_LIST = 50;

/** `$name` placeholders of a loop query, wherever they sit in its arguments; `$today` and `$now` fill themselves. */
export function queryParams(args: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
      if (m && m[1] !== 'today' && m[1] !== 'now') found.add(m[1]!);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(args);
  return [...found];
}

/** The data part of the brief from what the server answered; a part that failed to load is just empty. */
export function briefData(parts: { queries?: QueriesData | null; facets?: Facets | null; content?: ContentData | null; extensions?: SiteExtensions | null }): BriefData {
  const more: Record<string, number> = {};
  const cap = <T>(key: string, list: T[]): T[] => {
    if (list.length > BRIEF_LIST) more[key] = list.length - BRIEF_LIST;
    return list.slice(0, BRIEF_LIST);
  };
  const { queries, facets, content, extensions } = parts;
  const ownFields = content?.content.fields ?? {};
  const listable = new Set((queries?.types ?? []).map((t) => t.name));
  return {
    loopQueries: cap('loopQueries', Object.entries(queries?.presets ?? {}).map(([name, preset]) => ({ name, type: preset.type, params: queryParams(preset.args) }))),
    sources: cap('sources', [
      ...Object.keys(queries?.sources ?? {}).map((name) => ({ name, kind: 'json' as const })),
      ...(extensions?.data ?? []).map((d) => ({ name: d.name, kind: 'php' as const, ...(d.description ? { description: d.description } : {}) })),
    ]),
    facets: cap('facets', Object.entries(facets ?? {}).map(([name, f]) => ({ name, query: f.query, filters: f.filters.map((x) => x.key) }))),
    types: cap(
      'types',
      (content?.postTypes ?? [])
        .filter((t) => listable.size === 0 || listable.has(t.name))
        .map((t) => ({ name: t.name, label: t.label, fields: (ownFields[t.name] ?? []).map((f) => f.name) })),
    ),
    publicFields: cap(
      'publicFields',
      (content?.providers ?? []).flatMap((p) => p.fields.filter((f) => content!.publicFields.includes(f.id)).map((f) => f.name)),
    ),
    more,
  };
}

/** Selectors grouped as BEM blocks (`.card`, `.card__title`, `.card--dark`); the rest apart. */
export function bemBlocks(selectors: string[]): { blocks: Array<{ block: string; parts: string[] }>; other: string[] } {
  const blocks = new Map<string, Set<string>>();
  const other: string[] = [];
  for (const sel of selectors) {
    const m = /^\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)((?:__[a-z0-9]+(?:-[a-z0-9]+)*)?(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?)$/.exec(sel.trim());
    if (!m) {
      other.push(sel);
      continue;
    }
    const parts = blocks.get(m[1]!) ?? new Set<string>();
    if (m[2]) parts.add(m[2]);
    blocks.set(m[1]!, parts);
  }
  return {
    blocks: [...blocks].sort(([a], [b]) => a.localeCompare(b)).map(([block, parts]) => ({ block, parts: [...parts].sort() })),
    other: other.slice(0, 100),
  };
}

export function createApi(
  app: BuilderState,
  env: Omit<XbEnvironment, 'framework' | 'version'> = { type: 'production', histeon: '', wordpress: '', multisite: false, locale: 'it_IT' },
  media: MediaLibrary | null = null,
): { api: XbApi; emit: (event: Event, detail: unknown) => void } {
  const listeners = new Map<Event, Set<Listener>>();
  const emit = (event: Event, detail: unknown) => {
    for (const l of listeners.get(event) ?? []) {
      try {
        l(detail);
      } catch (e) {
        console.error('xb: listener', e);
      }
    }
  };
  const snapshot = (): XbBlock[] => JSON.parse(JSON.stringify(app.tree)) as XbBlock[];
  const library = (): MediaLibrary => {
    if (!media) throw new Error('La libreria dei media non è disponibile per questo utente.');
    return media;
  };
  const positive = (id: number, method: string): number => {
    if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${method}: id non valido`);
    return id;
  };
  const checkName = (name: string, method: string): string => {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name)) throw new TypeError(`${method}: nome non valido (lettere, cifre e _)`);
    return name;
  };
  const presetNamed = async (id: string): Promise<Preset> => {
    const own = PRESETS.find((p) => p.id === id);
    if (own) return own;
    const site = (await library().presets()).find((p) => p.id === id);
    if (!site) throw new Error(`Preset sconosciuto: ${id}`);
    return fromSite(site);
  };
  /** One change to the loop queries or JSON sources, saved in development with the panel's checks. */
  const saveSettings = async (change: (data: QueriesData) => { presets: QueriesData['presets']; sources: Record<string, JsonSource> }): Promise<void> => {
    const data = await app.api.getQueries();
    const next = change(data);
    await app.api.saveQueries(next.presets, data.head, data.base, next.sources);
    void app.refreshPreview(true, true);
  };
  const api: XbApi = Object.freeze({
    version: API_VERSION,
    get environment(): XbEnvironment {
      return Object.freeze({ ...env, framework: app.framework.active.label, version: 'dev' as const });
    },
    getHtml: () => print(snapshot()),
    setHtml(html: string) {
      if (typeof html !== 'string') throw new TypeError('setHtml: serve una stringa');
      const { blocks } = parse(html, { uid: randomUid });
      if (!roundTrips(blocks)) throw new Error('setHtml: questo HTML non si può rappresentare fedelmente nel builder');
      app.setTree(reconcileUids(snapshot(), blocks), { fromHtml: true });
    },
    getTree: snapshot,
    getSelection: () => app.selected,
    select(uid: string | null) {
      if (uid !== null && !app.find(uid)) throw new Error(`select: nessun elemento ${uid}`);
      app.select(uid);
    },
    getElementHtml(uid: string) {
      const block = findBlock(snapshot(), uid);
      return block ? print([block]) : null;
    },
    insert(html: string) {
      const { blocks } = parse(String(html), { uid: randomUid });
      app.insert(blocks);
      return blocks.map((b) => b.attrs.uid);
    },
    copy(uids: string[]) {
      if (!Array.isArray(uids) || !uids.length || uids.some((u) => typeof u !== 'string')) throw new TypeError('copy: serve una lista di uid');
      const blocks = uids.map((uid) => {
        const block = findBlock(snapshot(), uid);
        if (!block) throw new Error(`copy: nessun elemento ${uid}`);
        return block;
      });
      const text = JSON.stringify(makeClip(blocks, JSON.parse(JSON.stringify(app.styles)), window.location.hostname));
      rememberCopy(text);
      return text;
    },
    async paste(text: string, options: { target?: string | null; classes?: 'rename' | 'keep' } = {}) {
      const clip = typeof text === 'string' ? readClip(text) : null;
      if (!clip) throw new TypeError('paste: non è un contenuto copiato da Histeon (usa insert per l’HTML)');
      const target = options.target ?? null;
      if (target !== null && !app.find(target)) throw new Error(`paste: nessun elemento ${target}`);
      if (options.classes !== undefined && options.classes !== 'rename' && options.classes !== 'keep') throw new TypeError('paste: classes è rename o keep');
      const prepared = await preparePaste(app, clip, copiedHere(text));
      if (target !== null) app.select(target);
      const choice = Object.fromEntries(prepared.plan.filter((p) => p.fate === 'conflict').map((p) => [p.name, options.classes ?? 'rename']));
      return applyPaste(app, prepared, choice).uids;
    },
    remove(uid: string) {
      if (!app.find(uid)) throw new Error(`remove: nessun elemento ${uid}`);
      app.remove(uid);
    },
    setText(uid: string, text: string) {
      const block = app.find(uid);
      if (!block || block.name !== 'xb/element') throw new Error(`setText: nessun elemento ${uid}`);
      if (typeof text !== 'string') throw new TypeError('setText: testo non valido');
      const edit = setText(block, text, randomUid);
      if (!edit.ok) throw new Error(`setText: ${edit.error}`);
      app.setTree(replaceBlock(app.tree, uid, [edit.block]));
    },
    setAttribute(uid: string, name: string, value: string | true | null) {
      const block = app.find(uid);
      if (!block || block.name !== 'xb/element') throw new Error(`setAttribute: nessun elemento ${uid}`);
      if (typeof name !== 'string' || (value !== null && value !== true && typeof value !== 'string')) throw new TypeError('setAttribute: nome o valore non validi');
      if (value === null) {
        app.setTree(replaceBlock(app.tree, uid, [removeAttribute(block, name)]));
        return;
      }
      const has = Object.hasOwn(block.attrs.attributes ?? {}, name);
      const edit = setAttribute(block, has ? name : null, name, value === true ? '' : value);
      if (!edit.ok) throw new Error(`setAttribute: ${edit.error}`);
      // An empty string the panel would keep as a flag: here only `true` means "no value".
      const written = value === '' ? { ...edit.block, attrs: { ...edit.block.attrs, attributes: { ...edit.block.attrs.attributes, [name]: '' } } } : edit.block;
      app.setTree(replaceBlock(app.tree, uid, [written]));
    },
    move(uid: string, target: string, position: 'before' | 'after' | 'inside') {
      if (!app.find(uid) || !app.find(target)) throw new Error(`move: nessun elemento ${app.find(uid) ? target : uid}`);
      if (!['before', 'after', 'inside'].includes(position)) throw new TypeError('move: posizione before, after o inside');
      if (!canDrop(app.tree, uid, target, position)) throw new Error(`move: ${uid} non può andare ${position === 'inside' ? 'dentro' : position === 'before' ? 'prima di' : 'dopo'} ${target}`);
      app.moveTo(uid, target, position);
    },
    getCss: (selector: string) => app.styles.find((s) => s.selector === selector)?.css ?? '',
    setCss(selector: string, css: string) {
      if (typeof selector !== 'string' || !/^[^{}<;]{1,500}$/.test(selector) || typeof css !== 'string') throw new TypeError('setCss: selettore o CSS non validi');
      app.upsertStyle(selector.trim(), css);
    },
    listStyles: () => app.styles.map((s) => s.selector),
    lintCss(selector: string, css: string) {
      if (typeof selector !== 'string' || typeof css !== 'string') throw new TypeError('lintCss: selettore o CSS non validi');
      const context = lintContext(app.framework, app.globals, app.styles, app.queries);
      return cssLint(selector.trim(), css, context).map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message }));
    },
    lintHtml(html: string) {
      const { blocks } = parse(String(html), { uid: randomUid });
      return markupWarnings(blocks, new Set(app.framework.classes.map((c) => c.name)));
    },
    getChecks() {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-xb-canvas]');
      const d = frame?.contentDocument;
      if (!d?.body) throw new Error('getChecks: la tela non è ancora disegnata');
      const firstWith = new Map<string, string>();
      for (const block of app.index.block.values()) {
        if (block.name !== 'xb/element') continue;
        for (const cls of staticClasses(block)) if (!firstWith.has(`.${cls}`)) firstWith.set(`.${cls}`, block.attrs.uid);
      }
      const context = lintContext(app.framework, app.globals, app.styles, app.queries);
      const page = runChecks(d, { page: !app.isComponent });
      const css = app.styles.flatMap((style) =>
        firstWith.has(style.selector) ? cssLint(style.selector, style.css, context).map((issue) => ({ code: `css-${issue.code}`, severity: issue.severity, message: `${style.selector}: ${issue.message}`, uid: firstWith.get(style.selector) ?? null })) : [],
      );
      return [...page.map((f) => ({ code: f.rule, severity: f.severity, message: f.message, uid: f.uid })), ...css];
    },
    getView() {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-xb-canvas]');
      const d = frame?.contentDocument ?? null;
      const win = d?.defaultView ?? null;
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      };
      const at = (uid: string) => d?.querySelector(`[data-xb-uid="${CSS.escape(uid)}"]`) ?? null;
      const uid = app.selected;
      const block = uid ? app.find(uid) : null;
      let selection: AgentView['selection'] = null;
      if (uid && block) {
        const id = staticId(block);
        const selectors = [...staticClasses(block).map((c) => `.${c}`), ...conditionalClasses(block).map((c) => `.${c}`), ...(id ? [`#${id}`] : [])];
        const el = at(uid);
        const style = el && win ? win.getComputedStyle(el) : null;
        selection = {
          uid,
          label: describe(block),
          tag: block.name === 'xb/element' ? block.attrs.tag : block.name,
          selectors,
          styles: selectors.map((selector) => ({ selector, css: app.styles.find((s) => s.selector === selector)?.css ?? '' })),
          computed: style ? Object.fromEntries(VIEW_PROPERTIES.map((name) => [name, style.getPropertyValue(name)])) : null,
          box: el ? box(el) : null,
        };
      }
      const outline = d?.body
        ? [...d.body.querySelectorAll<HTMLElement>(':scope > [data-xb-uid], :scope > * > [data-xb-uid]')].slice(0, 40).map((el) => ({
            uid: el.dataset.xbUid ?? '',
            tag: el.tagName.toLowerCase(),
            class: el.getAttribute('class') ?? '',
            box: box(el),
          }))
        : [];
      return { canvas: { width: d?.documentElement.clientWidth ?? 0, height: d?.documentElement.scrollHeight ?? 0 }, selection, outline };
    },
    getDocument: () => (app.doc ? { id: app.doc.id, type: app.doc.type, title: app.doc.title, ref: app.ref, dirty: app.dirty, published: app.published } : null),
    getFramework: () => ({
      framework: app.framework.active.label,
      variables: app.framework.variables.map((v) => ({ name: v.name, group: v.group, ...(v.value !== undefined ? { value: v.value } : {}) })),
      classes: app.framework.classes.map((c) => ({ name: c.name, group: c.group })),
    }),
    getComponents: () => app.components.map((c) => ({ ref: c.ref, title: c.title, props: JSON.parse(JSON.stringify(c.props)) as Record<string, unknown> })),
    async render() {
      await app.refreshPreview(true, true);
      if (app.previewError) throw new Error(app.previewError);
      return { html: app.preview?.html ?? '', css: app.preview?.css ?? '' };
    },
    async listSections() {
      const { sections } = await app.api.listSections();
      return sections.map((s) => ({ id: s.id, name: s.name, origin: s.origin }));
    },
    async getSectionBrief(id: string) {
      const { sections } = await app.api.listSections();
      const section = sections.find((s) => s.id === id);
      if (!section) throw new Error(`getSectionBrief: nessuna sezione ${id}`);
      const clip = readClip((await app.api.getSection(id)).clip);
      if (!clip) throw new Error('getSectionBrief: sezione non leggibile');
      return sectionBrief(section.name, clip, app.framework.variables);
    },
    async getBrief() {
      const groups: Record<string, string[]> = {};
      const more: Record<string, number> = {};
      const values: Record<string, string> = {};
      const tokens: string[] = [];
      for (const v of app.framework.variables) {
        if (v.group === 'xb') tokens.push(v.name);
        else if ((groups[v.group] ??= []).length < BRIEF_GROUP) groups[v.group]!.push(v.name);
        else {
          more[v.group] = (more[v.group] ?? 0) + 1;
          continue;
        }
        if (v.value !== undefined) values[v.name] = v.value;
      }
      const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
      const [queries, facets, content] = await Promise.all([settle(app.api.getQueries()), settle(app.api.getFacets()), settle(app.api.getContent()), settle(app.loadExtensions())]);
      const { blocks, other } = bemBlocks(app.styles.map((s) => s.selector));
      return {
        document: api.getDocument(),
        framework: { name: app.framework.active.label, tokens, groups, more, values, classCount: app.framework.classes.length },
        mediaQueries: { ...app.queries },
        data: briefData({ queries, facets: facets?.facets ?? null, content, extensions: app.extensions }),
        blocks,
        otherSelectors: other,
        components: app.components.map((c) => ({ ref: c.ref, title: c.title, props: Object.keys(c.props) })),
      };
    },
    async createComponent(uid: string, ref: string, title: string) {
      if (typeof uid !== 'string' || !app.find(uid)) throw new Error(`createComponent: nessun elemento ${uid}`);
      if (typeof ref !== 'string' || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/.test(ref)) throw new TypeError('createComponent: chiave non valida (minuscole e trattini, es. "card" o "ui/card")');
      app.select(uid);
      await app.componentFromSelection(ref, typeof title === 'string' && title.trim() ? title.trim() : ref);
    },
    applyBem(uid: string) {
      if (typeof uid !== 'string' || !app.find(uid)) throw new Error(`applyBem: nessun elemento ${uid}`);
      return app.bem(uid);
    },
    listMedia: (filter: MediaFilter = {}) => library().list(filter),
    getMedia: (id: number) => library().get(positive(id, 'getMedia')),
    async uploadMedia(file: File, options: { collection?: number; preset?: string } = {}) {
      if (!(file instanceof File)) throw new TypeError('uploadMedia: serve un File');
      const preset = await presetNamed(options.preset ?? 'web');
      return library().upload(file, { preset, ...(options.collection ? { collection: positive(options.collection, 'uploadMedia') } : {}) });
    },
    setMediaAlt(id: number, alt: string) {
      if (typeof alt !== 'string') throw new TypeError('setMediaAlt: testo non valido');
      return library().setAlt(positive(id, 'setMediaAlt'), alt);
    },
    setMediaCollections(id: number, collections: number[]) {
      if (!Array.isArray(collections) || collections.some((c) => !Number.isInteger(c) || c <= 0)) throw new TypeError('setMediaCollections: serve una lista di id');
      return library().setCollections(positive(id, 'setMediaCollections'), collections);
    },
    listCollections: () => library().collections(),
    createCollection(name: string, parent = 0) {
      if (typeof name !== 'string' || !name.trim()) throw new TypeError('createCollection: serve un nome');
      return library().createCollection(name.trim().slice(0, 100), parent);
    },
    updateCollection: (id: number, change: { name?: string; parent?: number }) => library().updateCollection(positive(id, 'updateCollection'), change),
    deleteCollection: (id: number) => library().deleteCollection(positive(id, 'deleteCollection')),
    async compressMedia(id: number, preset = 'web') {
      return library().compressInPlace(positive(id, 'compressMedia'), await presetNamed(preset));
    },
    async listMediaPresets() {
      return [...PRESETS, ...(await library().presets().catch(() => [])).map(fromSite)].map((p) => ({ id: p.id, label: p.label, max: p.max, formats: [...p.formats], ...(p.quality !== undefined ? { quality: p.quality } : {}) }));
    },
    searchContent: (search = '', type = '', page = 1) => app.api.searchContent(String(search), String(type), Math.max(1, Math.floor(Number(page) || 1))),
    getContent: (id: number) => app.api.getAgentContent(positive(id, 'getContent')),
    updateContent(id: number, change: { title?: string; excerpt?: string; fields?: Record<string, unknown> }) {
      if (!change || typeof change !== 'object') throw new TypeError('updateContent: serve { title?, excerpt?, fields? }');
      return app.api.updateAgentContent(positive(id, 'updateContent'), change);
    },
    async getQuery(name: string) {
      const presets = (await app.api.getQueries()).presets as Record<string, QueryPreset>;
      return Object.hasOwn(presets, name) ? presets[name]! : null;
    },
    async setQuery(name: string, query: QueryPreset | null) {
      await saveSettings((data) => {
        const presets = { ...(data.presets as Record<string, QueryPreset>) };
        if (query === null) delete presets[checkName(name, 'setQuery')];
        else presets[checkName(name, 'setQuery')] = query;
        return { presets, sources: data.sources ?? {} };
      });
    },
    async getSource(name: string) {
      const sources = (await app.api.getQueries()).sources ?? {};
      const found = Object.hasOwn(sources, name) ? sources[name]! : null;
      return found ? (found.type === 'json' ? found.data : { ...found }) : null;
    },
    async setSource(name: string, data: unknown) {
      await saveSettings((current) => {
        const sources: Record<string, JsonSource> = { ...(current.sources ?? {}) };
        if (data === null) delete sources[checkName(name, 'setSource')];
        else sources[checkName(name, 'setSource')] = { type: 'json', data: JSON.parse(JSON.stringify(data)) as unknown };
        return { presets: current.presets, sources };
      });
    },
    async getComponent(ref: string) {
      const info = (await app.api.listComponents()).find((c) => c.ref === ref);
      if (!info) throw new Error(`getComponent: nessun componente ${ref}`);
      const doc = await app.api.getDocument(info.id);
      return { ref, title: doc.title || info.title, html: print(parseXb(doc.content).blocks), props: JSON.parse(JSON.stringify(doc.schema?.props ?? info.props)) as Record<string, PropDefinition> };
    },
    async updateComponent(ref: string, change: { html?: string; props?: Record<string, PropDefinition> }) {
      const info = (await app.api.listComponents()).find((c) => c.ref === ref);
      if (!info) throw new Error(`updateComponent: nessun componente ${ref}`);
      if (app.ref === ref || app.sessions.some((s) => s.ref === ref)) throw new Error('updateComponent: il componente è aperto in questa scheda: modificalo con setHtml o chiudilo prima');
      if (!change || (change.html === undefined && change.props === undefined)) throw new TypeError('updateComponent: serve html o props');
      const doc = await app.api.getDocument(info.id);
      const before = parseXb(doc.content).blocks;
      let blocks = before;
      if (change.html !== undefined) {
        if (typeof change.html !== 'string') throw new TypeError('updateComponent: html non valido');
        const parsed = parse(change.html, { uid: randomUid }).blocks;
        if (!roundTrips(parsed)) throw new Error('updateComponent: questo HTML non si può rappresentare fedelmente nel builder');
        blocks = reconcileUids(before, parsed);
        const problem = componentProblem(blocks);
        if (problem) throw new Error(`updateComponent: ${problem}`);
      }
      const props = change.props ?? doc.schema?.props ?? info.props;
      if (!props || typeof props !== 'object' || Array.isArray(props)) throw new TypeError('updateComponent: props non valide');
      const markup = print(blocks);
      await app.api.saveDocument(info.id, serializeXb(blocks), doc.head, doc.base, { schema: { props: JSON.parse(JSON.stringify(props)) as Record<string, PropDefinition> }, ref });
      app.components = await app.api.listComponents();
      void app.refreshPreview(true, true);
      // Props the markup no longer reads: pages may still set them, to no effect.
      return { unusedProps: Object.keys(props).filter((name) => !new RegExp(`props\\.${name}\\b`).test(markup)) };
    },
    undo: () => app.undo(),
    redo: () => app.redo(),
    save: () => app.save(),
    isDirty: () => app.dirty,
    on(event: Event, listener: Listener) {
      if (!['change', 'select', 'save'].includes(event) || typeof listener !== 'function') throw new TypeError('on: evento o funzione non validi');
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
  });
  return { api, emit };
}
