// The compact mini GUI (docs/spec/styles.md §9): groups of small buttons, each
// writing one or more declarations with a starting value into the selector's CSS, where the value is then edited
// by hand. A group appears when it makes sense here: grid settings for a grid, alignment for flex or grid, text
// settings for a text element, filters for an image, motion in a state such as :hover. The values are Histeon's
// (tokens with a fallback), so they work with any framework.
import { t } from './i18n.ts';

export interface CompactContext {
  /** The declarations the CSS has now (property → value). */
  decls: Record<string, string>;
  /** The element's tag (lowercase), '' when not an element. */
  tag: string;
  /** The state the mini GUI writes into (`:hover`…), null for the rule itself. */
  state: string | null;
}

export interface CompactSnippet {
  id: string;
  label: string;
  /** A short mark for the button: letters or a symbol, never an image. */
  mark: string;
  set: Record<string, string>;
  /** Properties the snippet takes away (a grid needs no flex-direction). */
  clears?: string[];
}

export interface CompactGroup {
  id: string;
  label: string;
  when?: (context: CompactContext) => boolean;
  snippets: CompactSnippet[];
}

const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'blockquote', 'figcaption', 'strong', 'em', 'small', 'button', 'dt', 'dd', 'cite', 'q', 'time', 'legend', 'summary', 'caption', 'th', 'td']);
const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'svg', 'iframe', 'canvas']);
const display = (c: CompactContext) => (c.decls.display ?? '').trim();

