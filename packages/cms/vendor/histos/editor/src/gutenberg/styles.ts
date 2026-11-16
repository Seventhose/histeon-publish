// The site's styles in Gutenberg, shared by the Aspetto panel, the CSS tab and the dock (lista della spesa 130-132):
// one store, so a change made in one place is the same text everywhere else at once.
//
// The canvas preview is incremental (131): every selector has its own <style>, compiled again only when its CSS
// changed, and the updates of one frame are applied together. A click in the Aspetto panel on a page with hundreds
// of selectors recompiles one rule, not the whole site.
import { compileCss, resolveNamedQueries } from '@xb/dsl';
import type { FrameworkData, StylesData } from '../lib/api.ts';
import { api, errorText } from './context.ts';
import { classTokens, isDynamic } from './classes.ts';
import { __, h, useEffect, useState, wp, type GutenbergBlock } from './wp.ts';

/** The last change made from a visual control, for the code to show where it went (132). */
export interface StyleChange {
  selector: string;
  prop: string;
  before: string | null;
  after: string | null;
  /** The block it went into (`@media (--tablet)`, `&:hover`), outermost first; empty for the rule itself. */
  path: string[];
  at: number;
}

interface StylesState {
  data: StylesData | null;
  dirty: boolean;
  error: string;
  saving: boolean;
  change: StyleChange | null;
}
let styles: StylesState = { data: null, dirty: false, error: '', saving: false, change: null };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function setStyles(next: Partial<StylesState>) {
  styles = { ...styles, ...next };
  if (next.data && styles.dirty) preview(styles.data);
  listeners.forEach((l) => l());
}

