import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPTIONS, SECTIONS, differs, exportDesign, matches, parseImport } from '../src/histos-css/options.ts';
import { panelEnglish } from '../vite.histos-css.config.ts';

const dir = new URL('../i18n/en/', import.meta.url);
const english = (): Record<string, string> => Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
const php = readFileSync(new URL('../../plugin/src/Framework/HistosCss/DesignData.php', import.meta.url), 'utf8');

/** A constant array of DesignData.php, read as text (the file is generated from Histeon Publish's design-data.json). */
function phpArray(name: string): string {
  const start = php.indexOf(`public const ${name} = array(`);
  const end = php.indexOf(');\n\n', start);
  return php.slice(start, end);
}
const defaults = Object.fromEntries([...phpArray('DEFAULTS').matchAll(/'([a-z0-9_]+)' => ('[^']*'|[\d.]+)/g)].map(([, k, v]) => [k, v.startsWith("'") ? v.slice(1, -1) : Number(v)]));
const limits = Object.fromEntries([...phpArray('LIMITS').matchAll(/'([a-z0-9_]+)' => array\(\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)].map(([, k, min, max]) => [k, [Number(min), Number(max)]]));

describe('Histeon CSS panel options', () => {
  it('has one option for every design parameter, with the limits of DesignData', () => {
    expect(Object.keys(defaults).length).toBeGreaterThan(20);
    expect(OPTIONS.map((o) => o.key).sort()).toEqual(Object.keys(defaults).sort());
    for (const o of OPTIONS) {
      if (o.kind === 'number') expect([o.key, o.min, o.max]).toEqual([o.key, ...limits[o.key]]);
      else expect(limits[o.key], o.key).toBeUndefined();
    }
  });

  it('finds an option by its Italian label, its English words or its key', () => {
    const find = (q: string) => OPTIONS.filter((o) => matches(o, q)).map((o) => o.key);
    expect(find('raggio')).toEqual(['radius', 'btn_radius', 'card_radius', 'icon_box_radius', 'field_radius']);
    expect(find('focus ring')).toEqual(expect.arrayContaining(['field_focus_ring', 'focus_on', 'focus_width']));
    expect(find('border radius')).toEqual(['radius']);
    expect(find('button radius')).toEqual(['btn_radius']);
    expect(find('spacing ratio')).toEqual(['space_ratio_min', 'space_ratio_max']);
    expect(find('typeface heading')).toEqual(['heading_font', 'font_heading']);
    expect(find('line height')).toEqual(expect.arrayContaining(['heading_leading', 'h3_leading', 'text_leading']));
    expect(find('informazióne')).toEqual(['info', 'info_on', 'info_dark', 'btn_info_on']);
    expect(find('dark theme link')).toEqual(['role_link_dark', 'role_link_hover_dark']);
    expect(find('tema scuro primario')).toEqual(['primary_dark']);
    expect(find('text max')).toContain('text_max');
    expect(find('')).toHaveLength(OPTIONS.length);
  });

  it('exports only what differs and reads it back over the defaults', () => {
    const design = { ...defaults, primary: '#e5533d', radius: 4, text_min: 16.0000000001 };
    const file = exportDesign(design, defaults);
    expect(JSON.parse(file)).toEqual({ format: 'histos-css-design', version: 1, design: { primary: '#e5533d', radius: 4 } });
    expect(parseImport(file, defaults)).toEqual({ ...defaults, primary: '#e5533d', radius: 4 });
    expect(differs(undefined, 8)).toBe(false);
    expect(differs('8', 8)).toBe(false);
  });

  it('refuses files that are not Histeon CSS settings', () => {
    const wrap = (design: unknown) => JSON.stringify({ format: 'histos-css-design', version: 1, design });
    expect(() => parseImport('{', defaults)).toThrow('not-json');
    expect(() => parseImport('[]', defaults)).toThrow('not-histos');
    expect(() => parseImport(JSON.stringify({ format: 'other', version: 1, design: {} }), defaults)).toThrow('not-histos');
    expect(() => parseImport(wrap({ evil: 1 }), defaults)).toThrow('unknown:evil');
    expect(() => parseImport(wrap(JSON.parse('{"__proto__": {"radius": 1}}')), defaults)).toThrow('unknown:__proto__');
    expect(() => parseImport(wrap({ radius: { a: 1 } }), defaults)).toThrow('unknown:radius');
    expect(() => parseImport(wrap({ radius: null }), defaults)).toThrow('unknown:radius');
    expect(() => parseImport(' '.repeat(64 * 1024 + 1), defaults)).toThrow('too-large');
  });

  it('has the English text of every label, and the drawer carries them', () => {
    const catalog = english();
    const labels = [...new Set([
      ...OPTIONS.flatMap((o) => [o.label, ...(o.format ? [o.format] : []), ...(o.kind === 'choice' ? o.choices.filter(([v, l]) => v !== l && !/^[\d:]+$/.test(l)).map(([, l]) => l) : [])]),
      ...SECTIONS.map(([, l]) => l),
      'Palette', 'Ruoli dei colori', 'Tema scuro', 'Titoli per livello', 'Testo e radice', 'Sezioni', 'Spazi fra gli elementi', 'Layout', 'Bordo predefinito', 'Pulsanti', 'Link', 'Card', 'Icone', 'Moduli', 'Accessibilità e dettagli', 'Movimento ed effetti', 'Avanzate', 'Misure dei singoli passi', 'Sovrapposizioni e superfici',
    ])];
    expect(labels.filter((l) => !(l in catalog))).toEqual([]);
    const carried = panelEnglish();
    // Texts the same in English (H1: {0}) need no carrying.
    expect(labels.filter((l) => !(l in carried) && catalog[l] !== l)).toEqual([]);
    expect(carried['Salva in sviluppo']).toBe(catalog['Salva in sviluppo']);
    expect(Object.keys(carried).length).toBeLessThan(480);
  });
});
