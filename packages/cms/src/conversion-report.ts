// The single report of an HTML import (doc 23 item 163): what the conversion took away, what moved into the page's
// JavaScript (event handlers, dialogs), which media queries of the site match Histeon's named breakpoints, and what
// is left to check. The converter keeps its notes as sentences; this groups them, so the app, the agent and the
// WordPress screen read the same report. A captured proposal has one group more: what waited for a script of the
// proposal and must be built again («da rifare», lost-interactions.ts and proposal-recipes.ts).

export type ConversionNoteKind = "removed" | "script" | "breakpoint" | "redo" | "check";

export interface ConversionNoteGroup {
  kind: ConversionNoteKind;
  items: string[];
}

const ORDER: readonly ConversionNoteKind[] = ["removed", "script", "breakpoint", "redo", "check"];

/** Which group a note belongs to, from its words (a `N × ` count in front is allowed). */
export function conversionNoteKind(note: string): ConversionNoteKind {
  const text = note.replace(/^\d+ × /u, "");
  // Before the words below: a line «da rifare» may quote a word of the site that reads like one of them.
  if (/^da rifare: /u.test(text)) return "redo";
  if (/^@media\b/u.test(text)) return "breakpoint";
  if (/JavaScript della pagina|addEventListener|showModal/u.test(text)) return "script";
  if (/\b(?:tolt[oaie]|non convertit[oaie]|sostituit[oaie]|ridott[oaie])\b/u.test(text)) return "removed";
  return "check";
}

/** The notes in their groups, in a fixed order, empty groups left out; each group keeps the notes' order. */
export function groupConversionNotes(notes: readonly string[]): ConversionNoteGroup[] {
  const groups = new Map<ConversionNoteKind, string[]>(ORDER.map((kind) => [kind, []]));
  for (const note of notes) groups.get(conversionNoteKind(note))!.push(note);
  return ORDER.filter((kind) => groups.get(kind)!.length).map((kind) => ({ kind, items: groups.get(kind)! }));
}

/** Histeon's named media queries as written by default (the plugin's NamedQueries::DEFAULTS), in em. */
const NAMED: ReadonlyArray<{ name: string; below: boolean; em: number }> = [
  { name: "--mobile", below: true, em: 40 },
  { name: "--tablet", below: true, em: 64 },
  { name: "--desktop", below: false, em: 64 },
];

/**
 * One note per width the site's media queries use: how often, and the named query that says the same (or the
 * nearest one, when none is equal), so whoever imports knows which breakpoints carry over as they are.
 */
export function breakpointNotes(css: readonly string[]): string[] {
  const counts = new Map<string, { below: boolean; em: number; count: number; written: string }>();
  const pattern = /@media[^{;]*?\(\s*(?:(max|min)-width\s*:\s*|width\s*(<=?|>=?)\s*)(\d+(?:\.\d+)?)(px|em|rem)\s*\)/giu;
  for (const sheet of css) {
    for (const match of sheet.matchAll(pattern)) {
      const below = match[1] ? match[1].toLowerCase() === "max" : match[2]!.startsWith("<");
      const value = Number(match[3]);
      const em = match[4]!.toLowerCase() === "px" ? value / 16 : value;
      const written = `${below ? "fino a" : "da"} ${match[3]}${match[4]!.toLowerCase()}`;
      const key = `${below}|${em}`;
      const entry = counts.get(key) ?? { below, em, count: 0, written };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.em - right.em)
    .slice(0, 20)
    .map(({ below, em, count, written }) => {
      const same = NAMED.find((n) => n.below === below && Math.abs(n.em - em) < 0.01);
      const sameSide = NAMED.filter((n) => n.below === below);
      const nearest = sameSide.reduce((best, n) => (Math.abs(n.em - em) < Math.abs(best.em - em) ? n : best), sameSide[0]!);
      const times = count === 1 ? "1 volta" : `${count} volte`;
      return same
        ? `@media ${written} (${times}): è ${same.name}, si può scrivere @media (${same.name})`
        : `@media ${written} (${times}): nessuna media query con nome uguale; la più vicina è ${nearest.name} (${nearest.em}em = ${nearest.em * 16}px)`;
    });
}
