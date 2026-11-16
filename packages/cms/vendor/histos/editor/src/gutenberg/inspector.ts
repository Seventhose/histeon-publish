import { parse, parseXb, print, reconcileUids, roundTrips, serializeXb, XbSyntaxError } from '@xb/dsl';
import type { DocumentData } from '../lib/api.ts';
import { balanced, prettyRule, rulesFor } from '../lib/sheet.ts';
import { classTokens, isDynamic, validClass, withClass, withoutClass } from './classes.ts';
import { AppearancePanel, ChangeNote } from './appearance.ts';
import { LogicPanel } from './logic.ts';
import { rangeOf } from '../lib/cssContext.ts';
import { blockSelectors, editStyles, HistoryButtons, ownCss, saveStyles, setOwnCss, useStyles } from './styles.ts';
import { Code } from './lazyCode.ts';
import { __, Fragment, h, useEffect, useMemo, useState, wp, type GutenbergBlock } from './wp.ts';

// The XB tabs of a block in Gutenberg's sidebar, as in the builder:
// - Classi and HTML change the blocks themselves: they go live with Gutenberg's own Save, like the texts;
// - CSS and JS are XB data with versions: they are saved to development with their own button and go live with
//   the next release. The CSS being edited is previewed in the canvas right away.

export { config } from './context.ts';
import { api, config, errorText } from './context.ts';

/** Client mode (docs/spec/client-mode.md, list 135): everything shows, nothing is written from here. */
export const client = Boolean(config?.client);
const readOnlyNote = () => h('p', { className: 'xb-insp-note' }, __('Sola lettura: qui vedi che cosa cambia e dove; le modifiche le fa chi gestisce il sito.'));

function useBlock(clientId: string): GutenbergBlock | null {
  return wp.data.useSelect((select: (store: string) => { getBlock: (id: string) => GutenbergBlock | null }) => select('core/block-editor').getBlock(clientId), [clientId]);
}

// ------------------------------------------------------------------ Classi

function ClassesTab({ block }: { block: GutenbergBlock }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const { updateBlockAttributes } = wp.data.useDispatch('core/block-editor');
  if (block.name !== 'xb/element') return h('p', { className: 'xb-insp-note' }, __('Le classi stanno sugli elementi: seleziona un elemento.'));
  const attrs: Record<string, unknown> = block.attributes.attributes ?? {};
  if (client) {
    const tokens = classTokens(attrs.class);
    return h(Fragment, null, h('div', { className: 'xb-insp-chips' }, tokens.length ? tokens.map((token) => h('span', { key: token, className: 'xb-insp-chip' }, '.' + token)) : h('span', { className: 'xb-insp-note' }, __('Nessuna classe.'))), readOnlyNote());
  }
  const set = (cls: string, id?: string) => {
    const next: Record<string, unknown> = { ...attrs };
    if (cls.trim() === '') delete next.class;
    else next.class = cls;
    if (id !== undefined) {
      if (id.trim() === '') delete next.id;
      else next.id = id.trim();
    }
    updateBlockAttributes(block.clientId, { attributes: next });
  };
  const add = (event: Event) => {
    event.preventDefault();
    const value = name.trim();
    if (!validClass(value)) {
      setError(__('Nome non valido: lettere, cifre, - e _, senza iniziare con una cifra.'));
      return;
    }
    setError('');
    set(withClass(attrs.class, value));
    setName('');
  };
  return h(
    Fragment,
    null,
    h(
      'div',
      { className: 'xb-insp-chips' },
      classTokens(attrs.class).map((token) =>
        h(
          'span',
          { key: token, className: 'xb-insp-chip' + (isDynamic(token) ? ' is-dynamic' : ''), title: isDynamic(token) ? __('Classe con un\'espressione: si modifica nell\'HTML') : undefined },
          '.' + token,
          isDynamic(token) ? null : h('button', { type: 'button', onClick: () => set(withoutClass(attrs.class, token)), 'aria-label': __('Rimuovi {0}', token) }, '×'),
        ),
      ),
      classTokens(attrs.class).length === 0 ? h('span', { className: 'xb-insp-note' }, __('Nessuna classe.')) : null,
    ),
    h(
      'form',
      { className: 'xb-insp-row', onSubmit: add },
      h('input', { value: name, onChange: (e: Event) => setName((e.target as HTMLInputElement).value), placeholder: __('nuova-classe'), 'aria-label': __('Nuova classe'), spellCheck: false }),
      h(wp.components.Button, { variant: 'secondary', type: 'submit', disabled: name.trim() === '' }, __('Aggiungi')),
    ),
    error ? h('p', { className: 'xb-insp-error' }, error) : null,
    h(
      'label',
      { className: 'xb-insp-field' },
      __('ID'),
      h('input', {
        defaultValue: typeof attrs.id === 'string' ? attrs.id : '',
        key: String(attrs.id ?? ''),
        spellCheck: false,
        onBlur: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          if (v !== (attrs.id ?? '') && (v === '' || /^[A-Za-z][\w:.-]*$/.test(v))) set(String(attrs.class ?? ''), v);
        },
      }),
    ),
  );
}

