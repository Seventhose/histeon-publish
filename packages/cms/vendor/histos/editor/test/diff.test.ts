import { describe, expect, it } from 'vitest';
import { documentText, lineDiff, summary } from '../src/lib/diff.ts';

describe('release diff', () => {
  it('finds added, removed and unchanged lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc', 5);
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
    expect(summary(d)).toEqual({ added: 1, removed: 1 });
  });

  it('collapses long unchanged runs around the changes', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l15', 'X');
    const d = lineDiff(before, after, 2);
    expect(d[0]).toEqual({ kind: 'skip', count: 13 });
    expect(d.filter((l) => l.kind === 'same')).toHaveLength(4);
    expect(d[d.length - 1]).toEqual({ kind: 'skip', count: 12 });
  });

  it('handles new and deleted documents', () => {
    expect(summary(lineDiff('', 'a\nb'))).toEqual({ added: 2, removed: 0 });
    expect(summary(lineDiff('a', ''))).toEqual({ added: 0, removed: 1 });
  });

  it('shows pages as XB code, styles as CSS, settings as sorted JSON', () => {
    const page = documentText('post:1', { content: '<!-- wp:xb/element {"uid":"aaaaaaaa","tag":"p"} --><!-- wp:xb/text {"uid":"aaaaaaab","content":"Ciao"} /--><!-- /wp:xb/element -->', script: 'go()' });
    expect(page).toBe('<p>Ciao</p>\n\n/* JavaScript */\ngo()');
    expect(documentText('styles', { styles: [{ selector: '.b', css: 'x:1' }, { selector: '.a', css: 'y:2' }], globals: [] })).toBe('.a {\ny:2\n}\n\n.b {\nx:1\n}');
    expect(documentText('settings', { reset: true, framework: 'acss' })).toBe('{\n  "framework": "acss",\n  "reset": true\n}');
  });
});
