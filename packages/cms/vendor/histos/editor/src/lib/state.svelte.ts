import { untrack } from 'svelte';
import { childrenOf, compileCss, elseLast, resolveNamedQueries, parseXb, randomUid, reuid, serializeXb, type AttrValue, type XbBlock } from '@xb/dsl';
import type { Clip } from './clip.ts';
import { documentOrder, findBlock, outermost, promoteInline, suggestedClass, wrapSiblings, indentBlock, indexTree, outdentBlock, pathIn, selectionAfterRemoval, type InsertPosition, unwrapBlock, wrapBlock, insertAfter, insertAtSelection, moveBlock, removeBlock, replaceBlock, canDrop, moveTo, type DropPosition } from './tree.ts';
import { applyBem, cleanLabel, componentProblem } from './speed.ts';
import { setDeclaration } from './miniGui.ts';
import { bodyAt, setBodyAt } from './cssContext.ts';
import { widthPrelude } from './canvasWidth.ts';
import { describeStep } from './historySteps.ts';
import { contentOnlyProblem } from './contentOnly.ts';
import { lookProblem, pageCss, setPageCss, type PageStyle } from './pageLook.ts';
import { rebaseEntries, rebaseTree } from './rebase.ts';
import { t, tn } from './i18n.ts';
import { ApiError, type Api, type ComponentInfo, type DocumentData, type FrameworkData, type GlobalSheet, type Preview, type Schema, type SiteExtensions, type StyleEntry } from './api.ts';

interface Snapshot {
  tree: XbBlock[];
  styles: StyleEntry[];
  globals: GlobalSheet[];
  /** The page's own look (voce 186). */
  pageStyles: PageStyle[];
  /** When it was taken (the step that follows it happened then). */
  at: number;
}

type Status = { kind: 'loading' | 'idle' | 'saving' | 'saved' | 'error'; message: string };

/** A document put aside while a component is edited over it (docs/spec/component-session.md). */
interface DocFrame {
  postId: number;
  doc: DocumentData | null;
  tree: XbBlock[];
  issues: string[];
  selected: string | null;
  docHead: string;
  docBase: string;
  savedContent: string;
  /** Client mode: the document as loaded or saved, what edits are checked against. */
  baseline: XbBlock[];
  script: string;
  savedScript: string;
  ref: string | null;
  schema: Schema | null;
  savedMeta: string;
  published: boolean;
  past: Snapshot[];
  future: Snapshot[];
  contextId: number;
  dirty: boolean;
  /** The shared styles as they were when the session started: "Annulla" puts them back. */
  styles: StyleEntry[];
  globals: GlobalSheet[];
  pageStyles: PageStyle[];
  savedPageStyles: string;
  pageBaseline: PageStyle[];
}

const HISTORY_LIMIT = 200;
/** Consecutive edits from the same source within this window form one undo step (typing). */
const COALESCE_MS = 1500;

/**
 * A tree as the page keeps it: plain and frozen. The parts it shares with an earlier tree are frozen already and
 * kept as they are; the new parts are copied as plain data (a panel may hand over its own reactive state) and
 * frozen. An edit costs the parts it changed, not the page.
 */
export function frozen<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  const copy = Array.isArray(value) ? value.map((v: unknown) => frozen(v)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozen(v)]));
  return Object.freeze(copy) as T;
}

/**
 * Single source of truth of the builder: the XB tree and the style entries.
 * Panels read from here and write through the methods below, which also record undo history.
 */
export class BuilderState {
  /**
   * The page. Never changed in place: every edit makes a new tree that shares the untouched parts with the old one
   * (tree.ts), and the tree is frozen so nothing can change it by mistake. History keeps these trees as they are, and
   * an edit no longer copies the whole page (docs/spec/performance.md, large pages).
   */
  tree = $state.raw<XbBlock[]>([]);
  /** Blocks by uid and their parents, rebuilt when the tree changes (lookups stay quick on large pages). */
  index = $derived(indexTree(this.tree));
  /**
   * Style entries and global sheets: frozen, and never changed in place, like the tree (V12). An edit makes a new
   * array that shares the untouched entries, so an undo point keeps the arrays as they are instead of copying
   * every style of the site, and «non salvato» compares entries already turned into JSON.
   */
  styles = $state.raw<StyleEntry[]>([]);
  globals = $state.raw<GlobalSheet[]>([]);
  selected = $state<string | null>(null);
  /** Further selected nodes besides `selected`, with Ctrl/Cmd+click or Shift+click (E7). */
  alsoSelected = $state<string[]>([]);
  hovered = $state<string | null>(null);
  doc = $state<DocumentData | null>(null);
  private reported = $state<Status>({ kind: 'loading', message: t('Caricamento…') });
  /** Repairs reported when the stored content was read (parseXb). */
  issues = $state<string[]>([]);
  preview = $state<Preview | null>(null);
  previewError = $state<string | null>(null);
  /** Bumped when the tree changes from anywhere but the HTML panel, so the panel reprints it. */
  treeRevision = $state(0);
  /** Bumped when styles change from anywhere but the CSS panel (load, undo/redo, save). */
  styleRevision = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  /** JavaScript of the document (JS panel); editable only with unfiltered_html. */
  script = $state('');
  /** Component documents only: key and props schema. */
  ref = $state<string | null>(null);
  schema = $state<Schema | null>(null);
  components = $state<ComponentInfo[]>([]);
  framework = $state<FrameworkData>({ active: { id: '', label: '' }, variables: [], classes: [] });
  /**
   * Width the canvas draws the page at (docs/spec/styles.md §8): null fits the stage. `layoutWidth` is the width in
   * use now, which the CSS panel offers for media and container queries.
   */
  canvasWidth = $state<number | null>(null);
  layoutWidth = $state(1280);
  /** Edits follow the canvas width (styles.md §10): with the canvas at a width, they go in that @media. */
  followCanvas = $state(true);
  /** The @media an edit goes in now, or null (the canvas fits the stage, or following is off). */
  get canvasPrelude(): string | null {
    return this.followCanvas && this.canvasWidth !== null ? widthPrelude(this.queries, this.canvasWidth) : null;
  }
  /** What the site's PHP offers (docs/spec/php.md): data providers, modifiers, dynamic blocks. Loaded on demand. */
  extensions = $state<SiteExtensions | null>(null);
  private extensionsLoading: Promise<void> | null = null;
  /** Where the last selection came from, so panels do not echo it back. */
  selectionSource: 'html' | 'other' = 'other';

  /** Versioning heads the editor started from (optimistic locking, merge base). */
  private docHead = '';
  private docBase = '';
  private stylesHead = '';
  private stylesBase = '';
  /** True when what is saved in dev equals what is live. */
  published = $state(true);

