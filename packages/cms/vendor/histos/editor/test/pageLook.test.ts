import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, serializeXb } from '@xb/dsl';
import { GROUPS } from '../src/lib/miniGui.ts';
import { changedProps, elementSelectors, groupOf, LOOK_GROUPS, lookProblem, pageCss, pageDeclarations, setPageDeclaration, type PageStyle } from '../src/lib/pageLook.ts';
import { BuilderState } from '../src/lib/state.svelte.ts';
import type { Api, SaveExtras } from '../src/lib/api.ts';

// Voce 186 (docs/spec/client-mode.md, «Aspetto della pagina»).
const php = readFileSync(new URL('../../plugin/src/Styles/PageLook.php', import.meta.url), 'utf8');

describe('page look', () => {
  it('has the same properties, groups and values as the server (PageLook::PROPS)', () => {
    const groups = /public const GROUPS = array\(([^)]*)\)/.exec(php)?.[1] ?? '';
    expect(groups.match(/'[a-z]+'/g)?.map((g) => g.slice(1, -1))).toEqual(LOOK_GROUPS);
    let count = 0;
    for (const group of GROUPS) {
      for (const control of group.controls) {
        const line = php.split('\n').find((l) => l.trimStart().startsWith(`'${control.prop}'`)) ?? '';
        expect(line, control.prop).toContain(`array( '${group.id}', `);
        const values = control.kind === 'choice' ? control.options.map((o) => o.value) : [...(control.extra ?? []).map((o) => o.value)];
        if (control.kind === 'scale') expect(line, control.prop).toContain(`'${group.id}', '${control.scale}'`);
        for (const value of values) expect(line, `${control.prop}: ${value}`).toContain(`'${value}'`);
        const listed = (line.slice(line.indexOf('=>')).match(/'[^']*'/g) ?? []).length - 1 - (control.kind === 'scale' ? 1 : 0);
        expect(listed, `${control.prop}: no value only on one side`).toBe(values.length);
        count++;
      }
    }
    expect((php.match(/^\t\t'[a-z-]+'\s+=> array\( '/gm) ?? []).length).toBe(count);
  });

  it('reads declarations by selector, block and property', () => {
    let entries: PageStyle[] = [];
    entries = setPageDeclaration(entries, '.title', [], 'color', 'var(--primary)');
    entries = setPageDeclaration(entries, '.title', ['@media (--tablet)', '&:hover'], 'color', 'var(--secondary)');
    const flat = pageDeclarations(entries);
    expect(flat.get('.title\u001F\u001Fcolor')).toBe('var(--primary)');
    expect(flat.get('.title\u001F@media (--tablet) &:hover\u001Fcolor')).toBe('var(--secondary)');
    expect(changedProps([], entries)).toEqual(['color']);
    // Removing the last declaration drops the entry.
    expect(setPageDeclaration(setPageDeclaration(entries, '.title', ['@media (--tablet)', '&:hover'], 'color', null), '.title', [], 'color', null)).toEqual([]);
  });

  it('refuses a change in a group the client was not given', () => {
    const after = setPageDeclaration([], '.title', [], 'padding', 'var(--space-m)');
    expect(groupOf('padding')).toBe('space');
    expect(lookProblem([], after, ['text'])).not.toBe('');
    expect(lookProblem([], after, ['space'])).toBe('');
    // What was there, untouched, is not a change.
    const both = setPageDeclaration(after, '.title', [], 'color', 'var(--primary)');
    expect(lookProblem(after, both, ['text'])).toBe('');
  });

  it('draws under one more class than the site rule', () => {
    const css = pageCss([{ selector: '.title', css: 'color: var(--primary);\n@media (--tablet) { color: var(--secondary); }' }], { tablet: '(width < 64em)' });
    expect(css).toContain(':root .title{');
    expect(css).toContain('@media (width < 64em)');
    expect(elementSelectors({ class: 'a card--{props.x} b', id: 'hero' })).toEqual(['.a', '.b', '#hero']);
  });
});

function fakeApi(sent: SaveExtras[]): Api {
  const doc = (content: string, styles: PageStyle[] = []) => ({ id: 1, type: 'page', title: 'T', status: 'publish', content, head: 'h'.repeat(32), base: 'h'.repeat(32), merged: 0, conflicts: [], published: true, link: null, script: '', scriptEditable: false, ref: null, schema: null, pageStyles: styles });
  const content = serializeXb(parse('<h1 class="title">Ciao</h1>').blocks);
  return {
    getDocument: async () => doc(content),
    getStyles: async () => ({ styles: [], globals: [], head: 's'.repeat(32), base: 's'.repeat(32) }),
    saveDocument: async (_id: number, c: string, _h: string, _b: string, extras: SaveExtras = {}) => {
      sent.push(extras);
      return doc(c, extras.styles ?? []);
    },
    saveStyles: async () => {
      throw new Error('never the site styles');
    },
    render: async () => ({ html: '', css: '', globalCss: '', stylesheets: [] }),
    listComponents: async () => [],
    getFramework: async () => ({ active: { id: 'xb-tokens', label: 'XB Tokens' }, variables: [], classes: [] }),
  } as unknown as Api;
}

describe('BuilderState and the page look of a client', () => {
  it('writes only in the groups given, and saves with the document', async () => {
    const sent: SaveExtras[] = [];
    const app = new BuilderState(fakeApi(sent), 1, true, false, { lookGroups: ['text'] });
    await app.load();
    app.setPageStyle('.title', 'padding: var(--space-m);\n');
    expect(app.pageStyles).toEqual([]);
    expect(app.status.kind).toBe('error');
    app.setPageStyle('.title', 'color: var(--primary);\n');
    expect(app.pageStyles).toEqual([{ selector: '.title', css: 'color: var(--primary);\n' }]);
    expect(app.liveCss).toContain(':root .title{');
    app.upsertStyle('.title', 'color: red;');
    expect(app.styles).toEqual([]);
    await app.save();
    expect(sent.at(-1)?.styles).toEqual([{ selector: '.title', css: 'color: var(--primary);\n' }]);
    expect(app.dirty).toBe(false);
    app.undo();
    expect(app.pageStyles).toEqual([]);
  });

  it('changes nothing on a page seen only', async () => {
    const sent: SaveExtras[] = [];
    const app = new BuilderState(fakeApi(sent), 1, true, false, { viewOnly: true, lookGroups: ['text'] });
    await app.load();
    app.setTree(parse('<h1 class="title">Altro</h1>').blocks);
    expect(app.content).toContain('Ciao');
    app.setPageStyle('.title', 'color: var(--primary);\n');
    expect(app.pageStyles).toEqual([]);
    await app.save();
    expect(sent).toEqual([]);
  });
});
