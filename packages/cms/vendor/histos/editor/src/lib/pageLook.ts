// The page's own look (voce 186; docs/spec/client-mode.md, «Aspetto della pagina»): what the mini GUI writes when a
// change must stay on one page. The entries are `{selector, css}` with the mini GUI's own CSS (declarations, a state,
// a named width); the server reads them with a closed grammar (plugin/src/Styles/PageLook.php) and prints them under
// the page's class (`.xb-page-12 .card__title`). In the builder and in Gutenberg only that page is drawn, so they are
// scoped to `:root`: the same specificity, one class more than the site's own rule, which they override.
import { compileCss, resolveNamedQueries } from '@xb/dsl';
import { bodyAt, setBodyAt } from './cssContext.ts';
import { GROUPS, setDeclaration } from './miniGui.ts';
import { t } from './i18n.ts';

export interface PageStyle {
  selector: string;
  css: string;
}

/** The mini GUI's groups, the unit a client is granted (PageLook::GROUPS). */
export const LOOK_GROUPS = GROUPS.map((g) => g.id);

const GROUP_OF = new Map(GROUPS.flatMap((g) => g.controls.map((c) => [c.prop, g.id] as const)));

/** The group of a property, '' when the mini GUI has no control for it. */
export function groupOf(prop: string): string {
  return GROUP_OF.get(prop) ?? '';
}

/** Every declaration, flat: `selector␟blocks␟property` → value, as the server compares two versions. */
export function pageDeclarations(entries: PageStyle[]): Map<string, string> {
  const out = new Map<string, string>();
  const read = (css: string, path: string[], selector: string) => {
    let at = 0;
    while (at < css.length) {
      const rest = css.slice(at);
      const span = rest.search(/[;{}]/);
      const end = span === -1 ? css.length : at + span;
      const text = css.slice(at, end).trim();
      if (css[end] === '{') {
        let depth = 1;
        let close = end + 1;
        while (close < css.length && depth > 0) {
          if (css[close] === '{') depth++;
          else if (css[close] === '}') depth--;
          close++;
        }
        const prelude = text.replace(/\s+/g, ' ').replace('( ', '(').replace(' )', ')');
        read(css.slice(end + 1, close - 1), [...path, prelude], selector);
        at = close;
        continue;
      }
      const colon = text.indexOf(':');
      if (text && colon > 0) out.set(`${selector}\u001F${path.join(' ')}\u001F${text.slice(0, colon).trim().toLowerCase()}`, text.slice(colon + 1).trim().replace(/\s+/g, ' '));
      at = end + 1;
    }
  };
  for (const entry of entries) read(entry.css, [], entry.selector);
  return out;
}

/** The properties whose value differs between two versions. */
export function changedProps(before: PageStyle[], after: PageStyle[]): string[] {
  const a = pageDeclarations(before);
  const b = pageDeclarations(after);
  const props = new Set<string>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key)) props.add(key.slice(key.lastIndexOf('\u001F') + 1));
  }
  return [...props];
}

/** '' when a client with these groups may go from `before` to `after`; otherwise why not (the server says the same). */
export function lookProblem(before: PageStyle[], after: PageStyle[], groups: string[]): string {
  for (const prop of changedProps(before, after)) {
    if (!groups.includes(groupOf(prop))) return t('Non puoi cambiare {0} su questa pagina.', prop);
  }
  return '';
}

/** The selector's own CSS on this page, '' when it has none. */
export function pageCssOf(entries: PageStyle[], selector: string): string {
  return entries.find((e) => e.selector === selector)?.css ?? '';
}

/** The entries with the selector's CSS replaced (added at the end; dropped when empty). */
export function setPageCss(entries: PageStyle[], selector: string, css: string): PageStyle[] {
  const empty = css.trim() === '';
  const index = entries.findIndex((e) => e.selector === selector);
  if (index < 0) return empty ? entries : [...entries, { selector, css }];
  return empty ? entries.filter((_, i) => i !== index) : entries.map((e, i) => (i === index ? { selector, css } : e));
}

/** One declaration set (or removed, null) in the block at `path` of the selector's CSS on this page. */
export function setPageDeclaration(entries: PageStyle[], selector: string, path: string[], prop: string, value: string | null): PageStyle[] {
  const css = pageCssOf(entries, selector);
  return setPageCss(entries, selector, setBodyAt(css, path, setDeclaration(bodyAt(css, path), prop, value)));
}

/** The entries as CSS under `scope`, named widths resolved. */
export function pageCss(entries: PageStyle[], queries: Record<string, string>, scope = ':root'): string {
  return resolveNamedQueries(entries.map((e) => compileCss(`${scope} ${e.selector}`, e.css)).join('\n'), queries);
}

/** The selectors an element offers for its look: its static classes, then its id (no `{…}` interpolations). */
export function elementSelectors(attributes: Record<string, unknown> | undefined): string[] {
  const cls = typeof attributes?.class === 'string' ? attributes.class : '';
  const id = typeof attributes?.id === 'string' ? attributes.id : '';
  const ok = (name: string) => /^-?[_a-zA-Z][_a-zA-Z0-9-]{0,99}$/.test(name);
  return [...cls.split(/\s+/).filter(ok).map((c) => '.' + c), ...(ok(id) ? ['#' + id] : [])];
}
