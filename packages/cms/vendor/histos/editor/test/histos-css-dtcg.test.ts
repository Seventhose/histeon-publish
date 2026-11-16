import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DTCG_FILES, EXTENSION, parseColor, parseDimension, toDtcg } from '../src/histos-css/dtcg.ts';

// «Esporta i token (DTCG)» (V8.1): the server's tokens as a DTCG 2025.10 file. The expected file is small on
// purpose: one token for each case (colour, transparency, alias, dimension, unit left out, formula, font, weight,
// shadow, a token that is also a group).
const TOKENS: Record<string, string> = {
  'xb-primary': 'oklch(55% 0.2 265)',
  'xb-primary-500': 'oklch(62% 0.2 265)',
  'xb-primary-a10': 'color-mix(in oklch, var(--xb-primary) 10%, transparent)',
  'xb-on-primary': 'oklch(99% 0 0)',
  'xb-text': 'var(--xb-primary-500)',
  'xb-text-muted': '#336699',
  'xb-link': 'var(--xb-text)',
  'xb-text-m': 'clamp(1rem, 0.9583rem + 0.1852vw, 1.125rem)',
  'xb-card-title': 'var(--xb-text-m)',
  'xb-radius-m': '0.5rem',
  'xb-btn-radius': 'var(--xb-radius-m)',
  'xb-btn-pad-y': '0.75em',
  'xb-font-body': 'system-ui, "Segoe UI", sans-serif',
  'xb-heading-font': 'var(--xb-font-body)',
  'xb-heading-weight': '700',
  'xb-shadow-m': '0 4px 12px oklch(0% 0 0 / 0.1)',
  'xb-drop-shadow-m': 'drop-shadow(0 2px 6px oklch(0% 0 0 / 0.3))',
  'xb-leading-normal': '1.6',
  'xb-h1-leading': 'var(--xb-leading-normal)',
};

describe('toDtcg', () => {
  it('writes the expected file', () => {
    const expected = JSON.parse(readFileSync(new URL('./histos-css-dtcg.expected.json', import.meta.url), 'utf8'));
    const r = toDtcg(TOKENS, 'light', 'Prova.');
    expect(r.doc).toEqual(expected);
    expect(r.exported).toBe(13);
    expect(r.skipped).toEqual({ formula: ['text-m', 'card-title', 'drop-shadow-m'], unit: ['btn-pad-y'], type: ['leading-normal', 'h1-leading'] });
  });

  it('follows the dark colours: a transparency is the dark base with its alpha', () => {
    const dark = toDtcg({ ...TOKENS, 'xb-primary': 'oklch(70.7% 0.19 265)' }, 'dark').doc as Record<string, any>;
    expect(dark.color.primary.a10.$value.components).toEqual([0.707, 0.19, 265]);
    expect(dark.color.primary.a10.$value.alpha).toBe(0.1);
    expect(dark.$extensions[EXTENSION].scheme).toBe('dark');
    expect(dark.$description).toBeUndefined();
  });

  it('never forces a formula into a type', () => {
    const r = toDtcg({ 'xb-space-m': 'clamp(1rem, 0.8rem + 0.7vw, 1.5rem)', 'xb-radius-inner': 'max(0px, calc(var(--xb-card-radius) - 1rem))', 'xb-gap': 'var(--xb-missing)' }, 'light');
    expect(r.exported).toBe(0);
    expect(r.skipped.formula).toEqual(['space-m', 'radius-inner', 'gap']);
  });

  it('reads colours and dimensions as the format wants them', () => {
    expect(parseColor('oklch(0% 0 0 / 0.5)')).toEqual({ colorSpace: 'oklch', components: [0, 0, 0], alpha: 0.5, hex: '#000000' });
    expect(parseColor('oklch(50% 0.1 360)')?.components[2]).toBe(0);
    expect(parseColor('currentColor')).toBeNull();
    expect(parseDimension('0')).toEqual({ value: 0, unit: 'px' });
    expect(parseDimension('-2px')).toEqual({ value: -2, unit: 'px' });
    expect(parseDimension('65ch')).toBe('unit');
    expect(parseDimension('auto')).toBeNull();
    expect(DTCG_FILES).toEqual({ light: 'tokens.chiaro.json', dark: 'tokens.scuro.json' });
  });
});
