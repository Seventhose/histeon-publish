/**
 * What a framework class does, for the HTML panel's completions (docs/spec/framework.md §Nel builder): the rules the
 * canvas loads for it and, where it sets a colour or a space, a small sample. For utility-class frameworks (Core
 * Framework, Automatic.css); Histeon CSS is written with variables and BEM classes, so it gets none. Everything is
 * read from the canvas's own stylesheets and shown as text: nothing is parsed as markup.
 */

import { t } from './i18n.ts';

/** The selector names this exact class (`.btn` matches `.btn`, `.btn:hover`, `.card .btn`; not `.btn-primary`). */
export function selectorHasClass(selector: string, name: string): boolean {
  // As stylesheets write it (`w-1/2` is `.w-1\/2`), then as a literal in the pattern.
  const css = name.replace(/[^\w-]/g, (c) => `\\${c}`);
  const literal = css.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`\\.${literal}(?![\\w-])`).test(selector);
}

/** The rules of the canvas that use the class, `selector { declarations }`, at most `limit`. */
export function rulesFor(doc: Document, name: string, limit = 4): string[] {
  const out: string[] = [];
  const walk = (rules: CSSRuleList, prefix: string) => {
    for (const rule of Array.from(rules)) {
      if (out.length >= limit) return;
      if (rule instanceof CSSStyleRule) {
        if (selectorHasClass(rule.selectorText, name)) out.push(`${prefix}${rule.selectorText} { ${rule.style.cssText} }`);
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        const media = rule instanceof CSSMediaRule ? `@media ${rule.conditionText} → ` : '';
        walk((rule as CSSGroupingRule).cssRules, prefix + media);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      walk(sheet.cssRules, '');
    } catch {
      /* a stylesheet from another origin: its rules cannot be read */
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** The info box of a completion: the class's rules and, if it colours or spaces something, a sample. */
export function classInfo(doc: Document | null, name: string): HTMLElement | null {
  if (!doc) return null;
  const rules = rulesFor(doc, name);
  const box = document.createElement('div');
  box.className = 'xb-class-info';
  if (rules.length === 0) {
    box.textContent = t('Nessuna regola caricata nella tela per questa classe.');
    return box;
  }
  const win = doc.defaultView;
  if (win) {
    // A probe in the canvas: the values the class really produces there (variables resolved).
    const probe = doc.createElement('div');
    probe.className = name;
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;';
    doc.body.append(probe);
    const cs = win.getComputedStyle(probe);
    const bg = cs.backgroundColor;
    const fg = cs.color;
    const pad = Number.parseFloat(cs.paddingLeft) || 0;
    const gap = Number.parseFloat(cs.columnGap) || 0;
    probe.remove();
    const sample = document.createElement('div');
    sample.className = 'xb-class-sample';
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      sample.style.background = bg;
      sample.style.color = fg;
      sample.textContent = 'Aa';
      box.append(sample);
    } else if (pad > 0 || gap > 0) {
      sample.style.width = `${Math.min(200, pad || gap)}px`;
      sample.style.height = '8px';
      sample.style.background = '#ff6f5e';
      sample.title = `${Math.round(pad || gap)}px`;
      box.append(sample);
    }
  }
  const pre = document.createElement('pre');
  pre.textContent = rules.join('\n');
  box.append(pre);
  return box;
}
