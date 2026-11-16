<script lang="ts">
  import { connectorApi, type ConnectorWordPressMode } from "../lib/api.js";
  import { translate, type Language } from "../lib/i18n.js";
  import { modal } from "../lib/modal.js";
  import type { CmsRemoteConnection } from "../lib/app-types.js";

  /**
   * What the AI agent may send to this linked site, chosen next to the connection itself (the «Siti collegati» card of
   * the project): the "Agente AI" screen only shows it. "Senza chiedere" is confirmed in a dialog that names the site.
   */
  let { language, act, busy, connection }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    connection: CmsRemoteConnection;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  // Doc 23 item 203: «Solo prove» lets the agent do only the dry run; the server refuses its real send.
  const MODES: ConnectorWordPressMode[] = ["off", "dry-run", "confirm", "auto"];
  const host = $derived(new URL(connection.url).hostname);

  let mode = $state<ConnectorWordPressMode | null>(null);
  let saved = $state("");
  let confirmAuto = $state(false);

  $effect(() => {
    const id = connection.id;
    mode = null;
    saved = "";
    connectorApi.wordPressMode(id).then((result) => { if (result.connectionId === connection.id) mode = result.mode; }, () => { mode = null; });
  });

  function choose(next: ConnectorWordPressMode): void {
    if (next === "auto") { confirmAuto = true; return; }
    save(next);
  }

  function save(next: ConnectorWordPressMode): void {
    void act(async () => {
      const result = await connectorApi.setWordPressMode(connection.id, next);
      mode = result.mode;
      saved = t("connector.modeSaved", { host, mode: t(`connector.mode.${result.mode}`) });
    });
  }
</script>

<div class="agent-send-mode">
  <label class="field-label" for={`agent-send-${connection.id}`}>{t("connector.siteModeLabel")}</label>
  {#if mode === null}
    <p class="muted">{t("connector.siteModeUnknown")}</p>
  {:else}
    <div class="agent-send-row">
    <select id={`agent-send-${connection.id}`} data-testid="cms-agent-send-mode" data-connection-id={connection.id} value={mode} disabled={busy || !connection.write} onchange={(event) => { const value = event.currentTarget.value as ConnectorWordPressMode; if (value === "auto") event.currentTarget.value = mode ?? "off"; choose(value); }}>
      {#each MODES as option (option)}<option value={option}>{t(`connector.mode.${option}`)}</option>{/each}
    </select>
    <!-- Doc 23 item 191: the choice saves itself; the owner looked for a «Salva» button, so it says so beside the menu. -->
    <span class="agent-send-saved" role="status" data-testid="cms-agent-send-saved">{saved ? `✓ ${t("connector.siteModeSaved")}` : ""}</span>
    </div>
    <p class="field-hint">{connection.write ? t("connector.siteModeHint") : t("connector.readOnly")}</p>
    {#if mode === "auto"}<p class="agent-send-warning" role="note">{t("connector.autoWarning")}</p>{/if}
  {/if}
</div>

{#if confirmAuto}
  <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) confirmAuto = false; }}>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby={`agent-send-auto-${connection.id}`} tabindex="-1" data-testid="cms-agent-auto-dialog" use:modal={{ onClose: () => confirmAuto = false }}>
      <div class="eyebrow">{t("connector.eyebrow")}</div>
      <h2 id={`agent-send-auto-${connection.id}`}>{t("connector.autoConfirmTitle", { host })}</h2>
      <p>{t("connector.autoWarning")}</p>
      <div class="modal-actions">
        <button type="button" class="button outline" onclick={() => confirmAuto = false}>{t("connector.cancel")}</button>
        <button type="button" class="button dark" data-testid="cms-agent-auto-confirm" onclick={() => { confirmAuto = false; save("auto"); }}>{t("connector.autoConfirm")}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .agent-send-mode { display: grid; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .agent-send-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .agent-send-mode select { width: auto; max-width: 100%; min-width: 220px; }
  .agent-send-saved { color: var(--mint-ink, #2f6b4f); font-size: 14px; font-weight: 700; }
  .agent-send-saved:empty { display: none; }
  .agent-send-mode p { margin: 0; }
  .agent-send-warning { padding: 9px 11px; border-radius: 6px; background: #fff4e8; color: #845923; font-size: 13px; line-height: 1.55; }
  @media (prefers-color-scheme: dark) {
    .agent-send-warning { background: #302821; color: #f0c99a; }
  }
</style>
