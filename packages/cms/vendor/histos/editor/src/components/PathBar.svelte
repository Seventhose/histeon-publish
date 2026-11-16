<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import { crumbName } from '../lib/tree.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Where the selection is (E4): «Pagina › Corpo › I giusti › Paragrafo» above the canvas. Each step selects its
  // node; a long path keeps its first step and the last ones.
  let { app }: { app: BuilderState } = $props();

  const MAX = 5;
  const steps = $derived.by(() => {
    if (!app.selected) return [];
    return app.path(app.selected).flatMap((uid) => {
      const block = app.find(uid);
      return block ? [{ uid, name: crumbName(block) }] : [];
    });
  });
  const shown = $derived(steps.length > MAX ? [steps[0]!, null, ...steps.slice(-(MAX - 2))] : steps);
</script>

{#if steps.length}
  <nav class="path" aria-label={t('Percorso della selezione')}>
    <ol>
      <li>
        <button type="button" onclick={() => app.select(null)} title={t('Togli la selezione')}>{app.isComponent ? t('Componente') : t('Pagina')}</button>
      </li>
      {#each shown as step, i (step?.uid ?? `gap-${i}`)}
        <li>
          {#if step}
            <button
              type="button"
              aria-current={step.uid === app.selected ? 'location' : undefined}
              title={step.name}
              onclick={() => app.select(step.uid)}
              onmouseenter={() => (app.hovered = step.uid)}
              onmouseleave={() => (app.hovered = null)}>{step.name}</button
            >
          {:else}
            <span aria-hidden="true">…</span>
          {/if}
        </li>
      {/each}
    </ol>
    {#if app.selection.length > 1}<span class="more" role="status">{t('e altri {0} selezionati', app.selection.length - 1)}</span>{/if}
  </nav>
{/if}

<style>
  .path {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    justify-content: flex-end;
    overflow: hidden;
  }
  ol {
    display: flex;
    align-items: center;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--xb-muted);
  }
  li {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 0 1 auto;
  }
  li + li::before {
    content: '›';
    padding: 0 4px;
  }
  button {
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 0;
    background: none;
    padding: 2px 4px;
    border-radius: var(--xb-r-sm);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button:hover {
    background: var(--xb-hover);
    color: var(--xb-text);
  }
  .more {
    flex: none;
    margin-left: 6px;
    font-size: 12px;
    color: var(--xb-accent);
    white-space: nowrap;
  }
  button[aria-current] {
    color: var(--xb-text);
    font-weight: 600;
  }
</style>
