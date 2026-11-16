<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { declarations, setDeclaration } from '../lib/miniGui.ts';
  import { compactGroups, snippetChanges, snippetState, type CompactSnippet } from '../lib/miniGuiCompact.ts';
  import type { Snippet } from 'svelte';

  // The compact mini GUI (docs/spec/styles.md §9): groups of small buttons in one strip, those that make
  // sense here only; a button writes its declarations with a starting value into the selector's CSS (the value is
  // then edited in the code), and a second click on a button that is on takes them away. Same props
  // and same place as the Histeon mini GUI: the choice between them is the CSS panel's.
  let { css, onchange, selector, tag = '', state = null, lead, trail }: { css: string; onchange: (next: string) => void; selector: string; tag?: string; state?: string | null; lead?: Snippet; trail?: Snippet } = $props();

  const current = $derived(declarations(css));
  const groups = $derived(compactGroups({ decls: current, tag: tag.toLowerCase(), state }));

  function press(snippet: CompactSnippet) {
    let next = css;
    for (const [prop, value] of snippetChanges(snippet, current)) next = setDeclaration(next, prop, value);
    onchange(next);
  }
</script>

<div class="mini compact" aria-label={t('Mini GUI di {0}', selector)} role="region">
  <div class="bar">
    {@render lead?.()}
    <span class="grow"></span>
    {@render trail?.()}
  </div>
  <div class="strip">
    {#each groups as group (group.id)}
      <div class="group" role="group" aria-label={group.label}>
        <span class="name">{group.label}</span>
        {#each group.snippets as snippet (snippet.id)}
          {@const on = snippetState(snippet, current)}
          <button
            type="button"
            class:on={on === 'on'}
            class:set={on === 'set'}
            aria-pressed={on === 'on'}
            title={`${snippet.label}: ${Object.entries(snippet.set).map(([p, v]) => `${p}: ${v}`).join('; ')}`}
            aria-label={snippet.label}
            onclick={() => press(snippet)}
          >{snippet.mark}</button>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .mini { display: grid; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--xb-line); }
  .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .strip { display: flex; flex-wrap: wrap; gap: 6px 10px; }
  .group { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-panel); }
  .name { font: 600 10px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.04em; color: var(--xb-muted); margin-inline-end: 4px; }
  button { min-inline-size: 26px; block-size: 24px; padding: 0 5px; border: 1px solid transparent; border-radius: var(--xb-r-sm); background: transparent; color: var(--xb-text); font: 12px var(--xb-sans); cursor: pointer; }
  button:hover { background: var(--xb-hover); }
  button:focus-visible { outline: 2px solid var(--xb-accent); outline-offset: -2px; }
  button.on { background: var(--xb-accent-bg); border-color: var(--xb-accent); color: var(--xb-accent); }
  button.set { border-color: var(--xb-line); }
  button.set::after { content: '•'; margin-inline-start: 1px; color: var(--xb-accent); }
</style>
