import { config, CssTab, HtmlTab, JsTab } from './inspector.ts';
import { __, h, useEffect, useRef, useState, wp, type GutenbergBlock } from './wp.ts';
import { holdPointer } from '../lib/pointerHold.ts';

// The code of the selected XB block under Gutenberg's canvas, as in the builder: HTML, CSS and JS side by side,
// resizable from the top edge, collapsible to its bar and expandable; one column can take the whole width.
// A text shows its element (the smallest piece that reads back on its own), as the builder's HTML panel does.

type Column = 'html' | 'css' | 'js';
interface DockState {
  height: number;
  open: boolean;
  wide: Column | null;
}
const KEY = 'xb-gutenberg-dock';

function load(): DockState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DockState> | null;
    const height = typeof raw?.height === 'number' && Number.isFinite(raw.height) ? Math.min(Math.max(raw.height, 160), 2000) : 300;
    const wide = raw?.wide === 'html' || raw?.wide === 'css' || raw?.wide === 'js' ? raw.wide : null;
    return { height, open: raw?.open !== false, wide };
  } catch {
    return { height: 300, open: true, wide: null };
  }
}

interface Store {
  getSelectedBlockClientId: () => string | null;
  getBlock: (id: string) => GutenbergBlock | null;
  getBlockParents: (id: string, ascending?: boolean) => string[];
  getBlocks: () => GutenbergBlock[];
}

/** The selected XB block, or the element around a selected text. */
function useTarget(): { block: GutenbergBlock | null; hasXb: boolean } {
  return wp.data.useSelect((select: (s: string) => Store) => {
    const store = select('core/block-editor');
    const hasXb = store.getBlocks().some((b) => b.name.startsWith('xb/'));
    const id = store.getSelectedBlockClientId();
    let block = id ? store.getBlock(id) : null;
    if (block && !block.name.startsWith('xb/')) block = null;
    if (block && (block.name === 'xb/text' || block.name === 'xb/branch' || block.name === 'xb/slot-fill')) {
      const parent = store.getBlockParents(block.clientId, true)[0];
      block = parent ? store.getBlock(parent) : block;
    }
    return { block, hasXb };
  }, []);
}

