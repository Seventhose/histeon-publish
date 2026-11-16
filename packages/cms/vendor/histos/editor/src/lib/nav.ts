import { t } from './i18n.ts';

/** Opening another document in the builder (same page, so the overlay over Gutenberg keeps working). */
export function builderUrl(post: number): string {
  const url = new URL(window.location.href);
  url.searchParams.set('post', String(post));
  return url.href;
}

/** Back to the Gutenberg editor that opened the builder over itself (only that page, on this origin, listens). */
export function closeEmbed(dirty: boolean): void {
  if (dirty && !window.confirm(t('Ci sono modifiche non salvate: tornare comunque a Gutenberg?'))) return;
  window.parent.postMessage({ type: 'xb:close' }, window.location.origin);
}

export function openDocument(post: number, dirty: boolean): void {
  if (dirty && !window.confirm(t('Ci sono modifiche non salvate: uscire comunque?'))) return;
  window.location.href = builderUrl(post);
}
