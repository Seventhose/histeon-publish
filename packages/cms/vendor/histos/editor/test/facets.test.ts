import { describe, expect, it } from 'vitest';
import { parse, serializeXb } from '@xb/dsl';
import { blankFacet, blankFilter, facetProblem, facetSnippet, nameProblem, type Facet } from '../src/lib/facets.ts';
import { setCatalog } from '../src/lib/i18n.ts';

const facet = (): Facet => ({
  ...blankFacet('evento'),
  filters: [
    { kind: 'search', key: 'q', label: 'Cerca {x} <b>' },
    { kind: 'taxonomy', key: 'tema-evento', label: 'Tema', taxonomy: 'tema', multiple: true, match: 'any' },
    { kind: 'field', key: 'citta', label: 'Città', field: 'xb:evento:citta' },
    blankFilter('sort', []),
  ],
});

describe('facets', () => {
  it('checks names and parameters like the server', () => {
    expect(nameProblem('eventi', [])).toBeNull();
    expect(nameProblem('Eventi', [])).toMatch(/non valido/);
    expect(nameProblem('ev-enti', [])).toMatch(/non valido/);
    expect(nameProblem('eventi', ['eventi'])).toMatch(/già/);
    expect(facetProblem(facet())).toBeNull();
    expect(facetProblem({ ...facet(), pageKey: 'paged' })).toMatch(/WordPress/);
    expect(facetProblem({ ...facet(), filters: [{ kind: 'search', key: 's', label: '' }] })).toMatch(/WordPress/);
    expect(facetProblem(facet(), ['tema-evento'])).toMatch(/WordPress/);
    expect(facetProblem({ ...facet(), filters: [{ kind: 'search', key: 'q', label: '' }, { kind: 'search', key: 'q', label: '' }] })).toMatch(/stesso/);
    expect(facetProblem({ ...facet(), filters: [{ kind: 'field', key: 'x', label: 'X', field: '' }] })).toMatch(/campo/);
    expect(blankFilter('search', ['q']).key).toBe('q2');
  });

  it('builds markup that parses, with escaped labels and dashed keys read by index', () => {
    const markup = facetSnippet('eventi', facet());
    const { blocks, warnings } = parse(markup);
    expect(warnings).toEqual([]);
    expect(serializeXb(blocks)).toContain('"data-xb-facet":"eventi"');
    const out = markup;
    expect(out).toContain('data-xb-facet="eventi"');
    expect(out).toContain('facets.eventi.filters["tema-evento"].options');
    expect(out).toContain('name="tema-evento[]"');
    expect(out).toContain('Cerca \\{x\\} &lt;b>');
    expect(out).toContain('{#loop facets.eventi.items as item}');
    expect(out).toContain('method="get"');
  });
});

describe('ranges and sorting by a field (D4)', () => {
  it('give the form two fields, which count as parameters', () => {
    const facet = { ...blankFacet('evento'), filters: [blankFilter('range', []), blankFilter('sort', [])] };
    expect(facetProblem(facet)).toMatch(/campo pubblico/);
    facet.filters[0] = { ...facet.filters[0]!, field: 'xb:evento:data', type: 'date' };
    expect(facetProblem(facet)).toBeNull();
    const snippet = facetSnippet('eventi', facet);
    expect(snippet).toContain('<input type="date" name="intervallo_min" value="{facets.eventi.filters.intervallo.min}" />');
    expect(snippet).toContain('name="intervallo_max"');
    expect(facetProblem({ ...facet, filters: [...facet.filters, { kind: 'search', key: 'intervallo_max', label: 'x' }] })).toMatch(/stesso parametro/);
    const sort = { ...facet.filters[1]!, options: [{ value: 'prezzo', label: 'Prezzo', orderby: 'field' as const, order: 'asc' as const }] };
    expect(facetProblem({ ...facet, filters: [facet.filters[0]!, sort] })).toMatch(/scegli il campo/);
  });

  it('writes the snippet in the editor language, its fixed words included', () => {
    setCatalog({ Predefinito: 'Default', Tutti: 'All', Pagine: 'Pages' });
    try {
      const out = facetSnippet('eventi', { ...facet(), filters: [facet().filters[2]!, facet().filters[3]!] });
      expect(out).toContain('<option value="">Default</option>');
      expect(out).toContain('<option value="">All</option>');
      expect(out).toContain('aria-label="Pages"');
      expect(out).not.toMatch(/Predefinito|Tutti|"Pagine"/);
    } finally {
      setCatalog({});
    }
  });
});
