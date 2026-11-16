// The options of the Histeon CSS panel (histos-publish doc 19 §5.3), declared once: the panel draws its sections
// from this list, in the builder and in the drawer over the site. Labels are Italian (through t()); `en` holds the
// English words a search also finds («line height» finds «Interlinea»). Limits match DesignData::LIMITS (tested).

import type { DesignParams } from '../lib/api.ts';

export type SectionId = 'colors' | 'text' | 'space' | 'shape' | 'details' | 'fonts' | 'recipes';

/** Where an option sits in its section: colours (families, palette, roles, dark theme), text (headings, levels, body). */
export type ColorGroup = 'families' | 'palette' | 'roles' | 'dark' | 'headings' | 'levels' | 'body' | 'sections' | 'gaps' | 'layout' | 'border' | 'buttons' | 'links' | 'forms' | 'access' | 'motion' | 'cards' | 'icons' | 'advanced' | 'steps' | 'surfaces' | 'shadows' | 'defaults';

interface Base {
  key: string;
  section: SectionId;
  /** Italian label, translated by the panel with t(). */
  label: string;
  /** An Italian frame for the label (`{0}, tema scuro`), translated too. */
  format?: string;
  /** English words for the search. */
  en: string;
  group?: ColorGroup;
}
/** A colour; `optional`: '' is allowed and means automatic. */
export interface ColorOption extends Base { kind: 'color'; optional?: boolean }
export interface NumberOption extends Base { kind: 'number'; min: number; max: number; step: number }
export interface FontOption extends Base { kind: 'font'; optional?: boolean }
/** 0 or 1. */
export interface ToggleOption extends Base { kind: 'toggle' }
/** One of a list: [value, Italian label]. */
export interface ChoiceOption extends Base { kind: 'choice'; choices: Array<[string, string]> }
/** A short free text, checked by the server. */
export interface TextOption extends Base { kind: 'text' }
/** A colour role: auto, white, black, a family or one of its shades. */
export interface RoleOption extends Base { kind: 'role' }
export type PanelOption = ColorOption | NumberOption | FontOption | ToggleOption | ChoiceOption | RoleOption | TextOption;

/** The sections, in the order of the tabs; labels translated by the panel. */
export const SECTIONS: Array<[SectionId, string]> = [
  ['colors', 'Colori'],
  ['text', 'Testo'],
  ['space', 'Spazi'],
  ['shape', 'Forme'],
  ['details', 'Moduli e dettagli'],
  ['fonts', 'Caratteri'],
  ['recipes', 'Ricette'],
];

const color = (key: string, label: string, en: string): ColorOption => ({ kind: 'color', key, section: 'colors', label, en, group: 'families' });
const toggle = (key: string, label: string, en: string, group: ColorGroup, format?: string): ToggleOption => ({ kind: 'toggle', key, section: 'colors', label, en, group, ...(format ? { format } : {}) });

/** The colour families, in the order of the palette; those with a switch. */
export const FAMILY_LABELS: Array<[string, string, string]> = [
  ['primary', 'Primario', 'primary brand'],
  ['secondary', 'Secondario', 'secondary brand'],
  ['tertiary', 'Terziario', 'tertiary third brand'],
  ['accent', 'Accento', 'accent'],
  ['neutral', 'Neutro', 'neutral grey gray'],
  ['success', 'Successo', 'success state'],
  ['warning', 'Avviso', 'warning state'],
  ['danger', 'Pericolo', 'danger error state'],
  ['info', 'Informazione', 'info information state'],
];
export const SWITCHABLE = ['secondary', 'tertiary', 'accent', 'success', 'warning', 'danger', 'info'];

/** The colour roles: name, Italian label, English words. */
export const ROLES: Array<[string, string, string]> = [
  ['bg', 'Sfondo', 'background page'],
  ['surface', 'Superficie', 'surface background card'],
  ['surface-2', 'Superficie 2', 'surface second background'],
  ['text', 'Testo', 'text body colour'],
  ['text-muted', 'Testo secondario', 'muted secondary text'],
  ['heading', 'Titoli', 'heading headings colour'],
  ['border', 'Bordo', 'border colour'],
  ['link', 'Link', 'link colour'],
  ['link-hover', 'Link al passaggio', 'link hover colour'],
  ['focus', 'Focus', 'focus ring colour'],
];
export const roleKey = (role: string, dark = false) => `role_${role.replace(/-/g, '_')}${dark ? '_dark' : ''}`;
const role = (name: string, label: string, en: string, dark: boolean): RoleOption => ({
  kind: 'role', key: roleKey(name, dark), section: 'colors', label, en: `${en} role${dark ? ' dark theme mode' : ''}`, group: dark ? 'dark' : 'roles', ...(dark ? { format: '{0}, tema scuro' } : {}),
});
const number = (section: SectionId, key: string, label: string, en: string, min: number, max: number, step: number): NumberOption => ({ kind: 'number', key, section, label, en, min, max, step, ...(section === 'colors' ? { group: 'palette' as const } : {}) });
const font = (key: string, label: string, en: string, optional = false): FontOption => ({ kind: 'font', key, section: 'fonts', label, en, ...(optional ? { optional } : {}) });
const typo = (group: ColorGroup, key: string, label: string, en: string, min: number, max: number, step: number, format?: string): NumberOption => ({ kind: 'number', key, section: 'text', group, label, en, min, max, step, ...(format ? { format } : {}) });
const choice = (group: ColorGroup, key: string, label: string, en: string, choices: Array<[string, string]>): ChoiceOption => ({ kind: 'choice', key, section: 'text', group, label, en, choices });
const WRAPS: Array<[string, string]> = [['wrap', 'Normale'], ['balance', 'Bilanciato'], ['pretty', 'Curato']];
const LEVELS = [1, 2, 3, 4, 5, 6];

/** The steps the panel previews. */
export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export const ALPHAS = [10, 20, 30, 40, 50, 60, 70, 80, 90] as const;
export const TEXT_STEPS = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl'] as const;
export const SPACE_STEPS = ['3xs', '2xs', 'xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl'] as const;

