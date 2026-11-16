// Client mode (docs/spec/client-mode.md): the same rule as the server's Security\ContentOnly, so the builder
// refuses at once what the server would refuse on save. Only texts and an image's picture may change; blocks,
// tags, classes, links, scripts and `{…}` expressions stay as they are.
import type { XbBlock } from '@xb/dsl';
import { t } from './i18n.ts';

export const IMAGE_ATTRIBUTES = ['src', 'srcset', 'sizes', 'width', 'height', 'alt'];

/** Prop types a client with `xb_edit_props` may set (list 135), as the server's ContentOnly::CLIENT_PROP_TYPES. */
export const CLIENT_PROP_TYPES = ['string', 'number', 'boolean', 'url', 'image', 'enum'];

/** The props a component declares, by ref: given only when the client may change props (xb_edit_props). */
export type PropSchemas = (ref: string) => Record<string, { type?: string; options?: unknown[] }> | undefined;

/** Whether a client may write `value` in a prop of this type (the server checks it again, the uploads folder too). */
export function clientPropValue(type: string | undefined, value: unknown, options: unknown[] = []): boolean {
  if (!type || !CLIENT_PROP_TYPES.includes(type)) return false;
  if (value === undefined || value === null) return true;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'enum') return typeof value === 'string' && options.map(String).includes(value);
  if (typeof value !== 'string' || value.length > 2000 || /[{}\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return false;
  if (type === 'url') return value === '' || /^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(value);
  if (type === 'image') return value === '' || /^https?:\/\/[^\s"'<>]+$/i.test(value);
  return true;
}

const expressions = (text: string): string => (text.match(/\{[^{}]*\}/g) ?? []).join('\u0000');

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

function children(block: XbBlock): XbBlock[] {
  return 'children' in block && Array.isArray(block.children) ? (block.children as XbBlock[]) : [];
}

function attributes(before: XbBlock, after: XbBlock, props?: PropSchemas): string {
  const a = { ...(before.attrs as Record<string, unknown>) };
  const b = { ...(after.attrs as Record<string, unknown>) };
  if (props && before.name === 'xb/component' && typeof a.ref === 'string' && a.ref === b.ref) {
    const pa = (a.props as Record<string, unknown>) ?? {};
    const pb = (b.props as Record<string, unknown>) ?? {};
    const schema = props(a.ref) ?? {};
    for (const name of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (same(pa[name], pb[name])) continue;
      const def = schema[name];
      if ((pa[name] !== null && typeof pa[name] === 'object') || !clientPropValue(def?.type, pb[name], def?.options)) return t('la prop «{0}» non si può cambiare così', name);
    }
    delete a.props;
    delete b.props;
  }
  if (before.name === 'xb/text') {
    if (expressions(String(a.content ?? '')) !== expressions(String(b.content ?? ''))) return t('espressioni {…} cambiate');
    delete a.content;
    delete b.content;
  } else if (before.name === 'xb/element' && a.tag === 'img' && b.tag === 'img') {
    const ia = { ...((a.attributes as Record<string, unknown>) ?? {}) };
    const ib = { ...((b.attributes as Record<string, unknown>) ?? {}) };
    for (const name of IMAGE_ATTRIBUTES) {
      const old = ia[name];
      const next = ib[name];
      if (typeof old === 'string' && old.includes('{') && next !== old) return t('immagine dinamica cambiata');
      if (typeof next === 'string' && next.includes('{') && next !== old) return t("espressione {…} aggiunta all'immagine");
      delete ia[name];
      delete ib[name];
    }
    a.attributes = ia;
    b.attributes = ib;
  }
  if (before.name === 'xb/passthrough' && (before as { raw: string }).raw !== (after as { raw: string }).raw) return t('codice HTML cambiato');
  return same(a, b) ? '' : t('attributi cambiati');
}

/** '' when `after` only changes texts and pictures of `before` (and literal props, with `props`); otherwise what it does more. */
export function contentOnlyProblem(before: XbBlock[], after: XbBlock[], props?: PropSchemas): string {
  if (before.length !== after.length) return t('elementi aggiunti o tolti');
  for (let i = 0; i < before.length; i++) {
    const a = before[i] as XbBlock;
    const b = after[i] as XbBlock;
    if (a.name !== b.name) return t('tipo di blocco cambiato');
    const problem = attributes(a, b, props) || contentOnlyProblem(children(a), children(b), props);
    if (problem) return problem;
  }
  return '';
}
