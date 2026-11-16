<script lang="ts">
  import { t, tx } from '../lib/i18n.ts';
  import { keyHint, withKeys } from '../lib/keys.svelte.ts';
  import { tick } from 'svelte';
  import HistorySteps from './HistorySteps.svelte';
  import HistosMark from './HistosMark.svelte';
  import Icon from './Icon.svelte';
  import { safeUrl, type BuilderConfig } from '../lib/config.ts';
  import { closeEmbed } from '../lib/nav.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  import { COMPONENT_REF_PATTERN } from '@xb/dsl';
  import PublishDialog from './PublishDialog.svelte';

  let {
    app,
    config,
    onpalette,
    oninsert,
    onpreview,
  }: { app: BuilderState; config: BuilderConfig; onpalette?: () => void; oninsert?: (anchor: HTMLElement) => void; onpreview?: (url: string) => void } = $props();

  let dialog: HTMLDialogElement;
  let publishDialog: PublishDialog;
  /** The «⋯» menu of narrow screens (L1): closes on Esc (back to its button) or a click elsewhere. */
  let moreOpen = $state(false);
  let moreButton = $state<HTMLButtonElement>();
  $effect(() => {
    if (!moreOpen) return;
    void tick().then(() => moreButton?.parentElement?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    const away = (e: PointerEvent) => {
      if (!moreButton?.parentElement?.contains(e.target as Node)) moreOpen = false;
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  });
  function moreKeys(event: KeyboardEvent) {
    const items = [...((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]'))];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      moreOpen = false;
      moreButton?.focus();
      return;
    }
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (go === undefined) return;
    event.preventDefault();
    items[(go + items.length) % items.length]?.focus();
  }

  /** Also used by the command palette. */
  export function openPublish() {
    if (config.canPublish) publishDialog.open();
  }

  export function openNewComponent() {
    error = '';
    dialog.showModal();
  }

  /** Saves, then shows the dev version over the builder (or, without a host for it, in a new tab). */
  export async function openPreview() {
    // Without a host the tab opens synchronously (popup blockers), then follows the signed link.
    const tab = onpreview ? null : window.open('about:blank', '_blank');
    try {
      await app.save();
      const { url } = await app.api.previewLink(config.postId, app.contextId);
      const target = safeUrl(url);
      if (!target) throw new Error(t('Link di anteprima non valido'));
      if (onpreview) onpreview(target);
      else if (tab) {
        tab.opener = null;
        tab.location.href = target;
      }
    } catch (e) {
      tab?.close();
      app.status = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  /** The page under the component sessions, for the trail. */
  const pageTitle = $derived(config.title || t('Pagina'));

  /**
   * Leaves `levels` component sessions (1: back to where it was opened from). Dropping unsaved changes asks
   * first; saving that fails keeps the session open with the error in the status.
   */
  async function leave(save: boolean, levels = 1) {
    if (!save && app.dirty && !window.confirm(t('Le modifiche al componente non salvate andranno perse. Uscire senza salvare?'))) return;
    for (let i = 0; i < levels; i++) {
      if (!(await app.closeComponent(save && i === 0))) return;
      if (i + 1 < levels && app.dirty && !window.confirm(t('Anche il componente sotto ha modifiche non salvate. Uscire senza salvarle?'))) return;
    }
  }

  let ref = $state('');
  let title = $state('');
  let error = $state('');

  async function createComponent(event: SubmitEvent) {
    event.preventDefault();
    if (!COMPONENT_REF_PATTERN.test(ref)) {
      error = t('Chiave non valida: minuscole e trattini, al massimo un namespace (es. ui/card-hero).');
      return;
    }
    try {
      await app.api.createComponent(ref, title || ref);
      // Opened in place, over this document (component session): nothing is reloaded or lost.
      app.components = await app.api.listComponents();
      dialog.close();
      await app.openComponent(ref);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<header class="topbar">
  {#if config.admin.overview}
    <a class="logo" href={config.admin.overview} target={config.embed ? '_blank' : undefined} rel={config.embed ? 'noopener' : undefined} title={t("Histeon nell'amministrazione: panoramica, release, versioni")} aria-label={t('Panoramica di Histeon')}><HistosMark /></a>
  {/if}
  {#if config.embed}
    <button class="back" onclick={() => closeEmbed(app.anyDirty)} title={t("Chiude Histeon e torna all'editor a blocchi")}>← Gutenberg</button>
  {:else}
    <a class="back" href={config.editUrl ?? '/wp-admin/'} title={t("Apre questa pagina nell'editor a blocchi")}>← {config.editUrl ? 'Gutenberg' : 'WordPress'}</a>
  {/if}
  {#if oninsert}
    <button class="add" data-insert-anchor onclick={(e) => oninsert(e.currentTarget)} title={withKeys(t('Aggiungi un elemento'), 'insert')} aria-label={t('Aggiungi un elemento')}><span aria-hidden="true"><Icon name="plus" size={15} /></span> {t('Aggiungi')}</button>
  {/if}
  {#if app.sessions.length}
    <nav class="trail" aria-label={t('Sessione del componente')}>
      <button class="crumb" onclick={() => void leave(false, app.sessions.length)} title={t('Torna a {0}', pageTitle)}>{pageTitle}</button>
      {#each app.sessions as s, i (s.id)}
        <span class="sep" aria-hidden="true">›</span>
        {#if i < app.sessions.length - 1}
          <button class="crumb" onclick={() => void leave(false, app.sessions.length - 1 - i)}>{s.title}</button>
        {:else}
          <h1 class="current"><span class="kind component"><Icon name="components" size={12} /> {t('Componente')}</span>{s.title}</h1>
        {/if}
      {/each}
    </nav>
  {:else}
    <h1>
      {#if config.template}<span class="kind">{config.template.part ? t('Parte di template') : 'Template'}</span>{/if}
      {app.doc?.title || config.title || t('(senza titolo)')}
    </h1>
  {/if}
  {#if config.languages && !app.sessions.length}
    <nav class="langs" aria-label={t('Lingue di questa pagina')}>
      {#each config.languages.items as l (l.code)}
        {#if l.state === 'current'}
          <span class="lang current" aria-current="page" title={t('{0}: questa pagina', l.label)}>{l.code.toUpperCase()}</span>
        {:else if l.url}
          <a class="lang {l.state}" href={l.url} title={l.state === 'missing' ? t('Traduci in {0}: crea la bozza e aprila qui', l.label) : l.state === 'draft' ? t('{0} (bozza): apri nel builder', l.label) : t('{0}: apri nel builder', l.label)}>{#if l.state === 'missing'}+{/if}{l.code.toUpperCase()}</a>
        {/if}
      {/each}
    </nav>
  {/if}
  <span class="status {app.status.kind}" role="status" aria-live="polite">
    {app.status.message || (app.invalid ? t('Non salvato: {0}', app.invalid) : app.dirty ? t('Modifiche non salvate') : '')}
  </span>
  <div class="actions">
    {#if onpalette}<button class="secondary" onclick={onpalette} title={withKeys(t('Tutti i comandi'), 'palette')}>{t('Comandi')}</button>{/if}
    <span class="pair">
      <button class="icon" onclick={() => app.undo()} disabled={!app.canUndo} title={withKeys(tx('Annulla', 'undo'), 'undo')} aria-label={t("Annulla l'ultima modifica")}><Icon name="undo" size={16} /></button>
      <button class="icon" onclick={() => app.redo()} disabled={!app.canRedo} title={withKeys(t('Ripeti'), 'redo')} aria-label={t('Ripeti la modifica annullata')}><Icon name="redo" size={16} /></button>
      <HistorySteps {app} />
    </span>
    {#if app.sessions.length}
      <button onclick={() => void leave(false)} title={t("Lascia il componente com'era all'apertura e torna indietro")}>{t('Esci senza salvare')}</button>
      <button class="primary session" onclick={() => void leave(true)} disabled={app.status.kind === 'saving'} title={keyHint('save') ? t('Salva il componente in sviluppo e torna indietro ({0} salva senza uscire)', keyHint('save')) : t('Salva il componente in sviluppo e torna indietro')}>
        {#if app.dirty}<span class="unsaved" aria-hidden="true"></span>{/if}{app.status.kind === 'saving' ? t('Salvataggio…') : t('Salva ed esci')}
      </button>
    {:else}
      <button class="secondary" onclick={() => { error = ''; dialog.showModal(); }}>{t('Nuovo componente')}</button>
      <button class="secondary" onclick={openPreview} title={t('Salva e mostra la pagina come la vedrà chi visita, senza il builder (Esc per tornare)')}>{t('Anteprima')}</button>
      {#if config.viewUrl}<a class="live secondary" href={config.viewUrl} target="_blank" rel="noopener" title={t('Apre la pagina pubblicata in una nuova scheda')}>{t('Pubblicato')} <Icon name="external" size={13} /></a>{/if}
      <!-- Under 1024 px the secondary actions go in a menu, so Salva and Pubblica always stay in view (L1). -->
      <span class="more-wrap">
        <button class="more" bind:this={moreButton} aria-haspopup="menu" aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)} title={t('Altre azioni')} aria-label={t('Altre azioni')}>⋯</button>
        {#if moreOpen}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div class="more-menu" role="menu" tabindex="-1" aria-label={t('Altre azioni')} onkeydown={moreKeys}>
            {#if onpalette}<button role="menuitem" onclick={() => { moreOpen = false; onpalette(); }}>{t('Comandi')}</button>{/if}
            <button role="menuitem" onclick={() => { moreOpen = false; error = ''; dialog.showModal(); }}>{t('Nuovo componente')}</button>
            <button role="menuitem" onclick={() => { moreOpen = false; void openPreview(); }}>{t('Anteprima')}</button>
            {#if config.viewUrl}<a role="menuitem" href={config.viewUrl} target="_blank" rel="noopener" onclick={() => (moreOpen = false)}>{t('Pubblicato')} <Icon name="external" size={13} /></a>{/if}
          </div>
        {/if}
      </span>
      <button onclick={() => app.save()} disabled={!app.dirty || app.status.kind === 'saving'} title={app.dirty ? withKeys(t('Modifiche non salvate: salva in sviluppo'), 'save') : withKeys(t('Salva in sviluppo'), 'save')}>
        <!-- Unsaved changes, always in sight: messages in the status line come and go, this stays until saved. -->
        {#if app.dirty}<span class="unsaved" aria-hidden="true"></span>{/if}{app.status.kind === 'saving' ? t('Salvataggio…') : t('Salva')}
      </button>
      {#if config.canPublish}
        <button class="primary" onclick={() => publishDialog.open()} disabled={app.published && !app.dirty} title={t('Porta online le modifiche salvate')}>{t('Pubblica…')}</button>
      {/if}
    {/if}
  </div>
</header>

<PublishDialog bind:this={publishDialog} {app} staticBridge={config.staticBridge} checksBlock={config.checksBlock} blogPublic={config.blogPublic} />

<dialog bind:this={dialog} aria-labelledby="xb-new-component">
  <form onsubmit={createComponent}>
    <h2 id="xb-new-component">{t('Nuovo componente')}</h2>
    <label>{t('Chiave')} <input bind:value={ref} placeholder="ui/card-hero" required /></label>
    <label>{t('Nome')} <input bind:value={title} placeholder="Card hero" /></label>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="row">
      <button type="button" onclick={() => dialog.close()}>{t('Annulla')}</button>
      <button type="submit" class="primary">{t('Crea e apri')}</button>
    </div>
  </form>
</dialog>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px 0 9px;
    height: 48px;
    background: var(--xb-panel);
    border-bottom: 1px solid var(--xb-line);
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: 600 13px var(--xb-sans);
    padding: 6px 12px 6px 9px;
    border-radius: var(--xb-r);
    border: 1px solid var(--xb-ink);
    background: var(--xb-ink);
    color: var(--xb-on-ink);
    cursor: pointer;
  }
  .add span {
    display: grid;
    color: var(--xb-coral);
  }
  .pair {
    display: inline-flex;
  }
  .pair .icon {
    display: grid;
    place-items: center;
    padding: 5px 8px;
  }
  .pair .icon:first-child {
    border-radius: var(--xb-r) 0 0 var(--xb-r);
  }
  .pair .icon:last-child {
    border-radius: 0 var(--xb-r) var(--xb-r) 0;
    margin-left: -1px;
  }
  .add:hover {
    background: color-mix(in srgb, var(--xb-ink) 88%, var(--xb-accent));
  }
  .logo {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    text-decoration: none;
    flex: none;
  }
  .back {
    color: var(--xb-muted);
    text-decoration: none;
    font: 13px var(--xb-sans);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .back:hover {
    color: var(--xb-text);
  }
  .back + .add,
  .back + h1 {
    margin-left: 2px;
  }
  h1 {
    font: 600 14px var(--xb-sans);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status {
    font-size: 12px;
    color: var(--xb-muted);
    flex: 1;
  }
  .status.error {
    color: var(--xb-danger);
  }
  .status.saved {
    color: var(--xb-ok);
  }
  .unsaved {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--xb-coral);
    vertical-align: 1px;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    border-radius: var(--xb-r-sm);
    color: var(--xb-muted);
    font-size: 13px;
    text-decoration: none;
  }
  .live:hover {
    color: var(--xb-text);
  }
  button {
    font: 500 13px var(--xb-sans);
    padding: 6px 12px;
    border-radius: var(--xb-r);
    border: 1px solid var(--xb-line);
    background: var(--xb-bg);
    color: var(--xb-text);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--xb-muted) 45%, var(--xb-line));
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  dialog {
    background: var(--xb-panel);
    color: var(--xb-text);
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-lg);
    padding: 20px;
    width: min(420px, 90vw);
    box-shadow: var(--xb-shadow);
  }
  dialog::backdrop {
    background: rgb(23 26 51 / 0.45);
    backdrop-filter: blur(2px);
  }
  dialog form {
    display: grid;
    gap: 12px;
  }
  dialog h2 {
    margin: 0;
    font-size: 16px;
  }
  dialog label {
    display: grid;
    gap: 4px;
    font-size: 13px;
    color: var(--xb-muted);
  }
  dialog input {
    font: 13px var(--xb-mono);
    padding: 6px 8px;
    background: var(--xb-bg);
    color: var(--xb-text);
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
  }
  dialog .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  dialog .error {
    color: var(--xb-danger);
    margin: 0;
    font-size: 13px;
  }
  .primary {
    font-weight: 600;
    background: var(--xb-ink);
    border-color: var(--xb-ink);
    color: var(--xb-on-ink);
  }
  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--xb-ink) 88%, var(--xb-accent));
    border-color: color-mix(in srgb, var(--xb-ink) 88%, var(--xb-accent));
  }
  .langs {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--xb-r);
    background: var(--xb-hover);
  }
  .lang {
    padding: 3px 8px;
    border-radius: var(--xb-r-sm);
    font: 600 11.5px var(--xb-sans);
    color: var(--xb-muted);
    text-decoration: none;
  }
  .lang.current {
    background: var(--xb-bg);
    color: var(--xb-text);
    box-shadow: 0 1px 2px rgb(23 26 51 / 0.12);
  }
  a.lang:hover {
    color: var(--xb-text);
  }
  .lang.draft {
    font-style: italic;
  }
  .lang.missing {
    color: var(--xb-link);
  }
  .trail {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .trail .sep {
    color: var(--xb-muted);
  }
  .crumb {
    border: 0;
    background: none;
    padding: 4px 2px;
    color: var(--xb-muted);
    font: 500 14px var(--xb-sans);
    white-space: nowrap;
  }
  .crumb:hover {
    color: var(--xb-text);
    text-decoration: underline;
  }
  .kind.component {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: color-mix(in srgb, var(--xb-coral) 16%, transparent);
    color: color-mix(in srgb, var(--xb-coral) 55%, var(--xb-text));
  }
  .primary.session {
    background: var(--xb-coral);
    border-color: var(--xb-coral);
    color: #171a33;
  }
  .primary.session:hover:not(:disabled) {
    background: color-mix(in srgb, var(--xb-coral) 88%, #000);
    border-color: color-mix(in srgb, var(--xb-coral) 88%, #000);
  }
  .kind {
    font: 600 10px/1 var(--xb-sans);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 6px;
    margin-right: 6px;
    border-radius: 999px;
    background: var(--xb-accent-bg);
    color: var(--xb-link);
    vertical-align: middle;
  }
  .more-wrap {
    position: relative;
    display: none;
  }
  .more-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 40;
    display: grid;
    min-width: 180px;
    padding: 4px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r);
    background: var(--xb-bg);
    box-shadow: var(--xb-shadow);
  }
  .more-menu > * {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--xb-r-sm);
    background: transparent;
    color: var(--xb-text);
    font: 13px var(--xb-sans);
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }
  .more-menu > *:hover,
  .more-menu > *:focus-visible {
    background: var(--xb-hover);
  }
  /* Under 1024 px (L1): the secondary actions move to «⋯», the title and the status give up room first. */
  @media (max-width: 1023px) {
    .actions .secondary {
      display: none;
    }
    .more-wrap {
      display: inline-flex;
    }
    .add {
      font-size: 0;
      gap: 0;
      padding: 6px 8px;
    }
    .back {
      display: none;
    }
    h1 {
      min-width: 0;
      max-width: 22vw;
    }
    .status {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  @media (max-width: 767px) {
    .langs,
    .status,
    h1,
    .pair > :not(:first-child) {
      display: none;
    }
    .pair .icon:first-child {
      border-radius: var(--xb-r);
    }
  }
</style>
