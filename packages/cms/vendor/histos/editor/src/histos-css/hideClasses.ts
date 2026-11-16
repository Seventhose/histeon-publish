// The live preview of the groups of classes (histos-publish doc 19 §5.3.12): the panel takes their rules out of the
// sheets the page has already parsed, in memory only, and puts them back at the next preview. Nothing is written.

interface Parent {
  cssRules: ArrayLike<{ cssText: string; selectorText?: string; conditionText?: string } & Partial<Parent>>;
  deleteRule(index: number): void;
  insertRule(rule: string, index: number): number;
}
type Removed = [parent: Parent, index: number, text: string];

const taken = new WeakMap<object, Removed[]>();

/** Whether a rule goes: every class it names matches. A rule that names no class stays, as in Utilities::filtered. */
function gone(selector: string, off: RegExp[]): boolean {
  const names = [...selector.matchAll(/\.(xb-[a-z0-9-]+)/g)].map((match) => match[1]!);
  return names.length > 0 && names.every((name) => off.some((pattern) => pattern.test(name)));
}

function walk(parent: Parent, off: RegExp[], out: Removed[]): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index]!;
    if (typeof rule.selectorText === 'string') {
      if (gone(rule.selectorText, off)) {
        out.push([parent, index, rule.cssText]);
        parent.deleteRule(index);
      }
    } else if (typeof rule.conditionText === 'string' && rule.deleteRule) {
      walk(rule as Parent, off, out);
    }
  }
}

/** `patterns`: those the server sends with the preview; empty puts everything back. */
export function hideClasses(doc: { styleSheets: Iterable<unknown> }, patterns: string[] = []): void {
  // Last taken, first back: each index is right again when its turn comes.
  for (const [parent, index, text] of (taken.get(doc) ?? []).reverse()) parent.insertRule(text, index);
  const out: Removed[] = [];
  const off = patterns.map((pattern) => new RegExp(pattern, 'u'));
  if (off.length) {
    for (const sheet of doc.styleSheets) {
      try {
        walk(sheet as Parent, off, out);
      } catch {
        // A sheet of another origin cannot be read: it stays as it is.
      }
    }
  }
  taken.set(doc, out);
}