  private savedContent = $state('');
  private savedStyles = $state('');
  private savedScript = $state('');
  private savedMeta = $state('');
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastRecord: { key: string; at: number } | null = null;
  private renderAbort: AbortController | null = null;
  /** Panel edits waiting for the typing pause (debounce), by panel. */
  private pendingEdits = new Map<string, { timer: ReturnType<typeof setTimeout>; apply: () => void }>();
  /** True while a panel holds typed text not yet applied to the tree or the styles. */
  editsPending = $state(false);
  /**
   * Text a panel holds but could not apply (an HTML syntax error, an empty element, unbalanced braces), by panel:
   * why, in words. It counts as unsaved: saving says it was not saved, leaving the page warns, and what would
   * replace it in the panel (another selection, an edit from elsewhere, undo) asks first.
   */
  rejected = $state<Record<string, string>>({});
  /** Why the first rejected text was refused ('' when none). */
  readonly invalid = $derived(Object.values(this.rejected)[0] ?? '');
  /** Asks whether rejected text may be dropped; window.confirm in the browser. */
  confirmDiscard: (question: string) => boolean = (question) => typeof window === 'undefined' || window.confirm(question);
  /**
   * Text written in the canvas that the canvas cannot take (docs/spec/inline-text.md), handed to the HTML panel
   * as the code of its element so it is not lost; the panel clears it.
   */
  htmlDraft = $state<{ uid: string; code: string } | null>(null);
  /** Templates: the sample post the canvas and the preview show the template with (0: the server's choice). */
  contextId = $state(0);

  readonly content = $derived(serializeXb(this.tree));
  readonly dirtyContent = $derived(this.content !== this.savedContent);
  readonly dirtyStyles = $derived(this.stylesJson() !== this.savedStyles);
  readonly dirtyScript = $derived(this.script !== this.savedScript);
  readonly dirtyMeta = $derived(this.metaJson() !== this.savedMeta);
  /** The page's own look (voce 186): saved with the document. */
  pageStyles = $state<PageStyle[]>([]);
  private savedPageStyles = $state('[]');
  /** The page's own look as loaded or saved: what a client's changes are checked against. */
  private pageBaseline: PageStyle[] = [];
  readonly dirtyPage = $derived(JSON.stringify(this.pageStyles) !== this.savedPageStyles);
  readonly dirty = $derived(this.editsPending || this.invalid !== '' || this.dirtyContent || this.dirtyStyles || this.dirtyScript || this.dirtyMeta || this.dirtyPage);
  /** Edits so far (undo points, typing included): a notice says something about the page as it was. */
  private editCount = $state(0);
  /** `editCount` when the status was reported. */
  private reportedAt = 0;
  /**
   * A 'saved' status stops being true as soon as the document changes again; a notice or an error (copied, pasted,
   * refused…) is about the moment it came from, and goes with the next edit instead of hiding «Modifiche non
   * salvate» for good.
   */
  private readonly shownStatus = $derived.by<Status>(() => {
    const r = this.reported;
    if (r.kind === 'saved' && this.dirty) return { kind: 'idle', message: '' };
    if ((r.kind === 'idle' || r.kind === 'error') && r.message && this.editCount !== this.reportedAt) return { kind: 'idle', message: '' };
    return r;
  });
  readonly isComponent = $derived(this.doc?.type === 'wp_block');
  /**
   * A component's props schema while it differs from the saved one, sent with each drawing so the canvas shows its
   * samples at once (E5); once saved, the server reads it from the development copy.
   */
  readonly sampleSchema = $derived(this.isComponent && this.dirtyMeta && this.schema ? JSON.stringify(this.schema) : '');
  /** CSS the canvas adds to show a state of the selection while it is styled (`:hover` forced), or ''. */
  forcedCss = $state('');

  /**
   * Compiled CSS of style entries by selector and text (V12): typing in one entry compiles that entry, not every
   * selector of the site. Emptied when it grows past a few thousand texts (old versions of edited entries).
   */
  private readonly compiledCache = new Map<string, string>();
  private compiled(selector: string, css: string): string {
    const key = `${selector}\u0000${css}`;
    let out = this.compiledCache.get(key);
    if (out === undefined) {
      if (this.compiledCache.size > 4000) this.compiledCache.clear();
      out = compileCss(selector, css);
      this.compiledCache.set(key, out);
    }
    return out;
  }

  /** Named media queries (`@media (--tablet)`), resolved in the live CSS like on the site. */
  queries = $state<Record<string, string>>({});
  /** Live CSS of the canvas, compiled in the browser so typing in the CSS panel needs no round trip. */
  /** A recipe tried on the canvas from the recipes panel, before it is applied: its CSS for one selector. */
  recipePreview = $state<{ selector: string; css: string } | null>(null);
  readonly liveCss = $derived(
    resolveNamedQueries(
      this.globals.map((g) => g.css).join('\n') + '\n' + this.styles.map((s) => this.compiled(s.selector, s.css)).join('\n') + '\n' + this.forcedCss + (this.recipePreview ? '\n' + compileCss(this.recipePreview.selector, this.recipePreview.css) : ''),
      this.queries,
    ) + (this.pageStyles.length ? '\n' + pageCss(this.pageStyles, this.queries) : ''),
  );


  /** The document being edited: the page, or a component in a session over it. */
  postId = $state(0);
  /** Component sessions open over the page, innermost last (breadcrumb). */
  sessions = $state<Array<{ id: number; ref: string; title: string }>>([]);
  private frames: DocFrame[] = [];
  /** Unsaved changes anywhere: this document or one put aside under a session. */
  readonly anyDirty = $derived(this.dirty || this.sessions.length > 0 && this.framesDirty());

  /**
   * Client mode (docs/spec/client-mode.md): only texts and pictures change. Edits are checked against the
   * document as loaded or last saved (`baseline`); styles, scripts and props do not change at all.
   */
  readonly contentOnly: boolean;
  /** Client mode with `xb_edit_props` (list 135): the literal props of component instances may change too. */
  readonly contentProps: boolean;
  /** Client mode on a page he may only see (voce 186): nothing changes, nothing is saved. */
  readonly viewOnly: boolean;
  /** Client mode: the mini GUI groups he may use on the page's own look (voce 186), [] for none. */
  readonly lookGroups: string[];
  private baseline: XbBlock[] = [];

  constructor(
    readonly api: Api,
    postId: number,
    contentOnly = false,
    contentProps = false,
    client: { viewOnly?: boolean; lookGroups?: string[] } = {},
  ) {
    this.postId = postId;
    this.contentOnly = contentOnly;
    this.contentProps = contentOnly && contentProps;
    this.viewOnly = contentOnly && client.viewOnly === true;
    this.lookGroups = contentOnly && !this.viewOnly ? [...(client.lookGroups ?? [])] : [];
  }

