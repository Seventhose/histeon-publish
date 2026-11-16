import type { ElementBlock } from '@xb/dsl';
import { removeAttribute, setAttribute, setTag, type Edit } from './attributes.ts';
import { t, tx } from './i18n.ts';

// The fields an element is edited with in the Properties panel (docs/spec/properties.md): what a link, an image
// or a heading needs, in words, instead of attribute names. Every change goes through the same checks as the
// code panel (attributes.ts): the panel can never write what the DSL would not read back.

export type FieldKind = 'text' | 'url' | 'number' | 'select' | 'check' | 'newtab' | 'level';

export interface Field {
  /** Attribute name (for `level`: the tag; for `newtab`: target + rel). */
  attr: string;
  label: string;
  kind: FieldKind;
  options?: Array<[string, string]>;
  placeholder?: string;
  /** Shown when the value is empty: what is missing and why it matters. */
  whenEmpty?: string;
  /** Short explanation kept visible while the field has a value. */
  help?: string;
}

export interface FieldGroup {
  title: string;
  fields: Field[];
  /** The image picker goes with this group. */
  media?: boolean;
}

const yes = (attr: string, label: string): Field => ({ attr, label, kind: 'check' });
const LEVELS: Array<[string, string]> = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => [h, h.toUpperCase()]);
const LOADING: Array<[string, string]> = [['', t('Predefinito')], ['lazy', t('Quando serve (lazy)')], ['eager', t('Subito')]];

/** The fields of an element by tag; null when only the generic attributes apply. */
export function fieldsFor(tag: string): FieldGroup | null {
  if (/^h[1-6]$/.test(tag)) return { title: t('Titolo'), fields: [{ attr: 'tag', label: t('Livello'), kind: 'level', options: LEVELS }] };
  switch (tag) {
    case 'a':
      return {
        title: t('Link'),
        fields: [
          { attr: 'href', label: t('Indirizzo'), kind: 'url', placeholder: t('/pagina/ o https://…'), whenEmpty: t('Un link senza indirizzo non porta da nessuna parte.') },
          { attr: 'target', label: t('Apri in una nuova scheda'), kind: 'newtab' },
          { attr: 'title', label: t('Suggerimento'), kind: 'text' },
        ],
      };
    case 'img':
      return {
        title: t('Immagine'),
        media: true,
        fields: [
          { attr: 'alt', label: t('Testo alternativo'), kind: 'text', placeholder: t('Cosa mostra l’immagine'), whenEmpty: t('Senza testo alternativo chi usa un lettore di schermo non sa cosa mostra. Lascialo vuoto solo se è decorativa.') },
          { attr: 'width', label: t('Larghezza'), kind: 'number' },
          { attr: 'height', label: t('Altezza'), kind: 'number' },
          { attr: 'loading', label: t('Caricamento'), kind: 'select', options: LOADING },
        ],
      };
    case 'button':
      return {
        title: t('Pulsante'),
        fields: [
          { attr: 'type', label: t('Tipo'), kind: 'select', options: [['button', t('Pulsante')], ['submit', t('Invia il modulo')], ['reset', t('Azzera il modulo')]] },
          yes('disabled', t('Disattivato')),
        ],
      };
    case 'input':
      return {
        title: t('Campo'),
        fields: [
          // No password: a static site cannot receive one safely, and Histeon CMS transfers refuse it (histos-transfer-markup-v1).
          { attr: 'type', label: t('Tipo'), kind: 'select', options: ['text', 'email', 'tel', 'number', 'url', 'search', 'date', 'checkbox', 'radio', 'hidden'].map((v) => [v, v]) },
          { attr: 'name', label: t('Nome'), kind: 'text' },
          { attr: 'placeholder', label: t('Testo di esempio'), kind: 'text' },
          yes('required', t('Obbligatorio')),
        ],
      };
    case 'textarea':
    case 'select':
      return { title: t('Campo'), fields: [{ attr: 'name', label: t('Nome'), kind: 'text' }, yes('required', t('Obbligatorio'))] };
    case 'label':
      return { title: t('Etichetta'), fields: [{ attr: 'for', label: t('Per il campo (id)'), kind: 'text' }] };
    case 'video':
      return {
        title: t('Video'),
        fields: [
          { attr: 'src', label: t('File'), kind: 'url' },
          { attr: 'poster', label: t('Immagine di copertina'), kind: 'url' },
          yes('controls', tx('Comandi', 'video')),
          yes('autoplay', t('Parte da solo')),
          yes('muted', t('Senza audio')),
          yes('loop', t('In loop')),
          yes('playsinline', t('Nella pagina su telefono')),
        ],
      };
    case 'iframe':
      return {
        title: t('Contenuto incorporato'),
        fields: [
          { attr: 'src', label: t('Indirizzo'), kind: 'url' },
          { attr: 'title', label: t('Titolo'), kind: 'text', whenEmpty: t('Un iframe senza titolo non dice cosa contiene a chi usa un lettore di schermo.') },
          { attr: 'loading', label: t('Caricamento'), kind: 'select', options: LOADING },
        ],
      };
    case 'ol':
      return { title: t('Elenco numerato'), fields: [{ attr: 'start', label: t('Parte da'), kind: 'number' }, yes('reversed', t('Al contrario'))] };
    case 'time':
      return { title: t('Data'), fields: [{ attr: 'datetime', label: t('Data per le macchine'), kind: 'text', placeholder: '2026-10-20' }] };
    case 'form':
      return {
        title: t('Invio del modulo'),
        fields: [
          { attr: 'action', label: t('Endpoint di invio'), kind: 'url', placeholder: t('/api/moduli oppure https://…'), whenEmpty: t('Senza endpoint, il modulo non può essere incluso in una build pubblicabile.'), help: t('I dati partono dal browser verso questo indirizzo. Histeon non li riceve: verifica il servizio e la sua informativa privacy.') },
          { attr: 'method', label: t('Metodo'), kind: 'select', options: [['get', 'GET'], ['post', 'POST']], whenEmpty: t('Scegli GET o POST prima della build.'), help: t('Usa POST per i dati personali. GET inserisce i valori nell’URL ed è adatto solo a ricerche pubbliche.') },
        ],
      };
    default:
      return null;
  }
}

