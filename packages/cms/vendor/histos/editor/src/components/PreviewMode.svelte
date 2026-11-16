<script lang="ts">
  import { dateLocale, t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  /**
   * The page as visitors will see it, over the whole builder (docs/spec/preview.md): the signed preview link of
   * the dev version, rendered by WordPress with its scripts, at full width or at a chosen width. Esc or "Torna al
   * builder" brings the builder back exactly as it was; the link also opens in a new tab.
   */
  let {
    url = $bindable(null),
    relink,
  }: {
    url: string | null;
    /**
     * A new signed link seen as a role (lista della spesa 161), with the roles there are; '' is the real visitor.
     * `ttl` is how long it lasts (V3), one of `DURATIONS`; the answer says when it expires.
     */
    relink?: (as: string, ttl: number) => Promise<{ url: string; expires?: number | null; roles?: Record<string, string> }>;
  } = $props();
  let roles = $state<Record<string, string>>({});
  let as = $state('');

  /** How long the link to copy or open in a new tab lasts (V3): the server accepts only these. */
  const DURATIONS: Array<{ label: string; seconds: number }> = [
    { label: t('1 ora'), seconds: 3600 },
    { label: t('1 giorno'), seconds: 86400 },
    { label: t('2 giorni'), seconds: 172800 },
    { label: t('7 giorni'), seconds: 604800 },
  ];
  let ttl = $state(172800);
  /** The link to share, with the chosen duration, and when it expires (Unix time); null until it arrives. */
  let share = $state<{ url: string; expires: number | null } | null>(null);
  let copied = $state(false);
  const expiry = $derived(share?.expires ? new Date(share.expires * 1000).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : '');

  async function refresh(): Promise<{ url: string } | null> {
    if (!relink) return null;
    try {
      const r = await relink(as, ttl);
      roles = r.roles ?? roles;
      share = { url: r.url, expires: r.expires ?? null };
      copied = false;
      return r;
    } catch {
      /* the link in use stays */
      return null;
    }
  }
  $effect(() => {
    if (!url || !relink || share) return;
    void refresh();
  });
  async function seeAs(next: string) {
    as = next;
    const r = await refresh();
    if (r) url = r.url;
  }
  function setDuration(next: number) {
    ttl = next;
    void refresh();
  }
  async function copy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      copied = true;
    } catch {
      copied = false;
    }
  }

  const WIDTHS: Array<{ label: string; px: number | null }> = [
    { label: t('Intera'), px: null },
    { label: 'Tablet', px: 820 },
    { label: t('Telefono'), px: 390 },
  ];
  let width = $state<number | null>(null);
  let back = $state<HTMLButtonElement>();
  let root = $state<HTMLDivElement>();
  // Modal for real: the builder under it is inert (no Tab, no screen reader) until the preview closes.
  let inerted: HTMLElement[] = [];
  function release() {
    for (const el of inerted) el.inert = false;
    inerted = [];
  }
  $effect(() => {
    if (!url || !root) return;
    inerted = [...(root.parentElement?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== root && !el.inert);
    for (const el of inerted) el.inert = true;
    return release;
  });
  let opener: HTMLElement | null = null;

  $effect(() => {
    if (!url) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    back?.focus();
  });

  export function close() {
    // Before the focus goes back: an inert button takes no focus.
    release();
    url = null;
    share = null;
    copied = false;
    opener?.focus();
    opener = null;
  }

  function onkeydown(event: KeyboardEvent) {
    if (!url || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  // Esc also works after a click inside the page (same origin: the preview is this site).
  function onload(event: Event) {
    try {
      // After the page's own handlers: an Esc that closed something in the page (a menu) is not ours.
      (event.currentTarget as HTMLIFrameElement).contentWindow?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) close();
      });
    } catch {
      /* another origin after a link: the button and the bar still work */
    }
  }
</script>

<svelte:window {onkeydown} />

