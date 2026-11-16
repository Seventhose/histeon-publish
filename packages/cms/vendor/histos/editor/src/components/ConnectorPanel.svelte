<script lang="ts">
  import { CONNECTOR_PORT, SCOPES, SCOPE_LABELS, connectorCommands, type ConnectorClient, type Scope } from '../lib/connector.svelte.ts';
  import { MAX_REQUEST, sectionInstructions, translateInstructions, type TaskContext } from '../lib/aiTasks.svelte.ts';
  import type { LanguageItem } from '../lib/config.ts';
  import Icon from './Icon.svelte';
  import { t } from '../lib/i18n.ts';

  // ✦ AI (docs/spec/connector.md): connects this tab to the Histeon Connector on the user's computer, so a local
  // agent (Claude Code, Codex, Opencode…) can work here. Nothing connects until "Collega" is clicked.
  /** context: the open document, for the requests; languages: the page's languages (Lingua Bridge), if any. */
  /** scopes: the areas the agent may change (voce 215); `save` is given to whoever may change them (administrators). */
  let { connector, scriptUrl, pair = null, context, languages = [], saveScopes = null }: { connector: ConnectorClient; scriptUrl: string | null; pair?: { origin: string; secret: string; rotate: string | null } | null; context: () => TaskContext; languages?: LanguageItem[]; saveScopes?: ((scopes: string[]) => Promise<string[]>) | null } = $props();

  const AREAS = Object.keys(SCOPES) as Scope[];
  let scopeError = $state('');
  let scopeSaved = $state(false);
  async function toggleScope(scope: Scope, on: boolean) {
    if (!saveScopes) return;
    scopeError = '';
    scopeSaved = false;
    const wanted = AREAS.filter((a) => (a === scope ? on : connector.scopes.has(a)));
    try {
      connector.scopes = new Set(await saveScopes(wanted));
      scopeSaved = true;
    } catch (e) {
      scopeError = e instanceof Error ? e.message : String(e);
    }
  }

  let request = $state('');
  let askError = $state('');
  /** Languages to translate into: every one but the page's own, untranslated ones first. */
  const targets = $derived(languages.filter((l) => l.state !== 'current').sort((a, b) => Number(a.state !== 'missing') - Number(b.state !== 'missing')));
  let chosenLanguages = $state<Record<string, boolean>>({});
  const openTasks = $derived(connector.tasks.items.filter((task) => task.status !== 'done').length);

  function askSection() {
    askError = '';
    try {
      connector.tasks.add('section', request, sectionInstructions(context()));
      request = '';
    } catch (e) {
      askError = e instanceof Error ? e.message : String(e);
    }
  }

  function askTranslation() {
    askError = '';
    const picked = targets.filter((l) => chosenLanguages[l.code] ?? l.state !== 'publish');
    if (picked.length === 0) {
      askError = t('Scegli almeno una lingua.');
      return;
    }
    try {
      connector.tasks.add('translate', picked.map((l) => l.label).join(', '), translateInstructions(context(), picked));
    } catch (e) {
      askError = e instanceof Error ? e.message : String(e);
    }
  }

  let open = $state(false);
  let copied = $state('');
  let root: HTMLDivElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();
  // Like the other popovers: a click elsewhere or Esc closes it (Esc closes only this), and the focus goes back.
  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      open = false;
      button?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  });
  const label = $derived(connector.state === 'connected' ? t('Agente AI collegato') : connector.state === 'waiting' ? t('Agente AI: in attesa del connettore') : t('Agente AI'));

  /** The manual for AI agents, next to the connector (it also travels inside it: `histos-connector manual`). */
  /** The pairing flags: the connector accepts this builder only, and the two recognise each other. */
  // The secret goes through stdin into a 0600 file, never into the command line of the long-running `serve` or `mcp`.
  const pairing = $derived(connectorCommands('histos-connector.mjs', pair).pair);
  /** The same commands with the connector's full path, for an MCP client that starts it from anywhere. */
  const mcpCommands = $derived(connectorCommands('/percorso/histos-connector.mjs', pair));
  const manualUrl = $derived(scriptUrl ? new URL('HISTOS-AI.md', scriptUrl).href : null);
  const agentText = $derived(
    t('Avvia il connettore Histeon per lavorare nella scheda del builder che ho aperto:') + '\n' +
      (scriptUrl ? t("1. Scarica {0} come histos-connector.mjs (se non l'hai già).", scriptUrl) + '\n' : '') +
      (pairing ? t('2. Abbina il connettore a questa scheda: {0}', pairing) + '\n' + '   ' + t('poi esegui in background: node histos-connector.mjs serve') + '\n' : t('2. Esegui in background: node histos-connector.mjs serve') + '\n') +
      t('3. Prima di modificare leggi tutto il manuale: node histos-connector.mjs manual') + '\n' +
      '   ' + t('(come si costruisce in Histeon: classi BEM e stile per selettore, variabili del framework invece di classi utility,') + '\n' +
      '   ' + t('componenti, contenuti dinamici, accessibilità), poi: node histos-connector.mjs brief (cosa ha questo sito).') + '\n' +
      t('4. Poi lavora le richieste che scrivo nel builder, una alla volta: node histos-connector.mjs next-task --wait 600') + '\n' +
      '   ' + t("(segui le istruzioni del builder che le accompagnano, chiudi ognuna con done <id> '<nota>', non pubblicare)."),
  );

  async function copy(what: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copied = what;
      setTimeout(() => (copied = ''), 1500);
    } catch {
      copied = '';
    }
  }
