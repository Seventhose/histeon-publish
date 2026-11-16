// The scheduled release in the Publish dialog (docs/spec/versioning.md §11): pure parts, tested in
// editor/test/schedule.test.ts. Dates are always read and shown in the site's time zone, never the computer's; the
// server checks everything again (Scheduled::parse_local and Scheduled::schedule).
import { t, tn } from './i18n.ts';

/** The scheduled release as GET /releases gives it (Scheduled::view). */
export interface ScheduledView {
  id: string;
  valid: boolean;
  /** The instant, UTC seconds. */
  at: number;
  local: string;
  timezone: string;
  tzThen: string;
  localThen: string;
  tzChanged: boolean;
  version: string;
  notes: string;
  user: number;
  userName: string;
  docs: string[];
  labels: string[];
  media: boolean;
  contents: boolean;
  mine: boolean;
}

/** What happened to the last scheduled release (Scheduled::last_view). */
export interface ScheduledLast {
  state: 'published' | 'skipped' | 'cancelled';
  code: string;
  reason: string;
  version: string;
  at: number;
  local: string;
  done: number;
  doneLocal: string;
  userName: string;
  release: number;
}

/** Whether the site has a system cron, and the lines for the hosting (Scheduled::cron). */
export interface CronInfo {
  system: boolean;
  lines: string[];
  config: string;
}

/** «Programma per…» starts at least this far ahead, and at most MAX_AHEAD (Scheduled::MIN_AHEAD, MAX_AHEAD). */
export const MIN_AHEAD = 5 * 60 * 1000;
export const MAX_AHEAD = 60 * 24 * 60 * 60 * 1000;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/** The offset of $tz from UTC at instant $ms, in minutes. WordPress also allows a fixed offset like «+02:00». */
export function offsetAt(ms: number, tz: string): number {
  const fixed = OFFSET.exec(tz);
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3]));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The instant $ms as `<input type="datetime-local">` writes it, in $tz: 2026-11-20T09:00. */
export function toLocal(ms: number, tz: string): string {
  const d = new Date(ms + offsetAt(ms, tz) * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The instant (ms) of a local date and time in $tz, or null when that time does not exist there (the day the
 * clocks go forward) or the text is not a date. A time that exists twice (the day they go back) is the first.
 */
export function fromLocal(local: string, tz: string): number | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(guess)) return null;
  const candidates = new Set<number>();
  for (const probe of [guess - 12 * 3600000, guess, guess + 12 * 3600000]) candidates.add(guess - offsetAt(probe, tz) * 60000);
  const matching = [...candidates].filter((ms) => toLocal(ms, tz) === local).sort((a, b) => a - b);
  return matching[0] ?? null;
}

export type Validation = { ok: true; at: number } | { ok: false; error: string };

/** Checks the date and time chosen in «Programma per…», as the server will: real, at least 5 minutes ahead, at most 60 days. */
export function validateSchedule(local: string, now: number, tz: string): Validation {
  if (!local) return { ok: false, error: t('Scegli giorno e ora.') };
  const at = fromLocal(local, tz);
  if (at === null) return { ok: false, error: t('Quest’ora non esiste nel fuso del sito (il giorno del passaggio all’ora legale) o la data non è valida.') };
  if (at < now + MIN_AHEAD) return { ok: false, error: t('Scegli un’ora almeno 5 minuti avanti: per pubblicare subito c’è «Pubblica ora».') };
  if (at > now + MAX_AHEAD) return { ok: false, error: t('Si programma al più 60 giorni avanti.') };
  return { ok: true, at };
}

/** The value the field starts with: the next full hour, at least an hour ahead, in the site's time zone. */
export function defaultLocal(now: number, tz: string): string {
  const hour = 3600000;
  const local = toLocal(now + hour, tz);
  const rounded = fromLocal(local.slice(0, 14) + '00', tz) ?? now + hour;
  return toLocal(rounded < now + hour ? rounded + hour : rounded, tz);
}

/** Date (dd/mm/yyyy) and time (HH:MM) of an instant (seconds) in $tz. */
export function formatAt(at: number, tz: string): { date: string; time: string } {
  const local = toLocal(at * 1000, tz);
  return { date: `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)}`, time: local.slice(11, 16) };
}

/** «Programmata per il 20/11/2026 alle 09:00 da Maria Rossi · versione 1.4.0 · 3 documenti». */
export function scheduledLine(view: ScheduledView, tz: string): string {
  const { date, time } = formatAt(view.at, tz);
  if (!view.valid) return t('Release programmata per il {0} alle {1}, ma alterata: non partirà.', date, time);
  const count = view.docs.length + (view.media ? 1 : 0) + (view.contents ? 1 : 0);
  const docs = tn('{0} documento', '{0} documenti', count, count);
  return view.userName
    ? t('Programmata per il {0} alle {1} da {2} · versione {3} · {4}', date, time, view.userName, view.version, docs)
    : t('Programmata per il {0} alle {1} · versione {2} · {3}', date, time, view.version, docs);
}

/** The note when the site's time zone changed after scheduling: the instant stays, the hour shown moves. */
export function timezoneNote(view: ScheduledView): string {
  if (!view.tzChanged || !view.tzThen) return '';
  return t('Il fuso del sito è cambiato dopo la programmazione: erano le {0} {1}. L’istante resta quello.', view.localThen, view.tzThen);
}

/** «Pubblicata la versione 1.4.0 alle 09:02», or skipped, or cancelled, with the reason. */
export function lastLine(last: ScheduledLast, tz: string): string {
  const at = formatAt(last.at, tz);
  const day = at.date.slice(0, 5);
  if (last.state === 'published') return t('Pubblicata la versione {0} alle {1}.', last.version, formatAt(last.done, tz).time);
  if (last.state === 'skipped') return t('Saltata la release programmata per il {0} alle {1}: {2}', day, at.time, last.reason);
  return t('Annullata la release programmata per il {0} alle {1}: {2}', day, at.time, last.reason);
}

/** Whether publishing $docs now cancels the scheduled release (it touches its documents, §11.4 d). */
export function cancelsScheduled(view: ScheduledView | null, docs: string[]): boolean {
  return !!view && docs.some((doc) => view.docs.includes(doc));
}

/** Whether the document open in the builder is in the scheduled release (the warning bar of §11.1). */
export function inScheduled(view: ScheduledView | null, postId: number): boolean {
  return !!view && view.valid && postId > 0 && view.docs.includes(`post:${postId}`);
}
