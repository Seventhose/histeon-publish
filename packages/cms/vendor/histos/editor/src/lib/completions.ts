import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

export interface NamedItem {
  name: string;
  group: string;
}

/**
 * CSS panel: framework custom properties. Typing `--sp` offers `--space-m`; outside `var(…)` the
 * completion inserts `var(--space-m)`, like writing the value by hand.
 */
export function variableSource(items: () => NamedItem[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/--[\w-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const before = context.state.sliceDoc(Math.max(0, word.from - 4), word.from);
    const insideVar = before.endsWith('var(');
    return {
      from: word.from,
      validFor: /^--[\w-]*$/,
      options: items().map((item) => ({
        label: `--${item.name}`,
        detail: item.group,
        type: 'variable',
        apply: insideVar ? `--${item.name}` : `var(--${item.name})`,
      })),
    };
  };
}

/**
 * HTML panel: framework classes inside a static `class="…"` attribute. With `describe`, each option shows what the
 * class does (classPreview.ts) next to the list.
 */
export function classSource(items: () => NamedItem[], describe?: (name: string) => Node | null): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    if (!/\bclass\s*=\s*"[^"{]*$/.test(before)) return null;
    const word = context.matchBefore(/[\w-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return {
      from: word.from,
      validFor: /^[\w-]*$/,
      options: items().map((item) => ({ label: item.name, detail: item.group, type: 'class', ...(describe ? { info: () => describe(item.name) } : {}) })),
    };
  };
}

/**
 * HTML panel, inside `{…}`: after `data.` the data of the site's PHP (docs/spec/php.md); after any other `.`,
 * on request (Ctrl+Space), the modifiers. Typing a field name is never interrupted by modifiers.
 */
export function expressionSource(ext: () => { data: Array<{ name: string; description: string }>; modifiers: string[] } | null): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const open = before.lastIndexOf('{');
    if (open < 0 || before.lastIndexOf('}') > open) return null;
    const e = ext();
    if (!e) return null;
    const data = context.matchBefore(/\bdata\.\w*$/);
    if (data && e.data.length) {
      return {
        from: data.from + 5,
        validFor: /^\w*$/,
        options: e.data.map((d) => ({ label: d.name, detail: 'PHP', info: d.description || undefined, type: 'variable' })),
      };
    }
    const member = context.matchBefore(/[\w)\]]\.\w*$/);
    if (!member || !context.explicit) return null;
    return {
      from: member.from + 2,
      validFor: /^\w*$/,
      options: e.modifiers.map((m) => ({ label: `${m}()`, type: 'function', apply: `${m}()` })),
    };
  };
}