{#if url}
  <div class="preview" bind:this={root} role="dialog" aria-modal="true" aria-label={t('Anteprima della pagina')}>
    <header>
      <strong>{t('Anteprima')}</strong>
      <span class="note" title={t('versione in sviluppo, come la vedrà chi visita')}>{t('versione in sviluppo, come la vedrà chi visita')}</span>
      <div class="widths" role="group" aria-label={t('Larghezza')}>
        {#each WIDTHS as w (w.label)}
          <button type="button" class:active={width === w.px} aria-pressed={width === w.px} onclick={() => (width = w.px)}>{w.label}</button>
        {/each}
      </div>
      {#if relink && Object.keys(roles).length}
        <label class="as">{t('Vedi come')}
          <select value={as} onchange={(e) => void seeAs(e.currentTarget.value)}>
            <option value="">{t('Chi visita ora')}</option>
            {#each Object.entries(roles) as [role, label] (role)}<option value={role}>{label}</option>{/each}
          </select>
        </label>
      {/if}
      {#if relink}
        <div class="share" role="group" aria-label={t('Link da condividere')}>
          <label class="as">{t('Durata del link')}
            <select value={ttl} onchange={(e) => setDuration(Number(e.currentTarget.value))}>
              {#each DURATIONS as d (d.seconds)}<option value={d.seconds}>{d.label}</option>{/each}
            </select>
          </label>
          <button type="button" class="copy" disabled={!share} onclick={() => void copy()}>{copied ? t('Copiato') : t('Copia link')}</button>
          {#if expiry}<span class="expires" aria-live="polite">{t('Scade il {0}', expiry)}</span>{/if}
        </div>
      {/if}
      <a class="tab" href={share?.url ?? url} target="_blank" rel="noopener noreferrer">{t('Nuova scheda')} <Icon name="external" size={13} /></a>
      <button type="button" class="primary" bind:this={back} onclick={close}>{t('Torna al builder')} <kbd>Esc</kbd></button>
    </header>
    <div class="stage">
      <iframe src={url} title={t('Anteprima della pagina in sviluppo')} {onload} style:width={width ? `${width}px` : '100%'}></iframe>
    </div>
  </div>
{/if}

<style>
  .preview {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--xb-stage);
  }
  /* One line at usual widths; when it does not fit the bar wraps by groups, never inside a label (D7). */
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 12px 6px 16px;
    background: var(--xb-panel);
    border-bottom: 1px solid var(--xb-line);
    font: 13px var(--xb-sans);
  }
  header > * {
    white-space: nowrap;
  }
  /* The note takes the room left and gives it up first, cut with an ellipsis, before the bar wraps. */
  .note {
    flex: 1 1 0;
    min-width: 6em;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--xb-muted);
  }
  .as {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    color: var(--xb-muted);
  }
  .as select,
  .share select {
    font: 12px var(--xb-sans);
    padding: 3px 6px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: var(--xb-bg);
    color: var(--xb-text);
  }
  .share {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }
  .copy {
    font: 500 12px var(--xb-sans);
    padding: 3px 8px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: var(--xb-bg);
    color: var(--xb-text);
    cursor: pointer;
  }
  .copy:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .expires {
    color: var(--xb-muted);
    font-size: 12px;
  }
  .widths {
    display: inline-flex;
    padding: 2px;
    border-radius: var(--xb-r);
    background: var(--xb-hover);
  }
  .widths button {
    font: 500 12px var(--xb-sans);
    padding: 4px 10px;
    border: 0;
    border-radius: var(--xb-r-sm);
    background: transparent;
    color: var(--xb-muted);
    cursor: pointer;
  }
  .widths button.active {
    background: var(--xb-bg);
    color: var(--xb-text);
    box-shadow: 0 1px 2px rgb(23 26 51 / 0.12);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--xb-muted);
    text-decoration: none;
  }
  .tab:hover {
    color: var(--xb-text);
  }
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: 600 13px var(--xb-sans);
    padding: 6px 10px 6px 12px;
    border-radius: var(--xb-r);
    border: 1px solid var(--xb-ink);
    background: var(--xb-ink);
    color: var(--xb-on-ink);
    cursor: pointer;
  }
  kbd {
    font: 600 10px var(--xb-sans);
    padding: 1px 5px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--xb-on-ink) 18%, transparent);
  }
  .stage {
    display: flex;
    justify-content: center;
    min-height: 0;
    overflow: auto;
  }
  iframe {
    display: block;
    height: 100%;
    max-width: 100%;
    border: 0;
    background: #fff;
    transition: width 0.2s ease;
  }
</style>
