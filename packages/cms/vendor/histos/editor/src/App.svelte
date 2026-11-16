<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Topbar from './components/Topbar.svelte';
  import Structure from './components/Structure.svelte';
  import Canvas from './components/Canvas.svelte';
  import HtmlPanel from './components/HtmlPanel.svelte';
  import CssPanel from './components/CssPanel.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import JsPanel from './components/JsPanel.svelte';
  import RecipesPanel from './components/RecipesPanel.svelte';
  import ShortcutsDialog from './components/ShortcutsDialog.svelte';
  import Icon, { type IconName } from './components/Icon.svelte';
  import PreviewMode from './components/PreviewMode.svelte';
  import ChecksPanel from './components/ChecksPanel.svelte';
  import { runChecks, type Finding } from './lib/checks.ts';
  import { cssFindings, lintContext } from './lib/cssLint.ts';
  import ConnectorPanel from './components/ConnectorPanel.svelte';
  import { ConnectorClient, SCOPE_LABELS } from './lib/connector.svelte.ts';
  import { MediaLibrary } from './lib/mediaLibrary.ts';
  import { sectionInstructions, type TaskContext } from './lib/aiTasks.svelte.ts';
  import { activate, bindingsFor, comboOf, DEFAULTS, display, keymap, SCOPES, type Overrides } from './lib/shortcuts.ts';
  import { setKeys, withKeys } from './lib/keys.svelte.ts';
  import CommandPalette from './components/CommandPalette.svelte';
  import MediaPicker from './components/MediaPicker.svelte';
  import FormEditor from './components/FormEditor.svelte';
  import Panel from './components/Panel.svelte';
  import InsertMenu from './components/InsertMenu.svelte';
  import SvgDialog from './components/SvgDialog.svelte';
  import VideoDialog from './components/VideoDialog.svelte';
  import IconDialog from './components/IconDialog.svelte';
  import ReplaceDialog from './components/ReplaceDialog.svelte';
  import MapDialog from './components/MapDialog.svelte';
  import PasteDialog from './components/PasteDialog.svelte';
  import Tour, { type TourStep } from './components/Tour.svelte';
  import AgentBanner from './components/AgentBanner.svelte';
  import { htmlToBlocks, makeClip, readClip, type Clip } from './lib/clip.ts';
  import { copiedHere, rememberCopy, restrictPaste } from './lib/pasteTrust.ts';
  import { createApi } from './lib/publicApi.ts';
  import { formatAt, inScheduled, type ScheduledView } from './lib/schedule.ts';
  import { DEFAULT_LAYOUT, PANEL_TITLES, areaOf, movePanel, normalize, resize, shareBetween, shiftPanel, sizeLimits, toggleCollapsed, type Area, type Layout, type PanelId } from './lib/layout.ts';
  import { holdPointer } from './lib/pointerHold.ts';
  import { randomUid } from '@xb/dsl';
  import { parse, print, refToTag, childrenOf, type XbBlock } from '@xb/dsl';
  import { SNIPPETS } from './lib/snippets.ts';
  import { canUnwrap, describe, hasPostContent, staticClasses, staticId } from './lib/tree.ts';
  import { inlineTarget } from './lib/inlineText.ts';
  import type { Command } from './lib/palette.ts';
  import { Api } from './lib/api.ts';
  import { BuilderState } from './lib/state.svelte.ts';
  import type { BuilderConfig } from './lib/config.ts';
  import { t, tn, tx } from './lib/i18n.ts';

  let { config }: { config: BuilderConfig } = $props();

  /**
   * The sections over the canvas, loaded the first time they open (lista migliorie V7): the builder starts without
   * their code. They are ES modules next to builder.js, imported by it, so they run under the page's nonce like it.
   */
  const SECTION_MODULES = {
    ContentSection: () => import('./components/sections/ContentSection.svelte'),
    TemplatesSection: () => import('./components/sections/TemplatesSection.svelte'),
    SelectorsPanel: () => import('./components/SelectorsPanel.svelte'),
    QueryPanel: () => import('./components/QueryPanel.svelte'),
    FacetsPanel: () => import('./components/FacetsPanel.svelte'),
    ContentHubPanel: () => import('./components/ContentHubPanel.svelte'),
    LibrarySection: () => import('./components/sections/LibrarySection.svelte'),
    HistoryPanel: () => import('./components/HistoryPanel.svelte'),
    SourcePanel: () => import('./components/SourcePanel.svelte'),
    DesignPanel: () => import('./components/DesignPanel.svelte'),
    CommentsPanel: () => import('./components/CommentsPanel.svelte'),
    AltTable: () => import('./components/AltTable.svelte'),
    ComponentPanel: () => import('./components/ComponentPanel.svelte'),
  };
  type SectionModule = keyof typeof SECTION_MODULES;
  const loadedSections = new Map<SectionModule, Promise<{ default: unknown }>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sectionModule(name: SectionModule): Promise<{ default: any }> {
    let loading = loadedSections.get(name);
    if (!loading) {
      loading = SECTION_MODULES[name]().catch((e: unknown) => {
        loadedSections.delete(name); // Try again next time it opens.
        throw e;
      });
      loadedSections.set(name, loading);
    }
    return loading;
  }

  // The configuration is fixed for the life of the page.
  const app = untrack(() => new BuilderState(new Api(config), config.postId, config.contentOnly, config.contentProps, { viewOnly: config.viewOnly, lookGroups: config.lookGroups }));
  /** Section shown over the canvas (null: the canvas). */
  type Section = 'content' | 'templates' | 'styles' | 'queries' | 'facets' | 'fields' | 'components' | 'history' | 'source' | 'checks' | 'design' | 'comments' | 'schema' | 'library' | 'alts';
  type ThemeChoice = 'system' | 'light' | 'dark';
  let section = $state<Section | null>(null);
  /** Where the panels sit (lib/layout.ts), remembered in this browser. */
  let layout = $state<Layout>(loadLayout());
  /** The panel shown alone in its area, if any. */
  const maximized = $derived(layout.maximized);
  /** The maximized panel is part of the layout: it stays maximized across visits (L4). */
  function setMaximized(id: PanelId | null) {
    if (layout.maximized !== id) layout = { ...layout, maximized: id };
  }
  /** Panel being dragged, and where it would land. */
  let dragging = $state<PanelId | null>(null);
  let dropAt = $state<{ area: Area; index: number } | null>(null);
  /** The theme chosen in this browser; 'system' follows the computer (light by day, dark by night). */
  let themeChoice = $state<ThemeChoice>(loadTheme());
  let systemDark = $state(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const theme = $derived<'light' | 'dark'>(themeChoice === 'system' ? (systemDark ? 'dark' : 'light') : themeChoice);

  function loadLayout(): Layout {
    // Client mode: the page, its structure and the selected element; no code panels.
    if (config.contentOnly) return { ...normalize(null), areas: { left: [], right: ['structure', 'properties'], bottom: [] }, sizes: { ...normalize(null).sizes, bottom: 0 } };
    try {
      const raw = localStorage.getItem('xb-layout');
      if (raw) return normalize(JSON.parse(raw));
      // Earlier versions kept only the height of the code panels.
      const dock = Number(localStorage.getItem('xb-dock') ?? NaN);
      return Number.isFinite(dock) ? resize(normalize(null), 'bottom', dock) : normalize(null);
    } catch {
      return normalize(null);
    }
  }
  function loadTheme(): ThemeChoice {
    try {
      const v = localStorage.getItem('xb-theme');
      if (v === 'light' || v === 'dark') return v;
    } catch {
      // Private mode: follow the system.
    }
    return 'system';
  }
  /** Only a choice made here is remembered: without one, the theme keeps following the system. */
  function chooseTheme(choice: ThemeChoice) {
    themeChoice = choice;
    try {
      if (choice === 'system') localStorage.removeItem('xb-theme');
      else localStorage.setItem('xb-theme', choice);
    } catch {
      // Not persisted: fine.
    }
  }
  const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
  const THEME_LABEL: Record<ThemeChoice, string> = { system: t('Tema come il sistema'), light: t('Tema chiaro'), dark: t('Tema scuro') };
  $effect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const follow = (e: MediaQueryListEvent) => (systemDark = e.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  });
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });
  $effect(() => {
    const value = JSON.stringify(layout);
    // Client mode has its own fixed layout: the person's usual one stays as it was.
    if (config.contentOnly) return;
    try {
      localStorage.setItem('xb-layout', value);
    } catch {
      // Not persisted: fine.
    }
  });

  /**
   * Dragging the edge of an area: the bottom one's top edge, the side ones' inner edge. Only while the button is
   * held on the edge (lib/pointerHold.ts); Esc puts back the size it had.
   */
  function startResize(area: Area, event: PointerEvent) {
    const box = (event.currentTarget as HTMLElement).parentElement as HTMLElement;
    const before = layout.sizes[area];
    // By how much the pointer moved, not where it is: the edge takes the pointer a few pixels around its line.
    const { clientX: x0, clientY: y0 } = event;
    holdPointer(event, {
      cursor: area === 'bottom' ? 'row-resize' : 'col-resize',
      move: (e) => {
        const value = area === 'bottom' ? Math.min(box.getBoundingClientRect().height - 120, before + y0 - e.clientY) : area === 'left' ? before + e.clientX - x0 : before + x0 - e.clientX;
        layout = resize(layout, area, value);
      },
      cancel: () => (layout = resize(layout, area, before)),
    });
  }
  /**
   * The separator between two panels of an area (L4): how much of their shared space each takes, by pointer or
   * keyboard (WAI-ARIA window splitter, like the area edges). Esc during a drag puts it back.
   */
  function pairSizes(box: HTMLElement, area: Area, a: PanelId, b: PanelId): [number, number] {
    const size = (id: PanelId) => {
      const r = box.querySelector<HTMLElement>(`:scope > .slot[data-id="${id}"]`)?.getBoundingClientRect();
      return r ? (area === 'bottom' ? r.width : r.height) : 0;
    };
    return [size(a), size(b)];
  }
  function startSplit(area: Area, a: PanelId, b: PanelId, event: PointerEvent) {
    const box = (event.currentTarget as HTMLElement).parentElement as HTMLElement;
    const [sa, sb] = pairSizes(box, area, a, b);
    const before = layout;
    const { clientX: x0, clientY: y0 } = event;
    holdPointer(event, {
      cursor: area === 'bottom' ? 'col-resize' : 'row-resize',
      move: (e) => (layout = shareBetween(before, a, b, sa + (area === 'bottom' ? e.clientX - x0 : e.clientY - y0), sa + sb)),
      cancel: () => (layout = before),
    });
  }
  function splitKey(area: Area, a: PanelId, b: PanelId, event: KeyboardEvent) {
    const box = (event.currentTarget as HTMLElement).parentElement as HTMLElement;
    const [sa, sb] = pairSizes(box, area, a, b);
    const step = event.shiftKey ? 64 : 16;
    const moves: Record<string, number> = area === 'bottom' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
    let next: number;
    if (moves[event.key] !== undefined) next = sa + (moves[event.key] as number);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sa + sb;
    else return;
    event.preventDefault();
    layout = shareBetween(layout, a, b, next, sa + sb);
  }
  const shareOf = (a: PanelId, b: PanelId) => Math.round((100 * (layout.weights[a] ?? 1)) / ((layout.weights[a] ?? 1) + (layout.weights[b] ?? 1)));

  /** The largest size `area` can take now: the bottom one leaves the canvas its 120px. */
  function maxSize(area: Area, edge: HTMLElement): number {
    const max = sizeLimits(area)[1];
    return area === 'bottom' ? Math.min(max, Math.round((edge.parentElement as HTMLElement).getBoundingClientRect().height - 126)) : max;
  }
  /**
   * The same edges from the keyboard (WAI-ARIA window splitter): arrows move the edge by 10px (Shift: 50px), Home
   * and End go to the smallest and largest size. The bottom area stays visible: hiding it is the rail's button.
   */
  function resizeKey(area: Area, event: KeyboardEvent) {
    const edge = event.currentTarget as HTMLElement;
    const grow: Record<string, number> = area === 'bottom' ? { ArrowUp: 1, ArrowDown: -1 } : area === 'left' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowLeft: 1, ArrowRight: -1 };
    const min = area === 'bottom' ? 60 : sizeLimits(area)[0];
    const max = maxSize(area, edge);
    const now = layout.sizes[area];
    const sign = grow[event.key];
    let value: number;
    if (sign) value = now + sign * (event.shiftKey ? 50 : 10);
    else if (event.key === 'Home') value = min;
    else if (event.key === 'End') value = max;
    else return;
    event.preventDefault();
    layout = resize(layout, area, Math.min(max, Math.max(min, value)));
  }

  const SECTIONS: Array<{ id: Section; label: string; icon: IconName }> = [
    { id: 'content', label: t('Contenuti'), icon: 'content' },
    { id: 'templates', label: t('Template'), icon: 'templates' },
    { id: 'styles', label: t('Stili e selettori'), icon: 'styles' },
    { id: 'queries', label: t('Dati e query'), icon: 'queries' },
    { id: 'facets', label: t('Filtri dei loop'), icon: 'facets' },
    { id: 'fields', label: t('Tipi e campi'), icon: 'fields' },
    { id: 'components', label: t('Componenti'), icon: 'components' },
    { id: 'library', label: t('Libreria'), icon: 'library' },
    { id: 'history', label: t('Versioni'), icon: 'history' },
    { id: 'source', label: t('File unico'), icon: 'file' },
    { id: 'checks', label: t('Controlli'), icon: 'check' },
    { id: 'design', label: t('Design system'), icon: 'palette' },
    { id: 'comments', label: t('Commenti'), icon: 'chat' },
  ].filter((s) => !config.contentOnly || s.id === 'checks') as Array<{ id: Section; label: string; icon: IconName }>;
  function toggle(id: Section) {
    section = section === id ? null : id;
  }
  // The section over the canvas takes the focus when it opens and gives it back when it closes; what it covers
  // (canvas and bottom panels) is inert meanwhile, so Tab does not wander behind it (A4).
  let sectionHeading = $state<HTMLElement>();
  let sectionOpener: HTMLElement | null = null;
  let shownSection: Section | null = null;
  $effect(() => {
    const now = section;
    untrack(() => {
      if (now && !shownSection) {
        sectionOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        void tick().then(() => sectionHeading?.focus());
      } else if (!now && shownSection) {
        const lost = !document.activeElement || document.activeElement === document.body;
        if (lost && sectionOpener?.isConnected) sectionOpener.focus();
        sectionOpener = null;
      }
      shownSection = now;
    });
  });

  // ---- panels
  type PanelAction = { kind: 'move'; area: Area } | { kind: 'shift'; delta: -1 | 1 } | { kind: 'collapse' } | { kind: 'maximize' } | { kind: 'reset' };
  function act(id: PanelId, action: PanelAction) {
    if (action.kind === 'move') layout = movePanel(layout, id, action.area, layout.areas[action.area].length);
    else if (action.kind === 'shift') layout = shiftPanel(layout, id, action.delta);
    else if (action.kind === 'collapse') layout = toggleCollapsed(layout, id);
    else if (action.kind === 'maximize') setMaximized(maximized === id ? null : id);
    else resetLayout();
    if (action.kind !== 'maximize' && maximized === id) setMaximized(null);
  }

  // «Ripristina la disposizione» asks nothing, but can be undone for a few seconds (L5).
  let layoutBefore = $state<Layout | null>(null);
  let layoutUndoTimer: ReturnType<typeof setTimeout> | undefined;
  function resetLayout() {
    layoutBefore = layout;
    layout = normalize(null);
    clearTimeout(layoutUndoTimer);
    layoutUndoTimer = setTimeout(() => (layoutBefore = null), 10_000);
  }
  function undoLayoutReset() {
    if (layoutBefore) layout = layoutBefore;
    layoutBefore = null;
    clearTimeout(layoutUndoTimer);
  }

  /** Shows a panel wherever it is: expanded, not hidden behind a maximized one, its area open. */
  function reveal(id: PanelId) {
    if (layout.collapsed.includes(id)) layout = toggleCollapsed(layout, id);
    const area = areaOf(layout, id);
    if (maximized && maximized !== id && layout.areas[area].includes(maximized)) setMaximized(null);
    if (area === 'bottom' && layout.sizes.bottom === 0) layout = resize(layout, 'bottom', DEFAULT_LAYOUT.sizes.bottom);
  }
  // Text the canvas could not take goes to the HTML panel (U2): the panel must be there to receive it.
  $effect(() => {
    if (app.htmlDraft) untrack(() => reveal('html'));
  });

  /** Where a dragged panel would land in `area`: before the first panel whose middle is past the pointer. */
  function dropIndex(area: Area, box: HTMLElement, event: { clientX: number; clientY: number }): number {
    const others = [...box.querySelectorAll<HTMLElement>(':scope > .slot')].filter((el) => el.dataset.id !== dragging);
    const at = others.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return area === 'bottom' ? event.clientX < r.left + r.width / 2 : event.clientY < r.top + r.height / 2;
    });
    return at < 0 ? others.length : at;
  }
  /**
   * A panel dragged by touch or pen from its grip (L3): the same drop marks and the same move as with the mouse, with
   * pointer events (lib/pointerHold.ts). The area under the finger is the target; Esc or a cancelled touch moves nothing.
   */
  function touchPanelDrag(id: PanelId, event: PointerEvent) {
    event.preventDefault();
    dragging = id;
    holdPointer(
      event,
      {
        cursor: 'grabbing',
        move: (e) => {
          const box = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.area');
          const area = box ? (['left', 'right', 'bottom'] as Area[]).find((a) => box.classList.contains(`area-${a}`)) : undefined;
          dropAt = box && area ? { area, index: dropIndex(area, box, e) } : null;
        },
        end: () => {
          if (dragging && dropAt) {
            layout = movePanel(layout, dragging, dropAt.area, dropAt.index);
            if (maximized === dragging) setMaximized(null);
          }
          endDrag();
        },
        cancel: endDrag,
      },
      event.currentTarget as HTMLElement,
    );
  }
  function overArea(area: Area, event: DragEvent) {
    if (!dragging || !event.dataTransfer?.types.includes('application/x-xb-panel')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const index = dropIndex(area, event.currentTarget as HTMLElement, event);
    if (dropAt?.area !== area || dropAt.index !== index) dropAt = { area, index };
  }
  function dropOnArea(area: Area, event: DragEvent) {
    if (!dragging) return;
    event.preventDefault();
    layout = movePanel(layout, dragging, area, dropIndex(area, event.currentTarget as HTMLElement, event));
    if (maximized === dragging) setMaximized(null);
    endDrag();
  }
  function endDrag() {
    dragging = null;
    dropAt = null;
  }
  // While a panel is dragged the browser sends no pointer events: one with the button up, or a new press, means
  // the drag ended where the page did not hear it (no dragend), so nothing may stay attached to the pointer.
  $effect(() => {
    if (!dragging) return;
    const stale = (event: PointerEvent) => {
      if (event.type === 'pointerdown' || (event.buttons & 1) === 0) endDrag();
    };
    window.addEventListener('pointermove', stale, true);
    window.addEventListener('pointerdown', stale, true);
    return () => {
      window.removeEventListener('pointermove', stale, true);
      window.removeEventListener('pointerdown', stale, true);
    };
  });
  const showArea = (area: Area) => layout.areas[area].length > 0 || dragging !== null;

  // Narrow screens (L1, L2): under 1024 px the side columns become drawers over the canvas, opened from the rail;
  // under 768 px the builder says it needs a wider screen (client mode works on a phone).
  const narrowQuery = window.matchMedia?.('(max-width: 1023px)');
  const tinyQuery = window.matchMedia?.('(max-width: 767px)');
  let narrow = $state(narrowQuery?.matches ?? false);
  let tiny = $state(tinyQuery?.matches ?? false);
  let drawerOpen = $state(false);
  let tinyDismissed = $state(readTinyDismissed());
  function readTinyDismissed(): boolean {
    try {
      return sessionStorage.getItem('xb-narrow-ok') === '1';
    } catch {
      return false;
    }
  }
  function dismissTiny() {
    tinyDismissed = true;
    try {
      sessionStorage.setItem('xb-narrow-ok', '1');
    } catch {
      /* this time only */
    }
  }
  $effect(() => {
    const follow = () => {
      narrow = narrowQuery?.matches ?? false;
      tiny = tinyQuery?.matches ?? false;
      if (!narrow) drawerOpen = false;
    };
    narrowQuery?.addEventListener('change', follow);
    tinyQuery?.addEventListener('change', follow);
    return () => {
      narrowQuery?.removeEventListener('change', follow);
      tinyQuery?.removeEventListener('change', follow);
    };
  });
  const bottomSize = $derived(layout.areas.bottom.length === 0 ? (dragging ? 64 : 0) : dragging && layout.sizes.bottom === 0 ? 64 : layout.sizes.bottom);
  /** The HTML panel can be seen: not behind a maximized neighbour, its area open and not covered by a section. */
  const htmlVisible = $derived.by(() => {
    const area = areaOf(layout, 'html');
    if (layout.maximized && layout.maximized !== 'html' && layout.areas[area].includes(layout.maximized)) return false;
    return area !== 'bottom' || (bottomSize > 0 && section === null);
  });

  let insertMenu: InsertMenu;
  let svgDialog: SvgDialog;
  let videoDialog: VideoDialog;
  let iconDialog: IconDialog | undefined = $state();
  let replaceDialog: ReplaceDialog;
  let mapDialog: MapDialog;
  let pasteDialog: PasteDialog;
  // "Incolla qui" from the structure's context menu: the clip goes through the same paste dialog as Ctrl+V.
  $effect(() => {
    const request = app.pasteRequest;
    if (!request) return;
    untrack(() => {
      app.pasteRequest = null;
      if (request.at) app.select(request.at);
      void pasteDialog.open(request.clip, request.trusted);
    });
  });
  /** Opens the "+" popup next to the button that asked (or the top bar's, from the keyboard). */
  function openInsert(anchor?: HTMLElement | null) {
    void insertMenu.open(anchor ?? document.querySelector<HTMLElement>('[data-insert-anchor]'));
  }

  // The framework's dashboard (Core Framework, ACSS) in a side panel over the canvas, shown and hidden with its
  // button: only the framework's app, without the WordPress admin (BuilderScreen::framed_dashboard). It stays
  // loaded while hidden, so it reopens where it was; hiding it reloads classes, variables and stylesheets.
  let fwOpen = $state(false);
  let fwLoaded = $state(false);
  let fwWidth = $state(untrack(() => readFwWidth()));
  function readFwWidth(): number {
    try {
      return Math.min(1400, Math.max(360, Number(localStorage.getItem('xb-fw-width')) || 620));
    } catch {
      return 620;
    }
  }
  function toggleFramework() {
    fwOpen = !fwOpen;
    if (fwOpen) fwLoaded = true;
    else void app.reloadFramework();
  }
  function setFwWidth(width: number) {
    fwWidth = Math.min(window.innerWidth - 200, Math.max(360, Math.round(width)));
    try {
      localStorage.setItem('xb-fw-width', String(fwWidth));
    } catch {
      /* ignore */
    }
  }
  function resizeFramework(event: PointerEvent) {
    const startX = event.clientX;
    const start = fwWidth;
    holdPointer(event, {
      cursor: 'col-resize',
      move: (e) => (fwWidth = Math.min(window.innerWidth - 200, Math.max(360, start + startX - e.clientX))),
      end: () => setFwWidth(fwWidth),
      cancel: () => (fwWidth = start),
    });
  }
  function resizeFrameworkKey(event: KeyboardEvent) {
    const step = event.shiftKey ? 50 : 10;
    if (event.key === 'ArrowLeft') setFwWidth(fwWidth + step);
    else if (event.key === 'ArrowRight') setFwWidth(fwWidth - step);
    else if (event.key === 'Home') setFwWidth(360);
    else if (event.key === 'End') setFwWidth(window.innerWidth - 200);
    else return;
    event.preventDefault();
  }
  /** The dashboard in a tab of its own, with the WordPress admin around it. */
  const fwTabUrl = $derived.by(() => {
    if (!config.framework) return '';
    const url = new URL(config.framework.url);
    url.searchParams.delete('xb_frame');
    return url.href;
  });
  const frameworkShort = $derived(config.framework?.id === 'acss' ? 'A' : 'CF');

  let palette: CommandPalette;
  let tour: Tour;
  // The first-run tour (lista della spesa 142): the five places a page is made in, in the order one uses them.
  const tourSteps: TourStep[] = [
    { target: '.canvas-area', title: t('La pagina'), text: t('Qui vedi la pagina com’è sul sito. Un clic seleziona un elemento; un doppio clic su un testo lo cambia.') },
    { target: '[data-panel="structure"]', title: t('La struttura'), text: t('Gli elementi della pagina, uno dentro l’altro. Trascinali per spostarli; il + aggiunge un elemento.') },
    { target: '[data-panel="css"]', title: t('Lo stile'), text: t('Con un elemento selezionato, la Mini GUI cambia spazi, colori e testo con un clic, con i valori del design del sito. Sotto vedi il CSS che scrive.') },
    { target: '[data-panel="html"]', title: t('Il codice'), text: t('Lo stesso elemento come HTML: tutto ciò che fai con i pulsanti si vede qui, e qui si può anche scrivere.') },
    { target: '.topbar .primary', title: t('Salvare e pubblicare'), text: t('Ctrl+S salva in sviluppo: il sito non cambia. «Pubblica…» porta online le modifiche, che si possono sempre riportare indietro.') },
  ];
  let media: MediaPicker;
  const pickImage = () => media.pick();
  /** A file of the library for a link (item 176 of Publish's doc 23): its address. */
  const pickFile = () => media.pickFile();
  /** The whole media library from the rail (E1); what is chosen there goes into the page after the selection. */
  async function browseMedia() {
    const chosen = await media.browse();
    if (!chosen) return;
    const children: XbBlock[] = chosen.text ? [{ name: 'xb/text', attrs: { uid: randomUid(), content: chosen.text } }] : [];
    app.insert([{ name: 'xb/element', attrs: { uid: randomUid(), tag: chosen.tag, attributes: chosen.attributes }, children }]);
  }

  // Fluent Forms (docs/spec/fluent-forms.md): its forms in the insert menu, its editor in a dialog.
  let formEditor: FormEditor;
  let fluentInfo: Awaited<ReturnType<typeof app.api.fluentForms>> | null = null;
  async function fluent() {
    fluentInfo ??= await app.api.fluentForms();
    return fluentInfo;
  }
  const forms = untrack(() => config.fluentForms)
    ? {
        list: async () => {
          fluentInfo = null;
          return (await fluent()).forms;
        },
        create: async () => {
          await formEditor.open((await fluent()).newUrl, t('Nuovo modulo Fluent Forms'));
        },
      }
    : undefined;
  async function editForm(id: number) {
    const info = await fluent();
    const title = info.forms.find((f) => f.id === id)?.title ?? t('Modulo {0}', id);
    await formEditor.open(info.editUrl.replace('999999999', String(Math.trunc(id))), t('Modulo: {0}', title));
    void app.refreshPreview(true);
  }

  async function insertImage() {
    const attributes = await pickImage();
    if (attributes) app.insert([{ name: 'xb/element', attrs: { uid: randomUid(), tag: 'img', attributes }, children: [] }]);
  }
  let topbar: Topbar;


  // Keyboard shortcuts (docs/spec/shortcuts.md): the user's changes over the defaults, saved in their profile.
  let shortcuts = $state<Overrides>(untrack(() => config.shortcuts));
  const bound = $derived(keymap(shortcuts));
  $effect(() => {
    activate(bound);
    setKeys(bound);
  });
  const mac = navigator.platform.toLowerCase().includes('mac');
  let shortcutsDialog: ShortcutsDialog;

  /**
   * Everything the palette offers, built when it opens (so it reflects the current page), with the shortcut of
   * each command as its hint. Without `select`, the "select this element" entries are left out (they change
   * with the page, so they take no shortcut).
   */
  function commands(select = true): Command[] {
    const list: Command[] = [];
    list.push({ id: 'save', label: t('Salva in sviluppo'), group: t('Azione'), run: () => void app.save() });
    list.push({ id: 'preview', label: t('Apri l’anteprima'), group: t('Azione'), run: () => void topbar.openPreview() });
    if (config.canPublish) list.push({ id: 'publish', label: t('Pubblica…'), group: t('Azione'), run: () => topbar.openPublish() });
    list.push({ id: 'undo', label: tx('Annulla', 'undo'), group: t('Azione'), run: () => app.undo() });
    list.push({ id: 'redo', label: t('Ripeti'), group: t('Azione'), run: () => app.redo() });
    list.push({ id: 'component', label: t('Nuovo componente…'), group: t('Azione'), run: () => topbar.openNewComponent() });
    list.push({ id: 'tour', label: t('Guida in cinque passi'), group: t('Aiuto'), run: () => tour.start() });
    if (!config.contentOnly) list.push({ id: 'replace', label: t('Cerca e sostituisci nella pagina…'), group: t('Azione'), run: () => replaceDialog.open() });
    if (config.media.url) list.push({ id: 'image', label: t('Inserisci immagine dalla libreria'), group: t('Inserisci'), run: () => void insertImage() });
    if (app.selected) {
      const uid = app.selected;
      // Several selected (E7): the same keys act on all of them.
      const many = app.selection.length > 1;
      list.push({ id: 'dup', label: many ? t('Duplica gli elementi selezionati') : t('Duplica l’elemento selezionato'), group: t('Azione'), run: () => (many ? app.duplicateSelection() : app.duplicate(uid)) });
      list.push({ id: 'del', label: many ? t('Elimina gli elementi selezionati') : t('Elimina l’elemento selezionato'), group: t('Azione'), run: () => (many ? app.removeSelection() : app.remove(uid)) });
      list.push({ id: 'up', label: t('Sposta su'), group: t('Azione'), run: () => (many ? app.moveSelection(-1) : app.move(uid, -1)) });
      list.push({ id: 'down', label: t('Sposta giù'), group: t('Azione'), run: () => (many ? app.moveSelection(1) : app.move(uid, 1)) });
      // The context menu's actions too (U8), so each can have its own keys (docs/spec/shortcuts.md).
      const block = app.find(uid);
      list.push({ id: 'outdent', label: t('Porta fuori dal contenitore'), group: t('Azione'), run: () => app.outdent(uid) });
      list.push({ id: 'indent', label: t('Metti dentro l’elemento prima'), group: t('Azione'), run: () => app.indent(uid) });
      list.push({ id: 'cut', label: t('Taglia l’elemento selezionato'), group: t('Azione'), run: () => void cutSelection() });
      list.push({ id: 'wrap-div', label: t('Avvolgi in un div'), group: t('Azione'), run: () => (many ? app.wrapSelection('div') : app.wrap(uid, 'div')) });
      list.push({ id: 'wrap-section', label: t('Avvolgi in una section'), group: t('Azione'), run: () => (many ? app.wrapSelection('section') : app.wrap(uid, 'section')) });
      list.push({ id: 'wrap-a', label: t('Avvolgi in un link'), group: t('Azione'), run: () => app.wrap(uid, 'a') });
      if (block && canUnwrap(block)) list.push({ id: 'unwrap', label: t('Togli il contenitore'), group: t('Azione'), run: () => app.unwrap(uid) });
      const parent = app.index.parent.get(uid);
      if (parent) list.push({ id: 'parent', label: t('Seleziona il genitore'), group: t('Seleziona'), run: () => app.select(parent.attrs.uid) });
      if (block) list.push({ id: 'copy-html', label: t('Copia HTML'), group: t('Azione'), run: () => void navigator.clipboard.writeText(print([$state.snapshot(block) as XbBlock])) });
      if (block?.name === 'xb/element') list.push({ id: 'make-component', label: t('Crea componente dalla selezione…'), group: t('Azione'), run: () => (app.menuRequest = { uid, view: 'component' }) });
      if (inlineTarget(block ?? null)) list.push({ id: 'edit-text', label: t('Scrivi il testo nella pagina'), group: t('Azione'), run: () => (app.inlineRequest = uid) });
    }
    for (const s of SECTIONS) list.push({ id: `sec-${s.id}`, label: s.label, group: t('Vai a'), run: () => (section = s.id) });
    if (!config.contentOnly) list.push({ id: 'alts', label: t('Testi alternativi della pagina'), group: t('Vai a'), run: () => (section = 'alts') });
    if (config.media.url && !config.contentOnly) list.push({ id: 'media', label: t('Libreria dei media'), group: t('Vai a'), run: () => void browseMedia() });
    for (const choice of ['system', 'light', 'dark'] as const) {
      if (choice !== themeChoice) list.push({ id: `theme-${choice}`, label: THEME_LABEL[choice], group: t('Azione'), run: () => chooseTheme(choice) });
    }
    if (config.framework) list.push({ id: 'framework', label: fwOpen ? t('{0}: nascondi il pannello', config.framework.label) : t('{0}: mostra il pannello', config.framework.label), group: t('Azione'), run: () => toggleFramework() });
    list.push({ id: 'dock', label: layout.sizes.bottom > 0 ? t('Nascondi i pannelli in basso') : t('Mostra i pannelli in basso'), group: t('Azione'), run: () => toggleBottom() });
    list.push({ id: 'insert', label: t('Aggiungi un elemento…'), group: t('Inserisci'), run: () => openInsert() });
    list.push({ id: 'shortcuts', label: t('Scorciatoie da tastiera…'), group: t('Azione'), run: () => shortcutsDialog.open() });
    list.push({ id: 'layout', label: t('Ripristina la disposizione dei pannelli'), group: t('Azione'), run: () => act('structure', { kind: 'reset' }) });
    const go = (url: string) => (config.embed ? window.open(url, '_blank', 'noopener') : (window.location.href = url));
    if (config.admin.overview) list.push({ id: 'adm-overview', label: t('Panoramica di Histeon (amministrazione)'), group: t('Vai a'), run: () => go(config.admin.overview as string) });
    if (config.admin.history) list.push({ id: 'adm-history', label: t('Versioni di questa pagina (amministrazione)'), group: t('Vai a'), run: () => go(config.admin.history as string) });
    if (config.admin.releases) list.push({ id: 'adm-releases', label: t('Release (amministrazione)'), group: t('Vai a'), run: () => go(config.admin.releases as string) });
    for (const id of Object.keys(PANEL_TITLES) as PanelId[]) {
      for (const area of ['left', 'right', 'bottom'] as Area[]) {
        if (!layout.areas[area].includes(id)) list.push({ id: `mv-${id}-${area}`, label: area === 'left' ? t('Sposta {0} a sinistra', PANEL_TITLES[id]) : area === 'right' ? t('Sposta {0} a destra', PANEL_TITLES[id]) : t('Sposta {0} in basso', PANEL_TITLES[id]), group: t('Pannelli'), run: () => act(id, { kind: 'move', area }) });
      }
    }
    for (const snippet of SNIPPETS) {
      list.push({ id: `snip-${snippet.key}`, label: t('Inserisci: {0}', snippet.label), group: t('Inserisci'), run: () => app.insert(parse(snippet.dsl).blocks) });
    }
    for (const component of app.components) {
      list.push({ id: `comp-${component.ref}`, label: `${component.title || component.ref} (${component.ref})`, group: t('Componente'), run: () => app.insert(parse(`<${refToTag(component.ref)} />`).blocks) });
    }
    const walk = (blocks: XbBlock[], depth: number) => {
      for (const block of blocks) {
        if (block.name !== 'xb/text') {
          const uid = block.attrs.uid;
          list.push({ id: `sel-${uid}`, label: `${'· '.repeat(Math.min(depth, 6))}${describe(block)}`, group: t('Seleziona'), run: () => app.select(uid) });
        }
        walk(childrenOf(block), depth + 1);
      }
    };
    if (select) walk(app.tree, 0);
    return list.map((c) => {
      const keys = bindingsFor(c.id, shortcuts);
      return keys.length ? { ...c, hint: display(keys[0]!, mac) } : c;
    });
  }

  /** Every command a shortcut can run: the palette itself, then the palette's commands. */
  function shortcutCommands(): Command[] {
    return [{ id: 'palette', label: t('Apri i comandi'), group: t('Azione'), run: () => void palette.open() }, ...commands(false)];
  }

  // Public JavaScript API (docs/spec/js-api.md): window.xb, with change, select and save events.
  const publicApi = untrack(() => createApi(app, { ...config.environment, locale: config.locale }, config.media.url && config.media.canUpload ? new MediaLibrary(config.media.url, config.restUrl, config.nonce, config.media.encoder, config.media.maxBytes) : null));
  // The Histeon Connector (docs/spec/connector.md): a local AI agent working in this tab, only once the user connects.
  /** The open document, for the requests to the agent (✦ → Chiedi all'agente). */
  function taskContext(): TaskContext {
    const uid = app.selected;
    const block = uid ? app.find(uid) : null;
    const label = block ? describe(block) : '';
    return {
      doc: config.postId,
      title: app.doc?.title ?? config.title,
      framework: app.framework.active.id ? { id: app.framework.active.id, label: app.framework.active.label } : null,
      selection: uid ? { uid, label } : null,
    };
  }
  // Doc 23 of Publish, item 204: a template without the block of the page's content does not travel to Publish (item
  // 190). Said where the template is edited, without stopping anything; parts of templates do not need it.
  const templateWithoutContent = $derived(!!config.template && !config.template.part && app.sessions.length === 0 && app.doc !== null && !hasPostContent(app.tree));
  function addPostContent() {
    app.insert(parse('{@content}').blocks);
    app.status = { kind: 'idle', message: t('Contenuto del post aggiunto: spostalo dove va il testo della pagina, poi salva.') };
  }
  const connector = new ConnectorClient(publicApi.api, () => ({ site: window.location.origin, title: app.doc?.title ?? config.title, doc: config.postId, kind: app.doc?.type ?? '' }), () => config.connectorPair?.secret ?? null);
  connector.scopes = untrack(() => new Set(config.agentScopes.enabled));
  onMount(() => {
    void app.load();
    if (!config.contentOnly) setTimeout(() => tour?.start(true), 1200);
    Object.defineProperty(window, 'xb', { value: publicApi.api, configurable: true });
    return () => delete (window as { xb?: unknown }).xb;
  });
  $effect(() => {
    void app.content;
    untrack(() => publicApi.emit('change', { dirty: app.dirty }));
  });
  $effect(() => {
    const uid = app.selected;
    untrack(() => publicApi.emit('select', { uid }));
  });
  $effect(() => {
    // Every save, from Ctrl+S, the button or the API.
    if (app.status.kind === 'saved') untrack(() => publicApi.emit('save', { message: app.status.message }));
  });

  // Re-render the preview on the server shortly after the content settles; the first one at once (opening the
  // document has nothing to wait for). Older requests in flight are aborted by refreshPreview.
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void app.content;
    void app.sampleSchema;
    void (app.isComponent && JSON.stringify(app.schema));
    if (app.status.kind === 'loading') return;
    clearTimeout(timer);
    if (untrack(() => app.preview) === null) void app.refreshPreview(false);
    else timer = setTimeout(() => void app.refreshPreview(false), 150);
  });

  function toggleBottom() {
    layout = resize(layout, 'bottom', layout.sizes.bottom > 0 ? 0 : 300);
  }

  // Checks of the page as drawn (docs/spec/checks.md): after each new drawing, a moment later (layout done).
  let findings = $state<Finding[]>([]);
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  function recheck() {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-xb-canvas]');
    const d = frame?.contentDocument;
    if (!d?.body) return;
    // With the Checks panel closed only the quick rules run (the rail's error counter): contrast and image sizes,
    // which read styles and layout of the whole page, wait for the panel (V11).
    const quick = section !== 'checks';
    const page = runChecks(d, { page: !app.isComponent && !config.template?.part, source: app.sessions.length ? [] : (config.languages?.source ?? []), quick });
    // The CSS of the selectors this page uses, with the same lint as the CSS panel (lib/cssLint.ts).
    const firstWith = new Map<string, string>();
    for (const block of app.index.block.values()) {
      if (block.name !== 'xb/element') continue;
      for (const cls of staticClasses(block)) if (!firstWith.has(`.${cls}`)) firstWith.set(`.${cls}`, block.attrs.uid);
      const id = staticId(block);
      if (id && !firstWith.has(`#${id}`)) firstWith.set(`#${id}`, block.attrs.uid);
    }
    const context = lintContext(app.framework, app.globals, app.styles, app.queries);
    findings = [...page, ...cssFindings(app.styles, context, (selector) => firstWith.get(selector) ?? null)];
  }
  $effect(() => {
    void app.preview;
    void app.liveCss;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(recheck, 600);
  });
  // Opening the Checks panel runs every rule at once.
  $effect(() => {
    if (section === 'checks') untrack(recheck);
  });
  const errors = $derived(findings.filter((f) => f.severity === 'error').length);
  // Open comments from the preview (docs/spec/review.md), counted on load and whenever the panel reads them.
  let openComments = $state(0);
  $effect(() => {
    const id = app.postId;
    if (!id || app.status.kind === 'loading') return;
    untrack(() => {
      app.api.reviewComments(id).then(
        (d) => (openComments = d.comments.filter((c) => c.status === 'open').length),
        () => (openComments = 0),
      );
    });
  });

  // The release scheduled for a day and a time (docs/spec/versioning.md §11): opening or saving a page that is in
  // it says that a saved change stops it. A warning, never a block.
  let scheduledView = $state<ScheduledView | null>(null);
  let scheduledTz = $state('UTC');
  $effect(() => {
    const id = app.postId;
    if (!id || app.status.kind === 'loading' || config.contentOnly || config.viewOnly) return;
    untrack(() => {
      app.api.listReleases().then(
        (list) => {
          scheduledView = list.scheduled ?? null;
          scheduledTz = list.timezone || 'UTC';
        },
        () => (scheduledView = null),
      );
    });
  });
  const scheduledHere = $derived(inScheduled(scheduledView, app.postId) ? formatAt(scheduledView!.at, scheduledTz) : null);

  /** The page shown over the builder (PreviewMode), or null. */
  let previewUrl = $state<string | null>(null);

  function onkeydown(event: KeyboardEvent) {
    // While the page is shown over the builder, the builder's shortcuts are asleep.
    if (previewUrl) return;
    const inEditor = !!(event.target as Element | null)?.closest?.('.cm-editor');
    const inField = isField(event.target);
    const combo = comboOf(event);
    const id = combo ? bound.get(combo) : undefined;
    if (id) {
      // Typing is never taken: only `global` shortcuts work in fields and code editors (docs/spec/shortcuts.md).
      const scope = SCOPES[id];
      const allowed = scope === 'global' || (scope === 'code' ? !inEditor : !inEditor && !inField);
      const command = allowed ? shortcutCommands().find((c) => c.id === id) : undefined;
      if (command) {
        event.preventDefault();
        command.run();
        return;
      }
    }
    if (event.key === 'Escape' && !inEditor && section) {
      section = null;
    } else if (event.key === 'Escape' && !inEditor && fwOpen) {
      toggleFramework();
    } else if (event.key === 'Escape' && !inEditor) {
      app.select(null);
    }
  }

  /**
   * Copy and paste between XB sites (docs/spec/quick-actions.md §5), outside text fields and code editors:
   * Ctrl+C copies the selected element with the styles of its classes; Ctrl+V of such a clip opens the paste
   * dialog, and HTML from elsewhere is cleaned and inserted as elements.
   */
  function outsideFields(event: ClipboardEvent): boolean {
    const target = event.target as Element | null;
    return !target?.closest?.('.cm-editor') && !isField(event.target) && !(document.activeElement instanceof HTMLElement && (isField(document.activeElement) || document.activeElement.closest('.cm-editor')));
  }

  /** Ctrl+X, and the palette's «Taglia»: copied as with Ctrl+C, then removed (one undo step brings it back). */
  async function cutSelection() {
    const uid = app.selected;
    const block = uid ? app.find(uid) : null;
    if (!uid || !block) return;
    const clip = JSON.stringify(makeClip([$state.snapshot(block) as XbBlock], $state.snapshot(app.styles), window.location.hostname));
    rememberCopy(clip);
    try {
      await navigator.clipboard.writeText(clip);
    } catch {
      app.status = { kind: 'error', message: t('Il browser non ha dato accesso agli appunti: niente è stato tagliato.') };
      return;
    }
    app.remove(uid);
    app.status = { kind: 'idle', message: t('Elemento tagliato con i suoi stili: incollalo con Ctrl+V.') };
  }
  function oncut(event: ClipboardEvent) {
    if (!app.selected || !outsideFields(event) || !event.clipboardData) return;
    const uid = app.selected;
    const block = app.find(uid);
    if (!block) return;
    const clip = JSON.stringify(makeClip([$state.snapshot(block) as XbBlock], $state.snapshot(app.styles), window.location.hostname));
    rememberCopy(clip);
    event.clipboardData.setData('text/plain', clip);
    event.preventDefault();
    app.remove(uid);
    app.status = { kind: 'idle', message: t('Elemento tagliato con i suoi stili: incollalo con Ctrl+V.') };
  }

  function oncopy(event: ClipboardEvent) {
    if (!app.selected || !outsideFields(event) || !event.clipboardData) return;
    const block = app.find(app.selected);
    if (!block) return;
    const clip = makeClip([$state.snapshot(block) as XbBlock], $state.snapshot(app.styles), window.location.hostname);
    rememberCopy(JSON.stringify(clip));
    event.clipboardData.setData('text/plain', JSON.stringify(clip));
    event.preventDefault();
    app.status = { kind: 'idle', message: t('Elemento copiato con i suoi stili: incollalo in un altro sito Histeon con Ctrl+V.') };
  }

  function onpaste(event: ClipboardEvent) {
    if (!outsideFields(event) || !event.clipboardData) return;
    const text = event.clipboardData.getData('text/plain');
    const clip = readClip(text);
    if (clip) {
      event.preventDefault();
      void pasteDialog.open(clip, copiedHere(text));
      return;
    }
    const html = event.clipboardData.getData('text/html') || (/^\s*</.test(text) ? text : '');
    if (!html) return;
    event.preventDefault();
    void (async () => {
      try {
        const { blocks: parsed, dropped } = htmlToBlocks(html, randomUid);
        const { blocks } = parsed.length ? await restrictPaste(app.api, parsed) : { blocks: parsed };
        if (blocks.length) app.insert(blocks);
        app.status = { kind: 'idle', message: dropped ? t('HTML incollato come {0} elementi; tolti {1} elementi o attributi non sicuri.', blocks.length, dropped) : t('HTML incollato come {0} elementi.', blocks.length) };
      } catch (e) {
        app.status = { kind: 'error', message: t('Non ho potuto controllare il contenuto incollato, quindi non l’ho inserito: {0}', e instanceof Error ? e.message : String(e)) };
      }
    })();
  }

  function isField(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }

  function onbeforeunload(event: BeforeUnloadEvent) {
    if (app.anyDirty) event.preventDefault();
  }
