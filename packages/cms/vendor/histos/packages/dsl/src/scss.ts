// A block's rules, gathered from the global sheets as one nested body (docs/spec/styles.md §11). Imported sites
// keep their CSS in a sheet, where `.card`, `.card__title`, `.card:hover` and every `@media` repeat the class;
// here they become what the selector panel writes, as in SCSS:
//
//   padding: 1rem;
//   &:hover { … }
//   &__title { … }
//   @media (width > 40em) { padding: 2rem; &__title { … } }
//
// Moving them into the selector (moveToSelector) leaves one place to read and edit. The order of the rules is
// kept, so the cascade is the same; rules that also name other blocks (`.card, .tile`) stay in the sheet.
import { compileCss, splitList } from './css.ts';
import { prettyRule, rulesWhere, type SheetRule } from './sheet.ts';

export interface BlockRule extends SheetRule {
  sheet: string;
  /** The selector relative to the block: '' (the block itself), `&:hover`, `&__title`, `& > a`… */
  rel: string;
  body: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GROUP = /^@(?:media|container|supports|layer)\b/i;

/** `.card__title:hover` → `&__title:hover` for block `card`; null when the selector is not about the block. */
export function relative(selector: string, block: string): string | null {
  const sel = selector.trim();
  const head = `.${block}`;
  if (!sel.startsWith(head)) return null;
  const rest = sel.slice(head.length);
  if (rest === '') return '';
  if (/^(?:__|--)[\w-]/.test(rest)) return `&${rest}`;
  if (/^[:[.#]/.test(rest)) return `&${rest}`;
  if (/^\s*[>+~]/.test(rest) || /^\s+\S/.test(rest)) return `& ${rest.trim()}`;
  return null; // `.cardigan`, `.card-x`: another block.
}

/** The selector list, relative to the block, when every selector is about it and they nest as one prelude. */
function relativeList(prelude: string, block: string): string | null {
  const parts = splitList(prelude).map((p) => relative(p, block));
  if (parts.some((p) => p === null)) return null;
  if (parts.length > 1 && parts.some((p) => p === '')) return null; // `.card, .card__x`: no single nested prelude.
  return (parts as string[]).join(', ');
}

/**
 * The rules of the block in one sheet: those that can move (every selector about the block, inside @media,
 * @container, @supports or @layer only) and those that stay (they name other blocks too).
 */
export function blockRules(css: string, block: string, sheet: string): { movable: BlockRule[]; shared: SheetRule[] } {
  const about = new RegExp(`\\.${escape(block)}(?![\\w-]|\\\\)|\\.${escape(block)}(?:__|--)[\\w-]`);
  const movable: BlockRule[] = [];
  const shared: SheetRule[] = [];
  for (const rule of rulesWhere(css, (prelude) => about.test(prelude.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]/g, ' ')))) {
    const moving = asBlockRule(css, rule, block, sheet);
    if (moving) movable.push(moving);
    else shared.push(rule);
  }
  return { movable, shared };
}

/** The rule as the block's nested rule, or null when it cannot move (other blocks, or inside @scope, @keyframes…). */
function asBlockRule(css: string, rule: SheetRule, block: string, sheet: string): BlockRule | null {
  const text = css.slice(rule.from, rule.to);
  const brace = text.indexOf('{');
  const rel = relativeList(text.slice(0, brace), block);
  if (rel === null || !rule.within.every((w) => GROUP.test(w))) return null;
  return { ...rule, sheet, rel, body: text.slice(brace + 1, -1).trim() };
}

/** The rules as one nested body, in their order; consecutive rules in the same @media share it. */
export function nestedBody(rules: BlockRule[]): string {
  const parts: string[] = [];
  let open: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const inner = buffer.join('\n');
    parts.push(open.reduceRight((acc, prelude) => `${prelude} {\n${acc}\n}`, inner));
    buffer = [];
  };
  for (const rule of rules) {
    if (rule.within.join('\u0000') !== open.join('\u0000')) {
      flush();
      open = rule.within;
    }
    // Minified sheets drop the last `;` of a body: joined to the next rule's, two declarations would become one.
    const body = /[;}]$/.test(rule.body) || rule.body === '' ? rule.body : `${rule.body};`;
    buffer.push(rule.rel === '' ? body : `${rule.rel} {\n${body}\n}`);
  }
  flush();
  return prettyRule(parts.join('\n'));
}

