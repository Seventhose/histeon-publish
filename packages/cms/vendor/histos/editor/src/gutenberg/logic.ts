// Loops and conditions in words, in Gutenberg's sidebar (lista della spesa 137). A loop reads as a sentence («6
// articoli, per data») from the builder's query summary, and its query, how many and how many to skip change with
// fields; a condition reads as a sentence and is composed as field, operator and value. Both write the same text the
// code shows (the loop's source, the branch's test): the code stays the truth, the panels are a way to write it.
import { parseExpression } from '@xb/dsl';
import type { QueriesData } from '../lib/api.ts';
import { readAmount, summary } from '../lib/queryForm.ts';
import { RESERVED, type Preset } from '../lib/queries.ts';
// The groupings and their sentence are shared with the builder's Query panel (doc 23 of Publish, items 187 and 205).
import { GROUPINGS, groupingOf, groupSentence, type GroupBy } from '../lib/loopGroups.ts';
import { api, config, errorText } from './context.ts';
import { __, h, useEffect, useState, wp, type GutenbergBlock } from './wp.ts';

// ------------------------------------------------------------------ conditions

export type Operator = '==' | '!=' | 'exists' | 'missing' | '>' | '<';

export const OPERATORS: Array<{ value: Operator; label: string }> = [
  { value: '==', label: 'è uguale a' },
  { value: '!=', label: 'è diverso da' },
  { value: 'exists', label: 'c’è' },
  { value: 'missing', label: 'non c’è' },
  { value: '>', label: 'è maggiore di' },
  { value: '<', label: 'è minore di' },
];

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A value as an expression literal: numbers, true, false and null as they are, anything else a quoted string. */
export function literal(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false' || v === 'null') return v;
  return JSON.stringify(v);
}

/** The test a field, an operator and a value make, or null when the field is not a plain path. */
export function composeTest(field: string, operator: Operator, value: string): string | null {
  const f = field.trim();
  if (!PATH.test(f)) return null;
  if (operator === 'exists') return f;
  if (operator === 'missing') return `!${f}`;
  return `${f} ${operator} ${literal(value)}`;
}

/** The parts of a simple test (`a == "x"`, `!a`, `a`), for the composer to show it; null when it is not that simple. */
export function readTest(test: string): { field: string; operator: Operator; value: string } | null {
  const t = test.trim();
  // Literals are values, never fields: `true` is not «the field true exists».
  if (['true', 'false', 'null'].includes(t.replace(/^!\s*/, ''))) return null;
  let m = /^!\s*([A-Za-z_][\w.]*)$/.exec(t);
  if (m && PATH.test(m[1]!)) return { field: m[1]!, operator: 'missing', value: '' };
  if (PATH.test(t)) return { field: t, operator: 'exists', value: '' };
  m = /^([A-Za-z_][\w.]*)\s*(==|!=|>|<)\s*(.+)$/.exec(t);
  if (!m || !PATH.test(m[1]!)) return null;
  let value = m[3]!.trim();
  // One literal only: anything more (`2 && b`) is not a simple test, and stays in the code field.
  if (!/^(-?\d+(\.\d+)?|true|false|null|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value)) return null;
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) value = JSON.parse(value) as string;
  else if (/^'(?:[^'\\]|\\.)*'$/.test(value)) value = value.slice(1, -1);
  return { field: m[1]!, operator: m[2] as Operator, value };
}

/** The test in words, for a client: «Si mostra se page.type è uguale a "evento"». */
export function sentence(test: string | null): string {
  if (!test) return __('Si mostra quando nessuna condizione prima è vera.');
  const parts = readTest(test);
  if (!parts) return __('Si mostra se: {0}', test);
  const op = OPERATORS.find((o) => o.value === parts.operator)!;
  const value = parts.operator === 'exists' || parts.operator === 'missing' ? '' : ` ${literal(parts.value)}`;
  return __('Si mostra se {0} {1}{2}.', parts.field, __(op.label), value);
}

/** Whether a test parses as an expression; the error message otherwise. */
export function checkTest(test: string): string | null {
  try {
    parseExpression(test);
    return null;
  } catch (e) {
    return errorText(e);
  }
}

