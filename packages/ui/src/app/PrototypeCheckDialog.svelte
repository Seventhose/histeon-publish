<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { plural, translate, type Language } from "../lib/i18n.js";
  import type { ConversionOptions, ImportFramework, PrototypeChangeView, PrototypeChangesView, PrototypeCheckView, SiteConversionView, SiteStructureChoice } from "../lib/app-types.js";

  /** A prototype checked before its import, with what a site conversion said (queue A2, B1–B5). */
  let { language, act, busy, changeKindLabel, cmsImportOpener, cmsStructureChoice = $bindable(), conversionReportBody, convertSiteToCms, importCheckedPrototype, prototypeCounts, saveJsonFile, checked, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    changeKindLabel: (kind: string) => string;
    cmsImportOpener: HTMLElement | null;
    cmsStructureChoice: SiteStructureChoice;
    conversionReportBody: (file: File, conversion: SiteConversionView) => { file: string; framework: ImportFramework; notes: string[]; selectable?: { original: number; selectable: number; share: number }; structure: SiteStructureChoice };
    convertSiteToCms: (siteId?: string, options?: ConversionOptions) => Promise<void>;
    importCheckedPrototype: () => Promise<void>;
    prototypeCounts: (counts: Record<string, number>) => string;
    saveJsonFile: (name: string, value: unknown) => void;
    checked: { file: File; result: PrototypeCheckView; conversion?: SiteConversionView & { downloadUrl: string } };
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const n = (key: string, count: number, values: Record<string, string | number> = {}) => plural(language, key, count, values);
  const result = $derived(checked.result);
  const name = $derived(result.existingProject?.name ?? result.report.project.name);
  const placeholders = $derived(result.report.placeholders?.length ?? 0);

  const IMPORT_FRAMEWORKS: readonly ImportFramework[] = ["histos-css", "acss", "core", "none"];
  /** Every change of a check in one list, with its status, for "Cosa cambia". */
  function prototypeChangeList(changes: PrototypeChangesView): Array<PrototypeChangeView & { status: "conflicts" | "added" | "modified" | "removed" | "keptLocal" }> {
    return (["conflicts", "added", "modified", "removed", "keptLocal"] as const).flatMap((status) => changes[status].map((item) => ({ ...item, status })));
  }
  const say = (italian: string, english: string) => (language === "it" ? italian : english);

  /** A new conversion keeps what the dialog already chose: options, the names applied and the model's table. */
  function again(change: Partial<ConversionOptions>): Promise<void> {
    const conversion = checked.conversion;
    if (!conversion) return Promise.resolve();
    return convertSiteToCms(conversion.siteId, { fonts: conversion.fontsRequested, framework: conversion.framework, exact: conversion.exactChoice === "choice" && conversion.exact, recipes: conversion.recipes, structure: conversion.structureApplied, choices: conversion.choicesApplied, refineView: conversion.refine, ...change });
  }

  // Doc 27, G3: the rows of the model's table the person keeps (all at first, but those already applied stay as they
  // are), and the alternative texts accepted one by one (none at first: the model does not see the images).
  let picked = $state<Record<string, boolean>>({});
  let altPicked = $state<Record<string, boolean>>({});
  $effect(() => {
    const conversion = checked.conversion;
    const refine = conversion?.refine;
    // Once some rows are applied, the boxes say which; before, every row is proposed.
    const applied = (refine?.rows ?? []).some((row) => conversion?.choicesApplied[row.id] === row.after);
    picked = Object.fromEntries((refine?.rows ?? []).map((row) => [row.id, applied ? conversion?.choicesApplied[row.id] === row.after : true]));
    altPicked = Object.fromEntries((refine?.suggestions ?? []).map((row) => [row.id, conversion?.choicesApplied[row.id] === row.after]));
  });
  const KIND_LABELS: Record<string, [string, string]> = { classe: ["classe", "class"], componente: ["componente", "component"], prop: ["campo", "field"], tipo: ["tipo di contenuto", "content type"], alt: ["testo alternativo", "alternative text"] };
  const kindLabel = (kind: string): string => say(...(KIND_LABELS[kind] ?? [kind, kind]));
  /** The answers to apply: the earlier ones, then the rows chosen now (a row not kept goes back to the converter's). */
  function chosenAnswers(all: boolean): Record<string, string> {
    const conversion = checked.conversion;
    const refine = conversion?.refine;
    if (!conversion || !refine) return {};
    const answers = { ...conversion.choicesApplied };
    for (const row of refine.rows) {
      if (all || picked[row.id]) answers[row.id] = row.after;
      else if (answers[row.id] === row.after) delete answers[row.id];
    }
    for (const row of refine.suggestions) {
      if (altPicked[row.id]) answers[row.id] = row.after;
      else if (answers[row.id] === row.after) delete answers[row.id];
    }
    return answers;
  }
  const failedBatches = $derived((checked.conversion?.refine?.batches ?? []).filter((batch) => !batch.ok));
  const appliedCount = $derived(Object.keys(checked.conversion?.choicesApplied ?? {}).length);

  /** A design proposal value shown in the dialog: a color as a swatch only when it really is #rrggbb. */
  function designSwatch(value: string): string | null {
    return /^#[0-9a-f]{6}$/iu.test(value) ? value : null;
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card cms-prototype-check" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy, returnFocus: cmsImportOpener }} aria-labelledby="cms-prototype-check-title" tabindex="-1" data-testid="cms-prototype-check" data-outcome={result.outcome}>
    <button class="modal-close" aria-label={t("common.close")} onclick={() => { if (!busy) onclose(); }}>×</button>
    <div class="eyebrow">{t("cms.checkEyebrow")}</div>
    <h2 id="cms-prototype-check-title">{result.outcome === "update" ? t("cms.importUpdateTitle", { name }) : result.outcome === "refused-duplicate" ? t("cms.checkDuplicateTitle") : t("cms.checkCreateTitle", { name })}</h2>
    <p class="cms-check-file">{checked.file.name}</p>
    <p>{t("cms.checkContains", { counts: prototypeCounts(result.report.counts) || t("cms.checkEmpty") })}</p>
    {#if result.preview?.status === "ready"}
      <div class="cms-check-preview">
        <a class="button outline" data-testid="cms-prototype-preview" href={result.preview.previewUrl} target="_blank" rel="noreferrer">{t("cms.openPreview")}</a>
        <small>{t("cms.checkPreviewNote")}{placeholders > 0 ? ` ${t("cms.checkPlaceholders", { n: placeholders })}` : ""}</small>
      </div>
    {:else if result.preview}
      <p class="cms-check-note">{t("cms.checkPreviewUnavailable")} {result.preview.reason}</p>
    {/if}
    {#if result.report.images}<p class="cms-check-note" data-testid="cms-prototype-images">{result.report.images.note}</p>{/if}
    {#if checked.conversion}
      {#if checked.conversion.selectable}<p class="cms-check-note" data-testid="cms-conversion-selectable">{t("cms.conversionSelectable", { share: Math.round(checked.conversion.selectable.share * 100), selectable: checked.conversion.selectable.selectable, original: checked.conversion.selectable.original })}</p>{/if}
      <details class="cms-check-list" data-testid="cms-conversion-notes" open={checked.conversion.notes.length <= 6}>
        <summary>{t("cms.conversionNotes", { n: checked.conversion.notes.length })}</summary>
        {#if checked.conversion.groups?.length}
          <!-- Doc 23 item 163: one report, by what happened. -->
          {#each checked.conversion.groups as group (group.kind)}
            <h4 class="cms-check-group" data-kind={group.kind}>{t(`cms.conversionGroup.${group.kind}`, { n: group.items.length })}</h4>
            <ul>{#each group.items as note, index (index)}<li>{note}</li>{/each}</ul>
          {/each}
        {:else if checked.conversion.notes.length}<ul>{#each checked.conversion.notes as note, index (index)}<li>{note}</li>{/each}</ul>{:else}<p class="muted">{t("cms.conversionClean")}</p>{/if}
      </details>
      {#if checked.conversion.googleFonts > 0 && !checked.conversion.fontsRequested}
        <div class="cms-check-fonts"><p>{t("cms.conversionFonts")}</p><button class="button outline small" type="button" data-testid="cms-conversion-fonts" disabled={busy} onclick={() => void act(() => again({ fonts: true }))}>{t("cms.conversionFontsAction")}</button></div>
      {/if}
      {#if checked.conversion.siteId}
        {@const current = checked.conversion.framework}
        <!-- Doc 18 §6.4.1: the framework of arrival, Histeon CSS preselected; a change converts again. -->
        <label class="cms-check-framework" data-testid="cms-conversion-framework">{t("cms.conversionFramework")}
          <select value={current} disabled={busy} onchange={(event) => { const framework = (event.currentTarget as HTMLSelectElement).value as ImportFramework; if (IMPORT_FRAMEWORKS.includes(framework) && framework !== current) void act(() => again({ framework })); }}>
            {#each IMPORT_FRAMEWORKS as framework (framework)}<option value={framework}>{t(`cms.conversionFramework.${framework}`)}</option>{/each}
          </select>
        </label>
        <p class="field-hint">{t(`cms.conversionFrameworkHint.${current}`)}</p>
        {#if checked.conversion.exactChoice !== "none"}
          {@const exact = checked.conversion.exact}
          {@const always = checked.conversion.exactChoice === "always"}
          <!-- Doc 28: the sizes written by hand kept exact, as the site's variables. Off at first; a captured proposal
               has them always (the server decides, the box only says so); a change converts again. -->
          <label class="cms-check-recipes" data-testid="cms-conversion-exact"><input type="checkbox" checked={exact} disabled={busy || always} onchange={(event) => { const wanted = (event.currentTarget as HTMLInputElement).checked; if (!always && wanted !== exact) void act(() => again({ exact: wanted })); }} /> {t("cms.conversionExact")}</label>
          <p class="field-hint">{t(always ? "cms.conversionExactHint.always" : "cms.conversionExactHint")}</p>
        {/if}
        {#if checked.conversion.recipesAvailable}
          {@const recipes = checked.conversion.recipes}
          <!-- Doc 18 §6.6: the recipes without JavaScript, proposed in the notes, applied on request; a change converts again. -->
          <label class="cms-check-recipes" data-testid="cms-conversion-recipes"><input type="checkbox" checked={recipes} disabled={busy} onchange={(event) => { const wanted = (event.currentTarget as HTMLInputElement).checked; if (wanted !== recipes) void act(() => again({ recipes: wanted })); }} /> {t("cms.conversionRecipes")}</label>
          <p class="field-hint">{t("cms.conversionRecipesHint")}</p>
        {/if}
      {/if}
      {#if Object.keys(checked.conversion.design).length}
        {@const tokens = checked.conversion.tokensRequested}
        <div class="cms-check-design" data-testid="cms-conversion-design">
          <p>{tokens && checked.conversion.framework !== "core" ? t(checked.conversion.framework === "acss" ? "cms.conversionAcssOn" : "cms.conversionTokensOn") : t("cms.conversionDesign")}</p>
          <dl>
            {#each Object.entries(checked.conversion.design) as [key, value] (key)}
              <div><dt>{t(`cms.design.${key}`)}</dt><dd>{#if designSwatch(value)}<span class="design-swatch" style:background={designSwatch(value)} aria-hidden="true"></span>{/if}<code>{value}</code></dd></div>
            {/each}
          </dl>
          <p class="field-hint">{t("cms.conversionDesignHint")}</p>
        </div>
      {/if}
      {#if checked.conversion.structure.parts.length || checked.conversion.structure.components.length}
        {@const proposal = checked.conversion.structure}
        {@const applied = checked.conversion.structureApplied}
        <fieldset class="cms-check-structure" data-testid="cms-conversion-structure">
          <legend>{t("cms.structureTitle")}</legend>
          <p class="field-hint">{t("cms.structureIntro")}</p>
          {#if proposal.parts.length}<label><input type="checkbox" bind:checked={cmsStructureChoice.parts} disabled={busy} /> {t("cms.structureParts", { areas: proposal.parts.map((area) => t(`cms.structureArea.${area}`)).join(" e ") })}</label>{/if}
          {#if proposal.components.length}<label><input type="checkbox" bind:checked={cmsStructureChoice.components} disabled={busy} onchange={() => { if (!cmsStructureChoice.components) cmsStructureChoice.lists = false; }} /> {n("cms.structureComponents", proposal.components.length, { names: proposal.components.map((item) => `${item.ref} (${item.uses})`).join(", ") })}</label>{/if}
          {#if proposal.lists.length}<label><input type="checkbox" bind:checked={cmsStructureChoice.lists} disabled={busy || !cmsStructureChoice.components} /> {n("cms.structureLists", proposal.lists.length, { records: proposal.lists.reduce((total, item) => total + item.records, 0) })}</label>{/if}
          <button class="button outline small" type="button" data-testid="cms-conversion-structure-apply" disabled={busy || (cmsStructureChoice.parts === applied.parts && cmsStructureChoice.components === applied.components && cmsStructureChoice.lists === applied.lists)} onclick={() => void act(() => again({ structure: { ...cmsStructureChoice } }))}>{t("cms.structureApply")}</button>
        </fieldset>
      {/if}
      {#if checked.conversion.siteId && (checked.conversion.choices > 0 || appliedCount > 0)}
        {@const conversion = checked.conversion}
        {@const refine = conversion.refine}
        <!-- Doc 27, G3: a model proposes clearer names; the prototype changes only with the ones applied here. -->
        <fieldset class="cms-check-refine" data-testid="cms-conversion-refine">
          <legend>{say("Nomi più chiari", "Clearer names")}</legend>
          <label><input type="checkbox" data-testid="cms-conversion-refine-toggle" checked={refine !== undefined} disabled={busy} onchange={(event) => { const wanted = (event.currentTarget as HTMLInputElement).checked; void act(() => (wanted ? again({ refine: true, refineView: undefined }) : again({ choices: {}, refineView: undefined }))); }} /> {say("Rifinisci i nomi con un modello", "Refine the names with a model")}</label>
          <p class="field-hint">{say(`Il convertitore ha dato ${conversion.choices} nomi prudenti ma generici. Un modello propone nomi più chiari; il prototipo cambia solo con quelli che applichi. Il modello si sceglie in Agente AI.`, `The converter gave ${conversion.choices} prudent but generic names. A model proposes clearer ones; the prototype changes only with the ones you apply. The model is chosen in AI agent.`)}</p>
          {#if refine}
            <p class="cms-check-note" data-testid="cms-refine-summary">{say(`Proposte di ${refine.model} (${refine.provider === "haiku" ? "Claude API" : refine.provider === "connettore" ? "il tuo abbonamento" : "modello locale"}) in ${Math.max(1, Math.round(refine.ms / 1000))} s: ${refine.rows.length} nomi, ${refine.suggestions.length} testi alternativi.`, `Proposals by ${refine.model} (${refine.provider === "haiku" ? "Claude API" : refine.provider === "connettore" ? "your plan" : "local model"}) in ${Math.max(1, Math.round(refine.ms / 1000))} s: ${refine.rows.length} names, ${refine.suggestions.length} alternative texts.`)}</p>
            {#if failedBatches.length}<div class="modal-warning" role="note" data-testid="cms-refine-failed"><span>!</span>{say(`${failedBatches.length} lotti su ${refine.batches.length} senza risposta (${failedBatches[0]?.error ?? "errore"}): quei nomi restano quelli di oggi.`, `${failedBatches.length} of ${refine.batches.length} batches without an answer (${failedBatches[0]?.error ?? "error"}): those names stay as they are.`)}</div>{/if}
            {#if refine.skipped > 0}<p class="field-hint">{say(`${refine.skipped} scelte oltre le prime ${refine.asked} restano coi nomi di oggi.`, `${refine.skipped} choices past the first ${refine.asked} keep today’s names.`)}</p>{/if}
            {#if refine.rows.length}
              <div class="cms-refine-scroll">
                <table class="cms-refine-table" data-testid="cms-refine-table">
                  <thead><tr><th scope="col"><span class="visually-hidden">{say("Applica", "Apply")}</span></th><th scope="col">{say("Prima", "Before")}</th><th scope="col">{say("Dopo", "After")}</th><th scope="col">{say("Dove", "Where")}</th></tr></thead>
                  <tbody>
                    {#each refine.rows as row (row.id)}
                      <tr data-applied={conversion.choicesApplied[row.id] === row.after}>
                        <td><input type="checkbox" bind:checked={picked[row.id]} disabled={busy} aria-label={say(`Applica ${row.after} al posto di ${row.before}`, `Apply ${row.after} instead of ${row.before}`)} /></td>
                        <td><code>{row.before}</code> <small class="muted">{kindLabel(row.kind)}</small></td>
                        <td><code>{row.after}</code>{#if conversion.choicesApplied[row.id] === row.after}<small class="muted">{say("applicato", "applied")}</small>{/if}</td>
                        <td><small>{row.context}</small></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}<p class="muted">{say("Il modello non ha proposto nomi diversi da quelli di oggi.", "The model proposed no names other than today’s.")}</p>{/if}
            {#if refine.suggestions.length}
              <h4 class="cms-check-group">{say("Testi alternativi suggeriti", "Suggested alternative texts")}</h4>
              <p class="field-hint">{say("Il modello non vede le immagini: accetta un testo solo se descrive davvero l’immagine (guardala nell’anteprima).", "The model does not see the images: accept a text only if it really describes the image (look at it in the preview).")}</p>
              <ul class="cms-refine-alts" data-testid="cms-refine-alts">
                {#each refine.suggestions as row (row.id)}<li><label><input type="checkbox" bind:checked={altPicked[row.id]} disabled={busy} /> {say("Accetta", "Accept")} «{row.after}»</label> <small class="muted">{row.context}</small></li>{/each}
              </ul>
            {/if}
            {#if refine.rejected.length}
              <details class="cms-check-list"><summary>{say(`${refine.rejected.length} risposte del modello lasciate fuori`, `${refine.rejected.length} model answers left out`)}</summary>
                <ul>{#each refine.rejected as item, index (index)}<li><code>{item.id}</code>{#if item.after} → <code>{item.after}</code>{/if}: {item.motivo}</li>{/each}</ul>
              </details>
            {/if}
            {#if refine.rows.length || refine.suggestions.length}
              <div class="form-actions">
                <button class="button outline small" type="button" data-testid="cms-refine-apply-all" disabled={busy || !refine.rows.length} onclick={() => void act(() => again({ choices: chosenAnswers(true) }))}>{say("Applica tutte", "Apply all")}</button>
                <button class="button dark small" type="button" data-testid="cms-refine-apply" disabled={busy} onclick={() => void act(() => again({ choices: chosenAnswers(false) }))}>{say("Applica le scelte segnate", "Apply the checked choices")}</button>
              </div>
            {/if}
          {/if}
          {#if appliedCount > 0}<p class="cms-check-note" data-testid="cms-refine-applied">{say(`${appliedCount} ${appliedCount === 1 ? "nome scelto è" : "nomi scelti sono"} nel prototipo.`, `${appliedCount} chosen ${appliedCount === 1 ? "name is" : "names are"} in the prototype.`)} <button class="button text small" type="button" disabled={busy} onclick={() => void act(() => again({ choices: {} }))}>{say("Torna ai nomi del convertitore", "Back to the converter’s names")}</button></p>{/if}
          {#if conversion.choicesRejected.length}
            <details class="cms-check-list" open data-testid="cms-refine-not-applied"><summary>{say(`${conversion.choicesRejected.length} scelte non applicate`, `${conversion.choicesRejected.length} choices not applied`)}</summary>
              <ul>{#each conversion.choicesRejected as item, index (index)}<li><code>{item.id}</code>: {item.motivo}</li>{/each}</ul>
            </details>
          {/if}
        </fieldset>
      {/if}
      <p class="cms-check-note"><a href={checked.conversion.downloadUrl} download={checked.file.name}>{t("cms.conversionDownload")}</a> {t("cms.conversionDownloadHint")}</p>
      {@const conversionNow = checked.conversion}
      <p class="cms-check-note"><button class="button outline small" type="button" data-testid="cms-conversion-report-download" onclick={() => saveJsonFile(checked.file.name.replace(/\.html?$/iu, "") + "-rapporto.json", { format: "histos-conversion-report", version: 1, ...conversionReportBody(checked.file, conversionNow), check: checked.result })}>{t("cms.conversionReportDownload")}</button></p>
    {/if}
    {#if result.report.ignored.length > 0}
      <details class="cms-check-list">
        <summary>{t("cms.checkIgnored", { n: result.report.ignored.length })}</summary>
        <ul>{#each result.report.ignored as item, index (index)}<li><strong>{item.what}</strong>{#if item.line}{" "}<span class="muted">({t("cms.problemsLine", { line: item.line })})</span>{/if} — {item.why}</li>{/each}</ul>
      </details>
    {/if}
    {#if result.report.warnings.length > 0}
      <!-- Open as well when the preview points to them: a bundle that publishing would stop. -->
      <details class="cms-check-list" data-testid="cms-prototype-warnings" open={result.report.warnings.length <= 3 || (result.preview?.status === "unavailable" && (result.preview.findings ?? 0) > 0)}>
        <summary>{t("cms.checkWarnings", { n: result.report.warnings.length })}</summary>
        <ul>{#each result.report.warnings as warning, index (index)}<li>{warning}</li>{/each}</ul>
      </details>
    {/if}
    {#if result.changes}
      {@const changes = result.changes}
      {@const list = prototypeChangeList(changes)}
      <div class="cms-check-changes" data-testid="cms-prototype-changes">
        <strong>{t("cms.changesTitle")}</strong>
        {#if list.length === 0}
          <p>{t("cms.changesNone")}</p>
        {:else}
          <ul class="cms-check-change-counts">
            {#each (["added", "modified", "removed", "keptLocal"] as const) as status (status)}{#if changes[status].length > 0}<li data-status={status}>{t(`cms.changes.${status}`, { n: changes[status].length })}</li>{/if}{/each}
            {#if changes.unchanged > 0}<li data-status="unchanged">{t("cms.changes.unchanged", { n: changes.unchanged })}</li>{/if}
          </ul>
          {#if changes.conflicts.length > 0}<div class="modal-warning" role="note"><span>!</span>{t("cms.changesConflicts", { n: changes.conflicts.length, names: changes.conflicts.slice(0, 5).map((item) => `«${item.label || changeKindLabel(item.kind)}»`).join(", ") })}</div>{/if}
          <details class="cms-check-list" open={list.length <= 8}>
            <summary>{t("cms.changesDetails", { n: list.length + changes.omitted })}</summary>
            <ul>{#each list as item (`${item.status}:${item.id}`)}<li data-status={item.status}><span class="cms-change-status">{t(`cms.changeStatus.${item.status}`)}</span> {item.label || changeKindLabel(item.kind)} <small>{changeKindLabel(item.kind)}</small></li>{/each}</ul>
            {#if changes.omitted > 0}<small class="muted">{t("cms.reportMore", { n: changes.omitted })}</small>{/if}
          </details>
        {/if}
      </div>
    {/if}
    {#if result.outcome === "update" && result.backupUnavailable}<div class="modal-warning" data-testid="cms-prototype-no-backup"><span>!</span>{t("cms.importUpdateNoBackup", { reason: result.backupUnavailable })}</div>
    {:else if result.outcome === "update" && !(result.changes?.conflicts.length)}<div class="modal-warning"><span>!</span>{t("cms.importUpdateBackup")}</div>{/if}
    {#if result.outcome === "refused-duplicate"}<div class="modal-warning"><span>!</span>{t("cms.checkDuplicateBody")}</div>{/if}
    <div class="modal-actions">
      <button class="button outline" disabled={busy} onclick={() => { if (!busy) onclose(); }}>{result.outcome === "refused-duplicate" ? t("common.close") : t("common.cancel")}</button>
      {#if result.outcome !== "refused-duplicate" && !(result.changes?.conflicts.length) && !(result.outcome === "update" && result.backupUnavailable)}<button class="button dark" data-testid="cms-prototype-import" disabled={busy} onclick={() => void act(importCheckedPrototype)}>{busy ? t("common.loading") : result.outcome === "update" ? t("cms.importUpdateConfirm") : t("cms.checkImport")} →</button>{/if}
    </div>
  </div>
</div>
