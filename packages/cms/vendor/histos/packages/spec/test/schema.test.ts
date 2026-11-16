import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse, sequentialUids, type XbBlock } from '@xb/dsl';
import schema from '../schemas/blocks.schema.json' with { type: 'json' };
import manifestSchema from '../schemas/site-transfer-v2.schema.json' with { type: 'json' };
import entitySchema from '../schemas/site-entity-v2.schema.json' with { type: 'json' };
import referenceSchema from '../schemas/site-reference-v2.schema.json' with { type: 'json' };
import profileSchema from '../schemas/histos-static-page-v1.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, allowUnionTypes: true });
const validate = ajv.compile(schema);
// Strict as Histeon Publish compiles them: a schema it refuses must not pass here.
const transferAjv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
transferAjv.addSchema(manifestSchema);
transferAjv.addSchema(entitySchema);
transferAjv.addSchema(referenceSchema);
const validateManifest = transferAjv.compile(manifestSchema);
const validateEntity = transferAjv.compile(entitySchema);
const validateReference = transferAjv.compile(referenceSchema);
const validateProfile = transferAjv.compile(profileSchema);

const fixturesDir = join(import.meta.dirname, '../../dsl/test/fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.xb'));

describe('every tree produced by the reference parser matches the schema', () => {
  it.each(fixtures)('%s', (file) => {
    const { blocks } = parse(readFileSync(join(fixturesDir, file), 'utf8'), { uid: sequentialUids() });
    for (const block of blocks) {
      const ok = validate(block);
      expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
    }
  });
});

describe('schema rejects invalid blocks', () => {
  const element = (attrs: Record<string, unknown>, children: XbBlock[] = []) => ({
    name: 'xb/element',
    attrs: { uid: 'aaaaaaaa', tag: 'div', ...attrs },
    children,
  });

  it.each([
    ['bad uid', element({ uid: 'X' })],
    ['uppercase first letter in tag', element({ tag: 'Div' })],
    ['pseudo attribute stored as attribute', element({ attributes: { 'xb:label': 'x' } })],
    ['attribute name with quote', element({ attributes: { 'a"b': 'x' } })],
    ['void element with children', element({ tag: 'img' }, [{ name: 'xb/text', attrs: { uid: 'bbbbbbbb', content: 'x' } }])],
    ['empty text', { name: 'xb/text', attrs: { uid: 'aaaaaaaa', content: '' } }],
    ['if whose first branch has no test', { name: 'xb/if', attrs: { uid: 'aaaaaaaa' }, children: [{ name: 'xb/branch', attrs: { uid: 'bbbbbbbb' }, children: [] }] }],
    ['component with post-id ref', { name: 'xb/component', attrs: { uid: 'aaaaaaaa', ref: '123' }, children: [] }],
    ['component child that is not a slot fill', { name: 'xb/component', attrs: { uid: 'aaaaaaaa', ref: 'card' }, children: [element({})] }],
    ['raw containing its own terminator', { name: 'xb/raw', attrs: { uid: 'aaaaaaaa', content: 'a{/raw}' } }],
    ['passthrough wrapping an xb block', { name: 'xb/passthrough', attrs: { uid: 'aaaaaaaa' }, raw: '<!-- wp:xb/text /-->' }],
    ['unknown block', { name: 'xb/unknown', attrs: { uid: 'aaaaaaaa' } }],
    ['grouped loop without a field', { name: 'xb/loop', attrs: { uid: 'aaaaaaaa', source: { kind: 'preset', id: 'foto', groupBy: { how: 'Y' } }, as: 'g' }, children: [] }],
    ['grouped loop with a field with spaces', { name: 'xb/loop', attrs: { uid: 'aaaaaaaa', source: { kind: 'preset', id: 'foto', groupBy: { field: 'a b' } }, as: 'g' }, children: [] }],
    ['grouped loop with an empty mode', { name: 'xb/loop', attrs: { uid: 'aaaaaaaa', source: { kind: 'preset', id: 'foto', groupBy: { field: 'a', how: '' } }, as: 'g' }, children: [] }],
    ['grouped loop with another key', { name: 'xb/loop', attrs: { uid: 'aaaaaaaa', source: { kind: 'preset', id: 'foto', groupBy: { field: 'a', order: 'desc' } }, as: 'g' }, children: [] }],
    ['grouped expression loop', { name: 'xb/loop', attrs: { uid: 'aaaaaaaa', source: { kind: 'expr', expr: 'props.items', groupBy: { field: 'a' } }, as: 'g' }, children: [] }],
  ])('%s', (_name, block) => {
    expect(validate(block)).toBe(false);
  });
});