function ConditionPanel({ block }: { block: GutenbergBlock }) {
  const test: string | null = typeof block.attributes.test === 'string' ? block.attributes.test : null;
  const parts = test ? readTest(test) : null;
  const [field, setField] = useState(parts?.field ?? '');
  const [operator, setOperator] = useState<Operator>(parts?.operator ?? '==');
  const [value, setValue] = useState(parts?.value ?? '');
  const [text, setText] = useState(test ?? '');
  const { updateBlockAttributes } = wp.data.useDispatch('core/block-editor');
  const client = Boolean(config?.client);
  const composed = composeTest(field, operator, value);
  const textError = text.trim() ? checkTest(text) : null;
  const write = (next: string) => {
    if (client || checkTest(next)) return;
    updateBlockAttributes(block.clientId, { test: next });
    setText(next);
  };
  return h(
    'div',
    { className: 'xb-logic' },
    h('p', { className: 'xb-logic-sentence' }, sentence(test)),
    test === null
      ? null
      : h(
          'div',
          { className: 'xb-logic-compose' },
          h(wp.components.TextControl, { label: __('Campo'), value: field, onChange: setField, disabled: client, placeholder: 'page.type', __nextHasNoMarginBottom: true }),
          h(wp.components.SelectControl, { label: __('Condizione'), value: operator, options: OPERATORS.map((o) => ({ value: o.value, label: __(o.label) })), onChange: setOperator, disabled: client, __nextHasNoMarginBottom: true }),
          operator === 'exists' || operator === 'missing' ? null : h(wp.components.TextControl, { label: __('Valore'), value, onChange: setValue, disabled: client, __nextHasNoMarginBottom: true }),
          client ? null : h(wp.components.Button, { variant: 'secondary', disabled: !composed || composed === test, onClick: () => composed && write(composed) }, __('Usa questa condizione')),
          h(wp.components.TextControl, { label: __('Come si scrive nel codice'), value: text, onChange: setText, disabled: client, help: textError ?? undefined, __nextHasNoMarginBottom: true }),
          client ? null : h(wp.components.Button, { variant: 'tertiary', disabled: !text.trim() || Boolean(textError) || text === test, onClick: () => write(text.trim()) }, __('Applica il codice')),
        ),
  );
}

// ------------------------------------------------------------------ loops

let queries: QueriesData | null = null;
let loadingQueries: Promise<QueriesData> | null = null;
function useQueries(): QueriesData | null {
  const [, update] = useState(0);
  useEffect(() => {
    if (queries || !api) return;
    loadingQueries ??= api.getQueries();
    loadingQueries.then(
      (q) => {
        queries = q;
        update((n) => n + 1);
      },
      () => {
        loadingQueries = null;
      },
    );
  }, []);
  return queries;
}

const BUILTIN: Record<string, Preset> = { posts: { type: 'posts', args: {} }, terms: { type: 'terms', args: {} }, users: { type: 'users', args: {} }, main: { type: 'main', args: {} } };

type LoopSourceAttr = { kind: string; id?: string; expr?: string; args?: Record<string, unknown>; groupBy?: GroupBy };

/** The loop's query in words: its preset's summary with what the loop itself passes (limit, offset, groups). */
export function loopSentence(source: LoopSourceAttr, presets: Record<string, Preset>, types: Record<string, string> = {}): string {
  if (source.kind !== 'preset' || !source.id) return __('Ripete i valori di {0}', source.expr ?? '…');
  const preset = presets[source.id] ?? BUILTIN[source.id];
  if (!preset) return __('Query «{0}», che questo sito non ha.', source.id);
  const args: Record<string, unknown> = { ...preset.args };
  const limit = source.args?.limit;
  if (typeof limit === 'number') {
    if (preset.type === 'posts') args.posts_per_page = limit;
    else args.number = limit;
  }
  const text = summary(preset.type, args, { types });
  const offset = typeof source.args?.offset === 'number' && source.args.offset > 0 ? __(', saltando i primi {0}', String(source.args.offset)) : '';
  const groups = source.groupBy ? `, ${groupSentence(source.groupBy)}` : '';
  return `${text}${offset}${groups} — ${RESERVED.includes(source.id) ? __('query di serie «{0}»', source.id) : __('query «{0}»', source.id)}`;
}