  /** In client mode, why an edit is refused ('' when it is fine); the status line says it. */
  private refused(problem: string): boolean {
    if (!problem) return false;
    if (this.viewOnly) {
      this.status = { kind: 'error', message: t('Questa pagina puoi solo vederla: chi gestisce il sito non ti ha dato il permesso di modificarla.') };
      return true;
    }
    this.status = { kind: 'error', message: t('In modalità contenuti si cambiano solo testi e immagini ({0}).', problem) };
    return true;
  }

  private framesDirty(): boolean {
    return this.frames.some((f) => f.dirty);
  }

  // ------------------------------------------------------------------ component sessions

  /**
   * Opens a component over the page, in place: the page (its unsaved changes, selection and undo history) is
   * put aside in memory, the component's definition is edited with every panel, and `closeComponent` brings the
   * page back. Nothing is reloaded. A component already open in the chain is not opened again (recursion).
   */
  async openComponent(ref: string): Promise<boolean> {
    this.flushEdits();
    if (!this.discardRejected()) return false;
    const info = this.components.find((c) => c.ref === ref);
    if (!info) {
      this.status = { kind: 'error', message: t('Componente {0} non trovato', ref) };
      return false;
    }
    if (info.id === this.postId || this.frames.some((f) => f.postId === info.id)) {
      this.status = { kind: 'error', message: t('Il componente {0} è già aperto', info.title || ref) };
      return false;
    }
    let doc: DocumentData;
    try {
      doc = await this.api.getDocument(info.id);
    } catch (e) {
      this.status = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
      return false;
    }
    this.frames.push({
      postId: this.postId,
      doc: this.doc,
      tree: this.tree,
      issues: this.issues,
      selected: this.selected,
      docHead: this.docHead,
      docBase: this.docBase,
      savedContent: this.savedContent,
      baseline: this.baseline,
      script: this.script,
      savedScript: this.savedScript,
      ref: this.ref,
      schema: this.schema,
      savedMeta: this.savedMeta,
      published: this.published,
      past: this.past,
      future: this.future,
      contextId: this.contextId,
      dirty: this.dirtyContent || this.dirtyScript || this.dirtyMeta || this.dirtyPage,
      styles: this.styles,
      globals: this.globals,
      pageStyles: this.pageStyles,
      savedPageStyles: this.savedPageStyles,
      pageBaseline: this.pageBaseline,
    });
    this.sessions = [...this.sessions, { id: info.id, ref, title: doc.title || info.title || ref }];
    this.postId = info.id;
    this.contextId = 0;
    this.useDocument(doc);
    this.status = { kind: 'idle', message: '' };
    void this.refreshPreview();
    return true;
  }

  /**
   * Leaves the innermost component session. `save`: the component is saved (with the shared styles) and the
   * page shows it; if saving fails the session stays open. Otherwise its unsaved changes are dropped, styles
   * included, and the page comes back exactly as it was left.
   */
  async closeComponent(save: boolean): Promise<boolean> {
    const frame = this.frames.at(-1);
    if (!frame) return false;
    this.flushEdits();
    if (save && this.dirty) {
      await this.save();
      if (this.reported.kind === 'error') return false;
    }
    const left = this.ref;
    if (!save) {
      this.styles = frame.styles;
      this.globals = frame.globals;
    }
    this.frames.pop();
    this.sessions = this.sessions.slice(0, -1);
    this.postId = frame.postId;
    this.doc = frame.doc;
    this.tree = frozen(frame.tree);
    this.issues = frame.issues;
    this.docHead = frame.docHead;
    this.docBase = frame.docBase;
    this.savedContent = frame.savedContent;
    this.baseline = frame.baseline;
    this.script = frame.script;
    this.savedScript = frame.savedScript;
    this.ref = frame.ref;
    this.schema = frame.schema;
    this.savedMeta = frame.savedMeta;
    this.pageStyles = frame.pageStyles;
    this.savedPageStyles = frame.savedPageStyles;
    this.pageBaseline = frame.pageBaseline;
    this.published = frame.published && this.published;
    this.past = frame.past;
    this.future = frame.future;
    this.lastRecord = null;
    this.contextId = frame.contextId;
    this.syncHistoryFlags();
    this.treeRevision++;
    this.styleRevision++;
    this.selected = frame.selected;
    this.status = save ? { kind: 'idle', message: t('Componente {0} salvato in sviluppo', left ?? '') } : { kind: 'idle', message: '' };
    if (save) {
      try {
        this.components = await this.api.listComponents();
      } catch {
        /* the list stays as it was; the canvas below still shows the new version */
      }
    }
    void this.refreshPreview();
    return true;
  }

  /** The document's own fields from the server (the shared styles are not touched). */
  private useDocument(doc: DocumentData): void {
    const { blocks, issues } = parseXb(doc.content);
    this.doc = doc;
    this.tree = frozen(blocks);
    this.baseline = $state.snapshot(blocks) as XbBlock[];
    this.issues = issues;
    this.selected = null;
    this.hovered = null;
    this.docHead = doc.head;
    this.docBase = doc.base;
    this.savedContent = issues.length > 0 ? doc.content : this.content;
    this.script = doc.script;
    this.savedScript = doc.script;
    this.ref = doc.ref;
    this.schema = doc.schema;
    this.savedMeta = JSON.stringify([doc.ref, doc.schema]);
    this.usePageStyles(doc);
    this.past = [];
    this.future = [];
    this.lastRecord = null;
    this.syncHistoryFlags();
    this.treeRevision++;
    this.styleRevision++;
  }

  /** The page's own look as the server has it (voce 186). */
  private usePageStyles(doc: DocumentData): void {
    const entries = (doc.pageStyles ?? []).map((e) => ({ selector: e.selector, css: e.css }));
    this.pageStyles = entries;
    this.pageBaseline = entries;
    this.savedPageStyles = JSON.stringify(entries);
  }

  get status(): Status {
    return this.shownStatus;
  }

  set status(status: Status) {
    this.reportedAt = untrack(() => this.editCount);
    this.reported = status;
  }

