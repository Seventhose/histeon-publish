import type { XbBlock } from '@xb/dsl';
import type { PropDefinition, StyleEntry } from './api.ts';
import { classTokens, isDynamic } from '../gutenberg/classes.ts';
import { t } from './i18n.ts';
import { updateBlock } from './tree.ts';

// Variants of a component as switches (lista della spesa 157): a «dark card» is a yes/no prop that adds the BEM
// modifier class (`card--scura`) to the component's first element, and that class only redefines a few of the
// variables `.card` uses. Who builds names the variant; the client turns it on with a switch, in the builder and in
// the block editor, like any yes/no prop. Pure functions over the tree, the props and the styles.

export interface Variant {
  prop: string;
  label: string;
  selector: string;
}

const token = (base: string, prop: string) => `{props.${prop} ? "${base}--${modifier(prop)}" : ""}`;
const TOKEN = /^\{props\.([A-Za-z_]\w*) \? "([_a-zA-Z][\w-]*)--([a-z0-9-]+)" : ""\}$/;

/** `scuraGrande` → `scura-grande`: the modifier as BEM writes it. */
export function modifier(prop: string): string {
  return prop.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** `Card scura` → `cardScura`: a prop name from the words someone typed. */
export function propName(label: string): string {
  const words = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[A-Za-z_]/.test(name) ? name : '';
}

/** The component's first element and its first static class: where variants go. */
function root(tree: XbBlock[]): { uid: string; base: string; classes: string } | null {
  const first = tree.find((b) => b.name === 'xb/element');
  if (!first || first.name !== 'xb/element') return null;
  const classes = typeof first.attrs.attributes?.class === 'string' ? first.attrs.attributes.class : '';
  const base = classTokens(classes).find((c) => !isDynamic(c));
  return base ? { uid: first.attrs.uid, base, classes } : null;
}

/** The variants the component has: yes/no props written as modifier classes on its first element. */
export function listVariants(tree: XbBlock[], props: Record<string, PropDefinition>): Variant[] {
  const r = root(tree);
  if (!r) return [];
  return classTokens(r.classes).flatMap((tok) => {
    const m = TOKEN.exec(tok);
    if (!m || props[m[1]!]?.type !== 'boolean') return [];
    return [{ prop: m[1]!, label: props[m[1]!]?.label ?? m[1]!, selector: `.${m[2]}--${m[3]}` }];
  });
}

/** The custom properties `.base` declares at its top level: the starting point a variant redefines. */
export function baseVariables(css: string): string {
  let depth = 0;
  const out: string[] = [];
  for (const line of css.split('\n')) {
    if (depth === 0) {
      const m = /^\s*(--[\w-]+)\s*:\s*([^;{}]+);/.exec(line);
      if (m) out.push(`${m[1]}: ${m[2]!.trim()};`);
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  }
  return out.join('\n');
}

export type VariantPlan =
  | { ok: true; prop: string; definition: PropDefinition; tree: XbBlock[]; selector: string; css: string }
  | { ok: false; error: string };

/** What adding the variant `label` changes: the prop, the first element's class, the CSS of the modifier. */
export function planVariant(tree: XbBlock[], props: Record<string, PropDefinition>, styles: StyleEntry[], label: string): VariantPlan {
  const name = propName(label);
  if (!name) return { ok: false, error: t('Dai alla variante un nome fatto di parole, per esempio «Scura».') };
  if (props[name]) return { ok: false, error: t('Il componente ha già una prop «{0}».', name) };
  const r = root(tree);
  if (!r) return { ok: false, error: t('Il primo elemento del componente non ha una classe: dagliene una (per esempio «card») e riprova.') };
  const selector = `.${r.base}--${modifier(name)}`;
  const next = updateBlock(tree, r.uid, (b) =>
    b.name === 'xb/element' ? { ...b, attrs: { ...b.attrs, attributes: { ...(b.attrs.attributes ?? {}), class: `${r.classes} ${token(r.base, name)}`.trim() } } } : b,
  );
  const own = styles.find((s) => s.selector === `.${r.base}`)?.css ?? '';
  return { ok: true, prop: name, definition: { type: 'boolean', default: false, label: label.trim() }, tree: next, selector, css: baseVariables(own) };
}

/** Takes a variant away: its prop and its class; its CSS stays, as with any selector no longer used. */
export function removeVariant(tree: XbBlock[], prop: string): XbBlock[] {
  const r = root(tree);
  if (!r) return tree;
  const classes = classTokens(r.classes)
    .filter((tok) => TOKEN.exec(tok)?.[1] !== prop)
    .join(' ');
  return updateBlock(tree, r.uid, (b) => (b.name === 'xb/element' ? { ...b, attrs: { ...b.attrs, attributes: { ...(b.attrs.attributes ?? {}), class: classes } } } : b));
}
