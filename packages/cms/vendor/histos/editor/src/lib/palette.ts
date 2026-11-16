/** Command palette (Ctrl+K): commands and their ranking. Pure, tested in test/palette.test.ts. */

export interface Command {
  id: string;
  /** What the user reads and types against, e.g. "Inserisci: Sezione". */
  label: string;
  /** Group shown on the right: Inserisci, Vai a, Azione, Seleziona, Componente. */
  group: string;
  hint?: string;
  run: () => void;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Score of a query against a label, or -1: every query character in order (subsequence), with bonuses for
 * word starts and consecutive matches. Empty query: everything, in the given order.
 */
export function score(query: string, label: string): number {
  const q = fold(query.trim());
  if (q === '') return 0;
  const l = fold(label);
  let at = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = l.indexOf(ch, at);
    if (found < 0) return -1;
    const wordStart = found === 0 || /[\s:.\-_/]/.test(l.charAt(found - 1));
    streak = found === at ? streak + 1 : 0;
    total += 1 + (wordStart ? 3 : 0) + streak * 2 - Math.min(found - at, 5) * 0.2;
    at = found + 1;
  }
  return total + (l.startsWith(q) ? 5 : 0) - l.length * 0.01;
}

/** Commands matching the query, best first; at most `limit`. */
export function rank(commands: Command[], query: string, limit = 50): Command[] {
  if (query.trim() === '') return commands.slice(0, limit);
  return commands
    .map((command, index) => ({ command, index, s: Math.max(score(query, command.label), score(query, `${command.group} ${command.label}`) - 1) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.command);
}