  async load(): Promise<void> {
    try {
      // The canvas only needs the document: its render starts as soon as the document arrives, while the
      // styles, components and framework (for the panels) are still on their way.
      const docRequest = this.api.getDocument(this.postId);
      const contextId = this.contextId;
      const early = docRequest
        .then((d) => {
          const content = serializeXb(parseXb(d.content).blocks);
          return this.api.render(this.postId, content, undefined, contextId).then((preview) => ({ content, preview }));
        })
        .catch(() => null);
      const [doc, styles, components, framework] = await Promise.all([docRequest, this.api.getStyles(), this.api.listComponents(), this.api.getFramework()]);
      this.components = components;
      this.framework = framework;
      const { blocks, issues } = parseXb(doc.content);
      this.doc = doc;
      this.tree = frozen(blocks);
      this.baseline = $state.snapshot(blocks) as XbBlock[];
      this.issues = issues;
      this.styles = frozen(styles.styles);
      this.globals = frozen(styles.globals);
      this.queries = styles.queries ?? {};
      this.docHead = doc.head;
      this.docBase = doc.base;
      this.stylesHead = styles.head;
      this.stylesBase = styles.base;
      this.published = doc.published && styles.head === styles.base;
      this.issues = [
        ...issues,
        ...doc.conflicts.map((c) => t('Conflitto sul testo {0}: tenuta la versione del builder («{1}»), il cliente aveva scritto «{2}»', c.uid, c.dev, c.prod)),
      ];
      // Repairs (new uids, wrapped blocks) count as changes, so they get saved explicitly.
      this.savedContent = issues.length > 0 ? doc.content : this.content;
      this.savedStyles = this.stylesJson();
      this.script = doc.script;
      this.savedScript = doc.script;
      this.ref = doc.ref;
      this.schema = doc.schema;
      this.savedMeta = JSON.stringify([doc.ref, doc.schema]);
      this.usePageStyles(doc);
      // A reload (after a restore or a selector rename) starts a new history: older steps would undo it.
      this.past = [];
      this.future = [];
      this.lastRecord = null;
      this.syncHistoryFlags();
      this.treeRevision++;
      this.styleRevision++;
      const notes: string[] = [];
      if (doc.merged > 0) notes.push(tn('{0} testo modificato fuori dal builder integrato', '{0} testi modificati fuori dal builder integrati', doc.merged, doc.merged));
      if (doc.conflicts.length > 0) notes.push(tn('{0} conflitto (vedi Elemento)', '{0} conflitti (vedi Elemento)', doc.conflicts.length, doc.conflicts.length));
      if (issues.length > 0) notes.push(tn('{0} riparazione', '{0} riparazioni', issues.length, issues.length));
      const first = await early;
      if (first && first.content === this.content && this.contextId === contextId) {
        this.preview = first.preview;
        this.previewError = null;
        this.renderedKey = this.renderKey(first.content, contextId);
      }
      this.status = { kind: 'idle', message: notes.join(' · ') };
    } catch (e) {
      this.status = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ------------------------------------------------------------------ edits

  /**
   * «Rendi elemento» (doc 18 F5): the `index`-th `<tag>` in the element `uid`, a piece of its text, becomes an element
   * with a class of its own (proposed as the CSS panel does), and is selected. False when it cannot.
   */
  promoteInline(uid: string, tag: string, index: number): boolean {
    const result = promoteInline(this.tree, uid, tag, index, suggestedClass(this.tree, uid, tag));
    if (!result) {
      this.status = { kind: 'idle', message: t('Questo pezzo di testo non si può rendere un elemento qui.') };
      return false;
    }
    this.setTree(result.blocks);
    this.select(result.uid);
    this.status = { kind: 'idle', message: t('Ora è un elemento con la sua classe: si stila dal pannello CSS.') };
    return true;
  }

  setTree(tree: XbBlock[], options: { fromHtml?: boolean } = {}): void {
    // An edit from elsewhere reprints the HTML panel: text it refused would go.
    if (!options.fromHtml && !this.discardRejected(['html'])) return;
    const propSchemas = this.contentProps ? (ref: string) => this.components.find((c) => c.ref === ref)?.props as Record<string, { type?: string; options?: unknown[] }> | undefined : undefined;
    if (this.viewOnly && serializeXb(tree) !== this.content && this.refused(t('sola lettura'))) return;
    if (this.contentOnly && this.refused(contentOnlyProblem(this.baseline, $state.snapshot(tree) as XbBlock[], propSchemas))) return;
    // Frozen first: the parts shared with the current tree are serialized already (serializeXb remembers them).
    // A loop's {:else} stays its last child, whatever the edit (an insertion inside a loop appends after it).
    const next = frozen(elseLast(tree));
    if (next !== this.tree && serializeXb(next) !== this.content) this.record(options.fromHtml ? 'html' : null);
    this.tree = next;
    if (!options.fromHtml) this.treeRevision++;
  }

  loadExtensions(): Promise<void> {
    this.extensionsLoading ??= this.api.extensions().then(
      (e) => {
        this.extensions = e;
      },
      () => {
        this.extensionsLoading = null; // Try again next time.
      },
    );
    return this.extensionsLoading;
  }

  /**
   * The page's own look (voce 186): the selector's CSS on this page only. In client mode only in the groups given
   * (`lookGroups`), as the server checks again on save.
   */
  setPageStyle(selector: string, css: string): void {
    const next = setPageCss(this.pageStyles, selector, css);
    if (next === this.pageStyles || JSON.stringify(next) === JSON.stringify(this.pageStyles)) return;
    if (this.contentOnly) {
      if (this.lookGroups.length === 0) {
        this.refused(t('aspetto della pagina'));
        return;
      }
      const problem = lookProblem(this.pageBaseline, next, this.lookGroups);
      if (problem) {
        this.status = { kind: 'error', message: problem };
        return;
      }
    }
    this.record(`page:${selector}`);
    this.pageStyles = next;
  }

  upsertStyle(selector: string, css: string): void {
    if (this.contentOnly && this.refused(t('stili'))) return;
    const index = this.styles.findIndex((s) => s.selector === selector);
    if (index >= 0) {
      const current = this.styles[index] as StyleEntry;
      if (current.css === css) return;
      this.record(`css:${selector}`);
      this.styles = frozen(this.styles.map((s, i) => (i === index ? { ...current, css } : s)));
      return;
    }
    this.record(`css:${selector}`);
    this.styles = frozen([...this.styles, { id: this.uniqueStyleId(selector), selector, css }]);
  }

  /**
   * Blocks' rules leave the global sheets for their selectors (docs/spec/styles.md §11): the selectors' CSS and the
   * sheets change together, as one step to undo. An existing entry is rewritten in place; new entries go before
   * the existing ones, in the given order, since the sheets they come from were printed before every entry.
   */
  moveToSelector(entries: Array<{ selector: string; css: string }>, sheets: Record<string, string>): void {
    if (entries.length === 0 || (this.contentOnly && this.refused(t('stili')))) return;
    this.record(null);
    const fresh: StyleEntry[] = [];
    const styles = [...this.styles];
    for (const { selector, css } of entries) {
      const index = styles.findIndex((s) => s.selector === selector);
      if (index >= 0) styles[index] = { ...(styles[index] as StyleEntry), css };
      else fresh.push({ id: this.uniqueStyleId(selector, fresh), selector, css });
    }
    this.styles = frozen([...fresh, ...styles]);
    this.globals = frozen(this.globals.map((g) => (Object.hasOwn(sheets, g.id) ? { id: g.id, css: sheets[g.id] as string } : g)));
    this.styleRevision++;
  }

  /** Replaces one global sheet (`global` unless named: imported sites have their own, e.g. a migrated one). */
  setGlobalCss(css: string, id = 'global'): void {
    if (this.contentOnly && this.refused(t('stili'))) return;
    if ((this.globals.find((g) => g.id === id)?.css ?? '') === css) return;
    this.record(`css:sheet:${id}`);
    const index = this.globals.findIndex((g) => g.id === id);
    this.globals = frozen(index >= 0 ? this.globals.map((g, i) => (i === index ? { id, css } : g)) : [...this.globals, { id, css }]);
  }

  /** The block with this uid in the live tree, or null. */
  find(uid: string): XbBlock | null {
    return this.index.block.get(uid) ?? null;
  }

  /** Uids from the root to `uid` (inclusive), or [] when not in the tree. */
  path(uid: string): string[] {
    return pathIn(this.index, uid);
  }

  select(uid: string | null, source: 'html' | 'other' = 'other'): void {
    // The panels follow the selection: text they refused would go.
    if (uid !== this.selected && source !== 'html' && !this.discardRejected()) return;
    this.selectionSource = source;
    this.selected = uid;
    if (this.alsoSelected.length) this.alsoSelected = [];
  }

  /** Every selected node, the main one first; those no longer in the page are left out (E7). */
  get selection(): string[] {
    if (!this.selected) return [];
    return [this.selected, ...this.alsoSelected.filter((uid) => uid !== this.selected && this.index.block.has(uid))];
  }

  /** Ctrl/Cmd+click: the node joins the selection, or leaves it (the next one becomes the main one). */
  toggleSelect(uid: string): void {
    const now = this.selection;
    if (!now.length) return this.select(uid);
    if (!now.includes(uid)) {
      this.alsoSelected = [...now.slice(1), uid];
      return;
    }
    const rest = now.filter((u) => u !== uid);
    this.select(rest[0] ?? null);
    this.alsoSelected = rest.slice(1);
  }

  /** Shift+click: the siblings from the main selection to this node, both included. */
  selectRange(uid: string): void {
    const from = this.selected;
    const parent = this.index.parent.get(uid) ?? null;
    if (!from || (this.index.parent.get(from) ?? null) !== parent) return this.select(uid);
    const siblings = (parent ? childrenOf(parent) : this.tree).map((b) => b.attrs.uid);
    const [a, b] = [siblings.indexOf(from), siblings.indexOf(uid)].sort((x, y) => x - y);
    this.alsoSelected = siblings.slice(a, b! + 1).filter((u) => u !== from);
  }

  /** The selection to act on: the outermost nodes, in reading order. */
  private acted(): string[] {
    const order = documentOrder(this.tree);
    return outermost(this.index, this.selection).sort((x, y) => order.indexOf(x) - order.indexOf(y));
  }

  /** Delete on several nodes: one undo step. */
  removeSelection(): void {
    const uids = this.acted();
    if (!uids.length) return;
    let tree = this.tree;
    for (const uid of uids) tree = removeBlock(tree, uid);
    this.setTree(tree);
    this.select(null);
  }

  /** Duplicate on several nodes: each copy right after its original, the copies selected. One undo step. */
  duplicateSelection(): void {
    const uids = this.acted();
    let tree = this.tree;
    const copies: string[] = [];
    for (const uid of uids) {
      const block = findBlock(tree, uid);
      const [copy] = block ? reuid([block], randomUid) : [];
      if (!copy) continue;
      tree = insertAfter(tree, uid, [copy]);
      copies.push(copy.attrs.uid);
    }
    if (!copies.length) return;
    this.setTree(tree);
    this.select(copies[0]!);
    this.alsoSelected = copies.slice(1);
  }

  /** Up or down by one place, all together; nothing moves when one is already at the edge. One undo step. */
  moveSelection(delta: -1 | 1): void {
    const uids = this.acted();
    for (const uid of uids) {
      const parent = this.index.parent.get(uid);
      const siblings = (parent ? childrenOf(parent) : this.tree).map((b) => b.attrs.uid);
      const at = siblings.indexOf(uid) + delta;
      if (at < 0 || at >= siblings.length) {
        this.status = { kind: 'idle', message: delta < 0 ? t('È già il primo del suo contenitore') : t('È già l’ultimo del suo contenitore') };
        return;
      }
    }
    let tree = this.tree;
    for (const uid of delta < 0 ? uids : [...uids].reverse()) tree = moveBlock(tree, uid, delta);
    this.setTree(tree);
  }

  /** Wrap: siblings next to each other go into one new element, others each into their own. One undo step. */
  wrapSelection(tag: string): void {
    const uids = this.acted();
    if (!uids.length) return;
    const fresh = randomUid();
    let tree = wrapSiblings(this.tree, uids, tag, () => fresh);
    if (!tree) {
      tree = this.tree;
      for (const uid of uids) tree = wrapBlock(tree, uid, tag, randomUid);
    }
    this.setTree(tree);
    if (findBlock(tree, fresh)) this.select(fresh);
  }

  setSchema(schema: Schema, ref: string | null = this.ref): void {
    if (this.contentOnly && this.refused(t('props del componente'))) return;
    this.record(null);
    this.schema = schema;
    this.ref = ref;
  }

  // ------------------------------------------------------------------ typing in the panels

  /**
   * Applies a panel edit after `ms` of quiet, replacing the one the same panel still has pending. Saving
   * applies pending edits first, so what was typed just before Ctrl+S is saved too.
   */
  deferEdit(panel: string, ms: number, apply: () => void): void {
    this.cancelEdit(panel);
    this.pendingEdits.set(panel, { timer: setTimeout(() => this.applyEdit(panel), ms), apply });
    this.editsPending = true;
  }

  /** Drops the pending edit of a panel (its text is being replaced from the state), and what it refused. */
  cancelEdit(panel: string): void {
    // Panels call this from their effects: reading `rejected` must not make them depend on it.
    if (untrack(() => panel in this.rejected)) {
      const { [panel]: _gone, ...rest } = untrack(() => this.rejected);
      this.rejected = rest;
    }
    const edit = this.pendingEdits.get(panel);
    if (!edit) return;
    clearTimeout(edit.timer);
    this.pendingEdits.delete(panel);
    this.editsPending = this.pendingEdits.size > 0;
  }

  /** A panel keeps text it could not apply: `why` says what is wrong (the status line and saving repeat it). */
  reject(panel: string, why: string): void {
    this.rejected = { ...untrack(() => this.rejected), [panel]: why };
  }

  /**
   * True when no panel holds refused text (only `panels`, when given), or when the user agrees to drop it: then
   * it no longer counts, and the panels show the state again.
   */
  discardRejected(panels?: string[]): boolean {
    const rejected = untrack(() => this.rejected);
    const why = Object.entries(rejected).find(([panel]) => !panels || panels.includes(panel))?.[1];
    if (why === undefined) return true;
    if (!this.confirmDiscard(t('{0}: il testo non valido non è salvato e andrà perso. Continuare?', why))) return false;
    this.rejected = panels ? Object.fromEntries(Object.entries(rejected).filter(([panel]) => !panels.includes(panel))) : {};
    return true;
  }

  /** Applies every pending panel edit now. */
  flushEdits(): void {
    for (const panel of [...this.pendingEdits.keys()]) this.applyEdit(panel);
  }

  private applyEdit(panel: string): void {
    const edit = this.pendingEdits.get(panel);
    if (!edit) return;
    this.cancelEdit(panel);
    edit.apply();
  }

  // ------------------------------------------------------------------ structure operations

  insert(blocks: XbBlock[], position: InsertPosition = 'auto'): void {
    if (blocks.length === 0) return;
    this.setTree(insertAtSelection(this.tree, this.selected, blocks, position));
    this.select(blocks[0]?.attrs.uid ?? null);
  }

  /**
   * Turns the selected element into a new component (a component from the selection): the subtree becomes the
   * component's markup, the selection becomes an instance of it. Refused when the subtree reads names that only
   * exist here, such as a surrounding loop's variable.
   */
  async componentFromSelection(ref: string, title: string): Promise<void> {
    const uid = this.selected;
    const tree = this.tree;
    const block = uid ? findBlock(tree, uid) : null;
    if (!uid || !block) throw new Error(t('Seleziona prima l’elemento da trasformare in componente.'));
    const problem = componentProblem([block]);
    if (problem) throw new Error(problem);
    await this.api.createComponent(ref, title, serializeXb([block]));
    this.components = await this.api.listComponents();
    const instance: XbBlock = { name: 'xb/component', attrs: { uid: randomUid(), ref, label: title }, children: [] };
    this.setTree(replaceBlock(tree, uid, [instance]));
    this.select(instance.attrs.uid);
  }

  /** Names a node of the structure (`xb:label`); an empty label removes it. */
  /** Asks the CSS panel to show a selector (from a class in the code), then cleared by it. */
  cssRequest = $state<string | null>(null);

  /** Asks the structure to rename a node (the canvas's context menu, E3); the structure clears it. */
  renameRequest = $state<string | null>(null);

  /** Asks the canvas to start writing in an element's text (context menu, palette); the canvas clears it. */
  inlineRequest = $state<string | null>(null);

  /**
   * The text of an element written in the canvas (docs/spec/inline-text.md): `content` already passed through
   * inlineContent(). One undo step.
   */
  setTextContent(uid: string, content: string): void {
    const tree = this.tree;
    const block = findBlock(tree, uid);
    if (!block || block.name !== 'xb/element') return;
    const [text] = childrenOf(block);
    if (!text || text.name !== 'xb/text' || text.attrs.content === content) return;
    const next = { ...block, children: [{ ...text, attrs: { ...text.attrs, content } }] } as XbBlock;
    this.setTree(replaceBlock(tree, uid, [next]));
  }

  setLabel(uid: string, label: string): void {
    const tree = this.tree;
    const block = findBlock(tree, uid);
    if (!block || (block.name !== 'xb/element' && block.name !== 'xb/component')) return;
    const clean = cleanLabel(label);
    const { label: _old, ...rest } = block.attrs;
    const next = { ...block, attrs: clean ? { ...rest, label: clean } : rest } as XbBlock;
    this.setTree(replaceBlock(tree, uid, [next]));
  }

  /** The style copied from an element (E12): its classes and its own style attribute, as written. */
  copiedStyle = $state<{ class: AttrValue | null; style: AttrValue | null } | null>(null);

  /** Copies an element's style (context menu «Copia stile»); false when the node is not an element. */
  copyStyle(uid: string): boolean {
    const block = this.find(uid);
    if (!block || block.name !== 'xb/element') return false;
    const attributes = block.attrs.attributes ?? {};
    this.copiedStyle = { class: attributes.class ?? null, style: attributes.style ?? null };
    return true;
  }

  /** Gives an element the copied style: its classes and style attribute become the copied ones. One undo step. */
  pasteStyle(uid: string): void {
    const copied = this.copiedStyle;
    const tree = this.tree;
    const block = findBlock(tree, uid);
    if (!copied || !block || block.name !== 'xb/element') return;
    const { class: _class, style: _style, ...rest } = block.attrs.attributes ?? {};
    const attributes: Record<string, AttrValue> = { ...rest };
    if (copied.class !== null && copied.class !== '') attributes.class = copied.class;
    if (copied.style !== null && copied.style !== '') attributes.style = copied.style;
    const { attributes: _old, ...attrs } = block.attrs;
    const next = { ...block, attrs: Object.keys(attributes).length ? { ...attrs, attributes } : attrs } as XbBlock;
    this.setTree(replaceBlock(tree, uid, [next]));
  }

  /** Auto-BEM on the selected element: its children without a class get `blocco__parte`. Returns the classes added. */
  bem(uid: string): string[] {
    const tree = this.tree;
    const block = findBlock(tree, uid);
    if (!block || block.name !== 'xb/element') return [];
    const result = applyBem(block);
    if (result.added.length || result.block !== block) this.setTree(replaceBlock(tree, uid, [result.block]));
    return result.added;
  }

  /** Wraps a node in a new element (context menu of the structure). */
  wrap(uid: string, tag: string): void {
    const fresh = randomUid();
    this.setTree(wrapBlock(this.tree, uid, tag, () => fresh));
    this.select(fresh);
  }

  /** Removes an element, keeping its children in its place. */
  unwrap(uid: string): void {
    const tree = this.tree;
    const first = childrenOf(findBlock(tree, uid) ?? ({ name: 'xb/text', attrs: { uid: '', content: '' } } as XbBlock))[0];
    this.setTree(unwrapBlock(tree, uid));
    this.select(first && first.name !== 'xb/text' ? first.attrs.uid : null);
  }

  /** A clip from the clipboard waiting for the paste dialog (opened by App). */
  pasteRequest = $state<{ clip: Clip; at: string | null; trusted?: boolean } | null>(null);

  /** Removes a node; a selection inside it moves to a neighbour (selectionAfterRemoval), so Delete can go on. */
  remove(uid: string): void {
    const tree = this.tree;
    const selected = this.selected;
    const inside = selected !== null && this.path(selected).includes(uid);
    const next = inside ? selectionAfterRemoval(tree, this.index, uid) : selected;
    this.setTree(removeBlock(tree, uid));
    if (inside && this.tree !== tree) this.select(next);
  }

  duplicate(uid: string): void {
    const tree = this.tree;
    const block = findBlock(tree, uid);
    if (!block) return;
    const [copy] = reuid([block], randomUid);
    if (!copy) return;
    this.setTree(insertAfter(tree, uid, [copy]));
    this.select(copy.attrs.uid);
  }

  /** Up or down among its siblings; at the first or last place it says so instead of doing nothing (U6). */
  move(uid: string, delta: -1 | 1): void {
    const tree = this.tree;
    const parent = this.index.parent.get(uid);
    const siblings = parent ? childrenOf(parent) : tree;
    const at = siblings.findIndex((b) => b.attrs.uid === uid);
    if (at < 0) return;
    if (at + delta < 0 || at + delta >= siblings.length) {
      this.status = { kind: 'idle', message: delta < 0 ? t('È già il primo del suo contenitore') : t('È già l’ultimo del suo contenitore') };
      return;
    }
    this.setTree(moveBlock(tree, uid, delta));
  }

  /** Out of its parent, right after it (Alt+←). */
  outdent(uid: string): void {
    const tree = this.tree;
    const next = outdentBlock(tree, uid);
    if (next === tree) {
      this.status = { kind: 'idle', message: this.index.parent.get(uid) ? t('Da qui non può uscire dal suo contenitore') : t('È già al primo livello') };
      return;
    }
    this.setTree(next);
    this.select(uid);
  }

  /** Into the element right before it, at the end (Alt+→). */
  indent(uid: string): void {
    const tree = this.tree;
    const next = indentBlock(tree, uid);
    if (next === tree) {
      this.status = { kind: 'idle', message: t('Prima di questo elemento non c’è un contenitore in cui entrare') };
      return;
    }
    this.setTree(next);
    this.select(uid);
  }

  /** Asks the structure to open the context menu of a node, possibly on its «Crea componente» form (palette). */
  menuRequest = $state<{ uid: string; view: 'menu' | 'component' } | null>(null);

  /**
   * One declaration of a selector's own CSS, from outside the CSS panel (canvas handles): pending typing is
   * applied first, and the panel shows the new text.
   */
  setDeclarationOn(selector: string, prop: string, value: string | null, path: string[] = []): void {
    this.flushEdits();
    const css = this.styles.find((s) => s.selector === selector)?.css ?? '';
    this.upsertStyle(selector, path.length ? setBodyAt(css, path, setDeclaration(bodyAt(css, path), prop, value)) : setDeclaration(css, prop, value));
    this.styleRevision++;
  }

  /** Node being dragged in the structure panel. */
  dragging = $state<string | null>(null);
  /** Where a drag by touch or pen would drop it now (the row shows it as during a mouse drag). */
  dropHint = $state<{ uid: string; position: DropPosition } | null>(null);

  canDrop(target: string, position: DropPosition): boolean {
    return this.dragging !== null && canDrop(this.tree, this.dragging, target, position);
  }

  moveTo(uid: string, target: string, position: DropPosition): void {
    const tree = this.tree;
    const moved = moveTo(tree, uid, target, position);
    if (moved !== tree) {
      this.setTree(moved);
      this.select(uid);
    }
  }

  // ------------------------------------------------------------------ history

  private snapshot(): Snapshot {
    return { tree: this.tree, styles: this.styles, globals: this.globals, pageStyles: this.pageStyles, at: Date.now() };
  }

  /** Saves an undo point. Edits with the same non-null key in quick succession share the first one. */
  private record(key: string | null): void {
    this.editCount = untrack(() => this.editCount) + 1;
    const now = Date.now();
    const coalesce = key !== null && this.lastRecord?.key === key && now - this.lastRecord.at < COALESCE_MS;
    this.lastRecord = key === null ? null : { key, at: now };
    if (coalesce) return;
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.syncHistoryFlags();
  }

  private restore(snapshot: Snapshot): void {
    this.tree = frozen(snapshot.tree);
    this.styles = snapshot.styles;
    this.globals = snapshot.globals;
    this.pageStyles = snapshot.pageStyles;
    this.treeRevision++;
    this.styleRevision++;
  }

  undo(): void {
    if (!this.discardRejected()) return;
    this.lastRecord = null;
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.snapshot());
    this.restore(previous);
    this.syncHistoryFlags();
  }

  redo(): void {
    if (!this.discardRejected()) return;
    this.lastRecord = null;
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot());
    this.restore(next);
    this.syncHistoryFlags();
  }

