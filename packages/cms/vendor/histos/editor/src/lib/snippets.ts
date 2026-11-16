/** Starting points for the insert palette, written in the DSL (docs/spec/dsl.md). */
import { t } from './i18n.ts';

export interface Snippet {
  /** Stable name (the Italian label): ids of commands and shortcuts, icons. */
  key: string;
  /** Label in the user's language. */
  label: string;
  dsl: string;
  /** Insert palette group (default: Elementi). */
  group?: 'Elementi' | 'Interazioni';
  /** Own CSS for its BEM classes, added only where the site has none yet (Histeon tokens, any framework). */
  styles?: Array<[string, string]>;
}

/** The groups of the + menu, in the order it shows them. */
export const INSERT_GROUPS = ['Elementi', 'Interazioni', 'Media', 'Componenti', 'Moduli', 'Blocchi PHP del sito'] as const;
export type InsertGroup = (typeof INSERT_GROUPS)[number];

/**
 * The menu's items by group, in that order, empty groups left out. `visible` is the same items in the order they
 * are drawn: the one the arrow keys and Enter follow, so they never land on an item the menu does not show.
 */
export function groupInOrder<T extends { group: InsertGroup }>(items: T[]): { groups: Array<{ name: InsertGroup; items: T[] }>; visible: T[] } {
  const groups = INSERT_GROUPS.map((name) => ({ name, items: items.filter((i) => i.group === name) })).filter((g) => g.items.length > 0);
  return { groups, visible: groups.flatMap((g) => g.items) };
}

/** The snippet ready to insert: `__ID__` becomes `id`, so ids (tabs, menus) are unique on the page. */
export function prepareSnippet(snippet: Snippet, id: string): { dsl: string; styles: Array<[string, string]> } {
  return { dsl: snippet.dsl.replaceAll('__ID__', id), styles: snippet.styles ?? [] };
}

const FOCUS = 'outline: 2px solid var(--xb-primary, currentColor);\n  outline-offset: 2px;';

