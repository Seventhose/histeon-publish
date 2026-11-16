import { describe, expect, it } from 'vitest';
import { parse, reconcileUids, serializeXb, type XbBlock } from '@xb/dsl';
import { rebaseEntries, rebaseTree } from '../src/lib/rebase.ts';

const entry = (id: string, css: string, extra: object = {}) => ({ id, selector: `.${id}`, css, ...extra });

describe('rebaseEntries', () => {
  it('is the stored list when nothing changed locally', () => {
    const sent = [entry('a', 'color:red '), entry('b', 'color:green')];
    const stored = [entry('a', 'color:red', { assets: [] }), entry('b', 'color:green')];
    expect(rebaseEntries(sent, sent, stored)).toEqual(stored);
  });

  it('keeps local changes, takes the stored version of the rest', () => {
    const sent = [entry('a', 'color:red '), entry('b', 'color:green'), entry('c', 'color:blue')];
    const stored = [entry('a', 'color:red'), entry('b', 'color:green'), entry('c', 'color:blue'), entry('s', 'top:0')];
    // During the save: b changed, c deleted, n added.
    const local = [entry('a', 'color:red '), entry('b', 'color:black'), entry('n', 'margin:0')];
    expect(rebaseEntries(local, sent, stored)).toEqual([entry('a', 'color:red'), entry('b', 'color:black'), entry('s', 'top:0'), entry('n', 'margin:0')]);
  });

  it('drops what the server dropped, unless it was changed since', () => {
    const sent = [entry('a', 'x'), entry('b', 'y')];
    const stored: ReturnType<typeof entry>[] = [];
    expect(rebaseEntries([entry('a', 'x'), entry('b', 'z')], sent, stored)).toEqual([entry('b', 'z')]);
  });
});

/** Re-parsed text keeping the uids of `before`, as the HTML panel does. */
const edit = (before: XbBlock[], dsl: string) => reconcileUids(before, parse(dsl).blocks);

describe('rebaseTree', () => {
  it('returns the local tree itself when the server stored what was sent', () => {
    const sent = parse('<p>a</p>').blocks;
    const local = edit(sent, '<p>b</p>');
    expect(rebaseTree(local, sent, sent)).toBe(local);
  });

  it('takes the filtered version of untouched nodes and keeps the edited ones', () => {
    const sent = parse('<div><p onclick="x()">a</p><p>b</p></div>').blocks;
    const stored = edit(sent, '<div><p>a</p><p>b</p></div>');
    const local = edit(sent, '<div><p onclick="x()">a</p><p>c</p></div>');
    expect(serializeXb(rebaseTree(local, sent, stored))).toBe(serializeXb(edit(sent, '<div><p>a</p><p>c</p></div>')));
  });

  it('removes untouched nodes the server removed, with what is inside them', () => {
    const sent = parse('<p>a</p><section><p>secret</p></section>').blocks;
    const stored = [sent[0] as XbBlock];
    const local = edit(sent, '<p>z</p><section><p>secret</p></section>');
    expect(serializeXb(rebaseTree(local, sent, stored))).toBe(serializeXb(edit(sent, '<p>z</p>')));
  });

  it('keeps a removed node the user changed during the save', () => {
    const sent = parse('<p>a</p><p>b</p>').blocks;
    const stored = [sent[0] as XbBlock];
    const local = edit(sent, '<p>a</p><p>b2</p>');
    expect(serializeXb(rebaseTree(local, sent, stored))).toBe(serializeXb(local));
  });
});