describe('grouped query loops (doc 23 of Publish, item 187)', () => {
  it('match the schema as the parser writes them', () => {
    const { blocks } = parse('{#loop foto(limit: 20).groupBy("publishedAt", "F Y") as g}<h2>{g.key}</h2>{/loop}{#loop foto().groupBy("title", "letter") as l}{/loop}', { uid: sequentialUids() });
    for (const block of blocks) expect(validate(block), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('shared Histos site-transfer schemas', () => {
  const manifest = {
    format: 'xb-site', version: 2,
    generator: { name: 'Histos CMS', version: '0.1.0', engineCommit: '9bc212050403dd056ac21edfcff398b514e4a3c1' },
    project: { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Fixture' },
    selection: { kind: 'workspace-head', snapshot: '550e8400-e29b-41d4-a716-446655440002' },
    requiredCapabilities: ['documents:page:v1', 'styles:global:v1', 'media:asset:v1'],
    profile: 'histos-static-page-v1',
    files: [
      { path: 'entities.ndjson', bytes: 1, sha256: 'a'.repeat(64) },
      { path: 'references.ndjson', bytes: 0, sha256: 'b'.repeat(64) },
    ],
    manifestHash: 'c'.repeat(64),
  };
  const entity = {
    id: '550e8400-e29b-41d4-a716-446655440003', kind: 'document', schemaVersion: 1,
    revisionHash: 'd'.repeat(64),
    payload: { documentType: 'page', title: 'Home', slug: 'home', status: 'draft', content: '', script: '' },
  };

  it('compiles and validates the manifest, entity, reference, and aggregate profile schemas', () => {
    const reference = {
      ownerId: entity.id, blockUid: 'abcdefgh', path: 'attrs.src',
      targetId: '550e8400-e29b-41d4-a716-446655440004', role: 'media',
    };
    expect(validateManifest(manifest), JSON.stringify(validateManifest.errors)).toBe(true);
    expect(validateEntity(entity), JSON.stringify(validateEntity.errors)).toBe(true);
    expect(validateReference(reference), JSON.stringify(validateReference.errors)).toBe(true);
    expect(validateProfile({ manifest, entities: [entity], references: [] }), JSON.stringify(validateProfile.errors)).toBe(true);
  });
  it('accepts posts and template roles, and refuses them where they do not belong', () => {
    const post = {
      ...entity, id: '550e8400-e29b-41d4-a716-446655440005',
      payload: { documentType: 'post', title: 'Notizia', slug: 'notizia', status: 'published', content: '', script: '', publishedAt: '2026-10-25T10:00:00Z', excerpt: 'Breve.', terms: { category: ['550e8400-e29b-41d4-a716-446655440006'] } },
    };
    expect(validateEntity(post), JSON.stringify(validateEntity.errors)).toBe(true);
    expect(validateEntity({ ...post, payload: { ...post.payload, publishedAt: '25/10/2026' } })).toBe(false);
    expect(validateEntity({ ...post, payload: { ...post.payload, slug: 'Notizia Uno' } })).toBe(false);
    const { terms: _terms, ...withoutTerms } = post.payload;
    expect(validateEntity({ ...post, payload: withoutTerms })).toBe(false);
    expect(validateEntity({ ...entity, payload: { ...entity.payload, excerpt: '' } })).toBe(false);
    const template = {
      id: '550e8400-e29b-41d4-a716-446655440007', kind: 'template', schemaVersion: 1, revisionHash: 'e'.repeat(64),
      payload: { title: 'Articolo', ref: 'theme-template/single', schema: { props: {} }, content: '', script: '', role: 'single' },
    };
    expect(validateEntity(template), JSON.stringify(validateEntity.errors)).toBe(true);
    expect(validateEntity({ ...template, payload: { ...template.payload, role: 'author' } })).toBe(false);
    expect(validateEntity({ ...template, kind: 'component', payload: { ...template.payload } })).toBe(false);
    const type = { id: '550e8400-e29b-41d4-a716-446655440008', kind: 'content-type', schemaVersion: 1, revisionHash: 'f'.repeat(64), payload: { key: 'evento', label: 'Eventi', fields: [] } };
    expect(validateEntity(type), JSON.stringify(validateEntity.errors)).toBe(true);
    expect(validateEntity({ ...type, payload: { ...type.payload, key: 'post' } })).toBe(false);
    expect(validateManifest({ ...manifest, profile: 'histos-static-project-v4' }), JSON.stringify(validateManifest.errors)).toBe(true);
  });
  it('takes every Histeon CSS design parameter in the styles entity, and only names shaped like one', () => {
    // The parameters are DesignData's (generated from Publish's design-data.json): the schema bounds their shape and
    // number, Design::validate their meaning. A fixed list here fell behind the panel once (role_bg, role_link…).
    const php = readFileSync(join(import.meta.dirname, '../../../plugin/src/Framework/HistosCss/DesignData.php'), 'utf8');
    const start = php.indexOf('public const DEFAULTS = array(');
    const defaults = Object.fromEntries([...php.slice(start, php.indexOf(');\n\n', start)).matchAll(/'([a-z0-9_]+)' => ('[^']*'|[\d.]+)/g)].map(([match, key, value]) => {
      if (key === undefined || value === undefined) throw new Error(`a DEFAULTS line not read: ${match}`);
      return [key, value.startsWith("'") ? value.slice(1, -1) : Number(value)];
    }));
    expect(Object.keys(defaults).length).toBeGreaterThan(400);
    const styles = (design: Record<string, unknown>) => ({
      id: '550e8400-e29b-41d4-a716-446655440009', kind: 'styles', schemaVersion: 1, revisionHash: 'a'.repeat(64),
      payload: { styles: [], globals: [], compiledCss: '', design },
    });
    expect(validateEntity(styles(defaults)), JSON.stringify(validateEntity.errors)).toBe(true);
    expect(validateEntity(styles({ role_bg: 'neutral-50', role_heading: 'primary-950', role_link: 'primary' })), JSON.stringify(validateEntity.errors)).toBe(true);
    expect(validateEntity(styles({ 'Role-Bg': 'neutral-50' }))).toBe(false);
    expect(validateEntity(styles({ role_bg: 'x'.repeat(241) }))).toBe(false);
    expect(validateEntity(styles({ role_bg: ['neutral-50'] }))).toBe(false);
    expect(validateEntity(styles({ text_min: 99 }))).toBe(false);
  });
});
