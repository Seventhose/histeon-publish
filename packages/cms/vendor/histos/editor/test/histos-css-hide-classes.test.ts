import { describe, expect, it } from 'vitest';
import { hideClasses } from '../src/histos-css/hideClasses.ts';

type Rule = { cssText: string; selectorText?: string; conditionText?: string; cssRules?: Rule[]; deleteRule?: (i: number) => void; insertRule?: (t: string, i: number) => number };

const list = (rules: Rule[]) => ({
  cssRules: rules,
  deleteRule(i: number) { rules.splice(i, 1); },
  insertRule(text: string, i: number) { rules.splice(i, 0, { cssText: text, selectorText: text.split(' {')[0]! }); return i; },
});
const style = (selector: string): Rule => ({ cssText: `${selector} { color: red }`, selectorText: selector });

describe('live preview of the groups of classes', () => {
  it('takes out the rules whose classes are all off, also inside @media, and puts them back in order', () => {
    const media = list([style('.xb-enter-up'), style('.xb-card')]);
    const rules: Rule[] = [style('.xb-btn-info'), style('.xb-btn, .xb-btn-info'), style('p'), { cssText: '@media', conditionText: 'x', ...media }, style('.xb-btn-info:hover')];
    const doc = { styleSheets: [list(rules)] };
    const before = rules.map((r) => r.cssText);
    hideClasses(doc, ['^xb-btn-info$', '^xb-enter-']);
    expect(rules.map((r) => r.selectorText ?? '@media')).toEqual(['.xb-btn, .xb-btn-info', 'p', '@media']);
    expect(media.cssRules.map((r) => r.selectorText)).toEqual(['.xb-card']);
    hideClasses(doc, ['^xb-btn-info$']);
    expect(rules.map((r) => r.selectorText ?? '@media')).toEqual(['.xb-btn, .xb-btn-info', 'p', '@media']);
    expect(media.cssRules.map((r) => r.selectorText)).toEqual(['.xb-enter-up', '.xb-card']);
    hideClasses(doc);
    expect(rules.map((r) => r.cssText)).toEqual(before);
  });

  it('leaves alone a sheet it cannot read', () => {
    const closed = { get cssRules(): never { throw new Error('SecurityError'); } };
    expect(() => hideClasses({ styleSheets: [closed] }, ['^xb-btn'])).not.toThrow();
  });
});
