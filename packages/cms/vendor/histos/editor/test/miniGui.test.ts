import { describe, expect, it } from 'vitest';
import { declarations, GROUPS, groupIsSet, optionsFor, relevant, scalesFrom, setDeclaration } from '../src/lib/miniGui.ts';

describe('mini GUI', () => {
  it('reads and writes top-level declarations, keeping nested rules', () => {
    const css = 'display: flex;\n&:hover { color: red; }\n@media (width <= 720px) { gap: 0; }\n';
    expect(declarations(css)).toEqual({ display: 'flex' });
    const set = setDeclaration(css, 'gap', 'var(--space-m)');
    expect(declarations(set)).toEqual({ display: 'flex', gap: 'var(--space-m)' });
    expect(set).toContain('&:hover');
    expect(set).toContain('@media (width <= 720px)');
    const removed = setDeclaration(set, 'display', null);
    expect(declarations(removed)).toEqual({ gap: 'var(--space-m)' });
    expect(removed).toContain('&:hover');
    expect(setDeclaration('display: flex;', 'display', null)).toBe('');
  });

  it('finds the scales by name, whatever the framework groups', () => {
    const cf = scalesFrom([
      { name: 'space-m', group: 'spacingStyles' },
      { name: 'space-xs', group: 'spacingStyles' },
      { name: 'space-2xl', group: 'spacingStyles' },
      { name: 'text-l', group: 'typographyStyles' },
      { name: 'text-body', group: 'colorStyles' },
      { name: 'primary', group: 'colorStyles' },
      { name: 'primary-l-2', group: 'colorStyles' },
      { name: 'radius-m', group: 'designStyles' },
      { name: 'shadow-s', group: 'designStyles' },
      { name: 'xb-space-m', group: 'xb' },
    ]);
    expect(cf.space.map((o) => o.label)).toEqual(['xs', 'm', '2xl']);
    expect(cf.text.map((o) => o.value)).toEqual(['var(--text-l)']);
    expect(cf.color.map((o) => o.label)).toEqual(['primary', 'primary-l-2']);
    expect(cf.radius[0]?.value).toBe('var(--radius-m)');
    const tokensOnly = scalesFrom([{ name: 'xb-space-s', group: 'xb' }, { name: 'xb-primary', group: 'xb' }]);
    expect(tokensOnly.space.map((o) => o.value)).toEqual(['var(--xb-space-s)']);
    expect(tokensOnly.color.map((o) => o.value)).toEqual(['var(--xb-primary)']);
  });

  it('offers every control with options', () => {
    const scales = scalesFrom([{ name: 'space-m', group: 'g' }, { name: 'radius-s', group: 'g' }]);
    for (const g of GROUPS) for (const c of g.controls) if (c.kind === 'choice') expect(optionsFor(c, scales).length).toBeGreaterThan(0);
    const radius = GROUPS.flatMap((g) => g.controls).find((c) => c.prop === 'border-radius')!;
    expect(optionsFor(radius, scales).map((o) => o.value)).toEqual(['var(--radius-s)', '0', '999px']);
  });
});

describe('mini GUI: only what makes sense now', () => {
  const control = (prop: string) => GROUPS.flatMap((g) => g.controls).find((c) => c.prop === prop)!;
  it('flex and grid settings for a flex or grid box only', () => {
    expect(relevant(control('flex-direction'), {})).toBe(false);
    expect(relevant(control('flex-direction'), { display: 'flex' })).toBe(true);
    expect(relevant(control('grid-template-columns'), { display: 'flex' })).toBe(false);
    expect(relevant(control('grid-template-columns'), { display: 'grid' })).toBe(true);
    expect(relevant(control('gap'), { display: 'inline-grid' })).toBe(true);
    expect(relevant(control('display'), {})).toBe(true);
  });
  it('offsets for a positioned box, object-fit for media, and anything already written', () => {
    expect(relevant(control('z-index'), {})).toBe(false);
    expect(relevant(control('z-index'), { position: 'sticky' })).toBe(true);
    expect(relevant(control('object-fit'), {}, 'div')).toBe(false);
    expect(relevant(control('object-fit'), {}, 'IMG')).toBe(true);
    expect(relevant(control('justify-content'), { 'justify-content': 'center' })).toBe(true);
  });
  it('a dot on groups with values', () => {
    expect(groupIsSet(GROUPS.find((g) => g.id === 'text')!, { color: 'red' })).toBe(true);
    expect(groupIsSet(GROUPS.find((g) => g.id === 'size')!, { color: 'red' })).toBe(false);
  });
});
