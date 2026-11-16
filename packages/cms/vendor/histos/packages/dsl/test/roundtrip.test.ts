import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseXb, print, sequentialUids, serializeXb, stripUids } from '../src/index.ts';

const dir = join(import.meta.dirname, 'fixtures');
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.xb'));

describe.each(fixtures)('round-trip %s', (file) => {
  const source = readFileSync(join(dir, file), 'utf8');
  const { blocks } = parse(source, { uid: sequentialUids('a') });

  it('DSL → tree → DSL is stable (modulo uid)', () => {
    const printed = print(blocks);
    const reparsed = parse(printed, { uid: sequentialUids('b') }).blocks;
    expect(stripUids(reparsed)).toEqual(stripUids(blocks));
    expect(print(reparsed)).toBe(printed);
  });

  it('tree → block grammar → tree is lossless (uid included)', () => {
    const serialized = serializeXb(blocks);
    const { blocks: back, issues } = parseXb(serialized, sequentialUids('c'));
    expect(issues).toEqual([]);
    expect(back).toEqual(blocks);
    expect(serializeXb(back)).toBe(serialized);
  });

  it('canonical print snapshot', () => {
    expect(print(blocks)).toMatchSnapshot();
  });
});
