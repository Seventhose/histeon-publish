import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error -- plain JavaScript module, shipped with the plugin.
import { DOCS, GUIDES, IMPORT_METHODS, MANUAL, METHODS, NONCE_WINDOW_MS, controlMac, doc, formatBrief, guide, mcpTools, nonceGuard, pairProof, startBridge } from '../../plugin/connector/histos-connector.mjs';
// @ts-expect-error -- plain JavaScript module, the repository's own script.
import { syncConnector } from '../../scripts/sync-manual.mjs';
import { createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { SCOPES, connectorCommands, fileFromBase64, handlers, scopeOf } from '../src/lib/connector.svelte.ts';
import { bemBlocks } from '../src/lib/publicApi.ts';
import type { XbApi } from '../src/lib/publicApi.ts';

const SCRIPT = fileURLToPath(new URL('../../plugin/connector/histos-connector.mjs', import.meta.url));
const ORIGIN = 'http://localhost:8898';
const PAIR = randomBytes(32).toString('base64url');
/** What the builder tab sends to link: a fresh nonce, the time, and its proof of the pairing secret over both. */
const proofBody = (origin = ORIGIN, secret = PAIR, time = String(Date.now())) => {
  const nonce = randomBytes(18).toString('base64url');
  return { nonce, time, proof: pairProof(secret, 'tab', nonce, origin, time) as string };
};

type Bridge = { port: number; token: string; close: () => Promise<void> };
let dir: string;
let bridge: Bridge;
const url = (path: string) => `http://127.0.0.1:${bridge.port}${path}`;
/** The agent's signed request: HMAC of the token over nonce, time, method and path; the token itself never travels. */
const controlHeader = (path: string, method: string, nonce = randomBytes(16).toString('hex'), token = bridge.token, time = String(Date.now())) =>
  `${nonce}.${time}.${createHmac('sha256', token).update(`control|${nonce}|${time}|${method}|/control/${path}`).digest('hex')}`;
const control = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url(`/control/${path}`), { method: body ? 'POST' : 'GET', headers: { 'X-Histos-Control': controlHeader(path, body ? 'POST' : 'GET'), 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const helloRaw = (origin = ORIGIN, body: Record<string, unknown> = proofBody(origin)) => fetch(url('/tab/hello'), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Home', doc: 7, ...body }) });
const hello = async (origin = ORIGIN) => (await (await helloRaw(origin)).json()) as { tab: string; key: string; proof: string };

/** A fake builder tab: answers every operation with its name and arguments. */
async function serveTab(tab: { tab: string; key: string }, origin = ORIGIN) {
  const res = await fetch(url(`/tab/next?tab=${tab.tab}`), { headers: { Origin: origin, 'X-XB-Tab-Key': tab.key } });
  const message = (await res.json()) as { id: string; method: string; args: unknown };
  await fetch(url(`/tab/result?tab=${tab.tab}`), { method: 'POST', headers: { Origin: origin, 'X-XB-Tab-Key': tab.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: message.id, ok: message.method !== 'remove', result: message, error: 'nessun elemento x' }) });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'xbc-'));
  bridge = await startBridge({ port: 0, dir, origin: ORIGIN, pair: PAIR, log: () => undefined });
});
afterEach(async () => {
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Histeon Connector nonces', () => {
  it('forgets nonces only once their time can no longer pass, and is never emptied at once', () => {
    let now = 1_000_000;
    const guard = nonceGuard(3, () => now);
    expect(guard.accept('a', now)).toBe(true);
    expect(guard.accept('a', now), 'replay').toBe(false);
    expect(guard.accept('b', now - NONCE_WINDOW_MS - 1), 'outside the window').toBe(false);
    expect(guard.accept('b', now)).toBe(true);
    expect(guard.accept('c', now)).toBe(true);
    expect(guard.accept('d', now), 'full: refused, the others stay remembered').toBe(false);
    expect(guard.accept('a', now)).toBe(false);
    now += 2 * NONCE_WINDOW_MS + 1;
    expect(guard.accept('a', now - 10), 'old entries dropped; its old time would fail anyway').toBe(true);
    expect(guard.size).toBe(1);
  });

  it('narrows an existing state folder to the owner', async () => {
    const loose = join(dir, 'loose');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    const other = await startBridge({ port: 0, dir: loose, origin: ORIGIN, pair: PAIR, log: () => undefined });
    await other.close();
    expect(statSync(loose).mode & 0o777).toBe(0o700);
  });
});

