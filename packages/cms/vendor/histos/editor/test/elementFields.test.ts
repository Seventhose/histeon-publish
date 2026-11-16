import { describe, expect, it } from 'vitest';
import { parse, print, sequentialUids, type ElementBlock } from '@xb/dsl';
import { applyField, COMMON, fieldsFor, valueOf } from '../src/lib/elementFields.ts';

const el = (dsl: string) => parse(dsl, { uid: sequentialUids('n') }).blocks[0] as ElementBlock;
const field = (tag: string, attr: string) => fieldsFor(tag)!.fields.find((f) => f.attr === attr)!;
const out = (r: ReturnType<typeof applyField>) => (r.ok ? print([r.block]) : `ERR ${r.error}`);

describe('fields of an element in the Properties panel', () => {
  it('has the fields each kind of element needs', () => {
    expect(fieldsFor('a')!.title).toBe('Link');
    expect(fieldsFor('img')!.media).toBe(true);
    expect(fieldsFor('h3')!.fields[0]!.kind).toBe('level');
    expect(fieldsFor('form')!.fields.map((f) => f.attr)).toEqual(['action', 'method']);
    expect(fieldsFor('div')).toBeNull();
    expect(COMMON.fields.map((f) => f.attr)).toEqual(['id', 'aria-label']);
  });

  it('configures a static form endpoint and method from the Properties panel', () => {
    const form = el('<form><input name="email"/></form>');
    const action = applyField(form, field('form', 'action'), 'https://forms.example/submit');
    // The printer may indent: what matters is the markup.
    const flat = (r: ReturnType<typeof applyField>) => out(r).replace(/\s*\n\s*/gu, '');
    expect(flat(action)).toBe('<form action="https://forms.example/submit"><input name="email"></form>');
    const method = action.ok ? applyField(action.block, field('form', 'method'), 'post') : action;
    expect(flat(method)).toBe('<form action="https://forms.example/submit" method="post"><input name="email"></form>');
    expect(method.ok && valueOf(method.block, field('form', 'action'))).toBe('https://forms.example/submit');
    expect(method.ok && valueOf(method.block, field('form', 'method'))).toBe('post');
  });

  it('opens a link in a new tab safely, and back', () => {
    // With a class: a bare <a> with only text would be read as inline formatting, not as an element.
    const link = el('<a class="cta" href="/x" rel="nofollow">x</a>');
    const opened = applyField(link, field('a', 'target'), true);
    expect(out(opened)).toBe('<a class="cta" href="/x" rel="nofollow noopener" target="_blank">x</a>');
    expect(opened.ok && valueOf(opened.block, field('a', 'target'))).toBe(true);
    const closed = opened.ok ? applyField(opened.block, field('a', 'target'), false) : opened;
    expect(out(closed)).toBe('<a class="cta" href="/x" rel="nofollow">x</a>');
  });

  it('sets, clears and checks values', () => {
    const img = el('<img src="/a.jpg"/>');
    expect(out(applyField(img, field('img', 'alt'), 'Foto di gruppo'))).toBe('<img src="/a.jpg" alt="Foto di gruppo">');
    expect(out(applyField(el('<img src="/a.jpg" alt="x"/>'), field('img', 'alt'), ''))).toBe('<img src="/a.jpg">');
    expect(out(applyField(img, field('img', 'width'), 'largo'))).toBe('ERR Serve un numero intero.');
    expect(out(applyField(el('<h2>T</h2>'), field('h2', 'tag'), 'h3'))).toBe('<h3>T</h3>');
    expect(out(applyField(el('<input name="a"/>'), field('input', 'required'), true))).toBe('<input name="a" required>');
    expect(out(applyField(el('<input name="a" required/>'), field('input', 'required'), false))).toBe('<input name="a">');
    expect(valueOf(el('<input required/>'), field('input', 'required'))).toBe(true);
  });
});