  /**
   * The undo history in words (docs/spec/history-panel.md), oldest first: each step done (`done`, undoable) and
   * each step undone (redoable). `back` is how many undos lead to the state before it (negative: redos to after it).
   */
  historySteps(): Array<{ label: string; at: number; done: boolean; back: number }> {
    const now = this.snapshot();
    const out: Array<{ label: string; at: number; done: boolean; back: number }> = [];
    const past = this.past;
    past.forEach((before, i) => out.push({ label: describeStep(before, past[i + 1] ?? now), at: before.at, done: true, back: past.length - i }));
    const future = [...this.future].reverse();
    future.forEach((after, i) => out.push({ label: describeStep(future[i - 1] ?? now, after), at: after.at, done: false, back: -(i + 1) }));
    return out;
  }

  /** Back (positive) or forward (negative) through the history in one go. */
  jump(steps: number): void {
    this.flushEdits();
    if (!this.discardRejected()) return;
    for (let i = 0; i < Math.abs(steps); i++) {
      if (steps > 0) this.undo();
      else this.redo();
    }
  }

  private syncHistoryFlags(): void {
    this.canUndo = this.past.length > 0;
    this.canRedo = this.future.length > 0;
  }

  // ------------------------------------------------------------------ server

  /** After the framework's own dashboard changed it: classes, variables, and the stylesheets of the preview. */
  async reloadFramework(): Promise<void> {
    try {
      this.framework = await this.api.getFramework();
    } catch {
      // Completions keep the previous list; the preview below still picks up new stylesheets.
    }
    await this.refreshPreview();
  }

