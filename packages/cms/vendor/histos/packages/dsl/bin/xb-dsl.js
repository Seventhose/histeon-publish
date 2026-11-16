#!/usr/bin/env node
// XB DSL command line: converts between the DSL (HTML panel text) and Gutenberg block grammar.
// Requires `npm run build -w packages/dsl` first.
import { readFileSync } from 'node:fs';
import { parse, parseXb, print, sequentialUids, serializeXb, XbSyntaxError } from '../dist/index.js';

// --seed <prefix>: deterministic uids (theme templates, fixtures) instead of random ones.
const argv = process.argv.slice(2);
const seedAt = argv.indexOf('--seed');
const seed = seedAt >= 0 ? argv.splice(seedAt, 2)[1] : undefined;
const uid = seed ? sequentialUids(seed) : undefined;
const [command, file = '-'] = argv;
const input = readFileSync(file === '-' ? 0 : file, 'utf8');

try {
  switch (command) {
    case 'to-blocks': {
      const { blocks, warnings } = parse(input, uid ? { uid } : {});
      for (const w of warnings) process.stderr.write(`avviso: ${w.message}\n`);
      process.stdout.write(serializeXb(blocks) + '\n');
      break;
    }
    case 'to-dsl': {
      const { blocks, issues } = parseXb(input);
      for (const issue of issues) process.stderr.write(`riparato: ${issue}\n`);
      process.stdout.write(print(blocks) + '\n');
      break;
    }
    case 'check': {
      const { warnings } = parse(input);
      for (const w of warnings) process.stderr.write(`avviso: ${w.message}\n`);
      process.stdout.write('ok\n');
      break;
    }
    default:
      process.stderr.write('Uso: xb-dsl <to-blocks|to-dsl|check> [--seed prefisso] [file|-]\n');
      process.exit(2);
  }
} catch (e) {
  if (e instanceof XbSyntaxError) {
    process.stderr.write(`${file}:${e.line}:${e.column}: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
