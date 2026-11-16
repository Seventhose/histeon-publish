<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import { declarations, GROUPS, groupIsSet, optionsFor, relevant, scalesFrom, setDeclaration, type Control } from '../lib/miniGui.ts';
  import type { Snippet } from 'svelte';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The mini GUI (docs/spec/styles.md §9): one row of groups over the CSS editor; the open group shows only the
  // controls that make sense for this element now (flex settings for a flex box, object-fit for an image…).
  // Each click writes into the selector's CSS, which stays the code you see; the active value is highlighted and
  // a second click on it removes the declaration. Clicking the open group closes it: the row is all that stays.
  // lead / trail: the panel's own controls (state, width, more) in the same row as the groups.
  // groups: only these groups (a client's page look, voce 186); all when not given.
  let { app, css, onchange, selector, tag = '', lead, trail, groups }: { app: BuilderState; css: string; onchange: (next: string) => void; selector: string; tag?: string; lead?: Snippet; trail?: Snippet; groups?: string[] } = $props();

  const shown = $derived(groups ? GROUPS.filter((g) => groups.includes(g.id)) : GROUPS);

  let tab = $state<string | null>(readTab());
  let all = $state(false);
  const scales = $derived(scalesFrom(app.framework.variables));
  const current = $derived(declarations(css));
  const group = $derived(shown.find((g) => g.id === tab) ?? null);
  const controls = $derived(group ? group.controls.filter((c) => all || relevant(c, current, tag)) : []);
  const hidden = $derived(group ? group.controls.length - controls.length : 0);

  function readTab(): string | null {
    try {
      const v = localStorage.getItem('xb-mini-gui-tab');
      return v === '' ? null : (v ?? GROUPS[0]!.id);
    } catch {
      return GROUPS[0]!.id;
    }
  }
  function open(id: string) {
    tab = tab === id ? null : id;
    all = false;
    try {
      localStorage.setItem('xb-mini-gui-tab', tab ?? '');
    } catch {
      /* ignore */
    }
  }

  function pick(control: Control, value: string) {
    onchange(setDeclaration(css, control.prop, current[control.prop] === value ? null : value));
  }
</script>

<div class="mini" aria-label={t('Mini GUI di {0}', selector)} role="region">
  <div class="bar">
    {@render lead?.()}
    <div class="tabs" role="tablist" aria-label={t('Gruppi di proprietà')}>
      {#each shown as g (g.id)}
        <button role="tab" aria-selected={tab === g.id} class:active={tab === g.id} class:set={groupIsSet(g, current)} title={tab === g.id ? t('{0}: un clic chiude', g.label) : g.label} onclick={() => open(g.id)}>{g.label}</button>
      {/each}
    </div>
    {@render trail?.()}
  </div>
  {#if group}
    <div class="rows" role="tabpanel" aria-label={group.label}>
      {#each controls as control (control.prop)}
        {@const options = optionsFor(control, scales)}
        {@const value = current[control.prop]}
        <div class="row" role="group" aria-label={control.prop}>
          <span class="prop" class:set={value !== undefined} title={value !== undefined ? `${control.prop}: ${value}` : control.prop}>{control.prop}</span>
          <div class="options">
            {#if options.length === 0}
              <span class="none">{t('nessuna variabile nel framework')}</span>
            {:else}
              {#each options as option (option.value)}
                <button class:active={value === option.value} aria-pressed={value === option.value} title="{control.prop}: {option.value}" onclick={() => pick(control, option.value)}>
                  {#if control.kind === 'scale' && control.scale === 'color'}<span class="swatch" style:background={option.value}></span>{/if}{option.label}
                </button>
              {/each}
            {/if}
            {#if value !== undefined && !options.some((op) => op.value === value)}
              <button class="active custom" aria-pressed="true" title={t('Valore scritto nel codice: un clic lo toglie')} onclick={() => pick(control, value)}>{value}</button>
            {/if}
          </div>
        </div>
      {/each}
      {#if hidden > 0}
        <button class="more" onclick={() => (all = true)} title={t('Proprietà che ora non hanno effetto (per esempio quelle di flex senza display: flex)')}>{tn('+{0} proprietà che ora non serve', '+{0} proprietà che ora non servono', hidden, hidden)}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .mini { font-size: 12px; min-width: 0; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
  .tabs { display: flex; flex-wrap: wrap; gap: 2px; flex: 1 1 auto; min-width: 0; }
  .tabs button { font: 12px var(--xb-sans); padding: 2px 7px; border: 0; border-radius: var(--xb-r-sm); background: transparent; color: var(--xb-muted); cursor: pointer; white-space: nowrap; position: relative; }
  .tabs button:hover { color: var(--xb-text); background: var(--xb-hover); }
  .tabs button.active { color: var(--xb-text); background: var(--xb-hover); box-shadow: inset 0 -2px 0 var(--xb-accent); }
  .tabs button.set::after { content: ''; position: absolute; top: 2px; right: 2px; width: 5px; height: 5px; border-radius: 50%; background: var(--xb-coral); }
  .rows { display: grid; gap: 3px; padding: 6px 0 2px; }
  .row { display: grid; grid-template-columns: 116px 1fr; gap: 6px; align-items: center; }
  .prop { font: 11px var(--xb-mono); color: var(--xb-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prop.set { color: var(--xb-link); }
  .options { display: flex; flex-wrap: wrap; gap: 3px; }
  .options button { font: 11px var(--xb-sans); padding: 1px 6px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .options button.active { background: var(--xb-accent); border-color: var(--xb-accent); color: #fff; }
  .options .custom { font-family: var(--xb-mono); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.2); }
  .none { color: var(--xb-muted); font-style: italic; }
  .more { justify-self: start; font: 11px var(--xb-sans); padding: 1px 6px; border: 0; background: none; color: var(--xb-link); cursor: pointer; }
</style>