export const OPTIONS: PanelOption[] = [
  ...FAMILY_LABELS.map(([key, label, en]) => color(key, label, `${en} colour color`)),
  ...FAMILY_LABELS.filter(([key]) => SWITCHABLE.includes(key)).map(([key, label, en]) => toggle(`${key}_on`, label, `${en} on off enable switch`, 'families', '{0}: attivo')),
  toggle('brand_lightness_on', 'Luminosità unica per il marchio', 'unify brand lightness', 'palette'),
  number('colors', 'brand_lightness', 'Luminosità del marchio', 'brand lightness oklch', 0.3, 0.85, 0.01),
  toggle('state_lightness_on', 'Luminosità unica per gli stati', 'unify state semantic lightness', 'palette'),
  number('colors', 'state_lightness', 'Luminosità degli stati', 'state semantic lightness oklch', 0.3, 0.85, 0.01),
  { kind: 'choice', key: 'hover_shade', section: 'colors', group: 'palette', label: 'Sfumatura al passaggio', en: 'hover shade colour', choices: ['400', '500', '600', '700', '800'].map((v) => [v, v]) },
  toggle('auto_contrast', 'Relazioni automatiche di contrasto', 'automatic colour relationships contrast readable', 'roles'),
  ...ROLES.map(([name, label, en]) => role(name, label, en, false)),
  toggle('dark_on', 'Tema scuro', 'dark theme mode scheme enable', 'dark'),
  { kind: 'choice', key: 'scheme', section: 'colors', group: 'dark', label: 'Schema del sito', en: 'website colour scheme light dark system prefers', choices: [['light', 'Solo chiaro'], ['dark', 'Solo scuro'], ['system', 'Segue il sistema']] },
  { kind: 'choice', key: 'dark_hover_shade', section: 'colors', group: 'dark', label: 'Sfumatura al passaggio, tema scuro', en: 'dark theme hover shade', choices: ['200', '300', '400', '500'].map((v) => [v, v]) },
  ...ROLES.map(([name, label, en]) => role(name, label, en, true)),
  ...FAMILY_LABELS.map(([key, label, en]): ColorOption => ({ kind: 'color', key: `${key}_dark`, section: 'colors', label, format: '{0}, tema scuro', en: `${en} dark theme colour color`, group: 'dark', optional: true })),
  number('text', 'text_min', 'Testo base, schermo piccolo (px)', 'base text size small screen mobile font size', 10, 32, 0.5),
  number('text', 'text_max', 'Testo base, schermo grande (px)', 'base text size large screen desktop font size', 10, 40, 0.5),
  number('text', 'text_ratio_min', 'Rapporto della scala, piccolo', 'type scale ratio small screen mobile', 1, 2, 0.01),
  number('text', 'text_ratio_max', 'Rapporto della scala, grande', 'type scale ratio large screen desktop', 1, 2, 0.01),
  number('space', 'space_min', 'Spazio base, schermo piccolo (px)', 'base spacing space small screen mobile', 4, 64, 1),
  number('space', 'space_max', 'Spazio base, schermo grande (px)', 'base spacing space large screen desktop', 4, 96, 1),
  number('space', 'space_ratio_min', 'Rapporto degli spazi, piccolo', 'spacing scale ratio small screen mobile', 1, 2.5, 0.01),
  number('space', 'space_ratio_max', 'Rapporto degli spazi, grande', 'spacing scale ratio large screen desktop', 1, 2.5, 0.01),
  number('space', 'viewport_min', 'Schermo piccolo (px)', 'minimum viewport small screen breakpoint', 240, 1200, 10),
  number('space', 'viewport_max', 'Schermo grande (px)', 'maximum viewport large screen breakpoint', 600, 3840, 10),
  number('shape', 'radius', 'Raggio medio (px)', 'border radius corners rounded', 0, 64, 1),
  number('shape', 'radius_ratio', 'Rapporto della scala dei raggi (0 = i raggi di partenza)', 'radius scale ratio', 0, 3, 0.05),
  ...[...['s', 'm', 'l', 'xl', '2xl'].map((step) => [`shadow_${step}`, `Ombra ${step}`] as const), ...['s', 'm', 'l'].map((step) => [`tshadow_${step}`, `Ombra del testo ${step}`] as const)].flatMap(([name, title]): NumberOption[] => [
    { kind: 'number', key: `${name}_y`, section: 'shape', group: 'shadows', label: 'Distanza (px)', format: `${title}: {0}`, en: `${name.replace('_', ' ')} box text shadow offset`, min: 0, max: 100, step: 1 },
    { kind: 'number', key: `${name}_blur`, section: 'shape', group: 'shadows', label: 'Sfocatura (px)', format: `${title}: {0}`, en: `${name.replace('_', ' ')} box text shadow blur`, min: 0, max: 200, step: 1 },
    { kind: 'number', key: `${name}_opacity`, section: 'shape', group: 'shadows', label: 'Opacità', format: `${title}: {0}`, en: `${name.replace('_', ' ')} box text shadow opacity`, min: 0, max: 1, step: 0.01 },
  ]),
  number('shape', 'width_content', 'Larghezza dei contenuti (rem)', 'content width container', 30, 160, 1),
  number('shape', 'width_wide', 'Larghezza ampia (rem)', 'wide width container', 30, 200, 1),
  number('shape', 'width_prose', 'Misura del testo (ch)', 'prose width measure line length', 30, 120, 1),
  { kind: 'toggle', key: 'heading_scale_on', section: 'text', group: 'headings', label: 'Scala dei titoli separata', en: 'separate heading headings scale' },
  typo('headings', 'heading_min', 'Titoli, base schermo piccolo (px)', 'heading base size small screen mobile', 10, 48, 0.5),
  typo('headings', 'heading_max', 'Titoli, base schermo grande (px)', 'heading base size large screen desktop', 10, 64, 0.5),
  typo('headings', 'heading_ratio_min', 'Rapporto dei titoli, piccolo', 'heading scale ratio small', 1, 2, 0.01),
  typo('headings', 'heading_ratio_max', 'Rapporto dei titoli, grande', 'heading scale ratio large', 1, 2, 0.01),
  { kind: 'toggle', key: 'headings_on', section: 'text', group: 'headings', label: 'Stili predefiniti dei titoli (h1-h6)', en: 'default heading styles elements h1 h2 h3' },
  choice('headings', 'heading_font', 'Carattere dei titoli', 'heading font family typeface', [['body', 'Testo'], ['heading', 'Titoli'], ['mono', 'Codice'], ['accent', 'Accento'], ['display', 'Display']]),
  typo('headings', 'heading_weight', 'Peso dei titoli', 'heading font weight bold', 100, 900, 100),
  typo('headings', 'heading_leading', 'Interlinea dei titoli', 'heading line height', 0.8, 2.5, 0.01),
  typo('headings', 'heading_tracking', 'Spaziatura delle lettere dei titoli (em)', 'heading letter spacing tracking', -0.1, 0.3, 0.005),
  choice('headings', 'heading_case', 'Maiuscole dei titoli', 'heading text transform uppercase case', [['none', 'Come scritte'], ['uppercase', 'Tutte maiuscole'], ['lowercase', 'Tutte minuscole'], ['capitalize', 'Iniziali maiuscole']]),
  { kind: 'toggle', key: 'heading_italic', section: 'text', group: 'headings', label: 'Titoli in corsivo', en: 'heading italic font style' },
  choice('headings', 'heading_wrap', 'A capo dei titoli', 'heading text wrap balance pretty', WRAPS),
  typo('headings', 'heading_measure', 'Larghezza massima dei titoli (ch)', 'heading max width measure', 0, 120, 1),
  ...LEVELS.flatMap((n) => [
    typo('levels', `h${n}_weight`, 'Peso', `h${n} heading level font weight`, 0, 900, 100, `H${n}: {0}`),
    typo('levels', `h${n}_leading`, 'Interlinea', `h${n} heading level line height`, 0, 2.5, 0.01, `H${n}: {0}`),
    typo('levels', `h${n}_tracking`, 'Spaziatura delle lettere (em)', `h${n} heading level letter spacing tracking`, -0.1, 0.3, 0.005, `H${n}: {0}`),
    typo('levels', `h${n}_measure`, 'Larghezza massima (ch, 0 = nessuna)', `h${n} heading level max width measure`, 0, 120, 1, `H${n}: {0}`),
  ]),
  ...LEVELS.flatMap((n): PanelOption[] => [
    { kind: 'choice', key: `h${n}_color`, section: 'text', group: 'levels', label: 'Colore', format: `H${n}: {0}`, en: `h${n} heading level colour`, choices: [['auto', 'Come tutti'], ['heading', 'Titoli'], ['text', 'Testo'], ['text-muted', 'Testo secondario'], ['primary', 'Primario'], ['secondary', 'Secondario'], ['accent', 'Accento']] },
    { kind: 'choice', key: `h${n}_font`, section: 'text', group: 'levels', label: 'Carattere', format: `H${n}: {0}`, en: `h${n} heading level font family`, choices: [['auto', 'Come tutti'], ['body', 'Testo'], ['heading', 'Titoli'], ['mono', 'Codice'], ['accent', 'Accento'], ['display', 'Display']] },
    { kind: 'choice', key: `h${n}_wrap`, section: 'text', group: 'levels', label: 'A capo', format: `H${n}: {0}`, en: `h${n} heading level text wrap balance pretty`, choices: [['auto', 'Come tutti'], ...WRAPS] },
    { kind: 'choice', key: `h${n}_case`, section: 'text', group: 'levels', label: 'Maiuscole', format: `H${n}: {0}`, en: `h${n} heading level text transform case`, choices: [['auto', 'Come tutti'], ['none', 'Come scritte'], ['uppercase', 'Tutte maiuscole'], ['lowercase', 'Tutte minuscole'], ['capitalize', 'Iniziali maiuscole']] },
  ]),
  ...[...TEXT_STEPS.map((step) => [`text_${step}`, `Testo ${step}`] as const), ...LEVELS.map((n) => [`h${n}`, `H${n}`] as const)].flatMap(([step, name]): NumberOption[] => [
    { kind: 'number', key: `size_${step}_min`, section: 'text', group: 'steps', label: 'Misura, schermo piccolo (px)', format: `${name}: {0}`, en: `${step.replace('_', ' ')} own size override small screen`, min: 0, max: 200, step: 0.5 },
    { kind: 'number', key: `size_${step}_max`, section: 'text', group: 'steps', label: 'Misura, schermo grande (px)', format: `${name}: {0}`, en: `${step.replace('_', ' ')} own size override large screen`, min: 0, max: 200, step: 0.5 },
  ]),
  ...TEXT_STEPS.flatMap((step): PanelOption[] => [
    { kind: 'number', key: `text_${step}_leading`, section: 'text', group: 'steps', label: 'Interlinea (0 = come il testo intorno)', format: `Testo ${step}: {0}`, en: `text ${step} step line height`, min: 0, max: 3, step: 0.01 },
    { kind: 'number', key: `text_${step}_tracking`, section: 'text', group: 'steps', label: 'Spaziatura delle lettere (em)', format: `Testo ${step}: {0}`, en: `text ${step} step letter spacing tracking`, min: -0.1, max: 0.3, step: 0.005 },
    { kind: 'number', key: `text_${step}_measure`, section: 'text', group: 'steps', label: 'Larghezza massima (ch, 0 = nessuna)', format: `Testo ${step}: {0}`, en: `text ${step} step max width measure`, min: 0, max: 120, step: 1 },
    { kind: 'choice', key: `text_${step}_case`, section: 'text', group: 'steps', label: 'Maiuscole', format: `Testo ${step}: {0}`, en: `text ${step} step text transform case`, choices: [['auto', 'Come il testo intorno'], ['none', 'Come scritte'], ['uppercase', 'Tutte maiuscole'], ['lowercase', 'Tutte minuscole'], ['capitalize', 'Iniziali maiuscole']] },
    { kind: 'choice', key: `text_${step}_wrap`, section: 'text', group: 'steps', label: 'A capo', format: `Testo ${step}: {0}`, en: `text ${step} step text wrap balance pretty`, choices: [['auto', 'Come il testo intorno'], ...WRAPS] },
  ]),
  { kind: 'toggle', key: 'text_on', section: 'text', group: 'body', label: 'Stili predefiniti del testo', en: 'default text body styles' },
  typo('body', 'text_leading', 'Interlinea del testo', 'text body line height', 1, 2.5, 0.01),
  choice('body', 'text_wrap', 'A capo del testo', 'text wrap pretty balance', WRAPS),
  typo('body', 'root_size', 'Dimensione radice (%)', 'root font size html rem', 62.5, 125, 0.5),
  { kind: 'number', key: 'section_multiplier_min', section: 'space', group: 'sections', label: 'Moltiplicatore delle sezioni, piccolo', en: 'section padding multiplier small screen', min: 0.5, max: 4, step: 0.05 },
  { kind: 'number', key: 'section_multiplier_max', section: 'space', group: 'sections', label: 'Moltiplicatore delle sezioni, grande', en: 'section padding multiplier large screen', min: 0.5, max: 4, step: 0.05 },
  { kind: 'choice', key: 'section_padding', section: 'space', group: 'sections', label: 'Padding predefinito delle sezioni', en: 'default section padding top bottom', choices: [['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'xl']] },
  { kind: 'number', key: 'gutter_min', section: 'space', group: 'sections', label: 'Margine laterale, piccolo (px)', en: 'gutter side margin small screen', min: 0, max: 128, step: 1 },
  { kind: 'number', key: 'gutter_max', section: 'space', group: 'sections', label: 'Margine laterale, grande (px)', en: 'gutter side margin large screen', min: 0, max: 128, step: 1 },
  ...([['container_gap', 'Spazio fra i figli di una sezione', 'container gap section children'], ['content_gap', 'Spazio fra blocchi di contenuto', 'content gap stack blocks'], ['grid_gap', 'Spazio delle griglie', 'grid gap columns']] as const).map(([key, label, en]): ChoiceOption => ({ kind: 'choice', key, section: 'space', group: 'gaps', label, en, choices: SPACE_STEPS.map((step) => [step, step]) })),
  { kind: 'number', key: 'grid_min', section: 'space', group: 'gaps', label: 'Griglia automatica: colonna minima (rem)', en: 'auto grid minimum column width', min: 6, max: 40, step: 0.5 },
  { kind: 'number', key: 'grid_max', section: 'space', group: 'gaps', label: 'Griglia automatica: colonne al massimo (0 = nessun limite)', en: 'auto grid maximum columns', min: 0, max: 12, step: 1 },
  { kind: 'choice', key: 'grid_fill', section: 'space', group: 'gaps', label: 'Griglia automatica: colonne', en: 'auto grid fit fill columns', choices: [['auto-fit', 'Riempiono la riga'], ['auto-fill', 'Tengono il posto']] },
  { kind: 'number', key: 'flow_text', section: 'space', group: 'gaps', label: 'Testi xb-prose: spazio fra i blocchi (em)', en: 'smart spacing paragraphs blocks prose', min: 0, max: 3, step: 0.05 },
  { kind: 'number', key: 'flow_heading', section: 'space', group: 'gaps', label: 'Testi xb-prose: spazio prima dei titoli (em)', en: 'smart spacing before headings prose', min: 0, max: 4, step: 0.05 },
  { kind: 'number', key: 'flow_after', section: 'space', group: 'gaps', label: 'Testi xb-prose: spazio dopo i titoli (em)', en: 'smart spacing after headings prose', min: 0, max: 3, step: 0.05 },
  { kind: 'number', key: 'flow_list', section: 'space', group: 'gaps', label: 'Testi xb-prose: spazio fra le voci delle liste (em)', en: 'smart spacing list items nested lists prose', min: 0, max: 1.5, step: 0.05 },
  { kind: 'choice', key: 'flow_scope', section: 'space', group: 'gaps', label: 'Spaziatura del testo: dove', en: 'smart spacing scope all content prose main', choices: [['prose', 'Solo nei testi xb-prose'], ['content', 'In tutto il contenuto (main)']] },
  { kind: 'toggle', key: 'section_grid_on', section: 'space', group: 'layout', label: 'Sezioni in griglia dei contenuti di default', en: 'sections content grid default' },
  { kind: 'toggle', key: 'boxed_on', section: 'space', group: 'layout', label: 'Layout a riquadro', en: 'boxed layout page width' },
  { kind: 'number', key: 'boxed_width', section: 'space', group: 'layout', label: 'Riquadro: larghezza (rem)', en: 'boxed layout width', min: 40, max: 200, step: 1 },
  { kind: 'choice', key: 'boxed_bg', section: 'space', group: 'layout', label: 'Riquadro: sfondo intorno', en: 'boxed layout outside background', choices: [['neutral-100', 'Neutro 100'], ['neutral-200', 'Neutro 200'], ['surface', 'Superficie'], ['surface-2', 'Superficie 2'], ['neutral-900', 'Neutro 900']] },
  { kind: 'choice', key: 'boxed_shadow', section: 'space', group: 'layout', label: 'Riquadro: ombra', en: 'boxed layout shadow', choices: [['none', 'Nessuna'], ['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'xl']] },
  { kind: 'number', key: 'width_min', section: 'space', group: 'layout', label: 'Larghezza minima del sito (px)', en: 'minimum site width', min: 240, max: 480, step: 1 },
  { kind: 'number', key: 'header_min', section: 'space', group: 'layout', label: 'Altezza dell’intestazione, piccolo (px)', en: 'header height small screen', min: 32, max: 200, step: 1 },
  { kind: 'number', key: 'header_max', section: 'space', group: 'layout', label: 'Altezza dell’intestazione, grande (px)', en: 'header height large screen', min: 32, max: 200, step: 1 },
  { kind: 'toggle', key: 'scroll_offset_on', section: 'space', group: 'layout', label: 'Ancore sotto l’intestazione', en: 'scroll offset anchor padding fixed header' },
  { kind: 'number', key: 'border_width', section: 'shape', group: 'border', label: 'Spessore del bordo (px)', en: 'default border width', min: 0, max: 8, step: 0.5 },
  { kind: 'choice', key: 'border_style', section: 'shape', group: 'border', label: 'Stile del bordo', en: 'default border style dashed dotted', choices: [['solid', 'Pieno'], ['dashed', 'Tratteggiato'], ['dotted', 'Punteggiato'], ['double', 'Doppio']] },
  { kind: 'choice', key: 'border_color', section: 'shape', group: 'border', label: 'Colore del bordo', en: 'default border colour role', choices: [['border', 'Bordo'], ['text-muted', 'Testo secondario'], ['primary', 'Primario'], ['neutral-300', 'Neutro 300']] },
  { kind: 'number', key: 'transition_ms', section: 'shape', group: 'border', label: 'Transizioni (ms)', en: 'transition duration buttons links', min: 0, max: 1000, step: 10 },
  { kind: 'number', key: 'divider_width', section: 'shape', group: 'border', label: 'Divisori: spessore (px)', en: 'divider rule width', min: 0, max: 8, step: 0.5 },
  { kind: 'choice', key: 'divider_style', section: 'shape', group: 'border', label: 'Divisori: stile', en: 'divider rule style', choices: [['solid', 'Pieno'], ['dashed', 'Tratteggiato'], ['dotted', 'Punteggiato'], ['double', 'Doppio']] },
  { kind: 'choice', key: 'divider_color', section: 'shape', group: 'border', label: 'Divisori: colore', en: 'divider rule colour', choices: [['border', 'Bordo'], ['text-muted', 'Testo secondario'], ['primary', 'Primario'], ['neutral-300', 'Neutro 300']] },
  { kind: 'choice', key: 'divider_space', section: 'shape', group: 'border', label: 'Divisori: spazio sopra e sotto', en: 'divider rule spacing', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'number', key: 'btn_pad_y', section: 'shape', group: 'buttons', label: 'Pulsanti: padding verticale (em)', en: 'button padding vertical', min: 0.2, max: 2, step: 0.05 },
  { kind: 'number', key: 'btn_pad_x', section: 'shape', group: 'buttons', label: 'Pulsanti: padding orizzontale (em)', en: 'button padding horizontal', min: 0.4, max: 4, step: 0.05 },
  { kind: 'choice', key: 'btn_radius', section: 'shape', group: 'buttons', label: 'Pulsanti: raggio', en: 'button radius rounded pill', choices: [['none', 'Nessuno'], ['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'xl'], ['full', 'Pillola']] },
  { kind: 'number', key: 'btn_weight', section: 'shape', group: 'buttons', label: 'Pulsanti: peso del testo', en: 'button font weight', min: 100, max: 900, step: 100 },
  { kind: 'number', key: 'btn_leading', section: 'shape', group: 'buttons', label: 'Pulsanti: interlinea', en: 'button line height', min: 0.8, max: 2, step: 0.05 },
  { kind: 'choice', key: 'btn_size', section: 'shape', group: 'buttons', label: 'Pulsanti: misura del testo', en: 'button text size font', choices: [['inherit', 'Come il testo intorno'], ['xs', 'xs'], ['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'xl']] },
  { kind: 'choice', key: 'btn_case', section: 'shape', group: 'buttons', label: 'Pulsanti: maiuscole', en: 'button text transform uppercase', choices: [['none', 'Come scritte'], ['uppercase', 'Tutte maiuscole'], ['lowercase', 'Tutte minuscole'], ['capitalize', 'Iniziali maiuscole']] },
  { kind: 'number', key: 'btn_tracking', section: 'shape', group: 'buttons', label: 'Pulsanti: spaziatura delle lettere (em)', en: 'button letter spacing', min: -0.05, max: 0.3, step: 0.005 },
  { kind: 'number', key: 'btn_border', section: 'shape', group: 'buttons', label: 'Pulsanti: bordo (px)', en: 'button border width', min: 0, max: 8, step: 0.5 },
  { kind: 'number', key: 'btn_min', section: 'shape', group: 'buttons', label: 'Pulsanti: larghezza minima (rem)', en: 'button minimum width', min: 0, max: 20, step: 0.5 },
  { kind: 'toggle', key: 'btn_full_mobile', section: 'shape', group: 'buttons', label: 'Pulsanti a tutta larghezza sui telefoni', en: 'full width buttons mobile' },
  { kind: 'number', key: 'btn_full_below', section: 'shape', group: 'buttons', label: 'Telefoni: fino a (px)', en: 'full width buttons breakpoint', min: 320, max: 960, step: 10 },
  ...FAMILY_LABELS.map(([key, label, en]): ToggleOption => ({ kind: 'toggle', key: `btn_${key}_on`, section: 'shape', group: 'buttons', label, format: 'Pulsanti della famiglia {0}', en: `${en} button variant family class on off` })),
  { kind: 'choice', key: 'btn_light_hover', section: 'shape', group: 'buttons', label: 'Variante chiara: sfumatura al passaggio', en: 'button light variant hover shade', choices: ['100', '200', '300'].map((v) => [v, v]) },
  { kind: 'choice', key: 'btn_dark_hover', section: 'shape', group: 'buttons', label: 'Variante scura: sfumatura al passaggio', en: 'button dark variant hover shade', choices: ['700', '900', '950'].map((v) => [v, v]) },
  { kind: 'toggle', key: 'btn_outline_on', section: 'shape', group: 'buttons', label: 'Pulsanti: variante a contorno', en: 'button outline variant class on off' },
  { kind: 'toggle', key: 'btn_light_on', section: 'shape', group: 'buttons', label: 'Pulsanti: variante chiara', en: 'button light variant class on off' },
  { kind: 'toggle', key: 'btn_dark_on', section: 'shape', group: 'buttons', label: 'Pulsanti: variante scura', en: 'button dark variant class on off' },
  { kind: 'choice', key: 'link_underline', section: 'shape', group: 'links', label: 'Link: sottolineatura', en: 'link underline decoration hover', choices: [['always', 'Sempre'], ['hover', 'Al passaggio'], ['never', 'Mai']] },
  { kind: 'number', key: 'link_thickness', section: 'shape', group: 'links', label: 'Link: spessore della linea (px)', en: 'link underline thickness', min: 0, max: 4, step: 0.5 },
  { kind: 'number', key: 'link_offset', section: 'shape', group: 'links', label: 'Link: distanza della linea (em)', en: 'link underline offset', min: 0, max: 0.5, step: 0.01 },
  { kind: 'toggle', key: 'links_on', section: 'shape', group: 'links', label: 'Stili predefiniti dei link', en: 'default link styles elements a' },
  { kind: 'toggle', key: 'external_on', section: 'shape', group: 'links', label: 'Link esterni: simbolo', en: 'external links arrow symbol outbound' },
  { kind: 'text', key: 'external_host', section: 'shape', group: 'links', label: 'Link esterni: dominio del sito (esempio.it)', en: 'external links site domain host' },
  { kind: 'text', key: 'external_label', section: 'shape', group: 'links', label: 'Link esterni: testo per i lettori di schermo', en: 'external links screen reader text label' },
  { kind: 'choice', key: 'external_symbol', section: 'shape', group: 'links', label: 'Link esterni: simbolo mostrato', en: 'external links symbol arrow none', choices: [['arrow', '↗'], ['none', 'Nessuno']] },
  { kind: 'choice', key: 'external_place', section: 'shape', group: 'links', label: 'Link esterni: posizione', en: 'external links symbol position before after', choices: [['after', 'Dopo il testo'], ['before', 'Prima del testo']] },
  ...([['card_pad', 'Card: padding', 'card padding'], ['card_gap', 'Card: spazio interno', 'card gap inner spacing']] as const).map(([key, label, en]): ChoiceOption => ({ kind: 'choice', key, section: 'shape', group: 'cards', label, en, choices: SPACE_STEPS.map((step) => [step, step]) })),
  { kind: 'choice', key: 'card_radius', section: 'shape', group: 'cards', label: 'Card: raggio', en: 'card radius', choices: [['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'xl']] },
  { kind: 'choice', key: 'card_bg', section: 'shape', group: 'cards', label: 'Card: sfondo', en: 'card background', choices: [['bg', 'Sfondo'], ['surface', 'Superficie'], ['surface-2', 'Superficie 2'], ['white', 'Bianco']] },
  { kind: 'choice', key: 'card_title', section: 'shape', group: 'cards', label: 'Card: misura del titolo (xb-card-title)', en: 'card title size heading', choices: [['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['h5', 'H5'], ['h6', 'H6']] },
  { kind: 'choice', key: 'card_shadow', section: 'shape', group: 'cards', label: 'Card: ombra', en: 'card shadow', choices: [['none', 'Nessuna'], ['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'xl']] },
  { kind: 'toggle', key: 'card_border', section: 'shape', group: 'cards', label: 'Card: bordo', en: 'card border' },
  { kind: 'choice', key: 'card_ratio', section: 'shape', group: 'cards', label: 'Card: proporzioni del media', en: 'card media aspect ratio', choices: [['16/9', '16:9'], ['4/3', '4:3'], ['3/2', '3:2'], ['1/1', '1:1'], ['3/4', '3:4']] },
  { kind: 'choice', key: 'overlay_color', section: 'shape', group: 'surfaces', label: 'Sovrapposizione: colore', en: 'overlay colour', choices: [['black', 'Nero'], ['white', 'Bianco'], ['primary', 'Primario'], ['secondary', 'Secondario'], ['accent', 'Accento'], ['neutral', 'Neutro']] },
  { kind: 'number', key: 'overlay_opacity', section: 'shape', group: 'surfaces', label: 'Sovrapposizione: opacità', en: 'overlay opacity', min: 0, max: 1, step: 0.05 },
  { kind: 'choice', key: 'overlay_blend', section: 'shape', group: 'surfaces', label: 'Sovrapposizione: fusione', en: 'overlay blend mode', choices: [['normal', 'Normale'], ['multiply', 'Moltiplica'], ['screen', 'Scherma'], ['overlay', 'Sovrapponi'], ['darken', 'Scurisci'], ['lighten', 'Schiarisci']] },
  ...[2, 3].flatMap((n): PanelOption[] => [
    { kind: 'choice', key: `overlay_${n}_color`, section: 'shape', group: 'surfaces', label: 'Colore', format: `Sovrapposizione ${n}: {0}`, en: `overlay ${n} colour`, choices: [['black', 'Nero'], ['white', 'Bianco'], ['primary', 'Primario'], ['secondary', 'Secondario'], ['accent', 'Accento'], ['neutral', 'Neutro']] },
    { kind: 'number', key: `overlay_${n}_opacity`, section: 'shape', group: 'surfaces', label: 'Opacità', format: `Sovrapposizione ${n}: {0}`, en: `overlay ${n} opacity`, min: 0, max: 1, step: 0.05 },
    { kind: 'choice', key: `overlay_${n}_blend`, section: 'shape', group: 'surfaces', label: 'Fusione', format: `Sovrapposizione ${n}: {0}`, en: `overlay ${n} blend mode`, choices: [['normal', 'Normale'], ['multiply', 'Moltiplica'], ['screen', 'Scherma'], ['overlay', 'Sovrapponi'], ['darken', 'Scurisci'], ['lighten', 'Schiarisci']] },
  ]),
  ...[1, 2, 3].flatMap((n): PanelOption[] => [
    { kind: 'role', key: `role_named_${n}`, section: 'shape', group: 'surfaces', label: 'Sfondo', format: `Superficie ${n}: {0}`, en: `surface ${n} background custom` },
    { kind: 'role', key: `role_named_${n}_to`, section: 'shape', group: 'surfaces', label: 'Fine del gradiente (Automatico = nessun gradiente)', format: `Superficie ${n}: {0}`, en: `surface ${n} gradient second colour end` },
    { kind: 'number', key: `surface_${n}_angle`, section: 'shape', group: 'surfaces', label: 'Angolo del gradiente (gradi)', format: `Superficie ${n}: {0}`, en: `surface ${n} gradient angle`, min: 0, max: 359, step: 1 },
    { kind: 'text', key: `surface_${n}_name`, section: 'shape', group: 'surfaces', label: 'Nome libero (classe xb-surface-nome)', format: `Superficie ${n}: {0}`, en: `surface ${n} custom name class` },
    { kind: 'toggle', key: `surface_${n}_border`, section: 'shape', group: 'surfaces', label: 'Bordo', format: `Superficie ${n}: {0}`, en: `surface ${n} border` },
    { kind: 'choice', key: `surface_${n}_shadow`, section: 'shape', group: 'surfaces', label: 'Ombra', format: `Superficie ${n}: {0}`, en: `surface ${n} shadow`, choices: [['none', 'Nessuna'], ['s', 's'], ['m', 'm'], ['l', 'l']] },
  ]),
  ...(['xs', 's', 'm', 'l', 'xl', '2xl'] as const).map((step): NumberOption => ({ kind: 'number', key: `icon_${step}`, section: 'shape', group: 'icons', label: `Icone: misura ${step} (em)`, en: `icon size ${step}`, min: 0.25, max: 8, step: 0.05 })),
  { kind: 'choice', key: 'icon_color', section: 'shape', group: 'icons', label: 'Icone: colore', en: 'icon colour', choices: [['currentColor', 'Come il testo'], ['primary', 'Primario'], ['secondary', 'Secondario'], ['accent', 'Accento'], ['text', 'Testo'], ['text-muted', 'Testo secondario']] },
  { kind: 'number', key: 'icon_stroke', section: 'shape', group: 'icons', label: 'Icone: spessore del tratto', en: 'icon stroke width', min: 1, max: 3, step: 0.25 },
  { kind: 'choice', key: 'icon_box_shade', section: 'shape', group: 'icons', label: 'Icona in riquadro: sfumatura', en: 'boxed icon background shade', choices: [['50', '50'], ['100', '100'], ['200', '200']] },
  { kind: 'choice', key: 'icon_box_pad', section: 'shape', group: 'icons', label: 'Icona in riquadro: padding', en: 'boxed icon padding', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'choice', key: 'icon_box_radius', section: 'shape', group: 'icons', label: 'Icona in riquadro: raggio', en: 'boxed icon radius', choices: [['none', 'Nessuno'], ['s', 's'], ['m', 'm'], ['l', 'l'], ['full', 'Pillola']] },
  { kind: 'choice', key: 'list_icon_color', section: 'shape', group: 'icons', label: 'Liste con icona: colore', en: 'icon list check colour', choices: [['primary', 'Primario'], ['secondary', 'Secondario'], ['accent', 'Accento'], ['success', 'Successo'], ['text', 'Testo']] },
  { kind: 'choice', key: 'list_icon_symbol', section: 'shape', group: 'icons', label: 'Liste con icona: simbolo', en: 'icon list symbol check arrow dot star plus dash', choices: [['check', 'Spunta'], ['arrow', 'Freccia'], ['dot', 'Punto'], ['star', 'Stella'], ['plus', 'Più'], ['dash', 'Trattino']] },
  { kind: 'choice', key: 'list_icon_gap', section: 'shape', group: 'icons', label: 'Liste con icona: distanza', en: 'icon list gap', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'toggle', key: 'forms_on', section: 'details', group: 'defaults', label: 'Stili predefiniti dei moduli', en: 'default form styles fields inputs fluent forms' },
  { kind: 'number', key: 'field_pad_y', section: 'details', group: 'forms', label: 'Campi: padding verticale (em)', en: 'field input padding vertical', min: 0.2, max: 2, step: 0.05 },
  { kind: 'number', key: 'field_pad_x', section: 'details', group: 'forms', label: 'Campi: padding orizzontale (em)', en: 'field input padding horizontal', min: 0.2, max: 3, step: 0.05 },
  { kind: 'choice', key: 'field_radius', section: 'details', group: 'forms', label: 'Campi: raggio', en: 'field input radius', choices: [['none', 'Nessuno'], ['s', 's'], ['m', 'm'], ['l', 'l'], ['full', 'Pillola']] },
  { kind: 'choice', key: 'field_bg', section: 'details', group: 'forms', label: 'Campi: sfondo', en: 'field input background', choices: [['bg', 'Sfondo'], ['surface', 'Superficie'], ['surface-2', 'Superficie 2'], ['white', 'Bianco']] },
  { kind: 'number', key: 'field_border', section: 'details', group: 'forms', label: 'Campi: bordo (px)', en: 'field input border width', min: 0, max: 8, step: 0.5 },
  { kind: 'number', key: 'field_focus_ring', section: 'details', group: 'forms', label: 'Campi: anello di focus (px)', en: 'field focus ring shadow', min: 0, max: 8, step: 0.5 },
  { kind: 'number', key: 'label_weight', section: 'details', group: 'forms', label: 'Etichette: peso', en: 'label font weight', min: 100, max: 900, step: 100 },
  { kind: 'choice', key: 'field_focus_color', section: 'details', group: 'forms', label: 'Campi: colore del focus', en: 'field focus colour', choices: [['focus', 'Focus'], ['primary', 'Primario'], ['accent', 'Accento']] },
  { kind: 'choice', key: 'label_color', section: 'details', group: 'forms', label: 'Etichette: colore', en: 'label colour', choices: [['heading', 'Titoli'], ['text', 'Testo'], ['text-muted', 'Testo secondario']] },
  { kind: 'choice', key: 'legend_size', section: 'details', group: 'forms', label: 'Legenda: misura', en: 'fieldset legend text size', choices: [['inherit', 'Come il testo intorno'], ['xs', 'xs'], ['s', 's'], ['m', 'm'], ['l', 'l']] },
  { kind: 'choice', key: 'field_size', section: 'details', group: 'forms', label: 'Campi: misura del testo', en: 'field input text size', choices: [['inherit', 'Come il testo intorno'], ['xs', 'xs'], ['s', 's'], ['m', 'm'], ['l', 'l']] },
  { kind: 'choice', key: 'field_placeholder', section: 'details', group: 'forms', label: 'Campi: segnaposto', en: 'field placeholder colour', choices: [['text-muted', 'Testo secondario'], ['text', 'Testo'], ['neutral-400', 'Neutro 400'], ['neutral-500', 'Neutro 500'], ['neutral-600', 'Neutro 600']] },
  { kind: 'choice', key: 'label_size', section: 'details', group: 'forms', label: 'Etichette: misura', en: 'label text size', choices: [['inherit', 'Come il testo intorno'], ['xs', 'xs'], ['s', 's'], ['m', 'm'], ['l', 'l']] },
  { kind: 'choice', key: 'help_size', section: 'details', group: 'forms', label: 'Aiuto: misura', en: 'help message text size', choices: [['xs', 'xs'], ['s', 's'], ['m', 'm']] },
  { kind: 'choice', key: 'help_color', section: 'details', group: 'forms', label: 'Aiuto: colore', en: 'help message colour', choices: [['text-muted', 'Testo secondario'], ['text', 'Testo'], ['neutral-500', 'Neutro 500']] },
  { kind: 'choice', key: 'field_invalid', section: 'details', group: 'forms', label: 'Errore: colore', en: 'invalid error field colour', choices: [['danger', 'Pericolo'], ['warning', 'Avviso'], ['primary', 'Primario']] },
  { kind: 'choice', key: 'field_valid', section: 'details', group: 'forms', label: 'Conferma: colore', en: 'valid success field colour', choices: [['success', 'Successo'], ['info', 'Informazione'], ['primary', 'Primario']] },
  { kind: 'choice', key: 'check_style', section: 'details', group: 'forms', label: 'Caselle: stile', en: 'checkbox switch toggle style', choices: [['normal', 'Casella'], ['switch', 'Interruttore']] },
  { kind: 'number', key: 'check_size', section: 'details', group: 'forms', label: 'Caselle e scelte: misura (em)', en: 'checkbox radio size', min: 0.8, max: 2, step: 0.05 },
  { kind: 'choice', key: 'field_gap', section: 'details', group: 'forms', label: 'Spazio fra i campi', en: 'field group gap spacing', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'choice', key: 'form_submit', section: 'details', group: 'forms', label: 'Pulsante d’invio: famiglia', en: 'form submit button colour family', choices: [['primary', 'Primario'], ['secondary', 'Secondario'], ['tertiary', 'Terziario'], ['accent', 'Accento'], ['neutral', 'Neutro'], ['success', 'Successo']] },
  { kind: 'number', key: 'step_height', section: 'details', group: 'forms', label: 'Barra dei passi: altezza (px)', en: 'form steps progress bar height multi page', min: 2, max: 24, step: 1 },
  { kind: 'choice', key: 'step_color', section: 'details', group: 'forms', label: 'Barra dei passi: colore', en: 'form steps progress bar colour', choices: [['primary', 'Primario'], ['secondary', 'Secondario'], ['tertiary', 'Terziario'], ['accent', 'Accento'], ['neutral', 'Neutro'], ['success', 'Successo']] },
  { kind: 'choice', key: 'step_track', section: 'details', group: 'forms', label: 'Barra dei passi: fondo', en: 'form steps progress bar track background', choices: [['neutral-100', 'Neutro 100'], ['neutral-200', 'Neutro 200'], ['neutral-300', 'Neutro 300'], ['surface', 'Superficie'], ['surface-2', 'Superficie 2']] },
  { kind: 'toggle', key: 'focus_on', section: 'details', group: 'access', label: 'Anello di focus su tutto il sito', en: 'focus ring outline focus-visible' },
  { kind: 'choice', key: 'focus_style', section: 'details', group: 'access', label: 'Focus: stile', en: 'focus ring outline style', choices: [['solid', 'Pieno'], ['dashed', 'Tratteggiato'], ['dotted', 'Punteggiato'], ['double', 'Doppio']] },
  { kind: 'number', key: 'focus_width', section: 'details', group: 'access', label: 'Focus: spessore (px)', en: 'focus ring width', min: 1, max: 6, step: 0.5 },
  { kind: 'number', key: 'focus_offset', section: 'details', group: 'access', label: 'Focus: distanza (px)', en: 'focus ring offset', min: 0, max: 8, step: 0.5 },
  { kind: 'toggle', key: 'smooth_scroll', section: 'details', group: 'access', label: 'Scorrimento morbido', en: 'smooth scrolling scroll behavior' },
  { kind: 'toggle', key: 'reduce_motion', section: 'details', group: 'access', label: 'Movimento ridotto quando il sistema lo chiede', en: 'reduce motion prefers-reduced-motion animations' },
  { kind: 'toggle', key: 'selection_on', section: 'details', group: 'access', label: 'Colore della selezione', en: 'text selection colour' },
  { kind: 'choice', key: 'selection_shade', section: 'details', group: 'access', label: 'Selezione: sfumatura del primario', en: 'selection shade primary', choices: [['100', '100'], ['200', '200'], ['300', '300'], ['400', '400']] },
  { kind: 'choice', key: 'selection_text', section: 'details', group: 'access', label: 'Selezione: testo', en: 'selection text colour', choices: [['text', 'Testo'], ['white', 'Bianco'], ['black', 'Nero'], ['on-primary', 'Leggibile sul primario']] },
  { kind: 'toggle', key: 'quotes_on', section: 'details', group: 'access', label: 'Stile delle citazioni', en: 'blockquote quote cite style' },
  { kind: 'number', key: 'quote_width', section: 'details', group: 'access', label: 'Citazioni: spessore del bordo (px)', en: 'blockquote border width', min: 0, max: 16, step: 1 },
  { kind: 'choice', key: 'quote_color', section: 'details', group: 'access', label: 'Citazioni: colore del bordo', en: 'blockquote border colour', choices: [['primary-300', 'Primario 300'], ['primary', 'Primario'], ['accent-300', 'Accento 300'], ['neutral-300', 'Neutro 300'], ['border', 'Bordo']] },
  { kind: 'choice', key: 'quote_pad', section: 'details', group: 'access', label: 'Citazioni: padding', en: 'blockquote padding', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'toggle', key: 'quote_italic', section: 'details', group: 'access', label: 'Citazioni in corsivo', en: 'blockquote italic' },
  { kind: 'number', key: 'columns_min', section: 'details', group: 'access', label: 'Colonne di testo: larghezza minima (rem)', en: 'text columns minimum width', min: 8, max: 40, step: 0.5 },
  { kind: 'choice', key: 'columns_gap', section: 'details', group: 'access', label: 'Colonne di testo: spazio', en: 'text columns gap', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'toggle', key: 'columns_rule', section: 'details', group: 'access', label: 'Colonne di testo: riga divisoria', en: 'text columns rule divider' },
  { kind: 'number', key: 'enter_range', section: 'details', group: 'motion', label: 'Entrata: compiuta a (% della vista)', en: 'scroll enter animation range view', min: 10, max: 100, step: 5 },
  { kind: 'choice', key: 'enter_distance', section: 'details', group: 'motion', label: 'Entrata: distanza', en: 'scroll enter animation distance', choices: SPACE_STEPS.map((step) => [step, step]) },
  { kind: 'choice', key: 'enter_ease', section: 'details', group: 'motion', label: 'Entrata: curva', en: 'scroll animation easing curve', choices: [['ease-out', 'Rallenta alla fine'], ['ease-in-out', 'Morbida'], ['ease', 'Standard'], ['linear', 'Lineare']] },
  { kind: 'number', key: 'enter_scale', section: 'details', group: 'motion', label: 'Entrata: misura di partenza (grow; shrink l’opposto)', en: 'scroll enter grow shrink scale', min: 0.5, max: 1, step: 0.01 },
  { kind: 'number', key: 'enter_blur', section: 'details', group: 'motion', label: 'Entrata: sfocatura (px)', en: 'scroll enter blur', min: 0, max: 40, step: 1 },
  { kind: 'number', key: 'exit_range', section: 'details', group: 'motion', label: 'Uscita: compiuta a (% dell’uscita)', en: 'scroll exit animation range', min: 10, max: 100, step: 5 },
  { kind: 'number', key: 'hover_bright', section: 'details', group: 'motion', label: 'Passaggio: luminosità', en: 'hover brightness', min: 1, max: 1.5, step: 0.01 },
  { kind: 'number', key: 'hover_fade', section: 'details', group: 'motion', label: 'Passaggio: opacità', en: 'hover fade opacity', min: 0.2, max: 1, step: 0.05 },
  { kind: 'number', key: 'hover_duration', section: 'details', group: 'motion', label: 'Passaggio: durata (ms)', en: 'hover effect duration transition', min: 50, max: 1000, step: 10 },
  { kind: 'number', key: 'hover_lift', section: 'details', group: 'motion', label: 'Passaggio: sollevamento (px)', en: 'hover lift distance', min: 1, max: 16, step: 1 },
  { kind: 'number', key: 'hover_scale', section: 'details', group: 'motion', label: 'Passaggio: ingrandimento', en: 'hover scale zoom', min: 1, max: 1.2, step: 0.01 },
  ...([
    ['print_alphas', 'Variabili: trasparenze (-a10 … -a90)', 'variables print transparencies alpha group'],
    ['print_shadows', 'Variabili: ombre', 'variables print shadows group'],
    ['print_buttons', 'Variabili: pulsanti e link', 'variables print buttons links group'],
    ['print_forms', 'Variabili: moduli', 'variables print forms fields group'],
    ['print_cards', 'Variabili: card', 'variables print cards group'],
    ['print_icons', 'Variabili: icone', 'variables print icons group'],
    ['print_motion', 'Variabili: movimento', 'variables print motion effects group'],
    ['tokens_inline', 'Token in linea nella pagina, senza file (WordPress)', 'inline tokens head stylesheet file print'],
    ['block_palette', 'Palette di Histeon CSS nell’editor a blocchi', 'gutenberg block editor palette theme json'],
    ['classes_colors', 'Classi: colori (xb-color-, xb-bg-, xb-border-)', 'classes print colour utilities group'],
    ['classes_buttons', 'Classi: pulsanti (xb-btn)', 'classes print buttons group'],
    ['classes_motion', 'Classi: movimento (xb-enter-, xb-exit-, xb-hover-)', 'classes print motion effects group'],
    ['classes_icons', 'Classi: icone (xb-icon, xb-list-icon)', 'classes print icons group'],
    ['classes_cards', 'Classi: card (xb-card)', 'classes print cards group'],
    ['classes_forms', 'Classi: moduli (xb-input, xb-field, xb-label, xb-help)', 'classes print forms group'],
  ] as const).map(([key, label, en]): ToggleOption => ({ kind: 'toggle', key, section: 'details', group: 'advanced', label, en })),
  font('font_body', 'Testo', 'body text font family typeface'),
  font('font_heading', 'Titoli', 'heading headings font family typeface'),
  font('font_mono', 'Codice', 'code monospace mono font family typeface'),
  font('font_accent', 'Accento', 'accent font family typeface fourth', true),
  font('font_display', 'Display', 'display font family typeface fifth', true),
];


const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Whether an option answers a search: its Italian label, its label as shown, its English words, its key. */
export function matches(option: PanelOption, query: string, shown = option.label): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(`${option.label} ${option.format ?? ''} ${shown} ${option.en} ${option.key.replace(/_/g, ' ')}`);
  return words.every((w) => hay.includes(w));
}

/** Whether a value differs from its default (numbers within rounding). */
export function differs(value: unknown, fallback: unknown): boolean {
  if (value === undefined) return false;
  if (typeof fallback === 'number') return Math.abs(Number(value) - fallback) > 1e-9;
  return String(value).trim() !== String(fallback ?? '').trim();
}

/** The format of an exported file: only what differs from the defaults. */
export const EXPORT_FORMAT = 'histos-css-design';

export function exportDesign(design: DesignParams, defaults: DesignParams): string {
  const changed = Object.fromEntries(Object.entries(design).filter(([key, value]) => key in defaults && differs(value, defaults[key])));
  return `${JSON.stringify({ format: EXPORT_FORMAT, version: 1, design: changed }, null, 2)}\n`;
}

/** Max size of an imported file. */
export const IMPORT_MAX = 64 * 1024;

/**
 * A file read back: the parameters it holds, over the defaults. Only known keys with a string or a number; the
 * server validates the values (design/preview) before the panel takes them.
 */
export function parseImport(text: string, defaults: DesignParams): DesignParams {
  if (text.length > IMPORT_MAX) throw new Error('too-large');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('not-json');
  }
  const body = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (!body || body.format !== EXPORT_FORMAT || body.version !== 1) throw new Error('not-histos');
  const design = body.design;
  if (!design || typeof design !== 'object' || Array.isArray(design)) throw new Error('not-histos');
  const out: DesignParams = { ...defaults };
  for (const [key, value] of Object.entries(design as Record<string, unknown>)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`unknown:${key}`);
    if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`unknown:${key}`);
    out[key] = value;
  }
  return out;
}
