<script lang="ts">
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n.ts';
  import { EditorView, basicSetup } from 'codemirror';
  import { Compartment, EditorState } from '@codemirror/state';
  import { keymap } from '@codemirror/view';
  import { indentWithTab } from '@codemirror/commands';
  import { html } from '@codemirror/lang-html';
  import { css } from '@codemirror/lang-css';
  import { javascript } from '@codemirror/lang-javascript';
  import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
  import type { CompletionSource } from '@codemirror/autocomplete';
  import { foldLongValues } from '../lib/fold.ts';
  import { abbreviationBefore, cursorIn, expandAbbreviation } from '../lib/emmet.ts';
  import { Prec } from '@codemirror/state';

  interface Props {
    value: string;
    language: 'html' | 'css' | 'javascript';
    onchange: (value: string) => void;
    diagnostics?: Diagnostic[];
    label: string;
    readOnly?: boolean;
    /** Range to select and reveal (selection sync); changes to it never steal focus. */
    selection?: { from: number; to: number } | null;
    /** Called when the user moves the cursor. */
    oncursor?: (offset: number) => void;
    /** Extra completions, added to the language's own. */
    completions?: CompletionSource[];
    /** HTML: Emmet abbreviations on Tab (docs/spec/html-panel.md). */
    emmet?: boolean;
    /** Ctrl/Cmd+click or F12 at a position: true when it went somewhere (a class to its CSS). */
    ondefinition?: (doc: string, offset: number) => boolean;
  }

  let { value, language, onchange, diagnostics = [], label, readOnly = false, selection = null, oncursor, completions = [], emmet = false, ondefinition }: Props = $props();

  /** Tab after an abbreviation expands it; anything else keeps Tab's indent. */
  function expand(view: EditorView): boolean {
    if (!emmet) return false;
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const line = view.state.doc.lineAt(range.head);
    const abbr = abbreviationBefore(line.text.slice(0, range.head - line.from));
    if (!abbr) return false;
    const html = expandAbbreviation(abbr, /^\s*/.exec(line.text)?.[0] ?? '');
    if (!html) return false;
    const from = range.head - abbr.length;
    view.dispatch({ changes: { from, to: range.head, insert: html }, selection: { anchor: from + cursorIn(html) }, userEvent: 'input.complete' });
    return true;
  }
  const definition = (view: EditorView, offset: number) => !!ondefinition?.(view.state.doc.toString(), offset);

  let host: HTMLDivElement;
  /** Tab indents here: how to leave by keyboard (WCAG 2.1.2), shown while the editor has the focus (A6). */
  const hintId = `xb-tab-hint-${Math.random().toString(36).slice(2, 8)}`;
  let view: EditorView | undefined;
  let applying = false;
  // Permissions arrive with the document, after the editor is created: keep read-only switchable.
  const readOnlyCompartment = new Compartment();

  const theme = EditorView.theme(
    {
      '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--xb-panel)', color: 'var(--xb-text)' },
      '.cm-scroller': { fontFamily: 'var(--xb-mono)', lineHeight: '1.55' },
      '.cm-gutters': { backgroundColor: 'var(--xb-panel)', color: 'var(--xb-muted)', border: 'none' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--xb-hover)' },
      '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--xb-accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--xb-selection)' },
      '.cm-tooltip': { backgroundColor: 'var(--xb-bg)', color: 'var(--xb-text)', border: '1px solid var(--xb-line)' },
    },
  );
  // Syntax colours from the builder theme (light or dark), readable on both.
  const highlight = syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.tagName, tags.keyword, tags.operatorKeyword], color: 'var(--xb-syn-tag)' },
      { tag: [tags.attributeName, tags.propertyName], color: 'var(--xb-syn-attr)' },
      { tag: [tags.attributeValue, tags.string, tags.special(tags.string)], color: 'var(--xb-syn-string)' },
      { tag: [tags.number, tags.unit, tags.bool, tags.atom], color: 'var(--xb-syn-number)' },
      { tag: [tags.className, tags.labelName, tags.definition(tags.variableName)], color: 'var(--xb-syn-class)' },
      { tag: [tags.comment, tags.blockComment, tags.lineComment], color: 'var(--xb-muted)', fontStyle: 'italic' },
      { tag: [tags.angleBracket, tags.punctuation, tags.bracket, tags.separator], color: 'var(--xb-muted)' },
      { tag: tags.invalid, color: 'var(--xb-danger)' },
    ]),
  );

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          Prec.high(
            keymap.of([
              { key: 'Tab', run: expand },
              { key: 'F12', run: (view) => definition(view, view.state.selection.main.head) },
            ]),
          ),
          keymap.of([indentWithTab]),
          EditorView.domEventHandlers({
            mousedown: (event, view) => {
              if (!(event.ctrlKey || event.metaKey) || !ondefinition) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null || !definition(view, pos)) return false;
              event.preventDefault();
              return true;
            },
          }),
          language === 'html' ? [html({ autoCloseTags: true }), foldLongValues()] : language === 'css' ? css() : javascript(),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          EditorState.languageData.of(() => completions.map((autocomplete) => ({ autocomplete }))),
          lintGutter(),
          EditorView.lineWrapping,
          theme,
          highlight,
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-describedby': hintId }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applying) onchange(update.state.doc.toString());
            const userMoved = update.transactions.some((t) => t.isUserEvent('select') || t.isUserEvent('input'));
            if (update.selectionSet && userMoved && !applying) oncursor?.(update.state.selection.main.head);
          }),
        ],
      }),
    });
    return () => view?.destroy();
  });

  // External value changes (selection, undo, reload) replace the document without echoing back.
  $effect(() => {
    const next = value;
    if (!view || view.state.doc.toString() === next) return;
    applying = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    applying = false;
  });

  $effect(() => {
    const locked = readOnly;
    view?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(locked)) });
  });

  $effect(() => {
    const range = selection;
    if (!view || !range) return;
    const length = view.state.doc.length;
    applying = true;
    view.dispatch({
      selection: { anchor: Math.min(range.from, length), head: Math.min(range.to, length) },
      effects: EditorView.scrollIntoView(Math.min(range.from, length), { y: 'center' }),
    });
    applying = false;
  });

  $effect(() => {
    const list = diagnostics;
    if (!view) return;
    const length = view.state.doc.length;
    view.dispatch(
      setDiagnostics(
        view.state,
        list.map((d) => ({ ...d, from: Math.min(d.from, length), to: Math.min(Math.max(d.to, d.from), length) })),
      ),
    );
  });
