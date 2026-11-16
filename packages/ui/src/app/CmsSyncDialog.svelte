<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsRemoteConnection, CmsSyncConflictChoice, CmsSyncPlan, CmsSyncPlanStatus } from "../lib/app-types.js";
  import { contentKind, groupByKind, kindName } from "../lib/site-content-kinds.js";
  import HisteonVersionNotice from "./HisteonVersionNotice.svelte";

  type PlanEntity = CmsSyncPlan["entities"][number];

  /**
   * What a sync with a linked site would do, conflict by conflict, before it does. Doc 23 item 199: the conflicts by
   * type, the two versions side by side, and one choice for a whole group; from a send, «Risolvi i conflitti» downloads
   * only the conflicts. Item 200: on a send, the contents only on the site by type and title, and «Porta nel progetto»
   * for the ones chosen.
   */
  let { language, act, applyCmsSyncPlan, bringCmsEntities, busy, closeCmsSyncPlan, cmsSyncChoices, cmsSyncConnection, cmsSyncPlan, cmsSyncPlanReady, pullCmsSite, setCmsSyncChoice }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    applyCmsSyncPlan: () => Promise<void>;
    /** A download plan of only these entries of the site (and what they need). */
    bringCmsEntities: (connection: CmsRemoteConnection, ids: string[]) => Promise<void>;
    busy: boolean;
    closeCmsSyncPlan: () => void;
    cmsSyncChoices: Record<string, CmsSyncConflictChoice | "">;
    cmsSyncConnection: CmsRemoteConnection | null;
    cmsSyncPlan: CmsSyncPlan;
    cmsSyncPlanReady: () => boolean;
    pullCmsSite: (connection: CmsRemoteConnection) => Promise<void>;
    setCmsSyncChoice: (entityId: string, value: string) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;

  const sending = $derived(cmsSyncPlan.action !== "pull");
  const kindOf = (entity: PlanEntity) => contentKind(entity.kind, entity.documentType);
  const conflicts = $derived(cmsSyncPlan.entities.filter((entity) => entity.status === "conflict"));
  const resolvable = $derived(conflicts.filter((entity) => entity.canResolve));
  const conflictGroups = $derived(groupByKind(conflicts, kindOf));
  const onSite = $derived(sending ? cmsSyncPlan.entities.filter((entity) => entity.status === "remote-only") : []);
  const onSiteGroups = $derived(groupByKind(onSite, kindOf));
  const others = $derived(cmsSyncPlan.entities.filter((entity) => entity.status !== "conflict" && !(sending && entity.status === "remote-only")));
  const chosenCount = $derived(resolvable.filter((entity) => cmsSyncChoices[entity.id] === "keep-local" || cmsSyncChoices[entity.id] === "use-remote").length);
  const bringable = (entity: PlanEntity) => entity.kind !== "styles" && entity.kind !== "tombstone";
  /** The most conflicts one download settles (the server's limit of choices in a plan); the rest in the next one. */
  const MAX_RESOLVED = 250;

  let selected = $state<string[]>([]);
  $effect(() => { void cmsSyncPlan; selected = []; });
  function toggle(id: string, on: boolean): void {
    selected = on ? [...new Set([...selected, id])] : selected.filter((candidate) => candidate !== id);
  }
  function chooseAll(items: PlanEntity[], choice: CmsSyncConflictChoice): void {
    for (const entity of items) if (entity.canResolve) setCmsSyncChoice(entity.id, choice);
  }

  function cmsSyncStatusText(status: CmsSyncPlanStatus): string {
    const labels: Record<CmsSyncPlanStatus, [string, string]> = {
      new: ["Nuovo", "New"], update: ["Da aggiornare", "To update"], unchanged: ["Già allineato", "Already aligned"],
      delete: ["Da rimuovere", "To remove"], "local-only": ["Solo in locale", "Local only"], "remote-only": ["Solo sul sito", "Remote only"], conflict: ["Conflitto", "Conflict"],
    };
    return say(...labels[status]);
  }
  const title = $derived(cmsSyncPlan.action === "pull"
    ? cmsSyncPlan.bring ? (cmsSyncPlan.counts.conflict ? say("Risolvi i conflitti", "Resolve the conflicts") : say("Porta nel progetto", "Bring into the project")) : say("Scarica dal sito", "Download from site")
    : cmsSyncPlan.action === "publish" ? say("Pubblica sul sito", "Publish to site") : say("Invia al sito", "Send to site"));
</script>

