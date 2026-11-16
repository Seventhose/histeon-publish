<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { AdminIndex, AdminLink } from "../lib/admin-index.js";

  /** One pill per language: EN live, EN draft, EN! to update, +EN missing (doc 20 §6). */
  let { index, language, locale, versions }: { index: AdminIndex; language: Language; locale: string | null; versions: AdminLink[] } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const pills = $derived(index.languages.languages.map((item) => ({ code: item.code, label: item.label, state: versions.find((link) => link.language === item.code)?.state ?? "missing" })));
</script>

{#if locale === null}
  <span class="admin-pills">
    {#each pills as pill (pill.code)}
      <span class="admin-pill {pill.state}" title="{pill.label}: {t(`admin.state.${pill.state}`)}"><span aria-hidden="true">{pill.code.toUpperCase()}</span><span class="visually-hidden">{pill.label}: {t(`admin.state.${pill.state}`)}</span></span>
    {/each}
  </span>
{:else}
  <span class="admin-pill published"><span aria-hidden="true">{locale.toUpperCase()}</span><span class="visually-hidden">{locale}</span></span>
{/if}
