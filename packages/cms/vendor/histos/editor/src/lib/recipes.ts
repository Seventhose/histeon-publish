// The recipes panel (docs/spec/histos-css.md §5): Histeon CSS's CSS recipes in groups, alternative names for the
// same thing, and JavaScript recipes for the document's module. Every recipe is written for Histeon; the alternative
// names are only aliases, so a habit carries over. Pure data and functions: the panel and the editor's completions
// read them, the tests check them.
import { t } from './i18n.ts';

export interface RecipeGroup {
  id: string;
  label: string;
  names: string[];
}

/** Histeon CSS's recipes by group, in the order the panel shows them. A recipe of the site's (ACSS) goes in «Dal sito». */
export const CSS_GROUPS: RecipeGroup[] = [
  { id: 'layout', label: t('Disposizione'), names: ['centra', 'centra-alto', 'centra-basso', 'centra-sinistra', 'centra-destra', 'flex-centro', 'pila', 'fila', 'fila-spaziata', 'griglia-auto', 'griglia-2', 'griglia-3', 'griglia-4', 'griglia-5', 'griglia-6', 'griglia-1-2', 'griglia-2-1', 'griglia-1-3', 'griglia-3-1', 'flex-griglia', 'griglia-contenuto', 'contenitore', 'sezione', 'tutta-larghezza', 'flusso', 'colonne', 'divisori', 'divisori-orizzontali', 'appiccicoso', 'scorri-orizzontale'] },
  { id: 'position', label: t('Posizione e media'), names: ['riempi', 'sfondo-elemento', 'immagine-copri', 'aspetto-video', 'aspetto-quadrato', 'sovrapposizione', 'link-esteso', 'piede-rivelato'] },
  { id: 'text', label: t('Testo'), names: ['tronca', 'tronca-righe', 'bilancia', 'misura', 'testo-gradiente', 'titolo'] },
  { id: 'look', label: t('Sfondi e bordi'), names: ['gradiente-lineare', 'gradiente-radiale', 'gradiente-conico', 'gradiente-netto', 'trasparenza', 'vignetta', 'bordo-gradiente', 'sfuma-basso', 'sfuma-alto', 'sfuma-lati', 'sfuma-bordi', 'raggio-concentrico', 'nastro-angolo'] },
  { id: 'components', label: t('Componenti'), names: ['card', 'solleva', 'vetro', 'divisore', 'pulsante-reset', 'lista-pulita', 'suggerimento'] },
  { id: 'states', label: t('Stati e pseudo-elementi'), names: ['al-passaggio', 'solo-puntatore', 'focus', 'focus-dentro', 'prima', 'dopo'] },
  { id: 'a11y', label: t('Accessibilità e movimento'), names: ['nascosto-accessibile', 'link-salta', 'transizione', 'meno-movimento', 'barra-nascosta'] },
];

/** Alternative recipe names → the Histeon recipe that does the same: `@auto-grid` (or `?auto-grid`) expands too. */
export const RECIPE_ALIASES: Record<string, string> = {
  'auto-grid': 'griglia-auto',
  'center-all': 'centra',
  'center-top': 'centra-alto',
  'center-bottom': 'centra-basso',
  'center-left': 'centra-sinistra',
  'center-right': 'centra-destra',
  'flex-column': 'pila',
  'flex-row': 'fila',
  'flex-grid': 'flex-griglia',
  'grid-1': 'pila',
  'grid-2': 'griglia-2',
  'grid-3': 'griglia-3',
  'grid-4': 'griglia-4',
  'grid-5': 'griglia-5',
  'grid-6': 'griglia-6',
  'grid-1-2': 'griglia-1-2',
  'grid-2-1': 'griglia-2-1',
  'grid-1-3': 'griglia-1-3',
  'grid-3-1': 'griglia-3-1',
  'variable-grid': 'griglia-auto',
  'content-grid': 'griglia-contenuto',
  columns: 'colonne',
  'divider-all': 'divisori',
  'divider-top': 'divisore',
  'line-clamp': 'tronca-righe',
  'gradient-text': 'testo-gradiente',
  'linear-gradient': 'gradiente-lineare',
  'gradient-radial': 'gradiente-radiale',
  'gradient-conic': 'gradiente-conico',
  'gradient-sharp': 'gradiente-netto',
  'gradient-vignette': 'vignetta',
  'gradient-border': 'bordo-gradiente',
  'fade-bottom': 'sfuma-basso',
  'fade-top': 'sfuma-alto',
  'fade-inline': 'sfuma-lati',
  'fade-all': 'sfuma-bordi',
  transparency: 'trasparenza',
  'concentric-radius': 'raggio-concentrico',
  'corner-ribbon': 'nastro-angolo',
  'footer-reveal': 'piede-rivelato',
  'is-bg': 'sfondo-elemento',
  'clickable-parent': 'link-esteso',
  hover: 'al-passaggio',
  'hover-exclude-touch': 'solo-puntatore',
  'focus-visible': 'focus',
  'focus-parent': 'focus-dentro',
  before: 'prima',
  after: 'dopo',
  tooltip: 'suggerimento',
  'skip-link': 'link-salta',
};

