import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain JavaScript module, shipped with the plugin.
import { classesIn, createSync, docFolder, fileSelector, selectorFile, unwrapCss, wrapCss } from '../../plugin/connector/histos-connector.mjs';

/** A builder in memory, reached like through the connector. */
function fakeBuilder() {
  const b = {
    doc: { id: 7, type: 'page', title: 'Chi siamo' },
    html: '<section class="hero"><h1 class="hero__title">Ciao</h1></section>',
    css: new Map<string, string>([['.hero', 'padding: var(--space-m);\n&__title { color: red; }\n'], ['.altro', 'color: blue;\n']]),
    calls: [] as string[],
  };
  const call = async (method: string, args: Record<string, string>) => {
    b.calls.push(method);
    switch (method) {
      case 'getDocument':
        return b.doc;
      case 'getHtml':
        return b.html;
      case 'setHtml':
        if (args.html!.includes('<p>')) throw new Error('riga 1: elemento non chiuso');
        b.html = args.html!.trim();
        return null;
      case 'listStyles':
        return [...b.css.keys()];
      case 'getCss':
        return b.css.get(args.selector!) ?? '';
      case 'setCss':
        b.css.set(args.selector!, args.css!);
        return null;
    }
    throw new Error(`metodo ${method}`);
  };
  return { b, call };
}

let root: string;
beforeEach(() => (root = mkdtempSync(join(tmpdir(), 'xbsync-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('connector sync: names', () => {
  it('maps selectors and files both ways, and nothing else', () => {
    expect(selectorFile('.card')).toBe('card.css');
    expect(selectorFile('#hero')).toBe('id-hero.css');
    expect(selectorFile('.a .b')).toBeNull();
    expect(selectorFile('.x/../y')).toBeNull();
    expect(fileSelector('card.css')).toBe('.card');
    expect(fileSelector('id-hero.css')).toBe('#hero');
    expect(fileSelector('../x.css')).toBeNull();
    expect(fileSelector('page.html')).toBeNull();
    expect(docFolder({ id: 3, type: 'wp_block', title: 'Scheda Evento è' })).toBe('componente-3-scheda-evento-e');
    expect([...classesIn('<div class="a b" id="top"><p class="{x}"></p></div>')]).toEqual(['a', 'b', '#top']);
  });

  it('wraps a body as one rule and reads it back', () => {
    const text = wrapCss('.card', 'gap: 1rem;\n&__t { color: red; }\n');
    expect(text).toBe('.card {\n  gap: 1rem;\n  &__t { color: red; }\n}\n');
    expect(unwrapCss('.card', text)).toBe('gap: 1rem;\n&__t { color: red; }');
    expect(unwrapCss('.card', '.altro { x: 1 }')).toBeNull();
    expect(unwrapCss('.card', '.card { a: 1 }\n.b { c: 2 }')).toBe('a: 1 }\n.b { c: 2');
  });
});

describe('connector sync: both ways', () => {
  it('writes the open document, sends saved files, brings builder changes back', async () => {
    const { b, call } = fakeBuilder();
    const logs: string[] = [];
    const sync = createSync({ root, call, log: (m: string) => logs.push(m) });
    await sync.tick();
    const dir = join(root, 'page-7-chi-siamo');
    expect(readFileSync(join(dir, 'page.html'), 'utf8')).toBe(b.html);
    expect(readFileSync(join(dir, 'hero.css'), 'utf8')).toContain('.hero {\n  padding: var(--space-m);');
    expect(existsSync(join(dir, 'altro.css')), 'only selectors the page uses').toBe(false);

    // A file saved in the editor goes to the builder.
    writeFileSync(join(dir, 'hero.css'), '.hero {\n  padding: 0;\n}\n');
    await sync.fileChanged(join(dir, 'hero.css'));
    expect(b.css.get('.hero')).toBe('padding: 0;\n');
    writeFileSync(join(dir, 'page.html'), '<section class="hero nuova"></section>');
    await sync.fileChanged(join(dir, 'page.html'));
    expect(b.html).toBe('<section class="hero nuova"></section>');
    // A new file creates the style.
    writeFileSync(join(dir, 'nuova.css'), '.nuova {\n  color: green;\n}\n');
    await sync.fileChanged(join(dir, 'nuova.css'));
    expect(b.css.get('.nuova')).toBe('color: green;\n');

    // The builder's change comes back to the file.
    b.html = '<section class="hero nuova"><p>da builder</p></section>';
    await sync.tick();
    expect(readFileSync(join(dir, 'page.html'), 'utf8')).toContain('da builder');

    // A builder error is reported, the file is kept, and it is not sent again until it changes.
    writeFileSync(join(dir, 'page.html'), '<div><p>rotto</div>');
    await sync.fileChanged(join(dir, 'page.html'));
    expect(logs.at(-1)).toContain('elemento non chiuso');
    expect(b.html).toContain('da builder');
  });

  it('never loses work when both sides changed', async () => {
    const { b, call } = fakeBuilder();
    const sync = createSync({ root, call });
    await sync.tick();
    const page = join(root, 'page-7-chi-siamo', 'page.html');
    writeFileSync(page, '<section class="hero">mia versione</section>');
    b.html = '<section class="hero">versione del builder</section>';
    await sync.tick();
    expect(readFileSync(page, 'utf8')).toContain('mia versione');
    expect(readFileSync(`${page}.builder`, 'utf8')).toContain('versione del builder');
  });

  it('follows the document open in the builder, and refuses links and stray paths', async () => {
    const { b, call } = fakeBuilder();
    const logs: string[] = [];
    const sync = createSync({ root, call, log: (m: string) => logs.push(m) });
    await sync.tick();
    b.doc = { id: 9, type: 'wp_block', title: 'Card' };
    await sync.tick();
    expect(existsSync(join(root, 'componente-9-card', 'page.html'))).toBe(true);
    // A file of the other document is not applied to this one.
    writeFileSync(join(root, 'page-7-chi-siamo', 'page.html'), '<section></section>');
    await sync.fileChanged(join(root, 'page-7-chi-siamo', 'page.html'));
    expect(logs.at(-1)).toContain('non è il documento aperto');
    // A symbolic link is never followed, outside paths are ignored.
    const outside = join(root, '..', `fuori-${Date.now()}.css`);
    writeFileSync(outside, '.hero { color: x; }');
    rmSync(join(root, 'componente-9-card', 'hero.css'));
    symlinkSync(outside, join(root, 'componente-9-card', 'hero.css'));
    await sync.fileChanged(join(root, 'componente-9-card', 'hero.css'));
    expect(b.css.get('.hero')).toBe('padding: var(--space-m);\n&__title { color: red; }\n');
    // Nor written through: the builder's change is reported, the outside file stays as it was.
    b.css.set('.hero', 'color: green;\n');
    await sync.tick();
    expect(readFileSync(outside, 'utf8')).toBe('.hero { color: x; }');
    expect(logs.some((m) => m.includes('Collegamento simbolico'))).toBe(true);
    await sync.fileChanged(join(root, '..', 'x.css'));
    rmSync(outside);
  });
});