/** The sheet without those rules; at-rules left empty go too. */
export function withoutRules(css: string, rules: SheetRule[]): string {
  let out = css;
  for (const rule of [...rules].sort((a, b) => b.from - a.from)) {
    let end = rule.to;
    while (end < out.length && /[ \t]/.test(out.charAt(end))) end++;
    if (out.charAt(end) === '\n') end++;
    out = out.slice(0, rule.from) + out.slice(end);
  }
  // Emptied groups: `@media (…) { }` with nothing but white space (repeated for groups inside groups).
  let previous = '';
  while (previous !== out) {
    previous = out;
    out = out.replace(/@(?:media|container|supports|layer)\b[^{};]*\{\s*\}\s*\n?/gi, '');
  }
  return out;
}

/** Properties a rule body declares, nested rules included (lower case). */
export function properties(body: string): Set<string> {
  const out = new Set<string>();
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body.charAt(i);
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < body.length && body.charAt(j) !== c) j += body.charAt(j) === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(') {
      // `url(a;b)`, `var(--x, ;)`: not a declaration's end.
      let depth = 1;
      while (depth > 0 && ++i < body.length) depth += body.charAt(i) === '(' ? 1 : body.charAt(i) === ')' ? -1 : 0;
    } else if (c === '{') start = i + 1; // what came before is a nested selector or at-rule
    else if (c === ';' || c === '}' || i === body.length) {
      const decl = body.slice(start, i).trim();
      const at = decl.indexOf(':');
      if (at > 0 && /^(?:--[\w-]+|-?[a-z][a-z-]*)$/i.test(decl.slice(0, at).trim())) {
        const name = decl.slice(0, at).trim();
        out.add(name.startsWith('--') ? name : name.toLowerCase());
      }
      start = i + 1;
    }
  }
  return out;
}

/**
 * Which properties override each other, coarsely and on the safe side: a shorthand and its longhands (`padding`,
 * `padding-top`), physical and logical sides (`margin-left`, `margin-inline`), `inset` and `top`, `place-*` and
 * `align-*`… share a family. Custom properties only match themselves; `all` matches everything.
 */
function family(prop: string): string {
  if (prop.startsWith('--')) return prop;
  const p = prop.replace(/^-(?:webkit|moz|ms|o)-/, '');
  if (/^(?:top|right|bottom|left|inset)(?:-|$)/.test(p)) return 'inset';
  if (/^(?:min-|max-)?(?:width|height|inline-size|block-size)$/.test(p)) return 'size';
  if (/^(?:place|align|justify)-/.test(p)) return 'align';
  if (/^(?:gap|row-gap|column-gap|grid-(?:row-|column-)?gap)$/.test(p)) return 'gap';
  if (/^(?:font|line-height)(?:-|$)/.test(p)) return 'font';
  if (/^columns?(?:-|$)/.test(p)) return 'column';
  if (/^text-decoration(?:-|$)/.test(p)) return 'text-decoration';
  if (/^text-emphasis(?:-|$)/.test(p)) return 'text-emphasis';
  if (p.startsWith('text-')) return p;
  return p.split('-')[0] as string;
}

/** A property both sets would set, or null. */
export function overlap(a: Set<string>, b: Set<string>): string | null {
  if (a.size === 0 || b.size === 0) return null;
  if (a.has('all')) return 'all';
  if (b.has('all')) return 'all';
  const families = new Map<string, string>();
  for (const p of b) families.set(family(p), p);
  for (const p of a) {
    const theirs = families.get(family(p));
    if (theirs !== undefined) return p === theirs ? p : `${p} / ${theirs}`;
  }
  return null;
}

