import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, type ElementBlock } from '@xb/dsl';
import { attributeNameError, removeAttribute, setAttribute, setTag, setText, textOf } from '../src/lib/attributes.ts';

function element(dsl: string): ElementBlock {
  const block = parse(dsl, { uid: sequentialUids() }).blocks[0];
  if (block?.name !== 'xb/element') throw new Error('not an element');
  return block;
}

describe('attribute rows', () => {
  it('renames in place, keeping the order', () => {
    const r = setAttribute(element('<a href="/x" class="c" target="_blank">t</a>'), 'class', 'id', 'c');
    expect(r.ok && Object.keys(r.block.attrs.attributes ?? {})).toEqual(['href', 'id', 'target']);
  });

  it('keeps booleans boolean and adds new ones without a value', () => {
    const b = element('<input disabled />');
    const kept = setAttribute(b, 'disabled', 'disabled', '');
    expect(kept.ok && kept.block.attrs.attributes?.disabled).toBe(true);
    const added = setAttribute(b, null, 'required', '');
    expect(added.ok && added.block.attrs.attributes?.required).toBe(true);
    const valued = setAttribute(b, null, 'placeholder', 'Nome');
    expect(valued.ok && valued.block.attrs.attributes?.placeholder).toBe('Nome');
  });

  it('refuses names the DSL or the builder reserve', () => {
    for (const name of ['', 'a b', '"x', '__proto__', 'xb:label', 'XB:uid', 'on{x}']) expect(attributeNameError(name)).not.toBeNull();
    const dup = setAttribute(element('<p class="a" id="b">x</p>'), 'id', 'class', 'b');
    expect(dup.ok).toBe(false);
  });

  it('removes the last attribute cleanly', () => {
    expect(removeAttribute(element('<p class="a">x</p>'), 'class').attrs.attributes).toBeUndefined();
  });

  it('changes tags only where the content still fits', () => {
    const p = element('<p class="a">x</p>');
    const h2 = setTag(p, 'h2');
    expect(h2.ok && h2.block.attrs.tag).toBe('h2');
    expect(setTag(p, 'img').ok).toBe(false);
    expect(setTag(p, 'script').ok).toBe(false);
    expect(setTag(p, 'DIV').ok).toBe(false);
    expect(setTag(p, 'x"y').ok).toBe(false);
    expect(setTag(element('<img src="/a.jpg" />'), 'div').ok).toBe(true);
  });

  it('edits the text of simple elements only', () => {
    const p = element('<p>ciao</p>');
    expect(textOf(p)).toBe('ciao');
    const r = setText(p, 'salve {this.title}', () => 'zzzzzzzz');
    expect(r.ok && r.block.children[0]).toMatchObject({ name: 'xb/text', attrs: { uid: p.children[0]?.attrs.uid, content: 'salve {this.title}' } });
    const emptied = setText(p, '', () => 'zzzzzzzz');
    expect(emptied.ok && emptied.block.children).toEqual([]);
    expect(textOf(element('<div><p>a</p></div>'))).toBeNull();
    expect(textOf(element('<img src="/a.jpg" />'))).toBeNull();
    expect(setText(element('<div><p>a</p></div>'), 'x', () => 'zzzzzzzz').ok).toBe(false);
  });

  it('keeps markup outside the inline subset as literal text', () => {
    const r = setText(element('<p>a</p>'), '<div>blocco</div> e <strong>forte</strong>', () => 'zzzzzzzz');
    expect(r.ok && r.block.children).toHaveLength(1);
  });
});