  /** What the preview on screen was rendered from: the canvas skips a render of the same content. */
  private renderedKey = '';

  /** What a drawing depends on. A component draws with its props' samples: a schema saved meanwhile (sent no more) still means a new drawing. */
  private renderKey(content: string, contextId: number): string {
    return `${this.postId}|${contextId}|${this.isComponent ? this.metaJson() : ''}|${content}`;
  }

  /**
   * Renders the canvas from the current content. `force: false` (the content watcher) skips content already
   * rendered; anything else (a component saved, the framework changed) renders again.
   */
  async refreshPreview(force = true, withCss = false): Promise<void> {
    const schema = this.sampleSchema;
    const key = this.renderKey(this.content, this.contextId);
    if (!force && key === this.renderedKey && this.preview) return;
    this.renderedKey = key;
    this.renderAbort?.abort();
    const abort = new AbortController();
    this.renderAbort = abort;
    try {
      this.preview = await this.api.render(this.postId, this.content, abort.signal, this.contextId, { css: withCss, known: this.preview, schema });
      this.previewError = null;
    } catch (e) {
      if (abort.signal.aborted) return;
      // Not rendered: the next trigger tries again.
      if (this.renderedKey === key) this.renderedKey = '';
      this.previewError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Saves what the document holds when each request is sent. Edits made while a request is in flight stay
   * local and dirty: the saved baseline becomes what the server stored, and what the server changed (filtered
   * content, normalised style entries) is put under them, part by part (rebase.ts). Panel edits still pending are
   * applied first, so the panels reprint what they show.
   */
  async save(): Promise<void> {
    this.flushEdits();
    if (!this.doc || !this.dirty || this.status.kind === 'saving') return;
    if (this.viewOnly) {
      this.refused(t('sola lettura'));
      return;
    }
    // Refused text cannot be saved: say so, and save the rest, if any.
    if (this.invalid && !this.dirtyContent && !this.dirtyStyles && !this.dirtyScript && !this.dirtyMeta && !this.dirtyPage) {
      this.status = { kind: 'error', message: t('{0}: non salvato', this.invalid) };
      return;
    }
    this.status = { kind: 'saving', message: t('Salvataggio…') };
    try {
      if (this.dirtyStyles) {
        const sent = this.stylesJson();
        const sentStyles = this.styles;
        const sentGlobals = this.globals;
        const saved = await this.api.saveStyles($state.snapshot(this.styles), $state.snapshot(this.globals), this.stylesHead, this.stylesBase);
        this.stylesHead = saved.head;
        this.stylesBase = saved.base;
        const stored = { styles: frozen(saved.styles), globals: frozen(saved.globals) };
        this.savedStyles = this.stylesJson(stored.styles, stored.globals);
        if (this.savedStyles !== sent) {
          this.flushEdits();
          const styles = rebaseEntries(this.styles, sentStyles, stored.styles);
          const globals = rebaseEntries(this.globals, sentGlobals, stored.globals);
          if (this.stylesJson(styles, globals) !== this.stylesJson()) {
            this.styles = frozen(styles);
            this.globals = frozen(globals);
            this.styleRevision++;
          }
        }
      }
      if (this.dirtyContent || this.dirtyScript || this.dirtyMeta || this.dirtyPage) {
        const sent = this.content;
        const sentTree = this.tree;
        const script = this.script;
        const meta = this.metaJson();
        const look = this.pageStyles;
        const extras: { script?: string; schema?: Schema; ref?: string; styles?: PageStyle[] } = {};
        if (this.dirtyScript) extras.script = this.script;
        if (this.dirtyPage) extras.styles = $state.snapshot(this.pageStyles) as PageStyle[];
        if (this.dirtyMeta && this.isComponent) {
          if (this.schema) extras.schema = $state.snapshot(this.schema);
          if (this.ref) extras.ref = this.ref;
        }
        const doc = await this.api.saveDocument(this.postId, sent, this.docHead, this.docBase, extras);
        this.doc = doc;
        // Stored as sent: the tree that was sent is the baseline, no need to read the text again.
        this.baseline = doc.content === sent ? (sentTree as XbBlock[]) : parseXb(doc.content).blocks;
        this.docHead = doc.head;
        this.docBase = doc.base;
        if (doc.content === sent) {
          this.savedContent = sent;
        } else {
          // The server filtered something (permissions): show exactly what was stored, under any later edit.
          const stored = this.baseline;
          this.savedContent = serializeXb(stored);
          this.flushEdits();
          const tree = this.content === sent ? stored : rebaseTree(this.tree, sentTree, stored);
          if (tree !== this.tree) {
            this.tree = frozen(tree);
            this.treeRevision++;
          }
          // While edits made during the save are unsaved a 'saved' status is not shown: this notice is.
          this.status = this.dirtyContent
            ? { kind: 'idle', message: t('Alcuni elementi sono stati filtrati per i tuoi permessi; le modifiche fatte durante il salvataggio non sono ancora salvate.') }
            : { kind: 'saved', message: t('Salvato. Alcuni elementi sono stati filtrati per i tuoi permessi.') };
        }
        this.savedScript = doc.script;
        if (this.script === script) this.script = doc.script;
        this.savedMeta = JSON.stringify([doc.ref, doc.schema]);
        if (doc.pageStyles) {
          const stored = doc.pageStyles.map((e) => ({ selector: e.selector, css: e.css }));
          this.savedPageStyles = JSON.stringify(stored);
          this.pageBaseline = stored;
          if (this.pageStyles === look) this.pageStyles = stored;
        }
        if (this.metaJson() === meta) {
          this.ref = doc.ref;
          this.schema = doc.schema;
        }
        if (this.isComponent) this.components = await this.api.listComponents();
      }
      this.published = false;
      if (this.invalid) this.status = { kind: 'error', message: t('Salvato in sviluppo il resto; {0}: non salvato', this.invalid) };
      else if (this.status.kind === 'saving') this.status = { kind: 'saved', message: t('Salvato in sviluppo: non ancora pubblicato') };
    } catch (e) {
      const message = e instanceof ApiError && e.status === 409 ? e.message : t('Salvataggio non riuscito: {0}', e instanceof Error ? e.message : String(e));
      this.status = { kind: 'error', message };
    }
  }

  /** JSON of each frozen entry or sheet, worked out once: comparing all the styles after an edit costs the edit. */
  private readonly entryJson = new WeakMap<object, string>();
  private stylesJson(styles: object[] = this.styles, globals: object[] = this.globals): string {
    const json = (item: object) => {
      let out = this.entryJson.get(item);
      if (out === undefined) {
        out = JSON.stringify(item);
        if (Object.isFrozen(item)) this.entryJson.set(item, out);
      }
      return out;
    };
    // Exactly JSON.stringify(styles) + JSON.stringify(globals), from the remembered pieces.
    return `[${styles.map(json).join(',')}][${globals.map(json).join(',')}]`;
  }

  private metaJson(): string {
    return JSON.stringify([this.ref, this.schema]);
  }

  private uniqueStyleId(selector: string, pending: StyleEntry[] = []): string {
    const base = selector.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 56) || 'style';
    let id = base;
    for (let n = 2; this.styles.some((s) => s.id === id) || pending.some((s) => s.id === id); n++) id = `${base}-${n}`;
    return id;
  }
}
