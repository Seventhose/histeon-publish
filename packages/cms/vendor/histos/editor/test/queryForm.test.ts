import { describe, expect, it } from 'vitest';
import { otherKeys, readAmount, readIds, readTaxFilters, setArg, summary, taxFiltersEditable, writeAmount, writeIds, writeTaxFilters } from '../src/lib/queryForm.ts';

describe('visual query builder', () => {
  it('sets and removes single arguments without touching the others', () => {
    const args = { post_type: 'post', meta_query: [{ key: 'x' }] };
    expect(setArg(args, 'orderby', 'title')).toEqual({ post_type: 'post', meta_query: [{ key: 'x' }], orderby: 'title' });
    expect(setArg(args, 'post_type', '')).toEqual({ meta_query: [{ key: 'x' }] });
    expect(args).toEqual({ post_type: 'post', meta_query: [{ key: 'x' }] });
  });

  it('reads and writes the amount, fixed or from the loop', () => {
    expect(readAmount('$count ?? 6')).toEqual({ fromLoop: true, param: 'count', value: 6 });
    expect(readAmount('$count')).toEqual({ fromLoop: true, param: 'count', value: 6 });
    expect(readAmount('$limit ?? 10')).toEqual({ fromLoop: true, param: 'limit', value: 10 });
    expect(readAmount(12)).toEqual({ fromLoop: false, param: 'count', value: 12 });
    expect(readAmount('8')).toEqual({ fromLoop: false, param: 'count', value: 8 });
    expect(writeAmount({ fromLoop: true, param: 'count', value: 3 })).toBe('$count ?? 3');
    expect(writeAmount({ fromLoop: true, param: 'limit', value: 4 })).toBe('$limit ?? 4');
    expect(writeAmount({ fromLoop: false, param: 'count', value: 500 })).toBe(100);
  });

  it('round-trips taxonomy filters and keeps the relation', () => {
    const one = writeTaxFilters({}, [{ taxonomy: 'category', terms: [3, 4], operator: 'IN' }], 'AND');
    expect(one.tax_query).toEqual([{ taxonomy: 'category', field: 'term_id', terms: [3, 4], operator: 'IN' }]);
    expect(readTaxFilters(one).filters).toEqual([{ taxonomy: 'category', terms: [3, 4], operator: 'IN' }]);
    const two = writeTaxFilters({}, [{ taxonomy: 'category', terms: [3], operator: 'IN' }, { taxonomy: 'post_tag', terms: [9], operator: 'NOT IN' }], 'OR');
    expect(readTaxFilters(two)).toEqual({ relation: 'OR', filters: [{ taxonomy: 'category', terms: [3], operator: 'IN' }, { taxonomy: 'post_tag', terms: [9], operator: 'NOT IN' }] });
    expect(writeTaxFilters(two, [], 'AND').tax_query).toBeUndefined();
    expect(taxFiltersEditable(two)).toBe(true);
    expect(taxFiltersEditable({ tax_query: [{ taxonomy: 'category', field: 'slug', terms: ['news'] }] })).toBe(false);
  });

  it('cleans id lists and lists what only the code view shows', () => {
    expect(readIds('3, 4,x, 4')).toEqual([3, 4, 4]);
    expect(writeIds([4, 4, 0, -1])).toEqual([4]);
    expect(writeIds([])).toBeUndefined();
    expect(otherKeys('posts', { post_type: 'post', meta_query: [], date_query: {} })).toEqual(['meta_query', 'date_query']);
  });

  it('describes a query in one line', () => {
    expect(summary('posts', { post_type: 'event', posts_per_page: '$count ?? 3', orderby: 'title', order: 'ASC' }, { types: { event: 'Eventi' } })).toBe('3 (o count) Eventi, per titolo crescente');
    expect(summary('main', {})).toBe('La query principale della pagina');
  });

  it('keeps fields that come from the loop linked to their parameter', async () => {
    const { choiceOf, readParam, writeParam } = await import('../src/lib/queryForm.ts');
    expect(readParam('$orderby ?? "date"')).toEqual({ param: 'orderby', fallback: 'date' });
    expect(readParam('$orderby ?? date')).toEqual({ param: 'orderby', fallback: 'date' });
    expect(readParam('date')).toBeNull();
    expect(writeParam('orderby', 'title')).toBe('$orderby ?? "title"');
    expect(writeParam('limit', 5)).toBe('$limit ?? 5');
    const order = choiceOf('$order ?? "DESC"', 'DESC');
    expect(order).toMatchObject({ value: 'DESC', param: 'order' });
    expect(order.write('ASC')).toBe('$order ?? "ASC"');
    expect(choiceOf('title', 'date').write('menu_order')).toBe('menu_order');
  });
});
