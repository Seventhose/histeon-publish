import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCss, keyClass, resolveNamedQueries } from '../src/index.ts';

const vectors = JSON.parse(readFileSync(join(import.meta.dirname, '../../spec/vectors/css.json'), 'utf8')) as {
  compile: Array<{ selector: string; body: string; css: string }>;
  keyClass: Array<{ selector: string; key: string | null }>;
  namedQueries: { queries: Record<string, string>; cases: Array<{ css: string; out: string }> };
};

describe('shared css vectors', () => {
  it.each(vectors.compile.map((v) => [v.selector + ' { ' + v.body + ' }', v] as const))('%s', (_n, v) => {
    expect(compileCss(v.selector, v.body)).toBe(v.css);
  });
  it.each(vectors.keyClass.map((v) => [v.selector, v] as const))('key class of %s', (_n, v) => {
    expect(keyClass(v.selector)).toBe(v.key);
  });
  it.each(vectors.namedQueries.cases.map((v) => [v.css, v] as const))('named queries in %s', (_n, v) => {
    expect(resolveNamedQueries(v.css, vectors.namedQueries.queries)).toBe(v.out);
  });
});
