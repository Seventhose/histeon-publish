<script lang="ts">
  import { tick } from 'svelte';
  import { rank, type Command } from '../lib/palette.ts';
  import { t } from '../lib/i18n.ts';

  // Ctrl+K: every command of the builder in one searchable list (keyboard first: ↑ ↓ Invio Esc).
  let { commands }: { commands: () => Command[] } = $props();

  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let active = $state(0);
  let all = $state<Command[]>([]);
  const results = $derived(rank(all, query));

  export async function open() {
    all = commands();
    query = '';
    active = 0;
    dialog.showModal();
    await tick();
    input?.focus();
  }

  function run(command: Command | undefined) {
    if (!command) return;
    dialog.close();
    command.run();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, results.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[active]);
    }
  }

  $effect(() => {
    void query;
    active = 0;
  });

  $effect(() => {
    document.getElementById(`xb-cmd-${active}`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<dialog bind:this={dialog} class="palette" aria-label={t('Comandi')}>
  <input
    bind:this={input}
    bind:value={query}
    {onkeydown}
    placeholder={t('Cerca un comando, un elemento, un componente…')}
    role="combobox"
    aria-expanded="true"
    aria-controls="xb-cmd-list"
    aria-activedescendant={results.length ? `xb-cmd-${active}` : undefined}
  />
  <ul id="xb-cmd-list" role="listbox">
    {#each results as command, i (command.id)}
      <!-- An option of the combobox (focus stays in the field, arrows move, Enter runs): no button inside, which would
           be a second interactive control nested in the option. The click is for the mouse. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li id="xb-cmd-{i}" role="option" aria-selected={i === active} class="item" class:active={i === active} onclick={() => run(command)} onmouseenter={() => (active = i)}>
        <span class="label">{command.label}</span>
        {#if command.hint}<kbd>{command.hint}</kbd>{/if}
        <span class="group">{command.group}</span>
      </li>
    {:else}
      <li class="none">{t('Nessun comando per "{0}"', query)}</li>
    {/each}
  </ul>
</dialog>

<style>
  .palette {
    width: min(560px, 92vw);
    max-height: 70vh;
    padding: 0;
    border: 1px solid var(--xb-line);
    border-radius: 10px;
    background: var(--xb-panel);
    color: var(--xb-text);
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.5);
    margin-top: 12vh;
  }
  .palette::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    font: 15px var(--xb-sans);
    padding: 14px 16px;
    border: 0;
    border-bottom: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    outline: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: calc(70vh - 56px);
    overflow: auto;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--xb-r);
    background: transparent;
    color: var(--xb-text);
    font: 13px var(--xb-sans);
    cursor: pointer;
  }
  .item.active {
    background: var(--xb-accent);
    color: #fff;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group {
    font-size: 11px;
    opacity: 0.7;
  }
  kbd {
    font: 11px var(--xb-mono);
    opacity: 0.8;
  }
  .none {
    padding: 10px;
    color: var(--xb-muted);
  }
</style>
