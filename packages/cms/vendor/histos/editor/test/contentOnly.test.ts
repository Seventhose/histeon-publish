import { parse, sequentialUids } from '@xb/dsl';
import { describe, expect, it } from 'vitest';
import { contentOnlyProblem, type PropSchemas } from '../src/lib/contentOnly.ts';

const tree = (dsl: string) => parse(dsl, { uid: sequentialUids('u') }).blocks;

describe('client mode (same rule as Security\\ContentOnly)', () => {
  const before = tree('<h1 class="t">Ciao {this.title}</h1><img src="/a.jpg" alt="Foto">');
  it('accepts a text and a picture', () => {
    expect(contentOnlyProblem(before, tree('<h1 class="t">Salve {this.title}</h1><img src="/a.jpg" alt="Foto">'))).toBe('');
    expect(contentOnlyProblem(before, tree('<h1 class="t">Ciao {this.title}</h1><img src="/b.jpg" alt="Altra" width="10" height="10">'))).toBe('');
  });
  it('refuses structure, attributes and expressions', () => {
    expect(contentOnlyProblem(before, tree('<h1 class="t big">Ciao {this.title}</h1><img src="/a.jpg" alt="Foto">'))).not.toBe('');
    expect(contentOnlyProblem(before, tree('<h2 class="t">Ciao {this.title}</h2><img src="/a.jpg" alt="Foto">'))).not.toBe('');
    expect(contentOnlyProblem(before, tree('<h1 class="t">Ciao {user.email}</h1><img src="/a.jpg" alt="Foto">'))).not.toBe('');
    expect(contentOnlyProblem(before, tree('<h1 class="t">Ciao {this.title}</h1>'))).not.toBe('');
    expect(contentOnlyProblem(before, tree('<h1 class="t">Ciao {this.title}</h1><img src="/a.jpg" alt="Foto" onerror="x">'))).not.toBe('');
    expect(contentOnlyProblem(tree('<img src="{this.image}">'), tree('<img src="/c.jpg">'))).not.toBe('');
  });

  // List 135: with xb_edit_props the literal props of simple types change too, nothing else.
  const schemas: PropSchemas = (ref) => (ref === 'ui/card' ? { title: { type: 'string' }, tone: { type: 'enum', options: ['chiaro', 'scuro'] }, link: { type: 'url' }, wide: { type: 'boolean' }, body: { type: 'rich-text' }, n: { type: 'number' } } : undefined);
  const card = (props: string) => tree(`<Ui.Card ${props}/>`);
  it('without xb_edit_props, props never change', () => {
    expect(contentOnlyProblem(card('title="A"'), card('title="B"'))).not.toBe('');
  });
  it('with xb_edit_props, literal props of simple types change', () => {
    expect(contentOnlyProblem(card('title="A"'), card('title="B"'), schemas)).toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="A" tone="scuro" wide={true} n={3} link="/contatti/"'), schemas)).toBe('');
    expect(contentOnlyProblem(card('title="A" tone="chiaro"'), card('title="A"'), schemas)).toBe('');
  });
  it('with xb_edit_props, refuses expressions, other types, bad values and unknown props', () => {
    expect(contentOnlyProblem(card('title="A"'), card('title={this.title}'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title={this.title}'), card('title="B"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="{user.email}"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="A" tone="rosso"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="A" link="javascript:alert(1)"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="A" body="<b>x</b>"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="A" altro="x"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), card('title="A" n="3"'), schemas)).not.toBe('');
    expect(contentOnlyProblem(card('title="A"'), tree('<Ui.Altro title="A"/>'), schemas)).not.toBe('');
  });
});
