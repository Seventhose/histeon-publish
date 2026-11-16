import { describe, expect, it } from 'vitest';
import { targetOf, removeTaxonomy, MAX_SUB, SUB_FIELD_TYPES, INNER_SUB_FIELD_TYPES, providerExpression, blankField, blankSubField, blankTaxonomy, blankType, emptyDefs, fieldExpression, fieldNameProblem, moveField, nameProblem, optionsText, parseOptions, problems, removeType, renameType, retypeField, retypeSub, slugify, statusOf, urlSlug, type ContentDefs } from '../src/lib/contentHub.ts';

const defs = (): ContentDefs => ({
  types: { evento: blankType('Evento', 'Eventi'), sede: blankType('Sede', 'Sedi') },
  taxonomies: { luogo: blankTaxonomy('Luogo', 'Luoghi', ['evento']) },
  fields: { evento: [{ ...blankField('Sede', 'post', []), postType: 'sede' }, blankField('Prezzo', 'number', [])] },
});

describe('content hub', () => {
  it('derives technical names and addresses from labels', () => {
    expect(slugify('Eventi musicali')).toBe('eventi_musicali');
    expect(slugify('Città è più')).toBe('citta_e_piu');
    expect(slugify('123 prove')).toBe('prove');
    expect(slugify('Una etichetta lunghissima per un tipo')).toHaveLength(20);
    expect(urlSlug('Eventi musicali')).toBe('eventi-musicali');
  });

  it('refuses reserved, malformed and taken names', () => {
    expect(nameProblem('evento', [], 20)).toBeNull();
    expect(nameProblem('page', [], 20)).toMatch(/riservato/);
    expect(nameProblem('year', [], 20)).toMatch(/riservato/);
    expect(nameProblem('wp_cose', [], 20)).toMatch(/riservato/);
    expect(nameProblem('Evento', [], 20)).toMatch(/non valido/);
    expect(nameProblem('a'.repeat(21), [], 20)).toMatch(/non valido/);
    expect(nameProblem('a'.repeat(21), [], 32)).toBeNull();
    expect(nameProblem('evento', ['evento'], 20)).toMatch(/già usato/);
    expect(fieldNameProblem('_segreto', [])).toMatch(/non valido/);
    expect(fieldNameProblem('prezzo', ['prezzo'])).toMatch(/c’è già/);
  });

  it('creates fields with unique names', () => {
    expect(blankField('Prezzo intero', 'number', []).name).toBe('prezzo_intero');
    expect(blankField('Prezzo', 'number', ['prezzo']).name).toBe('prezzo_2');
    expect(blankField('Formato', 'select', []).options).toHaveLength(1);
  });

  it('renames and removes a type with its references', () => {
    const renamed = renameType(defs(), 'sede', 'luogo_evento');
    expect(Object.keys(renamed.types)).toEqual(['evento', 'luogo_evento']);
    expect(renamed.fields.evento?.[0]?.postType).toBe('luogo_evento');
    const removed = removeType(defs(), 'evento');
    expect(removed.fields.evento).toBeUndefined();
    expect(removed.taxonomies.luogo?.types).toEqual([]);
    expect(removeType(defs(), 'sede').fields.evento?.[0]?.postType).toBe('');
  });

  it('keeps the field groups when a type is renamed or removed, and follows it in their lists', () => {
    const withGroups = (): ContentDefs => ({
      ...defs(),
      groups: {
        orari: { label: 'Orari', all: false, types: ['evento', 'sede'], except: [], fields: [{ ...blankField('Dove', 'post', []), postType: 'sede' }] },
        note: { label: 'Note', all: true, types: [], except: ['sede'], fields: [blankField('Nota', 'text', [])] },
      },
    });
    const renamed = renameType(withGroups(), 'sede', 'luogo_evento');
    expect(renamed.groups?.orari?.types).toEqual(['evento', 'luogo_evento']);
    expect(renamed.groups?.orari?.fields[0]?.postType).toBe('luogo_evento');
    expect(renamed.groups?.note?.except).toEqual(['luogo_evento']);
    const removed = removeType(withGroups(), 'sede');
    expect(Object.keys(removed.groups ?? {})).toEqual(['orari', 'note']);
    expect(removed.groups?.orari?.types).toEqual(['evento']);
    expect(removed.groups?.orari?.fields[0]?.postType).toBe('');
    expect(removed.groups?.note?.except).toEqual([]);
    expect(removeType(defs(), 'sede').groups).toBeUndefined();
  });

  it('tells what is live, changed or new', () => {
    const live = defs();
    const now = defs();
    expect(statusOf('types', 'evento', now, live)).toBe('live');
    now.fields.evento = moveField(now.fields.evento ?? [], 0, 1);
    expect(statusOf('types', 'evento', now, live)).toBe('changed');
    expect(statusOf('types', 'evento', now, emptyDefs())).toBe('new');
  });

  it('reports what stops a save', () => {
    const d = defs();
    expect(problems(d)).toEqual([]);
    d.fields.evento = [...(d.fields.evento ?? []), { ...blankField('Formato', 'select', []), options: [] }, { ...blankField('Altro', 'post', []) }];
    d.types.sede = { ...(d.types.sede as ReturnType<typeof blankType>), plural: ' ' };
    expect(problems(d)).toHaveLength(3);
  });

  it('reads rows and lists of other plugins with a loop', () => {
    expect(providerExpression({ name: 'capitoli', type: 'repeater', sub: [{ name: 'titolo' }] })).toBe('{#loop this.fields.capitoli as r}{r.titolo}{/loop}');
    expect(providerExpression({ name: 'foto', type: 'gallery', sub: [] })).toBe('{#loop this.fields.foto as r}{r.url}{/loop}');
    // A field of an options page (D5): read from site.options, dashes of the page's slug as underscores.
    expect(providerExpression({ name: 'orari', type: 'text', sub: [], optionsPage: 'dati-sito' })).toBe('{site.options.dati_sito.orari}');
    expect(providerExpression({ name: 'logo', type: 'image', sub: [], optionsPage: 'dati-sito' })).toBe('{site.options.dati_sito.logo.url}');
    expect(providerExpression({ name: 'righe', type: 'repeater', sub: [{ name: 'giorno' }], optionsPage: 'orari' })).toBe('{#loop site.options.orari.righe as r}{r.giorno}{/loop}');
    expect(providerExpression({ name: 'foto', type: 'image', sub: [] })).toBe('{this.fields.foto.url}');
    expect(providerExpression({ name: 'autore', type: 'text', sub: [] })).toBe('{this.fields.autore}');
  });

  it('builds repeaters with scalar sub fields only', () => {
    const r = blankField('Orari', 'repeater', []);
    expect(r.sub).toEqual([{ name: 'testo', label: 'Testo', type: 'text', options: [] }]);
    expect(blankField('Prezzo', 'number', []).sub).toEqual([]);
    expect(blankSubField('Giorno', 'text', ['giorno']).name).toBe('giorno_2');
    expect(blankSubField('Turno', 'select', []).options).toHaveLength(1);
    expect(INNER_SUB_FIELD_TYPES.map((t) => t.value)).toEqual(['text', 'textarea', 'number', 'date', 'time', 'toggle', 'select', 'image', 'file', 'url']);
    // A row may hold one more repeater (D6), never a third level.
    expect(SUB_FIELD_TYPES.at(-1)?.value).toBe('repeater');

    // Changing type keeps nothing of the old one, and a repeater always has a first field.
    const asText = retypeField({ ...r, sub: [blankSubField('Giorno', 'text', [])] }, 'text');
    expect(asText.sub).toEqual([]);
    expect(retypeField(asText, 'repeater').sub).toHaveLength(1);
    expect(retypeField(blankField('Formato', 'select', []), 'repeater').options).toEqual([]);
    expect(retypeSub(blankSubField('Turno', 'select', []), 'number').options).toEqual([]);
    expect(retypeSub(blankSubField('Turno', 'text', []), 'select').options).toHaveLength(1);
    expect(moveField(r.sub.concat(blankSubField('Ore', 'number', ['testo'])), 1, -1).map((s) => s.name)).toEqual(['ore', 'testo']);
  });

  it('allows one repeater inside a row, never a third level (D6)', () => {
    const d = defs();
    const r = blankField('Tappe', 'repeater', []);
    const inner = retypeSub(blankSubField('Orari', 'text', ['testo']), 'repeater');
    expect(inner.sub).toHaveLength(1);
    expect(SUB_FIELD_TYPES.map((x) => x.value)).toContain('repeater');
    expect(INNER_SUB_FIELD_TYPES.map((x) => x.value)).not.toContain('repeater');
    r.sub = [blankSubField('Luogo', 'text', []), inner];
    d.fields.evento = [...(d.fields.evento ?? []), r];
    expect(problems(d)).toEqual([]);
    expect(retypeSub(inner, 'text').sub).toBeUndefined();
    inner.sub = [];
    expect(problems(d)).toEqual(['evento: tappe: il ripetitore "orari" deve avere da 1 a 20 campi.']);
    inner.sub = [{ ...blankSubField('Giorno', 'text', []), type: 'repeater', sub: [blankSubField('X', 'text', [])] }];
    expect(problems(d)).toEqual(['evento: tappe: orari: "giorno" non può stare in un ripetitore dentro una riga.']);
    expect(fieldExpression('this', 'tappe', 'repeater', [{ name: 'orari', type: 'repeater', sub: [blankSubField('Giorno', 'text', [])] }])).toBe('{#loop this.fields.tappe as r}{#loop r.orari as o}{o.giorno}{/loop}{/loop}');
  });

  it('reports what stops a save in a repeater', () => {
    const d = defs();
    const r = blankField('Orari', 'repeater', []);
    d.fields.evento = [...(d.fields.evento ?? []), r];
    expect(problems(d)).toEqual([]);
    r.sub = [];
    expect(problems(d)).toEqual(['evento: il ripetitore "orari" deve avere da 1 a 20 campi.']);
    r.sub = Array.from({ length: MAX_SUB + 1 }, (_, i) => blankSubField(`C ${i}`, 'text', []));
    expect(problems(d)).toHaveLength(1);
    r.sub = [blankSubField('Giorno', 'text', []), blankSubField('Giorno', 'text', []), { ...blankSubField('Turno', 'select', []), options: [] }, { ...blankSubField('Altro', 'text', []), name: '_x' }];
    expect(problems(d)).toHaveLength(3);
    r.sub = [{ ...blankSubField('Sede', 'text', []), type: 'post' as never }, { ...blankSubField('Turno', 'select', []), options: [{ value: 'a b', label: 'A' }] }];
    expect(problems(d)).toHaveLength(2);
  });

  it('reads and writes options one per line', () => {
    const options = parseOptions('Mattina\nsera: Sera tardi\n\n  notte:  ');
    expect(options).toEqual([{ value: 'mattina', label: 'Mattina' }, { value: 'sera', label: 'Sera tardi' }, { value: 'notte', label: 'notte' }]);
    expect(optionsText(options)).toBe('Mattina\nsera: Sera tardi\nnotte');
    expect(parseOptions(optionsText(options))).toEqual(options);
  });

  it('reaches term and user fields from a page and from a loop', () => {
    expect(targetOf('term:category').single).toBe('this.categories[0]');
    expect(targetOf('term:luogo').single).toBe('this.terms.luogo[0]');
    expect(targetOf('user').single).toBe('this.author');
    expect(targetOf('evento')).toMatchObject({ kind: 'post', single: 'this', repeater: true });
    const d = defs();
    d.fields['term:luogo'] = [blankField('Colore', 'text', [])];
    expect(removeTaxonomy(d, 'luogo').fields['term:luogo']).toBeUndefined();
    d.fields.user = [{ ...blankField('Orari', 'repeater', []) }];
    expect(problems(d).some((p) => p.startsWith('user: il ripetitore'))).toBe(true);
  });

  it('writes the expression of a field', () => {
    expect(fieldExpression('this', 'orari', 'repeater', [{ name: 'giorno', type: 'text' }])).toBe('{#loop this.fields.orari as r}{r.giorno}{/loop}');
    expect(fieldExpression('item', 'tappe', 'repeater', [{ name: 'foto', type: 'image' }])).toBe('{#loop item.fields.tappe as r}{r.foto.url}{/loop}');
    expect(fieldExpression('this', 'foto', 'image')).toBe('{this.fields.foto.url}');
    expect(fieldExpression('item', 'sede', 'post')).toBe('{item.fields.sede.title}');
    expect(fieldExpression('item', 'prezzo', 'number')).toBe('{item.fields.prezzo}');
  });
});
