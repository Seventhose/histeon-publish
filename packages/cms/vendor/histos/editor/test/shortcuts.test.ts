import { describe, expect, it } from 'vitest';
import { bindingsFor, comboOf, comboProblem, display, keymap, setBindings } from '../src/lib/shortcuts.ts';

const key = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('shortcuts', () => {
  it('reads combinations from physical keys', () => {
    expect(comboOf(key('k', 'KeyK', { ctrlKey: true }))).toBe('Mod+K');
    expect(comboOf(key('K', 'KeyK', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+K');
    expect(comboOf(key('˚', 'KeyK', { altKey: true }))).toBe('Alt+K'); // Alt on a Mac changes the character, not the key
    expect(comboOf(key('ArrowUp', 'ArrowUp', { altKey: true }))).toBe('Alt+ArrowUp');
    expect(comboOf(key('ç', 'Semicolon', { ctrlKey: true }))).toBe('Mod+;');
    expect(comboOf(key('F2', 'F2'))).toBe('F2');
    expect(comboOf(key('Control', 'ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(comboOf(key('Enter', 'Enter'))).toBeNull();
  });

  it('merges the user choices over the defaults', () => {
    expect(keymap({}).get('Mod+K')).toBe('palette');
    const mine = setBindings({}, 'dup', ['Mod+J']);
    expect(keymap(mine).get('Mod+J')).toBe('dup');
    expect(keymap(mine).has('Mod+D'), 'the default moved, not added').toBe(false);
    expect(keymap(setBindings({}, 'del', [])).has('Delete'), 'a default can be turned off').toBe(false);
    expect(setBindings(mine, 'dup', ['Mod+D'])).toEqual({}, 'back to the default: nothing stored');
    expect(keymap({ 'sec-styles': ['Mod+D'] }).get('Mod+D'), 'a user choice wins over a default').toBe('sec-styles');
    expect(bindingsFor('redo', {})).toEqual(['Mod+Shift+Z', 'Mod+Y']);
  });

  it('refuses reserved, invalid and taken combinations', () => {
    expect(comboProblem('Mod+C', 'x', {})).toMatch(/browser/);
    expect(comboProblem('Mod+Enter', 'x', {})).toMatch(/non si può/);
    expect(comboProblem('Mod+S', 'x', {}, () => 'Salva')).toMatch(/Salva/);
    expect(comboProblem('Mod+S', 'save', {})).toBeNull();
    expect(comboProblem('Alt+P', 'preview', {})).toBeNull();
  });

  it('shows combinations for Mac and others', () => {
    expect(display('Mod+Shift+Z', true)).toBe('⌘⇧Z');
    expect(display('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(display('Alt+ArrowUp', false)).toBe('Alt+↑');
    expect(display('Delete', true)).toBe('Canc');
  });
});