/** The recipe a typed name means: its own name, or the Histeon recipe an alternative name stands for. */
export function resolveRecipe(name: string, recipes: Record<string, string>): string | null {
  if (Object.hasOwn(recipes, name)) return name;
  const alias = RECIPE_ALIASES[name];
  return alias !== undefined && Object.hasOwn(recipes, alias) ? alias : null;
}

/** The panel's CSS groups for the recipes this site has: Histeon's in order, then the site's own («Dal sito»). */
export function cssGroups(recipes: Record<string, string>): RecipeGroup[] {
  const known = new Set(CSS_GROUPS.flatMap((g) => g.names));
  const groups = CSS_GROUPS.map((g) => ({ ...g, names: g.names.filter((n) => Object.hasOwn(recipes, n)) })).filter((g) => g.names.length > 0);
  const site = Object.keys(recipes).filter((n) => !known.has(n)).sort();
  return site.length ? [...groups, { id: 'site', label: t('Dal sito'), names: site }] : groups;
}

/** What a filter keeps: the name, an alternative name of it, or words of the code. */
export function recipeMatches(name: string, css: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.includes(q) || css.toLowerCase().includes(q)) return true;
  return Object.entries(RECIPE_ALIASES).some(([alias, target]) => target === name && alias.includes(q));
}

/** Which sample the preview shows a recipe on: children for layouts, a paragraph for text, a picture for media. */
export type Sample = 'children' | 'text' | 'media' | 'box' | 'button';

export function sampleFor(name: string, css: string): Sample {
  if (/^(tronca|bilancia|misura|testo-gradiente|titolo|colonne)/.test(name)) return 'text';
  if (/^(immagine-copri|aspetto|riempi|sfondo-elemento|sfuma|vignetta)/.test(name)) return 'media';
  if (/^(pulsante|link-salta|suggerimento|focus|al-passaggio|solo-puntatore)/.test(name)) return 'button';
  if (/display:\s*(grid|flex)|columns:|& > \*/.test(css)) return 'children';
  return 'box';
}

const SAMPLES: Record<Sample, string> = {
  children: '<div class="r"><div>1</div><div>2</div><div>3</div><div>4</div></div>',
  text: '<p class="r">Il testo di esempio della ricetta, abbastanza lungo da andare a capo e mostrare cosa cambia: misura, righe, colore e taglio.</p>',
  media: '<div class="r media"><div class="foto"></div></div>',
  box: '<div class="r">Contenuto</div>',
  button: '<button class="r" type="button" data-suggerimento="Suggerimento">Pulsante</button>',
};

/**
 * The preview document of a CSS recipe: a sample styled by it, without scripts (the frame is sandboxed and its CSP
 * forbids them). `compiled` is the recipe's CSS already compiled for `.r` (compileCss), nesting included.
 */
