/**
 * Naming rules shared by parser, printer and validators — docs/spec/blocks.md §3.
 */

/** HTML/SVG element tag as written in the DSL: lowercase first letter (uppercase = component). */
export const TAG_PATTERN = /^[a-z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/;

/** Attribute names: conservative subset of the HTML spec (no quotes, braces, slashes, equals). */
export const ATTRIBUTE_NAME_PATTERN = /^[a-zA-Z_:@][a-zA-Z0-9_:.@-]*$/;

const REF_SEGMENT = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*';

/** Component key: `card` or `namespace/card-hero`. Stable across sites (not a post ID). */
export const COMPONENT_REF_PATTERN = new RegExp(`^${REF_SEGMENT}(?:/${REF_SEGMENT})?$`);

export const COMPONENT_TAG_PATTERN = /^[A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)?$/;

export const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The field a grouped query loop groups by (`{#loop foto().groupBy("fields.anno") as gruppo}`, doc 23 of Publish,
 * item 187): a dotted path of keys, as `groupBy` reads it. The same rule in the plugin (Spec::GROUP_BY_FIELD_PATTERN).
 */
export const GROUP_BY_FIELD_PATTERN = /^[A-Za-z0-9_$-]{1,64}(?:\.[A-Za-z0-9_$-]{1,64}){0,7}$/;

/** How a grouped query loop groups: `"letter"` or a date format (`"Y"`, `"F Y"`), as `groupBy` reads it. */
export const GROUP_BY_HOW_PATTERN = /^[^\p{Cc}\p{Cs}]{1,32}$/u;

/** HTML element names, used to reject `<DIV>`-style tags (all caps) that would otherwise read as components. `<Header>` stays a valid component. */
export const HTML_ELEMENTS = new Set(
  (
    'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col ' +
    'colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 ' +
    'h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta ' +
    'meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search ' +
    'section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th ' +
    'thead time title tr track u ul var video wbr'
  ).split(' '),
);

/**
 * Names that are valid by pattern but must never become object keys: assigning `__proto__` changes an object's
 * prototype, and `constructor`/`prototype` read through to Object.prototype when absent.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const SLOT_NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]*$/;

/** `ui/card-hero` → `Ui.CardHero`. */
export function refToTag(ref: string): string {
  return ref
    .split('/')
    .map((segment) =>
      segment
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(''),
    )
    .join('.');
}

/** `Ui.CardHero` → `ui/card-hero`. Inverse of refToTag for every valid ref. */
export function tagToRef(tag: string): string {
  return tag
    .split('.')
    .map((segment) => segment.replace(/(?!^)([A-Z])/g, '-$1').toLowerCase())
    .join('/');
}
