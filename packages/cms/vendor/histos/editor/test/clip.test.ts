import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, type XbBlock } from '@xb/dsl';
import { classesOf, freeName, makeClip, planClasses, readClip, renameClasses, renameSelector } from '../src/lib/clip.ts';
import { applyPaste } from '../src/lib/pastePlan.ts';
import type { BuilderState } from '../src/lib/state.svelte.ts';

const tree = (dsl: string): XbBlock[] => parse(dsl, { uid: sequentialUids('n') }).blocks;

describe('copy and paste between sites', () => {
  const blocks = tree('<article class="card {item.x}"><h2 class="card__title">T</h2></article>');

  it('copies the styles of the classes used, and only those', () => {
    expect([...classesOf(blocks)].sort()).toEqual(['card', 'card__title']);
    const clip = makeClip(blocks, [{ selector: '.card', css: 'padding:1rem' }, { selector: '.card__title', css: 'margin:0' }, { selector: '.other', css: 'x:1' }], 'a.example');
    expect(clip.styles.map((s) => s.selector)).toEqual(['.card', '.card__title']);
    expect(readClip(JSON.stringify(clip))?.markup).toBe(clip.markup);
  });

  it('refuses what is not a clip or carries bad selectors', () => {
    expect(readClip('<p>x</p>')).toBeNull();
    expect(readClip('{"xb":"other"}')).toBeNull();
    const bad = readClip(JSON.stringify({ xb: 'clip', version: 1, origin: 'x', markup: '', styles: [{ selector: '.a}body{display:none', css: '' }, { selector: '.ok', css: 'a:b' }] }));
    expect(bad?.styles.map((s) => s.selector)).toEqual(['.ok']);
  });

  it('plans new, same and clashing classes, and renames everywhere', () => {
    const clip = makeClip(blocks, [{ selector: '.card', css: 'padding: 1rem;' }, { selector: '.card__title', css: 'margin:0' }], 'a');
    const plan = planClasses(clip, [{ selector: '.card', css: 'padding:1rem' }, { selector: '.card__title', css: 'margin:2rem' }], new Set());
    expect(plan).toEqual([{ name: 'card', fate: 'same' }, { name: 'card__title', fate: 'conflict' }]);
    expect(planClasses(clip, [], new Set(['card']))[0]?.fate).toBe('conflict');
    expect(freeName('card', new Set(['card-2']))).toBe('card-3');
    const map = new Map([['card__title', 'card__title-2']]);
    const renamed = renameClasses(blocks, map);
    expect(JSON.stringify(renamed)).toContain('"class":"card__title-2"');
    expect(JSON.stringify(renamed)).toContain('"class":"card {item.x}"');
    expect(renameSelector('.card__title:hover, .card .card__title-x', map)).toBe('.card__title-2:hover, .card .card__title-x');
  });

  it('brings the styles of new classes even when their name starts like a class the site has', () => {
    const pasted = tree('<div class="card"><p class="card-2">x</p><p class="card__body">y</p></div>');
    const clip = makeClip(pasted, [{ selector: '.card', css: 'padding:1rem' }, { selector: '.card-2', css: 'color:red' }, { selector: '.card__body:hover', css: 'margin:0' }], 'a');
    const site = [{ selector: '.card', css: 'padding:1rem' }];
    const plan = planClasses(clip, site, new Set());
    expect(plan.find((p) => p.name === 'card')?.fate).toBe('same');
    const written: string[] = [];
    const app = { tree: [], styles: site, upsertStyle: (selector: string) => written.push(selector), insert: () => {} } as unknown as BuilderState;
    applyPaste(app, { clip, blocks: pasted, plan, missing: [] });
    expect(written).toEqual(['.card-2', '.card__body:hover']);
  });
});
