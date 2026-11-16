<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsProjectDetails, CmsTemplate } from "../lib/app-types.js";

  /** The project's templates, template parts and components, with the selection for the Cestino. */
  let { language, act, busy, cmsSelecting = $bindable(), cmsTemplatePartRef = $bindable(), cmsTemplatePartTitle = $bindable(), cmsTemplateRef = $bindable(), cmsTemplateTitle = $bindable(), cmsTrashSelection = $bindable(), createCmsTemplate, createCmsTemplatePart, launchCmsEditor, selectedCmsProject, setCmsTemplateRole, showCmsTrashConfirm = $bindable(), toggleCmsTrashSelection }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    cmsSelecting: boolean;
    cmsTemplatePartRef: string;
    cmsTemplatePartTitle: string;
    cmsTemplateRef: string;
    cmsTemplateTitle: string;
    cmsTrashSelection: string[];
    createCmsTemplate: () => Promise<void>;
    createCmsTemplatePart: () => Promise<void>;
    launchCmsEditor: (page: { alias: number }, back?: string) => void;
    selectedCmsProject: CmsProjectDetails | null;
    setCmsTemplateRole: (template: CmsTemplate, role: string) => Promise<void>;
    showCmsTrashConfirm: boolean;
    toggleCmsTrashSelection: (id: string, checked: boolean) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);

  const CMS_TEMPLATE_ROLES = ["front-page", "home", "index", "single", "page", "archive", "category", "tag", "search", "404"] as const;
</script>