</script>

<div class="wrap" bind:this={root}>
  <button class="ai {connector.state}" bind:this={button} title={label} aria-label={label} aria-expanded={open} onclick={() => (open = !open)}><Icon name="sparkle" /></button>
  {#if open}
    <div class="pop" role="dialog" aria-label={t('Connettore AI')}>
      <header>
        <strong>{t('Connettore AI')}</strong>
        <span class="state" role="status">
          {connector.state === 'connected' ? t('Collegato') : connector.state === 'waiting' ? t('In attesa del connettore…') : t('Scollegato')}
        </span>
      </header>
      <p>{t('Fa lavorare in questa scheda un agente AI del tuo computer (Claude Code, Codex, Opencode…). Vedi ogni modifica qui, puoi annullarla, e si salva solo in sviluppo: pubblicare resta a te.')}</p>
      <ol>
        <li>
          {t('Incolla nella chat del tuo agente:')}
          <pre>{agentText}</pre>
          <button onclick={() => copy('agent', agentText)}>{copied === 'agent' ? t('Copiato') : t('Copia le istruzioni')}</button>
          {#if scriptUrl}<a href={scriptUrl} download="histos-connector.mjs">{t('Scarica histos-connector.mjs')}</a>{/if}
          {#if manualUrl}<a href={manualUrl} download="HISTOS-AI.md">{t("Manuale per l'AI")}</a>{/if}
        </li>
        <li>
          {#if connector.state === 'off'}
            <button class="primary" onclick={() => connector.start()}>{t('Collega questa scheda')}</button>
          {:else}
            <button onclick={() => connector.stop()}>{t('Scollega')}</button>
          {/if}
        </li>
      </ol>
      {#if connector.problem}<p class="problem" role="alert">{connector.problem}</p>{/if}
      <section class="ask" aria-label={t("Chiedi all'agente")}>
        <h3>{t("Chiedi all'agente")} {#if openTasks}<span class="pill">{t('{0} in coda', openTasks)}</span>{/if}</h3>
        <label for="xb-ai-request">{t('Descrivi la sezione da creare')}</label>
        <textarea id="xb-ai-request" bind:value={request} rows="3" maxlength={MAX_REQUEST} placeholder={t('Es.: tre testimonianze con foto, nome e ruolo, su sfondo chiaro')}></textarea>
        <div class="row">
          <button class="primary" onclick={askSection} disabled={!request.trim()}>{t('Crea una sezione')}</button>
          <span class="hint">{context().selection ? t('dopo l’elemento selezionato') : t('in fondo alla pagina')}{context().framework?.id === 'xb-tokens' ? t(', con token e classi BEM di Histeon CSS') : ''}</span>
        </div>
        {#if targets.length}
          <fieldset>
            <legend>{t('Traduci questa pagina (bozze di Lingua Bridge)')}</legend>
            {#each targets as l (l.code)}
              <label class="lang"><input type="checkbox" checked={chosenLanguages[l.code] ?? l.state !== 'publish'} onchange={(e) => (chosenLanguages = { ...chosenLanguages, [l.code]: e.currentTarget.checked })} /> {l.label} <small>{l.state === 'missing' ? t('da tradurre') : l.state === 'draft' ? t('bozza') : t('pubblicata: correzione in bozza')}</small></label>
            {/each}
            <button onclick={askTranslation}>{t('Traduci')}</button>
          </fieldset>
        {/if}
        {#if askError}<p class="problem" role="alert">{askError}</p>{/if}
        {#if connector.tasks.items.length}
          <ul class="tasks">
            {#each connector.tasks.items as task (task.id)}
              <li class={task.status}>
                <span class="t-head"><strong>{task.kind === 'section' ? t('Sezione') : t('Traduzione')}</strong> · {task.status === 'waiting' ? t('in attesa dell’agente') : task.status === 'working' ? t('l’agente ci lavora') : t('fatta')} · {task.created}
                  {#if task.status === 'waiting'}<button class="x" aria-label={t('Ritira la richiesta')} onclick={() => connector.tasks.remove(task.id)}>×</button>{/if}</span>
                <span class="t-req">{task.request}</span>
                {#if task.note}<span class="t-note">{task.note}</span>{/if}
              </li>
            {/each}
          </ul>
          {#if connector.state !== 'connected'}<p class="hint">{t('Le richieste aspettano qui finché un agente si collega e chiede la prossima (next-task).')}</p>{/if}
        {/if}
      </section>
      <details class="scopes">
        <summary>{t("Cosa può fare l'agente")} <span class="hint">{t('{0} aree su {1}', AREAS.filter((a) => connector.scopes.has(a)).length, AREAS.length)}</span></summary>
        <p class="hint">{t("Leggere si può sempre; salvare va solo in sviluppo e pubblicare resta tuo. Contenuti e media cambiano subito il sito. Vale per questo sito, anche per gli agenti che lavorano da fuori (Abilities di WordPress).")}</p>
        <ul>
          {#each AREAS as area (area)}
            <li><label><input type="checkbox" checked={connector.scopes.has(area)} disabled={!saveScopes} onchange={(e) => void toggleScope(area, e.currentTarget.checked)} /> {SCOPE_LABELS[area]}</label></li>
          {/each}
        </ul>
        {#if !saveScopes}<p class="hint">{t("Lo sceglie un amministratore del sito.")}</p>{/if}
        {#if scopeSaved}<p class="hint" role="status">{t('✓ Salvato')}</p>{/if}
        {#if scopeError}<p class="problem" role="alert">{scopeError}</p>{/if}
      </details>
      <details>
        <summary>{t('Accoppiamento')}</summary>
        <p>{t("Il comando contiene un segreto tuo: con esso il connettore e questa scheda si riconoscono a vicenda, così nessun sito web e nessun altro programma possono collegarsi al loro posto. Non condividerlo; se l'hai condiviso, rigeneralo, poi ricopia le istruzioni e riavvia il connettore.")}</p>
        {#if pair?.rotate}<a href={pair.rotate}>{t('Rigenera il segreto')}</a>{/if}
      </details>
      <details>
        <summary>{t('Lavora dai file (VS Code)')}</summary>
        <p>{t('Con la scheda collegata, la pagina e i suoi stili diventano file di una cartella, sincronizzati nei due sensi: salvi nel tuo editor e qui si aggiorna; cambi qui e il file segue.')}</p>
        <pre>node /percorso/histos-connector.mjs sync ./sito</pre>
        <p>{t('Una sottocartella per documento:')} <code>page.html</code> {t('e un')} <code>.css</code> {t('per selettore. Segue anche i componenti aperti in sessione. Se cambiano entrambi, non si perde nulla: la versione del builder va in')} <code>.builder</code>.</p>
      </details>
      <details>
        <summary>{t('Come server MCP')}</summary>
        <p>{t('Una volta per tutte, nel terminale:')}</p>
        {#if mcpCommands.pair}
          <p>{t('Prima abbina il connettore a questa scheda (il segreto passa da stdin e resta in un file tuo):')}</p>
          <pre>{mcpCommands.pair}</pre>
          <p>{t('Poi aggiungi il server MCP, che usa l’abbinamento salvato:')}</p>
        {/if}
        <pre>claude mcp add xb -- {mcpCommands.mcp}</pre>
        <pre>codex mcp add xb -- {mcpCommands.mcp}</pre>
        <p>{t('Il connettore ascolta solo su 127.0.0.1:{0}; i comandi richiedono un token che resta nel tuo computer (~/.histos-connector).', CONNECTOR_PORT)}</p>
      </details>
      {#if connector.log.length}
        <h3>{t("Operazioni dell'agente")}</h3>
        <ul class="log">
          {#each connector.log as entry, i (i)}
            <li class:err={!entry.ok}>{entry.at} · {entry.method}{entry.error ? ` — ${entry.error}` : ''}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; display: contents; }
  .ai.waiting :global(svg) { opacity: 0.6; animation: pulse 1.4s ease-in-out infinite; }
  .ai.connected { color: var(--xb-link); }
  .problem { margin: 8px 0; padding: 6px 8px; border-left: 3px solid var(--xb-danger, #b32d2e); background: color-mix(in srgb, var(--xb-danger, #b32d2e) 8%, transparent); }
  @keyframes pulse { 50% { opacity: 0.2; } }
  @media (prefers-reduced-motion: reduce) { .ai.waiting :global(svg) { animation: none; } }
  .pop { position: fixed; z-index: 50; left: 64px; bottom: 16px; width: min(420px, 90vw); max-height: 80vh; overflow: auto; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-lg); padding: 12px 14px; font-size: 12px; box-shadow: var(--xb-shadow); }
  header { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .state { color: var(--xb-muted); }
  ol { padding-left: 18px; display: grid; gap: 10px; }
  pre { white-space: pre-wrap; background: color-mix(in srgb, var(--xb-text) 6%, transparent); padding: 6px 8px; border-radius: var(--xb-r); font: 11px var(--xb-mono, monospace); margin: 4px 0; }
  h3 { font-size: 12px; margin: 10px 0 4px; }
  .log { list-style: none; padding: 0; margin: 0; color: var(--xb-muted); }
  .scopes ul { list-style: none; padding: 0; margin: 4px 0; display: grid; gap: 4px; }
  .log .err { color: var(--xb-danger); }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  a { margin-left: 8px; color: var(--xb-link); }
  .ask { border-top: 1px solid var(--xb-line); margin-top: 10px; padding-top: 4px; display: grid; gap: 6px; }
  .ask label { color: var(--xb-muted); }
  .ask textarea { font: 12.5px var(--xb-sans); padding: 6px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); resize: vertical; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .hint { color: var(--xb-muted); font-size: 11.5px; margin: 0; }
  .pill { font-weight: 500; font-size: 11px; padding: 1px 6px; border-radius: 99px; background: color-mix(in srgb, var(--xb-accent) 15%, transparent); color: var(--xb-link); }
  fieldset { border: 1px solid var(--xb-line); border-radius: var(--xb-r); padding: 6px 8px; display: grid; gap: 4px; }
  legend { color: var(--xb-muted); font-size: 11.5px; }
  .lang { display: flex; gap: 6px; align-items: center; color: var(--xb-text) !important; }
  .lang small { color: var(--xb-muted); }
  fieldset button { justify-self: start; }
  .tasks { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
  .tasks li { display: grid; gap: 2px; padding: 5px 8px; border-radius: var(--xb-r-sm); border-left: 3px solid var(--xb-line); background: color-mix(in srgb, var(--xb-text) 4%, transparent); }
  .tasks li.working { border-color: var(--xb-accent); }
  .tasks li.done { border-color: var(--xb-ok); }
  .t-head { display: flex; gap: 4px; align-items: center; color: var(--xb-muted); }
  .t-req { white-space: pre-wrap; }
  .t-note { white-space: pre-wrap; color: var(--xb-text); border-top: 1px dashed var(--xb-line); padding-top: 2px; }
  .x { margin-left: auto; border: 0; padding: 0 4px; font-size: 14px; line-height: 1; }
</style>
