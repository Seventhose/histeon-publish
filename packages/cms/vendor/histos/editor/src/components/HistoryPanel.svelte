<script lang="ts">
  import { dateLocale, t, tn } from '../lib/i18n.ts';
  import type { Deploy, DeployStatus, ImportReport, Release } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  let {
    app,
    canPublish,
    canManage = false,
    visible,
    adminHistory = null,
    embed = false,
  }: { app: BuilderState; canPublish: boolean; canManage?: boolean; visible: boolean; adminHistory?: string | null; embed?: boolean } = $props();

  let importData = $state<unknown>(null);
  let importReport = $state<ImportReport | null>(null);
  /** The administrator's choice on the file's signature (P8, docs/spec/signing.md). */
  let trustKey = $state(false);
  let allowUnsigned = $state(false);
  const MAX_FILE = 20 * 1024 * 1024;

  /** Downloads a release as a .xbrelease file (JSON), to import on another site. */
  async function exportRelease(release: Release) {
    busy = true;
    message = '';
    try {
      const data = await app.api.exportRelease(release.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `xb-release-${release.version}.xbrelease`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message = t('Versione {0} esportata.', release.version);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function chooseImport(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    importReport = null;
    importData = null;
    trustKey = false;
    allowUnsigned = false;
    if (!file) return;
    if (file.size > MAX_FILE) {
      message = t('Il file supera la dimensione massima (20 MB).');
      return;
    }
    try {
      importData = JSON.parse(await file.text());
    } catch {
      message = t('Il file non è una release Histeon (JSON non valido).');
      return;
    }
    await runImport(false);
  }

  async function runImport(write: boolean) {
    if (!importData) return;
    busy = true;
    message = '';
    try {
      importReport = await app.api.importRelease(importData, write, { trust: trustKey, allowUnsigned });
      if (write) {
        message = t('Release importata in sviluppo: controllala in anteprima e pubblicala.');
        importData = null;
        await app.load();
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
      importReport = null;
    } finally {
      busy = false;
    }
  }

  let releases = $state<Release[]>([]);
  /** A release scheduled for later (docs/spec/versioning.md §11): a restore cancels it, and says so first. */
  let hasScheduled = $state(false);
  let deploy = $state<DeployStatus | null>(null);
  let keepContent = $state(true);
  let busy = $state(false);
  let message = $state('');

  async function refresh() {
    try {
      // The deploy history is for publishers only (GET /deploy requires xb_publish).
      const [list, status] = await Promise.all([app.api.listReleases(), canPublish ? app.api.deployStatus() : Promise.resolve(null)]);
      releases = list.releases;
      hasScheduled = !!list.scheduled;
      deploy = status;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    if (visible) void refresh();
  });

  async function restore(release: Release) {
    const question = keepContent
      ? t('Ripristinare la versione {0} sul sito pubblicato, mantenendo i testi scritti dopo? Verrà creata una nuova versione.', release.version)
      : t('Ripristinare la versione {0} sul sito pubblicato, riportando anche i testi di allora? Verrà creata una nuova versione.', release.version);
    if (!window.confirm(hasScheduled ? `${question} ${t('Ripristinare annulla anche la release programmata.')}` : question)) return;
    busy = true;
    message = '';
    try {
      const done = await app.api.restore(release.id, keepContent);
      message = t('Ripristinata: ora online la versione {0}.', done.version);
      await app.load();
      await refresh();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function deployNow() {
    if (!window.confirm(t('Generare il sito statico di ciò che è pubblicato e metterlo online su Cloudflare?'))) return;
    busy = true;
    message = t('Generazione e caricamento in corso…');
    try {
      const done = await app.api.deploy();
      message = [t('Online su Cloudflare: {0} file ({1} caricati).', done.files, done.uploaded), ...(done.warnings ?? [])].join(' ');
      await refresh();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function rollbackDeploy(d: Deploy) {
    // Contents withdrawn since that version was built come back online with it (doc 23, voce 171).
    const withdrawn = d.withdrawn && d.withdrawn.count > 0
      ? ' ' + t('Rimette online anche {0} contenuti ritirati dopo (bozze, privati o nel cestino): {1}. Per toglierli di nuovo, dopo pubblica ora su Cloudflare.', d.withdrawn.count, d.withdrawn.items.join(', ') + (d.withdrawn.count > d.withdrawn.items.length ? ', …' : ''))
      : '';
    if (!window.confirm(t('Rimettere online subito questa versione statica?') + withdrawn)) return;
    busy = true;
    try {
      const done = await app.api.rollbackDeploy(d.id);
      message = [t('Versione statica ripristinata.'), ...(done.warnings ?? [])].join(' ');
      await refresh();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** In the language of the interface, as the other dates of the builder (D7). */
  const date = (value: string) => new Date(value.replace(' ', 'T') + 'Z').toLocaleString(dateLocale());
</script>

<div class="history">
  {#if canPublish}
    <label class="keep"><input type="checkbox" bind:checked={keepContent} /> {t('Nei ripristini mantieni i testi scritti dopo quella versione')}</label>
  {/if}
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if releases.length === 0}
    <p class="hint">{t('Nessuna versione pubblicata finora.')}</p>
  {/if}
  {#if deploy}
    <section class="cloudflare">
      <h3>Cloudflare</h3>
      {#if !deploy.config.ready}
        <p class="hint">{t('Non configurato: Impostazioni → Histeon → Pubblicazione su Cloudflare.')}</p>
      {:else}
        <p class="hint">Worker <code>{deploy.config.script}</code>{deploy.auto ? ' · ' + t('pubblicazione automatica a ogni release') : ''}</p>
        {#if canPublish}<button onclick={deployNow} disabled={busy}>{t('Pubblica ora su Cloudflare')}</button>{/if}
        <ul>
          {#each deploy.history.slice(0, 8) as d (d.id)}
            <li class={d.status}>
              <span>{date(d.created)} · {d.message || d.version_id.slice(0, 8)}</span>
              <span class="status">{d.status === 'live' ? t('online') : d.status === 'blocked' ? t('bloccato') : ''}</span>
              {#if canPublish && d.status === 'superseded'}
                {#if d.withdrawn && d.withdrawn.count > 0}<span class="withdrawn" title={d.withdrawn.items.join(', ')}>{t('contenuti ritirati dopo: {0}', d.withdrawn.count)}</span>{/if}
                <button onclick={() => rollbackDeploy(d)} disabled={busy}>{t('Rimetti online')}</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if canManage}
    <section class="import">
      <h3>{t('Importa una release')}</h3>
      <p class="hint">{t("Da un file .xbrelease esportato da un altro sito (locale, staging…). Prima un'anteprima; poi tutto finisce in sviluppo, filtrato con i tuoi permessi, e va online solo quando pubblichi.")}</p>
      <label class="file">{t('Scegli il file…')} <input type="file" accept=".xbrelease,application/json" onchange={chooseImport} disabled={busy} hidden /></label>
      {#if importReport}
        <div class="report">
          <p><strong>{t('Versione {0}', importReport.release)}</strong> {t('da')} <code>{importReport.site}</code>{importReport.written ? ' — ' + t('importata') : ' — ' + t('anteprima')}</p>
          <ul>
            {#each importReport.documents as row, i (i)}<li>{row.action}: {row.label}</li>{/each}
          </ul>
          {#each importReport.issues as issue, i (i)}<p class="warn">⚠ {issue}</p>{/each}
          {#if importReport.signature}
            {@const sig = importReport.signature}
            <p class="signature {sig.status}" role="status">
              {#if sig.status === 'own'}{t('Firmato da questo sito.')}
              {:else if sig.status === 'trusted' || sig.status === 'rotated'}{t('Firmato da un sito di cui ti fidi ({0}).', sig.site)}
              {:else if sig.status === 'new'}{t('Firmato da una chiave che questo sito non conosce: sito dichiarato {0}, impronta {1}. Confrontala con quella in Impostazioni → Firma degli export del sito di origine.', sig.site, sig.fingerprint)}
              {:else if sig.status === 'unsigned'}{t('Il file non è firmato: non si sa da quale sito arriva.')}
              {:else if sig.status === 'revoked'}{t('Firmato con una chiave revocata: non si può importare.')}
              {:else if sig.status === 'invalid'}{t('La firma non corrisponde al contenuto: non si può importare.')}{/if}
            </p>
            {#if sig.status === 'new' && !importReport.written}<label class="check"><input type="checkbox" bind:checked={trustKey} /> {t('Mi fido di questa chiave (impronta {0})', sig.fingerprint)}</label>{/if}
            {#if sig.status === 'unsigned' && !importReport.written}<label class="check"><input type="checkbox" bind:checked={allowUnsigned} /> {t('Importa anche senza firma')}</label>{/if}
          {/if}
          {#if !importReport.written && importData}
            {@const status = importReport.signature?.status}
            <button onclick={() => runImport(true)} disabled={busy || status === 'invalid' || status === 'revoked' || (status === 'new' && !trustKey) || (status === 'unsigned' && !allowUnsigned)}>{t('Importa in sviluppo')}</button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  <h3>{t('Versioni')}</h3>
  {#if adminHistory}
    <p class="admin-link"><a href={adminHistory} target={embed ? '_blank' : undefined} rel={embed ? 'noopener' : undefined}>{t('Tutte le versioni di questa pagina, con confronto e ripristino ↗')}</a></p>
  {/if}
  <ol>
    {#each releases as release (release.id)}
      <li class:current={release.current}>
        <div class="head">
          <strong>{release.version}</strong>
          {#if release.current}<span class="badge">{t('online')}</span>{/if}
          <span class="meta">{date(release.created)} · {release.authorName}</span>
        </div>
        {#if release.notes}<p>{release.notes}</p>{/if}
        {#if release.checks}
          {@const c = release.checks}
          <p class="hint" title={t('Quello che i controlli della finestra Pubblica avevano trovato: un promemoria, non una prova.')}>{tn('Uscita con {0} errore e {1}', 'Uscita con {0} errori e {1}', c.errors, c.errors, tn('{0} avviso', '{0} avvisi', c.warnings, c.warnings))}{#if c.pages}{tn(', su {0} di {1} pagina', ', su {0} di {1} pagine', c.pages.total, c.pages.checked, c.pages.total)}{/if}</p>
        {/if}
        <div class="buttons">
          {#if canPublish && !release.current}
            <button onclick={() => restore(release)} disabled={busy}>{t('Ripristina')}</button>
          {/if}
          {#if canManage}<button onclick={() => exportRelease(release)} disabled={busy} title={t('Scarica un file .xbrelease da importare su un altro sito')}>{t('Esporta')}</button>{/if}
        </div>
      </li>
    {/each}
  </ol>
</div>

<style>
  .history { padding: 12px 16px; display: grid; gap: 12px; align-content: start; font-size: 13px; overflow: auto; height: 100%; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { border: 1px solid var(--xb-line); border-radius: var(--xb-r); padding: 8px 10px; display: grid; gap: 6px; }
  li.current { border-color: var(--xb-ok); }
  .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .meta, .hint { color: var(--xb-muted); }
  .badge { font-size: 11px; color: var(--xb-ok); border: 1px solid var(--xb-ok); border-radius: 999px; padding: 0 6px; }
  p { margin: 0; }
  .keep { display: flex; gap: 8px; align-items: center; color: var(--xb-muted); }
  .message { color: var(--xb-ok); }
  .admin-link { margin: 0; font-size: 12px; }
  .admin-link a { color: var(--xb-link); }
  h3 { margin: 4px 0 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .cloudflare { display: grid; gap: 8px; }
  .buttons { display: flex; gap: 6px; }
  .import, .report { display: grid; gap: 6px; }
  .report ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 12px; }
  .report li { border: 0; padding: 0; }
  .warn { color: var(--xb-danger); font-size: 12px; }
  .file { justify-self: start; font: 12.5px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); cursor: pointer; }
  .cloudflare ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .cloudflare li { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 12px; color: var(--xb-muted); }
  .cloudflare li.live .status { color: var(--xb-ok); }
  .cloudflare li.blocked .status { color: var(--xb-danger); }
  .cloudflare li .withdrawn { color: var(--xb-danger); }
  button { justify-self: start; font: 12.5px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
</style>
