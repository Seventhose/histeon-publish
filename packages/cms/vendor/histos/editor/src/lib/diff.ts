/** Differences between the online and the dev version of a document (publish dialog). Pure, tested. */
import { parseXb, print } from '@xb/dsl';
import { t } from './i18n.ts';

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'skip'; count: number };

/** Above this many cells the LCS table is too big for the browser: show everything as replaced. */
const MAX_CELLS = 4_000_000;

/** Line diff (longest common subsequence), with unchanged runs collapsed to `context` lines around changes. */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let full: DiffLine[];
  if (a.length * b.length > MAX_CELLS) {
    full = [...a.map((text) => ({ kind: 'del', text }) as DiffLine), ...b.map((text) => ({ kind: 'add', text }) as DiffLine)];
  } else {
    const n = a.length;
    const m = b.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    full = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        full.push({ kind: 'same', text: a[i] as string });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) full.push({ kind: 'del', text: a[i++] as string });
      else full.push({ kind: 'add', text: b[j++] as string });
    }
    while (i < n) full.push({ kind: 'del', text: a[i++] as string });
    while (j < m) full.push({ kind: 'add', text: b[j++] as string });
  }
  return collapse(full, context);
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
  const changed = lines.map((l) => l.kind !== 'same');
  const keep = lines.map((_, i) => changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skip', count: skipped });
  return out;
}

/** A document payload as text worth reading: XB code for pages, CSS for styles, JSON for settings. */
export function documentText(doc: string, payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  if (doc === 'styles') {
    const entries = Array.isArray(payload.styles) ? (payload.styles as Array<{ selector?: string; css?: string }>) : [];
    const globals = Array.isArray(payload.globals) ? (payload.globals as Array<{ id?: string; css?: string }>) : [];
    return [
      ...globals.map((g) => `/* ${t('foglio globale: {0}', g.id ?? '')} */\n${g.css ?? ''}`),
      ...[...entries].sort((x, y) => String(x.selector).localeCompare(String(y.selector))).map((e) => `${e.selector ?? ''} {\n${e.css ?? ''}\n}`),
    ].join('\n\n');
  }
  if (doc === 'settings') return JSON.stringify(sortKeys(payload), null, 2);
  const parts: string[] = [];
  if (typeof payload.content === 'string') {
    try {
      parts.push(print(parseXb(payload.content).blocks));
    } catch {
      parts.push(payload.content);
    }
  }
  if (typeof payload.script === 'string' && payload.script.trim() !== '') parts.push('/* JavaScript */\n' + payload.script);
  if (typeof payload.ref === 'string' && payload.ref !== '') parts.push(`/* ${t('componente: {0}', payload.ref)} */\n` + JSON.stringify(sortKeys(payload.schema ?? {}), null, 2));
  return parts.join('\n\n');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function summary(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
  };
}
