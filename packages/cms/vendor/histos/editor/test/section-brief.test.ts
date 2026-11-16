import { describe, expect, it } from 'vitest';
import { parse, serializeXb } from '@xb/dsl';
import { nearestToken, sectionBrief } from '../src/lib/sectionBrief.ts';

// Lista della spesa 166: a library section read as instructions, with this project's tokens instead of fixed values.
describe('sezione della libreria come istruzioni', () => {
  const variables = [
    { name: 'xb-space-m', group: 'Spazi', value: '1rem' },
    { name: 'xb-space-l', group: 'Spazi', value: '2rem' },
    { name: 'xb-text-l', group: 'Testi', value: '1.5rem' },
    { name: 'xb-primary', group: 'Colori', value: '#2563eb' },
  ];

  it('un valore fisso diventa il token più vicino del progetto', () => {
    expect(nearestToken('30px', variables, 'padding')).toBe('--xb-space-l');
    expect(nearestToken('24px', variables, 'font-size')).toBe('--xb-text-l');
    expect(nearestToken('#2563EB', variables, 'color')).toBe('--xb-primary');
    expect(nearestToken('var(--altro)', variables, 'gap')).toBeNull();
  });

  it('descrive parti, ruoli e disposizione senza dare il markup da copiare', () => {
    const brief = sectionBrief(
      'Eroe',
      {
        xb: 'clip',
        version: 1,
        origin: 'https://altro.example',
        markup: serializeXb(parse('<section class="hero"><h2 class="hero__title">Ciao</h2><a class="hero__cta" href="/x">Vai</a></section>').blocks),
        styles: [{ selector: '.hero', css: 'display: grid;\ngap: 15px;\npadding: 32px;\n&:hover {\n  color: red;\n}' }],
      },
      variables,
    );
    expect(brief).toContain('Non copiarne il markup');
    expect(brief).toContain('- <section>: blocco (nell\'originale .hero)');
    expect(brief).toContain('  - <h2>: titolo, parte «title» del blocco');
    expect(brief).toContain('padding: 32px → nel progetto: --xb-space-l');
    expect(brief).toContain('gap: 15px → nel progetto: --xb-space-m');
    expect(brief).not.toContain('color: red');
  });
});
