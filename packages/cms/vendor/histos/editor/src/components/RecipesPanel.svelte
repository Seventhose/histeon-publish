<script lang="ts">
  import { compileCss } from '@xb/dsl';
  import { staticClasses, updateBlock } from '../lib/tree.ts';
  import { validClassName } from '../lib/selectors.ts';
  import { RECIPE_ALIASES, JS_RECIPES, cssGroups, jsPreviewDocument, jsRecipeCode, previewDocument, recipeMatches, sampleFor, type JsRecipe } from '../lib/recipes.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t } from '../lib/i18n.ts';

  // The recipes panel (docs/spec/histos-css.md §5): every CSS and JavaScript recipe as a button. Pointing at one (or
  // focusing it) shows it before anything changes, as an editor previews an effect: on a sample in the panel, and on
  // the selected element in the canvas for a CSS recipe. A click writes it into the selected element's class; without
  // a class the buttons still preview (aria-disabled, so pointing at them works) and the panel offers to add one.
  let { app }: { app: BuilderState } = $props();

  let kind = $state<'css' | 'js'>('css');
  let query = $state('');
  let newClass = $state('');
  let message = $state('');
  /** The recipe being previewed (pointed at or focused), CSS name or JS recipe. */
  let previewing = $state<{ kind: 'css'; name: string } | { kind: 'js'; recipe: JsRecipe } | null>(null);

  const block = $derived(app.selected ? app.find(app.selected) : null);
  const classes = $derived(block?.name === 'xb/element' ? staticClasses(block) : []);
  let chosen = $state<string | null>(null);
  const cls = $derived(chosen && classes.includes(chosen) ? chosen : (classes[0] ?? null));
  const target = $derived(cls ? `.${cls}` : null);
  const recipes = $derived(app.framework.recipes ?? {});
  const groups = $derived(cssGroups(recipes).map((g) => ({ ...g, names: g.names.filter((n) => recipeMatches(n, recipes[n] ?? '', query)) })).filter((g) => g.names.length > 0));
  const jsList = $derived(JS_RECIPES.filter((r) => !query.trim() || `${r.name} ${r.label} ${r.description}`.toLowerCase().includes(query.trim().toLowerCase())));
  const scriptEditable = $derived(app.doc?.scriptEditable === true);
  const aliasesOf = (name: string) => Object.entries(RECIPE_ALIASES).filter(([, target]) => target === name).map(([alias]) => alias);

  /** Trying a recipe: the sample in the panel, and for CSS the element in the canvas (its class, or the element itself). */
  function show(next: typeof previewing) {
    previewing = next;
    const uid = app.selected;
    const on = target ?? (uid ? `[data-xb-uid="${uid.replace(/["\\]/g, '')}"]` : null);
    if (next?.kind === 'css' && on) app.recipePreview = { selector: on, css: recipes[next.name] ?? '' };
    else if (next?.kind === 'js' && next.recipe.css && on) app.recipePreview = { selector: on, css: next.recipe.css.replace(/opacity: 0;/, 'opacity: 1;') };
    else app.recipePreview = null;
  }
  function hide() {
    app.recipePreview = null;
  }
  $effect(() => () => {
    app.recipePreview = null;
  });

  const previewSrc = $derived.by(() => {
    if (!previewing) return '';
    if (previewing.kind === 'js') return jsPreviewDocument(previewing.recipe);
    const css = recipes[previewing.name] ?? '';
    return previewDocument(sampleFor(previewing.name, css), compileCss('.r', css));
  });
  const previewCode = $derived(previewing?.kind === 'css' ? (recipes[previewing.name] ?? '') : previewing?.kind === 'js' ? jsRecipeCode(previewing.recipe, target ?? '.classe') : '');

  /** The recipe's CSS goes at the end of the class's own CSS: what it sets wins over what was there. */
  function applyCss(name: string) {
    if (!target) return;
    // What the CSS panel is still writing goes first, so the recipe lands after it and nothing typed is lost.
    app.flushEdits();
    const own = app.styles.find((s) => s.selector === target)?.css.trim() ?? '';
    app.upsertStyle(target, `${own ? `${own}\n` : ''}/* @${name} */\n${recipes[name] ?? ''}\n`);
    // An external change for the CSS panel, which then shows the class's CSS with the recipe.
    app.styleRevision++;
    app.recipePreview = null;
    message = t('Ricetta @{0} aggiunta a {1}.', name, target);
  }

  function applyJs(recipe: JsRecipe) {
    if (!target || !scriptEditable) return;
    app.flushEdits();
    const code = jsRecipeCode(recipe, target);
    app.script = `${app.script.trimEnd()}${app.script.trim() ? '\n\n' : ''}${code}`;
    if (recipe.css) {
      const own = app.styles.find((s) => s.selector === target)?.css.trim() ?? '';
      app.upsertStyle(target, `${own ? `${own}\n` : ''}/* ${recipe.name} */\n${recipe.css}\n`);
      app.styleRevision++;
    }
    app.recipePreview = null;
    message = t('«{0}» aggiunto al JavaScript del documento per {1}.', recipe.label, target);
  }

  function addClass(event: SubmitEvent) {
    event.preventDefault();
    const name = newClass.trim();
    if (!app.selected || !validClassName(name)) return;
    app.setTree(
      updateBlock(app.tree, app.selected, (b) => {
        if (b.name !== 'xb/element') return b;
        const current = b.attrs.attributes?.class;
        const value = typeof current === 'string' && current.trim() !== '' ? `${current} ${name}` : name;
        return { ...b, attrs: { ...b.attrs, attributes: { ...(b.attrs.attributes ?? {}), class: value } } };
      }),
    );
    chosen = name;
    newClass = '';
  }
