import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JavaScript module, shipped with the plugin.
import { secured } from '../../plugin/assets/worker/worker.js';

describe('static site Worker', () => {
  it('adds the security headers WordPress chose to its own responses, and nothing else', () => {
    const env = { XB_SECURITY_HEADERS: JSON.stringify({ 'X-Frame-Options': 'SAMEORIGIN', 'Set-Cookie': 'x=1', 'Referrer-Policy': 'no-referrer\r\nX-Evil: 1' }) };
    const out = secured(new Response('ok', { status: 303, headers: { Location: '/grazie/' } }), env) as Response;
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/grazie/');
    expect(out.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(out.headers.get('set-cookie')).toBeNull();
    expect(out.headers.get('referrer-policy')).toBeNull();
  });

  it('answers as before when the headers are missing or broken', () => {
    expect((secured(new Response('ok'), { XB_SECURITY_HEADERS: '{' }) as Response).headers.get('x-frame-options')).toBeNull();
    expect((secured(new Response('ok'), {}) as Response).status).toBe(200);
  });
});
