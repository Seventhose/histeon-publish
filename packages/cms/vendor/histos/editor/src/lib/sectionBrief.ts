import { childrenOf, type XbBlock } from '@xb/dsl';
import { clipBlocks, type Clip } from './clip.ts';

// A library section as instructions for the agent (lista della spesa 166): instead of its markup, which would bring
// the other site's classes and fixed values along, the agent reads what the section is made of (its parts, their
// role and content) and how it is laid out, with every fixed size and colour written next to the nearest token of
// this project. It rebuilds the section in the project's own way. Pure functions over the clip.

export interface BriefVariable {
  name: string;
  group: string;
  value?: string;
}

const LAYOUT = /^(display|grid-template-columns|grid-template-rows|grid-auto-flow|flex-direction|flex-wrap|justify-content|align-items|gap|row-gap|column-gap|padding|padding-block|padding-inline|margin|margin-block|max-width|min-height|text-align|font-size|font-weight|line-height|color|background|background-color|border-radius|box-shadow|aspect-ratio|object-fit)$/;

/** A length in px (rem and em at 16px). */
function px(value: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem|em)$/.exec(value.trim());
  if (!m) return null;
  return m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16;
}

/** The project's token nearest to a fixed length or colour, among the variables whose value is known. */
export function nearestToken(value: string, variables: BriefVariable[], property: string): string | null {
  const v = value.trim();
  if (/var\(/.test(v)) return null;
  const length = px(v);
  if (length !== null) {
    const group = /font-size/.test(property) ? /text|font|size/i : /radius/.test(property) ? /radius|round/i : /space|gap|pad|spacing/i;
    let best: { name: string; diff: number } | null = null;
    for (const variable of variables) {
      const own = variable.value ? px(variable.value) : null;
      if (own === null || !group.test(`${variable.group} ${variable.name}`)) continue;
      const diff = Math.abs(own - length);
      if (!best || diff < best.diff) best = { name: variable.name, diff };
    }
    return best && best.diff <= Math.max(4, length * 0.25) ? `--${best.name.replace(/^--/, '')}` : null;
  }
  if (/^(#[0-9a-f]{3,8}|rgb|hsl|oklch)/i.test(v)) {
    const exact = variables.find((x) => x.value?.trim().toLowerCase() === v.toLowerCase());
    return exact ? `--${exact.name.replace(/^--/, '')}` : 'un colore del progetto (vedi il brief)';
  }
  return null;
}

/** BEM role of a class: block, part of a block, or variant. */
function role(cls: string): string {
  if (cls.includes('__')) return `parte «${cls.split('__')[1]}» del blocco`;
  if (cls.includes('--')) return `variante «${cls.split('--')[1]}»`;
  return 'blocco';
}

function describeContent(block: XbBlock): string {
  if (block.name !== 'xb/element') return '';
  const tag = block.attrs.tag;
  if (/^h[1-6]$/.test(tag)) return 'titolo';
  if (tag === 'p') return 'paragrafo';
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'pulsante';
  if (tag === 'img') return 'immagine (con il suo alt)';
  if (tag === 'ul' || tag === 'ol') return 'elenco';
  if (tag === 'li') return 'voce di elenco';
  return '';
}

function outline(blocks: XbBlock[], depth: number, out: string[], seen: { n: number }): void {
  for (const block of blocks) {
    if (seen.n >= 80) return;
    seen.n += 1;
    const pad = '  '.repeat(depth);
    if (block.name === 'xb/element') {
      const cls = typeof block.attrs.attributes?.class === 'string' ? block.attrs.attributes.class.split(/\s+/).filter((c) => c && !c.includes('{'))[0] : undefined;
      const what = [describeContent(block), cls ? `${role(cls)} (nell'originale .${cls})` : ''].filter(Boolean).join(', ');
      out.push(`${pad}- <${block.attrs.tag}>${what ? `: ${what}` : ''}`);
    } else if (block.name === 'xb/loop') {
      out.push(`${pad}- un loop: ripete ciò che segue per ogni elemento di una query (scegli una query di questo sito)`);
    } else if (block.name === 'xb/component') {
      out.push(`${pad}- il componente ${String((block.attrs as { ref?: string }).ref ?? '')}: usalo se esiste qui, altrimenti ricostruiscilo`);
    } else if (block.name === 'xb/if') {
      out.push(`${pad}- una condizione: una parte che si vede solo in certi casi`);
    } else if (block.name === 'xb/text') {
      continue;
    }
    const children = childrenOf(block);
    if (children.length) outline(children, depth + 1, out, seen);
  }
}

/** Top-level declarations of a selector's CSS that say how the section is laid out, with the nearest tokens. */
function layout(selector: string, css: string, variables: BriefVariable[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of css.split('\n')) {
    if (depth === 0) {
      const m = /^\s*([a-z-]+)\s*:\s*([^;{}]+);/.exec(line);
      if (m && LAYOUT.test(m[1]!)) {
        const parts = m[2]!.trim().split(/\s+/);
        const tokens = parts.map((p) => nearestToken(p, variables, m[1]!)).filter((x): x is string => !!x);
        out.push(`  - ${m[1]}: ${m[2]!.trim()}${tokens.length ? ` → nel progetto: ${[...new Set(tokens)].join(', ')}` : ''}`);
      }
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  }
  return out.length ? [`- ${selector}`, ...out.slice(0, 16)] : [];
}

/** The brief of a library section: what it is made of, how it is laid out, and the rule to rebuild it here. */
export function sectionBrief(name: string, clip: Clip, variables: BriefVariable[]): string {
  const blocks = clipBlocks(clip).blocks;
  const tree: string[] = [];
  outline(blocks, 0, tree, { n: 0 });
  const styles = clip.styles.flatMap((s) => layout(s.selector, s.css, variables)).slice(0, 120);
  return [
    `Sezione della libreria «${name}» (da ${clip.origin}). Non copiarne il markup né le classi: ricostruiscila in questa pagina con classi BEM nuove scritte per lei e con i token di questo progetto (nomi esatti nel brief).`,
    '',
    'Com\'è fatta:',
    ...tree,
    '',
    'Disposizione nell\'originale (i valori fissi vanno sostituiti con il token indicato, o con il più adatto del brief):',
    ...(styles.length ? styles : ['- nessuno stile di disposizione: decidi tu, con i token del progetto']),
    '',
    'I testi dell\'originale sono esempi: tienili se l\'utente non dice altro, ma in un loop leggi i dati con le espressioni.',
  ].join('\n');
}