/** The shared styles, loaded the first time a panel asks; the panel redraws when they change. */
export function useStyles(): StylesState {
  const [, update] = useState(0);
  useEffect(() => {
    const listener = () => update((n) => n + 1);
    listeners.add(listener);
    if (!loading && api) {
      loading = api
        .getStyles()
        .then((data) => setStyles({ data, error: '' }))
        .catch((e) => {
          // Asked again by the next panel that opens, like the framework and the queries (logic.ts).
          loading = null;
          setStyles({ error: errorText(e) });
        });
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return styles;
}

// ------------------------------------------------------------------ undo and redo with labels (list 141)

interface Step {
  data: StylesData;
  label: string;
  at: number;
}
let past: Step[] = [];
let future: Step[] = [];
const MAX_STEPS = 100;
/** Edits typed in the code within this time make one step, as a word processor does. */
const MERGE_MS = 1500;

/** The words of a step: what the visual control changed, or the selector whose code was edited. */
export function stepLabel(visual: StyleChange | null, selector?: string): string {
  if (visual) return `${visual.prop} ${__('di')} ${visual.selector}`;
  return selector ? __('CSS di {0}', selector) : __('modifica del CSS');
}

/** What undo and redo would do now, for the buttons. */
export function history(): { undo: string | null; redo: string | null } {
  return { undo: past.at(-1)?.label ?? null, redo: future.at(-1)?.label ?? null };
}

export function editStyles(change: (data: StylesData) => StylesData, visual: StyleChange | null = null, selector?: string) {
  const current = styles.data;
  if (!current) return;
  const label = stepLabel(visual, selector);
  const now = Date.now();
  const last = past.at(-1);
  // Typing in the code: one step for a burst of keys on the same selector.
  if (!(visual === null && last && last.label === label && now - last.at < MERGE_MS)) {
    past = [...past, { data: current, label, at: now }].slice(-MAX_STEPS);
  } else {
    last.at = now;
  }
  future = [];
  styles = { ...styles, dirty: true };
  setStyles({ data: change(current), change: visual });
}

export function undoStyles() {
  const step = past.at(-1);
  if (!step || !styles.data) return;
  past = past.slice(0, -1);
  future = [...future, { data: styles.data, label: step.label, at: Date.now() }];
  styles = { ...styles, dirty: true };
  setStyles({ data: step.data, change: null });
}

export function redoStyles() {
  const step = future.at(-1);
  if (!step || !styles.data) return;
  future = future.slice(0, -1);
  past = [...past, { data: styles.data, label: step.label, at: 0 }];
  styles = { ...styles, dirty: true };
  setStyles({ data: step.data, change: null });
}

/** Undo and redo as buttons that say what they undo («Annulla: padding di .card»). */
export function HistoryButtons() {
  useStyles();
  const { undo, redo } = history();
  if (!undo && !redo) return null;
  return h(
    'div',
    { className: 'xb-insp-row xb-history' },
    h(wp.components.Button, { variant: 'tertiary', size: 'compact', disabled: !undo, onClick: undoStyles, title: undo ? __('Annulla: {0}', undo) : undefined }, '↶ ' + (undo ? __('Annulla: {0}', undo) : __('Annulla'))),
    redo ? h(wp.components.Button, { variant: 'tertiary', size: 'compact', onClick: redoStyles }, '↷ ' + __('Ripeti: {0}', redo)) : null,
  );
}

export async function saveStyles() {
  if (!api || !styles.data || styles.saving) return;
  setStyles({ saving: true, error: '' });
  try {
    const { styles: entries, globals, head, base } = styles.data;
    const saved = await api.saveStyles(entries, globals, head, base);
    setStyles({ data: saved, dirty: false, saving: false });
  } catch (e) {
    setStyles({ saving: false, error: errorText(e) });
  }
}

/** The selectors whose CSS a block can have: its static classes, then its id. Only elements have them. */
export function blockSelectors(block: GutenbergBlock): string[] {
  if (block.name !== 'xb/element') return [];
  const attrs: Record<string, unknown> = block.attributes.attributes ?? {};
  return [
    ...classTokens(attrs.class)
      .filter((t) => !isDynamic(t))
      .map((t) => '.' + t),
    ...(typeof attrs.id === 'string' && attrs.id && !isDynamic(attrs.id) ? ['#' + attrs.id] : []),
  ];
}

/** The selector's own CSS, '' when it has none. */
export function ownCss(data: StylesData, selector: string): string {
  return data.styles.find((s) => s.selector === selector)?.css ?? '';
}

/** Replaces the selector's own CSS, adding its entry when it has none. */
export function setOwnCss(selector: string, css: string, visual: StyleChange | null = null) {
  editStyles((d) => {
    const index = d.styles.findIndex((s) => s.selector === selector);
    const entries = [...d.styles];
    if (index >= 0) entries[index] = { ...entries[index]!, css };
    else entries.push({ id: `${selector.replace(/[^a-z0-9_-]/gi, '')}-${Math.random().toString(36).slice(2, 8)}`, selector, css });
    return { ...d, styles: entries };
  }, visual, selector);
}

// ------------------------------------------------------------------ framework (the scales of the Aspetto panel)

let framework: FrameworkData | null = null;
let frameworkLoading: Promise<void> | null = null;

/** The active framework's variables and classes, loaded once per editor. */
export function useFramework(): FrameworkData | null {
  const [, update] = useState(0);
  useEffect(() => {
    if (!framework && !frameworkLoading && api) {
      frameworkLoading = api.getFramework().then(
        (data) => {
          framework = data;
          listeners.forEach((l) => l());
        },
        () => {
          frameworkLoading = null;
        },
      );
    }
    const listener = () => update((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return framework;
}

// ------------------------------------------------------------------ canvas preview, one <style> per selector

interface Compiled {
  selector: string;
  css: string;
  queries: string;
  el: HTMLStyleElement;
}
let compiled = new Map<string, Compiled>();
let previewDoc: Document | null = null;
let order: string[] = [];
let pending: StylesData | null = null;
let frame = 0;

function canvasDocument(): Document {
  const iframe = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
  return iframe?.contentDocument ?? document;
}

/** The edited CSS in the canvas: the live stylesheet is switched off and these take its place, at the next frame. */
export function preview(data: StylesData | null) {
  if (!data) return;
  pending = data;
  if (frame) return;
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 0) as unknown as number;
  frame = schedule(() => {
    frame = 0;
    const next = pending;
    pending = null;
    if (next) applyPreview(next, canvasDocument());
  });
}

/** Writes the preview into `doc`, touching only the selectors whose CSS changed. Exported for the tests. */
export function applyPreview(data: StylesData, doc: Document): { compiled: number } {
  if (doc !== previewDoc) {
    compiled = new Map();
    order = [];
    previewDoc = doc;
  }
  const live = doc.getElementById('xb-styles-editor-inline-css') as HTMLStyleElement | null;
  if (live?.sheet) live.sheet.disabled = true;
  const queries = data.queries ?? {};
  const queriesKey = JSON.stringify(queries);
  let globals = doc.getElementById('xb-inspector-preview') as HTMLStyleElement | null;
  if (!globals) {
    globals = doc.createElement('style');
    globals.id = 'xb-inspector-preview';
    doc.head.appendChild(globals);
  }
  // textContent: CSS text, never markup.
  const globalText = resolveNamedQueries(data.globals.map((g) => g.css).join('\n'), queries);
  if (globals.textContent !== globalText) globals.textContent = globalText;

  let count = 0;
  const ids = data.styles.map((s) => s.id);
  for (const entry of data.styles) {
    let c = compiled.get(entry.id);
    if (!c) {
      const el = doc.createElement('style');
      el.dataset.xbPreview = entry.id;
      c = { selector: '', css: '', queries: '', el };
      compiled.set(entry.id, c);
    }
    if (c.selector !== entry.selector || c.css !== entry.css || c.queries !== queriesKey) {
      c.el.textContent = resolveNamedQueries(compileCss(entry.selector, entry.css), queries);
      c.selector = entry.selector;
      c.css = entry.css;
      c.queries = queriesKey;
      count += 1;
    }
  }
  for (const [id, c] of compiled) {
    if (!ids.includes(id)) {
      c.el.remove();
      compiled.delete(id);
    }
  }
  // The selectors keep the order they have in the site's CSS, after the global sheets: the cascade does not change.
  if (ids.join('\n') !== order.join('\n') || ids.some((id) => !compiled.get(id)!.el.isConnected)) {
    let after: Element = globals;
    for (const id of ids) {
      const el = compiled.get(id)!.el;
      if (after.nextElementSibling !== el) after.after(el);
      after = el;
    }
    order = ids;
  }
  return { compiled: count };
}