</script>

<div class="wrap">
  <div class="code" bind:this={host}></div>
  <span class="tab-hint" id={hintId}>{t('Esc, poi Tab: esci dall’editor')}</span>
</div>

<style>
  /* A grid or flex item like the editor it wraps: it never grows past its row with the text (min-height 0). */
  .wrap {
    position: relative;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .tab-hint {
    display: none;
    position: absolute;
    right: 8px;
    bottom: 6px;
    padding: 1px 6px;
    border-radius: var(--xb-r-sm);
    background: var(--xb-bg);
    border: 1px solid var(--xb-line);
    color: var(--xb-muted);
    font: 11px var(--xb-sans);
    pointer-events: none;
    z-index: 1;
  }
  .wrap:focus-within .tab-hint {
    display: block;
  }
  .code {
    height: 100%;
    overflow: hidden;
  }
  .code :global(.cm-editor) {
    height: 100%;
  }
  .code :global(.cm-editor.cm-focused) {
    outline: none;
  }
  /* What a framework class does (classPreview.ts), next to the completions. */
  .code :global(.xb-class-info) {
    display: grid;
    gap: 6px;
    max-width: 420px;
  }
  .code :global(.xb-class-info pre) {
    margin: 0;
    font: 11.5px var(--xb-mono);
    white-space: pre-wrap;
    max-height: 180px;
    overflow: auto;
  }
  .code :global(.xb-class-sample) {
    display: grid;
    place-items: center;
    min-height: 8px;
    min-width: 28px;
    padding: 4px 8px;
    border-radius: 6px;
    justify-self: start;
    font: 600 12px var(--xb-sans);
  }
</style>
