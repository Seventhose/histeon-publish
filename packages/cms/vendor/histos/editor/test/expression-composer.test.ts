import { describe, expect, it } from 'vitest';
import { composeExpression, composeText, dataChoices, formatsFor, readExpression, valid } from '../src/lib/expressionComposer.ts';

// Lista della spesa 156: the composer writes what the expression language reads, and reads back what it wrote.
describe('compositore di espressioni', () => {
  const choices = dataChoices({ loops: ['post'], props: ['titolo'] });

  it('offre i dati del loop, delle props, della pagina, del sito e del visitatore', () => {
    const paths = choices.map((c) => c.path);
    expect(paths.indexOf('post.title')).toBeLessThan(paths.indexOf('this.title'));
    expect(paths).toContain('props.titolo');
    expect(paths).toContain('site.name');
    expect(paths).toContain('user.name');
  });

  it('compone espressioni valide per ogni forma', () => {
    const cases: Array<[Parameters<typeof composeExpression>[0], string]> = [
      [{ path: 'this.title', format: 'none', arg: '', fallback: '' }, 'this.title'],
      [{ path: 'this.title', format: 'upper', arg: '', fallback: '' }, 'this.title.upper()'],
      [{ path: 'post.date', format: 'date', arg: 'j F Y', fallback: '' }, 'post.date.date("j F Y")'],
      [{ path: 'this.commentCount', format: 'number', arg: '2', fallback: '' }, 'this.commentCount.number(2)'],
      [{ path: 'this.excerpt', format: 'words', arg: 'abc', fallback: 'Nessun estratto' }, 'this.excerpt.truncateWords(20) ?? "Nessun estratto"'],
      [{ path: 'this.categories', format: 'join', arg: ' · ', fallback: '' }, 'this.categories.join(" · ")'],
      [{ path: 'site.logo', format: 'imageAlt', arg: '', fallback: '' }, 'site.logo.alt'],
      [{ path: 'this.title', format: 'none', arg: '', fallback: 'Il "titolo"' }, 'this.title ?? "Il \\"titolo\\""'],
    ];
    for (const [c, expected] of cases) {
      expect(composeExpression(c)).toBe(expected);
      expect(valid(composeExpression(c))).toBe(true);
    }
    expect(composeText({ path: 'this.date', format: 'date', arg: 'd/m/Y', fallback: '' }, 'Pubblicato il ', '.')).toBe('Pubblicato il {this.date.date("d/m/Y")}.');
    // The words around stay words: a brace in them does not open an expression.
    expect(composeText({ path: 'this.title', format: 'none', arg: '', fallback: '' }, 'Prezzo {euro} ', ' }')).toBe('Prezzo \\{euro\\} {this.title} \\}');
  });

  it('rilegge ciò che ha scritto, e solo quello', () => {
    for (const c of [
      { path: 'post.date', format: 'date', arg: 'l j F', fallback: '—' },
      { path: 'this.excerpt', format: 'chars', arg: '80', fallback: '' },
      { path: 'this.image', format: 'imageUrl', arg: '', fallback: '' },
      { path: 'props.titolo', format: 'capitalize', arg: '', fallback: 'Titolo' },
    ] as const) {
      expect(readExpression(composeExpression(c), choices)).toEqual(c);
    }
    expect(readExpression('this.title && user.name', choices)).toBeNull();
    expect(readExpression('this.secret.upper()', choices)).toBeNull();
    expect(readExpression('this.title.slug()', choices)).toBeNull();
  });

  it('le date si formattano come data, le immagini danno indirizzo o testo alternativo', () => {
    expect(formatsFor('date')[0]!.id).toBe('date');
    expect(formatsFor('image').map((f) => f.id)).toEqual(['imageUrl', 'imageAlt']);
  });
});
