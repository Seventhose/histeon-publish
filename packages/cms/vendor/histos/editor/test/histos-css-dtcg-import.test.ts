import { describe, expect, it } from 'vitest';
import { siteNameProblem, tokenProblem } from '../src/lib/designSystem.ts';
import { toDtcg } from '../src/histos-css/dtcg.ts';
import { importDesignTokens, parseSiteVariables, readDesignTokens, textSizeSteps, tokenImportLines } from '../src/histos-css/dtcg-import.ts';
import { OPTIONS } from '../src/histos-css/options.ts';

const file = (name: string, data: unknown) => ({ name, text: JSON.stringify(data) });
const srgb = (hex: string) => ({ colorSpace: 'srgb', components: [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255), alpha: 1, hex });
const px = (value: number) => ({ value, unit: 'px' });

/** One mode of a Figma variable collection, as «Export modes» writes it. */
const figmaLight = {
  color: {
    $type: 'color',
    brand: { primary: { $value: srgb('#1D4ED8') }, secondary: { $value: srgb('#F97316') } },
    gray: { '100': { $value: srgb('#F3F4F6') }, '500': { $value: srgb('#6B7280') }, '900': { $value: srgb('#111827') } },
    feedback: { error: { $value: srgb('#DC2626') } },
    button: { background: { $value: '{color.brand.primary}' } },
    overlay: { $value: { ...srgb('#000000'), alpha: 0.4 } },
  },
  radius: { sm: { $type: 'number', $value: 4 }, md: { $type: 'number', $value: 10 }, full: { $type: 'number', $value: 999 } },
  font: {
    family: { body: { $type: 'string', $value: 'Inter' }, heading: { $type: 'string', $value: 'Playfair Display' } },
    size: { body: { $type: 'number', $value: 17 }, caption: { $type: 'number', $value: 13 }, h1: { $type: 'number', $value: 56 } },
    weight: { heading: { $type: 'number', $value: 600 } },
  },
  spacing: { card: { $type: 'dimension', $value: px(24) }, hairline: { $type: 'dimension', $value: px(1) } },
  label: { cta: { $type: 'string', $value: 'Scopri' } },
};
const figmaDark = { color: { $type: 'color', brand: { primary: { $value: srgb('#93C5FD') }, secondary: { $value: srgb('#F97316') } } } };

/** A Penpot export: Tokens Studio sets, numbers as texts, formulas, themes that switch sets on. */
const penpot = {
  Base: {
    primary: { '400': { $value: '#60a5fa', $type: 'color' }, '500': { $value: '#3b82f6', $type: 'color' }, '600': { $value: '#2563eb', $type: 'color' } },
    spacing: { base: { $value: '8', $type: 'spacing' }, lg: { $value: '{spacing.base} * 3', $type: 'spacing' }, strano: { $value: 'roundTo({spacing.base} / 3, 1)', $type: 'spacing' } },
    raggio: { card: { $value: '12', $type: 'borderRadius' } },
    testo: { base: { $value: '20', $type: 'fontSizes' } },
    caratteri: { testo: { $value: 'Source Sans 3', $type: 'fontFamilies' } },
    ombra: { card: { $value: { x: '0', y: '4', blur: '12', spread: '0', color: 'rgba(0,0,0,0.12)', type: 'dropShadow' }, $type: 'boxShadow' } },
    perso: { $value: '{non.esiste}', $type: 'color' },
  },
  Sera: { primary: { '500': { $value: '#93c5fd', $type: 'color' } } },
  $themes: [
    { id: 'a', name: 'Light', group: 'Modo', selectedTokenSets: { Base: 'enabled' } },
    { id: 'b', name: 'Dark', group: 'Modo', selectedTokenSets: { Base: 'source', Sera: 'enabled' } },
  ],
  $metadata: { tokenSetOrder: ['Base', 'Sera'] },
};

const optionKeys = new Set(OPTIONS.map((o) => o.key));

