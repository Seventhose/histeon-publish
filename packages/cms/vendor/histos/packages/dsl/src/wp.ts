import { parse as parseGrammar } from '@wordpress/block-serialization-default-parser';
import { randomUid, UID_PATTERN, type UidFactory } from './uid.ts';
import { ATTRIBUTE_NAME_PATTERN, COMPONENT_REF_PATTERN, GROUP_BY_FIELD_PATTERN, GROUP_BY_HOW_PATTERN, IDENTIFIER_PATTERN, RESERVED_NAMES, SLOT_NAME_PATTERN, TAG_PATTERN } from './names.ts';
import {
  childrenOf,
  DEFAULT_SLOT,
  MAX_NESTING,
  type AttrValue,
  type BranchBlock,
  type LoopGroupBy,
  type LoopSource,
  type PropValue,
  type SlotFillBlock,
  type XbBlock,
} from './tree.ts';

/** Shape produced by @wordpress/block-serialization-default-parser (and PHP parse_blocks). */
export interface ParsedBlock {
  blockName: string | null;
  attrs: Record<string, unknown> | null;
  innerBlocks: ParsedBlock[];
  innerHTML: string;
  innerContent: Array<string | null>;
}

export function parseBlockGrammar(document: string): ParsedBlock[] {
  return parseGrammar(document) as ParsedBlock[];
}

/** Same escaping as core serialize_block_attributes() / @wordpress/blocks. */
export function serializeAttributes(attrs: Record<string, unknown>): string {
  return JSON.stringify(attrs)
    .replace(/--/g, '\\u002d\\u002d')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\"/g, '\\u0022');
}

/** Mirrors core get_comment_delimited_block_content(). */
export function commentDelimited(name: string, attrs: Record<string, unknown> | null, content: string): string {
  const serializedName = name.startsWith('core/') ? name.slice(5) : name;
  const serializedAttrs = attrs && Object.keys(attrs).length > 0 ? serializeAttributes(attrs) + ' ' : '';
  return content === ''
    ? `<!-- wp:${serializedName} ${serializedAttrs}/-->`
    : `<!-- wp:${serializedName} ${serializedAttrs}-->${content}<!-- /wp:${serializedName} -->`;
}

/** Mirrors core serialize_block(). */
export function serializeParsedBlock(block: ParsedBlock): string {
  if (block.blockName === null) return block.innerHTML;
  let next = 0;
  let content = '';
  for (const chunk of block.innerContent) {
    if (chunk === null) {
      const inner = block.innerBlocks[next++];
      if (inner) content += serializeParsedBlock(inner);
    } else {
      content += chunk;
    }
  }
  return commentDelimited(block.blockName, block.attrs, content);
}

function isEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0;
}

/**
 * Attributes in canonical key order, empty maps and undefined values dropped
 * (PHP would turn an empty `{}` into `[]` on re-save).
 */
export function canonicalAttrs(block: XbBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && isEmptyRecord(value as Record<string, unknown>)) return;
    out[key] = value;
  };
  put('uid', block.attrs.uid);
  switch (block.name) {
    case 'xb/element':
      put('tag', block.attrs.tag);
      put('label', block.attrs.label);
      put('attributes', block.attrs.attributes);
      break;
    case 'xb/text':
      put('content', block.attrs.content);
      put('verbatim', block.attrs.verbatim);
      break;
    case 'xb/branch':
      put('test', block.attrs.test);
      break;
    case 'xb/loop': {
      const s = block.attrs.source;
      put(
        'source',
        s.kind === 'preset'
          ? {
              kind: 'preset',
              id: s.id,
              ...(isEmptyRecord(s.args) ? {} : { args: s.args }),
              ...(s.groupBy ? { groupBy: s.groupBy.how === undefined ? { field: s.groupBy.field } : { field: s.groupBy.field, how: s.groupBy.how } } : {}),
            }
          : { kind: 'expr', expr: s.expr },
      );
      put('as', block.attrs.as);
      put('index', block.attrs.index);
      break;
    }
    case 'xb/component':
      put('ref', block.attrs.ref);
      put('label', block.attrs.label);
      put('props', block.attrs.props);
      break;
    case 'xb/slot':
    case 'xb/slot-fill':
      put('name', block.attrs.name);
      break;
    case 'xb/raw':
      put('content', block.attrs.content);
      break;
    default:
      break;
  }
  return out;
}

