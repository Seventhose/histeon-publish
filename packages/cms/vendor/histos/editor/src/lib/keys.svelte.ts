// The keys of each command as the user set them (docs/spec/shortcuts.md), for the hints in titles, menus and
// empty states: built from the same keymap the shortcuts use, so a changed shortcut shows its new keys everywhere.
import { display } from './shortcuts.ts';

let current = $state<ReadonlyMap<string, string>>(new Map());
const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** The active keymap (combo → command), set by the builder whenever the user's shortcuts change. */
export function setKeys(map: ReadonlyMap<string, string>): void {
  current = map;
}

/** The first combination of a command as the user reads it (⌘S, Ctrl+S), or '' when it has none. */
export function keyHint(id: string): string {
  for (const [combo, bound] of current) if (bound === id) return display(combo, mac);
  return '';
}

/** `label (keys)`, or the label alone when the command has no keys. */
export function withKeys(label: string, id: string): string {
  const hint = keyHint(id);
  return hint ? `${label} (${hint})` : label;
}

/** The first combination in the form of aria-keyshortcuts (Control+D, Meta+D on a Mac), or undefined. */
export function ariaKeys(id: string): string | undefined {
  for (const [combo, bound] of current) {
    if (bound !== id) continue;
    return combo
      .split('+')
      .map((p) => (p === 'Mod' ? (mac ? 'Meta' : 'Control') : p))
      .join('+');
  }
  return undefined;
}
