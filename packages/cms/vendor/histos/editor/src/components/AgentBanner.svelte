<script lang="ts">
  // Restore point before the AI agent (lista della spesa 158): while an agent's session has changes, a bar says
  // which documents it touched, with «Tieni» and «Annulla tutto». Undo brings each one back to how it was before
  // the agent's first write, as a new version in development; the builder then reloads what is open.
  import { onMount } from 'svelte';
  import { t, tn } from '../lib/i18n.ts';
  import type { AgentSessionInfo } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  let { app }: { app: BuilderState } = $props();
  let sessions = $state<AgentSessionInfo[]>([]);
  let busy = $state(false);
  let message = $state('');

  /** Where the route does not exist (Histeon Publish's local projects) the bar stops asking after the first answer. */
  let unavailable = false;

  async function refresh() {
    if (unavailable) return;
    try {
      sessions = await app.api.getAgentSessions();
    } catch {
      sessions = [];
      unavailable = true;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), 30_000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  });

  async function act(session: AgentSessionInfo, action: 'keep' | 'undo') {
    if (action === 'undo' && app.dirty && !confirm(t('Hai modifiche non salvate in questo documento: annullando le modifiche dell’agente le perdi. Procedere?'))) return;
    busy = true;
    message = '';
    try {
      const result = await app.api.agentSession(session.user, action);
      const failed = Object.entries(result.failed ?? {});
      message = action === 'keep' ? t('Tenute le modifiche dell’agente.') : failed.length ? t('Annullate, tranne: {0}.', failed.map(([doc, why]) => `${session.docs.find((d) => d.doc === doc)?.label ?? doc} (${why})`).join(', ')) : t('Modifiche dell’agente annullate: tutto è com’era prima.');
      if (action === 'undo' && (result.restored ?? []).length) await app.load();
      await refresh();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const time = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

{#each sessions as session (session.user)}
  <div class="xb-agent-bar" role="region" aria-label={t('Modifiche dell’agente AI')}>
    <p>
      <strong>{session.active ? t('L’agente AI sta lavorando') : t('L’agente AI ha finito')}</strong>
      {tn('ha cambiato {0} documento dalle {1}', 'ha cambiato {0} documenti dalle {1}', session.docs.length, session.docs.length, time(session.started))}{session.mine ? '' : ` (${session.userName})`}:
      {session.docs.map((d) => d.label || d.doc).join(', ')}.
    </p>
    <button disabled={busy} onclick={() => act(session, 'keep')}>{t('Tieni')}</button>
    <button class="danger" disabled={busy} onclick={() => act(session, 'undo')}>{t('Annulla tutto')}</button>
  </div>
{/each}
{#if message}<p class="xb-agent-note" role="status">{message}</p>{/if}

<style>
  .xb-agent-bar { position: fixed; left: 50%; bottom: 56px; transform: translateX(-50%); z-index: 60; display: flex; gap: 8px; align-items: center; max-width: min(760px, calc(100vw - 32px)); padding: 8px 12px; border-radius: 10px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-accent, #e2725b); box-shadow: 0 8px 24px rgb(0 0 0 / 0.2); font-size: 12.5px; }
  p { margin: 0; flex: 1; }
  button { font: 12.5px var(--xb-sans); padding: 5px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; white-space: nowrap; }
  button.danger { border-color: var(--xb-danger); color: var(--xb-danger); }
  .xb-agent-note { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 60; padding: 6px 12px; border-radius: 8px; background: var(--xb-bg); border: 1px solid var(--xb-line); font-size: 12.5px; }
</style>