export function serializeXb(blocks: XbBlock[]): string {
  return blocks.map(serializeXbBlock).join('');
}

/**
 * Markup of blocks that cannot change any more. The editor keeps its tree frozen and shares the untouched parts
 * between edits, so after an edit only the changed branch is serialized again, not the page.
 */
const serialized = new WeakMap<XbBlock, string>();

/** Frozen, with its attributes and children: what `serialized` may remember. */
function unchanging(block: XbBlock): boolean {
  const children = (block as { children?: unknown }).children;
  return (
    Object.isFrozen(block) &&
    Object.isFrozen(block.attrs) &&
    Object.values(block.attrs).every((v) => typeof v !== 'object' || v === null || Object.isFrozen(v)) &&
    (children === undefined || Object.isFrozen(children))
  );
}

function serializeXbBlock(block: XbBlock): string {
  const known = serialized.get(block);
  if (known !== undefined) return known;
  const content = block.name === 'xb/passthrough' ? block.raw : childrenOf(block).map(serializeXbBlock).join('');
  const markup = commentDelimited(block.name, canonicalAttrs(block), content);
  if (unchanging(block)) serialized.set(block, markup);
  return markup;
}

export interface ParseXbResult {
  blocks: XbBlock[];
  /** Non-fatal repairs (new uids, wrapped foreign blocks, dropped stray HTML). */
  issues: string[];
}