{#snippet entityRow(entity: PlanEntity)}
  <div class="cms-sync-entity" class:conflict={entity.status === "conflict"} data-testid="cms-sync-entity">
    <div class="cms-sync-entity-info"><strong>{entity.label}</strong><small>{kindName(language, kindOf(entity))}</small>
      {#if entity.status === "conflict" && !entity.canResolve}
        <small>{entity.blockedReason === "local-missing" ? say("La copia locale manca. La versione sul sito è conservata; la cancellazione non viene propagata automaticamente.", "The local copy is missing. The site version is preserved; deletion is not propagated automatically.") : entity.blockedReason === "remote-missing" ? say("La copia sul sito manca. La versione locale è conservata; la cancellazione non viene propagata automaticamente.", "The site copy is missing. The local version is preserved; deletion is not propagated automatically.") : entity.blockedReason === "type-changed" ? say("Il tipo dell’entità è cambiato. Puoi confrontare i dati, ma l’applicazione resta bloccata per proteggere entrambe le copie.", "The entity type changed. You can compare the data, but applying it stays blocked to protect both copies.") : entity.blockedReason === "tombstone-conflict" ? say("La cancellazione non corrisponde più alla base comune: una copia è cambiata. Le due versioni restano integre; aggiorna il piano prima di continuare.", "The deletion no longer matches the shared base because one copy changed. Both versions are preserved; refresh the plan before continuing.") : entity.blockedReason === "tombstone-unsupported" ? say("Questo tipo di contenuto non può ancora essere cancellato in modo recuperabile. Le copie restano integre.", "This content type cannot yet be deleted with recovery. Both copies are preserved.") : say("Questo conflitto non può essere applicato automaticamente. Entrambe le copie restano intatte.", "This conflict cannot be applied automatically. Both copies are preserved.")}</small>
      {/if}
    </div>
    <span class="cms-sync-status" class:conflict={entity.status === "conflict"}>{cmsSyncStatusText(entity.status)}</span>
    {#if entity.status === "conflict" && entity.comparison?.length}
      <details class="cms-sync-comparison">
        <summary>{entity.comparison.length === 1 ? say("Confronta il campo modificato", "Compare the changed field") : say(`Confronta ${entity.comparison.length} campi modificati`, `Compare ${entity.comparison.length} changed fields`)}</summary>
        <div class="cms-sync-comparison-table-wrap">
          <table class="cms-sync-comparison-table">
            <caption>{say(`Differenze per ${entity.label}`, `Differences for ${entity.label}`)}</caption>
            <thead><tr><th scope="col">{say("Campo", "Field")}</th><th scope="col">{say("Nel progetto", "In the project")}</th><th scope="col">{say("Sul sito", "On site")}</th></tr></thead>
            <tbody>{#each entity.comparison as field (field.field)}<tr><th scope="row">{field.field}</th><td><code>{field.local}</code></td><td><code>{field.remote}</code></td></tr>{/each}</tbody>
          </table>
        </div>
        {#if entity.omittedComparisonFields}<small>{say(`Altri ${entity.omittedComparisonFields} campi modificati non mostrati.`, `${entity.omittedComparisonFields} more changed fields are not shown.`)}</small>{/if}
      </details>
    {/if}
    {#if entity.status === "conflict" && cmsSyncPlan.action === "pull" && entity.canResolve}
      <label class="cms-sync-resolution"><span>{say("Versione da conservare", "Version to keep")}</span><select aria-label={say(`Versione da conservare per ${entity.label}`, `Version to keep for ${entity.label}`)} value={cmsSyncChoices[entity.id] ?? ""} onchange={(event) => setCmsSyncChoice(entity.id, (event.currentTarget as HTMLSelectElement).value)}><option value="">{say("Scegli…", "Choose…")}</option><option value="keep-local">{say("Tieni quella del progetto", "Keep the project’s")}</option><option value="use-remote">{say("Tieni quella del sito", "Keep the site’s")}</option></select></label>
    {/if}
  </div>
{/snippet}

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closeCmsSyncPlan(); }}>
  <div class="modal-card cms-sync-modal" role="dialog" aria-modal="true" use:modal={{ onClose: closeCmsSyncPlan, canClose: () => !busy }} aria-labelledby="cms-sync-title" tabindex="-1">
    <button class="modal-close" aria-label={t("common.close")} onclick={closeCmsSyncPlan}>×</button>
    <div class="modal-icon">⇄</div>
    <div class="eyebrow">{say("REVISIONE SINCRONIZZAZIONE", "SYNC REVIEW")}</div>
    <h2 id="cms-sync-title">{title}</h2>
    <p><strong>{cmsSyncPlan.project.name}</strong> · {cmsSyncPlan.profile} · {cmsSyncConnection ? new URL(cmsSyncConnection.url).hostname : ""}</p>
    {#if cmsSyncPlan.histeon}<HisteonVersionNotice {language} notice={cmsSyncPlan.histeon} />{/if}
    <div class="modal-warning"><span>i</span><div><strong>{say("Ripristino dopo l’invio", "Restore after transfer")}</strong><p>{cmsSyncPlan.rollback.note}</p></div></div>
    {#if cmsSyncPlan.bring}<p class="modal-note" data-testid="cms-sync-bring-note">{say(`Scarico solo ${cmsSyncPlan.bring.requested === 1 ? "il contenuto scelto" : `i ${cmsSyncPlan.bring.requested} contenuti scelti`}${cmsSyncPlan.bring.total > cmsSyncPlan.bring.requested ? ` e ${cmsSyncPlan.bring.total - cmsSyncPlan.bring.requested} che servono loro e il progetto non ha (media, componenti, template)` : ""}. Gli altri contenuti del sito non entrano nel progetto, e il sito non cambia.`, `Only the ${cmsSyncPlan.bring.requested} chosen item(s) are downloaded${cmsSyncPlan.bring.total > cmsSyncPlan.bring.requested ? `, with ${cmsSyncPlan.bring.total - cmsSyncPlan.bring.requested} they need that the project lacks` : ""}. The site's other content stays out of the project, and the site does not change.`)}</p>{/if}
    {#if cmsSyncPlan.initializingRemote}<div class="modal-warning"><span>i</span><div>{say("Questo WordPress non ha ancora un progetto Histeon collegato. Il primo invio creerà il progetto selezionato. Le pagine WordPress senza dati Histeon restano fuori dal trasferimento.", "This WordPress site has no linked Histeon project yet. The first send will create the selected project. WordPress pages without Histeon data stay outside the transfer.")}</div></div>{/if}
    <div class="cms-sync-counts">
      <div><strong>{cmsSyncPlan.counts.new}</strong><small>{say("Nuovi", "New")}</small></div>
      <div><strong>{cmsSyncPlan.counts.update}</strong><small>{say("Aggiornamenti", "Updates")}</small></div>
      <div><strong>{cmsSyncPlan.counts.delete}</strong><small>{say("Rimozioni", "Removals")}</small></div>
      <div><strong>{cmsSyncPlan.counts.unchanged}</strong><small>{say("Allineati", "Aligned")}</small></div>
      <div><strong>{cmsSyncPlan.counts.conflict}</strong><small>{say("Conflitti", "Conflicts")}</small></div>
    </div>
    {#if cmsSyncPlan.counts.delete > 0}<div class="modal-warning"><span>!</span><div>{say("Il piano rimuoverà le pagine indicate dalla copia locale solo dopo aver salvato una copia di recupero. Il sito remoto non viene modificato da un download.", "The plan will remove the listed pages from the local copy only after saving a recovery backup. A download does not modify the remote site.")}</div></div>{/if}
    {#if cmsSyncPlan.counts.conflict > 0}
      <div class="modal-warning"><span>!</span><div>{say("Ci sono modifiche concorrenti. Histeon ferma l’operazione finché non scegli quale versione conservare.", "Some changes overlap. Histeon stops until you choose which version to keep.")}{#if cmsSyncPlan.action === "pull"}<p>{say("«Tieni quella del progetto» conserva il contenuto sul computer: al prossimo invio va sul sito. «Tieni quella del sito» sostituisce il contenuto nel progetto; le revisioni precedenti restano nella cronologia. Non viene creata un’unione automatica. Puoi scegliere per un gruppo intero.", "“Keep the project’s” preserves the computer copy: the next send takes it to the site. “Keep the site’s” replaces the content in the project; earlier revisions remain in history. No automatic merge is created. You can choose for a whole group.")}</p>{:else}<p>{say("Risolvi i conflitti: scarico solo quelli, e per ciascuno, o per un gruppo, scegli quale versione tenere. Gli altri contenuti del sito non entrano nel progetto.", "Resolve the conflicts: only those are downloaded, and for each one, or for a group, you choose which version to keep. The site’s other content stays out of the project.")}</p>{/if}</div></div>
    {/if}
    {#if cmsSyncPlan.action === "publish"}<div class="modal-warning"><span>!</span>{say("Le pagine e i contenuti pubblicabili diventeranno visibili sul sito.", "Publishable pages and content will become visible on the site.")}</div>{/if}
    {#if cmsSyncPlan.counts["local-only"] || cmsSyncPlan.counts["remote-only"]}<p class="modal-note">{say("Le voci presenti da un solo lato non vengono cancellate dall’altro lato.", "Items present on only one side will not be deleted from the other side.")}</p>{/if}
    {#if cmsSyncPlan.action === "pull" && resolvable.length > 1}
      <div class="cms-sync-bulk" role="group" aria-label={say("Scelta per tutti i conflitti", "Choice for every conflict")}>
        <span>{say(`Tutti i ${resolvable.length} conflitti`, `All ${resolvable.length} conflicts`)} · {say(`scelti ${chosenCount}`, `${chosenCount} chosen`)}</span>
        <button type="button" class="button outline small" onclick={() => chooseAll(resolvable, "keep-local")}>{say("Tieni quella del progetto", "Keep the project’s")}</button>
        <button type="button" class="button outline small" onclick={() => chooseAll(resolvable, "use-remote")}>{say("Tieni quella del sito", "Keep the site’s")}</button>
      </div>
    {/if}
    {#if onSite.length}
      <div class="cms-sync-bulk" role="group" aria-label={say("Contenuti solo sul sito", "Content only on the site")}>
        <span>{say(`${cmsSyncPlan.counts["remote-only"]} solo sul sito: l’invio non li tocca. Scegli quelli che servono al progetto.`, `${cmsSyncPlan.counts["remote-only"]} only on the site: the send leaves them alone. Choose the ones the project needs.`)}</span>
        <button type="button" class="button outline small" data-testid="cms-sync-bring" disabled={busy || !selected.length || !cmsSyncConnection?.read} onclick={() => { const connection = cmsSyncConnection; if (connection) void act(() => bringCmsEntities(connection, [...selected])); }}>{say(`Porta nel progetto (${selected.length})`, `Bring into the project (${selected.length})`)} →</button>
      </div>
    {/if}
    <div class="cms-sync-entity-list" aria-label={say("Dettaglio delle modifiche", "Change details")}>
      {#if conflicts.length}
        {#each conflictGroups as group (group.kind)}
          {@const groupName = kindName(language, group.kind, true)}
          <section class="cms-sync-group" aria-label={say(`Conflitti: ${groupName}`, `Conflicts: ${groupName}`)} data-testid="cms-sync-conflict-group">
            <div class="cms-sync-group-head">
              <strong>{groupName} <small>({group.items.length})</small></strong>
              {#if cmsSyncPlan.action === "pull" && group.items.some((entity) => entity.canResolve)}
                <button type="button" class="button text small" aria-label={say(`Tieni quella del progetto per ${groupName}`, `Keep the project’s for ${groupName}`)} onclick={() => chooseAll(group.items, "keep-local")}>{say("Tieni quella del progetto", "Keep the project’s")}</button>
                <button type="button" class="button text small" aria-label={say(`Tieni quella del sito per ${groupName}`, `Keep the site’s for ${groupName}`)} onclick={() => chooseAll(group.items, "use-remote")}>{say("Tieni quella del sito", "Keep the site’s")}</button>
              {/if}
            </div>
            {#each group.items as entity (entity.id)}{@render entityRow(entity)}{/each}
          </section>
        {/each}
      {/if}
      {#if onSite.length}
        {#each onSiteGroups as group (group.kind)}
          {@const groupName = kindName(language, group.kind, true)}
          {@const choosable = group.items.filter(bringable)}
          <section class="cms-sync-group" aria-label={say(`Solo sul sito: ${groupName}`, `Only on the site: ${groupName}`)} data-testid="cms-sync-onsite-group">
            <div class="cms-sync-group-head">
              <strong>{say("Solo sul sito", "Only on the site")} · {groupName} <small>({group.items.length})</small></strong>
              {#if choosable.length > 1}<button type="button" class="button text small" aria-label={say(`Scegli tutti: ${groupName}`, `Choose all: ${groupName}`)} onclick={() => { for (const entity of choosable) toggle(entity.id, true); }}>{say("Scegli tutti", "Choose all")}</button>{/if}
            </div>
            {#each group.items as entity (entity.id)}
              <label class="cms-sync-entity cms-sync-pick">
                <input type="checkbox" checked={selected.includes(entity.id)} disabled={!bringable(entity)} onchange={(event) => toggle(entity.id, (event.currentTarget as HTMLInputElement).checked)} />
                <span class="cms-sync-entity-info"><strong>{entity.label}</strong><small>{kindName(language, kindOf(entity))}{entity.onSite === "changed-on-site" ? say(" · cambiato sul sito dopo l’ultimo invio", " · changed on the site after the last send") : ""}{bringable(entity) ? "" : say(" · arriva solo con «Scarica aggiornamenti»", " · comes only with “Download updates”")}</small></span>
              </label>
            {/each}
          </section>
        {/each}
      {/if}
      {#each others as entity (entity.id)}{@render entityRow(entity)}{/each}
      {#if cmsSyncPlan.omittedEntities > 0}<p class="modal-note">{say(`Altre ${cmsSyncPlan.omittedEntities} voci non mostrate.`, `${cmsSyncPlan.omittedEntities} more items are not shown.`)}</p>{/if}
      {#if cmsSyncPlan.leftOut?.length}
        <details class="modal-note">
          <summary>{say(`${cmsSyncPlan.leftOut.length} contenuti del sito restano fuori: non si possono trasportare. Sul sito non cambiano.`, `${cmsSyncPlan.leftOut.length} items of the site stay out: they cannot be transferred. They don't change on the site.`)}</summary>
          <ul>{#each cmsSyncPlan.leftOut as item, index (index)}<li><strong>{item.title}</strong><br /><small>{item.reason}</small></li>{/each}</ul>
        </details>
      {/if}
      {#if !cmsSyncPlan.entities.length}<p class="empty-note">{say("Nessuna modifica rilevata.", "No changes found.")}</p>{/if}
    </div>
    <p class="modal-note">{cmsSyncPlan.expiresAt ? say("Il piano vale per 10 minuti. Histeon ricontrollerà le versioni prima di applicarlo.", "This plan is valid for 10 minutes. Histeon checks the versions again before applying it.") : say("Rivedi le voci in conflitto. Nessun dato è stato modificato.", "Review the conflicting items. No data was changed.")}</p>
    <div class="modal-actions">
      <button class="button outline" onclick={closeCmsSyncPlan}>{t("common.cancel")}</button>
      {#if sending && cmsSyncPlan.counts.conflict > 0 && cmsSyncConnection}<button class="button outline" disabled={busy || !cmsSyncConnection.read} onclick={() => { const connection = cmsSyncConnection!; closeCmsSyncPlan(); void act(() => pullCmsSite(connection)); }}>{say("Rivedi download", "Review download")} →</button>{/if}
      {#if sending && resolvable.length > 0 && cmsSyncConnection}<button class="button primary" disabled={busy || !cmsSyncConnection.read} onclick={() => { const connection = cmsSyncConnection!; void act(() => bringCmsEntities(connection, resolvable.slice(0, MAX_RESOLVED).map((entity) => entity.id))); }}>{resolvable.length > MAX_RESOLVED ? say(`Risolvi i primi ${MAX_RESOLVED} conflitti`, `Resolve the first ${MAX_RESOLVED} conflicts`) : say("Risolvi i conflitti", "Resolve the conflicts")} →</button>{/if}
      <button class="button primary" disabled={busy || !cmsSyncPlanReady()} onclick={() => void act(applyCmsSyncPlan)}>{cmsSyncPlan.action === "pull" && cmsSyncPlan.counts.conflict ? say("Applica le scelte e scarica", "Apply choices and download") : cmsSyncPlan.action === "pull" && cmsSyncPlan.bring ? say("Porta nel progetto", "Bring into the project") : cmsSyncPlan.action === "pull" ? say("Applica download", "Apply download") : cmsSyncPlan.action === "publish" ? say("Conferma pubblicazione", "Confirm publish") : say("Conferma invio", "Confirm send")} →</button>
    </div>
  </div>
</div>

<style>
  .cms-sync-bulk { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 10px; color: var(--ink-2); font-size: 13px; }
  .cms-sync-bulk > span { flex: 1 1 260px; }
  .cms-sync-group { border-bottom: 1px solid var(--line); }
  .cms-sync-group-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--panel-soft); }
  .cms-sync-group-head strong { flex: 1 1 auto; font-size: 13px; }
  .cms-sync-group-head small { color: var(--muted); font-weight: 400; }
  .cms-sync-pick { justify-content: flex-start; cursor: pointer; }
  .cms-sync-pick input { width: 18px; min-height: 18px; flex: 0 0 auto; margin: 0; accent-color: var(--coral); }
</style>
