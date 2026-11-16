<script lang="ts">
  import { onMount } from 'svelte';
  import { KIND_LABELS, SITE_PREFIX, colorFamilies, kindOf, recipeProblem, siteNameProblem, tokenProblem, type TokenKind } from '../lib/designSystem.ts';
  import { SITE_MAX, TOKEN_FILE_MAX, parseSiteVariables, type TokenFile } from '../histos-css/dtcg-import.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import type { ContrastPair, DesignParams, RecipeSources } from '../lib/api.ts';
  import DesignGenerator from './DesignGenerator.svelte';
  import FontsPanel from './FontsPanel.svelte';
  import { t } from '../lib/i18n.ts';

  // The design system (docs/spec/design-system.md): the active framework's variables with the values the page
  // computes — colours as swatches, spaces as bars, text sizes as samples. A click copies var(--name). With
  // Histeon Tokens the values are edited here, previewed at once, and saved in dev like any change.
  let { app }: { app: BuilderState } = $props();

  interface Token {
    name: string;
    value: string;
    px: number | null;
    /** A colour as the page resolves it (variables made of other variables included). */
    color: string | null;
    kind: TokenKind;
  }
  let tokens = $state<Token[]>([]);
  let query = $state('');
  let copied = $state('');
  let editable = $state(false);
  let saved = $state<Record<string, string>>({});
  let edits = $state<Record<string, string>>({});
  let heads = { head: '', base: '' };
  let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  let busy = $state(false);
  /** Histeon CSS design parameters (the generator): what is saved, what is being edited, the defaults. */
  let design = $state<DesignParams>({});
  let designSaved = $state<DesignParams>({});
  let designDefaults = $state<DesignParams>({});
  let designContrast = $state<ContrastPair[]>([]);
  let generator = $state<{ clearPreview: () => void; useFont: (key: 'font_body' | 'font_heading' | 'font_mono' | 'font_accent' | 'font_display', stack: string) => void } | undefined>();
  const designChanged = $derived(JSON.stringify(design) !== JSON.stringify(designSaved));
  /** Colour families opened by a click (their shades and transparencies). */
  let openFamilies = $state<string[]>([]);
  /** The site's own variables (`--xb-site-…`, names without the prefix) and recipes: as saved, and as being edited. */
  let siteSaved = $state<Record<string, string>>({});
  let siteTokens = $state<Record<string, string>>({});
  let newVar = $state({ name: '', value: '' });
  let recipeSources = $state<RecipeSources>({ site: {}, imported: {}, histos: {} });
  let siteRecipes = $state<Record<string, string>>({});
  let recipeQuery = $state('');
  let openRecipe = $state('');
  let newRecipe = $state({ name: '', css: '' });
  const siteChanged = $derived(JSON.stringify(siteTokens) !== JSON.stringify(siteSaved));
  const recipesChanged = $derived(JSON.stringify(siteRecipes) !== JSON.stringify(recipeSources.site));
  const siteProblem = $derived(Object.entries(siteTokens).map(([name, value]) => (tokenProblem(value) ? `--${SITE_PREFIX}${name}: ${tokenProblem(value)}` : null)).find(Boolean) ?? null);
  const recipeError = $derived(Object.entries(siteRecipes).map(([name, css]) => (recipeProblem(name, css) ? `@${name}: ${recipeProblem(name, css)}` : null)).find(Boolean) ?? null);
  /** Every recipe with where it comes from: the site's win over the imported ones, which win over Histeon's. */
  const allRecipes = $derived.by(() => {
    const names = [...new Set([...Object.keys(recipeSources.histos), ...Object.keys(recipeSources.imported), ...Object.keys(siteRecipes)])].sort();
    return names.map((name) => ({
      name,
      css: siteRecipes[name] ?? recipeSources.imported[name] ?? recipeSources.histos[name] ?? '',
      origin: siteRecipes[name] !== undefined ? 'site' : recipeSources.imported[name] !== undefined ? 'imported' : 'histos',
      overrides: siteRecipes[name] !== undefined && (recipeSources.imported[name] !== undefined || recipeSources.histos[name] !== undefined),
    }));
  });
  const shownRecipes = $derived(allRecipes.filter((r) => !recipeQuery || r.name.includes(recipeQuery.toLowerCase().replace(/^[@?]/, '')) || r.css.toLowerCase().includes(recipeQuery.toLowerCase())));

  const canvas = () => document.querySelector<HTMLIFrameElement>('iframe[data-xb-canvas]')?.contentDocument ?? null;

  /** Values as the page computes them; sizes resolved to pixels with a probe (clamp(), rem, vw…). */
  function measure() {
    const d = canvas();
    const win = d?.defaultView;
    if (!d || !win) return;
    const root = win.getComputedStyle(d.documentElement);
    const probe = d.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;';
    d.documentElement.append(probe);
    const isColor = (v: string) => CSS.supports('color', v);
    const names = [...new Set(app.framework.variables.map((v) => v.name))];
    tokens = names
      .map((name) => {
        const value = root.getPropertyValue(`--${name}`).trim();
        const kind = kindOf(name, value, isColor);
        let px: number | null = null;
        let color: string | null = null;
        if (kind === 'space' || kind === 'text' || kind === 'radius') {
          probe.style.width = `var(--${name})`;
          px = Number.parseFloat(win.getComputedStyle(probe).width) || null;
        } else if (kind === 'color') {
          probe.style.color = `var(--${name})`;
          color = win.getComputedStyle(probe).color;
        }
        return { name, value, px, color, kind };
      })
      .filter((tok) => tok.value !== '');
    probe.remove();
  }

  onMount(async () => {
    measure();
    try {
      const doc = await app.api.getTokens();
      editable = doc.editable && app.framework.active.id === 'xb-tokens';
      saved = { ...doc.tokens };
      heads = { head: doc.head, base: doc.base };
      designDefaults = { ...(doc.defaults ?? {}) };
      designContrast = doc.contrast ?? [];
      designSaved = { ...(doc.design ?? doc.defaults ?? {}) };
      design = { ...designSaved };
      siteSaved = { ...(doc.siteTokens ?? {}) };
      siteTokens = { ...siteSaved };
      recipeSources = { site: { ...(doc.recipes?.site ?? {}) }, imported: { ...(doc.recipes?.imported ?? {}) }, histos: { ...(doc.recipes?.histos ?? {}) } };
      siteRecipes = { ...recipeSources.site };
    } catch {
      editable = false;
    }
  });

  const shown = $derived(tokens.filter((tok) => !query || tok.name.includes(query.toLowerCase().replace(/^--/, ''))));
  const groups = $derived((Object.keys(KIND_LABELS) as TokenKind[]).map((kind) => ({ kind, list: shown.filter((tok) => tok.kind === kind).slice(0, 300) })).filter((g) => g.list.length));

  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(`var(--${name})`);
      copied = name;
      setTimeout(() => copied === name && (copied = ''), 1200);
    } catch {
      /* clipboard refused: the name is in the tooltip */
    }
  }

  const valueOf = (tok: Token) => edits[tok.name] ?? saved[tok.name] ?? tok.value;
  const problemOf = (name: string) => (edits[name] !== undefined ? tokenProblem(edits[name] ?? '') : null);
  const changed = $derived(Object.keys(edits).length > 0);

  /** A site variable typed: shown at once on the canvas (an inline property on its root), saved with the rest. */
  function editSite(name: string, value: string) {
    siteTokens = { ...siteTokens, [name]: value };
    if (tokenProblem(value) === null) canvas()?.documentElement.style.setProperty(`--${SITE_PREFIX}${name}`, value);
  }
  function removeSite(name: string) {
    const { [name]: _gone, ...rest } = siteTokens;
    siteTokens = rest;
    canvas()?.documentElement.style.removeProperty(`--${SITE_PREFIX}${name}`);
  }
  const newVarProblem = $derived(newVar.name === '' && newVar.value === '' ? null : siteNameProblem(newVar.name) ?? (siteTokens[newVar.name] !== undefined ? t('Esiste già una variabile con questo nome.') : tokenProblem(newVar.value)));
  function addSite() {
    if (newVarProblem || !newVar.name) return;
    editSite(newVar.name, newVar.value.trim());
    newVar = { name: '', value: '' };
  }
  let siteInput = $state<HTMLInputElement | undefined>();
  /**
   * Many variables at once (a file, or the tokens imported in the generator): shown on the canvas like a typed one,
   * saved with the rest. One of the same name takes the new value; nothing goes over the site's maximum.
   */
  function addSiteMany(variables: Record<string, string>): number {
    const next = { ...siteTokens };
    let added = 0;
    for (const [name, value] of Object.entries(variables)) {
      if (siteNameProblem(name) || tokenProblem(value) || (next[name] === undefined && Object.keys(next).length >= SITE_MAX)) continue;
      next[name] = value;
      added++;
    }
    siteTokens = next;
    const root = canvas()?.documentElement;
    for (const [name, value] of Object.entries(next)) root?.style.setProperty(`--${SITE_PREFIX}${name}`, value);
    return added;
  }
  const SITE_FILE_ERRORS: Record<string, string> = {
    'no-file': 'Scegli almeno un file.',
    'too-large': 'Il file è troppo grande (al massimo 8 MB).',
    'too-many': 'Troppe variabili nel file.',
    'not-json': 'Il file non è JSON.',
    'not-variables': 'Il file non contiene variabili del sito.',
  };
  /** «Importa variabili»: `variabili-sito.json` of Histeon Publish, or a file of design tokens of Figma or Penpot. */
  async function importSite(e: Event & { currentTarget: HTMLInputElement }) {
    const picked = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = '';
    if (!picked.length) return;
    try {
      if (picked.some((file) => file.size > TOKEN_FILE_MAX)) throw new Error('too-large');
      const files: TokenFile[] = [];
      for (const file of picked) files.push({ name: file.name, text: await file.text() });
      const read = parseSiteVariables(files);
      const total = Object.keys(read.variables).length;
      const added = addSiteMany(read.variables);
      const left = read.skipped.length + (total - added);
      message = { kind: added ? 'ok' : 'error', text: `${t('Variabili del sito importate: {0}; lasciate fuori {1}.', added, left)} ${added ? t('«Salva in sviluppo» le tiene.') : ''}`.trim() };
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      message = { kind: 'error', text: SITE_FILE_ERRORS[code] ? t(SITE_FILE_ERRORS[code]) : code };
    }
  }
  function editRecipe(name: string, css: string) {
    siteRecipes = { ...siteRecipes, [name]: css };
  }
  /** ↺: the site's version goes; Histeon's (or the imported one) is back. */
  function resetRecipe(name: string) {
    const { [name]: _gone, ...rest } = siteRecipes;
    siteRecipes = rest;
  }
  const newRecipeProblem = $derived(newRecipe.name === '' && newRecipe.css === '' ? null : allRecipes.some((r) => r.name === newRecipe.name) ? t('Esiste già una ricetta con questo nome: aprila e modificala.') : recipeProblem(newRecipe.name, newRecipe.css));
  function addRecipe() {
    if (newRecipeProblem || !newRecipe.name) return;
    editRecipe(newRecipe.name, newRecipe.css.trim());
    openRecipe = newRecipe.name;
    newRecipe = { name: '', css: '' };
  }

  /** Typing previews at once on the canvas (an inline custom property on its root), nothing is saved yet. */
  function edit(name: string, value: string) {
    edits = { ...edits, [name]: value };
    const root = canvas()?.documentElement;
    if (!root) return;
    if (tokenProblem(value) === null) root.style.setProperty(`--${name}`, value);
  }
  function reset(name: string) {
    const { [name]: _edit, ...otherEdits } = edits;
    edits = otherEdits;
    const { [name]: _saved, ...otherSaved } = saved;
    saved = otherSaved;
    canvas()?.documentElement.style.removeProperty(`--${name}`);
    pendingReset = [...pendingReset, name];
  }
  let pendingReset = $state<string[]>([]);

  async function save() {
    const bad = Object.keys(edits).find((n) => problemOf(n));
    if (bad) {
      message = { kind: 'error', text: `--${bad}: ${problemOf(bad)}` };
      return;
    }
    if (siteProblem || recipeError) {
      message = { kind: 'error', text: siteProblem ?? recipeError ?? '' };
      return;
    }
    busy = true;
    const next = { ...saved, ...edits };
    try {
      const r = await app.api.saveTokens(next, heads.head, heads.base, designChanged ? design : undefined, { ...(siteChanged ? { siteTokens } : {}), ...(recipesChanged ? { recipes: siteRecipes } : {}) });
      heads = r;
      saved = next;
      edits = {};
      designSaved = { ...design };
      siteSaved = { ...siteTokens };
      recipeSources = { ...recipeSources, site: { ...siteRecipes } };
      // The CSS panel's completions (`@name`, `var(--xb-site-…)`) see the new recipes and variables at once.
      app.framework = {
        ...app.framework,
        recipes: { ...recipeSources.histos, ...recipeSources.imported, ...siteRecipes },
        variables: [...app.framework.variables.filter((v) => v.group !== 'site'), ...Object.entries(siteTokens).map(([name, value]) => ({ name: `${SITE_PREFIX}${name}`, group: 'site', value }))],
      };
      generator?.clearPreview();
      pendingReset = [];
      const root = canvas()?.documentElement;
      root?.removeAttribute('style');
      await app.refreshPreview();
      requestAnimationFrame(measure);
      message = { kind: 'ok', text: t('Salvato in sviluppo: va online con la prossima release.') };
    } catch (e) {
      message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }
</script>

<div class="design">
  <div class="bar">
    <p class="intro">
      <strong>{app.framework.active.label || t('Nessun framework')}</strong>
      {#if editable}· {t('i valori di Histeon CSS si modificano qui, con anteprima immediata, e si salvano in sviluppo.')}{:else}· {t('i valori si modificano nel pannello del framework. Un clic copia')} <code>var(--{t('nome')})</code>.{/if}
    </p>
    <input type="search" bind:value={query} placeholder={t('Cerca una variabile')} aria-label={t('Cerca una variabile')} />
    {#if editable}
      <button class="primary" onclick={save} disabled={busy || (!changed && !designChanged && !siteChanged && !recipesChanged && pendingReset.length === 0)}>{busy ? t('Salvataggio…') : t('Salva in sviluppo')}</button>
    {/if}
  </div>
  {#if editable && Object.keys(designDefaults).length > 0}
    <DesignGenerator bind:this={generator} {app} bind:design defaults={designDefaults} bind:contrast={designContrast} onsite={addSiteMany} />
  {/if}
  {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}
  <FontsPanel {app} onuse={editable && generator ? (key, stack) => generator?.useFont(key, stack) : undefined} />
  {#if groups.length === 0}
    <p class="msg">{query ? t('Nessuna variabile trovata.') : t('Nessuna variabile nel framework attivo.')}</p>
  {/if}
  {#if editable}
    <section class="site" aria-label={t('Variabili del sito')}>
      <h3>{t('Variabili del sito')} <span>{Object.keys(siteTokens).length}</span></h3>
      <p class="msg">{t('Variabili tue, accanto a quelle di Histeon CSS: si usano come')} <code>var(--{SITE_PREFIX}{t('nome')})</code>.</p>
      {#if Object.keys(siteTokens).length}
        <ul class="site-list">
          {#each Object.entries(siteTokens) as [name, value] (name)}
            <li>
              <code>--{SITE_PREFIX}{name}</code>
              <input {value} aria-label={t('Valore di --{0}', SITE_PREFIX + name)} spellcheck="false" class:bad={!!tokenProblem(value)} oninput={(e) => editSite(name, e.currentTarget.value)} />
              <button class="reset" onclick={() => removeSite(name)} title={t('Elimina la variabile')} aria-label={t('Elimina --{0}', SITE_PREFIX + name)}>✕</button>
            </li>
          {/each}
        </ul>
      {/if}
      <form class="add" onsubmit={(e) => { e.preventDefault(); addSite(); }}>
        <span class="prefix">--{SITE_PREFIX}</span>
        <input bind:value={newVar.name} placeholder={t('nome')} aria-label={t('Nome della nuova variabile')} spellcheck="false" />
        <input bind:value={newVar.value} placeholder={t('valore, es. 1.5rem o var(--xb-primary-300)')} aria-label={t('Valore della nuova variabile')} spellcheck="false" />
        <button type="submit" disabled={!newVar.name || !newVar.value || !!newVarProblem}>＋ {t('Variabile')}</button>
        <button type="button" title={t('Molte variabili da un file: variabili-sito.json di Histeon Publish, o i token esportati da Figma o Penpot (quelli senza un parametro del design).')} onclick={() => siteInput?.click()}>{t('Importa variabili')}</button>
        <input type="file" accept="application/json,.json" multiple hidden bind:this={siteInput} onchange={importSite} />
      </form>
      {#if newVarProblem}<p class="msg error">{newVarProblem}</p>{/if}
    </section>
    <details class="recipes" data-testid="design-recipes">
      <summary><h3>{t('Ricette')} <span>{allRecipes.length}</span></h3></summary>
      <p class="msg">{t('Si usano con @nome nel pannello CSS e nel pannello Ricette. Una ricetta del sito con lo stesso nome sostituisce quella di Histeon; ↺ la riporta.')}</p>
      <input type="search" bind:value={recipeQuery} placeholder={t('Cerca una ricetta')} aria-label={t('Cerca una ricetta')} />
      <ul class="recipe-list">
        {#each shownRecipes.slice(0, 200) as r (r.name)}
          <li>
            <button class="recipe" aria-expanded={openRecipe === r.name} onclick={() => (openRecipe = openRecipe === r.name ? '' : r.name)}>
              <code>@{r.name}</code>
              <span class="origin {r.origin}">{r.origin === 'site' ? (r.overrides ? t('Sito · sostituisce') : t('Sito')) : r.origin === 'imported' ? 'Automatic.css' : 'Histeon'}</span>
            </button>
            {#if openRecipe === r.name}
              <textarea rows="5" spellcheck="false" aria-label={t('CSS della ricetta @{0}', r.name)} class:bad={!!(siteRecipes[r.name] !== undefined && recipeProblem(r.name, siteRecipes[r.name] ?? ''))} value={r.css} oninput={(e) => editRecipe(r.name, e.currentTarget.value)}></textarea>
              {#if siteRecipes[r.name] !== undefined && recipeProblem(r.name, siteRecipes[r.name] ?? '')}<p class="msg error">{recipeProblem(r.name, siteRecipes[r.name] ?? '')}</p>{/if}
              {#if siteRecipes[r.name] !== undefined}<button class="reset" onclick={() => resetRecipe(r.name)}>{r.overrides ? t('↺ Torna alla ricetta originale') : t('Elimina la ricetta')}</button>{/if}
            {/if}
          </li>
        {/each}
      </ul>
      <form class="add recipe-add" onsubmit={(e) => { e.preventDefault(); addRecipe(); }}>
        <span class="prefix">@</span>
        <input bind:value={newRecipe.name} placeholder={t('nome')} aria-label={t('Nome della nuova ricetta')} spellcheck="false" />
        <textarea bind:value={newRecipe.css} rows="3" placeholder={'display: grid;\ngap: var(--xb-space-m);'} aria-label={t('CSS della nuova ricetta')} spellcheck="false"></textarea>
        <button type="submit" disabled={!newRecipe.name || !newRecipe.css.trim() || !!newRecipeProblem}>＋ {t('Ricetta')}</button>
      </form>
      {#if newRecipeProblem}<p class="msg error">{newRecipeProblem}</p>{/if}
    </details>
  {/if}
  {#each groups as g (g.kind)}
    <section aria-label={KIND_LABELS[g.kind]}>
      <h3>{KIND_LABELS[g.kind]} <span>{g.list.length}</span></h3>
      {#if g.kind === 'color' && !query}
        <!-- Only each family's base colour; its shades, transparencies and text colour open with a click. -->
        <ul class="families">
          {#each colorFamilies(g.list) as fam (fam.key)}
            <li class:open={openFamilies.includes(fam.key)}>
              <div class="family-row">
                <ul class="grid color one">{@render item(fam.main, 'color')}</ul>
                {#if fam.variants.length}
                  <button class="more" aria-expanded={openFamilies.includes(fam.key)} onclick={() => (openFamilies = openFamilies.includes(fam.key) ? openFamilies.filter((k) => k !== fam.key) : [...openFamilies, fam.key])} title={t('Sfumature e trasparenze di --{0}', fam.key)}>
                    {#each fam.variants.slice(0, 11) as v (v.name)}<span class="dot" style:background={v.color ?? 'transparent'}></span>{/each}
                    <span>{openFamilies.includes(fam.key) ? '−' : `+${fam.variants.length}`}</span>
                  </button>
                {/if}
              </div>
              {#if openFamilies.includes(fam.key)}
                <ul class="grid color">{#each fam.variants as v (v.name)}{@render item(v, 'color')}{/each}</ul>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="grid {g.kind}">
          {#each g.list as tok (tok.name)}{@render item(tok, g.kind)}{/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>

{#snippet item(tok: Token, kind: TokenKind)}
  <li>
    <button class="token" onclick={() => copy(tok.name)} title={t('{0} — clic: copia var(--{1})', tok.value, tok.name)}>
      {#if kind === 'color'}<span class="swatch" style:background={edits[tok.name] !== undefined && !problemOf(tok.name) ? edits[tok.name] : (tok.color ?? 'transparent')}></span>
      {:else if kind === 'space'}<span class="bar-v" style:width="{Math.min(240, tok.px ?? 0)}px"></span>
      {:else if kind === 'text'}<span class="sample" style:font-size="{Math.min(48, tok.px ?? 16)}px">Aa</span>
      {:else if kind === 'radius'}<span class="radius" style:border-radius="{Math.min(40, tok.px ?? 0)}px"></span>
      {:else if kind === 'shadow'}<span class="shadow" style:box-shadow={tok.value}></span>{/if}
      <span class="text"><span class="name">--{tok.name}</span><span class="value">{copied === tok.name ? t('copiato') : tok.px !== null && kind !== 'color' ? `${Math.round(tok.px)}px · ${tok.value}` : tok.value}</span></span>
    </button>
    {#if editable && !tok.name.startsWith(SITE_PREFIX)}
      <div class="edit">
        <input value={valueOf(tok)} aria-label={t('Valore di --{0}', tok.name)} spellcheck="false" class:bad={!!problemOf(tok.name)} oninput={(e) => edit(tok.name, e.currentTarget.value)} />
        {#if saved[tok.name] !== undefined}<button class="reset" onclick={() => reset(tok.name)} title={t('Torna al valore predefinito di Histeon CSS')}>↺</button>{/if}
      </div>
      {#if problemOf(tok.name)}<p class="msg error">{problemOf(tok.name)}</p>{/if}
    {/if}
  </li>
{/snippet}

<style>
  .design { display: grid; gap: 16px; align-content: start; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .intro { margin: 0; flex: 1 1 320px; color: var(--xb-muted); font-size: 13px; }
  .intro strong { color: var(--xb-text); }
  input { font: 12.5px var(--xb-mono); padding: 5px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); min-width: 0; }
  input.bad { border-color: var(--xb-danger); }
  button { font: 500 13px var(--xb-sans); cursor: pointer; }
  .primary { padding: 6px 12px; border-radius: var(--xb-r); border: 1px solid var(--xb-ink); background: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  .primary:disabled { opacity: 0.45; cursor: default; }
  h3 { margin: 0 0 8px; font: 600 12px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.05em; color: var(--xb-muted); }
  h3 span { font-weight: 500; }
  .grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .grid.space, .grid.text { grid-template-columns: 1fr; }
  li { display: grid; gap: 4px; }
  .token { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); color: var(--xb-text); text-align: left; }
  .token:hover { border-color: color-mix(in srgb, var(--xb-muted) 45%, var(--xb-line)); }
  .text { display: grid; gap: 2px; min-width: 0; }
  .name { font: 600 12px var(--xb-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .value { font: 11px var(--xb-mono); color: var(--xb-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .swatch { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--xb-line); }
  .bar-v { height: 10px; min-width: 2px; border-radius: 2px; background: var(--xb-coral); }
  .grid.space .token { grid-template-columns: 250px minmax(0, 1fr); }
  .sample { font-family: Georgia, serif; line-height: 1; min-width: 36px; }
  .radius { width: 28px; height: 28px; border: 2px solid var(--xb-accent); background: var(--xb-accent-bg); }
  .shadow { width: 34px; height: 24px; border-radius: 4px; background: #fff; }
  .edit { display: flex; gap: 4px; }
  .edit input { flex: 1; }
  .reset { padding: 0 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); }
  .msg { margin: 0; font-size: 12.5px; color: var(--xb-muted); }
  .msg.ok { color: var(--xb-ok); }
  .msg.error { color: var(--xb-danger); }
  .families { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .family-row { display: flex; gap: 8px; align-items: stretch; }
  .grid.one { flex: 0 1 320px; grid-template-columns: 1fr; }
  .families .open > .grid { margin: 8px 0 4px 16px; }
  .more { display: flex; align-items: center; gap: 3px; padding: 4px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); color: var(--xb-muted); }
  .more .dot { width: 12px; height: 24px; border-radius: 3px; border: 1px solid color-mix(in srgb, var(--xb-line) 60%, transparent); }
  .more > span:last-child { margin-left: 6px; font: 600 12px var(--xb-mono); }
  .site, .recipes { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); }
  .recipes summary { cursor: pointer; list-style-position: inside; }
  .recipes summary h3 { display: inline; }
  .site-list, .recipe-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .site-list li { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr) auto; gap: 6px; align-items: center; }
  .site-list code, .recipe code { font: 600 12px var(--xb-mono); overflow: hidden; text-overflow: ellipsis; }
  .add { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .add input { flex: 1 1 140px; }
  .add button { padding: 5px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); }
  .add button:disabled { opacity: 0.45; cursor: default; }
  .prefix { font: 12px var(--xb-mono); color: var(--xb-muted); }
  .recipe-list { max-height: 340px; overflow: auto; }
  .recipe { display: flex; width: 100%; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); text-align: left; }
  .origin { font-size: 11px; color: var(--xb-muted); }
  .origin.site { color: var(--xb-coral); font-weight: 600; }
  textarea { width: 100%; font: 12.5px var(--xb-mono); padding: 6px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); box-sizing: border-box; }
  textarea.bad { border-color: var(--xb-danger); }
  .recipe-add textarea { flex: 1 1 100%; }
</style>