/** Interactions without code (docs/spec/interactions.md): ARIA patterns, usable without JavaScript too. */
export const INTERACTIONS: Snippet[] = [
  {
    key: 'Schede',
    label: t('Schede'),
    group: 'Interazioni',
    dsl: `<div class="tabs" data-xb-tabs>
  <div class="tabs__list" role="tablist" aria-label="${t('Schede')}">
    <button class="tabs__tab" type="button" role="tab" id="tab-__ID__-1" aria-controls="panel-__ID__-1" aria-selected="true">${t('Prima')}</button>
    <button class="tabs__tab" type="button" role="tab" id="tab-__ID__-2" aria-controls="panel-__ID__-2" aria-selected="false">${t('Seconda')}</button>
  </div>
  <div class="tabs__panel" role="tabpanel" id="panel-__ID__-1" aria-labelledby="tab-__ID__-1">
    <p>${t('Contenuto della prima scheda.')}</p>
  </div>
  <div class="tabs__panel" role="tabpanel" id="panel-__ID__-2" aria-labelledby="tab-__ID__-2">
    <p>${t('Contenuto della seconda scheda.')}</p>
  </div>
</div>`,
    styles: [
      ['.tabs', 'display: grid;\ngap: var(--xb-space-s, 1rem);'],
      ['.tabs__list', 'display: flex;\nflex-wrap: wrap;\ngap: var(--xb-space-2xs, 0.25rem);\nborder-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);'],
      ['.tabs__tab', `font: inherit;\npadding: var(--xb-space-xs, 0.5rem) var(--xb-space-s, 1rem);\nborder: 0;\nborder-bottom: 2px solid transparent;\nbackground: none;\ncolor: inherit;\ncursor: pointer;\n&[aria-selected="true"] {\n  border-bottom-color: var(--xb-primary, currentColor);\n  font-weight: 600;\n}\n&:focus-visible {\n  ${FOCUS}\n}`],
    ],
  },
  {
    key: 'Fisarmonica',
    label: t('Fisarmonica'),
    group: 'Interazioni',
    // Native <details name>: one open at a time, keyboard and screen readers included, no script.
    dsl: `<div class="accordion">
  <details class="accordion__item" name="accordion-__ID__" open>
    <summary class="accordion__title">${t('Prima domanda')}</summary>
    <div class="accordion__body">
      <p>${t('La risposta alla prima domanda.')}</p>
    </div>
  </details>
  <details class="accordion__item" name="accordion-__ID__">
    <summary class="accordion__title">${t('Seconda domanda')}</summary>
    <div class="accordion__body">
      <p>${t('La risposta alla seconda domanda.')}</p>
    </div>
  </details>
</div>`,
    styles: [
      ['.accordion', 'display: grid;\ngap: var(--xb-space-xs, 0.5rem);'],
      ['.accordion__item', 'border: 1px solid color-mix(in srgb, currentColor 18%, transparent);\nborder-radius: var(--xb-radius-m, 0.5rem);'],
      ['.accordion__title', `padding: var(--xb-space-s, 1rem);\nfont-weight: 600;\ncursor: pointer;\n&:focus-visible {\n  ${FOCUS}\n}`],
      ['.accordion__body', 'padding: 0 var(--xb-space-s, 1rem) var(--xb-space-s, 1rem);'],
    ],
  },
  {
    key: 'Menu mobile',
    label: t('Menu mobile'),
    group: 'Interazioni',
    dsl: `<nav class="site-nav" aria-label="${t('Principale')}">
  <button class="site-nav__toggle" type="button" data-xb-toggle aria-controls="menu-__ID__" aria-expanded="false">${t('Menu')}</button>
  <ul class="site-nav__menu" id="menu-__ID__">
    <li><a href="/">${t('Home')}</a></li>
    <li><a href="/chi-siamo/">${t('Chi siamo')}</a></li>
    <li><a href="/contatti/">${t('Contatti')}</a></li>
  </ul>
</nav>`,
    styles: [
      ['.site-nav', 'display: flex;\nflex-wrap: wrap;\nalign-items: center;\ngap: var(--xb-space-s, 1rem);'],
      ['.site-nav__toggle', `display: none;\nfont: inherit;\npadding: var(--xb-space-xs, 0.5rem) var(--xb-space-s, 1rem);\nborder: 1px solid currentColor;\nborder-radius: var(--xb-radius-s, 0.25rem);\nbackground: none;\ncolor: inherit;\ncursor: pointer;\n&:focus-visible {\n  ${FOCUS}\n}\n@media (width <= 48rem) {\n  display: inline-block;\n}`],
      ['.site-nav__menu', 'display: flex;\nflex-wrap: wrap;\ngap: var(--xb-space-s, 1rem);\nmargin: 0;\npadding: 0;\nlist-style: none;\n@media (width <= 48rem) {\n  flex-basis: 100%;\n  flex-direction: column;\n  .xb-js &:not([data-open]) {\n    display: none;\n  }\n}'],
    ],
  },
  {
    key: 'Selettore di lingua',
    label: t('Selettore di lingua'),
    group: 'Interazioni',
    // data.lingua comes from a language plugin (Lingua Bridge): without it, nothing is drawn.
    dsl: `{#if data.lingua.alternates.length() > 1}
  <nav class="lang-switch" aria-label="${t('Lingua')}">
    <ul class="lang-switch__list">
      {#loop data.lingua.alternates as lang}
        <li><a class="lang-switch__link" href={lang.url} hreflang={lang.code} lang={lang.code} aria-current={lang.current ? "page" : null}>{lang.code.upper()}</a></li>
      {/loop}
    </ul>
  </nav>
{/if}`,
    styles: [
      ['.lang-switch__list', 'display: flex;\ngap: var(--xb-space-xs, 0.5rem);\nmargin: 0;\npadding: 0;\nlist-style: none;'],
      ['.lang-switch__link', `display: inline-block;\npadding: 0.25em 0.5em;\nborder-radius: var(--xb-radius-s, 0.25rem);\ncolor: inherit;\nfont-weight: 600;\ntext-decoration: none;\n&[aria-current="page"] {\n  background: color-mix(in srgb, currentColor 12%, transparent);\n}\n&:focus-visible {\n  ${FOCUS}\n}`],
    ],
  },
  {
    key: 'Comparsa allo scorrimento',
    label: t('Comparsa allo scorrimento'),
    group: 'Interazioni',
    dsl: `<div class="reveal" data-xb-reveal>
  <h2>${t('Un titolo che compare')}</h2>
  <p>${t('Questo blocco compare quando entra nello schermo; con il movimento ridotto è subito visibile.')}</p>
</div>`,
  },
];

export const SNIPPETS: Snippet[] = [
  { key: 'Sezione',
    label: t('Sezione'), dsl: '<section class="section">\n  <div class="container"></div>\n</section>' },
  { key: 'Contenitore',
    label: t('Contenitore'), dsl: '<div></div>' },
  { key: 'Titolo',
    label: t('Titolo'), dsl: `<h2>${t('Titolo')}</h2>` },
  { key: 'Paragrafo',
    label: t('Paragrafo'), dsl: `<p>${t('Testo')}</p>` },
  { key: 'Link',
    label: t('Link'), dsl: `<a href="/">${t('Link')}</a>` },
  { key: 'Pulsante',
    label: t('Pulsante'), dsl: `<a class="btn" href="/">${t('Pulsante')}</a>` },
  { key: 'Immagine',
    label: t('Immagine'), dsl: '<img src="" alt="">' },
  { key: 'Lista',
    label: t('Lista'), dsl: `<ul>\n  <li>${t('Elemento')}</li>\n</ul>` },
  { key: 'Condizione',
    label: t('Condizione'), dsl: '{#if this.title}\n  <p>{this.title}</p>\n{/if}' },
  { key: 'Loop di articoli',
    label: t('Loop di articoli'), dsl: '{#loop posts(limit: 3) as post}\n  <article>\n    <h3><a href={post.url}>{post.title}</a></h3>\n  </article>\n{/loop}' },
  { key: 'Slot (nei componenti)',
    label: t('Slot (nei componenti)'), dsl: '{@slot}' },
  { key: 'Contenuto del post',
    label: t('Contenuto del post'), dsl: '{@content}' },
];
