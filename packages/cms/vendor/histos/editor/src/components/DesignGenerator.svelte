<script lang="ts">
  import { hideClasses } from '../histos-css/hideClasses.ts';
  import type { ContrastPair, DesignParams } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import HistosCssPanel from '../histos-css/HistosCssPanel.svelte';
  import type { PanelHost } from '../histos-css/host.ts';
  import { t } from '../lib/i18n.ts';

  // The Histeon CSS generator in the builder (docs/spec/histos-css.md §1): the Histeon CSS panel (histos-css/), the
  // same one the drawer opens over WordPress pages, with the tokens on the canvas. The Design system panel saves
  // the parameters in dev with the token values, as one commit.
  let { app, design = $bindable(), defaults, contrast = $bindable([]), onsite }: { app: BuilderState; design: DesignParams; defaults: DesignParams; contrast?: ContrastPair[]; onsite?: (variables: Record<string, string>) => number } = $props();

  let panel = $state<{ useFont: (key: 'font_body' | 'font_heading' | 'font_mono' | 'font_accent' | 'font_display', stack: string) => void } | undefined>();
  const canvas = () => document.querySelector<HTMLIFrameElement>('iframe[data-xb-canvas]')?.contentDocument ?? null;

  const host: PanelHost = {
    preview: (next) => app.api.previewDesign(next),
    tokens: (next) => app.api.designTokens(next),
    show(css, classesOff) {
      const doc = canvas();
      if (!doc) return;
      hideClasses(doc, classesOff);
      let style = doc.getElementById('xb-design-live');
      if (!css) {
        style?.remove();
        return;
      }
      if (!style) {
        style = doc.createElement('style');
        style.id = 'xb-design-live';
        doc.head.append(style);
      }
      // Server-built CSS from validated values; set as text, never parsed as markup.
      style.textContent = css;
    },
    // The builder has --xb-* variables of its own: the swatches take the canvas's values.
    read(names) {
      const doc = canvas();
      const win = doc?.defaultView;
      if (!doc || !win) return {};
      const root = win.getComputedStyle(doc.documentElement);
      return Object.fromEntries(names.map((name) => [name, root.getPropertyValue(`--${name}`).trim()]));
    },
  };

  /** A font chosen in the fonts section (E2): previewed like a value typed here. */
  export function useFont(key: 'font_body' | 'font_heading' | 'font_mono' | 'font_accent' | 'font_display', stack: string) {
    panel?.useFont(key, stack);
  }

  /** The canvas back to what is saved (after a save or a reset). */
  export function clearPreview() {
    host.show('');
  }
</script>

<details class="gen" open>
  <summary><strong>{t('Generatore Histeon CSS')}</strong> <span>{t('palette, scale e forme da pochi valori')}</span></summary>
  <HistosCssPanel bind:this={panel} {host} bind:design {defaults} bind:contrast {onsite} />
  <p class="foot">{t('Le modifiche si vedono subito nella tela; «Salva in sviluppo» le tiene.')}</p>
</details>

<style>
  .gen { border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); padding: 10px 12px; }
  summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
  summary span { color: var(--xb-muted); font-size: 12px; }
  .foot { margin: 10px 0 0; color: var(--xb-muted); font-size: 12px; }
</style>
