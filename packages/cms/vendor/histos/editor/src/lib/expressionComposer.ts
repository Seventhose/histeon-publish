import { parseExpression } from '@xb/dsl';
import { t } from './i18n.ts';

// The visual composer of an expression (lista della spesa 156): who does not program picks a piece of data (the
// page's title, the site's name, a field of the item in a loop), a format (a date as «4 novembre 2026», a number
// with two decimals, the first 20 words) and a fallback, and gets the expression the code would hold:
// `{post.date.date("j F Y") ?? "—"}`. Pure functions; the panel only draws them (ExpressionComposer.svelte).

export interface DataChoice {
  /** The path in the expression language: `this.title`, `site.name`, `post.fields.prezzo`. */
  path: string;
  label: string;
  group: string;
  /** What kind of value it is: which formats make sense. */
  kind: 'text' | 'date' | 'number' | 'url' | 'image' | 'list';
}

export type FormatId = 'none' | 'upper' | 'lower' | 'capitalize' | 'date' | 'number' | 'words' | 'chars' | 'join' | 'length' | 'imageUrl' | 'imageAlt';

export interface Composition {
  path: string;
  format: FormatId;
  /** The format's argument: the date pattern, the decimals, the number of words or characters, the separator. */
  arg: string;
  /** Shown when the value is empty; '' for none. */
  fallback: string;
}

/** The fields a post has, in words. */
function postFields(root: string, group: string): DataChoice[] {
  return [
    { path: `${root}.title`, label: t('Titolo'), group, kind: 'text' },
    { path: `${root}.excerpt`, label: t('Estratto'), group, kind: 'text' },
    { path: `${root}.date`, label: t('Data di pubblicazione'), group, kind: 'date' },
    { path: `${root}.modified`, label: t('Data di modifica'), group, kind: 'date' },
    { path: `${root}.author.name`, label: t('Autore'), group, kind: 'text' },
    { path: `${root}.url`, label: t('Indirizzo'), group, kind: 'url' },
    { path: `${root}.image`, label: t('Immagine in evidenza'), group, kind: 'image' },
    { path: `${root}.categories`, label: t('Categorie'), group, kind: 'list' },
    { path: `${root}.tags`, label: t('Tag'), group, kind: 'list' },
    { path: `${root}.commentCount`, label: t('Numero di commenti'), group, kind: 'number' },
  ];
}

/**
 * What can be read where the element is: the item of every loop around it (innermost first), the component's props
 * when editing a component, then the page, the site and the visitor.
 */
export function dataChoices(scope: { loops: string[]; props: string[] }): DataChoice[] {
  const out: DataChoice[] = [];
  for (const name of scope.loops) out.push(...postFields(name, t('Elemento del loop «{0}»', name)));
  for (const name of scope.props) out.push({ path: `props.${name}`, label: name, group: t('Props del componente'), kind: 'text' });
  out.push(...postFields('this', t('Questa pagina')));
  const site = t('Sito');
  out.push(
    { path: 'site.name', label: t('Nome del sito'), group: site, kind: 'text' },
    { path: 'site.description', label: t('Motto del sito'), group: site, kind: 'text' },
    { path: 'site.url', label: t('Indirizzo del sito'), group: site, kind: 'url' },
    { path: 'site.year', label: t('Anno in corso'), group: site, kind: 'number' },
    { path: 'site.logo', label: t('Logo'), group: site, kind: 'image' },
  );
  out.push({ path: 'user.name', label: t('Nome di chi visita (se ha fatto l’accesso)'), group: t('Visitatore'), kind: 'text' });
  return out;
}

/** The formats that fit a kind of value, with the default argument. */
export function formatsFor(kind: DataChoice['kind']): Array<{ id: FormatId; label: string; arg?: string; argLabel?: string }> {
  const none = { id: 'none' as const, label: t('Così com’è') };
  switch (kind) {
    case 'date':
      return [
        { id: 'date', label: t('Data'), arg: 'j F Y', argLabel: t('Forma della data') },
        none,
      ];
    case 'number':
      return [none, { id: 'number', label: t('Numero con decimali'), arg: '0', argLabel: t('Decimali') }];
    case 'image':
      return [
        { id: 'imageUrl', label: t('Indirizzo dell’immagine') },
        { id: 'imageAlt', label: t('Testo alternativo') },
      ];
    case 'list':
      return [
        { id: 'join', label: t('Elenco separato'), arg: ', ', argLabel: t('Separatore') },
        { id: 'length', label: t('Quanti sono') },
      ];
    case 'url':
      return [none];
    default:
      return [
        none,
        { id: 'upper', label: t('MAIUSCOLO') },
        { id: 'lower', label: t('minuscolo') },
        { id: 'capitalize', label: t('Iniziale maiuscola') },
        { id: 'words', label: t('Prime parole'), arg: '20', argLabel: t('Quante parole') },
        { id: 'chars', label: t('Primi caratteri'), arg: '120', argLabel: t('Quanti caratteri') },
      ];
  }
}

