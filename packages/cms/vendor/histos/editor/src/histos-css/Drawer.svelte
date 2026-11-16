<script lang="ts">
  import type { ContrastPair, DesignParams } from '../lib/api.ts';
  import { t } from '../lib/i18n.ts';
  import HistosCssPanel from './HistosCssPanel.svelte';
  import type { DrawerConfig, PanelHost } from './host.ts';
  import type { SectionId } from './options.ts';

  // The drawer over any WordPress page (docs/spec/histos-css.md §6): the Histeon CSS panel, its data from the REST
  // routes of Histeon or of the standalone plugin, and «Salva in sviluppo». Mounted in a shadow root by drawer.ts.
  /** Where the tokens live: the page (the preview) and a probe in the shadow root (the swatches). */
  let { config, host }: { config: DrawerConfig; host: Pick<PanelHost, 'show' | 'read'> } = $props();

  let open = $state(false);
  let loaded = $state(false);
  let failed = $state('');
  let design = $state<DesignParams>({});
  let saved = $state('');
  let defaults = $state<DesignParams>({});
  let contrast = $state<ContrastPair[]>([]);
  let recipes = $state<Record<string, string>>({});
  let tab = $state<SectionId>('colors');
  let status = $state<{ text: string; error?: boolean }>({ text: '' });
  let busy = $state(false);
  let tokens: Record<string, string> = {};
  let heads = { head: '', base: '' };
  let dialog = $state<HTMLElement | undefined>();
  const dirty = $derived(loaded && JSON.stringify(design) !== saved);

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(config.rest + path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': config.nonce, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new Error(data?.message ? String(data.message) : t('Errore {0}', res.status));
    return data as T;
  }

  /** The drawer's host: the server previews, the page shows. */
  const panelHost: PanelHost = {
    async preview(next) {
      const r = await api<{ css?: unknown; contrast?: ContrastPair[]; classesOff?: string[] }>('POST', 'design/preview', { design: next });
      return { css: typeof r.css === 'string' ? r.css : '', contrast: r.contrast, classesOff: r.classesOff };
    },
    show(css, classesOff) {
      host.show(css, classesOff);
      status = { text: JSON.stringify(design) !== saved ? t('Anteprima su questa pagina: salva in sviluppo per tenerla.') : '' };
    },
    read: (names) => host.read(names),
    async tokens(next) {
      const r = await api<{ tokens?: { light?: Record<string, string>; dark?: Record<string, string> | null } }>('POST', 'design/preview', { design: next, tokens: true });
      return { light: r.tokens?.light ?? {}, dark: r.tokens?.dark ?? null };
    },
  };

  async function load() {
    try {
      const [doc, framework] = await Promise.all([
        api<{ defaults?: DesignParams; design?: DesignParams; tokens?: Record<string, string>; head?: string; base?: string; contrast?: ContrastPair[] }>('GET', 'tokens'),
        api<{ recipes?: Record<string, string> }>('GET', 'framework').catch((): { recipes?: Record<string, string> } => ({})),
      ]);
      defaults = { ...(doc.defaults ?? {}) };
      design = { ...defaults, ...(doc.design ?? {}) };
      saved = JSON.stringify(design);
      tokens = doc.tokens && typeof doc.tokens === 'object' ? doc.tokens : {};
      heads = { head: String(doc.head ?? ''), base: String(doc.base ?? '') };
      contrast = doc.contrast ?? [];
      recipes = framework.recipes && typeof framework.recipes === 'object' ? { ...framework.recipes } : {};
      loaded = true;
      const r = await panelHost.preview(design);
      contrast = r.contrast ?? contrast;
      panelHost.show(r.css, r.classesOff);
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
  }

  async function save() {
    busy = true;
    status = { text: t('Salvataggio…') };
    try {
      const res = await api<{ head?: string; base?: string }>('POST', 'tokens', { tokens, design, ...heads });
      heads = { head: String(res.head ?? heads.head), base: String(res.base ?? heads.base) };
      saved = JSON.stringify(design);
      status = { text: config.savedText || t('Salvato in sviluppo. Pubblica una release dal builder per portarlo online.') };
    } catch (e) {
      status = { text: e instanceof Error ? e.message : String(e), error: true };
    }
    busy = false;
  }

  /** Opens or closes the drawer (the admin bar, Alt+Shift+H, Esc). */
  export function toggle(force?: boolean) {
    open = typeof force === 'boolean' ? force : !open;
    if (open && !loaded && !failed) void load();
    if (open) requestAnimationFrame(() => dialog?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button')?.focus());
  }

  export function isOpen(): boolean {
    return open;
  }

  export function hasChanges(): boolean {
    return dirty;
  }
</script>

<div class="drawer" role="dialog" aria-label="Histeon CSS" hidden={!open} bind:this={dialog}>
  <header>
    <img class="mark" src={config.mark} alt="" width="34" height="34" />
    <div>
      <h2>Histeon CSS</h2>
      <p>{t('Il tuo sistema di design')} · <kbd>{t('Alt+Maiusc+H')}</kbd></p>
    </div>
    <button type="button" class="x" aria-label={t('Chiudi')} onclick={() => toggle(false)}>×</button>
  </header>
  {#if !config.active}
    <p class="notice">{t('Il sito usa un altro framework: queste scelte valgono quando attivi Histeon CSS nelle impostazioni.')} <a href={config.settings}>{t('Impostazioni → Histeon')}</a></p>
  {/if}
  <div class="body">
    {#if failed}
      <p class="status is-error" role="alert">{failed}</p>
    {:else if !loaded}
      <p class="status">{t('Caricamento…')}</p>
    {:else}
      <HistosCssPanel host={panelHost} bind:design {defaults} bind:contrast {recipes} bind:tab />
    {/if}
  </div>
  <footer>
    <span class="status" class:is-error={status.error} role="status" aria-live="polite">{status.text}</span>
    <button type="button" class="primary" disabled={!dirty || busy} onclick={save}>{t('Salva in sviluppo')}</button>
  </footer>
</div>

<style>
  .drawer {
    --xb-ink: #171a33; --xb-on-ink: #f3ece1; --xb-coral: #ff6f5e; --xb-bg: #ffffff; --xb-line: #e6e1d8; --xb-text: #171a33;
    --xb-muted: #5f6270; --xb-danger: #b3261e; --xb-ok: #157f3c; --xb-r-sm: 8px; --xb-r: 12px;
    --xb-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --xb-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    position: fixed; z-index: 2147483000; inset-block: 12px; inset-inline-end: 12px; inline-size: min(460px, calc(100vw - 24px));
    display: flex; flex-direction: column; background: #fffdf9; color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: 20px;
    box-shadow: 0 30px 60px -20px rgb(23 26 51 / 0.45), 0 0 0 1px rgb(23 26 51 / 0.04); overflow: hidden; font: 13px/1.5 var(--xb-sans); color-scheme: light;
    animation: in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .drawer[hidden] { display: none; }
  @keyframes in { from { opacity: 0; transform: translateX(16px) scale(0.98); } to { opacity: 1; transform: none; } }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--xb-ink); color: var(--xb-on-ink); }
  .mark { display: block; inline-size: 34px; block-size: 34px; border-radius: 9px; }
  h2 { margin: 0; font-size: 15px; font-weight: 700; }
  header p { margin: 0; color: #b9bbd0; font-size: 12px; }
  kbd { padding: 1px 5px; border: 1px solid rgb(255 255 255 / 0.25); border-radius: 5px; font: 11px var(--xb-mono); }
  .x { margin-inline-start: auto; inline-size: 32px; block-size: 32px; border: 0; border-radius: 10px; background: rgb(255 255 255 / 0.08); color: var(--xb-on-ink); font-size: 18px; cursor: pointer; }
  .x:hover { background: rgb(255 255 255 / 0.16); }
  .notice { margin: 12px 16px 0; padding: 10px 12px; border-radius: 12px; background: #fff1ee; color: #8a2b20; font-size: 12.5px; }
  .notice a { color: inherit; font-weight: 700; }
  .body { flex: 1; overflow: auto; padding: 12px 16px 16px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--xb-line); background: #f3ece1; }
  .status { flex: 1; margin: 0; color: var(--xb-muted); font-size: 12px; }
  .status.is-error { color: var(--xb-danger); font-weight: 600; }
  .primary { padding: 9px 16px; border: 0; border-radius: 12px; background: var(--xb-coral); color: var(--xb-ink); font: 700 13px var(--xb-sans); cursor: pointer; }
  .primary:hover { background: #e85a49; }
  .primary:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--xb-coral); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
</style>
