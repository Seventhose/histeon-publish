import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { t } from './i18n.ts';

// Long attribute values (srcset, sizes, SVG paths, inline styles) fold to their first characters in the HTML
// panel, so the structure stays readable; a click on the marker shows the whole value. Only the view changes:
// the text, and what is saved, are untouched.

/** Values longer than this fold; KEEP characters stay visible. */
export const FOLD_OVER = 80;
const KEEP = 24;
const VALUE = /\s[a-zA-Z_:@][a-zA-Z0-9_:.@-]*="([^"]*)"/g;

/** The ranges to hide: [from, to) inside each long value, past its first characters. */
export function longValues(text: string): Array<{ start: number; from: number; to: number }> {
  const out: Array<{ start: number; from: number; to: number }> = [];
  for (const m of text.matchAll(VALUE)) {
    const value = m[1] ?? '';
    if (value.length <= FOLD_OVER) continue;
    const start = (m.index ?? 0) + m[0].length - 1 - value.length;
    out.push({ start, from: start + KEEP, to: start + value.length });
  }
  return out;
}

const expand = StateEffect.define<number>();

/** Values the user opened, by their start offset (kept in step with edits). */
const expanded = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) next = new Set([...value].map((p) => tr.changes.mapPos(p)));
    for (const e of tr.effects) if (e.is(expand)) next = new Set([...next, e.value]);
    return next;
  },
});

class Marker extends WidgetType {
  constructor(
    readonly start: number,
    readonly hidden: number,
  ) {
    super();
  }
  override eq(other: Marker): boolean {
    return other.start === this.start && other.hidden === this.hidden;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cm-xb-fold';
    el.textContent = `… +${this.hidden}`;
    el.title = t('Mostra tutto il valore');
    el.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ effects: expand.of(this.start) });
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function build(text: string, open: ReadonlySet<number>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { start, from, to } of longValues(text)) {
    if (!open.has(start)) builder.add(from, to, Decoration.replace({ widget: new Marker(start, to - from) }));
  }
  return builder.finish();
}

const folds = StateField.define<DecorationSet>({
  create: (state) => build(state.doc.toString(), state.field(expanded)),
  update(value, tr) {
    if (!tr.docChanged && !tr.effects.some((e) => e.is(expand))) return value;
    return build(tr.state.doc.toString(), tr.state.field(expanded));
  },
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
});

export function foldLongValues(): Extension {
  return [
    expanded,
    folds,
    EditorView.baseTheme({
      '.cm-xb-fold': {
        font: 'inherit',
        fontSize: '11px',
        padding: '0 4px',
        margin: '0 2px',
        border: '1px solid var(--xb-line)',
        borderRadius: '3px',
        background: 'var(--xb-hover)',
        color: 'var(--xb-muted)',
        cursor: 'pointer',
      },
    }),
  ];
}
