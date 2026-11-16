<script lang="ts">
  // The site's own scripts (lista della spesa 148): a library or file that every page, or every page of one type,
  // loads. Kept with the settings, so it goes to the site with a release; only unfiltered_html changes it, and a
  // file of another site needs its integrity hash. Loaded when the section opens.
  import { t } from '../lib/i18n.ts';
  import type { SiteScript, SiteScriptsData } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  let { app }: { app: BuilderState } = $props();
  let data = $state<SiteScriptsData | null>(null);
  let scripts = $state<SiteScript[]>([]);
  let error = $state('');
  let saved = $state('');
  let busy = $state(false);

  const STRATEGIES: Array<[SiteScript['strategy'], string]> = [
    ['defer', t('Dopo la pagina (defer)')],
    ['async', t('Appena arriva (async)')],
    ['module', t('Modulo (type="module")')],
    ['blocking', t('Subito, blocca la pagina')],
  ];

  async function load() {
    if (data || busy) return;
    busy = true;
    try {
      data = await app.api.getSiteScripts();
      scripts = data.scripts.map((s) => ({ ...s }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** A file of this site: its path, or an address on its host. Another site's file needs the integrity hash. */
  function external(src: string): boolean {
    if (src.startsWith('/') && !src.startsWith('//')) return false;
    try {
      return new URL(src).host !== location.host;
    } catch {
      return true;
    }
  }

  function add() {
    const used = new Set(scripts.map((s) => s.id));
    let n = scripts.length + 1;
    while (used.has(`script-${n}`)) n += 1;
    scripts = [...scripts, { id: `script-${n}`, label: '', src: '', scope: 'site', position: 'footer', strategy: 'defer', integrity: '' }];
  }

  function move(i: number, by: number) {
    const next = [...scripts];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    scripts = next;
  }

  async function save() {
    if (!data) return;
    busy = true;
    error = '';
    saved = '';
    try {
      const done = await app.api.saveSiteScripts(scripts, data.head, data.base);
      data = { ...data, head: done.head, base: done.base, scripts: scripts.map((s) => ({ ...s })) };
      saved = t('Salvati in sviluppo: vanno sul sito con la prossima release.');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const dirty = $derived(!!data && JSON.stringify(scripts) !== JSON.stringify(data.scripts));
  const readOnly = $derived(!data?.canWrite);
</script>

<details class="xb-site-scripts" ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && load()}>
  <summary>{t('Script del sito')} {#if data}<small>({scripts.length})</small>{/if}</summary>
  <p class="note">{t('Librerie e file che ogni pagina, o ogni pagina di un tipo, carica. Indirizzo di questo sito o https; un file di un altro sito va con la sua impronta di integrità.')}</p>
  {#if readOnly && data}<p class="note locked">{t('Sola lettura: solo chi ha il permesso')} <code>unfiltered_html</code> {t('può cambiare gli script del sito.')}</p>{/if}
  {#if busy && !data}<p class="note">{t('Caricamento…')}</p>{/if}
  {#each scripts as s, i (i)}
    <fieldset disabled={readOnly}>
      <legend>{s.label || s.id}</legend>
      <label>{t('Nome')} <input bind:value={s.label} placeholder={s.id} /></label>
      <label>{t('Id')} <input bind:value={s.id} /></label>
      <label class="wide">{t('Indirizzo del file')} <input bind:value={s.src} placeholder="/wp-content/uploads/js/mappa.js" spellcheck="false" /></label>
      {#if s.src && external(s.src)}
        <label class="wide">{t('Impronta di integrità')} <input bind:value={s.integrity} placeholder="sha384-…" spellcheck="false" aria-invalid={!/^sha(384|512)-/.test(s.integrity)} /></label>
      {/if}
      <label>{t('Dove')}
        <select bind:value={s.scope}>
          <option value="site">{t('Tutto il sito')}</option>
          {#each data?.types ?? [] as type (type)}<option value={'type:' + type}>{t('Solo «{0}»', type)}</option>{/each}
        </select>
      </label>
      <label>{t('Posizione')}
        <select bind:value={s.position}>
          <option value="footer">{t('In fondo alla pagina')}</option>
          <option value="head">{t('Nella testata')}</option>
        </select>
      </label>
      <label>{t('Caricamento')}
        <select bind:value={s.strategy}>
          {#each STRATEGIES as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <div class="row">
        <button type="button" disabled={i === 0} onclick={() => move(i, -1)} title={t('Sposta su')}>↑</button>
        <button type="button" disabled={i === scripts.length - 1} onclick={() => move(i, 1)} title={t('Sposta giù')}>↓</button>
        <button type="button" onclick={() => (scripts = scripts.filter((_, j) => j !== i))}>{t('Togli')}</button>
      </div>
    </fieldset>
  {/each}
  {#if data && !readOnly}
    <div class="row">
      <button type="button" onclick={add}>{t('Aggiungi uno script')}</button>
      <button type="button" class="primary" disabled={!dirty || busy} onclick={save}>{t('Salva in sviluppo')}</button>
    </div>
  {/if}
  {#if error}<p class="note locked" role="alert">{error}</p>{/if}
  {#if saved && !dirty}<p class="note" role="status">{saved}</p>{/if}
</details>

<style>
  .xb-site-scripts { border-top: 1px solid var(--xb-line); padding: 8px 12px; font-size: 12px; overflow: auto; max-height: 50vh; }
  summary { cursor: pointer; font-weight: 600; }
  .note { margin: 6px 0; color: var(--xb-muted); }
  .note.locked { color: var(--xb-danger); }
  fieldset { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; margin: 8px 0; padding: 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  legend { padding: 0 4px; font-weight: 600; }
  label { display: grid; gap: 2px; }
  label.wide, .row { grid-column: 1 / -1; }
  input, select { font: 12px var(--xb-sans); padding: 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  input[aria-invalid='true'] { border-color: var(--xb-danger); }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-accent, #e2725b); border-color: transparent; color: #fff; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
