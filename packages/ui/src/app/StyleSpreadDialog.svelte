<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsProject } from "../lib/app-types.js";

  /** One site's look brought to the other sites of a folder: first what would change, then the change. */
  let { language, act, applySpread, busy, cmsProjects, previewSpread, spread = $bindable(), onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    applySpread: () => Promise<void>;
    busy: boolean;
    cmsProjects: CmsProject[];
    previewSpread: () => Promise<void>;
    spread: { from: string; ids: string[]; results: Array<{ id: string; name: string; changes: string[]; applied: boolean }> | null };
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const changing = $derived(spread.results?.filter((entry) => entry.changes.length) ?? []);
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal-card first-site" role="dialog" aria-modal="true" aria-labelledby="spread-title" tabindex="-1" data-testid="spread-dialog" use:modal={{ onClose: () => onclose(), canClose: () => !busy }}>
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <h2 id="spread-title">{t("spread.title")}</h2>
    <p class="muted">{t("spread.hint")}</p>
    <label class="field-label">{t("spread.from")}
      <select bind:value={spread.from} onchange={() => { spread.results = null; }} data-testid="spread-from">
        <option value="">{t("spread.choose")}</option>
        {#each cmsProjects.filter((project) => spread.ids.includes(project.id)) as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
      </select>
    </label>
    {#if spread.results}
      {#if changing.length}
        <ul class="spread-list" data-testid="spread-results">{#each changing as entry (entry.id)}<li><strong>{entry.name}</strong> <span class="muted">{t("spread.changes", { n: entry.changes.length })}</span></li>{/each}</ul>
        <p class="muted">{t("spread.backup")}</p>
      {:else}<p>{t("spread.same")}</p>{/if}
    {/if}
    <div class="modal-actions">
      <button class="button outline" disabled={busy || !spread.from} onclick={() => void act(previewSpread)} data-testid="spread-preview">{t("spread.preview")}</button>
      <button class="button primary" disabled={busy || !changing.length} onclick={() => void act(applySpread)} data-testid="spread-apply">{t("spread.apply", { n: changing.length })}</button>
    </div>
  </div>
</div>
