import { describe, expect, it } from 'vitest';
import { cancelsScheduled, defaultLocal, formatAt, fromLocal, inScheduled, lastLine, offsetAt, scheduledLine, timezoneNote, toLocal, validateSchedule, type ScheduledLast, type ScheduledView } from '../src/lib/schedule.ts';

const ROME = 'Europe/Rome';

function view(extra: Partial<ScheduledView> = {}): ScheduledView {
  return {
    id: 'a'.repeat(32),
    valid: true,
    at: Date.UTC(2026, 10, 20, 8, 0) / 1000, // 09:00 in Rome (UTC+1 in November)
    local: '20/11/2026 09:00 (+01:00)',
    timezone: ROME,
    tzThen: ROME,
    localThen: '2026-11-20 09:00',
    tzChanged: false,
    version: '1.4.0',
    notes: '',
    user: 2,
    userName: 'Maria Rossi',
    docs: ['post:12', 'post:13', 'styles'],
    labels: ['Home', 'Chi siamo', 'Stili'],
    media: false,
    contents: false,
    mine: true,
    ...extra,
  };
}

describe('the scheduled release: dates in the site time zone', () => {
  it('reads and writes a local time in the site time zone, not the computer one', () => {
    expect(fromLocal('2026-11-20T09:00', ROME)).toBe(Date.UTC(2026, 10, 20, 8, 0));
    expect(fromLocal('2026-07-20T09:00', ROME)).toBe(Date.UTC(2026, 6, 20, 7, 0));
    expect(toLocal(Date.UTC(2026, 10, 20, 8, 0), ROME)).toBe('2026-11-20T09:00');
    expect(fromLocal('2026-11-20T09:00', 'UTC')).toBe(Date.UTC(2026, 10, 20, 9, 0));
    expect(offsetAt(Date.UTC(2026, 6, 1), ROME)).toBe(120);
  });

  it('takes a fixed offset as WordPress writes it', () => {
    expect(fromLocal('2026-11-20T09:00', '+02:00')).toBe(Date.UTC(2026, 10, 20, 7, 0));
    expect(toLocal(Date.UTC(2026, 10, 20, 7, 0), '-03:30')).toBe('2026-11-20T03:30');
  });

  it('refuses a time that does not exist and takes the first of one that exists twice', () => {
    // 29 March 2026: in Rome the clocks go from 02:00 to 03:00.
    expect(fromLocal('2026-03-29T02:30', ROME)).toBeNull();
    // 25 October 2026: 02:30 happens twice, first at +02:00.
    expect(fromLocal('2026-10-25T02:30', ROME)).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(fromLocal('2026-13-40T25:00', ROME)).toBeNull();
    expect(fromLocal('domani', ROME)).toBeNull();
  });

  it('validates the field as the server does: at least 5 minutes, at most 60 days', () => {
    const now = Date.UTC(2026, 10, 13, 10, 0);
    expect(validateSchedule('', now, ROME).ok).toBe(false);
    expect(validateSchedule('2026-11-13T10:00', now, ROME)).toMatchObject({ ok: false }); // 09:00 UTC: in the past
    expect(validateSchedule('2026-11-13T11:03', now, ROME)).toMatchObject({ ok: false }); // 3 minutes ahead
    expect(validateSchedule('2026-11-13T11:05', now, ROME)).toEqual({ ok: true, at: now + 5 * 60000 });
    expect(validateSchedule('2027-01-13T11:00', now, ROME)).toMatchObject({ ok: false }); // 61 days
    expect(validateSchedule('2026-03-29T02:30', Date.UTC(2026, 2, 20), ROME)).toMatchObject({ ok: false });
  });

  it('starts the field at the next full hour, at least an hour ahead', () => {
    expect(defaultLocal(Date.UTC(2026, 10, 13, 10, 20), ROME)).toBe('2026-11-13T13:00'); // 11:20 in Rome
    expect(defaultLocal(Date.UTC(2026, 10, 13, 10, 0), ROME)).toBe('2026-11-13T12:00');
  });
});

describe('the scheduled release: the lines', () => {
  it('writes «Programmata per il … da …»', () => {
    expect(formatAt(view().at, ROME)).toEqual({ date: '20/11/2026', time: '09:00' });
    expect(scheduledLine(view(), ROME)).toBe('Programmata per il 20/11/2026 alle 09:00 da Maria Rossi · versione 1.4.0 · 3 documenti');
    expect(scheduledLine(view({ userName: '', docs: ['post:12'], media: true }), ROME)).toBe('Programmata per il 20/11/2026 alle 09:00 · versione 1.4.0 · 2 documenti');
    expect(scheduledLine(view({ docs: ['post:12'] }), ROME)).toContain('· 1 documento');
    expect(scheduledLine(view({ valid: false }), ROME)).toContain('alterata');
  });

  it('says when the time zone changed after scheduling', () => {
    expect(timezoneNote(view())).toBe('');
    expect(timezoneNote(view({ tzChanged: true, timezone: 'Europe/London' }))).toContain('erano le 2026-11-20 09:00 Europe/Rome');
  });

  it('says what happened to the last one', () => {
    const last: ScheduledLast = { state: 'published', code: 'pubblicata', reason: '', version: '1.4.0', at: view().at, local: '', done: view().at + 120, doneLocal: '', userName: 'Maria Rossi', release: 7 };
    expect(lastLine(last, ROME)).toBe('Pubblicata la versione 1.4.0 alle 09:02.');
    expect(lastLine({ ...last, state: 'skipped', reason: 'una pagina è cambiata.' }, ROME)).toBe('Saltata la release programmata per il 20/11 alle 09:00: una pagina è cambiata.');
    expect(lastLine({ ...last, state: 'cancelled', reason: 'Annullata a mano.' }, ROME)).toContain('Annullata la release programmata per il 20/11');
  });

  it('knows when publishing now cancels it, and when the open page is in it', () => {
    expect(cancelsScheduled(view(), ['post:12'])).toBe(true);
    expect(cancelsScheduled(view(), ['post:99', 'settings'])).toBe(false);
    expect(cancelsScheduled(null, ['post:12'])).toBe(false);
    expect(inScheduled(view(), 13)).toBe(true);
    expect(inScheduled(view(), 99)).toBe(false);
    expect(inScheduled(view({ valid: false }), 13)).toBe(false);
  });
});
