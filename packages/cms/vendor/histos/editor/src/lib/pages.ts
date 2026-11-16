// Pages of a release, loaded in sandboxed frames from the Publish window: the visual comparison
// (VisualDiff.svelte) and the page checks before publishing (PublishChecks.svelte). Same rules as the canvas:
// the frame runs no script of the page, and a page that went to another origin is never read.
import type { Api, Change } from './api.ts';
import { t } from './i18n.ts';
import { FREEZE } from './visualDiff.ts';

export interface PageTarget {
  id: number;
  label: string;
  /** The page as visitors see it now; null when it is not online yet. */
  live: string | null;
  /** The signed development preview. */
  dev: string;
}

/** At most this many pages per check. */
export const MAX_PAGES = 6;
const LOAD_TIMEOUT = 30_000;

/**
 * The page open in the builder (styles and components show through it) and every page or template among the
 * changes. `needLive`: only pages already online (to compare them). Notes say what was left out and why; `total`
 * counts the targets and the pages left out past MAX_PAGES (M-B1: a round says how many it checked of how many).
 */
export async function pageTargets(api: Api, postId: number, changes: Change[], needLive: boolean): Promise<{ targets: PageTarget[]; skipped: string[]; total: number }> {
  const ids = new Map<number, string>();
  if (postId) ids.set(postId, t('Pagina aperta nel builder'));
  for (const c of changes) {
    const m = /^post:(\d+)$/.exec(c.doc);
    if (m) ids.set(Number(m[1]), ids.get(Number(m[1])) ?? c.label);
  }
  const targets: PageTarget[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let over = 0;
  for (const [id, label] of ids) {
    if (targets.length >= MAX_PAGES) {
      skipped.push(t('{0}: oltre le {1} pagine di un controllo', label, MAX_PAGES));
      over++;
      continue;
    }
    const link = await api.previewLink(id);
    const live = link.live ?? null;
    if (needLive && !live) {
      skipped.push(t('{0}: non ha una pagina online da confrontare (nuova, o un componente: si vede nelle pagine che lo usano)', label));
      continue;
    }
    const key = live ?? link.url.replace(/[?&]xb_preview=[^&]*/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ id, label, live, dev: link.url });
  }
  return { targets, skipped, total: targets.length + over };
}

/** Loads a same-origin page in a sandboxed frame (no scripts) and waits for its load. */
export function loadFrame(frame: HTMLIFrameElement, url: string): Promise<Document> {
  return new Promise((resolve, reject) => {
    const done = () => {
      const doc = frame.contentDocument;
      if (doc?.URL === 'about:blank') return; // The empty frame's own load, before the page.
      clearTimeout(timer);
      frame.removeEventListener('load', done);
      // A page that went to another site is never read.
      if (!doc || doc.location.origin !== window.location.origin) return reject(new Error(t('La pagina non si può leggere da qui')));
      resolve(doc);
    };
    const timer = setTimeout(() => {
      frame.removeEventListener('load', done);
      reject(new Error(t('La pagina non ha finito di caricarsi in 30 secondi')));
    }, LOAD_TIMEOUT);
    frame.addEventListener('load', done);
    frame.src = url;
  });
}

/** Animations off, Histeon's own marks hidden, fonts loaded: the page as it will stay. */
export async function settle(doc: Document): Promise<void> {
  const style = doc.createElement('style');
  style.textContent = FREEZE;
  doc.head?.append(style);
  await Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, 3000))]);
  await new Promise((r) => setTimeout(r, 300));
}
