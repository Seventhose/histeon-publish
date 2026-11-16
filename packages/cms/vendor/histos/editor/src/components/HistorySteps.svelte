<script lang="ts">
  import { t, dateLocale } from '../lib/i18n.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  // The undo history you can see (docs/spec/history-panel.md): the last steps in words, newest first, and a click
  // to go back to before any of them (or forward again to one undone), instead of pressing Ctrl+Z many times.
  let { app }: { app: BuilderState } = $props();

  let open = $state(false);
  let steps = $state<ReturnType<BuilderState['historySteps']>>([]);
  let root: HTMLDivElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();

  function toggle() {
    open = !open;
    if (open) steps = app.historySteps().reverse();
  }
  function go(back: number) {
    app.jump(back);
    steps = app.historySteps().reverse();
  }
  const time = (at: number) => new Date(at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
    };
    // Esc closes this and nothing else (not the selection too), and the focus goes back to the button.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      open = false;
      button?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  });
</script>

<div class="wrap" bind:this={root}>
  <button class="icon" bind:this={button} onclick={toggle} aria-expanded={open} aria-haspopup="dialog" disabled={!app.canUndo && !app.canRedo} title={t('Storia delle modifiche: torna a un punto preciso')} aria-label={t('Storia delle modifiche')}><Icon name="history" size={16} /></button>
  {#if open}
    <div class="pop" role="dialog" aria-label={t('Storia delle modifiche')}>
      <header><strong>{t('Storia')}</strong> <span>{t('{0} passi da annullare', steps.filter((s) => s.done).length)}</span></header>
      <ol>
        {#each steps as step, i (i)}
          {#if step.done && (i === 0 || !steps[i - 1]!.done)}
            <li class="now" aria-current="step">{t('Ora')}</li>
          {/if}
          <li class:undone={!step.done}>
            <button onclick={() => go(step.back)} title={step.done ? t('Torna a prima di questo passo') : t('Rifai fino a questo passo')}>
              <span class="label">{step.label}</span>
              <span class="time">{step.done ? '' : '↷ '}{time(step.at)}</span>
            </button>
          </li>
        {/each}
        {#if steps.length && !steps.some((s) => s.done)}<li class="now" aria-current="step">{t('Ora')}</li>{/if}
      </ol>
      <p class="hint">{t('Un clic su un passo riporta la pagina a prima di quel passo; i passi annullati restano qui finché non modifichi altro.')}</p>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; display: inline-flex; }
  .icon { display: inline-grid; place-items: center; padding: 4px 6px; }
  .pop { position: absolute; z-index: 60; right: 0; top: calc(100% + 6px); width: min(380px, 90vw); max-height: 60vh; overflow: auto; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r); box-shadow: var(--xb-shadow); padding: 8px; font-size: 12.5px; }
  header { display: flex; justify-content: space-between; gap: 8px; padding: 2px 4px 6px; color: var(--xb-muted); }
  header strong { color: var(--xb-text); }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
  li button { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; padding: 5px 6px; border: 0; border-radius: var(--xb-r-sm); background: transparent; color: inherit; font: inherit; cursor: pointer; }
  li button:hover, li button:focus-visible { background: var(--xb-hover); }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { color: var(--xb-muted); font: 11px var(--xb-mono); flex: none; }
  li.undone { opacity: 0.55; }
  li.now { padding: 2px 6px; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-coral); border-top: 1px solid var(--xb-coral); margin: 4px 0; }
  .hint { margin: 8px 4px 2px; color: var(--xb-muted); font-size: 11.5px; }
</style>