function LoopPanel({ block }: { block: GutenbergBlock }) {
  const data = useQueries();
  const { updateBlockAttributes } = wp.data.useDispatch('core/block-editor');
  const client = Boolean(config?.client);
  const source = (block.attributes.source ?? { kind: 'preset', id: 'posts' }) as LoopSourceAttr;
  if (!data) return h('p', { className: 'xb-insp-note' }, __('Caricamento delle query…'));
  const types = Object.fromEntries(data.types.map((t) => [t.name, t.label]));
  const presets = data.presets;
  const set = (next: typeof source) => {
    if (client) return;
    const args = Object.fromEntries(Object.entries(next.args ?? {}).filter(([, v]) => v !== undefined && v !== ''));
    // The grouping stays as it is when the query or its numbers change (item 187).
    updateBlockAttributes(block.clientId, { source: { kind: next.kind, id: next.id, ...(Object.keys(args).length ? { args } : {}), ...(next.groupBy ? { groupBy: next.groupBy } : {}) } });
  };
  const variable = typeof block.attributes.as === 'string' ? block.attributes.as : 'item';
  const groupKey = `{${variable}.key}`;
  const groupItems = `{${variable}.items}`;
  const grouping = groupingOf(source.groupBy);
  const preset = source.id ? (presets[source.id] ?? BUILTIN[source.id]) : undefined;
  const shown = preset ? readAmount(preset.type === 'posts' ? preset.args.posts_per_page : preset.args.number, 10) : null;
  return h(
    'div',
    { className: 'xb-logic' },
    h('p', { className: 'xb-logic-sentence' }, loopSentence(source, presets, types)),
    source.kind !== 'preset'
      ? h('p', { className: 'xb-insp-note' }, __('Questo loop ripete un valore scritto nel codice: si cambia nel builder.'))
      : h(
          'div',
          { className: 'xb-logic-compose' },
          h(wp.components.SelectControl, {
            label: __('Quale query'),
            value: source.id ?? 'posts',
            disabled: client,
            options: [...Object.keys(presets).map((id) => ({ value: id, label: id })), ...RESERVED.filter((id) => !(id in presets)).map((id) => ({ value: id, label: __('{0} (di serie)', id) }))],
            onChange: (id: string) => set({ kind: 'preset', id, args: source.args, groupBy: source.groupBy }),
            __nextHasNoMarginBottom: true,
          }),
          preset?.type === 'main'
            ? null
            : h(wp.components.TextControl, {
                label: __('Quanti'),
                type: 'number',
                min: 1,
                max: 100,
                disabled: client,
                value: typeof source.args?.limit === 'number' ? String(source.args.limit) : '',
                placeholder: shown ? String(shown.value) : '',
                help: __('Vuoto: quanti ne dice la query.'),
                onChange: (v: string) => set({ ...source, args: { ...source.args, limit: v === '' ? undefined : Math.max(1, Math.min(100, Number(v))) } }),
                __nextHasNoMarginBottom: true,
              }),
          preset?.type === 'main'
            ? null
            : h(wp.components.TextControl, {
                label: __('Salta i primi'),
                type: 'number',
                min: 0,
                disabled: client,
                value: typeof source.args?.offset === 'number' ? String(source.args.offset) : '',
                onChange: (v: string) => set({ ...source, args: { ...source.args, offset: v === '' ? undefined : Math.max(0, Number(v)) } }),
                __nextHasNoMarginBottom: true,
              }),
          // Doc 23 of Publish, item 187: each item of the loop becomes a group {key, items}, from one query.
          h(wp.components.SelectControl, {
            label: __('In gruppi'),
            value: grouping,
            disabled: client,
            options: [
              { value: '', label: __('No, un elemento per contenuto') },
              ...GROUPINGS.map((option) => ({ value: option.value, label: option.label() })),
              ...(grouping === 'code' && source.groupBy ? [{ value: 'code', label: groupSentence(source.groupBy) }] : []),
            ],
            help: __('Ogni ripetizione è un gruppo: il titolo in {0}, i contenuti in {1}.', groupKey, groupItems),
            onChange: (value: string) => {
              if (value === 'code') return;
              const { groupBy: _old, ...rest } = source;
              const option = GROUPINGS.find((entry) => entry.value === value);
              set(option ? { ...rest, groupBy: option.groupBy } : rest);
            },
            __nextHasNoMarginBottom: true,
          }),
        ),
  );
}

/** The panel for the selected block, when it is a loop or a branch of a condition; null otherwise. */
export function LogicPanel({ block }: { block: GutenbergBlock }) {
  if (block.name === 'xb/loop') return h(LoopPanel, { block });
  if (block.name === 'xb/branch') return h(ConditionPanel, { block, key: block.clientId });
  return null;
}