// ------------------------------------------------------------------ HTML

export function HtmlTab({ block, fill = false }: { block: GutenbergBlock; fill?: boolean }) {
  const markup = wp.blocks.serialize([block]) as string;
  const printed = useMemo(() => {
    const { blocks } = parseXb(markup);
    try {
      return { text: print(blocks), faithful: roundTrips(blocks), blocks };
    } catch {
      return { text: '', faithful: false, blocks };
    }
  }, [markup]);
  const [draft, setDraft] = useState(printed.text);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(printed.text);
    setError('');
  }, [printed.text]);
  const { replaceBlocks } = wp.data.useDispatch('core/block-editor');
  const apply = () => {
    try {
      const { blocks } = parse(draft);
      if (blocks.length === 0) {
        setError(__('Il codice è vuoto: per eliminare il blocco usa Gutenberg.'));
        return;
      }
      const next = wp.blocks.parse(serializeXb(reconcileUids(printed.blocks, blocks))) as GutenbergBlock[];
      setError('');
      replaceBlocks(block.clientId, next);
    } catch (e) {
      setError(e instanceof XbSyntaxError ? `${e.message}` : errorText(e));
    }
  };
  return h(
    Fragment,
    null,
    printed.faithful ? null : h('p', { className: 'xb-insp-note' }, __('Questo blocco contiene contenuto che il codice non rappresenta fedelmente: sola lettura.')),
    h(Code, { value: draft, language: 'html', onChange: setDraft, readOnly: client || !printed.faithful, label: __('HTML del blocco'), fill }),
    client ? readOnlyNote() : null,
    error ? h('p', { className: 'xb-insp-error' }, error) : null,
    h(
      'div',
      { className: 'xb-insp-row' },
      client ? null : h(wp.components.Button, { variant: 'primary', onClick: apply, disabled: !printed.faithful || draft === printed.text }, __('Applica')),
      client ? null : h(wp.components.Button, { variant: 'tertiary', onClick: () => setDraft(printed.text), disabled: draft === printed.text }, __('Annulla')),
    ),
    h('p', { className: 'xb-insp-note' }, __('Le modifiche vanno online con il Salva di Gutenberg.')),
  );
}

// ------------------------------------------------------------------ CSS (the shared store is styles.ts)

/** Where the declaration a visual control wrote sits in the selector's CSS, for the editor to select it (132). */
export function declarationRange(css: string, path: string[], prop: string, at: number): { from: number; to: number; at: number } | undefined {
  const body = path.length ? rangeOf(css, path) : { from: 0, to: css.length };
  if (!body) return undefined;
  const text = css.slice(body.from, body.to);
  const match = new RegExp(`(^|[\\s;{])(${prop.replace(/[-]/g, '\\-')}\\s*:[^;{}]*;?)`, 'm').exec(text);
  if (!match) return undefined;
  const from = body.from + match.index + match[1]!.length;
  return { from, to: from + match[2]!.length, at };
}

export function CssTab({ block }: { block: GutenbergBlock }) {
  const state = useStyles();
  const selectors = blockSelectors(block);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = chosen && selectors.includes(chosen) ? chosen : (selectors[0] ?? null);
  if (block.name !== 'xb/element') return h('p', { className: 'xb-insp-note' }, __('Il CSS si scrive sulle classi di un elemento: seleziona un elemento.'));
  if (!state.data) return h('p', { className: 'xb-insp-note' }, state.error || __('Caricamento degli stili…'));
  const data = state.data;
  const own = target ? ownCss(data, target) : '';
  const rules = target?.startsWith('.') ? data.globals.flatMap((g) => rulesFor(g.css, target.slice(1)).map((r) => ({ ...r, sheet: g.id }))) : [];

  const setOwn = (css: string) => {
    if (target) setOwnCss(target, css);
  };
  const setRule = (sheet: string, from: number, to: number, written: string, css: string) => {
    if (!balanced(css)) return;
    editStyles((d) => ({
      ...d,
      globals: d.globals.map((g) => (g.id === sheet && g.css.slice(from, to) === written ? { ...g, css: g.css.slice(0, from) + css + g.css.slice(to) } : g)),
    }));
  };

  return h(
    Fragment,
    null,
    selectors.length === 0
      ? h('p', { className: 'xb-insp-note' }, __('Aggiungi una classe (scheda Classi) per scriverne il CSS.'))
      : h(
          'div',
          { className: 'xb-insp-chips' },
          selectors.map((s) => h('button', { key: s, type: 'button', className: 'xb-insp-pill' + (s === target ? ' is-active' : ''), onClick: () => setChosen(s) }, s)),
        ),
    target ? h('p', { className: 'xb-insp-label' }, __('CSS proprio')) : null,
    target && state.change?.selector === target ? h(ChangeNote, { change: state.change }) : null,
    target ? h(Code, { key: 'own:' + target, value: own, language: 'css', onChange: setOwn, readOnly: client, label: __('CSS di {0}', target), height: 200, highlight: state.change?.selector === target ? declarationRange(own, state.change.path, state.change.prop, state.change.at) : undefined }) : null,
    ...rules.map((r) => {
      const written = data.globals.find((g) => g.id === r.sheet)?.css.slice(r.from, r.to) ?? '';
      return h(
        'div',
        { key: `${r.sheet}:${r.from}` },
        h('p', { className: 'xb-insp-label' }, (r.within.length ? r.within.join(' › ') + ' · ' : '') + __('nel foglio {0}', r.sheet)),
        h(Code, { value: prettyRule(written), language: 'css', readOnly: client, onChange: (css: string) => setRule(r.sheet, r.from, r.to, written, css), label: __('Regola nel foglio {0}', r.sheet), height: 200 }),
      );
    }),
    client ? null : h(HistoryButtons),
    state.error ? h('p', { className: 'xb-insp-error' }, state.error) : null,
    h(
      'div',
      { className: 'xb-insp-row' },
      client ? readOnlyNote() : h(wp.components.Button, { variant: 'primary', onClick: () => void saveStyles(), disabled: !state.dirty || state.saving, isBusy: state.saving }, __('Salva in sviluppo')),
    ),
    h('p', { className: 'xb-insp-note' }, state.dirty ? __('Anteprima nella pagina: salvala in sviluppo, poi pubblica una release per metterla online.') : __('Gli stili si pubblicano con le release di Histeon.')),
  );
}

