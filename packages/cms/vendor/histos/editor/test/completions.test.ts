import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { classSource, expressionSource, variableSource } from '../src/lib/completions.ts';

const vars = () => [{ name: 'space-m', group: 'spacing' }];
const classes = () => [{ name: 'btn--primary', group: 'buttons' }];
const at = (doc: string, explicit = false) => new CompletionContext(EditorState.create({ doc }), doc.length, explicit);
const ext = () => ({ data: [{ name: 'meteo', description: 'Previsioni' }], modifiers: ['upper', 'euro'] });

describe('completions', () => {
  it('wraps variables in var() unless already inside it', async () => {
    const plain = await variableSource(vars)(at('padding: --sp'));
    expect(plain?.options[0]?.apply).toBe('var(--space-m)');
    const inside = await variableSource(vars)(at('padding: var(--sp'));
    expect(inside?.options[0]?.apply).toBe('--space-m');
  });

  it('offers classes only inside a static class attribute', async () => {
    expect(await classSource(classes)(at('<a class="btn btn'))).not.toBeNull();
    expect(await classSource(classes)(at('<a href="btn'))).toBeNull();
    expect(await classSource(classes)(at('<a class="{x} b'))).toBeNull();
  });

  it('offers the site PHP data after data. and modifiers only on request', async () => {
    const data = await expressionSource(ext)(at('<p>{data.me'));
    expect(data?.options.map((o) => o.label)).toEqual(['meteo']);
    expect(data?.from).toBe('<p>{data.'.length);
    expect(await expressionSource(ext)(at('<p>{item.ti'))).toBeNull();
    const mods = await expressionSource(ext)(at('<p>{item.price.eu', true));
    expect(mods?.options.map((o) => o.label)).toContain('euro()');
    expect(await expressionSource(ext)(at('<p>{x} data.me'))).toBeNull();
  });
});
