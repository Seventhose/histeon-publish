// The Histeon CSS drawer (docs/spec/histos-css.md §6): built on its own (vite.histos-css.config.ts) into
// plugin/assets/builder/histos-css/panel.js, loaded by Histeon and by the standalone plugin on any page for users
// who can build. It lives in a shadow root, so the page's styles and the panel's never meet; the panel's own CSS
// is injected there by Svelte. Opened from the admin bar, with Alt+Shift+H or with #xb-histos-css in the address.

import { mount } from 'svelte';
import { setCatalog } from '../lib/i18n.ts';
import { hideClasses } from './hideClasses.ts';
import Drawer from './Drawer.svelte';
import type { DrawerConfig, PanelHost } from './host.ts';

/** The English texts of the panel, picked from editor/i18n/en at build time. */
declare const __HISTOS_CSS_EN__: Record<string, string>;

(() => {
  const config = (window as { XBHistosCss?: DrawerConfig }).XBHistosCss;
  if (!config || !document.body || typeof document.body.attachShadow !== 'function') return;
  if (config.english) setCatalog(__HISTOS_CSS_EN__);

  // On the page: the preview of the tokens, as server-built CSS from validated values (text, never markup).
  const pageStyle = document.createElement('style');
  pageStyle.id = 'xb-histos-css-preview';

  let drawer: { toggle: (force?: boolean) => void; isOpen: () => boolean; hasChanges: () => boolean } | null = null;
  let probe: HTMLElement | null = null;
  let probeStyle: HTMLStyleElement | null = null;

  // In the shadow root, the tokens the swatches show: the defaults and the preview on a hidden probe, so the panel
  // reads them in the admin too, where the site's stylesheet is not loaded, and never mixes them with its own.
  const host: Pick<PanelHost, 'show' | 'read'> = {
    show(css, classesOff) {
      hideClasses(document, classesOff);
      pageStyle.textContent = css;
      if (css && !pageStyle.isConnected) document.head.appendChild(pageStyle);
      if (probeStyle) probeStyle.textContent = css.replace(/^:root\{/, '.probe{');
    },
    read(names) {
      if (!probe) return {};
      const style = getComputedStyle(probe);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]));
    },
  };

  function build() {
    const element = document.createElement('div');
    element.id = 'xb-histos-css';
    document.body.appendChild(element);
    const root = element.attachShadow({ mode: 'open' });
    const tokens = document.createElement('style');
    probeStyle = document.createElement('style');
    probe = document.createElement('div');
    probe.className = 'probe';
    probe.hidden = true;
    const target = document.createElement('div');
    root.append(tokens, probeStyle, probe, target);
    fetch(config!.tokensCss, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((css) => {
        tokens.textContent = css.replace(/:root\s*\{/g, '.probe{');
      })
      .catch(() => {});
    drawer = mount(Drawer, { target, props: { config: config!, host } }) as typeof drawer;
  }

  function toggle(force?: boolean) {
    if (!drawer) build();
    drawer?.toggle(force);
  }

  document.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('#wp-admin-bar-xb-histos-css a') : null;
    if (link) {
      e.preventDefault();
      toggle();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyH') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && drawer?.isOpen()) toggle(false);
  });
  window.addEventListener('beforeunload', (e) => {
    if (drawer?.hasChanges()) e.preventDefault();
  });
  if (location.hash === '#xb-histos-css') toggle(true);
})();