export function previewDocument(sample: Sample, compiled: string): string {
  const base =
    ':root{--xb-primary:#3f4bc4;--xb-accent:#e0603a;--xb-bg:#fff;--xb-text:#1b1d2a}' +
    'body{margin:0;padding:14px;font:13px/1.4 system-ui,sans-serif;color:#1b1d2a;background:#fff}' +
    '.r{min-block-size:56px;background:#eef0fb;border:1px dashed #9aa1e0;position:relative}' +
    '.r>div{padding:8px;background:#3f4bc4;color:#fff;border-radius:4px;text-align:center}' +
    '.media{block-size:110px;overflow:hidden}.foto{position:absolute;inset:0;background:linear-gradient(135deg,#e0603a,#3f4bc4)}' +
    'button.r{padding:8px 14px;border-radius:6px;font:inherit}';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${base}</style><style>${compiled}</style></head><body>${SAMPLES[sample]}</body></html>`;
}

/**
 * A JavaScript recipe for the document's module. `{selector}` in the code becomes the selector the recipe is for
 * (the selected element's class); `css` goes with it, into that selector's CSS, when the effect needs styles; `demo`
 * shows the effect in the preview with CSS alone (the preview runs no script).
 */
export interface JsRecipe {
  name: string;
  label: string;
  description: string;
  code: string;
  css?: string;
  demo: { html: string; css: string };
}

export const JS_RECIPES: JsRecipe[] = [
  {
    name: 'compari-scorrendo',
    label: t('Compare scorrendo'),
    description: t('L’elemento entra con una dissolvenza quando arriva nella finestra. Chi preferisce meno movimento lo vede subito.'),
    code: "// Compare scorrendo: {selector}\nfor (const el of document.querySelectorAll('{selector}')) {\n  const io = new IntersectionObserver((entries) => {\n    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visibile'); io.unobserve(entry.target); }\n  }, { rootMargin: '0px 0px -10% 0px' });\n  io.observe(el);\n}\n",
    css: '@media (prefers-reduced-motion: no-preference) {\n  & {\n    opacity: 0;\n    translate: 0 1.5rem;\n    transition: opacity 600ms ease, translate 600ms ease;\n  }\n  &.is-visibile {\n    opacity: 1;\n    translate: 0 0;\n  }\n}',
    demo: { html: '<div class="r">Compare</div>', css: '.r{animation:entra 1.6s ease infinite}@keyframes entra{0%{opacity:0;translate:0 20px}40%,100%{opacity:1;translate:0 0}}' },
  },
  {
    name: 'conta',
    label: t('Numero che conta'),
    description: t('Un numero (il testo dell’elemento) sale da zero quando si vede. Il valore resta nel markup, quindi senza JavaScript si legge lo stesso.'),
    code: "// Numero che conta: {selector}\nfor (const el of document.querySelectorAll('{selector}')) {\n  const target = Number(el.textContent.replace(/[^\\d.]/g, ''));\n  if (!Number.isFinite(target) || matchMedia('(prefers-reduced-motion: reduce)').matches) continue;\n  const io = new IntersectionObserver(([entry]) => {\n    if (!entry.isIntersecting) return;\n    io.disconnect();\n    const start = performance.now();\n    const step = (now) => {\n      const p = Math.min(1, (now - start) / 1200);\n      el.textContent = Math.round(target * p).toLocaleString();\n      if (p < 1) requestAnimationFrame(step);\n    };\n    requestAnimationFrame(step);\n  });\n  io.observe(el);\n}\n",
    demo: { html: '<div class="r num"></div>', css: '.num{font:700 28px system-ui;counter-reset:n var(--n);animation:conta 1.6s steps(20) infinite}.num::after{content:counter(n)}@property --n{syntax:"<integer>";initial-value:0;inherits:false}@keyframes conta{to{--n:250}}' },
  },
  {
    name: 'intestazione-compatta',
    label: t('Intestazione che si riduce'),
    description: t('Quando la pagina scorre, l’elemento riceve la classe is-ridotta, da usare nel CSS per rimpicciolirlo.'),
    code: "// Intestazione che si riduce: {selector}\nconst testata = document.querySelector('{selector}');\nif (testata) {\n  const sentinel = document.createElement('div');\n  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px';\n  document.body.prepend(sentinel);\n  new IntersectionObserver(([entry]) => testata.classList.toggle('is-ridotta', !entry.isIntersecting)).observe(sentinel);\n}\n",
    css: 'position: sticky;\ninset-block-start: 0;\ntransition: padding 200ms ease;\n&.is-ridotta {\n  padding-block: var(--xb-space-xs, 0.5rem);\n}',
    demo: { html: '<div class="r testa">Intestazione</div>', css: '.testa{animation:riduci 2s ease infinite alternate}@keyframes riduci{from{padding:22px}to{padding:4px}}' },
  },
  {
    name: 'torna-su',
    label: t('Pulsante «torna su»'),
    description: t('Il pulsante compare dopo un po’ di scorrimento e riporta all’inizio della pagina.'),
    code: "// Torna su: {selector}\nconst su = document.querySelector('{selector}');\nif (su) {\n  const toggle = () => su.toggleAttribute('hidden', scrollY < 600);\n  addEventListener('scroll', toggle, { passive: true });\n  toggle();\n  su.addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));\n}\n",
    css: 'position: fixed;\ninset-block-end: var(--xb-space-m, 1rem);\ninset-inline-end: var(--xb-space-m, 1rem);',
    demo: { html: '<button class="r" type="button">↑</button>', css: '.r{animation:mostra 2s ease infinite}@keyframes mostra{0%,30%{opacity:0}60%,100%{opacity:1}}' },
  },
  {
    name: 'apri-chiudi',
    label: t('Apri e chiudi'),
    description: t('Un pulsante dentro l’elemento apre e chiude il blocco con aria-controls; aria-expanded resta giusto per chi usa un lettore di schermo.'),
    code: "// Apri e chiudi: {selector} (il pulsante ha aria-controls con l’id del blocco)\nfor (const button of document.querySelectorAll('{selector} [aria-controls]')) {\n  const panel = document.getElementById(button.getAttribute('aria-controls'));\n  if (!panel) continue;\n  button.setAttribute('aria-expanded', String(!panel.hidden));\n  button.addEventListener('click', () => {\n    panel.hidden = !panel.hidden;\n    button.setAttribute('aria-expanded', String(!panel.hidden));\n  });\n}\n",
    demo: { html: '<div class="r"><button type="button">Apri ▾</button><p class="p">Contenuto</p></div>', css: '.p{margin:6px 0 0;animation:apri 2s steps(1) infinite}@keyframes apri{50%{display:none}}' },
  },
  {
    name: 'scorrimento-ancore',
    label: t('Scorrimento morbido alle ancore'),
    description: t('I link #ancora dentro l’elemento scorrono morbidi fino al punto, e il fuoco ci arriva.'),
    code: "// Scorrimento morbido alle ancore: {selector}\nfor (const link of document.querySelectorAll('{selector} a[href^=\"#\"]')) {\n  link.addEventListener('click', (event) => {\n    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));\n    if (!target) return;\n    event.preventDefault();\n    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });\n    target.focus({ preventScroll: true });\n    history.pushState(null, '', link.hash);\n  });\n}\n",
    demo: { html: '<div class="r scorri"><div>#1</div><div>#2</div><div>#3</div></div>', css: '.scorri{display:grid;gap:4px;animation:scorri 2.4s ease infinite}@keyframes scorri{50%{translate:0 -24px}}' },
  },
  {
    name: 'anno-corrente',
    label: t('Anno corrente'),
    description: t('Scrive l’anno di oggi nell’elemento, per il «©» del piè di pagina.'),
    code: "// Anno corrente: {selector}\nfor (const el of document.querySelectorAll('{selector}')) el.textContent = String(new Date().getFullYear());\n",
    demo: { html: '<p class="r">© <b>2026</b> Il tuo sito</p>', css: '' },
  },
  {
    name: 'link-esterni',
    label: t('Link esterni in una nuova scheda'),
    description: t('I link ad altri siti dentro l’elemento si aprono in una nuova scheda, con rel="noopener" e un avviso per i lettori di schermo.'),
    code: "// Link esterni: {selector}\nfor (const link of document.querySelectorAll('{selector} a[href^=\"http\"]')) {\n  if (link.host === location.host) continue;\n  link.target = '_blank';\n  link.rel = 'noopener';\n  const note = document.createElement('span');\n  note.textContent = ' (si apre in una nuova scheda)';\n  note.style.cssText = 'position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';\n  link.append(note);\n}\n",
    demo: { html: '<p class="r">Vai su <a href="#">un altro sito ↗</a></p>', css: '' },
  },
];

/** The code a JS recipe adds for this selector. The selector is the element's class, so it never needs escaping in a string. */
export function jsRecipeCode(recipe: JsRecipe, selector: string): string {
  return recipe.code.replaceAll('{selector}', selector);
}

/** The preview document of a JS recipe: its demo, CSS only. */
export function jsPreviewDocument(recipe: JsRecipe): string {
  const base = 'body{margin:0;padding:14px;font:13px/1.4 system-ui,sans-serif;color:#1b1d2a;background:#fff}.r{padding:10px;background:#eef0fb;border:1px dashed #9aa1e0;border-radius:6px}.r>div{padding:6px;background:#3f4bc4;color:#fff;border-radius:4px}';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${base}${recipe.demo.css}</style></head><body>${recipe.demo.html}</body></html>`;
}