describe('Histeon Connector bridge', () => {
  it('carries an operation from the agent to the tab and back', async () => {
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
    const tab = await hello();
    const pending = control('call', { method: 'insert', args: { html: '<p>Ciao</p>' } });
    await serveTab(tab);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { method: string; args: unknown } }).result).toMatchObject({ method: 'insert', args: { html: '<p>Ciao</p>' } });
    const tabs = (await (await control('tabs')).json()) as { tabs: Array<{ origin: string; title: string }> };
    expect(tabs.tabs).toEqual([expect.objectContaining({ origin: ORIGIN, title: 'Home', doc: 7 })]);
    // A builder error is a 422 with its message.
    const failing = control('call', { method: 'remove', args: { uid: 'x' } });
    await serveTab(tab);
    expect((await failing).status).toBe(422);
  });

  it('never lets a web page or a stranger drive the builder', async () => {
    await hello();
    expect((await fetch(url('/control/tabs'))).status).toBe(401);
    expect((await control('tabs', undefined, { 'X-Histos-Control': controlHeader('tabs', 'GET', undefined, 'sbagliato') })).status).toBe(401);
    expect((await control('tabs', undefined, { Authorization: `Bearer ${bridge.token}`, 'X-Histos-Control': '' })).status, 'the old bearer token is not enough').toBe(401);
    const nonce = randomBytes(16).toString('hex');
    const signed = controlHeader('tabs', 'GET', nonce);
    const first = await control('tabs', undefined, { 'X-Histos-Control': signed });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-histos-bridge-proof'), 'the bridge proves it holds the token').toBe(createHmac('sha256', bridge.token).update(`bridge|${nonce}`).digest('hex'));
    expect((await control('tabs', undefined, { 'X-Histos-Control': signed })).status, 'a replayed request').toBe(401);
    const old = String(Date.now() - NONCE_WINDOW_MS - 1000);
    expect((await control('tabs', undefined, { 'X-Histos-Control': controlHeader('tabs', 'GET', undefined, bridge.token, old) })).status, 'a request signed too long ago').toBe(401);
    expect(controlMac('t', 'n', '1', 'GET', '/control/tabs')).toBe(createHmac('sha256', 't').update('control|n|1|GET|/control/tabs').digest('hex'));
    expect((await control('tabs', undefined, { Origin: 'https://evil.example' })).status, 'a page, even with the token').toBe(403);
    expect((await control('tabs', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await control('call', { method: 'eval', args: { code: '1' } })).status, 'no code, only listed operations').toBe(400);
    expect((await control('call', { method: 'getHtml', args: { code: '1' } })).status).toBe(400);
  });

  it('answers only to the loopback host names (no DNS rebinding)', async () => {
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: bridge.port, path: '/tab/hello', method: 'OPTIONS', headers: { Host: host, Origin: ORIGIN } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await status('evil.example:' + bridge.port)).toBe(421);
    expect(await status('127.0.0.1.evil.example')).toBe(421);
    expect(await status('127.0.0.1:' + bridge.port)).toBe(204);
    expect(await status('localhost:' + bridge.port)).toBe(204);
  });

  it('keeps tabs apart: per-tab key and origin', async () => {
    const tab = await hello();
    expect((await fetch(url('/tab/hello'), { method: 'POST' })).status, 'not from a browser page').toBe(403);
    expect((await fetch(url(`/tab/next?tab=${tab.tab}`), { headers: { Origin: ORIGIN, 'X-XB-Tab-Key': 'x' } })).status).toBe(401);
    expect((await fetch(url(`/tab/next?tab=${tab.tab}`), { headers: { Origin: 'https://evil.example', 'X-XB-Tab-Key': tab.key } })).status).toBe(403);
    const pre = await fetch(url('/tab/hello'), { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' } });
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await hello();
    const res = await control('call', { method: 'getHtml' });
    expect(res.status, 'two tabs: the agent must choose').toBe(409);
  });

  it('links only the paired builder, and proves itself to it', async () => {
    const body = proofBody();
    const res = await helloRaw(ORIGIN, body);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tab: string; key: string; proof: string };
    expect(data.proof, 'the connector proves the pairing for this tab id and key').toBe(pairProof(PAIR, 'bridge', body.nonce, data.tab, data.key));
    expect((await helloRaw(ORIGIN, body)).status, 'a nonce works once').toBe(401);
    expect((await helloRaw(ORIGIN, proofBody(ORIGIN, PAIR, String(Date.now() - NONCE_WINDOW_MS - 1000)))).status, 'a hello signed too long ago').toBe(401);
    const unsigned = proofBody();
    expect((await helloRaw(ORIGIN, { nonce: unsigned.nonce, proof: pairProof(PAIR, 'tab', unsigned.nonce, ORIGIN) })).status, 'a proof without the time (older builder)').toBe(401);
    expect((await helloRaw(ORIGIN, proofBody(ORIGIN, randomBytes(32).toString('base64url')))).status, 'the wrong secret').toBe(401);
    expect((await helloRaw(ORIGIN, {})).status, 'no proof').toBe(401);
    // Another web page: refused, and without CORS or Private Network Access headers.
    const evil = await helloRaw('https://evil.example');
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(url('/tab/hello'), { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Private-Network': 'true' } });
    expect(pre.headers.get('access-control-allow-private-network')).toBeNull();
    await expect(startBridge({ port: 0, dir, log: () => undefined })).rejects.toThrow(/--origin/);
  });

  it('gives a waiting «Importa HTML» page only its two operations, and a builder tab never those', async () => {
    const builder = await hello();
    const page = (await (await helloRaw(ORIGIN, { ...proofBody(), kind: 'importa-html', title: 'Importa HTML: sito', doc: null })).json()) as { tab: string; key: string };
    // Two tabs, but one builder: its operations need no --tab.
    const html = control('call', { method: 'getHtml' });
    await serveTab(builder);
    expect((await html).status).toBe(200);
    const asked = control('call', { method: 'importChoices', args: {} });
    await serveTab(page);
    const res = await asked;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { method: string } }).result.method).toBe('importChoices');
    expect((await control('call', { method: 'importChoicesAnswer', args: { code: '1' } })).status, 'only requestId and scelte').toBe(400);
    expect((await control('call', { method: 'importChoices', args: {}, tab: builder.tab })).status, 'never to a builder tab').toBe(404);
    expect((await control('call', { method: 'getHtml', tab: page.tab })).status, 'never the builder to that page').toBe(404);
  });

  it('says 409 with waiting: false when no page waits for names', async () => {
    await hello();
    const res = await control('call', { method: 'importChoices', args: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ waiting: false, error: expect.stringContaining('Rifinisci i nomi') });
  });

  it('answers 409 when no tab is connected', async () => {
    const res = await control('call', { method: 'getHtml' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Collega/);
  });
});