/** Fields every element has. */
export const COMMON: FieldGroup = {
  title: t('Identità'),
  fields: [
    { attr: 'id', label: t('Id (ancora)'), kind: 'text', placeholder: t('per i link #ancora') },
    { attr: 'aria-label', label: t('Nome accessibile'), kind: 'text' },
  ],
};

const relWords = (rel: string | true | undefined) => (typeof rel === 'string' ? rel.split(/\s+/).filter(Boolean) : []);

/** What the field shows now: a string, or a boolean for checks. */
export function valueOf(block: ElementBlock, field: Field): string | boolean {
  const attrs = block.attrs.attributes ?? {};
  if (field.kind === 'level') return block.attrs.tag;
  if (field.kind === 'newtab') return attrs.target === '_blank';
  const value = attrs[field.attr];
  if (field.kind === 'check') return value !== undefined;
  return value === true || value === undefined ? '' : value;
}

/** The element with the field set to `value` (empty text removes the attribute). */
export function applyField(block: ElementBlock, field: Field, value: string | boolean): Edit {
  const has = Object.hasOwn(block.attrs.attributes ?? {}, field.attr);
  switch (field.kind) {
    case 'level':
      return setTag(block, String(value));
    case 'check': {
      if (!value) return { ok: true, block: removeAttribute(block, field.attr) };
      if (has) return { ok: true, block };
      return setAttribute(block, null, field.attr, '');
    }
    case 'newtab': {
      const attrs = block.attrs.attributes ?? {};
      let rel = relWords(attrs.rel);
      let next = block;
      if (value) {
        const target = setAttribute(next, Object.hasOwn(attrs, 'target') ? 'target' : null, 'target', '_blank');
        if (!target.ok) return target;
        next = target.block;
        // A new tab never gets a handle on this page.
        if (!rel.includes('noopener')) rel = [...rel, 'noopener'];
      } else {
        next = removeAttribute(next, 'target');
        rel = rel.filter((r) => r !== 'noopener' && r !== 'noreferrer');
      }
      if (rel.length === 0) return { ok: true, block: removeAttribute(next, 'rel') };
      return setAttribute(next, Object.hasOwn(next.attrs.attributes ?? {}, 'rel') ? 'rel' : null, 'rel', rel.join(' '));
    }
    default: {
      const text = String(value).trim();
      if (text === '') return { ok: true, block: removeAttribute(block, field.attr) };
      if (field.kind === 'number' && !/^\d+$/.test(text) && !text.includes('{')) return { ok: false, error: t('Serve un numero intero.') };
      return setAttribute(block, has ? field.attr : null, field.attr, text);
    }
  }
}
