import { describe, expect, it } from 'vitest';
import { BRIEF_LIST, briefData, queryParams } from '../src/lib/publicApi.ts';
import type { ContentData, QueriesData } from '../src/lib/api.ts';

describe('brief data', () => {
  it('finds the $parameters of a loop query wherever they sit', () => {
    expect(queryParams({ type: 'evento', limit: 3, category: '$luogo', tax_query: [{ terms: ['$genere', 'fisso'] }], s: 'non $un parametro' })).toEqual(['luogo', 'genere']);
    expect(queryParams({ meta_query: [{ key: 'data', value: '$today' }], date_query: [{ after: '$now' }] }), 'they fill themselves').toEqual([]);
  });

  it('lists loop queries, sources, facets, types and readable fields, with caps', () => {
    const presets = Object.fromEntries(Array.from({ length: BRIEF_LIST + 2 }, (_, i) => [`q${i}`, { type: 'posts' as const, args: { category: '$cat' } }]));
    const queries = { presets, sources: { orari: { type: 'json', data: [] } }, types: [{ name: 'evento', label: 'Evento' }], head: 'h', base: 'b' } as unknown as QueriesData;
    const content = {
      content: { types: {}, taxonomies: {}, fields: { evento: [{ name: 'data_inizio' }] } },
      live: { types: {}, taxonomies: {}, fields: {} },
      publicFields: ['acf:field_1'],
      providers: [{ id: 'acf', label: 'ACF', fields: [{ id: 'acf:field_1', name: 'prezzo' }, { id: 'acf:field_2', name: 'segreto' }] }],
      postTypes: [{ name: 'evento', label: 'Evento', own: true }, { name: 'xb_submission', label: 'Invii', own: false }],
      canManage: true,
      head: 'h',
      base: 'b',
    } as unknown as ContentData;
    const data = briefData({
      queries,
      facets: { catalogo: { query: 'q0', type: 'evento', perPage: 10, pageKey: 'p', filters: [{ kind: 'taxonomy', key: 'genere', label: 'Genere' }] } } as never,
      content,
      extensions: { data: [{ name: 'meteo', description: 'Previsioni' }], modifiers: [], blocks: [] },
    });
    expect(data.loopQueries).toHaveLength(BRIEF_LIST);
    expect(data.loopQueries[0]).toEqual({ name: 'q0', type: 'posts', params: ['cat'] });
    expect(data.more).toEqual({ loopQueries: 2 });
    expect(data.sources).toEqual([{ name: 'orari', kind: 'json' }, { name: 'meteo', kind: 'php', description: 'Previsioni' }]);
    expect(data.facets).toEqual([{ name: 'catalogo', query: 'q0', filters: ['genere'] }]);
    expect(data.types).toEqual([{ name: 'evento', label: 'Evento', fields: ['data_inizio'] }]);
    expect(data.publicFields).toEqual(['prezzo']);
  });

  it('leaves out what did not load', () => {
    expect(briefData({})).toEqual({ loopQueries: [], sources: [], facets: [], types: [], publicFields: [], more: {} });
  });
});
