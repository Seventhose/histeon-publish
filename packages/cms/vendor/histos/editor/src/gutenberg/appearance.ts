// «Aspetto», the visual panel of a Histeon element in Gutenberg (lista della spesa 130): spaces, colours, text,
// layout and borders as buttons with the framework's tokens, for people who do not write CSS. It is the builder's
// mini GUI (docs/spec/styles.md §9-§10) with words instead of property names. Every button writes a real
// declaration into the selector's own CSS through the shared store (styles.ts), so the CSS tab and the dock show the
// same text at once, and the code says what changed (132).
import { bodyAt, setBodyAt, STATES } from '../lib/cssContext.ts';
import { declarations, GROUPS, groupIsSet, optionsFor, relevant, scalesFrom, setDeclaration, type Control, type Option } from '../lib/miniGui.ts';
import { config } from './context.ts';
import { blockSelectors, HistoryButtons, ownCss, saveStyles, setOwnCss, useFramework, useStyles } from './styles.ts';
import { pageCssOf } from '../lib/pageLook.ts';
import { lookGroups, savePageStyles, setPageLook, usePageStyles } from './pageStyles.ts';
import { __, Fragment, h, useState, wp, type GutenbergBlock } from './wp.ts';

/** The words a client reads instead of property names. */
export const LABELS: Record<string, string> = {
  display: 'Disposizione',
  'flex-direction': 'Direzione',
  'flex-wrap': 'A capo',
  'grid-template-columns': 'Colonne',
  'justify-content': 'Distribuzione',
  'align-items': 'Allineamento',
  gap: 'Distanza tra gli elementi',
  padding: 'Spazio interno',
  'padding-block': 'Spazio interno sopra e sotto',
  'padding-inline': 'Spazio interno ai lati',
  'margin-block': 'Spazio esterno sopra e sotto',
  'margin-inline': 'Margini ai lati',
  width: 'Larghezza',
  'max-width': 'Larghezza massima',
  'min-height': 'Altezza minima',
  'aspect-ratio': 'Proporzioni',
  'object-fit': 'Adattamento',
  'font-size': 'Dimensione del testo',
  'font-weight': 'Spessore del testo',
  'line-height': 'Interlinea',
  'text-align': 'Allineamento del testo',
  'text-wrap': 'Ritorno a capo',
  color: 'Colore del testo',
  background: 'Sfondo',
  'border-radius': 'Angoli arrotondati',
  'box-shadow': 'Ombra',
  border: 'Bordo',
  opacity: 'Opacità',
  position: 'Posizione',
  inset: 'Ancorato ai bordi',
  'z-index': 'Livello',
  overflow: 'Contenuto che esce',
  'container-type': 'Contenitore per le query',
};

const VALUE_LABELS: Record<string, string> = {
  block: 'Blocco',
  flex: 'In fila',
  grid: 'Griglia',
  'inline-flex': 'In linea',
  none: 'Nessuno',
  row: 'Orizzontale',
  column: 'Verticale',
  wrap: 'Sì',
  nowrap: 'No',
  start: 'Inizio',
  center: 'Centro',
  end: 'Fine',
  stretch: 'Riempi',
  'space-between': 'Distribuiti',
  auto: 'Automatico',
  '100%': 'Tutta',
  'fit-content': 'Il contenuto',
  balance: 'Bilanciato',
  pretty: 'Curato',
  cover: 'Riempi',
  contain: 'Contieni',
  relative: 'Relativa',
  absolute: 'Assoluta',
  sticky: 'Fissa scorrendo',
  hidden: 'Nascosto',
  clip: 'Tagliato',
  'inline-size': 'Sì',
  '1px solid currentColor': 'Sottile',
  '999px': 'Pillola',
};

/** A value as the client reads it: the token's step (`m`, `primary`), or a word for the common keywords. */
export function valueLabel(option: Option): string {
  return VALUE_LABELS[option.value] ? __(VALUE_LABELS[option.value]!) : option.label;
}

/** Where a button writes: the rule itself, a width, a state, or a state at a width (styles.md §10). */
export function contextPath(width: string, state: string): string[] {
  return [width, state].filter(Boolean);
}

/** The selector's CSS with one declaration set (or removed, null) in the block at `path`. */
export function applyDeclaration(css: string, path: string[], prop: string, value: string | null): string {
  return setBodyAt(css, path, setDeclaration(bodyAt(css, path), prop, value));
}

