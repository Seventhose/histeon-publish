import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { h, useEffect, useRef } from './wp.ts';

/** CodeMirror in the Gutenberg sidebar. The text it is given replaces the document only when it differs. */
export function Code(props: { value: string; language: 'html' | 'css' | 'javascript'; onChange: (value: string) => void; readOnly?: boolean; label: string; height?: number; fill?: boolean; highlight?: { from: number; to: number; at: number } }) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const lock = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          props.language === 'html' ? html() : props.language === 'css' ? css() : javascript(),
          EditorView.lineWrapping,
          lock.current.of(EditorState.readOnly.of(props.readOnly === true)),
          EditorView.contentAttributes.of({ 'aria-label': props.label }),
          EditorView.theme({ '&': props.fill ? { fontSize: '12px', height: '100%' } : { fontSize: '12px', maxHeight: `${props.height ?? 320}px` }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && u.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('delete') || t.isUserEvent('undo') || t.isUserEvent('redo') || t.isUserEvent('move'))) {
              onChange.current(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure(EditorState.readOnly.of(props.readOnly === true)) });
  }, [props.readOnly]);

  // A visual control just wrote here (lista della spesa 132): select the declaration and bring it into view.
  useEffect(() => {
    const v = view.current;
    const mark = props.highlight;
    if (!v || !mark || mark.to > v.state.doc.length) return;
    v.dispatch({ selection: { anchor: mark.from, head: mark.to }, scrollIntoView: true });
  }, [props.highlight?.at, props.value]);

  return h('div', { ref: host, className: 'xb-insp-code' + (props.fill ? ' is-fill' : '') });
}
