import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExpression } from '../src/index.ts';

interface ParseVector {
  source: string;
  preset?: boolean;
  ok?: boolean;
  error?: string;
}

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../spec/vectors/expressions.json'), 'utf8'),
) as { parse: ParseVector[] };

describe('shared expression vectors (parse)', () => {
  it.each(vectors.parse.map((v) => [v.source, v] as const))('%s', (_source, v) => {
    const run = () => parseExpression(v.source, 0, v.source.length, { allowPresetCall: v.preset === true });
    if (v.ok) expect(run).not.toThrow();
    else expect(run).toThrow(v.error);
  });
});
