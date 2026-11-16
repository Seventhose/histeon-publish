import { describe, expect, it } from 'vitest';
import { abbreviationBefore, cursorIn, expandAbbreviation } from '../src/lib/emmet.ts';

describe('Emmet abbreviations', () => {
  it('expands tags, classes, ids, attributes, text and nesting', () => {
    expect(expandAbbreviation('section.hero>h2.hero__title{Ciao}+p')).toBe('<section class="hero">\n  <h2 class="hero__title">Ciao</h2>\n  <p></p>\n</section>');
    expect(expandAbbreviation('.card#top')).toBe('<div id="top" class="card"></div>');
    expect(expandAbbreviation('a[href="/x" target=_blank]{Vai}')).toBe('<a href="/x" target="_blank">Vai</a>');
    expect(expandAbbreviation('img.foto[alt=""]')).toBe('<img class="foto" alt="">');
    expect(expandAbbreviation('ul>.item$*3')).toBe('<ul>\n  <li class="item1"></li>\n  <li class="item2"></li>\n  <li class="item3"></li>\n</ul>');
    expect(expandAbbreviation('div>(h3+p)*2^footer')).toBe('<div>\n  <h3></h3>\n  <p></p>\n  <h3></h3>\n  <p></p>\n</div>\n<footer></footer>');
    expect(expandAbbreviation('p', '    ')).toBe('<p></p>');
    expect(expandAbbreviation('div>p', '  ')).toBe('<div>\n    <p></p>\n  </div>');
  });

  it('never turns ordinary words or odd input into markup', () => {
    expect(expandAbbreviation('ciao')).toBeNull();
    expect(expandAbbreviation('the')).toBeNull();
    expect(expandAbbreviation('div>')).toBeNull();
    expect(expandAbbreviation('p{non chiuso')).toBeNull();
    expect(expandAbbreviation('p*999999>a*999999'), 'a size limit').toBeNull();
  });

  it('keeps typed text as text: tags escaped, braces literal', () => {
    expect(expandAbbreviation('p{<b>x</b> {a}}')).toBeNull();
    expect(expandAbbreviation('p{a < b & c}')).toBe('<p>a &lt; b &amp; c</p>');
    expect(expandAbbreviation('a[title="x" onclick="y"]')).toBe('<a title="x" onclick="y"></a>');
  });

  it('finds the abbreviation before the cursor and where the cursor goes', () => {
    expect(abbreviationBefore('  <p>Testo</p>ul>li')).toBe('ul>li');
    expect(abbreviationBefore('    section.hero>p{Due parole}')).toBe('section.hero>p{Due parole}');
    expect(abbreviationBefore('  <div class="x">')).toBeNull();
    expect(cursorIn('<section class="hero">\n  <p></p>\n</section>')).toBe(28);
  });
});