</script>

<svelte:window {onkeydown} {onbeforeunload} {oncopy} {oncut} {onpaste} onpagehide={() => connector.goodbye()} />

{#snippet structureTools()}
  <button onclick={(e) => openInsert(e.currentTarget)} title={withKeys(t('Aggiungi un elemento'), 'insert')} aria-label={t('Aggiungi un elemento')}>+</button>
{/snippet}

{#snippet body(id: PanelId)}
  {#if id === 'structure'}<Structure {app} />
  {:else if id === 'properties'}<InfoPanel {app} {pickImage} pickFile={config.media.url ? pickFile : undefined} oninsert={openInsert} contentOnly={config.contentOnly} oneditform={config.fluentForms ? (id) => void editForm(id) : undefined} />
  {:else if config.contentOnly}<p class="content-mode">{t('Non disponibile in modalità contenuti.')}</p>
  {:else if id === 'html'}<HtmlPanel {app} visible={htmlVisible} />
  {:else if id === 'css'}<CssPanel {app} />
  {:else if id === 'recipes'}<RecipesPanel {app} />
  {:else}<JsPanel {app} />{/if}
{/snippet}

{#snippet edge(name: Area, label: string)}
  <!-- A focusable separator is the WAI-ARIA window splitter: Svelte's a11y rules do not know it is interactive. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class={name === 'bottom' ? 'resizer' : 'edge'}
    inert={name === 'bottom' && section !== null}
    class:none={name === 'bottom' && bottomSize === 0}
    role="separator"
    tabindex="0"
    aria-orientation={name === 'bottom' ? 'horizontal' : 'vertical'}
    aria-label={label}
    aria-valuenow={layout.sizes[name]}
    aria-valuemin={name === 'bottom' ? 60 : sizeLimits(name)[0]}
    aria-valuemax={sizeLimits(name)[1]}
    aria-valuetext="{layout.sizes[name]} px"
    onpointerdown={(e) => startResize(name, e)}
    onkeydown={(e) => resizeKey(name, e)}
  ></div>
{/snippet}

{#snippet area(name: Area)}
  {@const ids = layout.areas[name]}
  {@const others = ids.filter((p) => p !== dragging)}
  {@const alone = maximized !== null && ids.includes(maximized)}
  <div
    class="area area-{name}"
    class:dragging={dragging !== null}
    role="group"
    aria-label={name === 'left' ? t('Pannelli a sinistra') : name === 'right' ? t('Pannelli a destra') : t('Pannelli in basso')}
    ondragover={(e) => overArea(name, e)}
    ondrop={(e) => dropOnArea(name, e)}
  >
    {#each ids as id, i (id)}
      {#if dropAt?.area === name && id !== dragging && dropAt.index === others.indexOf(id)}<div class="drop-mark" aria-hidden="true"></div>{/if}
      <div class="slot" data-id={id} class:hidden={alone && maximized !== id} class:collapsed={layout.collapsed.includes(id)} class:ghost={dragging === id} style:flex-grow={layout.collapsed.includes(id) ? null : (layout.weights[id] ?? 1)}>
        <Panel
          {id}
          title={PANEL_TITLES[id]}
          area={name}
          collapsed={layout.collapsed.includes(id)}
          maximized={maximized === id}
          canMaximize={ids.length > 1}
          first={i === 0}
          last={i === ids.length - 1}
          badge={id === 'js' && app.dirtyScript ? ' •' : ''}
          tools={id === 'structure' && !config.contentOnly ? structureTools : undefined}
          onaction={(a) => act(id, a)}
          ondragstart={(p) => (dragging = p)}
          ondragend={endDrag}
          ontouchdrag={touchPanelDrag}
        >
          {@render body(id)}
        </Panel>
      </div>
      {@const next = ids[i + 1]}
      {#if next && !alone && dragging === null && !layout.collapsed.includes(id) && !layout.collapsed.includes(next)}
        <!-- A focusable separator is the WAI-ARIA window splitter: Svelte's a11y rules do not know it is interactive. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          class="split"
          role="separator"
          tabindex="0"
          aria-orientation={name === 'bottom' ? 'vertical' : 'horizontal'}
          aria-label={t('Spazio fra {0} e {1}', PANEL_TITLES[id], PANEL_TITLES[next])}
          aria-valuenow={shareOf(id, next)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={t('{0}: {1}%', PANEL_TITLES[id], shareOf(id, next))}
          onpointerdown={(e) => startSplit(name, id, next, e)}
          onkeydown={(e) => splitKey(name, id, next, e)}
        ></div>
      {/if}
    {/each}
    {#if dropAt?.area === name && dropAt.index === others.length}<div class="drop-mark" aria-hidden="true"></div>{/if}
    {#if ids.length === 0 || (ids.length === 1 && ids[0] === dragging)}<div class="drop-empty">{t('Rilascia qui')}</div>{/if}
  </div>
{/snippet}

<div class="xb" class:is-dragging={dragging !== null} class:narrow class:drawer-open={drawerOpen}>
  {#if tiny && !config.contentOnly && !tinyDismissed}
    <div class="too-narrow" role="alertdialog" aria-modal="true" aria-labelledby="xb-too-narrow">
      <p id="xb-too-narrow">{t('Il builder serve uno schermo largo almeno 768 px: su questo si può salvare e pubblicare, ma costruire la pagina è scomodo.')}</p>
      <button onclick={dismissTiny}>{t('Continua comunque')}</button>
    </div>
  {/if}
  {#if layoutBefore}
    <div class="toast" role="status">
      {t('Disposizione dei pannelli ripristinata.')}
      <button onclick={undoLayoutReset}>{tx('Annulla', 'undo')}</button>
    </div>
  {/if}
  <Topbar bind:this={topbar} {app} {config} onpalette={() => void palette.open()} oninsert={openInsert} onpreview={(url) => (previewUrl = url)} />
  <PreviewMode bind:url={previewUrl} relink={(as, ttl) => app.api.previewLink(config.postId, app.contextId, as, ttl)} />
  <CommandPalette bind:this={palette} {commands} />
  <ShortcutsDialog bind:this={shortcutsDialog} {app} {mac} commands={shortcutCommands} bind:shortcuts />
  <MediaPicker bind:this={media} {config} />
  <InsertMenu bind:this={insertMenu} {app} pickImage={config.media.url ? pickImage : undefined} pickMedia={config.media.url ? () => media.pickMedia() : undefined} onsvg={() => svgDialog.open()} onvideo={config.media.canUpload ? () => videoDialog.open() : undefined} onicon={config.icons ? () => void iconDialog?.open() : undefined} onmap={() => mapDialog.open()} {forms} />
  <FormEditor bind:this={formEditor} />
  <SvgDialog bind:this={svgDialog} {app} />
  <VideoDialog bind:this={videoDialog} {app} />
  <ReplaceDialog bind:this={replaceDialog} {app} />
  <MapDialog bind:this={mapDialog} {app} />
  {#if config.icons}<IconDialog bind:this={iconDialog} {app} url={config.icons} />{/if}
  <PasteDialog bind:this={pasteDialog} {app} />
  <Tour bind:this={tour} steps={tourSteps} />
  {#if !config.contentOnly}<AgentBanner {app} />{/if}

  <nav class="rail" aria-label={t('Sezioni')}>
    {#each SECTIONS as s (s.id)}
      <button class:active={section === s.id} aria-pressed={section === s.id} title={s.id === 'checks' && errors ? tn('{0}: {1} errore', '{0}: {1} errori', errors, s.label, errors) : s.id === 'comments' && openComments ? t('{0}: {1} da fare', s.label, openComments) : s.label} aria-label={s.label} onclick={() => toggle(s.id)}><Icon name={s.icon} />{#if s.id === 'checks' && errors}<span class="badge" aria-hidden="true">{errors > 99 ? '99+' : errors}</span>{:else if s.id === 'comments' && openComments}<span class="badge info" aria-hidden="true">{openComments > 99 ? '99+' : openComments}</span>{/if}</button>
    {/each}
    {#if config.media.url && !config.contentOnly}
      <button title={t('Libreria dei media')} aria-label={t('Libreria dei media')} onclick={() => void browseMedia()}><Icon name="media" /></button>
    {/if}
    {#if app.isComponent}
      <button class:active={section === 'schema'} aria-pressed={section === 'schema'} title={t('Props del componente')} aria-label={t('Props del componente')} onclick={() => toggle('schema')}><Icon name="schema" /></button>
    {/if}
    <span class="grow"></span>
    {#if narrow}
      <button class="drawer-toggle" aria-pressed={drawerOpen} aria-controls="xb-drawer-right" title={drawerOpen ? t('Nascondi i pannelli laterali') : t('Mostra i pannelli laterali')} aria-label={t('Pannelli laterali')} onclick={() => (drawerOpen = !drawerOpen)}><Icon name="sidebar" /></button>
    {/if}
    {#if config.framework && !config.contentOnly}
      <button class="fw" class:active={fwOpen} aria-pressed={fwOpen} title={t('{0}: mostra o nascondi il pannello', config.framework.label)} aria-label={config.framework.label} onclick={toggleFramework}>{frameworkShort}</button>
    {/if}
    <button title={withKeys(t('Tutti i comandi'), 'palette')} aria-label={t('Comandi')} onclick={() => void palette.open()}><Icon name="commands" /></button>
    {#if !config.contentOnly}
    <ConnectorPanel {connector} scriptUrl={config.connector} pair={config.connectorPair} context={taskContext} languages={config.languages?.items ?? []} saveScopes={config.agentScopes.canChange ? async (scopes: string[]) => (await app.api.saveAgentScopes(scopes)).enabled : null} />
    <button title={layout.sizes.bottom > 0 ? t('Nascondi i pannelli in basso') : t('Mostra i pannelli in basso')} aria-label={t('Pannelli in basso')} aria-pressed={layout.sizes.bottom > 0} onclick={toggleBottom}><Icon name="code" /></button>
    {/if}
    <button title={t('{0} (clic: {1})', THEME_LABEL[themeChoice], THEME_LABEL[THEME_NEXT[themeChoice]])} aria-label={t('Cambia tema: ora {0}', THEME_LABEL[themeChoice])} onclick={() => chooseTheme(THEME_NEXT[themeChoice])}><Icon name={themeChoice === 'system' ? 'system' : themeChoice === 'dark' ? 'moon' : 'sun'} /></button>
  </nav>

  {#if showArea('left')}
    <aside class="column left" style:width="{layout.areas.left.length ? layout.sizes.left : 64}px" inert={narrow && !drawerOpen}>
      {@render area('left')}
      {#if layout.areas.left.length}{@render edge('left', t('Larghezza dei pannelli a sinistra'))}{/if}
    </aside>
  {/if}

  <main class="center" style:--dock="{bottomSize}px">
    <div class="canvas-area" inert={section !== null} class:with-note={config.contentOnly || templateWithoutContent || !!scheduledHere} class:agent-at-work={connector.working !== null}>{#if templateWithoutContent && !config.contentOnly}<div class="template-note" role="note" data-xb-template-without-content><p><strong>{t('A questo template manca il blocco «Contenuto del post».')}</strong> {t('Se il sito lavora con Histeon Publish, senza questo blocco la rilettura e l’invio si fermano su questo template. Aggiungilo dove va il testo della pagina. Mettilo anche in un template di elenchi (archivi, ricerca): lì resta vuoto e non si vede.')}</p><button type="button" onclick={addPostContent}>{t('Aggiungi il contenuto del post')}</button></div>{:else if scheduledHere}<p class="content-mode scheduled-here" role="note" data-xb-scheduled-here>{t('Questa pagina è nella release programmata per il {0} alle {1}. Se salvi una modifica, quella release non partirà.', scheduledHere.date, scheduledHere.time)}</p>{:else if config.viewOnly}<p class="content-mode" role="note">{t('Questa pagina puoi solo vederla: chi gestisce il sito non ti ha dato il permesso di modificarla.')}</p>{:else if config.contentOnly}<p class="content-mode" role="note">{t('Modalità contenuti: clic su un testo per cambiarlo, seleziona un\'immagine per sostituirla. Salvi in sviluppo; la pubblicazione la fa chi gestisce il sito.')}</p>{/if}<Canvas {app} origins={config.canvasOrigins} template={app.sessions.length ? null : config.template} />{#if connector.working}<p class="agent-working" role="status" data-xb-agent-working>✦ {t('L’agente sta lavorando: {0}', SCOPE_LABELS[connector.working.scope].toLowerCase())}</p>{/if}</div>
    {@render edge('bottom', t('Altezza dei pannelli in basso'))}
    <div class="bottom" inert={section !== null} class:collapsed={bottomSize === 0}>{@render area('bottom')}</div>

    {#if section}
      {@const title = section === 'alts' ? t('Testi alternativi della pagina') : (SECTIONS.find((s) => s.id === section)?.label ?? t('Props del componente'))}
      <div class="overlay" role="dialog" aria-label={title}>
        <header>
          <h2 tabindex="-1" bind:this={sectionHeading}>{title}</h2>
          <button onclick={() => (section = null)} aria-label={t("Chiudi e torna all'anteprima")}>{t('Chiudi')} ✕</button>
        </header>
        <div class="overlay-body">
          {#if section === 'content'}{#await sectionModule('ContentSection')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'templates'}{#await sectionModule('TemplatesSection')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} newUrl={config.admin.templates} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'styles'}{#await sectionModule('SelectorsPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} visible={true} canManage={config.canManage} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'queries'}{#await sectionModule('QueryPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} visible={true} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'facets'}{#await sectionModule('FacetsPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'fields'}{#await sectionModule('ContentHubPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} visible={true} adminUrl={config.admin.overview} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'components'}{#await sectionModule('ContentSection')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} initial="wp_block" />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'library'}{#await sectionModule('LibrarySection')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} oninsert={(clip: Clip) => { section = null; pasteDialog.open(clip); }} onagent={(name: string, brief: string) => connector.tasks.add('section', t('Ricostruisci in questa pagina la sezione «{0}» della libreria', name), `${sectionInstructions(taskContext())}\n\n${brief}`)} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'history'}{#await sectionModule('HistoryPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} canPublish={config.canPublish} canManage={config.canManage} visible={true} adminHistory={config.admin.history} embed={config.embed} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'source'}{#await sectionModule('SourcePanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'design'}{#await sectionModule('DesignPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'comments'}{#await sectionModule('CommentsPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} onshow={() => (section = null)} oncount={(n: number) => (openComments = n)} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'checks'}<ChecksPanel {app} {findings} onrecheck={recheck} onshow={() => (section = null)} onalts={() => (section = 'alts')} />
          {:else if section === 'alts'}{#await sectionModule('AltTable')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} onshow={() => (section = null)} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}
          {:else if section === 'schema'}{#await sectionModule('ComponentPanel')}<p class="section-loading" role="status">{t('Caricamento…')}</p>{:then mod}<mod.default {app} />{:catch e}<p class="section-loading error" role="alert">{t('Sezione non caricata: {0}', e instanceof Error ? e.message : String(e))}</p>{/await}{/if}
        </div>
      </div>
    {/if}

    {#if config.framework && fwLoaded}
      <section class="fw-drawer" hidden={!fwOpen} style:width="{fwWidth}px" aria-label={t('Pannello {0}', config.framework.label)}>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div class="fw-edge" role="separator" tabindex="0" aria-orientation="vertical" aria-label={t('Larghezza del pannello {0}', config.framework.label)} aria-valuenow={fwWidth} aria-valuemin={360} aria-valuetext="{fwWidth} px" onpointerdown={resizeFramework} onkeydown={resizeFrameworkKey}></div>
        <header>
          <strong>{config.framework.label}</strong>
          <button onclick={() => void app.reloadFramework()} title={t('Dopo aver salvato nel framework: aggiorna anteprima, variabili e classi')}>↻ {t("Applica all'anteprima")}</button>
          <a href={fwTabUrl} target="_blank" rel="noopener" title={t('Apri in una nuova scheda')}>↗</a>
          <button onclick={toggleFramework} aria-label={t('Nascondi il pannello {0}', config.framework.label)}>✕</button>
        </header>
        <iframe src={config.framework.url} title={config.framework.label}></iframe>
      </section>
    {/if}
  </main>

  {#if showArea('right')}
    <aside id="xb-drawer-right" class="column right" style:width="{layout.areas.right.length ? layout.sizes.right : 64}px" inert={narrow && !drawerOpen}>
      {#if layout.areas.right.length}{@render edge('right', t('Larghezza dei pannelli a destra'))}{/if}
      {@render area('right')}
    </aside>
  {/if}
</div>

<style>
  :global(:root) {
    --xb-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --xb-mono: ui-monospace, 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
    /* Light (default): the Histeon palette, warm paper with ink and a coral weft (docs/brand.md). */
    --xb-accent: #3f4bc4;
    /* The accent as text (links, active labels): readable on the panels in both themes. */
    --xb-link: #3f4bc4;
    --xb-ink: #171a33;
    --xb-on-ink: #f3ece1;
    --xb-coral: #ff6f5e;
    --xb-bg: #ffffff;
    --xb-panel: #f8f7f4;
    --xb-stage: #eceae4;
    --xb-line: #e3e0d8;
    --xb-text: #1c1d26;
    --xb-muted: #5f6270;
    --xb-accent-bg: rgb(63 75 196 / 0.1);
    --xb-danger: #b42318;
    --xb-danger-bg: rgb(214 54 56 / 0.1);
    /* Text on a --xb-danger background. */
    --xb-on-danger: #ffffff;
    --xb-ok: #157f3c;
    --xb-warn: #9a5b00;
    --xb-info: #1d4ed8;
    --xb-hover: rgb(23 26 51 / 0.05);
    --xb-selection: rgb(63 75 196 / 0.2);
    --xb-ring: 0 0 0 2px var(--xb-bg), 0 0 0 4px rgb(63 75 196 / 0.55);
    --xb-shadow: 0 1px 2px rgb(23 26 51 / 0.06), 0 8px 24px -6px rgb(23 26 51 / 0.18);
    --xb-r-sm: 5px;
    --xb-r: 7px;
    --xb-r-lg: 10px;
    --xb-syn-tag: #2b44a8;
    --xb-syn-attr: #7a3fd0;
    --xb-syn-string: #b4321d;
    --xb-syn-number: #1a7f37;
    --xb-syn-class: #a15c00;
    color-scheme: light;
  }
  :global(:root[data-theme='dark']) {
    --xb-accent: #5b66d6;
    --xb-link: #9aa3ff;
    --xb-ink: #ecebf3;
    --xb-on-ink: #171a33;
    --xb-bg: #15161f;
    --xb-panel: #1b1d29;
    --xb-stage: #0f1017;
    --xb-line: #2c2f40;
    --xb-text: #ecebf3;
    --xb-muted: #a3a6b8;
    --xb-accent-bg: rgb(110 120 240 / 0.2);
    --xb-danger: #ff9a9a;
    --xb-danger-bg: rgb(255 80 80 / 0.14);
    --xb-on-danger: #171a33;
    --xb-ok: #7be0a8;
    --xb-warn: #ffc46b;
    --xb-info: #8fb4ff;
    --xb-hover: rgb(255 255 255 / 0.06);
    --xb-selection: rgb(124 134 255 / 0.35);
    --xb-ring: 0 0 0 2px var(--xb-bg), 0 0 0 4px rgb(140 150 255 / 0.7);
    --xb-shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 10px 28px -6px rgb(0 0 0 / 0.55);
    --xb-syn-tag: #8fb4ff;
    --xb-syn-attr: #c9a7ff;
    --xb-syn-string: #ffb38a;
    --xb-syn-number: #8fe3a8;
    --xb-syn-class: #ffd479;
    color-scheme: dark;
  }
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: var(--xb-bg);
    color: var(--xb-text);
    font-family: var(--xb-sans);
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  /* One focus ring for every control: visible with the keyboard, quiet with the mouse. */
  :global(:where(button, a, input, select, textarea, summary, [tabindex]):focus-visible) {
    outline: none;
    box-shadow: var(--xb-ring);
  }
  /* Icons inside labelled buttons sit on the text's baseline. */
  :global(button > svg, a > svg) {
    vertical-align: -2px;
    flex: none;
  }
  :global(::selection) {
    background: var(--xb-selection);
  }
  /* Thin, quiet scrollbars that fit the panels. */
  :global(*) {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--xb-muted) 35%, transparent) transparent;
  }
  :global(button) {
    transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(*, *::before, *::after) {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
  }
  :global(#xb-builder) {
    height: 100%;
  }
  .xb {
    display: grid;
    grid-template-columns: 48px auto minmax(0, 1fr) auto;
    grid-template-rows: 48px minmax(0, 1fr);
    grid-template-areas: 'top top top top' 'rail left center right';
    height: 100dvh;
  }
  .xb > :global(header) {
    grid-area: top;
  }
  .template-note {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 12px;
    background: color-mix(in srgb, var(--xb-warn) 12%, var(--xb-bg));
    border-bottom: 1px solid var(--xb-line);
    border-left: 3px solid var(--xb-warn);
  }
  .template-note p {
    margin: 0;
  }
  .template-note button {
    flex: none;
    font: 12px var(--xb-sans);
    padding: 4px 10px;
    border-radius: var(--xb-r-sm);
    border: 1px solid var(--xb-line);
    background: var(--xb-bg);
    color: var(--xb-text);
    cursor: pointer;
  }
  .content-mode.scheduled-here {
    background: color-mix(in srgb, var(--xb-warn) 12%, var(--xb-bg));
    border-left: 3px solid var(--xb-warn);
  }
  .content-mode {
    margin: 0;
    padding: 6px 12px;
    font-size: 12px;
    background: var(--xb-accent-bg);
    border-bottom: 1px solid var(--xb-line);
  }
  .rail {
    grid-area: rail;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 0;
    background: var(--xb-panel);
    border-right: 1px solid var(--xb-line);
  }
  .rail button {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--xb-r);
    border: 0;
    background: transparent;
    color: var(--xb-muted);
    font: 600 16px var(--xb-sans);
    cursor: pointer;
  }
  .rail button:hover {
    background: var(--xb-hover);
    color: var(--xb-text);
  }
  .rail button.active {
    background: var(--xb-accent-bg);
    color: var(--xb-link);
  }
  /* The active section is marked by a coral thread on the rail's edge, like the weft in the mark. */
  .rail button.active::before {
    content: '';
    position: absolute;
    left: -6px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--xb-coral);
  }
  .rail .badge {
    position: absolute;
    top: 2px;
    right: 1px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--xb-danger);
    color: var(--xb-on-danger);
    font: 700 9.5px/15px var(--xb-sans);
    text-align: center;
  }
  .rail .badge.info {
    background: var(--xb-coral);
    color: #171a33;
  }
  .rail .sep {
    width: 20px;
    height: 1px;
    margin: 4px 0;
    background: var(--xb-line);
  }
  .grow {
    flex: 1;
  }
  .center {
    grid-area: center;
    position: relative;
    display: grid;
    grid-template-rows: minmax(120px, 1fr) 6px var(--dock);
    min-height: 0;
    min-width: 0;
  }
  .canvas-area {
    min-height: 0;
    min-width: 0;
  }
  /* An AI agent changed the page in the last seconds (doc 26 voce 219): say so over the canvas, without blocking it. */
  .canvas-area.agent-at-work { position: relative; outline: 2px solid var(--xb-link); outline-offset: -2px; }
  .agent-working { position: absolute; top: 8px; right: 12px; z-index: 5; margin: 0; padding: 4px 10px; border-radius: 999px; background: var(--xb-ink); color: var(--xb-on-ink); font-size: 12px; pointer-events: none; box-shadow: var(--xb-shadow); }
  @media (prefers-reduced-motion: no-preference) { .agent-working { animation: agent-in 0.2s ease-out; } }
  @keyframes agent-in { from { opacity: 0; transform: translateY(-4px); } }
  .canvas-area.with-note {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }
  /* The bottom edge takes the pointer 4px past its line on both sides, above the panel headers: a press near the
     edge resizes, never drags the panel below. */
  .resizer {
    position: relative;
    z-index: 4;
    cursor: row-resize;
    background: var(--xb-line);
    touch-action: none;
  }
  .resizer::before {
    content: '';
    position: absolute;
    inset: -4px 0;
  }
  .resizer:hover,
  .resizer:focus-visible,
  .edge:focus-visible,
  .fw-edge:focus-visible {
    background: var(--xb-accent);
    outline: none;
  }
  .resizer.none {
    display: none;
  }
  .bottom {
    min-height: 0;
    min-width: 0;
    display: flex;
  }
  .bottom.collapsed {
    display: none;
  }
  .column {
    position: relative;
    display: flex;
    min-height: 0;
    background: var(--xb-panel);
  }
  .column.left {
    grid-area: left;
    border-right: 1px solid var(--xb-line);
  }
  /* Under 1024 px the side columns are drawers over the canvas (L1): closed, they leave it the whole width. */
  .xb.narrow {
    grid-template-columns: 48px 0 minmax(0, 1fr) 0;
  }
  .xb.narrow .column {
    position: fixed;
    top: 48px;
    bottom: 0;
    z-index: 30;
    width: min(340px, calc(100vw - 56px)) !important;
    box-shadow: var(--xb-shadow);
    transition: transform 0.18s ease;
  }
  .xb.narrow .column.right {
    right: 0;
    transform: translateX(105%);
  }
  .xb.narrow .column.left {
    left: 48px;
    transform: translateX(calc(-100% - 60px));
  }
  .xb.narrow.drawer-open .column {
    transform: none;
  }
  .xb.narrow .column :global(.edge) {
    display: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .xb.narrow .column {
      transition: none;
    }
  }
  .too-narrow {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-content: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
    background: var(--xb-bg);
    color: var(--xb-text);
    font: 15px/1.5 var(--xb-sans);
  }
  .too-narrow button {
    justify-self: center;
    font: 600 14px var(--xb-sans);
    padding: 8px 16px;
    border-radius: var(--xb-r);
    border: 1px solid var(--xb-ink);
    background: var(--xb-ink);
    color: var(--xb-on-ink);
    cursor: pointer;
  }
  .column.right {
    grid-area: right;
    border-left: 1px solid var(--xb-line);
  }
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    z-index: 6;
    cursor: col-resize;
    touch-action: none;
  }
  .left .edge {
    right: -3px;
  }
  .right .edge {
    left: -3px;
  }
  .edge:hover {
    background: var(--xb-accent);
  }
  .area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .area-bottom {
    flex-direction: row;
    background: var(--xb-panel);
  }
  .slot {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    display: grid;
  }
  .area:not(.area-bottom) > .slot + .slot {
    border-top: 1px solid var(--xb-line);
  }
  .area-bottom > .slot + .slot {
    border-left: 1px solid var(--xb-line);
  }
  .slot.collapsed {
    flex: 0 0 auto;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-radius: var(--xb-r);
    background: var(--xb-ink);
    color: var(--xb-on-ink);
    font: 13px var(--xb-sans);
    box-shadow: var(--xb-shadow);
  }
  .toast button {
    font: 600 13px var(--xb-sans);
    padding: 3px 10px;
    border-radius: var(--xb-r-sm);
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  /* Between two panels of an area: a 1px line with a wider grip around it. */
  .split {
    flex: none;
    position: relative;
    z-index: 2;
    background: var(--xb-line);
    touch-action: none;
  }
  .area-bottom > .split {
    width: 1px;
    cursor: col-resize;
  }
  .area:not(.area-bottom) > .split {
    height: 1px;
    cursor: row-resize;
  }
  .split::before {
    content: '';
    position: absolute;
    inset: -3px 0;
  }
  .area-bottom > .split::before {
    inset: 0 -3px;
  }
  .split:hover,
  .split:focus-visible {
    background: var(--xb-accent);
    outline: none;
  }
  .slot.hidden {
    display: none;
  }
  .slot.ghost {
    opacity: 0.35;
  }
  .drop-mark {
    flex: 0 0 3px;
    background: var(--xb-accent);
    border-radius: 2px;
  }
  .drop-empty {
    flex: 1;
    display: grid;
    place-items: center;
    margin: 6px;
    border: 2px dashed var(--xb-accent);
    border-radius: 8px;
    color: var(--xb-link);
    font-size: 12px;
    text-align: center;
  }
  .is-dragging .area {
    outline: 1px dashed var(--xb-line);
    outline-offset: -3px;
  }
  /* While a panel is dragged the preview must not swallow the drag events. */
  .is-dragging .canvas-area {
    pointer-events: none;
  }
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--xb-bg);
  }
  .overlay header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--xb-line);
    background: var(--xb-panel);
  }
  .overlay h2 {
    margin: 0;
    font: 600 15px var(--xb-sans);
    letter-spacing: -0.01em;
  }
  .overlay header button {
    font: 13px var(--xb-sans);
    padding: 6px 12px;
    border-radius: var(--xb-r);
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
  }
  .overlay-body {
    min-height: 0;
    overflow: auto;
    padding: 16px;
  }
  .overlay .ext {
    margin: 0 12px 0 auto;
    font-size: 13px;
    color: var(--xb-muted);
  }
  .fw-drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 6;
    max-width: calc(100% - 120px);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--xb-bg);
    border-left: 1px solid var(--xb-line);
    box-shadow: var(--xb-shadow);
  }
  .fw-drawer[hidden] {
    display: none;
  }
  .fw-drawer header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--xb-line);
    font: 13px var(--xb-sans);
  }
  .fw-drawer header strong {
    margin-right: auto;
  }
  .fw-drawer header button,
  .fw-drawer header a {
    font: 12px var(--xb-sans);
    padding: 4px 10px;
    border-radius: var(--xb-r-sm);
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
    text-decoration: none;
  }
  .fw-drawer iframe {
    display: block;
    border: 0;
    width: 100%;
    height: 100%;
    background: #fff;
  }
  .fw-edge {
    position: absolute;
    left: -3px;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 1;
    touch-action: none;
  }
  .rail .fw {
    font: 700 11px var(--xb-sans);
    letter-spacing: 0.02em;
  }
  .section-loading {
    margin: 0;
    padding: 16px;
    color: var(--xb-muted);
    font-size: 13px;
  }
  .section-loading.error {
    color: var(--xb-danger);
  }
</style>