describe('Histeon Connector programs', () => {
  it('pairs from the pasted command, secret on stdin, and starts MCP and serve without it (ConnectorPanel)', async () => {
    const secret = randomBytes(32).toString('base64url');
    const commands = connectorCommands(SCRIPT, { origin: 'https://sito.test', secret });
    expect(commands.mcp).toBe(`node ${SCRIPT} mcp`);
    expect(commands.serve).toBe(`node ${SCRIPT} serve`);
    expect(commands.mcp + commands.serve).not.toContain(secret);
    expect(commands.pair.indexOf(secret)).toBeLessThan(commands.pair.indexOf('|'));
    const code = await new Promise<number>((resolve) => execFile('sh', ['-c', `${commands.pair} --dir '${dir}'`], (e) => resolve(e ? Number(e.code) : 0)));
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'pairing.json'), 'utf8'))).toEqual({ origin: 'https://sito.test', pair: secret });
    expect(statSync(join(dir, 'pairing.json')).mode & 0o777).toBe(0o600);
    expect(connectorCommands(SCRIPT, null).pair).toBe('');
  });

  it('speaks MCP over stdio', async () => {
    const child = spawn(process.execPath, [SCRIPT, 'mcp', '--dir', dir, '--port', String(bridge.port)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buffer = '';
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
    });
    const ask = async (id: number, method: string, params: unknown = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let i = 0; i < 100; i++) {
        const hit = lines.map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> }).find((m) => m.id === id);
        if (hit) return hit.result;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`no answer to ${method}`);
    };
    const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.serverInfo).toMatchObject({ name: 'histos-connector' });
    expect(String(init.instructions)).toContain('BEM');
    const tools = (await ask(2, 'tools/list')).tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['xb_insert', 'xb_getBrief', 'xb_guide', 'xb_manual', 'xb_createComponent', 'xb_applyBem']));
    const manual = await ask(5, 'tools/call', { name: 'xb_manual', arguments: {} });
    expect((manual.content as Array<{ text: string }>)[0]!.text).toContain('Una classe per blocco');
    expect(String(init.instructions)).toContain('xb_manual');
    const stili = await ask(4, 'tools/call', { name: 'xb_guide', arguments: { topic: 'stili' } });
    expect((stili.content as Array<{ text: string }>)[0]!.text).toContain('&__title');
    // A topic that only an inherited property answers is unknown, with a text like any other.
    for (const [id, topic] of [[6, 'constructor'], [7, '__proto__']] as const) {
      const unknown = await ask(id, 'tools/call', { name: 'xb_guide', arguments: { topic } });
      expect((unknown.content as Array<{ text: unknown }>)[0]!.text, topic).toBe(`Argomento sconosciuto: ${topic}. Disponibili: ${Object.keys(GUIDES).join(', ')}`);
    }
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['xb_import_choices', 'xb_import_choices_answer']));
    expect(String(init.instructions)).toContain('xb_import_choices');
    const none = await ask(8, 'tools/call', { name: 'xb_import_choices', arguments: {} });
    expect(none.isError, 'no page waits: an answer, not an error').toBe(false);
    expect(JSON.parse((none.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ question: null, note: expect.stringContaining('Rifinisci i nomi') });
    const call = await ask(3, 'tools/call', { name: 'xb_getHtml', arguments: {} });
    expect(call.isError, 'no tab yet: a tool error, not a crash').toBe(true);
    child.kill();
  });

  it('CLI exit codes: 1 when nothing is connected', async () => {
    const code = await new Promise<number>((resolve) => execFile(process.execPath, [SCRIPT, 'html', '--dir', dir, '--port', String(bridge.port)], (e) => resolve(e ? Number(e.code) : 0)));
    expect(code).toBe(1);
  });

  it('CLI: a command or a guide that only an inherited property answers is unknown', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((resolve) =>
        execFile(process.execPath, [SCRIPT, ...args, '--dir', dir, '--port', String(bridge.port)], (e, out, err) => resolve({ code: e ? Number(e.code) : 0, out, err })),
      );
    for (const command of ['constructor', '__proto__', 'toString']) {
      const { code, err } = await run([command, 'getHtml']);
      expect(code, command).toBe(1);
      expect(err, command).toBe(`Comando sconosciuto: ${command}. Vedi histos-connector help.\n`);
    }
    for (const topic of ['constructor', '__proto__']) {
      const { code, out } = await run(['guide', topic]);
      expect(code, topic).toBe(0);
      expect(out, topic).toBe(`Argomento sconosciuto: ${topic}. Disponibili: ${Object.keys(GUIDES).join(', ')}\n`);
    }
  });

  it('next-task hands the agent the user\'s request from the tab, and waits for one', async () => {
    const tab = await hello();
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) =>
        execFile(process.execPath, [SCRIPT, ...args, '--dir', dir, '--port', String(bridge.port)], (e, out) => resolve({ code: e ? Number(e.code) : 0, out })),
      );
    // The tab answers nextTask with a request, as the builder's TaskBoard does.
    const answer = async (result: unknown) => {
      const res = await fetch(url(`/tab/next?tab=${tab.tab}`), { headers: { Origin: ORIGIN, 'X-XB-Tab-Key': tab.key } });
      const message = (await res.json()) as { id: string; method: string };
      expect(message.method).toBe('nextTask');
      await fetch(url(`/tab/result?tab=${tab.tab}`), { method: 'POST', headers: { Origin: ORIGIN, 'X-XB-Tab-Key': tab.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: message.id, ok: true, result }) });
    };
    const first = run(['next-task', '--wait', '10']);
    await answer(null); // nothing yet: the CLI asks again
    await answer({ id: 'r1', kind: 'section', request: 'Tre testimonianze', instructions: 'Usa i token --xb-*', status: 'working' });
    const { code, out } = await first;
    expect(code).toBe(0);
    expect(out).toContain('Richiesta r1 (section)');
    expect(out).toContain('Tre testimonianze');
    expect(out).toContain('done r1');
  }, 20_000);

  it('import-choices waits for a page «Importa HTML», and import-choices-answer hands it the answer', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((resolve) =>
        execFile(process.execPath, [SCRIPT, ...args, '--dir', dir, '--port', String(bridge.port)], (e, out, err) => resolve({ code: e ? Number(e.code) : 0, out, err })),
      );
    const question = { requestId: 'q1', site: 'sito', count: 1, system: 'Regole', choices: '<<<DATI\n[]\nDATI>>>', answer: 'Rispondi' };
    const first = run(['import-choices', '--wait', '10']);
    // No page yet: the command asks again every second, then the page links and answers with its question.
    await new Promise((r) => setTimeout(r, 1500));
    const page = (await (await helloRaw(ORIGIN, { ...proofBody(), kind: 'importa-html', doc: null })).json()) as { tab: string; key: string };
    const take = async (result: unknown) => {
      const res = await fetch(url(`/tab/next?tab=${page.tab}`), { headers: { Origin: ORIGIN, 'X-XB-Tab-Key': page.key } });
      const message = (await res.json()) as { id: string; method: string; args: Record<string, unknown> };
      await fetch(url(`/tab/result?tab=${page.tab}`), { method: 'POST', headers: { Origin: ORIGIN, 'X-XB-Tab-Key': page.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: message.id, ok: true, result }) });
      return message;
    };
    expect((await take(question)).method).toBe('importChoices');
    const read = await first;
    expect(read.code, read.err).toBe(0);
    expect(JSON.parse(read.out)).toEqual({ question });
    const answered = run(['import-choices-answer', 'q1', '{"scelte":[{"id":"classe:a","valore":"evento"}]}']);
    const message = await take({ received: 1 });
    expect(message).toMatchObject({ method: 'importChoicesAnswer', args: { requestId: 'q1', scelte: '{"scelte":[{"id":"classe:a","valore":"evento"}]}' } });
    expect(JSON.parse((await answered).out)).toEqual({ received: 1 });
  }, 20_000);

  it('lets the agent change only the areas the administrator turned on (voce 215)', async () => {
    let css = '';
    const api = { setCss: (_s: string, c: string) => void (css = c), lintCss: () => [], getCss: () => 'color: red', isDirty: () => false, getSelection: () => null } as unknown as XbApi;
    const on = new Set<string>(['testi']);
    const run = handlers(api, undefined, () => on);
    expect(() => run.setCss!({ selector: '.a', css: 'color: blue' })).toThrow(/CSS dei selettori/);
    expect(css).toBe('');
    expect(run.getCss!({ selector: '.a' })).toBe('color: red'); // reading is always allowed
    on.add('stile');
    run.setCss!({ selector: '.a', css: 'color: blue' });
    expect(css).toBe('color: blue');
    for (const methods of Object.values(SCOPES)) for (const m of methods) expect(Object.keys(METHODS), m).toContain(m);
    for (const m of ['getHtml', 'getBrief', 'listMedia', 'searchContent', 'save', 'undo']) expect(scopeOf(m), m).toBeNull();
  });

  it('turns an uploaded file from base64 into a File, by its extension', () => {
    const file = fileFromBase64('logo.png', btoa('\x89PNG'));
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(4);
    expect(() => fileFromBase64('script.js', 'AA==')).toThrow(/non ammesso/);
    expect(() => fileFromBase64('../x.png', 'AA==')).toThrow(/nome del file/);
  });

  it('offers the same operations on both sides', () => {
    const api = {} as XbApi;
    expect(Object.keys(handlers(api)).sort()).toEqual(Object.keys(METHODS).sort());
    // + xb_tabs, xb_manual, xb_docs, xb_guide, and the two of «Importa HTML» (IMPORT_METHODS), which no builder tab runs.
    expect(mcpTools().length).toBe(Object.keys(METHODS).length + 6);
    for (const method of Object.keys(IMPORT_METHODS)) expect(Object.keys(handlers(api)), method).not.toContain(method);
  });

  it('teaches the method and describes the site', () => {
    for (const topic of ['metodo', 'sintassi', 'stili', 'componenti', 'dati', 'accessibilita', 'flusso']) expect(GUIDES[topic]).toBeTruthy();
    expect(guide('metodo')).toMatch(/BEM/);
    expect(guide('metodo')).toMatch(/utility/);
    expect(guide('nope')).toMatch(/Disponibili/);
    const { blocks, other } = bemBlocks(['.card', '.card__title', '.card--dark', '.card__title--big', '.btn', 'h1', '.a .b']);
    expect(blocks).toEqual([
      { block: 'btn', parts: [] },
      { block: 'card', parts: ['--dark', '__title', '__title--big'] },
    ]);
    expect(other).toEqual(['h1', '.a .b']);
    const text = formatBrief({
      document: { id: 3, type: 'page', title: 'Home', ref: null, dirty: false, published: true },
      framework: { name: 'Core Framework', tokens: ['xb-space-m'], groups: { spacing: ['space-s', 'space-m'] }, classCount: 400 },
      namedQueries: { tablet: '(width < 64em)' },
      blocks,
      otherSelectors: [],
      components: [{ ref: 'xb/accordion', title: 'Accordion', props: ['title'] }],
    });
    expect(text).toContain('--space-m');
    expect(text).toContain('(--tablet) = (width < 64em)');
    expect(text).toContain('.card → .card--dark .card__title .card__title--big');
    expect(text).toContain('<Xb.Accordion> (xb/accordion) props: title');
    expect(text).toContain('400 classi utility');
    expect(text).toContain('## Media query con nome (per @media, non per i loop)');
  });

  it('brief: values of the variables, the loop queries and the other names loops can read', () => {
    const text = formatBrief({
      document: null,
      framework: { name: 'Core Framework', tokens: ['xb-space-m'], groups: { spacing: ['space-s', 'space-m'] }, more: { spacing: 12 }, values: { 'space-m': '1.5rem', 'xb-space-m': '1.5rem' }, classCount: 0 },
      mediaQueries: { tablet: '(width < 64em)' },
      data: {
        loopQueries: [{ name: 'prossimi', type: 'posts', params: ['luogo'] }],
        sources: [{ name: 'orari', kind: 'json' }, { name: 'meteo', kind: 'php', description: 'Previsioni' }],
        facets: [{ name: 'catalogo', query: 'libri', filters: ['genere'] }],
        types: [{ name: 'evento', label: 'Evento', fields: ['data_inizio'] }],
        publicFields: ['prezzo'],
        more: { loopQueries: 3 },
      },
      blocks: [],
      otherSelectors: [],
      components: [],
    });
    expect(text).toContain('--space-m (1.5rem)');
    expect(text).toContain('--xb-space-m (1.5rem)');
    expect(text).toContain('(e altre 12)');
    expect(text).toContain('- prossimi (posts) parametri: luogo');
    expect(text).toContain('- … e altre 3');
    expect(text).toContain('- data.orari (JSON)');
    expect(text).toContain('- data.meteo (PHP): Previsioni');
    expect(text).toContain('- facets.catalogo sulla query libri, filtri: genere');
    expect(text).toContain('- evento «Evento» campi: .fields.data_inizio');
    expect(text).toContain('Campi di altri plugin leggibili: .fields.prezzo');
  });

  it('carries the manual inside, identical to HISTOS-AI.md (node scripts/sync-manual.mjs)', () => {
    const md = readFileSync(fileURLToPath(new URL('../../plugin/connector/HISTOS-AI.md', import.meta.url)), 'utf8');
    expect(MANUAL).toBe(md);
    for (const must of ['BEM', 'set-css', 'utility', '--xb-', '(--tablet)', '{#loop', 'alt', 'render']) expect(MANUAL).toContain(must);
  });

  it('carries the documentation for agents inside, identical to the shared fixture of Histeon Publish (A7)', () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../plugin/tests/fixtures/histos-agent-docs-v1.json', import.meta.url)), 'utf8'));
    expect(fixture).toMatchObject({ format: 'histos-agent-docs', version: 1 });
    expect(DOCS).toEqual(fixture.topics);
    expect(DOCS[0].key).toBe('indice');
    for (const key of ['metodo', 'stile', 'errori-tipici', 'controllo', 'histos-css', 'acss']) expect(DOCS.map((item: { key: string }) => item.key)).toContain(key);
    // Nothing, or an unknown topic, gives the index; a topic gives its own text.
    expect(doc()).toBe(DOCS[0].text);
    expect(doc('segreti')).toContain(DOCS[0].text);
    expect(doc('stile')).toBe(DOCS.find((item: { key: string }) => item.key === 'stile').text);
    const tool = mcpTools().find((item: { name: string }) => item.name === 'xb_docs');
    expect(tool.inputSchema.properties.topic.enum).toEqual(DOCS.map((item: { key: string }) => item.key));
  });

  it('embeds manual and docs so that no text can end its block or turn into code (scripts/sync-manual.mjs)', async () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../plugin/tests/fixtures/histos-agent-docs-v1.json', import.meta.url)), 'utf8'));
    // A marker followed by U+2028 or U+2029, which end a `//` comment: the old script stopped at the marker inside the
    // literal on the next sync, left the old tail after the new block, and the statement ran on import.
    const [lineSeparator, paragraphSeparator] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const md = `${MANUAL}\nMarcatore: // MANUAL:end${lineSeparator}globalThis.XB_SYNC_MANUAL = 1;//\n`;
    const docs = { ...fixture, topics: fixture.topics.map((topic: { text: string }, i: number) => (i === 1 ? { ...topic, text: `${topic.text}Marcatore: // DOCS:end${paragraphSeparator}globalThis.XB_SYNC_DOCS = 1;//\n` } : topic)) };
    const edited = `${md}Una riga in più.\n`;
    const synced = syncConnector(syncConnector(source, md, docs), edited, docs);
    for (const marker of ['// MANUAL:start', '// MANUAL:end', '// DOCS:start', '// DOCS:end']) expect(synced.split(marker).length - 1, marker).toBe(1);
    expect(synced.includes(lineSeparator) || synced.includes(paragraphSeparator)).toBe(false);
    const scratch = mkdtempSync(join(tmpdir(), 'xbsync-'));
    try {
      writeFileSync(join(scratch, 'histos-connector.mjs'), synced);
      const loaded = await import(pathToFileURL(join(scratch, 'histos-connector.mjs')).href);
      const global = globalThis as Record<string, unknown>;
      expect([global.XB_SYNC_MANUAL, global.XB_SYNC_DOCS]).toEqual([undefined, undefined]);
      expect(loaded.MANUAL).toBe(edited);
      expect(loaded.DOCS).toEqual(docs.topics);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    // A file an older sync left with a marker inside a literal is refused, not patched.
    expect(() => syncConnector(synced.replace('export const DOCS = ', 'export const DOCS = "// DOCS:end" && '), md, docs)).toThrow(/una sola coppia di marcatori \/\/ DOCS:start … \/\/ DOCS:end/);
    // The repository's own copy is what the script makes, as it is.
    expect(syncConnector(source, readFileSync(fileURLToPath(new URL('../../plugin/connector/HISTOS-AI.md', import.meta.url)), 'utf8'), fixture)).toBe(source);
  });
});
