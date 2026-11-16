<script lang="ts">
  import { api } from "../lib/api.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { AdminIndex } from "../lib/admin-index.js";

  let { index, language, projectId, projectName, onChanged, onNotice, onRenamed }: { index: AdminIndex; language: Language; projectId: string; projectName: string; onChanged: () => void; onNotice: (text: string, failed?: boolean) => void; onRenamed: (name: string) => void } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  /** What the form starts from and goes back to: the bar appears only when something differs. */
  const fromIndex = () => ({ name: projectName, siteUrl: index.siteUrl ?? "", locale: index.renderSettings.locale, timeZone: index.renderSettings.timeZone, variants: index.imageVariants, search: index.siteSearch, shopUrl: index.shop.url ?? "", currency: index.shop.currency });
  // svelte-ignore state_referenced_locally
  let saved = $state(fromIndex());
  // svelte-ignore state_referenced_locally
  let form = $state(fromIndex());
  let saving = $state(false);
  const dirty = $derived(JSON.stringify(form) !== JSON.stringify(saved));
  const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  /** Names, not codes: the language of the site is chosen, not typed. */
  const locales = $derived([...new Set([saved.locale, form.locale, "it-IT", "en-GB", "en-US", "fr-FR", "de-DE", "es-ES", "pt-PT", "pt-BR", "nl-NL", "ro-RO", "el-GR", "pl-PL", "ru-RU"])]);
  function localeName(code: string): string {
    try {
      const name = new Intl.DisplayNames([language], { type: "language" }).of(code) ?? code;
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      return code;
    }
  }
  const zoneChoices = $derived([...new Set([form.timeZone, ...zones])]);
  const hasShop = $derived(index.types.some((type) => type.key === "product") || Boolean(saved.shopUrl));
  let redirects = $state<Array<{ from: string; to: string }>>([]);
  async function loadRedirects(): Promise<void> {
    redirects = (await api<{ redirects: typeof redirects }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/redirects`)).redirects;
  }
  async function removeRedirect(position: number): Promise<void> {
    redirects = (await api<{ redirects: typeof redirects }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/redirects`, { method: "PUT", body: JSON.stringify({ redirects: redirects.filter((_entry, at) => at !== position) }) })).redirects;
  }
  async function save(event: Event): Promise<void> {
    event.preventDefault();
    saving = true;
    try {
      await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/settings`, { method: "PATCH", body: JSON.stringify({ name: form.name, locale: form.locale, timeZone: form.timeZone, siteUrl: form.siteUrl.trim() || null, images: { variants: form.variants }, search: form.search, shop: { url: form.shopUrl.trim() || null, currency: form.currency } }) });
      if (form.name !== saved.name) onRenamed(form.name.trim());
      saved = { ...form };
      onNotice(t("admin.saved"));
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
    }
    saving = false;
    onChanged();
  }
</script>

<form class="admin-panel-stack" onsubmit={save}>
  <section class="admin-block admin-form-block">
    <div><h2>{t("admin.set.site")}</h2><p class="muted">{t("admin.set.urlHint")}</p></div>
    <div>
      <label class="field-label">{t("admin.set.project")}<input bind:value={form.name} maxlength="120" required data-testid="admin-project-name" /></label>
      <label class="field-label">{t("admin.set.url")}<input bind:value={form.siteUrl} type="url" placeholder="https://esempio.it" data-testid="admin-site-url" /></label>
    </div>
  </section>
  <section class="admin-block admin-form-block">
    <div><h2>{t("admin.set.regional")}</h2></div>
    <div>
      <label class="field-label">{t("admin.set.locale")}
        <select bind:value={form.locale} data-testid="admin-locale">{#each locales as code (code)}<option value={code}>{localeName(code)}</option>{/each}</select>
      </label>
      <label class="field-label">{t("admin.set.timeZone")}
        <select bind:value={form.timeZone} data-testid="admin-time-zone">{#each zoneChoices as zone (zone)}<option value={zone}>{zone.replaceAll("_", " ")}</option>{/each}</select>
      </label>
    </div>
  </section>
  <section class="admin-block admin-form-block">
    <div><h2>{t("admin.set.images")}</h2></div>
    <div><label class="admin-check admin-wrap"><input type="checkbox" bind:checked={form.variants} /> {t("admin.set.variants")}</label><label class="admin-check admin-wrap"><input type="checkbox" bind:checked={form.search} data-testid="admin-site-search" /> {t("admin.set.search")}</label></div>
  </section>
  {#if hasShop}
  <section class="admin-block admin-form-block">
    <div><h2>{t("admin.set.shop")}</h2></div>
    <div>
      <label class="field-label">{t("admin.set.shopUrl")}<input bind:value={form.shopUrl} type="url" /></label>
      <label class="field-label">{t("admin.set.currency")}<input bind:value={form.currency} maxlength="3" /></label>
    </div>
  </section>
  {/if}
  <details class="admin-block" data-testid="admin-redirects" ontoggle={(event) => { if (event.currentTarget.open) void loadRedirects(); }}>
    <summary><strong>{t("admin.redirects")}</strong></summary>
    <p class="muted">{t("admin.redirects.hint")}</p>
    {#if redirects.length}
      <ul class="admin-redirects">{#each redirects as redirect, position (redirect.from)}<li><code>{redirect.from}</code> → <code>{redirect.to}</code><button type="button" class="button text small" onclick={() => void removeRedirect(position)}>{t("admin.redirects.remove")}</button></li>{/each}</ul>
    {:else}<p class="muted">{t("admin.redirects.none")}</p>{/if}
  </details>
  {#if dirty}
    <div class="admin-savebar">
      <button class="button primary small" disabled={saving} data-testid="admin-settings-save">{t("admin.set.save")}</button>
      <button type="button" class="button text small" onclick={() => { form = { ...saved }; }}>{t("admin.set.discard")}</button>
      <span>{t("admin.set.unsaved")}</span>
    </div>
  {/if}
</form>
