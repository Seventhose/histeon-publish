import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module shipped with the plugin
import worker, { handleForm, hmac } from '../../../plugin/assets/worker/worker.js';

const env = {
  TURNSTILE_SECRET: 'turnstile-secret',
  XB_FORMS_SECRET: 'forms-secret',
  XB_FORMS_ENDPOINT: 'https://wp.example/wp-json/xb/v1/forms',
  ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
};

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request('https://site.example/xb-form', { method: 'POST', body, headers });
}

function mockFetch(turnstileOk: boolean, hostname = 'site.example') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('turnstile')) return new Response(JSON.stringify({ success: turnstileOk, hostname }));
    return new Response('{}', { status: 201 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('static site worker', () => {
  it('serves assets for everything else', async () => {
    const res = await worker.fetch(new Request('https://site.example/about/'), env);
    expect(await res.text()).toBe('asset');
  });

  it('accepts only POST and bounded bodies', async () => {
    expect((await handleForm(new Request('https://site.example/xb-form'), env)).status).toBe(405);
    const big = post({ x: 'a'.repeat(40000), 'cf-turnstile-response': 't' });
    expect((await handleForm(big, env)).status).toBe(413);
  });

  it('requires a valid Turnstile token', async () => {
    mockFetch(false);
    expect((await handleForm(post({ nome: 'Ada' }), env)).status).toBe(403);
    expect((await handleForm(post({ nome: 'Ada', 'cf-turnstile-response': 'bad' }), env)).status).toBe(403);
  });

  it('rejects Turnstile tokens issued for another site', async () => {
    mockFetch(true, 'evil.example');
    expect((await handleForm(post({ nome: 'Ada', 'cf-turnstile-response': 'ok' }), env)).status).toBe(403);
  });

  it('caps a chunked body that declares no length', async () => {
    mockFetch(true);
    const chunk = new TextEncoder().encode('a'.repeat(16384));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request('https://site.example/xb-form', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // @ts-expect-error Node needs duplex for streamed request bodies
      duplex: 'half',
    });
    expect((await handleForm(req, env)).status).toBe(413);
    expect(sent).toBeLessThan(100);
  });

  it('forwards signed fields without the Turnstile token or xb_ controls', async () => {
    const calls = mockFetch(true);
    const res = await handleForm(post({ nome: 'Ada', 'cf-turnstile-response': 'ok', xb_form: 'contatti', 'bad name!': 'x' }), env);
    expect(res.status).toBe(200);
    const forward = calls.find((c) => c.url === env.XB_FORMS_ENDPOINT);
    const body = String(forward?.init.body);
    expect(JSON.parse(body).fields).toEqual({ nome: 'Ada' });
    const signature = (forward?.init.headers as Record<string, string>)['X-XB-Signature'];
    expect(signature).toBe(createHmac('sha256', env.XB_FORMS_SECRET).update(body).digest('hex'));
    expect(await hmac('k', 'm')).toBe(createHmac('sha256', 'k').update('m').digest('hex'));
  });

  it('never redirects outside the site', async () => {
    mockFetch(true);
    for (const target of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await handleForm(post({ 'cf-turnstile-response': 'ok', xb_redirect: target }), env);
      expect(res.status, target).toBe(200);
    }
    const ok = await handleForm(post({ 'cf-turnstile-response': 'ok', xb_redirect: '/grazie/' }), env);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('https://site.example/grazie/');
  });

  it('refuses to work half-configured', async () => {
    expect((await handleForm(post({ 'cf-turnstile-response': 'ok' }), { ...env, XB_FORMS_SECRET: '' })).status).toBe(503);
  });
});
