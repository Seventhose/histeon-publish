import { describe, expect, it } from 'vitest';
import { parse } from '@xb/dsl';
import { baseVariables, listVariants, modifier, planVariant, propName, removeVariant } from '../src/lib/variants.ts';

// Lista della spesa 157: a variant is a yes/no prop plus a BEM modifier class that redefines a few variables.
describe('varianti dei componenti', () => {
  const tree = parse('<div class="card"><h3 class="card__t">{props.titolo}</h3></div>').blocks;
  const styles = [{ id: 's1', selector: '.card', css: '--card-bg: var(--xb-surface);\n--card-fg: black;\npadding: 1rem;\n&:hover {\n  --card-bg: red;\n}' }];

  it('nomi della prop e del modificatore dalle parole', () => {
    expect(propName('Card scura')).toBe('cardScura');
    expect(propName('Più grande')).toBe('piuGrande');
    expect(propName('3 colonne')).toBe('');
    expect(modifier('cardScura')).toBe('card-scura');
  });

  it('aggiunge prop, classe condizionata e CSS di partenza con le variabili di primo livello', () => {
    const plan = planVariant(tree, {}, styles, 'Scura');
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.prop).toBe('scura');
    expect(plan.definition).toEqual({ type: 'boolean', default: false, label: 'Scura' });
    expect(plan.selector).toBe('.card--scura');
    expect(plan.css).toBe('--card-bg: var(--xb-surface);\n--card-fg: black;');
    const first = plan.tree[0]!;
    expect(first.name === 'xb/element' && first.attrs.attributes?.class).toBe('card {props.scura ? "card--scura" : ""}');
    expect(listVariants(plan.tree, { scura: plan.definition })).toEqual([{ prop: 'scura', label: 'Scura', selector: '.card--scura' }]);
    const back = removeVariant(plan.tree, 'scura')[0]!;
    expect(back.name === 'xb/element' && back.attrs.attributes?.class).toBe('card');
  });

  it('rifiuta un nome già preso e un componente senza classe', () => {
    expect(planVariant(tree, { scura: { type: 'string' } }, styles, 'Scura').ok).toBe(false);
    expect(planVariant(parse('<div><p>x</p></div>').blocks, {}, [], 'Scura').ok).toBe(false);
  });

  it('solo le variabili al primo livello', () => {
    expect(baseVariables('color: red;\n--a: 1;\n@media (--tablet) {\n  --b: 2;\n}')).toBe('--a: 1;');
  });
});

describe('classi condizionate nel pannello CSS', () => {
  it('legge i nomi tra virgolette nelle espressioni della classe', async () => {
    const { conditionalClasses } = await import('../src/lib/tree.ts');
    const [block] = parse('<div class="card {props.scura ? "card--scura" : ""} {x ? \'a b\' : "card"}"></div>').blocks;
    expect(conditionalClasses(block!)).toEqual(['card--scura', 'a', 'b']);
  });
});