</script>

<div class="recipes">
  <div class="bar">
    <div class="segmented" role="tablist" aria-label={t('Tipo di ricetta')}>
      <button role="tab" aria-selected={kind === 'css'} class:active={kind === 'css'} onclick={() => (kind = 'css')}>CSS</button>
      <button role="tab" aria-selected={kind === 'js'} class:active={kind === 'js'} onclick={() => (kind = 'js')}>JavaScript</button>
    </div>
    <input type="search" bind:value={query} placeholder={t('Cerca (anche coi nomi alternativi)')} aria-label={t('Cerca una ricetta')} />
  </div>

  <div class="target">
    {#if !block}
      <span class="muted">{t('Seleziona un elemento per provare e applicare le ricette.')}</span>
    {:else if classes.length > 1}
      <label>{t('Si applica a')} <select bind:value={chosen} aria-label={t('Classe a cui applicare')}>{#each classes as c (c)}<option value={c}>.{c}</option>{/each}</select></label>
    {:else if target}
      <span>{t('Si applica a')} <code>{target}</code></span>
    {:else}
      <form onsubmit={addClass}>
        <span class="muted">{t('L’elemento non ha una classe: dagliene una per applicare.')}</span>
        <input bind:value={newClass} placeholder="es. card" aria-label={t('Nuova classe')} />
        <button type="submit" disabled={!newClass.trim()}>{t('Aggiungi classe')}</button>
      </form>
    {/if}
  </div>

  <div class="scroll">
  <div class="preview" aria-live="polite">
    {#if previewing}
      <iframe title={t('Anteprima della ricetta')} sandbox="" srcdoc={previewSrc}></iframe>
      <pre><code>{previewCode}</code></pre>
    {:else}
      <p class="muted">{t('Passa sopra una ricetta per vederla qui e sull’elemento selezionato, prima di applicarla.')}</p>
    {/if}
  </div>
  {#if message}<p class="status" role="status">{message}</p>{/if}

  <div class="list" onmouseleave={hide} role="presentation">
    {#if kind === 'css'}
      {#each groups as g (g.id)}
        <h3>{g.label}</h3>
        <div class="buttons">
          {#each g.names as name (name)}
            {@const aliases = aliasesOf(name)}
            <button
              type="button"
              class:active={previewing?.kind === 'css' && previewing.name === name}
              onmouseenter={() => show({ kind: 'css', name })}
              onfocus={() => show({ kind: 'css', name })}
              onblur={hide}
              onclick={() => applyCss(name)}
              aria-disabled={!target}
              title={aliases.length ? t('Nomi alternativi: {0}', aliases.map((a) => `?${a}`).join(', ')) : undefined}
              aria-label={t('Applica la ricetta @{0}', name)}
            >@{name}</button>
          {/each}
        </div>
      {:else}
        <p class="muted">{t('Nessuna ricetta trovata.')}</p>
      {/each}
    {:else}
      {#if !scriptEditable}<p class="muted">{t('Solo chi ha il permesso unfiltered_html può aggiungere JavaScript.')}</p>{/if}
      <div class="buttons js">
        {#each jsList as recipe (recipe.name)}
          <button
            type="button"
            class:active={previewing?.kind === 'js' && previewing.recipe.name === recipe.name}
            onmouseenter={() => show({ kind: 'js', recipe })}
            onfocus={() => show({ kind: 'js', recipe })}
            onblur={hide}
            onclick={() => applyJs(recipe)}
            aria-disabled={!target || !scriptEditable}
            aria-label={t('Aggiungi il JavaScript «{0}»', recipe.label)}
          >
            <strong>{recipe.label}</strong>
            <small>{recipe.description}</small>
          </button>
        {:else}
          <p class="muted">{t('Nessuna ricetta trovata.')}</p>
        {/each}
      </div>
    {/if}
  </div>
  <p class="muted note">{t('{0} ricette CSS: scrivile anche nel CSS con @nome (o ?nome).', String(Object.keys(recipes).length))}</p>
  </div>
</div>

<style>
  /* The panel scrolls as one, nothing over anything: in a short panel every button is reachable, and pointing at
     one still shows the recipe on the canvas when the sample has scrolled away. */
  .recipes { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; overflow: auto; padding: 8px; font: 12.5px var(--xb-sans); }
  .scroll { display: flex; flex-direction: column; gap: 8px; }
  /* A fixed height, previewing or not: the buttons below never move under the pointer. */
  .preview { display: grid; grid-template-rows: 130px 1fr; gap: 4px; block-size: 236px; flex: none; overflow: hidden; }
  .preview .muted { grid-row: 1 / -1; align-self: center; text-align: center; }
  .preview iframe { inline-size: 100%; block-size: 130px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: #fff; }
  .preview pre { margin: 0; min-block-size: 0; overflow: auto; padding: 6px; background: var(--xb-panel); border-radius: var(--xb-r-sm); font: 11px var(--xb-mono, ui-monospace, monospace); white-space: pre-wrap; }
  .list { flex: none; }
  h3 { margin: 10px 0 4px; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.04em; color: var(--xb-muted); }
  .buttons { display: flex; flex-wrap: wrap; gap: 4px; }
  .buttons button { font: 12px var(--xb-mono, ui-monospace, monospace); padding: 3px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  .buttons button:hover, .buttons button.active { border-color: var(--xb-accent); background: var(--xb-accent-bg); }
  .buttons button[aria-disabled='true'] { cursor: default; }
  .buttons.js { display: grid; }
  .buttons.js button { display: grid; gap: 2px; text-align: left; font-family: var(--xb-sans); padding: 6px 8px; }
  .buttons.js small { color: var(--xb-muted); white-space: normal; }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .muted { color: var(--xb-muted); margin: 0; }
  .status { margin: 0; color: var(--xb-text); }
  .note { font-size: 11px; }
</style>
