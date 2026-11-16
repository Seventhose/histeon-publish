// The document as one file (docs/spec/single-file.md): its HTML, the CSS of the selectors it uses, its script
// and, for a component, its props — in the shape of a Vue/Svelte file:
//   <template> … </template>  <style> .card { … } </style>  <script> … </script>  <script type="application/json" data-props> … </script>
// Pure, tested in test/sfc.test.ts.
import { t } from './i18n.ts';

export interface SfcParts {
  html: string;
  /** Own CSS by selector, in order. */
  styles: Array<[string, string]>;
  script: string;
  /** Component props schema (JSON), or null for a page. */
  props: unknown;
}

const indent = (text: string, pad = '  ') =>
  text
    .split('\n')
    .map((l) => (l.trim() ? pad + l : ''))
    .join('\n');
const dedent = (text: string) => {
  const lines = text.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
  const pads = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const cut = pads.length ? Math.min(...pads) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^ */.exec(l)?.[0].length ?? 0))).join('\n');
};

export function toSfc(parts: SfcParts): string {
  const out = [`<template>\n${indent(parts.html.trim())}\n</template>`];
  if (parts.styles.length) out.push(`<style>\n${parts.styles.map(([sel, css]) => `${sel} {\n${indent(css.trim())}${css.trim() ? '\n' : ''}}`).join('\n\n')}\n</style>`);
  // A `</script>` inside the code would end the section: written as `<\/script>`, read back as it was.
  if (parts.script.trim()) out.push(`<script>\n${parts.script.replace(/\s+$/, '').replace(/<\/(script)/gi, '<\\/$1')}\n</script>`);
  if (parts.props !== null && parts.props !== undefined) out.push(`<script type="application/json" data-props>\n${JSON.stringify(parts.props, null, 2)}\n</script>`);
  return `${out.join('\n\n')}\n`;
}

export class SfcError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Top-level rules of a stylesheet, `selector { body }`; at-rules and stray text are refused. */
export function splitRules(css: string, base = 0): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < css.length) {
    const rest = css.slice(i);
    const skip = /^(\s+|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (skip) {
      i += skip[0].length;
      continue;
    }
    const open = css.indexOf('{', i);
    if (open < 0) throw new SfcError(t('Testo fuori da una regola nello <style>'), base + i);
    const selector = css.slice(i, open).trim();
    if (!selector || selector.startsWith('@')) throw new SfcError(t('Nello <style> vanno solo regole "selettore { … }": le @media stanno dentro la regola'), base + i);
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      const c = css.charAt(j);
      if (c === '"' || c === "'") {
        const end = css.indexOf(c, j + 1);
        j = end < 0 ? css.length : end;
      } else if (c === '/' && css.charAt(j + 1) === '*') {
        const end = css.indexOf('*/', j + 2);
        j = end < 0 ? css.length : end + 1;
      } else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    if (depth !== 0) throw new SfcError(t('Graffe non bilanciate nella regola {0}', selector), base + open);
    out.push([selector, dedent(css.slice(open + 1, j)).trim()]);
    i = j + 1;
  }
  return out;
}

/** The parts of a single file; errors say where. */
export function fromSfc(source: string): SfcParts {
  let text = source;
  const section = (re: RegExp) => {
    const all = [...text.matchAll(re)];
    if (all.length > 1) throw new SfcError(t('Sezione ripetuta'), all[1]?.index ?? 0);
    return all[0] ?? null;
  };
  // The page may hold <template> elements itself: the section ends at the last </template>.
  const start = text.indexOf('<template>');
  const end = text.lastIndexOf('</template>');
  if (start < 0 || end < start) throw new SfcError(t('Manca <template>…</template>'), 0);
  const template = [text.slice(start, end + '</template>'.length), text.slice(start + '<template>'.length, end)] as const;
  text = text.slice(0, start) + text.slice(end + '</template>'.length);
  const style = section(/<style>([\s\S]*?)<\/style>/g);
  const script = section(/<script>([\s\S]*?)<\/script>/g);
  const props = section(/<script type="application\/json" data-props>([\s\S]*?)<\/script>/g);
  // Nothing else at the top level: an unknown section is a mistake, not something to drop silently.
  const leftover = text
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script type="application\/json" data-props>[\s\S]*?<\/script>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (leftover) throw new SfcError(t('Testo fuori dalle sezioni: «{0}»', leftover.slice(0, 40)), source.indexOf(leftover.slice(0, 20)));
  let parsedProps: unknown = null;
  if (props) {
    try {
      parsedProps = JSON.parse(props[1] as string);
    } catch (e) {
      throw new SfcError(t('Props: JSON non valido ({0})', e instanceof Error ? e.message : String(e)), source.indexOf('data-props'));
    }
    if (parsedProps === null || typeof parsedProps !== 'object' || Array.isArray(parsedProps)) throw new SfcError(t('Props: serve un oggetto JSON'), source.indexOf('data-props'));
  }
  const styleBody = style ? (style[1] as string) : '';
  const styleAt = style ? source.indexOf('<style>') + '<style>'.length : 0;
  return {
    html: dedent(template[1] as string),
    styles: splitRules(styleBody, styleAt),
    script: script ? dedent(script[1] as string).replace(/<\\\/(script)/gi, '</$1') : '',
    props: parsedProps,
  };
}