function Dock() {
  const [state, setState] = useState<DockState>(load);
  const { block, hasXb } = useTarget();
  const max = typeof window !== 'undefined' ? Math.round(window.innerHeight * 0.75) : 600;
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Not remembered: fine.
    }
  }, [state.height, state.open, state.wide]);
  if (!hasXb) return null;

  // Only while the button is held on the edge (lib/pointerHold.ts); Esc puts back the height it had.
  const startResize = (event: { nativeEvent: PointerEvent; currentTarget: HTMLElement }) => {
    const startY = event.nativeEvent.clientY;
    const startH = state.height;
    const setHeight = (height: number) => setState((s) => ({ ...s, open: true, height: Math.min(max, Math.max(160, height)) }));
    holdPointer(event.nativeEvent, { cursor: 'row-resize', move: (e) => setHeight(startH + startY - e.clientY), cancel: () => setHeight(startH) }, event.currentTarget);
  };
  const resizeKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 50 : 10;
    const height = event.key === 'ArrowUp' ? state.height + step : event.key === 'ArrowDown' ? state.height - step : event.key === 'Home' ? 160 : event.key === 'End' ? max : null;
    if (height === null) return;
    event.preventDefault();
    setState((s) => ({ ...s, height: Math.min(max, Math.max(160, height)) }));
  };
  const expanded = state.height >= max - 4;
  const label = block ? (block.attributes.label as string | undefined) || (block.name === 'xb/element' ? `<${String(block.attributes.tag)}>` : block.name.slice(3)) : __('nessun blocco Histeon selezionato');
  const column = (id: Column, title: string, body: unknown) =>
    h(
      'div',
      { key: id, role: 'region', className: 'xb-dock-col' + (state.wide && state.wide !== id ? ' is-hidden' : ''), 'aria-label': title },
      h(
        'div',
        { className: 'xb-dock-head' },
        h('strong', null, title),
        h('button', { type: 'button', onClick: () => setState((s) => ({ ...s, wide: s.wide === id ? null : id })), title: state.wide === id ? __('Riduci') : __('Allarga'), 'aria-label': state.wide === id ? __('Riduci {0}', title) : __('Allarga {0}', title) }, state.wide === id ? '⤡' : '⤢'),
      ),
      h('div', { className: 'xb-dock-body' }, body),
    );

  return h(
    'div',
    { className: 'xb-dock' + (state.open ? '' : ' is-closed'), style: state.open ? { height: `${state.height}px` } : undefined },
    state.open
      ? h('div', { className: 'xb-dock-resize', role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-label': __('Altezza del codice Histeon'), 'aria-valuenow': state.height, 'aria-valuemin': 160, 'aria-valuemax': max, 'aria-valuetext': `${state.height} px`, onPointerDown: startResize, onKeyDown: resizeKey })
      : null,
    h(
      'div',
      { className: 'xb-dock-bar' },
      h('button', { type: 'button', className: 'xb-dock-toggle', onClick: () => setState((s) => ({ ...s, open: !s.open })), 'aria-expanded': state.open }, (state.open ? '▾ ' : '▸ ') + 'Histeon · ' + __('Codice')),
      h('span', { className: 'xb-dock-what' }, label),
      h('span', { className: 'xb-dock-grow' }),
      h('button', { type: 'button', onClick: openBuilder, title: __('Apre il builder sopra Gutenberg') }, '↗ ' + __('Apri in Histeon')),
      config ? h('a', { className: 'xb-dock-link', href: config.historyUrl, target: '_blank', rel: 'noopener', title: __('Versioni di questa pagina, con confronto e ripristino') }, '⟲ ' + __('Versioni')) : null,
      state.open
        ? h('button', { type: 'button', onClick: () => setState((s) => ({ ...s, height: expanded ? 300 : max })), title: expanded ? __('Riduci') : __('Espandi') }, expanded ? '⇲ ' + __('Riduci') : '⇱ ' + __('Espandi'))
        : null,
    ),
    state.open
      ? h(
          'div',
          { className: 'xb-dock-cols' },
          column('html', 'HTML', block ? h(HtmlTab, { block, fill: true, key: block.clientId }) : h('p', { className: 'xb-insp-note' }, __('Seleziona un blocco Histeon nella pagina.'))),
          column('css', 'CSS', block ? h(CssTab, { block, key: block.clientId }) : h('p', { className: 'xb-insp-note' }, __('Seleziona un elemento per vederne il CSS.'))),
          column('js', 'JavaScript', h(JsTab, { fill: true })),
        )
      : null,
  );
}

/** The builder over the editor, through the header button that launch.js adds (it saves Gutenberg first). */
export function openBuilder(): void {
  const button = document.querySelector<HTMLButtonElement>('.xb-launch-button');
  if (button) button.click();
  else if (config) window.location.href = config.builderUrl;
}

/** Puts the dock between the canvas and the meta boxes, and keeps it there when Gutenberg re-renders. */
function DockPortal() {
  const host = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'xb-dock-host';
    host.current = el;
    const place = () => {
      const content = document.querySelector('.interface-interface-skeleton__content');
      if (!content || el.parentElement === content) return;
      const boxes = content.querySelector(':scope > .edit-post-meta-boxes-main');
      content.insertBefore(el, boxes);
    };
    place();
    setReady(true);
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      el.remove();
    };
  }, []);
  return ready && host.current ? wp.element.createPortal(h(Dock, null), host.current) : null;
}

/** The page in XB, in Gutenberg's document sidebar: online or with changes to publish, and the ways out. */
function DocumentPanel() {
  const Panel = wp.editor?.PluginDocumentSettingPanel ?? wp.editPost?.PluginDocumentSettingPanel;
  if (!Panel || !config) return null;
  return h(
    Panel,
    { name: 'xb-document', title: 'Histeon', className: 'xb-doc-panel' },
    h(
      'p',
      { className: 'xb-doc-status' },
      h('span', { className: 'xb-doc-pill ' + (config.pending ? 'is-dev' : 'is-live') }, config.pending ? __('Modifiche Histeon da pubblicare') : __('Online')),
      config.release ? h('span', { className: 'xb-insp-note' }, ' ' + __('release v{0}', config.release)) : null,
    ),
    config.pending ? h('p', { className: 'xb-insp-note' }, __('Le modifiche salvate nel builder compaiono qui e sul sito dopo la pubblicazione.')) : null,
    h(
      'div',
      { className: 'xb-doc-actions' },
      h(wp.components.Button, { variant: 'primary', onClick: openBuilder }, __('Apri in Histeon')),
      h(wp.components.Button, { variant: 'secondary', href: config.historyUrl, target: '_blank' }, __('Versioni')),
      config.pending ? h(wp.components.Button, { variant: 'tertiary', href: config.releasesUrl, target: '_blank' }, __('Pubblica…')) : null,
    ),
  );
}

export function registerDock(): void {
  wp.plugins.registerPlugin('xb-code-dock', { render: DockPortal });
  wp.plugins.registerPlugin('xb-document', { render: DocumentPanel });
}
