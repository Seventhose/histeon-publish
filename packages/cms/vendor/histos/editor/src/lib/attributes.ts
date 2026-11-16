import {
  ATTRIBUTE_NAME_PATTERN,
  HTML_ELEMENTS,
  RAW_TEXT_ELEMENTS,
  RESERVED_NAMES,
  roundTrips,
  TAG_PATTERN,
  VOID_ELEMENTS,
  type AttrValue,
  type ElementBlock,
  type XbBlock,
} from '@xb/dsl';
import { t } from './i18n.ts';

// Editing an element from the properties panel: the same rules as the code panel, applied one field at a time.
// Every result is checked to print and read back unchanged, so the panel can never produce what the DSL
// would not accept. What may be saved (event handlers, javascript: URLs…) is still decided by the server.

export type Edit = { ok: true; block: ElementBlock } | { ok: false; error: string };

function checked(block: ElementBlock): Edit {
  return roundTrips([block]) ? { ok: true, block } : { ok: false, error: t('Il valore non si può rappresentare nel codice.') };
}

/** Why a name cannot be an attribute (null: it can). */
export function attributeNameError(name: string): string | null {
  if (name === '') return t('Il nome è vuoto.');
  if (!ATTRIBUTE_NAME_PATTERN.test(name)) return t('Nome non valido: lettere, cifre, trattini, due punti e punti.');
  if (RESERVED_NAMES.has(name)) return t('Nome riservato.');
  if (name.toLowerCase().startsWith('xb:')) return t('I nomi xb: sono riservati al builder.');
  return null;
}

/**
 * Sets one attribute, renaming `previous` in place when given (the order of the others is kept). A boolean
 * attribute stays boolean while its value is empty; a new one with no value is written without one.
 */
export function setAttribute(block: ElementBlock, previous: string | null, name: string, raw: string): Edit {
  const trimmed = name.trim();
  const error = attributeNameError(trimmed);
  if (error) return { ok: false, error };
  const current = block.attrs.attributes ?? {};
  if (trimmed !== previous && Object.hasOwn(current, trimmed)) return { ok: false, error: t("L'attributo {0} esiste già.", trimmed) };
  const before = previous !== null && Object.hasOwn(current, previous) ? current[previous] : undefined;
  const value: AttrValue = raw === '' && (before === undefined || before === true) ? true : raw;
  const next: Record<string, AttrValue> = {};
  let placed = false;
  for (const [key, existing] of Object.entries(current)) {
    if (key === previous) {
      next[trimmed] = value;
      placed = true;
    } else next[key] = existing;
  }
  if (!placed) next[trimmed] = value;
  return checked({ ...block, attrs: { ...block.attrs, attributes: next } });
}

export function removeAttribute(block: ElementBlock, name: string): ElementBlock {
  const attributes = { ...(block.attrs.attributes ?? {}) };
  delete attributes[name];
  const attrs = { ...block.attrs, attributes };
  if (Object.keys(attributes).length === 0) delete (attrs as { attributes?: unknown }).attributes;
  return { ...block, attrs };
}

/** Changes the tag, keeping attributes and children when the new element can hold them. */
export function setTag(block: ElementBlock, raw: string): Edit {
  const tag = raw.trim().replace(/^<|>$/g, '');
  if (!TAG_PATTERN.test(tag) || (tag === tag.toUpperCase() && HTML_ELEMENTS.has(tag.toLowerCase()))) {
    return { ok: false, error: t('Tag non valido (es. div, section, h2, my-widget).') };
  }
  if (tag === block.attrs.tag) return { ok: true, block };
  if (RAW_TEXT_ELEMENTS.has(tag) || RAW_TEXT_ELEMENTS.has(block.attrs.tag)) {
    return { ok: false, error: t('script, style e textarea hanno un contenuto speciale: cambiali dal codice.') };
  }
  if (VOID_ELEMENTS.has(tag) && block.children.length > 0) return { ok: false, error: t('<{0}> non può contenere altri elementi.', tag) };
  return checked({ ...block, attrs: { ...block.attrs, tag } });
}

/**
 * The text of an element whose content is a single run of text (null when it holds other elements, or is a
 * void or raw-text element, which the code panel edits instead).
 */
export function textOf(block: XbBlock): string | null {
  if (block.name !== 'xb/element' || VOID_ELEMENTS.has(block.attrs.tag) || RAW_TEXT_ELEMENTS.has(block.attrs.tag)) return null;
  if (block.children.length === 0) return '';
  const [only] = block.children;
  return block.children.length === 1 && only?.name === 'xb/text' && !only.attrs.verbatim ? only.attrs.content : null;
}

/** Replaces that text, reusing the run's uid so the selection in the structure survives. */
export function setText(block: ElementBlock, content: string, uid: () => string): Edit {
  if (textOf(block) === null) return { ok: false, error: t('Questo elemento contiene altri elementi: modificalo dal codice.') };
  const [only] = block.children;
  const children: XbBlock[] =
    content === '' ? [] : [{ name: 'xb/text', attrs: { uid: only?.attrs.uid ?? uid(), content } }];
  return checked({ ...block, children });
}
