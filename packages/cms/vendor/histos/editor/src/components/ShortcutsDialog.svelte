<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import type { Command } from '../lib/palette.ts';
  import { bindingsFor, comboOf, comboProblem, DEFAULTS, display, setBindings, type Overrides } from '../lib/shortcuts.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // Keyboard shortcuts (docs/spec/shortcuts.md): any command of the palette can have up to three combinations.
  // A new one is recorded by pressing it; changes are saved in the user's profile right away.
  let { app, mac, commands, shortcuts = $bindable() }: { app: BuilderState; mac: boolean; commands: () => Command[]; shortcuts: Overrides } = $props();

  let dialog: HTMLDialogElement;
  let list = $state<Command[]>([]);
  let query = $state('');
  /** The command waiting for a key combination. */
  let recording = $state<string | null>(null);
  let message = $state('');
  let saving = $state(false);

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return list.filter((c) => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || bindingsFor(c.id, shortcuts).some((k) => display(k, mac).toLowerCase().includes(q)));
  });
  const labelOf = (id: string) => list.find((c) => c.id === id)?.label ?? id;

  export function open() {
    list = commands();
    query = '';
    recording = null;
    message = '';
    dialog.showModal();
  }

  async function store(next: Overrides) {
    const before = shortcuts;
    shortcuts = next;
    saving = true;
    try {
      const res = await app.api.saveShortcuts(next);
      shortcuts = res.shortcuts;
      message = t('Salvate nel tuo profilo.');
    } catch (e) {
      shortcuts = before;
      message = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /** While recording, the next combination goes to the command (Esc cancels); nothing else sees the keys. */
  function onkeydowncapture(event: KeyboardEvent) {
    if (!recording || !dialog?.open) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      recording = null;
      message = '';
      return;
    }
    const combo = comboOf(event);
    if (!combo) return; // A modifier alone: wait for the key.
    const id = recording;
    const problem = comboProblem(combo, id, shortcuts, labelOf);
    if (problem) {
      message = problem;
      return;
    }
    const current = bindingsFor(id, shortcuts);
    recording = null;
    if (current.includes(combo)) return;
    void store(setBindings(shortcuts, id, [...current, combo].slice(-3)));
  }
</script>

<svelte:window {onkeydowncapture} />

<dialog bind:this={dialog} class="keys" aria-labelledby="xb-keys-title">
  <header>
    <h2 id="xb-keys-title">{t('Scorciatoie da tastiera')}</h2>
    <button onclick={() => dialog.close()} aria-label={t('Chiudi le scorciatoie')}>✕</button>
  </header>
  <p class="muted">{t('Ogni comando della palette ({0}) può averne fino a tre. Valgono per te, su ogni browser. Nei campi di testo e negli editor di codice funzionano solo «Apri i comandi» e «Salva».', display('Mod+K', mac))}</p>
  <input type="search" placeholder={t('Cerca un comando o una combinazione…')} aria-label={t('Cerca tra le scorciatoie')} bind:value={query} />
  <ul>
    {#each shown as c (c.id)}
      {@const keys = bindingsFor(c.id, shortcuts)}
      <li>
        <span class="label">{c.label} <span class="group">{c.group}</span></span>
        <span class="combos">
          {#each keys as k (k)}
            <span class="combo"><kbd>{display(k, mac)}</kbd><button aria-label={t('Togli {0} da {1}', display(k, mac), c.label)} disabled={saving} onclick={() => void store(setBindings(shortcuts, c.id, keys.filter((x) => x !== k)))}>✕</button></span>
          {/each}
          {#if recording === c.id}
            <span class="rec" role="status">{t('Premi la combinazione… (Esc annulla)')}</span>
          {:else if keys.length < 3}
            <button class="add" aria-label={t('Aggiungi una scorciatoia a {0}', c.label)} disabled={saving} onclick={() => ((recording = c.id), (message = ''))}>+</button>
          {/if}
          {#if c.id in shortcuts}
            <button class="reset" aria-label={t('Ripristina {0}', c.label)} disabled={saving} onclick={() => void store(setBindings(shortcuts, c.id, DEFAULTS[c.id] ?? []))}>↺</button>
          {/if}
        </span>
      </li>
    {/each}
  </ul>
  <footer>
    {#if message}<p class="msg" role="status">{message}</p>{/if}
    <button disabled={saving || !Object.keys(shortcuts).length} onclick={() => void store({})}>{t('Ripristina tutte')}</button>
  </footer>
</dialog>

<style>
  dialog { border: 1px solid var(--xb-line); border-radius: 10px; padding: 16px; background: var(--xb-bg); color: var(--xb-text); width: min(640px, 94vw); max-height: 86vh; font-size: 13px; }
  dialog[open] { display: grid; grid-template-rows: auto auto auto 1fr auto; gap: 8px; }
  dialog::backdrop { background: rgb(0 0 0 / 0.3); }
  header { display: flex; justify-content: space-between; align-items: center; }
  h2 { margin: 0; font-size: 15px; }
  .muted { margin: 0; color: var(--xb-muted); }
  ul { list-style: none; margin: 0; padding: 0; overflow: auto; }
  li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--xb-line); align-items: center; }
  .group { color: var(--xb-muted); font-size: 11px; margin-left: 4px; }
  .combos { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: end; }
  .combo { display: inline-flex; align-items: center; gap: 1px; }
  kbd { font: 11px var(--xb-mono, monospace); border: 1px solid var(--xb-line); border-bottom-width: 2px; border-radius: var(--xb-r-sm); padding: 1px 5px; }
  .rec { color: var(--xb-link); }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .msg { margin: 0; color: var(--xb-muted); }
  input { font: 12px var(--xb-sans); padding: 5px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  button { font: 12px var(--xb-sans); padding: 2px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .combo button { border: 0; padding: 0 3px; color: var(--xb-muted); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
