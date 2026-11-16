import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCatalog, t, tn } from '../src/lib/i18n.ts';

const root = new URL('..', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|svelte)$/.test(name) ? [path] : [];
  });
}

/** Every literal passed to t(), tn() or __() in the sources. */
export function used(): Map<string, string> {
  const out = new Map<string, string>();
  const call = /\b(?:t|tn|__)\(\s*((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)(?:\s*,\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`))?)/g;
  const literal = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
  const lit1 = `'((?:\\\\.|[^'\\\\])*)'`;
  const withContext = new RegExp(`\\btx\\(\\s*${lit1}\\s*,\\s*${lit1}`, 'g');
  for (const file of files(join(root, 'src'))) {
    if (file.endsWith('/lib/i18n.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(withContext)) out.set(`${match[2]}\u0004${match[1]}`.replace(/\\(['"`\\])/g, '$1'), file.slice(root.length));
    for (const match of source.matchAll(call)) {
      for (const lit of match[1].matchAll(literal)) {
        const raw = lit[1] ?? lit[2] ?? lit[3] ?? '';
        if (lit[3] !== undefined && raw.includes('${')) throw new Error(`${file}: t() with an interpolated template literal: ${raw}`);
        out.set(raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'), file.slice(root.length));
      }
    }
  }
  return out;
}

export function english(): Record<string, string> {
  const dir = join(root, 'i18n/en');
  return Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>));
}

describe('i18n', () => {
  afterEach(() => setCatalog({}));

  it('falls back to the Italian text and fills placeholders', () => {
    expect(t('Salva')).toBe('Salva');
    expect(t('Salvato {0} alle {1}', 'Home', '10:00')).toBe('Salvato Home alle 10:00');
    setCatalog({ Salva: 'Save', 'Salvato {0} alle {1}': 'Saved {0} at {1}', '{0} elemento': '{0} item', '{0} elementi': '{0} items' });
    expect(t('Salva')).toBe('Save');
    expect(t('Salvato {0} alle {1}', 'Home', '10:00')).toBe('Saved Home at 10:00');
    expect(tn('{0} elemento', '{0} elementi', 1, 1)).toBe('1 item');
    expect(tn('{0} elemento', '{0} elementi', 3, 3)).toBe('3 items');
  });

  it('has an English text for every text of the interface, with the same placeholders', () => {
    const catalog = english();
    const missing = [...used().entries()].filter(([text]) => !(text in catalog)).map(([text, file]) => `${file}: ${text}`);
    expect(missing).toEqual([]);
    const placeholders = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join();
    const broken = Object.entries(catalog).filter(([it, en]) => en.trim() === '' || placeholders(it) !== placeholders(en)).map(([it]) => it);
    expect(broken).toEqual([]);
  });
});
