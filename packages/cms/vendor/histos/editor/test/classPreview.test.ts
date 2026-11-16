import { describe, expect, it } from 'vitest';
import { selectorHasClass } from '../src/lib/classPreview.ts';
import { classSource } from '../src/lib/completions.ts';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';

describe('class preview', () => {
  it('finds the exact class in a selector', () => {
    expect(selectorHasClass('.btn', 'btn')).toBe(true);
    expect(selectorHasClass('.card .btn:hover', 'btn')).toBe(true);
    expect(selectorHasClass('.btn, .link', 'link')).toBe(true);
    expect(selectorHasClass('.btn-primary', 'btn')).toBe(false);
    expect(selectorHasClass('.btn--primary', 'btn')).toBe(false);
    expect(selectorHasClass('.bg--primary-dark', 'bg--primary')).toBe(false);
    expect(selectorHasClass('.w-1\\/2', 'w-1/2')).toBe(true);
  });

  it('adds the description to the completions only when asked', async () => {
    const at = (doc: string) => new CompletionContext(EditorState.create({ doc }), doc.length, false);
    const items = () => [{ name: 'btn', group: 'buttons' }];
    const plain = await classSource(items)(at('<a class="b'));
    expect(plain?.options[0]?.info).toBeUndefined();
    const described = await classSource(items, () => null)(at('<a class="b'));
    expect(typeof described?.options[0]?.info).toBe('function');
  });
});
