import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, serializeXb } from '@xb/dsl';
// @ts-expect-error -- a plain ES module of the repository's scripts, without types.
import { declarations, parseBlocks, score } from '../../scripts/bench/checks.mjs';

// The small-model bench (I8): its checks read the document as the builder saves it.
type Task = { id: string; criteria: unknown[] };
const tasks = (JSON.parse(readFileSync(new URL('../../scripts/bench/tasks.json', import.meta.url), 'utf8')) as { tasks: Task[] }).tasks;
const task = (id: string) => tasks.find((t) => t.id === id)!;
const saved = (dsl: string) => serializeXb(parse(dsl).blocks);
const styles = (css: Record<string, string>) => ({ styles: Object.entries(css).map(([selector, body]) => ({ selector, css: body })), globals: [] });
const all = (r: { passed: number; total: number }) => r.passed === r.total;

describe('small-model bench (I8)', () => {
  it('reads the blocks as the builder saves them', () => {
    const blocks = parseBlocks(saved('<section><h1>Ciao</h1><p>Testo</p></section>'));
    expect(blocks[0].name).toBe('xb/element');
    expect(blocks[0].attrs.tag).toBe('section');
    expect(blocks[0].children.map((b: { attrs: { tag: string } }) => b.attrs.tag)).toEqual(['h1', 'p']);
    expect(declarations({ styles: [], globals: [{ css: '.a{padding:1rem; Border: 1PX solid}' }] }, '.a')).toEqual({ padding: '1rem', border: '1px solid' });
  });

  it('passes a good answer to every task and fails a poor one', () => {
    const good: Record<string, [string, Record<string, string>]> = {
      hero: ['<section class="intro"><h1>Benvenuti in libreria</h1><p>Libri per tutti.</p><a href="/catalogo/" class="btn">Scopri il catalogo</a></section>', {}],
      stile: ['<div class="bench-card"><h3>Novità</h3><p>Testo</p></div>', { '.bench-card': 'padding: var(--xb-space-m); border: 1px solid; border-radius: var(--xb-radius-m)' }],
      loop: ['{#loop posts(limit: 3) as post}<article><a href="{post.url}">{post.title}</a> <time>{post.date}</time></article>{/loop}', {}],
      componente: ['<Bench.Scheda titolo="Uno" testo="A" /><Bench.Scheda titolo="Due" testo="B" />', {}],
      vuoto: ['{#loop posts(type: "evento") as e}<p>{e.title}</p>{:else}<p>Nessun evento in programma</p>{/loop}', {}],
    };
    for (const t of tasks) {
      const [dsl, css] = good[t.id]!;
      const result = score(t, saved(dsl), styles(css));
      expect(all(result), `${t.id}: ${JSON.stringify(result.results.filter((r: { ok: boolean }) => !r.ok))}`).toBe(true);
    }
    // Poor answers: the style in the attribute, a list written by hand, no else branch, raw HTML.
    expect(all(score(task('stile'), saved('<div class="bench-card" style="padding: var(--xb-space-m)"><h3>Novità</h3></div>'), styles({})))).toBe(false);
    expect(all(score(task('loop'), saved('<ul><li><a href="/a/">Primo</a></li></ul>'), styles({})))).toBe(false);
    expect(all(score(task('vuoto'), saved('{#loop posts() as e}<p>{e.title}</p>{/loop}<p>Nessun evento in programma</p>'), styles({})))).toBe(false);
    expect(score(task('hero'), saved('{#raw}<section><h1>Benvenuti in libreria</h1></section>{/raw}'), styles({})).passed).toBeLessThan(3);
  });
});
