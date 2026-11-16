import { describe, expect, it } from 'vitest';
import { TaskBoard, sectionInstructions, translateInstructions, type TaskContext } from '../src/lib/aiTasks.svelte.ts';
import { handlers } from '../src/lib/connector.svelte.ts';
import type { XbApi } from '../src/lib/publicApi.ts';

const ctx: TaskContext = { doc: 12, title: 'Chi siamo', framework: { id: 'xb-tokens', label: 'Histeon CSS' }, selection: { uid: 'abc12345', label: 'Hero' } };

describe("Chiedi all'agente", () => {
  it('a section goes after the selection, with Histeon CSS tokens and BEM classes only', () => {
    const text = sectionInstructions(ctx);
    expect(text).toContain('select abc12345');
    expect(text).toContain('token --xb-*');
    expect(text).toContain('Niente classi utility');
    expect(text).toContain('Non salvare e non pubblicare');
    const other = sectionInstructions({ ...ctx, framework: { id: 'core-framework', label: 'Core Framework' }, selection: null });
    expect(other).toContain('in fondo alla pagina');
    expect(other).toContain('Core Framework');
    expect(other).not.toContain('--xb-*');
  });

  it('a translation leaves Lingua Bridge drafts, never published', () => {
    const text = translateInstructions(ctx, [{ code: 'en', label: 'English' }]);
    expect(text).toContain('English (en)');
    expect(text).toContain('save-draft');
    expect(text).toContain('non pubblicare');
  });

  it('the agent takes requests in order and closes them with a note', () => {
    const board = new TaskBoard();
    const run = handlers({} as XbApi, board);
    expect(run.nextTask!({})).toBeNull();
    board.add('section', '  Tre testimonianze  ', sectionInstructions(ctx));
    board.add('translate', 'English', translateInstructions(ctx, [{ code: 'en', label: 'English' }]));
    const first = run.nextTask!({}) as { id: string; kind: string; request: string };
    expect(first).toMatchObject({ kind: 'section', request: 'Tre testimonianze', status: 'working' });
    expect((run.getTasks!({}) as unknown[]).length).toBe(2);
    expect(run.finishTask!({ id: first.id, note: 'Fatta, con la classe .testimonials' })).toEqual({ ok: true });
    expect(board.items[0]).toMatchObject({ status: 'done', note: 'Fatta, con la classe .testimonials' });
    expect(() => run.finishTask!({ id: first.id, note: '' })).toThrow('già chiusa');
    expect(() => run.finishTask!({ id: 'r99' })).toThrow('inesistente');
    expect((run.nextTask!({}) as { kind: string }).kind).toBe('translate');
    expect(run.nextTask!({})).toBeNull();
  });

  it('refuses empty, overlong and too many requests', () => {
    const board = new TaskBoard();
    expect(() => board.add('section', '   ', '')).toThrow('Scrivi');
    expect(() => board.add('section', 'x'.repeat(2001), '')).toThrow('troppo lunga');
    for (let i = 0; i < 20; i++) board.add('section', `richiesta ${i}`, '');
    expect(() => board.add('section', 'una di troppo', '')).toThrow('Troppe');
    board.remove('r1');
    expect(board.items).toHaveLength(19);
  });
});