/** Date forms offered by name; any other PHP date pattern can be typed. */
export const DATE_FORMS: Array<[string, string]> = [
  ['j F Y', '4 novembre 2026'],
  ['d/m/Y', '04/11/2026'],
  ['F Y', 'novembre 2026'],
  ['l j F', 'mercoledì 4 novembre'],
  ['H:i', '14:30'],
];

const quote = (s: string) => JSON.stringify(s);
const whole = (s: string, fallback: number) => (/^\d{1,4}$/.test(s.trim()) ? String(Number(s.trim())) : String(fallback));

/** The expression (without braces) for a composition. */
export function composeExpression(c: Composition): string {
  let expr = c.path;
  switch (c.format) {
    case 'upper':
    case 'lower':
    case 'capitalize':
    case 'length':
      expr += `.${c.format}()`;
      break;
    case 'date':
      expr += `.date(${c.arg.trim() ? quote(c.arg.trim()) : ''})`;
      break;
    case 'number':
      expr += `.number(${whole(c.arg, 0)})`;
      break;
    case 'words':
      expr += `.truncateWords(${whole(c.arg, 20)})`;
      break;
    case 'chars':
      expr += `.truncateChars(${whole(c.arg, 120)})`;
      break;
    case 'join':
      expr += `.join(${quote(c.arg)})`;
      break;
    case 'imageUrl':
      expr += '.url';
      break;
    case 'imageAlt':
      expr += '.alt';
      break;
  }
  return c.fallback.trim() ? `${expr} ?? ${quote(c.fallback.trim())}` : expr;
}

/** Words kept as they are: a brace in them is a literal one (`\{`), never the start of an expression. */
const literal = (words: string): string => words.replace(/[{}]/g, (c) => `\\${c}`);

/** Text with the expression in it: `{…}` between the words before and after. */
export function composeText(c: Composition, before = '', after = ''): string {
  return `${literal(before)}{${composeExpression(c)}}${literal(after)}`;
}

/** Whether the expression language reads it: the composer never writes what the code would refuse. */
export function valid(expr: string): boolean {
  try {
    parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

const FORMAT_CALLS: Array<[RegExp, (m: RegExpMatchArray) => Pick<Composition, 'format' | 'arg'>]> = [
  [/\.(upper|lower|capitalize|length)\(\)$/, (m) => ({ format: m[1] as FormatId, arg: '' })],
  [/\.date\((?:"((?:[^"\\]|\\.)*)")?\)$/, (m) => ({ format: 'date', arg: m[1] ? (JSON.parse(`"${m[1]}"`) as string) : '' })],
  [/\.number\((\d+)\)$/, (m) => ({ format: 'number', arg: m[1]! })],
  [/\.truncateWords\((\d+)\)$/, (m) => ({ format: 'words', arg: m[1]! })],
  [/\.truncateChars\((\d+)\)$/, (m) => ({ format: 'chars', arg: m[1]! })],
  [/\.join\(("(?:[^"\\]|\\.)*")\)$/, (m) => ({ format: 'join', arg: JSON.parse(m[1]!) as string })],
];

/**
 * A composition back from an expression the composer could have written, to edit it again; null for anything
 * else (a condition, two fields, a modifier it does not offer): the code panel stays the place for those.
 */
export function readExpression(expr: string, choices: DataChoice[]): Composition | null {
  let rest = expr.trim();
  let fallback = '';
  const fb = /\s*\?\?\s*("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (fb) {
    fallback = JSON.parse(fb[1]!) as string;
    rest = rest.slice(0, fb.index);
  }
  let format: FormatId = 'none';
  let arg = '';
  for (const [re, read] of FORMAT_CALLS) {
    const m = re.exec(rest);
    if (m) {
      ({ format, arg } = read(m));
      rest = rest.slice(0, m.index);
      break;
    }
  }
  if (format === 'none') {
    const image = /\.(url|alt)$/.exec(rest);
    if (image && choices.some((c) => c.path === rest.slice(0, image.index) && c.kind === 'image')) {
      format = image[1] === 'url' ? 'imageUrl' : 'imageAlt';
      rest = rest.slice(0, image.index);
    }
  }
  if (!choices.some((c) => c.path === rest)) return null;
  return { path: rest, format, arg, fallback };
}
