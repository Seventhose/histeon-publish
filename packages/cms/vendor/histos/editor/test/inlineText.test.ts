import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, type XbBlock } from '@xb/dsl';
import { draftCode, inlineContent, inlineRefusal, inlineTarget } from '../src/lib/inlineText.ts';

const first = (dsl: string): XbBlock => parse(dsl, { uid: sequentialUids('n') }).blocks[0]!;

describe('text written in the canvas', () => {
  it('takes over static text with inline formatting only', () => {
    expect(inlineTarget(first('<h1>Ciao <strong>mondo</strong></h1>'))).not.toBeNull();
    expect(inlineTarget(first('<p>Prezzo \\{fisso\\}</p>')), 'escaped braces are text').not.toBeNull();
    expect(inlineTarget(first('<h2>{item.title}</h2>'))).toBeNull();
    expect(inlineRefusal(first('<h2>Ciao {item.title}</h2>'))).toContain('Testo dinamico');
    expect(inlineTarget(first('<div><p>a</p></div>')), 'a box, not a text').toBeNull();
    expect(inlineTarget(first('<div></div>'))).toBeNull();
    expect(inlineTarget(first('<style>a{}</style>'))).toBeNull();
  });

  it('reads back only what the DSL can represent', () => {
    expect(inlineContent('h1', 'Ciao <strong>mondo</strong>')).toBe('Ciao <strong>mondo</strong>');
    expect(inlineContent('p', 'Riga<br>due')).toBe('Riga<br>due');
    expect(inlineContent('p', '<a href="/x">link</a> ok')).toBe('<a href="/x">link</a> ok');
    expect(inlineContent('p', '')).toBe('');
    expect(inlineContent('p', 'graffe \\{qui\\}')).toBe('graffe \\{qui\\}');
    expect(inlineContent('p', '<div>blocco</div>'), 'a block inside is refused').toBeNull();
    expect(inlineContent('p', '<a href="/x" onclick="x()">l</a>'), 'unknown attributes are refused').toBeNull();
    expect(inlineContent('p', 'testo {item.title}'), 'typed text is never an expression').toBeNull();
    expect(inlineContent('p', '</p><script>alert(1)</script><p>')).toBeNull();
    expect(inlineContent('p onclick="x"', 'a')).toBeNull();
  });
});

describe('text the canvas cannot take', () => {
  it('becomes the code of its element, as typed, for the HTML panel', () => {
    const [block] = parse('<p class="lead" id="x">old</p>', { uid: sequentialUids() }).blocks;
    const target = inlineTarget(block ?? null);
    expect(target).not.toBeNull();
    const code = draftCode(target!, 'new <div>block</div> $& text');
    expect(code).toContain('new <div>block</div> $& text');
    expect(code).toMatch(/^<p class="lead" id="x">/);
    expect(code).not.toContain('old');
  });
});

describe('links typed or pasted in the canvas', () => {
  it('keep only addresses that cannot run code', async () => {
    const { safeHref } = await import('../src/lib/inlineText.ts');
    for (const ok of ['/chi-siamo/', '#sezione', '?q=1', 'https://example.com', 'HTTP://example.com', 'mailto:a@example.com', 'tel:+39000', 'pagina.html']) expect(safeHref(ok), ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' \u0001javascript:x', 'JAVASCRIPT:x', 'vbscript:x', 'data:text/html,<p>', 'file:///etc/passwd']) expect(safeHref(bad), JSON.stringify(bad)).toBe(false);
  });
});
