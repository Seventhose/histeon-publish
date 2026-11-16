<script lang="ts">
  import { untrack } from 'svelte';
  import CodeEditor from './CodeEditor.svelte';
  import { appendQueryBlock, conditionAt } from '../lib/canvasWidth.ts';
  import MiniGui from './MiniGui.svelte';
  import MiniGuiCompact from './MiniGuiCompact.svelte';
  import { miniStyleFrom, type MiniStyle } from '../lib/miniGuiCompact.ts';
  import BulkMove from './BulkMove.svelte';
  import { bodyAt, rangeOf, setBodyAt, STATES, widthPreludes } from '../lib/cssContext.ts';
  import { LAYOUT_ACTIONS, applyDeclarations, cssCompletions, pxToRem, spacingScale } from '../lib/cssActions.ts';
  import { conditionalClasses, staticClasses, staticId, suggestedClass, updateBlock } from '../lib/tree.ts';
  import { balanced, prettyRule, rulesFor } from '../lib/sheet.ts';
  import { validClassName } from '../lib/selectors.ts';
  import { blockRules, nestedBody, safeToMove, withoutRules, type BlockRule } from '../lib/scss.ts';
  import { compileCss, cssLint } from '@xb/dsl';
  import type { Diagnostic } from '@codemirror/lint';
  import { lintContext, lintMessage } from '../lib/cssLint.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t, tn } from '../lib/i18n.ts';

  let { app }: { app: BuilderState } = $props();

  /** Targets of the pills: a selector (`.card`, `#hero`) or a whole global sheet (`sheet:<id>`). */
  const SHEET = 'sheet:';
  const block = $derived(app.selected ? app.find(app.selected) : null);
  // Every global sheet gets a pill: imported sites keep their CSS in a sheet of their own, not in `global`.
  const sheets = $derived(app.globals.length > 0 ? app.globals.map((g) => g.id) : ['global']);
  const sheetCss = (id: string) => app.globals.find((g) => g.id === id)?.css ?? '';
  const classes = $derived(staticClasses(block));
  // Selector pills: every static class, plus the id. CSS loads only on pages where they appear.
  // Then the classes an expression adds (`{props.scura ? "card--scura" : ""}`): a variant's CSS is written here too.
  const selectors = $derived([...classes.map((c) => `.${c}`), ...conditionalClasses(block).map((c) => `.${c}`), ...(staticId(block) ? [`#${staticId(block)}`] : [])]);
  let chosen = $state<string | null>(null);
  let newClass = $state('');
  const completions = cssCompletions(() => app);
  const spacing = $derived(spacingScale(app.framework.variables));
  /** «Altro»: queries at the canvas width and quick actions, over the editor instead of above it. */
  let moreOpen = $state(false);
  let moreEl: HTMLDivElement | undefined = $state();
  // «Altro» closes on a click elsewhere or Escape: it never stays over the editor.
  $effect(() => {
    if (!moreOpen) return;
    const away = (e: PointerEvent) => {
      const node = e.target as Node | null;
      if (node && !moreEl?.contains(node) && !(node instanceof Element && node.closest('[data-more-toggle]'))) moreOpen = false;
    };
    // Esc closes «Altro» and nothing else (not the selection too), and the focus goes back to its button.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      moreOpen = false;
      document.querySelector<HTMLElement>('[data-more-toggle]')?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  });
  /** Next to its button, below or above where there is room, never cut by the panel's edges. */
  let morePos = $state('');
  function placeMore(button: HTMLElement) {
    const r = button.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 8;
    morePos = below >= Math.min(320, r.top - 8) ? `left:${left}px;top:${r.bottom + 4}px;width:${width}px;max-height:${below - 4}px` : `left:${left}px;bottom:${window.innerHeight - r.top + 4}px;width:${width}px;max-height:${r.top - 12}px`;
  }
  $effect(() => {
    void target;
    moreOpen = false;
  });
  let spaceProp = $state<'gap' | 'padding' | 'padding-block' | 'padding-inline' | 'margin-block'>('gap');
  /** A quick action on the class's own CSS: the text changes as if typed, so the usual save path follows. */
  function quick(next: (css: string) => string) {
    onchange(next(text));
    moreOpen = false; // One action, and the editor is free again.
  }
  // The mini GUI is on unless the user turned it off (remembered in this browser).
  let miniOn = $state(readMini());
  function readMini(): boolean {
    try {
      return localStorage.getItem('xb-mini-gui') !== 'off';
    } catch {
      return true;
    }
  }
  function toggleMini() {
    miniOn = !miniOn;
    try {
      localStorage.setItem('xb-mini-gui', miniOn ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }
  // Which mini GUI: Histeon's groups and rows, or the compact strip of buttons (remembered too; `etch`, saved by
  // earlier versions, reads as `compact`).
  let miniStyle = $state<MiniStyle>(readMiniStyle());
  function readMiniStyle(): MiniStyle {
    try {
      return miniStyleFrom(localStorage.getItem('xb-mini-gui-style'));
    } catch {
      return 'histos';
    }
  }
  function chooseMiniStyle(value: string) {
    miniStyle = miniStyleFrom(value);
    try {
      localStorage.setItem('xb-mini-gui-style', miniStyle);
    } catch {
      /* ignore */
    }
  }

  // Follow the selection: default to the element's first class.
  $effect(() => {
    void app.selected;
    chosen = null;
  });
  // A class picked in the code (Ctrl+click, F12): this pill, once the selection has followed.
  $effect(() => {
    const wanted = app.cssRequest;
    if (!wanted) return;
    queueMicrotask(() => {
      chosen = wanted;
      app.cssRequest = null;
    });
  });
  const target = $derived(chosen ?? selectors[0] ?? (block ? null : SHEET + (sheets[0] ?? 'global')));
  const sheetTarget = $derived(target?.startsWith(SHEET) ? target.slice(SHEET.length) : null);

  // A class styled in a global sheet: its rules there, shown in place and edited in the sheet itself.
  const own = $derived(target && !sheetTarget ? (app.styles.find((s) => s.selector === target)?.css ?? '') : '');
  const inSheets = $derived.by(() => {
    if (!target?.startsWith('.')) return [];
    const name = target.slice(1);
    return sheets.flatMap((id) => rulesFor(sheetCss(id), name).map((r) => ({ ...r, sheet: id })));
  });
  /** Which view of a class: its own entry, or its rules in the sheets (default when it has no CSS of its own). */
  let view = $state<'own' | 'sheet'>('own');
  $effect(() => {
    void target;
    view = untrack(() => (own.trim() === '' && inSheets.length > 0 ? 'sheet' : 'own'));
  });

  // ---- the class's rules in the global sheets: only those rules, each editable on its own.
  // Each one remembers where it sits in its sheet and the exact text there; an edit is spliced back into that
  // spot only if the text is still the same (otherwise the sheet changed elsewhere and the rules are reloaded).
  const MAX_RULES = 30;
  interface Segment {
    key: string;
    sheet: string;
    from: number;
    to: number;
    /** What the sheet holds in [from, to). */
    written: string;
    text: string;
    within: string[];
    error: string;
  }
  let segments = $state<Segment[]>([]);
  function loadSegments() {
    for (const s of segments) app.cancelEdit(`css:${s.key}`);
    segments =
      view === 'sheet' && !sheetTarget
        ? inSheets.slice(0, MAX_RULES).map((r, i) => {
            const raw = sheetCss(r.sheet).slice(r.from, r.to);
            return { key: `${r.sheet}:${i}`, sheet: r.sheet, from: r.from, to: r.to, written: raw, text: prettyRule(raw), within: r.within, error: '' };
          })
        : [];
  }
  $effect(() => {
    void target;
    void view;
    void app.styleRevision;
    untrack(loadSegments);
  });

  function editRule(segment: Segment, css: string) {
    segment.text = css;
    if (!balanced(css)) {
      app.cancelEdit(`css:${segment.key}`);
      app.reject(`css:${segment.key}`, t('CSS di {0} con graffe non bilanciate', target ?? ''));
      segment.error = t('Graffe non bilanciate: la regola non viene scritta finché non le chiudi.');
      return;
    }
    segment.error = '';
    app.deferEdit(`css:${segment.key}`, 250, () => {
      const current = sheetCss(segment.sheet);
      if (current.slice(segment.from, segment.to) !== segment.written) {
        loadSegments();
        return;
      }
      app.setGlobalCss(current.slice(0, segment.from) + css + current.slice(segment.to), segment.sheet);
      const delta = css.length - (segment.to - segment.from);
      for (const other of segments) {
        if (other !== segment && other.sheet === segment.sheet && other.from >= segment.to) {
          other.from += delta;
          other.to += delta;
        }
      }
      segment.to = segment.from + css.length;
      segment.written = css;
    });
  }

  // ---- the block's rules as SCSS in its selector (styles.md §11): gathered from every sheet, moved in one step.
  const gathered = $derived.by(() => {
    if (!target?.startsWith('.') || view !== 'sheet') return null;
    const name = target.slice(1);
    const move: BlockRule[] = [];
    let keep = 0;
    let shared = 0;
    for (const id of sheets) {
      const css = sheetCss(id);
      const found = blockRules(css, name, id);
      const safe = safeToMove(css, found.movable, [name, ...classes.filter((c) => c !== name)]);
      move.push(...safe.move);
      keep += safe.keep.length;
      shared += found.shared.length;
    }
    return move.length ? { move, keep, shared, body: nestedBody(move) } : null;
  });
  let scssOpen = $state(true);

  function moveToSelector() {
    // Pending edits of the rules first: the move reads the sheets as they will be saved.
    app.flushEdits();
    const g = gathered;
    if (!g || !target) return;
    // Before the selector's own CSS: the sheets were printed before it, so the cascade stays the same.
    const next = g.body + '\n' + (own.trim() ? own.trim() + '\n' : '');
    const changed: Record<string, string> = {};
    for (const id of new Set(g.move.map((r) => r.sheet))) changed[id] = withoutRules(sheetCss(id), g.move.filter((r) => r.sheet === id));
    app.moveToSelector([{ selector: target, css: next }], changed);
    view = 'own';
  }

  // ---- a sheet pill: the whole CSS of the site, read-only, with each selector's part where it ends up.
  let fullView = $state(false);
  /** «Nei selettori»: every block of the sheet at once (styles.md §11), after a preview. */
  let bulkOpen = $state(false);
  $effect(() => {
    void target;
    bulkOpen = false;
  });
  const fullCss = $derived(
    fullView
      ? [
          ...app.globals.map((g) => `/* ── ${t('Foglio {0}', g.id)} ── */\n${prettyRule(g.css)}`),
          ...app.styles.map((st) => `/* ── ${st.selector} ${t('(selettore)')} ── */\n${prettyRule(compileCss(st.selector, st.css))}`),
        ].join('\n\n')
      : '',
  );

  /** The sheet the main editor shows and writes: only when a sheet pill is chosen. */
  const editingSheet = $derived(sheetTarget);
  const stored = $derived(editingSheet !== null ? sheetCss(editingSheet) : own);

  // The editor shows local text, updated on every keystroke; the store is written with a short delay.
  // Only a different selector or an external change (load, undo, save) replaces the text.
  let text = $state('');
  $effect(() => {
    void target;
    void app.styleRevision;
    app.cancelEdit('css');
    void editingSheet;
    text = untrack(() => stored);
  });

  // The selector's own CSS checked while it is written (C1): the same lint as the Checks panel and the agent.
  const lintWith = $derived(lintContext(app.framework, app.globals, app.styles, app.queries));
  const diagnostics = $derived<Diagnostic[]>(
    editingSheet === null && target && !target.startsWith(SHEET)
      ? cssLint(target, text, lintWith).map((issue) => ({ from: Math.min(issue.from, text.length), to: Math.min(issue.to, text.length), severity: issue.severity, message: lintMessage(issue) }))
      : [],
  );

  function onchange(css: string) {
    text = css;
    const current = target;
    const sheet = editingSheet;
    app.deferEdit('css', 250, () => {
      if (sheet !== null) app.setGlobalCss(css, sheet);
      else if (current) app.upsertStyle(current, css);
    });
  }

  // ---- where the mini GUI writes: the rule itself, a state, a width, or a state at a width (styles.md §10)
  let ctxState = $state<string | null>(null);
  let ctxWidth = $state<string | null>(null);
  const widths = $derived(widthPreludes(app.queries, app.layoutWidth, conditionAt, text));
  const path = $derived([...(ctxWidth ? [ctxWidth] : []), ...(ctxState ? [ctxState] : [])]);
  const contextCss = $derived(bodyAt(text, path));
  /** The block the editor shows after a context is chosen or created. */
  let jump = $state<{ from: number; to: number } | null>(null);
  const has = (p: string[]) => bodyAt(text, p).trim() !== '';
  // With the canvas at a width, the mini GUI writes in that @media (styles.md §10): the width follows the canvas
  // until one is picked by hand.
  /** Set while a width is picked by hand: following stops, and that width stays. */
  let pickedByHand = false;
  $effect(() => {
    const at = app.canvasPrelude;
    const following = app.followCanvas;
    untrack(() => {
      if (following) choose(undefined, at);
      else if (!pickedByHand) choose(undefined, null); // Turned off from the canvas: all widths.
      pickedByHand = false;
    });
  });
  function pickWidth(value: string) {
    if (value === '__canvas') {
      app.followCanvas = true;
      return;
    }
    pickedByHand = app.followCanvas;
    app.followCanvas = false;
    choose(undefined, value || null);
  }

  function choose(state: string | null | undefined, width: string | null | undefined) {
    if (state !== undefined) ctxState = state;
    if (width !== undefined) ctxWidth = width;
    jump = path.length ? rangeOf(text, path) : null;
  }
  // The canvas shows the chosen state on the selection (as if hovered, focused…), with its declarations.
  $effect(() => {
    const uid = app.selected;
    const state = ctxState;
    if (!uid || !state || sheetTarget || !miniOn) {
      app.forcedCss = '';
      return;
    }
    const decls = bodyAt(text, path).replace(/[^;{}]*\{[^}]*\}/g, '').trim();
    const sel = `[data-xb-uid="${CSS.escape(uid)}"]`;
    const rule = decls ? `${sel}${sel}${state.startsWith('&::') ? state.slice(1) : ''} { ${decls} }` : '';
    app.forcedCss = rule && ctxWidth ? `${ctxWidth} { ${rule} }` : rule;
    return () => (app.forcedCss = '');
  });

  function writeContext(body: string) {
    const created = path.length > 0 && rangeOf(text, path) === null;
    const next = setBodyAt(text, path, body);
    onchange(next);
    if (created) jump = rangeOf(next, path);
  }

  function addClass(event: SubmitEvent) {
    event.preventDefault();
    // Empty: the class proposed in the field (the block of the nearest ancestor with a class, and what this is).
    const name = newClass.trim() || (app.selected ? suggestedClass(app.tree, app.selected) : '');
    if (!app.selected || !validClassName(name)) return;
    app.setTree(
      updateBlock(app.tree, app.selected, (b) => {
        if (b.name !== 'xb/element') return b;
        const current = b.attrs.attributes?.class;
        const cls = typeof current === 'string' && current.trim() !== '' ? `${current} ${name}` : name;
        return { ...b, attrs: { ...b.attrs, attributes: { ...(b.attrs.attributes ?? {}), class: cls } } };
      }),
    );
    chosen = `.${name}`;
    newClass = '';
  }
</script>

<!-- Where the mini GUI writes (styles.md §10): the state and the width, in the class's own CSS and from «Nel foglio». -->
{#snippet contextPickers()}
  <button class="icon" onclick={toggleMini} aria-pressed={miniOn} title={miniOn ? t('Nascondi la Mini GUI') : t('Mostra la Mini GUI')}>Mini GUI {miniOn ? '▾' : '▸'}</button>
  {#if miniOn}
    <label class="pick" title={t('Come appare la Mini GUI: quella di Histeon o quella compatta')}>
      <span class="sr">{t('Stile della Mini GUI')}</span>
      <select aria-label={t('Stile della Mini GUI')} value={miniStyle} onchange={(e) => chooseMiniStyle(e.currentTarget.value)}>
        <option value="histos">Histeon</option>
        <option value="compact">{t('Stile compatto')}</option>
      </select>
    </label>
    <label class="pick" title={t('Dove scrive la Mini GUI: lo stato (● = ha già dichiarazioni)')}>
      <span class="sr">{t('Stato')}</span>
      <select aria-label={t('Stato')} value={ctxState ?? ''} onchange={(e) => choose(e.currentTarget.value || null, undefined)}>
        <option value="">{t('Normale')}</option>
        {#each STATES as st (st.prelude)}<option value={st.prelude}>{has([...(ctxWidth ? [ctxWidth] : []), st.prelude]) ? '● ' : ''}{st.label}</option>{/each}
      </select>
    </label>
    <label class="pick" title={t('A quale larghezza (● = ha già dichiarazioni)')}>
      <span class="sr">{t('Larghezza')}</span>
      <select aria-label={t('Larghezza')} value={app.canvasPrelude && ctxWidth === app.canvasPrelude ? '__canvas' : (ctxWidth ?? '')} onchange={(e) => pickWidth(e.currentTarget.value)}>
        <option value="">{t('Tutte')}</option>
        {#if app.canvasWidth !== null}<option value="__canvas">{t('Come la tela')}{app.canvasPrelude ? ` (${app.canvasPrelude.replace('@media ', '')})` : ''}</option>{/if}
        {#each widths as w (w.prelude)}<option value={w.prelude}>{has([w.prelude]) ? '● ' : ''}{w.label}</option>{/each}
      </select>
    </label>
  {/if}
{/snippet}

<div class="panel">
  <div class="pills" role="tablist" aria-label={t('Selettore')}>
    {#each selectors as sel (sel)}
      <button role="tab" aria-selected={target === sel} class:active={target === sel} onclick={() => (chosen = sel)}>{sel}</button>
    {/each}
    {#each sheets as id (id)}
      <button role="tab" class="sheet" aria-selected={target === SHEET + id} class:active={target === SHEET + id} onclick={() => (chosen = SHEET + id)} title={t('Foglio globale {0}', id)}>
        {sheets.length === 1 ? t('Foglio globale') : t('Foglio {0}', id)}
      </button>
    {/each}
  </div>

  {#if target && !sheetTarget && inSheets.length > 0}
    <div class="views">
      <button class:active={view === 'sheet'} onclick={() => (view = 'sheet')}>{t('Nel foglio ({0})', inSheets.length)}</button>
      <button class:active={view === 'own'} onclick={() => (view = 'own')}>{t('CSS proprio')}{own.trim() === '' ? '' : ' •'}</button>
    </div>
  {/if}

  {#if target && view === 'sheet' && segments.length > 0}
    <div class="rules">
      {#if gathered}
        <div class="scss" role="region" aria-label={t('SCSS di {0}', target)}>
          <div class="scss-head">
            <button class="link" aria-expanded={scssOpen} onclick={() => (scssOpen = !scssOpen)}>{scssOpen ? '▾' : '▸'} {t('Come SCSS nel selettore {0}', target)}</button>
            <button class="primary" onclick={moveToSelector} title={t('Le regole lasciano il foglio e diventano il CSS di {0}, annidate: un solo posto da leggere e modificare. Si annulla con Ctrl+Z.', target)}>{tn('Porta nel selettore ({0} regola)', 'Porta nel selettore ({0} regole)', gathered.move.length, gathered.move.length)}</button>
          </div>
          {#if scssOpen}
            <div class="scss-code"><CodeEditor value={gathered.body} language="css" onchange={() => {}} readOnly label={t('Anteprima SCSS di {0}', target)} /></div>
          {/if}
          {#if gathered.keep || gathered.shared}
            <p class="note">
              {#if gathered.keep}{tn("{0} regola resta nel foglio: più in basso un'altra regola tocca le stesse proprietà, e spostarla cambierebbe quale vince.", "{0} regole restano nel foglio: più in basso un'altra regola tocca le stesse proprietà, e spostarla cambierebbe quale vince.", gathered.keep, gathered.keep)}{/if}
              {#if gathered.shared}{tn('{0} regola è condivisa con altre classi', '{0} regole sono condivise con altre classi', gathered.shared, gathered.shared)} (<code>.a, .b</code>) {tn('e resta nel foglio.', 'e restano nel foglio.', gathered.shared)}{/if}
            </p>
          {/if}
        </div>
      {/if}
      <!-- The mini GUI here too, with its state and width (C3): it writes the class's own CSS, then shows it. -->
      {#if miniOn}
        {#if miniStyle === 'compact'}
          <MiniGuiCompact css={contextCss} onchange={(body) => (writeContext(body), (view = 'own'))} selector={path.length ? `${target} ${path.join(' ')}` : target} tag={block?.name === 'xb/element' ? block.attrs.tag : ''} state={ctxState} lead={contextPickers} />
        {:else}
          <MiniGui {app} css={contextCss} onchange={(body) => (writeContext(body), (view = 'own'))} selector={path.length ? `${target} ${path.join(' ')}` : target} tag={block?.name === 'xb/element' ? block.attrs.tag : ''} lead={contextPickers} />
        {/if}
        <p class="mini-note">{t('scrive nel CSS proprio di {0}', target)}</p>
      {:else}
        <div class="mini-toggle">{@render contextPickers()}</div>
      {/if}
      {#each segments as segment (segment.key)}
        <div class="rule">
          <div class="rule-head" title={t('Si salva nel foglio globale {0}, al posto di questa regola', segment.sheet)}>
            {segment.within.length ? segment.within.join(' › ') : t('regola')}<span>{segment.sheet}</span>
          </div>
          <div class="rule-code">
            <CodeEditor value={segment.text} language="css" onchange={(css) => editRule(segment, css)} {completions} label={t('Regola di {0} nel foglio {1}', target ?? '', segment.sheet)} />
          </div>
          {#if segment.error}<p class="error" role="status">{segment.error}</p>{/if}
        </div>
      {/each}
      {#if inSheets.length > MAX_RULES}<p class="more">{t('Altre {0} regole: aprile dal foglio globale.', inSheets.length - MAX_RULES)}</p>{/if}
    </div>
  {:else if target}
    {#if editingSheet === null}
      <div class="tools">
        {#snippet moreButton()}
          <button class="icon" data-more-toggle aria-expanded={moreOpen} aria-haspopup="true" onclick={(e) => { placeMore(e.currentTarget); moreOpen = !moreOpen; }} title={t("Query alla larghezza dell'anteprima e azioni rapide")}>{t('Altro')} ▾</button>
        {/snippet}
        {#if miniOn && target}
          {#if miniStyle === 'compact'}
            <MiniGuiCompact css={contextCss} onchange={writeContext} selector={path.length ? `${target} ${path.join(' ')}` : target} tag={block?.name === 'xb/element' ? block.attrs.tag : ''} state={ctxState} lead={contextPickers} trail={moreButton} />
          {:else}
            <MiniGui {app} css={contextCss} onchange={writeContext} selector={path.length ? `${target} ${path.join(' ')}` : target} tag={block?.name === 'xb/element' ? block.attrs.tag : ''} lead={contextPickers} trail={moreButton} />
          {/if}
        {:else}
          <div class="bar-off">{@render contextPickers()}<span class="grow"></span>{@render moreButton()}</div>
        {/if}
      </div>
      {#if moreOpen}
        <div class="more-pop" bind:this={moreEl} style={morePos} role="dialog" aria-label={t('Altro')} tabindex="-1">
          <div class="at-width" role="group" aria-label={t("Query alla larghezza dell'anteprima")}>
            <span>{t('A {0}px:', app.layoutWidth)}</span>
            <button onclick={() => quick((css) => appendQueryBlock(css, `@media ${conditionAt(app.layoutWidth, 'down')}`))} title={t('Aggiunge @media {0}: vale da questa larghezza in giù', conditionAt(app.layoutWidth, 'down'))}>{t('@media fino a qui')}</button>
            <button onclick={() => quick((css) => appendQueryBlock(css, `@media ${conditionAt(app.layoutWidth, 'up')}`))} title={t('Aggiunge @media {0}: vale da questa larghezza in su', conditionAt(app.layoutWidth, 'up'))}>{t('@media da qui in su')}</button>
            <button onclick={() => quick((css) => appendQueryBlock(css, `@container ${conditionAt(app.layoutWidth, 'down')}`))} title={t('Aggiunge @container {0}: segue la larghezza del contenitore (serve un antenato con container-type)', conditionAt(app.layoutWidth, 'down'))}>{t('@container fino a qui')}</button>
          </div>
          <div class="quick">
            <span class="quick-title">{t('Azioni rapide')}</span>
            <div class="quick-row" role="group" aria-label="Layout">
              {#each LAYOUT_ACTIONS as a (a.id)}<button onclick={() => quick((css) => applyDeclarations(css, a.decls))} title={Object.entries(a.decls).map(([k, v]) => `${k}: ${v}`).join('; ')}>{a.label}</button>{/each}
            </div>
            <div class="quick-row" role="group" aria-label={t('Spazi')}>
              <select bind:value={spaceProp} aria-label={t('Proprietà di spaziatura')}>
                <option value="gap">gap</option>
                <option value="padding">padding</option>
                <option value="padding-block">{t('padding verticale')}</option>
                <option value="padding-inline">{t('padding orizzontale')}</option>
                <option value="margin-block">{t('margine verticale')}</option>
              </select>
              {#each spacing as step (step.label)}<button onclick={() => quick((css) => applyDeclarations(css, { [spaceProp]: step.value }))} title="{spaceProp}: {step.value}">{step.label}</button>{/each}
              <button onclick={() => quick((css) => pxToRem(css))} title={t('Converte i valori in px in rem (base 16px)')}>px → rem</button>
            </div>
            <p class="quick-hint">{t("Abbreviazioni nell'editor:")} <code>df</code>, <code>dg</code>, <code>jcc</code>, <code>aic</code>, <code>mxa</code>… · {t('media query con nome:')} <code>@media (--tablet)</code> · {t('annidamento come in SCSS:')} <code>&amp;:hover</code>, <code>&amp;__titolo</code>, <code>&amp;--variante</code>, <code>@media</code> {t('dentro.')}</p>
          </div>
        </div>
      {/if}
    {/if}
    {#if editingSheet !== null}
      <!-- One row of the panel's grid: the bar and, when open, the preview of the bulk move. -->
      <div class="sheet-top">
        <div class="sheet-bar">
          <span>{t('Scrivi qui solo ciò che è davvero globale (reset,')} <code>:root</code>, {t('tag): lo stile di un blocco sta nel suo selettore, annidato come in SCSS.')}</span>
          <button class:on={bulkOpen} aria-pressed={bulkOpen} onclick={() => (bulkOpen = !bulkOpen)} title={t("Le regole di ogni blocco usato lasciano il foglio per il suo selettore, annidate come in SCSS: prima un'anteprima, poi un solo passo da annullare")}>{t('Nei selettori…')}</button>
          <button class:on={fullView} aria-pressed={fullView} onclick={() => (fullView = !fullView)} title={t('Il foglio e il CSS di ogni selettore, come arrivano nella pagina: sola lettura')}>{t('CSS completo')}</button>
        </div>
        {#if bulkOpen}<BulkMove {app} only={sheets.length > 1 ? editingSheet : undefined} onclose={() => (bulkOpen = false)} />{/if}
      </div>
    {/if}
    {#if editingSheet !== null && fullView}
      <CodeEditor value={fullCss} language="css" onchange={() => {}} readOnly label={t('CSS completo del sito')} />
    {:else}
      {#key `${target}|${editingSheet ?? ''}`}
        <CodeEditor value={text} language="css" {onchange} {completions} {diagnostics} selection={editingSheet === null ? jump : null} label={editingSheet !== null ? (sheets.length === 1 ? t('CSS globale') : t('Foglio globale {0}', editingSheet)) : t('CSS di {0}', target)} />
      {/key}
    {/if}
  {:else if block?.name === 'xb/element'}
    <form class="empty" onsubmit={addClass}>
      <p>{t("Gli stili si scrivono su una classe (o sull'id), e la mini GUI lavora sulla classe. Aggiungi una classe a questo elemento:")}</p>
      <input bind:value={newClass} placeholder={app.selected ? suggestedClass(app.tree, app.selected) : t('es. hero')} aria-label={t('Nuova classe')} />
      <button type="submit">{t('Aggiungi classe')}</button>
    </form>
  {:else}
    <p class="empty">{t("Seleziona un elemento nella struttura o nell'anteprima.")}</p>
  {/if}
</div>

<style>
  /* One row: state, width, the mini GUI's groups and «Altro»; an open group adds its rows, «Altro» floats. */
  /* Never more than 45% of the panel: the editor below always keeps the rest. */
  .tools { position: relative; padding: 4px 8px; border-bottom: 1px solid var(--xb-line); max-height: min(45cqh, 240px); overflow: auto; }
  .tools :global(.bar), .bar-off { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
  .grow { flex: 1; }
  .mini-toggle { padding: 4px 8px 0; display: flex; align-items: center; gap: 8px; }
  .mini-note { font-size: 11px; color: var(--xb-muted); }
  .mini-toggle button, .icon { font: 12px var(--xb-sans); padding: 2px 7px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; white-space: nowrap; }
  .icon[aria-expanded='true'] { border-color: var(--xb-accent); color: var(--xb-link); }
  .pick select { font: 11.5px var(--xb-mono); padding: 1px 2px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); max-width: 112px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .more-pop { position: fixed; z-index: 60; overflow: auto; background: var(--xb-bg); border: 1px solid var(--xb-line); border-radius: var(--xb-r); box-shadow: var(--xb-shadow); padding: 4px 0; }
  .at-width { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px 8px; font-size: 12px; color: var(--xb-muted); border-bottom: 1px solid var(--xb-line); }
  .at-width span { font-family: var(--xb-mono); }
  .at-width button { font: 12px var(--xb-sans); padding: 2px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .panel {
    position: relative;
    container-type: size;
    display: grid;
    grid-template-rows: auto auto 1fr;
    height: 100%;
    min-height: 0;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--xb-line);
  }
  .pills button {
    font: 12px var(--xb-mono);
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
  }
  .pills button.active {
    background: var(--xb-accent);
    border-color: var(--xb-accent);
    color: #fff;
  }
  .pills button.sheet {
    font-family: var(--xb-sans);
  }
  .views {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--xb-line);
    font-size: 12px;
    color: var(--xb-muted);
    min-width: 0;
  }
  .views button {
    font: 12px var(--xb-sans);
    padding: 2px 8px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: transparent;
    color: var(--xb-text);
    cursor: pointer;
  }
  .views button.active {
    border-color: var(--xb-accent);
    color: var(--xb-link);
  }
  .views button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .scss { margin: 0 8px 8px; border: 1px solid var(--xb-accent); border-radius: var(--xb-r); background: color-mix(in srgb, var(--xb-accent) 5%, transparent); }
  .scss-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 6px; flex-wrap: wrap; }
  .scss-head .link { border: 0; background: none; color: var(--xb-text); font: 600 12px var(--xb-sans); cursor: pointer; padding: 2px; }
  .scss-head .primary { font: 600 12px var(--xb-sans); padding: 3px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-accent); background: var(--xb-accent); color: #fff; cursor: pointer; }
  .scss-code :global(.code), .scss-code :global(.cm-editor) { height: auto; max-height: 260px; }
  .scss .note { margin: 0; padding: 4px 8px 6px; font-size: 11.5px; color: var(--xb-muted); }
  .sheet-bar { display: flex; align-items: center; gap: 8px; padding: 4px 12px; border-bottom: 1px solid var(--xb-line); font-size: 11.5px; color: var(--xb-muted); }
  .sheet-bar span { flex: 1; }
  .sheet-top { min-height: 0; }
  .sheet-bar button { font: 12px var(--xb-sans); padding: 2px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; white-space: nowrap; }
  .sheet-bar button.on { border-color: var(--xb-accent); color: var(--xb-link); }
  .rules {
    overflow: auto;
    min-height: 0;
    padding: 6px 0;
  }
  .rule {
    border-bottom: 1px solid var(--xb-line);
    padding-bottom: 4px;
  }
  .rule-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 12px;
    font: 11px var(--xb-mono);
    color: var(--xb-muted);
  }
  .rule-head span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rule-code :global(.code),
  .rule-code :global(.cm-editor) {
    height: auto;
  }
  .error {
    margin: 0;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--xb-danger);
    background: var(--xb-danger-bg);
  }
  .more {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--xb-muted);
  }
  .empty {
    padding: 16px;
    color: var(--xb-muted);
    font-size: 13px;
    display: grid;
    gap: 8px;
    align-content: start;
  }
  .empty input {
    font: 13px var(--xb-mono);
    padding: 6px 8px;
    background: var(--xb-bg);
    color: var(--xb-text);
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
  }
  .empty button {
    justify-self: start;
  }
  .quick { display: grid; gap: 6px; padding: 6px 8px; }
  .quick-title { color: var(--xb-muted); font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.05em; }
  .quick-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .quick-row button, .quick-row select { font: 11.5px var(--xb-sans); padding: 2px 8px; border: 1px solid var(--xb-line); border-radius: 12px; background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  .quick-row button:hover { border-color: var(--xb-accent); }
  .quick-hint { margin: 0; font-size: 11px; color: var(--xb-muted); }
</style>