// ------------------------------------------------------------------ JS (the page's script)

export function JsTab({ fill = false }: { fill?: boolean } = {}) {
  const [doc, setDoc] = useState<DocumentData | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!api || !config) return;
    api
      .getDocument(config.postId)
      .then((d) => {
        setDoc(d);
        setText(d.script);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  if (!doc) return h('p', { className: error ? 'xb-insp-error' : 'xb-insp-note' }, error || __('Caricamento…'));
  const save = async () => {
    if (!api || !config) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveDocument(config.postId, doc.content, doc.head, doc.base, { script: text });
      setDoc(saved);
      setText(saved.script);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return h(
    Fragment,
    null,
    doc.scriptEditable ? null : h('p', { className: 'xb-insp-note' }, __('Solo chi può pubblicare HTML non filtrato modifica il JavaScript.')),
    h(Code, { value: text, language: 'javascript', onChange: setText, readOnly: client || !doc.scriptEditable, label: __('JavaScript della pagina'), fill }),
    error ? h('p', { className: 'xb-insp-error' }, error) : null,
    h(
      'div',
      { className: 'xb-insp-row' },
      client ? readOnlyNote() : h(wp.components.Button, { variant: 'primary', onClick: () => void save(), disabled: !doc.scriptEditable || text === doc.script || saving, isBusy: saving }, __('Salva in sviluppo')),
    ),
    h('p', { className: 'xb-insp-note' }, __('Il JavaScript della pagina va online con la prossima release di Histeon.')),
  );
}

// ------------------------------------------------------------------ panel

// The sidebar keeps the classes; HTML, CSS and JS are in the dock under the canvas (dock.ts).
function XbPanel({ clientId }: { clientId: string }) {
  const block = useBlock(clientId);
  if (!block) return null;
  return h(
    Fragment,
    null,
    block.name === 'xb/element' ? h(wp.components.PanelBody, { title: __('Histeon · Aspetto'), initialOpen: true, className: 'xb-insp xb-look' }, h('div', { className: 'xb-insp-body' }, h(AppearancePanel, { block }))) : null,
    block.name === 'xb/loop' || block.name === 'xb/branch'
      ? h(wp.components.PanelBody, { title: block.name === 'xb/loop' ? __('Histeon · Ripeti') : __('Histeon · Condizione'), initialOpen: true, className: 'xb-insp' }, h('div', { className: 'xb-insp-body' }, h(LogicPanel, { block })))
      : null,
    h(wp.components.PanelBody, { title: __('Histeon · Classi'), initialOpen: block.name !== 'xb/element', className: 'xb-insp' }, h('div', { className: 'xb-insp-body' }, h(ClassesTab, { block }))),
  );
}

export function register(): void {
  if (!config || !api) return;
  const withXb = wp.compose.createHigherOrderComponent(
    (BlockEdit: unknown) => (props: { name?: string; isSelected?: boolean; clientId: string }) =>
      typeof props.name === 'string' && props.name.startsWith('xb/') && props.isSelected
        ? h(Fragment, null, h(BlockEdit, props), h(wp.blockEditor.InspectorControls, null, h(XbPanel, { clientId: props.clientId })))
        : h(BlockEdit, props),
    'withXbInspector',
  );
  wp.hooks.addFilter('editor.BlockEdit', 'xb/inspector', withXb);
}
