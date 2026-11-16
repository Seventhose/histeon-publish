import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, type Preview } from '../src/lib/api.ts';
import type { BuilderConfig } from '../src/lib/config.ts';

const api = new Api({ restUrl: '/wp-json/xb/v1/', nonce: 'n' } as unknown as BuilderConfig);

/** Answers every request with `reply` and records what was sent. */
function serve(reply: Record<string, unknown>) {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      return new Response(JSON.stringify(reply), { status: 200 });
    }),
  );
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('Api.render', () => {
  it('asks for the site CSS only when told to, and sends no hash on the first drawing', async () => {
    const sent = serve({ html: '<p>x</p>', globalCss: 'body{}', globalHash: 'h1', stylesheets: [] });
    const first = await api.render(1, 'c');
    expect(sent[0]).toMatchObject({ css: false, global_hash: '' });
    expect(first.globalCss).toBe('body{}');
    await api.render(1, 'c', undefined, 0, { css: true });
    expect(sent[1]).toMatchObject({ css: true });
  });

  it('keeps the site-wide CSS it already has when the server leaves it out', async () => {
    const known: Preview = { html: '', globalCss: 'body{margin:0}', globalHash: 'h1', stylesheets: [] };
    const sent = serve({ html: '<p>y</p>', globalHash: 'h1', stylesheets: [] });
    const next = await api.render(1, 'c', undefined, 0, { known });
    expect(sent[0]).toMatchObject({ global_hash: 'h1' });
    expect(next).toMatchObject({ html: '<p>y</p>', globalCss: 'body{margin:0}', globalHash: 'h1' });
  });

  it('takes the new site-wide CSS when its hash changed', async () => {
    const known: Preview = { html: '', globalCss: 'old', globalHash: 'h1', stylesheets: [] };
    serve({ html: '', globalCss: 'new', globalHash: 'h2', stylesheets: [] });
    expect((await api.render(1, 'c', undefined, 0, { known })).globalCss).toBe('new');
  });
});

describe('Api.saveDocument', () => {
  it('asks for a lean answer and keeps the content it sent when the server stored it as it was', async () => {
    const sent = serve({ id: 1, head: 'h'.repeat(32), unchanged: true });
    const doc = await api.saveDocument(1, '<!-- wp:xb/text {"uid":"a0000001","content":"x"} /-->', 'h', 'b');
    expect(sent[0]).toMatchObject({ lean: true });
    expect(doc.content).toBe('<!-- wp:xb/text {"uid":"a0000001","content":"x"} /-->');
  });

  it('takes the stored content when the server changed it', async () => {
    serve({ id: 1, head: 'h'.repeat(32), content: 'filtrato' });
    expect((await api.saveDocument(1, 'mandato', 'h', 'b')).content).toBe('filtrato');
  });
});

describe('Api with the answers the page carries (V6)', () => {
  const content = '<!-- wp:xb/text {"uid":"a0000001","content":"x"} /-->';
  const booted = () =>
    new Api({
      restUrl: '/wp-json/xb/v1/',
      nonce: 'n',
      postId: 7,
      boot: {
        document: { id: 7, content, head: 'h'.repeat(32) },
        styles: { styles: [], globals: [] },
        components: [],
        render: Promise.resolve({ html: '<p>x</p>', globalCss: 'body{}', globalHash: 'g', stylesheets: [] }),
      },
    } as unknown as BuilderConfig);

  it('uses each one once, then asks the server', async () => {
    const sent = serve({ html: '<p>dal server</p>', globalHash: 'g', stylesheets: [] });
    const api = booted();
    expect((await api.getDocument(7)).content).toBe(content);
    expect(await api.listComponents()).toEqual([]);
    expect((await api.render(7, content)).html).toBe('<p>x</p>');
    expect(sent, 'nothing asked yet').toHaveLength(0);
    expect((await api.render(7, content)).html).toBe('<p>dal server</p>');
    await api.getStyles();
    await api.getStyles();
    expect(sent).toHaveLength(2);
  });

  it('does not use the early drawing for another content', async () => {
    const sent = serve({ html: '<p>altro</p>', globalHash: 'g', stylesheets: [] });
    const api = booted();
    await api.getDocument(7);
    expect((await api.render(7, content + ' ')).html).toBe('<p>altro</p>');
    expect(sent).toHaveLength(1);
  });
});
