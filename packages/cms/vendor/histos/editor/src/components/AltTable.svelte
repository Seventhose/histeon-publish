<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import { literal, pageImages } from '../lib/media.ts';
  import { setAttribute } from '../lib/attributes.ts';
  import { updateBlock } from '../lib/tree.ts';
  import type { ElementBlock } from '@xb/dsl';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Every image of the page with its alternative text, in one table (docs/spec/media.md, «Testi alternativi»):
  // alt and SEO done for a whole page at once instead of one image at a time.
  let { app, onshow }: { app: BuilderState; onshow: () => void } = $props();

  let missingOnly = $state(false);
  const images = $derived(pageImages(app.index.block.values()));
  const missing = $derived(images.filter((i) => i.alt === null).length);
  const shown = $derived(missingOnly ? images.filter((i) => i.alt === null) : images);
  let errors = $state<Record<string, string>>({});

  /** A static URL to show as a thumbnail; nothing for an expression. */
  const thumb = (src: string) => (/^(https?:\/\/|\/)[^{}]*$/.test(src) ? src : null);
  const file = (src: string) => src.split('/').pop() || src;

  function setAlt(uid: string, value: string | null) {
    const block = app.find(uid);
    if (!block || block.name !== 'xb/element') return;
    const current = (block as ElementBlock).attrs.attributes ?? {};
    let next: ElementBlock;
    if (value === null) {
      const { alt: _gone, ...rest } = current;
      next = { ...(block as ElementBlock), attrs: { ...block.attrs, attributes: rest } } as ElementBlock;
    } else {
      // Typed text: braces are literal (an alt written here is never an expression).
      const edit = setAttribute(block as ElementBlock, Object.hasOwn(current, 'alt') ? 'alt' : null, 'alt', literal(value));
      if (!edit.ok) {
        errors = { ...errors, [uid]: edit.error };
        return;
      }
      next = edit.block;
      // An empty value is a decorative image: alt="", never the bare attribute.
      if (value === '') next = { ...next, attrs: { ...next.attrs, attributes: { ...next.attrs.attributes, alt: '' } } };
    }
    const { [uid]: _ok, ...rest } = errors;
    errors = rest;
    app.setTree(updateBlock(app.tree, uid, () => next));
  }

  function show(uid: string) {
    app.select(uid);
    onshow();
  }
</script>

<div class="alts">
  <div class="bar">
    <span>{tn('{0} immagine', '{0} immagini', images.length, images.length)} · {tn('{0} senza testo alternativo', '{0} senza testo alternativo', missing, missing)}</span>
    <label class="check"><input type="checkbox" bind:checked={missingOnly} /> {t('Solo senza testo alternativo')}</label>
  </div>
  {#if shown.length === 0}
    <p class="empty">{images.length === 0 ? t('In questa pagina non ci sono immagini.') : t('Ogni immagine ha il suo testo alternativo.')}</p>
  {:else}
    <table>
      <thead>
        <tr><th scope="col">{t('Immagine')}</th><th scope="col">{t('Testo alternativo')}</th><th scope="col">{t('Decorativa')}</th><th scope="col"><span class="sr">{t('Azioni')}</span></th></tr>
      </thead>
      <tbody>
        {#each shown as image (image.uid)}
          {@const src = thumb(image.src)}
          <tr class:missing={image.alt === null}>
            <td class="pic">
              {#if src}<img src={src} alt="" loading="lazy" />{/if}
              <span class="mono" title={image.src}>{image.dynamic && !src ? image.src : file(image.src)}</span>
            </td>
            <td>
              {#if image.dynamic}
                <span class="mono dynamic" title={t('Viene dal contenuto: si cambia nel pannello HTML o nel contenuto')}>{image.alt ?? '—'}</span>
              {:else}
                <input
                  value={image.alt ?? ''}
                  placeholder={image.alt === null ? t('Manca: descrivi l’immagine') : ''}
                  disabled={image.alt === ''}
                  aria-label={t('Testo alternativo di {0}', file(image.src))}
                  onchange={(e) => setAlt(image.uid, e.currentTarget.value.trim() === '' ? null : e.currentTarget.value.trim())}
                />
                {#if errors[image.uid]}<p class="error" role="alert">{errors[image.uid]}</p>{/if}
              {/if}
            </td>
            <td class="deco">
              <input type="checkbox" checked={image.alt === ''} disabled={image.dynamic} aria-label={t('{0} è decorativa (alt vuoto)', file(image.src))} onchange={(e) => setAlt(image.uid, e.currentTarget.checked ? '' : null)} />
            </td>
            <td><button onclick={() => show(image.uid)}>{t('Mostra')}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .alts { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
  .bar { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--xb-line); color: var(--xb-muted); flex-wrap: wrap; }
  .check { display: inline-flex; gap: 6px; align-items: center; color: var(--xb-text); }
  .empty { padding: 16px; color: var(--xb-muted); }
  table { width: 100%; border-collapse: collapse; overflow: auto; display: block; }
  thead, tbody { display: table; width: 100%; table-layout: fixed; }
  th { text-align: left; font: 600 11px var(--xb-sans); color: var(--xb-muted); padding: 6px 12px; border-bottom: 1px solid var(--xb-line); }
  th:nth-child(1) { width: 34%; }
  th:nth-child(3), th:nth-child(4) { width: 90px; }
  td { padding: 6px 12px; border-bottom: 1px solid var(--xb-line); vertical-align: middle; }
  tr.missing td:first-child { box-shadow: inset 3px 0 0 var(--xb-danger); }
  .pic { display: flex; gap: 8px; align-items: center; min-width: 0; }
  .pic img { width: 48px; height: 36px; object-fit: cover; border-radius: var(--xb-r-sm); background: var(--xb-stage); flex: none; }
  .pic span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font: 12px var(--xb-mono); }
  .dynamic { color: var(--xb-muted); }
  td input:not([type='checkbox']) { width: 100%; font: 13px var(--xb-sans); padding: 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  td input:disabled { opacity: 0.6; }
  .deco { text-align: center; }
  .error { margin: 4px 0 0; color: var(--xb-danger); font-size: 12px; }
  button { font: 12px var(--xb-sans); padding: 3px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
