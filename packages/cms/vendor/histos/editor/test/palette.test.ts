import { describe, expect, it } from 'vitest';
import { rank, score, type Command } from '../src/lib/palette.ts';

const cmd = (label: string, group = 'Azione'): Command => ({ id: label, label, group, run: () => {} });

describe('command palette', () => {
  it('matches subsequences, accents ignored', () => {
    expect(score('sez', 'Sezione')).toBeGreaterThan(0);
    expect(score('xyz', 'Sezione')).toBe(-1);
    expect(score('perche', 'Perché XB')).toBeGreaterThan(0);
  });

  it('prefers word starts and prefixes', () => {
    const list = [cmd('Inserisci: Paragrafo'), cmd('Salva'), cmd('Anteprima'), cmd('Pubblica')];
    expect(rank(list, 'pub')[0]?.label).toBe('Pubblica');
    expect(rank(list, 'sal')[0]?.label).toBe('Salva');
    expect(rank(list, 'ins par')[0]?.label).toBe('Inserisci: Paragrafo');
  });

  it('matches the group too, and keeps order for an empty query', () => {
    const list = [cmd('Header', 'Componente'), cmd('Footer', 'Componente'), cmd('Salva')];
    expect(rank(list, 'comp foo')[0]?.label).toBe('Footer');
    expect(rank(list, '').map((c) => c.label)).toEqual(['Header', 'Footer', 'Salva']);
  });
});
