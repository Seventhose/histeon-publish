import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, serializeXb } from '@xb/dsl';
import { BuilderState } from '../src/lib/state.svelte.ts';
import { createApi } from '../src/lib/publicApi.ts';
import { handlers } from '../src/lib/connector.svelte.ts';
import type { Api } from '../src/lib/api.ts';

const DSL = '<section class="hero"><h1>Ciao</h1><p class="lead">Testo</p><ul><li>a</li></ul><img src="/a.png" alt="x"></section>';

async function page() {
  const content = serializeXb(parse(DSL, { uid: sequentialUids('u') }).blocks);
  const fake = {
    getDocument: async () => ({ id: 1, type: 'page', title: 'T', status: 'publish', content, head: 'h'.repeat(32), base: 'h'.repeat(32), merged: 0, conflicts: [], published: true, link: null, script: '', scriptEditable: true, ref: null, schema: null }),
    getStyles: async () => ({ styles: [], globals: [], head: 's'.repeat(32), base: 's'.repeat(32) }),
    render: async () => ({ html: '', globalCss: '', globalHash: '', stylesheets: [] }),
    listComponents: async () => [],
    getFramework: async () => ({ active: { id: 'xb-tokens', label: 'XB Tokens' }, variables: [], classes: [] }),
  } as unknown as Api;
  const app = new BuilderState(fake, 1);
  await app.load();
  const { api } = createApi(app);
  const uid = (tag: string): string => {
    const found = JSON.stringify(app.tree).match(new RegExp(`"uid":"(u\\d+)","tag":"${tag}"`));
    if (!found) throw new Error(tag);
    return found[1]!;
  };
  return { app, api, uid, run: handlers(api) };
}

describe('fine operations for agents (I6)', () => {
  it('changes one text, one attribute, one position, each one undo step', async () => {
    const { app, api, uid } = await page();
    api.setText(uid('h1'), 'Benvenuti {this.title}');
    expect(api.getElementHtml(uid('h1'))).toBe('<h1>Benvenuti {this.title}</h1>');
    api.setAttribute(uid('img'), 'alt', 'Il porto al tramonto');
    api.setAttribute(uid('img'), 'loading', 'lazy');
    api.setAttribute(uid('ul'), 'hidden', true);
    api.setAttribute(uid('p'), 'class', null);
    expect(api.getElementHtml(uid('img'))).toBe('<img src="/a.png" alt="Il porto al tramonto" loading="lazy">');
    expect(api.getElementHtml(uid('ul'))).toContain('<ul hidden>');
    expect(api.getElementHtml(uid('p'))).toBe('<p>Testo</p>');
    api.move(uid('p'), uid('h1'), 'before');
    expect(api.getHtml().indexOf('<p>')).toBeLessThan(api.getHtml().indexOf('<h1>'));
    app.undo();
    expect(api.getHtml().indexOf('<h1>')).toBeLessThan(api.getHtml().indexOf('<p>'));
  });

  it('refuses what the Properties panel refuses', async () => {
    const { api, uid } = await page();
    expect(() => api.setText(uid('ul'), 'x')).toThrow(/altri elementi/);
    expect(() => api.setAttribute(uid('img'), 'xb:uid', 'x')).toThrow(/riservati/);
    expect(() => api.setAttribute(uid('img'), 'a b', 'x')).toThrow(/Nome non valido/);
    expect(() => api.move(uid('section'), uid('h1'), 'inside')).toThrow(/non può/);
    expect(() => api.move(uid('h1'), 'nessuno', 'after')).toThrow(/nessun elemento/);
    expect(() => api.setText('nessuno', 'x')).toThrow(/nessun elemento/);
  });

  it('reaches the connector with checked arguments', async () => {
    const { api, uid, run } = await page();
    expect(run.setText!({ uid: uid('h1'), text: 'Dal connettore' })).toEqual({ ok: true });
    expect(api.getElementHtml(uid('h1'))).toBe('<h1>Dal connettore</h1>');
    expect(run.setAttribute!({ uid: uid('img'), name: 'alt', value: null })).toEqual({ ok: true });
    expect(api.getElementHtml(uid('img'))).toBe('<img src="/a.png">');
    expect(() => run.move!({ uid: uid('p'), target: uid('h1'), position: 'sopra' })).toThrow(/before, after o inside/);
    expect(() => run.setAttribute!({ uid: uid('img'), name: 'alt', value: 3 })).toThrow(/value/);
  });
});