/**
 * Specificity of each selector of a list (a·10000 + b·100 + c), or null when it cannot be told simply
 * (`:is()`, `:not()`, `:has()`, `:where()`, `:nth-child(… of …)`): then any other rule may tie with it.
 */
export function specificities(prelude: string): number[] | null {
  const out: number[] = [];
  for (const selector of splitList(prelude)) {
    if (/:(?:is|not|has|where|matches|-\w+-any|nth-(?:last-)?child)\(/i.test(selector)) return null;
    const s = selector.replace(/"[^"]*"|'[^']*'/g, '""').replace(/\([^)]*\)/g, '()');
    const ids = (s.match(/#-?[_a-zA-Z -￿\\][\w -￿\\-]*/g) ?? []).length;
    const classes = (s.match(/\.-?[_a-zA-Z -￿\\][\w -￿\\-]*/g) ?? []).length + (s.match(/\[[^\]]*\]/g) ?? []).length;
    const pseudoElements = (s.match(/::[\w-]+|:(?:before|after|first-line|first-letter)\b/gi) ?? []).length;
    const pseudoClasses = (s.match(/(?<!:):(?!:)[\w-]+/g) ?? []).length - (s.match(/(?<!:):(?:before|after|first-line|first-letter)\b/gi) ?? []).length;
    const types = (s.replace(/\[[^\]]*\]/g, ' ').match(/(?:^|[\s>+~(])(?:[a-zA-Z][\w-]*)(?=$|[\s>+~.#:[)])/g) ?? []).length;
    out.push(ids * 10000 + (classes + pseudoClasses) * 100 + types + pseudoElements);
  }
  return out;
}

/** Whether two rules may tie on specificity, so that only their order decides. */
function mayTie(a: number[] | null, b: number[] | null): boolean {
  return a === null || b === null || a.some((x) => b.includes(x));
}

/**
 * The rules that can move without changing which declaration wins. Moved rules are printed after the global
 * sheets, so a rule that stays in the sheet further down, names the block or another class of the element
 * (`classes`), and sets the same property would lose to them: such a rule keeps its place, and so does every
 * earlier rule of the block it would have followed.
 */
export function safeToMove(css: string, movable: BlockRule[], classes: string[]): { move: BlockRule[]; keep: BlockRule[] } {
  const moving = new Set(movable.map((r) => r.from));
  const names = classes.map((c) => new RegExp(`\\.${escape(c)}(?![\\w-]|\\\\)`));
  const staying = rulesWhere(css, (prelude) => names.some((re) => re.test(prelude))).filter((r) => !moving.has(r.from));
  const keep: BlockRule[] = [];
  const move: BlockRule[] = [];
  for (const rule of movable) {
    const mine = properties(rule.body);
    const clash = staying.some((later) => {
      if (later.from < rule.to) return false;
      const text = css.slice(later.from, later.to);
      return overlap(mine, properties(text.slice(text.indexOf('{') + 1, -1))) !== null;
    });
    (clash ? keep : move).push(rule);
  }
  return { move, keep };
}

// ---- every block at once (docs/spec/styles.md §11): «Porta i blocchi nei selettori».

/** The block a class belongs to: its name before the first `__` or `--` (`card__title`, `card--dark` → `card`). */
export function blockOf(name: string): string {
  const at = name.search(/(?<=.)(?:__|--)/);
  return at > 0 ? name.slice(0, at) : name;
}

export interface KeptRule {
  sheet: string;
  selector: string;
  /** The rule that would lose its place: a selector, with `(selettore)` for one already in an entry. */
  against: string;
  property: string;
}

export interface SheetMovePlan {
  /** Blocks that move, in the order their entries are printed. */
  blocks: Array<{ block: string; selector: string; rules: number; body: string; existing: boolean }>;
  moved: number;
  /** Rules of used blocks that stay: the cascade would change (with the rule they would follow), or shared. */
  cascade: KeptRule[];
  shared: number;
  /** Blocks no document or template uses: their rules stay (classes added by scripts are not seen). */
  unused: { blocks: string[]; rules: number };
  /** What to write: the entries (new ones first, in this order, before the existing entries) and the sheets. */
  entries: Array<{ selector: string; css: string }>;
  sheets: Record<string, string>;
}

interface Placed {
  sheet: string;
  prelude: string;
  props: Set<string>;
  spec: number[] | null;
  /** Order in the page: sheets first, in order; then entries, in order. */
  pos: number;
  rule?: BlockRule;
  block?: string;
}

const MAX_RULES = 50000;

/** Every style rule of a CSS text, with what the cascade needs. @keyframes steps are not style rules. */
function placed(css: string, sheet: string, pos: () => number): Array<Placed & { from: number; to: number; within: string[] }> {
  return rulesWhere(css, () => true, MAX_RULES)
    .filter((r) => !r.within.some((w) => /^@(?:-\w+-)?keyframes\b/i.test(w)))
    .map((r) => {
      const text = css.slice(r.from, r.to);
      const brace = text.indexOf('{');
      const body = text.slice(brace + 1, -1);
      const prelude = text.slice(0, brace).trim();
      return { ...r, sheet, prelude, props: properties(body), spec: body.includes('{') ? null : specificities(prelude), pos: pos() };
    });
}

/**
 * Whether the compiler prints the moved rule after the rest of its entry: compileCss writes the BEM parts of a body
 * (`&__title`, `&--dark`, also inside @media) after everything else, as sibling rules. So in one entry a BEM part
 * followed in the sheet by a rule that is not one (`& a[aria-current]`, `&:hover`, the block itself) would swap
 * places with it.
 */
function isHoisted(r: Placed): boolean {
  const parts = splitList(r.rule?.rel ?? '');
  return parts.length > 0 && parts.every((part) => /^&(?:__|--)/.test(part));
}

/**
 * Moves every used block's rules from the global sheets into its selector entry, keeping the cascade.
 *
 * Blocks are taken in the order they first appear. A new entry goes before the existing ones (the sheets came
 * before every entry), and the rules moved into an existing entry go before its own CSS. A rule stays in the sheet
 * when a rule that came after it, setting a property of the same family with a specificity that may tie, would
 * print before it once moved: a rule that stays in a sheet (shared lists, other blocks, unused blocks, other
 * sheets), a rule of another block whose entry prints earlier, or an entry printed earlier, or, in its own entry, a
 * rule that is not a BEM part when this one is (isHoisted: the compiler would print the BEM part after it). Rules kept this way
 * stay too for the earlier rules, until nothing changes. `only` limits the move to one sheet (the others count
 * for the cascade); `used` are the classes that documents and templates use.
 */
export function planSheetMove(
  sheets: Array<{ id: string; css: string }>,
  styles: Array<{ selector: string; css: string }>,
  used: Set<string>,
  only?: string,
): SheetMovePlan {
  let counter = 0;
  const next = () => counter++;
  const usedBlocks = new Set([...used].map(blockOf));
  const rules: Placed[] = [];
  const first = new Map<string, number>();
  const unused = new Map<string, number>();
  let shared = 0;
  for (const sheet of sheets) {
    for (const r of placed(sheet.css, sheet.id, next)) {
      const entry: Placed = r;
      rules.push(entry);
      if (only !== undefined && sheet.id !== only) continue;
      const lead = /^\.(-?[_a-zA-Z][\w-]*)(?![\w-]|\\)/.exec(r.prelude);
      const block = lead ? blockOf(lead[1] as string) : null;
      const moving = block ? asBlockRule(sheet.css, r, block, sheet.id) : null;
      if (block && moving) {
        if (!usedBlocks.has(block)) {
          unused.set(block, (unused.get(block) ?? 0) + 1);
          continue;
        }
        entry.rule = moving;
        entry.block = block;
        if (!first.has(block)) first.set(block, r.pos);
      } else if ([...r.prelude.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]/g, ' ').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].some((m) => usedBlocks.has(blockOf(m[1] as string)))) {
        shared++;
      }
    }
  }

  // Where each block's entry prints: new entries first (in order of appearance), then the existing ones.
  const existing = new Map(styles.map((s, i) => [s.selector, i]));
  const fresh = [...first.keys()].filter((b) => !existing.has(`.${b}`));
  const rank = (block: string) => {
    const at = existing.get(`.${block}`);
    return at === undefined ? fresh.indexOf(block) : fresh.length + at;
  };
  // Entries' own rules, already printed after every sheet: they matter to the rules moved into a later entry.
  const entryRules = styles.flatMap((s, i) => placed(compileCss(s.selector, s.css), s.selector, next).map((r) => ({ ...r, rank: fresh.length + i })));

  // Rules by property family, to look only at those that may override each other.
  const byFamily = new Map<string, Placed[]>();
  for (const r of rules) {
    for (const f of new Set([...r.props].map(family))) {
      const list = byFamily.get(f);
      if (list) list.push(r);
      else byFamily.set(f, [r]);
    }
  }
  const candidates = (r: Placed) => (r.props.has('all') ? rules : [...new Set([...r.props].map(family)), 'all'].flatMap((f) => byFamily.get(f) ?? []));
  const moving = new Set(rules.filter((r) => r.rule));
  const cascade: KeptRule[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    // From the bottom up: a rule kept in the sheet is known before the earlier rules it may hold back.
    for (const r of [...rules].reverse()) {
      if (!moving.has(r)) continue;
      const mine = rank(r.block as string);
      let against: { selector: string; property: string } | null = null;
      for (const later of candidates(r)) {
        if (later.pos <= r.pos) continue;
        const before = !moving.has(later) || rank(later.block as string) < mine || (later.block === r.block && isHoisted(r) && !isHoisted(later));
        if (!before || !mayTie(r.spec, later.spec)) continue;
        const property = overlap(r.props, later.props);
        if (property) {
          against = { selector: later.prelude, property };
          break;
        }
      }
      if (!against) {
        for (const own of entryRules) {
          if (own.rank >= mine || !mayTie(r.spec, own.spec)) continue;
          const property = overlap(r.props, own.props);
          if (property) {
            against = { selector: `${own.prelude} (selettore ${own.sheet})`, property };
            break;
          }
        }
      }
      if (against) {
        moving.delete(r);
        cascade.push({ sheet: r.sheet, selector: r.prelude, against: against.selector, property: against.property });
        changed = true;
      }
    }
  }

  const blocks: SheetMovePlan['blocks'] = [];
  const entries: SheetMovePlan['entries'] = [];
  const order = [...first.keys()].sort((a, b) => rank(a) - rank(b));
  for (const block of order) {
    const mine = rules.filter((r) => moving.has(r) && r.block === block).map((r) => r.rule as BlockRule);
    if (mine.length === 0) continue;
    const selector = `.${block}`;
    const body = nestedBody(mine);
    const own = styles[existing.get(selector) ?? -1]?.css ?? '';
    blocks.push({ block, selector, rules: mine.length, body, existing: existing.has(selector) });
    entries.push({ selector, css: `${body}\n${own.trim() === '' ? '' : `${own.trim()}\n`}` });
  }
  const out: Record<string, string> = {};
  for (const sheet of sheets) {
    const gone = rules.filter((r) => moving.has(r) && r.sheet === sheet.id).map((r) => r.rule as BlockRule);
    if (gone.length > 0) out[sheet.id] = withoutRules(sheet.css, gone);
  }
  return {
    blocks,
    moved: moving.size,
    cascade: cascade.sort((a, b) => a.selector.localeCompare(b.selector)),
    shared,
    unused: { blocks: [...unused.keys()], rules: [...unused.values()].reduce((a, b) => a + b, 0) },
    entries,
    sheets: out,
  };
}
