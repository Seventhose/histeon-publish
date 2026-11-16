<script lang="ts" module>
  // The first-run tour of the builder (lista della spesa 142): five steps for someone who has never built a page,
  // each pointing at the part of the screen it talks about. Shown once per browser; the palette opens it again.
  export const TOUR_KEY = 'xb-tour-done';

  export interface TourStep {
    /** Where the step points (a CSS selector); missing on the screen, the step shows in the middle. */
    target: string;
    title: string;
    text: string;
  }
</script>

<script lang="ts">
  import { t } from '../lib/i18n.ts';

  let { steps }: { steps: TourStep[] } = $props();
  let index = $state(-1);
  let box = $state<{ top: number; left: number; width: number; height: number } | null>(null);

  /** Opens the tour; `onlyFirstTime` skips it when this browser has seen it. */
  export function start(onlyFirstTime = false) {
    let seen = false;
    try {
      seen = localStorage.getItem(TOUR_KEY) === '1';
    } catch {
      seen = false;
    }
    if (onlyFirstTime && seen) return;
    show(0);
  }

  function show(i: number) {
    index = i;
    const el = steps[i] ? document.querySelector(steps[i]!.target) : null;
    const r = el?.getBoundingClientRect();
    box = r && r.width > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
    queueMicrotask(() => document.querySelector<HTMLButtonElement>('.xb-tour [data-next]')?.focus());
  }

  function close() {
    index = -1;
    try {
      localStorage.setItem(TOUR_KEY, '1');
    } catch {
      /* A browser without storage sees the tour again next time: nothing breaks. */
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (index < 0) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' && index < steps.length - 1) show(index + 1);
    else if (e.key === 'ArrowLeft' && index > 0) show(index - 1);
  }

  const card = $derived.by(() => {
    if (!box) return 'top: 50%; left: 50%; transform: translate(-50%, -50%);';
    const below = box.top + box.height + 220 < window.innerHeight;
    const top = below ? box.top + box.height + 12 : Math.max(12, box.top - 12 - 200);
    const left = Math.min(Math.max(12, box.left), window.innerWidth - 372);
    return `top: ${top}px; left: ${left}px;`;
  });
</script>

<svelte:window {onkeydown} />

{#if index >= 0 && steps[index]}
  <div class="xb-tour" role="dialog" aria-modal="true" aria-labelledby="xb-tour-title">
    {#if box}<div class="spot" style="top: {box.top - 6}px; left: {box.left - 6}px; width: {box.width + 12}px; height: {box.height + 12}px;"></div>{:else}<div class="shade"></div>{/if}
    <div class="card" style={card}>
      <p class="count">{t('Passo {0} di {1}', index + 1, steps.length)}</p>
      <h2 id="xb-tour-title">{steps[index]!.title}</h2>
      <p>{steps[index]!.text}</p>
      <div class="row">
        <button onclick={close}>{t('Salta la guida')}</button>
        {#if index > 0}<button onclick={() => show(index - 1)}>{t('Indietro')}</button>{/if}
        {#if index < steps.length - 1}<button class="primary" data-next onclick={() => show(index + 1)}>{t('Avanti')}</button>{:else}<button class="primary" data-next onclick={close}>{t('Inizia')}</button>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .xb-tour { position: fixed; inset: 0; z-index: 10000; }
  .shade { position: absolute; inset: 0; background: rgb(0 0 0 / 0.45); }
  .spot { position: absolute; border-radius: 8px; box-shadow: 0 0 0 9999px rgb(0 0 0 / 0.45); outline: 2px solid var(--xb-accent, #e2725b); pointer-events: none; }
  .card { position: absolute; width: min(360px, calc(100vw - 24px)); padding: 16px; border-radius: 10px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); box-shadow: 0 12px 32px rgb(0 0 0 / 0.25); font-size: 13px; }
  .count { margin: 0 0 4px; color: var(--xb-muted); font-size: 12px; }
  h2 { margin: 0 0 6px; font-size: 16px; }
  .card p { margin: 0 0 12px; line-height: 1.5; }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: 13px var(--xb-sans); padding: 6px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-accent, #e2725b); border-color: transparent; color: #fff; }
</style>
