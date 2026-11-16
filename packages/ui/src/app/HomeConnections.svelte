<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsProject, CmsRemoteConnection } from "../lib/app-types.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";
  import HisteonVersionNotice from "./HisteonVersionNotice.svelte";

  /** The WordPress sites linked to this computer, and the form to pair one. */
  let { language, act, beginCmsUnlink, busy, cmsCatalogFilter, cmsConnections, cmsPairingCode = $bindable(), cmsPairingTargetId = $bindable(), cmsProjects, connectCmsSite, openCmsProject, pullCmsSite, pairingSiteUrl = $bindable(), pendingPairing, startPairing, confirmPairing, cancelPairing }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    beginCmsUnlink: (connection: CmsRemoteConnection) => void;
    busy: boolean;
    cmsCatalogFilter: "all" | "local" | "connected";
    cmsConnections: CmsRemoteConnection[];
    cmsPairingCode: string;
    cmsPairingTargetId: string;
    cmsProjects: CmsProject[];
    connectCmsSite: () => Promise<void>;
    openCmsProject: (projectId: string, navigation?: number) => Promise<void>;
    pullCmsSite: (connection: CmsRemoteConnection) => Promise<void>;
    /** Doc 23 item 237: pairing from the site in one click, and the confirmation when the site answers. */
    pairingSiteUrl: string;
    pendingPairing: { state: string; claim: string; siteUrl: string } | null;
    startPairing: () => Promise<void>;
    confirmPairing: () => Promise<void>;
    cancelPairing: () => void;
  } = $props();
  const host = (value: string) => { try { return new URL(value).hostname; } catch { return value; } };
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const formatDate = (value?: string) => formatDateIn(language, value);
</script>

<section class="panel-card cms-remote-panel" id="cms-connected-sites" aria-labelledby="cms-connect-title">
  <div class="panel-head"><span class="step-number">WP</span><div><h2 id="cms-connect-title" tabindex="-1">{cmsCatalogFilter === "connected" ? t("cms.connectTitle") : t("cms.connectedTitle")}</h2><p>{cmsCatalogFilter === "connected" ? t("cms.connectHint") : t("cms.connectedListHint")}</p></div></div>
  {#if pendingPairing}
    <div class="cms-remote-connect" role="alertdialog" aria-labelledby="cms-pair-confirm-title" aria-describedby="cms-pair-confirm-body">
      <h3 id="cms-pair-confirm-title">{t("cms.pairConfirmTitle", { host: host(pendingPairing.siteUrl) })}</h3>
      <p id="cms-pair-confirm-body">{t("cms.pairConfirmBody")}</p>
      <div class="cms-remote-actions">
        <button class="button primary" type="button" onclick={() => void act(confirmPairing)} disabled={busy}>{t("cms.pairConfirm")}</button>
        <button class="button text" type="button" onclick={cancelPairing} disabled={busy}>{t("cms.pairCancel")}</button>
      </div>
    </div>
  {/if}
  {#if cmsCatalogFilter === "connected"}
  <form class="cms-remote-connect" onsubmit={(event) => { event.preventDefault(); void act(startPairing); }}>
    <h3>{t("cms.pairFromSiteTitle")}</h3>
    <p class="field-hint">{t("cms.pairFromSiteHint")}</p>
    <label class="field-label" for="cms-pair-site">{t("cms.pairSiteUrl")}</label>
    <input id="cms-pair-site" type="url" inputmode="url" autocomplete="url" bind:value={pairingSiteUrl} maxlength="2048" placeholder="https://www.esempio.it" required />
    <button class="button primary" type="submit" disabled={busy || !pairingSiteUrl.trim()}>{t("cms.pairFromSite")}</button>
  </form>
  <form class="cms-remote-connect" onsubmit={(event) => { event.preventDefault(); void act(connectCmsSite); }}>
    <h3>{t("cms.pairOrCode")}</h3>
    {#if cmsConnections.length}
      <label class="field-label" for="cms-link-target">{t("cms.connectionTarget")}
        <select id="cms-link-target" bind:value={cmsPairingTargetId} disabled={busy}>
          <option value="">{t("cms.newConnection")}</option>
          {#each cmsConnections as connection (connection.id)}<option value={connection.id}>{connection.projectName || t("cms.siteName")} · {new URL(connection.url).hostname}</option>{/each}
        </select>
      </label>
      {#if cmsPairingTargetId}<p class="field-hint">{t("cms.reconnectHint")}</p>{/if}
    {/if}
    <label class="field-label" for="cms-pairing-code">{t("cms.pairCode")}</label>
    <textarea id="cms-pairing-code" bind:value={cmsPairingCode} rows="3" maxlength="16384" placeholder="histos-cms-1:…" required></textarea>
    <button class="button primary" type="submit" disabled={busy || !cmsPairingCode.trim()}>{cmsPairingTargetId ? t("cms.reconnect") : t("cms.connect")}</button>
  </form>
  {/if}
  {#if cmsConnections.length}
    <div class="cms-remote-list">
      {#each cmsConnections as connection (connection.id)}
        <article class="cms-remote-row">
          <div><strong>{connection.projectName || t("cms.siteName")}</strong><p class="muted">{new URL(connection.url).hostname} · {connection.profile} · {connection.write ? t("cms.readWrite") : t("cms.readOnly")}</p><p class="muted">{t("cms.lastSync")}: {formatDate(connection.lastSyncedAt ?? undefined)}</p>{#if connection.histeon}<HisteonVersionNotice {language} notice={connection.histeon} />{/if}</div>
          <div class="cms-remote-actions">
            <button class="button primary small" onclick={() => void act(() => pullCmsSite(connection))} disabled={busy || !connection.read}>{t("cms.downloadOpen")}</button>
            {#if connection.projectId && cmsProjects.some((project) => project.id === connection.projectId)}<button class="button outline small" onclick={() => void act(() => openCmsProject(connection.projectId!))} disabled={busy}>{t("cms.openCopy")}</button>{/if}
            <button class="button text small" onclick={() => beginCmsUnlink(connection)} disabled={busy}>{t("cms.unlink")}</button>
          </div>
        </article>
      {/each}
    </div>
  {:else}<p class="muted">{t("cms.noConnections")}</p>{/if}
</section>