export function AppearancePanel({ block }: { block: GutenbergBlock }) {
  const state = useStyles();
  const framework = useFramework();
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState<string>('space');
  const [width, setWidth] = useState('');
  const [stateKey, setStateKey] = useState('');
  // Voce 186: where the buttons write. A client with the page's look writes only there; who builds chooses.
  const look = usePageStyles();
  const [onlyPage, setOnlyPage] = useState(false);
  const selectors = blockSelectors(block);
  const target = chosen && selectors.includes(chosen) ? chosen : (selectors[0] ?? null);

  if (block.name !== 'xb/element') return h('p', { className: 'xb-insp-note' }, __('L’aspetto si cambia sugli elementi: seleziona un elemento.'));
  if (!target) return h('p', { className: 'xb-insp-note' }, __('Dai un nome a questo elemento (una classe, qui sotto) per cambiarne l’aspetto.'));
  if (!state.data) return h('p', { className: 'xb-insp-note' }, state.error || __('Caricamento degli stili…'));

  const data = state.data;
  const client = Boolean(config?.client);
  const pageMode = lookGroups.length > 0 && (client || onlyPage) && look.entries !== null;
  const css = pageMode ? pageCssOf(look.entries ?? [], target) : ownCss(data, target);
  const path = contextPath(width, stateKey);
  const current = declarations(bodyAt(css, path));
  const scales = scalesFrom(framework?.variables ?? []);
  const swatches = new Map((framework?.variables ?? []).filter((v) => v.value).map((v) => [`var(--${v.name})`, v.value as string]));
  const tag = typeof block.attributes.tag === 'string' ? block.attributes.tag : '';

  // Client mode (list 135): the panel shows what is set, its buttons do not write, except on the page's own look.
  const write = (control: Control, value: string | null) => {
    if (pageMode) {
      setPageLook(target, path, control.prop, value);
      return;
    }
    if (client) return;
    const before = current[control.prop] ?? null;
    setOwnCss(target, applyDeclaration(css, path, control.prop, value), { selector: target, prop: control.prop, before, after: value, path, at: Date.now() });
  };

  const control = (c: Control) => {
    const options = optionsFor(c, scales);
    const value = current[c.prop];
    const known = options.some((o) => o.value === value);
    const pills = [...options, ...(value !== undefined && !known ? [{ label: value, value }] : [])];
    const isColor = c.kind === 'scale' && c.scale === 'color';
    return h(
      'div',
      { key: c.prop, className: 'xb-look-control', role: 'group', 'aria-label': __(LABELS[c.prop] ?? c.prop) },
      h('span', { className: 'xb-look-label' }, __(LABELS[c.prop] ?? c.prop), h('code', null, c.prop)),
      pills.length === 0
        ? h('span', { className: 'xb-insp-note' }, __('Il framework non ha questa scala.'))
        : h(
            'div',
            { className: 'xb-look-options' },
            pills.map((o) => {
              const active = o.value === value;
              const swatch = isColor ? swatches.get(o.value) : undefined;
              const declaration = c.prop + ': ' + o.value;
              return h(
                'button',
                {
                  key: o.value,
                  type: 'button',
                  className: 'xb-insp-pill' + (active ? ' is-active' : '') + (swatch ? ' has-swatch' : ''),
                  'aria-pressed': active,
                  disabled: client && !pageMode && !active,
                  title: active ? __('Togli: {0}', declaration) : declaration,
                  onClick: () => write(c, active ? null : o.value),
                },
                swatch ? h('span', { className: 'xb-look-swatch', style: { background: swatch } }) : null,
                valueLabel(o),
              );
            }),
          ),
    );
  };

  // A client sees only the groups he was given for the page's look.
  const groups = pageMode && client ? GROUPS.filter((g) => lookGroups.includes(g.id)) : GROUPS;
  const group = groups.find((g) => g.id === open) ?? groups[0]!;
  const shown = group.controls.filter((c) => relevant(c, current, tag));
  const hidden = group.controls.length - shown.length;
  const queries = Object.keys(data.queries ?? {});

  return h(
    Fragment,
    null,
    selectors.length > 1
      ? h(
          'div',
          { className: 'xb-insp-chips' },
          selectors.map((s) => h('button', { key: s, type: 'button', className: 'xb-insp-pill' + (s === target ? ' is-active' : ''), onClick: () => setChosen(s) }, s)),
        )
      : null,
    h(
      'div',
      { className: 'xb-look-context' },
      h(wp.components.SelectControl, {
        label: __('Quando'),
        value: stateKey,
        options: [{ label: __('Sempre'), value: '' }, ...STATES.map((s) => ({ label: s.label, value: s.prelude }))],
        onChange: setStateKey,
        __nextHasNoMarginBottom: true,
      }),
      h(wp.components.SelectControl, {
        label: __('Su quali schermi'),
        value: width,
        options: [{ label: __('Tutti'), value: '' }, ...queries.map((q) => ({ label: q, value: `@media (--${q})` }))],
        onChange: setWidth,
        __nextHasNoMarginBottom: true,
      }),
    ),
    lookGroups.length > 0 && !client
      ? h(wp.components.ToggleControl, {
          label: __('Solo questa pagina'),
          help: onlyPage ? __('Scrive uno stile proprio di questa pagina: la classe resta com’è sulle altre.') : __('Scrive nella classe: vale su tutto il sito.'),
          checked: onlyPage,
          onChange: (on: boolean) => setOnlyPage(on),
          __nextHasNoMarginBottom: true,
        })
      : null,
    h(
      'div',
      { className: 'xb-look-groups', role: 'tablist' },
      groups.map((g) =>
        h(
          'button',
          { key: g.id, type: 'button', role: 'tab', 'aria-selected': g.id === group.id, className: 'xb-look-group' + (g.id === group.id ? ' is-active' : ''), onClick: () => setOpen(g.id) },
          g.id === 'layout' ? __('Impaginazione') : g.label,
          groupIsSet(g, current) ? h('span', { className: 'xb-look-dot', 'aria-label': __('con valori') }) : null,
        ),
      ),
    ),
    h('div', { className: 'xb-look-body', role: 'tabpanel' }, shown.map(control)),
    hidden > 0 ? h('p', { className: 'xb-insp-note' }, __('{0} impostazioni compaiono quando servono (per esempio le colonne con la griglia).', String(hidden))) : null,
    !pageMode && state.change && state.change.selector === target ? h(ChangeNote, { change: state.change }) : null,
    client || pageMode ? null : h(HistoryButtons),
    !pageMode && state.error ? h('p', { className: 'xb-insp-error' }, state.error) : null,
    pageMode && look.error ? h('p', { className: 'xb-insp-error', role: 'alert' }, look.error) : null,
    pageMode
      ? h(
          'div',
          { className: 'xb-insp-row' },
          h(wp.components.Button, { variant: 'primary', onClick: () => void savePageStyles(), disabled: !look.dirty || look.saving, isBusy: look.saving }, __('Salva in sviluppo')),
          h('p', { className: 'xb-insp-note' }, __('Vale solo per questa pagina: la stessa classe sulle altre pagine resta com’è. Va online con la prossima pubblicazione.')),
        )
      : h(
          'div',
          { className: 'xb-insp-row' },
          client
            ? h('p', { className: 'xb-insp-note' }, __('Sola lettura: qui vedi che cosa cambia e dove; le modifiche le fa chi gestisce il sito.'))
            : h(wp.components.Button, { variant: 'primary', onClick: () => void saveStyles(), disabled: !state.dirty || state.saving, isBusy: state.saving }, __('Salva in sviluppo')),
        ),
  );
}

/** What the last button changed, in words and in code (132). */
export function ChangeNote({ change }: { change: { selector: string; prop: string; before: string | null; after: string | null; path: string[] } }) {
  const where = change.path.length ? ` (${change.path.join(' › ')})` : '';
  const text =
    change.after === null
      ? __('Tolto {0} da {1}{2}.', change.prop, change.selector, where)
      : change.before === null
        ? __('Aggiunto {0}: {1} a {2}{3}.', change.prop, change.after, change.selector, where)
        : __('{0} di {1}{2}: da {3} a {4}.', change.prop, change.selector, where, change.before, change.after);
  return h('p', { className: 'xb-look-change', role: 'status' }, text, ' ', __('Lo vedi evidenziato nel CSS, sotto la pagina.'));
}
