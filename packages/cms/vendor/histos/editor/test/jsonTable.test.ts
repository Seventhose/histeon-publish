import { describe, expect, it } from 'vitest';
import { addColumn, addRow, columns, keyProblem, moveRow, parseCell, removeColumn, renameColumn, setCell, setEntry, shapeOf } from '../src/lib/jsonTable.ts';

describe('visual JSON sources', () => {
  const rows = [{ giorno: 'Lunedì', ore: '9-13', posti: 20 }, { giorno: 'Martedì', ore: '14-18', posti: 12 }];

  it('picks the editor that fits the value', () => {
    expect(shapeOf(rows)).toBe('table');
    expect(shapeOf([])).toBe('table');
    expect(shapeOf({ telefono: '02 123', email: 'a@b.it' })).toBe('object');
    expect(shapeOf([{ a: { b: 1 } }])).toBe('code');
    expect(shapeOf('testo')).toBe('code');
  });

  it('keeps types while editing cells', () => {
    expect(parseCell('25', 20)).toBe(25);
    expect(parseCell('venti', 20)).toBe('venti');
    expect(parseCell('false', true)).toBe(false);
    expect(setCell(rows, 1, 'posti', '15')[1]).toEqual({ giorno: 'Martedì', ore: '14-18', posti: 15 });
    // A single object keeps its numbers, yes/no and empty values as the table does.
    expect(setEntry({ titolo: 'Orari', posti: 10, aperto: true, nota: null }, 'posti', '12')).toEqual({ titolo: 'Orari', posti: 12, aperto: true, nota: null });
    expect(setEntry({ aperto: true }, 'aperto', 'false')).toEqual({ aperto: false });
    expect(setEntry({ nota: null }, 'nota', '')).toEqual({ nota: null });
    expect(setEntry({ posti: 10 }, 'posti', 'molti')).toEqual({ posti: 'molti' });
    expect(rows[1]?.posti).toBe(12);
  });

  it('adds, moves, renames and removes rows and columns', () => {
    expect(columns(rows)).toEqual(['giorno', 'ore', 'posti']);
    expect(addRow(rows)[2]).toEqual({ giorno: '', ore: '', posti: '' });
    expect(moveRow(rows, 1, -1).map((r) => r.giorno)).toEqual(['Martedì', 'Lunedì']);
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(columns(renameColumn(rows, 'ore', 'orario'))).toEqual(['giorno', 'orario', 'posti']);
    expect(columns(removeColumn(rows, 'posti'))).toEqual(['giorno', 'ore']);
    expect(addColumn([], 'nome')).toEqual([{ nome: '' }]);
    expect(keyProblem('ore', ['ore'])).not.toBeNull();
    expect(keyProblem('2x', [])).not.toBeNull();
    expect(keyProblem('note', ['ore'])).toBeNull();
  });
});
