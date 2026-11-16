// Keyboard shortcuts (docs/spec/shortcuts.md): every command of the palette (Ctrl+K) can have key
// combinations. The defaults below apply until the user changes them; only the changes are stored, per user,
// on the server (plugin/src/Admin/Shortcuts.php checks the same rules). Pure, tested in test/shortcuts.test.ts.

import { t } from './i18n.ts';

/** Mod is Ctrl, or ⌘ on a Mac. Order: Mod, Alt, Shift, key. */
export const COMBO = /^(Mod\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F[1-9]|F1[0-2]|Arrow(Up|Down|Left|Right)|Delete|Backspace|Home|End|PageUp|PageDown|[,./;[\]=-])$/;

/** Kept by the browser or the system, or needed to type and move around. */
export const RESERVED = ['Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+R', 'Mod+L', 'Mod+F', 'Mod+P', 'Mod+Shift+T', 'Mod+Shift+N', 'Mod+Shift+W', 'Backspace'];

export const DEFAULTS: Record<string, string[]> = {
  palette: ['Mod+K'],
  save: ['Mod+S'],
  insert: ['Mod+I'],
  undo: ['Mod+Z'],
  redo: ['Mod+Shift+Z', 'Mod+Y'],
  dup: ['Mod+D'],
  del: ['Delete'],
  up: ['Alt+ArrowUp'],
  down: ['Alt+ArrowDown'],
  outdent: ['Alt+ArrowLeft'],
  indent: ['Alt+ArrowRight'],
};

/**
 * Where a shortcut works: `global` everywhere (code editors and fields too), `code` everywhere but the code
 * editors (which have their own), anything else only outside fields and code editors, so typing is never taken.
 */
export const SCOPES: Record<string, 'global' | 'code'> = { palette: 'global', save: 'global', insert: 'code' };

export type Overrides = Record<string, string[]>;

const NAMED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown']);
const PUNCTUATION: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-' };

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The combination of a key event, or null (a modifier alone, a key that cannot be a shortcut). Letters, digits
 * and punctuation come from the physical key (`code`), so Alt or a keyboard layout never change them.
 */
export function comboOf(event: KeyLike): string | null {
  let key: string | null = null;
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (PUNCTUATION[code]) key = PUNCTUATION[code]!;
  else if (NAMED.has(event.key) || /^F([1-9]|1[0-2])$/.test(event.key)) key = event.key;
  else if (/^[a-z0-9]$/i.test(event.key)) key = event.key.toUpperCase();
  if (!key) return null;
  return `${event.ctrlKey || event.metaKey ? 'Mod+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
}

export function bindingsFor(id: string, overrides: Overrides): string[] {
  return overrides[id] ?? DEFAULTS[id] ?? [];
}

/** Combination → command: the user's choices first, then the defaults they did not take over. */
export function keymap(overrides: Overrides): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, combos] of Object.entries(overrides)) for (const c of combos) map.set(c, id);
  for (const [id, combos] of Object.entries(DEFAULTS)) {
    if (id in overrides) continue;
    for (const c of combos) if (!map.has(c)) map.set(c, id);
  }
  return map;
}

/** Why a combination cannot go to this command, or null. `labelOf` names the command that has it. */
export function comboProblem(combo: string, id: string, overrides: Overrides, labelOf: (id: string) => string = (x) => x): string | null {
  if (!COMBO.test(combo)) return t('Questa combinazione non si può usare.');
  if (RESERVED.includes(combo)) return t('{0} resta al browser o alla scrittura.', combo);
  const owner = keymap(overrides).get(combo);
  if (owner && owner !== id) return t('{0} è già di «{1}».', combo, labelOf(owner));
  return null;
}

/** The overrides with these combinations for a command (the defaults again: no override). */
export function setBindings(overrides: Overrides, id: string, combos: string[]): Overrides {
  const next = { ...overrides };
  const defaults = DEFAULTS[id] ?? [];
  if (combos.length === defaults.length && combos.every((c, i) => c === defaults[i])) delete next[id];
  else next[id] = combos;
  return next;
}

const SYMBOLS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Delete: t('Canc'), Backspace: '⌫', PageUp: t('Pag↑'), PageDown: t('Pag↓'), Home: t('Inizio'), End: t('Fine') };

/** A combination as the user reads it: ⌘⇧Z on a Mac, Ctrl+Shift+Z elsewhere. */
export function display(combo: string, mac: boolean): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const name = SYMBOLS[key] ?? (key === '' ? '+' : key);
  if (mac) return parts.map((p) => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' })[p] ?? p).join('') + name;
  return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), name].join('+');
}

/** The active keymap, for the canvas frame (which hands bound keys over to the builder window). */
let active = keymap({});
export function activate(map: Map<string, string>): void {
  active = map;
}
export function isBound(combo: string | null): boolean {
  return combo !== null && active.has(combo);
}
/** The command a combination runs now, or undefined. */
export function commandOf(combo: string | null): string | undefined {
  return combo === null ? undefined : active.get(combo);
}
