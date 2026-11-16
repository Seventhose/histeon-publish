// The mini GUI (docs/spec/styles.md §9): a compact toolbar over the CSS editor that writes the most
// used declarations into the selector's code while you look at the element. The code stays the truth: every
// control reads its state from the CSS and writes back plain declarations, with the framework's variables.
// Pure, tested in test/miniGui.test.ts.
import { statements } from '@xb/dsl';
import { applyDeclarations } from './cssActions.ts';
import { t } from './i18n.ts';

/** The top-level declarations of a rule body (nested rules and queries are not read). */
export function declarations(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [prelude, block] of statements(css)) {
    if (block !== null) continue;
    const at = prelude.indexOf(':');
    if (at > 0) out[prelude.slice(0, at).trim().toLowerCase()] = prelude.slice(at + 1).trim();
  }
  return out;
}

/** Sets a top-level declaration, or removes it (null), leaving everything else as written. */
export function setDeclaration(css: string, prop: string, value: string | null): string {
  if (value !== null) return applyDeclarations(css, { [prop]: value });
  const parts: string[] = [];
  for (const [prelude, block] of statements(css)) {
    if (block !== null) parts.push(`${prelude} {${block}}`);
    else if (prelude.slice(0, Math.max(0, prelude.indexOf(':'))).trim().toLowerCase() !== prop) parts.push(`${prelude.trim()};`);
  }
  const decls = parts.filter((p) => !p.includes('{'));
  const nested = parts.filter((p) => p.includes('{'));
  const next = [...decls, ...nested].join('\n');
  return next ? `${next}\n` : '';
}

export interface Option {
  label: string;
  value: string;
}

export interface Scales {
  space: Option[];
  text: Option[];
  radius: Option[];
  shadow: Option[];
  color: Option[];
}

const ORDER = ['4xs', '3xs', '2xs', 'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', '3xl', '4xl'];
const step = (name: string) => {
  const s = name.split('-').pop() ?? '';
  const i = ORDER.indexOf(s);
  return i === -1 ? 99 : i;
};
const scale = (names: string[], prefix: RegExp): Option[] =>
  names
    .filter((n) => prefix.test(n))
    .sort((a, b) => step(a) - step(b) || a.localeCompare(b))
    .map((n) => ({ label: n.replace(prefix, '').replace(/^xb-/, '') || n, value: `var(--${n})` }));

/**
 * Scales from the framework's variables, recognised by name so they work with any framework (Core Framework
 * groups them, ACSS does not): spaces, text sizes, radii, shadows and colours. The semantic `--xb-*` tokens are
 * used when the framework has no names of its own for a scale.
 */
export function scalesFrom(variables: Array<{ name: string; group: string }>): Scales {
  const names = [...new Set(variables.map((v) => v.name))];
  const own = names.filter((n) => !n.startsWith('xb-'));
  const tokens = names.filter((n) => n.startsWith('xb-'));
  const pick = (re: RegExp, tokenRe: RegExp) => {
    const mine = scale(own, re);
    return mine.length ? mine : scale(tokens, tokenRe);
  };
  const colorRe = /^(primary|secondary|tertiary|accent|base|neutral|bg|surface|heading|white|black|success|danger|error|warning|info|light|dark)(-[a-z0-9-]+)?$/;
  const colors = own.filter((n) => colorRe.test(n) && !/-(trans|alpha|rgb|hsl)(-\d+)?$|-(h|s|l)$/.test(n)).slice(0, 48);
  return {
    space: pick(/^space-/, /^xb-space-/),
    text: pick(/^text-(?:\d?x*[sml]|\d?xl|xxl)$/, /^xb-text-/),
    radius: pick(/^radius-/, /^xb-radius-/),
    shadow: pick(/^(box-)?shadow-/, /^xb-shadow-/),
    color: (colors.length ? colors : tokens.filter((n) => /^xb-(primary|bg|surface|text|heading)/.test(n))).map((n) => ({ label: n.replace(/^xb-/, ''), value: `var(--${n})` })),
  };
}

export type Control =
  | { prop: string; kind: 'choice'; options: Option[] }
  | { prop: string; kind: 'scale'; scale: keyof Scales; extra?: Option[] };

export interface Group {
  id: string;
  label: string;
  controls: Control[];
}

const o = (...values: string[]): Option[] => values.map((v) => ({ label: v, value: v }));