export const COMPACT_GROUPS: CompactGroup[] = [
  {
    id: 'display',
    label: t('Display'),
    snippets: [
      { id: 'flex-row', label: t('Flex in riga'), mark: '⇢', set: { display: 'flex', 'flex-direction': 'row' } },
      { id: 'flex-column', label: t('Flex in colonna'), mark: '⇣', set: { display: 'flex', 'flex-direction': 'column' } },
      { id: 'grid', label: t('Griglia'), mark: '▦', set: { display: 'grid' }, clears: ['flex-direction'] },
    ],
  },
  {
    id: 'grid',
    label: t('Griglia'),
    when: (c) => display(c) === 'grid' || display(c) === 'inline-grid',
    snippets: [
      { id: 'columns', label: t('Colonne'), mark: '|||', set: { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' } },
      { id: 'rows', label: t('Righe'), mark: '☰', set: { 'grid-template-rows': 'auto' } },
      { id: 'areas', label: t('Aree'), mark: '⊞', set: { 'grid-template-areas': "'a a' 'b c'" } },
      { id: 'auto-rows', label: t('Righe automatiche'), mark: '≡', set: { 'grid-auto-rows': '1fr' } },
      { id: 'gap', label: t('Spazio tra le celle'), mark: '↔', set: { gap: 'var(--xb-space-m, 1rem)' } },
    ],
  },
  {
    id: 'justify',
    label: t('Distribuisci'),
    when: (c) => display(c) === 'flex' || display(c) === 'inline-flex',
    snippets: [
      { id: 'start', label: t('All’inizio'), mark: '⇤', set: { 'justify-content': 'start' } },
      { id: 'center', label: t('Al centro'), mark: '↹', set: { 'justify-content': 'center' } },
      { id: 'end', label: t('Alla fine'), mark: '⇥', set: { 'justify-content': 'end' } },
      { id: 'between', label: t('Spazio tra'), mark: '⟷', set: { 'justify-content': 'space-between' } },
      { id: 'evenly', label: t('Spazio uguale'), mark: '⋯', set: { 'justify-content': 'space-evenly' } },
      { id: 'gap', label: t('Spazio tra gli elementi'), mark: '↔', set: { gap: 'var(--xb-space-m, 1rem)' } },
    ],
  },
  {
    id: 'align',
    label: t('Allinea'),
    when: (c) => ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display(c)),
    snippets: [
      { id: 'start', label: t('In alto'), mark: '⤒', set: { 'align-items': 'start' } },
      { id: 'center', label: t('Al centro'), mark: '↕', set: { 'align-items': 'center' } },
      { id: 'end', label: t('In basso'), mark: '⤓', set: { 'align-items': 'end' } },
      { id: 'stretch', label: t('Estendi'), mark: '⇳', set: { 'align-items': 'stretch' } },
    ],
  },
  {
    id: 'motion',
    label: t('Movimento'),
    when: (c) => c.state !== null && /:(hover|focus|focus-visible|focus-within|active)\b/.test(c.state),
    snippets: [
      { id: 'translate', label: t('Sposta'), mark: '↗', set: { translate: '0 -0.25rem' } },
      { id: 'scale', label: t('Ingrandisci'), mark: '⤢', set: { scale: '1.05' } },
      { id: 'rotate', label: t('Ruota'), mark: '↻', set: { rotate: '3deg' } },
      { id: 'shadow', label: t('Ombra'), mark: '◩', set: { 'box-shadow': 'var(--xb-shadow-m, 0 0.5rem 1.5rem rgb(0 0 0 / 0.15))' } },
    ],
  },
  {
    id: 'transition',
    label: t('Transizione'),
    when: (c) => c.state === null,
    snippets: [
      { id: 'transition', label: t('Transizione'), mark: '∿', set: { 'transition-property': 'all', 'transition-duration': '0.3s', 'transition-timing-function': 'ease' } },
    ],
  },
  {
    id: 'position',
    label: t('Posizione'),
    snippets: [
      { id: 'relative', label: t('Relativa'), mark: 'R', set: { position: 'relative' } },
      { id: 'absolute', label: t('Assoluta'), mark: 'A', set: { position: 'absolute' } },
      { id: 'top', label: t('Distanza dall’alto'), mark: '⊤', set: { 'inset-block-start': '0' } },
      { id: 'right', label: t('Distanza da destra'), mark: '⊣', set: { 'inset-inline-end': '0' } },
      { id: 'bottom', label: t('Distanza dal basso'), mark: '⊥', set: { 'inset-block-end': '0' } },
      { id: 'left', label: t('Distanza da sinistra'), mark: '⊢', set: { 'inset-inline-start': '0' } },
      { id: 'z', label: t('Livello'), mark: 'z', set: { 'z-index': '1' } },
    ],
  },
  {
    id: 'text',
    label: t('Testo'),
    when: (c) => TEXT_TAGS.has(c.tag),
    snippets: [
      { id: 'size', label: t('Dimensione del testo'), mark: 'Aa', set: { 'font-size': 'var(--xb-text-l, 1.25rem)' } },
      { id: 'weight', label: t('Grassetto'), mark: 'B', set: { 'font-weight': '700' } },
      { id: 'line', label: t('Interlinea'), mark: '↨', set: { 'line-height': '1.2' } },
      { id: 'spacing', label: t('Spaziatura delle lettere'), mark: 'A·A', set: { 'letter-spacing': '0.02em' } },
      { id: 'color', label: t('Colore del testo'), mark: 'A●', set: { color: 'var(--xb-text, currentColor)' } },
      { id: 'left', label: t('Allinea a sinistra'), mark: '⫷', set: { 'text-align': 'start' } },
      { id: 'center', label: t('Centra il testo'), mark: '≡', set: { 'text-align': 'center' } },
      { id: 'right', label: t('Allinea a destra'), mark: '⫸', set: { 'text-align': 'end' } },
      { id: 'justify', label: t('Giustifica'), mark: '☰', set: { 'text-align': 'justify' } },
    ],
  },
  {
    id: 'media',
    label: t('Immagine'),
    when: (c) => MEDIA_TAGS.has(c.tag),
    snippets: [
      { id: 'cover', label: t('Copri'), mark: '▣', set: { 'object-fit': 'cover' } },
      { id: 'contain', label: t('Contieni'), mark: '▢', set: { 'object-fit': 'contain' } },
      { id: 'ratio', label: t('Proporzioni'), mark: '16:9', set: { 'aspect-ratio': '16 / 9' } },
      { id: 'brightness', label: t('Luminosità'), mark: '☀', set: { filter: 'brightness(1.2)' } },
      { id: 'saturate', label: t('Saturazione'), mark: '◐', set: { filter: 'saturate(1.5)' } },
      { id: 'blur', label: t('Sfocatura'), mark: '◌', set: { filter: 'blur(4px)' } },
      { id: 'contrast', label: t('Contrasto'), mark: '◑', set: { filter: 'contrast(1.2)' } },
    ],
  },
  {
    id: 'box',
    label: t('Box'),
    snippets: [
      { id: 'padding', label: t('Spazio interno'), mark: '▤', set: { padding: 'var(--xb-space-m, 1rem)' } },
      { id: 'background', label: t('Colore di sfondo'), mark: '■', set: { 'background-color': 'var(--xb-surface, #f5f5f5)' } },
      { id: 'border', label: t('Bordo'), mark: '□', set: { border: 'var(--xb-border-width, 1px) solid var(--xb-border, currentColor)' } },
      { id: 'radius', label: t('Angoli arrotondati'), mark: '◜', set: { 'border-radius': 'var(--xb-radius-m, 0.5rem)' } },
      { id: 'max-width', label: t('Larghezza massima'), mark: '⟷', set: { 'max-inline-size': 'var(--xb-width-content, 72rem)' } },
      { id: 'min-height', label: t('Altezza minima'), mark: '↥', set: { 'min-block-size': '50vh' } },
      { id: 'shadow', label: t('Ombra'), mark: '◩', set: { 'box-shadow': 'var(--xb-shadow-m, 0 0.5rem 1.5rem rgb(0 0 0 / 0.15))' } },
      { id: 'opacity', label: t('Opacità'), mark: '◍', set: { opacity: '0.8' } },
    ],
  },
];

/** The groups that make sense here, in order. */
export function compactGroups(context: CompactContext): CompactGroup[] {
  return COMPACT_GROUPS.filter((g) => !g.when || g.when(context));
}

/** `on`: the CSS has every declaration of the snippet as it writes them; `set`: some of its properties have another value. */
export function snippetState(snippet: CompactSnippet, decls: Record<string, string>): 'on' | 'set' | 'off' {
  const props = Object.keys(snippet.set);
  if (props.every((p) => (decls[p] ?? '').trim() === snippet.set[p])) return 'on';
  return props.some((p) => decls[p] !== undefined) ? 'set' : 'off';
}

/**
 * What a click does: a snippet that is on comes off (its properties are removed), otherwise its declarations are
 * written (an existing value is replaced) and what it clears goes. A list of [property, value | null].
 */
export function snippetChanges(snippet: CompactSnippet, decls: Record<string, string>): Array<[string, string | null]> {
  if (snippetState(snippet, decls) === 'on') return Object.keys(snippet.set).map((p) => [p, null]);
  return [...Object.entries(snippet.set), ...(snippet.clears ?? []).filter((p) => decls[p] !== undefined).map((p): [string, null] => [p, null])];
}

/** Which mini GUI the panel shows: Histeon's groups and rows, or the compact strip. */
export type MiniStyle = 'histos' | 'compact';

/**
 * The style a saved preference (`localStorage['xb-mini-gui-style']`) stands for: `compact`, or `etch` as saved by
 * versions before 0.5.15 for the same strip; anything else is Histeon's.
 */
export function miniStyleFrom(saved: string | null | undefined): MiniStyle {
  return saved === 'compact' || saved === 'etch' ? 'compact' : 'histos';
}