/** Reads post_content into an XB tree, repairing what Gutenberg or other tools may have changed. */
export function parseXb(document: string, uid: UidFactory = randomUid): ParseXbResult {
  const issues: string[] = [];
  const seen = new Set<string>();

  const takeUid = (candidate: unknown, where: string): string => {
    if (typeof candidate === 'string' && UID_PATTERN.test(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
    let fresh = uid();
    while (seen.has(fresh)) fresh = uid();
    seen.add(fresh);
    issues.push(`${where}: uid ${candidate === undefined ? 'mancante' : 'non valido o duplicato'}, assegnato ${fresh}`);
    return fresh;
  };

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const shown = (s: string): string => JSON.stringify(s.slice(0, 40));
  const name = (v: unknown, pattern: RegExp): string | undefined =>
    typeof v === 'string' && pattern.test(v) && !RESERVED_NAMES.has(v) ? v : undefined;

  // Stored attributes are untrusted input: every name and value is checked against the same rules as the DSL,
  // so nothing reaches the printer (and from there the parser) that the parser itself would not produce.
  const attributesOf = (v: unknown, where: string): Record<string, AttrValue> | undefined => {
    if (v === undefined) return undefined;
    if (!plain(v)) {
      issues.push(`${where}: attributi non validi, rimossi`);
      return undefined;
    }
    const out: Record<string, AttrValue> = {};
    for (const [key, value] of Object.entries(v)) {
      if (name(key, ATTRIBUTE_NAME_PATTERN) === undefined || key.startsWith('xb:') || !(typeof value === 'string' || value === true)) {
        issues.push(`${where}: attributo ${shown(key)} non valido, rimosso`);
        continue;
      }
      out[key] = value;
    }
    return isEmptyRecord(out) ? undefined : out;
  };

  const propValue = (v: unknown): PropValue | undefined => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (plain(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && typeof v.expr === 'string') return { expr: v.expr };
      if (keys.length === 1 && typeof v.tpl === 'string') return { tpl: v.tpl };
    }
    return undefined;
  };

  const propsOf = (v: unknown, where: string): Record<string, PropValue> | undefined => {
    if (v === undefined) return undefined;
    if (!plain(v)) {
      issues.push(`${where}: props non valide, rimosse`);
      return undefined;
    }
    const out: Record<string, PropValue> = {};
    for (const [key, value] of Object.entries(v)) {
      const checked = propValue(value);
      if (name(key, IDENTIFIER_PATTERN) === undefined || checked === undefined) {
        issues.push(`${where}: prop ${shown(key)} non valida, rimossa`);
        continue;
      }
      out[key] = checked;
    }
    return isEmptyRecord(out) ? undefined : out;
  };

  const sourceOf = (v: unknown, where: string): LoopSource => {
    if (plain(v) && v.kind === 'expr' && typeof v.expr === 'string') return { kind: 'expr', expr: v.expr };
    if (plain(v) && v.kind === 'preset' && name(v.id, IDENTIFIER_PATTERN) !== undefined) {
      // A grouped query loop (doc 23 of Publish, item 187): `groupBy` is {field, how?} with the rules of the DSL.
      const group = v.groupBy;
      let groupBy: LoopGroupBy | undefined;
      if (group !== undefined) {
        if (
          !plain(group) ||
          Object.keys(group).some((key) => key !== 'field' && key !== 'how') ||
          typeof group.field !== 'string' ||
          !GROUP_BY_FIELD_PATTERN.test(group.field) ||
          (group.how !== undefined && (typeof group.how !== 'string' || !GROUP_BY_HOW_PATTERN.test(group.how)))
        ) {
          issues.push(`${where}: raggruppamento della query non valido, sostituito con []`);
          return { kind: 'expr', expr: '[]' };
        }
        groupBy = group.how === undefined ? { field: group.field } : { field: group.field, how: group.how as string };
      }
      const grouped = groupBy ? { groupBy } : {};
      if (v.args === undefined) return { kind: 'preset', id: v.id as string, ...grouped };
      if (plain(v.args) && Object.entries(v.args).every(([k, a]) => name(k, IDENTIFIER_PATTERN) !== undefined && typeof a === 'string')) {
        return { kind: 'preset', id: v.id as string, args: { ...(v.args as Record<string, string>) }, ...grouped };
      }
    }
    issues.push(`${where}: sorgente non valida, sostituita con []`);
    return { kind: 'expr', expr: '[]' };
  };

  const slotName = (v: unknown, where: string): string => {
    if (v === undefined) return DEFAULT_SLOT;
    const checked = name(v, SLOT_NAME_PATTERN);
    if (checked === undefined) issues.push(`${where}: nome di slot non valido, uso "${DEFAULT_SLOT}"`);
    return checked ?? DEFAULT_SLOT;
  };

  let depth = 0;
  const convertList = (list: ParsedBlock[]): XbBlock[] => {
    if (++depth > MAX_NESTING) throw new RangeError(`Documento annidato oltre ${MAX_NESTING} livelli`);
    try {
      return list.flatMap((p) => {
        const b = convert(p);
        return b ? [b] : [];
      });
    } finally {
      depth--;
    }
  };

  const convert = (p: ParsedBlock): XbBlock | null => {
    if (p.blockName === null) {
      if (p.innerHTML.trim() === '') return null;
      issues.push('HTML fuori dai blocchi convertito in xb/raw');
      return { name: 'xb/raw', attrs: { uid: takeUid(undefined, 'xb/raw'), content: p.innerHTML } };
    }
    if (!p.blockName.startsWith('xb/')) {
      return { name: 'xb/passthrough', attrs: { uid: takeUid(undefined, p.blockName) }, raw: serializeParsedBlock(p) };
    }
    const a: Record<string, unknown> = plain(p.attrs) ? p.attrs : {};
    const blockName = p.blockName;
    if (p.innerContent.some((c) => c !== null && c.trim() !== '')) {
      issues.push(`${blockName}: HTML statico ignorato (i blocchi xb sono dinamici)`);
    }
    const id = takeUid(a.uid, blockName);
    switch (blockName) {
      case 'xb/element': {
        const tag = name(a.tag, TAG_PATTERN);
        if (!tag) issues.push(`${blockName} ${id}: tag mancante o non valido, uso "div"`);
        const attributes = attributesOf(a.attributes, `${blockName} ${id}`);
        const attrs: { uid: string; tag: string; label?: string; attributes?: Record<string, AttrValue> } = {
          uid: id,
          tag: tag ?? 'div',
        };
        if (str(a.label) !== undefined) attrs.label = a.label as string;
        if (attributes) attrs.attributes = attributes;
        return { name: blockName, attrs, children: convertList(p.innerBlocks) };
      }
      case 'xb/text':
        return {
          name: blockName,
          attrs: a.verbatim === true ? { uid: id, content: str(a.content) ?? '', verbatim: true } : { uid: id, content: str(a.content) ?? '' },
        };
      case 'xb/if':
        return {
          name: blockName,
          attrs: { uid: id },
          children: convertList(p.innerBlocks).filter((c): c is BranchBlock => {
            if (c.name === 'xb/branch') return true;
            issues.push(`xb/if ${id}: figlio ${c.name} rimosso (ammessi solo xb/branch)`);
            return false;
          }),
        };
      case 'xb/branch':
        return {
          name: blockName,
          attrs: str(a.test) !== undefined ? { uid: id, test: a.test as string } : { uid: id },
          children: convertList(p.innerBlocks),
        };
      case 'xb/loop': {
        const attrs: { uid: string; source: LoopSource; as: string; index?: string } = {
          uid: id,
          source: sourceOf(a.source, `${blockName} ${id}`),
          as: name(a.as, IDENTIFIER_PATTERN) ?? 'item',
        };
        const index = name(a.index, IDENTIFIER_PATTERN);
        if (index !== undefined) attrs.index = index;
        const children = convertList(p.innerBlocks);
        // A branch in a loop is its `{:else}`: only one, last, without a test.
        const kept = children.filter((c, i) => {
          if (c.name !== 'xb/branch' || (i === children.length - 1 && c.attrs.test === undefined)) return true;
          issues.push(`xb/loop ${id}: ramo ${c.attrs.uid} rimosso (in un loop è ammesso solo {:else}, in fondo)`);
          return false;
        });
        return { name: blockName, attrs, children: kept };
      }
      case 'xb/component': {
        const ref = typeof a.ref === 'string' && COMPONENT_REF_PATTERN.test(a.ref) ? a.ref : undefined;
        if (!ref) issues.push(`${blockName} ${id}: ref mancante o non valido`);
        const attrs: { uid: string; ref: string; label?: string; props?: Record<string, PropValue> } = { uid: id, ref: ref ?? '' };
        if (str(a.label) !== undefined) attrs.label = a.label as string;
        const props = propsOf(a.props, `${blockName} ${id}`);
        if (props) attrs.props = props;
        return {
          name: blockName,
          attrs,
          children: convertList(p.innerBlocks).filter((c): c is SlotFillBlock => {
            if (c.name === 'xb/slot-fill') return true;
            issues.push(`xb/component ${id}: figlio ${c.name} rimosso (ammessi solo xb/slot-fill)`);
            return false;
          }),
        };
      }
      case 'xb/slot':
        return { name: blockName, attrs: { uid: id, name: slotName(a.name, `${blockName} ${id}`) } };
      case 'xb/slot-fill':
        return { name: blockName, attrs: { uid: id, name: slotName(a.name, `${blockName} ${id}`) }, children: convertList(p.innerBlocks) };
      case 'xb/raw':
        return { name: blockName, attrs: { uid: id, content: str(a.content) ?? '' } };
      case 'xb/passthrough': {
        const inner = p.innerBlocks.find((b) => b.blockName !== null);
        if (!inner) {
          issues.push(`xb/passthrough ${id}: vuoto, rimosso`);
          return null;
        }
        if (p.innerBlocks.length > 1) issues.push(`xb/passthrough ${id}: più blocchi interni, tenuto solo il primo`);
        return { name: blockName, attrs: { uid: id }, raw: serializeParsedBlock(inner) };
      }
      case 'xb/post-content':
        return { name: blockName, attrs: { uid: id } };
      default:
        issues.push(`${blockName}: blocco xb sconosciuto, conservato come passthrough`);
        return { name: 'xb/passthrough', attrs: { uid: id }, raw: serializeParsedBlock(p) };
    }
  };

  return { blocks: convertList(parseBlockGrammar(document)), issues };
}