{#if selectedCmsProject}
  <div class="admin-actions cms-select-row">
    <button class="button outline small" type="button" aria-pressed={cmsSelecting} onclick={() => { cmsSelecting = !cmsSelecting; if (!cmsSelecting) cmsTrashSelection = []; }}>{t("cms.select")}</button>
    {#if cmsSelecting && cmsTrashSelection.length}
      <span class="muted">{t("cms.trashSelected", { count: cmsTrashSelection.length })}</span>
      <button class="button dark small" disabled={busy} onclick={() => { showCmsTrashConfirm = true; }}>{t("cms.trashPrepare")}</button>
    {/if}
  </div>
  <section class="panel-card cms-settings-panel">
    <div class="panel-head"><span class="step-number" aria-hidden="true">▦</span><div><h2>{t("cms.templates")}</h2><p>{t("cms.templatesHint")}</p></div></div>
    {#if selectedCmsProject.templates.length}
      <div class="site-grid">
        {#each selectedCmsProject.templates as template (template.id)}
          <article class="site-card">
            <div class="site-card-top"><span class="site-icon">▱</span><span class="status-chip" class:ready={template.hasDefaultSlot}>{template.hasDefaultSlot ? t("cms.templateReady") : t("cms.templateMissingSlot")}</span></div>
            {#if cmsSelecting}<label class="cms-trash-select"><input type="checkbox" aria-label={t("cms.selectForTrashLabel", { label: template.title })} checked={cmsTrashSelection.includes(template.id)} onchange={(event) => toggleCmsTrashSelection(template.id, (event.currentTarget as HTMLInputElement).checked)} /> {t("cms.selectForTrash")}</label>{/if}
            <button class="site-title" onclick={() => launchCmsEditor(template)}>{template.title}<span aria-hidden="true">↗</span></button>
            <p class="muted">{template.ref}</p>
            <label class="field-label">{t("cms.templateRole")}
              <select value={template.role ?? ""} disabled={busy} onchange={(event) => void act(() => setCmsTemplateRole(template, (event.currentTarget as HTMLSelectElement).value))}>
                <option value="">{t("cms.noRole")}</option>
                {#each CMS_TEMPLATE_ROLES as role (role)}<option value={role} disabled={selectedCmsProject.templates.some((other) => other.id !== template.id && other.role === role)}>{t(`cms.role.${role}`)}</option>{/each}
              </select>
            </label>
            <div class="site-card-actions"><button class="button primary small" aria-label={t("cms.builderFor", { label: template.title })} onclick={() => launchCmsEditor(template)}>{t("cms.builder")}</button></div>
          </article>
        {/each}
      </div>
    {:else}<p class="muted">{t("cms.noTemplates")}</p>{/if}
    <form class="input-action" onsubmit={(event) => { event.preventDefault(); void act(createCmsTemplate); }}>
      <input bind:value={cmsTemplateTitle} maxlength="120" placeholder={t("cms.templateTitle")} aria-label={t("cms.templateTitle")} required />
      <input bind:value={cmsTemplateRef} maxlength="80" placeholder={t("cms.templateRef")} aria-label={t("cms.templateRef")} required />
      <button class="button dark" type="submit" disabled={busy}>{t("cms.addTemplate")}</button>
    </form>
  </section>
  <section class="panel-card cms-settings-panel">
    <div class="panel-head"><span class="step-number" aria-hidden="true">◫</span><div><h2>{t("cms.templateParts")}</h2><p>{t("cms.templatePartsHint")}</p></div></div>
    {#if selectedCmsProject.templateParts.length}
      <div class="site-grid">
        {#each selectedCmsProject.templateParts as part (part.id)}
          <article class="site-card">
            <div class="site-card-top"><span class="site-icon">▰</span><span class="status-chip">{t("cms.templatePart")}</span></div>
            {#if cmsSelecting}<label class="cms-trash-select"><input type="checkbox" aria-label={t("cms.selectForTrashLabel", { label: part.title })} checked={cmsTrashSelection.includes(part.id)} onchange={(event) => toggleCmsTrashSelection(part.id, (event.currentTarget as HTMLInputElement).checked)} /> {t("cms.selectForTrash")}</label>{/if}
            <button class="site-title" onclick={() => launchCmsEditor(part)}>{part.title}<span aria-hidden="true">↗</span></button>
            <p class="muted">{part.ref}</p>
            <div class="site-card-actions"><button class="button primary small" aria-label={t("cms.builderFor", { label: part.title })} onclick={() => launchCmsEditor(part)}>{t("cms.builder")}</button></div>
          </article>
        {/each}
      </div>
    {:else}<p class="muted">{t("cms.noTemplateParts")}</p>{/if}
    <form class="input-action" onsubmit={(event) => { event.preventDefault(); void act(createCmsTemplatePart); }}>
      <input bind:value={cmsTemplatePartTitle} maxlength="120" placeholder={t("cms.templatePartTitle")} aria-label={t("cms.templatePartTitle")} required />
      <input bind:value={cmsTemplatePartRef} maxlength="80" placeholder={t("cms.templatePartRef")} aria-label={t("cms.templatePartRef")} required />
      <button class="button dark" type="submit" disabled={busy}>{t("cms.addTemplatePart")}</button>
    </form>
  </section>
  {#if selectedCmsProject.components.length}
    <section class="panel-card cms-settings-panel">
      <div class="panel-head"><span class="step-number" aria-hidden="true">◇</span><div><h2>{t("cms.components")}</h2><p>{t("cms.componentsHint")}</p></div></div>
      <div class="site-grid">
        {#each selectedCmsProject.components as component (component.id)}
          <article class="site-card"><div class="site-card-top"><span class="site-icon">◇</span>{#if cmsSelecting}<label class="cms-trash-select"><input type="checkbox" aria-label={t("cms.selectForTrashLabel", { label: component.title })} checked={cmsTrashSelection.includes(component.id)} onchange={(event) => toggleCmsTrashSelection(component.id, (event.currentTarget as HTMLInputElement).checked)} /> {t("cms.selectForTrash")}</label>{/if}</div><button class="site-title" onclick={() => launchCmsEditor(component)}>{component.title}<span aria-hidden="true">↗</span></button><p class="muted">{component.ref}</p></article>
        {/each}
      </div>
    </section>
  {/if}
{/if}