export const GROUPS: Group[] = [
  {
    id: 'layout',
    label: 'Layout',
    controls: [
      { prop: 'display', kind: 'choice', options: o('block', 'flex', 'grid', 'inline-flex', 'none') },
      { prop: 'flex-direction', kind: 'choice', options: o('row', 'column') },
      { prop: 'flex-wrap', kind: 'choice', options: o('wrap', 'nowrap') },
      { prop: 'grid-template-columns', kind: 'choice', options: [{ label: '2', value: 'repeat(2, minmax(0, 1fr))' }, { label: '3', value: 'repeat(3, minmax(0, 1fr))' }, { label: '4', value: 'repeat(4, minmax(0, 1fr))' }, { label: 'auto', value: 'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))' }] },
      { prop: 'justify-content', kind: 'choice', options: o('start', 'center', 'end', 'space-between') },
      { prop: 'align-items', kind: 'choice', options: o('start', 'center', 'end', 'stretch') },
      { prop: 'gap', kind: 'scale', scale: 'space' },
    ],
  },
  {
    id: 'space',
    label: t('Spazi'),
    controls: [
      { prop: 'padding', kind: 'scale', scale: 'space' },
      { prop: 'padding-block', kind: 'scale', scale: 'space' },
      { prop: 'padding-inline', kind: 'scale', scale: 'space' },
      { prop: 'margin-block', kind: 'scale', scale: 'space' },
      { prop: 'margin-inline', kind: 'choice', options: o('auto', '0') },
    ],
  },
  {
    id: 'size',
    label: t('Dimensioni'),
    controls: [
      { prop: 'width', kind: 'choice', options: o('100%', 'auto', 'fit-content') },
      { prop: 'max-width', kind: 'choice', options: o('100%', '60ch', '40rem', '75rem') },
      { prop: 'min-height', kind: 'choice', options: o('50vh', '100vh', '100svh') },
      { prop: 'aspect-ratio', kind: 'choice', options: o('1', '4 / 3', '16 / 9') },
      { prop: 'object-fit', kind: 'choice', options: o('cover', 'contain') },
    ],
  },
  {
    id: 'text',
    label: t('Testo'),
    controls: [
      { prop: 'font-size', kind: 'scale', scale: 'text' },
      { prop: 'font-weight', kind: 'choice', options: o('400', '500', '600', '700') },
      { prop: 'line-height', kind: 'choice', options: o('1', '1.2', '1.5', '1.7') },
      { prop: 'text-align', kind: 'choice', options: o('start', 'center', 'end') },
      { prop: 'text-wrap', kind: 'choice', options: o('balance', 'pretty') },
      { prop: 'color', kind: 'scale', scale: 'color' },
    ],
  },
  {
    id: 'look',
    label: t('Colori e bordi'),
    controls: [
      { prop: 'background', kind: 'scale', scale: 'color' },
      { prop: 'border-radius', kind: 'scale', scale: 'radius', extra: o('0', '999px') },
      { prop: 'box-shadow', kind: 'scale', scale: 'shadow', extra: o('none') },
      { prop: 'border', kind: 'choice', options: o('none', '1px solid currentColor') },
      { prop: 'opacity', kind: 'choice', options: o('0.5', '0.8', '1') },
    ],
  },
  {
    id: 'position',
    label: t('Posizione'),
    controls: [
      { prop: 'position', kind: 'choice', options: o('relative', 'absolute', 'sticky') },
      { prop: 'inset', kind: 'choice', options: o('0') },
      { prop: 'z-index', kind: 'choice', options: o('1', '10', '100') },
      { prop: 'overflow', kind: 'choice', options: o('hidden', 'auto', 'clip') },
      { prop: 'container-type', kind: 'choice', options: o('inline-size') },
    ],
  },
];

/** The options of a control, with the site's scale. */
export function optionsFor(control: Control, scales: Scales): Option[] {
  return control.kind === 'choice' ? control.options : [...scales[control.scale], ...(control.extra ?? [])];
}

const FLEX = /^(inline-)?flex$/;
const GRID = /^(inline-)?grid$/;

/**
 * Whether a control makes sense now (docs/spec/styles.md §9, «dinamica»): flex and grid settings only for a flex
 * or grid box, offsets and stacking only for a positioned one, object-fit only for media. A control with a value
 * always shows, so nothing written can hide.
 */
export function relevant(control: Control, current: Record<string, string>, tag = ''): boolean {
  if (current[control.prop] !== undefined) return true;
  const display = current.display ?? '';
  switch (control.prop) {
    case 'flex-direction':
    case 'flex-wrap':
      return FLEX.test(display);
    case 'grid-template-columns':
      return GRID.test(display);
    case 'justify-content':
    case 'align-items':
    case 'gap':
      return FLEX.test(display) || GRID.test(display);
    case 'inset':
    case 'z-index':
      return ['relative', 'absolute', 'fixed', 'sticky'].includes(current.position ?? '');
    case 'object-fit':
      return ['img', 'video', 'picture', 'iframe'].includes(tag.toLowerCase());
    default:
      return true;
  }
}

/** Props of a group that have a value: a dot on the group's tab. */
export function groupIsSet(group: Group, current: Record<string, string>): boolean {
  return group.controls.some((c) => current[c.prop] !== undefined);
}
