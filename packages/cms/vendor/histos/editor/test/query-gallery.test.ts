import { describe, expect, it } from 'vitest';
import { GALLERY, galleryName, loopSnippet, parameters, parseArgs } from '../src/lib/queries.ts';

// Lista della spesa 165: ready queries, valid as written, with loops that pass the page's own values.
describe('galleria di query', () => {
  it('ogni query della galleria ha parametri validi', () => {
    for (const entry of GALLERY) expect(parseArgs(JSON.stringify(entry.preset.args))).toEqual({ args: entry.preset.args });
  });

  it('gli articoli correlati ricevono id e categoria della pagina', () => {
    const related = GALLERY.find((g) => g.name === 'articoliCorrelati')!;
    expect(parameters(related.preset.args)).toEqual(['categoria', 'count', 'escludi']);
    expect(loopSnippet('articoliCorrelati', related.preset)).toContain('{#loop articoliCorrelati(categoria: this.categories[0].id, count: 3, escludi: this.id) as item}');
  });

  it('un nome già preso riceve un numero', () => {
    expect(galleryName('ultimiArticoli', [])).toBe('ultimiArticoli');
    expect(galleryName('ultimiArticoli', ['ultimiArticoli', 'ultimiArticoli2'])).toBe('ultimiArticoli3');
  });
});
