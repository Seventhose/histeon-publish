import { describe, expect, it } from 'vitest';
import { fromSfc, SfcError, splitRules, toSfc } from '../src/lib/sfc.ts';

const parts = {
  html: '<article class="card">\n  <h2 class="card__title">{props.title}</h2>\n</article>',
  styles: [
    ['.card', 'padding: var(--space-m);\n&__title { color: red; }'],
    ['.card__title', ''],
  ] as Array<[string, string]>,
  script: "document.querySelectorAll('.card').forEach(() => {});",
  props: { title: { type: 'string', default: 'Titolo' } },
};

describe('single-file view', () => {
  it('prints a document as one file and reads it back', () => {
    const text = toSfc(parts);
    expect(text).toContain('<template>\n  <article class="card">');
    expect(text).toContain('<style>\n.card {\n  padding: var(--space-m);\n  &__title { color: red; }\n}\n\n.card__title {\n}\n</style>');
    expect(text).toContain('<script type="application/json" data-props>');
    expect(fromSfc(text)).toEqual(parts);
  });

  it('leaves out what a document does not have', () => {
    const page = toSfc({ html: '<p>x</p>', styles: [], script: '', props: null });
    expect(page).toBe('<template>\n  <p>x</p>\n</template>\n');
    expect(fromSfc(page)).toEqual({ html: '<p>x</p>', styles: [], script: '', props: null });
  });

  it('says what is wrong, and where', () => {
    expect(() => fromSfc('<p>x</p>')).toThrow(/Manca <template>/);
    expect(() => fromSfc('<template></template>\nciao')).toThrow(/fuori dalle sezioni/);
    expect(() => fromSfc('<template></template><style>@media (x) { .a { b: c } }</style>')).toThrow(/solo regole/);
    expect(() => fromSfc('<template></template><style>.a { b: c </style>')).toThrow(/Graffe/);
    expect(() => fromSfc('<template></template><script type="application/json" data-props>[1]</script>')).toThrow(/oggetto/);
    expect(() => fromSfc('<template></template><style></style><style></style>')).toThrow(/ripetuta/);
    // <template> elements in the page itself: the section ends at the last </template>.
    expect(fromSfc('<template>\n  <template><p>x</p></template>\n</template>').html).toBe('<template><p>x</p></template>');
    // A </script> inside the code survives the round trip.
    const js = 'const s = "</script>";';
    expect(fromSfc(toSfc({ html: '<p/>', styles: [], script: js, props: null })).script).toBe(js);
    try {
      fromSfc('<template></template>\n<style>\n.a { x: 1 }\nfuori\n</style>');
    } catch (e) {
      expect(e).toBeInstanceOf(SfcError);
      expect((e as SfcError).offset).toBeGreaterThan(20);
    }
  });

  it('splits rules with nesting, strings and comments', () => {
    expect(splitRules('/* c */ .a { content: "}"; &:hover { x: 1 } } #b{y:2}')).toEqual([
      ['.a', 'content: "}"; &:hover { x: 1 }'],
      ['#b', 'y:2'],
    ]);
  });
});
