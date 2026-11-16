// The visual side of a JSON source: an array of rows becomes a table, an object a list of keys. Values keep their
// type (a number stays a number) unless the author types something that is not one.

import { t } from './i18n.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Row = Record<string, Json>;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** How a value can be edited visually. */
export function shapeOf(value: unknown): 'table' | 'object' | 'code' {
  if (Array.isArray(value) && value.every((r) => isPlain(r) && Object.values(r).every(isScalar))) return 'table';
  if (isPlain(value) && Object.values(value).every(isScalar)) return 'object';
  return 'code';
}

/** The columns of a table: every key, in first-seen order. */
export function columns(rows: Row[]): string[] {
  const seen: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
  return seen;
}

/** A typed cell back to JSON: numbers and booleans stay what they were when the text still reads as one. */
export function parseCell(text: string, previous: Json | undefined): Json {
  if (typeof previous === 'number' && /^-?\d+(\.\d+)?$/.test(text.trim())) return Number(text);
  if (typeof previous === 'boolean' && /^(true|false)$/.test(text.trim())) return text.trim() === 'true';
  if (previous === null && text === '') return null;
  return text;
}

export function cellText(value: Json | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function setCell(rows: Row[], index: number, key: string, text: string): Row[] {
  return rows.map((row, i) => (i === index ? { ...row, [key]: parseCell(text, row[key]) } : row));
}

/** One key of a single object, typed as the table types a cell. */
export function setEntry(object: Row, key: string, text: string): Row {
  return { ...object, [key]: parseCell(text, object[key]) };
}

export function addRow(rows: Row[]): Row[] {
  return [...rows, Object.fromEntries(columns(rows).map((k) => [k, ''])) as Row];
}

export function removeRow(rows: Row[], index: number): Row[] {
  return rows.filter((_, i) => i !== index);
}

export function moveRow(rows: Row[], index: number, delta: -1 | 1): Row[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to] as Row, next[index] as Row];
  return next;
}

/** A key name a JSON source accepts and an expression can read (`item.chiave`). */
export function keyProblem(key: string, existing: string[]): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return t('Nome di colonna non valido: lettere, cifre e _, non all’inizio una cifra.');
  if (existing.includes(key)) return t('La colonna "{0}" c’è già.', key);
  return null;
}

export function addColumn(rows: Row[], key: string): Row[] {
  return (rows.length ? rows : [{}]).map((row) => ({ ...row, [key]: '' }));
}

/** Renames a key in every row, keeping its position. */
export function renameColumn(rows: Row[], from: string, to: string): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k === from ? to : k, v])) as Row);
}

export function removeColumn(rows: Row[], key: string): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== key)) as Row);
}
