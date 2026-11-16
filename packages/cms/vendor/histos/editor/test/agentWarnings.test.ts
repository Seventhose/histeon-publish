import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, serializeXb } from '@xb/dsl';
import { BuilderState } from '../src/lib/state.svelte.ts';
import { createApi, markupWarnings } from '../src/lib/publicApi.ts';
import { handlers } from '../src/lib/connector.svelte.ts';
import type { Api } from '../src/lib/api.ts';

async function builder() {
  const content = serializeXb(parse('<section class="hero"><h1>Ciao</h1></section>', { uid: sequentialUids('u') }).blocks);
  const fake = {
    getDocument: async () => ({ id: 1, type: 'page', title: 'T', status: 'publish', content, head: 'h'.repeat(32), base: 'h'.repeat(32), merged: 0, conflicts: [], published: true, link: null, script: '', scriptEditable: true, ref: null, schema: null }),
    getStyles: async () => ({ styles: [], globals: [], queries: { tablet: '(width < 64em)' }, head: 's'.repeat(32), base: 's'.repeat(32) }),
    render: async () => ({ html: '', globalCss: '', globalHash: '', stylesheets: [] }),
    listComponents: async () => [],
    getFramework: async () => ({
      active: { id: 'core', label: 'Core' },
      variables: [{ name: 'space-m', group: 'spacing', value: '1.5rem' }],
      classes: ['flex', 'gap-m', 'p-m', 'bg-dark', 'text-l'].map((name) => ({ name, group: 'utility' })),
    }),
  } as unknown as Api;
  const app = new BuilderState(fake, 1);
  await app.load();
  const { api } = createApi(app);
  return { app, api, run: handlers(api) };
}

describe('warnings for agents (I1)', () => {
  it('lints the CSS an agent writes as the CSS panel does', async () => {
    const { api, run } = await builder();
    const codes = api.lintCss('.hero', 'padding: var(--space-xx); @media (--phone) { color: red !important }').map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['unknown-variable', 'unknown-query', 'important']));
    expect(api.lintCss('.hero', 'padding: var(--space-m); @media (--tablet) { gap: var(--space-m) }')).toEqual([]);
    const answer = run.setCss!({ selector: '.hero', css: 'margin: var(--nope)' }) as { ok: boolean; warnings: Array<{ code: string; message: string }> };
    expect(answer.ok).toBe(true);
    expect(answer.warnings[0]).toMatchObject({ code: 'unknown-variable' });
    expect(answer.warnings[0]!.message).toContain('--nope');
    expect(api.getCss('.hero'), 'written anyway: the warning is for the next step').toBe('margin: var(--nope)');
  });

  it('flags utility chains, classes outside BEM and inline styles in inserted markup', async () => {
    const { api, run } = await builder();
    const warnings = api.lintHtml('<div class="flex gap-m p-m bg-dark"><p class="Testo_Grande" style="color:red">x</p><p class="card__title">y</p></div>');
    expect(warnings.map((w) => w.code)).toEqual(['utility-chain', 'not-bem', 'inline-style']);
    expect(api.lintHtml('<article class="card"><h2 class="card__title text-l">ok</h2></article>')).toEqual([]);
    const answer = run.insert!({ html: '<p style="margin:0">z</p>' }) as { uids: string[]; warnings: Array<{ code: string }> };
    expect(answer.uids).toHaveLength(1);
    expect(answer.warnings.map((w) => w.code)).toEqual(['inline-style']);
  });

  it('leaves dynamic class lists alone', () => {
    expect(markupWarnings(parse('<p class="{item.kind} Strano">x</p>').blocks, new Set())).toEqual([]);
  });
});