describe('Histeon CSS panel: design tokens read', () => {
  it('reads a mode exported by Figma: object colours, numbers the name says are lengths, references', () => {
    const read = readDesignTokens([file('Light.tokens.json', figmaLight)]);
    expect(read.dialect).toBe('dtcg');
    const byName = new Map(read.tokens.map((token) => [token.name, token]));
    expect(byName.get('color.brand.primary')).toMatchObject({ kind: 'color', color: { r: 29, g: 78, b: 216, alpha: 1 } });
    expect(byName.get('color.button.background')).toMatchObject({ kind: 'color', alias: 'color.brand.primary' });
    expect(byName.get('radius.md')).toMatchObject({ kind: 'dimension', use: 'radius', length: { px: 10, unit: 'px' } });
    expect(byName.get('font.size.body')).toMatchObject({ kind: 'fontSize', length: { px: 17 } });
    expect(read.problems).toContainEqual({ token: 'label.cta', why: 'tipo «string» non convertito' });
  });

  it('reads a Penpot export: the sets of the theme, numbers written as texts, formulas', () => {
    const light = readDesignTokens([file('tokens.json', penpot)]);
    expect(light.dialect).toBe('tokens-studio');
    expect(light.sets).toEqual(['Base']);
    expect(light.dark).toBe(true);
    const byName = new Map(light.tokens.map((token) => [token.name, token]));
    expect(byName.get('spacing.lg')?.length).toEqual({ px: 24, unit: 'px' });
    expect(light.problems).toContainEqual({ token: 'spacing.strano', why: 'formula non calcolata' });
    expect(light.problems).toContainEqual({ token: 'perso', why: 'rimanda a {non.esiste}, che non c’è' });
    const dark = readDesignTokens([file('tokens.json', penpot)], { scheme: 'dark' });
    expect(dark.sets).toEqual(['Base', 'Sera']);
    expect(dark.tokens.find((token) => token.name === 'primary.500')?.color).toMatchObject({ r: 147, g: 197, b: 253 });
    // What both readings refuse is said once; what only the dark sets hold is said as dark.
    const withDark = { ...penpot, Sera: { ...penpot.Sera, altro: { $value: 'roundTo(4)', $type: 'spacing' } } };
    const result = importDesignTokens(readDesignTokens([file('tokens.json', withDark)]), { dark: readDesignTokens([file('tokens.json', withDark)], { scheme: 'dark' }) });
    expect(result.report.skipped.map((item) => item.token)).toEqual(['spacing.strano', 'perso', 'altro (scuro)']);
  });

  it('refuses what is not JSON or is too much, and never runs anything', () => {
    expect(() => readDesignTokens([])).toThrow('no-file');
    expect(() => readDesignTokens([{ name: 'a.json', text: '{' }])).toThrow('not-json');
    const many = Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`t${n}`, { $type: 'number', $value: n }]));
    expect(() => readDesignTokens([file('many.json', many)])).toThrow('too-many');
    const read = readDesignTokens([file('f.json', { a: { $type: 'dimension', $value: "constructor.constructor('return 1')()" }, ok: { n: { $type: 'number', $value: 1 } } })]);
    expect(read.tokens.map((token) => token.name)).toEqual(['ok.n']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('Histeon CSS panel: tokens to parameters and site variables', () => {
  it('turns family colours, fonts, base size and radius into parameters of the panel, inside their limits', () => {
    const result = importDesignTokens(readDesignTokens([file('Light.tokens.json', figmaLight)]), { dark: readDesignTokens([file('Dark.tokens.json', figmaDark)]) });
    expect(result.design).toMatchObject({
      primary: '#1d4ed8',
      secondary: '#f97316',
      neutral: '#6b7280',
      danger: '#dc2626',
      font_body: 'Inter, system-ui, sans-serif',
      font_heading: '"Playfair Display", system-ui, sans-serif',
      text_max: 17,
      text_min: 16,
      radius: 10,
      heading_weight: 600,
      dark_on: 1,
      primary_dark: '#93c5fd',
    });
    // The same colour in both modes is not a dark colour of its own.
    expect(result.design.secondary_dark).toBeUndefined();
    // Every key is a parameter of the panel, every number inside its limits.
    for (const [key, value] of Object.entries(result.design)) {
      expect(optionKeys.has(key), key).toBe(true);
      const option = OPTIONS.find((o) => o.key === key);
      if (option?.kind === 'number') expect(Number(value) >= option.min && Number(value) <= option.max, key).toBe(true);
    }
    // No text size became a variable; the rest did, with names and values the server accepts.
    expect(Object.keys(result.siteTokens).some((name) => /size|caption|h1/.test(name))).toBe(false);
    expect(result.siteTokens).toMatchObject({ 'spacing-card': '1.5rem', 'spacing-hairline': '1px', 'color-button-background': 'var(--xb-primary)', 'color-overlay': 'rgb(0 0 0 / 0.4)', 'radius-full': '62.4375rem' });
    for (const [name, value] of Object.entries(result.siteTokens)) expect([siteNameProblem(name), tokenProblem(value)], name).toEqual([null, null]);
    expect(result.report.shades.neutral).toEqual(['color.gray.100', 'color.gray.900']);
    expect(result.report.fonts).toEqual(['Inter', 'Playfair Display']);
  });

  it('keeps a value out of the limits of its option out of the design, and says it', () => {
    const result = importDesignTokens(readDesignTokens([file('t.json', { font: { size: { body: { $type: 'number', $value: 72 } } } })]));
    expect(result.design.text_max).toBeUndefined();
    expect(result.report.skipped).toContainEqual({ token: 'font.size.body', why: 'text_max: 72 è fuori dai limiti (10–40)' });
  });

  it('takes the running text from the body style nearest 16 px, with its own leading; a gradient stop is no family colour', () => {
    const style = (size: number, leading: number) => ({ $type: 'typography', $value: { fontFamily: 'Roboto', fontSize: px(size), fontWeight: 400, lineHeight: leading } });
    const library = {
      body: { large: style(22, 1.3), medium: style(15, 1.45), small: style(12, 1.2) },
      color: { $type: 'color', gradient: { primary: { $value: srgb('#000000') } }, sfumatura: { accent: { $value: srgb('#ffffff') } }, primary: { $value: srgb('#6750a4') } },
    };
    const result = importDesignTokens(readDesignTokens([file('libreria.json', library)]));
    expect(result.design).toMatchObject({ text_max: 15, text_min: 15, text_leading: 1.45, primary: '#6750a4' });
    expect(result.design.accent).toBeUndefined();
    expect(result.siteTokens).toMatchObject({ 'color-gradient-primary': '#000000', 'color-sfumatura-accent': '#ffffff' });
  });

  it('matches every text size to a step of the scale the server computed: never a fixed length', () => {
    const result = importDesignTokens(readDesignTokens([file('Light.tokens.json', figmaLight)]));
    const tokens = { 'xb-text-xs': 'clamp(0.7rem, 0.6rem + 0.2vw, 0.8rem)', 'xb-text-s': 'clamp(0.8rem, 0.7rem + 0.2vw, 0.9rem)', 'xb-text-m': 'clamp(1rem, 0.9rem + 0.2vw, 1.0625rem)', 'xb-h1': 'clamp(2.2rem, 2rem + 2vw, 3.4rem)', 'xb-h2': 'clamp(1.8rem, 2rem + 2vw, 2.6rem)', 'xb-space-m': '1rem' };
    expect(textSizeSteps(result.report.sizes, tokens)).toEqual([
      { token: 'font.size.body', px: 17, step: 'xb-text-m', stepPx: 17 },
      { token: 'font.size.caption', px: 13, step: 'xb-text-xs', stepPx: 12.8 },
      { token: 'font.size.h1', px: 56, step: 'xb-h1', stepPx: 54.4 },
    ]);
    const lines = tokenImportLines(result.report, textSizeSteps(result.report.sizes, tokens));
    expect(lines[0]).toBe('Token letti: 19 (formato DTCG).');
    expect(lines).toContain('font.size.caption: 13 px → --xb-text-xs (12.8 px). Le misure di testo non diventano misure fisse.');
    expect(lines).toContain('Non convertito: label.cta (tipo «string» non convertito).');
    expect(lines.join('\n')).not.toMatch(/font-size|\d+px;/);
  });

  it('reads back the tokens this panel exports: the main parameters, no site variable', () => {
    const exported = toDtcg({ 'xb-primary': 'oklch(55% 0.2 265)', 'xb-primary-500': 'oklch(55% 0.2 265)', 'xb-radius-m': '0.5rem', 'xb-font-body': 'Inter, system-ui, sans-serif', 'xb-space-m': 'clamp(1rem, 2vw, 2rem)' }, 'light').doc;
    const read = readDesignTokens([file('tokens.chiaro.json', exported)]);
    expect(read.histeon).toBe(true);
    const result = importDesignTokens(read);
    expect(result.design).toMatchObject({ primary: 'oklch(55% 0.2 265)', radius: 8, font_body: 'Inter, system-ui, sans-serif' });
    expect(result.siteTokens).toEqual({});
  });

  it('reads a file of site variables and refuses what is not one', () => {
    const good = { format: 'histeon-variabili-sito', version: 1, variabili: { 'brand-glow': 'oklch(70% 0.2 30)', 'gap-card': '1.5rem', 'Bad Name': '1px', 'evil': 'url(x)', n: 4 } };
    const read = parseSiteVariables([file('variabili-sito.json', good)]);
    expect(read.variables).toEqual({ 'brand-glow': 'oklch(70% 0.2 30)', 'gap-card': '1.5rem' });
    expect(read.skipped.map((item) => item.token)).toEqual(['Bad Name', 'evil', 'n']);
    expect(() => parseSiteVariables([{ name: 'x.json', text: '{' }])).toThrow('not-json');
    expect(() => parseSiteVariables([file('v.json', { format: 'histeon-variabili-sito', version: 2, variabili: {} })])).toThrow('not-variables');
    const many = { format: 'histeon-variabili-sito', version: 1, variabili: Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`v${n}`, '1px'])) };
    expect(() => parseSiteVariables([file('v.json', many)])).toThrow('too-many');
    // A file of design tokens gives the tokens that have no design parameter.
    expect(parseSiteVariables([file('Light.tokens.json', figmaLight)]).variables).toMatchObject({ 'spacing-card': '1.5rem' });
  });
});
