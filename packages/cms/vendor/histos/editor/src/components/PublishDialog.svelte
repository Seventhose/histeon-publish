<script lang="ts">
  import { t, dateLocale } from '../lib/i18n.ts';
  import type { Change } from '../lib/api.ts';
  import { documentText, lineDiff, summary, type DiffLine } from '../lib/diff.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import VisualDiff from './VisualDiff.svelte';
  import PublishChecks from './PublishChecks.svelte';
  import type { ChecksOutcome } from '../lib/checks.ts';
  import { cancelsScheduled, defaultLocal, formatAt, lastLine, MAX_AHEAD, MIN_AHEAD, scheduledLine, timezoneNote, toLocal, validateSchedule, type CronInfo, type ScheduledLast, type ScheduledView } from '../lib/schedule.ts';

  /** staticBridge: Static Bridge serves a static copy and refreshes it after the release. checksBlock: errors in the page checks keep Publish disabled. blogPublic: WordPress lets search engines index the site. */
  let { app, staticBridge = false, checksBlock = false, blogPublic = true }: { app: BuilderState; staticBridge?: boolean; checksBlock?: boolean; blogPublic?: boolean } = $props();

  let dialog: HTMLDialogElement;
  let changes = $state<Change[]>([]);
  let chosen = $state<Record<string, boolean>>({});
  let version = $state('');
  let notes = $state('');
  let busy = $state(false);
  let error = $state('');
  let result = $state('');
  /** The client's approval from the preview (docs/spec/review.md), shown before publishing. */
  let approval = $state<{ name: string; at: number; current: boolean } | null>(null);
  /** Open diffs, by document: what goes online compared with what is online now. */
  let diffs = $state<Record<string, DiffLine[] | 'loading' | string>>({});
  /** The visual comparison is open: the window needs room for two pages side by side. */
  let comparing = $state(false);
  /** Page checks: errors found, and whether they are done. */
  let checkErrors = $state(0);
  let checksReady = $state(true);
  /** The outcome of a finished round of checks, sent with the release (V1.5); null when they did not run or end. */
  let checksDone = $state<ChecksOutcome | null>(null);
  const blocked = $derived(checksBlock && (!checksReady || checkErrors > 0));
  /** The scheduled release (docs/spec/versioning.md §11): «Pubblica ora» or «Programma per…», at most one at a time. */
  let mode = $state<'now' | 'schedule'>('now');
  let when = $state('');
  let scheduled = $state<ScheduledView | null>(null);
  let scheduledLast = $state<ScheduledLast | null>(null);
  let cron = $state<CronInfo | null>(null);
  let timezone = $state('UTC');
  let now = $state(Date.now());
  const chosenDocs = $derived(changes.filter((c) => chosen[c.doc]).map((c) => c.doc));
  const validation = $derived(mode === 'schedule' ? validateSchedule(when, now, timezone) : null);
  /** Publishing these documents now cancels the scheduled release (§11.4 d): said before pressing. */
  const cancelsIt = $derived(mode === 'now' && cancelsScheduled(scheduled, chosenDocs));

  function readSchedule(list: { scheduled?: ScheduledView | null; scheduledLast?: ScheduledLast | null; cron?: CronInfo; timezone?: string }) {
    scheduled = list.scheduled ?? null;
    scheduledLast = list.scheduledLast ?? null;
    cron = list.cron ?? null;
    timezone = list.timezone || 'UTC';
  }

  async function cancelScheduled() {
    if (!scheduled || !window.confirm(t('Annullare la release programmata? Non andrà online nulla.'))) return;
    busy = true;
    error = '';
    try {
      await app.api.cancelSchedule();
      readSchedule(await app.api.listReleases());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function dismissLast() {
    try {
      await app.api.cancelSchedule(true);
      scheduledLast = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** The visual comparison, opened by «Guarda» on the checks' «Aspetto» line. */
  let visual: VisualDiff | undefined = $state();
  let visualBox: HTMLDivElement | undefined = $state();

  function look() {
    void visual?.run();
    visualBox?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function toggleDiff(doc: string) {
    if (diffs[doc]) {
      const { [doc]: _closed, ...rest } = diffs;
      diffs = rest;
      return;
    }
    diffs = { ...diffs, [doc]: 'loading' };
    try {
      const d = await app.api.diffChange(doc);
      diffs = { ...diffs, [doc]: lineDiff(documentText(doc, d.prod), documentText(doc, d.dev)) };
    } catch (e) {
      diffs = { ...diffs, [doc]: e instanceof Error ? e.message : String(e) };
    }
  }

  export async function open() {
    error = '';
    result = '';
    diffs = {};
    comparing = false;
    checksDone = null;
    mode = 'now';
    now = Date.now();
    dialog.showModal();
    busy = true;
    try {
      await app.save();
      const [list, releases, review] = await Promise.all([app.api.getChanges(), app.api.listReleases(), app.api.reviewComments(app.postId).catch(() => null)]);
      approval = review?.approval ?? null;
      changes = list;
      // After a send, only what it brought starts chosen: work of the site goes online when someone picks it.
      const sent = list.some((c) => c.sent);
      chosen = Object.fromEntries(list.map((c) => [c.doc, !sent || c.sent === true]));
      version = releases.next;
      readSchedule(releases);
      when = defaultLocal(now, timezone);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function schedule(docs: string[]) {
    now = Date.now();
    const check = validateSchedule(when, now, timezone);
    if (!check.ok || scheduled) return;
    busy = true;
    error = '';
    try {
      const done = await app.api.scheduleRelease(when, version, notes, docs, checksDone);
      const at = formatAt(done.at, timezone);
      result = t('Programmata per il {0} alle {1}: la versione {2} andrà online da sola, se nulla cambia prima.', at.date, at.time, done.version);
      readSchedule(await app.api.listReleases());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function publish(event: SubmitEvent) {
    event.preventDefault();
    const docs = chosenDocs;
    if (docs.length === 0 || blocked) return;
    if (mode === 'schedule') return schedule(docs);
    busy = true;
    error = '';
    try {
      const done = await app.api.publish(version, notes, docs, checksDone);
      result =
        (done.merged
          ? done.conflicts
            ? t('Pubblicata la versione {0}, con {1} testi del cliente integrati ({2} conflitti: tenuta la versione del builder).', done.version, done.merged, done.conflicts)
            : t('Pubblicata la versione {0}, con {1} testi del cliente integrati.', done.version, done.merged)
          : done.conflicts
            ? t('Pubblicata la versione {0} ({1} conflitti: tenuta la versione del builder).', done.version, done.conflicts)
            : t('Pubblicata la versione {0}.', done.version)) + (staticBridge ? ' ' + t('Static Bridge aggiorna a breve la copia statica delle pagine coinvolte.') : '');
      await app.load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="xb-publish-title" class:wide={comparing}>
  <form onsubmit={publish}>
    <h2 id="xb-publish-title">{t('Pubblica')}</h2>
    {#if result}
      <p class="ok" role="status">{result}</p>
      <div class="row"><button type="button" class="primary" onclick={() => dialog.close()}>{t('Chiudi')}</button></div>
    {:else}
      {#if busy && changes.length === 0}<p>{t('Preparazione…')}</p>{/if}
      {#if !busy && changes.length === 0 && !error}<p>{t('Non ci sono modifiche da pubblicare.')}</p>{/if}
      {#if approval}
        <p class="approval" class:stale={!approval.current}>
          {approval.current ? t('Approvata da') : t('Approvata una versione precedente da')} <strong>{approval.name}</strong> {t('il {0}', new Date(approval.at * 1000).toLocaleDateString(dateLocale()))}{approval.current ? '.' : t(': la pagina è cambiata dopo.')}
        </p>
      {/if}
      {#if scheduled}
        <div class="scheduled" data-xb-scheduled>
          <p><strong data-xb-scheduled-line>{scheduledLine(scheduled, timezone)}</strong> <button type="button" class="link" onclick={cancelScheduled} disabled={busy}>{t('Annulla la programmazione')}</button></p>
          {#if timezoneNote(scheduled)}<p class="muted">{timezoneNote(scheduled)}</p>{/if}
        </div>
      {/if}
      {#if scheduledLast}
        <p class="scheduled-last" class:skipped={scheduledLast.state !== 'published'} data-xb-scheduled-last>{lastLine(scheduledLast, timezone)} <button type="button" class="link" onclick={dismissLast}>{t('Chiudi')}</button></p>
      {/if}
      {#if changes.length > 0}
        <fieldset>
          <legend>{t('Cosa va online')}</legend>
          {#if changes.some((c) => c.sent) && changes.some((c) => !c.sent)}
            <p class="muted">{t('Sono selezionate le modifiche arrivate da Histeon CMS. Quelle fatte sul sito vanno online solo se le scegli.')}</p>
          {/if}
          {#each changes as change (change.doc)}
            {@const diff = diffs[change.doc]}
            <div class="change">
              <label class="check"><input type="checkbox" bind:checked={chosen[change.doc]} /> {change.label} <small>{change.doc}</small></label>
              {#if change.doc !== 'media' && change.doc !== 'contents'}<button type="button" class="link" onclick={() => toggleDiff(change.doc)} aria-expanded={!!diff}>{diff ? t('Nascondi') : t('Differenze')}</button>{/if}
            </div>
            {#if diff === 'loading'}
              <p class="muted">{t('Confronto…')}</p>
            {:else if typeof diff === 'string'}
              <p class="error">{diff}</p>
            {:else if diff}
              {@const s = summary(diff)}
              <div class="diff" role="region" aria-label={t('Differenze di {0}', change.label)}>
                <p class="muted">{t('+{0} −{1} righe rispetto al sito pubblicato', s.added, s.removed)}</p>
                <pre>{#each diff as line, i (i)}{#if line.kind === 'skip'}<span class="skip">{t('… {0} righe uguali …', line.count)}</span>{:else}<span class={line.kind}>{line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}{line.text}</span>{/if}
{/each}</pre>
              </div>
            {/if}
          {/each}
        </fieldset>
        {#key changes}
          <PublishChecks {app} {changes} block={checksBlock} {blogPublic} onlook={look} bind:errors={checkErrors} bind:ready={checksReady} bind:outcome={checksDone} />
          <div bind:this={visualBox}><VisualDiff bind:this={visual} {app} {changes} bind:active={comparing} /></div>
        {/key}
        <label>{t('Versione')} <input bind:value={version} pattern="\d{'{'}1,4{'}'}\.\d{'{'}1,4{'}'}\.\d{'{'}1,4{'}'}" required /></label>
        <label>{t('Note')} <textarea bind:value={notes} rows="3" placeholder={t('Cosa cambia in questa versione')}></textarea></label>
        <fieldset class="when" data-xb-publish-mode>
          <legend>{t('Quando')}</legend>
          <label class="check"><input type="radio" name="xb-publish-mode" value="now" bind:group={mode} /> {t('Pubblica ora')}</label>
          <label class="check"><input type="radio" name="xb-publish-mode" value="schedule" bind:group={mode} disabled={!!scheduled} /> {t('Programma per…')}</label>
          {#if scheduled}<p class="muted">{t('C’è già una release programmata: annullala per programmarne un’altra.')}</p>{/if}
          {#if mode === 'schedule'}
            <label>{t('Giorno e ora (ora del sito, {0})', timezone)}
              <input type="datetime-local" bind:value={when} min={toLocal(now + MIN_AHEAD, timezone)} max={toLocal(now + MAX_AHEAD, timezone)} required data-xb-schedule-at />
            </label>
            {#if validation && !validation.ok && when}<p class="error">{validation.error}</p>{/if}
            {#if cron && !cron.system}
              <details class="cron">
                <summary>{t('Questo sito non ha un cron di sistema: la release può partire in ritardo.')}</summary>
                <p class="muted">{t('La release partirà alla prima visita a WordPress dopo l’ora scelta, non necessariamente all’ora. Se il sito è servito in statico può slittare di ore; oltre 2 ore di ritardo non parte. Chiedi all’hosting di aggiungere una di queste righe al cron:')}</p>
                <pre>{cron.lines.join('\n')}</pre>
                <p class="muted">{t('Poi, in wp-config.php:')} <code>{cron.config}</code></p>
              </details>
            {/if}
          {/if}
        </fieldset>
        {#if cancelsIt && scheduled}
          {@const at = formatAt(scheduled.at, timezone)}
          <p class="warn" role="note">{t('Questa release tocca documenti della release programmata per il {0} alle {1}: pubblicando ora, quella viene annullata.', at.date, at.time)}</p>
        {/if}
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="row">
        <button type="button" onclick={() => dialog.close()}>{t('Annulla')}</button>
        <button type="submit" class="primary" disabled={busy || changes.length === 0 || blocked || (mode === 'schedule' && (!validation?.ok || !!scheduled))} title={blocked ? t('I controlli delle pagine devono finire senza errori') : undefined}>{busy ? t('Attendi…') : mode === 'schedule' ? t('Programma') : t('Pubblica')}</button>
      </div>
    {/if}
  </form>
</dialog>

<style>
  .approval { margin: 0 0 10px; padding: 8px 10px; border-radius: var(--xb-r-sm); background: color-mix(in srgb, var(--xb-ok) 12%, transparent); font-size: 13px; }
  .approval.stale { background: color-mix(in srgb, var(--xb-coral) 16%, transparent); }
  dialog { background: var(--xb-panel); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: 8px; padding: 20px; width: min(760px, 94vw); max-height: 90vh; overflow: auto; }
  .change { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .link { border: 0; padding: 2px 4px; color: var(--xb-link); font-size: 12px; }
  .muted { color: var(--xb-muted); font-size: 12px; margin: 0; }
  .diff pre { margin: 4px 0 0; max-height: 320px; overflow: auto; font: 12px/1.5 var(--xb-mono); background: var(--xb-bg); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); padding: 6px 0; white-space: pre; }
  .diff span { display: block; padding: 0 8px; }
  .diff .add { background: rgb(46 160 67 / 0.18); }
  .diff .del { background: rgb(248 81 73 / 0.18); }
  .diff .skip { color: var(--xb-muted); font-style: italic; }
  dialog.wide { width: min(1240px, 96vw); }
  dialog::backdrop { background: rgb(0 0 0 / 0.5); }
  form { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 16px; }
  fieldset { border: 1px solid var(--xb-line); border-radius: var(--xb-r); padding: 8px 12px; display: grid; gap: 6px; }
  legend { color: var(--xb-muted); font-size: 12px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--xb-muted); }
  label.check { display: flex; gap: 8px; align-items: center; color: var(--xb-text); }
  /* «Pubblica ora» / «Programma per…»: one under the other, each row at least 24px high so that the two radios
     (13px) leave the space WCAG 2.5.8 asks for (axe target-size), as the rows of «Cosa va online» already do. */
  .when label.check { min-block-size: 24px; }
  small { color: var(--xb-muted); font-family: var(--xb-mono); }
  input:not([type='checkbox']), textarea { font: 13px var(--xb-sans); padding: 6px 8px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .row { display: flex; justify-content: flex-end; gap: 8px; }
  button { font: 13px var(--xb-sans); padding: 6px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  .error { color: var(--xb-danger); margin: 0; }
  .ok { color: var(--xb-ok); margin: 0; }
  .scheduled, .scheduled-last, .warn { margin: 0; padding: 8px 10px; border-radius: var(--xb-r-sm); font-size: 13px; background: color-mix(in srgb, var(--xb-warn) 14%, transparent); }
  .scheduled p { margin: 0; }
  .scheduled-last:not(.skipped) { background: color-mix(in srgb, var(--xb-ok) 12%, transparent); }
  .cron pre { margin: 4px 0; overflow-x: auto; font: 12px/1.5 var(--xb-mono); background: var(--xb-bg); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); padding: 6px 8px; }
  .cron summary { cursor: pointer; font-size: 12px; color: var(--xb-text); }
</style>
