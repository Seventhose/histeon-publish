import { describe, expect, it } from 'vitest';
import { blankField } from '../src/lib/contentHub.ts';
import type { SubField } from '../src/lib/contentHub.ts';
import { MAX_INNER_ROWS, cellText, editsInline, emptyRow, fromInput, listQuery, mediaQuery, relatedQuery, rowsOf, subValue, termEditUrl, toRow } from '../src/lib/contentTable.ts';

describe('content table', () => {
  it('shapes rows from the REST API', () => {
    const row = toRow({ id: 3, status: 'draft', date: '2026-10-20T10:00:00', link: 'http://x/?p=3', title: { raw: 'Concerto' }, meta: { prezzo: 12 } });
    expect(row).toMatchObject({ id: 3, title: 'Concerto', meta: { prezzo: 12 } });
    expect(toRow({ id: 4, status: 'publish', date: '', link: '', title: { rendered: 'A' }, meta: [] as unknown as Record<string, unknown> }).meta).toEqual({});
  });

  it('shows and parses values by type', () => {
    const number = blankField('Prezzo', 'number', []);
    const toggle = blankField('Gratis', 'toggle', []);
    const choice = { ...blankField('Formato', 'select', []), options: [{ value: 'online', label: 'Online' }] };
    expect(fromInput(number, '12.5')).toBe(12.5);
    expect(fromInput(number, '')).toBeNull();
    expect(fromInput(number, 'abc')).toBeNull();
    expect(fromInput(toggle, true)).toBe(true);
    expect(cellText(toggle, false)).toBe('No');
    expect(cellText(choice, 'online')).toBe('Online');
    expect(cellText(blankField('Orari', 'repeater', []), [{}, {}])).toBe('2 righe');
    expect(editsInline(blankField('Foto', 'image', []))).toBe(false);
    // Doc 26 voce 211: several values are shown, not edited, in a cell.
    const days = { ...choice, multiple: true };
    expect(cellText(days, ['online', 'altro'])).toBe('Online, altro');
    expect(editsInline(days)).toBe(false);
    expect(cellText({ ...blankField('Foto', 'image', []), multiple: true }, [3, 4])).toBe('2 valori');
    expect(editsInline(blankField('Inizio', 'time', []))).toBe(true);
    expect(editsInline(number)).toBe(true);
  });

  it('asks WordPress for one page, every editable status', () => {
    const q = listQuery('wp/v2/evento', 2, 20, 'any', ' rock ');
    expect(q.startsWith('wp/v2/evento?')).toBe(true);
    const params = new URLSearchParams(q.split('?')[1]);
    expect(params.get('page')).toBe('2');
    expect(params.get('status')).toBe('publish,future,draft,pending,private');
    expect(params.get('search')).toBe('rock');
    expect(params.get('context')).toBe('edit');
  });

  it('edits the rows of a repeater as the REST schema wants them (D6)', () => {
    const sub: SubField[] = [
      { name: 'giorno', label: 'Giorno', type: 'text', options: [] },
      { name: 'posti', label: 'Posti', type: 'number', options: [] },
      { name: 'aperto', label: 'Aperto', type: 'toggle', options: [] },
      { name: 'foto', label: 'Foto', type: 'image', options: [] },
      { name: 'turni', label: 'Turni', type: 'repeater', options: [], sub: [{ name: 'ora', label: 'Ora', type: 'text', options: [] }] },
    ];
    expect(emptyRow(sub)).toEqual({ giorno: '', posti: null, aperto: false, foto: 0, turni: [] });
    const rows = rowsOf([{ giorno: 'lun', posti: '12', aperto: 1, foto: '7', extra: 'x', turni: [{ ora: 9, altro: 1 }] }, 'riga sbagliata'], sub);
    expect(rows).toEqual([
      { giorno: 'lun', posti: 12, aperto: true, foto: 7, turni: [{ ora: '9' }] },
      { giorno: '', posti: null, aperto: false, foto: 0, turni: [] },
    ]);
    expect(rowsOf(Array.from({ length: 80 }, () => ({})), sub, MAX_INNER_ROWS)).toHaveLength(50);
    expect(rowsOf('non una lista', sub)).toEqual([]);
    expect(subValue(sub[1]!, 'abc')).toBeNull();
    expect(subValue(sub[3]!, -4)).toBe(0);
  });

  it('asks WordPress for images and linked contents', () => {
    const media = new URLSearchParams(mediaQuery(' gatto ').split('?')[1]);
    expect(mediaQuery('').startsWith('/wp/v2/media?')).toBe(true);
    expect(media.get('media_type')).toBe('image');
    expect(media.get('search')).toBe('gatto');
    const related = relatedQuery('/wp/v2/eventi', '');
    expect(related.startsWith('/wp/v2/eventi?')).toBe(true);
    expect(new URLSearchParams(related.split('?')[1]).get('search')).toBeNull();
  });

  it('links a term to WordPress by its taxonomy name, not its REST route', () => {
    expect(termEditUrl('https://sito.test/wp-admin/', 'post_tag', 7)).toBe('https://sito.test/wp-admin/term.php?taxonomy=post_tag&tag_ID=7');
    expect(termEditUrl('https://sito.test/wp-admin/', 'category', 3)).toContain('taxonomy=category&');
    expect(termEditUrl(null, 'category', 3)).toBeNull();
    expect(termEditUrl('https://sito.test/wp-admin/', '', 3)).toBeNull();
  });
});
