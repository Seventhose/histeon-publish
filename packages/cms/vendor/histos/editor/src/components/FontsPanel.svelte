<script lang="ts">
  import { onMount } from 'svelte';
  import type { FontsData } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t } from '../lib/i18n.ts';

  // The site's fonts in the design system (E2, docs/spec/fonts.md): the families served by the site itself, with a
  // sample, and Google Fonts families to download once, on the server, so pages never call Google (GDPR). The list
  // to choose from is bundled with the plugin: the browser asks Google nothing either.
  type Use = 'font_body' | 'font_heading' | 'font_mono' | 'font_accent' | 'font_display';
  let { app, onuse }: { app: BuilderState; onuse?: (key: Use, stack: string) => void } = $props();

  type Entry = NonNullable<FontsData['catalog']>[number];
  let data = $state<FontsData | null>(null);
  let catalog = $state<Entry[]>([]);
  let query = $state('');
  let chosen = $state<Entry | null>(null);
  let weights = $state<number[]>([]);
  let italic = $state(false);
  let busy = $state(false);
  let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const GENERIC: Record<string, string> = { serif: 'serif', monospace: 'monospace', handwriting: 'cursive' };
  const USES: Array<[Use, string]> = [['font_body', t('Testo')], ['font_heading', t('Titoli')], ['font_mono', t('Codice')], ['font_accent', t('Accento')], ['font_display', t('Display')]];
  const onSite = $derived(new Set((data?.families ?? []).map((f) => f.family)));
  const found = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? catalog.filter((f) => f.family.toLowerCase().includes(q) || f.category.includes(q)).slice(0, 40) : [];
  });

  /** A font stack for a family: the family, then the generic kind it falls back to. */
  function stack(family: string): string {
    const kind = catalog.find((f) => f.family === family)?.category ?? 'sans-serif';
    return `"${family}", ${GENERIC[kind] ?? 'sans-serif'}`;
  }

  function faces(f: FontsData['families'][number]): string {
    const normal = f.faces.filter((x) => x.style === 'normal').map((x) => x.weight);
    const italics = f.faces.filter((x) => x.style === 'italic').map((x) => x.weight);
    return [normal.join(' · '), italics.length ? t('corsivo {0}', italics.join(' · ')) : ''].filter(Boolean).join(' — ');
  }

  onMount(async () => {
    try {
      const got = await app.api.getFonts();
      catalog = got.catalog ?? [];
      data = got;
    } catch (e) {
      message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    }
  });

  // The site's @font-face rules in the builder's own page too, for the samples (the canvas has them already).
  $effect(() => {
    const css = data?.css ?? '';
    let style = document.getElementById('xb-local-fonts') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'xb-local-fonts';
      document.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  });

  function choose(entry: Entry) {
    chosen = entry;
    weights = entry.weights.filter((w) => w === 400 || w === 700);
    if (!weights.length) weights = [entry.weights[0] ?? 400];
    italic = false;
    message = null;
  }

  async function download() {
    if (!chosen || !weights.length) return;
    busy = true;
    message = null;
    try {
      const got = await app.api.importGoogleFont(chosen.family, [...weights].sort((a, b) => a - b), italic);
      data = got;
      message = { kind: 'ok', text: t('{0} è sul sito: le pagine lo prendono da qui, non da Google.', chosen.family) };
      chosen = null;
      query = '';
      await app.refreshPreview();
    } catch (e) {
      message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function remove(family: string) {
    if (!confirm(t('Togliere {0} dal sito? Le pagine che lo usano passano al carattere di riserva.', family))) return;
    busy = true;
    try {
      data = await app.api.removeFont(family);
      message = { kind: 'ok', text: t('{0} tolto dal sito.', family) };
      await app.refreshPreview();
    } catch (e) {
      message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  function toggleWeight(w: number, on: boolean) {
    weights = on ? [...new Set([...weights, w])] : weights.filter((x) => x !== w);
  }
</script>

<section class="fonts" aria-label={t('Font del sito')}>
  <h3>{t('Font del sito')} <span>{data?.families.length ?? 0}</span></h3>
  <p class="hint">{t('Serviti dal sito stesso: nessuna richiesta a Google dalle pagine.')}</p>
  {#if data && data.families.length === 0}<p class="hint">{t('Nessun font locale.')}</p>{/if}
  <ul class="families">
    {#each data?.families ?? [] as f (f.family)}
      <li>
        <span class="sample" style:font-family={stack(f.family)}>{f.family} — Aa Bb Cc 123</span>
        <small>{faces(f)}</small>
        <span class="actions">
          {#if onuse}
            {#each USES as [key, label] (key)}<button type="button" onclick={() => onuse?.(key, stack(f.family))} title={t('Usa {0} per: {1}', f.family, label)}>{label}</button>{/each}
          {/if}
          <button type="button" onclick={() => navigator.clipboard?.writeText(stack(f.family))} title={t('Copia «{0}»', stack(f.family))}>{t('Copia')}</button>
          {#if data?.canManage}<button type="button" class="danger" disabled={busy} onclick={() => remove(f.family)} aria-label={t('Togli {0}', f.family)}>✕</button>{/if}
        </span>
      </li>
    {/each}
  </ul>

  {#if data?.canManage}
    <div class="google">
      <label class="search">
        {t('Aggiungi da Google Fonts')}
        <input type="search" bind:value={query} placeholder={t('Cerca una famiglia (Inter, Lora, serif…)')} oninput={() => (chosen = null)} />
      </label>
      {#if found.length}
        <ul class="catalog" aria-label={t('Famiglie trovate')}>
          {#each found as f (f.family)}
            <li><button type="button" class:on={chosen?.family === f.family} onclick={() => choose(f)} aria-pressed={chosen?.family === f.family}>{f.family} <small>{f.category}{onSite.has(f.family) ? ` · ${t('già sul sito')}` : ''}</small></button></li>
          {/each}
        </ul>
      {:else if query.trim()}
        <p class="hint">{t('Nessuna famiglia nell’elenco: puoi aggiungerla da Histeon → Impostazioni scrivendo il nome.')}</p>
      {/if}
      {#if chosen}
        <fieldset>
          <legend>{chosen.family}</legend>
          <div class="weights">
            {#each chosen.weights as w (w)}
              <label><input type="checkbox" checked={weights.includes(w)} onchange={(e) => toggleWeight(w, e.currentTarget.checked)} /> {w}</label>
            {/each}
          </div>
          {#if chosen.italic}<label><input type="checkbox" bind:checked={italic} /> {t('Anche il corsivo')}</label>{/if}
          <button type="button" class="primary" disabled={busy || !weights.length} onclick={download}>{busy ? t('Scarico…') : t('Scarica sul sito')}</button>
        </fieldset>
      {/if}
    </div>
  {:else if data}
    <p class="hint">{t('Solo un amministratore aggiunge o toglie i font.')}</p>
  {/if}
  {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}
</section>

<style>
  .fonts { padding: 0 0 12px; display: grid; gap: 8px; }
  h3 { margin: 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  h3 span { font-weight: 400; }
  .hint { margin: 0; color: var(--xb-muted); font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .families { display: grid; gap: 6px; }
  .families li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 6px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .sample { font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .families small { grid-column: 1; color: var(--xb-muted); font-size: 11px; }
  .actions { grid-column: 2; grid-row: 1 / span 2; display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  button { font: 12px var(--xb-sans); padding: 4px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; justify-self: start; }
  button.danger { color: var(--xb-danger); }
  .google { display: grid; gap: 6px; }
  .search { display: grid; gap: 4px; font-size: 12px; color: var(--xb-muted); }
  .search input { font: 13px var(--xb-sans); padding: 6px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .catalog { display: flex; flex-wrap: wrap; gap: 4px; max-height: 160px; overflow: auto; }
  .catalog button.on { border-color: var(--xb-accent); background: var(--xb-accent-bg); }
  .catalog small { color: var(--xb-muted); }
  fieldset { display: grid; gap: 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); font-size: 12px; }
  .weights { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .msg { margin: 0; font-size: 12.5px; }
  .msg.ok { color: var(--xb-ok); }
  .msg.error { color: var(--xb-danger); }
</style>
