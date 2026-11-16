// The page's own look in Gutenberg (voce 186; docs/spec/client-mode.md, «Aspetto della pagina»): the Aspetto panel
// writes here when a change must stay on this page, never in the site's classes. Loaded with the editor, shown in the
// canvas at once (a <style> after the site's styles, scoped to `:root`: one class more than the site's own rule), saved
// in development with the document (POST /documents/{id} with `styles`), where the server checks the grammar and,
// for a client, the level and the groups.
import type { DocumentData } from '../lib/api.ts';
import { lookProblem, pageCss, setPageDeclaration, type PageStyle } from '../lib/pageLook.ts';
import { api, config, errorText } from './context.ts';
import { useEffect, useState } from './wp.ts';

interface PageState {
  entries: PageStyle[] | null;
  /** The entries as loaded or saved: a client's changes are checked against them. */
  saved: PageStyle[];
  doc: DocumentData | null;
  queries: Record<string, string>;
  dirty: boolean;
  saving: boolean;
  error: string;
}

let page: PageState = { entries: null, saved: [], doc: null, queries: {}, dirty: false, saving: false, error: '' };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

/** The groups this user may write in this page's own look ([] for none). */
export const lookGroups: string[] = Array.isArray(config?.pageLook) ? config.pageLook.filter((g): g is string => typeof g === 'string') : [];

function set(next: Partial<PageState>) {
  page = { ...page, ...next };
  if (page.entries) preview(page.entries, page.queries);
  listeners.forEach((l) => l());
}

/** Loads the page's look once (the editor calls it at start, so the canvas shows it before any panel opens). */
export function loadPageStyles(): Promise<void> {
  if (!api || !config?.postId) return Promise.resolve();
  const client = api;
  loading ??= client
    .getDocument(config.postId)
    .then(async (doc) => {
      const entries = (doc.pageStyles ?? []).map((e) => ({ selector: e.selector, css: e.css }));
      // The named widths only when they are needed to draw, or to write (the panel offers them).
      const queries = lookGroups.length > 0 || entries.some((e) => e.css.includes('(--')) ? ((await client.getStyles()).queries ?? {}) : {};
      set({ entries, saved: entries, doc, queries, error: '' });
    })
    .catch((e) => {
      // Asked again by the next call, like the site's styles (styles.ts).
      loading = null;
      set({ error: errorText(e) });
    });
  return loading;
}

export function usePageStyles(): PageState {
  const [, update] = useState(0);
  useEffect(() => {
    const listener = () => update((n) => n + 1);
    listeners.add(listener);
    void loadPageStyles();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return page;
}

/** One declaration on this page (null removes it); refused at once when the server would refuse it. */
export function setPageLook(selector: string, path: string[], prop: string, value: string | null): string {
  if (!page.entries) return '';
  const next = setPageDeclaration(page.entries, selector, path, prop, value);
  const problem = config?.client ? lookProblem(page.saved, next, lookGroups) : '';
  if (problem) {
    set({ error: problem });
    return problem;
  }
  set({ entries: next, dirty: true, error: '' });
  return '';
}

export async function savePageStyles(): Promise<void> {
  if (!api || !config || !page.entries || !page.doc || page.saving) return;
  set({ saving: true, error: '' });
  try {
    // The document as it is in development: only the look changes (a client's texts change in the builder).
    const fresh = await api.getDocument(config.postId);
    const saved = await api.saveDocument(config.postId, fresh.content, fresh.head, fresh.base, { styles: page.entries });
    const entries = (saved.pageStyles ?? page.entries).map((e) => ({ selector: e.selector, css: e.css }));
    set({ entries, saved: entries, doc: saved, dirty: false, saving: false });
  } catch (e) {
    set({ saving: false, error: errorText(e) });
  }
}

function canvasDocument(): Document {
  const iframe = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
  return iframe?.contentDocument ?? document;
}

/** The page's look in the canvas, after the site's styles; exported for the tests. */
export function applyPageStyles(entries: PageStyle[], queries: Record<string, string>, doc: Document): void {
  let el = doc.getElementById('xb-page-preview') as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement('style');
    el.id = 'xb-page-preview';
  }
  // Last in the head, so it comes after the site's own <style> elements; textContent: CSS text, never markup.
  if (el.parentNode !== doc.head || doc.head.lastElementChild !== el) doc.head.appendChild(el);
  const css = pageCss(entries, queries);
  if (el.textContent !== css) el.textContent = css;
}

/** At the next frame; while the canvas iframe is not there yet (the editor is still starting), again a little later. */
function preview(entries: PageStyle[], queries: Record<string, string>, tries = 20) {
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 0);
  schedule(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
    if (!iframe?.contentDocument?.head && tries > 0 && document.querySelector('.block-editor-iframe__container, .edit-post-visual-editor')) {
      setTimeout(() => preview(entries, queries, tries - 1), 500);
      return;
    }
    applyPageStyles(entries, queries, canvasDocument());
  });
}
